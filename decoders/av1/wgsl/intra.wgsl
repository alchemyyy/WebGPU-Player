// AV1 intra family: every intra predictor (directional with edge filter and upsampling, smooth, Paeth, DC, chroma from luma,
// palette, and filter intra) and the intra wavefront's per-superblock job loop. Owner: av1-gpu-intra; scratch/av1/DESIGN.md specifies its
// functions, prefixes, and record fields.
// The reference is libaom v3.15.2 (BSD-2-Clause, decoders/licenses/libaom-LICENSE): av1_predict_intra_block() after its edge
// derivation (av1/common/reconintra.c), the predictors of aom_dsp/intrapred.c, and av1/common/cfl.c; the tables below name their sources.
// The lanes first decode a chunk of the superblock's jobs in parallel, one job each, into descriptors; then the jobs run one after
// another with all 64 lanes: a job's edges go to workgroup memory, a directional job filters and upsamples them there, and each lane
// predicts, adds the residual to, clips, and writes quads of four samples (two words of the frame store each).

// The lanes of the intra workgroups
const INTRA_LANES: u32 = 64u;
const INTRA_LANES_LOG2: u32 = 6u;
// The smallest plane block side, as libaom's set_plane_n4() keeps it, in log2 samples
const INTRA_MINIMUM_SIZE_LOG2: u32 = 2u;

// libaom's PREDICTION_MODE values (av1/common/enums.h); UV modes 0 to 12 are the same predictions
const INTRA_MODE_DC: u32 = 0u;
const INTRA_MODE_V: u32 = 1u;
const INTRA_MODE_H: u32 = 2u;
const INTRA_MODE_D45: u32 = 3u;
const INTRA_MODE_D135: u32 = 4u;
const INTRA_MODE_D113: u32 = 5u;
const INTRA_MODE_D157: u32 = 6u;
const INTRA_MODE_D203: u32 = 7u;
const INTRA_MODE_D67: u32 = 8u;
const INTRA_MODE_SMOOTH: u32 = 9u;
const INTRA_MODE_SMOOTH_V: u32 = 10u;
const INTRA_MODE_SMOOTH_H: u32 = 11u;
const INTRA_MODE_PAETH: u32 = 12u;
// UV_CFL_PRED: a DC_PRED prediction, then chroma from luma
const INTRA_UV_MODE_CFL: u32 = 13u;
// libaom's INTERINTRA_MODE values, which predict DC_PRED, V_PRED, H_PRED, and SMOOTH_PRED (interintra_to_intra_mode)
const INTRA_INTERINTRA_V: u32 = 1u;
const INTRA_INTERINTRA_H: u32 = 2u;
const INTRA_INTERINTRA_SMOOTH: u32 = 3u;

// Directional angles in degrees: ANGLE_STEP, and the angles of V_PRED and H_PRED (mode_to_angle_map, av1/common/blockd.h)
const INTRA_ANGLE_STEP: i32 = 3;
const INTRA_ANGLE_VERTICAL: i32 = 90;
const INTRA_ANGLE_HORIZONTAL: i32 = 180;
// The directional interpolation: positions in 1/64 sample, weights in 1/32
const INTRA_POSITION_BITS: u32 = 6u;
const INTRA_POSITION_MASK: i32 = 63;
const INTRA_INTERPOLATION_WEIGHT: i32 = 32;
const INTRA_INTERPOLATION_ROUNDING: i32 = 16;
const INTRA_INTERPOLATION_SHIFT: u32 = 5u;

// The edge filter and upsampler (av1_filter_intra_edge_c(), filter_intra_edge_corner(), av1_upsample_intra_edge_c()):
// 4-bit kernels and the corner kernel 5, 6, 5
const INTRA_EDGE_KERNEL_ROUNDING: i32 = 8;
const INTRA_EDGE_KERNEL_SHIFT: u32 = 4u;
const INTRA_EDGE_CORNER_OUTER_TAP: i32 = 5;
const INTRA_EDGE_CORNER_CENTER_TAP: i32 = 6;
// Corner filtering needs both block sides to sum to at least this
const INTRA_EDGE_CORNER_MINIMUM_SIZE: i32 = 24;
const INTRA_EDGE_FILTER_TAPS: i32 = 5;
const INTRA_UPSAMPLE_TAPS: i32 = 4;
const INTRA_UPSAMPLE_OUTER_TAP: i32 = -1;
const INTRA_UPSAMPLE_INNER_TAP: i32 = 9;
// An upsampled edge's even samples are the input samples, which this tap leaves exact through the kernel's rounding
const INTRA_UPSAMPLE_COPY_TAP: i32 = 16;

// SMOOTH_WEIGHT_LOG2_SCALE (aom_dsp/intrapred_common.h): smooth weights out of 256
const INTRA_SMOOTH_SCALE: i32 = 256;
const INTRA_SMOOTH_SHIFT: u32 = 8u;
const INTRA_SMOOTH_ROUNDING: i32 = 128;
// The smallest smooth block side, where the weights of a side start in smooth_weights
const INTRA_SMOOTH_FIRST_SIZE: u32 = 4u;

// libaom's rectangular DC divisions (aom_dsp/intrapred.c): multiply by these and shift by 17 for 1:2 and 1:4 blocks, exact for every bit depth
const INTRA_DC_MULTIPLIER_1X2: u32 = 0xAAABu;
const INTRA_DC_MULTIPLIER_1X4: u32 = 0x6667u;
const INTRA_DC_SHIFT: u32 = 17u;

// Filter intra (av1_filter_intra_predictor_c()): 4x2 output blocks, seven taps each, FILTER_INTRA_SCALE_BITS
const INTRA_FILTER_BLOCK_WIDTH_LOG2: u32 = 2u;
const INTRA_FILTER_BLOCK_HEIGHT_LOG2: u32 = 1u;
const INTRA_FILTER_OUTPUTS: u32 = 8u;
const INTRA_FILTER_OUTPUTS_LOG2: u32 = 3u;
const INTRA_FILTER_TAPS_PER_OUTPUT: u32 = 8u;
const INTRA_FILTER_ROUNDING: i32 = 8;
const INTRA_FILTER_SHIFT: u32 = 4u;

// Chroma from luma (av1/common/cfl.c): luma averages in Q3 per subsampling, and alpha times AC in Q6
const CFL_Q3_SHIFT_420: u32 = 1u;
const CFL_Q3_SHIFT_422: u32 = 2u;
const CFL_Q3_SHIFT_444: u32 = 3u;
const CFL_ALPHA_SHIFT: u32 = 6u;
// The buffer libaom stores is at least 2x2 chroma samples; the job holds its size in units of 2
const CFL_SIZE_UNIT: u32 = 2u;

// Palette color index maps: 4 bits per index, 8 per word; colors: 16 bits, 2 per word
const PALETTE_INDICES_PER_WORD_LOG2: u32 = 3u;
const PALETTE_INDEX_MASK: u32 = 15u;
const PALETTE_COLORS_PER_WORD_LOG2: u32 = 1u;

// What predicts a job's samples
const INTRA_PREDICTOR_FLAT: u32 = 0u;
const INTRA_PREDICTOR_VERTICAL: u32 = 1u;
const INTRA_PREDICTOR_HORIZONTAL: u32 = 2u;
const INTRA_PREDICTOR_SMOOTH: u32 = 3u;
const INTRA_PREDICTOR_SMOOTH_VERTICAL: u32 = 4u;
const INTRA_PREDICTOR_SMOOTH_HORIZONTAL: u32 = 5u;
const INTRA_PREDICTOR_PAETH: u32 = 6u;
const INTRA_PREDICTOR_ZONE_1: u32 = 7u;
const INTRA_PREDICTOR_ZONE_2: u32 = 8u;
const INTRA_PREDICTOR_ZONE_3: u32 = 9u;
const INTRA_PREDICTOR_FILTER: u32 = 10u;
const INTRA_PREDICTOR_PALETTE: u32 = 11u;
// The target already holds the prediction (IntraBC)
const INTRA_PREDICTOR_COPY: u32 = 12u;

// The intra tables in the frame data buffer's intra area, as words from INTRA_TABLES_OFFSET
const INTRA_TABLE_DERIVATIVES: u32 = 0u;
const INTRA_DERIVATIVE_COUNT: u32 = 90u;
const INTRA_TABLE_SMOOTH_WEIGHTS: u32 = 96u;
const INTRA_SMOOTH_WEIGHT_COUNT: u32 = 124u;
const INTRA_TABLE_FILTER_TAPS: u32 = 224u;
const INTRA_FILTER_TAP_COUNT: u32 = 320u;
const INTRA_TABLE_WORDS: u32 = 544u;

// dr_intra_derivative (av1/common/reconintra.h): the directional step per angle in degrees, 0 where no angle uses it
const INTRA_DERIVATIVES = array<u32, 90>(
    0u, 0u, 0u, 1023u, 0u, 0u, 547u, 0u, 0u, 372u, 0u, 0u, 0u, 0u, 273u, 0u, 0u, 215u, 0u, 0u, 178u, 0u, 0u, 151u, 0u, 0u, 132u, 0u, 0u, 116u,
    0u, 0u, 102u, 0u, 0u, 0u, 90u, 0u, 0u, 80u, 0u, 0u, 71u, 0u, 0u, 64u, 0u, 0u, 57u, 0u, 0u, 51u, 0u, 0u, 45u, 0u, 0u, 0u, 40u, 0u,
    0u, 35u, 0u, 0u, 31u, 0u, 0u, 27u, 0u, 0u, 23u, 0u, 0u, 19u, 0u, 0u, 15u, 0u, 0u, 0u, 0u, 11u, 0u, 0u, 7u, 0u, 0u, 3u, 0u, 0u
);

// smooth_weights (aom_dsp/intrapred_common.h): the weights of sides 4, 8, 16, 32, and 64, a side's first at its size minus 4
const INTRA_SMOOTH_WEIGHTS = array<u32, 124>(
    255u, 149u, 85u, 64u,
    255u, 197u, 146u, 105u, 73u, 50u, 37u, 32u,
    255u, 225u, 196u, 170u, 145u, 123u, 102u, 84u, 68u, 54u, 43u, 33u, 26u, 20u, 17u, 16u,
    255u, 240u, 225u, 210u, 196u, 182u, 169u, 157u, 145u, 133u, 122u, 111u, 101u, 92u, 83u, 74u,
    66u, 59u, 52u, 45u, 39u, 34u, 29u, 25u, 21u, 17u, 14u, 12u, 10u, 9u, 8u, 8u,
    255u, 248u, 240u, 233u, 225u, 218u, 210u, 203u, 196u, 189u, 182u, 176u, 169u, 163u, 156u, 150u,
    144u, 138u, 133u, 127u, 121u, 116u, 111u, 106u, 101u, 96u, 91u, 86u, 82u, 77u, 73u, 69u,
    65u, 61u, 57u, 54u, 50u, 47u, 44u, 41u, 38u, 35u, 32u, 29u, 27u, 25u, 22u, 20u,
    18u, 16u, 15u, 13u, 12u, 10u, 9u, 8u, 7u, 6u, 6u, 5u, 5u, 4u, 4u, 4u
);

// av1_filter_intra_taps (av1/common/reconintra.c): per filter intra mode and 4x2 output, the taps of the corner, the four samples above,
// and the two samples left (the eighth is 0)
const INTRA_FILTER_TAPS = array<i32, 320>(
    -6, 10, 0, 0, 0, 12, 0, 0, -5, 2, 10, 0, 0, 9, 0, 0, -3, 1, 1, 10, 0, 7, 0, 0, -3, 1, 1, 2, 10, 5, 0, 0,
    -4, 6, 0, 0, 0, 2, 12, 0, -3, 2, 6, 0, 0, 2, 9, 0, -3, 2, 2, 6, 0, 2, 7, 0, -3, 1, 2, 2, 6, 3, 5, 0,
    -10, 16, 0, 0, 0, 10, 0, 0, -6, 0, 16, 0, 0, 6, 0, 0, -4, 0, 0, 16, 0, 4, 0, 0, -2, 0, 0, 0, 16, 2, 0, 0,
    -10, 16, 0, 0, 0, 0, 10, 0, -6, 0, 16, 0, 0, 0, 6, 0, -4, 0, 0, 16, 0, 0, 4, 0, -2, 0, 0, 0, 16, 0, 2, 0,
    -8, 8, 0, 0, 0, 16, 0, 0, -8, 0, 8, 0, 0, 16, 0, 0, -8, 0, 0, 8, 0, 16, 0, 0, -8, 0, 0, 0, 8, 16, 0, 0,
    -4, 4, 0, 0, 0, 0, 16, 0, -4, 0, 4, 0, 0, 0, 16, 0, -4, 0, 0, 4, 0, 0, 16, 0, -4, 0, 0, 0, 4, 0, 16, 0,
    -2, 8, 0, 0, 0, 10, 0, 0, -1, 3, 8, 0, 0, 6, 0, 0, -1, 2, 3, 8, 0, 4, 0, 0, 0, 1, 2, 3, 8, 2, 0, 0,
    -1, 4, 0, 0, 0, 3, 10, 0, -1, 3, 4, 0, 0, 4, 6, 0, -1, 2, 3, 4, 0, 4, 4, 0, -1, 2, 2, 3, 4, 3, 3, 0,
    -12, 14, 0, 0, 0, 14, 0, 0, -10, 0, 14, 0, 0, 12, 0, 0, -9, 0, 0, 14, 0, 11, 0, 0, -8, 0, 0, 0, 14, 10, 0, 0,
    -10, 12, 0, 0, 0, 0, 14, 0, -9, 1, 12, 0, 0, 0, 12, 0, -8, 0, 0, 12, 0, 1, 11, 0, -7, 0, 0, 1, 12, 1, 9, 0
);

// A job's edge samples in workgroup memory: four regions (raw above, raw left, final above, final left), each holding samples
// -INTRA_EDGE_ORIGIN to INTRA_EDGE_REGION_SAMPLES - INTRA_EDGE_ORIGIN - 1 of its edge.
// Smooth predictions keep their column and row weights in the final regions, which they do not otherwise use.
const INTRA_EDGE_ORIGIN: i32 = 8;
const INTRA_EDGE_REGION_SAMPLES: u32 = 136u;
const INTRA_EDGE_ABOVE_RAW: u32 = 0u;
const INTRA_EDGE_LEFT_RAW: u32 = 1u;
const INTRA_EDGE_ABOVE_FINAL: u32 = 2u;
const INTRA_EDGE_LEFT_FINAL: u32 = 3u;
var<workgroup> intraEdges: array<i32, 544>;

// The edge lattice of a 64x64 superblock's plane in an intra-only frame: every sample a job of the superblock reads as an edge, so jobs
// take their edges from workgroup memory instead of the frame. Rows: line k is the bottom row of unit row k (y = 4k + 3), x 0 to 63, two
// samples per word. Columns: line k is the right column of unit column k (x = 4k + 3), y 0 to 63, a sample per word, since a word's two
// rows would come from different lanes. Above: the row above the superblock, x -2 to 127 (whole frame words); left: the column left of
// it, y 0 to 63, two samples per word. In an intra-only frame every unit an edge reads inside the superblock belongs to an earlier job
// (libaom's availability follows decode order), so the lattice always holds it. Inter frames, whose edges may be inter blocks, and
// 128x128 superblocks take every edge from the frame.
const INTRA_SUPERBLOCK_64_LOG2: u32 = 6u;
const INTRA_LATTICE_ROW_WORDS_LOG2: u32 = 5u;
const INTRA_LATTICE_COLUMN_WORDS_LOG2: u32 = 6u;
const INTRA_LATTICE_LEFT_WORDS: u32 = 32u;
const INTRA_LATTICE_ABOVE_WORDS: u32 = 65u;
// The above row's first sample, x = -2, so its words are the frame's
const INTRA_LATTICE_ABOVE_ORIGIN: i32 = 2;
// A unit's last sample in its row or column, the one the lattice lines hold
const INTRA_UNIT_LAST_SAMPLE: u32 = 3u;
var<workgroup> intraLatticeRows: array<u32, 512>;
var<workgroup> intraLatticeColumns: array<u32, 1024>;
var<workgroup> intraLatticeAbove: array<u32, 65>;
var<workgroup> intraLatticeLeft: array<u32, 32>;
// DC_PRED sums its edges sixteen samples a step, as four quads; every block side is a multiple of 4
const INTRA_DC_STEP_SAMPLES: i32 = 16;
const INTRA_QUAD_SAMPLES: i32 = 4;
// The output pass takes quads of four samples of a row
const INTRA_QUAD_SAMPLES_LOG2: u32 = 2u;
// The taps a zone 2 sample may read on either edge, so the path it does not take still reads inside its region
const INTRA_EDGE_LOWEST_TAP: i32 = -2;
const INTRA_EDGE_HIGHEST_TAP: i32 = 126;

// The filter intra outputs or libaom's CFL buffer (recon_buf_q3), 32 x 32 at row stride 32, then the CFL partial sums, one per lane
const INTRA_BLOCK_STRIDE_LOG2: u32 = 5u;
const CFL_PARTIAL_SUMS: u32 = 1024u;
var<workgroup> intraBlock: array<i32, 1088>;

// Job descriptors: the jobs of a chunk of a superblock's list, each decoded by one lane (intraDecodeJob), so the sequential job loop only
// unpacks fields. Per job, two vectors: the job (x4 and y4, the extent's log2 sizes, the residual bit; the flags; the record's edges word;
// the block index) and its details (the directional steps or CFL's alpha and stored size; the palette's colors and map words; the map's
// width and the job's offset in it).
const INTRA_CHUNK_JOBS: u32 = 64u;
var<workgroup> intraDescriptors: array<array<vec4u, 2>, 64>;
// The job vector's position word
const INTRA_DESCRIPTOR_X4_SHIFT: u32 = 0u;
const INTRA_DESCRIPTOR_Y4_SHIFT: u32 = 12u;
const INTRA_DESCRIPTOR_COORDINATE_BITS: u32 = 12u;
const INTRA_DESCRIPTOR_WIDTH_SHIFT: u32 = 24u;
const INTRA_DESCRIPTOR_HEIGHT_SHIFT: u32 = 27u;
const INTRA_DESCRIPTOR_SIZE_BITS: u32 = 3u;
const INTRA_DESCRIPTOR_RESIDUAL_SHIFT: u32 = 30u;
// The job vector's flags word: the predictor, the job kind, and the phases and options the job takes
const INTRA_FLAG_PREDICTOR_BITS: u32 = 4u;
const INTRA_FLAG_KIND_SHIFT: u32 = 4u;
const INTRA_FLAG_NEEDS_ABOVE: u32 = 6u;
const INTRA_FLAG_NEEDS_LEFT: u32 = 7u;
const INTRA_FLAG_LOADS_EDGES: u32 = 8u;
const INTRA_FLAG_COMPUTES_DC: u32 = 9u;
const INTRA_FLAG_FILLS_FLAT: u32 = 10u;
const INTRA_FLAG_CHANGES_EDGES: u32 = 11u;
const INTRA_FLAG_FILTERS_CORNER: u32 = 12u;
const INTRA_FLAG_UPSAMPLES_ABOVE: u32 = 13u;
const INTRA_FLAG_UPSAMPLES_LEFT: u32 = 14u;
const INTRA_FLAG_ABOVE_STRENGTH_SHIFT: u32 = 15u;
const INTRA_FLAG_LEFT_STRENGTH_SHIFT: u32 = 17u;
const INTRA_FLAG_STRENGTH_BITS: u32 = 2u;
const INTRA_FLAG_USES_CFL: u32 = 19u;
const INTRA_FLAG_SMOOTH_WEIGHTS: u32 = 20u;
const INTRA_FLAG_FILTER_MODE_SHIFT: u32 = 21u;
const INTRA_FLAG_NEEDS_RIGHT: u32 = 24u;
const INTRA_FLAG_NEEDS_BOTTOM: u32 = 25u;
// The details vector's first word: the directional steps, or CFL's biased alpha and stored width and height
const INTRA_DETAIL_STEP_BITS: u32 = 11u;
const INTRA_DETAIL_STEP_Y_SHIFT: u32 = 11u;
const INTRA_DETAIL_CFL_WIDTH_SHIFT: u32 = 8u;
const INTRA_DETAIL_CFL_HEIGHT_SHIFT: u32 = 16u;
const INTRA_DETAIL_FIELD_BITS: u32 = 8u;
// The details vector's last word: the palette map's width and the job's offset in it
const INTRA_DETAIL_PALETTE_OFFSET_X_SHIFT: u32 = 8u;
const INTRA_DETAIL_PALETTE_OFFSET_Y_SHIFT: u32 = 16u;

// Writes the intra tables into the frame data buffer's intra area; loadTables calls it from workgroups 0 to 63
fn intraLoadTables(workgroupIndex: u32, lane: u32) {
    let index = workgroupIndex * INTRA_LANES + lane;
    if (index >= INTRA_TABLE_WORDS) {
        return;
    }
    var value = 0u;
    if (index < INTRA_TABLE_DERIVATIVES + INTRA_DERIVATIVE_COUNT) {
        value = INTRA_DERIVATIVES[index - INTRA_TABLE_DERIVATIVES];
    } else if (index >= INTRA_TABLE_SMOOTH_WEIGHTS && index < INTRA_TABLE_SMOOTH_WEIGHTS + INTRA_SMOOTH_WEIGHT_COUNT) {
        value = INTRA_SMOOTH_WEIGHTS[index - INTRA_TABLE_SMOOTH_WEIGHTS];
    } else if (index >= INTRA_TABLE_FILTER_TAPS && index < INTRA_TABLE_FILTER_TAPS + INTRA_FILTER_TAP_COUNT) {
        value = bitcast<u32>(INTRA_FILTER_TAPS[index - INTRA_TABLE_FILTER_TAPS]);
    }
    frameData[getTablesOffset() + INTRA_TABLES_OFFSET + index] = value;
}

// Reconstructs a superblock's intra jobs of one plane in decode order, all 64 lanes together.
// superblockIndex and plane must be workgroup uniform: every job synchronizes the workgroup.
fn intraReconstructSuperblock(superblockIndex: u32, plane: u32, lane: u32) {
    let listWord = RECORD_SUPERBLOCK_JOBS_Y + plane * (RECORD_SUPERBLOCK_JOBS_U - RECORD_SUPERBLOCK_JOBS_Y);
    let firstJob = readSuperblockWord(superblockIndex, listWord);
    let jobCount = readSuperblockWord(superblockIndex, listWord + 1u);
    if (jobCount == 0u) {
        return;
    }
    // The plane's first words in the target and scratch buffers, and the target's luma for chroma from luma
    let targetBuffer = readRecordWord(RECORD_HEADER_TARGET_BUFFER);
    let planeBases = vec3u(getStoreWordIndex(targetBuffer, plane, 0u, 0u),
        getStoreWordIndex(readRecordWord(RECORD_HEADER_SCRATCH_BUFFER), plane, 0u, 0u), getStoreWordIndex(targetBuffer, PLANE_Y, 0u, 0u));
    let frame = vec4u(readRecordWord(RECORD_HEADER_BIT_DEPTH), readRecordWord(RECORD_HEADER_SUBSAMPLING_X),
        readRecordWord(RECORD_HEADER_SUBSAMPLING_Y), readRecordWord(RECORD_HEADER_FLAGS));
    // The superblock's origin in the plane, and whether its edges come from the lattice (64x64 superblocks of intra-only frames)
    let superblockColumns = readRecordWord(RECORD_HEADER_SUPERBLOCK_COLUMNS);
    let isChroma = plane != PLANE_Y;
    let usesLattice = ((frame.w >> RECORD_FLAG_INTRA_ONLY) & 1u) != 0u && ((frame.w >> RECORD_FLAG_SUPERBLOCK_128) & 1u) == 0u;
    let lattice = vec3u(((superblockIndex % superblockColumns) << INTRA_SUPERBLOCK_64_LOG2) >> select(0u, frame.y, isChroma),
        ((superblockIndex / superblockColumns) << INTRA_SUPERBLOCK_64_LOG2) >> select(0u, frame.z, isChroma), select(0u, 1u, usesLattice));
    // The lattice's boundary loads into registers now and into workgroup memory after the first chunk's decode, so their latencies overlap
    var boundary = vec3u(0u);
    if (lattice.z != 0u) {
        boundary = intraLoadLatticeBoundary(lattice.xy, plane, lane, planeBases.x);
    }
    for (var chunkStart = 0u; chunkStart < jobCount; chunkStart += INTRA_CHUNK_JOBS) {
        // Every lane decodes one job of the chunk, so no job waits on its record or its decisions
        let chunkJobs = min(jobCount - chunkStart, INTRA_CHUNK_JOBS);
        if (lane < chunkJobs) {
            intraDecodeJob(firstJob + chunkStart + lane, lane, plane, frame);
        }
        if (chunkStart == 0u && lattice.z != 0u) {
            intraStoreLatticeBoundary(boundary, lane);
        }
        workgroupBarrier();
        for (var slot = 0u; slot < chunkJobs; slot += 1u) {
            let descriptor = workgroupUniformLoad(&intraDescriptors[slot]);
            intraRunJob(descriptor[0], descriptor[1], plane, lane, planeBases, frame, lattice);
            // The next job reads this one's samples as edges, from the lattice or, for 128x128 superblocks, from the frame
            if (lattice.z == 0u) {
                storageBarrier();
            }
            workgroupBarrier();
        }
    }
}

// A lane's words of a superblock's lattice boundary at origin in the plane, read from the frame where they exist (zero elsewhere, which
// no edge reads): the row above the superblock's words lane and, for lane 0, its last word, and the column left of it's word lane
fn intraLoadLatticeBoundary(origin: vec2u, plane: u32, lane: u32, targetBase: u32) -> vec3u {
    let planeWidth = getStorePlaneWidth(plane);
    let planeHeight = getStorePlaneHeight(plane);
    let rowWords = planeWidth >> SAMPLE_PAIR_SHIFT;
    var boundary = vec3u(0u);
    if (origin.y > 0u) {
        // Word w holds x = origin.x - 2 + 2w and the next sample, the frame word origin.x / 2 - 1 + w
        let rowBase = targetBase + (origin.y - 1u) * rowWords;
        let firstFrameWord = origin.x >> SAMPLE_PAIR_SHIFT;
        if (firstFrameWord + lane >= 1u && firstFrameWord + lane - 1u < rowWords) {
            boundary.x = frames[rowBase + firstFrameWord + lane - 1u];
        }
        let lastWord = INTRA_LATTICE_ABOVE_WORDS - 1u;
        if (lane == 0u && firstFrameWord + lastWord - 1u < rowWords) {
            boundary.y = frames[rowBase + firstFrameWord + lastWord - 1u];
        }
    }
    if (origin.x > 0u && lane < INTRA_LATTICE_LEFT_WORDS) {
        // The samples at x = origin.x - 1, odd, are the frame words' second halves
        let column = (origin.x - 1u) >> SAMPLE_PAIR_SHIFT;
        let y = origin.y + (lane << SAMPLE_PAIR_SHIFT);
        if (y < planeHeight) {
            boundary.z = frames[targetBase + y * rowWords + column] >> SAMPLE_HALF_BITS;
        }
        if (y + 1u < planeHeight) {
            boundary.z |= frames[targetBase + (y + 1u) * rowWords + column] & (SAMPLE_HALF_MASK << SAMPLE_HALF_BITS);
        }
    }
    return boundary;
}

// Writes a lane's lattice boundary words (intraLoadLatticeBoundary) into workgroup memory
fn intraStoreLatticeBoundary(boundary: vec3u, lane: u32) {
    intraLatticeAbove[lane] = boundary.x;
    if (lane == 0u) {
        intraLatticeAbove[INTRA_LATTICE_ABOVE_WORDS - 1u] = boundary.y;
    }
    if (lane < INTRA_LATTICE_LEFT_WORDS) {
        intraLatticeLeft[lane] = boundary.z;
    }
}

// A sample of a word of two, at an even or odd position
fn intraUnpackSample(word: u32, position: u32) -> i32 {
    return i32((word >> ((position & 1u) * SAMPLE_HALF_BITS)) & SAMPLE_HALF_MASK);
}

// A sample (x, y) of the row above a job (y its top - 1, x from its left - 1, the corner), for a job of the superblock lattice describes
// (its origin, and whether it uses the lattice): the boundary row above the superblock, the boundary column left of it for the corner of
// a job at the superblock's left, or the lattice row of the unit row above; else the frame's
fn intraReadAboveEdge(x: u32, y: u32, lattice: vec3u, targetBase: u32, rowWords: u32) -> i32 {
    if (lattice.z == 0u) {
        return intraReadSample(targetBase, rowWords, x, y);
    }
    let relativeX = i32(x) - i32(lattice.x);
    if (y < lattice.y) {
        let index = u32(relativeX + INTRA_LATTICE_ABOVE_ORIGIN);
        return intraUnpackSample(intraLatticeAbove[index >> SAMPLE_PAIR_SHIFT], index);
    }
    let relativeY = y - lattice.y;
    if (relativeX < 0) {
        return intraUnpackSample(intraLatticeLeft[relativeY >> SAMPLE_PAIR_SHIFT], relativeY);
    }
    return intraUnpackSample(intraLatticeRows[((relativeY >> MI_SIZE_LOG2) << INTRA_LATTICE_ROW_WORDS_LOG2) + (u32(relativeX) >> SAMPLE_PAIR_SHIFT)],
        u32(relativeX));
}

// A sample (x, y) of the column left of a job (x its left - 1, y from its top): the boundary column left of the superblock or the lattice
// column of the unit column left, in lattice mode; else the frame's
fn intraReadLeftEdge(x: u32, y: u32, lattice: vec3u, targetBase: u32, rowWords: u32) -> i32 {
    if (lattice.z == 0u) {
        return intraReadSample(targetBase, rowWords, x, y);
    }
    let relativeY = y - lattice.y;
    if (x < lattice.x) {
        return intraUnpackSample(intraLatticeLeft[relativeY >> SAMPLE_PAIR_SHIFT], relativeY);
    }
    return i32(intraLatticeColumns[(((x - lattice.x) >> MI_SIZE_LOG2) << INTRA_LATTICE_COLUMN_WORDS_LOG2) + relativeY]);
}

// Writes an output quad at superblock-relative (relativeX, relativeY), a multiple of 4 across, into the lattice: the quad when it is a
// unit's last row, and its last sample, a unit's last column
fn intraWriteLattice(relativeX: u32, relativeY: u32, values: vec4u) {
    if ((relativeY & INTRA_UNIT_LAST_SAMPLE) == INTRA_UNIT_LAST_SAMPLE) {
        let rowWord = ((relativeY >> MI_SIZE_LOG2) << INTRA_LATTICE_ROW_WORDS_LOG2) + (relativeX >> SAMPLE_PAIR_SHIFT);
        intraLatticeRows[rowWord] = values.x | (values.y << SAMPLE_HALF_BITS);
        intraLatticeRows[rowWord + 1u] = values.z | (values.w << SAMPLE_HALF_BITS);
    }
    intraLatticeColumns[((relativeX >> MI_SIZE_LOG2) << INTRA_LATTICE_COLUMN_WORDS_LOG2) + relativeY] = values.w;
}

// Whether a bit of a flags word is set
fn intraHasFlag(flags: u32, flag: u32) -> bool {
    return ((flags >> flag) & 1u) != 0u;
}

// Reads a sample of a plane whose first word is planeBase, as a signed value
fn intraReadSample(planeBase: u32, rowWords: u32, x: u32, y: u32) -> i32 {
    let word = frames[planeBase + y * rowWords + (x >> SAMPLE_PAIR_SHIFT)];
    return i32((word >> ((x & 1u) * SAMPLE_HALF_BITS)) & SAMPLE_HALF_MASK);
}

// mode_to_angle_map (av1/common/blockd.h) for the directional modes
fn intraGetBaseAngle(mode: u32) -> i32 {
    switch (mode) {
        case INTRA_MODE_V: { return 90; }
        case INTRA_MODE_H: { return 180; }
        case INTRA_MODE_D45: { return 45; }
        case INTRA_MODE_D135: { return 135; }
        case INTRA_MODE_D113: { return 113; }
        case INTRA_MODE_D157: { return 157; }
        case INTRA_MODE_D203: { return 203; }
        case INTRA_MODE_D67: { return 67; }
        default: { return 0; }
    }
}

// interintra_to_intra_mode (av1/common/reconintra.h)
fn intraGetInterIntraMode(interIntraMode: u32) -> u32 {
    switch (interIntraMode) {
        case INTRA_INTERINTRA_V: { return INTRA_MODE_V; }
        case INTRA_INTERINTRA_H: { return INTRA_MODE_H; }
        case INTRA_INTERINTRA_SMOOTH: { return INTRA_MODE_SMOOTH; }
        default: { return INTRA_MODE_DC; }
    }
}

// libaom's intra_edge_filter_strength() (av1/common/reconintra.c): 0 to 3 for the block's sides, the angle's distance from the edge's
// own direction, and the edge filter type (1 when a neighbor predicts smoothly); the thresholds are libaom's
fn intraGetEdgeFilterStrength(firstSize: i32, secondSize: i32, delta: i32, filterType: u32) -> u32 {
    let angleDistance = abs(delta);
    let sizeSum = firstSize + secondSize;
    var strength = 0u;
    if (filterType == 0u) {
        if (sizeSum <= 8) {
            if (angleDistance >= 56) { strength = 1u; }
        } else if (sizeSum <= 16) {
            if (angleDistance >= 40) { strength = 1u; }
        } else if (sizeSum <= 24) {
            if (angleDistance >= 8) { strength = 1u; }
            if (angleDistance >= 16) { strength = 2u; }
            if (angleDistance >= 32) { strength = 3u; }
        } else if (sizeSum <= 32) {
            if (angleDistance >= 1) { strength = 1u; }
            if (angleDistance >= 4) { strength = 2u; }
            if (angleDistance >= 32) { strength = 3u; }
        } else {
            if (angleDistance >= 1) { strength = 3u; }
        }
    } else {
        if (sizeSum <= 8) {
            if (angleDistance >= 40) { strength = 1u; }
            if (angleDistance >= 64) { strength = 2u; }
        } else if (sizeSum <= 16) {
            if (angleDistance >= 20) { strength = 1u; }
            if (angleDistance >= 48) { strength = 2u; }
        } else if (sizeSum <= 24) {
            if (angleDistance >= 4) { strength = 3u; }
        } else {
            if (angleDistance >= 1) { strength = 3u; }
        }
    }
    return strength;
}

// libaom's av1_use_intra_edge_upsample() (av1/common/reconintra.h); the size limits are libaom's
fn intraUsesUpsampling(firstSize: i32, secondSize: i32, delta: i32, filterType: u32) -> bool {
    let angleDistance = abs(delta);
    if (angleDistance == 0 || angleDistance >= 40) {
        return false;
    }
    return firstSize + secondSize <= select(16, 8, filterType == 1u);
}

// A tap of av1_filter_intra_edge_c()'s kernels { 0, 4, 8, 4, 0 }, { 0, 5, 6, 5, 0 }, { 2, 4, 4, 4, 2 } for strength 1 to 3
fn intraGetEdgeKernelTap(strength: u32, tap: i32) -> i32 {
    let tapDistance = abs(tap - 2);
    switch (strength) {
        case 1u: { return select(select(0, 4, tapDistance == 1), 8, tapDistance == 0); }
        case 2u: { return select(select(0, 5, tapDistance == 1), 6, tapDistance == 0); }
        default: { return select(4, 2, tapDistance == 2); }
    }
}

// An edge sample after libaom's corner filter and av1_filter_intra_edge_c(): sample index of the edge whose raw samples start at rawBase,
// the corner (index -1) already filtered, and the filter covering filterCount samples from the corner (none at strength 0)
fn intraGetFilteredEdgeSample(rawBase: i32, index: i32, strength: u32, filterCount: i32, corner: i32) -> i32 {
    if (index < 0) {
        return corner;
    }
    if (strength == 0u || index > filterCount - 2) {
        return intraEdges[rawBase + index];
    }
    // libaom filters p = edge - 1 in place from a copy: p[0] is the corner, p[k] is sample k - 1, clamped to the filtered run
    var sum = 0;
    for (var tap = 0; tap < INTRA_EDGE_FILTER_TAPS; tap += 1) {
        let edgeIndex = clamp(index - 1 + tap, 0, filterCount - 1);
        let sample = select(intraEdges[rawBase + edgeIndex - 1], corner, edgeIndex == 0);
        sum += intraGetEdgeKernelTap(strength, tap) * sample;
    }
    return (sum + INTRA_EDGE_KERNEL_ROUNDING) >> INTRA_EDGE_KERNEL_SHIFT;
}

// libaom's DC_PRED average of both edges: a shift for square blocks, the exact multiply and shift for 1:2 and 1:4 ones
fn intraDivideDc(sum: i32, widthLog2: u32, heightLog2: u32) -> i32 {
    let rounded = u32(sum + (((1 << widthLog2) + (1 << heightLog2)) >> 1u));
    if (widthLog2 == heightLog2) {
        return i32(rounded >> (widthLog2 + 1u));
    }
    let multiplier = select(INTRA_DC_MULTIPLIER_1X4, INTRA_DC_MULTIPLIER_1X2, widthLog2 + 1u == heightLog2 || heightLog2 + 1u == widthLog2);
    return i32(((rounded >> min(widthLog2, heightLog2)) * multiplier) >> INTRA_DC_SHIFT);
}

// libaom's paeth_predictor_single() (aom_dsp/intrapred.c) for four samples of a row
fn intraPaethQuad(left: i32, top: vec4<i32>, topLeft: i32) -> vec4<i32> {
    let base = top + (left - topLeft);
    let leftDistances = abs(base - left);
    let topDistances = abs(base - top);
    let topLeftDistances = abs(base - topLeft);
    let picksLeft = (leftDistances <= topDistances) & (leftDistances <= topLeftDistances);
    return select(select(vec4<i32>(topLeft), top, topDistances <= topLeftDistances), vec4<i32>(left), picksLeft);
}

// Four consecutive samples of the edge regions
fn intraLoadEdgeQuad(first: i32) -> vec4<i32> {
    return vec4<i32>(intraEdges[first], intraEdges[first + 1], intraEdges[first + 2], intraEdges[first + 3]);
}

// The edge samples at four taps of an edge region
fn intraGatherEdges(base: i32, taps: vec4<i32>) -> vec4<i32> {
    return vec4<i32>(intraEdges[base + taps.x], intraEdges[base + taps.y], intraEdges[base + taps.z], intraEdges[base + taps.w]);
}

// libaom's directional interpolation of two taps, the second weighted by shifts in 1/32
fn intraInterpolate(first: vec4<i32>, second: vec4<i32>, shifts: vec4<i32>) -> vec4<i32> {
    return (first * (INTRA_INTERPOLATION_WEIGHT - shifts) + second * shifts + INTRA_INTERPOLATION_ROUNDING) >> vec4u(INTRA_INTERPOLATION_SHIFT);
}

// The sum of an edge run's first count samples (a multiple of 4), sixteen independent reads a step; reads past count stay inside the
// region and are masked
fn intraSumEdgeRun(first: i32, count: i32) -> i32 {
    var total = vec4<i32>(0);
    for (var offset = 0; offset < count; offset += INTRA_DC_STEP_SAMPLES) {
        let quad1 = select(vec4<i32>(0), intraLoadEdgeQuad(first + offset + INTRA_QUAD_SAMPLES), offset + INTRA_QUAD_SAMPLES < count);
        let quad2 = select(vec4<i32>(0), intraLoadEdgeQuad(first + offset + 2 * INTRA_QUAD_SAMPLES), offset + 2 * INTRA_QUAD_SAMPLES < count);
        let quad3 = select(vec4<i32>(0), intraLoadEdgeQuad(first + offset + 3 * INTRA_QUAD_SAMPLES), offset + 3 * INTRA_QUAD_SAMPLES < count);
        total += intraLoadEdgeQuad(first + offset) + quad1 + quad2 + quad3;
    }
    return total.x + total.y + total.z + total.w;
}

// Four samples of two frame store words
fn intraUnpackSamples(words: vec2u) -> vec4<i32> {
    return vec4<i32>(vec4u(words.x & SAMPLE_HALF_MASK, words.x >> SAMPLE_HALF_BITS, words.y & SAMPLE_HALF_MASK, words.y >> SAMPLE_HALF_BITS));
}

// Four signed 16-bit residuals of two scratch buffer words
fn intraUnpackResiduals(words: vec2u) -> vec4<i32> {
    return vec4<i32>(bitcast<i32>(words.x << SAMPLE_HALF_BITS) >> SAMPLE_HALF_BITS, bitcast<i32>(words.x) >> SAMPLE_HALF_BITS,
        bitcast<i32>(words.y << SAMPLE_HALF_BITS) >> SAMPLE_HALF_BITS, bitcast<i32>(words.y) >> SAMPLE_HALF_BITS);
}

// The residual words of a job's quad quadIndex in the scratch plane whose first word is residualBase, or zeros past the job or the plane.
// extent holds the job's origin, its quad count, and its quads per row in log2; plane holds the plane's width, height, and row words.
fn intraLoadResidualQuad(residualBase: u32, quadIndex: u32, extent: vec4u, plane: vec3u) -> vec2u {
    let x = extent.x + ((quadIndex & ((1u << extent.w) - 1u)) << INTRA_QUAD_SAMPLES_LOG2);
    let y = extent.y + (quadIndex >> extent.w);
    if (quadIndex >= extent.z || x >= plane.x || y >= plane.y) {
        return vec2u(0u);
    }
    let residualIndex = residualBase + y * plane.z + (x >> SAMPLE_PAIR_SHIFT);
    return vec2u(frames[residualIndex], frames[residualIndex + select(0u, 1u, x + (1u << SAMPLE_PAIR_SHIFT) < plane.x)]);
}

// A palette color by its index: 16 bits, two per record word from colorsWord
fn paletteReadColor(colorsWord: u32, colorIndex: u32) -> i32 {
    return i32((readRecordWord(colorsWord + (colorIndex >> PALETTE_COLORS_PER_WORD_LOG2)) >> ((colorIndex & 1u) * SAMPLE_HALF_BITS)) & SAMPLE_HALF_MASK);
}

// libaom's cfl_luma_subsampling_*_hbd_c() for one sample of the CFL buffer: the luma at the chroma sample, in Q3
fn cflGetLumaQ3(lumaBase: u32, lumaRowWords: u32, lumaX: u32, lumaY: u32, subsamplingX: u32, subsamplingY: u32) -> i32 {
    let word = frames[lumaBase + lumaY * lumaRowWords + (lumaX >> SAMPLE_PAIR_SHIFT)];
    if (subsamplingX == 0u) {
        return i32((word >> ((lumaX & 1u) * SAMPLE_HALF_BITS)) & SAMPLE_HALF_MASK) << CFL_Q3_SHIFT_444;
    }
    let pairSum = i32(word & SAMPLE_HALF_MASK) + i32(word >> SAMPLE_HALF_BITS);
    if (subsamplingY == 0u) {
        return pairSum << CFL_Q3_SHIFT_422;
    }
    let below = frames[lumaBase + (lumaY + 1u) * lumaRowWords + (lumaX >> SAMPLE_PAIR_SHIFT)];
    return (pairSum + i32(below & SAMPLE_HALF_MASK) + i32(below >> SAMPLE_HALF_BITS)) << CFL_Q3_SHIFT_420;
}

// A sample filter intra reads at row and column of libaom's 33 x 33 buffer: row 0 is the above edge from the corner, column 0 the left edge
fn intraGetFilterSource(aboveBase: i32, leftBase: i32, row: i32, column: i32) -> i32 {
    if (row == 0) {
        return intraEdges[aboveBase + column - 1];
    }
    if (column == 0) {
        return intraEdges[leftBase + row - 1];
    }
    return intraBlock[((row - 1) << INTRA_BLOCK_STRIDE_LOG2) + column - 1];
}

// Decodes an intra job of the record into the descriptor pair of a slot (scratch/av1/DESIGN.md 6.2): its extent, its predictor and the
// phases it takes (libaom's edge needs, flat fill, DC, edge filter and upsampling decisions, CFL, palette, filter intra), and the values
// those phases read from the record and the tables. frame holds the bit depth, subsampling, and header flags.
fn intraDecodeJob(jobIndex: u32, slot: u32, plane: u32, frame: vec4u) {
    let positionWord = readIntraJobWord(jobIndex, RECORD_INTRA_JOB_POSITION);
    let blockWord = readIntraJobWord(jobIndex, RECORD_INTRA_JOB_BLOCK);
    let edgesWord = readIntraJobWord(jobIndex, RECORD_INTRA_JOB_EDGES);
    let x4 = getField(positionWord, RECORD_INTRA_JOB_X4_SHIFT, RECORD_INTRA_JOB_COORDINATE_BITS);
    let y4 = getField(positionWord, RECORD_INTRA_JOB_Y4_SHIFT, RECORD_INTRA_JOB_COORDINATE_BITS);
    let originX = x4 << MI_SIZE_LOG2;
    let originY = y4 << MI_SIZE_LOG2;
    let transformSize = getField(positionWord, RECORD_INTRA_JOB_TX_SIZE_SHIFT, RECORD_INTRA_JOB_TX_SIZE_BITS);
    let hasResidual = positionWord >> RECORD_INTRA_JOB_HAS_RESIDUAL_SHIFT;
    let blockIndex = getField(blockWord, 0u, RECORD_INTRA_JOB_BLOCK_INDEX_BITS);
    let kind = getField(blockWord, RECORD_INTRA_JOB_KIND_SHIFT, RECORD_INTRA_JOB_KIND_BITS);
    let blockPosition = readBlockWord(blockIndex, RECORD_BLOCK_POSITION);
    let blockSize = getField(blockPosition, RECORD_BLOCK_SIZE_SHIFT, RECORD_BLOCK_SIZE_BITS);
    let modes = readBlockWord(blockIndex, RECORD_BLOCK_MODES);
    let extension = readBlockWord(blockIndex, RECORD_BLOCK_EXTENSION);
    let isChroma = plane != PLANE_Y;
    let subsamplingX = select(0u, frame.y, isChroma);
    let subsamplingY = select(0u, frame.z, isChroma);
    let tablesBase = getTablesOffset() + INTRA_TABLES_OFFSET;

    // The extent: the transform size, or for IntraBC the plane block, at least 4x4 as libaom's set_plane_n4() keeps it
    var widthLog2 = getTransformWidthLog2(transformSize);
    var heightLog2 = getTransformHeightLog2(transformSize);
    if (kind == RECORD_INTRA_JOB_KIND_INTRABC) {
        widthLog2 = max(getBlockWidthLog2(blockSize) - subsamplingX, INTRA_MINIMUM_SIZE_LOG2);
        heightLog2 = max(getBlockHeightLog2(blockSize) - subsamplingY, INTRA_MINIMUM_SIZE_LOG2);
    }
    let width = 1 << widthLog2;
    let height = 1 << heightLog2;

    // The prediction mode and its options
    var mode = INTRA_MODE_DC;
    var angleDelta = 0;
    var filterIntraMode = RECORD_BLOCK_FILTER_INTRA_NONE;
    var usesCfl = false;
    var usesPalette = false;
    var paletteColors = 0u;
    var paletteMap = 0u;
    var paletteMapWidth = 0u;
    var paletteOffsetX = 0u;
    var paletteOffsetY = 0u;
    if (kind == RECORD_INTRA_JOB_KIND_TRANSFORM) {
        if (isChroma) {
            let chromaMode = getField(modes, RECORD_BLOCK_UV_MODE_SHIFT, RECORD_BLOCK_UV_MODE_BITS);
            usesCfl = chromaMode == INTRA_UV_MODE_CFL;
            mode = select(chromaMode, INTRA_MODE_DC, usesCfl);
            angleDelta = (i32(getField(modes, RECORD_BLOCK_ANGLE_DELTA_UV_SHIFT, RECORD_BLOCK_ANGLE_DELTA_BITS)) - i32(RECORD_BLOCK_ANGLE_DELTA_BIAS)) * INTRA_ANGLE_STEP;
        } else {
            mode = getField(modes, RECORD_BLOCK_Y_MODE_SHIFT, RECORD_BLOCK_Y_MODE_BITS);
            angleDelta = (i32(getField(modes, RECORD_BLOCK_ANGLE_DELTA_Y_SHIFT, RECORD_BLOCK_ANGLE_DELTA_BITS)) - i32(RECORD_BLOCK_ANGLE_DELTA_BIAS)) * INTRA_ANGLE_STEP;
            filterIntraMode = getField(modes, RECORD_BLOCK_FILTER_INTRA_SHIFT, RECORD_BLOCK_FILTER_INTRA_BITS);
        }
        if (((extension >> RECORD_BLOCK_HAS_PALETTE_SHIFT) & 1u) != 0u) {
            // The palette extension follows any other extension of the block
            var paletteBase = readRecordWord(RECORD_HEADER_SIDE_DATA) + getField(extension, 0u, RECORD_BLOCK_EXTENSION_OFFSET_BITS);
            paletteBase += select(0u, RECORD_MOTION_WORDS, ((extension >> RECORD_BLOCK_HAS_MOTION_SHIFT) & 1u) != 0u);
            paletteBase += select(0u, RECORD_LOCAL_WARP_WORDS, ((extension >> RECORD_BLOCK_HAS_LOCAL_WARP_SHIFT) & 1u) != 0u);
            paletteBase += select(0u, RECORD_VARIABLE_TX_WORDS, ((extension >> RECORD_BLOCK_HAS_VARIABLE_TX_SHIFT) & 1u) != 0u);
            let paletteSizes = readRecordWord(paletteBase + RECORD_PALETTE_SIZES);
            let lumaPaletteSize = getField(paletteSizes, RECORD_PALETTE_SIZE_Y_SHIFT, RECORD_PALETTE_SIZE_BITS);
            let chromaPaletteSize = getField(paletteSizes, RECORD_PALETTE_SIZE_UV_SHIFT, RECORD_PALETTE_SIZE_BITS);
            usesPalette = select(lumaPaletteSize, chromaPaletteSize, isChroma) > 0u;
            if (usesPalette) {
                // The plane block as libaom's set_plane_n4() and setup_pred_plane() place it: a 4-sample side of a subsampled plane
                // belongs to its pair's chroma block, which starts at the even mode info position
                let lumaWidthLog2 = getBlockWidthLog2(blockSize);
                let lumaHeightLog2 = getBlockHeightLog2(blockSize);
                var modeInfoRow = getField(blockPosition, RECORD_BLOCK_MI_ROW_SHIFT, RECORD_BLOCK_MI_BITS);
                var modeInfoColumn = getField(blockPosition, RECORD_BLOCK_MI_COLUMN_SHIFT, RECORD_BLOCK_MI_BITS);
                if (subsamplingY != 0u && lumaHeightLog2 == MI_SIZE_LOG2) {
                    modeInfoRow &= ~1u;
                }
                if (subsamplingX != 0u && lumaWidthLog2 == MI_SIZE_LOG2) {
                    modeInfoColumn &= ~1u;
                }
                paletteMapWidth = 1u << max(lumaWidthLog2 - subsamplingX, INTRA_MINIMUM_SIZE_LOG2);
                paletteOffsetX = originX - ((modeInfoColumn << MI_SIZE_LOG2) >> subsamplingX);
                paletteOffsetY = originY - ((modeInfoRow << MI_SIZE_LOG2) >> subsamplingY);
                switch (plane) {
                    case PLANE_U: { paletteColors = paletteBase + RECORD_PALETTE_COLORS_U; }
                    case PLANE_V: { paletteColors = paletteBase + RECORD_PALETTE_COLORS_V; }
                    default: { paletteColors = paletteBase + RECORD_PALETTE_COLORS_Y; }
                }
                // The luma map comes first when luma has a palette
                paletteMap = paletteBase + RECORD_PALETTE_HEADER_WORDS;
                if (isChroma && lumaPaletteSize > 0u) {
                    paletteMap += 1u << (lumaWidthLog2 + lumaHeightLog2 - PALETTE_INDICES_PER_WORD_LOG2);
                }
            }
        }
    } else if (kind == RECORD_INTRA_JOB_KIND_INTERINTRA) {
        let compound = readRecordWord(readRecordWord(RECORD_HEADER_SIDE_DATA) + getField(extension, 0u, RECORD_BLOCK_EXTENSION_OFFSET_BITS)
            + RECORD_MOTION_COMPOUND);
        mode = intraGetInterIntraMode(getField(compound, RECORD_MOTION_INTERINTRA_MODE_SHIFT, RECORD_MOTION_INTERINTRA_MODE_BITS));
    }

    // libaom's edge needs: filter intra and the non-directional modes read both edges, a directional mode the edges its angle faces
    let usesFilterIntra = filterIntraMode != RECORD_BLOCK_FILTER_INTRA_NONE;
    let isDirectional = !usesPalette && !usesFilterIntra && mode >= INTRA_MODE_V && mode <= INTRA_MODE_D67;
    let angle = intraGetBaseAngle(mode) + angleDelta;
    let needsAbove = !isDirectional || angle < INTRA_ANGLE_HORIZONTAL;
    let needsLeft = !isDirectional || angle > INTRA_ANGLE_VERTICAL;
    let topCount = i32(getField(edgesWord, RECORD_INTRA_JOB_TOP_SHIFT, RECORD_INTRA_JOB_EDGE_BITS));
    let topRightCount = i32(getField(edgesWord, RECORD_INTRA_JOB_TOP_RIGHT_SHIFT, RECORD_INTRA_JOB_EDGE_BITS)) - i32(RECORD_INTRA_JOB_EDGE_BIAS);
    let leftCount = i32(getField(edgesWord, RECORD_INTRA_JOB_LEFT_SHIFT, RECORD_INTRA_JOB_EDGE_BITS));
    let bottomLeftCount = i32(getField(edgesWord, RECORD_INTRA_JOB_BOTTOM_LEFT_SHIFT, RECORD_INTRA_JOB_EDGE_BITS)) - i32(RECORD_INTRA_JOB_EDGE_BIAS);
    let edgeFilterType = (edgesWord >> RECORD_INTRA_JOB_EDGE_FILTER_SHIFT) & 1u;
    let predictsFromEdges = kind != RECORD_INTRA_JOB_KIND_INTRABC && !usesPalette;
    // libaom fills the whole block with one sample when the edge a single-edge prediction needs is missing
    let fillsFlat = predictsFromEdges && ((!needsAbove && leftCount == 0) || (!needsLeft && topCount == 0));

    var predictor = INTRA_PREDICTOR_FLAT;
    if (kind == RECORD_INTRA_JOB_KIND_INTRABC) {
        predictor = INTRA_PREDICTOR_COPY;
    } else if (usesPalette) {
        predictor = INTRA_PREDICTOR_PALETTE;
    } else if (fillsFlat) {
        predictor = INTRA_PREDICTOR_FLAT;
    } else if (usesFilterIntra) {
        predictor = INTRA_PREDICTOR_FILTER;
    } else if (isDirectional) {
        if (angle < INTRA_ANGLE_VERTICAL) {
            predictor = INTRA_PREDICTOR_ZONE_1;
        } else if (angle == INTRA_ANGLE_VERTICAL) {
            predictor = INTRA_PREDICTOR_VERTICAL;
        } else if (angle < INTRA_ANGLE_HORIZONTAL) {
            predictor = INTRA_PREDICTOR_ZONE_2;
        } else if (angle == INTRA_ANGLE_HORIZONTAL) {
            predictor = INTRA_PREDICTOR_HORIZONTAL;
        } else {
            predictor = INTRA_PREDICTOR_ZONE_3;
        }
    } else {
        switch (mode) {
            case INTRA_MODE_SMOOTH: { predictor = INTRA_PREDICTOR_SMOOTH; }
            case INTRA_MODE_SMOOTH_V: { predictor = INTRA_PREDICTOR_SMOOTH_VERTICAL; }
            case INTRA_MODE_SMOOTH_H: { predictor = INTRA_PREDICTOR_SMOOTH_HORIZONTAL; }
            case INTRA_MODE_PAETH: { predictor = INTRA_PREDICTOR_PAETH; }
            default: { predictor = INTRA_PREDICTOR_FLAT; }
        }
    }
    let loadsEdges = predictsFromEdges && !fillsFlat;
    let computesDc = loadsEdges && predictor == INTRA_PREDICTOR_FLAT;
    let usesSmoothWeights = predictor == INTRA_PREDICTOR_SMOOTH || predictor == INTRA_PREDICTOR_SMOOTH_VERTICAL
        || predictor == INTRA_PREDICTOR_SMOOTH_HORIZONTAL;

    // The directional edge stage libaom runs with the sequence's intra edge filter: corner filter, edge filter strengths, upsampling
    let needsRight = isDirectional && angle < INTRA_ANGLE_VERTICAL;
    let needsBottom = isDirectional && angle > INTRA_ANGLE_HORIZONTAL;
    var filtersCorner = false;
    var aboveStrength = 0u;
    var leftStrength = 0u;
    var upsamplesAbove = false;
    var upsamplesLeft = false;
    if (isDirectional && !fillsFlat && ((frame.w >> RECORD_FLAG_INTRA_EDGE_FILTER) & 1u) != 0u) {
        let filtersEdges = angle != INTRA_ANGLE_VERTICAL && angle != INTRA_ANGLE_HORIZONTAL;
        filtersCorner = filtersEdges && needsAbove && needsLeft && width + height >= INTRA_EDGE_CORNER_MINIMUM_SIZE;
        if (filtersEdges && needsAbove && topCount > 0) {
            aboveStrength = intraGetEdgeFilterStrength(width, height, angle - INTRA_ANGLE_VERTICAL, edgeFilterType);
        }
        if (filtersEdges && needsLeft && leftCount > 0) {
            leftStrength = intraGetEdgeFilterStrength(height, width, angle - INTRA_ANGLE_HORIZONTAL, edgeFilterType);
        }
        upsamplesAbove = needsAbove && intraUsesUpsampling(width, height, angle - INTRA_ANGLE_VERTICAL, edgeFilterType);
        upsamplesLeft = needsLeft && intraUsesUpsampling(height, width, angle - INTRA_ANGLE_HORIZONTAL, edgeFilterType);
    }
    let changesEdges = filtersCorner || aboveStrength > 0u || leftStrength > 0u || upsamplesAbove || upsamplesLeft;

    // Directional steps (av1_get_dx(), av1_get_dy()); chroma from luma instead takes its alpha and the luma surface libaom stored
    var detailWord = 0u;
    switch (predictor) {
        case INTRA_PREDICTOR_ZONE_1: {
            detailWord = frameData[tablesBase + INTRA_TABLE_DERIVATIVES + u32(angle)];
        }
        case INTRA_PREDICTOR_ZONE_2: {
            detailWord = frameData[tablesBase + INTRA_TABLE_DERIVATIVES + u32(INTRA_ANGLE_HORIZONTAL - angle)]
                | (frameData[tablesBase + INTRA_TABLE_DERIVATIVES + u32(angle - INTRA_ANGLE_VERTICAL)] << INTRA_DETAIL_STEP_Y_SHIFT);
        }
        case INTRA_PREDICTOR_ZONE_3: {
            detailWord = frameData[tablesBase + INTRA_TABLE_DERIVATIVES + u32(INTRA_ANGLE_HORIZONTAL + INTRA_ANGLE_VERTICAL - angle)]
                << INTRA_DETAIL_STEP_Y_SHIFT;
        }
        default: {}
    }
    if (usesCfl) {
        let storedWidth = min((getField(blockWord, RECORD_INTRA_JOB_CFL_WIDTH_SHIFT, RECORD_INTRA_JOB_CFL_SIZE_BITS) + 1u) * CFL_SIZE_UNIT, u32(width));
        let storedHeight = min((getField(blockWord, RECORD_INTRA_JOB_CFL_HEIGHT_SHIFT, RECORD_INTRA_JOB_CFL_SIZE_BITS) + 1u) * CFL_SIZE_UNIT, u32(height));
        detailWord = getField(modes, select(RECORD_BLOCK_CFL_ALPHA_V_SHIFT, RECORD_BLOCK_CFL_ALPHA_U_SHIFT, plane == PLANE_U), RECORD_BLOCK_CFL_ALPHA_BITS)
            | (storedWidth << INTRA_DETAIL_CFL_WIDTH_SHIFT) | (storedHeight << INTRA_DETAIL_CFL_HEIGHT_SHIFT);
    }

    var flags = predictor | (kind << INTRA_FLAG_KIND_SHIFT) | (filterIntraMode << INTRA_FLAG_FILTER_MODE_SHIFT)
        | (aboveStrength << INTRA_FLAG_ABOVE_STRENGTH_SHIFT) | (leftStrength << INTRA_FLAG_LEFT_STRENGTH_SHIFT);
    flags |= select(0u, 1u << INTRA_FLAG_NEEDS_ABOVE, needsAbove) | select(0u, 1u << INTRA_FLAG_NEEDS_LEFT, needsLeft);
    flags |= select(0u, 1u << INTRA_FLAG_LOADS_EDGES, loadsEdges) | select(0u, 1u << INTRA_FLAG_COMPUTES_DC, computesDc);
    flags |= select(0u, 1u << INTRA_FLAG_FILLS_FLAT, fillsFlat) | select(0u, 1u << INTRA_FLAG_CHANGES_EDGES, changesEdges);
    flags |= select(0u, 1u << INTRA_FLAG_FILTERS_CORNER, filtersCorner) | select(0u, 1u << INTRA_FLAG_UPSAMPLES_ABOVE, upsamplesAbove);
    flags |= select(0u, 1u << INTRA_FLAG_UPSAMPLES_LEFT, upsamplesLeft) | select(0u, 1u << INTRA_FLAG_USES_CFL, usesCfl);
    flags |= select(0u, 1u << INTRA_FLAG_SMOOTH_WEIGHTS, usesSmoothWeights) | select(0u, 1u << INTRA_FLAG_NEEDS_RIGHT, needsRight);
    flags |= select(0u, 1u << INTRA_FLAG_NEEDS_BOTTOM, needsBottom);
    let position = (x4 << INTRA_DESCRIPTOR_X4_SHIFT) | (y4 << INTRA_DESCRIPTOR_Y4_SHIFT) | (widthLog2 << INTRA_DESCRIPTOR_WIDTH_SHIFT)
        | (heightLog2 << INTRA_DESCRIPTOR_HEIGHT_SHIFT) | (hasResidual << INTRA_DESCRIPTOR_RESIDUAL_SHIFT);
    let paletteWord = paletteMapWidth | (paletteOffsetX << INTRA_DETAIL_PALETTE_OFFSET_X_SHIFT) | (paletteOffsetY << INTRA_DETAIL_PALETTE_OFFSET_Y_SHIFT);
    intraDescriptors[slot] = array<vec4u, 2>(vec4u(position, flags, edgesWord, blockIndex), vec4u(detailWord, paletteColors, paletteMap, paletteWord));
}

// Reconstructs one intra job (scratch/av1/DESIGN.md 6.2) from its descriptor pair: predicts kind 0 from the target's edges, blends kind 1's
// intra prediction with its inter prediction, takes kind 2's IntraBC prediction from the inter family; then adds the residual, clips,
// and writes. planeBases holds the plane's first words in the target and scratch buffers and the target luma's; frame holds the bit
// depth, subsampling, and header flags; lattice holds the superblock's origin in the plane and whether its edges use the lattice.
fn intraRunJob(job: vec4u, details: vec4u, plane: u32, lane: u32, planeBases: vec3u, frame: vec4u, lattice: vec3u) {
    let targetBase = planeBases.x;
    let residualBase = planeBases.y;
    let lumaBase = planeBases.z;
    let originX = getField(job.x, INTRA_DESCRIPTOR_X4_SHIFT, INTRA_DESCRIPTOR_COORDINATE_BITS) << MI_SIZE_LOG2;
    let originY = getField(job.x, INTRA_DESCRIPTOR_Y4_SHIFT, INTRA_DESCRIPTOR_COORDINATE_BITS) << MI_SIZE_LOG2;
    let widthLog2 = getField(job.x, INTRA_DESCRIPTOR_WIDTH_SHIFT, INTRA_DESCRIPTOR_SIZE_BITS);
    let heightLog2 = getField(job.x, INTRA_DESCRIPTOR_HEIGHT_SHIFT, INTRA_DESCRIPTOR_SIZE_BITS);
    let width = 1 << widthLog2;
    let height = 1 << heightLog2;
    let hasResidual = intraHasFlag(job.x, INTRA_DESCRIPTOR_RESIDUAL_SHIFT);
    let flags = job.y;
    let predictor = getField(flags, 0u, INTRA_FLAG_PREDICTOR_BITS);
    let kind = getField(flags, INTRA_FLAG_KIND_SHIFT, RECORD_INTRA_JOB_KIND_BITS);
    let needsAbove = intraHasFlag(flags, INTRA_FLAG_NEEDS_ABOVE);
    let needsLeft = intraHasFlag(flags, INTRA_FLAG_NEEDS_LEFT);
    let loadsEdges = intraHasFlag(flags, INTRA_FLAG_LOADS_EDGES);
    let computesDc = intraHasFlag(flags, INTRA_FLAG_COMPUTES_DC);
    let fillsFlat = intraHasFlag(flags, INTRA_FLAG_FILLS_FLAT);
    let usesCfl = intraHasFlag(flags, INTRA_FLAG_USES_CFL);
    let usesSmoothWeights = intraHasFlag(flags, INTRA_FLAG_SMOOTH_WEIGHTS);
    let filterIntraMode = getField(flags, INTRA_FLAG_FILTER_MODE_SHIFT, RECORD_BLOCK_FILTER_INTRA_BITS);
    let edgesWord = job.z;
    let topCount = i32(getField(edgesWord, RECORD_INTRA_JOB_TOP_SHIFT, RECORD_INTRA_JOB_EDGE_BITS));
    let topRightCount = i32(getField(edgesWord, RECORD_INTRA_JOB_TOP_RIGHT_SHIFT, RECORD_INTRA_JOB_EDGE_BITS)) - i32(RECORD_INTRA_JOB_EDGE_BIAS);
    let leftCount = i32(getField(edgesWord, RECORD_INTRA_JOB_LEFT_SHIFT, RECORD_INTRA_JOB_EDGE_BITS));
    let bottomLeftCount = i32(getField(edgesWord, RECORD_INTRA_JOB_BOTTOM_LEFT_SHIFT, RECORD_INTRA_JOB_EDGE_BITS)) - i32(RECORD_INTRA_JOB_EDGE_BIAS);
    let blockIndex = job.w;
    let paletteColors = details.y;
    let paletteMap = details.z;
    let paletteMapWidth = getField(details.w, 0u, INTRA_DETAIL_FIELD_BITS);
    let paletteOffsetX = getField(details.w, INTRA_DETAIL_PALETTE_OFFSET_X_SHIFT, INTRA_DETAIL_FIELD_BITS);
    let paletteOffsetY = getField(details.w, INTRA_DETAIL_PALETTE_OFFSET_Y_SHIFT, INTRA_DETAIL_FIELD_BITS);
    let bitDepth = frame.x;
    let sampleMaximum = (1 << bitDepth) - 1;
    // libaom's base, 128 << (bitDepth - 8): missing edges take base - 1 above, base + 1 left, and base at the corner
    let neutral = 1 << (bitDepth - 1u);
    let isChroma = plane != PLANE_Y;
    let subsamplingX = select(0u, frame.y, isChroma);
    let subsamplingY = select(0u, frame.z, isChroma);
    let planeWidth = getStorePlaneWidth(plane);
    let planeHeight = getStorePlaneHeight(plane);
    let rowWords = planeWidth >> SAMPLE_PAIR_SHIFT;
    let tablesBase = getTablesOffset() + INTRA_TABLES_OFFSET;

    let aboveRawBase = INTRA_EDGE_ORIGIN + i32(INTRA_EDGE_ABOVE_RAW * INTRA_EDGE_REGION_SAMPLES);
    let leftRawBase = INTRA_EDGE_ORIGIN + i32(INTRA_EDGE_LEFT_RAW * INTRA_EDGE_REGION_SAMPLES);
    let aboveFinalBase = INTRA_EDGE_ORIGIN + i32(INTRA_EDGE_ABOVE_FINAL * INTRA_EDGE_REGION_SAMPLES);
    let leftFinalBase = INTRA_EDGE_ORIGIN + i32(INTRA_EDGE_LEFT_FINAL * INTRA_EDGE_REGION_SAMPLES);
    let usesLattice = lattice.z != 0u;

    // The output pass's quads; each lane's first quad's residual loads now, ahead of the edges
    let quadColumnsLog2 = widthLog2 - INTRA_QUAD_SAMPLES_LOG2;
    let quadCount = 1u << (quadColumnsLog2 + heightLog2);
    var firstResidualWords = vec2u(0u);
    let quadExtent = vec4u(originX, originY, quadCount, quadColumnsLog2);
    let planeExtent = vec3u(planeWidth, planeHeight, rowWords);
    if (hasResidual) {
        firstResidualWords = intraLoadResidualQuad(residualBase, lane, quadExtent, planeExtent);
    }
    // Blocks over 64 quads load the lane's next three quads now too, so the output loop's iterations do not each wait on a load
    var secondResidualWords = vec2u(0u);
    var thirdResidualWords = vec2u(0u);
    var fourthResidualWords = vec2u(0u);
    if (hasResidual && quadCount > INTRA_LANES) {
        secondResidualWords = intraLoadResidualQuad(residualBase, lane + INTRA_LANES, quadExtent, planeExtent);
        thirdResidualWords = intraLoadResidualQuad(residualBase, lane + 2u * INTRA_LANES, quadExtent, planeExtent);
        fourthResidualWords = intraLoadResidualQuad(residualBase, lane + 3u * INTRA_LANES, quadExtent, planeExtent);
    }


    // The single sample a flat fill takes: the above edge's first for a left-edge prediction, else the left edge's first
    var flatValue = neutral;
    if (fillsFlat) {
        if (needsLeft) {
            flatValue = neutral + 1;
            if (topCount > 0) {
                flatValue = intraReadAboveEdge(originX, originY - 1u, lattice, targetBase, rowWords);
            }
        } else {
            flatValue = neutral - 1;
            if (leftCount > 0) {
                flatValue = intraReadLeftEdge(originX - 1u, originY, lattice, targetBase, rowWords);
            }
        }
    }

    // Edges, as libaom fills its above_row and left_col: available samples, the last one repeated, or the other edge's first;
    // a needed top-right or bottom-left run extends its edge by the other side's size
    let aboveNeeded = width + select(0, height, topRightCount >= 0);
    let leftNeeded = height + select(0, width, bottomLeftCount >= 0);
    if (loadsEdges) {
        let aboveLast = select(topCount - 1, width + topRightCount - 1, topRightCount > 0);
        let leftLast = select(leftCount - 1, height + bottomLeftCount - 1, bottomLeftCount > 0);
        for (var index = i32(lane); index < max(aboveNeeded, leftNeeded); index += i32(INTRA_LANES)) {
            if (needsAbove && index < aboveNeeded) {
                var value = neutral - 1;
                if (topCount > 0) {
                    value = intraReadAboveEdge(originX + u32(min(index, aboveLast)), originY - 1u, lattice, targetBase, rowWords);
                } else if (leftCount > 0) {
                    value = intraReadLeftEdge(originX - 1u, originY, lattice, targetBase, rowWords);
                }
                intraEdges[aboveRawBase + index] = value;
            }
            if (needsLeft && index < leftNeeded) {
                var value = neutral + 1;
                if (leftCount > 0) {
                    value = intraReadLeftEdge(originX - 1u, originY + u32(min(index, leftLast)), lattice, targetBase, rowWords);
                } else if (topCount > 0) {
                    value = intraReadAboveEdge(originX, originY - 1u, lattice, targetBase, rowWords);
                }
                intraEdges[leftRawBase + index] = value;
            }
        }
        if (lane == 0u) {
            var corner = neutral;
            if (topCount > 0 && leftCount > 0) {
                corner = intraReadAboveEdge(originX - 1u, originY - 1u, lattice, targetBase, rowWords);
            } else if (topCount > 0) {
                corner = intraReadAboveEdge(originX, originY - 1u, lattice, targetBase, rowWords);
            } else if (leftCount > 0) {
                corner = intraReadLeftEdge(originX - 1u, originY, lattice, targetBase, rowWords);
            }
            intraEdges[aboveRawBase - 1] = corner;
            intraEdges[leftRawBase - 1] = corner;
        }
        if (usesSmoothWeights) {
            let laneIndex = i32(lane);
            if (laneIndex < width) {
                intraEdges[aboveFinalBase + laneIndex] = i32(frameData[tablesBase + INTRA_TABLE_SMOOTH_WEIGHTS + u32(width) - INTRA_SMOOTH_FIRST_SIZE + lane]);
            }
            if (laneIndex < height) {
                intraEdges[leftFinalBase + laneIndex] = i32(frameData[tablesBase + INTRA_TABLE_SMOOTH_WEIGHTS + u32(height) - INTRA_SMOOTH_FIRST_SIZE + lane]);
            }
        }
    }
    workgroupBarrier();

    // DC_PRED over the available edges (dc_pred's variants), the edges' replicated samples included
    if (computesDc) {
        var sum = 0;
        if (topCount > 0) {
            sum += intraSumEdgeRun(aboveRawBase, width);
        }
        if (leftCount > 0) {
            sum += intraSumEdgeRun(leftRawBase, height);
        }
        if (topCount > 0 && leftCount > 0) {
            flatValue = intraDivideDc(sum, widthLog2, heightLog2);
        } else if (topCount > 0) {
            flatValue = (sum + (width >> 1u)) >> widthLog2;
        } else if (leftCount > 0) {
            flatValue = (sum + (height >> 1u)) >> heightLog2;
        }
    }

    // Directional edges: libaom's corner filter, edge filter, and upsampling, from the raw regions into the final ones
    var aboveBase = aboveRawBase;
    var leftBase = leftRawBase;
    let upsampleAbove = getField(flags, INTRA_FLAG_UPSAMPLES_ABOVE, 1u);
    let upsampleLeft = getField(flags, INTRA_FLAG_UPSAMPLES_LEFT, 1u);
    if (intraHasFlag(flags, INTRA_FLAG_CHANGES_EDGES)) {
        let filtersCorner = intraHasFlag(flags, INTRA_FLAG_FILTERS_CORNER);
        let needsRight = intraHasFlag(flags, INTRA_FLAG_NEEDS_RIGHT);
        let needsBottom = intraHasFlag(flags, INTRA_FLAG_NEEDS_BOTTOM);
        let aboveStrength = getField(flags, INTRA_FLAG_ABOVE_STRENGTH_SHIFT, INTRA_FLAG_STRENGTH_BITS);
        let leftStrength = getField(flags, INTRA_FLAG_LEFT_STRENGTH_SHIFT, INTRA_FLAG_STRENGTH_BITS);
        var corner = intraEdges[aboveRawBase - 1];
        if (filtersCorner) {
            corner = (INTRA_EDGE_CORNER_OUTER_TAP * (intraEdges[leftRawBase] + intraEdges[aboveRawBase])
                + INTRA_EDGE_CORNER_CENTER_TAP * corner + INTRA_EDGE_KERNEL_ROUNDING) >> INTRA_EDGE_KERNEL_SHIFT;
        }
        for (var side = 0u; side < 2u; side += 1u) {
            let isAbove = side == 0u;
            if (!select(needsLeft, needsAbove, isAbove)) {
                continue;
            }
            let rawBase = select(leftRawBase, aboveRawBase, isAbove);
            let finalBase = select(leftFinalBase, aboveFinalBase, isAbove);
            let strength = select(leftStrength, aboveStrength, isAbove);
            let ownSize = select(height, width, isAbove);
            let otherSize = select(width, height, isAbove);
            let extendsPastBlock = select(needsBottom, needsRight, isAbove);
            let filterCount = select(leftCount, topCount, isAbove) + 1 + select(0, otherSize, extendsPastBlock);
            let upsamples = select(upsampleLeft, upsampleAbove, isAbove) != 0u;
            let upsampleCount = ownSize + select(0, otherSize, extendsPastBlock);
            let firstIndex = select(-1, -2, upsamples);
            let endIndex = select(select(leftNeeded, aboveNeeded, isAbove), 2 * upsampleCount - 1, upsamples);
            for (var finalIndex = i32(lane) + firstIndex; finalIndex < endIndex; finalIndex += i32(INTRA_LANES)) {
                var value = 0;
                if (upsamples && (finalIndex & 1) != 0) {
                    // av1_upsample_intra_edge_c(): odd samples interpolate in[i] to in[i + 3], where in[0] and in[1] are the corner
                    // and the last input repeats
                    let firstInput = (finalIndex + 1) >> 1u;
                    var sum = 0;
                    for (var tap = 0; tap < INTRA_UPSAMPLE_TAPS; tap += 1) {
                        let input = firstInput + tap;
                        let sourceIndex = select(min(input - 2, upsampleCount - 1), -1, input <= 1);
                        let weight = select(INTRA_UPSAMPLE_INNER_TAP, INTRA_UPSAMPLE_OUTER_TAP, tap == 0 || tap == INTRA_UPSAMPLE_TAPS - 1);
                        sum += weight * intraGetFilteredEdgeSample(rawBase, sourceIndex, strength, filterCount, corner);
                    }
                    value = clamp((sum + INTRA_EDGE_KERNEL_ROUNDING) >> INTRA_EDGE_KERNEL_SHIFT, 0, sampleMaximum);
                } else {
                    // Upsampled even samples are the inputs (sample -2 the corner); otherwise the filtered sample itself
                    value = intraGetFilteredEdgeSample(rawBase, select(finalIndex, finalIndex >> 1u, upsamples), strength, filterCount, corner);
                }
                intraEdges[finalBase + finalIndex] = value;
            }
        }
        workgroupBarrier();
        aboveBase = aboveFinalBase;
        leftBase = leftFinalBase;
    }

    // Chroma from luma: libaom's CFL buffer of the luma the block stored (cfl_store()), padded by repetition (cfl_pad()), and its
    // average (subtract_average_c()); each lane sums its stored samples weighted by how often padding repeats them, and libaom's
    // round offset is half the block's samples
    let cflAlpha = i32(getField(details.x, 0u, RECORD_BLOCK_CFL_ALPHA_BITS)) - i32(RECORD_BLOCK_CFL_ALPHA_BIAS);
    let cflStoredWidth = getField(details.x, INTRA_DETAIL_CFL_WIDTH_SHIFT, INTRA_DETAIL_FIELD_BITS);
    let cflStoredHeight = getField(details.x, INTRA_DETAIL_CFL_HEIGHT_SHIFT, INTRA_DETAIL_FIELD_BITS);
    var cflAverage = 0;
    if (usesCfl) {
        let lumaRowWords = getStorePlaneWidth(PLANE_Y) >> SAMPLE_PAIR_SHIFT;
        var partialSum = 0;
        for (var position = lane; position < (1u << (widthLog2 + heightLog2)); position += INTRA_LANES) {
            let column = position & (u32(width) - 1u);
            let row = position >> widthLog2;
            if (column < cflStoredWidth && row < cflStoredHeight) {
                let value = cflGetLumaQ3(lumaBase, lumaRowWords, (originX + column) << subsamplingX, (originY + row) << subsamplingY, subsamplingX, subsamplingY);
                intraBlock[(row << INTRA_BLOCK_STRIDE_LOG2) + column] = value;
                let repeatsX = select(1u, u32(width) - cflStoredWidth + 1u, column == cflStoredWidth - 1u);
                let repeatsY = select(1u, u32(height) - cflStoredHeight + 1u, row == cflStoredHeight - 1u);
                partialSum += value * i32(repeatsX * repeatsY);
            }
        }
        intraBlock[CFL_PARTIAL_SUMS + lane] = partialSum;
        workgroupBarrier();
        var total = 1 << (widthLog2 + heightLog2 - 1u);
        for (var partial = 0u; partial < INTRA_LANES; partial += 1u) {
            total += intraBlock[CFL_PARTIAL_SUMS + partial];
        }
        cflAverage = total >> (widthLog2 + heightLog2);
    }

    // Filter intra: libaom's recursive 4x2 blocks, as diagonal steps of up to 8 blocks; lane = block column x 8 + output
    if (predictor == INTRA_PREDICTOR_FILTER) {
        let output = lane & (INTRA_FILTER_OUTPUTS - 1u);
        let blockColumn = lane >> INTRA_FILTER_OUTPUTS_LOG2;
        let tapBase = tablesBase + INTRA_TABLE_FILTER_TAPS + (filterIntraMode * INTRA_FILTER_OUTPUTS + output) * INTRA_FILTER_TAPS_PER_OUTPUT;
        let cornerTap = bitcast<i32>(frameData[tapBase]);
        let aboveTap0 = bitcast<i32>(frameData[tapBase + 1u]);
        let aboveTap1 = bitcast<i32>(frameData[tapBase + 2u]);
        let aboveTap2 = bitcast<i32>(frameData[tapBase + 3u]);
        let aboveTap3 = bitcast<i32>(frameData[tapBase + 4u]);
        let leftTap0 = bitcast<i32>(frameData[tapBase + 5u]);
        let leftTap1 = bitcast<i32>(frameData[tapBase + 6u]);
        let blockRows = height >> INTRA_FILTER_BLOCK_HEIGHT_LOG2;
        let blockColumns = width >> INTRA_FILTER_BLOCK_WIDTH_LOG2;
        for (var diagonal = 0; diagonal < blockRows + blockColumns - 1; diagonal += 1) {
            let blockRow = diagonal - i32(blockColumn);
            if (i32(blockColumn) < blockColumns && blockRow >= 0 && blockRow < blockRows) {
                // The block's first output in libaom's buffer, whose row 0 and column 0 are the edges
                let row = 1 + (blockRow << INTRA_FILTER_BLOCK_HEIGHT_LOG2);
                let column = 1 + (i32(blockColumn) << INTRA_FILTER_BLOCK_WIDTH_LOG2);
                let sum = cornerTap * intraGetFilterSource(aboveRawBase, leftRawBase, row - 1, column - 1)
                    + aboveTap0 * intraGetFilterSource(aboveRawBase, leftRawBase, row - 1, column)
                    + aboveTap1 * intraGetFilterSource(aboveRawBase, leftRawBase, row - 1, column + 1)
                    + aboveTap2 * intraGetFilterSource(aboveRawBase, leftRawBase, row - 1, column + 2)
                    + aboveTap3 * intraGetFilterSource(aboveRawBase, leftRawBase, row - 1, column + 3)
                    + leftTap0 * intraGetFilterSource(aboveRawBase, leftRawBase, row, column - 1)
                    + leftTap1 * intraGetFilterSource(aboveRawBase, leftRawBase, row + 1, column - 1);
                let outputRow = row + i32(output >> INTRA_FILTER_BLOCK_WIDTH_LOG2);
                let outputColumn = column + i32(output & ((1u << INTRA_FILTER_BLOCK_WIDTH_LOG2) - 1u));
                intraBlock[((outputRow - 1) << INTRA_BLOCK_STRIDE_LOG2) + outputColumn - 1] =
                    clamp((sum + INTRA_FILTER_ROUNDING) >> INTRA_FILTER_SHIFT, 0, sampleMaximum);
            }
            workgroupBarrier();
        }
    }

    // IntraBC: the inter family copies the prediction into the target, which the residual then adds to
    if (kind == RECORD_INTRA_JOB_KIND_INTRABC) {
        interPredictIntraBlockCopy(blockIndex, plane, lane);
        storageBarrier();
    }

    // Directional steps (av1_get_dx(), av1_get_dy()) and the zones' limits
    let stepX = i32(getField(details.x, 0u, INTRA_DETAIL_STEP_BITS));
    let stepY = i32(getField(details.x, INTRA_DETAIL_STEP_Y_SHIFT, INTRA_DETAIL_STEP_BITS));
    let maximumBaseX = (width + height - 1) << upsampleAbove;
    let maximumBaseY = (width + height - 1) << upsampleLeft;
    let minimumBaseX = -(1 << upsampleAbove);
    let fractionBitsX = INTRA_POSITION_BITS - upsampleAbove;
    let fractionBitsY = INTRA_POSITION_BITS - upsampleLeft;

    // Predict, add the residual, clip, and write: each lane takes quads of four samples of a row (two frame store words) and computes
    // them as vectors, four independent chains. An IntraBC block without a residual is final in the frame, but its samples still go to
    // the lattice.
    if (kind != RECORD_INTRA_JOB_KIND_INTRABC || hasResidual || usesLattice) {
        let sampleOffsets = vec4<i32>(0, 1, 2, 3);
        let sampleMaxima = vec4<i32>(sampleMaximum);
        for (var quadIndex = lane; quadIndex < quadCount; quadIndex += INTRA_LANES) {
            let row = quadIndex >> quadColumnsLog2;
            let column = (quadIndex & ((1u << quadColumnsLog2) - 1u)) << INTRA_QUAD_SAMPLES_LOG2;
            let x = originX + column;
            let y = originY + row;
            if (x >= planeWidth || y >= planeHeight) {
                continue;
            }
            let wordIndex = targetBase + y * rowWords + (x >> SAMPLE_PAIR_SHIFT);
            let secondWord = select(0u, 1u, x + (1u << SAMPLE_PAIR_SHIFT) < planeWidth);
            var targetWords = vec2u(0u);
            if (kind != RECORD_INTRA_JOB_KIND_TRANSFORM) {
                targetWords = vec2u(frames[wordIndex], frames[wordIndex + secondWord]);
            }
            var residuals = vec4<i32>(0);
            if (hasResidual) {
                // The lane's first four quads loaded with the edges; later ones (blocks of 64 samples a side) load here
                var residualWords = firstResidualWords;
                switch ((quadIndex - lane) >> INTRA_LANES_LOG2) {
                    case 0u: {}
                    case 1u: {
                        residualWords = secondResidualWords;
                    }
                    case 2u: {
                        residualWords = thirdResidualWords;
                    }
                    case 3u: {
                        residualWords = fourthResidualWords;
                    }
                    default: {
                        let residualIndex = residualBase + y * rowWords + (x >> SAMPLE_PAIR_SHIFT);
                        residualWords = vec2u(frames[residualIndex], frames[residualIndex + secondWord]);
                    }
                }
                residuals = intraUnpackResiduals(residualWords);
            }
            let columnIndex = i32(column);
            let columns = vec4<i32>(columnIndex) + sampleOffsets;
            let sampleRow = i32(row);
            var predictions = vec4<i32>(flatValue);
            switch (predictor) {
                case INTRA_PREDICTOR_VERTICAL: {
                    predictions = intraLoadEdgeQuad(aboveBase + columnIndex);
                }
                case INTRA_PREDICTOR_HORIZONTAL: {
                    predictions = vec4<i32>(intraEdges[leftBase + sampleRow]);
                }
                case INTRA_PREDICTOR_SMOOTH: {
                    let rowWeight = intraEdges[leftFinalBase + sampleRow];
                    let columnWeights = intraLoadEdgeQuad(aboveFinalBase + columnIndex);
                    let below = intraEdges[leftBase + height - 1];
                    let right = intraEdges[aboveBase + width - 1];
                    predictions = (rowWeight * intraLoadEdgeQuad(aboveBase + columnIndex) + (INTRA_SMOOTH_SCALE - rowWeight) * below
                        + columnWeights * intraEdges[leftBase + sampleRow] + (INTRA_SMOOTH_SCALE - columnWeights) * right
                        + INTRA_SMOOTH_SCALE) >> vec4u(INTRA_SMOOTH_SHIFT + 1u);
                }
                case INTRA_PREDICTOR_SMOOTH_VERTICAL: {
                    let rowWeight = intraEdges[leftFinalBase + sampleRow];
                    let below = intraEdges[leftBase + height - 1];
                    predictions = (rowWeight * intraLoadEdgeQuad(aboveBase + columnIndex) + (INTRA_SMOOTH_SCALE - rowWeight) * below
                        + INTRA_SMOOTH_ROUNDING) >> vec4u(INTRA_SMOOTH_SHIFT);
                }
                case INTRA_PREDICTOR_SMOOTH_HORIZONTAL: {
                    let columnWeights = intraLoadEdgeQuad(aboveFinalBase + columnIndex);
                    let right = intraEdges[aboveBase + width - 1];
                    predictions = (columnWeights * intraEdges[leftBase + sampleRow] + (INTRA_SMOOTH_SCALE - columnWeights) * right
                        + INTRA_SMOOTH_ROUNDING) >> vec4u(INTRA_SMOOTH_SHIFT);
                }
                case INTRA_PREDICTOR_PAETH: {
                    predictions = intraPaethQuad(intraEdges[leftBase + sampleRow], intraLoadEdgeQuad(aboveBase + columnIndex), intraEdges[aboveBase - 1]);
                }
                case INTRA_PREDICTOR_ZONE_1: {
                    // av1_highbd_dr_prediction_z1_c() along the above edge; past its end both taps clamp to the last sample, which
                    // interpolates to that sample, libaom's fill
                    let position = (sampleRow + 1) * stepX;
                    let shift = ((position << upsampleAbove) & INTRA_POSITION_MASK) >> 1u;
                    let bases = vec4<i32>(position >> fractionBitsX) + (columns << vec4u(upsampleAbove));
                    let lastTaps = vec4<i32>(maximumBaseX);
                    predictions = intraInterpolate(intraGatherEdges(aboveBase, min(bases, lastTaps)), intraGatherEdges(aboveBase, min(bases + 1, lastTaps)),
                        vec4<i32>(shift));
                }
                case INTRA_PREDICTOR_ZONE_2: {
                    // av1_highbd_dr_prediction_z2_c(): the above edge while it reaches, else the left edge; both are computed with taps
                    // clamped inside the edge regions, and each sample takes its own
                    let positionsX = (columns << vec4u(INTRA_POSITION_BITS)) - (sampleRow + 1) * stepX;
                    let basesX = positionsX >> vec4u(fractionBitsX);
                    let shiftsX = ((positionsX * (1 << upsampleAbove)) & vec4<i32>(INTRA_POSITION_MASK)) >> vec4u(1u);
                    let positionsY = (sampleRow << INTRA_POSITION_BITS) - (columns + 1) * stepY;
                    let basesY = positionsY >> vec4u(fractionBitsY);
                    let shiftsY = ((positionsY * (1 << upsampleLeft)) & vec4<i32>(INTRA_POSITION_MASK)) >> vec4u(1u);
                    let lowestTaps = vec4<i32>(INTRA_EDGE_LOWEST_TAP);
                    let highestTaps = vec4<i32>(INTRA_EDGE_HIGHEST_TAP);
                    let tapsX = clamp(basesX, lowestTaps, highestTaps);
                    let tapsY = clamp(basesY, lowestTaps, highestTaps);
                    let fromAbove = intraInterpolate(intraGatherEdges(aboveBase, tapsX), intraGatherEdges(aboveBase, tapsX + 1), shiftsX);
                    let fromLeft = intraInterpolate(intraGatherEdges(leftBase, tapsY), intraGatherEdges(leftBase, tapsY + 1), shiftsY);
                    predictions = select(fromLeft, fromAbove, basesX >= vec4<i32>(minimumBaseX));
                }
                case INTRA_PREDICTOR_ZONE_3: {
                    // av1_highbd_dr_prediction_z3_c() along the left edge, clamped past its end as zone 1
                    let positions = (columns + 1) * stepY;
                    let shifts = ((positions << vec4u(upsampleLeft)) & vec4<i32>(INTRA_POSITION_MASK)) >> vec4u(1u);
                    let bases = (positions >> vec4u(fractionBitsY)) + (sampleRow << upsampleLeft);
                    let lastTaps = vec4<i32>(maximumBaseY);
                    predictions = intraInterpolate(intraGatherEdges(leftBase, min(bases, lastTaps)), intraGatherEdges(leftBase, min(bases + 1, lastTaps)), shifts);
                }
                case INTRA_PREDICTOR_FILTER: {
                    let first = (row << INTRA_BLOCK_STRIDE_LOG2) + column;
                    predictions = vec4<i32>(intraBlock[first], intraBlock[first + 1u], intraBlock[first + 2u], intraBlock[first + 3u]);
                }
                case INTRA_PREDICTOR_PALETTE: {
                    // The palette branch of av1_predict_intra_block(): the colors the block's index map names; a quad's four indices
                    // share a map word, since map widths, offsets, and quads are multiples of 4
                    let mapIndex = (row + paletteOffsetY) * paletteMapWidth + column + paletteOffsetX;
                    let indexWord = readRecordWord(paletteMap + (mapIndex >> PALETTE_INDICES_PER_WORD_LOG2))
                        >> ((mapIndex & ((1u << PALETTE_INDICES_PER_WORD_LOG2) - 1u)) * RECORD_PALETTE_INDEX_BITS);
                    let colorIndices = (vec4u(indexWord) >> (vec4u(0u, 1u, 2u, 3u) * RECORD_PALETTE_INDEX_BITS)) & vec4u(PALETTE_INDEX_MASK);
                    predictions = vec4<i32>(paletteReadColor(paletteColors, colorIndices.x), paletteReadColor(paletteColors, colorIndices.y),
                        paletteReadColor(paletteColors, colorIndices.z), paletteReadColor(paletteColors, colorIndices.w));
                }
                case INTRA_PREDICTOR_COPY: {
                    predictions = intraUnpackSamples(targetWords);
                }
                default: {}
            }
            if (usesCfl) {
                // av1_cfl_predict_block(): alpha times the luma's AC (the padded buffer less its average), added to DC_PRED and clipped;
                // ROUND_POWER_OF_TWO_SIGNED rounds the magnitude
                let paddedColumns = min(vec4u(columns), vec4u(cflStoredWidth - 1u));
                let lumaRow = min(row, cflStoredHeight - 1u) << INTRA_BLOCK_STRIDE_LOG2;
                let scaled = cflAlpha * (vec4<i32>(intraBlock[lumaRow + paddedColumns.x], intraBlock[lumaRow + paddedColumns.y],
                    intraBlock[lumaRow + paddedColumns.z], intraBlock[lumaRow + paddedColumns.w]) - cflAverage);
                let magnitudes = (abs(scaled) + (1 << (CFL_ALPHA_SHIFT - 1u))) >> vec4u(CFL_ALPHA_SHIFT);
                predictions = clamp(predictions + select(magnitudes, -magnitudes, scaled < vec4<i32>(0)), vec4<i32>(0), sampleMaxima);
            }
            if (kind == RECORD_INTRA_JOB_KIND_INTERINTRA) {
                let interSamples = vec4u(intraUnpackSamples(targetWords));
                predictions = vec4<i32>(vec4u(interBlendInterIntra(blockIndex, plane, column, row, interSamples.x, u32(predictions.x)),
                    interBlendInterIntra(blockIndex, plane, column + 1u, row, interSamples.y, u32(predictions.y)),
                    interBlendInterIntra(blockIndex, plane, column + 2u, row, interSamples.z, u32(predictions.z)),
                    interBlendInterIntra(blockIndex, plane, column + 3u, row, interSamples.w, u32(predictions.w))));
            }
            let values = vec4u(clamp(predictions + residuals, vec4<i32>(0), sampleMaxima));
            frames[wordIndex] = values.x | (values.y << SAMPLE_HALF_BITS);
            if (secondWord != 0u) {
                frames[wordIndex + 1u] = values.z | (values.w << SAMPLE_HALF_BITS);
            }
            if (usesLattice) {
                intraWriteLattice(x - lattice.x, y - lattice.y, values);
            }
        }
    }
}
