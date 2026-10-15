// A picture plan: everything slice data parsing needs, self-contained so a parse worker with its own module instance can take it.
// The coordinator serializes a plan; a worker reads it back. Both run the same module, so the plain structs travel as their bytes.

use std::mem::size_of;
use std::ptr;

use crate::layout::{MAXIMUM_REFERENCE_INDICES, MAXIMUM_TILE_COLUMNS, MAXIMUM_TILE_ROWS};
use crate::parameter_sets::{CHROMA_QP_OFFSET_LIST_CAPACITY, SCALING_LIST_BYTE_COUNT};

pub const PLAN_MAGIC: u32 = 0x4E41_4C50;
pub const REFERENCE_LIST_LENGTH: usize = MAXIMUM_REFERENCE_INDICES as usize;
pub const WEIGHT_VALUES: usize = 6;
/// Zero bytes after each segment's data, which the arithmetic decoder may fetch past the segment's end
pub const SEGMENT_PADDING_BYTES: usize = 8;

/// Marks a struct of only u32, i32, and u8 fields and arrays, which any bytes of its size form validly.
///
/// # Safety
/// The implementing type must be `repr(C)`, `Copy`, and hold no references, pointers, or types with invalid bit patterns.
pub unsafe trait PlainData: Copy {}

/// Appends a plain struct's bytes.
pub fn write_plain<T: PlainData>(output: &mut Vec<u8>, value: &T) {
    // SAFETY: PlainData types are repr(C) structs of plain integers, so their bytes are initialized and readable
    let bytes: &[u8] = unsafe { std::slice::from_raw_parts(ptr::from_ref(value).cast::<u8>(), size_of::<T>()) };
    output.extend_from_slice(bytes);
}

/// Reads a plain struct at a byte offset, advancing the offset; None when the bytes run out.
pub fn read_plain<T: PlainData>(bytes: &[u8], offset: &mut usize) -> Option<T> {
    let end: usize = offset.checked_add(size_of::<T>())?;
    if end > bytes.len() {
        return None;
    }
    // SAFETY: the range is in bounds, and every bit pattern is a valid PlainData value
    let value: T = unsafe { ptr::read_unaligned(bytes.as_ptr().add(*offset).cast::<T>()) };
    *offset = end;
    Some(value)
}

/// The fields of the active SPS and PPS that slice data parsing, motion derivation, and the GPU record header read.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct PictureParameters {
    pub picture_id: u32,
    pub poc: i32,
    pub width: u32,
    pub height: u32,
    pub chroma_format: u32,
    pub horizontal_shift: u32,
    pub vertical_shift: u32,
    pub bit_depth: u32,
    pub bit_depth_chroma: u32,
    pub ctb_log2: u32,
    pub min_cb_log2: u32,
    pub min_tb_log2: u32,
    pub max_tb_log2: u32,
    pub max_transform_depth_inter: u32,
    pub max_transform_depth_intra: u32,
    pub ctb_width: u32,
    pub ctb_height: u32,
    pub ctb_count: u32,
    pub amp: u32,
    pub pcm: u32,
    pub pcm_bit_depth: u32,
    pub pcm_bit_depth_chroma: u32,
    pub pcm_min_log2: u32,
    pub pcm_max_log2: u32,
    pub pcm_loop_filter_disabled: u32,
    pub scaling_list_enabled: u32,
    pub strong_intra_smoothing: u32,
    pub transform_skip_rotation: u32,
    pub transform_skip_context: u32,
    pub implicit_rdpcm: u32,
    pub explicit_rdpcm: u32,
    pub intra_smoothing_disabled: u32,
    pub persistent_rice: u32,
    pub sign_data_hiding: u32,
    pub constrained_intra_pred: u32,
    pub transform_skip: u32,
    pub cu_qp_delta: u32,
    pub min_cu_qp_delta_log2: u32,
    pub cb_qp_offset: i32,
    pub cr_qp_offset: i32,
    pub transquant_bypass: u32,
    pub tiles: u32,
    pub entropy_sync: u32,
    pub loop_filter_across_tiles: u32,
    pub log2_parallel_merge: u32,
    pub log2_max_transform_skip: u32,
    pub cross_component: u32,
    pub chroma_qp_offset_list: u32,
    pub min_cu_chroma_qp_offset_log2: u32,
    pub chroma_qp_offset_list_length: u32,
    pub cb_qp_offset_list: [i32; CHROMA_QP_OFFSET_LIST_CAPACITY],
    pub cr_qp_offset_list: [i32; CHROMA_QP_OFFSET_LIST_CAPACITY],
    pub log2_sao_offset_scale_luma: u32,
    pub log2_sao_offset_scale_chroma: u32,
    pub qp_bd_offset: i32,
    pub tile_columns: u32,
    pub tile_rows: u32,
    pub column_boundaries: [u32; MAXIMUM_TILE_COLUMNS as usize + 1],
    pub row_boundaries: [u32; MAXIMUM_TILE_ROWS as usize + 1],
    pub conformance_left: u32,
    pub conformance_right: u32,
    pub conformance_top: u32,
    pub conformance_bottom: u32,
    /// Changes whenever the CTB address tables change, so a consumer rebuilds its copy only then
    pub tables_generation: u32,
    pub sao_any: u32,
    pub deblocking_any: u32,
    pub scaling_list: [u8; SCALING_LIST_BYTE_COUNT],
}

// SAFETY: repr(C), Copy, and only integers and integer arrays
unsafe impl PlainData for PictureParameters {}

/// One entry of a reference picture list.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct ReferenceEntry {
    /// The decode-order ID of the picture, or MISSING_PICTURE for one generated because it was missing
    pub picture_id: u32,
    pub poc: i32,
    pub long_term: u32,
}

/// An independent slice segment header and its reference picture lists.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct SliceHeader {
    pub slice_type: u32,
    pub qp: i32,
    pub cb_qp_offset: i32,
    pub cr_qp_offset: i32,
    pub cu_chroma_qp_offset: u32,
    pub deblocking_disabled: u32,
    pub beta_offset: i32,
    pub tc_offset: i32,
    pub loop_filter_across_slices: u32,
    pub sao_luma: u32,
    pub sao_chroma: u32,
    pub max_merge_candidates: u32,
    pub temporal_mvp: u32,
    pub collocated_list: u32,
    pub collocated_ref_idx: u32,
    pub collocated_valid: u32,
    pub mvd_l1_zero: u32,
    pub cabac_init: u32,
    pub reference_counts: [u32; 2],
    pub address_rs: u32,
    pub address_ts: u32,
    pub luma_log2_weight_denominator: u32,
    pub chroma_log2_weight_denominator: u32,
    pub weighted: u32,
    pub no_backward_prediction: u32,
    pub references: [[ReferenceEntry; REFERENCE_LIST_LENGTH]; 2],
    /// Per list and reference index: luma weight and offset, Cb weight and offset, Cr weight and offset
    pub weights: [[[i32; WEIGHT_VALUES]; REFERENCE_LIST_LENGTH]; 2],
}

// SAFETY: repr(C), Copy, and only integers and integer arrays
unsafe impl PlainData for SliceHeader {}

impl SliceHeader {
    pub fn empty() -> Self {
        Self {
            slice_type: 0,
            qp: 0,
            cb_qp_offset: 0,
            cr_qp_offset: 0,
            cu_chroma_qp_offset: 0,
            deblocking_disabled: 0,
            beta_offset: 0,
            tc_offset: 0,
            loop_filter_across_slices: 0,
            sao_luma: 0,
            sao_chroma: 0,
            max_merge_candidates: 5,
            temporal_mvp: 0,
            collocated_list: 0,
            collocated_ref_idx: 0,
            collocated_valid: 0,
            mvd_l1_zero: 0,
            cabac_init: 0,
            reference_counts: [0; 2],
            address_rs: 0,
            address_ts: 0,
            luma_log2_weight_denominator: 0,
            chroma_log2_weight_denominator: 0,
            weighted: 0,
            no_backward_prediction: 1,
            references: [[ReferenceEntry::default(); REFERENCE_LIST_LENGTH]; 2],
            weights: [[[1, 0, 1, 0, 1, 0]; REFERENCE_LIST_LENGTH]; 2],
        }
    }
}

/// One slice segment: its slice, first CTB, data range in the plan's data, and its tile substreams' entry points.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Segment {
    pub slice: u32,
    pub address_ts: u32,
    pub data_offset: u32,
    pub data_end: u32,
    pub dependent: u32,
    pub entry_point_first: u32,
    pub entry_point_count: u32,
}

// SAFETY: repr(C), Copy, and only integers
unsafe impl PlainData for Segment {}

/// How a decoding unit starts: at its segment's own data, or at a tile substream's entry point.
pub const UNIT_STARTS_SEGMENT: u32 = 2;
pub const UNIT_STARTS_SUBSTREAM: u32 = 1;

/// A decoding unit: an independent slice with its dependent segments, or one tile's substream. It decodes up to the CTB the next one starts at.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Unit {
    pub first_segment: u32,
    pub last_segment: u32,
    pub ctb_ts: u32,
    pub end_ctb_ts: u32,
    pub start: u32,
    pub position: u32,
}

// SAFETY: repr(C), Copy, and only integers
unsafe impl PlainData for Unit {}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct PlanHeader {
    magic: u32,
    slice_count: u32,
    segment_count: u32,
    unit_count: u32,
    entry_point_count: u32,
    data_byte_length: u32,
}

// SAFETY: repr(C), Copy, and only integers
unsafe impl PlainData for PlanHeader {}

/// A planned picture: its parameters, slices, segments, units, and the RBSP of its slice data with emulation prevention removed.
#[derive(Clone)]
pub struct Plan {
    pub parameters: PictureParameters,
    pub slices: Vec<SliceHeader>,
    pub segments: Vec<Segment>,
    pub units: Vec<Unit>,
    /// Each segment's substream starts after its first, as offsets into data
    pub entry_points: Vec<u32>,
    pub data: Vec<u8>,
}

impl Plan {
    pub fn serialize(&self, output: &mut Vec<u8>) {
        output.clear();
        let header: PlanHeader = PlanHeader {
            magic: PLAN_MAGIC,
            slice_count: self.slices.len() as u32,
            segment_count: self.segments.len() as u32,
            unit_count: self.units.len() as u32,
            entry_point_count: self.entry_points.len() as u32,
            data_byte_length: self.data.len() as u32,
        };
        write_plain(output, &header);
        write_plain(output, &self.parameters);
        for slice in &self.slices {
            write_plain(output, slice);
        }
        for segment in &self.segments {
            write_plain(output, segment);
        }
        for unit in &self.units {
            write_plain(output, unit);
        }
        for entry_point in &self.entry_points {
            output.extend_from_slice(&entry_point.to_le_bytes());
        }
        output.extend_from_slice(&self.data);
    }

    /// Reads a serialized plan back; None when the bytes are not one.
    pub fn deserialize(bytes: &[u8]) -> Option<Self> {
        let mut offset: usize = 0;
        let header: PlanHeader = read_plain(bytes, &mut offset)?;
        if header.magic != PLAN_MAGIC {
            return None;
        }
        let parameters: PictureParameters = read_plain(bytes, &mut offset)?;
        let mut slices: Vec<SliceHeader> = Vec::with_capacity(header.slice_count as usize);
        for _ in 0..header.slice_count {
            slices.push(read_plain(bytes, &mut offset)?);
        }
        let mut segments: Vec<Segment> = Vec::with_capacity(header.segment_count as usize);
        for _ in 0..header.segment_count {
            segments.push(read_plain(bytes, &mut offset)?);
        }
        let mut units: Vec<Unit> = Vec::with_capacity(header.unit_count as usize);
        for _ in 0..header.unit_count {
            units.push(read_plain(bytes, &mut offset)?);
        }
        let mut entry_points: Vec<u32> = Vec::with_capacity(header.entry_point_count as usize);
        for _ in 0..header.entry_point_count {
            let word: [u8; 4] = bytes.get(offset..offset + 4)?.try_into().ok()?;
            entry_points.push(u32::from_le_bytes(word));
            offset += 4;
        }
        let data_end: usize = offset.checked_add(header.data_byte_length as usize)?;
        let data: Vec<u8> = bytes.get(offset..data_end)?.to_vec();
        Some(Self { parameters, slices, segments, units, entry_points, data })
    }
}
