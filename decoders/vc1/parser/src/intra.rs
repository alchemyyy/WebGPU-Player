// Intra prediction of each intra block as its macroblock finishes: the DC and AC prediction, scan, and dequantization FFmpeg's
// vc1_decode_i_block, vc1_decode_i_block_adv, and vc1_decode_intra_block do inline. The macroblock layer left each intra block's DC
// differential and its AC levels by scan index, since no bit they read depends on prediction, and every neighbor prediction reads,
// left, top, and top-left, precedes the macroblock in raster order within its unit.

use crate::layout::{COEFFICIENT_POSITION_SHIFT, FCM_FRAME, FCM_PROGRESSIVE, MACROBLOCK_SLICE_TOP_BIT, PROFILE_ADVANCED};
use crate::tables::{DC_PREDICTION, DQSCALE, SCAN_8X8, WMV3_DC_SCALE};
use crate::unit::{BLOCK_COUNT, MB_ACPRED_BIT, MB_DECODED_BIT, MB_INTRA_CODED_SHIFT, MacroblockRecord, UnitParser, wrap_int16};

// The intra prediction variants: FFmpeg's vc1_decode_i_block, vc1_decode_i_block_adv, and vc1_decode_intra_block
#[derive(Clone, Copy, PartialEq, Eq)]
enum IntraVariant {
    Simple,
    Advanced,
    InterPicture,
}

// The prediction directions: from the block above, or from the block to the left
const DIRECTION_TOP: u32 = 0;
const DIRECTION_LEFT: u32 = 1;
// The 8x8 scans of SCAN_8X8: normal inter, normal intra, horizontal intra, vertical intra, and interlaced
const SCAN_NORMAL_INTER: u32 = 0;
const SCAN_NORMAL_INTRA: u32 = 1;
const SCAN_HORIZONTAL: u32 = 2;
const SCAN_VERTICAL: u32 = 3;
const SCAN_INTERLACED: u32 = 4;
const SCAN_LENGTH: u32 = 64;
// Halves of a block's prediction record: the DC level, the first column's AC levels at 1 to 7, and the first row's at 9 to 15
const PREDICTION_DC: u32 = 0;
const PREDICTION_ROW_HALF_OFFSET: u32 = 8;
const LANE_COUNT: usize = 8;
// The picture quantizer above which Simple and Main I pictures overlap, which drops their outer DC predictor
const OVERLAP_PQUANT_LIMIT: u32 = 9;
// Rounding and shift of a rescaled predictor, 2^18 fixed point
const RESCALE_ROUNDING: u32 = 0x20000;
const RESCALE_SHIFT: u32 = 18;
const POSITION_MASK: u32 = 63;

/// The block a prediction reads to the left or above, as FFmpeg's dc_val[-1] and dc_val[-wrap] address it: its macroblock, its block,
/// and whether it lies in the picture.
#[derive(Clone, Copy)]
struct NeighborBlock {
    column: u32,
    row: u32,
    block: usize,
    current: bool,
    inside: bool,
}

const OUTSIDE: NeighborBlock = NeighborBlock { column: 0, row: 0, block: 0, current: false, inside: false };

/// One half of a prediction record word: its low half for even halves, its high half for odd ones, sign-extended.
fn prediction_half(record: &MacroblockRecord, block: usize, half: u32) -> i32 {
    let word: u32 = record.predictions[block][(half / 2) as usize];
    ((word << (16 - (half & 1) * 16)) as i32) >> 16
}

fn pack_halves(low: i32, high: i32) -> u32 {
    (low as u32 & 0xFFFF) | ((high as u32) << 16)
}

/// A neighbor's DC predictor rescaled from its macroblock's quantizer to quantizer
fn scale_dc_predictor(value: i32, neighbor_quantizer: i32, quantizer: u32) -> i32 {
    let neighbor: u32 = neighbor_quantizer.unsigned_abs();
    if neighbor == 0 || neighbor == quantizer {
        return value;
    }
    let scale_index: usize = WMV3_DC_SCALE[quantizer as usize] as usize - 1;
    let product: u32 = (value as u32)
        .wrapping_mul(u32::from(WMV3_DC_SCALE[neighbor as usize]))
        .wrapping_mul(DQSCALE[scale_index])
        .wrapping_add(RESCALE_ROUNDING);
    (product as i32) >> RESCALE_SHIFT
}

/// The rescaled AC predictor of FFmpeg's "scale predictors if needed" loops
fn scale_ac_predictor(value: i32, current_scale: i32, neighbor_scale: i32) -> i32 {
    if neighbor_scale != 0 && current_scale != neighbor_scale {
        let product: u32 = (value as u32)
            .wrapping_mul(neighbor_scale as u32)
            .wrapping_mul(DQSCALE[(current_scale - 1) as usize])
            .wrapping_add(RESCALE_ROUNDING);
        return (product as i32) >> RESCALE_SHIFT;
    }
    value
}

impl UnitParser<'_> {
    fn neighbor_block(&self, block: usize, direction: u32) -> NeighborBlock {
        let (column, row): (u32, u32) = (self.mb_x, self.mb_y);
        if block >= 4 {
            // Chroma blocks sit on the macroblock grid
            if direction == DIRECTION_LEFT {
                if column == 0 {
                    return OUTSIDE;
                }
                return NeighborBlock { column: column - 1, row, block, current: false, inside: true };
            }
            if row == 0 {
                return OUTSIDE;
            }
            return NeighborBlock { column, row: row - 1, block, current: false, inside: true };
        }
        if direction == DIRECTION_LEFT {
            if block & 1 != 0 {
                return NeighborBlock { column, row, block: block - 1, current: true, inside: true };
            }
            if column == 0 {
                return OUTSIDE;
            }
            return NeighborBlock { column: column - 1, row, block: block + 1, current: false, inside: true };
        }
        if block & 2 != 0 {
            return NeighborBlock { column, row, block: block - 2, current: true, inside: true };
        }
        if row == 0 {
            return OUTSIDE;
        }
        NeighborBlock { column, row: row - 1, block: block + 2, current: false, inside: true }
    }

    /// The top-left neighbor, dc_val[-1 - wrap]
    fn top_left_block(&self, block: usize) -> NeighborBlock {
        let (column, row): (u32, u32) = (self.mb_x, self.mb_y);
        if block >= 4 {
            if column == 0 || row == 0 {
                return OUTSIDE;
            }
            return NeighborBlock { column: column - 1, row: row - 1, block, current: false, inside: true };
        }
        match block {
            0 => {
                if column == 0 || row == 0 {
                    return OUTSIDE;
                }
                NeighborBlock { column: column - 1, row: row - 1, block: 3, current: false, inside: true }
            }
            1 => {
                if row == 0 {
                    return OUTSIDE;
                }
                NeighborBlock { column, row: row - 1, block: 2, current: false, inside: true }
            }
            2 => {
                if column == 0 {
                    return OUTSIDE;
                }
                NeighborBlock { column: column - 1, row, block: 1, current: false, inside: true }
            }
            _ => NeighborBlock { column, row, block: 0, current: true, inside: true },
        }
    }

    fn neighbor_record(&self, neighbor: &NeighborBlock) -> &MacroblockRecord {
        if neighbor.current {
            return &self.records[self.current];
        }
        self.record(neighbor.column, neighbor.row)
    }

    fn neighbor_dc(&self, neighbor: &NeighborBlock) -> i32 {
        if !neighbor.inside {
            return 0;
        }
        prediction_half(self.neighbor_record(neighbor), neighbor.block, PREDICTION_DC)
    }

    /// Whether a neighbor block exists and is intra, FFmpeg's mb_type check of a_avail and c_avail
    fn neighbor_is_intra(&self, neighbor: &NeighborBlock) -> bool {
        neighbor.inside && (self.neighbor_record(neighbor).flags >> neighbor.block) & 1 != 0
    }

    /// The signed quantizer of a macroblock of the current field, FFmpeg's qscale_table
    fn quantizer_at(&self, column: u32, row: u32) -> i32 {
        self.record(column, row).quantizer
    }

    /// FFmpeg's vc1_i_pred_dc for Simple and Main profile I pictures: the prediction and its direction
    fn predict_simple_dc(&self, block: usize, first_line: bool, dc_scale: u32) -> (i32, u32) {
        let mut c: i32 = self.neighbor_dc(&self.neighbor_block(block, DIRECTION_LEFT));
        let mut b: i32 = self.neighbor_dc(&self.top_left_block(block));
        let mut a: i32 = self.neighbor_dc(&self.neighbor_block(block, DIRECTION_TOP));
        let outer: i32 = if self.unit.pq < OVERLAP_PQUANT_LIMIT || self.sequence.overlap == 0 { DC_PREDICTION[dc_scale as usize] as i32 } else { 0 };
        if first_line && block != 2 && block != 3 {
            b = outer;
            a = outer;
        }
        if self.mb_x == 0 && block != 1 && block != 3 {
            b = outer;
            c = outer;
        }
        if (a - b).abs() <= (b - c).abs() {
            return (c, DIRECTION_LEFT);
        }
        (a, DIRECTION_TOP)
    }

    /// FFmpeg's ff_vc1_pred_dc; top and left are a_avail and c_avail
    fn predict_dc(&self, block: usize, top: bool, left: bool) -> (i32, u32) {
        let current_quantizer: u32 = self.records[self.current].quantizer.unsigned_abs();
        if WMV3_DC_SCALE[current_quantizer as usize] == 0 {
            return (0, DIRECTION_LEFT);
        }
        let mut c: i32 = self.neighbor_dc(&self.neighbor_block(block, DIRECTION_LEFT));
        let mut b: i32 = self.neighbor_dc(&self.top_left_block(block));
        let mut a: i32 = self.neighbor_dc(&self.neighbor_block(block, DIRECTION_TOP));
        if left && block != 1 && block != 3 {
            c = scale_dc_predictor(c, self.quantizer_at(self.mb_x.wrapping_sub(1), self.mb_y), current_quantizer);
        }
        if top && block != 2 && block != 3 {
            a = scale_dc_predictor(a, self.quantizer_at(self.mb_x, self.mb_y.wrapping_sub(1)), current_quantizer);
        }
        if top && left && block != 3 {
            let column: u32 = if block != 1 { self.mb_x.wrapping_sub(1) } else { self.mb_x };
            let row: u32 = if block != 2 { self.mb_y.wrapping_sub(1) } else { self.mb_y };
            b = scale_dc_predictor(b, self.quantizer_at(column, row), current_quantizer);
        }
        if left && (!top || (a - b).abs() <= (b - c).abs()) {
            return (c, DIRECTION_LEFT);
        }
        if top {
            return (a, DIRECTION_TOP);
        }
        (0, DIRECTION_LEFT)
    }

    /// The quantizer step of a signed macroblock quantizer, as AC prediction scales by it: |q| * 2 plus HALFQP for picture quantizers, less one
    fn predictor_scale(&self, quantizer: i32) -> i32 {
        quantizer.abs() * 2 + if quantizer < 0 { 0 } else { self.unit.halfpq as i32 } - 1
    }

    /// The quantizer of the neighbor a block's AC prediction reads, FFmpeg's q2; 0 when that neighbor is missing
    fn predictor_neighbor_quantizer(&self, block: usize, direction: u32, top: bool, left: bool, quantizer: i32) -> i32 {
        if block == 3 {
            return quantizer;
        }
        if direction == DIRECTION_LEFT {
            if block == 1 {
                return quantizer;
            }
            if left && (self.mb_x != 0 || self.mb_y != 0) {
                return self.quantizer_at(self.mb_x.wrapping_sub(1), self.mb_y);
            }
            return 0;
        }
        if block == 2 {
            return quantizer;
        }
        if top && self.mb_y != 0 {
            return self.quantizer_at(self.mb_x, self.mb_y - 1);
        }
        0
    }

    /// A dequantized AC level as FFmpeg's "scale AC coeffs" loops leave it; zero_check_first tests the level before scaling, as coded blocks do
    fn dequantize_level(&self, level: i32, scale: i32, quant: i32, zero_check_first: bool) -> i32 {
        if zero_check_first && level == 0 {
            return 0;
        }
        let mut value: i32 = wrap_int16(level.wrapping_mul(scale));
        if self.unit.pquantizer == 0 && value != 0 {
            value = wrap_int16(value + if value < 0 { -quant } else { quant });
        }
        value
    }

    /// Predicts, scans, and dequantizes intra block n of the current macroblock in place: its entries hold AC levels by scan index and
    /// its DC predictor half the DC differential, and they leave as the reconstruction reads them, with the predictors its neighbors read
    fn predict_intra_block(&mut self, block: usize, variant: IntraVariant, flags: u32, first_line: bool) {
        let quantizer: i32 = self.records[self.current].quantizer;
        let quant: i32 = quantizer.abs();
        let dc_scale: u32 = u32::from(WMV3_DC_SCALE[quant as usize]);
        let ac_prediction: bool = flags & MB_ACPRED_BIT != 0;
        let coded: bool = (flags >> (MB_INTRA_CODED_SHIFT + block as u32)) & 1 != 0;
        let mut top: bool = true;
        let mut left: bool = true;
        let (prediction, mut direction): (i32, u32) = match variant {
            IntraVariant::Simple => self.predict_simple_dc(block, first_line, dc_scale),
            IntraVariant::Advanced => {
                top = !first_line || block == 2 || block == 3;
                left = self.mb_x != 0 || block == 1 || block == 3;
                self.predict_dc(block, top, left)
            }
            IntraVariant::InterPicture => {
                top = (block == 2 || block == 3 || !first_line) && self.neighbor_is_intra(&self.neighbor_block(block, DIRECTION_TOP));
                left = (block == 1 || block == 3 || self.mb_x != 0) && self.neighbor_is_intra(&self.neighbor_block(block, DIRECTION_LEFT));
                self.predict_dc(block, top, left)
            }
        };
        let dc: i32 = prediction_half(&self.records[self.current], block, PREDICTION_DC) + prediction;
        let mut use_prediction: bool = ac_prediction;
        let mut scan: u32 = SCAN_NORMAL_INTRA;
        let fcm: u32 = self.unit.fcm;
        match variant {
            IntraVariant::Simple => {
                if ac_prediction {
                    scan = if direction == DIRECTION_LEFT { SCAN_VERTICAL } else { SCAN_HORIZONTAL };
                }
            }
            IntraVariant::Advanced => {
                use_prediction = ac_prediction && (top || left);
                if ac_prediction {
                    scan = if !use_prediction && fcm == FCM_FRAME {
                        SCAN_INTERLACED
                    } else if direction == DIRECTION_LEFT {
                        SCAN_VERTICAL
                    } else {
                        SCAN_HORIZONTAL
                    };
                } else if fcm == FCM_FRAME {
                    scan = SCAN_INTERLACED;
                }
            }
            IntraVariant::InterPicture => {
                use_prediction = ac_prediction && (top || left);
                if !top {
                    direction = DIRECTION_LEFT;
                }
                if !left {
                    direction = DIRECTION_TOP;
                }
                scan = if fcm == FCM_PROGRESSIVE {
                    SCAN_NORMAL_INTER
                } else if use_prediction && fcm == FCM_FRAME {
                    if direction == DIRECTION_LEFT { SCAN_VERTICAL } else { SCAN_HORIZONTAL }
                } else {
                    SCAN_INTERLACED
                };
            }
        }
        let scale: i32 = quant * 2 + if quantizer < 0 { 0 } else { self.unit.halfpq as i32 };
        let mut first_row: [i32; LANE_COUNT] = [0; LANE_COUNT];
        let mut first_column: [i32; LANE_COUNT] = [0; LANE_COUNT];

        // Levels off the first row and column take no prediction, so they scan and dequantize in place; the entries compact as they go
        let level_count: usize = self.records[self.current].block_count(block) as usize;
        let mut count: usize = 0;
        for entry in 0..level_count {
            let word: u32 = self.block_entries[block][entry];
            let position: u32 = u32::from(SCAN_8X8[(scan * SCAN_LENGTH + ((word >> COEFFICIENT_POSITION_SHIFT) & POSITION_MASK)) as usize]);
            let level: i32 = ((word << 16) as i32) >> 16;
            if position < LANE_COUNT as u32 {
                first_row[position as usize] = level;
            } else if position & 7 == 0 {
                first_column[(position >> 3) as usize] = level;
            } else {
                let value: i32 = self.dequantize_level(level, scale, quant, true);
                if value != 0 {
                    self.block_entries[block][count] = (position << COEFFICIENT_POSITION_SHIFT) | (value as u32 & 0xFFFF);
                    count += 1;
                }
            }
        }

        // AC prediction adds the neighbor's first column to a left-predicted block's, or its first row to a top-predicted block's
        if use_prediction {
            let neighbor: NeighborBlock = self.neighbor_block(block, direction);
            let mut current_scale: i32 = 0;
            let mut neighbor_scale: i32 = 0;
            if variant != IntraVariant::Simple {
                current_scale = self.predictor_scale(quantizer);
                let neighbor_quantizer: i32 = self.predictor_neighbor_quantizer(block, direction, top, left, quantizer);
                if neighbor_quantizer != 0 {
                    neighbor_scale = self.predictor_scale(neighbor_quantizer);
                }
            }
            for lane in 1..LANE_COUNT {
                let mut predictor: i32 = 0;
                if neighbor.inside {
                    let half: u32 = if direction == DIRECTION_LEFT { lane as u32 } else { lane as u32 + PREDICTION_ROW_HALF_OFFSET };
                    predictor = prediction_half(self.neighbor_record(&neighbor), neighbor.block, half);
                }
                if variant != IntraVariant::Simple {
                    predictor = scale_ac_predictor(predictor, current_scale, neighbor_scale);
                }
                if direction == DIRECTION_LEFT {
                    first_column[lane] = wrap_int16(first_column[lane] + predictor);
                } else {
                    first_row[lane] = wrap_int16(first_row[lane] + predictor);
                }
            }
        }

        // The predictors this block leaves for its neighbors: the DC level, then the first column and row before dequantization
        let record: &mut MacroblockRecord = &mut self.records[self.current];
        record.predictions[block] = [
            pack_halves(dc, first_column[1]),
            pack_halves(first_column[2], first_column[3]),
            pack_halves(first_column[4], first_column[5]),
            pack_halves(first_column[6], first_column[7]),
            pack_halves(0, first_row[1]),
            pack_halves(first_row[2], first_row[3]),
            pack_halves(first_row[4], first_row[5]),
            pack_halves(first_row[6], first_row[7]),
        ];

        // Coded blocks dequantize the levels they hold; uncoded blocks dequantize their predicted levels, testing them after scaling
        for lane in 1..LANE_COUNT {
            let row_value: i32 = self.dequantize_level(first_row[lane], scale, quant, coded);
            if row_value != 0 {
                self.block_entries[block][count] = ((lane as u32) << COEFFICIENT_POSITION_SHIFT) | (row_value as u32 & 0xFFFF);
                count += 1;
            }
            let column_value: i32 = self.dequantize_level(first_column[lane], scale, quant, coded);
            if column_value != 0 {
                self.block_entries[block][count] = (((lane as u32) * 8) << COEFFICIENT_POSITION_SHIFT) | (column_value as u32 & 0xFFFF);
                count += 1;
            }
        }
        let dc_value: i32 = wrap_int16(dc.wrapping_mul(dc_scale as i32));
        if dc_value != 0 {
            self.block_entries[block][count] = dc_value as u32 & 0xFFFF;
            count += 1;
        }
        self.records[self.current].set_block_count(block, count as u32);
    }

    /// Predicts the intra blocks of the current macroblock
    pub fn predict_intra_macroblock(&mut self) {
        let flags: u32 = self.records[self.current].flags;
        if flags & MB_DECODED_BIT == 0 || flags & crate::unit::MB_INTRA_BLOCKS_MASK == 0 {
            return;
        }
        let first_line: bool = flags & MACROBLOCK_SLICE_TOP_BIT != 0;
        let variant: IntraVariant = if !self.is_intra_picture() {
            IntraVariant::InterPicture
        } else if self.sequence.profile == PROFILE_ADVANCED {
            IntraVariant::Advanced
        } else {
            IntraVariant::Simple
        };
        for block in 0..BLOCK_COUNT {
            if (flags >> block) & 1 != 0 {
                self.predict_intra_block(block, variant, flags, first_line);
            }
        }
    }
}
