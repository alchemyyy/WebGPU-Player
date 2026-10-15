//! id: vc1
//! name: VC-1
//! decoder: video
//! accepts: codec in [vc1, wmv3], stream.width <= 4096, stream.height <= 4096, stream.width * stream.height <= 4194304, stream.bitDepth == 8
//! output: I420
//! parser: 2
//! references: 2
//! reorder: 1
//! packet: 32 MiB
//! state: 44
//! buffer: pictureState, 24864
//! buffer: macroblocks, 4194304
//! buffer: blockData, 50331648
//! error: 1, configuration
//! error: 2, unsupportedFeature
//! error: 3, pictureSize
//! error: 4, sequenceHeader
//! error: 5, pictureHeader, resync
//! error: 6, bitplane, resync
//! error: 7, startCodes, resync
//! error: 8, macroblockLayer, resync
//! error: 9, bitsExhausted, resync
//! error: 10, recordInvalid
//! error: 11, pictureTooShort, resync
//! dispatch: beginPicture, 1
//! dispatch: expandRecord, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: copyPicture, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: reconstruct, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: overlapVerticalEdges, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: overlapHorizontalEdges, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: putIntra, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: filterHorizontalBlockEdges, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: filterHorizontalSubblockEdges, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: filterVerticalBlockEdges, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: filterVerticalSubblockEdges, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: filterFrameHorizontalLines, ceil(stream.width / 64)
//! dispatch: filterFrameVerticalLines, ceil(stream.height / 128)
//! dispatch: nextPass, 1
//! dispatch: reconstruct, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: overlapVerticalEdges, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: overlapHorizontalEdges, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: putIntra, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: filterHorizontalBlockEdges, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: filterHorizontalSubblockEdges, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: filterVerticalBlockEdges, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: filterVerticalSubblockEdges, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: finishPicture, 1

// The VC-1 decoder: Simple, Main, and Advanced profile VC-1 and WMV3, IntraX8 included, in compute shaders.
// Its packets are the GPU records its CPU parser (parser/) makes of each picture: the parser parses the headers and the macroblock layer,
// predicts intra blocks, and decodes IntraX8 pictures, so these passes set up the picture from its record, then reconstruct, smooth,
// and filter it. Each step mirrors FFmpeg's vc1 decoder, so its frames match FFmpeg's.
// A field picture's frame runs the passes twice, once per field; nextPass moves every stage on to the second field.

// The GPU record the parser writes for each picture: its magic and version, its limits, and the word offsets of its fields.
// parser/build.rs reads these RECORD_ declarations and the ERROR_ codes below, so the parser and the passes share one layout
const RECORD_MAGIC: u32 = 1378960214u;
const RECORD_VERSION: u32 = 1u;
const RECORD_MAXIMUM_MACROBLOCKS: u32 = 16384u;
// A field picture's frame has two passes, one per field
const RECORD_MAXIMUM_PASSES: u32 = 2u;

// Words of the record header; the passes' parameter blocks follow it in order
const RECORD_HEADER_MAGIC: u32 = 0u;
const RECORD_HEADER_VERSION: u32 = 1u;
const RECORD_HEADER_KIND: u32 = 2u;
const RECORD_HEADER_FRAME_TYPE: u32 = 3u;
const RECORD_HEADER_FCM: u32 = 4u;
const RECORD_HEADER_FIELD_MODE: u32 = 5u;
const RECORD_HEADER_MB_WIDTH: u32 = 6u;
const RECORD_HEADER_MB_HEIGHT: u32 = 7u;
const RECORD_HEADER_CODED_WIDTH: u32 = 8u;
const RECORD_HEADER_CODED_HEIGHT: u32 = 9u;
const RECORD_HEADER_PROFILE: u32 = 10u;
const RECORD_HEADER_RES_FASTTX: u32 = 11u;
const RECORD_HEADER_OVERLAP: u32 = 12u;
const RECORD_HEADER_PASS_COUNT: u32 = 13u;
// Word offsets in the record: the lookup sets, the macroblock offset table, and an IntraX8 picture's samples; 0 for none
const RECORD_HEADER_LOOKUPS: u32 = 14u;
const RECORD_HEADER_MACROBLOCKS: u32 = 15u;
const RECORD_HEADER_SAMPLES: u32 = 16u;
const RECORD_HEADER_FLAGS: u32 = 17u;
const RECORD_HEADER_PASSES: u32 = 24u;
const RECORD_HEADER_WORDS: u32 = 72u;
// The parser dropped every reference since the last record, as FFmpeg's decoder does when a coded size change reinitializes it
const RECORD_FLAG_RESET_ANCHORS: u32 = 1u;

// What a picture's record holds: its macroblocks, an IntraX8 picture's samples, or nothing for a skipped P picture
const RECORD_KIND_MACROBLOCKS: u32 = 0u;
const RECORD_KIND_INTRAX8: u32 = 1u;
const RECORD_KIND_SKIPPED: u32 = 2u;

// Words of a pass's parameter block: its picture header's fields the passes read, its rows, and its intensity compensation
const RECORD_PASS_TYPE: u32 = 0u;
const RECORD_PASS_FCM: u32 = 1u;
const RECORD_PASS_FIELD_MODE: u32 = 2u;
const RECORD_PASS_CURRENT_FIELD_TYPE: u32 = 3u;
const RECORD_PASS_PQ: u32 = 4u;
const RECORD_PASS_MSPEL: u32 = 5u;
const RECORD_PASS_RND: u32 = 6u;
const RECORD_PASS_RANGEREDFRM: u32 = 7u;
const RECORD_PASS_CONDOVER: u32 = 8u;
const RECORD_PASS_UNSIGNED_INTRA: u32 = 9u;
const RECORD_PASS_LOOP_FILTER: u32 = 10u;
// The frame row of the pass's first macroblock row, and its macroblock rows
const RECORD_PASS_ROW_OFFSET: u32 = 11u;
const RECORD_PASS_MB_ROWS: u32 = 12u;
const RECORD_PASS_LAST_USE_IC: u32 = 13u;
const RECORD_PASS_NEXT_USE_IC: u32 = 14u;
const RECORD_PASS_CURRENT_USE_IC: u32 = 15u;
const RECORD_PASS_LUT_LAST: u32 = 16u;
const RECORD_PASS_LUT_NEXT: u32 = 17u;
const RECORD_PASS_LUT_CURRENT: u32 = 18u;
// Bit n set: the record carries lookup set n for the pass
const RECORD_PASS_LOOKUP_SETS: u32 = 19u;
const RECORD_PASS_WORDS: u32 = 24u;

// The intensity compensation lookup sets: two anchor sets and the B pictures' auxiliary set, each four tables of 256 entries packed
// four to a word: luma of the top and bottom fields, then chroma of each
const RECORD_LOOKUP_SET_COUNT: u32 = 3u;
const RECORD_LOOKUP_SET_WORDS: u32 = 256u;

// Words of a macroblock's record: its fixed words, then the words of its present operations in slot order, then its blocks'
// coefficient entries in block order
const RECORD_MACROBLOCK_FLAGS: u32 = 0u;
// Four coded subblock bits per block
const RECORD_MACROBLOCK_CBP: u32 = 1u;
// Four transform type bits per block, FFmpeg's ttblk
const RECORD_MACROBLOCK_TT: u32 = 2u;
// FFmpeg's is_intra bits, which the loop filter reads
const RECORD_MACROBLOCK_IS_INTRA: u32 = 3u;
// The four luma blocks' motion_val[0], packed
const RECORD_MACROBLOCK_MV0: u32 = 4u;
// FFmpeg's mv_f[0] in bits 0 to 5
const RECORD_MACROBLOCK_FIELD_FLAGS: u32 = 8u;
const RECORD_MACROBLOCK_LOOP_FILTER_CHROMA_MV: u32 = 9u;
// A transform half-word per block, two to a word
const RECORD_MACROBLOCK_TRANSFORMS: u32 = 10u;
// A coefficient count byte per block: blocks 0 to 3, then 4 and 5
const RECORD_MACROBLOCK_COUNTS: u32 = 13u;
// Bit n set: operation slot n is present, the luma slots then the chroma slots
const RECORD_MACROBLOCK_OPERATIONS: u32 = 15u;
const RECORD_MACROBLOCK_FIXED_WORDS: u32 = 16u;

// Bits of a macroblock's flags word the passes read: bits 0 to 5 are its intra blocks
const RECORD_MACROBLOCK_FIELDTX_BIT: u32 = 128u;
const RECORD_MACROBLOCK_OVERFLAG_BIT: u32 = 256u;
// The macroblock sits in the first or the last row of its slice, which overlap smoothing and the loop filter do not cross
const RECORD_MACROBLOCK_SLICE_TOP_BIT: u32 = 33554432u;
const RECORD_MACROBLOCK_SLICE_BOTTOM_BIT: u32 = 67108864u;

// Operation slots: eight luma slots, a put and an averaging slot per 8x8 block, then eight chroma slots alike
const RECORD_LUMA_OPERATION_SLOTS: u32 = 8u;
// The flags word and the packed motion vector of an operation
const RECORD_OPERATION_WORDS: u32 = 2u;

// Fields of a block's transform half-word: the transform type, the coded subblocks, the DC-only subblocks, and whether the block is coded
const RECORD_TRANSFORM_TYPE_MASK: u32 = 3u;
const RECORD_TRANSFORM_8X8: u32 = 0u;
const RECORD_TRANSFORM_8X4: u32 = 1u;
const RECORD_TRANSFORM_4X8: u32 = 2u;
const RECORD_TRANSFORM_4X4: u32 = 3u;
const RECORD_TRANSFORM_CODED_SHIFT: u32 = 2u;
const RECORD_TRANSFORM_DC_ONLY_SHIFT: u32 = 6u;
const RECORD_TRANSFORM_PRESENT_BIT: u32 = 1024u;

// Transform types, FFmpeg's TT_*
const RECORD_TT_8X8: u32 = 0u;
const RECORD_TT_8X4_BOTTOM: u32 = 1u;
const RECORD_TT_8X4_TOP: u32 = 2u;
const RECORD_TT_8X4: u32 = 3u;
const RECORD_TT_4X8_RIGHT: u32 = 4u;
const RECORD_TT_4X8_LEFT: u32 = 5u;
const RECORD_TT_4X8: u32 = 6u;
const RECORD_TT_4X4: u32 = 7u;

// Fields of a motion compensation operation's flags word
const RECORD_OPERATION_PRESENT: u32 = 1u;
const RECORD_OPERATION_KIND_SHIFT: u32 = 1u;
const RECORD_OPERATION_AVERAGE: u32 = 8u;
const RECORD_OPERATION_SOURCE_SHIFT: u32 = 4u;
const RECORD_OPERATION_BOTTOM_FIELD: u32 = 64u;
const RECORD_OPERATION_FIELD_MV: u32 = 128u;

// Luma operation kinds: mc_1mv's 16x16 block, mc_4mv_luma's 8x8 block, and interp_mc's averaging 16x16 block
const RECORD_LUMA_KIND_1MV: u32 = 0u;
const RECORD_LUMA_KIND_4MV: u32 = 1u;
const RECORD_LUMA_KIND_INTERPOLATED: u32 = 2u;

// Chroma operation kinds: the 8x8 blocks of mc_1mv, mc_4mv_chroma, and interp_mc, and mc_4mv_chroma4's 4x4 quarters
const RECORD_CHROMA_KIND_1MV: u32 = 0u;
const RECORD_CHROMA_KIND_4MV: u32 = 1u;
const RECORD_CHROMA_KIND_INTERPOLATED: u32 = 2u;
const RECORD_CHROMA_KIND_QUARTER: u32 = 3u;

// Reference sources of an operation: the previous anchor, the next anchor, and the first field of the current frame
const RECORD_SOURCE_LAST: u32 = 0u;
const RECORD_SOURCE_NEXT: u32 = 1u;
const RECORD_SOURCE_CURRENT: u32 = 2u;

// A coefficient entry: its position in the block above this shift, its value in the low 16 bits; a block holds at most 64
const RECORD_COEFFICIENT_POSITION_SHIFT: u32 = 16u;
const RECORD_COEFFICIENTS_PER_BLOCK: u32 = 64u;

// Profiles
const RECORD_PROFILE_SIMPLE: u32 = 0u;
const RECORD_PROFILE_MAIN: u32 = 1u;
const RECORD_PROFILE_COMPLEX: u32 = 2u;
const RECORD_PROFILE_ADVANCED: u32 = 3u;

// Picture types; BI pictures decode as intra B pictures
const RECORD_TYPE_I: u32 = 0u;
const RECORD_TYPE_P: u32 = 1u;
const RECORD_TYPE_B: u32 = 2u;
const RECORD_TYPE_BI: u32 = 3u;

// Frame coding modes
const RECORD_FCM_PROGRESSIVE: u32 = 0u;
const RECORD_FCM_FRAME: u32 = 1u;
const RECORD_FCM_FIELD: u32 = 2u;

// Conditional overlap of Advanced profile I pictures
const RECORD_CONDOVER_NONE: u32 = 0u;
const RECORD_CONDOVER_ALL: u32 = 1u;
const RECORD_CONDOVER_SELECT: u32 = 2u;

// Error codes, the high byte of a status error word, which the //! error lines name; the low 24 bits carry the failing value.
// A size beyond the pool or the package's limit holds for the pictures after it too, so it ends the attempt.
// A picture too short for field coding is damage, which FFmpeg drops ("image too short"), so it resyncs
const ERROR_CODE_SHIFT: u32 = 24u;
const ERROR_CONFIGURATION: u32 = 1u;
const ERROR_UNSUPPORTED_FEATURE: u32 = 2u;
const ERROR_PICTURE_SIZE: u32 = 3u;
const ERROR_SEQUENCE_HEADER: u32 = 4u;
const ERROR_PICTURE_HEADER: u32 = 5u;
const ERROR_BITPLANE: u32 = 6u;
const ERROR_START_CODES: u32 = 7u;
const ERROR_MACROBLOCK_LAYER: u32 = 8u;
const ERROR_BITS_EXHAUSTED: u32 = 9u;
const ERROR_RECORD_INVALID: u32 = 10u;
const ERROR_PICTURE_TOO_SHORT: u32 = 11u;

// The record check failure values of the passes: the header, the kind or pass count, a pass's rows or lookup sets, the macroblock
// table or lookup sets beyond the record, a macroblock beyond it, and IntraX8 samples beyond it
const INVALID_RECORD_HEADER: u32 = 1u;
const INVALID_RECORD_KIND: u32 = 2u;
const INVALID_RECORD_PASS: u32 = 3u;
const INVALID_RECORD_TABLES: u32 = 4u;
const INVALID_RECORD_MACROBLOCK: u32 = 5u;
const INVALID_RECORD_SAMPLES: u32 = 6u;

// The state buffer: the anchors' pool slots and whether each is interlaced, and the sequence facts of the latest picture
const S_LAST_SLOT: u32 = 0u;
const S_NEXT_SLOT: u32 = 1u;
const S_LAST_INTERLACED: u32 = 2u;
const S_NEXT_INTERLACED: u32 = 3u;
const S_MB_WIDTH: u32 = 4u;
const S_MB_HEIGHT: u32 = 5u;
const S_CODED_WIDTH: u32 = 6u;
const S_CODED_HEIGHT: u32 = 7u;
const S_PROFILE: u32 = 8u;
const S_RES_FASTTX: u32 = 9u;
const S_OVERLAP: u32 = 10u;
const NO_SLOT: u32 = 255u;

// The picture state: how many passes reconstruct and the pass the stages work on, the picture's anchor facts and how it fills its slot,
// each pass's parameter block, and each pass's snapshot of the lookup sets its intensity compensation reads
const F_PASS_COUNT: u32 = 0u;
const F_CURRENT_PASS: u32 = 1u;
const F_FRAME_TYPE: u32 = 2u;
const F_RELEASED_ANCHOR: u32 = 3u;
const F_COPY_MODE: u32 = 4u;
// The pool slot a slot copy reads, or the record word offset of the samples a sample copy reads
const F_COPY_SOURCE: u32 = 5u;
const F_PASSES: u32 = 8u;
// A pass's parameter block: the record's pass words, then its references
const PICTURE_PASS_WORDS: u32 = 32u;
const P_FORWARD_SLOT: u32 = RECORD_PASS_WORDS;
const P_BACKWARD_SLOT: u32 = RECORD_PASS_WORDS + 1u;
const P_FORWARD_INTERLACED: u32 = RECORD_PASS_WORDS + 2u;
const P_BACKWARD_INTERLACED: u32 = RECORD_PASS_WORDS + 3u;
const F_PASS_LUTS: u32 = F_PASSES + RECORD_MAXIMUM_PASSES * PICTURE_PASS_WORDS;
// A lookup set's snapshot holds one entry per word
const LUT_TABLE_WORDS: u32 = 256u;
const LUT_SET_WORDS: u32 = 1024u;
const PASS_LUT_WORDS: u32 = RECORD_LOOKUP_SET_COUNT * LUT_SET_WORDS;
const LOOKUP_ENTRIES_PER_WORD: u32 = 4u;

// How copyPicture fills a picture that reconstructs nothing: not at all, from a pool slot, or from the record's samples
const COPY_MODE_NONE: u32 = 0u;
const COPY_MODE_SLOT: u32 = 1u;
const COPY_MODE_SAMPLES: u32 = 2u;
// The frame type of a packet whose record failed its check, which holds no reference
const NO_FRAME_TYPE: u32 = 255u;

// The macroblock buffer: one record per frame macroblock, the record's fixed words, then its operation slots, luma then chroma
const M_LUMA_OPS: u32 = RECORD_MACROBLOCK_FIXED_WORDS;
const M_CHROMA_OPS: u32 = M_LUMA_OPS + RECORD_LUMA_OPERATION_SLOTS * RECORD_OPERATION_WORDS;
const OPERATION_SLOTS: u32 = 2u * RECORD_LUMA_OPERATION_SLOTS;
const MACROBLOCK_WORDS: u32 = 64u;
const MACROBLOCK_SIZE: u32 = 16u;
const BLOCKS_PER_MACROBLOCK: u32 = 6u;
// An IntraX8 picture's record samples per macroblock, four to a word: 256 luma and 64 of each chroma plane
const INTRAX8_WORDS_PER_MACROBLOCK: u32 = 96u;
// The block data buffer: the coefficient entries of each block of each frame macroblock, then the intra samples before overlap smoothing
const B_INTRA_SAMPLES: u32 = RECORD_MAXIMUM_MACROBLOCKS * BLOCKS_PER_MACROBLOCK * RECORD_COEFFICIENTS_PER_BLOCK;
const EXPAND_WORKGROUP_SIZE: u32 = 64u;

// The quarter sample modes' shifts, indexed by the vector's fraction, FFmpeg's shift_value
const MSPEL_SHIFT = array<u32, 4>(
    0u, 5u, 1u, 5u
);

// WGSL shared by every pass of the VC-1 decoder: failure reports, parameter blocks, macroblock records, and samples.

// Reports a failure: the code in the high byte and the failing value below it; the highest report wins
fn reportFailure(code: u32, value: u32) {
    reportDecodeError((code << ERROR_CODE_SHIFT) | min(value, (1u << ERROR_CODE_SHIFT) - 1u));
}

fn stateValue(field: u32) -> u32 {
    return state[field];
}

fn setStateValue(field: u32, value: u32) {
    state[field] = value;
}

fn passBase(passIndex: u32) -> u32 {
    return F_PASSES + passIndex * PICTURE_PASS_WORDS;
}

// The parameter block the invocation reads
var<private> parameterBase: u32;

fn parameter(field: u32) -> u32 {
    return pictureState[parameterBase + field];
}

// Frame geometry in macroblocks; a field picture's frame has an even macroblock height, each field half of it
var<private> mbWidth: u32;
var<private> mbHeight: u32;

fn loadGeometry() {
    mbWidth = stateValue(S_MB_WIDTH);
    mbHeight = stateValue(S_MB_HEIGHT);
}

// Macroblock records, addressed by frame macroblock rows; a second field's rows follow its first field's
fn macroblockRecord(column: u32, frameRow: u32) -> u32 {
    return (frameRow * mbWidth + column) * MACROBLOCK_WORDS;
}

fn unpackMotionVector(word: u32) -> vec2i {
    return vec2i(i32(word << 16u) >> 16u, i32(word) >> 16);
}

// Sign-extends the low 16 bits, as FFmpeg's int16_t blocks keep values
fn wrapInt16(value: i32) -> i32 {
    return (value << 16u) >> 16u;
}

fn clipToByte(value: i32) -> u32 {
    return u32(clamp(value, 0, 255));
}

// Samples of the output slot
fn readPictureSample(plane: u32, x: u32, y: u32) -> u32 {
    return readSlotSample(packet.outputSlot, plane, x, y);
}

// Writes the four samples of one output word, starting at x, a multiple of 4
fn writePictureWord(plane: u32, x: u32, y: u32, samples: vec4u) {
    writeOutputSamples8(plane, x, y, samples);
}

// Intra samples of the frame before overlap smoothing, one i32 per sample at frame coordinates
fn intraSampleIndex(plane: u32, x: u32, y: u32) -> u32 {
    let lumaSize = mbWidth * mbHeight * 256u;
    switch (plane) {
        case 0u: {
            return B_INTRA_SAMPLES + y * mbWidth * 16u + x;
        }
        case 1u: {
            return B_INTRA_SAMPLES + lumaSize + y * mbWidth * 8u + x;
        }
        default: {
            return B_INTRA_SAMPLES + lumaSize + lumaSize / 4u + y * mbWidth * 8u + x;
        }
    }
}

// WGSL of the picture setup from the GPU record the CPU parser wrote: the record check, the sequence facts, the anchors and the passes'
// parameter blocks, and the expansion of the record's macroblocks and lookup sets into the buffers the passes read.

// The record header starts the packet
fn headerValue(field: u32) -> u32 {
    return readPacketWord(field);
}

// Whether a region of words at a record word offset lies after the header and within the record
fn recordHolds(offset: u32, words: u32, recordWords: u32) -> bool {
    return offset >= RECORD_HEADER_WORDS && offset <= recordWords && recordWords - offset >= words;
}

// Checks a macroblock picture's passes and tables against the record, then copies each pass's parameter block with its references
fn beginMacroblockPasses(passCount: u32, recordWords: u32, references: vec4u) -> bool {
    let height = stateValue(S_MB_HEIGHT);
    var lookupWords = 0u;
    for (var passIndex = 0u; passIndex < passCount; passIndex += 1u) {
        let source = RECORD_HEADER_PASSES + passIndex * RECORD_PASS_WORDS;
        let rowOffset = headerValue(source + RECORD_PASS_ROW_OFFSET);
        let rows = headerValue(source + RECORD_PASS_MB_ROWS);
        let usedSets = headerValue(source + RECORD_PASS_LOOKUP_SETS);
        if (rows > height || rowOffset > height - rows || usedSets >= (1u << RECORD_LOOKUP_SET_COUNT)) {
            reportFailure(ERROR_RECORD_INVALID, INVALID_RECORD_PASS);
            return false;
        }
        lookupWords += countOneBits(usedSets) * RECORD_LOOKUP_SET_WORDS;
    }
    let lookupsHeld = lookupWords == 0u || recordHolds(headerValue(RECORD_HEADER_LOOKUPS), lookupWords, recordWords);
    if (!lookupsHeld || !recordHolds(headerValue(RECORD_HEADER_MACROBLOCKS), stateValue(S_MB_WIDTH) * height, recordWords)) {
        reportFailure(ERROR_RECORD_INVALID, INVALID_RECORD_TABLES);
        return false;
    }
    for (var passIndex = 0u; passIndex < passCount; passIndex += 1u) {
        let source = RECORD_HEADER_PASSES + passIndex * RECORD_PASS_WORDS;
        let base = passBase(passIndex);
        for (var word = 0u; word < RECORD_PASS_WORDS; word += 1u) {
            pictureState[base + word] = headerValue(source + word);
        }
        pictureState[base + P_FORWARD_SLOT] = references.x;
        pictureState[base + P_BACKWARD_SLOT] = references.y;
        pictureState[base + P_FORWARD_INTERLACED] = references.z;
        pictureState[base + P_BACKWARD_INTERLACED] = references.w;
    }
    return true;
}

// Hands an anchor's slot back to the engine and empties the anchor
fn releaseAnchor(field: u32) {
    let slot = stateValue(field);
    if (slot != NO_SLOT) {
        releaseReferenceSlot(slot);
    }
    setStateValue(field, NO_SLOT);
}

// Sets up a picture from its record: the record check, the sequence facts, the anchors, and how the picture fills its slot.
// An anchor's forward reference is the previous next anchor, and it becomes the next anchor itself
@compute @workgroup_size(1)
fn beginPicture() {
    pictureState[F_PASS_COUNT] = 0u;
    pictureState[F_CURRENT_PASS] = 0u;
    pictureState[F_FRAME_TYPE] = NO_FRAME_TYPE;
    pictureState[F_RELEASED_ANCHOR] = NO_SLOT;
    pictureState[F_COPY_MODE] = COPY_MODE_NONE;
    // A reset cleared the state, whose zero slots would read as held: the anchors start empty
    if (packet.reset != 0u) {
        setStateValue(S_LAST_SLOT, NO_SLOT);
        setStateValue(S_NEXT_SLOT, NO_SLOT);
    }
    let recordWords = packet.byteLength / 4u;
    if (recordWords < RECORD_HEADER_WORDS || headerValue(RECORD_HEADER_MAGIC) != RECORD_MAGIC || headerValue(RECORD_HEADER_VERSION) != RECORD_VERSION) {
        reportFailure(ERROR_RECORD_INVALID, INVALID_RECORD_HEADER);
        return;
    }
    let kind = headerValue(RECORD_HEADER_KIND);
    let frameType = headerValue(RECORD_HEADER_FRAME_TYPE);
    let passCount = headerValue(RECORD_HEADER_PASS_COUNT);
    if (kind > RECORD_KIND_SKIPPED || frameType > RECORD_TYPE_BI || passCount == 0u || passCount > RECORD_MAXIMUM_PASSES) {
        reportFailure(ERROR_RECORD_INVALID, INVALID_RECORD_KIND);
        return;
    }
    let width = headerValue(RECORD_HEADER_MB_WIDTH);
    let height = headerValue(RECORD_HEADER_MB_HEIGHT);
    if (width == 0u || width > stream.planes[0].width / MACROBLOCK_SIZE) {
        reportFailure(ERROR_PICTURE_SIZE, width);
        return;
    }
    if (height == 0u || height > stream.planes[0].height / MACROBLOCK_SIZE || width * height > RECORD_MAXIMUM_MACROBLOCKS) {
        reportFailure(ERROR_PICTURE_SIZE, height);
        return;
    }
    let codedWidth = headerValue(RECORD_HEADER_CODED_WIDTH);
    let codedHeight = headerValue(RECORD_HEADER_CODED_HEIGHT);
    setStateValue(S_MB_WIDTH, width);
    setStateValue(S_MB_HEIGHT, height);
    setStateValue(S_CODED_WIDTH, codedWidth);
    setStateValue(S_CODED_HEIGHT, codedHeight);
    setStateValue(S_PROFILE, headerValue(RECORD_HEADER_PROFILE));
    setStateValue(S_RES_FASTTX, headerValue(RECORD_HEADER_RES_FASTTX));
    setStateValue(S_OVERLAP, headerValue(RECORD_HEADER_OVERLAP));
    reportHeaderFacts(width * MACROBLOCK_SIZE, height * MACROBLOCK_SIZE, OUTPUT_BIT_DEPTH, vec4u(0u, 0u, codedWidth, codedHeight));
    // The parser dropped its references at a coded size change, as FFmpeg's reinitialized decoder does
    if ((headerValue(RECORD_HEADER_FLAGS) & RECORD_FLAG_RESET_ANCHORS) != 0u) {
        releaseAnchor(S_LAST_SLOT);
        releaseAnchor(S_NEXT_SLOT);
    }
    let isAnchor = frameType == RECORD_TYPE_I || frameType == RECORD_TYPE_P;
    var references = vec4u(stateValue(S_LAST_SLOT), stateValue(S_NEXT_SLOT), stateValue(S_LAST_INTERLACED), stateValue(S_NEXT_INTERLACED));
    if (isAnchor) {
        references = vec4u(stateValue(S_NEXT_SLOT), NO_SLOT, stateValue(S_NEXT_INTERLACED), 0u);
    }
    pictureState[F_FRAME_TYPE] = frameType;
    if (frameType == RECORD_TYPE_B && references.x == NO_SLOT) {
        // The parser drops a B picture without a previous anchor, as FFmpeg skips it; one after a stream change's reset repeats the next anchor
        pictureState[F_COPY_MODE] = COPY_MODE_SLOT;
        pictureState[F_COPY_SOURCE] = references.y;
        return;
    }
    if (isAnchor) {
        // The anchor that drops out is released once the picture finishes
        pictureState[F_RELEASED_ANCHOR] = stateValue(S_LAST_SLOT);
        setStateValue(S_LAST_SLOT, stateValue(S_NEXT_SLOT));
        setStateValue(S_LAST_INTERLACED, stateValue(S_NEXT_INTERLACED));
        setStateValue(S_NEXT_SLOT, packet.outputSlot);
        setStateValue(S_NEXT_INTERLACED, select(0u, 1u, headerValue(RECORD_HEADER_FCM) != RECORD_FCM_PROGRESSIVE));
    }
    switch (kind) {
        case RECORD_KIND_SKIPPED: {
            // A skipped P picture copies its forward reference, as vc1_decode_skip_blocks does
            pictureState[F_COPY_MODE] = COPY_MODE_SLOT;
            pictureState[F_COPY_SOURCE] = references.x;
        }
        case RECORD_KIND_INTRAX8: {
            let samples = headerValue(RECORD_HEADER_SAMPLES);
            if (!recordHolds(samples, width * height * INTRAX8_WORDS_PER_MACROBLOCK, recordWords)) {
                reportFailure(ERROR_RECORD_INVALID, INVALID_RECORD_SAMPLES);
                return;
            }
            pictureState[F_COPY_MODE] = COPY_MODE_SAMPLES;
            pictureState[F_COPY_SOURCE] = samples;
        }
        default: {
            if (!beginMacroblockPasses(passCount, recordWords, references)) {
                return;
            }
            pictureState[F_PASS_COUNT] = passCount;
        }
    }
}

// Unpacks the lookup sets each pass's intensity compensation reads, four entries to a record word, into the pass's snapshot
fn expandLookupSets(passCount: u32, localIndex: u32) {
    var setWord = headerValue(RECORD_HEADER_LOOKUPS);
    for (var passIndex = 0u; passIndex < passCount; passIndex += 1u) {
        let usedSets = pictureState[passBase(passIndex) + RECORD_PASS_LOOKUP_SETS];
        for (var lutSet = 0u; lutSet < RECORD_LOOKUP_SET_COUNT; lutSet += 1u) {
            if (((usedSets >> lutSet) & 1u) == 0u) {
                continue;
            }
            let snapshot = F_PASS_LUTS + passIndex * PASS_LUT_WORDS + lutSet * LUT_SET_WORDS;
            for (var word = localIndex; word < RECORD_LOOKUP_SET_WORDS; word += EXPAND_WORKGROUP_SIZE) {
                let entries = readPacketWord(setWord + word);
                for (var lane = 0u; lane < LOOKUP_ENTRIES_PER_WORD; lane += 1u) {
                    pictureState[snapshot + word * LOOKUP_ENTRIES_PER_WORD + lane] = (entries >> (lane * 8u)) & 0xFFu;
                }
            }
            setWord += RECORD_LOOKUP_SET_WORDS;
        }
    }
}

// The coefficient count of a block from a macroblock record's count words
fn recordBlockCount(source: u32, block: u32) -> u32 {
    return (readPacketWord(source + RECORD_MACROBLOCK_COUNTS + block / 4u) >> ((block & 3u) * 8u)) & 0xFFu;
}

// Expands a macroblock picture's record, one workgroup per frame macroblock: the macroblock's fixed words and present operations into its
// record, its coefficient entries into its blocks; the first workgroup also unpacks the passes' lookup sets.
// A macroblock no unit decoded reconstructs from an empty record
@compute @workgroup_size(EXPAND_WORKGROUP_SIZE)
fn expandRecord(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    let passCount = pictureState[F_PASS_COUNT];
    if (passCount == 0u) {
        return;
    }
    if (workgroupId.x == 0u && workgroupId.y == 0u) {
        expandLookupSets(passCount, localIndex);
    }
    loadGeometry();
    let column = workgroupId.x;
    let frameRow = workgroupId.y;
    if (column >= mbWidth || frameRow >= mbHeight) {
        return;
    }
    let record = macroblockRecord(column, frameRow);
    let macroblockIndex = frameRow * mbWidth + column;
    let source = readPacketWord(headerValue(RECORD_HEADER_MACROBLOCKS) + macroblockIndex);
    if (source == 0u) {
        if (localIndex < RECORD_MACROBLOCK_FIXED_WORDS) {
            macroblocks[record + localIndex] = 0u;
        }
        return;
    }
    let recordWords = packet.byteLength / 4u;
    if (!recordHolds(source, RECORD_MACROBLOCK_FIXED_WORDS, recordWords)) {
        if (localIndex == 0u) {
            reportFailure(ERROR_RECORD_INVALID, INVALID_RECORD_MACROBLOCK);
        }
        return;
    }
    let operations = readPacketWord(source + RECORD_MACROBLOCK_OPERATIONS) & ((1u << OPERATION_SLOTS) - 1u);
    let coefficients = source + RECORD_MACROBLOCK_FIXED_WORDS + countOneBits(operations) * RECORD_OPERATION_WORDS;
    var coefficientCount = 0u;
    for (var block = 0u; block < BLOCKS_PER_MACROBLOCK; block += 1u) {
        coefficientCount += recordBlockCount(source, block);
    }
    if (!recordHolds(coefficients, coefficientCount, recordWords)) {
        if (localIndex == 0u) {
            reportFailure(ERROR_RECORD_INVALID, INVALID_RECORD_MACROBLOCK);
        }
        return;
    }
    if (localIndex < RECORD_MACROBLOCK_FIXED_WORDS) {
        macroblocks[record + localIndex] = readPacketWord(source + localIndex);
    }
    // The record keeps only the present operations, in slot order
    if (localIndex < OPERATION_SLOTS && ((operations >> localIndex) & 1u) != 0u) {
        let operation = source + RECORD_MACROBLOCK_FIXED_WORDS + countOneBits(operations & ((1u << localIndex) - 1u)) * RECORD_OPERATION_WORDS;
        let slot = record + M_LUMA_OPS + localIndex * RECORD_OPERATION_WORDS;
        macroblocks[slot] = readPacketWord(operation);
        macroblocks[slot + 1u] = readPacketWord(operation + 1u);
    }
    var entry = coefficients;
    for (var block = 0u; block < BLOCKS_PER_MACROBLOCK; block += 1u) {
        let count = recordBlockCount(source, block);
        let base = (macroblockIndex * BLOCKS_PER_MACROBLOCK + block) * RECORD_COEFFICIENTS_PER_BLOCK;
        for (var index = localIndex; index < count; index += EXPAND_WORKGROUP_SIZE) {
            blockData[base + index] = readPacketWord(entry + index);
        }
        entry += count;
    }
}

// Ends a picture: releases the anchor that dropped out, and the picture's own slot unless it became an anchor
@compute @workgroup_size(1)
fn finishPicture() {
    let releasedAnchor = pictureState[F_RELEASED_ANCHOR];
    if (releasedAnchor != NO_SLOT) {
        releaseReferenceSlot(releasedAnchor);
    }
    let frameType = pictureState[F_FRAME_TYPE];
    // A picture that is no anchor holds no reference
    if (frameType != RECORD_TYPE_I && frameType != RECORD_TYPE_P) {
        releaseReferenceSlot(packet.outputSlot);
    }
}

// WGSL of the VC-1 decoder's reconstruction: one workgroup per macroblock runs the inverse transforms and motion compensation,
// then overlap smoothing runs between intra blocks and intra blocks are put. Each step mirrors FFmpeg's vc1dsp.c and vc1_mc.c.
// The coefficients, then the transformed residual, of the macroblock's six blocks in raster order
var<workgroup> transformBlocks: array<i32, 384>;
// The values of DC-only subblocks, per block and subblock, read before the column pass overwrites their DC
var<workgroup> dcOnlyValues: array<i32, 24>;
// Whether the workgroup's macroblock exists in the pass, broadcast so barriers stay in uniform control flow
var<workgroup> workgroupActive: u32;

// The pass parameters the reconstruction reads, loaded per workgroup
var<private> passPictureType: u32;
var<private> passFieldMode: u32;
var<private> passCurrentFieldType: u32;
var<private> passFcm: u32;
var<private> passRowOffset: u32;
var<private> passRows: u32;
var<private> passMspel: u32;
var<private> passRnd: u32;
var<private> passRangered: u32;
var<private> passProfile: u32;
var<private> codedWidth: i32;
var<private> codedHeight: i32;
var<private> horizontalEdge: i32;
var<private> verticalEdge: i32;
// Simple and Main profile streams without RES_FASTTX take FFmpeg's simple IDCT in place of the VC-1 transforms
var<private> simpleIdct: bool;

fn loadPassParameters(passIndex: u32) -> bool {
    parameterBase = passBase(passIndex);
    // Only macroblock pictures reconstruct; a picture copyPicture fills runs no pass
    if (pictureState[F_PASS_COUNT] <= passIndex) {
        return false;
    }
    passPictureType = parameter(RECORD_PASS_TYPE);
    passFieldMode = parameter(RECORD_PASS_FIELD_MODE);
    passCurrentFieldType = parameter(RECORD_PASS_CURRENT_FIELD_TYPE);
    passFcm = parameter(RECORD_PASS_FCM);
    passRowOffset = parameter(RECORD_PASS_ROW_OFFSET);
    passRows = parameter(RECORD_PASS_MB_ROWS);
    passMspel = parameter(RECORD_PASS_MSPEL);
    passRnd = parameter(RECORD_PASS_RND);
    passRangered = parameter(RECORD_PASS_RANGEREDFRM);
    passProfile = stateValue(S_PROFILE);
    simpleIdct = passProfile != RECORD_PROFILE_ADVANCED && stateValue(S_RES_FASTTX) == 0u;
    codedWidth = i32(stateValue(S_CODED_WIDTH));
    codedHeight = i32(stateValue(S_CODED_HEIGHT));
    if (passProfile == RECORD_PROFILE_ADVANCED) {
        horizontalEdge = codedWidth;
        verticalEdge = codedHeight;
    } else {
        horizontalEdge = i32(mbWidth) * 16;
        verticalEdge = i32(mbHeight) * 16;
    }
    return true;
}

// The picture row of a row of the current pass: field pictures interleave their rows into the frame
fn pictureRow(passRow: u32) -> u32 {
    if (passFieldMode != 0u) {
        return passRow * 2u + passCurrentFieldType;
    }
    return passRow;
}

// Whether intra blocks of the pass go through overlap smoothing before they are put
fn overlapActive() -> bool {
    if (stateValue(S_OVERLAP) == 0u) {
        return false;
    }
    let pq = parameter(RECORD_PASS_PQ);
    switch (passPictureType) {
        case RECORD_TYPE_I, RECORD_TYPE_BI: {
            return pq >= 9u || (passProfile == RECORD_PROFILE_ADVANCED && parameter(RECORD_PASS_CONDOVER) != RECORD_CONDOVER_NONE);
        }
        case RECORD_TYPE_P: {
            return pq >= 9u;
        }
        default: {
            return false;
        }
    }
}

// Reference access: the slot, interlacing, intensity compensation, and lookup set of an operation's source
struct ReferencePicture {
    slot: u32,
    interlaced: bool,
    useIntensityCompensation: bool,
    lutSet: u32,
}

fn referencePicture(source: u32) -> ReferencePicture {
    switch (source) {
        case RECORD_SOURCE_NEXT: {
            return ReferencePicture(parameter(P_BACKWARD_SLOT), parameter(P_BACKWARD_INTERLACED) != 0u, parameter(RECORD_PASS_NEXT_USE_IC) != 0u, parameter(RECORD_PASS_LUT_NEXT));
        }
        case RECORD_SOURCE_CURRENT: {
            return ReferencePicture(packet.outputSlot, true, parameter(RECORD_PASS_CURRENT_USE_IC) != 0u, parameter(RECORD_PASS_LUT_CURRENT));
        }
        default: {
            return ReferencePicture(parameter(P_FORWARD_SLOT), parameter(P_FORWARD_INTERLACED) != 0u, parameter(RECORD_PASS_LAST_USE_IC) != 0u, parameter(RECORD_PASS_LUT_LAST));
        }
    }
}

// The pass's snapshot of a lookup set
fn lookupValue(passIndex: u32, lutSet: u32, table: u32, value: u32) -> u32 {
    return pictureState[F_PASS_LUTS + passIndex * PASS_LUT_WORDS + lutSet * LUT_SET_WORDS + table * LUT_TABLE_WORDS + value];
}

var<private> currentPass: u32;

// One reference sample at motion compensation coordinates: frame rows, or the reference field's rows in a field picture.
// Out of picture positions read the nearest sample as FFmpeg's emulated_edge_mc does, per field for an interlaced reference;
// then range reduction and intensity compensation apply as FFmpeg scales its edge emulation buffer
fn fetchReference(reference: ReferencePicture, plane: u32, x: i32, row: i32, bottomField: u32) -> i32 {
    let chroma = plane != 0u;
    let horizontal = select(horizontalEdge, horizontalEdge >> 1u, chroma);
    let vertical = select(verticalEdge, verticalEdge >> 1u, chroma);
    let clampedX = clamp(x, 0, horizontal - 1);
    var frameRow = 0;
    var parity = 0u;
    if (passFieldMode != 0u) {
        parity = bottomField;
        if (reference.interlaced) {
            frameRow = 2 * clamp(row, 0, (vertical >> 1u) - 1) + i32(bottomField);
        } else {
            frameRow = clamp(2 * row + i32(bottomField), 0, vertical - 1);
        }
    } else {
        parity = u32(row & 1);
        if (reference.interlaced) {
            frameRow = 2 * clamp(row >> 1u, 0, (vertical >> 1u) - 1) + (row & 1);
        } else {
            frameRow = clamp(row, 0, vertical - 1);
        }
    }
    var value = 128;
    if (reference.slot != NO_SLOT) {
        value = i32(readSlotSample(reference.slot, plane, u32(clampedX), u32(frameRow)));
    }
    if (passRangered != 0u) {
        value = ((value - 128) >> 1u) + 128;
    }
    if (reference.useIntensityCompensation) {
        value = i32(lookupValue(currentPass, reference.lutSet, select(0u, 2u, chroma) + parity, u32(value)));
    }
    return value;
}

// The 4-tap bicubic filters of VC-1's quarter sample modes, FFmpeg's vc1_mspel_*_filter_16bits
fn bicubic(mode: u32, a: i32, b: i32, c: i32, d: i32) -> i32 {
    switch (mode) {
        case 1u: {
            return -4 * a + 53 * b + 18 * c - 3 * d;
        }
        case 2u: {
            return -a + 9 * b + 9 * c - d;
        }
        default: {
            return -3 * a + 18 * b + 53 * c - 4 * d;
        }
    }
}

// FFmpeg's vc1_mspel_filter: one direction's rounded filter
fn bicubicRounded(mode: u32, a: i32, b: i32, c: i32, d: i32, rounding: i32) -> i32 {
    switch (mode) {
        case 1u, 3u: {
            return (bicubic(mode, a, b, c, d) + 32 - rounding) >> 6u;
        }
        default: {
            return (bicubic(mode, a, b, c, d) + 8 - rounding) >> 4u;
        }
    }
}

// The motion compensation geometry of a luma operation at one of its pixels
struct LumaSource {
    x: i32,
    row: i32,
    rowStep: i32,
}

fn clipLumaSource(sourceX: i32, sourceY: i32) -> vec2i {
    if (passProfile != RECORD_PROFILE_ADVANCED) {
        return vec2i(clamp(sourceX, -16, i32(mbWidth) * 16), clamp(sourceY, -16, i32(mbHeight) * 16));
    }
    var y = sourceY;
    if (passFcm == RECORD_FCM_FRAME) {
        y = clamp(sourceY, -18 + (sourceY & 1), codedHeight + (sourceY & 1));
    } else {
        y = clamp(sourceY, -18, codedHeight + 1);
    }
    return vec2i(clamp(sourceX, -17, codedWidth), y);
}

// The predicted luma sample of one operation at macroblock pixel (x, y): FFmpeg's ff_vc1_mc_1mv, ff_vc1_mc_4mv_luma, or ff_vc1_interp_mc
fn lumaPrediction(flags: u32, vector: vec2i, macroblockColumn: u32, macroblockRow: u32, x: u32, y: u32) -> i32 {
    let kind = (flags >> RECORD_OPERATION_KIND_SHIFT) & 3u;
    let reference = referencePicture((flags >> RECORD_OPERATION_SOURCE_SHIFT) & 3u);
    let bottomField = select(0u, 1u, (flags & RECORD_OPERATION_BOTTOM_FIELD) != 0u);
    let fieldMotion = (flags & RECORD_OPERATION_FIELD_MV) != 0u;
    var origin = vec2i(0, 0);
    var pixel = vec2i(i32(x), i32(y));
    var rowStep = 1;
    if (kind == RECORD_LUMA_KIND_4MV) {
        var block = (x >> 3u) + 2u * (y >> 3u);
        pixel = vec2i(i32(x & 7u), i32(y & 7u));
        if (fieldMotion) {
            block = (x >> 3u) + 2u * (y & 1u);
            pixel.y = i32(y >> 1u);
            rowStep = 2;
        }
        let sourceX = i32(macroblockColumn) * 16 + i32(block & 1u) * 8 + (vector.x >> 2u);
        var sourceY = i32(macroblockRow) * 16 + i32(block & 2u) * 4 + (vector.y >> 2u);
        if (fieldMotion) {
            sourceY = i32(macroblockRow) * 16 + select(0, 1, block > 1u) + (vector.y >> 2u);
        }
        origin = clipLumaSource(sourceX, sourceY);
    } else {
        origin = clipLumaSource(i32(macroblockColumn) * 16 + (vector.x >> 2u), i32(macroblockRow) * 16 + (vector.y >> 2u));
    }
    let baseX = origin.x + pixel.x;
    let baseRow = origin.y + pixel.y * rowStep;
    if (passMspel != 0u) {
        let horizontalMode = u32(vector.x & 3);
        let verticalMode = u32(vector.y & 3);
        let rnd = i32(passRnd);
        if (verticalMode != 0u) {
            if (horizontalMode != 0u) {
                let shift = (MSPEL_SHIFT[horizontalMode] + MSPEL_SHIFT[verticalMode]) >> 1u;
                let rounding = (1 << (shift - 1u)) + rnd - 1;
                var columns = vec4i(0, 0, 0, 0);
                for (var tap = 0; tap < 4; tap += 1) {
                    let column = baseX - 1 + tap;
                    let a = fetchReference(reference, 0u, column, baseRow - rowStep, bottomField);
                    let b = fetchReference(reference, 0u, column, baseRow, bottomField);
                    let c = fetchReference(reference, 0u, column, baseRow + rowStep, bottomField);
                    let d = fetchReference(reference, 0u, column, baseRow + 2 * rowStep, bottomField);
                    columns[tap] = wrapInt16((bicubic(verticalMode, a, b, c, d) + rounding) >> shift);
                }
                return i32(clipToByte((bicubic(horizontalMode, columns.x, columns.y, columns.z, columns.w) + 64 - rnd) >> 7u));
            }
            let a = fetchReference(reference, 0u, baseX, baseRow - rowStep, bottomField);
            let b = fetchReference(reference, 0u, baseX, baseRow, bottomField);
            let c = fetchReference(reference, 0u, baseX, baseRow + rowStep, bottomField);
            let d = fetchReference(reference, 0u, baseX, baseRow + 2 * rowStep, bottomField);
            return i32(clipToByte(bicubicRounded(verticalMode, a, b, c, d, 1 - rnd)));
        }
        if (horizontalMode != 0u) {
            let a = fetchReference(reference, 0u, baseX - 1, baseRow, bottomField);
            let b = fetchReference(reference, 0u, baseX, baseRow, bottomField);
            let c = fetchReference(reference, 0u, baseX + 1, baseRow, bottomField);
            let d = fetchReference(reference, 0u, baseX + 2, baseRow, bottomField);
            return i32(clipToByte(bicubicRounded(horizontalMode, a, b, c, d, rnd)));
        }
        return fetchReference(reference, 0u, baseX, baseRow, bottomField);
    }
    // Half sample bilinear prediction: FFmpeg's hpeldsp, rounding unless RNDCTRL is set
    let halfX = (vector.x & 2) != 0;
    let halfY = (vector.y & 2) != 0;
    let a = fetchReference(reference, 0u, baseX, baseRow, bottomField);
    if (!halfX && !halfY) {
        return a;
    }
    let noRounding = passRnd != 0u;
    if (halfX && halfY) {
        let b = fetchReference(reference, 0u, baseX + 1, baseRow, bottomField);
        let c = fetchReference(reference, 0u, baseX, baseRow + rowStep, bottomField);
        let d = fetchReference(reference, 0u, baseX + 1, baseRow + rowStep, bottomField);
        return (a + b + c + d + select(2, 1, noRounding)) >> 2u;
    }
    var b = 0;
    if (halfX) {
        b = fetchReference(reference, 0u, baseX + 1, baseRow, bottomField);
    } else {
        b = fetchReference(reference, 0u, baseX, baseRow + rowStep, bottomField);
    }
    return (a + b + select(1, 0, noRounding)) >> 1u;
}

fn clipChromaSource(kind: u32, sourceX: i32, sourceY: i32) -> vec2i {
    if (passProfile != RECORD_PROFILE_ADVANCED) {
        return vec2i(clamp(sourceX, -8, i32(mbWidth) * 8), clamp(sourceY, -8, i32(mbHeight) * 8));
    }
    let x = clamp(sourceX, -8, codedWidth >> 1u);
    if (passFcm == RECORD_FCM_FRAME && kind != RECORD_CHROMA_KIND_4MV) {
        return vec2i(x, clamp(sourceY, -8 + (sourceY & 1), (codedHeight >> 1u) + (sourceY & 1)));
    }
    return vec2i(x, clamp(sourceY, -8, codedHeight >> 1u));
}

// The predicted chroma sample of one operation at macroblock chroma pixel (x, y): bilinear in eighth samples
fn chromaPrediction(flags: u32, vector: vec2i, plane: u32, macroblockColumn: u32, macroblockRow: u32, x: u32, y: u32) -> i32 {
    let kind = (flags >> RECORD_OPERATION_KIND_SHIFT) & 3u;
    var reference = referencePicture((flags >> RECORD_OPERATION_SOURCE_SHIFT) & 3u);
    let bottomField = select(0u, 1u, (flags & RECORD_OPERATION_BOTTOM_FIELD) != 0u);
    let fieldMotion = (flags & RECORD_OPERATION_FIELD_MV) != 0u;
    var pixel = vec2i(i32(x), i32(y));
    var rowStep = 1;
    var origin = vec2i(0, 0);
    if (kind == RECORD_CHROMA_KIND_QUARTER) {
        let verticalDistance = select(4, 1, fieldMotion);
        var quarter = (x >> 2u) + 2u * (y >> 2u);
        pixel = vec2i(i32(x & 3u), i32(y & 3u));
        if (fieldMotion) {
            quarter = (x >> 2u) + 2u * (y & 1u);
            pixel.y = i32(y >> 1u);
            rowStep = 2;
        }
        let sourceX = i32(macroblockColumn) * 8 + i32(quarter & 1u) * 4 + (vector.x >> 2u);
        let sourceY = i32(macroblockRow) * 8 + select(0, verticalDistance, (quarter & 2u) != 0u) + (vector.y >> 2u);
        origin = clipChromaSource(kind, sourceX, sourceY);
    } else {
        origin = clipChromaSource(kind, i32(macroblockColumn) * 8 + (vector.x >> 2u), i32(macroblockRow) * 8 + (vector.y >> 2u));
    }
    let fractionX = (vector.x & 3) << 1u;
    let fractionY = (vector.y & 3) << 1u;
    let baseX = origin.x + pixel.x;
    let baseRow = origin.y + pixel.y * rowStep;
    if (kind == RECORD_CHROMA_KIND_QUARTER) {
        // mc_4mv_chroma4 applies intensity compensation but not range reduction, which interlaced frames never use
        reference.useIntensityCompensation = reference.useIntensityCompensation;
    }
    let a = fetchReference(reference, plane, baseX, baseRow, bottomField);
    let b = fetchReference(reference, plane, baseX + 1, baseRow, bottomField);
    let c = fetchReference(reference, plane, baseX, baseRow + rowStep, bottomField);
    let d = fetchReference(reference, plane, baseX + 1, baseRow + rowStep, bottomField);
    let sum = (8 - fractionX) * (8 - fractionY) * a + fractionX * (8 - fractionY) * b + (8 - fractionX) * fractionY * c + fractionX * fractionY * d;
    return (sum + select(32, 28, passRnd != 0u)) >> 6u;
}

// An operation word, zero for a slot the parse did not write, since the parse stores only the operations it wrote
fn operationWord(record: u32, base: u32, slot: u32, word: u32) -> u32 {
    let presence = slot + select(0u, RECORD_LUMA_OPERATION_SLOTS, base == M_CHROMA_OPS);
    if (((macroblocks[record + RECORD_MACROBLOCK_OPERATIONS] >> presence) & 1u) == 0u) {
        return 0u;
    }
    return macroblocks[record + base + slot * RECORD_OPERATION_WORDS + word];
}

// The predicted luma sample of an inter macroblock: the put operation, then the averaging one if present
fn predictLuma(record: u32, macroblockColumn: u32, macroblockRow: u32, x: u32, y: u32) -> i32 {
    var slot = 0u;
    let firstFlags = operationWord(record, M_LUMA_OPS, 0u, 0u);
    if ((firstFlags & RECORD_OPERATION_PRESENT) == 0u || ((firstFlags >> RECORD_OPERATION_KIND_SHIFT) & 3u) == RECORD_LUMA_KIND_4MV) {
        var block = (x >> 3u) + 2u * (y >> 3u);
        let blockFlags = operationWord(record, M_LUMA_OPS, block * 2u, 0u);
        if ((blockFlags & RECORD_OPERATION_FIELD_MV) != 0u || (firstFlags & RECORD_OPERATION_FIELD_MV) != 0u) {
            block = (x >> 3u) + 2u * (y & 1u);
        }
        slot = block * 2u;
    }
    let putFlags = operationWord(record, M_LUMA_OPS, slot, 0u);
    if ((putFlags & RECORD_OPERATION_PRESENT) == 0u) {
        return 128;
    }
    var value = lumaPrediction(putFlags, unpackMotionVector(operationWord(record, M_LUMA_OPS, slot, 1u)), macroblockColumn, macroblockRow, x, y);
    let averageFlags = operationWord(record, M_LUMA_OPS, slot + 1u, 0u);
    if ((averageFlags & RECORD_OPERATION_PRESENT) != 0u) {
        let other = lumaPrediction(averageFlags, unpackMotionVector(operationWord(record, M_LUMA_OPS, slot + 1u, 1u)), macroblockColumn, macroblockRow, x, y);
        value = (value + other + 1) >> 1u;
    }
    return value;
}

fn predictChroma(record: u32, plane: u32, macroblockColumn: u32, macroblockRow: u32, x: u32, y: u32) -> i32 {
    var slot = 0u;
    let firstFlags = operationWord(record, M_CHROMA_OPS, 0u, 0u);
    if ((firstFlags & RECORD_OPERATION_PRESENT) != 0u && ((firstFlags >> RECORD_OPERATION_KIND_SHIFT) & 3u) == RECORD_CHROMA_KIND_QUARTER) {
        var quarter = (x >> 2u) + 2u * (y >> 2u);
        if ((firstFlags & RECORD_OPERATION_FIELD_MV) != 0u) {
            quarter = (x >> 2u) + 2u * (y & 1u);
        }
        slot = quarter * 2u;
    }
    let putFlags = operationWord(record, M_CHROMA_OPS, slot, 0u);
    if ((putFlags & RECORD_OPERATION_PRESENT) == 0u) {
        return 128;
    }
    var value = chromaPrediction(putFlags, unpackMotionVector(operationWord(record, M_CHROMA_OPS, slot, 1u)), plane, macroblockColumn, macroblockRow, x, y);
    let averageFlags = operationWord(record, M_CHROMA_OPS, slot + 1u, 0u);
    if ((averageFlags & RECORD_OPERATION_PRESENT) != 0u) {
        let other = chromaPrediction(averageFlags, unpackMotionVector(operationWord(record, M_CHROMA_OPS, slot + 1u, 1u)), plane, macroblockColumn, macroblockRow, x, y);
        value = (value + other + 1) >> 1u;
    }
    return value;
}

// The transform half-word of a block
fn blockTransform(record: u32, block: u32) -> u32 {
    return (macroblocks[record + RECORD_MACROBLOCK_TRANSFORMS + block / 2u] >> ((block & 1u) * 16u)) & 0xFFFFu;
}

// The 8-point inverse transform of one row or column: FFmpeg's vc1_inv_trans_8x8 butterflies, without the final shift
fn transform8(s: array<i32, 8>, bias: i32) -> array<i32, 8> {
    let t1 = 12 * (s[0] + s[4]) + bias;
    let t2 = 12 * (s[0] - s[4]) + bias;
    let t3 = 16 * s[2] + 6 * s[6];
    let t4 = 6 * s[2] - 16 * s[6];
    let t5 = t1 + t3;
    let t6 = t2 + t4;
    let t7 = t2 - t4;
    let t8 = t1 - t3;
    let u1 = 16 * s[1] + 15 * s[3] + 9 * s[5] + 4 * s[7];
    let u2 = 15 * s[1] - 4 * s[3] - 16 * s[5] - 9 * s[7];
    let u3 = 9 * s[1] - 16 * s[3] + 4 * s[5] + 15 * s[7];
    let u4 = 4 * s[1] - 9 * s[3] + 15 * s[5] - 16 * s[7];
    return array<i32, 8>(t5 + u1, t6 + u2, t7 + u3, t8 + u4, t8 - u4, t7 - u3, t6 - u2, t5 - u1);
}

// The 4-point inverse transform: FFmpeg's vc1_inv_trans_4x* butterflies, without the final shift
fn transform4(s0: i32, s1: i32, s2: i32, s3: i32, bias: i32) -> vec4i {
    let t1 = 17 * (s0 + s2) + bias;
    let t2 = 17 * (s0 - s2) + bias;
    let t3 = 22 * s1 + 10 * s3;
    let t4 = 22 * s3 - 10 * s1;
    return vec4i(t1 + t3, t2 - t4, t2 + t4, t1 - t3);
}

fn blockValue(block: u32, row: u32, column: u32) -> i32 {
    return transformBlocks[block * 64u + row * 8u + column];
}

fn setBlockValue(block: u32, row: u32, column: u32, value: i32) {
    transformBlocks[block * 64u + row * 8u + column] = value;
}

// The subblocks a transform type splits a block into, and the first row and column of each
fn subblockOrigin(transformType: u32, subblock: u32) -> vec2u {
    switch (transformType) {
        case RECORD_TRANSFORM_8X4: {
            return vec2u(0u, subblock * 4u);
        }
        case RECORD_TRANSFORM_4X8: {
            return vec2u(subblock * 4u, 0u);
        }
        case RECORD_TRANSFORM_4X4: {
            return vec2u((subblock & 1u) * 4u, (subblock >> 1u) * 4u);
        }
        default: {
            return vec2u(0u, 0u);
        }
    }
}

// FFmpeg's simple IDCT, simple_idct_template.c at 8 bits and simple_idct.c: cos(k * pi / 16) * sqrt(2) in 14 bits for the
// 8-point passes, and the 4-point passes' cos(k * pi / 8) * sqrt(2) in 12 bits for columns and 15 bits for rows
const SIMPLE_W1: i32 = 22725;
const SIMPLE_W2: i32 = 21407;
const SIMPLE_W3: i32 = 19266;
const SIMPLE_W4: i32 = 16383;
const SIMPLE_W5: i32 = 12873;
const SIMPLE_W6: i32 = 8867;
const SIMPLE_W7: i32 = 4520;
const SIMPLE_ROW_SHIFT: u32 = 11u;
const SIMPLE_COL_SHIFT: u32 = 20u;
const SIMPLE_DC_SHIFT: u32 = 3u;
// (1 << (SIMPLE_COL_SHIFT - 1)) / SIMPLE_W4, the column pass's rounding folded into its DC term
const SIMPLE_COL_ROUNDING: i32 = 32;
const SIMPLE_C1: i32 = 3784;
const SIMPLE_C2: i32 = 1567;
const SIMPLE_C3: i32 = 2896;
const SIMPLE_C_SHIFT: u32 = 17u;
const SIMPLE_R1: i32 = 30274;
const SIMPLE_R2: i32 = 12540;
const SIMPLE_R3: i32 = 23170;
const SIMPLE_R_SHIFT: u32 = 11u;

// idctRowCondDC: one row of eight, kept in int16; a row with only its DC fills with the DC scaled
fn simpleRow8(s: array<i32, 8>) -> array<i32, 8> {
    if (s[1] == 0 && s[2] == 0 && s[3] == 0 && s[4] == 0 && s[5] == 0 && s[6] == 0 && s[7] == 0) {
        let dc = wrapInt16(s[0] << SIMPLE_DC_SHIFT);
        return array<i32, 8>(dc, dc, dc, dc, dc, dc, dc, dc);
    }
    var a0 = SIMPLE_W4 * s[0] + (1 << (SIMPLE_ROW_SHIFT - 1u));
    var a1 = a0;
    var a2 = a0;
    var a3 = a0;
    a0 += SIMPLE_W2 * s[2] + SIMPLE_W4 * s[4] + SIMPLE_W6 * s[6];
    a1 += SIMPLE_W6 * s[2] - SIMPLE_W4 * s[4] - SIMPLE_W2 * s[6];
    a2 += -SIMPLE_W6 * s[2] - SIMPLE_W4 * s[4] + SIMPLE_W2 * s[6];
    a3 += -SIMPLE_W2 * s[2] + SIMPLE_W4 * s[4] - SIMPLE_W6 * s[6];
    let b0 = SIMPLE_W1 * s[1] + SIMPLE_W3 * s[3] + SIMPLE_W5 * s[5] + SIMPLE_W7 * s[7];
    let b1 = SIMPLE_W3 * s[1] - SIMPLE_W7 * s[3] - SIMPLE_W1 * s[5] - SIMPLE_W5 * s[7];
    let b2 = SIMPLE_W5 * s[1] - SIMPLE_W1 * s[3] + SIMPLE_W7 * s[5] + SIMPLE_W3 * s[7];
    let b3 = SIMPLE_W7 * s[1] - SIMPLE_W5 * s[3] + SIMPLE_W3 * s[5] - SIMPLE_W1 * s[7];
    return array<i32, 8>(
        wrapInt16((a0 + b0) >> SIMPLE_ROW_SHIFT), wrapInt16((a1 + b1) >> SIMPLE_ROW_SHIFT),
        wrapInt16((a2 + b2) >> SIMPLE_ROW_SHIFT), wrapInt16((a3 + b3) >> SIMPLE_ROW_SHIFT),
        wrapInt16((a3 - b3) >> SIMPLE_ROW_SHIFT), wrapInt16((a2 - b2) >> SIMPLE_ROW_SHIFT),
        wrapInt16((a1 - b1) >> SIMPLE_ROW_SHIFT), wrapInt16((a0 - b0) >> SIMPLE_ROW_SHIFT));
}

// The 8-point column pass of idctSparseCol and idctSparseColAdd, before any int16 store
fn simpleColumn8(s: array<i32, 8>) -> array<i32, 8> {
    var a0 = SIMPLE_W4 * (s[0] + SIMPLE_COL_ROUNDING);
    var a1 = a0;
    var a2 = a0;
    var a3 = a0;
    a0 += SIMPLE_W2 * s[2] + SIMPLE_W4 * s[4] + SIMPLE_W6 * s[6];
    a1 += SIMPLE_W6 * s[2] - SIMPLE_W4 * s[4] - SIMPLE_W2 * s[6];
    a2 += -SIMPLE_W6 * s[2] - SIMPLE_W4 * s[4] + SIMPLE_W2 * s[6];
    a3 += -SIMPLE_W2 * s[2] + SIMPLE_W4 * s[4] - SIMPLE_W6 * s[6];
    let b0 = SIMPLE_W1 * s[1] + SIMPLE_W3 * s[3] + SIMPLE_W5 * s[5] + SIMPLE_W7 * s[7];
    let b1 = SIMPLE_W3 * s[1] - SIMPLE_W7 * s[3] - SIMPLE_W1 * s[5] - SIMPLE_W5 * s[7];
    let b2 = SIMPLE_W5 * s[1] - SIMPLE_W1 * s[3] + SIMPLE_W7 * s[5] + SIMPLE_W3 * s[7];
    let b3 = SIMPLE_W7 * s[1] - SIMPLE_W5 * s[3] + SIMPLE_W3 * s[5] - SIMPLE_W1 * s[7];
    return array<i32, 8>(
        (a0 + b0) >> SIMPLE_COL_SHIFT, (a1 + b1) >> SIMPLE_COL_SHIFT, (a2 + b2) >> SIMPLE_COL_SHIFT, (a3 + b3) >> SIMPLE_COL_SHIFT,
        (a3 - b3) >> SIMPLE_COL_SHIFT, (a2 - b2) >> SIMPLE_COL_SHIFT, (a1 - b1) >> SIMPLE_COL_SHIFT, (a0 - b0) >> SIMPLE_COL_SHIFT);
}

// idct4row: one row of four, kept in int16
fn simpleRow4(s0: i32, s1: i32, s2: i32, s3: i32) -> vec4i {
    let c0 = (s0 + s2) * SIMPLE_R3 + (1 << (SIMPLE_R_SHIFT - 1u));
    let c2 = (s0 - s2) * SIMPLE_R3 + (1 << (SIMPLE_R_SHIFT - 1u));
    let c1 = s1 * SIMPLE_R1 + s3 * SIMPLE_R2;
    let c3 = s1 * SIMPLE_R2 - s3 * SIMPLE_R1;
    return vec4i(wrapInt16((c0 + c1) >> SIMPLE_R_SHIFT), wrapInt16((c2 + c3) >> SIMPLE_R_SHIFT),
        wrapInt16((c2 - c3) >> SIMPLE_R_SHIFT), wrapInt16((c0 - c1) >> SIMPLE_R_SHIFT));
}

// idct4col_add's column of four, which adds to the prediction directly
fn simpleColumn4(s0: i32, s1: i32, s2: i32, s3: i32) -> vec4i {
    let c0 = (s0 + s2) * SIMPLE_C3 + (1 << (SIMPLE_C_SHIFT - 1u));
    let c2 = (s0 - s2) * SIMPLE_C3 + (1 << (SIMPLE_C_SHIFT - 1u));
    let c1 = s1 * SIMPLE_C1 + s3 * SIMPLE_C2;
    let c3 = s1 * SIMPLE_C2 - s3 * SIMPLE_C1;
    return vec4i((c0 + c1) >> SIMPLE_C_SHIFT, (c2 + c3) >> SIMPLE_C_SHIFT, (c2 - c3) >> SIMPLE_C_SHIFT, (c0 - c1) >> SIMPLE_C_SHIFT);
}

// The simple IDCT's row pass over one row of a block, in place: ff_simple_idct, ff_simple_idct84_add, 48_add, and 44_add
fn simpleTransformRow(record: u32, block: u32, row: u32) {
    let transform = blockTransform(record, block);
    if ((transform & RECORD_TRANSFORM_PRESENT_BIT) == 0u) {
        return;
    }
    let transformType = transform & RECORD_TRANSFORM_TYPE_MASK;
    let coded = (transform >> RECORD_TRANSFORM_CODED_SHIFT) & 15u;
    if (transformType == RECORD_TRANSFORM_8X8 || (transformType == RECORD_TRANSFORM_8X4 && ((coded >> (row >> 2u)) & 1u) != 0u)) {
        var samples: array<i32, 8>;
        for (var column = 0u; column < 8u; column += 1u) {
            samples[column] = blockValue(block, row, column);
        }
        let result = simpleRow8(samples);
        for (var column = 0u; column < 8u; column += 1u) {
            setBlockValue(block, row, column, result[column]);
        }
        return;
    }
    if (transformType == RECORD_TRANSFORM_8X4) {
        return;
    }
    for (var half = 0u; half < 2u; half += 1u) {
        var subblock = half;
        if (transformType == RECORD_TRANSFORM_4X4) {
            subblock = (row >> 2u) * 2u + half;
        }
        if (((coded >> subblock) & 1u) == 0u) {
            continue;
        }
        let first = half * 4u;
        let result = simpleRow4(blockValue(block, row, first), blockValue(block, row, first + 1u),
            blockValue(block, row, first + 2u), blockValue(block, row, first + 3u));
        for (var column = 0u; column < 4u; column += 1u) {
            setBlockValue(block, row, first + column, result[column]);
        }
    }
}

// The simple IDCT's column pass over one column: an intra block's samples, or the residual an inter block adds.
// An 8x8 block keeps its result in int16 unless only its DC is coded, which ff_simple_idct_add adds directly
fn simpleTransformColumn(record: u32, block: u32, column: u32, intra: bool) {
    let transform = blockTransform(record, block);
    if ((transform & RECORD_TRANSFORM_PRESENT_BIT) == 0u) {
        fillColumn(block, column, 0, 0u, 8u);
        return;
    }
    let transformType = transform & RECORD_TRANSFORM_TYPE_MASK;
    let coded = (transform >> RECORD_TRANSFORM_CODED_SHIFT) & 15u;
    let dcOnly = !intra && ((transform >> RECORD_TRANSFORM_DC_ONLY_SHIFT) & 1u) != 0u;
    if (transformType == RECORD_TRANSFORM_8X8 || transformType == RECORD_TRANSFORM_4X8) {
        if (transformType == RECORD_TRANSFORM_4X8 && ((coded >> (column >> 2u)) & 1u) == 0u) {
            fillColumn(block, column, 0, 0u, 8u);
            return;
        }
        var samples: array<i32, 8>;
        for (var row = 0u; row < 8u; row += 1u) {
            samples[row] = blockValue(block, row, column);
        }
        let result = simpleColumn8(samples);
        let keepsInt16 = transformType == RECORD_TRANSFORM_8X8 && !dcOnly;
        for (var row = 0u; row < 8u; row += 1u) {
            setBlockValue(block, row, column, select(result[row], wrapInt16(result[row]), keepsInt16));
        }
        return;
    }
    for (var vertical = 0u; vertical < 2u; vertical += 1u) {
        var subblock = vertical;
        if (transformType == RECORD_TRANSFORM_4X4) {
            subblock = vertical * 2u + (column >> 2u);
        }
        let first = vertical * 4u;
        if (((coded >> subblock) & 1u) == 0u) {
            fillColumn(block, column, 0, first, 4u);
            continue;
        }
        let result = simpleColumn4(blockValue(block, first, column), blockValue(block, first + 1u, column),
            blockValue(block, first + 2u, column), blockValue(block, first + 3u, column));
        for (var row = 0u; row < 4u; row += 1u) {
            setBlockValue(block, first + row, column, result[row]);
        }
    }
}

// The first pass of a block's inverse transform over one row, in place; a DC-only subblock's value is computed here from its DC
fn transformRow(record: u32, block: u32, row: u32, intra: bool) {
    if (simpleIdct) {
        simpleTransformRow(record, block, row);
        return;
    }
    let transform = blockTransform(record, block);
    if ((transform & RECORD_TRANSFORM_PRESENT_BIT) == 0u) {
        return;
    }
    let transformType = transform & RECORD_TRANSFORM_TYPE_MASK;
    let coded = (transform >> RECORD_TRANSFORM_CODED_SHIFT) & 15u;
    let dcOnly = select((transform >> RECORD_TRANSFORM_DC_ONLY_SHIFT) & 15u, 0u, intra);
    for (var subblock = 0u; subblock < 4u; subblock += 1u) {
        let origin = subblockOrigin(transformType, subblock);
        if (((dcOnly >> subblock) & 1u) != 0u && origin.y == row) {
            dcOnlyValues[block * 4u + subblock] = dcOnlyValue(transformType, blockValue(block, row, origin.x));
        }
    }
    switch (transformType) {
        case RECORD_TRANSFORM_8X8: {
            if ((dcOnly & 1u) != 0u) {
                return;
            }
            var samples: array<i32, 8>;
            for (var column = 0u; column < 8u; column += 1u) {
                samples[column] = blockValue(block, row, column);
            }
            let result = transform8(samples, 4);
            for (var column = 0u; column < 8u; column += 1u) {
                setBlockValue(block, row, column, wrapInt16(result[column] >> 3u));
            }
        }
        case RECORD_TRANSFORM_8X4: {
            let subblock = row >> 2u;
            if (((coded >> subblock) & 1u) == 0u || ((dcOnly >> subblock) & 1u) != 0u) {
                return;
            }
            var samples: array<i32, 8>;
            for (var column = 0u; column < 8u; column += 1u) {
                samples[column] = blockValue(block, row, column);
            }
            let result = transform8(samples, 4);
            for (var column = 0u; column < 8u; column += 1u) {
                setBlockValue(block, row, column, wrapInt16(result[column] >> 3u));
            }
        }
        default: {
            for (var half = 0u; half < 2u; half += 1u) {
                var subblock = half;
                if (transformType == RECORD_TRANSFORM_4X4) {
                    subblock = (row >> 2u) * 2u + half;
                }
                if (((coded >> subblock) & 1u) == 0u || ((dcOnly >> subblock) & 1u) != 0u) {
                    continue;
                }
                let first = half * 4u;
                let result = transform4(blockValue(block, row, first), blockValue(block, row, first + 1u),
                    blockValue(block, row, first + 2u), blockValue(block, row, first + 3u), 4);
                for (var column = 0u; column < 4u; column += 1u) {
                    setBlockValue(block, row, first + column, wrapInt16(result[column] >> 3u));
                }
            }
        }
    }
}

// The DC-only value of a subblock: FFmpeg's vc1_inv_trans_*_dc
fn dcOnlyValue(transformType: u32, dc: i32) -> i32 {
    switch (transformType) {
        case RECORD_TRANSFORM_8X8: {
            return (3 * ((3 * dc + 1) >> 1u) + 16) >> 5u;
        }
        case RECORD_TRANSFORM_8X4: {
            return (17 * ((3 * dc + 1) >> 1u) + 64) >> 7u;
        }
        case RECORD_TRANSFORM_4X8: {
            return (12 * ((17 * dc + 4) >> 3u) + 64) >> 7u;
        }
        default: {
            return (17 * ((17 * dc + 4) >> 3u) + 64) >> 7u;
        }
    }
}

// Fills rows [first, first + count) of a column with one value
fn fillColumn(block: u32, column: u32, value: i32, first: u32, count: u32) {
    for (var row = first; row < first + count; row += 1u) {
        setBlockValue(block, row, column, value);
    }
}

// The second pass over one column: the residual each sample adds, or for intra blocks the sample before it is put.
// The 8x8 transform keeps its result in int16 as FFmpeg's block does; the others add their result directly
fn transformColumn(record: u32, block: u32, column: u32, intra: bool) {
    if (simpleIdct) {
        simpleTransformColumn(record, block, column, intra);
        return;
    }
    let transform = blockTransform(record, block);
    if ((transform & RECORD_TRANSFORM_PRESENT_BIT) == 0u) {
        fillColumn(block, column, 0, 0u, 8u);
        return;
    }
    let transformType = transform & RECORD_TRANSFORM_TYPE_MASK;
    let coded = (transform >> RECORD_TRANSFORM_CODED_SHIFT) & 15u;
    let dcOnly = select((transform >> RECORD_TRANSFORM_DC_ONLY_SHIFT) & 15u, 0u, intra);
    switch (transformType) {
        case RECORD_TRANSFORM_8X8: {
            if ((dcOnly & 1u) != 0u) {
                fillColumn(block, column, dcOnlyValues[block * 4u], 0u, 8u);
                return;
            }
            var samples: array<i32, 8>;
            for (var row = 0u; row < 8u; row += 1u) {
                samples[row] = blockValue(block, row, column);
            }
            let result = transform8(samples, 64);
            for (var row = 0u; row < 8u; row += 1u) {
                let rounding = select(0, 1, row >= 4u);
                setBlockValue(block, row, column, wrapInt16((result[row] + rounding) >> 7u));
            }
        }
        case RECORD_TRANSFORM_8X4: {
            for (var subblock = 0u; subblock < 2u; subblock += 1u) {
                let first = subblock * 4u;
                if (((coded >> subblock) & 1u) == 0u) {
                    fillColumn(block, column, 0, first, 4u);
                    continue;
                }
                if (((dcOnly >> subblock) & 1u) != 0u) {
                    fillColumn(block, column, dcOnlyValues[block * 4u + subblock], first, 4u);
                    continue;
                }
                let result = transform4(blockValue(block, first, column), blockValue(block, first + 1u, column),
                    blockValue(block, first + 2u, column), blockValue(block, first + 3u, column), 64);
                for (var row = 0u; row < 4u; row += 1u) {
                    setBlockValue(block, first + row, column, result[row] >> 7u);
                }
            }
        }
        case RECORD_TRANSFORM_4X8: {
            let subblock = column >> 2u;
            if (((coded >> subblock) & 1u) == 0u) {
                fillColumn(block, column, 0, 0u, 8u);
                return;
            }
            if (((dcOnly >> subblock) & 1u) != 0u) {
                fillColumn(block, column, dcOnlyValues[block * 4u + subblock], 0u, 8u);
                return;
            }
            var samples: array<i32, 8>;
            for (var row = 0u; row < 8u; row += 1u) {
                samples[row] = blockValue(block, row, column);
            }
            let result = transform8(samples, 64);
            for (var row = 0u; row < 8u; row += 1u) {
                let rounding = select(0, 1, row >= 4u);
                setBlockValue(block, row, column, (result[row] + rounding) >> 7u);
            }
        }
        default: {
            let half = column >> 2u;
            for (var vertical = 0u; vertical < 2u; vertical += 1u) {
                let subblock = vertical * 2u + half;
                let first = vertical * 4u;
                if (((coded >> subblock) & 1u) == 0u) {
                    fillColumn(block, column, 0, first, 4u);
                    continue;
                }
                if (((dcOnly >> subblock) & 1u) != 0u) {
                    fillColumn(block, column, dcOnlyValues[block * 4u + subblock], first, 4u);
                    continue;
                }
                let result = transform4(blockValue(block, first, column), blockValue(block, first + 1u, column),
                    blockValue(block, first + 2u, column), blockValue(block, first + 3u, column), 64);
                for (var row = 0u; row < 4u; row += 1u) {
                    setBlockValue(block, first + row, column, result[row] >> 7u);
                }
            }
        }
    }
}

// Where a macroblock pixel's residual sits: the block and its row, with FIELDTX blocks holding alternate rows
fn lumaResidualPosition(fieldTransform: bool, x: u32, y: u32) -> vec2u {
    if (fieldTransform) {
        return vec2u((x >> 3u) + 2u * (y & 1u), y >> 1u);
    }
    return vec2u((x >> 3u) + 2u * (y >> 3u), y & 7u);
}

// An intra sample as FFmpeg puts it: range reduction scales P and B intra blocks, and Simple and Main I pictures without overlap
fn intraSampleBeforeOverlap(value: i32) -> i32 {
    if (passRangered == 0u) {
        return value;
    }
    if (passPictureType == RECORD_TYPE_I || passPictureType == RECORD_TYPE_BI) {
        if (parameter(RECORD_PASS_UNSIGNED_INTRA) != 0u) {
            return wrapInt16((value - 64) * 2);
        }
        return value;
    }
    return wrapInt16(value * 2);
}

fn putIntraSample(value: i32) -> u32 {
    if (parameter(RECORD_PASS_UNSIGNED_INTRA) != 0u) {
        return clipToByte(value);
    }
    return clipToByte(value + 128);
}

// Writes one sample of the output slot; the invocation must own the sample's word for the whole pass
fn writePictureSample(plane: u32, x: u32, y: u32, value: u32) {
    let byteAddress = getSampleByteAddress(packet.outputSlot, plane, x, y);
    let wordIndex = byteAddress >> 2u;
    let shift = (byteAddress & 3u) * 8u;
    framePool[wordIndex] = (framePool[wordIndex] & ~(0xFFu << shift)) | ((value & 0xFFu) << shift);
}

// Reconstructs one macroblock of a pass: coefficients, inverse transforms, motion compensation, and the residual add
fn reconstructMacroblock(passIndex: u32, workgroupId: vec3u, localIndex: u32) {
    loadGeometry();
    let valid = loadPassParameters(passIndex);
    currentPass = passIndex;
    let column = workgroupId.x;
    let row = workgroupId.y;
    if (localIndex == 0u) {
        workgroupActive = select(0u, 1u, valid && column < mbWidth && row < passRows);
    }
    if (workgroupUniformLoad(&workgroupActive) == 0u) {
        return;
    }
    let record = macroblockRecord(column, passRowOffset + row);
    let flags = macroblocks[record + RECORD_MACROBLOCK_FLAGS];
    let intraMask = flags & 0x3Fu;
    let fieldTransform = (flags & RECORD_MACROBLOCK_FIELDTX_BIT) != 0u;
    for (var index = localIndex; index < 384u; index += 64u) {
        transformBlocks[index] = 0;
    }
    workgroupBarrier();
    let macroblockIndex = record / MACROBLOCK_WORDS;
    for (var block = 0u; block < 6u; block += 1u) {
        let counts = macroblocks[record + select(RECORD_MACROBLOCK_COUNTS + 1u, RECORD_MACROBLOCK_COUNTS, block < 4u)];
        let count = (counts >> ((block & 3u) * 8u)) & 0xFFu;
        let base = (macroblockIndex * 6u + block) * RECORD_COEFFICIENTS_PER_BLOCK;
        for (var entry = localIndex; entry < count; entry += 64u) {
            let word = blockData[base + entry];
            transformBlocks[block * 64u + ((word >> 16u) & 63u)] = i32(word << 16u) >> 16u;
        }
    }
    workgroupBarrier();
    if (localIndex < 48u) {
        let block = localIndex >> 3u;
        transformRow(record, block, localIndex & 7u, ((intraMask >> block) & 1u) != 0u);
    }
    workgroupBarrier();
    if (localIndex < 48u) {
        let block = localIndex >> 3u;
        transformColumn(record, block, localIndex & 7u, ((intraMask >> block) & 1u) != 0u);
    }
    workgroupBarrier();
    let deferIntra = overlapActive();

    // Luma: one word of four samples per invocation
    let lumaRow = localIndex >> 2u;
    let lumaX = (localIndex & 3u) * 4u;
    let lumaPosition = lumaResidualPosition(fieldTransform, lumaX, lumaRow);
    let lumaBlock = lumaPosition.x;
    let pictureY = pictureRow(row * 16u + lumaRow);
    let pictureX = column * 16u + lumaX;
    if (((intraMask >> lumaBlock) & 1u) != 0u) {
        var outputSamples = vec4u(0u, 0u, 0u, 0u);
        for (var lane = 0u; lane < 4u; lane += 1u) {
            let value = intraSampleBeforeOverlap(blockValue(lumaBlock, lumaPosition.y, (lumaX + lane) & 7u));
            if (deferIntra) {
                setIntraSample(0u, pictureX + lane, pictureY, value);
            } else {
                outputSamples[lane] = putIntraSample(value);
            }
        }
        if (!deferIntra) {
            writePictureWord(0u, pictureX, pictureY, outputSamples);
        }
    } else {
        let coded = (blockTransform(record, lumaBlock) & RECORD_TRANSFORM_PRESENT_BIT) != 0u;
        var outputSamples = vec4u(0u, 0u, 0u, 0u);
        for (var lane = 0u; lane < 4u; lane += 1u) {
            var value = predictLuma(record, column, row, lumaX + lane, lumaRow);
            if (coded) {
                value += blockValue(lumaBlock, lumaPosition.y, (lumaX + lane) & 7u);
            }
            outputSamples[lane] = clipToByte(value);
        }
        writePictureWord(0u, pictureX, pictureY, outputSamples);
    }

    // Chroma: one word per invocation of the first 32, eight rows of two words per plane
    if (localIndex < 32u) {
        let plane = 1u + (localIndex >> 4u);
        let chromaRow = (localIndex >> 1u) & 7u;
        let chromaX = (localIndex & 1u) * 4u;
        let block = 3u + plane;
        let chromaY = pictureRow(row * 8u + chromaRow);
        let chromaPictureX = column * 8u + chromaX;
        if (((intraMask >> block) & 1u) != 0u) {
            var outputSamples = vec4u(0u, 0u, 0u, 0u);
            for (var lane = 0u; lane < 4u; lane += 1u) {
                let value = intraSampleBeforeOverlap(blockValue(block, chromaRow, chromaX + lane));
                if (deferIntra) {
                    setIntraSample(plane, chromaPictureX + lane, chromaY, value);
                } else {
                    outputSamples[lane] = putIntraSample(value);
                }
            }
            if (!deferIntra) {
                writePictureWord(plane, chromaPictureX, chromaY, outputSamples);
            }
        } else {
            let coded = (blockTransform(record, block) & RECORD_TRANSFORM_PRESENT_BIT) != 0u;
            var outputSamples = vec4u(0u, 0u, 0u, 0u);
            for (var lane = 0u; lane < 4u; lane += 1u) {
                var value = predictChroma(record, plane, column, row, chromaX + lane, chromaRow);
                if (coded) {
                    value += blockValue(block, chromaRow, chromaX + lane);
                }
                outputSamples[lane] = clipToByte(value);
            }
            writePictureWord(plane, chromaPictureX, chromaY, outputSamples);
        }
    }
}

fn setIntraSample(plane: u32, x: u32, y: u32, value: i32) {
    blockData[intraSampleIndex(plane, x, y)] = bitcast<u32>(value);
}

fn intraSample(plane: u32, x: u32, y: u32) -> i32 {
    return bitcast<i32>(blockData[intraSampleIndex(plane, x, y)]);
}

@compute @workgroup_size(64)
fn reconstruct(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    reconstructMacroblock(pictureState[F_CURRENT_PASS], workgroupId, localIndex);
}

// Moves the pass stages on to a frame's second field: each stage reads the pass it works on from the picture state, so one pipeline
// serves both passes
@compute @workgroup_size(1)
fn nextPass() {
    pictureState[F_CURRENT_PASS] = 1u;
}

// The four samples a copy puts at x, a multiple of 4: a pool slot's, mid-gray for a missing slot, or the record's, whose planes hold
// rows of whole macroblocks tightly packed, luma then Cb and Cr
fn copiedSamples(mode: u32, source: u32, plane: u32, x: u32, y: u32) -> vec4u {
    if (mode == COPY_MODE_SAMPLES) {
        let lumaWidth = mbWidth * MACROBLOCK_SIZE;
        let lumaHeight = mbHeight * MACROBLOCK_SIZE;
        var planeStart = 0u;
        var width = lumaWidth;
        if (plane != 0u) {
            width = lumaWidth / 2u;
            planeStart = lumaWidth * lumaHeight + (plane - 1u) * width * (lumaHeight / 2u);
        }
        let word = readPacketWord(source + (planeStart + y * width + x) / 4u);
        return vec4u(word & 0xFFu, (word >> 8u) & 0xFFu, (word >> 16u) & 0xFFu, word >> 24u);
    }
    if (source == NO_SLOT) {
        return vec4u(128u, 128u, 128u, 128u);
    }
    var samples = vec4u(0u, 0u, 0u, 0u);
    for (var lane = 0u; lane < 4u; lane += 1u) {
        samples[lane] = readSlotSample(source, plane, x + lane, y);
    }
    return samples;
}

// Fills a picture that reconstructs nothing, one macroblock per workgroup: a copy of a pool slot, as a skipped P picture copies its
// forward reference, or the samples of an IntraX8 picture's record, which the parser decoded and filtered
@compute @workgroup_size(64)
fn copyPicture(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    loadGeometry();
    let mode = pictureState[F_COPY_MODE];
    let column = workgroupId.x;
    let row = workgroupId.y;
    if (mode == COPY_MODE_NONE || column >= mbWidth || row >= mbHeight) {
        return;
    }
    let source = pictureState[F_COPY_SOURCE];
    if (mode == COPY_MODE_SLOT && source == packet.outputSlot) {
        return;
    }
    let lumaRow = row * 16u + (localIndex >> 2u);
    let lumaX = column * 16u + (localIndex & 3u) * 4u;
    writePictureWord(0u, lumaX, lumaRow, copiedSamples(mode, source, 0u, lumaX, lumaRow));
    if (localIndex < 32u) {
        let plane = 1u + (localIndex >> 4u);
        let chromaRow = row * 8u + ((localIndex >> 1u) & 7u);
        let chromaX = column * 8u + (localIndex & 1u) * 4u;
        writePictureWord(plane, chromaX, chromaRow, copiedSamples(mode, source, plane, chromaX, chromaRow));
    }
}

// Overlap smoothing, FFmpeg's vc1_h_s_overlap and vc1_v_s_overlap on the intra samples: rnd1 alternates 4, 3 along the edge
fn overlapEdge(plane: u32, x0: u32, y0: u32, vertical: bool, alongIndex: u32) {
    var positions: array<vec2u, 4>;
    for (var k = 0u; k < 4u; k += 1u) {
        if (vertical) {
            positions[k] = vec2u(x0 - 2u + k, y0);
        } else {
            positions[k] = vec2u(x0, pictureRow(y0 - 2u + k));
        }
    }
    let a = intraSample(plane, positions[0].x, positions[0].y);
    let b = intraSample(plane, positions[1].x, positions[1].y);
    let c = intraSample(plane, positions[2].x, positions[2].y);
    let d = intraSample(plane, positions[3].x, positions[3].y);
    let rnd1 = select(4, 3, (alongIndex & 1u) != 0u);
    let rnd2 = 7 - rnd1;
    let d1 = a - d;
    let d2 = a - d + b - c;
    setIntraSample(plane, positions[0].x, positions[0].y, wrapInt16(((a * 8) - d1 + rnd1) >> 3u));
    setIntraSample(plane, positions[1].x, positions[1].y, wrapInt16(((b * 8) - d2 + rnd2) >> 3u));
    setIntraSample(plane, positions[2].x, positions[2].y, wrapInt16(((c * 8) + d2 + rnd1) >> 3u));
    setIntraSample(plane, positions[3].x, positions[3].y, wrapInt16(((d * 8) + d1 + rnd2) >> 3u));
}

fn recordFlags(column: u32, row: u32) -> u32 {
    return macroblocks[macroblockRecord(column, passRowOffset + row) + RECORD_MACROBLOCK_FLAGS];
}

fn blockIsIntra(column: u32, row: u32, block: u32) -> bool {
    return ((recordFlags(column, row) >> block) & 1u) != 0u;
}

// The overlap condition of an I picture edge: every edge above PQUANT 8, or per CONDOVER; internal edges need only this macroblock's flag
fn intraPictureOverlaps(column: u32, row: u32, internal: bool, neighborColumn: u32, neighborRow: u32) -> bool {
    if (parameter(RECORD_PASS_PQ) >= 9u) {
        return true;
    }
    if (passProfile != RECORD_PROFILE_ADVANCED) {
        return false;
    }
    let condition = parameter(RECORD_PASS_CONDOVER);
    if (condition == RECORD_CONDOVER_ALL) {
        return true;
    }
    if (condition != RECORD_CONDOVER_SELECT || (recordFlags(column, row) & RECORD_MACROBLOCK_OVERFLAG_BIT) == 0u) {
        return false;
    }
    return internal || (recordFlags(neighborColumn, neighborRow) & RECORD_MACROBLOCK_OVERFLAG_BIT) != 0u;
}

// Overlap smoothing across vertical edges, before the horizontal edges: the macroblock's left edge and its internal luma edge
fn overlapVerticalEdgesInPass(passIndex: u32, workgroupId: vec3u, localIndex: u32) {
    loadGeometry();
    if (!loadPassParameters(passIndex) || !overlapActive()) {
        return;
    }
    let column = workgroupId.x;
    let row = workgroupId.y;
    if (column >= mbWidth || row >= passRows || localIndex >= 48u) {
        return;
    }
    let isIntraPicture = passPictureType == RECORD_TYPE_I || passPictureType == RECORD_TYPE_BI;
    var plane = 0u;
    var edgeX = 0u;
    var along = 0u;
    var internal = false;
    var leftBlock = 0u;
    var rightBlock = 0u;
    var leftColumn = column;
    if (localIndex < 16u) {
        if (column == 0u) {
            return;
        }
        along = localIndex;
        edgeX = column * 16u;
        leftColumn = column - 1u;
        leftBlock = select(1u, 3u, along >= 8u);
        rightBlock = select(0u, 2u, along >= 8u);
    } else if (localIndex < 32u) {
        along = localIndex - 16u;
        edgeX = column * 16u + 8u;
        internal = true;
        leftBlock = select(0u, 2u, along >= 8u);
        rightBlock = leftBlock + 1u;
    } else {
        if (column == 0u) {
            return;
        }
        plane = 1u + (localIndex - 32u) / 8u;
        along = (localIndex - 32u) % 8u;
        edgeX = column * 8u;
        leftColumn = column - 1u;
        leftBlock = 3u + plane;
        rightBlock = leftBlock;
    }
    var applies = false;
    if (isIntraPicture) {
        applies = intraPictureOverlaps(column, row, internal, column - select(1u, 0u, internal), row);
    } else {
        applies = blockIsIntra(column, row, rightBlock) && blockIsIntra(leftColumn, row, leftBlock);
    }
    if (!applies) {
        return;
    }
    let rowsPerMacroblock = select(16u, 8u, plane != 0u);
    overlapEdge(plane, edgeX, pictureRow(row * rowsPerMacroblock + along), true, along);
}

// Overlap smoothing across horizontal edges: the macroblock's top edge, unless a slice starts at it, and its internal luma edge
fn overlapHorizontalEdgesInPass(passIndex: u32, workgroupId: vec3u, localIndex: u32) {
    loadGeometry();
    if (!loadPassParameters(passIndex) || !overlapActive() || passFcm == RECORD_FCM_FRAME) {
        return;
    }
    let column = workgroupId.x;
    let row = workgroupId.y;
    if (column >= mbWidth || row >= passRows || localIndex >= 48u) {
        return;
    }
    let isIntraPicture = passPictureType == RECORD_TYPE_I || passPictureType == RECORD_TYPE_BI;
    let sliceTop = (recordFlags(column, row) & RECORD_MACROBLOCK_SLICE_TOP_BIT) != 0u;
    var plane = 0u;
    var edgeRow = 0u;
    var along = 0u;
    var internal = false;
    var topBlock = 0u;
    var bottomBlock = 0u;
    var topRow = row;
    var x = 0u;
    if (localIndex < 16u) {
        if (sliceTop || row == 0u) {
            return;
        }
        along = localIndex;
        edgeRow = row * 16u;
        topRow = row - 1u;
        topBlock = select(2u, 3u, along >= 8u);
        bottomBlock = select(0u, 1u, along >= 8u);
        x = column * 16u + along;
    } else if (localIndex < 32u) {
        along = localIndex - 16u;
        edgeRow = row * 16u + 8u;
        internal = true;
        topBlock = select(0u, 1u, along >= 8u);
        bottomBlock = topBlock + 2u;
        x = column * 16u + along;
    } else {
        if (sliceTop || row == 0u) {
            return;
        }
        plane = 1u + (localIndex - 32u) / 8u;
        along = (localIndex - 32u) % 8u;
        edgeRow = row * 8u;
        topRow = row - 1u;
        topBlock = 3u + plane;
        bottomBlock = topBlock;
        x = column * 8u + along;
    }
    var applies = false;
    if (isIntraPicture) {
        applies = intraPictureOverlaps(column, row, internal, column, row - select(1u, 0u, internal));
    } else {
        applies = blockIsIntra(column, row, bottomBlock) && blockIsIntra(column, topRow, topBlock);
    }
    if (!applies) {
        return;
    }
    overlapEdge(plane, x, edgeRow, false, along);
}

@compute @workgroup_size(64)
fn overlapVerticalEdges(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    overlapVerticalEdgesInPass(pictureState[F_CURRENT_PASS], workgroupId, localIndex);
}

@compute @workgroup_size(64)
fn overlapHorizontalEdges(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    overlapHorizontalEdgesInPass(pictureState[F_CURRENT_PASS], workgroupId, localIndex);
}

// Puts the smoothed intra samples of a pass; range reduction scales I pictures after overlap smoothing, as FFmpeg does
fn putIntraSamples(passIndex: u32, workgroupId: vec3u, localIndex: u32) {
    loadGeometry();
    if (!loadPassParameters(passIndex) || !overlapActive()) {
        return;
    }
    let column = workgroupId.x;
    let row = workgroupId.y;
    if (column >= mbWidth || row >= passRows) {
        return;
    }
    let flags = recordFlags(column, row);
    let intraMask = flags & 0x3Fu;
    let fieldTransform = (flags & RECORD_MACROBLOCK_FIELDTX_BIT) != 0u;
    let scaleAfterOverlap = passRangered != 0u && (passPictureType == RECORD_TYPE_I || passPictureType == RECORD_TYPE_BI);
    let lumaRow = localIndex >> 2u;
    let lumaX = (localIndex & 3u) * 4u;
    let lumaBlock = lumaResidualPosition(fieldTransform, lumaX, lumaRow).x;
    if (((intraMask >> lumaBlock) & 1u) != 0u) {
        let pictureY = pictureRow(row * 16u + lumaRow);
        let pictureX = column * 16u + lumaX;
        var outputSamples = vec4u(0u, 0u, 0u, 0u);
        for (var lane = 0u; lane < 4u; lane += 1u) {
            var value = intraSample(0u, pictureX + lane, pictureY);
            if (scaleAfterOverlap) {
                value = wrapInt16(value * 2);
            }
            outputSamples[lane] = clipToByte(value + 128);
        }
        writePictureWord(0u, pictureX, pictureY, outputSamples);
    }
    if (localIndex < 32u) {
        let plane = 1u + (localIndex >> 4u);
        let block = 3u + plane;
        if (((intraMask >> block) & 1u) != 0u) {
            let chromaY = pictureRow(row * 8u + ((localIndex >> 1u) & 7u));
            let chromaX = column * 8u + (localIndex & 1u) * 4u;
            var outputSamples = vec4u(0u, 0u, 0u, 0u);
            for (var lane = 0u; lane < 4u; lane += 1u) {
                var value = intraSample(plane, chromaX + lane, chromaY);
                if (scaleAfterOverlap) {
                    value = wrapInt16(value * 2);
                }
                outputSamples[lane] = clipToByte(value + 128);
            }
            writePictureWord(plane, chromaX, chromaY, outputSamples);
        }
    }
}

@compute @workgroup_size(64)
fn putIntra(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    putIntraSamples(pictureState[F_CURRENT_PASS], workgroupId, localIndex);
}

// WGSL of the VC-1 decoder's in-loop deblocking filter, FFmpeg's vc1_loopfilter.c and vc1_loop_filter.
// FFmpeg filters every horizontal edge before any vertical edge; along each, the 8-aligned edges come before the 4-aligned subblock edges,
// which only read samples the earlier ones settled, so each set filters in parallel as its own pass.
// Interlaced frame pictures filter field rows two apart, which overlap, so their edges filter in order along each column and row.
// One sample of a loop filter line: sample k of the 8 across an edge, k = 4 the first after it
fn lineSamplePosition(horizontalEdge: bool, x: u32, edge: u32, k: u32, rowStep: u32) -> vec2u {
    if (horizontalEdge) {
        return vec2u(x, pictureRow(edge - 4u * rowStep + k * rowStep));
    }
    return vec2u(edge - 4u + k, x);
}

// FFmpeg's vc1_filter_line on the line through x across an edge; returns whether the segment's other lines filter.
// For a horizontal edge, x is the column and edge the pass row after the edge; for a vertical edge, x is the picture row and edge the column
fn filterLine(plane: u32, horizontalEdge: bool, x: u32, edge: u32, rowStep: u32, pq: i32) -> bool {
    var line: array<i32, 8>;
    var positions: array<vec2u, 8>;
    for (var k = 0u; k < 8u; k += 1u) {
        positions[k] = lineSamplePosition(horizontalEdge, x, edge, k, rowStep);
        line[k] = i32(readPictureSample(plane, positions[k].x, positions[k].y));
    }
    var a0 = (2 * (line[2] - line[5]) - 5 * (line[3] - line[4]) + 4) >> 3u;
    let a0Sign = a0 >> 31u;
    a0 = (a0 ^ a0Sign) - a0Sign;
    if (a0 >= pq) {
        return false;
    }
    let a1 = abs((2 * (line[0] - line[3]) - 5 * (line[1] - line[2]) + 4) >> 3u);
    let a2 = abs((2 * (line[4] - line[7]) - 5 * (line[5] - line[6]) + 4) >> 3u);
    if (a1 >= a0 && a2 >= a0) {
        return false;
    }
    var clip = line[3] - line[4];
    let clipSign = clip >> 31u;
    clip = ((clip ^ clipSign) - clipSign) >> 1u;
    if (clip == 0) {
        return false;
    }
    let a3 = min(a1, a2);
    var d = (5 * (a0 - a3)) >> 3u;
    if ((a0Sign ^ clipSign) != 0) {
        d = min(d, clip);
        d = (d ^ clipSign) - clipSign;
        writePictureSample(plane, positions[3].x, positions[3].y, clipToByte(line[3] - d));
        writePictureSample(plane, positions[4].x, positions[4].y, clipToByte(line[4] + d));
    }
    return true;
}

// FFmpeg's vc1_loop_filter on one segment of four lines: the third line decides for the others.
// For a horizontal edge the lines are columns x to x + 3; for a vertical edge they are the pass rows x to x + 3, rowStep apart in the picture
fn filterSegment(plane: u32, horizontalEdge: bool, first: u32, edge: u32, rowStep: u32, pq: i32) {
    if (horizontalEdge) {
        if (filterLine(plane, true, first + 2u, edge, rowStep, pq)) {
            filterLine(plane, true, first, edge, rowStep, pq);
            filterLine(plane, true, first + 1u, edge, rowStep, pq);
            filterLine(plane, true, first + 3u, edge, rowStep, pq);
        }
        return;
    }
    if (filterLine(plane, false, segmentRow(first, 2u, rowStep), edge, rowStep, pq)) {
        filterLine(plane, false, segmentRow(first, 0u, rowStep), edge, rowStep, pq);
        filterLine(plane, false, segmentRow(first, 1u, rowStep), edge, rowStep, pq);
        filterLine(plane, false, segmentRow(first, 3u, rowStep), edge, rowStep, pq);
    }
}

// The picture row of line k of a vertical edge segment starting at a pass row
fn segmentRow(first: u32, k: u32, rowStep: u32) -> u32 {
    return pictureRow(first + k * rowStep);
}

fn macroblockField(column: u32, row: u32, field: u32) -> u32 {
    return macroblocks[macroblockRecord(column, passRowOffset + row) + field];
}

// What a P picture edge decision reads of a block: its intra flag, its four coded subblock bits, its vector, and its field flag
struct EdgeBlock {
    intra: bool,
    pattern: u32,
    vector: u32,
    field: u32,
}

fn edgeBlock(column: u32, row: u32, block: u32) -> EdgeBlock {
    let intra = ((macroblockField(column, row, RECORD_MACROBLOCK_IS_INTRA) >> block) & 1u) != 0u;
    let pattern = (macroblockField(column, row, RECORD_MACROBLOCK_CBP) >> (block * 4u)) & 15u;
    var vector = 0u;
    if (block < 4u) {
        vector = macroblockField(column, row, RECORD_MACROBLOCK_MV0 + block);
    } else {
        vector = macroblockField(column, row, RECORD_MACROBLOCK_LOOP_FILTER_CHROMA_MV);
    }
    let field = (macroblockField(column, row, RECORD_MACROBLOCK_FIELD_FLAGS) >> block) & 1u;
    return EdgeBlock(intra, pattern, vector, field);
}

// FFmpeg's whole-edge condition of vc1_p_v_loop_filter and vc1_p_h_loop_filter
fn filtersWholeEdge(first: EdgeBlock, second: EdgeBlock) -> bool {
    return first.intra || second.intra || first.vector != second.vector || (passFcm == RECORD_FCM_FIELD && first.field != second.field);
}

// Whether the pass decides edges from coded patterns and vectors, as P pictures do, rather than filtering every block edge
fn usesPEdgeDecisions() -> bool {
    return passPictureType == RECORD_TYPE_P;
}

// Whether the pass filters 4x4, 8x4, and 4x8 subblock edges: P pictures and field B pictures
fn filtersSubblockEdges() -> bool {
    return passPictureType == RECORD_TYPE_P || (passPictureType == RECORD_TYPE_B && passFcm == RECORD_FCM_FIELD);
}

fn blockTransformType(column: u32, row: u32, block: u32) -> u32 {
    return (macroblockField(column, row, RECORD_MACROBLOCK_TT) >> (block * 4u)) & 15u;
}

fn loopFilterActive(passIndex: u32) -> bool {
    return loadPassParameters(passIndex) && parameter(RECORD_PASS_LOOP_FILTER) != 0u && passFcm != RECORD_FCM_FRAME;
}

// Whether the frame's single pass is an interlaced frame picture with the loop filter on
fn frameLoopFilterActive() -> bool {
    return loadPassParameters(0u) && parameter(RECORD_PASS_LOOP_FILTER) != 0u && passFcm == RECORD_FCM_FRAME;
}

// Horizontal block edges: each macroblock filters its internal luma edge and its bottom edge, unless its slice ends there.
// Invocations 0 to 3 take the internal edge's 4-sample segments, 4 to 7 the luma bottom edge, 8 to 11 the chroma bottom edges
fn filterHorizontalBlockEdgesInPass(passIndex: u32, workgroupId: vec3u, localIndex: u32) {
    loadGeometry();
    if (!loopFilterActive(passIndex)) {
        return;
    }
    let column = workgroupId.x;
    let row = workgroupId.y;
    if (column >= mbWidth || row >= passRows || localIndex >= 12u) {
        return;
    }
    let pq = i32(parameter(RECORD_PASS_PQ));
    let lastRow = row + 1u >= passRows || (macroblockField(column, row, RECORD_MACROBLOCK_FLAGS) & RECORD_MACROBLOCK_SLICE_BOTTOM_BIT) != 0u;
    var plane = 0u;
    var segment = localIndex & 3u;
    var edge = 0u;
    var topBlock = 0u;
    var bottomBlock = 0u;
    var bottomRow = row;
    if (localIndex < 4u) {
        edge = row * 16u + 8u;
        topBlock = segment >> 1u;
        bottomBlock = topBlock + 2u;
    } else if (localIndex < 8u) {
        if (lastRow) {
            return;
        }
        edge = row * 16u + 16u;
        topBlock = 2u + (segment >> 1u);
        bottomBlock = segment >> 1u;
        bottomRow = row + 1u;
    } else {
        if (lastRow) {
            return;
        }
        plane = 1u + ((localIndex - 8u) >> 1u);
        segment = (localIndex - 8u) & 1u;
        edge = row * 8u + 8u;
        topBlock = 3u + plane;
        bottomBlock = topBlock;
        bottomRow = row + 1u;
    }
    let x = select(column * 16u, column * 8u, plane != 0u) + segment * 4u;
    if (usesPEdgeDecisions()) {
        let top = edgeBlock(column, row, topBlock);
        let bottom = edgeBlock(column, bottomRow, bottomBlock);
        if (!filtersWholeEdge(top, bottom)) {
            // The right half is bit 0 of either block's adjacent subblocks, the left half bit 1
            let index = (top.pattern | (bottom.pattern >> 2u)) & 3u;
            let half = select(1u, 2u, (segment & 1u) == 0u);
            if ((index & half) == 0u) {
                return;
            }
        }
    }
    filterSegment(plane, true, x, edge, 1u, pq);
}

// Horizontal subblock edges at row 4 of each block whose transform splits it horizontally
fn filterHorizontalSubblockEdgesInPass(passIndex: u32, workgroupId: vec3u, localIndex: u32) {
    loadGeometry();
    if (!loopFilterActive(passIndex) || !filtersSubblockEdges()) {
        return;
    }
    let column = workgroupId.x;
    let row = workgroupId.y;
    if (column >= mbWidth || row >= passRows || localIndex >= 12u) {
        return;
    }
    let pq = i32(parameter(RECORD_PASS_PQ));
    var plane = 0u;
    var block = 0u;
    var segment = 0u;
    var edge = 0u;
    if (localIndex < 8u) {
        // Luma blocks 0 to 3, two segments each
        block = localIndex >> 1u;
        segment = localIndex & 1u;
        edge = row * 16u + (block >> 1u) * 8u + 4u;
    } else {
        plane = 1u + ((localIndex - 8u) >> 1u);
        block = 3u + plane;
        segment = (localIndex - 8u) & 1u;
        edge = row * 8u + 4u;
    }
    let transformType = blockTransformType(column, row, block);
    if (transformType != RECORD_TT_4X4 && transformType != RECORD_TT_8X4) {
        return;
    }
    let pattern = (macroblockField(column, row, RECORD_MACROBLOCK_CBP) >> (block * 4u)) & 15u;
    // The right half filters when a right subblock is coded, the left half when a left one is
    let mask = select(5u, 10u, segment == 0u);
    if ((pattern & mask) == 0u) {
        return;
    }
    var x = column * 8u + segment * 4u;
    if (plane == 0u) {
        x = column * 16u + (block & 1u) * 8u + segment * 4u;
    }
    filterSegment(plane, true, x, edge, 1u, pq);
}

// Vertical block edges: each macroblock filters its internal luma edge and its right edge, except at the picture's right edge.
// Invocations 0 to 3 take the internal edge's 4-row segments, 4 to 7 the luma right edge, 8 to 11 the chroma right edges
fn filterVerticalBlockEdgesInPass(passIndex: u32, workgroupId: vec3u, localIndex: u32) {
    loadGeometry();
    if (!loopFilterActive(passIndex)) {
        return;
    }
    let column = workgroupId.x;
    let row = workgroupId.y;
    if (column >= mbWidth || row >= passRows || localIndex >= 12u) {
        return;
    }
    let pq = i32(parameter(RECORD_PASS_PQ));
    let lastColumn = column + 1u >= mbWidth;
    var plane = 0u;
    var segment = localIndex & 3u;
    var edge = 0u;
    var leftBlock = 0u;
    var rightBlock = 0u;
    var rightColumn = column;
    if (localIndex < 4u) {
        edge = column * 16u + 8u;
        leftBlock = (segment >> 1u) * 2u;
        rightBlock = leftBlock + 1u;
    } else if (localIndex < 8u) {
        if (lastColumn) {
            return;
        }
        edge = column * 16u + 16u;
        leftBlock = (segment >> 1u) * 2u + 1u;
        rightBlock = (segment >> 1u) * 2u;
        rightColumn = column + 1u;
    } else {
        if (lastColumn) {
            return;
        }
        plane = 1u + ((localIndex - 8u) >> 1u);
        segment = (localIndex - 8u) & 1u;
        edge = column * 8u + 8u;
        leftBlock = 3u + plane;
        rightBlock = leftBlock;
        rightColumn = column + 1u;
    }
    let firstRow = select(row * 16u, row * 8u, plane != 0u) + segment * 4u;
    if (usesPEdgeDecisions()) {
        let left = edgeBlock(column, row, leftBlock);
        let right = edgeBlock(rightColumn, row, rightBlock);
        if (!filtersWholeEdge(left, right)) {
            // The bottom half is bit 0 of either block's adjacent subblocks, the top half bit 2
            let index = (left.pattern | (right.pattern >> 1u)) & 5u;
            let half = select(1u, 4u, (segment & 1u) == 0u);
            if ((index & half) == 0u) {
                return;
            }
        }
    }
    filterSegment(plane, false, firstRow, edge, 1u, pq);
}

// Vertical subblock edges at column 4 of each block whose transform splits it vertically
fn filterVerticalSubblockEdgesInPass(passIndex: u32, workgroupId: vec3u, localIndex: u32) {
    loadGeometry();
    if (!loopFilterActive(passIndex) || !filtersSubblockEdges()) {
        return;
    }
    let column = workgroupId.x;
    let row = workgroupId.y;
    if (column >= mbWidth || row >= passRows || localIndex >= 12u) {
        return;
    }
    let pq = i32(parameter(RECORD_PASS_PQ));
    var plane = 0u;
    var block = 0u;
    var segment = 0u;
    var edge = 0u;
    var firstRow = 0u;
    if (localIndex < 8u) {
        block = localIndex >> 1u;
        segment = localIndex & 1u;
        edge = column * 16u + (block & 1u) * 8u + 4u;
        firstRow = row * 16u + (block >> 1u) * 8u + segment * 4u;
    } else {
        plane = 1u + ((localIndex - 8u) >> 1u);
        block = 3u + plane;
        segment = (localIndex - 8u) & 1u;
        edge = column * 8u + 4u;
        firstRow = row * 8u + segment * 4u;
    }
    let transformType = blockTransformType(column, row, block);
    if (transformType != RECORD_TT_4X4 && transformType != RECORD_TT_4X8) {
        return;
    }
    let pattern = (macroblockField(column, row, RECORD_MACROBLOCK_CBP) >> (block * 4u)) & 15u;
    // The bottom half filters when a bottom subblock is coded, the top half when a top one is
    let mask = select(3u, 12u, segment == 0u);
    if ((pattern & mask) == 0u) {
        return;
    }
    filterSegment(plane, false, firstRow, edge, 1u, pq);
}

// Interlaced frame pictures: each field's lines filter apart, two picture rows per line, as FFmpeg's ff_vc1_p_intfr_loop_filter
// and the interlaced branch of ff_vc1_i_loop_filter do; their edges sit four rows apart, so each line segment walks its edges in order

fn isSplitTransform(transformType: u32, split: u32) -> bool {
    return transformType == RECORD_TT_4X4 || transformType == split;
}

// The edges across the rows of one 4-column segment and one parity, top to bottom.
// Invocations take luma segments, then each chroma plane's, each segment twice for the two parities
fn filterFrameHorizontalEdges(index: u32) {
    loadGeometry();
    if (!frameLoopFilterActive()) {
        return;
    }
    let lumaSegments = mbWidth * 4u;
    let chromaSegments = mbWidth * 2u;
    let parity = index & 1u;
    var segment = index >> 1u;
    var plane = 0u;
    if (segment >= lumaSegments) {
        segment -= lumaSegments;
        if (segment >= 2u * chromaSegments) {
            return;
        }
        plane = 1u + segment / chromaSegments;
        segment = segment % chromaSegments;
    }
    let pq = i32(parameter(RECORD_PASS_PQ));
    let intraPicture = passPictureType == RECORD_TYPE_I || passPictureType == RECORD_TYPE_BI;
    let segmentsPerMacroblock = select(4u, 2u, plane != 0u);
    let column = segment / segmentsPerMacroblock;
    let x = segment * 4u;
    // The left half of the luma macroblock holds blocks 0 and 2, the right half blocks 1 and 3
    let half = (segment % 4u) >> 1u;
    for (var row = 0u; row < mbHeight; row += 1u) {
        let flags = macroblockField(column, row, RECORD_MACROBLOCK_FLAGS);
        let topEdge = (flags & RECORD_MACROBLOCK_SLICE_TOP_BIT) != 0u;
        let bottomEdge = (flags & RECORD_MACROBLOCK_SLICE_BOTTOM_BIT) != 0u;
        let fieldTransform = (flags & RECORD_MACROBLOCK_FIELDTX_BIT) != 0u;
        if (plane != 0u) {
            let base = row * 8u + parity;
            if (intraPicture) {
                if (!topEdge) {
                    filterSegment(plane, true, x, base, 2u, pq);
                }
                continue;
            }
            if (bottomEdge) {
                continue;
            }
            if (!topEdge && isSplitTransform(blockTransformType(column, row, 3u + plane), RECORD_TT_8X4)) {
                filterSegment(plane, true, x, base + 4u, 2u, pq);
            }
            filterSegment(plane, true, x, base + 8u, 2u, pq);
            continue;
        }
        let base = row * 16u + parity;
        if (intraPicture) {
            if (!topEdge) {
                filterSegment(0u, true, x, base, 2u, pq);
            }
            if (!fieldTransform) {
                filterSegment(0u, true, x, base + 8u, 2u, pq);
            }
            continue;
        }
        if (fieldTransform) {
            // Block half holds the top field's lines, block half + 2 the bottom field's
            let block = half + 2u * parity;
            if (isSplitTransform(blockTransformType(column, row, block), RECORD_TT_8X4)) {
                filterSegment(0u, true, x, base + 8u, 2u, pq);
            }
            if (!bottomEdge) {
                filterSegment(0u, true, x, base + 16u, 2u, pq);
            }
            continue;
        }
        if (!topEdge && isSplitTransform(blockTransformType(column, row, half), RECORD_TT_8X4)) {
            filterSegment(0u, true, x, base + 4u, 2u, pq);
        }
        filterSegment(0u, true, x, base + 8u, 2u, pq);
        if (bottomEdge) {
            continue;
        }
        if (isSplitTransform(blockTransformType(column, row, half + 2u), RECORD_TT_8X4)) {
            filterSegment(0u, true, x, base + 12u, 2u, pq);
        }
        filterSegment(0u, true, x, base + 16u, 2u, pq);
    }
}

// The edges across the columns of one segment of four same-parity rows, left to right.
// Each luma macroblock row has four segments, rows 0, 2, 4, 6 then 1, 3, 5, 7 then 8 and 9 onward; each chroma one has two
fn filterFrameVerticalEdges(index: u32) {
    loadGeometry();
    if (!frameLoopFilterActive()) {
        return;
    }
    let lumaSegments = mbHeight * 4u;
    let chromaSegments = mbHeight * 2u;
    var segment = index;
    var plane = 0u;
    if (segment >= lumaSegments) {
        segment -= lumaSegments;
        if (segment >= 2u * chromaSegments) {
            return;
        }
        plane = 1u + segment / chromaSegments;
        segment = segment % chromaSegments;
    }
    let pq = i32(parameter(RECORD_PASS_PQ));
    let intraPicture = passPictureType == RECORD_TYPE_I || passPictureType == RECORD_TYPE_BI;
    let segmentsPerMacroblock = select(4u, 2u, plane != 0u);
    let row = segment / segmentsPerMacroblock;
    let part = segment % segmentsPerMacroblock;
    let parity = part & 1u;
    let lower = part >> 1u;
    let rowsPerMacroblock = select(16u, 8u, plane != 0u);
    let firstRow = row * rowsPerMacroblock + lower * 8u + parity;
    let width = select(16u, 8u, plane != 0u);
    for (var column = 0u; column < mbWidth; column += 1u) {
        let lastColumn = column + 1u >= mbWidth;
        let left = column * width;
        if (intraPicture) {
            if (plane == 0u) {
                filterSegment(0u, false, firstRow, left + 8u, 2u, pq);
            }
            if (!lastColumn) {
                filterSegment(plane, false, firstRow, left + width, 2u, pq);
            }
            continue;
        }
        if (plane != 0u) {
            if (isSplitTransform(blockTransformType(column, row, 3u + plane), RECORD_TT_4X8)) {
                filterSegment(plane, false, firstRow, left + 4u, 2u, pq);
            }
            if (!lastColumn) {
                filterSegment(plane, false, firstRow, left + 8u, 2u, pq);
            }
            continue;
        }
        // Field transform macroblocks hold each field's lines in one block row, frame macroblocks each half's rows
        let fieldTransform = (macroblockField(column, row, RECORD_MACROBLOCK_FLAGS) & RECORD_MACROBLOCK_FIELDTX_BIT) != 0u;
        let blockRow = select(lower, parity, fieldTransform);
        let leftBlock = blockRow * 2u;
        if (isSplitTransform(blockTransformType(column, row, leftBlock), RECORD_TT_4X8)) {
            filterSegment(0u, false, firstRow, left + 4u, 2u, pq);
        }
        filterSegment(0u, false, firstRow, left + 8u, 2u, pq);
        if (isSplitTransform(blockTransformType(column, row, leftBlock + 1u), RECORD_TT_4X8)) {
            filterSegment(0u, false, firstRow, left + 12u, 2u, pq);
        }
        if (!lastColumn) {
            filterSegment(0u, false, firstRow, left + 16u, 2u, pq);
        }
    }
}

@compute @workgroup_size(64)
fn filterFrameHorizontalLines(@builtin(global_invocation_id) invocation: vec3u) {
    filterFrameHorizontalEdges(invocation.x);
}

@compute @workgroup_size(64)
fn filterFrameVerticalLines(@builtin(global_invocation_id) invocation: vec3u) {
    filterFrameVerticalEdges(invocation.x);
}

@compute @workgroup_size(16)
fn filterHorizontalBlockEdges(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    filterHorizontalBlockEdgesInPass(pictureState[F_CURRENT_PASS], workgroupId, localIndex);
}

@compute @workgroup_size(16)
fn filterHorizontalSubblockEdges(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    filterHorizontalSubblockEdgesInPass(pictureState[F_CURRENT_PASS], workgroupId, localIndex);
}

@compute @workgroup_size(16)
fn filterVerticalBlockEdges(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    filterVerticalBlockEdgesInPass(pictureState[F_CURRENT_PASS], workgroupId, localIndex);
}

@compute @workgroup_size(16)
fn filterVerticalSubblockEdges(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    filterVerticalSubblockEdgesInPass(pictureState[F_CURRENT_PASS], workgroupId, localIndex);
}
