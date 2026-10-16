// Motion vector derivation (8.5.3.2): merge candidates, AMVP, and temporal prediction from the collocated picture.
// It runs over a picture's prediction records in decode order, after slice data parsing, because temporal prediction reads the motion
// of earlier pictures, which parse workers do not have. It writes each record's final vectors, reference indices, and prediction flags.
// FFmpeg's libavcodec/hevc/mvs.c is the behavioral reference; this is a port of the engine's verified WGSL derivation.

use crate::ctb_layout::CTBLayout;
use crate::layout::{
    BLOCK_PRED_FLAGS_SHIFT, BLOCK_REF_IDX_0_SHIFT, BLOCK_REF_IDX_1_SHIFT, CTB_PREDICTION_COUNT, CTB_PREDICTION_OFFSET, CTB_SLICE,
    PREDICTION_HEIGHT_SHIFT, PREDICTION_WIDTH_SHIFT, PREDICTION_X_SHIFT, PREDICTION_Y_SHIFT,
};
use crate::plan::{PictureParameters, ReferenceEntry, SliceHeader};
use crate::records::{
    JOB_CTB_ENTRY_WORDS, JobStreams, PREDICTION_RECORD_WORDS, SYNTAX_CU_LOG2_BASE, SYNTAX_CU_LOG2_SHIFT, SYNTAX_INTER_PRED_IDC_SHIFT,
    SYNTAX_MERGE_FLAG_SHIFT, SYNTAX_MERGE_INDEX_SHIFT, SYNTAX_MVP_L0_SHIFT, SYNTAX_MVP_L1_SHIFT, SYNTAX_PART_INDEX_SHIFT, SYNTAX_PART_MODE_SHIFT,
};
use crate::sequencer::{SLICE_B, SLICE_P};
use crate::slice_data::{PART_2NXN, PART_2NXND, PART_2NXNU, PART_NLX2N, PART_NRX2N, PART_NX2N, PRED_BI, PRED_L0, PRED_L1, partition_geometry};
use crate::tables::{COMBINED_CANDIDATE_L0, COMBINED_CANDIDATE_L1};

const FIELDS_MASK: u32 = (15 << BLOCK_REF_IDX_0_SHIFT) | (15 << BLOCK_REF_IDX_1_SHIFT) | (3 << BLOCK_PRED_FLAGS_SHIFT);
const MAXIMUM_MERGE_CANDIDATES: usize = 5;
const COLLOCATED_BLOCK_LOG2: u32 = 4;
const COLLOCATED_LONG_TERM_0: u32 = 4;
const COLLOCATED_LONG_TERM_1: u32 = 8;
const SYNTAX_FIELD_MASK_1: u32 = 1;
const SYNTAX_FIELD_MASK_2: u32 = 3;
const SYNTAX_FIELD_MASK_3: u32 = 7;

/// A motion vector field: both vectors, both reference indices, and the prediction flags.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct MotionField {
    vectors: [[i32; 2]; 2],
    ref_idx: [u32; 2],
    pred_flags: u32,
}

fn pack_vector(vector: [i32; 2]) -> u32 {
    (vector[0] as u32 & 0xFFFF) | ((vector[1] as u32) << 16)
}

fn unpack_vector(word: u32) -> [i32; 2] {
    [((word << 16) as i32) >> 16, (word as i32) >> 16]
}

fn clip_int16(value: i32) -> i32 {
    value.clamp(-32768, 32767)
}

fn wrap_vector(vector: [i32; 2]) -> [i32; 2] {
    [((vector[0] << 16) >> 16), ((vector[1] << 16) >> 16)]
}

fn scale_motion_vector(vector: [i32; 2], poc_distance_colocated: i32, poc_distance_current: i32) -> [i32; 2] {
    let td: i32 = poc_distance_colocated.clamp(-128, 127);
    let tb: i32 = poc_distance_current.clamp(-128, 127);
    let tx: i32 = (16384 + (td / 2).abs()) / td;
    let scale_factor: i32 = ((tb * tx + 32) >> 6).clamp(-4096, 4095);
    let scale = |component: i32| -> i32 {
        let product: i32 = scale_factor.wrapping_mul(component);
        clip_int16((product + 127 + i32::from(product < 0)) >> 8)
    };
    [scale(vector[0]), scale(vector[1])]
}

fn is_same_motion(first: &MotionField, second: &MotionField) -> bool {
    if first.pred_flags != second.pred_flags {
        return false;
    }
    let same_l0: bool = first.ref_idx[0] == second.ref_idx[0] && first.vectors[0] == second.vectors[0];
    let same_l1: bool = first.ref_idx[1] == second.ref_idx[1] && first.vectors[1] == second.vectors[1];
    match first.pred_flags {
        PRED_BI => same_l0 && same_l1,
        PRED_L0 => same_l0,
        PRED_L1 => same_l1,
        _ => false,
    }
}

/// The collocated motion of a 16x16 block: both vectors, both reference POCs, and flags.
#[derive(Clone, Copy, Default)]
struct CollocatedMotion {
    vectors: [u32; 2],
    pocs: [i32; 2],
    flags: u32,
}

/// A decoded picture's motion at 16x16 granularity, which later pictures' temporal prediction reads.
struct CollocatedField {
    picture_id: u32,
    poc: i32,
    stride: u32,
    blocks: Vec<CollocatedMotion>,
}

/// The coding unit around a prediction unit.
#[derive(Clone, Copy)]
struct CodingUnit {
    x: u32,
    y: u32,
    log2_size: u32,
    part_mode: u32,
}

/// Derives motion over the pictures of a stream in decode order, keeping the collocated motion of the pictures still referenced.
#[derive(Default)]
pub struct MotionStage {
    layout: CTBLayout,
    grid: Vec<[u32; 3]>,
    block_stride: usize,
    ctb_slices: Vec<u32>,
    fields: Vec<CollocatedField>,
    spare_blocks: Vec<Vec<CollocatedMotion>>,
}

/// The per-picture inputs of motion derivation.
struct PictureContext<'a> {
    parameters: &'a PictureParameters,
    slices: &'a [SliceHeader],
    collocated: Option<usize>,
}

impl MotionStage {
    /// Drops every picture's motion, for a reset.
    pub fn reset(&mut self) {
        for field in self.fields.drain(..) {
            self.spare_blocks.push(field.blocks);
        }
    }

    /// Derives the motion of one picture's prediction records, from every job of the picture in decode order, then stores its collocated motion.
    /// Pictures outside `keep` leave first, since neither this picture nor a later one references them.
    pub fn process(&mut self, parameters: &PictureParameters, slices: &[SliceHeader], keep: &[u32], jobs: &mut [JobStreams]) {
        let mut index: usize = 0;
        while index < self.fields.len() {
            if keep.contains(&self.fields[index].picture_id) {
                index += 1;
            } else {
                let field: CollocatedField = self.fields.swap_remove(index);
                self.spare_blocks.push(field.blocks);
            }
        }
        self.layout.update(parameters);
        self.block_stride = ((parameters.width + 3) >> 2) as usize;
        let block_count: usize = self.block_stride * ((parameters.height + 3) >> 2) as usize;
        if self.grid.len() < block_count {
            self.grid.resize(block_count, [0; 3]);
        }
        self.ctb_slices.clear();
        self.ctb_slices.resize(parameters.ctb_count as usize, 0);
        let mut collocated_by_slice: Vec<Option<usize>> = Vec::with_capacity(slices.len());
        for slice in slices {
            let mut collocated: Option<usize> = None;
            if slice.temporal_mvp == 1 && slice.collocated_valid == 1 {
                let entry: ReferenceEntry = slice.references[slice.collocated_list as usize][slice.collocated_ref_idx as usize];
                collocated = self.fields.iter().position(|field: &CollocatedField| field.picture_id == entry.picture_id);
            }
            collocated_by_slice.push(collocated);
        }
        for job in jobs.iter_mut() {
            let ctb_count: usize = job.ctb_count();
            for ctb in 0..ctb_count {
                let entry_start: usize = ctb * JOB_CTB_ENTRY_WORDS;
                let ctb_address_rs: u32 = job.ctb_entries[entry_start];
                let record: &[u32] = &job.ctb_entries[entry_start + 1..entry_start + JOB_CTB_ENTRY_WORDS];
                let slice_index: usize = record[CTB_SLICE as usize] as usize;
                let prediction_offset: usize = record[CTB_PREDICTION_OFFSET as usize] as usize;
                let prediction_count: usize = record[CTB_PREDICTION_COUNT as usize] as usize;
                self.ctb_slices[ctb_address_rs as usize] = slice_index as u32;
                let context: PictureContext = PictureContext { parameters, slices, collocated: collocated_by_slice[slice_index] };
                let ctb_x0: u32 = (ctb_address_rs % parameters.ctb_width) << parameters.ctb_log2;
                let ctb_y0: u32 = (ctb_address_rs / parameters.ctb_width) << parameters.ctb_log2;
                for prediction in 0..prediction_count {
                    let start: usize = prediction_offset + prediction * PREDICTION_RECORD_WORDS;
                    let words: &mut [u32] = &mut job.predictions[start..start + PREDICTION_RECORD_WORDS];
                    self.derive_record(&context, slice_index, ctb_x0, ctb_y0, words);
                }
            }
        }
        self.store_collocated(parameters, slices);
    }

    fn block_index(&self, x: u32, y: u32) -> usize {
        (y >> 2) as usize * self.block_stride + (x >> 2) as usize
    }

    fn read_motion(&self, x: u32, y: u32) -> MotionField {
        let block: [u32; 3] = self.grid[self.block_index(x, y)];
        MotionField {
            vectors: [unpack_vector(block[0]), unpack_vector(block[1])],
            ref_idx: [(block[2] >> BLOCK_REF_IDX_0_SHIFT) & 15, (block[2] >> BLOCK_REF_IDX_1_SHIFT) & 15],
            pred_flags: (block[2] >> BLOCK_PRED_FLAGS_SHIFT) & 3,
        }
    }

    fn pred_flags_at(&self, x: u32, y: u32) -> u32 {
        (self.grid[self.block_index(x, y)][2] >> BLOCK_PRED_FLAGS_SHIFT) & 3
    }

    fn write_motion(&mut self, x0: u32, y0: u32, width: u32, height: u32, field: &MotionField) {
        let block: [u32; 3] = [
            pack_vector(field.vectors[0]),
            pack_vector(field.vectors[1]),
            (field.ref_idx[0] << BLOCK_REF_IDX_0_SHIFT) | (field.ref_idx[1] << BLOCK_REF_IDX_1_SHIFT) | (field.pred_flags << BLOCK_PRED_FLAGS_SHIFT),
        ];
        for y in (y0..y0 + height).step_by(4) {
            let row: usize = (y >> 2) as usize * self.block_stride;
            for x in (x0..x0 + width).step_by(4) {
                self.grid[row + (x >> 2) as usize] = block;
            }
        }
    }

    /// Derives one prediction record: an intra coding unit's record only marks its blocks intra.
    fn derive_record(&mut self, context: &PictureContext, slice_index: usize, ctb_x0: u32, ctb_y0: u32, words: &mut [u32]) {
        let geometry: u32 = words[0];
        let x0: u32 = ctb_x0 + (((geometry >> PREDICTION_X_SHIFT) & 15) << 2);
        let y0: u32 = ctb_y0 + (((geometry >> PREDICTION_Y_SHIFT) & 15) << 2);
        let width: u32 = (((geometry >> PREDICTION_WIDTH_SHIFT) & 15) + 1) << 2;
        let height: u32 = (((geometry >> PREDICTION_HEIGHT_SHIFT) & 15) + 1) << 2;
        let merge_flag: bool = (geometry >> SYNTAX_MERGE_FLAG_SHIFT) & SYNTAX_FIELD_MASK_1 == 1;
        let inter_pred_idc: u32 = (geometry >> SYNTAX_INTER_PRED_IDC_SHIFT) & SYNTAX_FIELD_MASK_2;
        if !merge_flag && inter_pred_idc == 0 {
            self.write_motion(x0, y0, width, height, &MotionField::default());
            return;
        }
        let slice: &SliceHeader = &context.slices[slice_index];
        let part_index: u32 = (geometry >> SYNTAX_PART_INDEX_SHIFT) & SYNTAX_FIELD_MASK_2;
        let part_mode: u32 = (geometry >> SYNTAX_PART_MODE_SHIFT) & SYNTAX_FIELD_MASK_3;
        let cu_log2: u32 = ((geometry >> SYNTAX_CU_LOG2_SHIFT) & SYNTAX_FIELD_MASK_2) + SYNTAX_CU_LOG2_BASE;
        let offset: [u32; 4] = partition_geometry(part_mode, 1 << cu_log2, part_index);
        let coding_unit: CodingUnit = CodingUnit { x: x0 - offset[0], y: y0 - offset[1], log2_size: cu_log2, part_mode };
        let mut motion: MotionField = MotionField::default();
        if merge_flag {
            let merge_index: u32 = (geometry >> SYNTAX_MERGE_INDEX_SHIFT) & SYNTAX_FIELD_MASK_3;
            motion = self.derive_merge_motion(context, slice, &coding_unit, [x0, y0, width, height], part_index, merge_index);
            // 8x4 and 4x8 prediction blocks are never bi-predicted
            if motion.pred_flags == PRED_BI && width + height == 12 {
                motion.pred_flags = PRED_L0;
            }
        } else {
            for list in 0..2usize {
                if inter_pred_idc & (1 << list) == 0 {
                    continue;
                }
                let ref_idx: u32 = (words[1] >> (list * 4)) & 15;
                let mvp_shift: u32 = if list == 0 { SYNTAX_MVP_L0_SHIFT } else { SYNTAX_MVP_L1_SHIFT };
                let mvp_flag: u32 = (geometry >> mvp_shift) & SYNTAX_FIELD_MASK_1;
                let predictor: [i32; 2] = self.predict_motion_vector(context, slice, &coding_unit, [x0, y0, width, height], part_index, ref_idx, list, mvp_flag);
                let difference: [i32; 2] = unpack_vector(words[2 + list]);
                motion.ref_idx[list] = ref_idx;
                motion.vectors[list] = wrap_vector([predictor[0].wrapping_add(difference[0]), predictor[1].wrapping_add(difference[1])]);
                motion.pred_flags |= 1 << list;
            }
        }
        self.write_motion(x0, y0, width, height, &motion);
        words[1] = (words[1] & !FIELDS_MASK)
            | (motion.ref_idx[0] << BLOCK_REF_IDX_0_SHIFT)
            | (motion.ref_idx[1] << BLOCK_REF_IDX_1_SHIFT)
            | (motion.pred_flags << BLOCK_PRED_FLAGS_SHIFT);
        words[2] = pack_vector(motion.vectors[0]);
        words[3] = pack_vector(motion.vectors[1]);
    }

    /// Prediction block availability (6.4.2), including the intra check.
    #[allow(clippy::too_many_arguments)]
    fn is_prediction_block_available(
        &self,
        slice: &SliceHeader,
        coding_unit: &CodingUnit,
        block: [u32; 4],
        part_index: u32,
        neighbour_x: i32,
        neighbour_y: i32,
    ) -> bool {
        let [x_pb, y_pb, width, height] = block;
        let cb_size: i32 = 1 << coding_unit.log2_size;
        let cu_x: i32 = coding_unit.x as i32;
        let cu_y: i32 = coding_unit.y as i32;
        let same_cb: bool = neighbour_x >= cu_x && neighbour_y >= cu_y && neighbour_x < cu_x + cb_size && neighbour_y < cu_y + cb_size;
        let available: bool = if !same_cb {
            self.layout.is_available_in_slice(x_pb, y_pb, neighbour_x, neighbour_y, slice.address_ts)
        } else {
            !(((width << 1) as i32) == cb_size
                && ((height << 1) as i32) == cb_size
                && part_index == 1
                && cu_y + height as i32 <= neighbour_y
                && cu_x + width as i32 > neighbour_x)
        };
        available && self.pred_flags_at(neighbour_x as u32, neighbour_y as u32) != 0
    }

    fn collocated_motion(&self, field: &CollocatedField, x: u32, y: u32) -> CollocatedMotion {
        field.blocks[((y >> COLLOCATED_BLOCK_LOG2) * field.stride + (x >> COLLOCATED_BLOCK_LOG2)) as usize]
    }

    /// Derives mvLXCol from one list of the collocated block (8.5.3.2.9).
    fn check_collocated_list(&self, context: &PictureContext, slice: &SliceHeader, field: &CollocatedField, motion: &CollocatedMotion, list_colocated: usize, ref_idx: u32, list: usize) -> Option<[i32; 2]> {
        let reference: ReferenceEntry = slice.references[list][ref_idx as usize];
        let current_long_term: bool = reference.long_term != 0;
        let long_term_flag: u32 = if list_colocated == 1 { COLLOCATED_LONG_TERM_1 } else { COLLOCATED_LONG_TERM_0 };
        let colocated_long_term: bool = motion.flags & long_term_flag != 0;
        if current_long_term != colocated_long_term {
            return None;
        }
        let vector: [i32; 2] = unpack_vector(motion.vectors[list_colocated]);
        let colocated_distance: i32 = field.poc.wrapping_sub(motion.pocs[list_colocated]);
        let current_distance: i32 = context.parameters.poc.wrapping_sub(reference.poc);
        if current_long_term || colocated_distance == current_distance || colocated_distance == 0 {
            return Some(vector);
        }
        Some(scale_motion_vector(vector, colocated_distance, current_distance))
    }

    fn derive_collocated_vector(&self, context: &PictureContext, slice: &SliceHeader, field: &CollocatedField, x: u32, y: u32, ref_idx: u32, list: usize) -> Option<[i32; 2]> {
        let motion: CollocatedMotion = self.collocated_motion(field, x, y);
        let pred_flags: u32 = motion.flags & 3;
        if pred_flags == 0 {
            return None;
        }
        let list_colocated: usize = if pred_flags & PRED_L0 == 0 {
            1
        } else if pred_flags == PRED_L0 {
            0
        } else if slice.no_backward_prediction == 1 {
            list
        } else if slice.collocated_list == 1 {
            0
        } else {
            1
        };
        self.check_collocated_list(context, slice, field, &motion, list_colocated, ref_idx, list)
    }

    /// Temporal luma motion vector prediction (8.5.3.2.8): the bottom-right collocated block, then the center one.
    fn predict_temporal_vector(&self, context: &PictureContext, slice: &SliceHeader, block: [u32; 4], ref_idx: u32, list: usize) -> Option<[i32; 2]> {
        let field_index: usize = context.collocated?;
        let field: &CollocatedField = &self.fields[field_index];
        let [x0, y0, width, height] = block;
        let parameters: &PictureParameters = context.parameters;
        let bottom_right_x: u32 = x0 + width;
        let bottom_right_y: u32 = y0 + height;
        if (y0 >> parameters.ctb_log2) == (bottom_right_y >> parameters.ctb_log2) && bottom_right_y < parameters.height && bottom_right_x < parameters.width {
            let candidate: Option<[i32; 2]> = self.derive_collocated_vector(context, slice, field, bottom_right_x & !15, bottom_right_y & !15, ref_idx, list);
            if candidate.is_some() {
                return candidate;
            }
        }
        let center_x: u32 = x0 + (width >> 1);
        let center_y: u32 = y0 + (height >> 1);
        self.derive_collocated_vector(context, slice, field, center_x & !15, center_y & !15, ref_idx, list)
    }

    /// The merge candidate at merge_index (8.5.3.2.2).
    fn derive_merge_motion(&self, context: &PictureContext, slice: &SliceHeader, coding_unit: &CodingUnit, block: [u32; 4], part_index_in: u32, merge_index: u32) -> MotionField {
        let parameters: &PictureParameters = context.parameters;
        let log2_parallel_merge: u32 = parameters.log2_parallel_merge;
        let mut block: [u32; 4] = block;
        let mut part_index: u32 = part_index_in;
        let single_merge_list: bool = log2_parallel_merge > 2 && coding_unit.log2_size == 3;
        if single_merge_list {
            block = [coding_unit.x, coding_unit.y, 8, 8];
            part_index = 0;
        }
        let [x_pb, y_pb, width, height] = block;
        let max_merge_candidates: usize = slice.max_merge_candidates as usize;
        let merge_index: usize = merge_index as usize;
        let mut candidates: [MotionField; MAXIMUM_MERGE_CANDIDATES] = [MotionField::default(); MAXIMUM_MERGE_CANDIDATES];
        let mut candidate_count: usize = 0;

        // Spatial candidates A1, B1, B0, A0, and B2 (8.5.3.2.3); availability counts before pruning
        let part_mode: u32 = coding_unit.part_mode;
        let vertical_second: bool = part_mode == PART_NX2N || part_mode == PART_NLX2N || part_mode == PART_NRX2N;
        let horizontal_second: bool = part_mode == PART_2NXN || part_mode == PART_2NXNU || part_mode == PART_2NXND;
        let mut spatial: [MotionField; 5] = [MotionField::default(); 5];
        let mut available_mask: u32 = 0;
        for index in 0..5u32 {
            let (neighbour, excluded): ([i32; 2], bool) = match index {
                0 => ([x_pb as i32 - 1, (y_pb + height) as i32 - 1], !single_merge_list && part_index == 1 && vertical_second),
                1 => ([(x_pb + width) as i32 - 1, y_pb as i32 - 1], !single_merge_list && part_index == 1 && horizontal_second),
                2 => ([(x_pb + width) as i32, y_pb as i32 - 1], false),
                3 => ([x_pb as i32 - 1, (y_pb + height) as i32], false),
                _ => ([x_pb as i32 - 1, y_pb as i32 - 1], candidate_count == 4),
            };
            if excluded
                || ((neighbour[0] >> log2_parallel_merge) == (x_pb >> log2_parallel_merge) as i32
                    && (neighbour[1] >> log2_parallel_merge) == (y_pb >> log2_parallel_merge) as i32)
                || !self.is_prediction_block_available(slice, coding_unit, block, part_index, neighbour[0], neighbour[1])
            {
                continue;
            }
            let motion: MotionField = self.read_motion(neighbour[0] as u32, neighbour[1] as u32);
            spatial[index as usize] = motion;
            available_mask |= 1 << index;
            // B1 and A0 against A1, B0 against B1, B2 against A1 and B1
            let compared_with_a1: bool = index == 1 || index == 3 || index == 4;
            let compared_with_b1: bool = index == 2 || index == 4;
            if (compared_with_a1 && available_mask & 1 != 0 && is_same_motion(&motion, &spatial[0]))
                || (compared_with_b1 && available_mask & 2 != 0 && is_same_motion(&motion, &spatial[1]))
            {
                continue;
            }
            candidates[candidate_count] = motion;
            if merge_index == candidate_count {
                return motion;
            }
            candidate_count += 1;
        }

        // The temporal candidate, from reference index 0 of each list (8.5.3.2.8)
        if slice.temporal_mvp == 1 && candidate_count < max_merge_candidates {
            let mut temporal: MotionField = MotionField::default();
            let list_count: usize = if slice.slice_type == SLICE_B { 2 } else { 1 };
            for list in 0..list_count {
                if let Some(vector) = self.predict_temporal_vector(context, slice, block, 0, list) {
                    temporal.pred_flags |= 1 << list;
                    temporal.vectors[list] = vector;
                }
            }
            if temporal.pred_flags != 0 {
                candidates[candidate_count] = temporal;
                if merge_index == candidate_count {
                    return temporal;
                }
                candidate_count += 1;
            }
        }

        let original_count: usize = candidate_count;
        if slice.slice_type == SLICE_B && original_count > 1 && original_count < max_merge_candidates {
            let mut combination: usize = 0;
            while candidate_count < max_merge_candidates && combination < original_count * (original_count - 1) {
                let candidate_l0: MotionField = candidates[COMBINED_CANDIDATE_L0[combination]];
                let candidate_l1: MotionField = candidates[COMBINED_CANDIDATE_L1[combination]];
                combination += 1;
                if candidate_l0.pred_flags & PRED_L0 != 0
                    && candidate_l1.pred_flags & PRED_L1 != 0
                    && (slice.references[0][candidate_l0.ref_idx[0] as usize].poc != slice.references[1][candidate_l1.ref_idx[1] as usize].poc
                        || candidate_l0.vectors[0] != candidate_l1.vectors[1])
                {
                    let combined: MotionField = MotionField {
                        vectors: [candidate_l0.vectors[0], candidate_l1.vectors[1]],
                        ref_idx: [candidate_l0.ref_idx[0], candidate_l1.ref_idx[1]],
                        pred_flags: PRED_BI,
                    };
                    candidates[candidate_count] = combined;
                    if merge_index == candidate_count {
                        return combined;
                    }
                    candidate_count += 1;
                }
            }
        }

        let zero_reference_count: u32 = if slice.slice_type == SLICE_P {
            slice.reference_counts[0]
        } else {
            slice.reference_counts[0].min(slice.reference_counts[1])
        };
        let mut zero_index: u32 = 0;
        while candidate_count < max_merge_candidates {
            let ref_idx: u32 = if zero_index < zero_reference_count { zero_index } else { 0 };
            let zero: MotionField = MotionField {
                vectors: [[0; 2]; 2],
                ref_idx: [ref_idx, ref_idx],
                pred_flags: PRED_L0 | if slice.slice_type == SLICE_B { PRED_L1 } else { 0 },
            };
            if merge_index == candidate_count {
                return zero;
            }
            candidate_count += 1;
            zero_index += 1;
        }
        candidates[merge_index.min(MAXIMUM_MERGE_CANDIDATES - 1)]
    }

    /// A spatial AMVP candidate from either list of the neighbour, the target's own list first (8.5.3.2.7).
    /// Unscaled, the neighbour must reference the target picture; scaled, it must match the target's long-term marking and is scaled by POC distance.
    #[allow(clippy::too_many_arguments)]
    fn amvp_candidate(&self, context: &PictureContext, slice: &SliceHeader, x: u32, y: u32, list: usize, ref_idx: u32, target_poc: i32, scaled: bool) -> Option<[i32; 2]> {
        let motion: MotionField = self.read_motion(x, y);
        let current_long_term: bool = slice.references[list][ref_idx as usize].long_term != 0;
        let current_poc: i32 = context.parameters.poc;
        for order in 0..2 {
            let prediction_list: usize = if order == 0 { list } else { 1 - list };
            if motion.pred_flags & (1 << prediction_list) == 0 {
                continue;
            }
            let neighbour_reference: ReferenceEntry = slice.references[prediction_list][motion.ref_idx[prediction_list] as usize];
            let vector: [i32; 2] = motion.vectors[prediction_list];
            if !scaled {
                if neighbour_reference.poc == target_poc {
                    return Some(vector);
                }
                continue;
            }
            if (neighbour_reference.long_term != 0) != current_long_term {
                continue;
            }
            if current_long_term || neighbour_reference.poc == target_poc {
                return Some(vector);
            }
            let mut distance: i32 = current_poc.wrapping_sub(neighbour_reference.poc);
            if distance == 0 {
                distance = 1;
            }
            return Some(scale_motion_vector(vector, distance, current_poc.wrapping_sub(target_poc)));
        }
        None
    }

    /// The motion vector predictor of a list for a prediction unit (8.5.3.2.6, 8.5.3.2.7).
    #[allow(clippy::too_many_arguments)]
    fn predict_motion_vector(
        &self,
        context: &PictureContext,
        slice: &SliceHeader,
        coding_unit: &CodingUnit,
        block: [u32; 4],
        part_index: u32,
        ref_idx: u32,
        list: usize,
        mvp_flag: u32,
    ) -> [i32; 2] {
        let [x_pb, y_pb, width, height] = block;
        let target_poc: i32 = slice.references[list][ref_idx as usize].poc;
        // Neighbours A0, A1, B0, B1, B2
        let positions: [[i32; 2]; 5] = [
            [x_pb as i32 - 1, (y_pb + height) as i32],
            [x_pb as i32 - 1, (y_pb + height) as i32 - 1],
            [(x_pb + width) as i32, y_pb as i32 - 1],
            [(x_pb + width) as i32 - 1, y_pb as i32 - 1],
            [x_pb as i32 - 1, y_pb as i32 - 1],
        ];
        let mut available_mask: u32 = 0;
        for (index, position) in positions.iter().enumerate() {
            if self.is_prediction_block_available(slice, coding_unit, block, part_index, position[0], position[1]) {
                available_mask |= 1 << index;
            }
        }
        let is_scaled: bool = available_mask & 3 != 0;
        // Steps 0 to 3 try A0 and A1 unscaled, then scaled; steps 4 to 6 try the B neighbours unscaled;
        // without A neighbours, the B candidate moves to A and steps 7 to 9 try the B neighbours scaled
        let mut candidate_a: Option<[i32; 2]> = None;
        let mut candidate_b: Option<[i32; 2]> = None;
        for step in 0..10u32 {
            if step == 7 {
                if is_scaled {
                    break;
                }
                if candidate_b.is_some() {
                    candidate_a = candidate_b;
                }
                candidate_b = None;
            }
            let for_a: bool = step < 4;
            let neighbour: usize = if for_a { (step & 1) as usize } else { (2 + (step - 4) % 3) as usize };
            if (for_a && candidate_a.is_some()) || (!for_a && candidate_b.is_some()) || available_mask & (1 << neighbour) == 0 {
                continue;
            }
            let scaled: bool = step == 2 || step == 3 || step >= 7;
            let position: [i32; 2] = positions[neighbour];
            let candidate: Option<[i32; 2]> = self.amvp_candidate(context, slice, position[0] as u32, position[1] as u32, list, ref_idx, target_poc, scaled);
            if for_a {
                candidate_a = candidate;
            } else {
                candidate_b = candidate;
            }
        }
        let mut candidates: [[i32; 2]; 2] = [[0; 2]; 2];
        let mut candidate_count: u32 = 0;
        if let Some(vector) = candidate_a {
            candidates[0] = vector;
            candidate_count = 1;
        }
        if let Some(vector) = candidate_b
            && candidate_a != Some(vector)
        {
            candidates[candidate_count as usize] = vector;
            candidate_count += 1;
        }
        if candidate_count < 2
            && slice.temporal_mvp == 1
            && mvp_flag == candidate_count
            && let Some(vector) = self.predict_temporal_vector(context, slice, block, ref_idx, list)
        {
            candidates[candidate_count as usize] = vector;
            candidate_count += 1;
        }
        if mvp_flag >= candidate_count {
            return [0; 2];
        }
        candidates[mvp_flag as usize]
    }

    /// Stores the picture's motion at 16x16 granularity for later pictures' temporal motion vector prediction.
    fn store_collocated(&mut self, parameters: &PictureParameters, slices: &[SliceHeader]) {
        let stride: u32 = (parameters.width + 15) >> COLLOCATED_BLOCK_LOG2;
        let rows: u32 = (parameters.height + 15) >> COLLOCATED_BLOCK_LOG2;
        let mut blocks: Vec<CollocatedMotion> = self.spare_blocks.pop().unwrap_or_default();
        blocks.clear();
        blocks.reserve((stride * rows) as usize);
        for row in 0..rows {
            for column in 0..stride {
                let x: u32 = column << COLLOCATED_BLOCK_LOG2;
                let y: u32 = row << COLLOCATED_BLOCK_LOG2;
                let block: [u32; 3] = self.grid[self.block_index(x, y)];
                let pred_flags: u32 = (block[2] >> BLOCK_PRED_FLAGS_SHIFT) & 3;
                let slice: &SliceHeader = &slices[self.ctb_slices[self.layout.ctb_address_of(x, y) as usize] as usize];
                let mut motion: CollocatedMotion = CollocatedMotion { vectors: [block[0], block[1]], pocs: [0; 2], flags: pred_flags };
                for list in 0..2usize {
                    if pred_flags & (1 << list) == 0 {
                        continue;
                    }
                    let ref_idx: usize = ((block[2] >> (list * 4)) & 15) as usize;
                    let reference: ReferenceEntry = slice.references[list][ref_idx];
                    motion.pocs[list] = reference.poc;
                    if reference.long_term != 0 {
                        motion.flags |= if list == 0 { COLLOCATED_LONG_TERM_0 } else { COLLOCATED_LONG_TERM_1 };
                    }
                }
                blocks.push(motion);
            }
        }
        self.fields.push(CollocatedField { picture_id: parameters.picture_id, poc: parameters.poc, stride, blocks });
    }
}
