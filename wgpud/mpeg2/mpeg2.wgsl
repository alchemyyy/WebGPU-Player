//! id: mpeg2
//! name: MPEG-2 Video
//! decoder: video
//! accepts: codec in [mpeg2video, mpeg1video], stream.width <= 16384, stream.height <= 16384, stream.bitDepth == 8
//! output: I420, I422, I444
//! references: 2
//! reorder: 3
//! packet: 8 MiB
//! state: 64
//! buffer: pictureState, 2394880, indirect
//! buffer: macroblocks, stream.width * stream.height / 256 * 68
//! buffer: coefficients, min(stream.width * stream.height * (4 + 8 / (output.chromaWidthDivisor * output.chromaHeightDivisor)), 134217728)
//! error: 1, sequenceHeader, conceal
//! error: 2, pictureSize
//! error: 3, chromaFormat
//! error: 4, pictureHeader, conceal
//! error: 5, quantizerMatrix, conceal
//! error: 6, startCodes, resync
//! error: 7, pictureCount, resync
//! error: 8, fieldPictures, resync
//! error: 9, sliceHeader, conceal
//! error: 10, macroblockAddress, conceal
//! error: 11, macroblockType, conceal
//! error: 12, motionType, conceal
//! error: 13, motionVector, conceal
//! error: 14, codedBlockPattern, conceal
//! error: 15, dcDifferential, conceal
//! error: 16, coefficients, conceal
//! error: 17, skippedMacroblock, conceal
//! error: 18, sliceEnd, conceal
//! error: 19, bitsExhausted, conceal
//! error: 20, coefficientStorage, conceal
//! error: 21, packetSize, conceal
//! error: 22, sliceCoverage, conceal
//! error: 23, frameDimensions, resync
//! error: 24, fieldMissing, conceal
//! dispatch: loadLookups, 60
//! dispatch: preparePacket, 1
//! dispatch: countStartCodes, indirect pictureState
//! dispatch: prefixStartCodes, 1
//! dispatch: listStartCodes, indirect pictureState
//! dispatch: parseHeaders, 1
//! dispatch: prepareSlices, indirect pictureState
//! dispatch: allocateSlices, 1
//! dispatch: copyFrame, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: decodeSlices, indirect pictureState
//! dispatch: checkSlices, 1
//! dispatch: composeMacroblocks, indirect pictureState
//! dispatch: prepareRedecode, 1
//! dispatch: redecodeSlices, indirect pictureState
//! dispatch: markSegments, 1
//! dispatch: reconstructPicture, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: decideConcealment, 1
//! dispatch: concealMacroblocks, indirect pictureState
//! dispatch: concealIntra, indirect pictureState
//! dispatch: deblockHorizontal, indirect pictureState
//! dispatch: deblockVertical, indirect pictureState
//! dispatch: nextPicture, 1
//! dispatch: reconstructPicture, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: decideConcealment, 1
//! dispatch: concealMacroblocks, indirect pictureState
//! dispatch: concealIntra, indirect pictureState
//! dispatch: deblockHorizontal, indirect pictureState
//! dispatch: deblockVertical, indirect pictureState
//! dispatch: finishPacket, 1

// The MPEG-2 Video decoder: ISO/IEC 13818-2 Main, High, and 4:2:2 profile streams, and 4:4:4 ones, entirely in compute shaders,
// from the container's packets and codec private data alone. It mirrors FFmpeg's mpeg12dec.c and mpegvideo, so its frames match
// FFmpeg's mpeg2video decoder with FFmpeg's simple IDCT, which FFmpeg's default IDCT equals on x86-64.
// A packet holds one frame: a frame picture or two field pictures, or the second field of a frame whose first field ended the packet before.
// The passes:
// - loadLookups copies the code lookups and scan orders into pictureState, once per session
// - preparePacket, countStartCodes, prefixStartCodes, and listStartCodes find the packet's start codes in parallel, in order
// - parseHeaders walks them on one invocation as decode_chunks does: sequence, extensions, GOP, pictures, and the slice table
// - prepareSlices parses each slice's header and first macroblock address; allocateSlices gives each its coefficient storage
// - copyFrame copies a first field from an earlier packet, or fills a frame FFmpeg would not decode
// - decodeSlices decodes each slice on its own invocation: macroblock types, motion vectors, and quantized coefficients
// - checkSlices checks that the slices cover each picture once, in raster order; where they do not, or a slice failed, composeMacroblocks
//   gives each macroblock the error status FFmpeg's ff_er_add_slice leaves it, and redecodeSlices rewrites the macroblocks two slices decoded
// - markSegments marks the damaged macroblocks as ff_er_frame_end does before it conceals them
// - reconstructPicture runs once per picture, one workgroup per macroblock: dequantization, the IDCT, motion compensation, output
// - decideConcealment, concealMacroblocks, concealIntra, deblockHorizontal, and deblockVertical conceal a picture's damaged macroblocks
//   as FFmpeg's error resilience does, after the picture's reconstruction
// - finishPacket hands the slots that left the references back to the engine
// A damaged slice ends at its damage, and decoding resumes at the next slice; damaged headers are ignored where FFmpeg ignores them

// pictureState: the dispatch arguments, then the session context, then the packet's work
// The words an indirect dispatch reads; every pass that precedes one writes them
const ARGUMENTS_X: u32 = 0u;
const ARGUMENTS_Y: u32 = 1u;
const ARGUMENTS_Z: u32 = 2u;

// The session context, which survives a reset as FFmpeg's decoder context survives a flush
const CONTEXT_LOOKUPS_LOADED: u32 = 4u;
const CONTEXT_CONFIGURATION_PARSED: u32 = 5u;
const CONTEXT_SEQUENCE_WIDTH: u32 = 6u;
const CONTEXT_SEQUENCE_HEIGHT: u32 = 7u;
const CONTEXT_MPEG2: u32 = 8u;
const CONTEXT_CHROMA_FORMAT: u32 = 9u;
const CONTEXT_PROGRESSIVE_SEQUENCE: u32 = 10u;
const CONTEXT_LOW_DELAY: u32 = 11u;
const CONTEXT_PROFILE: u32 = 12u;
const CONTEXT_LEVEL: u32 = 13u;
const CONTEXT_INITIALIZED: u32 = 14u;
const CONTEXT_INITIALIZED_WIDTH: u32 = 15u;
const CONTEXT_INITIALIZED_HEIGHT: u32 = 16u;
const CONTEXT_INITIALIZED_PROGRESSIVE_SEQUENCE: u32 = 17u;
const CONTEXT_INITIALIZED_CHROMA_FORMAT: u32 = 18u;
const CONTEXT_MACROBLOCK_WIDTH: u32 = 19u;
const CONTEXT_MACROBLOCK_HEIGHT: u32 = 20u;
// The picture coding fields FFmpeg keeps from picture to picture: a picture without a coding extension, as MPEG-1 pictures are, reuses them
const CONTEXT_PICTURE_FIELDS: u32 = 24u;
// The quantizer matrices in raster order: intra, non-intra, chroma intra, and chroma non-intra
const CONTEXT_MATRICES: u32 = 64u;
const MATRIX_WORDS: u32 = 64u;
const MATRIX_INTRA: u32 = 0u;
const MATRIX_NON_INTRA: u32 = 64u;
const MATRIX_CHROMA_INTRA: u32 = 128u;
const MATRIX_CHROMA_NON_INTRA: u32 = 192u;
const MATRICES_WORDS: u32 = 256u;

// The code lookups and tables loadLookups copies
const LOOKUPS: u32 = 320u;

// The packet's work
const PACKET_FAILED: u32 = 4128u;
const PACKET_SCAN_WORKGROUPS: u32 = 4129u;
const PACKET_START_CODE_COUNT: u32 = 4130u;
const PACKET_PICTURE_COUNT: u32 = 4131u;
const PACKET_SLICE_COUNT: u32 = 4132u;
const PACKET_CURRENT_PICTURE: u32 = 4133u;
// What copyFrame writes into the output slot before any picture decodes: nothing, a whole frame, or one field's lines
const PACKET_COPY_MODE: u32 = 4134u;
// The slot it copies from, plus one; zero fills the frame with gray as FFmpeg colors a missing reference
const PACKET_COPY_SOURCE: u32 = 4135u;
const PACKET_COPY_FIELD: u32 = 4136u;
const PACKET_RELEASE_COUNT: u32 = 4137u;
const PACKET_RELEASES: u32 = 4138u;
const MAXIMUM_RELEASES: u32 = 6u;
// The slot, plus one, of a frame whose first field an earlier packet decoded: this packet's second field writes into it too,
// so the frame the engine presents for that packet is whole
const PACKET_MIRROR_SLOT: u32 = 4144u;
// Whether two slices decoded one macroblock, so redecodeSlices rewrites each macroblock from the slice that decoded it last
const PACKET_REDECODE: u32 = 4145u;
// Per scan workgroup: its start code count, then the start codes before it
const BLOCK_COUNTS: u32 = 4160u;
const BLOCK_OFFSETS: u32 = 6208u;
const MAXIMUM_SCAN_WORKGROUPS: u32 = 2048u;
// The packet's start code positions in order, each the position of its 00 00 01 prefix
const START_CODES: u32 = 8256u;
const MAXIMUM_START_CODES: u32 = 65536u;
// The packet's pictures: a frame picture, or two field pictures
const PICTURES: u32 = 73792u;
const MAXIMUM_PICTURES: u32 = 2u;
const PICTURE_WORDS: u32 = 320u;
// The packet's slices
const SLICES: u32 = 74432u;
const SLICE_WORDS: u32 = 8u;
const MAXIMUM_SLICES: u32 = 65536u;
// pictureState's words: 74432 + 65536 * 8 = 598720
const PICTURE_STATE_WORDS: u32 = 598720u;

// Fields of a picture's block in PICTURES; the picture coding fields share their order with CONTEXT_PICTURE_FIELDS
const PICTURE_DECODED: u32 = 0u;
const PICTURE_TYPE: u32 = 1u;
const PICTURE_MPEG2: u32 = 2u;
const PICTURE_FIRST_FIELD: u32 = 3u;
const PICTURE_FORWARD_SLOT: u32 = 4u;
const PICTURE_BACKWARD_SLOT: u32 = 5u;
const PICTURE_STARTED: u32 = 6u;
const PICTURE_MACROBLOCK_COUNT: u32 = 7u;
const PICTURE_D10: u32 = 8u;
// Whether a slice of the picture failed, or its slices left a macroblock uncovered or covered twice, so the picture is concealed
const PICTURE_CONCEALED: u32 = 9u;
// Whether concealment takes the damaged macroblocks for intra ones, FFmpeg's is_intra_more_likely
const PICTURE_CONCEAL_INTRA: u32 = 10u;
// The picture's slices in the slice table: the first, and how many
const PICTURE_FIRST_SLICE: u32 = 11u;
const PICTURE_SLICE_COUNT: u32 = 12u;
// The picture coding fields, at the same offsets from PICTURE_CODING_FIELDS and CONTEXT_PICTURE_FIELDS
const PICTURE_CODING_FIELDS: u32 = 16u;
const CODING_F_CODE_FORWARD_X: u32 = 0u;
const CODING_F_CODE_FORWARD_Y: u32 = 1u;
const CODING_F_CODE_BACKWARD_X: u32 = 2u;
const CODING_F_CODE_BACKWARD_Y: u32 = 3u;
const CODING_FULL_PEL_FORWARD: u32 = 4u;
const CODING_FULL_PEL_BACKWARD: u32 = 5u;
const CODING_INTRA_DC_PRECISION: u32 = 6u;
const CODING_PICTURE_STRUCTURE: u32 = 7u;
const CODING_TOP_FIELD_FIRST: u32 = 8u;
const CODING_FRAME_PRED_FRAME_DCT: u32 = 9u;
const CODING_CONCEALMENT_MOTION_VECTORS: u32 = 10u;
const CODING_Q_SCALE_TYPE: u32 = 11u;
const CODING_INTRA_VLC_FORMAT: u32 = 12u;
const CODING_ALTERNATE_SCAN: u32 = 13u;
const CODING_REPEAT_FIRST_FIELD: u32 = 14u;
const CODING_CHROMA_420_TYPE: u32 = 15u;
const CODING_PROGRESSIVE_FRAME: u32 = 16u;
const CODING_FIELD_COUNT: u32 = 17u;
const PICTURE_MATRICES: u32 = 64u;

// Fields of a slice's entry in SLICES
const SLICE_DATA_BYTE: u32 = 0u;
const SLICE_END_BYTE: u32 = 1u;
// The picture's index in bit 0, FFmpeg's mb_y of the slice's row above it
const SLICE_POSITION: u32 = 2u;
// The first macroblock's column in bits 0 to 15 and the slice's quantizer scale above them
const SLICE_FIRST_MACROBLOCK: u32 = 3u;
// The bit its first macroblock starts at, or 0 for a slice whose header failed, which decodes nothing as FFmpeg's resync stays unset
const SLICE_MACROBLOCK_BIT: u32 = 4u;
const SLICE_ENTRY_BASE: u32 = 5u;
const SLICE_ENTRY_LIMIT: u32 = 6u;
// How the slice ended in bits 30 and 31, and where in the bits below in its picture's raster order: after its last macroblock,
// or at the macroblock it failed at; decodeSlices writes it for checkSlices
const SLICE_END_MACROBLOCK: u32 = 7u;
const SLICE_OUTCOME_SHIFT: u32 = 30u;
const SLICE_END_INDEX_MASK: u32 = 0x3FFFFFFFu;
// Slice outcomes: none yet, ended, and failed
const SLICE_OUTCOME_NONE: u32 = 0u;
const SLICE_OUTCOME_ENDED: u32 = 1u;
const SLICE_OUTCOME_FAILED: u32 = 2u;
// Slices dispatch in rows of this many workgroups, so a packet of many slices stays within the workgroup count limit
const SLICE_DISPATCH_WIDTH: u32 = 256u;

// state: what a reset clears, as FFmpeg's flush drops its pictures. Slots are stored plus one, so zero is none
const STATE_LAST_SLOT: u32 = 0u;
const STATE_NEXT_SLOT: u32 = 1u;
const STATE_FIRST_FIELD: u32 = 2u;
const STATE_SYNC: u32 = 3u;
const STATE_CLOSED_GOP: u32 = 4u;
// A frame whose first field ended its packet, which the next packet's second field completes
const STATE_PENDING_SLOT: u32 = 5u;
const STATE_PENDING_ANCHOR: u32 = 6u;
const STATE_PENDING_STRUCTURE: u32 = 7u;
const STATE_FACTS_REPORTED: u32 = 8u;
// The pending frame's picture fields, which the packet that completes it reports again
const STATE_PENDING_FIELDS: u32 = 9u;

// macroblocks: one record per macroblock of the frame, at FFmpeg's mb_y and mb_x; field pictures interleave their rows by parity
const MACROBLOCK_WORDS: u32 = 17u;
// The packet index of the packet that decoded the record, so a macroblock no slice covered is recognized
const RECORD_SERIAL: u32 = 0u;
const RECORD_FLAGS: u32 = 1u;
// Motion vectors, x in the low and y in the high 16 bits: forward 0 and 1, then backward 0 and 1;
// dual prime keeps its opposite parity vectors in the backward words
const RECORD_VECTORS: u32 = 2u;
const RECORD_ENTRY_START: u32 = 6u;
// Each block's coefficient entry count, a byte each, four to a word
const RECORD_BLOCK_COUNTS: u32 = 7u;
// A concealed picture's concealment status of the macroblock, the CONCEAL_* bits, with its owner above CONCEAL_OWNER_SHIFT
const RECORD_CONCEALMENT: u32 = 10u;
// The DC of each 8x8 block concealment computes or guesses, two signed 16-bit values to a word: luma, then blue, then red,
// RECORD_DC_PLANE_WORDS words to a plane
const RECORD_DC: u32 = 11u;
const RECORD_DC_PLANE_WORDS: u32 = 2u;

// Fields of a record's flags
const FLAG_INTRA: u32 = 1u;
const FLAG_FORWARD: u32 = 2u;
const FLAG_BACKWARD: u32 = 4u;
const MOTION_TYPE_SHIFT: u32 = 3u;
const MOTION_TYPE_MASK: u32 = 3u;
const FLAG_FIELD_DCT: u32 = 32u;
// Field selects at bit 6 + direction * 2 + vector
const FIELD_SELECT_SHIFT: u32 = 6u;
const CODED_BLOCKS_SHIFT: u32 = 10u;
const CODED_BLOCKS_MASK: u32 = 0xFFFu;
const QUANTIZER_SHIFT: u32 = 22u;
const QUANTIZER_MASK: u32 = 0x7Fu;
// A skipped macroblock, FFmpeg's mb_skipped
const FLAG_SKIPPED: u32 = 0x20000000u;

// The bits of a macroblock's concealment status, as FFmpeg's error_status_table holds them with each error and end kind as one:
// a slice starts at the macroblock, a failed slice stopped at it, a slice ended at it, and it is damaged.
// A macroblock no slice covered keeps all three of the first, as ff_er_frame_start fills the table
const CONCEAL_SLICE_START: u32 = 1u;
const CONCEAL_ERROR: u32 = 2u;
const CONCEAL_END: u32 = 4u;
const CONCEAL_UNCOVERED: u32 = 7u;
const CONCEAL_DAMAGED: u32 = 8u;
// The slice that decoded the macroblock last, plus one, whose record redecodeSlices rewrites
const CONCEAL_OWNER_SHIFT: u32 = 8u;

// Motion types of a record, FFmpeg's MV_TYPE_*: one vector per direction for the frame or the field picture's macroblock,
// a vector per field of a frame picture's macroblock, a vector per half of a field picture's macroblock, and dual prime
const MOTION_FRAME: u32 = 0u;
const MOTION_FIELD: u32 = 1u;
const MOTION_16X8: u32 = 2u;
const MOTION_DUAL_PRIME: u32 = 3u;

// coefficients: each coded block's quantized coefficients in decode order, its scan position in bits 0 to 5 and its signed level above;
// an intra block's first entry holds its DC as the DC prediction left it
const ENTRY_LEVEL_SHIFT: u32 = 6u;
const ENTRY_POSITION_MASK: u32 = 63u;
const COEFFICIENTS_PER_BLOCK: u32 = 64u;
// A coefficient costs at least two bits, so a slice's bytes bound its entries
const ENTRIES_PER_SLICE_BYTE: u32 = 4u;

// Start codes, the byte after 00 00 01
const PICTURE_START_CODE: u32 = 0x00u;
const SLICE_MINIMUM_START_CODE: u32 = 0x01u;
const SLICE_MAXIMUM_START_CODE: u32 = 0xAFu;
const USER_DATA_START_CODE: u32 = 0xB2u;
const SEQUENCE_HEADER_CODE: u32 = 0xB3u;
const EXTENSION_START_CODE: u32 = 0xB5u;
const GROUP_START_CODE: u32 = 0xB8u;
// What decode_chunks' last_code remembers: nothing, a picture header, or a slice
const LAST_CODE_NONE: u32 = 0u;
const LAST_CODE_PICTURE: u32 = 1u;
const LAST_CODE_SLICE: u32 = 2u;

// Extension start code identifiers
const SEQUENCE_EXTENSION_ID: u32 = 1u;
const QUANT_MATRIX_EXTENSION_ID: u32 = 3u;
const PICTURE_CODING_EXTENSION_ID: u32 = 8u;

// Picture types, FFmpeg's AV_PICTURE_TYPE_*, and picture structures
const PICTURE_TYPE_NONE: u32 = 0u;
const PICTURE_TYPE_I: u32 = 1u;
const PICTURE_TYPE_P: u32 = 2u;
const PICTURE_TYPE_B: u32 = 3u;
const STRUCTURE_TOP_FIELD: u32 = 1u;
const STRUCTURE_BOTTOM_FIELD: u32 = 2u;
const STRUCTURE_FRAME: u32 = 3u;

// Chroma formats, as chroma_format and the prelude's OUTPUT_CHROMA_FORMAT count them
const CHROMA_420: u32 = 1u;
const CHROMA_422: u32 = 2u;
const CHROMA_444: u32 = 3u;

// copyFrame's modes
const COPY_NONE: u32 = 0u;
const COPY_FRAME: u32 = 1u;
const COPY_FIELD: u32 = 2u;

// Header sources
const SOURCE_PACKET: u32 = 0u;
const SOURCE_CONFIGURATION: u32 = 1u;

// Macroblock type flags of the lookups' symbols
const MACROBLOCK_INTRA: u32 = 1u;
const MACROBLOCK_QUANT: u32 = 2u;
const MACROBLOCK_FORWARD: u32 = 4u;
const MACROBLOCK_BACKWARD: u32 = 8u;
const MACROBLOCK_PATTERN: u32 = 16u;
const MACROBLOCK_ZERO_MOTION: u32 = 32u;

// macroblock_address_increment symbols past the increments
const INCREMENT_ESCAPE: u32 = 33u;
const INCREMENT_END: u32 = 35u;
const INCREMENT_ESCAPE_MACROBLOCKS: u32 = 33u;

// Lookup entries: the symbol, the code's length, and a subtable link
const LOOKUP_LINK_FLAG: u32 = 0x80000000u;
const LOOKUP_SYMBOL_MASK: u32 = 0xFFFFu;
const LOOKUP_LENGTH_SHIFT: u32 = 16u;
const LOOKUP_LENGTH_MASK: u32 = 31u;
const LOOKUP_SUBTABLE_BITS_MASK: u32 = 15u;
// Coefficient symbols: the run plus one in bits 0 to 6 and the level above; level 0 is the escape and level 127 the end of block
const COEFFICIENT_RUN_MASK: u32 = 127u;
const COEFFICIENT_LEVEL_SHIFT: u32 = 7u;
const COEFFICIENT_ESCAPE_LEVEL: u32 = 0u;
const COEFFICIENT_END_OF_BLOCK_LEVEL: u32 = 127u;
// The last scan position
const MAXIMUM_SCAN_INDEX: i32 = 63;

// Pictures taller than this many macroblock rows carry slice_vertical_position_extension, FFmpeg's 2800 / 16
const VERTICAL_POSITION_EXTENSION_ROWS: u32 = 175u;
// The 4:2:2 profile at Main level, which D-10 streams use, by FFmpeg's profile and level numbers
const D10_PROFILE: u32 = 0u;
const D10_LEVEL: u32 = 5u;
const D10_INTRA_DC_PRECISION: u32 = 2u;
// What follows the last macroblock of a D-10 picture in some files: an MXF key
const MXF_KEY_PREFIX: u32 = 0x060E2Bu;
// What follows the last macroblock of a picture with an m704 alpha plane
const M704_ALPHA_MARKER: u32 = 0x201u;

const ERROR_CODE_SHIFT: u32 = 24u;
const ERROR_VALUE_MASK: u32 = 0xFFFFFFu;
const ERROR_SEQUENCE_HEADER: u32 = 1u;
const ERROR_PICTURE_SIZE: u32 = 2u;
const ERROR_CHROMA_FORMAT: u32 = 3u;
const ERROR_PICTURE_HEADER: u32 = 4u;
const ERROR_QUANTIZER_MATRIX: u32 = 5u;
const ERROR_START_CODES: u32 = 6u;
const ERROR_PICTURE_COUNT: u32 = 7u;
const ERROR_FIELD_PICTURES: u32 = 8u;
const ERROR_SLICE_HEADER: u32 = 9u;
const ERROR_MACROBLOCK_ADDRESS: u32 = 10u;
const ERROR_MACROBLOCK_TYPE: u32 = 11u;
const ERROR_MOTION_TYPE: u32 = 12u;
const ERROR_MOTION_VECTOR: u32 = 13u;
const ERROR_CODED_BLOCK_PATTERN: u32 = 14u;
const ERROR_DC_DIFFERENTIAL: u32 = 15u;
const ERROR_COEFFICIENTS: u32 = 16u;
const ERROR_SKIPPED_MACROBLOCK: u32 = 17u;
const ERROR_SLICE_END: u32 = 18u;
const ERROR_BITS_EXHAUSTED: u32 = 19u;
const ERROR_COEFFICIENT_STORAGE: u32 = 20u;
const ERROR_PACKET_SIZE: u32 = 21u;
const ERROR_SLICE_COVERAGE: u32 = 22u;
const ERROR_FRAME_DIMENSIONS: u32 = 23u;
const ERROR_FIELD_MISSING: u32 = 24u;

// Reports a failure, the code in the high byte and the failing value below it, and stops the packet's later passes.
// Its codes are fatal or resync the decoder, so the packet's frame never presents
fn reportFailure(code: u32, value: u32) {
    reportDecodeError((code << ERROR_CODE_SHIFT) | min(value, ERROR_VALUE_MASK));
    pictureState[PACKET_FAILED] = 1u;
}

// Reports damage the decoder conceals, the code in the high byte and the failing value below it; decoding goes on
fn reportConcealment(code: u32, value: u32) {
    reportDecodeError((code << ERROR_CODE_SHIFT) | min(value, ERROR_VALUE_MASK));
}

fn packetFailed() -> bool {
    return pictureState[PACKET_FAILED] != 0u;
}

fn setDispatchArguments(x: u32, y: u32, z: u32) {
    pictureState[ARGUMENTS_X] = x;
    pictureState[ARGUMENTS_Y] = y;
    pictureState[ARGUMENTS_Z] = z;
}

fn lookupWord(index: u32) -> u32 {
    return pictureState[LOOKUPS + index];
}

fn pictureBase(pictureIndex: u32) -> u32 {
    return PICTURES + pictureIndex * PICTURE_WORDS;
}

fn sliceBase(sliceIndex: u32) -> u32 {
    return SLICES + sliceIndex * SLICE_WORDS;
}

// Sign-extends the low 16 bits, as FFmpeg's int16_t blocks keep values
fn wrapInt16(value: i32) -> i32 {
    return (value << 16u) >> 16u;
}

// FFmpeg's sign_extend
fn signExtend(value: i32, bits: u32) -> i32 {
    return (value << (32u - bits)) >> (32u - bits);
}

fn clipSample(value: i32) -> u32 {
    return u32(clamp(value, 0, 255));
}

fn byteSwap(value: u32) -> u32 {
    return (value << 24u) | ((value & 0xFF00u) << 8u) | ((value >> 8u) & 0xFF00u) | (value >> 24u);
}

// The packet's words as a big-endian bitstream reads them, zero past its end as FFmpeg's padding reads
fn packetBigEndianWord(wordIndex: u32) -> u32 {
    if (wordIndex >= (packet.byteLength + 3u) >> 2u) {
        return 0u;
    }
    return byteSwap(readPacketWord(wordIndex));
}

// count bits, 1 to 32, at any bit position of the packet
fn peekPacketBitsAt(bit: u32, count: u32) -> u32 {
    let word = bit >> 5u;
    let shift = bit & 31u;
    let window = (packetBigEndianWord(word) << shift) | ((packetBigEndianWord(word + 1u) >> 1u) >> (31u - shift));
    return window >> (32u - count);
}

// Code lookups, at their word offset in TABLE_WORDS and with their first level's index bits
const LOOKUP_MACROBLOCK_ADDRESS_INCREMENT: u32 = 0u;
const LOOKUP_MACROBLOCK_ADDRESS_INCREMENT_BITS: u32 = 8u;
const LOOKUP_P_MACROBLOCK_TYPE: u32 = 284u;
const LOOKUP_P_MACROBLOCK_TYPE_BITS: u32 = 6u;
const LOOKUP_B_MACROBLOCK_TYPE: u32 = 348u;
const LOOKUP_B_MACROBLOCK_TYPE_BITS: u32 = 6u;
const LOOKUP_CODED_BLOCK_PATTERN: u32 = 412u;
const LOOKUP_CODED_BLOCK_PATTERN_BITS: u32 = 9u;
const LOOKUP_MOTION_CODE: u32 = 924u;
const LOOKUP_MOTION_CODE_BITS: u32 = 8u;
const LOOKUP_DC_SIZE_LUMINANCE: u32 = 1190u;
const LOOKUP_DC_SIZE_LUMINANCE_BITS: u32 = 9u;
const LOOKUP_DC_SIZE_CHROMINANCE: u32 = 1702u;
const LOOKUP_DC_SIZE_CHROMINANCE_BITS: u32 = 9u;
const LOOKUP_DCT_COEFFICIENTS_B14: u32 = 2216u;
const LOOKUP_DCT_COEFFICIENTS_B14_BITS: u32 = 9u;
const LOOKUP_DCT_COEFFICIENTS_B15: u32 = 2896u;
const LOOKUP_DCT_COEFFICIENTS_B15_BITS: u32 = 9u;
const TABLE_ZIGZAG_SCAN: u32 = 3570u;
const TABLE_ALTERNATE_SCAN: u32 = 3634u;
const TABLE_DEFAULT_INTRA_MATRIX: u32 = 3698u;
const TABLE_NON_LINEAR_QUANTIZER_SCALE: u32 = 3762u;
const LOOKUP_WORD_COUNT: u32 = 3794u;
const LOOKUP_WORDS = array<u32, 3794>(
    0x00080023u, 0x80030100u, 0x00000000u, 0x80030108u, 0x80030110u, 0x80020118u, 0x0008000Eu, 0x0008000Du,
    0x0008000Cu, 0x0008000Bu, 0x0008000Au, 0x00080009u, 0x00070008u, 0x00070008u, 0x00070007u, 0x00070007u,
    0x00050006u, 0x00050006u, 0x00050006u, 0x00050006u, 0x00050006u, 0x00050006u, 0x00050006u, 0x00050006u,
    0x00050005u, 0x00050005u, 0x00050005u, 0x00050005u, 0x00050005u, 0x00050005u, 0x00050005u, 0x00050005u,
    0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u,
    0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u,
    0x00040003u, 0x00040003u, 0x00040003u, 0x00040003u, 0x00040003u, 0x00040003u, 0x00040003u, 0x00040003u,
    0x00040003u, 0x00040003u, 0x00040003u, 0x00040003u, 0x00040003u, 0x00040003u, 0x00040003u, 0x00040003u,
    0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u,
    0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u,
    0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u,
    0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u,
    0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u,
    0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u,
    0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u,
    0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u, 0x00030001u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x000B0021u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x000B0022u,
    0x000B0020u, 0x000B001Fu, 0x000B001Eu, 0x000B001Du, 0x000B001Cu, 0x000B001Bu, 0x000B001Au, 0x000B0019u,
    0x000B0018u, 0x000B0017u, 0x000B0016u, 0x000B0015u, 0x000A0014u, 0x000A0014u, 0x000A0013u, 0x000A0013u,
    0x000A0012u, 0x000A0011u, 0x000A0010u, 0x000A000Fu, 0x00000000u, 0x00060003u, 0x00050036u, 0x00050036u,
    0x00050016u, 0x00050016u, 0x00050001u, 0x00050001u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u,
    0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00020034u, 0x00020034u, 0x00020034u, 0x00020034u,
    0x00020034u, 0x00020034u, 0x00020034u, 0x00020034u, 0x00020034u, 0x00020034u, 0x00020034u, 0x00020034u,
    0x00020034u, 0x00020034u, 0x00020034u, 0x00020034u, 0x00010014u, 0x00010014u, 0x00010014u, 0x00010014u,
    0x00010014u, 0x00010014u, 0x00010014u, 0x00010014u, 0x00010014u, 0x00010014u, 0x00010014u, 0x00010014u,
    0x00010014u, 0x00010014u, 0x00010014u, 0x00010014u, 0x00010014u, 0x00010014u, 0x00010014u, 0x00010014u,
    0x00010014u, 0x00010014u, 0x00010014u, 0x00010014u, 0x00010014u, 0x00010014u, 0x00010014u, 0x00010014u,
    0x00010014u, 0x00010014u, 0x00010014u, 0x00010014u, 0x00000000u, 0x00060003u, 0x0006001Au, 0x00060016u,
    0x0005001Eu, 0x0005001Eu, 0x00050001u, 0x00050001u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u,
    0x00040014u, 0x00040014u, 0x00040014u, 0x00040014u, 0x00030008u, 0x00030008u, 0x00030008u, 0x00030008u,
    0x00030008u, 0x00030008u, 0x00030008u, 0x00030008u, 0x00030018u, 0x00030018u, 0x00030018u, 0x00030018u,
    0x00030018u, 0x00030018u, 0x00030018u, 0x00030018u, 0x0002000Cu, 0x0002000Cu, 0x0002000Cu, 0x0002000Cu,
    0x0002000Cu, 0x0002000Cu, 0x0002000Cu, 0x0002000Cu, 0x0002000Cu, 0x0002000Cu, 0x0002000Cu, 0x0002000Cu,
    0x0002000Cu, 0x0002000Cu, 0x0002000Cu, 0x0002000Cu, 0x0002001Cu, 0x0002001Cu, 0x0002001Cu, 0x0002001Cu,
    0x0002001Cu, 0x0002001Cu, 0x0002001Cu, 0x0002001Cu, 0x0002001Cu, 0x0002001Cu, 0x0002001Cu, 0x0002001Cu,
    0x0002001Cu, 0x0002001Cu, 0x0002001Cu, 0x0002001Cu, 0x00000000u, 0x00090000u, 0x00090027u, 0x0009001Bu,
    0x0009003Bu, 0x00090037u, 0x0009002Fu, 0x0009001Fu, 0x0008003Au, 0x0008003Au, 0x00080036u, 0x00080036u,
    0x0008002Eu, 0x0008002Eu, 0x0008001Eu, 0x0008001Eu, 0x00080039u, 0x00080039u, 0x00080035u, 0x00080035u,
    0x0008002Du, 0x0008002Du, 0x0008001Du, 0x0008001Du, 0x00080026u, 0x00080026u, 0x0008001Au, 0x0008001Au,
    0x00080025u, 0x00080025u, 0x00080019u, 0x00080019u, 0x0008002Bu, 0x0008002Bu, 0x00080017u, 0x00080017u,
    0x00080033u, 0x00080033u, 0x0008000Fu, 0x0008000Fu, 0x0008002Au, 0x0008002Au, 0x00080016u, 0x00080016u,
    0x00080032u, 0x00080032u, 0x0008000Eu, 0x0008000Eu, 0x00080029u, 0x00080029u, 0x00080015u, 0x00080015u,
    0x00080031u, 0x00080031u, 0x0008000Du, 0x0008000Du, 0x00080023u, 0x00080023u, 0x00080013u, 0x00080013u,
    0x0008000Bu, 0x0008000Bu, 0x00080007u, 0x00080007u, 0x00070022u, 0x00070022u, 0x00070022u, 0x00070022u,
    0x00070012u, 0x00070012u, 0x00070012u, 0x00070012u, 0x0007000Au, 0x0007000Au, 0x0007000Au, 0x0007000Au,
    0x00070006u, 0x00070006u, 0x00070006u, 0x00070006u, 0x00070021u, 0x00070021u, 0x00070021u, 0x00070021u,
    0x00070011u, 0x00070011u, 0x00070011u, 0x00070011u, 0x00070009u, 0x00070009u, 0x00070009u, 0x00070009u,
    0x00070005u, 0x00070005u, 0x00070005u, 0x00070005u, 0x0006003Fu, 0x0006003Fu, 0x0006003Fu, 0x0006003Fu,
    0x0006003Fu, 0x0006003Fu, 0x0006003Fu, 0x0006003Fu, 0x00060003u, 0x00060003u, 0x00060003u, 0x00060003u,
    0x00060003u, 0x00060003u, 0x00060003u, 0x00060003u, 0x00060024u, 0x00060024u, 0x00060024u, 0x00060024u,
    0x00060024u, 0x00060024u, 0x00060024u, 0x00060024u, 0x00060018u, 0x00060018u, 0x00060018u, 0x00060018u,
    0x00060018u, 0x00060018u, 0x00060018u, 0x00060018u, 0x0005003Eu, 0x0005003Eu, 0x0005003Eu, 0x0005003Eu,
    0x0005003Eu, 0x0005003Eu, 0x0005003Eu, 0x0005003Eu, 0x0005003Eu, 0x0005003Eu, 0x0005003Eu, 0x0005003Eu,
    0x0005003Eu, 0x0005003Eu, 0x0005003Eu, 0x0005003Eu, 0x00050002u, 0x00050002u, 0x00050002u, 0x00050002u,
    0x00050002u, 0x00050002u, 0x00050002u, 0x00050002u, 0x00050002u, 0x00050002u, 0x00050002u, 0x00050002u,
    0x00050002u, 0x00050002u, 0x00050002u, 0x00050002u, 0x0005003Du, 0x0005003Du, 0x0005003Du, 0x0005003Du,
    0x0005003Du, 0x0005003Du, 0x0005003Du, 0x0005003Du, 0x0005003Du, 0x0005003Du, 0x0005003Du, 0x0005003Du,
    0x0005003Du, 0x0005003Du, 0x0005003Du, 0x0005003Du, 0x00050001u, 0x00050001u, 0x00050001u, 0x00050001u,
    0x00050001u, 0x00050001u, 0x00050001u, 0x00050001u, 0x00050001u, 0x00050001u, 0x00050001u, 0x00050001u,
    0x00050001u, 0x00050001u, 0x00050001u, 0x00050001u, 0x00050038u, 0x00050038u, 0x00050038u, 0x00050038u,
    0x00050038u, 0x00050038u, 0x00050038u, 0x00050038u, 0x00050038u, 0x00050038u, 0x00050038u, 0x00050038u,
    0x00050038u, 0x00050038u, 0x00050038u, 0x00050038u, 0x00050034u, 0x00050034u, 0x00050034u, 0x00050034u,
    0x00050034u, 0x00050034u, 0x00050034u, 0x00050034u, 0x00050034u, 0x00050034u, 0x00050034u, 0x00050034u,
    0x00050034u, 0x00050034u, 0x00050034u, 0x00050034u, 0x0005002Cu, 0x0005002Cu, 0x0005002Cu, 0x0005002Cu,
    0x0005002Cu, 0x0005002Cu, 0x0005002Cu, 0x0005002Cu, 0x0005002Cu, 0x0005002Cu, 0x0005002Cu, 0x0005002Cu,
    0x0005002Cu, 0x0005002Cu, 0x0005002Cu, 0x0005002Cu, 0x0005001Cu, 0x0005001Cu, 0x0005001Cu, 0x0005001Cu,
    0x0005001Cu, 0x0005001Cu, 0x0005001Cu, 0x0005001Cu, 0x0005001Cu, 0x0005001Cu, 0x0005001Cu, 0x0005001Cu,
    0x0005001Cu, 0x0005001Cu, 0x0005001Cu, 0x0005001Cu, 0x00050028u, 0x00050028u, 0x00050028u, 0x00050028u,
    0x00050028u, 0x00050028u, 0x00050028u, 0x00050028u, 0x00050028u, 0x00050028u, 0x00050028u, 0x00050028u,
    0x00050028u, 0x00050028u, 0x00050028u, 0x00050028u, 0x00050014u, 0x00050014u, 0x00050014u, 0x00050014u,
    0x00050014u, 0x00050014u, 0x00050014u, 0x00050014u, 0x00050014u, 0x00050014u, 0x00050014u, 0x00050014u,
    0x00050014u, 0x00050014u, 0x00050014u, 0x00050014u, 0x00050030u, 0x00050030u, 0x00050030u, 0x00050030u,
    0x00050030u, 0x00050030u, 0x00050030u, 0x00050030u, 0x00050030u, 0x00050030u, 0x00050030u, 0x00050030u,
    0x00050030u, 0x00050030u, 0x00050030u, 0x00050030u, 0x0005000Cu, 0x0005000Cu, 0x0005000Cu, 0x0005000Cu,
    0x0005000Cu, 0x0005000Cu, 0x0005000Cu, 0x0005000Cu, 0x0005000Cu, 0x0005000Cu, 0x0005000Cu, 0x0005000Cu,
    0x0005000Cu, 0x0005000Cu, 0x0005000Cu, 0x0005000Cu, 0x00040020u, 0x00040020u, 0x00040020u, 0x00040020u,
    0x00040020u, 0x00040020u, 0x00040020u, 0x00040020u, 0x00040020u, 0x00040020u, 0x00040020u, 0x00040020u,
    0x00040020u, 0x00040020u, 0x00040020u, 0x00040020u, 0x00040020u, 0x00040020u, 0x00040020u, 0x00040020u,
    0x00040020u, 0x00040020u, 0x00040020u, 0x00040020u, 0x00040020u, 0x00040020u, 0x00040020u, 0x00040020u,
    0x00040020u, 0x00040020u, 0x00040020u, 0x00040020u, 0x00040010u, 0x00040010u, 0x00040010u, 0x00040010u,
    0x00040010u, 0x00040010u, 0x00040010u, 0x00040010u, 0x00040010u, 0x00040010u, 0x00040010u, 0x00040010u,
    0x00040010u, 0x00040010u, 0x00040010u, 0x00040010u, 0x00040010u, 0x00040010u, 0x00040010u, 0x00040010u,
    0x00040010u, 0x00040010u, 0x00040010u, 0x00040010u, 0x00040010u, 0x00040010u, 0x00040010u, 0x00040010u,
    0x00040010u, 0x00040010u, 0x00040010u, 0x00040010u, 0x00040008u, 0x00040008u, 0x00040008u, 0x00040008u,
    0x00040008u, 0x00040008u, 0x00040008u, 0x00040008u, 0x00040008u, 0x00040008u, 0x00040008u, 0x00040008u,
    0x00040008u, 0x00040008u, 0x00040008u, 0x00040008u, 0x00040008u, 0x00040008u, 0x00040008u, 0x00040008u,
    0x00040008u, 0x00040008u, 0x00040008u, 0x00040008u, 0x00040008u, 0x00040008u, 0x00040008u, 0x00040008u,
    0x00040008u, 0x00040008u, 0x00040008u, 0x00040008u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u,
    0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u,
    0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u,
    0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u,
    0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu,
    0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu,
    0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu,
    0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu,
    0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu,
    0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu,
    0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu,
    0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu,
    0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x0003003Cu, 0x00000000u, 0x00000000u, 0x00000000u, 0x80020100u,
    0x80020104u, 0x80010108u, 0x00070007u, 0x00070007u, 0x00070006u, 0x00070006u, 0x00070005u, 0x00070005u,
    0x00060004u, 0x00060004u, 0x00060004u, 0x00060004u, 0x00040003u, 0x00040003u, 0x00040003u, 0x00040003u,
    0x00040003u, 0x00040003u, 0x00040003u, 0x00040003u, 0x00040003u, 0x00040003u, 0x00040003u, 0x00040003u,
    0x00040003u, 0x00040003u, 0x00040003u, 0x00040003u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u,
    0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u,
    0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u,
    0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u,
    0x00030002u, 0x00030002u, 0x00030002u, 0x00030002u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u,
    0x00010000u, 0x00010000u, 0x00010000u, 0x00010000u, 0x000A0010u, 0x000A000Fu, 0x000A000Eu, 0x000A000Du,
    0x000A000Cu, 0x000A000Bu, 0x0009000Au, 0x0009000Au, 0x00090009u, 0x00090008u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00030000u, 0x00030000u,
    0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u,
    0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u,
    0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u,
    0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u,
    0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u,
    0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u,
    0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u,
    0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030000u, 0x00030003u, 0x00030003u,
    0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u,
    0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u,
    0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u,
    0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u,
    0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u,
    0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u,
    0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u,
    0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030004u, 0x00030004u,
    0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u,
    0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u,
    0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u,
    0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u,
    0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u,
    0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u,
    0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u,
    0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00030004u, 0x00040005u, 0x00040005u,
    0x00040005u, 0x00040005u, 0x00040005u, 0x00040005u, 0x00040005u, 0x00040005u, 0x00040005u, 0x00040005u,
    0x00040005u, 0x00040005u, 0x00040005u, 0x00040005u, 0x00040005u, 0x00040005u, 0x00040005u, 0x00040005u,
    0x00040005u, 0x00040005u, 0x00040005u, 0x00040005u, 0x00040005u, 0x00040005u, 0x00040005u, 0x00040005u,
    0x00040005u, 0x00040005u, 0x00040005u, 0x00040005u, 0x00040005u, 0x00040005u, 0x00050006u, 0x00050006u,
    0x00050006u, 0x00050006u, 0x00050006u, 0x00050006u, 0x00050006u, 0x00050006u, 0x00050006u, 0x00050006u,
    0x00050006u, 0x00050006u, 0x00050006u, 0x00050006u, 0x00050006u, 0x00050006u, 0x00060007u, 0x00060007u,
    0x00060007u, 0x00060007u, 0x00060007u, 0x00060007u, 0x00060007u, 0x00060007u, 0x00070008u, 0x00070008u,
    0x00070008u, 0x00070008u, 0x00080009u, 0x00080009u, 0x0009000Au, 0x0009000Bu, 0x00020000u, 0x00020000u,
    0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u,
    0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u,
    0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u,
    0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u,
    0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u,
    0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u,
    0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u,
    0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u,
    0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u,
    0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u,
    0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u,
    0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u,
    0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u,
    0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u,
    0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u,
    0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020000u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u,
    0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020001u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u,
    0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00020002u, 0x00030003u, 0x00030003u,
    0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u,
    0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u,
    0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u,
    0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u,
    0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u,
    0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u,
    0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u,
    0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00030003u, 0x00040004u, 0x00040004u,
    0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u,
    0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u,
    0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u,
    0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00040004u, 0x00050005u, 0x00050005u,
    0x00050005u, 0x00050005u, 0x00050005u, 0x00050005u, 0x00050005u, 0x00050005u, 0x00050005u, 0x00050005u,
    0x00050005u, 0x00050005u, 0x00050005u, 0x00050005u, 0x00050005u, 0x00050005u, 0x00060006u, 0x00060006u,
    0x00060006u, 0x00060006u, 0x00060006u, 0x00060006u, 0x00060006u, 0x00060006u, 0x00070007u, 0x00070007u,
    0x00070007u, 0x00070007u, 0x00080008u, 0x00080008u, 0x00090009u, 0x80010200u, 0x000A000Au, 0x000A000Bu,
    0x80070200u, 0x80040280u, 0x80030290u, 0x80030298u, 0x800102A0u, 0x800102A2u, 0x800102A4u, 0x800102A6u,
    0x00060000u, 0x00060000u, 0x00060000u, 0x00060000u, 0x00060000u, 0x00060000u, 0x00060000u, 0x00060000u,
    0x00070103u, 0x00070103u, 0x00070103u, 0x00070103u, 0x0007008Au, 0x0007008Au, 0x0007008Au, 0x0007008Au,
    0x00070201u, 0x00070201u, 0x00070201u, 0x00070201u, 0x00070089u, 0x00070089u, 0x00070089u, 0x00070089u,
    0x00060088u, 0x00060088u, 0x00060088u, 0x00060088u, 0x00060088u, 0x00060088u, 0x00060088u, 0x00060088u,
    0x00060087u, 0x00060087u, 0x00060087u, 0x00060087u, 0x00060087u, 0x00060087u, 0x00060087u, 0x00060087u,
    0x00060102u, 0x00060102u, 0x00060102u, 0x00060102u, 0x00060102u, 0x00060102u, 0x00060102u, 0x00060102u,
    0x00060086u, 0x00060086u, 0x00060086u, 0x00060086u, 0x00060086u, 0x00060086u, 0x00060086u, 0x00060086u,
    0x0008008Eu, 0x0008008Eu, 0x00080301u, 0x00080301u, 0x0008008Du, 0x0008008Du, 0x0008008Cu, 0x0008008Cu,
    0x00080104u, 0x00080104u, 0x00080182u, 0x00080182u, 0x00080281u, 0x00080281u, 0x0008008Bu, 0x0008008Bu,
    0x00050181u, 0x00050181u, 0x00050181u, 0x00050181u, 0x00050181u, 0x00050181u, 0x00050181u, 0x00050181u,
    0x00050181u, 0x00050181u, 0x00050181u, 0x00050181u, 0x00050181u, 0x00050181u, 0x00050181u, 0x00050181u,
    0x00050085u, 0x00050085u, 0x00050085u, 0x00050085u, 0x00050085u, 0x00050085u, 0x00050085u, 0x00050085u,
    0x00050085u, 0x00050085u, 0x00050085u, 0x00050085u, 0x00050085u, 0x00050085u, 0x00050085u, 0x00050085u,
    0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u,
    0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u,
    0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u,
    0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u,
    0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u,
    0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u, 0x00040101u,
    0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u,
    0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u,
    0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u,
    0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u, 0x00040083u,
    0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u,
    0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u,
    0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u,
    0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u,
    0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u,
    0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u,
    0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u,
    0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u,
    0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u,
    0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u,
    0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u,
    0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u,
    0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u,
    0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u,
    0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u,
    0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u,
    0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u,
    0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u,
    0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u,
    0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u,
    0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u,
    0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u,
    0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u,
    0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u, 0x00023F80u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u,
    0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u,
    0x00100902u, 0x00100882u, 0x00100802u, 0x00100782u, 0x00100187u, 0x00100111u, 0x00100110u, 0x0010010Fu,
    0x0010010Eu, 0x0010010Du, 0x0010010Cu, 0x001000A0u, 0x0010009Fu, 0x0010009Eu, 0x0010009Du, 0x0010009Cu,
    0x000F1401u, 0x000F1401u, 0x000F1381u, 0x000F1381u, 0x000F1301u, 0x000F1301u, 0x000F1281u, 0x000F1281u,
    0x000F1201u, 0x000F1201u, 0x000F1181u, 0x000F1181u, 0x000F1101u, 0x000F1101u, 0x000F1081u, 0x000F1081u,
    0x000F1001u, 0x000F1001u, 0x000F0702u, 0x000F0702u, 0x000F0682u, 0x000F0682u, 0x000F0602u, 0x000F0602u,
    0x000F0582u, 0x000F0582u, 0x000F0502u, 0x000F0502u, 0x000F0482u, 0x000F0482u, 0x000F0402u, 0x000F0402u,
    0x000E0F81u, 0x000E0F81u, 0x000E0F81u, 0x000E0F81u, 0x000E0F01u, 0x000E0F01u, 0x000E0F01u, 0x000E0F01u,
    0x000E0E81u, 0x000E0E81u, 0x000E0E81u, 0x000E0E81u, 0x000E0E01u, 0x000E0E01u, 0x000E0E01u, 0x000E0E01u,
    0x000E0D81u, 0x000E0D81u, 0x000E0D81u, 0x000E0D81u, 0x000E0D01u, 0x000E0D01u, 0x000E0D01u, 0x000E0D01u,
    0x000E0C81u, 0x000E0C81u, 0x000E0C81u, 0x000E0C81u, 0x000E0C01u, 0x000E0C01u, 0x000E0C01u, 0x000E0C01u,
    0x000E0B81u, 0x000E0B81u, 0x000E0B81u, 0x000E0B81u, 0x000E0B01u, 0x000E0B01u, 0x000E0B01u, 0x000E0B01u,
    0x000E0A81u, 0x000E0A81u, 0x000E0A81u, 0x000E0A81u, 0x000E0A01u, 0x000E0A01u, 0x000E0A01u, 0x000E0A01u,
    0x000E0981u, 0x000E0981u, 0x000E0981u, 0x000E0981u, 0x000E0901u, 0x000E0901u, 0x000E0901u, 0x000E0901u,
    0x000E0881u, 0x000E0881u, 0x000E0881u, 0x000E0881u, 0x000E0801u, 0x000E0801u, 0x000E0801u, 0x000E0801u,
    0x000D010Bu, 0x000D010Au, 0x000D0186u, 0x000D0204u, 0x000D0283u, 0x000D0382u, 0x000D0302u, 0x000D0781u,
    0x000D0701u, 0x000D0681u, 0x000D0601u, 0x000D009Bu, 0x000D009Au, 0x000D0099u, 0x000D0098u, 0x000D0097u,
    0x000C0581u, 0x000C0109u, 0x000C0185u, 0x000C0501u, 0x000C0203u, 0x000C0108u, 0x000C0096u, 0x000C0095u,
    0x000C0481u, 0x000C0094u, 0x000C0093u, 0x000C0282u, 0x000C0184u, 0x000C0401u, 0x000C0107u, 0x000C0092u,
    0x000A0091u, 0x000A0106u, 0x000A0381u, 0x000A0183u, 0x000A0202u, 0x000A0090u, 0x000A008Fu, 0x000A0105u,
    0x80070200u, 0x80040280u, 0x80030290u, 0x80030298u, 0x00090106u, 0x0009008Fu, 0x800102A0u, 0x00090090u,
    0x00060000u, 0x00060000u, 0x00060000u, 0x00060000u, 0x00060000u, 0x00060000u, 0x00060000u, 0x00060000u,
    0x00070088u, 0x00070088u, 0x00070088u, 0x00070088u, 0x00070089u, 0x00070089u, 0x00070089u, 0x00070089u,
    0x00070087u, 0x00070087u, 0x00070087u, 0x00070087u, 0x00070103u, 0x00070103u, 0x00070103u, 0x00070103u,
    0x00060381u, 0x00060381u, 0x00060381u, 0x00060381u, 0x00060381u, 0x00060381u, 0x00060381u, 0x00060381u,
    0x00060301u, 0x00060301u, 0x00060301u, 0x00060301u, 0x00060301u, 0x00060301u, 0x00060301u, 0x00060301u,
    0x00060085u, 0x00060085u, 0x00060085u, 0x00060085u, 0x00060085u, 0x00060085u, 0x00060085u, 0x00060085u,
    0x00060086u, 0x00060086u, 0x00060086u, 0x00060086u, 0x00060086u, 0x00060086u, 0x00060086u, 0x00060086u,
    0x00080282u, 0x00080282u, 0x0008008Cu, 0x0008008Cu, 0x00080581u, 0x00080581u, 0x00080501u, 0x00080501u,
    0x0008008Eu, 0x0008008Eu, 0x0008008Du, 0x0008008Du, 0x00080104u, 0x00080104u, 0x00080202u, 0x00080202u,
    0x00050083u, 0x00050083u, 0x00050083u, 0x00050083u, 0x00050083u, 0x00050083u, 0x00050083u, 0x00050083u,
    0x00050083u, 0x00050083u, 0x00050083u, 0x00050083u, 0x00050083u, 0x00050083u, 0x00050083u, 0x00050083u,
    0x00050102u, 0x00050102u, 0x00050102u, 0x00050102u, 0x00050102u, 0x00050102u, 0x00050102u, 0x00050102u,
    0x00050102u, 0x00050102u, 0x00050102u, 0x00050102u, 0x00050102u, 0x00050102u, 0x00050102u, 0x00050102u,
    0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u,
    0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u, 0x00050084u,
    0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u,
    0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u,
    0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u,
    0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u,
    0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u,
    0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u,
    0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u,
    0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u, 0x00030082u,
    0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u,
    0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u,
    0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u,
    0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u, 0x00043F80u,
    0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u,
    0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u,
    0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u,
    0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u, 0x00040181u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u, 0x00020081u,
    0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u,
    0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u,
    0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u,
    0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u,
    0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u,
    0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u,
    0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u,
    0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u, 0x00030101u,
    0x00050201u, 0x00050201u, 0x00050201u, 0x00050201u, 0x00050201u, 0x00050201u, 0x00050201u, 0x00050201u,
    0x00050201u, 0x00050201u, 0x00050201u, 0x00050201u, 0x00050201u, 0x00050201u, 0x00050201u, 0x00050201u,
    0x00050281u, 0x00050281u, 0x00050281u, 0x00050281u, 0x00050281u, 0x00050281u, 0x00050281u, 0x00050281u,
    0x00050281u, 0x00050281u, 0x00050281u, 0x00050281u, 0x00050281u, 0x00050281u, 0x00050281u, 0x00050281u,
    0x0007008Au, 0x0007008Au, 0x0007008Au, 0x0007008Au, 0x00070182u, 0x00070182u, 0x00070182u, 0x00070182u,
    0x0007008Bu, 0x0007008Bu, 0x0007008Bu, 0x0007008Bu, 0x00070401u, 0x00070401u, 0x00070401u, 0x00070401u,
    0x00070481u, 0x00070481u, 0x00070481u, 0x00070481u, 0x00080601u, 0x00080601u, 0x00080681u, 0x00080681u,
    0x00080183u, 0x00080183u, 0x00080105u, 0x00080105u, 0x00080701u, 0x00080701u, 0x00080781u, 0x00080781u,
    0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u,
    0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u,
    0x00100902u, 0x00100882u, 0x00100802u, 0x00100782u, 0x00100187u, 0x00100111u, 0x00100110u, 0x0010010Fu,
    0x0010010Eu, 0x0010010Du, 0x0010010Cu, 0x001000A0u, 0x0010009Fu, 0x0010009Eu, 0x0010009Du, 0x0010009Cu,
    0x000F1401u, 0x000F1401u, 0x000F1381u, 0x000F1381u, 0x000F1301u, 0x000F1301u, 0x000F1281u, 0x000F1281u,
    0x000F1201u, 0x000F1201u, 0x000F1181u, 0x000F1181u, 0x000F1101u, 0x000F1101u, 0x000F1081u, 0x000F1081u,
    0x000F1001u, 0x000F1001u, 0x000F0702u, 0x000F0702u, 0x000F0682u, 0x000F0682u, 0x000F0602u, 0x000F0602u,
    0x000F0582u, 0x000F0582u, 0x000F0502u, 0x000F0502u, 0x000F0482u, 0x000F0482u, 0x000F0402u, 0x000F0402u,
    0x000E0F81u, 0x000E0F81u, 0x000E0F81u, 0x000E0F81u, 0x000E0F01u, 0x000E0F01u, 0x000E0F01u, 0x000E0F01u,
    0x000E0E81u, 0x000E0E81u, 0x000E0E81u, 0x000E0E81u, 0x000E0E01u, 0x000E0E01u, 0x000E0E01u, 0x000E0E01u,
    0x000E0D81u, 0x000E0D81u, 0x000E0D81u, 0x000E0D81u, 0x000E0D01u, 0x000E0D01u, 0x000E0D01u, 0x000E0D01u,
    0x000E0C81u, 0x000E0C81u, 0x000E0C81u, 0x000E0C81u, 0x000E0C01u, 0x000E0C01u, 0x000E0C01u, 0x000E0C01u,
    0x000E0B81u, 0x000E0B81u, 0x000E0B81u, 0x000E0B81u, 0x000E0B01u, 0x000E0B01u, 0x000E0B01u, 0x000E0B01u,
    0x000E0A81u, 0x000E0A81u, 0x000E0A81u, 0x000E0A81u, 0x000E0A01u, 0x000E0A01u, 0x000E0A01u, 0x000E0A01u,
    0x000E0981u, 0x000E0981u, 0x000E0981u, 0x000E0981u, 0x000E0901u, 0x000E0901u, 0x000E0901u, 0x000E0901u,
    0x000E0881u, 0x000E0881u, 0x000E0881u, 0x000E0881u, 0x000E0801u, 0x000E0801u, 0x000E0801u, 0x000E0801u,
    0x000D010Bu, 0x000D010Au, 0x000D0186u, 0x000D0204u, 0x000D0283u, 0x000D0382u, 0x000D0302u, 0x00000000u,
    0x00000000u, 0x00000000u, 0x00000000u, 0x000D009Bu, 0x000D009Au, 0x000D0099u, 0x000D0098u, 0x000D0097u,
    0x00000000u, 0x000C0109u, 0x000C0185u, 0x00000000u, 0x00000000u, 0x000C0108u, 0x000C0096u, 0x000C0095u,
    0x00000000u, 0x000C0094u, 0x000C0093u, 0x00000000u, 0x000C0184u, 0x00000000u, 0x000C0107u, 0x000C0092u,
    0x000A0203u, 0x000A0091u, 0x00000000u, 0x00000001u, 0x00000008u, 0x00000010u, 0x00000009u, 0x00000002u,
    0x00000003u, 0x0000000Au, 0x00000011u, 0x00000018u, 0x00000020u, 0x00000019u, 0x00000012u, 0x0000000Bu,
    0x00000004u, 0x00000005u, 0x0000000Cu, 0x00000013u, 0x0000001Au, 0x00000021u, 0x00000028u, 0x00000030u,
    0x00000029u, 0x00000022u, 0x0000001Bu, 0x00000014u, 0x0000000Du, 0x00000006u, 0x00000007u, 0x0000000Eu,
    0x00000015u, 0x0000001Cu, 0x00000023u, 0x0000002Au, 0x00000031u, 0x00000038u, 0x00000039u, 0x00000032u,
    0x0000002Bu, 0x00000024u, 0x0000001Du, 0x00000016u, 0x0000000Fu, 0x00000017u, 0x0000001Eu, 0x00000025u,
    0x0000002Cu, 0x00000033u, 0x0000003Au, 0x0000003Bu, 0x00000034u, 0x0000002Du, 0x00000026u, 0x0000001Fu,
    0x00000027u, 0x0000002Eu, 0x00000035u, 0x0000003Cu, 0x0000003Du, 0x00000036u, 0x0000002Fu, 0x00000037u,
    0x0000003Eu, 0x0000003Fu, 0x00000000u, 0x00000008u, 0x00000010u, 0x00000018u, 0x00000001u, 0x00000009u,
    0x00000002u, 0x0000000Au, 0x00000011u, 0x00000019u, 0x00000020u, 0x00000028u, 0x00000030u, 0x00000038u,
    0x00000039u, 0x00000031u, 0x00000029u, 0x00000021u, 0x0000001Au, 0x00000012u, 0x00000003u, 0x0000000Bu,
    0x00000004u, 0x0000000Cu, 0x00000013u, 0x0000001Bu, 0x00000022u, 0x0000002Au, 0x00000032u, 0x0000003Au,
    0x00000023u, 0x0000002Bu, 0x00000033u, 0x0000003Bu, 0x00000014u, 0x0000001Cu, 0x00000005u, 0x0000000Du,
    0x00000006u, 0x0000000Eu, 0x00000015u, 0x0000001Du, 0x00000024u, 0x0000002Cu, 0x00000034u, 0x0000003Cu,
    0x00000025u, 0x0000002Du, 0x00000035u, 0x0000003Du, 0x00000016u, 0x0000001Eu, 0x00000007u, 0x0000000Fu,
    0x00000017u, 0x0000001Fu, 0x00000026u, 0x0000002Eu, 0x00000036u, 0x0000003Eu, 0x00000027u, 0x0000002Fu,
    0x00000037u, 0x0000003Fu, 0x00000008u, 0x00000010u, 0x00000013u, 0x00000016u, 0x0000001Au, 0x0000001Bu,
    0x0000001Du, 0x00000022u, 0x00000010u, 0x00000010u, 0x00000016u, 0x00000018u, 0x0000001Bu, 0x0000001Du,
    0x00000022u, 0x00000025u, 0x00000013u, 0x00000016u, 0x0000001Au, 0x0000001Bu, 0x0000001Du, 0x00000022u,
    0x00000022u, 0x00000026u, 0x00000016u, 0x00000016u, 0x0000001Au, 0x0000001Bu, 0x0000001Du, 0x00000022u,
    0x00000025u, 0x00000028u, 0x00000016u, 0x0000001Au, 0x0000001Bu, 0x0000001Du, 0x00000020u, 0x00000023u,
    0x00000028u, 0x00000030u, 0x0000001Au, 0x0000001Bu, 0x0000001Du, 0x00000020u, 0x00000023u, 0x00000028u,
    0x00000030u, 0x0000003Au, 0x0000001Au, 0x0000001Bu, 0x0000001Du, 0x00000022u, 0x00000026u, 0x0000002Eu,
    0x00000038u, 0x00000045u, 0x0000001Bu, 0x0000001Du, 0x00000023u, 0x00000026u, 0x0000002Eu, 0x00000038u,
    0x00000045u, 0x00000053u, 0x00000000u, 0x00000001u, 0x00000002u, 0x00000003u, 0x00000004u, 0x00000005u,
    0x00000006u, 0x00000007u, 0x00000008u, 0x0000000Au, 0x0000000Cu, 0x0000000Eu, 0x00000010u, 0x00000012u,
    0x00000014u, 0x00000016u, 0x00000018u, 0x0000001Cu, 0x00000020u, 0x00000024u, 0x00000028u, 0x0000002Cu,
    0x00000030u, 0x00000034u, 0x00000038u, 0x00000040u, 0x00000048u, 0x00000050u, 0x00000058u, 0x00000060u,
    0x00000068u, 0x00000070u,
);

// Copies the lookups into pictureState; preparePacket marks them loaded only after this pass, so no invocation skips its word early
@compute @workgroup_size(64)
fn loadLookups(@builtin(global_invocation_id) invocation: vec3u) {
    if (pictureState[CONTEXT_LOOKUPS_LOADED] != 0u || invocation.x >= LOOKUP_WORD_COUNT) {
        return;
    }
    pictureState[LOOKUPS + invocation.x] = LOOKUP_WORDS[invocation.x];
}

// The start code scan: each invocation covers SCAN_BYTES_PER_INVOCATION bytes, a workgroup SCAN_BYTES_PER_WORKGROUP
const SCAN_WORKGROUP_SIZE: u32 = 256u;
const SCAN_BYTES_PER_INVOCATION: u32 = 16u;
const SCAN_BYTES_PER_WORKGROUP: u32 = 4096u;
// The scan workgroups each prefix invocation sums: MAXIMUM_SCAN_WORKGROUPS over SCAN_WORKGROUP_SIZE
const PREFIX_WORKGROUPS_PER_INVOCATION: u32 = 8u;
// The bytes a start code takes: 00 00 01 and its type
const START_CODE_BYTES: u32 = 4u;

@compute @workgroup_size(1)
fn preparePacket() {
    pictureState[CONTEXT_LOOKUPS_LOADED] = 1u;
    pictureState[PACKET_FAILED] = 0u;
    pictureState[PACKET_START_CODE_COUNT] = 0u;
    pictureState[PACKET_PICTURE_COUNT] = 0u;
    pictureState[PACKET_SLICE_COUNT] = 0u;
    pictureState[PACKET_CURRENT_PICTURE] = 0u;
    pictureState[PACKET_COPY_MODE] = COPY_NONE;
    pictureState[PACKET_RELEASE_COUNT] = 0u;
    pictureState[PACKET_MIRROR_SLOT] = 0u;
    let workgroups = (packet.byteLength + SCAN_BYTES_PER_WORKGROUP - 1u) / SCAN_BYTES_PER_WORKGROUP;
    pictureState[PACKET_SCAN_WORKGROUPS] = workgroups;
    setDispatchArguments(workgroups, 1u, 1u);
}

// Bit k set when the bytes from offset k of word, followed by next, begin 00 00 01
fn startCodesInWord(word: u32, next: u32) -> u32 {
    var mask = 0u;
    if ((word >> 8u) == 1u) {
        mask |= 1u;
    }
    if ((((word << 8u) | (next >> 24u)) >> 8u) == 1u) {
        mask |= 2u;
    }
    if ((((word << 16u) | (next >> 16u)) >> 8u) == 1u) {
        mask |= 4u;
    }
    if ((((word << 24u) | (next >> 8u)) >> 8u) == 1u) {
        mask |= 8u;
    }
    return mask;
}

// Bit k set when a start code begins at firstByte + k, a multiple of 16; its type byte must lie inside the packet, as FFmpeg finds them
fn startCodeMask(firstByte: u32) -> u32 {
    let firstWord = firstByte >> 2u;
    let word0 = packetBigEndianWord(firstWord);
    let word1 = packetBigEndianWord(firstWord + 1u);
    let word2 = packetBigEndianWord(firstWord + 2u);
    let word3 = packetBigEndianWord(firstWord + 3u);
    let word4 = packetBigEndianWord(firstWord + 4u);
    var mask = startCodesInWord(word0, word1) | (startCodesInWord(word1, word2) << 4u)
        | (startCodesInWord(word2, word3) << 8u) | (startCodesInWord(word3, word4) << 12u);
    let length = packet.byteLength;
    if (firstByte + SCAN_BYTES_PER_INVOCATION + START_CODE_BYTES - 1u > length) {
        for (var offset = 0u; offset < SCAN_BYTES_PER_INVOCATION; offset += 1u) {
            if (firstByte + offset + START_CODE_BYTES > length) {
                mask &= ~(1u << offset);
            }
        }
    }
    return mask;
}

var<workgroup> scanTotal: atomic<u32>;

// Counts each scan workgroup's start codes
@compute @workgroup_size(SCAN_WORKGROUP_SIZE)
fn countStartCodes(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    let firstByte = (workgroupId.x * SCAN_WORKGROUP_SIZE + localIndex) * SCAN_BYTES_PER_INVOCATION;
    var count = 0u;
    if (firstByte < packet.byteLength) {
        count = countOneBits(startCodeMask(firstByte));
    }
    if (count != 0u) {
        atomicAdd(&scanTotal, count);
    }
    workgroupBarrier();
    if (localIndex == 0u) {
        pictureState[BLOCK_COUNTS + workgroupId.x] = atomicLoad(&scanTotal);
    }
}

var<workgroup> prefixTotals: array<u32, SCAN_WORKGROUP_SIZE>;

// The start codes before each scan workgroup, an exclusive prefix sum in one workgroup, and the packet's start code count
@compute @workgroup_size(SCAN_WORKGROUP_SIZE)
fn prefixStartCodes(@builtin(local_invocation_index) localIndex: u32) {
    let workgroups = min(pictureState[PACKET_SCAN_WORKGROUPS], MAXIMUM_SCAN_WORKGROUPS);
    let first = min(localIndex * PREFIX_WORKGROUPS_PER_INVOCATION, workgroups);
    let last = min(first + PREFIX_WORKGROUPS_PER_INVOCATION, workgroups);
    var sum = 0u;
    for (var group = first; group < last; group += 1u) {
        sum += pictureState[BLOCK_COUNTS + group];
    }
    prefixTotals[localIndex] = sum;
    workgroupBarrier();
    var before = 0u;
    for (var other = 0u; other < localIndex; other += 1u) {
        before += prefixTotals[other];
    }
    for (var group = first; group < last; group += 1u) {
        pictureState[BLOCK_OFFSETS + group] = before;
        before += pictureState[BLOCK_COUNTS + group];
    }
    if (localIndex == SCAN_WORKGROUP_SIZE - 1u) {
        pictureState[PACKET_START_CODE_COUNT] = before;
        if (before > MAXIMUM_START_CODES) {
            reportFailure(ERROR_START_CODES, before);
        }
    }
}

var<workgroup> listCounts: array<u32, SCAN_WORKGROUP_SIZE>;

// Writes each start code's position at its place in packet order
@compute @workgroup_size(SCAN_WORKGROUP_SIZE)
fn listStartCodes(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    let firstByte = (workgroupId.x * SCAN_WORKGROUP_SIZE + localIndex) * SCAN_BYTES_PER_INVOCATION;
    var mask = 0u;
    if (firstByte < packet.byteLength) {
        mask = startCodeMask(firstByte);
    }
    listCounts[localIndex] = countOneBits(mask);
    workgroupBarrier();
    if (mask == 0u) {
        return;
    }
    var position = pictureState[BLOCK_OFFSETS + workgroupId.x];
    for (var other = 0u; other < localIndex; other += 1u) {
        position += listCounts[other];
    }
    while (mask != 0u) {
        let offset = firstTrailingBit(mask);
        if (position < MAXIMUM_START_CODES) {
            pictureState[START_CODES + position] = firstByte + offset;
        }
        position += 1u;
        mask &= mask - 1u;
    }
}

// The header stage: one invocation walks the packet's start codes as FFmpeg's decode_chunks does, after the codec private data
// the first packet of a session; it updates the session context, decides each picture's references, and builds the slice table.
// Its reader reads the codec private data or the packet, a byte at a time, since headers are few and short
var<private> headerSource: u32;
var<private> headerBit: u32;
var<private> headerByteLength: u32;
var<private> headerFailed: bool;
// decode_chunks' state: the last start code kind, whether a picture start code was seen, and s->pict_type
var<private> lastCode: u32;
var<private> pictureStartCodeSeen: bool;
var<private> currentPictureType: u32;
var<private> pictureCount: u32;
var<private> sliceCount: u32;
// The frame this packet decodes: whether one started, whether it is an anchor, and its first decoded picture's structure
var<private> frameStarted: bool;
var<private> frameAnchor: bool;
var<private> frameFirstStructure: u32;
// Whether the packet's last decoded picture was a first field that no second field followed, and which picture
var<private> openFirstField: bool;
var<private> openFirstFieldStructure: u32;
var<private> openFirstFieldPicture: u32;
// The picture fields word of the frame this packet started
var<private> frameFieldsWord: u32;

// Ends the header stage on a fatal or resync failure
fn failHeader(code: u32, value: u32) {
    if (!headerFailed) {
        reportFailure(code, value);
    }
    headerFailed = true;
}

fn headerByte(index: u32) -> u32 {
    if (index >= headerByteLength) {
        return 0u;
    }
    if (headerSource == SOURCE_CONFIGURATION) {
        return readConfigByte(index);
    }
    return readPacketByte(index);
}

// count bits, 1 to 24, from the header reader's position, zero past the end as FFmpeg's padding reads
fn peekHeaderBits(count: u32) -> u32 {
    let byteIndex = headerBit >> 3u;
    let window = (headerByte(byteIndex) << 24u) | (headerByte(byteIndex + 1u) << 16u)
        | (headerByte(byteIndex + 2u) << 8u) | headerByte(byteIndex + 3u);
    return (window << (headerBit & 7u)) >> (32u - count);
}

fn readHeaderBits(count: u32) -> u32 {
    let value = peekHeaderBits(count);
    headerBit += count;
    return value;
}

fn readHeaderFlag() -> bool {
    return readHeaderBits(1u) != 0u;
}

fn codingField(field: u32) -> u32 {
    return pictureState[CONTEXT_PICTURE_FIELDS + field];
}

fn setCodingField(field: u32, value: u32) {
    pictureState[CONTEXT_PICTURE_FIELDS + field] = value;
}

fn addRelease(slot: u32) {
    let count = pictureState[PACKET_RELEASE_COUNT];
    if (count < MAXIMUM_RELEASES) {
        pictureState[PACKET_RELEASES + count] = slot;
        pictureState[PACKET_RELEASE_COUNT] = count + 1u;
    }
}

// FFmpeg's load_matrix: 64 values in zigzag order into the luma matrix when lumaMatrix is set, and the chroma matrix;
// an intra matrix's DC weight is always 8. A zero value is damage: the load stops there, keeping the values before it,
// and the header reads on after the zero, as FFmpeg ignores load_matrix's failure
fn loadMatrix(lumaMatrix: u32, chromaMatrix: u32, loadLuma: bool, intra: bool) {
    for (var index = 0u; index < COEFFICIENTS_PER_BLOCK; index += 1u) {
        let position = lookupWord(TABLE_ZIGZAG_SCAN + index);
        var value = readHeaderBits(8u);
        if (value == 0u) {
            reportConcealment(ERROR_QUANTIZER_MATRIX, index);
            return;
        }
        if (intra && index == 0u && value != 8u) {
            value = 8u;
        }
        pictureState[CONTEXT_MATRICES + chromaMatrix + position] = value;
        if (loadLuma) {
            pictureState[CONTEXT_MATRICES + lumaMatrix + position] = value;
        }
    }
}

// FFmpeg's mpeg1_decode_sequence. A damaged header is ignored as FFmpeg ignores it: a missing marker before the matrices
// leaves everything as it was, and a nonzero tail after them keeps the matrices it loaded but not its size or MPEG-1 parameters
fn parseSequenceHeader() {
    let width = readHeaderBits(12u);
    let height = readHeaderBits(12u);
    // aspect_ratio_information, frame_rate_code, and bit_rate_value
    readHeaderBits(4u);
    readHeaderBits(4u);
    readHeaderBits(18u);
    if (!readHeaderFlag()) {
        reportConcealment(ERROR_SEQUENCE_HEADER, headerBit >> 3u);
        return;
    }
    // vbv_buffer_size_value and constrained_parameters_flag
    readHeaderBits(10u);
    readHeaderBits(1u);
    if (readHeaderFlag()) {
        loadMatrix(MATRIX_INTRA, MATRIX_CHROMA_INTRA, true, true);
    } else {
        for (var position = 0u; position < COEFFICIENTS_PER_BLOCK; position += 1u) {
            let value = lookupWord(TABLE_DEFAULT_INTRA_MATRIX + position);
            pictureState[CONTEXT_MATRICES + MATRIX_INTRA + position] = value;
            pictureState[CONTEXT_MATRICES + MATRIX_CHROMA_INTRA + position] = value;
        }
    }
    if (readHeaderFlag()) {
        loadMatrix(MATRIX_NON_INTRA, MATRIX_CHROMA_NON_INTRA, true, false);
    } else {
        for (var position = 0u; position < COEFFICIENTS_PER_BLOCK; position += 1u) {
            pictureState[CONTEXT_MATRICES + MATRIX_NON_INTRA + position] = DEFAULT_NON_INTRA_WEIGHT;
            pictureState[CONTEXT_MATRICES + MATRIX_CHROMA_NON_INTRA + position] = DEFAULT_NON_INTRA_WEIGHT;
        }
    }
    // What follows the header up to the next start code must be zero
    let tail = peekHeaderBits(SEQUENCE_HEADER_TAIL_BITS);
    if (tail != 0u) {
        reportConcealment(ERROR_SEQUENCE_HEADER, tail);
        return;
    }
    pictureState[CONTEXT_SEQUENCE_WIDTH] = width;
    pictureState[CONTEXT_SEQUENCE_HEIGHT] = height;
    // The MPEG-2 parameters that emulate MPEG-1 until a sequence extension follows
    pictureState[CONTEXT_MPEG2] = 0u;
    pictureState[CONTEXT_PROGRESSIVE_SEQUENCE] = 1u;
    pictureState[CONTEXT_CHROMA_FORMAT] = CHROMA_420;
    setCodingField(CODING_PROGRESSIVE_FRAME, 1u);
    setCodingField(CODING_PICTURE_STRUCTURE, STRUCTURE_FRAME);
    setCodingField(CODING_FRAME_PRED_FRAME_DCT, 1u);
    state[STATE_FIRST_FIELD] = 0u;
}

// The non-intra weight of the default matrix
const DEFAULT_NON_INTRA_WEIGHT: u32 = 16u;
// The bits after a sequence header that FFmpeg requires to be zero
const SEQUENCE_HEADER_TAIL_BITS: u32 = 23u;

// FFmpeg's mpeg_decode_sequence_extension
fn parseSequenceExtension() {
    // profile_and_level_indication's escape bit, then profile and level
    readHeaderBits(1u);
    let profile = readHeaderBits(3u);
    let level = readHeaderBits(4u);
    let progressiveSequence = readHeaderBits(1u);
    var chromaFormat = readHeaderBits(2u);
    if (chromaFormat == 0u) {
        chromaFormat = CHROMA_420;
    }
    let horizontalExtension = readHeaderBits(2u);
    let verticalExtension = readHeaderBits(2u);
    // bit_rate_extension, marker_bit, and vbv_buffer_size_extension
    readHeaderBits(12u);
    readHeaderBits(1u);
    readHeaderBits(8u);
    let lowDelay = readHeaderBits(1u);
    pictureState[CONTEXT_PROFILE] = profile;
    pictureState[CONTEXT_LEVEL] = level;
    pictureState[CONTEXT_PROGRESSIVE_SEQUENCE] = progressiveSequence;
    pictureState[CONTEXT_CHROMA_FORMAT] = chromaFormat;
    pictureState[CONTEXT_SEQUENCE_WIDTH] |= horizontalExtension << SIZE_EXTENSION_SHIFT;
    pictureState[CONTEXT_SEQUENCE_HEIGHT] |= verticalExtension << SIZE_EXTENSION_SHIFT;
    pictureState[CONTEXT_LOW_DELAY] = lowDelay;
    pictureState[CONTEXT_MPEG2] = 1u;
}

// Where horizontal_size_extension and vertical_size_extension go
const SIZE_EXTENSION_SHIFT: u32 = 12u;

// FFmpeg's mpeg_decode_quant_matrix_extension
fn parseQuantMatrixExtension() {
    if (readHeaderFlag()) {
        loadMatrix(MATRIX_INTRA, MATRIX_CHROMA_INTRA, true, true);
    }
    if (readHeaderFlag()) {
        loadMatrix(MATRIX_NON_INTRA, MATRIX_CHROMA_NON_INTRA, true, false);
    }
    if (readHeaderFlag()) {
        loadMatrix(MATRIX_INTRA, MATRIX_CHROMA_INTRA, false, true);
    }
    if (readHeaderFlag()) {
        loadMatrix(MATRIX_NON_INTRA, MATRIX_CHROMA_NON_INTRA, false, false);
    }
}

// The f_code a picture without motion in a direction carries, by which FFmpeg guesses a damaged picture header's type
const UNUSED_F_CODE: u32 = 15u;

// mpeg_decode_picture_coding_extension's guess for a picture whose header carried no valid type: an I picture codes no f_code,
// a P picture only the forward ones
fn guessPictureType() {
    if (currentPictureType != PICTURE_TYPE_NONE || pictureState[CONTEXT_INITIALIZED] == 0u) {
        return;
    }
    let forwardUnused = codingField(CODING_F_CODE_FORWARD_X) == UNUSED_F_CODE && codingField(CODING_F_CODE_FORWARD_Y) == UNUSED_F_CODE;
    let backwardUnused = codingField(CODING_F_CODE_BACKWARD_X) == UNUSED_F_CODE && codingField(CODING_F_CODE_BACKWARD_Y) == UNUSED_F_CODE;
    currentPictureType = PICTURE_TYPE_B;
    if (backwardUnused) {
        currentPictureType = select(PICTURE_TYPE_P, PICTURE_TYPE_I, forwardUnused);
    }
    pictureState[pictureBase(pictureCount - 1u) + PICTURE_TYPE] = currentPictureType;
}

// FFmpeg's mpeg_decode_picture_coding_extension
fn parsePictureCodingExtension() {
    for (var field = CODING_F_CODE_FORWARD_X; field <= CODING_F_CODE_BACKWARD_Y; field += 1u) {
        setCodingField(field, max(readHeaderBits(4u), 1u));
    }
    setCodingField(CODING_FULL_PEL_FORWARD, 0u);
    setCodingField(CODING_FULL_PEL_BACKWARD, 0u);
    setCodingField(CODING_INTRA_DC_PRECISION, readHeaderBits(2u));
    setCodingField(CODING_PICTURE_STRUCTURE, readHeaderBits(2u));
    setCodingField(CODING_TOP_FIELD_FIRST, readHeaderBits(1u));
    setCodingField(CODING_FRAME_PRED_FRAME_DCT, readHeaderBits(1u));
    setCodingField(CODING_CONCEALMENT_MOTION_VECTORS, readHeaderBits(1u));
    setCodingField(CODING_Q_SCALE_TYPE, readHeaderBits(1u));
    setCodingField(CODING_INTRA_VLC_FORMAT, readHeaderBits(1u));
    setCodingField(CODING_ALTERNATE_SCAN, readHeaderBits(1u));
    setCodingField(CODING_REPEAT_FIRST_FIELD, readHeaderBits(1u));
    setCodingField(CODING_CHROMA_420_TYPE, readHeaderBits(1u));
    setCodingField(CODING_PROGRESSIVE_FRAME, readHeaderBits(1u));
}

// The bits of a GOP header's time_code, read in two parts since the reader takes at most 24
const TIME_CODE_HIGH_BITS: u32 = 13u;
const TIME_CODE_LOW_BITS: u32 = 12u;

// FFmpeg's mpeg_decode_gop
fn parseGroupOfPictures() {
    state[STATE_FIRST_FIELD] = 0u;
    readHeaderBits(TIME_CODE_HIGH_BITS);
    readHeaderBits(TIME_CODE_LOW_BITS);
    state[STATE_CLOSED_GOP] = readHeaderBits(1u);
    // broken_link
    readHeaderBits(1u);
    state[STATE_SYNC] = 1u;
}

// FFmpeg's mpeg_decode_postinit: the frame geometry, set on the first picture and again when the sequence changes it.
// The pool and the reported visible rectangle keep their first size, so a size change fails; a new geometry drops the references
fn initializeGeometry() {
    let width = pictureState[CONTEXT_SEQUENCE_WIDTH];
    let height = pictureState[CONTEXT_SEQUENCE_HEIGHT];
    let progressiveSequence = pictureState[CONTEXT_PROGRESSIVE_SEQUENCE];
    let chromaFormat = pictureState[CONTEXT_CHROMA_FORMAT];
    let initialized = pictureState[CONTEXT_INITIALIZED] != 0u;
    let heightAlignmentDiffers = ((height + 15u) & ~15u) != ((height + 31u) & ~31u);
    if (initialized && width == pictureState[CONTEXT_INITIALIZED_WIDTH] && height == pictureState[CONTEXT_INITIALIZED_HEIGHT]
        && chromaFormat == pictureState[CONTEXT_INITIALIZED_CHROMA_FORMAT]
        && !(progressiveSequence != pictureState[CONTEXT_INITIALIZED_PROGRESSIVE_SEQUENCE] && heightAlignmentDiffers)) {
        return;
    }
    if (initialized && (width != pictureState[CONTEXT_INITIALIZED_WIDTH] || height != pictureState[CONTEXT_INITIALIZED_HEIGHT])) {
        failHeader(ERROR_PICTURE_SIZE, (width << 12u) | (height & 0xFFFu));
        return;
    }
    if (chromaFormat != OUTPUT_CHROMA_FORMAT) {
        failHeader(ERROR_CHROMA_FORMAT, chromaFormat);
        return;
    }
    let macroblockWidth = (width + 15u) / 16u;
    var macroblockHeight = (height + 15u) / 16u;
    if (pictureState[CONTEXT_MPEG2] != 0u && progressiveSequence == 0u) {
        macroblockHeight = (height + 31u) / 32u * 2u;
    }
    if (macroblockWidth * 16u > stream.width || macroblockHeight * 16u > stream.height) {
        failHeader(ERROR_PICTURE_SIZE, (width << 12u) | (height & 0xFFFu));
        return;
    }
    if (initialized) {
        dropReferences();
    }
    pictureState[CONTEXT_INITIALIZED] = 1u;
    pictureState[CONTEXT_INITIALIZED_WIDTH] = width;
    pictureState[CONTEXT_INITIALIZED_HEIGHT] = height;
    pictureState[CONTEXT_INITIALIZED_PROGRESSIVE_SEQUENCE] = progressiveSequence;
    pictureState[CONTEXT_INITIALIZED_CHROMA_FORMAT] = chromaFormat;
    pictureState[CONTEXT_MACROBLOCK_WIDTH] = macroblockWidth;
    pictureState[CONTEXT_MACROBLOCK_HEIGHT] = macroblockHeight;
}

// Releases the anchors, as ff_mpv_common_end drops FFmpeg's pictures
fn dropReferences() {
    let lastSlot = state[STATE_LAST_SLOT];
    let nextSlot = state[STATE_NEXT_SLOT];
    let pendingSlot = state[STATE_PENDING_SLOT];
    state[STATE_LAST_SLOT] = 0u;
    state[STATE_NEXT_SLOT] = 0u;
    state[STATE_PENDING_SLOT] = 0u;
    if (lastSlot != 0u && lastSlot != DUMMY_REFERENCE) {
        addRelease(lastSlot - 1u);
    }
    if (nextSlot != 0u && nextSlot != DUMMY_REFERENCE) {
        addRelease(nextSlot - 1u);
    }
    if (pendingSlot != 0u) {
        addRelease(pendingSlot - 1u);
    }
}

// A picture start code, as decode_chunks handles PICTURE_START_CODE: the geometry, then FFmpeg's mpeg1_decode_picture
fn handlePictureStartCode() {
    if (pictureStartCodeSeen && codingField(CODING_PICTURE_STRUCTURE) == STRUCTURE_FRAME) {
        // FFmpeg ignores a picture header after a frame picture, and the slices after it decode into that frame
        return;
    }
    pictureStartCodeSeen = true;
    if (pictureState[CONTEXT_SEQUENCE_WIDTH] == 0u || pictureState[CONTEXT_SEQUENCE_HEIGHT] == 0u) {
        // No sequence header gave a size yet; FFmpeg decodes nothing until one does
        failHeader(ERROR_FRAME_DIMENSIONS, (pictureState[CONTEXT_SEQUENCE_WIDTH] << 12u) | (pictureState[CONTEXT_SEQUENCE_HEIGHT] & 0xFFFu));
        return;
    }
    if (lastCode != LAST_CODE_NONE && lastCode != LAST_CODE_SLICE) {
        return;
    }
    initializeGeometry();
    if (headerFailed) {
        return;
    }
    // temporal_reference
    readHeaderBits(10u);
    // A type FFmpeg decodes no picture of, MPEG-1's D pictures among them, leaves the picture without one, as FFmpeg's pict_type 0:
    // an MPEG-2 picture coding extension guesses it, and slices of a picture without one are skipped
    let codingType = readHeaderBits(3u);
    currentPictureType = codingType;
    if (codingType < PICTURE_TYPE_I || codingType > PICTURE_TYPE_B) {
        reportConcealment(ERROR_PICTURE_HEADER, codingType);
        currentPictureType = PICTURE_TYPE_NONE;
    } else {
        // vbv_delay
        readHeaderBits(16u);
    }
    if (currentPictureType == PICTURE_TYPE_P || currentPictureType == PICTURE_TYPE_B) {
        setCodingField(CODING_FULL_PEL_FORWARD, readHeaderBits(1u));
        let forwardCode = max(readHeaderBits(3u), 1u);
        setCodingField(CODING_F_CODE_FORWARD_X, forwardCode);
        setCodingField(CODING_F_CODE_FORWARD_Y, forwardCode);
    }
    if (currentPictureType == PICTURE_TYPE_B) {
        setCodingField(CODING_FULL_PEL_BACKWARD, readHeaderBits(1u));
        let backwardCode = max(readHeaderBits(3u), 1u);
        setCodingField(CODING_F_CODE_BACKWARD_X, backwardCode);
        setCodingField(CODING_F_CODE_BACKWARD_Y, backwardCode);
    }
    if (pictureCount >= MAXIMUM_PICTURES) {
        failHeader(ERROR_PICTURE_COUNT, pictureCount + 1u);
        return;
    }
    let picture = pictureBase(pictureCount);
    pictureState[picture + PICTURE_DECODED] = 0u;
    pictureState[picture + PICTURE_STARTED] = 0u;
    pictureState[picture + PICTURE_TYPE] = currentPictureType;
    pictureState[picture + PICTURE_MPEG2] = pictureState[CONTEXT_MPEG2];
    pictureState[picture + PICTURE_CONCEALED] = 0u;
    pictureState[picture + PICTURE_CONCEAL_INTRA] = 0u;
    pictureState[picture + PICTURE_FIRST_SLICE] = sliceCount;
    pictureState[picture + PICTURE_SLICE_COUNT] = 0u;
    pictureCount += 1u;
    lastCode = LAST_CODE_PICTURE;
}

fn handleExtension() {
    let identifier = readHeaderBits(4u);
    switch (identifier) {
        case SEQUENCE_EXTENSION_ID: {
            if (lastCode == LAST_CODE_NONE) {
                parseSequenceExtension();
            }
        }
        case QUANT_MATRIX_EXTENSION_ID: {
            parseQuantMatrixExtension();
        }
        case PICTURE_CODING_EXTENSION_ID: {
            if (lastCode == LAST_CODE_PICTURE) {
                parsePictureCodingExtension();
                guessPictureType();
            }
        }
        default: {
        }
    }
}

// The first slice after a picture header: FFmpeg's fixups of the picture structure and its first_field toggle
fn beginPictureSlices() {
    if (pictureState[CONTEXT_PROGRESSIVE_SEQUENCE] != 0u && codingField(CODING_PROGRESSIVE_FRAME) == 0u) {
        setCodingField(CODING_PROGRESSIVE_FRAME, 1u);
    }
    let structure = codingField(CODING_PICTURE_STRUCTURE);
    if (structure == 0u || (codingField(CODING_PROGRESSIVE_FRAME) != 0u && structure != STRUCTURE_FRAME)) {
        setCodingField(CODING_PICTURE_STRUCTURE, STRUCTURE_FRAME);
    }
    if (codingField(CODING_PICTURE_STRUCTURE) == STRUCTURE_FRAME) {
        state[STATE_FIRST_FIELD] = 0u;
    } else {
        state[STATE_FIRST_FIELD] ^= 1u;
    }
}

// FFmpeg's buffer size check of mpeg_field_start: a packet this short cannot hold the picture's macroblocks
const MINIMUM_PICTURE_BITS_NUMERATOR: u32 = 11u;
const MINIMUM_PICTURE_BITS_DENOMINATOR: u32 = 528u;

// FFmpeg's flags of a frame starting with a picture of this structure, as the picture fields word: ff_mpv_frame_start's interlaced and
// top field first, which mpeg_field_start also sets for a field pair whose first field is the top one, and its repeat_pict
fn createFrameFieldsWord(structure: u32) -> u32 {
    let progressiveSequence = pictureState[CONTEXT_PROGRESSIVE_SEQUENCE] != 0u;
    let progressiveFrame = codingField(CODING_PROGRESSIVE_FRAME) != 0u;
    let interlaced = !progressiveFrame && !progressiveSequence;
    let topFieldFirst = codingField(CODING_TOP_FIELD_FIRST) != 0u || structure == STRUCTURE_TOP_FIELD;
    let repeatFirstField = codingField(CODING_REPEAT_FIRST_FIELD) != 0u && (progressiveSequence || progressiveFrame);
    return PICTURE_FIELDS_REPORTED_BIT | select(0u, PICTURE_FIELDS_INTERLACED_BIT, interlaced)
        | select(0u, PICTURE_FIELDS_TOP_FIELD_FIRST_BIT, topFieldFirst) | select(0u, PICTURE_FIELDS_REPEAT_FIRST_FIELD_BIT, repeatFirstField);
}

fn reportFrameFields(word: u32) {
    reportPictureFields((word & PICTURE_FIELDS_INTERLACED_BIT) != 0u, (word & PICTURE_FIELDS_TOP_FIELD_FIRST_BIT) != 0u,
        (word & PICTURE_FIELDS_REPEAT_FIRST_FIELD_BIT) != 0u);
}

// A picture's first slice: whether FFmpeg decodes the picture, then mpeg_field_start: its frame, its references, and its parameters
fn startPicture(pictureIndex: u32) {
    let picture = pictureBase(pictureIndex);
    pictureState[picture + PICTURE_STARTED] = 1u;
    let pictureType = pictureState[picture + PICTURE_TYPE];
    if (state[STATE_LAST_SLOT] == 0u && pictureType == PICTURE_TYPE_B && state[STATE_CLOSED_GOP] == 0u) {
        return;
    }
    if (pictureType == PICTURE_TYPE_I) {
        state[STATE_SYNC] = 1u;
    }
    if (state[STATE_NEXT_SLOT] == 0u && pictureType == PICTURE_TYPE_P && state[STATE_SYNC] == 0u) {
        return;
    }
    if (pictureState[CONTEXT_INITIALIZED] == 0u) {
        return;
    }
    // A picture whose header carried no type and no coding extension guessed one: FFmpeg skips its slices
    if (pictureType == PICTURE_TYPE_NONE) {
        return;
    }
    let macroblockWidth = pictureState[CONTEXT_MACROBLOCK_WIDTH];
    let macroblockHeight = pictureState[CONTEXT_MACROBLOCK_HEIGHT];
    if (macroblockWidth * macroblockHeight * MINIMUM_PICTURE_BITS_NUMERATOR / MINIMUM_PICTURE_BITS_DENOMINATOR > packet.byteLength) {
        // FFmpeg abandons the packet: the picture never starts, so the packet shows the latest anchor as one FFmpeg decodes nothing for
        reportConcealment(ERROR_PACKET_SIZE, packet.byteLength);
        return;
    }
    let structure = codingField(CODING_PICTURE_STRUCTURE);
    let firstField = state[STATE_FIRST_FIELD];
    let outputSlot = packet.outputSlot + 1u;
    if (firstField != 0u || structure == STRUCTURE_FRAME) {
        if (frameStarted) {
            failHeader(ERROR_PICTURE_COUNT, pictureIndex + 1u);
            return;
        }
        frameStarted = true;
        frameAnchor = pictureType != PICTURE_TYPE_B;
        frameFirstStructure = structure;
        frameFieldsWord = createFrameFieldsWord(structure);
        reportFrameFields(frameFieldsWord);
        // A first field whose second field never came stays as FFmpeg leaves it: an anchor keeps its reference. Its packet concealed
        // the other field, which counts now that no second field replaced it
        let pendingSlot = state[STATE_PENDING_SLOT];
        if (pendingSlot != 0u) {
            reportConcealment(ERROR_FIELD_MISSING, STRUCTURE_FRAME - state[STATE_PENDING_STRUCTURE]);
        }
        if (pendingSlot != 0u && state[STATE_PENDING_ANCHOR] == 0u) {
            addRelease(pendingSlot - 1u);
        }
        state[STATE_PENDING_SLOT] = 0u;
        // ff_mpv_frame_start: an anchor moves the next picture to last and takes its place
        if (frameAnchor) {
            let oldLast = state[STATE_LAST_SLOT];
            state[STATE_LAST_SLOT] = state[STATE_NEXT_SLOT];
            state[STATE_NEXT_SLOT] = outputSlot;
            if (oldLast != 0u && oldLast != DUMMY_REFERENCE && oldLast != state[STATE_LAST_SLOT]) {
                addRelease(oldLast - 1u);
            }
        }
    } else if (frameStarted) {
        // The second field of the frame this packet started
        if (frameFirstStructure == structure || frameFirstStructure == STRUCTURE_FRAME) {
            failHeader(ERROR_FIELD_PICTURES, structure);
            return;
        }
    } else {
        // The second field of a frame whose first field ended an earlier packet: copy that field into this packet's slot
        let pendingSlot = state[STATE_PENDING_SLOT];
        if (pendingSlot == 0u || state[STATE_PENDING_STRUCTURE] == structure) {
            failHeader(ERROR_FIELD_PICTURES, structure);
            return;
        }
        frameStarted = true;
        frameAnchor = state[STATE_PENDING_ANCHOR] != 0u;
        frameFirstStructure = state[STATE_PENDING_STRUCTURE];
        // This packet's slot holds the whole frame, which reports the flags its first field's packet reported
        frameFieldsWord = state[STATE_PENDING_FIELDS];
        reportFrameFields(frameFieldsWord);
        pictureState[PACKET_COPY_MODE] = COPY_FIELD;
        pictureState[PACKET_COPY_SOURCE] = pendingSlot;
        pictureState[PACKET_COPY_FIELD] = state[STATE_PENDING_STRUCTURE] - 1u;
        pictureState[PACKET_MIRROR_SLOT] = pendingSlot;
        if (state[STATE_NEXT_SLOT] == pendingSlot) {
            state[STATE_NEXT_SLOT] = outputSlot;
        }
        if (state[STATE_LAST_SLOT] == pendingSlot) {
            state[STATE_LAST_SLOT] = outputSlot;
        }
        addRelease(pendingSlot - 1u);
        state[STATE_PENDING_SLOT] = 0u;
    }
    // ff_mpv_alloc_dummy_frames: a missing forward reference of a P or B picture, or backward one of a B picture, is a gray dummy
    if (state[STATE_LAST_SLOT] == 0u && pictureType != PICTURE_TYPE_I) {
        state[STATE_LAST_SLOT] = DUMMY_REFERENCE;
    }
    if (state[STATE_NEXT_SLOT] == 0u && pictureType == PICTURE_TYPE_B) {
        state[STATE_NEXT_SLOT] = DUMMY_REFERENCE;
    }
    openFirstField = structure != STRUCTURE_FRAME && firstField != 0u;
    openFirstFieldStructure = structure;
    openFirstFieldPicture = pictureIndex;
    pictureState[picture + PICTURE_DECODED] = 1u;
    pictureState[picture + PICTURE_FIRST_FIELD] = firstField;
    pictureState[picture + PICTURE_FORWARD_SLOT] = state[STATE_LAST_SLOT];
    pictureState[picture + PICTURE_BACKWARD_SLOT] = state[STATE_NEXT_SLOT];
    let fieldRows = select(1u, 2u, structure != STRUCTURE_FRAME);
    pictureState[picture + PICTURE_MACROBLOCK_COUNT] = macroblockWidth * (macroblockHeight / fieldRows);
    for (var field = 0u; field < CODING_FIELD_COUNT; field += 1u) {
        pictureState[picture + PICTURE_CODING_FIELDS + field] = codingField(field);
    }
    for (var word = 0u; word < MATRICES_WORDS; word += 1u) {
        pictureState[picture + PICTURE_MATRICES + word] = pictureState[CONTEXT_MATRICES + word];
    }
    // FFmpeg's is_d10: a D-10 picture may carry junk after its last macroblock
    let d10 = pictureState[CONTEXT_CHROMA_FORMAT] == CHROMA_422 && pictureType == PICTURE_TYPE_I
        && pictureState[CONTEXT_PROFILE] == D10_PROFILE && pictureState[CONTEXT_LEVEL] == D10_LEVEL
        && codingField(CODING_INTRA_DC_PRECISION) == D10_INTRA_DC_PRECISION && codingField(CODING_Q_SCALE_TYPE) == 1u
        && codingField(CODING_ALTERNATE_SCAN) == 0u && codingField(CODING_PROGRESSIVE_FRAME) == 0u;
    pictureState[picture + PICTURE_D10] = select(0u, 1u, d10);
}

// A slice start code, as decode_chunks' default case handles one
fn handleSlice(position: u32, code: u32, nextPosition: u32) {
    if (lastCode == LAST_CODE_PICTURE) {
        beginPictureSlices();
    }
    if (lastCode == LAST_CODE_NONE) {
        return;
    }
    lastCode = LAST_CODE_SLICE;
    let pictureIndex = pictureCount - 1u;
    let structure = codingField(CODING_PICTURE_STRUCTURE);
    let fieldPicture = select(0u, 1u, structure != STRUCTURE_FRAME);
    let macroblockHeight = pictureState[CONTEXT_MACROBLOCK_HEIGHT];
    var row = code - SLICE_MINIMUM_START_CODE;
    if (pictureState[CONTEXT_MPEG2] != 0u && macroblockHeight > VERTICAL_POSITION_EXTENSION_ROWS) {
        row += (headerByte(position + START_CODE_BYTES) & 0xE0u) << 2u;
    }
    row = row << fieldPicture;
    if (structure == STRUCTURE_BOTTOM_FIELD) {
        row += 1u;
    }
    if (packet.byteLength < position + START_CODE_BYTES + 2u || row >= macroblockHeight) {
        // FFmpeg abandons the rest of the packet at a slice too short or below the picture; this slice is skipped instead, decoding
        // resumes at the next one, and concealment covers what it would have decoded
        reportConcealment(ERROR_SLICE_HEADER, row);
        return;
    }
    let picture = pictureBase(pictureIndex);
    if (pictureState[picture + PICTURE_STARTED] == 0u) {
        startPicture(pictureIndex);
        if (headerFailed) {
            return;
        }
    }
    if (pictureState[picture + PICTURE_DECODED] == 0u) {
        return;
    }
    if (sliceCount >= MAXIMUM_SLICES) {
        failHeader(ERROR_START_CODES, sliceCount);
        return;
    }
    let slice = sliceBase(sliceCount);
    pictureState[slice + SLICE_DATA_BYTE] = position + START_CODE_BYTES;
    pictureState[slice + SLICE_END_BYTE] = nextPosition;
    pictureState[slice + SLICE_POSITION] = pictureIndex | (row << 1u);
    pictureState[slice + SLICE_MACROBLOCK_BIT] = 0u;
    pictureState[slice + SLICE_END_MACROBLOCK] = SLICE_OUTCOME_NONE;
    pictureState[picture + PICTURE_SLICE_COUNT] += 1u;
    sliceCount += 1u;
}

fn handleStartCode(position: u32, nextPosition: u32) {
    let code = headerByte(position + 3u);
    headerBit = (position + START_CODE_BYTES) * 8u;
    if (code == SEQUENCE_HEADER_CODE) {
        if (lastCode == LAST_CODE_NONE) {
            parseSequenceHeader();
            // A packet's sequence header syncs FFmpeg's decoder whether or not it was damaged
            if (headerSource == SOURCE_PACKET) {
                state[STATE_SYNC] = 1u;
            }
        }
        return;
    }
    if (code == PICTURE_START_CODE) {
        handlePictureStartCode();
        return;
    }
    if (code == EXTENSION_START_CODE) {
        handleExtension();
        return;
    }
    if (code == GROUP_START_CODE) {
        if (lastCode == LAST_CODE_NONE) {
            parseGroupOfPictures();
        }
        return;
    }
    if (code >= SLICE_MINIMUM_START_CODE && code <= SLICE_MAXIMUM_START_CODE) {
        handleSlice(position, code, nextPosition);
    }
}

// The position of the first start code at or after position in the codec private data, or its length
fn findConfigurationStartCode(position: u32) -> u32 {
    let length = headerByteLength;
    for (var candidate = position; candidate + START_CODE_BYTES <= length; candidate += 1u) {
        if (readConfigByte(candidate) == 0u && readConfigByte(candidate + 1u) == 0u && readConfigByte(candidate + 2u) == 1u) {
            return candidate;
        }
    }
    return length;
}

// The codec private data, decoded as FFmpeg decodes extradata before the first packet: its headers apply, a picture ends it
fn parseConfiguration() {
    headerSource = SOURCE_CONFIGURATION;
    headerByteLength = stream.configByteLength;
    lastCode = LAST_CODE_NONE;
    pictureStartCodeSeen = false;
    var position = findConfigurationStartCode(0u);
    while (position < headerByteLength) {
        let nextPosition = findConfigurationStartCode(position + START_CODE_BYTES);
        if (readConfigByte(position + 3u) == PICTURE_START_CODE) {
            return;
        }
        handleStartCode(position, nextPosition);
        if (headerFailed) {
            return;
        }
        position = nextPosition;
    }
}

@compute @workgroup_size(1)
fn parseHeaders() {
    setDispatchArguments(0u, 1u, 1u);
    if (packetFailed()) {
        return;
    }
    headerFailed = false;
    pictureCount = 0u;
    sliceCount = 0u;
    currentPictureType = PICTURE_TYPE_NONE;
    frameStarted = false;
    frameAnchor = false;
    openFirstField = false;
    frameFieldsWord = 0u;
    if (pictureState[CONTEXT_CONFIGURATION_PARSED] == 0u) {
        pictureState[CONTEXT_CONFIGURATION_PARSED] = 1u;
        if (stream.configByteLength > 0u) {
            parseConfiguration();
            if (headerFailed) {
                return;
            }
        }
    }
    headerSource = SOURCE_PACKET;
    headerByteLength = packet.byteLength;
    lastCode = LAST_CODE_NONE;
    pictureStartCodeSeen = false;
    let startCodeCount = min(pictureState[PACKET_START_CODE_COUNT], MAXIMUM_START_CODES);
    for (var index = 0u; index < startCodeCount; index += 1u) {
        let position = pictureState[START_CODES + index];
        var nextPosition = packet.byteLength;
        if (index + 1u < startCodeCount) {
            nextPosition = pictureState[START_CODES + index + 1u];
        }
        handleStartCode(position, nextPosition);
        if (headerFailed) {
            return;
        }
    }
    finishHeaders();
}

// The packet's frame after its headers: what its slot shows when it decodes nothing, the references it releases, and the slice dispatch
fn finishHeaders() {
    let outputSlot = packet.outputSlot;
    if (!frameStarted) {
        // FFmpeg outputs nothing for this packet; its slot shows the latest anchor, or gray before any
        pictureState[PACKET_COPY_MODE] = COPY_FRAME;
        pictureState[PACKET_COPY_SOURCE] = state[STATE_NEXT_SLOT];
        addRelease(outputSlot);
    } else if (openFirstField) {
        // The next packet's second field completes this frame
        state[STATE_PENDING_SLOT] = outputSlot + 1u;
        state[STATE_PENDING_ANCHOR] = select(0u, 1u, frameAnchor);
        state[STATE_PENDING_STRUCTURE] = openFirstFieldStructure;
        state[STATE_PENDING_FIELDS] = frameFieldsWord;
        concealMissingField();
    } else if (!frameAnchor) {
        addRelease(outputSlot);
    }
    pictureState[PACKET_PICTURE_COUNT] = pictureCount;
    pictureState[PACKET_SLICE_COUNT] = sliceCount;
    pictureState[PACKET_CURRENT_PICTURE] = 0u;
    if (pictureState[CONTEXT_INITIALIZED] != 0u && state[STATE_FACTS_REPORTED] == 0u) {
        state[STATE_FACTS_REPORTED] = 1u;
        let macroblockWidth = pictureState[CONTEXT_MACROBLOCK_WIDTH];
        let macroblockHeight = pictureState[CONTEXT_MACROBLOCK_HEIGHT];
        let visibleRectangle = vec4u(0u, 0u, pictureState[CONTEXT_INITIALIZED_WIDTH], pictureState[CONTEXT_INITIALIZED_HEIGHT]);
        reportHeaderFacts(macroblockWidth * 16u, macroblockHeight * 16u, OUTPUT_BIT_DEPTH, visibleRectangle);
    }
    let rows = (sliceCount + SLICE_DISPATCH_WIDTH - 1u) / SLICE_DISPATCH_WIDTH;
    setDispatchArguments(min(sliceCount, SLICE_DISPATCH_WIDTH), rows, 1u);
}

// The packet ends with a first field, so its frame's other field holds whatever its slot held. That field is concealed as a field
// picture without slices, every macroblock damaged, so the frame this packet presents is whole; a second field in the next packet
// replaces it, as it completes the frame in this slot too. FFmpeg leaves the field as its buffer held it
fn concealMissingField() {
    let missingIndex = openFirstFieldPicture + 1u;
    if (missingIndex >= MAXIMUM_PICTURES) {
        return;
    }
    let first = pictureBase(openFirstFieldPicture);
    let missing = pictureBase(missingIndex);
    for (var word = 0u; word < PICTURE_WORDS; word += 1u) {
        pictureState[missing + word] = pictureState[first + word];
    }
    pictureState[missing + PICTURE_CODING_FIELDS + CODING_PICTURE_STRUCTURE] = STRUCTURE_FRAME - openFirstFieldStructure;
    pictureState[missing + PICTURE_FIRST_FIELD] = 0u;
    pictureState[missing + PICTURE_CONCEALED] = 1u;
    pictureState[missing + PICTURE_FIRST_SLICE] = sliceCount;
    pictureState[missing + PICTURE_SLICE_COUNT] = 0u;
    pictureCount = missingIndex + 1u;
}

// The slice reader: the bits of the packet from any position, a window of three big-endian words in registers, the third loaded a word
// ahead so a crossing's load has a word of decoding to arrive; zero past the packet's end, as FFmpeg's padded buffers read
var<private> readerBit: u32;
var<private> readerWord: u32;
var<private> readerHigh: u32;
var<private> readerLow: u32;
var<private> readerAhead: u32;
var<private> readerEndBit: u32;

fn startReader(bit: u32) {
    readerEndBit = packet.byteLength * 8u;
    readerBit = bit;
    readerWord = bit >> 5u;
    readerHigh = packetBigEndianWord(readerWord);
    readerLow = packetBigEndianWord(readerWord + 1u);
    readerAhead = packetBigEndianWord(readerWord + 2u);
}

// The 32 bits from the reader's position; the low word shifts in two steps, so a shift of 0 keeps its bits out
fn peekWindow() -> u32 {
    let shift = readerBit & 31u;
    return (readerHigh << shift) | ((readerLow >> 1u) >> (31u - shift));
}

// count bits, 1 to 32, without consuming them
fn peekBits(count: u32) -> u32 {
    return peekWindow() >> (32u - count);
}

// Consumes count bits, 0 to 32, which crosses at most one word
fn consumeBits(count: u32) {
    readerBit += count;
    if ((readerBit >> 5u) != readerWord) {
        readerWord += 1u;
        readerHigh = readerLow;
        readerLow = readerAhead;
        readerAhead = packetBigEndianWord(readerWord + 2u);
    }
}

fn readBits(count: u32) -> u32 {
    if (count == 0u) {
        return 0u;
    }
    let value = peekBits(count);
    consumeBits(count);
    return value;
}

fn readBit() -> u32 {
    let value = peekWindow() >> 31u;
    consumeBits(1u);
    return value;
}

// FFmpeg's get_bits_left: negative once a read went past the packet
fn bitsLeft() -> i32 {
    return i32(readerEndBit) - i32(readerBit);
}

// Reads one code of a lookup and returns its entry, whose length is zero for bits no code starts; such bits stay unread
fn readCode(lookup: u32, firstBits: u32) -> u32 {
    let window = peekWindow();
    var entry = lookupWord(lookup + (window >> (32u - firstBits)));
    if ((entry & LOOKUP_LINK_FLAG) != 0u) {
        let subtableBits = (entry >> LOOKUP_LENGTH_SHIFT) & LOOKUP_SUBTABLE_BITS_MASK;
        entry = lookupWord(lookup + (entry & LOOKUP_SYMBOL_MASK) + ((window << firstBits) >> (32u - subtableBits)));
    }
    consumeBits(codeLength(entry));
    return entry;
}

fn codeLength(entry: u32) -> u32 {
    return (entry >> LOOKUP_LENGTH_SHIFT) & LOOKUP_LENGTH_MASK;
}

fn codeSymbol(entry: u32) -> u32 {
    return entry & LOOKUP_SYMBOL_MASK;
}

// The coded blocks of a macroblock: 4:2:0, 4:2:2, and 4:4:4
fn blocksPerMacroblock(chromaFormat: u32) -> u32 {
    switch (chromaFormat) {
        case CHROMA_422: {
            return 8u;
        }
        case CHROMA_444: {
            return 12u;
        }
        default: {
            return 6u;
        }
    }
}

// Each slice's header and first macroblock address, which allocateSlices sizes the slice's coefficient storage from;
// FFmpeg's mpeg_decode_slice up to its macroblock loop. A damaged header leaves the slice unprepared: it decodes nothing and marks
// nothing, as FFmpeg's slice fails before its resync position is set, and decoding resumes at the next slice
@compute @workgroup_size(1)
fn prepareSlices(@builtin(workgroup_id) workgroupId: vec3u) {
    let sliceIndex = workgroupId.y * SLICE_DISPATCH_WIDTH + workgroupId.x;
    if (packetFailed() || sliceIndex >= pictureState[PACKET_SLICE_COUNT]) {
        return;
    }
    let slice = sliceBase(sliceIndex);
    let positionWord = pictureState[slice + SLICE_POSITION];
    let picture = pictureBase(positionWord & 1u);
    let row = positionWord >> 1u;
    startReader(pictureState[slice + SLICE_DATA_BYTE] * 8u);
    if (pictureState[picture + PICTURE_MPEG2] != 0u && pictureState[CONTEXT_MACROBLOCK_HEIGHT] > VERTICAL_POSITION_EXTENSION_ROWS) {
        consumeBits(3u);
    }
    let quantizerScale = readQuantizerScale(pictureState[picture + PICTURE_CODING_FIELDS + CODING_Q_SCALE_TYPE]);
    if (quantizerScale == 0u) {
        reportConcealment(ERROR_SLICE_HEADER, row);
        return;
    }
    // extra_bit_slice and its bytes, FFmpeg's skip_1stop_8data_bits
    if (bitsLeft() <= 0) {
        reportConcealment(ERROR_BITS_EXHAUSTED, row);
        return;
    }
    while (readBit() != 0u) {
        consumeBits(8u);
        if (bitsLeft() <= 0) {
            reportConcealment(ERROR_BITS_EXHAUSTED, row);
            return;
        }
    }
    var column = 0u;
    while (bitsLeft() > 0) {
        let entry = readCode(LOOKUP_MACROBLOCK_ADDRESS_INCREMENT, LOOKUP_MACROBLOCK_ADDRESS_INCREMENT_BITS);
        if (codeLength(entry) == 0u) {
            reportConcealment(ERROR_MACROBLOCK_ADDRESS, row);
            return;
        }
        let increment = codeSymbol(entry);
        if (increment >= INCREMENT_ESCAPE) {
            if (increment == INCREMENT_ESCAPE) {
                column += INCREMENT_ESCAPE_MACROBLOCKS;
            }
        } else {
            column += increment;
            break;
        }
    }
    if (column >= pictureState[CONTEXT_MACROBLOCK_WIDTH]) {
        reportConcealment(ERROR_MACROBLOCK_ADDRESS, column);
        return;
    }
    pictureState[slice + SLICE_FIRST_MACROBLOCK] = column | (quantizerScale << 16u);
    pictureState[slice + SLICE_MACROBLOCK_BIT] = readerBit;
}

// Whether prepareSlices read the slice's header, so the slice decodes
fn slicePrepared(slice: u32) -> bool {
    return pictureState[slice + SLICE_MACROBLOCK_BIT] != 0u;
}

// FFmpeg's mpeg_get_qscale
fn readQuantizerScale(nonLinear: u32) -> u32 {
    let code = readBits(5u);
    if (nonLinear != 0u) {
        return lookupWord(TABLE_NON_LINEAR_QUANTIZER_SCALE + code);
    }
    return code << 1u;
}

// A slice's first macroblock in its picture's raster order
fn sliceStart(slice: u32) -> u32 {
    let positionWord = pictureState[slice + SLICE_POSITION];
    let picture = pictureBase(positionWord & 1u);
    let fieldPicture = select(0u, 1u, pictureState[picture + PICTURE_CODING_FIELDS + CODING_PICTURE_STRUCTURE] != STRUCTURE_FRAME);
    let row = (positionWord >> 1u) >> fieldPicture;
    return row * pictureState[CONTEXT_MACROBLOCK_WIDTH] + (pictureState[slice + SLICE_FIRST_MACROBLOCK] & 0xFFFFu);
}

// The coefficient entries a slice may write: two bits code each, and its macroblocks up to the next slice's take 64 per block at most.
// Summed over a packet, neither bound exceeds the coefficient buffer, which holds the smaller of the frame's blocks and the packet's bits;
// slices out of raster order may exceed the frame's blocks, and allocateSlices clips them to the buffer
fn sliceAllocation(sliceIndex: u32, sliceCount: u32) -> u32 {
    let slice = sliceBase(sliceIndex);
    if (!slicePrepared(slice)) {
        return 0u;
    }
    let pictureIndex = pictureState[slice + SLICE_POSITION] & 1u;
    let start = sliceStart(slice);
    var end = pictureState[pictureBase(pictureIndex) + PICTURE_MACROBLOCK_COUNT];
    if (sliceIndex + 1u < sliceCount) {
        let next = sliceBase(sliceIndex + 1u);
        if ((pictureState[next + SLICE_POSITION] & 1u) == pictureIndex && slicePrepared(next)) {
            let nextStart = sliceStart(next);
            if (nextStart > start) {
                end = nextStart;
            }
        }
    }
    let span = select(1u, end - start, end > start);
    let byteLength = pictureState[slice + SLICE_END_BYTE] - pictureState[slice + SLICE_DATA_BYTE];
    let blocks = blocksPerMacroblock(pictureState[CONTEXT_CHROMA_FORMAT]);
    return min(byteLength * ENTRIES_PER_SLICE_BYTE, span * blocks * COEFFICIENTS_PER_BLOCK);
}

const ALLOCATION_WORKGROUP_SIZE: u32 = 256u;
var<workgroup> allocationTotals: array<u32, ALLOCATION_WORKGROUP_SIZE>;

// Each slice's range of coefficient entries, an exclusive prefix sum of their allocations in one workgroup
@compute @workgroup_size(ALLOCATION_WORKGROUP_SIZE)
fn allocateSlices(@builtin(local_invocation_index) localIndex: u32) {
    let sliceCount = select(min(pictureState[PACKET_SLICE_COUNT], MAXIMUM_SLICES), 0u, packetFailed());
    let slicesPerInvocation = (sliceCount + ALLOCATION_WORKGROUP_SIZE - 1u) / ALLOCATION_WORKGROUP_SIZE;
    let first = min(localIndex * slicesPerInvocation, sliceCount);
    let last = min(first + slicesPerInvocation, sliceCount);
    var sum = 0u;
    for (var sliceIndex = first; sliceIndex < last; sliceIndex += 1u) {
        sum += sliceAllocation(sliceIndex, sliceCount);
    }
    allocationTotals[localIndex] = sum;
    workgroupBarrier();
    var before = 0u;
    for (var other = 0u; other < localIndex; other += 1u) {
        before += allocationTotals[other];
    }
    let capacity = arrayLength(&coefficients);
    for (var sliceIndex = first; sliceIndex < last; sliceIndex += 1u) {
        let slice = sliceBase(sliceIndex);
        let allocation = sliceAllocation(sliceIndex, sliceCount);
        pictureState[slice + SLICE_ENTRY_BASE] = min(before, capacity);
        pictureState[slice + SLICE_ENTRY_LIMIT] = min(before + allocation, capacity);
        before += allocation;
    }
}

// Writes one macroblock's samples of the output slot before any picture decodes: a first field an earlier packet decoded,
// or the frame a packet FFmpeg decodes nothing for shows
const GRAY_WORD: u32 = 0x80808080u;

@compute @workgroup_size(64)
fn copyFrame(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    let mode = pictureState[PACKET_COPY_MODE];
    if (mode == COPY_NONE || packetFailed()) {
        return;
    }
    var source = pictureState[PACKET_COPY_SOURCE];
    if (source == DUMMY_REFERENCE) {
        source = 0u;
    }
    let field = pictureState[PACKET_COPY_FIELD];
    for (var plane = 0u; plane < 3u; plane += 1u) {
        let planeLayout = stream.planes[plane];
        var macroblockPlaneWidth = 16u;
        var macroblockPlaneHeight = 16u;
        if (plane > 0u) {
            macroblockPlaneWidth = select(16u, 8u, OUTPUT_CHROMA_FORMAT != CHROMA_444);
            macroblockPlaneHeight = select(16u, 8u, OUTPUT_CHROMA_FORMAT == CHROMA_420);
        }
        let wordsPerRow = macroblockPlaneWidth / 4u;
        let words = wordsPerRow * macroblockPlaneHeight;
        for (var word = localIndex; word < words; word += 64u) {
            let y = workgroupId.y * macroblockPlaneHeight + word / wordsPerRow;
            let x = workgroupId.x * macroblockPlaneWidth + (word % wordsPerRow) * 4u;
            if (y >= planeLayout.height || x >= planeLayout.width || (mode == COPY_FIELD && (y & 1u) != field)) {
                continue;
            }
            var value = GRAY_WORD;
            if (source != 0u) {
                value = framePool[getSampleByteAddress(source - 1u, plane, x, y) >> 2u];
            }
            framePool[getSampleByteAddress(packet.outputSlot, plane, x, y) >> 2u] = value;
        }
    }
}

// The macroblock layer: one invocation decodes one slice, as FFmpeg's mpeg_decode_slice and mpeg_decode_mb do, and records each
// macroblock's motion and its blocks' quantized coefficients for reconstructPicture
// The slice's picture
var<private> pictureType: u32;
var<private> mpeg2Picture: bool;
var<private> pictureStructure: u32;
var<private> fieldPicture: u32;
var<private> intraDCPrecision: u32;
var<private> qScaleType: u32;
var<private> intraVLCFormat: u32;
var<private> concealmentMotionVectors: bool;
var<private> framePredFrameDCT: bool;
var<private> topFieldFirst: bool;
var<private> progressiveSequence: bool;
var<private> fCodes: vec4u;
var<private> fullPel: vec2u;
var<private> blockCount: u32;
var<private> macroblockWidth: u32;
var<private> macroblockHeight: u32;
var<private> sequenceHeight: u32;
var<private> pictureD10: bool;
var<private> alternateScan: bool;
var<private> progressiveFrame: bool;
var<private> chromaFormat: u32;
// The macroblock being decoded and the state FFmpeg's MpegEncContext keeps across macroblocks
var<private> macroblockX: u32;
var<private> macroblockY: u32;
var<private> quantizerScale: u32;
var<private> lastDCLuma: i32;
var<private> lastDCBlue: i32;
var<private> lastDCRed: i32;
// FFmpeg's last_mv of each direction: the first vector's x and y, then the second's
var<private> predictionForward: vec4i;
var<private> predictionBackward: vec4i;
// FFmpeg's mv: forward 0 and 1, backward 0 and 1; dual prime puts its opposite parity vectors in the backward pair
var<private> vectorForward0: vec2i;
var<private> vectorForward1: vec2i;
var<private> vectorBackward0: vec2i;
var<private> vectorBackward1: vec2i;
var<private> fieldSelects: u32;
var<private> motionDirection: u32;
var<private> motionType: u32;
var<private> fieldDCT: bool;
var<private> previousIntra: bool;
var<private> sliceFailed: bool;
// The macroblock the slice failed at, in its picture's raster order, FFmpeg's mb_x and mb_y when mpeg_decode_slice returns an error
var<private> sliceFailureIndex: u32;
// Whether redecodeSlices runs the slice again, writing only the records of the macroblocks it decoded last, and its index plus one
var<private> sliceRedecoding: bool;
var<private> sliceOwner: u32;
// The slice's coefficient storage and the macroblock's entry counts, a byte per block
var<private> entryCursor: u32;
var<private> entryLimit: u32;
var<private> blockCountsLow: u32;
var<private> blockCountsMiddle: u32;
var<private> blockCountsHigh: u32;

// Fails the slice at the current macroblock: it decodes no further, and concealment covers its damage
fn failSlice(code: u32, value: u32) {
    if (!sliceFailed) {
        if (!sliceRedecoding) {
            reportConcealment(code, value);
        }
        sliceFailureIndex = (macroblockY >> fieldPicture) * macroblockWidth + macroblockX;
    }
    sliceFailed = true;
}

// The failing value of a macroblock: its column and row
fn macroblockPosition() -> u32 {
    return (macroblockY << 12u) | macroblockX;
}

fn loadSlicePicture(pictureIndex: u32) {
    let picture = pictureBase(pictureIndex);
    let fields = picture + PICTURE_CODING_FIELDS;
    pictureType = pictureState[picture + PICTURE_TYPE];
    mpeg2Picture = pictureState[picture + PICTURE_MPEG2] != 0u;
    pictureStructure = pictureState[fields + CODING_PICTURE_STRUCTURE];
    fieldPicture = select(0u, 1u, pictureStructure != STRUCTURE_FRAME);
    intraDCPrecision = pictureState[fields + CODING_INTRA_DC_PRECISION];
    qScaleType = pictureState[fields + CODING_Q_SCALE_TYPE];
    intraVLCFormat = pictureState[fields + CODING_INTRA_VLC_FORMAT];
    concealmentMotionVectors = pictureState[fields + CODING_CONCEALMENT_MOTION_VECTORS] != 0u;
    framePredFrameDCT = pictureState[fields + CODING_FRAME_PRED_FRAME_DCT] != 0u;
    topFieldFirst = pictureState[fields + CODING_TOP_FIELD_FIRST] != 0u;
    alternateScan = pictureState[fields + CODING_ALTERNATE_SCAN] != 0u;
    progressiveFrame = pictureState[fields + CODING_PROGRESSIVE_FRAME] != 0u;
    fCodes = vec4u(pictureState[fields + CODING_F_CODE_FORWARD_X], pictureState[fields + CODING_F_CODE_FORWARD_Y],
        pictureState[fields + CODING_F_CODE_BACKWARD_X], pictureState[fields + CODING_F_CODE_BACKWARD_Y]);
    fullPel = vec2u(pictureState[fields + CODING_FULL_PEL_FORWARD], pictureState[fields + CODING_FULL_PEL_BACKWARD]);
    pictureD10 = pictureState[picture + PICTURE_D10] != 0u;
    progressiveSequence = pictureState[CONTEXT_PROGRESSIVE_SEQUENCE] != 0u;
    chromaFormat = pictureState[CONTEXT_CHROMA_FORMAT];
    blockCount = blocksPerMacroblock(chromaFormat);
    macroblockWidth = pictureState[CONTEXT_MACROBLOCK_WIDTH];
    macroblockHeight = pictureState[CONTEXT_MACROBLOCK_HEIGHT];
    sequenceHeight = pictureState[CONTEXT_INITIALIZED_HEIGHT];
}

fn resetDCPredictors() {
    let value = 128 << intraDCPrecision;
    lastDCLuma = value;
    lastDCBlue = value;
    lastDCRed = value;
}

// The parity of the picture's field, FFmpeg's (picture_structure - 1) & 1
fn pictureParity() -> u32 {
    return (pictureStructure - 1u) & 1u;
}

// Appends a quantized coefficient to the slice's storage; past the slice's allocation the slice fails
fn writeEntry(position: u32, level: i32) {
    if (entryCursor >= entryLimit) {
        failSlice(ERROR_COEFFICIENT_STORAGE, macroblockPosition());
        return;
    }
    coefficients[entryCursor] = position | (bitcast<u32>(level) << ENTRY_LEVEL_SHIFT);
    entryCursor += 1u;
}

fn recordBlockCount(block: u32, count: u32) {
    let shift = (block & 3u) * 8u;
    if (block < 4u) {
        blockCountsLow |= count << shift;
    } else if (block < 8u) {
        blockCountsMiddle |= count << shift;
    } else {
        blockCountsHigh |= count << shift;
    }
}

// FFmpeg's get_xbits: n bits whose leading zero makes them negative
fn readSignedDifference(count: u32) -> i32 {
    let value = readBits(count);
    if ((value >> (count - 1u)) == 0u) {
        return i32(value) - i32((1u << count) - 1u);
    }
    return i32(value);
}

// FFmpeg's decode_dc and its predictor update; returns the DC as the prediction leaves it
fn decodeDC(component: u32) -> i32 {
    var entry: u32;
    if (component == 0u) {
        entry = readCode(LOOKUP_DC_SIZE_LUMINANCE, LOOKUP_DC_SIZE_LUMINANCE_BITS);
    } else {
        entry = readCode(LOOKUP_DC_SIZE_CHROMINANCE, LOOKUP_DC_SIZE_CHROMINANCE_BITS);
    }
    if (codeLength(entry) == 0u) {
        failSlice(ERROR_DC_DIFFERENTIAL, macroblockPosition());
        return 0;
    }
    let size = codeSymbol(entry);
    var difference = 0;
    if (size != 0u) {
        difference = readSignedDifference(size);
    }
    var dc: i32;
    if (component == 0u) {
        dc = lastDCLuma + difference;
        lastDCLuma = dc;
    } else if (component == 1u) {
        dc = lastDCBlue + difference;
        lastDCBlue = dc;
    } else {
        dc = lastDCRed + difference;
        lastDCRed = dc;
    }
    return dc;
}

// The level of an MPEG-1 escape: 8 bits, or 16 when the first 8 are -128 or 0
fn readMPEG1EscapeLevel() -> i32 {
    let level = signExtend(i32(readBits(8u)), 8u);
    if (level == -128) {
        return i32(readBits(8u)) - 256;
    }
    if (level == 0) {
        return i32(readBits(8u));
    }
    return level;
}

// A run and level after a coefficient code's lookup entry: an escape's fixed-length fields, or the code's own with its sign bit
fn readRunLevel(symbol: u32) -> vec2i {
    let level = symbol >> COEFFICIENT_LEVEL_SHIFT;
    if (level == COEFFICIENT_ESCAPE_LEVEL) {
        let run = i32(readBits(6u)) + 1;
        if (mpeg2Picture) {
            return vec2i(run, signExtend(i32(readBits(12u)), 12u));
        }
        return vec2i(run, readMPEG1EscapeLevel());
    }
    let run = i32(symbol & COEFFICIENT_RUN_MASK);
    if (readBit() != 0u) {
        return vec2i(run, -i32(level));
    }
    return vec2i(run, i32(level));
}

// An intra block: FFmpeg's mpeg2_decode_block_intra, or ff_mpeg1_decode_block_intra, up to dequantization; returns its entry count
fn decodeIntraBlock(block: u32) -> u32 {
    let component = select((block & 1u) + 1u, 0u, block < 4u);
    let dc = decodeDC(component);
    if (sliceFailed) {
        return 0u;
    }
    writeEntry(0u, dc);
    var count = 1u;
    var index = 0;
    if (!mpeg2Picture) {
        // MPEG-1 checks for the end of block before each code
        if ((peekWindow() >> 30u) == 2u) {
            consumeBits(2u);
            return count;
        }
    }
    var lookup = LOOKUP_DCT_COEFFICIENTS_B14;
    if (mpeg2Picture && intraVLCFormat != 0u) {
        lookup = LOOKUP_DCT_COEFFICIENTS_B15;
    }
    loop {
        let entry = readCode(lookup, LOOKUP_DCT_COEFFICIENTS_B14_BITS);
        if (codeLength(entry) == 0u) {
            failSlice(ERROR_COEFFICIENTS, macroblockPosition());
            return count;
        }
        let symbol = codeSymbol(entry);
        if ((symbol >> COEFFICIENT_LEVEL_SHIFT) == COEFFICIENT_END_OF_BLOCK_LEVEL) {
            if (!mpeg2Picture) {
                failSlice(ERROR_COEFFICIENTS, macroblockPosition());
            }
            return count;
        }
        let runLevel = readRunLevel(symbol);
        index += runLevel.x;
        if (index > MAXIMUM_SCAN_INDEX) {
            failSlice(ERROR_COEFFICIENTS, macroblockPosition());
            return count;
        }
        writeEntry(u32(index), runLevel.y);
        count += 1u;
        if (!mpeg2Picture && (peekWindow() >> 30u) == 2u) {
            consumeBits(2u);
            return count;
        }
    }
}

// A non-intra block: FFmpeg's mpeg2_decode_block_non_intra, or mpeg1_decode_block_inter, up to dequantization.
// A first code of 1s is level 1 at the first position, and 10 after a coefficient ends the block; returns its entry count
fn decodeNonIntraBlock() -> u32 {
    var count = 0u;
    var index = -1;
    if ((peekWindow() >> 31u) != 0u) {
        let negative = ((peekWindow() >> 30u) & 1u) != 0u;
        writeEntry(0u, select(1, -1, negative));
        count = 1u;
        index = 0;
        consumeBits(2u);
        if ((peekWindow() >> 30u) == 2u) {
            consumeBits(2u);
            return count;
        }
    }
    loop {
        let entry = readCode(LOOKUP_DCT_COEFFICIENTS_B14, LOOKUP_DCT_COEFFICIENTS_B14_BITS);
        let symbol = codeSymbol(entry);
        if (codeLength(entry) == 0u || (symbol >> COEFFICIENT_LEVEL_SHIFT) == COEFFICIENT_END_OF_BLOCK_LEVEL) {
            failSlice(ERROR_COEFFICIENTS, macroblockPosition());
            return count;
        }
        let runLevel = readRunLevel(symbol);
        index += runLevel.x;
        if (index > MAXIMUM_SCAN_INDEX) {
            failSlice(ERROR_COEFFICIENTS, macroblockPosition());
            return count;
        }
        writeEntry(u32(index), runLevel.y);
        count += 1u;
        if ((peekWindow() >> 30u) == 2u) {
            consumeBits(2u);
            return count;
        }
    }
}

// What mpeg_decode_motion returns for bits no motion code starts, which it leaves unread
const INVALID_MOTION_VALUE: i32 = 0xFFFF;

// FFmpeg's mpeg_decode_motion: a motion code against its prediction, wrapped to the f_code's range.
// An invalid code fails nothing: like FFmpeg, the macroblock decodes on with INVALID_MOTION_VALUE, whose prediction leaves the reference
fn decodeMotion(fCode: u32, prediction: i32) -> i32 {
    let entry = readCode(LOOKUP_MOTION_CODE, LOOKUP_MOTION_CODE_BITS);
    if (codeLength(entry) == 0u) {
        return INVALID_MOTION_VALUE;
    }
    let code = codeSymbol(entry);
    if (code == 0u) {
        return prediction;
    }
    let negative = readBit() != 0u;
    let shift = fCode - 1u;
    var value = i32(code);
    if (shift != 0u) {
        value = ((value - 1) << shift) | i32(readBits(shift));
        value += 1;
    }
    if (negative) {
        value = -value;
    }
    return signExtend(value + prediction, 5u + shift);
}

// FFmpeg's get_dmv: 0, 10, and 11 read as 0, 1, and -1
fn readDualPrimeDifferential() -> i32 {
    if (readBit() != 0u) {
        return 1 - (i32(readBit()) << 1u);
    }
    return 0;
}

fn predictionOf(direction: u32) -> vec4i {
    return select(predictionForward, predictionBackward, direction != 0u);
}

fn setPrediction(direction: u32, prediction: vec4i) {
    if (direction == 0u) {
        predictionForward = prediction;
    } else {
        predictionBackward = prediction;
    }
}

fn setVector(direction: u32, index: u32, vector: vec2i) {
    if (direction == 0u) {
        if (index == 0u) {
            vectorForward0 = vector;
        } else {
            vectorForward1 = vector;
        }
    } else if (index == 0u) {
        vectorBackward0 = vector;
    } else {
        vectorBackward1 = vector;
    }
}

fn fCodeX(direction: u32) -> u32 {
    return select(fCodes.x, fCodes.z, direction != 0u);
}

fn fCodeY(direction: u32) -> u32 {
    return select(fCodes.y, fCodes.w, direction != 0u);
}

// Frame motion in a frame picture: one vector, which both predictions of the direction take
fn decodeFrameMotion(direction: u32) {
    var prediction = predictionOf(direction);
    let x = decodeMotion(fCodeX(direction), prediction.x);
    let y = decodeMotion(fCodeY(direction), prediction.y);
    prediction = vec4i(x, y, x, y);
    setPrediction(direction, prediction);
    var vector = vec2i(x, y);
    // full_pel_vector: MPEG-1's whole-sample vectors
    if (fullPel[direction] != 0u) {
        vector *= 2;
    }
    setVector(direction, 0u, vector);
}

// 16x8 motion in a field picture: a field select and a vector for each half
fn decode16x8Motion(direction: u32) {
    var prediction = predictionOf(direction);
    for (var half = 0u; half < 2u; half += 1u) {
        if (readBit() != 0u) {
            fieldSelects |= 1u << (direction * 2u + half);
        }
        var vector: vec2i;
        if (half == 0u) {
            vector = vec2i(decodeMotion(fCodeX(direction), prediction.x), decodeMotion(fCodeY(direction), prediction.y));
            prediction = vec4i(vector, prediction.zw);
        } else {
            vector = vec2i(decodeMotion(fCodeX(direction), prediction.z), decodeMotion(fCodeY(direction), prediction.w));
            prediction = vec4i(prediction.xy, vector);
        }
        setVector(direction, half, vector);
    }
    setPrediction(direction, prediction);
}

// Field motion in a frame picture: a field select and a field vector for each field, whose vertical prediction is in frame units
fn decodeFrameFieldMotion(direction: u32) {
    var prediction = predictionOf(direction);
    for (var field = 0u; field < 2u; field += 1u) {
        if (readBit() != 0u) {
            fieldSelects |= 1u << (direction * 2u + field);
        }
        if (field == 0u) {
            let x = decodeMotion(fCodeX(direction), prediction.x);
            let y = decodeMotion(fCodeY(direction), prediction.y >> 1u);
            prediction = vec4i(x, y * 2, prediction.zw);
            setVector(direction, 0u, vec2i(x, y));
        } else {
            let x = decodeMotion(fCodeX(direction), prediction.z);
            let y = decodeMotion(fCodeY(direction), prediction.w >> 1u);
            prediction = vec4i(prediction.xy, x, y * 2);
            setVector(direction, 1u, vec2i(x, y));
        }
    }
    setPrediction(direction, prediction);
}

// Field motion in a field picture: one field select and one vector
fn decodeFieldMotion(direction: u32) {
    if (readBit() != 0u) {
        fieldSelects |= 1u << (direction * 2u);
    }
    let prediction = predictionOf(direction);
    let x = decodeMotion(fCodeX(direction), prediction.x);
    let y = decodeMotion(fCodeY(direction), prediction.y);
    setPrediction(direction, vec4i(x, y, x, y));
    setVector(direction, 0u, vec2i(x, y));
}

// The opposite parity vector of dual prime: the vector scaled by m / 2 and rounded away from zero, plus the differential
fn dualPrimeComponent(value: i32, scale: i32, differential: i32) -> i32 {
    return ((value * scale + select(0, 1, value > 0)) >> 1u) + differential;
}

// Dual prime: one vector and a differential, from which the opposite parity vectors derive, as FFmpeg's MT_DMV case does
fn decodeDualPrimeMotion(direction: u32) {
    let verticalShift = 1u - fieldPicture;
    var prediction = predictionOf(direction);
    let x = decodeMotion(fCodeX(direction), prediction.x);
    let differentialX = readDualPrimeDifferential();
    let y = decodeMotion(fCodeY(direction), prediction.y >> verticalShift);
    let differentialY = readDualPrimeDifferential();
    let frameY = y * (1 << verticalShift);
    setPrediction(direction, vec4i(x, frameY, x, frameY));
    vectorForward0 = vec2i(x, y);
    vectorForward1 = vec2i(x, y);
    if (fieldPicture == 0u) {
        // Top from bottom, then bottom from top, as m = 1 + 2 * !top_field_first and 4 - m scale them
        let scale = select(3, 1, topFieldFirst);
        vectorBackward0 = vec2i(dualPrimeComponent(x, scale, differentialX), dualPrimeComponent(y, scale, differentialY) - 1);
        vectorBackward1 = vec2i(dualPrimeComponent(x, 4 - scale, differentialX), dualPrimeComponent(y, 4 - scale, differentialY) + 1);
    } else {
        let parityOffset = select(1, -1, pictureStructure == STRUCTURE_TOP_FIELD);
        vectorBackward0 = vec2i(dualPrimeComponent(x, 1, differentialX), dualPrimeComponent(y, 1, differentialY) + parityOffset);
    }
}

fn packVector(vector: vec2i) -> u32 {
    let x = clamp(vector.x, -32768, 32767);
    let y = clamp(vector.y, -32768, 32767);
    return (bitcast<u32>(x) & 0xFFFFu) | (bitcast<u32>(y) << 16u);
}

// Writes the macroblock's record; a slice running again writes only the macroblocks no later slice decoded
fn storeMacroblock(flags: u32, codedBlocks: u32, entryStart: u32) {
    let record = (macroblockY * macroblockWidth + macroblockX) * MACROBLOCK_WORDS;
    if (sliceRedecoding && (macroblocks[record + RECORD_CONCEALMENT] >> CONCEAL_OWNER_SHIFT) != sliceOwner) {
        return;
    }
    macroblocks[record + RECORD_SERIAL] = packet.index;
    macroblocks[record + RECORD_FLAGS] = flags | (fieldSelects << FIELD_SELECT_SHIFT) | (codedBlocks << CODED_BLOCKS_SHIFT)
        | (quantizerScale << QUANTIZER_SHIFT);
    macroblocks[record + RECORD_VECTORS] = packVector(vectorForward0);
    macroblocks[record + RECORD_VECTORS + 1u] = packVector(vectorForward1);
    macroblocks[record + RECORD_VECTORS + 2u] = packVector(vectorBackward0);
    macroblocks[record + RECORD_VECTORS + 3u] = packVector(vectorBackward1);
    macroblocks[record + RECORD_ENTRY_START] = entryStart;
    macroblocks[record + RECORD_BLOCK_COUNTS] = blockCountsLow;
    macroblocks[record + RECORD_BLOCK_COUNTS + 1u] = blockCountsMiddle;
    macroblocks[record + RECORD_BLOCK_COUNTS + 2u] = blockCountsHigh;
}

fn motionFlags() -> u32 {
    var flags = motionDirection | (motionType << MOTION_TYPE_SHIFT);
    if (fieldDCT) {
        flags |= FLAG_FIELD_DCT;
    }
    return flags;
}

// The motion skipped macroblocks share, set when an increment skips some, as mpeg_decode_slice sets it
fn prepareSkippedMacroblocks() {
    resetDCPredictors();
    motionType = select(MOTION_FIELD, MOTION_FRAME, pictureStructure == STRUCTURE_FRAME);
    let parity = pictureParity();
    if (pictureType == PICTURE_TYPE_P) {
        motionDirection = FLAG_FORWARD;
        vectorForward0 = vec2i(0);
        predictionForward = vec4i(0);
        fieldSelects = parity;
    } else {
        vectorForward0 = predictionForward.xy;
        vectorBackward0 = predictionBackward.xy;
        fieldSelects = parity | (parity << 2u);
    }
}

// A skipped macroblock: P predicts from the same place, B repeats the previous macroblock's prediction
fn decodeSkippedMacroblock() {
    if (pictureType == PICTURE_TYPE_B && previousIntra) {
        failSlice(ERROR_SKIPPED_MACROBLOCK, macroblockPosition());
        return;
    }
    blockCountsLow = 0u;
    blockCountsMiddle = 0u;
    blockCountsHigh = 0u;
    storeMacroblock(motionFlags() | FLAG_SKIPPED, 0u, entryCursor);
}

// A coded macroblock, FFmpeg's mpeg_decode_mb after its skip handling
fn decodeCodedMacroblock() {
    let entryStart = entryCursor;
    blockCountsLow = 0u;
    blockCountsMiddle = 0u;
    blockCountsHigh = 0u;
    var macroblockType = 0u;
    switch (pictureType) {
        case PICTURE_TYPE_P: {
            let entry = readCode(LOOKUP_P_MACROBLOCK_TYPE, LOOKUP_P_MACROBLOCK_TYPE_BITS);
            if (codeLength(entry) == 0u) {
                failSlice(ERROR_MACROBLOCK_TYPE, macroblockPosition());
                return;
            }
            macroblockType = codeSymbol(entry);
        }
        case PICTURE_TYPE_B: {
            let entry = readCode(LOOKUP_B_MACROBLOCK_TYPE, LOOKUP_B_MACROBLOCK_TYPE_BITS);
            if (codeLength(entry) == 0u) {
                failSlice(ERROR_MACROBLOCK_TYPE, macroblockPosition());
                return;
            }
            macroblockType = codeSymbol(entry);
        }
        default: {
            if (readBit() == 0u) {
                if (readBit() == 0u) {
                    failSlice(ERROR_MACROBLOCK_TYPE, macroblockPosition());
                    return;
                }
                macroblockType = MACROBLOCK_QUANT | MACROBLOCK_INTRA;
            } else {
                macroblockType = MACROBLOCK_INTRA;
            }
        }
    }
    if ((macroblockType & MACROBLOCK_INTRA) != 0u) {
        decodeIntraMacroblock(macroblockType, entryStart);
        return;
    }
    if ((macroblockType & MACROBLOCK_ZERO_MOTION) != 0u) {
        // A P macroblock without motion compensation: zero motion from the same place
        motionDirection = FLAG_FORWARD;
        fieldSelects = 0u;
        if (pictureStructure == STRUCTURE_FRAME) {
            if (!framePredFrameDCT) {
                fieldDCT = readBit() != 0u;
            }
            motionType = MOTION_FRAME;
        } else {
            motionType = MOTION_FIELD;
            fieldSelects = pictureStructure - 1u;
        }
        if ((macroblockType & MACROBLOCK_QUANT) != 0u) {
            quantizerScale = readQuantizerScale(qScaleType);
        }
        predictionForward = vec4i(0);
        vectorForward0 = vec2i(0);
    } else {
        var frameMotionType = MOTION_TYPE_FRAME_CODE;
        if (pictureStructure != STRUCTURE_FRAME || !framePredFrameDCT) {
            frameMotionType = readBits(2u);
            if (pictureStructure == STRUCTURE_FRAME && (macroblockType & MACROBLOCK_PATTERN) != 0u) {
                fieldDCT = readBit() != 0u;
            }
        }
        if ((macroblockType & MACROBLOCK_QUANT) != 0u) {
            quantizerScale = readQuantizerScale(qScaleType);
        }
        motionDirection = 0u;
        if ((macroblockType & MACROBLOCK_FORWARD) != 0u) {
            motionDirection |= FLAG_FORWARD;
        }
        if ((macroblockType & MACROBLOCK_BACKWARD) != 0u) {
            motionDirection |= FLAG_BACKWARD;
        }
        fieldSelects = 0u;
        switch (frameMotionType) {
            case MOTION_TYPE_FRAME_CODE: {
                motionType = select(MOTION_16X8, MOTION_FRAME, pictureStructure == STRUCTURE_FRAME);
                for (var direction = 0u; direction < 2u; direction += 1u) {
                    if ((motionDirection & (FLAG_FORWARD << direction)) == 0u) {
                        continue;
                    }
                    if (pictureStructure == STRUCTURE_FRAME) {
                        decodeFrameMotion(direction);
                    } else {
                        decode16x8Motion(direction);
                    }
                }
            }
            case MOTION_TYPE_FIELD_CODE: {
                motionType = MOTION_FIELD;
                for (var direction = 0u; direction < 2u; direction += 1u) {
                    if ((motionDirection & (FLAG_FORWARD << direction)) == 0u) {
                        continue;
                    }
                    if (pictureStructure == STRUCTURE_FRAME) {
                        decodeFrameFieldMotion(direction);
                    } else {
                        decodeFieldMotion(direction);
                    }
                }
            }
            case MOTION_TYPE_DUAL_PRIME_CODE: {
                // Dual prime predicts from one direction; FFmpeg would decode a B picture's as two
                if (progressiveSequence || motionDirection != FLAG_FORWARD) {
                    failSlice(ERROR_MOTION_TYPE, macroblockPosition());
                    return;
                }
                motionType = MOTION_DUAL_PRIME;
                decodeDualPrimeMotion(0u);
            }
            default: {
                failSlice(ERROR_MOTION_TYPE, macroblockPosition());
                return;
            }
        }
        if (sliceFailed) {
            return;
        }
    }
    resetDCPredictors();
    var codedBlocks = 0u;
    if ((macroblockType & MACROBLOCK_PATTERN) != 0u) {
        let entry = readCode(LOOKUP_CODED_BLOCK_PATTERN, LOOKUP_CODED_BLOCK_PATTERN_BITS);
        if (codeLength(entry) == 0u) {
            failSlice(ERROR_CODED_BLOCK_PATTERN, macroblockPosition());
            return;
        }
        var pattern = codeSymbol(entry);
        if (blockCount > 6u) {
            pattern = (pattern << (blockCount - 6u)) | readBits(blockCount - 6u);
        }
        if (pattern == 0u) {
            failSlice(ERROR_CODED_BLOCK_PATTERN, macroblockPosition());
            return;
        }
        for (var block = 0u; block < blockCount; block += 1u) {
            if (((pattern >> (blockCount - 1u - block)) & 1u) == 0u) {
                continue;
            }
            codedBlocks |= 1u << block;
            recordBlockCount(block, decodeNonIntraBlock());
            if (sliceFailed) {
                return;
            }
        }
    }
    previousIntra = false;
    storeMacroblock(motionFlags(), codedBlocks, entryStart);
}

// frame_motion_type and field_motion_type codes: field, frame or 16x8, and dual prime
const MOTION_TYPE_FIELD_CODE: u32 = 1u;
const MOTION_TYPE_FRAME_CODE: u32 = 2u;
const MOTION_TYPE_DUAL_PRIME_CODE: u32 = 3u;

fn decodeIntraMacroblock(macroblockType: u32, entryStart: u32) {
    if (pictureStructure == STRUCTURE_FRAME && !framePredFrameDCT) {
        fieldDCT = readBit() != 0u;
    }
    if ((macroblockType & MACROBLOCK_QUANT) != 0u) {
        quantizerScale = readQuantizerScale(qScaleType);
    }
    if (concealmentMotionVectors) {
        // Concealment vectors only update the predictions
        if (pictureStructure != STRUCTURE_FRAME) {
            consumeBits(1u);
        }
        let x = decodeMotion(fCodes.x, predictionForward.x);
        let y = decodeMotion(fCodes.y, predictionForward.y);
        predictionForward = vec4i(x, y, x, y);
        // marker_bit
        consumeBits(1u);
    } else {
        predictionForward = vec4i(0);
        predictionBackward = vec4i(0);
    }
    if (sliceFailed) {
        return;
    }
    for (var block = 0u; block < blockCount; block += 1u) {
        recordBlockCount(block, decodeIntraBlock(block));
        if (sliceFailed) {
            return;
        }
    }
    previousIntra = true;
    var flags = FLAG_INTRA;
    if (fieldDCT) {
        flags |= FLAG_FIELD_DCT;
    }
    let savedSelects = fieldSelects;
    fieldSelects = 0u;
    storeMacroblock(flags, (1u << blockCount) - 1u, entryStart);
    fieldSelects = savedSelects;
}

// The end of a picture after its last macroblock, mpeg_decode_slice's checks: what remains must be zero up to the next start code,
// unless a D-10 picture or an MXF key or an m704 alpha plane follows
fn checkPictureEnd() {
    let left = bitsLeft();
    var d10 = pictureD10;
    if (left >= 32 && !d10) {
        let aligned = (readerBit + 7u) & ~7u;
        if (peekPacketBitsAt(aligned, 24u) == MXF_KEY_PREFIX) {
            d10 = true;
        }
        if (left > 32 && peekPacketBitsAt(aligned, 32u) == M704_ALPHA_MARKER) {
            return;
        }
    }
    if (left < 0) {
        failSlice(ERROR_BITS_EXHAUSTED, macroblockPosition());
        return;
    }
    if (left > 0 && !d10 && peekBits(u32(min(left, 23))) != 0u) {
        failSlice(ERROR_SLICE_END, macroblockPosition());
    }
}

// FFmpeg's overread check at the end of a slice
fn checkSliceOverread() {
    if (bitsLeft() < 0) {
        failSlice(ERROR_BITS_EXHAUSTED, macroblockPosition());
    }
}

// Where an ended slice stopped: the macroblock after its last one, in its picture's raster order
var<private> sliceEndIndex: u32;

fn recordSliceEnd() {
    sliceEndIndex = (macroblockY >> fieldPicture) * macroblockWidth + macroblockX;
}

// mpeg_decode_slice's last slice check: an interlaced picture may lack the slice of a last row below its visible height
fn missingLastSlice(skipRun: i32) -> bool {
    let left = bitsLeft();
    if (macroblockY < ((sequenceHeight + 15u) >> 4u) || progressiveSequence || left > 25 || left < 0 || skipRun != -1) {
        return false;
    }
    return left == 0 || peekBits(u32(left)) == 0u;
}

fn decodeSlice(sliceIndex: u32) {
    let slice = sliceBase(sliceIndex);
    let positionWord = pictureState[slice + SLICE_POSITION];
    loadSlicePicture(positionWord & 1u);
    let firstMacroblock = pictureState[slice + SLICE_FIRST_MACROBLOCK];
    macroblockX = firstMacroblock & 0xFFFFu;
    quantizerScale = firstMacroblock >> 16u;
    macroblockY = positionWord >> 1u;
    entryCursor = pictureState[slice + SLICE_ENTRY_BASE];
    entryLimit = pictureState[slice + SLICE_ENTRY_LIMIT];
    startReader(pictureState[slice + SLICE_MACROBLOCK_BIT]);
    sliceFailed = false;
    fieldDCT = false;
    resetDCPredictors();
    predictionForward = vec4i(0);
    predictionBackward = vec4i(0);
    vectorForward0 = vec2i(0);
    vectorForward1 = vec2i(0);
    vectorBackward0 = vec2i(0);
    vectorBackward1 = vec2i(0);
    fieldSelects = 0u;
    motionDirection = 0u;
    motionType = MOTION_FRAME;
    previousIntra = false;
    // FFmpeg's mb_skip_run: macroblocks still to skip, or -1 once a coded macroblock read its own increment
    var skipRun = 0;
    loop {
        if (skipRun != 0) {
            skipRun -= 1;
            decodeSkippedMacroblock();
        } else {
            skipRun = -1;
            decodeCodedMacroblock();
        }
        if (sliceFailed) {
            return;
        }
        macroblockX += 1u;
        if (macroblockX >= macroblockWidth) {
            macroblockX = 0u;
            macroblockY += 1u << fieldPicture;
            if (macroblockY >= macroblockHeight) {
                // A failure here lies past the picture's last macroblock, where ff_er_add_slice marks no error
                checkPictureEnd();
                sliceEndIndex = pictureState[pictureBase(positionWord & 1u) + PICTURE_MACROBLOCK_COUNT];
                return;
            }
            if (missingLastSlice(skipRun)) {
                checkSliceOverread();
                recordSliceEnd();
                return;
            }
        }
        if (skipRun == -1) {
            skipRun = 0;
            loop {
                let entry = readCode(LOOKUP_MACROBLOCK_ADDRESS_INCREMENT, LOOKUP_MACROBLOCK_ADDRESS_INCREMENT_BITS);
                if (codeLength(entry) == 0u) {
                    failSlice(ERROR_MACROBLOCK_ADDRESS, macroblockPosition());
                    return;
                }
                let increment = codeSymbol(entry);
                if (increment < INCREMENT_ESCAPE) {
                    skipRun += i32(increment);
                    break;
                }
                if (increment == INCREMENT_ESCAPE) {
                    skipRun += i32(INCREMENT_ESCAPE_MACROBLOCKS);
                } else if (increment == INCREMENT_END) {
                    if (skipRun != 0 || peekBits(15u) != 0u) {
                        failSlice(ERROR_SLICE_END, macroblockPosition());
                        return;
                    }
                    checkSliceOverread();
                    recordSliceEnd();
                    return;
                }
            }
            if (skipRun != 0) {
                if (pictureType == PICTURE_TYPE_I) {
                    failSlice(ERROR_MACROBLOCK_ADDRESS, macroblockPosition());
                    return;
                }
                prepareSkippedMacroblocks();
            }
        }
    }
}

// Decodes a prepared slice; the first run records how it ended, which a run again repeats exactly
fn runSlice(sliceIndex: u32, redecoding: bool) {
    let slice = sliceBase(sliceIndex);
    if (!slicePrepared(slice)) {
        return;
    }
    sliceRedecoding = redecoding;
    sliceOwner = sliceIndex + 1u;
    decodeSlice(sliceIndex);
    if (redecoding) {
        return;
    }
    var outcome = SLICE_OUTCOME_ENDED;
    var index = sliceEndIndex;
    if (sliceFailed) {
        outcome = SLICE_OUTCOME_FAILED;
        index = sliceFailureIndex;
    }
    pictureState[slice + SLICE_END_MACROBLOCK] = (outcome << SLICE_OUTCOME_SHIFT) | min(index, SLICE_END_INDEX_MASK);
}

@compute @workgroup_size(1)
fn decodeSlices(@builtin(workgroup_id) workgroupId: vec3u) {
    let sliceIndex = workgroupId.y * SLICE_DISPATCH_WIDTH + workgroupId.x;
    if (packetFailed() || sliceIndex >= pictureState[PACKET_SLICE_COUNT]) {
        return;
    }
    runSlice(sliceIndex, false);
}

// Runs every slice again when two slices decoded one macroblock, since their records raced; each macroblock's record is then the one
// of the slice that decoded it last, as FFmpeg's later slice overwrites an earlier one
@compute @workgroup_size(1)
fn redecodeSlices(@builtin(workgroup_id) workgroupId: vec3u) {
    let sliceIndex = workgroupId.y * SLICE_DISPATCH_WIDTH + workgroupId.x;
    if (packetFailed() || pictureState[PACKET_REDECODE] == 0u || sliceIndex >= pictureState[PACKET_SLICE_COUNT]) {
        return;
    }
    runSlice(sliceIndex, true);
}

// Slice coverage and FFmpeg's error status. FFmpeg decodes slices one after another, and ff_er_add_slice records each in its
// error_status_table. A picture whose slices all ended, in raster order, covering it once needs no concealment, as FFmpeg's error count
// stays 0; an interlaced picture may also lack the slices of a last row below its visible height, which ff_er_frame_end ignores.
// Otherwise the picture is concealed: composeMacroblocks gives each of its macroblocks the status ff_er_add_slice's calls leave it, in
// slice order, and the slice that decoded it last, whose record redecodeSlices rewrites when two slices decoded it
const CHECK_WORKGROUP_SIZE: u32 = 256u;
const COMPOSE_WORKGROUP_SIZE: u32 = 64u;

var<workgroup> concealedPictures: atomic<u32>;
var<workgroup> checkTask: u32;

@compute @workgroup_size(CHECK_WORKGROUP_SIZE)
fn checkSlices(@builtin(local_invocation_index) localIndex: u32) {
    if (localIndex == 0u) {
        // A missing field parseHeaders made up for is concealed whatever the slices do
        var preset = 0u;
        for (var pictureIndex = 0u; pictureIndex < min(pictureState[PACKET_PICTURE_COUNT], MAXIMUM_PICTURES); pictureIndex += 1u) {
            preset |= (pictureState[pictureBase(pictureIndex) + PICTURE_CONCEALED] & 1u) << pictureIndex;
        }
        atomicStore(&concealedPictures, preset);
        checkTask = select(1u, 0u, packetFailed());
        setDispatchArguments(0u, 1u, 1u);
        pictureState[PACKET_REDECODE] = 0u;
    }
    if (workgroupUniformLoad(&checkTask) == 0u) {
        return;
    }
    let sliceCount = min(pictureState[PACKET_SLICE_COUNT], MAXIMUM_SLICES);
    for (var sliceIndex = localIndex; sliceIndex < sliceCount; sliceIndex += CHECK_WORKGROUP_SIZE) {
        if (sliceNeedsConcealment(sliceIndex, sliceCount)) {
            atomicOr(&concealedPictures, 1u << (pictureState[sliceBase(sliceIndex) + SLICE_POSITION] & 1u));
        }
    }
    workgroupBarrier();
    if (localIndex != 0u) {
        return;
    }
    let concealed = atomicLoad(&concealedPictures);
    for (var pictureIndex = 0u; pictureIndex < min(pictureState[PACKET_PICTURE_COUNT], MAXIMUM_PICTURES); pictureIndex += 1u) {
        pictureState[pictureBase(pictureIndex) + PICTURE_CONCEALED] = (concealed >> pictureIndex) & 1u;
    }
    if (concealed != 0u) {
        let frameMacroblocks = pictureState[CONTEXT_MACROBLOCK_WIDTH] * pictureState[CONTEXT_MACROBLOCK_HEIGHT];
        setDispatchArguments((frameMacroblocks + COMPOSE_WORKGROUP_SIZE - 1u) / COMPOSE_WORKGROUP_SIZE, 1u, 1u);
    }
}

// Composes the status of each macroblock of a concealed picture, one invocation per macroblock of the frame, so the work spreads over the
// device however many slices a damaged packet holds: a frame picture's macroblock, or a field picture's of the row's parity
@compute @workgroup_size(COMPOSE_WORKGROUP_SIZE)
fn composeMacroblocks(@builtin(global_invocation_id) invocation: vec3u) {
    let width = pictureState[CONTEXT_MACROBLOCK_WIDTH];
    if (packetFailed() || invocation.x >= width * pictureState[CONTEXT_MACROBLOCK_HEIGHT]) {
        return;
    }
    let frameRow = invocation.x / width;
    let column = invocation.x % width;
    for (var pictureIndex = 0u; pictureIndex < min(pictureState[PACKET_PICTURE_COUNT], MAXIMUM_PICTURES); pictureIndex += 1u) {
        let picture = pictureBase(pictureIndex);
        if (pictureState[picture + PICTURE_DECODED] == 0u || pictureState[picture + PICTURE_CONCEALED] == 0u) {
            continue;
        }
        let structure = pictureState[picture + PICTURE_CODING_FIELDS + CODING_PICTURE_STRUCTURE];
        if (structure == STRUCTURE_FRAME) {
            composeMacroblockStatus(pictureIndex, frameRow * width + column);
        } else if ((frameRow & 1u) == structure - 1u) {
            composeMacroblockStatus(pictureIndex, (frameRow >> 1u) * width + column);
        }
    }
}

// Dispatches redecodeSlices over the slices when two slices decoded one macroblock, and over none otherwise
@compute @workgroup_size(1)
fn prepareRedecode() {
    setDispatchArguments(0u, 1u, 1u);
    if (packetFailed() || pictureState[PACKET_REDECODE] == 0u) {
        return;
    }
    let sliceCount = min(pictureState[PACKET_SLICE_COUNT], MAXIMUM_SLICES);
    setDispatchArguments(min(sliceCount, SLICE_DISPATCH_WIDTH), (sliceCount + SLICE_DISPATCH_WIDTH - 1u) / SLICE_DISPATCH_WIDTH, 1u);
}

// Whether a slice leaves its picture to concealment: it failed, its header did, or the slice after it in its picture does not start
// where it ended; a gap or an overlap reports the macroblock it starts at
fn sliceNeedsConcealment(sliceIndex: u32, sliceCount: u32) -> bool {
    let slice = sliceBase(sliceIndex);
    if (!slicePrepared(slice)) {
        return true;
    }
    let outcomeWord = pictureState[slice + SLICE_END_MACROBLOCK];
    if ((outcomeWord >> SLICE_OUTCOME_SHIFT) != SLICE_OUTCOME_ENDED) {
        return true;
    }
    let pictureIndex = pictureState[slice + SLICE_POSITION] & 1u;
    let picture = pictureBase(pictureIndex);
    let start = sliceStart(slice);
    if (sliceIndex == pictureState[picture + PICTURE_FIRST_SLICE] && start != 0u) {
        reportConcealment(ERROR_SLICE_COVERAGE, pictureMacroblockPosition(pictureIndex, 0u));
        return true;
    }
    let end = outcomeWord & SLICE_END_INDEX_MASK;
    if (sliceIndex + 1u < sliceCount) {
        let next = sliceBase(sliceIndex + 1u);
        if ((pictureState[next + SLICE_POSITION] & 1u) == pictureIndex) {
            if (!slicePrepared(next)) {
                return true;
            }
            let nextStart = sliceStart(next);
            if (nextStart != end) {
                reportConcealment(ERROR_SLICE_COVERAGE, pictureMacroblockPosition(pictureIndex, min(nextStart, end)));
                return true;
            }
            return false;
        }
    }
    if (end != pictureState[picture + PICTURE_MACROBLOCK_COUNT] && !missingRowsTolerated(pictureIndex, end)) {
        reportConcealment(ERROR_SLICE_COVERAGE, pictureMacroblockPosition(pictureIndex, end));
        return true;
    }
    return false;
}

// The record of the macroblock at an index of a picture's raster order
fn pictureMacroblockRecord(pictureIndex: u32, index: u32) -> u32 {
    let width = pictureState[CONTEXT_MACROBLOCK_WIDTH];
    return (pictureMacroblockRow(pictureIndex, index / width) * width + index % width) * MACROBLOCK_WORDS;
}

// A macroblock's status after ff_er_add_slice's calls for the picture's slices in order. The last slice whose range covers it decides:
// an ended slice covers through its last macroblock and marks an end there, a failed one through the macroblock it failed at and marks
// an error there, a range past the picture marks nothing, and each slice marks its start. No slice covering it leaves it uncovered.
// The slice that decoded it last owns its record; a second slice that decoded it means the slices raced on its record
fn composeMacroblockStatus(pictureIndex: u32, index: u32) {
    let picture = pictureBase(pictureIndex);
    let firstSlice = pictureState[picture + PICTURE_FIRST_SLICE];
    let count = pictureState[picture + PICTURE_MACROBLOCK_COUNT];
    var status = CONCEAL_UNCOVERED;
    var covered = false;
    var owner = 0u;
    var decoders = 0u;
    var sliceIndex = firstSlice + pictureState[picture + PICTURE_SLICE_COUNT];
    while (sliceIndex > firstSlice && decoders < 2u) {
        sliceIndex -= 1u;
        let slice = sliceBase(sliceIndex);
        if (!slicePrepared(slice)) {
            continue;
        }
        let outcomeWord = pictureState[slice + SLICE_END_MACROBLOCK];
        let outcome = outcomeWord >> SLICE_OUTCOME_SHIFT;
        let endIndex = outcomeWord & SLICE_END_INDEX_MASK;
        let start = sliceStart(slice);
        if (outcome == SLICE_OUTCOME_NONE || index < start) {
            continue;
        }
        var last = endIndex;
        var mark = CONCEAL_ERROR;
        if (outcome == SLICE_OUTCOME_ENDED) {
            last = endIndex - 1u;
            mark = CONCEAL_END;
        }
        if (!covered && index <= last) {
            covered = true;
            status = select(0u, mark, index == last && last < count) | select(0u, CONCEAL_SLICE_START, index == start);
        }
        // The macroblocks it decoded: a failed slice decoded none at its failure
        if (index < endIndex) {
            decoders += 1u;
            if (owner == 0u) {
                owner = sliceIndex + 1u;
            }
        }
    }
    if (decoders > 1u) {
        pictureState[PACKET_REDECODE] = 1u;
    }
    macroblocks[pictureMacroblockRecord(pictureIndex, index) + RECORD_CONCEALMENT] = status | (owner << CONCEAL_OWNER_SHIFT);
}

// The distance in decoded macroblocks before a damaged one that ff_er_frame_end's backward pass also marks damaged, and its reset value
const DAMAGE_DISTANCE: u32 = 50u;
const DAMAGE_DISTANCE_RESET: u32 = 9999999u;

// Marks each concealed picture's damaged macroblocks as ff_er_frame_end does, on the statuses composeMacroblocks composed. Its passes reset
// at each slice start, so each invocation takes the segments that start in its share of the macroblocks
@compute @workgroup_size(CHECK_WORKGROUP_SIZE)
fn markSegments(@builtin(local_invocation_index) localIndex: u32) {
    if (packetFailed()) {
        return;
    }
    let pictureCount = min(pictureState[PACKET_PICTURE_COUNT], MAXIMUM_PICTURES);
    for (var pictureIndex = 0u; pictureIndex < pictureCount; pictureIndex += 1u) {
        let picture = pictureBase(pictureIndex);
        if (pictureState[picture + PICTURE_DECODED] == 0u || pictureState[picture + PICTURE_CONCEALED] == 0u) {
            continue;
        }
        let count = pictureState[picture + PICTURE_MACROBLOCK_COUNT];
        let share = (count + CHECK_WORKGROUP_SIZE - 1u) / CHECK_WORKGROUP_SIZE;
        let first = min(localIndex * share, count);
        let last = min(first + share, count);
        for (var index = first; index < last; index += 1u) {
            if ((macroblocks[pictureMacroblockRecord(pictureIndex, index) + RECORD_CONCEALMENT] & CONCEAL_SLICE_START) != 0u) {
                markSegment(pictureIndex, index, count);
            }
        }
    }
}

// Whether FFmpeg's mbskip_table holds a decoded macroblock as skipped, which the backward pass does not count: every macroblock of a
// picture no other references, and a P picture's skipped ones
fn decodedMacroblockSkipped(pictureIndex: u32, record: u32) -> bool {
    let pictureType = pictureState[pictureBase(pictureIndex) + PICTURE_TYPE];
    if (pictureType == PICTURE_TYPE_B) {
        return true;
    }
    return pictureType == PICTURE_TYPE_P && (macroblocks[record + RECORD_FLAGS] & FLAG_SKIPPED) != 0u;
}

// ff_er_frame_end's passes over one segment, the macroblocks from a slice start to the next: those after its last end or error are
// damaged, so are those up to DAMAGE_DISTANCE decoded macroblocks before a damaged one, and those after a damaged one
fn markSegment(pictureIndex: u32, start: u32, count: u32) {
    var end = start + 1u;
    while (end < count && (macroblocks[pictureMacroblockRecord(pictureIndex, end) + RECORD_CONCEALMENT] & CONCEAL_SLICE_START) == 0u) {
        end += 1u;
    }
    var lastMark = end;
    for (var index = end; index > start;) {
        index -= 1u;
        if ((macroblocks[pictureMacroblockRecord(pictureIndex, index) + RECORD_CONCEALMENT] & (CONCEAL_ERROR | CONCEAL_END)) != 0u) {
            lastMark = index;
            break;
        }
    }
    for (var index = start; index < end; index += 1u) {
        let record = pictureMacroblockRecord(pictureIndex, index);
        let status = macroblocks[record + RECORD_CONCEALMENT];
        if ((status & CONCEAL_ERROR) != 0u || lastMark == end || index > lastMark) {
            macroblocks[record + RECORD_CONCEALMENT] = status | CONCEAL_DAMAGED;
        }
    }
    var distance = DAMAGE_DISTANCE_RESET;
    for (var index = end; index > start;) {
        index -= 1u;
        let record = pictureMacroblockRecord(pictureIndex, index);
        let status = macroblocks[record + RECORD_CONCEALMENT];
        if (!decodedMacroblockSkipped(pictureIndex, record)) {
            distance += 1u;
        }
        if ((status & CONCEAL_DAMAGED) != 0u) {
            distance = 0u;
        }
        if (distance < DAMAGE_DISTANCE) {
            macroblocks[record + RECORD_CONCEALMENT] = status | CONCEAL_DAMAGED;
        }
    }
    var damaged = false;
    for (var index = start; index < end; index += 1u) {
        let record = pictureMacroblockRecord(pictureIndex, index);
        let status = macroblocks[record + RECORD_CONCEALMENT];
        damaged = damaged || (status & CONCEAL_DAMAGED) != 0u;
        if (damaged) {
            macroblocks[record + RECORD_CONCEALMENT] = status | CONCEAL_DAMAGED;
        }
    }
}

// FFmpeg's mb_y of a row of a picture's raster order: field pictures interleave their rows by parity
fn pictureMacroblockRow(pictureIndex: u32, row: u32) -> u32 {
    let structure = pictureState[pictureBase(pictureIndex) + PICTURE_CODING_FIELDS + CODING_PICTURE_STRUCTURE];
    if (structure == STRUCTURE_FRAME) {
        return row;
    }
    return (row << 1u) + select(0u, 1u, structure == STRUCTURE_BOTTOM_FIELD);
}

// The failing value of the macroblock at an index of a picture's raster order, as macroblockPosition gives it
fn pictureMacroblockPosition(pictureIndex: u32, index: u32) -> u32 {
    let width = pictureState[CONTEXT_MACROBLOCK_WIDTH];
    return (pictureMacroblockRow(pictureIndex, index / width) << 12u) | (index % width);
}

// Whether the macroblocks from index on are ones an interlaced picture may lack: mpeg_decode_slice stops at a row below the
// visible height, and ff_er_frame_end ignores such a missing last row
fn missingRowsTolerated(pictureIndex: u32, index: u32) -> bool {
    let width = pictureState[CONTEXT_MACROBLOCK_WIDTH];
    if (index % width != 0u || pictureState[CONTEXT_PROGRESSIVE_SEQUENCE] != 0u) {
        return false;
    }
    return pictureMacroblockRow(pictureIndex, index / width) >= ((pictureState[CONTEXT_INITIALIZED_HEIGHT] + 15u) >> 4u);
}

// Reconstruction: one workgroup per macroblock of the current picture dequantizes its blocks' coefficients, runs FFmpeg's simple IDCT,
// predicts its samples as FFmpeg's mpegvideo_motion.c does, and writes them into the output slot; field pictures write every other line
const RECONSTRUCT_WORKGROUP_SIZE: u32 = 64u;
const MAXIMUM_BLOCKS: u32 = 12u;
const BLOCK_ROWS: u32 = 8u;
const LUMA_WORDS: u32 = 64u;

var<workgroup> macroblockTask: u32;
var<workgroup> reconstructRecord: array<u32, MACROBLOCK_WORDS>;
var<workgroup> blockCoefficients: array<i32, 768>;
var<workgroup> blockParity: array<atomic<u32>, MAXIMUM_BLOCKS>;

// FFmpeg's simple IDCT at 8 bits, simple_idct_template.c: cos(k * pi / 16) * sqrt(2) in 14 bits
const IDCT_W1: i32 = 22725;
const IDCT_W2: i32 = 21407;
const IDCT_W3: i32 = 19266;
const IDCT_W4: i32 = 16383;
const IDCT_W5: i32 = 12873;
const IDCT_W6: i32 = 8867;
const IDCT_W7: i32 = 4520;
const IDCT_ROW_SHIFT: u32 = 11u;
const IDCT_COLUMN_SHIFT: u32 = 20u;
const IDCT_DC_SHIFT: u32 = 3u;
// (1 << (IDCT_COLUMN_SHIFT - 1)) / IDCT_W4, the column pass's rounding folded into its DC term
const IDCT_COLUMN_ROUNDING: i32 = 32;

// The reference lines a prediction addresses: a field of the reference frame, or the whole frame
const REFERENCE_TOP_FIELD: u32 = 0u;
const REFERENCE_WHOLE_FRAME: u32 = 2u;
// A reference that names no slot but gray, as FFmpeg colors the dummy picture of a missing reference
const DUMMY_REFERENCE: u32 = 0x8000u;
const GRAY_SAMPLE: u32 = 128u;

// The picture being reconstructed
var<private> reconstructPictureBase: u32;
var<private> reconstructStructure: u32;
var<private> reconstructParity: u32;
var<private> reconstructFieldPicture: bool;
var<private> reconstructType: u32;
var<private> reconstructFirstField: bool;
var<private> reconstructForwardSlot: u32;
var<private> reconstructBackwardSlot: u32;
var<private> reconstructMacroblockWidth: u32;
var<private> reconstructMacroblockHeight: u32;
var<private> reconstructMirrorSlot: u32;
// The macroblock
var<private> recordFlags: u32;
var<private> recordCodedBlocks: u32;
var<private> recordIntra: bool;
var<private> recordFieldDCT: bool;
var<private> macroblockColumn: u32;
var<private> macroblockRow: u32;

// What a workgroup does for its macroblock: nothing, reconstructs a record, or computes its blocks' DCs for concealment
const MACROBLOCK_TASK_NONE: u32 = 0u;
const MACROBLOCK_TASK_RECONSTRUCT: u32 = 1u;
const MACROBLOCK_TASK_DC: u32 = 2u;

// The current picture's block, set by currentPictureMacroblock
var<private> currentPicture: u32;

// Whether the frame's macroblock at column and row belongs to the packet's current picture, which decoded
fn currentPictureMacroblock(column: u32, row: u32) -> bool {
    if (packetFailed()) {
        return false;
    }
    let pictureIndex = pictureState[PACKET_CURRENT_PICTURE];
    if (pictureIndex >= pictureState[PACKET_PICTURE_COUNT]) {
        return false;
    }
    currentPicture = pictureBase(pictureIndex);
    let structure = pictureState[currentPicture + PICTURE_CODING_FIELDS + CODING_PICTURE_STRUCTURE];
    if (pictureState[currentPicture + PICTURE_DECODED] == 0u || column >= pictureState[CONTEXT_MACROBLOCK_WIDTH]
        || row >= pictureState[CONTEXT_MACROBLOCK_HEIGHT]) {
        return false;
    }
    return structure == STRUCTURE_FRAME || (row & 1u) == structure - 1u;
}

// Fills the workgroup's record with a macroblock that predicts from the same place, with no residual: forward, and for a B picture
// backward too, from the references' fields of the picture's parity for a field picture
fn loadZeroMotionRecord(directions: u32) {
    for (var word = 0u; word < MACROBLOCK_WORDS; word += 1u) {
        reconstructRecord[word] = 0u;
    }
    let structure = pictureState[currentPicture + PICTURE_CODING_FIELDS + CODING_PICTURE_STRUCTURE];
    var flags = directions;
    if (structure != STRUCTURE_FRAME) {
        let parity = structure - 1u;
        flags |= (MOTION_FIELD << MOTION_TYPE_SHIFT) | (parity << FIELD_SELECT_SHIFT) | (parity << (FIELD_SELECT_SHIFT + 2u));
    }
    reconstructRecord[RECORD_FLAGS] = flags;
}

// Loads the workgroup's macroblock record for reconstructPicture: a concealed picture's damaged macroblocks are left to concealment.
// A macroblock no slice decoded, which checkSlices lets an unconcealed picture lack only in a missing last row, repeats the same place
// of the forward reference, or gray
fn loadReconstructRecord(column: u32, row: u32) -> u32 {
    if (!currentPictureMacroblock(column, row)) {
        return MACROBLOCK_TASK_NONE;
    }
    let record = (row * pictureState[CONTEXT_MACROBLOCK_WIDTH] + column) * MACROBLOCK_WORDS;
    let concealed = pictureState[currentPicture + PICTURE_CONCEALED] != 0u;
    if (concealed && (macroblocks[record + RECORD_CONCEALMENT] & CONCEAL_DAMAGED) != 0u) {
        return MACROBLOCK_TASK_NONE;
    }
    if (concealed || macroblocks[record + RECORD_SERIAL] == packet.index) {
        for (var word = 0u; word < MACROBLOCK_WORDS; word += 1u) {
            reconstructRecord[word] = macroblocks[record + word];
        }
        return MACROBLOCK_TASK_RECONSTRUCT;
    }
    loadZeroMotionRecord(FLAG_FORWARD);
    return MACROBLOCK_TASK_RECONSTRUCT;
}

// The task of the workgroup's macroblock in concealMacroblocks: a damaged macroblock taken for an inter one predicts from the same
// place, as ff_er_frame_end conceals one without motion vectors, MPEG-2's case: forward, both ways in a B picture. With damaged
// macroblocks taken for intra ones, each undamaged macroblock computes its blocks' DCs, which concealIntra guesses theirs from
fn loadConcealmentTask(column: u32, row: u32) -> u32 {
    if (!currentPictureMacroblock(column, row) || pictureState[currentPicture + PICTURE_CONCEALED] == 0u) {
        return MACROBLOCK_TASK_NONE;
    }
    let record = (row * pictureState[CONTEXT_MACROBLOCK_WIDTH] + column) * MACROBLOCK_WORDS;
    let damaged = (macroblocks[record + RECORD_CONCEALMENT] & CONCEAL_DAMAGED) != 0u;
    let intra = pictureState[currentPicture + PICTURE_CONCEAL_INTRA] != 0u;
    if (!damaged) {
        return select(MACROBLOCK_TASK_NONE, MACROBLOCK_TASK_DC, intra);
    }
    if (intra) {
        return MACROBLOCK_TASK_NONE;
    }
    var directions = FLAG_FORWARD;
    if (pictureState[currentPicture + PICTURE_TYPE] == PICTURE_TYPE_B) {
        directions |= FLAG_BACKWARD;
    }
    loadZeroMotionRecord(directions);
    return MACROBLOCK_TASK_RECONSTRUCT;
}

fn recordBlockEntryCount(block: u32) -> u32 {
    return (reconstructRecord[RECORD_BLOCK_COUNTS + (block >> 2u)] >> ((block & 3u) * 8u)) & 0xFFu;
}

fn blockCoded(block: u32) -> bool {
    return recordIntra || ((recordCodedBlocks >> block) & 1u) != 0u;
}

// A coefficient entry dequantized as FFmpeg's block decoders dequantize, into its raster position and int16 value
fn dequantize(entry: u32, block: u32) -> vec2i {
    let scanPosition = entry & ENTRY_POSITION_MASK;
    let level = bitcast<i32>(entry) >> ENTRY_LEVEL_SHIFT;
    let fields = reconstructPictureBase + PICTURE_CODING_FIELDS;
    let mpeg2 = pictureState[reconstructPictureBase + PICTURE_MPEG2] != 0u;
    var scan = TABLE_ZIGZAG_SCAN;
    if (pictureState[fields + CODING_ALTERNATE_SCAN] != 0u) {
        scan = TABLE_ALTERNATE_SCAN;
    }
    let position = lookupWord(scan + scanPosition);
    let matrices = reconstructPictureBase + PICTURE_MATRICES;
    var value: i32;
    if (recordIntra && scanPosition == 0u) {
        // The DC as the prediction left it: MPEG-2 scales it by its precision, MPEG-1 by the intra matrix's DC weight
        if (mpeg2) {
            value = level * (1 << (3u - pictureState[fields + CODING_INTRA_DC_PRECISION]));
        } else {
            value = level * i32(pictureState[matrices + MATRIX_INTRA]);
        }
    } else {
        let chroma = mpeg2 && block >= 4u;
        var matrix = select(MATRIX_NON_INTRA, MATRIX_CHROMA_NON_INTRA, chroma);
        if (recordIntra) {
            matrix = select(MATRIX_INTRA, MATRIX_CHROMA_INTRA, chroma);
        }
        let weight = i32(pictureState[matrices + matrix + position]);
        let quantizer = i32((recordFlags >> QUANTIZER_SHIFT) & QUANTIZER_MASK);
        let magnitude = abs(level);
        if (recordIntra) {
            value = (magnitude * quantizer * weight) >> 4u;
        } else {
            value = ((magnitude * 2 + 1) * quantizer * weight) >> 5u;
        }
        // MPEG-1 makes every reconstructed level odd
        if (!mpeg2) {
            value = (value - 1) | 1;
        }
        if (level < 0) {
            value = -value;
        }
    }
    return vec2i(i32(position), wrapInt16(value));
}

// idctRowCondDC: one row, kept in int16; a row with only its DC fills with the DC scaled.
// The even part sums the even coefficients' cosines, the odd part the odd ones'; their sum and difference are the outputs
fn transformRow(block: u32, row: u32) {
    let base = block * COEFFICIENTS_PER_BLOCK + row * BLOCK_ROWS;
    let coefficient0 = blockCoefficients[base];
    let coefficient1 = blockCoefficients[base + 1u];
    let coefficient2 = blockCoefficients[base + 2u];
    let coefficient3 = blockCoefficients[base + 3u];
    let coefficient4 = blockCoefficients[base + 4u];
    let coefficient5 = blockCoefficients[base + 5u];
    let coefficient6 = blockCoefficients[base + 6u];
    let coefficient7 = blockCoefficients[base + 7u];
    if ((coefficient1 | coefficient2 | coefficient3 | coefficient4 | coefficient5 | coefficient6 | coefficient7) == 0) {
        let dc = wrapInt16(coefficient0 << IDCT_DC_SHIFT);
        for (var column = 0u; column < BLOCK_ROWS; column += 1u) {
            blockCoefficients[base + column] = dc;
        }
        return;
    }
    var even0 = IDCT_W4 * coefficient0 + (1 << (IDCT_ROW_SHIFT - 1u));
    var even1 = even0;
    var even2 = even0;
    var even3 = even0;
    even0 += IDCT_W2 * coefficient2 + IDCT_W4 * coefficient4 + IDCT_W6 * coefficient6;
    even1 += IDCT_W6 * coefficient2 - IDCT_W4 * coefficient4 - IDCT_W2 * coefficient6;
    even2 += -IDCT_W6 * coefficient2 - IDCT_W4 * coefficient4 + IDCT_W2 * coefficient6;
    even3 += -IDCT_W2 * coefficient2 + IDCT_W4 * coefficient4 - IDCT_W6 * coefficient6;
    let odd0 = IDCT_W1 * coefficient1 + IDCT_W3 * coefficient3 + IDCT_W5 * coefficient5 + IDCT_W7 * coefficient7;
    let odd1 = IDCT_W3 * coefficient1 - IDCT_W7 * coefficient3 - IDCT_W1 * coefficient5 - IDCT_W5 * coefficient7;
    let odd2 = IDCT_W5 * coefficient1 - IDCT_W1 * coefficient3 + IDCT_W7 * coefficient5 + IDCT_W3 * coefficient7;
    let odd3 = IDCT_W7 * coefficient1 - IDCT_W5 * coefficient3 + IDCT_W3 * coefficient5 - IDCT_W1 * coefficient7;
    blockCoefficients[base] = wrapInt16((even0 + odd0) >> IDCT_ROW_SHIFT);
    blockCoefficients[base + 1u] = wrapInt16((even1 + odd1) >> IDCT_ROW_SHIFT);
    blockCoefficients[base + 2u] = wrapInt16((even2 + odd2) >> IDCT_ROW_SHIFT);
    blockCoefficients[base + 3u] = wrapInt16((even3 + odd3) >> IDCT_ROW_SHIFT);
    blockCoefficients[base + 4u] = wrapInt16((even3 - odd3) >> IDCT_ROW_SHIFT);
    blockCoefficients[base + 5u] = wrapInt16((even2 - odd2) >> IDCT_ROW_SHIFT);
    blockCoefficients[base + 6u] = wrapInt16((even1 - odd1) >> IDCT_ROW_SHIFT);
    blockCoefficients[base + 7u] = wrapInt16((even0 - odd0) >> IDCT_ROW_SHIFT);
}

// idctSparseColPut and idctSparseColAdd's column pass: the sample of an intra block before its clip, or the residual an inter block adds
fn transformColumn(block: u32, column: u32) {
    let base = block * COEFFICIENTS_PER_BLOCK + column;
    let coefficient0 = blockCoefficients[base];
    let coefficient1 = blockCoefficients[base + 8u];
    let coefficient2 = blockCoefficients[base + 16u];
    let coefficient3 = blockCoefficients[base + 24u];
    let coefficient4 = blockCoefficients[base + 32u];
    let coefficient5 = blockCoefficients[base + 40u];
    let coefficient6 = blockCoefficients[base + 48u];
    let coefficient7 = blockCoefficients[base + 56u];
    var even0 = IDCT_W4 * (coefficient0 + IDCT_COLUMN_ROUNDING);
    var even1 = even0;
    var even2 = even0;
    var even3 = even0;
    even0 += IDCT_W2 * coefficient2 + IDCT_W4 * coefficient4 + IDCT_W6 * coefficient6;
    even1 += IDCT_W6 * coefficient2 - IDCT_W4 * coefficient4 - IDCT_W2 * coefficient6;
    even2 += -IDCT_W6 * coefficient2 - IDCT_W4 * coefficient4 + IDCT_W2 * coefficient6;
    even3 += -IDCT_W2 * coefficient2 + IDCT_W4 * coefficient4 - IDCT_W6 * coefficient6;
    let odd0 = IDCT_W1 * coefficient1 + IDCT_W3 * coefficient3 + IDCT_W5 * coefficient5 + IDCT_W7 * coefficient7;
    let odd1 = IDCT_W3 * coefficient1 - IDCT_W7 * coefficient3 - IDCT_W1 * coefficient5 - IDCT_W5 * coefficient7;
    let odd2 = IDCT_W5 * coefficient1 - IDCT_W1 * coefficient3 + IDCT_W7 * coefficient5 + IDCT_W3 * coefficient7;
    let odd3 = IDCT_W7 * coefficient1 - IDCT_W5 * coefficient3 + IDCT_W3 * coefficient5 - IDCT_W1 * coefficient7;
    blockCoefficients[base] = (even0 + odd0) >> IDCT_COLUMN_SHIFT;
    blockCoefficients[base + 8u] = (even1 + odd1) >> IDCT_COLUMN_SHIFT;
    blockCoefficients[base + 16u] = (even2 + odd2) >> IDCT_COLUMN_SHIFT;
    blockCoefficients[base + 24u] = (even3 + odd3) >> IDCT_COLUMN_SHIFT;
    blockCoefficients[base + 32u] = (even3 - odd3) >> IDCT_COLUMN_SHIFT;
    blockCoefficients[base + 40u] = (even2 - odd2) >> IDCT_COLUMN_SHIFT;
    blockCoefficients[base + 48u] = (even1 - odd1) >> IDCT_COLUMN_SHIFT;
    blockCoefficients[base + 56u] = (even0 - odd0) >> IDCT_COLUMN_SHIFT;
}

// The block and raster position of a macroblock sample: field DCT puts each field's lines in their own blocks, and 4:2:2 and 4:4:4
// chroma follow the luma's DCT type
fn residualIndex(plane: u32, x: u32, row: u32) -> vec2u {
    var verticalBlock = row >> 3u;
    var blockRow = row & 7u;
    if (recordFieldDCT && (plane == 0u || OUTPUT_CHROMA_FORMAT != CHROMA_420)) {
        verticalBlock = row & 1u;
        blockRow = row >> 1u;
    }
    var block: u32;
    if (plane == 0u) {
        block = (x >> 3u) + 2u * verticalBlock;
    } else if (OUTPUT_CHROMA_FORMAT == CHROMA_420) {
        block = 3u + plane;
    } else if (OUTPUT_CHROMA_FORMAT == CHROMA_422) {
        block = 3u + plane + 2u * verticalBlock;
    } else {
        block = 3u + plane + 2u * verticalBlock + 4u * (x >> 3u);
    }
    return vec2u(block, blockRow * BLOCK_ROWS + (x & 7u));
}

// One reference sample at plane coordinates; field lines interleave in the reference frame. A slot of 0 or DUMMY_REFERENCE is gray.
// Positions clamp to the plane, or to the field's lines, as edges extend; only a vector out of the picture, which concealment
// predicts from the clamped edge, reaches past them
fn referenceSample(reference: u32, field: u32, plane: u32, x: i32, line: i32) -> i32 {
    if (reference == 0u || reference == DUMMY_REFERENCE) {
        return i32(GRAY_SAMPLE);
    }
    let planeLayout = stream.planes[plane];
    let clampedX = u32(clamp(x, 0, i32(planeLayout.width) - 1));
    var clampedLine = u32(clamp(line, 0, i32(planeLayout.height) - 1));
    if (field != REFERENCE_WHOLE_FRAME) {
        clampedLine = u32(clamp(line, 0, i32(planeLayout.height / 2u) - 1)) * 2u + field;
    }
    return i32(readSlotSample(reference - 1u, plane, clampedX, clampedLine));
}

// The four predicted samples of one prediction from (x, line) of a plane, half-sample interpolated as FFmpeg's put_pixels rounds
fn predictFour(reference: u32, field: u32, plane: u32, x: i32, line: i32, halfX: bool, halfY: bool) -> vec4u {
    var samples = vec4u(0u);
    for (var offset = 0; offset < 4; offset += 1) {
        let a = referenceSample(reference, field, plane, x + offset, line);
        var value = a;
        if (halfX && halfY) {
            let b = referenceSample(reference, field, plane, x + offset + 1, line);
            let c = referenceSample(reference, field, plane, x + offset, line + 1);
            let d = referenceSample(reference, field, plane, x + offset + 1, line + 1);
            value = (a + b + c + d + 2) >> 2u;
        } else if (halfX) {
            value = (a + referenceSample(reference, field, plane, x + offset + 1, line) + 1) >> 1u;
        } else if (halfY) {
            value = (a + referenceSample(reference, field, plane, x + offset, line + 1) + 1) >> 1u;
        }
        samples[offset] = u32(value);
    }
    return samples;
}

fn unpackVector(word: u32) -> vec2i {
    return vec2i(bitcast<i32>(word << 16u) >> 16u, bitcast<i32>(word) >> 16u);
}

// The predictions of a word's four samples: one, two to average, or none that FFmpeg skips
struct Prediction {
    samples: vec4u,
    valid: bool,
}

// One prediction of four samples of a plane's row of the macroblock: the reference, its lines, the vector, the luma line its rows start
// at before the vector, the row within its rows, and its luma height for FFmpeg's out-of-picture check, which skips the prediction
fn predictOperation(reference: u32, field: u32, vector: vec2i, lumaLineBase: i32, rowInGroup: u32, lumaHeight: i32, verticalEdge: i32,
    plane: u32, xInMacroblock: u32) -> Prediction {
    var prediction: Prediction;
    let horizontalEdge = i32(reconstructMacroblockWidth * 16u);
    let lumaX = i32(macroblockColumn * 16u) + (vector.x >> 1u);
    let lumaY = lumaLineBase + (vector.y >> 1u);
    let xLimit = max(horizontalEdge - (vector.x & 1) - 15, 0);
    let yLimit = max(verticalEdge - (vector.y & 1) - lumaHeight + 1, 0);
    if (u32(lumaX) >= u32(xLimit) || u32(lumaY) >= u32(yLimit)) {
        // A vector may not leave the reference. FFmpeg skips such a prediction and keeps whatever its frame buffer held, which is no
        // defined result; this one predicts from the reference's edge, which the clamped positions extend, and counts as concealed
        reportConcealment(ERROR_MOTION_VECTOR, (macroblockRow << 12u) | macroblockColumn);
    }
    prediction.valid = true;
    if (plane == 0u || OUTPUT_CHROMA_FORMAT == CHROMA_444) {
        prediction.samples = predictFour(reference, field, plane, i32(macroblockColumn * 16u + xInMacroblock) + (vector.x >> 1u),
            lumaY + i32(rowInGroup), (vector.x & 1) != 0, (vector.y & 1) != 0);
        return prediction;
    }
    // Chroma vectors halve toward zero, as C divides
    let chromaX = vector.x / 2;
    let x = i32(macroblockColumn * 8u + xInMacroblock) + (chromaX >> 1u);
    if (OUTPUT_CHROMA_FORMAT == CHROMA_422) {
        prediction.samples = predictFour(reference, field, plane, x, lumaY + i32(rowInGroup), (chromaX & 1) != 0, (vector.y & 1) != 0);
        return prediction;
    }
    let chromaY = vector.y / 2;
    let line = (lumaLineBase >> 1u) + (chromaY >> 1u) + i32(rowInGroup);
    prediction.samples = predictFour(reference, field, plane, x, line, (chromaX & 1) != 0, (chromaY & 1) != 0);
    return prediction;
}

fn recordVector(index: u32) -> vec2i {
    return unpackVector(reconstructRecord[RECORD_VECTORS + index]);
}

fn recordFieldSelect(direction: u32, index: u32) -> u32 {
    return (recordFlags >> (FIELD_SELECT_SHIFT + direction * 2u + index)) & 1u;
}

// The reference of a field picture's forward prediction from a field: the current frame's first field when a P picture's second field
// predicts from the opposite parity, as FFmpeg's field and 16x8 cases choose
fn forwardFieldReference(fieldSelect: u32) -> u32 {
    if (reconstructType != PICTURE_TYPE_B && !reconstructFirstField && fieldSelect != reconstructParity) {
        return packet.outputSlot + 1u;
    }
    return reconstructForwardSlot;
}

// Averages a second prediction into a first, as FFmpeg's avg_pixels follows its put_pixels; a skipped one leaves what was there
fn combinePredictions(first: Prediction, second: Prediction, stale: vec4u) -> vec4u {
    var result = select(stale, first.samples, first.valid);
    if (second.valid) {
        result = (result + second.samples + vec4u(1u)) >> vec4u(1u);
    }
    return result;
}

// The predicted samples of a word of the macroblock: rowInMacroblock is the row within the macroblock's rows of the plane in the picture
fn predictWord(plane: u32, rowInMacroblock: u32, xInMacroblock: u32, planeRows: u32, stale: vec4u) -> vec4u {
    let motionType = (recordFlags >> MOTION_TYPE_SHIFT) & MOTION_TYPE_MASK;
    let forward = (recordFlags & FLAG_FORWARD) != 0u;
    let backward = (recordFlags & FLAG_BACKWARD) != 0u;
    var first: Prediction;
    var second: Prediction;
    first.valid = false;
    second.valid = false;
    let chroma420 = plane != 0u && OUTPUT_CHROMA_FORMAT == CHROMA_420;
    // A plane row's luma row, for choosing the macroblock half of 16x8 motion
    let lumaRow = select(rowInMacroblock, rowInMacroblock * 2u, chroma420);
    if (!reconstructFieldPicture) {
        let frameEdge = i32(reconstructMacroblockHeight * 16u);
        let fieldEdge = i32(reconstructMacroblockHeight * 8u);
        if (motionType == MOTION_FRAME) {
            let lineBase = i32(macroblockRow * 16u);
            if (forward) {
                first = predictOperation(reconstructForwardSlot, REFERENCE_WHOLE_FRAME, recordVector(0u), lineBase, rowInMacroblock, 16, frameEdge,
                    plane, xInMacroblock);
            }
            if (backward) {
                let prediction = predictOperation(reconstructBackwardSlot, REFERENCE_WHOLE_FRAME, recordVector(2u), lineBase, rowInMacroblock, 16,
                    frameEdge, plane, xInMacroblock);
                if (forward) {
                    second = prediction;
                } else {
                    first = prediction;
                }
            }
        } else {
            // Field motion and dual prime predict each field of the macroblock, a line of each parity, from 8 field lines
            let parity = rowInMacroblock & 1u;
            let rowInField = rowInMacroblock >> 1u;
            let lineBase = i32(macroblockRow * 8u);
            if (motionType == MOTION_DUAL_PRIME) {
                first = predictOperation(reconstructForwardSlot, parity, recordVector(parity), lineBase, rowInField, 8, fieldEdge, plane,
                    xInMacroblock);
                second = predictOperation(reconstructForwardSlot, 1u - parity, recordVector(2u + parity), lineBase, rowInField, 8, fieldEdge, plane,
                    xInMacroblock);
            } else {
                if (forward) {
                    first = predictOperation(reconstructForwardSlot, recordFieldSelect(0u, parity), recordVector(parity), lineBase, rowInField, 8,
                        fieldEdge, plane, xInMacroblock);
                }
                if (backward) {
                    let prediction = predictOperation(reconstructBackwardSlot, recordFieldSelect(1u, parity), recordVector(2u + parity), lineBase,
                        rowInField, 8, fieldEdge, plane, xInMacroblock);
                    if (forward) {
                        second = prediction;
                    } else {
                        first = prediction;
                    }
                }
            }
        }
        return combinePredictions(first, second, stale);
    }
    // Field pictures address their reference fields' lines, from the macroblock's field row
    let fieldEdge = i32(reconstructMacroblockHeight * 8u);
    let fieldRow = macroblockRow >> 1u;
    if (motionType == MOTION_DUAL_PRIME) {
        let lineBase = i32(fieldRow * 16u);
        var opposite = reconstructForwardSlot;
        if (!reconstructFirstField) {
            opposite = packet.outputSlot + 1u;
        }
        first = predictOperation(reconstructForwardSlot, reconstructParity, recordVector(0u), lineBase, rowInMacroblock, 16, fieldEdge, plane,
            xInMacroblock);
        second = predictOperation(opposite, 1u - reconstructParity, recordVector(2u), lineBase, rowInMacroblock, 16, fieldEdge, plane,
            xInMacroblock);
        return combinePredictions(first, second, stale);
    }
    var half = 0u;
    var lineBase = i32(fieldRow * 16u);
    var rowInGroup = rowInMacroblock;
    var lumaHeight = 16;
    if (motionType == MOTION_16X8) {
        half = select(0u, 1u, lumaRow >= 8u);
        lineBase += i32(half * 8u);
        rowInGroup = rowInMacroblock - half * (planeRows / 2u);
        lumaHeight = 8;
    }
    if (forward) {
        let fieldSelect = recordFieldSelect(0u, half);
        first = predictOperation(forwardFieldReference(fieldSelect), fieldSelect, recordVector(half), lineBase, rowInGroup, lumaHeight, fieldEdge,
            plane, xInMacroblock);
    }
    if (backward) {
        let prediction = predictOperation(reconstructBackwardSlot, recordFieldSelect(1u, half), recordVector(2u + half), lineBase, rowInGroup,
            lumaHeight, fieldEdge, plane, xInMacroblock);
        if (forward) {
            second = prediction;
        } else {
            first = prediction;
        }
    }
    return combinePredictions(first, second, stale);
}

// The output row of a plane's row of the macroblock: field pictures write their field's lines of the frame
fn outputRow(rowInMacroblock: u32, planeRows: u32) -> u32 {
    if (!reconstructFieldPicture) {
        return macroblockRow * planeRows + rowInMacroblock;
    }
    return ((macroblockRow >> 1u) * planeRows + rowInMacroblock) * 2u + reconstructParity;
}

// Writes one word of four samples: prediction, residual, and FFmpeg's clip
fn writeMacroblockWord(word: u32) {
    var plane = 0u;
    var planeWidth = 16u;
    var planeRows = 16u;
    var wordInPlane = word;
    if (word >= LUMA_WORDS) {
        planeWidth = select(8u, 16u, OUTPUT_CHROMA_FORMAT == CHROMA_444);
        planeRows = select(16u, 8u, OUTPUT_CHROMA_FORMAT == CHROMA_420);
        let chromaWords = planeWidth / 4u * planeRows;
        plane = 1u + (word - LUMA_WORDS) / chromaWords;
        wordInPlane = (word - LUMA_WORDS) % chromaWords;
    }
    let wordsPerRow = planeWidth / 4u;
    let rowInMacroblock = wordInPlane / wordsPerRow;
    let xInMacroblock = (wordInPlane % wordsPerRow) * 4u;
    let row = outputRow(rowInMacroblock, planeRows);
    let x = macroblockColumn * planeWidth + xInMacroblock;
    var predicted = vec4u(0u);
    if (!recordIntra) {
        var stale = vec4u(0u);
        for (var offset = 0u; offset < 4u; offset += 1u) {
            stale[offset] = readOutputSample(plane, x + offset, row);
        }
        predicted = predictWord(plane, rowInMacroblock, xInMacroblock, planeRows, stale);
    }
    var samples = vec4u(0u);
    for (var offset = 0u; offset < 4u; offset += 1u) {
        let residual = residualIndex(plane, xInMacroblock + offset, rowInMacroblock);
        if (recordIntra) {
            samples[offset] = clipSample(blockCoefficients[residual.x * COEFFICIENTS_PER_BLOCK + residual.y]);
        } else if (((recordCodedBlocks >> residual.x) & 1u) != 0u) {
            samples[offset] = clipSample(i32(predicted[offset]) + blockCoefficients[residual.x * COEFFICIENTS_PER_BLOCK + residual.y]);
        } else {
            samples[offset] = predicted[offset];
        }
    }
    writeOutputSamples8(plane, x, row, samples);
    if (reconstructMirrorSlot != 0u) {
        framePool[getSampleByteAddress(reconstructMirrorSlot - 1u, plane, x, row) >> 2u] = samples.x | (samples.y << 8u) | (samples.z << 16u)
            | (samples.w << 24u);
    }
}

@compute @workgroup_size(RECONSTRUCT_WORKGROUP_SIZE)
fn reconstructPicture(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    if (localIndex == 0u) {
        macroblockTask = loadReconstructRecord(workgroupId.x, workgroupId.y);
    }
    if (localIndex < MAXIMUM_BLOCKS) {
        atomicStore(&blockParity[localIndex], 0u);
    }
    if (workgroupUniformLoad(&macroblockTask) != MACROBLOCK_TASK_RECONSTRUCT) {
        return;
    }
    reconstructMacroblock(workgroupId.x, workgroupId.y, localIndex);
}

// Reconstructs the workgroup's macroblock from the record its first invocation loaded: dequantization, the IDCT, prediction, output.
// Call it from uniform control flow, after blockParity is cleared
fn reconstructMacroblock(column: u32, row: u32, localIndex: u32) {
    macroblockColumn = column;
    macroblockRow = row;
    reconstructPictureBase = pictureBase(pictureState[PACKET_CURRENT_PICTURE]);
    reconstructStructure = pictureState[reconstructPictureBase + PICTURE_CODING_FIELDS + CODING_PICTURE_STRUCTURE];
    reconstructFieldPicture = reconstructStructure != STRUCTURE_FRAME;
    reconstructParity = (reconstructStructure - 1u) & 1u;
    reconstructType = pictureState[reconstructPictureBase + PICTURE_TYPE];
    reconstructFirstField = pictureState[reconstructPictureBase + PICTURE_FIRST_FIELD] != 0u;
    reconstructForwardSlot = pictureState[reconstructPictureBase + PICTURE_FORWARD_SLOT];
    reconstructBackwardSlot = pictureState[reconstructPictureBase + PICTURE_BACKWARD_SLOT];
    reconstructMacroblockWidth = pictureState[CONTEXT_MACROBLOCK_WIDTH];
    reconstructMacroblockHeight = pictureState[CONTEXT_MACROBLOCK_HEIGHT];
    reconstructMirrorSlot = pictureState[PACKET_MIRROR_SLOT];
    recordFlags = reconstructRecord[RECORD_FLAGS];
    recordIntra = (recordFlags & FLAG_INTRA) != 0u;
    recordFieldDCT = (recordFlags & FLAG_FIELD_DCT) != 0u;
    recordCodedBlocks = (recordFlags >> CODED_BLOCKS_SHIFT) & CODED_BLOCKS_MASK;
    let blocks = blocksPerMacroblock(OUTPUT_CHROMA_FORMAT);
    let mpeg2 = pictureState[reconstructPictureBase + PICTURE_MPEG2] != 0u;
    // The coded blocks start from zero
    for (var index = localIndex; index < blocks * COEFFICIENTS_PER_BLOCK; index += RECONSTRUCT_WORKGROUP_SIZE) {
        blockCoefficients[index] = 0;
    }
    workgroupBarrier();
    // Each entry, dequantized into its block at its raster position, with the parity of the block's levels for mismatch control
    var entryCount = 0u;
    for (var block = 0u; block < blocks; block += 1u) {
        entryCount += recordBlockEntryCount(block);
    }
    let entryStart = reconstructRecord[RECORD_ENTRY_START];
    for (var entry = localIndex; entry < entryCount; entry += RECONSTRUCT_WORKGROUP_SIZE) {
        var block = 0u;
        var blockFirst = 0u;
        loop {
            let count = recordBlockEntryCount(block);
            if (entry < blockFirst + count || block + 1u >= blocks) {
                break;
            }
            blockFirst += count;
            block += 1u;
        }
        let coefficient = dequantize(coefficients[entryStart + entry], block);
        blockCoefficients[block * COEFFICIENTS_PER_BLOCK + u32(coefficient.x)] = coefficient.y;
        if (mpeg2) {
            atomicXor(&blockParity[block], bitcast<u32>(coefficient.y) & 1u);
        }
    }
    workgroupBarrier();
    // MPEG-2 mismatch control: a coded block whose levels sum to an even number toggles its last coefficient's lowest bit
    if (mpeg2 && localIndex < blocks && blockCoded(localIndex) && atomicLoad(&blockParity[localIndex]) == 0u) {
        let last = localIndex * COEFFICIENTS_PER_BLOCK + COEFFICIENTS_PER_BLOCK - 1u;
        blockCoefficients[last] = blockCoefficients[last] ^ 1;
    }
    workgroupBarrier();
    for (var task = localIndex; task < blocks * BLOCK_ROWS; task += RECONSTRUCT_WORKGROUP_SIZE) {
        if (blockCoded(task / BLOCK_ROWS)) {
            transformRow(task / BLOCK_ROWS, task % BLOCK_ROWS);
        }
    }
    workgroupBarrier();
    for (var task = localIndex; task < blocks * BLOCK_ROWS; task += RECONSTRUCT_WORKGROUP_SIZE) {
        if (blockCoded(task / BLOCK_ROWS)) {
            transformColumn(task / BLOCK_ROWS, task % BLOCK_ROWS);
        }
    }
    workgroupBarrier();
    let chromaWords = select(8u, 16u, OUTPUT_CHROMA_FORMAT == CHROMA_444) / 4u * select(16u, 8u, OUTPUT_CHROMA_FORMAT == CHROMA_420);
    let words = LUMA_WORDS + 2u * chromaWords;
    for (var word = localIndex; word < words; word += RECONSTRUCT_WORKGROUP_SIZE) {
        writeMacroblockWord(word);
    }
}

// Concealment of a concealed picture's damaged macroblocks after its reconstruction, as FFmpeg's ff_er_frame_end conceals a frame
// picture. FFmpeg's MPEG-2 decoder keeps no motion vectors for it, so every vector it guesses is zero: a damaged macroblock taken for an
// inter one predicts from the same place; one taken for an intra one gets DCs guessed from the nearest undamaged blocks, filtered for
// luma, as flat blocks; then the edges of damaged macroblocks with an intra side are smoothed.
// FFmpeg leaves field pictures unconcealed, holding whatever its buffer held; they are concealed the same way here, on their own lines,
// from the references' fields of their parity. FFmpeg also addresses 4:2:2 and 4:4:4 chroma as if it were 4:2:0, which leaves damaged
// macroblocks' chroma unconcealed and overwrites other macroblocks'; here each macroblock's own chroma blocks are concealed
const MACROBLOCK_SIZE: u32 = 16u;
const LUMA_BLOCKS: u32 = 4u;
// The words of an 8x8 block of 8-bit samples, and an 8-bit sample in each byte of a word
const BLOCK_WORDS: u32 = 16u;
const SAMPLE_REPLICATE: u32 = 0x01010101u;

// The concealed picture: its block, its macroblock columns and rows, whether it is a field picture and its parity, and the slot, plus one,
// of the frame its second field completes
var<private> concealPicture: u32;
var<private> concealWidth: u32;
var<private> concealRows: u32;
var<private> concealFieldPicture: bool;
var<private> concealParity: u32;
var<private> concealMirrorSlot: u32;

fn loadConcealedPicture() {
    concealPicture = pictureBase(pictureState[PACKET_CURRENT_PICTURE]);
    let structure = pictureState[concealPicture + PICTURE_CODING_FIELDS + CODING_PICTURE_STRUCTURE];
    concealFieldPicture = structure != STRUCTURE_FRAME;
    concealParity = (structure - 1u) & 1u;
    concealWidth = pictureState[CONTEXT_MACROBLOCK_WIDTH];
    concealRows = pictureState[CONTEXT_MACROBLOCK_HEIGHT] >> select(0u, 1u, concealFieldPicture);
    concealMirrorSlot = pictureState[PACKET_MIRROR_SLOT];
}

// The concealed picture's macroblock row of a frame macroblock row
fn concealPictureRow(frameRow: u32) -> u32 {
    return select(frameRow, frameRow >> 1u, concealFieldPicture);
}

// The frame line of a line of the concealed picture's plane
fn concealFrameLine(line: u32) -> u32 {
    return select(line, line * 2u + concealParity, concealFieldPicture);
}

// The record of the concealed picture's macroblock at a column and row of the picture
fn concealRecord(column: u32, row: u32) -> u32 {
    let frameRow = select(row, row * 2u + concealParity, concealFieldPicture);
    return (frameRow * concealWidth + column) * MACROBLOCK_WORDS;
}

fn macroblockDamaged(record: u32) -> bool {
    return (macroblocks[record + RECORD_CONCEALMENT] & CONCEAL_DAMAGED) != 0u;
}

// Whether ff_er_frame_end takes a macroblock for an intra one: a damaged one as decideConcealment guessed, an undamaged one as decoded
fn macroblockConcealedIntra(record: u32) -> bool {
    if (macroblockDamaged(record)) {
        return pictureState[concealPicture + PICTURE_CONCEAL_INTRA] != 0u;
    }
    return (macroblocks[record + RECORD_FLAGS] & FLAG_INTRA) != 0u;
}

// Whether the frame's macroblock at column and row belongs to the current picture, which is concealed
fn concealedPictureMacroblock(column: u32, row: u32) -> bool {
    return currentPictureMacroblock(column, row) && pictureState[currentPicture + PICTURE_CONCEALED] != 0u;
}

// A sample of a slot, plus one, at a line of the concealed picture's plane; a missing or dummy reference is gray
fn concealSample(slot: u32, plane: u32, x: u32, line: u32) -> i32 {
    if (slot == 0u || slot == DUMMY_REFERENCE) {
        return i32(GRAY_SAMPLE);
    }
    return i32(readSlotSample(slot - 1u, plane, x, concealFrameLine(line)));
}

// Four samples of the output slot at a line of the concealed picture's plane, from x, a multiple of 4
fn readConcealedWord(plane: u32, x: u32, line: u32) -> u32 {
    return framePool[getSampleByteAddress(packet.outputSlot, plane, x, concealFrameLine(line)) >> 2u];
}

// Writes four samples of the output slot, and of the frame a second field completes
fn writeConcealedWord(plane: u32, x: u32, line: u32, word: u32) {
    let frameLine = concealFrameLine(line);
    framePool[getSampleByteAddress(packet.outputSlot, plane, x, frameLine) >> 2u] = word;
    if (concealMirrorSlot != 0u) {
        framePool[getSampleByteAddress(concealMirrorSlot - 1u, plane, x, frameLine) >> 2u] = word;
    }
}

// The 8x8 blocks of a plane's macroblock across and down: luma's 2 by 2, and chroma's by the output's subsampling
fn blocksAcrossMacroblock(plane: u32) -> u32 {
    return select(1u, 2u, plane == 0u || OUTPUT_CHROMA_FORMAT == CHROMA_444);
}

fn blocksDownMacroblock(plane: u32) -> u32 {
    return select(1u, 2u, plane == 0u || OUTPUT_CHROMA_FORMAT != CHROMA_420);
}

// The record of the macroblock a block of the concealed picture's plane lies in, and the block's index in the macroblock
fn blockRecord(plane: u32, blockX: u32, blockY: u32) -> u32 {
    return concealRecord(blockX / blocksAcrossMacroblock(plane), blockY / blocksDownMacroblock(plane));
}

fn blockInMacroblock(plane: u32, blockX: u32, blockY: u32) -> u32 {
    let across = blocksAcrossMacroblock(plane);
    return blockX % across + (blockY % blocksDownMacroblock(plane)) * across;
}

// The DC concealMacroblocks stored for a block of an undamaged macroblock, a signed 16-bit value as FFmpeg's dc_val holds it
fn storedBlockDC(plane: u32, blockX: u32, blockY: u32) -> i32 {
    let block = blockInMacroblock(plane, blockX, blockY);
    let word = macroblocks[blockRecord(plane, blockX, blockY) + RECORD_DC + plane * RECORD_DC_PLANE_WORDS + (block >> 1u)];
    return bitcast<i32>(word << (16u * (1u - (block & 1u)))) >> 16u;
}

const DECIDE_WORKGROUP_SIZE: u32 = 256u;
// is_intra_more_likely takes damaged macroblocks for inter ones below this many undamaged ones, and samples about this many
const INTRA_GUESS_MINIMUM_UNDAMAGED: u32 = 5u;
const INTRA_GUESS_SAMPLES: u32 = 50u;

var<workgroup> decideTask: u32;
var<workgroup> decideForward: u32;
var<workgroup> decideUndamaged: u32;
var<workgroup> undamagedCount: atomic<u32>;
var<workgroup> sampledCounts: array<u32, DECIDE_WORKGROUP_SIZE>;
var<workgroup> intraVotes: atomic<i32>;

// Decides whether the current picture's damaged macroblocks are taken for intra ones, as is_intra_more_likely does, and dispatches
// the concealment passes over the frame's macroblocks when the picture is concealed
@compute @workgroup_size(DECIDE_WORKGROUP_SIZE)
fn decideConcealment(@builtin(local_invocation_index) localIndex: u32) {
    if (localIndex == 0u) {
        atomicStore(&undamagedCount, 0u);
        atomicStore(&intraVotes, 0);
        decideTask = 0u;
        setDispatchArguments(0u, 1u, 1u);
        let pictureIndex = pictureState[PACKET_CURRENT_PICTURE];
        if (!packetFailed() && pictureIndex < min(pictureState[PACKET_PICTURE_COUNT], MAXIMUM_PICTURES)) {
            let picture = pictureBase(pictureIndex);
            if (pictureState[picture + PICTURE_DECODED] != 0u && pictureState[picture + PICTURE_CONCEALED] != 0u) {
                decideTask = 1u;
                decideForward = pictureState[picture + PICTURE_FORWARD_SLOT];
                setDispatchArguments((stream.width + MACROBLOCK_SIZE - 1u) / MACROBLOCK_SIZE, (stream.height + MACROBLOCK_SIZE - 1u) / MACROBLOCK_SIZE, 1u);
            }
        }
    }
    if (workgroupUniformLoad(&decideTask) == 0u) {
        return;
    }
    loadConcealedPicture();
    let count = concealWidth * concealRows;
    var undamaged = 0u;
    for (var index = localIndex; index < count; index += DECIDE_WORKGROUP_SIZE) {
        if (!macroblockDamaged(concealRecord(index % concealWidth, index / concealWidth))) {
            undamaged += 1u;
        }
    }
    atomicAdd(&undamagedCount, undamaged);
    workgroupBarrier();
    if (localIndex == 0u) {
        decideUndamaged = atomicLoad(&undamagedCount);
    }
    let undamagedTotal = workgroupUniformLoad(&decideUndamaged);
    let forward = workgroupUniformLoad(&decideForward);
    // Without a previous picture concealment is spatial; with almost every macroblock damaged it is temporal
    var intra = forward == 0u;
    if (!intra && undamagedTotal >= INTRA_GUESS_MINIMUM_UNDAMAGED) {
        // Every skipAmount-th undamaged macroblock above the last row votes, in raster order
        let skipAmount = max(undamagedTotal / INTRA_GUESS_SAMPLES, 1u);
        let candidates = (concealRows - 1u) * concealWidth;
        let share = (candidates + DECIDE_WORKGROUP_SIZE - 1u) / DECIDE_WORKGROUP_SIZE;
        let first = min(localIndex * share, candidates);
        let last = min(first + share, candidates);
        var shareUndamaged = 0u;
        for (var index = first; index < last; index += 1u) {
            if (!macroblockDamaged(concealRecord(index % concealWidth, index / concealWidth))) {
                shareUndamaged += 1u;
            }
        }
        sampledCounts[localIndex] = shareUndamaged;
        workgroupBarrier();
        var position = 0u;
        for (var other = 0u; other < localIndex; other += 1u) {
            position += sampledCounts[other];
        }
        var votes = 0;
        for (var index = first; index < last; index += 1u) {
            let column = index % concealWidth;
            let row = index / concealWidth;
            if (macroblockDamaged(concealRecord(column, row))) {
                continue;
            }
            position += 1u;
            if (position % skipAmount == 0u) {
                votes += intraVote(column, row, forward);
            }
        }
        atomicAdd(&intraVotes, votes);
        workgroupBarrier();
        intra = atomicLoad(&intraVotes) > 0;
    }
    if (localIndex == 0u) {
        pictureState[concealPicture + PICTURE_CONCEAL_INTRA] = select(0u, 1u, intra);
    }
}

// A sampled undamaged macroblock's vote: in an I picture, by how much more it differs from the previous picture than that picture
// differs from itself a macroblock row down, the sums of absolute differences of their luma; otherwise 1 for intra and -1 for inter
fn intraVote(column: u32, row: u32, forward: u32) -> i32 {
    if (pictureState[concealPicture + PICTURE_TYPE] != PICTURE_TYPE_I) {
        return select(-1, 1, (macroblocks[concealRecord(column, row) + RECORD_FLAGS] & FLAG_INTRA) != 0u);
    }
    let left = column * MACROBLOCK_SIZE;
    let top = row * MACROBLOCK_SIZE;
    var difference = 0;
    for (var line = top; line < top + MACROBLOCK_SIZE; line += 1u) {
        for (var x = left; x < left + MACROBLOCK_SIZE; x += 1u) {
            let previous = concealSample(forward, 0u, x, line);
            difference += abs(previous - concealSample(packet.outputSlot + 1u, 0u, x, line));
            difference -= abs(previous - concealSample(forward, 0u, x, line + MACROBLOCK_SIZE));
        }
    }
    return difference;
}

// Conceals the damaged macroblocks taken for inter ones by predicting them from the same place; with damaged macroblocks taken for
// intra ones, stores each undamaged macroblock's block DCs instead, as ff_er_frame_end's fill pass computes them for guess_dc
@compute @workgroup_size(RECONSTRUCT_WORKGROUP_SIZE)
fn concealMacroblocks(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    if (localIndex == 0u) {
        macroblockTask = loadConcealmentTask(workgroupId.x, workgroupId.y);
    }
    if (localIndex < MAXIMUM_BLOCKS) {
        atomicStore(&blockParity[localIndex], 0u);
    }
    switch (workgroupUniformLoad(&macroblockTask)) {
        case MACROBLOCK_TASK_RECONSTRUCT: {
            reconstructMacroblock(workgroupId.x, workgroupId.y, localIndex);
        }
        case MACROBLOCK_TASK_DC: {
            storeMacroblockDC(workgroupId.x, workgroupId.y, localIndex);
        }
        default: {
        }
    }
}

// FFmpeg's DC of an 8x8 block of 8-bit samples: their sum, rounded, over 8
const DC_ROUNDING: u32 = 4u;
const DC_SHIFT: u32 = 3u;

// Stores the DC of each 8x8 block of an undamaged macroblock, summing a word of samples per invocation into blockParity's counters:
// luma's blocks first, then each chroma plane's
fn storeMacroblockDC(column: u32, frameRow: u32, localIndex: u32) {
    loadConcealedPicture();
    let row = concealPictureRow(frameRow);
    let chromaBlocks = blocksAcrossMacroblock(1u) * blocksDownMacroblock(1u);
    let taskCount = (LUMA_BLOCKS + 2u * chromaBlocks) * BLOCK_WORDS;
    for (var task = localIndex; task < taskCount; task += RECONSTRUCT_WORKGROUP_SIZE) {
        let counter = task / BLOCK_WORDS;
        let wordInBlock = task % BLOCK_WORDS;
        var plane = 0u;
        var block = counter;
        if (counter >= LUMA_BLOCKS) {
            plane = 1u + (counter - LUMA_BLOCKS) / chromaBlocks;
            block = (counter - LUMA_BLOCKS) % chromaBlocks;
        }
        let across = blocksAcrossMacroblock(plane);
        let x = (column * across + block % across) * BLOCK_ROWS + (wordInBlock & 1u) * 4u;
        let line = (row * blocksDownMacroblock(plane) + block / across) * BLOCK_ROWS + (wordInBlock >> 1u);
        let word = readConcealedWord(plane, x, line);
        atomicAdd(&blockParity[counter], (word & 0xFFu) + ((word >> 8u) & 0xFFu) + ((word >> 16u) & 0xFFu) + (word >> 24u));
    }
    workgroupBarrier();
    if (localIndex != 0u) {
        return;
    }
    var words = array<u32, 6>(0u, 0u, 0u, 0u, 0u, 0u);
    for (var counter = 0u; counter < LUMA_BLOCKS + 2u * chromaBlocks; counter += 1u) {
        var plane = 0u;
        var block = counter;
        if (counter >= LUMA_BLOCKS) {
            plane = 1u + (counter - LUMA_BLOCKS) / chromaBlocks;
            block = (counter - LUMA_BLOCKS) % chromaBlocks;
        }
        let dc = (atomicLoad(&blockParity[counter]) + DC_ROUNDING) >> DC_SHIFT;
        words[plane * RECORD_DC_PLANE_WORDS + (block >> 1u)] |= dc << (16u * (block & 1u));
    }
    let record = concealRecord(column, row);
    for (var word = 0u; word < 3u * RECORD_DC_PLANE_WORDS; word += 1u) {
        macroblocks[record + RECORD_DC + word] = words[word];
    }
}

// guess_dc's weights: 2^28 over the distance to the nearest undamaged block, at least 1, or a gray 1024 at distance 9999 without one;
// the weighted average needs 64 bits, and its quotient, a DC, fits these bits
const GUESS_WEIGHT_NUMERATOR: u32 = 268435456u;
const GUESS_DEFAULT_COLOR: u32 = 1024u;
const GUESS_DEFAULT_DISTANCE: u32 = 9999u;
const GUESS_QUOTIENT_BITS: u32 = 12u;

// 64-bit unsigned arithmetic on vec2u values, the low word first
fn add64(first: vec2u, second: vec2u) -> vec2u {
    let low = first.x + second.x;
    return vec2u(low, first.y + second.y + select(0u, 1u, low < first.x));
}

fn subtract64(first: vec2u, second: vec2u) -> vec2u {
    return vec2u(first.x - second.x, first.y - second.y - select(0u, 1u, first.x < second.x));
}

fn lessThan64(first: vec2u, second: vec2u) -> bool {
    return first.y < second.y || (first.y == second.y && first.x < second.x);
}

fn shiftLeft64(value: vec2u, shift: u32) -> vec2u {
    if (shift == 0u) {
        return value;
    }
    return vec2u(value.x << shift, (value.y << shift) | (value.x >> (32u - shift)));
}

// A 32-bit value times one below 2^16, in 64 bits
fn multiply64(value: u32, factor: u32) -> vec2u {
    let upper = (value >> 16u) * factor;
    return add64(vec2u(upper << 16u, upper >> 16u), vec2u((value & 0xFFFFu) * factor, 0u));
}

fn blockUndamaged(plane: u32, blockX: u32, blockY: u32) -> bool {
    return !macroblockDamaged(blockRecord(plane, blockX, blockY));
}

// guess_dc for a block of a damaged macroblock: the nearest undamaged block to its left, right, top, and bottom in its plane's block
// grid, weighted by the inverse of its distance, averaged with rounding
fn guessBlockDC(plane: u32, blockX: u32, blockY: u32) -> i32 {
    let across = concealWidth * blocksAcrossMacroblock(plane);
    let down = concealRows * blocksDownMacroblock(plane);
    var colors = array<u32, 4>(GUESS_DEFAULT_COLOR, GUESS_DEFAULT_COLOR, GUESS_DEFAULT_COLOR, GUESS_DEFAULT_COLOR);
    var distances = array<u32, 4>(GUESS_DEFAULT_DISTANCE, GUESS_DEFAULT_DISTANCE, GUESS_DEFAULT_DISTANCE, GUESS_DEFAULT_DISTANCE);
    for (var x = blockX; x > 0u;) {
        x -= 1u;
        if (blockUndamaged(plane, x, blockY)) {
            colors[0] = u32(storedBlockDC(plane, x, blockY));
            distances[0] = blockX - x;
            break;
        }
    }
    for (var x = blockX + 1u; x < across; x += 1u) {
        if (blockUndamaged(plane, x, blockY)) {
            colors[1] = u32(storedBlockDC(plane, x, blockY));
            distances[1] = x - blockX;
            break;
        }
    }
    for (var y = blockY; y > 0u;) {
        y -= 1u;
        if (blockUndamaged(plane, blockX, y)) {
            colors[2] = u32(storedBlockDC(plane, blockX, y));
            distances[2] = blockY - y;
            break;
        }
    }
    for (var y = blockY + 1u; y < down; y += 1u) {
        if (blockUndamaged(plane, blockX, y)) {
            colors[3] = u32(storedBlockDC(plane, blockX, y));
            distances[3] = y - blockY;
            break;
        }
    }
    var weightSum = 0u;
    var weighted = vec2u(0u);
    for (var direction = 0u; direction < 4u; direction += 1u) {
        let weight = GUESS_WEIGHT_NUMERATOR / max(distances[direction], 1u);
        weightSum += weight;
        weighted = add64(weighted, multiply64(weight, colors[direction]));
    }
    var remainder = add64(weighted, vec2u(weightSum / 2u, 0u));
    var quotient = 0u;
    for (var bit = GUESS_QUOTIENT_BITS; bit > 0u;) {
        bit -= 1u;
        let divisor = shiftLeft64(vec2u(weightSum, 0u), bit);
        if (!lessThan64(remainder, divisor)) {
            remainder = subtract64(remainder, divisor);
            quotient |= 1u << bit;
        }
    }
    return i32(quotient);
}

// The DC concealment uses for a block: stored for an undamaged macroblock's, guessed for a damaged one's
fn concealmentBlockDC(plane: u32, blockX: u32, blockY: u32) -> i32 {
    if (blockUndamaged(plane, blockX, blockY)) {
        return storedBlockDC(plane, blockX, blockY);
    }
    return guessBlockDC(plane, blockX, blockY);
}

// filter181's step on a DC and its neighbors in one direction, kept in 16 bits as FFmpeg's dc_val keeps it; the clip keeps the product
// in 32 bits
const FILTER_MINIMUM: i32 = -196602;
const FILTER_MAXIMUM: i32 = 163834;
const FILTER_SCALE: i32 = 10923;
const FILTER_ROUNDING: i32 = 32768;
const FILTER_SHIFT: u32 = 16u;

fn filterDC(previous: i32, current: i32, next: i32) -> i32 {
    let value = clamp(current * 8 - previous - next, FILTER_MINIMUM, FILTER_MAXIMUM);
    return wrapInt16((value * FILTER_SCALE + FILTER_ROUNDING) >> FILTER_SHIFT);
}

// put_dc's clip of a DC before it divides it by 8 into a sample
const MAXIMUM_DC: i32 = 2040;
const DC_SAMPLE_SCALE: u32 = 8u;
// The luma blocks around a macroblock's four, 4 by 4, which filter181 reads for them
const LUMA_NEIGHBORHOOD_WIDTH: u32 = 4u;
const LUMA_NEIGHBORHOOD_BLOCKS: u32 = 16u;

var<workgroup> lumaNeighborhood: array<i32, LUMA_NEIGHBORHOOD_BLOCKS>;
var<workgroup> chromaGuesses: array<i32, 8>;
var<workgroup> lumaFiltered: array<i32, LUMA_BLOCKS>;

// A luma DC of the workgroup's neighborhood, the blocks from one before its macroblock's to one after, both ways
fn neighborhoodDC(blockX: u32, blockY: u32, column: u32, row: u32) -> i32 {
    return lumaNeighborhood[(blockX + 1u - column * 2u) + (blockY + 1u - row * 2u) * LUMA_NEIGHBORHOOD_WIDTH];
}

// filter181's horizontal pass at a block, which skips the first and last rows and columns of the luma block grid
fn horizontallyFilteredDC(blockX: u32, blockY: u32, column: u32, row: u32, down: u32) -> i32 {
    if (blockY == 0u || blockY + 1u >= down) {
        return neighborhoodDC(blockX, blockY, column, row);
    }
    return filterDC(neighborhoodDC(blockX - 1u, blockY, column, row), neighborhoodDC(blockX, blockY, column, row),
        neighborhoodDC(blockX + 1u, blockY, column, row));
}

// filter181 at a block: its vertical pass over the horizontal pass's values, inside the grid's border
fn filteredLumaDC(blockX: u32, blockY: u32, column: u32, row: u32, across: u32, down: u32) -> i32 {
    if (blockX == 0u || blockX + 1u >= across || blockY == 0u || blockY + 1u >= down) {
        return neighborhoodDC(blockX, blockY, column, row);
    }
    return filterDC(horizontallyFilteredDC(blockX, blockY - 1u, column, row, down), horizontallyFilteredDC(blockX, blockY, column, row, down),
        horizontallyFilteredDC(blockX, blockY + 1u, column, row, down));
}

// Conceals a damaged macroblock taken for an intra one: guess_dc's DCs for its blocks and the luma ones around them, filter181 over
// luma's, and put_dc's flat blocks
@compute @workgroup_size(RECONSTRUCT_WORKGROUP_SIZE)
fn concealIntra(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    if (localIndex == 0u) {
        var task = MACROBLOCK_TASK_NONE;
        if (concealedPictureMacroblock(workgroupId.x, workgroupId.y) && pictureState[currentPicture + PICTURE_CONCEAL_INTRA] != 0u) {
            let record = (workgroupId.y * pictureState[CONTEXT_MACROBLOCK_WIDTH] + workgroupId.x) * MACROBLOCK_WORDS;
            task = select(MACROBLOCK_TASK_NONE, MACROBLOCK_TASK_DC, macroblockDamaged(record));
        }
        macroblockTask = task;
    }
    if (workgroupUniformLoad(&macroblockTask) == MACROBLOCK_TASK_NONE) {
        return;
    }
    loadConcealedPicture();
    let column = workgroupId.x;
    let row = concealPictureRow(workgroupId.y);
    let lumaAcross = concealWidth * 2u;
    let lumaDown = concealRows * 2u;
    let chromaBlocks = blocksAcrossMacroblock(1u) * blocksDownMacroblock(1u);
    if (localIndex < LUMA_NEIGHBORHOOD_BLOCKS) {
        let blockX = i32(column * 2u + localIndex % LUMA_NEIGHBORHOOD_WIDTH) - 1;
        let blockY = i32(row * 2u + localIndex / LUMA_NEIGHBORHOOD_WIDTH) - 1;
        var value = 0;
        if (blockX >= 0 && blockY >= 0 && u32(blockX) < lumaAcross && u32(blockY) < lumaDown) {
            value = concealmentBlockDC(0u, u32(blockX), u32(blockY));
        }
        lumaNeighborhood[localIndex] = value;
    } else if (localIndex < LUMA_NEIGHBORHOOD_BLOCKS + 2u * chromaBlocks) {
        let chromaIndex = localIndex - LUMA_NEIGHBORHOOD_BLOCKS;
        let plane = 1u + chromaIndex / chromaBlocks;
        let block = chromaIndex % chromaBlocks;
        let across = blocksAcrossMacroblock(plane);
        chromaGuesses[chromaIndex] = guessBlockDC(plane, column * across + block % across, row * blocksDownMacroblock(plane) + block / across);
    }
    workgroupBarrier();
    if (localIndex < LUMA_BLOCKS) {
        lumaFiltered[localIndex] = filteredLumaDC(column * 2u + localIndex % 2u, row * 2u + localIndex / 2u, column, row, lumaAcross, lumaDown);
    }
    workgroupBarrier();
    let taskCount = (LUMA_BLOCKS + 2u * chromaBlocks) * BLOCK_WORDS;
    for (var task = localIndex; task < taskCount; task += RECONSTRUCT_WORKGROUP_SIZE) {
        let counter = task / BLOCK_WORDS;
        let wordInBlock = task % BLOCK_WORDS;
        var plane = 0u;
        var block = counter;
        var dc = 0;
        if (counter < LUMA_BLOCKS) {
            dc = lumaFiltered[counter];
        } else {
            plane = 1u + (counter - LUMA_BLOCKS) / chromaBlocks;
            block = (counter - LUMA_BLOCKS) % chromaBlocks;
            dc = chromaGuesses[counter - LUMA_BLOCKS];
        }
        let across = blocksAcrossMacroblock(plane);
        let x = (column * across + block % across) * BLOCK_ROWS + (wordInBlock & 1u) * 4u;
        let line = (row * blocksDownMacroblock(plane) + block / across) * BLOCK_ROWS + (wordInBlock >> 1u);
        writeConcealedWord(plane, x, line, (u32(clamp(dc, 0, MAXIMUM_DC)) / DC_SAMPLE_SCALE) * SAMPLE_REPLICATE);
    }
}

// The deblocking ff_er_frame_end runs on a concealed picture, h_block_filter over the whole picture, then v_block_filter: at each 8x8
// block edge with a damaged side and an intra side, the step across the edge, less half the steps beside it, spreads over the four
// samples of each damaged side by these taps over 16, more strongly by 16 over 9 with one damaged side. Zero vectors leave the edges
// between inter macroblocks alone. Each edge's samples are its own, so its edges filter in parallel
const DEBLOCK_TAPS = array<i32, 4>(7, 5, 3, 1);
const DEBLOCK_TAP_SHIFT: u32 = 4u;
const DEBLOCK_ONE_SIDED_NUMERATOR: i32 = 16;
const DEBLOCK_ONE_SIDED_DENOMINATOR: i32 = 9;

// The step an edge spreads, from the two samples before it and the two after it
fn deblockStep(beforeFar: i32, beforeNear: i32, afterNear: i32, afterFar: i32, bothDamaged: bool) -> i32 {
    let before = beforeNear - beforeFar;
    let across = afterNear - beforeNear;
    let after = afterFar - afterNear;
    var step = max(abs(across) - ((abs(before) + abs(after) + 1) >> 1u), 0);
    if (across < 0) {
        step = -step;
    }
    if (!bothDamaged) {
        step = step * DEBLOCK_ONE_SIDED_NUMERATOR / DEBLOCK_ONE_SIDED_DENOMINATOR;
    }
    return step;
}

fn unpackSamples(word: u32) -> vec4i {
    return vec4i(i32(word & 0xFFu), i32((word >> 8u) & 0xFFu), i32((word >> 16u) & 0xFFu), i32(word >> 24u));
}

fn packSamples(samples: vec4i) -> u32 {
    return clipSample(samples.x) | (clipSample(samples.y) << 8u) | (clipSample(samples.z) << 16u) | (clipSample(samples.w) << 24u);
}

// Whether an edge between the macroblocks of two records filters: a side is damaged and a side is intra
fn edgeFilters(firstRecord: u32, secondRecord: u32) -> bool {
    return (macroblockDamaged(firstRecord) || macroblockDamaged(secondRecord))
        && (macroblockConcealedIntra(firstRecord) || macroblockConcealedIntra(secondRecord));
}

// h_block_filter on one line of the edge after a block of a plane: the four samples either side, two words of the line
fn filterVerticalEdge(plane: u32, leftBlockX: u32, line: u32) {
    let blockY = line / BLOCK_ROWS;
    let leftRecord = blockRecord(plane, leftBlockX, blockY);
    let rightRecord = blockRecord(plane, leftBlockX + 1u, blockY);
    if (!edgeFilters(leftRecord, rightRecord)) {
        return;
    }
    let leftDamaged = macroblockDamaged(leftRecord);
    let rightDamaged = macroblockDamaged(rightRecord);
    let edge = (leftBlockX + 1u) * BLOCK_ROWS;
    var left = unpackSamples(readConcealedWord(plane, edge - 4u, line));
    var right = unpackSamples(readConcealedWord(plane, edge, line));
    let step = deblockStep(left.z, left.w, right.x, right.y, leftDamaged && rightDamaged);
    if (step == 0) {
        return;
    }
    if (leftDamaged) {
        for (var tap = 0u; tap < 4u; tap += 1u) {
            left[3u - tap] += (step * DEBLOCK_TAPS[tap]) >> DEBLOCK_TAP_SHIFT;
        }
        writeConcealedWord(plane, edge - 4u, line, packSamples(left));
    }
    if (rightDamaged) {
        for (var tap = 0u; tap < 4u; tap += 1u) {
            right[tap] -= (step * DEBLOCK_TAPS[tap]) >> DEBLOCK_TAP_SHIFT;
        }
        writeConcealedWord(plane, edge, line, packSamples(right));
    }
}

// v_block_filter on the four columns from x, a multiple of 4, of the edge below a block of a plane: the four lines either side
fn filterHorizontalEdge(plane: u32, x: u32, topBlockY: u32) {
    let blockX = x / BLOCK_ROWS;
    let topRecord = blockRecord(plane, blockX, topBlockY);
    let bottomRecord = blockRecord(plane, blockX, topBlockY + 1u);
    if (!edgeFilters(topRecord, bottomRecord)) {
        return;
    }
    let topDamaged = macroblockDamaged(topRecord);
    let bottomDamaged = macroblockDamaged(bottomRecord);
    let edge = (topBlockY + 1u) * BLOCK_ROWS;
    var lines = array<vec4i, 8>();
    for (var offset = 0u; offset < 8u; offset += 1u) {
        lines[offset] = unpackSamples(readConcealedWord(plane, x, edge - 4u + offset));
    }
    for (var column = 0u; column < 4u; column += 1u) {
        let step = deblockStep(lines[2][column], lines[3][column], lines[4][column], lines[5][column], topDamaged && bottomDamaged);
        if (step == 0) {
            continue;
        }
        for (var tap = 0u; tap < 4u; tap += 1u) {
            if (topDamaged) {
                lines[3u - tap][column] += (step * DEBLOCK_TAPS[tap]) >> DEBLOCK_TAP_SHIFT;
            }
            if (bottomDamaged) {
                lines[4u + tap][column] -= (step * DEBLOCK_TAPS[tap]) >> DEBLOCK_TAP_SHIFT;
            }
        }
    }
    for (var offset = 0u; offset < 8u; offset += 1u) {
        if ((offset < 4u && topDamaged) || (offset >= 4u && bottomDamaged)) {
            writeConcealedWord(plane, x, edge - 4u + offset, packSamples(lines[offset]));
        }
    }
}

// h_block_filter for the edges after each block of the workgroup's macroblock, a line per invocation: luma's two edges of 16 lines,
// then each chroma plane's
@compute @workgroup_size(RECONSTRUCT_WORKGROUP_SIZE)
fn deblockHorizontal(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    if (!concealedPictureMacroblock(workgroupId.x, workgroupId.y)) {
        return;
    }
    loadConcealedPicture();
    let row = concealPictureRow(workgroupId.y);
    let lumaTasks = 2u * MACROBLOCK_SIZE;
    let chromaTasks = blocksAcrossMacroblock(1u) * BLOCK_ROWS * blocksDownMacroblock(1u);
    for (var task = localIndex; task < lumaTasks + 2u * chromaTasks; task += RECONSTRUCT_WORKGROUP_SIZE) {
        var plane = 0u;
        var planeTask = task;
        if (task >= lumaTasks) {
            plane = 1u + (task - lumaTasks) / chromaTasks;
            planeTask = (task - lumaTasks) % chromaTasks;
        }
        let across = blocksAcrossMacroblock(plane);
        let lines = BLOCK_ROWS * blocksDownMacroblock(plane);
        let leftBlockX = workgroupId.x * across + planeTask / lines;
        if (leftBlockX + 1u < concealWidth * across) {
            filterVerticalEdge(plane, leftBlockX, row * lines + planeTask % lines);
        }
    }
}

// v_block_filter for the edges below each block of the workgroup's macroblock, four columns per invocation: luma's two edges of four
// words, then each chroma plane's
@compute @workgroup_size(RECONSTRUCT_WORKGROUP_SIZE)
fn deblockVertical(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    if (!concealedPictureMacroblock(workgroupId.x, workgroupId.y)) {
        return;
    }
    loadConcealedPicture();
    let row = concealPictureRow(workgroupId.y);
    let lumaTasks = 2u * MACROBLOCK_SIZE / 4u;
    let chromaTasks = blocksDownMacroblock(1u) * BLOCK_ROWS * blocksAcrossMacroblock(1u) / 4u;
    for (var task = localIndex; task < lumaTasks + 2u * chromaTasks; task += RECONSTRUCT_WORKGROUP_SIZE) {
        var plane = 0u;
        var planeTask = task;
        if (task >= lumaTasks) {
            plane = 1u + (task - lumaTasks) / chromaTasks;
            planeTask = (task - lumaTasks) % chromaTasks;
        }
        let down = blocksDownMacroblock(plane);
        let words = BLOCK_ROWS * blocksAcrossMacroblock(plane) / 4u;
        let topBlockY = row * down + planeTask / words;
        if (topBlockY + 1u < concealRows * down) {
            filterHorizontalEdge(plane, workgroupId.x * words * 4u + (planeTask % words) * 4u, topBlockY);
        }
    }
}

// Moves reconstructPicture on to the packet's second picture
@compute @workgroup_size(1)
fn nextPicture() {
    pictureState[PACKET_CURRENT_PICTURE] += 1u;
}

// Hands back the slots that left the references, never one a reference still holds
@compute @workgroup_size(1)
fn finishPacket() {
    if (packetFailed()) {
        return;
    }
    let count = min(pictureState[PACKET_RELEASE_COUNT], MAXIMUM_RELEASES);
    for (var index = 0u; index < count; index += 1u) {
        let slot = pictureState[PACKET_RELEASES + index];
        if (slot + 1u == state[STATE_LAST_SLOT] || slot + 1u == state[STATE_NEXT_SLOT] || slot + 1u == state[STATE_PENDING_SLOT]) {
            continue;
        }
        releaseReferenceSlot(slot);
    }
}
