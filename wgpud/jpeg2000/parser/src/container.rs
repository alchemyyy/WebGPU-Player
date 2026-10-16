// Finds the codestream in a packet as FFmpeg's jpeg2000 decoder does, and reads the JP2 header boxes that steer its pixel format.
// MJ2 and MOV samples carry a whole JP2 file (FFmpeg's encoders write one per frame), a Contiguous Codestream box (ISO/IEC 15444-3 writers),
// or a bare codestream; a JP2 file's colr, pclr, and cdef boxes are read, and in every case the codestream starts at the first SOC marker.

use crate::error::{DecodeResult, fail};
use crate::layout::ERROR_CODESTREAM_MISSING;
use crate::stream::ByteStream;

const JP2_SIGNATURE_LENGTH: u32 = 12;
const JP2_SIGNATURE_TYPE: u32 = 0x6A50_2020;
const JP2_SIGNATURE_VALUE: u32 = 0x0D0A_870A;
const JP2_CODESTREAM_BOX: u32 = 0x6A70_3263;
const JP2_HEADER_BOX: u32 = 0x6A70_3268;
const COLOUR_BOX: u32 = 0x636F_6C72;
const PALETTE_BOX: u32 = 0x7063_6C72;
const CHANNEL_DEFINITION_BOX: u32 = 0x6364_6566;
pub const START_OF_CODESTREAM: u16 = 0xFF4F;
/// FFmpeg gives up after this many boxes that are neither the codestream nor the JP2 header
const BOX_SEARCH_RANGE: u32 = 10;
const BOX_HEADER_LENGTH: u32 = 8;
const EXTENDED_BOX_HEADER_LENGTH: u32 = 16;
const EXTENDED_BOX_SIZE: u32 = 1;
const ENUMERATED_COLOUR_METHOD: u8 = 1;
const COLOUR_BOX_MINIMUM_LENGTH: u32 = 7;
const PALETTE_BOX_MINIMUM_LENGTH: u32 = 6;
const CHANNEL_DEFINITION_BOX_MINIMUM_LENGTH: u32 = 2;
const PALETTE_MAXIMUM_ENTRIES: u32 = 256;
const PALETTE_CHANNELS: u8 = 3;
const PALETTE_MAXIMUM_DEPTH: u32 = 16;
const MAXIMUM_CHANNEL_INDEX: i32 = 4;
// The failure values of a missing codestream
pub const MISSING_CODESTREAM_BOX: u32 = 1;
pub const MISSING_START_MARKER: u32 = 2;
pub const PACKET_TOO_SHORT: u32 = 3;
const SIGNED_INTEGER_MAXIMUM: i64 = i32::MAX as i64;

/// What a JP2 header says about the image, as FFmpeg keeps it: the enumerated colour space, a palette, and the channel definitions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ColourInfo {
    /// The enumerated colour space of a colr box with method 1, or 0 for none
    pub colour_space: u32,
    pub has_palette: bool,
    /// Each component's channel association, or -1 when no cdef box set it
    pub channel_definitions: [i32; 4],
}

impl Default for ColourInfo {
    fn default() -> Self {
        Self { colour_space: 0, has_palette: false, channel_definitions: [-1; 4] }
    }
}

/// Where a packet's codestream starts, after its SOC marker, and what its JP2 header said.
pub struct LocatedCodestream {
    /// The packet offset just past the SOC marker
    pub first_marker: usize,
    pub colour: ColourInfo,
}

/// Reads the boxes of a JP2 header until its Contiguous Codestream box: returns Ok(true) at the codestream,
/// Ok(false) when none is found, and Err(()) where FFmpeg's search returns an error, after which the SOC search still runs.
fn find_codestream_box(packet: &[u8], stream: &mut ByteStream, colour: &mut ColourInfo) -> Result<bool, ()> {
    let mut search_range: u32 = BOX_SEARCH_RANGE;
    while search_range > 0 && stream.bytes_left() >= BOX_HEADER_LENGTH as usize {
        let mut box_size: u32 = stream.read_u32(packet);
        let box_type: u32 = stream.read_u32(packet);
        let box_end: u32;
        if box_size == EXTENDED_BOX_SIZE {
            if stream.read_u32(packet) != 0 {
                // A box beyond 4 GiB
                return Ok(false);
            }
            box_size = stream.read_u32(packet);
            if box_size < EXTENDED_BOX_HEADER_LENGTH || stream.position as i64 + i64::from(box_size) - i64::from(EXTENDED_BOX_HEADER_LENGTH) > SIGNED_INTEGER_MAXIMUM {
                return Err(());
            }
            box_end = (stream.position as u32).wrapping_add(box_size) - EXTENDED_BOX_HEADER_LENGTH;
        } else {
            if box_size < BOX_HEADER_LENGTH || stream.position as i64 + i64::from(box_size) - i64::from(BOX_HEADER_LENGTH) > SIGNED_INTEGER_MAXIMUM {
                return Err(());
            }
            box_end = (stream.position as u32).wrapping_add(box_size) - BOX_HEADER_LENGTH;
        }
        if box_type == JP2_CODESTREAM_BOX {
            return Ok(true);
        }
        if (stream.bytes_left() as u64) < u64::from(box_size) || box_end < box_size {
            return Ok(false);
        }
        if box_type == JP2_HEADER_BOX && box_size >= EXTENDED_BOX_HEADER_LENGTH {
            if read_header_boxes(packet, stream, box_end, colour) {
                return Ok(true);
            }
        } else {
            search_range -= 1;
        }
        stream.seek(box_end as usize);
    }
    Ok(false)
}

/// Reads the boxes inside a JP2 header box; returns true when one of them is the codestream, as FFmpeg then stops there.
fn read_header_boxes(packet: &[u8], stream: &mut ByteStream, header_end: u32, colour: &mut ColourInfo) -> bool {
    loop {
        if stream.bytes_left() < BOX_HEADER_LENGTH as usize {
            return false;
        }
        let mut inner_size: u32 = stream.read_u32(packet);
        let inner_type: u32 = stream.read_u32(packet);
        let inner_end: u32 = (stream.position as u32).wrapping_add(inner_size).wrapping_sub(BOX_HEADER_LENGTH);
        if inner_size < BOX_HEADER_LENGTH || inner_end > header_end || inner_end < inner_size {
            return false;
        }
        inner_size -= BOX_HEADER_LENGTH;
        match inner_type {
            JP2_CODESTREAM_BOX => return true,
            COLOUR_BOX if inner_size >= COLOUR_BOX_MINIMUM_LENGTH => {
                let method: u8 = stream.read_u8(packet);
                stream.skip(2);
                if method == ENUMERATED_COLOUR_METHOD {
                    colour.colour_space = stream.read_u32(packet);
                }
            }
            PALETTE_BOX if inner_size >= PALETTE_BOX_MINIMUM_LENGTH => read_palette(packet, stream, inner_size, colour),
            CHANNEL_DEFINITION_BOX if inner_size >= CHANNEL_DEFINITION_BOX_MINIMUM_LENGTH => {
                let count: u16 = stream.read_u16(packet);
                for _ in 0..count {
                    let channel: i32 = i32::from(stream.read_u16(packet));
                    stream.read_u16(packet);
                    // An unassociated channel, 65535, keeps its default as FFmpeg's bound leaves it
                    let association: i32 = i32::from(stream.read_u16(packet));
                    if channel < MAXIMUM_CHANNEL_INDEX && association < MAXIMUM_CHANNEL_INDEX {
                        colour.channel_definitions[channel as usize] = association;
                    }
                }
            }
            _ => {}
        }
        stream.seek(inner_end as usize);
        if header_end.wrapping_sub(inner_end) < BOX_HEADER_LENGTH {
            return false;
        }
    }
}

/// Marks a palette that FFmpeg accepts: up to 256 colours of 3 channels, each at most 16 bits deep.
fn read_palette(packet: &[u8], stream: &mut ByteStream, box_length: u32, colour: &mut ColourInfo) {
    let colour_count: u32 = u32::from(stream.read_u16(packet));
    let channels: u8 = stream.read_u8(packet);
    let mut depths: [u32; 3] = [0; 3];
    for depth in &mut depths {
        *depth = u32::from(stream.read_u8(packet) & 0x7F) + 1;
    }
    let size: u32 = depths.iter().map(|&depth: &u32| depth.div_ceil(8) * colour_count).sum();
    if colour_count > PALETTE_MAXIMUM_ENTRIES || channels != PALETTE_CHANNELS || depths.iter().any(|&depth: &u32| depth > PALETTE_MAXIMUM_DEPTH) || box_length < size {
        return;
    }
    colour.has_palette = true;
}

/// Locates the codestream of a packet: past a JP2 header when the packet starts with a JP2 signature box, then at the first SOC marker.
pub fn locate_codestream(packet: &[u8]) -> DecodeResult<LocatedCodestream> {
    let mut colour: ColourInfo = ColourInfo::default();
    let mut stream: ByteStream = ByteStream::new(0, packet.len());
    if stream.bytes_left() < 2 {
        return fail(ERROR_CODESTREAM_MISSING, PACKET_TOO_SHORT);
    }
    let is_jp2: bool = stream.bytes_left() >= JP2_SIGNATURE_LENGTH as usize
        && stream.read_u32(packet) == JP2_SIGNATURE_LENGTH
        && stream.read_u32(packet) == JP2_SIGNATURE_TYPE
        && stream.read_u32(packet) == JP2_SIGNATURE_VALUE;
    if is_jp2 {
        // FFmpeg's search returns an error code where it gives up early, which its caller takes as found
        if let Ok(false) = find_codestream_box(packet, &mut stream, &mut colour) {
            return fail(ERROR_CODESTREAM_MISSING, MISSING_CODESTREAM_BOX);
        }
    } else {
        stream.seek(0);
    }
    while stream.bytes_left() >= 3 && stream.peek_u16(packet) != START_OF_CODESTREAM {
        stream.skip(1);
    }
    if stream.bytes_left() < 2 || stream.read_u16(packet) != START_OF_CODESTREAM {
        return fail(ERROR_CODESTREAM_MISSING, MISSING_START_MARKER);
    }
    Ok(LocatedCodestream { first_marker: stream.position, colour })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOC: [u8; 2] = [0xFF, 0x4F];

    fn jp2_box(box_type: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut bytes: Vec<u8> = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(box_type);
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn finds_a_bare_codestream_and_one_behind_a_codestream_box() {
        let bare: Vec<u8> = [SOC.as_slice(), &[0xFF, 0x51]].concat();
        assert_eq!(locate_codestream(&bare).map(|located| located.first_marker), Ok(2));
        let wrapped: Vec<u8> = jp2_box(b"jp2c", &bare);
        let located: LocatedCodestream = locate_codestream(&wrapped).expect("the codestream box holds a codestream");
        assert_eq!(located.first_marker, 10);
        assert_eq!(located.colour, ColourInfo::default());
    }

    #[test]
    fn reads_the_colour_space_and_channel_definitions_of_a_jp2_header() {
        let signature: Vec<u8> = jp2_box(b"jP  ", &[0x0D, 0x0A, 0x87, 0x0A]);
        let colour_box: Vec<u8> = jp2_box(b"colr", &[1, 0, 0, 0, 0, 0, 18]);
        let channel_box: Vec<u8> = jp2_box(b"cdef", &[0, 1, 0, 0, 0, 0, 0, 1]);
        let header: Vec<u8> = jp2_box(b"jp2h", &[colour_box, channel_box].concat());
        let codestream: Vec<u8> = jp2_box(b"jp2c", &[SOC.as_slice(), &[0xFF, 0x51]].concat());
        let packet: Vec<u8> = [signature, jp2_box(b"ftyp", b"jp2 \0\0\0\0jp2 "), header, codestream].concat();
        let located: LocatedCodestream = locate_codestream(&packet).expect("the JP2 file holds a codestream");
        assert_eq!(located.colour.colour_space, 18);
        assert_eq!(located.colour.channel_definitions, [1, -1, -1, -1]);
        assert_eq!(&packet[located.first_marker - 2..located.first_marker], &SOC);
    }

    #[test]
    fn reports_a_packet_without_a_start_marker() {
        assert_eq!(locate_codestream(&[0x00, 0x01, 0x02, 0x03]).err().map(|error| error.value), Some(MISSING_START_MARKER));
        assert_eq!(locate_codestream(&[0x00]).err().map(|error| error.value), Some(PACKET_TOO_SHORT));
    }
}
