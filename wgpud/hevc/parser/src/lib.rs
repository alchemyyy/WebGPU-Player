// The parser of the HEVC decoder package: it parses packets on the CPU, where CABAC's serial bins run fast, and emits each
// picture's GPU record, which the WGSL back end reconstructs from, with the output events FFmpeg's output process decides.
// A coordinator instance plans pictures in decode order and finishes them with motion derivation; parse instances, one per worker,
// parse planned slice data in parallel.
// The exports implement version 2 of the engine's parser interface, with one picture per access unit. The module imports only its memory,
// as env.memory; the host writes inputs into the reserved input buffer and copies outputs out of linear memory.

// The parser keeps the specification's indexed loops, and the motion derivation its processes' inputs as arguments
#![allow(clippy::needless_range_loop, clippy::too_many_arguments)]

mod assemble;
mod bitstream;
mod cabac;
mod ctb_layout;
mod error;
mod motion;
mod nal;
mod parameter_sets;
mod plan;
mod records;
mod sequencer;
mod slice_data;
mod tables;

// The record layout is shared with the WGSL back end, which reads fields the parser only writes through others
#[allow(dead_code)]
mod layout {
    include!(concat!(env!("OUT_DIR"), "/record_layout.rs"));
}

use std::collections::VecDeque;
use std::ffi::c_void;

use assemble::assemble_picture;
use error::{DecodeError, DecodeResult};
use layout::ERROR_RECORD_INVALID;
use motion::MotionStage;
use plan::{PictureParameters, Plan, SliceHeader};
use records::{JOB_HEADER_WORDS, JOB_CTB_ENTRY_WORDS, JobStreams};
use sequencer::{PlanOutcome, Sequencer};
use slice_data::{ParseResources, parse_units};

// The parser interface version the exports implement, and its call statuses; the HEVC parser never reports a blocked plan,
// and an access unit holds one picture, so a packet never has more after its first
const PARSER_ABI_VERSION: u32 = 2;
const STATUS_SUCCESS: i32 = 0;
const STATUS_NO_PICTURE: i32 = 1;
const STATUS_FAILED: i32 = -1;
// A picture reports no visible size of its own, and the codec private data declares no largest picture: the conformance window
// reaches the session through the record's header facts instead
const NO_PICTURE_SIZE: u32 = 0;
// Every picture runs each repeat of the header its full count for the stream
const HEADER_REPEAT_COUNT: u32 = u32::MAX;
// A picture reports no output format of its own, so the session keeps the one the stream started with
const NO_PICTURE_FORMAT: u32 = 0;
// The record failure values of the host's calls
const INVALID_PLAN: u32 = 1;
const INVALID_JOB: u32 = 2;
const NO_PENDING_PICTURE: u32 = 3;
const INVALID_UNIT_RANGE: u32 = 4;

/// What the coordinator keeps of a planned picture until its parsed slice data returns.
struct PendingPicture {
    parameters: PictureParameters,
    slices: Vec<SliceHeader>,
    keep: Vec<u32>,
}

/// One instance's state: a coordinator uses the sequencer, motion stage, and pending pictures; a parse worker the parse resources.
pub struct ParserInstance {
    sequencer: Sequencer,
    parse: ParseResources,
    motion: MotionStage,
    pending: VecDeque<PendingPicture>,
    plan_unit_count: u32,
    input: Vec<u8>,
    output_bytes: Vec<u8>,
    output_words: Vec<u32>,
    output_is_words: bool,
    /// The output events of the last call: a plan's, which a decode reports too; a parse or finish decides none
    events: Vec<u32>,
    jobs: Vec<JobStreams>,
    error: DecodeError,
}

pub(crate) fn empty_parameters() -> PictureParameters {
    // SAFETY: PictureParameters is a plain struct of integers, for which all zero bits are valid
    unsafe { std::mem::zeroed() }
}

impl ParserInstance {
    fn new() -> Self {
        Self {
            sequencer: Sequencer::new(empty_parameters()),
            parse: ParseResources::default(),
            motion: MotionStage::default(),
            pending: VecDeque::new(),
            plan_unit_count: 0,
            input: Vec::new(),
            output_bytes: Vec::new(),
            output_words: Vec::new(),
            output_is_words: false,
            events: Vec::new(),
            jobs: Vec::new(),
            error: DecodeError { code: 0, value: 0 },
        }
    }

    fn reset(&mut self) {
        self.sequencer = Sequencer::new(empty_parameters());
        self.motion.reset();
        self.pending.clear();
        self.events.clear();
    }

    fn record_failure(&mut self, error: DecodeError) -> i32 {
        self.error = error;
        STATUS_FAILED
    }

    /// Plans the picture of the packet in the input, keeping what finishing it needs, and takes the output events its start decided.
    fn plan_packet(&mut self, byte_length: usize) -> DecodeResult<Option<Box<Plan>>> {
        self.events.clear();
        let packet: &[u8] = &self.input[..byte_length];
        let outcome: PlanOutcome = self.sequencer.plan_packet(packet)?;
        self.events.extend_from_slice(self.sequencer.events());
        match outcome {
            PlanOutcome::NoPicture => Ok(None),
            PlanOutcome::Picture(plan, keep) => {
                self.pending.push_back(PendingPicture { parameters: plan.parameters, slices: plan.slices.clone(), keep });
                self.plan_unit_count = plan.units.len() as u32;
                Ok(Some(plan))
            }
        }
    }

    /// Derives motion over the jobs of the oldest pending picture and assembles its GPU record.
    fn finish_picture(&mut self) -> DecodeResult<()> {
        let Some(picture) = self.pending.pop_front() else {
            return error::fail(ERROR_RECORD_INVALID, NO_PENDING_PICTURE);
        };
        self.motion.process(&picture.parameters, &picture.slices, &picture.keep, &mut self.jobs);
        assemble_picture(&picture.parameters, &picture.slices, &picture.keep, &self.jobs, &mut self.output_words)?;
        self.output_is_words = true;
        Ok(())
    }

    fn decode_packet(&mut self, byte_length: usize) -> DecodeResult<bool> {
        let Some(plan) = self.plan_packet(byte_length)? else {
            return Ok(false);
        };
        parse_units(&mut self.parse, &plan, 0, plan.units.len())?;
        self.jobs.clear();
        self.jobs.push(std::mem::take(&mut self.parse.streams));
        let result: DecodeResult<()> = self.finish_picture();
        // The streams' allocations go back for the next picture
        if let Some(streams) = self.jobs.pop() {
            self.parse.streams = streams;
        }
        result.map(|()| true)
    }

    fn parse_plan(&mut self, byte_length: usize, first_unit: u32, unit_count: u32) -> DecodeResult<()> {
        self.events.clear();
        let Some(plan) = Plan::deserialize(&self.input[..byte_length]) else {
            return error::fail(ERROR_RECORD_INVALID, INVALID_PLAN);
        };
        let first: usize = first_unit as usize;
        let count: usize = unit_count as usize;
        if first.checked_add(count).is_none_or(|end: usize| end > plan.units.len()) {
            return error::fail(ERROR_RECORD_INVALID, INVALID_UNIT_RANGE);
        }
        parse_units(&mut self.parse, &plan, first, count)?;
        self.parse.streams.serialize(&mut self.output_words);
        self.output_is_words = true;
        Ok(())
    }

    /// Reads the serialized jobs in the input, one after another, then finishes the oldest pending picture with them.
    fn finish_jobs(&mut self, byte_length: usize) -> DecodeResult<()> {
        self.events.clear();
        if !byte_length.is_multiple_of(4) {
            return error::fail(ERROR_RECORD_INVALID, INVALID_JOB);
        }
        let words: Vec<u32> = self.input[..byte_length].chunks_exact(4).map(|bytes: &[u8]| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])).collect();
        self.jobs.clear();
        let mut offset: usize = 0;
        while offset < words.len() {
            let Some(header) = words.get(offset..offset + JOB_HEADER_WORDS) else {
                return error::fail(ERROR_RECORD_INVALID, INVALID_JOB);
            };
            let length: usize = JOB_HEADER_WORDS + header[1] as usize * JOB_CTB_ENTRY_WORDS + header[2..].iter().map(|&count: &u32| count as usize).sum::<usize>();
            let Some(job_words) = words.get(offset..offset + length) else {
                return error::fail(ERROR_RECORD_INVALID, INVALID_JOB);
            };
            let mut streams: JobStreams = JobStreams::default();
            if !streams.deserialize(job_words) {
                return error::fail(ERROR_RECORD_INVALID, INVALID_JOB);
            }
            self.jobs.push(streams);
            offset += length;
        }
        self.finish_picture()
    }

    fn output(&self) -> (*const u8, usize) {
        if self.output_is_words {
            (self.output_words.as_ptr().cast::<u8>(), self.output_words.len() * 4)
        } else {
            (self.output_bytes.as_ptr(), self.output_bytes.len())
        }
    }
}

/// Returns the instance behind a host handle.
///
/// # Safety
/// The handle must come from parser_create and not be destroyed.
unsafe fn parser_instance<'a>(handle: *mut c_void) -> &'a mut ParserInstance {
    // SAFETY: the caller passes a live handle from parser_create
    unsafe { &mut *handle.cast::<ParserInstance>() }
}

/// The parser interface version the module implements, which the host checks against its own.
#[unsafe(no_mangle)]
pub extern "C" fn parser_abi_version() -> u32 {
    PARSER_ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn parser_create() -> *mut c_void {
    Box::into_raw(Box::new(ParserInstance::new())).cast::<c_void>()
}

/// # Safety
/// The handle must come from parser_create; it is invalid afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_destroy(handle: *mut c_void) {
    if handle.is_null() {
        return;
    }
    // SAFETY: the handle came from Box::into_raw in parser_create
    drop(unsafe { Box::from_raw(handle.cast::<ParserInstance>()) });
}

/// Returns an input buffer of at least byte_length bytes, which the next call reads.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_reserve_input(handle: *mut c_void, byte_length: u32) -> *mut u8 {
    // SAFETY: the host passes a live handle
    let instance: &mut ParserInstance = unsafe { parser_instance(handle) };
    if instance.input.len() < byte_length as usize {
        instance.input.resize(byte_length as usize, 0);
    }
    instance.input.as_mut_ptr()
}

/// Parses the codec private data in the input. Returns 0, or -1 with the error set.
///
/// # Safety
/// The handle must be live, and byte_length at most the reserved input.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_configure(handle: *mut c_void, byte_length: u32) -> i32 {
    // SAFETY: the host passes a live handle
    let instance: &mut ParserInstance = unsafe { parser_instance(handle) };
    let configuration: Vec<u8> = instance.input[..byte_length as usize].to_vec();
    match instance.sequencer.configure(&configuration) {
        Ok(()) => STATUS_SUCCESS,
        Err(error) => instance.record_failure(error),
    }
}

/// Drops every picture and parameter set, for a seek or a new stream; the codec private data must be configured again.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_reset(handle: *mut c_void) {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.reset();
}

/// Plans the packet in the input: returns 0 with the serialized plan as the output, its only picture, 1 for a packet without a picture, or -1.
/// Either success reports the output events the picture's start decided.
///
/// # Safety
/// The handle must be live, and byte_length at most the reserved input.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_plan(handle: *mut c_void, byte_length: u32) -> i32 {
    // SAFETY: the host passes a live handle
    let instance: &mut ParserInstance = unsafe { parser_instance(handle) };
    match instance.plan_packet(byte_length as usize) {
        Ok(Some(plan)) => {
            plan.serialize(&mut instance.output_bytes);
            instance.output_is_words = false;
            STATUS_SUCCESS
        }
        Ok(None) => STATUS_NO_PICTURE,
        Err(error) => instance.record_failure(error),
    }
}

/// Plans the packet's next picture: an access unit holds one, so there is none, and the call decides no output events.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_plan_next(handle: *mut c_void) -> i32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.events.clear();
    STATUS_NO_PICTURE
}

/// The decoding units of the last planned picture, which parse calls may split between workers in order.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_plan_unit_count(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.plan_unit_count
}

/// Parses units first_unit to first_unit + unit_count of the serialized plan in the input: returns 0 with the job as the output, or -1.
///
/// # Safety
/// The handle must be live, and byte_length at most the reserved input.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_parse(handle: *mut c_void, byte_length: u32, first_unit: u32, unit_count: u32) -> i32 {
    // SAFETY: the host passes a live handle
    let instance: &mut ParserInstance = unsafe { parser_instance(handle) };
    match instance.parse_plan(byte_length as usize, first_unit, unit_count) {
        Ok(()) => STATUS_SUCCESS,
        Err(error) => instance.record_failure(error),
    }
}

/// Finishes the oldest planned picture from its serialized jobs in the input, in decode order: returns 0 with the GPU record as the output, or -1.
///
/// # Safety
/// The handle must be live, and byte_length at most the reserved input.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_finish(handle: *mut c_void, byte_length: u32) -> i32 {
    // SAFETY: the host passes a live handle
    let instance: &mut ParserInstance = unsafe { parser_instance(handle) };
    match instance.finish_jobs(byte_length as usize) {
        Ok(()) => STATUS_SUCCESS,
        Err(error) => instance.record_failure(error),
    }
}

/// Plans, parses, and finishes the packet in the input on this instance: returns 0 with the GPU record of its only picture as the output,
/// 1 for no picture, or -1. Either success reports the plan's output events.
///
/// # Safety
/// The handle must be live, and byte_length at most the reserved input.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_decode(handle: *mut c_void, byte_length: u32) -> i32 {
    // SAFETY: the host passes a live handle
    let instance: &mut ParserInstance = unsafe { parser_instance(handle) };
    match instance.decode_packet(byte_length as usize) {
        Ok(true) => STATUS_SUCCESS,
        Ok(false) => STATUS_NO_PICTURE,
        Err(error) => instance.record_failure(error),
    }
}

/// Decodes the packet's next picture on this instance: an access unit holds one, so there is none, and the call decides no output events.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_decode_next(handle: *mut c_void) -> i32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.events.clear();
    STATUS_NO_PICTURE
}

/// The visible width of the picture the last finish or decode output: none of its own, so the session keeps the stream's visible rectangle.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_picture_width(_handle: *mut c_void) -> u32 {
    NO_PICTURE_SIZE
}

/// The visible height of the picture the last finish or decode output: none of its own.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_picture_height(_handle: *mut c_void) -> u32 {
    NO_PICTURE_SIZE
}

/// How many times the picture the last finish or decode output runs a repeat of the header: the header's count for the stream.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_picture_repeat_count(_handle: *mut c_void, _repeat: u32) -> u32 {
    HEADER_REPEAT_COUNT
}

/// The output format of the picture the last finish or decode output: none of its own, so the session keeps its format.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_picture_format(_handle: *mut c_void) -> u32 {
    NO_PICTURE_FORMAT
}

/// The width of the largest picture the configured codec private data, or the last output picture's sequence, declares: none,
/// so the session takes the container's size.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_maximum_picture_width(_handle: *mut c_void) -> u32 {
    NO_PICTURE_SIZE
}

/// The height of the largest picture the configured codec private data, or the last output picture's sequence, declares: none.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_maximum_picture_height(_handle: *mut c_void) -> u32 {
    NO_PICTURE_SIZE
}

/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_output_pointer(handle: *mut c_void) -> *const u8 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.output().0
}

/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_output_byte_length(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.output().1 as u32
}

/// The output events of the last call, as words: a picture's index in decode order modulo 2^30, with bit 31 set to discard it.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_event_pointer(handle: *mut c_void) -> *const u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.events.as_ptr()
}

/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_event_count(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.events.len() as u32
}

/// The code of the last failed check, from the record layout's error codes.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_error_code(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.error.code
}

/// The value that failed the last failed check.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_error_value(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.error.value
}
