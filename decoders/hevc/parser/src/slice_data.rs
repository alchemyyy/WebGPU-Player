// Slice data parsing (7.3.8): the CTU loop over decoding units, SAO syntax, the coding quadtree, coding units, prediction unit syntax,
// intra mode derivation, the transform tree, and PCM samples. It records per-CTB GPU records; motion derivation runs later, in decode order.
// FFmpeg's libavcodec/hevc (cabac.c, hevcdec.c) is the behavioral reference; this is a port of the engine's verified WGSL parser.

use crate::cabac::ArithmeticDecoder;
use crate::ctb_layout::CTBLayout;
use crate::error::{DecodeResult, fail};
use crate::layout::{
    BLOCK_BYPASS_SHIFT, BLOCK_QP_SHIFT, CTB_COEFFICIENT_COUNT, CTB_COEFFICIENT_OFFSET, CTB_EDGE_COUNT, CTB_EDGE_OFFSET,
    CTB_INTRA_COUNT_LUMA, CTB_JOB_OFFSET, CTB_PREDICTION_COUNT, CTB_PREDICTION_OFFSET, CTB_SAO_LUMA_TYPE, CTB_SLICE,
    CTB_TRANSFORM_COUNT_4, EDGE_CBF_SHIFT, EDGE_LOG2_SIZE_SHIFT, EDGE_X_SHIFT, EDGE_Y_SHIFT, ERROR_SLICE_DATA, JOB_MODE_SHIFT,
    JOB_SIZE_SHIFT, JOB_X_SHIFT, JOB_Y_SHIFT, PCM_HEADER_WORDS, PREDICTION_HEIGHT_SHIFT, PREDICTION_WIDTH_SHIFT, PREDICTION_X_SHIFT,
    PREDICTION_Y_SHIFT, SAO_BAND, SAO_EDGE, SAO_NOT_APPLIED, SAO_POSITION_SHIFT, TRANSFORM_PLANE_SHIFT, TRANSFORM_X_SHIFT,
    TRANSFORM_Y_SHIFT,
};
use crate::plan::{PictureParameters, Plan, Segment, SliceHeader, UNIT_STARTS_SEGMENT, UNIT_STARTS_SUBSTREAM, Unit};
use crate::records::{
    JOB_CTB_ENTRY_WORDS, JobStreams, PREDICTION_RECORD_WORDS, SYNTAX_CU_LOG2_BASE, SYNTAX_CU_LOG2_SHIFT, SYNTAX_INTER_PRED_IDC_SHIFT, SYNTAX_MERGE_FLAG_SHIFT,
    SYNTAX_MERGE_INDEX_SHIFT, SYNTAX_MVP_L0_SHIFT, SYNTAX_MVP_L1_SHIFT, SYNTAX_PART_INDEX_SHIFT, SYNTAX_PART_MODE_SHIFT,
};
use crate::sequencer::{SLICE_B, SLICE_I};
use crate::tables::{CHROMA_422_MODES, CONTEXT_COUNT, CONTEXT_INIT_VALUES, INTRA_CHROMA_MODES};

mod residual;

use residual::{SCAN_DIAGONAL, TRANSFORM_BYPASS, scan_index_of};

// Context variable offsets, in FFmpeg's order
pub const CONTEXT_SAO_MERGE: usize = 0;
pub const CONTEXT_SAO_TYPE: usize = 1;
pub const CONTEXT_SPLIT_CU: usize = 2;
pub const CONTEXT_TRANSQUANT_BYPASS: usize = 5;
pub const CONTEXT_SKIP: usize = 6;
pub const CONTEXT_CU_QP_DELTA: usize = 9;
pub const CONTEXT_PRED_MODE: usize = 12;
pub const CONTEXT_PART_MODE: usize = 13;
pub const CONTEXT_PREV_INTRA_LUMA: usize = 17;
pub const CONTEXT_INTRA_CHROMA: usize = 18;
pub const CONTEXT_MERGE_FLAG: usize = 20;
pub const CONTEXT_MERGE_IDX: usize = 21;
pub const CONTEXT_INTER_PRED_IDC: usize = 22;
pub const CONTEXT_REF_IDX: usize = 27;
pub const CONTEXT_MVD_GREATER0: usize = 31;
pub const CONTEXT_MVD_GREATER1: usize = 33;
pub const CONTEXT_MVP_FLAG: usize = 35;
pub const CONTEXT_NO_RESIDUAL: usize = 36;
pub const CONTEXT_SPLIT_TRANSFORM: usize = 37;
pub const CONTEXT_CBF_LUMA: usize = 40;
pub const CONTEXT_CBF_CHROMA: usize = 42;
pub const CONTEXT_TRANSFORM_SKIP: usize = 47;
pub const CONTEXT_EXPLICIT_RDPCM: usize = 49;
pub const CONTEXT_EXPLICIT_RDPCM_DIRECTION: usize = 51;
pub const CONTEXT_LAST_X_PREFIX: usize = 53;
pub const CONTEXT_LAST_Y_PREFIX: usize = 71;
pub const CONTEXT_SIGNIFICANT_GROUP: usize = 89;
pub const CONTEXT_SIGNIFICANT: usize = 93;
pub const CONTEXT_GREATER1: usize = 137;
pub const CONTEXT_GREATER2: usize = 161;
pub const CONTEXT_LOG2_RES_SCALE: usize = 167;
pub const CONTEXT_RES_SCALE_SIGN: usize = 175;
pub const CONTEXT_CU_CHROMA_QP_OFFSET_FLAG: usize = 177;
pub const CONTEXT_CU_CHROMA_QP_OFFSET_IDX: usize = 178;

// Prediction modes and partitions
pub const MODE_INTER: u32 = 0;
pub const MODE_INTRA: u32 = 1;
pub const MODE_SKIP: u32 = 2;
pub const PART_2NX2N: u32 = 0;
pub const PART_2NXN: u32 = 1;
pub const PART_NX2N: u32 = 2;
pub const PART_NXN: u32 = 3;
pub const PART_2NXNU: u32 = 4;
pub const PART_2NXND: u32 = 5;
pub const PART_NLX2N: u32 = 6;
pub const PART_NRX2N: u32 = 7;

// Prediction flags; 0 marks an intra block
pub const PRED_L0: u32 = 1;
pub const PRED_L1: u32 = 2;
pub const PRED_BI: u32 = 3;

// Intra prediction modes with special handling
pub const INTRA_PLANAR: u32 = 0;
pub const INTRA_DC: u32 = 1;
pub const INTRA_ANGULAR_26: u32 = 26;
/// intra_chroma_pred_mode 4, which takes the luma mode
pub const CHROMA_MODE_DERIVED: u32 = 4;

const CONTEXT_INITIALIZATION_MAXIMUM_QP: i32 = 51;
const MAXIMUM_CT_DEPTH: u32 = 3;
const LIST_COUNT: usize = 2;
const SAO_WORDS_PER_CTB: usize = 6;

// What happens to the context variables when a slice segment or substream starts
#[derive(Clone, Copy, PartialEq, Eq)]
enum ContextAction {
    Keep,
    Initialize,
    Synchronize,
}

/// The offset and size of a prediction block of a coding unit's partitioning, as (x, y, width, height).
pub fn partition_geometry(part_mode: u32, cb_size: u32, index: u32) -> [u32; 4] {
    let half: u32 = cb_size >> 1;
    let quarter: u32 = cb_size >> 2;
    let second: bool = index == 1;
    match part_mode {
        PART_2NXN => [0, if second { half } else { 0 }, cb_size, half],
        PART_NX2N => [if second { half } else { 0 }, 0, half, cb_size],
        PART_2NXNU => if second { [0, quarter, cb_size, cb_size - quarter] } else { [0, 0, cb_size, quarter] },
        PART_2NXND => if second { [0, cb_size - quarter, cb_size, quarter] } else { [0, 0, cb_size, cb_size - quarter] },
        PART_NLX2N => if second { [quarter, 0, cb_size - quarter, cb_size] } else { [0, 0, quarter, cb_size] },
        PART_NRX2N => if second { [cb_size - quarter, 0, quarter, cb_size] } else { [0, 0, cb_size - quarter, cb_size] },
        PART_NXN => [(index & 1) * half, (index >> 1) * half, half, half],
        _ => [0, 0, cb_size, cb_size],
    }
}

/// The reusable state of a parse worker: CTB tables, per-picture parse grids, and the job's output streams.
#[derive(Default)]
pub struct ParseResources {
    layout: CTBLayout,
    skip: Vec<u8>,
    depth: Vec<u8>,
    intra_mode: Vec<u8>,
    qp: Vec<i8>,
    sao: Vec<u32>,
    intra_jobs: [Vec<u32>; 3],
    transforms: [Vec<u32>; 4],
    pending_predictions: Vec<[u32; 4]>,
    pub streams: JobStreams,
}

/// Parses units first_unit to first_unit + unit_count of a plan into the resources' streams.
pub fn parse_units(resources: &mut ParseResources, plan: &Plan, first_unit: usize, unit_count: usize) -> DecodeResult<()> {
    let parameters: &PictureParameters = &plan.parameters;
    resources.layout.update(parameters);
    let block_stride: usize = ((parameters.width + 3) >> 2) as usize;
    let block_count: usize = block_stride * ((parameters.height + 3) >> 2) as usize;
    for grid in [&mut resources.skip, &mut resources.depth, &mut resources.intra_mode] {
        if grid.len() < block_count {
            grid.resize(block_count, 0);
        }
    }
    if resources.qp.len() < block_count {
        resources.qp.resize(block_count, 0);
    }
    let sao_words: usize = parameters.ctb_count as usize * 6;
    if resources.sao.len() < sao_words {
        resources.sao.resize(sao_words, 0);
    }
    resources.streams.clear();
    let Some(units) = plan.units.get(first_unit..first_unit + unit_count) else {
        return fail(ERROR_SLICE_DATA, 15);
    };
    let mut parser: Parser = Parser::new(resources, plan, block_stride);
    for unit in units {
        parser.decode_unit(unit)?;
    }
    Ok(())
}

struct Parser<'a> {
    parameters: &'a PictureParameters,
    slices: &'a [SliceHeader],
    segments: &'a [Segment],
    data: &'a [u8],
    layout: &'a CTBLayout,
    skip: &'a mut [u8],
    depth: &'a mut [u8],
    intra_mode: &'a mut [u8],
    qp_grid: &'a mut [i8],
    sao: &'a mut [u32],
    intra_jobs: &'a mut [Vec<u32>; 3],
    transforms: &'a mut [Vec<u32>; 4],
    pending_predictions: &'a mut Vec<[u32; 4]>,
    streams: &'a mut JobStreams,

    // Picture geometry and parameters the syntax reads often
    width: u32,
    height: u32,
    chroma_format: u32,
    horizontal_shift: u32,
    vertical_shift: u32,
    bit_depth_luma: u32,
    bit_depth_chroma: u32,
    ctb_log2: u32,
    ctb_size: u32,
    ctb_width: u32,
    min_tb_log2: u32,
    min_cb_log2: u32,
    block_stride: usize,
    qp_bd_offset: i32,
    min_cu_qp_delta_log2: u32,
    min_cu_chroma_qp_offset_log2: u32,
    transquant_bypass_enabled: bool,
    cu_qp_delta_enabled: bool,
    pub(crate) transform_skip_enabled: bool,
    pub(crate) sign_data_hiding: bool,
    pub(crate) persistent_rice: bool,
    pub(crate) transform_skip_context: bool,
    pub(crate) implicit_rdpcm: bool,
    pub(crate) explicit_rdpcm: bool,
    pub(crate) transform_skip_rotation: bool,
    cross_component_prediction: bool,
    entropy_sync: bool,

    // The arithmetic decoder and context variables
    pub(crate) decoder: ArithmeticDecoder,
    pub(crate) contexts: [u8; CONTEXT_COUNT],
    wpp_contexts: [u8; CONTEXT_COUNT],
    pub(crate) rice_statistics: [u32; 4],
    wpp_rice_statistics: [u32; 4],
    wpp_valid: bool,
    /// Where the next substream starts once a terminating bin ends the current one
    next_position: usize,

    // The slice being decoded
    slice_index: usize,
    slice_type: u32,
    slice_qp: i32,
    slice_address_ts: u32,
    pub(crate) slice_cb_qp_offset: i32,
    pub(crate) slice_cr_qp_offset: i32,
    slice_cu_chroma_qp_offset: bool,
    sao_luma: bool,
    sao_chroma: bool,
    max_merge_candidates: u32,
    reference_counts: [u32; 2],
    mvd_l1_zero: bool,

    // The CTU being decoded, and where its records start in the streams
    ctb_address_rs: u32,
    ctb_address_ts: u32,
    ctb_x: u32,
    ctb_y: u32,
    ctb_prediction_start: usize,
    ctb_edge_start: usize,
    ctb_coefficient_start: usize,

    // Quantization state, the HEVCLocalContext fields of FFmpeg
    pub(crate) qp_y: i32,
    qp_y_prediction: i32,
    first_qp_group: bool,
    is_cu_qp_delta_coded: bool,
    cu_qp_delta: i32,
    is_cu_chroma_qp_offset_coded: bool,
    pub(crate) cu_qp_offset_cb: i32,
    pub(crate) cu_qp_offset_cr: i32,
    ct_depth: u32,

    // The coding unit being decoded
    cu_log2: u32,
    pub(crate) cu_pred_mode: u32,
    cu_part_mode: u32,
    pub(crate) cu_bypass: bool,
    cu_intra_split: bool,
    cu_max_transform_depth: u32,
    pu_merge_flag: bool,
    pu_intra_modes: [u32; 4],
    pu_intra_modes_chroma: [u32; 4],
    pu_chroma_modes: [u32; 4],
    pub(crate) tu_intra_mode: u32,
    pub(crate) tu_intra_mode_chroma: u32,
    tu_chroma_mode: u32,
    pub(crate) tu_cross_scale: i32,
}

impl<'a> Parser<'a> {
    fn new(resources: &'a mut ParseResources, plan: &'a Plan, block_stride: usize) -> Self {
        let parameters: &PictureParameters = &plan.parameters;
        Self {
            parameters,
            slices: &plan.slices,
            segments: &plan.segments,
            data: &plan.data,
            layout: &resources.layout,
            skip: &mut resources.skip,
            depth: &mut resources.depth,
            intra_mode: &mut resources.intra_mode,
            qp_grid: &mut resources.qp,
            sao: &mut resources.sao,
            intra_jobs: &mut resources.intra_jobs,
            transforms: &mut resources.transforms,
            pending_predictions: &mut resources.pending_predictions,
            streams: &mut resources.streams,
            width: parameters.width,
            height: parameters.height,
            chroma_format: parameters.chroma_format,
            horizontal_shift: parameters.horizontal_shift,
            vertical_shift: parameters.vertical_shift,
            bit_depth_luma: parameters.bit_depth,
            bit_depth_chroma: parameters.bit_depth_chroma,
            ctb_log2: parameters.ctb_log2,
            ctb_size: 1 << parameters.ctb_log2,
            ctb_width: parameters.ctb_width,
            min_tb_log2: parameters.min_tb_log2,
            min_cb_log2: parameters.min_cb_log2,
            block_stride,
            qp_bd_offset: parameters.qp_bd_offset,
            min_cu_qp_delta_log2: parameters.min_cu_qp_delta_log2,
            min_cu_chroma_qp_offset_log2: parameters.min_cu_chroma_qp_offset_log2,
            transquant_bypass_enabled: parameters.transquant_bypass == 1,
            cu_qp_delta_enabled: parameters.cu_qp_delta == 1,
            transform_skip_enabled: parameters.transform_skip == 1,
            sign_data_hiding: parameters.sign_data_hiding == 1,
            persistent_rice: parameters.persistent_rice == 1,
            transform_skip_context: parameters.transform_skip_context == 1,
            implicit_rdpcm: parameters.implicit_rdpcm == 1,
            explicit_rdpcm: parameters.explicit_rdpcm == 1,
            transform_skip_rotation: parameters.transform_skip_rotation == 1,
            cross_component_prediction: parameters.cross_component == 1,
            entropy_sync: parameters.entropy_sync == 1,
            decoder: ArithmeticDecoder::default(),
            contexts: [0; CONTEXT_COUNT],
            wpp_contexts: [0; CONTEXT_COUNT],
            rice_statistics: [0; 4],
            wpp_rice_statistics: [0; 4],
            wpp_valid: false,
            next_position: 0,
            slice_index: 0,
            slice_type: SLICE_I,
            slice_qp: 0,
            slice_address_ts: 0,
            slice_cb_qp_offset: 0,
            slice_cr_qp_offset: 0,
            slice_cu_chroma_qp_offset: false,
            sao_luma: false,
            sao_chroma: false,
            max_merge_candidates: 5,
            reference_counts: [0; 2],
            mvd_l1_zero: false,
            ctb_address_rs: 0,
            ctb_address_ts: 0,
            ctb_x: 0,
            ctb_y: 0,
            ctb_prediction_start: 0,
            ctb_edge_start: 0,
            ctb_coefficient_start: 0,
            qp_y: 0,
            qp_y_prediction: 0,
            first_qp_group: true,
            is_cu_qp_delta_coded: false,
            cu_qp_delta: 0,
            is_cu_chroma_qp_offset_coded: false,
            cu_qp_offset_cb: 0,
            cu_qp_offset_cr: 0,
            ct_depth: 0,
            cu_log2: 3,
            cu_pred_mode: MODE_INTRA,
            cu_part_mode: PART_2NX2N,
            cu_bypass: false,
            cu_intra_split: false,
            cu_max_transform_depth: 0,
            pu_merge_flag: false,
            pu_intra_modes: [INTRA_DC; 4],
            pu_intra_modes_chroma: [INTRA_DC; 4],
            pu_chroma_modes: [CHROMA_MODE_DERIVED; 4],
            tu_intra_mode: INTRA_DC,
            tu_intra_mode_chroma: INTRA_DC,
            tu_chroma_mode: CHROMA_MODE_DERIVED,
            tu_cross_scale: 0,
        }
    }

    #[inline(always)]
    pub(crate) fn bin(&mut self, context: usize) -> u32 {
        self.decoder.decode_bin(self.data, &mut self.contexts[context])
    }

    #[inline(always)]
    pub(crate) fn bypass(&mut self) -> u32 {
        self.decoder.decode_bypass(self.data)
    }

    #[inline(always)]
    pub(crate) fn bypass_bits(&mut self, count: u32) -> u32 {
        self.decoder.decode_bypass_bits(self.data, count)
    }

    fn terminate(&mut self) -> u32 {
        self.decoder.decode_terminate(self.data)
    }

    pub(crate) fn plane_horizontal_shift(&self, plane: u32) -> u32 {
        if plane == 0 { 0 } else { self.horizontal_shift }
    }

    pub(crate) fn plane_vertical_shift(&self, plane: u32) -> u32 {
        if plane == 0 { 0 } else { self.vertical_shift }
    }

    pub(crate) fn plane_bit_depth(&self, plane: u32) -> u32 {
        if plane == 0 { self.bit_depth_luma } else { self.bit_depth_chroma }
    }

    pub(crate) fn ctb_plane_origin(&self, plane: u32) -> (u32, u32) {
        ((self.ctb_x << self.ctb_log2) >> self.plane_horizontal_shift(plane), (self.ctb_y << self.ctb_log2) >> self.plane_vertical_shift(plane))
    }

    fn block_index(&self, x: u32, y: u32) -> usize {
        (y >> 2) as usize * self.block_stride + (x >> 2) as usize
    }

    fn is_available(&self, current_x: u32, current_y: u32, neighbour_x: i32, neighbour_y: i32) -> bool {
        self.layout.is_available_in_slice(current_x, current_y, neighbour_x, neighbour_y, self.slice_address_ts)
    }

    /// Initializes every context variable for the slice's initType and SliceQpY (9.3.2.2).
    fn initialize_contexts(&mut self) {
        let mut init_type: usize = (2 - self.slice_type) as usize;
        if self.slice_type != SLICE_I && self.slices[self.slice_index].cabac_init == 1 {
            init_type ^= 3;
        }
        let qp: i32 = self.slice_qp.clamp(0, CONTEXT_INITIALIZATION_MAXIMUM_QP);
        for index in 0..CONTEXT_COUNT {
            let init_value: i32 = i32::from(CONTEXT_INIT_VALUES[init_type * CONTEXT_COUNT + index]);
            let slope: i32 = (init_value >> 4) * 5 - 45;
            let offset: i32 = ((init_value & 15) << 3) - 16;
            let pre_context_state: i32 = (((slope * qp) >> 4) + offset).clamp(1, 126);
            self.contexts[index] = if pre_context_state <= 63 { ((63 - pre_context_state) << 1) as u8 } else { (((pre_context_state - 64) << 1) | 1) as u8 };
        }
        self.rice_statistics = [0; 4];
    }

    fn load_slice(&mut self, slice_index: usize) {
        let slice: &SliceHeader = &self.slices[slice_index];
        self.slice_index = slice_index;
        self.slice_type = slice.slice_type;
        self.slice_qp = slice.qp;
        self.slice_address_ts = slice.address_ts;
        self.slice_cb_qp_offset = slice.cb_qp_offset;
        self.slice_cr_qp_offset = slice.cr_qp_offset;
        self.slice_cu_chroma_qp_offset = slice.cu_chroma_qp_offset == 1;
        self.sao_luma = slice.sao_luma == 1;
        self.sao_chroma = slice.sao_chroma == 1;
        self.max_merge_candidates = slice.max_merge_candidates;
        self.reference_counts = slice.reference_counts;
        self.mvd_l1_zero = slice.mvd_l1_zero == 1;
    }

    /// The first CTB column of the tile holding CTB column x.
    fn tile_column_start(&self, x: u32) -> u32 {
        let columns: usize = self.parameters.tile_columns as usize;
        for column in 0..columns {
            if x < self.parameters.column_boundaries[column + 1] {
                return self.parameters.column_boundaries[column];
            }
        }
        0
    }

    fn is_first_ctb_in_tile(&self, ctb_ts: u32) -> bool {
        ctb_ts == 0 || self.layout.tile_id[ctb_ts as usize] != self.layout.tile_id[ctb_ts as usize - 1]
    }

    /// Decodes one unit, up to the CTB the next one starts at.
    fn decode_unit(&mut self, unit: &Unit) -> DecodeResult<()> {
        let mut segment: usize = unit.first_segment as usize;
        let last_segment: usize = unit.last_segment as usize;
        self.load_slice(self.segments[segment].slice as usize);
        // A unit starts as a slice or a tile does: with the slice QP, no QP prediction, and nothing carried from another unit
        self.qp_y = self.slice_qp;
        self.qp_y_prediction = self.slice_qp;
        self.first_qp_group = true;
        self.cu_qp_offset_cb = 0;
        self.cu_qp_offset_cr = 0;
        self.rice_statistics = [0; 4];
        self.wpp_rice_statistics = [0; 4];
        self.wpp_valid = false;
        let mut pending: u32 = unit.start;
        self.next_position = unit.position as usize;
        let mut end: usize = self.segments[segment].data_end as usize;
        self.ctb_address_ts = unit.ctb_ts;
        let end_ctb_ts: u32 = unit.end_ctb_ts;
        let ctb_count: u32 = self.parameters.ctb_count;
        loop {
            if self.ctb_address_ts >= ctb_count {
                return fail(ERROR_SLICE_DATA, 10);
            }
            self.ctb_address_rs = self.layout.ts_to_rs[self.ctb_address_ts as usize];
            self.ctb_x = self.ctb_address_rs % self.ctb_width;
            self.ctb_y = self.ctb_address_rs / self.ctb_width;
            let x_ctb: u32 = self.ctb_x << self.ctb_log2;
            let y_ctb: u32 = self.ctb_y << self.ctb_log2;
            let first_in_tile: bool = self.is_first_ctb_in_tile(self.ctb_address_ts);
            let first_in_tile_row: bool = self.entropy_sync && self.ctb_x == self.tile_column_start(self.ctb_x);
            // Context variables at a slice segment or substream start (9.3.1): kept, initialized, or synchronized from the WPP storage
            let mut action: ContextAction = ContextAction::Keep;
            if pending == UNIT_STARTS_SEGMENT {
                let record: Segment = self.segments[segment];
                let dependent: bool = record.dependent == 1;
                self.next_position = record.data_offset as usize;
                end = record.data_end as usize;
                if first_in_tile {
                    action = ContextAction::Initialize;
                } else if first_in_tile_row {
                    action = ContextAction::Synchronize;
                } else if !dependent {
                    action = ContextAction::Initialize;
                }
                if !dependent {
                    self.first_qp_group = true;
                    self.qp_y = self.slice_qp;
                    self.qp_y_prediction = self.slice_qp;
                    self.cu_qp_offset_cb = 0;
                    self.cu_qp_offset_cr = 0;
                }
            } else if pending == UNIT_STARTS_SUBSTREAM {
                action = if first_in_tile { ContextAction::Initialize } else { ContextAction::Synchronize };
            }
            if pending != 0 && !self.decoder.start(self.data, self.next_position, end) {
                return fail(ERROR_SLICE_DATA, 16);
            }
            // Synchronization needs the stored state of the CTB above and to the right, in the same slice and tile
            if action == ContextAction::Synchronize
                && !(self.wpp_valid && self.is_available(x_ctb, y_ctb, (x_ctb + self.ctb_size) as i32, y_ctb as i32 - self.ctb_size as i32))
            {
                action = ContextAction::Initialize;
            }
            match action {
                ContextAction::Initialize => self.initialize_contexts(),
                ContextAction::Synchronize => {
                    self.contexts = self.wpp_contexts;
                    self.rice_statistics = self.wpp_rice_statistics;
                }
                ContextAction::Keep => {}
            }
            if first_in_tile || first_in_tile_row {
                self.first_qp_group = true;
            }
            if !self.cu_qp_delta_enabled {
                self.qp_y = self.slice_qp;
            }
            pending = 0;

            self.begin_ctb();
            self.decode_sao_parameters()?;
            let end_of_slice: u32 = self.decode_coding_quadtree(x_ctb, y_ctb)?;
            self.finish_ctb();
            self.ctb_address_ts += 1;
            if self.entropy_sync && self.ctb_x - self.tile_column_start(self.ctb_x) == 1 {
                self.wpp_contexts = self.contexts;
                self.wpp_rice_statistics = self.rice_statistics;
                self.wpp_valid = true;
            }
            // The unit ends where the next one starts: after its last segment's end, or after its tile's end_of_subset_one_bit
            if self.ctb_address_ts >= end_ctb_ts {
                if end_of_slice == 0 && self.terminate() != 1 {
                    return fail(ERROR_SLICE_DATA, 14);
                }
                return Ok(());
            }
            if end_of_slice == 1 {
                if segment >= last_segment {
                    return Ok(());
                }
                segment += 1;
                if self.segments[segment].address_ts != self.ctb_address_ts {
                    return fail(ERROR_SLICE_DATA, 11);
                }
                pending = UNIT_STARTS_SEGMENT;
                continue;
            }
            if self.ctb_address_ts >= ctb_count {
                return fail(ERROR_SLICE_DATA, 12);
            }
            let next_rs: u32 = self.layout.ts_to_rs[self.ctb_address_ts as usize];
            let next_x: u32 = next_rs % self.ctb_width;
            if self.is_first_ctb_in_tile(self.ctb_address_ts) || (self.entropy_sync && next_x == self.tile_column_start(next_x)) {
                // end_of_subset_one_bit, then byte_alignment(); the next substream starts at the next byte
                if self.terminate() != 1 {
                    return fail(ERROR_SLICE_DATA, 13);
                }
                self.next_position = self.decoder.stop_position();
                pending = UNIT_STARTS_SUBSTREAM;
            }
        }
    }

    /// Starts a CTB's records; the prediction, edge, and coefficient streams grow in CTB order, so each CTB's records are contiguous.
    fn begin_ctb(&mut self) {
        for list in self.intra_jobs.iter_mut() {
            list.clear();
        }
        for list in self.transforms.iter_mut() {
            list.clear();
        }
        self.ctb_prediction_start = self.streams.predictions.len();
        self.ctb_edge_start = self.streams.edges.len();
        self.ctb_coefficient_start = self.streams.coefficients.len();
    }

    /// Writes the CTB's entry: its slice, SAO parameters, and where its records sit in the streams.
    fn finish_ctb(&mut self) {
        let streams: &mut JobStreams = self.streams;
        let entry_start: usize = streams.ctb_entries.len();
        streams.ctb_entries.resize(entry_start + JOB_CTB_ENTRY_WORDS, 0);
        let entry: &mut [u32] = &mut streams.ctb_entries[entry_start..];
        entry[0] = self.ctb_address_rs;
        let record: &mut [u32] = &mut entry[1..];
        record[CTB_SLICE as usize] = self.slice_index as u32;
        let sao_base: usize = self.ctb_address_rs as usize * SAO_WORDS_PER_CTB;
        let sao_field: usize = CTB_SAO_LUMA_TYPE as usize;
        record[sao_field..sao_field + SAO_WORDS_PER_CTB].copy_from_slice(&self.sao[sao_base..sao_base + SAO_WORDS_PER_CTB]);
        record[CTB_PREDICTION_OFFSET as usize] = self.ctb_prediction_start as u32;
        record[CTB_PREDICTION_COUNT as usize] = ((streams.predictions.len() - self.ctb_prediction_start) / PREDICTION_RECORD_WORDS) as u32;
        record[CTB_EDGE_OFFSET as usize] = self.ctb_edge_start as u32;
        record[CTB_EDGE_COUNT as usize] = (streams.edges.len() - self.ctb_edge_start) as u32;
        record[CTB_COEFFICIENT_OFFSET as usize] = self.ctb_coefficient_start as u32;
        record[CTB_COEFFICIENT_COUNT as usize] = (streams.coefficients.len() - self.ctb_coefficient_start) as u32;
        record[CTB_JOB_OFFSET as usize] = streams.jobs.len() as u32;
        for (plane, list) in self.intra_jobs.iter().enumerate() {
            record[CTB_INTRA_COUNT_LUMA as usize + plane] = list.len() as u32;
            streams.jobs.extend_from_slice(list);
        }
        for (size_index, list) in self.transforms.iter().enumerate() {
            record[CTB_TRANSFORM_COUNT_4 as usize + size_index] = list.len() as u32;
            streams.jobs.extend_from_slice(list);
        }
    }

    /// sao (7.3.8.3); offsets are stored scaled, as signed bytes.
    fn decode_sao_parameters(&mut self) -> DecodeResult<()> {
        let x_ctb: u32 = self.ctb_x << self.ctb_log2;
        let y_ctb: u32 = self.ctb_y << self.ctb_log2;
        let mut merge_left: bool = false;
        let mut merge_up: bool = false;
        if self.sao_luma || self.sao_chroma {
            if self.ctb_x > 0 && self.is_available(x_ctb, y_ctb, x_ctb as i32 - 1, y_ctb as i32) {
                merge_left = self.bin(CONTEXT_SAO_MERGE) == 1;
            }
            if self.ctb_y > 0 && !merge_left && self.is_available(x_ctb, y_ctb, x_ctb as i32, y_ctb as i32 - 1) {
                merge_up = self.bin(CONTEXT_SAO_MERGE) == 1;
            }
        }
        let record: usize = self.ctb_address_rs as usize * 6;
        let source: usize = if merge_left {
            record - 6
        } else if merge_up {
            record - self.ctb_width as usize * 6
        } else {
            record
        };
        let component_count: u32 = if self.chroma_format != 0 { 3 } else { 1 };
        for component in 0..3u32 {
            let type_word: usize = record + component as usize * 2;
            let enabled: bool = component < component_count && if component == 0 { self.sao_luma } else { self.sao_chroma };
            if !enabled {
                self.sao[type_word] = SAO_NOT_APPLIED;
                self.sao[type_word + 1] = 0;
                continue;
            }
            if merge_left || merge_up {
                self.sao[type_word] = self.sao[source + component as usize * 2];
                self.sao[type_word + 1] = self.sao[source + component as usize * 2 + 1];
                continue;
            }
            let mut sao_type: u32 = SAO_NOT_APPLIED;
            let mut edge_class: u32 = 0;
            if component == 2 {
                sao_type = self.sao[record + 2] & 3;
                edge_class = (self.sao[record + 2] >> SAO_POSITION_SHIFT) & 31;
            } else if self.bin(CONTEXT_SAO_TYPE) == 1 {
                sao_type = if self.bypass() == 1 { SAO_EDGE } else { SAO_BAND };
            }
            if sao_type == SAO_NOT_APPLIED {
                self.sao[type_word] = SAO_NOT_APPLIED;
                self.sao[type_word + 1] = 0;
                continue;
            }
            let bit_depth: u32 = self.plane_bit_depth(component);
            let offset_maximum: u32 = (1 << (bit_depth.min(10) - 5)) - 1;
            let mut absolute_offsets: [u32; 4] = [0; 4];
            for offset in &mut absolute_offsets {
                let mut value: u32 = 0;
                while value < offset_maximum && self.bypass() == 1 {
                    value += 1;
                }
                *offset = value;
            }
            let scale: u32 = if component == 0 { self.parameters.log2_sao_offset_scale_luma } else { self.parameters.log2_sao_offset_scale_chroma };
            let mut packed_offsets: u32 = 0;
            let position: u32;
            if sao_type == SAO_BAND {
                let mut signs: u32 = 0;
                for (index, &offset) in absolute_offsets.iter().enumerate() {
                    if offset != 0 {
                        signs |= self.bypass() << index;
                    }
                }
                position = self.bypass_bits(5);
                for (index, &offset) in absolute_offsets.iter().enumerate() {
                    let mut value: i32 = (offset << scale) as i32;
                    if (signs >> index) & 1 == 1 {
                        value = -value;
                    }
                    packed_offsets |= (value as u32 & 0xFF) << (index * 8);
                }
            } else {
                if component != 2 {
                    edge_class = self.bypass_bits(2);
                }
                position = edge_class;
                for (index, &offset) in absolute_offsets.iter().enumerate() {
                    let mut value: i32 = (offset << scale) as i32;
                    if index > 1 {
                        value = -value;
                    }
                    packed_offsets |= (value as u32 & 0xFF) << (index * 8);
                }
            }
            self.sao[type_word] = sao_type | (position << SAO_POSITION_SHIFT);
            self.sao[type_word + 1] = packed_offsets;
        }
        Ok(())
    }

    /// coding_quadtree (7.3.8.4) over an explicit stack; returns end_of_slice_segment_flag.
    fn decode_coding_quadtree(&mut self, x_ctb: u32, y_ctb: u32) -> DecodeResult<u32> {
        let mut node_x: [u32; 4] = [0; 4];
        let mut node_y: [u32; 4] = [0; 4];
        let mut node_child: [u32; 4] = [0; 4];
        let mut depth: i32 = 0;
        let mut end_of_slice: u32 = 0;
        node_x[0] = x_ctb;
        node_y[0] = y_ctb;
        while depth >= 0 {
            let level: usize = depth as usize;
            let x: u32 = node_x[level];
            let y: u32 = node_y[level];
            let log2_size: u32 = self.ctb_log2 - level as u32;
            let size: u32 = 1 << log2_size;
            let child: u32 = node_child[level];
            if child == 0 {
                self.ct_depth = level as u32;
                let mut split: bool = log2_size > self.min_cb_log2;
                if x + size <= self.width && y + size <= self.height && log2_size > self.min_cb_log2 {
                    let mut increment: usize = 0;
                    if self.is_available(x, y, x as i32 - 1, y as i32) && u32::from(self.depth[self.block_index(x - 1, y)]) > level as u32 {
                        increment += 1;
                    }
                    if self.is_available(x, y, x as i32, y as i32 - 1) && u32::from(self.depth[self.block_index(x, y - 1)]) > level as u32 {
                        increment += 1;
                    }
                    split = self.bin(CONTEXT_SPLIT_CU + increment) == 1;
                }
                if self.cu_qp_delta_enabled && log2_size >= self.min_cu_qp_delta_log2 {
                    self.is_cu_qp_delta_coded = false;
                    self.cu_qp_delta = 0;
                }
                if self.slice_cu_chroma_qp_offset && log2_size >= self.min_cu_chroma_qp_offset_log2 {
                    self.is_cu_chroma_qp_offset_coded = false;
                }
                if split {
                    node_child[level] = 1;
                    node_x[level + 1] = x;
                    node_y[level + 1] = y;
                    node_child[level + 1] = 0;
                    depth += 1;
                    continue;
                }
                self.decode_coding_unit(x, y, log2_size)?;
                let right_edge: bool = (x + size) & (self.ctb_size - 1) == 0 || x + size >= self.width;
                let bottom_edge: bool = (y + size) & (self.ctb_size - 1) == 0 || y + size >= self.height;
                if right_edge && bottom_edge {
                    end_of_slice = self.terminate();
                }
                depth -= 1;
                continue;
            }
            let half: u32 = size >> 1;
            let mut next_child: u32 = child;
            while next_child < 4 {
                let child_x: u32 = x + if next_child & 1 == 1 { half } else { 0 };
                let child_y: u32 = y + if next_child >= 2 { half } else { 0 };
                if child_x < self.width && child_y < self.height {
                    break;
                }
                next_child += 1;
            }
            if next_child < 4 {
                node_child[level] = next_child + 1;
                node_x[level + 1] = x + if next_child & 1 == 1 { half } else { 0 };
                node_y[level + 1] = y + if next_child >= 2 { half } else { 0 };
                node_child[level + 1] = 0;
                depth += 1;
                continue;
            }
            let group_mask: u32 = (1 << self.min_cu_qp_delta_log2) - 1;
            if (x + size) & group_mask == 0 && (y + size) & group_mask == 0 {
                self.qp_y_prediction = self.qp_y;
            }
            depth -= 1;
        }
        Ok(end_of_slice)
    }

    /// QpY prediction (8.6.1).
    fn predict_qp_y(&mut self, x_base: u32, y_base: u32) -> i32 {
        let ctb_mask: u32 = self.ctb_size - 1;
        let group_mask: u32 = (1 << self.min_cu_qp_delta_log2) - 1;
        let x_group: u32 = x_base - (x_base & group_mask);
        let y_group: u32 = y_base - (y_base & group_mask);
        let available_a: bool = x_base & ctb_mask != 0 && x_group & ctb_mask != 0;
        let available_b: bool = y_base & ctb_mask != 0 && y_group & ctb_mask != 0;
        let mut prediction: i32 = self.qp_y_prediction;
        if self.first_qp_group || (x_group == 0 && y_group == 0) {
            self.first_qp_group = !self.is_cu_qp_delta_coded;
            prediction = self.slice_qp;
        }
        let qp_a: i32 = if available_a { i32::from(self.qp_grid[self.block_index(x_group - 1, y_group)]) } else { prediction };
        let qp_b: i32 = if available_b { i32::from(self.qp_grid[self.block_index(x_group, y_group - 1)]) } else { prediction };
        (qp_a + qp_b + 1) >> 1
    }

    fn set_qp_y(&mut self, x_base: u32, y_base: u32) {
        let prediction: i32 = self.predict_qp_y(x_base, y_base);
        if self.cu_qp_delta != 0 {
            let modulus: i32 = 52 + self.qp_bd_offset;
            self.qp_y = ((prediction + self.cu_qp_delta + 52 + 2 * self.qp_bd_offset).rem_euclid(modulus)) - self.qp_bd_offset;
        } else {
            self.qp_y = prediction;
        }
    }

    /// coding_unit (7.3.8.5).
    fn decode_coding_unit(&mut self, x0: u32, y0: u32, log2_cb_size: u32) -> DecodeResult<()> {
        let cb_size: u32 = 1 << log2_cb_size;
        self.cu_log2 = log2_cb_size;
        self.cu_pred_mode = MODE_INTRA;
        self.cu_part_mode = PART_2NX2N;
        self.cu_intra_split = false;
        self.pu_merge_flag = false;
        self.pu_intra_modes = [INTRA_DC; 4];
        self.pu_intra_modes_chroma = [INTRA_DC; 4];
        self.pu_chroma_modes = [CHROMA_MODE_DERIVED; 4];
        self.pending_predictions.clear();
        self.cu_bypass = false;
        if self.transquant_bypass_enabled {
            self.cu_bypass = self.bin(CONTEXT_TRANSQUANT_BYPASS) == 1;
        }
        let mut skip: bool = false;
        if self.slice_type != SLICE_I {
            let mut increment: usize = 0;
            if self.is_available(x0, y0, x0 as i32 - 1, y0 as i32) && self.skip[self.block_index(x0 - 1, y0)] != 0 {
                increment += 1;
            }
            if self.is_available(x0, y0, x0 as i32, y0 as i32 - 1) && self.skip[self.block_index(x0, y0 - 1)] != 0 {
                increment += 1;
            }
            skip = self.bin(CONTEXT_SKIP + increment) == 1;
            self.cu_pred_mode = if skip { MODE_SKIP } else { MODE_INTER };
        }
        let mut pcm: bool = false;
        if !skip {
            if self.slice_type != SLICE_I {
                self.cu_pred_mode = if self.bin(CONTEXT_PRED_MODE) == 1 { MODE_INTRA } else { MODE_INTER };
            }
            if self.cu_pred_mode != MODE_INTRA || log2_cb_size == self.min_cb_log2 {
                self.cu_part_mode = self.decode_part_mode(log2_cb_size);
                self.cu_intra_split = self.cu_part_mode == PART_NXN && self.cu_pred_mode == MODE_INTRA;
            }
            if self.cu_pred_mode == MODE_INTRA {
                let parameters: &PictureParameters = self.parameters;
                if self.cu_part_mode == PART_2NX2N
                    && parameters.pcm == 1
                    && log2_cb_size >= parameters.pcm_min_log2
                    && log2_cb_size <= parameters.pcm_max_log2
                {
                    pcm = self.terminate() == 1;
                }
                if pcm {
                    self.set_intra_modes(x0, y0, cb_size, INTRA_DC);
                    self.decode_pcm_samples(x0, y0, log2_cb_size)?;
                } else {
                    self.decode_intra_prediction_units(x0, y0, log2_cb_size);
                }
            }
        }
        if self.cu_pred_mode != MODE_INTRA {
            self.decode_prediction_units(x0, y0, cb_size)?;
        }
        // rqt_root_cbf, then the transform tree; a coding unit without one is a single transform edge for deblocking
        let mut residual: bool = !skip && !pcm;
        if residual && self.cu_pred_mode != MODE_INTRA && !(self.cu_part_mode == PART_2NX2N && self.pu_merge_flag) {
            residual = self.bin(CONTEXT_NO_RESIDUAL) == 1;
        }
        if residual {
            self.cu_max_transform_depth = if self.cu_pred_mode == MODE_INTRA {
                self.parameters.max_transform_depth_intra + u32::from(self.cu_intra_split)
            } else {
                self.parameters.max_transform_depth_inter
            };
            self.decode_transform_tree(x0, y0, log2_cb_size)?;
        } else {
            self.emit_edge(x0, y0, log2_cb_size, false);
        }
        if self.cu_qp_delta_enabled && !self.is_cu_qp_delta_coded {
            self.set_qp_y(x0, y0);
        }
        // The coding unit's fields for its neighbours, and its prediction records with QpY and the filter bypass
        let bypass_filters: bool = (self.cu_bypass && self.transquant_bypass_enabled) || (pcm && self.parameters.pcm_loop_filter_disabled == 1);
        let qp_field: u32 = ((self.qp_y as u32) & 0xFF) << BLOCK_QP_SHIFT;
        let bypass_field: u32 = u32::from(bypass_filters) << BLOCK_BYPASS_SHIFT;
        if self.cu_pred_mode == MODE_INTRA {
            let size4: u32 = (cb_size >> 2) - 1;
            let geometry: u32 = (((x0 & (self.ctb_size - 1)) >> 2) << PREDICTION_X_SHIFT)
                | (((y0 & (self.ctb_size - 1)) >> 2) << PREDICTION_Y_SHIFT)
                | (size4 << PREDICTION_WIDTH_SHIFT)
                | (size4 << PREDICTION_HEIGHT_SHIFT);
            self.streams.predictions.extend_from_slice(&[geometry, qp_field | bypass_field, 0, 0]);
        } else {
            for record in self.pending_predictions.iter() {
                self.streams.predictions.extend_from_slice(&[record[0], record[1] | qp_field | bypass_field, record[2], record[3]]);
            }
        }
        let depth_value: u8 = self.ct_depth.min(MAXIMUM_CT_DEPTH) as u8;
        let skip_value: u8 = u8::from(skip);
        let qp_value: i8 = self.qp_y as i8;
        let clipped_width: u32 = cb_size.min(self.width - x0);
        let clipped_height: u32 = cb_size.min(self.height - y0);
        let inter: bool = self.cu_pred_mode != MODE_INTRA;
        for y in (y0..y0 + clipped_height).step_by(4) {
            let row: usize = (y >> 2) as usize * self.block_stride;
            for x in (x0..x0 + clipped_width).step_by(4) {
                let index: usize = row + (x >> 2) as usize;
                self.depth[index] = depth_value;
                self.skip[index] = skip_value;
                self.qp_grid[index] = qp_value;
                if inter {
                    self.intra_mode[index] = INTRA_DC as u8;
                }
            }
        }
        let group_mask: u32 = (1 << self.min_cu_qp_delta_log2) - 1;
        if (x0 + cb_size) & group_mask == 0 && (y0 + cb_size) & group_mask == 0 {
            self.qp_y_prediction = self.qp_y;
        }
        Ok(())
    }

    fn set_intra_modes(&mut self, x0: u32, y0: u32, size: u32, mode: u32) {
        let size: u32 = size.max(4);
        for y in (y0..(y0 + size).min(self.height)).step_by(4) {
            for x in (x0..(x0 + size).min(self.width)).step_by(4) {
                let index: usize = self.block_index(x, y);
                self.intra_mode[index] = mode as u8;
            }
        }
    }

    fn decode_part_mode(&mut self, log2_cb_size: u32) -> u32 {
        if self.bin(CONTEXT_PART_MODE) == 1 {
            return PART_2NX2N;
        }
        if log2_cb_size == self.min_cb_log2 {
            if self.cu_pred_mode == MODE_INTRA {
                return PART_NXN;
            }
            if self.bin(CONTEXT_PART_MODE + 1) == 1 {
                return PART_2NXN;
            }
            if log2_cb_size == 3 {
                return PART_NX2N;
            }
            if self.bin(CONTEXT_PART_MODE + 2) == 1 {
                return PART_NX2N;
            }
            return PART_NXN;
        }
        if self.parameters.amp == 0 {
            return if self.bin(CONTEXT_PART_MODE + 1) == 1 { PART_2NXN } else { PART_NX2N };
        }
        if self.bin(CONTEXT_PART_MODE + 1) == 1 {
            if self.bin(CONTEXT_PART_MODE + 3) == 1 {
                return PART_2NXN;
            }
            return if self.bypass() == 1 { PART_2NXND } else { PART_2NXNU };
        }
        if self.bin(CONTEXT_PART_MODE + 3) == 1 {
            return PART_NX2N;
        }
        if self.bypass() == 1 { PART_NRX2N } else { PART_NLX2N }
    }

    /// The prediction units of an inter or skipped coding unit, in partition order.
    fn decode_prediction_units(&mut self, x0: u32, y0: u32, cb_size: u32) -> DecodeResult<()> {
        let count: u32 = match self.cu_part_mode {
            PART_2NX2N => 1,
            PART_NXN => 4,
            _ => 2,
        };
        for index in 0..count {
            let geometry: [u32; 4] = partition_geometry(self.cu_part_mode, cb_size, index);
            self.decode_prediction_unit(x0 + geometry[0], y0 + geometry[1], geometry[2], geometry[3], index)?;
        }
        Ok(())
    }

    fn decode_ref_idx(&mut self, count: u32) -> u32 {
        let maximum: u32 = count - 1;
        let context_maximum: u32 = maximum.min(2);
        let mut index: u32 = 0;
        while index < context_maximum && self.bin(CONTEXT_REF_IDX + index as usize) == 1 {
            index += 1;
        }
        if index == 2 {
            while index < maximum && self.bypass() == 1 {
                index += 1;
            }
        }
        index
    }

    fn decode_mvd_component(&mut self, greater: u32) -> DecodeResult<i32> {
        if greater == 0 {
            return Ok(0);
        }
        let mut magnitude: u32 = 1;
        if greater == 2 {
            // abs_mvd_minus2 as first-order Exp-Golomb
            magnitude = 2;
            let mut exponent: u32 = 1;
            while exponent < 31 && self.bypass() == 1 {
                magnitude = magnitude.wrapping_add(1 << exponent);
                exponent += 1;
            }
            if exponent == 31 {
                return fail(ERROR_SLICE_DATA, 4);
            }
            magnitude = magnitude.wrapping_add(self.bypass_bits(exponent));
        }
        if self.bypass() == 1 {
            return Ok((magnitude as i32).wrapping_neg());
        }
        Ok(magnitude as i32)
    }

    /// mvd_coding (7.3.8.9): both greater-than-0 flags, both greater-than-1 flags, then each component's remainder and sign.
    /// Returns the difference as two 16-bit fields, which is exact for the 16-bit wrap of the predictor sum.
    fn decode_motion_vector_difference(&mut self) -> DecodeResult<u32> {
        let mut greater: [u32; 2] = [self.bin(CONTEXT_MVD_GREATER0), self.bin(CONTEXT_MVD_GREATER0)];
        for value in &mut greater {
            if *value == 1 {
                *value += self.bin(CONTEXT_MVD_GREATER1 + 1);
            }
        }
        let horizontal: i32 = self.decode_mvd_component(greater[0])?;
        let vertical: i32 = self.decode_mvd_component(greater[1])?;
        Ok((horizontal as u32 & 0xFFFF) | ((vertical as u32) << 16))
    }

    /// prediction_unit (7.3.8.6): its syntax, which motion derivation turns into vectors in decode order.
    fn decode_prediction_unit(&mut self, x0: u32, y0: u32, width: u32, height: u32, part_index: u32) -> DecodeResult<()> {
        let mut merge_flag: bool = self.cu_pred_mode == MODE_SKIP;
        if !merge_flag {
            merge_flag = self.bin(CONTEXT_MERGE_FLAG) == 1;
        }
        self.pu_merge_flag = merge_flag;
        let mut syntax: u32 = (u32::from(merge_flag) << SYNTAX_MERGE_FLAG_SHIFT)
            | (part_index << SYNTAX_PART_INDEX_SHIFT)
            | (self.cu_part_mode << SYNTAX_PART_MODE_SHIFT)
            | ((self.cu_log2 - SYNTAX_CU_LOG2_BASE) << SYNTAX_CU_LOG2_SHIFT);
        let mut fields: u32 = 0;
        let mut differences: [u32; 2] = [0; 2];
        if merge_flag {
            let mut merge_index: u32 = 0;
            if self.max_merge_candidates > 1 {
                merge_index = self.bin(CONTEXT_MERGE_IDX);
                if merge_index != 0 {
                    while merge_index < self.max_merge_candidates - 1 && self.bypass() == 1 {
                        merge_index += 1;
                    }
                }
            }
            syntax |= merge_index << SYNTAX_MERGE_INDEX_SHIFT;
        } else {
            let mut inter_pred_idc: u32 = PRED_L0;
            if self.slice_type == SLICE_B {
                if width + height == 12 {
                    inter_pred_idc = if self.bin(CONTEXT_INTER_PRED_IDC + 4) == 1 { PRED_L1 } else { PRED_L0 };
                } else if self.bin(CONTEXT_INTER_PRED_IDC + self.ct_depth as usize) == 1 {
                    inter_pred_idc = PRED_BI;
                } else {
                    inter_pred_idc = if self.bin(CONTEXT_INTER_PRED_IDC + 4) == 1 { PRED_L1 } else { PRED_L0 };
                }
            }
            syntax |= inter_pred_idc << SYNTAX_INTER_PRED_IDC_SHIFT;
            for list in 0..LIST_COUNT {
                if inter_pred_idc & (1 << list) == 0 {
                    continue;
                }
                let mut ref_idx: u32 = 0;
                if self.reference_counts[list] > 0 {
                    ref_idx = self.decode_ref_idx(self.reference_counts[list]);
                }
                fields |= ref_idx << (list * 4);
                if !(list == 1 && self.mvd_l1_zero && inter_pred_idc == PRED_BI) {
                    differences[list] = self.decode_motion_vector_difference()?;
                }
                let mvp_flag: u32 = self.bin(CONTEXT_MVP_FLAG);
                syntax |= mvp_flag << if list == 0 { SYNTAX_MVP_L0_SHIFT } else { SYNTAX_MVP_L1_SHIFT };
            }
        }
        let geometry: u32 = (((x0 & (self.ctb_size - 1)) >> 2) << PREDICTION_X_SHIFT)
            | (((y0 & (self.ctb_size - 1)) >> 2) << PREDICTION_Y_SHIFT)
            | (((width >> 2) - 1) << PREDICTION_WIDTH_SHIFT)
            | (((height >> 2) - 1) << PREDICTION_HEIGHT_SHIFT);
        self.pending_predictions.push([geometry | syntax, fields, differences[0], differences[1]]);
        Ok(())
    }

    /// The luma intra prediction mode of a prediction block (8.4.2).
    fn derive_luma_intra_mode(&mut self, x0: u32, y0: u32, pu_size: u32, previous_flag: u32, mpm_index: u32, remaining_mode: u32) -> u32 {
        let mut candidate_left: u32 = INTRA_DC;
        if self.is_available(x0, y0, x0 as i32 - 1, y0 as i32) {
            candidate_left = u32::from(self.intra_mode[self.block_index(x0 - 1, y0)]);
        }
        let mut candidate_up: u32 = INTRA_DC;
        let ctb_top: u32 = (y0 >> self.ctb_log2) << self.ctb_log2;
        if y0 > ctb_top && self.is_available(x0, y0, x0 as i32, y0 as i32 - 1) {
            candidate_up = u32::from(self.intra_mode[self.block_index(x0, y0 - 1)]);
        }
        let mut candidates: [u32; 3];
        if candidate_left == candidate_up {
            if candidate_left < 2 {
                candidates = [INTRA_PLANAR, INTRA_DC, INTRA_ANGULAR_26];
            } else {
                candidates = [candidate_left, 2 + ((candidate_left - 2 + 31) & 31), 2 + ((candidate_left - 2 + 1) & 31)];
            }
        } else {
            let third: u32 = if candidate_left != INTRA_PLANAR && candidate_up != INTRA_PLANAR {
                INTRA_PLANAR
            } else if candidate_left != INTRA_DC && candidate_up != INTRA_DC {
                INTRA_DC
            } else {
                INTRA_ANGULAR_26
            };
            candidates = [candidate_left, candidate_up, third];
        }
        let mode: u32 = if previous_flag == 1 {
            candidates[mpm_index as usize]
        } else {
            candidates.sort_unstable();
            let mut mode: u32 = remaining_mode;
            for candidate in candidates {
                if mode >= candidate {
                    mode += 1;
                }
            }
            mode
        };
        self.set_intra_modes(x0, y0, pu_size, mode);
        mode
    }

    fn decode_intra_chroma_mode(&mut self) -> u32 {
        if self.bin(CONTEXT_INTRA_CHROMA) == 0 {
            return CHROMA_MODE_DERIVED;
        }
        self.bypass_bits(2)
    }

    fn derive_chroma_mode(chroma_mode: u32, luma_mode: u32) -> u32 {
        if chroma_mode == CHROMA_MODE_DERIVED {
            return luma_mode;
        }
        if luma_mode == INTRA_CHROMA_MODES[chroma_mode as usize] {
            return 34;
        }
        INTRA_CHROMA_MODES[chroma_mode as usize]
    }

    /// The intra prediction syntax of a coding unit and its luma and chroma modes.
    fn decode_intra_prediction_units(&mut self, x0: u32, y0: u32, log2_cb_size: u32) {
        let split: bool = self.cu_part_mode == PART_NXN;
        let pb_size: u32 = (1 << log2_cb_size) >> u32::from(split);
        let side: u32 = if split { 2 } else { 1 };
        let mut previous_flags: u32 = 0;
        for index in 0..side * side {
            previous_flags |= self.bin(CONTEXT_PREV_INTRA_LUMA) << index;
        }
        for row in 0..side {
            for column in 0..side {
                let index: usize = (row * 2 + column) as usize;
                let previous_flag: u32 = (previous_flags >> (row * side + column)) & 1;
                let mut mpm_index: u32 = 0;
                let mut remaining_mode: u32 = 0;
                if previous_flag == 1 {
                    while mpm_index < 2 && self.bypass() == 1 {
                        mpm_index += 1;
                    }
                } else {
                    remaining_mode = self.bypass_bits(5);
                }
                self.pu_intra_modes[index] = self.derive_luma_intra_mode(x0 + pb_size * column, y0 + pb_size * row, pb_size, previous_flag, mpm_index, remaining_mode);
            }
        }
        if self.chroma_format == 3 {
            for row in 0..side {
                for column in 0..side {
                    let index: usize = (row * 2 + column) as usize;
                    let chroma_mode: u32 = self.decode_intra_chroma_mode();
                    self.pu_chroma_modes[index] = chroma_mode;
                    self.pu_intra_modes_chroma[index] = Self::derive_chroma_mode(chroma_mode, self.pu_intra_modes[index]);
                }
            }
        } else if self.chroma_format != 0 {
            let chroma_mode: u32 = self.decode_intra_chroma_mode();
            self.pu_chroma_modes[0] = chroma_mode;
            let mode: u32 = Self::derive_chroma_mode(chroma_mode, self.pu_intra_modes[0]);
            self.pu_intra_modes_chroma[0] = if self.chroma_format == 2 { u32::from(CHROMA_422_MODES[mode as usize]) } else { mode };
        }
    }

    /// pcm_sample (7.3.8.7): raw samples at the byte the arithmetic decoder stopped at, which restarts after them.
    /// The samples go to the picture's PCM list, scaled to the bit depth.
    fn decode_pcm_samples(&mut self, x0: u32, y0: u32, log2_cb_size: u32) -> DecodeResult<()> {
        let cb_size: u32 = 1 << log2_cb_size;
        let parameters: &PictureParameters = self.parameters;
        let plane_count: u32 = if self.chroma_format != 0 { 3 } else { 1 };
        let mut position: usize = self.decoder.stop_position();
        let end: usize = self.decoder.end();
        let mut current_byte: u32 = 0;
        let mut bits_left: u32 = 0;
        let streams: &mut JobStreams = self.streams;
        streams.pcm_index.push(streams.pcm_data.len() as u32);
        streams.pcm_data.push(x0 | (y0 << 16));
        streams.pcm_data.push(log2_cb_size);
        debug_assert_eq!(PCM_HEADER_WORDS, 2);
        let mut packed: u32 = 0;
        let mut packed_count: u32 = 0;
        for plane in 0..plane_count {
            let shift_x: u32 = if plane == 0 { 0 } else { self.horizontal_shift };
            let shift_y: u32 = if plane == 0 { 0 } else { self.vertical_shift };
            let sample_count: u32 = (cb_size >> shift_x) * (cb_size >> shift_y);
            let pcm_bit_depth: u32 = if plane == 0 { parameters.pcm_bit_depth } else { parameters.pcm_bit_depth_chroma };
            let bit_depth: u32 = if plane == 0 { self.bit_depth_luma } else { self.bit_depth_chroma };
            let scale: u32 = bit_depth.saturating_sub(pcm_bit_depth);
            for _ in 0..sample_count {
                let mut value: u32 = 0;
                for _ in 0..pcm_bit_depth {
                    if bits_left == 0 {
                        current_byte = if position < end { u32::from(self.data[position]) } else { 0 };
                        position += 1;
                        bits_left = 8;
                    }
                    bits_left -= 1;
                    value = (value << 1) | ((current_byte >> bits_left) & 1);
                }
                packed |= ((value << scale) & 0xFFFF) << (packed_count * 16);
                packed_count += 1;
                if packed_count == 2 {
                    streams.pcm_data.push(packed);
                    packed = 0;
                    packed_count = 0;
                }
            }
        }
        if packed_count > 0 {
            streams.pcm_data.push(packed);
        }
        if !self.decoder.start(self.data, position, end) {
            return fail(ERROR_SLICE_DATA, 17);
        }
        Ok(())
    }

    /// Marks a transform unit's edges and luma cbf for deblocking.
    pub(crate) fn emit_edge(&mut self, x0: u32, y0: u32, log2_size: u32, cbf_luma: bool) {
        let mask: u32 = self.ctb_size - 1;
        self.streams.edges.push(
            (((x0 & mask) >> 2) << EDGE_X_SHIFT)
                | (((y0 & mask) >> 2) << EDGE_Y_SHIFT)
                | ((log2_size - 2) << EDGE_LOG2_SIZE_SHIFT)
                | (u32::from(cbf_luma) << EDGE_CBF_SHIFT),
        );
    }

    fn emit_intra_job(&mut self, plane: u32, x0: u32, y0: u32, log2_size: u32, mode: u32) {
        let (origin_x, origin_y) = self.ctb_plane_origin(plane);
        let plane_x: u32 = (x0 >> self.plane_horizontal_shift(plane)) - origin_x;
        let plane_y: u32 = (y0 >> self.plane_vertical_shift(plane)) - origin_y;
        self.intra_jobs[plane as usize].push(
            ((plane_x >> 2) << JOB_X_SHIFT) | ((plane_y >> 2) << JOB_Y_SHIFT) | ((log2_size - 2) << JOB_SIZE_SHIFT) | (mode << JOB_MODE_SHIFT),
        );
    }

    /// Adds a transform block to its size's transform list, at plane coordinates.
    pub(crate) fn emit_transform(&mut self, plane: u32, plane_x0: u32, plane_y0: u32, log2_size: u32, flags: u32) {
        let (origin_x, origin_y) = self.ctb_plane_origin(plane);
        let plane_x: u32 = plane_x0 - origin_x;
        let plane_y: u32 = plane_y0 - origin_y;
        self.transforms[(log2_size - 2) as usize]
            .push(((plane_x >> 2) << TRANSFORM_X_SHIFT) | ((plane_y >> 2) << TRANSFORM_Y_SHIFT) | (plane << TRANSFORM_PLANE_SHIFT) | flags);
    }

    pub(crate) fn push_coefficient(&mut self, word: u32) {
        self.streams.coefficients.push(word);
    }

    fn decode_cross_component_scale(&mut self, plane: u32) {
        let context_index: usize = (plane - 1) as usize;
        let mut log2_scale_plus1: u32 = 0;
        while log2_scale_plus1 < 4 && self.bin(CONTEXT_LOG2_RES_SCALE + 4 * context_index + log2_scale_plus1 as usize) == 1 {
            log2_scale_plus1 += 1;
        }
        if log2_scale_plus1 == 0 {
            self.tu_cross_scale = 0;
            return;
        }
        let sign: i32 = self.bin(CONTEXT_RES_SCALE_SIGN + context_index) as i32;
        self.tu_cross_scale = (1 << (log2_scale_plus1 - 1)) * (1 - 2 * sign);
    }

    /// transform_unit (7.3.8.10).
    #[allow(clippy::too_many_arguments)]
    fn decode_transform_unit(
        &mut self,
        x0: u32,
        y0: u32,
        x_base: u32,
        y_base: u32,
        cb_x_base: u32,
        cb_y_base: u32,
        log2_size: u32,
        block_index: u32,
        cbf_luma: bool,
        cbf_cb: [u32; 2],
        cbf_cr: [u32; 2],
    ) -> DecodeResult<()> {
        let cbf_chroma: bool = cbf_cb[0] == 1 || cbf_cr[0] == 1 || (self.chroma_format == 2 && (cbf_cb[1] == 1 || cbf_cr[1] == 1));
        let mut scan_index: u32 = SCAN_DIAGONAL;
        let mut scan_index_chroma: u32 = SCAN_DIAGONAL;
        if cbf_luma || cbf_chroma {
            if self.cu_qp_delta_enabled && !self.is_cu_qp_delta_coded {
                let mut prefix: u32 = 0;
                let mut increment: usize = 0;
                while prefix < 5 && self.bin(CONTEXT_CU_QP_DELTA + increment) == 1 {
                    prefix += 1;
                    increment = 1;
                }
                let mut magnitude: u32 = prefix;
                if prefix >= 5 {
                    let mut exponent: u32 = 0;
                    let mut suffix: u32 = 0;
                    while exponent < 7 && self.bypass() == 1 {
                        suffix += 1 << exponent;
                        exponent += 1;
                    }
                    if exponent == 7 {
                        return fail(ERROR_SLICE_DATA, 2);
                    }
                    suffix += self.bypass_bits(exponent);
                    magnitude += suffix;
                }
                self.cu_qp_delta = magnitude as i32;
                if magnitude != 0 && self.bypass() == 1 {
                    self.cu_qp_delta = -self.cu_qp_delta;
                }
                self.is_cu_qp_delta_coded = true;
                if self.cu_qp_delta < -(26 + self.qp_bd_offset / 2) || self.cu_qp_delta > 25 + self.qp_bd_offset / 2 {
                    return fail(ERROR_SLICE_DATA, 3);
                }
                self.set_qp_y(cb_x_base, cb_y_base);
            }
            if self.slice_cu_chroma_qp_offset && cbf_chroma && !self.cu_bypass && !self.is_cu_chroma_qp_offset_coded {
                if self.bin(CONTEXT_CU_CHROMA_QP_OFFSET_FLAG) == 1 {
                    let mut index: u32 = 0;
                    let list_length: u32 = self.parameters.chroma_qp_offset_list_length;
                    if list_length > 1 {
                        // Truncated rice with cMax chroma_qp_offset_list_len_minus1
                        let maximum: u32 = list_length - 1;
                        while index < maximum && self.bin(CONTEXT_CU_CHROMA_QP_OFFSET_IDX) == 1 {
                            index += 1;
                        }
                    }
                    let entry: usize = (index as usize).min(self.parameters.cb_qp_offset_list.len() - 1);
                    self.cu_qp_offset_cb = self.parameters.cb_qp_offset_list[entry];
                    self.cu_qp_offset_cr = self.parameters.cr_qp_offset_list[entry];
                } else {
                    self.cu_qp_offset_cb = 0;
                    self.cu_qp_offset_cr = 0;
                }
                self.is_cu_chroma_qp_offset_coded = true;
            }
            if self.cu_pred_mode == MODE_INTRA && log2_size < 4 {
                scan_index = scan_index_of(self.tu_intra_mode);
                scan_index_chroma = scan_index_of(self.tu_intra_mode_chroma);
            }
        }
        self.decode_transform_blocks(x0, y0, x_base, y_base, log2_size, block_index, cbf_luma, cbf_cb, cbf_cr, cbf_luma || cbf_chroma, scan_index, scan_index_chroma)
    }

    /// The transform blocks of a transform unit in syntax order: luma, then each chroma plane's one or two blocks.
    /// Chroma blocks sit at the unit itself, or at its parent for the fourth 4x4 luma block of 4:2:0 and 4:2:2.
    /// Each block gets its intra prediction job, and its residual when coded.
    #[allow(clippy::too_many_arguments)]
    fn decode_transform_blocks(
        &mut self,
        x0: u32,
        y0: u32,
        x_base: u32,
        y_base: u32,
        log2_size: u32,
        block_index: u32,
        cbf_luma: bool,
        cbf_cb: [u32; 2],
        cbf_cr: [u32; 2],
        coded: bool,
        scan_index: u32,
        scan_index_chroma: u32,
    ) -> DecodeResult<()> {
        let mut chroma_placement: u32 = 0;
        if self.chroma_format != 0 {
            if log2_size > 2 || self.chroma_format == 3 {
                chroma_placement = 1;
            } else if block_index == 3 {
                chroma_placement = 2;
            }
        }
        let own_chroma: bool = chroma_placement == 1;
        let chroma_x: u32 = if own_chroma { x0 } else { x_base };
        let chroma_y: u32 = if own_chroma { y0 } else { y_base };
        let chroma_log2: u32 = if own_chroma { log2_size - self.horizontal_shift } else { log2_size };
        let block_count: u32 = if self.chroma_format == 2 { 2 } else { 1 };
        let cross_allowed: bool = coded
            && own_chroma
            && self.cross_component_prediction
            && cbf_luma
            && (self.cu_pred_mode != MODE_INTRA || self.tu_chroma_mode == CHROMA_MODE_DERIVED);
        let step_count: u32 = 1 + if chroma_placement != 0 { 2 * block_count } else { 0 };
        self.tu_cross_scale = 0;
        for step in 0..step_count {
            let mut plane: u32 = 0;
            let mut x: u32 = x0;
            let mut y: u32 = y0;
            let mut size: u32 = log2_size;
            let mut cbf: bool = cbf_luma;
            if step > 0 {
                plane = 1 + (step - 1) / block_count;
                let block: u32 = (step - 1) % block_count;
                x = chroma_x;
                y = chroma_y + (block << chroma_log2);
                size = chroma_log2;
                cbf = (if plane == 1 { cbf_cb } else { cbf_cr })[block as usize] == 1;
                if block == 0 {
                    self.tu_cross_scale = 0;
                    if cross_allowed {
                        self.decode_cross_component_scale(plane);
                    }
                }
            }
            if self.cu_pred_mode == MODE_INTRA {
                let mode: u32 = if plane == 0 { self.tu_intra_mode } else { self.tu_intra_mode_chroma };
                self.emit_intra_job(plane, x, y, size, mode);
            }
            if !coded {
                continue;
            }
            if cbf {
                self.decode_residual_coding(x, y, size, if plane == 0 { scan_index } else { scan_index_chroma }, plane)?;
            } else if plane > 0 && self.tu_cross_scale != 0 {
                // A chroma block with no coded residual still receives the cross-component prediction
                let flags: u32 = TRANSFORM_BYPASS | self.cross_component_flags(plane);
                self.emit_transform(plane, x >> self.plane_horizontal_shift(plane), y >> self.plane_vertical_shift(plane), size, flags);
            }
        }
        self.tu_cross_scale = 0;
        Ok(())
    }

    /// transform_tree (7.3.8.8), iterating over an explicit stack.
    fn decode_transform_tree(&mut self, x0: u32, y0: u32, log2_cb_size: u32) -> DecodeResult<()> {
        let mut node_x: [u32; 6] = [0; 6];
        let mut node_y: [u32; 6] = [0; 6];
        let mut node_x_base: [u32; 6] = [0; 6];
        let mut node_y_base: [u32; 6] = [0; 6];
        let mut node_block: [u32; 6] = [0; 6];
        // Bits 0 and 1 hold cbf_cb, bits 2 and 3 cbf_cr: the parent's on entry, the node's own once parsed
        let mut node_cbf: [u32; 6] = [0; 6];
        let mut node_child: [u32; 6] = [0; 6];
        let max_tb_log2: u32 = self.parameters.max_tb_log2;
        let mut depth: i32 = 0;
        node_x[0] = x0;
        node_y[0] = y0;
        node_x_base[0] = x0;
        node_y_base[0] = y0;
        while depth >= 0 {
            let level: usize = depth as usize;
            let x: u32 = node_x[level];
            let y: u32 = node_y[level];
            let log2_size: u32 = log2_cb_size - level as u32;
            let child: u32 = node_child[level];
            if child == 0 {
                if self.cu_intra_split {
                    if level == 1 {
                        let block: usize = node_block[level] as usize;
                        self.tu_intra_mode = self.pu_intra_modes[block];
                        let chroma_index: usize = if self.chroma_format == 3 { block } else { 0 };
                        self.tu_intra_mode_chroma = self.pu_intra_modes_chroma[chroma_index];
                        self.tu_chroma_mode = self.pu_chroma_modes[chroma_index];
                    }
                } else {
                    self.tu_intra_mode = self.pu_intra_modes[0];
                    self.tu_intra_mode_chroma = self.pu_intra_modes_chroma[0];
                    self.tu_chroma_mode = self.pu_chroma_modes[0];
                }
                let split: bool = if log2_size <= max_tb_log2
                    && log2_size > self.min_tb_log2
                    && (level as u32) < self.cu_max_transform_depth
                    && !(self.cu_intra_split && level == 0)
                {
                    self.bin(CONTEXT_SPLIT_TRANSFORM + 5 - log2_size as usize) == 1
                } else {
                    let inter_split: bool = self.parameters.max_transform_depth_inter == 0
                        && self.cu_pred_mode == MODE_INTER
                        && self.cu_part_mode != PART_2NX2N
                        && level == 0;
                    log2_size > max_tb_log2 || (self.cu_intra_split && level == 0) || inter_split
                };
                let mut cbf: u32 = node_cbf[level];
                if self.chroma_format != 0 && (log2_size > 2 || self.chroma_format == 3) {
                    let two_chroma_blocks: bool = self.chroma_format == 2 && (!split || log2_size == 3);
                    let context: usize = CONTEXT_CBF_CHROMA + level;
                    if level == 0 || cbf & 1 != 0 {
                        cbf = (cbf & !3) | self.bin(context);
                        if two_chroma_blocks {
                            cbf |= self.bin(context) << 1;
                        }
                    }
                    if level == 0 || cbf & 4 != 0 {
                        cbf = (cbf & !12) | (self.bin(context) << 2);
                        if two_chroma_blocks {
                            cbf |= self.bin(context) << 3;
                        }
                    }
                }
                node_cbf[level] = cbf;
                if split {
                    node_child[level] = 1;
                    let next: usize = level + 1;
                    node_x[next] = x;
                    node_y[next] = y;
                    node_x_base[next] = x;
                    node_y_base[next] = y;
                    node_block[next] = 0;
                    node_cbf[next] = cbf;
                    node_child[next] = 0;
                    depth += 1;
                    continue;
                }
                let cbf_cb: [u32; 2] = [cbf & 1, (cbf >> 1) & 1];
                let cbf_cr: [u32; 2] = [(cbf >> 2) & 1, (cbf >> 3) & 1];
                let mut cbf_luma: bool = true;
                if self.cu_pred_mode == MODE_INTRA
                    || level != 0
                    || cbf_cb[0] == 1
                    || cbf_cr[0] == 1
                    || (self.chroma_format == 2 && (cbf_cb[1] == 1 || cbf_cr[1] == 1))
                {
                    cbf_luma = self.bin(CONTEXT_CBF_LUMA + usize::from(level == 0)) == 1;
                }
                self.decode_transform_unit(x, y, node_x_base[level], node_y_base[level], x0, y0, log2_size, node_block[level], cbf_luma, cbf_cb, cbf_cr)?;
                self.emit_edge(x, y, log2_size, cbf_luma);
                depth -= 1;
                continue;
            }
            if child < 4 {
                node_child[level] = child + 1;
                let half: u32 = 1 << (log2_size - 1);
                let next: usize = level + 1;
                node_x[next] = x + if child & 1 == 1 { half } else { 0 };
                node_y[next] = y + if child >= 2 { half } else { 0 };
                node_x_base[next] = x;
                node_y_base[next] = y;
                node_block[next] = child;
                node_cbf[next] = node_cbf[level];
                node_child[next] = 0;
                depth += 1;
                continue;
            }
            depth -= 1;
        }
        Ok(())
    }

    /// Cross-component prediction of a chroma block from the co-located luma residual, as a signed scale in the transform word.
    pub(crate) fn cross_component_flags(&self, plane: u32) -> u32 {
        if plane == 0 || self.tu_cross_scale == 0 {
            return 0;
        }
        ((self.tu_cross_scale as u32) & 31) << crate::layout::TRANSFORM_CROSS_SHIFT
    }

}
