// AV1 filters family: deblocking, CDEF, super-resolution, and loop restoration with its stripe boundaries. Owner: av1-gpu-filters;
// scratch/av1/DESIGN.md specifies its functions, prefixes, and record fields.
// Every function is bit-exact with libaom v3.15.2's C functions (vendor/aom), which scratch/av1/gpu-filters/ checks on Dawn.

// Shared

const FILTERS_WORKGROUP_SIZE: u32 = 64u;
// The area of a workgroup of the deblocking, CDEF, and loop restoration passes: 64x64 luma samples
const FILTERS_AREA_SIZE_LOG2: u32 = 6u;

// A plane's horizontal subsampling: 0 for luma
fn filtersGetSubsamplingX(plane: u32) -> u32 {
    if (plane == PLANE_Y) {
        return 0u;
    }
    return readRecordWord(RECORD_HEADER_SUBSAMPLING_X);
}

// A plane's vertical subsampling: 0 for luma
fn filtersGetSubsamplingY(plane: u32) -> u32 {
    if (plane == PLANE_Y) {
        return 0u;
    }
    return readRecordWord(RECORD_HEADER_SUBSAMPLING_Y);
}

// Whether the frame codes a plane: monochrome frames code luma only
fn filtersHasPlane(plane: u32) -> bool {
    return plane == PLANE_Y || !hasRecordFlag(RECORD_FLAG_MONOCHROME);
}

// Words an invocation copies per round of filtersCopyArea, their loads issued together
const FILTERS_COPY_BATCH: u32 = 4u;

// The word of pair index of a copy area: the area's rows from firstRow, 2^pairsPerRowLog2 pairs per row from areaX
fn filtersGetCopyWord(index: u32, rowWords: u32, areaX: u32, firstRow: u32, pairsPerRowLog2: u32) -> u32 {
    let x = areaX + ((index & ((1u << pairsPerRowLog2) - 1u)) << SAMPLE_PAIR_SHIFT);
    return (firstRow + (index >> pairsPerRowLog2)) * rowWords + (x >> SAMPLE_PAIR_SHIFT);
}

// Writes a copied word when its pair is inside the copy area and short of the width limit
fn filtersStoreCopyWord(index: u32, pairCount: u32, columnMask: u32, areaX: u32, widthLimit: u32, targetWord: u32, value: u32) {
    if (index < pairCount && areaX + ((index & columnMask) << SAMPLE_PAIR_SHIFT) < widthLimit) {
        frames[targetWord] = value;
    }
}

// Copies the sample pairs of a plane's rows firstRow to rowEnd and columns areaX to areaX + 2^(pairsPerRowLog2 + 1), short of
// widthLimit, from the plane at sourceBase to the plane at targetBase (frames word indices, rows rowWords apart)
fn filtersCopyArea(sourceBase: u32, targetBase: u32, rowWords: u32, areaX: u32, firstRow: u32, rowEnd: u32, pairsPerRowLog2: u32,
    widthLimit: u32, lane: u32) {
    let pairCount = (rowEnd - firstRow) << pairsPerRowLog2;
    let lastPair = pairCount - 1u;
    let columnMask = (1u << pairsPerRowLog2) - 1u;
    for (var first = lane; first < pairCount; first += FILTERS_COPY_BATCH * FILTERS_WORKGROUP_SIZE) {
        // Indices past the area load its last pair, whose word is inside the store
        let second = first + FILTERS_WORKGROUP_SIZE;
        let third = second + FILTERS_WORKGROUP_SIZE;
        let fourth = third + FILTERS_WORKGROUP_SIZE;
        let word0 = filtersGetCopyWord(first, rowWords, areaX, firstRow, pairsPerRowLog2);
        let word1 = filtersGetCopyWord(min(second, lastPair), rowWords, areaX, firstRow, pairsPerRowLog2);
        let word2 = filtersGetCopyWord(min(third, lastPair), rowWords, areaX, firstRow, pairsPerRowLog2);
        let word3 = filtersGetCopyWord(min(fourth, lastPair), rowWords, areaX, firstRow, pairsPerRowLog2);
        let value0 = frames[sourceBase + word0];
        let value1 = frames[sourceBase + word1];
        let value2 = frames[sourceBase + word2];
        let value3 = frames[sourceBase + word3];
        filtersStoreCopyWord(first, pairCount, columnMask, areaX, widthLimit, targetBase + word0, value0);
        filtersStoreCopyWord(second, pairCount, columnMask, areaX, widthLimit, targetBase + word1, value1);
        filtersStoreCopyWord(third, pairCount, columnMask, areaX, widthLimit, targetBase + word2, value2);
        filtersStoreCopyWord(fourth, pairCount, columnMask, areaX, widthLimit, targetBase + word3, value3);
    }
}

// Deblocking: libaom's av1_filter_block_plane_vert and av1_filter_block_plane_horz with set_lpf_parameters (the decoder's
// lpf_opt_level 0, av1/common/av1_loopfilter.c) and the aom_highbd_lpf_* filters of aom_dsp/loopfilter.c, which equal the 8-bit ones
// at bit depth 8.
// A filter reaches at most half of the smaller transform side across its edge, so edges of one direction never share a sample or a
// word, and all of them filter at once; libaom's vertical then horizontal order per 128-row band equals all vertical edges first.
// A workgroup takes the edges of its 64x64 luma area of plane z: it reads every 4x4 unit's transform and plane block sides, level,
// and skip into workgroup memory, then each invocation decides one edge and filters it on two lines, two rows of a vertical edge or a
// column pair of a horizontal one.

const DEBLOCK_UNIT_SIZE_LOG2: u32 = 2u;
// Units per side of a luma area
const DEBLOCK_AREA_UNITS_LOG2: u32 = 4u;
// Unit slots per line of units: the unit before the area's first edge, then the area's units
const DEBLOCK_UNIT_SLOTS: u32 = 17u;
const DEBLOCK_UNIT_COUNT: u32 = 272u;
// A unit word: log2 of the transform side and of the plane block side across the pass's edges, the level, and skipped inter
const DEBLOCK_UNIT_TRANSFORM_SHIFT: u32 = 0u;
const DEBLOCK_UNIT_BLOCK_SHIFT: u32 = 3u;
const DEBLOCK_UNIT_SIDE_BITS: u32 = 3u;
const DEBLOCK_UNIT_LEVEL_SHIFT: u32 = 6u;
const DEBLOCK_UNIT_SKIP_INTER_SHIFT: u32 = 12u;
// Plane blocks are at least 4 samples on a side (av1_ss_size_lookup), chroma transforms at most 32 (av1_get_adjusted_tx_size)
const DEBLOCK_MINIMUM_SIDE_LOG2: u32 = 2u;
const DEBLOCK_CHROMA_TRANSFORM_MAXIMUM_LOG2: u32 = 5u;
// A decision: the filter length, 0 for none, and the level
const DEBLOCK_DECISION_LEVEL_SHIFT: u32 = 8u;
const DEBLOCK_DECISION_LENGTH_MASK: u32 = 255u;
const DEBLOCK_LENGTH_4: u32 = 4u;
const DEBLOCK_LENGTH_6: u32 = 6u;
const DEBLOCK_LENGTH_8: u32 = 8u;
const DEBLOCK_LENGTH_14: u32 = 14u;
// The samples an invocation filters on each line: p6 to q6, with the edge between indices 6 and 7
const DEBLOCK_SAMPLES: u32 = 14u;
// update_sharpness: the inner limit is halved by sharpness above 0 and again above 4, and capped at 9 - sharpness
const DEBLOCK_SHARPNESS_SECOND_HALVING: u32 = 4u;
const DEBLOCK_SHARPNESS_LIMIT_BASE: u32 = 9u;
const DEBLOCK_HIGH_VARIANCE_SHIFT: u32 = 4u;
// The filters' signed sample range at bit depth 8 (signed_char_clamp_high), scaled up by the bit depth
const DEBLOCK_SIGNED_OFFSET: i32 = 128;
const DEBLOCK_EIGHTHS: vec2u = vec2u(3u);
const DEBLOCK_SIXTEENTHS: vec2u = vec2u(4u);
const DEBLOCK_HALF: vec2u = vec2u(1u);

var<workgroup> deblockUnits: array<u32, DEBLOCK_UNIT_COUNT>;
var<workgroup> deblockControl: u32;

// Whether the workgroup's area of a plane has edges this frame filters
fn deblockIsAreaFiltered(plane: u32, areaX: u32, areaY: u32) -> bool {
    if (!isDecodingFrame() || !hasRecordFlag(RECORD_FLAG_DEBLOCK) || !filtersHasPlane(plane)) {
        return false;
    }
    let planes = getField(readRecordWord(RECORD_HEADER_DEBLOCK), RECORD_DEBLOCK_PLANES_SHIFT, RECORD_DEBLOCK_PLANES_BITS);
    if (((planes >> plane) & 1u) == 0u) {
        return false;
    }
    return areaX < getFramePlaneWidth(plane) && areaY < getFramePlaneHeight(plane);
}

// The unit word of the 4x4 unit at plane sample (x, y): chroma units read the mode info of the bottom-right luma unit of their group,
// as libaom's set_lpf_parameters does for sub8x8 blocks
fn deblockReadUnit(plane: u32, x: u32, y: u32, isVertical: bool, subsamplingX: u32, subsamplingY: u32) -> u32 {
    let modeInfoRow = ((y >> MI_SIZE_LOG2) << subsamplingY) | subsamplingY;
    let modeInfoColumn = ((x >> MI_SIZE_LOG2) << subsamplingX) | subsamplingX;
    let modeInfo = frameData[getModeInfoWordIndex(modeInfoRow, modeInfoColumn)];
    let blockIndex = getField(modeInfo, 0u, MODE_INFO_BLOCK_INDEX_BITS);
    let blockSize = getField(readBlockWord(blockIndex, RECORD_BLOCK_POSITION), RECORD_BLOCK_SIZE_SHIFT, RECORD_BLOCK_SIZE_BITS);
    let transform = readBlockWord(blockIndex, RECORD_BLOCK_TRANSFORM);
    var blockSideLog2: u32;
    var transformSideLog2: u32;
    var levelShift: u32;
    if (plane == PLANE_Y) {
        // The map holds the luma transform as the loop filter reads it (get_transform_size)
        let transformSize = getField(modeInfo, MODE_INFO_TX_SIZE_SHIFT, MODE_INFO_TX_SIZE_BITS);
        if (isVertical) {
            blockSideLog2 = getBlockWidthLog2(blockSize);
            transformSideLog2 = getTransformWidthLog2(transformSize);
            levelShift = RECORD_BLOCK_LEVEL_Y_VERTICAL_SHIFT;
        } else {
            blockSideLog2 = getBlockHeightLog2(blockSize);
            transformSideLog2 = getTransformHeightLog2(transformSize);
            levelShift = RECORD_BLOCK_LEVEL_Y_HORIZONTAL_SHIFT;
        }
    } else {
        if (isVertical) {
            blockSideLog2 = max(getBlockWidthLog2(blockSize) - subsamplingX, DEBLOCK_MINIMUM_SIDE_LOG2);
        } else {
            blockSideLog2 = max(getBlockHeightLog2(blockSize) - subsamplingY, DEBLOCK_MINIMUM_SIDE_LOG2);
        }
        // av1_get_max_uv_txsize, or 4x4 in a lossless segment
        transformSideLog2 = min(blockSideLog2, DEBLOCK_CHROMA_TRANSFORM_MAXIMUM_LOG2);
        let segment = getField(transform, RECORD_BLOCK_SEGMENT_SHIFT, RECORD_BLOCK_SEGMENT_BITS);
        if (((readRecordWord(RECORD_HEADER_SEGMENT_LOSSLESS_MASK) >> segment) & 1u) == 1u) {
            transformSideLog2 = DEBLOCK_MINIMUM_SIDE_LOG2;
        }
        levelShift = select(RECORD_BLOCK_LEVEL_V_SHIFT, RECORD_BLOCK_LEVEL_U_SHIFT, plane == PLANE_U);
    }
    let level = getField(transform, levelShift, RECORD_BLOCK_LEVEL_BITS);
    let skipInter = getField(modeInfo, MODE_INFO_SKIP_INTER_SHIFT, 1u);
    return (transformSideLog2 << DEBLOCK_UNIT_TRANSFORM_SHIFT) | (blockSideLog2 << DEBLOCK_UNIT_BLOCK_SHIFT)
        | (level << DEBLOCK_UNIT_LEVEL_SHIFT) | (skipInter << DEBLOCK_UNIT_SKIP_INTER_SHIFT);
}

// set_lpf_parameters for the edge before unit (edgeUnit, lineUnit), at edgePosition across the edges: the filter length and level,
// 0 when the edge does not filter; edgePosition is inside the frame and not 0, so both units are read
fn deblockDecide(lineUnit: u32, edgeUnit: u32, edgePosition: u32, plane: u32) -> u32 {
    let current = deblockUnits[lineUnit * DEBLOCK_UNIT_SLOTS + edgeUnit + 1u];
    let previous = deblockUnits[lineUnit * DEBLOCK_UNIT_SLOTS + edgeUnit];
    let currentTransformLog2 = getField(current, DEBLOCK_UNIT_TRANSFORM_SHIFT, DEBLOCK_UNIT_SIDE_BITS);
    // Only transform edges filter
    if ((edgePosition & ((1u << currentTransformLog2) - 1u)) != 0u) {
        return 0u;
    }
    let currentLevel = getField(current, DEBLOCK_UNIT_LEVEL_SHIFT, RECORD_BLOCK_LEVEL_BITS);
    let previousLevel = getField(previous, DEBLOCK_UNIT_LEVEL_SHIFT, RECORD_BLOCK_LEVEL_BITS);
    if (currentLevel == 0u && previousLevel == 0u) {
        return 0u;
    }
    // Between two skipped inter units, only a prediction edge of the current block filters
    let blockSideLog2 = getField(current, DEBLOCK_UNIT_BLOCK_SHIFT, DEBLOCK_UNIT_SIDE_BITS);
    let isPredictionEdge = (edgePosition & ((1u << blockSideLog2) - 1u)) == 0u;
    let bothSkipped = (current & previous & (1u << DEBLOCK_UNIT_SKIP_INTER_SHIFT)) != 0u;
    if (bothSkipped && !isPredictionEdge) {
        return 0u;
    }
    // The smaller transform side, in 4-sample units, picks the length (tx_dim_to_filter_length; chroma 4 or 6)
    let previousTransformLog2 = getField(previous, DEBLOCK_UNIT_TRANSFORM_SHIFT, DEBLOCK_UNIT_SIDE_BITS);
    let dimension = min(currentTransformLog2, previousTransformLog2) - DEBLOCK_UNIT_SIZE_LOG2;
    var filterLength = DEBLOCK_LENGTH_14;
    if (dimension == 0u) {
        filterLength = DEBLOCK_LENGTH_4;
    } else if (plane != PLANE_Y) {
        filterLength = DEBLOCK_LENGTH_6;
    } else if (dimension == 1u) {
        filterLength = DEBLOCK_LENGTH_8;
    }
    let level = select(previousLevel, currentLevel, currentLevel != 0u);
    return filterLength | (level << DEBLOCK_DECISION_LEVEL_SHIFT);
}

// update_sharpness: a level's inner limit, outer (block) limit, and high edge variance threshold at bit depth 8
fn deblockGetLimits(level: u32, sharpness: u32) -> vec3u {
    let halvings = select(0u, 1u, sharpness > 0u) + select(0u, 1u, sharpness > DEBLOCK_SHARPNESS_SECOND_HALVING);
    var innerLimit = level >> halvings;
    if (sharpness > 0u) {
        innerLimit = min(innerLimit, DEBLOCK_SHARPNESS_LIMIT_BASE - sharpness);
    }
    innerLimit = max(innerLimit, 1u);
    return vec3u(innerLimit, 2u * (level + 2u) + innerLimit, level >> DEBLOCK_HIGH_VARIANCE_SHIFT);
}

// The low samples of two words, and their high samples
fn deblockLowPair(wordA: u32, wordB: u32) -> vec2i {
    return vec2i(vec2u(wordA, wordB) & vec2u(SAMPLE_HALF_MASK));
}

fn deblockHighPair(wordA: u32, wordB: u32) -> vec2i {
    return vec2i(vec2u(wordA, wordB) >> vec2u(SAMPLE_HALF_BITS));
}

// One word of two samples, the low first
fn deblockPackWord(low: i32, high: i32) -> u32 {
    return u32(low) | (u32(high) << SAMPLE_HALF_BITS);
}

// The samples a vertical edge's filter reaches on two rows, whose words holding the edge's first sample are wordA and wordB:
// word k of a row, from 4 before, holds samples 2k - 1 and 2k
fn deblockGatherVertical(wordA: u32, wordB: u32, filterLength: u32) -> array<vec2i, DEBLOCK_SAMPLES> {
    var samples: array<vec2i, DEBLOCK_SAMPLES>;
    if (filterLength == DEBLOCK_LENGTH_14) {
        let a0 = frames[wordA - 4u];
        let b0 = frames[wordB - 4u];
        let a1 = frames[wordA - 3u];
        let b1 = frames[wordB - 3u];
        let a6 = frames[wordA + 2u];
        let b6 = frames[wordB + 2u];
        let a7 = frames[wordA + 3u];
        let b7 = frames[wordB + 3u];
        samples[0] = deblockHighPair(a0, b0);
        samples[1] = deblockLowPair(a1, b1);
        samples[2] = deblockHighPair(a1, b1);
        samples[11] = deblockLowPair(a6, b6);
        samples[12] = deblockHighPair(a6, b6);
        samples[13] = deblockLowPair(a7, b7);
    }
    if (filterLength >= DEBLOCK_LENGTH_6) {
        let a2 = frames[wordA - 2u];
        let b2 = frames[wordB - 2u];
        let a5 = frames[wordA + 1u];
        let b5 = frames[wordB + 1u];
        samples[3] = deblockLowPair(a2, b2);
        samples[4] = deblockHighPair(a2, b2);
        samples[9] = deblockLowPair(a5, b5);
        samples[10] = deblockHighPair(a5, b5);
    }
    let a3 = frames[wordA - 1u];
    let b3 = frames[wordB - 1u];
    let a4 = frames[wordA];
    let b4 = frames[wordB];
    samples[5] = deblockLowPair(a3, b3);
    samples[6] = deblockHighPair(a3, b3);
    samples[7] = deblockLowPair(a4, b4);
    samples[8] = deblockHighPair(a4, b4);
    return samples;
}

// Writes the words of two rows a vertical edge's filter changes
fn deblockScatterVertical(wordA: u32, wordB: u32, filterLength: u32, samples: array<vec2i, DEBLOCK_SAMPLES>) {
    frames[wordA - 1u] = deblockPackWord(samples[5].x, samples[6].x);
    frames[wordB - 1u] = deblockPackWord(samples[5].y, samples[6].y);
    frames[wordA] = deblockPackWord(samples[7].x, samples[8].x);
    frames[wordB] = deblockPackWord(samples[7].y, samples[8].y);
    if (filterLength >= DEBLOCK_LENGTH_8) {
        frames[wordA - 2u] = deblockPackWord(samples[3].x, samples[4].x);
        frames[wordB - 2u] = deblockPackWord(samples[3].y, samples[4].y);
        frames[wordA + 1u] = deblockPackWord(samples[9].x, samples[10].x);
        frames[wordB + 1u] = deblockPackWord(samples[9].y, samples[10].y);
    }
    if (filterLength == DEBLOCK_LENGTH_14) {
        frames[wordA - 3u] = deblockPackWord(samples[1].x, samples[2].x);
        frames[wordB - 3u] = deblockPackWord(samples[1].y, samples[2].y);
        frames[wordA + 2u] = deblockPackWord(samples[11].x, samples[12].x);
        frames[wordB + 2u] = deblockPackWord(samples[11].y, samples[12].y);
    }
}

// The word of a column pair `offset` rows from the row of word
fn deblockGetRowWord(word: u32, rowWords: u32, offset: i32) -> u32 {
    return u32(i32(word) + offset * i32(rowWords));
}

// The samples a horizontal edge's filter reaches on a column pair, whose word at the edge's first row is word: sample k is row k - 7
fn deblockGatherHorizontal(word: u32, rowWords: u32, filterLength: u32) -> array<vec2i, DEBLOCK_SAMPLES> {
    var samples: array<vec2i, DEBLOCK_SAMPLES>;
    if (filterLength == DEBLOCK_LENGTH_14) {
        let row0 = frames[deblockGetRowWord(word, rowWords, -7)];
        let row1 = frames[deblockGetRowWord(word, rowWords, -6)];
        let row2 = frames[deblockGetRowWord(word, rowWords, -5)];
        let row11 = frames[deblockGetRowWord(word, rowWords, 4)];
        let row12 = frames[deblockGetRowWord(word, rowWords, 5)];
        let row13 = frames[deblockGetRowWord(word, rowWords, 6)];
        samples[0] = deblockLowPair(row0, row0 >> SAMPLE_HALF_BITS);
        samples[1] = deblockLowPair(row1, row1 >> SAMPLE_HALF_BITS);
        samples[2] = deblockLowPair(row2, row2 >> SAMPLE_HALF_BITS);
        samples[11] = deblockLowPair(row11, row11 >> SAMPLE_HALF_BITS);
        samples[12] = deblockLowPair(row12, row12 >> SAMPLE_HALF_BITS);
        samples[13] = deblockLowPair(row13, row13 >> SAMPLE_HALF_BITS);
    }
    if (filterLength >= DEBLOCK_LENGTH_8) {
        let row3 = frames[deblockGetRowWord(word, rowWords, -4)];
        let row10 = frames[deblockGetRowWord(word, rowWords, 3)];
        samples[3] = deblockLowPair(row3, row3 >> SAMPLE_HALF_BITS);
        samples[10] = deblockLowPair(row10, row10 >> SAMPLE_HALF_BITS);
    }
    if (filterLength >= DEBLOCK_LENGTH_6) {
        let row4 = frames[deblockGetRowWord(word, rowWords, -3)];
        let row9 = frames[deblockGetRowWord(word, rowWords, 2)];
        samples[4] = deblockLowPair(row4, row4 >> SAMPLE_HALF_BITS);
        samples[9] = deblockLowPair(row9, row9 >> SAMPLE_HALF_BITS);
    }
    let row5 = frames[deblockGetRowWord(word, rowWords, -2)];
    let row6 = frames[deblockGetRowWord(word, rowWords, -1)];
    let row7 = frames[word];
    let row8 = frames[deblockGetRowWord(word, rowWords, 1)];
    samples[5] = deblockLowPair(row5, row5 >> SAMPLE_HALF_BITS);
    samples[6] = deblockLowPair(row6, row6 >> SAMPLE_HALF_BITS);
    samples[7] = deblockLowPair(row7, row7 >> SAMPLE_HALF_BITS);
    samples[8] = deblockLowPair(row8, row8 >> SAMPLE_HALF_BITS);
    return samples;
}

// Writes the rows of a column pair a horizontal edge's filter changes
fn deblockScatterHorizontal(word: u32, rowWords: u32, filterLength: u32, samples: array<vec2i, DEBLOCK_SAMPLES>) {
    frames[deblockGetRowWord(word, rowWords, -2)] = deblockPackWord(samples[5].x, samples[5].y);
    frames[deblockGetRowWord(word, rowWords, -1)] = deblockPackWord(samples[6].x, samples[6].y);
    frames[word] = deblockPackWord(samples[7].x, samples[7].y);
    frames[deblockGetRowWord(word, rowWords, 1)] = deblockPackWord(samples[8].x, samples[8].y);
    if (filterLength >= DEBLOCK_LENGTH_8) {
        frames[deblockGetRowWord(word, rowWords, -3)] = deblockPackWord(samples[4].x, samples[4].y);
        frames[deblockGetRowWord(word, rowWords, 2)] = deblockPackWord(samples[9].x, samples[9].y);
    }
    if (filterLength == DEBLOCK_LENGTH_14) {
        frames[deblockGetRowWord(word, rowWords, -6)] = deblockPackWord(samples[1].x, samples[1].y);
        frames[deblockGetRowWord(word, rowWords, -5)] = deblockPackWord(samples[2].x, samples[2].y);
        frames[deblockGetRowWord(word, rowWords, -4)] = deblockPackWord(samples[3].x, samples[3].y);
        frames[deblockGetRowWord(word, rowWords, 3)] = deblockPackWord(samples[10].x, samples[10].y);
        frames[deblockGetRowWord(word, rowWords, 4)] = deblockPackWord(samples[11].x, samples[11].y);
        frames[deblockGetRowWord(word, rowWords, 5)] = deblockPackWord(samples[12].x, samples[12].y);
    }
}

// libaom's highbd filters of one edge on two lines: the 4-tap filter (filter_mask2, highbd_filter4), the chroma 6-tap filter
// (filter_mask3_chroma, highbd_filter6), and the 8- and 14-tap luma filters (filter_mask, highbd_filter8, highbd_filter14)
fn deblockFilterLines(samples: array<vec2i, DEBLOCK_SAMPLES>, filterLength: u32, level: u32, sharpness: u32) -> array<vec2i, DEBLOCK_SAMPLES> {
    let depthShift = OUTPUT_BIT_DEPTH - 8u;
    let limits = deblockGetLimits(level, sharpness);
    let innerLimit = vec2i(i32(limits.x << depthShift));
    let outerLimit = vec2i(i32(limits.y << depthShift));
    let varianceThreshold = vec2i(i32(limits.z << depthShift));
    let flatThreshold = vec2i(1 << depthShift);
    let p6 = samples[0];
    let p5 = samples[1];
    let p4 = samples[2];
    let p3 = samples[3];
    let p2 = samples[4];
    let p1 = samples[5];
    let p0 = samples[6];
    let q0 = samples[7];
    let q1 = samples[8];
    let q2 = samples[9];
    let q3 = samples[10];
    let q4 = samples[11];
    let q5 = samples[12];
    let q6 = samples[13];
    var mask = (abs(p1 - p0) <= innerLimit) & (abs(q1 - q0) <= innerLimit)
        & ((abs(p0 - q0) * 2 + (abs(p1 - q1) >> DEBLOCK_HALF)) <= outerLimit);
    if (filterLength >= DEBLOCK_LENGTH_6) {
        mask = mask & (abs(p2 - p1) <= innerLimit) & (abs(q2 - q1) <= innerLimit);
    }
    if (filterLength >= DEBLOCK_LENGTH_8) {
        mask = mask & (abs(p3 - p2) <= innerLimit) & (abs(q3 - q2) <= innerLimit);
    }
    // The 4-tap filter in signed 8-bit arithmetic scaled to the bit depth; with the mask off it changes nothing
    let offset = vec2i(DEBLOCK_SIGNED_OFFSET << depthShift);
    let lowest = -offset;
    let highest = offset - vec2i(1);
    let signedP1 = p1 - offset;
    let signedP0 = p0 - offset;
    let signedQ0 = q0 - offset;
    let signedQ1 = q1 - offset;
    let highVariance = (abs(p1 - p0) > varianceThreshold) | (abs(q1 - q0) > varianceThreshold);
    let outerTaps = select(vec2i(0), clamp(signedP1 - signedQ1, lowest, highest), highVariance);
    let filterValue = select(vec2i(0), clamp(outerTaps + 3 * (signedQ0 - signedP0), lowest, highest), mask);
    let filter1 = clamp(filterValue + 4, lowest, highest) >> DEBLOCK_EIGHTHS;
    let filter2 = clamp(filterValue + 3, lowest, highest) >> DEBLOCK_EIGHTHS;
    let outerAdjustment = select((filter1 + 1) >> DEBLOCK_HALF, vec2i(0), highVariance);
    var filtered = samples;
    filtered[5] = clamp(signedP1 + outerAdjustment, lowest, highest) + offset;
    filtered[6] = clamp(signedP0 + filter2, lowest, highest) + offset;
    filtered[7] = clamp(signedQ0 - filter1, lowest, highest) + offset;
    filtered[8] = clamp(signedQ1 - outerAdjustment, lowest, highest) + offset;
    if (filterLength == DEBLOCK_LENGTH_4) {
        return filtered;
    }
    var flat = (abs(p1 - p0) <= flatThreshold) & (abs(q1 - q0) <= flatThreshold)
        & (abs(p2 - p0) <= flatThreshold) & (abs(q2 - q0) <= flatThreshold) & mask;
    if (filterLength == DEBLOCK_LENGTH_6) {
        // The 5-tap filter [1, 2, 2, 2, 1]
        filtered[5] = select(filtered[5], (p2 * 3 + p1 * 2 + p0 * 2 + q0 + 4) >> DEBLOCK_EIGHTHS, flat);
        filtered[6] = select(filtered[6], (p2 + p1 * 2 + p0 * 2 + q0 * 2 + q1 + 4) >> DEBLOCK_EIGHTHS, flat);
        filtered[7] = select(filtered[7], (p1 + p0 * 2 + q0 * 2 + q1 * 2 + q2 + 4) >> DEBLOCK_EIGHTHS, flat);
        filtered[8] = select(filtered[8], (p0 + q0 * 2 + q1 * 2 + q2 * 3 + 4) >> DEBLOCK_EIGHTHS, flat);
        return filtered;
    }
    flat = flat & (abs(p3 - p0) <= flatThreshold) & (abs(q3 - q0) <= flatThreshold);
    // The 7-tap filter [1, 1, 1, 2, 1, 1, 1]
    filtered[4] = select(p2, (p3 * 3 + p2 * 2 + p1 + p0 + q0 + 4) >> DEBLOCK_EIGHTHS, flat);
    filtered[5] = select(filtered[5], (p3 * 2 + p2 + p1 * 2 + p0 + q0 + q1 + 4) >> DEBLOCK_EIGHTHS, flat);
    filtered[6] = select(filtered[6], (p3 + p2 + p1 + p0 * 2 + q0 + q1 + q2 + 4) >> DEBLOCK_EIGHTHS, flat);
    filtered[7] = select(filtered[7], (p2 + p1 + p0 + q0 * 2 + q1 + q2 + q3 + 4) >> DEBLOCK_EIGHTHS, flat);
    filtered[8] = select(filtered[8], (p1 + p0 + q0 + q1 * 2 + q2 + q3 * 2 + 4) >> DEBLOCK_EIGHTHS, flat);
    filtered[9] = select(q2, (p0 + q0 + q1 + q2 * 2 + q3 * 3 + 4) >> DEBLOCK_EIGHTHS, flat);
    if (filterLength == DEBLOCK_LENGTH_8) {
        return filtered;
    }
    // The 13-tap filter [1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1] where both sides are flat out to the 7th sample
    let flatOuter = (abs(p4 - p0) <= flatThreshold) & (abs(q4 - q0) <= flatThreshold) & (abs(p5 - p0) <= flatThreshold)
        & (abs(q5 - q0) <= flatThreshold) & (abs(p6 - p0) <= flatThreshold) & (abs(q6 - q0) <= flatThreshold) & flat;
    filtered[1] = select(p5, (p6 * 7 + p5 * 2 + p4 * 2 + p3 + p2 + p1 + p0 + q0 + 8) >> DEBLOCK_SIXTEENTHS, flatOuter);
    filtered[2] = select(p4, (p6 * 5 + p5 * 2 + p4 * 2 + p3 * 2 + p2 + p1 + p0 + q0 + q1 + 8) >> DEBLOCK_SIXTEENTHS, flatOuter);
    filtered[3] = select(p3, (p6 * 4 + p5 + p4 * 2 + p3 * 2 + p2 * 2 + p1 + p0 + q0 + q1 + q2 + 8) >> DEBLOCK_SIXTEENTHS, flatOuter);
    filtered[4] = select(filtered[4],
        (p6 * 3 + p5 + p4 + p3 * 2 + p2 * 2 + p1 * 2 + p0 + q0 + q1 + q2 + q3 + 8) >> DEBLOCK_SIXTEENTHS, flatOuter);
    filtered[5] = select(filtered[5],
        (p6 * 2 + p5 + p4 + p3 + p2 * 2 + p1 * 2 + p0 * 2 + q0 + q1 + q2 + q3 + q4 + 8) >> DEBLOCK_SIXTEENTHS, flatOuter);
    filtered[6] = select(filtered[6],
        (p6 + p5 + p4 + p3 + p2 + p1 * 2 + p0 * 2 + q0 * 2 + q1 + q2 + q3 + q4 + q5 + 8) >> DEBLOCK_SIXTEENTHS, flatOuter);
    filtered[7] = select(filtered[7],
        (p5 + p4 + p3 + p2 + p1 + p0 * 2 + q0 * 2 + q1 * 2 + q2 + q3 + q4 + q5 + q6 + 8) >> DEBLOCK_SIXTEENTHS, flatOuter);
    filtered[8] = select(filtered[8],
        (p4 + p3 + p2 + p1 + p0 + q0 * 2 + q1 * 2 + q2 * 2 + q3 + q4 + q5 + q6 * 2 + 8) >> DEBLOCK_SIXTEENTHS, flatOuter);
    filtered[9] = select(filtered[9],
        (p3 + p2 + p1 + p0 + q0 + q1 * 2 + q2 * 2 + q3 * 2 + q4 + q5 + q6 * 3 + 8) >> DEBLOCK_SIXTEENTHS, flatOuter);
    filtered[10] = select(q3, (p2 + p1 + p0 + q0 + q1 + q2 * 2 + q3 * 2 + q4 * 2 + q5 + q6 * 4 + 8) >> DEBLOCK_SIXTEENTHS, flatOuter);
    filtered[11] = select(q4, (p1 + p0 + q0 + q1 + q2 + q3 * 2 + q4 * 2 + q5 * 2 + q6 * 5 + 8) >> DEBLOCK_SIXTEENTHS, flatOuter);
    filtered[12] = select(q5, (p0 + q0 + q1 + q2 + q3 + q4 * 2 + q5 * 2 + q6 * 7 + 8) >> DEBLOCK_SIXTEENTHS, flatOuter);
    return filtered;
}

// Filters the vertical (isVertical) or horizontal edges of the workgroup's area of plane workgroup.z in the target buffer, in place.
// The edge axis crosses the pass's edges, x for vertical edges, and the line axis runs along them.
fn deblockRunPass(workgroup: vec3u, lane: u32, isVertical: bool) {
    let plane = workgroup.z;
    let subsamplingX = filtersGetSubsamplingX(plane);
    let subsamplingY = filtersGetSubsamplingY(plane);
    let areaX = (workgroup.x << FILTERS_AREA_SIZE_LOG2) >> subsamplingX;
    let areaY = (workgroup.y << FILTERS_AREA_SIZE_LOG2) >> subsamplingY;
    if (lane == 0u) {
        deblockControl = select(0u, 1u, deblockIsAreaFiltered(plane, areaX, areaY));
    }
    if (workgroupUniformLoad(&deblockControl) == 0u) {
        return;
    }
    let frameWidth = getFramePlaneWidth(plane);
    let frameHeight = getFramePlaneHeight(plane);
    let edgeOrigin = select(areaY, areaX, isVertical);
    let lineOrigin = select(areaX, areaY, isVertical);
    let edgeLimit = select(frameHeight, frameWidth, isVertical);
    let lineLimit = select(frameWidth, frameHeight, isVertical);
    let edgeUnitsLog2 = DEBLOCK_AREA_UNITS_LOG2 - select(subsamplingY, subsamplingX, isVertical);
    let lineUnitsLog2 = DEBLOCK_AREA_UNITS_LOG2 - select(subsamplingX, subsamplingY, isVertical);
    let edgeUnits = 1u << edgeUnitsLog2;
    let lineUnits = 1u << lineUnitsLog2;
    // Every unit inside the frame, and the one before the area's first edge
    for (var slot = lane; slot < DEBLOCK_UNIT_COUNT; slot += FILTERS_WORKGROUP_SIZE) {
        let lineUnit = slot / DEBLOCK_UNIT_SLOTS;
        let edgeSlot = slot - lineUnit * DEBLOCK_UNIT_SLOTS;
        let linePosition = lineOrigin + (lineUnit << DEBLOCK_UNIT_SIZE_LOG2);
        let unitEnd = edgeOrigin + (edgeSlot << DEBLOCK_UNIT_SIZE_LOG2);
        if (lineUnit >= lineUnits || edgeSlot > edgeUnits || linePosition >= lineLimit || unitEnd == 0u) {
            continue;
        }
        let unitPosition = unitEnd - (1u << DEBLOCK_UNIT_SIZE_LOG2);
        if (unitPosition >= edgeLimit) {
            continue;
        }
        let x = select(linePosition, unitPosition, isVertical);
        let y = select(unitPosition, linePosition, isVertical);
        deblockUnits[slot] = deblockReadUnit(plane, x, y, isVertical, subsamplingX, subsamplingY);
    }
    workgroupBarrier();
    let sharpness = getField(readRecordWord(RECORD_HEADER_DEBLOCK), RECORD_DEBLOCK_SHARPNESS_SHIFT, RECORD_DEBLOCK_SHARPNESS_BITS);
    let frameBuffer = readRecordWord(RECORD_HEADER_TARGET_BUFFER);
    let rowWords = getStorePlaneWidth(plane) >> SAMPLE_PAIR_SHIFT;
    // Two lines per invocation, four lines per unit
    let linePairsLog2 = lineUnitsLog2 + 1u;
    let invocationCount = 1u << (edgeUnitsLog2 + linePairsLog2);
    for (var invocation = lane; invocation < invocationCount; invocation += FILTERS_WORKGROUP_SIZE) {
        // Consecutive invocations take adjacent words: the next edge of a row pair, or the next column pair of an edge
        var edgeUnit = invocation & (edgeUnits - 1u);
        var linePair = invocation >> edgeUnitsLog2;
        if (!isVertical) {
            linePair = invocation & ((1u << linePairsLog2) - 1u);
            edgeUnit = invocation >> linePairsLog2;
        }
        let edgePosition = edgeOrigin + (edgeUnit << DEBLOCK_UNIT_SIZE_LOG2);
        let lineUnit = linePair >> 1u;
        if (edgePosition == 0u || edgePosition >= edgeLimit || lineOrigin + (lineUnit << DEBLOCK_UNIT_SIZE_LOG2) >= lineLimit) {
            continue;
        }
        let decision = deblockDecide(lineUnit, edgeUnit, edgePosition, plane);
        if (decision == 0u) {
            continue;
        }
        let filterLength = decision & DEBLOCK_DECISION_LENGTH_MASK;
        let linePosition = lineOrigin + (linePair << 1u);
        let x = select(linePosition, edgePosition, isVertical);
        let y = select(edgePosition, linePosition, isVertical);
        let word = getStoreWordIndex(frameBuffer, plane, x, y);
        var samples: array<vec2i, DEBLOCK_SAMPLES>;
        if (isVertical) {
            samples = deblockGatherVertical(word, word + rowWords, filterLength);
        } else {
            samples = deblockGatherHorizontal(word, rowWords, filterLength);
        }
        let filtered = deblockFilterLines(samples, filterLength, decision >> DEBLOCK_DECISION_LEVEL_SHIFT, sharpness);
        if (isVertical) {
            deblockScatterVertical(word, word + rowWords, filterLength, filtered);
        } else {
            deblockScatterHorizontal(word, rowWords, filterLength, filtered);
        }
    }
}

// The vertical edges of the 64x64 luma area (x, y) of plane z, in place in the target buffer
fn deblockVerticalEdges(workgroup: vec3u, lane: u32) {
    deblockRunPass(workgroup, lane, true);
}

// The horizontal edges of the 64x64 luma area (x, y) of plane z, in place in the target buffer, after every vertical edge
fn deblockHorizontalEdges(workgroup: vec3u, lane: u32) {
    deblockRunPass(workgroup, lane, false);
}

// Tables: the family's part of the frame data buffer's tables area, which filtersLoadTables writes once per session

// av1_resize_filter_normative's 64 phases of 8 taps, two signed taps per word
const FILTERS_TABLE_UPSCALE: u32 = 0u;
const FILTERS_TABLE_UPSCALE_WORDS_PER_PHASE: u32 = 4u;
const FILTERS_TABLE_UPSCALE_WORDS: u32 = 256u;
// av1_x_by_xplus1: the self-guided filter's 256 blend factors
const FILTERS_TABLE_BLEND: u32 = 256u;
const FILTERS_TABLE_BLEND_WORDS: u32 = 256u;
// av1_sgr_params: per set, the two radii (2 bits each) and their strengths (12 bits each, 0 for a disabled radius)
const FILTERS_TABLE_SGR_SETS: u32 = 512u;
const FILTERS_TABLE_SGR_SET_COUNT: u32 = 16u;
const FILTERS_TABLE_SGR_RADIUS_BITS: u32 = 2u;
const FILTERS_TABLE_SGR_RADIUS_1_SHIFT: u32 = 2u;
const FILTERS_TABLE_SGR_STRENGTH_0_SHIFT: u32 = 4u;
const FILTERS_TABLE_SGR_STRENGTH_1_SHIFT: u32 = 16u;
const FILTERS_TABLE_SGR_STRENGTH_BITS: u32 = 12u;
const FILTERS_TABLE_USED_WORDS: u32 = 528u;

// av1_resize_filter_normative (av1/common/resize.c)
const SUPERRES_FILTER_TAPS: array<i32, 512> = array<i32, 512>(
    0, 0, 0, 128, 0, 0, 0, 0,
    0, 0, -1, 128, 2, -1, 0, 0,
    0, 1, -3, 127, 4, -2, 1, 0,
    0, 1, -4, 127, 6, -3, 1, 0,
    0, 2, -6, 126, 8, -3, 1, 0,
    0, 2, -7, 125, 11, -4, 1, 0,
    -1, 2, -8, 125, 13, -5, 2, 0,
    -1, 3, -9, 124, 15, -6, 2, 0,
    -1, 3, -10, 123, 18, -6, 2, -1,
    -1, 3, -11, 122, 20, -7, 3, -1,
    -1, 4, -12, 121, 22, -8, 3, -1,
    -1, 4, -13, 120, 25, -9, 3, -1,
    -1, 4, -14, 118, 28, -9, 3, -1,
    -1, 4, -15, 117, 30, -10, 4, -1,
    -1, 5, -16, 116, 32, -11, 4, -1,
    -1, 5, -16, 114, 35, -12, 4, -1,
    -1, 5, -17, 112, 38, -12, 4, -1,
    -1, 5, -18, 111, 40, -13, 5, -1,
    -1, 5, -18, 109, 43, -14, 5, -1,
    -1, 6, -19, 107, 45, -14, 5, -1,
    -1, 6, -19, 105, 48, -15, 5, -1,
    -1, 6, -19, 103, 51, -16, 5, -1,
    -1, 6, -20, 101, 53, -16, 6, -1,
    -1, 6, -20, 99, 56, -17, 6, -1,
    -1, 6, -20, 97, 58, -17, 6, -1,
    -1, 6, -20, 95, 61, -18, 6, -1,
    -2, 7, -20, 93, 64, -18, 6, -2,
    -2, 7, -20, 91, 66, -19, 6, -1,
    -2, 7, -20, 88, 69, -19, 6, -1,
    -2, 7, -20, 86, 71, -19, 6, -1,
    -2, 7, -20, 84, 74, -20, 7, -2,
    -2, 7, -20, 81, 76, -20, 7, -1,
    -2, 7, -20, 79, 79, -20, 7, -2,
    -1, 7, -20, 76, 81, -20, 7, -2,
    -2, 7, -20, 74, 84, -20, 7, -2,
    -1, 6, -19, 71, 86, -20, 7, -2,
    -1, 6, -19, 69, 88, -20, 7, -2,
    -1, 6, -19, 66, 91, -20, 7, -2,
    -2, 6, -18, 64, 93, -20, 7, -2,
    -1, 6, -18, 61, 95, -20, 6, -1,
    -1, 6, -17, 58, 97, -20, 6, -1,
    -1, 6, -17, 56, 99, -20, 6, -1,
    -1, 6, -16, 53, 101, -20, 6, -1,
    -1, 5, -16, 51, 103, -19, 6, -1,
    -1, 5, -15, 48, 105, -19, 6, -1,
    -1, 5, -14, 45, 107, -19, 6, -1,
    -1, 5, -14, 43, 109, -18, 5, -1,
    -1, 5, -13, 40, 111, -18, 5, -1,
    -1, 4, -12, 38, 112, -17, 5, -1,
    -1, 4, -12, 35, 114, -16, 5, -1,
    -1, 4, -11, 32, 116, -16, 5, -1,
    -1, 4, -10, 30, 117, -15, 4, -1,
    -1, 3, -9, 28, 118, -14, 4, -1,
    -1, 3, -9, 25, 120, -13, 4, -1,
    -1, 3, -8, 22, 121, -12, 4, -1,
    -1, 3, -7, 20, 122, -11, 3, -1,
    -1, 2, -6, 18, 123, -10, 3, -1,
    0, 2, -6, 15, 124, -9, 3, -1,
    0, 2, -5, 13, 125, -8, 2, -1,
    0, 1, -4, 11, 125, -7, 2, 0,
    0, 1, -3, 8, 126, -6, 2, 0,
    0, 1, -3, 6, 127, -4, 1, 0,
    0, 1, -2, 4, 127, -3, 1, 0,
    0, 0, -1, 2, 128, -1, 0, 0
);

// av1_x_by_xplus1 (av1/common/restoration.c)
const RESTORATION_BLEND_FACTORS: array<u32, 256> = array<u32, 256>(
    1u, 128u, 171u, 192u, 205u, 213u, 219u, 224u, 228u, 230u, 233u, 235u, 236u, 238u, 239u, 240u,
    241u, 242u, 243u, 243u, 244u, 244u, 245u, 245u, 246u, 246u, 247u, 247u, 247u, 247u, 248u, 248u,
    248u, 248u, 249u, 249u, 249u, 249u, 249u, 250u, 250u, 250u, 250u, 250u, 250u, 250u, 251u, 251u,
    251u, 251u, 251u, 251u, 251u, 251u, 251u, 251u, 252u, 252u, 252u, 252u, 252u, 252u, 252u, 252u,
    252u, 252u, 252u, 252u, 252u, 252u, 252u, 252u, 252u, 253u, 253u, 253u, 253u, 253u, 253u, 253u,
    253u, 253u, 253u, 253u, 253u, 253u, 253u, 253u, 253u, 253u, 253u, 253u, 253u, 253u, 253u, 253u,
    253u, 253u, 253u, 253u, 253u, 253u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u,
    254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u,
    254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u,
    254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u,
    254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 254u, 255u, 255u, 255u, 255u, 255u, 255u,
    255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u,
    255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u,
    255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u,
    255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u,
    255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 255u, 256u
);

// av1_sgr_params (av1/common/restoration.c): radius 0, radius 1, strength 0, strength 1 per set, a strength of -1 disabled
const RESTORATION_SGR_PARAMETERS: array<i32, 64> = array<i32, 64>(
    2, 1, 140, 3236, 2, 1, 112, 2158, 2, 1, 93, 1618, 2, 1, 80, 1438,
    2, 1, 70, 1295, 2, 1, 58, 1177, 2, 1, 47, 1079, 2, 1, 37, 996,
    2, 1, 30, 925, 2, 1, 25, 863, 0, 1, -1, 2589, 0, 1, -1, 1618,
    0, 1, -1, 1177, 0, 1, -1, 925, 2, 0, 56, -1, 2, 0, 22, -1
);

// The first word of the family's tables
fn filtersGetTablesOffset() -> u32 {
    return getTablesOffset() + FILTERS_TABLES_OFFSET;
}

// Writes the family's tables into its tables area: one word per invocation of workgroups 0 to 8
fn filtersLoadTables(workgroupIndex: u32, lane: u32) {
    let index = workgroupIndex * FILTERS_WORKGROUP_SIZE + lane;
    if (index >= FILTERS_TABLE_USED_WORDS) {
        return;
    }
    var word = 0u;
    if (index < FILTERS_TABLE_BLEND) {
        let low = SUPERRES_FILTER_TAPS[index * 2u];
        let high = SUPERRES_FILTER_TAPS[index * 2u + 1u];
        word = (u32(low) & SAMPLE_HALF_MASK) | (u32(high) << SAMPLE_HALF_BITS);
    } else if (index < FILTERS_TABLE_SGR_SETS) {
        word = RESTORATION_BLEND_FACTORS[index - FILTERS_TABLE_BLEND];
    } else {
        let first = (index - FILTERS_TABLE_SGR_SETS) * 4u;
        let strengthMask = (1u << FILTERS_TABLE_SGR_STRENGTH_BITS) - 1u;
        word = u32(RESTORATION_SGR_PARAMETERS[first]) | (u32(RESTORATION_SGR_PARAMETERS[first + 1u]) << FILTERS_TABLE_SGR_RADIUS_1_SHIFT)
            | ((u32(max(RESTORATION_SGR_PARAMETERS[first + 2u], 0)) & strengthMask) << FILTERS_TABLE_SGR_STRENGTH_0_SHIFT)
            | ((u32(max(RESTORATION_SGR_PARAMETERS[first + 3u], 0)) & strengthMask) << FILTERS_TABLE_SGR_STRENGTH_1_SHIFT);
    }
    frameData[filtersGetTablesOffset() + index] = word;
}

// Super-resolution: libaom's av1_upscale_normative_rows (av1/common/resize.c) with av1_highbd_convolve_horiz_rs_c
// (av1/common/convolve.c), whose 8-bit twin computes the same. Each tile column continues the previous one's position and only the
// frame's edges pad, so the tile split changes no sample: an output sample's source position and phase are one formula across the
// frame, clamped to the frame aligned to 8 samples (mi_cols), which the last tile column pads from.

const SUPERRES_SCALE_BITS: u32 = 14u;
const SUPERRES_SCALE_MASK: u32 = 16383u;
const SUPERRES_EXTRA_BITS: u32 = 8u;
const SUPERRES_EXTRA_OFFSET: i32 = 128;
const SUPERRES_TAPS: u32 = 8u;
// The convolution starts 4 samples before the position: libaom passes the source from 1 before, and steps 3 taps back
const SUPERRES_TAP_OFFSET: i32 = 4;
const SUPERRES_FILTER_BITS: u32 = 7u;
const SUPERRES_ROW_SAMPLES: u32 = 256u;
const SUPERRES_SAMPLES_PER_INVOCATION: u32 = 4u;
// Rows per workgroup: av1.wgsl's applySuperres grid has ceil(stream.height / 16) rows of workgroups (one per row works too: the
// workgroups past the plane return at once)
const SUPERRES_ROWS_PER_WORKGROUP: u32 = 16u;

// av1_get_upscale_convolve_step and get_upscale_convolve_x0: a plane's step (x) and first position (y), in 1/16384 samples
fn superresGetSteps(downscaledWidth: u32, upscaledWidth: u32) -> vec2u {
    let step = ((downscaledWidth << SUPERRES_SCALE_BITS) + upscaledWidth / 2u) / upscaledWidth;
    let stepError = i32(upscaledWidth * step) - i32(downscaledWidth << SUPERRES_SCALE_BITS);
    let first = (-(i32(upscaledWidth - downscaledWidth) << (SUPERRES_SCALE_BITS - 1u)) + i32(upscaledWidth / 2u)) / i32(upscaledWidth)
        + SUPERRES_EXTRA_OFFSET - stepError / 2;
    return vec2u(step, u32(first) & SUPERRES_SCALE_MASK);
}

// The upscaled sample at output position `position` of a source row whose first word is rowWord, the source's columns clamped
// to [0, lastColumn]
fn superresUpscaleSample(rowWord: u32, position: u32, lastColumn: i32) -> u32 {
    let firstColumn = i32(position >> SUPERRES_SCALE_BITS) - SUPERRES_TAP_OFFSET;
    let phaseWord = filtersGetTablesOffset() + FILTERS_TABLE_UPSCALE
        + ((position & SUPERRES_SCALE_MASK) >> SUPERRES_EXTRA_BITS) * FILTERS_TABLE_UPSCALE_WORDS_PER_PHASE;
    var sum = 0;
    for (var tap = 0u; tap < SUPERRES_TAPS; tap += 1u) {
        let column = u32(clamp(firstColumn + i32(tap), 0, lastColumn));
        let sample = i32((frames[rowWord + (column >> SAMPLE_PAIR_SHIFT)] >> ((column & 1u) * SAMPLE_HALF_BITS)) & SAMPLE_HALF_MASK);
        let taps = frameData[phaseWord + (tap >> 1u)];
        sum += sample * getSignedField(taps, (tap & 1u) * SAMPLE_HALF_BITS, SAMPLE_HALF_BITS);
    }
    return clipSample((sum + (1 << (SUPERRES_FILTER_BITS - 1u))) >> SUPERRES_FILTER_BITS, OUTPUT_BIT_DEPTH);
}

// Whether the frame upscales: its coded width differs from its upscaled width (av1_superres_scaled)
fn superresIsScaled() -> bool {
    return readRecordWord(RECORD_HEADER_FRAME_WIDTH) != readRecordWord(RECORD_HEADER_UPSCALED_WIDTH);
}

// The last source column the upscaling reads: the plane aligned to 8 luma samples
fn superresGetLastColumn(plane: u32) -> i32 {
    return i32((readRecordWord(RECORD_HEADER_MI_COLUMNS) << MI_SIZE_LOG2) >> filtersGetSubsamplingX(plane)) - 1;
}

// Upscales 256 output samples from x * 256 of rows y * 16 to y * 16 + 15 of plane z, from the super-resolution source to its
// target: four per invocation and row
fn superresUpscaleRow(workgroup: vec3u, lane: u32) {
    let plane = workgroup.z;
    if (!isDecodingFrame() || readRecordWord(RECORD_HEADER_SUPERRES_SOURCE) == RECORD_MISSING || !filtersHasPlane(plane)) {
        return;
    }
    let firstRow = workgroup.y * SUPERRES_ROWS_PER_WORKGROUP;
    let planeHeight = getFramePlaneHeight(plane);
    let upscaledWidth = getUpscaledPlaneWidth(plane);
    let firstColumn = workgroup.x * SUPERRES_ROW_SAMPLES + lane * SUPERRES_SAMPLES_PER_INVOCATION;
    if (firstRow >= planeHeight || firstColumn >= upscaledWidth) {
        return;
    }
    let steps = superresGetSteps(getFramePlaneWidth(plane), upscaledWidth);
    let lastColumn = superresGetLastColumn(plane);
    let rowWords = getStorePlaneWidth(plane) >> SAMPLE_PAIR_SHIFT;
    let firstSourceRow = getStoreWordIndex(readRecordWord(RECORD_HEADER_SUPERRES_SOURCE), plane, 0u, firstRow);
    let firstTargetRow = getStoreWordIndex(readRecordWord(RECORD_HEADER_SUPERRES_TARGET), plane, 0u, firstRow);
    let sampleCount = min(SUPERRES_ROWS_PER_WORKGROUP, planeHeight - firstRow) * SUPERRES_SAMPLES_PER_INVOCATION;
    var word = 0u;
    // Every sample of the rows through one call site
    for (var index = 0u; index < sampleCount; index += 1u) {
        let rowOffset = (index / SUPERRES_SAMPLES_PER_INVOCATION) * rowWords;
        let x = firstColumn + (index & (SUPERRES_SAMPLES_PER_INVOCATION - 1u));
        word |= superresUpscaleSample(firstSourceRow + rowOffset, steps.y + x * steps.x, lastColumn) << ((x & 1u) * SAMPLE_HALF_BITS);
        if ((x & 1u) == 1u) {
            if (x - 1u < upscaledWidth) {
                frames[firstTargetRow + rowOffset + ((x - 1u) >> SAMPLE_PAIR_SHIFT)] = word;
            }
            word = 0u;
        }
    }
}

// Loop restoration stripe boundaries: libaom's av1_loop_restoration_save_boundary_lines(.., 0) (save_deblock_boundary_lines of
// av1/common/restoration.c): for each 64-row stripe, offset 8 rows up, the two deblocked rows above it and the two below it, the
// second below repeating the first at the plane's last row, upscaled when super-resolution runs. The frame's first stripe has no rows
// above and its last none below: loop restoration extends the frame there instead.

// Rows of luma per stripe offset (RESTORATION_UNIT_OFFSET), the samples a workgroup saves per row, and the rows per side
const RESTORATION_STRIPE_OFFSET: u32 = 8u;
const RESTORATION_STRIPE_HEIGHT_LOG2: u32 = 6u;
const RESTORATION_BOUNDARY_SPAN: u32 = 256u;
const RESTORATION_BOUNDARY_SAMPLES_PER_INVOCATION: u32 = 4u;
const RESTORATION_CONTEXT_ROWS: u32 = 2u;
// The restoration header's types (libaom's RestorationType)
const RESTORATION_TYPE_NONE: u32 = 0u;
const RESTORATION_TYPE_WIENER: u32 = 1u;
const RESTORATION_TYPE_SGRPROJ: u32 = 2u;

// The word of saved row `slot` (0 and 1 above the stripe, 2 and 3 below it) of a stripe of a plane holding sample x
fn restorationGetBoundaryWord(plane: u32, stripe: u32, slot: u32, x: u32) -> u32 {
    let stripes = (stream.height + RESTORATION_STRIPE_HEIGHT - 1u) / RESTORATION_STRIPE_HEIGHT + 2u;
    let rowWords = stream.width >> SAMPLE_PAIR_SHIFT;
    return getRestorationBoundaryOffset() + ((plane * stripes + stripe) * RESTORATION_BOUNDARY_ROWS + slot) * rowWords
        + (x >> SAMPLE_PAIR_SHIFT);
}

// A plane's restoration header word
fn restorationReadPlaneWord(plane: u32, word: u32) -> u32 {
    return readRecordWord(RECORD_HEADER_RESTORATION + plane * RECORD_RESTORATION_WORDS + word);
}

// Whether the loop restoration pass filters a plane
fn restorationIsPlaneRestored(plane: u32) -> bool {
    return isDecodingFrame() && readRecordWord(RECORD_HEADER_RESTORATION_SOURCE) != RECORD_MISSING && filtersHasPlane(plane)
        && restorationReadPlaneWord(plane, RECORD_RESTORATION_TYPE) != RESTORATION_TYPE_NONE;
}

// A plane's stripe height and offset, in its rows
fn restorationGetStripeGeometry(plane: u32) -> vec2u {
    let subsamplingY = filtersGetSubsamplingY(plane);
    return vec2u(RESTORATION_STRIPE_HEIGHT >> subsamplingY, RESTORATION_STRIPE_OFFSET >> subsamplingY);
}

// Saves the rows around stripe y of plane z, 256 samples from x * 256, from the deblocked target buffer: four per invocation and row
fn restorationSaveBoundaries(workgroup: vec3u, lane: u32) {
    let plane = workgroup.z;
    if (!restorationIsPlaneRestored(plane)) {
        return;
    }
    let stripeGeometry = restorationGetStripeGeometry(plane);
    let planeHeight = getFramePlaneHeight(plane);
    let stripe = workgroup.y;
    let stripeStart = u32(max(i32(stripe * stripeGeometry.x) - i32(stripeGeometry.y), 0));
    if (stripeStart >= planeHeight) {
        return;
    }
    let stripeEnd = min((stripe + 1u) * stripeGeometry.x - stripeGeometry.y, planeHeight);
    let scaled = superresIsScaled();
    let width = select(getFramePlaneWidth(plane), getUpscaledPlaneWidth(plane), scaled);
    let firstColumn = workgroup.x * RESTORATION_BOUNDARY_SPAN + lane * RESTORATION_BOUNDARY_SAMPLES_PER_INVOCATION;
    if (firstColumn >= width) {
        return;
    }
    let deblocked = readRecordWord(RECORD_HEADER_TARGET_BUFFER);
    let steps = superresGetSteps(getFramePlaneWidth(plane), getUpscaledPlaneWidth(plane));
    let lastColumn = superresGetLastColumn(plane);
    var word = 0u;
    // Four samples of each of the four rows through one call site
    for (var index = 0u; index < RESTORATION_BOUNDARY_ROWS * RESTORATION_BOUNDARY_SAMPLES_PER_INVOCATION; index += 1u) {
        let slot = index / RESTORATION_BOUNDARY_SAMPLES_PER_INVOCATION;
        let x = firstColumn + (index & (RESTORATION_BOUNDARY_SAMPLES_PER_INVOCATION - 1u));
        let isAbove = slot < RESTORATION_CONTEXT_ROWS;
        if ((isAbove && stripe == 0u) || (!isAbove && stripeEnd >= planeHeight)) {
            continue;
        }
        var row = stripeStart - RESTORATION_CONTEXT_ROWS + slot;
        if (!isAbove) {
            row = min(stripeEnd + slot - RESTORATION_CONTEXT_ROWS, planeHeight - 1u);
        }
        let rowWord = getStoreWordIndex(deblocked, plane, 0u, row);
        var sample: u32;
        if (scaled) {
            sample = superresUpscaleSample(rowWord, steps.y + x * steps.x, lastColumn);
        } else {
            sample = (frames[rowWord + (x >> SAMPLE_PAIR_SHIFT)] >> ((x & 1u) * SAMPLE_HALF_BITS)) & SAMPLE_HALF_MASK;
        }
        word |= sample << ((x & 1u) * SAMPLE_HALF_BITS);
        if ((x & 1u) == 1u) {
            frameData[restorationGetBoundaryWord(plane, stripe, slot, x)] = word;
            word = 0u;
        }
    }
}

// CDEF: libaom's av1_cdef_frame per 64x64 filter block (cdef_fb_col, av1_cdef_filter_fb, cdef_find_dir_c, and
// cdef_filter_block_internal of av1/common/cdef.c and cdef_block.c). Its input is the deblocked frame everywhere (libaom's line and
// column buffers keep the unfiltered neighbors), with CDEF_VERY_LARGE outside the frame aligned to 8 luma samples.
// A workgroup takes one filter block of plane z: it reads which 8x8 blocks have residual and the source around the block into
// workgroup memory; each invocation finds one 8x8 block's direction from the luma in the frame store, then filters sample pairs.

// Samples outside the frame (CDEF_VERY_LARGE, av1/common/cdef_block.h)
const CDEF_VERY_LARGE: i32 = 16384;
// The tile: the filter block's samples and two around them, a sample pair per word; chroma-wide areas use 18 words of each row
const CDEF_BORDER: u32 = 2u;
const CDEF_TILE_ROW_WORDS: u32 = 34u;
const CDEF_TILE_ROW_SAMPLES: u32 = 68u;
const CDEF_NARROW_TILE_ROW_WORDS: u32 = 18u;
const CDEF_TILE_WORDS: u32 = 2312u;
// Tile words an invocation loads per round, and the pair outside the frame
const CDEF_TILE_BATCH: u32 = 4u;
const CDEF_OUTSIDE_PAIR: u32 = 0x40004000u;
// Masks a tap sample for the clipping maximum: CDEF_VERY_LARGE becomes 0, every sample stays
const CDEF_MAXIMUM_MASK: i32 = 0x3FFF;
// The 8x8 luma blocks of a filter block
const CDEF_BLOCK_SIZE_LOG2: u32 = 3u;
const CDEF_BLOCKS_PER_ROW_LOG2: u32 = 3u;
const CDEF_BLOCKS: u32 = 64u;
const CDEF_DIRECTIONS: u32 = 8u;
// A block entry's first word: the block filters, its primary taps' damping shift, and its primary strength (adjusted by its variance
// on luma); its other words hold the primary and the two secondary tap offset pairs (cdefPackOffsets)
const CDEF_BLOCK_FILTERS: u32 = 1u;
const CDEF_BLOCK_PRIMARY_SHIFT_SHIFT: u32 = 1u;
const CDEF_BLOCK_PRIMARY_SHIFT_BITS: u32 = 4u;
const CDEF_BLOCK_STRENGTH_SHIFT: u32 = 5u;
// The workgroup's mode: nothing to write, copy the source, or filter
const CDEF_MODE_NONE: u32 = 0u;
const CDEF_MODE_COPY: u32 = 1u;
const CDEF_MODE_FILTER: u32 = 2u;
// cdef_find_dir_c: costs are 840 / line length times the squared line sums, the variance a 1/1024 of the cost difference
const CDEF_COST_NUMERATOR: i32 = 840;
const CDEF_VARIANCE_SHIFT: u32 = 10u;
const CDEF_SAMPLE_CENTER: i32 = 128;
// adjust_strength: the variance's log2 above 6, capped at 12
const CDEF_STRENGTH_VARIANCE_SHIFT: u32 = 6u;
const CDEF_STRENGTH_LOG_MAXIMUM: u32 = 12u;
// The 4:2:2 chroma direction of a luma direction, a nibble per direction (conv422 in av1_cdef_filter_fb)
const CDEF_DIRECTIONS_422: u32 = 0x66654207u;

var<workgroup> cdefTile: array<u32, CDEF_TILE_WORDS>;
var<workgroup> cdefBlocks: array<vec4u, CDEF_BLOCKS>;
var<workgroup> cdefAnyBlockFilters: atomic<u32>;
var<workgroup> cdefMode: u32;

// The strength index of a 64x64 filter block: 4 bits per 64x64 block of its superblock, RECORD_SUPERBLOCK_CDEF_SKIP when it skips
fn cdefGetStrengthIndex(blockColumn: u32, blockRow: u32) -> u32 {
    let superblockColumns = readRecordWord(RECORD_HEADER_SUPERBLOCK_COLUMNS);
    if (hasRecordFlag(RECORD_FLAG_SUPERBLOCK_128)) {
        let superblock = (blockRow >> 1u) * superblockColumns + (blockColumn >> 1u);
        let quadrant = ((blockRow & 1u) << 1u) | (blockColumn & 1u);
        return getField(readSuperblockWord(superblock, RECORD_SUPERBLOCK_CDEF), quadrant * RECORD_SUPERBLOCK_CDEF_INDEX_BITS,
            RECORD_SUPERBLOCK_CDEF_INDEX_BITS);
    }
    return getField(readSuperblockWord(blockRow * superblockColumns + blockColumn, RECORD_SUPERBLOCK_CDEF), 0u,
        RECORD_SUPERBLOCK_CDEF_INDEX_BITS);
}

// A plane's primary (x) and secondary (y) strength of a strength index, at bit depth 8: luma, or chroma
fn cdefGetStrengths(index: u32, plane: u32) -> vec2u {
    let strengths = readRecordWord(RECORD_HEADER_CDEF_STRENGTHS + index);
    if (plane == PLANE_Y) {
        return vec2u(getField(strengths, RECORD_CDEF_LUMA_PRIMARY_SHIFT, RECORD_CDEF_STRENGTH_BITS),
            getField(strengths, RECORD_CDEF_LUMA_SECONDARY_SHIFT, RECORD_CDEF_STRENGTH_BITS));
    }
    return vec2u(getField(strengths, RECORD_CDEF_CHROMA_PRIMARY_SHIFT, RECORD_CDEF_STRENGTH_BITS),
        getField(strengths, RECORD_CDEF_CHROMA_SECONDARY_SHIFT, RECORD_CDEF_STRENGTH_BITS));
}

// What the workgroup does before it knows which 8x8 blocks filter: cdef_fb_col's skips
fn cdefGetMode(plane: u32, blockColumn: u32, blockRow: u32) -> u32 {
    if (!isDecodingFrame() || readRecordWord(RECORD_HEADER_CDEF_SOURCE) == RECORD_MISSING || !filtersHasPlane(plane)) {
        return CDEF_MODE_NONE;
    }
    let miColumn = blockColumn << (FILTERS_AREA_SIZE_LOG2 - MI_SIZE_LOG2);
    let miRow = blockRow << (FILTERS_AREA_SIZE_LOG2 - MI_SIZE_LOG2);
    if (miColumn >= readRecordWord(RECORD_HEADER_MI_COLUMNS) || miRow >= readRecordWord(RECORD_HEADER_MI_ROWS)) {
        return CDEF_MODE_NONE;
    }
    let index = cdefGetStrengthIndex(blockColumn, blockRow);
    if (index == RECORD_SUPERBLOCK_CDEF_SKIP) {
        return CDEF_MODE_COPY;
    }
    // Planes without strength copy; libaom filters luma at zero strength, which changes nothing
    let strengths = cdefGetStrengths(index, plane);
    if (strengths.x == 0u && strengths.y == 0u) {
        return CDEF_MODE_COPY;
    }
    return CDEF_MODE_FILTER;
}

// Word index of the tile, dense over its rows of tile words (CDEF_TILE_ROW_WORDS for luma-wide areas, CDEF_NARROW_TILE_ROW_WORDS for
// chroma-wide ones): the source pair at its place, CDEF_OUTSIDE_PAIR outside the frame aligned to 8, whose load reads the plane's
// first word instead
fn cdefLoadTileWord(index: u32, isWide: bool, area: vec2u, alignedSize: vec2u, sourceBase: u32, rowWords: u32) -> u32 {
    let tileRow = select(index / CDEF_NARROW_TILE_ROW_WORDS, index / CDEF_TILE_ROW_WORDS, isWide);
    let tileWord = index - tileRow * select(CDEF_NARROW_TILE_ROW_WORDS, CDEF_TILE_ROW_WORDS, isWide);
    let x = i32(area.x) + i32(tileWord << SAMPLE_PAIR_SHIFT) - i32(CDEF_BORDER);
    let y = i32(area.y) + i32(tileRow) - i32(CDEF_BORDER);
    let inside = x >= 0 && y >= 0 && u32(x) < alignedSize.x && u32(y) < alignedSize.y;
    let word = frames[sourceBase + select(0u, u32(y) * rowWords + (u32(x) >> SAMPLE_PAIR_SHIFT), inside)];
    return select(CDEF_OUTSIDE_PAIR, word, inside);
}

// Writes dense tile word index into the tile, when the tile has it
fn cdefStoreTileWord(index: u32, tileWordCount: u32, isWide: bool, word: u32) {
    if (index >= tileWordCount) {
        return;
    }
    let tileRow = select(index / CDEF_NARROW_TILE_ROW_WORDS, index / CDEF_TILE_ROW_WORDS, isWide);
    let tileWord = index - tileRow * select(CDEF_NARROW_TILE_ROW_WORDS, CDEF_TILE_ROW_WORDS, isWide);
    cdefTile[tileRow * CDEF_TILE_ROW_WORDS + tileWord] = word;
}

// cdef_find_dir_c for the 8x8 luma block whose first sample's word of the frame store is blockWord, rows rowWords apart,
// unrolled (scratch/av1/gpu-filters/generate_cdef_direction.py writes it): its direction (x) and variance (y). Sample (i, j)
// >> coeff_shift, less 128, adds to one partial sum per direction; a direction's cost weighs each squared partial sum by
// 840 / its sample count.
fn cdefFindDirection(blockWord: u32, rowWords: u32, depthShift: u32) -> vec2i {
    let row0Word0 = frames[blockWord + 0u * rowWords + 0u];
    let row0Word1 = frames[blockWord + 0u * rowWords + 1u];
    let row0Word2 = frames[blockWord + 0u * rowWords + 2u];
    let row0Word3 = frames[blockWord + 0u * rowWords + 3u];
    let x00 = i32(((row0Word0) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x01 = i32(((row0Word0 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x02 = i32(((row0Word1) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x03 = i32(((row0Word1 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x04 = i32(((row0Word2) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x05 = i32(((row0Word2 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x06 = i32(((row0Word3) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x07 = i32(((row0Word3 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let row1Word0 = frames[blockWord + 1u * rowWords + 0u];
    let row1Word1 = frames[blockWord + 1u * rowWords + 1u];
    let row1Word2 = frames[blockWord + 1u * rowWords + 2u];
    let row1Word3 = frames[blockWord + 1u * rowWords + 3u];
    let x10 = i32(((row1Word0) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x11 = i32(((row1Word0 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x12 = i32(((row1Word1) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x13 = i32(((row1Word1 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x14 = i32(((row1Word2) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x15 = i32(((row1Word2 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x16 = i32(((row1Word3) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x17 = i32(((row1Word3 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let row2Word0 = frames[blockWord + 2u * rowWords + 0u];
    let row2Word1 = frames[blockWord + 2u * rowWords + 1u];
    let row2Word2 = frames[blockWord + 2u * rowWords + 2u];
    let row2Word3 = frames[blockWord + 2u * rowWords + 3u];
    let x20 = i32(((row2Word0) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x21 = i32(((row2Word0 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x22 = i32(((row2Word1) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x23 = i32(((row2Word1 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x24 = i32(((row2Word2) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x25 = i32(((row2Word2 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x26 = i32(((row2Word3) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x27 = i32(((row2Word3 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let row3Word0 = frames[blockWord + 3u * rowWords + 0u];
    let row3Word1 = frames[blockWord + 3u * rowWords + 1u];
    let row3Word2 = frames[blockWord + 3u * rowWords + 2u];
    let row3Word3 = frames[blockWord + 3u * rowWords + 3u];
    let x30 = i32(((row3Word0) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x31 = i32(((row3Word0 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x32 = i32(((row3Word1) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x33 = i32(((row3Word1 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x34 = i32(((row3Word2) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x35 = i32(((row3Word2 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x36 = i32(((row3Word3) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x37 = i32(((row3Word3 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let row4Word0 = frames[blockWord + 4u * rowWords + 0u];
    let row4Word1 = frames[blockWord + 4u * rowWords + 1u];
    let row4Word2 = frames[blockWord + 4u * rowWords + 2u];
    let row4Word3 = frames[blockWord + 4u * rowWords + 3u];
    let x40 = i32(((row4Word0) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x41 = i32(((row4Word0 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x42 = i32(((row4Word1) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x43 = i32(((row4Word1 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x44 = i32(((row4Word2) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x45 = i32(((row4Word2 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x46 = i32(((row4Word3) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x47 = i32(((row4Word3 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let row5Word0 = frames[blockWord + 5u * rowWords + 0u];
    let row5Word1 = frames[blockWord + 5u * rowWords + 1u];
    let row5Word2 = frames[blockWord + 5u * rowWords + 2u];
    let row5Word3 = frames[blockWord + 5u * rowWords + 3u];
    let x50 = i32(((row5Word0) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x51 = i32(((row5Word0 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x52 = i32(((row5Word1) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x53 = i32(((row5Word1 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x54 = i32(((row5Word2) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x55 = i32(((row5Word2 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x56 = i32(((row5Word3) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x57 = i32(((row5Word3 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let row6Word0 = frames[blockWord + 6u * rowWords + 0u];
    let row6Word1 = frames[blockWord + 6u * rowWords + 1u];
    let row6Word2 = frames[blockWord + 6u * rowWords + 2u];
    let row6Word3 = frames[blockWord + 6u * rowWords + 3u];
    let x60 = i32(((row6Word0) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x61 = i32(((row6Word0 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x62 = i32(((row6Word1) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x63 = i32(((row6Word1 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x64 = i32(((row6Word2) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x65 = i32(((row6Word2 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x66 = i32(((row6Word3) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x67 = i32(((row6Word3 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let row7Word0 = frames[blockWord + 7u * rowWords + 0u];
    let row7Word1 = frames[blockWord + 7u * rowWords + 1u];
    let row7Word2 = frames[blockWord + 7u * rowWords + 2u];
    let row7Word3 = frames[blockWord + 7u * rowWords + 3u];
    let x70 = i32(((row7Word0) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x71 = i32(((row7Word0 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x72 = i32(((row7Word1) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x73 = i32(((row7Word1 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x74 = i32(((row7Word2) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x75 = i32(((row7Word2 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x76 = i32(((row7Word3) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let x77 = i32(((row7Word3 >> SAMPLE_HALF_BITS) & SAMPLE_HALF_MASK) >> depthShift) - CDEF_SAMPLE_CENTER;
    let partial0_0 = x00;
    let partial0_1 = x01 + x10;
    let partial0_2 = x02 + x11 + x20;
    let partial0_3 = x03 + x12 + x21 + x30;
    let partial0_4 = x04 + x13 + x22 + x31 + x40;
    let partial0_5 = x05 + x14 + x23 + x32 + x41 + x50;
    let partial0_6 = x06 + x15 + x24 + x33 + x42 + x51 + x60;
    let partial0_7 = x07 + x16 + x25 + x34 + x43 + x52 + x61 + x70;
    let partial0_8 = x17 + x26 + x35 + x44 + x53 + x62 + x71;
    let partial0_9 = x27 + x36 + x45 + x54 + x63 + x72;
    let partial0_10 = x37 + x46 + x55 + x64 + x73;
    let partial0_11 = x47 + x56 + x65 + x74;
    let partial0_12 = x57 + x66 + x75;
    let partial0_13 = x67 + x76;
    let partial0_14 = x77;
    let cost0 = (partial0_0 * partial0_0 + partial0_14 * partial0_14) * CDEF_COST_NUMERATOR
        + (partial0_1 * partial0_1 + partial0_13 * partial0_13) * (CDEF_COST_NUMERATOR / 2)
        + (partial0_2 * partial0_2 + partial0_12 * partial0_12) * (CDEF_COST_NUMERATOR / 3)
        + (partial0_3 * partial0_3 + partial0_11 * partial0_11) * (CDEF_COST_NUMERATOR / 4)
        + (partial0_4 * partial0_4 + partial0_10 * partial0_10) * (CDEF_COST_NUMERATOR / 5)
        + (partial0_5 * partial0_5 + partial0_9 * partial0_9) * (CDEF_COST_NUMERATOR / 6)
        + (partial0_6 * partial0_6 + partial0_8 * partial0_8) * (CDEF_COST_NUMERATOR / 7)
        + (partial0_7 * partial0_7) * (CDEF_COST_NUMERATOR / 8);
    let partial1_0 = x00 + x01;
    let partial1_1 = x02 + x03 + x10 + x11;
    let partial1_2 = x04 + x05 + x12 + x13 + x20 + x21;
    let partial1_3 = x06 + x07 + x14 + x15 + x22 + x23 + x30 + x31;
    let partial1_4 = x16 + x17 + x24 + x25 + x32 + x33 + x40 + x41;
    let partial1_5 = x26 + x27 + x34 + x35 + x42 + x43 + x50 + x51;
    let partial1_6 = x36 + x37 + x44 + x45 + x52 + x53 + x60 + x61;
    let partial1_7 = x46 + x47 + x54 + x55 + x62 + x63 + x70 + x71;
    let partial1_8 = x56 + x57 + x64 + x65 + x72 + x73;
    let partial1_9 = x66 + x67 + x74 + x75;
    let partial1_10 = x76 + x77;
    let cost1 = (partial1_3 * partial1_3 + partial1_4 * partial1_4 + partial1_5 * partial1_5 + partial1_6 * partial1_6
        + partial1_7 * partial1_7) * (CDEF_COST_NUMERATOR / 8)
        + (partial1_0 * partial1_0 + partial1_10 * partial1_10) * (CDEF_COST_NUMERATOR / 2)
        + (partial1_1 * partial1_1 + partial1_9 * partial1_9) * (CDEF_COST_NUMERATOR / 4)
        + (partial1_2 * partial1_2 + partial1_8 * partial1_8) * (CDEF_COST_NUMERATOR / 6);
    let partial2_0 = x00 + x01 + x02 + x03 + x04 + x05 + x06 + x07;
    let partial2_1 = x10 + x11 + x12 + x13 + x14 + x15 + x16 + x17;
    let partial2_2 = x20 + x21 + x22 + x23 + x24 + x25 + x26 + x27;
    let partial2_3 = x30 + x31 + x32 + x33 + x34 + x35 + x36 + x37;
    let partial2_4 = x40 + x41 + x42 + x43 + x44 + x45 + x46 + x47;
    let partial2_5 = x50 + x51 + x52 + x53 + x54 + x55 + x56 + x57;
    let partial2_6 = x60 + x61 + x62 + x63 + x64 + x65 + x66 + x67;
    let partial2_7 = x70 + x71 + x72 + x73 + x74 + x75 + x76 + x77;
    let cost2 = (partial2_0 * partial2_0 + partial2_1 * partial2_1 + partial2_2 * partial2_2 + partial2_3 * partial2_3
        + partial2_4 * partial2_4 + partial2_5 * partial2_5 + partial2_6 * partial2_6 + partial2_7 * partial2_7) * (CDEF_COST_NUMERATOR / 8);
    let partial3_0 = x06 + x07;
    let partial3_1 = x04 + x05 + x16 + x17;
    let partial3_2 = x02 + x03 + x14 + x15 + x26 + x27;
    let partial3_3 = x00 + x01 + x12 + x13 + x24 + x25 + x36 + x37;
    let partial3_4 = x10 + x11 + x22 + x23 + x34 + x35 + x46 + x47;
    let partial3_5 = x20 + x21 + x32 + x33 + x44 + x45 + x56 + x57;
    let partial3_6 = x30 + x31 + x42 + x43 + x54 + x55 + x66 + x67;
    let partial3_7 = x40 + x41 + x52 + x53 + x64 + x65 + x76 + x77;
    let partial3_8 = x50 + x51 + x62 + x63 + x74 + x75;
    let partial3_9 = x60 + x61 + x72 + x73;
    let partial3_10 = x70 + x71;
    let cost3 = (partial3_3 * partial3_3 + partial3_4 * partial3_4 + partial3_5 * partial3_5 + partial3_6 * partial3_6
        + partial3_7 * partial3_7) * (CDEF_COST_NUMERATOR / 8)
        + (partial3_0 * partial3_0 + partial3_10 * partial3_10) * (CDEF_COST_NUMERATOR / 2)
        + (partial3_1 * partial3_1 + partial3_9 * partial3_9) * (CDEF_COST_NUMERATOR / 4)
        + (partial3_2 * partial3_2 + partial3_8 * partial3_8) * (CDEF_COST_NUMERATOR / 6);
    let partial4_0 = x07;
    let partial4_1 = x06 + x17;
    let partial4_2 = x05 + x16 + x27;
    let partial4_3 = x04 + x15 + x26 + x37;
    let partial4_4 = x03 + x14 + x25 + x36 + x47;
    let partial4_5 = x02 + x13 + x24 + x35 + x46 + x57;
    let partial4_6 = x01 + x12 + x23 + x34 + x45 + x56 + x67;
    let partial4_7 = x00 + x11 + x22 + x33 + x44 + x55 + x66 + x77;
    let partial4_8 = x10 + x21 + x32 + x43 + x54 + x65 + x76;
    let partial4_9 = x20 + x31 + x42 + x53 + x64 + x75;
    let partial4_10 = x30 + x41 + x52 + x63 + x74;
    let partial4_11 = x40 + x51 + x62 + x73;
    let partial4_12 = x50 + x61 + x72;
    let partial4_13 = x60 + x71;
    let partial4_14 = x70;
    let cost4 = (partial4_0 * partial4_0 + partial4_14 * partial4_14) * CDEF_COST_NUMERATOR
        + (partial4_1 * partial4_1 + partial4_13 * partial4_13) * (CDEF_COST_NUMERATOR / 2)
        + (partial4_2 * partial4_2 + partial4_12 * partial4_12) * (CDEF_COST_NUMERATOR / 3)
        + (partial4_3 * partial4_3 + partial4_11 * partial4_11) * (CDEF_COST_NUMERATOR / 4)
        + (partial4_4 * partial4_4 + partial4_10 * partial4_10) * (CDEF_COST_NUMERATOR / 5)
        + (partial4_5 * partial4_5 + partial4_9 * partial4_9) * (CDEF_COST_NUMERATOR / 6)
        + (partial4_6 * partial4_6 + partial4_8 * partial4_8) * (CDEF_COST_NUMERATOR / 7)
        + (partial4_7 * partial4_7) * (CDEF_COST_NUMERATOR / 8);
    let partial5_0 = x60 + x70;
    let partial5_1 = x40 + x50 + x61 + x71;
    let partial5_2 = x20 + x30 + x41 + x51 + x62 + x72;
    let partial5_3 = x00 + x10 + x21 + x31 + x42 + x52 + x63 + x73;
    let partial5_4 = x01 + x11 + x22 + x32 + x43 + x53 + x64 + x74;
    let partial5_5 = x02 + x12 + x23 + x33 + x44 + x54 + x65 + x75;
    let partial5_6 = x03 + x13 + x24 + x34 + x45 + x55 + x66 + x76;
    let partial5_7 = x04 + x14 + x25 + x35 + x46 + x56 + x67 + x77;
    let partial5_8 = x05 + x15 + x26 + x36 + x47 + x57;
    let partial5_9 = x06 + x16 + x27 + x37;
    let partial5_10 = x07 + x17;
    let cost5 = (partial5_3 * partial5_3 + partial5_4 * partial5_4 + partial5_5 * partial5_5 + partial5_6 * partial5_6
        + partial5_7 * partial5_7) * (CDEF_COST_NUMERATOR / 8)
        + (partial5_0 * partial5_0 + partial5_10 * partial5_10) * (CDEF_COST_NUMERATOR / 2)
        + (partial5_1 * partial5_1 + partial5_9 * partial5_9) * (CDEF_COST_NUMERATOR / 4)
        + (partial5_2 * partial5_2 + partial5_8 * partial5_8) * (CDEF_COST_NUMERATOR / 6);
    let partial6_0 = x00 + x10 + x20 + x30 + x40 + x50 + x60 + x70;
    let partial6_1 = x01 + x11 + x21 + x31 + x41 + x51 + x61 + x71;
    let partial6_2 = x02 + x12 + x22 + x32 + x42 + x52 + x62 + x72;
    let partial6_3 = x03 + x13 + x23 + x33 + x43 + x53 + x63 + x73;
    let partial6_4 = x04 + x14 + x24 + x34 + x44 + x54 + x64 + x74;
    let partial6_5 = x05 + x15 + x25 + x35 + x45 + x55 + x65 + x75;
    let partial6_6 = x06 + x16 + x26 + x36 + x46 + x56 + x66 + x76;
    let partial6_7 = x07 + x17 + x27 + x37 + x47 + x57 + x67 + x77;
    let cost6 = (partial6_0 * partial6_0 + partial6_1 * partial6_1 + partial6_2 * partial6_2 + partial6_3 * partial6_3
        + partial6_4 * partial6_4 + partial6_5 * partial6_5 + partial6_6 * partial6_6 + partial6_7 * partial6_7) * (CDEF_COST_NUMERATOR / 8);
    let partial7_0 = x00 + x10;
    let partial7_1 = x01 + x11 + x20 + x30;
    let partial7_2 = x02 + x12 + x21 + x31 + x40 + x50;
    let partial7_3 = x03 + x13 + x22 + x32 + x41 + x51 + x60 + x70;
    let partial7_4 = x04 + x14 + x23 + x33 + x42 + x52 + x61 + x71;
    let partial7_5 = x05 + x15 + x24 + x34 + x43 + x53 + x62 + x72;
    let partial7_6 = x06 + x16 + x25 + x35 + x44 + x54 + x63 + x73;
    let partial7_7 = x07 + x17 + x26 + x36 + x45 + x55 + x64 + x74;
    let partial7_8 = x27 + x37 + x46 + x56 + x65 + x75;
    let partial7_9 = x47 + x57 + x66 + x76;
    let partial7_10 = x67 + x77;
    let cost7 = (partial7_3 * partial7_3 + partial7_4 * partial7_4 + partial7_5 * partial7_5 + partial7_6 * partial7_6
        + partial7_7 * partial7_7) * (CDEF_COST_NUMERATOR / 8)
        + (partial7_0 * partial7_0 + partial7_10 * partial7_10) * (CDEF_COST_NUMERATOR / 2)
        + (partial7_1 * partial7_1 + partial7_9 * partial7_9) * (CDEF_COST_NUMERATOR / 4)
        + (partial7_2 * partial7_2 + partial7_8 * partial7_8) * (CDEF_COST_NUMERATOR / 6);
    // The first direction of the highest cost, and the cost of the direction orthogonal to it
    var bestCost = 0;
    var bestDirection = 0u;
    if (cost0 > bestCost) {
        bestCost = cost0;
        bestDirection = 0u;
    }
    if (cost1 > bestCost) {
        bestCost = cost1;
        bestDirection = 1u;
    }
    if (cost2 > bestCost) {
        bestCost = cost2;
        bestDirection = 2u;
    }
    if (cost3 > bestCost) {
        bestCost = cost3;
        bestDirection = 3u;
    }
    if (cost4 > bestCost) {
        bestCost = cost4;
        bestDirection = 4u;
    }
    if (cost5 > bestCost) {
        bestCost = cost5;
        bestDirection = 5u;
    }
    if (cost6 > bestCost) {
        bestCost = cost6;
        bestDirection = 6u;
    }
    if (cost7 > bestCost) {
        bestCost = cost7;
        bestDirection = 7u;
    }
    var orthogonalCost = cost0;
    switch ((bestDirection + 4u) & 7u) {
        case 1u: { orthogonalCost = cost1; }
        case 2u: { orthogonalCost = cost2; }
        case 3u: { orthogonalCost = cost3; }
        case 4u: { orthogonalCost = cost4; }
        case 5u: { orthogonalCost = cost5; }
        case 6u: { orthogonalCost = cost6; }
        case 7u: { orthogonalCost = cost7; }
        default: {}
    }
    return vec2i(i32(bestDirection), (bestCost - orthogonalCost) >> CDEF_VARIANCE_SHIFT);
}

// adjust_strength: the luma primary strength of an 8x8 block by its directional variance
fn cdefAdjustStrength(strength: i32, variance: i32) -> i32 {
    if (variance == 0) {
        return 0;
    }
    let scaled = u32(variance) >> CDEF_STRENGTH_VARIANCE_SHIFT;
    var logarithm = 0u;
    if (scaled != 0u) {
        logarithm = min(firstLeadingBit(scaled), CDEF_STRENGTH_LOG_MAXIMUM);
    }
    return (strength * (4 + i32(logarithm)) + 8) >> 4u;
}

// cdef_directions: per direction, a nibble each of the x and y step of its first (tap 0) and second (tap 1) sample, plus 2
const CDEF_TAP_0_STEPS_X: u32 = 0x22233333u;
const CDEF_TAP_0_STEPS_Y: u32 = 0x33332221u;
const CDEF_TAP_1_STEPS_X: u32 = 0x12344444u;
const CDEF_TAP_1_STEPS_Y: u32 = 0x44443210u;
const CDEF_STEP_BIAS: i32 = 2;
// The secondary taps run 2 directions either side of the primary one
const CDEF_SECONDARY_TURN: u32 = 2u;

// The (x, y) steps of a direction's tap 0 (x, y) and tap 1 (z, w) samples
fn cdefGetDirectionSteps(direction: u32) -> vec4i {
    let shift = (direction & 7u) << 2u;
    let nibbles = (vec4u(CDEF_TAP_0_STEPS_X, CDEF_TAP_0_STEPS_Y, CDEF_TAP_1_STEPS_X, CDEF_TAP_1_STEPS_Y) >> vec4u(shift)) & vec4u(15u);
    return vec4i(nibbles) - vec4i(CDEF_STEP_BIAS);
}

// constrain's damping shift for a strength, max(0, damping - msb(strength)); 0 for strength 0, whose taps do not run
fn cdefGetDampingShift(strength: i32, damping: i32) -> u32 {
    if (strength == 0) {
        return 0u;
    }
    return u32(max(0, damping - i32(firstLeadingBit(u32(strength)))));
}

// A direction's tap 0 (x) and tap 1 (y) offsets in tile samples, from cdefGetDirectionSteps' steps
fn cdefGetTapOffsets(steps: vec4i) -> vec2i {
    return vec2i(steps.x + steps.y * i32(CDEF_TILE_ROW_SAMPLES), steps.z + steps.w * i32(CDEF_TILE_ROW_SAMPLES));
}

// Two tap offsets in one word, 16 signed bits each
fn cdefPackOffsets(offsets: vec2i) -> u32 {
    return (u32(offsets.x) & SAMPLE_HALF_MASK) | (u32(offsets.y) << SAMPLE_HALF_BITS);
}

// The two tap offsets of a cdefPackOffsets word
fn cdefUnpackOffsets(word: u32) -> vec2i {
    return vec2i(i32(word << SAMPLE_HALF_BITS) >> SAMPLE_HALF_BITS, i32(word) >> SAMPLE_HALF_BITS);
}

// The tile samples at sample index sampleIndex (row-major, CDEF_TILE_ROW_SAMPLES per row) and the one after it
fn cdefReadTilePair(sampleIndex: u32) -> vec2i {
    let first = cdefTile[sampleIndex >> SAMPLE_PAIR_SHIFT];
    let second = cdefTile[(sampleIndex + 1u) >> SAMPLE_PAIR_SHIFT];
    let shift = (sampleIndex & 1u) * SAMPLE_HALF_BITS;
    return vec2i(i32((first >> shift) & SAMPLE_HALF_MASK), i32((second >> (SAMPLE_HALF_BITS - shift)) & SAMPLE_HALF_MASK));
}

// constrain for two neighbor differences: their contributions, shrunk by the threshold and its damping shift
fn cdefConstrainPair(difference: vec2i, threshold: i32, shift: u32) -> vec2i {
    let magnitude = abs(difference);
    let value = clamp(vec2i(threshold) - (magnitude >> vec2u(shift)), vec2i(0), magnitude);
    return select(value, -value, difference < vec2i(0));
}

// cdef_filter_block_internal for the sample pair at tile sample index sampleIndex: primary taps along the direction (offsets of
// cdefGetTapOffsets), secondary taps 45 degrees off it, clipped to the taps' range when both run; the filtered pair as a word.
// The maximum ignores taps outside the frame: CDEF_VERY_LARGE masked to 14 bits is 0, and samples are at most 12 bits.
fn cdefFilterPair(sampleIndex: u32, primary: i32, primaryShift: u32, primaryOffsets: vec2i, secondary: i32, secondaryShift: u32,
    secondaryOffsetsA: vec2i, secondaryOffsetsB: vec2i) -> u32 {
    let center = cdefReadTilePair(sampleIndex);
    let clipping = primary != 0 && secondary != 0;
    let index = i32(sampleIndex);
    var sum = vec2i(0);
    var maximum = center;
    var minimum = center;
    if (primary != 0) {
        // cdef_pri_taps by the primary strength's parity at bit depth 8: {4, 2} or {3, 3}
        let oddPrimary = ((primary >> (OUTPUT_BIT_DEPTH - 8u)) & 1) == 1;
        let forward0 = cdefReadTilePair(u32(index + primaryOffsets.x));
        let backward0 = cdefReadTilePair(u32(index - primaryOffsets.x));
        let forward1 = cdefReadTilePair(u32(index + primaryOffsets.y));
        let backward1 = cdefReadTilePair(u32(index - primaryOffsets.y));
        sum = select(4, 3, oddPrimary) * (cdefConstrainPair(forward0 - center, primary, primaryShift)
            + cdefConstrainPair(backward0 - center, primary, primaryShift))
            + select(2, 3, oddPrimary) * (cdefConstrainPair(forward1 - center, primary, primaryShift)
            + cdefConstrainPair(backward1 - center, primary, primaryShift));
        if (clipping) {
            let mask = vec2i(CDEF_MAXIMUM_MASK);
            maximum = max(max(maximum, max(forward0 & mask, backward0 & mask)), max(forward1 & mask, backward1 & mask));
            minimum = min(min(minimum, min(forward0, backward0)), min(forward1, backward1));
        }
    }
    if (secondary != 0) {
        // cdef_sec_taps {2, 1}
        let sampleA0 = cdefReadTilePair(u32(index + secondaryOffsetsA.x));
        let sampleA1 = cdefReadTilePair(u32(index - secondaryOffsetsA.x));
        let sampleB0 = cdefReadTilePair(u32(index + secondaryOffsetsB.x));
        let sampleB1 = cdefReadTilePair(u32(index - secondaryOffsetsB.x));
        let sampleA2 = cdefReadTilePair(u32(index + secondaryOffsetsA.y));
        let sampleA3 = cdefReadTilePair(u32(index - secondaryOffsetsA.y));
        let sampleB2 = cdefReadTilePair(u32(index + secondaryOffsetsB.y));
        let sampleB3 = cdefReadTilePair(u32(index - secondaryOffsetsB.y));
        sum += 2 * (cdefConstrainPair(sampleA0 - center, secondary, secondaryShift) + cdefConstrainPair(sampleA1 - center, secondary, secondaryShift)
            + cdefConstrainPair(sampleB0 - center, secondary, secondaryShift) + cdefConstrainPair(sampleB1 - center, secondary, secondaryShift))
            + cdefConstrainPair(sampleA2 - center, secondary, secondaryShift) + cdefConstrainPair(sampleA3 - center, secondary, secondaryShift)
            + cdefConstrainPair(sampleB2 - center, secondary, secondaryShift) + cdefConstrainPair(sampleB3 - center, secondary, secondaryShift);
        if (clipping) {
            let mask = vec2i(CDEF_MAXIMUM_MASK);
            let nearMaximum = max(max(sampleA0 & mask, sampleA1 & mask), max(sampleB0 & mask, sampleB1 & mask));
            let farMaximum = max(max(sampleA2 & mask, sampleA3 & mask), max(sampleB2 & mask, sampleB3 & mask));
            maximum = max(maximum, max(nearMaximum, farMaximum));
            minimum = min(min(minimum, min(min(sampleA0, sampleA1), min(sampleB0, sampleB1))), min(min(sampleA2, sampleA3), min(sampleB2, sampleB3)));
        }
    }
    var filtered = center + ((vec2i(8) + sum - select(vec2i(0), vec2i(1), sum < vec2i(0))) >> vec2u(4u));
    if (clipping) {
        filtered = clamp(filtered, minimum, maximum);
    }
    return u32(filtered.x) | (u32(filtered.y) << SAMPLE_HALF_BITS);
}

// CDEF of the 64x64 luma area (x, y) of plane z, from the CDEF source to the CDEF target, which receives every sample of the area
// inside the frame aligned to 8: filtered 8x8 blocks, and the source elsewhere
fn cdefFilterBlock(workgroup: vec3u, lane: u32) {
    let plane = workgroup.z;
    if (lane == 0u) {
        cdefMode = cdefGetMode(plane, workgroup.x, workgroup.y);
        atomicStore(&cdefAnyBlockFilters, 0u);
    }
    let initialMode = workgroupUniformLoad(&cdefMode);
    if (initialMode == CDEF_MODE_NONE) {
        return;
    }
    let subsamplingX = filtersGetSubsamplingX(plane);
    let subsamplingY = filtersGetSubsamplingY(plane);
    let miColumns = readRecordWord(RECORD_HEADER_MI_COLUMNS);
    let miRows = readRecordWord(RECORD_HEADER_MI_ROWS);
    let firstMiColumn = workgroup.x << (FILTERS_AREA_SIZE_LOG2 - MI_SIZE_LOG2);
    let firstMiRow = workgroup.y << (FILTERS_AREA_SIZE_LOG2 - MI_SIZE_LOG2);
    // One invocation per 8x8 luma block: it filters when it is inside the frame and some of its 4x4 units have residual
    // (is_8x8_block_skip)
    let blockX = lane & ((1u << CDEF_BLOCKS_PER_ROW_LOG2) - 1u);
    let blockY = lane >> CDEF_BLOCKS_PER_ROW_LOG2;
    let blockMiColumn = firstMiColumn + (blockX << 1u);
    let blockMiRow = firstMiRow + (blockY << 1u);
    var blockFilters = false;
    if (initialMode == CDEF_MODE_FILTER && blockMiColumn < miColumns && blockMiRow < miRows) {
        let skipBit = 1u << MODE_INFO_SKIP_SHIFT;
        let skipped = frameData[getModeInfoWordIndex(blockMiRow, blockMiColumn)] & frameData[getModeInfoWordIndex(blockMiRow, blockMiColumn + 1u)]
            & frameData[getModeInfoWordIndex(blockMiRow + 1u, blockMiColumn)] & frameData[getModeInfoWordIndex(blockMiRow + 1u, blockMiColumn + 1u)]
            & skipBit;
        blockFilters = skipped == 0u;
    }
    if (blockFilters) {
        atomicOr(&cdefAnyBlockFilters, 1u);
    }
    workgroupBarrier();
    if (lane == 0u && initialMode == CDEF_MODE_FILTER && atomicLoad(&cdefAnyBlockFilters) == 0u) {
        cdefMode = CDEF_MODE_COPY;
    }
    let mode = workgroupUniformLoad(&cdefMode);
    let sourceBuffer = readRecordWord(RECORD_HEADER_CDEF_SOURCE);
    let targetBuffer = readRecordWord(RECORD_HEADER_CDEF_TARGET);
    let areaX = (workgroup.x << FILTERS_AREA_SIZE_LOG2) >> subsamplingX;
    let areaY = (workgroup.y << FILTERS_AREA_SIZE_LOG2) >> subsamplingY;
    let alignedWidth = (miColumns << MI_SIZE_LOG2) >> subsamplingX;
    let alignedHeight = (miRows << MI_SIZE_LOG2) >> subsamplingY;
    let pairsPerRowLog2 = FILTERS_AREA_SIZE_LOG2 - SAMPLE_PAIR_SHIFT - subsamplingX;
    let areaRows = 1u << (FILTERS_AREA_SIZE_LOG2 - subsamplingY);
    let rowWords = getStorePlaneWidth(plane) >> SAMPLE_PAIR_SHIFT;
    let sourceBase = getStoreWordIndex(sourceBuffer, plane, 0u, 0u);
    let targetBase = getStoreWordIndex(targetBuffer, plane, 0u, 0u);
    if (mode == CDEF_MODE_COPY) {
        filtersCopyArea(sourceBase, targetBase, rowWords, areaX, areaY, min(areaY + areaRows, alignedHeight), pairsPerRowLog2, alignedWidth, lane);
        return;
    }
    // The tile: the area and two samples around it, CDEF_VERY_LARGE outside the frame; pairs never straddle its edge, as the
    // aligned width is even. Four words per invocation and round, their loads issued together.
    let isWide = subsamplingX == 0u;
    let tileWordCount = (areaRows + 2u * CDEF_BORDER) * select(CDEF_NARROW_TILE_ROW_WORDS, CDEF_TILE_ROW_WORDS, isWide);
    let lastTileWord = tileWordCount - 1u;
    for (var first = lane; first < tileWordCount; first += CDEF_TILE_BATCH * FILTERS_WORKGROUP_SIZE) {
        let second = first + FILTERS_WORKGROUP_SIZE;
        let third = second + FILTERS_WORKGROUP_SIZE;
        let fourth = third + FILTERS_WORKGROUP_SIZE;
        let word0 = cdefLoadTileWord(first, isWide, vec2u(areaX, areaY), vec2u(alignedWidth, alignedHeight), sourceBase, rowWords);
        let word1 = cdefLoadTileWord(min(second, lastTileWord), isWide, vec2u(areaX, areaY), vec2u(alignedWidth, alignedHeight), sourceBase,
            rowWords);
        let word2 = cdefLoadTileWord(min(third, lastTileWord), isWide, vec2u(areaX, areaY), vec2u(alignedWidth, alignedHeight), sourceBase,
            rowWords);
        let word3 = cdefLoadTileWord(min(fourth, lastTileWord), isWide, vec2u(areaX, areaY), vec2u(alignedWidth, alignedHeight), sourceBase,
            rowWords);
        cdefStoreTileWord(first, tileWordCount, isWide, word0);
        cdefStoreTileWord(second, tileWordCount, isWide, word1);
        cdefStoreTileWord(third, tileWordCount, isWide, word2);
        cdefStoreTileWord(fourth, tileWordCount, isWide, word3);
    }
    // Each filtering 8x8 block's primary strength and damping shift, and its taps' offsets; the barrier after it also publishes the tile
    let index = cdefGetStrengthIndex(workgroup.x, workgroup.y);
    let strengths = cdefGetStrengths(index, plane);
    let depthShift = OUTPUT_BIT_DEPTH - 8u;
    let primaryStrength = i32(strengths.x << depthShift);
    let damping = i32(getField(readRecordWord(RECORD_HEADER_CDEF), RECORD_CDEF_DAMPING_SHIFT, RECORD_CDEF_DAMPING_BITS) + depthShift)
        - select(0, 1, plane != PLANE_Y);
    var blockEntry = vec4u(0u);
    if (blockFilters) {
        var direction = 0u;
        var blockPrimary = primaryStrength;
        if (primaryStrength != 0) {
            // The direction comes from the block's luma in the source, inside the frame as the block filters
            let lumaX = (workgroup.x << FILTERS_AREA_SIZE_LOG2) + (blockX << CDEF_BLOCK_SIZE_LOG2);
            let lumaY = (workgroup.y << FILTERS_AREA_SIZE_LOG2) + (blockY << CDEF_BLOCK_SIZE_LOG2);
            let found = cdefFindDirection(getStoreWordIndex(sourceBuffer, PLANE_Y, lumaX, lumaY),
                getStorePlaneWidth(PLANE_Y) >> SAMPLE_PAIR_SHIFT, depthShift);
            direction = u32(found.x);
            if (plane == PLANE_Y) {
                blockPrimary = cdefAdjustStrength(primaryStrength, found.y);
            } else if (subsamplingX != subsamplingY) {
                direction = (CDEF_DIRECTIONS_422 >> (direction << 2u)) & 7u;
            }
        }
        // The direction is 0 when the plane has no primary strength: the secondary taps still follow it
        blockEntry = vec4u(CDEF_BLOCK_FILTERS | (cdefGetDampingShift(blockPrimary, damping) << CDEF_BLOCK_PRIMARY_SHIFT_SHIFT)
            | (u32(blockPrimary) << CDEF_BLOCK_STRENGTH_SHIFT),
            cdefPackOffsets(cdefGetTapOffsets(cdefGetDirectionSteps(direction))),
            cdefPackOffsets(cdefGetTapOffsets(cdefGetDirectionSteps(direction + CDEF_SECONDARY_TURN))),
            cdefPackOffsets(cdefGetTapOffsets(cdefGetDirectionSteps(direction + CDEF_DIRECTIONS - CDEF_SECONDARY_TURN))));
    }
    cdefBlocks[lane] = blockEntry;
    workgroupBarrier();
    let secondaryStrength = i32(strengths.y << depthShift);
    let secondaryShift = cdefGetDampingShift(secondaryStrength, damping);
    let blockShiftX = CDEF_BLOCK_SIZE_LOG2 - subsamplingX;
    let blockShiftY = CDEF_BLOCK_SIZE_LOG2 - subsamplingY;
    for (var pair = lane; pair < (areaRows << pairsPerRowLog2); pair += FILTERS_WORKGROUP_SIZE) {
        let x = (pair & ((1u << pairsPerRowLog2) - 1u)) << SAMPLE_PAIR_SHIFT;
        let y = pair >> pairsPerRowLog2;
        if (areaX + x >= alignedWidth || areaY + y >= alignedHeight) {
            continue;
        }
        let block = cdefBlocks[((y >> blockShiftY) << CDEF_BLOCKS_PER_ROW_LOG2) | (x >> blockShiftX)];
        var word = cdefTile[(y + CDEF_BORDER) * CDEF_TILE_ROW_WORDS + ((x + CDEF_BORDER) >> SAMPLE_PAIR_SHIFT)];
        if ((block.x & CDEF_BLOCK_FILTERS) != 0u) {
            word = cdefFilterPair((y + CDEF_BORDER) * CDEF_TILE_ROW_SAMPLES + x + CDEF_BORDER, i32(block.x >> CDEF_BLOCK_STRENGTH_SHIFT),
                getField(block.x, CDEF_BLOCK_PRIMARY_SHIFT_SHIFT, CDEF_BLOCK_PRIMARY_SHIFT_BITS), cdefUnpackOffsets(block.y), secondaryStrength,
                secondaryShift, cdefUnpackOffsets(block.z), cdefUnpackOffsets(block.w));
        }
        frames[targetBase + (areaY + y) * rowWords + ((areaX + x) >> SAMPLE_PAIR_SHIFT)] = word;
    }
}

// Loop restoration: libaom's av1_loop_restoration_filter_frame (av1_loop_restoration_filter_unit, wiener_filter_stripe_highbd with
// av1_highbd_wiener_convolve_add_src_c, sgrproj_filter_stripe_highbd with av1_selfguided_restoration_c and
// av1_apply_selfguided_restoration_c), whose 8-bit twins compute the same. Every output sample depends only on the samples around it
// as its stripe sees them: inside the stripe the source (CDEF and super-resolution's output), above and below it the saved deblocked
// rows (two rows to three: above r0, r0, r1, below r2, r3, r3), or the source's first or last row at the plane's top and bottom,
// with columns clamped to the plane, as libaom's frame extension and line buffers do. Unit boundaries fall on stripe boundaries.
// A workgroup restores its 64x64 luma area of plane z in segments of at most 16 rows inside one stripe and so one unit: it resolves
// each tile row's source once, reads the segment's source as its stripe sees it into workgroup memory, then the Wiener filter's
// horizontal pass or the self-guided filter's A and B (packed in one word), then the outputs. Self-guided A and B rows of radius 2
// are the odd rows: stripes start on even rows.

const RESTORATION_REACH: u32 = 3u;
// The tile's row stride, from 4 columns left of the area so its sample pairs are the store's, and the A and B arrays' (one row and
// column around the outputs; radius 2's hold odd rows only)
const RESTORATION_TILE_LEFT: u32 = 4u;
const RESTORATION_TILE_COLUMNS: u32 = 72u;
const RESTORATION_AB_COLUMNS: u32 = 66u;
// get_conv_params_wiener: the horizontal pass rounds 3 bits, the vertical 11; at 12 bits 2 move to the horizontal pass so its output
// stays within 16 bits
const RESTORATION_WIENER_ROUND_0: u32 = 3u;
const RESTORATION_WIENER_ROUND_1: u32 = 11u;
const RESTORATION_WIENER_DEPTH_LIMIT: u32 = 10u;
const RESTORATION_WIENER_BITS: u32 = 7u;
const RESTORATION_WIENER_TAPS: u32 = 7u;
// The self-guided filter (av1/common/restoration.h): SGRPROJ_MTABLE_BITS, SGRPROJ_RECIP_BITS, SGRPROJ_SGR_BITS, SGRPROJ_RST_BITS,
// SGRPROJ_PRJ_BITS, and av1_one_by_x of 9 and 25 samples
const RESTORATION_SGR_STRENGTH_BITS: u32 = 20u;
const RESTORATION_SGR_RECIPROCAL_BITS: u32 = 12u;
const RESTORATION_SGR_BITS: u32 = 8u;
const RESTORATION_SGR_ONE: u32 = 256u;
const RESTORATION_SGR_SOURCE_BITS: u32 = 4u;
const RESTORATION_SGR_PROJECTION_BITS: u32 = 7u;
const RESTORATION_SGR_RECIPROCAL_9: u32 = 455u;
const RESTORATION_SGR_RECIPROCAL_25: u32 = 164u;
const RESTORATION_SGR_BLEND_LIMIT: u32 = 255u;
// The workgroup's control words: whether it restores, copies, or does nothing
const RESTORATION_MODE_NONE: u32 = 0u;
const RESTORATION_MODE_COPY: u32 = 1u;
const RESTORATION_MODE_FILTER: u32 = 2u;

// A plane's restoration unit word at sample row y and the area's unit column
fn restorationReadUnitWord(plane: u32, unitColumn: u32, row: u32, stripeOffset: u32, word: u32) -> u32 {
    let unitSizeLog2 = firstTrailingBit(restorationReadPlaneWord(plane, RECORD_RESTORATION_UNIT_SIZE));
    let horizontalUnits = restorationReadPlaneWord(plane, RECORD_RESTORATION_HORIZONTAL_UNITS);
    let unitRow = min((row + stripeOffset) >> unitSizeLog2, restorationReadPlaneWord(plane, RECORD_RESTORATION_VERTICAL_UNITS) - 1u);
    let unit = restorationReadPlaneWord(plane, RECORD_RESTORATION_FIRST_UNIT) + unitRow * horizontalUnits + unitColumn;
    return readRecordWord(readRecordWord(RECORD_HEADER_RESTORATION_UNITS) + unit * RECORD_RESTORATION_UNIT_WORDS + word);
}

// A Wiener tap set of a unit: taps 0 to 2 of the vertical or horizontal filter, the center 128 - 2 * (tap 0 + tap 1 + tap 2)
// (read_wiener_filter's implicit WIENER_FILT_STEP plus av1_highbd_wiener_convolve_add_src's added source)
fn restorationGetWienerTaps(coefficients: u32, isHorizontal: bool) -> vec4i {
    let shift = select(RECORD_RESTORATION_UNIT_WIENER_VERTICAL_SHIFT, RECORD_RESTORATION_UNIT_WIENER_HORIZONTAL_SHIFT, isHorizontal);
    let tap0 = i32(getField(coefficients, shift, RECORD_RESTORATION_UNIT_WIENER_TAP_0_BITS)) - i32(RECORD_RESTORATION_UNIT_WIENER_TAP_0_BIAS);
    let tap1 = i32(getField(coefficients, shift + RECORD_RESTORATION_UNIT_WIENER_TAP_0_BITS, RECORD_RESTORATION_UNIT_WIENER_TAP_1_BITS))
        - i32(RECORD_RESTORATION_UNIT_WIENER_TAP_1_BIAS);
    let tap2 = i32(getField(coefficients, shift + RECORD_RESTORATION_UNIT_WIENER_TAP_0_BITS + RECORD_RESTORATION_UNIT_WIENER_TAP_1_BITS,
        RECORD_RESTORATION_UNIT_WIENER_TAP_2_BITS)) - i32(RECORD_RESTORATION_UNIT_WIENER_TAP_2_BIAS);
    return vec4i(tap0, tap1, tap2, -2 * (tap0 + tap1 + tap2));
}

// The self-guided set's two radii and strengths, from the tables
fn restorationGetSgrSet(setIndex: u32) -> vec4u {
    let word = frameData[filtersGetTablesOffset() + FILTERS_TABLE_SGR_SETS + setIndex];
    return vec4u(getField(word, 0u, FILTERS_TABLE_SGR_RADIUS_BITS), getField(word, FILTERS_TABLE_SGR_RADIUS_1_SHIFT, FILTERS_TABLE_SGR_RADIUS_BITS),
        getField(word, FILTERS_TABLE_SGR_STRENGTH_0_SHIFT, FILTERS_TABLE_SGR_STRENGTH_BITS),
        getField(word, FILTERS_TABLE_SGR_STRENGTH_1_SHIFT, FILTERS_TABLE_SGR_STRENGTH_BITS));
}

// Restores the 64x64 luma area (x, y) of plane z, from the restoration source to its target, which receives every sample of the area
// inside the plane: restored units, and the source in units, or planes, without restoration
fn restorationFilterUnit(workgroup: vec3u, lane: u32) {
    restorationRestoreArea(workgroup, lane);
}

// The segment layout: 16 rows of outputs, a tile of 3 more rows around them and 4 more columns (3 used), packed A and B arrays,
// dense work lists for the narrower chroma areas

const RESTORATION_SEGMENT_ROWS: u32 = 16u;
const RESTORATION_TILE_ROWS: u32 = 22u;
const RESTORATION_TILE_WORDS: u32 = 1584u;
// Packed A and B words: radius 1 for 18 rows, radius 2 for 9 odd rows, each 66 columns; the Wiener pass's 22 rows of 64 fit too
const RESTORATION_PACKED_RADIUS_1: u32 = 0u;
const RESTORATION_PACKED_RADIUS_2: u32 = 1188u;
const RESTORATION_PACKED_WORDS: u32 = 1782u;
// A word: A (1 to 256) in the low 9 bits, B (below 2^20) above
const RESTORATION_PACKED_BLEND_BITS: u32 = 9u;
const RESTORATION_PACKED_BLEND_MASK: u32 = 511u;
// A tile row's source: a word index of the frames buffer, or with this bit, of the saved boundary rows in frameData
const RESTORATION_ROW_FROM_BOUNDARY: u32 = 0x80000000u;
// The A and B columns of a luma-wide area (64 samples) and a chroma-wide one (32)
const RESTORATION_WIDE_AB_COLUMNS: u32 = 66u;
const RESTORATION_NARROW_AB_COLUMNS: u32 = 34u;
// The tile's sample pairs per row of a luma-wide area and a chroma-wide one, and the pairs an invocation loads per round
const RESTORATION_WIDE_TILE_PAIRS: u32 = 36u;
const RESTORATION_NARROW_TILE_PAIRS: u32 = 20u;
const RESTORATION_TILE_BATCH: u32 = 4u;

var<workgroup> restorationTile: array<i32, RESTORATION_TILE_WORDS>;
var<workgroup> restorationPacked: array<u32, RESTORATION_PACKED_WORDS>;
var<workgroup> restorationRowSources: array<u32, RESTORATION_TILE_ROWS>;
var<workgroup> restorationBlendFactors: array<u32, FILTERS_TABLE_BLEND_WORDS>;
var<workgroup> restorationControl: u32;

// The segment tile sample at segment-relative (row, column), rows from -3 and columns from -4
fn restorationReadTile(row: i32, column: i32) -> i32 {
    return restorationTile[u32(row + i32(RESTORATION_REACH)) * RESTORATION_TILE_COLUMNS + u32(column + i32(RESTORATION_TILE_LEFT))];
}

// A word of a tile row's source: the frames buffer, or the saved boundary rows in frameData
fn restorationReadSourceWord(rowSource: u32, word: u32) -> u32 {
    if ((rowSource & RESTORATION_ROW_FROM_BOUNDARY) != 0u) {
        return frameData[(rowSource & ~RESTORATION_ROW_FROM_BOUNDARY) + word];
    }
    return frames[rowSource + word];
}

// The two samples of tile pair index (row-major, tile columns from -4), columns clamped to the plane
fn restorationLoadTilePair(index: u32, isWide: bool, areaX: u32, lastColumn: i32) -> vec2u {
    let tileRow = select(index / RESTORATION_NARROW_TILE_PAIRS, index / RESTORATION_WIDE_TILE_PAIRS, isWide);
    let tilePairs = select(RESTORATION_NARROW_TILE_PAIRS, RESTORATION_WIDE_TILE_PAIRS, isWide);
    let x = i32(areaX + ((index - tileRow * tilePairs) << SAMPLE_PAIR_SHIFT)) - i32(RESTORATION_TILE_LEFT);
    let rowSource = restorationRowSources[tileRow];
    let firstX = u32(clamp(x, 0, lastColumn));
    let secondX = u32(clamp(x + 1, 0, lastColumn));
    let firstWord = restorationReadSourceWord(rowSource, firstX >> SAMPLE_PAIR_SHIFT);
    let secondWord = restorationReadSourceWord(rowSource, secondX >> SAMPLE_PAIR_SHIFT);
    return vec2u((firstWord >> ((firstX & 1u) * SAMPLE_HALF_BITS)) & SAMPLE_HALF_MASK,
        (secondWord >> ((secondX & 1u) * SAMPLE_HALF_BITS)) & SAMPLE_HALF_MASK);
}

// Writes tile pair index's two samples, when the tile has the pair
fn restorationStoreTilePair(index: u32, tilePairCount: u32, isWide: bool, samples: vec2u) {
    if (index >= tilePairCount) {
        return;
    }
    let tileRow = select(index / RESTORATION_NARROW_TILE_PAIRS, index / RESTORATION_WIDE_TILE_PAIRS, isWide);
    let tilePairs = select(RESTORATION_NARROW_TILE_PAIRS, RESTORATION_WIDE_TILE_PAIRS, isWide);
    let tileIndex = tileRow * RESTORATION_TILE_COLUMNS + ((index - tileRow * tilePairs) << SAMPLE_PAIR_SHIFT);
    restorationTile[tileIndex] = i32(samples.x);
    restorationTile[tileIndex + 1u] = i32(samples.y);
}

// calculate_intermediate_result for one position of the segment tile: A and B of a radius's box, packed
fn restorationComputeBox(row: i32, column: i32, radius: u32, strength: u32) -> u32 {
    var sum = 0u;
    var squares = 0u;
    let reach = i32(radius);
    for (var rowOffset = -reach; rowOffset <= reach; rowOffset += 1) {
        for (var columnOffset = -reach; columnOffset <= reach; columnOffset += 1) {
            let sample = u32(restorationReadTile(row + rowOffset, column + columnOffset));
            sum += sample;
            squares += sample * sample;
        }
    }
    let depthShift = OUTPUT_BIT_DEPTH - 8u;
    let count = select(25u, 9u, radius == 1u);
    let scaledSquares = (squares + ((1u << (2u * depthShift)) >> 1u)) >> (2u * depthShift);
    let scaledSum = (sum + ((1u << depthShift) >> 1u)) >> depthShift;
    var deviation = 0u;
    if (scaledSquares * count >= scaledSum * scaledSum) {
        deviation = scaledSquares * count - scaledSum * scaledSum;
    }
    let level = (deviation * strength + (1u << (RESTORATION_SGR_STRENGTH_BITS - 1u))) >> RESTORATION_SGR_STRENGTH_BITS;
    let blend = restorationBlendFactors[min(level, RESTORATION_SGR_BLEND_LIMIT)];
    let reciprocal = select(RESTORATION_SGR_RECIPROCAL_25, RESTORATION_SGR_RECIPROCAL_9, radius == 1u);
    let offset = ((RESTORATION_SGR_ONE - blend) * sum * reciprocal + (1u << (RESTORATION_SGR_RECIPROCAL_BITS - 1u))) >> RESTORATION_SGR_RECIPROCAL_BITS;
    return blend | (offset << RESTORATION_PACKED_BLEND_BITS);
}

// A packed word's A (x) and B (y)
fn restorationUnpack(word: u32) -> vec2i {
    return vec2i(i32(word & RESTORATION_PACKED_BLEND_MASK), i32(word >> RESTORATION_PACKED_BLEND_BITS));
}

// Restores the 64x64 luma area (x, y) of plane z, from the restoration source to its target, in segments of at most 16 rows
fn restorationRestoreArea(workgroup: vec3u, lane: u32) {
    let plane = workgroup.z;
    let subsamplingX = filtersGetSubsamplingX(plane);
    let subsamplingY = filtersGetSubsamplingY(plane);
    let areaWidth = 1u << (FILTERS_AREA_SIZE_LOG2 - subsamplingX);
    let areaHeight = 1u << (FILTERS_AREA_SIZE_LOG2 - subsamplingY);
    let areaX = workgroup.x * areaWidth;
    let areaY = workgroup.y * areaHeight;
    let planeWidth = getUpscaledPlaneWidth(plane);
    let planeHeight = getFramePlaneHeight(plane);
    if (lane == 0u) {
        var mode = RESTORATION_MODE_NONE;
        if (isDecodingFrame() && readRecordWord(RECORD_HEADER_RESTORATION_SOURCE) != RECORD_MISSING && filtersHasPlane(plane)
            && areaX < planeWidth && areaY < planeHeight) {
            mode = select(RESTORATION_MODE_COPY, RESTORATION_MODE_FILTER,
                restorationReadPlaneWord(plane, RECORD_RESTORATION_TYPE) != RESTORATION_TYPE_NONE);
        }
        restorationControl = mode;
    }
    let mode = workgroupUniformLoad(&restorationControl);
    if (mode == RESTORATION_MODE_NONE) {
        return;
    }
    let sourceBuffer = readRecordWord(RECORD_HEADER_RESTORATION_SOURCE);
    let targetBuffer = readRecordWord(RECORD_HEADER_RESTORATION_TARGET);
    let areaEnd = min(areaY + areaHeight, planeHeight);
    let pairsPerRowLog2 = FILTERS_AREA_SIZE_LOG2 - SAMPLE_PAIR_SHIFT - subsamplingX;
    let targetBase = getStoreWordIndex(targetBuffer, plane, 0u, 0u);
    let sourceBase = getStoreWordIndex(sourceBuffer, plane, 0u, 0u);
    let rowWords = getStorePlaneWidth(plane) >> SAMPLE_PAIR_SHIFT;
    if (mode == RESTORATION_MODE_COPY) {
        filtersCopyArea(sourceBase, targetBase, rowWords, areaX, areaY, areaEnd, pairsPerRowLog2, planeWidth, lane);
        return;
    }
    // The blend factors (FILTERS_TABLE_BLEND_WORDS, four per invocation), loaded together
    let blendBase = filtersGetTablesOffset() + FILTERS_TABLE_BLEND + lane;
    let blendFactor0 = frameData[blendBase];
    let blendFactor1 = frameData[blendBase + FILTERS_WORKGROUP_SIZE];
    let blendFactor2 = frameData[blendBase + 2u * FILTERS_WORKGROUP_SIZE];
    let blendFactor3 = frameData[blendBase + 3u * FILTERS_WORKGROUP_SIZE];
    restorationBlendFactors[lane] = blendFactor0;
    restorationBlendFactors[lane + FILTERS_WORKGROUP_SIZE] = blendFactor1;
    restorationBlendFactors[lane + 2u * FILTERS_WORKGROUP_SIZE] = blendFactor2;
    restorationBlendFactors[lane + 3u * FILTERS_WORKGROUP_SIZE] = blendFactor3;
    let isWide = subsamplingX == 0u;
    let tilePairs = select(RESTORATION_NARROW_TILE_PAIRS, RESTORATION_WIDE_TILE_PAIRS, isWide);
    let abColumns = select(RESTORATION_NARROW_AB_COLUMNS, RESTORATION_WIDE_AB_COLUMNS, isWide);
    let stripeGeometry = restorationGetStripeGeometry(plane);
    let stripeHeightLog2 = RESTORATION_STRIPE_HEIGHT_LOG2 - subsamplingY;
    let unitSizeLog2 = firstTrailingBit(restorationReadPlaneWord(plane, RECORD_RESTORATION_UNIT_SIZE));
    let unitColumn = min(areaX >> unitSizeLog2, restorationReadPlaneWord(plane, RECORD_RESTORATION_HORIZONTAL_UNITS) - 1u);
    let highDepth = select(0u, 2u, OUTPUT_BIT_DEPTH > RESTORATION_WIENER_DEPTH_LIMIT);
    let roundHorizontal = RESTORATION_WIENER_ROUND_0 + highDepth;
    let roundVertical = RESTORATION_WIENER_ROUND_1 - highDepth;
    let sampleMaximum = (1 << OUTPUT_BIT_DEPTH) - 1;
    let lastColumn = i32(planeWidth) - 1;
    var segmentStart = areaY;
    while (segmentStart < areaEnd) {
        let stripe = (segmentStart + stripeGeometry.y) >> stripeHeightLog2;
        let stripeStart = u32(max(i32(stripe * stripeGeometry.x) - i32(stripeGeometry.y), 0));
        let stripeEnd = min((stripe + 1u) * stripeGeometry.x - stripeGeometry.y, planeHeight);
        let segmentEnd = min(min(segmentStart + RESTORATION_SEGMENT_ROWS, areaEnd), stripeEnd);
        let segmentRows = segmentEnd - segmentStart;
        let unitWord = restorationReadUnitWord(plane, unitColumn, segmentStart, stripeGeometry.y, 0u);
        let unitType = getField(unitWord, RECORD_RESTORATION_UNIT_TYPE_SHIFT, RECORD_RESTORATION_UNIT_TYPE_BITS);
        let segmentPairs = segmentRows << pairsPerRowLog2;
        if (unitType == RESTORATION_TYPE_NONE) {
            filtersCopyArea(sourceBase, targetBase, rowWords, areaX, segmentStart, segmentEnd, pairsPerRowLog2, planeWidth, lane);
            segmentStart = segmentEnd;
            continue;
        }
        // Each tile row's source as the stripe sees it: the source inside; outside, the saved deblocked rows (above r0, r0, r1, below
        // r2, r3, r3), or the source's first or last row at the plane's top and bottom
        let tileRows = segmentRows + 2u * RESTORATION_REACH;
        if (lane < tileRows) {
            let row = i32(segmentStart + lane) - i32(RESTORATION_REACH);
            var rowSource = sourceBase + u32(clamp(row, 0, i32(planeHeight) - 1)) * rowWords;
            if (row < i32(stripeStart) && stripeStart != 0u) {
                rowSource = restorationGetBoundaryWord(plane, stripe, select(0u, 1u, row == i32(stripeStart) - 1), 0u) | RESTORATION_ROW_FROM_BOUNDARY;
            } else if (row >= i32(stripeEnd) && stripeEnd < planeHeight) {
                rowSource = restorationGetBoundaryWord(plane, stripe, select(3u, 2u, row == i32(stripeEnd)), 0u) | RESTORATION_ROW_FROM_BOUNDARY;
            }
            restorationRowSources[lane] = rowSource;
        }
        workgroupBarrier();
        // The tile a sample pair at a time, four pairs per round so their loads overlap; indices past the tile load its last pair
        let tilePairCount = tileRows * tilePairs;
        let lastPair = tilePairCount - 1u;
        for (var first = lane; first < tilePairCount; first += RESTORATION_TILE_BATCH * FILTERS_WORKGROUP_SIZE) {
            let samples0 = restorationLoadTilePair(first, isWide, areaX, lastColumn);
            let samples1 = restorationLoadTilePair(min(first + FILTERS_WORKGROUP_SIZE, lastPair), isWide, areaX, lastColumn);
            let samples2 = restorationLoadTilePair(min(first + 2u * FILTERS_WORKGROUP_SIZE, lastPair), isWide, areaX, lastColumn);
            let samples3 = restorationLoadTilePair(min(first + 3u * FILTERS_WORKGROUP_SIZE, lastPair), isWide, areaX, lastColumn);
            restorationStoreTilePair(first, tilePairCount, isWide, samples0);
            restorationStoreTilePair(first + FILTERS_WORKGROUP_SIZE, tilePairCount, isWide, samples1);
            restorationStoreTilePair(first + 2u * FILTERS_WORKGROUP_SIZE, tilePairCount, isWide, samples2);
            restorationStoreTilePair(first + 3u * FILTERS_WORKGROUP_SIZE, tilePairCount, isWide, samples3);
        }
        workgroupBarrier();
        if (unitType == RESTORATION_TYPE_WIENER) {
            // The horizontal pass over every tile row, kept in 16 bits (highbd_convolve_add_src_horiz_hip)
            let coefficients = restorationReadUnitWord(plane, unitColumn, segmentStart, stripeGeometry.y, 1u);
            let horizontalTaps = restorationGetWienerTaps(coefficients, true);
            let horizontalLimit = (1 << (OUTPUT_BIT_DEPTH + 1u + RESTORATION_WIENER_BITS - roundHorizontal)) - 1;
            let columnsLog2 = FILTERS_AREA_SIZE_LOG2 - subsamplingX;
            for (var index = lane; index < tileRows << columnsLog2; index += FILTERS_WORKGROUP_SIZE) {
                let row = i32(index >> columnsLog2) - i32(RESTORATION_REACH);
                let column = i32(index & (areaWidth - 1u));
                let center = restorationReadTile(row, column);
                let sum = (center << RESTORATION_WIENER_BITS) + (1 << (OUTPUT_BIT_DEPTH + RESTORATION_WIENER_BITS - 1u))
                    + horizontalTaps.x * (restorationReadTile(row, column - 3) + restorationReadTile(row, column + 3))
                    + horizontalTaps.y * (restorationReadTile(row, column - 2) + restorationReadTile(row, column + 2))
                    + horizontalTaps.z * (restorationReadTile(row, column - 1) + restorationReadTile(row, column + 1))
                    + horizontalTaps.w * center;
                restorationPacked[index] = u32(clamp((sum + (1 << (roundHorizontal - 1u))) >> roundHorizontal, 0, horizontalLimit));
            }
            workgroupBarrier();
            // The vertical pass, two samples per word (highbd_convolve_add_src_vert_hip)
            let verticalTaps = restorationGetWienerTaps(coefficients, false);
            for (var pair = lane; pair < segmentPairs; pair += FILTERS_WORKGROUP_SIZE) {
                let column = (pair & ((1u << pairsPerRowLog2) - 1u)) << SAMPLE_PAIR_SHIFT;
                let row = pair >> pairsPerRowLog2;
                var word = 0u;
                for (var half = 0u; half < 2u; half += 1u) {
                    let center = (row + RESTORATION_REACH) * areaWidth + column + half;
                    let centerValue = i32(restorationPacked[center]);
                    let sum = (centerValue << RESTORATION_WIENER_BITS) - (1 << (OUTPUT_BIT_DEPTH + roundVertical - 1u))
                        + verticalTaps.x * (i32(restorationPacked[center - 3u * areaWidth]) + i32(restorationPacked[center + 3u * areaWidth]))
                        + verticalTaps.y * (i32(restorationPacked[center - 2u * areaWidth]) + i32(restorationPacked[center + 2u * areaWidth]))
                        + verticalTaps.z * (i32(restorationPacked[center - areaWidth]) + i32(restorationPacked[center + areaWidth]))
                        + verticalTaps.w * centerValue;
                    let value = clamp((sum + (1 << (roundVertical - 1u))) >> roundVertical, 0, sampleMaximum);
                    word |= u32(value) << (half * SAMPLE_HALF_BITS);
                }
                if (areaX + column < planeWidth) {
                    frames[targetBase + (segmentStart + row) * rowWords + ((areaX + column) >> SAMPLE_PAIR_SHIFT)] = word;
                }
            }
        } else {
            // The self-guided filter: the packed A and B of each enabled radius, then the outputs
            let sgrParameters = restorationGetSgrSet(getField(unitWord, RECORD_RESTORATION_UNIT_SGR_SET_SHIFT, RECORD_RESTORATION_UNIT_SGR_SET_BITS));
            // Radius 2's odd rows from the one above the segment through the one at or below its last row
            let radius2Rows = (segmentRows + 3u) >> 1u;
            if (sgrParameters.x > 0u) {
                for (var index = lane; index < radius2Rows * abColumns; index += FILTERS_WORKGROUP_SIZE) {
                    let abRow = select(index / RESTORATION_NARROW_AB_COLUMNS, index / RESTORATION_WIDE_AB_COLUMNS, isWide);
                    let abColumn = index - abRow * abColumns;
                    restorationPacked[RESTORATION_PACKED_RADIUS_2 + abRow * RESTORATION_AB_COLUMNS + abColumn] =
                        restorationComputeBox(i32(abRow * 2u) - 1, i32(abColumn) - 1, 2u, sgrParameters.z);
                }
            }
            if (sgrParameters.y > 0u) {
                for (var index = lane; index < (segmentRows + 2u) * abColumns; index += FILTERS_WORKGROUP_SIZE) {
                    let abRow = select(index / RESTORATION_NARROW_AB_COLUMNS, index / RESTORATION_WIDE_AB_COLUMNS, isWide);
                    let abColumn = index - abRow * abColumns;
                    restorationPacked[RESTORATION_PACKED_RADIUS_1 + abRow * RESTORATION_AB_COLUMNS + abColumn] =
                        restorationComputeBox(i32(abRow) - 1, i32(abColumn) - 1, 1u, sgrParameters.w);
                }
            }
            workgroupBarrier();
            // av1_decode_xq: the projection weights
            let weight0 = i32(getField(unitWord, RECORD_RESTORATION_UNIT_SGR_WEIGHT_0_SHIFT, RECORD_RESTORATION_UNIT_SGR_WEIGHT_BITS))
                - i32(RECORD_RESTORATION_UNIT_SGR_WEIGHT_0_BIAS);
            let weight1 = i32(getField(unitWord, RECORD_RESTORATION_UNIT_SGR_WEIGHT_1_SHIFT, RECORD_RESTORATION_UNIT_SGR_WEIGHT_BITS))
                - i32(RECORD_RESTORATION_UNIT_SGR_WEIGHT_1_BIAS);
            var projection0 = weight0;
            var projection1 = (1 << RESTORATION_SGR_PROJECTION_BITS) - projection0 - weight1;
            if (sgrParameters.x == 0u) {
                projection0 = 0;
                projection1 = (1 << RESTORATION_SGR_PROJECTION_BITS) - weight1;
            } else if (sgrParameters.y == 0u) {
                projection1 = 0;
            }
            for (var pair = lane; pair < segmentPairs; pair += FILTERS_WORKGROUP_SIZE) {
                let column = (pair & ((1u << pairsPerRowLog2) - 1u)) << SAMPLE_PAIR_SHIFT;
                let row = pair >> pairsPerRowLog2;
                var word = 0u;
                for (var half = 0u; half < 2u; half += 1u) {
                    let x = column + half;
                    let sample = restorationReadTile(i32(row), i32(x));
                    let scaled = sample << RESTORATION_SGR_SOURCE_BITS;
                    var value = scaled << RESTORATION_SGR_PROJECTION_BITS;
                    if (sgrParameters.x > 0u) {
                        // selfguided_restoration_fast_internal: odd rows weigh their own A and B row, even rows the rows around
                        var weighted = vec2i(0);
                        var shift = RESTORATION_SGR_BITS + 5u - RESTORATION_SGR_SOURCE_BITS;
                        if ((row & 1u) == 1u) {
                            let center = RESTORATION_PACKED_RADIUS_2 + ((row + 1u) >> 1u) * RESTORATION_AB_COLUMNS + x + 1u;
                            weighted = restorationUnpack(restorationPacked[center]) * 6
                                + (restorationUnpack(restorationPacked[center - 1u]) + restorationUnpack(restorationPacked[center + 1u])) * 5;
                            shift = RESTORATION_SGR_BITS + 4u - RESTORATION_SGR_SOURCE_BITS;
                        } else {
                            let above = RESTORATION_PACKED_RADIUS_2 + (row >> 1u) * RESTORATION_AB_COLUMNS + x + 1u;
                            let below = above + RESTORATION_AB_COLUMNS;
                            weighted = (restorationUnpack(restorationPacked[above]) + restorationUnpack(restorationPacked[below])) * 6
                                + (restorationUnpack(restorationPacked[above - 1u]) + restorationUnpack(restorationPacked[above + 1u])
                                + restorationUnpack(restorationPacked[below - 1u]) + restorationUnpack(restorationPacked[below + 1u])) * 5;
                        }
                        let filtered = (weighted.x * sample + weighted.y + (1 << (shift - 1u))) >> shift;
                        value += projection0 * (filtered - scaled);
                    }
                    if (sgrParameters.y > 0u) {
                        // selfguided_restoration_internal: the cross weighs 4, the corners 3
                        let center = RESTORATION_PACKED_RADIUS_1 + (row + 1u) * RESTORATION_AB_COLUMNS + x + 1u;
                        let weighted = (restorationUnpack(restorationPacked[center]) + restorationUnpack(restorationPacked[center - 1u])
                            + restorationUnpack(restorationPacked[center + 1u]) + restorationUnpack(restorationPacked[center - RESTORATION_AB_COLUMNS])
                            + restorationUnpack(restorationPacked[center + RESTORATION_AB_COLUMNS])) * 4
                            + (restorationUnpack(restorationPacked[center - RESTORATION_AB_COLUMNS - 1u])
                            + restorationUnpack(restorationPacked[center - RESTORATION_AB_COLUMNS + 1u])
                            + restorationUnpack(restorationPacked[center + RESTORATION_AB_COLUMNS - 1u])
                            + restorationUnpack(restorationPacked[center + RESTORATION_AB_COLUMNS + 1u])) * 3;
                        let shift = RESTORATION_SGR_BITS + 5u - RESTORATION_SGR_SOURCE_BITS;
                        let filtered = (weighted.x * sample + weighted.y + (1 << (shift - 1u))) >> shift;
                        value += projection1 * (filtered - scaled);
                    }
                    // av1_apply_selfguided_restoration_c rounds into an int16_t before clipping
                    let roundShift = RESTORATION_SGR_PROJECTION_BITS + RESTORATION_SGR_SOURCE_BITS;
                    let rounded = (value + (1 << (roundShift - 1u))) >> roundShift;
                    let narrowed = (rounded << 16u) >> 16u;
                    word |= u32(clamp(narrowed, 0, sampleMaximum)) << (half * SAMPLE_HALF_BITS);
                }
                if (areaX + column < planeWidth) {
                    frames[targetBase + (segmentStart + row) * rowWords + ((areaX + column) >> SAMPLE_PAIR_SHIFT)] = word;
                }
            }
        }
        workgroupBarrier();
        segmentStart = segmentEnd;
    }
}
