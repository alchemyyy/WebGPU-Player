// Sequence and picture parameter sets (7.3.2.2, 7.3.2.3), with their scaling lists and short-term reference picture sets.
// FFmpeg's libavcodec/hevc/ps.c is the behavioral reference.

use crate::bitstream::BitReader;
use crate::error::{DecodeResult, fail};
use crate::layout::{ERROR_PARAMETER_SET_INVALID, ERROR_UNSUPPORTED_FORMAT, MAXIMUM_DPB_PICTURES, MAXIMUM_TILE_COLUMNS, MAXIMUM_TILE_ROWS};

pub const MAXIMUM_SPS_COUNT: usize = 16;
pub const MAXIMUM_PPS_COUNT: usize = 64;
pub const MAXIMUM_SHORT_TERM_SETS: usize = 64;
pub const MAXIMUM_SHORT_TERM_DELTAS: usize = 16;
pub const MAXIMUM_LONG_TERM_SPS_PICTURES: usize = 32;
pub const CHROMA_QP_OFFSET_LIST_CAPACITY: usize = 6;

// Profile bits after general_profile_idc and before general_level_idc: compatibility flags, 4 source flags, 43 constraint bits, and 1
const PROFILE_FLAG_BITS: u32 = 80;
const SUB_LAYER_PROFILE_BITS: u32 = 88;

// general_profile_idc values that enable PPS extensions; earlier profiles carry extension data a decoder ignores
const PROFILE_RANGE_EXTENSIONS: u32 = 4;
const PROFILE_SCREEN_CONTENT: u32 = 9;

const MAXIMUM_BIT_DEPTH: u32 = 16;
const MAXIMUM_LOG2_POC_LSB: u32 = 16;
const MAXIMUM_CPB_COUNT: u32 = 32;
const MINIMUM_CTB_LOG2: u32 = 4;
const MAXIMUM_CTB_LOG2: u32 = 6;
const MAXIMUM_TRANSFORM_LOG2: u32 = 5;

// Scaling list bytes: 6 4x4 matrices, 18 8x8 matrices for sizes 8, 16, and 32, and 12 DC values
pub const SCALING_LIST_BYTE_COUNT: usize = 6 * 16 + 18 * 64 + 12;
const SCALING_LIST_8X8_BASE: usize = 96;
const SCALING_LIST_SIZE_STRIDE: usize = 384;
const SCALING_LIST_DC_BASE: usize = 96 + 3 * 384;
const DEFAULT_SCALING_VALUE: u8 = 16;

pub const DIAGONAL_SCAN_4X4_X: [u8; 16] = [0, 0, 1, 0, 1, 2, 0, 1, 2, 3, 1, 2, 3, 2, 3, 3];
pub const DIAGONAL_SCAN_4X4_Y: [u8; 16] = [0, 1, 0, 2, 1, 0, 3, 2, 1, 0, 3, 2, 1, 3, 2, 3];

const DEFAULT_SCALING_INTRA: [u8; 64] = [
    16, 16, 16, 16, 17, 18, 21, 24, 16, 16, 16, 16, 17, 19, 22, 25, 16, 16, 17, 18, 20, 22, 25, 29, 16, 16, 18, 21, 24, 27, 31, 36,
    17, 17, 20, 24, 30, 35, 41, 47, 18, 19, 22, 27, 35, 44, 54, 65, 21, 22, 25, 31, 41, 54, 70, 88, 24, 25, 29, 36, 47, 65, 88, 115,
];

const DEFAULT_SCALING_INTER: [u8; 64] = [
    16, 16, 16, 16, 17, 18, 20, 24, 16, 16, 16, 17, 18, 20, 24, 25, 16, 16, 17, 18, 20, 24, 25, 28, 16, 17, 18, 20, 24, 25, 28, 33,
    17, 18, 20, 24, 25, 28, 33, 41, 18, 20, 24, 25, 28, 33, 41, 54, 20, 24, 25, 28, 33, 41, 54, 71, 24, 25, 28, 33, 41, 54, 71, 91,
];

/// The byte of a scaling matrix entry: sizeId 0 is 4x4, sizeIds 1 to 3 are 8x8 matrices that upsample.
pub fn scaling_byte_index(size_id: u32, matrix_id: u32, position: u32) -> usize {
    if size_id == 0 {
        return (matrix_id * 16 + position) as usize;
    }
    SCALING_LIST_8X8_BASE + (size_id as usize - 1) * SCALING_LIST_SIZE_STRIDE + (matrix_id * 64 + position) as usize
}

/// The byte of a 16x16 or 32x32 matrix's DC value.
pub fn scaling_dc_index(size_id: u32, matrix_id: u32) -> usize {
    SCALING_LIST_DC_BASE + (size_id as usize - 2) * 6 + matrix_id as usize
}

/// The diagonal scan position of coefficient index within an 8x8 matrix, as y * 8 + x.
fn diagonal_scan_8x8_position(index: u32) -> u32 {
    let mut remaining: u32 = index;
    for diagonal in 0..15u32 {
        let first: u32 = diagonal.saturating_sub(7);
        let last: u32 = diagonal.min(7);
        let length: u32 = last - first + 1;
        if remaining < length {
            // Up-right diagonals start at the bottom-left end
            let column: u32 = first + remaining;
            let row: u32 = diagonal - column;
            return row * 8 + column;
        }
        remaining -= length;
    }
    63
}

#[derive(Clone, Copy)]
pub struct ScalingList {
    pub bytes: [u8; SCALING_LIST_BYTE_COUNT],
}

impl Default for ScalingList {
    fn default() -> Self {
        let mut list: Self = Self { bytes: [0; SCALING_LIST_BYTE_COUNT] };
        list.set_defaults();
        list
    }
}

impl ScalingList {
    fn set_defaults(&mut self) {
        for matrix_id in 0..6u32 {
            for position in 0..16u32 {
                self.bytes[scaling_byte_index(0, matrix_id, position)] = DEFAULT_SCALING_VALUE;
            }
            for size_id in 1..4u32 {
                for position in 0..64u32 {
                    let value: u8 = if matrix_id < 3 { DEFAULT_SCALING_INTRA[position as usize] } else { DEFAULT_SCALING_INTER[position as usize] };
                    self.bytes[scaling_byte_index(size_id, matrix_id, position)] = value;
                }
            }
            self.bytes[scaling_dc_index(2, matrix_id)] = DEFAULT_SCALING_VALUE;
            self.bytes[scaling_dc_index(3, matrix_id)] = DEFAULT_SCALING_VALUE;
        }
    }

    /// scaling_list_data (7.3.4) over the default lists; returns false on an invalid list.
    fn parse(&mut self, reader: &mut BitReader, chroma_format: u32) -> bool {
        self.set_defaults();
        for size_id in 0..4u32 {
            let matrix_step: u32 = if size_id == 3 { 3 } else { 1 };
            let coefficient_count: u32 = 64u32.min(1 << (4 + (size_id << 1)));
            let mut matrix_id: u32 = 0;
            while matrix_id < 6 {
                if reader.read_flag() == 0 {
                    let mut delta: u32 = reader.read_unsigned_golomb();
                    if delta != 0 {
                        delta *= matrix_step;
                        if matrix_id < delta {
                            return false;
                        }
                        for position in 0..coefficient_count {
                            self.bytes[scaling_byte_index(size_id, matrix_id, position)] =
                                self.bytes[scaling_byte_index(size_id, matrix_id - delta, position)];
                        }
                        if size_id > 1 {
                            self.bytes[scaling_dc_index(size_id, matrix_id)] = self.bytes[scaling_dc_index(size_id, matrix_id - delta)];
                        }
                    }
                    matrix_id += matrix_step;
                    continue;
                }
                let mut next_coefficient: i32 = 8;
                if size_id > 1 {
                    let dc: i32 = reader.read_signed_golomb() + 8;
                    if !(1..=255).contains(&dc) {
                        return false;
                    }
                    next_coefficient = dc;
                    self.bytes[scaling_dc_index(size_id, matrix_id)] = dc as u8;
                }
                for index in 0..coefficient_count {
                    let position: u32 = if size_id == 0 {
                        u32::from(DIAGONAL_SCAN_4X4_Y[index as usize]) * 4 + u32::from(DIAGONAL_SCAN_4X4_X[index as usize])
                    } else {
                        diagonal_scan_8x8_position(index)
                    };
                    next_coefficient = (next_coefficient + reader.read_signed_golomb() + 256).rem_euclid(256);
                    self.bytes[scaling_byte_index(size_id, matrix_id, position)] = next_coefficient as u8;
                }
                matrix_id += matrix_step;
            }
        }
        // 4:4:4 chroma 32x32 matrices repeat the 16x16 ones
        if chroma_format == 3 {
            for chroma_matrix in 0..4u32 {
                let matrix_id: u32 = if chroma_matrix >= 2 { chroma_matrix + 2 } else { chroma_matrix + 1 };
                for position in 0..64u32 {
                    self.bytes[scaling_byte_index(3, matrix_id, position)] = self.bytes[scaling_byte_index(2, matrix_id, position)];
                }
                self.bytes[scaling_dc_index(3, matrix_id)] = self.bytes[scaling_dc_index(2, matrix_id)];
            }
        }
        !reader.overrun()
    }
}

/// A short-term reference picture set: negative deltas first, closest first, then positive deltas, closest first.
#[derive(Clone, Copy, Default)]
pub struct ShortTermSet {
    pub negative_count: u32,
    pub count: u32,
    pub delta_pocs: [i32; MAXIMUM_SHORT_TERM_DELTAS],
    pub used: [u8; MAXIMUM_SHORT_TERM_DELTAS],
}

/// st_ref_pic_set (7.3.7); `sets` holds the SPS sets parsed so far, which a predicted set reads.
pub fn parse_short_term_set(reader: &mut BitReader, sets: &[ShortTermSet], set_index: u32, set_count: u32, in_slice_header: bool) -> Option<ShortTermSet> {
    let mut parsed: ShortTermSet = ShortTermSet::default();
    let mut predicted: u32 = 0;
    if set_index != 0 && set_count != 0 {
        predicted = reader.read_flag();
    }
    if predicted == 1 {
        let mut reference_index: u32 = set_index - 1;
        if in_slice_header {
            let delta_index: u32 = reader.read_unsigned_golomb() + 1;
            if delta_index > set_count {
                return None;
            }
            reference_index = set_count - delta_index;
        }
        let reference: ShortTermSet = *sets.get(reference_index as usize)?;
        let sign: u32 = reader.read_flag();
        let absolute_delta: u32 = reader.read_unsigned_golomb() + 1;
        if absolute_delta > 32768 {
            return None;
        }
        let delta_rps: i32 = if sign == 1 { -(absolute_delta as i32) } else { absolute_delta as i32 };
        let mut count: usize = 0;
        let mut negative_count: u32 = 0;
        for index in 0..=reference.count as usize {
            let used: u32 = reader.read_flag();
            let use_delta: u32 = if used == 0 { reader.read_flag() } else { 1 };
            if used == 1 || use_delta == 1 {
                if count >= MAXIMUM_SHORT_TERM_DELTAS {
                    return None;
                }
                let mut delta_poc: i32 = delta_rps;
                if index < reference.count as usize {
                    delta_poc += reference.delta_pocs[index];
                }
                parsed.delta_pocs[count] = delta_poc;
                parsed.used[count] = used as u8;
                if delta_poc < 0 {
                    negative_count += 1;
                }
                count += 1;
            }
        }
        // Sort ascending, then reverse the negative pictures so the closest comes first
        for outer in 1..count {
            let delta_poc: i32 = parsed.delta_pocs[outer];
            let used: u8 = parsed.used[outer];
            let mut inner: usize = outer;
            while inner > 0 && parsed.delta_pocs[inner - 1] > delta_poc {
                parsed.delta_pocs[inner] = parsed.delta_pocs[inner - 1];
                parsed.used[inner] = parsed.used[inner - 1];
                inner -= 1;
            }
            parsed.delta_pocs[inner] = delta_poc;
            parsed.used[inner] = used;
        }
        let negative: usize = negative_count as usize;
        parsed.delta_pocs[..negative].reverse();
        parsed.used[..negative].reverse();
        parsed.negative_count = negative_count;
        parsed.count = count as u32;
        return if reader.overrun() { None } else { Some(parsed) };
    }
    let negative_count: u32 = reader.read_unsigned_golomb();
    let positive_count: u32 = reader.read_unsigned_golomb();
    if negative_count >= MAXIMUM_SHORT_TERM_DELTAS as u32
        || positive_count >= MAXIMUM_SHORT_TERM_DELTAS as u32
        || negative_count + positive_count > MAXIMUM_SHORT_TERM_DELTAS as u32
    {
        return None;
    }
    let mut previous: i32 = 0;
    for index in 0..negative_count as usize {
        previous -= (reader.read_unsigned_golomb() as i32).wrapping_add(1);
        parsed.delta_pocs[index] = previous;
        parsed.used[index] = reader.read_flag() as u8;
    }
    previous = 0;
    for index in 0..positive_count as usize {
        previous += (reader.read_unsigned_golomb() as i32).wrapping_add(1);
        parsed.delta_pocs[negative_count as usize + index] = previous;
        parsed.used[negative_count as usize + index] = reader.read_flag() as u8;
    }
    parsed.negative_count = negative_count;
    parsed.count = negative_count + positive_count;
    if reader.overrun() { None } else { Some(parsed) }
}

/// profile_tier_level (7.3.3); returns general_profile_idc.
fn parse_profile_tier_level(reader: &mut BitReader, max_sub_layers_minus1: u32) -> u32 {
    reader.skip_bits(3);
    let profile_idc: u32 = reader.read_bits(5);
    reader.skip_bits(PROFILE_FLAG_BITS);
    reader.skip_bits(8);
    let mut profile_present: u32 = 0;
    let mut level_present: u32 = 0;
    for index in 0..max_sub_layers_minus1 {
        profile_present |= reader.read_flag() << index;
        level_present |= reader.read_flag() << index;
    }
    if max_sub_layers_minus1 > 0 {
        reader.skip_bits(2 * (8 - max_sub_layers_minus1));
    }
    for index in 0..max_sub_layers_minus1 {
        if (profile_present >> index) & 1 == 1 {
            reader.skip_bits(SUB_LAYER_PROFILE_BITS);
        }
        if (level_present >> index) & 1 == 1 {
            reader.skip_bits(8);
        }
    }
    profile_idc
}

fn parse_sub_layer_hrd(reader: &mut BitReader, cpb_count: u32, sub_picture_parameters: bool) {
    for _ in 0..cpb_count {
        reader.read_unsigned_golomb();
        reader.read_unsigned_golomb();
        if sub_picture_parameters {
            reader.read_unsigned_golomb();
            reader.read_unsigned_golomb();
        }
        reader.skip_bits(1);
    }
}

/// hrd_parameters (E.2.2), skipped.
fn parse_hrd(reader: &mut BitReader, common_information: bool, max_sub_layers_minus1: u32) -> bool {
    let mut nal_hrd: bool = false;
    let mut vcl_hrd: bool = false;
    let mut sub_picture_parameters: bool = false;
    if common_information {
        nal_hrd = reader.read_flag() == 1;
        vcl_hrd = reader.read_flag() == 1;
        if nal_hrd || vcl_hrd {
            sub_picture_parameters = reader.read_flag() == 1;
            if sub_picture_parameters {
                reader.skip_bits(19);
            }
            reader.skip_bits(8);
            if sub_picture_parameters {
                reader.skip_bits(4);
            }
            reader.skip_bits(15);
        }
    }
    for _ in 0..=max_sub_layers_minus1 {
        let fixed_general: bool = reader.read_flag() == 1;
        let mut fixed_within_sequence: bool = false;
        if !fixed_general {
            fixed_within_sequence = reader.read_flag() == 1;
        }
        let mut low_delay: bool = false;
        if fixed_general || fixed_within_sequence {
            reader.read_unsigned_golomb();
        } else {
            low_delay = reader.read_flag() == 1;
        }
        let mut cpb_count: u32 = 1;
        if !low_delay {
            cpb_count = reader.read_unsigned_golomb().wrapping_add(1);
            if cpb_count > MAXIMUM_CPB_COUNT {
                return false;
            }
        }
        if nal_hrd {
            parse_sub_layer_hrd(reader, cpb_count, sub_picture_parameters);
        }
        if vcl_hrd {
            parse_sub_layer_hrd(reader, cpb_count, sub_picture_parameters);
        }
    }
    true
}

/// vui_parameters (E.2.1), skipped.
fn parse_video_usability(reader: &mut BitReader, max_sub_layers_minus1: u32) -> bool {
    if reader.read_flag() == 1 && reader.read_bits(8) == 255 {
        reader.skip_bits(32);
    }
    if reader.read_flag() == 1 {
        reader.skip_bits(1);
    }
    if reader.read_flag() == 1 {
        reader.skip_bits(4);
        if reader.read_flag() == 1 {
            reader.skip_bits(24);
        }
    }
    if reader.read_flag() == 1 {
        reader.read_unsigned_golomb();
        reader.read_unsigned_golomb();
    }
    reader.skip_bits(3);
    if reader.read_flag() == 1 {
        for _ in 0..4 {
            reader.read_unsigned_golomb();
        }
    }
    if reader.read_flag() == 1 {
        reader.skip_bits(64);
        if reader.read_flag() == 1 {
            reader.read_unsigned_golomb();
        }
        if reader.read_flag() == 1 && !parse_hrd(reader, true, max_sub_layers_minus1) {
            return false;
        }
    }
    if reader.read_flag() == 1 {
        reader.skip_bits(3);
        for _ in 0..5 {
            reader.read_unsigned_golomb();
        }
    }
    true
}

#[derive(Clone)]
pub struct SequenceParameterSet {
    pub chroma_format: u32,
    pub width: u32,
    pub height: u32,
    pub conformance_left: u32,
    pub conformance_right: u32,
    pub conformance_top: u32,
    pub conformance_bottom: u32,
    pub bit_depth: u32,
    pub bit_depth_chroma: u32,
    pub log2_max_poc_lsb: u32,
    pub min_cb_log2: u32,
    pub ctb_log2: u32,
    pub min_tb_log2: u32,
    pub max_tb_log2: u32,
    pub max_transform_depth_inter: u32,
    pub max_transform_depth_intra: u32,
    pub scaling_list_enabled: u32,
    pub scaling_list: ScalingList,
    pub amp: u32,
    pub sao: u32,
    pub pcm: u32,
    pub pcm_bit_depth: u32,
    pub pcm_bit_depth_chroma: u32,
    pub pcm_min_log2: u32,
    pub pcm_max_log2: u32,
    pub pcm_loop_filter_disabled: u32,
    pub short_term_set_count: u32,
    pub short_term_sets: Vec<ShortTermSet>,
    pub long_term_present: u32,
    pub long_term_count: u32,
    pub long_term_lsb: [u32; MAXIMUM_LONG_TERM_SPS_PICTURES],
    pub long_term_used_mask: u32,
    pub temporal_mvp: u32,
    pub strong_intra_smoothing: u32,
    pub transform_skip_rotation: u32,
    pub transform_skip_context: u32,
    pub implicit_rdpcm: u32,
    pub explicit_rdpcm: u32,
    pub extended_precision: u32,
    pub intra_smoothing_disabled: u32,
    pub persistent_rice: u32,
    pub cabac_bypass_alignment: u32,
    pub profile_idc: u32,
    /// sps_max_dec_pic_buffering_minus1 + 1 of the highest sub-layer
    pub max_dec_pic_buffering: u32,
    /// sps_max_num_reorder_pics of the highest sub-layer
    pub num_reorder_pictures: u32,
    /// Changes whenever a set is parsed into this ID, so derived tables know to rebuild
    pub generation: u32,
    /// The set's RBSP without trailing zero bytes, which tells a repeated set from a new one
    pub data: Vec<u8>,
}

/// seq_parameter_set_rbsp (7.3.2.2) after the NAL unit header; returns the set's ID and the set.
pub fn parse_sequence_parameter_set(reader: &mut BitReader, generation: u32) -> DecodeResult<(usize, SequenceParameterSet)> {
    reader.skip_bits(4);
    let max_sub_layers_minus1: u32 = reader.read_bits(3);
    reader.skip_bits(1);
    let profile_idc: u32 = parse_profile_tier_level(reader, max_sub_layers_minus1);
    let sps_id: u32 = reader.read_unsigned_golomb();
    if sps_id as usize >= MAXIMUM_SPS_COUNT {
        return fail(ERROR_PARAMETER_SET_INVALID, sps_id);
    }
    let chroma_format: u32 = reader.read_unsigned_golomb();
    if chroma_format > 3 {
        return fail(ERROR_PARAMETER_SET_INVALID, chroma_format);
    }
    if chroma_format == 3 && reader.read_flag() == 1 {
        // separate_colour_plane_flag
        return fail(ERROR_UNSUPPORTED_FORMAT, 1);
    }
    let width: u32 = reader.read_unsigned_golomb();
    let height: u32 = reader.read_unsigned_golomb();
    let mut conformance: [u32; 4] = [0; 4];
    if reader.read_flag() == 1 {
        let sub_width: u32 = if chroma_format == 1 || chroma_format == 2 { 2 } else { 1 };
        let sub_height: u32 = if chroma_format == 1 { 2 } else { 1 };
        conformance[0] = reader.read_unsigned_golomb().wrapping_mul(sub_width);
        conformance[1] = reader.read_unsigned_golomb().wrapping_mul(sub_width);
        conformance[2] = reader.read_unsigned_golomb().wrapping_mul(sub_height);
        conformance[3] = reader.read_unsigned_golomb().wrapping_mul(sub_height);
        if conformance[0].saturating_add(conformance[1]) >= width || conformance[2].saturating_add(conformance[3]) >= height {
            conformance = [0; 4];
        }
    }
    let bit_depth: u32 = reader.read_unsigned_golomb().saturating_add(8);
    let bit_depth_chroma: u32 = reader.read_unsigned_golomb().saturating_add(8);
    let log2_max_poc_lsb: u32 = reader.read_unsigned_golomb().saturating_add(4);
    if bit_depth > MAXIMUM_BIT_DEPTH || bit_depth_chroma > MAXIMUM_BIT_DEPTH || log2_max_poc_lsb > MAXIMUM_LOG2_POC_LSB {
        return fail(ERROR_PARAMETER_SET_INVALID, bit_depth);
    }
    // sps_max_dec_pic_buffering_minus1, sps_max_num_reorder_pics, and sps_max_latency_increase_plus1 per sub-layer;
    // the output process bumps by the highest sub-layer's, and a reorder depth past the buffering raises the buffering, as FFmpeg does
    let ordering_information: u32 = reader.read_flag();
    let first_layer: u32 = if ordering_information == 1 { 0 } else { max_sub_layers_minus1 };
    let mut max_dec_pic_buffering: u32 = 0;
    let mut num_reorder_pictures: u32 = 0;
    for _ in first_layer..=max_sub_layers_minus1 {
        max_dec_pic_buffering = reader.read_unsigned_golomb().saturating_add(1);
        num_reorder_pictures = reader.read_unsigned_golomb();
        reader.read_unsigned_golomb();
        if max_dec_pic_buffering > MAXIMUM_DPB_PICTURES || num_reorder_pictures >= MAXIMUM_DPB_PICTURES {
            return fail(ERROR_PARAMETER_SET_INVALID, 9);
        }
        if num_reorder_pictures >= max_dec_pic_buffering {
            max_dec_pic_buffering = num_reorder_pictures + 1;
        }
    }
    let min_cb_log2: u32 = reader.read_unsigned_golomb().saturating_add(3);
    let ctb_log2: u32 = min_cb_log2.saturating_add(reader.read_unsigned_golomb());
    let min_tb_log2: u32 = reader.read_unsigned_golomb().saturating_add(2);
    let max_tb_log2: u32 = min_tb_log2.saturating_add(reader.read_unsigned_golomb());
    let max_transform_depth_inter: u32 = reader.read_unsigned_golomb();
    let max_transform_depth_intra: u32 = reader.read_unsigned_golomb();
    let minimum_coding_block_mask: u32 = (1u32 << min_cb_log2.min(31)) - 1;
    if !(MINIMUM_CTB_LOG2..=MAXIMUM_CTB_LOG2).contains(&ctb_log2)
        || min_tb_log2 >= min_cb_log2
        || max_tb_log2 > ctb_log2.min(MAXIMUM_TRANSFORM_LOG2)
        || width & minimum_coding_block_mask != 0
        || height & minimum_coding_block_mask != 0
        || width == 0
        || height == 0
    {
        return fail(ERROR_PARAMETER_SET_INVALID, ctb_log2);
    }
    let scaling_list_enabled: u32 = reader.read_flag();
    let mut scaling_list: ScalingList = ScalingList::default();
    if scaling_list_enabled == 1 && reader.read_flag() == 1 && !scaling_list.parse(reader, chroma_format) {
        return fail(ERROR_PARAMETER_SET_INVALID, 2);
    }
    let amp: u32 = reader.read_flag();
    let sao: u32 = reader.read_flag();
    let pcm: u32 = reader.read_flag();
    let mut pcm_bit_depth: u32 = 0;
    let mut pcm_bit_depth_chroma: u32 = 0;
    let mut pcm_min_log2: u32 = 0;
    let mut pcm_max_log2: u32 = 0;
    let mut pcm_loop_filter_disabled: u32 = 0;
    if pcm == 1 {
        pcm_bit_depth = reader.read_bits(4) + 1;
        pcm_bit_depth_chroma = reader.read_bits(4) + 1;
        pcm_min_log2 = reader.read_unsigned_golomb().saturating_add(3);
        pcm_max_log2 = pcm_min_log2.saturating_add(reader.read_unsigned_golomb());
        pcm_loop_filter_disabled = reader.read_flag();
    }
    let short_term_set_count: u32 = reader.read_unsigned_golomb();
    if short_term_set_count as usize > MAXIMUM_SHORT_TERM_SETS {
        return fail(ERROR_PARAMETER_SET_INVALID, short_term_set_count);
    }
    let mut short_term_sets: Vec<ShortTermSet> = Vec::new();
    for set_index in 0..short_term_set_count {
        let Some(set) = parse_short_term_set(reader, &short_term_sets, set_index, short_term_set_count, false) else {
            return fail(ERROR_PARAMETER_SET_INVALID, 3);
        };
        short_term_sets.push(set);
    }
    let long_term_present: u32 = reader.read_flag();
    let mut long_term_count: u32 = 0;
    let mut long_term_lsb: [u32; MAXIMUM_LONG_TERM_SPS_PICTURES] = [0; MAXIMUM_LONG_TERM_SPS_PICTURES];
    let mut long_term_used_mask: u32 = 0;
    if long_term_present == 1 {
        long_term_count = reader.read_unsigned_golomb();
        if long_term_count as usize > MAXIMUM_LONG_TERM_SPS_PICTURES {
            return fail(ERROR_PARAMETER_SET_INVALID, long_term_count);
        }
        for index in 0..long_term_count as usize {
            long_term_lsb[index] = reader.read_bits(log2_max_poc_lsb);
            long_term_used_mask |= reader.read_flag() << index;
        }
    }
    let temporal_mvp: u32 = reader.read_flag();
    let strong_intra_smoothing: u32 = reader.read_flag();
    if reader.read_flag() == 1 && !parse_video_usability(reader, max_sub_layers_minus1) {
        return fail(ERROR_PARAMETER_SET_INVALID, 4);
    }
    let mut range_flags: u32 = 0;
    if reader.read_flag() == 1 {
        let range_extension: u32 = reader.read_flag();
        reader.skip_bits(2);
        let screen_content_extension: u32 = reader.read_flag();
        reader.skip_bits(4);
        if range_extension == 1 {
            range_flags = reader.read_bits(9);
        }
        if screen_content_extension == 1 {
            return fail(ERROR_UNSUPPORTED_FORMAT, 2);
        }
    }
    if reader.overrun() {
        return fail(ERROR_PARAMETER_SET_INVALID, 5);
    }
    let sps: SequenceParameterSet = SequenceParameterSet {
        chroma_format,
        width,
        height,
        conformance_left: conformance[0],
        conformance_right: conformance[1],
        conformance_top: conformance[2],
        conformance_bottom: conformance[3],
        bit_depth,
        bit_depth_chroma,
        log2_max_poc_lsb,
        min_cb_log2,
        ctb_log2,
        min_tb_log2,
        max_tb_log2,
        max_transform_depth_inter,
        max_transform_depth_intra,
        scaling_list_enabled,
        scaling_list,
        amp,
        sao,
        pcm,
        pcm_bit_depth,
        pcm_bit_depth_chroma,
        pcm_min_log2,
        pcm_max_log2,
        pcm_loop_filter_disabled,
        short_term_set_count,
        short_term_sets,
        long_term_present,
        long_term_count,
        long_term_lsb,
        long_term_used_mask,
        temporal_mvp,
        strong_intra_smoothing,
        transform_skip_rotation: (range_flags >> 8) & 1,
        transform_skip_context: (range_flags >> 7) & 1,
        implicit_rdpcm: (range_flags >> 6) & 1,
        explicit_rdpcm: (range_flags >> 5) & 1,
        extended_precision: (range_flags >> 4) & 1,
        intra_smoothing_disabled: (range_flags >> 3) & 1,
        persistent_rice: (range_flags >> 1) & 1,
        cabac_bypass_alignment: range_flags & 1,
        profile_idc,
        max_dec_pic_buffering,
        num_reorder_pictures,
        generation,
        data: Vec::new(),
    };
    Ok((sps_id as usize, sps))
}

#[derive(Clone)]
pub struct PictureParameterSet {
    pub sps_id: u32,
    pub dependent_slices: u32,
    pub output_flag_present: u32,
    pub extra_slice_header_bits: u32,
    pub sign_data_hiding: u32,
    pub cabac_init_present: u32,
    pub num_ref_idx_l0_default: u32,
    pub num_ref_idx_l1_default: u32,
    pub init_qp: i32,
    pub constrained_intra_pred: u32,
    pub transform_skip: u32,
    pub cu_qp_delta: u32,
    pub diff_cu_qp_delta_depth: u32,
    pub cb_qp_offset: i32,
    pub cr_qp_offset: i32,
    pub slice_chroma_qp_offsets: u32,
    pub weighted_pred: u32,
    pub weighted_bipred: u32,
    pub transquant_bypass: u32,
    pub tiles: u32,
    pub entropy_sync: u32,
    pub tile_columns: u32,
    pub tile_rows: u32,
    pub uniform_spacing: u32,
    pub column_widths: [u32; MAXIMUM_TILE_COLUMNS as usize],
    pub row_heights: [u32; MAXIMUM_TILE_ROWS as usize],
    pub loop_filter_across_tiles: u32,
    pub loop_filter_across_slices: u32,
    pub deblocking_control: u32,
    pub deblocking_override: u32,
    pub deblocking_disabled: u32,
    pub beta_offset: i32,
    pub tc_offset: i32,
    pub scaling_list_present: u32,
    pub scaling_list: ScalingList,
    pub lists_modification: u32,
    pub log2_parallel_merge: u32,
    pub slice_header_extension: u32,
    pub log2_max_transform_skip: u32,
    pub cross_component: u32,
    pub chroma_qp_offset_list: u32,
    pub diff_cu_chroma_qp_offset_depth: u32,
    pub chroma_qp_offset_list_length: u32,
    pub cb_qp_offset_list: [i32; CHROMA_QP_OFFSET_LIST_CAPACITY],
    pub cr_qp_offset_list: [i32; CHROMA_QP_OFFSET_LIST_CAPACITY],
    pub log2_sao_offset_scale_luma: u32,
    pub log2_sao_offset_scale_chroma: u32,
    pub generation: u32,
}

/// pic_parameter_set_rbsp (7.3.2.3) after the NAL unit header.
/// Returns None for a PPS ahead of its SPS, which stays absent as FFmpeg skips it; a slice that refers to it reports the missing set.
pub fn parse_picture_parameter_set(
    reader: &mut BitReader,
    sequence_sets: &[Option<Box<SequenceParameterSet>>],
    generation: u32,
) -> DecodeResult<Option<(usize, PictureParameterSet)>> {
    let pps_id: u32 = reader.read_unsigned_golomb();
    if pps_id as usize >= MAXIMUM_PPS_COUNT {
        return fail(ERROR_PARAMETER_SET_INVALID, pps_id);
    }
    let sps_id: u32 = reader.read_unsigned_golomb();
    if sps_id as usize >= MAXIMUM_SPS_COUNT {
        return fail(ERROR_PARAMETER_SET_INVALID, sps_id);
    }
    let Some(sps) = sequence_sets[sps_id as usize].as_deref() else {
        return Ok(None);
    };
    let profile_idc: u32 = sps.profile_idc;
    let dependent_slices: u32 = reader.read_flag();
    let output_flag_present: u32 = reader.read_flag();
    let extra_slice_header_bits: u32 = reader.read_bits(3);
    let sign_data_hiding: u32 = reader.read_flag();
    let cabac_init_present: u32 = reader.read_flag();
    let num_ref_idx_l0_default: u32 = reader.read_unsigned_golomb().saturating_add(1);
    let num_ref_idx_l1_default: u32 = reader.read_unsigned_golomb().saturating_add(1);
    let init_qp: i32 = 26 + reader.read_signed_golomb();
    let constrained_intra_pred: u32 = reader.read_flag();
    let transform_skip: u32 = reader.read_flag();
    let cu_qp_delta: u32 = reader.read_flag();
    let diff_cu_qp_delta_depth: u32 = if cu_qp_delta == 1 { reader.read_unsigned_golomb() } else { 0 };
    let cb_qp_offset: i32 = reader.read_signed_golomb();
    let cr_qp_offset: i32 = reader.read_signed_golomb();
    let slice_chroma_qp_offsets: u32 = reader.read_flag();
    let weighted_pred: u32 = reader.read_flag();
    let weighted_bipred: u32 = reader.read_flag();
    let transquant_bypass: u32 = reader.read_flag();
    let tiles: u32 = reader.read_flag();
    let entropy_sync: u32 = reader.read_flag();
    let mut tile_columns: u32 = 1;
    let mut tile_rows: u32 = 1;
    let mut uniform_spacing: u32 = 1;
    let mut loop_filter_across_tiles: u32 = 1;
    let mut column_widths: [u32; MAXIMUM_TILE_COLUMNS as usize] = [0; MAXIMUM_TILE_COLUMNS as usize];
    let mut row_heights: [u32; MAXIMUM_TILE_ROWS as usize] = [0; MAXIMUM_TILE_ROWS as usize];
    if tiles == 1 {
        tile_columns = reader.read_unsigned_golomb().saturating_add(1);
        tile_rows = reader.read_unsigned_golomb().saturating_add(1);
        if tile_columns > MAXIMUM_TILE_COLUMNS || tile_rows > MAXIMUM_TILE_ROWS {
            return fail(ERROR_PARAMETER_SET_INVALID, tile_columns);
        }
        uniform_spacing = reader.read_flag();
        if uniform_spacing == 0 {
            for column in 0..(tile_columns - 1) as usize {
                column_widths[column] = reader.read_unsigned_golomb().saturating_add(1);
            }
            for row in 0..(tile_rows - 1) as usize {
                row_heights[row] = reader.read_unsigned_golomb().saturating_add(1);
            }
        }
        loop_filter_across_tiles = reader.read_flag();
    }
    let loop_filter_across_slices: u32 = reader.read_flag();
    let deblocking_control: u32 = reader.read_flag();
    let mut deblocking_override: u32 = 0;
    let mut deblocking_disabled: u32 = 0;
    let mut beta_offset: i32 = 0;
    let mut tc_offset: i32 = 0;
    if deblocking_control == 1 {
        deblocking_override = reader.read_flag();
        deblocking_disabled = reader.read_flag();
        if deblocking_disabled == 0 {
            beta_offset = reader.read_signed_golomb().wrapping_mul(2);
            tc_offset = reader.read_signed_golomb().wrapping_mul(2);
        }
    }
    let scaling_list_present: u32 = reader.read_flag();
    let mut scaling_list: ScalingList = ScalingList::default();
    if scaling_list_present == 1 && !scaling_list.parse(reader, sps.chroma_format) {
        return fail(ERROR_PARAMETER_SET_INVALID, 6);
    }
    let lists_modification: u32 = reader.read_flag();
    let log2_parallel_merge: u32 = reader.read_unsigned_golomb().saturating_add(2);
    let slice_header_extension: u32 = reader.read_flag();
    let mut log2_max_transform_skip: u32 = 2;
    let mut cross_component: u32 = 0;
    let mut chroma_qp_offset_list: u32 = 0;
    let mut diff_cu_chroma_qp_offset_depth: u32 = 0;
    let mut chroma_qp_offset_list_length: u32 = 0;
    let mut cb_qp_offset_list: [i32; CHROMA_QP_OFFSET_LIST_CAPACITY] = [0; CHROMA_QP_OFFSET_LIST_CAPACITY];
    let mut cr_qp_offset_list: [i32; CHROMA_QP_OFFSET_LIST_CAPACITY] = [0; CHROMA_QP_OFFSET_LIST_CAPACITY];
    let mut log2_sao_offset_scale_luma: u32 = 0;
    let mut log2_sao_offset_scale_chroma: u32 = 0;
    if reader.read_flag() == 1 {
        let range_extension: u32 = reader.read_flag();
        reader.skip_bits(2);
        let screen_content_extension: u32 = reader.read_flag();
        reader.skip_bits(4);
        if range_extension == 1 && profile_idc >= PROFILE_RANGE_EXTENSIONS {
            if transform_skip == 1 {
                log2_max_transform_skip = reader.read_unsigned_golomb().saturating_add(2);
            }
            cross_component = reader.read_flag();
            chroma_qp_offset_list = reader.read_flag();
            if chroma_qp_offset_list == 1 {
                diff_cu_chroma_qp_offset_depth = reader.read_unsigned_golomb();
                let list_length: u32 = reader.read_unsigned_golomb().saturating_add(1);
                if list_length as usize > CHROMA_QP_OFFSET_LIST_CAPACITY {
                    return fail(ERROR_PARAMETER_SET_INVALID, list_length);
                }
                chroma_qp_offset_list_length = list_length;
                for index in 0..list_length as usize {
                    cb_qp_offset_list[index] = reader.read_signed_golomb();
                    cr_qp_offset_list[index] = reader.read_signed_golomb();
                }
            }
            log2_sao_offset_scale_luma = reader.read_unsigned_golomb();
            log2_sao_offset_scale_chroma = reader.read_unsigned_golomb();
        }
        if screen_content_extension == 1 && profile_idc == PROFILE_SCREEN_CONTENT {
            return fail(ERROR_UNSUPPORTED_FORMAT, 3);
        }
    }
    if reader.overrun() {
        return fail(ERROR_PARAMETER_SET_INVALID, 7);
    }
    let pps: PictureParameterSet = PictureParameterSet {
        sps_id,
        dependent_slices,
        output_flag_present,
        extra_slice_header_bits,
        sign_data_hiding,
        cabac_init_present,
        num_ref_idx_l0_default,
        num_ref_idx_l1_default,
        init_qp,
        constrained_intra_pred,
        transform_skip,
        cu_qp_delta,
        diff_cu_qp_delta_depth,
        cb_qp_offset,
        cr_qp_offset,
        slice_chroma_qp_offsets,
        weighted_pred,
        weighted_bipred,
        transquant_bypass,
        tiles,
        entropy_sync,
        tile_columns,
        tile_rows,
        uniform_spacing,
        column_widths,
        row_heights,
        loop_filter_across_tiles,
        loop_filter_across_slices,
        deblocking_control,
        deblocking_override,
        deblocking_disabled,
        beta_offset,
        tc_offset,
        scaling_list_present,
        scaling_list,
        lists_modification,
        log2_parallel_merge,
        slice_header_extension,
        log2_max_transform_skip,
        cross_component,
        chroma_qp_offset_list,
        diff_cu_chroma_qp_offset_depth,
        chroma_qp_offset_list_length,
        cb_qp_offset_list,
        cr_qp_offset_list,
        log2_sao_offset_scale_luma,
        log2_sao_offset_scale_chroma,
        generation,
    };
    Ok(Some((pps_id as usize, pps)))
}
