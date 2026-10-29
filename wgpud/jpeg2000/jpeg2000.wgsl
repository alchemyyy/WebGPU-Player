//! id: jpeg2000
//! name: JPEG 2000
//! decoder: video
//! accepts: codec in [jpeg2000], stream.width <= 8192, stream.height <= 8192, stream.width * stream.height <= 11010048
//! output: I420, I420P10, I420P12, I422, I422P10, I422P12, I444, I444P10, I444P12
//! parser: 2
//! packet: 32 MiB
//! state: 16
//! buffer: control, 256, indirect
//! buffer: coefficients, 4 * stream.width * stream.height * (1 + 2 / (output.chromaWidthDivisor * output.chromaHeightDivisor))
//! buffer: transformScratch, 4 * stream.width * stream.height * (1 + 2 / (output.chromaWidthDivisor * output.chromaHeightDivisor))
//! error: 1, recordInvalid
//! error: 2, codestreamMissing, resync
//! error: 3, markerSegment, resync
//! error: 4, imageSize
//! error: 5, componentCount
//! error: 6, colourSpace
//! error: 7, bitDepth
//! error: 8, chromaFormat
//! error: 9, codingStyle
//! error: 10, quantization
//! error: 11, progressionOrder
//! error: 12, tilePart, resync
//! error: 13, passCount, resync
//! error: 14, unsupportedFeature
//! error: 15, outputFormat
//! error: 16, pictureSize
//! error: 17, resourceLimit
//! error: 18, regionOfInterest
//! error: 19, tileMissing, resync
//! error: 20, lengthBits, resync
//! error: 21, magnitudeBits, resync
//! error: 22, packetData, resync
//! error: 23, codeBlockLength, resync
//! error: 24, pictureArea
//! dispatch: beginPicture, 1
//! dispatch: clearCoefficients, indirect control
//! dispatch: planCodeBlocks, 1
//! dispatch: decodeCodeBlocks, indirect control
//! dispatch: planSmallLevels, 1
//! dispatch: transformSmallLevels, indirect control
//! repeat: (max(stream.width, stream.height) > 64) + (max(stream.width, stream.height) > 128) + (max(stream.width, stream.height) > 256) + (max(stream.width, stream.height) > 512) + (max(stream.width, stream.height) > 1024) + (max(stream.width, stream.height) > 2048) + (max(stream.width, stream.height) > 4096), 4
//! dispatch: planHorizontal, 1
//! dispatch: transformHorizontal, indirect control
//! dispatch: planVertical, 1
//! dispatch: transformVertical, indirect control
//! dispatch: writeOutput, ceil(stream.width * output.bytesPerSample / 256), stream.height, 3

// The JPEG 2000 decoder (ISO/IEC 15444-1), bit-exact with FFmpeg's native jpeg2000 decoder, with the 9/7 wavelet on FFmpeg's integer path (its bitexact flag).
// Its packets are the GPU records its CPU parser (parser/) makes of each codestream: the parser reads the headers and runs tier-2,
// so every code block arrives with its coded bytes, pass count, and dequantization; these passes then run tier-1 with one invocation per code block,
// the inverse wavelet level by level, the inverse component transform, and the DC level shift into the output planes.
// A Digital Cinema XYZ picture, which FFmpeg decodes to xyz12, leaves through FFmpeg's XYZ to RGB conversion as limited-range BT.709 Y'CbCr.
// Wavelet levels whose region fits SMALL_LEVEL_SIZE samples on both axes run in one workgroup per tile-component; each larger level
// dispatches its horizontal and vertical passes over every tile-component that has it, as many times as the largest stream allows.

// The GPU record the parser writes for each picture: its magic and version, then word offsets of its tables.
// parser/build.rs reads these RECORD_ declarations and the ERROR_ codes below, so the parser and the passes share one layout
const RECORD_MAGIC: u32 = 1380659786u;
const RECORD_VERSION: u32 = 2u;
const RECORD_MAXIMUM_BYTE_LENGTH: u32 = 33554432u;
// The largest picture the header accepts, past which the parser fails a codestream before any tier-2 work
const RECORD_MAXIMUM_PICTURE_SIDE: u32 = 8192u;
const RECORD_MAXIMUM_PICTURE_AREA: u32 = 11010048u;
const RECORD_HEADER_MAGIC: u32 = 0u;
const RECORD_HEADER_VERSION: u32 = 1u;
const RECORD_HEADER_BYTE_LENGTH: u32 = 2u;
const RECORD_HEADER_WIDTH: u32 = 3u;
const RECORD_HEADER_HEIGHT: u32 = 4u;
const RECORD_HEADER_CHROMA_FORMAT: u32 = 5u;
const RECORD_HEADER_OUTPUT_BIT_DEPTH: u32 = 6u;
const RECORD_HEADER_FORMAT_ERROR: u32 = 7u;
const RECORD_HEADER_TILE_COLUMNS: u32 = 8u;
const RECORD_HEADER_TILE_ROWS: u32 = 9u;
const RECORD_HEADER_TILE_WIDTH: u32 = 10u;
const RECORD_HEADER_TILE_HEIGHT: u32 = 11u;
const RECORD_HEADER_TILE_OFFSET_X: u32 = 12u;
const RECORD_HEADER_TILE_OFFSET_Y: u32 = 13u;
const RECORD_HEADER_IMAGE_X0: u32 = 14u;
const RECORD_HEADER_IMAGE_Y0: u32 = 15u;
const RECORD_HEADER_IMAGE_X1: u32 = 16u;
const RECORD_HEADER_IMAGE_Y1: u32 = 17u;
const RECORD_HEADER_TILE_TABLE: u32 = 18u;
const RECORD_HEADER_TILE_COMPONENT_TABLE: u32 = 19u;
const RECORD_HEADER_TILE_COMPONENT_COUNT: u32 = 20u;
const RECORD_HEADER_CODE_BLOCK_TABLE: u32 = 21u;
const RECORD_HEADER_CODE_BLOCK_COUNT: u32 = 22u;
const RECORD_HEADER_COEFFICIENT_WORDS: u32 = 23u;
const RECORD_HEADER_SMALL_JOB_TABLE: u32 = 24u;
const RECORD_HEADER_SMALL_JOB_COUNT: u32 = 25u;
const RECORD_HEADER_BIG_ITERATION_TABLE: u32 = 26u;
const RECORD_HEADER_BIG_ITERATION_COUNT: u32 = 27u;
const RECORD_HEADER_OUTPUT_TRANSFORM: u32 = 28u;
const RECORD_HEADER_PLANES: u32 = 29u;
const RECORD_HEADER_WORDS: u32 = 56u;
// The conversion the output stage applies: none, or an XYZ picture's, whose planes hold X', Y', and Z' and which it writes as BT.709 Y'CbCr
const RECORD_OUTPUT_TRANSFORM_NONE: u32 = 0u;
const RECORD_OUTPUT_TRANSFORM_XYZ: u32 = 1u;
// An output plane: the component it shows, its size and origin as FFmpeg allocates and fills it, its subsampling, and its sample conversion
const RECORD_PLANE_COMPONENT: u32 = 0u;
const RECORD_PLANE_WIDTH: u32 = 1u;
const RECORD_PLANE_HEIGHT: u32 = 2u;
const RECORD_PLANE_ORIGIN_X: u32 = 3u;
const RECORD_PLANE_ORIGIN_Y: u32 = 4u;
const RECORD_PLANE_DIVISOR_X: u32 = 5u;
const RECORD_PLANE_DIVISOR_Y: u32 = 6u;
const RECORD_PLANE_COMPONENT_BITS: u32 = 7u;
const RECORD_PLANE_SHIFT: u32 = 8u;
const RECORD_PLANE_WORDS: u32 = 9u;
const RECORD_PLANE_COUNT: u32 = 3u;
// A tile: its component transform and, per component slot, the tile-component index or RECORD_MISSING
const RECORD_TILE_TRANSFORM: u32 = 0u;
const RECORD_TILE_COMPONENTS: u32 = 1u;
const RECORD_TILE_WORDS: u32 = 5u;
const RECORD_COMPONENT_SLOTS: u32 = 4u;
const RECORD_MISSING: u32 = 4294967295u;
const RECORD_COMPONENT_TRANSFORM_NONE: u32 = 0u;
const RECORD_COMPONENT_TRANSFORM_REVERSIBLE: u32 = 1u;
const RECORD_COMPONENT_TRANSFORM_IRREVERSIBLE: u32 = 2u;
// A tile-component: its coefficients, size, and origin in component coordinates, and its wavelet levels
const RECORD_TILE_COMPONENT_COEFFICIENTS: u32 = 0u;
const RECORD_TILE_COMPONENT_WIDTH: u32 = 1u;
const RECORD_TILE_COMPONENT_HEIGHT: u32 = 2u;
const RECORD_TILE_COMPONENT_X0: u32 = 3u;
const RECORD_TILE_COMPONENT_Y0: u32 = 4u;
const RECORD_TILE_COMPONENT_LEVEL_COUNT: u32 = 5u;
const RECORD_TILE_COMPONENT_FIRST_BIG_LEVEL: u32 = 6u;
const RECORD_TILE_COMPONENT_LEVELS: u32 = 7u;
const RECORD_TILE_COMPONENT_WAVELET: u32 = 8u;
const RECORD_TILE_COMPONENT_FINAL_SHIFT: u32 = 9u;
const RECORD_TILE_COMPONENT_WORDS: u32 = 10u;
const RECORD_WAVELET_IRREVERSIBLE: u32 = 0u;
const RECORD_WAVELET_REVERSIBLE: u32 = 1u;
// A wavelet level, coarsest first: the region it reconstructs, each size with its origin's parity in bit 16
const RECORD_LEVEL_WIDTH: u32 = 0u;
const RECORD_LEVEL_HEIGHT: u32 = 1u;
const RECORD_LEVEL_WORDS: u32 = 2u;
const RECORD_LEVEL_PARITY_SHIFT: u32 = 16u;
const RECORD_LEVEL_SIZE_MASK: u32 = 65535u;
// A code block, in decode order: where its coefficients go, its coded bytes with FFmpeg's inserted terminators, and its tier-1 parameters
const RECORD_CODE_BLOCK_DESTINATION: u32 = 0u;
const RECORD_CODE_BLOCK_STRIDE: u32 = 1u;
const RECORD_CODE_BLOCK_SIZE: u32 = 2u;
const RECORD_CODE_BLOCK_DATA_OFFSET: u32 = 3u;
const RECORD_CODE_BLOCK_DATA_LENGTH: u32 = 4u;
const RECORD_CODE_BLOCK_PASSES: u32 = 5u;
const RECORD_CODE_BLOCK_STYLE: u32 = 6u;
const RECORD_CODE_BLOCK_SCALE: u32 = 7u;
const RECORD_CODE_BLOCK_TERMINATIONS: u32 = 8u;
const RECORD_CODE_BLOCK_WORDS: u32 = 9u;
const RECORD_CODE_BLOCK_HEIGHT_SHIFT: u32 = 16u;
const RECORD_CODE_BLOCK_TERMINATION_COUNT_SHIFT: u32 = 16u;
const RECORD_CODE_BLOCK_BIT_PLANE_SHIFT: u32 = 8u;
const RECORD_CODE_BLOCK_BIT_PLANE_BIAS: u32 = 32u;
const RECORD_CODE_BLOCK_BAND_SHIFT: u32 = 16u;
const RECORD_CODE_BLOCK_REGION_SHIFT: u32 = 24u;
const RECORD_CODE_BLOCK_MAGNITUDE_BITS_SHIFT: u32 = 8u;
const RECORD_CODE_BLOCK_WAVELET_SHIFT: u32 = 16u;
// A larger level's iteration: the horizontal and vertical work items of every tile-component that has it, and its jobs
const RECORD_ITERATION_HORIZONTAL_ITEMS: u32 = 0u;
const RECORD_ITERATION_VERTICAL_ITEMS: u32 = 1u;
const RECORD_ITERATION_JOB_COUNT: u32 = 2u;
const RECORD_ITERATION_JOBS: u32 = 3u;
const RECORD_ITERATION_WORDS: u32 = 4u;
const RECORD_JOB_TILE_COMPONENT: u32 = 0u;
const RECORD_JOB_LEVEL: u32 = 1u;
const RECORD_JOB_HORIZONTAL_START: u32 = 2u;
const RECORD_JOB_VERTICAL_START: u32 = 3u;
const RECORD_JOB_WORDS: u32 = 4u;
// Levels whose region fits this many samples on both axes run in one workgroup per tile-component
const RECORD_SMALL_LEVEL_SIZE: u32 = 64u;
// The most iterations of larger levels the repeat dispatches, at the largest stream the header accepts
const RECORD_MAXIMUM_BIG_ITERATIONS: u32 = 7u;
// Code block coding styles, as COD and COC carry them
const RECORD_STYLE_BYPASS: u32 = 1u;
const RECORD_STYLE_RESET: u32 = 2u;
const RECORD_STYLE_TERMINATE_ALL: u32 = 4u;
const RECORD_STYLE_VERTICAL_CAUSAL: u32 = 8u;
const RECORD_STYLE_PREDICTABLE_TERMINATION: u32 = 16u;
const RECORD_STYLE_SEGMENTATION_SYMBOLS: u32 = 32u;
const RECORD_MAXIMUM_CODE_BLOCK_SAMPLES: u32 = 4096u;
const RECORD_MAXIMUM_CODE_BLOCK_SIDE: u32 = 1024u;
const RECORD_MAXIMUM_PASSES: u32 = 100u;

// Error codes, the high byte of a status error word; the low 24 bits hold the failing value
const ERROR_CODE_SHIFT: u32 = 24u;
const ERROR_RECORD_INVALID: u32 = 1u;
const ERROR_CODESTREAM_MISSING: u32 = 2u;
const ERROR_MARKER_SEGMENT: u32 = 3u;
const ERROR_IMAGE_SIZE: u32 = 4u;
const ERROR_COMPONENT_COUNT: u32 = 5u;
const ERROR_COLOUR_SPACE: u32 = 6u;
const ERROR_BIT_DEPTH: u32 = 7u;
const ERROR_CHROMA_FORMAT: u32 = 8u;
const ERROR_CODING_STYLE: u32 = 9u;
const ERROR_QUANTIZATION: u32 = 10u;
const ERROR_PROGRESSION_ORDER: u32 = 11u;
const ERROR_TILE_PART: u32 = 12u;
const ERROR_PASS_COUNT: u32 = 13u;
const ERROR_UNSUPPORTED_FEATURE: u32 = 14u;
const ERROR_OUTPUT_FORMAT: u32 = 15u;
const ERROR_PICTURE_SIZE: u32 = 16u;
const ERROR_RESOURCE_LIMIT: u32 = 17u;
const ERROR_REGION_OF_INTEREST: u32 = 18u;
const ERROR_TILE_MISSING: u32 = 19u;
const ERROR_LENGTH_BITS: u32 = 20u;
const ERROR_MAGNITUDE_BITS: u32 = 21u;
const ERROR_PACKET_DATA: u32 = 22u;
const ERROR_CODE_BLOCK_LENGTH: u32 = 23u;
const ERROR_PICTURE_AREA: u32 = 24u;

// Failure values of recordInvalid
const INVALID_LENGTH: u32 = 1u;
const INVALID_MAGIC: u32 = 2u;
const INVALID_VERSION: u32 = 3u;
const INVALID_TABLE: u32 = 4u;
const INVALID_TILE: u32 = 5u;
const INVALID_TILE_COMPONENT: u32 = 6u;
const INVALID_CODE_BLOCK: u32 = 7u;
const INVALID_JOB: u32 = 8u;

// Words of the control buffer: the next indirect dispatch's workgroup counts, then the picture's progress
const CONTROL_DISPATCH_X: u32 = 0u;
const CONTROL_DISPATCH_Y: u32 = 1u;
const CONTROL_DISPATCH_Z: u32 = 2u;
const CONTROL_ABORT: u32 = 3u;
const CONTROL_ITERATION: u32 = 4u;
const CONTROL_NEXT_ITERATION: u32 = 5u;
// Words of the state buffer: the size of the first picture since a reset, which every later picture keeps
const STATE_SIZE_SEEN: u32 = 0u;
const STATE_WIDTH: u32 = 1u;
const STATE_HEIGHT: u32 = 2u;

const MAXIMUM_WORKGROUPS_PER_DIMENSION: u32 = 65535u;
const CLEAR_WORKGROUP_SIZE: u32 = 256u;
const TIER1_WORKGROUP_SIZE: u32 = 32u;
const TRANSFORM_WORKGROUP_SIZE: u32 = 256u;
const BYTES_PER_WORD: u32 = 4u;
const MAXIMUM_WAVELET_LEVELS: u32 = 32u;
// The largest larger-level threshold the header's repeat counts
const BIG_LEVEL_LAST_THRESHOLD: u32 = 4096u;

// Tier-1: a code block's state words, one per column of each stripe of four rows; each holds four bits per field, one per row
const TIER1_STATE_WORDS: u32 = 1024u;
const STRIPE_HEIGHT: u32 = 4u;
const SIGNIFICANT_SHIFT: u32 = 0u;
const NEGATIVE_SHIFT: u32 = 4u;
const VISITED_SHIFT: u32 = 8u;
const REFINED_SHIFT: u32 = 12u;
const ROW_FIELD_MASK: u32 = 15u;
// A stripe column with neither a significant nor a visited sample
const SIGNIFICANT_OR_VISITED_MASK: u32 = 3855u;
// Six rows of a column's significance around a stripe: the row above, its four rows, and the row below; vertically causal coding drops the row below
const NEIGHBOURHOOD_MASK: u32 = 63u;
const CAUSAL_NEIGHBOURHOOD_MASK: u32 = 31u;
const CAUSAL_ROW: u32 = 3u;
// FFmpeg's neighbour flags, which index its context tables: significance of N, E, W, S, NE, NW, SE, SW, then the signs of N, S, W, E
const FLAG_NEIGHBOURS: u32 = 255u;
const FLAG_SIGN_SHIFT: u32 = 8u;
const FLAG_SIGNIFICANCE_LOW: u32 = 15u;
const SIGNIFICANCE_CONTEXT_BITS: u32 = 4u;
const SIGNIFICANCE_CONTEXT_MASK: u32 = 15u;
const SIGN_CONTEXT_MASK: u32 = 15u;
const SIGN_XOR_SHIFT: u32 = 4u;
const REFINEMENT_FIRST_CONTEXT: u32 = 14u;
const REFINEMENT_NEIGHBOUR_CONTEXT: u32 = 15u;
const REFINEMENT_LATER_CONTEXT: u32 = 16u;
// MQ decoder contexts: 0 to 8 significance, 9 to 13 sign, 14 to 16 refinement, then the uniform and run-length contexts
const MQ_CONTEXT_COUNT: u32 = 19u;
const MQ_CONTEXT_UNIFORM: u32 = 17u;
const MQ_CONTEXT_RUN_LENGTH: u32 = 18u;
// Initial states, as state index * 2 + MPS
const MQ_UNIFORM_STATE: u32 = 92u;
const MQ_RUN_LENGTH_STATE: u32 = 6u;
const MQ_FIRST_SIGNIFICANCE_STATE: u32 = 8u;
const MQ_PROBABILITY_MASK: u32 = 65535u;
const MQ_NEXT_MPS_SHIFT: u32 = 16u;
const MQ_NEXT_LPS_SHIFT: u32 = 24u;
const MQ_STATE_INDEX_MASK: u32 = 127u;
const MQ_INTERVAL_HALF: u32 = 32768u;
const MQ_MARKER: u32 = 255u;
const MQ_MARKER_LIMIT: u32 = 143u;
const MQ_RAW_BIT: u32 = 1073741824u;
const SEGMENTATION_SYMBOL_COUNT: u32 = 4u;
const SIGN_BIT: u32 = 2147483648u;
const MAGNITUDE_MASK: u32 = 2147483647u;
// FFmpeg's decode_cblk stops at a bit-plane outside this range
const FIRST_BIT_PLANE_LIMIT: i32 = -1;
const LAST_BIT_PLANE_LIMIT: i32 = 29;
const PASS_TYPE_SIGNIFICANCE: u32 = 0u;
const PASS_TYPE_REFINEMENT: u32 = 1u;
const PASS_TYPE_CLEANUP: u32 = 2u;
const TERMINATION_ARITHMETIC: u32 = 1u;
const TERMINATION_RAW: u32 = 2u;
const BYPASS_ARITHMETIC_TRIPLES: i32 = 2;
const TERMINATIONS_PER_WORD: u32 = 2u;
const TERMINATION_MASK: u32 = 65535u;
const BYTE_MASK: u32 = 255u;
const SIGN_EXTEND_BYTE_SHIFT: u32 = 24u;

// Dequantization: the 5/3 path's unit step, which shifts only, and the integer 9/7 path's prescale and fixed point
const REVERSIBLE_UNIT_STEP: i32 = 32768;
const STEP_FRACTION_SHIFT: u32 = 16u;
const IRREVERSIBLE_PRESCALE_SHIFT: u32 = 6u;
const IRREVERSIBLE_PRESCALE_ROUNDING: i32 = 32;
const ROUNDING_HALF: u32 = 32768u;
// FFmpeg's integer 9/7 lifting constants, in 16-bit fixed point, and the shift its coefficients carry until the last level
const LIFTING_ALPHA_PRIME: u32 = 38413u;
const LIFTING_BETA: u32 = 3472u;
const LIFTING_GAMMA: u32 = 57862u;
const LIFTING_DELTA: u32 = 29066u;
const LIFTING_K: u32 = 80621u;
const LIFTING_X: u32 = 53274u;
const LIFTING_K_SHIFT: u32 = 17u;
const LIFTING_K_ROUNDING: u32 = 65536u;
const FINAL_SHIFT: u32 = 8u;
const FINAL_ROUNDING: i32 = 128;
const LIFTING_LOW_BITS: u32 = 16u;
const LIFTING_LOW_MASK: u32 = 65535u;
const LIFTING_CONSTANT_SPLIT: u32 = 8u;
const LIFTING_CONSTANT_LOW_MASK: u32 = 255u;
// FFmpeg's integer ICT factors beyond the unit terms
const ICT_RED_FROM_CR: u32 = 26345u;
const ICT_GREEN_FROM_CB: u32 = 22553u;
const ICT_GREEN_FROM_CR: u32 = 46802u;
const ICT_BLUE_FROM_CB: u32 = 4294952354u;
// FFmpeg's conversion of XYZ to RGB (libswscale's xyz12Torgb48_c and ff_sws_fill_xyztables): each 12-bit X', Y', or Z' code through the
// DCI gamma of 2.6 to 16-bit linear light, rounded, the 4.12 fixed-point XYZ to BT.709 RGB matrix, clipped to 16 bits, and the gamma of 1/2.2
// back to a 12-bit R', G', or B' code, rounded
const XYZ_CODE_MAXIMUM: f32 = 4095.0;
const XYZ_LINEAR_MAXIMUM: f32 = 65535.0;
const XYZ_LINEAR_MAXIMUM_CODE: i32 = 65535;
const XYZ_DECODING_GAMMA: f32 = 2.6;
const RGB_ENCODING_GAMMA: f32 = 1.0 / 2.2;
const XYZ_MATRIX_SHIFT: u32 = 12u;
const XYZ_TO_RED: vec3i = vec3i(13270, -6295, -2041);
const XYZ_TO_GREEN: vec3i = vec3i(-3969, 7682, 170);
const XYZ_TO_BLUE: vec3i = vec3i(228, -835, 4329);
// The format an XYZ picture's planes take: 4:4:4 at 12 bits, as limited-range BT.709 Y'CbCr, luma from 256 over 3504 codes and chroma about
// 2048 over 3584, as the engine expands a 12-bit limited-range signal
const XYZ_CHROMA_FORMAT: u32 = 3u;
const XYZ_BIT_DEPTH: u32 = 12u;
const BT709_RED_WEIGHT: f32 = 0.2126;
const BT709_BLUE_WEIGHT: f32 = 0.0722;
const LIMITED_LUMA_BLACK: f32 = 256.0;
const LIMITED_LUMA_RANGE: f32 = 3504.0;
const LIMITED_CHROMA_CENTER: f32 = 2048.0;
const LIMITED_CHROMA_RANGE: f32 = 3584.0;

// FFmpeg's context tables: significance contexts by neighbour flags, four bits per band; sign contexts with the XOR bit at bit 4,
// by the significance of N, E, W, S and their signs; and the MQ states by index * 2 + MPS: Qe, then the next MPS and LPS states
const SIGNIFICANCE_CONTEXTS = array<u32, 256>(
    0u, 4947u, 5429u, 10103u, 5429u, 10103u, 10312u, 10360u, 4947u, 9348u, 10103u, 10119u, 10103u, 10119u, 10360u, 10376u,
    12561u, 17251u, 17974u, 22391u, 17974u, 22391u, 22600u, 22648u, 17251u, 21636u, 22391u, 22407u, 22391u, 22407u, 22648u, 22664u,
    12561u, 17251u, 17974u, 22391u, 17974u, 22391u, 22600u, 22648u, 17251u, 21636u, 22391u, 22407u, 22391u, 22407u, 22648u, 22664u,
    25122u, 29539u, 30262u, 30583u, 30262u, 30583u, 30792u, 30840u, 29539u, 29828u, 30583u, 30599u, 30583u, 30599u, 30840u, 30856u,
    12561u, 17251u, 17974u, 22391u, 17974u, 22391u, 22600u, 22648u, 17251u, 21636u, 22391u, 22407u, 22391u, 22407u, 22648u, 22664u,
    25122u, 29539u, 30262u, 30583u, 30262u, 30583u, 30792u, 30840u, 29539u, 29828u, 30583u, 30599u, 30583u, 30599u, 30840u, 30856u,
    25122u, 29539u, 30262u, 30583u, 30262u, 30583u, 30792u, 30840u, 29539u, 29828u, 30583u, 30599u, 30583u, 30599u, 30840u, 30856u,
    33314u, 33635u, 34358u, 34679u, 34358u, 34679u, 34888u, 34936u, 33635u, 33924u, 34679u, 34695u, 34679u, 34695u, 34936u, 34952u,
    12561u, 17251u, 17974u, 22391u, 17974u, 22391u, 22600u, 22648u, 17251u, 21636u, 22391u, 22407u, 22391u, 22407u, 22648u, 22664u,
    25122u, 29539u, 30262u, 30583u, 30262u, 30583u, 30792u, 30840u, 29539u, 29828u, 30583u, 30599u, 30583u, 30599u, 30840u, 30856u,
    25122u, 29539u, 30262u, 30583u, 30262u, 30583u, 30792u, 30840u, 29539u, 29828u, 30583u, 30599u, 30583u, 30599u, 30840u, 30856u,
    33314u, 33635u, 34358u, 34679u, 34358u, 34679u, 34888u, 34936u, 33635u, 33924u, 34679u, 34695u, 34679u, 34695u, 34936u, 34952u,
    25122u, 29539u, 30262u, 30583u, 30262u, 30583u, 30792u, 30840u, 29539u, 29828u, 30583u, 30599u, 30583u, 30599u, 30840u, 30856u,
    33314u, 33635u, 34358u, 34679u, 34358u, 34679u, 34888u, 34936u, 33635u, 33924u, 34679u, 34695u, 34679u, 34695u, 34936u, 34952u,
    33314u, 33635u, 34358u, 34679u, 34358u, 34679u, 34888u, 34936u, 33635u, 33924u, 34679u, 34695u, 34679u, 34695u, 34936u, 34952u,
    33314u, 33635u, 34358u, 34679u, 34358u, 34679u, 34888u, 34936u, 33635u, 33924u, 34679u, 34695u, 34679u, 34695u, 34936u, 34952u
);
const SIGN_CONTEXTS = array<u32, 256>(
    9u, 10u, 12u, 13u, 12u, 13u, 12u, 13u, 10u, 10u, 13u, 13u, 13u, 13u, 13u, 13u,
    9u, 26u, 12u, 11u, 12u, 11u, 12u, 11u, 10u, 9u, 13u, 12u, 13u, 12u, 13u, 12u,
    9u, 10u, 12u, 13u, 12u, 13u, 12u, 13u, 26u, 9u, 11u, 12u, 11u, 12u, 11u, 12u,
    9u, 26u, 12u, 11u, 12u, 11u, 12u, 11u, 26u, 26u, 11u, 11u, 11u, 11u, 11u, 11u,
    9u, 10u, 12u, 13u, 28u, 27u, 9u, 10u, 10u, 10u, 13u, 13u, 27u, 27u, 10u, 10u,
    9u, 26u, 12u, 11u, 28u, 29u, 9u, 26u, 10u, 9u, 13u, 12u, 27u, 28u, 10u, 9u,
    9u, 10u, 12u, 13u, 28u, 27u, 9u, 10u, 26u, 9u, 11u, 12u, 29u, 28u, 26u, 9u,
    9u, 26u, 12u, 11u, 28u, 29u, 9u, 26u, 26u, 26u, 11u, 11u, 29u, 29u, 26u, 26u,
    9u, 10u, 28u, 27u, 12u, 13u, 9u, 10u, 10u, 10u, 27u, 27u, 13u, 13u, 10u, 10u,
    9u, 26u, 28u, 29u, 12u, 11u, 9u, 26u, 10u, 9u, 27u, 28u, 13u, 12u, 10u, 9u,
    9u, 10u, 28u, 27u, 12u, 13u, 9u, 10u, 26u, 9u, 29u, 28u, 11u, 12u, 26u, 9u,
    9u, 26u, 28u, 29u, 12u, 11u, 9u, 26u, 26u, 26u, 29u, 29u, 11u, 11u, 26u, 26u,
    9u, 10u, 28u, 27u, 28u, 27u, 28u, 27u, 10u, 10u, 27u, 27u, 27u, 27u, 27u, 27u,
    9u, 26u, 28u, 29u, 28u, 29u, 28u, 29u, 10u, 9u, 27u, 28u, 27u, 28u, 27u, 28u,
    9u, 10u, 28u, 27u, 28u, 27u, 28u, 27u, 26u, 9u, 29u, 28u, 29u, 28u, 29u, 28u,
    9u, 26u, 28u, 29u, 28u, 29u, 28u, 29u, 26u, 26u, 29u, 29u, 29u, 29u, 29u, 29u
);
const MQ_STATES = array<u32, 94>(
    50484737u, 33773057u, 201602049u, 218444801u, 302389249u, 319232001u, 403180225u, 420022977u,
    973735201u, 990577953u, 1112277537u, 1129120289u, 219043329u, 202331649u, 470832129u, 487674881u,
    470960129u, 487802881u, 471087105u, 487929857u, 571879425u, 588722177u, 605561857u, 622404609u,
    672799745u, 689642497u, 708449793u, 725292545u, 488527361u, 471815681u, 471880705u, 488723457u,
    505565441u, 522408193u, 539248641u, 556091393u, 572930049u, 589772801u, 606614529u, 623457281u,
    640299009u, 657141761u, 640428033u, 657270785u, 674112513u, 690955265u, 707797505u, 724640257u,
    741481473u, 758324225u, 775165953u, 792008705u, 808850945u, 825693697u, 842535937u, 859378689u,
    876220929u, 893063681u, 909906177u, 926748929u, 943590081u, 960432833u, 977275329u, 994118081u,
    1010960545u, 1027803297u, 1044645153u, 1061487905u, 1078330433u, 1095173185u, 1112015521u, 1128858273u,
    1145700897u, 1162543649u, 1179386177u, 1196228929u, 1213071633u, 1229914385u, 1246756997u, 1263599749u,
    1280442441u, 1297285193u, 1314127909u, 1330970661u, 1347813397u, 1364656149u, 1381498889u, 1398341641u,
    1415184389u, 1432027141u, 1448738817u, 1465581569u, 1549555201u, 1566397953u
);

var<workgroup> tier1State: array<u32, TIER1_STATE_WORDS>;
var<workgroup> tier1Contexts: array<u32, MQ_CONTEXT_COUNT>;

// The code block lane 0 of a tier-1 workgroup decodes, and its MQ decoder's registers
var<private> codeBlockDataOffset: u32;
var<private> codeBlockDataLength: u32;
var<private> codeBlockDestination: u32;
var<private> codeBlockStride: u32;
var<private> codeBlockWidth: u32;
var<private> codeBlockHeight: u32;
var<private> codeBlockStripes: u32;
var<private> mqInterval: u32;
var<private> mqCode: u32;
var<private> mqPosition: u32;
var<private> mqRaw: bool;

fn errorWord(code: u32, value: u32) -> u32 {
    return (code << ERROR_CODE_SHIFT) | min(value, (1u << ERROR_CODE_SHIFT) - 1u);
}

fn recordError(value: u32) -> u32 {
    return errorWord(ERROR_RECORD_INVALID, value);
}

fn readRecord(index: u32) -> u32 {
    return readPacketWord(index);
}

fn getRecordWordCount() -> u32 {
    return packet.byteLength / BYTES_PER_WORD;
}

// Whether `count` entries of `entryWords` words from word `offset` lie within the record
fn fitsRecord(offset: u32, count: u32, entryWords: u32) -> bool {
    let words = getRecordWordCount();
    return offset <= words && count <= (words - offset) / entryWords;
}

// The workgroup counts of an indirect dispatch of `workgroups` workgroups, folded into two dimensions past the per-dimension limit
fn writeDispatch(workgroups: u32) {
    let columns = min(workgroups, MAXIMUM_WORKGROUPS_PER_DIMENSION);
    var rows = 0u;
    if (columns > 0u) {
        rows = (workgroups + columns - 1u) / columns;
    }
    control[CONTROL_DISPATCH_X] = columns;
    control[CONTROL_DISPATCH_Y] = rows;
    control[CONTROL_DISPATCH_Z] = 1u;
}

fn getWorkgroupIndex(group: vec3u, groups: vec3u) -> u32 {
    return group.y * groups.x + group.x;
}

fn getPlaneField(plane: u32, field: u32) -> u32 {
    return readRecord(RECORD_HEADER_PLANES + plane * RECORD_PLANE_WORDS + field);
}

// The larger-level iterations the header's repeat dispatches for this stream, by the same thresholds
fn getBigIterationLimit() -> u32 {
    let side = max(stream.width, stream.height);
    var limit = 0u;
    for (var threshold = RECORD_SMALL_LEVEL_SIZE; threshold <= BIG_LEVEL_LAST_THRESHOLD; threshold *= 2u) {
        if (side > threshold) {
            limit += 1u;
        }
    }
    return limit;
}

struct TileComponent {
    coefficients: u32,
    width: u32,
    height: u32,
    x0: u32,
    y0: u32,
    levelCount: u32,
    firstBigLevel: u32,
    levels: u32,
    wavelet: u32,
    finalShift: u32,
}

fn readTileComponent(index: u32) -> TileComponent {
    let entry = readRecord(RECORD_HEADER_TILE_COMPONENT_TABLE) + index * RECORD_TILE_COMPONENT_WORDS;
    return TileComponent(
        readRecord(entry + RECORD_TILE_COMPONENT_COEFFICIENTS),
        readRecord(entry + RECORD_TILE_COMPONENT_WIDTH),
        readRecord(entry + RECORD_TILE_COMPONENT_HEIGHT),
        readRecord(entry + RECORD_TILE_COMPONENT_X0),
        readRecord(entry + RECORD_TILE_COMPONENT_Y0),
        readRecord(entry + RECORD_TILE_COMPONENT_LEVEL_COUNT),
        readRecord(entry + RECORD_TILE_COMPONENT_FIRST_BIG_LEVEL),
        readRecord(entry + RECORD_TILE_COMPONENT_LEVELS),
        readRecord(entry + RECORD_TILE_COMPONENT_WAVELET),
        readRecord(entry + RECORD_TILE_COMPONENT_FINAL_SHIFT),
    );
}

// A wavelet level's region: its sizes and the parities of its origin
struct WaveletLevel {
    width: u32,
    widthParity: u32,
    height: u32,
    heightParity: u32,
}

fn readWaveletLevel(component: TileComponent, level: u32) -> WaveletLevel {
    let entry = component.levels + level * RECORD_LEVEL_WORDS;
    let width = readRecord(entry + RECORD_LEVEL_WIDTH);
    let height = readRecord(entry + RECORD_LEVEL_HEIGHT);
    return WaveletLevel(width & RECORD_LEVEL_SIZE_MASK, width >> RECORD_LEVEL_PARITY_SHIFT, height & RECORD_LEVEL_SIZE_MASK, height >> RECORD_LEVEL_PARITY_SHIFT);
}

// Checks a tile-component: its coefficients within the picture's, and each level within its region and coarser than the next
fn checkTileComponent(index: u32, coefficientWords: u32) -> bool {
    let component = readTileComponent(index);
    if (component.width == 0u || component.height == 0u || component.coefficients > coefficientWords) {
        return false;
    }
    if (component.height > (coefficientWords - component.coefficients) / component.width) {
        return false;
    }
    if (component.levelCount > MAXIMUM_WAVELET_LEVELS || component.firstBigLevel > component.levelCount || component.wavelet > RECORD_WAVELET_REVERSIBLE) {
        return false;
    }
    if (!fitsRecord(component.levels, component.levelCount, RECORD_LEVEL_WORDS)) {
        return false;
    }
    for (var level = 0u; level < component.levelCount; level += 1u) {
        let shape = readWaveletLevel(component, level);
        if (shape.width > component.width || shape.height > component.height || shape.widthParity > 1u || shape.heightParity > 1u) {
            return false;
        }
        let isSmall = shape.width <= RECORD_SMALL_LEVEL_SIZE && shape.height <= RECORD_SMALL_LEVEL_SIZE;
        if (isSmall != (level < component.firstBigLevel)) {
            return false;
        }
    }
    return true;
}

// Checks the record's header, tables, and tile-components against the session's stream and buffers; returns an error word or 0
fn checkRecord() -> u32 {
    let byteLength = packet.byteLength;
    if (byteLength < RECORD_HEADER_WORDS * BYTES_PER_WORD || (byteLength % BYTES_PER_WORD) != 0u) {
        return recordError(INVALID_LENGTH);
    }
    if (readRecord(RECORD_HEADER_MAGIC) != RECORD_MAGIC) {
        return recordError(INVALID_MAGIC);
    }
    if (readRecord(RECORD_HEADER_VERSION) != RECORD_VERSION) {
        return recordError(INVALID_VERSION);
    }
    if (readRecord(RECORD_HEADER_BYTE_LENGTH) != byteLength) {
        return recordError(INVALID_LENGTH);
    }
    let formatError = readRecord(RECORD_HEADER_FORMAT_ERROR);
    if (formatError != 0u) {
        return formatError;
    }
    let chromaFormat = readRecord(RECORD_HEADER_CHROMA_FORMAT);
    let bitDepth = readRecord(RECORD_HEADER_OUTPUT_BIT_DEPTH);
    if (chromaFormat != OUTPUT_CHROMA_FORMAT || bitDepth != OUTPUT_BIT_DEPTH) {
        return errorWord(ERROR_OUTPUT_FORMAT, (chromaFormat << 8u) | bitDepth);
    }
    // An XYZ picture converts the three planes at each position together, so it needs every plane, at 4:4:4 and 12 bits
    let outputTransform = readRecord(RECORD_HEADER_OUTPUT_TRANSFORM);
    let xyz = outputTransform == RECORD_OUTPUT_TRANSFORM_XYZ;
    if (outputTransform > RECORD_OUTPUT_TRANSFORM_XYZ || (xyz && (chromaFormat != XYZ_CHROMA_FORMAT || bitDepth != XYZ_BIT_DEPTH))) {
        return recordError(INVALID_TABLE);
    }
    let width = readRecord(RECORD_HEADER_WIDTH);
    let height = readRecord(RECORD_HEADER_HEIGHT);
    if (width == 0u || height == 0u || width > stream.width || height > stream.height) {
        return errorWord(ERROR_PICTURE_SIZE, max(width, height));
    }
    for (var plane = 0u; plane < RECORD_PLANE_COUNT; plane += 1u) {
        let component = getPlaneField(plane, RECORD_PLANE_COMPONENT);
        if (component != RECORD_MISSING && component >= RECORD_COMPONENT_SLOTS) {
            return recordError(INVALID_TABLE);
        }
        let divisorX = getPlaneField(plane, RECORD_PLANE_DIVISOR_X);
        let divisorY = getPlaneField(plane, RECORD_PLANE_DIVISOR_Y);
        if ((component != RECORD_MISSING && (divisorX == 0u || divisorY == 0u)) || (xyz && component == RECORD_MISSING)) {
            return recordError(INVALID_TABLE);
        }
        if (getPlaneField(plane, RECORD_PLANE_WIDTH) > stream.planes[plane].width || getPlaneField(plane, RECORD_PLANE_HEIGHT) > stream.planes[plane].height) {
            return errorWord(ERROR_PICTURE_SIZE, getPlaneField(plane, RECORD_PLANE_WIDTH));
        }
    }
    let tileColumns = readRecord(RECORD_HEADER_TILE_COLUMNS);
    let tileRows = readRecord(RECORD_HEADER_TILE_ROWS);
    let words = getRecordWordCount();
    if (tileColumns == 0u || tileRows == 0u || tileRows > words / tileColumns || readRecord(RECORD_HEADER_TILE_WIDTH) == 0u || readRecord(RECORD_HEADER_TILE_HEIGHT) == 0u) {
        return recordError(INVALID_TABLE);
    }
    let tileCount = tileColumns * tileRows;
    let componentCount = readRecord(RECORD_HEADER_TILE_COMPONENT_COUNT);
    let iterationCount = readRecord(RECORD_HEADER_BIG_ITERATION_COUNT);
    if (!fitsRecord(readRecord(RECORD_HEADER_TILE_TABLE), tileCount, RECORD_TILE_WORDS)
        || !fitsRecord(readRecord(RECORD_HEADER_TILE_COMPONENT_TABLE), componentCount, RECORD_TILE_COMPONENT_WORDS)
        || !fitsRecord(readRecord(RECORD_HEADER_CODE_BLOCK_TABLE), readRecord(RECORD_HEADER_CODE_BLOCK_COUNT), RECORD_CODE_BLOCK_WORDS)
        || !fitsRecord(readRecord(RECORD_HEADER_SMALL_JOB_TABLE), readRecord(RECORD_HEADER_SMALL_JOB_COUNT), 1u)
        || !fitsRecord(readRecord(RECORD_HEADER_BIG_ITERATION_TABLE), iterationCount, RECORD_ITERATION_WORDS)) {
        return recordError(INVALID_TABLE);
    }
    let coefficientWords = readRecord(RECORD_HEADER_COEFFICIENT_WORDS);
    if (coefficientWords > arrayLength(&coefficients) || coefficientWords > arrayLength(&transformScratch)) {
        return errorWord(ERROR_RESOURCE_LIMIT, coefficientWords >> 20u);
    }
    if (iterationCount > getBigIterationLimit()) {
        return errorWord(ERROR_RESOURCE_LIMIT, iterationCount);
    }
    let tileTable = readRecord(RECORD_HEADER_TILE_TABLE);
    for (var tile = 0u; tile < tileCount; tile += 1u) {
        let entry = tileTable + tile * RECORD_TILE_WORDS;
        if (readRecord(entry + RECORD_TILE_TRANSFORM) > RECORD_COMPONENT_TRANSFORM_IRREVERSIBLE) {
            return recordError(INVALID_TILE);
        }
        for (var slot = 0u; slot < RECORD_COMPONENT_SLOTS; slot += 1u) {
            let component = readRecord(entry + RECORD_TILE_COMPONENTS + slot);
            if (component != RECORD_MISSING && component >= componentCount) {
                return recordError(INVALID_TILE);
            }
        }
        for (var plane = 0u; plane < RECORD_PLANE_COUNT; plane += 1u) {
            let slot = getPlaneField(plane, RECORD_PLANE_COMPONENT);
            if (slot != RECORD_MISSING && readRecord(entry + RECORD_TILE_COMPONENTS + slot) == RECORD_MISSING) {
                return recordError(INVALID_TILE);
            }
        }
    }
    for (var component = 0u; component < componentCount; component += 1u) {
        if (!checkTileComponent(component, coefficientWords)) {
            return recordError(INVALID_TILE_COMPONENT);
        }
    }
    return 0u;
}

// Checks the record, reports the picture's size, and sizes the coefficient clear; a failed check makes every later pass empty
@compute @workgroup_size(1)
fn beginPicture() {
    control[CONTROL_ABORT] = 1u;
    control[CONTROL_ITERATION] = 0u;
    control[CONTROL_NEXT_ITERATION] = 0u;
    writeDispatch(0u);
    let error = checkRecord();
    if (error != 0u) {
        reportDecodeError(error);
        return;
    }
    let width = readRecord(RECORD_HEADER_WIDTH);
    let height = readRecord(RECORD_HEADER_HEIGHT);
    if (state[STATE_SIZE_SEEN] != 0u && (state[STATE_WIDTH] != width || state[STATE_HEIGHT] != height)) {
        reportDecodeError(errorWord(ERROR_PICTURE_SIZE, max(width, height)));
        return;
    }
    state[STATE_SIZE_SEEN] = 1u;
    state[STATE_WIDTH] = width;
    state[STATE_HEIGHT] = height;
    reportHeaderFacts(stream.width, stream.height, OUTPUT_BIT_DEPTH, vec4u(0u, 0u, width, height));
    control[CONTROL_ABORT] = 0u;
    let coefficientWords = readRecord(RECORD_HEADER_COEFFICIENT_WORDS);
    writeDispatch((coefficientWords + CLEAR_WORKGROUP_SIZE - 1u) / CLEAR_WORKGROUP_SIZE);
}

// Zeroes the picture's coefficients, the value of every code block without coded bytes
@compute @workgroup_size(256)
fn clearCoefficients(@builtin(workgroup_id) group: vec3u, @builtin(num_workgroups) groups: vec3u, @builtin(local_invocation_index) lane: u32) {
    let index = getWorkgroupIndex(group, groups) * CLEAR_WORKGROUP_SIZE + lane;
    if (index < readRecord(RECORD_HEADER_COEFFICIENT_WORDS)) {
        coefficients[index] = 0u;
    }
}

@compute @workgroup_size(1)
fn planCodeBlocks() {
    if (control[CONTROL_ABORT] != 0u) {
        writeDispatch(0u);
        return;
    }
    writeDispatch(readRecord(RECORD_HEADER_CODE_BLOCK_COUNT));
}

struct CodeBlock {
    destination: u32,
    stride: u32,
    width: u32,
    height: u32,
    dataOffset: u32,
    dataLength: u32,
    terminationCount: u32,
    terminations: u32,
    passes: u32,
    bitPlane: i32,
    band: u32,
    regionShift: u32,
    style: u32,
    magnitudeBits: i32,
    wavelet: u32,
    scale: i32,
}

fn readCodeBlock(index: u32) -> CodeBlock {
    let entry = readRecord(RECORD_HEADER_CODE_BLOCK_TABLE) + index * RECORD_CODE_BLOCK_WORDS;
    let size = readRecord(entry + RECORD_CODE_BLOCK_SIZE);
    let length = readRecord(entry + RECORD_CODE_BLOCK_DATA_LENGTH);
    let passes = readRecord(entry + RECORD_CODE_BLOCK_PASSES);
    let style = readRecord(entry + RECORD_CODE_BLOCK_STYLE);
    // The magnitude bits are a signed byte, -1 for a band of no guard bits and exponent 0
    let magnitudeBits = bitcast<i32>(((style >> RECORD_CODE_BLOCK_MAGNITUDE_BITS_SHIFT) & BYTE_MASK) << SIGN_EXTEND_BYTE_SHIFT) >> SIGN_EXTEND_BYTE_SHIFT;
    return CodeBlock(
        readRecord(entry + RECORD_CODE_BLOCK_DESTINATION),
        readRecord(entry + RECORD_CODE_BLOCK_STRIDE),
        size & RECORD_LEVEL_SIZE_MASK,
        size >> RECORD_CODE_BLOCK_HEIGHT_SHIFT,
        readRecord(entry + RECORD_CODE_BLOCK_DATA_OFFSET),
        length & TERMINATION_MASK,
        length >> RECORD_CODE_BLOCK_TERMINATION_COUNT_SHIFT,
        readRecord(entry + RECORD_CODE_BLOCK_TERMINATIONS),
        passes & BYTE_MASK,
        i32((passes >> RECORD_CODE_BLOCK_BIT_PLANE_SHIFT) & BYTE_MASK) - i32(RECORD_CODE_BLOCK_BIT_PLANE_BIAS),
        (passes >> RECORD_CODE_BLOCK_BAND_SHIFT) & BYTE_MASK,
        passes >> RECORD_CODE_BLOCK_REGION_SHIFT,
        style & BYTE_MASK,
        magnitudeBits,
        (style >> RECORD_CODE_BLOCK_WAVELET_SHIFT) & 1u,
        bitcast<i32>(readRecord(entry + RECORD_CODE_BLOCK_SCALE)),
    );
}

// Checks a code block's size, its place in the coefficients, its bytes, and its terminations against the record and the buffers
fn checkCodeBlock(block: CodeBlock) -> bool {
    if (block.width == 0u || block.height == 0u || block.width > RECORD_MAXIMUM_CODE_BLOCK_SIDE || block.height > RECORD_MAXIMUM_CODE_BLOCK_SIDE) {
        return false;
    }
    if (block.width * block.height > RECORD_MAXIMUM_CODE_BLOCK_SAMPLES || ((block.height + STRIPE_HEIGHT - 1u) / STRIPE_HEIGHT) * block.width > TIER1_STATE_WORDS) {
        return false;
    }
    let coefficientWords = readRecord(RECORD_HEADER_COEFFICIENT_WORDS);
    if (block.stride < block.width || block.destination > coefficientWords) {
        return false;
    }
    if ((block.height - 1u) > (coefficientWords - block.destination - block.width) / block.stride || block.width > coefficientWords - block.destination) {
        return false;
    }
    if (block.dataOffset > packet.byteLength || block.dataLength > packet.byteLength - block.dataOffset) {
        return false;
    }
    if (block.passes >= RECORD_MAXIMUM_PASSES || block.terminationCount >= RECORD_MAXIMUM_PASSES || block.band > 3u) {
        return false;
    }
    return fitsRecord(block.terminations, (block.terminationCount + TERMINATIONS_PER_WORD - 1u) / TERMINATIONS_PER_WORD, 1u);
}

// One of the code block's bytes; FFmpeg's buffer ends in 0xFF 0xFF, which past the end the MQ decoder reads as markers
fn readCodeBlockByte(index: u32) -> u32 {
    if (index < codeBlockDataLength) {
        return readPacketByte(codeBlockDataOffset + index);
    }
    return MQ_MARKER;
}

fn readTermination(table: u32, index: u32) -> u32 {
    return (readRecord(table + index / TERMINATIONS_PER_WORD) >> ((index % TERMINATIONS_PER_WORD) * 16u)) & TERMINATION_MASK;
}

fn initializeContexts() {
    for (var context = 0u; context < MQ_CONTEXT_COUNT; context += 1u) {
        tier1Contexts[context] = 0u;
    }
    tier1Contexts[MQ_CONTEXT_UNIFORM] = MQ_UNIFORM_STATE;
    tier1Contexts[MQ_CONTEXT_RUN_LENGTH] = MQ_RUN_LENGTH_STATE;
    tier1Contexts[0] = MQ_FIRST_SIGNIFICANCE_STATE;
}

// FFmpeg's bytein: the next byte into the code register, holding at a marker and taking 7 bits after 0xFF
fn mqByteIn() {
    if (readCodeBlockByte(mqPosition) == MQ_MARKER) {
        if (readCodeBlockByte(mqPosition + 1u) > MQ_MARKER_LIMIT) {
            mqCode += 1u;
        } else {
            mqPosition += 1u;
            mqCode += 2u + 0xFE00u - (readCodeBlockByte(mqPosition) << 9u);
        }
    } else {
        mqPosition += 1u;
        mqCode += 1u + 0xFF00u - (readCodeBlockByte(mqPosition) << 8u);
    }
}

fn mqInitialize(start: u32, raw: bool, reset: bool) {
    mqRaw = raw;
    if (reset) {
        initializeContexts();
    }
    mqPosition = start;
    mqCode = (readCodeBlockByte(mqPosition) ^ MQ_MARKER) << 16u;
    mqByteIn();
    mqCode = mqCode << 7u;
    mqInterval = MQ_INTERVAL_HALF;
}

fn mqRenormalize() {
    loop {
        if ((mqCode & BYTE_MASK) == 0u) {
            mqCode -= 0x100u;
            mqByteIn();
        }
        mqInterval += mqInterval;
        mqCode += mqCode;
        if ((mqInterval & MQ_INTERVAL_HALF) != 0u) {
            break;
        }
    }
}

// FFmpeg's exchange: the decision of an interval exchange, its next state, and renormalization
fn mqExchange(context: u32, stateIndex: u32, table: u32, lessProbable: bool) -> u32 {
    let probability = table & MQ_PROBABILITY_MASK;
    var decision: u32;
    let toMoreProbable = select(mqInterval >= probability, mqInterval < probability, lessProbable);
    if (lessProbable) {
        mqInterval = probability;
    }
    if (toMoreProbable) {
        decision = stateIndex & 1u;
        tier1Contexts[context] = (table >> MQ_NEXT_MPS_SHIFT) & MQ_STATE_INDEX_MASK;
    } else {
        decision = 1u - (stateIndex & 1u);
        tier1Contexts[context] = (table >> MQ_NEXT_LPS_SHIFT) & MQ_STATE_INDEX_MASK;
    }
    mqRenormalize();
    return decision;
}

// Decodes one decision: arithmetic in a context, or a raw bit in a bypassed segment
fn mqDecode(context: u32) -> u32 {
    if (mqRaw) {
        let bit = select(0u, 1u, (mqCode & MQ_RAW_BIT) == 0u);
        if ((mqCode & BYTE_MASK) == 0u) {
            mqCode -= 0x100u;
            mqByteIn();
        }
        mqCode += mqCode;
        return bit;
    }
    let stateIndex = tier1Contexts[context];
    let table = MQ_STATES[stateIndex];
    mqInterval -= table & MQ_PROBABILITY_MASK;
    if ((mqCode >> 16u) < mqInterval) {
        if ((mqInterval & MQ_INTERVAL_HALF) != 0u) {
            return stateIndex & 1u;
        }
        return mqExchange(context, stateIndex, table, false);
    }
    mqCode -= mqInterval << 16u;
    return mqExchange(context, stateIndex, table, true);
}

// The state word of a stripe column, 0 outside the code block
fn readStateWord(stripe: i32, column: i32) -> u32 {
    if (stripe < 0 || column < 0 || u32(stripe) >= codeBlockStripes || u32(column) >= codeBlockWidth) {
        return 0u;
    }
    return tier1State[u32(stripe) * codeBlockWidth + u32(column)];
}

// One field of a column's six rows: the row above the stripe, its four rows, and the row below
fn getColumnField(above: u32, current: u32, below: u32, shift: u32) -> u32 {
    return ((above >> (shift + 3u)) & 1u) | (((current >> shift) & ROW_FIELD_MASK) << 1u) | (((below >> shift) & 1u) << 5u);
}

// FFmpeg's flags of a sample's eight neighbours' significance and four neighbours' signs, from the significance and sign fields of the
// columns left of it, its own, and right of it; vertically causal coding drops the row below the stripe
fn getNeighbourFlags(significantLeft: u32, significantCurrent: u32, significantRight: u32, negativeLeft: u32, negativeCurrent: u32, negativeRight: u32, row: u32, causalRow: bool) -> u32 {
    let north = (significantCurrent >> row) & 1u;
    let west = (significantLeft >> (row + 1u)) & 1u;
    let east = (significantRight >> (row + 1u)) & 1u;
    let northWest = (significantLeft >> row) & 1u;
    let northEast = (significantRight >> row) & 1u;
    var south = (significantCurrent >> (row + 2u)) & 1u;
    var southWest = (significantLeft >> (row + 2u)) & 1u;
    var southEast = (significantRight >> (row + 2u)) & 1u;
    if (causalRow) {
        south = 0u;
        southWest = 0u;
        southEast = 0u;
    }
    let signs = ((negativeCurrent >> row) & north) | (((negativeCurrent >> (row + 2u)) & south) << 1u)
        | (((negativeLeft >> (row + 1u)) & west) << 2u) | (((negativeRight >> (row + 1u)) & east) << 3u);
    return north | (east << 1u) | (west << 2u) | (south << 3u) | (northEast << 4u) | (northWest << 5u) | (southEast << 6u) | (southWest << 7u)
        | (signs << FLAG_SIGN_SHIFT);
}

fn getSignificanceContext(flags: u32, band: u32) -> u32 {
    return (SIGNIFICANCE_CONTEXTS[flags & FLAG_NEIGHBOURS] >> (band * SIGNIFICANCE_CONTEXT_BITS)) & SIGNIFICANCE_CONTEXT_MASK;
}

// The sign context and the bit FFmpeg XORs the decision with
fn getSignContext(flags: u32) -> u32 {
    return SIGN_CONTEXTS[(flags & FLAG_SIGNIFICANCE_LOW) | (((flags >> FLAG_SIGN_SHIFT) & FLAG_SIGNIFICANCE_LOW) << 4u)];
}

fn getCoefficientIndex(column: u32, row: u32) -> u32 {
    return codeBlockDestination + row * codeBlockStride + column;
}

// FFmpeg's decode_sigpass at bit-plane `plane`
fn decodeSignificancePass(plane: u32, band: u32, causal: bool) {
    let mask = (3u << plane) >> 1u;
    for (var stripe = 0u; stripe < codeBlockStripes; stripe += 1u) {
        let rows = min(STRIPE_HEIGHT, codeBlockHeight - stripe * STRIPE_HEIGHT);
        let stripeIndex = i32(stripe);
        var aboveLeft = 0u;
        var left = 0u;
        var belowLeft = 0u;
        var above = readStateWord(stripeIndex - 1, 0);
        var current = readStateWord(stripeIndex, 0);
        var below = readStateWord(stripeIndex + 1, 0);
        for (var column = 0u; column < codeBlockWidth; column += 1u) {
            let aboveRight = readStateWord(stripeIndex - 1, i32(column) + 1);
            let right = readStateWord(stripeIndex, i32(column) + 1);
            let belowRight = readStateWord(stripeIndex + 1, i32(column) + 1);
            let significantLeft = getColumnField(aboveLeft, left, belowLeft, SIGNIFICANT_SHIFT);
            let significantRight = getColumnField(aboveRight, right, belowRight, SIGNIFICANT_SHIFT);
            if (((significantLeft | significantRight | getColumnField(above, current, below, SIGNIFICANT_SHIFT)) & NEIGHBOURHOOD_MASK) != 0u) {
                let negativeLeft = getColumnField(aboveLeft, left, belowLeft, NEGATIVE_SHIFT);
                let negativeRight = getColumnField(aboveRight, right, belowRight, NEGATIVE_SHIFT);
                for (var row = 0u; row < rows; row += 1u) {
                    let rowBit = 1u << row;
                    if ((current & ((rowBit << SIGNIFICANT_SHIFT) | (rowBit << VISITED_SHIFT))) != 0u) {
                        continue;
                    }
                    let flags = getNeighbourFlags(significantLeft, getColumnField(above, current, below, SIGNIFICANT_SHIFT), significantRight,
                        negativeLeft, getColumnField(above, current, below, NEGATIVE_SHIFT), negativeRight, row, causal && row == CAUSAL_ROW);
                    if ((flags & FLAG_NEIGHBOURS) == 0u) {
                        continue;
                    }
                    if (mqDecode(getSignificanceContext(flags, band)) != 0u) {
                        let signEntry = getSignContext(flags);
                        var sign = mqDecode(signEntry & SIGN_CONTEXT_MASK);
                        if (!mqRaw) {
                            sign ^= signEntry >> SIGN_XOR_SHIFT;
                        }
                        coefficients[getCoefficientIndex(column, stripe * STRIPE_HEIGHT + row)] = (sign << 31u) | mask;
                        current |= rowBit << SIGNIFICANT_SHIFT;
                        if (sign != 0u) {
                            current |= rowBit << NEGATIVE_SHIFT;
                        }
                    }
                    current |= rowBit << VISITED_SHIFT;
                }
                tier1State[stripe * codeBlockWidth + column] = current;
            }
            aboveLeft = above;
            left = current;
            belowLeft = below;
            above = aboveRight;
            current = right;
            below = belowRight;
        }
    }
}

// FFmpeg's decode_refpass at bit-plane `plane`: the next magnitude bit of each sample significant before this bit-plane's significance pass
fn decodeRefinementPass(plane: u32, causal: bool) {
    let planeBit = 1u << plane;
    for (var stripe = 0u; stripe < codeBlockStripes; stripe += 1u) {
        let rows = min(STRIPE_HEIGHT, codeBlockHeight - stripe * STRIPE_HEIGHT);
        let stripeIndex = i32(stripe);
        var aboveLeft = 0u;
        var left = 0u;
        var belowLeft = 0u;
        var above = readStateWord(stripeIndex - 1, 0);
        var current = readStateWord(stripeIndex, 0);
        var below = readStateWord(stripeIndex + 1, 0);
        for (var column = 0u; column < codeBlockWidth; column += 1u) {
            let aboveRight = readStateWord(stripeIndex - 1, i32(column) + 1);
            let right = readStateWord(stripeIndex, i32(column) + 1);
            let belowRight = readStateWord(stripeIndex + 1, i32(column) + 1);
            let candidates = ((current >> SIGNIFICANT_SHIFT) & ROW_FIELD_MASK) & ~((current >> VISITED_SHIFT) & ROW_FIELD_MASK);
            if (candidates != 0u) {
                let significantLeft = getColumnField(aboveLeft, left, belowLeft, SIGNIFICANT_SHIFT);
                let significantCurrent = getColumnField(above, current, below, SIGNIFICANT_SHIFT);
                let significantRight = getColumnField(aboveRight, right, belowRight, SIGNIFICANT_SHIFT);
                for (var row = 0u; row < rows; row += 1u) {
                    let rowBit = 1u << row;
                    if ((candidates & rowBit) == 0u) {
                        continue;
                    }
                    let flags = getNeighbourFlags(significantLeft, significantCurrent, significantRight, 0u, 0u, 0u, row, causal && row == CAUSAL_ROW);
                    var context = select(REFINEMENT_FIRST_CONTEXT, REFINEMENT_NEIGHBOUR_CONTEXT, (flags & FLAG_NEIGHBOURS) != 0u);
                    if ((current & (rowBit << REFINED_SHIFT)) != 0u) {
                        context = REFINEMENT_LATER_CONTEXT;
                    }
                    let index = getCoefficientIndex(column, stripe * STRIPE_HEIGHT + row);
                    var value = coefficients[index] | (planeBit >> 1u);
                    if (mqDecode(context) != 0u) {
                        value |= planeBit;
                    } else {
                        value &= ~planeBit;
                    }
                    coefficients[index] = value;
                    current |= rowBit << REFINED_SHIFT;
                }
                tier1State[stripe * codeBlockWidth + column] = current;
            }
            aboveLeft = above;
            left = current;
            belowLeft = below;
            above = aboveRight;
            current = right;
            below = belowRight;
        }
    }
}

// FFmpeg's decode_clnpass at bit-plane `plane`, with run-length coding of all-insignificant stripe columns
fn decodeCleanupPass(plane: u32, band: u32, segmentationSymbols: bool, causal: bool) {
    // FFmpeg's 3 << (plane - 1), whose shift by -1 at plane 0 x86 masks to 31
    var mask = SIGN_BIT;
    if (plane >= 1u) {
        mask = 3u << (plane - 1u);
    }
    let runMask = select(NEIGHBOURHOOD_MASK, CAUSAL_NEIGHBOURHOOD_MASK, causal);
    for (var stripe = 0u; stripe < codeBlockStripes; stripe += 1u) {
        let rows = min(STRIPE_HEIGHT, codeBlockHeight - stripe * STRIPE_HEIGHT);
        let stripeIndex = i32(stripe);
        var aboveLeft = 0u;
        var left = 0u;
        var belowLeft = 0u;
        var above = readStateWord(stripeIndex - 1, 0);
        var current = readStateWord(stripeIndex, 0);
        var below = readStateWord(stripeIndex + 1, 0);
        for (var column = 0u; column < codeBlockWidth; column += 1u) {
            let aboveRight = readStateWord(stripeIndex - 1, i32(column) + 1);
            let right = readStateWord(stripeIndex, i32(column) + 1);
            let belowRight = readStateWord(stripeIndex + 1, i32(column) + 1);
            let significantLeft = getColumnField(aboveLeft, left, belowLeft, SIGNIFICANT_SHIFT);
            let significantRight = getColumnField(aboveRight, right, belowRight, SIGNIFICANT_SHIFT);
            var runLength = 0u;
            var decoded = false;
            var skipped = false;
            if (rows == STRIPE_HEIGHT && (current & SIGNIFICANT_OR_VISITED_MASK) == 0u
                && ((significantLeft | significantRight | getColumnField(above, current, below, SIGNIFICANT_SHIFT)) & runMask) == 0u) {
                if (mqDecode(MQ_CONTEXT_RUN_LENGTH) == 0u) {
                    skipped = true;
                } else {
                    runLength = mqDecode(MQ_CONTEXT_UNIFORM) << 1u;
                    runLength |= mqDecode(MQ_CONTEXT_UNIFORM);
                    decoded = true;
                }
            }
            if (!skipped) {
                let negativeLeft = getColumnField(aboveLeft, left, belowLeft, NEGATIVE_SHIFT);
                let negativeRight = getColumnField(aboveRight, right, belowRight, NEGATIVE_SHIFT);
                for (var row = runLength; row < rows; row += 1u) {
                    let rowBit = 1u << row;
                    let causalRow = causal && row == CAUSAL_ROW;
                    if (!decoded && (current & ((rowBit << SIGNIFICANT_SHIFT) | (rowBit << VISITED_SHIFT))) == 0u) {
                        let flags = getNeighbourFlags(significantLeft, getColumnField(above, current, below, SIGNIFICANT_SHIFT), significantRight,
                            negativeLeft, getColumnField(above, current, below, NEGATIVE_SHIFT), negativeRight, row, causalRow);
                        decoded = mqDecode(getSignificanceContext(flags, band)) != 0u;
                    }
                    if (decoded) {
                        let flags = getNeighbourFlags(significantLeft, getColumnField(above, current, below, SIGNIFICANT_SHIFT), significantRight,
                            negativeLeft, getColumnField(above, current, below, NEGATIVE_SHIFT), negativeRight, row, causalRow);
                        let signEntry = getSignContext(flags);
                        let sign = mqDecode(signEntry & SIGN_CONTEXT_MASK) ^ (signEntry >> SIGN_XOR_SHIFT);
                        coefficients[getCoefficientIndex(column, stripe * STRIPE_HEIGHT + row)] = (sign << 31u) | mask;
                        current |= rowBit << SIGNIFICANT_SHIFT;
                        if (sign != 0u) {
                            current |= rowBit << NEGATIVE_SHIFT;
                        }
                    }
                    decoded = false;
                }
                current &= ~(ROW_FIELD_MASK << VISITED_SHIFT);
                tier1State[stripe * codeBlockWidth + column] = current;
            }
            aboveLeft = above;
            left = current;
            belowLeft = below;
            above = aboveRight;
            current = right;
            below = belowRight;
        }
    }
    if (segmentationSymbols) {
        // FFmpeg only logs a wrong segmentation symbol
        for (var symbol = 0u; symbol < SEGMENTATION_SYMBOL_COUNT; symbol += 1u) {
            mqDecode(MQ_CONTEXT_UNIFORM);
        }
    }
}

// FFmpeg's needs_termination: whether a pass ends a segment, and whether the next is arithmetic or raw
fn getTermination(style: u32, passNumber: i32) -> u32 {
    if ((style & RECORD_STYLE_BYPASS) != 0u) {
        let passType = passNumber % 3;
        let triple = passNumber / 3;
        if (passType == 0 && triple > BYPASS_ARITHMETIC_TRIPLES) {
            return TERMINATION_RAW;
        }
        if (passType == 2 && triple > BYPASS_ARITHMETIC_TRIPLES) {
            return TERMINATION_ARITHMETIC;
        }
        if ((style & RECORD_STYLE_TERMINATE_ALL) != 0u) {
            return select(TERMINATION_ARITHMETIC, TERMINATION_RAW, triple > BYPASS_ARITHMETIC_TRIPLES);
        }
    }
    if ((style & RECORD_STYLE_TERMINATE_ALL) != 0u) {
        return TERMINATION_ARITHMETIC;
    }
    return 0u;
}

// FFmpeg's decode_cblk passes; like FFmpeg it keeps what it decoded when a bit-plane or a termination runs out
fn decodeCodeBlockPasses(block: CodeBlock) {
    mqInitialize(0u, false, true);
    var bitPlane = block.bitPlane;
    var passType = PASS_TYPE_CLEANUP;
    var terminationIndex = 0u;
    let causal = (block.style & RECORD_STYLE_VERTICAL_CAUSAL) != 0u;
    for (var passIndex = 0u; passIndex < block.passes; passIndex += 1u) {
        if (bitPlane < FIRST_BIT_PLANE_LIMIT || bitPlane > LAST_BIT_PLANE_LIMIT) {
            return;
        }
        let plane = u32(bitPlane + 1);
        switch (passType) {
            case PASS_TYPE_SIGNIFICANCE: {
                decodeSignificancePass(plane, block.band, causal);
            }
            case PASS_TYPE_REFINEMENT: {
                decodeRefinementPass(plane, causal);
            }
            default: {
                decodeCleanupPass(plane, block.band, (block.style & RECORD_STYLE_SEGMENTATION_SYMBOLS) != 0u, causal);
            }
        }
        if ((block.style & RECORD_STYLE_RESET) != 0u) {
            initializeContexts();
        }
        if (passIndex + 1u < block.passes) {
            let termination = getTermination(block.style, i32(passIndex));
            if (termination != 0u) {
                if (terminationIndex >= block.terminationCount) {
                    return;
                }
                let start = readTermination(block.terminations, terminationIndex);
                terminationIndex += 1u;
                mqInitialize(start, termination == TERMINATION_RAW, false);
            }
        }
        passType += 1u;
        if (passType == 3u) {
            bitPlane -= 1;
            passType = PASS_TYPE_SIGNIFICANCE;
        }
    }
}

// A 64-bit two's complement value in two words
struct Wide {
    low: u32,
    high: u32,
}

fn multiplyWide(first: u32, second: u32) -> Wide {
    let firstLow = first & LIFTING_LOW_MASK;
    let firstHigh = first >> LIFTING_LOW_BITS;
    let secondLow = second & LIFTING_LOW_MASK;
    let secondHigh = second >> LIFTING_LOW_BITS;
    let lowLow = firstLow * secondLow;
    let lowHigh = firstLow * secondHigh;
    let highLow = firstHigh * secondLow;
    let middle = lowHigh + highLow;
    let middleCarry = select(0u, 0x10000u, middle < lowHigh);
    let low = lowLow + (middle << LIFTING_LOW_BITS);
    let lowCarry = select(0u, 1u, low < lowLow);
    return Wide(low, firstHigh * secondHigh + (middle >> LIFTING_LOW_BITS) + middleCarry + lowCarry);
}

fn negateWide(value: Wide) -> Wide {
    let low = ~value.low + 1u;
    return Wide(low, ~value.high + select(0u, 1u, low == 0u));
}

fn multiplySignedWide(first: i32, second: i32) -> Wide {
    // abs of the most negative value keeps its bits, which as u32 are its magnitude
    let product = multiplyWide(u32(abs(first)), u32(abs(second)));
    if ((first < 0) != (second < 0)) {
        return negateWide(product);
    }
    return product;
}

fn addWide(value: Wide, addend: u32) -> Wide {
    let low = value.low + addend;
    return Wide(low, value.high + select(0u, 1u, low < value.low));
}

// The low 32 bits of a 64-bit value shifted right by 1 to 31 bits
fn shiftWide(value: Wide, shift: u32) -> i32 {
    return bitcast<i32>((value.low >> shift) | (value.high << (32u - shift)));
}

fn isWidePositive(value: Wide) -> bool {
    return bitcast<i32>(value.high) > 0 || (value.high == 0u && value.low != 0u);
}

// Applies the region of interest shift and dequantizes one sign-magnitude sample, as decode_cblk's last loop and FFmpeg's dequantization do
fn dequantizeSample(sample: u32, block: CodeBlock) -> i32 {
    var value = sample;
    if (block.regionShift != 0u) {
        // FFmpeg's (UINT32_MAX >> M_b) >> 1, whose shift x86 masks as WGSL does
        let backgroundMask = (0xFFFFFFFFu >> u32(block.magnitudeBits)) >> 1u;
        let magnitude = value & MAGNITUDE_MASK;
        if ((magnitude & ~backgroundMask) == 0u) {
            value = (magnitude << block.regionShift) | (value & SIGN_BIT);
        }
    }
    let downshift = u32(31 - block.magnitudeBits);
    let negative = (value & SIGN_BIT) != 0u;
    if (block.wavelet == RECORD_WAVELET_REVERSIBLE) {
        var shifted: i32;
        if (negative) {
            shifted = -bitcast<i32>((value & MAGNITUDE_MASK) >> downshift);
        } else {
            shifted = bitcast<i32>(value) >> downshift;
        }
        if (block.scale == REVERSIBLE_UNIT_STEP) {
            return shifted;
        }
        // FFmpeg's (val * (int64_t)step) / 65536, truncated toward zero
        let magnitude = shiftWide(multiplyWide(u32(abs(shifted)), u32(abs(block.scale))), STEP_FRACTION_SHIFT);
        if ((shifted < 0) != (block.scale < 0)) {
            return -magnitude;
        }
        return magnitude;
    }
    var signedValue = bitcast<i32>(value & MAGNITUDE_MASK);
    if (negative) {
        signedValue = -signedValue;
    }
    let prescaled = (signedValue + IRREVERSIBLE_PRESCALE_ROUNDING) >> IRREVERSIBLE_PRESCALE_SHIFT;
    // FFmpeg's RSHIFT: rounds half away from zero for positive products and toward it below
    let product = multiplySignedWide(prescaled, block.scale);
    if (isWidePositive(product)) {
        return shiftWide(addWide(product, ROUNDING_HALF), STEP_FRACTION_SHIFT);
    }
    return shiftWide(addWide(product, ROUNDING_HALF - 1u), STEP_FRACTION_SHIFT);
}

// Tier-1 of one code block per workgroup: lane 0 runs the passes over the workgroup's state, then every lane dequantizes
@compute @workgroup_size(32)
fn decodeCodeBlocks(@builtin(workgroup_id) group: vec3u, @builtin(num_workgroups) groups: vec3u, @builtin(local_invocation_index) lane: u32) {
    let blockIndex = getWorkgroupIndex(group, groups);
    if (blockIndex >= readRecord(RECORD_HEADER_CODE_BLOCK_COUNT)) {
        return;
    }
    let block = readCodeBlock(blockIndex);
    if (!checkCodeBlock(block)) {
        if (lane == 0u) {
            reportDecodeError(recordError(INVALID_CODE_BLOCK));
        }
        return;
    }
    let stripes = (block.height + STRIPE_HEIGHT - 1u) / STRIPE_HEIGHT;
    for (var index = lane; index < stripes * block.width; index += TIER1_WORKGROUP_SIZE) {
        tier1State[index] = 0u;
    }
    workgroupBarrier();
    if (lane == 0u) {
        codeBlockDataOffset = block.dataOffset;
        codeBlockDataLength = block.dataLength;
        codeBlockDestination = block.destination;
        codeBlockStride = block.stride;
        codeBlockWidth = block.width;
        codeBlockHeight = block.height;
        codeBlockStripes = stripes;
        decodeCodeBlockPasses(block);
    }
    storageBarrier();
    let samples = block.width * block.height;
    for (var index = lane; index < samples; index += TIER1_WORKGROUP_SIZE) {
        let coefficient = block.destination + (index / block.width) * block.stride + index % block.width;
        coefficients[coefficient] = bitcast<u32>(dequantizeSample(coefficients[coefficient], block));
    }
}

// FFmpeg's integer 9/7 lifting step: (constant * (first + second) + 2^15) >> 16 over 64 bits, keeping its low 32 bits as FFmpeg's int sample does
fn liftStep(constant: u32, first: i32, second: i32) -> i32 {
    let lowSum = (bitcast<u32>(first) & LIFTING_LOW_MASK) + (bitcast<u32>(second) & LIFTING_LOW_MASK);
    let high = (first >> LIFTING_LOW_BITS) + (second >> LIFTING_LOW_BITS) + i32(lowSum >> LIFTING_LOW_BITS);
    let low = lowSum & LIFTING_LOW_MASK;
    // constant * low reaches 33 bits, so it splits at 8 bits of the constant
    let lowProduct = (constant & LIFTING_CONSTANT_LOW_MASK) * low + ROUNDING_HALF;
    let highProduct = (constant >> LIFTING_CONSTANT_SPLIT) * low;
    let fraction = (highProduct >> LIFTING_CONSTANT_SPLIT) + ((((highProduct & LIFTING_CONSTANT_LOW_MASK) << LIFTING_CONSTANT_SPLIT) + lowProduct) >> LIFTING_LOW_BITS);
    return i32(constant) * high + i32(fraction);
}

// (value * constant + rounding) >> shift over 64 bits, the single-sample scaling of FFmpeg's integer 9/7 lines
fn scaleWide(value: i32, constant: u32, rounding: u32, shift: u32) -> i32 {
    return shiftWide(addWide(multiplySignedWide(value, i32(constant)), rounding), shift);
}

// One line of a wavelet level: where its samples are, how far apart, their count, and the parity of its first sample on the level's grid
struct Line {
    base: u32,
    step: u32,
    length: u32,
    parity: u32,
    fromScratch: bool,
}

// The sample at line index `index`, from the level's lows and then its highs, as FFmpeg interleaves them
fn readLineSample(line: Line, index: i32) -> i32 {
    let position = u32(index);
    let lowCount = (line.length + 1u - line.parity) >> 1u;
    var offset: u32;
    if ((position & 1u) == 0u) {
        offset = (position >> 1u) - line.parity;
    } else {
        offset = lowCount + (position >> 1u);
    }
    let address = line.base + offset * line.step;
    if (line.fromScratch) {
        return bitcast<i32>(transformScratch[address]);
    }
    return bitcast<i32>(coefficients[address]);
}

// The sample at a line index with whole-sample symmetric extension, as FFmpeg's extend53 and extend97_int mirror a line of two or more
fn readExtended(line: Line, index: i32) -> i32 {
    let first = i32(line.parity);
    let length = i32(line.length);
    let period = 2 * (length - 1);
    var offset = (index - first) % period;
    if (offset < 0) {
        offset += period;
    }
    if (offset >= length) {
        offset = period - offset;
    }
    return readLineSample(line, first + offset);
}

// FFmpeg's sr_1d53 at line indices 2 * pair and 2 * pair + 1
fn reconstructReversiblePair(line: Line, pair: u32) -> vec2i {
    let even = i32(2u * pair);
    if (line.length == 1u) {
        let sample = readLineSample(line, i32(line.parity));
        return select(vec2i(sample, sample), vec2i(sample >> 1u, sample >> 1u), line.parity == 1u);
    }
    let before = readExtended(line, even - 1);
    let center = readExtended(line, even);
    let after = readExtended(line, even + 1);
    let next = readExtended(line, even + 2);
    let afterNext = readExtended(line, even + 3);
    let low = center - ((before + after + 2) >> 2u);
    let nextLow = next - ((after + afterNext + 2) >> 2u);
    return vec2i(low, after + ((low + nextLow) >> 1u));
}

// FFmpeg's sr_1d97_int at line indices 2 * pair and 2 * pair + 1, computing each lifting step at every index it reads, as FFmpeg's extended loops do
fn reconstructIrreversiblePair(line: Line, pair: u32) -> vec2i {
    let even = i32(2u * pair);
    if (line.length == 1u) {
        let sample = readLineSample(line, i32(line.parity));
        if (line.parity == 1u) {
            let scaled = scaleWide(sample, LIFTING_K, LIFTING_K_ROUNDING, LIFTING_K_SHIFT);
            return vec2i(scaled, scaled);
        }
        let scaled = scaleWide(sample, LIFTING_X, ROUNDING_HALF, STEP_FRACTION_SHIFT);
        return vec2i(scaled, scaled);
    }
    var samples: array<i32, 9>;
    for (var offset = 0; offset < 9; offset += 1) {
        samples[offset] = readExtended(line, even - 3 + offset);
    }
    // Step 1 at even - 2, even, even + 2, even + 4; step 2 at even - 1, even + 1, even + 3; step 3 at even, even + 2; step 4 at even + 1
    let delta0 = samples[1] - liftStep(LIFTING_DELTA, samples[0], samples[2]);
    let delta1 = samples[3] - liftStep(LIFTING_DELTA, samples[2], samples[4]);
    let delta2 = samples[5] - liftStep(LIFTING_DELTA, samples[4], samples[6]);
    let delta3 = samples[7] - liftStep(LIFTING_DELTA, samples[6], samples[8]);
    let gamma0 = samples[2] - liftStep(LIFTING_GAMMA, delta0, delta1);
    let gamma1 = samples[4] - liftStep(LIFTING_GAMMA, delta1, delta2);
    let gamma2 = samples[6] - liftStep(LIFTING_GAMMA, delta2, delta3);
    let beta0 = delta1 + liftStep(LIFTING_BETA, gamma0, gamma1);
    let beta1 = delta2 + liftStep(LIFTING_BETA, gamma1, gamma2);
    return vec2i(beta0, gamma1 + beta0 + beta1 + liftStep(LIFTING_ALPHA_PRIME, beta0, beta1));
}

// The number of line index pairs a line spans, 0 for an empty line
fn getPairCount(length: u32, parity: u32) -> u32 {
    if (length == 0u) {
        return 0u;
    }
    return (length + parity + 1u) >> 1u;
}

// Reconstructs one pair of a line and writes its samples in natural order into the other buffer
fn reconstructLinePair(component: TileComponent, line: Line, pair: u32, outputBase: u32, outputStep: u32) {
    var values: vec2i;
    if (component.wavelet == RECORD_WAVELET_REVERSIBLE) {
        values = reconstructReversiblePair(line, pair);
    } else {
        values = reconstructIrreversiblePair(line, pair);
    }
    for (var member = 0u; member < 2u; member += 1u) {
        let index = 2u * pair + member;
        if (index < line.parity || index >= line.parity + line.length) {
            continue;
        }
        let address = outputBase + (index - line.parity) * outputStep;
        if (line.fromScratch) {
            coefficients[address] = bitcast<u32>(values[member]);
        } else {
            transformScratch[address] = bitcast<u32>(values[member]);
        }
    }
}

// The horizontal pass of a level: row `row`'s pair `pair`, from the coefficients into the scratch buffer
fn reconstructHorizontal(component: TileComponent, shape: WaveletLevel, item: u32) {
    let pairs = getPairCount(shape.width, shape.widthParity);
    let row = item / pairs;
    let base = component.coefficients + row * component.width;
    reconstructLinePair(component, Line(base, 1u, shape.width, shape.widthParity, false), item % pairs, base, 1u);
}

// The vertical pass of a level: column `column`'s pair `pair`, from the scratch buffer back into the coefficients
fn reconstructVertical(component: TileComponent, shape: WaveletLevel, item: u32) {
    let pairs = getPairCount(shape.height, shape.heightParity);
    let column = item / pairs;
    let base = component.coefficients + column;
    reconstructLinePair(component, Line(base, component.width, shape.height, shape.heightParity, true), item % pairs, base, component.width);
}

@compute @workgroup_size(1)
fn planSmallLevels() {
    if (control[CONTROL_ABORT] != 0u) {
        writeDispatch(0u);
        return;
    }
    writeDispatch(readRecord(RECORD_HEADER_SMALL_JOB_COUNT));
}

// Every small level of one tile-component, coarsest first, in one workgroup: each level's horizontal pass, then its vertical pass
@compute @workgroup_size(256)
fn transformSmallLevels(@builtin(workgroup_id) group: vec3u, @builtin(num_workgroups) groups: vec3u, @builtin(local_invocation_index) lane: u32) {
    let job = getWorkgroupIndex(group, groups);
    if (job >= readRecord(RECORD_HEADER_SMALL_JOB_COUNT)) {
        return;
    }
    let componentIndex = readRecord(readRecord(RECORD_HEADER_SMALL_JOB_TABLE) + job);
    if (componentIndex >= readRecord(RECORD_HEADER_TILE_COMPONENT_COUNT)) {
        if (lane == 0u) {
            reportDecodeError(recordError(INVALID_JOB));
        }
        return;
    }
    let component = readTileComponent(componentIndex);
    let levels = min(component.firstBigLevel, MAXIMUM_WAVELET_LEVELS);
    for (var level = 0u; level < levels; level += 1u) {
        let shape = readWaveletLevel(component, level);
        let horizontalItems = shape.height * getPairCount(shape.width, shape.widthParity);
        for (var item = lane; item < horizontalItems; item += TRANSFORM_WORKGROUP_SIZE) {
            reconstructHorizontal(component, shape, item);
        }
        storageBarrier();
        let verticalItems = shape.width * getPairCount(shape.height, shape.heightParity);
        for (var item = lane; item < verticalItems; item += TRANSFORM_WORKGROUP_SIZE) {
            reconstructVertical(component, shape, item);
        }
        storageBarrier();
    }
}

fn getIterationField(iteration: u32, field: u32) -> u32 {
    return readRecord(readRecord(RECORD_HEADER_BIG_ITERATION_TABLE) + iteration * RECORD_ITERATION_WORDS + field);
}

// Starts the next larger-level iteration and sizes its horizontal pass
@compute @workgroup_size(1)
fn planHorizontal() {
    let iteration = control[CONTROL_NEXT_ITERATION];
    control[CONTROL_ITERATION] = iteration;
    control[CONTROL_NEXT_ITERATION] = iteration + 1u;
    if (control[CONTROL_ABORT] != 0u || iteration >= readRecord(RECORD_HEADER_BIG_ITERATION_COUNT)) {
        writeDispatch(0u);
        return;
    }
    let items = getIterationField(iteration, RECORD_ITERATION_HORIZONTAL_ITEMS);
    writeDispatch((items + TRANSFORM_WORKGROUP_SIZE - 1u) / TRANSFORM_WORKGROUP_SIZE);
}

@compute @workgroup_size(1)
fn planVertical() {
    let iteration = control[CONTROL_ITERATION];
    if (control[CONTROL_ABORT] != 0u || iteration >= readRecord(RECORD_HEADER_BIG_ITERATION_COUNT)) {
        writeDispatch(0u);
        return;
    }
    let items = getIterationField(iteration, RECORD_ITERATION_VERTICAL_ITEMS);
    writeDispatch((items + TRANSFORM_WORKGROUP_SIZE - 1u) / TRANSFORM_WORKGROUP_SIZE);
}

// The job of an iteration whose work items include `item`, by binary search over the jobs' first items in `field`
fn findJob(iteration: u32, item: u32, field: u32) -> u32 {
    let jobs = getIterationField(iteration, RECORD_ITERATION_JOBS);
    var low = 0u;
    var high = getIterationField(iteration, RECORD_ITERATION_JOB_COUNT) - 1u;
    while (low < high) {
        let middle = (low + high + 1u) >> 1u;
        if (readRecord(jobs + middle * RECORD_JOB_WORDS + field) <= item) {
            low = middle;
        } else {
            high = middle - 1u;
        }
    }
    return jobs + low * RECORD_JOB_WORDS;
}

// Reads a job's tile-component and level, or reports a job outside the record and returns false
fn readJob(job: u32, component: ptr<function, TileComponent>, shape: ptr<function, WaveletLevel>) -> bool {
    let componentIndex = readRecord(job + RECORD_JOB_TILE_COMPONENT);
    if (componentIndex >= readRecord(RECORD_HEADER_TILE_COMPONENT_COUNT)) {
        reportDecodeError(recordError(INVALID_JOB));
        return false;
    }
    *component = readTileComponent(componentIndex);
    let level = readRecord(job + RECORD_JOB_LEVEL);
    if (level >= (*component).levelCount) {
        reportDecodeError(recordError(INVALID_JOB));
        return false;
    }
    *shape = readWaveletLevel(*component, level);
    return true;
}

@compute @workgroup_size(256)
fn transformHorizontal(@builtin(workgroup_id) group: vec3u, @builtin(num_workgroups) groups: vec3u, @builtin(local_invocation_index) lane: u32) {
    let iteration = control[CONTROL_ITERATION];
    let item = getWorkgroupIndex(group, groups) * TRANSFORM_WORKGROUP_SIZE + lane;
    if (iteration >= readRecord(RECORD_HEADER_BIG_ITERATION_COUNT) || item >= getIterationField(iteration, RECORD_ITERATION_HORIZONTAL_ITEMS)) {
        return;
    }
    let job = findJob(iteration, item, RECORD_JOB_HORIZONTAL_START);
    var component: TileComponent;
    var shape: WaveletLevel;
    if (!readJob(job, &component, &shape)) {
        return;
    }
    reconstructHorizontal(component, shape, item - readRecord(job + RECORD_JOB_HORIZONTAL_START));
}

@compute @workgroup_size(256)
fn transformVertical(@builtin(workgroup_id) group: vec3u, @builtin(num_workgroups) groups: vec3u, @builtin(local_invocation_index) lane: u32) {
    let iteration = control[CONTROL_ITERATION];
    let item = getWorkgroupIndex(group, groups) * TRANSFORM_WORKGROUP_SIZE + lane;
    if (iteration >= readRecord(RECORD_HEADER_BIG_ITERATION_COUNT) || item >= getIterationField(iteration, RECORD_ITERATION_VERTICAL_ITEMS)) {
        return;
    }
    let job = findJob(iteration, item, RECORD_JOB_VERTICAL_START);
    var component: TileComponent;
    var shape: WaveletLevel;
    if (!readJob(job, &component, &shape)) {
        return;
    }
    reconstructVertical(component, shape, item - readRecord(job + RECORD_JOB_VERTICAL_START));
}

// A reconstructed coefficient of a tile-component, with FFmpeg's last integer 9/7 shift: (value + 128) >> 8 in 32 bits
fn readReconstructed(component: TileComponent, x: u32, y: u32) -> i32 {
    let value = bitcast<i32>(coefficients[component.coefficients + (y - component.y0) * component.width + (x - component.x0)]);
    if (component.finalShift != 0u) {
        return (value + FINAL_ROUNDING) >> FINAL_SHIFT;
    }
    return value;
}

// FFmpeg's rct_int or ict_int at one position of a tile's first three components, returning component `slot`'s result
fn transformComponents(tile: u32, transform: u32, slot: u32, x: u32, y: u32) -> i32 {
    let first = readReconstructed(readTileComponent(readRecord(tile + RECORD_TILE_COMPONENTS)), x, y);
    let second = readReconstructed(readTileComponent(readRecord(tile + RECORD_TILE_COMPONENTS + 1u)), x, y);
    let third = readReconstructed(readTileComponent(readRecord(tile + RECORD_TILE_COMPONENTS + 2u)), x, y);
    if (transform == RECORD_COMPONENT_TRANSFORM_REVERSIBLE) {
        let green = first - ((third + second) >> 2u);
        switch (slot) {
            case 0u: {
                return green + third;
            }
            case 1u: {
                return green;
            }
            default: {
                return green + second;
            }
        }
    }
    switch (slot) {
        case 0u: {
            return first + third + (bitcast<i32>(ICT_RED_FROM_CR * bitcast<u32>(third) + ROUNDING_HALF) >> 16u);
        }
        case 1u: {
            return first - (bitcast<i32>(ICT_GREEN_FROM_CB * bitcast<u32>(second) + ROUNDING_HALF) >> 16u)
                - (bitcast<i32>(ICT_GREEN_FROM_CR * bitcast<u32>(third) + ROUNDING_HALF) >> 16u);
        }
        default: {
            return first + 2 * second + (bitcast<i32>(ICT_BLUE_FROM_CB * bitcast<u32>(second) + ROUNDING_HALF) >> 16u);
        }
    }
}

// One output sample of a plane as FFmpeg's write_frame stores it: the reconstructed value, DC level shifted, clipped, and shifted to the
// plane's precision; past the component's last sample, which FFmpeg leaves unwritten, the edge repeats
fn getOutputSample(plane: u32, x: u32, y: u32) -> u32 {
    let slot = getPlaneField(plane, RECORD_PLANE_COMPONENT);
    let divisorX = getPlaneField(plane, RECORD_PLANE_DIVISOR_X);
    let divisorY = getPlaneField(plane, RECORD_PLANE_DIVISOR_Y);
    let lastX = (readRecord(RECORD_HEADER_IMAGE_X1) + divisorX - 1u) / divisorX - 1u;
    let lastY = (readRecord(RECORD_HEADER_IMAGE_Y1) + divisorY - 1u) / divisorY - 1u;
    let componentX = min(x + getPlaneField(plane, RECORD_PLANE_ORIGIN_X), lastX);
    let componentY = min(y + getPlaneField(plane, RECORD_PLANE_ORIGIN_Y), lastY);
    let tileColumns = readRecord(RECORD_HEADER_TILE_COLUMNS);
    let tileRows = readRecord(RECORD_HEADER_TILE_ROWS);
    let tileColumn = min((componentX * divisorX - readRecord(RECORD_HEADER_TILE_OFFSET_X)) / readRecord(RECORD_HEADER_TILE_WIDTH), tileColumns - 1u);
    let tileRow = min((componentY * divisorY - readRecord(RECORD_HEADER_TILE_OFFSET_Y)) / readRecord(RECORD_HEADER_TILE_HEIGHT), tileRows - 1u);
    let tile = readRecord(RECORD_HEADER_TILE_TABLE) + (tileRow * tileColumns + tileColumn) * RECORD_TILE_WORDS;
    let transform = readRecord(tile + RECORD_TILE_TRANSFORM);
    var value: i32;
    if (transform != RECORD_COMPONENT_TRANSFORM_NONE && slot < 3u) {
        value = transformComponents(tile, transform, slot, componentX, componentY);
    } else {
        value = readReconstructed(readTileComponent(readRecord(tile + RECORD_TILE_COMPONENTS + slot)), componentX, componentY);
    }
    let bits = getPlaneField(plane, RECORD_PLANE_COMPONENT_BITS);
    let maximum = i32((1u << bits) - 1u);
    let shifted = clamp(value + i32(1u << (bits - 1u)), 0, maximum);
    return u32(shifted) << getPlaneField(plane, RECORD_PLANE_SHIFT);
}

// FFmpeg's xyzgamma table entry of an X', Y', or Z' code: its 16-bit linear light, 0 for code 0, where pow is undefined
fn decodeXYZGamma(code: u32) -> i32 {
    if (code == 0u) {
        return 0;
    }
    return i32(round(pow(f32(code) / XYZ_CODE_MAXIMUM, XYZ_DECODING_GAMMA) * XYZ_LINEAR_MAXIMUM));
}

// FFmpeg's rgbgamma table entry of 16-bit linear light, clipped first as its converter clips it: the R', G', or B' code, 0 for 0
fn encodeRGBGamma(linear: i32) -> f32 {
    let clipped = clamp(linear, 0, XYZ_LINEAR_MAXIMUM_CODE);
    if (clipped == 0) {
        return 0.0;
    }
    return round(pow(f32(clipped) / XYZ_LINEAR_MAXIMUM, RGB_ENCODING_GAMMA) * XYZ_CODE_MAXIMUM);
}

// One output sample of an XYZ picture: the R'G'B' FFmpeg's converter makes of the X', Y', and Z' planes at the position, as limited-range
// BT.709 Y'CbCr at 12 bits, luma in plane 0, Cb in plane 1, and Cr in plane 2
fn getXYZOutputSample(plane: u32, x: u32, y: u32) -> u32 {
    let linear = vec3i(decodeXYZGamma(getOutputSample(0u, x, y)), decodeXYZGamma(getOutputSample(1u, x, y)), decodeXYZGamma(getOutputSample(2u, x, y)));
    let rgb = vec3f(
        encodeRGBGamma(dot(XYZ_TO_RED, linear) >> XYZ_MATRIX_SHIFT),
        encodeRGBGamma(dot(XYZ_TO_GREEN, linear) >> XYZ_MATRIX_SHIFT),
        encodeRGBGamma(dot(XYZ_TO_BLUE, linear) >> XYZ_MATRIX_SHIFT)
    ) / XYZ_CODE_MAXIMUM;
    let luma = BT709_RED_WEIGHT * rgb.r + (1.0 - BT709_RED_WEIGHT - BT709_BLUE_WEIGHT) * rgb.g + BT709_BLUE_WEIGHT * rgb.b;
    var value: f32;
    switch (plane) {
        case 0u: {
            value = LIMITED_LUMA_BLACK + LIMITED_LUMA_RANGE * luma;
        }
        case 1u: {
            value = LIMITED_CHROMA_CENTER + LIMITED_CHROMA_RANGE * (rgb.b - luma) / (2.0 * (1.0 - BT709_BLUE_WEIGHT));
        }
        default: {
            value = LIMITED_CHROMA_CENTER + LIMITED_CHROMA_RANGE * (rgb.r - luma) / (2.0 * (1.0 - BT709_RED_WEIGHT));
        }
    }
    return u32(clamp(round(value), 0.0, XYZ_CODE_MAXIMUM));
}

// One sample of an output plane: FFmpeg's sample, or for an XYZ picture its conversion
fn getConvertedSample(plane: u32, x: u32, y: u32) -> u32 {
    if (readRecord(RECORD_HEADER_OUTPUT_TRANSFORM) == RECORD_OUTPUT_TRANSFORM_XYZ) {
        return getXYZOutputSample(plane, x, y);
    }
    return getOutputSample(plane, x, y);
}

// Writes one word of a plane row: four 8-bit or two 16-bit samples; an XYZ picture is 12-bit, so only the 16-bit samples convert
@compute @workgroup_size(64)
fn writeOutput(@builtin(global_invocation_id) invocation: vec3u) {
    let plane = invocation.z;
    if (plane >= RECORD_PLANE_COUNT || control[CONTROL_ABORT] != 0u || getPlaneField(plane, RECORD_PLANE_COMPONENT) == RECORD_MISSING) {
        return;
    }
    let width = getPlaneField(plane, RECORD_PLANE_WIDTH);
    let row = invocation.y;
    let firstSample = invocation.x * SAMPLES_PER_WORD;
    if (row >= getPlaneField(plane, RECORD_PLANE_HEIGHT) || firstSample >= width) {
        return;
    }
    if (SAMPLE_BYTES == 1u) {
        var samples = vec4u(0u);
        for (var lane = 0u; lane < 4u; lane += 1u) {
            if (firstSample + lane < width) {
                samples[lane] = getOutputSample(plane, firstSample + lane, row);
            }
        }
        writeOutputSamples8(plane, firstSample, row, samples);
        return;
    }
    var samples = vec2u(0u);
    for (var lane = 0u; lane < 2u; lane += 1u) {
        if (firstSample + lane < width) {
            samples[lane] = getConvertedSample(plane, firstSample + lane, row);
        }
    }
    writeOutputSamples16(plane, firstSample, row, samples);
}
