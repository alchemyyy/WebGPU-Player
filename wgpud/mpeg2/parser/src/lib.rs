// The parser of the MPEG-2 Video decoder package: it reads each packet's sequence headers on the CPU, so each picture declares its
// sequence's size and chroma format, and a picture its session's pool cannot hold moves the engine to a session of its own.
// The WGSL back end decodes the packet itself, so a picture's GPU record is its packet, byte for byte, and its frame presents in
// timestamp order as a decoder without a parser's does: the parser decides no output events.
// The exports implement version 2 of the engine's parser interface, with one picture per packet and no parse units. The module imports
// only its memory, as env.memory; the host writes inputs into the reserved input buffer and copies outputs out of linear memory.

mod sequence;

// The error codes are shared with the WGSL back end, which declares them
#[allow(dead_code)]
mod error_codes {
    include!(concat!(env!("OUT_DIR"), "/error_codes.rs"));
}

use std::collections::VecDeque;
use std::ffi::c_void;

use error_codes::ERROR_RECORD_INVALID;
use sequence::{Sequence, SequenceFacts};

// The parser interface version the exports implement, and its call statuses; a packet holds one picture, so a packet never has more after
// its first
const PARSER_ABI_VERSION: u32 = 2;
const STATUS_SUCCESS: i32 = 0;
const STATUS_NO_PICTURE: i32 = 1;
const STATUS_FAILED: i32 = -1;
// Every picture runs each repeat of the header its full count for the stream; the header declares none
const HEADER_REPEAT_COUNT: u32 = u32::MAX;
// A picture format word: chroma_format_idc shifted left 8, ORed with the bit depth, which is always 8; 0 is the session's format
const PICTURE_FORMAT_CHROMA_SHIFT: u32 = 8;
const BIT_DEPTH: u32 = 8;
const SESSION_FORMAT: u32 = 0;
// The values of recordInvalid: a call the engine never makes for a parser whose plans have no units
const NO_PENDING_PICTURE: u32 = 1;
const UNEXPECTED_PARSE: u32 = 2;
const UNEXPECTED_JOBS: u32 = 3;

/// A failure's code, one the header's `//! error:` lines name, and its failing value.
#[derive(Clone, Copy, Debug, Default)]
struct ParserError {
    code: u32,
    value: u32,
}

/// A planned picture: its packet, which its record is, and its sequence's facts after the packet's headers.
struct PendingPicture {
    packet: Vec<u8>,
    sequence: Option<SequenceFacts>,
}

/// One instance's state: a coordinator plans and finishes pictures; a parse worker's instance is never called, as plans have no units.
pub struct ParserInstance {
    sequence: Sequence,
    pending: VecDeque<PendingPicture>,
    input: Vec<u8>,
    output: Vec<u8>,
    events: Vec<u32>,
    /// The sequence of the picture the last finish or decode output
    picture: Option<SequenceFacts>,
    /// The largest picture of the stream after a configure or a picture: its sequence's size
    maximum: Option<SequenceFacts>,
    error: ParserError,
}

impl ParserInstance {
    fn new() -> Self {
        Self {
            sequence: Sequence::default(),
            pending: VecDeque::new(),
            input: Vec::new(),
            output: Vec::new(),
            events: Vec::new(),
            picture: None,
            maximum: None,
            error: ParserError::default(),
        }
    }

    fn reset(&mut self) {
        self.sequence = Sequence::default();
        self.pending.clear();
        self.output.clear();
        self.picture = None;
        self.maximum = None;
    }

    fn fail(&mut self, value: u32) -> i32 {
        self.error = ParserError { code: ERROR_RECORD_INVALID, value };
        STATUS_FAILED
    }

    /// Reads the codec private data's headers, as the WGSL does before a session's first packet.
    fn configure(&mut self, byte_length: usize) {
        self.pending.clear();
        self.sequence.read_headers(&self.input[..byte_length]);
        self.maximum = self.sequence.facts();
    }

    /// Plans the packet in the input: its headers update the sequence, and the packet waits to become its picture's record.
    fn plan_packet(&mut self, byte_length: usize) {
        let packet: Vec<u8> = self.input[..byte_length].to_vec();
        self.sequence.read_headers(&packet);
        self.pending.push_back(PendingPicture { packet, sequence: self.sequence.facts() });
        self.output.clear();
    }

    /// Finishes the oldest planned picture: its record is its packet.
    fn finish_picture(&mut self) -> i32 {
        let Some(pending) = self.pending.pop_front() else {
            return self.fail(NO_PENDING_PICTURE);
        };
        self.output = pending.packet;
        self.picture = pending.sequence;
        self.maximum = pending.sequence;
        STATUS_SUCCESS
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

/// Reads the codec private data in the input, a sequence header and its extensions, or anything else, whose headers then apply. Returns 0.
///
/// # Safety
/// The handle must be live, and byte_length at most the reserved input.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_configure(handle: *mut c_void, byte_length: u32) -> i32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.configure(byte_length as usize);
    STATUS_SUCCESS
}

/// Drops every picture and the sequence, for a seek or a new stream; the codec private data must be configured again.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_reset(handle: *mut c_void) {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.reset();
}

/// Plans the packet in the input: returns 0 with an empty plan, its only picture, which no parse units make up. A packet without a
/// picture start code is a picture too, since the WGSL presents a frame for every packet.
///
/// # Safety
/// The handle must be live, and byte_length at most the reserved input.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_plan(handle: *mut c_void, byte_length: u32) -> i32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.plan_packet(byte_length as usize);
    STATUS_SUCCESS
}

/// Plans the packet's next picture: a packet holds one, so there is none.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_plan_next(_handle: *mut c_void) -> i32 {
    STATUS_NO_PICTURE
}

/// The last plan's units: none, so no picture's parsing leaves the coordinator.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_plan_unit_count(_handle: *mut c_void) -> u32 {
    0
}

/// Parses units of a plan, which has none, so the call fails.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_parse(handle: *mut c_void, _byte_length: u32, _first_unit: u32, _unit_count: u32) -> i32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.fail(UNEXPECTED_PARSE)
}

/// Finishes the oldest planned picture, whose plan had no units, so the input holds no jobs; its record is its packet.
///
/// # Safety
/// The handle must be live, and byte_length at most the reserved input.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_finish(handle: *mut c_void, byte_length: u32) -> i32 {
    // SAFETY: the host passes a live handle
    let instance: &mut ParserInstance = unsafe { parser_instance(handle) };
    if byte_length != 0 {
        return instance.fail(UNEXPECTED_JOBS);
    }
    instance.finish_picture()
}

/// Plans and finishes the packet in the input on this instance; its record is the packet.
///
/// # Safety
/// The handle must be live, and byte_length at most the reserved input.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_decode(handle: *mut c_void, byte_length: u32) -> i32 {
    // SAFETY: the host passes a live handle
    let instance: &mut ParserInstance = unsafe { parser_instance(handle) };
    instance.plan_packet(byte_length as usize);
    instance.finish_picture()
}

/// Decodes the packet's next picture: a packet holds one, so there is none.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_decode_next(_handle: *mut c_void) -> i32 {
    STATUS_NO_PICTURE
}

/// The visible width of the picture the last finish or decode output: its sequence's horizontal size, or 0 before any sequence header.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_picture_width(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.picture.map_or(0, |facts: SequenceFacts| facts.width)
}

/// The visible height of the picture the last finish or decode output: its sequence's vertical size, or 0 before any sequence header.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_picture_height(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.picture.map_or(0, |facts: SequenceFacts| facts.height)
}

/// How many times the picture's record runs a repeat of the header: the header declares none.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_picture_repeat_count(_handle: *mut c_void, _repeat: u32) -> u32 {
    HEADER_REPEAT_COUNT
}

/// The output format the picture decodes into: 8-bit at its sequence's chroma format, or the session's before any sequence header.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_picture_format(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }
        .picture
        .map_or(SESSION_FORMAT, |facts: SequenceFacts| (facts.chroma_format << PICTURE_FORMAT_CHROMA_SHIFT) | BIT_DEPTH)
}

/// The width of the largest picture after a configure or a picture: its sequence's horizontal size, or 0 before any sequence header.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_maximum_picture_width(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.maximum.map_or(0, |facts: SequenceFacts| facts.width)
}

/// The height of the largest picture after a configure or a picture: its sequence's vertical size, or 0 before any sequence header.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_maximum_picture_height(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.maximum.map_or(0, |facts: SequenceFacts| facts.height)
}

/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_output_pointer(handle: *mut c_void) -> *const u8 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.output.as_ptr()
}

/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_output_byte_length(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.output.len() as u32
}

/// The last call's output events: none, since frames present in timestamp order.
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

/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_error_code(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.error.code
}

/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_error_value(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.error.value
}
