// The parser of the MPEG-4 Part 2, H.263, and MS-MPEG4 decoder package: it parses each packet's pictures on the CPU as FFmpeg's mpeg4,
// h263, and msmpeg4 decoders do, and emits each picture's GPU record, which the WGSL back end reconstructs, with the output events
// FFmpeg's output decides.
// A coordinator instance plans pictures in decode order: their headers and the sequence state they carry. Parse instances, one per
// worker, decode each picture's macroblock layer, a picture to a parse unit, into its record; the coordinator finishes pictures in
// decode order, keeping the anchor motion MPEG-4 B pictures read.
// The exports implement version 2 of the engine's parser interface. The module imports only its memory, as env.memory; the host writes
// inputs into the reserved input buffer and copies outputs out of linear memory.

// The parser keeps FFmpeg's indexed loops and its many-argument helpers
#![allow(clippy::needless_range_loop, clippy::too_many_arguments)]

mod bitstream;
mod codec;
mod error;
mod h263;
mod h263dec;
mod motion;
mod mpeg4;
mod mpv;
mod msmpeg4;
mod msmpeg4_tables;
mod plan;
mod record;
mod sequencer;
mod tables;
mod vlc;

// The record layout is shared with the WGSL back end, which reads fields the parser only writes through others
#[allow(dead_code)]
mod layout {
    include!(concat!(env!("OUT_DIR"), "/record_layout.rs"));
}

use std::collections::VecDeque;
use std::ffi::c_void;

use codec::{AnchorMotion, DecodedPicture, PictureInfo};
use error::{DecodeError, DecodeResult};
use layout::ERROR_RECORD_INVALID;
use plan::{PlanField, PlanReader, PlanWriter};
use record::write_record;
use sequencer::{BLOCKED, PendingPicture, PicturePlan, Sequencer};

// The parser interface version the exports implement, and its call statuses
const PARSER_ABI_VERSION: u32 = 2;
const STATUS_SUCCESS: i32 = 0;
const STATUS_NO_PICTURE: i32 = 1;
const STATUS_BLOCKED: i32 = 2;
const STATUS_MORE_PICTURES: i32 = 3;
const STATUS_FAILED: i32 = -1;
// Every picture runs each repeat of the header its full count for the stream; the header declares none
const HEADER_REPEAT_COUNT: u32 = u32::MAX;
// Every picture decodes into 8-bit 4:2:0: chroma_format_idc 1 shifted left 8, ORed with the bit depth
const PICTURE_FORMAT_I420: u32 = (1 << 8) | 8;
const BYTES_PER_WORD: usize = 4;
// A picture is one parse unit
const PLAN_UNIT_COUNT: u32 = 1;
// The record check failure values of the interface: a plan, job, or unit range that does not read, and a finish without a planned picture
pub const INVALID_PLAN: u32 = 5;
pub const INVALID_JOB: u32 = 6;
pub const INVALID_UNIT_RANGE: u32 = 7;
pub const NO_PENDING_PICTURE: u32 = 8;

/// A parse worker's result: the picture's record, and the anchor motion of a reference picture B pictures may read.
struct Job {
    record: Vec<u32>,
    anchor_motion: Option<AnchorMotion>,
}

impl PlanField for Job {
    fn write(&self, writer: &mut PlanWriter) {
        self.record.write(writer);
        self.anchor_motion.write(writer);
    }
    fn read(reader: &mut PlanReader) -> Option<Self> {
        Some(Self { record: Vec::<u32>::read(reader)?, anchor_motion: Option::<AnchorMotion>::read(reader)? })
    }
}

/// Decodes a planned picture's macroblock layer into its job.
fn decode_plan(plan: &PicturePlan, reference: bool) -> DecodeResult<Job> {
    let decoded: DecodedPicture = plan.decode()?;
    let mut record: Vec<u32> = Vec::new();
    write_record(&decoded.mpv, &decoded.motion, &decoded.header, &mut record)?;
    // MPEG-4 and H.263 B pictures read the next anchor's motion
    let anchor_motion: Option<AnchorMotion> =
        if reference && matches!(plan, PicturePlan::Mpeg4(_) | PicturePlan::H263(_)) { Some(codec::anchor_motion(&decoded.mpv)) } else { None };
    Ok(Job { record, anchor_motion })
}

/// One instance's state: a coordinator uses the sequencer and its pending pictures; a parse worker only decodes plans.
pub struct ParserInstance {
    sequencer: Sequencer,
    pending: VecDeque<PendingPicture>,
    input: Vec<u8>,
    output_words: Vec<u32>,
    events: Vec<u32>,
    picture: PictureInfo,
    maximum_size: (u32, u32),
    error: DecodeError,
}

impl ParserInstance {
    fn new() -> Self {
        Self {
            sequencer: Sequencer::default(),
            pending: VecDeque::new(),
            input: Vec::new(),
            output_words: Vec::new(),
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

    /// Takes a plan step's result: the serialized plan as the output, and the status of the step.
    fn take_planned(&mut self, planned: DecodeResult<Option<(PendingPicture, PicturePlan)>>) -> i32 {
        self.events.clear();
        self.events.extend_from_slice(self.sequencer.events());
        match planned {
            Ok(Some((pending, plan))) => {
                let mut writer: PlanWriter = PlanWriter::default();
                pending.info.reference.write(&mut writer);
                plan.write(&mut writer);
                self.output_words = writer.words;
                self.pending.push_back(pending);
                if self.sequencer.has_next() { STATUS_MORE_PICTURES } else { STATUS_SUCCESS }
            }
            Ok(None) => STATUS_NO_PICTURE,
            Err(error) if error == BLOCKED => STATUS_BLOCKED,
            Err(error) => self.record_failure(error),
        }
    }

    fn parse_plan(&mut self, byte_length: usize, first_unit: u32, unit_count: u32) -> DecodeResult<()> {
        self.events.clear();
        if first_unit != 0 || unit_count != PLAN_UNIT_COUNT {
            return error::fail(ERROR_RECORD_INVALID, INVALID_UNIT_RANGE);
        }
        let words: Vec<u32> = read_words(&self.input[..byte_length]).ok_or(DecodeError { code: ERROR_RECORD_INVALID, value: INVALID_PLAN })?;
        let mut reader: PlanReader = PlanReader::new(&words);
        let (Some(reference), Some(plan)) = (bool::read(&mut reader), PicturePlan::read(&mut reader)) else {
            return error::fail(ERROR_RECORD_INVALID, INVALID_PLAN);
        };
        let job: Job = decode_plan(&plan, reference)?;
        let mut writer: PlanWriter = PlanWriter::default();
        job.write(&mut writer);
        self.output_words = writer.words;
        Ok(())
    }

    /// Finishes the oldest pending picture from its job.
    fn finish_job(&mut self, job: Job) -> DecodeResult<()> {
        let Some(pending) = self.pending.pop_front() else {
            return error::fail(ERROR_RECORD_INVALID, NO_PENDING_PICTURE);
        };
        self.sequencer.finish(&pending, job.anchor_motion);
        self.output_words = job.record;
        self.picture = pending.info;
        self.maximum_size = (pending.info.maximum_width, pending.info.maximum_height);
        Ok(())
    }

    fn finish_jobs(&mut self, byte_length: usize) -> DecodeResult<()> {
        self.events.clear();
        let job: Option<Job> = read_words(&self.input[..byte_length]).and_then(|words: Vec<u32>| {
            let mut reader: PlanReader = PlanReader::new(&words);
            let job: Job = Job::read(&mut reader)?;
            reader.is_empty().then_some(job)
        });
        let Some(job) = job else {
            return error::fail(ERROR_RECORD_INVALID, INVALID_JOB);
        };
        self.finish_job(job)
    }

    /// Plans, decodes, and finishes a planned picture on this instance; the plan's events stay the call's.
    fn decode_planned(&mut self, planned: DecodeResult<Option<(PendingPicture, PicturePlan)>>) -> i32 {
        let planned: Option<(PendingPicture, PicturePlan)> = match planned {
            Ok(planned) => planned,
            // Every earlier picture finished on this instance, so nothing can block it
            Err(error) if error == BLOCKED => return self.record_failure(DecodeError { code: ERROR_RECORD_INVALID, value: INVALID_PLAN }),
            Err(error) => return self.record_failure(error),
        };
        let events: Vec<u32> = self.sequencer.events().to_vec();
        let Some((pending, plan)) = planned else {
            self.events = events;
            return STATUS_NO_PICTURE;
        };
        let reference: bool = pending.info.reference;
        self.pending.push_back(pending);
        let result: DecodeResult<()> = decode_plan(&plan, reference).and_then(|job: Job| self.finish_job(job));
        self.events = events;
        match result {
            Ok(()) if self.sequencer.has_next() => STATUS_MORE_PICTURES,
            Ok(()) => STATUS_SUCCESS,
            Err(error) => self.record_failure(error),
        }
    }

    fn output(&self) -> (*const u8, usize) {
        (self.output_words.as_ptr().cast::<u8>(), self.output_words.len() * BYTES_PER_WORD)
    }
}

/// The little-endian words of a byte buffer, None unless it holds whole words.
fn read_words(bytes: &[u8]) -> Option<Vec<u32>> {
    if !bytes.len().is_multiple_of(BYTES_PER_WORD) {
        return None;
    }
    Some(bytes.chunks_exact(BYTES_PER_WORD).map(|chunk: &[u8]| u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])).collect())
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

/// Parses the codec private data in the input: a BITMAPINFOHEADER of the coded size and FourCC, then the track's extradata. Returns 0,
/// or -1 with the error set.
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

/// Plans the first picture of the packet in the input: returns 0 with the serialized plan as the output when it is the packet's last,
/// 3 when more follow, 1 for a packet without a picture, 2 for a B picture that waits for the anchors before it to finish, or -1.
///
/// # Safety
/// The handle must be live, and byte_length at most the reserved input.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_plan(handle: *mut c_void, byte_length: u32) -> i32 {
    // SAFETY: the host passes a live handle
    let instance: &mut ParserInstance = unsafe { parser_instance(handle) };
    let packet: Vec<u8> = instance.input[..byte_length as usize].to_vec();
    let planned = instance.sequencer.plan_packet(&packet);
    instance.take_planned(planned)
}

/// Plans the packet's next picture, as DivX packs a B picture after its anchor's: the statuses of parser_plan.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_plan_next(handle: *mut c_void) -> i32 {
    // SAFETY: the host passes a live handle
    let instance: &mut ParserInstance = unsafe { parser_instance(handle) };
    let planned = instance.sequencer.plan_next();
    instance.take_planned(planned)
}

/// The parse units of the last planned picture: a picture is one unit.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_plan_unit_count(_handle: *mut c_void) -> u32 {
    PLAN_UNIT_COUNT
}

/// Decodes the serialized plan in the input, its one unit: returns 0 with the job as the output, or -1.
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

/// Finishes the oldest planned picture from its serialized job in the input, in decode order: returns 0 with the GPU record as the
/// output, or -1.
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

/// Plans, decodes, and finishes the first picture of the packet in the input on this instance: the statuses of parser_plan, with the
/// GPU record as the output.
///
/// # Safety
/// The handle must be live, and byte_length at most the reserved input.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_decode(handle: *mut c_void, byte_length: u32) -> i32 {
    // SAFETY: the host passes a live handle
    let instance: &mut ParserInstance = unsafe { parser_instance(handle) };
    let packet: Vec<u8> = instance.input[..byte_length as usize].to_vec();
    let planned = instance.sequencer.plan_packet(&packet);
    instance.decode_planned(planned)
}

/// Decodes the packet's next picture on this instance.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_decode_next(handle: *mut c_void) -> i32 {
    // SAFETY: the host passes a live handle
    let instance: &mut ParserInstance = unsafe { parser_instance(handle) };
    let planned = instance.sequencer.plan_next();
    instance.decode_planned(planned)
}

/// The visible width of the picture the last finish or decode output, FFmpeg's frame width.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_picture_width(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.picture.width
}

/// The visible height of the picture the last finish or decode output.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_picture_height(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.picture.height
}

/// How many times the picture runs a repeat of the header: the header declares none.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_picture_repeat_count(_handle: *mut c_void, _repeat: u32) -> u32 {
    HEADER_REPEAT_COUNT
}

/// The output format of the picture: 8-bit 4:2:0.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_picture_format(_handle: *mut c_void) -> u32 {
    PICTURE_FORMAT_I420
}

/// The fields of the picture the last finish or decode output: bit 0 reported, bit 1 interlaced, bit 2 top field first, as FFmpeg flags
/// its frames.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_picture_fields(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.picture.fields
}

/// The width of the largest picture the configured codec private data, or the last output picture's sequence, declares.
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

/// The output events of the last call, as words: a picture's index in decode order modulo 2^30, bit 31 to drop it.
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
