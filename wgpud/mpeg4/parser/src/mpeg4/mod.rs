// MPEG-4 Part 2, as FFmpeg's mpeg4 decoder decodes it: the coordinator's stream parses each packet's headers in decode order, keeping the
// timing, the encoder detection, and the workarounds they decide, and plans each VOP; a parse worker decodes the plan's macroblock layer.

mod header;
mod macroblock;

use crate::codec::{AnchorMotion, Configuration, DecodedPicture, PictureInfo, fields_word};
use crate::bitstream::BitReader;
use crate::error::{self, DecodeResult};
use crate::h263dec::{H263Context, check_bits, decode_frame_macroblocks};
use crate::layout::{ERROR_PICTURE_SIZE, ERROR_UNSUPPORTED_FEATURE};
use crate::motion::{MotionContext, SpriteWarp};
use crate::mpv::{Codec, FF_BUG_STD_QPEL, Mpv, PictType, ScanTable, Unquantize};
use crate::plan_struct;
use crate::record::RecordHeader;
use crate::sequencer::{AnchorState, CodecStream, PicturePlan, PlanStep};
use crate::tables::{ALTERNATE_HORIZONTAL_SCAN, ALTERNATE_VERTICAL_SCAN, MPEG4_C_DC_SCALE_TABLE, MPEG4_Y_DC_SCALE_TABLE, ZIGZAG_DIRECT};

use header::{HeaderOutcome, Mpeg4Header, UNSUPPORTED_STD_QPEL, VopHeader};
use macroblock::{Mpeg4Decoder, Mpeg4Picture};

// The luma FFmpeg colors a missing reference of MPEG-4 with
const MISSING_REFERENCE_LUMA: u32 = 128;
// The largest side the package takes, and the picture size failure value
const MAXIMUM_SIDE: i32 = 4096;
const MAXIMUM_SAMPLES: i32 = 9_437_184;

/// The coordinator's MPEG-4 stream.
pub struct Mpeg4Stream {
    header: Mpeg4Header,
    /// Anchors decoded since the stream started, which a B picture needs two of, as FFmpeg's last_pic
    anchors: u32,
    /// The size the last picture decoded at
    size: Option<(i32, i32)>,
}

impl Mpeg4Stream {
    /// decode_init: the codec private data's extradata parses as headers, and its failures are ignored as FFmpeg ignores them.
    pub fn new(configuration: &Configuration) -> DecodeResult<Self> {
        let mut header: Mpeg4Header = Mpeg4Header::new(configuration.codec_tag, configuration.width, configuration.height);
        if !configuration.extradata.is_empty() {
            let mut parsed: Mpeg4Header = header.clone();
            if parsed.parse_picture_header(&mut BitReader::new(&configuration.extradata), true).is_ok() {
                header = parsed;
            }
        }
        // A VOL in the extradata sizes the stream without a reinit, as it parses before FFmpeg's context exists
        header.context_reinit = false;
        Ok(Self { header, anchors: 0, size: None })
    }
}

/// A planned VOP: what its macroblock layer decodes with.
pub struct Mpeg4Plan {
    packet: Vec<u8>,
    mb_bit_offset: u32,
    width: i32,
    height: i32,
    visible_edges: bool,
    vop: VopHeader,
    progressive_sequence: bool,
    low_delay: bool,
    quarter_sample: bool,
    mpeg_quant: bool,
    intra_matrix: [u16; 64],
    inter_matrix: [u16; 64],
    data_partitioning: bool,
    rvlc: bool,
    resync_marker: bool,
    shape: i32,
    quant_precision: i32,
    time_increment_bits: i32,
    vol_sprite_usage: i32,
    divx_version: i32,
    divx_build: i32,
    workaround_bugs: u32,
    xvid_idct: bool,
    pp_time: u16,
    pb_time: u16,
    pp_field_time: u16,
    pb_field_time: u16,
    reset_anchors: bool,
    anchor: Option<AnchorMotion>,
}

plan_struct!(Mpeg4Plan {
    packet,
    mb_bit_offset,
    width,
    height,
    visible_edges,
    vop,
    progressive_sequence,
    low_delay,
    quarter_sample,
    mpeg_quant,
    intra_matrix,
    inter_matrix,
    data_partitioning,
    rvlc,
    resync_marker,
    shape,
    quant_precision,
    time_increment_bits,
    vol_sprite_usage,
    divx_version,
    divx_build,
    workaround_bugs,
    xvid_idct,
    pp_time,
    pb_time,
    pp_field_time,
    pb_field_time,
    reset_anchors,
    anchor,
});

/// The byte a DivX packed bitstream's next VOP starts at, as ff_mpeg4_frame_end finds the one it keeps for the next packet: an I or B
/// VOP after this one's start code.
fn packed_next_vop(packet: &[u8], from: usize) -> Option<usize> {
    let end: usize = packet.len().checked_sub(4)?;
    (from..end).find(|&i: &usize| packet[i] == 0 && packet[i + 1] == 0 && packet[i + 2] == 1 && packet[i + 3] == 0xB6).filter(|&i: &usize| packet[i + 4] & 0x40 == 0)
}

impl CodecStream for Mpeg4Stream {
    fn plan(&mut self, packet: &[u8], start: usize, anchors: &AnchorState) -> DecodeResult<PlanStep> {
        let bytes: &[u8] = &packet[start.min(packet.len())..];
        let mut header: Mpeg4Header = self.header.clone();
        let mut gb: BitReader = BitReader::new(bytes);
        let (outcome, vop) = header.parse_picture_header(&mut gb, false)?;
        if outcome != HeaderOutcome::Vop {
            self.header = header;
            return Ok(PlanStep::NoPicture);
        }
        let (width, height): (i32, i32) = (header.width, header.height);
        if width <= 0 || height <= 0 || width > MAXIMUM_SIDE || height > MAXIMUM_SIDE || width * height > MAXIMUM_SAMPLES {
            return error::fail(ERROR_PICTURE_SIZE, ((width.clamp(0, 0xFFF) as u32) << 12) | height.clamp(0, 0xFFF) as u32);
        }
        if header.quarter_sample && header.workaround_bugs & FF_BUG_STD_QPEL != 0 {
            return error::fail(ERROR_UNSUPPORTED_FEATURE, UNSUPPORTED_STD_QPEL);
        }
        let mb_num: i64 = i64::from(((width + 15) / 16) * ((height + 15) / 16));
        // ff_h263_decode_frame refuses an anchor of fewer bits than half its macroblocks
        if vop.pict_type != PictType::B && mb_num / 2 > gb.bits_left() {
            self.header = header;
            return Ok(PlanStep::NoPicture);
        }
        let reset_anchors: bool = header.context_reinit || self.size.is_some_and(|size: (i32, i32)| size != (width, height));
        let reference: bool = vop.pict_type != PictType::B;
        if !reference {
            if reset_anchors || self.anchors < 2 {
                self.header = header;
                return Ok(PlanStep::NoPicture);
            }
            if !anchors.finished {
                return Ok(PlanStep::Blocked);
            }
        }
        let first_picture: bool = self.size.is_none();
        header.context_reinit = false;
        self.header = header;
        let header: &Mpeg4Header = &self.header;
        if reset_anchors {
            self.anchors = 0;
        }
        if reference {
            self.anchors += 1;
        }
        self.size = Some((width, height));
        let info: PictureInfo = PictureInfo {
            width: width as u32,
            height: height as u32,
            maximum_width: width as u32,
            maximum_height: height as u32,
            fields: fields_word(!header.progressive_sequence, vop.top_field_first),
            reference,
            output_now: !reference || header.low_delay,
            reset_anchors,
        };
        let plan: Mpeg4Plan = Mpeg4Plan {
            packet: bytes.to_vec(),
            mb_bit_offset: gb.bits_count() as u32,
            width,
            height,
            // ff_mpv_common_init and a size change reset the edges to the macroblock grid after decode_vop_header set them
            visible_edges: header.visible_edges && !reset_anchors && !first_picture,
            vop,
            progressive_sequence: header.progressive_sequence,
            low_delay: header.low_delay,
            quarter_sample: header.quarter_sample,
            mpeg_quant: header.mpeg_quant,
            intra_matrix: header.intra_matrix,
            inter_matrix: header.inter_matrix,
            data_partitioning: header.data_partitioning,
            rvlc: header.rvlc,
            resync_marker: header.resync_marker,
            shape: header.shape,
            quant_precision: header.quant_precision,
            time_increment_bits: header.time_increment_bits,
            vol_sprite_usage: header.vol_sprite_usage,
            divx_version: header.divx_version,
            divx_build: header.divx_build,
            workaround_bugs: header.workaround_bugs,
            xvid_idct: header.xvid_idct,
            pp_time: header.pp_time,
            pb_time: header.pb_time,
            pp_field_time: header.pp_field_time,
            pb_field_time: header.pb_field_time,
            reset_anchors,
            anchor: if reference { None } else { anchors.motion.cloned() },
        };
        let next_start: Option<usize> = if header.divx_packed { packed_next_vop(packet, start + gb.bits_count() / 8).map(|next: usize| next) } else { None };
        Ok(PlanStep::Picture { info, plan: PicturePlan::Mpeg4(Box::new(plan)), next_start })
    }

    fn maximum_picture_size(&self) -> (u32, u32) {
        (self.header.width.max(0) as u32, self.header.height.max(0) as u32)
    }
}

impl Mpeg4Plan {
    /// The VOP's macroblock layer, as ff_h263_decode_frame decodes it after the header.
    pub fn decode(&self) -> DecodeResult<DecodedPicture> {
        let vop: &VopHeader = &self.vop;
        let mut mpv: Mpv = Mpv::new(Codec::Mpeg4, self.width, self.height);
        mpv.h263_pred = true;
        mpv.y_dc_scale_table = &MPEG4_Y_DC_SCALE_TABLE;
        mpv.c_dc_scale_table = &MPEG4_C_DC_SCALE_TABLE;
        mpv.pict_type = vop.pict_type;
        mpv.qscale = vop.qscale;
        mpv.chroma_qscale = vop.qscale;
        mpv.no_rounding = vop.no_rounding;
        mpv.quarter_sample = self.quarter_sample;
        mpv.progressive_sequence = self.progressive_sequence;
        mpv.alternate_scan = vop.alternate_scan;
        mpv.top_field_first = vop.top_field_first;
        mpv.low_delay = self.low_delay;
        mpv.workaround_bugs = self.workaround_bugs;
        mpv.dct_unquantize_intra = if self.mpeg_quant { Unquantize::Mpeg2 } else { Unquantize::H263 };
        mpv.dct_unquantize_inter = if self.mpeg_quant { Unquantize::Mpeg2 } else { Unquantize::None };
        mpv.intra_scantable = ScanTable::new(if vop.alternate_scan { &ALTERNATE_VERTICAL_SCAN } else { &ZIGZAG_DIRECT });
        mpv.inter_scantable = mpv.intra_scantable;
        mpv.intra_matrix = self.intra_matrix;
        mpv.inter_matrix = self.inter_matrix;
        if self.visible_edges {
            mpv.h_edge_pos = self.width;
            mpv.v_edge_pos = self.height;
        }
        let mut h: H263Context = H263Context::new(mpv, &self.packet);
        h.gb.seek(self.mb_bit_offset as usize);
        h.data_partitioning = self.data_partitioning;
        h.partitioned_frame = self.data_partitioning && vop.pict_type != PictType::B;
        h.reference = vop.pict_type != PictType::B;
        let picture: Mpeg4Picture = Mpeg4Picture {
            f_code: vop.f_code,
            b_code: vop.b_code,
            intra_dc_threshold: vop.intra_dc_threshold,
            mpeg_quant: self.mpeg_quant,
            rvlc: self.rvlc,
            resync_marker: self.resync_marker,
            shape: self.shape,
            quant_precision: self.quant_precision,
            time_increment_bits: self.time_increment_bits,
            vol_sprite_usage: self.vol_sprite_usage,
            sprite: vop.sprite,
            sprite_shift: vop.sprite_shift,
            divx_version: self.divx_version,
            divx_build: self.divx_build,
            pp_time: self.pp_time,
            pb_time: self.pb_time,
            pp_field_time: self.pp_field_time,
            pb_field_time: self.pb_field_time,
            anchor: self.anchor.as_ref(),
            intra_h_scantable: if vop.alternate_scan { ALTERNATE_VERTICAL_SCAN } else { ALTERNATE_HORIZONTAL_SCAN },
            intra_v_scantable: ALTERNATE_VERTICAL_SCAN,
        };
        let mut decoder: Mpeg4Decoder = Mpeg4Decoder::new(h, picture);
        decode_frame_macroblocks(&mut decoder)?;
        check_bits(&decoder.h)?;
        let sprite: SpriteWarp = vop.sprite;
        let motion: MotionContext = MotionContext {
            pict_type: vop.pict_type,
            width: self.width,
            height: self.height,
            no_rounding: vop.no_rounding,
            quarter_sample: self.quarter_sample,
            obmc: false,
            workaround_bugs: self.workaround_bugs,
            sprite,
        };
        let header: RecordHeader =
            RecordHeader { xvid_idct: self.xvid_idct, loop_filter: false, reset_anchors: self.reset_anchors, missing_reference_luma: MISSING_REFERENCE_LUMA };
        Ok(DecodedPicture { mpv: decoder.h.c, motion, header })
    }
}
