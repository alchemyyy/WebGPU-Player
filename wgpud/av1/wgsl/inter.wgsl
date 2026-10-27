// AV1 inter family: motion compensation with scaled references and dual filters, compound average, distance, wedge, and
// difference-weighted prediction, inter-intra, OBMC, local and global warp, and IntraBC. Owner: av1-gpu-inter;
// scratch/av1/DESIGN.md specifies its functions, prefixes, and record fields.
// Every function reproduces libaom's decoder (av1/decoder/decodeframe.c with av1/common/reconinter.c, convolve.c, and warped_motion.c) bit for bit at 8, 10, and 12 bits.
// libaom never extends a reference's borders while it decodes: every sample it reads for a prediction inside the frame's mode info grid is the reference plane's sample at coordinates clamped to the plane's frame.
// That also makes its motion vector clamp and its scaled position clamp no-ops, so these passes clamp coordinates and predict from the unclamped motion.
// Every convolution path of libaom (two-dimensional, horizontal, vertical, copy, scaled) equals one two-pass formula whose zero phase kernel is {0, 0, 0, 128, 0, 0, 0, 0}.
// Its horizontal pass rounds to the intermediate precision; a single prediction rounds the vertical pass's sum to a sample, and a compound one keeps it at 16 bits for its blend.

// libaom's sub-sample precisions (aom_dsp/aom_filter.h): motion vectors in 1/8 luma sample, filter phases in 1/16 sample, positions in 1/1024 sample
const INTER_SUBPEL_BITS: u32 = 4u;
const INTER_SUBPEL_MASK: i32 = 15;
const INTER_SCALE_SUBPEL_BITS: u32 = 10u;
const INTER_SCALE_SUBPEL_MASK: i32 = 1023;
const INTER_SCALE_EXTRA_BITS: u32 = 6u;
const INTER_SCALE_EXTRA_OFFSET: i32 = 32;
const INTER_UNSCALED_STEP: i32 = 1024;
// A motion vector's 1/8 luma sample steps in a plane's 1/16 sample units: doubled unless the plane is subsampled
const INTER_MOTION_VECTOR_PLANE_SHIFT: u32 = 1u;
const INTER_MOTION_VECTOR_BITS: u32 = 16u;
const INTER_MOTION_VECTOR_ROW_SHIFT: u32 = 0u;
const INTER_MOTION_VECTOR_COLUMN_SHIFT: u32 = 16u;

// libaom's reference scale factors (av1/common/scale.h): 14-bit fixed point, 1 << 14 when unscaled.
// av1_scaled_x offsets the product by (scale - (1 << 14)) * 8 and rounds it by 8 bits, and the step rounds the scale to 1/1024 sample.
const INTER_REFERENCE_NO_SCALE: i32 = 16384;
const INTER_SCALE_OFFSET_MULTIPLIER: i32 = 8;
const INTER_SCALE_ROUND_BITS: u32 = 8u;
const INTER_SCALE_ROUND_MASK: i32 = 255;
const INTER_SCALE_ROUND_HALF: i32 = 128;
const INTER_STEP_ROUND_BITS: u32 = 4u;

// libaom's convolution (av1/common/convolve.h, get_conv_params_no_round): 7-bit kernels of 8 taps.
// The horizontal pass rounds by 3 bits (5 at 12 bits, so its result fits 16 bits); the vertical pass rounds a single prediction to the sample scale and a compound one by 7 bits.
const INTER_FILTER_BITS: u32 = 7u;
const INTER_FILTER_TAPS: i32 = 8;
const INTER_FILTER_FIRST_TAP: i32 = -3;
const INTER_ROUND0_BITS: u32 = 3u;
const INTER_INTERMEDIATE_BITS: u32 = 16u;
const INTER_INTERMEDIATE_HEADROOM_BITS: u32 = 2u;
const INTER_COMPOUND_ROUND1_BITS: u32 = 7u;
const INTER_ROUND_0: u32 = max(INTER_ROUND0_BITS, OUTPUT_BIT_DEPTH + INTER_FILTER_BITS + INTER_INTERMEDIATE_HEADROOM_BITS - INTER_INTERMEDIATE_BITS);
const INTER_ROUND_0_HALF: i32 = 1 << (INTER_ROUND_0 - 1u);
const INTER_SINGLE_ROUND_1: u32 = 2u * INTER_FILTER_BITS - INTER_ROUND_0;
const INTER_SINGLE_ROUND_1_HALF: i32 = 1 << (INTER_SINGLE_ROUND_1 - 1u);
const INTER_COMPOUND_ROUND1_HALF: i32 = 1 << (INTER_COMPOUND_ROUND1_BITS - 1u);
const INTER_OFFSET_BITS: u32 = OUTPUT_BIT_DEPTH + 2u * INTER_FILTER_BITS - INTER_ROUND_0;
const INTER_HORIZONTAL_OFFSET: i32 = 1 << (OUTPUT_BIT_DEPTH + INTER_FILTER_BITS - 1u);
const INTER_VERTICAL_OFFSET: i32 = 1 << INTER_OFFSET_BITS;
// What a single prediction subtracts after its vertical pass: (1 << bd) + (1 << (bd - 1))
const INTER_SINGLE_OFFSET: i32 = (1 << OUTPUT_BIT_DEPTH) + (1 << (OUTPUT_BIT_DEPTH - 1u));
// What a compound prediction subtracts after its blend, and the bits it then rounds by
const INTER_COMPOUND_OFFSET: i32 = (1 << (INTER_OFFSET_BITS - INTER_COMPOUND_ROUND1_BITS)) + (1 << (INTER_OFFSET_BITS - INTER_COMPOUND_ROUND1_BITS - 1u));
const INTER_COMPOUND_ROUND_BITS: u32 = 2u * INTER_FILTER_BITS - INTER_ROUND_0 - INTER_COMPOUND_ROUND1_BITS;
const INTER_COMPOUND_ROUND_HALF: i32 = 1 << (INTER_COMPOUND_ROUND_BITS - 1u);
const INTER_SAMPLE_MAXIMUM: i32 = (1 << OUTPUT_BIT_DEPTH) - 1;

// libaom's blends (aom_dsp/blend.h): 6-bit alpha up to 64.
// The difference-weighted mask (reconinter.c, diffwtd_mask_d16) is 38 plus the rounded difference over 16, rounded by more bits above 8 bits.
const INTER_BLEND_BITS: u32 = 6u;
const INTER_BLEND_MAXIMUM: i32 = 64;
const INTER_BLEND_HALF: i32 = 32;
const INTER_DIFFERENCE_MASK_BASE: i32 = 38;
const INTER_DIFFERENCE_FACTOR_BITS: u32 = 4u;
const INTER_BASE_BIT_DEPTH: u32 = 8u;
const INTER_DIFFERENCE_ROUND_BITS: u32 = INTER_COMPOUND_ROUND_BITS + OUTPUT_BIT_DEPTH - INTER_BASE_BIT_DEPTH;
const INTER_DIFFERENCE_ROUND_HALF: i32 = 1 << (INTER_DIFFERENCE_ROUND_BITS - 1u);
const INTER_DISTANCE_BITS: u32 = 4u;

// libaom's InterpFilter values and the tables' kernels: the four 8-tap kernels in filter order, then the 4-tap regular and smooth kernels
// av1_get_interp_filter_params_with_block_size takes for a side of at most 4 samples (sharp takes the regular one, bilinear its own)
const INTER_FILTER_SMOOTH: u32 = 1u;
const INTER_FILTER_BILINEAR: u32 = 3u;
const INTER_KERNEL_REGULAR_4: u32 = 4u;
const INTER_KERNEL_SMOOTH_4: u32 = 5u;
const INTER_KERNEL_COUNT: u32 = 6u;
const INTER_KERNEL_PHASES: u32 = 16u;
const INTER_KERNEL_WORDS: u32 = 4u;
const INTER_FOUR_TAP_MAXIMUM_SIZE: u32 = 4u;
const INTER_FILTER_FIELD_BITS: u32 = 2u * RECORD_BLOCK_FILTER_BITS;

// libaom's warp (av1/common/warped_motion.c, mv.h): a 16-bit model, 8x8 blocks projected at their center, shear phases reduced to 6 bits
// and rounded by 10 bits into the 193 kernels of av1_warped_filter, offset by 64
const INTER_WARP_MODEL_BITS: u32 = 16u;
const INTER_WARP_MODEL_MASK: i32 = 65535;
const INTER_WARP_PARAMETER_MASK: i32 = -64;
const INTER_WARP_PHASE_BITS: u32 = 10u;
const INTER_WARP_PHASE_HALF: i32 = 512;
const INTER_WARP_PHASE_OFFSET: i32 = 64;
const INTER_WARP_BLOCK_MASK: u32 = 7u;
const INTER_WARP_BLOCK_CENTER: i32 = 4;
const INTER_WARP_MINIMUM_SIZE: u32 = 8u;
const INTER_WARP_FILTER_ENTRIES: u32 = 193u;
const INTER_WARP_FILTER_WORDS: u32 = 2u;
// The warp's record words: six matrix entries, then alpha and beta, then gamma and delta
const INTER_WARP_ALPHA_BETA_WORD: u32 = 6u;
const INTER_WARP_GAMMA_DELTA_WORD: u32 = 7u;
const INTER_WARP_PARAMETER_BITS: u32 = 16u;

// libaom's OBMC (av1/common/obmc.h, reconinter.c, decodeframe.c): at most 4 neighbors per side (max_neighbor_obmc), neighbor steps of at most
// 64 samples, an overlap of half the block's side up to 64 samples, predictions of at least 4 samples, and no blend from above for plane
// blocks of at most 32 samples (av1_skip_u4x4_pred_in_obmc)
const INTER_OBMC_MAXIMUM_NEIGHBORS: u32 = 4u;
const INTER_OBMC_STEP_LIMIT: u32 = 16u;
const INTER_OBMC_SIZE_LIMIT: u32 = 64u;
const INTER_OBMC_MINIMUM_SIZE: u32 = 4u;
const INTER_OBMC_SKIP_ABOVE_AREA: u32 = 32u;
const INTER_OBMC_MASK_BYTES: u32 = 127u;

// libaom's inter-intra (av1/common/reconinter.c): INTERINTRA_MODE values, the DC weight, the weights' scale 128 / max(width, height),
// and the wedge sign it always takes (INTERINTRA_WEDGE_SIGN)
const INTER_INTERINTRA_VERTICAL: u32 = 1u;
const INTER_INTERINTRA_HORIZONTAL: u32 = 2u;
const INTER_INTERINTRA_SMOOTH: u32 = 3u;
const INTER_INTERINTRA_DC_WEIGHT: u32 = 32u;
const INTER_INTERINTRA_SCALE_LOG2: u32 = 7u;
const INTER_INTERINTRA_WEDGE_SIGN: u32 = 0u;
const INTER_INTERINTRA_WEIGHT_BYTES: u32 = 128u;

// libaom's COMPOUND_TYPE and MOTION_MODE values
const INTER_COMPOUND_DISTANCE: u32 = 1u;
const INTER_COMPOUND_WEDGE: u32 = 2u;
const INTER_COMPOUND_DIFFERENCE: u32 = 3u;
const INTER_MOTION_OBMC: u32 = 1u;

// The record's reference fields are libaom's MV_REFERENCE_FRAME + 1: 0 none, 1 intra, then LAST_FRAME (1) to ALTREF_FRAME
const INTER_LAST_FRAME: u32 = 1u;
const INTER_REFERENCE_FIELD_FIRST: u32 = INTER_LAST_FRAME + RECORD_BLOCK_REFERENCE_BIAS;
// A superblock's 4x4 units per side, log2: 16 (64x64) or 32 (128x128); and the bits of a tile index in a superblock's tile word
const INTER_SUPERBLOCK_64_UNITS_LOG2: u32 = 4u;
const INTER_SUPERBLOCK_128_UNITS_LOG2: u32 = 5u;
const INTER_TILE_INDEX_BITS: u32 = 8u;

// libaom's wedges (av1/common/reconinter.c, tools/gen_wedge_masks_data.py): 16 per block size of 8 to 32 samples per side and two signs,
// cut from 64x64 master masks along 6 directions at the codebook's offsets in 1/8 of the block
const INTER_WEDGE_TYPES: u32 = 16u;
const INTER_WEDGE_BLOCK_SIZES: u32 = 9u;
const INTER_WEDGE_SIGN_AREA_LOG2: u32 = 5u;
const INTER_WEDGE_MASTER_CENTER: u32 = 32u;
const INTER_WEDGE_MASTER_LAST: i32 = 63;
const INTER_WEDGE_MASTER_SHIFT: i32 = 16;
const INTER_WEDGE_OFFSET_BITS: u32 = 3u;
const INTER_WEDGE_BYTES: u32 = 100352u;
const INTER_WEDGE_HORIZONTAL: u32 = 0u;
const INTER_WEDGE_VERTICAL: u32 = 1u;
const INTER_WEDGE_OBLIQUE27: u32 = 2u;
const INTER_WEDGE_OBLIQUE63: u32 = 3u;
const INTER_WEDGE_OBLIQUE117: u32 = 4u;

// The inter tables area (INTER_TABLES_OFFSET of the frame data's tables): interpolation kernels (two signed taps per word), warp kernels
// (four signed taps per word), OBMC masks, inter-intra weights, and wedge masks (four bytes per word, in byte order)
const INTER_BYTES_PER_WORD: u32 = 4u;
const INTER_BYTE_BITS: u32 = 8u;
const INTER_BYTE_MASK: u32 = 255u;
const INTER_SIGNED_BYTE_SHIFT: u32 = 24u;
const INTER_TABLE_KERNELS: u32 = 0u;
const INTER_TABLE_WARP_FILTER: u32 = INTER_TABLE_KERNELS + INTER_KERNEL_COUNT * INTER_KERNEL_PHASES * INTER_KERNEL_WORDS;
const INTER_TABLE_OBMC_MASKS: u32 = INTER_TABLE_WARP_FILTER + INTER_WARP_FILTER_ENTRIES * INTER_WARP_FILTER_WORDS;
const INTER_TABLE_INTERINTRA_WEIGHTS: u32 = INTER_TABLE_OBMC_MASKS + (INTER_OBMC_MASK_BYTES + INTER_BYTES_PER_WORD - 1u) / INTER_BYTES_PER_WORD;
const INTER_TABLE_WEDGE_MASKS: u32 = INTER_TABLE_INTERINTRA_WEIGHTS + INTER_INTERINTRA_WEIGHT_BYTES / INTER_BYTES_PER_WORD;
const INTER_TABLE_WORDS: u32 = INTER_TABLE_WEDGE_MASKS + INTER_WEDGE_BYTES / INTER_BYTES_PER_WORD;
const INTER_LOADER_WORKGROUPS: u32 = 64u;

// The session's chroma subsampling, from its output format (4:0:0 decodes as 4:2:0 without chroma prediction)
const INTER_CHROMA_SUBSAMPLING_X: u32 = select(0u, 1u, OUTPUT_CHROMA_FORMAT != 3u);
const INTER_CHROMA_SUBSAMPLING_Y: u32 = select(0u, 1u, OUTPUT_CHROMA_FORMAT == 1u);

// predictInter's tiles: 16x16 luma samples, every plane of them in one workgroup of 64 lanes, which first describe each of the tile's
// sixteen 4x4 luma units (its prediction mode and up to four prediction terms: the main prediction, the second reference's, OBMC's
// above neighbor's, and OBMC's left neighbor's), then stage the terms' horizontal passes, then predict sample pairs
const INTER_WORKGROUP_SIZE: u32 = 64u;
const INTER_TILE_SIZE_LOG2: u32 = 4u;
const INTER_TILE_UNIT_COLUMNS_LOG2: u32 = 2u;
const INTER_TILE_UNITS: u32 = 16u;
const INTER_TILE_LUMA_SAMPLES: u32 = 256u;
const INTER_UNIT_TERMS: u32 = 4u;
const INTER_TERM_MAIN: u32 = 0u;
const INTER_TERM_SECOND: u32 = 1u;
const INTER_TERM_ABOVE: u32 = 2u;
const INTER_TERM_LEFT: u32 = 3u;
const INTER_QUAD_SIZE: i32 = 4;
const INTER_QUAD_OFFSETS: vec4<i32> = vec4<i32>(0, 1, 2, 3);
const INTER_MINIMUM_PLANE_BLOCK: u32 = 4u;
// The 4x4 units of the largest block's side (128 samples)
const INTER_MAXIMUM_BLOCK_UNITS: u32 = 32u;

// A unit's control word: valid, prediction mode, OBMC's above and left overlaps in plane samples (0 without that neighbor), the
// difference-weighted mask's inversion, and the distance weights
const INTER_UNIT_VALID_SHIFT: u32 = 0u;
const INTER_UNIT_MODE_SHIFT: u32 = 1u;
const INTER_UNIT_MODE_BITS: u32 = 3u;
const INTER_UNIT_ABOVE_OVERLAP_SHIFT: u32 = 4u;
const INTER_UNIT_LEFT_OVERLAP_SHIFT: u32 = 10u;
const INTER_UNIT_OVERLAP_BITS: u32 = 6u;
const INTER_UNIT_INVERSE_SHIFT: u32 = 16u;
const INTER_UNIT_FORWARD_SHIFT: u32 = 17u;
const INTER_UNIT_BACKWARD_SHIFT: u32 = 21u;
const INTER_UNIT_WEIGHT_BITS: u32 = 4u;
// A unit's shape word: the wedge's first byte in the wedge table and its stride's log2 (the luma block's width), then the first unit of
// each of its terms' regions (main and second, above, left), which holds their staging slots
const INTER_UNIT_WEDGE_BITS: u32 = 17u;
const INTER_UNIT_STRIDE_SHIFT: u32 = 17u;
const INTER_UNIT_STRIDE_BITS: u32 = 3u;
const INTER_UNIT_OWNERS_SHIFT: u32 = 20u;
const INTER_UNIT_OWNER_BITS: u32 = 4u;
// Prediction modes of a unit
const INTER_MODE_SINGLE: u32 = 0u;
const INTER_MODE_AVERAGE: u32 = 1u;
const INTER_MODE_DISTANCE: u32 = 2u;
const INTER_MODE_WEDGE: u32 = 3u;
const INTER_MODE_DIFFERENCE: u32 = 4u;

// The tile's units of every plane: unit u of plane p is unit plane p * 16 + u, so the lanes set up all three planes at once
const INTER_UNIT_PLANES: u32 = INTER_TILE_UNITS * RECORD_PLANES;

// A prediction term: one reference's prediction of a prediction block (plane origin and size), translated or warped.
// Translation keeps the origin sample's reference position in 1/1024 sample (its reference's steps give the other samples'); warp keeps the
// record word of its model. Its control word holds whether it warps, its kernels, whether it scales, its reference, and the size of the
// rectangle it stages from its origin (width and height log2): the prediction block, or OBMC's overlap with its neighbor.
const INTER_TERM_WORDS: u32 = 4u;
const INTER_TERM_CONTROL: u32 = 0u;
const INTER_TERM_ORIGIN: u32 = 1u;
const INTER_TERM_POSITION_X: u32 = 2u;
const INTER_TERM_WARP_WORD: u32 = 2u;
const INTER_TERM_POSITION_Y: u32 = 3u;
const INTER_TERM_WARP_SHIFT: u32 = 0u;
const INTER_TERM_KERNEL_X_SHIFT: u32 = 1u;
const INTER_TERM_KERNEL_Y_SHIFT: u32 = 4u;
const INTER_TERM_KERNEL_BITS: u32 = 3u;
const INTER_TERM_SCALED_SHIFT: u32 = 7u;
const INTER_TERM_REFERENCE_SHIFT: u32 = 8u;
const INTER_TERM_REFERENCE_BITS: u32 = 3u;
const INTER_TERM_STAGED_WIDTH_SHIFT: u32 = 11u;
const INTER_TERM_STAGED_HEIGHT_SHIFT: u32 = 14u;
const INTER_TERM_STAGED_BITS: u32 = 3u;

// A reference's words in the tile: its store base in each plane, its last sample (column, then row from bit 16) in luma and in chroma, and
// its steps per sample in 1/1024 sample (x, then y from bit 16). The lanes after the unit planes' fill them while the others set up units.
const INTER_REFERENCE_WORDS: u32 = 6u;
const INTER_REFERENCE_LAST_SAMPLE: u32 = 3u;
const INTER_REFERENCE_STEPS: u32 = 5u;
const INTER_REFERENCE_FIRST_LANE: u32 = INTER_UNIT_PLANES;

// Staging: every term of a region (its staged rectangle's part of the tile) gets its horizontal pass once per reference row and column
// into workgroup memory, which the vertical pass of every sample of the region reads, instead of eight passes per sample.
// The region's first unit claims the term's slot: its intermediates, two per word, and its items, which all lanes then take in turn.
// A translation item holds up to 8 intermediates of one row; a warp item one of the 15 rows of an 8x8 block's horizontal filter.
// When the tile's slots do not all fit, the tile stages and predicts one plane at a time (no plane can overflow: at most 912 words and
// 232 items, for scaled OBMC blocks), its items after the words the luma masks take.
const INTER_STAGING_SLOTS: u32 = INTER_UNIT_PLANES * INTER_UNIT_TERMS;
const INTER_STAGING_WORDS: u32 = 1024u;
const INTER_STAGING_ITEMS: u32 = 512u;
const INTER_ITEM_INTERMEDIATES_LOG2: u32 = 3u;
// The last sample a translation item's horizontal passes read, from its first tap's column
const INTER_ITEM_LAST_SAMPLE: i32 = 14;
// An item's entry (16 bits, two per word): its slot and its index in the slot; claims take even item counts, so each owns its words
const INTER_ITEM_SLOT_BITS: u32 = 8u;
const INTER_ITEM_NONE: u32 = 65535u;
// The claims counter: intermediate words claimed, and items claimed from bit 16
const INTER_CLAIM_ITEMS_SHIFT: u32 = 16u;
const INTER_CLAIM_WORDS_MASK: u32 = 65535u;
// A slot's word: its first intermediate word, all ones when the slot does not stage
const INTER_SLOT_NONE: u32 = 4294967295u;
// A warp block's staged rows (libaom's k = -7 to 7, so row 7 is the center's) and their words
const INTER_WARP_ROWS: u32 = 15u;
const INTER_WARP_ROW_CENTER: i32 = 7;
const INTER_WARP_BLOCK_LOG2: u32 = 3u;
const INTER_WARP_ROW_WORDS: u32 = 4u;
const INTER_WARP_BLOCK_WORDS: u32 = INTER_WARP_ROWS * INTER_WARP_ROW_WORDS;
// The luma difference-weighted masks of the tile, two per word (a sample pair's); they take the first items' words once the tile has staged
const INTER_LUMA_MASK_WORDS: u32 = INTER_TILE_LUMA_SAMPLES / 2u;
const INTER_SCRATCH_WORDS: u32 = max(INTER_STAGING_ITEMS / 2u, INTER_LUMA_MASK_WORDS);
const INTER_PLANE_ROUND_FIRST_ITEM: u32 = INTER_LUMA_MASK_WORDS * 2u;
// A staging round's prediction phases: luma (or the round's one plane), then the chroma planes
const INTER_PREDICTION_PHASES: u32 = 2u;

// The inter tables' source, which interLoadTables expands into the frame data's inter tables area: libaom's tables packed four bytes per
// word (the first in the low byte), printed from libaom by scratch/av1/gpu-inter/tools/extract-tables.mjs, in parts:
// - kernels: av1/common/filter.h av1_sub_pel_filters_8, _8smooth, _8sharp, av1_bilinear_filters, av1_sub_pel_filters_4, and _4smooth,
//   16 phases of 8 signed taps each, the unit tap 128 as 0x80 (no tap is -128)
// - copied as they are: av1/common/warped_motion.c av1_warped_filter (193 phases of 8 signed taps), then av1/common/reconinter.c
//   obmc_mask_1 to obmc_mask_64 (each of length n at index n - 1, then a zero byte), then ii_weights1d
// - wedge masters: tools/gen_wedge_masks_data.py WEDGE_MASTER_OBLIQUE_ODD, WEDGE_MASTER_OBLIQUE_EVEN, and WEDGE_MASTER_VERTICAL
//   (av1/common/reconinter.c's wedge_master_* masks)
// - sign flips: av1/common/reconinter.c wedge_signflip_lookup of the block sizes with wedges in the wedge table's order, 16 bits each,
//   two per word
// - codebooks: av1/common/reconinter.c wedge_codebook_16_heqw, _hgtw, and _hltw (blocks as wide as high, higher, and wider), a byte
//   per wedge: its WedgeDirectionType (3 bits), then its x and y offsets in 1/4 of the block (2 bits each)
const INTER_SOURCE_KERNELS: u32 = 0u;
const INTER_SOURCE_COPIED: u32 = 192u;
const INTER_SOURCE_WEDGE_MASTERS: u32 = 642u;
const INTER_SOURCE_SIGN_FLIPS: u32 = 690u;
const INTER_SOURCE_CODEBOOKS: u32 = 695u;
const INTER_SOURCE_WORDS: u32 = 707u;
const INTER_TABLE_SOURCE = array<u32, INTER_SOURCE_WORDS>(
    0x80000000u, 0x00000000u, 0x7efa0200u, 0x0000fe08u, 0x7af60200u, 0x0000fc12u, 0x74f40200u, 0x0002f81cu,
    0x6ef20200u, 0x0002f626u, 0x66f20200u, 0x0002f430u, 0x5ef00200u, 0x0002f43au, 0x54f20200u, 0x0002f442u,
    0x4cf20200u, 0x0002f24cu, 0x42f40200u, 0x0002f254u, 0x3af40200u, 0x0002f05eu, 0x30f40200u, 0x0002f266u,
    0x26f60200u, 0x0002f26eu, 0x1cf80200u, 0x0002f474u, 0x12fc0000u, 0x0002f67au, 0x08fe0000u, 0x0002fa7eu,
    0x80000000u, 0x00000000u, 0x3e1c0200u, 0x00000222u, 0x3e1a0000u, 0x00000424u, 0x3e160000u, 0x00000428u,
    0x3c140000u, 0x0000062au, 0x3a120000u, 0x0000082cu, 0x38100000u, 0x00000a2eu, 0x3610fe00u, 0x00000c30u,
    0x340efe00u, 0x00fe0e34u, 0x300c0000u, 0x00fe1036u, 0x2e0a0000u, 0x00001038u, 0x2c080000u, 0x0000123au,
    0x2a060000u, 0x0000143cu, 0x28040000u, 0x0000163eu, 0x24040000u, 0x00001a3eu, 0x22020000u, 0x00021c3eu,
    0x80000000u, 0x00000000u, 0x7efa02feu, 0x0002fe08u, 0x7cf406feu, 0xfe04fa10u, 0x78ee08feu, 0xfe06f61au,
    0x74ea0afcu, 0xfe06f226u, 0x6cea0afcu, 0xfe08ee30u, 0x64e80afcu, 0xfe08ec3cu, 0x5ae80afcu, 0xfe0aea46u,
    0x50e80cfcu, 0xfc0ce850u, 0x46ea0afeu, 0xfc0ae85au, 0x3cec08feu, 0xfc0ae864u, 0x30ee08feu, 0xfc0aea6cu,
    0x26f206feu, 0xfc0aea74u, 0x1af606feu, 0xfe08ee78u, 0x10fa04feu, 0xfe06f47cu, 0x08fe0200u, 0xfe02fa7eu,
    0x80000000u, 0x00000000u, 0x78000000u, 0x00000008u, 0x70000000u, 0x00000010u, 0x68000000u, 0x00000018u,
    0x60000000u, 0x00000020u, 0x58000000u, 0x00000028u, 0x50000000u, 0x00000030u, 0x48000000u, 0x00000038u,
    0x40000000u, 0x00000040u, 0x38000000u, 0x00000048u, 0x30000000u, 0x00000050u, 0x28000000u, 0x00000058u,
    0x20000000u, 0x00000060u, 0x18000000u, 0x00000068u, 0x10000000u, 0x00000070u, 0x08000000u, 0x00000078u,
    0x80000000u, 0x00000000u, 0x7efc0000u, 0x0000fe08u, 0x7af80000u, 0x0000fc12u, 0x74f60000u, 0x0000fa1cu,
    0x6ef40000u, 0x0000f826u, 0x66f40000u, 0x0000f630u, 0x5ef20000u, 0x0000f63au, 0x54f40000u, 0x0000f642u,
    0x4cf40000u, 0x0000f44cu, 0x42f60000u, 0x0000f454u, 0x3af60000u, 0x0000f25eu, 0x30f60000u, 0x0000f466u,
    0x26f80000u, 0x0000f46eu, 0x1cfa0000u, 0x0000f674u, 0x12fc0000u, 0x0000f87au, 0x08fe0000u, 0x0000fc7eu,
    0x80000000u, 0x00000000u, 0x3e1e0000u, 0x00000222u, 0x3e1a0000u, 0x00000424u, 0x3e160000u, 0x00000428u,
    0x3c140000u, 0x0000062au, 0x3a120000u, 0x0000082cu, 0x38100000u, 0x00000a2eu, 0x360e0000u, 0x00000c30u,
    0x340c0000u, 0x00000c34u, 0x300c0000u, 0x00000e36u, 0x2e0a0000u, 0x00001038u, 0x2c080000u, 0x0000123au,
    0x2a060000u, 0x0000143cu, 0x28040000u, 0x0000163eu, 0x24040000u, 0x00001a3eu, 0x22020000u, 0x00001e3eu,
    0x017f0000u, 0x00000000u, 0x027fff00u, 0x00000000u, 0x047ffd01u, 0x000000ffu, 0x067efc01u, 0x000001feu,
    0x087efb01u, 0x000001fdu, 0x0b7dfa01u, 0x000001fcu, 0x0d7cf901u, 0x000001fcu, 0x0f7bf802u, 0x000001fbu,
    0x127af702u, 0x000001fau, 0x1479f602u, 0x000001fau, 0x1678f502u, 0x000002f9u, 0x1977f402u, 0x000002f8u,
    0x1b75f303u, 0x000002f8u, 0x1d74f303u, 0x000002f7u, 0x2072f203u, 0x000003f6u, 0x2371f103u, 0x000002f6u,
    0x256ff103u, 0x000003f5u, 0x286df003u, 0x000003f5u, 0x2a6cf003u, 0x000003f4u, 0x2d6aef04u, 0x000003f3u,
    0x2f68ef04u, 0x000003f3u, 0x3266ef04u, 0x000003f2u, 0x3464ef04u, 0x000003f2u, 0x3762ee04u, 0x000004f1u,
    0x3a60ee04u, 0x000003f1u, 0x3c5eee04u, 0x000004f0u, 0x3f5bee04u, 0x000004f0u, 0x4159ee04u, 0x000004f0u,
    0x4457ee04u, 0x000004efu, 0x4655ee04u, 0x000004efu, 0x4952ee04u, 0x000004efu, 0x4b50ee04u, 0x000004efu,
    0x4e4eee04u, 0x000004eeu, 0x504bef04u, 0x000004eeu, 0x5249ef04u, 0x000004eeu, 0x5546ef04u, 0x000004eeu,
    0x5744ef04u, 0x000004eeu, 0x5941f004u, 0x000004eeu, 0x5b3ff004u, 0x000004eeu, 0x5e3cf004u, 0x000004eeu,
    0x603af103u, 0x000004eeu, 0x6237f104u, 0x000004eeu, 0x6434f203u, 0x000004efu, 0x6632f203u, 0x000004efu,
    0x682ff303u, 0x000004efu, 0x6a2df303u, 0x000004efu, 0x6c2af403u, 0x000003f0u, 0x6d28f503u, 0x000003f0u,
    0x6f25f503u, 0x000003f1u, 0x7123f602u, 0x000003f1u, 0x7220f603u, 0x000003f2u, 0x741df702u, 0x000003f3u,
    0x751bf802u, 0x000003f3u, 0x7719f802u, 0x000002f4u, 0x7816f902u, 0x000002f5u, 0x7914fa01u, 0x000002f6u,
    0x7a12fa01u, 0x000002f7u, 0x7b0ffb01u, 0x000002f8u, 0x7c0dfc01u, 0x000001f9u, 0x7d0bfc01u, 0x000001fau,
    0x7e08fd01u, 0x000001fbu, 0x7e06fe01u, 0x000001fcu, 0x7f04ff00u, 0x000001fdu, 0x7f020000u, 0x000000ffu,
    0x7f000000u, 0x00000001u, 0x7fff0000u, 0x00000002u, 0x7ffd0100u, 0x0001fe04u, 0x7ffb0100u, 0x0001fe06u,
    0x7efa0200u, 0x0001fd08u, 0x7ef902ffu, 0xff02fc0bu, 0x7df803ffu, 0xff02fb0du, 0x7cf603ffu, 0xff03fa10u,
    0x7bf504ffu, 0xff03f912u, 0x7af404ffu, 0xff03f914u, 0x79f304ffu, 0xff03f817u, 0x78f205feu, 0xff04f719u,
    0x77f105ffu, 0xff04f61bu, 0x76f005ffu, 0xff04f51eu, 0x74ef06feu, 0xff05f421u, 0x72ef06feu, 0xff05f423u,
    0x71ee06feu, 0xff05f326u, 0x6fed07feu, 0xfe06f229u, 0x6eed07feu, 0xfe06f12bu, 0x6cec07feu, 0xfe06f12eu,
    0x6aec07feu, 0xfe06f031u, 0x68eb07feu, 0xfe07f033u, 0x66eb07feu, 0xfe07ef36u, 0x64eb08feu, 0xfe07ee38u,
    0x62ea08feu, 0xfe07ee3bu, 0x60ea08feu, 0xfe07ed3eu, 0x5eea08feu, 0xfe07ed40u, 0x5bea08feu, 0xfe08ec43u,
    0x59ea08feu, 0xfe08ec45u, 0x57ea08feu, 0xfe08eb48u, 0x54eb08feu, 0xfe08eb4au, 0x52ea08feu, 0xfe08eb4du,
    0x4feb08feu, 0xfe08eb4fu, 0x4deb08feu, 0xfe08ea52u, 0x4aeb08feu, 0xfe08eb54u, 0x48eb08feu, 0xfe08ea57u,
    0x45ec08feu, 0xfe08ea59u, 0x43ec08feu, 0xfe08ea5bu, 0x40ed07feu, 0xfe08ea5eu, 0x3eed07feu, 0xfe08ea60u,
    0x3bee07feu, 0xfe08ea62u, 0x38ee07feu, 0xfe08eb64u, 0x36ef07feu, 0xfe07eb66u, 0x33f007feu, 0xfe07eb68u,
    0x31f006feu, 0xfe07ec6au, 0x2ef106feu, 0xfe07ec6cu, 0x2bf106feu, 0xfe07ed6eu, 0x29f206feu, 0xfe07ed6fu,
    0x26f305ffu, 0xfe06ee71u, 0x23f405ffu, 0xfe06ef72u, 0x21f405ffu, 0xfe06ef74u, 0x1ef504ffu, 0xff05f076u,
    0x1bf604ffu, 0xff05f177u, 0x19f704ffu, 0xfe05f278u, 0x17f803ffu, 0xff04f379u, 0x14f903ffu, 0xff04f47au,
    0x12f903ffu, 0xff04f57bu, 0x10fa03ffu, 0xff03f67cu, 0x0dfb02ffu, 0xff03f87du, 0x0bfc02ffu, 0xff02f97eu,
    0x08fd0100u, 0x0002fa7eu, 0x06fe0100u, 0x0001fb7fu, 0x04fe0100u, 0x0001fd7fu, 0x02000000u, 0x0000ff7fu,
    0x01000000u, 0x0000007fu, 0xff000000u, 0x0000027fu, 0xfd010000u, 0x00ff047fu, 0xfc010000u, 0x01fe067eu,
    0xfb010000u, 0x01fd087eu, 0xfa010000u, 0x01fc0b7du, 0xf9010000u, 0x01fc0d7cu, 0xf8020000u, 0x01fb0f7bu,
    0xf7020000u, 0x01fa127au, 0xf6020000u, 0x01fa1479u, 0xf5020000u, 0x02f91678u, 0xf4020000u, 0x02f81977u,
    0xf3030000u, 0x02f81b75u, 0xf3030000u, 0x02f71d74u, 0xf2030000u, 0x03f62072u, 0xf1030000u, 0x02f62371u,
    0xf1030000u, 0x03f5256fu, 0xf0030000u, 0x03f5286du, 0xf0030000u, 0x03f42a6cu, 0xef040000u, 0x03f32d6au,
    0xef040000u, 0x03f32f68u, 0xef040000u, 0x03f23266u, 0xef040000u, 0x03f23464u, 0xee040000u, 0x04f13762u,
    0xee040000u, 0x03f13a60u, 0xee040000u, 0x04f03c5eu, 0xee040000u, 0x04f03f5bu, 0xee040000u, 0x04f04159u,
    0xee040000u, 0x04ef4457u, 0xee040000u, 0x04ef4655u, 0xee040000u, 0x04ef4952u, 0xee040000u, 0x04ef4b50u,
    0xee040000u, 0x04ee4e4eu, 0xef040000u, 0x04ee504bu, 0xef040000u, 0x04ee5249u, 0xef040000u, 0x04ee5546u,
    0xef040000u, 0x04ee5744u, 0xf0040000u, 0x04ee5941u, 0xf0040000u, 0x04ee5b3fu, 0xf0040000u, 0x04ee5e3cu,
    0xf1030000u, 0x04ee603au, 0xf1040000u, 0x04ee6237u, 0xf2030000u, 0x04ef6434u, 0xf2030000u, 0x04ef6632u,
    0xf3030000u, 0x04ef682fu, 0xf3030000u, 0x04ef6a2du, 0xf4030000u, 0x03f06c2au, 0xf5030000u, 0x03f06d28u,
    0xf5030000u, 0x03f16f25u, 0xf6020000u, 0x03f17123u, 0xf6030000u, 0x03f27220u, 0xf7020000u, 0x03f3741du,
    0xf8020000u, 0x03f3751bu, 0xf8020000u, 0x02f47719u, 0xf9020000u, 0x02f57816u, 0xfa010000u, 0x02f67914u,
    0xfa010000u, 0x02f77a12u, 0xfb010000u, 0x02f87b0fu, 0xfc010000u, 0x01f97c0du, 0xfc010000u, 0x01fa7d0bu,
    0xfd010000u, 0x01fb7e08u, 0xfe010000u, 0x01fc7e06u, 0xff000000u, 0x01fd7f04u, 0x00000000u, 0x00ff7f02u,
    0x00000000u, 0x00ff7f02u, 0x27402d40u, 0x24403b32u, 0x3935302au, 0x2240403du, 0x2e2b2825u, 0x38363431u,
    0x403d3c3au, 0x21404040u, 0x28262423u, 0x2d2c2b29u, 0x3332302fu, 0x38373534u, 0x3c3b3a39u, 0x403e3d3cu,
    0x40404040u, 0x21404040u, 0x24232322u, 0x28272625u, 0x2b2a2928u, 0x2d2c2c2cu, 0x302f2f2eu, 0x33333231u,
    0x35343433u, 0x38383736u, 0x3a393938u, 0x3c3c3b3au, 0x3d3c3c3cu, 0x3e3e3e3eu, 0x3f3f3f3eu, 0x4040403fu,
    0x40404040u, 0x00404040u, 0x36383a3cu, 0x2f303234u, 0x292a2c2du, 0x23252627u, 0x1f202122u, 0x1b1c1d1eu,
    0x1718191au, 0x14151616u, 0x12121313u, 0x0f101011u, 0x0d0e0e0fu, 0x0c0c0c0du, 0x0a0a0b0bu, 0x0909090au,
    0x08080808u, 0x07070707u, 0x06060606u, 0x05050506u, 0x04040505u, 0x04040404u, 0x03030404u, 0x03030303u,
    0x02030303u, 0x02020202u, 0x02020202u, 0x02020202u, 0x01010202u, 0x01010101u, 0x01010101u, 0x01010101u,
    0x01010101u, 0x01010101u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u,
    0x00000000u, 0x12060201u, 0x3f3c3525u, 0x40404040u, 0x40404040u, 0x40404040u, 0x40404040u, 0x40404040u,
    0x40404040u, 0x40404040u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u,
    0x00000000u, 0x1b0b0401u, 0x3f3e3a2eu, 0x40404040u, 0x40404040u, 0x40404040u, 0x40404040u, 0x40404040u,
    0x40404040u, 0x40404040u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u,
    0x00000000u, 0x15070200u, 0x403e392bu, 0x40404040u, 0x40404040u, 0x40404040u, 0x40404040u, 0x40404040u,
    0x40404040u, 0x40404040u, 0xbbefbbffu, 0xbbffbbefu, 0xbbefbbefu, 0xbaefbbffu, 0x0000abefu, 0x55545352u,
    0x59497030u, 0x75357232u, 0x5c4c5b4bu, 0x55545352u, 0x51705030u, 0x75357232u, 0x5c4c5b4bu, 0x55545352u,
    0x50595149u, 0x75357232u, 0x5c4c5b4bu,
);
// The source's escaped unit tap (0x80 as a signed byte) and the unit tap it stands for
const INTER_SOURCE_UNIT_TAP_ESCAPE: i32 = -128;
const INTER_FILTER_UNIT_TAP: i32 = 128;
// The wedge masters' first bytes in their part
const INTER_MASTER_OBLIQUE_ODD: u32 = 0u;
const INTER_MASTER_OBLIQUE_EVEN: u32 = 64u;
const INTER_MASTER_VERTICAL: u32 = 128u;
// A codebook byte's fields
const INTER_CODE_DIRECTION_BITS: u32 = 3u;
const INTER_CODE_OFFSET_BITS: u32 = 2u;
// Sign flips: one block size's wedges per half word
const INTER_SIGN_FLIP_SIZES_PER_WORD: u32 = 2u;

// libaom av1/common/reconinter.c: the block sizes with wedges, in BLOCK_SIZE order (BLOCK_8X8 to BLOCK_32X32, BLOCK_8X32, BLOCK_32X8), the wedge table's order
const INTER_WEDGE_BLOCK_SIZE_LIST = array<u32, 9>(3u, 4u, 5u, 6u, 7u, 8u, 9u, 18u, 19u);

// The codebooks of wedge_params_lookup by block shape, in the source's order
const INTER_CODEBOOK_EQUAL: u32 = 0u;
const INTER_CODEBOOK_HIGHER: u32 = 1u;
const INTER_CODEBOOK_WIDER: u32 = 2u;

// interLoadTables' copy of the inter tables' source
var<workgroup> interSource: array<u32, INTER_SOURCE_WORDS>;

// predictInter's workgroup state: the planes the tile predicts and whether its staging overflows, its unit planes' control and shape words
// and prediction terms, and the references' words
var<workgroup> interTilePlaneCount: u32;
var<workgroup> interTileOverflow: u32;
var<workgroup> interUnitControl: array<u32, INTER_UNIT_PLANES>;
var<workgroup> interUnitShape: array<u32, INTER_UNIT_PLANES>;
var<workgroup> interTerms: array<u32, INTER_UNIT_PLANES * INTER_UNIT_TERMS * INTER_TERM_WORDS>;
var<workgroup> interReferences: array<u32, RECORD_REFERENCES * INTER_REFERENCE_WORDS>;
// Staging: the claims counter, the slots' words, the intermediates, and the scratch words: the items' entries while the tile stages, then
// the luma difference-weighted masks of its samples, which the chroma planes average
var<workgroup> interStagingClaims: atomic<u32>;
var<workgroup> interSlots: array<u32, INTER_STAGING_SLOTS>;
var<workgroup> interIntermediates: array<u32, INTER_STAGING_WORDS>;
var<workgroup> interScratch: array<u32, INTER_SCRATCH_WORDS>;

// Tables

// A byte of a byte table of the inter tables area
fn interReadTableByte(tablesBase: u32, table: u32, byteIndex: u32) -> u32 {
    let word = frameData[tablesBase + table + byteIndex / INTER_BYTES_PER_WORD];
    return (word >> ((byteIndex % INTER_BYTES_PER_WORD) * INTER_BYTE_BITS)) & INTER_BYTE_MASK;
}

// The word index of an interpolation kernel's taps 0 and 1
fn interGetKernelWord(tablesBase: u32, kernel: u32, phase: u32) -> u32 {
    return tablesBase + INTER_TABLE_KERNELS + (kernel * INTER_KERNEL_PHASES + phase) * INTER_KERNEL_WORDS;
}

// Four taps of an interpolation kernel from two words of signed halves
fn interReadKernelQuad(wordIndex: u32) -> vec4<i32> {
    let words = vec2u(frameData[wordIndex], frameData[wordIndex + 1u]);
    return vec4<i32>(
        bitcast<i32>(words.x << SAMPLE_HALF_BITS) >> SAMPLE_HALF_BITS, bitcast<i32>(words.x) >> SAMPLE_HALF_BITS,
        bitcast<i32>(words.y << SAMPLE_HALF_BITS) >> SAMPLE_HALF_BITS, bitcast<i32>(words.y) >> SAMPLE_HALF_BITS);
}

// Four taps of a warp kernel from one word of signed bytes
fn interReadWarpQuad(wordIndex: u32) -> vec4<i32> {
    let word = frameData[wordIndex];
    return vec4<i32>(
        bitcast<i32>(word << INTER_SIGNED_BYTE_SHIFT) >> INTER_SIGNED_BYTE_SHIFT,
        bitcast<i32>(word << (INTER_SIGNED_BYTE_SHIFT - INTER_BYTE_BITS)) >> INTER_SIGNED_BYTE_SHIFT,
        bitcast<i32>(word << INTER_BYTE_BITS) >> INTER_SIGNED_BYTE_SHIFT,
        bitcast<i32>(word) >> INTER_SIGNED_BYTE_SHIFT);
}

// The first byte of a wedge's mask in the wedge table: the table holds each block size's 16 wedges in turn, sign 0 then sign 1, row by row
fn interGetWedgeByte(blockSize: u32, wedgeIndex: u32, wedgeSign: u32) -> u32 {
    var first = 0u;
    for (var slot = 0u; slot < INTER_WEDGE_BLOCK_SIZES; slot += 1u) {
        let slotSize = INTER_WEDGE_BLOCK_SIZE_LIST[slot];
        let areaLog2 = getBlockWidthLog2(slotSize) + getBlockHeightLog2(slotSize);
        if (slotSize == blockSize) {
            return first + ((wedgeIndex * 2u + wedgeSign) << areaLog2);
        }
        first += 1u << (areaLog2 + INTER_WEDGE_SIGN_AREA_LOG2);
    }
    return first;
}

// A word of the inter tables' source, from the loader workgroup's copy
fn interReadSourceWord(index: u32) -> u32 {
    return interSource[index];
}

// A byte of a part of the inter tables' source
fn interReadSourceByte(part: u32, byteIndex: u32) -> u32 {
    return (interReadSourceWord(part + byteIndex / INTER_BYTES_PER_WORD) >> ((byteIndex % INTER_BYTES_PER_WORD) * INTER_BYTE_BITS)) & INTER_BYTE_MASK;
}

// An interpolation kernel tap of the source: a signed byte, the escape standing for the unit tap
fn interReadSourceTap(tap: u32) -> i32 {
    let value = bitcast<i32>(interReadSourceByte(INTER_SOURCE_KERNELS, tap) << INTER_SIGNED_BYTE_SHIFT) >> INTER_SIGNED_BYTE_SHIFT;
    return select(value, INTER_FILTER_UNIT_TAP, value == INTER_SOURCE_UNIT_TAP_ESCAPE);
}

// libaom's oblique 63 degree master mask (init_wedge_master_masks): rows alternate the even and odd masters, shifted left by one more
// sample every second row from 16 samples right, edges replicated
fn interGetWedgeOblique(row: u32, column: u32) -> u32 {
    let shift = INTER_WEDGE_MASTER_SHIFT - i32((row + 1u) / 2u);
    let index = u32(clamp(i32(column) - shift, 0, INTER_WEDGE_MASTER_LAST));
    return interReadSourceByte(INTER_SOURCE_WEDGE_MASTERS, select(INTER_MASTER_OBLIQUE_ODD, INTER_MASTER_OBLIQUE_EVEN, row % 2u == 0u) + index);
}

// A sample of libaom's 64x64 master mask of a direction and sign (wedge_mask_obl): the vertical and oblique 63 masters, transposed,
// mirrored, and complemented into the other directions; sign 1 complements sign 0
fn interGetWedgeMaster(negative: u32, direction: u32, row: u32, column: u32) -> u32 {
    let mirroredRow = u32(INTER_WEDGE_MASTER_LAST) - row;
    let mirroredColumn = u32(INTER_WEDGE_MASTER_LAST) - column;
    var value: u32;
    switch (direction) {
        case INTER_WEDGE_HORIZONTAL: {
            value = interReadSourceByte(INTER_SOURCE_WEDGE_MASTERS, INTER_MASTER_VERTICAL + row);
        }
        case INTER_WEDGE_VERTICAL: {
            value = interReadSourceByte(INTER_SOURCE_WEDGE_MASTERS, INTER_MASTER_VERTICAL + column);
        }
        case INTER_WEDGE_OBLIQUE27: {
            value = interGetWedgeOblique(column, row);
        }
        case INTER_WEDGE_OBLIQUE63: {
            value = interGetWedgeOblique(row, column);
        }
        case INTER_WEDGE_OBLIQUE117: {
            value = u32(INTER_BLEND_MAXIMUM) - interGetWedgeOblique(row, mirroredColumn);
        }
        default: {
            value = u32(INTER_BLEND_MAXIMUM) - interGetWedgeOblique(column, mirroredRow);
        }
    }
    if (negative == 1u) {
        return u32(INTER_BLEND_MAXIMUM) - value;
    }
    return value;
}

// A byte of the wedge table: the block size, wedge, sign, and sample it stands for, cut from the master mask as libaom's
// get_wedge_mask_inplace cuts it
fn interComputeWedgeByte(byteIndex: u32) -> u32 {
    var first = 0u;
    for (var slot = 0u; slot < INTER_WEDGE_BLOCK_SIZES; slot += 1u) {
        let blockSize = INTER_WEDGE_BLOCK_SIZE_LIST[slot];
        let widthLog2 = getBlockWidthLog2(blockSize);
        let heightLog2 = getBlockHeightLog2(blockSize);
        let areaLog2 = widthLog2 + heightLog2;
        let slotBytes = 1u << (areaLog2 + INTER_WEDGE_SIGN_AREA_LOG2);
        if (byteIndex < first + slotBytes) {
            let slotByte = byteIndex - first;
            let entry = slotByte >> areaLog2;
            let wedgeIndex = entry / 2u;
            let maskSample = slotByte & ((1u << areaLog2) - 1u);
            let row = maskSample >> widthLog2;
            let column = maskSample & ((1u << widthLog2) - 1u);
            var codebook = INTER_CODEBOOK_EQUAL;
            if (heightLog2 > widthLog2) {
                codebook = INTER_CODEBOOK_HIGHER;
            } else if (heightLog2 < widthLog2) {
                codebook = INTER_CODEBOOK_WIDER;
            }
            // The wedge's code: its direction, then its offsets in 1/4 of the block, doubled into libaom's 1/8
            let code = interReadSourceByte(INTER_SOURCE_CODEBOOKS, codebook * INTER_WEDGE_TYPES + wedgeIndex);
            let offsetX = getField(code, INTER_CODE_DIRECTION_BITS, INTER_CODE_OFFSET_BITS) << 1u;
            let offsetY = getField(code, INTER_CODE_DIRECTION_BITS + INTER_CODE_OFFSET_BITS, INTER_CODE_OFFSET_BITS) << 1u;
            let flips = interReadSourceWord(INTER_SOURCE_SIGN_FLIPS + slot / INTER_SIGN_FLIP_SIZES_PER_WORD);
            let negative = (entry % 2u) ^ getField(flips, (slot % INTER_SIGN_FLIP_SIZES_PER_WORD) * INTER_WEDGE_TYPES + wedgeIndex, 1u);
            let masterRow = INTER_WEDGE_MASTER_CENTER - ((offsetY << heightLog2) >> INTER_WEDGE_OFFSET_BITS) + row;
            let masterColumn = INTER_WEDGE_MASTER_CENTER - ((offsetX << widthLog2) >> INTER_WEDGE_OFFSET_BITS) + column;
            return interGetWedgeMaster(negative, getField(code, 0u, INTER_CODE_DIRECTION_BITS), masterRow, masterColumn);
        }
        first += slotBytes;
    }
    return 0u;
}

// One word of the inter tables area: two kernel taps as signed halves, the source's words as they are (warp filter, OBMC masks,
// inter-intra weights), or four wedge mask bytes
fn interComputeTableWord(word: u32) -> u32 {
    if (word < INTER_TABLE_WARP_FILTER) {
        let tap = (word - INTER_TABLE_KERNELS) * 2u;
        return (u32(interReadSourceTap(tap)) & SAMPLE_HALF_MASK) | (u32(interReadSourceTap(tap + 1u)) << SAMPLE_HALF_BITS);
    }
    if (word < INTER_TABLE_WEDGE_MASKS) {
        return interReadSourceWord(INTER_SOURCE_COPIED + word - INTER_TABLE_WARP_FILTER);
    }
    var packed = 0u;
    for (var byteSlot = 0u; byteSlot < INTER_BYTES_PER_WORD; byteSlot += 1u) {
        packed |= interComputeWedgeByte((word - INTER_TABLE_WEDGE_MASKS) * INTER_BYTES_PER_WORD + byteSlot) << (byteSlot * INTER_BYTE_BITS);
    }
    return packed;
}

// Writes the inter tables (interpolation and warp kernels, OBMC masks, inter-intra weights, wedge masks) into the frame data's inter
// tables area, from workgroups 0 to 63 of loadTables. All 64 lanes call it in uniform control flow: it copies the source into workgroup
// memory first, its one read of the constant array (the shader compiles a constant array once per site that reads it).
fn interLoadTables(workgroupIndex: u32, lane: u32) {
    for (var index = lane; index < INTER_SOURCE_WORDS; index += INTER_WORKGROUP_SIZE) {
        interSource[index] = INTER_TABLE_SOURCE[index];
    }
    workgroupBarrier();
    let tablesBase = getTablesOffset() + INTER_TABLES_OFFSET;
    for (var word = workgroupIndex * INTER_WORKGROUP_SIZE + lane; word < INTER_TABLE_WORDS; word += INTER_WORKGROUP_SIZE * INTER_LOADER_WORKGROUPS) {
        frameData[tablesBase + word] = interComputeTableWord(word);
    }
}

// Block access

// The block index the mode info map holds for a 4x4 luma unit inside the frame's mode info grid
fn interReadMapBlock(unitColumn: u32, unitRow: u32) -> u32 {
    return frameData[getModeInfoWordIndex(unitRow, unitColumn)] & ((1u << MODE_INFO_BLOCK_INDEX_BITS) - 1u);
}

// The block covering a 4x4 luma unit, past the mode info grid too, where a block straddling the grid's edge reaches (libaom predicts
// whole blocks into its border, and CFL reads that luma); RECORD_MISSING when no block covers it
fn interFindBlock(unitColumn: u32, unitRow: u32, miColumns: u32, miRows: u32) -> u32 {
    let blockIndex = interReadMapBlock(min(unitColumn, miColumns - 1u), min(unitRow, miRows - 1u));
    if (unitColumn < miColumns && unitRow < miRows) {
        return blockIndex;
    }
    let position = readBlockWord(blockIndex, RECORD_BLOCK_POSITION);
    let blockSize = getField(position, RECORD_BLOCK_SIZE_SHIFT, RECORD_BLOCK_SIZE_BITS);
    let columnEnd = getField(position, RECORD_BLOCK_MI_COLUMN_SHIFT, RECORD_BLOCK_MI_BITS) + (1u << (getBlockWidthLog2(blockSize) - MI_SIZE_LOG2));
    let rowEnd = getField(position, RECORD_BLOCK_MI_ROW_SHIFT, RECORD_BLOCK_MI_BITS) + (1u << (getBlockHeightLog2(blockSize) - MI_SIZE_LOG2));
    if (unitColumn >= columnEnd || unitRow >= rowEnd) {
        return RECORD_MISSING;
    }
    return blockIndex;
}

// Whether a block predicts from references: inter, not IntraBC
fn interIsMotionBlock(blockIndex: u32) -> bool {
    if (blockIndex == RECORD_MISSING) {
        return false;
    }
    let position = readBlockWord(blockIndex, RECORD_BLOCK_POSITION);
    return getField(position, RECORD_BLOCK_INTER_SHIFT, 1u) == 1u && getField(position, RECORD_BLOCK_INTRABC_SHIFT, 1u) == 0u;
}

// Whether every block of the 2x2 (or 2x1) group of 4x4 luma units sharing a subsampled chroma block predicts from references,
// as libaom's is_sub8x8_inter requires before each block predicts its own chroma
fn interIsMotionGroup(unitColumn: u32, unitRow: u32, subsamplingX: u32, subsamplingY: u32, miColumns: u32, miRows: u32) -> bool {
    for (var row = unitRow & ~subsamplingY; row <= (unitRow | subsamplingY); row += 1u) {
        for (var column = unitColumn & ~subsamplingX; column <= (unitColumn | subsamplingX); column += 1u) {
            if (!interIsMotionBlock(interFindBlock(column, row, miColumns, miRows))) {
                return false;
            }
        }
    }
    return true;
}

// The kernel libaom filters a side of a prediction block with: av1_get_interp_filter_params_with_block_size's 4-tap kernels for a side of at most 4 samples
fn interSelectKernel(filterType: u32, size: u32) -> u32 {
    if (size > INTER_FOUR_TAP_MAXIMUM_SIZE) {
        return filterType;
    }
    switch (filterType) {
        case INTER_FILTER_SMOOTH: {
            return INTER_KERNEL_SMOOTH_4;
        }
        case INTER_FILTER_BILINEAR: {
            return INTER_FILTER_BILINEAR;
        }
        default: {
            return INTER_KERNEL_REGULAR_4;
        }
    }
}

// libaom's av1_scaled_x and av1_scaled_y: a 1/16 sample position times a 14-bit scale, offset, then rounded by 8 bits away from zero
// (ROUND_POWER_OF_TWO_SIGNED_64) into 1/1024 sample; the 64-bit product splits at the scale's low byte, so every term fits 32 bits
fn interScaleValue(value: i32, scale: i32) -> i32 {
    let low = value * (scale & INTER_SCALE_ROUND_MASK) + (scale - INTER_REFERENCE_NO_SCALE) * INTER_SCALE_OFFSET_MULTIPLIER;
    let high = value * (scale >> INTER_SCALE_ROUND_BITS) + (low >> INTER_SCALE_ROUND_BITS);
    let remainder = low & INTER_SCALE_ROUND_MASK;
    if (high >= 0) {
        return high + select(0, 1, remainder >= INTER_SCALE_ROUND_HALF);
    }
    return high + select(0, 1, remainder > INTER_SCALE_ROUND_HALF);
}

// The first 4x4 luma unit row and column of the tile holding a block, from its superblock's tile word and the header's tile starts
fn interGetTileStarts(miRow: u32, miColumn: u32) -> vec2u {
    var superblockLog2 = INTER_SUPERBLOCK_64_UNITS_LOG2;
    if (hasRecordFlag(RECORD_FLAG_SUPERBLOCK_128)) {
        superblockLog2 = INTER_SUPERBLOCK_128_UNITS_LOG2;
    }
    let superblockIndex = (miRow >> superblockLog2) * readRecordWord(RECORD_HEADER_SUPERBLOCK_COLUMNS) + (miColumn >> superblockLog2);
    let tile = readSuperblockWord(superblockIndex, RECORD_SUPERBLOCK_TILE);
    let tileColumn = getField(tile, 0u, INTER_TILE_INDEX_BITS);
    let tileRow = getField(tile, RECORD_SUPERBLOCK_TILE_ROW_SHIFT, INTER_TILE_INDEX_BITS);
    return vec2u(readRecordWord(RECORD_HEADER_TILE_COLUMN_STARTS + tileColumn) << superblockLog2,
        readRecordWord(RECORD_HEADER_TILE_ROW_STARTS + tileRow) << superblockLog2);
}

// The neighbor an OBMC block blends over one of its 4x4 units along its top edge (or left edge), visited as libaom's
// foreach_overlappable_nb_above (foreach_overlappable_nb_left) visits them: steps of the neighbor's side up to 64 samples, a 4-sample
// neighbor standing for its pair through the pair's second block, and at most neighborLimit inter neighbors.
// Returns the neighbor's block index, the overlap's first unit along the edge, and its length in units, 0 when no counted neighbor covers the unit.
fn interFindObmcNeighbor(alongLeft: bool, blockRow: u32, blockColumn: u32, edgeLength: u32, edgeEnd: u32, unitPosition: u32,
                         neighborLimit: u32) -> vec3u {
    var position = select(blockColumn, blockRow, alongLeft);
    var count = 0u;
    loop {
        if (position >= edgeEnd || count >= neighborLimit || position > unitPosition) {
            break;
        }
        var row = select(blockRow - 1u, position, alongLeft);
        var column = select(position, blockColumn - 1u, alongLeft);
        var neighbor = interReadMapBlock(column, row);
        let neighborSize = getField(readBlockWord(neighbor, RECORD_BLOCK_POSITION), RECORD_BLOCK_SIZE_SHIFT, RECORD_BLOCK_SIZE_BITS);
        let sideLog2 = select(getBlockWidthLog2(neighborSize), getBlockHeightLog2(neighborSize), alongLeft) - MI_SIZE_LOG2;
        var step = min(1u << sideLog2, INTER_OBMC_STEP_LIMIT);
        if (step == 1u) {
            position &= ~1u;
            row = select(row, position + 1u, alongLeft);
            column = select(position + 1u, column, alongLeft);
            neighbor = interReadMapBlock(column, row);
            step = 2u;
        }
        let overlappable = getField(readBlockWord(neighbor, RECORD_BLOCK_POSITION), RECORD_BLOCK_INTER_SHIFT, 1u) == 1u;
        if (unitPosition < position + step) {
            if (overlappable) {
                return vec3u(neighbor, position, min(edgeLength, step));
            }
            break;
        }
        if (overlappable) {
            count += 1u;
        }
        position += step;
    }
    return vec3u(0u);
}

// Writes a reference's words for the tile: its store base in each plane, its last sample in luma and in chroma, and its steps
fn interSetupReference(referenceIndex: u32) {
    let frameBuffer = min(readReferenceWord(referenceIndex, RECORD_REFERENCE_BUFFER), RECORD_FRAME_BUFFERS - 1u);
    let width = max(readReferenceWord(referenceIndex, RECORD_REFERENCE_WIDTH), 1u);
    let height = max(readReferenceWord(referenceIndex, RECORD_REFERENCE_HEIGHT), 1u);
    let base = referenceIndex * INTER_REFERENCE_WORDS;
    for (var plane = 0u; plane < RECORD_PLANES; plane += 1u) {
        interReferences[base + plane] = getStoreWordIndex(frameBuffer, plane, 0u, 0u);
    }
    let chromaWidth = (width + INTER_CHROMA_SUBSAMPLING_X) >> INTER_CHROMA_SUBSAMPLING_X;
    let chromaHeight = (height + INTER_CHROMA_SUBSAMPLING_Y) >> INTER_CHROMA_SUBSAMPLING_Y;
    interReferences[base + INTER_REFERENCE_LAST_SAMPLE] = (width - 1u) | ((height - 1u) << SAMPLE_HALF_BITS);
    interReferences[base + INTER_REFERENCE_LAST_SAMPLE + 1u] = (chromaWidth - 1u) | ((chromaHeight - 1u) << SAMPLE_HALF_BITS);
    let steps = interGetReferenceSteps(referenceIndex);
    interReferences[base + INTER_REFERENCE_STEPS] = u32(steps.x) | (u32(steps.y) << SAMPLE_HALF_BITS);
}

// A reference's steps per sample in 1/1024 sample: its scale rounded to that precision (av1_setup_scale_factors_for_frame), or one sample
fn interGetReferenceSteps(referenceIndex: u32) -> vec2<i32> {
    let scale = vec2<i32>(vec2u(readReferenceWord(referenceIndex, RECORD_REFERENCE_SCALE_X), readReferenceWord(referenceIndex, RECORD_REFERENCE_SCALE_Y)));
    if (all(scale == vec2<i32>(INTER_REFERENCE_NO_SCALE))) {
        return vec2<i32>(INTER_UNSCALED_STEP);
    }
    return (scale + vec2<i32>(1 << (INTER_STEP_ROUND_BITS - 1u))) >> vec2u(INTER_STEP_ROUND_BITS);
}

// A reference's steps per sample in the tile: x, then y from bit 16
fn interGetSteps(referenceIndex: u32) -> u32 {
    return interReferences[referenceIndex * INTER_REFERENCE_WORDS + INTER_REFERENCE_STEPS];
}

// A reference's store base in a plane
fn interGetReferenceBase(referenceIndex: u32, plane: u32) -> u32 {
    return interReferences[referenceIndex * INTER_REFERENCE_WORDS + plane];
}

// A reference's last sample in a plane: column, then row from bit 16
fn interGetReferenceLast(referenceIndex: u32, plane: u32) -> u32 {
    return interReferences[referenceIndex * INTER_REFERENCE_WORDS + INTER_REFERENCE_LAST_SAMPLE + min(plane, 1u)];
}

// Writes one prediction term of a unit plane: a prediction block (plane origin and size) predicted from one reference with one motion
// vector, translated (scaled as the reference is) or warped with the model at warpWord, staging the rectangle of stagedSize from the
// origin; false when the reference has no frame buffer
fn interSetupTerm(termBase: u32, plane: u32, referenceField: u32, motionVector: u32, filters: u32, origin: vec2u, size: vec2u,
                  warpWord: u32, stagedSize: vec2u) -> bool {
    if (referenceField < INTER_REFERENCE_FIELD_FIRST) {
        return false;
    }
    let referenceIndex = referenceField - INTER_REFERENCE_FIELD_FIRST;
    if (readReferenceWord(referenceIndex, RECORD_REFERENCE_BUFFER) >= RECORD_FRAME_BUFFERS) {
        return false;
    }
    interTerms[termBase + INTER_TERM_ORIGIN] = origin.x | (origin.y << SAMPLE_HALF_BITS);
    let referenceBits = (referenceIndex << INTER_TERM_REFERENCE_SHIFT) | (firstTrailingBit(stagedSize.x) << INTER_TERM_STAGED_WIDTH_SHIFT)
        | (firstTrailingBit(stagedSize.y) << INTER_TERM_STAGED_HEIGHT_SHIFT);
    if (warpWord != 0u) {
        interTerms[termBase + INTER_TERM_CONTROL] = referenceBits | (1u << INTER_TERM_WARP_SHIFT);
        interTerms[termBase + INTER_TERM_WARP_WORD] = warpWord;
        return true;
    }
    let subsamplingX = select(0u, INTER_CHROMA_SUBSAMPLING_X, plane != PLANE_Y);
    let subsamplingY = select(0u, INTER_CHROMA_SUBSAMPLING_Y, plane != PLANE_Y);
    let kernelX = interSelectKernel(getField(filters, 0u, RECORD_BLOCK_FILTER_BITS), size.x);
    let kernelY = interSelectKernel(getField(filters, RECORD_BLOCK_FILTER_BITS, RECORD_BLOCK_FILTER_BITS), size.y);
    var control = referenceBits | (kernelX << INTER_TERM_KERNEL_X_SHIFT) | (kernelY << INTER_TERM_KERNEL_Y_SHIFT);
    let vectorRow = getSignedField(motionVector, INTER_MOTION_VECTOR_ROW_SHIFT, INTER_MOTION_VECTOR_BITS) << (INTER_MOTION_VECTOR_PLANE_SHIFT - subsamplingY);
    let vectorColumn = getSignedField(motionVector, INTER_MOTION_VECTOR_COLUMN_SHIFT, INTER_MOTION_VECTOR_BITS) << (INTER_MOTION_VECTOR_PLANE_SHIFT - subsamplingX);
    let position = (vec2<i32>(origin) << vec2u(INTER_SUBPEL_BITS)) + vec2<i32>(vectorColumn, vectorRow);
    let scale = vec2<i32>(vec2u(readReferenceWord(referenceIndex, RECORD_REFERENCE_SCALE_X), readReferenceWord(referenceIndex, RECORD_REFERENCE_SCALE_Y)));
    var scaledPosition = position << vec2u(INTER_SCALE_EXTRA_BITS);
    if (any(scale != vec2<i32>(INTER_REFERENCE_NO_SCALE))) {
        scaledPosition = vec2<i32>(interScaleValue(position.x, scale.x), interScaleValue(position.y, scale.y)) + vec2<i32>(INTER_SCALE_EXTRA_OFFSET);
    }
    // Steps of whole samples keep each phase constant across the block, so the term can stage (the scaled positions' offset included)
    if (any(interGetReferenceSteps(referenceIndex) != vec2<i32>(INTER_UNSCALED_STEP))) {
        control |= 1u << INTER_TERM_SCALED_SHIFT;
    }
    interTerms[termBase + INTER_TERM_CONTROL] = control;
    interTerms[termBase + INTER_TERM_POSITION_X] = bitcast<u32>(scaledPosition.x);
    interTerms[termBase + INTER_TERM_POSITION_Y] = bitcast<u32>(scaledPosition.y);
    return true;
}

// Writes an OBMC neighbor's term: its first reference's single, unwarped prediction of the overlap (dec_build_prediction_by_above_pred and
// _left_pred), a prediction block of size from origin of which the overlap's stagedSize blends
fn interSetupNeighborTerm(termBase: u32, plane: u32, neighbor: u32, origin: vec2u, size: vec2u, stagedSize: vec2u) -> bool {
    let modes = readBlockWord(neighbor, RECORD_BLOCK_MODES);
    return interSetupTerm(termBase, plane, getField(modes, RECORD_BLOCK_REFERENCE_0_SHIFT, RECORD_BLOCK_REFERENCE_BITS),
        readRecordWord(getBlockExtensionOffset(neighbor) + RECORD_MOTION_VECTOR_0), getField(modes, RECORD_BLOCK_FILTER_X_SHIFT, INTER_FILTER_FIELD_BITS),
        origin, size, 0u, stagedSize);
}

// Describes how one 4x4 luma unit of the tile predicts a plane, as libaom's dec_build_inter_predictor and dec_build_obmc_inter_predictors_sb
// predict its block: the mode and masks, up to four prediction terms, and the region, whose first unit claims the region's staging;
// one lane per unit plane
fn interSetupUnit(unitPlane: u32, tile: vec3u) {
    interUnitControl[unitPlane] = 0u;
    let plane = unitPlane / INTER_TILE_UNITS;
    let unit = unitPlane % INTER_TILE_UNITS;
    let unitColumn = (tile.x << INTER_TILE_UNIT_COLUMNS_LOG2) + unit % (1u << INTER_TILE_UNIT_COLUMNS_LOG2);
    let unitRow = (tile.y << INTER_TILE_UNIT_COLUMNS_LOG2) + unit / (1u << INTER_TILE_UNIT_COLUMNS_LOG2);
    let miColumns = readRecordWord(RECORD_HEADER_MI_COLUMNS);
    let miRows = readRecordWord(RECORD_HEADER_MI_ROWS);
    let subsamplingX = select(0u, INTER_CHROMA_SUBSAMPLING_X, plane != PLANE_Y);
    let subsamplingY = select(0u, INTER_CHROMA_SUBSAMPLING_Y, plane != PLANE_Y);
    // A subsampled chroma block covering 4-wide or 4-high blocks belongs to the group's last block, which predicts it from the group's
    // origin; when every block of the group is inter, each block predicts its own share with its own motion instead
    var blockIndex = interFindBlock(unitColumn | subsamplingX, unitRow | subsamplingY, miColumns, miRows);
    if (!interIsMotionBlock(blockIndex)) {
        return;
    }
    var position = readBlockWord(blockIndex, RECORD_BLOCK_POSITION);
    var blockSize = getField(position, RECORD_BLOCK_SIZE_SHIFT, RECORD_BLOCK_SIZE_BITS);
    let groupColumn = select(0u, 1u, subsamplingX == 1u && getBlockWidthLog2(blockSize) == MI_SIZE_LOG2);
    let groupRow = select(0u, 1u, subsamplingY == 1u && getBlockHeightLog2(blockSize) == MI_SIZE_LOG2);
    var ownShare = false;
    if (groupColumn + groupRow != 0u && interIsMotionGroup(unitColumn, unitRow, subsamplingX, subsamplingY, miColumns, miRows)) {
        blockIndex = interFindBlock(unitColumn, unitRow, miColumns, miRows);
        position = readBlockWord(blockIndex, RECORD_BLOCK_POSITION);
        blockSize = getField(position, RECORD_BLOCK_SIZE_SHIFT, RECORD_BLOCK_SIZE_BITS);
        ownShare = true;
    }
    let miRow = getField(position, RECORD_BLOCK_MI_ROW_SHIFT, RECORD_BLOCK_MI_BITS);
    let miColumn = getField(position, RECORD_BLOCK_MI_COLUMN_SHIFT, RECORD_BLOCK_MI_BITS);
    let widthLog2 = getBlockWidthLog2(blockSize);
    let heightLog2 = getBlockHeightLog2(blockSize);
    var origin = vec2u(((miColumn - groupColumn) << MI_SIZE_LOG2) >> subsamplingX, ((miRow - groupRow) << MI_SIZE_LOG2) >> subsamplingY);
    var size = max(vec2u((1u << widthLog2) >> subsamplingX, (1u << heightLog2) >> subsamplingY), vec2u(INTER_MINIMUM_PLANE_BLOCK));
    if (ownShare) {
        origin = vec2u((miColumn << MI_SIZE_LOG2) >> subsamplingX, (miRow << MI_SIZE_LOG2) >> subsamplingY);
        size = vec2u((1u << widthLog2) >> subsamplingX, (1u << heightLog2) >> subsamplingY);
    }

    let modes = readBlockWord(blockIndex, RECORD_BLOCK_MODES);
    let motionWord = getBlockExtensionOffset(blockIndex);
    let compoundWord = readRecordWord(motionWord + RECORD_MOTION_COMPOUND);
    let reference0 = getField(modes, RECORD_BLOCK_REFERENCE_0_SHIFT, RECORD_BLOCK_REFERENCE_BITS);
    let reference1 = getField(modes, RECORD_BLOCK_REFERENCE_1_SHIFT, RECORD_BLOCK_REFERENCE_BITS);
    let filters = getField(modes, RECORD_BLOCK_FILTER_X_SHIFT, INTER_FILTER_FIELD_BITS);
    let compound = reference1 >= INTER_REFERENCE_FIELD_FIRST;
    // av1_init_warp_params warps a plane block of at least 8x8 only
    let warpAllowed = all(size >= vec2u(INTER_WARP_MINIMUM_SIZE));
    var warpWord0 = 0u;
    var warpWord1 = 0u;
    if (warpAllowed) {
        switch (getField(modes, RECORD_BLOCK_WARP_0_SHIFT, RECORD_BLOCK_WARP_0_BITS)) {
            case RECORD_BLOCK_WARP_LOCAL: {
                warpWord0 = getBlockExtensionWordIndex(blockIndex, RECORD_BLOCK_HAS_LOCAL_WARP_SHIFT) + RECORD_LOCAL_WARP_MATRIX;
            }
            case RECORD_BLOCK_WARP_GLOBAL: {
                warpWord0 = RECORD_HEADER_GLOBAL_MOTION + (reference0 - INTER_REFERENCE_FIELD_FIRST) * RECORD_GLOBAL_MOTION_WORDS + RECORD_GLOBAL_MOTION_MATRIX;
            }
            default: {
            }
        }
        if (compound && getField(modes, RECORD_BLOCK_WARP_1_SHIFT, 1u) == 1u) {
            warpWord1 = RECORD_HEADER_GLOBAL_MOTION + (reference1 - INTER_REFERENCE_FIELD_FIRST) * RECORD_GLOBAL_MOTION_WORDS + RECORD_GLOBAL_MOTION_MATRIX;
        }
    }

    var control = 1u << INTER_UNIT_VALID_SHIFT;
    var mask = 0u;
    if (compound) {
        var mode = INTER_MODE_AVERAGE;
        switch (getField(modes, RECORD_BLOCK_COMPOUND_TYPE_SHIFT, RECORD_BLOCK_COMPOUND_TYPE_BITS)) {
            case INTER_COMPOUND_DISTANCE: {
                mode = INTER_MODE_DISTANCE;
                control |= getField(compoundWord, RECORD_MOTION_DISTANCE_FORWARD_SHIFT, RECORD_MOTION_DISTANCE_BITS) << INTER_UNIT_FORWARD_SHIFT;
                control |= getField(compoundWord, RECORD_MOTION_DISTANCE_BACKWARD_SHIFT, RECORD_MOTION_DISTANCE_BITS) << INTER_UNIT_BACKWARD_SHIFT;
            }
            case INTER_COMPOUND_WEDGE: {
                mode = INTER_MODE_WEDGE;
                let wedgeIndex = getField(compoundWord, RECORD_MOTION_WEDGE_INDEX_SHIFT, RECORD_MOTION_WEDGE_INDEX_BITS);
                let wedgeSign = getField(compoundWord, RECORD_MOTION_WEDGE_SIGN_SHIFT, 1u);
                mask = interGetWedgeByte(blockSize, wedgeIndex, wedgeSign) | (widthLog2 << INTER_UNIT_STRIDE_SHIFT);
            }
            case INTER_COMPOUND_DIFFERENCE: {
                mode = INTER_MODE_DIFFERENCE;
                control |= getField(compoundWord, RECORD_MOTION_MASK_TYPE_SHIFT, 1u) << INTER_UNIT_INVERSE_SHIFT;
            }
            default: {
            }
        }
        control |= mode << INTER_UNIT_MODE_SHIFT;
    }

    // The main prediction's and the second reference's terms, which stage the prediction block
    let unitTerms = unitPlane * INTER_UNIT_TERMS * INTER_TERM_WORDS;
    if (!interSetupTerm(unitTerms + INTER_TERM_MAIN * INTER_TERM_WORDS, plane, reference0, readRecordWord(motionWord + RECORD_MOTION_VECTOR_0),
        filters, origin, size, warpWord0, size)) {
        return;
    }
    if (compound && !interSetupTerm(unitTerms + INTER_TERM_SECOND * INTER_TERM_WORDS, plane, reference1,
        readRecordWord(motionWord + RECORD_MOTION_VECTOR_1), filters, origin, size, warpWord1, size)) {
        return;
    }

    // OBMC (av1_build_obmc_inter_prediction): the neighbors above and left blend over the block's first rows and columns, when the block
    // is not at its tile's top (left) edge; plane blocks of at most 32 samples take no blend from above.
    // Each neighbor's term predicts at least 4 samples on its blended side and stages the overlap; a neighbor without a frame buffer
    // (which libaom rejects) blends nothing.
    if (getField(modes, RECORD_BLOCK_MOTION_MODE_SHIFT, RECORD_BLOCK_MOTION_MODE_BITS) == INTER_MOTION_OBMC) {
        let tileStarts = interGetTileStarts(miRow, miColumn);
        let widthUnits = 1u << (widthLog2 - MI_SIZE_LOG2);
        let heightUnits = 1u << (heightLog2 - MI_SIZE_LOG2);
        if (miRow > tileStarts.y && size.x * size.y > INTER_OBMC_SKIP_ABOVE_AREA) {
            let above = interFindObmcNeighbor(false, miRow, miColumn, widthUnits, min(miColumn + widthUnits, miColumns), unitColumn,
                min(widthLog2 - MI_SIZE_LOG2, INTER_OBMC_MAXIMUM_NEIGHBORS));
            let overlap = (min(1u << heightLog2, INTER_OBMC_SIZE_LIMIT) >> 1u) >> subsamplingY;
            let termOrigin = vec2u((above.y << MI_SIZE_LOG2) >> subsamplingX, (miRow << MI_SIZE_LOG2) >> subsamplingY);
            let termSize = vec2u((above.z << MI_SIZE_LOG2) >> subsamplingX,
                clamp((1u << heightLog2) >> (subsamplingY + 1u), INTER_OBMC_MINIMUM_SIZE, INTER_OBMC_SIZE_LIMIT >> (subsamplingY + 1u)));
            if (above.z != 0u && interSetupNeighborTerm(unitTerms + INTER_TERM_ABOVE * INTER_TERM_WORDS, plane, above.x, termOrigin, termSize,
                vec2u(termSize.x, overlap))) {
                control |= overlap << INTER_UNIT_ABOVE_OVERLAP_SHIFT;
            }
        }
        if (miColumn > tileStarts.x) {
            let left = interFindObmcNeighbor(true, miRow, miColumn, heightUnits, min(miRow + heightUnits, miRows), unitRow,
                min(heightLog2 - MI_SIZE_LOG2, INTER_OBMC_MAXIMUM_NEIGHBORS));
            let overlap = (min(1u << widthLog2, INTER_OBMC_SIZE_LIMIT) >> 1u) >> subsamplingX;
            let termOrigin = vec2u((miColumn << MI_SIZE_LOG2) >> subsamplingX, (left.y << MI_SIZE_LOG2) >> subsamplingY);
            let termSize = vec2u(clamp((1u << widthLog2) >> (subsamplingX + 1u), INTER_OBMC_MINIMUM_SIZE, INTER_OBMC_SIZE_LIMIT >> (subsamplingX + 1u)),
                (left.z << MI_SIZE_LOG2) >> subsamplingY);
            if (left.z != 0u && interSetupNeighborTerm(unitTerms + INTER_TERM_LEFT * INTER_TERM_WORDS, plane, left.x, termOrigin, termSize,
                vec2u(overlap, termSize.y))) {
                control |= overlap << INTER_UNIT_LEFT_OVERLAP_SHIFT;
            }
        }
    }

    // The first unit of each of its terms' regions (every unit of a region shares the term), which claims the term's staging
    let tileOrigin = interGetTileOrigin(tile, plane);
    var shape = mask | (interGetTermOwner(unitTerms + INTER_TERM_MAIN * INTER_TERM_WORDS, plane, tileOrigin) << INTER_UNIT_OWNERS_SHIFT);
    if (getField(control, INTER_UNIT_ABOVE_OVERLAP_SHIFT, INTER_UNIT_OVERLAP_BITS) != 0u) {
        shape |= interGetTermOwner(unitTerms + INTER_TERM_ABOVE * INTER_TERM_WORDS, plane, tileOrigin) << interGetOwnerShift(INTER_TERM_ABOVE);
    }
    if (getField(control, INTER_UNIT_LEFT_OVERLAP_SHIFT, INTER_UNIT_OVERLAP_BITS) != 0u) {
        shape |= interGetTermOwner(unitTerms + INTER_TERM_LEFT * INTER_TERM_WORDS, plane, tileOrigin) << interGetOwnerShift(INTER_TERM_LEFT);
    }
    interUnitShape[unitPlane] = shape;
    interUnitControl[unitPlane] = control;
}

// The tile's origin in a plane
fn interGetTileOrigin(tile: vec3u, plane: u32) -> vec2u {
    let subsamplingX = select(0u, INTER_CHROMA_SUBSAMPLING_X, plane != PLANE_Y);
    let subsamplingY = select(0u, INTER_CHROMA_SUBSAMPLING_Y, plane != PLANE_Y);
    return vec2u((tile.x << INTER_TILE_SIZE_LOG2) >> subsamplingX, (tile.y << INTER_TILE_SIZE_LOG2) >> subsamplingY);
}

// A term's region: its staged rectangle's part of the tile (start, then size) in plane samples. Blocks, OBMC's overlaps, and tiles are
// aligned powers of two, so a region is the rectangle or the tile along each side; it is empty when an OBMC overlap ends before the tile.
fn interGetRegion(termBase: u32, plane: u32, tileOrigin: vec2u) -> vec4u {
    let subsamplingX = select(0u, INTER_CHROMA_SUBSAMPLING_X, plane != PLANE_Y);
    let subsamplingY = select(0u, INTER_CHROMA_SUBSAMPLING_Y, plane != PLANE_Y);
    let control = interTerms[termBase + INTER_TERM_CONTROL];
    let originWord = interTerms[termBase + INTER_TERM_ORIGIN];
    let origin = vec2u(originWord & SAMPLE_HALF_MASK, originWord >> SAMPLE_HALF_BITS);
    let size = vec2u(1u << getField(control, INTER_TERM_STAGED_WIDTH_SHIFT, INTER_TERM_STAGED_BITS),
        1u << getField(control, INTER_TERM_STAGED_HEIGHT_SHIFT, INTER_TERM_STAGED_BITS));
    let tileEnd = tileOrigin + vec2u((1u << INTER_TILE_SIZE_LOG2) >> subsamplingX, (1u << INTER_TILE_SIZE_LOG2) >> subsamplingY);
    let start = max(origin, tileOrigin);
    return vec4u(start, max(min(origin + size, tileEnd), start) - start);
}

// The first unit of a term's region in its plane, in the tile's raster order
fn interGetTermOwner(termBase: u32, plane: u32, tileOrigin: vec2u) -> u32 {
    let subsamplingX = select(0u, INTER_CHROMA_SUBSAMPLING_X, plane != PLANE_Y);
    let subsamplingY = select(0u, INTER_CHROMA_SUBSAMPLING_Y, plane != PLANE_Y);
    let offset = (interGetRegion(termBase, plane, tileOrigin).xy - tileOrigin) << vec2u(subsamplingX, subsamplingY);
    return ((offset.y >> MI_SIZE_LOG2) << INTER_TILE_UNIT_COLUMNS_LOG2) + (offset.x >> MI_SIZE_LOG2);
}

// The shift of a term's region owner in a unit's shape word: the main and second terms share theirs
fn interGetOwnerShift(term: u32) -> u32 {
    return INTER_UNIT_OWNERS_SHIFT + (max(term, INTER_TERM_SECOND) - INTER_TERM_SECOND) * INTER_UNIT_OWNER_BITS;
}

// The staging slot of a unit plane's term: its region's first unit's
fn interGetTermSlot(unitPlane: u32, shape: u32, term: u32) -> u32 {
    let owner = getField(shape, interGetOwnerShift(term), INTER_UNIT_OWNER_BITS);
    return ((unitPlane & ~(INTER_TILE_UNITS - 1u)) + owner) * INTER_UNIT_TERMS + term;
}

// A translation term's steps per sample in 1/1024 sample, its reference's
fn interGetTermSteps(control: u32) -> vec2<i32> {
    let steps = interGetSteps(getField(control, INTER_TERM_REFERENCE_SHIFT, INTER_TERM_REFERENCE_BITS));
    return vec2<i32>(vec2u(steps & SAMPLE_HALF_MASK, steps >> SAMPLE_HALF_BITS));
}

// A translation term's reference position at a sample of its plane, in 1/1024 sample: the origin's plus the steps
fn interGetTermPosition(termBase: u32, sample: vec2u, steps: vec2<i32>) -> vec2<i32> {
    let originWord = interTerms[termBase + INTER_TERM_ORIGIN];
    let origin = vec2<i32>(vec2u(originWord & SAMPLE_HALF_MASK, originWord >> SAMPLE_HALF_BITS));
    let position = vec2<i32>(bitcast<i32>(interTerms[termBase + INTER_TERM_POSITION_X]), bitcast<i32>(interTerms[termBase + INTER_TERM_POSITION_Y]));
    return position + (vec2<i32>(sample) - origin) * steps;
}

// The reference rows a translation term's region stages: from 3 above its first row's position to 4 below its last's (the region's rows
// and 7 more without scaling)
fn interGetStagedRows(termBase: u32, control: u32, region: vec4u) -> u32 {
    let steps = interGetTermSteps(control);
    let first = interGetTermPosition(termBase, region.xy, steps).y;
    let last = first + i32(region.w - 1u) * steps.y;
    return u32((last >> INTER_SCALE_SUBPEL_BITS) - (first >> INTER_SCALE_SUBPEL_BITS) + INTER_FILTER_TAPS);
}

// Claims the staging of a term whose region a unit plane owns: its slot word (its first intermediate word, none when it does not fit) and
// its items' entries, from the claims counter. Translation stages the region's columns over the reference rows its vertical passes read;
// warp stages 15 rows of each of the region's 8x8 blocks. An empty region (no sample of the tile blends that overlap) claims nothing.
fn interClaimTerm(unitPlane: u32, term: u32, tile: vec3u) {
    let plane = unitPlane / INTER_TILE_UNITS;
    let slot = unitPlane * INTER_UNIT_TERMS + term;
    let termBase = slot * INTER_TERM_WORDS;
    let control = interTerms[termBase + INTER_TERM_CONTROL];
    let region = interGetRegion(termBase, plane, interGetTileOrigin(tile, plane));
    if (region.z == 0u || region.w == 0u) {
        return;
    }
    let widthLog2 = firstTrailingBit(region.z);
    var words: u32;
    var usedItems: u32;
    if (getField(control, INTER_TERM_WARP_SHIFT, 1u) == 1u) {
        let blocks = (region.z * region.w) >> (2u * INTER_WARP_BLOCK_LOG2);
        words = blocks * INTER_WARP_BLOCK_WORDS;
        usedItems = blocks * INTER_WARP_ROWS;
    } else {
        let rows = interGetStagedRows(termBase, control, region);
        words = (rows << widthLog2) >> SAMPLE_PAIR_SHIFT;
        usedItems = rows << (max(widthLog2, INTER_ITEM_INTERMEDIATES_LOG2) - INTER_ITEM_INTERMEDIATES_LOG2);
    }
    let items = (usedItems + 1u) & ~1u;
    let claimed = atomicAdd(&interStagingClaims, (items << INTER_CLAIM_ITEMS_SHIFT) | words);
    let firstItem = claimed >> INTER_CLAIM_ITEMS_SHIFT;
    let firstWord = claimed & INTER_CLAIM_WORDS_MASK;
    let fits = firstItem + items <= INTER_STAGING_ITEMS && firstWord + words <= INTER_STAGING_WORDS;
    interSlots[slot] = select(INTER_SLOT_NONE, firstWord, fits);
    // The claimed items' entries, two per word: the slot and each item's index in it; none for the padding item and a slot that does not fit
    for (var item = 0u; item < items && firstItem + item < INTER_STAGING_ITEMS; item += 2u) {
        var entries = INTER_ITEM_NONE | (INTER_ITEM_NONE << SAMPLE_HALF_BITS);
        if (fits) {
            let second = select(INTER_ITEM_NONE, slot | ((item + 1u) << INTER_ITEM_SLOT_BITS), item + 1u < usedItems);
            entries = (slot | (item << INTER_ITEM_SLOT_BITS)) | (second << SAMPLE_HALF_BITS);
        }
        interScratch[(firstItem + item) >> 1u] = entries;
    }
}

// Claims the staging of every term of a valid unit plane whose region it owns
fn interClaimUnit(unitPlane: u32, tile: vec3u) {
    let control = interUnitControl[unitPlane];
    if (getField(control, INTER_UNIT_VALID_SHIFT, 1u) == 0u) {
        return;
    }
    let shape = interUnitShape[unitPlane];
    // The unit's terms: the main one, the second reference's when compound, the neighbors' when they overlap
    var terms = 1u << INTER_TERM_MAIN;
    if (getField(control, INTER_UNIT_MODE_SHIFT, INTER_UNIT_MODE_BITS) != INTER_MODE_SINGLE) {
        terms |= 1u << INTER_TERM_SECOND;
    }
    if (getField(control, INTER_UNIT_ABOVE_OVERLAP_SHIFT, INTER_UNIT_OVERLAP_BITS) != 0u) {
        terms |= 1u << INTER_TERM_ABOVE;
    }
    if (getField(control, INTER_UNIT_LEFT_OVERLAP_SHIFT, INTER_UNIT_OVERLAP_BITS) != 0u) {
        terms |= 1u << INTER_TERM_LEFT;
    }
    for (var term = 0u; term < INTER_UNIT_TERMS; term += 1u) {
        if (((terms >> term) & 1u) == 1u && interGetTermSlot(unitPlane, shape, term) == unitPlane * INTER_UNIT_TERMS + term) {
            interClaimTerm(unitPlane, term, tile);
        }
    }
}

// Four horizontal pass sums of consecutive columns with one kernel (taps 0-3, 4-7), from the twelve samples of three quads
fn interFilterQuad(kernelLow: vec4<i32>, kernelHigh: vec4<i32>, first: vec4<i32>, second: vec4<i32>, third: vec4<i32>) -> vec4<i32> {
    return vec4<i32>(
        dot(kernelLow, first) + dot(kernelHigh, second),
        dot(kernelLow, vec4<i32>(first.yzw, second.x)) + dot(kernelHigh, vec4<i32>(second.yzw, third.x)),
        dot(kernelLow, vec4<i32>(first.zw, second.xy)) + dot(kernelHigh, vec4<i32>(second.zw, third.xy)),
        dot(kernelLow, vec4<i32>(first.w, second.xyz)) + dot(kernelHigh, vec4<i32>(second.w, third.xyz)));
}

// The two samples of a word, low half first
fn interUnpackPair(word: u32) -> vec2<i32> {
    return vec2<i32>(vec2u(word & SAMPLE_HALF_MASK, word >> SAMPLE_HALF_BITS));
}

// Sixteen samples of a reference row from a column, as four quads (the filters read the first fifteen): whole words where those lie inside
// the plane, each column clamped near its edges
fn interReadRowSixteen(rowBase: u32, column: i32, lastColumn: i32) -> array<vec4<i32>, 4> {
    if (column >= 0 && column + INTER_ITEM_LAST_SAMPLE <= lastColumn) {
        let first = rowBase + (u32(column) >> SAMPLE_PAIR_SHIFT);
        let words0 = vec4u(readFrameWord(first), readFrameWord(first + 1u), readFrameWord(first + 2u), readFrameWord(first + 3u));
        let words1 = vec4u(readFrameWord(first + 4u), readFrameWord(first + 5u), readFrameWord(first + 6u), readFrameWord(first + 7u));
        // From an odd column, each sample pair is a word's high half and the next word's low half
        var pairs0 = words0;
        var pairs1 = words1;
        if ((column & 1) == 1) {
            pairs0 = (words0 >> vec4u(SAMPLE_HALF_BITS)) | (vec4u(words0.yzw, words1.x) << vec4u(SAMPLE_HALF_BITS));
            pairs1 = (words1 >> vec4u(SAMPLE_HALF_BITS)) | (vec4u(words1.yzw, words1.w) << vec4u(SAMPLE_HALF_BITS));
        }
        return array<vec4<i32>, 4>(vec4<i32>(interUnpackPair(pairs0.x), interUnpackPair(pairs0.y)),
            vec4<i32>(interUnpackPair(pairs0.z), interUnpackPair(pairs0.w)), vec4<i32>(interUnpackPair(pairs1.x), interUnpackPair(pairs1.y)),
            vec4<i32>(interUnpackPair(pairs1.z), interUnpackPair(pairs1.w)));
    }
    return array<vec4<i32>, 4>(interReadRowQuad(rowBase, column, lastColumn), interReadRowQuad(rowBase, column + INTER_QUAD_SIZE, lastColumn),
        interReadRowQuad(rowBase, column + 2 * INTER_QUAD_SIZE, lastColumn), interReadRowQuad(rowBase, column + 3 * INTER_QUAD_SIZE, lastColumn));
}

// Writes a staging item's intermediates, rounded to the intermediate precision, two per word: wordCount words of the 8 (low, then high)
fn interWriteIntermediates(wordBase: u32, wordCount: u32, lowSums: vec4<i32>, highSums: vec4<i32>) {
    let rounding = vec4<i32>(INTER_HORIZONTAL_OFFSET + INTER_ROUND_0_HALF);
    let low = vec4u((lowSums + rounding) >> vec4u(INTER_ROUND_0));
    let high = vec4u((highSums + rounding) >> vec4u(INTER_ROUND_0));
    interIntermediates[wordBase] = low.x | (low.y << SAMPLE_HALF_BITS);
    if (wordCount > 1u) {
        interIntermediates[wordBase + 1u] = low.z | (low.w << SAMPLE_HALF_BITS);
    }
    if (wordCount > 2u) {
        interIntermediates[wordBase + 2u] = high.x | (high.y << SAMPLE_HALF_BITS);
        interIntermediates[wordBase + 3u] = high.z | (high.w << SAMPLE_HALF_BITS);
    }
}

// libaom's av1_warp_affine projection of an 8x8 block of a plane (by its first sample) through the model at warpWord: its center's integer
// reference position and the fractional positions of the block's first row and column, reduced to the warp filter's precision
// (ix4, iy4, sx4, sy4); the products fit 32 bits at every accepted size
fn interProjectWarpBlock(warpWord: u32, blockOrigin: vec2u, plane: u32, shears: vec4<i32>) -> vec4<i32> {
    let subsamplingX = select(0u, INTER_CHROMA_SUBSAMPLING_X, plane != PLANE_Y);
    let subsamplingY = select(0u, INTER_CHROMA_SUBSAMPLING_Y, plane != PLANE_Y);
    let sourceX = (i32(blockOrigin.x) + INTER_WARP_BLOCK_CENTER) << subsamplingX;
    let sourceY = (i32(blockOrigin.y) + INTER_WARP_BLOCK_CENTER) << subsamplingY;
    let projectedX = (bitcast<i32>(readRecordWord(warpWord + 2u)) * sourceX + bitcast<i32>(readRecordWord(warpWord + 3u)) * sourceY
        + bitcast<i32>(readRecordWord(warpWord))) >> subsamplingX;
    let projectedY = (bitcast<i32>(readRecordWord(warpWord + 4u)) * sourceX + bitcast<i32>(readRecordWord(warpWord + 5u)) * sourceY
        + bitcast<i32>(readRecordWord(warpWord + 1u))) >> subsamplingY;
    let fractionX = ((projectedX & INTER_WARP_MODEL_MASK) - INTER_WARP_BLOCK_CENTER * (shears.x + shears.y)) & INTER_WARP_PARAMETER_MASK;
    let fractionY = ((projectedY & INTER_WARP_MODEL_MASK) - INTER_WARP_BLOCK_CENTER * (shears.z + shears.w)) & INTER_WARP_PARAMETER_MASK;
    return vec4<i32>(projectedX >> INTER_WARP_MODEL_BITS, projectedY >> INTER_WARP_MODEL_BITS, fractionX, fractionY);
}

// A warp model's shears: alpha, beta, gamma, delta
fn interGetWarpShears(warpWord: u32) -> vec4<i32> {
    let alphaBeta = readRecordWord(warpWord + INTER_WARP_ALPHA_BETA_WORD);
    let gammaDelta = readRecordWord(warpWord + INTER_WARP_GAMMA_DELTA_WORD);
    return vec4<i32>(getSignedField(alphaBeta, 0u, INTER_WARP_PARAMETER_BITS), getSignedField(alphaBeta, INTER_WARP_PARAMETER_BITS, INTER_WARP_PARAMETER_BITS),
        getSignedField(gammaDelta, 0u, INTER_WARP_PARAMETER_BITS), getSignedField(gammaDelta, INTER_WARP_PARAMETER_BITS, INTER_WARP_PARAMETER_BITS));
}

// The warp filter words of four fractional positions: ROUND_POWER_OF_TWO by 10 bits, offset by 64
fn interGetWarpWords(positions: vec4<i32>, tablesBase: u32) -> vec4u {
    let phases = ((positions + vec4<i32>(INTER_WARP_PHASE_HALF)) >> vec4u(INTER_WARP_PHASE_BITS)) + vec4<i32>(INTER_WARP_PHASE_OFFSET);
    return vec4u(tablesBase + INTER_TABLE_WARP_FILTER) + vec4u(phases) * INTER_WARP_FILTER_WORDS;
}

// Four warp horizontal pass sums of consecutive columns, each with its own kernel (two words of four signed byte taps), from the twelve
// samples of three quads
fn interWarpFilterQuad(first: vec4<i32>, second: vec4<i32>, third: vec4<i32>, words: vec4u) -> vec4<i32> {
    return vec4<i32>(
        dot(interReadWarpQuad(words.x), first) + dot(interReadWarpQuad(words.x + 1u), second),
        dot(interReadWarpQuad(words.y), vec4<i32>(first.yzw, second.x)) + dot(interReadWarpQuad(words.y + 1u), vec4<i32>(second.yzw, third.x)),
        dot(interReadWarpQuad(words.z), vec4<i32>(first.zw, second.xy)) + dot(interReadWarpQuad(words.z + 1u), vec4<i32>(second.zw, third.xy)),
        dot(interReadWarpQuad(words.w), vec4<i32>(first.w, second.xyz)) + dot(interReadWarpQuad(words.w + 1u), vec4<i32>(second.w, third.xyz)));
}

// The horizontal pass of a warp item: row k (0-14) of an 8x8 block's 15 (libaom's k - 7), its 8 columns l at the phases of
// sx4 + beta * (k - 3) + alpha * l, from the 15 samples of the reference row from ix4 - 7 (av1_highbd_warp_affine_c's horizontal filter)
fn interStageWarpItem(index: u32, region: vec4u, termBase: u32, plane: u32, rowWords: u32, slotBase: u32, tablesBase: u32) {
    let block = index / INTER_WARP_ROWS;
    let row = index % INTER_WARP_ROWS;
    let blocksLog2 = firstTrailingBit(region.z) - INTER_WARP_BLOCK_LOG2;
    let blockOrigin = region.xy + (vec2u(block & ((1u << blocksLog2) - 1u), block >> blocksLog2) << vec2u(INTER_WARP_BLOCK_LOG2));
    let control = interTerms[termBase + INTER_TERM_CONTROL];
    let referenceIndex = getField(control, INTER_TERM_REFERENCE_SHIFT, INTER_TERM_REFERENCE_BITS);
    let lastSample = interGetReferenceLast(referenceIndex, plane);
    let warpWord = interTerms[termBase + INTER_TERM_WARP_WORD];
    let shears = interGetWarpShears(warpWord);
    let projection = interProjectWarpBlock(warpWord, blockOrigin, plane, shears);
    let referenceRow = clamp(projection.y + i32(row) - INTER_WARP_ROW_CENTER, 0, i32(lastSample >> SAMPLE_HALF_BITS));
    let samples = interReadRowSixteen(interGetReferenceBase(referenceIndex, plane) + u32(referenceRow) * rowWords,
        projection.x - INTER_WARP_ROW_CENTER, i32(lastSample & SAMPLE_HALF_MASK));
    let positions = vec4<i32>(projection.z + shears.y * (i32(row) - INTER_WARP_ROW_CENTER + INTER_WARP_BLOCK_CENTER)) + shears.x * INTER_QUAD_OFFSETS;
    interWriteIntermediates(slotBase + block * INTER_WARP_BLOCK_WORDS + row * INTER_WARP_ROW_WORDS, INTER_WARP_ROW_WORDS,
        interWarpFilterQuad(samples[0], samples[1], samples[2], interGetWarpWords(positions, tablesBase)),
        interWarpFilterQuad(samples[1], samples[2], samples[3], interGetWarpWords(positions + vec4<i32>(shears.x * INTER_QUAD_SIZE), tablesBase)));
}

// The horizontal pass of a scaled translation item: each intermediate at its own position (the term's plus the steps), whose phase picks its
// kernel, from 8 samples clamped to the plane
fn interStageScaledItem(rowBase: u32, firstPosition: i32, step: i32, kernel: u32, lastColumn: i32, wordBase: u32, wordCount: u32,
                        tablesBase: u32) {
    for (var word = 0u; word < wordCount; word += 1u) {
        let positions = vec2<i32>(firstPosition) + vec2<i32>(i32(word << SAMPLE_PAIR_SHIFT)) * step + vec2<i32>(0, step);
        let columns = (positions >> vec2u(INTER_SCALE_SUBPEL_BITS)) + vec2<i32>(INTER_FILTER_FIRST_TAP);
        let kernels = vec2u(interGetKernelWord(tablesBase, kernel, u32((positions.x & INTER_SCALE_SUBPEL_MASK) >> INTER_SCALE_EXTRA_BITS)),
            interGetKernelWord(tablesBase, kernel, u32((positions.y & INTER_SCALE_SUBPEL_MASK) >> INTER_SCALE_EXTRA_BITS)));
        let sums = vec2<i32>(
            dot(interReadKernelQuad(kernels.x), interReadRowQuad(rowBase, columns.x, lastColumn))
                + dot(interReadKernelQuad(kernels.x + 2u), interReadRowQuad(rowBase, columns.x + INTER_QUAD_SIZE, lastColumn)),
            dot(interReadKernelQuad(kernels.y), interReadRowQuad(rowBase, columns.y, lastColumn))
                + dot(interReadKernelQuad(kernels.y + 2u), interReadRowQuad(rowBase, columns.y + INTER_QUAD_SIZE, lastColumn)));
        let intermediates = vec2u((sums + vec2<i32>(INTER_HORIZONTAL_OFFSET + INTER_ROUND_0_HALF)) >> vec2u(INTER_ROUND_0));
        interIntermediates[wordBase + word] = intermediates.x | (intermediates.y << SAMPLE_HALF_BITS);
    }
}

// The horizontal pass of one staging item, packed in pairs: up to 8 intermediates of one row of a translation term's region (the term's
// kernel at its phase, or each column's at its own when scaled), or one row of a warp block's
fn interStageItem(entry: u32, tile: vec3u, tablesBase: u32) {
    let slot = entry & ((1u << INTER_ITEM_SLOT_BITS) - 1u);
    if (slot >= INTER_STAGING_SLOTS) {
        return;
    }
    let index = entry >> INTER_ITEM_SLOT_BITS;
    let plane = slot / (INTER_TILE_UNITS * INTER_UNIT_TERMS);
    let termBase = slot * INTER_TERM_WORDS;
    let control = interTerms[termBase + INTER_TERM_CONTROL];
    let region = interGetRegion(termBase, plane, interGetTileOrigin(tile, plane));
    let rowWords = getStorePlaneWidth(plane) >> SAMPLE_PAIR_SHIFT;
    let slotBase = interSlots[slot];
    if (getField(control, INTER_TERM_WARP_SHIFT, 1u) == 1u) {
        interStageWarpItem(index, region, termBase, plane, rowWords, slotBase, tablesBase);
        return;
    }
    let widthLog2 = firstTrailingBit(region.z);
    let chunksLog2 = max(widthLog2, INTER_ITEM_INTERMEDIATES_LOG2) - INTER_ITEM_INTERMEDIATES_LOG2;
    let row = index >> chunksLog2;
    let chunk = index & ((1u << chunksLog2) - 1u);
    let referenceIndex = getField(control, INTER_TERM_REFERENCE_SHIFT, INTER_TERM_REFERENCE_BITS);
    let lastSample = interGetReferenceLast(referenceIndex, plane);
    let lastColumn = i32(lastSample & SAMPLE_HALF_MASK);
    let steps = interGetTermSteps(control);
    let position = interGetTermPosition(termBase, region.xy + vec2u(chunk << INTER_ITEM_INTERMEDIATES_LOG2, 0u), steps);
    let referenceRow = clamp((position.y >> INTER_SCALE_SUBPEL_BITS) + INTER_FILTER_FIRST_TAP + i32(row), 0, i32(lastSample >> SAMPLE_HALF_BITS));
    let rowBase = interGetReferenceBase(referenceIndex, plane) + u32(referenceRow) * rowWords;
    // The item's words: one per pair of the row's intermediates it holds (a region narrower than 8 samples keeps only its own)
    let wordBase = slotBase + (row << (widthLog2 - SAMPLE_PAIR_SHIFT)) + (chunk << (INTER_ITEM_INTERMEDIATES_LOG2 - SAMPLE_PAIR_SHIFT));
    let wordCount = (1u << min(widthLog2, INTER_ITEM_INTERMEDIATES_LOG2)) >> SAMPLE_PAIR_SHIFT;
    let kernel = getField(control, INTER_TERM_KERNEL_X_SHIFT, INTER_TERM_KERNEL_BITS);
    if (getField(control, INTER_TERM_SCALED_SHIFT, 1u) == 1u) {
        interStageScaledItem(rowBase, position.x, steps.x, kernel, lastColumn, wordBase, wordCount, tablesBase);
        return;
    }
    let kernelWord = interGetKernelWord(tablesBase, kernel, u32((position.x & INTER_SCALE_SUBPEL_MASK) >> INTER_SCALE_EXTRA_BITS));
    let kernelLow = interReadKernelQuad(kernelWord);
    let kernelHigh = interReadKernelQuad(kernelWord + 2u);
    let samples = interReadRowSixteen(rowBase, (position.x >> INTER_SCALE_SUBPEL_BITS) + INTER_FILTER_FIRST_TAP, lastColumn);
    interWriteIntermediates(wordBase, wordCount, interFilterQuad(kernelLow, kernelHigh, samples[0], samples[1], samples[2]),
        interFilterQuad(kernelLow, kernelHigh, samples[1], samples[2], samples[3]));
}

// The vertical pass sums of samples (x, y) and (x + 1, y) of a warp term (x even, in the term's region), from its slot's intermediates:
// rows r to r + 7 of their 8x8 block's 15, each sample's kernel at the phase of sy4 + delta * r + gamma * l (av1_highbd_warp_affine_c)
fn interWarpStagedPair(slotBase: u32, termBase: u32, region: vec4u, plane: u32, x: u32, y: u32, tablesBase: u32) -> vec2<i32> {
    let offset = vec2u(x, y) - region.xy;
    let blocksLog2 = firstTrailingBit(region.z) - INTER_WARP_BLOCK_LOG2;
    let block = ((offset.y >> INTER_WARP_BLOCK_LOG2) << blocksLog2) + (offset.x >> INTER_WARP_BLOCK_LOG2);
    let column = offset.x & INTER_WARP_BLOCK_MASK;
    let row = offset.y & INTER_WARP_BLOCK_MASK;
    let warpWord = interTerms[termBase + INTER_TERM_WARP_WORD];
    let shears = interGetWarpShears(warpWord);
    let projection = interProjectWarpBlock(warpWord, region.xy + (offset & vec2u(~INTER_WARP_BLOCK_MASK)), plane, shears);
    let position = projection.w + shears.w * i32(row) + shears.z * i32(column);
    let words = interGetWarpWords(vec4<i32>(position, position + shears.z, 0, 0), tablesBase);
    let low0 = interReadWarpQuad(words.x);
    let high0 = interReadWarpQuad(words.x + 1u);
    let low1 = interReadWarpQuad(words.y);
    let high1 = interReadWarpQuad(words.y + 1u);
    let first = slotBase + block * INTER_WARP_BLOCK_WORDS + row * INTER_WARP_ROW_WORDS + (column >> SAMPLE_PAIR_SHIFT);
    var sums = vec2<i32>(INTER_VERTICAL_OFFSET);
    sums += vec2<i32>(low0.x, low1.x) * interUnpackPair(interIntermediates[first]);
    sums += vec2<i32>(low0.y, low1.y) * interUnpackPair(interIntermediates[first + INTER_WARP_ROW_WORDS]);
    sums += vec2<i32>(low0.z, low1.z) * interUnpackPair(interIntermediates[first + 2u * INTER_WARP_ROW_WORDS]);
    sums += vec2<i32>(low0.w, low1.w) * interUnpackPair(interIntermediates[first + 3u * INTER_WARP_ROW_WORDS]);
    sums += vec2<i32>(high0.x, high1.x) * interUnpackPair(interIntermediates[first + 4u * INTER_WARP_ROW_WORDS]);
    sums += vec2<i32>(high0.y, high1.y) * interUnpackPair(interIntermediates[first + 5u * INTER_WARP_ROW_WORDS]);
    sums += vec2<i32>(high0.z, high1.z) * interUnpackPair(interIntermediates[first + 6u * INTER_WARP_ROW_WORDS]);
    sums += vec2<i32>(high0.w, high1.w) * interUnpackPair(interIntermediates[first + 7u * INTER_WARP_ROW_WORDS]);
    return sums;
}

// The vertical pass sums of samples (x, y) and (x + 1, y) of a staged term (x even, in the term's region), from its slot's intermediates:
// the 8 staged rows from 3 above the samples' row position, the kernel at its phase
fn interStagedPair(slotBase: u32, termBase: u32, plane: u32, tileOrigin: vec2u, x: u32, y: u32, tablesBase: u32) -> vec2<i32> {
    let control = interTerms[termBase + INTER_TERM_CONTROL];
    let region = interGetRegion(termBase, plane, tileOrigin);
    if (getField(control, INTER_TERM_WARP_SHIFT, 1u) == 1u) {
        return interWarpStagedPair(slotBase, termBase, region, plane, x, y, tablesBase);
    }
    let steps = interGetTermSteps(control);
    let firstPosition = interGetTermPosition(termBase, region.xy, steps).y;
    let position = firstPosition + i32(y - region.y) * steps.y;
    let rowWordsLog2 = firstTrailingBit(region.z) - SAMPLE_PAIR_SHIFT;
    let first = slotBase + (u32((position >> INTER_SCALE_SUBPEL_BITS) - (firstPosition >> INTER_SCALE_SUBPEL_BITS)) << rowWordsLog2)
        + ((x - region.x) >> SAMPLE_PAIR_SHIFT);
    let kernelWord = interGetKernelWord(tablesBase, getField(control, INTER_TERM_KERNEL_Y_SHIFT, INTER_TERM_KERNEL_BITS),
        u32((position & INTER_SCALE_SUBPEL_MASK) >> INTER_SCALE_EXTRA_BITS));
    let kernelLow = interReadKernelQuad(kernelWord);
    let kernelHigh = interReadKernelQuad(kernelWord + 2u);
    let rowWords = 1u << rowWordsLog2;
    var sums = vec2<i32>(INTER_VERTICAL_OFFSET);
    sums += kernelLow.x * interUnpackPair(interIntermediates[first]);
    sums += kernelLow.y * interUnpackPair(interIntermediates[first + rowWords]);
    sums += kernelLow.z * interUnpackPair(interIntermediates[first + 2u * rowWords]);
    sums += kernelLow.w * interUnpackPair(interIntermediates[first + 3u * rowWords]);
    sums += kernelHigh.x * interUnpackPair(interIntermediates[first + 4u * rowWords]);
    sums += kernelHigh.y * interUnpackPair(interIntermediates[first + 5u * rowWords]);
    sums += kernelHigh.z * interUnpackPair(interIntermediates[first + 6u * rowWords]);
    sums += kernelHigh.w * interUnpackPair(interIntermediates[first + 7u * rowWords]);
    return sums;
}

// Four samples of a reference row from firstColumn, each column clamped to the plane
fn interReadRowQuad(rowBase: u32, firstColumn: i32, lastColumn: i32) -> vec4<i32> {
    let columns = vec4u(clamp(vec4<i32>(firstColumn) + INTER_QUAD_OFFSETS, vec4<i32>(0), vec4<i32>(lastColumn)));
    let words = vec4u(readFrameWord(rowBase + (columns.x >> SAMPLE_PAIR_SHIFT)), readFrameWord(rowBase + (columns.y >> SAMPLE_PAIR_SHIFT)),
        readFrameWord(rowBase + (columns.z >> SAMPLE_PAIR_SHIFT)), readFrameWord(rowBase + (columns.w >> SAMPLE_PAIR_SHIFT)));
    return vec4<i32>((words >> ((columns & vec4u(1u)) * SAMPLE_HALF_BITS)) & vec4u(SAMPLE_HALF_MASK));
}

// Prediction

// A single prediction's samples from its vertical pass sums
fn interRoundSingle(sums: vec2<i32>) -> vec2<i32> {
    let samples = ((sums + vec2<i32>(INTER_SINGLE_ROUND_1_HALF)) >> vec2u(INTER_SINGLE_ROUND_1)) - vec2<i32>(INTER_SINGLE_OFFSET);
    return clamp(samples, vec2<i32>(0), vec2<i32>(INTER_SAMPLE_MAXIMUM));
}

// libaom's AOM_BLEND_A64: weight / 64 of the first value, the rest of the second, rounded
fn interBlend(weights: vec2<i32>, first: vec2<i32>, second: vec2<i32>) -> vec2<i32> {
    return (weights * first + (vec2<i32>(INTER_BLEND_MAXIMUM) - weights) * second + vec2<i32>(INTER_BLEND_HALF)) >> vec2u(INTER_BLEND_BITS);
}

// A compound mask value of one sample of a plane block (its position in the block and in the tile): the wedge's, or the luma difference-weighted
// mask kept in the tile; a subsampled plane averages the luma values it covers, as aom_highbd_blend_a64_d16_mask does
fn interReadMask(mode: u32, maskWord: u32, plane: u32, blockPosition: vec2u, tilePosition: vec2u, tablesBase: u32) -> i32 {
    let subsamplingX = select(0u, INTER_CHROMA_SUBSAMPLING_X, plane != PLANE_Y);
    let subsamplingY = select(0u, INTER_CHROMA_SUBSAMPLING_Y, plane != PLANE_Y);
    let strideLog2 = getField(maskWord, INTER_UNIT_STRIDE_SHIFT, INTER_UNIT_STRIDE_BITS);
    let wedgeByte = getField(maskWord, 0u, INTER_UNIT_WEDGE_BITS);
    var sum = 0u;
    for (var row = 0u; row <= subsamplingY; row += 1u) {
        for (var column = 0u; column <= subsamplingX; column += 1u) {
            if (mode == INTER_MODE_DIFFERENCE) {
                let lumaIndex = (((tilePosition.y << subsamplingY) + row) << INTER_TILE_SIZE_LOG2) + (tilePosition.x << subsamplingX) + column;
                sum += (interScratch[lumaIndex >> SAMPLE_PAIR_SHIFT] >> ((lumaIndex & 1u) * SAMPLE_HALF_BITS)) & SAMPLE_HALF_MASK;
            } else {
                let lumaPosition = (blockPosition << vec2u(subsamplingX, subsamplingY)) + vec2u(column, row);
                sum += interReadTableByte(tablesBase, INTER_TABLE_WEDGE_MASKS, wedgeByte + (lumaPosition.y << strideLog2) + lumaPosition.x);
            }
        }
    }
    let shift = subsamplingX + subsamplingY;
    return i32((sum + ((1u << shift) >> 1u)) >> shift);
}

// Predicts samples (x, y) and (x + 1, y) of a plane, x even, from their unit plane: its terms' sums rounded to samples (single) or blended
// at 16 bits (compound: average, distance weights, or a wedge or difference-weighted mask), then OBMC's blends with the above and the left
// neighbors' predictions; a luma difference-weighted unit keeps its mask in the tile for the chroma planes
fn interPredictPair(unitPlane: u32, plane: u32, x: u32, y: u32, tilePosition: vec2u, tablesBase: u32) -> vec2u {
    let control = interUnitControl[unitPlane];
    let mode = getField(control, INTER_UNIT_MODE_SHIFT, INTER_UNIT_MODE_BITS);
    let unitTerms = unitPlane * INTER_UNIT_TERMS * INTER_TERM_WORDS;
    let origin = interTerms[unitTerms + INTER_TERM_ORIGIN];
    let blockPosition = vec2u(x - (origin & SAMPLE_HALF_MASK), y - (origin >> SAMPLE_HALF_BITS));
    let aboveOverlap = getField(control, INTER_UNIT_ABOVE_OVERLAP_SHIFT, INTER_UNIT_OVERLAP_BITS);
    let leftOverlap = getField(control, INTER_UNIT_LEFT_OVERLAP_SHIFT, INTER_UNIT_OVERLAP_BITS);
    var needed = 1u << INTER_TERM_MAIN;
    if (mode != INTER_MODE_SINGLE) {
        needed |= 1u << INTER_TERM_SECOND;
    }
    if (blockPosition.y < aboveOverlap) {
        needed |= 1u << INTER_TERM_ABOVE;
    }
    if (blockPosition.x < leftOverlap) {
        needed |= 1u << INTER_TERM_LEFT;
    }
    var mainSums = vec2<i32>(0);
    var secondSums = vec2<i32>(0);
    var aboveSums = vec2<i32>(0);
    var leftSums = vec2<i32>(0);
    let shape = interUnitShape[unitPlane];
    let tileOrigin = vec2u(x, y) - tilePosition;
    for (var term = 0u; term < INTER_UNIT_TERMS; term += 1u) {
        if (((needed >> term) & 1u) == 0u) {
            continue;
        }
        // The term's slot, which its region's first unit holds (staging always fits a plane, so it has one)
        let slot = interGetTermSlot(unitPlane, shape, term);
        let sums = interStagedPair(interSlots[slot], slot * INTER_TERM_WORDS, plane, tileOrigin, x, y, tablesBase);
        switch (term) {
            case INTER_TERM_MAIN: {
                mainSums = sums;
            }
            case INTER_TERM_SECOND: {
                secondSums = sums;
            }
            case INTER_TERM_ABOVE: {
                aboveSums = sums;
            }
            default: {
                leftSums = sums;
            }
        }
    }
    if (mode == INTER_MODE_SINGLE) {
        var samples = interRoundSingle(mainSums);
        if (blockPosition.y < aboveOverlap) {
            let weight = i32(interReadTableByte(tablesBase, INTER_TABLE_OBMC_MASKS, aboveOverlap - 1u + blockPosition.y));
            samples = interBlend(vec2<i32>(weight), samples, interRoundSingle(aboveSums));
        }
        if (blockPosition.x < leftOverlap) {
            let maskByte = leftOverlap - 1u + blockPosition.x;
            let weights = vec2<i32>(i32(interReadTableByte(tablesBase, INTER_TABLE_OBMC_MASKS, maskByte)),
                i32(interReadTableByte(tablesBase, INTER_TABLE_OBMC_MASKS, maskByte + 1u)));
            samples = interBlend(weights, samples, interRoundSingle(leftSums));
        }
        return vec2u(samples);
    }
    let compound0 = (mainSums + vec2<i32>(INTER_COMPOUND_ROUND1_HALF)) >> vec2u(INTER_COMPOUND_ROUND1_BITS);
    let compound1 = (secondSums + vec2<i32>(INTER_COMPOUND_ROUND1_HALF)) >> vec2u(INTER_COMPOUND_ROUND1_BITS);
    var blended: vec2<i32>;
    switch (mode) {
        case INTER_MODE_AVERAGE: {
            blended = (compound0 + compound1) >> vec2u(1u);
        }
        case INTER_MODE_DISTANCE: {
            let forward = i32(getField(control, INTER_UNIT_FORWARD_SHIFT, INTER_UNIT_WEIGHT_BITS));
            let backward = i32(getField(control, INTER_UNIT_BACKWARD_SHIFT, INTER_UNIT_WEIGHT_BITS));
            blended = (compound0 * forward + compound1 * backward) >> vec2u(INTER_DISTANCE_BITS);
        }
        default: {
            var masks: vec2<i32>;
            if (mode == INTER_MODE_DIFFERENCE && plane == PLANE_Y) {
                // diffwtd_mask_d16: the mask of the two predictions' rounded difference, inverted for DIFFWTD_38_INV
                let difference = (abs(compound0 - compound1) + vec2<i32>(INTER_DIFFERENCE_ROUND_HALF)) >> vec2u(INTER_DIFFERENCE_ROUND_BITS);
                masks = min(vec2<i32>(INTER_DIFFERENCE_MASK_BASE) + (difference >> vec2u(INTER_DIFFERENCE_FACTOR_BITS)), vec2<i32>(INTER_BLEND_MAXIMUM));
                if (getField(control, INTER_UNIT_INVERSE_SHIFT, 1u) == 1u) {
                    masks = vec2<i32>(INTER_BLEND_MAXIMUM) - masks;
                }
                interScratch[((tilePosition.y << INTER_TILE_SIZE_LOG2) + tilePosition.x) >> SAMPLE_PAIR_SHIFT] = u32(masks.x) | (u32(masks.y) << SAMPLE_HALF_BITS);
            } else {
                masks = vec2<i32>(interReadMask(mode, shape, plane, blockPosition, tilePosition, tablesBase),
                    interReadMask(mode, shape, plane, blockPosition + vec2u(1u, 0u), tilePosition + vec2u(1u, 0u), tablesBase));
            }
            blended = (masks * compound0 + (vec2<i32>(INTER_BLEND_MAXIMUM) - masks) * compound1) >> vec2u(INTER_BLEND_BITS);
        }
    }
    let samples = (blended - vec2<i32>(INTER_COMPOUND_OFFSET) + vec2<i32>(INTER_COMPOUND_ROUND_HALF)) >> vec2u(INTER_COMPOUND_ROUND_BITS);
    return vec2u(clamp(samples, vec2<i32>(0), vec2<i32>(INTER_SAMPLE_MAXIMUM)));
}

// Predicts every inter sample pair of planes firstPlane to firstPlane + planeCount - 1 of the tile (planes of one subsampling) into the target
// buffer, whole blocks as libaom predicts them, past the mode info grid too, inside the planes' storage; lanes take pairs in turn
fn interPredictPlanes(firstPlane: u32, planeCount: u32, tile: vec3u, lane: u32, tablesBase: u32) {
    let subsamplingX = select(0u, INTER_CHROMA_SUBSAMPLING_X, firstPlane != PLANE_Y);
    let subsamplingY = select(0u, INTER_CHROMA_SUBSAMPLING_Y, firstPlane != PLANE_Y);
    let tileOrigin = interGetTileOrigin(tile, firstPlane);
    let pairColumnsLog2 = INTER_TILE_SIZE_LOG2 - subsamplingX - SAMPLE_PAIR_SHIFT;
    let pairsLog2 = pairColumnsLog2 + INTER_TILE_SIZE_LOG2 - subsamplingY;
    let storeWidth = getStorePlaneWidth(firstPlane);
    let storeHeight = getStorePlaneHeight(firstPlane);
    let targetBuffer = readRecordWord(RECORD_HEADER_TARGET_BUFFER);
    for (var index = lane; index < (planeCount << pairsLog2); index += INTER_WORKGROUP_SIZE) {
        let plane = firstPlane + (index >> pairsLog2);
        let pair = index & ((1u << pairsLog2) - 1u);
        let tilePosition = vec2u((pair & ((1u << pairColumnsLog2) - 1u)) << SAMPLE_PAIR_SHIFT, pair >> pairColumnsLog2);
        let x = tileOrigin.x + tilePosition.x;
        let y = tileOrigin.y + tilePosition.y;
        if (x >= storeWidth || y >= storeHeight) {
            continue;
        }
        let unitPlane = plane * INTER_TILE_UNITS + (((tilePosition.y << subsamplingY) >> MI_SIZE_LOG2) << INTER_TILE_UNIT_COLUMNS_LOG2)
            + ((tilePosition.x << subsamplingX) >> MI_SIZE_LOG2);
        if (getField(interUnitControl[unitPlane], INTER_UNIT_VALID_SHIFT, 1u) == 0u) {
            continue;
        }
        let samples = interPredictPair(unitPlane, plane, x, y, tilePosition, tablesBase);
        writeFrameWord(getStoreWordIndex(targetBuffer, plane, x, y), samples.x | (samples.y << SAMPLE_HALF_BITS));
    }
}

// The planes predictInter predicts in a tile, the same for every lane (0 when it predicts none there); also clears the tile's staging claims.
// All 64 lanes call it in uniform control flow.
fn interBeginTile(tile: vec3u, lane: u32) -> u32 {
    if (lane == 0u) {
        var planeCount = 0u;
        // Blocks straddling the mode info grid's edge reach at most a 128-sample block's width past it
        if (tile.z == 0u && isDecodingFrame() && !hasRecordFlag(RECORD_FLAG_INTRA_ONLY)
            && (tile.x << INTER_TILE_UNIT_COLUMNS_LOG2) < readRecordWord(RECORD_HEADER_MI_COLUMNS) + INTER_MAXIMUM_BLOCK_UNITS
            && (tile.y << INTER_TILE_UNIT_COLUMNS_LOG2) < readRecordWord(RECORD_HEADER_MI_ROWS) + INTER_MAXIMUM_BLOCK_UNITS) {
            planeCount = select(RECORD_PLANES, 1u, hasRecordFlag(RECORD_FLAG_MONOCHROME));
        }
        interTilePlaneCount = planeCount;
        atomicStore(&interStagingClaims, 0u);
    }
    return workgroupUniformLoad(&interTilePlaneCount);
}

// Sets up the tile at once: one lane per unit plane of the planes it predicts, the lanes after them the references' words; then waits for them.
// All 64 lanes call it in uniform control flow.
fn interSetupTile(tile: vec3u, lane: u32, planeCount: u32) {
    if (lane < planeCount * INTER_TILE_UNITS) {
        interSetupUnit(lane, tile);
    } else if (lane >= INTER_REFERENCE_FIRST_LANE && lane < INTER_REFERENCE_FIRST_LANE + RECORD_REFERENCES) {
        interSetupReference(lane - INTER_REFERENCE_FIRST_LANE);
    }
    workgroupBarrier();
}

// Claims the staging of the terms the unit planes from firstUnitPlane on own (unitPlaneCount of them, one lane each), then waits for the
// claims; returns whether they overflowed the staging. All 64 lanes call it in uniform control flow.
fn interClaimTile(tile: vec3u, lane: u32, firstUnitPlane: u32, unitPlaneCount: u32) -> bool {
    if (lane >= firstUnitPlane && lane < firstUnitPlane + unitPlaneCount) {
        interClaimUnit(lane, tile);
    }
    workgroupBarrier();
    if (lane == 0u) {
        let claims = atomicLoad(&interStagingClaims);
        interTileOverflow = select(0u, 1u, (claims >> INTER_CLAIM_ITEMS_SHIFT) > INTER_STAGING_ITEMS
            || (claims & INTER_CLAIM_WORDS_MASK) > INTER_STAGING_WORDS);
    }
    return workgroupUniformLoad(&interTileOverflow) == 1u;
}

// Runs every claimed staging item from firstItem on, lanes in turn, then waits for the intermediates (the scratch words before firstItem's
// are free from then on). All 64 lanes call it in uniform control flow.
fn interStageTile(tile: vec3u, lane: u32, firstItem: u32, tablesBase: u32) {
    let itemEnd = min(atomicLoad(&interStagingClaims) >> INTER_CLAIM_ITEMS_SHIFT, INTER_STAGING_ITEMS);
    for (var item = firstItem + lane; item < itemEnd; item += INTER_WORKGROUP_SIZE) {
        interStageItem((interScratch[item >> 1u] >> ((item & 1u) * SAMPLE_HALF_BITS)) & SAMPLE_HALF_MASK, tile, tablesBase);
    }
    workgroupBarrier();
}

// predictInter's work for a 16x16 luma tile (x, y) and every plane of it: each sample of each inter (not IntraBC) block into the target
// buffer: translation with scaled references and dual filters, compound average, distance, wedge, and difference-weighted, OBMC, local and
// global warp, sub-8x8 chroma, and the inter part of inter-intra blocks. Expects a grid of z 1 (tiles of z above 0 return at once).
// All 64 lanes call it; it holds workgroup barriers, so the caller calls it in uniform control flow.
// Its phases: every plane's units and the references, the staging claims, the staged horizontal passes, luma's samples, then the chroma
// planes' samples, which read luma's difference-weighted masks. When the claims overflow the staging, it stages and predicts one plane at
// a time instead.
fn interPredictTile(tile: vec3u, lane: u32) {
    let planeCount = interBeginTile(tile, lane);
    if (planeCount == 0u) {
        return;
    }
    let tablesBase = getTablesOffset() + INTER_TABLES_OFFSET;
    interSetupTile(tile, lane, planeCount);
    let overflow = interClaimTile(tile, lane, 0u, planeCount * INTER_TILE_UNITS);
    // One round of every plane, or one round per plane when the claims overflowed; each heavy phase has one call site
    let roundCount = select(1u, planeCount, overflow);
    var firstItem = 0u;
    for (var round = 0u; round < roundCount; round += 1u) {
        if (overflow) {
            // The previous round's samples are done with its slots and intermediates
            workgroupBarrier();
            if (lane == 0u) {
                atomicStore(&interStagingClaims, INTER_PLANE_ROUND_FIRST_ITEM << INTER_CLAIM_ITEMS_SHIFT);
            }
            workgroupBarrier();
            _ = interClaimTile(tile, lane, round * INTER_TILE_UNITS, INTER_TILE_UNITS);
            firstItem = INTER_PLANE_ROUND_FIRST_ITEM;
        }
        interStageTile(tile, lane, firstItem, tablesBase);
        // Luma (or the round's plane), then the chroma planes, which read luma's difference-weighted masks
        for (var phase = 0u; phase < INTER_PREDICTION_PHASES; phase += 1u) {
            var firstPlane = select(PLANE_Y, PLANE_U, phase == 1u);
            var phasePlanes = select(1u, planeCount - 1u, phase == 1u);
            if (overflow) {
                firstPlane = round;
                phasePlanes = select(1u, 0u, phase == 1u);
            }
            if (phasePlanes != 0u) {
                interPredictPlanes(firstPlane, phasePlanes, tile, lane, tablesBase);
            }
            workgroupBarrier();
        }
    }
}

// One sample of the target buffer for IntraBC, its coordinates clamped to the plane's storage (valid displacements never leave the tile)
fn interReadIntraBlockCopySample(planeBase: u32, rowWords: u32, limits: vec2<i32>, x: i32, y: i32) -> u32 {
    let column = u32(clamp(x, 0, limits.x));
    let row = u32(clamp(y, 0, limits.y));
    return (readFrameWord(planeBase + row * rowWords + (column >> SAMPLE_PAIR_SHIFT)) >> ((column & 1u) * SAMPLE_HALF_BITS)) & SAMPLE_HALF_MASK;
}

// The IntraBC block's prediction of a plane, by all 64 lanes together: the target buffer's samples at the block's displacement, which is whole
// in luma, averaged by libaom's 2-tap av1_intrabc_filter_params where chroma lands on half samples (the plane block from the group's origin,
// at least 4x4, as for sub-8x8 chroma), into the target buffer: the whole block, past the mode info grid too, inside the plane's storage.
// libaom reads its own frame unclamped and valid displacements stay inside the tile's mode info grid, so the reads clamp to the storage only.
// The source never overlaps the block (libaom's av1_is_dv_valid), so the lanes need no barrier; the caller places one before other lanes read the block.
fn interPredictIntraBlockCopy(blockIndex: u32, plane: u32, lane: u32) {
    let subsamplingX = select(0u, INTER_CHROMA_SUBSAMPLING_X, plane != PLANE_Y);
    let subsamplingY = select(0u, INTER_CHROMA_SUBSAMPLING_Y, plane != PLANE_Y);
    let position = readBlockWord(blockIndex, RECORD_BLOCK_POSITION);
    let blockSize = getField(position, RECORD_BLOCK_SIZE_SHIFT, RECORD_BLOCK_SIZE_BITS);
    let widthLog2 = getBlockWidthLog2(blockSize);
    let heightLog2 = getBlockHeightLog2(blockSize);
    let groupColumn = select(0u, 1u, subsamplingX == 1u && widthLog2 == MI_SIZE_LOG2);
    let groupRow = select(0u, 1u, subsamplingY == 1u && heightLog2 == MI_SIZE_LOG2);
    let origin = vec2u(((getField(position, RECORD_BLOCK_MI_COLUMN_SHIFT, RECORD_BLOCK_MI_BITS) - groupColumn) << MI_SIZE_LOG2) >> subsamplingX,
        ((getField(position, RECORD_BLOCK_MI_ROW_SHIFT, RECORD_BLOCK_MI_BITS) - groupRow) << MI_SIZE_LOG2) >> subsamplingY);
    let widthLog2Plane = max(widthLog2 - subsamplingX, MI_SIZE_LOG2);
    let heightLog2Plane = max(heightLog2 - subsamplingY, MI_SIZE_LOG2);
    let motionVector = readRecordWord(getBlockExtensionOffset(blockIndex) + RECORD_MOTION_VECTOR_0);
    let source = (vec2<i32>(origin) << vec2u(INTER_SUBPEL_BITS)) + vec2<i32>(
        getSignedField(motionVector, INTER_MOTION_VECTOR_COLUMN_SHIFT, INTER_MOTION_VECTOR_BITS) << (INTER_MOTION_VECTOR_PLANE_SHIFT - subsamplingX),
        getSignedField(motionVector, INTER_MOTION_VECTOR_ROW_SHIFT, INTER_MOTION_VECTOR_BITS) << (INTER_MOTION_VECTOR_PLANE_SHIFT - subsamplingY));
    let sourceSample = source >> vec2u(INTER_SUBPEL_BITS);
    let halfX = (source.x & INTER_SUBPEL_MASK) != 0;
    let halfY = (source.y & INTER_SUBPEL_MASK) != 0;
    let planeBase = getStoreWordIndex(readRecordWord(RECORD_HEADER_TARGET_BUFFER), plane, 0u, 0u);
    let storeWidth = getStorePlaneWidth(plane);
    let storeHeight = getStorePlaneHeight(plane);
    let rowWords = storeWidth >> SAMPLE_PAIR_SHIFT;
    let limits = vec2<i32>(i32(storeWidth) - 1, i32(storeHeight) - 1);
    let pairColumnsLog2 = widthLog2Plane - SAMPLE_PAIR_SHIFT;
    let pairCount = 1u << (pairColumnsLog2 + heightLog2Plane);
    for (var pair = lane; pair < pairCount; pair += INTER_WORKGROUP_SIZE) {
        let blockX = (pair & ((1u << pairColumnsLog2) - 1u)) << SAMPLE_PAIR_SHIFT;
        let blockY = pair >> pairColumnsLog2;
        let x = origin.x + blockX;
        let y = origin.y + blockY;
        if (x >= storeWidth || y >= storeHeight) {
            continue;
        }
        var samples = vec2u(0u);
        for (var pairSample = 0u; pairSample < 2u; pairSample += 1u) {
            let sourceX = sourceSample.x + i32(blockX + pairSample);
            let sourceY = sourceSample.y + i32(blockY);
            var sum = interReadIntraBlockCopySample(planeBase, rowWords, limits, sourceX, sourceY);
            var count = 1u;
            if (halfX) {
                sum += interReadIntraBlockCopySample(planeBase, rowWords, limits, sourceX + 1, sourceY);
                count = 2u;
            }
            if (halfY) {
                sum += interReadIntraBlockCopySample(planeBase, rowWords, limits, sourceX, sourceY + 1);
                count += count;
                if (halfX) {
                    sum += interReadIntraBlockCopySample(planeBase, rowWords, limits, sourceX + 1, sourceY + 1);
                }
            }
            // The bilinear average of 1, 2, or 4 samples, rounded (av1_highbd_convolve_2d_sr_intrabc_c and its one-dimensional forms)
            let shift = countTrailingZeros(count);
            let value = (sum + (count >> 1u)) >> shift;
            if (pairSample == 0u) {
                samples.x = value;
            } else {
                samples.y = value;
            }
        }
        writeFrameWord(planeBase + y * rowWords + (x >> SAMPLE_PAIR_SHIFT), samples.x | (samples.y << SAMPLE_HALF_BITS));
    }
}

// One sample of an inter-intra block's prediction (libaom's av1_combine_interintra): the intra prediction blended over the inter prediction with
// the block's smooth weights for its INTERINTRA_MODE or its wedge mask (sign 0, subsampled for chroma); x and y are the sample's position in the plane block
fn interBlendInterIntra(blockIndex: u32, plane: u32, x: u32, y: u32, interSample: u32, intraSample: u32) -> u32 {
    let subsamplingX = select(0u, INTER_CHROMA_SUBSAMPLING_X, plane != PLANE_Y);
    let subsamplingY = select(0u, INTER_CHROMA_SUBSAMPLING_Y, plane != PLANE_Y);
    let blockSize = getField(readBlockWord(blockIndex, RECORD_BLOCK_POSITION), RECORD_BLOCK_SIZE_SHIFT, RECORD_BLOCK_SIZE_BITS);
    let compoundWord = readRecordWord(getBlockExtensionOffset(blockIndex) + RECORD_MOTION_COMPOUND);
    let tablesBase = getTablesOffset() + INTER_TABLES_OFFSET;
    let widthLog2 = getBlockWidthLog2(blockSize);
    var weight = 0u;
    if (getField(compoundWord, RECORD_MOTION_INTERINTRA_WEDGE_SHIFT, 1u) == 1u) {
        let wedgeIndex = getField(compoundWord, RECORD_MOTION_INTERINTRA_WEDGE_INDEX_SHIFT, RECORD_MOTION_WEDGE_INDEX_BITS);
        let maskWord = interGetWedgeByte(blockSize, wedgeIndex, INTER_INTERINTRA_WEDGE_SIGN) | (widthLog2 << INTER_UNIT_STRIDE_SHIFT);
        weight = u32(interReadMask(INTER_MODE_WEDGE, maskWord, plane, vec2u(x, y), vec2u(0u), tablesBase));
    } else {
        let scaleLog2 = INTER_INTERINTRA_SCALE_LOG2 - max(widthLog2 - subsamplingX, getBlockHeightLog2(blockSize) - subsamplingY);
        switch (getField(compoundWord, RECORD_MOTION_INTERINTRA_MODE_SHIFT, RECORD_MOTION_INTERINTRA_MODE_BITS)) {
            case INTER_INTERINTRA_VERTICAL: {
                weight = interReadTableByte(tablesBase, INTER_TABLE_INTERINTRA_WEIGHTS, y << scaleLog2);
            }
            case INTER_INTERINTRA_HORIZONTAL: {
                weight = interReadTableByte(tablesBase, INTER_TABLE_INTERINTRA_WEIGHTS, x << scaleLog2);
            }
            case INTER_INTERINTRA_SMOOTH: {
                weight = interReadTableByte(tablesBase, INTER_TABLE_INTERINTRA_WEIGHTS, min(x, y) << scaleLog2);
            }
            default: {
                weight = INTER_INTERINTRA_DC_WEIGHT;
            }
        }
    }
    return (weight * intraSample + (u32(INTER_BLEND_MAXIMUM) - weight) * interSample + u32(INTER_BLEND_HALF)) >> INTER_BLEND_BITS;
}
