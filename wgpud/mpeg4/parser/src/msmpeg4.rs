// FFmpeg's msmpeg4v1, msmpeg4v2, and msmpeg4 (v3) decoders: msmpeg4dec.c, the parts of msmpeg4.c they read (the DC and coded block
// predictors, the v2 DC tables), and ff_mpeg4_pred_ac, run by the slice loop of ff_h263_decode_frame.
// The coordinator parses each picture's header, which carries the stream's sequential state: the slice height of the last I picture,
// and the rounding that alternates between P pictures once an I picture's extension header turned flip-flop rounding on. FFmpeg reads
// that extension header where the I picture's macroblocks end, so the coordinator decodes an MS-MPEG4 v3 I picture's macroblock
// layer to find it; a parse worker decodes each picture's macroblock layer from its plan.

use std::sync::LazyLock;

use crate::bitstream::BitReader;
use crate::codec::{Configuration, DecodedPicture, PictureInfo, fields_word};
use crate::error::{self, DecodeResult};
use crate::h263dec::{
    H263Context, INVALID_CODE, INVALID_LEVEL, INVALID_MOTION, MacroblockLayer, SliceStatus, check_bits, decode_frame_macroblocks, h263_lookups,
    macroblock_failure,
};
use crate::layout::{ERROR_BITS_EXHAUSTED, ERROR_PICTURE_HEADER};
use crate::motion::MotionContext;
use crate::mpv::{
    Codec, MB_TYPE_16X16, MB_TYPE_FORWARD_MV, MB_TYPE_INTRA, MB_TYPE_SKIP, MV_DIR_FORWARD, MV_TYPE_16X16, Mpv, PictType, Unquantize,
    rounded_div,
};
use crate::msmpeg4_tables::{
    MSMP4_DC_TABLES, MSMP4_MB_I_TABLE, MSMP4_MV_TABLE0, MSMP4_MV_TABLE0_LENS, MSMP4_MV_TABLE1, MSMP4_MV_TABLE1_LENS, OLD_FF_Y_DC_SCALE_TABLE,
    TABLE_MB_NON_INTRA, TABLE0_LEVEL, TABLE0_RUN, TABLE0_VLC, TABLE1_LEVEL, TABLE1_RUN, TABLE1_VLC, TABLE2_LEVEL, TABLE2_RUN, TABLE2_VLC,
    TABLE4_LEVEL, TABLE4_RUN, TABLE4_VLC, V2_INTRA_CBPC, V2_MB_TYPE, WMV1_C_DC_SCALE_TABLE,
};
use crate::plan_struct;
use crate::record::RecordHeader;
use crate::sequencer::{AnchorState, CodecStream, PicturePlan, PlanStep};
use crate::tables::{
    ALTERNATE_HORIZONTAL_SCAN, ALTERNATE_VERTICAL_SCAN, INTER_LEVEL, INTER_RUN, INTER_VLC, MPEG4_DCTAB_CHROM, MPEG4_DCTAB_LUM, MPEG4_INTRA_LEVEL,
    MPEG4_INTRA_RUN, MPEG4_INTRA_VLC,
};
use crate::vlc::{RLTable, RunLevel, VLCLookup, lookup_from_lengths_and_symbols, lookup_from_pairs};

// The picture header failure values: a v1 picture without its start code, a picture type other than I or P, a quantizer of 0, an
// I picture's slice code out of range, and a packet shorter than a bit per macroblock
pub const INVALID_START_CODE: u32 = 1;
pub const INVALID_PICTURE_TYPE: u32 = 2;
pub const INVALID_QSCALE: u32 = 3;
pub const INVALID_SLICE_CODE: u32 = 4;
pub const PACKET_TOO_SHORT: u32 = 5;

// msmpeg4.h's DC_MAX, the DC code whose level follows in 8 bits
const DC_MAX: u32 = 119;
// v1's picture start code
const V1_START_CODE: u32 = 0x0000_0100;
// The v2 DC tables' symbol of level 0: they code levels -256 to 255
const V2_DC_LEVEL_OFFSET: i32 = 256;
// The gray FFmpeg's dummy reference frame of a P picture without one holds, for every codec but H.263 and FLV
const MISSING_REFERENCE_LUMA: u32 = 0x80;

/// The six RL tables of ff_rl_table, the v2 DC tables of init_h263_dc_for_msmpeg4, and msmpeg4_decode_init_static's VLCs.
struct MsMpeg4Lookups {
    rl: [RLTable; 6],
    v2_dc_lum: VLCLookup,
    v2_dc_chroma: VLCLookup,
    v2_intra_cbpc: VLCLookup,
    v2_mb_type: VLCLookup,
    mv: [VLCLookup; 2],
    /// ff_mb_non_intra_vlc[DEFAULT_INTER_INDEX], ff_table_mb_non_intra
    mb_non_intra: VLCLookup,
    mb_i: VLCLookup,
    /// ff_msmp4_dc_vlc[dc_table_index][chroma]
    dc: [[VLCLookup; 2]; 2],
}

/// init_h263_dc_for_msmpeg4: the H.263 DC size codes inverted, then the level's bits, and a marker bit after levels of more than 8 bits.
fn v2_dc_codes(size_table: &[[u8; 2]; 13]) -> Vec<(u32, u32, u32)> {
    (-V2_DC_LEVEL_OFFSET..V2_DC_LEVEL_OFFSET)
        .map(|level: i32| {
            let size: u32 = 32 - level.unsigned_abs().leading_zeros();
            let bits: u32 = if level < 0 { level.unsigned_abs() ^ ((1 << size) - 1) } else { level as u32 };
            let mut length: u32 = u32::from(size_table[size as usize][1]);
            let mut code: u32 = u32::from(size_table[size as usize][0]) ^ ((1 << length) - 1);
            if size > 0 {
                code = (code << size) | bits;
                length += size;
                if size > 8 {
                    code = (code << 1) | 1;
                    length += 1;
                }
            }
            (code, length, (level + V2_DC_LEVEL_OFFSET) as u32)
        })
        .collect()
}

fn mv_lookup(lengths: &[u8], symbols: &[u16]) -> VLCLookup {
    let symbols: Vec<u32> = symbols.iter().map(|&symbol: &u16| u32::from(symbol)).collect();
    lookup_from_lengths_and_symbols(lengths, Some(&symbols))
}

static LOOKUPS: LazyLock<MsMpeg4Lookups> = LazyLock::new(|| MsMpeg4Lookups {
    rl: [
        // Intra luma: low motion, high motion, mid rate
        RLTable::new(132, 85, &TABLE0_VLC, &TABLE0_RUN, &TABLE0_LEVEL),
        RLTable::new(185, 119, &TABLE2_VLC, &TABLE2_RUN, &TABLE2_LEVEL),
        RLTable::new(102, 67, &MPEG4_INTRA_VLC, &MPEG4_INTRA_RUN, &MPEG4_INTRA_LEVEL),
        // Intra chroma and inter: low motion, high motion, mid rate
        RLTable::new(148, 81, &TABLE1_VLC, &TABLE1_RUN, &TABLE1_LEVEL),
        RLTable::new(168, 99, &TABLE4_VLC, &TABLE4_RUN, &TABLE4_LEVEL),
        RLTable::new(102, 58, &INTER_VLC, &INTER_RUN, &INTER_LEVEL),
    ],
    v2_dc_lum: VLCLookup::new(&v2_dc_codes(&MPEG4_DCTAB_LUM)),
    v2_dc_chroma: VLCLookup::new(&v2_dc_codes(&MPEG4_DCTAB_CHROM)),
    v2_intra_cbpc: lookup_from_pairs(&V2_INTRA_CBPC),
    v2_mb_type: lookup_from_pairs(&V2_MB_TYPE),
    mv: [mv_lookup(&MSMP4_MV_TABLE0_LENS, &MSMP4_MV_TABLE0), mv_lookup(&MSMP4_MV_TABLE1_LENS, &MSMP4_MV_TABLE1)],
    mb_non_intra: lookup_from_pairs(&TABLE_MB_NON_INTRA),
    mb_i: lookup_from_pairs(&MSMP4_MB_I_TABLE),
    dc: [
        [lookup_from_pairs(&MSMP4_DC_TABLES[0][0]), lookup_from_pairs(&MSMP4_DC_TABLES[0][1])],
        [lookup_from_pairs(&MSMP4_DC_TABLES[1][0]), lookup_from_pairs(&MSMP4_DC_TABLES[1][1])],
    ],
});

fn lookups() -> &'static MsMpeg4Lookups {
    &LOOKUPS
}

/// FFmpeg's decode012: 0, 10, or 11.
fn decode012(gb: &mut BitReader) -> u32 {
    if !gb.get_flag() { 0 } else { gb.get_bits1() + 1 }
}

/// The msmpeg4_version of a codec: 1, 2, or 3.
fn version_of(codec: Codec) -> u32 {
    match codec {
        Codec::MsMpeg4V1 => 1,
        Codec::MsMpeg4V2 => 2,
        _ => 3,
    }
}

fn codec_of_version(version: u32) -> Codec {
    match version {
        1 => Codec::MsMpeg4V1,
        2 => Codec::MsMpeg4V2,
        _ => Codec::MsMpeg4V3,
    }
}

/// What msmpeg4_decode_picture_header reads of a picture.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct PictureHeader {
    pict_type: PictType,
    qscale: i32,
    /// An I picture's slice height; a P picture keeps the last I picture's
    slice_height: Option<i32>,
    rl_table_index: u32,
    rl_chroma_table_index: u32,
    dc_table_index: u32,
    mv_table_index: u32,
    use_skip_mb_code: bool,
}

/// msmpeg4_decode_picture_header, up to the rounding, which the stream decides.
fn decode_picture_header(gb: &mut BitReader, version: u32, mb_width: i32, mb_height: i32) -> DecodeResult<PictureHeader> {
    // A valid picture codes at least a bit per macroblock; FFmpeg discards shorter ones
    if gb.bits_left() * 8 < i64::from(mb_width * mb_height) {
        return error::fail(ERROR_PICTURE_HEADER, PACKET_TOO_SHORT);
    }
    if version == 1 {
        if gb.get_bits(32) != V1_START_CODE {
            return error::fail(ERROR_PICTURE_HEADER, INVALID_START_CODE);
        }
        // The frame number
        gb.skip_bits(5);
    }
    let pict_type: PictType = match gb.get_bits(2) + 1 {
        1 => PictType::I,
        2 => PictType::P,
        _ => return error::fail(ERROR_PICTURE_HEADER, INVALID_PICTURE_TYPE),
    };
    let qscale: i32 = gb.get_bits(5) as i32;
    if qscale == 0 {
        return error::fail(ERROR_PICTURE_HEADER, INVALID_QSCALE);
    }
    let mut header: PictureHeader = PictureHeader { pict_type, qscale, ..PictureHeader::default() };
    if pict_type == PictType::I {
        let code: i32 = gb.get_bits(5) as i32;
        if version == 1 {
            if code == 0 || code > mb_height {
                return error::fail(ERROR_PICTURE_HEADER, INVALID_SLICE_CODE);
            }
            header.slice_height = Some(code);
        } else {
            // 0x17: one slice, 0x18: two slices, ...
            if code < 0x17 {
                return error::fail(ERROR_PICTURE_HEADER, INVALID_SLICE_CODE);
            }
            header.slice_height = Some(mb_height / (code - 0x16));
        }
        if version == 3 {
            header.rl_chroma_table_index = decode012(gb);
            header.rl_table_index = decode012(gb);
            header.dc_table_index = gb.get_bits1();
        } else {
            header.rl_chroma_table_index = 2;
            header.rl_table_index = 2;
        }
    } else if version == 3 {
        header.use_skip_mb_code = gb.get_flag();
        header.rl_table_index = decode012(gb);
        header.rl_chroma_table_index = header.rl_table_index;
        header.dc_table_index = gb.get_bits1();
        header.mv_table_index = gb.get_bits1();
    } else {
        header.use_skip_mb_code = version == 1 || gb.get_flag();
        header.rl_table_index = 2;
        header.rl_chroma_table_index = 2;
    }
    Ok(header)
}

/// ff_msmpeg4_decode_ext_header, read where an I picture's macroblocks ended: the flip-flop rounding of the P pictures after it, or
/// None where FFmpeg keeps it (an I picture too long for the extension header to end it).
fn decode_ext_header(gb: &mut BitReader, version: u32) -> Option<bool> {
    let left: i64 = gb.size_in_bits() as i64 - gb.bits_count() as i64;
    let length: i64 = if version >= 3 { 17 } else { 16 };
    if left >= length && left < length + 8 {
        // The frame rate, then the bit rate
        gb.skip_bits(5 + 11);
        Some(version >= 3 && gb.get_flag())
    } else if left < length + 8 {
        Some(false)
    } else {
        None
    }
}

/// The coordinator's state of an MS-MPEG4 stream.
pub struct MsMpeg4Stream {
    version: u32,
    width: i32,
    height: i32,
    /// FFmpeg's slice_height, the last I picture's; mb_height before the first
    slice_height: i32,
    no_rounding: bool,
    flipflop_rounding: bool,
}

impl MsMpeg4Stream {
    /// ff_msmpeg4_decode_init: the picture size is the container's, as MS-MPEG4 headers carry none.
    pub fn new(configuration: &Configuration) -> DecodeResult<Self> {
        Ok(Self {
            version: version_of(configuration.codec),
            width: configuration.width,
            height: configuration.height,
            slice_height: (configuration.height + 15) / 16,
            no_rounding: false,
            flipflop_rounding: false,
        })
    }
}

impl CodecStream for MsMpeg4Stream {
    /// ff_h263_decode_frame's picture: the header, the rounding it sets, and an I picture's extension header.
    fn plan(&mut self, packet: &[u8], start: usize, _anchors: &AnchorState) -> DecodeResult<PlanStep> {
        // A packet is one picture; an empty one outputs nothing in a low-delay stream
        if start != 0 || packet.is_empty() {
            return Ok(PlanStep::NoPicture);
        }
        let mb_width: i32 = (self.width + 15) / 16;
        let mb_height: i32 = (self.height + 15) / 16;
        let mut gb: BitReader = BitReader::new(packet);
        let header: PictureHeader = decode_picture_header(&mut gb, self.version, mb_width, mb_height)?;
        if let Some(slice_height) = header.slice_height {
            self.slice_height = slice_height;
            self.no_rounding = true;
        } else {
            self.no_rounding = self.flipflop_rounding && !self.no_rounding;
        }
        let plan: MsMpeg4Plan = MsMpeg4Plan {
            packet: packet.to_vec(),
            version: self.version,
            width: self.width,
            height: self.height,
            pict_type: header.pict_type.number(),
            qscale: header.qscale,
            slice_height: self.slice_height,
            header_bits: gb.bits_count() as u32,
            rl_table_index: header.rl_table_index,
            rl_chroma_table_index: header.rl_chroma_table_index,
            dc_table_index: header.dc_table_index,
            mv_table_index: header.mv_table_index,
            use_skip_mb_code: header.use_skip_mb_code,
            no_rounding: self.no_rounding,
        };
        if header.pict_type == PictType::I {
            // v1 and v2 never turn flip-flop rounding on, so only v3 needs where the macroblocks end. A damaged picture fails again
            // on its parse worker; its extension header reads where the macroblock layer stopped, as FFmpeg's does.
            let flipflop: Option<bool> = if self.version == 3 {
                let (_, end) = plan.decode_layer();
                let mut tail: BitReader = BitReader::new(packet);
                tail.seek(end);
                decode_ext_header(&mut tail, self.version)
            } else {
                Some(false)
            };
            if let Some(flipflop) = flipflop {
                self.flipflop_rounding = flipflop;
            }
        }
        let info: PictureInfo = PictureInfo {
            width: self.width as u32,
            height: self.height as u32,
            maximum_width: self.width as u32,
            maximum_height: self.height as u32,
            fields: fields_word(false, false),
            reference: true,
            output_now: true,
            reset_anchors: false,
        };
        Ok(PlanStep::Picture { info, plan: PicturePlan::MsMpeg4(Box::new(plan)), next_start: None })
    }

    fn maximum_picture_size(&self) -> (u32, u32) {
        (self.width as u32, self.height as u32)
    }
}

/// A planned MS-MPEG4 picture: its packet, the header the coordinator read, and the stream state it decodes with.
pub struct MsMpeg4Plan {
    packet: Vec<u8>,
    version: u32,
    width: i32,
    height: i32,
    /// PictType::number
    pict_type: i32,
    qscale: i32,
    slice_height: i32,
    /// Where the macroblock layer starts
    header_bits: u32,
    rl_table_index: u32,
    rl_chroma_table_index: u32,
    dc_table_index: u32,
    mv_table_index: u32,
    use_skip_mb_code: bool,
    no_rounding: bool,
}

plan_struct!(MsMpeg4Plan {
    packet,
    version,
    width,
    height,
    pict_type,
    qscale,
    slice_height,
    header_bits,
    rl_table_index,
    rl_chroma_table_index,
    dc_table_index,
    mv_table_index,
    use_skip_mb_code,
    no_rounding
});

impl MsMpeg4Plan {
    pub fn decode(&self) -> DecodeResult<DecodedPicture> {
        self.decode_layer().0
    }

    /// The picture's macroblock layer, and the bit its reader stopped at.
    fn decode_layer(&self) -> (DecodeResult<DecodedPicture>, usize) {
        let codec: Codec = codec_of_version(self.version);
        let pict_type: PictType = if self.pict_type == PictType::P.number() { PictType::P } else { PictType::I };
        // ff_h263_decode_init and ff_msmpeg4_decode_init: H.263 prediction, H.263 intra dequantization at reconstruction, inter
        // blocks dequantized as they parse, and ff_msmpeg4_common_init's DC scales
        let mut c: Mpv = Mpv::new(codec, self.width, self.height);
        c.h263_pred = true;
        c.dct_unquantize_intra = Unquantize::H263;
        c.dct_unquantize_inter = Unquantize::None;
        if self.version == 3 {
            // workaround_bugs is never 0, as FF_BUG_AUTODETECT is on
            c.y_dc_scale_table = &OLD_FF_Y_DC_SCALE_TABLE;
            c.c_dc_scale_table = &WMV1_C_DC_SCALE_TABLE;
        }
        c.low_delay = true;
        c.pict_type = pict_type;
        c.qscale = self.qscale;
        c.chroma_qscale = self.qscale;
        c.no_rounding = self.no_rounding;
        let coded_block_size: usize = (c.b8_stride * (2 * c.mb_height + 1) + 1) as usize;
        let mut h: H263Context = H263Context::new(c, &self.packet);
        h.gb.seek(self.header_bits as usize);
        h.slice_height = self.slice_height;
        h.reference = true;
        let mut decoder: MsMpeg4Decoder = MsMpeg4Decoder {
            h,
            version: self.version,
            use_skip_mb_code: self.use_skip_mb_code,
            rl_table_index: self.rl_table_index as usize,
            rl_chroma_table_index: self.rl_chroma_table_index as usize,
            dc_table_index: self.dc_table_index as usize,
            mv_table_index: self.mv_table_index as usize,
            coded_block: vec![0; coded_block_size],
        };
        let result: DecodeResult<()> = decode_frame_macroblocks(&mut decoder).and_then(|()| check_bits(&decoder.h));
        let end: usize = decoder.h.gb.bits_count();
        let decoded: DecodeResult<DecodedPicture> = result.map(|()| {
            let mpv: Mpv = decoder.h.c;
            let motion: MotionContext = MotionContext {
                pict_type,
                width: self.width,
                height: self.height,
                no_rounding: self.no_rounding,
                quarter_sample: false,
                obmc: false,
                workaround_bugs: mpv.workaround_bugs,
                sprite: Default::default(),
            };
            let header: RecordHeader =
                RecordHeader { xvid_idct: false, loop_filter: false, reset_anchors: false, missing_reference_luma: MISSING_REFERENCE_LUMA };
            DecodedPicture { mpv, motion, header }
        });
        (decoded, end)
    }
}

/// An RL code as FFmpeg's RL_VLC_ELEM tables give it: the level scaled by qmul and qadd, and the run plus 1, plus 192 for a last code.
enum RlCode {
    Escape,
    Code { level: i32, run: i32 },
}

/// MSMP4DecContext: the H.263 decoder context and the tables of the picture.
struct MsMpeg4Decoder<'a> {
    h: H263Context<'a>,
    version: u32,
    use_skip_mb_code: bool,
    rl_table_index: usize,
    rl_chroma_table_index: usize,
    dc_table_index: usize,
    mv_table_index: usize,
    /// s->coded_block, at FFmpeg's offset of b8_stride + 1; every entry an I picture reads, it wrote or never writes
    coded_block: Vec<u8>,
}

impl<'a> MsMpeg4Decoder<'a> {
    fn coded_block_index(&self, xy: i32) -> usize {
        (xy + self.h.c.b8_stride + 1) as usize
    }

    /// ff_msmpeg4_coded_block_pred: the coded flag predicted for luma block n, and the index it is stored at.
    fn coded_block_pred(&self, n: usize) -> (u8, usize) {
        let xy: i32 = self.h.c.block_index[n];
        let wrap: i32 = self.h.c.b8_stride;
        let a: u8 = self.coded_block[self.coded_block_index(xy - 1)];
        let b: u8 = self.coded_block[self.coded_block_index(xy - 1 - wrap)];
        let c: u8 = self.coded_block[self.coded_block_index(xy - wrap)];
        let pred: u8 = if b == c { a } else { c };
        (pred, self.coded_block_index(xy))
    }

    /// msmpeg4v2_decode_motion: H.263's vector code with a range of 64 that wraps.
    fn v2_decode_motion(&mut self, pred: i32) -> DecodeResult<i32> {
        let Some(code) = self.h.gb.get_vlc(&h263_lookups().mv) else {
            return macroblock_failure(&self.h.c, INVALID_MOTION);
        };
        if code == 0 {
            return Ok(pred);
        }
        let sign: bool = self.h.gb.get_flag();
        let mut val: i32 = code as i32;
        if sign {
            val = -val;
        }
        val += pred;
        if val <= -64 {
            val += 64;
        } else if val >= 64 {
            val -= 64;
        }
        Ok(val)
    }

    /// ff_msmpeg4_decode_motion: v3's vector pair from the picture's table, or escaped in 6 bits each.
    fn v3_decode_motion(&mut self, pred_x: i32, pred_y: i32) -> DecodeResult<(i32, i32)> {
        let Some(symbol) = self.h.gb.get_vlc(&lookups().mv[self.mv_table_index]) else {
            return macroblock_failure(&self.h.c, INVALID_MOTION);
        };
        let (mut mx, mut my): (i32, i32) = if symbol != 0 {
            ((symbol >> 8) as i32, (symbol & 0xFF) as i32)
        } else {
            let mx: i32 = self.h.gb.get_bits(6) as i32;
            (mx, self.h.gb.get_bits(6) as i32)
        };
        mx += pred_x - 32;
        my += pred_y - 32;
        // The vectors wrap, though not exactly modulo 64
        for value in [&mut mx, &mut my] {
            if *value <= -64 {
                *value += 64;
            } else if *value >= 64 {
                *value -= 64;
            }
        }
        Ok((mx, my))
    }

    /// The skipped macroblock of a P picture's skip bit.
    fn skip_mb(&mut self) -> SliceStatus {
        let c: &mut Mpv = &mut self.h.c;
        let mb_xy: i32 = c.mb_xy();
        c.mb_intra = false;
        c.block_last_index = [-1; 6];
        c.mv_dir = MV_DIR_FORWARD;
        c.mv_type = MV_TYPE_16X16;
        c.mv[0][0] = [0, 0];
        c.mb_skipped = true;
        c.mb_type[mb_xy as usize] = MB_TYPE_SKIP | MB_TYPE_FORWARD_MV | MB_TYPE_16X16;
        SliceStatus::Ok
    }

    /// The forward 16x16 vector of an inter macroblock.
    fn set_forward_vector(&mut self, mx: i32, my: i32) {
        let c: &mut Mpv = &mut self.h.c;
        let mb_xy: i32 = c.mb_xy();
        c.mv_dir = MV_DIR_FORWARD;
        c.mv_type = MV_TYPE_16X16;
        c.mv[0][0] = [mx, my];
        c.mb_type[mb_xy as usize] = MB_TYPE_FORWARD_MV | MB_TYPE_16X16;
    }

    /// Decodes the six blocks of the macroblock's coded block pattern.
    fn decode_blocks(&mut self, cbp: u32) -> DecodeResult<()> {
        self.h.c.clear_blocks();
        for n in 0..6 {
            self.decode_block(n, (cbp >> (5 - n)) & 1 != 0)?;
        }
        Ok(())
    }

    /// msmpeg4v12_decode_mb.
    fn v12_decode_mb(&mut self) -> DecodeResult<SliceStatus> {
        let h263: &'static crate::h263dec::H263Lookups = h263_lookups();
        let mut cbp: u32;
        if self.h.c.pict_type == PictType::P {
            if self.use_skip_mb_code && self.h.gb.get_flag() {
                return Ok(self.skip_mb());
            }
            let code: u32 = if self.version == 2 { self.h.get_vlc(&lookups().v2_mb_type)? } else { self.h.get_vlc(&h263.inter_mcbpc)? };
            if code > 7 {
                return macroblock_failure(&self.h.c, INVALID_CODE);
            }
            self.h.c.mb_intra = code >> 2 != 0;
            cbp = code & 3;
        } else {
            self.h.c.mb_intra = true;
            cbp = if self.version == 2 { self.h.get_vlc(&lookups().v2_intra_cbpc)? } else { self.h.get_vlc(&h263.intra_mcbpc)? };
            if cbp > 3 {
                return macroblock_failure(&self.h.c, INVALID_CODE);
            }
        }
        if !self.h.c.mb_intra {
            let cbpy: u32 = self.h.get_vlc(&h263.cbpy)?;
            cbp |= cbpy << 2;
            if self.version == 1 || cbp & 3 != 3 {
                cbp ^= 0x3C;
            }
            let (pred_x, pred_y, _) = self.h.c.h263_pred_motion(0, 0);
            let mx: i32 = self.v2_decode_motion(pred_x)?;
            let my: i32 = self.v2_decode_motion(pred_y)?;
            self.set_forward_vector(mx, my);
        } else {
            if self.version == 2 {
                self.h.c.ac_pred = self.h.gb.get_flag();
                cbp |= self.h.get_vlc(&h263.cbpy)? << 2;
            } else {
                self.h.c.ac_pred = false;
                cbp |= self.h.get_vlc(&h263.cbpy)? << 2;
                if self.h.c.pict_type == PictType::P {
                    cbp ^= 0x3C;
                }
            }
            let mb_xy: i32 = self.h.c.mb_xy();
            self.h.c.mb_type[mb_xy as usize] = MB_TYPE_INTRA;
        }
        self.decode_blocks(cbp)?;
        Ok(SliceStatus::Ok)
    }

    /// msmpeg4v34_decode_mb, for v3.
    fn v3_decode_mb(&mut self) -> DecodeResult<SliceStatus> {
        if self.h.gb.bits_left() <= 0 {
            let position: u32 = ((self.h.c.mb_y as u32 & 0xFFF) << 12) | (self.h.c.mb_x as u32 & 0xFFF);
            return error::fail(ERROR_BITS_EXHAUSTED, position);
        }
        let mut cbp: u32;
        if self.h.c.pict_type == PictType::P {
            if self.use_skip_mb_code && self.h.gb.get_flag() {
                return Ok(self.skip_mb());
            }
            let code: u32 = self.h.get_vlc(&lookups().mb_non_intra)?;
            self.h.c.mb_intra = code & 0x40 == 0;
            cbp = code & 0x3F;
        } else {
            self.h.c.mb_intra = true;
            let code: u32 = self.h.get_vlc(&lookups().mb_i)?;
            // The luma blocks' coded flags are predicted
            cbp = 0;
            for i in 0..6 {
                let mut val: u32 = (code >> (5 - i)) & 1;
                if i < 4 {
                    let (pred, index) = self.coded_block_pred(i);
                    val ^= u32::from(pred);
                    self.coded_block[index] = val as u8;
                }
                cbp |= val << (5 - i);
            }
        }
        if !self.h.c.mb_intra {
            let (pred_x, pred_y, _) = self.h.c.h263_pred_motion(0, 0);
            let (mx, my) = self.v3_decode_motion(pred_x, pred_y)?;
            self.set_forward_vector(mx, my);
        } else {
            self.h.c.ac_pred = self.h.gb.get_flag();
            let mb_xy: i32 = self.h.c.mb_xy();
            self.h.c.mb_type[mb_xy as usize] = MB_TYPE_INTRA;
        }
        self.decode_blocks(cbp)?;
        Ok(SliceStatus::Ok)
    }

    /// ff_msmpeg4_pred_dc for v2 and v3: the DC predicted for block n from its scaled neighbors, and the direction, 0 left, 1 top.
    fn pred_dc(&self, n: usize) -> (i32, i32) {
        let c: &Mpv = &self.h.c;
        let scale: i32 = if n < 4 { c.y_dc_scale } else { c.c_dc_scale };
        let wrap: i32 = c.block_wrap[n];
        let xy: i32 = c.block_index[n];
        // B C
        // A X
        let mut a: i32 = i32::from(c.get_dc_val(xy - 1));
        let mut b: i32 = i32::from(c.get_dc_val(xy - 1 - wrap));
        let mut cc: i32 = i32::from(c.get_dc_val(xy - wrap));
        if c.first_slice_line && n & 2 == 0 {
            b = 1024;
            cc = 1024;
        }
        // FFmpeg's C path: a plain division by 8, FASTDIV with ff_inverse (2^32 / scale rounded up) for other scales. Its x86 inline
        // assembly floors the division by 8 as well, which differs for the negative DCs only damaged streams predict from.
        let divide = |value: i32| -> i32 {
            let value: i32 = value + (scale >> 1);
            if scale == 8 {
                value / 8
            } else {
                let inverse: u64 = (1u64 << 32).div_ceil(scale as u64);
                (((value as i64 as u64).wrapping_mul(inverse)) >> 32) as u32 as i32
            }
        };
        a = divide(a);
        b = divide(b);
        cc = divide(cc);
        // MS-MPEG4 v1 to v3 test with <= where MPEG-4 tests with <
        if (a - b).abs() <= (b - cc).abs() { (cc, 1) } else { (a, 0) }
    }

    /// msmpeg4_decode_dc: block n's DC level and its prediction direction, -1 for v1's, which predicts from the last DC.
    fn decode_dc(&mut self, n: usize) -> DecodeResult<(i32, i32)> {
        let mut level: i32;
        if self.version <= 2 {
            let lookup: &VLCLookup = if n < 4 { &lookups().v2_dc_lum } else { &lookups().v2_dc_chroma };
            level = self.h.get_vlc(lookup)? as i32 - V2_DC_LEVEL_OFFSET;
        } else {
            let symbol: u32 = self.h.get_vlc(&lookups().dc[self.dc_table_index][usize::from(n >= 4)])?;
            // DC_MAX's 8-bit level reads its sign bit even when it is 0
            level = if symbol == DC_MAX { self.h.gb.get_bits(8) as i32 } else { symbol as i32 };
            if (symbol == DC_MAX || level != 0) && self.h.gb.get_flag() {
                level = -level;
            }
        }
        if self.version == 1 {
            let i: usize = if n < 4 { 0 } else { n - 3 };
            level += self.h.last_dc[i];
            self.h.last_dc[i] = level;
            return Ok((level, -1));
        }
        let (pred, dir) = self.pred_dc(n);
        level += pred;
        let scale: i32 = if n < 4 { self.h.c.y_dc_scale } else { self.h.c.c_dc_scale };
        let xy: i32 = self.h.c.block_index[n];
        *self.h.c.dc_val(xy) = (level * scale) as i16;
        Ok((level, dir))
    }

    /// ff_mpeg4_pred_ac: adds the left or top neighbor's AC predictors to an intra block when ac_pred is on, rescaled to the block's
    /// quantizer, and stores the block's own.
    fn pred_ac(&mut self, n: usize, dir: i32) {
        let c: &mut Mpv = &mut self.h.c;
        let index: i32 = c.block_index[n];
        if c.ac_pred {
            if dir == 0 {
                let xy: i32 = c.mb_x - 1 + c.mb_y * c.mb_stride;
                let left: [i16; 16] = c.get_ac_val(index - 1);
                let same: bool = c.mb_x == 0 || n == 1 || n == 3 || c.qscale == i32::from(c.qscale_table[xy as usize]);
                for i in 1..8 {
                    let value: i32 =
                        if same { i32::from(left[i]) } else { rounded_div(i32::from(left[i]) * i32::from(c.qscale_table[xy as usize]), c.qscale) };
                    c.block[n][i << 3] = c.block[n][i << 3].wrapping_add(value as i16);
                }
            } else {
                let xy: i32 = c.mb_x + c.mb_y * c.mb_stride - c.mb_stride;
                let top: [i16; 16] = c.get_ac_val(index - c.block_wrap[n]);
                let same: bool = c.mb_y == 0 || n == 2 || n == 3 || c.qscale == i32::from(c.qscale_table[xy as usize]);
                for i in 1..8 {
                    let value: i32 =
                        if same { i32::from(top[i + 8]) } else { rounded_div(i32::from(top[i + 8]) * i32::from(c.qscale_table[xy as usize]), c.qscale) };
                    c.block[n][i] = c.block[n][i].wrapping_add(value as i16);
                }
            }
        }
        let block: [i16; 64] = c.block[n];
        let stored: &mut [i16; 16] = c.ac_val(index);
        for i in 1..8 {
            stored[i] = block[i << 3];
            stored[8 + i] = block[i];
        }
    }

    /// GET_RL_VLC: the next code of an RL table as FFmpeg's per-quantizer table holds it.
    fn rl_code(&mut self, rl: &RLTable, qmul: i32, qadd: i32) -> DecodeResult<RlCode> {
        let Some((code, length)) = rl.decode(self.h.gb.peek_window()) else {
            return macroblock_failure(&self.h.c, INVALID_CODE);
        };
        self.h.gb.skip_bits(length);
        Ok(match code {
            RunLevel::Escape => RlCode::Escape,
            RunLevel::Code { run, level, last, .. } => RlCode::Code { level: level * qmul + qadd, run: run + 1 + if last { 192 } else { 0 } },
        })
    }

    /// An escaped code's RL code, which may not be another escape.
    fn escaped_rl_code(&mut self, rl: &RLTable, qmul: i32, qadd: i32) -> DecodeResult<(i32, i32)> {
        match self.rl_code(rl, qmul, qadd)? {
            RlCode::Code { level, run } => Ok((level, run)),
            RlCode::Escape => macroblock_failure(&self.h.c, INVALID_CODE),
        }
    }

    /// Applies the sign bit after a code: (level ^ sign) - sign.
    fn signed(&mut self, level: i32) -> i32 {
        if self.h.gb.get_flag() { -level } else { level }
    }

    /// ff_msmpeg4_decode_block for v1 to v3: an intra block's DC and its coefficients, which ff_mpv_reconstruct_mb dequantizes, or an
    /// inter block's coefficients, dequantized here.
    fn decode_block(&mut self, n: usize, coded: bool) -> DecodeResult<()> {
        let tables: &'static MsMpeg4Lookups = lookups();
        let (qmul, qadd): (i32, i32);
        let rl: &RLTable;
        let run_diff: i32;
        let scan: [u8; 64];
        let mut i: i32;
        let mut dc_pred_dir: i32 = -1;
        if self.h.c.mb_intra {
            qmul = 1;
            qadd = 0;
            let (level, dir) = self.decode_dc(n)?;
            dc_pred_dir = dir;
            // A negative level only logs, as FFmpeg's does without inter-intra prediction
            let (table, scale): (usize, i32) =
                if n < 4 { (self.rl_table_index, self.h.c.y_dc_scale) } else { (3 + self.rl_chroma_table_index, self.h.c.c_dc_scale) };
            rl = &tables.rl[table];
            if level > 256 * scale {
                return macroblock_failure(&self.h.c, INVALID_LEVEL);
            }
            self.h.c.block[n][0] = level as i16;
            run_diff = 0;
            i = 0;
            if !coded {
                self.pred_ac(n, dc_pred_dir);
                self.h.c.block_last_index[n] = i;
                return Ok(());
            }
            scan = if self.h.c.ac_pred {
                if dc_pred_dir == 0 { ALTERNATE_VERTICAL_SCAN } else { ALTERNATE_HORIZONTAL_SCAN }
            } else {
                self.h.c.intra_scantable.permutated
            };
        } else {
            qmul = self.h.c.qscale << 1;
            qadd = (self.h.c.qscale - 1) | 1;
            i = -1;
            rl = &tables.rl[3 + self.rl_table_index];
            run_diff = if self.version == 2 { 0 } else { 1 };
            if !coded {
                self.h.c.block_last_index[n] = i;
                return Ok(());
            }
            scan = self.h.c.inter_scantable.permutated;
        }
        // FFmpeg's overflow check reads the bits left where the block's reader opened
        let left: i64 = self.h.gb.bits_left();
        loop {
            let mut level: i32;
            match self.rl_code(rl, qmul, qadd)? {
                RlCode::Code { level: code_level, run } => {
                    i += run;
                    level = self.signed(code_level);
                }
                RlCode::Escape => {
                    let cache: u32 = self.h.gb.peek_window();
                    if self.version == 1 || cache & 0x8000_0000 == 0 {
                        if self.version == 1 || cache & 0x4000_0000 == 0 {
                            // Third escape: last, run, and level in full
                            if self.version != 1 {
                                self.h.gb.skip_bits(2);
                            }
                            let last: bool = self.h.gb.get_flag();
                            let run: i32 = self.h.gb.get_bits(6) as i32;
                            level = self.h.gb.get_sbits(8);
                            level = if level > 0 { level * qmul + qadd } else { level * qmul - qadd };
                            i += run + 1;
                            if last {
                                i += 192;
                            }
                        } else {
                            // Second escape: the run extended by the table's longest run of the level
                            self.h.gb.skip_bits(2);
                            let (code_level, run) = self.escaped_rl_code(rl, qmul, qadd)?;
                            i += run + i32::from(rl.max_run[(run >> 7) as usize][(code_level / qmul) as usize]) + run_diff;
                            level = self.signed(code_level);
                        }
                    } else {
                        // First escape: the level extended by the table's largest level of the run
                        self.h.gb.skip_bits(1);
                        let (code_level, run) = self.escaped_rl_code(rl, qmul, qadd)?;
                        i += run;
                        let extended: i32 = code_level + i32::from(rl.max_level[(run >> 7) as usize][((run - 1) & 63) as usize]) * qmul;
                        level = self.signed(extended);
                    }
                }
            }
            if i > 62 {
                i -= 192;
                if i & !63 != 0 {
                    // FFmpeg ignores the overflow of an undamaged reader, ending the block, without the error recognition flags
                    if left >= 0 {
                        i = 63;
                        break;
                    }
                    return macroblock_failure(&self.h.c, INVALID_LEVEL);
                }
                self.h.c.block[n][usize::from(scan[i as usize])] = level as i16;
                break;
            }
            self.h.c.block[n][usize::from(scan[i as usize])] = level as i16;
        }
        if self.h.c.mb_intra {
            self.pred_ac(n, dc_pred_dir);
        }
        self.h.c.block_last_index[n] = i;
        Ok(())
    }
}

impl<'a> MacroblockLayer<'a> for MsMpeg4Decoder<'a> {
    fn h(&mut self) -> &mut H263Context<'a> {
        &mut self.h
    }

    fn decode_mb(&mut self) -> DecodeResult<SliceStatus> {
        if self.version == 3 { self.v3_decode_mb() } else { self.v12_decode_mb() }
    }

    /// MS-MPEG4 slices start at fixed rows, without resync markers.
    fn decode_resync_header(&mut self) -> DecodeResult<bool> {
        Ok(false)
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
        fn put(&mut self, value: u32, count: u32) {
            for i in (0..count).rev() {
                if self.bits.is_multiple_of(8) {
                    self.bytes.push(0);
                }
                if (value >> i) & 1 != 0 {
                    let last: usize = self.bytes.len() - 1;
                    self.bytes[last] |= 0x80 >> (self.bits % 8);
                }
                self.bits += 1;
            }
        }

        fn put_pair<T: Copy + Into<u32>>(&mut self, pair: [T; 2]) {
            self.put(pair[0].into(), pair[1].into());
        }
    }

    const ANCHORS: AnchorState = AnchorState { finished: true, motion: None };

    fn stream(codec: Codec, width: i32, height: i32) -> MsMpeg4Stream {
        let configuration: Configuration = Configuration { codec, codec_tag: 0, width, height, extradata: Vec::new() };
        MsMpeg4Stream::new(&configuration).unwrap()
    }

    fn plan(stream: &mut MsMpeg4Stream, packet: &[u8]) -> MsMpeg4Plan {
        match stream.plan(packet, 0, &ANCHORS).unwrap() {
            PlanStep::Picture { info, plan: PicturePlan::MsMpeg4(plan), next_start } => {
                assert!(info.reference && info.output_now && next_start.is_none());
                *plan
            }
            _ => panic!("no picture planned"),
        }
    }

    /// A 16x16 v3 I picture of flat blocks, its extension header turning flip-flop rounding on or off.
    fn v3_flat_i_picture(flipflop: bool) -> Vec<u8> {
        let mut w: BitWriter = BitWriter::default();
        // I, qscale 4, one slice, rl_chroma_table_index 0, rl_table_index 1, dc_table_index 0
        w.put(0, 2);
        w.put(4, 5);
        w.put(0x17, 5);
        w.put(0b0, 1);
        w.put(0b10, 2);
        w.put(0, 1);
        // No coded blocks, no AC prediction, and DC differences of 0
        w.put_pair(MSMP4_MB_I_TABLE[0]);
        w.put(0, 1);
        for n in 0..6 {
            w.put_pair(MSMP4_DC_TABLES[0][usize::from(n >= 4)][0]);
        }
        // The extension header: frame rate, bit rate, flip-flop rounding
        w.put(25, 5);
        w.put(100, 11);
        w.put(u32::from(flipflop), 1);
        w.bytes
    }

    /// A v3 P picture whose macroblocks are all skipped.
    fn v3_skipped_p_picture(macroblocks: usize) -> Vec<u8> {
        let mut w: BitWriter = BitWriter::default();
        // P, qscale 4, skip codes, rl_table_index 0, dc_table_index 0, mv_table_index 0
        w.put(0b01, 2);
        w.put(4, 5);
        w.put(1, 1);
        w.put(0, 1);
        w.put(0, 1);
        w.put(0, 1);
        for _ in 0..macroblocks {
            w.put(1, 1);
        }
        w.bytes
    }

    #[test]
    fn reads_v3_picture_headers() {
        let mut w: BitWriter = BitWriter::default();
        // I, qscale 9, slice code 0x18 (two slices), rl_chroma_table_index 2, rl_table_index 1, dc_table_index 1
        w.put(0, 2);
        w.put(9, 5);
        w.put(0x18, 5);
        w.put(0b11, 2);
        w.put(0b10, 2);
        w.put(1, 1);
        w.put(0, 16);
        let header: PictureHeader = decode_picture_header(&mut BitReader::new(&w.bytes), 3, 4, 4).unwrap();
        assert_eq!(
            header,
            PictureHeader {
                pict_type: PictType::I,
                qscale: 9,
                slice_height: Some(2),
                rl_table_index: 1,
                rl_chroma_table_index: 2,
                dc_table_index: 1,
                mv_table_index: 0,
                use_skip_mb_code: false
            }
        );
        let mut w: BitWriter = BitWriter::default();
        // P, qscale 31, skip codes, rl_table_index 0, dc_table_index 1, mv_table_index 1
        w.put(0b01, 2);
        w.put(31, 5);
        w.put(1, 1);
        w.put(0, 1);
        w.put(1, 1);
        w.put(1, 1);
        w.put(0, 16);
        let header: PictureHeader = decode_picture_header(&mut BitReader::new(&w.bytes), 3, 4, 4).unwrap();
        assert_eq!(
            header,
            PictureHeader {
                pict_type: PictType::P,
                qscale: 31,
                slice_height: None,
                rl_table_index: 0,
                rl_chroma_table_index: 0,
                dc_table_index: 1,
                mv_table_index: 1,
                use_skip_mb_code: true
            }
        );
    }

    #[test]
    fn refuses_damaged_picture_headers() {
        let header_failure = |bytes: &[u8], version: u32, mb_count: i32| -> u32 {
            let error = decode_picture_header(&mut BitReader::new(bytes), version, mb_count, 1).unwrap_err();
            assert_eq!(error.code, ERROR_PICTURE_HEADER);
            error.value
        };
        // qscale 0; slice code 0x16; a v1 picture without its start code; B picture type; 4 bytes for 396 macroblocks
        assert_eq!(header_failure(&[0b0000_0000, 0b0101_1100], 3, 1), INVALID_QSCALE);
        assert_eq!(header_failure(&[0b0000_0101, 0b0110_0000], 3, 1), INVALID_SLICE_CODE);
        assert_eq!(header_failure(&[0, 0, 2, 0, 0, 0], 1, 1), INVALID_START_CODE);
        assert_eq!(header_failure(&[0b1000_0100, 0], 2, 1), INVALID_PICTURE_TYPE);
        assert_eq!(header_failure(&[0, 0, 0, 0], 3, 396), PACKET_TOO_SHORT);
    }

    #[test]
    fn alternates_rounding_after_an_i_picture_with_flipflop_rounding() {
        for flipflop in [true, false] {
            let mut stream: MsMpeg4Stream = stream(Codec::MsMpeg4V3, 16, 16);
            let i_plan: MsMpeg4Plan = plan(&mut stream, &v3_flat_i_picture(flipflop));
            assert!(i_plan.no_rounding);
            let rounding: Vec<bool> = (0..3).map(|_| plan(&mut stream, &v3_skipped_p_picture(1)).no_rounding).collect();
            assert_eq!(rounding, if flipflop { vec![false, true, false] } else { vec![false, false, false] });
            // The I picture decodes its DC from the 1024 predictors: 128 at a DC scale of 8
            let decoded: DecodedPicture = i_plan.decode().unwrap();
            let record = &decoded.mpv.records[0];
            assert!(record.mb_intra);
            assert_eq!(record.entries, (0..6).map(|n: u8| (n, 0, 1024)).collect::<Vec<(u8, u8, i16)>>());
        }
    }

    #[test]
    fn decodes_v1_dc_from_the_last_dc() {
        let mut w: BitWriter = BitWriter::default();
        // Start code, frame number, I, qscale 5, slices of one row
        w.put(V1_START_CODE, 32);
        w.put(0, 5);
        w.put(0, 2);
        w.put(5, 5);
        w.put(1, 5);
        // Intra MCBPC and CBPY of no coded blocks
        w.put(1, 1);
        w.put(0b0011, 4);
        // Luma DC differences 3, 0, -2, 0 in the inverted H.263 size codes, chroma 0
        w.put(0b0111, 4);
        w.put(0b100, 3);
        w.put(0b0101, 4);
        w.put(0b100, 3);
        w.put(0b00, 2);
        w.put(0b00, 2);
        let mut stream: MsMpeg4Stream = stream(Codec::MsMpeg4V1, 16, 16);
        let decoded: DecodedPicture = plan(&mut stream, &w.bytes).decode().unwrap();
        // The DCs 131, 131, 129, 129, 128, 128 at v1's DC scale of 8
        assert_eq!(decoded.mpv.records[0].entries, vec![(0, 0, 1048), (1, 0, 1048), (2, 0, 1032), (3, 0, 1032), (4, 0, 1024), (5, 0, 1024)]);
    }

    #[test]
    fn decodes_v2_dc_codes_with_inverted_size_codes() {
        let window = |code: u32, length: u32| -> u32 { code << (32 - length) };
        let lum: &VLCLookup = &lookups().v2_dc_lum;
        assert_eq!(lum.decode(window(0b0111, 4)), Some((259, 4)));
        assert_eq!(lum.decode(window(0b100, 3)), Some((256, 3)));
        // -256: the size 9 code 11111110, the complement 011111111, and the marker bit
        assert_eq!(lum.decode(window((0b1111_1110 << 10) | (0b0_1111_1111 << 1) | 1, 18)), Some((0, 18)));
        // Chroma's size 0 code, 11 inverted
        assert_eq!(lookups().v2_dc_chroma.decode(window(0b00, 2)), Some((256, 2)));
    }

    #[test]
    fn wraps_escaped_v3_vectors() {
        let mut w: BitWriter = BitWriter::default();
        // Table 0's escape, the first code of its lengths: eight zeros, then 63 and 0
        assert_eq!(MSMP4_MV_TABLE0[0], 0);
        w.put(0, u32::from(MSMP4_MV_TABLE0_LENS[0]));
        w.put(63, 6);
        w.put(0, 6);
        let mut decoder: MsMpeg4Decoder = MsMpeg4Decoder {
            h: H263Context::new(Mpv::new(Codec::MsMpeg4V3, 16, 16), &w.bytes),
            version: 3,
            use_skip_mb_code: false,
            rl_table_index: 0,
            rl_chroma_table_index: 0,
            dc_table_index: 0,
            mv_table_index: 0,
            coded_block: Vec::new(),
        };
        // 63 + 40 - 32 wraps from 71 to 7, 0 - 40 - 32 from -72 to -8
        assert_eq!(decoder.v3_decode_motion(40, -40).unwrap(), (7, -8));
    }

    #[test]
    fn decodes_skipped_macroblocks_and_fails_a_truncated_picture() {
        let mut stream: MsMpeg4Stream = stream(Codec::MsMpeg4V3, 48, 16);
        let decoded: DecodedPicture = plan(&mut stream, &v3_skipped_p_picture(3)).decode().unwrap();
        assert_eq!(decoded.mpv.records.len(), 3);
        assert!(decoded.mpv.records.iter().all(|record| !record.mb_intra && record.residual_blocks == 0 && record.mv[0][0] == [0, 0]));
        // The packet ends after the first macroblock's skip bit and the padding bits that follow it
        let truncated: Vec<u8> = v3_skipped_p_picture(1);
        let Err(error) = plan(&mut stream, &truncated).decode() else {
            panic!("a truncated picture decoded");
        };
        assert!(error.code == ERROR_BITS_EXHAUSTED || error.code == ERROR_MACROBLOCK_LAYER, "{error:?}");
    }
}
