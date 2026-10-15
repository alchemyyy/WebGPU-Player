// Motion vector prediction and the motion compensation records, as FFmpeg's vc1_pred.c predicts and vc1_mc.c compensates: progressive,
// field, and interlaced frame prediction with hybrid prediction, B picture direct and interpolated prediction from the next anchor's
// motion, and the calls the GPU's reconstruction replays, each with its side effects on the motion fields.

use crate::layout::{
    CHROMA_KIND_1MV, CHROMA_KIND_4MV, CHROMA_KIND_INTERPOLATED, CHROMA_KIND_QUARTER, FCM_FRAME, LUMA_KIND_1MV, LUMA_KIND_4MV,
    LUMA_KIND_INTERPOLATED, LUMA_OPERATION_SLOTS, OPERATION_AVERAGE, OPERATION_BOTTOM_FIELD, OPERATION_FIELD_MV, OPERATION_KIND_SHIFT,
    OPERATION_PRESENT, OPERATION_SOURCE_SHIFT, PROFILE_ADVANCED, SOURCE_CURRENT, SOURCE_LAST, SOURCE_NEXT, TYPE_B, TYPE_P,
};
use crate::macroblock::{BMV_BACKWARD, BMV_DIRECT, BMV_FORWARD, BMV_INTERPOLATED};
use crate::plan::{ANCHOR_INTRA, ANCHOR_WORDS_PER_MACROBLOCK};
use crate::tables::{B_FIELD_MVPRED_SCALES, CHROMA_MV_PAIRS, FIELD_CHROMA_ROUNDING, FIELD_MVPRED_SCALES, LUMA_MV_PAIRS};
use crate::unit::{
    GRID_STRIDE, MB_BLOCK_MV_TYPE_SHIFT, MacroblockRecord, UnitParser, median_of_four, median_of_three, pack_motion_vector, unpack_motion_vector,
    wrap_int16,
};

// A predictor further than this from A or C in sum of components picks A or C with a bit, hybrid prediction
const HYBRID_PREDICTION_THRESHOLD: i32 = 32;
// The field predictor scaling rows: SCALEOPP, SCALESAME1, SCALESAME2, SCALEZONE1_X, SCALEZONE1_Y, ZONE1OFFSET_X, ZONE1OFFSET_Y
const SCALE_ROWS: u32 = 7;
const SCALE_DISTANCES: u32 = 4;
const SCALE_OPPOSITE: u32 = 0;
const SCALE_SAME1: u32 = 1;
const SCALE_SAME2: u32 = 2;
const SCALE_ZONE1_X: u32 = 3;
const SCALE_ZONE1_Y: u32 = 4;
const ZONE1_OFFSET_X: u32 = 5;
const ZONE1_OFFSET_Y: u32 = 6;
const MAXIMUM_SCALE_DISTANCE: u32 = 3;
// Components beyond these never rescale
const SCALE_LIMIT_X: i32 = 255;
const SCALE_LIMIT_Y: i32 = 63;
// The whole-macroblock bit of BFRACTION's inverse for direct prediction
const BFRACTION_ONE: i32 = 256;

/// A grid block's predictor in a field picture: its motion vector and opposite-field flag in one direction, and whether it is intra.
#[derive(Clone, Copy)]
struct FieldPredictor {
    vector: [i32; 2],
    field: u32,
    intra: bool,
}

/// The chroma motion vector of a luma vector, FFmpeg's (mv + ((mv & 3) == 3)) >> 1
fn chroma_vector(vector: [i32; 2]) -> [i32; 2] {
    [(vector[0] + i32::from(vector[0] & 3 == 3)) >> 1, (vector[1] + i32::from(vector[1] & 3 == 3)) >> 1]
}

/// FASTUVMC rounding of mc_1mv and mc_4mv_chroma: odd components move toward zero
fn round_toward_zero_even(value: i32) -> i32 {
    value + if value < 0 { value & 1 } else { -(value & 1) }
}

/// FASTUVMC rounding of interp_mc: odd components move away from zero
fn round_away_from_zero_even(value: i32) -> i32 {
    value + if value < 0 { -(value & 1) } else { value & 1 }
}

/// The rounded mean of two predictors, as FFmpeg averages a field-motion neighbor's two field vectors
fn average_vectors(first: [i32; 2], second: [i32; 2]) -> [i32; 2] {
    [(first[0] + second[0] + 1) >> 1, (first[1] + second[1] + 1) >> 1]
}

fn median_vector(first: [i32; 2], second: [i32; 2], third: [i32; 2]) -> [i32; 2] {
    [median_of_three(first[0], second[0], third[0]), median_of_three(first[1], second[1], third[1])]
}

fn wrap_vector(vector: [i32; 2]) -> [i32; 2] {
    [wrap_int16(vector[0]), wrap_int16(vector[1])]
}

/// Adds a differential to a prediction within the motion vector range, wrapping as FFmpeg's masks do.
fn wrap_into_range(prediction: i32, differential: i32, range: i32) -> i32 {
    ((prediction + differential + range) & ((range << 1) - 1)) - range
}

fn scale_zoned(value: i32, limit: i32, zone: i32, scale1: i32, scale2: i32, offset: i32) -> i32 {
    if value.abs() > limit {
        return value;
    }
    if value.abs() < zone {
        return (value * scale1) >> 8;
    }
    if value < 0 {
        return ((value * scale2) >> 8) - offset;
    }
    ((value * scale2) >> 8) + offset
}

fn field_scale_value(table: u32, row: u32, distance: u32) -> i32 {
    FIELD_MVPRED_SCALES[((table * SCALE_ROWS + row) * SCALE_DISTANCES + distance.min(MAXIMUM_SCALE_DISTANCE)) as usize]
}

fn backward_field_scale_value(row: u32, distance: u32) -> i32 {
    B_FIELD_MVPRED_SCALES[(row * SCALE_DISTANCES + distance.min(MAXIMUM_SCALE_DISTANCE)) as usize]
}

impl UnitParser<'_> {
    fn write_luma_operation(&mut self, slot: u32, flags: u32, vector: [i32; 2]) {
        let record: &mut MacroblockRecord = &mut self.records[self.current];
        record.operation_words[slot as usize] = [flags | OPERATION_PRESENT, pack_motion_vector(vector)];
        record.operations |= 1 << slot;
    }

    fn write_chroma_operation(&mut self, slot: u32, flags: u32, vector: [i32; 2]) {
        let record: &mut MacroblockRecord = &mut self.records[self.current];
        record.operation_words[(LUMA_OPERATION_SLOTS + slot) as usize] = [flags | OPERATION_PRESENT, pack_motion_vector(vector)];
        record.operations |= 1 << (LUMA_OPERATION_SLOTS + slot);
    }

    /// The source of a forward or backward operation: the first field of the current frame when a second field references the opposite field
    fn operation_source(&self, direction: u32, reference_field: u32) -> u32 {
        if direction != 0 {
            return SOURCE_NEXT;
        }
        if self.unit.field_mode != 0 && self.unit.current_field_type != reference_field && self.unit.second_field != 0 {
            return SOURCE_CURRENT;
        }
        SOURCE_LAST
    }

    fn operation_flags(&self, kind: u32, direction: u32, average: bool, reference_field: u32) -> u32 {
        let mut flags: u32 = (kind << OPERATION_KIND_SHIFT) | (self.operation_source(direction, reference_field) << OPERATION_SOURCE_SHIFT);
        if average {
            flags |= OPERATION_AVERAGE;
        }
        if reference_field != 0 {
            flags |= OPERATION_BOTTOM_FIELD;
        }
        flags
    }

    fn set_current_motion_vectors_of_record(&mut self, direction: usize, block: usize, vector: [i32; 2]) {
        self.records[self.current].motion_vectors[direction][block] = pack_motion_vector(vector);
    }

    /// Records ff_vc1_mc_1mv(v, dir) and its side effects on motion_val[1], luma_mv, and chroma mv_f
    pub fn record_motion_1mv(&mut self, direction: u32) {
        let mut vector: [i32; 2] = self.current_motion_vector(direction as usize, 0);
        if self.unit.picture_type == TYPE_P {
            for block in 0..4 {
                self.set_current_motion_vectors_of_record(1, block, vector);
            }
        }
        let mut chroma: [i32; 2] = chroma_vector(vector);
        self.records[self.current].loop_filter_chroma_mv = pack_motion_vector(chroma);
        let reference_field: u32 = self.ref_field_type[direction as usize];
        let current_field: i32 = self.unit.current_field_type as i32;
        if self.unit.field_mode != 0 && self.unit.current_field_type != reference_field {
            vector[1] = vector[1] - 2 + 4 * current_field;
            chroma[1] = chroma[1] - 2 + 4 * current_field;
        }
        if self.sequence.fastuvmc != 0 && self.unit.fcm != FCM_FRAME {
            chroma = [round_toward_zero_even(chroma[0]), round_toward_zero_even(chroma[1])];
        }
        let luma_flags: u32 = self.operation_flags(LUMA_KIND_1MV, direction, false, reference_field);
        self.write_luma_operation(0, luma_flags, vector);
        let chroma_flags: u32 = self.operation_flags(CHROMA_KIND_1MV, direction, false, reference_field);
        self.write_chroma_operation(0, chroma_flags, chroma);
        if self.unit.field_mode != 0 {
            self.set_chroma_field_flags(direction, u32::from(self.unit.current_field_type != reference_field));
        }
    }

    /// Records ff_vc1_interp_mc: averaging the backward prediction into the forward one
    pub fn record_interpolated_motion(&mut self) {
        let mut vector: [i32; 2] = self.current_motion_vector(1, 0);
        let mut chroma: [i32; 2] = chroma_vector(vector);
        let reference_field: u32 = self.ref_field_type[1];
        let current_field: i32 = self.unit.current_field_type as i32;
        if self.unit.field_mode != 0 && self.unit.current_field_type != reference_field {
            vector[1] = vector[1] - 2 + 4 * current_field;
            chroma[1] = chroma[1] - 2 + 4 * current_field;
        }
        if self.sequence.fastuvmc != 0 {
            chroma = [round_away_from_zero_even(chroma[0]), round_away_from_zero_even(chroma[1])];
        }
        let luma_flags: u32 = self.operation_flags(LUMA_KIND_INTERPOLATED, 1, true, reference_field);
        self.write_luma_operation(1, luma_flags, vector);
        let chroma_flags: u32 = self.operation_flags(CHROMA_KIND_INTERPOLATED, 1, true, reference_field);
        self.write_chroma_operation(1, chroma_flags, chroma);
    }

    /// get_luma_mv: the luma vector of a field 4MV macroblock's chroma, from the field flags, and the opposite-field block count
    fn median_luma_vector(&self, direction: u32) -> ([i32; 2], u32) {
        let field_flags: u32 = self.records[self.current].field_flags;
        let mut index: u32 = 0;
        for block in 0..4 {
            index |= ((field_flags >> (direction * 8 + block)) & 1) << block;
        }
        let opposite_count: u32 = index.count_ones();
        let direction_index: usize = direction as usize;
        let vectors: [[i32; 2]; 4] = std::array::from_fn(|block: usize| self.current_motion_vector(direction_index, block));
        let result: [i32; 2] = match opposite_count {
            0 | 4 => [
                median_of_four(vectors[0][0], vectors[1][0], vectors[2][0], vectors[3][0]),
                median_of_four(vectors[0][1], vectors[1][1], vectors[2][1], vectors[3][1]),
            ],
            1 => median_vector(
                vectors[usize::from(index < 2)],
                vectors[1 + usize::from(index < 4)],
                vectors[2 + usize::from(index < 8)],
            ),
            3 => median_vector(
                vectors[usize::from(index > 0xD)],
                vectors[1 + usize::from(index > 0xB)],
                vectors[2 + usize::from(index > 0x7)],
            ),
            _ => {
                let pair: u8 = LUMA_MV_PAIRS[index as usize];
                let first: [i32; 2] = vectors[(pair >> 4) as usize];
                let second: [i32; 2] = vectors[(pair & 15) as usize];
                [(first[0] + second[0]) / 2, (first[1] + second[1]) / 2]
            }
        };
        (result, opposite_count)
    }

    /// get_chroma_mv: the luma vector of a 4MV macroblock's chroma from its inter blocks, and their count, 0 when no chroma prediction is made
    fn median_chroma_vector(&self, direction: u32) -> ([i32; 2], u32) {
        let flags: u32 = self.records[self.current].flags;
        let mut index: u32 = 0;
        for block in 0..4 {
            if (flags >> block) & 1 == 0 {
                index |= 1 << block;
            }
        }
        let valid_count: u32 = index.count_ones();
        let direction_index: usize = direction as usize;
        let vectors: [[i32; 2]; 4] = std::array::from_fn(|block: usize| self.current_motion_vector(direction_index, block));
        match valid_count {
            4 => (
                [
                    median_of_four(vectors[0][0], vectors[1][0], vectors[2][0], vectors[3][0]),
                    median_of_four(vectors[0][1], vectors[1][1], vectors[2][1], vectors[3][1]),
                ],
                4,
            ),
            3 => (
                median_vector(
                    vectors[usize::from(index > 0xD)],
                    vectors[1 + usize::from(index > 0xB)],
                    vectors[2 + usize::from(index > 0x7)],
                ),
                3,
            ),
            2 => {
                let pair: u8 = CHROMA_MV_PAIRS[index as usize];
                let first: [i32; 2] = vectors[(pair >> 4) as usize];
                let second: [i32; 2] = vectors[(pair & 15) as usize];
                ([(first[0] + second[0]) / 2, (first[1] + second[1]) / 2], 2)
            }
            _ => ([0, 0], 0),
        }
    }

    /// Records ff_vc1_mc_4mv_luma(v, n, dir, avg) and its side effects
    pub fn record_motion_4mv_luma(&mut self, block: u32, direction: u32, average: bool) {
        let mut vector: [i32; 2] = self.current_motion_vector(direction as usize, block as usize);
        let flags: u32 = self.records[self.current].flags;
        let field_motion: u32 = if self.unit.fcm == FCM_FRAME { (flags >> (MB_BLOCK_MV_TYPE_SHIFT + block)) & 1 } else { 0 };
        let reference_field: u32 = self.ref_field_type[direction as usize];
        if self.unit.field_mode != 0 && self.unit.current_field_type != reference_field {
            vector[1] = vector[1] - 2 + 4 * self.unit.current_field_type as i32;
        }
        if self.unit.picture_type == TYPE_P && block == 3 && self.unit.field_mode != 0 {
            let (median, opposite_count): ([i32; 2], u32) = self.median_luma_vector(0);
            self.records[self.current].motion_vectors[1][0] = pack_motion_vector(median);
            let opposite: u32 = u32::from(opposite_count > 2);
            for index in 0..4 {
                let grid_index: i32 = self.block_grid_index(index);
                self.set_grid_field_flag(1, grid_index, opposite);
            }
        }
        if self.unit.fcm == FCM_FRAME {
            if self.unit.picture_type == TYPE_P {
                self.set_current_motion_vectors_of_record(1, block as usize, vector);
            }
            // Pull back vectors that point too far outside the frame
            let width: i32 = self.sequence.coded_width as i32;
            let height: i32 = (self.sequence.coded_height >> 1) as i32;
            let source_x: i32 = self.mb_x as i32 * 16 + (vector[0] >> 2);
            let source_y: i32 = self.mb_y as i32 * 8 + (vector[1] >> 3);
            if source_x < -17 {
                vector[0] -= 4 * (source_x + 17);
            } else if source_x > width {
                vector[0] -= 4 * (source_x - width);
            }
            if source_y < -18 {
                vector[1] -= 8 * (source_y + 18);
            } else if source_y > height + 1 {
                vector[1] -= 8 * (source_y - height - 1);
            }
        }
        let mut operation: u32 = self.operation_flags(LUMA_KIND_4MV, direction, average, reference_field);
        if field_motion != 0 {
            operation |= OPERATION_FIELD_MV;
        }
        self.write_luma_operation(block * 2 + u32::from(average), operation, vector);
    }

    /// Records ff_vc1_mc_4mv_chroma(v, dir)
    pub fn record_motion_4mv_chroma(&mut self, direction: u32) {
        let luma: [i32; 2];
        let chroma_reference: u32;
        if self.unit.field_mode == 0 || self.unit.numref == 0 {
            let (median, valid_count): ([i32; 2], u32) = self.median_chroma_vector(direction);
            if valid_count == 0 {
                let record: &mut MacroblockRecord = &mut self.records[self.current];
                record.motion_vectors[1][0] = 0;
                record.loop_filter_chroma_mv = 0;
                return;
            }
            luma = median;
            chroma_reference = self.ref_field_type[direction as usize];
        } else {
            let (median, opposite_count): ([i32; 2], u32) = self.median_luma_vector(direction);
            luma = median;
            chroma_reference = self.unit.current_field_type ^ u32::from(opposite_count > 2);
        }
        self.records[self.current].motion_vectors[1][0] = pack_motion_vector(luma);
        let mut chroma: [i32; 2] = chroma_vector(luma);
        self.records[self.current].loop_filter_chroma_mv = pack_motion_vector(chroma);
        if self.sequence.fastuvmc != 0 {
            chroma = [round_toward_zero_even(chroma[0]), round_toward_zero_even(chroma[1])];
        }
        if self.unit.current_field_type != chroma_reference {
            chroma[1] += 2 - 4 * chroma_reference as i32;
        }
        let flags: u32 = self.operation_flags(CHROMA_KIND_4MV, direction, false, chroma_reference);
        self.write_chroma_operation(0, flags, chroma);
        if self.unit.field_mode != 0 {
            self.set_chroma_field_flags(direction, u32::from(self.unit.current_field_type != chroma_reference));
        }
    }

    /// Records ff_vc1_mc_4mv_chroma4(v, dir, dir2, avg): the four 4x4 chroma quarters of an interlaced frame macroblock
    pub fn record_motion_4mv_chroma4(&mut self, direction: u32, direction2: u32, average: bool) {
        let field_motion: u32 = (self.records[self.current].flags >> MB_BLOCK_MV_TYPE_SHIFT) & 1;
        for quarter in 0..4u32 {
            let source: u32 = if quarter < 2 { direction } else { direction2 };
            let vector: [i32; 2] = self.current_motion_vector(source as usize, quarter as usize);
            let chroma_y: i32 = if field_motion != 0 {
                (vector[1] >> 4) * 8 + FIELD_CHROMA_ROUNDING[(vector[1] & 15) as usize]
            } else {
                (vector[1] + i32::from(vector[1] & 3 == 3)) >> 1
            };
            let chroma: [i32; 2] = [(vector[0] + i32::from(vector[0] & 3 == 3)) >> 1, chroma_y];
            let mut flags: u32 =
                (CHROMA_KIND_QUARTER << OPERATION_KIND_SHIFT) | (if source != 0 { SOURCE_NEXT } else { SOURCE_LAST } << OPERATION_SOURCE_SHIFT);
            if average {
                flags |= OPERATION_AVERAGE;
            }
            if field_motion != 0 {
                flags |= OPERATION_FIELD_MV;
            }
            self.write_chroma_operation(quarter * 2 + u32::from(average), flags, chroma);
        }
    }

    fn reference_distance(&self, direction: u32) -> u32 {
        if self.unit.picture_type != TYPE_B {
            return self.unit.refdist;
        }
        if direction != 0 { self.unit.brfd } else { self.unit.frfd }
    }

    fn clamp_field_y(&self, value: i32, direction: u32) -> i32 {
        let half_range: i32 = self.unit.range_y as i32 / 2;
        if self.unit.current_field_type != 0 && self.ref_field_type[direction as usize] == 0 {
            return value.clamp(-half_range + 1, half_range);
        }
        value.clamp(-half_range, half_range - 1)
    }

    fn scale_for_same_component(&self, value: i32, dimension: u32, direction: u32) -> i32 {
        let table: u32 = direction ^ self.unit.second_field;
        let distance: u32 = self.reference_distance(direction);
        if dimension == 0 {
            let scaled: i32 = scale_zoned(
                value,
                SCALE_LIMIT_X,
                field_scale_value(table, SCALE_ZONE1_X, distance),
                field_scale_value(table, SCALE_SAME1, distance),
                field_scale_value(table, SCALE_SAME2, distance),
                field_scale_value(table, ZONE1_OFFSET_X, distance),
            );
            let range_x: i32 = self.unit.range_x as i32;
            return scaled.clamp(-range_x, range_x - 1);
        }
        let scaled: i32 = scale_zoned(
            value,
            SCALE_LIMIT_Y,
            field_scale_value(table, SCALE_ZONE1_Y, distance),
            field_scale_value(table, SCALE_SAME1, distance),
            field_scale_value(table, SCALE_SAME2, distance),
            field_scale_value(table, ZONE1_OFFSET_Y, distance),
        );
        self.clamp_field_y(scaled, direction)
    }

    fn scale_for_opposite_component(&self, value: i32, dimension: u32, direction: u32) -> i32 {
        let distance: u32 = self.unit.brfd.min(MAXIMUM_SCALE_DISTANCE);
        if dimension == 0 {
            let scaled: i32 = scale_zoned(
                value,
                SCALE_LIMIT_X,
                backward_field_scale_value(SCALE_ZONE1_X, distance),
                backward_field_scale_value(SCALE_SAME1, distance),
                backward_field_scale_value(SCALE_SAME2, distance),
                backward_field_scale_value(ZONE1_OFFSET_X, distance),
            );
            let range_x: i32 = self.unit.range_x as i32;
            return scaled.clamp(-range_x, range_x - 1);
        }
        let scaled: i32 = scale_zoned(
            value,
            SCALE_LIMIT_Y,
            backward_field_scale_value(SCALE_ZONE1_Y, distance),
            backward_field_scale_value(SCALE_SAME1, distance),
            backward_field_scale_value(SCALE_SAME2, distance),
            backward_field_scale_value(ZONE1_OFFSET_Y, distance),
        );
        self.clamp_field_y(scaled, direction)
    }

    /// FFmpeg's scaleforsame
    fn scale_for_same(&self, value: i32, dimension: u32, direction: u32) -> i32 {
        let half_pel: u32 = 1 - self.unit.quarter_sample;
        let component: i32 = value >> half_pel;
        if self.unit.picture_type != TYPE_B || self.unit.second_field != 0 || direction == 0 {
            return self.scale_for_same_component(component, dimension, direction) * (1 << half_pel);
        }
        let scale_same: i32 = backward_field_scale_value(SCALE_OPPOSITE, self.unit.brfd.min(MAXIMUM_SCALE_DISTANCE));
        ((component * scale_same) >> 8) * (1 << half_pel)
    }

    /// FFmpeg's scaleforopp
    fn scale_for_opposite(&self, value: i32, dimension: u32, direction: u32) -> i32 {
        let half_pel: u32 = 1 - self.unit.quarter_sample;
        let component: i32 = value >> half_pel;
        if self.unit.picture_type == TYPE_B && self.unit.second_field == 0 && direction == 1 {
            return self.scale_for_opposite_component(component, dimension, direction) * (1 << half_pel);
        }
        let scale_opposite: i32 = field_scale_value(direction ^ self.unit.second_field, SCALE_OPPOSITE, self.reference_distance(direction));
        ((component * scale_opposite) >> 8) * (1 << half_pel)
    }

    /// Whether grid block (column, row) lies in the picture: FFmpeg's padding column and the rows above read as zero
    fn grid_block_inside(&self, column: i32, row: i32) -> bool {
        column >= 0 && row >= 0 && column < self.mb_width as i32 * 2
    }

    /// The record of grid block (column, row) of the current field, and the block within it
    fn grid_block_record(&self, column: i32, row: i32) -> (&MacroblockRecord, usize) {
        let block: usize = ((column as u32 & 1) | ((row as u32 & 1) << 1)) as usize;
        (self.record(column as u32 >> 1, row as u32 >> 1), block)
    }

    /// FFmpeg's motion_val[0] of grid block (column, row) of a progressive picture
    fn progressive_grid_vector(&self, column: i32, row: i32) -> [i32; 2] {
        if !self.grid_block_inside(column, row) {
            return [0, 0];
        }
        let (record, block): (&MacroblockRecord, usize) = self.grid_block_record(column, row);
        unpack_motion_vector(record.motion_vectors[0][block])
    }

    /// FFmpeg's is_intra check of grid block (column, row) of a progressive picture
    fn progressive_grid_is_intra(&self, column: i32, row: i32) -> bool {
        if !self.grid_block_inside(column, row) {
            return false;
        }
        let (record, block): (&MacroblockRecord, usize) = self.grid_block_record(column, row);
        (record.flags >> block) & 1 != 0
    }

    /// Zeroes the vectors of an intra macroblock's block, as FFmpeg's predictors do for intra blocks
    fn clear_intra_vectors(&mut self, block: u32, whole_macroblock: bool) {
        self.set_current_motion_vector(0, block as usize, [0, 0]);
        let record: &mut MacroblockRecord = &mut self.records[self.current];
        record.motion_vectors[0][block as usize] = 0;
        record.motion_vectors[1][block as usize] = 0;
        if whole_macroblock {
            for other in 1..4 {
                record.motion_vectors[0][other] = 0;
                record.motion_vectors[1][other] = 0;
            }
            record.loop_filter_chroma_mv = 0;
        }
    }

    /// The B predictor's grid position of block n and whether it exists, the rest of FFmpeg's ff_vc1_pred_mv offsets
    fn predictor_b_position(&self, block: u32, column: i32, row: i32, one_vector: bool, mixed: bool, valid: bool) -> (i32, i32, bool) {
        let last_column: bool = self.mb_x == self.mb_width - 1;
        let mut b_column: i32 = column - 1;
        let mut b_row: i32 = row - 1;
        let mut b_valid: bool = valid;
        if one_vector {
            let step: i32 = if last_column { if mixed { -2 } else { -1 } } else { 2 };
            b_column = column + step;
            b_valid = b_valid && self.mb_width > 1;
            return (b_column, b_row, b_valid);
        }
        match block {
            0 => {
                if self.mb_x == 0 {
                    if self.sequence.res_rtm_flag != 0 {
                        b_column = column + 1;
                    } else {
                        // FFmpeg's offset of 2 * mb_width - wrap - 1 reaches the last block of the row above the previous row
                        b_column = self.mb_width as i32 * 2 - 1;
                        b_row = row - 2;
                    }
                }
            }
            1 => b_column = column + if last_column { -1 } else { 1 },
            2 => b_column = column + 1,
            _ => {}
        }
        (b_column, b_row, b_valid)
    }

    /// FFmpeg's ff_vc1_pred_mv for progressive P pictures: direction 0, and no field predictors, flags, or scaling
    pub fn predict_progressive_motion_vector(&mut self, block: u32, differential_input: [i32; 2], one_vector: bool) {
        if self.mb_intra {
            self.clear_intra_vectors(block, one_vector);
            return;
        }
        let mut differential: [i32; 2] = differential_input;
        if self.unit.quarter_sample == 0 {
            differential = [differential[0] * 2, differential[1] * 2];
        }
        let column: i32 = self.mb_x as i32 * 2 + (block & 1) as i32;
        let row: i32 = self.mb_y as i32 * 2 + (block >> 1) as i32;
        let a_valid: bool = !self.first_slice_line || block >= 2;
        let c_valid: bool = self.mb_x != 0 || block & 1 != 0;
        let (b_column, b_row, b_valid): (i32, i32, bool) = self.predictor_b_position(block, column, row, one_vector, false, a_valid);
        let predictor_a: [i32; 2] = if a_valid { self.progressive_grid_vector(column, row - 1) } else { [0, 0] };
        let predictor_b: [i32; 2] = if b_valid { self.progressive_grid_vector(b_column, b_row) } else { [0, 0] };
        let predictor_c: [i32; 2] = if c_valid { self.progressive_grid_vector(column - 1, row) } else { [0, 0] };
        let mut prediction: [i32; 2] = if a_valid {
            predictor_a
        } else if c_valid {
            predictor_c
        } else if b_valid {
            predictor_b
        } else {
            [0, 0]
        };
        if i32::from(a_valid) + i32::from(b_valid) + i32::from(c_valid) > 1 {
            prediction = median_vector(predictor_a, predictor_b, predictor_c);
        }
        // Pullback toward the picture
        let limit: i32 = if one_vector { -60 } else { -28 };
        let origin_x: i32 = ((self.mb_x as i32) << 6) + if block & 1 != 0 { 32 } else { 0 };
        let origin_y: i32 = ((self.mb_y as i32) << 6) + if block >= 2 { 32 } else { 0 };
        prediction = [
            (origin_x + prediction[0]).clamp(limit, ((self.mb_width as i32) << 6) - 4) - origin_x,
            (origin_y + prediction[1]).clamp(limit, ((self.mb_height as i32) << 6) - 4) - origin_y,
        ];
        // Hybrid prediction: a far predictor lets one bit pick A or C
        if a_valid && c_valid {
            let sum_a: i32 = if self.progressive_grid_is_intra(column, row - 1) {
                prediction[0].abs() + prediction[1].abs()
            } else {
                (prediction[0] - predictor_a[0]).abs() + (prediction[1] - predictor_a[1]).abs()
            };
            if sum_a > HYBRID_PREDICTION_THRESHOLD {
                prediction = if self.reader.read_flag() { predictor_a } else { predictor_c };
            } else {
                let sum_c: i32 = if self.progressive_grid_is_intra(column - 1, row) {
                    prediction[0].abs() + prediction[1].abs()
                } else {
                    (prediction[0] - predictor_c[0]).abs() + (prediction[1] - predictor_c[1]).abs()
                };
                if sum_c > HYBRID_PREDICTION_THRESHOLD {
                    prediction = if self.reader.read_flag() { predictor_a } else { predictor_c };
                }
            }
        }
        let range_x: i32 = self.unit.range_x as i32;
        let range_y: i32 = self.unit.range_y as i32;
        let vector: [i32; 2] = [
            wrap_into_range(prediction[0], differential[0], range_x),
            wrap_into_range(prediction[1], differential[1], range_y),
        ];
        let stored: [i32; 2] = wrap_vector(vector);
        self.set_current_motion_vector(0, block as usize, stored);
        self.ref_field_type[0] = self.unit.current_field_type;
        let packed: u32 = pack_motion_vector(stored);
        let record: &mut MacroblockRecord = &mut self.records[self.current];
        record.motion_vectors[0][block as usize] = packed;
        if one_vector {
            record.motion_vectors[0][1] = packed;
            record.motion_vectors[0][2] = packed;
            record.motion_vectors[0][3] = packed;
        }
    }

    /// The predictor of grid block (column, row) of the current field; the padding and the rows above read as zero
    fn field_predictor(&self, column: i32, row: i32, direction: u32) -> FieldPredictor {
        if !self.grid_block_inside(column, row) {
            return FieldPredictor { vector: [0, 0], field: 0, intra: false };
        }
        let (record, block): (&MacroblockRecord, usize) = self.grid_block_record(column, row);
        FieldPredictor {
            vector: unpack_motion_vector(record.motion_vectors[direction as usize][block]),
            field: (record.field_flags >> (direction * 8 + block as u32)) & 1,
            intra: (record.flags >> block) & 1 != 0,
        }
    }

    /// Sets mv_f of a block of the current macroblock in one direction
    fn set_staged_field_flag(&mut self, direction: u32, block: u32, value: u32) {
        let bit: u32 = 1 << (direction * 8 + block);
        let record: &mut MacroblockRecord = &mut self.records[self.current];
        if value != 0 {
            record.field_flags |= bit;
        } else {
            record.field_flags &= !bit;
        }
    }

    /// FFmpeg's ff_vc1_pred_mv for field pictures
    #[allow(clippy::too_many_arguments)]
    pub fn predict_motion_vector(
        &mut self,
        block: u32,
        differential_input: [i32; 2],
        one_vector: bool,
        range_x: i32,
        range_y_input: i32,
        predictor_flag: i32,
        direction: u32,
    ) {
        if self.mb_intra {
            self.clear_intra_vectors(block, one_vector);
            return;
        }
        let mut differential: [i32; 2] = differential_input;
        if self.unit.quarter_sample == 0 {
            differential = [differential[0] * 2, differential[1] * 2];
        }
        let column: i32 = self.mb_x as i32 * 2 + (block & 1) as i32;
        let row: i32 = self.mb_y as i32 * 2 + (block >> 1) as i32;
        let mut a_valid: bool = !self.first_slice_line || block >= 2;
        let mut c_valid: bool = self.mb_x != 0 || block & 1 != 0;
        let mixed: bool = self.is_mixed_motion_vector_mode();
        let (b_column, b_row, mut b_valid): (i32, i32, bool) = self.predictor_b_position(block, column, row, one_vector, mixed, a_valid);
        if !one_vector && self.mb_width == 1 {
            b_valid = b_valid && c_valid;
        }
        let read_a: FieldPredictor = self.field_predictor(column, row - 1, direction);
        let read_b: FieldPredictor = self.field_predictor(b_column, b_row, direction);
        let read_c: FieldPredictor = self.field_predictor(column - 1, row, direction);
        a_valid = a_valid && !read_a.intra;
        b_valid = b_valid && !read_b.intra;
        c_valid = c_valid && !read_c.intra;
        let mut predictor_a: [i32; 2] = if a_valid { read_a.vector } else { [0, 0] };
        let mut predictor_b: [i32; 2] = if b_valid { read_b.vector } else { [0, 0] };
        let mut predictor_c: [i32; 2] = if c_valid { read_c.vector } else { [0, 0] };
        let a_field: u32 = if a_valid { read_a.field } else { 0 };
        let b_field: u32 = if b_valid { read_b.field } else { 0 };
        let c_field: u32 = if c_valid { read_c.field } else { 0 };
        let valid_count: i32 = i32::from(a_valid) + i32::from(b_valid) + i32::from(c_valid);
        let opposite_count: i32 = (a_field + b_field + c_field) as i32;
        let same_count: i32 = valid_count - opposite_count;
        let opposite: u32 = if self.unit.numref == 0 {
            1 - self.unit.reffield
        } else if same_count <= opposite_count {
            1 - predictor_flag as u32
        } else {
            predictor_flag as u32
        };
        self.set_staged_field_flag(direction, block, opposite);
        self.ref_field_type[direction as usize] = self.unit.current_field_type ^ opposite;
        // Predictors from the other polarity than the chosen reference rescale to it
        if opposite != 0 {
            if a_valid && a_field == 0 {
                predictor_a = [self.scale_for_opposite(predictor_a[0], 0, direction), self.scale_for_opposite(predictor_a[1], 1, direction)];
            }
            if b_valid && b_field == 0 {
                predictor_b = [self.scale_for_opposite(predictor_b[0], 0, direction), self.scale_for_opposite(predictor_b[1], 1, direction)];
            }
            if c_valid && c_field == 0 {
                predictor_c = [self.scale_for_opposite(predictor_c[0], 0, direction), self.scale_for_opposite(predictor_c[1], 1, direction)];
            }
        } else {
            if a_valid && a_field != 0 {
                predictor_a = [self.scale_for_same(predictor_a[0], 0, direction), self.scale_for_same(predictor_a[1], 1, direction)];
            }
            if b_valid && b_field != 0 {
                predictor_b = [self.scale_for_same(predictor_b[0], 0, direction), self.scale_for_same(predictor_b[1], 1, direction)];
            }
            if c_valid && c_field != 0 {
                predictor_c = [self.scale_for_same(predictor_c[0], 0, direction), self.scale_for_same(predictor_c[1], 1, direction)];
            }
        }
        // FFmpeg keeps the field predictors in int16_t
        predictor_a = wrap_vector(predictor_a);
        predictor_b = wrap_vector(predictor_b);
        predictor_c = wrap_vector(predictor_c);
        let mut prediction: [i32; 2] = if a_valid {
            predictor_a
        } else if c_valid {
            predictor_c
        } else if b_valid {
            predictor_b
        } else {
            [0, 0]
        };
        if valid_count > 1 {
            prediction = median_vector(predictor_a, predictor_b, predictor_c);
        }
        // Hybrid prediction of field P pictures; their valid A and C are never intra, so FFmpeg's intra tests of them always fail
        if self.unit.picture_type != TYPE_B && a_valid && c_valid {
            let far_from_a: bool = (prediction[0] - predictor_a[0]).abs() + (prediction[1] - predictor_a[1]).abs() > HYBRID_PREDICTION_THRESHOLD;
            if far_from_a || (prediction[0] - predictor_c[0]).abs() + (prediction[1] - predictor_c[1]).abs() > HYBRID_PREDICTION_THRESHOLD {
                prediction = if self.reader.read_flag() { predictor_a } else { predictor_c };
            }
        }
        let mut range_y: i32 = range_y_input;
        if self.unit.numref != 0 {
            range_y >>= 1;
        }
        let bias: i32 = i32::from(self.unit.current_field_type != 0 && self.ref_field_type[direction as usize] == 0);
        let vector: [i32; 2] = [
            wrap_into_range(prediction[0], differential[0], range_x),
            ((prediction[1] + differential[1] + range_y - bias) & ((range_y << 1) - 1)) - range_y + bias,
        ];
        let stored: [i32; 2] = wrap_vector(vector);
        self.set_current_motion_vector(direction as usize, block as usize, stored);
        let packed: u32 = pack_motion_vector(stored);
        self.records[self.current].motion_vectors[direction as usize][block as usize] = packed;
        if one_vector {
            for other in 1..4u32 {
                self.records[self.current].motion_vectors[direction as usize][other as usize] = packed;
                self.set_staged_field_flag(direction, other, opposite);
            }
        }
    }

    /// Whether a block of a macroblock carries a field motion vector, FFmpeg's blk_mv_type
    fn block_field_motion(record: &MacroblockRecord, block: u32) -> bool {
        (record.flags >> (MB_BLOCK_MV_TYPE_SHIFT + block)) & 1 != 0
    }

    fn record_vector(record: &MacroblockRecord, block: u32, direction: u32) -> [i32; 2] {
        unpack_motion_vector(record.motion_vectors[direction as usize][block as usize])
    }

    /// FFmpeg's ff_vc1_pred_mv_intfr for interlaced frame pictures; mvn is 1 for 1MV and 2 for 2MV field macroblocks
    pub fn predict_interlaced_frame_motion_vector(&mut self, block: u32, differential: [i32; 2], mvn: u32, direction: u32) {
        if self.mb_intra {
            self.clear_intra_vectors(block, mvn == 1);
            return;
        }
        let current: MacroblockRecord = self.records[self.current];
        let current_field_motion: bool = Self::block_field_motion(&current, block);
        let mut a: [i32; 2] = [0, 0];
        let mut b: [i32; 2] = [0, 0];
        let mut c: [i32; 2] = [0, 0];
        let mut a_valid: bool = false;
        let mut b_valid: bool = false;
        let mut c_valid: bool = false;
        // A: the left block and, for a field-motion left neighbor under a frame-motion block, the block in its other row
        if self.mb_x != 0 || block & 1 != 0 {
            let first: [i32; 2];
            let second: [i32; 2];
            let left_field_motion: bool;
            let mut left_intra: bool = false;
            if block & 1 != 0 {
                first = Self::record_vector(&current, block - 1, direction);
                second = Self::record_vector(&current, if block == 1 { 2 } else { 0 }, direction);
                left_field_motion = Self::block_field_motion(&current, block - 1);
            } else {
                let left: &MacroblockRecord = self.record(self.mb_x - 1, self.mb_y);
                first = Self::record_vector(left, block + 1, direction);
                second = Self::record_vector(left, if block == 0 { 3 } else { 1 }, direction);
                left_field_motion = Self::block_field_motion(left, block + 1);
                left_intra = left.is_intra != 0;
            }
            a = if current_field_motion || !left_field_motion { first } else { average_vectors(first, second) };
            a_valid = !left_intra;
            if left_intra {
                a = [0, 0];
            }
        }
        if block < 2 || current_field_motion {
            if !self.first_slice_line {
                // B: the macroblock above, its other row averaged in when only it has field motion
                let top: &MacroblockRecord = self.record(self.mb_x, self.mb_y - 1);
                if top.is_intra == 0 {
                    b_valid = true;
                    let top_field_motion: bool = Self::block_field_motion(top, block | 2);
                    let adjacent: u32 = if top_field_motion && current_field_motion { block } else { block | 2 };
                    b = Self::record_vector(top, adjacent, direction);
                    if top_field_motion && !current_field_motion {
                        b = average_vectors(b, Self::record_vector(top, adjacent ^ 2, direction));
                    }
                }
                // C: the macroblock above right, or above left in the last column, where above right is FFmpeg's zero padding
                if self.mb_width > 1 {
                    let right_exists: bool = self.mb_x + 1 < self.mb_width;
                    let top_right: &MacroblockRecord = self.record((self.mb_x + 1).min(self.mb_width - 1), self.mb_y - 1);
                    if !right_exists || top_right.is_intra == 0 {
                        c_valid = true;
                        if right_exists {
                            let right_field_motion: bool = Self::block_field_motion(top_right, 2);
                            let adjacent: u32 = if right_field_motion && current_field_motion { block & 2 } else { 2 };
                            c = Self::record_vector(top_right, adjacent, direction);
                            if right_field_motion && !current_field_motion {
                                c = average_vectors(c, Self::record_vector(top_right, adjacent ^ 2, direction));
                            }
                        }
                        if self.mb_x == self.mb_width - 1 {
                            let top_left: &MacroblockRecord = self.record(self.mb_x - 1, self.mb_y - 1);
                            c_valid = top_left.is_intra == 0;
                            if c_valid {
                                let left_field_motion: bool = Self::block_field_motion(top_left, 3);
                                let adjacent: u32 = if left_field_motion && current_field_motion { block | 1 } else { 3 };
                                c = Self::record_vector(top_left, adjacent, direction);
                                if left_field_motion && !current_field_motion {
                                    c = average_vectors(c, Self::record_vector(top_left, 1, direction));
                                }
                            }
                        }
                    }
                }
            }
        } else {
            b_valid = true;
            b = Self::record_vector(&current, 1, direction);
            c_valid = true;
            c = Self::record_vector(&current, 0, direction);
        }
        let total_valid: i32 = i32::from(a_valid) + i32::from(b_valid) + i32::from(c_valid);
        if self.mb_x == 0 && !(block == 1 || block == 3) {
            a = [0, 0];
        }
        if self.first_slice_line && (current_field_motion || block & 2 == 0) {
            b = [0, 0];
            c = [0, 0];
        }
        let mut prediction: [i32; 2] = [0, 0];
        if !current_field_motion {
            if self.mb_width == 1 {
                prediction = b;
            } else if total_valid >= 2 {
                prediction = median_vector(a, b, c);
            } else if total_valid != 0 {
                prediction = if a_valid {
                    a
                } else if b_valid {
                    b
                } else {
                    c
                };
            }
        } else {
            let field_a: i32 = i32::from(a_valid && a[1] & 4 != 0);
            let field_b: i32 = i32::from(b_valid && b[1] & 4 != 0);
            let field_c: i32 = i32::from(c_valid && c[1] & 4 != 0);
            let opposite_count: i32 = field_a + field_b + field_c;
            let same_count: i32 = total_valid - opposite_count;
            match total_valid {
                3 => {
                    if same_count == 3 || opposite_count == 3 {
                        prediction = median_vector(a, b, c);
                    } else if same_count >= opposite_count {
                        prediction = if field_a == 0 { a } else { b };
                    } else {
                        prediction = if field_a != 0 { a } else { b };
                    }
                }
                2 => {
                    if same_count >= opposite_count {
                        prediction = if field_a == 0 && a_valid {
                            a
                        } else if field_b == 0 && b_valid {
                            b
                        } else {
                            c
                        };
                    } else {
                        prediction = if field_a != 0 && a_valid { a } else { b };
                    }
                }
                1 => {
                    prediction = if a_valid {
                        a
                    } else if b_valid {
                        b
                    } else {
                        c
                    };
                }
                _ => {}
            }
        }
        let range_x: i32 = self.unit.range_x as i32;
        let range_y: i32 = self.unit.range_y as i32;
        let vector: [i32; 2] = [
            wrap_into_range(prediction[0], differential[0], range_x),
            wrap_into_range(prediction[1], differential[1], range_y),
        ];
        let stored: [i32; 2] = wrap_vector(vector);
        let packed: u32 = pack_motion_vector(stored);
        self.set_current_motion_vector(direction as usize, block as usize, stored);
        let record: &mut MacroblockRecord = &mut self.records[self.current];
        record.motion_vectors[direction as usize][block as usize] = packed;
        match mvn {
            1 => {
                record.motion_vectors[direction as usize][1] = packed;
                record.motion_vectors[direction as usize][2] = packed;
                record.motion_vectors[direction as usize][3] = packed;
            }
            2 => {
                record.motion_vectors[direction as usize][block as usize + 1] = packed;
                self.set_current_motion_vector(direction as usize, block as usize + 1, stored);
            }
            _ => {}
        }
    }

    /// FFmpeg's scale_mv for B picture direct prediction
    fn scale_direct_vector(&self, value: i32, inverse: bool) -> i32 {
        let mut fraction: i32 = self.unit.bfraction;
        if inverse {
            fraction -= BFRACTION_ONE;
        }
        if self.unit.quarter_sample == 0 {
            return 2 * ((value * fraction + 255) >> 9);
        }
        (value * fraction + 128) >> 8
    }

    /// The next anchor's words for a block of the current macroblock: its vector of block 0 or 2, and its flags
    fn anchor_words(&self) -> [u32; ANCHOR_WORDS_PER_MACROBLOCK] {
        let index: usize = ((self.mb_y + self.unit.row_offset) * self.mb_width + self.mb_x) as usize * ANCHOR_WORDS_PER_MACROBLOCK;
        match self.anchor_motion.get(index..index + ANCHOR_WORDS_PER_MACROBLOCK) {
            Some(words) => [words[0], words[1], words[2]],
            None => [0; ANCHOR_WORDS_PER_MACROBLOCK],
        }
    }

    /// The next anchor's motion vector of block 0 or block 2 of the colocated macroblock
    fn anchor_motion_vector(&self, block: u32) -> [i32; 2] {
        let words: [u32; ANCHOR_WORDS_PER_MACROBLOCK] = self.anchor_words();
        unpack_motion_vector(if block == 2 { words[1] } else { words[0] })
    }

    fn scaled_direct_vectors(&self, colocated: [i32; 2]) -> ([i32; 2], [i32; 2]) {
        let forward: [i32; 2] = [self.scale_direct_vector(colocated[0], false), self.scale_direct_vector(colocated[1], false)];
        let backward: [i32; 2] = [self.scale_direct_vector(colocated[0], true), self.scale_direct_vector(colocated[1], true)];
        (forward, backward)
    }

    /// FFmpeg's ff_vc1_pred_b_mv for progressive B pictures
    pub fn predict_b_motion_vector(&mut self, differential_x: [i32; 2], differential_y: [i32; 2], direct: bool, motion_type: u32) {
        let mut dx: [i32; 2] = differential_x;
        let mut dy: [i32; 2] = differential_y;
        let range_x: i32 = self.unit.range_x as i32;
        let range_y: i32 = self.unit.range_y as i32;
        if self.unit.quarter_sample == 0 {
            dx = [dx[0] * 2, dx[1] * 2];
            dy = [dy[0] * 2, dy[1] * 2];
        }
        let xy: i32 = self.block_grid_index(0);
        if self.mb_intra {
            self.set_grid_motion_vector(0, xy, [0, 0]);
            self.set_grid_motion_vector(1, xy, [0, 0]);
            return;
        }
        let (mut forward, mut backward): ([i32; 2], [i32; 2]) = self.scaled_direct_vectors(self.anchor_motion_vector(0));
        let low_x: i32 = -60 - ((self.mb_x as i32) << 6);
        let high_x: i32 = ((self.mb_width as i32) << 6) - 4 - ((self.mb_x as i32) << 6);
        let low_y: i32 = -60 - ((self.mb_y as i32) << 6);
        let high_y: i32 = ((self.mb_height as i32) << 6) - 4 - ((self.mb_y as i32) << 6);
        forward = [forward[0].clamp(low_x, high_x), forward[1].clamp(low_y, high_y)];
        backward = [backward[0].clamp(low_x, high_x), backward[1].clamp(low_y, high_y)];
        self.set_current_motion_vector(0, 0, wrap_vector(forward));
        self.set_current_motion_vector(1, 0, wrap_vector(backward));
        if direct {
            self.set_grid_motion_vector(0, xy, self.current_motion_vector(0, 0));
            self.set_grid_motion_vector(1, xy, self.current_motion_vector(1, 0));
            return;
        }
        for direction in 0..2u32 {
            let wanted: bool = if direction != 0 {
                motion_type == BMV_BACKWARD || motion_type == BMV_INTERPOLATED
            } else {
                motion_type == BMV_FORWARD || motion_type == BMV_INTERPOLATED
            };
            if !wanted {
                continue;
            }
            let direction_index: usize = direction as usize;
            let mut c: [i32; 2] = self.grid_motion_vector(direction_index, xy - 2);
            let a: [i32; 2] = self.grid_motion_vector(direction_index, xy - GRID_STRIDE * 2);
            let offset: i32 = if self.mb_x == self.mb_width - 1 { -2 } else { 2 };
            let b: [i32; 2] = self.grid_motion_vector(direction_index, xy - GRID_STRIDE * 2 + offset);
            if self.mb_x == 0 {
                c = [0, 0];
            }
            let mut prediction: [i32; 2] = [0, 0];
            if !self.first_slice_line {
                prediction = if self.mb_width == 1 { a } else { median_vector(a, b, c) };
            } else if self.mb_x != 0 {
                prediction = c;
            }
            let shift: u32 = if self.sequence.profile < PROFILE_ADVANCED { 5 } else { 6 };
            let limit: i32 = 4 - (1 << shift);
            let origin_x: i32 = (self.mb_x as i32) << shift;
            let origin_y: i32 = (self.mb_y as i32) << shift;
            let maximum_x: i32 = ((self.mb_width as i32) << shift) - 4;
            let maximum_y: i32 = ((self.mb_height as i32) << shift) - 4;
            if origin_x + prediction[0] < limit {
                prediction[0] = limit - origin_x;
            }
            if origin_y + prediction[1] < limit {
                prediction[1] = limit - origin_y;
            }
            if origin_x + prediction[0] > maximum_x {
                prediction[0] = maximum_x - origin_x;
            }
            if origin_y + prediction[1] > maximum_y {
                prediction[1] = maximum_y - origin_y;
            }
            let differential: [i32; 2] = [dx[direction_index], dy[direction_index]];
            let vector: [i32; 2] = [
                wrap_into_range(prediction[0], differential[0], range_x),
                wrap_into_range(prediction[1], differential[1], range_y),
            ];
            self.set_current_motion_vector(direction_index, 0, wrap_vector(vector));
        }
        self.set_grid_motion_vector(0, xy, self.current_motion_vector(0, 0));
        self.set_grid_motion_vector(1, xy, self.current_motion_vector(1, 0));
    }

    /// FFmpeg's ff_vc1_pred_b_mv_intfi for field B pictures
    pub fn predict_field_b_motion_vector(&mut self, block: u32, differential_x: [i32; 2], differential_y: [i32; 2], one_vector: bool, predictor_flags: [i32; 2]) {
        let direction: u32 = u32::from(self.b_motion_type == BMV_BACKWARD);
        if self.b_motion_type == BMV_DIRECT {
            let mut forward: [i32; 2] = [0, 0];
            let mut backward: [i32; 2] = [0, 0];
            let mut opposite: u32 = 0;
            let words: [u32; ANCHOR_WORDS_PER_MACROBLOCK] = self.anchor_words();
            if words[2] & ANCHOR_INTRA == 0 {
                (forward, backward) = self.scaled_direct_vectors(unpack_motion_vector(words[0]));
                let opposite_total: u32 = (words[2] & crate::plan::ANCHOR_FIELD_FLAGS_MASK).count_ones();
                opposite = u32::from(opposite_total > 2);
            }
            forward = wrap_vector(forward);
            backward = wrap_vector(backward);
            self.set_current_motion_vector(0, 0, forward);
            self.set_current_motion_vector(1, 0, backward);
            self.ref_field_type[0] = self.unit.current_field_type ^ opposite;
            self.ref_field_type[1] = self.unit.current_field_type ^ opposite;
            for index in 0..4 {
                let grid_index: i32 = self.block_grid_index(index);
                self.set_grid_motion_vector(0, grid_index, forward);
                self.set_grid_motion_vector(1, grid_index, backward);
                self.set_grid_field_flag(0, grid_index, opposite);
                self.set_grid_field_flag(1, grid_index, opposite);
            }
            return;
        }
        // The predictions in FFmpeg's order: both directions of an interpolated macroblock, else the coded direction, then the other
        // direction's 1MV prediction once the macroblock's last vector is in
        let interpolated: bool = self.b_motion_type == BMV_INTERPOLATED;
        let first_direction: u32 = if interpolated { 0 } else { direction };
        let count: u32 = if interpolated || block == 3 || one_vector { 2 } else { 1 };
        let range_x: i32 = self.unit.range_x as i32;
        let range_y: i32 = self.unit.range_y as i32;
        for index in 0..count {
            let prediction_direction: u32 = if index == 0 { first_direction } else { 1 - first_direction };
            let prediction_block: u32 = if index == 0 && !interpolated { block } else { 0 };
            let block_is_one_vector: bool = interpolated || index != 0 || one_vector;
            let mut flag: i32 = predictor_flags[prediction_direction as usize];
            if index != 0 && !interpolated {
                flag = 0;
            }
            let differential: [i32; 2] = [differential_x[prediction_direction as usize], differential_y[prediction_direction as usize]];
            self.predict_motion_vector(prediction_block, differential, block_is_one_vector, range_x, range_y, flag, prediction_direction);
        }
    }

    /// The direct prediction of an interlaced frame B macroblock from the next anchor's colocated vectors
    pub fn predict_interlaced_frame_direct(&mut self, two_motion_vectors: bool) {
        let (forward, backward): ([i32; 2], [i32; 2]) = self.scaled_direct_vectors(self.anchor_motion_vector(0));
        self.set_current_motion_vector(0, 0, wrap_vector(forward));
        self.set_current_motion_vector(1, 0, wrap_vector(backward));
        let first_index: i32 = self.block_grid_index(0);
        self.set_grid_motion_vector(0, first_index, self.current_motion_vector(0, 0));
        self.set_grid_motion_vector(1, first_index, self.current_motion_vector(1, 0));
        if two_motion_vectors {
            let (second_forward, second_backward): ([i32; 2], [i32; 2]) = self.scaled_direct_vectors(self.anchor_motion_vector(2));
            self.set_current_motion_vector(0, 2, wrap_vector(second_forward));
            self.set_current_motion_vector(1, 2, wrap_vector(second_backward));
            let second_index: i32 = self.block_grid_index(2);
            self.set_grid_motion_vector(0, second_index, self.current_motion_vector(0, 2));
            self.set_grid_motion_vector(1, second_index, self.current_motion_vector(1, 2));
            for block in [1u32, 3] {
                for direction in 0..2usize {
                    let vector: [i32; 2] = self.current_motion_vector(direction, block as usize - 1);
                    self.set_current_motion_vector(direction, block as usize, vector);
                    let index: i32 = self.block_grid_index(block);
                    self.set_grid_motion_vector(direction, index, vector);
                }
            }
            return;
        }
        for block in 1..4u32 {
            for direction in 0..2usize {
                let vector: [i32; 2] = self.current_motion_vector(direction, 0);
                self.set_current_motion_vector(direction, block as usize, vector);
                let index: i32 = self.block_grid_index(block);
                self.set_grid_motion_vector(direction, index, vector);
            }
        }
    }
}
