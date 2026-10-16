// residual_coding (7.3.8.11) with dequantization (8.6.2 to 8.6.4): each coefficient becomes a coefficient word at its position in
// the CTB's plane, and the block a transform list entry, which the GPU's inverse transform pass reads.

use super::{
    CONTEXT_EXPLICIT_RDPCM, CONTEXT_EXPLICIT_RDPCM_DIRECTION, CONTEXT_GREATER1, CONTEXT_GREATER2, CONTEXT_LAST_X_PREFIX, CONTEXT_LAST_Y_PREFIX,
    CONTEXT_SIGNIFICANT, CONTEXT_SIGNIFICANT_GROUP, CONTEXT_TRANSFORM_SKIP, MODE_INTER, MODE_INTRA, Parser,
};
use crate::error::{DecodeResult, fail};
use crate::layout::{
    COEFFICIENT_PLANE_SHIFT, COEFFICIENT_VALUE_SHIFT, COEFFICIENT_X_SHIFT, COEFFICIENT_Y_SHIFT, ERROR_SLICE_DATA, TRANSFORM_BYPASS_SHIFT,
    TRANSFORM_DST_SHIFT, TRANSFORM_RDPCM_SHIFT, TRANSFORM_RDPCM_VERTICAL_SHIFT, TRANSFORM_SKIP_SHIFT,
};
use crate::parameter_sets::{scaling_byte_index, scaling_dc_index};
use crate::tables::{
    CHROMA_QP_TABLE, DIAGONAL_SCAN_2X2_INVERSE, DIAGONAL_SCAN_2X2_X, DIAGONAL_SCAN_2X2_Y, DIAGONAL_SCAN_4X4_INVERSE, DIAGONAL_SCAN_8X8_INVERSE,
    DIAGONAL_SCAN_8X8_X, DIAGONAL_SCAN_8X8_Y, HORIZONTAL_SCAN_2X2_X, HORIZONTAL_SCAN_2X2_Y, HORIZONTAL_SCAN_4X4_X, HORIZONTAL_SCAN_4X4_Y,
    HORIZONTAL_SCAN_8X8_INVERSE, LEVEL_SCALE, SIGNIFICANT_CONTEXT_MAP,
};
use crate::parameter_sets::{DIAGONAL_SCAN_4X4_X, DIAGONAL_SCAN_4X4_Y};

// Coefficient scans of residual coding
pub const SCAN_DIAGONAL: u32 = 0;
pub const SCAN_HORIZONTAL: u32 = 1;
pub const SCAN_VERTICAL: u32 = 2;

pub const TRANSFORM_DST: u32 = 1 << TRANSFORM_DST_SHIFT;
pub const TRANSFORM_SKIP: u32 = 1 << TRANSFORM_SKIP_SHIFT;
pub const TRANSFORM_BYPASS: u32 = 1 << TRANSFORM_BYPASS_SHIFT;
pub const TRANSFORM_RDPCM: u32 = 1 << TRANSFORM_RDPCM_SHIFT;
pub const TRANSFORM_RDPCM_VERTICAL: u32 = 1 << TRANSFORM_RDPCM_VERTICAL_SHIFT;

const INTRA_ANGULAR_10: u32 = 10;
const INTRA_ANGULAR_26: u32 = 26;
const MAXIMUM_COEFFICIENT: i64 = 32767;
const MINIMUM_COEFFICIENT: i64 = -32768;
const LEVEL_MAGNITUDE_LIMIT: u32 = 32768;
const MAXIMUM_PREFIX: u32 = 32;
const MAXIMUM_ESCAPE_LENGTH: u32 = 22;
const GREATER1_FLAG_LIMIT: u32 = 8;
const FLAT_SCALING_FACTOR: u32 = 16;

/// The scan of a 4x4 or 8x8 intra transform block from its prediction mode (7.4.9.11).
pub fn scan_index_of(mode: u32) -> u32 {
    match mode {
        6..=14 => SCAN_VERTICAL,
        22..=30 => SCAN_HORIZONTAL,
        _ => SCAN_DIAGONAL,
    }
}

impl Parser<'_> {
    fn decode_last_significant_suffix(&mut self, prefix: u32) -> u32 {
        let length: u32 = (prefix >> 1) - 1;
        self.bypass_bits(length)
    }

    fn decode_coefficient_remaining(&mut self, rice_parameter: u32) -> DecodeResult<u32> {
        let mut prefix: u32 = 0;
        while prefix < MAXIMUM_PREFIX && self.bypass() == 1 {
            prefix += 1;
        }
        if prefix < 3 {
            return Ok((prefix << rice_parameter) + self.bypass_bits(rice_parameter));
        }
        let prefix_minus3: u32 = prefix - 3;
        if prefix >= MAXIMUM_PREFIX || prefix_minus3 + rice_parameter > MAXIMUM_ESCAPE_LENGTH {
            return fail(ERROR_SLICE_DATA, 1);
        }
        let suffix_length: u32 = prefix_minus3 + rice_parameter;
        Ok((((1 << prefix_minus3) + 2) << rice_parameter) + self.bypass_bits(suffix_length))
    }

    /// The QP of a transform block's plane (8.6.1), with QpBdOffset added.
    fn plane_qp(&self, plane: u32) -> i32 {
        let qp_bd_offset: i32 = self.qp_bd_offset;
        if plane == 0 {
            return self.qp_y + qp_bd_offset;
        }
        let parameters = self.parameters;
        let offset: i32 = if plane == 1 {
            parameters.cb_qp_offset + self.slice_cb_qp_offset + self.cu_qp_offset_cb
        } else {
            parameters.cr_qp_offset + self.slice_cr_qp_offset + self.cu_qp_offset_cr
        };
        let qpi: i32 = (self.qp_y + offset).clamp(-qp_bd_offset, 57);
        let qp: i32 = if self.chroma_format == 1 {
            if qpi < 30 {
                qpi
            } else if qpi > 43 {
                qpi - 6
            } else {
                CHROMA_QP_TABLE[(qpi - 30) as usize]
            }
        } else {
            qpi.min(51)
        };
        qp + qp_bd_offset
    }

    /// residual_coding of one transform block, and its transform list entry.
    pub(super) fn decode_residual_coding(&mut self, x0: u32, y0: u32, log2_size: u32, scan_index: u32, plane: u32) -> DecodeResult<()> {
        let plane_x: u32 = x0 >> self.plane_horizontal_shift(plane);
        let plane_y: u32 = y0 >> self.plane_vertical_shift(plane);
        let (origin_x, origin_y) = self.ctb_plane_origin(plane);
        let block_x: u32 = plane_x - origin_x;
        let block_y: u32 = plane_y - origin_y;
        let trafo_size: u32 = 1 << log2_size;
        let intra_mode: u32 = if plane == 0 { self.tu_intra_mode } else { self.tu_intra_mode_chroma };
        let intra: bool = self.cu_pred_mode == MODE_INTRA;
        let bypass: bool = self.cu_bypass;
        let mut transform_skip: bool = false;
        let mut shift: u32 = 0;
        let mut scale: u32 = 0;
        let mut use_matrix: bool = false;
        let mut matrix_id: u32 = 0;
        let mut dc_scale: u32 = FLAT_SCALING_FACTOR;
        if !bypass {
            let qp: i32 = self.plane_qp(plane);
            if self.transform_skip_enabled && log2_size <= self.parameters.log2_max_transform_skip {
                transform_skip = self.bin(CONTEXT_TRANSFORM_SKIP + usize::from(plane > 0)) == 1;
            }
            shift = self.plane_bit_depth(plane) + log2_size - 5;
            scale = LEVEL_SCALE[(qp % 6) as usize] << (qp / 6);
            if self.parameters.scaling_list_enabled == 1 && !(transform_skip && log2_size > 2) {
                use_matrix = true;
                matrix_id = 3 * u32::from(!intra) + plane;
                if log2_size >= 4 {
                    dc_scale = u32::from(self.parameters.scaling_list[scaling_dc_index(log2_size - 2, matrix_id)]);
                }
            }
        }
        let mut explicit_rdpcm_flag: bool = false;
        let mut explicit_rdpcm_vertical: bool = false;
        if self.cu_pred_mode == MODE_INTER && self.explicit_rdpcm && (transform_skip || bypass) {
            explicit_rdpcm_flag = self.bin(CONTEXT_EXPLICIT_RDPCM + usize::from(plane > 0)) == 1;
            if explicit_rdpcm_flag {
                explicit_rdpcm_vertical = self.bin(CONTEXT_EXPLICIT_RDPCM_DIRECTION + usize::from(plane > 0)) == 1;
            }
        }

        // last_sig_coeff_x_prefix, last_sig_coeff_y_prefix, and their suffixes
        let prefix_maximum: u32 = (log2_size << 1) - 1;
        let (context_offset, context_shift): (usize, u32) = if plane == 0 {
            ((3 * (log2_size - 2) + ((log2_size - 1) >> 2)) as usize, (log2_size + 1) >> 2)
        } else {
            (15, log2_size - 2)
        };
        let mut last: [u32; 2] = [0; 2];
        for (axis, value) in last.iter_mut().enumerate() {
            let context_base: usize = if axis == 1 { CONTEXT_LAST_Y_PREFIX } else { CONTEXT_LAST_X_PREFIX };
            let mut prefix: u32 = 0;
            while prefix < prefix_maximum && self.bin(context_base + (prefix >> context_shift) as usize + context_offset) == 1 {
                prefix += 1;
            }
            *value = prefix;
        }
        for value in &mut last {
            let prefix: u32 = *value;
            if prefix > 3 {
                let suffix: u32 = self.decode_last_significant_suffix(prefix);
                *value = (1 << ((prefix >> 1) - 1)) * (2 + (prefix & 1)) + suffix;
            }
        }
        let (mut last_x, mut last_y) = (last[0], last[1]);
        if scan_index == SCAN_VERTICAL {
            std::mem::swap(&mut last_x, &mut last_y);
        }
        let last_group_x: u32 = last_x >> 2;
        let last_group_y: u32 = last_y >> 2;
        let mut coefficient_count: u32 = match scan_index {
            SCAN_DIAGONAL => {
                let mut count: u32 = u32::from(DIAGONAL_SCAN_4X4_INVERSE[((last_y & 3) * 4 + (last_x & 3)) as usize]);
                match trafo_size {
                    8 => count += u32::from(DIAGONAL_SCAN_2X2_INVERSE[(last_group_y * 2 + last_group_x) as usize]) << 4,
                    16 => count += u32::from(DIAGONAL_SCAN_4X4_INVERSE[(last_group_y * 4 + last_group_x) as usize]) << 4,
                    32 => count += u32::from(DIAGONAL_SCAN_8X8_INVERSE[(last_group_y * 8 + last_group_x) as usize]) << 4,
                    _ => {}
                }
                count
            }
            SCAN_HORIZONTAL => u32::from(HORIZONTAL_SCAN_8X8_INVERSE[(last_y * 8 + last_x) as usize]),
            _ => u32::from(HORIZONTAL_SCAN_8X8_INVERSE[(last_x * 8 + last_y) as usize]),
        };
        coefficient_count += 1;
        let last_subset: u32 = (coefficient_count - 1) >> 4;
        let group_width: u32 = trafo_size >> 2;

        // Coded sub-block flags, one bit per 4x4 group at x * 8 + y
        let mut group_flags: u64 = 0;
        let mut greater1_context: u32 = 1;
        let sign_hiding_allowed: bool = !(bypass
            || (intra && self.implicit_rdpcm && transform_skip && (intra_mode == INTRA_ANGULAR_10 || intra_mode == INTRA_ANGULAR_26))
            || explicit_rdpcm_flag);
        let skip_contexts: bool = self.transform_skip_context && (transform_skip || bypass);
        let sub_block_type: usize = if self.persistent_rice { 2 * usize::from(plane == 0) + usize::from(transform_skip || bypass) } else { 0 };
        let rotate: bool = !bypass && transform_skip && self.transform_skip_rotation && log2_size == 2 && intra;
        for subset_index in (0..=last_subset).rev() {
            let (group_x, group_y): (u32, u32) = match scan_index {
                SCAN_DIAGONAL => match trafo_size {
                    8 => (u32::from(DIAGONAL_SCAN_2X2_X[subset_index as usize]), u32::from(DIAGONAL_SCAN_2X2_Y[subset_index as usize])),
                    16 => (u32::from(DIAGONAL_SCAN_4X4_X[subset_index as usize]), u32::from(DIAGONAL_SCAN_4X4_Y[subset_index as usize])),
                    32 => (u32::from(DIAGONAL_SCAN_8X8_X[subset_index as usize]), u32::from(DIAGONAL_SCAN_8X8_Y[subset_index as usize])),
                    _ => (0, 0),
                },
                SCAN_HORIZONTAL => (u32::from(HORIZONTAL_SCAN_2X2_X[subset_index as usize]), u32::from(HORIZONTAL_SCAN_2X2_Y[subset_index as usize])),
                _ => (u32::from(HORIZONTAL_SCAN_2X2_Y[subset_index as usize]), u32::from(HORIZONTAL_SCAN_2X2_X[subset_index as usize])),
            };
            let group_bit: u32 = group_x * 8 + group_y;
            let mut implicit_non_zero: bool = false;
            let group_flag: u32 = if subset_index < last_subset && subset_index > 0 {
                let mut group_context: u32 = 0;
                if group_x + 1 < group_width {
                    group_context += ((group_flags >> ((group_x + 1) * 8 + group_y)) & 1) as u32;
                }
                if group_y + 1 < group_width {
                    group_context += ((group_flags >> (group_x * 8 + group_y + 1)) & 1) as u32;
                }
                implicit_non_zero = true;
                self.bin(CONTEXT_SIGNIFICANT_GROUP + group_context.min(1) as usize + if plane > 0 { 2 } else { 0 })
            } else {
                u32::from((group_x == last_group_x && group_y == last_group_y) || (group_x == 0 && group_y == 0))
            };
            if group_flag == 1 {
                group_flags |= 1 << group_bit;
            }
            let last_scan_position: i32 = coefficient_count as i32 - (subset_index << 4) as i32 - 1;
            let mut significant_positions: [u32; 16] = [0; 16];
            let mut significant_count: usize = 0;
            let mut end_position: i32 = 15;
            if subset_index == last_subset {
                end_position = last_scan_position - 1;
                significant_positions[0] = last_scan_position as u32;
                significant_count = 1;
            }
            let mut previous_significance: u32 = 0;
            if group_x + 1 < group_width {
                previous_significance = ((group_flags >> ((group_x + 1) * 8 + group_y)) & 1) as u32;
            }
            if group_y + 1 < group_width {
                previous_significance += (((group_flags >> (group_x * 8 + group_y + 1)) & 1) as u32) << 1;
            }
            if group_flag == 1 && end_position >= 0 {
                let mut map_row: u32 = 0;
                let mut significant_offset: u32 = 0;
                if skip_contexts {
                    map_row = 4;
                    significant_offset = if plane == 0 { 40 } else { 41 };
                } else {
                    if plane != 0 {
                        significant_offset = 27;
                    }
                    if log2_size != 2 {
                        map_row = previous_significance + 1;
                        if plane == 0 {
                            if group_x > 0 || group_y > 0 {
                                significant_offset += 3;
                            }
                            if log2_size == 3 {
                                significant_offset += if scan_index == SCAN_DIAGONAL { 9 } else { 15 };
                            } else {
                                significant_offset += 21;
                            }
                        } else if log2_size == 3 {
                            significant_offset += 9;
                        } else {
                            significant_offset += 12;
                        }
                    }
                }
                let map_base: usize = (scan_index * 80 + map_row * 16) as usize;
                let count_before: usize = significant_count;
                let mut position: i32 = end_position;
                while position > 0 {
                    let context: usize = CONTEXT_SIGNIFICANT + usize::from(SIGNIFICANT_CONTEXT_MAP[map_base + position as usize]) + significant_offset as usize;
                    let significant: u32 = self.bin(context);
                    significant_positions[significant_count] = position as u32;
                    significant_count += significant as usize;
                    position -= 1;
                }
                if significant_count != count_before {
                    implicit_non_zero = false;
                }
                if !implicit_non_zero {
                    let zero_offset: u32 = if skip_contexts {
                        if plane == 0 { 42 } else { 43 }
                    } else if subset_index == 0 {
                        if plane == 0 { 0 } else { 27 }
                    } else {
                        significant_offset + 2
                    };
                    significant_positions[significant_count] = 0;
                    significant_count += self.bin(CONTEXT_SIGNIFICANT + zero_offset as usize) as usize;
                } else {
                    significant_positions[significant_count] = 0;
                    significant_count += 1;
                }
            }
            if significant_count == 0 {
                continue;
            }

            // Levels and signs of the sub-block's significant coefficients
            let mut context_set: u32 = if subset_index > 0 && plane == 0 { 2 } else { 0 };
            let mut rice_parameter: u32 = if self.persistent_rice { self.rice_statistics[sub_block_type] / 4 } else { 0 };
            if subset_index != last_subset && greater1_context == 0 {
                context_set += 1;
            }
            greater1_context = 1;
            let mut greater1_flags: u32 = 0;
            let greater1_count: usize = significant_count.min(GREATER1_FLAG_LIMIT as usize);
            let chroma_greater1_offset: usize = if plane > 0 { 16 } else { 0 };
            for index in 0..greater1_count {
                let flag: u32 = self.bin(CONTEXT_GREATER1 + (context_set << 2) as usize + greater1_context as usize + chroma_greater1_offset);
                greater1_flags |= flag << index;
                if flag == 1 {
                    greater1_context = 0;
                } else if greater1_context > 0 && greater1_context < 3 {
                    greater1_context += 1;
                }
            }
            let first_greater1: u32 = if greater1_flags != 0 { greater1_flags.trailing_zeros() } else { GREATER1_FLAG_LIMIT };
            let last_non_zero_position: u32 = significant_positions[0];
            let first_non_zero_position: u32 = significant_positions[significant_count - 1];
            let sign_hidden: bool = sign_hiding_allowed && self.sign_data_hiding && last_non_zero_position - first_non_zero_position >= 4;
            let mut greater2: u32 = 0;
            if first_greater1 != GREATER1_FLAG_LIMIT {
                greater2 = self.bin(CONTEXT_GREATER2 + context_set as usize + if plane > 0 { 4 } else { 0 });
            }
            let sign_count: u32 = if sign_hidden { significant_count as u32 - 1 } else { significant_count as u32 };
            let mut sign_flags: u32 = self.bypass_bits(sign_count) << (16 - sign_count);
            let mut absolute_sum: u32 = 0;
            let mut rice_initialized: bool = false;
            for (index, &position) in significant_positions[..significant_count].iter().enumerate() {
                let (offset_x, offset_y): (u32, u32) = match scan_index {
                    SCAN_DIAGONAL => (u32::from(DIAGONAL_SCAN_4X4_X[position as usize]), u32::from(DIAGONAL_SCAN_4X4_Y[position as usize])),
                    SCAN_HORIZONTAL => (u32::from(HORIZONTAL_SCAN_4X4_X[position as usize]), u32::from(HORIZONTAL_SCAN_4X4_Y[position as usize])),
                    _ => (u32::from(HORIZONTAL_SCAN_4X4_Y[position as usize]), u32::from(HORIZONTAL_SCAN_4X4_X[position as usize])),
                };
                let coefficient_x: u32 = (group_x << 2) + offset_x;
                let coefficient_y: u32 = (group_y << 2) + offset_y;
                let mut level: u32;
                let decode_remaining: bool;
                if index < GREATER1_FLAG_LIMIT as usize {
                    level = 1 + ((greater1_flags >> index) & 1);
                    if index as u32 == first_greater1 {
                        level += greater2;
                    }
                    decode_remaining = level == if index as u32 == first_greater1 { 3 } else { 2 };
                } else {
                    level = 1;
                    decode_remaining = true;
                }
                if decode_remaining {
                    let remaining: u32 = self.decode_coefficient_remaining(rice_parameter)?;
                    level = level.wrapping_add(remaining);
                    if level > (3 << rice_parameter) {
                        rice_parameter = if self.persistent_rice { rice_parameter + 1 } else { (rice_parameter + 1).min(4) };
                    }
                    if self.persistent_rice && !rice_initialized {
                        let initial_rice: u32 = self.rice_statistics[sub_block_type] / 4;
                        if remaining >= (3 << initial_rice) {
                            self.rice_statistics[sub_block_type] += 1;
                        } else if 2 * remaining < (1 << initial_rice) && self.rice_statistics[sub_block_type] > 0 {
                            self.rice_statistics[sub_block_type] -= 1;
                        }
                        rice_initialized = true;
                    }
                }
                let mut signed_level: i32 = level.min(i32::MAX as u32) as i32;
                if sign_hidden {
                    absolute_sum = absolute_sum.wrapping_add(level);
                    if position == first_non_zero_position && absolute_sum & 1 == 1 {
                        signed_level = -signed_level;
                    }
                }
                if sign_flags >> 15 == 1 {
                    signed_level = -signed_level;
                }
                sign_flags = (sign_flags << 1) & 0xFFFF;
                let value: i64 = if bypass {
                    i64::from(signed_level).clamp(MINIMUM_COEFFICIENT, MAXIMUM_COEFFICIENT)
                } else {
                    let mut matrix_value: u32 = FLAT_SCALING_FACTOR;
                    if use_matrix {
                        matrix_value = if coefficient_x != 0 || coefficient_y != 0 || log2_size < 4 {
                            let matrix_position: u32 = match log2_size {
                                2 => (coefficient_y << 2) + coefficient_x,
                                3 => (coefficient_y << 3) + coefficient_x,
                                4 => ((coefficient_y >> 1) << 3) + (coefficient_x >> 1),
                                _ => ((coefficient_y >> 2) << 3) + (coefficient_x >> 2),
                            };
                            u32::from(self.parameters.scaling_list[scaling_byte_index(log2_size - 2, matrix_id, matrix_position)])
                        } else {
                            dc_scale
                        };
                    }
                    // Saturates (level * factor + 2^(shift - 1)) >> shift to 16 bits, with the level's magnitude capped first
                    let magnitude: i64 = i64::from(signed_level.unsigned_abs().min(LEVEL_MAGNITUDE_LIMIT));
                    let capped_level: i64 = if signed_level < 0 { -magnitude } else { magnitude };
                    let factor: i64 = i64::from(scale) * i64::from(matrix_value);
                    ((capped_level * factor + (1i64 << (shift - 1))) >> shift).clamp(MINIMUM_COEFFICIENT, MAXIMUM_COEFFICIENT)
                };
                let (output_x, output_y): (u32, u32) = if rotate { (3 - coefficient_x, 3 - coefficient_y) } else { (coefficient_x, coefficient_y) };
                self.push_coefficient(
                    (plane << COEFFICIENT_PLANE_SHIFT)
                        | ((block_x + output_x) << COEFFICIENT_X_SHIFT)
                        | ((block_y + output_y) << COEFFICIENT_Y_SHIFT)
                        | (((value as i32 as u32) & 0xFFFF) << COEFFICIENT_VALUE_SHIFT),
                );
            }
        }

        // The block's inverse transform, residual DPCM, or nothing for bypass without DPCM
        let implicit_directional: bool = self.implicit_rdpcm && intra && (intra_mode == INTRA_ANGULAR_10 || intra_mode == INTRA_ANGULAR_26);
        let rdpcm_vertical: bool = if explicit_rdpcm_flag { explicit_rdpcm_vertical } else { intra_mode == INTRA_ANGULAR_26 };
        let rdpcm_flags: u32 = TRANSFORM_RDPCM | if rdpcm_vertical { TRANSFORM_RDPCM_VERTICAL } else { 0 };
        let flags: u32 = if bypass {
            if explicit_rdpcm_flag || implicit_directional {
                TRANSFORM_BYPASS | rdpcm_flags
            } else if self.tu_cross_scale == 0 || plane == 0 {
                return Ok(());
            } else {
                TRANSFORM_BYPASS
            }
        } else if transform_skip {
            TRANSFORM_SKIP | if explicit_rdpcm_flag || implicit_directional { rdpcm_flags } else { 0 }
        } else if intra && plane == 0 && log2_size == 2 {
            TRANSFORM_DST
        } else {
            0
        };
        let cross_flags: u32 = self.cross_component_flags(plane);
        self.emit_transform(plane, plane_x, plane_y, log2_size, flags | cross_flags);
        Ok(())
    }
}
