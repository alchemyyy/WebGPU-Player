//! id: mpeg4
//! name: MPEG-4 Part 2, H.263, and MS-MPEG4
//! decoder: video
//! accepts: codec in [mpeg4, h263, h263p, msmpeg4v3, msmpeg4v2, msmpeg4v1], picture.width <= 4096, picture.height <= 4096, picture.width * picture.height <= 9437184, stream.bitDepth == 8
//! output: I420
//! parser: 2
//! references: 2
//! reorder: 1
//! packet: 40 MiB
//! state: 16
//! error: 1, configuration
//! error: 2, unsupportedFeature
//! error: 3, pictureSize
//! error: 4, sequenceHeader, resync
//! error: 5, pictureHeader, resync
//! error: 6, macroblockLayer, resync
//! error: 7, bitsExhausted, resync
//! error: 8, recordInvalid
//! dispatch: beginPicture, 1
//! dispatch: reconstruct, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: filterHorizontalEdges, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: filterVerticalEdges, ceil(stream.width / 16), ceil(stream.height / 16)
//! dispatch: finishPicture, 1

// The MPEG-4 Part 2, H.263, and MS-MPEG4 decoder: FFmpeg's mpeg4, h263, and msmpeg4 decoders, which share FFmpeg's mpegvideo
// reconstruction, in compute shaders.
// Its packets are the GPU records its CPU parser (parser/) makes of each picture. The parser reads the headers and the macroblock
// layer, predicts motion vectors and the DC and AC coefficients, dequantizes, and turns each macroblock's motion into operations whose
// source positions FFmpeg's mpegvideo_motion.c computes. These passes run the operations and FFmpeg's IDCT for each macroblock, then
// H.263's deblocking filter (Annex J), so the frames match FFmpeg's bit-exact decode.

// The GPU record the parser writes for each picture: its magic and version, the header's word offsets, then a word offset per
// macroblock into the macroblock records, in raster order.
// parser/build.rs reads these RECORD_ declarations and the ERROR_ codes below, so the parser and the passes share one layout
const RECORD_MAGIC: u32 = 1380988237u;
const RECORD_VERSION: u32 = 1u;
// A picture of the accepts conditions' 9437184 samples covers at most 37377 macroblocks, whose records of at most 258 words and table
// entries fit the packet's 40 MiB
const RECORD_MAXIMUM_MACROBLOCKS: u32 = 37377u;

// Words of the record header
const RECORD_HEADER_MAGIC: u32 = 0u;
const RECORD_HEADER_VERSION: u32 = 1u;
const RECORD_HEADER_PICTURE_TYPE: u32 = 2u;
const RECORD_HEADER_MB_WIDTH: u32 = 3u;
const RECORD_HEADER_MB_HEIGHT: u32 = 4u;
// FFmpeg's h_edge_pos and v_edge_pos: luma reference positions clamp to them, chroma positions to half of them
const RECORD_HEADER_EDGE_WIDTH: u32 = 5u;
const RECORD_HEADER_EDGE_HEIGHT: u32 = 6u;
const RECORD_HEADER_IDCT: u32 = 7u;
const RECORD_HEADER_LOOP_FILTER: u32 = 8u;
const RECORD_HEADER_NO_ROUNDING: u32 = 9u;
// The sprite warping accuracy and FFmpeg's sprite_delta of a picture with GMC of two or three points, as signed words
const RECORD_HEADER_GMC_ACCURACY: u32 = 10u;
const RECORD_HEADER_GMC_DXX: u32 = 11u;
const RECORD_HEADER_GMC_DXY: u32 = 12u;
const RECORD_HEADER_GMC_DYX: u32 = 13u;
const RECORD_HEADER_GMC_DYY: u32 = 14u;
// The word offset of the macroblock offset table
const RECORD_HEADER_MACROBLOCKS: u32 = 15u;
const RECORD_HEADER_FLAGS: u32 = 16u;
// The luma of a missing reference, as FFmpeg colors its dummy frames: 16 for H.263, 128 otherwise; chroma is 128
const RECORD_HEADER_MISSING_REFERENCE_LUMA: u32 = 17u;
const RECORD_HEADER_WORDS: u32 = 32u;
// The parser dropped every reference since the last record, as FFmpeg's decoder does when a size change reinitializes it
const RECORD_FLAG_RESET_ANCHORS: u32 = 1u;

// Picture types; an S picture (MPEG-4 GMC) is an anchor as a P picture is
const RECORD_TYPE_I: u32 = 0u;
const RECORD_TYPE_P: u32 = 1u;
const RECORD_TYPE_B: u32 = 2u;
const RECORD_TYPE_S: u32 = 3u;

// IDCTs: FFmpeg's simple IDCT, which every stream but Xvid's takes, and the Xvid IDCT FFmpeg switches to for an Xvid stream
const RECORD_IDCT_SIMPLE: u32 = 0u;
const RECORD_IDCT_XVID: u32 = 1u;

// Words of a macroblock's record: its flags, its deblocking quantizers, then its operations in order, then its dense blocks in block order,
// then its coefficient entries
const RECORD_MACROBLOCK_FLAGS: u32 = 0u;
const RECORD_MACROBLOCK_LOOP_FILTER: u32 = 1u;
const RECORD_MACROBLOCK_FIXED_WORDS: u32 = 2u;
// The most words a macroblock's record takes: its fixed words, at most 64 operation words, and six dense blocks, since a block of 32 or
// more coefficients is dense and one of fewer takes fewer words as entries
const RECORD_MACROBLOCK_MAXIMUM_WORDS: u32 = 258u;

// Fields of a macroblock's flags word: whether it is intra, whether its luma blocks hold fields (interlaced DCT), the blocks with a
// residual (an intra macroblock puts all six), the operation count, the dense blocks among those with a residual, and the coefficient
// entry count of the others
const RECORD_MB_INTRA: u32 = 1u;
const RECORD_MB_INTERLACED_DCT: u32 = 2u;
const RECORD_MB_RESIDUAL_SHIFT: u32 = 2u;
const RECORD_MB_RESIDUAL_MASK: u32 = 63u;
const RECORD_MB_OPERATION_COUNT_SHIFT: u32 = 8u;
const RECORD_MB_OPERATION_COUNT_MASK: u32 = 63u;
const RECORD_MB_DENSE_SHIFT: u32 = 14u;
const RECORD_MB_DENSE_MASK: u32 = 63u;
const RECORD_MB_ENTRY_COUNT_SHIFT: u32 = 20u;
const RECORD_MB_ENTRY_COUNT_MASK: u32 = 511u;

// A dense block: its 64 IDCT inputs at raster positions, two int16 to a word, the even position in the low half
const RECORD_DENSE_BLOCK_WORDS: u32 = 32u;
// A block of this many nonzero coefficients or more is dense
const RECORD_DENSE_BLOCK_ENTRIES: u32 = 32u;

// Fields of a macroblock's deblocking word, as ff_h263_loop_filter derives them, each 0 for an edge it leaves: the quantizer of the
// inner horizontal edge and the vertical edge at 8, the top edge's luma and chroma quantizers, and the left edge's
const RECORD_LOOP_FILTER_INNER_SHIFT: u32 = 0u;
const RECORD_LOOP_FILTER_TOP_SHIFT: u32 = 5u;
const RECORD_LOOP_FILTER_TOP_CHROMA_SHIFT: u32 = 10u;
const RECORD_LOOP_FILTER_LEFT_SHIFT: u32 = 15u;
const RECORD_LOOP_FILTER_LEFT_CHROMA_SHIFT: u32 = 20u;
const RECORD_LOOP_FILTER_QP_MASK: u32 = 31u;

// An operation predicts one block of the macroblock into its prediction, in order, as FFmpeg's pixel operations do. Its first word
// holds its kind and flags; the words after it depend on its kind:
// - HPEL: put_pixels_tab or put_no_rnd_pixels_tab, or avg_pixels_tab, of a block; a position word
// - QPEL: the qpel_mc_func of a 16x16 or 8x8 block; a position word
// - GMC1: FFmpeg's gmc1 of a 16x16 luma or 8x8 chroma block; a position word, then the fractions x16 | y16 << 8
// - GMC: FFmpeg's ff_gmc_c of a 16x16 luma or 8x8 chroma block; the signed ox and oy of its first sample
// - OBMC: FFmpeg's obmc_motion of an 8x8 luma block; a word of the five predictions' dxy, two bits each, mid, top, left, right, bottom,
//   then their five position words
// A position word holds the block's integer source position at its top left, x in the low 16 bits and y in the high 16 bits, both
// signed; a field operation's y counts the reference field's lines. Every reference sample clamps to the edge positions, as FFmpeg's
// emulated edges extend them: x to [0, edge width - 1] and a frame line to [0, edge height - 1], halved for chroma, where GMC halves
// rounding up as gmc_motion does
const RECORD_OP_KIND_MASK: u32 = 15u;
const RECORD_OP_HPEL: u32 = 0u;
const RECORD_OP_QPEL: u32 = 1u;
const RECORD_OP_GMC1: u32 = 2u;
const RECORD_OP_GMC: u32 = 3u;
const RECORD_OP_OBMC: u32 = 4u;
// The operation predicts both chroma planes at the same position, else luma
const RECORD_OP_CHROMA: u32 = 16u;
// It reads the backward reference, the next anchor, else the forward reference, the previous anchor
const RECORD_OP_BACKWARD: u32 = 32u;
// It averages into the prediction, as FFmpeg's avg_ operations do, else puts
const RECORD_OP_AVERAGE: u32 = 64u;
// A put rounds down, as put_no_rnd_ operations and GMC with rounding control do
const RECORD_OP_NO_ROUNDING: u32 = 128u;
// The fraction index: dxy of hpel, two bits, or of qpel, four bits
const RECORD_OP_DXY_SHIFT: u32 = 8u;
const RECORD_OP_DXY_MASK: u32 = 15u;
// The block is 16 samples wide, else 8
const RECORD_OP_WIDE: u32 = 4096u;
// The block's height in lines, 1 to 16
const RECORD_OP_HEIGHT_SHIFT: u32 = 13u;
const RECORD_OP_HEIGHT_MASK: u32 = 31u;
// The block covers one field: its lines step by two in the prediction and in the reference
const RECORD_OP_FIELD: u32 = 262144u;
// A field block's lines are the prediction's bottom field, and the reference lines it reads are the reference's bottom field
const RECORD_OP_DEST_BOTTOM: u32 = 524288u;
const RECORD_OP_SOURCE_BOTTOM: u32 = 1048576u;
// The block starts 8 luma samples right of, or 8 lines below, the macroblock's top left
const RECORD_OP_DEST_X8: u32 = 2097152u;
const RECORD_OP_DEST_Y8: u32 = 4194304u;
// The words after each kind's operation word
const RECORD_OP_HPEL_WORDS: u32 = 1u;
const RECORD_OP_QPEL_WORDS: u32 = 1u;
const RECORD_OP_GMC1_WORDS: u32 = 2u;
const RECORD_OP_GMC_WORDS: u32 = 2u;
const RECORD_OP_OBMC_WORDS: u32 = 6u;

// A coefficient entry: its value, the IDCT's int16 input, in the low 16 bits, its raster position in the block above them, and its
// block, 0 to 3 luma and 4 and 5 chroma, above that
const RECORD_ENTRY_VALUE_MASK: u32 = 65535u;
const RECORD_ENTRY_POSITION_SHIFT: u32 = 16u;
const RECORD_ENTRY_POSITION_MASK: u32 = 63u;
const RECORD_ENTRY_BLOCK_SHIFT: u32 = 22u;
const RECORD_ENTRY_BLOCK_MASK: u32 = 7u;

// Error codes, the high byte of a status error word, which the //! error lines name; the low 24 bits carry the failing value.
// The configuration, an unsupported feature, and a size beyond the pool or the package's limit hold for the pictures after them too, so
// they end the attempt; a damaged sequence header, picture header, or macroblock layer resyncs at the next key packet
const ERROR_CODE_SHIFT: u32 = 24u;
const ERROR_CONFIGURATION: u32 = 1u;
const ERROR_UNSUPPORTED_FEATURE: u32 = 2u;
const ERROR_PICTURE_SIZE: u32 = 3u;
const ERROR_SEQUENCE_HEADER: u32 = 4u;
const ERROR_PICTURE_HEADER: u32 = 5u;
const ERROR_MACROBLOCK_LAYER: u32 = 6u;
const ERROR_BITS_EXHAUSTED: u32 = 7u;
const ERROR_RECORD_INVALID: u32 = 8u;

// The record check failure values of the passes: the header, the macroblock table beyond the record, and a macroblock beyond it
const INVALID_RECORD_HEADER: u32 = 1u;
const INVALID_RECORD_TABLES: u32 = 2u;
const INVALID_RECORD_MACROBLOCK: u32 = 3u;

// The state buffer: the anchors' pool slots, the previous anchor (the forward reference) and the next one (the backward reference of
// a B picture), then the picture's type and the anchor it pushes out, which finishPicture releases
const S_LAST_SLOT: u32 = 0u;
const S_NEXT_SLOT: u32 = 1u;
const S_PICTURE_TYPE: u32 = 2u;
const S_RELEASED_ANCHOR: u32 = 3u;
const NO_SLOT: u32 = 255u;
// The picture type of a packet whose record failed its check, which holds no reference
const NO_PICTURE_TYPE: u32 = 255u;

const MACROBLOCK_SIZE: u32 = 16u;
const CHROMA_SIZE: u32 = 8u;
const RECONSTRUCT_WORKGROUP_SIZE: u32 = 64u;
// The prediction holds the macroblock's 256 luma samples, then its 64 Cb and 64 Cr samples, in raster order
const PREDICTION_SAMPLES: u32 = 384u;
const PREDICTION_CB: u32 = 256u;
const PREDICTION_CR: u32 = 320u;
const BLOCK_COUNT: u32 = 6u;
// The chroma value of a missing reference, as FFmpeg's dummy frames hold
const MISSING_REFERENCE_CHROMA: i32 = 128;
// The widest warping accuracy MPEG-4 codes, sprite_warping_accuracy of 0 to 3
const MAXIMUM_GMC_ACCURACY: u32 = 3u;
// The rows of a qpel window: a 16x16 block's 17 lines of 17 samples
const QPEL_WINDOW_STRIDE: u32 = 17u;
const QPEL_HALF_STRIDE: u32 = 16u;

// Reports a failure: the code in the high byte and the failing value below it; the highest report wins
fn reportFailure(code: u32, value: u32) {
    reportDecodeError((code << ERROR_CODE_SHIFT) | min(value, (1u << ERROR_CODE_SHIFT) - 1u));
}

// The record header starts the packet
fn headerValue(field: u32) -> u32 {
    return readPacketWord(field);
}

fn headerSigned(field: u32) -> i32 {
    return bitcast<i32>(readPacketWord(field));
}

fn recordWords() -> u32 {
    return packet.byteLength / 4u;
}

fn isAnchorType(pictureType: u32) -> bool {
    return pictureType == RECORD_TYPE_I || pictureType == RECORD_TYPE_P || pictureType == RECORD_TYPE_S;
}

// The record check every pass makes from the packet alone, so its passes agree without reading the state: 0 for a record they can
// run, else the INVALID_RECORD_ value beginPicture reports
fn recordFailure() -> u32 {
    let words = recordWords();
    if (words < RECORD_HEADER_WORDS || headerValue(RECORD_HEADER_MAGIC) != RECORD_MAGIC || headerValue(RECORD_HEADER_VERSION) != RECORD_VERSION) {
        return INVALID_RECORD_HEADER;
    }
    if (headerValue(RECORD_HEADER_PICTURE_TYPE) > RECORD_TYPE_S || headerValue(RECORD_HEADER_IDCT) > RECORD_IDCT_XVID
        || headerValue(RECORD_HEADER_LOOP_FILTER) > 1u || headerValue(RECORD_HEADER_NO_ROUNDING) > 1u
        || headerValue(RECORD_HEADER_GMC_ACCURACY) > MAXIMUM_GMC_ACCURACY) {
        return INVALID_RECORD_HEADER;
    }
    let width = headerValue(RECORD_HEADER_MB_WIDTH);
    let height = headerValue(RECORD_HEADER_MB_HEIGHT);
    if (width == 0u || height == 0u || width > stream.width / MACROBLOCK_SIZE || height > stream.height / MACROBLOCK_SIZE
        || width * height > RECORD_MAXIMUM_MACROBLOCKS) {
        return INVALID_RECORD_HEADER;
    }
    // The edges bound every reference read, so they stay within the pool's planes
    let edgeWidth = headerValue(RECORD_HEADER_EDGE_WIDTH);
    let edgeHeight = headerValue(RECORD_HEADER_EDGE_HEIGHT);
    if (edgeWidth == 0u || edgeHeight == 0u || edgeWidth > stream.width || edgeHeight > stream.height) {
        return INVALID_RECORD_HEADER;
    }
    let table = headerValue(RECORD_HEADER_MACROBLOCKS);
    if (table < RECORD_HEADER_WORDS || table > words || words - table < width * height) {
        return INVALID_RECORD_TABLES;
    }
    return 0u;
}

// The word offset of a macroblock's record, from the table
fn macroblockRecord(column: u32, row: u32) -> u32 {
    return readPacketWord(headerValue(RECORD_HEADER_MACROBLOCKS) + row * headerValue(RECORD_HEADER_MB_WIDTH) + column);
}

// The words after an operation's word, by its kind
fn operationArgumentWords(kind: u32) -> u32 {
    switch (kind) {
        case RECORD_OP_HPEL: {
            return RECORD_OP_HPEL_WORDS;
        }
        case RECORD_OP_QPEL: {
            return RECORD_OP_QPEL_WORDS;
        }
        case RECORD_OP_GMC1: {
            return RECORD_OP_GMC1_WORDS;
        }
        case RECORD_OP_GMC: {
            return RECORD_OP_GMC_WORDS;
        }
        default: {
            return RECORD_OP_OBMC_WORDS;
        }
    }
}

// Whether a macroblock's record, its fixed words, its operations, its dense blocks, and its coefficient entries, lies within the record,
// every operation of a known kind
fn macroblockRecordHolds(offset: u32) -> bool {
    let words = recordWords();
    if (offset < RECORD_HEADER_WORDS || offset > words || words - offset < RECORD_MACROBLOCK_FIXED_WORDS) {
        return false;
    }
    let flags = readPacketWord(offset + RECORD_MACROBLOCK_FLAGS);
    let operationCount = (flags >> RECORD_MB_OPERATION_COUNT_SHIFT) & RECORD_MB_OPERATION_COUNT_MASK;
    var cursor = offset + RECORD_MACROBLOCK_FIXED_WORDS;
    for (var operation = 0u; operation < operationCount; operation += 1u) {
        if (cursor >= words) {
            return false;
        }
        let kind = readPacketWord(cursor) & RECORD_OP_KIND_MASK;
        if (kind > RECORD_OP_OBMC || words - cursor - 1u < operationArgumentWords(kind)) {
            return false;
        }
        cursor += 1u + operationArgumentWords(kind);
    }
    let entryCount = (flags >> RECORD_MB_ENTRY_COUNT_SHIFT) & RECORD_MB_ENTRY_COUNT_MASK;
    let denseWords = countOneBits((flags >> RECORD_MB_DENSE_SHIFT) & RECORD_MB_DENSE_MASK) * RECORD_DENSE_BLOCK_WORDS;
    return words - cursor >= denseWords && words - cursor - denseWords >= entryCount;
}

// The block of a macroblock's dense block k: its dense blocks lie in block order
fn denseBlock(denseMask: u32, k: u32) -> u32 {
    var remaining = k;
    for (var block = 0u; block < BLOCK_COUNT; block += 1u) {
        if (((denseMask >> block) & 1u) != 0u) {
            if (remaining == 0u) {
                return block;
            }
            remaining -= 1u;
        }
    }
    return BLOCK_COUNT - 1u;
}

// Hands an anchor's slot back to the engine and empties the anchor
fn releaseAnchor(field: u32) {
    let slot = state[field];
    if (slot != NO_SLOT) {
        releaseReferenceSlot(slot);
    }
    state[field] = NO_SLOT;
}

// Sets up a picture from its record: the record check and the anchors. An anchor's forward reference is the previous next anchor,
// and it becomes the next anchor itself; a B picture reads the last anchor forward and the next one backward
@compute @workgroup_size(1)
fn beginPicture() {
    state[S_PICTURE_TYPE] = NO_PICTURE_TYPE;
    state[S_RELEASED_ANCHOR] = NO_SLOT;
    // A reset cleared the state, whose zero slots would read as held: the anchors start empty
    if (packet.reset != 0u) {
        state[S_LAST_SLOT] = NO_SLOT;
        state[S_NEXT_SLOT] = NO_SLOT;
    }
    let failure = recordFailure();
    if (failure != 0u) {
        reportFailure(ERROR_RECORD_INVALID, failure);
        return;
    }
    // The parser dropped its references, as FFmpeg's reinitialized decoder does
    if ((headerValue(RECORD_HEADER_FLAGS) & RECORD_FLAG_RESET_ANCHORS) != 0u) {
        releaseAnchor(S_LAST_SLOT);
        releaseAnchor(S_NEXT_SLOT);
    }
    let pictureType = headerValue(RECORD_HEADER_PICTURE_TYPE);
    state[S_PICTURE_TYPE] = pictureType;
    if (isAnchorType(pictureType)) {
        // The anchor that drops out is released once the picture finishes
        state[S_RELEASED_ANCHOR] = state[S_LAST_SLOT];
        state[S_LAST_SLOT] = state[S_NEXT_SLOT];
        state[S_NEXT_SLOT] = packet.outputSlot;
    }
}

// Ends a picture: releases the anchor that dropped out, and the picture's own slot unless it became an anchor
@compute @workgroup_size(1)
fn finishPicture() {
    let releasedAnchor = state[S_RELEASED_ANCHOR];
    if (releasedAnchor != NO_SLOT) {
        releaseReferenceSlot(releasedAnchor);
    }
    if (!isAnchorType(state[S_PICTURE_TYPE])) {
        releaseReferenceSlot(packet.outputSlot);
    }
}

// Reconstruction: one workgroup per macroblock runs its operations into the prediction, FFmpeg's IDCT on its blocks, and writes its
// samples, as FFmpeg's mpv_reconstruct_mb does after ff_mpv_motion
var<workgroup> prediction: array<u32, PREDICTION_SAMPLES>;
var<workgroup> coefficients: array<i32, PREDICTION_SAMPLES>;
// A qpel operation's reference window, (size + 1) lines of size + 1 samples, and its horizontally filtered lines
var<workgroup> qpelWindow: array<i32, 289>;
var<workgroup> qpelHalf: array<i32, 272>;

// The operation the invocations run: its reference slot and plane, how it reads the reference's lines, the clamping edges, the value of
// a missing reference, and where its block lies in the prediction
var<private> referenceSlot: u32;
var<private> referencePlane: u32;
var<private> referenceField: bool;
var<private> referenceBottom: i32;
var<private> referenceEdge: vec2i;
var<private> missingReference: i32;
var<private> destinationOrigin: vec2u;
var<private> destinationBottom: u32;
var<private> destinationSize: u32;

fn unpackPosition(word: u32) -> vec2i {
    return vec2i(i32(word << 16u) >> 16u, i32(word) >> 16u);
}

fn wrapInt16(value: i32) -> i32 {
    return (value << 16u) >> 16u;
}

fn clipToByte(value: i32) -> i32 {
    return clamp(value, 0, 255);
}

// FFmpeg's rnd_avg32 and no_rnd_avg32 per sample: rounding is 1 for the rounding average
fn average2(a: i32, b: i32, rounding: i32) -> i32 {
    return (a + b + rounding) >> 1u;
}

// One reference sample of the operation: a field operation's line l of field f is frame line 2l + f, and every position clamps to
// the edges as FFmpeg's emulated_edge_mc extends them
fn referenceSample(x: i32, line: i32) -> i32 {
    if (referenceSlot == NO_SLOT) {
        return missingReference;
    }
    var frameLine = line;
    if (referenceField) {
        frameLine = 2 * line + referenceBottom;
    }
    let clampedX = clamp(x, 0, referenceEdge.x);
    let clampedY = clamp(frameLine, 0, referenceEdge.y);
    return i32(readReferenceSample(referenceSlot, referencePlane, u32(clampedX), u32(clampedY)));
}

fn predictionIndex(plane: u32, x: u32, y: u32) -> u32 {
    if (plane == 0u) {
        return y * MACROBLOCK_SIZE + x;
    }
    return PREDICTION_CB + (plane - 1u) * (CHROMA_SIZE * CHROMA_SIZE) + y * CHROMA_SIZE + x;
}

// Puts or averages sample (i, j) of the operation's block into the prediction; a field block's lines step by two
fn storePrediction(i: u32, j: u32, value: i32, averaging: bool) {
    let x = destinationOrigin.x + i;
    var y = destinationOrigin.y + j;
    if (referenceField) {
        y = destinationOrigin.y + 2u * j + destinationBottom;
    }
    if (x >= destinationSize || y >= destinationSize) {
        return;
    }
    let index = predictionIndex(referencePlane, x, y);
    if (averaging) {
        prediction[index] = u32(average2(i32(prediction[index]), value, 1));
    } else {
        prediction[index] = u32(value);
    }
}

// Sets up an operation on one plane: its reference, its edges, and its block's place in the prediction
fn beginOperation(word: u32, plane: u32) {
    let kind = word & RECORD_OP_KIND_MASK;
    if ((word & RECORD_OP_BACKWARD) != 0u) {
        referenceSlot = select(NO_SLOT, state[S_NEXT_SLOT], headerValue(RECORD_HEADER_PICTURE_TYPE) == RECORD_TYPE_B);
    } else {
        referenceSlot = state[S_LAST_SLOT];
    }
    referencePlane = plane;
    referenceField = (word & RECORD_OP_FIELD) != 0u;
    referenceBottom = select(0, 1, (word & RECORD_OP_SOURCE_BOTTOM) != 0u);
    let edgeWidth = i32(headerValue(RECORD_HEADER_EDGE_WIDTH));
    let edgeHeight = i32(headerValue(RECORD_HEADER_EDGE_HEIGHT));
    if (plane == 0u) {
        referenceEdge = vec2i(edgeWidth - 1, edgeHeight - 1);
        missingReference = i32(headerValue(RECORD_HEADER_MISSING_REFERENCE_LUMA));
    } else {
        // gmc_motion passes the chroma edges rounded up; every other operation's chroma clamps to half the edges
        if (kind == RECORD_OP_GMC) {
            referenceEdge = vec2i(((edgeWidth + 1) >> 1u) - 1, ((edgeHeight + 1) >> 1u) - 1);
        } else {
            referenceEdge = max(vec2i((edgeWidth >> 1u) - 1, (edgeHeight >> 1u) - 1), vec2i(0, 0));
        }
        missingReference = MISSING_REFERENCE_CHROMA;
    }
    // The 8-sample offsets are luma samples, half as many chroma samples
    let offset = select(8u, 4u, plane != 0u);
    destinationOrigin = vec2u(select(0u, offset, (word & RECORD_OP_DEST_X8) != 0u), select(0u, offset, (word & RECORD_OP_DEST_Y8) != 0u));
    destinationBottom = select(0u, 1u, (word & RECORD_OP_DEST_BOTTOM) != 0u);
    destinationSize = select(MACROBLOCK_SIZE, CHROMA_SIZE, plane != 0u);
}

// FFmpeg's hpel pixel operations at one sample, put_pixels_tab and put_no_rnd_pixels_tab: dxy bit 0 averages the sample right, bit 1
// the sample below; the packed averages of hpeldsp.c's x2, y2, and xy2 functions round per sample as these do
fn hpelSample(x: i32, y: i32, dxy: u32, rounding: i32) -> i32 {
    let a = referenceSample(x, y);
    switch (dxy) {
        case 1u: {
            return average2(a, referenceSample(x + 1, y), rounding);
        }
        case 2u: {
            return average2(a, referenceSample(x, y + 1), rounding);
        }
        case 3u: {
            return (a + referenceSample(x + 1, y) + referenceSample(x, y + 1) + referenceSample(x + 1, y + 1) + 1 + rounding) >> 2u;
        }
        default: {
            return a;
        }
    }
}

// mpeg4videodsp.c's gmc1_c at one sample: bilinear in sixteenths with the picture's rounder
fn gmc1Sample(x: i32, y: i32, fractions: u32) -> i32 {
    let x16 = i32(fractions & 0xFFu);
    let y16 = i32((fractions >> 8u) & 0xFFu);
    let a = (16 - x16) * (16 - y16);
    let b = x16 * (16 - y16);
    let c = (16 - x16) * y16;
    let d = x16 * y16;
    let rounder = 128 - i32(headerValue(RECORD_HEADER_NO_ROUNDING));
    return (a * referenceSample(x, y) + b * referenceSample(x + 1, y) + c * referenceSample(x, y + 1) + d * referenceSample(x + 1, y + 1)
        + rounder) >> 8u;
}

// mpeg4videodsp.c's ff_gmc_c at sample (i, j) of a block whose first sample warps from (ox, oy): its four branches, by whether the
// warped position's integer part lies within the plane less its last column and line
fn gmcSample(origin: vec2i, i: i32, j: i32) -> i32 {
    let accuracy = headerValue(RECORD_HEADER_GMC_ACCURACY);
    let shift = accuracy + 1u;
    let s = 1 << shift;
    let r = (1 << (2u * accuracy + 1u)) - i32(headerValue(RECORD_HEADER_NO_ROUNDING));
    let vx = origin.x + i * headerSigned(RECORD_HEADER_GMC_DXX) + j * headerSigned(RECORD_HEADER_GMC_DXY);
    let vy = origin.y + i * headerSigned(RECORD_HEADER_GMC_DYX) + j * headerSigned(RECORD_HEADER_GMC_DYY);
    var sourceX = vx >> 16u;
    var sourceY = vy >> 16u;
    let fractionX = sourceX & (s - 1);
    let fractionY = sourceY & (s - 1);
    sourceX >>= shift;
    sourceY >>= shift;
    // ff_gmc_c's width-- and height--: the edges' last column and line
    let width = referenceEdge.x;
    let height = referenceEdge.y;
    if (u32(sourceX) < u32(width)) {
        if (u32(sourceY) < u32(height)) {
            return ((referenceSample(sourceX, sourceY) * (s - fractionX) + referenceSample(sourceX + 1, sourceY) * fractionX) * (s - fractionY)
                + (referenceSample(sourceX, sourceY + 1) * (s - fractionX) + referenceSample(sourceX + 1, sourceY + 1) * fractionX) * fractionY
                + r) >> (shift * 2u);
        }
        let line = clamp(sourceY, 0, height);
        return ((referenceSample(sourceX, line) * (s - fractionX) + referenceSample(sourceX + 1, line) * fractionX) * s + r) >> (shift * 2u);
    }
    let column = clamp(sourceX, 0, width);
    if (u32(sourceY) < u32(height)) {
        return ((referenceSample(column, sourceY) * (s - fractionY) + referenceSample(column, sourceY + 1) * fractionY) * s + r) >> (shift * 2u);
    }
    return referenceSample(column, clamp(sourceY, 0, height));
}

// put_obmc's weights of the top, left, mid, right, and bottom predictions at each sample of an 8x8 block, four bits each from the low
// bits; each sample's weights sum to 8
const OBMC_WEIGHTS = array<u32, 64>(
    0x00422u, 0x00512u, 0x00512u, 0x00512u, 0x01502u, 0x01502u, 0x01502u, 0x02402u,
    0x00521u, 0x00521u, 0x00512u, 0x00512u, 0x01502u, 0x01502u, 0x02501u, 0x02501u,
    0x00521u, 0x00521u, 0x00611u, 0x00611u, 0x01601u, 0x01601u, 0x02501u, 0x02501u,
    0x00521u, 0x00521u, 0x00611u, 0x00611u, 0x01601u, 0x01601u, 0x02501u, 0x02501u,
    0x10520u, 0x10520u, 0x10610u, 0x10610u, 0x11600u, 0x11600u, 0x12500u, 0x12500u,
    0x10520u, 0x10520u, 0x10610u, 0x10610u, 0x11600u, 0x11600u, 0x12500u, 0x12500u,
    0x10520u, 0x10520u, 0x20510u, 0x20510u, 0x21500u, 0x21500u, 0x12500u, 0x12500u,
    0x20420u, 0x20510u, 0x20510u, 0x20510u, 0x21500u, 0x21500u, 0x21500u, 0x22400u
);
// The order of the weights, top, left, mid, right, bottom, by the record's order of the predictions, mid, top, left, right, bottom
const OBMC_WEIGHT_SHIFTS = array<u32, 5>(8u, 0u, 4u, 12u, 16u);

// mpegvideo_motion.c's obmc_motion at sample (i, j) of its 8x8 block: five hpel_motion predictions, each with its own position and
// dxy, which put_obmc blends
fn obmcSample(arguments: u32, i: u32, j: u32, rounding: i32) -> i32 {
    let dxys = readPacketWord(arguments);
    let weights = OBMC_WEIGHTS[j * 8u + i];
    var sum = 4;
    for (var predictionIndex = 0u; predictionIndex < 5u; predictionIndex += 1u) {
        let position = unpackPosition(readPacketWord(arguments + 1u + predictionIndex));
        let dxy = (dxys >> (predictionIndex * 2u)) & 3u;
        let weight = i32((weights >> OBMC_WEIGHT_SHIFTS[predictionIndex]) & 15u);
        sum += weight * hpelSample(position.x + i32(i), position.y + i32(j), dxy, rounding);
    }
    return sum >> 3u;
}

// FFmpeg's mpeg4_qpel lowpass filter at output k of a window of size + 1 samples, which mirrors taps past either end of the window as
// qpeldsp.c's h_lowpass and v_lowpass functions spell out
fn mirrorTap(k: i32, size: i32) -> u32 {
    if (k < 0) {
        return u32(-1 - k);
    }
    if (k > size) {
        return u32(2 * size + 1 - k);
    }
    return u32(k);
}

fn qpelWindowSample(i: u32, j: u32) -> i32 {
    return qpelWindow[j * QPEL_WINDOW_STRIDE + i];
}

fn qpelHalfSample(i: u32, j: u32) -> i32 {
    return qpelHalf[j * QPEL_HALF_STRIDE + i];
}

fn qpelTaps(t0: i32, t1: i32, tm1: i32, t2: i32, tm2: i32, t3: i32, tm3: i32, t4: i32) -> i32 {
    return (t0 + t1) * 20 - (tm1 + t2) * 6 + (tm2 + t3) * 3 - (tm3 + t4);
}

// The horizontal lowpass of window line j at output i
fn qpelWindowHorizontal(i: u32, j: u32, size: i32) -> i32 {
    let k = i32(i);
    return qpelTaps(qpelWindowSample(mirrorTap(k, size), j), qpelWindowSample(mirrorTap(k + 1, size), j),
        qpelWindowSample(mirrorTap(k - 1, size), j), qpelWindowSample(mirrorTap(k + 2, size), j),
        qpelWindowSample(mirrorTap(k - 2, size), j), qpelWindowSample(mirrorTap(k + 3, size), j),
        qpelWindowSample(mirrorTap(k - 3, size), j), qpelWindowSample(mirrorTap(k + 4, size), j));
}

// The vertical lowpass of window column i at output j
fn qpelWindowVertical(i: u32, j: u32, size: i32) -> i32 {
    let k = i32(j);
    return qpelTaps(qpelWindowSample(i, mirrorTap(k, size)), qpelWindowSample(i, mirrorTap(k + 1, size)),
        qpelWindowSample(i, mirrorTap(k - 1, size)), qpelWindowSample(i, mirrorTap(k + 2, size)),
        qpelWindowSample(i, mirrorTap(k - 2, size)), qpelWindowSample(i, mirrorTap(k + 3, size)),
        qpelWindowSample(i, mirrorTap(k - 3, size)), qpelWindowSample(i, mirrorTap(k + 4, size)));
}

// The vertical lowpass of the horizontally filtered lines, column i at output j
fn qpelHalfVertical(i: u32, j: u32, size: i32) -> i32 {
    let k = i32(j);
    return qpelTaps(qpelHalfSample(i, mirrorTap(k, size)), qpelHalfSample(i, mirrorTap(k + 1, size)),
        qpelHalfSample(i, mirrorTap(k - 1, size)), qpelHalfSample(i, mirrorTap(k + 2, size)),
        qpelHalfSample(i, mirrorTap(k - 2, size)), qpelHalfSample(i, mirrorTap(k + 3, size)),
        qpelHalfSample(i, mirrorTap(k - 3, size)), qpelHalfSample(i, mirrorTap(k + 4, size)));
}

// op_put and op_put_no_rnd of the lowpass filters: (b + 16) >> 5 or (b + 15) >> 5 through the crop table
fn qpelRound(value: i32, rounding: i32) -> i32 {
    return clipToByte((value + 15 + rounding) >> 5u);
}

// qpeldsp.c's qpel{16,8}_mcXY: the window of the block's reference samples; for a horizontal quarter or half position the window's
// lines filtered horizontally, averaged with the window's column x or x + 1 at a quarter position when a vertical filter follows,
// as the mcX1, mcX2, and mcX3 functions' halfH; then each sample: the window, its filtered lines, or their vertical filter, averaged at
// quarter positions with the line it lies nearest, as the final pixels_l2 does. put_no_rnd rounds every filter and average down
fn runQpel(word: u32, arguments: u32, localIndex: u32) {
    let size = select(8u, 16u, (word & RECORD_OP_WIDE) != 0u);
    let dxy = (word >> RECORD_OP_DXY_SHIFT) & RECORD_OP_DXY_MASK;
    let fractionX = dxy & 3u;
    let fractionY = dxy >> 2u;
    let rounding = select(1, 0, (word & RECORD_OP_NO_ROUNDING) != 0u);
    let averaging = (word & RECORD_OP_AVERAGE) != 0u;
    let position = unpackPosition(readPacketWord(arguments));
    let windowSize = size + 1u;
    for (var index = localIndex; index < windowSize * windowSize; index += RECONSTRUCT_WORKGROUP_SIZE) {
        let i = index % windowSize;
        let j = index / windowSize;
        qpelWindow[j * QPEL_WINDOW_STRIDE + i] = referenceSample(position.x + i32(i), position.y + i32(j));
    }
    workgroupBarrier();
    if (fractionX != 0u) {
        for (var index = localIndex; index < windowSize * size; index += RECONSTRUCT_WORKGROUP_SIZE) {
            let i = index % size;
            let j = index / size;
            var half = qpelRound(qpelWindowHorizontal(i, j, i32(size)), rounding);
            if (fractionY != 0u && fractionX != 2u) {
                half = average2(half, qpelWindowSample(i + (fractionX >> 1u), j), rounding);
            }
            qpelHalf[j * QPEL_HALF_STRIDE + i] = half;
        }
        workgroupBarrier();
    }
    for (var index = localIndex; index < size * size; index += RECONSTRUCT_WORKGROUP_SIZE) {
        let i = index % size;
        let j = index / size;
        var value: i32;
        if (fractionY == 0u) {
            if (fractionX == 0u) {
                value = qpelWindowSample(i, j);
            } else if (fractionX == 2u) {
                value = qpelHalfSample(i, j);
            } else {
                value = average2(qpelWindowSample(i + (fractionX >> 1u), j), qpelHalfSample(i, j), rounding);
            }
        } else {
            var nearest: i32;
            var filtered: i32;
            if (fractionX == 0u) {
                filtered = qpelRound(qpelWindowVertical(i, j, i32(size)), rounding);
                nearest = qpelWindowSample(i, j + (fractionY >> 1u));
            } else {
                filtered = qpelRound(qpelHalfVertical(i, j, i32(size)), rounding);
                nearest = qpelHalfSample(i, j + (fractionY >> 1u));
            }
            value = select(average2(nearest, filtered, rounding), filtered, fractionY == 2u);
        }
        storePrediction(i, j, value, averaging);
    }
}

// Runs one operation on one plane into the prediction: avg_ operations average the rounded prediction of the matching put into it
fn runOperation(word: u32, arguments: u32, localIndex: u32) {
    let kind = word & RECORD_OP_KIND_MASK;
    if (kind == RECORD_OP_QPEL) {
        runQpel(word, arguments, localIndex);
        return;
    }
    var width = select(8u, 16u, (word & RECORD_OP_WIDE) != 0u);
    var height = (word >> RECORD_OP_HEIGHT_SHIFT) & RECORD_OP_HEIGHT_MASK;
    // obmc_motion predicts one 8x8 luma block
    if (kind == RECORD_OP_OBMC) {
        width = 8u;
        height = 8u;
    }
    let dxy = (word >> RECORD_OP_DXY_SHIFT) & RECORD_OP_DXY_MASK;
    let rounding = select(1, 0, (word & RECORD_OP_NO_ROUNDING) != 0u);
    let averaging = (word & RECORD_OP_AVERAGE) != 0u;
    for (var index = localIndex; index < width * height; index += RECONSTRUCT_WORKGROUP_SIZE) {
        let i = index % width;
        let j = index / width;
        var value: i32;
        switch (kind) {
            case RECORD_OP_HPEL: {
                let position = unpackPosition(readPacketWord(arguments));
                value = hpelSample(position.x + i32(i), position.y + i32(j), dxy & 3u, rounding);
            }
            case RECORD_OP_GMC1: {
                let position = unpackPosition(readPacketWord(arguments));
                value = gmc1Sample(position.x + i32(i), position.y + i32(j), readPacketWord(arguments + 1u));
            }
            case RECORD_OP_GMC: {
                let origin = vec2i(bitcast<i32>(readPacketWord(arguments)), bitcast<i32>(readPacketWord(arguments + 1u)));
                value = gmcSample(origin, i32(i), i32(j));
            }
            default: {
                value = obmcSample(arguments, i, j, rounding);
            }
        }
        storePrediction(i, j, value, averaging);
    }
}

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

// idctRowCondDC: one row, kept in int16; a row with only its DC fills with the DC scaled.
// The even part sums the even coefficients' cosines, the odd part the odd ones'; their sum and difference are the outputs
fn simpleTransformRow(base: u32) {
    let coefficient0 = coefficients[base];
    let coefficient1 = coefficients[base + 1u];
    let coefficient2 = coefficients[base + 2u];
    let coefficient3 = coefficients[base + 3u];
    let coefficient4 = coefficients[base + 4u];
    let coefficient5 = coefficients[base + 5u];
    let coefficient6 = coefficients[base + 6u];
    let coefficient7 = coefficients[base + 7u];
    if ((coefficient1 | coefficient2 | coefficient3 | coefficient4 | coefficient5 | coefficient6 | coefficient7) == 0) {
        let dc = wrapInt16(coefficient0 << IDCT_DC_SHIFT);
        for (var column = 0u; column < 8u; column += 1u) {
            coefficients[base + column] = dc;
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
    coefficients[base] = wrapInt16((even0 + odd0) >> IDCT_ROW_SHIFT);
    coefficients[base + 1u] = wrapInt16((even1 + odd1) >> IDCT_ROW_SHIFT);
    coefficients[base + 2u] = wrapInt16((even2 + odd2) >> IDCT_ROW_SHIFT);
    coefficients[base + 3u] = wrapInt16((even3 + odd3) >> IDCT_ROW_SHIFT);
    coefficients[base + 4u] = wrapInt16((even3 - odd3) >> IDCT_ROW_SHIFT);
    coefficients[base + 5u] = wrapInt16((even2 - odd2) >> IDCT_ROW_SHIFT);
    coefficients[base + 6u] = wrapInt16((even1 - odd1) >> IDCT_ROW_SHIFT);
    coefficients[base + 7u] = wrapInt16((even0 - odd0) >> IDCT_ROW_SHIFT);
}

// idctSparseColPut and idctSparseColAdd's column pass: the sample of an intra block before its clip, or the residual an inter block adds
fn simpleTransformColumn(base: u32) -> array<i32, 8> {
    let coefficient0 = coefficients[base];
    let coefficient1 = coefficients[base + 8u];
    let coefficient2 = coefficients[base + 16u];
    let coefficient3 = coefficients[base + 24u];
    let coefficient4 = coefficients[base + 32u];
    let coefficient5 = coefficients[base + 40u];
    let coefficient6 = coefficients[base + 48u];
    let coefficient7 = coefficients[base + 56u];
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
    return array<i32, 8>(
        (even0 + odd0) >> IDCT_COLUMN_SHIFT,
        (even1 + odd1) >> IDCT_COLUMN_SHIFT,
        (even2 + odd2) >> IDCT_COLUMN_SHIFT,
        (even3 + odd3) >> IDCT_COLUMN_SHIFT,
        (even3 - odd3) >> IDCT_COLUMN_SHIFT,
        (even2 - odd2) >> IDCT_COLUMN_SHIFT,
        (even1 - odd1) >> IDCT_COLUMN_SHIFT,
        (even0 - odd0) >> IDCT_COLUMN_SHIFT
    );
}

// The Xvid IDCT, xvididct.c: each row's cosines, scaled for its row, and the rounding of its row pass
const XVID_ROW_SHIFT: u32 = 11u;
const XVID_COLUMN_SHIFT: u32 = 6u;
// TAB04, TAB17, TAB26, and TAB35, seven cosines each
const XVID_TABLES = array<i32, 28>(
    22725, 21407, 19266, 16384, 12873, 8867, 4520,
    31521, 29692, 26722, 22725, 17855, 12299, 6270,
    29692, 27969, 25172, 21407, 16819, 11585, 5906,
    26722, 25172, 22654, 19266, 15137, 10426, 5315
);
// ff_xvid_idct's table and rounding of rows 0 to 7: TAB04, TAB17, TAB26, TAB35, TAB04, TAB35, TAB26, TAB17
const XVID_ROW_TABLES = array<u32, 8>(0u, 1u, 2u, 3u, 0u, 3u, 2u, 1u);
const XVID_ROW_ROUNDING = array<i32, 8>(65536, 3597, 2260, 1203, 0, 120, 512, 512);
const XVID_TAN1: i32 = 0x32EC;
const XVID_TAN2: i32 = 0x6A0A;
const XVID_TAN3: i32 = 0xAB0E;
const XVID_SQRT2: i32 = 0x5A82;

// idct_row: the row's outputs stored as shorts; a row of zeros stays
fn xvidTransformRow(base: u32, row: u32) {
    let table = XVID_ROW_TABLES[row] * 7u;
    let rounding = XVID_ROW_ROUNDING[row];
    let c1 = XVID_TABLES[table];
    let c2 = XVID_TABLES[table + 1u];
    let c3 = XVID_TABLES[table + 2u];
    let c4 = XVID_TABLES[table + 3u];
    let c5 = XVID_TABLES[table + 4u];
    let c6 = XVID_TABLES[table + 5u];
    let c7 = XVID_TABLES[table + 6u];
    let in0 = coefficients[base];
    let in1 = coefficients[base + 1u];
    let in2 = coefficients[base + 2u];
    let in3 = coefficients[base + 3u];
    let in4 = coefficients[base + 4u];
    let in5 = coefficients[base + 5u];
    let in6 = coefficients[base + 6u];
    let in7 = coefficients[base + 7u];
    let right = in5 | in6 | in7;
    let left = in1 | in2 | in3;
    var outputs: array<i32, 8>;
    if ((right | in4) == 0) {
        let k = c4 * in0 + rounding;
        if (left != 0) {
            let a0 = k + c2 * in2;
            let a1 = k + c6 * in2;
            let a2 = k - c6 * in2;
            let a3 = k - c2 * in2;
            let b0 = c1 * in1 + c3 * in3;
            let b1 = c3 * in1 - c7 * in3;
            let b2 = c5 * in1 - c1 * in3;
            let b3 = c7 * in1 - c5 * in3;
            outputs = array<i32, 8>(a0 + b0, a1 + b1, a2 + b2, a3 + b3, a3 - b3, a2 - b2, a1 - b1, a0 - b0);
        } else {
            let a0 = k >> XVID_ROW_SHIFT;
            if (a0 == 0) {
                return;
            }
            let value = wrapInt16(a0);
            for (var column = 0u; column < 8u; column += 1u) {
                coefficients[base + column] = value;
            }
            return;
        }
    } else if ((left | right) == 0) {
        let a0 = wrapInt16((rounding + c4 * (in0 + in4)) >> XVID_ROW_SHIFT);
        let a1 = wrapInt16((rounding + c4 * (in0 - in4)) >> XVID_ROW_SHIFT);
        coefficients[base] = a0;
        coefficients[base + 1u] = a1;
        coefficients[base + 2u] = a1;
        coefficients[base + 3u] = a0;
        coefficients[base + 4u] = a0;
        coefficients[base + 5u] = a1;
        coefficients[base + 6u] = a1;
        coefficients[base + 7u] = a0;
        return;
    } else {
        let k = c4 * in0 + rounding;
        let a0 = k + c2 * in2 + c4 * in4 + c6 * in6;
        let a1 = k + c6 * in2 - c4 * in4 - c2 * in6;
        let a2 = k - c6 * in2 - c4 * in4 + c2 * in6;
        let a3 = k - c2 * in2 + c4 * in4 - c6 * in6;
        let b0 = c1 * in1 + c3 * in3 + c5 * in5 + c7 * in7;
        let b1 = c3 * in1 - c7 * in3 - c1 * in5 - c5 * in7;
        let b2 = c5 * in1 - c1 * in3 + c7 * in5 + c3 * in7;
        let b3 = c7 * in1 - c5 * in3 + c3 * in5 - c1 * in7;
        outputs = array<i32, 8>(a0 + b0, a1 + b1, a2 + b2, a3 + b3, a3 - b3, a2 - b2, a1 - b1, a0 - b0);
    }
    for (var column = 0u; column < 8u; column += 1u) {
        coefficients[base + column] = wrapInt16(outputs[column] >> XVID_ROW_SHIFT);
    }
}

// MULT: the high half of a 16-bit fixed-point product
fn xvidMultiply(constant: i32, value: i32) -> i32 {
    return (constant * value) >> 16u;
}

// idct_col_8, the outputs stored as shorts. ff_xvid_idct takes idct_col_4 or idct_col_3 when rows 4 to 7, or 3 to 7, are zero, which
// compute what idct_col_8 does of such a column
fn xvidTransformColumn(base: u32) -> array<i32, 8> {
    var mm4 = coefficients[base + 56u];
    var mm5 = coefficients[base + 40u];
    var mm6 = coefficients[base + 24u];
    var mm7 = coefficients[base + 8u];
    var mm0 = xvidMultiply(XVID_TAN1, mm4) + mm7;
    var mm1 = xvidMultiply(XVID_TAN1, mm7) - mm4;
    var mm2 = xvidMultiply(XVID_TAN3, mm5) + mm6;
    var mm3 = xvidMultiply(XVID_TAN3, mm6) - mm5;
    mm7 = mm0 + mm2;
    mm4 = mm1 - mm3;
    mm0 = mm0 - mm2;
    mm1 = mm1 + mm3;
    mm6 = mm0 + mm1;
    mm5 = mm0 - mm1;
    mm5 = 2 * xvidMultiply(XVID_SQRT2, mm5);
    mm6 = 2 * xvidMultiply(XVID_SQRT2, mm6);
    mm1 = coefficients[base + 16u];
    mm2 = coefficients[base + 48u];
    mm3 = xvidMultiply(XVID_TAN2, mm2) + mm1;
    mm2 = xvidMultiply(XVID_TAN2, mm1) - mm2;
    mm0 = coefficients[base] + coefficients[base + 32u];
    mm1 = coefficients[base] - coefficients[base + 32u];
    // The butterflies: (a, b) becomes (a + b, a - b)
    var spill = mm0 + mm3;
    mm3 = mm0 - mm3;
    mm0 = spill;
    spill = mm0 + mm7;
    mm7 = mm0 - mm7;
    mm0 = spill;
    spill = mm3 + mm4;
    mm4 = mm3 - mm4;
    mm3 = spill;
    spill = mm1 + mm2;
    mm2 = mm1 - mm2;
    mm1 = spill;
    spill = mm1 + mm6;
    mm6 = mm1 - mm6;
    mm1 = spill;
    spill = mm2 + mm5;
    mm5 = mm2 - mm5;
    mm2 = spill;
    return array<i32, 8>(
        wrapInt16(mm0 >> XVID_COLUMN_SHIFT),
        wrapInt16(mm1 >> XVID_COLUMN_SHIFT),
        wrapInt16(mm2 >> XVID_COLUMN_SHIFT),
        wrapInt16(mm3 >> XVID_COLUMN_SHIFT),
        wrapInt16(mm4 >> XVID_COLUMN_SHIFT),
        wrapInt16(mm5 >> XVID_COLUMN_SHIFT),
        wrapInt16(mm6 >> XVID_COLUMN_SHIFT),
        wrapInt16(mm7 >> XVID_COLUMN_SHIFT)
    );
}

// Where row r of a block lies in the prediction: interlaced DCT puts luma blocks 0 to 3 on alternating lines, as FFmpeg's
// dct_linesize of two lines and dct_offset of one line do; chroma blocks stay frame-ordered
fn blockSampleIndex(block: u32, row: u32, column: u32, interlaced: bool) -> u32 {
    if (block >= 4u) {
        return predictionIndex(block - 3u, column, row);
    }
    let x = (block & 1u) * 8u + column;
    var y = (block >> 1u) * 8u + row;
    if (interlaced) {
        y = 2u * row + (block >> 1u);
    }
    return predictionIndex(0u, x, y);
}

@compute @workgroup_size(RECONSTRUCT_WORKGROUP_SIZE)
fn reconstruct(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    if (recordFailure() != 0u) {
        return;
    }
    let column = workgroupId.x;
    let row = workgroupId.y;
    if (column >= headerValue(RECORD_HEADER_MB_WIDTH) || row >= headerValue(RECORD_HEADER_MB_HEIGHT)) {
        return;
    }
    let record = macroblockRecord(column, row);
    if (!macroblockRecordHolds(record)) {
        if (localIndex == 0u) {
            reportFailure(ERROR_RECORD_INVALID, INVALID_RECORD_MACROBLOCK);
        }
        return;
    }
    let flags = readPacketWord(record + RECORD_MACROBLOCK_FLAGS);
    let intra = (flags & RECORD_MB_INTRA) != 0u;
    let interlaced = (flags & RECORD_MB_INTERLACED_DCT) != 0u;
    let residualMask = (flags >> RECORD_MB_RESIDUAL_SHIFT) & RECORD_MB_RESIDUAL_MASK;
    let operationCount = (flags >> RECORD_MB_OPERATION_COUNT_SHIFT) & RECORD_MB_OPERATION_COUNT_MASK;
    let entryCount = (flags >> RECORD_MB_ENTRY_COUNT_SHIFT) & RECORD_MB_ENTRY_COUNT_MASK;
    for (var index = localIndex; index < PREDICTION_SAMPLES; index += RECONSTRUCT_WORKGROUP_SIZE) {
        prediction[index] = 0u;
        coefficients[index] = 0;
    }
    workgroupBarrier();

    // The operations in order, each on its plane or on both chroma planes
    var cursor = record + RECORD_MACROBLOCK_FIXED_WORDS;
    for (var operation = 0u; operation < operationCount; operation += 1u) {
        let word = readPacketWord(cursor);
        let chroma = (word & RECORD_OP_CHROMA) != 0u;
        for (var plane = select(0u, 1u, chroma); plane <= select(0u, 2u, chroma); plane += 1u) {
            beginOperation(word, plane);
            runOperation(word, cursor + 1u, localIndex);
            workgroupBarrier();
        }
        cursor += 1u + operationArgumentWords(word & RECORD_OP_KIND_MASK);
    }

    // The dense blocks and the coefficient entries into their blocks, then the IDCT's row pass and its column pass, which puts an intra
    // block's samples or adds an inter block's residual to the prediction, clipped
    let denseMask = (flags >> RECORD_MB_DENSE_SHIFT) & RECORD_MB_DENSE_MASK;
    let denseWords = countOneBits(denseMask) * RECORD_DENSE_BLOCK_WORDS;
    for (var index = localIndex; index < denseWords; index += RECONSTRUCT_WORKGROUP_SIZE) {
        let word = readPacketWord(cursor + index);
        let block = denseBlock(denseMask, index / RECORD_DENSE_BLOCK_WORDS);
        let position = (index % RECORD_DENSE_BLOCK_WORDS) * 2u;
        coefficients[block * 64u + position] = i32(word << 16u) >> 16u;
        coefficients[block * 64u + position + 1u] = i32(word) >> 16u;
    }
    cursor += denseWords;
    for (var entry = localIndex; entry < entryCount; entry += RECONSTRUCT_WORKGROUP_SIZE) {
        let word = readPacketWord(cursor + entry);
        let block = (word >> RECORD_ENTRY_BLOCK_SHIFT) & RECORD_ENTRY_BLOCK_MASK;
        if (block < BLOCK_COUNT) {
            let position = (word >> RECORD_ENTRY_POSITION_SHIFT) & RECORD_ENTRY_POSITION_MASK;
            coefficients[block * 64u + position] = wrapInt16(i32(word & RECORD_ENTRY_VALUE_MASK));
        }
    }
    workgroupBarrier();
    let xvid = headerValue(RECORD_HEADER_IDCT) == RECORD_IDCT_XVID;
    let transformBlock = localIndex >> 3u;
    let transformLine = localIndex & 7u;
    let transforms = localIndex < BLOCK_COUNT * 8u && ((residualMask >> transformBlock) & 1u) != 0u;
    if (transforms) {
        let base = transformBlock * 64u + transformLine * 8u;
        if (xvid) {
            xvidTransformRow(base, transformLine);
        } else {
            simpleTransformRow(base);
        }
    }
    workgroupBarrier();
    if (transforms) {
        let base = transformBlock * 64u + transformLine;
        var residual: array<i32, 8>;
        if (xvid) {
            residual = xvidTransformColumn(base);
        } else {
            residual = simpleTransformColumn(base);
        }
        for (var line = 0u; line < 8u; line += 1u) {
            let index = blockSampleIndex(transformBlock, line, transformLine, interlaced);
            var value = residual[line];
            if (!intra) {
                value += i32(prediction[index]);
            }
            prediction[index] = u32(clipToByte(value));
        }
    }
    workgroupBarrier();

    // The samples, a word of four per invocation: luma, then the chroma planes' eight lines of two words
    let lumaLine = localIndex >> 2u;
    let lumaX = (localIndex & 3u) * 4u;
    let lumaIndex = predictionIndex(0u, lumaX, lumaLine);
    writeOutputSamples8(0u, column * MACROBLOCK_SIZE + lumaX, row * MACROBLOCK_SIZE + lumaLine,
        vec4u(prediction[lumaIndex], prediction[lumaIndex + 1u], prediction[lumaIndex + 2u], prediction[lumaIndex + 3u]));
    if (localIndex < 32u) {
        let plane = 1u + (localIndex >> 4u);
        let chromaLine = (localIndex >> 1u) & 7u;
        let chromaX = (localIndex & 1u) * 4u;
        let chromaIndex = predictionIndex(plane, chromaX, chromaLine);
        writeOutputSamples8(plane, column * CHROMA_SIZE + chromaX, row * CHROMA_SIZE + chromaLine,
            vec4u(prediction[chromaIndex], prediction[chromaIndex + 1u], prediction[chromaIndex + 2u], prediction[chromaIndex + 3u]));
    }
}

// H.263 Annex J deblocking: h263dsp.c's filters, in two passes over the picture, every horizontal edge, then every vertical edge
const LOOP_FILTER_STRENGTH = array<i32, 32>(
    0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 7,
    7, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12, 12
);

// One line of four samples across an edge, p0 and p1 before it and p2 and p3 after it: h263_h_loop_filter_c and
// h263_v_loop_filter_c's body; its divisions truncate toward zero as C's do
fn filterEdgeLine(samples: vec4i, qp: u32) -> vec4i {
    let strength = LOOP_FILTER_STRENGTH[qp];
    let p0 = samples.x;
    var p1 = samples.y;
    var p2 = samples.z;
    let p3 = samples.w;
    let d = (p0 - p3 + 4 * (p2 - p1)) / 8;
    var d1 = 0;
    if (d < -2 * strength) {
        d1 = 0;
    } else if (d < -strength) {
        d1 = -2 * strength - d;
    } else if (d < strength) {
        d1 = d;
    } else if (d < 2 * strength) {
        d1 = 2 * strength - d;
    }
    p1 += d1;
    p2 -= d1;
    // A sample past either end of the byte range saturates
    if ((p1 & 256) != 0) {
        p1 = ~(p1 >> 31u);
    }
    if ((p2 & 256) != 0) {
        p2 = ~(p2 >> 31u);
    }
    let ad1 = abs(d1) >> 1u;
    let d2 = clamp((p0 - p3) / 4, -ad1, ad1);
    return vec4i(p0 - d2, p1, p2, p3 + d2) & vec4i(255);
}

fn outputWordIndex(plane: u32, x: u32, y: u32) -> u32 {
    return getSampleByteAddress(packet.outputSlot, plane, x, y) >> 2u;
}

fn unpackSamples(word: u32) -> vec4i {
    return vec4i(i32(word & 0xFFu), i32((word >> 8u) & 0xFFu), i32((word >> 16u) & 0xFFu), i32(word >> 24u));
}

fn packSamples(samples: vec4i) -> u32 {
    let bytes = vec4u(samples) & vec4u(0xFFu);
    return bytes.x | (bytes.y << 8u) | (bytes.z << 16u) | (bytes.w << 24u);
}

// h263_v_loop_filter_c across the horizontal edge above line y, over the four columns of the output word at x
fn filterHorizontalEdgeWord(plane: u32, x: u32, y: u32, qp: u32) {
    let indices = vec4u(outputWordIndex(plane, x, y - 2u), outputWordIndex(plane, x, y - 1u), outputWordIndex(plane, x, y),
        outputWordIndex(plane, x, y + 1u));
    var lines = array<vec4i, 4>(unpackSamples(framePool[indices.x]), unpackSamples(framePool[indices.y]), unpackSamples(framePool[indices.z]),
        unpackSamples(framePool[indices.w]));
    for (var lane = 0u; lane < 4u; lane += 1u) {
        let filtered = filterEdgeLine(vec4i(lines[0][lane], lines[1][lane], lines[2][lane], lines[3][lane]), qp);
        lines[0][lane] = filtered.x;
        lines[1][lane] = filtered.y;
        lines[2][lane] = filtered.z;
        lines[3][lane] = filtered.w;
    }
    framePool[indices.x] = packSamples(lines[0]);
    framePool[indices.y] = packSamples(lines[1]);
    framePool[indices.z] = packSamples(lines[2]);
    framePool[indices.w] = packSamples(lines[3]);
}

// h263_h_loop_filter_c across the vertical edge left of column x, a multiple of 4, on line y: the two samples before it end the
// previous word, the two after it start the next
fn filterVerticalEdgeLine(plane: u32, x: u32, y: u32, qp: u32) {
    let beforeIndex = outputWordIndex(plane, x - 4u, y);
    let afterIndex = outputWordIndex(plane, x, y);
    var before = unpackSamples(framePool[beforeIndex]);
    var after = unpackSamples(framePool[afterIndex]);
    let filtered = filterEdgeLine(vec4i(before.z, before.w, after.x, after.y), qp);
    before.z = filtered.x;
    before.w = filtered.y;
    after.x = filtered.z;
    after.y = filtered.w;
    framePool[beforeIndex] = packSamples(before);
    framePool[afterIndex] = packSamples(after);
}

// The deblocking word of a macroblock the pass filters, or 0 for none: the record must hold it and the picture filter
fn loopFilterWord(column: u32, row: u32) -> u32 {
    if (recordFailure() != 0u || headerValue(RECORD_HEADER_LOOP_FILTER) == 0u) {
        return 0u;
    }
    if (column >= headerValue(RECORD_HEADER_MB_WIDTH) || row >= headerValue(RECORD_HEADER_MB_HEIGHT)) {
        return 0u;
    }
    let record = macroblockRecord(column, row);
    let words = recordWords();
    if (record < RECORD_HEADER_WORDS || record > words || words - record < RECORD_MACROBLOCK_FIXED_WORDS) {
        return 0u;
    }
    return readPacketWord(record + RECORD_MACROBLOCK_LOOP_FILTER);
}

fn loopFilterQp(word: u32, shift: u32) -> u32 {
    return (word >> shift) & RECORD_LOOP_FILTER_QP_MASK;
}

// ff_h263_loop_filter's horizontal edges of a macroblock, h263_v_loop_filter: the luma edge at line 8 with the macroblock's quantizer,
// and its top edge in luma and both chroma planes when the macroblock above or it codes one. Invocations 0 to 3 take the four words
// of the inner edge, 4 to 7 the top edge's luma words, 8 to 11 its chroma words
@compute @workgroup_size(16)
fn filterHorizontalEdges(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    let column = workgroupId.x;
    let row = workgroupId.y;
    let word = loopFilterWord(column, row);
    let lumaX = column * MACROBLOCK_SIZE + (localIndex & 3u) * 4u;
    let lumaY = row * MACROBLOCK_SIZE;
    if (localIndex < 4u) {
        let qp = loopFilterQp(word, RECORD_LOOP_FILTER_INNER_SHIFT);
        if (qp != 0u) {
            filterHorizontalEdgeWord(0u, lumaX, lumaY + 8u, qp);
        }
    } else if (localIndex < 8u) {
        let qp = loopFilterQp(word, RECORD_LOOP_FILTER_TOP_SHIFT);
        if (qp != 0u && row != 0u) {
            filterHorizontalEdgeWord(0u, lumaX, lumaY, qp);
        }
    } else if (localIndex < 12u) {
        let qp = loopFilterQp(word, RECORD_LOOP_FILTER_TOP_CHROMA_SHIFT);
        if (qp != 0u && loopFilterQp(word, RECORD_LOOP_FILTER_TOP_SHIFT) != 0u && row != 0u) {
            let plane = 1u + ((localIndex >> 1u) & 1u);
            filterHorizontalEdgeWord(plane, column * CHROMA_SIZE + (localIndex & 1u) * 4u, row * CHROMA_SIZE, qp);
        }
    }
}

// ff_h263_loop_filter's vertical edges of a macroblock, h263_h_loop_filter: the luma edge at column 8 with the macroblock's
// quantizer, and its left edge in luma and both chroma planes when the macroblock left of it or it codes one. Invocations 0 to 15
// take the inner edge's lines, 16 to 31 the left edge's luma lines, 32 to 47 its chroma lines
@compute @workgroup_size(64)
fn filterVerticalEdges(@builtin(workgroup_id) workgroupId: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    let column = workgroupId.x;
    let row = workgroupId.y;
    let word = loopFilterWord(column, row);
    let lumaX = column * MACROBLOCK_SIZE;
    let lumaY = row * MACROBLOCK_SIZE + (localIndex & 15u);
    if (localIndex < 16u) {
        let qp = loopFilterQp(word, RECORD_LOOP_FILTER_INNER_SHIFT);
        if (qp != 0u) {
            filterVerticalEdgeLine(0u, lumaX + 8u, lumaY, qp);
        }
    } else if (localIndex < 32u) {
        let qp = loopFilterQp(word, RECORD_LOOP_FILTER_LEFT_SHIFT);
        if (qp != 0u && column != 0u) {
            filterVerticalEdgeLine(0u, lumaX, lumaY, qp);
        }
    } else if (localIndex < 48u) {
        let qp = loopFilterQp(word, RECORD_LOOP_FILTER_LEFT_CHROMA_SHIFT);
        if (qp != 0u && loopFilterQp(word, RECORD_LOOP_FILTER_LEFT_SHIFT) != 0u && column != 0u) {
            let plane = 1u + ((localIndex >> 3u) & 1u);
            filterVerticalEdgeLine(plane, column * CHROMA_SIZE, row * CHROMA_SIZE + (localIndex & 7u), qp);
        }
    }
}
