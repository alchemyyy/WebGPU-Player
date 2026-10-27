// The MPEG-4 Part 2 macroblock layer as FFmpeg's mpeg4videodec.c decodes it: mpeg4_decode_mb for I, P, S(GMC), and B VOPs, the data
// partitions of ff_mpeg4_decode_partitions and mpeg4_decode_partitioned_mb, mpeg4_decode_block with its escapes and reversible codes,
// DC and AC prediction, get_amv, video packet headers, and ff_mpeg4_set_direct_mv.

use std::sync::LazyLock;

use crate::codec::AnchorMotion;
use crate::error::DecodeResult;
use crate::h263dec::{H263Context, INVALID_CODE, INVALID_LEVEL, MacroblockLayer, SliceStatus, h263_lookups, macroblock_failure};
use crate::mpeg4::header::{BIN_ONLY_SHAPE, GMC_SPRITE, RECT_SHAPE};
use crate::motion::SpriteWarp;
use crate::mpv::{
    FF_BUG_AMV, FF_BUG_DC_CLIP, FF_BUG_DIRECT_BLOCKSIZE, FF_BUG_XVID_ILACE, MB_TYPE_8X8, MB_TYPE_16X8, MB_TYPE_16X16, MB_TYPE_ACPRED,
    MB_TYPE_BACKWARD_MV, MB_TYPE_BIDIR_MV, MB_TYPE_DIRECT2, MB_TYPE_FORWARD_MV, MB_TYPE_GMC, MB_TYPE_INTERLACED, MB_TYPE_INTRA,
    MB_TYPE_SKIP, MV_DIR_BACKWARD, MV_DIR_FORWARD, MV_DIRECT, MV_TYPE_8X8, MV_TYPE_FIELD, MV_TYPE_16X16, PictType, has_backward_mv,
    has_forward_mv, is_8x8, is_acpred, is_direct, is_interlaced, is_intra, is_skip, rounded_div,
};
use crate::tables::{
    INTER_LEVEL, INTER_RUN, INTER_RVLC, INTER_RVLC_LEVEL, INTER_RVLC_RUN, INTER_VLC, INTRA_RVLC, INTRA_RVLC_LEVEL, INTRA_RVLC_RUN, MB_TYPE_B_TAB,
    MPEG4_DCTAB_CHROM, MPEG4_DCTAB_LUM, MPEG4_INTRA_LEVEL, MPEG4_INTRA_RUN, MPEG4_INTRA_VLC,
};
use crate::vlc::{RLTable, RunLevel, VLCLookup, lookup_from_pairs};

// The resync markers and partition markers, mpeg4videodefs.h
const DC_MARKER: u32 = 0x6B001;
const MOTION_MARKER: u32 = 0x1F001;
// The number of DC VLC codes FFmpeg builds of the 13 in each table
const DC_VLC_CODES: usize = 10;
// mb_type_b_map: each B macroblock type code's mb_type
const MB_TYPE_B_MAP: [u32; 4] =
    [MB_TYPE_DIRECT2 | MB_TYPE_BIDIR_MV, MB_TYPE_BIDIR_MV | MB_TYPE_16X16, MB_TYPE_BACKWARD_MV | MB_TYPE_16X16, MB_TYPE_FORWARD_MV | MB_TYPE_16X16];
const QUANT_TAB: [i32; 4] = [-1, -2, 1, 2];
const MPEG4_RESYNC_PREFIX: [u32; 8] = [0x7F00, 0x7E00, 0x7C00, 0x7800, 0x7000, 0x6000, 0x4000, 0x0000];
// The direct mode scale table, direct_scale_mv's size and bias
const TAB_SIZE: i32 = 64;
const TAB_BIAS: i32 = 32;

pub struct Mpeg4Lookups {
    pub dc_lum: VLCLookup,
    pub dc_chrom: VLCLookup,
    pub mb_type_b: VLCLookup,
    pub rl_intra: RLTable,
    pub rl_inter: RLTable,
    pub rvlc_intra: RLTable,
    pub rvlc_inter: RLTable,
}

static LOOKUPS: LazyLock<Mpeg4Lookups> = LazyLock::new(|| Mpeg4Lookups {
    dc_lum: lookup_from_pairs(&MPEG4_DCTAB_LUM[..DC_VLC_CODES]),
    dc_chrom: lookup_from_pairs(&MPEG4_DCTAB_CHROM[..DC_VLC_CODES]),
    mb_type_b: lookup_from_pairs(&MB_TYPE_B_TAB),
    rl_intra: RLTable::new(102, 67, &MPEG4_INTRA_VLC, &MPEG4_INTRA_RUN, &MPEG4_INTRA_LEVEL),
    rl_inter: RLTable::new(102, 58, &INTER_VLC, &INTER_RUN, &INTER_LEVEL),
    rvlc_intra: RLTable::new(169, 103, &INTRA_RVLC, &INTRA_RVLC_RUN, &INTRA_RVLC_LEVEL),
    rvlc_inter: RLTable::new(169, 103, &INTER_RVLC, &INTER_RVLC_RUN, &INTER_RVLC_LEVEL),
});

/// The picture-level facts the macroblock layer reads besides the MpegEncContext's.
pub struct Mpeg4Picture<'a> {
    pub f_code: i32,
    pub b_code: i32,
    pub intra_dc_threshold: i32,
    pub mpeg_quant: bool,
    pub rvlc: bool,
    pub resync_marker: bool,
    pub shape: i32,
    pub quant_precision: i32,
    pub time_increment_bits: i32,
    pub vol_sprite_usage: i32,
    pub sprite: SpriteWarp,
    pub sprite_shift: [i32; 2],
    pub divx_version: i32,
    pub divx_build: i32,
    pub pp_time: u16,
    pub pb_time: u16,
    pub pp_field_time: u16,
    pub pb_field_time: u16,
    pub anchor: Option<&'a AnchorMotion>,
    pub intra_h_scantable: [u8; 64],
    pub intra_v_scantable: [u8; 64],
}

pub struct Mpeg4Decoder<'a> {
    pub h: H263Context<'a>,
    pub picture: Mpeg4Picture<'a>,
    direct_scale_mv: [[i16; 64]; 2],
}

/// FFmpeg's RSHIFT.
fn rshift(a: i32, b: i32) -> i32 {
    if a > 0 { (a + ((1 << b) >> 1)) >> b } else { (a + ((1 << b) >> 1) - 1) >> b }
}

/// ff_mpeg4_get_video_packet_prefix_length.
fn video_packet_prefix_length(pict_type: PictType, f_code: i32, b_code: i32) -> i32 {
    match pict_type {
        PictType::I => 16,
        PictType::P | PictType::S => f_code + 15,
        PictType::B => f_code.max(b_code).max(2) + 15,
    }
}

/// FFmpeg's av_log2.
fn av_log2(value: u32) -> u32 {
    if value == 0 { 0 } else { 31 - value.leading_zeros() }
}

impl<'a> Mpeg4Decoder<'a> {
    pub fn new(h: H263Context<'a>, picture: Mpeg4Picture<'a>) -> Self {
        let mut decoder: Self = Self { h, picture, direct_scale_mv: [[0; 64]; 2] };
        if decoder.h.c.pict_type == PictType::B {
            decoder.init_direct_mv();
        }
        decoder
    }

    /// ff_mpeg4_init_direct_mv.
    fn init_direct_mv(&mut self) {
        let pp: i32 = i32::from(self.picture.pp_time);
        let pb: i32 = i32::from(self.picture.pb_time);
        for i in 0..TAB_SIZE {
            self.direct_scale_mv[0][i as usize] = ((i - TAB_BIAS) * pb / pp) as i16;
            self.direct_scale_mv[1][i as usize] = ((i - TAB_BIAS) * (pb - pp) / pp) as i16;
        }
    }

    fn lookups() -> &'static Mpeg4Lookups {
        &LOOKUPS
    }

    /// mpeg4_pred_dc.
    fn pred_dc(&self, n: usize) -> (i32, bool) {
        let c = &self.h.c;
        let index: i32 = c.block_index[n];
        let wrap: i32 = c.block_wrap[n];
        let mut a: i32 = i32::from(c.get_dc_val(index - 1));
        let mut b: i32 = i32::from(c.get_dc_val(index - 1 - wrap));
        let mut cc: i32 = i32::from(c.get_dc_val(index - wrap));
        if c.first_slice_line && n != 3 {
            if n != 2 {
                b = 1024;
                cc = 1024;
            }
            if n != 1 && c.mb_x == c.resync_mb_x {
                b = 1024;
                a = 1024;
            }
        }
        if c.mb_x == c.resync_mb_x && c.mb_y == c.resync_mb_y + 1 && (n == 0 || n == 4 || n == 5) {
            b = 1024;
        }
        if (a - b).abs() < (b - cc).abs() { (cc, true) } else { (a, false) }
    }

    /// mpeg4_get_level_dc: the quantized DC from its prediction, storing the scaled DC as the next prediction.
    fn get_level_dc(&mut self, n: usize, pred: i32, level: i32) -> i32 {
        let c = &mut self.h.c;
        let scale: i32 = if n < 4 { c.y_dc_scale } else { c.c_dc_scale };
        let pred: i32 = (pred + (scale >> 1)) / scale;
        let level: i32 = level + pred;
        let ret: i32 = level;
        let mut scaled: i32 = level * scale;
        if scaled & !2047 != 0 {
            if scaled < 0 {
                scaled = 0;
            } else if c.workaround_bugs & FF_BUG_DC_CLIP == 0 {
                scaled = 2047;
            }
        }
        let index: i32 = c.block_index[n];
        *c.dc_val(index) = scaled as i16;
        ret
    }

    /// mpeg4_decode_dc: the quantized DC and the prediction direction, true for top.
    fn decode_dc(&mut self, n: usize) -> DecodeResult<(i32, bool)> {
        let lookups: &Mpeg4Lookups = Self::lookups();
        let code: u32 = self.h.get_vlc(if n < 4 { &lookups.dc_lum } else { &lookups.dc_chrom })?;
        let mut level: i32 = 0;
        if code != 0 {
            level = self.h.gb.get_xbits(code);
            if code > 8 {
                // The marker bit, which FFmpeg checks only when asked to
                self.h.gb.skip_bits(1);
            }
        }
        let (pred, dir) = self.pred_dc(n);
        Ok((self.get_level_dc(n, pred, level), dir))
    }

    /// ff_mpeg4_pred_ac: adds the left or top AC prediction when ac_pred is on, then stores the block's own as the next prediction.
    fn pred_ac(&mut self, n: usize, dir_top: bool) {
        let c = &mut self.h.c;
        let index: i32 = c.block_index[n];
        let qscale: i32 = c.qscale;
        if c.ac_pred {
            if !dir_top {
                let xy: i32 = c.mb_x - 1 + c.mb_y * c.mb_stride;
                let ac: [i16; 16] = c.get_ac_val(index - 1);
                let neighbor_qscale: i32 = if c.mb_x > 0 || n == 1 || n == 3 { i32::from(c.qscale_table[xy.max(0) as usize]) } else { qscale };
                let same: bool = c.mb_x == 0 || qscale == neighbor_qscale || n == 1 || n == 3;
                for i in 1..8 {
                    let prediction: i32 = if same { i32::from(ac[i]) } else { rounded_div(i32::from(ac[i]) * neighbor_qscale, qscale) };
                    c.block[n][i << 3] = (i32::from(c.block[n][i << 3]) + prediction) as i16;
                }
            } else {
                let xy: i32 = c.mb_x + c.mb_y * c.mb_stride - c.mb_stride;
                let ac: [i16; 16] = c.get_ac_val(index - c.block_wrap[n]);
                let neighbor_qscale: i32 = if c.mb_y > 0 { i32::from(c.qscale_table[xy as usize]) } else { qscale };
                let same: bool = c.mb_y == 0 || qscale == neighbor_qscale || n == 2 || n == 3;
                for i in 1..8 {
                    let prediction: i32 = if same { i32::from(ac[i + 8]) } else { rounded_div(i32::from(ac[i + 8]) * neighbor_qscale, qscale) };
                    c.block[n][i] = (i32::from(c.block[n][i]) + prediction) as i16;
                }
            }
        }
        let block: [i16; 64] = c.block[n];
        let own: &mut [i16; 16] = c.ac_val(index);
        for i in 1..8 {
            own[i] = block[i << 3];
            own[8 + i] = block[i];
        }
    }

    /// mpeg4_decode_block.
    fn decode_block(&mut self, n: usize, coded: bool, intra: bool, use_intra_dc_vlc: bool, rvlc: bool) -> DecodeResult<()> {
        let lookups: &Mpeg4Lookups = Self::lookups();
        let mut i: i32;
        let mut dc_pred_dir: bool = false;
        let mut pred: i32 = 0;
        let rl: &RLTable;
        let scan: [u8; 64];
        let (qmul, qadd): (i32, i32);
        if intra {
            if use_intra_dc_vlc {
                let level: i32;
                if self.h.partitioned_frame {
                    let c = &self.h.c;
                    let stored: i32 = i32::from(c.get_dc_val(c.block_index[n]));
                    let scale: i32 = if n < 4 { c.y_dc_scale } else { c.c_dc_scale };
                    level = (stored + (scale >> 1)) / scale;
                    let direction: u32 = (u32::from(c.pred_dir_table[c.mb_xy() as usize]) << n) & 32;
                    dc_pred_dir = direction != 0;
                } else {
                    let (decoded, dir) = self.decode_dc(n)?;
                    level = decoded;
                    dc_pred_dir = dir;
                }
                self.h.c.block[n][0] = level as i16;
                i = 0;
            } else {
                i = -1;
                let (predicted, dir) = self.pred_dc(n);
                pred = predicted;
                dc_pred_dir = dir;
            }
            rl = if rvlc { &lookups.rvlc_intra } else { &lookups.rl_intra };
            scan = if self.h.c.ac_pred {
                if !dc_pred_dir { self.picture.intra_v_scantable } else { self.picture.intra_h_scantable }
            } else {
                self.h.c.intra_scantable.permutated
            };
            qmul = 1;
            qadd = 0;
        } else {
            i = -1;
            if !coded {
                self.h.c.block_last_index[n] = i;
                return Ok(());
            }
            rl = if rvlc { &lookups.rvlc_inter } else { &lookups.rl_inter };
            scan = self.h.c.intra_scantable.permutated;
            if self.picture.mpeg_quant {
                qmul = 1;
                qadd = 0;
            } else {
                qmul = self.h.c.qscale << 1;
                qadd = (self.h.c.qscale - 1) | 1;
            }
        }
        if coded {
            loop {
                let Some((code, length)) = rl.decode(self.h.gb.peek_window()) else {
                    return macroblock_failure(&self.h.c, INVALID_CODE);
                };
                self.h.gb.skip_bits(length);
                let mut level: i32;
                match code {
                    RunLevel::Escape => {
                        if rvlc {
                            let gb = &mut self.h.gb;
                            if gb.get_bits1() == 0 {
                                return macroblock_failure(&self.h.c, INVALID_CODE);
                            }
                            let last: bool = gb.get_flag();
                            let run: i32 = gb.get_bits(6) as i32;
                            if gb.get_bits1() == 0 {
                                return macroblock_failure(&self.h.c, INVALID_CODE);
                            }
                            let magnitude: i32 = gb.get_bits(11) as i32;
                            if gb.get_bits(5) != 0x10 {
                                return macroblock_failure(&self.h.c, INVALID_CODE);
                            }
                            level = magnitude * qmul + qadd;
                            if gb.get_flag() {
                                level = -level;
                            }
                            i += run + 1;
                            if last {
                                i += 192;
                            }
                        } else {
                            let cache: u32 = self.h.gb.peek_window();
                            if cache & 0x8000_0000 != 0 {
                                if cache & 0x4000_0000 != 0 {
                                    // Third escape: last, run, and a 12-bit level between markers
                                    let gb = &mut self.h.gb;
                                    gb.skip_bits(2);
                                    let last: bool = gb.get_flag();
                                    let run: i32 = gb.get_bits(6) as i32;
                                    gb.skip_bits(1);
                                    level = gb.get_sbits(12);
                                    gb.skip_bits(1);
                                    level = if level > 0 { level * qmul + qadd } else { level * qmul - qadd };
                                    if !(-2048..=2047).contains(&level) {
                                        level = if level < 0 { -2048 } else { 2047 };
                                    }
                                    i += run + 1;
                                    if last {
                                        i += 192;
                                    }
                                } else {
                                    // Second escape: the run extended past the code's longest run for its level
                                    self.h.gb.skip_bits(2);
                                    let Some((RunLevel::Code { run, level: table_level, last, .. }, length)) = rl.decode(self.h.gb.peek_window()) else {
                                        return macroblock_failure(&self.h.c, INVALID_CODE);
                                    };
                                    self.h.gb.skip_bits(length);
                                    level = table_level * qmul + qadd;
                                    let max_run: i32 = i32::from(rl.max_run[usize::from(last)][table_level as usize]);
                                    i += run + 1 + if last { 192 } else { 0 } + max_run + 1;
                                    if self.h.gb.get_flag() {
                                        level = -level;
                                    }
                                }
                            } else {
                                // First escape: the level extended past the code's largest level for its run
                                self.h.gb.skip_bits(1);
                                let Some((RunLevel::Code { run, level: table_level, last, .. }, length)) = rl.decode(self.h.gb.peek_window()) else {
                                    return macroblock_failure(&self.h.c, INVALID_CODE);
                                };
                                self.h.gb.skip_bits(length);
                                i += run + 1 + if last { 192 } else { 0 };
                                let max_level: i32 = i32::from(rl.max_level[usize::from(last)][run as usize]);
                                level = table_level * qmul + qadd + max_level * qmul;
                                if self.h.gb.get_flag() {
                                    level = -level;
                                }
                            }
                        }
                    }
                    RunLevel::Code { run, level: table_level, last, .. } => {
                        i += run + 1 + if last { 192 } else { 0 };
                        level = table_level * qmul + qadd;
                        if self.h.gb.get_flag() {
                            level = -level;
                        }
                    }
                }
                if i > 62 {
                    i -= 192;
                    if i & !63 != 0 {
                        return macroblock_failure(&self.h.c, INVALID_LEVEL);
                    }
                    self.h.c.block[n][usize::from(scan[i as usize])] = level as i16;
                    break;
                }
                self.h.c.block[n][usize::from(scan[i as usize])] = level as i16;
            }
        }
        if intra {
            if !use_intra_dc_vlc {
                let block_dc: i32 = i32::from(self.h.c.block[n][0]);
                self.h.c.block[n][0] = self.get_level_dc(n, pred, block_dc) as i16;
                i = i.max(0);
            }
            self.pred_ac(n, dc_pred_dir);
            if self.h.c.ac_pred {
                i = 63;
            }
        }
        self.h.c.block_last_index[n] = i;
        Ok(())
    }

    /// get_amv: the average vector of a GMC macroblock, component n.
    fn get_amv(&self, n: usize) -> i32 {
        let c = &self.h.c;
        let sprite: SpriteWarp = self.picture.sprite;
        let a: i32 = sprite.sprite_warping_accuracy;
        let quarter: i32 = i32::from(c.quarter_sample);
        let mut len: i32 = 1 << (self.picture.f_code + 4);
        if c.workaround_bugs & FF_BUG_AMV != 0 {
            len >>= quarter;
        }
        let sum: i32 = if sprite.real_sprite_warping_points == 1 {
            if self.picture.divx_version == 500 && self.picture.divx_build == 413 && a >= quarter {
                sprite.sprite_offset[0][n] / (1 << (a - quarter))
            } else {
                rshift(sprite.sprite_offset[0][n] * (1 << quarter), a)
            }
        } else {
            let mut dx: i32 = sprite.sprite_delta[n][0];
            let mut dy: i32 = sprite.sprite_delta[n][1];
            let shift: i32 = self.picture.sprite_shift[0];
            if n != 0 {
                dy -= 1 << (shift + a + 1);
            } else {
                dx -= 1 << (shift + a + 1);
            }
            let mb_v: u32 = (sprite.sprite_offset[0][n] as u32)
                .wrapping_add((dx as u32).wrapping_mul(c.mb_x as u32).wrapping_mul(16))
                .wrapping_add((dy as u32).wrapping_mul(c.mb_y as u32).wrapping_mul(16));
            let mut sum: i32 = 0;
            for y in 0..16u32 {
                let mut v: i32 = mb_v.wrapping_add((dy as u32).wrapping_mul(y)) as i32;
                for _ in 0..16 {
                    sum = sum.wrapping_add(v >> shift);
                    v = v.wrapping_add(dx);
                }
            }
            rshift(sum, a + 8 - quarter)
        };
        if sum < -len {
            -len
        } else if sum >= len {
            len - 1
        } else {
            sum
        }
    }

    /// mpeg4_is_resync: the macroblock number after a resync marker or the picture's end, else 0. A stream without resync markers
    /// never ends a slice early, as FFmpeg's FF_BUG_NO_PADDING workaround has it.
    fn is_resync(&mut self) -> i32 {
        if !self.picture.resync_marker {
            return 0;
        }
        let pict_number: i32 = self.h.c.pict_type.number();
        let mut bits_count: usize = self.h.gb.bits_count();
        let mut v: u32 = self.h.gb.show_bits(16);
        while v <= 0xFF {
            if self.h.c.pict_type == PictType::B || (v >> (8 - pict_number)) != 1 || self.h.partitioned_frame {
                break;
            }
            self.h.gb.skip_bits((8 + pict_number) as u32);
            bits_count += (8 + pict_number) as usize;
            v = self.h.gb.show_bits(16);
        }
        if bits_count + 8 >= self.h.gb.size_in_bits() {
            v >>= 8;
            v |= 0x7F >> (7 - (bits_count & 7));
            if v == 0x7F {
                return self.h.c.mb_num;
            }
        } else if v == MPEG4_RESYNC_PREFIX[bits_count & 7] {
            let mb_num_bits: u32 = av_log2((self.h.c.mb_num - 1) as u32) + 1;
            let backup = self.h.gb.clone();
            self.h.gb.skip_bits(1);
            self.h.gb.align();
            let mut len: i32 = 0;
            while len < 32 {
                if self.h.gb.get_bits1() != 0 {
                    break;
                }
                len += 1;
            }
            let mut mb_num: i32 = self.h.gb.get_bits(mb_num_bits) as i32;
            if mb_num == 0 || mb_num > self.h.c.mb_num || self.h.gb.bits_count() + 6 > self.h.gb.size_in_bits() {
                mb_num = -1;
            }
            self.h.gb = backup;
            if len >= video_packet_prefix_length(self.h.c.pict_type, self.picture.f_code, self.picture.b_code) {
                return mb_num;
            }
        }
        0
    }

    /// ff_mpeg4_decode_video_packet_header.
    fn decode_video_packet_header(&mut self) -> DecodeResult<bool> {
        let mb_num_bits: u32 = av_log2((self.h.c.mb_num - 1) as u32) + 1;
        if self.h.gb.bits_count() as i64 > self.h.gb.size_in_bits() as i64 - 20 {
            return Ok(false);
        }
        let mut len: i32 = 0;
        while len < 32 {
            if self.h.gb.get_bits1() != 0 {
                break;
            }
            len += 1;
        }
        if len != video_packet_prefix_length(self.h.c.pict_type, self.picture.f_code, self.picture.b_code) {
            return Ok(false);
        }
        let mut header_extension: bool = false;
        if self.picture.shape != RECT_SHAPE {
            header_extension = self.h.gb.get_flag();
        }
        let mb_num: i32 = self.h.gb.get_bits(mb_num_bits) as i32;
        if mb_num >= self.h.c.mb_num || mb_num == 0 {
            return Ok(false);
        }
        self.h.c.mb_x = mb_num % self.h.c.mb_width;
        self.h.c.mb_y = mb_num / self.h.c.mb_width;
        if self.picture.shape != BIN_ONLY_SHAPE {
            let qscale: i32 = self.h.gb.get_bits(self.picture.quant_precision as u32) as i32;
            if qscale != 0 {
                self.h.c.qscale = qscale;
                self.h.c.chroma_qscale = qscale;
            }
        }
        if self.picture.shape == RECT_SHAPE {
            header_extension = self.h.gb.get_flag();
        }
        if header_extension {
            while self.h.gb.get_bits1() != 0 {}
            self.h.gb.skip_bits(1);
            self.h.gb.skip_bits(self.picture.time_increment_bits as u32);
            self.h.gb.skip_bits(1);
            self.h.gb.skip_bits(2);
            if self.picture.shape != BIN_ONLY_SHAPE {
                self.h.gb.skip_bits(3);
                if self.h.c.pict_type == PictType::S && self.picture.vol_sprite_usage == GMC_SPRITE {
                    // FFmpeg rereads the trajectory and logs "untested"; its values replace the VOP header's
                    return Ok(false);
                }
                if self.h.c.pict_type != PictType::I {
                    self.h.gb.skip_bits(3);
                }
                if self.h.c.pict_type == PictType::B {
                    self.h.gb.skip_bits(3);
                }
            }
        }
        Ok(true)
    }

    /// The motion_val index of block i, which the partitions write through.
    fn store_motion(&mut self, mx: i32, my: i32) {
        let xy: i32 = self.h.c.block_index[0];
        let stride: i32 = self.h.c.b8_stride;
        let value: [i16; 2] = [mx as i16, my as i16];
        for index in [xy, xy + 1, xy + stride, xy + stride + 1] {
            *self.h.c.motion_val(0, index) = value;
        }
    }

    /// mpeg4_decode_partition_a: the first partition's macroblock types, quantizers, DCs, and vectors; the macroblocks it holds.
    fn decode_partition_a(&mut self) -> DecodeResult<i32> {
        let lookups = h263_lookups();
        let mut mb_num: i32 = 0;
        self.h.c.first_slice_line = true;
        while self.h.c.mb_y < self.h.c.mb_height {
            self.h.c.init_block_index();
            while self.h.c.mb_x < self.h.c.mb_width {
                let xy: i32 = self.h.c.mb_xy();
                mb_num += 1;
                self.h.c.update_block_index();
                if self.h.c.mb_x == self.h.c.resync_mb_x && self.h.c.mb_y == self.h.c.resync_mb_y + 1 {
                    self.h.c.first_slice_line = false;
                }
                if self.h.c.pict_type == PictType::I {
                    let cbpc: u32 = loop {
                        if self.h.gb.show_bits(19) == DC_MARKER {
                            return Ok(mb_num - 1);
                        }
                        let cbpc: u32 = self.h.get_vlc(&lookups.intra_mcbpc)?;
                        if cbpc != 8 {
                            break cbpc;
                        }
                    };
                    self.h.c.cbp_table[xy as usize] = (cbpc & 3) as u8;
                    self.h.c.mb_type[xy as usize] = MB_TYPE_INTRA;
                    self.h.c.mb_intra = true;
                    if cbpc & 4 != 0 {
                        let qscale: i32 = self.h.c.qscale + QUANT_TAB[self.h.gb.get_bits(2) as usize];
                        self.h.c.set_qscale(qscale);
                    }
                    self.h.c.qscale_table[xy as usize] = self.h.c.qscale as i8;
                    self.h.c.mbintra_table[xy as usize] = 1;
                    let mut dir: u8 = 0;
                    for i in 0..6 {
                        let (_, top) = self.decode_dc(i)?;
                        dir = (dir << 1) | u8::from(top);
                    }
                    self.h.c.pred_dir_table[xy as usize] = dir;
                } else {
                    let cbpc: u32 = loop {
                        let bits: u32 = self.h.gb.show_bits(17);
                        if bits == MOTION_MARKER {
                            return Ok(mb_num - 1);
                        }
                        self.h.gb.skip_bits(1);
                        if bits & 0x10000 != 0 {
                            break u32::MAX;
                        }
                        let cbpc: u32 = self.h.get_vlc(&lookups.inter_mcbpc)?;
                        if cbpc != 20 {
                            break cbpc;
                        }
                    };
                    if cbpc == u32::MAX {
                        // A skipped macroblock: GMC's average vector in an S(GMC)-VOP, else none
                        let (mx, my): (i32, i32) = if self.h.c.pict_type == PictType::S && self.picture.vol_sprite_usage == GMC_SPRITE {
                            self.h.c.mb_type[xy as usize] = MB_TYPE_SKIP | MB_TYPE_16X16 | MB_TYPE_GMC | MB_TYPE_FORWARD_MV;
                            (self.get_amv(0), self.get_amv(1))
                        } else {
                            self.h.c.mb_type[xy as usize] = MB_TYPE_SKIP | MB_TYPE_16X16 | MB_TYPE_FORWARD_MV;
                            (0, 0)
                        };
                        self.store_motion(mx, my);
                        self.h.c.h263_clean_intra_table_entries(xy);
                        self.h.c.mb_x += 1;
                        continue;
                    }
                    self.h.c.cbp_table[xy as usize] = (cbpc & (8 + 3)) as u8;
                    self.h.c.mb_intra = cbpc & 4 != 0;
                    if self.h.c.mb_intra {
                        self.h.c.mb_type[xy as usize] = MB_TYPE_INTRA;
                        self.h.c.mbintra_table[xy as usize] = 1;
                        self.store_motion(0, 0);
                    } else {
                        self.h.c.h263_clean_intra_table_entries(xy);
                        self.h.c.mcsel =
                            self.h.c.pict_type == PictType::S && self.picture.vol_sprite_usage == GMC_SPRITE && cbpc & 16 == 0 && self.h.gb.get_flag();
                        if cbpc & 16 == 0 {
                            let (pred_x, pred_y, _) = self.h.c.h263_pred_motion(0, 0);
                            let (mx, my): (i32, i32);
                            if !self.h.c.mcsel {
                                mx = self.h.decode_motion_checked(pred_x, self.picture.f_code)?;
                                my = self.h.decode_motion_checked(pred_y, self.picture.f_code)?;
                                self.h.c.mb_type[xy as usize] = MB_TYPE_16X16 | MB_TYPE_FORWARD_MV;
                            } else {
                                mx = self.get_amv(0);
                                my = self.get_amv(1);
                                self.h.c.mb_type[xy as usize] = MB_TYPE_16X16 | MB_TYPE_GMC | MB_TYPE_FORWARD_MV;
                            }
                            self.store_motion(mx, my);
                        } else {
                            self.h.c.mb_type[xy as usize] = MB_TYPE_8X8 | MB_TYPE_FORWARD_MV;
                            for i in 0..4 {
                                let (pred_x, pred_y, index) = self.h.c.h263_pred_motion(i, 0);
                                let mx: i32 = self.h.decode_motion_checked(pred_x, self.picture.f_code)?;
                                let my: i32 = self.h.decode_motion_checked(pred_y, self.picture.f_code)?;
                                *self.h.c.motion_val(0, index) = [mx as i16, my as i16];
                            }
                        }
                    }
                }
                self.h.c.mb_x += 1;
            }
            self.h.c.mb_x = 0;
            self.h.c.mb_y += 1;
        }
        Ok(mb_num)
    }

    /// mpeg4_decode_partition_b: the second partition's AC prediction flags, coded block patterns, quantizer changes, and inter DCs.
    fn decode_partition_b(&mut self, mb_count: i32) -> DecodeResult<()> {
        let lookups = h263_lookups();
        let mut mb_num: i32 = 0;
        self.h.c.mb_x = self.h.c.resync_mb_x;
        self.h.c.first_slice_line = true;
        self.h.c.mb_y = self.h.c.resync_mb_y;
        while mb_num < mb_count {
            self.h.c.init_block_index();
            while mb_num < mb_count && self.h.c.mb_x < self.h.c.mb_width {
                let xy: usize = self.h.c.mb_xy() as usize;
                mb_num += 1;
                self.h.c.update_block_index();
                if self.h.c.mb_x == self.h.c.resync_mb_x && self.h.c.mb_y == self.h.c.resync_mb_y + 1 {
                    self.h.c.first_slice_line = false;
                }
                if self.h.c.pict_type == PictType::I {
                    let ac_pred: bool = self.h.gb.get_flag();
                    let cbpy: u32 = self.h.get_vlc(&lookups.cbpy)?;
                    self.h.c.cbp_table[xy] |= (cbpy << 2) as u8;
                    if ac_pred {
                        self.h.c.mb_type[xy] |= MB_TYPE_ACPRED;
                    }
                } else if is_intra(self.h.c.mb_type[xy]) {
                    let ac_pred: bool = self.h.gb.get_flag();
                    let cbpy: u32 = self.h.get_vlc(&lookups.cbpy)?;
                    if self.h.c.cbp_table[xy] & 8 != 0 {
                        let qscale: i32 = self.h.c.qscale + QUANT_TAB[self.h.gb.get_bits(2) as usize];
                        self.h.c.set_qscale(qscale);
                    }
                    self.h.c.qscale_table[xy] = self.h.c.qscale as i8;
                    let mut dir: u8 = 0;
                    for i in 0..6 {
                        let (_, top) = self.decode_dc(i)?;
                        dir = (dir << 1) | u8::from(top);
                    }
                    self.h.c.cbp_table[xy] &= 3;
                    self.h.c.cbp_table[xy] |= (cbpy << 2) as u8;
                    if ac_pred {
                        self.h.c.mb_type[xy] |= MB_TYPE_ACPRED;
                    }
                    self.h.c.pred_dir_table[xy] = dir;
                } else if is_skip(self.h.c.mb_type[xy]) {
                    self.h.c.qscale_table[xy] = self.h.c.qscale as i8;
                    self.h.c.cbp_table[xy] = 0;
                } else {
                    let cbpy: u32 = self.h.get_vlc(&lookups.cbpy)?;
                    if self.h.c.cbp_table[xy] & 8 != 0 {
                        let qscale: i32 = self.h.c.qscale + QUANT_TAB[self.h.gb.get_bits(2) as usize];
                        self.h.c.set_qscale(qscale);
                    }
                    self.h.c.qscale_table[xy] = self.h.c.qscale as i8;
                    self.h.c.cbp_table[xy] &= 3;
                    self.h.c.cbp_table[xy] |= ((cbpy ^ 0xF) << 2) as u8;
                }
                self.h.c.mb_x += 1;
            }
            if mb_num >= mb_count {
                return Ok(());
            }
            self.h.c.mb_x = 0;
            self.h.c.mb_y += 1;
        }
        Ok(())
    }

    /// mpeg4_decode_partitioned_mb: a macroblock's third partition, its blocks.
    fn decode_partitioned_mb(&mut self) -> DecodeResult<SliceStatus> {
        let xy: usize = self.h.c.mb_xy() as usize;
        let mb_type: u32 = self.h.c.mb_type[xy];
        let mut cbp: u32 = u32::from(self.h.c.cbp_table[xy]);
        let use_intra_dc_vlc: bool = self.h.c.qscale < self.picture.intra_dc_threshold;
        if i32::from(self.h.c.qscale_table[xy]) != self.h.c.qscale {
            let qscale: i32 = i32::from(self.h.c.qscale_table[xy]);
            self.h.c.set_qscale(qscale);
        }
        if self.h.c.pict_type == PictType::P || self.h.c.pict_type == PictType::S {
            for i in 0..4 {
                let index: i32 = self.h.c.block_index[i];
                let value: [i16; 2] = self.h.c.get_motion_val(0, index);
                self.h.c.mv[0][i] = [i32::from(value[0]), i32::from(value[1])];
            }
            self.h.c.mb_intra = is_intra(mb_type);
            if is_skip(mb_type) {
                self.h.c.block_last_index = [-1; 6];
                self.h.c.mv_dir = MV_DIR_FORWARD;
                self.h.c.mv_type = MV_TYPE_16X16;
                if self.h.c.pict_type == PictType::S && self.picture.vol_sprite_usage == GMC_SPRITE {
                    self.h.c.mcsel = true;
                    self.h.c.mb_skipped = false;
                    self.h.c.mbskip_table[xy] = 0;
                } else {
                    self.h.c.mcsel = false;
                    self.h.c.mb_skipped = true;
                    self.h.c.mbskip_table[xy] = 1;
                }
            } else if self.h.c.mb_intra {
                self.h.c.ac_pred = is_acpred(mb_type);
            } else {
                self.h.c.mv_dir = MV_DIR_FORWARD;
                self.h.c.mv_type = if is_8x8(mb_type) { MV_TYPE_8X8 } else { MV_TYPE_16X16 };
            }
        } else {
            self.h.c.mb_intra = true;
            self.h.c.ac_pred = is_acpred(mb_type);
        }
        if !is_skip(mb_type) {
            self.h.c.clear_blocks();
            let intra: bool = self.h.c.mb_intra;
            let rvlc: bool = self.picture.rvlc;
            for i in 0..6 {
                self.decode_block(i, cbp & 32 != 0, intra, use_intra_dc_vlc, rvlc)?;
                cbp += cbp;
            }
        }
        self.h.mb_num_left -= 1;
        if self.h.mb_num_left <= 0 {
            return Ok(if self.is_resync() != 0 { SliceStatus::End } else { SliceStatus::NoEnd });
        }
        if self.is_resync() != 0 {
            let delta: usize = if self.h.c.mb_x + 1 == self.h.c.mb_width { 2 } else { 1 };
            if self.h.c.cbp_table[xy + delta] != 0 {
                return Ok(SliceStatus::End);
            }
        }
        Ok(SliceStatus::Ok)
    }

    /// The next anchor's skip table entry, which a B macroblock inherits.
    fn anchor_skipped(&self, index: usize) -> bool {
        self.picture.anchor.is_some_and(|anchor: &AnchorMotion| anchor.mbskip_table.get(index).copied().unwrap_or(0) != 0)
    }

    /// ff_mpeg4_set_one_direct_mv.
    fn set_one_direct_mv(&mut self, mx: i32, my: i32, i: usize) {
        let xy: i32 = self.h.c.block_index[i];
        let time_pp: i32 = i32::from(self.picture.pp_time);
        let time_pb: i32 = i32::from(self.picture.pb_time);
        let anchor_vector: [i32; 2] = self.anchor_motion_val(xy);
        for (component, delta) in [mx, my].into_iter().enumerate() {
            let p: i32 = anchor_vector[component];
            let (forward, backward): (i32, i32) = if ((p + TAB_BIAS) as u32) < TAB_SIZE as u32 {
                let forward: i32 = i32::from(self.direct_scale_mv[0][(p + TAB_BIAS) as usize]) + delta;
                (forward, if delta != 0 { forward - p } else { i32::from(self.direct_scale_mv[1][(p + TAB_BIAS) as usize]) })
            } else {
                let forward: i32 = p * time_pb / time_pp + delta;
                (forward, if delta != 0 { forward - p } else { p * (time_pb - time_pp) / time_pp })
            };
            self.h.c.mv[0][i][component] = forward;
            self.h.c.mv[1][i][component] = backward;
        }
    }

    /// next_pic.motion_val[0][xy], from the anchor motion's b8 grid.
    fn anchor_motion_val(&self, xy: i32) -> [i32; 2] {
        let Some(anchor) = self.picture.anchor else {
            return [0; 2];
        };
        let index: usize = (2 * xy) as usize;
        match anchor.motion_val.get(index..index + 2) {
            Some(pair) => [i32::from(pair[0]), i32::from(pair[1])],
            None => [0; 2],
        }
    }

    /// ff_mpeg4_set_direct_mv: the direct mode vectors from the co-located macroblock of the next anchor; returns the mb_type.
    fn set_direct_mv(&mut self, mx: i32, my: i32) -> u32 {
        let mb_index: usize = self.h.c.mb_xy() as usize;
        let colocated: u32 = self.picture.anchor.map_or(0, |anchor: &AnchorMotion| anchor.mb_type.get(mb_index).copied().unwrap_or(0));
        if is_8x8(colocated) {
            self.h.c.mv_type = MV_TYPE_8X8;
            for i in 0..4 {
                self.set_one_direct_mv(mx, my, i);
            }
            return MB_TYPE_DIRECT2 | MB_TYPE_8X8 | MB_TYPE_BIDIR_MV;
        }
        if is_interlaced(colocated) {
            self.h.c.mv_type = MV_TYPE_FIELD;
            let anchor: &AnchorMotion = self.picture.anchor.expect("an interlaced co-located macroblock comes from an anchor");
            for i in 0..2 {
                let field_select: i32 = i32::from(anchor.ref_index.get(4 * mb_index + 2 * i).copied().unwrap_or(0));
                self.h.c.field_select[0][i] = field_select;
                self.h.c.field_select[1][i] = i as i32;
                let (time_pp, time_pb): (u16, u16) = if self.h.c.top_field_first {
                    (
                        self.picture.pp_field_time.wrapping_sub(field_select as u16).wrapping_add(i as u16),
                        self.picture.pb_field_time.wrapping_sub(field_select as u16).wrapping_add(i as u16),
                    )
                } else {
                    (
                        self.picture.pp_field_time.wrapping_add(field_select as u16).wrapping_sub(i as u16),
                        self.picture.pb_field_time.wrapping_add(field_select as u16).wrapping_sub(i as u16),
                    )
                };
                let (time_pp, time_pb): (i32, i32) = (i32::from(time_pp), i32::from(time_pb));
                let field_index: usize = 2 * (i * anchor.field_mv.len() / 4 + mb_index);
                let vector: [i32; 2] = match anchor.field_mv.get(field_index..field_index + 2) {
                    Some(pair) => [i32::from(pair[0]), i32::from(pair[1])],
                    None => [0; 2],
                };
                for (component, delta) in [mx, my].into_iter().enumerate() {
                    let forward: i32 = vector[component] * time_pb / time_pp + delta;
                    self.h.c.mv[0][i][component] = forward;
                    self.h.c.mv[1][i][component] = if delta != 0 { forward - vector[component] } else { vector[component] * (time_pb - time_pp) / time_pp };
                }
            }
            return MB_TYPE_DIRECT2 | MB_TYPE_16X8 | MB_TYPE_BIDIR_MV | MB_TYPE_INTERLACED;
        }
        self.set_one_direct_mv(mx, my, 0);
        for dir in 0..2 {
            let vector: [i32; 2] = self.h.c.mv[dir][0];
            for i in 1..4 {
                self.h.c.mv[dir][i] = vector;
            }
        }
        self.h.c.mv_type = if self.h.c.workaround_bugs & FF_BUG_DIRECT_BLOCKSIZE != 0 || !self.h.c.quarter_sample { MV_TYPE_16X16 } else { MV_TYPE_8X8 };
        MB_TYPE_DIRECT2 | MB_TYPE_16X16 | MB_TYPE_BIDIR_MV
    }

    /// The intra part of mpeg4_decode_mb, from its intra label on.
    fn decode_intra_mb(&mut self, cbpc: u32, dquant: bool) -> DecodeResult<()> {
        let xy: usize = self.h.c.mb_xy() as usize;
        self.h.c.ac_pred = self.h.gb.get_flag();
        self.h.c.mb_type[xy] = if self.h.c.ac_pred { MB_TYPE_INTRA | MB_TYPE_ACPRED } else { MB_TYPE_INTRA };
        let cbpy: u32 = self.h.get_vlc(&h263_lookups().cbpy)?;
        let mut cbp: u32 = (cbpc & 3) | (cbpy << 2);
        let use_intra_dc_vlc: bool = self.h.c.qscale < self.picture.intra_dc_threshold;
        if dquant {
            let qscale: i32 = self.h.c.qscale + QUANT_TAB[self.h.gb.get_bits(2) as usize];
            self.h.c.set_qscale(qscale);
        }
        if !self.h.c.progressive_sequence {
            self.h.c.interlaced_dct = self.h.gb.get_flag();
        }
        self.h.c.clear_blocks();
        for i in 0..6 {
            self.decode_block(i, cbp & 32 != 0, true, use_intra_dc_vlc, false)?;
            cbp += cbp;
        }
        Ok(())
    }

    /// The P and S(GMC) part of mpeg4_decode_mb; Ok(None) for a skipped macroblock, else its coded block pattern.
    fn decode_p_mb(&mut self) -> DecodeResult<Option<u32>> {
        let xy: usize = self.h.c.mb_xy() as usize;
        let gmc: bool = self.h.c.pict_type == PictType::S && self.picture.vol_sprite_usage == GMC_SPRITE;
        let cbpc: u32 = loop {
            if self.h.gb.get_flag() {
                self.h.c.mb_intra = false;
                self.h.c.block_last_index = [-1; 6];
                self.h.c.mv_dir = MV_DIR_FORWARD;
                self.h.c.mv_type = MV_TYPE_16X16;
                if gmc {
                    self.h.c.mb_type[xy] = MB_TYPE_SKIP | MB_TYPE_GMC | MB_TYPE_16X16 | MB_TYPE_FORWARD_MV;
                    self.h.c.mcsel = true;
                    self.h.c.mv[0][0] = [self.get_amv(0), self.get_amv(1)];
                    self.h.c.mbskip_table[xy] = 0;
                    self.h.c.mb_skipped = false;
                } else {
                    self.h.c.mb_type[xy] = MB_TYPE_SKIP | MB_TYPE_16X16 | MB_TYPE_FORWARD_MV;
                    self.h.c.mcsel = false;
                    self.h.c.mv[0][0] = [0, 0];
                    self.h.c.mbskip_table[xy] = 1;
                    self.h.c.mb_skipped = true;
                }
                return Ok(None);
            }
            let cbpc: u32 = self.h.get_vlc(&h263_lookups().inter_mcbpc)?;
            if cbpc != 20 {
                break cbpc;
            }
        };
        let dquant: bool = cbpc & 8 != 0;
        self.h.c.mb_intra = cbpc & 4 != 0;
        if self.h.c.mb_intra {
            self.decode_intra_mb(cbpc, dquant)?;
            return Ok(Some(u32::MAX));
        }
        self.h.c.clear_blocks();
        self.h.c.mcsel = gmc && cbpc & 16 == 0 && self.h.gb.get_flag();
        let cbpy: u32 = self.h.get_vlc(&h263_lookups().cbpy)? ^ 0x0F;
        let cbp: u32 = (cbpc & 3) | (cbpy << 2);
        if dquant {
            let qscale: i32 = self.h.c.qscale + QUANT_TAB[self.h.gb.get_bits(2) as usize];
            self.h.c.set_qscale(qscale);
        }
        if !self.h.c.progressive_sequence && (cbp != 0 || self.h.c.workaround_bugs & FF_BUG_XVID_ILACE != 0) {
            self.h.c.interlaced_dct = self.h.gb.get_flag();
        }
        self.h.c.mv_dir = MV_DIR_FORWARD;
        let f_code: i32 = self.picture.f_code;
        if cbpc & 16 == 0 {
            if self.h.c.mcsel {
                self.h.c.mb_type[xy] = MB_TYPE_GMC | MB_TYPE_16X16 | MB_TYPE_FORWARD_MV;
                self.h.c.mv_type = MV_TYPE_16X16;
                self.h.c.mv[0][0] = [self.get_amv(0), self.get_amv(1)];
            } else if !self.h.c.progressive_sequence && self.h.gb.get_flag() {
                self.h.c.mb_type[xy] = MB_TYPE_16X8 | MB_TYPE_FORWARD_MV | MB_TYPE_INTERLACED;
                self.h.c.mv_type = MV_TYPE_FIELD;
                self.h.c.field_select[0][0] = self.h.gb.get_bits1() as i32;
                self.h.c.field_select[0][1] = self.h.gb.get_bits1() as i32;
                let (pred_x, pred_y, _) = self.h.c.h263_pred_motion(0, 0);
                for i in 0..2 {
                    let mx: i32 = self.h.decode_motion_checked(pred_x, f_code)?;
                    let my: i32 = self.h.decode_motion_checked(pred_y / 2, f_code)?;
                    self.h.c.mv[0][i] = [mx, my];
                }
            } else {
                self.h.c.mb_type[xy] = MB_TYPE_16X16 | MB_TYPE_FORWARD_MV;
                self.h.c.mv_type = MV_TYPE_16X16;
                let (pred_x, pred_y, _) = self.h.c.h263_pred_motion(0, 0);
                let mx: i32 = self.h.decode_motion_checked(pred_x, f_code)?;
                let my: i32 = self.h.decode_motion_checked(pred_y, f_code)?;
                self.h.c.mv[0][0] = [mx, my];
            }
        } else {
            self.h.c.mb_type[xy] = MB_TYPE_8X8 | MB_TYPE_FORWARD_MV;
            self.h.c.mv_type = MV_TYPE_8X8;
            for i in 0..4 {
                let (pred_x, pred_y, index) = self.h.c.h263_pred_motion(i, 0);
                let mx: i32 = self.h.decode_motion_checked(pred_x, f_code)?;
                let my: i32 = self.h.decode_motion_checked(pred_y, f_code)?;
                self.h.c.mv[0][i] = [mx, my];
                *self.h.c.motion_val(0, index) = [mx as i16, my as i16];
            }
        }
        Ok(Some(cbp))
    }

    /// The B part of mpeg4_decode_mb; Ok(None) for a skipped macroblock, else its coded block pattern.
    fn decode_b_mb(&mut self) -> DecodeResult<Option<u32>> {
        let xy: usize = self.h.c.mb_xy() as usize;
        self.h.c.mb_intra = false;
        self.h.c.mcsel = false;
        if self.h.c.mb_x == 0 {
            self.h.c.last_mv = [[[0; 2]; 2]; 2];
        }
        self.h.c.mb_skipped = self.anchor_skipped(xy);
        if self.h.c.mb_skipped {
            self.h.c.block_last_index = [-1; 6];
            self.h.c.mv_dir = MV_DIR_FORWARD;
            self.h.c.mv_type = MV_TYPE_16X16;
            self.h.c.mv[0][0] = [0, 0];
            self.h.c.mv[1][0] = [0, 0];
            self.h.c.mb_type[xy] = MB_TYPE_SKIP | MB_TYPE_16X16 | MB_TYPE_FORWARD_MV;
            return Ok(None);
        }
        let mut mb_type: u32;
        let cbp: u32;
        if self.h.gb.get_flag() {
            mb_type = MB_TYPE_DIRECT2 | MB_TYPE_SKIP | MB_TYPE_BIDIR_MV;
            cbp = 0;
        } else {
            let modb2: bool = self.h.gb.get_flag();
            let code: u32 = self.h.get_vlc(&Self::lookups().mb_type_b)?;
            mb_type = MB_TYPE_B_MAP[code as usize];
            if modb2 {
                cbp = 0;
            } else {
                self.h.c.clear_blocks();
                cbp = self.h.gb.get_bits(6);
            }
            if !is_direct(mb_type) && cbp != 0 && self.h.gb.get_flag() {
                let qscale: i32 = self.h.c.qscale + self.h.gb.get_bits1() as i32 * 4 - 2;
                self.h.c.set_qscale(qscale);
            }
            if !self.h.c.progressive_sequence {
                if cbp != 0 {
                    self.h.c.interlaced_dct = self.h.gb.get_flag();
                }
                if !is_direct(mb_type) && self.h.gb.get_flag() {
                    mb_type |= MB_TYPE_16X8 | MB_TYPE_INTERLACED;
                    mb_type &= !MB_TYPE_16X16;
                    if has_forward_mv(mb_type) {
                        self.h.c.field_select[0][0] = self.h.gb.get_bits1() as i32;
                        self.h.c.field_select[0][1] = self.h.gb.get_bits1() as i32;
                    }
                    if has_backward_mv(mb_type) {
                        self.h.c.field_select[1][0] = self.h.gb.get_bits1() as i32;
                        self.h.c.field_select[1][1] = self.h.gb.get_bits1() as i32;
                    }
                }
            }
            self.h.c.mv_dir = 0;
            let (f_code, b_code): (i32, i32) = (self.picture.f_code, self.picture.b_code);
            if mb_type & (MB_TYPE_DIRECT2 | MB_TYPE_INTERLACED) == 0 {
                self.h.c.mv_type = MV_TYPE_16X16;
                if has_forward_mv(mb_type) {
                    self.h.c.mv_dir = MV_DIR_FORWARD;
                    let mx: i32 = self.h.decode_motion(self.h.c.last_mv[0][0][0], f_code);
                    let my: i32 = self.h.decode_motion(self.h.c.last_mv[0][0][1], f_code);
                    self.h.c.last_mv[0][1] = [mx, my];
                    self.h.c.last_mv[0][0] = [mx, my];
                    self.h.c.mv[0][0] = [mx, my];
                }
                if has_backward_mv(mb_type) {
                    self.h.c.mv_dir |= MV_DIR_BACKWARD;
                    let mx: i32 = self.h.decode_motion(self.h.c.last_mv[1][0][0], b_code);
                    let my: i32 = self.h.decode_motion(self.h.c.last_mv[1][0][1], b_code);
                    self.h.c.last_mv[1][1] = [mx, my];
                    self.h.c.last_mv[1][0] = [mx, my];
                    self.h.c.mv[1][0] = [mx, my];
                }
            } else if !is_direct(mb_type) {
                self.h.c.mv_type = MV_TYPE_FIELD;
                if has_forward_mv(mb_type) {
                    self.h.c.mv_dir = MV_DIR_FORWARD;
                    for i in 0..2 {
                        let mx: i32 = self.h.decode_motion(self.h.c.last_mv[0][i][0], f_code);
                        let my: i32 = self.h.decode_motion(self.h.c.last_mv[0][i][1] / 2, f_code);
                        self.h.c.last_mv[0][i][0] = mx;
                        self.h.c.mv[0][i][0] = mx;
                        self.h.c.mv[0][i][1] = my;
                        self.h.c.last_mv[0][i][1] = my * 2;
                    }
                }
                if has_backward_mv(mb_type) {
                    self.h.c.mv_dir |= MV_DIR_BACKWARD;
                    for i in 0..2 {
                        let mx: i32 = self.h.decode_motion(self.h.c.last_mv[1][i][0], b_code);
                        let my: i32 = self.h.decode_motion(self.h.c.last_mv[1][i][1] / 2, b_code);
                        self.h.c.last_mv[1][i][0] = mx;
                        self.h.c.mv[1][i][0] = mx;
                        self.h.c.mv[1][i][1] = my;
                        self.h.c.last_mv[1][i][1] = my * 2;
                    }
                }
            }
        }
        if is_direct(mb_type) {
            let (mx, my): (i32, i32) =
                if is_skip(mb_type) { (0, 0) } else { (self.h.decode_motion(0, 1), self.h.decode_motion(0, 1)) };
            self.h.c.mv_dir = MV_DIR_FORWARD | MV_DIR_BACKWARD | MV_DIRECT;
            mb_type |= self.set_direct_mv(mx, my);
        }
        self.h.c.mb_type[xy] = mb_type;
        Ok(Some(cbp))
    }

    /// mpeg4_decode_mb.
    fn decode_mb_unpartitioned(&mut self) -> DecodeResult<SliceStatus> {
        let xy: usize = self.h.c.mb_xy() as usize;
        let cbp: Option<u32> = match self.h.c.pict_type {
            PictType::P | PictType::S => self.decode_p_mb()?,
            PictType::B => self.decode_b_mb()?,
            PictType::I => {
                let cbpc: u32 = loop {
                    let cbpc: u32 = self.h.get_vlc(&h263_lookups().intra_mcbpc)?;
                    if cbpc != 8 {
                        break cbpc;
                    }
                };
                self.h.c.mb_intra = true;
                self.decode_intra_mb(cbpc, cbpc & 4 != 0)?;
                Some(u32::MAX)
            }
        };
        // u32::MAX marks an intra macroblock, whose blocks decoded already
        if let Some(mut cbp) = cbp
            && cbp != u32::MAX
        {
            for i in 0..6 {
                self.decode_block(i, cbp & 32 != 0, false, false, false)?;
                cbp += cbp;
            }
        }
        let next: i32 = self.is_resync();
        if next != 0 {
            let c = &self.h.c;
            if c.mb_x + c.mb_y * c.mb_width + 1 >= next {
                return Ok(SliceStatus::End);
            }
            if c.pict_type == PictType::B {
                let delta: usize = if c.mb_x + 1 == c.mb_width { 2 } else { 1 };
                if self.anchor_skipped(xy + delta) {
                    return Ok(SliceStatus::Ok);
                }
            }
            return Ok(SliceStatus::End);
        }
        Ok(SliceStatus::Ok)
    }
}

impl<'a> MacroblockLayer<'a> for Mpeg4Decoder<'a> {
    fn h(&mut self) -> &mut H263Context<'a> {
        &mut self.h
    }

    fn decode_mb(&mut self) -> DecodeResult<SliceStatus> {
        if self.h.partitioned_frame { self.decode_partitioned_mb() } else { self.decode_mb_unpartitioned() }
    }

    fn decode_resync_header(&mut self) -> DecodeResult<bool> {
        self.decode_video_packet_header()
    }

    fn resync_aligns(&self) -> bool {
        true
    }

    /// ff_mpeg4_decode_partitions: the first and second partitions of a video packet, between their markers.
    fn decode_partitions(&mut self) -> DecodeResult<()> {
        let mb_num: i32 = self.decode_partition_a()?;
        if mb_num <= 0 {
            return macroblock_failure(&self.h.c, INVALID_CODE);
        }
        let c = &self.h.c;
        if c.resync_mb_x + c.resync_mb_y * c.mb_width + mb_num > c.mb_num {
            return macroblock_failure(&self.h.c, INVALID_CODE);
        }
        self.h.mb_num_left = mb_num;
        if self.h.c.pict_type == PictType::I {
            while self.h.gb.show_bits(9) == 1 {
                self.h.gb.skip_bits(9);
            }
            if self.h.gb.get_bits(19) != DC_MARKER {
                return macroblock_failure(&self.h.c, INVALID_CODE);
            }
        } else {
            while self.h.gb.show_bits(10) == 1 {
                self.h.gb.skip_bits(10);
            }
            if self.h.gb.get_bits(17) != MOTION_MARKER {
                return macroblock_failure(&self.h.c, INVALID_CODE);
            }
        }
        self.decode_partition_b(mb_num)
    }
}
