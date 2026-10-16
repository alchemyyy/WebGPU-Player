// The parser of the JPEG 2000 decoder package: it reads each codestream's headers and runs tier-2 on the CPU, where packet headers
// are bit-serial, and emits the picture's GPU record of code blocks, which the WGSL back end decodes with tier-1 and the inverse transforms.
// A coordinator instance plans pictures in decode order and finishes them; parse instances, one per worker, run tier-2 over whole tiles.
// Pictures are intra coded and present in decode order, so no step decides output events.
// The exports implement version 2 of the engine's parser interface, with one picture per codestream. The module imports only its memory,
// as env.memory; the host writes inputs into the reserved input buffer and copies outputs out of linear memory.

// The parser keeps FFmpeg's indexed loops over the per-component arrays
#![allow(clippy::needless_range_loop)]

mod codestream;
mod container;
mod error;
mod format;
mod geometry;
mod quantization;
mod record;
mod stream;
mod tier2;

// The record layout is shared with the WGSL back end, which reads fields the parser only writes through others
#[allow(dead_code)]
mod layout {
    include!(concat!(env!("OUT_DIR"), "/record_layout.rs"));
}

use std::collections::VecDeque;
use std::ffi::c_void;

use codestream::{Codestream, FormatChoice, ImageSize, MAXIMUM_COMPONENTS, TileHeader, parse_codestream};
use error::{DecodeError, DecodeResult};
use format::{OutputLayout, PixelFormat, plan_output};
use geometry::{MAXIMUM_PARSE_WORK, Tile, initialize_tile};
use layout::ERROR_RECORD_INVALID;
use record::{TILE_JOB_MAGIC, ParsedTile, assemble_record, deserialize_tiles, parse_tile, serialize_tile};
use tier2::TileDecoder;

// The parser interface version the exports implement, and its call statuses; the JPEG 2000 parser never reports a blocked plan,
// and a packet holds one codestream, so it never has a picture after its first
const PARSER_ABI_VERSION: u32 = 2;
const STATUS_SUCCESS: i32 = 0;
const STATUS_NO_PICTURE: i32 = 1;
const STATUS_FAILED: i32 = -1;
// A picture reports no visible size of its own, and the codec private data declares no largest picture
const NO_PICTURE_SIZE: u32 = 0;
// Every picture runs each repeat of the header its full count for the stream
const HEADER_REPEAT_COUNT: u32 = u32::MAX;
// A picture reports no output format of its own, so the session keeps the one the stream started with
const NO_PICTURE_FORMAT: u32 = 0;
/// The first word of a serialized plan
const PLAN_MAGIC: u32 = 0x4B50_324A;
/// Words of a serialized plan before the packet: its magic, pixel format, needed components, and packet length
const PLAN_HEADER_WORDS: usize = 4;
const BYTES_PER_WORD: usize = 4;
// The record failure values of the host's calls
const INVALID_PLAN: u32 = 1;
const INVALID_JOB: u32 = 2;
const NO_PENDING_PICTURE: u32 = 3;
const INVALID_UNIT_RANGE: u32 = 4;

/// What the coordinator keeps of a planned picture until its tiles return.
struct PendingPicture {
    size: ImageSize,
    layout: OutputLayout,
    tile_count: usize,
}

/// One instance's state: a coordinator plans and finishes, a parse worker runs tier-2 for the tiles it is given.
pub struct ParserInstance {
    pending: VecDeque<PendingPicture>,
    /// The pixel format of the last planned picture, which FFmpeg keeps while it fits
    previous_format: Option<PixelFormat>,
    plan_unit_count: u32,
    input: Vec<u8>,
    output_bytes: Vec<u8>,
    output_words: Vec<u32>,
    output_is_words: bool,
    events: Vec<u32>,
    error: DecodeError,
}

/// The components the planes show, as a mask word of a serialized plan.
fn component_mask(layout: &OutputLayout) -> u32 {
    layout.decoded_components.iter().enumerate().fold(0, |mask: u32, (index, &decoded): (usize, &bool)| mask | (u32::from(decoded) << index))
}

fn components_of_mask(mask: u32) -> [bool; MAXIMUM_COMPONENTS] {
    std::array::from_fn(|index: usize| (mask >> index) & 1 != 0)
}

/// Runs tier-2 over tiles `first` to `first + count` of a parsed codestream and collects their tier-1 work.
fn parse_tiles(codestream: &mut Codestream, needed_components: &[bool; MAXIMUM_COMPONENTS], first: usize, count: usize) -> DecodeResult<Vec<ParsedTile>> {
    let mut tiles: Vec<ParsedTile> = Vec::with_capacity(count);
    let mut remaining_work: u64 = MAXIMUM_PARSE_WORK;
    for tile_index in first..first + count {
        let mut geometry: Tile = initialize_tile(&codestream.size, codestream.tiles[tile_index].as_deref(), &codestream.region_shift, tile_index, &mut remaining_work)?;
        let header: &mut TileHeader = codestream.tiles[tile_index].as_mut().expect("an initialized tile has a header");
        TileDecoder::new(&codestream.arena, header, &mut geometry, &codestream.size, codestream.has_packed_main_headers, &mut remaining_work).decode_packets()?;
        tiles.push(parse_tile(&geometry, header, tile_index as u32, needed_components)?);
    }
    Ok(tiles)
}

impl ParserInstance {
    fn new() -> Self {
        Self {
            pending: VecDeque::new(),
            previous_format: None,
            plan_unit_count: 0,
            input: Vec::new(),
            output_bytes: Vec::new(),
            output_words: Vec::new(),
            output_is_words: false,
            events: Vec::new(),
            error: DecodeError { code: 0, value: 0 },
        }
    }

    fn reset(&mut self) {
        self.pending.clear();
        self.previous_format = None;
        self.events.clear();
    }

    fn record_failure(&mut self, error: DecodeError) -> i32 {
        self.error = error;
        STATUS_FAILED
    }

    /// Parses the packet's headers in decode order, settling its pixel format and output layout, and keeps what finishing it needs.
    fn plan_packet(&mut self, byte_length: usize) -> DecodeResult<Codestream> {
        self.events.clear();
        let codestream: Codestream = parse_codestream(&self.input[..byte_length], FormatChoice::Choose(self.previous_format))?;
        let layout: OutputLayout = plan_output(&codestream.size, &codestream.colour, &codestream.pixel_format);
        self.previous_format = Some(codestream.pixel_format);
        self.plan_unit_count = codestream.tiles.len() as u32;
        self.pending.push_back(PendingPicture { size: codestream.size, layout, tile_count: codestream.tiles.len() });
        Ok(codestream)
    }

    /// Writes the plan a parse worker takes: the plan's pixel format and needed components, then the packet itself.
    fn serialize_plan(&mut self, codestream: &Codestream, byte_length: usize) {
        let layout: &OutputLayout = &self.pending.back().expect("a planned picture is pending").layout;
        let header: [u32; PLAN_HEADER_WORDS] = [PLAN_MAGIC, codestream.pixel_format.to_word(), component_mask(layout), byte_length as u32];
        self.output_bytes.clear();
        for word in header {
            self.output_bytes.extend_from_slice(&word.to_le_bytes());
        }
        self.output_bytes.extend_from_slice(&self.input[..byte_length]);
        self.output_is_words = false;
    }

    fn finish_picture(&mut self, tiles: Vec<ParsedTile>) -> DecodeResult<()> {
        let Some(picture) = self.pending.pop_front() else {
            return error::fail(ERROR_RECORD_INVALID, NO_PENDING_PICTURE);
        };
        self.output_words = assemble_record(&picture.size, picture.tile_count, &picture.layout, tiles)?;
        self.output_is_words = true;
        Ok(())
    }

    fn decode_packet(&mut self, byte_length: usize) -> DecodeResult<()> {
        let mut codestream: Codestream = self.plan_packet(byte_length)?;
        let needed: [bool; MAXIMUM_COMPONENTS] = self.pending.back().expect("a planned picture is pending").layout.decoded_components;
        let tile_count: usize = codestream.tiles.len();
        match parse_tiles(&mut codestream, &needed, 0, tile_count) {
            Ok(tiles) => self.finish_picture(tiles),
            Err(error) => {
                // The picture fails whole, so no later packet finishes with its geometry
                self.pending.pop_back();
                Err(error)
            }
        }
    }

    fn parse_plan(&mut self, byte_length: usize, first_unit: u32, unit_count: u32) -> DecodeResult<()> {
        self.events.clear();
        let plan: &[u8] = &self.input[..byte_length];
        let read_word = |index: usize| -> Option<u32> {
            let bytes: &[u8] = plan.get(index * BYTES_PER_WORD..(index + 1) * BYTES_PER_WORD)?;
            Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
        };
        let (Some(PLAN_MAGIC), Some(format_word), Some(mask), Some(packet_length)) = (read_word(0), read_word(1), read_word(2), read_word(3)) else {
            return error::fail(ERROR_RECORD_INVALID, INVALID_PLAN);
        };
        let packet_start: usize = PLAN_HEADER_WORDS * BYTES_PER_WORD;
        let (Some(format), Some(packet)) = (PixelFormat::from_word(format_word), plan.get(packet_start..packet_start + packet_length as usize)) else {
            return error::fail(ERROR_RECORD_INVALID, INVALID_PLAN);
        };
        let mut codestream: Codestream = parse_codestream(packet, FormatChoice::Given(format))?;
        let first: usize = first_unit as usize;
        let count: usize = unit_count as usize;
        if first.checked_add(count).is_none_or(|end: usize| end > codestream.tiles.len()) {
            return error::fail(ERROR_RECORD_INVALID, INVALID_UNIT_RANGE);
        }
        let tiles: Vec<ParsedTile> = parse_tiles(&mut codestream, &components_of_mask(mask), first, count)?;
        self.output_words.clear();
        self.output_words.extend_from_slice(&[TILE_JOB_MAGIC, tiles.len() as u32]);
        for tile in &tiles {
            serialize_tile(tile, &mut self.output_words);
        }
        self.output_is_words = true;
        Ok(())
    }

    /// Reads the serialized jobs in the input, concatenated in unit order, and finishes the oldest pending picture with their tiles.
    fn finish_jobs(&mut self, byte_length: usize) -> DecodeResult<()> {
        self.events.clear();
        if !byte_length.is_multiple_of(BYTES_PER_WORD) {
            return error::fail(ERROR_RECORD_INVALID, INVALID_JOB);
        }
        let words: Vec<u32> = self.input[..byte_length].chunks_exact(BYTES_PER_WORD).map(|bytes: &[u8]| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])).collect();
        let tiles: Vec<ParsedTile> = deserialize_tiles(&words)?;
        self.finish_picture(tiles)
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

/// Takes the codec private data: an MJ2 sample entry's JP2 header, which FFmpeg's decoder does not read either, so nothing depends on it.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_configure(_handle: *mut c_void, _byte_length: u32) -> i32 {
    STATUS_SUCCESS
}

/// Drops every pending picture and the remembered pixel format, for a seek or a new stream.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_reset(handle: *mut c_void) {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.reset();
}

/// Plans the packet in the input: returns 0 with the serialized plan as the output, its only picture, whose units are the codestream's tiles, or -1.
///
/// # Safety
/// The handle must be live, and byte_length at most the reserved input.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_plan(handle: *mut c_void, byte_length: u32) -> i32 {
    // SAFETY: the host passes a live handle
    let instance: &mut ParserInstance = unsafe { parser_instance(handle) };
    match instance.plan_packet(byte_length as usize) {
        Ok(codestream) => {
            instance.serialize_plan(&codestream, byte_length as usize);
            STATUS_SUCCESS
        }
        Err(error) => instance.record_failure(error),
    }
}

/// Plans the packet's next picture: a packet holds one codestream, so there is none, and the call decides no output events.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_plan_next(handle: *mut c_void) -> i32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.events.clear();
    STATUS_NO_PICTURE
}

/// The tiles of the last planned picture, which parse calls may split between workers in order.
///
/// # Safety
/// The handle must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_plan_unit_count(handle: *mut c_void) -> u32 {
    // SAFETY: the host passes a live handle
    unsafe { parser_instance(handle) }.plan_unit_count
}

/// Runs tier-2 for tiles first_unit to first_unit + unit_count of the serialized plan in the input: returns 0 with the job as the output, or -1.
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

/// Plans, parses, and finishes the packet in the input on this instance: returns 0 with the GPU record of its only picture as the output, or -1.
///
/// # Safety
/// The handle must be live, and byte_length at most the reserved input.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parser_decode(handle: *mut c_void, byte_length: u32) -> i32 {
    // SAFETY: the host passes a live handle
    let instance: &mut ParserInstance = unsafe { parser_instance(handle) };
    match instance.decode_packet(byte_length as usize) {
        Ok(()) => STATUS_SUCCESS,
        Err(error) => instance.record_failure(error),
    }
}

/// Decodes the packet's next picture on this instance: a packet holds one codestream, so there is none, and the call decides no output events.
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

/// The output events of the last call, as words; intra pictures present in decode order, so there are none.
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
