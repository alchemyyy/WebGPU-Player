// MPEG-4 Part 2 headers as FFmpeg's mpeg4videodec.c reads them: ff_mpeg4_parse_picture_header's start code loop over visual object
// sequences, visual objects, video object layers, groups of VOPs, and user data, then decode_vop_header, with mpeg4_decode_sprite_trajectory
// and ff_mpeg4_workaround_bugs. The state they keep is the coordinator's, since each header reads what the ones before it set.

use std::sync::LazyLock;

use crate::bitstream::BitReader;
use crate::codec::fourcc;
use crate::error::{self, DecodeResult};
use crate::layout::{ERROR_PICTURE_HEADER, ERROR_SEQUENCE_HEADER, ERROR_UNSUPPORTED_FEATURE};
use crate::motion::SpriteWarp;
use crate::mpv::{
    FF_BUG_AUTODETECT, FF_BUG_DC_CLIP, FF_BUG_DIRECT_BLOCKSIZE, FF_BUG_EDGE, FF_BUG_HPEL_CHROMA, FF_BUG_IEDGE, FF_BUG_QPEL_CHROMA,
    FF_BUG_QPEL_CHROMA2, FF_BUG_STD_QPEL, FF_BUG_UMP4, FF_BUG_XVID_ILACE, PictType,
};
use crate::plan_struct;
use crate::tables::{MPEG4_DC_THRESHOLD, MPEG4_DEFAULT_INTRA_MATRIX, MPEG4_DEFAULT_NON_INTRA_MATRIX, SPRITE_TRAJECTORY_LENS, ZIGZAG_DIRECT};
use crate::vlc::{VLCLookup, lookup_from_lengths};

// Start codes, mpeg4videodefs.h
const VOS_STARTCODE: u32 = 0x1B0;
const USER_DATA_STARTCODE: u32 = 0x1B2;
const GOP_STARTCODE: u32 = 0x1B3;
const VISUAL_OBJ_STARTCODE: u32 = 0x1B5;
const VOP_STARTCODE: u32 = 0x1B6;
// Video object types and shapes
const SIMPLE_VO_TYPE: i32 = 1;
const ADV_SIMPLE_VO_TYPE: i32 = 17;
const SIMPLE_STUDIO_VO_TYPE: i32 = 14;
const CORE_STUDIO_VO_TYPE: i32 = 15;
pub const RECT_SHAPE: i32 = 0;
pub const BIN_ONLY_SHAPE: i32 = 2;
const GRAY_SHAPE: i32 = 3;
pub const STATIC_SPRITE: i32 = 1;
pub const GMC_SPRITE: i32 = 2;
const FF_ASPECT_EXTENDED: u32 = 15;
const VOT_VIDEO_ID: u32 = 1;
const VOT_STILL_TEXTURE_ID: u32 = 2;
// The profile of the Simple Studio profile, which FFmpeg decodes at more than 8 bits
const SIMPLE_STUDIO_PROFILE: u32 = 14;

// The header failure values
pub const HEADER_FRAMERATE: u32 = 1;
pub const HEADER_MATRIX: u32 = 2;
pub const HEADER_TRUNCATED: u32 = 3;
pub const HEADER_WARPING_POINTS: u32 = 4;
pub const HEADER_QSCALE: u32 = 5;
pub const HEADER_F_CODE: u32 = 6;
pub const HEADER_B_CODE: u32 = 7;
pub const HEADER_SPRITE: u32 = 8;
pub const HEADER_NO_VOP: u32 = 9;
// The unsupported feature values: the studio profile, a shape other than rectangular, static sprites, and old libavcodec's qpel
pub const UNSUPPORTED_STUDIO: u32 = 1;
pub const UNSUPPORTED_SHAPE: u32 = 2;
pub const UNSUPPORTED_STATIC_SPRITE: u32 = 3;
pub const UNSUPPORTED_STD_QPEL: u32 = 4;
pub const UNSUPPORTED_SCALABILITY: u32 = 5;
pub const UNSUPPORTED_NEW_PRED: u32 = 6;

static SPRITE_TRAJECTORY: LazyLock<VLCLookup> = LazyLock::new(|| lookup_from_lengths(&SPRITE_TRAJECTORY_LENS));

/// What ff_mpeg4_parse_picture_header found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeaderOutcome {
    /// A VOP header, its macroblocks starting at the reader's position
    Vop,
    /// FRAME_SKIPPED: a VOP that codes no picture, or a packet FFmpeg skips
    Skipped,
    /// The headers ended without a VOP, as extradata does
    End,
}

/// The stream state of FFmpeg's Mpeg4DecContext and MpegEncContext that headers set and read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mpeg4Header {
    pub codec_tag: u32,
    pub width: i32,
    pub height: i32,
    pub vo_type: i32,
    pub vol_control_parameters: bool,
    pub low_delay: bool,
    pub shape: i32,
    pub framerate_num: i32,
    pub framerate_den: i32,
    pub time_increment_bits: i32,
    pub t_frame: i32,
    pub progressive_sequence: bool,
    pub vol_sprite_usage: i32,
    pub num_sprite_warping_points: i32,
    pub sprite_warping_accuracy: i32,
    pub sprite_brightness_change: bool,
    pub quant_precision: i32,
    pub mpeg_quant: bool,
    pub intra_matrix: [u16; 64],
    pub inter_matrix: [u16; 64],
    pub quarter_sample: bool,
    pub cplx_estimation_trash_i: i32,
    pub cplx_estimation_trash_p: i32,
    pub cplx_estimation_trash_b: i32,
    pub resync_marker: bool,
    pub data_partitioning: bool,
    pub rvlc: bool,
    pub new_pred: bool,
    pub scalability: bool,
    pub enhancement_type: bool,
    pub divx_version: i32,
    pub divx_build: i32,
    pub divx_packed: bool,
    pub lavc_build: i32,
    pub xvid_build: i32,
    pub workaround_bugs: u32,
    pub xvid_idct: bool,
    pub picture_number: i32,
    // Timing
    pub time_base: i32,
    pub last_time_base: i32,
    pub time: i64,
    pub last_non_b_time: i64,
    pub pp_time: u16,
    pub pb_time: u16,
    pub pp_field_time: u16,
    pub pb_field_time: u16,
    /// The size changed since the last picture, FFmpeg's context_reinit
    pub context_reinit: bool,
    /// h_edge_pos and v_edge_pos are the visible size, as decode_vop_header sets them once FF_BUG_EDGE is on; a context reinit
    /// resets them to the macroblock-aligned size
    pub visible_edges: bool,
}

/// The VOP header's fields a picture decodes with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VopHeader {
    pub pict_type: PictType,
    pub qscale: i32,
    pub f_code: i32,
    pub b_code: i32,
    pub no_rounding: bool,
    pub intra_dc_threshold: i32,
    pub top_field_first: bool,
    pub alternate_scan: bool,
    pub sprite: SpriteWarp,
    pub sprite_shift: [i32; 2],
}

plan_struct!(VopHeader { pict_type, qscale, f_code, b_code, no_rounding, intra_dc_threshold, top_field_first, alternate_scan, sprite, sprite_shift });
plan_struct!(SpriteWarp { real_sprite_warping_points, sprite_warping_accuracy, sprite_offset, sprite_delta });

impl crate::plan::PlanField for PictType {
    fn write(&self, writer: &mut crate::plan::PlanWriter) {
        writer.words.push(self.number() as u32);
    }
    fn read(reader: &mut crate::plan::PlanReader) -> Option<Self> {
        match reader.word()? {
            1 => Some(PictType::I),
            2 => Some(PictType::P),
            3 => Some(PictType::B),
            4 => Some(PictType::S),
            _ => None,
        }
    }
}

fn header_failure<T>(value: u32) -> DecodeResult<T> {
    error::fail(ERROR_PICTURE_HEADER, value)
}

fn sequence_failure<T>(value: u32) -> DecodeResult<T> {
    error::fail(ERROR_SEQUENCE_HEADER, value)
}

/// FFmpeg's av_log2.
fn av_log2(value: u32) -> i32 {
    if value == 0 { 0 } else { 31 - value.leading_zeros() as i32 }
}

/// Parses an integer at the start of text as sscanf's %d does: optional sign, then digits.
fn scan_int(text: &[u8]) -> Option<(i32, &[u8])> {
    let mut index: usize = 0;
    while index < text.len() && text[index].is_ascii_whitespace() {
        index += 1;
    }
    let negative: bool = index < text.len() && text[index] == b'-';
    if index < text.len() && (text[index] == b'-' || text[index] == b'+') {
        index += 1;
    }
    let start: usize = index;
    let mut value: i64 = 0;
    while index < text.len() && text[index].is_ascii_digit() {
        value = (value * 10 + i64::from(text[index] - b'0')).min(i64::from(i32::MAX) + 1);
        index += 1;
    }
    if index == start {
        return None;
    }
    let value: i32 = if negative { (-value).max(i64::from(i32::MIN)) as i32 } else { value.min(i64::from(i32::MAX)) as i32 };
    Some((value, &text[index..]))
}

impl Mpeg4Header {
    /// decode_init's state for a stream of the configuration's FourCC and size.
    pub fn new(codec_tag: u32, width: i32, height: i32) -> Self {
        Self {
            codec_tag,
            width,
            height,
            vo_type: 0,
            vol_control_parameters: false,
            low_delay: false,
            shape: RECT_SHAPE,
            framerate_num: 0,
            framerate_den: 1,
            time_increment_bits: 4,
            t_frame: 0,
            progressive_sequence: true,
            vol_sprite_usage: 0,
            num_sprite_warping_points: 0,
            sprite_warping_accuracy: 0,
            sprite_brightness_change: false,
            quant_precision: 5,
            mpeg_quant: false,
            intra_matrix: [0; 64],
            inter_matrix: [0; 64],
            quarter_sample: false,
            cplx_estimation_trash_i: 0,
            cplx_estimation_trash_p: 0,
            cplx_estimation_trash_b: 0,
            resync_marker: false,
            data_partitioning: false,
            rvlc: false,
            new_pred: false,
            scalability: false,
            enhancement_type: false,
            divx_version: -1,
            divx_build: -1,
            divx_packed: false,
            lavc_build: -1,
            xvid_build: -1,
            workaround_bugs: FF_BUG_AUTODETECT,
            xvid_idct: false,
            picture_number: 0,
            time_base: 0,
            last_time_base: 0,
            time: 0,
            last_non_b_time: 0,
            pp_time: 0,
            pb_time: 0,
            pp_field_time: 0,
            pb_field_time: 0,
            context_reinit: false,
            visible_edges: false,
        }
    }

    /// ff_mpeg4_parse_picture_header: the start codes before a VOP, then its header. `header` parses extradata, where running out of
    /// bytes ends the headers.
    pub fn parse_picture_header(&mut self, gb: &mut BitReader, header: bool) -> DecodeResult<(HeaderOutcome, VopHeader)> {
        gb.align();
        if self.codec_tag == fourcc(b"WV1F") && gb.show_bits(24) == 0x575630 {
            gb.skip_bits(24);
            if gb.get_bits(8) == 0xF0 {
                return self.decode_vop_header(gb);
            }
        }
        let mut startcode: u32 = 0xff;
        let mut vol: bool = false;
        loop {
            if gb.bits_count() >= gb.size_in_bits() {
                if gb.size_in_bits() == 8 && (self.divx_version >= 0 || self.xvid_build >= 0) || self.codec_tag == fourcc(b"QMP4") {
                    return Ok((HeaderOutcome::Skipped, VopHeader::default()));
                }
                if header && gb.bits_count() == gb.size_in_bits() {
                    return Ok((HeaderOutcome::End, VopHeader::default()));
                }
                return header_failure(HEADER_NO_VOP);
            }
            let v: u32 = gb.get_bits(8);
            startcode = (startcode << 8) | v;
            if startcode & 0xFFFF_FF00 != 0x100 {
                continue;
            }
            if (0x120..=0x12F).contains(&startcode) {
                if !vol {
                    vol = true;
                    self.decode_vol_header(gb)?;
                }
            } else if startcode == USER_DATA_STARTCODE {
                self.decode_user_data(gb);
            } else if startcode == GOP_STARTCODE {
                self.decode_gop_header(gb);
            } else if startcode == VOS_STARTCODE {
                let profile: u32 = gb.get_bits(4);
                let level: u32 = gb.get_bits(4);
                if profile == SIMPLE_STUDIO_PROFILE && level > 0 && level < 9 {
                    return error::fail(ERROR_UNSUPPORTED_FEATURE, UNSUPPORTED_STUDIO);
                }
            } else if startcode == VISUAL_OBJ_STARTCODE {
                decode_visual_object(gb);
            } else if startcode == VOP_STARTCODE {
                break;
            }
            gb.align();
            startcode = 0xff;
        }
        self.decode_vop_header(gb)
    }

    /// mpeg4_decode_gop_header.
    fn decode_gop_header(&mut self, gb: &mut BitReader) {
        if gb.show_bits(23) == 0 {
            return;
        }
        let hours: i32 = gb.get_bits(5) as i32;
        let minutes: i32 = gb.get_bits(6) as i32;
        gb.skip_bits(1);
        let seconds: i32 = gb.get_bits(6) as i32;
        self.time_base = seconds + 60 * (minutes + 60 * hours);
        gb.skip_bits(2);
    }

    /// decode_user_data: the encoder's name and build, which select FFmpeg's workarounds.
    fn decode_user_data(&mut self, gb: &mut BitReader) {
        let mut buf: Vec<u8> = Vec::with_capacity(255);
        while buf.len() < 255 && gb.bits_count() < gb.size_in_bits() {
            if gb.show_bits(23) == 0 {
                break;
            }
            buf.push(gb.get_bits(8) as u8);
        }
        if let Some(end) = buf.iter().position(|&byte: &u8| byte == 0) {
            buf.truncate(end);
        }
        // DivX%dBuild%d%c, then DivX%db%d%c
        for separator in [b"Build".as_slice(), b"b".as_slice()] {
            if let Some(rest) = buf.strip_prefix(b"DivX")
                && let Some((version, rest)) = scan_int(rest)
                && let Some(rest) = rest.strip_prefix(separator)
                && let Some((build, rest)) = scan_int(rest)
            {
                self.divx_version = version;
                self.divx_build = build;
                self.divx_packed = rest.first() == Some(&b'p');
                break;
            }
        }
        // FFmpe%*[^b]b%d, then FFmpeg v%d.%d.%d / libavcodec build: %d, then Lavc%d.%d.%d
        let mut lavc_build: Option<i32> = None;
        if let Some(rest) = buf.strip_prefix(b"FFmpe")
            && let Some(position) = rest.iter().position(|&byte: &u8| byte == b'b')
            && position > 0
            && let Some((build, _)) = scan_int(&rest[position + 1..])
        {
            lavc_build = Some(build);
        }
        if lavc_build.is_none()
            && let Some(rest) = buf.strip_prefix(b"FFmpeg v")
            && let Some((_, rest)) = scan_int(rest)
            && let Some(rest) = rest.strip_prefix(b".")
            && let Some((_, rest)) = scan_int(rest)
            && let Some(rest) = rest.strip_prefix(b".")
            && let Some((_, rest)) = scan_int(rest)
            && let Some(rest) = rest.strip_prefix(b" / libavcodec build: ")
            && let Some((build, _)) = scan_int(rest)
        {
            lavc_build = Some(build);
        }
        if lavc_build.is_none()
            && let Some(rest) = buf.strip_prefix(b"Lavc")
        {
            // sscanf's count plus one must be 4: all three numbers read
            if let Some((ver, rest)) = scan_int(rest)
                && let Some(rest) = rest.strip_prefix(b".")
                && let Some((ver2, rest)) = scan_int(rest)
                && let Some(rest) = rest.strip_prefix(b".")
                && let Some((ver3, _)) = scan_int(rest)
            {
                lavc_build = Some(((ver & 0xFF) << 16) + ((ver2 & 0xFF) << 8) + (ver3 & 0xFF));
            }
        }
        match lavc_build {
            Some(build) => self.lavc_build = build,
            None if buf == b"ffmpeg" => self.lavc_build = 4600,
            None => {}
        }
        if let Some(rest) = buf.strip_prefix(b"XviD")
            && let Some((build, _)) = scan_int(rest)
        {
            self.xvid_build = build;
        }
    }

    /// mpeg4_load_default_matrices, under the identity permutation.
    fn load_default_matrices(&mut self) {
        for i in 0..64 {
            self.intra_matrix[i] = MPEG4_DEFAULT_INTRA_MATRIX[i] as u16;
            self.inter_matrix[i] = MPEG4_DEFAULT_NON_INTRA_MATRIX[i] as u16;
        }
    }

    /// Reads a custom quantizer matrix in zigzag order, its last value repeating after a zero.
    fn read_matrix(gb: &mut BitReader, matrix: &mut [u16; 64]) -> DecodeResult<()> {
        let mut last: u16 = 0;
        let mut i: usize = 0;
        while i < 64 {
            if gb.bits_left() < 8 {
                return sequence_failure(HEADER_MATRIX);
            }
            let v: u16 = gb.get_bits(8) as u16;
            if v == 0 {
                break;
            }
            last = v;
            matrix[usize::from(ZIGZAG_DIRECT[i])] = v;
            i += 1;
        }
        while i < 64 {
            matrix[usize::from(ZIGZAG_DIRECT[i])] = last;
            i += 1;
        }
        Ok(())
    }

    /// decode_vol_header.
    fn decode_vol_header(&mut self, gb: &mut BitReader) -> DecodeResult<()> {
        gb.skip_bits(1);
        self.vo_type = gb.get_bits(8) as i32;
        if self.vo_type == CORE_STUDIO_VO_TYPE || self.vo_type == SIMPLE_STUDIO_VO_TYPE {
            return error::fail(ERROR_UNSUPPORTED_FEATURE, UNSUPPORTED_STUDIO);
        }
        let vo_ver_id: u32 = if gb.get_flag() {
            let version: u32 = gb.get_bits(4);
            gb.skip_bits(3);
            version
        } else {
            1
        };
        let aspect_ratio_info: u32 = gb.get_bits(4);
        if aspect_ratio_info == FF_ASPECT_EXTENDED {
            gb.skip_bits(16);
        }
        self.vol_control_parameters = gb.get_flag();
        if self.vol_control_parameters {
            gb.skip_bits(2);
            self.low_delay = gb.get_flag();
            if gb.get_flag() {
                gb.skip_bits(15 + 1 + 15 + 1 + 15 + 1 + 3 + 11 + 1 + 15 + 1);
            }
        } else if self.picture_number == 0 {
            self.low_delay = self.vo_type == SIMPLE_VO_TYPE || self.vo_type == ADV_SIMPLE_VO_TYPE;
        }
        self.shape = gb.get_bits(2) as i32;
        if self.shape == GRAY_SHAPE && vo_ver_id != 1 {
            gb.skip_bits(4);
        }
        gb.skip_bits(1);
        self.framerate_num = gb.get_bits(16) as i32;
        if self.framerate_num == 0 {
            return sequence_failure(HEADER_FRAMERATE);
        }
        self.time_increment_bits = (av_log2((self.framerate_num - 1) as u32) + 1).max(1);
        gb.skip_bits(1);
        self.framerate_den = if gb.get_flag() { gb.get_bits(self.time_increment_bits as u32) as i32 } else { 1 };
        self.t_frame = 0;
        if self.shape != BIN_ONLY_SHAPE {
            if self.shape == RECT_SHAPE {
                gb.skip_bits(1);
                let width: i32 = gb.get_bits(13) as i32;
                gb.skip_bits(1);
                let height: i32 = gb.get_bits(13) as i32;
                gb.skip_bits(1);
                if width != 0 && height != 0 && !(self.width != 0 && self.codec_tag == fourcc(b"MP4S")) {
                    if self.width != 0 && self.height != 0 && (self.width != width || self.height != height) {
                        self.context_reinit = true;
                    }
                    self.width = width;
                    self.height = height;
                }
            }
            self.progressive_sequence = !gb.get_flag();
            gb.skip_bits(1);
            self.vol_sprite_usage = if vo_ver_id == 1 { gb.get_bits(1) as i32 } else { gb.get_bits(2) as i32 };
            if self.vol_sprite_usage == STATIC_SPRITE || self.vol_sprite_usage == GMC_SPRITE {
                if self.vol_sprite_usage == STATIC_SPRITE {
                    gb.skip_bits(13 + 1 + 13 + 1 + 13 + 1 + 13 + 1);
                }
                self.num_sprite_warping_points = gb.get_bits(6) as i32;
                if self.num_sprite_warping_points > 3 {
                    self.num_sprite_warping_points = 0;
                    return sequence_failure(HEADER_WARPING_POINTS);
                }
                self.sprite_warping_accuracy = gb.get_bits(2) as i32;
                self.sprite_brightness_change = gb.get_flag();
                if self.vol_sprite_usage == STATIC_SPRITE {
                    gb.skip_bits(1);
                }
            }
            if gb.get_flag() {
                self.quant_precision = gb.get_bits(4) as i32;
                gb.skip_bits(4);
                if self.quant_precision < 3 || self.quant_precision > 9 {
                    self.quant_precision = 5;
                }
            } else {
                self.quant_precision = 5;
            }
            self.mpeg_quant = gb.get_flag();
            if self.mpeg_quant {
                self.load_default_matrices();
                if gb.get_flag() {
                    Self::read_matrix(gb, &mut self.intra_matrix)?;
                }
                if gb.get_flag() {
                    Self::read_matrix(gb, &mut self.inter_matrix)?;
                }
            }
            self.quarter_sample = vo_ver_id != 1 && gb.get_flag();
            if gb.bits_left() < 4 {
                return sequence_failure(HEADER_TRUNCATED);
            }
            if !gb.get_flag() {
                self.read_complexity_estimation(gb);
            } else {
                self.cplx_estimation_trash_i = 0;
                self.cplx_estimation_trash_p = 0;
                self.cplx_estimation_trash_b = 0;
            }
            self.resync_marker = !gb.get_flag();
            self.data_partitioning = gb.get_flag();
            if self.data_partitioning {
                self.rvlc = gb.get_flag();
            }
            if vo_ver_id != 1 {
                self.new_pred = gb.get_flag();
                if self.new_pred {
                    gb.skip_bits(3);
                }
                gb.skip_bits(1);
            } else {
                self.new_pred = false;
            }
            self.scalability = gb.get_flag();
            if self.scalability {
                let backup: BitReader = gb.clone();
                gb.skip_bits(1 + 4 + 1);
                let factors: [u32; 4] = [gb.get_bits(5), gb.get_bits(5), gb.get_bits(5), gb.get_bits(5)];
                self.enhancement_type = gb.get_flag();
                if factors.contains(&0) {
                    self.scalability = false;
                    *gb = backup;
                }
            }
        }
        Ok(())
    }

    /// The complexity estimation header of decode_vol_header, which only sets the bits each VOP header skips.
    fn read_complexity_estimation(&mut self, gb: &mut BitReader) {
        let position: usize = gb.bits_count();
        let estimation_method: u32 = gb.get_bits(2);
        if estimation_method >= 2 {
            return;
        }
        let sum = |gb: &mut BitReader, weight: i32, count: usize| -> i32 { (0..count).map(|_| weight * gb.get_bits1() as i32).sum() };
        if !gb.get_flag() {
            self.cplx_estimation_trash_i += sum(gb, 8, 6);
        }
        if !gb.get_flag() {
            self.cplx_estimation_trash_i += sum(gb, 8, 1);
            self.cplx_estimation_trash_p += sum(gb, 8, 2);
            self.cplx_estimation_trash_i += sum(gb, 8, 1);
        }
        if !gb.get_flag() {
            gb.seek(position);
            self.cplx_estimation_trash_i = 0;
            self.cplx_estimation_trash_p = 0;
            self.cplx_estimation_trash_b = 0;
            return;
        }
        if !gb.get_flag() {
            self.cplx_estimation_trash_i += sum(gb, 8, 3);
            self.cplx_estimation_trash_i += sum(gb, 4, 1);
        }
        if !gb.get_flag() {
            self.cplx_estimation_trash_p += sum(gb, 8, 2);
            self.cplx_estimation_trash_b += sum(gb, 8, 1);
            self.cplx_estimation_trash_p += sum(gb, 8, 3);
        }
        if !gb.get_flag() {
            gb.seek(position);
            self.cplx_estimation_trash_i = 0;
            self.cplx_estimation_trash_p = 0;
            self.cplx_estimation_trash_b = 0;
            return;
        }
        if estimation_method == 1 {
            self.cplx_estimation_trash_i += sum(gb, 8, 1);
            self.cplx_estimation_trash_p += sum(gb, 8, 1);
        }
    }

    /// decode_vop_header, then ff_mpeg4_workaround_bugs, which ff_h263_decode_frame runs right after the header.
    fn decode_vop_header(&mut self, gb: &mut BitReader) -> DecodeResult<(HeaderOutcome, VopHeader)> {
        let mut vop: VopHeader = VopHeader {
            pict_type: match gb.get_bits(2) {
                0 => PictType::I,
                1 => PictType::P,
                2 => PictType::B,
                _ => PictType::S,
            },
            ..VopHeader::default()
        };
        if vop.pict_type == PictType::B && self.low_delay && !self.vol_control_parameters {
            self.low_delay = false;
        }
        let mut time_incr: i32 = 0;
        while gb.get_flag() {
            time_incr += 1;
        }
        gb.skip_bits(1);
        if self.time_increment_bits == 0 || gb.show_bits(self.time_increment_bits as u32 + 1) & 1 == 0 {
            self.time_increment_bits = 1;
            while self.time_increment_bits < 16 {
                let bits: u32 = self.time_increment_bits as u32;
                if vop.pict_type == PictType::P || (vop.pict_type == PictType::S && self.vol_sprite_usage == GMC_SPRITE) {
                    if gb.show_bits(bits + 6) & 0x37 == 0x30 {
                        break;
                    }
                } else if gb.show_bits(bits + 5) & 0x1F == 0x18 {
                    break;
                }
                self.time_increment_bits += 1;
            }
        }
        let time_increment: i64 = i64::from(gb.get_bits(self.time_increment_bits as u32));
        let framerate_num: i64 = i64::from(self.framerate_num);
        if vop.pict_type != PictType::B {
            self.last_time_base = self.time_base;
            self.time_base += time_incr;
            self.time = i64::from(self.time_base) * framerate_num + time_increment;
            if self.workaround_bugs & FF_BUG_UMP4 != 0 && self.time < self.last_non_b_time {
                self.time_base += 1;
                self.time += framerate_num;
            }
            self.pp_time = (self.time - self.last_non_b_time) as u16;
            self.last_non_b_time = self.time;
        } else {
            self.time = i64::from(self.last_time_base + time_incr) * framerate_num + time_increment;
            self.pb_time = (i64::from(self.pp_time) - (self.last_non_b_time - self.time)) as u16;
            let pp: i32 = i32::from(self.pp_time);
            let pb: i32 = i32::from(self.pb_time);
            if pp <= pb || pp <= pp - pb || pp <= 0 {
                return Ok((HeaderOutcome::Skipped, vop));
            }
            if self.t_frame == 0 {
                self.t_frame = pb;
            }
            if self.t_frame == 0 {
                self.t_frame = 1;
            }
            let t_frame: i64 = i64::from(self.t_frame);
            let rounded = |value: i64| -> i64 { if value >= 0 { (value + (t_frame >> 1)) / t_frame } else { (value - (t_frame >> 1)) / t_frame } };
            let base: i64 = rounded(self.last_non_b_time - i64::from(self.pp_time));
            self.pp_field_time = ((rounded(self.last_non_b_time) - base) * 2) as u16;
            self.pb_field_time = ((rounded(self.time) - base) * 2) as u16;
            if self.pp_field_time <= self.pb_field_time || self.pb_field_time <= 1 {
                self.pb_field_time = 2;
                self.pp_field_time = 4;
                if !self.progressive_sequence {
                    return Ok((HeaderOutcome::Skipped, vop));
                }
            }
        }
        gb.skip_bits(1);
        if !gb.get_flag() {
            return Ok((HeaderOutcome::Skipped, vop));
        }
        if self.new_pred {
            return error::fail(ERROR_UNSUPPORTED_FEATURE, UNSUPPORTED_NEW_PRED);
        }
        vop.no_rounding = self.shape != BIN_ONLY_SHAPE
            && (vop.pict_type == PictType::P || (vop.pict_type == PictType::S && self.vol_sprite_usage == GMC_SPRITE))
            && gb.get_flag();
        if self.shape != RECT_SHAPE {
            return error::fail(ERROR_UNSUPPORTED_FEATURE, UNSUPPORTED_SHAPE);
        }
        gb.skip_bits(self.cplx_estimation_trash_i as u32);
        if vop.pict_type != PictType::I {
            gb.skip_bits(self.cplx_estimation_trash_p as u32);
        }
        if vop.pict_type == PictType::B {
            gb.skip_bits(self.cplx_estimation_trash_b as u32);
        }
        if gb.bits_left() < 3 {
            return header_failure(HEADER_TRUNCATED);
        }
        vop.intra_dc_threshold = i32::from(MPEG4_DC_THRESHOLD[gb.get_bits(3) as usize]);
        if !self.progressive_sequence {
            vop.top_field_first = gb.get_flag();
            vop.alternate_scan = gb.get_flag();
        }
        if vop.pict_type == PictType::S {
            if self.vol_sprite_usage == STATIC_SPRITE {
                return error::fail(ERROR_UNSUPPORTED_FEATURE, UNSUPPORTED_STATIC_SPRITE);
            }
            if self.vol_sprite_usage == GMC_SPRITE {
                let (sprite, shift) = self.decode_sprite_trajectory(gb)?;
                vop.sprite = sprite;
                vop.sprite_shift = shift;
            }
        }
        vop.f_code = 1;
        vop.b_code = 1;
        vop.qscale = gb.get_bits(self.quant_precision as u32) as i32;
        if vop.qscale == 0 {
            return header_failure(HEADER_QSCALE);
        }
        if vop.pict_type != PictType::I {
            vop.f_code = gb.get_bits(3) as i32;
            if vop.f_code == 0 {
                return header_failure(HEADER_F_CODE);
            }
        }
        if vop.pict_type == PictType::B {
            vop.b_code = gb.get_bits(3) as i32;
            if vop.b_code == 0 {
                return header_failure(HEADER_B_CODE);
            }
        }
        if self.scalability {
            return error::fail(ERROR_UNSUPPORTED_FEATURE, UNSUPPORTED_SCALABILITY);
        }
        if self.vo_type == 0 && !self.vol_control_parameters && self.divx_version == -1 && self.picture_number == 0 {
            self.low_delay = true;
        }
        self.picture_number += 1;
        if self.workaround_bugs & FF_BUG_EDGE != 0 {
            self.visible_edges = true;
        }
        self.workaround_bugs_after_header();
        Ok((HeaderOutcome::Vop, vop))
    }

    /// mpeg4_decode_sprite_trajectory: the warp of an S(GMC)-VOP and FFmpeg's sprite_shift.
    fn decode_sprite_trajectory(&self, gb: &mut BitReader) -> DecodeResult<(SpriteWarp, [i32; 2])> {
        let accuracy: i32 = self.sprite_warping_accuracy;
        let a: i32 = 2 << accuracy;
        let rho: i32 = 3 - accuracy;
        let r: i32 = 16 / a;
        let mut alpha: i32 = 1;
        let mut beta: i32 = 0;
        let w: i32 = self.width;
        let h: i32 = self.height;
        if w <= 0 || h <= 0 {
            return header_failure(HEADER_SPRITE);
        }
        let vop_ref: [[i32; 2]; 4] = [[0, 0], [w, 0], [0, h], [w, h]];
        let mut d: [[i32; 2]; 4] = [[0; 2]; 4];
        let divx_413: bool = self.divx_version == 500 && self.divx_build == 413;
        for point in d.iter_mut().take(self.num_sprite_warping_points as usize) {
            let read = |gb: &mut BitReader| -> DecodeResult<i32> {
                let length: u32 = gb.get_vlc(&SPRITE_TRAJECTORY).ok_or(error::DecodeError { code: ERROR_PICTURE_HEADER, value: HEADER_SPRITE })?;
                Ok(if length > 0 { gb.get_xbits(length) } else { 0 })
            };
            let x: i32 = read(gb)?;
            if !divx_413 {
                gb.skip_bits(1);
            }
            let y: i32 = read(gb)?;
            gb.skip_bits(1);
            *point = [x, y];
        }
        while (1 << alpha) < w {
            alpha += 1;
        }
        while (1 << beta) < h {
            beta += 1;
        }
        let w2: i32 = 1 << alpha;
        let h2: i32 = 1 << beta;
        let mut sprite_ref: [[i32; 2]; 3] = [[0; 2]; 3];
        if divx_413 {
            sprite_ref[0] = [a * vop_ref[0][0] + d[0][0], a * vop_ref[0][1] + d[0][1]];
            sprite_ref[1] = [a * vop_ref[1][0] + d[0][0] + d[1][0], a * vop_ref[1][1] + d[0][1] + d[1][1]];
            sprite_ref[2] = [a * vop_ref[2][0] + d[0][0] + d[2][0], a * vop_ref[2][1] + d[0][1] + d[2][1]];
        } else {
            sprite_ref[0] = [(a >> 1) * (2 * vop_ref[0][0] + d[0][0]), (a >> 1) * (2 * vop_ref[0][1] + d[0][1])];
            sprite_ref[1] = [(a >> 1) * (2 * vop_ref[1][0] + d[0][0] + d[1][0]), (a >> 1) * (2 * vop_ref[1][1] + d[0][1] + d[1][1])];
            sprite_ref[2] = [(a >> 1) * (2 * vop_ref[2][0] + d[0][0] + d[2][0]), (a >> 1) * (2 * vop_ref[2][1] + d[0][1] + d[2][1])];
        }
        let rounded64 = |numerator: i64, denominator: i64| -> i64 {
            if numerator >= 0 { (numerator + (denominator >> 1)) / denominator } else { (numerator - (denominator >> 1)) / denominator }
        };
        let (r64, w64, h64, w264, h264): (i64, i64, i64, i64, i64) = (i64::from(r), i64::from(w), i64::from(h), i64::from(w2), i64::from(h2));
        let sr = |i: usize, j: usize| -> i64 { i64::from(sprite_ref[i][j]) };
        let vr = |i: usize, j: usize| -> i64 { i64::from(vop_ref[i][j]) };
        let virtual_ref: [[i64; 2]; 2] = [
            [
                (16 * (vr(0, 0) + w264) + rounded64((w64 - w264) * (r64 * sr(0, 0) - 16 * vr(0, 0)) + w264 * (r64 * sr(1, 0) - 16 * vr(1, 0)), w64)) as i32
                    as i64,
                (16 * vr(0, 1) + rounded64((w64 - w264) * (r64 * sr(0, 1) - 16 * vr(0, 1)) + w264 * (r64 * sr(1, 1) - 16 * vr(1, 1)), w64)) as i32 as i64,
            ],
            [
                (16 * vr(0, 0) + rounded64((h64 - h264) * (r64 * sr(0, 0) - 16 * vr(0, 0)) + h264 * (r64 * sr(2, 0) - 16 * vr(2, 0)), h64)) as i32 as i64,
                (16 * (vr(0, 1) + h264) + rounded64((h64 - h264) * (r64 * sr(0, 1) - 16 * vr(0, 1)) + h264 * (r64 * sr(2, 1) - 16 * vr(2, 1)), h64)) as i32
                    as i64,
            ],
        ];
        let mut sprite_offset: [[i64; 2]; 2] = [[0; 2]; 2];
        let mut sprite_delta: [[i64; 2]; 2] = [[0; 2]; 2];
        let mut sprite_shift: [i32; 2] = [0; 2];
        let a64: i64 = i64::from(a);
        let (alpha64, beta64, rho64): (i64, i64, i64) = (i64::from(alpha), i64::from(beta), i64::from(rho));
        match self.num_sprite_warping_points {
            0 => {
                sprite_delta = [[a64, 0], [0, a64]];
            }
            1 => {
                sprite_offset[0] = [sr(0, 0) - a64 * vr(0, 0), sr(0, 1) - a64 * vr(0, 1)];
                sprite_offset[1] = [
                    ((sr(0, 0) >> 1) | (sr(0, 0) & 1)) - a64 * (vr(0, 0) / 2),
                    ((sr(0, 1) >> 1) | (sr(0, 1) & 1)) - a64 * (vr(0, 1) / 2),
                ];
                sprite_delta = [[a64, 0], [0, a64]];
            }
            2 => {
                let shift: i64 = alpha64 + rho64;
                sprite_offset[0][0] = sr(0, 0) * (1 << shift)
                    + (-r64 * sr(0, 0) + virtual_ref[0][0]) * (-vr(0, 0))
                    + (r64 * sr(0, 1) - virtual_ref[0][1]) * (-vr(0, 1))
                    + (1 << (shift - 1));
                sprite_offset[0][1] = sr(0, 1) * (1 << shift)
                    + (-r64 * sr(0, 1) + virtual_ref[0][1]) * (-vr(0, 0))
                    + (-r64 * sr(0, 0) + virtual_ref[0][0]) * (-vr(0, 1))
                    + (1 << (shift - 1));
                sprite_offset[1][0] = (-r64 * sr(0, 0) + virtual_ref[0][0]) * (-2 * vr(0, 0) + 1)
                    + (r64 * sr(0, 1) - virtual_ref[0][1]) * (-2 * vr(0, 1) + 1)
                    + 2 * w264 * r64 * sr(0, 0)
                    - 16 * w264
                    + (1 << (shift + 1));
                sprite_offset[1][1] = (-r64 * sr(0, 1) + virtual_ref[0][1]) * (-2 * vr(0, 0) + 1)
                    + (-r64 * sr(0, 0) + virtual_ref[0][0]) * (-2 * vr(0, 1) + 1)
                    + 2 * w264 * r64 * sr(0, 1)
                    - 16 * w264
                    + (1 << (shift + 1));
                sprite_delta[0][0] = (-r64 * sr(0, 0) + virtual_ref[0][0]) as i32 as i64;
                sprite_delta[0][1] = (r64 * sr(0, 1) - virtual_ref[0][1]) as i32 as i64;
                sprite_delta[1][0] = (-r64 * sr(0, 1) + virtual_ref[0][1]) as i32 as i64;
                sprite_delta[1][1] = (-r64 * sr(0, 0) + virtual_ref[0][0]) as i32 as i64;
                sprite_shift = [alpha + rho, alpha + rho + 2];
            }
            _ => {
                let min_ab: i32 = alpha.min(beta);
                let w3: i64 = w264 >> min_ab;
                let h3: i64 = h264 >> min_ab;
                let shift: i64 = alpha64 + beta64 + rho64 - i64::from(min_ab);
                sprite_offset[0][0] = sr(0, 0) * (1 << shift)
                    + (-r64 * sr(0, 0) + virtual_ref[0][0]) * h3 * (-vr(0, 0))
                    + (-r64 * sr(0, 0) + virtual_ref[1][0]) * w3 * (-vr(0, 1))
                    + (1 << (shift - 1));
                sprite_offset[0][1] = sr(0, 1) * (1 << shift)
                    + (-r64 * sr(0, 1) + virtual_ref[0][1]) * h3 * (-vr(0, 0))
                    + (-r64 * sr(0, 1) + virtual_ref[1][1]) * w3 * (-vr(0, 1))
                    + (1 << (shift - 1));
                sprite_offset[1][0] = (-r64 * sr(0, 0) + virtual_ref[0][0]) * h3 * (-2 * vr(0, 0) + 1)
                    + (-r64 * sr(0, 0) + virtual_ref[1][0]) * w3 * (-2 * vr(0, 1) + 1)
                    + 2 * w264 * h3 * r64 * sr(0, 0)
                    - 16 * w264 * h3
                    + (1 << (shift + 1));
                sprite_offset[1][1] = (-r64 * sr(0, 1) + virtual_ref[0][1]) * h3 * (-2 * vr(0, 0) + 1)
                    + (-r64 * sr(0, 1) + virtual_ref[1][1]) * w3 * (-2 * vr(0, 1) + 1)
                    + 2 * w264 * h3 * r64 * sr(0, 1)
                    - 16 * w264 * h3
                    + (1 << (shift + 1));
                sprite_delta[0][0] = (-r64 * sr(0, 0) + virtual_ref[0][0]) * h3;
                sprite_delta[0][1] = (-r64 * sr(0, 0) + virtual_ref[1][0]) * w3;
                sprite_delta[1][0] = (-r64 * sr(0, 1) + virtual_ref[0][1]) * h3;
                sprite_delta[1][1] = (-r64 * sr(0, 1) + virtual_ref[1][1]) * w3;
                sprite_shift = [shift as i32, shift as i32 + 2];
            }
        }
        let real_points: i32;
        if sprite_delta[0][0] == a64 << sprite_shift[0] && sprite_delta[0][1] == 0 && sprite_delta[1][0] == 0 && sprite_delta[1][1] == a64 << sprite_shift[0] {
            sprite_offset[0][0] >>= sprite_shift[0];
            sprite_offset[0][1] >>= sprite_shift[0];
            sprite_offset[1][0] >>= sprite_shift[1];
            sprite_offset[1][1] >>= sprite_shift[1];
            sprite_delta = [[a64, 0], [0, a64]];
            sprite_shift = [0, 0];
            real_points = 1;
        } else {
            let shift_y: i32 = 16 - sprite_shift[0];
            let shift_c: i32 = 16 - sprite_shift[1];
            let int_max: i64 = i64::from(i32::MAX);
            for i in 0..2 {
                if shift_c < 0
                    || shift_y < 0
                    || sprite_offset[0][i].abs() >= int_max >> shift_y
                    || sprite_offset[1][i].abs() >= int_max >> shift_c
                    || sprite_delta[0][i].abs() >= int_max >> shift_y
                    || sprite_delta[1][i].abs() >= int_max >> shift_y
                {
                    return header_failure(HEADER_SPRITE);
                }
            }
            for i in 0..2 {
                sprite_offset[0][i] *= 1 << shift_y;
                sprite_offset[1][i] *= 1 << shift_c;
                sprite_delta[0][i] *= 1 << shift_y;
                sprite_delta[1][i] *= 1 << shift_y;
                sprite_shift[i] = 16;
            }
            for i in 0..2 {
                let sd: [i64; 2] = [sprite_delta[i][0] - a64 * (1 << 16), sprite_delta[i][1] - a64 * (1 << 16)];
                let (wp, hp): (i64, i64) = (w64 + 16, h64 + 16);
                if (sprite_offset[0][i] + sprite_delta[i][0] * wp).abs() >= int_max
                    || (sprite_offset[0][i] + sprite_delta[i][1] * hp).abs() >= int_max
                    || (sprite_offset[0][i] + sprite_delta[i][0] * wp + sprite_delta[i][1] * hp).abs() >= int_max
                    || (sprite_delta[i][0] * wp).abs() >= int_max
                    || (sprite_delta[i][1] * hp).abs() >= int_max
                    || sd[0].abs() >= int_max
                    || sd[1].abs() >= int_max
                    || (sprite_offset[0][i] + sd[0] * wp).abs() >= int_max
                    || (sprite_offset[0][i] + sd[1] * hp).abs() >= int_max
                    || (sprite_offset[0][i] + sd[0] * wp + sd[1] * hp).abs() >= int_max
                {
                    return header_failure(HEADER_SPRITE);
                }
            }
            real_points = self.num_sprite_warping_points;
        }
        let warp: SpriteWarp = SpriteWarp {
            real_sprite_warping_points: real_points,
            sprite_warping_accuracy: accuracy,
            sprite_offset: [[sprite_offset[0][0] as i32, sprite_offset[0][1] as i32], [sprite_offset[1][0] as i32, sprite_offset[1][1] as i32]],
            sprite_delta: [[sprite_delta[0][0] as i32, sprite_delta[0][1] as i32], [sprite_delta[1][0] as i32, sprite_delta[1][1] as i32]],
        };
        Ok((warp, sprite_shift))
    }

    /// ff_mpeg4_workaround_bugs, which decides the workarounds and the IDCT from the encoder detected so far.
    fn workaround_bugs_after_header(&mut self) {
        let tag: u32 = self.codec_tag;
        if self.xvid_build == -1 && self.divx_version == -1 && self.lavc_build == -1 {
            if [b"XVID", b"XVIX", b"RMP4", b"ZMP4", b"SIPP"].iter().any(|candidate: &&[u8; 4]| tag == fourcc(candidate)) {
                self.xvid_build = 0;
            }
            if self.xvid_build == -1 && tag == fourcc(b"DIVX") && self.vo_type == 0 && !self.vol_control_parameters {
                self.divx_version = 400;
            }
        }
        if self.xvid_build >= 0 && self.divx_version >= 0 {
            self.divx_version = -1;
            self.divx_build = -1;
        }
        let bugs: &mut u32 = &mut self.workaround_bugs;
        if *bugs & FF_BUG_AUTODETECT != 0 {
            let xvid: u32 = self.xvid_build as u32;
            let lavc: u32 = self.lavc_build as u32;
            let divx: u32 = self.divx_version as u32;
            if tag == fourcc(b"XVIX") {
                *bugs |= FF_BUG_XVID_ILACE;
            }
            if tag == fourcc(b"UMP4") {
                *bugs |= FF_BUG_UMP4;
            }
            if self.divx_version >= 500 && self.divx_build < 1814 {
                *bugs |= FF_BUG_QPEL_CHROMA;
            }
            if self.divx_version > 502 && self.divx_build < 1814 {
                *bugs |= FF_BUG_QPEL_CHROMA2;
            }
            if xvid <= 1 {
                *bugs |= FF_BUG_QPEL_CHROMA;
            }
            if xvid <= 12 {
                *bugs |= FF_BUG_EDGE;
            }
            if xvid <= 32 {
                *bugs |= FF_BUG_DC_CLIP;
            }
            if lavc < 4653 {
                *bugs |= FF_BUG_STD_QPEL;
            }
            if lavc < 4655 {
                *bugs |= FF_BUG_DIRECT_BLOCKSIZE;
            }
            if lavc < 4670 {
                *bugs |= FF_BUG_EDGE;
            }
            if lavc <= 4712 {
                *bugs |= FF_BUG_DC_CLIP;
            }
            if lavc & 0xFF >= 100 && lavc > 3621476 && lavc < 3752552 && !(3752037..=3752191).contains(&lavc) {
                *bugs |= FF_BUG_IEDGE;
            }
            if self.divx_version >= 0 {
                *bugs |= FF_BUG_DIRECT_BLOCKSIZE;
            }
            if divx < 500 {
                *bugs |= FF_BUG_EDGE;
            }
            if self.divx_version >= 0 {
                *bugs |= FF_BUG_HPEL_CHROMA;
            }
        }
        if self.xvid_build >= 0 {
            self.xvid_idct = true;
        }
    }
}

/// mpeg4_decode_visual_object, whose color description the engine reads from the container.
fn decode_visual_object(gb: &mut BitReader) {
    if gb.get_flag() {
        gb.skip_bits(4 + 3);
    }
    let visual_object_type: u32 = gb.get_bits(4);
    if (visual_object_type == VOT_VIDEO_ID || visual_object_type == VOT_STILL_TEXTURE_ID) && gb.get_flag() {
        gb.skip_bits(3 + 1);
        if gb.get_flag() {
            gb.skip_bits(24);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_encoders_from_user_data_as_ffmpeg_does() {
        let cases: [(&[u8], i32, i32, i32, bool); 4] = [
            (b"DivX503b1393p", 503, -1, -1, true),
            (b"XviD0067", -1, 67, -1, false),
            (b"Lavc62.11.100", -1, -1, (62 << 16) + (11 << 8) + 100, false),
            (b"DivX501Build20020416", 501, -1, -1, false),
        ];
        for (data, divx, xvid, lavc, packed) in cases {
            let mut header: Mpeg4Header = Mpeg4Header::new(0, 320, 240);
            let mut bytes: Vec<u8> = data.to_vec();
            bytes.extend_from_slice(&[0, 0, 1]);
            header.decode_user_data(&mut BitReader::new(&bytes));
            assert_eq!((header.divx_version, header.xvid_build, header.lavc_build, header.divx_packed), (divx, xvid, lavc, packed), "{data:?}");
        }
    }

    #[test]
    fn switches_xvid_streams_to_the_xvid_idct_and_workarounds() {
        let mut header: Mpeg4Header = Mpeg4Header::new(fourcc(b"XVID"), 320, 240);
        header.workaround_bugs_after_header();
        assert!(header.xvid_idct);
        assert_ne!(header.workaround_bugs & FF_BUG_EDGE, 0);
        let mut lavc: Mpeg4Header = Mpeg4Header::new(0, 320, 240);
        lavc.lavc_build = (62 << 16) + (11 << 8) + 100;
        lavc.workaround_bugs_after_header();
        assert!(!lavc.xvid_idct);
        assert_eq!(lavc.workaround_bugs, FF_BUG_AUTODETECT);
    }
}
