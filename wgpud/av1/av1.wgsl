//! name: AV1
//! id: av1
//! decoder: video
//! accepts: codec in [av1], picture.width <= 16384, picture.height <= 8704, picture.width * picture.height <= 35651584
//! output: I420, I420P10, I420P12, I422, I422P10, I422P12, I444, I444P10, I444P12
//! monochrome: yes
//! parser: 2
//! references: 0
//! reorder: 0
//! packet: max(67108864, min(536870912, stream.width * stream.height * (11 + (1 + 2 / (output.chromaWidthDivisor * output.chromaHeightDivisor)) * (7 + (output.bitDepth + 8) / 2)) / 4 + stream.width * stream.height / 32 + 65536))
//! state: 1 KiB
//! buffer: frames, 10 * stream.width * stream.height * (1 + 2 / (output.chromaWidthDivisor * output.chromaHeightDivisor))
//! buffer: framesHigh, 10 * stream.width * stream.height * (1 + 2 / (output.chromaWidthDivisor * output.chromaHeightDivisor))
//! buffer: frameData, stream.width * stream.height / 4 + 24 * (ceil(stream.height / 64) + 2) * stream.width + 655360
//! error: 1, configuration
//! error: 2, bitstreamCorrupt, resync
//! error: 3, bitstreamUnsupported
//! error: 4, parserMemory
//! error: 5, parserError, resync
//! error: 6, recordSize
//! error: 7, pictureSize
//! error: 8, streamFormat
//! error: 9, recordInvalid
//! error: 10, referenceInvalid, resync
//! error: 11, frameBuffers
//! dispatch: loadTables, 64
//! dispatch: beginFrame, 1
//! dispatch: fillNeutralReferences, ceil(stream.width / 128), stream.height, 3
//! dispatch: clearResiduals, ceil(stream.width / 128), stream.height, 3
//! dispatch: expandBlocks, ceil(stream.width * stream.height / 16384)
//! dispatch: predictInter, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: inverseTransform, ceil(stream.width * stream.height / 4096)
//! dispatch: inverseTransformLarge, ceil(stream.width * stream.height / 4096)
//! repeat: ceil((ceil(stream.width / 64) + 5 * ceil(stream.height / 64)) / 2), 2
//! dispatch: predictIntra, ceil(stream.height / 64), 4, 3
//! dispatch: predictIntra, ceil(stream.height / 64), 5, 3
//! dispatch: deblockVertical, ceil(stream.width / 64), ceil(stream.height / 64), 3
//! dispatch: deblockHorizontal, ceil(stream.width / 64), ceil(stream.height / 64), 3
//! dispatch: saveRestorationBoundaries, ceil(stream.width / 256), ceil(stream.height / 64) + 1, 3
//! dispatch: applyCdef, ceil(stream.width / 64), ceil(stream.height / 64), 3
//! dispatch: applySuperres, ceil(stream.width / 256), ceil(stream.height / 16), 3
//! dispatch: applyLoopRestoration, ceil(stream.width / 64), ceil(stream.height / 64), 3
//! dispatch: generateFilmGrain, 1
//! dispatch: writeOutput, ceil(stream.width / 128), stream.height, 3

// The AV1 decoder: Main, High, and Professional profile streams at 8, 10, and 12 bits, 4:0:0, 4:2:0, 4:2:2, and 4:4:4, in compute shaders.
// Its packets are the GPU records its parser (parser/, libaom's decoder running its parse-only pass) makes of each frame, hidden frames
// and show_existing_frame included, so these passes predict, reconstruct, filter, and output a frame from its record.
// The package's WGSL is this file followed by the family files decoder.json lists, concatenated in order: wgsl/transform.wgsl,
// wgsl/intra.wgsl, wgsl/inter.wgsl, and wgsl/filters.wgsl. This file owns the header, the record layout, the frame store, the
// helpers every family shares, and the entry points; each entry point calls its family's functions, which scratch/av1/DESIGN.md specifies.
// References live in the frame store, the frames and framesHigh buffers: ten frame buffers the parser assigns, which the record
// names by index, so the frame pool only receives the shown frames, with film grain applied.
// The parser reports each picture's wave pairs, so the intra wavefront runs only the waves that hold jobs.

// The GPU record of one frame: its magic and version, its limits, and the word offsets of its fields.
// parser/record_layout.mjs reads these RECORD_ declarations and the ERROR_ codes below into a C header, so the parser and the passes share one layout.
// Enumerated values (block and transform sizes, transform types, prediction modes, filters, motion modes) are libaom's.
const RECORD_MAGIC: u32 = 1378965057u;
const RECORD_VERSION: u32 = 2u;
const RECORD_MISSING: u32 = 4294967295u;
const RECORD_KIND_DECODE: u32 = 0u;
const RECORD_KIND_SHOW_EXISTING: u32 = 1u;
const RECORD_MAXIMUM_WIDTH: u32 = 16384u;
const RECORD_MAXIMUM_HEIGHT: u32 = 8704u;
const RECORD_MAXIMUM_AREA: u32 = 35651584u;
const RECORD_FRAME_BUFFERS: u32 = 10u;
// The frame buffers the frames buffer holds; framesHigh holds the rest, so neither binding holds more than half of the frame store
const RECORD_FRAME_BUFFERS_LOW: u32 = 5u;
const RECORD_REFERENCES: u32 = 7u;
const RECORD_PLANES: u32 = 3u;
const RECORD_MAXIMUM_TILE_COLUMNS: u32 = 64u;
const RECORD_MAXIMUM_TILE_ROWS: u32 = 64u;
const RECORD_CDEF_STRENGTHS: u32 = 8u;

// The packet bound, a record's worst case for a pool of stream.width x stream.height, which the header's packet line spells out and
// parser/record_layout.mjs checks against these: per 4x4 luma unit, RECORD_PACKET_UNIT_WORDS for a 4x4 block and its side data
// (4 block words, 3 motion words, and 4 variable transform words, more than an 8x8 palette or warp takes per unit); per 4x4 unit of
// each plane, RECORD_PACKET_PLANE_UNIT_WORDS for an intra job (3), a transform job (3), and its payload's partial last word (1), and
// 16 coefficients of bit depth + RECORD_PACKET_COEFFICIENT_BIT_BIAS bits, libaom's dequantized range; one byte per
// RECORD_PACKET_MARGIN_SAMPLES luma samples and RECORD_PACKET_MARGIN_BYTES for the superblocks, restoration units, and header;
// all of it at least RECORD_PACKET_MINIMUM_BYTES, the bound before level 6, and at most RECORD_PACKET_MAXIMUM_BYTES, the engine's
// largest packet. The parser judges each record against the bound of its frame's size rounded up to 64, never above its session's
const RECORD_PACKET_UNIT_WORDS: u32 = 11u;
const RECORD_PACKET_PLANE_UNIT_WORDS: u32 = 7u;
const RECORD_PACKET_COEFFICIENT_BIT_BIAS: u32 = 8u;
const RECORD_PACKET_MARGIN_SAMPLES: u32 = 32u;
const RECORD_PACKET_MARGIN_BYTES: u32 = 65536u;
const RECORD_PACKET_MINIMUM_BYTES: u32 = 67108864u;
const RECORD_PACKET_MAXIMUM_BYTES: u32 = 536870912u;

// Header words
const RECORD_HEADER_MAGIC: u32 = 0u;
const RECORD_HEADER_VERSION: u32 = 1u;
const RECORD_HEADER_KIND: u32 = 2u;
const RECORD_HEADER_FLAGS: u32 = 3u;
const RECORD_HEADER_PICTURE_INDEX: u32 = 4u;
const RECORD_HEADER_FRAME_TYPE: u32 = 5u;
const RECORD_HEADER_FRAME_WIDTH: u32 = 6u;
const RECORD_HEADER_FRAME_HEIGHT: u32 = 7u;
const RECORD_HEADER_UPSCALED_WIDTH: u32 = 8u;
const RECORD_HEADER_RENDER_WIDTH: u32 = 9u;
const RECORD_HEADER_RENDER_HEIGHT: u32 = 10u;
const RECORD_HEADER_BIT_DEPTH: u32 = 11u;
const RECORD_HEADER_SUBSAMPLING_X: u32 = 12u;
const RECORD_HEADER_SUBSAMPLING_Y: u32 = 13u;
const RECORD_HEADER_MI_COLUMNS: u32 = 14u;
const RECORD_HEADER_MI_ROWS: u32 = 15u;
const RECORD_HEADER_SUPERBLOCK_COLUMNS: u32 = 16u;
const RECORD_HEADER_SUPERBLOCK_ROWS: u32 = 17u;
const RECORD_HEADER_TARGET_BUFFER: u32 = 18u;
const RECORD_HEADER_SCRATCH_BUFFER: u32 = 19u;
const RECORD_HEADER_FINAL_BUFFER: u32 = 20u;
const RECORD_HEADER_OUTPUT_BUFFER: u32 = 21u;
const RECORD_HEADER_CDEF_SOURCE: u32 = 22u;
const RECORD_HEADER_CDEF_TARGET: u32 = 23u;
const RECORD_HEADER_SUPERRES_SOURCE: u32 = 24u;
const RECORD_HEADER_SUPERRES_TARGET: u32 = 25u;
const RECORD_HEADER_RESTORATION_SOURCE: u32 = 26u;
const RECORD_HEADER_RESTORATION_TARGET: u32 = 27u;
const RECORD_HEADER_NEUTRAL_FILL_MASK: u32 = 28u;
const RECORD_HEADER_SEGMENT_LOSSLESS_MASK: u32 = 29u;
const RECORD_HEADER_DEBLOCK: u32 = 30u;
const RECORD_HEADER_CDEF: u32 = 31u;
const RECORD_HEADER_CDEF_STRENGTHS: u32 = 32u;
const RECORD_HEADER_RESTORATION: u32 = 40u;
const RECORD_HEADER_SUPERRES_DENOMINATOR: u32 = 55u;
const RECORD_HEADER_TILE_COLUMNS: u32 = 56u;
const RECORD_HEADER_TILE_ROWS: u32 = 57u;
const RECORD_HEADER_TILE_COLUMN_STARTS: u32 = 58u;
const RECORD_HEADER_TILE_ROW_STARTS: u32 = 123u;
const RECORD_HEADER_WAVE_COUNT: u32 = 188u;
const RECORD_HEADER_WAVE_SLOPE: u32 = 189u;
const RECORD_HEADER_REFERENCES: u32 = 190u;
const RECORD_HEADER_GLOBAL_MOTION: u32 = 232u;
const RECORD_HEADER_FILM_GRAIN: u32 = 302u;
const RECORD_HEADER_SUPERBLOCKS: u32 = 350u;
const RECORD_HEADER_BLOCKS: u32 = 351u;
const RECORD_HEADER_BLOCK_COUNT: u32 = 352u;
const RECORD_HEADER_INTRA_JOBS: u32 = 353u;
const RECORD_HEADER_INTRA_JOB_COUNT: u32 = 354u;
const RECORD_HEADER_TRANSFORM_JOBS: u32 = 355u;
const RECORD_HEADER_TRANSFORM_JOB_COUNT: u32 = 356u;
const RECORD_HEADER_COEFFICIENTS: u32 = 357u;
const RECORD_HEADER_COEFFICIENT_WORDS: u32 = 358u;
const RECORD_HEADER_SIDE_DATA: u32 = 359u;
const RECORD_HEADER_SIDE_DATA_WORDS: u32 = 360u;
const RECORD_HEADER_RESTORATION_UNITS: u32 = 361u;
const RECORD_HEADER_RESTORATION_UNIT_COUNT: u32 = 362u;
const RECORD_HEADER_RECORD_WORDS: u32 = 363u;
const RECORD_HEADER_STATISTICS: u32 = 364u;
// The index of the first transform job with a 64-point side, or the transform job count when none has one: the parser lists those
// jobs after every other, so inverseTransform runs the jobs before it and inverseTransformLarge the rest
const RECORD_HEADER_TRANSFORM_LARGE_JOB: u32 = 380u;
const RECORD_HEADER_WORDS: u32 = 384u;

// The parser's counts for the frame, which tools and tests read and the passes ignore
const RECORD_STATISTICS_WORDS: u32 = 16u;
const RECORD_STATISTIC_BLOCKS: u32 = 0u;
const RECORD_STATISTIC_INTRA_BLOCKS: u32 = 1u;
const RECORD_STATISTIC_INTER_BLOCKS: u32 = 2u;
const RECORD_STATISTIC_INTRABC_BLOCKS: u32 = 3u;
const RECORD_STATISTIC_SKIP_BLOCKS: u32 = 4u;
const RECORD_STATISTIC_INTRA_TRANSFORM_BLOCKS: u32 = 5u;
const RECORD_STATISTIC_INTER_TRANSFORM_BLOCKS: u32 = 6u;
const RECORD_STATISTIC_CODED_TRANSFORM_BLOCKS: u32 = 7u;
const RECORD_STATISTIC_NONZERO_COEFFICIENTS: u32 = 8u;
const RECORD_STATISTIC_COEFFICIENT_CHECKSUM: u32 = 9u;
const RECORD_STATISTIC_PALETTE_BLOCKS: u32 = 10u;
const RECORD_STATISTIC_CFL_BLOCKS: u32 = 11u;
const RECORD_STATISTIC_COMPOUND_BLOCKS: u32 = 12u;
const RECORD_STATISTIC_OBMC_BLOCKS: u32 = 13u;
const RECORD_STATISTIC_WARPED_BLOCKS: u32 = 14u;
const RECORD_STATISTIC_EDGE_CHECKSUM: u32 = 15u;

// Header flag bits
const RECORD_FLAG_SHOW_FRAME: u32 = 0u;
const RECORD_FLAG_SHOWABLE_FRAME: u32 = 1u;
const RECORD_FLAG_INTRA_ONLY: u32 = 2u;
const RECORD_FLAG_ALLOW_INTRABC: u32 = 3u;
const RECORD_FLAG_SUPERBLOCK_128: u32 = 4u;
const RECORD_FLAG_MONOCHROME: u32 = 5u;
const RECORD_FLAG_INTRA_EDGE_FILTER: u32 = 6u;
const RECORD_FLAG_SUPERRES: u32 = 7u;
const RECORD_FLAG_DEBLOCK: u32 = 8u;
const RECORD_FLAG_CDEF: u32 = 9u;
const RECORD_FLAG_RESTORATION: u32 = 10u;
const RECORD_FLAG_FILM_GRAIN: u32 = 11u;
const RECORD_FLAG_CODED_LOSSLESS: u32 = 12u;
// An IntraBC or inter-intra block has a residual, which its job adds over the whole block: clearResiduals zeroes the scratch buffer
// first, since only coded transform blocks write residuals
const RECORD_FLAG_BLOCK_RESIDUALS: u32 = 13u;

// RECORD_HEADER_DEBLOCK: the planes deblocking runs on, and the sharpness
const RECORD_DEBLOCK_PLANES_SHIFT: u32 = 0u;
const RECORD_DEBLOCK_PLANES_BITS: u32 = 3u;
const RECORD_DEBLOCK_SHARPNESS_SHIFT: u32 = 8u;
const RECORD_DEBLOCK_SHARPNESS_BITS: u32 = 3u;

// RECORD_HEADER_CDEF: the damping, and the bits of a 64x64 block's strength index
const RECORD_CDEF_DAMPING_SHIFT: u32 = 0u;
const RECORD_CDEF_DAMPING_BITS: u32 = 4u;
const RECORD_CDEF_INDEX_BITS_SHIFT: u32 = 4u;
const RECORD_CDEF_INDEX_BITS_BITS: u32 = 2u;

// A CDEF strength word: luma and chroma primary and secondary strengths, secondaries as applied (0, 1, 2, or 4)
const RECORD_CDEF_LUMA_PRIMARY_SHIFT: u32 = 0u;
const RECORD_CDEF_LUMA_SECONDARY_SHIFT: u32 = 4u;
const RECORD_CDEF_CHROMA_PRIMARY_SHIFT: u32 = 8u;
const RECORD_CDEF_CHROMA_SECONDARY_SHIFT: u32 = 12u;
const RECORD_CDEF_STRENGTH_BITS: u32 = 4u;

// Per plane restoration header: frame restoration type, unit size in samples, units across and down, and the plane's first unit
const RECORD_RESTORATION_WORDS: u32 = 5u;
const RECORD_RESTORATION_TYPE: u32 = 0u;
const RECORD_RESTORATION_UNIT_SIZE: u32 = 1u;
const RECORD_RESTORATION_HORIZONTAL_UNITS: u32 = 2u;
const RECORD_RESTORATION_VERTICAL_UNITS: u32 = 3u;
const RECORD_RESTORATION_FIRST_UNIT: u32 = 4u;

// A reference, LAST_FRAME to ALTREF_FRAME: its frame buffer or RECORD_MISSING, its upscaled size, and libaom's 14-bit scale factors
const RECORD_REFERENCE_WORDS: u32 = 6u;
const RECORD_REFERENCE_BUFFER: u32 = 0u;
const RECORD_REFERENCE_WIDTH: u32 = 1u;
const RECORD_REFERENCE_HEIGHT: u32 = 2u;
const RECORD_REFERENCE_SCALE_X: u32 = 3u;
const RECORD_REFERENCE_SCALE_Y: u32 = 4u;

// A reference's global motion: type (libaom's TransformationType) and invalid bit, the six matrix entries, and the shear parameters
const RECORD_GLOBAL_MOTION_WORDS: u32 = 10u;
const RECORD_GLOBAL_MOTION_TYPE: u32 = 0u;
const RECORD_GLOBAL_MOTION_MATRIX: u32 = 1u;
const RECORD_GLOBAL_MOTION_ALPHA_BETA: u32 = 7u;
const RECORD_GLOBAL_MOTION_GAMMA_DELTA: u32 = 8u;
const RECORD_GLOBAL_MOTION_INVALID_SHIFT: u32 = 8u;

// Film grain: libaom's aom_film_grain_t, packed
const RECORD_FILM_GRAIN_WORDS: u32 = 48u;
const RECORD_FILM_GRAIN_CONTROL: u32 = 0u;
const RECORD_FILM_GRAIN_SEED: u32 = 1u;
const RECORD_FILM_GRAIN_CB: u32 = 2u;
const RECORD_FILM_GRAIN_CR: u32 = 3u;
const RECORD_FILM_GRAIN_POINTS_Y: u32 = 4u;
const RECORD_FILM_GRAIN_POINTS_CB: u32 = 11u;
const RECORD_FILM_GRAIN_POINTS_CR: u32 = 16u;
const RECORD_FILM_GRAIN_AR_Y: u32 = 21u;
const RECORD_FILM_GRAIN_AR_CB: u32 = 27u;
const RECORD_FILM_GRAIN_AR_CR: u32 = 34u;
const RECORD_FILM_GRAIN_APPLY_SHIFT: u32 = 0u;
const RECORD_FILM_GRAIN_OVERLAP_SHIFT: u32 = 1u;
const RECORD_FILM_GRAIN_CLIP_SHIFT: u32 = 2u;
const RECORD_FILM_GRAIN_CHROMA_FROM_LUMA_SHIFT: u32 = 3u;
const RECORD_FILM_GRAIN_POINTS_Y_COUNT_SHIFT: u32 = 4u;
const RECORD_FILM_GRAIN_POINTS_CB_COUNT_SHIFT: u32 = 8u;
const RECORD_FILM_GRAIN_POINTS_CR_COUNT_SHIFT: u32 = 12u;
const RECORD_FILM_GRAIN_SCALING_SHIFT_SHIFT: u32 = 16u;
const RECORD_FILM_GRAIN_AR_LAG_SHIFT: u32 = 20u;
const RECORD_FILM_GRAIN_AR_SHIFT_SHIFT: u32 = 22u;
const RECORD_FILM_GRAIN_GRAIN_SCALE_SHIFT_SHIFT: u32 = 26u;
// The sequence's matrix coefficients are identity (GBR): restricted range clips chroma to the luma range, as libaom's grain does
const RECORD_FILM_GRAIN_MC_IDENTITY_SHIFT: u32 = 28u;
const RECORD_FILM_GRAIN_MULTIPLIER_SHIFT: u32 = 0u;
const RECORD_FILM_GRAIN_LUMA_MULTIPLIER_SHIFT: u32 = 8u;
const RECORD_FILM_GRAIN_OFFSET_SHIFT: u32 = 16u;

// A superblock, in frame raster order: its luma, Cb, and Cr intra job lists, its 64x64 blocks' CDEF indices, and its tile
const RECORD_SUPERBLOCK_WORDS: u32 = 8u;
const RECORD_SUPERBLOCK_JOBS_Y: u32 = 0u;
const RECORD_SUPERBLOCK_JOB_COUNT_Y: u32 = 1u;
const RECORD_SUPERBLOCK_JOBS_U: u32 = 2u;
const RECORD_SUPERBLOCK_JOB_COUNT_U: u32 = 3u;
const RECORD_SUPERBLOCK_JOBS_V: u32 = 4u;
const RECORD_SUPERBLOCK_JOB_COUNT_V: u32 = 5u;
const RECORD_SUPERBLOCK_CDEF: u32 = 6u;
const RECORD_SUPERBLOCK_TILE: u32 = 7u;
const RECORD_SUPERBLOCK_CDEF_INDEX_BITS: u32 = 4u;
const RECORD_SUPERBLOCK_CDEF_SKIP: u32 = 15u;
const RECORD_SUPERBLOCK_TILE_ROW_SHIFT: u32 = 8u;

// A coding block, in decode order
const RECORD_BLOCK_WORDS: u32 = 4u;
const RECORD_BLOCK_POSITION: u32 = 0u;
const RECORD_BLOCK_TRANSFORM: u32 = 1u;
const RECORD_BLOCK_MODES: u32 = 2u;
const RECORD_BLOCK_EXTENSION: u32 = 3u;
const RECORD_BLOCK_MI_ROW_SHIFT: u32 = 0u;
const RECORD_BLOCK_MI_COLUMN_SHIFT: u32 = 12u;
const RECORD_BLOCK_MI_BITS: u32 = 12u;
const RECORD_BLOCK_SIZE_SHIFT: u32 = 24u;
const RECORD_BLOCK_SIZE_BITS: u32 = 5u;
const RECORD_BLOCK_INTER_SHIFT: u32 = 29u;
const RECORD_BLOCK_SKIP_SHIFT: u32 = 30u;
const RECORD_BLOCK_INTRABC_SHIFT: u32 = 31u;
const RECORD_BLOCK_TX_SIZE_SHIFT: u32 = 0u;
const RECORD_BLOCK_TX_SIZE_BITS: u32 = 5u;
const RECORD_BLOCK_SEGMENT_SHIFT: u32 = 5u;
const RECORD_BLOCK_SEGMENT_BITS: u32 = 3u;
const RECORD_BLOCK_LEVEL_Y_VERTICAL_SHIFT: u32 = 8u;
const RECORD_BLOCK_LEVEL_Y_HORIZONTAL_SHIFT: u32 = 14u;
const RECORD_BLOCK_LEVEL_U_SHIFT: u32 = 20u;
const RECORD_BLOCK_LEVEL_V_SHIFT: u32 = 26u;
const RECORD_BLOCK_LEVEL_BITS: u32 = 6u;
// Intra block modes
const RECORD_BLOCK_Y_MODE_SHIFT: u32 = 0u;
const RECORD_BLOCK_Y_MODE_BITS: u32 = 5u;
const RECORD_BLOCK_UV_MODE_SHIFT: u32 = 5u;
const RECORD_BLOCK_UV_MODE_BITS: u32 = 4u;
const RECORD_BLOCK_ANGLE_DELTA_Y_SHIFT: u32 = 9u;
const RECORD_BLOCK_ANGLE_DELTA_UV_SHIFT: u32 = 12u;
const RECORD_BLOCK_ANGLE_DELTA_BITS: u32 = 3u;
const RECORD_BLOCK_ANGLE_DELTA_BIAS: u32 = 3u;
const RECORD_BLOCK_FILTER_INTRA_SHIFT: u32 = 15u;
const RECORD_BLOCK_FILTER_INTRA_BITS: u32 = 3u;
const RECORD_BLOCK_FILTER_INTRA_NONE: u32 = 5u;
const RECORD_BLOCK_CFL_ALPHA_U_SHIFT: u32 = 18u;
const RECORD_BLOCK_CFL_ALPHA_V_SHIFT: u32 = 24u;
const RECORD_BLOCK_CFL_ALPHA_BITS: u32 = 6u;
const RECORD_BLOCK_CFL_ALPHA_BIAS: u32 = 16u;
// Inter and IntraBC block modes
const RECORD_BLOCK_REFERENCE_0_SHIFT: u32 = 0u;
const RECORD_BLOCK_REFERENCE_1_SHIFT: u32 = 4u;
const RECORD_BLOCK_REFERENCE_BITS: u32 = 4u;
const RECORD_BLOCK_REFERENCE_BIAS: u32 = 1u;
const RECORD_BLOCK_MOTION_MODE_SHIFT: u32 = 8u;
const RECORD_BLOCK_MOTION_MODE_BITS: u32 = 2u;
const RECORD_BLOCK_FILTER_X_SHIFT: u32 = 10u;
const RECORD_BLOCK_FILTER_Y_SHIFT: u32 = 12u;
const RECORD_BLOCK_FILTER_BITS: u32 = 2u;
const RECORD_BLOCK_WARP_0_SHIFT: u32 = 14u;
const RECORD_BLOCK_WARP_0_BITS: u32 = 2u;
const RECORD_BLOCK_WARP_1_SHIFT: u32 = 16u;
const RECORD_BLOCK_COMPOUND_TYPE_SHIFT: u32 = 17u;
const RECORD_BLOCK_COMPOUND_TYPE_BITS: u32 = 2u;
const RECORD_BLOCK_INTERINTRA_SHIFT: u32 = 19u;
const RECORD_BLOCK_WARP_NONE: u32 = 0u;
const RECORD_BLOCK_WARP_LOCAL: u32 = 1u;
const RECORD_BLOCK_WARP_GLOBAL: u32 = 2u;
// Extension word: the side data offset and which extensions follow there, in this order
const RECORD_BLOCK_EXTENSION_OFFSET_BITS: u32 = 24u;
const RECORD_BLOCK_HAS_MOTION_SHIFT: u32 = 24u;
const RECORD_BLOCK_HAS_LOCAL_WARP_SHIFT: u32 = 25u;
const RECORD_BLOCK_HAS_VARIABLE_TX_SHIFT: u32 = 26u;
const RECORD_BLOCK_HAS_PALETTE_SHIFT: u32 = 27u;

// Motion extension: the two motion vectors as libaom's int_mv words, then the compound word
const RECORD_MOTION_WORDS: u32 = 3u;
const RECORD_MOTION_VECTOR_0: u32 = 0u;
const RECORD_MOTION_VECTOR_1: u32 = 1u;
const RECORD_MOTION_COMPOUND: u32 = 2u;
const RECORD_MOTION_WEDGE_INDEX_SHIFT: u32 = 0u;
const RECORD_MOTION_WEDGE_INDEX_BITS: u32 = 4u;
const RECORD_MOTION_WEDGE_SIGN_SHIFT: u32 = 4u;
const RECORD_MOTION_MASK_TYPE_SHIFT: u32 = 5u;
const RECORD_MOTION_INTERINTRA_MODE_SHIFT: u32 = 6u;
const RECORD_MOTION_INTERINTRA_MODE_BITS: u32 = 2u;
const RECORD_MOTION_INTERINTRA_WEDGE_SHIFT: u32 = 8u;
const RECORD_MOTION_INTERINTRA_WEDGE_INDEX_SHIFT: u32 = 9u;
const RECORD_MOTION_DISTANCE_FORWARD_SHIFT: u32 = 13u;
const RECORD_MOTION_DISTANCE_BACKWARD_SHIFT: u32 = 17u;
const RECORD_MOTION_DISTANCE_BITS: u32 = 4u;
const RECORD_MOTION_INTER_MODE_SHIFT: u32 = 21u;
const RECORD_MOTION_INTER_MODE_BITS: u32 = 5u;

// Local warp extension: the six matrix entries, then alpha and beta, then gamma and delta, as low and high signed halves
const RECORD_LOCAL_WARP_WORDS: u32 = 8u;
const RECORD_LOCAL_WARP_MATRIX: u32 = 0u;
const RECORD_LOCAL_WARP_ALPHA_BETA: u32 = 6u;
const RECORD_LOCAL_WARP_GAMMA_DELTA: u32 = 7u;

// Variable transform extension: libaom's inter_tx_size array, one transform size per byte
const RECORD_VARIABLE_TX_WORDS: u32 = 4u;

// Palette extension: eight colors per plane, two per word, the sizes, then the color index maps at four bits per sample
const RECORD_PALETTE_HEADER_WORDS: u32 = 13u;
const RECORD_PALETTE_COLORS_Y: u32 = 0u;
const RECORD_PALETTE_COLORS_U: u32 = 4u;
const RECORD_PALETTE_COLORS_V: u32 = 8u;
const RECORD_PALETTE_SIZES: u32 = 12u;
const RECORD_PALETTE_SIZE_Y_SHIFT: u32 = 0u;
const RECORD_PALETTE_SIZE_UV_SHIFT: u32 = 4u;
const RECORD_PALETTE_SIZE_BITS: u32 = 4u;
const RECORD_PALETTE_INDEX_BITS: u32 = 4u;

// An intra job, in decode order within its superblock's plane list
const RECORD_INTRA_JOB_WORDS: u32 = 3u;
const RECORD_INTRA_JOB_POSITION: u32 = 0u;
const RECORD_INTRA_JOB_BLOCK: u32 = 1u;
const RECORD_INTRA_JOB_EDGES: u32 = 2u;
const RECORD_INTRA_JOB_X4_SHIFT: u32 = 0u;
const RECORD_INTRA_JOB_Y4_SHIFT: u32 = 12u;
const RECORD_INTRA_JOB_COORDINATE_BITS: u32 = 12u;
const RECORD_INTRA_JOB_TX_SIZE_SHIFT: u32 = 24u;
const RECORD_INTRA_JOB_TX_SIZE_BITS: u32 = 5u;
const RECORD_INTRA_JOB_PLANE_SHIFT: u32 = 29u;
const RECORD_INTRA_JOB_PLANE_BITS: u32 = 2u;
const RECORD_INTRA_JOB_HAS_RESIDUAL_SHIFT: u32 = 31u;
const RECORD_INTRA_JOB_BLOCK_INDEX_BITS: u32 = 22u;
const RECORD_INTRA_JOB_KIND_SHIFT: u32 = 22u;
const RECORD_INTRA_JOB_KIND_BITS: u32 = 2u;
const RECORD_INTRA_JOB_CFL_WIDTH_SHIFT: u32 = 24u;
const RECORD_INTRA_JOB_CFL_HEIGHT_SHIFT: u32 = 28u;
const RECORD_INTRA_JOB_CFL_SIZE_BITS: u32 = 4u;
const RECORD_INTRA_JOB_KIND_TRANSFORM: u32 = 0u;
const RECORD_INTRA_JOB_KIND_INTERINTRA: u32 = 1u;
const RECORD_INTRA_JOB_KIND_INTRABC: u32 = 2u;
const RECORD_INTRA_JOB_TOP_SHIFT: u32 = 0u;
const RECORD_INTRA_JOB_TOP_RIGHT_SHIFT: u32 = 7u;
const RECORD_INTRA_JOB_LEFT_SHIFT: u32 = 14u;
const RECORD_INTRA_JOB_BOTTOM_LEFT_SHIFT: u32 = 21u;
const RECORD_INTRA_JOB_EDGE_BITS: u32 = 7u;
const RECORD_INTRA_JOB_EDGE_BIAS: u32 = 1u;
const RECORD_INTRA_JOB_EDGE_FILTER_SHIFT: u32 = 28u;

// A transform job: a transform block with coefficients, and where its residual goes
const RECORD_TRANSFORM_JOB_WORDS: u32 = 3u;
const RECORD_TRANSFORM_JOB_POSITION: u32 = 0u;
const RECORD_TRANSFORM_JOB_CODING: u32 = 1u;
const RECORD_TRANSFORM_JOB_PAYLOAD: u32 = 2u;
const RECORD_TRANSFORM_JOB_X4_SHIFT: u32 = 0u;
const RECORD_TRANSFORM_JOB_Y4_SHIFT: u32 = 12u;
const RECORD_TRANSFORM_JOB_COORDINATE_BITS: u32 = 12u;
const RECORD_TRANSFORM_JOB_TX_SIZE_SHIFT: u32 = 24u;
const RECORD_TRANSFORM_JOB_TX_SIZE_BITS: u32 = 5u;
const RECORD_TRANSFORM_JOB_PLANE_BITS: u32 = 2u;
const RECORD_TRANSFORM_JOB_PLANE_SHIFT: u32 = 29u;
const RECORD_TRANSFORM_JOB_LOSSLESS_SHIFT: u32 = 31u;
const RECORD_TRANSFORM_JOB_TX_TYPE_SHIFT: u32 = 0u;
const RECORD_TRANSFORM_JOB_TX_TYPE_BITS: u32 = 4u;
const RECORD_TRANSFORM_JOB_DESTINATION_SHIFT: u32 = 4u;
const RECORD_TRANSFORM_JOB_SPARSE_SHIFT: u32 = 5u;
const RECORD_TRANSFORM_JOB_VALUE_BITS_SHIFT: u32 = 6u;
const RECORD_TRANSFORM_JOB_VALUE_BITS_BITS: u32 = 5u;
const RECORD_TRANSFORM_JOB_EOB_SHIFT: u32 = 11u;
const RECORD_TRANSFORM_JOB_EOB_BITS: u32 = 11u;
const RECORD_TRANSFORM_JOB_BOX_COLUMNS_SHIFT: u32 = 22u;
const RECORD_TRANSFORM_JOB_BOX_ROWS_SHIFT: u32 = 27u;
const RECORD_TRANSFORM_JOB_BOX_BITS: u32 = 5u;
const RECORD_TRANSFORM_JOB_COUNT_SHIFT: u32 = 22u;
const RECORD_TRANSFORM_JOB_COUNT_BITS: u32 = 10u;
const RECORD_TRANSFORM_JOB_POSITION_BITS: u32 = 10u;
const RECORD_TRANSFORM_DESTINATION_TARGET: u32 = 0u;
const RECORD_TRANSFORM_DESTINATION_RESIDUAL: u32 = 1u;

// A loop restoration unit, per plane in raster order
const RECORD_RESTORATION_UNIT_WORDS: u32 = 2u;
const RECORD_RESTORATION_UNIT_TYPE_SHIFT: u32 = 0u;
const RECORD_RESTORATION_UNIT_TYPE_BITS: u32 = 2u;
const RECORD_RESTORATION_UNIT_SGR_SET_SHIFT: u32 = 2u;
const RECORD_RESTORATION_UNIT_SGR_SET_BITS: u32 = 4u;
const RECORD_RESTORATION_UNIT_SGR_WEIGHT_0_SHIFT: u32 = 6u;
const RECORD_RESTORATION_UNIT_SGR_WEIGHT_1_SHIFT: u32 = 14u;
const RECORD_RESTORATION_UNIT_SGR_WEIGHT_BITS: u32 = 8u;
const RECORD_RESTORATION_UNIT_SGR_WEIGHT_0_BIAS: u32 = 96u;
const RECORD_RESTORATION_UNIT_SGR_WEIGHT_1_BIAS: u32 = 32u;
const RECORD_RESTORATION_UNIT_WIENER_VERTICAL_SHIFT: u32 = 0u;
const RECORD_RESTORATION_UNIT_WIENER_HORIZONTAL_SHIFT: u32 = 15u;
const RECORD_RESTORATION_UNIT_WIENER_TAP_0_BITS: u32 = 4u;
const RECORD_RESTORATION_UNIT_WIENER_TAP_1_BITS: u32 = 5u;
const RECORD_RESTORATION_UNIT_WIENER_TAP_2_BITS: u32 = 6u;
const RECORD_RESTORATION_UNIT_WIENER_TAP_0_BIAS: u32 = 5u;
const RECORD_RESTORATION_UNIT_WIENER_TAP_1_BIAS: u32 = 23u;
const RECORD_RESTORATION_UNIT_WIENER_TAP_2_BIAS: u32 = 17u;

// Error codes, which the parser and the passes share; an error word is (code << ERROR_CODE_SHIFT) | value
const ERROR_CODE_SHIFT: u32 = 24u;
const ERROR_CONFIGURATION: u32 = 1u;
const ERROR_BITSTREAM_CORRUPT: u32 = 2u;
const ERROR_BITSTREAM_UNSUPPORTED: u32 = 3u;
const ERROR_PARSER_MEMORY: u32 = 4u;
const ERROR_PARSER_ERROR: u32 = 5u;
const ERROR_RECORD_SIZE: u32 = 6u;
const ERROR_PICTURE_SIZE: u32 = 7u;
const ERROR_STREAM_FORMAT: u32 = 8u;
const ERROR_RECORD_INVALID: u32 = 9u;
const ERROR_REFERENCE_INVALID: u32 = 10u;
const ERROR_FRAME_BUFFERS: u32 = 11u;
const ERROR_VALUE_MASK: u32 = 16777215u;

// The values ERROR_RECORD_INVALID reports from the passes: the header's magic, version, length, or kind, a frame buffer index,
// a section outside the record, the tile grid, the wave count or slope, the mode info and superblock grids against the frame size,
// or the transform jobs' split: RECORD_HEADER_TRANSFORM_LARGE_JOB past the job count, a job with a 64-point side before it or one
// without from it on, or a 64-point job of a type other than DCT_DCT, the only one libaom codes there; a transform pass skips such a job
const RECORD_INVALID_MAGIC: u32 = 1u;
const RECORD_INVALID_VERSION: u32 = 2u;
const RECORD_INVALID_LENGTH: u32 = 3u;
const RECORD_INVALID_KIND: u32 = 4u;
const RECORD_INVALID_BUFFER: u32 = 5u;
const RECORD_INVALID_SECTION: u32 = 6u;
const RECORD_INVALID_TILES: u32 = 7u;
const RECORD_INVALID_WAVES: u32 = 8u;
const RECORD_INVALID_GRID: u32 = 9u;
const RECORD_INVALID_TRANSFORM_JOB: u32 = 10u;
// The wave slopes a record may declare: intra edges, IntraBC with 128x128 superblocks, and IntraBC with 64x64 superblocks
const WAVE_SLOPE_INTRA: u32 = 2u;
const WAVE_SLOPE_INTRABC_128: u32 = 3u;
const WAVE_SLOPE_INTRABC_64: u32 = 5u;

// The persistent state buffer's words
const STATE_WAVE_EVEN: u32 = 0u;
const STATE_WAVE_ODD: u32 = 1u;
const STATE_FRAME_VALID: u32 = 2u;

// The frame data buffer's areas after the mode info map and the restoration boundaries, and the tables' family areas
const FILM_GRAIN_AREA_WORDS: u32 = 32768u;
const TABLES_AREA_WORDS: u32 = 131072u;
const TABLES_READY_WORD: u32 = 0u;
const TABLES_READY_VALUE: u32 = 1u;
const TRANSFORM_TABLES_OFFSET: u32 = 16u;
const TRANSFORM_TABLES_WORDS: u32 = 16368u;
const INTRA_TABLES_OFFSET: u32 = 16384u;
const INTRA_TABLES_WORDS: u32 = 16384u;
const INTER_TABLES_OFFSET: u32 = 32768u;
const INTER_TABLES_WORDS: u32 = 65536u;
const FILTERS_TABLES_OFFSET: u32 = 98304u;
const FILTERS_TABLES_WORDS: u32 = 32768u;
// Rows of saved pre-CDEF samples per restoration stripe and plane: two above the stripe and two below
const RESTORATION_BOUNDARY_ROWS: u32 = 4u;
const RESTORATION_STRIPE_HEIGHT: u32 = 64u;

// The mode info map word of a 4x4 luma unit, which expandBlocks writes: its block's index, its luma transform size as the
// loop filter reads it (TX_4X4 when lossless, the variable transform's leaf in an inter block with residual), and its block's skip flags
const MODE_INFO_BLOCK_INDEX_BITS: u32 = 22u;
const MODE_INFO_TX_SIZE_SHIFT: u32 = 22u;
const MODE_INFO_TX_SIZE_BITS: u32 = 5u;
const MODE_INFO_SKIP_SHIFT: u32 = 27u;
const MODE_INFO_SKIP_INTER_SHIFT: u32 = 28u;
const MODE_INFO_INTER_SHIFT: u32 = 29u;

// The wavefront's tile column slots per superblock row (the header's even predictIntra dispatch has this many workgroup columns, the
// odd one a column more), and the chroma planes' lag behind luma in waves, which the parser's wave count includes
const WAVE_TILE_COLUMN_SLOTS: u32 = 4u;
const RECORD_WAVE_CHROMA_LAG: u32 = 1u;

// libaom's enumerations the families share
const BLOCK_SIZES_ALL: u32 = 22u;
const TX_SIZES_ALL: u32 = 19u;
const TX_4X4: u32 = 0u;
const PLANE_Y: u32 = 0u;
const PLANE_U: u32 = 1u;
const PLANE_V: u32 = 2u;
const MI_SIZE_LOG2: u32 = 2u;
const SAMPLE_PAIR_SHIFT: u32 = 1u;
const SAMPLE_HALF_BITS: u32 = 16u;
const SAMPLE_HALF_MASK: u32 = 65535u;

// Record access

// A word of the record, which the packet holds
fn readRecordWord(wordIndex: u32) -> u32 {
    return readPacketWord(wordIndex);
}

// An unsigned field of a word; bitCount is below 32
fn getField(word: u32, shift: u32, bitCount: u32) -> u32 {
    return (word >> shift) & ((1u << bitCount) - 1u);
}

// A two's complement field of a word, sign extended; bitCount is 1 to 31
fn getSignedField(word: u32, shift: u32, bitCount: u32) -> i32 {
    let unused = 32u - bitCount;
    return bitcast<i32>(word << (unused - shift)) >> unused;
}

// A header flag
fn hasRecordFlag(flag: u32) -> bool {
    return ((readRecordWord(RECORD_HEADER_FLAGS) >> flag) & 1u) == 1u;
}

// A word of a coding block
fn readBlockWord(blockIndex: u32, word: u32) -> u32 {
    return readRecordWord(readRecordWord(RECORD_HEADER_BLOCKS) + blockIndex * RECORD_BLOCK_WORDS + word);
}

// The first side data word of a block's extensions
fn getBlockExtensionOffset(blockIndex: u32) -> u32 {
    let extension = readBlockWord(blockIndex, RECORD_BLOCK_EXTENSION);
    return readRecordWord(RECORD_HEADER_SIDE_DATA) + getField(extension, 0u, RECORD_BLOCK_EXTENSION_OFFSET_BITS);
}

// The record word where one of a block's extensions starts, or RECORD_MISSING when the block has none of that kind;
// extensionShift is its presence bit, RECORD_BLOCK_HAS_MOTION_SHIFT to RECORD_BLOCK_HAS_PALETTE_SHIFT
fn getBlockExtensionWordIndex(blockIndex: u32, extensionShift: u32) -> u32 {
    let extension = readBlockWord(blockIndex, RECORD_BLOCK_EXTENSION);
    if (((extension >> extensionShift) & 1u) == 0u) {
        return RECORD_MISSING;
    }
    // The extensions sit in presence bit order; the ones before this one push it back
    var wordIndex = readRecordWord(RECORD_HEADER_SIDE_DATA) + getField(extension, 0u, RECORD_BLOCK_EXTENSION_OFFSET_BITS);
    if (extensionShift > RECORD_BLOCK_HAS_MOTION_SHIFT && ((extension >> RECORD_BLOCK_HAS_MOTION_SHIFT) & 1u) == 1u) {
        wordIndex += RECORD_MOTION_WORDS;
    }
    if (extensionShift > RECORD_BLOCK_HAS_LOCAL_WARP_SHIFT && ((extension >> RECORD_BLOCK_HAS_LOCAL_WARP_SHIFT) & 1u) == 1u) {
        wordIndex += RECORD_LOCAL_WARP_WORDS;
    }
    if (extensionShift > RECORD_BLOCK_HAS_VARIABLE_TX_SHIFT && ((extension >> RECORD_BLOCK_HAS_VARIABLE_TX_SHIFT) & 1u) == 1u) {
        wordIndex += RECORD_VARIABLE_TX_WORDS;
    }
    return wordIndex;
}

// libaom's av1_get_txb_size_index(): the entry of a block's inter_tx_size array that holds the 4x4 unit (row, column) of the block
fn getVariableTransformIndex(blockSize: u32, row: u32, column: u32) -> u32 {
    var widthLog2 = 0u;
    var heightLog2 = 0u;
    var strideLog2 = 0u;
    switch (blockSize) {
        case 0u, 1u, 2u, 3u: { strideLog2 = select(0u, 1u, blockSize >= 2u); }
        case 4u, 5u, 6u: { widthLog2 = 1u; heightLog2 = 1u; strideLog2 = select(0u, 1u, blockSize >= 5u); }
        case 7u, 8u, 9u: { widthLog2 = 2u; heightLog2 = 2u; strideLog2 = select(0u, 1u, blockSize >= 8u); }
        case 10u, 11u, 12u, 13u: { widthLog2 = 3u; heightLog2 = 3u; strideLog2 = select(0u, 1u, blockSize >= 11u); }
        case 14u, 15u: { widthLog2 = 3u; heightLog2 = 3u; strideLog2 = 2u; }
        case 16u: { heightLog2 = 1u; }
        case 17u: { widthLog2 = 1u; strideLog2 = 1u; }
        case 18u: { widthLog2 = 1u; heightLog2 = 2u; }
        case 19u: { widthLog2 = 2u; heightLog2 = 1u; strideLog2 = 1u; }
        case 20u: { widthLog2 = 2u; heightLog2 = 3u; }
        default: { widthLog2 = 3u; heightLog2 = 2u; strideLog2 = 1u; }
    }
    return ((row >> heightLog2) << strideLog2) + (column >> widthLog2);
}

// A word of an intra job
fn readIntraJobWord(jobIndex: u32, word: u32) -> u32 {
    return readRecordWord(readRecordWord(RECORD_HEADER_INTRA_JOBS) + jobIndex * RECORD_INTRA_JOB_WORDS + word);
}

// A word of a transform job
fn readTransformJobWord(jobIndex: u32, word: u32) -> u32 {
    return readRecordWord(readRecordWord(RECORD_HEADER_TRANSFORM_JOBS) + jobIndex * RECORD_TRANSFORM_JOB_WORDS + word);
}

// A word of a superblock, by its index in frame raster order
fn readSuperblockWord(superblockIndex: u32, word: u32) -> u32 {
    return readRecordWord(readRecordWord(RECORD_HEADER_SUPERBLOCKS) + superblockIndex * RECORD_SUPERBLOCK_WORDS + word);
}

// A word of a reference's entry, by its index from LAST_FRAME (0) to ALTREF_FRAME (6)
fn readReferenceWord(referenceIndex: u32, word: u32) -> u32 {
    return readRecordWord(RECORD_HEADER_REFERENCES + referenceIndex * RECORD_REFERENCE_WORDS + word);
}

// Frame store: RECORD_FRAME_BUFFERS frame buffers of 16-bit samples, two per word, each plane sized for the session's largest frame.
// It spans two buffers, so a device whose largest binding holds half of it holds the store: frames holds frame buffers 0 to
// RECORD_FRAME_BUFFERS_LOW - 1 and framesHigh the rest, and a word index runs on from one to the other

// A plane's allocated width in samples
fn getStorePlaneWidth(plane: u32) -> u32 {
    if (plane == PLANE_Y) {
        return stream.width;
    }
    return stream.planes[plane].width;
}

// A plane's allocated height in rows
fn getStorePlaneHeight(plane: u32) -> u32 {
    if (plane == PLANE_Y) {
        return stream.height;
    }
    return stream.planes[plane].height;
}

// The words of one plane of one frame buffer
fn getStorePlaneWords(plane: u32) -> u32 {
    return (getStorePlaneWidth(plane) >> SAMPLE_PAIR_SHIFT) * getStorePlaneHeight(plane);
}

// The words of one frame buffer
fn getStoreBufferWords() -> u32 {
    return getStorePlaneWords(PLANE_Y) + getStorePlaneWords(PLANE_U) + getStorePlaneWords(PLANE_V);
}

// The word that holds sample (x, y) of a plane of a frame buffer; even x is its low half
fn getStoreWordIndex(frameBuffer: u32, plane: u32, x: u32, y: u32) -> u32 {
    var planeOffset = 0u;
    for (var earlierPlane = 0u; earlierPlane < plane; earlierPlane += 1u) {
        planeOffset += getStorePlaneWords(earlierPlane);
    }
    return frameBuffer * getStoreBufferWords() + planeOffset + y * (getStorePlaneWidth(plane) >> SAMPLE_PAIR_SHIFT) + (x >> SAMPLE_PAIR_SHIFT);
}

// Reads a word of the frame store
fn readFrameWord(word: u32) -> u32 {
    let lowWords = arrayLength(&frames);
    if (word < lowWords) {
        return frames[word];
    }
    return framesHigh[word - lowWords];
}

// Writes a word of the frame store
fn writeFrameWord(word: u32, value: u32) {
    let lowWords = arrayLength(&frames);
    if (word < lowWords) {
        frames[word] = value;
        return;
    }
    framesHigh[word - lowWords] = value;
}

// Reads a sample of a frame buffer
fn readStoreSample(frameBuffer: u32, plane: u32, x: u32, y: u32) -> u32 {
    let word = readFrameWord(getStoreWordIndex(frameBuffer, plane, x, y));
    return (word >> ((x & 1u) * SAMPLE_HALF_BITS)) & SAMPLE_HALF_MASK;
}

// Writes samples (x, y) and (x + 1, y) of a frame buffer, x even; one invocation owns each word
fn writeStoreSamplePair(frameBuffer: u32, plane: u32, x: u32, y: u32, samples: vec2u) {
    writeFrameWord(getStoreWordIndex(frameBuffer, plane, x, y), (samples.x & SAMPLE_HALF_MASK) | ((samples.y & SAMPLE_HALF_MASK) << SAMPLE_HALF_BITS));
}

// Reads a residual sample, which the record's scratch buffer holds as a signed 16-bit sample while the frame reconstructs
fn readResidualSample(plane: u32, x: u32, y: u32) -> i32 {
    let word = readFrameWord(getStoreWordIndex(readRecordWord(RECORD_HEADER_SCRATCH_BUFFER), plane, x, y));
    return bitcast<i32>(word << ((1u - (x & 1u)) * SAMPLE_HALF_BITS)) >> SAMPLE_HALF_BITS;
}

// Writes residual samples (x, y) and (x + 1, y), x even, saturated to 16 bits, which clipping to the sample range leaves exact
fn writeResidualPair(plane: u32, x: u32, y: u32, residuals: vec2i) {
    let low = u32(clamp(residuals.x, -32768, 32767)) & SAMPLE_HALF_MASK;
    let high = u32(clamp(residuals.y, -32768, 32767)) & SAMPLE_HALF_MASK;
    writeFrameWord(getStoreWordIndex(readRecordWord(RECORD_HEADER_SCRATCH_BUFFER), plane, x, y), low | (high << SAMPLE_HALF_BITS));
}

// Frame data areas

// The word of the mode info map for a 4x4 luma unit
fn getModeInfoWordIndex(modeInfoRow: u32, modeInfoColumn: u32) -> u32 {
    return modeInfoRow * (stream.width >> MI_SIZE_LOG2) + modeInfoColumn;
}

// The first word of the saved restoration boundary rows
fn getRestorationBoundaryOffset() -> u32 {
    return (stream.width >> MI_SIZE_LOG2) * (stream.height >> MI_SIZE_LOG2);
}

// The first word of the film grain area
fn getFilmGrainOffset() -> u32 {
    let stripeCount = (stream.height + RESTORATION_STRIPE_HEIGHT - 1u) / RESTORATION_STRIPE_HEIGHT + 2u;
    return getRestorationBoundaryOffset() + 6u * stripeCount * stream.width;
}

// The first word of the tables area
fn getTablesOffset() -> u32 {
    return getFilmGrainOffset() + FILM_GRAIN_AREA_WORDS;
}

// Sample arithmetic

// Clips a value to the samples of a bit depth
fn clipSample(value: i32, bitDepth: u32) -> u32 {
    return u32(clamp(value, 0, (1 << bitDepth) - 1));
}

// libaom's ROUND_POWER_OF_TWO of a non-negative value
fn roundPowerOfTwo(value: i32, shift: u32) -> i32 {
    if (shift == 0u) {
        return value;
    }
    return (value + (1 << (shift - 1u))) >> shift;
}

// libaom's ROUND_POWER_OF_TWO_SIGNED
fn roundPowerOfTwoSigned(value: i32, shift: u32) -> i32 {
    if (value < 0) {
        return -roundPowerOfTwo(-value, shift);
    }
    return roundPowerOfTwo(value, shift);
}

// libaom's block and transform sizes

// log2 of a block size's width in samples
fn getBlockWidthLog2(blockSize: u32) -> u32 {
    switch (blockSize) {
        case 0u, 1u, 16u: { return 2u; }
        case 2u, 3u, 4u, 18u: { return 3u; }
        case 5u, 6u, 7u, 17u, 20u: { return 4u; }
        case 8u, 9u, 10u, 19u: { return 5u; }
        case 11u, 12u, 13u, 21u: { return 6u; }
        default: { return 7u; }
    }
}

// log2 of a block size's height in samples
fn getBlockHeightLog2(blockSize: u32) -> u32 {
    switch (blockSize) {
        case 0u, 2u, 17u: { return 2u; }
        case 1u, 3u, 5u, 19u: { return 3u; }
        case 4u, 6u, 8u, 16u, 21u: { return 4u; }
        case 7u, 9u, 11u, 18u: { return 5u; }
        case 10u, 12u, 14u, 20u: { return 6u; }
        default: { return 7u; }
    }
}

// log2 of a transform size's width in samples
fn getTransformWidthLog2(transformSize: u32) -> u32 {
    switch (transformSize) {
        case 0u, 5u, 13u: { return 2u; }
        case 1u, 6u, 7u, 15u: { return 3u; }
        case 2u, 8u, 9u, 14u, 17u: { return 4u; }
        case 3u, 10u, 11u, 16u: { return 5u; }
        default: { return 6u; }
    }
}

// log2 of a transform size's height in samples
fn getTransformHeightLog2(transformSize: u32) -> u32 {
    switch (transformSize) {
        case 0u, 6u, 14u: { return 2u; }
        case 1u, 5u, 8u, 16u: { return 3u; }
        case 2u, 7u, 10u, 13u, 18u: { return 4u; }
        case 3u, 9u, 12u, 15u: { return 5u; }
        default: { return 6u; }
    }
}

// The record's plane sizes for the frame being decoded: a plane's width before super-resolution, and its height
fn getFramePlaneWidth(plane: u32) -> u32 {
    let width = readRecordWord(RECORD_HEADER_FRAME_WIDTH);
    if (plane == PLANE_Y) {
        return width;
    }
    let subsamplingX = readRecordWord(RECORD_HEADER_SUBSAMPLING_X);
    return (width + subsamplingX) >> subsamplingX;
}

fn getFramePlaneHeight(plane: u32) -> u32 {
    let height = readRecordWord(RECORD_HEADER_FRAME_HEIGHT);
    if (plane == PLANE_Y) {
        return height;
    }
    let subsamplingY = readRecordWord(RECORD_HEADER_SUBSAMPLING_Y);
    return (height + subsamplingY) >> subsamplingY;
}

// A plane's width after super-resolution, which the frame keeps as a reference and outputs
fn getUpscaledPlaneWidth(plane: u32) -> u32 {
    let width = readRecordWord(RECORD_HEADER_UPSCALED_WIDTH);
    if (plane == PLANE_Y) {
        return width;
    }
    let subsamplingX = readRecordWord(RECORD_HEADER_SUBSAMPLING_X);
    return (width + subsamplingX) >> subsamplingX;
}

// Whether the frame being decoded runs this pass: the record was accepted and it decodes a frame
fn isDecodingFrame() -> bool {
    return state[STATE_FRAME_VALID] == 1u && readRecordWord(RECORD_HEADER_KIND) == RECORD_KIND_DECODE;
}

// The output format's chroma format (OUTPUT_CHROMA_FORMAT's values) of a record's subsampling, 0 for none; 4:0:0 decodes to 4:2:0
fn getRecordChromaFormat(subsamplingX: u32, subsamplingY: u32) -> u32 {
    switch ((subsamplingX << 1u) | subsamplingY) {
        case 3u: { return 1u; }
        case 2u: { return 2u; }
        case 0u: { return 3u; }
        default: { return 0u; }
    }
}

// Whether entries of a size fit a record section from its offset on, without overflow
fn isSectionWithin(offset: u32, entryCount: u32, entryWords: u32, recordWords: u32) -> bool {
    if (offset < RECORD_HEADER_WORDS || offset > recordWords) {
        return false;
    }
    return entryCount <= (recordWords - offset) / entryWords;
}

// Whether a tile start list runs from 0 up to its frame's superblocks, strictly increasing
fn areTileStartsValid(firstWord: u32, tileCount: u32, superblocks: u32) -> bool {
    if (tileCount == 0u || tileCount > RECORD_MAXIMUM_TILE_COLUMNS || readRecordWord(firstWord) != 0u) {
        return false;
    }
    for (var tile = 0u; tile < tileCount; tile += 1u) {
        if (readRecordWord(firstWord + tile + 1u) <= readRecordWord(firstWord + tile)) {
            return false;
        }
    }
    return readRecordWord(firstWord + tileCount) == superblocks;
}

// The record error word of an invalid record value
fn getRecordInvalidError(value: u32) -> u32 {
    return (ERROR_RECORD_INVALID << ERROR_CODE_SHIFT) | value;
}

// The picture size error word of a dimension
fn getPictureSizeError(dimension: u32) -> u32 {
    return (ERROR_PICTURE_SIZE << ERROR_CODE_SHIFT) | (dimension & ERROR_VALUE_MASK);
}

// Whether a frame buffer index names one of the frame store's frame buffers, or RECORD_MISSING where allowed
fn isFrameBufferValid(frameBuffer: u32, allowMissing: bool) -> bool {
    return frameBuffer < RECORD_FRAME_BUFFERS || (allowMissing && frameBuffer == RECORD_MISSING);
}

// The first problem of a decode record's frame buffers, references, grids, sections, tiles, and waves as an error word, or 0
fn validateDecodeRecord(recordWords: u32) -> u32 {
    let targetBuffer = readRecordWord(RECORD_HEADER_TARGET_BUFFER);
    let scratchBuffer = readRecordWord(RECORD_HEADER_SCRATCH_BUFFER);
    let finalBuffer = readRecordWord(RECORD_HEADER_FINAL_BUFFER);
    if (!isFrameBufferValid(targetBuffer, false) || !isFrameBufferValid(scratchBuffer, false) || targetBuffer == scratchBuffer) {
        return getRecordInvalidError(RECORD_INVALID_BUFFER);
    }
    if ((finalBuffer != targetBuffer && finalBuffer != scratchBuffer) || readRecordWord(RECORD_HEADER_OUTPUT_BUFFER) != finalBuffer) {
        return getRecordInvalidError(RECORD_INVALID_BUFFER);
    }
    // Each filter pass reads one of the frame's two buffers and writes the other, or does not run
    for (var field = RECORD_HEADER_CDEF_SOURCE; field <= RECORD_HEADER_RESTORATION_SOURCE; field += 2u) {
        let source = readRecordWord(field);
        let destination = readRecordWord(field + 1u);
        let runs = source != RECORD_MISSING;
        let readsFrame = source == targetBuffer || source == scratchBuffer;
        let writesFrame = destination == targetBuffer || destination == scratchBuffer;
        if ((runs && (!readsFrame || !writesFrame || source == destination)) || (!runs && destination != RECORD_MISSING)) {
            return getRecordInvalidError(RECORD_INVALID_BUFFER);
        }
    }
    if (readRecordWord(RECORD_HEADER_NEUTRAL_FILL_MASK) >= (1u << RECORD_FRAME_BUFFERS)) {
        return getRecordInvalidError(RECORD_INVALID_BUFFER);
    }
    for (var reference = 0u; reference < RECORD_REFERENCES; reference += 1u) {
        let frameBuffer = readReferenceWord(reference, RECORD_REFERENCE_BUFFER);
        if (!isFrameBufferValid(frameBuffer, true)) {
            return getRecordInvalidError(RECORD_INVALID_BUFFER);
        }
        if (frameBuffer == RECORD_MISSING) {
            continue;
        }
        let width = readReferenceWord(reference, RECORD_REFERENCE_WIDTH);
        let height = readReferenceWord(reference, RECORD_REFERENCE_HEIGHT);
        if (width == 0u || width > stream.width) {
            return getPictureSizeError(width);
        }
        if (height == 0u || height > stream.height) {
            return getPictureSizeError(height);
        }
    }
    // The mode info grid covers the frame aligned to 8, and the superblock grid covers the mode info grid
    let frameWidth = readRecordWord(RECORD_HEADER_FRAME_WIDTH);
    let frameHeight = readRecordWord(RECORD_HEADER_FRAME_HEIGHT);
    if (frameWidth == 0u || frameWidth > readRecordWord(RECORD_HEADER_UPSCALED_WIDTH)) {
        return getPictureSizeError(frameWidth);
    }
    let miColumns = readRecordWord(RECORD_HEADER_MI_COLUMNS);
    let miRows = readRecordWord(RECORD_HEADER_MI_ROWS);
    let superblockLog2 = select(4u, 5u, hasRecordFlag(RECORD_FLAG_SUPERBLOCK_128));
    let superblockColumns = readRecordWord(RECORD_HEADER_SUPERBLOCK_COLUMNS);
    let superblockRows = readRecordWord(RECORD_HEADER_SUPERBLOCK_ROWS);
    if (miColumns != ((frameWidth + 7u) >> 3u) << 1u || miRows != ((frameHeight + 7u) >> 3u) << 1u
        || superblockColumns != (miColumns + (1u << superblockLog2) - 1u) >> superblockLog2
        || superblockRows != (miRows + (1u << superblockLog2) - 1u) >> superblockLog2) {
        return getRecordInvalidError(RECORD_INVALID_GRID);
    }
    // Sections
    if (!isSectionWithin(readRecordWord(RECORD_HEADER_SUPERBLOCKS), superblockColumns * superblockRows, RECORD_SUPERBLOCK_WORDS, recordWords)
        || !isSectionWithin(readRecordWord(RECORD_HEADER_BLOCKS), readRecordWord(RECORD_HEADER_BLOCK_COUNT), RECORD_BLOCK_WORDS, recordWords)
        || !isSectionWithin(readRecordWord(RECORD_HEADER_INTRA_JOBS), readRecordWord(RECORD_HEADER_INTRA_JOB_COUNT), RECORD_INTRA_JOB_WORDS, recordWords)
        || !isSectionWithin(readRecordWord(RECORD_HEADER_TRANSFORM_JOBS), readRecordWord(RECORD_HEADER_TRANSFORM_JOB_COUNT), RECORD_TRANSFORM_JOB_WORDS, recordWords)
        || !isSectionWithin(readRecordWord(RECORD_HEADER_COEFFICIENTS), readRecordWord(RECORD_HEADER_COEFFICIENT_WORDS), 1u, recordWords)
        || !isSectionWithin(readRecordWord(RECORD_HEADER_SIDE_DATA), readRecordWord(RECORD_HEADER_SIDE_DATA_WORDS), 1u, recordWords)
        || !isSectionWithin(readRecordWord(RECORD_HEADER_RESTORATION_UNITS), readRecordWord(RECORD_HEADER_RESTORATION_UNIT_COUNT), RECORD_RESTORATION_UNIT_WORDS, recordWords)) {
        return getRecordInvalidError(RECORD_INVALID_SECTION);
    }
    // The transform passes check each job's side of the split as they run it
    if (readRecordWord(RECORD_HEADER_TRANSFORM_LARGE_JOB) > readRecordWord(RECORD_HEADER_TRANSFORM_JOB_COUNT)) {
        return getRecordInvalidError(RECORD_INVALID_TRANSFORM_JOB);
    }
    let restorationUnitCount = readRecordWord(RECORD_HEADER_RESTORATION_UNIT_COUNT);
    for (var plane = 0u; plane < RECORD_PLANES; plane += 1u) {
        let entry = RECORD_HEADER_RESTORATION + plane * RECORD_RESTORATION_WORDS;
        if (readRecordWord(entry + RECORD_RESTORATION_TYPE) == 0u) {
            continue;
        }
        let units = readRecordWord(entry + RECORD_RESTORATION_HORIZONTAL_UNITS) * readRecordWord(entry + RECORD_RESTORATION_VERTICAL_UNITS);
        let firstUnit = readRecordWord(entry + RECORD_RESTORATION_FIRST_UNIT);
        if (firstUnit > restorationUnitCount || units > restorationUnitCount - firstUnit) {
            return getRecordInvalidError(RECORD_INVALID_SECTION);
        }
    }
    // Tiles and waves: the wavefront runs at most the header's repeat count of wave pairs
    if (readRecordWord(RECORD_HEADER_TILE_ROWS) > RECORD_MAXIMUM_TILE_ROWS
        || !areTileStartsValid(RECORD_HEADER_TILE_COLUMN_STARTS, readRecordWord(RECORD_HEADER_TILE_COLUMNS), superblockColumns)
        || !areTileStartsValid(RECORD_HEADER_TILE_ROW_STARTS, readRecordWord(RECORD_HEADER_TILE_ROWS), superblockRows)) {
        return getRecordInvalidError(RECORD_INVALID_TILES);
    }
    let slope = readRecordWord(RECORD_HEADER_WAVE_SLOPE);
    let wavePairs = ((stream.width + 63u) / 64u + 5u * ((stream.height + 63u) / 64u) + 1u) / 2u;
    if ((slope != WAVE_SLOPE_INTRA && slope != WAVE_SLOPE_INTRABC_128 && slope != WAVE_SLOPE_INTRABC_64)
        || readRecordWord(RECORD_HEADER_WAVE_COUNT) > 2u * wavePairs) {
        return getRecordInvalidError(RECORD_INVALID_WAVES);
    }
    return 0u;
}

// The first problem of a record as an error word, or 0 for one the passes may read: its magic, version, length, and kind, its format
// and output size against the session, and for a decode record everything validateDecodeRecord checks
fn validateRecord() -> u32 {
    let packetWords = packet.byteLength >> 2u;
    if (packetWords < RECORD_HEADER_WORDS) {
        return getRecordInvalidError(RECORD_INVALID_LENGTH);
    }
    if (readRecordWord(RECORD_HEADER_MAGIC) != RECORD_MAGIC) {
        return getRecordInvalidError(RECORD_INVALID_MAGIC);
    }
    if (readRecordWord(RECORD_HEADER_VERSION) != RECORD_VERSION) {
        return getRecordInvalidError(RECORD_INVALID_VERSION);
    }
    let recordWords = readRecordWord(RECORD_HEADER_RECORD_WORDS);
    if (recordWords < RECORD_HEADER_WORDS || recordWords > packetWords) {
        return getRecordInvalidError(RECORD_INVALID_LENGTH);
    }
    let kind = readRecordWord(RECORD_HEADER_KIND);
    if (kind != RECORD_KIND_DECODE && kind != RECORD_KIND_SHOW_EXISTING) {
        return getRecordInvalidError(RECORD_INVALID_KIND);
    }
    let bitDepth = readRecordWord(RECORD_HEADER_BIT_DEPTH);
    let subsamplingX = readRecordWord(RECORD_HEADER_SUBSAMPLING_X);
    let subsamplingY = readRecordWord(RECORD_HEADER_SUBSAMPLING_Y);
    if (bitDepth != OUTPUT_BIT_DEPTH || subsamplingX > 1u || subsamplingY > 1u
        || getRecordChromaFormat(subsamplingX, subsamplingY) != OUTPUT_CHROMA_FORMAT) {
        return (ERROR_STREAM_FORMAT << ERROR_CODE_SHIFT) | ((bitDepth & 0xFFFFu) << 8u) | ((subsamplingX & 0xFu) << 4u) | (subsamplingY & 0xFu);
    }
    let upscaledWidth = readRecordWord(RECORD_HEADER_UPSCALED_WIDTH);
    let frameHeight = readRecordWord(RECORD_HEADER_FRAME_HEIGHT);
    if (upscaledWidth == 0u || upscaledWidth > stream.width) {
        return getPictureSizeError(upscaledWidth);
    }
    if (frameHeight == 0u || frameHeight > stream.height) {
        return getPictureSizeError(frameHeight);
    }
    // The frames buffer holds exactly its frame buffers, where framesHigh's begin, as the header sizes both
    let bufferWords = getStoreBufferWords();
    if (arrayLength(&frames) != RECORD_FRAME_BUFFERS_LOW * bufferWords
        || arrayLength(&framesHigh) < (RECORD_FRAME_BUFFERS - RECORD_FRAME_BUFFERS_LOW) * bufferWords) {
        return (ERROR_FRAME_BUFFERS << ERROR_CODE_SHIFT) | RECORD_FRAME_BUFFERS_LOW;
    }
    if (!isFrameBufferValid(readRecordWord(RECORD_HEADER_OUTPUT_BUFFER), false)) {
        return getRecordInvalidError(RECORD_INVALID_BUFFER);
    }
    if (kind == RECORD_KIND_SHOW_EXISTING) {
        return 0u;
    }
    return validateDecodeRecord(recordWords);
}

// Entry points: each checks that its pass applies, then calls its family's functions (scratch/av1/DESIGN.md, "Kernel contracts").
// The checks read the frame's validity through workgroup memory, so the families' barriers stay in uniform control flow.

var<workgroup> passControl: u32;
var<workgroup> waveSuperblocks: array<u32, 16>;

// Whether beginFrame accepted the record, as a workgroup uniform value; call it from uniform control flow
fn loadFrameValidity(lane: u32) -> bool {
    if (lane == 0u) {
        passControl = state[STATE_FRAME_VALID];
    }
    return workgroupUniformLoad(&passControl) == 1u;
}

// Whether the record decodes a frame, as a workgroup uniform value
fn loadDecodingFrame(lane: u32) -> bool {
    return loadFrameValidity(lane) && readRecordWord(RECORD_HEADER_KIND) == RECORD_KIND_DECODE;
}

// Writes the families' constant tables into the frame data buffer once per session: the scratch buffers start zeroed and survive
// resets, and beginFrame marks the tables ready once this dispatch finished
@compute @workgroup_size(64)
fn loadTables(@builtin(workgroup_id) workgroup: vec3u, @builtin(local_invocation_index) lane: u32) {
    if (lane == 0u) {
        passControl = frameData[getTablesOffset() + TABLES_READY_WORD];
    }
    if (workgroupUniformLoad(&passControl) == TABLES_READY_VALUE) {
        return;
    }
    transformLoadTables(workgroup.x, lane);
    intraLoadTables(workgroup.x, lane);
    interLoadTables(workgroup.x, lane);
    filtersLoadTables(workgroup.x, lane);
}

// Checks the record against the session and resets the wavefront; a record it rejects runs no other pass
@compute @workgroup_size(1)
fn beginFrame() {
    state[STATE_FRAME_VALID] = 0u;
    state[STATE_WAVE_EVEN] = 0u;
    // loadTables finished before this dispatch, so every family's tables are complete
    frameData[getTablesOffset() + TABLES_READY_WORD] = TABLES_READY_VALUE;
    let error = validateRecord();
    if (error != 0u) {
        reportDecodeError(error);
        return;
    }
    state[STATE_FRAME_VALID] = 1u;
}

// Fills the frame buffers of the neutral fill mask, references error resilient mode lost, with neutral grey: row y of plane z,
// two samples per lane from x * 128
@compute @workgroup_size(64)
fn fillNeutralReferences(@builtin(workgroup_id) workgroup: vec3u, @builtin(local_invocation_index) lane: u32) {
    if (!isDecodingFrame()) {
        return;
    }
    let mask = readRecordWord(RECORD_HEADER_NEUTRAL_FILL_MASK);
    let plane = workgroup.z;
    let x = workgroup.x * 128u + lane * 2u;
    if (mask == 0u || x >= getStorePlaneWidth(plane) || workgroup.y >= getStorePlaneHeight(plane)) {
        return;
    }
    let neutral = 1u << (readRecordWord(RECORD_HEADER_BIT_DEPTH) - 1u);
    for (var frameBuffer = 0u; frameBuffer < RECORD_FRAME_BUFFERS; frameBuffer += 1u) {
        if (((mask >> frameBuffer) & 1u) == 1u) {
            writeStoreSamplePair(frameBuffer, plane, x, workgroup.y, vec2u(neutral, neutral));
        }
    }
}

// Zeroes the scratch buffer's residuals when an IntraBC or inter-intra job adds a residual over its whole block, which transform
// blocks without coefficients leave unwritten; row y of plane z, two samples per lane from x * 128
@compute @workgroup_size(64)
fn clearResiduals(@builtin(workgroup_id) workgroup: vec3u, @builtin(local_invocation_index) lane: u32) {
    if (!isDecodingFrame() || !hasRecordFlag(RECORD_FLAG_BLOCK_RESIDUALS)) {
        return;
    }
    let plane = workgroup.z;
    let x = workgroup.x * 128u + lane * 2u;
    if (x >= getStorePlaneWidth(plane) || workgroup.y >= getStorePlaneHeight(plane)) {
        return;
    }
    writeFrameWord(getStoreWordIndex(readRecordWord(RECORD_HEADER_SCRATCH_BUFFER), plane, x, workgroup.y), 0u);
}

// Writes the mode info map: each workgroup takes blocks workgroup.x, workgroup.x + workgroup count, ..., and its lanes take each
// block's 4x4 luma units within the frame's mode info grid
@compute @workgroup_size(64)
fn expandBlocks(@builtin(workgroup_id) workgroup: vec3u, @builtin(num_workgroups) workgroupCount: vec3u, @builtin(local_invocation_index) lane: u32) {
    if (!isDecodingFrame()) {
        return;
    }
    let blockCount = readRecordWord(RECORD_HEADER_BLOCK_COUNT);
    let miColumns = readRecordWord(RECORD_HEADER_MI_COLUMNS);
    let miRows = readRecordWord(RECORD_HEADER_MI_ROWS);
    let losslessMask = readRecordWord(RECORD_HEADER_SEGMENT_LOSSLESS_MASK);
    for (var blockIndex = workgroup.x; blockIndex < blockCount; blockIndex += workgroupCount.x) {
        let position = readBlockWord(blockIndex, RECORD_BLOCK_POSITION);
        let transform = readBlockWord(blockIndex, RECORD_BLOCK_TRANSFORM);
        let blockSize = getField(position, RECORD_BLOCK_SIZE_SHIFT, RECORD_BLOCK_SIZE_BITS);
        if (blockSize >= BLOCK_SIZES_ALL) {
            continue;
        }
        let miRow = getField(position, RECORD_BLOCK_MI_ROW_SHIFT, RECORD_BLOCK_MI_BITS);
        let miColumn = getField(position, RECORD_BLOCK_MI_COLUMN_SHIFT, RECORD_BLOCK_MI_BITS);
        let inter = getField(position, RECORD_BLOCK_INTER_SHIFT, 1u);
        let skip = getField(position, RECORD_BLOCK_SKIP_SHIFT, 1u);
        let lossless = (losslessMask >> getField(transform, RECORD_BLOCK_SEGMENT_SHIFT, RECORD_BLOCK_SEGMENT_BITS)) & 1u;
        // The loop filter reads TX_4X4 for lossless blocks, and an inter block with a residual's own transform partition
        var blockTransformSize = getField(transform, RECORD_BLOCK_TX_SIZE_SHIFT, RECORD_BLOCK_TX_SIZE_BITS);
        if (lossless == 1u) {
            blockTransformSize = TX_4X4;
        }
        var variableTransformWord = RECORD_MISSING;
        if (lossless == 0u && inter == 1u && skip == 0u) {
            variableTransformWord = getBlockExtensionWordIndex(blockIndex, RECORD_BLOCK_HAS_VARIABLE_TX_SHIFT);
        }
        let widthLog2 = getBlockWidthLog2(blockSize) - MI_SIZE_LOG2;
        let heightLog2 = getBlockHeightLog2(blockSize) - MI_SIZE_LOG2;
        let mapWord = blockIndex | (skip << MODE_INFO_SKIP_SHIFT) | ((skip & inter) << MODE_INFO_SKIP_INTER_SHIFT)
            | (inter << MODE_INFO_INTER_SHIFT);
        for (var unit = lane; unit < (1u << (widthLog2 + heightLog2)); unit += 64u) {
            let rowInBlock = unit >> widthLog2;
            let columnInBlock = unit & ((1u << widthLog2) - 1u);
            let row = miRow + rowInBlock;
            let column = miColumn + columnInBlock;
            if (row >= miRows || column >= miColumns) {
                continue;
            }
            var transformSize = blockTransformSize;
            if (variableTransformWord != RECORD_MISSING) {
                let index = getVariableTransformIndex(blockSize, rowInBlock, columnInBlock);
                transformSize = (readRecordWord(variableTransformWord + (index >> 2u)) >> ((index & 3u) * 8u)) & 0xFFu;
            }
            frameData[getModeInfoWordIndex(row, column)] = mapWord | (min(transformSize, TX_SIZES_ALL - 1u) << MODE_INFO_TX_SIZE_SHIFT);
        }
    }
}

// Predicts every inter block, the inter part of inter-intra blocks included, into the target buffer: every plane of 16x16 luma tile (x, y)
@compute @workgroup_size(64)
fn predictInter(@builtin(workgroup_id) workgroup: vec3u, @builtin(local_invocation_index) lane: u32) {
    if (!loadDecodingFrame(lane)) {
        return;
    }
    interPredictTile(workgroup, lane);
}

// Inverse transforms the transform jobs before RECORD_HEADER_TRANSFORM_LARGE_JOB, those without a 64-point side, adding inter
// blocks' residuals to their predictions and writing the others' residuals
@compute @workgroup_size(64)
fn inverseTransform(@builtin(workgroup_id) workgroup: vec3u, @builtin(num_workgroups) workgroupCount: vec3u, @builtin(local_invocation_index) lane: u32) {
    if (!loadDecodingFrame(lane)) {
        return;
    }
    transformRunSmallJobs(workgroup.x, workgroupCount.x, lane);
}

// Inverse transforms the jobs from RECORD_HEADER_TRANSFORM_LARGE_JOB on, those with a 64-point side, in a pass of their own, so the
// 64-point transforms compile into a kernel of their own; the two passes write disjoint blocks, so either may run first
@compute @workgroup_size(64)
fn inverseTransformLarge(@builtin(workgroup_id) workgroup: vec3u, @builtin(num_workgroups) workgroupCount: vec3u, @builtin(local_invocation_index) lane: u32) {
    if (!loadDecodingFrame(lane)) {
        return;
    }
    transformRunLargeJobs(workgroup.x, workgroupCount.x, lane);
}

// Reconstructs one wave of the intra wavefront: workgroup (x, y, z) takes superblock row x of plane z and its superblocks of tile
// columns y, y + WAVE_TILE_COLUMN_SLOTS, ..., each the one at local column wave - lag - slope x local row of its tile, if inside it
fn reconstructWave(wave: u32, workgroup: vec3u, lane: u32) {
    let plane = workgroup.z;
    let superblockRow = workgroup.x;
    // One invocation picks the superblocks, so every barrier of the job lists stays in uniform control flow
    if (lane == 0u) {
        var count = 0u;
        let lag = select(RECORD_WAVE_CHROMA_LAG, 0u, plane == PLANE_Y);
        let planeExists = plane == PLANE_Y || !hasRecordFlag(RECORD_FLAG_MONOCHROME);
        if (isDecodingFrame() && planeExists && wave < readRecordWord(RECORD_HEADER_WAVE_COUNT) && wave >= lag
            && superblockRow < readRecordWord(RECORD_HEADER_SUPERBLOCK_ROWS)) {
            // The superblock row's tile row, and its row within that tile
            var tileRow = 0u;
            let tileRows = readRecordWord(RECORD_HEADER_TILE_ROWS);
            while (tileRow + 1u < tileRows && readRecordWord(RECORD_HEADER_TILE_ROW_STARTS + tileRow + 1u) <= superblockRow) {
                tileRow += 1u;
            }
            let localRow = superblockRow - readRecordWord(RECORD_HEADER_TILE_ROW_STARTS + tileRow);
            let rowStart = readRecordWord(RECORD_HEADER_WAVE_SLOPE) * localRow;
            if (wave - lag >= rowStart) {
                let localColumn = wave - lag - rowStart;
                let superblockColumns = readRecordWord(RECORD_HEADER_SUPERBLOCK_COLUMNS);
                let tileColumns = readRecordWord(RECORD_HEADER_TILE_COLUMNS);
                for (var tileColumn = workgroup.y; tileColumn < tileColumns; tileColumn += WAVE_TILE_COLUMN_SLOTS) {
                    let firstColumn = readRecordWord(RECORD_HEADER_TILE_COLUMN_STARTS + tileColumn);
                    let endColumn = readRecordWord(RECORD_HEADER_TILE_COLUMN_STARTS + tileColumn + 1u);
                    if (firstColumn + localColumn < endColumn) {
                        waveSuperblocks[count] = superblockRow * superblockColumns + firstColumn + localColumn;
                        count += 1u;
                    }
                }
            }
        }
        passControl = count;
    }
    let count = workgroupUniformLoad(&passControl);
    for (var index = 0u; index < count; index += 1u) {
        intraReconstructSuperblock(workgroupUniformLoad(&waveSuperblocks[index]), plane, lane);
    }
}

// One wave of the intra wavefront. Both dispatches of a pair run this entry point, so the wavefront compiles once: the even one
// (WAVE_TILE_COLUMN_SLOTS workgroup columns) takes its wave index from the even counter and hands the next to the odd counter, and the
// odd one (a column more, whose workgroups return at once) the other way round, so no dispatch writes the counter it reads
@compute @workgroup_size(64)
fn predictIntra(@builtin(workgroup_id) workgroup: vec3u, @builtin(num_workgroups) workgroupCount: vec3u, @builtin(local_invocation_index) lane: u32) {
    if (workgroup.y >= WAVE_TILE_COLUMN_SLOTS) {
        return;
    }
    let odd = workgroupCount.y > WAVE_TILE_COLUMN_SLOTS;
    if (lane == 0u) {
        passControl = state[select(STATE_WAVE_EVEN, STATE_WAVE_ODD, odd)];
    }
    let wave = workgroupUniformLoad(&passControl);
    reconstructWave(wave, workgroup, lane);
    if (lane == 0u && all(workgroup == vec3u(0u))) {
        state[select(STATE_WAVE_ODD, STATE_WAVE_EVEN, odd)] = wave + 1u;
    }
}

// Whether a filter pass of the record runs, as a workgroup uniform value
fn loadFilterPass(lane: u32, flag: u32) -> bool {
    return loadDecodingFrame(lane) && hasRecordFlag(flag);
}

// Filters the vertical edges of a 64x64 luma area of plane z in place in the target buffer
@compute @workgroup_size(64)
fn deblockVertical(@builtin(workgroup_id) workgroup: vec3u, @builtin(local_invocation_index) lane: u32) {
    if (!loadFilterPass(lane, RECORD_FLAG_DEBLOCK)) {
        return;
    }
    deblockVerticalEdges(workgroup, lane);
}

// Filters the horizontal edges of a 64x64 luma area of plane z in place, once every vertical edge of the frame is filtered
@compute @workgroup_size(64)
fn deblockHorizontal(@builtin(workgroup_id) workgroup: vec3u, @builtin(local_invocation_index) lane: u32) {
    if (!loadFilterPass(lane, RECORD_FLAG_DEBLOCK)) {
        return;
    }
    deblockHorizontalEdges(workgroup, lane);
}

// Saves the deblocked rows around each loop restoration stripe boundary, upscaled when super-resolution runs
@compute @workgroup_size(64)
fn saveRestorationBoundaries(@builtin(workgroup_id) workgroup: vec3u, @builtin(local_invocation_index) lane: u32) {
    if (!loadFilterPass(lane, RECORD_FLAG_RESTORATION)) {
        return;
    }
    restorationSaveBoundaries(workgroup, lane);
}

// Applies CDEF from the CDEF source to the CDEF target: a 64x64 luma area of plane z
@compute @workgroup_size(64)
fn applyCdef(@builtin(workgroup_id) workgroup: vec3u, @builtin(local_invocation_index) lane: u32) {
    if (!loadFilterPass(lane, RECORD_FLAG_CDEF)) {
        return;
    }
    cdefFilterBlock(workgroup, lane);
}

// Upscales the super-resolution source into the super-resolution target: 256 samples of 16 rows from y * 16 of plane z
@compute @workgroup_size(64)
fn applySuperres(@builtin(workgroup_id) workgroup: vec3u, @builtin(local_invocation_index) lane: u32) {
    if (!loadFilterPass(lane, RECORD_FLAG_SUPERRES)) {
        return;
    }
    superresUpscaleRow(workgroup, lane);
}

// Restores from the restoration source into the restoration target: a 64x64 area of plane z
@compute @workgroup_size(64)
fn applyLoopRestoration(@builtin(workgroup_id) workgroup: vec3u, @builtin(local_invocation_index) lane: u32) {
    if (!loadFilterPass(lane, RECORD_FLAG_RESTORATION)) {
        return;
    }
    restorationFilterUnit(workgroup, lane);
}

// Whether the record writes the output slot, as a workgroup uniform value: an accepted record of a presented frame
fn loadOutputtingFrame(lane: u32) -> bool {
    return loadFrameValidity(lane) && hasRecordFlag(RECORD_FLAG_SHOW_FRAME);
}

// Generates the frame's grain templates and scaling tables when it presents with film grain
@compute @workgroup_size(64)
fn generateFilmGrain(@builtin(local_invocation_index) lane: u32) {
    if (!loadOutputtingFrame(lane) || !hasRecordFlag(RECORD_FLAG_FILM_GRAIN)) {
        return;
    }
    grainGenerate(lane);
}

// Copies the output buffer into the output slot with film grain, or neutral chroma for 4:0:0: 128 samples of row y of plane z
@compute @workgroup_size(64)
fn writeOutput(@builtin(workgroup_id) workgroup: vec3u, @builtin(local_invocation_index) lane: u32) {
    if (!loadOutputtingFrame(lane)) {
        return;
    }
    outputWriteRow(workgroup, lane);
}
