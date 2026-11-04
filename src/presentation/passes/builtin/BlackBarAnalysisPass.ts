// The built-in black bar analysis: a compute pass over the route's signal that samples every row and every column of the frame at evenly spaced points,
// and writes one word per line of how many of its samples are brighter than black and the sum of their luma, which the presenter reads back for
// BlackBarDetector. The Black bars section of docs/src/architecture.md describes it.
import { BYTES_PER_WORD } from '../../WebGPUConstants';

/** The samples the pass reads along each row and each column, one invocation of the line's workgroup each. */
export const BLACK_BAR_SAMPLES_PER_LINE = 64;

/** The most rows, and the most columns, the pass analyzes; a larger frame is analyzed at this many evenly spaced lines. */
export const BLACK_BAR_LINE_CAPACITY = 16_384;

/** The bytes of the pass's statistics buffer: a word for every row and every column at capacity. */
export const BLACK_BAR_STATISTICS_BYTE_LENGTH = 2 * BLACK_BAR_LINE_CAPACITY * BYTES_PER_WORD;

/** A sample's level is its luma times this, so a line's level sum over its samples is its mean luma times this and BLACK_BAR_SAMPLES_PER_LINE. */
export const BLACK_BAR_WHITE_LEVEL = 255;

// A sample's luma is the BT.709 weighting of its 'source' R, G, and B, encoded in the source's transfer function, where 0 is black; it stays signed, so the
// ringing a coder leaves in bars beside a bright edge, which swings both ways around black, cancels in a line's sum, and chroma that bleeds across the
// edge adds nothing unless the route clamped R, G, and B. Another matrix's own weights differ from BT.709's by a few hundredths, which leaves chroma a trace
const LUMA_WEIGHTS = 'vec3f(0.2126, 0.7152, 0.0722)';
// A sample is lit above this luma: about 0.3 nits in PQ and 0.4 in SDR at 100 nits, so one value serves every transfer
const LIT_SAMPLE_LUMA = 0.1;
// A sample is bright above this luma, as a subtitle's strokes are. What coders left in bars never reached it in the H.264, HEVC, and AV1 encodes measured,
// and chroma that bleeds onto black reaches 0.21 at most where a route clamps R, G, and B before the pass reads them
const BRIGHT_SAMPLE_LUMA = 0.3;
// A sample's level is stored above this offset, which holds levels down to a quarter below black, and is clamped to this limit, a 9-bit field
const LEVEL_OFFSET = 64;
const LEVEL_LIMIT = 511;
// A line's word holds its lit sample count in its low bits, at most 64, its bright sample count above them, and its offset level sum above both,
// at most 64 * 511
const SAMPLE_COUNT_BITS = 7;
const SAMPLE_COUNT_MASK = (1 << SAMPLE_COUNT_BITS) - 1;
const LEVEL_SUM_SHIFT = 2 * SAMPLE_COUNT_BITS;
// 2^32 over the golden ratio: a frame index times it is the fraction of a sample spacing by which the frame's samples shift, which spreads the
// samples of successive frames evenly along their lines
const SAMPLE_PHASE_MULTIPLIER = 0x9e_37_79_b9;
// The phase keeps the top 24 bits of that product, which an f32 holds exactly
const SAMPLE_PHASE_SHIFT = 8;
const SAMPLE_PHASE_SCALE = 2 ** 24;

/** The rows and the columns of a frame that the pass analyzes. */
export type BlackBarLineCounts = Readonly<{ columns: number; rows: number }>;

/** Returns how many of a line's samples are lit, brighter than black, from its word. */
export function getBlackBarLitSampleCount(word: number): number {
    return word & SAMPLE_COUNT_MASK;
}

/** Returns how many of a line's samples are bright, as a subtitle's strokes are, from its word. */
export function getBlackBarBrightSampleCount(word: number): number {
    return (word >>> SAMPLE_COUNT_BITS) & SAMPLE_COUNT_MASK;
}

/** Returns the sum of a line's sample levels, each its luma times BLACK_BAR_WHITE_LEVEL, negative below black, from its word. */
export function getBlackBarLevelSum(word: number): number {
    return (word >>> LEVEL_SUM_SHIFT) - (LEVEL_OFFSET * BLACK_BAR_SAMPLES_PER_LINE);
}

/** Returns the lines the pass analyzes in a source of a size: one per row and one per column, each within capacity, as the pass derives them. */
export function getBlackBarLineCounts(sourceWidth: number, sourceHeight: number): BlackBarLineCounts {
    return {
        columns: Math.min(Math.max(Math.trunc(sourceWidth), 1), BLACK_BAR_LINE_CAPACITY),
        rows: Math.min(Math.max(Math.trunc(sourceHeight), 1), BLACK_BAR_LINE_CAPACITY)
    };
}

/** Returns the declaration of the pass's statistics buffer, a word per line, at its binding. */
export function createBlackBarStatisticsWGSL(binding: number): string {
    return `@group(0) @binding(${binding}) var<storage, read_write> blackBarStatistics: array<u32>;`;
}

/**
 * Returns the pass's entry point, one workgroup per line, the frame's rows and then its columns, which writes each line's word into the statistics buffer.
 * It reads `presentation`, whose source size gives the lines and whose coordinate mapping takes a point of the frame to the signal's coordinate,
 * the signal's entry point, and the statistics buffer, all of which the planner declares.
 */
export function createBlackBarAnalysisWGSL(signalEntryPoint: string): string {
    return /* wgsl */ `
var<workgroup> blackBarLineWord: atomic<u32>;

@compute @workgroup_size(${BLACK_BAR_SAMPLES_PER_LINE})
fn computeMain(@builtin(workgroup_id) workgroup: vec3u, @builtin(local_invocation_index) sampleIndex: u32) {
    if (sampleIndex == 0u) {
        atomicStore(&blackBarLineWord, 0u);
    }
    workgroupBarrier();
    let lines = clamp(vec2u(presentation.sourceSize), vec2u(1u), vec2u(${BLACK_BAR_LINE_CAPACITY}u));
    let line = workgroup.x;
    let phase = f32((presentation.frameIndex * ${SAMPLE_PHASE_MULTIPLIER}u) >> ${SAMPLE_PHASE_SHIFT}u) / ${SAMPLE_PHASE_SCALE}.0;
    let along = (f32(sampleIndex) + phase) / ${BLACK_BAR_SAMPLES_PER_LINE}.0;
    var point = vec2f(along, (f32(line) + 0.5) / f32(lines.y));
    if (line >= lines.y) {
        point = vec2f((f32(line - lines.y) + 0.5) / f32(lines.x), along);
    }
    let luma = dot(${signalEntryPoint}(point * presentation.textureScale + presentation.textureOffset).rgb, ${LUMA_WEIGHTS});
    let level = u32(clamp(round(luma * ${BLACK_BAR_WHITE_LEVEL}.0) + ${LEVEL_OFFSET}.0, 0.0, ${LEVEL_LIMIT}.0));
    let lit = select(0u, 1u, luma > ${LIT_SAMPLE_LUMA});
    let bright = select(0u, 1u << ${SAMPLE_COUNT_BITS}u, luma > ${BRIGHT_SAMPLE_LUMA});
    atomicAdd(&blackBarLineWord, (level << ${LEVEL_SUM_SHIFT}u) | bright | lit);
    workgroupBarrier();
    if (sampleIndex == 0u) {
        blackBarStatistics[line] = atomicLoad(&blackBarLineWord);
    }
}`;
}
