// Motion compensation operations: each inter macroblock's prediction as the sequence of FFmpeg pixel operations mpegvideo_motion.c and
// mpeg4videodec.c's gmc1_motion and gmc_motion run, with the source positions, fractions, and clips they compute. The WGSL runs each
// operation as FFmpeg's operation would, reading reference samples clamped to the edge positions, which FFmpeg's emulated edges extend.

use crate::layout::{
    OP_AVERAGE, OP_BACKWARD, OP_CHROMA, OP_DEST_BOTTOM, OP_DEST_X8, OP_DEST_Y8, OP_DXY_SHIFT,
    OP_FIELD, OP_GMC, OP_GMC1, OP_HEIGHT_SHIFT, OP_HPEL, OP_NO_ROUNDING, OP_OBMC, OP_QPEL,
    OP_SOURCE_BOTTOM, OP_WIDE,
};
use crate::mpv::{
    FF_BUG_HPEL_CHROMA, FF_BUG_QPEL_CHROMA, FF_BUG_QPEL_CHROMA2, MV_DIR_BACKWARD, MV_DIR_FORWARD, MV_TYPE_8X8, MV_TYPE_FIELD, MV_TYPE_16X16,
    MacroblockRecord, Mpv, PictType, is_intra,
};

/// An MPEG-4 S(GMC)-VOP's warp, as mpeg4_decode_sprite_trajectory leaves it in Mpeg4DecContext.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SpriteWarp {
    pub real_sprite_warping_points: i32,
    pub sprite_warping_accuracy: i32,
    pub sprite_offset: [[i32; 2]; 2],
    pub sprite_delta: [[i32; 2]; 2],
}

/// What a picture's operations depend on beyond each macroblock.
#[derive(Clone, Copy, Debug, Default)]
pub struct MotionContext {
    pub pict_type: PictType,
    pub width: i32,
    pub height: i32,
    pub no_rounding: bool,
    pub quarter_sample: bool,
    pub obmc: bool,
    pub workaround_bugs: u32,
    pub sprite: SpriteWarp,
}

/// FFmpeg's ff_h263_round_chroma.
pub fn h263_round_chroma(x: i32) -> i32 {
    const ROUND_TABLE: [i32; 16] = [0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1];
    ROUND_TABLE[(x & 0xF) as usize] + (x >> 3)
}

fn position_word(x: i32, y: i32) -> u32 {
    (x as u16 as u32) | ((y as u16 as u32) << 16)
}

/// The pixel operation FFmpeg's op_pix or op_qpix stands for: put, put_no_rnd, or avg, and which reference it reads.
#[derive(Clone, Copy)]
struct PixelOperation {
    /// OP_BACKWARD, OP_AVERAGE, and OP_NO_ROUNDING bits
    flags: u32,
}

/// Where an operation's block lies within the macroblock: its width, its lines, and its field and offset bits.
#[derive(Clone, Copy, Default)]
struct BlockPlacement {
    wide: bool,
    height: u32,
    field: bool,
    dest_bottom: bool,
    source_bottom: bool,
    dest_x8: bool,
    dest_y8: bool,
}

impl BlockPlacement {
    fn bits(self) -> u32 {
        let mut bits: u32 = self.height << OP_HEIGHT_SHIFT;
        for (set, bit) in [
            (self.wide, OP_WIDE),
            (self.field, OP_FIELD),
            (self.dest_bottom, OP_DEST_BOTTOM),
            (self.source_bottom, OP_SOURCE_BOTTOM),
            (self.dest_x8, OP_DEST_X8),
            (self.dest_y8, OP_DEST_Y8),
        ] {
            if set {
                bits |= bit;
            }
        }
        bits
    }
}

/// Writes one macroblock's operations.
pub struct OperationWriter<'a> {
    context: &'a MotionContext,
    mpv: &'a Mpv,
    record: &'a MacroblockRecord,
    words: Vec<u32>,
    count: u32,
}

impl<'a> OperationWriter<'a> {
    fn push(&mut self, kind: u32, chroma: bool, operation: PixelOperation, dxy: i32, placement: BlockPlacement, data: &[u32]) {
        let mut word: u32 = kind | operation.flags | ((dxy as u32) << OP_DXY_SHIFT) | placement.bits();
        if chroma {
            word |= OP_CHROMA;
        }
        self.words.push(word);
        self.words.extend_from_slice(data);
        self.count += 1;
    }

    /// mpeg_motion_internal of the H.263 output format: a 16x16 block, or one field's 16x8 lines.
    fn mpeg_motion(&mut self, operation: PixelOperation, field_based: bool, bottom_field: bool, field_select: bool, motion_x: i32, motion_y: i32) {
        let mb_x: i32 = self.record.mb_x;
        let mb_y: i32 = self.record.mb_y;
        let block_y_half: i32 = i32::from(field_based);
        let h: u32 = if field_based { 8 } else { 16 };
        let dxy: i32 = ((motion_y & 1) << 1) | (motion_x & 1);
        let src_x: i32 = mb_x * 16 + (motion_x >> 1);
        let src_y: i32 = (mb_y << (4 - block_y_half)) + (motion_y >> 1);
        let (uvdxy, uvsrc_x, uvsrc_y): (i32, i32, i32) = if self.context.workaround_bugs & FF_BUG_HPEL_CHROMA != 0 && field_based {
            let mx: i32 = (motion_x >> 1) | (motion_x & 1);
            let my: i32 = motion_y >> 1;
            (((my & 1) << 1) | (mx & 1), mb_x * 8 + (mx >> 1), (mb_y << (3 - block_y_half)) + (my >> 1))
        } else {
            (dxy | (motion_y & 2) | ((motion_x & 2) >> 1), src_x >> 1, src_y >> 1)
        };
        let placement: BlockPlacement =
            BlockPlacement { wide: true, height: h, field: field_based, dest_bottom: bottom_field, source_bottom: field_select, ..BlockPlacement::default() };
        self.push(OP_HPEL, false, operation, dxy, placement, &[position_word(src_x, src_y)]);
        let chroma: BlockPlacement = BlockPlacement { wide: false, height: h >> 1, ..placement };
        self.push(OP_HPEL, true, operation, uvdxy, chroma, &[position_word(uvsrc_x, uvsrc_y)]);
    }

    /// hpel_motion's clipped source position and dxy of an 8x8 luma block.
    fn hpel_position(&self, src_x: i32, src_y: i32, motion_x: i32, motion_y: i32) -> (i32, i32, i32) {
        let mut dxy: i32 = 0;
        let mut src_x: i32 = src_x + (motion_x >> 1);
        let mut src_y: i32 = src_y + (motion_y >> 1);
        src_x = src_x.clamp(-16, self.context.width);
        if src_x != self.context.width {
            dxy |= motion_x & 1;
        }
        src_y = src_y.clamp(-16, self.context.height);
        if src_y != self.context.height {
            dxy |= (motion_y & 1) << 1;
        }
        (src_x, src_y, dxy)
    }

    /// chroma_4mv_motion: both chroma blocks from the sum of the luma vectors.
    fn chroma_4mv_motion(&mut self, operation: PixelOperation, mx: i32, my: i32) {
        let mx: i32 = h263_round_chroma(mx);
        let my: i32 = h263_round_chroma(my);
        let mut dxy: i32 = ((my & 1) << 1) | (mx & 1);
        let mut src_x: i32 = self.record.mb_x * 8 + (mx >> 1);
        let mut src_y: i32 = self.record.mb_y * 8 + (my >> 1);
        src_x = src_x.clamp(-8, self.context.width >> 1);
        if src_x == self.context.width >> 1 {
            dxy &= !1;
        }
        src_y = src_y.clamp(-8, self.context.height >> 1);
        if src_y == self.context.height >> 1 {
            dxy &= !2;
        }
        let placement: BlockPlacement = BlockPlacement { height: 8, ..BlockPlacement::default() };
        self.push(OP_HPEL, true, operation, dxy, placement, &[position_word(src_x, src_y)]);
    }

    /// qpel_motion: a 16x16 block, or one field's lines as two 8x8 blocks.
    fn qpel_motion(&mut self, operation: PixelOperation, field_based: bool, bottom_field: bool, field_select: bool, motion_x: i32, motion_y: i32) {
        let mb_x: i32 = self.record.mb_x;
        let mb_y: i32 = self.record.mb_y;
        let h: u32 = if field_based { 8 } else { 16 };
        let dxy: i32 = ((motion_y & 3) << 2) | (motion_x & 3);
        let src_x: i32 = mb_x * 16 + (motion_x >> 2);
        let src_y: i32 = mb_y * (16 >> i32::from(field_based)) + (motion_y >> 2);
        let bugs: u32 = self.context.workaround_bugs;
        let (mut mx, mut my): (i32, i32) = if field_based {
            (motion_x / 2, motion_y >> 1)
        } else if bugs & FF_BUG_QPEL_CHROMA2 != 0 {
            const ROUND_TABLE: [i32; 8] = [0, 0, 1, 1, 0, 0, 0, 1];
            ((motion_x >> 1) + ROUND_TABLE[(motion_x & 7) as usize], (motion_y >> 1) + ROUND_TABLE[(motion_y & 7) as usize])
        } else if bugs & FF_BUG_QPEL_CHROMA != 0 {
            ((motion_x >> 1) | (motion_x & 1), (motion_y >> 1) | (motion_y & 1))
        } else {
            (motion_x / 2, motion_y / 2)
        };
        mx = (mx >> 1) | (mx & 1);
        my = (my >> 1) | (my & 1);
        let uvdxy: i32 = (mx & 1) | ((my & 1) << 1);
        mx >>= 1;
        my >>= 1;
        let uvsrc_x: i32 = mb_x * 8 + mx;
        let uvsrc_y: i32 = mb_y * (8 >> i32::from(field_based)) + my;
        if field_based {
            let placement: BlockPlacement =
                BlockPlacement { wide: false, height: h, field: true, dest_bottom: bottom_field, source_bottom: field_select, ..BlockPlacement::default() };
            self.push(OP_QPEL, false, operation, dxy, placement, &[position_word(src_x, src_y)]);
            self.push(OP_QPEL, false, operation, dxy, BlockPlacement { dest_x8: true, ..placement }, &[position_word(src_x + 8, src_y)]);
        } else {
            let placement: BlockPlacement = BlockPlacement { wide: true, height: h, ..BlockPlacement::default() };
            self.push(OP_QPEL, false, operation, dxy, placement, &[position_word(src_x, src_y)]);
        }
        // The chroma operation is a half-sample one, put or avg as the luma's is
        let chroma: BlockPlacement =
            BlockPlacement { wide: false, height: h >> 1, field: field_based, dest_bottom: bottom_field, source_bottom: field_select, ..BlockPlacement::default() };
        self.push(OP_HPEL, true, operation, uvdxy, chroma, &[position_word(uvsrc_x, uvsrc_y)]);
    }

    /// apply_8x8: four 8x8 luma blocks and the chroma of their summed vectors.
    fn apply_8x8(&mut self, operation: PixelOperation, dir: usize) {
        let mb_x: i32 = self.record.mb_x;
        let mb_y: i32 = self.record.mb_y;
        let mut mx: i32 = 0;
        let mut my: i32 = 0;
        for i in 0..4 {
            let motion_x: i32 = self.record.mv[dir][i][0];
            let motion_y: i32 = self.record.mv[dir][i][1];
            let placement: BlockPlacement = BlockPlacement { height: 8, dest_x8: i & 1 != 0, dest_y8: i >> 1 != 0, ..BlockPlacement::default() };
            if self.context.quarter_sample {
                let mut dxy: i32 = ((motion_y & 3) << 2) | (motion_x & 3);
                let mut src_x: i32 = mb_x * 16 + (motion_x >> 2) + (i as i32 & 1) * 8;
                let mut src_y: i32 = mb_y * 16 + (motion_y >> 2) + (i as i32 >> 1) * 8;
                src_x = src_x.clamp(-16, self.context.width);
                if src_x == self.context.width {
                    dxy &= !3;
                }
                src_y = src_y.clamp(-16, self.context.height);
                if src_y == self.context.height {
                    dxy &= !12;
                }
                self.push(OP_QPEL, false, operation, dxy, placement, &[position_word(src_x, src_y)]);
                mx += motion_x / 2;
                my += motion_y / 2;
            } else {
                let (src_x, src_y, dxy) = self.hpel_position(mb_x * 16 + (i as i32 & 1) * 8, mb_y * 16 + (i as i32 >> 1) * 8, motion_x, motion_y);
                self.push(OP_HPEL, false, operation, dxy, placement, &[position_word(src_x, src_y)]);
                mx += motion_x;
                my += motion_y;
            }
        }
        self.chroma_4mv_motion(operation, mx, my);
    }

    /// apply_obmc: each 8x8 luma block overlapped from its own, top, left, right, and bottom vectors, then the chroma of the four.
    fn apply_obmc(&mut self, operation: PixelOperation) {
        let mpv: &Mpv = self.mpv;
        let mb_x: i32 = self.record.mb_x;
        let mb_y: i32 = self.record.mb_y;
        let xy: i32 = mb_x + mb_y * mpv.mb_stride;
        let mot_stride: i32 = mpv.b8_stride;
        let mot_xy: i32 = mb_x * 2 + mb_y * 2 * mot_stride;
        let motion = |index: i32| -> [i32; 2] {
            let value: [i16; 2] = mpv.get_motion_val(0, index);
            [i32::from(value[0]), i32::from(value[1])]
        };
        let mut cache: [[[i32; 2]; 4]; 4] = [[[0; 2]; 4]; 4];
        // The macroblock's own vectors, as motion_val held them when it reconstructed: a later slice's prediction may zero its lower
        // right entry (ff_h263_pred_motion at a slice's first macroblock), which the final table keeps
        let own = |i: usize| -> [i32; 2] {
            let vector: [i32; 2] = if self.record.mv_type == MV_TYPE_8X8 { self.record.mv[0][i] } else { self.record.mv[0][0] };
            [i32::from(vector[0] as i16), i32::from(vector[1] as i16)]
        };
        cache[1][1] = own(0);
        cache[1][2] = own(1);
        cache[2][1] = own(2);
        cache[2][2] = own(3);
        cache[3][1] = own(2);
        cache[3][2] = own(3);
        if mb_y == 0 || is_intra(mpv.mb_type[(xy - mpv.mb_stride) as usize]) {
            cache[0][1] = cache[1][1];
            cache[0][2] = cache[1][2];
        } else {
            cache[0][1] = motion(mot_xy - mot_stride);
            cache[0][2] = motion(mot_xy - mot_stride + 1);
        }
        if mb_x == 0 || is_intra(mpv.mb_type[(xy - 1) as usize]) {
            cache[1][0] = cache[1][1];
            cache[2][0] = cache[2][1];
        } else {
            cache[1][0] = motion(mot_xy - 1);
            cache[2][0] = motion(mot_xy - 1 + mot_stride);
        }
        match self.record.obmc_right {
            Some([top, bottom]) => {
                cache[1][3] = [i32::from(top[0]), i32::from(top[1])];
                cache[2][3] = [i32::from(bottom[0]), i32::from(bottom[1])];
            }
            None => {
                cache[1][3] = cache[1][2];
                cache[2][3] = cache[2][2];
            }
        }
        let mut mx: i32 = 0;
        let mut my: i32 = 0;
        for i in 0..4usize {
            let x: usize = (i & 1) + 1;
            let y: usize = (i >> 1) + 1;
            let vectors: [[i32; 2]; 5] = [cache[y][x], cache[y - 1][x], cache[y][x - 1], cache[y][x + 1], cache[y + 1][x]];
            let base_x: i32 = mb_x * 16 + (i as i32 & 1) * 8;
            let base_y: i32 = mb_y * 16 + (i as i32 >> 1) * 8;
            let mut dxys: u32 = 0;
            let mut positions: [u32; 6] = [0; 6];
            for (index, vector) in vectors.iter().enumerate() {
                let (src_x, src_y, dxy) = self.hpel_position(base_x, base_y, vector[0], vector[1]);
                dxys |= (dxy as u32) << (2 * index);
                positions[index + 1] = position_word(src_x, src_y);
            }
            positions[0] = dxys;
            let placement: BlockPlacement = BlockPlacement { height: 8, dest_x8: i & 1 != 0, dest_y8: i >> 1 != 0, ..BlockPlacement::default() };
            self.push(OP_OBMC, false, operation, 0, placement, &positions);
            mx += vectors[0][0];
            my += vectors[0][1];
        }
        self.chroma_4mv_motion(operation, mx, my);
    }

    /// ff_mpeg4_mcsel_motion: gmc1_motion for one warping point, gmc_motion for two or three.
    fn mcsel_motion(&mut self) {
        let sprite: SpriteWarp = self.context.sprite;
        let mb_x: i32 = self.record.mb_x;
        let mb_y: i32 = self.record.mb_y;
        let no_rounding: bool = self.context.no_rounding;
        let rounding: PixelOperation = PixelOperation { flags: if no_rounding { OP_NO_ROUNDING } else { 0 } };
        let accuracy: i32 = sprite.sprite_warping_accuracy;
        let width: i32 = self.context.width;
        let height: i32 = self.context.height;
        if sprite.real_sprite_warping_points == 1 {
            let mut motion_x: i32 = sprite.sprite_offset[0][0];
            let mut motion_y: i32 = sprite.sprite_offset[0][1];
            let mut src_x: i32 = mb_x * 16 + (motion_x >> (accuracy + 1));
            let mut src_y: i32 = mb_y * 16 + (motion_y >> (accuracy + 1));
            motion_x *= 1 << (3 - accuracy);
            motion_y *= 1 << (3 - accuracy);
            src_x = src_x.clamp(-16, width);
            if src_x == width {
                motion_x = 0;
            }
            src_y = src_y.clamp(-16, height);
            if src_y == height {
                motion_y = 0;
            }
            let luma: BlockPlacement = BlockPlacement { wide: true, height: 16, ..BlockPlacement::default() };
            if (motion_x | motion_y) & 7 != 0 {
                let fractions: u32 = (motion_x & 15) as u32 | (((motion_y & 15) as u32) << 8);
                self.push(OP_GMC1, false, rounding, 0, luma, &[position_word(src_x, src_y), fractions]);
            } else {
                let dxy: i32 = ((motion_x >> 3) & 1) | ((motion_y >> 2) & 2);
                self.push(OP_HPEL, false, rounding, dxy, luma, &[position_word(src_x, src_y)]);
            }
            let mut motion_x: i32 = sprite.sprite_offset[1][0];
            let mut motion_y: i32 = sprite.sprite_offset[1][1];
            let mut src_x: i32 = mb_x * 8 + (motion_x >> (accuracy + 1));
            let mut src_y: i32 = mb_y * 8 + (motion_y >> (accuracy + 1));
            motion_x *= 1 << (3 - accuracy);
            motion_y *= 1 << (3 - accuracy);
            src_x = src_x.clamp(-8, width >> 1);
            if src_x == width >> 1 {
                motion_x = 0;
            }
            src_y = src_y.clamp(-8, height >> 1);
            if src_y == height >> 1 {
                motion_y = 0;
            }
            let fractions: u32 = (motion_x & 15) as u32 | (((motion_y & 15) as u32) << 8);
            let chroma: BlockPlacement = BlockPlacement { height: 8, ..BlockPlacement::default() };
            self.push(OP_GMC1, true, rounding, 0, chroma, &[position_word(src_x, src_y), fractions]);
        } else {
            let delta: [[i32; 2]; 2] = sprite.sprite_delta;
            let ox: i32 = sprite.sprite_offset[0][0].wrapping_add(delta[0][0].wrapping_mul(mb_x * 16)).wrapping_add(delta[0][1].wrapping_mul(mb_y * 16));
            let oy: i32 = sprite.sprite_offset[0][1].wrapping_add(delta[1][0].wrapping_mul(mb_x * 16)).wrapping_add(delta[1][1].wrapping_mul(mb_y * 16));
            let luma: BlockPlacement = BlockPlacement { wide: true, height: 16, ..BlockPlacement::default() };
            self.push(OP_GMC, false, rounding, 0, luma, &[ox as u32, oy as u32]);
            let ox: i32 = sprite.sprite_offset[1][0].wrapping_add(delta[0][0].wrapping_mul(mb_x * 8)).wrapping_add(delta[0][1].wrapping_mul(mb_y * 8));
            let oy: i32 = sprite.sprite_offset[1][1].wrapping_add(delta[1][0].wrapping_mul(mb_x * 8)).wrapping_add(delta[1][1].wrapping_mul(mb_y * 8));
            let chroma: BlockPlacement = BlockPlacement { height: 8, ..BlockPlacement::default() };
            self.push(OP_GMC, true, rounding, 0, chroma, &[ox as u32, oy as u32]);
        }
    }

    /// mpv_motion_internal of one direction.
    fn motion(&mut self, dir: usize, operation: PixelOperation) {
        let record: &MacroblockRecord = self.record;
        if self.context.obmc && self.context.pict_type != PictType::B {
            self.apply_obmc(operation);
            return;
        }
        match record.mv_type {
            MV_TYPE_16X16 => {
                if record.mcsel {
                    self.mcsel_motion();
                } else if self.context.quarter_sample {
                    self.qpel_motion(operation, false, false, false, record.mv[dir][0][0], record.mv[dir][0][1]);
                } else {
                    self.mpeg_motion(operation, false, false, false, record.mv[dir][0][0], record.mv[dir][0][1]);
                }
            }
            MV_TYPE_8X8 => self.apply_8x8(operation, dir),
            MV_TYPE_FIELD => {
                for i in 0..2 {
                    let field_select: bool = record.field_select[dir][i] != 0;
                    let (motion_x, motion_y): (i32, i32) = (record.mv[dir][i][0], record.mv[dir][i][1]);
                    if self.context.quarter_sample {
                        self.qpel_motion(operation, true, i == 1, field_select, motion_x, motion_y);
                    } else {
                        self.mpeg_motion(operation, true, i == 1, field_select, motion_x, motion_y);
                    }
                }
            }
            _ => {}
        }
    }
}

/// The operations of an inter macroblock, in the order mpv_reconstruct_mb_internal runs them, and their count; an intra macroblock has
/// none. `mpv` holds the picture's final tables, which OBMC reads.
pub fn macroblock_operations(context: &MotionContext, mpv: &Mpv, record: &MacroblockRecord) -> (Vec<u32>, u32) {
    let mut writer: OperationWriter = OperationWriter { context, mpv, record, words: Vec::new(), count: 0 };
    if record.mb_intra {
        return (writer.words, 0);
    }
    let put: u32 = if !context.no_rounding || context.pict_type == PictType::B { 0 } else { OP_NO_ROUNDING };
    let mut operation: PixelOperation = PixelOperation { flags: put };
    if record.mv_dir & MV_DIR_FORWARD != 0 {
        writer.motion(0, operation);
        operation = PixelOperation { flags: OP_AVERAGE };
    }
    if record.mv_dir & MV_DIR_BACKWARD != 0 {
        writer.motion(1, PixelOperation { flags: operation.flags | OP_BACKWARD });
    }
    let count: u32 = writer.count;
    (writer.words, count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mpv::Codec;

    fn inter_record(mb_x: i32, mb_y: i32, mv: [i32; 2]) -> MacroblockRecord {
        let mut record: MacroblockRecord = MacroblockRecord { mb_x, mb_y, mv_dir: MV_DIR_FORWARD, mv_type: MV_TYPE_16X16, ..MacroblockRecord::default() };
        record.mv[0][0] = mv;
        record
    }

    #[test]
    fn rounds_chroma_as_ffmpeg_does() {
        assert_eq!(h263_round_chroma(0), 0);
        assert_eq!(h263_round_chroma(3), 1);
        assert_eq!(h263_round_chroma(8), 1);
        assert_eq!(h263_round_chroma(-3), -1);
        assert_eq!(h263_round_chroma(-1), 0);
    }

    #[test]
    fn puts_a_half_sample_macroblock_and_its_chroma() {
        let mpv: Mpv = Mpv::new(Codec::H263, 64, 64);
        let context: MotionContext = MotionContext { pict_type: PictType::P, width: 64, height: 64, ..MotionContext::default() };
        // A vector of (3, -5) half samples at macroblock (1, 2): luma from (17, 29) with both halves, chroma rounded to odd halves
        let (words, count) = macroblock_operations(&context, &mpv, &inter_record(1, 2, [3, -5]));
        assert_eq!(count, 2);
        assert_eq!(words[0], OP_HPEL | (3 << OP_DXY_SHIFT) | OP_WIDE | (16 << OP_HEIGHT_SHIFT));
        assert_eq!(words[1], position_word(17, 29));
        // uvdxy = dxy | (motion_y & 2) | ((motion_x & 2) >> 1) = 3, from (8, 14)
        assert_eq!(words[2], OP_HPEL | OP_CHROMA | (3 << OP_DXY_SHIFT) | (8 << OP_HEIGHT_SHIFT));
        assert_eq!(words[3], position_word(8, 14));
    }

    #[test]
    fn averages_the_backward_prediction_of_a_bidirectional_macroblock() {
        let mpv: Mpv = Mpv::new(Codec::Mpeg4, 64, 64);
        let context: MotionContext = MotionContext { pict_type: PictType::B, width: 64, height: 64, no_rounding: true, ..MotionContext::default() };
        let mut record: MacroblockRecord = inter_record(0, 0, [0, 0]);
        record.mv_dir = MV_DIR_FORWARD | MV_DIR_BACKWARD;
        let (words, count) = macroblock_operations(&context, &mpv, &record);
        assert_eq!(count, 4);
        assert_eq!(words[0] & (OP_NO_ROUNDING | OP_AVERAGE | OP_BACKWARD), 0);
        assert_eq!(words[4] & (OP_AVERAGE | OP_BACKWARD), OP_AVERAGE | OP_BACKWARD);
    }

    #[test]
    fn overlaps_the_right_neighbor_vectors_the_record_kept() {
        let mpv: Mpv = Mpv::new(Codec::H263, 64, 64);
        let context: MotionContext = MotionContext { pict_type: PictType::P, width: 64, height: 64, obmc: true, ..MotionContext::default() };
        // Each of the four blocks is an operation word, the dxys word, then its own, top, left, right, and bottom positions
        const BLOCK_WORDS: usize = 7;
        const RIGHT: usize = 5;
        let mut record: MacroblockRecord = inter_record(0, 0, [0, 0]);
        record.obmc_right = Some([[4, 2], [6, 0]]);
        let (words, count) = macroblock_operations(&context, &mpv, &record);
        assert_eq!(count, 5);
        // Block 1 reads the upper vector at (8, 0) + (2, 1), block 3 the lower one at (8, 8) + (3, 0)
        assert_eq!(words[BLOCK_WORDS + RIGHT], position_word(10, 1));
        assert_eq!(words[3 * BLOCK_WORDS + RIGHT], position_word(11, 8));
        // Without a kept neighbor the right blocks read the macroblock's own vectors
        record.obmc_right = None;
        let (words, _) = macroblock_operations(&context, &mpv, &record);
        assert_eq!(words[BLOCK_WORDS + RIGHT], position_word(8, 0));
        assert_eq!(words[3 * BLOCK_WORDS + RIGHT], position_word(8, 8));
    }
}
