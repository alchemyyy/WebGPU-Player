// The parser of the VC-1 decoder package: it parses VC-1 and WMV3 packets on the CPU, where the serial macroblock layer runs fast, and
// emits each picture's GPU record, which the WGSL back end expands and reconstructs from, with the output events FFmpeg's output decides.
// A coordinator instance plans pictures in decode order, with their headers and parse units, slices and fields; parse instances, one per
// worker, decode the units' macroblock layers in parallel, intra prediction and IntraX8 pictures included; the coordinator finishes each
// picture into its record.
// The exports implement version 2 of the engine's parser interface, with one picture per packet. The module imports only its memory, as
// env.memory; the host writes inputs into the reserved input buffer and copies outputs out of linear memory.

// The parser keeps FFmpeg's indexed loops, and the motion predictors their many inputs as arguments
#![allow(clippy::needless_range_loop, clippy::too_many_arguments)]

mod bitstream;
mod error;
mod header;
mod intra;
mod intrax8;
mod intrax8_tables;
mod macroblock;
mod motion;
mod plan;
mod record;
mod segments;
mod sequencer;
mod tables;
mod unit;
mod vlc;

// The record layout is shared with the WGSL back end, which reads fields the parser only writes through others
#[allow(dead_code)]
mod layout {
    include!(concat!(env!("OUT_DIR"), "/record_layout.rs"));
}

use std::collections::VecDeque;
use std::ffi::c_void;

use error::{DecodeError, DecodeResult};
use layout::ERROR_RECORD_INVALID;
use plan::Plan;
use record::{INVALID_JOB, INVALID_PLAN, INVALID_UNIT_RANGE, NO_PENDING_PICTURE, ParsedUnit, assemble_record, deserialize_jobs, parse_units, serialize_job, unit_anchor_motion};
use sequencer::{PendingPicture, PictureInfo, PlanOutcome, Sequencer};
use unit::UnitOutput;

// The parser interface version the exports implement, and its call statuses; a packet holds one picture, so a packet never has more after
// its first
const PARSER_ABI_VERSION: u32 = 2;
const STATUS_SUCCESS: i32 = 0;
const STATUS_NO_PICTURE: i32 = 1;
const STATUS_BLOCKED: i32 = 2;
const STATUS_FAILED: i32 = -1;
// Every picture runs each repeat of the header its full count for the stream; the header declares none
const HEADER_REPEAT_COUNT: u32 = u32::MAX;
// Every picture decodes into 8-bit 4:2:0: chroma_format_idc 1 shifted left 8, ORed with the bit depth
const PICTURE_FORMAT_I420: u32 = (1 << 8) | 8;
const BYTES_PER_WORD: usize = 4;

/// One instance's state: a coordinator uses the sequencer and its pending pictures; a parse worker only parses plans.
pub struct ParserInstance {
    sequencer: Sequencer,
    pending: VecDeque<PendingPicture>,
    plan_unit_count: u32,
    input: Vec<u8>,
    output_bytes: Vec<u8>,
    output_words: Vec<u32>,
    output_is_words: bool,
    /// The output events of the last call: a plan's, which a decode reports too; a parse or finish decides none
    events: Vec<u32>,
    /// What the picture the last finish or decode output reports
    picture: PictureInfo,
    /// The largest picture of the stream after a configure or a picture
    maximum_size: (u32, u32),
    error: DecodeError,
}

impl ParserInstance {
    fn new() -> Self {
        Self {
            sequencer: Sequencer::default(),
            pending: VecDeque::new(),
            plan_unit_count: 0,
            input: Vec::new(),
            output_bytes: Vec::new(),
            output_words: Vec::new(),
            output_is_words: false,
            events: Vec::new(),
            picture: PictureInfo::default(),
            maximum_size: (0, 0),
            error: DecodeError { code: 0, value: 0 },
        }
    }

    fn reset(&mut self) {
        self.sequencer.reset();
        self.pending.clear();
        self.events.clear();
        self.picture = PictureInfo::default();
        self.maximum_size = (0, 0);
    }

    fn record_failure(&mut self, error: DecodeError) -> i32 {
        self.error = error;
        STATUS_FAILED
    }

    fn configure(&mut self, byte_length: usize) -> DecodeResult<()> {
        let codec_private: Vec<u8> = self.input[..byte_length].to_vec();
        self.pending.clear();
        self.sequencer.configure(&codec_private)?;
        self.maximum_size = self.sequencer.maximum_picture_size();
        Ok(())
    }

    /// Plans the picture of the packet in the input, keeping what finishing it needs, and takes the output events its plan decided.
    fn plan_packet(&mut self, byte_length: usize) -> DecodeResult<Option<Option<Box<Plan>>>> {
        self.events.clear();
        let packet: &[u8] = &self.input[..byte_length];
        let outcome: PlanOutcome = self.sequencer.plan_packet(packet)?;
        self.events.extend_from_slice(self.sequencer.events());
        match outcome {
            PlanOutcome::Blocked => Ok(None),
            PlanOutcome::NoPicture => Ok(Some(None)),
            PlanOutcome::Picture(plan, pending) => {
                self.plan_unit_count = plan.units.len() as u32;
                self.pending.push_back(*pending);
                Ok(Some(Some(plan)))
            }
        }
    }

    /// Finishes the oldest pending picture from its parsed units into its GPU record.
    fn finish_picture(&mut self, units: &[ParsedUnit]) -> DecodeResult<()> {
        let Some(pending) = self.pending.pop_front() else {
            return error::fail(ERROR_RECORD_INVALID, NO_PENDING_PICTURE);
        };
        if let Err(failure) = assemble_record(&pending, units, &mut self.output_words) {
            self.sequencer.abandon(&pending);
            return Err(failure);
        }
        self.sequencer.finish_anchor(&pending, &unit_anchor_motion(units));
        self.output_is_words = true;
        self.picture = pending.info;
        self.maximum_size = (pending.info.maximum_width, pending.info.maximum_height);
        Ok(())
    }

    /// Plans, parses, and finishes the packet in the input on this instance; Ok(false) for a packet without a picture.
    fn decode_packet(&mut self, byte_length: usize) -> DecodeResult<bool> {
        let Some(planned) = self.plan_packet(byte_length)? else {
            // Every earlier picture finished on this instance, so nothing can block it
            return error::fail(ERROR_RECORD_INVALID, INVALID_PLAN);
        };
        let Some(plan) = planned else {
            return Ok(false);
        };
        let outputs: Vec<UnitOutput> = parse_units(&plan, 0, plan.units.len());
        let units: Vec<ParsedUnit> = outputs
            .into_iter()
            .map(|output: UnitOutput| {
                let unit: &plan::UnitParameters = &plan.units[output.unit_index as usize];
                ParsedUnit { row_offset: unit.row_offset, start_row: unit.start_row, end_row: unit.end_row, output }
            })
            .collect();
        self.finish_picture(&units).map(|()| true)
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
        let outputs: Vec<UnitOutput> = parse_units(&plan, first, count);
        serialize_job(&plan, &outputs, &mut self.output_words);
        self.output_is_words = true;
        Ok(())
    }

    /// Reads the serialized jobs in the input, one after another, then finishes the oldest pending picture with them.
    fn finish_jobs(&mut self, byte_length: usize) -> DecodeResult<()> {
        self.events.clear();
        if !byte_length.is_multiple_of(BYTES_PER_WORD) {
            return error::fail(ERROR_RECORD_INVALID, INVALID_JOB);
        }
        let words: Vec<u32> = self.input[..byte_length]
            .chunks_exact(BYTES_PER_WORD)
            .map(|bytes: &[u8]| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
            .collect();
        let mut units: Vec<ParsedUnit> = deserialize_jobs(&words)?;
        units.sort_by_key(|unit: &ParsedUnit| unit.output.unit_index);
        self.finish_picture(&units)
    }

    fn output(&self) -> (*const u8, usize) {
        if self.output_is_words {
            (self.output_words.as_ptr().cast::<u8>(), self.output_words.len() * BYTES_PER_WORD)
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

/// Parses the codec private data in the input: a WMV3 BITMAPINFOHEADER and STRUCT_C, or VC-1 extradata. Returns 0, or -1 with the error set.
///
/// # Safety
/// The handle must be live, and byte_length at most the reserved input.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_configure(handle: *mut c_void, byte_length: u32) -> i32 {
    // SAFETY: the host passes a live handle
    let instance: &mut ParserInstance = unsafe { parser_instance(handle) };
    match instance.configure(byte_length as usize) {
        Ok(()) => STATUS_SUCCESS,
        Err(error) => instance.record_failure(error),
    }
}

/// Drops every picture and the configuration, for a seek or a new stream; the codec private data must be configured again.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_reset(handle: *mut c_void) {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.reset();
}

/// Plans the packet in the input: returns 0 with the serialized plan as the output, its only picture, 1 for a packet without a picture,
/// 2 for a B picture that waits for the anchors before it to finish, or -1. Either success reports the output events the plan decided.
///
/// # Safety
/// The handle must be live, and byte_length at most the reserved input.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_plan(handle: *mut c_void, byte_length: u32) -> i32 {
    // SAFETY: the host passes a live handle
    let instance: &mut ParserInstance = unsafe { parser_instance(handle) };
    match instance.plan_packet(byte_length as usize) {
        Ok(Some(Some(plan))) => {
            plan.serialize(&mut instance.output_bytes);
            instance.output_is_words = false;
            STATUS_SUCCESS
        }
        Ok(Some(None)) => STATUS_NO_PICTURE,
        Ok(None) => STATUS_BLOCKED,
        Err(error) => instance.record_failure(error),
    }
}

/// Plans the packet's next picture: a packet holds one, so there is none, and the call decides no output events.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_plan_next(handle: *mut c_void) -> i32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.events.clear();
    STATUS_NO_PICTURE
}

/// The parse units of the last planned picture, slices and fields, which parse calls may split between workers in order.
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

/// Finishes the oldest planned picture from its serialized jobs in the input, in decode order: returns 0 with the GPU record as the
/// output, or -1 with the highest failure of its units.
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

/// Decodes the packet's next picture on this instance: a packet holds one, so there is none, and the call decides no output events.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_decode_next(handle: *mut c_void) -> i32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.events.clear();
    STATUS_NO_PICTURE
}

/// The visible width of the picture the last finish or decode output: its coded width.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_picture_width(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.picture.width
}

/// The visible height of the picture the last finish or decode output: its coded height.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_picture_height(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.picture.height
}

/// How many times the picture the last finish or decode output runs a repeat of the header: the header declares none.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_picture_repeat_count(_handle: *mut c_void, _repeat: u32) -> u32 {
    HEADER_REPEAT_COUNT
}

/// The output format of the picture the last finish or decode output: 8-bit 4:2:0.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_picture_format(_handle: *mut c_void) -> u32 {
    PICTURE_FORMAT_I420
}

/// The fields of the picture the last finish or decode output: bit 0 reported, bit 1 interlaced, bit 2 top field first, bit 3 repeat
/// first field, as FFmpeg's vc1 decoder flags its frames.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_picture_fields(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.picture.fields
}

/// The width of the largest picture the configured codec private data, or the last output picture's sequence, declares: the Advanced
/// profile's maximum coded width, or the Simple and Main profiles' coded width.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_maximum_picture_width(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.maximum_size.0
}

/// The height of the largest picture the configured codec private data, or the last output picture's sequence, declares.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_maximum_picture_height(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.maximum_size.1
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

/// The output events of the last call, as words: a picture's index in decode order modulo 2^30.
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
