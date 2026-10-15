//! id: hevc
//! name: HEVC
//! decoder: video
//! accepts: codec in [hevc], stream.width <= 8192, stream.height <= 4320, stream.width * stream.height <= 8912896
//! output: I420, I420P10, I420P12, I422, I422P10, I422P12, I444, I444P10, I444P12
//! monochrome: yes
//! parser: 2
//! references: 16
//! reorder: 8
//! packet: 64 MiB
//! state: 285696
//! buffer: pictureState, 77056 + stream.width * stream.height * (1 + 2 / (output.chromaWidthDivisor * output.chromaHeightDivisor)) * output.bytesPerSample + 12 * stream.height
//! buffer: blockData, 16 * (stream.width * stream.height / 16 + (stream.width + stream.height) / 4 + 1 + 64)
//! buffer: residualData, 4 * stream.width * stream.height * (1 + 2 / (output.chromaWidthDivisor * output.chromaHeightDivisor))
//! error: 1, configuration
//! error: 2, nalLength, resync
//! error: 3, parameterSetMissing, resync
//! error: 4, parameterSetInvalid, resync
//! error: 5, unsupportedFormat
//! error: 6, pictureSize
//! error: 7, bitDepth
//! error: 8, chromaFormat
//! error: 9, sliceHeader, resync
//! error: 10, sliceSegmentLimit
//! error: 11, sliceData, resync
//! error: 12, referencePictures, resync
//! error: 13, multiplePictures
//! error: 14, sliceDecodeIncomplete, resync
//! error: 15, recordInvalid
//! dispatch: beginPicture, 1
//! dispatch: clearPicture, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: expandRecords, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: writePcmSamples, 1
//! dispatch: inverseTransform, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: predictInter, ceil(stream.width * output.bytesPerSample / 32), ceil(stream.height / 8), 3
//! repeat: ceil((ceil(stream.width / 64) + 2 * ceil(stream.height / 16) - 2) / 2), 2
//! dispatch: predictIntra, ceil(stream.height / 16), 1, 3
//! dispatch: predictIntra, ceil(stream.height / 16) + 1, 1, 3
//! dispatch: deblockVertical, ceil(stream.width / 64), ceil(stream.height / 32), 3
//! dispatch: deblockHorizontal, ceil(stream.width / 32), ceil(stream.height / 64), 3
//! dispatch: copySaoSource, ceil(stream.width * output.bytesPerSample / 32), ceil(stream.height / 8), 3
//! dispatch: applySao, ceil(stream.width * output.bytesPerSample / 32), ceil(stream.height / 8), 3

// The HEVC decoder: Main, Main 10, Main 12, and the 4:2:2 and 4:4:4 range extension profiles, base layer only, in compute shaders.
// Its packets are the GPU records its CPU parser (parser/) makes of each access unit; the parser parses the slices, so these passes
// set up the picture from its record, then reconstruct and filter it, with one body for every planar output format the prelude describes.
// The intra prediction wavefront dispatches once per diagonal wave of 64-sample strips over the rows of 16x16 CTBs:
// (ceil(stream.width / 64) + 2 * ceil(stream.height / 16) - 2) waves, which the repeat dispatches in even and odd pairs; a wave past the picture's last does nothing.
// Both dispatches of a pair run predictIntra, which tells the odd one by its extra workgroup column, so the wavefront compiles once.

// The GPU record the parser writes for each picture: its magic and version, its limits, and the word offsets of its fields.
// parser/build.rs reads these RECORD_ declarations and the ERROR_ codes below, so the parser and the passes share one layout
const RECORD_VERSION: u32 = 1u;
const RECORD_MAGIC: u32 = 1263424840u;
const RECORD_MISSING_PICTURE: u32 = 4294967295u;
const RECORD_MAXIMUM_TILE_COLUMNS: u32 = 20u;
const RECORD_MAXIMUM_TILE_ROWS: u32 = 22u;
const RECORD_MAXIMUM_REFERENCE_INDICES: u32 = 16u;
const RECORD_MAXIMUM_DPB_PICTURES: u32 = 16u;
const RECORD_MAXIMUM_WIDTH: u32 = 8192u;
const RECORD_MAXIMUM_HEIGHT: u32 = 4320u;
const RECORD_MAXIMUM_LUMA_PICTURE_SIZE: u32 = 8912896u;
const RECORD_MAXIMUM_SLICES: u32 = 600u;
const RECORD_MAXIMUM_SLICE_SEGMENTS: u32 = 1024u;
const RECORD_HEADER_MAGIC: u32 = 0u;
const RECORD_HEADER_VERSION: u32 = 1u;
const RECORD_HEADER_PICTURE_ID: u32 = 2u;
const RECORD_HEADER_POC: u32 = 3u;
const RECORD_HEADER_WIDTH: u32 = 4u;
const RECORD_HEADER_HEIGHT: u32 = 5u;
const RECORD_HEADER_CHROMA_FORMAT: u32 = 6u;
const RECORD_HEADER_BIT_DEPTH: u32 = 7u;
const RECORD_HEADER_BIT_DEPTH_CHROMA: u32 = 8u;
const RECORD_HEADER_CTB_LOG2: u32 = 9u;
const RECORD_HEADER_MIN_TB_LOG2: u32 = 10u;
const RECORD_HEADER_CONFORMANCE_LEFT: u32 = 11u;
const RECORD_HEADER_CONFORMANCE_RIGHT: u32 = 12u;
const RECORD_HEADER_CONFORMANCE_TOP: u32 = 13u;
const RECORD_HEADER_CONFORMANCE_BOTTOM: u32 = 14u;
const RECORD_HEADER_STRONG_INTRA_SMOOTHING: u32 = 15u;
const RECORD_HEADER_INTRA_SMOOTHING_DISABLED: u32 = 16u;
const RECORD_HEADER_CONSTRAINED_INTRA_PRED: u32 = 17u;
const RECORD_HEADER_CB_QP_OFFSET: u32 = 18u;
const RECORD_HEADER_CR_QP_OFFSET: u32 = 19u;
const RECORD_HEADER_LOOP_FILTER_ACROSS_TILES: u32 = 20u;
const RECORD_HEADER_TILE_COLUMNS: u32 = 21u;
const RECORD_HEADER_TILE_ROWS: u32 = 22u;
const RECORD_HEADER_TABLES_GENERATION: u32 = 23u;
const RECORD_HEADER_SAO_ANY: u32 = 24u;
const RECORD_HEADER_DEBLOCKING_ANY: u32 = 25u;
const RECORD_HEADER_SLICE_COUNT: u32 = 26u;
const RECORD_HEADER_SLICES: u32 = 27u;
const RECORD_HEADER_CTBS: u32 = 28u;
const RECORD_HEADER_PCM_COUNT: u32 = 29u;
const RECORD_HEADER_PCM: u32 = 30u;
const RECORD_HEADER_DPB_COUNT: u32 = 31u;
const RECORD_HEADER_COLUMN_BOUNDARIES: u32 = 32u;
const RECORD_HEADER_ROW_BOUNDARIES: u32 = 53u;
const RECORD_HEADER_DPB: u32 = 76u;
const RECORD_HEADER_WORDS: u32 = 96u;
const RECORD_SLICE_ADDRESS_RS: u32 = 0u;
const RECORD_SLICE_DEBLOCKING_DISABLED: u32 = 1u;
const RECORD_SLICE_BETA_OFFSET: u32 = 2u;
const RECORD_SLICE_TC_OFFSET: u32 = 3u;
const RECORD_SLICE_LOOP_FILTER_ACROSS_SLICES: u32 = 4u;
const RECORD_SLICE_WEIGHTED: u32 = 5u;
const RECORD_SLICE_LUMA_LOG2_WEIGHT_DENOM: u32 = 6u;
const RECORD_SLICE_CHROMA_LOG2_WEIGHT_DENOM: u32 = 7u;
const RECORD_SLICE_REFERENCE_COUNT_0: u32 = 8u;
const RECORD_SLICE_REFERENCE_COUNT_1: u32 = 9u;
const RECORD_SLICE_REFERENCES: u32 = 10u;
const RECORD_SLICE_WEIGHTS: u32 = 106u;
const RECORD_SLICE_WORDS: u32 = 298u;
const RECORD_REFERENCE_ENTRY_WORDS: u32 = 3u;
const RECORD_WEIGHT_ENTRY_WORDS: u32 = 6u;
const RECORD_CTB_SLICE: u32 = 0u;
const RECORD_CTB_SAO_LUMA_TYPE: u32 = 1u;
const RECORD_CTB_SAO_LUMA_OFFSETS: u32 = 2u;
const RECORD_CTB_SAO_CB_TYPE: u32 = 3u;
const RECORD_CTB_SAO_CB_OFFSETS: u32 = 4u;
const RECORD_CTB_SAO_CR_TYPE: u32 = 5u;
const RECORD_CTB_SAO_CR_OFFSETS: u32 = 6u;
const RECORD_CTB_PREDICTION_OFFSET: u32 = 7u;
const RECORD_CTB_PREDICTION_COUNT: u32 = 8u;
const RECORD_CTB_EDGE_OFFSET: u32 = 9u;
const RECORD_CTB_EDGE_COUNT: u32 = 10u;
const RECORD_CTB_COEFFICIENT_OFFSET: u32 = 11u;
const RECORD_CTB_COEFFICIENT_COUNT: u32 = 12u;
const RECORD_CTB_JOB_OFFSET: u32 = 13u;
const RECORD_CTB_INTRA_COUNT_LUMA: u32 = 14u;
const RECORD_CTB_INTRA_COUNT_CB: u32 = 15u;
const RECORD_CTB_INTRA_COUNT_CR: u32 = 16u;
const RECORD_CTB_TRANSFORM_COUNT_4: u32 = 17u;
const RECORD_CTB_TRANSFORM_COUNT_8: u32 = 18u;
const RECORD_CTB_TRANSFORM_COUNT_16: u32 = 19u;
const RECORD_CTB_TRANSFORM_COUNT_32: u32 = 20u;
const RECORD_CTB_WORDS: u32 = 21u;
const RECORD_PREDICTION_WORDS: u32 = 4u;
const RECORD_PREDICTION_GEOMETRY: u32 = 0u;
const RECORD_PREDICTION_FIELDS: u32 = 1u;
const RECORD_PREDICTION_VECTOR_0: u32 = 2u;
const RECORD_PREDICTION_VECTOR_1: u32 = 3u;
const RECORD_PREDICTION_X_SHIFT: u32 = 0u;
const RECORD_PREDICTION_Y_SHIFT: u32 = 4u;
const RECORD_PREDICTION_WIDTH_SHIFT: u32 = 8u;
const RECORD_PREDICTION_HEIGHT_SHIFT: u32 = 12u;
const RECORD_BLOCK_REF_IDX_0_SHIFT: u32 = 0u;
const RECORD_BLOCK_REF_IDX_1_SHIFT: u32 = 4u;
const RECORD_BLOCK_PRED_FLAGS_SHIFT: u32 = 8u;
const RECORD_BLOCK_BYPASS_SHIFT: u32 = 19u;
const RECORD_BLOCK_CBF_SHIFT: u32 = 20u;
const RECORD_BLOCK_EDGE_LEFT_SHIFT: u32 = 21u;
const RECORD_BLOCK_EDGE_TOP_SHIFT: u32 = 22u;
const RECORD_BLOCK_QP_SHIFT: u32 = 24u;
const RECORD_EDGE_X_SHIFT: u32 = 0u;
const RECORD_EDGE_Y_SHIFT: u32 = 4u;
const RECORD_EDGE_LOG2_SIZE_SHIFT: u32 = 8u;
const RECORD_EDGE_CBF_SHIFT: u32 = 11u;
const RECORD_COEFFICIENT_PLANE_SHIFT: u32 = 0u;
const RECORD_COEFFICIENT_X_SHIFT: u32 = 2u;
const RECORD_COEFFICIENT_Y_SHIFT: u32 = 8u;
const RECORD_COEFFICIENT_VALUE_SHIFT: u32 = 16u;
const RECORD_JOB_X_SHIFT: u32 = 0u;
const RECORD_JOB_Y_SHIFT: u32 = 4u;
const RECORD_JOB_SIZE_SHIFT: u32 = 8u;
const RECORD_JOB_MODE_SHIFT: u32 = 10u;
const RECORD_TRANSFORM_X_SHIFT: u32 = 0u;
const RECORD_TRANSFORM_Y_SHIFT: u32 = 4u;
const RECORD_TRANSFORM_PLANE_SHIFT: u32 = 8u;
const RECORD_TRANSFORM_DST_SHIFT: u32 = 10u;
const RECORD_TRANSFORM_SKIP_SHIFT: u32 = 11u;
const RECORD_TRANSFORM_BYPASS_SHIFT: u32 = 12u;
const RECORD_TRANSFORM_RDPCM_SHIFT: u32 = 13u;
const RECORD_TRANSFORM_RDPCM_VERTICAL_SHIFT: u32 = 14u;
const RECORD_TRANSFORM_CROSS_SHIFT: u32 = 15u;
const RECORD_SAO_NOT_APPLIED: u32 = 0u;
const RECORD_SAO_BAND: u32 = 1u;
const RECORD_SAO_EDGE: u32 = 2u;
const RECORD_SAO_POSITION_SHIFT: u32 = 2u;
const RECORD_PCM_HEADER_WORDS: u32 = 2u;

// Error codes, the high byte of a status error word, which the //! error lines name; the low 24 bits carry the failing value
const ERROR_CODE_SHIFT: u32 = 24u;
const ERROR_CONFIGURATION: u32 = 1u;
const ERROR_NAL_LENGTH: u32 = 2u;
const ERROR_PARAMETER_SET_MISSING: u32 = 3u;
const ERROR_PARAMETER_SET_INVALID: u32 = 4u;
const ERROR_UNSUPPORTED_FORMAT: u32 = 5u;
const ERROR_PICTURE_SIZE: u32 = 6u;
const ERROR_BIT_DEPTH: u32 = 7u;
const ERROR_CHROMA_FORMAT: u32 = 8u;
const ERROR_SLICE_HEADER: u32 = 9u;
const ERROR_SLICE_SEGMENT_LIMIT: u32 = 10u;
const ERROR_SLICE_DATA: u32 = 11u;
const ERROR_REFERENCE_PICTURES: u32 = 12u;
const ERROR_MULTIPLE_PICTURES: u32 = 13u;
const ERROR_SLICE_DECODE_INCOMPLETE: u32 = 14u;
const ERROR_RECORD_INVALID: u32 = 15u;

// The state buffer: the tables generation, the DPB as picture ID and slot pairs, and the CTB address tables of the active parameter sets
const S_TABLES_GENERATION: u32 = 0u;
const S_DPB: u32 = 16u;
const DPB_ENTRY_WORDS: u32 = 2u;
const DPB_ENTRY_COUNT: u32 = 17u;
const S_RS_TO_TS: u32 = 64u;
const S_TILE_ID: u32 = 35712u;
const S_COLUMN_BOUNDARIES: u32 = 71360u;
const S_ROW_BOUNDARIES: u32 = 71381u;

// The picture buffer: the wave counters, the picture parameter block, each slice's reference slots, and the SAO source copy
const F_WAVE_EVEN: u32 = 0u;
const F_WAVE_ODD: u32 = 1u;
const F_VALID: u32 = 2u;
const F_PARAMETERS: u32 = 16u;
const F_SLICE_SLOTS: u32 = 64u;
const SLICE_SLOT_WORDS: u32 = 32u;
const F_SAO_SOURCE: u32 = 19264u;

// Fields of the picture parameter block, which beginPicture fills from the record header
const P_WIDTH: u32 = 0u;
const P_HEIGHT: u32 = 1u;
const P_CHROMA_FORMAT: u32 = 2u;
const P_HORIZONTAL_SHIFT: u32 = 3u;
const P_VERTICAL_SHIFT: u32 = 4u;
const P_BIT_DEPTH: u32 = 5u;
const P_BIT_DEPTH_CHROMA: u32 = 6u;
const P_CTB_LOG2: u32 = 7u;
const P_MIN_TB_LOG2: u32 = 8u;
const P_CTB_WIDTH: u32 = 9u;
const P_CTB_HEIGHT: u32 = 10u;
const P_CTB_COUNT: u32 = 11u;
const P_BLOCK_STRIDE: u32 = 12u;
const P_STRONG_INTRA_SMOOTHING: u32 = 13u;
const P_INTRA_SMOOTHING_DISABLED: u32 = 14u;
const P_CONSTRAINED_INTRA_PRED: u32 = 15u;
const P_CB_QP_OFFSET: u32 = 16u;
const P_CR_QP_OFFSET: u32 = 17u;
const P_LOOP_FILTER_ACROSS_TILES: u32 = 18u;
const P_SAO_ANY: u32 = 19u;
const P_DEBLOCKING_ANY: u32 = 20u;
const P_CHROMA_PLANE_WIDTH: u32 = 21u;
const P_CHROMA_PLANE_HEIGHT: u32 = 22u;
const P_RESIDUAL_CB_BASE: u32 = 23u;
const P_RESIDUAL_CR_BASE: u32 = 24u;
const P_SAO_ROW_WORDS_LUMA: u32 = 25u;
const P_SAO_ROW_WORDS_CHROMA: u32 = 26u;
const P_SAO_CB_BASE: u32 = 27u;
const P_SAO_CR_BASE: u32 = 28u;
const P_SLICES: u32 = 29u;
const P_CTBS: u32 = 30u;
const P_PCM_COUNT: u32 = 31u;
const P_PCM: u32 = 32u;

// Words of one 4x4 block record: the L0 and L1 motion vectors, the prediction fields with QpY, and the transform edge fields
const BLOCK_WORDS: u32 = 4u;

// The largest luma picture the decoder takes, and the width of one intra wavefront strip in luma samples
const MAXIMUM_LUMA_PICTURE_SIZE: u32 = 8912896u;
const INTRA_STRIP_WIDTH: u32 = 64u;
// The luma rows of the CTB row each workgroup column of the wavefront's dispatches covers, the smallest CTB's
const INTRA_ROW_HEIGHT: u32 = 16u;

// The 32x32 HEVC transform matrix (8.6.4.2), row-major: row k is the basis function of frequency k
const TRANSFORM_MATRIX = array<i32, 1024>(
    64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64,
    90, 90, 88, 85, 82, 78, 73, 67, 61, 54, 46, 38, 31, 22, 13, 4, -4, -13, -22, -31, -38, -46, -54, -61, -67, -73, -78, -82, -85, -88, -90, -90,
    90, 87, 80, 70, 57, 43, 25, 9, -9, -25, -43, -57, -70, -80, -87, -90, -90, -87, -80, -70, -57, -43, -25, -9, 9, 25, 43, 57, 70, 80, 87, 90,
    90, 82, 67, 46, 22, -4, -31, -54, -73, -85, -90, -88, -78, -61, -38, -13, 13, 38, 61, 78, 88, 90, 85, 73, 54, 31, 4, -22, -46, -67, -82, -90,
    89, 75, 50, 18, -18, -50, -75, -89, -89, -75, -50, -18, 18, 50, 75, 89, 89, 75, 50, 18, -18, -50, -75, -89, -89, -75, -50, -18, 18, 50, 75, 89,
    88, 67, 31, -13, -54, -82, -90, -78, -46, -4, 38, 73, 90, 85, 61, 22, -22, -61, -85, -90, -73, -38, 4, 46, 78, 90, 82, 54, 13, -31, -67, -88,
    87, 57, 9, -43, -80, -90, -70, -25, 25, 70, 90, 80, 43, -9, -57, -87, -87, -57, -9, 43, 80, 90, 70, 25, -25, -70, -90, -80, -43, 9, 57, 87,
    85, 46, -13, -67, -90, -73, -22, 38, 82, 88, 54, -4, -61, -90, -78, -31, 31, 78, 90, 61, 4, -54, -88, -82, -38, 22, 73, 90, 67, 13, -46, -85,
    83, 36, -36, -83, -83, -36, 36, 83, 83, 36, -36, -83, -83, -36, 36, 83, 83, 36, -36, -83, -83, -36, 36, 83, 83, 36, -36, -83, -83, -36, 36, 83,
    82, 22, -54, -90, -61, 13, 78, 85, 31, -46, -90, -67, 4, 73, 88, 38, -38, -88, -73, -4, 67, 90, 46, -31, -85, -78, -13, 61, 90, 54, -22, -82,
    80, 9, -70, -87, -25, 57, 90, 43, -43, -90, -57, 25, 87, 70, -9, -80, -80, -9, 70, 87, 25, -57, -90, -43, 43, 90, 57, -25, -87, -70, 9, 80,
    78, -4, -82, -73, 13, 85, 67, -22, -88, -61, 31, 90, 54, -38, -90, -46, 46, 90, 38, -54, -90, -31, 61, 88, 22, -67, -85, -13, 73, 82, 4, -78,
    75, -18, -89, -50, 50, 89, 18, -75, -75, 18, 89, 50, -50, -89, -18, 75, 75, -18, -89, -50, 50, 89, 18, -75, -75, 18, 89, 50, -50, -89, -18, 75,
    73, -31, -90, -22, 78, 67, -38, -90, -13, 82, 61, -46, -88, -4, 85, 54, -54, -85, 4, 88, 46, -61, -82, 13, 90, 38, -67, -78, 22, 90, 31, -73,
    70, -43, -87, 9, 90, 25, -80, -57, 57, 80, -25, -90, -9, 87, 43, -70, -70, 43, 87, -9, -90, -25, 80, 57, -57, -80, 25, 90, 9, -87, -43, 70,
    67, -54, -78, 38, 85, -22, -90, 4, 90, 13, -88, -31, 82, 46, -73, -61, 61, 73, -46, -82, 31, 88, -13, -90, -4, 90, 22, -85, -38, 78, 54, -67,
    64, -64, -64, 64, 64, -64, -64, 64, 64, -64, -64, 64, 64, -64, -64, 64, 64, -64, -64, 64, 64, -64, -64, 64, 64, -64, -64, 64, 64, -64, -64, 64,
    61, -73, -46, 82, 31, -88, -13, 90, -4, -90, 22, 85, -38, -78, 54, 67, -67, -54, 78, 38, -85, -22, 90, 4, -90, 13, 88, -31, -82, 46, 73, -61,
    57, -80, -25, 90, -9, -87, 43, 70, -70, -43, 87, 9, -90, 25, 80, -57, -57, 80, 25, -90, 9, 87, -43, -70, 70, 43, -87, -9, 90, -25, -80, 57,
    54, -85, -4, 88, -46, -61, 82, 13, -90, 38, 67, -78, -22, 90, -31, -73, 73, 31, -90, 22, 78, -67, -38, 90, -13, -82, 61, 46, -88, 4, 85, -54,
    50, -89, 18, 75, -75, -18, 89, -50, -50, 89, -18, -75, 75, 18, -89, 50, 50, -89, 18, 75, -75, -18, 89, -50, -50, 89, -18, -75, 75, 18, -89, 50,
    46, -90, 38, 54, -90, 31, 61, -88, 22, 67, -85, 13, 73, -82, 4, 78, -78, -4, 82, -73, -13, 85, -67, -22, 88, -61, -31, 90, -54, -38, 90, -46,
    43, -90, 57, 25, -87, 70, 9, -80, 80, -9, -70, 87, -25, -57, 90, -43, -43, 90, -57, -25, 87, -70, -9, 80, -80, 9, 70, -87, 25, 57, -90, 43,
    38, -88, 73, -4, -67, 90, -46, -31, 85, -78, 13, 61, -90, 54, 22, -82, 82, -22, -54, 90, -61, -13, 78, -85, 31, 46, -90, 67, 4, -73, 88, -38,
    36, -83, 83, -36, -36, 83, -83, 36, 36, -83, 83, -36, -36, 83, -83, 36, 36, -83, 83, -36, -36, 83, -83, 36, 36, -83, 83, -36, -36, 83, -83, 36,
    31, -78, 90, -61, 4, 54, -88, 82, -38, -22, 73, -90, 67, -13, -46, 85, -85, 46, 13, -67, 90, -73, 22, 38, -82, 88, -54, -4, 61, -90, 78, -31,
    25, -70, 90, -80, 43, 9, -57, 87, -87, 57, -9, -43, 80, -90, 70, -25, -25, 70, -90, 80, -43, -9, 57, -87, 87, -57, 9, 43, -80, 90, -70, 25,
    22, -61, 85, -90, 73, -38, -4, 46, -78, 90, -82, 54, -13, -31, 67, -88, 88, -67, 31, 13, -54, 82, -90, 78, -46, 4, 38, -73, 90, -85, 61, -22,
    18, -50, 75, -89, 89, -75, 50, -18, -18, 50, -75, 89, -89, 75, -50, 18, 18, -50, 75, -89, 89, -75, 50, -18, -18, 50, -75, 89, -89, 75, -50, 18,
    13, -38, 61, -78, 88, -90, 85, -73, 54, -31, 4, 22, -46, 67, -82, 90, -90, 82, -67, 46, -22, -4, 31, -54, 73, -85, 90, -88, 78, -61, 38, -13,
    9, -25, 43, -57, 70, -80, 87, -90, 90, -87, 80, -70, 57, -43, 25, -9, -9, 25, -43, 57, -70, 80, -87, 90, -90, 87, -80, 70, -57, 43, -25, 9,
    4, -13, 22, -31, 38, -46, 54, -61, 67, -73, 78, -82, 85, -88, 90, -90, 90, -90, 88, -85, 82, -78, 73, -67, 61, -54, 46, -38, 31, -22, 13, -4
);

// WGSL shared by every pass of the HEVC back end: failure reports, the picture parameter block, sample access, block records,
// and the picture's GPU record in the packet: its slice records and CTB table, which the CPU parser wrote.
// The layout constants are declared above; the sample format constants come from the engine's prelude.

// Pool slot sentinel of a reference picture that had to be generated because it was missing
const NO_SLOT: u32 = 0xFFu;

// Fields of the third and fourth words of a 4x4 block record; together they read as one fields word
const BLOCK_BYPASS_BIT: u32 = 1u << RECORD_BLOCK_BYPASS_SHIFT;
const BLOCK_CBF_BIT: u32 = 1u << RECORD_BLOCK_CBF_SHIFT;
const BLOCK_EDGE_LEFT_BIT: u32 = 1u << RECORD_BLOCK_EDGE_LEFT_SHIFT;
const BLOCK_EDGE_TOP_BIT: u32 = 1u << RECORD_BLOCK_EDGE_TOP_SHIFT;
const BLOCK_PREDICTION_WORD: u32 = 2u;
const BLOCK_EDGE_WORD: u32 = 3u;

// Prediction flags; 0 marks an intra block
const PRED_L0: u32 = 1u;
const PRED_L1: u32 = 2u;
const PRED_BI: u32 = 3u;

// Intra prediction modes with special handling
const INTRA_PLANAR: u32 = 0u;
const INTRA_DC: u32 = 1u;
const INTRA_ANGULAR_10: u32 = 10u;
const INTRA_ANGULAR_26: u32 = 26u;

// The job lists of a CTB, in record order: three intra lists, then transform lists for sizes 4, 8, 16, and 32
const JOB_LIST_TRANSFORM_4: u32 = 3u;

const TRANSFORM_DST_BIT: u32 = 1u << RECORD_TRANSFORM_DST_SHIFT;
const TRANSFORM_SKIP_BIT: u32 = 1u << RECORD_TRANSFORM_SKIP_SHIFT;
const TRANSFORM_BYPASS_BIT: u32 = 1u << RECORD_TRANSFORM_BYPASS_SHIFT;
const TRANSFORM_RDPCM_BIT: u32 = 1u << RECORD_TRANSFORM_RDPCM_SHIFT;
const TRANSFORM_RDPCM_VERTICAL_BIT: u32 = 1u << RECORD_TRANSFORM_RDPCM_VERTICAL_SHIFT;

// Reports a failure: the code in the high byte and the failing value below it; the highest report wins
fn reportFailure(code: u32, value: u32) {
    reportDecodeError((code << ERROR_CODE_SHIFT) | min(value, (1u << ERROR_CODE_SHIFT) - 1u));
}

fn pictureValue(field: u32) -> u32 {
    return pictureState[F_PARAMETERS + field];
}

fn pictureSignedValue(field: u32) -> i32 {
    return bitcast<i32>(pictureState[F_PARAMETERS + field]);
}

fn setPictureValue(field: u32, value: u32) {
    pictureState[F_PARAMETERS + field] = value;
}

// Picture geometry every pass loads at its start
var<private> pictureWidth: u32;
var<private> pictureHeight: u32;
var<private> chromaFormat: u32;
var<private> horizontalShift: u32;
var<private> verticalShift: u32;
var<private> bitDepthLuma: u32;
var<private> bitDepthChroma: u32;
var<private> ctbLog2: u32;
var<private> ctbSize: u32;
var<private> ctbWidth: u32;
var<private> ctbHeight: u32;
var<private> minTbLog2: u32;
var<private> blockStride: u32;
// Word offsets of the record's slice records and CTB table in the packet
var<private> recordSlices: u32;
var<private> recordCtbs: u32;

fn loadPictureGeometry() {
    pictureWidth = pictureValue(P_WIDTH);
    pictureHeight = pictureValue(P_HEIGHT);
    chromaFormat = pictureValue(P_CHROMA_FORMAT);
    horizontalShift = pictureValue(P_HORIZONTAL_SHIFT);
    verticalShift = pictureValue(P_VERTICAL_SHIFT);
    bitDepthLuma = pictureValue(P_BIT_DEPTH);
    bitDepthChroma = pictureValue(P_BIT_DEPTH_CHROMA);
    ctbLog2 = pictureValue(P_CTB_LOG2);
    ctbSize = 1u << ctbLog2;
    ctbWidth = pictureValue(P_CTB_WIDTH);
    ctbHeight = pictureValue(P_CTB_HEIGHT);
    minTbLog2 = pictureValue(P_MIN_TB_LOG2);
    blockStride = pictureValue(P_BLOCK_STRIDE);
    recordSlices = pictureValue(P_SLICES);
    recordCtbs = pictureValue(P_CTBS);
}

fn planeWidth(plane: u32) -> u32 {
    return select(pictureValue(P_CHROMA_PLANE_WIDTH), pictureWidth, plane == 0u);
}

fn planeHeight(plane: u32) -> u32 {
    return select(pictureValue(P_CHROMA_PLANE_HEIGHT), pictureHeight, plane == 0u);
}

fn planeBitDepth(plane: u32) -> u32 {
    return select(bitDepthChroma, bitDepthLuma, plane == 0u);
}

fn planeHorizontalShift(plane: u32) -> u32 {
    return select(horizontalShift, 0u, plane == 0u);
}

fn planeVerticalShift(plane: u32) -> u32 {
    return select(verticalShift, 0u, plane == 0u);
}

fn clipToBitDepth(value: i32, bitDepth: u32) -> u32 {
    return u32(clamp(value, 0, (1 << bitDepth) - 1));
}

// Samples of the output slot and of reference slots
fn readPictureSample(plane: u32, x: u32, y: u32) -> u32 {
    return readSlotSample(packet.outputSlot, plane, x, y);
}

// Writes one sample of the output slot; the invocation must own the sample's word for the whole pass
fn writePictureSample(plane: u32, x: u32, y: u32, value: u32) {
    let byteAddress = getSampleByteAddress(packet.outputSlot, plane, x, y);
    let wordIndex = byteAddress >> 2u;
    let shift = (byteAddress & 3u) * 8u;
    let mask = SAMPLE_MASK << shift;
    framePool[wordIndex] = (framePool[wordIndex] & ~mask) | ((value & SAMPLE_MASK) << shift);
}

// Writes the SAMPLES_PER_WORD samples of one output word, starting at x, a multiple of SAMPLES_PER_WORD
fn writePictureWord(plane: u32, x: u32, y: u32, samples: vec4u) {
    let byteAddress = getSampleByteAddress(packet.outputSlot, plane, x, y);
    var word = 0u;
    for (var lane = 0u; lane < SAMPLES_PER_WORD; lane += 1u) {
        word |= (samples[lane] & SAMPLE_MASK) << (lane * SAMPLE_BYTES * 8u);
    }
    framePool[byteAddress >> 2u] = word;
}

// Reads a reference slot sample with the coordinates clamped into the picture; a missing reference reads mid-gray
fn readReferenceClamped(slot: u32, plane: u32, x: i32, y: i32) -> i32 {
    if (slot == NO_SLOT) {
        return 1 << (planeBitDepth(plane) - 1u);
    }
    let clampedX = u32(clamp(x, 0, i32(planeWidth(plane)) - 1));
    let clampedY = u32(clamp(y, 0, i32(planeHeight(plane)) - 1));
    return i32(readSlotSample(slot, plane, clampedX, clampedY));
}

// Residual samples, one i32 per sample of each plane, tightly packed at the SPS size
fn residualIndex(plane: u32, x: u32, y: u32) -> u32 {
    switch (plane) {
        case 0u: {
            return y * pictureWidth + x;
        }
        case 1u: {
            return pictureValue(P_RESIDUAL_CB_BASE) + y * pictureValue(P_CHROMA_PLANE_WIDTH) + x;
        }
        default: {
            return pictureValue(P_RESIDUAL_CR_BASE) + y * pictureValue(P_CHROMA_PLANE_WIDTH) + x;
        }
    }
}

fn readResidual(plane: u32, x: u32, y: u32) -> i32 {
    return bitcast<i32>(residualData[residualIndex(plane, x, y)]);
}

// 4x4 block records, addressed by luma sample coordinates
fn blockRecord(x: u32, y: u32) -> u32 {
    return ((y >> 2u) * blockStride + (x >> 2u)) * BLOCK_WORDS;
}

// The prediction and edge fields of a block, which occupy distinct bits
fn blockFields(x: u32, y: u32) -> u32 {
    let record = blockRecord(x, y);
    return blockData[record + BLOCK_PREDICTION_WORD] | blockData[record + BLOCK_EDGE_WORD];
}

fn blockPredFlags(fields: u32) -> u32 {
    return (fields >> RECORD_BLOCK_PRED_FLAGS_SHIFT) & 3u;
}

fn blockRefIdx(fields: u32, list: u32) -> u32 {
    return (fields >> (RECORD_BLOCK_REF_IDX_0_SHIFT + list * 4u)) & 15u;
}

// QpY, the signed top byte of the prediction word
fn blockQp(x: u32, y: u32) -> i32 {
    return bitcast<i32>(blockData[blockRecord(x, y) + BLOCK_PREDICTION_WORD]) >> RECORD_BLOCK_QP_SHIFT;
}

fn blockMotionVector(x: u32, y: u32, list: u32) -> vec2i {
    return unpackMotionVector(blockData[blockRecord(x, y) + list]);
}

fn unpackMotionVector(word: u32) -> vec2i {
    return vec2i(i32(word << 16u) >> 16u, i32(word) >> 16);
}

// The record's CTB table, in raster order
fn ctbValue(ctbAddressRs: u32, field: u32) -> u32 {
    return readPacketWord(recordCtbs + ctbAddressRs * RECORD_CTB_WORDS + field);
}

fn ctbSlice(ctbAddressRs: u32) -> u32 {
    return ctbValue(ctbAddressRs, RECORD_CTB_SLICE);
}

// The word offset of one of a CTB's job lists in the packet: the lists follow each other in record order
fn ctbJobList(ctbAddressRs: u32, list: u32) -> u32 {
    var offset = ctbValue(ctbAddressRs, RECORD_CTB_JOB_OFFSET);
    for (var previous = 0u; previous < list; previous += 1u) {
        offset += ctbValue(ctbAddressRs, RECORD_CTB_INTRA_COUNT_LUMA + previous);
    }
    return offset;
}

fn ctbJobCount(ctbAddressRs: u32, list: u32) -> u32 {
    return ctbValue(ctbAddressRs, RECORD_CTB_INTRA_COUNT_LUMA + list);
}

// The record's slice records
fn sliceValue(slice: u32, field: u32) -> u32 {
    return readPacketWord(recordSlices + slice * RECORD_SLICE_WORDS + field);
}

fn sliceSignedValue(slice: u32, field: u32) -> i32 {
    return bitcast<i32>(sliceValue(slice, field));
}

fn referenceField(slice: u32, list: u32, refIdx: u32, field: u32) -> u32 {
    return sliceValue(slice, RECORD_SLICE_REFERENCES + (list * RECORD_MAXIMUM_REFERENCE_INDICES + refIdx) * RECORD_REFERENCE_ENTRY_WORDS + field);
}

// The pool slot of a reference picture, which beginPicture resolved from its picture ID
fn referenceSlot(slice: u32, list: u32, refIdx: u32) -> u32 {
    return pictureState[F_SLICE_SLOTS + slice * SLICE_SLOT_WORDS + list * RECORD_MAXIMUM_REFERENCE_INDICES + refIdx];
}

fn referencePoc(slice: u32, list: u32, refIdx: u32) -> i32 {
    return bitcast<i32>(referenceField(slice, list, refIdx, 1u));
}

fn referenceIsLongTerm(slice: u32, list: u32, refIdx: u32) -> bool {
    return referenceField(slice, list, refIdx, 2u) != 0u;
}

// One of a reference's six weight values: luma weight and offset, Cb weight and offset, Cr weight and offset
fn weightValue(slice: u32, list: u32, refIdx: u32, index: u32) -> i32 {
    return sliceSignedValue(slice, RECORD_SLICE_WEIGHTS + (list * RECORD_MAXIMUM_REFERENCE_INDICES + refIdx) * RECORD_WEIGHT_ENTRY_WORDS + index);
}

// CTB address tables of the active parameter sets
fn ctbAddressRsToTs(ctbAddressRs: u32) -> u32 {
    return state[S_RS_TO_TS + ctbAddressRs];
}

fn tileIdOfTs(ctbAddressTs: u32) -> u32 {
    return state[S_TILE_ID + ctbAddressTs];
}

fn ctbAddressOf(x: u32, y: u32) -> u32 {
    return (y >> ctbLog2) * ctbWidth + (x >> ctbLog2);
}

// Interleaves the low bits of x and y, x in the even bits, as z-scan order does
fn interleaveBits(x: u32, y: u32, bitCount: u32) -> u32 {
    var result = 0u;
    for (var bit = 0u; bit < bitCount; bit += 1u) {
        result |= ((x >> bit) & 1u) << (2u * bit);
        result |= ((y >> bit) & 1u) << (2u * bit + 1u);
    }
    return result;
}

// MinTbAddrZs of a luma position inside the picture (6.5.2)
fn minTbAddressZs(x: u32, y: u32) -> u32 {
    let shift = ctbLog2 - minTbLog2;
    let mask = (1u << shift) - 1u;
    let ctbAddressTs = ctbAddressRsToTs(ctbAddressOf(x, y));
    return (ctbAddressTs << (2u * shift)) | interleaveBits((x >> minTbLog2) & mask, (y >> minTbLog2) & mask, shift);
}

// z-scan availability (6.4.1) once every CTB record of the picture is written: the slice comes from the CTB records
fn isDecodedNeighbourAvailable(currentX: u32, currentY: u32, neighbourX: i32, neighbourY: i32) -> bool {
    if (neighbourX < 0 || neighbourY < 0 || u32(neighbourX) >= pictureWidth || u32(neighbourY) >= pictureHeight) {
        return false;
    }
    let x = u32(neighbourX);
    let y = u32(neighbourY);
    if (minTbAddressZs(x, y) > minTbAddressZs(currentX, currentY)) {
        return false;
    }
    let neighbourCtb = ctbAddressOf(x, y);
    let currentCtb = ctbAddressOf(currentX, currentY);
    if (sliceValue(ctbSlice(neighbourCtb), RECORD_SLICE_ADDRESS_RS) != sliceValue(ctbSlice(currentCtb), RECORD_SLICE_ADDRESS_RS)) {
        return false;
    }
    return tileIdOfTs(ctbAddressRsToTs(neighbourCtb)) == tileIdOfTs(ctbAddressRsToTs(currentCtb));
}

// WGSL of the HEVC back end's picture setup from the GPU record the CPU parser wrote: the record check, the picture parameter block,
// the CTB address tables, the DPB of pool slots by picture ID, and the expansion of the record's per-CTB block records and coefficients.
const RECORD_WORKGROUP_SIZE: u32 = 64u;

// The record header starts the packet
fn headerValue(field: u32) -> u32 {
    return readPacketWord(field);
}

// Builds CtbAddrRsToTs, TileId, and the tile boundaries (6.5.1) from the record header's tile boundaries
fn buildCtbTables(widthInCtbs: u32) {
    let columns = headerValue(RECORD_HEADER_TILE_COLUMNS);
    let rows = headerValue(RECORD_HEADER_TILE_ROWS);
    for (var column = 0u; column <= columns; column += 1u) {
        state[S_COLUMN_BOUNDARIES + column] = headerValue(RECORD_HEADER_COLUMN_BOUNDARIES + column);
    }
    for (var row = 0u; row <= rows; row += 1u) {
        state[S_ROW_BOUNDARIES + row] = headerValue(RECORD_HEADER_ROW_BOUNDARIES + row);
    }
    var ctbAddressTs = 0u;
    var tileId = 0u;
    for (var row = 0u; row < rows; row += 1u) {
        for (var column = 0u; column < columns; column += 1u) {
            for (var y = state[S_ROW_BOUNDARIES + row]; y < state[S_ROW_BOUNDARIES + row + 1u]; y += 1u) {
                for (var x = state[S_COLUMN_BOUNDARIES + column]; x < state[S_COLUMN_BOUNDARIES + column + 1u]; x += 1u) {
                    state[S_RS_TO_TS + y * widthInCtbs + x] = ctbAddressTs;
                    state[S_TILE_ID + ctbAddressTs] = tileId;
                    ctbAddressTs += 1u;
                }
            }
            tileId += 1u;
        }
    }
}

fn dpbEntry(index: u32) -> u32 {
    return S_DPB + index * DPB_ENTRY_WORDS;
}

// The pool slot of a picture the DPB holds, or NO_SLOT for a missing or unknown one
fn findPictureSlot(pictureId: u32) -> u32 {
    if (pictureId == RECORD_MISSING_PICTURE) {
        return NO_SLOT;
    }
    for (var index = 0u; index < DPB_ENTRY_COUNT; index += 1u) {
        let entry = dpbEntry(index);
        if (state[entry + 1u] != NO_SLOT && state[entry] == pictureId) {
            return state[entry + 1u];
        }
    }
    return NO_SLOT;
}

// Releases the slots of pictures the record's DPB no longer keeps, then holds the output slot for the current picture.
// A cleared state reads as entries with slot 0 and picture ID 0, so an entry is in use only while it names a slot through its flag word.
fn updateDpb() -> bool {
    let keepCount = min(headerValue(RECORD_HEADER_DPB_COUNT), RECORD_MAXIMUM_DPB_PICTURES);
    var free = DPB_ENTRY_COUNT;
    for (var index = 0u; index < DPB_ENTRY_COUNT; index += 1u) {
        let entry = dpbEntry(index);
        let slot = state[entry + 1u];
        if (slot == NO_SLOT) {
            free = min(free, index);
            continue;
        }
        let pictureId = state[entry];
        var kept = false;
        for (var keep = 0u; keep < keepCount; keep += 1u) {
            if (headerValue(RECORD_HEADER_DPB + keep) == pictureId) {
                kept = true;
            }
        }
        if (!kept) {
            releaseReferenceSlot(slot);
            state[entry + 1u] = NO_SLOT;
            free = min(free, index);
        }
    }
    if (free >= DPB_ENTRY_COUNT) {
        reportFailure(ERROR_REFERENCE_PICTURES, DPB_ENTRY_COUNT);
        return false;
    }
    state[dpbEntry(free)] = headerValue(RECORD_HEADER_PICTURE_ID);
    state[dpbEntry(free) + 1u] = packet.outputSlot;
    return true;
}

@compute @workgroup_size(1)
fn beginPicture() {
    pictureState[F_VALID] = 0u;
    pictureState[F_WAVE_EVEN] = 0u;
    pictureState[F_WAVE_ODD] = 0u;
    if (atomicLoad(&status.errorCode) != 0u) {
        return;
    }
    // A reset cleared the state, whose zero slots would read as held: the DPB starts empty
    if (packet.reset == 1u) {
        for (var index = 0u; index < DPB_ENTRY_COUNT; index += 1u) {
            state[dpbEntry(index) + 1u] = NO_SLOT;
        }
        state[S_TABLES_GENERATION] = 0u;
    }
    let recordWords = packet.byteLength / 4u;
    if (recordWords < RECORD_HEADER_WORDS || headerValue(RECORD_HEADER_MAGIC) != RECORD_MAGIC || headerValue(RECORD_HEADER_VERSION) != RECORD_VERSION) {
        reportFailure(ERROR_RECORD_INVALID, 1u);
        return;
    }
    let width = headerValue(RECORD_HEADER_WIDTH);
    let height = headerValue(RECORD_HEADER_HEIGHT);
    let chroma = headerValue(RECORD_HEADER_CHROMA_FORMAT);
    let bitDepth = headerValue(RECORD_HEADER_BIT_DEPTH);
    let bitDepthChromaValue = headerValue(RECORD_HEADER_BIT_DEPTH_CHROMA);
    let ctbLog2Value = headerValue(RECORD_HEADER_CTB_LOG2);
    if (width == 0u || height == 0u || width > stream.planes[0].width || height > stream.planes[0].height || width * height > MAXIMUM_LUMA_PICTURE_SIZE) {
        reportFailure(ERROR_PICTURE_SIZE, width);
        return;
    }
    if (bitDepth != OUTPUT_BIT_DEPTH || (chroma != 0u && bitDepthChromaValue != OUTPUT_BIT_DEPTH)) {
        reportFailure(ERROR_BIT_DEPTH, bitDepth);
        return;
    }
    if (chroma != OUTPUT_CHROMA_FORMAT && !(chroma == 0u && OUTPUT_CHROMA_FORMAT == 1u)) {
        reportFailure(ERROR_CHROMA_FORMAT, chroma);
        return;
    }
    let widthInCtbs = (width + (1u << ctbLog2Value) - 1u) >> ctbLog2Value;
    let heightInCtbs = (height + (1u << ctbLog2Value) - 1u) >> ctbLog2Value;
    let sliceCount = headerValue(RECORD_HEADER_SLICE_COUNT);
    let slices = headerValue(RECORD_HEADER_SLICES);
    let ctbs = headerValue(RECORD_HEADER_CTBS);
    if (sliceCount == 0u || sliceCount > RECORD_MAXIMUM_SLICES || slices + sliceCount * RECORD_SLICE_WORDS > recordWords
        || ctbs + widthInCtbs * heightInCtbs * RECORD_CTB_WORDS > recordWords) {
        reportFailure(ERROR_RECORD_INVALID, 2u);
        return;
    }
    let tablesGeneration = headerValue(RECORD_HEADER_TABLES_GENERATION);
    if (state[S_TABLES_GENERATION] != tablesGeneration) {
        buildCtbTables(widthInCtbs);
        state[S_TABLES_GENERATION] = tablesGeneration;
    }
    if (!updateDpb()) {
        return;
    }
    // Each slice's reference pictures, as pool slots
    for (var slice = 0u; slice < sliceCount; slice += 1u) {
        let sliceBase = slices + slice * RECORD_SLICE_WORDS;
        for (var list = 0u; list < 2u; list += 1u) {
            let count = min(readPacketWord(sliceBase + RECORD_SLICE_REFERENCE_COUNT_0 + list), RECORD_MAXIMUM_REFERENCE_INDICES);
            for (var refIdx = 0u; refIdx < RECORD_MAXIMUM_REFERENCE_INDICES; refIdx += 1u) {
                var slot = NO_SLOT;
                if (refIdx < count) {
                    let entry = sliceBase + RECORD_SLICE_REFERENCES + (list * RECORD_MAXIMUM_REFERENCE_INDICES + refIdx) * RECORD_REFERENCE_ENTRY_WORDS;
                    slot = findPictureSlot(readPacketWord(entry));
                }
                pictureState[F_SLICE_SLOTS + slice * SLICE_SLOT_WORDS + list * RECORD_MAXIMUM_REFERENCE_INDICES + refIdx] = slot;
            }
        }
    }
    let horizontalShiftValue = select(0u, 1u, chroma == 1u || chroma == 2u);
    let verticalShiftValue = select(0u, 1u, chroma == 1u);
    let chromaPlaneWidth = select(0u, width >> horizontalShiftValue, chroma != 0u);
    let chromaPlaneHeight = select(0u, height >> verticalShiftValue, chroma != 0u);
    setPictureValue(P_WIDTH, width);
    setPictureValue(P_HEIGHT, height);
    setPictureValue(P_CHROMA_FORMAT, chroma);
    setPictureValue(P_HORIZONTAL_SHIFT, horizontalShiftValue);
    setPictureValue(P_VERTICAL_SHIFT, verticalShiftValue);
    setPictureValue(P_BIT_DEPTH, bitDepth);
    setPictureValue(P_BIT_DEPTH_CHROMA, select(bitDepth, bitDepthChromaValue, chroma != 0u));
    setPictureValue(P_CTB_LOG2, ctbLog2Value);
    setPictureValue(P_MIN_TB_LOG2, headerValue(RECORD_HEADER_MIN_TB_LOG2));
    setPictureValue(P_CTB_WIDTH, widthInCtbs);
    setPictureValue(P_CTB_HEIGHT, heightInCtbs);
    setPictureValue(P_CTB_COUNT, widthInCtbs * heightInCtbs);
    setPictureValue(P_BLOCK_STRIDE, (width + 3u) >> 2u);
    setPictureValue(P_STRONG_INTRA_SMOOTHING, headerValue(RECORD_HEADER_STRONG_INTRA_SMOOTHING));
    setPictureValue(P_INTRA_SMOOTHING_DISABLED, headerValue(RECORD_HEADER_INTRA_SMOOTHING_DISABLED));
    setPictureValue(P_CONSTRAINED_INTRA_PRED, headerValue(RECORD_HEADER_CONSTRAINED_INTRA_PRED));
    setPictureValue(P_CB_QP_OFFSET, headerValue(RECORD_HEADER_CB_QP_OFFSET));
    setPictureValue(P_CR_QP_OFFSET, headerValue(RECORD_HEADER_CR_QP_OFFSET));
    setPictureValue(P_LOOP_FILTER_ACROSS_TILES, headerValue(RECORD_HEADER_LOOP_FILTER_ACROSS_TILES));
    setPictureValue(P_SAO_ANY, headerValue(RECORD_HEADER_SAO_ANY));
    setPictureValue(P_DEBLOCKING_ANY, headerValue(RECORD_HEADER_DEBLOCKING_ANY));
    setPictureValue(P_CHROMA_PLANE_WIDTH, chromaPlaneWidth);
    setPictureValue(P_CHROMA_PLANE_HEIGHT, chromaPlaneHeight);
    setPictureValue(P_RESIDUAL_CB_BASE, width * height);
    setPictureValue(P_RESIDUAL_CR_BASE, width * height + chromaPlaneWidth * chromaPlaneHeight);
    let lumaRowWords = (width + SAMPLES_PER_WORD - 1u) / SAMPLES_PER_WORD;
    let chromaRowWords = (chromaPlaneWidth + SAMPLES_PER_WORD - 1u) / SAMPLES_PER_WORD;
    setPictureValue(P_SAO_ROW_WORDS_LUMA, lumaRowWords);
    setPictureValue(P_SAO_ROW_WORDS_CHROMA, chromaRowWords);
    setPictureValue(P_SAO_CB_BASE, F_SAO_SOURCE + lumaRowWords * height);
    setPictureValue(P_SAO_CR_BASE, F_SAO_SOURCE + lumaRowWords * height + chromaRowWords * chromaPlaneHeight);
    setPictureValue(P_SLICES, slices);
    setPictureValue(P_CTBS, ctbs);
    setPictureValue(P_PCM_COUNT, headerValue(RECORD_HEADER_PCM_COUNT));
    setPictureValue(P_PCM, headerValue(RECORD_HEADER_PCM));
    let conformanceLeft = headerValue(RECORD_HEADER_CONFORMANCE_LEFT);
    let conformanceTop = headerValue(RECORD_HEADER_CONFORMANCE_TOP);
    reportHeaderFacts(width, height, bitDepth, vec4u(
        conformanceLeft,
        conformanceTop,
        width - conformanceLeft - headerValue(RECORD_HEADER_CONFORMANCE_RIGHT),
        height - conformanceTop - headerValue(RECORD_HEADER_CONFORMANCE_BOTTOM)
    ));
    pictureState[F_VALID] = 1u;
}

// Writes a CTB's block records from its prediction and edge records, and its coefficients into the residual buffer.
// Records of one kind cover disjoint blocks, and the two kinds write different words, so every invocation writes independently.
@compute @workgroup_size(64)
fn expandRecords(@builtin(workgroup_id) workgroup: vec3u, @builtin(local_invocation_index) lane: u32) {
    if (pictureState[F_VALID] == 0u) {
        return;
    }
    loadPictureGeometry();
    if (workgroup.x >= ctbWidth || workgroup.y >= ctbHeight) {
        return;
    }
    let ctbAddress = workgroup.y * ctbWidth + workgroup.x;
    let ctbX0 = workgroup.x << ctbLog2;
    let ctbY0 = workgroup.y << ctbLog2;
    let predictionOffset = ctbValue(ctbAddress, RECORD_CTB_PREDICTION_OFFSET);
    let predictionCount = ctbValue(ctbAddress, RECORD_CTB_PREDICTION_COUNT);
    for (var index = lane; index < predictionCount; index += RECORD_WORKGROUP_SIZE) {
        let base = predictionOffset + index * RECORD_PREDICTION_WORDS;
        let geometry = readPacketWord(base + RECORD_PREDICTION_GEOMETRY);
        let fields = readPacketWord(base + RECORD_PREDICTION_FIELDS);
        let vector0 = readPacketWord(base + RECORD_PREDICTION_VECTOR_0);
        let vector1 = readPacketWord(base + RECORD_PREDICTION_VECTOR_1);
        let x0 = ctbX0 + (((geometry >> RECORD_PREDICTION_X_SHIFT) & 15u) << 2u);
        let y0 = ctbY0 + (((geometry >> RECORD_PREDICTION_Y_SHIFT) & 15u) << 2u);
        let x1 = min(x0 + ((((geometry >> RECORD_PREDICTION_WIDTH_SHIFT) & 15u) + 1u) << 2u), pictureWidth);
        let y1 = min(y0 + ((((geometry >> RECORD_PREDICTION_HEIGHT_SHIFT) & 15u) + 1u) << 2u), pictureHeight);
        for (var y = y0; y < y1; y += 4u) {
            for (var x = x0; x < x1; x += 4u) {
                let record = blockRecord(x, y);
                blockData[record] = vector0;
                blockData[record + 1u] = vector1;
                blockData[record + BLOCK_PREDICTION_WORD] = fields;
            }
        }
    }
    let edgeOffset = ctbValue(ctbAddress, RECORD_CTB_EDGE_OFFSET);
    let edgeCount = ctbValue(ctbAddress, RECORD_CTB_EDGE_COUNT);
    for (var index = lane; index < edgeCount; index += RECORD_WORKGROUP_SIZE) {
        let edge = readPacketWord(edgeOffset + index);
        let x0 = ctbX0 + (((edge >> RECORD_EDGE_X_SHIFT) & 15u) << 2u);
        let y0 = ctbY0 + (((edge >> RECORD_EDGE_Y_SHIFT) & 15u) << 2u);
        // A coding unit without residual is one edge record of its own size, up to 64
        let size = 4u << ((edge >> RECORD_EDGE_LOG2_SIZE_SHIFT) & 7u);
        let cbfValue = select(0u, BLOCK_CBF_BIT, ((edge >> RECORD_EDGE_CBF_SHIFT) & 1u) == 1u);
        for (var y = y0; y < min(y0 + size, pictureHeight); y += 4u) {
            for (var x = x0; x < min(x0 + size, pictureWidth); x += 4u) {
                var value = cbfValue;
                if (x == x0) {
                    value |= BLOCK_EDGE_LEFT_BIT;
                }
                if (y == y0) {
                    value |= BLOCK_EDGE_TOP_BIT;
                }
                blockData[blockRecord(x, y) + BLOCK_EDGE_WORD] = value;
            }
        }
    }
    let coefficientOffset = ctbValue(ctbAddress, RECORD_CTB_COEFFICIENT_OFFSET);
    let coefficientCount = ctbValue(ctbAddress, RECORD_CTB_COEFFICIENT_COUNT);
    for (var index = lane; index < coefficientCount; index += RECORD_WORKGROUP_SIZE) {
        let word = readPacketWord(coefficientOffset + index);
        let plane = (word >> RECORD_COEFFICIENT_PLANE_SHIFT) & 3u;
        let x = (ctbX0 >> planeHorizontalShift(plane)) + ((word >> RECORD_COEFFICIENT_X_SHIFT) & 63u);
        let y = (ctbY0 >> planeVerticalShift(plane)) + ((word >> RECORD_COEFFICIENT_Y_SHIFT) & 63u);
        residualData[residualIndex(plane, x, y)] = bitcast<u32>(bitcast<i32>(word) >> RECORD_COEFFICIENT_VALUE_SHIFT);
    }
}

// Writes the samples of PCM coding units straight into the output slot, one coding unit per invocation.
// A PCM coding unit's chroma rows start on word boundaries, so no two invocations write one word.
@compute @workgroup_size(64)
fn writePcmSamples(@builtin(local_invocation_index) lane: u32) {
    if (pictureState[F_VALID] == 0u) {
        return;
    }
    loadPictureGeometry();
    let count = pictureValue(P_PCM_COUNT);
    let indexBase = pictureValue(P_PCM);
    let planeCount = select(1u, 3u, chromaFormat != 0u);
    for (var index = lane; index < count; index += RECORD_WORKGROUP_SIZE) {
        let record = readPacketWord(indexBase + index);
        let header = readPacketWord(record);
        let x0 = header & 0xFFFFu;
        let y0 = header >> 16u;
        let cbSize = 1u << readPacketWord(record + 1u);
        var sample = 0u;
        for (var plane = 0u; plane < planeCount; plane += 1u) {
            let width = cbSize >> planeHorizontalShift(plane);
            let height = cbSize >> planeVerticalShift(plane);
            let planeX = x0 >> planeHorizontalShift(plane);
            let planeY = y0 >> planeVerticalShift(plane);
            for (var offset = 0u; offset < width * height; offset += 1u) {
                let word = readPacketWord(record + RECORD_PCM_HEADER_WORDS + (sample >> 1u));
                let value = (word >> ((sample & 1u) * 16u)) & 0xFFFFu;
                writePictureSample(plane, planeX + offset % width, planeY + offset / width, value);
                sample += 1u;
            }
        }
    }
}

// WGSL of the HEVC decoder's reconstruction: residual clearing, inverse transforms, inter prediction, and the intra prediction wavefront.
// Inverse transforms run one workgroup per CTB over the CTB's transform lists; inter prediction runs per output word;
// intra prediction runs in diagonal waves of 64-sample strips, so every neighbour a block reads is reconstructed before it.
// FFmpeg's libavcodec/hevc (dsp_template.c, pred_template.c, hevcdec.c) is the behavioral reference.
const RECONSTRUCTION_WORKGROUP_SIZE: u32 = 64u;

// The inverse DST of 4x4 intra luma blocks (8.6.4.2)
const dstMatrix = array<i32, 16>(29, 55, 74, 84, 74, 74, 0, -74, 84, -29, -74, 55, 55, -84, 74, -29);

const lumaFilters = array<i32, 32>(
    0, 0, 0, 64, 0, 0, 0, 0,
    -1, 4, -10, 58, 17, -5, 1, 0,
    -1, 4, -11, 40, 40, -11, 4, -1,
    0, 1, -5, 17, 58, -10, 4, -1
);

const chromaFilters = array<i32, 32>(
    0, 64, 0, 0,
    -2, 58, 10, -2,
    -4, 54, 16, -2,
    -6, 46, 28, -4,
    -4, 36, 36, -4,
    -4, 28, 46, -6,
    -2, 16, 54, -4,
    -2, 10, 58, -2
);

const intraPredictionAngles = array<i32, 33>(
    32, 26, 21, 17, 13, 9, 5, 2, 0, -2, -5, -9, -13, -17, -21, -26, -32,
    -26, -21, -17, -13, -9, -5, -2, 0, 2, 5, 9, 13, 17, 21, 26, 32
);

const inverseAngles = array<i32, 15>(-4096, -1638, -910, -630, -482, -390, -315, -256, -315, -390, -482, -630, -910, -1638, -4096);

@compute @workgroup_size(16, 16)
fn clearPicture(@builtin(global_invocation_id) invocation: vec3u) {
    if (pictureState[F_VALID] == 0u) {
        return;
    }
    loadPictureGeometry();
    let x = invocation.x;
    let y = invocation.y;
    if (x < pictureWidth && y < pictureHeight) {
        residualData[residualIndex(0u, x, y)] = 0u;
    }
    if (chromaFormat != 0u && x < planeWidth(1u) && y < planeHeight(1u)) {
        residualData[residualIndex(1u, x, y)] = 0u;
        residualData[residualIndex(2u, x, y)] = 0u;
    }
}

// Inverse transforms, one workgroup per CTB
var<workgroup> transformMatrix: array<i32, 1024>;
var<workgroup> transformBlocks: array<i32, 2048>;
var<workgroup> transformControl: u32;

fn transformValue(row: u32, column: u32, size: u32) -> i32 {
    return transformMatrix[(row * (32u / size)) * 32u + column];
}

@compute @workgroup_size(64)
fn inverseTransform(@builtin(workgroup_id) workgroup: vec3u, @builtin(local_invocation_index) lane: u32) {
    loadPictureGeometry();
    if (lane == 0u) {
        transformControl = select(0u, 1u, pictureState[F_VALID] == 1u && workgroup.x < ctbWidth && workgroup.y < ctbHeight);
    }
    if (workgroupUniformLoad(&transformControl) == 0u) {
        return;
    }
    for (var index = lane; index < 1024u; index += RECONSTRUCTION_WORKGROUP_SIZE) {
        transformMatrix[index] = TRANSFORM_MATRIX[index];
    }
    let ctbAddress = workgroup.y * ctbWidth + workgroup.x;
    // Pass 0 transforms every block; pass 1 adds cross-component predictions once every luma block is final
    for (var transformPass = 0u; transformPass < 2u; transformPass += 1u) {
        for (var sizeIndex = 0u; sizeIndex < 4u; sizeIndex += 1u) {
            let size = 4u << sizeIndex;
            let log2Size = sizeIndex + 2u;
            if (lane == 0u) {
                transformControl = ctbJobCount(ctbAddress, JOB_LIST_TRANSFORM_4 + sizeIndex);
            }
            let count = workgroupUniformLoad(&transformControl);
            // Every invocation has read the count before the next one overwrites it
            workgroupBarrier();
            let blocksPerBatch = RECONSTRUCTION_WORKGROUP_SIZE / size;
            let blockSlot = lane / size;
            let line = lane % size;
            let listBase = ctbJobList(ctbAddress, JOB_LIST_TRANSFORM_4 + sizeIndex);
            for (var batchStart = 0u; batchStart < count; batchStart += blocksPerBatch) {
                let entryIndex = batchStart + blockSlot;
                let valid = entryIndex < count;
                var entry = 0u;
                if (valid) {
                    entry = readPacketWord(listBase + entryIndex);
                }
                let plane = (entry >> RECORD_TRANSFORM_PLANE_SHIFT) & 3u;
                let originX = ((workgroup.x << ctbLog2) >> planeHorizontalShift(plane)) + (((entry >> RECORD_TRANSFORM_X_SHIFT) & 15u) << 2u);
                let originY = ((workgroup.y << ctbLog2) >> planeVerticalShift(plane)) + (((entry >> RECORD_TRANSFORM_Y_SHIFT) & 15u) << 2u);
                let crossScale = (bitcast<i32>(entry) << (32u - RECORD_TRANSFORM_CROSS_SHIFT - 5u)) >> 27u;
                if (transformPass == 0u) {
                    transformBlockPass(valid, entry, plane, originX, originY, size, log2Size, blockSlot, line);
                } else if (valid && crossScale != 0) {
                    // resScaleVal * rY >> 3 added to the chroma residual, one row per invocation
                    for (var column = 0u; column < size; column += 1u) {
                        let luma = readResidual(0u, originX + column, originY + line);
                        let index = residualIndex(plane, originX + column, originY + line);
                        residualData[index] = bitcast<u32>(bitcast<i32>(residualData[index]) + ((crossScale * luma) >> 3u));
                    }
                }
                workgroupBarrier();
            }
        }
    }
}

// One block per size invocations: columns, then rows, of an inverse transform, transform skip, or residual DPCM
fn transformBlockPass(valid: bool, entry: u32, plane: u32, originX: u32, originY: u32, size: u32, log2Size: u32, blockSlot: u32, line: u32) {
    let blockBase = blockSlot * size * size;
    let bypass = (entry & TRANSFORM_BYPASS_BIT) != 0u;
    let skip = (entry & TRANSFORM_SKIP_BIT) != 0u;
    let rdpcm = (entry & TRANSFORM_RDPCM_BIT) != 0u;
    let rdpcmVertical = (entry & TRANSFORM_RDPCM_VERTICAL_BIT) != 0u;
    let dst = (entry & TRANSFORM_DST_BIT) != 0u;
    let bitDepth = planeBitDepth(plane);
    var column: array<i32, 32>;
    if (valid) {
        for (var row = 0u; row < size; row += 1u) {
            column[row] = readResidual(plane, originX + line, originY + row);
        }
        if (bypass || skip) {
            if (skip) {
                // r = d << tsShift, then the bdShift rounding of 8.6.2
                let bdShift = 20u - bitDepth;
                for (var row = 0u; row < size; row += 1u) {
                    column[row] = ((column[row] << (5u + log2Size)) + (1 << (bdShift - 1u))) >> bdShift;
                }
            }
            if (rdpcm && rdpcmVertical) {
                for (var row = 1u; row < size; row += 1u) {
                    column[row] += column[row - 1u];
                }
            }
            for (var row = 0u; row < size; row += 1u) {
                transformBlocks[blockBase + row * size + line] = column[row];
            }
        } else {
            // First stage: the column, clipped to 16 bits after a shift of 7
            for (var output = 0u; output < size; output += 1u) {
                var sum = 0;
                for (var input = 0u; input < size; input += 1u) {
                    var coefficient = 0;
                    if (dst) {
                        coefficient = dstMatrix[input * 4u + output];
                    } else {
                        coefficient = transformValue(input, output, size);
                    }
                    sum += coefficient * column[input];
                }
                transformBlocks[blockBase + output * size + line] = clamp((sum + 64) >> 7u, -32768, 32767);
            }
        }
    }
    workgroupBarrier();
    if (!valid) {
        return;
    }
    var row: array<i32, 32>;
    for (var index = 0u; index < size; index += 1u) {
        row[index] = transformBlocks[blockBase + line * size + index];
    }
    if (bypass || skip) {
        if (rdpcm && !rdpcmVertical) {
            for (var index = 1u; index < size; index += 1u) {
                row[index] += row[index - 1u];
            }
        }
        for (var index = 0u; index < size; index += 1u) {
            residualData[residualIndex(plane, originX + index, originY + line)] = bitcast<u32>(row[index]);
        }
        return;
    }
    // Second stage: the row, clipped to 16 bits after a shift of 20 - BitDepth
    let shift = 20u - bitDepth;
    let rounding = 1 << (shift - 1u);
    for (var output = 0u; output < size; output += 1u) {
        var sum = 0;
        for (var input = 0u; input < size; input += 1u) {
            var coefficient = 0;
            if (dst) {
                coefficient = dstMatrix[input * 4u + output];
            } else {
                coefficient = transformValue(input, output, size);
            }
            sum += coefficient * row[input];
        }
        residualData[residualIndex(plane, originX + output, originY + line)] = bitcast<u32>(clamp((sum + rounding) >> shift, -32768, 32767));
    }
}

// Inter prediction, one output word per invocation
struct InterReference {
    slot: u32,
    vector: vec2i,
}

// One list's interpolated sample at 14-bit precision (8.5.3.3.3)
fn interpolateSample(plane: u32, x: u32, y: u32, slot: u32, vector: vec2i) -> i32 {
    let bitDepth = planeBitDepth(plane);
    if (plane == 0u) {
        let fractionX = u32(vector.x & 3);
        let fractionY = u32(vector.y & 3);
        let baseX = i32(x) + (vector.x >> 2u);
        let baseY = i32(y) + (vector.y >> 2u);
        if (fractionX == 0u && fractionY == 0u) {
            return readReferenceClamped(slot, 0u, baseX, baseY) << (14u - bitDepth);
        }
        if (fractionY == 0u) {
            var sum = 0;
            for (var tap = 0u; tap < 8u; tap += 1u) {
                sum += lumaFilters[fractionX * 8u + tap] * readReferenceClamped(slot, 0u, baseX + i32(tap) - 3, baseY);
            }
            return sum >> (bitDepth - 8u);
        }
        if (fractionX == 0u) {
            var sum = 0;
            for (var tap = 0u; tap < 8u; tap += 1u) {
                sum += lumaFilters[fractionY * 8u + tap] * readReferenceClamped(slot, 0u, baseX, baseY + i32(tap) - 3);
            }
            return sum >> (bitDepth - 8u);
        }
        var sum = 0;
        for (var row = 0u; row < 8u; row += 1u) {
            var horizontal = 0;
            for (var tap = 0u; tap < 8u; tap += 1u) {
                horizontal += lumaFilters[fractionX * 8u + tap] * readReferenceClamped(slot, 0u, baseX + i32(tap) - 3, baseY + i32(row) - 3);
            }
            sum += lumaFilters[fractionY * 8u + row] * (horizontal >> (bitDepth - 8u));
        }
        return sum >> 6u;
    }
    // Chroma vectors are in units of 1 / (4 * SubWidthC) and 1 / (4 * SubHeightC) samples; fractions index eighth-sample filters
    let shiftX = 2u + horizontalShift;
    let shiftY = 2u + verticalShift;
    let fractionX = (u32(vector.x) & ((1u << shiftX) - 1u)) << (1u - horizontalShift);
    let fractionY = (u32(vector.y) & ((1u << shiftY) - 1u)) << (1u - verticalShift);
    let baseX = i32(x) + (vector.x >> shiftX);
    let baseY = i32(y) + (vector.y >> shiftY);
    if (fractionX == 0u && fractionY == 0u) {
        return readReferenceClamped(slot, plane, baseX, baseY) << (14u - bitDepth);
    }
    if (fractionY == 0u) {
        var sum = 0;
        for (var tap = 0u; tap < 4u; tap += 1u) {
            sum += chromaFilters[fractionX * 4u + tap] * readReferenceClamped(slot, plane, baseX + i32(tap) - 1, baseY);
        }
        return sum >> (bitDepth - 8u);
    }
    if (fractionX == 0u) {
        var sum = 0;
        for (var tap = 0u; tap < 4u; tap += 1u) {
            sum += chromaFilters[fractionY * 4u + tap] * readReferenceClamped(slot, plane, baseX, baseY + i32(tap) - 1);
        }
        return sum >> (bitDepth - 8u);
    }
    var sum = 0;
    for (var row = 0u; row < 4u; row += 1u) {
        var horizontal = 0;
        for (var tap = 0u; tap < 4u; tap += 1u) {
            horizontal += chromaFilters[fractionX * 4u + tap] * readReferenceClamped(slot, plane, baseX + i32(tap) - 1, baseY + i32(row) - 1);
        }
        sum += chromaFilters[fractionY * 4u + row] * (horizontal >> (bitDepth - 8u));
    }
    return sum >> 6u;
}

// The weighted sample prediction of one sample (8.5.3.3.4)
fn predictInterSample(plane: u32, x: u32, y: u32, lumaX: u32, lumaY: u32) -> i32 {
    let record = blockRecord(lumaX, lumaY);
    let fields = blockData[record + BLOCK_PREDICTION_WORD];
    let predFlags = blockPredFlags(fields);
    let slice = ctbSlice(ctbAddressOf(lumaX, lumaY));
    let bitDepth = planeBitDepth(plane);
    let weighted = sliceValue(slice, RECORD_SLICE_WEIGHTED) == 1u;
    let denominator = select(sliceValue(slice, RECORD_SLICE_CHROMA_LOG2_WEIGHT_DENOM), sliceValue(slice, RECORD_SLICE_LUMA_LOG2_WEIGHT_DENOM), plane == 0u);
    let weightIndex = select(2u + (plane - 1u) * 2u, 0u, plane == 0u);
    var predictions = vec2i(0);
    var weights = vec2i(1);
    var offsets = vec2i(0);
    for (var list = 0u; list < 2u; list += 1u) {
        if ((predFlags & (1u << list)) == 0u) {
            continue;
        }
        let refIdx = blockRefIdx(fields, list);
        let vector = unpackMotionVector(blockData[record + list]);
        predictions[list] = interpolateSample(plane, x, y, referenceSlot(slice, list, refIdx), vector);
        weights[list] = weightValue(slice, list, refIdx, weightIndex);
        offsets[list] = weightValue(slice, list, refIdx, weightIndex + 1u);
    }
    let offsetScale = 1 << (bitDepth - 8u);
    if (predFlags == PRED_BI) {
        if (!weighted) {
            let shift = 15u - bitDepth;
            return (predictions.x + predictions.y + (1 << (shift - 1u))) >> shift;
        }
        let log2Weight = denominator + 14u - bitDepth;
        let offset = (offsets.x + offsets.y) * offsetScale + 1;
        return (predictions.x * weights.x + predictions.y * weights.y + (offset << log2Weight)) >> (log2Weight + 1u);
    }
    let list = select(0u, 1u, predFlags == PRED_L1);
    if (!weighted) {
        let shift = 14u - bitDepth;
        return (predictions[list] + (1 << (shift - 1u))) >> shift;
    }
    let shift = denominator + 14u - bitDepth;
    var rounding = 0;
    if (shift > 0u) {
        rounding = 1 << (shift - 1u);
    }
    return ((predictions[list] * weights[list] + rounding) >> shift) + offsets[list] * offsetScale;
}

@compute @workgroup_size(8, 8)
fn predictInter(@builtin(global_invocation_id) invocation: vec3u) {
    if (pictureState[F_VALID] == 0u) {
        return;
    }
    loadPictureGeometry();
    let plane = invocation.z;
    if (plane > 0u && chromaFormat == 0u) {
        return;
    }
    let x0 = invocation.x * SAMPLES_PER_WORD;
    let y = invocation.y;
    let width = planeWidth(plane);
    if (x0 >= width || y >= planeHeight(plane)) {
        return;
    }
    let shiftX = planeHorizontalShift(plane);
    let shiftY = planeVerticalShift(plane);
    // A word never straddles coding units, so the first sample decides whether the word is inter predicted
    if (blockPredFlags(blockFields(x0 << shiftX, y << shiftY)) == 0u) {
        return;
    }
    let bitDepth = planeBitDepth(plane);
    var samples = vec4u(0u);
    for (var lane = 0u; lane < SAMPLES_PER_WORD; lane += 1u) {
        let x = x0 + lane;
        if (x >= width) {
            samples[lane] = readPictureSample(plane, min(x, stream.planes[plane].width - 1u), y);
            continue;
        }
        // The weighted sample prediction clips to the sample range before the residual is added (8.5.3.3.4)
        let prediction = i32(clipToBitDepth(predictInterSample(plane, x, y, x << shiftX, y << shiftY), bitDepth));
        samples[lane] = clipToBitDepth(prediction + readResidual(plane, x, y), bitDepth);
    }
    writePictureWord(plane, x0, y, samples);
}

// Intra prediction (8.4.4.2), a wave of strips per dispatch
var<workgroup> intraReference: array<i32, 129>;
var<workgroup> intraFiltered: array<i32, 129>;
var<workgroup> intraAvailable: array<u32, 129>;
var<workgroup> intraControl: u32;
var<workgroup> intraFirstCtb: u32;
var<workgroup> intraLastCtb: u32;

// Both dispatches of a wave pair run this entry point: the even one has a workgroup column per CTB row, and the odd one a column more, which returns at once.
// Each reads its own wave counter, so every workgroup of a dispatch sees one wave, and writes the next wave into the other's.
@compute @workgroup_size(64)
fn predictIntra(
    @builtin(workgroup_id) workgroup: vec3u,
    @builtin(num_workgroups) workgroupCount: vec3u,
    @builtin(local_invocation_index) lane: u32
) {
    let rowCount = (stream.height + INTRA_ROW_HEIGHT - 1u) / INTRA_ROW_HEIGHT;
    if (workgroup.x >= rowCount) {
        return;
    }
    let odd = workgroupCount.x > rowCount;
    if (lane == 0u) {
        intraControl = pictureState[select(F_WAVE_EVEN, F_WAVE_ODD, odd)];
    }
    let wave = workgroupUniformLoad(&intraControl);
    workgroupBarrier();
    predictIntraWave(wave, workgroup, lane);
    if (lane == 0u) {
        pictureState[select(F_WAVE_ODD, F_WAVE_EVEN, odd)] = wave + 1u;
    }
}

// Reconstructs the intra blocks of one plane of one strip: the strip of diagonal wave in CTB row workgroup.x
fn predictIntraWave(wave: u32, workgroup: vec3u, lane: u32) {
    loadPictureGeometry();
    let plane = workgroup.z;
    let row = workgroup.x;
    // The strip's CTB columns, decided by one invocation so every barrier stays in uniform control flow
    if (lane == 0u) {
        intraFirstCtb = 0u;
        intraLastCtb = 0u;
        let ctbsPerStrip = max(INTRA_STRIP_WIDTH >> ctbLog2, 1u);
        if (pictureState[F_VALID] == 1u && row < ctbHeight && !(plane > 0u && chromaFormat == 0u) && wave >= 2u * row) {
            let firstCtb = (wave - 2u * row) * ctbsPerStrip;
            if (firstCtb < ctbWidth) {
                intraFirstCtb = firstCtb;
                intraLastCtb = min(firstCtb + ctbsPerStrip, ctbWidth);
            }
        }
    }
    let firstCtb = workgroupUniformLoad(&intraFirstCtb);
    let lastCtb = workgroupUniformLoad(&intraLastCtb);
    for (var column = firstCtb; column < lastCtb; column += 1u) {
        let ctbAddress = row * ctbWidth + column;
        if (lane == 0u) {
            intraControl = ctbJobCount(ctbAddress, plane);
        }
        let count = workgroupUniformLoad(&intraControl);
        workgroupBarrier();
        let listBase = ctbJobList(ctbAddress, plane);
        let originX = (column << ctbLog2) >> planeHorizontalShift(plane);
        let originY = (row << ctbLog2) >> planeVerticalShift(plane);
        for (var job = 0u; job < count; job += 1u) {
            if (lane == 0u) {
                intraControl = readPacketWord(listBase + job);
            }
            let word = workgroupUniformLoad(&intraControl);
            workgroupBarrier();
            let blockX = originX + (((word >> RECORD_JOB_X_SHIFT) & 15u) << 2u);
            let blockY = originY + (((word >> RECORD_JOB_Y_SHIFT) & 15u) << 2u);
            let log2Size = ((word >> RECORD_JOB_SIZE_SHIFT) & 3u) + 2u;
            let mode = (word >> RECORD_JOB_MODE_SHIFT) & 63u;
            predictIntraBlock(plane, blockX, blockY, log2Size, mode, lane);
        }
    }
}

// The reference sample index of a neighbour: 0 is (-1, 2N - 1), 2N is the corner, 4N is (2N - 1, -1)
fn intraReferencePosition(index: u32, size: u32) -> vec2i {
    let corner = 2u * size;
    if (index < corner) {
        return vec2i(-1, i32(corner - 1u - index));
    }
    return vec2i(i32(index) - i32(corner) - 1, -1);
}

fn intraLeft(offset: i32, size: u32) -> i32 {
    return intraFiltered[u32(i32(2u * size) - 1 - offset)];
}

fn intraTop(offset: i32, size: u32) -> i32 {
    return intraFiltered[u32(i32(2u * size) + 1 + offset)];
}

fn predictIntraBlock(plane: u32, blockX: u32, blockY: u32, log2Size: u32, mode: u32, lane: u32) {
    let size = 1u << log2Size;
    let referenceCount = 4u * size + 1u;
    let bitDepth = planeBitDepth(plane);
    let shiftX = planeHorizontalShift(plane);
    let shiftY = planeVerticalShift(plane);
    let currentLumaX = blockX << shiftX;
    let currentLumaY = blockY << shiftY;
    let constrained = pictureValue(P_CONSTRAINED_INTRA_PRED) == 1u;
    let width = planeWidth(plane);
    let height = planeHeight(plane);
    for (var index = lane; index < referenceCount; index += RECONSTRUCTION_WORKGROUP_SIZE) {
        let offset = intraReferencePosition(index, size);
        let x = i32(blockX) + offset.x;
        let y = i32(blockY) + offset.y;
        var available = false;
        if (x >= 0 && y >= 0 && u32(x) < width && u32(y) < height) {
            let lumaX = u32(x) << shiftX;
            let lumaY = u32(y) << shiftY;
            available = isDecodedNeighbourAvailable(currentLumaX, currentLumaY, i32(lumaX), i32(lumaY));
            if (available && constrained) {
                available = blockPredFlags(blockFields(lumaX, lumaY)) == 0u;
            }
            if (available) {
                intraReference[index] = i32(readPictureSample(plane, u32(x), u32(y)));
            }
        }
        intraAvailable[index] = select(0u, 1u, available);
    }
    workgroupBarrier();
    // Substitution of unavailable reference samples (8.4.4.2.2)
    if (lane == 0u) {
        var first = referenceCount;
        for (var index = 0u; index < referenceCount; index += 1u) {
            if (intraAvailable[index] == 1u) {
                first = index;
                break;
            }
        }
        if (first == referenceCount) {
            for (var index = 0u; index < referenceCount; index += 1u) {
                intraReference[index] = 1 << (bitDepth - 1u);
            }
        } else {
            intraReference[0] = intraReference[first];
            for (var index = 1u; index < referenceCount; index += 1u) {
                if (intraAvailable[index] == 0u) {
                    intraReference[index] = intraReference[index - 1u];
                }
            }
        }
    }
    workgroupBarrier();
    // Filtering of neighbouring samples (8.4.4.2.3)
    var smoothing = false;
    var strong = false;
    if (pictureValue(P_INTRA_SMOOTHING_DISABLED) == 0u && (plane == 0u || chromaFormat == 3u) && mode != INTRA_DC && size != 4u) {
        let distance = min(u32(abs(i32(mode) - 26)), u32(abs(i32(mode) - 10)));
        let threshold = select(select(0u, 1u, log2Size == 4u), 7u, log2Size == 3u);
        smoothing = distance > threshold;
        if (smoothing && plane == 0u && log2Size == 5u && pictureValue(P_STRONG_INTRA_SMOOTHING) == 1u) {
            // Bi-linear smoothing when both sides are nearly linear
            let limit = 1 << (bitDepth - 5u);
            let corner = intraReference[2u * size];
            strong = abs(corner + intraReference[4u * size] - 2 * intraReference[3u * size]) < limit
                && abs(corner + intraReference[0] - 2 * intraReference[size]) < limit;
        }
    }
    for (var index = lane; index < referenceCount; index += RECONSTRUCTION_WORKGROUP_SIZE) {
        var value = intraReference[index];
        if (strong) {
            let corner = intraReference[2u * size];
            if (index < 2u * size && index > 0u) {
                // Left samples: 63 - i parts corner, i + 1 parts the last left sample
                let offset = i32(2u * size - 1u - index);
                value = ((63 - offset) * corner + (offset + 1) * intraReference[0] + 32) >> 6u;
            } else if (index > 2u * size && index < 4u * size) {
                let offset = i32(index - 2u * size - 1u);
                value = ((63 - offset) * corner + (offset + 1) * intraReference[4u * size] + 32) >> 6u;
            }
        } else if (smoothing && index > 0u && index < 4u * size) {
            value = (intraReference[index - 1u] + 2 * value + intraReference[index + 1u] + 2) >> 2u;
        }
        intraFiltered[index] = value;
    }
    workgroupBarrier();
    let boundaryFilters = plane == 0u && size < 32u;
    let maximum = (1 << bitDepth) - 1;
    let wordsPerRow = size / SAMPLES_PER_WORD;
    var dc = 0;
    if (mode == INTRA_DC) {
        dc = i32(size);
        for (var index = 0u; index < size; index += 1u) {
            dc += intraLeft(i32(index), size) + intraTop(i32(index), size);
        }
        dc >>= log2Size + 1u;
    }
    for (var word = lane; word < size * wordsPerRow; word += RECONSTRUCTION_WORKGROUP_SIZE) {
        let y = word / wordsPerRow;
        let firstX = (word % wordsPerRow) * SAMPLES_PER_WORD;
        var samples = vec4u(0u);
        for (var sampleLane = 0u; sampleLane < SAMPLES_PER_WORD; sampleLane += 1u) {
            let x = firstX + sampleLane;
            var prediction = 0;
            if (mode == INTRA_PLANAR) {
                prediction = (i32(size - 1u - x) * intraLeft(i32(y), size) + i32(x + 1u) * intraTop(i32(size), size)
                    + i32(size - 1u - y) * intraTop(i32(x), size) + i32(y + 1u) * intraLeft(i32(size), size) + i32(size)) >> (log2Size + 1u);
            } else if (mode == INTRA_DC) {
                prediction = dc;
                if (boundaryFilters) {
                    if (x == 0u && y == 0u) {
                        prediction = (intraLeft(0, size) + 2 * dc + intraTop(0, size) + 2) >> 2u;
                    } else if (y == 0u) {
                        prediction = (intraTop(i32(x), size) + 3 * dc + 2) >> 2u;
                    } else if (x == 0u) {
                        prediction = (intraLeft(i32(y), size) + 3 * dc + 2) >> 2u;
                    }
                }
            } else {
                prediction = predictAngularSample(mode, x, y, size, boundaryFilters, maximum);
            }
            let value = prediction + readResidual(plane, blockX + x, blockY + y);
            samples[sampleLane] = u32(clamp(value, 0, maximum));
        }
        writePictureWord(plane, blockX + firstX, blockY + y, samples);
    }
    storageBarrier();
    workgroupBarrier();
}

// refMain of the angular modes: the main side, extended by projecting the other side for negative angles
fn intraMainReference(vertical: bool, index: i32, size: u32, angle: i32, mode: u32) -> i32 {
    if (index >= 0) {
        if (vertical) {
            return intraTop(index - 1, size);
        }
        return intraLeft(index - 1, size);
    }
    let projected = -1 + ((index * inverseAngles[mode - 11u] + 128) >> 8u);
    if (vertical) {
        return intraLeft(projected, size);
    }
    return intraTop(projected, size);
}

fn predictAngularSample(mode: u32, x: u32, y: u32, size: u32, boundaryFilters: bool, maximum: i32) -> i32 {
    let angle = intraPredictionAngles[mode - 2u];
    let vertical = mode >= 18u;
    // Along the main direction: x for vertical modes, y for horizontal ones
    let along = select(y, x, !vertical);
    let across = select(x, y, !vertical);
    let position = i32(along + 1u) * angle;
    let index = position >> 5u;
    let fraction = position & 31;
    var prediction = 0;
    if (fraction != 0) {
        prediction = ((32 - fraction) * intraMainReference(vertical, i32(across) + index + 1, size, angle, mode)
            + fraction * intraMainReference(vertical, i32(across) + index + 2, size, angle, mode) + 16) >> 5u;
    } else {
        prediction = intraMainReference(vertical, i32(across) + index + 1, size, angle, mode);
    }
    if (boundaryFilters) {
        if (mode == INTRA_ANGULAR_26 && x == 0u) {
            prediction = clamp(intraTop(0, size) + ((intraLeft(i32(y), size) - intraLeft(-1, size)) >> 1u), 0, maximum);
        } else if (mode == INTRA_ANGULAR_10 && y == 0u) {
            prediction = clamp(intraLeft(0, size) + ((intraTop(i32(x), size) - intraTop(-1, size)) >> 1u), 0, maximum);
        }
    }
    return prediction;
}

// WGSL of the HEVC decoder's in-loop filters: deblocking (8.7.2) and SAO (8.7.3).
// Deblocking filters every vertical edge of the picture in one pass and every horizontal edge in the next, in place;
// each invocation owns the words its edge segment touches. SAO reads a copy of the deblocked picture and writes the output slot.
// FFmpeg's libavcodec/hevc (filter.c, dsp_template.c) and h26x templates are the behavioral reference.
const tcTable = array<i32, 54>(
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4,
    5, 5, 6, 6, 7, 8, 9, 10, 11, 13, 14, 16, 18, 20, 22, 24
);

const betaTable = array<i32, 52>(
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 7, 8,
    9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36,
    38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62, 64
);

// QpC of 4:2:0 chroma for qPi 30 to 43 (Table 8-10)
const chromaQpTable = array<i32, 14>(29, 30, 31, 32, 33, 33, 34, 34, 35, 35, 36, 36, 37, 37);

const saoEdgeIndex = array<u32, 5>(1u, 2u, 0u, 3u, 4u);
const saoNeighbourX = array<i32, 8>(-1, 1, 0, 0, -1, 1, 1, -1);
const saoNeighbourY = array<i32, 8>(0, 0, -1, 1, -1, 1, -1, 1);

fn isIntraBlock(fields: u32) -> bool {
    return blockPredFlags(fields) == 0u;
}

fn sliceReferencePoc(slice: u32, list: u32, fields: u32) -> i32 {
    return referencePoc(slice, list, blockRefIdx(fields, list));
}

fn isLargeMotionDifference(first: vec2i, second: vec2i) -> bool {
    return abs(first.x - second.x) >= 4 || abs(first.y - second.y) >= 4;
}

// The motion-based boundary strength of FFmpeg's boundary_strength, Q being the current block and P its neighbour
fn motionBoundaryStrength(xP: u32, yP: u32, pSlice: u32, xQ: u32, yQ: u32, qSlice: u32) -> u32 {
    let pFields = blockFields(xP, yP);
    let qFields = blockFields(xQ, yQ);
    let pFlags = blockPredFlags(pFields);
    let qFlags = blockPredFlags(qFields);
    let p0 = blockMotionVector(xP, yP, 0u);
    let p1 = blockMotionVector(xP, yP, 1u);
    let q0 = blockMotionVector(xQ, yQ, 0u);
    let q1 = blockMotionVector(xQ, yQ, 1u);
    if (qFlags == PRED_BI && pFlags == PRED_BI) {
        let qRef0 = sliceReferencePoc(qSlice, 0u, qFields);
        let qRef1 = sliceReferencePoc(qSlice, 1u, qFields);
        let pRef0 = sliceReferencePoc(pSlice, 0u, pFields);
        let pRef1 = sliceReferencePoc(pSlice, 1u, pFields);
        if (qRef0 == pRef0 && qRef0 == qRef1 && pRef0 == pRef1) {
            let straight = isLargeMotionDifference(p0, q0) || isLargeMotionDifference(p1, q1);
            let crossed = isLargeMotionDifference(p1, q0) || isLargeMotionDifference(p0, q1);
            return select(0u, 1u, straight && crossed);
        }
        if (pRef0 == qRef0 && pRef1 == qRef1) {
            return select(0u, 1u, isLargeMotionDifference(p0, q0) || isLargeMotionDifference(p1, q1));
        }
        if (pRef1 == qRef0 && pRef0 == qRef1) {
            return select(0u, 1u, isLargeMotionDifference(p1, q0) || isLargeMotionDifference(p0, q1));
        }
        return 1u;
    }
    if (qFlags != PRED_BI && pFlags != PRED_BI) {
        let qList = select(1u, 0u, (qFlags & PRED_L0) != 0u);
        let pList = select(1u, 0u, (pFlags & PRED_L0) != 0u);
        let qVector = select(q1, q0, qList == 0u);
        let pVector = select(p1, p0, pList == 0u);
        if (sliceReferencePoc(qSlice, qList, qFields) == sliceReferencePoc(pSlice, pList, pFields)) {
            return select(0u, 1u, isLargeMotionDifference(qVector, pVector));
        }
        return 1u;
    }
    return 1u;
}

// bS of the edge segment whose first Q sample is at luma (xQ, yQ), as FFmpeg's ff_hevc_deblocking_boundary_strengths sets it
fn edgeBoundaryStrength(xQ: u32, yQ: u32, vertical: bool) -> u32 {
    let xP = select(xQ, xQ - 1u, vertical);
    let yP = select(yQ - 1u, yQ, vertical);
    let qCtb = ctbAddressOf(xQ, yQ);
    let pCtb = ctbAddressOf(xP, yP);
    let qSlice = ctbSlice(qCtb);
    let pSlice = ctbSlice(pCtb);
    if (sliceValue(qSlice, RECORD_SLICE_DEBLOCKING_DISABLED) == 1u) {
        return 0u;
    }
    let qFields = blockFields(xQ, yQ);
    let pFields = blockFields(xP, yP);
    let transformEdge = (qFields & select(BLOCK_EDGE_TOP_BIT, BLOCK_EDGE_LEFT_BIT, vertical)) != 0u;
    if (transformEdge) {
        if (pCtb != qCtb) {
            if (sliceValue(qSlice, RECORD_SLICE_ADDRESS_RS) != sliceValue(pSlice, RECORD_SLICE_ADDRESS_RS)
                && sliceValue(qSlice, RECORD_SLICE_LOOP_FILTER_ACROSS_SLICES) == 0u) {
                return 0u;
            }
            if (pictureValue(P_LOOP_FILTER_ACROSS_TILES) == 0u
                && tileIdOfTs(ctbAddressRsToTs(pCtb)) != tileIdOfTs(ctbAddressRsToTs(qCtb))) {
                return 0u;
            }
        }
        if (isIntraBlock(qFields) || isIntraBlock(pFields)) {
            return 2u;
        }
        if ((qFields & BLOCK_CBF_BIT) != 0u || (pFields & BLOCK_CBF_BIT) != 0u) {
            return 1u;
        }
        return motionBoundaryStrength(xP, yP, pSlice, xQ, yQ, qSlice);
    }
    // An edge inside a transform block: only prediction block edges of inter blocks filter
    if (isIntraBlock(qFields)) {
        return 0u;
    }
    return motionBoundaryStrength(xP, yP, pSlice, xQ, yQ, qSlice);
}

// The sample at distance offset across the edge on line line: negative offsets are on the P side
fn edgeSamplePosition(edgeX: u32, edgeY: u32, vertical: bool, line: u32, offset: i32) -> vec2u {
    if (vertical) {
        return vec2u(u32(i32(edgeX) + offset), edgeY + line);
    }
    return vec2u(edgeX + line, u32(i32(edgeY) + offset));
}

fn readEdgeSample(plane: u32, edgeX: u32, edgeY: u32, vertical: bool, line: u32, offset: i32) -> i32 {
    let position = edgeSamplePosition(edgeX, edgeY, vertical, line, offset);
    return i32(readPictureSample(plane, position.x, position.y));
}

fn writeEdgeSample(plane: u32, edgeX: u32, edgeY: u32, vertical: bool, line: u32, offset: i32, value: i32, bitDepth: u32) {
    let position = edgeSamplePosition(edgeX, edgeY, vertical, line, offset);
    writePictureSample(plane, position.x, position.y, clipToBitDepth(value, bitDepth));
}

// Filters one 4-line luma edge segment (8.7.2.5.3, 8.7.2.5.6, 8.7.2.5.7)
fn filterLumaSegment(edgeX: u32, edgeY: u32, vertical: bool) {
    let bs = edgeBoundaryStrength(edgeX, edgeY, vertical);
    if (bs == 0u) {
        return;
    }
    let xP = select(edgeX, edgeX - 1u, vertical);
    let yP = select(edgeY - 1u, edgeY, vertical);
    let qSlice = ctbSlice(ctbAddressOf(edgeX, edgeY));
    let qp = (blockQp(edgeX, edgeY) + blockQp(xP, yP) + 1) >> 1u;
    let bitDepth = bitDepthLuma;
    let scale = 1 << (bitDepth - 8u);
    let beta = betaTable[clamp(qp + sliceSignedValue(qSlice, RECORD_SLICE_BETA_OFFSET), 0, 51)] * scale;
    let tc = tcTable[clamp(qp + 2 * (i32(bs) - 1) + sliceSignedValue(qSlice, RECORD_SLICE_TC_OFFSET), 0, 53)] * scale;
    let noP = (blockFields(xP, yP) & BLOCK_BYPASS_BIT) != 0u;
    let noQ = (blockFields(edgeX, edgeY) & BLOCK_BYPASS_BIT) != 0u;
    // Decisions from lines 0 and 3
    let dp0 = abs(readEdgeSample(0u, edgeX, edgeY, vertical, 0u, -3) - 2 * readEdgeSample(0u, edgeX, edgeY, vertical, 0u, -2)
        + readEdgeSample(0u, edgeX, edgeY, vertical, 0u, -1));
    let dq0 = abs(readEdgeSample(0u, edgeX, edgeY, vertical, 0u, 2) - 2 * readEdgeSample(0u, edgeX, edgeY, vertical, 0u, 1)
        + readEdgeSample(0u, edgeX, edgeY, vertical, 0u, 0));
    let dp3 = abs(readEdgeSample(0u, edgeX, edgeY, vertical, 3u, -3) - 2 * readEdgeSample(0u, edgeX, edgeY, vertical, 3u, -2)
        + readEdgeSample(0u, edgeX, edgeY, vertical, 3u, -1));
    let dq3 = abs(readEdgeSample(0u, edgeX, edgeY, vertical, 3u, 2) - 2 * readEdgeSample(0u, edgeX, edgeY, vertical, 3u, 1)
        + readEdgeSample(0u, edgeX, edgeY, vertical, 3u, 0));
    let d0 = dp0 + dq0;
    let d3 = dp3 + dq3;
    if (d0 + d3 >= beta) {
        return;
    }
    let tc25 = (tc * 5 + 1) >> 1u;
    var strong = (d0 << 1u) < (beta >> 2u) && (d3 << 1u) < (beta >> 2u);
    for (var line = 0u; line < 4u && strong; line += 3u) {
        let p3 = readEdgeSample(0u, edgeX, edgeY, vertical, line, -4);
        let p0 = readEdgeSample(0u, edgeX, edgeY, vertical, line, -1);
        let q0 = readEdgeSample(0u, edgeX, edgeY, vertical, line, 0);
        let q3 = readEdgeSample(0u, edgeX, edgeY, vertical, line, 3);
        strong = abs(p3 - p0) + abs(q3 - q0) < (beta >> 3u) && abs(p0 - q0) < tc25;
    }
    let sideThreshold = (beta + (beta >> 1u)) >> 3u;
    let extendP = dp0 + dp3 < sideThreshold;
    let extendQ = dq0 + dq3 < sideThreshold;
    for (var line = 0u; line < 4u; line += 1u) {
        let p3 = readEdgeSample(0u, edgeX, edgeY, vertical, line, -4);
        let p2 = readEdgeSample(0u, edgeX, edgeY, vertical, line, -3);
        let p1 = readEdgeSample(0u, edgeX, edgeY, vertical, line, -2);
        let p0 = readEdgeSample(0u, edgeX, edgeY, vertical, line, -1);
        let q0 = readEdgeSample(0u, edgeX, edgeY, vertical, line, 0);
        let q1 = readEdgeSample(0u, edgeX, edgeY, vertical, line, 1);
        let q2 = readEdgeSample(0u, edgeX, edgeY, vertical, line, 2);
        let q3 = readEdgeSample(0u, edgeX, edgeY, vertical, line, 3);
        if (strong) {
            let tc2 = 2 * tc;
            if (!noP) {
                writeEdgeSample(0u, edgeX, edgeY, vertical, line, -1, p0 + clamp(((p2 + 2 * p1 + 2 * p0 + 2 * q0 + q1 + 4) >> 3u) - p0, -tc2, tc2), bitDepth);
                writeEdgeSample(0u, edgeX, edgeY, vertical, line, -2, p1 + clamp(((p2 + p1 + p0 + q0 + 2) >> 2u) - p1, -tc2, tc2), bitDepth);
                writeEdgeSample(0u, edgeX, edgeY, vertical, line, -3, p2 + clamp(((2 * p3 + 3 * p2 + p1 + p0 + q0 + 4) >> 3u) - p2, -tc2, tc2), bitDepth);
            }
            if (!noQ) {
                writeEdgeSample(0u, edgeX, edgeY, vertical, line, 0, q0 + clamp(((p1 + 2 * p0 + 2 * q0 + 2 * q1 + q2 + 4) >> 3u) - q0, -tc2, tc2), bitDepth);
                writeEdgeSample(0u, edgeX, edgeY, vertical, line, 1, q1 + clamp(((p0 + q0 + q1 + q2 + 2) >> 2u) - q1, -tc2, tc2), bitDepth);
                writeEdgeSample(0u, edgeX, edgeY, vertical, line, 2, q2 + clamp(((2 * q3 + 3 * q2 + q1 + q0 + p0 + 4) >> 3u) - q2, -tc2, tc2), bitDepth);
            }
            continue;
        }
        var delta = (9 * (q0 - p0) - 3 * (q1 - p1) + 8) >> 4u;
        if (abs(delta) >= tc * 10) {
            continue;
        }
        delta = clamp(delta, -tc, tc);
        let halfTc = tc >> 1u;
        if (!noP) {
            writeEdgeSample(0u, edgeX, edgeY, vertical, line, -1, p0 + delta, bitDepth);
            if (extendP) {
                writeEdgeSample(0u, edgeX, edgeY, vertical, line, -2, p1 + clamp((((p2 + p0 + 1) >> 1u) - p1 + delta) >> 1u, -halfTc, halfTc), bitDepth);
            }
        }
        if (!noQ) {
            writeEdgeSample(0u, edgeX, edgeY, vertical, line, 0, q0 - delta, bitDepth);
            if (extendQ) {
                writeEdgeSample(0u, edgeX, edgeY, vertical, line, 1, q1 + clamp((((q2 + q0 + 1) >> 1u) - q1 - delta) >> 1u, -halfTc, halfTc), bitDepth);
            }
        }
    }
}

// Filters one 4-line chroma edge segment at chroma (edgeX, edgeY) (8.7.2.5.5)
fn filterChromaSegment(plane: u32, edgeX: u32, edgeY: u32, vertical: bool) {
    let lumaX = edgeX << horizontalShift;
    let lumaY = edgeY << verticalShift;
    if (edgeBoundaryStrength(lumaX, lumaY, vertical) != 2u) {
        return;
    }
    let xP = select(lumaX, lumaX - 1u, vertical);
    let yP = select(lumaY - 1u, lumaY, vertical);
    let qSlice = ctbSlice(ctbAddressOf(lumaX, lumaY));
    let qp = (blockQp(lumaX, lumaY) + blockQp(xP, yP) + 1) >> 1u;
    let offset = select(pictureSignedValue(P_CR_QP_OFFSET), pictureSignedValue(P_CB_QP_OFFSET), plane == 1u);
    let qpi = clamp(qp + offset, 0, 57);
    var chromaQp = min(qpi, 51);
    if (chromaFormat == 1u) {
        if (qpi < 30) {
            chromaQp = qpi;
        } else if (qpi > 43) {
            chromaQp = qpi - 6;
        } else {
            chromaQp = chromaQpTable[qpi - 30];
        }
    }
    let bitDepth = bitDepthChroma;
    let tc = tcTable[clamp(chromaQp + 2 + sliceSignedValue(qSlice, RECORD_SLICE_TC_OFFSET), 0, 53)] * (1 << (bitDepth - 8u));
    if (tc <= 0) {
        return;
    }
    let noP = (blockFields(xP, yP) & BLOCK_BYPASS_BIT) != 0u;
    let noQ = (blockFields(lumaX, lumaY) & BLOCK_BYPASS_BIT) != 0u;
    for (var line = 0u; line < 4u; line += 1u) {
        let p1 = readEdgeSample(plane, edgeX, edgeY, vertical, line, -2);
        let p0 = readEdgeSample(plane, edgeX, edgeY, vertical, line, -1);
        let q0 = readEdgeSample(plane, edgeX, edgeY, vertical, line, 0);
        let q1 = readEdgeSample(plane, edgeX, edgeY, vertical, line, 1);
        let delta = clamp((((q0 - p0) * 4) + p1 - q1 + 4) >> 3u, -tc, tc);
        if (!noP) {
            writeEdgeSample(plane, edgeX, edgeY, vertical, line, -1, p0 + delta, bitDepth);
        }
        if (!noQ) {
            writeEdgeSample(plane, edgeX, edgeY, vertical, line, 0, q0 - delta, bitDepth);
        }
    }
}

fn deblockSegment(plane: u32, edgeX: u32, edgeY: u32, vertical: bool) {
    if (plane == 0u) {
        filterLumaSegment(edgeX, edgeY, vertical);
    } else {
        filterChromaSegment(plane, edgeX, edgeY, vertical);
    }
}

// Vertical edges: x is a multiple of 8 in the plane, each invocation one segment of 4 rows
@compute @workgroup_size(8, 8)
fn deblockVertical(@builtin(global_invocation_id) invocation: vec3u) {
    if (pictureState[F_VALID] == 0u || pictureValue(P_DEBLOCKING_ANY) == 0u) {
        return;
    }
    loadPictureGeometry();
    let plane = invocation.z;
    if (plane > 0u && chromaFormat == 0u) {
        return;
    }
    let edgeX = invocation.x * 8u;
    let edgeY = invocation.y * 4u;
    if (edgeX == 0u || edgeX >= planeWidth(plane) || edgeY >= planeHeight(plane)) {
        return;
    }
    deblockSegment(plane, edgeX, edgeY, true);
}

// Horizontal edges: y is a multiple of 8 in the plane, each invocation one segment of 4 columns
@compute @workgroup_size(8, 8)
fn deblockHorizontal(@builtin(global_invocation_id) invocation: vec3u) {
    if (pictureState[F_VALID] == 0u || pictureValue(P_DEBLOCKING_ANY) == 0u) {
        return;
    }
    loadPictureGeometry();
    let plane = invocation.z;
    if (plane > 0u && chromaFormat == 0u) {
        return;
    }
    let edgeX = invocation.x * 4u;
    let edgeY = invocation.y * 8u;
    if (edgeY == 0u || edgeX >= planeWidth(plane) || edgeY >= planeHeight(plane)) {
        return;
    }
    deblockSegment(plane, edgeX, edgeY, false);
}

// SAO reads the deblocked picture from a tightly packed copy
fn saoSourceBase(plane: u32) -> u32 {
    switch (plane) {
        case 0u: {
            return F_SAO_SOURCE;
        }
        case 1u: {
            return pictureValue(P_SAO_CB_BASE);
        }
        default: {
            return pictureValue(P_SAO_CR_BASE);
        }
    }
}

fn saoRowWords(plane: u32) -> u32 {
    return select(pictureValue(P_SAO_ROW_WORDS_CHROMA), pictureValue(P_SAO_ROW_WORDS_LUMA), plane == 0u);
}

fn readSaoSource(plane: u32, x: u32, y: u32) -> i32 {
    let word = pictureState[saoSourceBase(plane) + y * saoRowWords(plane) + x / SAMPLES_PER_WORD];
    return i32((word >> ((x % SAMPLES_PER_WORD) * SAMPLE_BYTES * 8u)) & SAMPLE_MASK);
}

@compute @workgroup_size(8, 8)
fn copySaoSource(@builtin(global_invocation_id) invocation: vec3u) {
    if (pictureState[F_VALID] == 0u || pictureValue(P_SAO_ANY) == 0u) {
        return;
    }
    loadPictureGeometry();
    let plane = invocation.z;
    if (plane > 0u && chromaFormat == 0u) {
        return;
    }
    let x = invocation.x * SAMPLES_PER_WORD;
    let y = invocation.y;
    if (x >= planeWidth(plane) || y >= planeHeight(plane)) {
        return;
    }
    let byteAddress = getSampleByteAddress(packet.outputSlot, plane, x, y);
    pictureState[saoSourceBase(plane) + y * saoRowWords(plane) + invocation.x] = framePool[byteAddress >> 2u];
}

// Whether SAO may use the neighbour at plane (neighbourX, neighbourY) for the sample at (x, y) (8.7.3.2)
fn isSaoNeighbourUsable(plane: u32, x: u32, y: u32, neighbourX: i32, neighbourY: i32) -> bool {
    if (neighbourX < 0 || neighbourY < 0 || u32(neighbourX) >= planeWidth(plane) || u32(neighbourY) >= planeHeight(plane)) {
        return false;
    }
    let lumaX = x << planeHorizontalShift(plane);
    let lumaY = y << planeVerticalShift(plane);
    let neighbourLumaX = u32(neighbourX) << planeHorizontalShift(plane);
    let neighbourLumaY = u32(neighbourY) << planeVerticalShift(plane);
    let currentCtb = ctbAddressOf(lumaX, lumaY);
    let neighbourCtb = ctbAddressOf(neighbourLumaX, neighbourLumaY);
    if (currentCtb == neighbourCtb) {
        return true;
    }
    let currentSlice = ctbSlice(currentCtb);
    let neighbourSlice = ctbSlice(neighbourCtb);
    if (sliceValue(currentSlice, RECORD_SLICE_ADDRESS_RS) != sliceValue(neighbourSlice, RECORD_SLICE_ADDRESS_RS)) {
        let neighbourFirst = minTbAddressZs(neighbourLumaX, neighbourLumaY) < minTbAddressZs(lumaX, lumaY);
        if (neighbourFirst && sliceValue(currentSlice, RECORD_SLICE_LOOP_FILTER_ACROSS_SLICES) == 0u) {
            return false;
        }
        if (!neighbourFirst && sliceValue(neighbourSlice, RECORD_SLICE_LOOP_FILTER_ACROSS_SLICES) == 0u) {
            return false;
        }
    }
    if (pictureValue(P_LOOP_FILTER_ACROSS_TILES) == 0u
        && tileIdOfTs(ctbAddressRsToTs(currentCtb)) != tileIdOfTs(ctbAddressRsToTs(neighbourCtb))) {
        return false;
    }
    return true;
}

fn saoOffset(packedOffsets: u32, index: u32) -> i32 {
    return (bitcast<i32>(packedOffsets << (24u - index * 8u))) >> 24u;
}

@compute @workgroup_size(8, 8)
fn applySao(@builtin(global_invocation_id) invocation: vec3u) {
    if (pictureState[F_VALID] == 0u) {
        return;
    }
    loadPictureGeometry();
    let plane = invocation.z;
    let x0 = invocation.x * SAMPLES_PER_WORD;
    let y = invocation.y;
    // A monochrome picture presents mid-gray chroma
    if (plane > 0u && chromaFormat == 0u) {
        if (x0 < stream.planes[plane].width && y < stream.planes[plane].height) {
            let gray = 1u << (bitDepthLuma - 1u);
            writePictureWord(plane, x0, y, vec4u(gray));
        }
        return;
    }
    if (pictureValue(P_SAO_ANY) == 0u || x0 >= planeWidth(plane) || y >= planeHeight(plane)) {
        return;
    }
    let shiftX = planeHorizontalShift(plane);
    let shiftY = planeVerticalShift(plane);
    let ctbAddress = ctbAddressOf(x0 << shiftX, y << shiftY);
    let typeWord = ctbValue(ctbAddress, RECORD_CTB_SAO_LUMA_TYPE + plane * 2u);
    let saoType = typeWord & 3u;
    if (saoType == RECORD_SAO_NOT_APPLIED) {
        return;
    }
    let position = (typeWord >> RECORD_SAO_POSITION_SHIFT) & 31u;
    let packedOffsets = ctbValue(ctbAddress, RECORD_CTB_SAO_LUMA_TYPE + plane * 2u + 1u);
    let bitDepth = planeBitDepth(plane);
    let width = planeWidth(plane);
    var samples = vec4u(0u);
    for (var lane = 0u; lane < SAMPLES_PER_WORD; lane += 1u) {
        let x = x0 + lane;
        if (x >= width) {
            samples[lane] = readPictureSample(plane, min(x, stream.planes[plane].width - 1u), y);
            continue;
        }
        let value = readSaoSource(plane, x, y);
        var result = value;
        let bypass = (blockFields(x << shiftX, y << shiftY) & BLOCK_BYPASS_BIT) != 0u;
        if (!bypass) {
            if (saoType == RECORD_SAO_BAND) {
                let band = (u32(value) >> (bitDepth - 5u)) & 31u;
                let index = (band - position) & 31u;
                if (index < 4u) {
                    result = value + saoOffset(packedOffsets, index);
                }
            } else {
                let firstX = i32(x) + saoNeighbourX[position * 2u];
                let firstY = i32(y) + saoNeighbourY[position * 2u];
                let secondX = i32(x) + saoNeighbourX[position * 2u + 1u];
                let secondY = i32(y) + saoNeighbourY[position * 2u + 1u];
                if (isSaoNeighbourUsable(plane, x, y, firstX, firstY) && isSaoNeighbourUsable(plane, x, y, secondX, secondY)) {
                    let first = readSaoSource(plane, u32(firstX), u32(firstY));
                    let second = readSaoSource(plane, u32(secondX), u32(secondY));
                    let edge = saoEdgeIndex[u32(2 + sign(value - first) + sign(value - second))];
                    if (edge != 0u) {
                        result = value + saoOffset(packedOffsets, edge - 1u);
                    }
                }
            }
        }
        samples[lane] = clipToBitDepth(result, bitDepth);
    }
    writePictureWord(plane, x0, y, samples);
}
