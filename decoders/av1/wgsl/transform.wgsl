// AV1 transform family: inverse transforms, the lossless Walsh-Hadamard transform included, reconstruction add and clip, film grain
// synthesis, and the output copy. Owner: av1-gpu-transform; scratch/av1/DESIGN.md specifies its functions, prefixes, and record fields.
// libaom (av1/common/av1_inv_txfm1d.c, av1_inv_txfm2d.c, idct.c, av1/decoder/grain_synthesis.c) is the reference for every result.

// Inverse transforms. A workgroup takes consecutive transform jobs in chunks and runs a chunk in rounds of jobs that share its lanes
// and memory: each job's lanes decode its coefficients into workgroup memory, run one 1D transform per row and then per column, each
// lane holding its whole line in registers, and write the block. Every 1D transform follows libaom's flow graph, so its roundings and
// clamps are libaom's for every input.

// The family's workgroup size, which every entry point that calls it declares
const TRANSFORM_LANES: u32 = 64u;

// libaom's INV_COS_BIT: the cosines' and sines' precision, and half_btf's rounding
const TRANSFORM_COSINE_BITS: u32 = 12u;
const TRANSFORM_COSINE_ROUNDING: i32 = 2048;
const TRANSFORM_COSINE_FRACTION_MASK: i32 = 4095;
// av1_cospi_arr_data for INV_COS_BIT (av1/common/av1_txfm.c): round(cos(PI * j / 128) * 4096)
const TRANSFORM_COSINES = array<i32, 64>(
    4096, 4095, 4091, 4085, 4076, 4065, 4052, 4036, 4017, 3996, 3973, 3948, 3920, 3889, 3857, 3822,
    3784, 3745, 3703, 3659, 3612, 3564, 3513, 3461, 3406, 3349, 3290, 3229, 3166, 3102, 3035, 2967,
    2896, 2824, 2751, 2675, 2598, 2520, 2440, 2359, 2276, 2191, 2106, 2019, 1931, 1842, 1751, 1660,
    1567, 1474, 1380, 1285, 1189, 1092, 995, 897, 799, 700, 601, 501, 401, 301, 201, 101
);
// av1_sinpi_arr_data for INV_COS_BIT (av1/common/av1_txfm.c): the 4-point ADST's sines
const TRANSFORM_SINES = array<i32, 5>(0, 1321, 2482, 3344, 3803);
// NewSqrt2 and NewInvSqrt2 at NewSqrt2Bits (av1/common/av1_txfm.h): the identity transforms' and 2:1 rectangular rows' scales
const TRANSFORM_SQRT2: i32 = 5793;
const TRANSFORM_INVERSE_SQRT2: i32 = 2896;
const TRANSFORM_SQRT2_BITS: u32 = 12u;
const TRANSFORM_SQRT2_ROUNDING: i32 = 2048;
// av1_iidentity8_c and av1_iidentity32_c scale by 2 and 4
const TRANSFORM_IDENTITY8_SCALE: i32 = 2;
const TRANSFORM_IDENTITY32_SCALE: i32 = 4;
// UNIT_QUANT_SHIFT (aom_dsp/txfm_common.h): the lossless rows' input shift
const TRANSFORM_LOSSLESS_INPUT_SHIFT: u32 = 2u;
// The column pass's output round shift, -av1_inv_txfm_shift_ls[size][1] for every size
const TRANSFORM_COLUMN_SHIFT: u32 = 4u;
const TRANSFORM_COLUMN_ROUNDING: i32 = 8;
// -av1_inv_txfm_shift_ls[size][0] (av1/common/av1_inv_txfm2d.c), two bits per TX_SIZE: the row pass's output round shift
const TRANSFORM_ROW_SHIFTS_LOW: u32 = 0x955542A4u;
const TRANSFORM_ROW_SHIFTS_HIGH: u32 = 0x2Au;
const TRANSFORM_ROW_SHIFTS_LOW_SIZES: u32 = 16u;
const TRANSFORM_ROW_SHIFT_MASK: u32 = 3u;
// The row pass clamps its inputs and every stage to BitDepth + 8 bits, the column pass to Max(BitDepth + 6, 16) bits
// (av1_gen_inv_stage_range and inv_txfm2d_add_c); libaom's dqcoeff, the job's coefficients, fit the row range
const TRANSFORM_ROW_RANGE_BITS: u32 = OUTPUT_BIT_DEPTH + 8u;
const TRANSFORM_COLUMN_RANGE_BITS: u32 = max(OUTPUT_BIT_DEPTH + 6u, 16u);
const TRANSFORM_ROW_HIGH: i32 = (1 << (TRANSFORM_ROW_RANGE_BITS - 1u)) - 1;
const TRANSFORM_ROW_LOW: i32 = -(1 << (TRANSFORM_ROW_RANGE_BITS - 1u));
const TRANSFORM_COLUMN_HIGH: i32 = (1 << (TRANSFORM_COLUMN_RANGE_BITS - 1u)) - 1;
const TRANSFORM_COLUMN_LOW: i32 = -(1 << (TRANSFORM_COLUMN_RANGE_BITS - 1u));
// The lossless Walsh-Hadamard transform clamps nothing
const TRANSFORM_UNCLAMPED_HIGH: i32 = 2147483647;
const TRANSFORM_UNCLAMPED_LOW: i32 = -2147483647 - 1;
// half_btf's two products each fit 32 bits (weights below 4096, values within 20 bits); their sum needs 33 bits only when rows hold
// 20-bit values, at 12 bits, which then splits each product at INV_COS_BIT
const TRANSFORM_WIDE_SUMS: bool = TRANSFORM_ROW_RANGE_BITS > 18u;
// Residuals saturate to 16 bits, which clip(prediction + residual) never notices
const TRANSFORM_RESIDUAL_HIGH: i32 = 32767;
const TRANSFORM_RESIDUAL_LOW: i32 = -32768;
const TRANSFORM_HALF_BITS: u32 = 16u;
const TRANSFORM_HALF_MASK: u32 = 65535u;

// The 1D transforms, in libaom's TXFM_TYPE order, then the lossless Walsh-Hadamard transform
const TRANSFORM_KIND_DCT4: u32 = 0u;
const TRANSFORM_KIND_DCT8: u32 = 1u;
const TRANSFORM_KIND_DCT16: u32 = 2u;
const TRANSFORM_KIND_DCT32: u32 = 3u;
const TRANSFORM_KIND_DCT64: u32 = 4u;
const TRANSFORM_KIND_ADST4: u32 = 5u;
const TRANSFORM_KIND_ADST8: u32 = 6u;
const TRANSFORM_KIND_ADST16: u32 = 7u;
const TRANSFORM_KIND_IDENTITY4: u32 = 8u;
const TRANSFORM_KIND_IDENTITY8: u32 = 9u;
const TRANSFORM_KIND_IDENTITY16: u32 = 10u;
const TRANSFORM_KIND_IDENTITY32: u32 = 11u;
const TRANSFORM_KIND_WALSH_HADAMARD4: u32 = 12u;
// libaom's TX_TYPE_1D, and vtx_tab and htx_tab (av1/common/common_data.h) at two bits per TX_TYPE: the column and row 1D types
const TRANSFORM_1D_DCT: u32 = 0u;
const TRANSFORM_1D_FLIPADST: u32 = 2u;
const TRANSFORM_1D_IDENTITY: u32 = 3u;
const TRANSFORM_1D_TYPE_BITS: u32 = 2u;
// libaom's TX_TYPE DCT_DCT, the only type of sizes with a 64-point side
const TRANSFORM_TYPE_DCT_DCT: u32 = 0u;
const TRANSFORM_COLUMN_TYPES: u32 = 0xEDCE6244u;
const TRANSFORM_ROW_TYPES: u32 = 0xB73DA850u;
const TRANSFORM_SMALLEST_SIDE_LOG2: u32 = 2u;

// The transform job's one-bit fields (lossless, destination, sparse)
const TRANSFORM_JOB_FLAG_BITS: u32 = 1u;
// Coefficients are coded in the transform's top-left 32x32 at most, so a 64-point line's inputs past 32 are zero; values carry at
// most 20 bits (BitDepth + 8)
const TRANSFORM_MAXIMUM_CODED_SIDE_LOG2: u32 = 5u;
const TRANSFORM_UNCODED_INPUT: i32 = 0;
const TRANSFORM_MAXIMUM_VALUE_BITS: u32 = 20u;
const TRANSFORM_WORD_BITS: u32 = 32u;
const TRANSFORM_WORD_BIT_MASK: u32 = 31u;
const TRANSFORM_WORD_SHIFT: u32 = 5u;
const TRANSFORM_PASSES: u32 = 2u;
const TRANSFORM_ROW_PASS: u32 = 0u;
// A lane decodes four coefficients and writes two output words per pass, their reads issued together
const TRANSFORM_DECODE_SLOTS: u32 = 4u;
const TRANSFORM_DECODE_MEMBERS = vec4u(0u, 1u, 2u, 3u);
const TRANSFORM_WRITE_WORDS: u32 = 2u;

// transformMemory: a round's lines from the bottom, where each job has the row pass's outputs in rows of its width + 1 (the padding
// keeps the lanes' accesses on distinct banks), which the column pass overwrites with its outputs packed in pairs of rows; and its
// staging from the top, where each job has its decoded coefficients in rows of its coded width + 1. A 64x64 job fills both (32 rows of
// 65 and of 33). A round's staging stays clear of the round before's lines, which that round still writes from while this one
// decodes, so rounds need no barrier between them
const TRANSFORM_MEMORY_WORDS: u32 = 3136u;
var<workgroup> transformMemory: array<i32, TRANSFORM_MEMORY_WORDS>;
var<workgroup> transformValid: u32;
// A chunk's plan: per job its round, first lane, lane count, and lines and staging offsets (packed in halves), and its record words;
// per round its lanes; then the round count, with the rounds that hold a sparse job as bits from TRANSFORM_PLAN_SPARSE_SHIFT on. A
// round's spare lanes go to its jobs, each job's lanes scaled by one power of two, for their decode and write loops
const TRANSFORM_CHUNK_JOBS: u32 = 16u;
const TRANSFORM_PLAN_SPARSE_SHIFT: u32 = 16u;
const TRANSFORM_PLAN_ROUND_MASK: u32 = 65535u;
// The round of a job another run takes
const TRANSFORM_PLAN_SKIPPED: u32 = 0xFFFFFFFFu;
var<workgroup> transformPlan: array<vec4u, TRANSFORM_CHUNK_JOBS>;
var<workgroup> transformJobWords: array<vec3u, TRANSFORM_CHUNK_JOBS>;
var<workgroup> transformRoundLanes: array<u32, TRANSFORM_CHUNK_JOBS>;
var<workgroup> transformRounds: u32;
// The jobs a run takes: the jobs without a 64-point side, which the record lists first, or the jobs with one, from the header's
// RECORD_HEADER_TRANSFORM_LARGE_JOB on
const TRANSFORM_JOBS_SMALL: u32 = 1u;
const TRANSFORM_JOBS_LARGE: u32 = 2u;
const TRANSFORM_LARGE_SIDE_LOG2: u32 = 6u;

// A transform job's fields, decoded once per job
struct TransformJob {
    plane: u32,
    originX: u32,
    originY: u32,
    transformSize: u32,
    widthLog2: u32,
    heightLog2: u32,
    codedWidthLog2: u32,
    codedHeightLog2: u32,
    rowKind: u32,
    columnKind: u32,
    flipRows: bool,
    flipColumns: bool,
    lossless: bool,
    destination: u32,
    sparse: bool,
    valueBits: u32,
    payload: u32,
    // Dense: the coded box; sparse: the entry count
    payloadColumns: u32,
    payloadRows: u32,
    entryCount: u32,
    // The rows and columns whose coefficients may be nonzero, which the passes transform
    boxColumns: u32,
    boxRows: u32,
    // The job's places in transformMemory for its round: its lines, and its staging rows and their stride
    linesBase: u32,
    stagingBase: u32,
    stagingStride: u32,
}

// One lane's line of a pass: where it reads its inputs and writes its outputs in transformMemory, and the pass's value processing
struct TransformLine {
    inputBase: u32,
    inputStride: u32,
    // Inputs at or past the count are zero
    inputCount: u32,
    outputBase: u32,
    outputStride: u32,
    // The column pass saturates its outputs to 16 bits and packs them in pairs
    packOutputs: bool,
    inputMultiplier: i32,
    inputRounding: i32,
    inputShift: u32,
    clampLow: i32,
    clampHigh: i32,
    outputRounding: i32,
    outputShift: u32,
}

// A line's input: zero at or past its count, then the pass's scaling (round_shift(input * NewInvSqrt2) for 2:1 rows,
// UNIT_QUANT_SHIFT for lossless rows) and clamp (clamp_buf)
fn transformLoad(line: TransformLine, index: u32) -> i32 {
    let stored = transformMemory[line.inputBase + min(index, line.inputCount - 1u) * line.inputStride];
    let value = select(0, stored, index < line.inputCount);
    return clamp((value * line.inputMultiplier + line.inputRounding) >> line.inputShift, line.clampLow, line.clampHigh);
}

// libaom's clamp_value at the pass's stage range
fn transformClampStage(line: TransformLine, value: i32) -> i32 {
    return clamp(value, line.clampLow, line.clampHigh);
}

// libaom's half_btf: weight0 * value0 + weight1 * value1, rounded and shifted by INV_COS_BIT as its 64-bit sum gives it
fn transformRotate(weight0: i32, value0: i32, weight1: i32, value1: i32) -> i32 {
    let product0 = weight0 * value0;
    let product1 = weight1 * value1;
    if (!TRANSFORM_WIDE_SUMS) {
        return (product0 + product1 + TRANSFORM_COSINE_ROUNDING) >> TRANSFORM_COSINE_BITS;
    }
    let fractions = (product0 & TRANSFORM_COSINE_FRACTION_MASK) + (product1 & TRANSFORM_COSINE_FRACTION_MASK) + TRANSFORM_COSINE_ROUNDING;
    return (product0 >> TRANSFORM_COSINE_BITS) + (product1 >> TRANSFORM_COSINE_BITS) + (fractions >> TRANSFORM_COSINE_BITS);
}

// round_shift(sum of weights[k] * values[k], 12) as 64-bit arithmetic gives it, for weights below 2^14 and values within 20 bits:
// each value splits into its high part and its low 12 bits, so both partial sums fit 32 bits
fn transformDotRound(weights: vec4i, values: vec4i) -> i32 {
    let highSum = dot(weights, values >> vec4u(TRANSFORM_COSINE_BITS));
    let lowSum = dot(weights, values & vec4i(TRANSFORM_COSINE_FRACTION_MASK));
    return highSum + ((lowSum + TRANSFORM_COSINE_ROUNDING) >> TRANSFORM_COSINE_BITS);
}

// round_shift(weight * value, NewSqrt2Bits) as 64-bit arithmetic gives it
fn transformScaleRound(weight: i32, value: i32) -> i32 {
    let highPart = weight * (value >> TRANSFORM_SQRT2_BITS);
    let lowPart = weight * (value & TRANSFORM_COSINE_FRACTION_MASK);
    return highPart + ((lowPart + TRANSFORM_SQRT2_ROUNDING) >> TRANSFORM_SQRT2_BITS);
}

// Stores a line's outputs 2 * pairIndex and 2 * pairIndex + 1 after the pass's round shift (av1_round_shift_array): the row pass as
// two values of its line, the column pass saturated to 16 bits and packed into one word, rows 2k and 2k + 1 of the lane's column
fn transformStorePair(line: TransformLine, pairIndex: u32, first: i32, second: i32) {
    let firstOutput = (first + line.outputRounding) >> line.outputShift;
    let secondOutput = (second + line.outputRounding) >> line.outputShift;
    if (line.packOutputs) {
        let low = bitcast<u32>(clamp(firstOutput, TRANSFORM_RESIDUAL_LOW, TRANSFORM_RESIDUAL_HIGH)) & TRANSFORM_HALF_MASK;
        let high = bitcast<u32>(clamp(secondOutput, TRANSFORM_RESIDUAL_LOW, TRANSFORM_RESIDUAL_HIGH)) << TRANSFORM_HALF_BITS;
        transformMemory[line.outputBase + pairIndex * line.outputStride] = bitcast<i32>(low | high);
        return;
    }
    let address = line.outputBase + 2u * pairIndex * line.outputStride;
    transformMemory[address] = firstOutput;
    transformMemory[address + line.outputStride] = secondOutput;
}

// libaom's av1_idct4 (av1/common/av1_inv_txfm1d.c), transcribed stage by stage
fn transformInverseDCT4(line: TransformLine) {
    let input0 = transformLoad(line, 0u);
    let input1 = transformLoad(line, 1u);
    let input2 = transformLoad(line, 2u);
    let input3 = transformLoad(line, 3u);
    // Stage 2
    let stage2Value0 = transformRotate(TRANSFORM_COSINES[32], input0, TRANSFORM_COSINES[32], input2);
    let stage2Value1 = transformRotate(TRANSFORM_COSINES[32], input0, -TRANSFORM_COSINES[32], input2);
    let stage2Value2 = transformRotate(TRANSFORM_COSINES[48], input1, -TRANSFORM_COSINES[16], input3);
    let stage2Value3 = transformRotate(TRANSFORM_COSINES[16], input1, TRANSFORM_COSINES[48], input3);
    // Stage 3
    let stage3Value0 = transformClampStage(line, stage2Value0 + stage2Value3);
    let stage3Value1 = transformClampStage(line, stage2Value1 + stage2Value2);
    let stage3Value2 = transformClampStage(line, stage2Value1 - stage2Value2);
    let stage3Value3 = transformClampStage(line, stage2Value0 - stage2Value3);
    transformStorePair(line, 0u, stage3Value0, stage3Value1);
    transformStorePair(line, 1u, stage3Value2, stage3Value3);
}

// libaom's av1_idct8 (av1/common/av1_inv_txfm1d.c), transcribed stage by stage
fn transformInverseDCT8(line: TransformLine) {
    let input0 = transformLoad(line, 0u);
    let input1 = transformLoad(line, 1u);
    let input2 = transformLoad(line, 2u);
    let input3 = transformLoad(line, 3u);
    let input4 = transformLoad(line, 4u);
    let input5 = transformLoad(line, 5u);
    let input6 = transformLoad(line, 6u);
    let input7 = transformLoad(line, 7u);
    // Stage 2
    let stage2Value4 = transformRotate(TRANSFORM_COSINES[56], input1, -TRANSFORM_COSINES[8], input7);
    let stage2Value5 = transformRotate(TRANSFORM_COSINES[24], input5, -TRANSFORM_COSINES[40], input3);
    let stage2Value6 = transformRotate(TRANSFORM_COSINES[40], input5, TRANSFORM_COSINES[24], input3);
    let stage2Value7 = transformRotate(TRANSFORM_COSINES[8], input1, TRANSFORM_COSINES[56], input7);
    // Stage 3
    let stage3Value0 = transformRotate(TRANSFORM_COSINES[32], input0, TRANSFORM_COSINES[32], input4);
    let stage3Value1 = transformRotate(TRANSFORM_COSINES[32], input0, -TRANSFORM_COSINES[32], input4);
    let stage3Value2 = transformRotate(TRANSFORM_COSINES[48], input2, -TRANSFORM_COSINES[16], input6);
    let stage3Value3 = transformRotate(TRANSFORM_COSINES[16], input2, TRANSFORM_COSINES[48], input6);
    let stage3Value4 = transformClampStage(line, stage2Value4 + stage2Value5);
    let stage3Value5 = transformClampStage(line, stage2Value4 - stage2Value5);
    let stage3Value6 = transformClampStage(line, stage2Value7 - stage2Value6);
    let stage3Value7 = transformClampStage(line, stage2Value6 + stage2Value7);
    // Stage 4
    let stage4Value0 = transformClampStage(line, stage3Value0 + stage3Value3);
    let stage4Value1 = transformClampStage(line, stage3Value1 + stage3Value2);
    let stage4Value2 = transformClampStage(line, stage3Value1 - stage3Value2);
    let stage4Value3 = transformClampStage(line, stage3Value0 - stage3Value3);
    let stage4Value5 = transformRotate(-TRANSFORM_COSINES[32], stage3Value5, TRANSFORM_COSINES[32], stage3Value6);
    let stage4Value6 = transformRotate(TRANSFORM_COSINES[32], stage3Value5, TRANSFORM_COSINES[32], stage3Value6);
    // Stage 5
    let stage5Value0 = transformClampStage(line, stage4Value0 + stage3Value7);
    let stage5Value1 = transformClampStage(line, stage4Value1 + stage4Value6);
    let stage5Value2 = transformClampStage(line, stage4Value2 + stage4Value5);
    let stage5Value3 = transformClampStage(line, stage4Value3 + stage3Value4);
    let stage5Value4 = transformClampStage(line, stage4Value3 - stage3Value4);
    let stage5Value5 = transformClampStage(line, stage4Value2 - stage4Value5);
    let stage5Value6 = transformClampStage(line, stage4Value1 - stage4Value6);
    let stage5Value7 = transformClampStage(line, stage4Value0 - stage3Value7);
    transformStorePair(line, 0u, stage5Value0, stage5Value1);
    transformStorePair(line, 1u, stage5Value2, stage5Value3);
    transformStorePair(line, 2u, stage5Value4, stage5Value5);
    transformStorePair(line, 3u, stage5Value6, stage5Value7);
}

// libaom's av1_idct16 (av1/common/av1_inv_txfm1d.c), transcribed stage by stage
fn transformInverseDCT16(line: TransformLine) {
    let input0 = transformLoad(line, 0u);
    let input1 = transformLoad(line, 1u);
    let input2 = transformLoad(line, 2u);
    let input3 = transformLoad(line, 3u);
    let input4 = transformLoad(line, 4u);
    let input5 = transformLoad(line, 5u);
    let input6 = transformLoad(line, 6u);
    let input7 = transformLoad(line, 7u);
    let input8 = transformLoad(line, 8u);
    let input9 = transformLoad(line, 9u);
    let input10 = transformLoad(line, 10u);
    let input11 = transformLoad(line, 11u);
    let input12 = transformLoad(line, 12u);
    let input13 = transformLoad(line, 13u);
    let input14 = transformLoad(line, 14u);
    let input15 = transformLoad(line, 15u);
    // Stage 2
    let stage2Value8 = transformRotate(TRANSFORM_COSINES[60], input1, -TRANSFORM_COSINES[4], input15);
    let stage2Value9 = transformRotate(TRANSFORM_COSINES[28], input9, -TRANSFORM_COSINES[36], input7);
    let stage2Value10 = transformRotate(TRANSFORM_COSINES[44], input5, -TRANSFORM_COSINES[20], input11);
    let stage2Value11 = transformRotate(TRANSFORM_COSINES[12], input13, -TRANSFORM_COSINES[52], input3);
    let stage2Value12 = transformRotate(TRANSFORM_COSINES[52], input13, TRANSFORM_COSINES[12], input3);
    let stage2Value13 = transformRotate(TRANSFORM_COSINES[20], input5, TRANSFORM_COSINES[44], input11);
    let stage2Value14 = transformRotate(TRANSFORM_COSINES[36], input9, TRANSFORM_COSINES[28], input7);
    let stage2Value15 = transformRotate(TRANSFORM_COSINES[4], input1, TRANSFORM_COSINES[60], input15);
    // Stage 3
    let stage3Value4 = transformRotate(TRANSFORM_COSINES[56], input2, -TRANSFORM_COSINES[8], input14);
    let stage3Value5 = transformRotate(TRANSFORM_COSINES[24], input10, -TRANSFORM_COSINES[40], input6);
    let stage3Value6 = transformRotate(TRANSFORM_COSINES[40], input10, TRANSFORM_COSINES[24], input6);
    let stage3Value7 = transformRotate(TRANSFORM_COSINES[8], input2, TRANSFORM_COSINES[56], input14);
    let stage3Value8 = transformClampStage(line, stage2Value8 + stage2Value9);
    let stage3Value9 = transformClampStage(line, stage2Value8 - stage2Value9);
    let stage3Value10 = transformClampStage(line, stage2Value11 - stage2Value10);
    let stage3Value11 = transformClampStage(line, stage2Value10 + stage2Value11);
    let stage3Value12 = transformClampStage(line, stage2Value12 + stage2Value13);
    let stage3Value13 = transformClampStage(line, stage2Value12 - stage2Value13);
    let stage3Value14 = transformClampStage(line, stage2Value15 - stage2Value14);
    let stage3Value15 = transformClampStage(line, stage2Value14 + stage2Value15);
    // Stage 4
    let stage4Value0 = transformRotate(TRANSFORM_COSINES[32], input0, TRANSFORM_COSINES[32], input8);
    let stage4Value1 = transformRotate(TRANSFORM_COSINES[32], input0, -TRANSFORM_COSINES[32], input8);
    let stage4Value2 = transformRotate(TRANSFORM_COSINES[48], input4, -TRANSFORM_COSINES[16], input12);
    let stage4Value3 = transformRotate(TRANSFORM_COSINES[16], input4, TRANSFORM_COSINES[48], input12);
    let stage4Value4 = transformClampStage(line, stage3Value4 + stage3Value5);
    let stage4Value5 = transformClampStage(line, stage3Value4 - stage3Value5);
    let stage4Value6 = transformClampStage(line, stage3Value7 - stage3Value6);
    let stage4Value7 = transformClampStage(line, stage3Value6 + stage3Value7);
    let stage4Value9 = transformRotate(-TRANSFORM_COSINES[16], stage3Value9, TRANSFORM_COSINES[48], stage3Value14);
    let stage4Value10 = transformRotate(-TRANSFORM_COSINES[48], stage3Value10, -TRANSFORM_COSINES[16], stage3Value13);
    let stage4Value13 = transformRotate(-TRANSFORM_COSINES[16], stage3Value10, TRANSFORM_COSINES[48], stage3Value13);
    let stage4Value14 = transformRotate(TRANSFORM_COSINES[48], stage3Value9, TRANSFORM_COSINES[16], stage3Value14);
    // Stage 5
    let stage5Value0 = transformClampStage(line, stage4Value0 + stage4Value3);
    let stage5Value1 = transformClampStage(line, stage4Value1 + stage4Value2);
    let stage5Value2 = transformClampStage(line, stage4Value1 - stage4Value2);
    let stage5Value3 = transformClampStage(line, stage4Value0 - stage4Value3);
    let stage5Value5 = transformRotate(-TRANSFORM_COSINES[32], stage4Value5, TRANSFORM_COSINES[32], stage4Value6);
    let stage5Value6 = transformRotate(TRANSFORM_COSINES[32], stage4Value5, TRANSFORM_COSINES[32], stage4Value6);
    let stage5Value8 = transformClampStage(line, stage3Value8 + stage3Value11);
    let stage5Value9 = transformClampStage(line, stage4Value9 + stage4Value10);
    let stage5Value10 = transformClampStage(line, stage4Value9 - stage4Value10);
    let stage5Value11 = transformClampStage(line, stage3Value8 - stage3Value11);
    let stage5Value12 = transformClampStage(line, stage3Value15 - stage3Value12);
    let stage5Value13 = transformClampStage(line, stage4Value14 - stage4Value13);
    let stage5Value14 = transformClampStage(line, stage4Value13 + stage4Value14);
    let stage5Value15 = transformClampStage(line, stage3Value12 + stage3Value15);
    // Stage 6
    let stage6Value0 = transformClampStage(line, stage5Value0 + stage4Value7);
    let stage6Value1 = transformClampStage(line, stage5Value1 + stage5Value6);
    let stage6Value2 = transformClampStage(line, stage5Value2 + stage5Value5);
    let stage6Value3 = transformClampStage(line, stage5Value3 + stage4Value4);
    let stage6Value4 = transformClampStage(line, stage5Value3 - stage4Value4);
    let stage6Value5 = transformClampStage(line, stage5Value2 - stage5Value5);
    let stage6Value6 = transformClampStage(line, stage5Value1 - stage5Value6);
    let stage6Value7 = transformClampStage(line, stage5Value0 - stage4Value7);
    let stage6Value10 = transformRotate(-TRANSFORM_COSINES[32], stage5Value10, TRANSFORM_COSINES[32], stage5Value13);
    let stage6Value11 = transformRotate(-TRANSFORM_COSINES[32], stage5Value11, TRANSFORM_COSINES[32], stage5Value12);
    let stage6Value12 = transformRotate(TRANSFORM_COSINES[32], stage5Value11, TRANSFORM_COSINES[32], stage5Value12);
    let stage6Value13 = transformRotate(TRANSFORM_COSINES[32], stage5Value10, TRANSFORM_COSINES[32], stage5Value13);
    // Stage 7
    let stage7Value0 = transformClampStage(line, stage6Value0 + stage5Value15);
    let stage7Value1 = transformClampStage(line, stage6Value1 + stage5Value14);
    let stage7Value2 = transformClampStage(line, stage6Value2 + stage6Value13);
    let stage7Value3 = transformClampStage(line, stage6Value3 + stage6Value12);
    let stage7Value4 = transformClampStage(line, stage6Value4 + stage6Value11);
    let stage7Value5 = transformClampStage(line, stage6Value5 + stage6Value10);
    let stage7Value6 = transformClampStage(line, stage6Value6 + stage5Value9);
    let stage7Value7 = transformClampStage(line, stage6Value7 + stage5Value8);
    let stage7Value8 = transformClampStage(line, stage6Value7 - stage5Value8);
    let stage7Value9 = transformClampStage(line, stage6Value6 - stage5Value9);
    let stage7Value10 = transformClampStage(line, stage6Value5 - stage6Value10);
    let stage7Value11 = transformClampStage(line, stage6Value4 - stage6Value11);
    let stage7Value12 = transformClampStage(line, stage6Value3 - stage6Value12);
    let stage7Value13 = transformClampStage(line, stage6Value2 - stage6Value13);
    let stage7Value14 = transformClampStage(line, stage6Value1 - stage5Value14);
    let stage7Value15 = transformClampStage(line, stage6Value0 - stage5Value15);
    transformStorePair(line, 0u, stage7Value0, stage7Value1);
    transformStorePair(line, 1u, stage7Value2, stage7Value3);
    transformStorePair(line, 2u, stage7Value4, stage7Value5);
    transformStorePair(line, 3u, stage7Value6, stage7Value7);
    transformStorePair(line, 4u, stage7Value8, stage7Value9);
    transformStorePair(line, 5u, stage7Value10, stage7Value11);
    transformStorePair(line, 6u, stage7Value12, stage7Value13);
    transformStorePair(line, 7u, stage7Value14, stage7Value15);
}

// libaom's av1_idct32 (av1/common/av1_inv_txfm1d.c), transcribed stage by stage
fn transformInverseDCT32(line: TransformLine) {
    let input0 = transformLoad(line, 0u);
    let input1 = transformLoad(line, 1u);
    let input2 = transformLoad(line, 2u);
    let input3 = transformLoad(line, 3u);
    let input4 = transformLoad(line, 4u);
    let input5 = transformLoad(line, 5u);
    let input6 = transformLoad(line, 6u);
    let input7 = transformLoad(line, 7u);
    let input8 = transformLoad(line, 8u);
    let input9 = transformLoad(line, 9u);
    let input10 = transformLoad(line, 10u);
    let input11 = transformLoad(line, 11u);
    let input12 = transformLoad(line, 12u);
    let input13 = transformLoad(line, 13u);
    let input14 = transformLoad(line, 14u);
    let input15 = transformLoad(line, 15u);
    let input16 = transformLoad(line, 16u);
    let input17 = transformLoad(line, 17u);
    let input18 = transformLoad(line, 18u);
    let input19 = transformLoad(line, 19u);
    let input20 = transformLoad(line, 20u);
    let input21 = transformLoad(line, 21u);
    let input22 = transformLoad(line, 22u);
    let input23 = transformLoad(line, 23u);
    let input24 = transformLoad(line, 24u);
    let input25 = transformLoad(line, 25u);
    let input26 = transformLoad(line, 26u);
    let input27 = transformLoad(line, 27u);
    let input28 = transformLoad(line, 28u);
    let input29 = transformLoad(line, 29u);
    let input30 = transformLoad(line, 30u);
    let input31 = transformLoad(line, 31u);
    // Stage 2
    let stage2Value16 = transformRotate(TRANSFORM_COSINES[62], input1, -TRANSFORM_COSINES[2], input31);
    let stage2Value17 = transformRotate(TRANSFORM_COSINES[30], input17, -TRANSFORM_COSINES[34], input15);
    let stage2Value18 = transformRotate(TRANSFORM_COSINES[46], input9, -TRANSFORM_COSINES[18], input23);
    let stage2Value19 = transformRotate(TRANSFORM_COSINES[14], input25, -TRANSFORM_COSINES[50], input7);
    let stage2Value20 = transformRotate(TRANSFORM_COSINES[54], input5, -TRANSFORM_COSINES[10], input27);
    let stage2Value21 = transformRotate(TRANSFORM_COSINES[22], input21, -TRANSFORM_COSINES[42], input11);
    let stage2Value22 = transformRotate(TRANSFORM_COSINES[38], input13, -TRANSFORM_COSINES[26], input19);
    let stage2Value23 = transformRotate(TRANSFORM_COSINES[6], input29, -TRANSFORM_COSINES[58], input3);
    let stage2Value24 = transformRotate(TRANSFORM_COSINES[58], input29, TRANSFORM_COSINES[6], input3);
    let stage2Value25 = transformRotate(TRANSFORM_COSINES[26], input13, TRANSFORM_COSINES[38], input19);
    let stage2Value26 = transformRotate(TRANSFORM_COSINES[42], input21, TRANSFORM_COSINES[22], input11);
    let stage2Value27 = transformRotate(TRANSFORM_COSINES[10], input5, TRANSFORM_COSINES[54], input27);
    let stage2Value28 = transformRotate(TRANSFORM_COSINES[50], input25, TRANSFORM_COSINES[14], input7);
    let stage2Value29 = transformRotate(TRANSFORM_COSINES[18], input9, TRANSFORM_COSINES[46], input23);
    let stage2Value30 = transformRotate(TRANSFORM_COSINES[34], input17, TRANSFORM_COSINES[30], input15);
    let stage2Value31 = transformRotate(TRANSFORM_COSINES[2], input1, TRANSFORM_COSINES[62], input31);
    // Stage 3
    let stage3Value8 = transformRotate(TRANSFORM_COSINES[60], input2, -TRANSFORM_COSINES[4], input30);
    let stage3Value9 = transformRotate(TRANSFORM_COSINES[28], input18, -TRANSFORM_COSINES[36], input14);
    let stage3Value10 = transformRotate(TRANSFORM_COSINES[44], input10, -TRANSFORM_COSINES[20], input22);
    let stage3Value11 = transformRotate(TRANSFORM_COSINES[12], input26, -TRANSFORM_COSINES[52], input6);
    let stage3Value12 = transformRotate(TRANSFORM_COSINES[52], input26, TRANSFORM_COSINES[12], input6);
    let stage3Value13 = transformRotate(TRANSFORM_COSINES[20], input10, TRANSFORM_COSINES[44], input22);
    let stage3Value14 = transformRotate(TRANSFORM_COSINES[36], input18, TRANSFORM_COSINES[28], input14);
    let stage3Value15 = transformRotate(TRANSFORM_COSINES[4], input2, TRANSFORM_COSINES[60], input30);
    let stage3Value16 = transformClampStage(line, stage2Value16 + stage2Value17);
    let stage3Value17 = transformClampStage(line, stage2Value16 - stage2Value17);
    let stage3Value18 = transformClampStage(line, stage2Value19 - stage2Value18);
    let stage3Value19 = transformClampStage(line, stage2Value18 + stage2Value19);
    let stage3Value20 = transformClampStage(line, stage2Value20 + stage2Value21);
    let stage3Value21 = transformClampStage(line, stage2Value20 - stage2Value21);
    let stage3Value22 = transformClampStage(line, stage2Value23 - stage2Value22);
    let stage3Value23 = transformClampStage(line, stage2Value22 + stage2Value23);
    let stage3Value24 = transformClampStage(line, stage2Value24 + stage2Value25);
    let stage3Value25 = transformClampStage(line, stage2Value24 - stage2Value25);
    let stage3Value26 = transformClampStage(line, stage2Value27 - stage2Value26);
    let stage3Value27 = transformClampStage(line, stage2Value26 + stage2Value27);
    let stage3Value28 = transformClampStage(line, stage2Value28 + stage2Value29);
    let stage3Value29 = transformClampStage(line, stage2Value28 - stage2Value29);
    let stage3Value30 = transformClampStage(line, stage2Value31 - stage2Value30);
    let stage3Value31 = transformClampStage(line, stage2Value30 + stage2Value31);
    // Stage 4
    let stage4Value4 = transformRotate(TRANSFORM_COSINES[56], input4, -TRANSFORM_COSINES[8], input28);
    let stage4Value5 = transformRotate(TRANSFORM_COSINES[24], input20, -TRANSFORM_COSINES[40], input12);
    let stage4Value6 = transformRotate(TRANSFORM_COSINES[40], input20, TRANSFORM_COSINES[24], input12);
    let stage4Value7 = transformRotate(TRANSFORM_COSINES[8], input4, TRANSFORM_COSINES[56], input28);
    let stage4Value8 = transformClampStage(line, stage3Value8 + stage3Value9);
    let stage4Value9 = transformClampStage(line, stage3Value8 - stage3Value9);
    let stage4Value10 = transformClampStage(line, stage3Value11 - stage3Value10);
    let stage4Value11 = transformClampStage(line, stage3Value10 + stage3Value11);
    let stage4Value12 = transformClampStage(line, stage3Value12 + stage3Value13);
    let stage4Value13 = transformClampStage(line, stage3Value12 - stage3Value13);
    let stage4Value14 = transformClampStage(line, stage3Value15 - stage3Value14);
    let stage4Value15 = transformClampStage(line, stage3Value14 + stage3Value15);
    let stage4Value17 = transformRotate(-TRANSFORM_COSINES[8], stage3Value17, TRANSFORM_COSINES[56], stage3Value30);
    let stage4Value18 = transformRotate(-TRANSFORM_COSINES[56], stage3Value18, -TRANSFORM_COSINES[8], stage3Value29);
    let stage4Value21 = transformRotate(-TRANSFORM_COSINES[40], stage3Value21, TRANSFORM_COSINES[24], stage3Value26);
    let stage4Value22 = transformRotate(-TRANSFORM_COSINES[24], stage3Value22, -TRANSFORM_COSINES[40], stage3Value25);
    let stage4Value25 = transformRotate(-TRANSFORM_COSINES[40], stage3Value22, TRANSFORM_COSINES[24], stage3Value25);
    let stage4Value26 = transformRotate(TRANSFORM_COSINES[24], stage3Value21, TRANSFORM_COSINES[40], stage3Value26);
    let stage4Value29 = transformRotate(-TRANSFORM_COSINES[8], stage3Value18, TRANSFORM_COSINES[56], stage3Value29);
    let stage4Value30 = transformRotate(TRANSFORM_COSINES[56], stage3Value17, TRANSFORM_COSINES[8], stage3Value30);
    // Stage 5
    let stage5Value0 = transformRotate(TRANSFORM_COSINES[32], input0, TRANSFORM_COSINES[32], input16);
    let stage5Value1 = transformRotate(TRANSFORM_COSINES[32], input0, -TRANSFORM_COSINES[32], input16);
    let stage5Value2 = transformRotate(TRANSFORM_COSINES[48], input8, -TRANSFORM_COSINES[16], input24);
    let stage5Value3 = transformRotate(TRANSFORM_COSINES[16], input8, TRANSFORM_COSINES[48], input24);
    let stage5Value4 = transformClampStage(line, stage4Value4 + stage4Value5);
    let stage5Value5 = transformClampStage(line, stage4Value4 - stage4Value5);
    let stage5Value6 = transformClampStage(line, stage4Value7 - stage4Value6);
    let stage5Value7 = transformClampStage(line, stage4Value6 + stage4Value7);
    let stage5Value9 = transformRotate(-TRANSFORM_COSINES[16], stage4Value9, TRANSFORM_COSINES[48], stage4Value14);
    let stage5Value10 = transformRotate(-TRANSFORM_COSINES[48], stage4Value10, -TRANSFORM_COSINES[16], stage4Value13);
    let stage5Value13 = transformRotate(-TRANSFORM_COSINES[16], stage4Value10, TRANSFORM_COSINES[48], stage4Value13);
    let stage5Value14 = transformRotate(TRANSFORM_COSINES[48], stage4Value9, TRANSFORM_COSINES[16], stage4Value14);
    let stage5Value16 = transformClampStage(line, stage3Value16 + stage3Value19);
    let stage5Value17 = transformClampStage(line, stage4Value17 + stage4Value18);
    let stage5Value18 = transformClampStage(line, stage4Value17 - stage4Value18);
    let stage5Value19 = transformClampStage(line, stage3Value16 - stage3Value19);
    let stage5Value20 = transformClampStage(line, stage3Value23 - stage3Value20);
    let stage5Value21 = transformClampStage(line, stage4Value22 - stage4Value21);
    let stage5Value22 = transformClampStage(line, stage4Value21 + stage4Value22);
    let stage5Value23 = transformClampStage(line, stage3Value20 + stage3Value23);
    let stage5Value24 = transformClampStage(line, stage3Value24 + stage3Value27);
    let stage5Value25 = transformClampStage(line, stage4Value25 + stage4Value26);
    let stage5Value26 = transformClampStage(line, stage4Value25 - stage4Value26);
    let stage5Value27 = transformClampStage(line, stage3Value24 - stage3Value27);
    let stage5Value28 = transformClampStage(line, stage3Value31 - stage3Value28);
    let stage5Value29 = transformClampStage(line, stage4Value30 - stage4Value29);
    let stage5Value30 = transformClampStage(line, stage4Value29 + stage4Value30);
    let stage5Value31 = transformClampStage(line, stage3Value28 + stage3Value31);
    // Stage 6
    let stage6Value0 = transformClampStage(line, stage5Value0 + stage5Value3);
    let stage6Value1 = transformClampStage(line, stage5Value1 + stage5Value2);
    let stage6Value2 = transformClampStage(line, stage5Value1 - stage5Value2);
    let stage6Value3 = transformClampStage(line, stage5Value0 - stage5Value3);
    let stage6Value5 = transformRotate(-TRANSFORM_COSINES[32], stage5Value5, TRANSFORM_COSINES[32], stage5Value6);
    let stage6Value6 = transformRotate(TRANSFORM_COSINES[32], stage5Value5, TRANSFORM_COSINES[32], stage5Value6);
    let stage6Value8 = transformClampStage(line, stage4Value8 + stage4Value11);
    let stage6Value9 = transformClampStage(line, stage5Value9 + stage5Value10);
    let stage6Value10 = transformClampStage(line, stage5Value9 - stage5Value10);
    let stage6Value11 = transformClampStage(line, stage4Value8 - stage4Value11);
    let stage6Value12 = transformClampStage(line, stage4Value15 - stage4Value12);
    let stage6Value13 = transformClampStage(line, stage5Value14 - stage5Value13);
    let stage6Value14 = transformClampStage(line, stage5Value13 + stage5Value14);
    let stage6Value15 = transformClampStage(line, stage4Value12 + stage4Value15);
    let stage6Value18 = transformRotate(-TRANSFORM_COSINES[16], stage5Value18, TRANSFORM_COSINES[48], stage5Value29);
    let stage6Value19 = transformRotate(-TRANSFORM_COSINES[16], stage5Value19, TRANSFORM_COSINES[48], stage5Value28);
    let stage6Value20 = transformRotate(-TRANSFORM_COSINES[48], stage5Value20, -TRANSFORM_COSINES[16], stage5Value27);
    let stage6Value21 = transformRotate(-TRANSFORM_COSINES[48], stage5Value21, -TRANSFORM_COSINES[16], stage5Value26);
    let stage6Value26 = transformRotate(-TRANSFORM_COSINES[16], stage5Value21, TRANSFORM_COSINES[48], stage5Value26);
    let stage6Value27 = transformRotate(-TRANSFORM_COSINES[16], stage5Value20, TRANSFORM_COSINES[48], stage5Value27);
    let stage6Value28 = transformRotate(TRANSFORM_COSINES[48], stage5Value19, TRANSFORM_COSINES[16], stage5Value28);
    let stage6Value29 = transformRotate(TRANSFORM_COSINES[48], stage5Value18, TRANSFORM_COSINES[16], stage5Value29);
    // Stage 7
    let stage7Value0 = transformClampStage(line, stage6Value0 + stage5Value7);
    let stage7Value1 = transformClampStage(line, stage6Value1 + stage6Value6);
    let stage7Value2 = transformClampStage(line, stage6Value2 + stage6Value5);
    let stage7Value3 = transformClampStage(line, stage6Value3 + stage5Value4);
    let stage7Value4 = transformClampStage(line, stage6Value3 - stage5Value4);
    let stage7Value5 = transformClampStage(line, stage6Value2 - stage6Value5);
    let stage7Value6 = transformClampStage(line, stage6Value1 - stage6Value6);
    let stage7Value7 = transformClampStage(line, stage6Value0 - stage5Value7);
    let stage7Value10 = transformRotate(-TRANSFORM_COSINES[32], stage6Value10, TRANSFORM_COSINES[32], stage6Value13);
    let stage7Value11 = transformRotate(-TRANSFORM_COSINES[32], stage6Value11, TRANSFORM_COSINES[32], stage6Value12);
    let stage7Value12 = transformRotate(TRANSFORM_COSINES[32], stage6Value11, TRANSFORM_COSINES[32], stage6Value12);
    let stage7Value13 = transformRotate(TRANSFORM_COSINES[32], stage6Value10, TRANSFORM_COSINES[32], stage6Value13);
    let stage7Value16 = transformClampStage(line, stage5Value16 + stage5Value23);
    let stage7Value17 = transformClampStage(line, stage5Value17 + stage5Value22);
    let stage7Value18 = transformClampStage(line, stage6Value18 + stage6Value21);
    let stage7Value19 = transformClampStage(line, stage6Value19 + stage6Value20);
    let stage7Value20 = transformClampStage(line, stage6Value19 - stage6Value20);
    let stage7Value21 = transformClampStage(line, stage6Value18 - stage6Value21);
    let stage7Value22 = transformClampStage(line, stage5Value17 - stage5Value22);
    let stage7Value23 = transformClampStage(line, stage5Value16 - stage5Value23);
    let stage7Value24 = transformClampStage(line, stage5Value31 - stage5Value24);
    let stage7Value25 = transformClampStage(line, stage5Value30 - stage5Value25);
    let stage7Value26 = transformClampStage(line, stage6Value29 - stage6Value26);
    let stage7Value27 = transformClampStage(line, stage6Value28 - stage6Value27);
    let stage7Value28 = transformClampStage(line, stage6Value27 + stage6Value28);
    let stage7Value29 = transformClampStage(line, stage6Value26 + stage6Value29);
    let stage7Value30 = transformClampStage(line, stage5Value25 + stage5Value30);
    let stage7Value31 = transformClampStage(line, stage5Value24 + stage5Value31);
    // Stage 8
    let stage8Value0 = transformClampStage(line, stage7Value0 + stage6Value15);
    let stage8Value1 = transformClampStage(line, stage7Value1 + stage6Value14);
    let stage8Value2 = transformClampStage(line, stage7Value2 + stage7Value13);
    let stage8Value3 = transformClampStage(line, stage7Value3 + stage7Value12);
    let stage8Value4 = transformClampStage(line, stage7Value4 + stage7Value11);
    let stage8Value5 = transformClampStage(line, stage7Value5 + stage7Value10);
    let stage8Value6 = transformClampStage(line, stage7Value6 + stage6Value9);
    let stage8Value7 = transformClampStage(line, stage7Value7 + stage6Value8);
    let stage8Value8 = transformClampStage(line, stage7Value7 - stage6Value8);
    let stage8Value9 = transformClampStage(line, stage7Value6 - stage6Value9);
    let stage8Value10 = transformClampStage(line, stage7Value5 - stage7Value10);
    let stage8Value11 = transformClampStage(line, stage7Value4 - stage7Value11);
    let stage8Value12 = transformClampStage(line, stage7Value3 - stage7Value12);
    let stage8Value13 = transformClampStage(line, stage7Value2 - stage7Value13);
    let stage8Value14 = transformClampStage(line, stage7Value1 - stage6Value14);
    let stage8Value15 = transformClampStage(line, stage7Value0 - stage6Value15);
    let stage8Value20 = transformRotate(-TRANSFORM_COSINES[32], stage7Value20, TRANSFORM_COSINES[32], stage7Value27);
    let stage8Value21 = transformRotate(-TRANSFORM_COSINES[32], stage7Value21, TRANSFORM_COSINES[32], stage7Value26);
    let stage8Value22 = transformRotate(-TRANSFORM_COSINES[32], stage7Value22, TRANSFORM_COSINES[32], stage7Value25);
    let stage8Value23 = transformRotate(-TRANSFORM_COSINES[32], stage7Value23, TRANSFORM_COSINES[32], stage7Value24);
    let stage8Value24 = transformRotate(TRANSFORM_COSINES[32], stage7Value23, TRANSFORM_COSINES[32], stage7Value24);
    let stage8Value25 = transformRotate(TRANSFORM_COSINES[32], stage7Value22, TRANSFORM_COSINES[32], stage7Value25);
    let stage8Value26 = transformRotate(TRANSFORM_COSINES[32], stage7Value21, TRANSFORM_COSINES[32], stage7Value26);
    let stage8Value27 = transformRotate(TRANSFORM_COSINES[32], stage7Value20, TRANSFORM_COSINES[32], stage7Value27);
    // Stage 9
    let stage9Value0 = transformClampStage(line, stage8Value0 + stage7Value31);
    let stage9Value1 = transformClampStage(line, stage8Value1 + stage7Value30);
    let stage9Value2 = transformClampStage(line, stage8Value2 + stage7Value29);
    let stage9Value3 = transformClampStage(line, stage8Value3 + stage7Value28);
    let stage9Value4 = transformClampStage(line, stage8Value4 + stage8Value27);
    let stage9Value5 = transformClampStage(line, stage8Value5 + stage8Value26);
    let stage9Value6 = transformClampStage(line, stage8Value6 + stage8Value25);
    let stage9Value7 = transformClampStage(line, stage8Value7 + stage8Value24);
    let stage9Value8 = transformClampStage(line, stage8Value8 + stage8Value23);
    let stage9Value9 = transformClampStage(line, stage8Value9 + stage8Value22);
    let stage9Value10 = transformClampStage(line, stage8Value10 + stage8Value21);
    let stage9Value11 = transformClampStage(line, stage8Value11 + stage8Value20);
    let stage9Value12 = transformClampStage(line, stage8Value12 + stage7Value19);
    let stage9Value13 = transformClampStage(line, stage8Value13 + stage7Value18);
    let stage9Value14 = transformClampStage(line, stage8Value14 + stage7Value17);
    let stage9Value15 = transformClampStage(line, stage8Value15 + stage7Value16);
    let stage9Value16 = transformClampStage(line, stage8Value15 - stage7Value16);
    let stage9Value17 = transformClampStage(line, stage8Value14 - stage7Value17);
    let stage9Value18 = transformClampStage(line, stage8Value13 - stage7Value18);
    let stage9Value19 = transformClampStage(line, stage8Value12 - stage7Value19);
    let stage9Value20 = transformClampStage(line, stage8Value11 - stage8Value20);
    let stage9Value21 = transformClampStage(line, stage8Value10 - stage8Value21);
    let stage9Value22 = transformClampStage(line, stage8Value9 - stage8Value22);
    let stage9Value23 = transformClampStage(line, stage8Value8 - stage8Value23);
    let stage9Value24 = transformClampStage(line, stage8Value7 - stage8Value24);
    let stage9Value25 = transformClampStage(line, stage8Value6 - stage8Value25);
    let stage9Value26 = transformClampStage(line, stage8Value5 - stage8Value26);
    let stage9Value27 = transformClampStage(line, stage8Value4 - stage8Value27);
    let stage9Value28 = transformClampStage(line, stage8Value3 - stage7Value28);
    let stage9Value29 = transformClampStage(line, stage8Value2 - stage7Value29);
    let stage9Value30 = transformClampStage(line, stage8Value1 - stage7Value30);
    let stage9Value31 = transformClampStage(line, stage8Value0 - stage7Value31);
    transformStorePair(line, 0u, stage9Value0, stage9Value1);
    transformStorePair(line, 1u, stage9Value2, stage9Value3);
    transformStorePair(line, 2u, stage9Value4, stage9Value5);
    transformStorePair(line, 3u, stage9Value6, stage9Value7);
    transformStorePair(line, 4u, stage9Value8, stage9Value9);
    transformStorePair(line, 5u, stage9Value10, stage9Value11);
    transformStorePair(line, 6u, stage9Value12, stage9Value13);
    transformStorePair(line, 7u, stage9Value14, stage9Value15);
    transformStorePair(line, 8u, stage9Value16, stage9Value17);
    transformStorePair(line, 9u, stage9Value18, stage9Value19);
    transformStorePair(line, 10u, stage9Value20, stage9Value21);
    transformStorePair(line, 11u, stage9Value22, stage9Value23);
    transformStorePair(line, 12u, stage9Value24, stage9Value25);
    transformStorePair(line, 13u, stage9Value26, stage9Value27);
    transformStorePair(line, 14u, stage9Value28, stage9Value29);
    transformStorePair(line, 15u, stage9Value30, stage9Value31);
}

// libaom's av1_idct64 (av1/common/av1_inv_txfm1d.c), transcribed stage by stage
fn transformInverseDCT64(line: TransformLine) {
    let input0 = transformLoad(line, 0u);
    let input1 = transformLoad(line, 1u);
    let input2 = transformLoad(line, 2u);
    let input3 = transformLoad(line, 3u);
    let input4 = transformLoad(line, 4u);
    let input5 = transformLoad(line, 5u);
    let input6 = transformLoad(line, 6u);
    let input7 = transformLoad(line, 7u);
    let input8 = transformLoad(line, 8u);
    let input9 = transformLoad(line, 9u);
    let input10 = transformLoad(line, 10u);
    let input11 = transformLoad(line, 11u);
    let input12 = transformLoad(line, 12u);
    let input13 = transformLoad(line, 13u);
    let input14 = transformLoad(line, 14u);
    let input15 = transformLoad(line, 15u);
    let input16 = transformLoad(line, 16u);
    let input17 = transformLoad(line, 17u);
    let input18 = transformLoad(line, 18u);
    let input19 = transformLoad(line, 19u);
    let input20 = transformLoad(line, 20u);
    let input21 = transformLoad(line, 21u);
    let input22 = transformLoad(line, 22u);
    let input23 = transformLoad(line, 23u);
    let input24 = transformLoad(line, 24u);
    let input25 = transformLoad(line, 25u);
    let input26 = transformLoad(line, 26u);
    let input27 = transformLoad(line, 27u);
    let input28 = transformLoad(line, 28u);
    let input29 = transformLoad(line, 29u);
    let input30 = transformLoad(line, 30u);
    let input31 = transformLoad(line, 31u);
    // AV1 codes a 64-point transform's first 32 inputs only (every line's input count is at most 32, as libaom zeroes the rest), so
    // the others are literal zeros, which fold half the flow graph away
    let input32 = TRANSFORM_UNCODED_INPUT;
    let input33 = TRANSFORM_UNCODED_INPUT;
    let input34 = TRANSFORM_UNCODED_INPUT;
    let input35 = TRANSFORM_UNCODED_INPUT;
    let input36 = TRANSFORM_UNCODED_INPUT;
    let input37 = TRANSFORM_UNCODED_INPUT;
    let input38 = TRANSFORM_UNCODED_INPUT;
    let input39 = TRANSFORM_UNCODED_INPUT;
    let input40 = TRANSFORM_UNCODED_INPUT;
    let input41 = TRANSFORM_UNCODED_INPUT;
    let input42 = TRANSFORM_UNCODED_INPUT;
    let input43 = TRANSFORM_UNCODED_INPUT;
    let input44 = TRANSFORM_UNCODED_INPUT;
    let input45 = TRANSFORM_UNCODED_INPUT;
    let input46 = TRANSFORM_UNCODED_INPUT;
    let input47 = TRANSFORM_UNCODED_INPUT;
    let input48 = TRANSFORM_UNCODED_INPUT;
    let input49 = TRANSFORM_UNCODED_INPUT;
    let input50 = TRANSFORM_UNCODED_INPUT;
    let input51 = TRANSFORM_UNCODED_INPUT;
    let input52 = TRANSFORM_UNCODED_INPUT;
    let input53 = TRANSFORM_UNCODED_INPUT;
    let input54 = TRANSFORM_UNCODED_INPUT;
    let input55 = TRANSFORM_UNCODED_INPUT;
    let input56 = TRANSFORM_UNCODED_INPUT;
    let input57 = TRANSFORM_UNCODED_INPUT;
    let input58 = TRANSFORM_UNCODED_INPUT;
    let input59 = TRANSFORM_UNCODED_INPUT;
    let input60 = TRANSFORM_UNCODED_INPUT;
    let input61 = TRANSFORM_UNCODED_INPUT;
    let input62 = TRANSFORM_UNCODED_INPUT;
    let input63 = TRANSFORM_UNCODED_INPUT;
    // Stage 2
    let stage2Value32 = transformRotate(TRANSFORM_COSINES[63], input1, -TRANSFORM_COSINES[1], input63);
    let stage2Value33 = transformRotate(TRANSFORM_COSINES[31], input33, -TRANSFORM_COSINES[33], input31);
    let stage2Value34 = transformRotate(TRANSFORM_COSINES[47], input17, -TRANSFORM_COSINES[17], input47);
    let stage2Value35 = transformRotate(TRANSFORM_COSINES[15], input49, -TRANSFORM_COSINES[49], input15);
    let stage2Value36 = transformRotate(TRANSFORM_COSINES[55], input9, -TRANSFORM_COSINES[9], input55);
    let stage2Value37 = transformRotate(TRANSFORM_COSINES[23], input41, -TRANSFORM_COSINES[41], input23);
    let stage2Value38 = transformRotate(TRANSFORM_COSINES[39], input25, -TRANSFORM_COSINES[25], input39);
    let stage2Value39 = transformRotate(TRANSFORM_COSINES[7], input57, -TRANSFORM_COSINES[57], input7);
    let stage2Value40 = transformRotate(TRANSFORM_COSINES[59], input5, -TRANSFORM_COSINES[5], input59);
    let stage2Value41 = transformRotate(TRANSFORM_COSINES[27], input37, -TRANSFORM_COSINES[37], input27);
    let stage2Value42 = transformRotate(TRANSFORM_COSINES[43], input21, -TRANSFORM_COSINES[21], input43);
    let stage2Value43 = transformRotate(TRANSFORM_COSINES[11], input53, -TRANSFORM_COSINES[53], input11);
    let stage2Value44 = transformRotate(TRANSFORM_COSINES[51], input13, -TRANSFORM_COSINES[13], input51);
    let stage2Value45 = transformRotate(TRANSFORM_COSINES[19], input45, -TRANSFORM_COSINES[45], input19);
    let stage2Value46 = transformRotate(TRANSFORM_COSINES[35], input29, -TRANSFORM_COSINES[29], input35);
    let stage2Value47 = transformRotate(TRANSFORM_COSINES[3], input61, -TRANSFORM_COSINES[61], input3);
    let stage2Value48 = transformRotate(TRANSFORM_COSINES[61], input61, TRANSFORM_COSINES[3], input3);
    let stage2Value49 = transformRotate(TRANSFORM_COSINES[29], input29, TRANSFORM_COSINES[35], input35);
    let stage2Value50 = transformRotate(TRANSFORM_COSINES[45], input45, TRANSFORM_COSINES[19], input19);
    let stage2Value51 = transformRotate(TRANSFORM_COSINES[13], input13, TRANSFORM_COSINES[51], input51);
    let stage2Value52 = transformRotate(TRANSFORM_COSINES[53], input53, TRANSFORM_COSINES[11], input11);
    let stage2Value53 = transformRotate(TRANSFORM_COSINES[21], input21, TRANSFORM_COSINES[43], input43);
    let stage2Value54 = transformRotate(TRANSFORM_COSINES[37], input37, TRANSFORM_COSINES[27], input27);
    let stage2Value55 = transformRotate(TRANSFORM_COSINES[5], input5, TRANSFORM_COSINES[59], input59);
    let stage2Value56 = transformRotate(TRANSFORM_COSINES[57], input57, TRANSFORM_COSINES[7], input7);
    let stage2Value57 = transformRotate(TRANSFORM_COSINES[25], input25, TRANSFORM_COSINES[39], input39);
    let stage2Value58 = transformRotate(TRANSFORM_COSINES[41], input41, TRANSFORM_COSINES[23], input23);
    let stage2Value59 = transformRotate(TRANSFORM_COSINES[9], input9, TRANSFORM_COSINES[55], input55);
    let stage2Value60 = transformRotate(TRANSFORM_COSINES[49], input49, TRANSFORM_COSINES[15], input15);
    let stage2Value61 = transformRotate(TRANSFORM_COSINES[17], input17, TRANSFORM_COSINES[47], input47);
    let stage2Value62 = transformRotate(TRANSFORM_COSINES[33], input33, TRANSFORM_COSINES[31], input31);
    let stage2Value63 = transformRotate(TRANSFORM_COSINES[1], input1, TRANSFORM_COSINES[63], input63);
    // Stage 3
    let stage3Value16 = transformRotate(TRANSFORM_COSINES[62], input2, -TRANSFORM_COSINES[2], input62);
    let stage3Value17 = transformRotate(TRANSFORM_COSINES[30], input34, -TRANSFORM_COSINES[34], input30);
    let stage3Value18 = transformRotate(TRANSFORM_COSINES[46], input18, -TRANSFORM_COSINES[18], input46);
    let stage3Value19 = transformRotate(TRANSFORM_COSINES[14], input50, -TRANSFORM_COSINES[50], input14);
    let stage3Value20 = transformRotate(TRANSFORM_COSINES[54], input10, -TRANSFORM_COSINES[10], input54);
    let stage3Value21 = transformRotate(TRANSFORM_COSINES[22], input42, -TRANSFORM_COSINES[42], input22);
    let stage3Value22 = transformRotate(TRANSFORM_COSINES[38], input26, -TRANSFORM_COSINES[26], input38);
    let stage3Value23 = transformRotate(TRANSFORM_COSINES[6], input58, -TRANSFORM_COSINES[58], input6);
    let stage3Value24 = transformRotate(TRANSFORM_COSINES[58], input58, TRANSFORM_COSINES[6], input6);
    let stage3Value25 = transformRotate(TRANSFORM_COSINES[26], input26, TRANSFORM_COSINES[38], input38);
    let stage3Value26 = transformRotate(TRANSFORM_COSINES[42], input42, TRANSFORM_COSINES[22], input22);
    let stage3Value27 = transformRotate(TRANSFORM_COSINES[10], input10, TRANSFORM_COSINES[54], input54);
    let stage3Value28 = transformRotate(TRANSFORM_COSINES[50], input50, TRANSFORM_COSINES[14], input14);
    let stage3Value29 = transformRotate(TRANSFORM_COSINES[18], input18, TRANSFORM_COSINES[46], input46);
    let stage3Value30 = transformRotate(TRANSFORM_COSINES[34], input34, TRANSFORM_COSINES[30], input30);
    let stage3Value31 = transformRotate(TRANSFORM_COSINES[2], input2, TRANSFORM_COSINES[62], input62);
    let stage3Value32 = transformClampStage(line, stage2Value32 + stage2Value33);
    let stage3Value33 = transformClampStage(line, stage2Value32 - stage2Value33);
    let stage3Value34 = transformClampStage(line, stage2Value35 - stage2Value34);
    let stage3Value35 = transformClampStage(line, stage2Value34 + stage2Value35);
    let stage3Value36 = transformClampStage(line, stage2Value36 + stage2Value37);
    let stage3Value37 = transformClampStage(line, stage2Value36 - stage2Value37);
    let stage3Value38 = transformClampStage(line, stage2Value39 - stage2Value38);
    let stage3Value39 = transformClampStage(line, stage2Value38 + stage2Value39);
    let stage3Value40 = transformClampStage(line, stage2Value40 + stage2Value41);
    let stage3Value41 = transformClampStage(line, stage2Value40 - stage2Value41);
    let stage3Value42 = transformClampStage(line, stage2Value43 - stage2Value42);
    let stage3Value43 = transformClampStage(line, stage2Value42 + stage2Value43);
    let stage3Value44 = transformClampStage(line, stage2Value44 + stage2Value45);
    let stage3Value45 = transformClampStage(line, stage2Value44 - stage2Value45);
    let stage3Value46 = transformClampStage(line, stage2Value47 - stage2Value46);
    let stage3Value47 = transformClampStage(line, stage2Value46 + stage2Value47);
    let stage3Value48 = transformClampStage(line, stage2Value48 + stage2Value49);
    let stage3Value49 = transformClampStage(line, stage2Value48 - stage2Value49);
    let stage3Value50 = transformClampStage(line, stage2Value51 - stage2Value50);
    let stage3Value51 = transformClampStage(line, stage2Value50 + stage2Value51);
    let stage3Value52 = transformClampStage(line, stage2Value52 + stage2Value53);
    let stage3Value53 = transformClampStage(line, stage2Value52 - stage2Value53);
    let stage3Value54 = transformClampStage(line, stage2Value55 - stage2Value54);
    let stage3Value55 = transformClampStage(line, stage2Value54 + stage2Value55);
    let stage3Value56 = transformClampStage(line, stage2Value56 + stage2Value57);
    let stage3Value57 = transformClampStage(line, stage2Value56 - stage2Value57);
    let stage3Value58 = transformClampStage(line, stage2Value59 - stage2Value58);
    let stage3Value59 = transformClampStage(line, stage2Value58 + stage2Value59);
    let stage3Value60 = transformClampStage(line, stage2Value60 + stage2Value61);
    let stage3Value61 = transformClampStage(line, stage2Value60 - stage2Value61);
    let stage3Value62 = transformClampStage(line, stage2Value63 - stage2Value62);
    let stage3Value63 = transformClampStage(line, stage2Value62 + stage2Value63);
    // Stage 4
    let stage4Value8 = transformRotate(TRANSFORM_COSINES[60], input4, -TRANSFORM_COSINES[4], input60);
    let stage4Value9 = transformRotate(TRANSFORM_COSINES[28], input36, -TRANSFORM_COSINES[36], input28);
    let stage4Value10 = transformRotate(TRANSFORM_COSINES[44], input20, -TRANSFORM_COSINES[20], input44);
    let stage4Value11 = transformRotate(TRANSFORM_COSINES[12], input52, -TRANSFORM_COSINES[52], input12);
    let stage4Value12 = transformRotate(TRANSFORM_COSINES[52], input52, TRANSFORM_COSINES[12], input12);
    let stage4Value13 = transformRotate(TRANSFORM_COSINES[20], input20, TRANSFORM_COSINES[44], input44);
    let stage4Value14 = transformRotate(TRANSFORM_COSINES[36], input36, TRANSFORM_COSINES[28], input28);
    let stage4Value15 = transformRotate(TRANSFORM_COSINES[4], input4, TRANSFORM_COSINES[60], input60);
    let stage4Value16 = transformClampStage(line, stage3Value16 + stage3Value17);
    let stage4Value17 = transformClampStage(line, stage3Value16 - stage3Value17);
    let stage4Value18 = transformClampStage(line, stage3Value19 - stage3Value18);
    let stage4Value19 = transformClampStage(line, stage3Value18 + stage3Value19);
    let stage4Value20 = transformClampStage(line, stage3Value20 + stage3Value21);
    let stage4Value21 = transformClampStage(line, stage3Value20 - stage3Value21);
    let stage4Value22 = transformClampStage(line, stage3Value23 - stage3Value22);
    let stage4Value23 = transformClampStage(line, stage3Value22 + stage3Value23);
    let stage4Value24 = transformClampStage(line, stage3Value24 + stage3Value25);
    let stage4Value25 = transformClampStage(line, stage3Value24 - stage3Value25);
    let stage4Value26 = transformClampStage(line, stage3Value27 - stage3Value26);
    let stage4Value27 = transformClampStage(line, stage3Value26 + stage3Value27);
    let stage4Value28 = transformClampStage(line, stage3Value28 + stage3Value29);
    let stage4Value29 = transformClampStage(line, stage3Value28 - stage3Value29);
    let stage4Value30 = transformClampStage(line, stage3Value31 - stage3Value30);
    let stage4Value31 = transformClampStage(line, stage3Value30 + stage3Value31);
    let stage4Value33 = transformRotate(-TRANSFORM_COSINES[4], stage3Value33, TRANSFORM_COSINES[60], stage3Value62);
    let stage4Value34 = transformRotate(-TRANSFORM_COSINES[60], stage3Value34, -TRANSFORM_COSINES[4], stage3Value61);
    let stage4Value37 = transformRotate(-TRANSFORM_COSINES[36], stage3Value37, TRANSFORM_COSINES[28], stage3Value58);
    let stage4Value38 = transformRotate(-TRANSFORM_COSINES[28], stage3Value38, -TRANSFORM_COSINES[36], stage3Value57);
    let stage4Value41 = transformRotate(-TRANSFORM_COSINES[20], stage3Value41, TRANSFORM_COSINES[44], stage3Value54);
    let stage4Value42 = transformRotate(-TRANSFORM_COSINES[44], stage3Value42, -TRANSFORM_COSINES[20], stage3Value53);
    let stage4Value45 = transformRotate(-TRANSFORM_COSINES[52], stage3Value45, TRANSFORM_COSINES[12], stage3Value50);
    let stage4Value46 = transformRotate(-TRANSFORM_COSINES[12], stage3Value46, -TRANSFORM_COSINES[52], stage3Value49);
    let stage4Value49 = transformRotate(-TRANSFORM_COSINES[52], stage3Value46, TRANSFORM_COSINES[12], stage3Value49);
    let stage4Value50 = transformRotate(TRANSFORM_COSINES[12], stage3Value45, TRANSFORM_COSINES[52], stage3Value50);
    let stage4Value53 = transformRotate(-TRANSFORM_COSINES[20], stage3Value42, TRANSFORM_COSINES[44], stage3Value53);
    let stage4Value54 = transformRotate(TRANSFORM_COSINES[44], stage3Value41, TRANSFORM_COSINES[20], stage3Value54);
    let stage4Value57 = transformRotate(-TRANSFORM_COSINES[36], stage3Value38, TRANSFORM_COSINES[28], stage3Value57);
    let stage4Value58 = transformRotate(TRANSFORM_COSINES[28], stage3Value37, TRANSFORM_COSINES[36], stage3Value58);
    let stage4Value61 = transformRotate(-TRANSFORM_COSINES[4], stage3Value34, TRANSFORM_COSINES[60], stage3Value61);
    let stage4Value62 = transformRotate(TRANSFORM_COSINES[60], stage3Value33, TRANSFORM_COSINES[4], stage3Value62);
    // Stage 5
    let stage5Value4 = transformRotate(TRANSFORM_COSINES[56], input8, -TRANSFORM_COSINES[8], input56);
    let stage5Value5 = transformRotate(TRANSFORM_COSINES[24], input40, -TRANSFORM_COSINES[40], input24);
    let stage5Value6 = transformRotate(TRANSFORM_COSINES[40], input40, TRANSFORM_COSINES[24], input24);
    let stage5Value7 = transformRotate(TRANSFORM_COSINES[8], input8, TRANSFORM_COSINES[56], input56);
    let stage5Value8 = transformClampStage(line, stage4Value8 + stage4Value9);
    let stage5Value9 = transformClampStage(line, stage4Value8 - stage4Value9);
    let stage5Value10 = transformClampStage(line, stage4Value11 - stage4Value10);
    let stage5Value11 = transformClampStage(line, stage4Value10 + stage4Value11);
    let stage5Value12 = transformClampStage(line, stage4Value12 + stage4Value13);
    let stage5Value13 = transformClampStage(line, stage4Value12 - stage4Value13);
    let stage5Value14 = transformClampStage(line, stage4Value15 - stage4Value14);
    let stage5Value15 = transformClampStage(line, stage4Value14 + stage4Value15);
    let stage5Value17 = transformRotate(-TRANSFORM_COSINES[8], stage4Value17, TRANSFORM_COSINES[56], stage4Value30);
    let stage5Value18 = transformRotate(-TRANSFORM_COSINES[56], stage4Value18, -TRANSFORM_COSINES[8], stage4Value29);
    let stage5Value21 = transformRotate(-TRANSFORM_COSINES[40], stage4Value21, TRANSFORM_COSINES[24], stage4Value26);
    let stage5Value22 = transformRotate(-TRANSFORM_COSINES[24], stage4Value22, -TRANSFORM_COSINES[40], stage4Value25);
    let stage5Value25 = transformRotate(-TRANSFORM_COSINES[40], stage4Value22, TRANSFORM_COSINES[24], stage4Value25);
    let stage5Value26 = transformRotate(TRANSFORM_COSINES[24], stage4Value21, TRANSFORM_COSINES[40], stage4Value26);
    let stage5Value29 = transformRotate(-TRANSFORM_COSINES[8], stage4Value18, TRANSFORM_COSINES[56], stage4Value29);
    let stage5Value30 = transformRotate(TRANSFORM_COSINES[56], stage4Value17, TRANSFORM_COSINES[8], stage4Value30);
    let stage5Value32 = transformClampStage(line, stage3Value32 + stage3Value35);
    let stage5Value33 = transformClampStage(line, stage4Value33 + stage4Value34);
    let stage5Value34 = transformClampStage(line, stage4Value33 - stage4Value34);
    let stage5Value35 = transformClampStage(line, stage3Value32 - stage3Value35);
    let stage5Value36 = transformClampStage(line, stage3Value39 - stage3Value36);
    let stage5Value37 = transformClampStage(line, stage4Value38 - stage4Value37);
    let stage5Value38 = transformClampStage(line, stage4Value37 + stage4Value38);
    let stage5Value39 = transformClampStage(line, stage3Value36 + stage3Value39);
    let stage5Value40 = transformClampStage(line, stage3Value40 + stage3Value43);
    let stage5Value41 = transformClampStage(line, stage4Value41 + stage4Value42);
    let stage5Value42 = transformClampStage(line, stage4Value41 - stage4Value42);
    let stage5Value43 = transformClampStage(line, stage3Value40 - stage3Value43);
    let stage5Value44 = transformClampStage(line, stage3Value47 - stage3Value44);
    let stage5Value45 = transformClampStage(line, stage4Value46 - stage4Value45);
    let stage5Value46 = transformClampStage(line, stage4Value45 + stage4Value46);
    let stage5Value47 = transformClampStage(line, stage3Value44 + stage3Value47);
    let stage5Value48 = transformClampStage(line, stage3Value48 + stage3Value51);
    let stage5Value49 = transformClampStage(line, stage4Value49 + stage4Value50);
    let stage5Value50 = transformClampStage(line, stage4Value49 - stage4Value50);
    let stage5Value51 = transformClampStage(line, stage3Value48 - stage3Value51);
    let stage5Value52 = transformClampStage(line, stage3Value55 - stage3Value52);
    let stage5Value53 = transformClampStage(line, stage4Value54 - stage4Value53);
    let stage5Value54 = transformClampStage(line, stage4Value53 + stage4Value54);
    let stage5Value55 = transformClampStage(line, stage3Value52 + stage3Value55);
    let stage5Value56 = transformClampStage(line, stage3Value56 + stage3Value59);
    let stage5Value57 = transformClampStage(line, stage4Value57 + stage4Value58);
    let stage5Value58 = transformClampStage(line, stage4Value57 - stage4Value58);
    let stage5Value59 = transformClampStage(line, stage3Value56 - stage3Value59);
    let stage5Value60 = transformClampStage(line, stage3Value63 - stage3Value60);
    let stage5Value61 = transformClampStage(line, stage4Value62 - stage4Value61);
    let stage5Value62 = transformClampStage(line, stage4Value61 + stage4Value62);
    let stage5Value63 = transformClampStage(line, stage3Value60 + stage3Value63);
    // Stage 6
    let stage6Value0 = transformRotate(TRANSFORM_COSINES[32], input0, TRANSFORM_COSINES[32], input32);
    let stage6Value1 = transformRotate(TRANSFORM_COSINES[32], input0, -TRANSFORM_COSINES[32], input32);
    let stage6Value2 = transformRotate(TRANSFORM_COSINES[48], input16, -TRANSFORM_COSINES[16], input48);
    let stage6Value3 = transformRotate(TRANSFORM_COSINES[16], input16, TRANSFORM_COSINES[48], input48);
    let stage6Value4 = transformClampStage(line, stage5Value4 + stage5Value5);
    let stage6Value5 = transformClampStage(line, stage5Value4 - stage5Value5);
    let stage6Value6 = transformClampStage(line, stage5Value7 - stage5Value6);
    let stage6Value7 = transformClampStage(line, stage5Value6 + stage5Value7);
    let stage6Value9 = transformRotate(-TRANSFORM_COSINES[16], stage5Value9, TRANSFORM_COSINES[48], stage5Value14);
    let stage6Value10 = transformRotate(-TRANSFORM_COSINES[48], stage5Value10, -TRANSFORM_COSINES[16], stage5Value13);
    let stage6Value13 = transformRotate(-TRANSFORM_COSINES[16], stage5Value10, TRANSFORM_COSINES[48], stage5Value13);
    let stage6Value14 = transformRotate(TRANSFORM_COSINES[48], stage5Value9, TRANSFORM_COSINES[16], stage5Value14);
    let stage6Value16 = transformClampStage(line, stage4Value16 + stage4Value19);
    let stage6Value17 = transformClampStage(line, stage5Value17 + stage5Value18);
    let stage6Value18 = transformClampStage(line, stage5Value17 - stage5Value18);
    let stage6Value19 = transformClampStage(line, stage4Value16 - stage4Value19);
    let stage6Value20 = transformClampStage(line, stage4Value23 - stage4Value20);
    let stage6Value21 = transformClampStage(line, stage5Value22 - stage5Value21);
    let stage6Value22 = transformClampStage(line, stage5Value21 + stage5Value22);
    let stage6Value23 = transformClampStage(line, stage4Value20 + stage4Value23);
    let stage6Value24 = transformClampStage(line, stage4Value24 + stage4Value27);
    let stage6Value25 = transformClampStage(line, stage5Value25 + stage5Value26);
    let stage6Value26 = transformClampStage(line, stage5Value25 - stage5Value26);
    let stage6Value27 = transformClampStage(line, stage4Value24 - stage4Value27);
    let stage6Value28 = transformClampStage(line, stage4Value31 - stage4Value28);
    let stage6Value29 = transformClampStage(line, stage5Value30 - stage5Value29);
    let stage6Value30 = transformClampStage(line, stage5Value29 + stage5Value30);
    let stage6Value31 = transformClampStage(line, stage4Value28 + stage4Value31);
    let stage6Value34 = transformRotate(-TRANSFORM_COSINES[8], stage5Value34, TRANSFORM_COSINES[56], stage5Value61);
    let stage6Value35 = transformRotate(-TRANSFORM_COSINES[8], stage5Value35, TRANSFORM_COSINES[56], stage5Value60);
    let stage6Value36 = transformRotate(-TRANSFORM_COSINES[56], stage5Value36, -TRANSFORM_COSINES[8], stage5Value59);
    let stage6Value37 = transformRotate(-TRANSFORM_COSINES[56], stage5Value37, -TRANSFORM_COSINES[8], stage5Value58);
    let stage6Value42 = transformRotate(-TRANSFORM_COSINES[40], stage5Value42, TRANSFORM_COSINES[24], stage5Value53);
    let stage6Value43 = transformRotate(-TRANSFORM_COSINES[40], stage5Value43, TRANSFORM_COSINES[24], stage5Value52);
    let stage6Value44 = transformRotate(-TRANSFORM_COSINES[24], stage5Value44, -TRANSFORM_COSINES[40], stage5Value51);
    let stage6Value45 = transformRotate(-TRANSFORM_COSINES[24], stage5Value45, -TRANSFORM_COSINES[40], stage5Value50);
    let stage6Value50 = transformRotate(-TRANSFORM_COSINES[40], stage5Value45, TRANSFORM_COSINES[24], stage5Value50);
    let stage6Value51 = transformRotate(-TRANSFORM_COSINES[40], stage5Value44, TRANSFORM_COSINES[24], stage5Value51);
    let stage6Value52 = transformRotate(TRANSFORM_COSINES[24], stage5Value43, TRANSFORM_COSINES[40], stage5Value52);
    let stage6Value53 = transformRotate(TRANSFORM_COSINES[24], stage5Value42, TRANSFORM_COSINES[40], stage5Value53);
    let stage6Value58 = transformRotate(-TRANSFORM_COSINES[8], stage5Value37, TRANSFORM_COSINES[56], stage5Value58);
    let stage6Value59 = transformRotate(-TRANSFORM_COSINES[8], stage5Value36, TRANSFORM_COSINES[56], stage5Value59);
    let stage6Value60 = transformRotate(TRANSFORM_COSINES[56], stage5Value35, TRANSFORM_COSINES[8], stage5Value60);
    let stage6Value61 = transformRotate(TRANSFORM_COSINES[56], stage5Value34, TRANSFORM_COSINES[8], stage5Value61);
    // Stage 7
    let stage7Value0 = transformClampStage(line, stage6Value0 + stage6Value3);
    let stage7Value1 = transformClampStage(line, stage6Value1 + stage6Value2);
    let stage7Value2 = transformClampStage(line, stage6Value1 - stage6Value2);
    let stage7Value3 = transformClampStage(line, stage6Value0 - stage6Value3);
    let stage7Value5 = transformRotate(-TRANSFORM_COSINES[32], stage6Value5, TRANSFORM_COSINES[32], stage6Value6);
    let stage7Value6 = transformRotate(TRANSFORM_COSINES[32], stage6Value5, TRANSFORM_COSINES[32], stage6Value6);
    let stage7Value8 = transformClampStage(line, stage5Value8 + stage5Value11);
    let stage7Value9 = transformClampStage(line, stage6Value9 + stage6Value10);
    let stage7Value10 = transformClampStage(line, stage6Value9 - stage6Value10);
    let stage7Value11 = transformClampStage(line, stage5Value8 - stage5Value11);
    let stage7Value12 = transformClampStage(line, stage5Value15 - stage5Value12);
    let stage7Value13 = transformClampStage(line, stage6Value14 - stage6Value13);
    let stage7Value14 = transformClampStage(line, stage6Value13 + stage6Value14);
    let stage7Value15 = transformClampStage(line, stage5Value12 + stage5Value15);
    let stage7Value18 = transformRotate(-TRANSFORM_COSINES[16], stage6Value18, TRANSFORM_COSINES[48], stage6Value29);
    let stage7Value19 = transformRotate(-TRANSFORM_COSINES[16], stage6Value19, TRANSFORM_COSINES[48], stage6Value28);
    let stage7Value20 = transformRotate(-TRANSFORM_COSINES[48], stage6Value20, -TRANSFORM_COSINES[16], stage6Value27);
    let stage7Value21 = transformRotate(-TRANSFORM_COSINES[48], stage6Value21, -TRANSFORM_COSINES[16], stage6Value26);
    let stage7Value26 = transformRotate(-TRANSFORM_COSINES[16], stage6Value21, TRANSFORM_COSINES[48], stage6Value26);
    let stage7Value27 = transformRotate(-TRANSFORM_COSINES[16], stage6Value20, TRANSFORM_COSINES[48], stage6Value27);
    let stage7Value28 = transformRotate(TRANSFORM_COSINES[48], stage6Value19, TRANSFORM_COSINES[16], stage6Value28);
    let stage7Value29 = transformRotate(TRANSFORM_COSINES[48], stage6Value18, TRANSFORM_COSINES[16], stage6Value29);
    let stage7Value32 = transformClampStage(line, stage5Value32 + stage5Value39);
    let stage7Value33 = transformClampStage(line, stage5Value33 + stage5Value38);
    let stage7Value34 = transformClampStage(line, stage6Value34 + stage6Value37);
    let stage7Value35 = transformClampStage(line, stage6Value35 + stage6Value36);
    let stage7Value36 = transformClampStage(line, stage6Value35 - stage6Value36);
    let stage7Value37 = transformClampStage(line, stage6Value34 - stage6Value37);
    let stage7Value38 = transformClampStage(line, stage5Value33 - stage5Value38);
    let stage7Value39 = transformClampStage(line, stage5Value32 - stage5Value39);
    let stage7Value40 = transformClampStage(line, stage5Value47 - stage5Value40);
    let stage7Value41 = transformClampStage(line, stage5Value46 - stage5Value41);
    let stage7Value42 = transformClampStage(line, stage6Value45 - stage6Value42);
    let stage7Value43 = transformClampStage(line, stage6Value44 - stage6Value43);
    let stage7Value44 = transformClampStage(line, stage6Value43 + stage6Value44);
    let stage7Value45 = transformClampStage(line, stage6Value42 + stage6Value45);
    let stage7Value46 = transformClampStage(line, stage5Value41 + stage5Value46);
    let stage7Value47 = transformClampStage(line, stage5Value40 + stage5Value47);
    let stage7Value48 = transformClampStage(line, stage5Value48 + stage5Value55);
    let stage7Value49 = transformClampStage(line, stage5Value49 + stage5Value54);
    let stage7Value50 = transformClampStage(line, stage6Value50 + stage6Value53);
    let stage7Value51 = transformClampStage(line, stage6Value51 + stage6Value52);
    let stage7Value52 = transformClampStage(line, stage6Value51 - stage6Value52);
    let stage7Value53 = transformClampStage(line, stage6Value50 - stage6Value53);
    let stage7Value54 = transformClampStage(line, stage5Value49 - stage5Value54);
    let stage7Value55 = transformClampStage(line, stage5Value48 - stage5Value55);
    let stage7Value56 = transformClampStage(line, stage5Value63 - stage5Value56);
    let stage7Value57 = transformClampStage(line, stage5Value62 - stage5Value57);
    let stage7Value58 = transformClampStage(line, stage6Value61 - stage6Value58);
    let stage7Value59 = transformClampStage(line, stage6Value60 - stage6Value59);
    let stage7Value60 = transformClampStage(line, stage6Value59 + stage6Value60);
    let stage7Value61 = transformClampStage(line, stage6Value58 + stage6Value61);
    let stage7Value62 = transformClampStage(line, stage5Value57 + stage5Value62);
    let stage7Value63 = transformClampStage(line, stage5Value56 + stage5Value63);
    // Stage 8
    let stage8Value0 = transformClampStage(line, stage7Value0 + stage6Value7);
    let stage8Value1 = transformClampStage(line, stage7Value1 + stage7Value6);
    let stage8Value2 = transformClampStage(line, stage7Value2 + stage7Value5);
    let stage8Value3 = transformClampStage(line, stage7Value3 + stage6Value4);
    let stage8Value4 = transformClampStage(line, stage7Value3 - stage6Value4);
    let stage8Value5 = transformClampStage(line, stage7Value2 - stage7Value5);
    let stage8Value6 = transformClampStage(line, stage7Value1 - stage7Value6);
    let stage8Value7 = transformClampStage(line, stage7Value0 - stage6Value7);
    let stage8Value10 = transformRotate(-TRANSFORM_COSINES[32], stage7Value10, TRANSFORM_COSINES[32], stage7Value13);
    let stage8Value11 = transformRotate(-TRANSFORM_COSINES[32], stage7Value11, TRANSFORM_COSINES[32], stage7Value12);
    let stage8Value12 = transformRotate(TRANSFORM_COSINES[32], stage7Value11, TRANSFORM_COSINES[32], stage7Value12);
    let stage8Value13 = transformRotate(TRANSFORM_COSINES[32], stage7Value10, TRANSFORM_COSINES[32], stage7Value13);
    let stage8Value16 = transformClampStage(line, stage6Value16 + stage6Value23);
    let stage8Value17 = transformClampStage(line, stage6Value17 + stage6Value22);
    let stage8Value18 = transformClampStage(line, stage7Value18 + stage7Value21);
    let stage8Value19 = transformClampStage(line, stage7Value19 + stage7Value20);
    let stage8Value20 = transformClampStage(line, stage7Value19 - stage7Value20);
    let stage8Value21 = transformClampStage(line, stage7Value18 - stage7Value21);
    let stage8Value22 = transformClampStage(line, stage6Value17 - stage6Value22);
    let stage8Value23 = transformClampStage(line, stage6Value16 - stage6Value23);
    let stage8Value24 = transformClampStage(line, stage6Value31 - stage6Value24);
    let stage8Value25 = transformClampStage(line, stage6Value30 - stage6Value25);
    let stage8Value26 = transformClampStage(line, stage7Value29 - stage7Value26);
    let stage8Value27 = transformClampStage(line, stage7Value28 - stage7Value27);
    let stage8Value28 = transformClampStage(line, stage7Value27 + stage7Value28);
    let stage8Value29 = transformClampStage(line, stage7Value26 + stage7Value29);
    let stage8Value30 = transformClampStage(line, stage6Value25 + stage6Value30);
    let stage8Value31 = transformClampStage(line, stage6Value24 + stage6Value31);
    let stage8Value36 = transformRotate(-TRANSFORM_COSINES[16], stage7Value36, TRANSFORM_COSINES[48], stage7Value59);
    let stage8Value37 = transformRotate(-TRANSFORM_COSINES[16], stage7Value37, TRANSFORM_COSINES[48], stage7Value58);
    let stage8Value38 = transformRotate(-TRANSFORM_COSINES[16], stage7Value38, TRANSFORM_COSINES[48], stage7Value57);
    let stage8Value39 = transformRotate(-TRANSFORM_COSINES[16], stage7Value39, TRANSFORM_COSINES[48], stage7Value56);
    let stage8Value40 = transformRotate(-TRANSFORM_COSINES[48], stage7Value40, -TRANSFORM_COSINES[16], stage7Value55);
    let stage8Value41 = transformRotate(-TRANSFORM_COSINES[48], stage7Value41, -TRANSFORM_COSINES[16], stage7Value54);
    let stage8Value42 = transformRotate(-TRANSFORM_COSINES[48], stage7Value42, -TRANSFORM_COSINES[16], stage7Value53);
    let stage8Value43 = transformRotate(-TRANSFORM_COSINES[48], stage7Value43, -TRANSFORM_COSINES[16], stage7Value52);
    let stage8Value52 = transformRotate(-TRANSFORM_COSINES[16], stage7Value43, TRANSFORM_COSINES[48], stage7Value52);
    let stage8Value53 = transformRotate(-TRANSFORM_COSINES[16], stage7Value42, TRANSFORM_COSINES[48], stage7Value53);
    let stage8Value54 = transformRotate(-TRANSFORM_COSINES[16], stage7Value41, TRANSFORM_COSINES[48], stage7Value54);
    let stage8Value55 = transformRotate(-TRANSFORM_COSINES[16], stage7Value40, TRANSFORM_COSINES[48], stage7Value55);
    let stage8Value56 = transformRotate(TRANSFORM_COSINES[48], stage7Value39, TRANSFORM_COSINES[16], stage7Value56);
    let stage8Value57 = transformRotate(TRANSFORM_COSINES[48], stage7Value38, TRANSFORM_COSINES[16], stage7Value57);
    let stage8Value58 = transformRotate(TRANSFORM_COSINES[48], stage7Value37, TRANSFORM_COSINES[16], stage7Value58);
    let stage8Value59 = transformRotate(TRANSFORM_COSINES[48], stage7Value36, TRANSFORM_COSINES[16], stage7Value59);
    // Stage 9
    let stage9Value0 = transformClampStage(line, stage8Value0 + stage7Value15);
    let stage9Value1 = transformClampStage(line, stage8Value1 + stage7Value14);
    let stage9Value2 = transformClampStage(line, stage8Value2 + stage8Value13);
    let stage9Value3 = transformClampStage(line, stage8Value3 + stage8Value12);
    let stage9Value4 = transformClampStage(line, stage8Value4 + stage8Value11);
    let stage9Value5 = transformClampStage(line, stage8Value5 + stage8Value10);
    let stage9Value6 = transformClampStage(line, stage8Value6 + stage7Value9);
    let stage9Value7 = transformClampStage(line, stage8Value7 + stage7Value8);
    let stage9Value8 = transformClampStage(line, stage8Value7 - stage7Value8);
    let stage9Value9 = transformClampStage(line, stage8Value6 - stage7Value9);
    let stage9Value10 = transformClampStage(line, stage8Value5 - stage8Value10);
    let stage9Value11 = transformClampStage(line, stage8Value4 - stage8Value11);
    let stage9Value12 = transformClampStage(line, stage8Value3 - stage8Value12);
    let stage9Value13 = transformClampStage(line, stage8Value2 - stage8Value13);
    let stage9Value14 = transformClampStage(line, stage8Value1 - stage7Value14);
    let stage9Value15 = transformClampStage(line, stage8Value0 - stage7Value15);
    let stage9Value20 = transformRotate(-TRANSFORM_COSINES[32], stage8Value20, TRANSFORM_COSINES[32], stage8Value27);
    let stage9Value21 = transformRotate(-TRANSFORM_COSINES[32], stage8Value21, TRANSFORM_COSINES[32], stage8Value26);
    let stage9Value22 = transformRotate(-TRANSFORM_COSINES[32], stage8Value22, TRANSFORM_COSINES[32], stage8Value25);
    let stage9Value23 = transformRotate(-TRANSFORM_COSINES[32], stage8Value23, TRANSFORM_COSINES[32], stage8Value24);
    let stage9Value24 = transformRotate(TRANSFORM_COSINES[32], stage8Value23, TRANSFORM_COSINES[32], stage8Value24);
    let stage9Value25 = transformRotate(TRANSFORM_COSINES[32], stage8Value22, TRANSFORM_COSINES[32], stage8Value25);
    let stage9Value26 = transformRotate(TRANSFORM_COSINES[32], stage8Value21, TRANSFORM_COSINES[32], stage8Value26);
    let stage9Value27 = transformRotate(TRANSFORM_COSINES[32], stage8Value20, TRANSFORM_COSINES[32], stage8Value27);
    let stage9Value32 = transformClampStage(line, stage7Value32 + stage7Value47);
    let stage9Value33 = transformClampStage(line, stage7Value33 + stage7Value46);
    let stage9Value34 = transformClampStage(line, stage7Value34 + stage7Value45);
    let stage9Value35 = transformClampStage(line, stage7Value35 + stage7Value44);
    let stage9Value36 = transformClampStage(line, stage8Value36 + stage8Value43);
    let stage9Value37 = transformClampStage(line, stage8Value37 + stage8Value42);
    let stage9Value38 = transformClampStage(line, stage8Value38 + stage8Value41);
    let stage9Value39 = transformClampStage(line, stage8Value39 + stage8Value40);
    let stage9Value40 = transformClampStage(line, stage8Value39 - stage8Value40);
    let stage9Value41 = transformClampStage(line, stage8Value38 - stage8Value41);
    let stage9Value42 = transformClampStage(line, stage8Value37 - stage8Value42);
    let stage9Value43 = transformClampStage(line, stage8Value36 - stage8Value43);
    let stage9Value44 = transformClampStage(line, stage7Value35 - stage7Value44);
    let stage9Value45 = transformClampStage(line, stage7Value34 - stage7Value45);
    let stage9Value46 = transformClampStage(line, stage7Value33 - stage7Value46);
    let stage9Value47 = transformClampStage(line, stage7Value32 - stage7Value47);
    let stage9Value48 = transformClampStage(line, stage7Value63 - stage7Value48);
    let stage9Value49 = transformClampStage(line, stage7Value62 - stage7Value49);
    let stage9Value50 = transformClampStage(line, stage7Value61 - stage7Value50);
    let stage9Value51 = transformClampStage(line, stage7Value60 - stage7Value51);
    let stage9Value52 = transformClampStage(line, stage8Value59 - stage8Value52);
    let stage9Value53 = transformClampStage(line, stage8Value58 - stage8Value53);
    let stage9Value54 = transformClampStage(line, stage8Value57 - stage8Value54);
    let stage9Value55 = transformClampStage(line, stage8Value56 - stage8Value55);
    let stage9Value56 = transformClampStage(line, stage8Value55 + stage8Value56);
    let stage9Value57 = transformClampStage(line, stage8Value54 + stage8Value57);
    let stage9Value58 = transformClampStage(line, stage8Value53 + stage8Value58);
    let stage9Value59 = transformClampStage(line, stage8Value52 + stage8Value59);
    let stage9Value60 = transformClampStage(line, stage7Value51 + stage7Value60);
    let stage9Value61 = transformClampStage(line, stage7Value50 + stage7Value61);
    let stage9Value62 = transformClampStage(line, stage7Value49 + stage7Value62);
    let stage9Value63 = transformClampStage(line, stage7Value48 + stage7Value63);
    // Stage 10
    let stage10Value0 = transformClampStage(line, stage9Value0 + stage8Value31);
    let stage10Value1 = transformClampStage(line, stage9Value1 + stage8Value30);
    let stage10Value2 = transformClampStage(line, stage9Value2 + stage8Value29);
    let stage10Value3 = transformClampStage(line, stage9Value3 + stage8Value28);
    let stage10Value4 = transformClampStage(line, stage9Value4 + stage9Value27);
    let stage10Value5 = transformClampStage(line, stage9Value5 + stage9Value26);
    let stage10Value6 = transformClampStage(line, stage9Value6 + stage9Value25);
    let stage10Value7 = transformClampStage(line, stage9Value7 + stage9Value24);
    let stage10Value8 = transformClampStage(line, stage9Value8 + stage9Value23);
    let stage10Value9 = transformClampStage(line, stage9Value9 + stage9Value22);
    let stage10Value10 = transformClampStage(line, stage9Value10 + stage9Value21);
    let stage10Value11 = transformClampStage(line, stage9Value11 + stage9Value20);
    let stage10Value12 = transformClampStage(line, stage9Value12 + stage8Value19);
    let stage10Value13 = transformClampStage(line, stage9Value13 + stage8Value18);
    let stage10Value14 = transformClampStage(line, stage9Value14 + stage8Value17);
    let stage10Value15 = transformClampStage(line, stage9Value15 + stage8Value16);
    let stage10Value16 = transformClampStage(line, stage9Value15 - stage8Value16);
    let stage10Value17 = transformClampStage(line, stage9Value14 - stage8Value17);
    let stage10Value18 = transformClampStage(line, stage9Value13 - stage8Value18);
    let stage10Value19 = transformClampStage(line, stage9Value12 - stage8Value19);
    let stage10Value20 = transformClampStage(line, stage9Value11 - stage9Value20);
    let stage10Value21 = transformClampStage(line, stage9Value10 - stage9Value21);
    let stage10Value22 = transformClampStage(line, stage9Value9 - stage9Value22);
    let stage10Value23 = transformClampStage(line, stage9Value8 - stage9Value23);
    let stage10Value24 = transformClampStage(line, stage9Value7 - stage9Value24);
    let stage10Value25 = transformClampStage(line, stage9Value6 - stage9Value25);
    let stage10Value26 = transformClampStage(line, stage9Value5 - stage9Value26);
    let stage10Value27 = transformClampStage(line, stage9Value4 - stage9Value27);
    let stage10Value28 = transformClampStage(line, stage9Value3 - stage8Value28);
    let stage10Value29 = transformClampStage(line, stage9Value2 - stage8Value29);
    let stage10Value30 = transformClampStage(line, stage9Value1 - stage8Value30);
    let stage10Value31 = transformClampStage(line, stage9Value0 - stage8Value31);
    let stage10Value40 = transformRotate(-TRANSFORM_COSINES[32], stage9Value40, TRANSFORM_COSINES[32], stage9Value55);
    let stage10Value41 = transformRotate(-TRANSFORM_COSINES[32], stage9Value41, TRANSFORM_COSINES[32], stage9Value54);
    let stage10Value42 = transformRotate(-TRANSFORM_COSINES[32], stage9Value42, TRANSFORM_COSINES[32], stage9Value53);
    let stage10Value43 = transformRotate(-TRANSFORM_COSINES[32], stage9Value43, TRANSFORM_COSINES[32], stage9Value52);
    let stage10Value44 = transformRotate(-TRANSFORM_COSINES[32], stage9Value44, TRANSFORM_COSINES[32], stage9Value51);
    let stage10Value45 = transformRotate(-TRANSFORM_COSINES[32], stage9Value45, TRANSFORM_COSINES[32], stage9Value50);
    let stage10Value46 = transformRotate(-TRANSFORM_COSINES[32], stage9Value46, TRANSFORM_COSINES[32], stage9Value49);
    let stage10Value47 = transformRotate(-TRANSFORM_COSINES[32], stage9Value47, TRANSFORM_COSINES[32], stage9Value48);
    let stage10Value48 = transformRotate(TRANSFORM_COSINES[32], stage9Value47, TRANSFORM_COSINES[32], stage9Value48);
    let stage10Value49 = transformRotate(TRANSFORM_COSINES[32], stage9Value46, TRANSFORM_COSINES[32], stage9Value49);
    let stage10Value50 = transformRotate(TRANSFORM_COSINES[32], stage9Value45, TRANSFORM_COSINES[32], stage9Value50);
    let stage10Value51 = transformRotate(TRANSFORM_COSINES[32], stage9Value44, TRANSFORM_COSINES[32], stage9Value51);
    let stage10Value52 = transformRotate(TRANSFORM_COSINES[32], stage9Value43, TRANSFORM_COSINES[32], stage9Value52);
    let stage10Value53 = transformRotate(TRANSFORM_COSINES[32], stage9Value42, TRANSFORM_COSINES[32], stage9Value53);
    let stage10Value54 = transformRotate(TRANSFORM_COSINES[32], stage9Value41, TRANSFORM_COSINES[32], stage9Value54);
    let stage10Value55 = transformRotate(TRANSFORM_COSINES[32], stage9Value40, TRANSFORM_COSINES[32], stage9Value55);
    // Stage 11
    let stage11Value0 = transformClampStage(line, stage10Value0 + stage9Value63);
    let stage11Value1 = transformClampStage(line, stage10Value1 + stage9Value62);
    let stage11Value2 = transformClampStage(line, stage10Value2 + stage9Value61);
    let stage11Value3 = transformClampStage(line, stage10Value3 + stage9Value60);
    let stage11Value4 = transformClampStage(line, stage10Value4 + stage9Value59);
    let stage11Value5 = transformClampStage(line, stage10Value5 + stage9Value58);
    let stage11Value6 = transformClampStage(line, stage10Value6 + stage9Value57);
    let stage11Value7 = transformClampStage(line, stage10Value7 + stage9Value56);
    let stage11Value8 = transformClampStage(line, stage10Value8 + stage10Value55);
    let stage11Value9 = transformClampStage(line, stage10Value9 + stage10Value54);
    let stage11Value10 = transformClampStage(line, stage10Value10 + stage10Value53);
    let stage11Value11 = transformClampStage(line, stage10Value11 + stage10Value52);
    let stage11Value12 = transformClampStage(line, stage10Value12 + stage10Value51);
    let stage11Value13 = transformClampStage(line, stage10Value13 + stage10Value50);
    let stage11Value14 = transformClampStage(line, stage10Value14 + stage10Value49);
    let stage11Value15 = transformClampStage(line, stage10Value15 + stage10Value48);
    let stage11Value16 = transformClampStage(line, stage10Value16 + stage10Value47);
    let stage11Value17 = transformClampStage(line, stage10Value17 + stage10Value46);
    let stage11Value18 = transformClampStage(line, stage10Value18 + stage10Value45);
    let stage11Value19 = transformClampStage(line, stage10Value19 + stage10Value44);
    let stage11Value20 = transformClampStage(line, stage10Value20 + stage10Value43);
    let stage11Value21 = transformClampStage(line, stage10Value21 + stage10Value42);
    let stage11Value22 = transformClampStage(line, stage10Value22 + stage10Value41);
    let stage11Value23 = transformClampStage(line, stage10Value23 + stage10Value40);
    let stage11Value24 = transformClampStage(line, stage10Value24 + stage9Value39);
    let stage11Value25 = transformClampStage(line, stage10Value25 + stage9Value38);
    let stage11Value26 = transformClampStage(line, stage10Value26 + stage9Value37);
    let stage11Value27 = transformClampStage(line, stage10Value27 + stage9Value36);
    let stage11Value28 = transformClampStage(line, stage10Value28 + stage9Value35);
    let stage11Value29 = transformClampStage(line, stage10Value29 + stage9Value34);
    let stage11Value30 = transformClampStage(line, stage10Value30 + stage9Value33);
    let stage11Value31 = transformClampStage(line, stage10Value31 + stage9Value32);
    let stage11Value32 = transformClampStage(line, stage10Value31 - stage9Value32);
    let stage11Value33 = transformClampStage(line, stage10Value30 - stage9Value33);
    let stage11Value34 = transformClampStage(line, stage10Value29 - stage9Value34);
    let stage11Value35 = transformClampStage(line, stage10Value28 - stage9Value35);
    let stage11Value36 = transformClampStage(line, stage10Value27 - stage9Value36);
    let stage11Value37 = transformClampStage(line, stage10Value26 - stage9Value37);
    let stage11Value38 = transformClampStage(line, stage10Value25 - stage9Value38);
    let stage11Value39 = transformClampStage(line, stage10Value24 - stage9Value39);
    let stage11Value40 = transformClampStage(line, stage10Value23 - stage10Value40);
    let stage11Value41 = transformClampStage(line, stage10Value22 - stage10Value41);
    let stage11Value42 = transformClampStage(line, stage10Value21 - stage10Value42);
    let stage11Value43 = transformClampStage(line, stage10Value20 - stage10Value43);
    let stage11Value44 = transformClampStage(line, stage10Value19 - stage10Value44);
    let stage11Value45 = transformClampStage(line, stage10Value18 - stage10Value45);
    let stage11Value46 = transformClampStage(line, stage10Value17 - stage10Value46);
    let stage11Value47 = transformClampStage(line, stage10Value16 - stage10Value47);
    let stage11Value48 = transformClampStage(line, stage10Value15 - stage10Value48);
    let stage11Value49 = transformClampStage(line, stage10Value14 - stage10Value49);
    let stage11Value50 = transformClampStage(line, stage10Value13 - stage10Value50);
    let stage11Value51 = transformClampStage(line, stage10Value12 - stage10Value51);
    let stage11Value52 = transformClampStage(line, stage10Value11 - stage10Value52);
    let stage11Value53 = transformClampStage(line, stage10Value10 - stage10Value53);
    let stage11Value54 = transformClampStage(line, stage10Value9 - stage10Value54);
    let stage11Value55 = transformClampStage(line, stage10Value8 - stage10Value55);
    let stage11Value56 = transformClampStage(line, stage10Value7 - stage9Value56);
    let stage11Value57 = transformClampStage(line, stage10Value6 - stage9Value57);
    let stage11Value58 = transformClampStage(line, stage10Value5 - stage9Value58);
    let stage11Value59 = transformClampStage(line, stage10Value4 - stage9Value59);
    let stage11Value60 = transformClampStage(line, stage10Value3 - stage9Value60);
    let stage11Value61 = transformClampStage(line, stage10Value2 - stage9Value61);
    let stage11Value62 = transformClampStage(line, stage10Value1 - stage9Value62);
    let stage11Value63 = transformClampStage(line, stage10Value0 - stage9Value63);
    transformStorePair(line, 0u, stage11Value0, stage11Value1);
    transformStorePair(line, 1u, stage11Value2, stage11Value3);
    transformStorePair(line, 2u, stage11Value4, stage11Value5);
    transformStorePair(line, 3u, stage11Value6, stage11Value7);
    transformStorePair(line, 4u, stage11Value8, stage11Value9);
    transformStorePair(line, 5u, stage11Value10, stage11Value11);
    transformStorePair(line, 6u, stage11Value12, stage11Value13);
    transformStorePair(line, 7u, stage11Value14, stage11Value15);
    transformStorePair(line, 8u, stage11Value16, stage11Value17);
    transformStorePair(line, 9u, stage11Value18, stage11Value19);
    transformStorePair(line, 10u, stage11Value20, stage11Value21);
    transformStorePair(line, 11u, stage11Value22, stage11Value23);
    transformStorePair(line, 12u, stage11Value24, stage11Value25);
    transformStorePair(line, 13u, stage11Value26, stage11Value27);
    transformStorePair(line, 14u, stage11Value28, stage11Value29);
    transformStorePair(line, 15u, stage11Value30, stage11Value31);
    transformStorePair(line, 16u, stage11Value32, stage11Value33);
    transformStorePair(line, 17u, stage11Value34, stage11Value35);
    transformStorePair(line, 18u, stage11Value36, stage11Value37);
    transformStorePair(line, 19u, stage11Value38, stage11Value39);
    transformStorePair(line, 20u, stage11Value40, stage11Value41);
    transformStorePair(line, 21u, stage11Value42, stage11Value43);
    transformStorePair(line, 22u, stage11Value44, stage11Value45);
    transformStorePair(line, 23u, stage11Value46, stage11Value47);
    transformStorePair(line, 24u, stage11Value48, stage11Value49);
    transformStorePair(line, 25u, stage11Value50, stage11Value51);
    transformStorePair(line, 26u, stage11Value52, stage11Value53);
    transformStorePair(line, 27u, stage11Value54, stage11Value55);
    transformStorePair(line, 28u, stage11Value56, stage11Value57);
    transformStorePair(line, 29u, stage11Value58, stage11Value59);
    transformStorePair(line, 30u, stage11Value60, stage11Value61);
    transformStorePair(line, 31u, stage11Value62, stage11Value63);
}

// libaom's av1_iadst4 (av1/common/av1_inv_txfm1d.c): its outputs are sums of sine products of up to 35 bits, round shifted, which
// transformDotRound computes exactly from the same products
fn transformInverseADST4(line: TransformLine) {
    let inputs = vec4i(transformLoad(line, 0u), transformLoad(line, 1u), transformLoad(line, 2u), transformLoad(line, 3u));
    // x0 = s0 + s3 + s5 + s2: sinpi1 * x0 + sinpi3 * x1 + sinpi4 * x2 + sinpi2 * x3
    let output0 = transformDotRound(vec4i(TRANSFORM_SINES[1], TRANSFORM_SINES[3], TRANSFORM_SINES[4], TRANSFORM_SINES[2]), inputs);
    // x1 = s1 - s4 - s6 + s2: sinpi2 * x0 + sinpi3 * x1 - sinpi1 * x2 - sinpi4 * x3
    let output1 = transformDotRound(vec4i(TRANSFORM_SINES[2], TRANSFORM_SINES[3], -TRANSFORM_SINES[1], -TRANSFORM_SINES[4]), inputs);
    // x2 = sinpi3 * ((x0 - x2) + x3)
    let output2 = transformDotRound(vec4i(TRANSFORM_SINES[3], 0, -TRANSFORM_SINES[3], TRANSFORM_SINES[3]), inputs);
    // x3 = s0 + s1 - s2 after stage 4: (sinpi1 + sinpi2) * x0 - sinpi3 * x1 + (sinpi4 - sinpi1) * x2 + (sinpi2 - sinpi4) * x3
    let output3 = transformDotRound(
        vec4i(TRANSFORM_SINES[1] + TRANSFORM_SINES[2], -TRANSFORM_SINES[3], TRANSFORM_SINES[4] - TRANSFORM_SINES[1], TRANSFORM_SINES[2] - TRANSFORM_SINES[4]),
        inputs);
    transformStorePair(line, 0u, output0, output1);
    transformStorePair(line, 1u, output2, output3);
}

// libaom's av1_iadst8 (av1/common/av1_inv_txfm1d.c), transcribed stage by stage
fn transformInverseADST8(line: TransformLine) {
    let input0 = transformLoad(line, 0u);
    let input1 = transformLoad(line, 1u);
    let input2 = transformLoad(line, 2u);
    let input3 = transformLoad(line, 3u);
    let input4 = transformLoad(line, 4u);
    let input5 = transformLoad(line, 5u);
    let input6 = transformLoad(line, 6u);
    let input7 = transformLoad(line, 7u);
    // Stage 2
    let stage2Value0 = transformRotate(TRANSFORM_COSINES[4], input7, TRANSFORM_COSINES[60], input0);
    let stage2Value1 = transformRotate(TRANSFORM_COSINES[60], input7, -TRANSFORM_COSINES[4], input0);
    let stage2Value2 = transformRotate(TRANSFORM_COSINES[20], input5, TRANSFORM_COSINES[44], input2);
    let stage2Value3 = transformRotate(TRANSFORM_COSINES[44], input5, -TRANSFORM_COSINES[20], input2);
    let stage2Value4 = transformRotate(TRANSFORM_COSINES[36], input3, TRANSFORM_COSINES[28], input4);
    let stage2Value5 = transformRotate(TRANSFORM_COSINES[28], input3, -TRANSFORM_COSINES[36], input4);
    let stage2Value6 = transformRotate(TRANSFORM_COSINES[52], input1, TRANSFORM_COSINES[12], input6);
    let stage2Value7 = transformRotate(TRANSFORM_COSINES[12], input1, -TRANSFORM_COSINES[52], input6);
    // Stage 3
    let stage3Value0 = transformClampStage(line, stage2Value0 + stage2Value4);
    let stage3Value1 = transformClampStage(line, stage2Value1 + stage2Value5);
    let stage3Value2 = transformClampStage(line, stage2Value2 + stage2Value6);
    let stage3Value3 = transformClampStage(line, stage2Value3 + stage2Value7);
    let stage3Value4 = transformClampStage(line, stage2Value0 - stage2Value4);
    let stage3Value5 = transformClampStage(line, stage2Value1 - stage2Value5);
    let stage3Value6 = transformClampStage(line, stage2Value2 - stage2Value6);
    let stage3Value7 = transformClampStage(line, stage2Value3 - stage2Value7);
    // Stage 4
    let stage4Value4 = transformRotate(TRANSFORM_COSINES[16], stage3Value4, TRANSFORM_COSINES[48], stage3Value5);
    let stage4Value5 = transformRotate(TRANSFORM_COSINES[48], stage3Value4, -TRANSFORM_COSINES[16], stage3Value5);
    let stage4Value6 = transformRotate(-TRANSFORM_COSINES[48], stage3Value6, TRANSFORM_COSINES[16], stage3Value7);
    let stage4Value7 = transformRotate(TRANSFORM_COSINES[16], stage3Value6, TRANSFORM_COSINES[48], stage3Value7);
    // Stage 5
    let stage5Value0 = transformClampStage(line, stage3Value0 + stage3Value2);
    let stage5Value1 = transformClampStage(line, stage3Value1 + stage3Value3);
    let stage5Value2 = transformClampStage(line, stage3Value0 - stage3Value2);
    let stage5Value3 = transformClampStage(line, stage3Value1 - stage3Value3);
    let stage5Value4 = transformClampStage(line, stage4Value4 + stage4Value6);
    let stage5Value5 = transformClampStage(line, stage4Value5 + stage4Value7);
    let stage5Value6 = transformClampStage(line, stage4Value4 - stage4Value6);
    let stage5Value7 = transformClampStage(line, stage4Value5 - stage4Value7);
    // Stage 6
    let stage6Value2 = transformRotate(TRANSFORM_COSINES[32], stage5Value2, TRANSFORM_COSINES[32], stage5Value3);
    let stage6Value3 = transformRotate(TRANSFORM_COSINES[32], stage5Value2, -TRANSFORM_COSINES[32], stage5Value3);
    let stage6Value6 = transformRotate(TRANSFORM_COSINES[32], stage5Value6, TRANSFORM_COSINES[32], stage5Value7);
    let stage6Value7 = transformRotate(TRANSFORM_COSINES[32], stage5Value6, -TRANSFORM_COSINES[32], stage5Value7);
    transformStorePair(line, 0u, stage5Value0, -stage5Value4);
    transformStorePair(line, 1u, stage6Value6, -stage6Value2);
    transformStorePair(line, 2u, stage6Value3, -stage6Value7);
    transformStorePair(line, 3u, stage5Value5, -stage5Value1);
}

// libaom's av1_iadst16 (av1/common/av1_inv_txfm1d.c), transcribed stage by stage
fn transformInverseADST16(line: TransformLine) {
    let input0 = transformLoad(line, 0u);
    let input1 = transformLoad(line, 1u);
    let input2 = transformLoad(line, 2u);
    let input3 = transformLoad(line, 3u);
    let input4 = transformLoad(line, 4u);
    let input5 = transformLoad(line, 5u);
    let input6 = transformLoad(line, 6u);
    let input7 = transformLoad(line, 7u);
    let input8 = transformLoad(line, 8u);
    let input9 = transformLoad(line, 9u);
    let input10 = transformLoad(line, 10u);
    let input11 = transformLoad(line, 11u);
    let input12 = transformLoad(line, 12u);
    let input13 = transformLoad(line, 13u);
    let input14 = transformLoad(line, 14u);
    let input15 = transformLoad(line, 15u);
    // Stage 2
    let stage2Value0 = transformRotate(TRANSFORM_COSINES[2], input15, TRANSFORM_COSINES[62], input0);
    let stage2Value1 = transformRotate(TRANSFORM_COSINES[62], input15, -TRANSFORM_COSINES[2], input0);
    let stage2Value2 = transformRotate(TRANSFORM_COSINES[10], input13, TRANSFORM_COSINES[54], input2);
    let stage2Value3 = transformRotate(TRANSFORM_COSINES[54], input13, -TRANSFORM_COSINES[10], input2);
    let stage2Value4 = transformRotate(TRANSFORM_COSINES[18], input11, TRANSFORM_COSINES[46], input4);
    let stage2Value5 = transformRotate(TRANSFORM_COSINES[46], input11, -TRANSFORM_COSINES[18], input4);
    let stage2Value6 = transformRotate(TRANSFORM_COSINES[26], input9, TRANSFORM_COSINES[38], input6);
    let stage2Value7 = transformRotate(TRANSFORM_COSINES[38], input9, -TRANSFORM_COSINES[26], input6);
    let stage2Value8 = transformRotate(TRANSFORM_COSINES[34], input7, TRANSFORM_COSINES[30], input8);
    let stage2Value9 = transformRotate(TRANSFORM_COSINES[30], input7, -TRANSFORM_COSINES[34], input8);
    let stage2Value10 = transformRotate(TRANSFORM_COSINES[42], input5, TRANSFORM_COSINES[22], input10);
    let stage2Value11 = transformRotate(TRANSFORM_COSINES[22], input5, -TRANSFORM_COSINES[42], input10);
    let stage2Value12 = transformRotate(TRANSFORM_COSINES[50], input3, TRANSFORM_COSINES[14], input12);
    let stage2Value13 = transformRotate(TRANSFORM_COSINES[14], input3, -TRANSFORM_COSINES[50], input12);
    let stage2Value14 = transformRotate(TRANSFORM_COSINES[58], input1, TRANSFORM_COSINES[6], input14);
    let stage2Value15 = transformRotate(TRANSFORM_COSINES[6], input1, -TRANSFORM_COSINES[58], input14);
    // Stage 3
    let stage3Value0 = transformClampStage(line, stage2Value0 + stage2Value8);
    let stage3Value1 = transformClampStage(line, stage2Value1 + stage2Value9);
    let stage3Value2 = transformClampStage(line, stage2Value2 + stage2Value10);
    let stage3Value3 = transformClampStage(line, stage2Value3 + stage2Value11);
    let stage3Value4 = transformClampStage(line, stage2Value4 + stage2Value12);
    let stage3Value5 = transformClampStage(line, stage2Value5 + stage2Value13);
    let stage3Value6 = transformClampStage(line, stage2Value6 + stage2Value14);
    let stage3Value7 = transformClampStage(line, stage2Value7 + stage2Value15);
    let stage3Value8 = transformClampStage(line, stage2Value0 - stage2Value8);
    let stage3Value9 = transformClampStage(line, stage2Value1 - stage2Value9);
    let stage3Value10 = transformClampStage(line, stage2Value2 - stage2Value10);
    let stage3Value11 = transformClampStage(line, stage2Value3 - stage2Value11);
    let stage3Value12 = transformClampStage(line, stage2Value4 - stage2Value12);
    let stage3Value13 = transformClampStage(line, stage2Value5 - stage2Value13);
    let stage3Value14 = transformClampStage(line, stage2Value6 - stage2Value14);
    let stage3Value15 = transformClampStage(line, stage2Value7 - stage2Value15);
    // Stage 4
    let stage4Value8 = transformRotate(TRANSFORM_COSINES[8], stage3Value8, TRANSFORM_COSINES[56], stage3Value9);
    let stage4Value9 = transformRotate(TRANSFORM_COSINES[56], stage3Value8, -TRANSFORM_COSINES[8], stage3Value9);
    let stage4Value10 = transformRotate(TRANSFORM_COSINES[40], stage3Value10, TRANSFORM_COSINES[24], stage3Value11);
    let stage4Value11 = transformRotate(TRANSFORM_COSINES[24], stage3Value10, -TRANSFORM_COSINES[40], stage3Value11);
    let stage4Value12 = transformRotate(-TRANSFORM_COSINES[56], stage3Value12, TRANSFORM_COSINES[8], stage3Value13);
    let stage4Value13 = transformRotate(TRANSFORM_COSINES[8], stage3Value12, TRANSFORM_COSINES[56], stage3Value13);
    let stage4Value14 = transformRotate(-TRANSFORM_COSINES[24], stage3Value14, TRANSFORM_COSINES[40], stage3Value15);
    let stage4Value15 = transformRotate(TRANSFORM_COSINES[40], stage3Value14, TRANSFORM_COSINES[24], stage3Value15);
    // Stage 5
    let stage5Value0 = transformClampStage(line, stage3Value0 + stage3Value4);
    let stage5Value1 = transformClampStage(line, stage3Value1 + stage3Value5);
    let stage5Value2 = transformClampStage(line, stage3Value2 + stage3Value6);
    let stage5Value3 = transformClampStage(line, stage3Value3 + stage3Value7);
    let stage5Value4 = transformClampStage(line, stage3Value0 - stage3Value4);
    let stage5Value5 = transformClampStage(line, stage3Value1 - stage3Value5);
    let stage5Value6 = transformClampStage(line, stage3Value2 - stage3Value6);
    let stage5Value7 = transformClampStage(line, stage3Value3 - stage3Value7);
    let stage5Value8 = transformClampStage(line, stage4Value8 + stage4Value12);
    let stage5Value9 = transformClampStage(line, stage4Value9 + stage4Value13);
    let stage5Value10 = transformClampStage(line, stage4Value10 + stage4Value14);
    let stage5Value11 = transformClampStage(line, stage4Value11 + stage4Value15);
    let stage5Value12 = transformClampStage(line, stage4Value8 - stage4Value12);
    let stage5Value13 = transformClampStage(line, stage4Value9 - stage4Value13);
    let stage5Value14 = transformClampStage(line, stage4Value10 - stage4Value14);
    let stage5Value15 = transformClampStage(line, stage4Value11 - stage4Value15);
    // Stage 6
    let stage6Value4 = transformRotate(TRANSFORM_COSINES[16], stage5Value4, TRANSFORM_COSINES[48], stage5Value5);
    let stage6Value5 = transformRotate(TRANSFORM_COSINES[48], stage5Value4, -TRANSFORM_COSINES[16], stage5Value5);
    let stage6Value6 = transformRotate(-TRANSFORM_COSINES[48], stage5Value6, TRANSFORM_COSINES[16], stage5Value7);
    let stage6Value7 = transformRotate(TRANSFORM_COSINES[16], stage5Value6, TRANSFORM_COSINES[48], stage5Value7);
    let stage6Value12 = transformRotate(TRANSFORM_COSINES[16], stage5Value12, TRANSFORM_COSINES[48], stage5Value13);
    let stage6Value13 = transformRotate(TRANSFORM_COSINES[48], stage5Value12, -TRANSFORM_COSINES[16], stage5Value13);
    let stage6Value14 = transformRotate(-TRANSFORM_COSINES[48], stage5Value14, TRANSFORM_COSINES[16], stage5Value15);
    let stage6Value15 = transformRotate(TRANSFORM_COSINES[16], stage5Value14, TRANSFORM_COSINES[48], stage5Value15);
    // Stage 7
    let stage7Value0 = transformClampStage(line, stage5Value0 + stage5Value2);
    let stage7Value1 = transformClampStage(line, stage5Value1 + stage5Value3);
    let stage7Value2 = transformClampStage(line, stage5Value0 - stage5Value2);
    let stage7Value3 = transformClampStage(line, stage5Value1 - stage5Value3);
    let stage7Value4 = transformClampStage(line, stage6Value4 + stage6Value6);
    let stage7Value5 = transformClampStage(line, stage6Value5 + stage6Value7);
    let stage7Value6 = transformClampStage(line, stage6Value4 - stage6Value6);
    let stage7Value7 = transformClampStage(line, stage6Value5 - stage6Value7);
    let stage7Value8 = transformClampStage(line, stage5Value8 + stage5Value10);
    let stage7Value9 = transformClampStage(line, stage5Value9 + stage5Value11);
    let stage7Value10 = transformClampStage(line, stage5Value8 - stage5Value10);
    let stage7Value11 = transformClampStage(line, stage5Value9 - stage5Value11);
    let stage7Value12 = transformClampStage(line, stage6Value12 + stage6Value14);
    let stage7Value13 = transformClampStage(line, stage6Value13 + stage6Value15);
    let stage7Value14 = transformClampStage(line, stage6Value12 - stage6Value14);
    let stage7Value15 = transformClampStage(line, stage6Value13 - stage6Value15);
    // Stage 8
    let stage8Value2 = transformRotate(TRANSFORM_COSINES[32], stage7Value2, TRANSFORM_COSINES[32], stage7Value3);
    let stage8Value3 = transformRotate(TRANSFORM_COSINES[32], stage7Value2, -TRANSFORM_COSINES[32], stage7Value3);
    let stage8Value6 = transformRotate(TRANSFORM_COSINES[32], stage7Value6, TRANSFORM_COSINES[32], stage7Value7);
    let stage8Value7 = transformRotate(TRANSFORM_COSINES[32], stage7Value6, -TRANSFORM_COSINES[32], stage7Value7);
    let stage8Value10 = transformRotate(TRANSFORM_COSINES[32], stage7Value10, TRANSFORM_COSINES[32], stage7Value11);
    let stage8Value11 = transformRotate(TRANSFORM_COSINES[32], stage7Value10, -TRANSFORM_COSINES[32], stage7Value11);
    let stage8Value14 = transformRotate(TRANSFORM_COSINES[32], stage7Value14, TRANSFORM_COSINES[32], stage7Value15);
    let stage8Value15 = transformRotate(TRANSFORM_COSINES[32], stage7Value14, -TRANSFORM_COSINES[32], stage7Value15);
    transformStorePair(line, 0u, stage7Value0, -stage7Value8);
    transformStorePair(line, 1u, stage7Value12, -stage7Value4);
    transformStorePair(line, 2u, stage8Value6, -stage8Value14);
    transformStorePair(line, 3u, stage8Value10, -stage8Value2);
    transformStorePair(line, 4u, stage8Value3, -stage8Value11);
    transformStorePair(line, 5u, stage8Value15, -stage8Value7);
    transformStorePair(line, 6u, stage7Value5, -stage7Value13);
    transformStorePair(line, 7u, stage7Value9, -stage7Value1);
}

// One output of libaom's av1_iidentity4_c, 8, 16, and 32
fn transformScaleIdentity(kind: u32, value: i32) -> i32 {
    switch (kind) {
        case TRANSFORM_KIND_IDENTITY4: { return transformScaleRound(TRANSFORM_SQRT2, value); }
        case TRANSFORM_KIND_IDENTITY8: { return value * TRANSFORM_IDENTITY8_SCALE; }
        case TRANSFORM_KIND_IDENTITY16: { return transformScaleRound(2 * TRANSFORM_SQRT2, value); }
        default: { return value * TRANSFORM_IDENTITY32_SCALE; }
    }
}

// libaom's identity transforms: each output scales its own input
fn transformInverseIdentity(kind: u32, line: TransformLine) {
    let pairCount = 2u << (kind - TRANSFORM_KIND_IDENTITY4);
    for (var pairIndex = 0u; pairIndex < pairCount; pairIndex += 1u) {
        let first = transformScaleIdentity(kind, transformLoad(line, 2u * pairIndex));
        let second = transformScaleIdentity(kind, transformLoad(line, 2u * pairIndex + 1u));
        transformStorePair(line, pairIndex, first, second);
    }
}

// One pass of libaom's av1_highbd_iwht4x4_16_add_c: the 4-point Walsh-Hadamard butterfly, without clamps; valueA to valueD are its
// a1 to d1, which read inputs 0, 3, 1, and 2
fn transformInverseWalshHadamard4(line: TransformLine) {
    var valueA = transformLoad(line, 0u);
    var valueC = transformLoad(line, 1u);
    var valueD = transformLoad(line, 2u);
    var valueB = transformLoad(line, 3u);
    valueA += valueC;
    valueD -= valueB;
    let halfDifference = (valueA - valueD) >> 1u;
    valueB = halfDifference - valueB;
    valueC = halfDifference - valueC;
    valueA -= valueB;
    valueD += valueC;
    transformStorePair(line, 0u, valueA, valueB);
    transformStorePair(line, 1u, valueC, valueD);
}

// Runs one line's 1D inverse transform of a job without a 64-point side; each transform has this one call site in its kernel, so
// the kernel holds one copy of each
fn transformRunLine(kind: u32, line: TransformLine) {
    switch (kind) {
        case TRANSFORM_KIND_DCT4: { transformInverseDCT4(line); }
        case TRANSFORM_KIND_DCT8: { transformInverseDCT8(line); }
        case TRANSFORM_KIND_DCT16: { transformInverseDCT16(line); }
        case TRANSFORM_KIND_DCT32: { transformInverseDCT32(line); }
        case TRANSFORM_KIND_ADST4: { transformInverseADST4(line); }
        case TRANSFORM_KIND_ADST8: { transformInverseADST8(line); }
        case TRANSFORM_KIND_ADST16: { transformInverseADST16(line); }
        case TRANSFORM_KIND_IDENTITY4, TRANSFORM_KIND_IDENTITY8, TRANSFORM_KIND_IDENTITY16, TRANSFORM_KIND_IDENTITY32: {
            transformInverseIdentity(kind, line);
        }
        case TRANSFORM_KIND_WALSH_HADAMARD4: { transformInverseWalshHadamard4(line); }
        default: {}
    }
}

// Runs one line's 1D inverse transform of a job with a 64-point side. Streams code these sizes with DCT_DCT only (av1_get_tx_type),
// and the large run rejects any other type, so the line is a DCT64 along that side and a DCT16 (TX_16X64, TX_64X16) or DCT32 (TX_32X64,
// TX_64X32) across it; each transform has this one call site in its kernel
fn transformRunLine64(kind: u32, line: TransformLine) {
    switch (kind) {
        case TRANSFORM_KIND_DCT16: { transformInverseDCT16(line); }
        case TRANSFORM_KIND_DCT32: { transformInverseDCT32(line); }
        case TRANSFORM_KIND_DCT64: { transformInverseDCT64(line); }
        default: {}
    }
}

// The 1D transform of a 1D type at a side (libaom's av1_txfm_type_ls): flipped ADST is ADST, flipped when the block is written
fn transformGetKind(type1D: u32, sideLog2: u32) -> u32 {
    let sizeIndex = sideLog2 - TRANSFORM_SMALLEST_SIDE_LOG2;
    switch (type1D) {
        case TRANSFORM_1D_DCT: { return TRANSFORM_KIND_DCT4 + sizeIndex; }
        case TRANSFORM_1D_IDENTITY: { return TRANSFORM_KIND_IDENTITY4 + sizeIndex; }
        default: { return TRANSFORM_KIND_ADST4 + sizeIndex; }
    }
}

// The row pass's output round shift of a TX_SIZE
fn transformGetRowShift(transformSize: u32) -> u32 {
    if (transformSize < TRANSFORM_ROW_SHIFTS_LOW_SIZES) {
        return (TRANSFORM_ROW_SHIFTS_LOW >> (2u * transformSize)) & TRANSFORM_ROW_SHIFT_MASK;
    }
    return (TRANSFORM_ROW_SHIFTS_HIGH >> (2u * (transformSize - TRANSFORM_ROW_SHIFTS_LOW_SIZES))) & TRANSFORM_ROW_SHIFT_MASK;
}

// Decodes a transform job's words (position, coding, and payload offset), which the chunk's plan keeps
fn transformDecodeJob(words: vec3u) -> TransformJob {
    let position = words.x;
    let coding = words.y;
    var job: TransformJob;
    job.transformSize = getField(position, RECORD_TRANSFORM_JOB_TX_SIZE_SHIFT, RECORD_TRANSFORM_JOB_TX_SIZE_BITS);
    job.plane = getField(position, RECORD_TRANSFORM_JOB_PLANE_SHIFT, RECORD_TRANSFORM_JOB_PLANE_BITS);
    job.originX = getField(position, RECORD_TRANSFORM_JOB_X4_SHIFT, RECORD_TRANSFORM_JOB_COORDINATE_BITS) << MI_SIZE_LOG2;
    job.originY = getField(position, RECORD_TRANSFORM_JOB_Y4_SHIFT, RECORD_TRANSFORM_JOB_COORDINATE_BITS) << MI_SIZE_LOG2;
    job.widthLog2 = getTransformWidthLog2(job.transformSize);
    job.heightLog2 = getTransformHeightLog2(job.transformSize);
    job.codedWidthLog2 = min(job.widthLog2, TRANSFORM_MAXIMUM_CODED_SIDE_LOG2);
    job.codedHeightLog2 = min(job.heightLog2, TRANSFORM_MAXIMUM_CODED_SIDE_LOG2);
    job.lossless = getField(position, RECORD_TRANSFORM_JOB_LOSSLESS_SHIFT, TRANSFORM_JOB_FLAG_BITS) == 1u;
    let transformType = getField(coding, RECORD_TRANSFORM_JOB_TX_TYPE_SHIFT, RECORD_TRANSFORM_JOB_TX_TYPE_BITS);
    let columnType = getField(TRANSFORM_COLUMN_TYPES, TRANSFORM_1D_TYPE_BITS * transformType, TRANSFORM_1D_TYPE_BITS);
    let rowType = getField(TRANSFORM_ROW_TYPES, TRANSFORM_1D_TYPE_BITS * transformType, TRANSFORM_1D_TYPE_BITS);
    job.flipRows = !job.lossless && columnType == TRANSFORM_1D_FLIPADST;
    job.flipColumns = !job.lossless && rowType == TRANSFORM_1D_FLIPADST;
    job.rowKind = select(transformGetKind(rowType, job.widthLog2), TRANSFORM_KIND_WALSH_HADAMARD4, job.lossless);
    job.columnKind = select(transformGetKind(columnType, job.heightLog2), TRANSFORM_KIND_WALSH_HADAMARD4, job.lossless);
    job.destination = getField(coding, RECORD_TRANSFORM_JOB_DESTINATION_SHIFT, TRANSFORM_JOB_FLAG_BITS);
    job.sparse = getField(coding, RECORD_TRANSFORM_JOB_SPARSE_SHIFT, TRANSFORM_JOB_FLAG_BITS) == 1u;
    job.valueBits = clamp(getField(coding, RECORD_TRANSFORM_JOB_VALUE_BITS_SHIFT, RECORD_TRANSFORM_JOB_VALUE_BITS_BITS), 1u, TRANSFORM_MAXIMUM_VALUE_BITS);
    job.payload = readRecordWord(RECORD_HEADER_COEFFICIENTS) + words.z;
    let codedWidth = 1u << job.codedWidthLog2;
    let codedHeight = 1u << job.codedHeightLog2;
    job.payloadColumns = min(getField(coding, RECORD_TRANSFORM_JOB_BOX_COLUMNS_SHIFT, RECORD_TRANSFORM_JOB_BOX_BITS) + 1u, codedWidth);
    job.payloadRows = min(getField(coding, RECORD_TRANSFORM_JOB_BOX_ROWS_SHIFT, RECORD_TRANSFORM_JOB_BOX_BITS) + 1u, codedHeight);
    job.entryCount = getField(coding, RECORD_TRANSFORM_JOB_COUNT_SHIFT, RECORD_TRANSFORM_JOB_COUNT_BITS) + 1u;
    job.boxColumns = select(job.payloadColumns, codedWidth, job.sparse);
    job.boxRows = select(job.payloadRows, codedHeight, job.sparse);
    job.stagingStride = codedWidth + 1u;
    // libaom's av1_highbd_iwht4x4_1_add_c reads only the DC coefficient when the end of block is at most 1
    let endOfBlock = getField(coding, RECORD_TRANSFORM_JOB_EOB_SHIFT, RECORD_TRANSFORM_JOB_EOB_BITS);
    if (job.lossless && endOfBlock <= 1u) {
        job.boxColumns = 1u;
        job.boxRows = 1u;
    }
    return job;
}

// Reads bitCount (1 to 31) bits of a coefficient payload at a bit offset, least significant bit first. Both words the bits may span
// are always read, so no read waits behind a branch
fn transformReadPayloadBits(payload: u32, bitOffset: u32, bitCount: u32) -> u32 {
    let wordIndex = payload + (bitOffset >> TRANSFORM_WORD_SHIFT);
    let shift = bitOffset & TRANSFORM_WORD_BIT_MASK;
    let low = readRecordWord(wordIndex) >> shift;
    let high = readRecordWord(wordIndex + 1u);
    let bits = select(low, low | (high << (TRANSFORM_WORD_BITS - shift)), shift + bitCount > TRANSFORM_WORD_BITS);
    return bits & ((1u << bitCount) - 1u);
}

// A two's complement coefficient of valueBits bits, clamped to libaom's dqcoeff range
fn transformExtendCoefficient(bits: u32, valueBits: u32) -> i32 {
    let unused = TRANSFORM_WORD_BITS - valueBits;
    return clamp(bitcast<i32>(bits << unused) >> unused, TRANSFORM_ROW_LOW, TRANSFORM_ROW_HIGH);
}

// The payload bits of a dense box slot (the box's rows in spans of a power of two, column by column)
fn transformReadSlot(job: TransformJob, slot: u32, rowSpanLog2: u32) -> u32 {
    let row = slot & ((1u << rowSpanLog2) - 1u);
    let column = slot >> rowSpanLog2;
    return transformReadPayloadBits(job.payload, (column * job.payloadRows + row) * job.valueBits, job.valueBits);
}

// Stores a dense box slot's coefficient in the job's staging rows when the slot lies in the box
fn transformStoreSlot(job: TransformJob, slot: u32, inBox: bool, bits: u32, rowSpanLog2: u32) {
    if (inBox) {
        let row = slot & ((1u << rowSpanLog2) - 1u);
        transformMemory[job.stagingBase + row * job.stagingStride + (slot >> rowSpanLog2)] = transformExtendCoefficient(bits, job.valueBits);
    }
}

// Decodes a dense job's coefficients into its staging rows (the box in column-major order), or zeroes a sparse job's coded area for
// transformDecodeEntries; the job's lanes share the work. A lane takes TRANSFORM_DECODE_SLOTS slots per pass and reads them all
// before storing any (slot 0's payload for a slot past the box), so their reads overlap
fn transformDecodeCoefficients(job: TransformJob, laneInJob: u32, laneCount: u32) {
    if (!job.sparse) {
        // Lanes take the box's rows in spans of a power of two, so no lane divides
        let rowSpanLog2 = TRANSFORM_WORD_BITS - countLeadingZeros(job.payloadRows - 1u);
        let slotCount = job.payloadColumns << rowSpanLog2;
        for (var slot = laneInJob; slot < slotCount; slot += TRANSFORM_DECODE_SLOTS * laneCount) {
            let slots = vec4u(slot) + laneCount * TRANSFORM_DECODE_MEMBERS;
            let inBox = (slots < vec4u(slotCount)) & ((slots & vec4u((1u << rowSpanLog2) - 1u)) < vec4u(job.payloadRows));
            let readSlots = select(vec4u(0u), slots, inBox);
            let bits = vec4u(transformReadSlot(job, readSlots.x, rowSpanLog2), transformReadSlot(job, readSlots.y, rowSpanLog2),
                transformReadSlot(job, readSlots.z, rowSpanLog2), transformReadSlot(job, readSlots.w, rowSpanLog2));
            transformStoreSlot(job, readSlots.x, inBox.x, bits.x, rowSpanLog2);
            transformStoreSlot(job, readSlots.y, inBox.y, bits.y, rowSpanLog2);
            transformStoreSlot(job, readSlots.z, inBox.z, bits.z, rowSpanLog2);
            transformStoreSlot(job, readSlots.w, inBox.w, bits.w, rowSpanLog2);
        }
        return;
    }
    let codedCount = 1u << (job.codedWidthLog2 + job.codedHeightLog2);
    for (var index = laneInJob; index < codedCount; index += laneCount) {
        let row = index >> job.codedWidthLog2;
        let column = index & ((1u << job.codedWidthLog2) - 1u);
        transformMemory[job.stagingBase + row * job.stagingStride + column] = 0;
    }
}

// Stores a sparse entry, a coded position (column * coded height + row) and a value, when it is one of the job's and in its area
fn transformStoreEntry(job: TransformJob, present: bool, bits: u32) {
    let position = bits & ((1u << RECORD_TRANSFORM_JOB_POSITION_BITS) - 1u);
    if (present && position < (1u << (job.codedWidthLog2 + job.codedHeightLog2))) {
        let row = position & ((1u << job.codedHeightLog2) - 1u);
        let column = position >> job.codedHeightLog2;
        transformMemory[job.stagingBase + row * job.stagingStride + column] = transformExtendCoefficient(bits >> RECORD_TRANSFORM_JOB_POSITION_BITS, job.valueBits);
    }
}

// Writes a sparse job's entries over its zeroed coded area, TRANSFORM_DECODE_SLOTS per lane and pass, all read before any is stored
fn transformDecodeEntries(job: TransformJob, laneInJob: u32, laneCount: u32) {
    let entryBits = RECORD_TRANSFORM_JOB_POSITION_BITS + job.valueBits;
    for (var entry = laneInJob; entry < job.entryCount; entry += TRANSFORM_DECODE_SLOTS * laneCount) {
        let entries = vec4u(entry) + laneCount * TRANSFORM_DECODE_MEMBERS;
        let present = entries < vec4u(job.entryCount);
        let readEntries = select(vec4u(0u), entries, present) * entryBits;
        let bits = vec4u(transformReadPayloadBits(job.payload, readEntries.x, entryBits), transformReadPayloadBits(job.payload, readEntries.y, entryBits),
            transformReadPayloadBits(job.payload, readEntries.z, entryBits), transformReadPayloadBits(job.payload, readEntries.w, entryBits));
        transformStoreEntry(job, present.x, bits.x);
        transformStoreEntry(job, present.y, bits.y);
        transformStoreEntry(job, present.z, bits.z);
        transformStoreEntry(job, present.w, bits.w);
    }
}

// A job lane's line of a pass: rows read the staging rows and write the row outputs; columns read the row outputs and write packed pairs
fn transformGetLine(job: TransformJob, passIndex: u32, laneInJob: u32) -> TransformLine {
    let lineStride = (1u << job.widthLog2) + 1u;
    var line: TransformLine;
    if (passIndex == TRANSFORM_ROW_PASS) {
        let rectangular = abs(i32(job.widthLog2) - i32(job.heightLog2)) == 1;
        line.inputBase = job.stagingBase + laneInJob * job.stagingStride;
        line.inputStride = 1u;
        line.inputCount = job.boxColumns;
        line.outputBase = job.linesBase + laneInJob * lineStride;
        line.outputStride = 1u;
        line.packOutputs = false;
        line.inputMultiplier = select(1, TRANSFORM_INVERSE_SQRT2, rectangular);
        line.inputRounding = select(0, TRANSFORM_SQRT2_ROUNDING, rectangular);
        line.inputShift = select(0u, TRANSFORM_SQRT2_BITS, rectangular);
        line.clampLow = TRANSFORM_ROW_LOW;
        line.clampHigh = TRANSFORM_ROW_HIGH;
        let rowShift = transformGetRowShift(job.transformSize);
        line.outputShift = rowShift;
        line.outputRounding = (1 << rowShift) >> 1u;
    } else {
        line.inputBase = job.linesBase + laneInJob;
        line.inputStride = lineStride;
        line.inputCount = job.boxRows;
        line.outputBase = job.linesBase + laneInJob;
        line.outputStride = lineStride;
        line.packOutputs = true;
        line.inputMultiplier = 1;
        line.inputRounding = 0;
        line.inputShift = 0u;
        line.clampLow = TRANSFORM_COLUMN_LOW;
        line.clampHigh = TRANSFORM_COLUMN_HIGH;
        line.outputShift = TRANSFORM_COLUMN_SHIFT;
        line.outputRounding = TRANSFORM_COLUMN_ROUNDING;
    }
    if (job.lossless) {
        line.inputMultiplier = 1;
        line.inputRounding = 0;
        line.inputShift = select(0u, TRANSFORM_LOSSLESS_INPUT_SHIFT, passIndex == TRANSFORM_ROW_PASS);
        line.clampLow = TRANSFORM_UNCLAMPED_LOW;
        line.clampHigh = TRANSFORM_UNCLAMPED_HIGH;
        line.outputShift = 0u;
        line.outputRounding = 0;
    }
    return line;
}

// One output word of a job's block: its first sample's position, whether it lies in the block and the plane (words that do not sit at
// the job's origin and read the block's word 0, so their reads stay harmless), and its two residuals; the transform type's flips pick
// each sample's residual (libaom's lr_flip and ud_flip)
struct TransformOutputWord {
    x: u32,
    y: u32,
    inside: bool,
    residuals: vec2i,
}

fn transformGetOutputWord(job: TransformJob, word: u32, wordCount: u32, planeWidth: u32, planeHeight: u32) -> TransformOutputWord {
    let width = 1u << job.widthLog2;
    let height = 1u << job.heightLog2;
    let pairsLog2 = job.widthLog2 - SAMPLE_PAIR_SHIFT;
    let blockWord = select(0u, word, word < wordCount);
    let row = blockWord >> pairsLog2;
    let column = (blockWord & ((1u << pairsLog2) - 1u)) << SAMPLE_PAIR_SHIFT;
    var output: TransformOutputWord;
    output.inside = word < wordCount && job.originX + column < planeWidth && job.originY + row < planeHeight;
    output.x = select(job.originX, job.originX + column, output.inside);
    output.y = select(job.originY, job.originY + row, output.inside);
    let sourceRow = select(row, height - 1u - row, job.flipRows);
    let firstColumn = select(column, width - 1u - column, job.flipColumns);
    let secondColumn = select(column + 1u, width - 2u - column, job.flipColumns);
    let pairBase = job.linesBase + (sourceRow >> 1u) * (width + 1u);
    // The pair's low half holds even rows; shifting the wanted half to the top sign-extends it
    let halfShift = (1u - (sourceRow & 1u)) * TRANSFORM_HALF_BITS;
    output.residuals = vec2i(
        bitcast<i32>(bitcast<u32>(transformMemory[pairBase + firstColumn]) << halfShift) >> TRANSFORM_HALF_BITS,
        bitcast<i32>(bitcast<u32>(transformMemory[pairBase + secondColumn]) << halfShift) >> TRANSFORM_HALF_BITS);
    return output;
}

// An output word added to the target buffer's samples and clipped
fn transformReconstruct(output: TransformOutputWord, stored: vec2u) -> vec2u {
    return vec2u(clipSample(i32(stored.x) + output.residuals.x, OUTPUT_BIT_DEPTH), clipSample(i32(stored.y) + output.residuals.y, OUTPUT_BIT_DEPTH));
}

// Adds the residuals to the target buffer and clips (destination 0), or writes them to the scratch buffer (destination 1), two words
// of two samples per job lane and pass; destination 0 reads both words' targets before writing either, so the reads overlap
fn transformWriteBlock(job: TransformJob, laneInJob: u32, laneCount: u32) {
    let wordCount = 1u << (job.heightLog2 + job.widthLog2 - SAMPLE_PAIR_SHIFT);
    let planeWidth = getStorePlaneWidth(job.plane);
    let planeHeight = getStorePlaneHeight(job.plane);
    let targetBuffer = readRecordWord(RECORD_HEADER_TARGET_BUFFER);
    for (var word = laneInJob; word < wordCount; word += TRANSFORM_WRITE_WORDS * laneCount) {
        let first = transformGetOutputWord(job, word, wordCount, planeWidth, planeHeight);
        let second = transformGetOutputWord(job, word + laneCount, wordCount, planeWidth, planeHeight);
        if (job.destination == RECORD_TRANSFORM_DESTINATION_RESIDUAL) {
            if (first.inside) {
                writeResidualPair(job.plane, first.x, first.y, first.residuals);
            }
            if (second.inside) {
                writeResidualPair(job.plane, second.x, second.y, second.residuals);
            }
            continue;
        }
        let firstTarget = vec2u(readStoreSample(targetBuffer, job.plane, first.x, first.y), readStoreSample(targetBuffer, job.plane, first.x + 1u, first.y));
        let secondTarget = vec2u(readStoreSample(targetBuffer, job.plane, second.x, second.y), readStoreSample(targetBuffer, job.plane, second.x + 1u, second.y));
        if (first.inside) {
            writeStoreSamplePair(targetBuffer, job.plane, first.x, first.y, transformReconstruct(first, firstTarget));
        }
        if (second.inside) {
            writeStoreSamplePair(targetBuffer, job.plane, second.x, second.y, transformReconstruct(second, secondTarget));
        }
    }
}

// Plans a chunk of consecutive jobs of a run's range into rounds. A job takes as many lanes as its widest pass (its width, or its
// coded rows), lines for the larger of its coded rows and half its rows, and staging for its coded area; a round takes jobs in order
// while they fit the lanes and the memory, its staging clear of the round before's lines. A job the run cannot take (one with a
// 64-point side in the small range; in the large range one without, or one of another type than DCT_DCT, the only type streams
// code there) is reported as RECORD_INVALID_TRANSFORM_JOB and not decoded. Returns the round count, with the rounds that hold a
// sparse job as bits from TRANSFORM_PLAN_SPARSE_SHIFT on
fn transformPlanChunk(chunkStart: u32, chunkJobs: u32, jobClass: u32, lane: u32) -> u32 {
    if (lane < chunkJobs) {
        let position = readTransformJobWord(chunkStart + lane, RECORD_TRANSFORM_JOB_POSITION);
        let coding = readTransformJobWord(chunkStart + lane, RECORD_TRANSFORM_JOB_CODING);
        transformJobWords[lane] = vec3u(position, coding, readTransformJobWord(chunkStart + lane, RECORD_TRANSFORM_JOB_PAYLOAD));
        let transformSize = getField(position, RECORD_TRANSFORM_JOB_TX_SIZE_SHIFT, RECORD_TRANSFORM_JOB_TX_SIZE_BITS);
        let widthLog2 = getTransformWidthLog2(transformSize);
        let heightLog2 = getTransformHeightLog2(transformSize);
        let large = max(widthLog2, heightLog2) == TRANSFORM_LARGE_SIDE_LOG2;
        let plainDCT = getField(coding, RECORD_TRANSFORM_JOB_TX_TYPE_SHIFT, RECORD_TRANSFORM_JOB_TX_TYPE_BITS) == TRANSFORM_TYPE_DCT_DCT
            && getField(position, RECORD_TRANSFORM_JOB_LOSSLESS_SHIFT, TRANSFORM_JOB_FLAG_BITS) == 0u;
        let taken = select(!large, large && plainDCT, jobClass == TRANSFORM_JOBS_LARGE);
        if (!taken) {
            reportDecodeError(getRecordInvalidError(RECORD_INVALID_TRANSFORM_JOB));
        }
        let codedRows = 1u << min(heightLog2, TRANSFORM_MAXIMUM_CODED_SIDE_LOG2);
        let codedColumns = 1u << min(widthLog2, TRANSFORM_MAXIMUM_CODED_SIDE_LOG2);
        let linesWords = max(codedRows, 1u << (heightLog2 - 1u)) * ((1u << widthLog2) + 1u);
        let stagingWords = codedRows * (codedColumns + 1u);
        let sparse = getField(coding, RECORD_TRANSFORM_JOB_SPARSE_SHIFT, TRANSFORM_JOB_FLAG_BITS);
        transformPlan[lane] = select(vec4u(TRANSFORM_PLAN_SKIPPED, 0u, 0u, 0u), vec4u(sparse, max(1u << widthLog2, codedRows), linesWords, stagingWords), taken);
    }
    workgroupBarrier();
    if (lane == 0u) {
        var roundCount = 0u;
        var laneSum = 0u;
        var linesSum = 0u;
        var stagingSum = 0u;
        var previousLines = 0u;
        var sparseRounds = 0u;
        for (var job = 0u; job < chunkJobs; job += 1u) {
            let need = transformPlan[job];
            if (need.x == TRANSFORM_PLAN_SKIPPED) {
                continue;
            }
            let fits = laneSum + need.y <= TRANSFORM_LANES && linesSum + need.z + stagingSum + need.w <= TRANSFORM_MEMORY_WORDS
                && previousLines + stagingSum + need.w <= TRANSFORM_MEMORY_WORDS;
            if (roundCount == 0u || !fits) {
                if (roundCount > 0u) {
                    transformRoundLanes[roundCount - 1u] = laneSum;
                }
                roundCount += 1u;
                previousLines = linesSum;
                laneSum = 0u;
                linesSum = 0u;
                stagingSum = 0u;
            }
            let round = roundCount - 1u;
            stagingSum += need.w;
            sparseRounds |= need.x << round;
            transformPlan[job] = vec4u(round, laneSum, need.y, linesSum | ((TRANSFORM_MEMORY_WORDS - stagingSum) << TRANSFORM_HALF_BITS));
            laneSum += need.y;
            linesSum += need.z;
        }
        if (roundCount > 0u) {
            transformRoundLanes[roundCount - 1u] = laneSum;
        }
        transformRounds = roundCount | (sparseRounds << TRANSFORM_PLAN_SPARSE_SHIFT);
    }
    return workgroupUniformLoad(&transformRounds);
}

// A lane's share of a round: its job, if any, and its place among the job's lanes
struct TransformRoundShare {
    job: TransformJob,
    assigned: bool,
    laneInJob: u32,
    laneCount: u32,
}

// Begins a round of a planned chunk: each job's lanes decode its coefficients; the sparse entries, which land on a zeroed area, take
// a barrier of their own in rounds that hold a sparse job. Each job's lanes are scaled by the largest power of two that keeps the
// round's lanes within 64
fn transformBeginRound(chunkJobs: u32, round: u32, sparseRound: bool, lane: u32) -> TransformRoundShare {
    let scaleLog2 = countLeadingZeros(transformRoundLanes[round] - 1u) - countLeadingZeros(TRANSFORM_LANES - 1u);
    var slot = chunkJobs;
    for (var planned = 0u; planned < chunkJobs; planned += 1u) {
        let plan = transformPlan[planned];
        if (plan.x == round && lane - (plan.y << scaleLog2) < (plan.z << scaleLog2)) {
            slot = planned;
        }
    }
    var share: TransformRoundShare;
    share.assigned = slot < chunkJobs;
    share.laneCount = 1u;
    if (share.assigned) {
        let plan = transformPlan[slot];
        share.job = transformDecodeJob(transformJobWords[slot]);
        share.job.linesBase = plan.w & TRANSFORM_HALF_MASK;
        share.job.stagingBase = plan.w >> TRANSFORM_HALF_BITS;
        share.laneInJob = lane - (plan.y << scaleLog2);
        share.laneCount = plan.z << scaleLog2;
        transformDecodeCoefficients(share.job, share.laneInJob, share.laneCount);
    }
    workgroupBarrier();
    if (sparseRound) {
        if (share.assigned && share.job.sparse) {
            transformDecodeEntries(share.job, share.laneInJob, share.laneCount);
        }
        workgroupBarrier();
    }
    return share;
}

// A run's chunks over its range of the record's jobs (the small run's jobs before RECORD_HEADER_TRANSFORM_LARGE_JOB, the large run's
// from there on): the range's first job and job count, the jobs per chunk (the range's jobs per workgroup, 1 to 16), and the chunk
// count; no chunks when the record does not decode a frame. Chunk c holds the range's jobs c * chunkJobs onward, and a workgroup runs
// chunks workgroupIndex, workgroupIndex + workgroupCount, and so on, each in rounds of jobs that share its lanes. beginFrame rejects a
// large start past the job count; the clamp keeps the ranges inside the jobs regardless
fn transformGetChunks(jobClass: u32, workgroupCount: u32, lane: u32) -> vec4u {
    if (lane == 0u) {
        transformValid = select(0u, 1u, isDecodingFrame());
    }
    if (workgroupUniformLoad(&transformValid) == 0u) {
        return vec4u(0u);
    }
    let jobCount = readRecordWord(RECORD_HEADER_TRANSFORM_JOB_COUNT);
    let largeStart = min(readRecordWord(RECORD_HEADER_TRANSFORM_LARGE_JOB), jobCount);
    let firstJob = select(0u, largeStart, jobClass == TRANSFORM_JOBS_LARGE);
    let rangeJobs = select(largeStart, jobCount - largeStart, jobClass == TRANSFORM_JOBS_LARGE);
    let chunkJobs = clamp((rangeJobs + workgroupCount - 1u) / workgroupCount, 1u, TRANSFORM_CHUNK_JOBS);
    return vec4u(firstJob, rangeJobs, chunkJobs, (rangeJobs + chunkJobs - 1u) / chunkJobs);
}

// Whether a planned round holds a sparse job
fn transformIsSparseRound(plan: u32, round: u32) -> bool {
    return ((plan >> (TRANSFORM_PLAN_SPARSE_SHIFT + round)) & 1u) == 1u;
}

// Runs the record's transform jobs without a 64-point side, which it lists first, before RECORD_HEADER_TRANSFORM_LARGE_JOB (the
// contract's inverse transform). transformRunLargeJobs, another entry point on the same grid, runs the rest; each run has its own 1D
// dispatcher, so the DCT64 compiles into the large kernel only
fn transformRunSmallJobs(workgroupIndex: u32, workgroupCount: u32, lane: u32) {
    let chunks = transformGetChunks(TRANSFORM_JOBS_SMALL, workgroupCount, lane);
    for (var chunk = workgroupIndex; chunk < chunks.w; chunk += workgroupCount) {
        let jobsHere = min(chunks.z, chunks.y - chunk * chunks.z);
        let plan = transformPlanChunk(chunks.x + chunk * chunks.z, jobsHere, TRANSFORM_JOBS_SMALL, lane);
        for (var round = 0u; round < (plan & TRANSFORM_PLAN_ROUND_MASK); round += 1u) {
            let share = transformBeginRound(jobsHere, round, transformIsSparseRound(plan, round), lane);
            for (var passIndex = 0u; passIndex < TRANSFORM_PASSES; passIndex += 1u) {
                let isRowPass = passIndex == TRANSFORM_ROW_PASS;
                if (share.assigned && share.laneInJob < select(1u << share.job.widthLog2, share.job.boxRows, isRowPass)) {
                    transformRunLine(select(share.job.columnKind, share.job.rowKind, isRowPass), transformGetLine(share.job, passIndex, share.laneInJob));
                }
                workgroupBarrier();
            }
            if (share.assigned) {
                transformWriteBlock(share.job, share.laneInJob, share.laneCount);
            }
        }
    }
}

// Runs the record's transform jobs with a 64-point side (TX_64X64, TX_32X64, TX_64X32, TX_16X64, TX_64X16), which it lists from
// RECORD_HEADER_TRANSFORM_LARGE_JOB on
fn transformRunLargeJobs(workgroupIndex: u32, workgroupCount: u32, lane: u32) {
    let chunks = transformGetChunks(TRANSFORM_JOBS_LARGE, workgroupCount, lane);
    for (var chunk = workgroupIndex; chunk < chunks.w; chunk += workgroupCount) {
        let jobsHere = min(chunks.z, chunks.y - chunk * chunks.z);
        let plan = transformPlanChunk(chunks.x + chunk * chunks.z, jobsHere, TRANSFORM_JOBS_LARGE, lane);
        for (var round = 0u; round < (plan & TRANSFORM_PLAN_ROUND_MASK); round += 1u) {
            let share = transformBeginRound(jobsHere, round, transformIsSparseRound(plan, round), lane);
            for (var passIndex = 0u; passIndex < TRANSFORM_PASSES; passIndex += 1u) {
                let isRowPass = passIndex == TRANSFORM_ROW_PASS;
                if (share.assigned && share.laneInJob < select(1u << share.job.widthLog2, share.job.boxRows, isRowPass)) {
                    transformRunLine64(select(share.job.columnKind, share.job.rowKind, isRowPass), transformGetLine(share.job, passIndex, share.laneInJob));
                }
                workgroupBarrier();
            }
            if (share.assigned) {
                transformWriteBlock(share.job, share.laneInJob, share.laneCount);
            }
        }
    }
}

// Writes the family's tables into its tables area once per session: the film grain Gaussian sequence, and the row jumps of grain's
// random generator, which is linear over GF(2): column c of a row's matrix is the register row * width steps after the register 1 << c
fn transformLoadTables(workgroupIndex: u32, lane: u32) {
    let invocation = workgroupIndex * TRANSFORM_LANES + lane;
    let tables = getTablesOffset() + TRANSFORM_TABLES_OFFSET;
    if (invocation < GRAIN_GAUSSIAN_WORDS) {
        frameData[tables + GRAIN_GAUSSIAN_TABLE + invocation] = GRAIN_GAUSSIAN_PACKED[invocation];
        return;
    }
    let jumpColumn = invocation - GRAIN_GAUSSIAN_WORDS;
    if (jumpColumn >= GRAIN_ROW_JUMP_WORDS) {
        return;
    }
    let matrix = jumpColumn / GRAIN_REGISTER_BITS;
    let row = matrix % GRAIN_TEMPLATE_MAXIMUM_ROWS;
    let columns = select(GRAIN_TEMPLATE_NARROW_COLUMNS, GRAIN_TEMPLATE_WIDE_COLUMNS, matrix < GRAIN_TEMPLATE_MAXIMUM_ROWS);
    var randomRegister = 1u << (jumpColumn % GRAIN_REGISTER_BITS);
    for (var step = 0u; step < row * columns; step += 1u) {
        grainNextRandom(&randomRegister, GRAIN_REGISTER_BITS);
    }
    frameData[tables + GRAIN_ROW_JUMP_TABLE + jumpColumn] = randomRegister;
}

// Film grain synthesis (libaom's add_film_grain_run, av1/decoder/grain_synthesis.c) in the specification's per-sample form:
// grainGenerate writes the frame's grain templates, scaling tables, and per-32x32 random offsets into the film grain area, and
// outputWriteRow adds each sample's noise, blending templates across 32x32 block and stripe edges as libaom's line and column
// buffers do. libaom pads odd frames to even sizes by repeating the last column and row, which only the chroma luma average sees.

// grain_synthesis.c: gauss_bits, the register's width, the offsets' random bits, the 32x32 luma blocks (luma_subblock_size), and
// the template padding (left_pad, top_pad, right_pad, and ar_padding are 3, bottom_pad 0)
const GRAIN_GAUSS_BITS: u32 = 11u;
const GRAIN_REGISTER_BITS: u32 = 16u;
const GRAIN_REGISTER_MASK: u32 = 65535u;
const GRAIN_FEEDBACK_TAP_1: u32 = 1u;
const GRAIN_FEEDBACK_TAP_3: u32 = 3u;
const GRAIN_FEEDBACK_TAP_12: u32 = 12u;
const GRAIN_OFFSET_RANDOM_BITS: u32 = 8u;
const GRAIN_OFFSET_FIELD_BITS: u32 = 4u;
const GRAIN_OFFSET_FIELD_MASK: u32 = 15u;
const GRAIN_BLOCK_LOG2: u32 = 5u;
const GRAIN_PADDING: u32 = 3u;
// Two 32x32 blocks of grain fit each template between its paddings
const GRAIN_TEMPLATE_CORE: u32 = 64u;
// The Gaussian sequence's 12 bits, which gauss_sec_shift brings to the bit depth
const GRAIN_GAUSSIAN_BITS: u32 = 12u;
// init_random_generator's mixing of a 32-row luma line into the seed, and the lines Cb's and Cr's templates start from
const GRAIN_LINE_MULTIPLIER_HIGH: u32 = 37u;
const GRAIN_LINE_ADDEND_HIGH: u32 = 178u;
const GRAIN_LINE_MULTIPLIER_LOW: u32 = 173u;
const GRAIN_LINE_ADDEND_LOW: u32 = 105u;
const GRAIN_CB_LINE: u32 = 7u;
const GRAIN_CR_LINE: u32 = 11u;
// ver_boundary_overlap and hor_boundary_overlap: (27, 17) and (17, 27) across two samples, (23, 22) across one, rounded by 5 bits
const GRAIN_BLEND_OUTER: i32 = 27;
const GRAIN_BLEND_INNER: i32 = 17;
const GRAIN_BLEND_NARROW_PREVIOUS: i32 = 23;
const GRAIN_BLEND_NARROW_CURRENT: i32 = 22;
const GRAIN_BLEND_SHIFT: u32 = 5u;
const GRAIN_BLEND_ROUNDING: i32 = 16;
// min_luma_legal_range, max_luma_legal_range, and max_chroma_legal_range at 8 bits
const GRAIN_LEGAL_LOW: i32 = 16;
const GRAIN_LEGAL_LUMA_HIGH: i32 = 235;
const GRAIN_LEGAL_CHROMA_HIGH: i32 = 240;
// The chroma scaling index mixes luma and chroma at a fixed scale of 64; the multipliers and the offset are biased by 128 and 256 << (bd - 8)
const GRAIN_COMBINATION_SHIFT: u32 = 6u;
const GRAIN_MULTIPLIER_BIAS: i32 = 128;
const GRAIN_CHROMA_FROM_LUMA_MULTIPLIER: i32 = 64;
// The grain's range at the session's bit depth
const GRAIN_MINIMUM: i32 = -(1 << (OUTPUT_BIT_DEPTH - 1u));
const GRAIN_MAXIMUM: i32 = (1 << (OUTPUT_BIT_DEPTH - 1u)) - 1;
const GRAIN_EIGHT_BIT_DEPTH: u32 = 8u;
// init_scaling_function's 16-bit fixed point, over 256 entries of 8-bit positions
const GRAIN_SCALING_ONE: i32 = 65536;
const GRAIN_SCALING_ROUNDING: i32 = 32768;
const GRAIN_SCALING_FRACTION_BITS: u32 = 16u;
const GRAIN_SCALING_BASE_ENTRIES: u32 = 256u;
const GRAIN_SCALING_BASE_LOG2: u32 = 8u;
const GRAIN_SCALING_LAST_ENTRY: u32 = 255u;
// The auto-regressive filter's window, lag 3's support: three rows above by seven columns, then three samples to the left; then the
// chroma planes' luma weight
const GRAIN_WINDOW_LAG: u32 = 3u;
const GRAIN_WINDOW_COLUMNS: u32 = 7u;
const GRAIN_WINDOW_ABOVE: u32 = 21u;
const GRAIN_WINDOW_NEIGHBORS: u32 = 24u;
const GRAIN_WEIGHT_COUNT: u32 = 25u;
// Widths of the record's film grain fields that av1.wgsl declares as shifts
const GRAIN_FLAG_BITS: u32 = 1u;
const GRAIN_POINT_COUNT_BITS: u32 = 4u;
const GRAIN_SCALING_SHIFT_BITS: u32 = 4u;
const GRAIN_AR_LAG_BITS: u32 = 2u;
const GRAIN_AR_SHIFT_BITS: u32 = 4u;
const GRAIN_SCALE_SHIFT_BITS: u32 = 2u;
const GRAIN_MULTIPLIER_BITS: u32 = 8u;
const GRAIN_OFFSET_BITS: u32 = 9u;
const GRAIN_BYTE_BITS: u32 = 8u;
const GRAIN_BYTES_PER_WORD_LOG2: u32 = 2u;
const GRAIN_BYTE_INDEX_MASK: u32 = 3u;
const GRAIN_BYTE_MASK: u32 = 255u;

// The film grain area (frameData from getFilmGrainOffset()), in words: three templates of at most 73 rows of 41 words, each word
// holding a row's column j in its low half and column j + half the row in its high half (so no two lanes of the AR filter's
// wavefront ever touch one word in a step); three scaling tables of 4096 byte entries; and each 32x32 luma block's random offsets
// as one byte, stripe after stripe in whole words
const GRAIN_TEMPLATE_WORDS: u32 = 2993u;
const GRAIN_LUMA_TEMPLATE: u32 = 0u;
const GRAIN_SCALING_TABLES: u32 = 8979u;
const GRAIN_SCALING_TABLE_WORDS: u32 = 1024u;
const GRAIN_BLOCK_OFFSETS: u32 = 12051u;
const GRAIN_BLOCK_OFFSETS_WORDS: u32 = 4096u;
// The transform family's tables area: the Gaussian sequence, two entries per word, then the random generator's row jumps: for each
// template width (82 and 44 columns) and row, the 16 columns of the matrix that moves a template's start register to the row's start
const GRAIN_GAUSSIAN_TABLE: u32 = 0u;
const GRAIN_GAUSSIAN_WORDS: u32 = 1024u;
const GRAIN_ROW_JUMP_TABLE: u32 = 1024u;
const GRAIN_ROW_JUMP_WORDS: u32 = 2336u;
const GRAIN_TEMPLATE_MAXIMUM_ROWS: u32 = 73u;
const GRAIN_TEMPLATE_WIDE_COLUMNS: u32 = 82u;
const GRAIN_TEMPLATE_NARROW_COLUMNS: u32 = 44u;
// grainGenerate's workgroup memory: one template, or two chroma templates and their luma averages; and two planes' window weights.
// While the scaling tables build, it holds the three planes' base entries and then a copy of the record's three points fields
const GRAIN_SCRATCH_WORDS: u32 = 2993u;
const GRAIN_PASS_WEIGHTS: u32 = 50u;
const GRAIN_SCALING_POINTS: u32 = RECORD_PLANES * GRAIN_SCALING_BASE_ENTRIES;
const GRAIN_SCALING_POINTS_WORDS: u32 = RECORD_FILM_GRAIN_AR_Y - RECORD_FILM_GRAIN_POINTS_Y;
// The luma average words a lane places at most: 4:2:2's 70 rows by 38 columns, two per word, over 64 lanes
const GRAIN_AVERAGE_SLOTS: u32 = 21u;
// A random register's four steps at a time, the steps as shifts and each step's member of a group
const GRAIN_GROUP_STEPS: u32 = 4u;
const GRAIN_GROUP_SHIFTS = vec4u(1u, 2u, 3u, 4u);
const GRAIN_GROUP_MEMBERS = vec4u(0u, 1u, 2u, 3u);

// libaom's gaussian_sequence (av1/decoder/grain_synthesis.c): 2048 samples of a zero-mean Gaussian in 12 bits, as the GPU table
// holds them: word j has entry 2j in its low half and entry 2j + 1 in its high half, each 16-bit two's complement (written by
// scratch/av1/gpu-transform/tools/generate_gaussian_wgsl.py; packed, the literal compiles in about half the time)
const GRAIN_GAUSSIAN_PACKED = array<u32, 1024>(
    0x02380038u, 0x00ACFF4Cu, 0xFFAC007Cu, 0xFFC000ACu, 0x0018FC7Cu, 0x00E00334u, 0x03E404E0u, 0xFFF80110u,
    0xFE7CFC6Cu, 0xFF98FD24u, 0x0320FF44u, 0xFD740070u, 0xFE88FEC0u, 0xFF04008Cu, 0xFF5801ECu, 0xFCEC002Cu,
    0xFDB8024Cu, 0xFF1C01F4u, 0x02A8000Cu, 0xFE240110u, 0xFF9C03CCu, 0x0170028Cu, 0xFF3C01B0u, 0xFF40FD30u,
    0xFEB403E8u, 0xFF78028Cu, 0xFDA4FDD8u, 0x00C0FFFCu, 0xFF78FF24u, 0xFFCC03E8u, 0xFFA00174u, 0x007CFD90u,
    0x018CFFE8u, 0xFFF4021Cu, 0x0280FF98u, 0x00F401D0u, 0xFFACFF30u, 0xFDF00170u, 0x00F8FD1Cu, 0xFCB0FC38u,
    0x01780260u, 0xFEDCFFC4u, 0xFF64FFD8u, 0xFEDC00FCu, 0x00E000F8u, 0x0190FEE8u, 0x00F4FF0Cu, 0x004CFFC4u,
    0x00D4FFB0u, 0x01540214u, 0xFFDC0080u, 0xFEA00338u, 0xFEF8FFC4u, 0xFD9CFFA0u, 0xFD4001A0u, 0xFF3400DCu,
    0xFF600280u, 0xFE6804C4u, 0x01500384u, 0xFEB00014u, 0xFCE8FFA0u, 0x00300130u, 0xFB30FFE4u, 0xFE40FB6Cu,
    0xFEDC0068u, 0x00F4FDF8u, 0xFC4C003Cu, 0xFD3C0000u, 0x006C010Cu, 0xFDDC0164u, 0xFEA801E8u, 0x01E8FF78u,
    0xFF20FF3Cu, 0xFF140290u, 0x003CFB98u, 0x008C0004u, 0xFD5C0114u, 0x00A8FE88u, 0x01D0FF94u, 0x02340008u,
    0x00F00040u, 0xFED40134u, 0xFE38FE70u, 0x0038FF78u, 0xFE680078u, 0x01B4FF8Cu, 0xFF1801F8u, 0x034C0148u,
    0xFFACFF5Cu, 0xFF580310u, 0xFF2000E8u, 0xFE88015Cu, 0x02380080u, 0xFB240060u, 0x0114FEE0u, 0x03400350u,
    0x0290FE98u, 0xFE8001D0u, 0xFE9CFEB4u, 0xFE7C02D8u, 0xFF4000A0u, 0x012801D4u, 0x008C00E0u, 0xFF9CFCF8u,
    0x00040118u, 0x002C00C4u, 0xFD78FFDCu, 0x001003A4u, 0x001C0594u, 0x03280210u, 0x00140304u, 0x0058010Cu,
    0xFEE4FEB4u, 0xFE80007Cu, 0x00D0FE40u, 0xFBECFF1Cu, 0x0294FEB8u, 0xFF6C017Cu, 0x024CFED4u, 0x021C00F0u,
    0x0088001Cu, 0xFE4CFFA8u, 0x01280100u, 0x0578FC18u, 0xFFD00000u, 0xFF780420u, 0xFDF00108u, 0x0278FBACu,
    0xFDB0FE1Cu, 0x031CFEA8u, 0xFD64007Cu, 0x0184FD00u, 0xFF180510u, 0xFF38FF44u, 0xFFFCFEE0u, 0x00640134u,
    0x0100FF58u, 0x00CCFE0Cu, 0x0288FE04u, 0x0174FF78u, 0xFF88FEF0u, 0xFDD8FC14u, 0xFE80FDDCu, 0xFED80224u,
    0xFF9401ACu, 0xFC70FFF8u, 0xFF20FEBCu, 0xFF90FFA8u, 0xFF9CFF24u, 0xFCE403E4u, 0x01680224u, 0x00B4FF28u,
    0xFF3801ACu, 0x0094FF2Cu, 0x00940060u, 0x00D8011Cu, 0xFEC0FE64u, 0xFED40078u, 0xFDA4FE80u, 0xFEB4FDC4u,
    0xFF4CFFF8u, 0x02B8FF50u, 0xFFA80074u, 0x004C0274u, 0xFDFC002Cu, 0xFF3000F0u, 0x0064FFD8u, 0x0158FDB0u,
    0xFE3CFECCu, 0x0014FF1Cu, 0xF9280394u, 0xFEACFF78u, 0x008CFCDCu, 0x02000028u, 0x00F80154u, 0xFE1400B8u,
    0xFF640380u, 0xFD8C03A4u, 0xFD500148u, 0xFD98FE40u, 0xFF9CFD10u, 0xFC040230u, 0xFCE000B4u, 0x004CFFC0u,
    0x042C0240u, 0x0294018Cu, 0xFF940228u, 0x0140FFE4u, 0x0138FD8Cu, 0xFFA4FFA4u, 0x010CFE28u, 0x02300010u,
    0xFD600204u, 0x01ECFFCCu, 0x0104FF9Cu, 0x011C0180u, 0x01300124u, 0x0058FF6Cu, 0x03F4FF68u, 0xFF1C0428u,
    0xFE8800A4u, 0x0250FD54u, 0x009CFE78u, 0xFDF400C4u, 0xFC8CFFC0u, 0xFF5000A0u, 0x0288027Cu, 0xFE740194u,
    0x0360FE4Cu, 0xFD2801A8u, 0xFDA403DCu, 0xFDB00388u, 0xFF200128u, 0xFF500218u, 0x01B4FC68u, 0x0498FFD0u,
    0x01A0FC8Cu, 0xFCC8FCF8u, 0x020CFC8Cu, 0xFDCCFDDCu, 0xFF5CFFBCu, 0x02B4FFA0u, 0xFD4C016Cu, 0xFFBCFC0Cu,
    0xFE200104u, 0xFBA4036Cu, 0xFEB401C4u, 0x037CFEA0u, 0x04C4FBC0u, 0x000CFD5Cu, 0x00F4FEDCu, 0x017401F0u,
    0x0118FFE0u, 0x007000C8u, 0xFFA0FE48u, 0xFD7C0018u, 0x0038FF48u, 0x00E0FE50u, 0x0110FC2Cu, 0x0090FEFCu,
    0x01A4FE4Cu, 0x016C0164u, 0x004CFDF0u, 0xFD1800ACu, 0x0194FE90u, 0xFE60FD10u, 0xFD5002ACu, 0x021C0048u,
    0x005C01A0u, 0x01E001BCu, 0xFA78FFB8u, 0xFB6C00A4u, 0x0018FFBCu, 0x010801A8u, 0x00800410u, 0xFDF4FC70u,
    0x0040FE9Cu, 0xFFF4036Cu, 0xFFA80004u, 0x01100214u, 0x0140FDF4u, 0xFE040114u, 0x001803ACu, 0xFF88FE70u,
    0x003C02F4u, 0xFE6400ECu, 0x01780064u, 0x0190FE1Cu, 0xFD1CFF9Cu, 0xFEFCFF94u, 0xFEF40148u, 0xFF3800E0u,
    0x00B8FE60u, 0xFDCCFDA4u, 0x0128FFECu, 0x037C003Cu, 0x003CFC88u, 0x004400A4u, 0x00D8FD08u, 0x0388FED8u,
    0xFFE4FEB0u, 0xFE9C0194u, 0xFF30FDC8u, 0xFE00FA38u, 0x01480128u, 0xFF5CFE98u, 0xFCF8F9E8u, 0xFE540484u,
    0xFE0800A4u, 0x0078FF90u, 0xFF6CFF28u, 0x0134FEF8u, 0x00400020u, 0x0048FFB8u, 0x00B00074u, 0xFEF0FFC0u,
    0xFDE801CCu, 0xFEE8FCF0u, 0x006C015Cu, 0xFF7CFD10u, 0xFDE4020Cu, 0x0074FCF8u, 0xFB54FED8u, 0xFDD0FEE0u,
    0xFE280410u, 0xFCB00074u, 0x0074FBA4u, 0x02B8027Cu, 0xFF50011Cu, 0x00CC03F8u, 0xFD78FCA0u, 0x0164FF08u,
    0xFDB803CCu, 0x0108FF34u, 0x02100370u, 0xFF48FFE8u, 0x01C00074u, 0x033CFF70u, 0x00D4020Cu, 0x0034FF2Cu,
    0x00C8000Cu, 0xFE18010Cu, 0xFC90FE6Cu, 0xFD600338u, 0x038CFFD8u, 0x01F4FF08u, 0xFDC002CCu, 0xFDC001ECu,
    0x02D00010u, 0x0180FF94u, 0x0158007Cu, 0x02400118u, 0x00FCFE0Cu, 0xFECC0068u, 0xFF4400C4u, 0x04F4FFF8u,
    0x04080128u, 0x01B4FB54u, 0x0174013Cu, 0xFF38FE50u, 0x02C0FD6Cu, 0x0254FF20u, 0x010CFF7Cu, 0xFE3C0020u,
    0x00680374u, 0x01A8FC10u, 0xFEE8FABCu, 0xFB700004u, 0x01DC0170u, 0x012C02B8u, 0x0018FFF8u, 0xFDB000B4u,
    0x0184FF3Cu, 0x01F40130u, 0xFF6002D4u, 0xFFAC00F4u, 0xFF000110u, 0x0140FE5Cu, 0xFF7000D0u, 0x009CFF64u,
    0x01C4016Cu, 0x021C001Cu, 0x00DC013Cu, 0xFF08FD7Cu, 0x004801D0u, 0x00200168u, 0x01F0FE7Cu, 0xFFD0FD58u,
    0xFF8C00D0u, 0x003CFE68u, 0xFE78FDA4u, 0xFCB80224u, 0xFE340310u, 0xFDE00290u, 0xFEF8FE7Cu, 0xFCE0038Cu,
    0xFD9CFD8Cu, 0x023CFDC8u, 0x00A4FF24u, 0xFFF00120u, 0x0134FECCu, 0xFD84FF90u, 0x0118FD08u, 0x01B0FD64u,
    0x00F0016Cu, 0x025CFF3Cu, 0x01800154u, 0x025000C4u, 0xFE0CFFD4u, 0xFDBC01B0u, 0x027CFF7Cu, 0x0188FFB4u,
    0xFE640004u, 0x01FC021Cu, 0xFE9C0148u, 0x0010FFDCu, 0xFFC0FF24u, 0xFFC4FF08u, 0xFF400018u, 0x04100170u,
    0xFFE8005Cu, 0xFFE0FBECu, 0x00680028u, 0x00C00094u, 0xFDF8FF78u, 0xFCD00038u, 0x02DCFF20u, 0x01640188u,
    0xFFB000D4u, 0xFC10FE58u, 0x024CFEBCu, 0x0240FA28u, 0xFCD001CCu, 0x0038FCB0u, 0xFFA4FDBCu, 0xFF90FAA4u,
    0x00C8FE10u, 0x0034016Cu, 0x0030FF74u, 0xFFC4FFD0u, 0x00480054u, 0x00840028u, 0xFEF4FE9Cu, 0xFEE4FF98u,
    0x02DCFE6Cu, 0x00A4FDF8u, 0xFDE4FED0u, 0x01480078u, 0xFE34FFB4u, 0x018402F4u, 0x00EC024Cu, 0xFFB8FE4Cu,
    0xFE6CFF50u, 0xFF6CFEC4u, 0xFDA402CCu, 0xFFB80194u, 0xFC88FFA8u, 0x03B0FFBCu, 0xFF240058u, 0x03C0FEA8u,
    0x01CC01D8u, 0x02C0FF18u, 0x03400078u, 0x02B4FF1Cu, 0x0084FE04u, 0x034CFE24u, 0xFE94FD14u, 0x045CFFD4u,
    0xFBE0FBB0u, 0x01AC004Cu, 0xFD4C0228u, 0x0164003Cu, 0xFE800060u, 0xFD9CFF44u, 0x02E0FDC0u, 0x037C01FCu,
    0xFB940160u, 0xFFE801F8u, 0x0144FEA0u, 0xFDA8014Cu, 0x0124FEC8u, 0xFF7001FCu, 0x01E4FFF8u, 0x011C0030u,
    0xFF10FEFCu, 0xFF9C0100u, 0xFF34FEDCu, 0x01D8FFD4u, 0x038CFF34u, 0xFC18FF44u, 0x005CFF00u, 0xFE78048Cu,
    0x01640234u, 0xFFE4028Cu, 0x0100FC8Cu, 0xFF4001E4u, 0xFF5002F8u, 0xFDF40178u, 0xFE4CFE3Cu, 0xFD20035Cu,
    0x007C00D4u, 0xFE2401F8u, 0x004C01D4u, 0x0228FE28u, 0xFC50FD4Cu, 0x02E4FD94u, 0x0190FF10u, 0x00140084u,
    0xFF3C00C0u, 0xFD640108u, 0xFFC4FC0Cu, 0xFEC40128u, 0x004CFCC4u, 0x011CFF64u, 0xFE40FD00u, 0x0094FCC0u,
    0x028C00F8u, 0x04D40268u, 0xFEB80120u, 0xFF84FE70u, 0x00DC024Cu, 0xFD480208u, 0x03000408u, 0xFFA4FD1Cu,
    0x0128FEF0u, 0xFE3001C0u, 0xFF38019Cu, 0x01B80188u, 0x0108FF38u, 0xFEFCFF68u, 0x04080140u, 0x014000D8u,
    0xFFC0FFF8u, 0xFC08009Cu, 0x0494043Cu, 0x01E40218u, 0x0084FE50u, 0xFFCC0174u, 0x0054FF00u, 0xFEA00074u,
    0x00740030u, 0xFE800130u, 0x039C019Cu, 0x0210FED4u, 0x00B40274u, 0x002C0288u, 0xFF24FC2Cu, 0x00300528u,
    0x02EC014Cu, 0xFEF4020Cu, 0x021CFD30u, 0x0234FEECu, 0xFF30FEA8u, 0x01B4FF3Cu, 0x00580380u, 0x0084FE78u,
    0xFC3C0050u, 0x0238FEE0u, 0xFFD00038u, 0x0378FE38u, 0x02280008u, 0xFEDCFF64u, 0x012003B4u, 0xFD340080u,
    0x04A8FEDCu, 0x036CFF68u, 0xFDA80160u, 0xFCD4FEFCu, 0xFFE4FE2Cu, 0xFFE0FF88u, 0x0504FFD4u, 0x00C001F0u,
    0x013801D0u, 0xFDFCFFB4u, 0xFE38FE84u, 0xFFD0FC0Cu, 0xFF640134u, 0x01EC0024u, 0xFCD8FF64u, 0x067400BCu,
    0xFF880044u, 0x013CFF8Cu, 0xFF7400A0u, 0x03280160u, 0x0250FE60u, 0xFE20013Cu, 0x02100038u, 0xFDC8FF34u,
    0xFF180174u, 0xFEA802F0u, 0xFFFC02E8u, 0xFE600144u, 0x0300FDA8u, 0xFF08010Cu, 0xFF7CFFA8u, 0xFE50FE5Cu,
    0xFEE00050u, 0xFEC40194u, 0xFDB4FB40u, 0xFF940208u, 0xFEC0005Cu, 0xFE200170u, 0xFFA4FF28u, 0xFED40698u,
    0x03FC00B4u, 0x0334FF50u, 0xFF1CFFBCu, 0x01B4FEFCu, 0x0014FC78u, 0xFE040028u, 0xFD2001B8u, 0x014C0138u,
    0x02F800CCu, 0x02D8FE8Cu, 0xFFEC0060u, 0xFDF8FD88u, 0x0150FDD0u, 0xFFC00434u, 0x0308FDECu, 0x00C00248u,
    0xFD28018Cu, 0x0114FDF8u, 0x0050FF44u, 0xFD9CFFCCu, 0xFFD0FF04u, 0x00D40288u, 0x00E4FD50u, 0xFEFCFFCCu,
    0xFE6401ACu, 0xFE6CFEF0u, 0x033000B4u, 0x0030FCE4u, 0x01E40098u, 0xFF28FFA8u, 0x02B803DCu, 0xFDF000BCu,
    0xFF8C0288u, 0x013CFF4Cu, 0x000C01DCu, 0x0060FDCCu, 0xFF0401DCu, 0xFE88FE94u, 0x022CFE78u, 0xFDC0FF00u,
    0xFEA00104u, 0xFFF00078u, 0xFEFCFF78u, 0x0048FE14u, 0x0294022Cu, 0x02680244u, 0x01B40304u, 0xFFE001A8u,
    0xFB0CFEBCu, 0xFEBC01A0u, 0x0398FFB0u, 0x00E400A0u, 0x002002D4u, 0x0040FDFCu, 0x00440180u, 0x0088FF80u,
    0x00F800F0u, 0xFFBCFF34u, 0xFC5C00FCu, 0xFE20FF88u, 0xFFACFD8Cu, 0x035400C0u, 0xFEE0FE6Cu, 0x00CCFF7Cu,
    0x00A80064u, 0xFF3CFFBCu, 0x01CCFC9Cu, 0x017C0438u, 0x00F4FFB0u, 0x01E40000u, 0x0040FC88u, 0x016000B8u,
    0x01CC0258u, 0x025C00A4u, 0x0140FF3Cu, 0x024CFFC0u, 0x00E4FF48u, 0x0174000Cu, 0xFCB00030u, 0x00E0FEA8u,
    0xFF3800D0u, 0x008001E4u, 0x0110FFECu, 0xFCB8FE2Cu, 0x01000180u, 0xFDF8FD30u, 0xFDBCFE30u, 0xFF880070u,
    0xFE9C0284u, 0xFDA0FF30u, 0x02C0FDF0u, 0xFE580230u, 0x033C0188u, 0x00540028u, 0xFF6800C8u, 0xFF700000u,
    0x01180248u, 0x0050FF88u, 0xFC34FDD4u, 0xFE28FF3Cu, 0x005002D4u, 0xFFE000A8u, 0x00A00058u, 0x0000FD50u,
    0x016400A0u, 0xFCF80174u, 0xFF8002E4u, 0xFF0802A4u, 0x0004FE20u, 0x0060FE94u, 0x00E80220u, 0x03BCFBF8u,
    0x016400ECu, 0xFFD80014u, 0x0018012Cu, 0xFDACFD5Cu, 0x04600084u, 0x0214FF98u, 0x0238FBB8u, 0x01BC0288u,
    0x017C01FCu, 0xFE8800BCu, 0x05D0FDA4u, 0x001801A8u, 0xFF2402F4u, 0x02CCFF40u, 0x03980078u, 0x00A802B0u,
    0xFE34002Cu, 0x011C0238u, 0x04880478u, 0x01A80258u, 0x02900378u, 0xFEC0FE9Cu, 0x013C00DCu, 0xFD2CFF50u,
    0xFCD0FF44u, 0xFEA4FD8Cu, 0xFE84FF1Cu, 0xFE3C03F4u, 0x02E0FD6Cu, 0x019403A0u, 0xFFB8FD48u, 0xFC84FEF4u,
    0x00B80080u, 0xFCF4FEA8u, 0x01500168u, 0x01580190u, 0x022401ACu, 0x0088FF90u, 0xFF28FF1Cu, 0xFDFCFCCCu,
    0x005C0154u, 0x0074FF78u, 0x0178FED4u, 0x0064FF0Cu, 0xFDF8FEC4u, 0xFFF4FEE4u, 0x00A40338u, 0xFF4CFDDCu,
    0x0074FF80u, 0xFCC4FC64u, 0xFE90010Cu, 0x026CFDBCu, 0x00A000C0u, 0xF9740000u, 0x01A8042Cu, 0xFE98FFC8u,
    0xFF6401D4u, 0x012002D0u, 0x022CFDF0u, 0x0224FE94u, 0x01F8FF6Cu, 0x0098013Cu, 0xFD94FD78u, 0xFFE8FD54u,
    0xFE80FE88u, 0xFC68FF94u, 0x0300FBF8u, 0xFEF800B4u, 0xFB0CFE04u, 0xFFC4FEFCu, 0xFF10012Cu, 0x02D403DCu,
    0xFDC0FE88u, 0xFD20FF2Cu, 0x00C0022Cu, 0xFD940444u, 0x0178FC90u, 0xFFFCFFC8u, 0xFFE0FF28u, 0x010C0344u,
    0x0534018Cu, 0xFDA80360u, 0x00380064u, 0xFFA4FE64u, 0x00B40164u, 0xFE2C0374u, 0x0124FE4Cu, 0xFCDCFE7Cu,
    0xFCB8FD40u, 0xFEA40170u, 0xFD2C008Cu, 0x03AC0600u, 0x00700174u, 0x01B4FE8Cu, 0x0470FE20u, 0xFFE00128u,
    0x0084FF1Cu, 0xFF24FFD0u, 0xFC080364u, 0xFBECFFC4u, 0x0148FE30u, 0x00F40394u, 0xFD20000Cu, 0x0168FED8u,
    0xFE8801D4u, 0xFFA4FF94u, 0x01700314u, 0x0220FFC8u, 0xFD600190u, 0x02D8FE5Cu, 0x01400010u, 0xFEE4002Cu,
    0xFCE4FE84u, 0x008401E8u, 0xFDAC00CCu, 0x0058FE8Cu, 0xFC74FF68u, 0xFDC4FD84u, 0xFF8CFD90u, 0xFF38FD4Cu,
    0x0114FFC8u, 0x01E4FFA8u, 0x03B4FEBCu, 0x03E80360u, 0xFF48FE38u, 0x0124FEECu, 0x009CFED8u, 0x014002A4u,
    0x038C00A0u, 0xFB2CFFACu, 0xFF8CFEE0u, 0xFE8C0104u, 0x02DCFD7Cu, 0xFFA0FD0Cu, 0x01580054u, 0x015CFDF8u,
    0x00F0FD50u, 0x00D8FFACu, 0xFF78FBECu, 0xFE74FD5Cu, 0x03C0FA24u, 0x00B0FFD8u, 0x05EC00A8u, 0xFE0801A4u,
    0xFE94FEA8u, 0x04C0FE98u, 0xFE84FC54u, 0x00FCFF2Cu, 0xFD3CFD6Cu, 0xFE4401E4u, 0x03A0FF68u, 0x0458FF88u,
    0xFEFC01DCu, 0xFF6C0230u, 0x006CFEA8u, 0x00E4FF3Cu, 0x01F8FEE0u, 0xFEB80230u, 0x0120FFA8u, 0x01CCFC10u,
    0x01D4FF1Cu, 0xFF3CFCBCu, 0x0184004Cu, 0x019C00E8u, 0xFD34FB70u, 0x02F4FD7Cu, 0xFE9CFF54u, 0x0074FE08u,
    0x021001B0u, 0x01DC0030u, 0xFDA0FF58u, 0x00A001C0u, 0xFEF0FDECu, 0xFD5C001Cu, 0x033CFFF4u, 0x01C803D4u,
    0x00680208u, 0x0100FF98u, 0xFFFCFEA8u, 0xFE90FFE4u, 0xFDF4FFCCu, 0xFDD4FDC4u, 0x0300FF38u, 0xFF300464u,
    0x00B0FE00u, 0x00F800E8u, 0xFC88FF6Cu, 0xFDA8025Cu, 0x0324FED0u, 0xFF2CFF64u, 0xFF4001E8u, 0xFF00FCDCu,
    0xFE980170u, 0xFEB8FC6Cu, 0xFF1000E4u, 0xFE28FE40u, 0xFDD40358u, 0x023CFE94u, 0xFF64FFF4u, 0xFEACFE90u,
    0x00FC01B0u, 0xFF68FD10u, 0x010C0120u, 0xFCB0FDBCu, 0x006CFDB0u, 0x00F4FFB4u, 0xFD340138u, 0xFFB00250u,
    0x016801B4u, 0xFF080004u, 0x020400A0u, 0x02DC0248u, 0xFE2C002Cu, 0xFEDCFEE8u, 0xFDB4FF64u, 0x0134001Cu,
    0x00180390u, 0x009C007Cu, 0xFF0400B4u, 0xFC6403B0u, 0xFDF8FCFCu, 0xFD90FE54u, 0xFF2C012Cu, 0x0020FB88u,
    0x0320FD2Cu, 0xFF2CFB98u, 0xFCB0FAF8u, 0xFE6000B4u, 0x00C001B8u, 0xFCE8FDC0u, 0xFBC8FFB4u, 0xFDEC0050u,
    0xFF7CFEA0u, 0xFCCC017Cu, 0x04580094u, 0x00A40080u, 0x02BC01C8u, 0x0090FC64u, 0xFE80FD64u, 0xFCC00288u,
    0x022801FCu, 0xFF9CFFCCu, 0x00D0FD70u, 0x02ECFDC8u, 0x02A8FFA8u, 0x012C00E8u, 0xFE6800C0u, 0xFF68FC0Cu,
    0xFEF4FF04u, 0xFC940110u, 0xFD78FD68u, 0xFF78FEB4u, 0x000C0010u, 0xFFE40480u, 0xFDE8014Cu, 0xFD600140u,
    0xFEC4FE34u, 0xFEFC0214u, 0xFFD800E4u, 0xFCD0041Cu, 0x005800B4u, 0xFDD4FE10u, 0xFE90FD60u, 0x005C01ACu,
    0x01940164u, 0x00FCFE68u, 0xFF5000C4u, 0x0318FDD4u, 0x0020010Cu, 0x00280174u, 0xFEB40060u, 0x00780148u,
    0xFC7C0174u, 0x01D8FFD8u, 0xFDB0FEF8u, 0x008003B8u, 0x00700290u, 0xFF180298u, 0x000401A4u, 0xFE30FEA8u,
    0x00F4022Cu, 0xFFE0FE60u, 0x000000FCu, 0x00BCFE64u, 0x01FCFD48u, 0x0144FE24u, 0x0290FBB8u, 0x0230FEC8u,
    0xFF780108u, 0x00A00130u, 0xFDBCFFC0u, 0x015000F8u, 0x0230FD30u, 0xFEE0FEA4u, 0xFF3CFEECu, 0x0354FE0Cu,
    0xFF14FDE0u, 0xFC20FB98u, 0x0074FCF8u, 0x00340038u, 0x0374035Cu, 0xFFF400D4u, 0x03FC00A8u, 0xFDD80200u,
    0xFF6C039Cu, 0x00BC02CCu, 0xFEAC00A4u, 0xFF48FDF8u, 0xFF680370u, 0xFF30FD58u, 0xFED4FB7Cu, 0xFE28FDF0u,
    0x0064016Cu, 0xFBE0FD18u, 0x021CFFE0u, 0x00900118u, 0xFFE0FD5Cu, 0xFEE8FF18u, 0x0060FF20u, 0xFFB40238u,
    0x009400ACu, 0x00680094u, 0xFED80020u, 0x0314FFE0u, 0x0020FFB0u, 0x0118FFF0u, 0x03B00120u, 0xFE1C01ACu
);

var<workgroup> grainScratch: array<u32, GRAIN_SCRATCH_WORDS>;
var<workgroup> grainGaussianTable: array<u32, GRAIN_GAUSSIAN_WORDS>;
var<workgroup> grainWeights: array<i32, GRAIN_PASS_WEIGHTS>;
var<workgroup> grainRunning: u32;

// A word of the record's film grain block
fn grainReadWord(field: u32) -> u32 {
    return readRecordWord(RECORD_HEADER_FILM_GRAIN + field);
}

// A field of the film grain control word
fn grainReadControl(shift: u32, bitCount: u32) -> u32 {
    return getField(grainReadWord(RECORD_FILM_GRAIN_CONTROL), shift, bitCount);
}

// A byte of a run of the film grain block, four per word
fn grainReadByte(firstField: u32, index: u32) -> u32 {
    let word = grainReadWord(firstField + (index >> GRAIN_BYTES_PER_WORD_LOG2));
    return getField(word, (index & GRAIN_BYTE_INDEX_MASK) * GRAIN_BYTE_BITS, GRAIN_BYTE_BITS);
}

// Whether chroma scales from luma (chroma_scaling_from_luma)
fn grainChromaFromLuma() -> bool {
    return grainReadControl(RECORD_FILM_GRAIN_CHROMA_FROM_LUMA_SHIFT, GRAIN_FLAG_BITS) == 1u;
}

// A plane's own scaling point count (num_y_points, num_cb_points, num_cr_points)
fn grainOwnPointCount(plane: u32) -> u32 {
    switch (plane) {
        case PLANE_Y: { return grainReadControl(RECORD_FILM_GRAIN_POINTS_Y_COUNT_SHIFT, GRAIN_POINT_COUNT_BITS); }
        case PLANE_U: { return grainReadControl(RECORD_FILM_GRAIN_POINTS_CB_COUNT_SHIFT, GRAIN_POINT_COUNT_BITS); }
        default: { return grainReadControl(RECORD_FILM_GRAIN_POINTS_CR_COUNT_SHIFT, GRAIN_POINT_COUNT_BITS); }
    }
}

// Whether a plane receives grain: luma with scaling points, chroma with its own points or scaling from luma (apply_y, apply_cb, apply_cr)
fn grainPlaneApplies(plane: u32) -> bool {
    if (plane == PLANE_Y) {
        return grainOwnPointCount(PLANE_Y) > 0u;
    }
    return grainOwnPointCount(plane) > 0u || grainChromaFromLuma();
}

// The scaling points a plane's scaling function interpolates: luma's, which chroma scaling from luma copies, or the plane's own
fn grainScalingPlane(plane: u32) -> u32 {
    return select(plane, PLANE_Y, grainChromaFromLuma());
}

fn grainPointsField(plane: u32) -> u32 {
    switch (plane) {
        case PLANE_Y: { return RECORD_FILM_GRAIN_POINTS_Y; }
        case PLANE_U: { return RECORD_FILM_GRAIN_POINTS_CB; }
        default: { return RECORD_FILM_GRAIN_POINTS_CR; }
    }
}

// Whether the record shows a frame with film grain
fn grainFrameApplies() -> bool {
    return state[STATE_FRAME_VALID] == 1u && hasRecordFlag(RECORD_FLAG_SHOW_FRAME) && hasRecordFlag(RECORD_FLAG_FILM_GRAIN)
        && grainReadControl(RECORD_FILM_GRAIN_APPLY_SHIFT, GRAIN_FLAG_BITS) == 1u;
}

// The film grain's random seed
fn grainSeed() -> u32 {
    return grainReadWord(RECORD_FILM_GRAIN_SEED) & GRAIN_REGISTER_MASK;
}

// libaom's get_random_number: steps the 16-bit linear feedback register and returns its top bitCount bits
fn grainNextRandom(randomRegister: ptr<function, u32>, bitCount: u32) -> u32 {
    let current = *randomRegister;
    let feedback = (current ^ (current >> GRAIN_FEEDBACK_TAP_1) ^ (current >> GRAIN_FEEDBACK_TAP_3) ^ (current >> GRAIN_FEEDBACK_TAP_12)) & 1u;
    let next = (current >> 1u) | (feedback << (GRAIN_REGISTER_BITS - 1u));
    *randomRegister = next;
    return (next >> (GRAIN_REGISTER_BITS - bitCount)) & ((1u << bitCount) - 1u);
}

// The register after each of four get_random_number steps at once. The taps of the first four steps read only the register's own
// bits, so their feedback bits are bits 0 to 3 of r ^ r >> 1 ^ r >> 3 ^ r >> 12, and the register after step k is r >> k with the
// first k of them shifted in at the top; the last member starts the next group
fn grainNextRandomFour(randomRegister: u32) -> vec4u {
    let feedback = randomRegister ^ (randomRegister >> GRAIN_FEEDBACK_TAP_1) ^ (randomRegister >> GRAIN_FEEDBACK_TAP_3)
        ^ (randomRegister >> GRAIN_FEEDBACK_TAP_12);
    let feedbackBits = vec4u(feedback) & ((vec4u(1u) << GRAIN_GROUP_SHIFTS) - vec4u(1u));
    return (vec4u(randomRegister) >> GRAIN_GROUP_SHIFTS) | (feedbackBits << (vec4u(GRAIN_REGISTER_BITS) - GRAIN_GROUP_SHIFTS));
}

// libaom's init_random_generator: the seed mixed with a 32-row luma line's number
fn grainSeedLine(seed: u32, lineNumber: u32) -> u32 {
    let high = ((lineNumber * GRAIN_LINE_MULTIPLIER_HIGH + GRAIN_LINE_ADDEND_HIGH) & 255u) << GRAIN_BYTE_BITS;
    let low = (lineNumber * GRAIN_LINE_MULTIPLIER_LOW + GRAIN_LINE_ADDEND_LOW) & 255u;
    return seed ^ high ^ low;
}

// The register at a template row's first sample: the row jump matrix of the template's width applied to the start register, the XOR
// of the matrix columns the start's set bits pick
fn grainRowStart(start: u32, row: u32, columns: u32) -> u32 {
    let widthIndex = select(1u, 0u, columns == GRAIN_TEMPLATE_WIDE_COLUMNS);
    let matrix = getTablesOffset() + TRANSFORM_TABLES_OFFSET + GRAIN_ROW_JUMP_TABLE
        + (widthIndex * GRAIN_TEMPLATE_MAXIMUM_ROWS + row) * GRAIN_REGISTER_BITS;
    var randomRegister = 0u;
    for (var bit = 0u; bit < GRAIN_REGISTER_BITS; bit += 1u) {
        randomRegister ^= select(0u, frameData[matrix + bit], ((start >> bit) & 1u) == 1u);
    }
    return randomRegister;
}

// The register a plane's template generator starts from: the seed for luma, the seed mixed with lines 7 and 11 for Cb and Cr
fn grainTemplateStart(plane: u32) -> u32 {
    let seed = grainSeed();
    if (plane == PLANE_Y) {
        return seed;
    }
    return grainSeedLine(seed, select(GRAIN_CR_LINE, GRAIN_CB_LINE, plane == PLANE_U));
}

// An entry of the Gaussian sequence, from the copy grainGenerate keeps in workgroup memory
fn grainGaussian(index: u32) -> i32 {
    let word = grainGaussianTable[index >> 1u];
    return bitcast<i32>(word << ((1u - (index & 1u)) * TRANSFORM_HALF_BITS)) >> TRANSFORM_HALF_BITS;
}

// A template's rows and columns (luma_block_size and chroma_block_size in add_film_grain_run)
fn grainTemplateRows(subsamplingY: u32) -> u32 {
    return GRAIN_PADDING + (2u >> subsamplingY) * GRAIN_PADDING + (GRAIN_TEMPLATE_CORE >> subsamplingY);
}

fn grainTemplateColumns(subsamplingX: u32) -> u32 {
    return 2u * GRAIN_PADDING + 2u * (2u >> subsamplingX) * GRAIN_PADDING + (GRAIN_TEMPLATE_CORE >> subsamplingX);
}

// A block's first template row or column for its random offset (luma_offset and chroma_offset in add_film_grain_run)
fn grainBlockOrigin(offset: u32, subsampling: u32) -> u32 {
    return GRAIN_PADDING + (2u >> subsampling) * (GRAIN_PADDING + offset);
}

// A plane's subsampling
fn grainSubsamplingX(plane: u32) -> u32 {
    return select(readRecordWord(RECORD_HEADER_SUBSAMPLING_X), 0u, plane == PLANE_Y);
}

fn grainSubsamplingY(plane: u32) -> u32 {
    return select(readRecordWord(RECORD_HEADER_SUBSAMPLING_Y), 0u, plane == PLANE_Y);
}

// The frame's 32-row stripes and 32-column blocks, over its size rounded up to even
fn grainStripeCount() -> u32 {
    let paddedHeight = (readRecordWord(RECORD_HEADER_FRAME_HEIGHT) + 1u) & ~1u;
    return (paddedHeight + (1u << GRAIN_BLOCK_LOG2) - 1u) >> GRAIN_BLOCK_LOG2;
}

fn grainBlocksPerStripe() -> u32 {
    let paddedWidth = (readRecordWord(RECORD_HEADER_UPSCALED_WIDTH) + 1u) & ~1u;
    return (paddedWidth + (1u << GRAIN_BLOCK_LOG2) - 1u) >> GRAIN_BLOCK_LOG2;
}

// A byte of the scaling points grainBuildScalingTables copies into grainScratch, from a points field's first copied word
fn grainPointByte(points: u32, index: u32) -> u32 {
    let word = grainScratch[points + (index >> GRAIN_BYTES_PER_WORD_LOG2)];
    return getField(word, (index & GRAIN_BYTE_INDEX_MASK) * GRAIN_BYTE_BITS, GRAIN_BYTE_BITS);
}

// libaom's init_scaling_function at an 8-bit position over points copied to grainScratch: the last write of its fills and segments
// that covers the position
fn grainScalingFunction(points: u32, pointCount: u32, position: u32) -> i32 {
    if (pointCount == 0u) {
        return 0;
    }
    var value = 0;
    if (position < grainPointByte(points, 0u)) {
        value = i32(grainPointByte(points, 1u));
    }
    var segment = pointCount;
    var start = grainPointByte(points, 0u);
    for (var point = 0u; point + 1u < pointCount; point += 1u) {
        let end = grainPointByte(points, 2u * point + 2u);
        if (end > start && position >= start && position < end) {
            segment = point;
        }
        start = end;
    }
    if (segment < pointCount) {
        let startX = i32(grainPointByte(points, 2u * segment));
        let startY = i32(grainPointByte(points, 2u * segment + 1u));
        let deltaX = i32(grainPointByte(points, 2u * segment + 2u)) - startX;
        let deltaY = i32(grainPointByte(points, 2u * segment + 3u)) - startY;
        let delta = deltaY * ((GRAIN_SCALING_ONE + (deltaX >> 1u)) / deltaX);
        value = startY + (((i32(position) - startX) * delta + GRAIN_SCALING_ROUNDING) >> GRAIN_SCALING_FRACTION_BITS);
    }
    let lastPoint = pointCount - 1u;
    if (position >= grainPointByte(points, 2u * lastPoint)) {
        value = i32(grainPointByte(points, 2u * lastPoint + 1u));
    }
    return value;
}

// libaom's scale_LUT of a sample-depth index over a plane's base table, which grainScratch holds while the tables build
fn grainScaleIndex(plane: u32, index: u32) -> u32 {
    let shift = OUTPUT_BIT_DEPTH - GRAIN_EIGHT_BIT_DEPTH;
    let position = index >> shift;
    let base = bitcast<i32>(grainScratch[plane * GRAIN_SCALING_BASE_ENTRIES + position]);
    if (shift == 0u || position == GRAIN_SCALING_LAST_ENTRY) {
        return u32(base);
    }
    let next = bitcast<i32>(grainScratch[plane * GRAIN_SCALING_BASE_ENTRIES + position + 1u]);
    let fraction = i32(index & ((1u << shift) - 1u));
    return u32(base + (((next - base) * fraction + ((1 << shift) >> 1u)) >> shift));
}

// Builds the three planes' scaling tables at the session's bit depth: the record's scaling points into grainScratch, 256 base
// entries per plane before them, then one byte per index from 0 to 2^bitDepth - 1 into the film grain area
fn grainBuildScalingTables(lane: u32) {
    if (lane < GRAIN_SCALING_POINTS_WORDS) {
        grainScratch[GRAIN_SCALING_POINTS + lane] = grainReadWord(RECORD_FILM_GRAIN_POINTS_Y + lane);
    }
    workgroupBarrier();
    for (var entry = lane; entry < RECORD_PLANES * GRAIN_SCALING_BASE_ENTRIES; entry += TRANSFORM_LANES) {
        let scalingPlane = grainScalingPlane(entry >> GRAIN_SCALING_BASE_LOG2);
        let points = GRAIN_SCALING_POINTS + grainPointsField(scalingPlane) - RECORD_FILM_GRAIN_POINTS_Y;
        let position = entry & (GRAIN_SCALING_BASE_ENTRIES - 1u);
        grainScratch[entry] = bitcast<u32>(grainScalingFunction(points, grainOwnPointCount(scalingPlane), position));
    }
    workgroupBarrier();
    let wordsPerPlaneLog2 = OUTPUT_BIT_DEPTH - GRAIN_BYTES_PER_WORD_LOG2;
    let tables = getFilmGrainOffset() + GRAIN_SCALING_TABLES;
    for (var word = lane; word < (RECORD_PLANES << wordsPerPlaneLog2); word += TRANSFORM_LANES) {
        let plane = word >> wordsPerPlaneLog2;
        let planeWord = word & ((1u << wordsPerPlaneLog2) - 1u);
        var packed = 0u;
        for (var byteIndex = 0u; byteIndex <= GRAIN_BYTE_INDEX_MASK; byteIndex += 1u) {
            packed |= grainScaleIndex(plane, (planeWord << GRAIN_BYTES_PER_WORD_LOG2) + byteIndex) << (byteIndex * GRAIN_BYTE_BITS);
        }
        frameData[tables + plane * GRAIN_SCALING_TABLE_WORDS + planeWord] = packed;
    }
    workgroupBarrier();
}

// Draws every 32x32 luma block's random offsets, one generator per stripe, as add_film_grain_run draws them: a word's four blocks
// from one group of four steps; bytes past the stripe's last block stay zero
fn grainBuildBlockOffsets(lane: u32) {
    let stripeCount = grainStripeCount();
    let blockCount = grainBlocksPerStripe();
    let wordsPerStripe = (blockCount + GRAIN_BYTE_INDEX_MASK) >> GRAIN_BYTES_PER_WORD_LOG2;
    let offsets = getFilmGrainOffset() + GRAIN_BLOCK_OFFSETS;
    let seed = grainSeed();
    for (var stripe = lane; stripe < stripeCount; stripe += TRANSFORM_LANES) {
        var randomRegister = grainSeedLine(seed, stripe);
        for (var word = 0u; word < wordsPerStripe; word += 1u) {
            let registers = grainNextRandomFour(randomRegister);
            randomRegister = registers.w;
            let present = GRAIN_GROUP_MEMBERS < vec4u(blockCount - (word << GRAIN_BYTES_PER_WORD_LOG2));
            let blockBytes = select(vec4u(0u), (registers >> vec4u(GRAIN_REGISTER_BITS - GRAIN_OFFSET_RANDOM_BITS)) & vec4u(GRAIN_BYTE_MASK), present);
            let packed = blockBytes.x | (blockBytes.y << GRAIN_BYTE_BITS) | (blockBytes.z << (2u * GRAIN_BYTE_BITS)) | (blockBytes.w << (3u * GRAIN_BYTE_BITS));
            let index = stripe * wordsPerStripe + word;
            if (index < GRAIN_BLOCK_OFFSETS_WORDS) {
                frameData[offsets + index] = packed;
            }
        }
    }
}

// A sample of a finished template in the film grain area
fn grainReadTemplate(templateOffset: u32, rowWords: u32, row: u32, column: u32) -> i32 {
    let high = column >= rowWords;
    let word = frameData[templateOffset + row * rowWords + select(column, column - rowWords, high)];
    return bitcast<i32>(select(word << TRANSFORM_HALF_BITS, word, high)) >> TRANSFORM_HALF_BITS;
}

// The luma template's average under a chroma template sample, for the chroma auto-regressive filter's luma term: from grainScratch
// while it still holds the luma template, else from the stored luma template
fn grainAverageLumaTemplate(row: u32, column: u32, subsamplingX: u32, subsamplingY: u32, inScratch: bool) -> i32 {
    let lumaTemplate = getFilmGrainOffset() + GRAIN_LUMA_TEMPLATE;
    let lumaRowWords = GRAIN_TEMPLATE_WIDE_COLUMNS >> 1u;
    let lumaRow = ((row - GRAIN_PADDING) << subsamplingY) + GRAIN_PADDING;
    let lumaColumn = ((column - GRAIN_PADDING) << subsamplingX) + GRAIN_PADDING;
    var sum = 0;
    for (var rowOffset = 0u; rowOffset <= subsamplingY; rowOffset += 1u) {
        for (var columnOffset = 0u; columnOffset <= subsamplingX; columnOffset += 1u) {
            if (inScratch) {
                let split = grainSplitColumn(lumaRowWords, lumaColumn + columnOffset);
                sum += bitcast<i32>(grainScratch[(lumaRow + rowOffset) * lumaRowWords + split.x] << split.y) >> TRANSFORM_HALF_BITS;
            } else {
                sum += grainReadTemplate(lumaTemplate, lumaRowWords, lumaRow + rowOffset, lumaColumn + columnOffset);
            }
        }
    }
    let shift = subsamplingX + subsamplingY;
    return (sum + ((1 << shift) >> 1u)) >> shift;
}

// The weight of a window position for a lag: positions 0 to 20 are the rows three, two, and one above by seven columns ending at
// column +lag (right-aligned, so a row's newest value always enters its last position), 21 to 23 row 0 by columns -3 to -1, and 24
// the chroma planes' luma weight; inside the lag's support it is the coefficient at libaom's pred_pos index (rows -lag to -1 by
// columns -lag to lag, then row 0 by columns -lag to -1, then luma), elsewhere zero
fn grainWindowWeight(weightsField: u32, lag: u32, lumaTerm: bool, window: u32) -> i32 {
    let rowLength = 2u * lag + 1u;
    var inSupport = lumaTerm;
    var position = 2u * lag * (lag + 1u);
    if (window < GRAIN_WINDOW_ABOVE) {
        let distance = GRAIN_WINDOW_LAG - window / GRAIN_WINDOW_COLUMNS;
        // Column -lag sits at window column 6 - 2 * lag
        let windowColumn = window % GRAIN_WINDOW_COLUMNS;
        inSupport = distance <= lag && windowColumn + 2u * lag + 1u >= GRAIN_WINDOW_COLUMNS;
        position = (lag - distance) * rowLength + windowColumn + 2u * lag + 1u - GRAIN_WINDOW_COLUMNS;
    } else if (window < GRAIN_WINDOW_NEIGHBORS) {
        let columnOffset = window - GRAIN_WINDOW_ABOVE;
        inSupport = columnOffset + lag >= GRAIN_WINDOW_LAG;
        position = lag * rowLength + columnOffset + lag - GRAIN_WINDOW_LAG;
    }
    if (!inSupport) {
        return 0;
    }
    return bitcast<i32>(grainReadByte(weightsField, position) << (TRANSFORM_WORD_BITS - GRAIN_BYTE_BITS)) >> (TRANSFORM_WORD_BITS - GRAIN_BYTE_BITS);
}

// A template column's word in its split row, and the shift that sign-extends its half
fn grainSplitColumn(rowWords: u32, column: u32) -> vec2u {
    let high = column >= rowWords;
    return vec2u(select(column, column - rowWords, high), select(TRANSFORM_HALF_BITS, 0u, high));
}

// A template pass: the luma template, or both chroma templates in one wavefront (4:2:0, where both fit with their luma averages), or
// one chroma template. Template k of the pass sits at k * templateWords of grainScratch; the luma averages under the filtered chroma
// samples follow the templates when they fit, else each sample averages the stored luma template
struct GrainPass {
    firstPlane: u32,
    planeCount: u32,
    subsamplingX: u32,
    subsamplingY: u32,
    rows: u32,
    columns: u32,
    rowWords: u32,
    templateWords: u32,
    filterRows: u32,
    filterColumns: u32,
    lumaTerm: bool,
    scratchAverages: bool,
    averagesBase: u32,
}

fn grainMakePass(firstPlane: u32, planeCount: u32) -> GrainPass {
    var templatePass: GrainPass;
    templatePass.firstPlane = firstPlane;
    templatePass.planeCount = planeCount;
    templatePass.subsamplingX = grainSubsamplingX(firstPlane);
    templatePass.subsamplingY = grainSubsamplingY(firstPlane);
    templatePass.rows = grainTemplateRows(templatePass.subsamplingY);
    templatePass.columns = grainTemplateColumns(templatePass.subsamplingX);
    templatePass.rowWords = templatePass.columns >> 1u;
    templatePass.templateWords = templatePass.rows * templatePass.rowWords;
    templatePass.filterRows = templatePass.rows - GRAIN_PADDING;
    templatePass.filterColumns = templatePass.columns - 2u * GRAIN_PADDING;
    templatePass.lumaTerm = firstPlane != PLANE_Y && grainOwnPointCount(PLANE_Y) > 0u;
    templatePass.averagesBase = planeCount * templatePass.templateWords;
    let averageWords = (templatePass.filterRows * templatePass.filterColumns + 1u) >> 1u;
    templatePass.scratchAverages = templatePass.lumaTerm && templatePass.averagesBase + averageWords <= GRAIN_SCRATCH_WORDS;
    return templatePass;
}

// A template word of white noise from two generator states: column j's in the low half, column j + rowWords's in the high half
fn grainWhiteWord(lowRegister: u32, highRegister: u32, gaussianRounding: i32, gaussianShift: u32) -> u32 {
    let low = (grainGaussian(lowRegister >> (GRAIN_REGISTER_BITS - GRAIN_GAUSS_BITS)) + gaussianRounding) >> gaussianShift;
    let high = (grainGaussian(highRegister >> (GRAIN_REGISTER_BITS - GRAIN_GAUSS_BITS)) + gaussianRounding) >> gaussianShift;
    return (bitcast<u32>(low) & TRANSFORM_HALF_MASK) | (bitcast<u32>(high) << TRANSFORM_HALF_BITS);
}

// Fills a pass's templates with white noise in raster order, a row of a plane per lane. Word j of a split row holds columns j and
// j + rowWords, so the lane runs two generators, the row's own (jumped to the row's start) and a copy rowWords steps ahead, and
// writes four whole words per group of four steps
fn grainWhiteNoise(templatePass: GrainPass, lane: u32) {
    let gaussianShift = GRAIN_GAUSSIAN_BITS - OUTPUT_BIT_DEPTH + grainReadControl(RECORD_FILM_GRAIN_GRAIN_SCALE_SHIFT_SHIFT, GRAIN_SCALE_SHIFT_BITS);
    let gaussianRounding = (1 << gaussianShift) >> 1u;
    let rowWords = templatePass.rowWords;
    for (var index = lane; index < templatePass.planeCount * templatePass.rows; index += TRANSFORM_LANES) {
        let passPlane = select(0u, 1u, index >= templatePass.rows);
        let row = index - passPlane * templatePass.rows;
        let rowBase = passPlane * templatePass.templateWords + row * rowWords;
        var lowRegister = grainRowStart(grainTemplateStart(templatePass.firstPlane + passPlane), row, templatePass.columns);
        var highRegister = lowRegister;
        for (var skipped = GRAIN_GROUP_STEPS; skipped <= rowWords; skipped += GRAIN_GROUP_STEPS) {
            highRegister = grainNextRandomFour(highRegister).w;
        }
        for (var skipped = rowWords & ~(GRAIN_GROUP_STEPS - 1u); skipped < rowWords; skipped += 1u) {
            _ = grainNextRandom(&highRegister, GRAIN_GAUSS_BITS);
        }
        for (var word = 0u; word < rowWords; word += GRAIN_GROUP_STEPS) {
            let lowRegisters = grainNextRandomFour(lowRegister);
            let highRegisters = grainNextRandomFour(highRegister);
            lowRegister = lowRegisters.w;
            highRegister = highRegisters.w;
            grainScratch[rowBase + word] = grainWhiteWord(lowRegisters.x, highRegisters.x, gaussianRounding, gaussianShift);
            if (word + 1u < rowWords) {
                grainScratch[rowBase + word + 1u] = grainWhiteWord(lowRegisters.y, highRegisters.y, gaussianRounding, gaussianShift);
            }
            if (word + 2u < rowWords) {
                grainScratch[rowBase + word + 2u] = grainWhiteWord(lowRegisters.z, highRegisters.z, gaussianRounding, gaussianShift);
            }
            if (word + 3u < rowWords) {
                grainScratch[rowBase + word + 3u] = grainWhiteWord(lowRegisters.w, highRegisters.w, gaussianRounding, gaussianShift);
            }
        }
    }
}

// Places the luma average under every filtered chroma sample where the chroma passes read them (grainPassLumaAverage), two per word in
// raster order, when they fit beside the chroma templates. They come from the luma template while grainScratch still holds it (after
// the luma pass stored it); each lane carries its words over a barrier, since the averages overwrite the luma template, and the
// chroma passes' white noise fills only the templates before them, so Cb and Cr passes share one placement
fn grainPlaceLumaAverages(chromaPass: GrainPass, lane: u32) {
    if (!chromaPass.lumaTerm || !chromaPass.scratchAverages) {
        return;
    }
    let columns = chromaPass.filterColumns;
    let wordCount = (chromaPass.filterRows * columns) >> 1u;
    // Word w holds positions 2w and 2w + 1, one row's even and odd columns since rows are an even number of columns; a lane's next
    // slot is 128 positions on
    let slotPositions = 2u * TRANSFORM_LANES;
    let slotRows = slotPositions / columns;
    let slotColumns = slotPositions - slotRows * columns;
    var row = (2u * lane) / columns;
    var column = 2u * lane - row * columns;
    var averages: array<u32, GRAIN_AVERAGE_SLOTS>;
    for (var slot = 0u; slot < GRAIN_AVERAGE_SLOTS; slot += 1u) {
        if (row < chromaPass.filterRows) {
            let even = grainAverageLumaTemplate(row + GRAIN_PADDING, column + GRAIN_PADDING, chromaPass.subsamplingX, chromaPass.subsamplingY, true);
            let odd = grainAverageLumaTemplate(row + GRAIN_PADDING, column + 1u + GRAIN_PADDING, chromaPass.subsamplingX, chromaPass.subsamplingY, true);
            averages[slot] = (bitcast<u32>(even) & TRANSFORM_HALF_MASK) | (bitcast<u32>(odd) << TRANSFORM_HALF_BITS);
        }
        row += slotRows;
        column += slotColumns;
        if (column >= columns) {
            column -= columns;
            row += 1u;
        }
    }
    workgroupBarrier();
    for (var slot = 0u; slot < GRAIN_AVERAGE_SLOTS; slot += 1u) {
        let word = lane + slot * TRANSFORM_LANES;
        if (word < wordCount) {
            grainScratch[chromaPass.averagesBase + word] = averages[slot];
        }
    }
}

// The luma average under a filtered chroma sample: from grainScratch, or from the stored luma template when it did not fit
fn grainPassLumaAverage(templatePass: GrainPass, row: u32, column: u32) -> i32 {
    if (!templatePass.scratchAverages) {
        return grainAverageLumaTemplate(row, column, templatePass.subsamplingX, templatePass.subsamplingY, false);
    }
    let position = (row - GRAIN_PADDING) * templatePass.filterColumns + column - GRAIN_PADDING;
    let word = grainScratch[templatePass.averagesBase + (position >> 1u)];
    return bitcast<i32>(word << ((1u - (position & 1u)) * TRANSFORM_HALF_BITS)) >> TRANSFORM_HALF_BITS;
}

// Filters one template sample (generate_luma_grain_block, generate_chroma_grain_blocks): libaom's clamp(grain + ((wsum + rounding) >>
// shift)) over the white noise in the sample's word, written back with one read and one write; returns the filtered sample
fn grainFinishSample(base: u32, rowWords: u32, row: u32, column: u32, sum: i32, shift: u32) -> i32 {
    let split = grainSplitColumn(rowWords, column);
    let index = base + row * rowWords + split.x;
    let word = grainScratch[index];
    let filtered = clamp((bitcast<i32>(word << split.y) >> TRANSFORM_HALF_BITS) + ((sum + ((1 << shift) >> 1u)) >> shift), GRAIN_MINIMUM, GRAIN_MAXIMUM);
    let bits = bitcast<u32>(filtered) & TRANSFORM_HALF_MASK;
    grainScratch[index] = select((word & TRANSFORM_HALF_MASK) | (bits << TRANSFORM_HALF_BITS), (word & ~TRANSFORM_HALF_MASK) | bits, split.y != 0u);
    return filtered;
}

// The auto-regressive window a lane slides along its row, in grainWindowWeight's order: the rows three and two above by seven columns
// ending at the lag, the row above by the six columns before its newest value (which a sample's own step loads and weighs, position
// 20, so above[20] stays unused), then the row's three samples to the left. Positions past the lag's support hold anything, since
// their weights are zero
struct GrainWindow {
    above: array<i32, GRAIN_WINDOW_ABOVE>,
    left: array<i32, GRAIN_WINDOW_LAG>,
}

// The newest value of the row above, which a sample's own step adds, and the last-filtered left sample, in window positions
const GRAIN_NEWEST_POSITION: u32 = 20u;
const GRAIN_LEFT_POSITION: u32 = 23u;
// The start step of a lane's missing second row
const GRAIN_STEP_NEVER: u32 = 0xFFFFFFFFu;
// The weight that carries a running sum through a dot product
const GRAIN_UNIT_WEIGHT: i32 = 1;

// A pass plane's window weights, from grainWeights into registers
fn grainLoadWeights(passPlane: u32) -> array<i32, GRAIN_WEIGHT_COUNT> {
    let base = passPlane * GRAIN_WEIGHT_COUNT;
    return array<i32, GRAIN_WEIGHT_COUNT>(
        grainWeights[base], grainWeights[base + 1u], grainWeights[base + 2u], grainWeights[base + 3u], grainWeights[base + 4u],
        grainWeights[base + 5u], grainWeights[base + 6u], grainWeights[base + 7u], grainWeights[base + 8u], grainWeights[base + 9u],
        grainWeights[base + 10u], grainWeights[base + 11u], grainWeights[base + 12u], grainWeights[base + 13u], grainWeights[base + 14u],
        grainWeights[base + 15u], grainWeights[base + 16u], grainWeights[base + 17u], grainWeights[base + 18u], grainWeights[base + 19u],
        grainWeights[base + 20u], grainWeights[base + 21u], grainWeights[base + 22u], grainWeights[base + 23u], grainWeights[base + 24u]);
}

// The partial sum a step prepares for the next sample: the rounding and every weighted window position but the newest value of the
// row above, which the sample's own step adds. Integer dot products compile to multiply-add chains that keep their order, which
// plain additions do not (the compiler folds them into one chain that starts with the latest value), so the values known when the
// step starts form short chains, the values the step loads (positions 6, 13, 19, and the luma average) follow, and the sample the
// step just filtered comes last
fn grainPartialSum(window: GrainWindow, weights: array<i32, GRAIN_WEIGHT_COUNT>, average: i32, rounding: i32) -> i32 {
    let known = dot(vec4i(weights[0], weights[1], weights[2], weights[3]), vec4i(window.above[0], window.above[1], window.above[2], window.above[3]))
        + dot(vec4i(weights[4], weights[5], weights[7], weights[8]), vec4i(window.above[4], window.above[5], window.above[7], window.above[8]))
        + dot(vec4i(weights[9], weights[10], weights[11], weights[12]), vec4i(window.above[9], window.above[10], window.above[11], window.above[12]))
        + dot(vec4i(weights[14], weights[15], weights[16], weights[17]), vec4i(window.above[14], window.above[15], window.above[16], window.above[17]))
        + dot(vec4i(weights[18], weights[21], weights[22], GRAIN_UNIT_WEIGHT), vec4i(window.above[18], window.left[0], window.left[1], rounding));
    let loaded = dot(vec4i(GRAIN_UNIT_WEIGHT, weights[6], weights[13], weights[19]), vec4i(known, window.above[6], window.above[13], window.above[19]));
    return dot(vec3i(GRAIN_UNIT_WEIGHT, weights[GRAIN_WINDOW_NEIGHBORS], weights[GRAIN_LEFT_POSITION]), vec3i(loaded, average, window.left[2]));
}

// The auto-regressive filter rows of a pass's planes field
fn grainWeightsField(plane: u32) -> u32 {
    switch (plane) {
        case PLANE_Y: { return RECORD_FILM_GRAIN_AR_Y; }
        case PLANE_U: { return RECORD_FILM_GRAIN_AR_CB; }
        default: { return RECORD_FILM_GRAIN_AR_CR; }
    }
}

// The auto-regressive filter with a lag, as a pipelined wavefront. Lane l takes row l of the pass's first plane, or row
// l - filterRows of the second, and the row 64 - filterRows below it in the same plane when that exists (rows 64 to 69 of a single
// plane; rows 29 to 34 of the second plane in a joint 4:2:0 pass), never active together, so a lane keeps one plane's weights. Row r
// starts at step 1 + (lag + 1) * r, and its step t reads the rows above at template column u = t - start, final since the row above
// filtered it at step t - 1; from u = 3 + lag on the step filters column u - lag, and the steps before only fill the window, so a row
// needs no separate window load. A step loads the one value the step before produced (the row above at column u), adds it to the
// partial sum the step before prepared, and stores the sample; it issues the next step's loads before that store and prepares the
// next partial sum after it, so every row, the first included, starts after a preparing step
fn grainFilterWavefront(templatePass: GrainPass, lag: u32, shift: u32, lane: u32) {
    let slope = lag + 1u;
    let preRoll = GRAIN_PADDING + lag;
    let rowSteps = preRoll + templatePass.filterColumns;
    let stepCount = 1u + rowSteps + slope * (templatePass.filterRows - 1u);
    let rounding = (1 << shift) >> 1u;
    let rowWords = templatePass.rowWords;
    let virtualRows = templatePass.planeCount * templatePass.filterRows;
    let passPlane = select(0u, 1u, lane >= templatePass.filterRows);
    let planeBase = passPlane * templatePass.templateWords;
    let firstRow = lane - passPlane * templatePass.filterRows;
    let firstStart = select(GRAIN_STEP_NEVER, 1u + slope * firstRow, lane < virtualRows);
    let firstBase = planeBase + (firstRow + GRAIN_PADDING) * rowWords;
    let laterRow = firstRow + TRANSFORM_LANES - passPlane * templatePass.filterRows;
    let laterStart = select(GRAIN_STEP_NEVER, 1u + slope * laterRow, lane < virtualRows && laterRow < templatePass.filterRows);
    let laterBase = planeBase + (laterRow + GRAIN_PADDING) * rowWords;
    let weights = grainLoadWeights(passPlane);
    var window: GrainWindow;
    // What the step before prepared: the partial sum, the sample's word and the shift that extracts its half, and the newest value's
    // word and shift; inactive lanes read word 0, padding that no step writes
    var partial = 0;
    var ownWord = 0u;
    var ownIndex = 0u;
    var ownShift = 0u;
    var newestIndex = 0u;
    var newestShift = 0u;
    for (var step = 0u; step < stepCount; step += 1u) {
        let later = step >= laterStart;
        let rowStart = select(firstStart, laterStart, later);
        let column = step - rowStart;
        let filtering = step >= rowStart && column >= preRoll && column < rowSteps;
        let nextStep = step + 1u;
        let nextLater = nextStep >= laterStart;
        let nextStart = select(firstStart, laterStart, nextLater);
        let nextColumn = nextStep - nextStart;
        let nextActive = nextStep >= nextStart && nextColumn < rowSteps;
        let nextBase = select(firstBase, laterBase, nextLater);
        let nextRow = select(firstRow, laterRow, nextLater);
        let newestSplit = grainSplitColumn(rowWords, nextColumn);
        let ownColumn = max(nextColumn, lag) - lag;
        let ownSplit = grainSplitColumn(rowWords, ownColumn);
        let nextAbove3Index = select(0u, nextBase - 3u * rowWords + newestSplit.x, nextActive);
        let nextAbove2Index = select(0u, nextBase - 2u * rowWords + newestSplit.x, nextActive);
        let nextOwnIndex = select(0u, nextBase + ownSplit.x, nextActive);
        // This step's newest value first, then the next step's values, all before this step's store
        let newest = bitcast<i32>(grainScratch[newestIndex] << newestShift) >> TRANSFORM_HALF_BITS;
        let nextAbove3 = bitcast<i32>(grainScratch[nextAbove3Index] << newestSplit.y) >> TRANSFORM_HALF_BITS;
        let nextAbove2 = bitcast<i32>(grainScratch[nextAbove2Index] << newestSplit.y) >> TRANSFORM_HALF_BITS;
        let nextOwnWord = grainScratch[nextOwnIndex];
        // The luma average for the next sample; inactive lanes and padding columns read column 3's, outside every template
        var nextAverage = 0;
        if (templatePass.lumaTerm) {
            nextAverage = grainPassLumaAverage(templatePass, nextRow + GRAIN_PADDING, select(GRAIN_PADDING, max(ownColumn, GRAIN_PADDING), nextActive));
        }
        // This step's sample (libaom's clamp(grain + ((wsum + rounding) >> shift))); before column 3 it is the white noise padding
        let white = bitcast<i32>(ownWord << ownShift) >> TRANSFORM_HALF_BITS;
        let filtered = clamp(white + ((partial + weights[GRAIN_NEWEST_POSITION] * newest) >> shift), GRAIN_MINIMUM, GRAIN_MAXIMUM);
        let sample = select(white, filtered, filtering);
        if (filtering) {
            grainScratch[ownIndex] = (ownWord & (TRANSFORM_HALF_MASK << ownShift))
                | ((bitcast<u32>(sample) & TRANSFORM_HALF_MASK) << (TRANSFORM_HALF_BITS - ownShift));
        }
        // The next step's window and partial sum
        window.above[0] = window.above[1];
        window.above[1] = window.above[2];
        window.above[2] = window.above[3];
        window.above[3] = window.above[4];
        window.above[4] = window.above[5];
        window.above[5] = window.above[6];
        window.above[6] = nextAbove3;
        window.above[7] = window.above[8];
        window.above[8] = window.above[9];
        window.above[9] = window.above[10];
        window.above[10] = window.above[11];
        window.above[11] = window.above[12];
        window.above[12] = window.above[13];
        window.above[13] = nextAbove2;
        window.above[14] = window.above[15];
        window.above[15] = window.above[16];
        window.above[16] = window.above[17];
        window.above[17] = window.above[18];
        window.above[18] = window.above[19];
        window.above[19] = newest;
        window.left[0] = window.left[1];
        window.left[1] = window.left[2];
        window.left[2] = sample;
        partial = grainPartialSum(window, weights, nextAverage, rounding);
        ownWord = nextOwnWord;
        ownIndex = nextOwnIndex;
        ownShift = ownSplit.y;
        newestIndex = select(0u, nextBase - rowWords + newestSplit.x, nextActive);
        newestShift = newestSplit.y;
        workgroupBarrier();
    }
}

// Builds a pass's templates in grainScratch and stores them: white noise, then the auto-regressive filter, both templates of a joint
// pass together. The templates stay in grainScratch after the closing barrier
fn grainBuildPass(firstPlane: u32, planeCount: u32, lane: u32) {
    let templatePass = grainMakePass(firstPlane, planeCount);
    grainWhiteNoise(templatePass, lane);
    let lag = grainReadControl(RECORD_FILM_GRAIN_AR_LAG_SHIFT, GRAIN_AR_LAG_BITS);
    if (lane < planeCount * GRAIN_WEIGHT_COUNT) {
        let passPlane = select(0u, 1u, lane >= GRAIN_WEIGHT_COUNT);
        let plane = firstPlane + passPlane;
        grainWeights[lane] = grainWindowWeight(grainWeightsField(plane), lag, templatePass.lumaTerm, lane - passPlane * GRAIN_WEIGHT_COUNT);
    }
    workgroupBarrier();
    let shift = grainReadControl(RECORD_FILM_GRAIN_AR_SHIFT_SHIFT, GRAIN_AR_SHIFT_BITS);
    if (lag == 0u) {
        // Without neighbors every sample is independent: a lane filters whole rows, with the luma weight alone
        let firstLumaWeight = grainWeights[GRAIN_WINDOW_NEIGHBORS];
        let secondLumaWeight = grainWeights[GRAIN_WEIGHT_COUNT + GRAIN_WINDOW_NEIGHBORS];
        for (var filterRow = lane; filterRow < templatePass.filterRows; filterRow += TRANSFORM_LANES) {
            for (var filterColumn = 0u; filterColumn < templatePass.filterColumns; filterColumn += 1u) {
                let row = filterRow + GRAIN_PADDING;
                let column = filterColumn + GRAIN_PADDING;
                var average = 0;
                if (templatePass.lumaTerm) {
                    average = grainPassLumaAverage(templatePass, row, column);
                }
                grainFinishSample(0u, templatePass.rowWords, row, column, firstLumaWeight * average, shift);
                if (planeCount == 2u) {
                    grainFinishSample(templatePass.templateWords, templatePass.rowWords, row, column, secondLumaWeight * average, shift);
                }
            }
        }
    } else {
        grainFilterWavefront(templatePass, lag, shift, lane);
    }
    workgroupBarrier();
    let templates = getFilmGrainOffset() + GRAIN_LUMA_TEMPLATE;
    for (var word = lane; word < planeCount * templatePass.templateWords; word += TRANSFORM_LANES) {
        let passPlane = select(0u, 1u, word >= templatePass.templateWords);
        frameData[templates + (firstPlane + passPlane) * GRAIN_TEMPLATE_WORDS + word - passPlane * templatePass.templateWords] = grainScratch[word];
    }
    workgroupBarrier();
}

// Generates the shown frame's film grain into the film grain area: scaling tables, block offsets, and the templates, a pass per plane
// in order (luma, Cb, Cr) where Cb's pass takes Cr too when both fit together. Every pass goes through the one grainBuildPass call
// site, so its code compiles once
fn grainGenerate(lane: u32) {
    if (lane == 0u) {
        grainRunning = select(0u, 1u, grainFrameApplies());
    }
    if (workgroupUniformLoad(&grainRunning) == 0u) {
        return;
    }
    let gaussianTable = getTablesOffset() + TRANSFORM_TABLES_OFFSET + GRAIN_GAUSSIAN_TABLE;
    for (var word = lane; word < GRAIN_GAUSSIAN_WORDS; word += TRANSFORM_LANES) {
        grainGaussianTable[word] = frameData[gaussianTable + word];
    }
    workgroupBarrier();
    grainBuildScalingTables(lane);
    grainBuildBlockOffsets(lane);
    let lumaApplies = grainPlaneApplies(PLANE_Y);
    let chromaU = grainPlaneApplies(PLANE_U);
    let chromaV = grainPlaneApplies(PLANE_V);
    let joint = chromaU && chromaV && 2u * grainMakePass(PLANE_U, 2u).templateWords <= GRAIN_SCRATCH_WORDS;
    for (var plane = PLANE_Y; plane < RECORD_PLANES; plane += 1u) {
        let applies = select(select(chromaV && !joint, chromaU || joint, plane == PLANE_U), lumaApplies, plane == PLANE_Y);
        if (applies) {
            grainBuildPass(plane, select(1u, 2u, plane == PLANE_U && joint), lane);
        }
        if (plane == PLANE_Y) {
            if (lumaApplies && (chromaU || chromaV)) {
                grainPlaceLumaAverages(grainMakePass(select(PLANE_V, PLANE_U, chromaU), select(1u, 2u, joint)), lane);
            }
            // Where the averages do not fit, the chroma templates' luma term reads the stored luma template
            storageBarrier();
        }
    }
}

// The output copy: 128 samples of a row per workgroup, one output word of SAMPLES_PER_WORD samples per lane, from one store word at
// 16 bits per sample and two at 8. A lane's samples are a vec4u whose first SAMPLES_PER_WORD members count
const OUTPUT_ROW_SAMPLES: u32 = 128u;
const OUTPUT_LANE_STORE_WORDS: u32 = SAMPLES_PER_WORD >> SAMPLE_PAIR_SHIFT;
const OUTPUT_SAMPLE_OFFSETS: vec4u = vec4u(0u, 1u, 2u, 3u);

// What the output copy needs about one plane's film grain, read once per invocation of a frame with film grain
struct GrainPlane {
    applies: bool,
    subsamplingX: u32,
    subsamplingY: u32,
    templateOffset: u32,
    templateRowWords: u32,
    scalingTable: u32,
    blockOffsets: u32,
    wordsPerStripe: u32,
    overlap: bool,
    scalingShift: u32,
    multiplier: i32,
    lumaMultiplier: i32,
    offset: i32,
    clampLow: i32,
    clampHigh: i32,
    lumaWidth: u32,
    outputBuffer: u32,
}

// Reads a plane's film grain parameters (add_noise_to_block's multipliers, offset, and clip range)
fn grainReadPlane(plane: u32) -> GrainPlane {
    var grain: GrainPlane;
    grain.outputBuffer = readRecordWord(RECORD_HEADER_OUTPUT_BUFFER);
    grain.applies = hasRecordFlag(RECORD_FLAG_FILM_GRAIN) && grainReadControl(RECORD_FILM_GRAIN_APPLY_SHIFT, GRAIN_FLAG_BITS) == 1u
        && grainPlaneApplies(plane);
    grain.subsamplingX = grainSubsamplingX(plane);
    grain.subsamplingY = grainSubsamplingY(plane);
    grain.templateOffset = getFilmGrainOffset() + GRAIN_LUMA_TEMPLATE + plane * GRAIN_TEMPLATE_WORDS;
    grain.templateRowWords = grainTemplateColumns(grain.subsamplingX) >> 1u;
    grain.scalingTable = getFilmGrainOffset() + GRAIN_SCALING_TABLES + plane * GRAIN_SCALING_TABLE_WORDS;
    grain.blockOffsets = getFilmGrainOffset() + GRAIN_BLOCK_OFFSETS;
    grain.wordsPerStripe = (grainBlocksPerStripe() + GRAIN_BYTE_INDEX_MASK) >> GRAIN_BYTES_PER_WORD_LOG2;
    grain.overlap = grainReadControl(RECORD_FILM_GRAIN_OVERLAP_SHIFT, GRAIN_FLAG_BITS) == 1u;
    grain.scalingShift = grainReadControl(RECORD_FILM_GRAIN_SCALING_SHIFT_SHIFT, GRAIN_SCALING_SHIFT_BITS);
    grain.lumaWidth = readRecordWord(RECORD_HEADER_UPSCALED_WIDTH);
    let depthShift = OUTPUT_BIT_DEPTH - GRAIN_EIGHT_BIT_DEPTH;
    if (plane != PLANE_Y) {
        let chromaWord = grainReadWord(select(RECORD_FILM_GRAIN_CR, RECORD_FILM_GRAIN_CB, plane == PLANE_U));
        grain.multiplier = i32(getField(chromaWord, RECORD_FILM_GRAIN_MULTIPLIER_SHIFT, GRAIN_MULTIPLIER_BITS)) - GRAIN_MULTIPLIER_BIAS;
        grain.lumaMultiplier = i32(getField(chromaWord, RECORD_FILM_GRAIN_LUMA_MULTIPLIER_SHIFT, GRAIN_MULTIPLIER_BITS)) - GRAIN_MULTIPLIER_BIAS;
        grain.offset = (i32(getField(chromaWord, RECORD_FILM_GRAIN_OFFSET_SHIFT, GRAIN_OFFSET_BITS)) << depthShift) - (1 << OUTPUT_BIT_DEPTH);
        if (grainChromaFromLuma()) {
            grain.multiplier = 0;
            grain.lumaMultiplier = GRAIN_CHROMA_FROM_LUMA_MULTIPLIER;
            grain.offset = 0;
        }
    }
    grain.clampLow = 0;
    grain.clampHigh = (1 << OUTPUT_BIT_DEPTH) - 1;
    if (grainReadControl(RECORD_FILM_GRAIN_CLIP_SHIFT, GRAIN_FLAG_BITS) == 1u) {
        let identity = grainReadControl(RECORD_FILM_GRAIN_MC_IDENTITY_SHIFT, GRAIN_FLAG_BITS) == 1u;
        grain.clampLow = GRAIN_LEGAL_LOW << depthShift;
        let chromaHigh = select(GRAIN_LEGAL_CHROMA_HIGH, GRAIN_LEGAL_LUMA_HIGH, identity);
        grain.clampHigh = select(chromaHigh, GRAIN_LEGAL_LUMA_HIGH, plane == PLANE_Y) << depthShift;
    }
    return grain;
}

// One block's random offsets byte
fn grainReadBlockOffsets(grain: GrainPlane, stripe: u32, block: u32) -> u32 {
    let word = frameData[grain.blockOffsets + stripe * grain.wordsPerStripe + (block >> GRAIN_BYTES_PER_WORD_LOG2)];
    return getField(word, (block & GRAIN_BYTE_INDEX_MASK) * GRAIN_BYTE_BITS, GRAIN_BYTE_BITS);
}

// ver_boundary_overlap and hor_boundary_overlap: the previous block's or stripe's grain blended into the current one, sample index of
// an edge one or two samples wide
fn grainBlend(previous: i32, current: i32, index: u32, edgeWidth: u32) -> i32 {
    var previousWeight = GRAIN_BLEND_NARROW_PREVIOUS;
    var currentWeight = GRAIN_BLEND_NARROW_CURRENT;
    if (edgeWidth == 2u) {
        previousWeight = select(GRAIN_BLEND_INNER, GRAIN_BLEND_OUTER, index == 0u);
        currentWeight = select(GRAIN_BLEND_OUTER, GRAIN_BLEND_INNER, index == 0u);
    }
    return clamp((previous * previousWeight + current * currentWeight + GRAIN_BLEND_ROUNDING) >> GRAIN_BLEND_SHIFT, GRAIN_MINIMUM, GRAIN_MAXIMUM);
}

// Template samples (row, column) and (row, column + 1)
fn grainReadTemplatePair(grain: GrainPlane, row: u32, column: u32) -> vec2i {
    return vec2i(grainReadTemplate(grain.templateOffset, grain.templateRowWords, row, column),
        grainReadTemplate(grain.templateOffset, grain.templateRowWords, row, column + 1u));
}

// The grain of a stripe's row at a sample pair of a 32x32 block (block columns blockColumn and blockColumn + 1, blockColumn even):
// the template samples the block's offsets pick, blended with the block to its left over the first one or two columns
fn grainStripeNoisePair(grain: GrainPlane, stripe: u32, stripeRow: u32, block: u32, blockColumn: u32) -> vec2i {
    let offsets = grainReadBlockOffsets(grain, stripe, block);
    let row = grainBlockOrigin(offsets & GRAIN_OFFSET_FIELD_MASK, grain.subsamplingY) + stripeRow;
    let column = grainBlockOrigin(offsets >> GRAIN_OFFSET_FIELD_BITS, grain.subsamplingX) + blockColumn;
    var noise = grainReadTemplatePair(grain, row, column);
    let edgeWidth = 2u >> grain.subsamplingX;
    if (grain.overlap && block > 0u && blockColumn < edgeWidth) {
        let leftOffsets = grainReadBlockOffsets(grain, stripe, block - 1u);
        let leftRow = grainBlockOrigin(leftOffsets & GRAIN_OFFSET_FIELD_MASK, grain.subsamplingY) + stripeRow;
        let blockWidth = 1u << (GRAIN_BLOCK_LOG2 - grain.subsamplingX);
        let leftColumn = grainBlockOrigin(leftOffsets >> GRAIN_OFFSET_FIELD_BITS, grain.subsamplingX) + blockWidth + blockColumn;
        let left = grainReadTemplatePair(grain, leftRow, leftColumn);
        // The pair's second column is inside an edge two samples wide only
        let blended = vec2i(grainBlend(left.x, noise.x, blockColumn, edgeWidth), grainBlend(left.y, noise.y, blockColumn + 1u, edgeWidth));
        noise = select(noise, blended, vec2<bool>(true, blockColumn + 1u < edgeWidth));
    }
    return noise;
}

// The grain of samples (x, y) and (x + 1, y) of a plane, x even (one block holds both): their stripe's grain, blended with the stripe
// above over the first one or two rows. One grainStripeNoisePair call site serves both stripes, so its code compiles once
fn grainNoisePair(grain: GrainPlane, x: u32, y: u32) -> vec2i {
    let blockWidthLog2 = GRAIN_BLOCK_LOG2 - grain.subsamplingX;
    let blockHeightLog2 = GRAIN_BLOCK_LOG2 - grain.subsamplingY;
    let block = x >> blockWidthLog2;
    let blockColumn = x & ((1u << blockWidthLog2) - 1u);
    let stripe = y >> blockHeightLog2;
    let stripeRow = y & ((1u << blockHeightLog2) - 1u);
    let edgeHeight = 2u >> grain.subsamplingY;
    let blended = grain.overlap && stripe > 0u && stripeRow < edgeHeight;
    var noise = vec2i(0);
    var above = vec2i(0);
    for (var stripeOffset = 0u; stripeOffset < select(1u, 2u, blended); stripeOffset += 1u) {
        // The stripe above continues past its rows into this stripe's first rows
        let value = grainStripeNoisePair(grain, stripe - stripeOffset, stripeRow + (stripeOffset << blockHeightLog2), block, blockColumn);
        if (stripeOffset == 0u) {
            noise = value;
        } else {
            above = value;
        }
    }
    if (blended) {
        noise = vec2i(grainBlend(above.x, noise.x, stripeRow, edgeHeight), grainBlend(above.y, noise.y, stripeRow, edgeHeight));
    }
    return noise;
}

// A plane's scaling table entry (scale_LUT at the session's bit depth)
fn grainReadScaling(grain: GrainPlane, index: u32) -> i32 {
    let word = frameData[grain.scalingTable + (index >> GRAIN_BYTES_PER_WORD_LOG2)];
    return i32(getField(word, (index & GRAIN_BYTE_INDEX_MASK) * GRAIN_BYTE_BITS, GRAIN_BYTE_BITS));
}

// The scaling indices of samples (x, y) and (x + 1, y), x even: the samples themselves for luma; for chroma, their mix with the
// co-located luma, averaged over two columns when chroma is subsampled horizontally (libaom pads an odd frame by repeating its last
// column)
fn outputScalingIndices(grain: GrainPlane, plane: u32, x: u32, y: u32, samples: vec2u) -> vec2u {
    if (plane == PLANE_Y) {
        return samples;
    }
    let lumaX = x << grain.subsamplingX;
    let lumaY = y << grain.subsamplingY;
    // Luma columns lumaX and lumaX + 1, then lumaX + 2 and lumaX + 3 when subsampled
    let firstWord = frames[getStoreWordIndex(grain.outputBuffer, PLANE_Y, lumaX, lumaY)];
    var averages = vec2i(vec2u(firstWord & SAMPLE_HALF_MASK, firstWord >> SAMPLE_HALF_BITS));
    if (grain.subsamplingX == 1u) {
        let secondWord = frames[getStoreWordIndex(grain.outputBuffer, PLANE_Y, lumaX + 2u, lumaY)];
        let lumaColumns = vec4u(firstWord, firstWord >> SAMPLE_HALF_BITS, secondWord, secondWord >> SAMPLE_HALF_BITS) & vec4u(SAMPLE_HALF_MASK);
        let next = select(lumaColumns.xz, lumaColumns.yw, vec2u(lumaX + 1u, lumaX + 3u) < vec2u(grain.lumaWidth));
        averages = (vec2i(lumaColumns.xz) + vec2i(next) + vec2i(1)) >> vec2u(1u);
    }
    let combined = ((averages * grain.lumaMultiplier + grain.multiplier * vec2i(samples)) >> vec2u(GRAIN_COMBINATION_SHIFT)) + vec2i(grain.offset);
    return vec2u(clamp(combined, vec2i(0), vec2i((1 << OUTPUT_BIT_DEPTH) - 1)));
}

// Film grain added to samples (x, y) and (x + 1, y), x even (add_noise_to_block): each one's scaled noise, rounded, added, and clipped
fn outputGrainPair(grain: GrainPlane, plane: u32, x: u32, y: u32, samples: vec2u) -> vec2u {
    let indices = outputScalingIndices(grain, plane, x, y, samples);
    let scaled = vec2i(grainReadScaling(grain, indices.x), grainReadScaling(grain, indices.y)) * grainNoisePair(grain, x, y);
    let noise = (scaled + vec2i((1 << grain.scalingShift) >> 1u)) >> vec2u(grain.scalingShift);
    return vec2u(clamp(vec2i(samples) + noise, vec2i(grain.clampLow), vec2i(grain.clampHigh)));
}

// Film grain added to a lane's samples from (firstX, y), those inside the plane's width
fn outputAddGrain(plane: u32, firstX: u32, y: u32, width: u32, samples: vec4u) -> vec4u {
    let grain = grainReadPlane(plane);
    if (!grain.applies) {
        return samples;
    }
    // The lane's pairs that start inside the width, through one outputGrainPair call site, so its code compiles once
    var grained = samples;
    let pairCount = select(1u, OUTPUT_LANE_STORE_WORDS, firstX + 2u < width);
    for (var pair = 0u; pair < pairCount; pair += 1u) {
        let pairSamples = outputGrainPair(grain, plane, firstX + (pair << SAMPLE_PAIR_SHIFT), y, select(samples.xy, samples.zw, pair == 1u));
        grained = select(vec4u(pairSamples, grained.zw), vec4u(grained.xy, pairSamples), pair == 1u);
    }
    return select(samples, grained, vec4u(firstX) + OUTPUT_SAMPLE_OFFSETS < vec4u(width));
}

// Copies 128 samples of row y of plane z of the output buffer into the output slot, from x * 128, with film grain; 4:0:0 frames
// write neutral chroma
fn outputWriteRow(workgroup: vec3u, lane: u32) {
    let plane = workgroup.z;
    let y = workgroup.y;
    let laneOffset = lane * SAMPLES_PER_WORD;
    let firstX = workgroup.x * OUTPUT_ROW_SAMPLES + laneOffset;
    let storeWidth = getStorePlaneWidth(plane);
    // Lanes past the row's samples, and rows and columns past the store plane (most chroma workgroups of subsampled formats), leave
    // on the stream uniform alone, before any storage read
    if (laneOffset >= OUTPUT_ROW_SAMPLES || y >= getStorePlaneHeight(plane) || firstX >= storeWidth) {
        return;
    }
    // The header words, all read before any is tested
    let frameValid = state[STATE_FRAME_VALID] == 1u;
    let flags = readRecordWord(RECORD_HEADER_FLAGS);
    let outputBuffer = readRecordWord(RECORD_HEADER_OUTPUT_BUFFER);
    let width = getUpscaledPlaneWidth(plane);
    let height = getFramePlaneHeight(plane);
    if (!frameValid || getField(flags, RECORD_FLAG_SHOW_FRAME, 1u) == 0u || y >= height || firstX >= width) {
        return;
    }
    var samples = vec4u(1u << (OUTPUT_BIT_DEPTH - 1u));
    if (plane == PLANE_Y || getField(flags, RECORD_FLAG_MONOCHROME, 1u) == 0u) {
        // The lane's store words; columns past the store's width repeat its last
        let wordIndex = getStoreWordIndex(outputBuffer, plane, firstX, y);
        let words = vec2u(frames[wordIndex], frames[wordIndex + OUTPUT_LANE_STORE_WORDS - 1u]);
        let columns = min(vec4u(firstX) + OUTPUT_SAMPLE_OFFSETS, vec4u(storeWidth - 1u)) - vec4u(firstX);
        samples = (select(vec4u(words.x), vec4u(words.y), columns >= vec4u(2u)) >> ((columns & vec4u(1u)) * SAMPLE_HALF_BITS)) & vec4u(SAMPLE_HALF_MASK);
        if (getField(flags, RECORD_FLAG_FILM_GRAIN, 1u) == 1u) {
            samples = outputAddGrain(plane, firstX, y, width, samples);
        }
    }
    // NOTE: one output write site; with a second writeOutputSamples16 call the 4K dispatch cost about 98 us even when no lane
    // reached either write (19 us with one), measured on an RTX 5080
    if (SAMPLE_BYTES == 1u) {
        writeOutputSamples8(plane, firstX, y, samples);
    } else {
        writeOutputSamples16(plane, firstX, y, samples.xy);
    }
}
