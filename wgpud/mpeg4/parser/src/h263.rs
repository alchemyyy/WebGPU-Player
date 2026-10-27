// FFmpeg's h263 and h263p decoders, which share their code: ituh263dec.c's ff_h263_decode_picture_header with the H.263+ (PLUSPTYPE)
// options, h263_decode_gob_header, and ff_h263_decode_mb with h263_decode_block, h263_pred_acdc (Advanced Intra Coding),
// h263p_decode_umotion (Unrestricted Motion Vectors), preview_obmc (Advanced Prediction), the PB-frame P part, and the B-picture path,
// and what h263dec.c's ff_h263_decode_frame does around the header: the size change that drops every reference and the B picture it
// skips without references.
// The coordinator parses each picture header in decode order, as the header's options persist in FFmpeg's context while UFEP is 0;
// the plan carries the parsed header, and a parse worker decodes the macroblock layer from the bit after it.

use std::sync::LazyLock;

use crate::bitstream::BitReader;
use crate::codec::{AnchorMotion, Configuration, DecodedPicture, PictureInfo, fields_word, fourcc};
use crate::error::{self, DecodeResult};
use crate::h263dec::{
    H263Context, INVALID_CODE, INVALID_LEVEL, INVALID_MOTION, MacroblockLayer, SliceStatus, check_bits, decode_frame_macroblocks,
    h263_lookups, macroblock_failure,
};
use crate::layout::{ERROR_PICTURE_HEADER, ERROR_PICTURE_SIZE, ERROR_RECORD_INVALID, ERROR_UNSUPPORTED_FEATURE};
use crate::motion::MotionContext;
use crate::mpv::{
    Codec, MB_TYPE_16X16, MB_TYPE_8X8, MB_TYPE_ACPRED, MB_TYPE_BACKWARD_MV, MB_TYPE_BIDIR_MV, MB_TYPE_CBP, MB_TYPE_DIRECT2,
    MB_TYPE_FORWARD_MV, MB_TYPE_INTRA, MB_TYPE_QUANT, MB_TYPE_SKIP, MV_DIR_BACKWARD, MV_DIR_FORWARD, MV_DIRECT, MV_TYPE_8X8,
    MV_TYPE_16X16, Mpv, PictType, ScanTable, has_backward_mv, has_forward_mv, is_8x8, is_direct, is_intra,
};
use crate::plan_struct;
use crate::record::RecordHeader;
use crate::sequencer::{AnchorState, CodecStream, PlanStep};
use crate::tables::{
    AIC_DC_SCALE_TABLE, ALTERNATE_HORIZONTAL_SCAN, ALTERNATE_VERTICAL_SCAN, CBPC_B_TAB, H263_CHROMA_QSCALE_TABLE, H263_FORMAT,
    H263_MBTYPE_B_TAB, INTER_LEVEL, INTER_RUN, INTER_VLC, INTRA_LEVEL_AIC, INTRA_RUN_AIC, INTRA_VLC_AIC, MBA_LENGTH, MBA_MAX,
    MODIFIED_QUANT_TAB, MPEG12_DC_SCALE_TABLE,
};
use crate::vlc::{RLTable, RunLevel, VLCLookup, lookup_from_pairs};

// The picture header failure values: no picture start code, a PTYPE marker or H.263 id that is wrong, a source format, UFEP, or
// picture type FFmpeg refuses, a custom clock of zero, a packet too short for the picture's macroblocks, PEI past the packet, and
// a slice-structured picture's SEPB markers
pub const BAD_START_CODE: u32 = 1;
pub const BAD_PTYPE_MARKER: u32 = 2;
pub const BAD_H263_ID: u32 = 3;
pub const BAD_SOURCE_FORMAT: u32 = 4;
pub const BAD_UFEP: u32 = 5;
pub const BAD_PICTURE_TYPE: u32 = 6;
pub const ZERO_FRAMERATE: u32 = 7;
pub const TOO_FEW_BITS: u32 = 8;
pub const BAD_PEI: u32 = 9;
pub const BAD_SLICE_MARKER: u32 = 10;
// The unsupported feature values: options FFmpeg does not decode (it refuses SAC in a version 1 header and decodes the others as if
// they were off), and a B picture whose direct mode reads what the coordinator does not keep
pub const SYNTAX_BASED_ARITHMETIC_CODING: u32 = 1;
pub const REFERENCE_PICTURE_SELECTION: u32 = 2;
pub const INDEPENDENT_SEGMENT_DECODING: u32 = 3;
pub const RECTANGULAR_SLICES: u32 = 4;
pub const ARBITRARY_SLICE_ORDERING: u32 = 5;
pub const B_PICTURE_ANCHOR: u32 = 6;
// The record check failure value of a plan whose picture type does not read
pub const INVALID_PICTURE_TYPE: u32 = 9;

// PTYPE's source formats: 6 is a custom format and 7 the extended PTYPE (PLUSPTYPE)
const CUSTOM_SOURCE_FORMAT: u32 = 6;
const EXTENDED_SOURCE_FORMAT: u32 = 7;
// The picture start code's 22 bits
const PICTURE_START_CODE: u32 = 0x20;
// FFmpeg's FF_ASPECT_EXTENDED, the custom format's pixel aspect ratio code that the ratio's own two bytes follow
const ASPECT_EXTENDED: u32 = 15;
// The inter and intra MCBPC codes of macroblock stuffing
const INTER_STUFFING: u32 = 20;
const INTRA_STUFFING: u32 = 8;
// Larger UMV vector differences than these bits are refused, as FFmpeg asks for a sample of them
const HUGE_UMOTION: i32 = 32768;
// ff_h263_decode_motion's code that read no vector
const INVALID_VECTOR: i32 = 0xffff;
// FFmpeg's direct_scale_mv table size and its bias
const DIRECT_TAB_SIZE: i32 = 64;
const DIRECT_TAB_BIAS: i32 = DIRECT_TAB_SIZE / 2;
// The luma FFmpeg's ff_mpv_frame_start fills an H.263 reference it lacks with
const MISSING_REFERENCE_LUMA: u32 = 16;
// The slice-structured MBA width past which a second marker follows it
const MBA_MARKER_MB_NUM: i32 = 1583;
// The ZYGO intra picture's extra bits FFmpeg reads, and the bits they need
const ZYGO_EXTRA_BITS: u32 = 85 + 13 * 3 * 16 + 50;

/// h263_mb_type_b_map: the mb_type of each B macroblock type code; code 12 is stuffing.
const H263_MB_TYPE_B_MAP: [u32; 15] = [
    MB_TYPE_DIRECT2 | MB_TYPE_BIDIR_MV,
    MB_TYPE_DIRECT2 | MB_TYPE_BIDIR_MV | MB_TYPE_CBP,
    MB_TYPE_DIRECT2 | MB_TYPE_BIDIR_MV | MB_TYPE_CBP | MB_TYPE_QUANT,
    MB_TYPE_FORWARD_MV | MB_TYPE_16X16,
    MB_TYPE_FORWARD_MV | MB_TYPE_CBP | MB_TYPE_16X16,
    MB_TYPE_FORWARD_MV | MB_TYPE_CBP | MB_TYPE_QUANT | MB_TYPE_16X16,
    MB_TYPE_BACKWARD_MV | MB_TYPE_16X16,
    MB_TYPE_BACKWARD_MV | MB_TYPE_CBP | MB_TYPE_16X16,
    MB_TYPE_BACKWARD_MV | MB_TYPE_CBP | MB_TYPE_QUANT | MB_TYPE_16X16,
    MB_TYPE_BIDIR_MV | MB_TYPE_16X16,
    MB_TYPE_BIDIR_MV | MB_TYPE_CBP | MB_TYPE_16X16,
    MB_TYPE_BIDIR_MV | MB_TYPE_CBP | MB_TYPE_QUANT | MB_TYPE_16X16,
    0,
    MB_TYPE_INTRA | MB_TYPE_CBP,
    MB_TYPE_INTRA | MB_TYPE_CBP | MB_TYPE_QUANT,
];

/// ff_h263_rl_inter and ff_rl_intra_aic, h263_mbtype_b_vlc (its symbols index H263_MB_TYPE_B_MAP), cbpc_b_vlc, and the alternate
/// scans AIC's AC prediction reads coefficients in.
struct H263Tables {
    rl_inter: RLTable,
    rl_intra_aic: RLTable,
    mb_type_b: VLCLookup,
    cbpc_b: VLCLookup,
    intra_h_scantable: ScanTable,
    intra_v_scantable: ScanTable,
}

static TABLES: LazyLock<H263Tables> = LazyLock::new(|| H263Tables {
    rl_inter: RLTable::new(102, 58, &INTER_VLC, &INTER_RUN, &INTER_LEVEL),
    rl_intra_aic: RLTable::new(102, 58, &INTRA_VLC_AIC, &INTRA_RUN_AIC, &INTRA_LEVEL_AIC),
    mb_type_b: lookup_from_pairs(&H263_MBTYPE_B_TAB),
    cbpc_b: lookup_from_pairs(&CBPC_B_TAB),
    intra_h_scantable: ScanTable::new(&ALTERNATE_HORIZONTAL_SCAN),
    intra_v_scantable: ScanTable::new(&ALTERNATE_VERTICAL_SCAN),
});

/// FFmpeg's H263_GOB_HEIGHT: the macroblock rows of a GOB.
fn h263_gob_height(height: i32) -> i32 {
    if height <= 400 {
        1
    } else if height <= 800 {
        2
    } else {
        4
    }
}

/// ff_h263_decode_mba: the slice's first macroblock, as its macroblock address of the picture's width codes it.
fn h263_decode_mba(gb: &mut BitReader, mb_num: i32, mb_width: i32) -> (i32, i32) {
    let index: usize = MBA_MAX.iter().position(|&max: &u16| mb_num - 1 <= i32::from(max)).unwrap_or(MBA_MAX.len());
    let mb_pos: i32 = gb.get_bits(u32::from(MBA_LENGTH[index])) as i32;
    (mb_pos % mb_width, mb_pos / mb_width)
}

/// FFmpeg's skip_1stop_8data_bits: PEI and its PSUPP bytes; false when they run past the packet.
fn skip_1stop_8data_bits(gb: &mut BitReader) -> bool {
    if gb.bits_left() <= 0 {
        return false;
    }
    while gb.get_flag() {
        gb.skip_bits(8);
        if gb.bits_left() <= 0 {
            return false;
        }
    }
    true
}

/// The H263DecContext and MpegEncContext fields ff_h263_decode_picture_header writes; they persist from picture to picture, as
/// FFmpeg's context keeps them, so an H.263+ header with UFEP 0 keeps the options of the last one that updated them.
#[derive(Clone, Debug, PartialEq, Eq)]
struct PictureHeader {
    picture_number: i32,
    width: i32,
    height: i32,
    pict_type: PictType,
    qscale: i32,
    no_rounding: bool,
    h263_long_vectors: bool,
    obmc: bool,
    pb_frame: i32,
    custom_pcf: bool,
    umvplus: bool,
    h263_aic: bool,
    loop_filter: bool,
    h263_slice_structured: bool,
    alt_inter_vlc: bool,
    modified_quant: bool,
    /// chroma_qscale_table is ff_h263_chroma_qscale_table, as a modified quantization header left it
    h263_chroma_qscale: bool,
    time: i64,
    last_non_b_time: i64,
    pp_time: u16,
    pb_time: u16,
    low_delay: bool,
    /// The bit the macroblock layer starts at
    header_bits: usize,
}

impl PictureHeader {
    fn new(width: i32, height: i32) -> Self {
        Self {
            picture_number: 0,
            width,
            height,
            pict_type: PictType::I,
            qscale: 0,
            no_rounding: false,
            h263_long_vectors: false,
            obmc: false,
            pb_frame: 0,
            custom_pcf: false,
            umvplus: false,
            h263_aic: false,
            loop_filter: false,
            h263_slice_structured: false,
            alt_inter_vlc: false,
            modified_quant: false,
            h263_chroma_qscale: false,
            time: 0,
            last_non_b_time: 0,
            pp_time: 0,
            pb_time: 0,
            // ff_h263_decode_init's low_delay
            low_delay: true,
            header_bits: 0,
        }
    }

    /// ff_h263_decode_picture_header.
    fn decode(&mut self, gb: &mut BitReader, codec_tag: u32) -> DecodeResult<()> {
        let header = |value: u32| -> DecodeResult<()> { error::fail(ERROR_PICTURE_HEADER, value) };
        gb.align();
        let mut startcode: u32 = gb.get_bits(22 - 8);
        let mut left: i64 = gb.bits_left();
        while left > 24 {
            startcode = ((startcode << 8) | gb.get_bits(8)) & 0x003F_FFFF;
            if startcode == PICTURE_START_CODE {
                break;
            }
            left -= 8;
        }
        if startcode != PICTURE_START_CODE {
            return header(BAD_START_CODE);
        }
        // The temporal reference, unwrapped from 8 bits
        let mut i: i32 = gb.get_bits(8) as i32;
        i -= (i - (self.picture_number & 0xFF) + 128) & !0xFF;
        self.picture_number = (self.picture_number & !0xFF) + i;
        // PTYPE
        if !gb.get_flag() {
            return header(BAD_PTYPE_MARKER);
        }
        if gb.get_flag() {
            return header(BAD_H263_ID);
        }
        // Split screen, document camera, and freeze picture release
        gb.skip_bits(3);
        let format: u32 = gb.get_bits(3);
        if format != EXTENDED_SOURCE_FORMAT && format != CUSTOM_SOURCE_FORMAT {
            // H.263 version 1
            let [width, height]: [u16; 2] = H263_FORMAT[format as usize];
            if width == 0 {
                return header(BAD_SOURCE_FORMAT);
            }
            self.pict_type = if gb.get_flag() { PictType::P } else { PictType::I };
            self.h263_long_vectors = gb.get_flag();
            if gb.get_flag() {
                return error::fail(ERROR_UNSUPPORTED_FEATURE, SYNTAX_BASED_ARITHMETIC_CODING);
            }
            self.obmc = gb.get_flag();
            self.pb_frame = gb.get_bits1() as i32;
            self.qscale = gb.get_bits(5) as i32;
            // Continuous Presence Multipoint
            gb.skip_bits(1);
            self.width = i32::from(width);
            self.height = i32::from(height);
        } else {
            // H.263 version 2: PLUSPTYPE
            let ufep: u32 = gb.get_bits(3);
            let mut format: u32 = format;
            if ufep == 1 {
                // OPPTYPE
                format = gb.get_bits(3);
                self.custom_pcf = gb.get_flag();
                self.umvplus = gb.get_flag();
                if gb.get_flag() {
                    return error::fail(ERROR_UNSUPPORTED_FEATURE, SYNTAX_BASED_ARITHMETIC_CODING);
                }
                self.obmc = gb.get_flag();
                self.h263_aic = gb.get_flag();
                self.loop_filter = gb.get_flag();
                self.h263_slice_structured = gb.get_flag();
                if gb.get_flag() {
                    return error::fail(ERROR_UNSUPPORTED_FEATURE, REFERENCE_PICTURE_SELECTION);
                }
                if gb.get_flag() {
                    return error::fail(ERROR_UNSUPPORTED_FEATURE, INDEPENDENT_SEGMENT_DECODING);
                }
                self.alt_inter_vlc = gb.get_flag();
                self.modified_quant = gb.get_flag();
                if self.modified_quant {
                    self.h263_chroma_qscale = true;
                }
                // Start code emulation prevention, then reserved bits
                gb.skip_bits(1);
                gb.skip_bits(3);
            } else if ufep != 0 {
                return header(BAD_UFEP);
            }
            // MPPTYPE
            self.pict_type = match gb.get_bits(3) {
                0 => PictType::I,
                1 => PictType::P,
                2 => {
                    // Improved PB frames
                    self.pb_frame = 3;
                    PictType::P
                }
                3 => PictType::B,
                // ZYGO's intra picture
                7 => PictType::I,
                _ => return header(BAD_PICTURE_TYPE),
            };
            // Reference picture resampling and reduced-resolution update, which FFmpeg ignores
            gb.skip_bits(2);
            self.no_rounding = gb.get_flag();
            gb.skip_bits(4);
            if ufep != 0 {
                let (width, height): (i32, i32) = if format == CUSTOM_SOURCE_FORMAT {
                    // CPFMT
                    let aspect_ratio_info: u32 = gb.get_bits(4);
                    let width: i32 = (gb.get_bits(9) as i32 + 1) * 4;
                    // A marker FFmpeg only logs
                    gb.skip_bits(1);
                    let height: i32 = gb.get_bits(9) as i32 * 4;
                    if aspect_ratio_info == ASPECT_EXTENDED {
                        // PAR width and height
                        gb.skip_bits(16);
                    }
                    (width, height)
                } else {
                    match H263_FORMAT.get(format as usize) {
                        Some(&[width, height]) => (i32::from(width), i32::from(height)),
                        None => return header(BAD_SOURCE_FORMAT),
                    }
                };
                if width == 0 || height == 0 {
                    return header(BAD_SOURCE_FORMAT);
                }
                self.width = width;
                self.height = height;
                if self.custom_pcf {
                    // CPCFC: the clock conversion code and divisor
                    gb.skip_bits(1);
                    if gb.get_bits(7) == 0 {
                        return header(ZERO_FRAMERATE);
                    }
                }
            }
            if self.custom_pcf {
                // The extended temporal reference
                gb.skip_bits(2);
            }
            if ufep != 0 {
                if self.umvplus && !gb.get_flag() {
                    // UUI
                    gb.skip_bits(1);
                }
                if self.h263_slice_structured {
                    if gb.get_flag() {
                        return error::fail(ERROR_UNSUPPORTED_FEATURE, RECTANGULAR_SLICES);
                    }
                    if gb.get_flag() {
                        return error::fail(ERROR_UNSUPPORTED_FEATURE, ARBITRARY_SLICE_ORDERING);
                    }
                }
                if self.pict_type == PictType::B {
                    // ELNUM, then RLNUM
                    gb.skip_bits(4);
                    if ufep == 1 {
                        gb.skip_bits(4);
                    }
                }
            }
            self.qscale = gb.get_bits(5) as i32;
        }
        // av_image_check_size, within the package's largest side
        if self.width > crate::codec::MAXIMUM_SIDE || self.height > crate::codec::MAXIMUM_SIDE {
            return error::fail(ERROR_PICTURE_SIZE, ((self.width as u32) << 12) | self.height as u32);
        }
        if i64::from(self.width * self.height / 256 / 8) > gb.bits_left() {
            return header(TOO_FEW_BITS);
        }
        let mb_width: i32 = (self.width + 15) / 16;
        let mb_height: i32 = (self.height + 15) / 16;
        if self.pb_frame != 0 {
            // The B picture's temporal reference, its extension, and its quantizer information
            gb.skip_bits(3);
            if self.custom_pcf {
                gb.skip_bits(2);
            }
            gb.skip_bits(2);
        }
        if self.pict_type != PictType::B {
            self.time = i64::from(self.picture_number);
            self.pp_time = (self.time - self.last_non_b_time) as u16;
            self.last_non_b_time = self.time;
        } else {
            self.time = i64::from(self.picture_number);
            self.pb_time = (i64::from(self.pp_time) - (self.last_non_b_time - self.time)) as u16;
            let pp_time: i32 = i32::from(self.pp_time);
            let pb_time: i32 = i32::from(self.pb_time);
            if pp_time <= pb_time || pp_time <= pp_time - pb_time || pp_time <= 0 {
                self.pp_time = 2;
                self.pb_time = 1;
            }
        }
        if !skip_1stop_8data_bits(gb) {
            return header(BAD_PEI);
        }
        if self.h263_slice_structured {
            if !gb.get_flag() {
                return header(BAD_SLICE_MARKER);
            }
            // The first slice's MBA, which the macroblock loop does not read: it starts at the picture's first macroblock
            h263_decode_mba(gb, mb_width * mb_height, mb_width);
            if !gb.get_flag() {
                return header(BAD_SLICE_MARKER);
            }
        }
        if self.pict_type == PictType::B {
            self.low_delay = false;
        }
        if self.pict_type == PictType::I && codec_tag == fourcc(b"ZYGO") && gb.bits_left() >= i64::from(ZYGO_EXTRA_BITS) {
            gb.skip_bits(ZYGO_EXTRA_BITS);
        }
        self.header_bits = gb.bits_count();
        Ok(())
    }
}

/// The stream's coordinator state: the persistent header, the coded size FFmpeg's context was initialized for, and the reference
/// pictures since the last size change, of which FFmpeg's last_pic and next_pic are the last two.
pub struct H263Stream {
    codec_tag: u32,
    header: PictureHeader,
    coded_width: i32,
    coded_height: i32,
    maximum_size: (u32, u32),
    references: u32,
    /// The picture type of the latest reference picture, FFmpeg's next_pic
    next_type: PictType,
}

impl H263Stream {
    pub fn new(configuration: &Configuration) -> DecodeResult<Self> {
        Ok(Self {
            codec_tag: configuration.codec_tag,
            header: PictureHeader::new(configuration.width, configuration.height),
            coded_width: configuration.width,
            coded_height: configuration.height,
            maximum_size: (configuration.width as u32, configuration.height as u32),
            references: 0,
            next_type: PictType::I,
        })
    }
}

impl CodecStream for H263Stream {
    /// ff_h263_decode_frame up to the macroblock loop: the header, the size change, and the B picture it skips.
    fn plan(&mut self, packet: &[u8], start: usize, anchors: &AnchorState) -> DecodeResult<PlanStep> {
        let Some(bytes) = packet.get(start..).filter(|bytes: &&[u8]| !bytes.is_empty()) else {
            return Ok(PlanStep::NoPicture);
        };
        let mut header: PictureHeader = self.header.clone();
        let mut gb: BitReader = BitReader::new(bytes);
        if let Err(failure) = header.decode(&mut gb, self.codec_tag) {
            // FFmpeg keeps what the header read, but reverts its size
            header.width = self.header.width;
            header.height = self.header.height;
            self.header = header;
            return Err(failure);
        }
        let is_b: bool = header.pict_type == PictType::B;
        // H.263 may change its size at any picture, which reinitializes FFmpeg's context and drops its references
        let reset_anchors: bool = header.width != self.coded_width || header.height != self.coded_height;
        let references: u32 = if reset_anchors { 0 } else { self.references };
        if is_b && references < 2 {
            // FFmpeg skips a B picture without its last_pic
            self.commit(header, reset_anchors, references);
            return Ok(PlanStep::NoPicture);
        }
        let mut anchor: Option<AnchorMotion> = None;
        if is_b {
            if !anchors.finished {
                return Ok(PlanStep::Blocked);
            }
            let mb_width: i32 = (header.width + 15) / 16;
            let mb_height: i32 = (header.height + 15) / 16;
            // A U263 B picture whose next_pic is intra reads the reference before it, which the coordinator does not keep
            let unavailable: bool = self.codec_tag == fourcc(b"U263") && self.next_type == PictType::I;
            match anchors.motion {
                Some(motion) if !unavailable && motion.mb_width == mb_width && motion.mb_height == mb_height => anchor = Some(motion.clone()),
                _ => {
                    self.commit(header, reset_anchors, references);
                    return error::fail(ERROR_UNSUPPORTED_FEATURE, B_PICTURE_ANCHOR);
                }
            }
        }
        let width: u32 = header.width as u32;
        let height: u32 = header.height as u32;
        self.maximum_size = (self.maximum_size.0.max(width), self.maximum_size.1.max(height));
        let info: PictureInfo = PictureInfo {
            width,
            height,
            maximum_width: self.maximum_size.0,
            maximum_height: self.maximum_size.1,
            fields: fields_word(false, false),
            reference: !is_b,
            output_now: is_b || header.low_delay,
            reset_anchors,
        };
        let plan: H263Plan = H263Plan {
            packet: bytes.to_vec(),
            header_bits: header.header_bits as u32,
            width: header.width,
            height: header.height,
            pict_type: header.pict_type.number(),
            qscale: header.qscale,
            no_rounding: header.no_rounding,
            h263_long_vectors: header.h263_long_vectors,
            obmc: header.obmc,
            pb_frame: header.pb_frame,
            umvplus: header.umvplus,
            h263_aic: header.h263_aic,
            loop_filter: header.loop_filter,
            h263_slice_structured: header.h263_slice_structured,
            alt_inter_vlc: header.alt_inter_vlc,
            modified_quant: header.modified_quant,
            h263_chroma_qscale: header.h263_chroma_qscale,
            pp_time: header.pp_time,
            pb_time: header.pb_time,
            reset_anchors,
            anchor,
        };
        if !is_b {
            self.next_type = header.pict_type;
        }
        self.commit(header, reset_anchors, if is_b { references } else { (references + 1).min(2) });
        Ok(PlanStep::Picture { info, plan: crate::sequencer::PicturePlan::H263(Box::new(plan)), next_start: None })
    }

    fn maximum_picture_size(&self) -> (u32, u32) {
        self.maximum_size
    }
}

impl H263Stream {
    /// Keeps a planned header, and the size FFmpeg's context was reinitialized for.
    fn commit(&mut self, header: PictureHeader, reset_anchors: bool, references: u32) {
        if reset_anchors {
            self.coded_width = header.width;
            self.coded_height = header.height;
        }
        self.header = header;
        self.references = references;
    }
}

/// A planned picture: its packet, the bit its macroblock layer starts at, the header's parameters, and the next reference picture's
/// motion a B picture's direct mode reads.
pub struct H263Plan {
    packet: Vec<u8>,
    header_bits: u32,
    width: i32,
    height: i32,
    /// PictType::number
    pict_type: i32,
    qscale: i32,
    no_rounding: bool,
    h263_long_vectors: bool,
    obmc: bool,
    pb_frame: i32,
    umvplus: bool,
    h263_aic: bool,
    loop_filter: bool,
    h263_slice_structured: bool,
    alt_inter_vlc: bool,
    modified_quant: bool,
    h263_chroma_qscale: bool,
    pp_time: u16,
    pb_time: u16,
    reset_anchors: bool,
    anchor: Option<AnchorMotion>,
}

plan_struct!(H263Plan {
    packet,
    header_bits,
    width,
    height,
    pict_type,
    qscale,
    no_rounding,
    h263_long_vectors,
    obmc,
    pb_frame,
    umvplus,
    h263_aic,
    loop_filter,
    h263_slice_structured,
    alt_inter_vlc,
    modified_quant,
    h263_chroma_qscale,
    pp_time,
    pb_time,
    reset_anchors,
    anchor,
});

impl H263Plan {
    /// The macroblock loop of ff_h263_decode_frame for the planned picture.
    pub fn decode(&self) -> DecodeResult<DecodedPicture> {
        let pict_type: PictType = match self.pict_type {
            1 => PictType::I,
            2 => PictType::P,
            3 => PictType::B,
            _ => return error::fail(ERROR_RECORD_INVALID, INVALID_PICTURE_TYPE),
        };
        let mut c: Mpv = Mpv::new(Codec::H263, self.width, self.height);
        c.pict_type = pict_type;
        c.qscale = self.qscale;
        c.chroma_qscale = self.qscale;
        c.no_rounding = self.no_rounding;
        c.obmc = self.obmc;
        c.h263_aic = self.h263_aic;
        c.low_delay = pict_type != PictType::B;
        let dc_scale_table: &'static [u8; 32] = if self.h263_aic { &AIC_DC_SCALE_TABLE } else { &MPEG12_DC_SCALE_TABLE[0] };
        c.y_dc_scale_table = dc_scale_table;
        c.c_dc_scale_table = dc_scale_table;
        if self.h263_chroma_qscale {
            c.chroma_qscale_table = &H263_CHROMA_QSCALE_TABLE;
        }
        let mut h: H263Context = H263Context::new(c, &self.packet);
        h.gb.seek(self.header_bits as usize);
        h.h263_long_vectors = self.h263_long_vectors;
        h.gob_index = h263_gob_height(self.height);
        h.umvplus = self.umvplus;
        h.h263_slice_structured = self.h263_slice_structured;
        h.alt_inter_vlc = self.alt_inter_vlc;
        h.loop_filter = self.loop_filter;
        h.modified_quant = self.modified_quant;
        h.reference = pict_type != PictType::B;
        let mut direct_scale_mv: [[i16; DIRECT_TAB_SIZE as usize]; 2] = [[0; DIRECT_TAB_SIZE as usize]; 2];
        if pict_type == PictType::B {
            // ff_mpeg4_init_direct_mv
            let pp_time: i32 = i32::from(self.pp_time);
            let pb_time: i32 = i32::from(self.pb_time);
            for i in 0..DIRECT_TAB_SIZE {
                direct_scale_mv[0][i as usize] = ((i - DIRECT_TAB_BIAS) * pb_time / pp_time) as i16;
                direct_scale_mv[1][i as usize] = ((i - DIRECT_TAB_BIAS) * (pb_time - pp_time) / pp_time) as i16;
            }
        }
        let mut decoder: H263Decoder = H263Decoder {
            h,
            pb_frame: self.pb_frame,
            h263_aic_dir: false,
            anchor: self.anchor.as_ref(),
            direct_scale_mv,
            pp_time: self.pp_time,
            pb_time: self.pb_time,
        };
        decode_frame_macroblocks(&mut decoder)?;
        let mpv: Mpv = decoder.h.c;
        let motion: MotionContext = MotionContext {
            pict_type,
            width: self.width,
            height: self.height,
            no_rounding: self.no_rounding,
            quarter_sample: false,
            obmc: self.obmc,
            workaround_bugs: mpv.workaround_bugs,
            sprite: Default::default(),
        };
        let header: RecordHeader =
            RecordHeader { xvid_idct: false, loop_filter: self.loop_filter, reset_anchors: self.reset_anchors, missing_reference_luma: MISSING_REFERENCE_LUMA };
        Ok(DecodedPicture { mpv, motion, header })
    }
}

/// The H.263 macroblock layer of one picture.
struct H263Decoder<'a> {
    h: H263Context<'a>,
    pb_frame: i32,
    h263_aic_dir: bool,
    anchor: Option<&'a AnchorMotion>,
    direct_scale_mv: [[i16; DIRECT_TAB_SIZE as usize]; 2],
    pp_time: u16,
    pb_time: u16,
}

/// h263p_decode_umotion: a vector component of the UMV mode's reversible code, from its prediction; 0xffff for a huge one.
fn h263p_decode_umotion(gb: &mut BitReader, pred: i32) -> i32 {
    if gb.get_flag() {
        // A difference of 0
        return pred;
    }
    let mut code: i32 = 2 + gb.get_bits1() as i32;
    while gb.get_flag() {
        code <<= 1;
        code += gb.get_bits1() as i32;
        if code >= HUGE_UMOTION {
            return INVALID_VECTOR;
        }
    }
    let sign: bool = code & 1 != 0;
    code >>= 1;
    if sign { pred - code } else { pred + code }
}

/// h263_get_modb: whether a PB frame's macroblock codes a B-part vector, and its CBPB when it codes one.
fn h263_get_modb(gb: &mut BitReader, pb_frame: i32, cbpb: &mut u32) -> i32 {
    let (coded, mv): (bool, bool) = if pb_frame < 3 {
        // Annex G's (and the Intel H.263's) PB frames
        let coded: bool = gb.get_flag();
        let mv: bool = if pb_frame == 2 && coded { !gb.get_flag() } else { true };
        (coded, mv)
    } else {
        // Annex M's improved PB frames: get_unary(gb, 0, 4) + 1
        let mut ones: i32 = 0;
        while ones < 4 && gb.get_flag() {
            ones += 1;
        }
        let modb: i32 = ones + 1;
        (modb & 1 != 0, modb & 2 != 0)
    };
    if coded {
        *cbpb = gb.get_bits(6);
    }
    i32::from(mv)
}

/// h263_pred_acdc: AIC's DC and AC prediction of an intra block from its left or top neighbor, which then stores the block's own
/// predictors.
fn h263_pred_acdc(c: &mut Mpv, block: &mut [i16; 64], n: usize, h263_aic_dir: bool) {
    let xy: i32 = c.block_index[n];
    let (wrap, scale): (i32, i32) = if n < 4 { (c.b8_stride, c.y_dc_scale) } else { (c.mb_stride, c.c_dc_scale) };
    // B C
    // A X
    let mut a: i32 = i32::from(c.get_dc_val(xy - 1));
    let mut cc: i32 = i32::from(c.get_dc_val(xy - wrap));
    // No prediction outside the GOB
    if c.first_slice_line && n != 3 {
        if n != 2 {
            cc = 1024;
        }
        if n != 1 && c.mb_x == c.resync_mb_x {
            a = 1024;
        }
    }
    let pred_dc: i32 = if c.ac_pred {
        if h263_aic_dir {
            // Left prediction
            if a != 1024 {
                let left: [i16; 16] = c.get_ac_val(xy - 1);
                for i in 1..8 {
                    block[i << 3] = block[i << 3].wrapping_add(left[i]);
                }
                a
            } else {
                1024
            }
        } else if cc != 1024 {
            // Top prediction
            let top: [i16; 16] = c.get_ac_val(xy - wrap);
            for i in 1..8 {
                block[i] = block[i].wrapping_add(top[i + 8]);
            }
            cc
        } else {
            1024
        }
    } else if a != 1024 && cc != 1024 {
        (a + cc) >> 1
    } else if a != 1024 {
        a
    } else {
        cc
    };
    block[0] = (i32::from(block[0]) * scale + pred_dc) as i16;
    if block[0] < 0 {
        block[0] = 0;
    } else {
        block[0] |= 1;
    }
    *c.dc_val(xy) = block[0];
    let ac_val: &mut [i16; 16] = c.ac_val(xy);
    for i in 1..8 {
        // The left column, then the top row
        ac_val[i] = block[i << 3];
        ac_val[8 + i] = block[i];
    }
}

impl<'a> H263Decoder<'a> {
    /// A vector component: h263p_decode_umotion in UMV mode, ff_h263_decode_motion otherwise; a code that reads none fails.
    fn decode_vector(&mut self, pred: i32) -> DecodeResult<i32> {
        let value: i32 = if self.h.umvplus { h263p_decode_umotion(&mut self.h.gb, pred) } else { self.h.decode_motion(pred, 1) };
        if value >= INVALID_VECTOR {
            return macroblock_failure(&self.h.c, INVALID_MOTION);
        }
        Ok(value)
    }

    /// A vector component as preview_obmc reads it, unchecked.
    fn preview_vector(&mut self, pred: i32) -> i32 {
        if self.h.umvplus { h263p_decode_umotion(&mut self.h.gb, pred) } else { self.h.decode_motion(pred, 1) }
    }

    /// Sets the four motion_val entries of the macroblock whose first block is at index.
    fn set_macroblock_motion(&mut self, dir: usize, index: i32, value: [i16; 2]) {
        let stride: i32 = self.h.c.b8_stride;
        for entry in [index, index + 1, index + stride, index + 1 + stride] {
            *self.h.c.motion_val(dir, entry) = value;
        }
    }

    /// h263_decode_dquant: DQUANT, or Annex T's modified quantizer.
    fn h263_decode_dquant(&mut self) {
        const QUANT_TAB: [i32; 4] = [-1, -2, 1, 2];
        let qscale: i32 = if self.h.modified_quant {
            if self.h.gb.get_flag() {
                let table: usize = self.h.gb.get_bits1() as usize;
                i32::from(MODIFIED_QUANT_TAB[table][self.h.c.qscale as usize])
            } else {
                self.h.gb.get_bits(5) as i32
            }
        } else {
            self.h.c.qscale + QUANT_TAB[self.h.gb.get_bits(2) as usize]
        };
        self.h.c.set_qscale(qscale);
    }

    /// h263_decode_block into block: an intra block's DC, then run-level codes with H.263's escape (and Annex T's long level), retried
    /// with the intra table when an Annex S inter block overruns; AIC predicts an intra block after it.
    fn h263_decode_block(&mut self, block: &mut [i16; 64], n: usize, coded: bool) -> DecodeResult<()> {
        let tables: &H263Tables = &TABLES;
        let start: BitReader<'a> = self.h.gb.clone();
        let mut rl: &RLTable = &tables.rl_inter;
        let mut scan_table: &[u8; 64] = &self.h.c.intra_scantable.permutated;
        let mb_intra: bool = self.h.c.mb_intra;
        let aic_intra: bool = self.h.c.h263_aic && mb_intra;
        let mut i: i32;
        if aic_intra {
            i = 0;
            if !coded {
                h263_pred_acdc(&mut self.h.c, block, n, self.h263_aic_dir);
                self.h.c.block_last_index[n] = 0;
                return Ok(());
            }
            rl = &tables.rl_intra_aic;
            if self.h.c.ac_pred {
                scan_table = if self.h263_aic_dir { &tables.intra_v_scantable.permutated } else { &tables.intra_h_scantable.permutated };
            }
        } else if mb_intra {
            // The DC coefficient; an illegal one, which FFmpeg only logs, decodes as it reads
            let mut level: i32 = self.h.gb.get_bits(8) as i32;
            if level == 255 {
                level = 128;
            }
            block[0] = level as i16;
            i = 1;
        } else {
            i = 0;
        }
        if !coded {
            self.h.c.block_last_index[n] = i - 1;
            return Ok(());
        }
        let scan_table: [u8; 64] = *scan_table;
        let mut scan: [u8; 64] = scan_table;
        'retry: loop {
            // Offset by -1 so the run indexes the scan directly
            i -= 1;
            loop {
                let Some((code, length)) = rl.decode(self.h.gb.peek_window()) else {
                    return macroblock_failure(&self.h.c, INVALID_CODE);
                };
                self.h.gb.skip_bits(length);
                // GET_RL_VLC's run: the table's run + 1, + 192 for a last code; an escape's 7 bits hold LAST and RUN
                let (run, level): (i32, i32) = match code {
                    RunLevel::Escape => {
                        let run: i32 = self.h.gb.get_bits(7) as i32 + 1;
                        let mut level: i32 = i32::from(self.h.gb.get_bits(8) as u8 as i8);
                        if level == -128 {
                            // Annex T's extended level: 5 low bits, then 6 signed high bits
                            level = self.h.gb.get_bits(5) as i32;
                            level |= self.h.gb.get_sbits(6) * (1 << 5);
                        }
                        (run, level)
                    }
                    RunLevel::Code { run, level, last, .. } => {
                        let run: i32 = run + 1 + if last { 192 } else { 0 };
                        let level: i32 = if self.h.gb.get_flag() { -level } else { level };
                        (run, level)
                    }
                };
                i += run;
                if i >= 64 {
                    // The last code: redo the step without its flag
                    i = i - run + ((run - 1) & 63) + 1;
                    if i < 64 {
                        block[usize::from(scan[i as usize])] = level as i16;
                        break 'retry;
                    }
                    if self.h.alt_inter_vlc && std::ptr::eq(rl, &tables.rl_inter) && !mb_intra {
                        // Annex S: an inter block may take the intra table, which an overrun tells
                        rl = &tables.rl_intra_aic;
                        i = 0;
                        self.h.gb = start.clone();
                        *block = [0; 64];
                        scan = scan_table;
                        continue 'retry;
                    }
                    return macroblock_failure(&self.h.c, INVALID_LEVEL);
                }
                block[usize::from(scan[i as usize])] = level as i16;
            }
        }
        if aic_intra {
            h263_pred_acdc(&mut self.h.c, block, n, self.h263_aic_dir);
        }
        self.h.c.block_last_index[n] = i;
        Ok(())
    }

    /// h263_decode_block of macroblock block n, in place.
    fn decode_macroblock_block(&mut self, n: usize, coded: bool) -> DecodeResult<()> {
        let mut block: [i16; 64] = std::mem::replace(&mut self.h.c.block[n], [0; 64]);
        let result: DecodeResult<()> = self.h263_decode_block(&mut block, n, coded);
        self.h.c.block[n] = block;
        result
    }

    /// h263_skip_b_part: reads past a PB frame's B-part blocks, which FFmpeg does not reconstruct.
    fn h263_skip_b_part(&mut self, mut cbp: u32) -> DecodeResult<()> {
        let mb_intra: bool = self.h.c.mb_intra;
        let block_last_index: [i32; 6] = self.h.c.block_last_index;
        self.h.c.mb_intra = false;
        let mut block: [i16; 64] = [0; 64];
        for i in 0..6 {
            self.h263_decode_block(&mut block, i, cbp & 32 != 0)?;
            cbp += cbp;
        }
        self.h.c.mb_intra = mb_intra;
        self.h.c.block_last_index = block_last_index;
        Ok(())
    }

    /// set_one_direct_mv: block i's forward and backward vectors, scaled from the next reference picture's.
    fn set_one_direct_mv(&mut self, anchor: &AnchorMotion, i: usize) {
        let xy: usize = self.h.c.block_index[i] as usize;
        let time_pp: i32 = i32::from(self.pp_time);
        let time_pb: i32 = i32::from(self.pb_time);
        for component in 0..2 {
            let p: i32 = anchor.motion_val.get(2 * xy + component).copied().map_or(0, i32::from);
            if ((p + DIRECT_TAB_BIAS) as u32) < DIRECT_TAB_SIZE as u32 {
                self.h.c.mv[0][i][component] = i32::from(self.direct_scale_mv[0][(p + DIRECT_TAB_BIAS) as usize]);
                self.h.c.mv[1][i][component] = i32::from(self.direct_scale_mv[1][(p + DIRECT_TAB_BIAS) as usize]);
            } else {
                self.h.c.mv[0][i][component] = p * time_pb / time_pp;
                self.h.c.mv[1][i][component] = p * (time_pb - time_pp) / time_pp;
            }
        }
    }

    /// set_direct_mv: the direct macroblock's vectors from the co-located macroblock of the next reference picture; its mb_type.
    fn set_direct_mv(&mut self) -> DecodeResult<u32> {
        let Some(anchor) = self.anchor else {
            return error::fail(ERROR_UNSUPPORTED_FEATURE, B_PICTURE_ANCHOR);
        };
        let mb_index: usize = self.h.c.mb_xy() as usize;
        let colocated_mb_type: u32 = anchor.mb_type.get(mb_index).copied().unwrap_or(0);
        self.h.c.mv_type = MV_TYPE_8X8;
        if is_8x8(colocated_mb_type) {
            for i in 0..4 {
                self.set_one_direct_mv(anchor, i);
            }
            Ok(MB_TYPE_DIRECT2 | MB_TYPE_8X8 | MB_TYPE_BIDIR_MV)
        } else {
            self.set_one_direct_mv(anchor, 0);
            for dir in 0..2 {
                let vector: [i32; 2] = self.h.c.mv[dir][0];
                self.h.c.mv[dir][1] = vector;
                self.h.c.mv[dir][2] = vector;
                self.h.c.mv[dir][3] = vector;
            }
            Ok(MB_TYPE_DIRECT2 | MB_TYPE_16X16 | MB_TYPE_BIDIR_MV)
        }
    }

    /// The forward or backward vector of a B macroblock, which its four motion_val entries keep.
    fn decode_b_vector(&mut self, dir: usize) -> DecodeResult<()> {
        let (pred_x, pred_y, mot): (i32, i32, i32) = self.h.c.h263_pred_motion(0, dir);
        let mx: i32 = self.decode_vector(pred_x)?;
        let my: i32 = self.decode_vector(pred_y)?;
        if self.h.umvplus && mx - pred_x == 1 && my - pred_y == 1 {
            // Bit stuffing to prevent a start code
            self.h.gb.skip_bits(1);
        }
        self.h.c.mv[dir][0] = [mx, my];
        self.set_macroblock_motion(dir, mot, [mx as i16, my as i16]);
        Ok(())
    }

    /// The intra macroblock header after MCBPC: AIC's prediction mode, a PB frame's MODB, CBPY, and DQUANT; the coded block pattern.
    fn decode_intra_header(&mut self, cbpc: u32, dquant: bool, pb_mv_count: &mut i32, cbpb: &mut u32) -> DecodeResult<u32> {
        let xy: usize = self.h.c.mb_xy() as usize;
        self.h.c.mb_type[xy] = MB_TYPE_INTRA;
        if self.h.c.h263_aic {
            self.h.c.ac_pred = self.h.gb.get_flag();
            if self.h.c.ac_pred {
                self.h.c.mb_type[xy] = MB_TYPE_INTRA | MB_TYPE_ACPRED;
                self.h263_aic_dir = self.h.gb.get_flag();
            }
        } else {
            self.h.c.ac_pred = false;
        }
        if self.pb_frame != 0 && self.h.gb.get_flag() {
            *pb_mv_count = h263_get_modb(&mut self.h.gb, self.pb_frame, cbpb);
        }
        let cbpy: u32 = self.h.get_vlc(&h263_lookups().cbpy)?;
        let cbp: u32 = (cbpc & 3) | (cbpy << 2);
        if dquant {
            self.h263_decode_dquant();
        }
        *pb_mv_count += i32::from(self.pb_frame != 0);
        Ok(cbp)
    }

    /// preview_obmc: reads the next macroblock's vectors into the tables ahead of its decode, as OBMC of this macroblock reads them
    /// when it reconstructs; the reader returns to this macroblock's end.
    fn preview_obmc(&mut self) {
        let saved: BitReader<'a> = self.h.gb.clone();
        let xy: usize = (self.h.c.mb_x + 1 + self.h.c.mb_y * self.h.c.mb_stride) as usize;
        for index in &mut self.h.c.block_index[..4] {
            *index += 2;
        }
        for index in &mut self.h.c.block_index[4..] {
            *index += 1;
        }
        self.h.c.mb_x += 1;
        'end: {
            let cbpc: i32 = loop {
                if self.h.gb.get_flag() {
                    // A skipped macroblock
                    let index: i32 = self.h.c.block_index[0];
                    self.set_macroblock_motion(0, index, [0; 2]);
                    self.h.c.mb_type[xy] = MB_TYPE_SKIP | MB_TYPE_16X16 | MB_TYPE_FORWARD_MV;
                    break 'end;
                }
                let cbpc: i32 = self.h.gb.get_vlc(&h263_lookups().inter_mcbpc).map_or(-1, |code: u32| code as i32);
                if cbpc != INTER_STUFFING as i32 {
                    break cbpc;
                }
            };
            if cbpc & 4 != 0 {
                self.h.c.mb_type[xy] = MB_TYPE_INTRA;
                break 'end;
            }
            let _cbpy: Option<u32> = self.h.gb.get_vlc(&h263_lookups().cbpy);
            if cbpc & 8 != 0 {
                let dquant_bits: u32 = if self.h.modified_quant { if self.h.gb.get_flag() { 1 } else { 5 } } else { 2 };
                self.h.gb.skip_bits(dquant_bits);
            }
            if cbpc & 16 == 0 {
                self.h.c.mb_type[xy] = MB_TYPE_16X16 | MB_TYPE_FORWARD_MV;
                let (pred_x, pred_y, mot): (i32, i32, i32) = self.h.c.h263_pred_motion(0, 0);
                let mx: i32 = self.preview_vector(pred_x);
                let my: i32 = self.preview_vector(pred_y);
                self.set_macroblock_motion(0, mot, [mx as i16, my as i16]);
            } else {
                self.h.c.mb_type[xy] = MB_TYPE_8X8 | MB_TYPE_FORWARD_MV;
                for i in 0..4 {
                    let (pred_x, pred_y, mot): (i32, i32, i32) = self.h.c.h263_pred_motion(i, 0);
                    let mx: i32 = self.preview_vector(pred_x);
                    let my: i32 = self.preview_vector(pred_y);
                    if self.h.umvplus && mx - pred_x == 1 && my - pred_y == 1 {
                        self.h.gb.skip_bits(1);
                    }
                    *self.h.c.motion_val(0, mot) = [mx as i16, my as i16];
                }
            }
        }
        for index in &mut self.h.c.block_index[..4] {
            *index -= 2;
        }
        for index in &mut self.h.c.block_index[4..] {
            *index -= 1;
        }
        self.h.c.mb_x -= 1;
        self.h.gb = saved;
    }

    /// The end of ff_h263_decode_mb: a reader past the packet fails, and 16 zero bits (or the packet's end) end the slice.
    fn end_of_macroblock(&self) -> DecodeResult<SliceStatus> {
        check_bits(&self.h)?;
        let left: i64 = self.h.gb.bits_left();
        let mut v: u32 = self.h.gb.show_bits(16);
        if left < 16 {
            v >>= 16 - left;
        }
        Ok(if v == 0 { SliceStatus::End } else { SliceStatus::Ok })
    }

    /// The P macroblock header of ff_h263_decode_mb; None for a skipped macroblock.
    fn decode_p_header(&mut self, pb_mv_count: &mut i32, cbpb: &mut u32) -> DecodeResult<Option<u32>> {
        let xy: usize = self.h.c.mb_xy() as usize;
        let cbpc: u32 = loop {
            if self.h.gb.get_flag() {
                // A skipped macroblock
                let c: &mut Mpv = &mut self.h.c;
                c.mb_intra = false;
                c.block_last_index = [-1; 6];
                c.mv_dir = MV_DIR_FORWARD;
                c.mv_type = MV_TYPE_16X16;
                c.mb_type[xy] = MB_TYPE_SKIP | MB_TYPE_16X16 | MB_TYPE_FORWARD_MV;
                c.mv[0][0] = [0; 2];
                c.mb_skipped = !(c.obmc || self.h.loop_filter);
                return Ok(None);
            }
            let cbpc: u32 = self.h.get_vlc(&h263_lookups().inter_mcbpc)?;
            if cbpc != INTER_STUFFING {
                break cbpc;
            }
        };
        self.h.c.clear_blocks();
        let dquant: bool = cbpc & 8 != 0;
        self.h.c.mb_intra = cbpc & 4 != 0;
        if self.h.c.mb_intra {
            return self.decode_intra_header(cbpc, dquant, pb_mv_count, cbpb).map(Some);
        }
        if self.pb_frame != 0 && self.h.gb.get_flag() {
            *pb_mv_count = h263_get_modb(&mut self.h.gb, self.pb_frame, cbpb);
        }
        let mut cbpy: u32 = self.h.get_vlc(&h263_lookups().cbpy)?;
        if !self.h.alt_inter_vlc || cbpc & 3 != 3 {
            cbpy ^= 0xF;
        }
        let cbp: u32 = (cbpc & 3) | (cbpy << 2);
        if dquant {
            self.h263_decode_dquant();
        }
        self.h.c.mv_dir = MV_DIR_FORWARD;
        if cbpc & 16 == 0 {
            self.h.c.mb_type[xy] = MB_TYPE_16X16 | MB_TYPE_FORWARD_MV;
            self.h.c.mv_type = MV_TYPE_16X16;
            let (pred_x, pred_y, _): (i32, i32, i32) = self.h.c.h263_pred_motion(0, 0);
            let mx: i32 = self.decode_vector(pred_x)?;
            let my: i32 = self.decode_vector(pred_y)?;
            self.h.c.mv[0][0] = [mx, my];
            if self.h.umvplus && mx - pred_x == 1 && my - pred_y == 1 {
                self.h.gb.skip_bits(1);
            }
        } else {
            self.h.c.mb_type[xy] = MB_TYPE_8X8 | MB_TYPE_FORWARD_MV;
            self.h.c.mv_type = MV_TYPE_8X8;
            for i in 0..4 {
                let (pred_x, pred_y, mot): (i32, i32, i32) = self.h.c.h263_pred_motion(i, 0);
                let mx: i32 = self.decode_vector(pred_x)?;
                let my: i32 = self.decode_vector(pred_y)?;
                self.h.c.mv[0][i] = [mx, my];
                if self.h.umvplus && mx - pred_x == 1 && my - pred_y == 1 {
                    self.h.gb.skip_bits(1);
                }
                *self.h.c.motion_val(0, mot) = [mx as i16, my as i16];
            }
        }
        Ok(Some(cbp))
    }

    /// The B macroblock header of ff_h263_decode_mb.
    fn decode_b_header(&mut self, pb_mv_count: &mut i32, cbpb: &mut u32) -> DecodeResult<u32> {
        let xy: usize = self.h.c.mb_xy() as usize;
        let first: i32 = self.h.c.block_index[0];
        self.set_macroblock_motion(0, first, [0; 2]);
        self.set_macroblock_motion(1, first, [0; 2]);
        let mut mb_type: u32 = loop {
            let code: u32 = self.h.get_vlc(&TABLES.mb_type_b)?;
            let mb_type: u32 = H263_MB_TYPE_B_MAP[code as usize];
            if mb_type != 0 {
                break mb_type;
            }
        };
        self.h.c.mb_intra = is_intra(mb_type);
        let cbp: u32 = if mb_type & MB_TYPE_CBP != 0 {
            self.h.c.clear_blocks();
            let cbpc: u32 = self.h.get_vlc(&TABLES.cbpc_b)?;
            if self.h.c.mb_intra {
                return self.decode_intra_header(cbpc, mb_type & MB_TYPE_QUANT != 0, pb_mv_count, cbpb);
            }
            let mut cbpy: u32 = self.h.get_vlc(&h263_lookups().cbpy)?;
            if !self.h.alt_inter_vlc || cbpc & 3 != 3 {
                cbpy ^= 0xF;
            }
            (cbpc & 3) | (cbpy << 2)
        } else {
            0
        };
        if mb_type & MB_TYPE_QUANT != 0 {
            self.h263_decode_dquant();
        }
        if is_direct(mb_type) {
            self.h.c.mv_dir = MV_DIR_FORWARD | MV_DIR_BACKWARD | MV_DIRECT;
            mb_type |= self.set_direct_mv()?;
        } else {
            self.h.c.mv_dir = 0;
            self.h.c.mv_type = MV_TYPE_16X16;
            if has_forward_mv(mb_type) {
                self.h.c.mv_dir = MV_DIR_FORWARD;
                self.decode_b_vector(0)?;
            }
            if has_backward_mv(mb_type) {
                self.h.c.mv_dir |= MV_DIR_BACKWARD;
                self.decode_b_vector(1)?;
            }
        }
        self.h.c.mb_type[xy] = mb_type;
        Ok(cbp)
    }

    /// The I macroblock header of ff_h263_decode_mb.
    fn decode_i_header(&mut self, pb_mv_count: &mut i32, cbpb: &mut u32) -> DecodeResult<u32> {
        let cbpc: u32 = loop {
            let cbpc: u32 = self.h.get_vlc(&h263_lookups().intra_mcbpc)?;
            if cbpc != INTRA_STUFFING {
                break cbpc;
            }
        };
        self.h.c.clear_blocks();
        self.h.c.mb_intra = true;
        self.decode_intra_header(cbpc, cbpc & 4 != 0, pb_mv_count, cbpb)
    }
}

impl<'a> MacroblockLayer<'a> for H263Decoder<'a> {
    fn h(&mut self) -> &mut H263Context<'a> {
        &mut self.h
    }

    /// ff_h263_decode_mb.
    fn decode_mb(&mut self) -> DecodeResult<SliceStatus> {
        let mut cbpb: u32 = 0;
        let mut pb_mv_count: i32 = 0;
        let cbp: u32 = match self.h.c.pict_type {
            PictType::P | PictType::S => match self.decode_p_header(&mut pb_mv_count, &mut cbpb)? {
                Some(cbp) => cbp,
                None => return self.end_of_macroblock(),
            },
            PictType::B => self.decode_b_header(&mut pb_mv_count, &mut cbpb)?,
            PictType::I => self.decode_i_header(&mut pb_mv_count, &mut cbpb)?,
        };
        while pb_mv_count > 0 {
            // The B part's vector, which FFmpeg reads past
            self.h.decode_motion(0, 1);
            self.h.decode_motion(0, 1);
            pb_mv_count -= 1;
        }
        let mut cbp: u32 = cbp;
        for i in 0..6 {
            self.decode_macroblock_block(i, cbp & 32 != 0)?;
            cbp += cbp;
        }
        if self.pb_frame != 0 {
            self.h263_skip_b_part(cbpb)?;
        }
        let c: &Mpv = &self.h.c;
        if c.obmc && !c.mb_intra && c.pict_type == PictType::P && c.mb_x + 1 < c.mb_width && self.h.mb_num_left != 1 {
            self.preview_obmc();
        }
        self.end_of_macroblock()
    }

    /// h263_decode_gob_header: a GOB header, or a slice header in slice-structured mode; false where FFmpeg returns -1.
    fn decode_resync_header(&mut self) -> DecodeResult<bool> {
        let h: &mut H263Context<'a> = &mut self.h;
        if h.gb.show_bits(16) != 0 {
            return Ok(false);
        }
        // A GBSC, probably with GSTUFF
        h.gb.skip_bits(16);
        let mut left: i64 = h.gb.bits_left().min(32);
        while left > 13 {
            if h.gb.get_flag() {
                break;
            }
            left -= 1;
        }
        if left <= 13 {
            return Ok(false);
        }
        let (mb_x, mb_y, qscale): (i32, i32, i32) = if h.h263_slice_structured {
            if !h.gb.get_flag() {
                return Ok(false);
            }
            let (mb_x, mb_y): (i32, i32) = h263_decode_mba(&mut h.gb, h.c.mb_num, h.c.mb_width);
            if h.c.mb_num > MBA_MARKER_MB_NUM && !h.gb.get_flag() {
                return Ok(false);
            }
            // SQUANT
            let qscale: i32 = h.gb.get_bits(5) as i32;
            if !h.gb.get_flag() {
                return Ok(false);
            }
            // GFID
            h.gb.skip_bits(2);
            (mb_x, mb_y, qscale)
        } else {
            let gob_number: i32 = h.gb.get_bits(5) as i32;
            // GFID, then GQUANT
            h.gb.skip_bits(2);
            let qscale: i32 = h.gb.get_bits(5) as i32;
            (0, h.gob_index * gob_number, qscale)
        };
        if mb_y >= h.c.mb_height || qscale == 0 {
            return Ok(false);
        }
        h.c.mb_x = mb_x;
        h.c.mb_y = mb_y;
        h.c.qscale = qscale;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::ERROR_MACROBLOCK_LAYER;

    /// Writes bits most significant first.
    #[derive(Default)]
    struct BitWriter {
        bytes: Vec<u8>,
        bits: usize,
    }

    impl BitWriter {
        fn put(&mut self, count: u32, value: u32) -> &mut Self {
            for bit in (0..count).rev() {
                if self.bits.is_multiple_of(8) {
                    self.bytes.push(0);
                }
                if (value >> bit) & 1 != 0 {
                    let last: usize = self.bytes.len() - 1;
                    self.bytes[last] |= 0x80 >> (self.bits % 8);
                }
                self.bits += 1;
            }
            self
        }

        /// Pads with zero bytes, as a stream's stuffing and the next start code would follow.
        fn finish(&mut self, padding: usize) -> Vec<u8> {
            let mut bytes: Vec<u8> = self.bytes.clone();
            bytes.extend(std::iter::repeat_n(0, padding));
            bytes
        }
    }

    fn configuration(width: i32, height: i32) -> Configuration {
        Configuration { codec: Codec::H263, codec_tag: fourcc(b"H263"), width, height, extradata: Vec::new() }
    }

    /// A version 1 header: PSC, TR, PTYPE of a source format and type, PQUANT, CPM, and PEI.
    fn version1_header(writer: &mut BitWriter, temporal_reference: u32, format: u32, inter: bool, qscale: u32) {
        writer.put(22, PICTURE_START_CODE).put(8, temporal_reference);
        // Marker, H.263 id, split screen, document camera, freeze release
        writer.put(1, 1).put(1, 0).put(3, 0).put(3, format);
        // Coding type, UMV, SAC, AP, PB
        writer.put(1, u32::from(inter)).put(4, 0);
        writer.put(5, qscale).put(1, 0).put(1, 0);
    }

    /// An H.263+ header with UFEP 1 and a custom size, or UFEP 0; options are OPPTYPE's bits 4 to 11 after the custom clock flag
    /// (UMV, SAC, AP, AIC, DF, SS, RPS, ISD, AIV, MQ) as one 10-bit value.
    fn plus_header(writer: &mut BitWriter, update: Option<(u32, u32, u32)>, picture_type: u32, no_rounding: bool, qscale: u32) {
        writer.put(22, PICTURE_START_CODE).put(8, 0);
        writer.put(1, 1).put(1, 0).put(3, 0).put(3, EXTENDED_SOURCE_FORMAT);
        match update {
            Some((options, width, height)) => {
                writer.put(3, 1).put(3, CUSTOM_SOURCE_FORMAT).put(1, 0).put(10, options).put(1, 1).put(3, 0);
                writer.put(3, picture_type).put(2, 0).put(1, u32::from(no_rounding)).put(3, 0).put(1, 1);
                // CPFMT: square pixels, width / 4 - 1, a marker, height / 4
                writer.put(4, 1).put(9, width / 4 - 1).put(1, 1).put(9, height / 4);
                if options & (1 << 9) != 0 {
                    // UUI
                    writer.put(1, 1);
                }
                if options & (1 << 4) != 0 {
                    // Rectangular and arbitrary slice order bits
                    writer.put(2, 0);
                }
            }
            None => {
                writer.put(3, 0);
                writer.put(3, picture_type).put(2, 0).put(1, u32::from(no_rounding)).put(3, 0).put(1, 1);
            }
        }
        writer.put(5, qscale).put(1, 0);
    }

    fn plan_packet(stream: &mut H263Stream, packet: &[u8]) -> DecodeResult<PlanStep> {
        stream.plan(packet, 0, &AnchorState { finished: true, motion: None })
    }

    fn planned(step: PlanStep) -> (PictureInfo, Box<H263Plan>) {
        match step {
            PlanStep::Picture { info, plan: crate::sequencer::PicturePlan::H263(plan), next_start: None } => (info, plan),
            _ => panic!("expected an H.263 picture"),
        }
    }

    #[test]
    fn parses_a_version_1_header_and_finds_its_start_code_after_junk() {
        let mut writer: BitWriter = BitWriter::default();
        writer.put(16, 0xABCD);
        version1_header(&mut writer, 7, 2, false, 9);
        let packet: Vec<u8> = writer.finish(64);
        let mut stream: H263Stream = H263Stream::new(&configuration(176, 144)).unwrap();
        let (info, plan) = planned(plan_packet(&mut stream, &packet).unwrap());
        assert_eq!((info.width, info.height, info.reference, info.output_now, info.reset_anchors), (176, 144, true, true, false));
        assert_eq!((plan.width, plan.height, plan.pict_type, plan.qscale), (176, 144, 1, 9));
        assert_eq!(plan.header_bits, 16 + 22 + 8 + 13 + 5 + 2);
        assert_eq!(stream.header.picture_number, 7);
    }

    #[test]
    fn keeps_h263_plus_options_while_ufep_is_zero_and_reports_size_changes() {
        let mut stream: H263Stream = H263Stream::new(&configuration(176, 144)).unwrap();
        let mut writer: BitWriter = BitWriter::default();
        // UMV, AIC, DF, AIV, MQ on a 320x240 intra picture
        plus_header(&mut writer, Some((0b10_0110_0011, 320, 240)), 0, false, 4);
        let (info, plan) = planned(plan_packet(&mut stream, &writer.finish(64)).unwrap());
        assert_eq!((info.width, info.height, info.reset_anchors), (320, 240, true));
        assert!(plan.umvplus && plan.h263_aic && plan.loop_filter && plan.alt_inter_vlc && plan.modified_quant && plan.h263_chroma_qscale);
        assert!(!plan.obmc && !plan.h263_slice_structured);
        let mut writer: BitWriter = BitWriter::default();
        plus_header(&mut writer, None, 1, true, 6);
        let (info, plan) = planned(plan_packet(&mut stream, &writer.finish(64)).unwrap());
        assert_eq!((info.width, info.height, info.reset_anchors), (320, 240, false));
        assert_eq!((plan.pict_type, plan.qscale, plan.no_rounding), (2, 6, true));
        assert!(plan.umvplus && plan.h263_aic && plan.loop_filter && plan.modified_quant);
    }

    #[test]
    fn refuses_damaged_and_unsupported_headers() {
        let mut stream: H263Stream = H263Stream::new(&configuration(176, 144)).unwrap();
        let no_start_code: Vec<u8> = vec![0x55; 64];
        assert_eq!(plan_packet(&mut stream, &no_start_code).err().map(|e| (e.code, e.value)), Some((ERROR_PICTURE_HEADER, BAD_START_CODE)));
        // Source format 0 is forbidden
        let mut writer: BitWriter = BitWriter::default();
        version1_header(&mut writer, 0, 0, false, 9);
        assert_eq!(plan_packet(&mut stream, &writer.finish(64)).err().map(|e| (e.code, e.value)), Some((ERROR_PICTURE_HEADER, BAD_SOURCE_FORMAT)));
        // Syntax-based arithmetic coding
        let mut writer: BitWriter = BitWriter::default();
        writer.put(22, PICTURE_START_CODE).put(8, 0).put(1, 1).put(1, 0).put(3, 0).put(3, 2).put(1, 0).put(1, 0).put(1, 1);
        assert_eq!(
            plan_packet(&mut stream, &writer.finish(64)).err().map(|e| (e.code, e.value)),
            Some((ERROR_UNSUPPORTED_FEATURE, SYNTAX_BASED_ARITHMETIC_CODING))
        );
        // A QCIF picture needs at least 176 * 144 / 256 / 8 bits after its header
        let mut writer: BitWriter = BitWriter::default();
        version1_header(&mut writer, 0, 2, false, 9);
        assert_eq!(plan_packet(&mut stream, &writer.finish(0)).err().map(|e| (e.code, e.value)), Some((ERROR_PICTURE_HEADER, TOO_FEW_BITS)));
    }

    #[test]
    fn skips_a_b_picture_without_two_references() {
        let mut stream: H263Stream = H263Stream::new(&configuration(64, 48)).unwrap();
        let mut writer: BitWriter = BitWriter::default();
        plus_header(&mut writer, Some((0, 64, 48)), 0, false, 4);
        planned(plan_packet(&mut stream, &writer.finish(64)).unwrap());
        let mut writer: BitWriter = BitWriter::default();
        plus_header(&mut writer, None, 3, false, 4);
        assert!(matches!(plan_packet(&mut stream, &writer.finish(64)).unwrap(), PlanStep::NoPicture));
        // FFmpeg's header turned low_delay off, so the next reference picture waits for the one after it
        let mut writer: BitWriter = BitWriter::default();
        plus_header(&mut writer, None, 1, false, 4);
        let (info, _) = planned(plan_packet(&mut stream, &writer.finish(64)).unwrap());
        assert!(info.reference && !info.output_now);
        // With two references a B picture waits for them to finish
        let mut writer: BitWriter = BitWriter::default();
        plus_header(&mut writer, None, 3, false, 4);
        let step: PlanStep = stream.plan(&writer.finish(64), 0, &AnchorState { finished: false, motion: None }).unwrap();
        assert!(matches!(step, PlanStep::Blocked));
    }

    #[test]
    fn decodes_umv_reversible_vector_differences() {
        // "1": no difference; "0 0 0": +1 (code 2 + 0 = 2, sign 0); "0 1 1 0 0": code (3 << 1) | 0 = 6, +3
        let bytes: [u8; 2] = [0b1000_0110, 0b0000_0000];
        let mut gb: BitReader = BitReader::new(&bytes);
        assert_eq!(h263p_decode_umotion(&mut gb, 5), 5);
        assert_eq!(h263p_decode_umotion(&mut gb, 5), 6);
        assert_eq!(h263p_decode_umotion(&mut gb, 5), 8);
        // "0 1 0": code 3, sign 1: -1
        let bytes: [u8; 1] = [0b0100_0000];
        let mut gb: BitReader = BitReader::new(&bytes);
        assert_eq!(h263p_decode_umotion(&mut gb, 0), -1);
    }

    /// An intra macroblock of a version 1 I picture: MCBPC 1 (cbpc 0), CBPY "0011" (only block 0 coded... CBPY 0 codes as 0011),
    /// then six DC bytes, block 0 with one last AC code.
    fn intra_macroblock(writer: &mut BitWriter, dc: u32) {
        // MCBPC for cbpc 0 is "1"; CBPY code of 0 is 0011, which intra reads as is: no luma coded; chroma bits 0
        writer.put(1, 1).put(4, 0b0011);
        for _ in 0..6 {
            writer.put(8, dc);
        }
    }

    #[test]
    fn decodes_an_intra_picture_into_dequantized_dc_records() {
        // A 32x16 picture of two macroblocks, as a custom H.263+ size
        let mut writer: BitWriter = BitWriter::default();
        plus_header(&mut writer, Some((0, 32, 16)), 0, false, 5);
        intra_macroblock(&mut writer, 100);
        intra_macroblock(&mut writer, 255);
        let packet: Vec<u8> = writer.finish(4);
        let mut stream: H263Stream = H263Stream::new(&configuration(32, 16)).unwrap();
        let (_, plan) = planned(plan_packet(&mut stream, &packet).unwrap());
        let decoded: DecodedPicture = plan.decode().unwrap();
        let records = &decoded.mpv.records;
        assert_eq!(records.len(), 2);
        // The DC scale of a non-AIC picture is 8; a DC of 255 codes 128
        assert_eq!(records[0].entries, (0..6).map(|block: u8| (block, 0, 800)).collect::<Vec<(u8, u8, i16)>>());
        assert_eq!(records[1].entries, (0..6).map(|block: u8| (block, 0, 1024)).collect::<Vec<(u8, u8, i16)>>());
        assert!(records.iter().all(|record| record.mb_intra && record.residual_blocks == 63));
        assert_eq!(decoded.header.missing_reference_luma, 16);
    }

    #[test]
    fn fails_a_picture_whose_macroblocks_run_out() {
        let mut writer: BitWriter = BitWriter::default();
        plus_header(&mut writer, Some((0, 32, 16)), 0, false, 5);
        intra_macroblock(&mut writer, 100);
        // The second macroblock's MCBPC reads zeros, which no intra MCBPC code starts with this many of
        let packet: Vec<u8> = writer.finish(8);
        let mut stream: H263Stream = H263Stream::new(&configuration(32, 16)).unwrap();
        let (_, plan) = planned(plan_packet(&mut stream, &packet).unwrap());
        let failure = plan.decode().err().unwrap();
        assert!(failure.code == ERROR_MACROBLOCK_LAYER || failure.code == crate::layout::ERROR_BITS_EXHAUSTED, "{failure:?}");
    }

    #[test]
    fn predicts_aic_dc_from_the_left_block() {
        // AIC: an intra macroblock with no coded blocks predicts every DC; the first takes 1024's prediction of nothing
        let mut writer: BitWriter = BitWriter::default();
        plus_header(&mut writer, Some((0b00_0100_0000, 16, 16)), 0, false, 5);
        // MCBPC "1", ac_pred 0, CBPY 0011 (none coded)
        writer.put(1, 1).put(1, 0).put(4, 0b0011);
        let packet: Vec<u8> = writer.finish(4);
        let mut stream: H263Stream = H263Stream::new(&configuration(16, 16)).unwrap();
        let (_, plan) = planned(plan_packet(&mut stream, &packet).unwrap());
        let decoded: DecodedPicture = plan.decode().unwrap();
        // Block 0 has neither neighbor: 0 * scale + 1024, made odd; blocks 1 to 3 average or copy 1025; chroma have no neighbor
        assert_eq!(decoded.mpv.records[0].entries, (0..6).map(|block: u8| (block, 0, 1025)).collect::<Vec<(u8, u8, i16)>>());
    }
}
