// What the three codec families share: the codec private data the engine passes, the planned picture a coordinator hands a parse
// worker, the decoded picture a parse worker hands back, and the anchor motion MPEG-4 B pictures read.

use crate::error::{self, DecodeResult};
use crate::layout::ERROR_CONFIGURATION;
use crate::motion::MotionContext;
use crate::mpv::{Codec, Mpv};
use crate::plan_struct;
use crate::record::RecordHeader;

// The codec private data: a 40-byte BITMAPINFOHEADER of the track's coded size and FourCC, then the track's extradata
const BITMAP_INFO_HEADER_BYTE_LENGTH: usize = 40;
const WIDTH_OFFSET: usize = 4;
const HEIGHT_OFFSET: usize = 8;
const COMPRESSION_OFFSET: usize = 16;
// The configuration failure values: data shorter than the header, and a size of zero or past the package's limit
pub const CONFIGURATION_TOO_SHORT: u32 = 1;
pub const CONFIGURATION_SIZE: u32 = 2;
// The package's largest side, as its header's accepts conditions bound it
pub const MAXIMUM_SIDE: i32 = 4096;

/// FFmpeg's FourCCs of the codecs, from libavformat/riff.c and isom_tags.c, upper-cased as FFmpeg's lookups compare them.
const MSMPEG4V3_TAGS: [&[u8; 4]; 10] = [b"MP43", b"DIV3", b"MPG3", b"DIV5", b"DIV6", b"DIV4", b"DVX3", b"AP41", b"COL1", b"COL0"];
const MSMPEG4V2_TAGS: [&[u8; 4]; 2] = [b"MP42", b"DIV2"];
const MSMPEG4V1_TAGS: [&[u8; 4]; 2] = [b"MPG4", b"MP41"];
const H263_TAGS: [&[u8; 4]; 11] = [b"H263", b"X263", b"T263", b"L263", b"VX1K", b"ZYGO", b"M263", b"LSVM", b"U263", b"VSM4", b"S263"];

/// FFmpeg's avpriv_toupper4 of a little-endian FourCC.
pub fn toupper4(tag: u32) -> u32 {
    u32::from_le_bytes(tag.to_le_bytes().map(|byte: u8| byte.to_ascii_uppercase()))
}

/// FFmpeg's AV_RL32 of a FourCC's characters.
pub const fn fourcc(tag: &[u8; 4]) -> u32 {
    u32::from_le_bytes(*tag)
}

/// The codec a FourCC names, as FFmpeg's demuxers map it; any other FourCC, such as XVID, DIVX, or mp4v, is MPEG-4 Part 2.
pub fn codec_of_tag(tag: u32) -> Codec {
    let upper: [u8; 4] = toupper4(tag).to_le_bytes();
    let in_set = |set: &[&[u8; 4]]| set.iter().any(|candidate: &&[u8; 4]| **candidate == upper);
    if in_set(&MSMPEG4V3_TAGS) {
        Codec::MsMpeg4V3
    } else if in_set(&MSMPEG4V2_TAGS) {
        Codec::MsMpeg4V2
    } else if in_set(&MSMPEG4V1_TAGS) {
        Codec::MsMpeg4V1
    } else if in_set(&H263_TAGS) {
        Codec::H263
    } else {
        Codec::Mpeg4
    }
}

/// The codec private data, as the engine passes it for every codec of the package.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Configuration {
    pub codec: Codec,
    /// FFmpeg's s->codec_tag: the FourCC, upper-cased
    pub codec_tag: u32,
    /// The container's coded size, FFmpeg's avctx->width and height before any header sets them
    pub width: i32,
    pub height: i32,
    pub extradata: Vec<u8>,
}

impl Configuration {
    /// Reads the BITMAPINFOHEADER and the extradata after it, which FFmpeg reads whatever biSize says.
    pub fn parse(bytes: &[u8]) -> DecodeResult<Self> {
        if bytes.len() < BITMAP_INFO_HEADER_BYTE_LENGTH {
            return error::fail(ERROR_CONFIGURATION, CONFIGURATION_TOO_SHORT);
        }
        let read = |offset: usize| -> u32 { u32::from_le_bytes([bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]]) };
        let width: i32 = read(WIDTH_OFFSET) as i32;
        // A bottom-up bitmap's negative height still names its size
        let height: i32 = (read(HEIGHT_OFFSET) as i32).saturating_abs();
        if width <= 0 || height <= 0 || width > MAXIMUM_SIDE || height > MAXIMUM_SIDE {
            return error::fail(ERROR_CONFIGURATION, CONFIGURATION_SIZE);
        }
        let tag: u32 = read(COMPRESSION_OFFSET);
        Ok(Self { codec: codec_of_tag(tag), codec_tag: toupper4(tag), width, height, extradata: bytes[BITMAP_INFO_HEADER_BYTE_LENGTH..].to_vec() })
    }
}

/// What an MPEG-4 B picture's direct mode and skip inheritance read of the next anchor, FFmpeg's next_pic tables and the field vectors
/// the anchor left in the context's p_field_mv_table.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AnchorMotion {
    pub mb_width: i32,
    pub mb_height: i32,
    /// motion_val[0] of the b8 grid, b8_stride * mb_height * 2 entries, x and y interleaved
    pub motion_val: Vec<i16>,
    /// mb_type at mb_x + mb_y * mb_stride
    pub mb_type: Vec<u32>,
    /// mbskip_table at mb_x + mb_y * mb_stride
    pub mbskip_table: Vec<u8>,
    /// ref_index[0], four entries per macroblock
    pub ref_index: Vec<u8>,
    /// p_field_mv_table[field][0] at mb_x + mb_y * mb_stride, x and y interleaved, field 0 then field 1
    pub field_mv: Vec<i16>,
}

plan_struct!(AnchorMotion { mb_width, mb_height, motion_val, mb_type, mbskip_table, ref_index, field_mv });

/// A picture a parse worker decoded: its tables and macroblock records, how its operations move, and its record's picture facts.
pub struct DecodedPicture {
    pub mpv: Mpv,
    pub motion: MotionContext,
    pub header: RecordHeader,
}

/// The visible size, fields, and order of a planned picture, which the parser reports with its record.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PictureInfo {
    pub width: u32,
    pub height: u32,
    /// The largest picture of the picture's sequence
    pub maximum_width: u32,
    pub maximum_height: u32,
    /// The parser_picture_fields word
    pub fields: u32,
    /// An I, P, or S picture, which later pictures reference; a B picture is none
    pub reference: bool,
    /// The picture outputs at once, as a B picture and any picture of a low-delay stream do; otherwise it outputs when the next
    /// reference picture is planned
    pub output_now: bool,
    /// The picture drops every reference before it, as FFmpeg's decoder does when a size change reinitializes it, and the reference
    /// picture waiting to output with them
    pub reset_anchors: bool,
}

/// The parser_picture_fields word: bit 0 reported, bit 1 interlaced, bit 2 top field first.
pub fn fields_word(interlaced: bool, top_field_first: bool) -> u32 {
    1 | (u32::from(interlaced) << 1) | (u32::from(interlaced && top_field_first) << 2)
}

/// The anchor motion of a decoded reference picture: its tables B pictures read as FFmpeg's next_pic.
pub fn anchor_motion(mpv: &Mpv) -> AnchorMotion {
    let b8_count: i32 = mpv.b8_stride * mpv.mb_height * 2;
    let mb_count: usize = (mpv.mb_stride * mpv.mb_height) as usize;
    let mut motion_val: Vec<i16> = Vec::with_capacity(2 * b8_count as usize);
    for index in 0..b8_count {
        motion_val.extend_from_slice(&mpv.get_motion_val(0, index));
    }
    let mut field_mv: Vec<i16> = Vec::with_capacity(4 * mb_count);
    for field in 0..2 {
        for mb_xy in 0..mb_count as i32 {
            field_mv.extend_from_slice(&mpv.get_p_field_mv(field, 0, mb_xy));
        }
    }
    AnchorMotion {
        mb_width: mpv.mb_width,
        mb_height: mpv.mb_height,
        motion_val,
        mb_type: mpv.mb_type[..mb_count].to_vec(),
        mbskip_table: mpv.mbskip_table[..mb_count].to_vec(),
        ref_index: mpv.ref_index[0].iter().map(|&value: &i8| value as u8).collect(),
        field_mv,
    }
}
