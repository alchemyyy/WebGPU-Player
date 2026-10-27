// The GPU record of a picture, as mpeg4.wgsl reads it: the header, the macroblock offset table, and each macroblock's flags,
// deblocking quantizers, motion compensation operations, and coefficient entries.

use crate::error::{self, DecodeResult};
use crate::layout::{
    ERROR_RECORD_INVALID, ENTRY_BLOCK_SHIFT, ENTRY_POSITION_SHIFT, FLAG_RESET_ANCHORS, HEADER_EDGE_HEIGHT,
    HEADER_EDGE_WIDTH, HEADER_FLAGS, HEADER_GMC_ACCURACY, HEADER_GMC_DXX, HEADER_GMC_DXY, HEADER_GMC_DYX,
    HEADER_GMC_DYY, HEADER_IDCT, HEADER_LOOP_FILTER, HEADER_MACROBLOCKS, HEADER_MAGIC, HEADER_MB_HEIGHT,
    HEADER_MB_WIDTH, HEADER_MISSING_REFERENCE_LUMA, HEADER_NO_ROUNDING, HEADER_PICTURE_TYPE, HEADER_VERSION,
    HEADER_WORDS, IDCT_SIMPLE, IDCT_XVID, LOOP_FILTER_INNER_SHIFT, LOOP_FILTER_LEFT_CHROMA_SHIFT,
    LOOP_FILTER_LEFT_SHIFT, LOOP_FILTER_TOP_CHROMA_SHIFT, LOOP_FILTER_TOP_SHIFT, MAGIC, MAXIMUM_MACROBLOCKS,
    MB_DENSE_SHIFT, MB_ENTRY_COUNT_SHIFT, MB_INTERLACED_DCT, MB_INTRA, MB_OPERATION_COUNT_MASK, MB_OPERATION_COUNT_SHIFT,
    MB_RESIDUAL_SHIFT, DENSE_BLOCK_ENTRIES, TYPE_B, TYPE_I, TYPE_P, TYPE_S, VERSION,
};
use crate::motion::{MotionContext, macroblock_operations};
use crate::mpv::{MacroblockRecord, Mpv, PictType, is_skip};

// The record check failure values of the parser: a picture of more macroblocks than a record holds, a macroblock with too many
// operations, or a picture whose macroblock layer left macroblocks undecoded
pub const TOO_MANY_MACROBLOCKS: u32 = 1;
pub const TOO_MANY_OPERATIONS: u32 = 2;
pub const MACROBLOCKS_MISSING: u32 = 3;

/// The picture-level facts of a record beyond the macroblocks and the motion context.
#[derive(Clone, Copy, Debug, Default)]
pub struct RecordHeader {
    /// FFmpeg switched to the Xvid IDCT for this stream
    pub xvid_idct: bool,
    /// H.263's Annex J deblocking filter is on
    pub loop_filter: bool,
    /// The parser dropped its references before this picture
    pub reset_anchors: bool,
    /// The luma of a missing reference's dummy frame
    pub missing_reference_luma: u32,
}

fn picture_type_word(pict_type: PictType) -> u32 {
    match pict_type {
        PictType::I => TYPE_I,
        PictType::P => TYPE_P,
        PictType::B => TYPE_B,
        PictType::S => TYPE_S,
    }
}

/// ff_h263_loop_filter's quantizers of a macroblock's edges: the inner ones, the top edge's, and the left edge's, each with its chroma
/// quantizer; 0 leaves an edge.
fn loop_filter_word(mpv: &Mpv, mb_x: i32, mb_y: i32) -> u32 {
    let xy: usize = (mb_x + mb_y * mpv.mb_stride) as usize;
    let quantizer = |index: usize| -> u32 { if is_skip(mpv.mb_type[index]) { 0 } else { mpv.qscale_table[index] as u32 } };
    let chroma = |qp: u32| -> u32 { if qp == 0 { 0 } else { u32::from(mpv.chroma_qscale_table[qp as usize]) } };
    let qp_c: u32 = quantizer(xy);
    let mut word: u32 = qp_c << LOOP_FILTER_INNER_SHIFT;
    if mb_y > 0 {
        let qp_tt: u32 = quantizer(xy - mpv.mb_stride as usize);
        let qp_tc: u32 = if qp_c != 0 { qp_c } else { qp_tt };
        word |= (qp_tc << LOOP_FILTER_TOP_SHIFT) | (chroma(qp_tc) << LOOP_FILTER_TOP_CHROMA_SHIFT);
    }
    if mb_x > 0 {
        let qp_lc: u32 = if qp_c != 0 || is_skip(mpv.mb_type[xy - 1]) { qp_c } else { mpv.qscale_table[xy - 1] as u32 };
        word |= (qp_lc << LOOP_FILTER_LEFT_SHIFT) | (chroma(qp_lc) << LOOP_FILTER_LEFT_CHROMA_SHIFT);
    }
    word
}

/// Writes a picture's record into words: every macroblock of the picture must have a record, in any order, the last one of a position
/// winning.
pub fn write_record(mpv: &Mpv, motion: &MotionContext, header: &RecordHeader, words: &mut Vec<u32>) -> DecodeResult<()> {
    let mb_count: usize = (mpv.mb_width * mpv.mb_height) as usize;
    if mb_count > MAXIMUM_MACROBLOCKS as usize {
        return error::fail(ERROR_RECORD_INVALID, TOO_MANY_MACROBLOCKS);
    }
    let mut by_position: Vec<Option<&MacroblockRecord>> = vec![None; mb_count];
    for record in &mpv.records {
        let index: usize = (record.mb_x + record.mb_y * mpv.mb_width) as usize;
        if index < mb_count {
            by_position[index] = Some(record);
        }
    }
    words.clear();
    words.resize(HEADER_WORDS as usize, 0);
    let set = |words: &mut Vec<u32>, field: u32, value: u32| words[field as usize] = value;
    set(words, HEADER_MAGIC, MAGIC);
    set(words, HEADER_VERSION, VERSION);
    set(words, HEADER_PICTURE_TYPE, picture_type_word(motion.pict_type));
    set(words, HEADER_MB_WIDTH, mpv.mb_width as u32);
    set(words, HEADER_MB_HEIGHT, mpv.mb_height as u32);
    set(words, HEADER_EDGE_WIDTH, mpv.h_edge_pos as u32);
    set(words, HEADER_EDGE_HEIGHT, mpv.v_edge_pos as u32);
    set(words, HEADER_IDCT, if header.xvid_idct { IDCT_XVID } else { IDCT_SIMPLE });
    set(words, HEADER_LOOP_FILTER, u32::from(header.loop_filter));
    set(words, HEADER_NO_ROUNDING, u32::from(motion.no_rounding));
    set(words, HEADER_GMC_ACCURACY, motion.sprite.sprite_warping_accuracy as u32);
    set(words, HEADER_GMC_DXX, motion.sprite.sprite_delta[0][0] as u32);
    set(words, HEADER_GMC_DXY, motion.sprite.sprite_delta[0][1] as u32);
    set(words, HEADER_GMC_DYX, motion.sprite.sprite_delta[1][0] as u32);
    set(words, HEADER_GMC_DYY, motion.sprite.sprite_delta[1][1] as u32);
    set(words, HEADER_FLAGS, if header.reset_anchors { FLAG_RESET_ANCHORS } else { 0 });
    set(words, HEADER_MISSING_REFERENCE_LUMA, header.missing_reference_luma);
    let table: usize = words.len();
    set(words, HEADER_MACROBLOCKS, table as u32);
    words.resize(table + mb_count, 0);
    for (index, record) in by_position.iter().enumerate() {
        let Some(record) = record else {
            return error::fail(ERROR_RECORD_INVALID, MACROBLOCKS_MISSING);
        };
        words[table + index] = words.len() as u32;
        let (operations, operation_count) = macroblock_operations(motion, mpv, record);
        if operation_count > MB_OPERATION_COUNT_MASK {
            return error::fail(ERROR_RECORD_INVALID, TOO_MANY_OPERATIONS);
        }
        // A block of many coefficients is dense, its 64 inputs two to a word; the others' coefficients are entries
        let mut counts: [u32; 6] = [0; 6];
        for &(block, _, _) in &record.entries {
            counts[usize::from(block)] += 1;
        }
        let dense: u32 = (0..6).filter(|&block: &usize| counts[block] >= DENSE_BLOCK_ENTRIES).fold(0, |mask: u32, block: usize| mask | (1 << block));
        let entry_count: u32 = (0..6).filter(|&block: &usize| dense & (1 << block) == 0).map(|block: usize| counts[block]).sum();
        let mut flags: u32 = (record.residual_blocks << MB_RESIDUAL_SHIFT)
            | (operation_count << MB_OPERATION_COUNT_SHIFT)
            | (dense << MB_DENSE_SHIFT)
            | (entry_count << MB_ENTRY_COUNT_SHIFT);
        if record.mb_intra {
            flags |= MB_INTRA;
        }
        if record.interlaced_dct {
            flags |= MB_INTERLACED_DCT;
        }
        words.push(flags);
        words.push(if header.loop_filter { loop_filter_word(mpv, record.mb_x, record.mb_y) } else { 0 });
        words.extend_from_slice(&operations);
        for block in 0..6u8 {
            if dense & (1 << block) == 0 {
                continue;
            }
            let mut samples: [u16; 64] = [0; 64];
            for &(_, position, value) in record.entries.iter().filter(|entry: &&(u8, u8, i16)| entry.0 == block) {
                samples[usize::from(position)] = value as u16;
            }
            words.extend(samples.chunks_exact(2).map(|pair: &[u16]| u32::from(pair[0]) | (u32::from(pair[1]) << 16)));
        }
        words.extend(record.entries.iter().filter(|entry: &&(u8, u8, i16)| dense & (1 << entry.0) == 0).map(|&(block, position, value): &(u8, u8, i16)| {
            (u32::from(block) << ENTRY_BLOCK_SHIFT) | (u32::from(position) << ENTRY_POSITION_SHIFT) | u32::from(value as u16)
        }));
    }
    Ok(())
}
