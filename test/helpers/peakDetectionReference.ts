// A CPU reference of the HDR peak detection the built-in passes implement, written from libplacebo's pl_shader_detect_peak, measure_peak, and
// update_peak_buf (src/shaders/colorspace.c): the accumulation the measurement's workgroups add up, the reduction of it, and its smoothing.
// It computes in f64 and truncates the fixed-point codes as the passes do, so the WGSL, which computes in f32, matches it within f32 rounding.
import { applyPQEOTF, applyPQOETF, type ColorTriplet, type RGBCoefficients } from 'webgpu-player/color/ColorPipeline';
import {
    getPeakDetectionSmoothingCoefficient,
    PEAK_DETECTION_ACCUMULATION_OFFSETS,
    PEAK_DETECTION_ACCUMULATION_WORD_COUNT,
    PEAK_DETECTION_BLACK_PQ,
    PEAK_DETECTION_HISTOGRAM_BIAS,
    PEAK_DETECTION_HISTOGRAM_BINS,
    PEAK_DETECTION_HISTOGRAM_BITS,
    PEAK_DETECTION_LINEAR_MAXIMUM,
    PEAK_DETECTION_PQ_BITS,
    PEAK_DETECTION_PQ_MAXIMUM,
    PEAK_DETECTION_SLICES,
    PEAK_DETECTION_WORKGROUP_SIZE,
    usesPeakDetectionHistogram,
    type PeakDetectionParameters
} from 'webgpu-player/presentation/passes/builtin/PeakDetectionPass';

const PQ_PEAK_NITS = 10_000;
const WORKGROUP_INVOCATIONS = PEAK_DETECTION_WORKGROUP_SIZE * PEAK_DETECTION_WORKGROUP_SIZE;
const HISTOGRAM_SHIFT = PEAK_DETECTION_PQ_BITS - PEAK_DETECTION_HISTOGRAM_BITS;

/** The points one frame's measurement reads, a whole number of workgroups on each axis: each point's PQ 'source' RGB. */
export type ReferenceFrame = Readonly<{
    height: number
    sample: (x: number, y: number) => ColorTriplet
    width: number
}>;

/** The smoothed state: the frame average and the peak in PQ, both 0 before the first measurement. */
export type ReferencePeakState = Readonly<{ averagePQ: number; peakPQ: number }>;

export const EMPTY_REFERENCE_PEAK_STATE: ReferencePeakState = Object.freeze({ averagePQ: 0, peakPQ: 0 });

/** The scene statistics the reduction writes into the render settings, in nits. */
export type ReferenceToneMapping = Readonly<{ averageNits: number; inputPeakNits: number }>;

function smoothstep(edge0: number, edge1: number, value: number): number {
    const normalized = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1);
    return normalized * normalized * (3 - (2 * normalized));
}

function mix(start: number, end: number, amount: number): number {
    return start + ((end - start) * amount);
}

/** Returns the PQ of linear light over 10000 nits, libplacebo's pq_eotf_inv. */
function encodePQ(normalizedLinear: number): number {
    return applyPQOETF(Math.min(Math.max(normalizedLinear, 0), 1) * PQ_PEAK_NITS);
}

/** Returns a frame of one PQ 'source' RGB, a whole number of workgroups wide and high. */
export function createUniformReferenceFrame(width: number, height: number, encodedRGB: ColorTriplet): ReferenceFrame {
    return { height, sample: (): ColorTriplet => encodedRGB, width };
}

/** Returns the PQ 'source' RGB of a neutral grey of a luminance. */
export function encodeNeutralNits(nits: number): ColorTriplet {
    const encoded = applyPQOETF(nits);
    return [ encoded, encoded, encoded ];
}

/** What one point adds to its workgroup: its PQ luminance code, its linear maxRGB code, and its histogram bin, the first when it fades to black. */
type ReferencePoint = Readonly<{ bin: number; maximumRGBCode: number; pqCode: number }>;

/** What one workgroup accumulates before it adds into its slice. */
type ReferenceWorkgroup = {
    bins: Uint32Array
    blackCount: number
    maximumRGBCode: number
    pqSum: number
};

/** Measures one point as a measurement invocation does. */
function measureReferencePoint(encoded: ColorTriplet, luminanceCoefficients: RGBCoefficients, cutoff: number): ReferencePoint {
    const linear = encoded.map((component: number): number => applyPQEOTF(component) / PQ_PEAK_NITS);
    const luminance = (linear[0] * luminanceCoefficients.red) + (linear[1] * luminanceCoefficients.green) + (linear[2] * luminanceCoefficients.blue);
    const maximumRGB = Math.min(Math.max(Math.max(...linear), 0), 1);
    let luminancePQ = encodePQ(luminance);
    if (cutoff > 0) {
        luminancePQ *= smoothstep(0, cutoff, luminancePQ);
    }
    const pqCode = Math.trunc(PEAK_DETECTION_PQ_MAXIMUM * luminancePQ);
    const bin = (Math.trunc(PEAK_DETECTION_PQ_MAXIMUM * encodePQ(maximumRGB)) >> HISTOGRAM_SHIFT) - PEAK_DETECTION_HISTOGRAM_BIAS;
    return {
        // A point that fades to black counts in the first bin, which the workgroup takes its black points out of again
        bin: cutoff > 0 && pqCode === 0 ? 0 : Math.min(Math.max(bin, 0), PEAK_DETECTION_HISTOGRAM_BINS - 1),
        maximumRGBCode: Math.trunc(PEAK_DETECTION_LINEAR_MAXIMUM * maximumRGB),
        pqCode
    };
}

/** Measures the 16x16 points of one workgroup. */
function measureReferenceWorkgroup(
    frame: ReferenceFrame,
    workgroupX: number,
    workgroupY: number,
    luminanceCoefficients: RGBCoefficients,
    cutoff: number
): ReferenceWorkgroup {
    const workgroup: ReferenceWorkgroup = { bins: new Uint32Array(PEAK_DETECTION_HISTOGRAM_BINS), blackCount: 0, maximumRGBCode: 0, pqSum: 0 };
    for (let localIndex = 0; localIndex < WORKGROUP_INVOCATIONS; localIndex += 1) {
        const x = (workgroupX * PEAK_DETECTION_WORKGROUP_SIZE) + (localIndex % PEAK_DETECTION_WORKGROUP_SIZE);
        const y = (workgroupY * PEAK_DETECTION_WORKGROUP_SIZE) + Math.floor(localIndex / PEAK_DETECTION_WORKGROUP_SIZE);
        const point = measureReferencePoint(frame.sample(x, y), luminanceCoefficients, cutoff);
        workgroup.bins[point.bin] += 1;
        workgroup.pqSum += point.pqCode;
        workgroup.maximumRGBCode = Math.max(workgroup.maximumRGBCode, point.maximumRGBCode);
        if (cutoff > 0 && point.pqCode === 0) {
            workgroup.blackCount += 1;
        }
    }
    workgroup.bins[0] -= workgroup.blackCount;
    return workgroup;
}

/** Adds one workgroup into its slice of the accumulation, as its first invocation does. */
function accumulateReferenceWorkgroup(accumulation: Uint32Array, slice: number, workgroup: ReferenceWorkgroup, histogram: boolean): void {
    const offsets = PEAK_DETECTION_ACCUMULATION_OFFSETS;
    if (histogram) {
        accumulation.set(
            workgroup.bins.map((count: number, bin: number): number => accumulation[offsets.histogram + (slice * PEAK_DETECTION_HISTOGRAM_BINS) + bin] + count),
            offsets.histogram + (slice * PEAK_DETECTION_HISTOGRAM_BINS)
        );
    }
    const activeCount = WORKGROUP_INVOCATIONS - workgroup.blackCount;
    accumulation[offsets.workgroups + slice] += 1;
    accumulation[offsets.activeWorkgroups + slice] += Math.min(activeCount, 1);
    if (activeCount > 0) {
        accumulation[offsets.pqSum + slice] += Math.trunc(workgroup.pqSum / activeCount);
        accumulation[offsets.maximumRGB + slice] = Math.max(accumulation[offsets.maximumRGB + slice], workgroup.maximumRGBCode);
    }
}

/** Measures a frame as the measurement pass's workgroups do, and returns the accumulation buffer's words. */
export function measureReferenceFrame(
    frame: ReferenceFrame,
    luminanceCoefficients: RGBCoefficients,
    parameters: PeakDetectionParameters
): Uint32Array {
    const accumulation = new Uint32Array(PEAK_DETECTION_ACCUMULATION_WORD_COUNT);
    const histogram = usesPeakDetectionHistogram(parameters);
    const cutoff = Math.max(parameters.blackCutoff, 0) / 100;
    const workgroupsX = frame.width / PEAK_DETECTION_WORKGROUP_SIZE;
    const workgroupsY = frame.height / PEAK_DETECTION_WORKGROUP_SIZE;
    if (!Number.isInteger(workgroupsX) || !Number.isInteger(workgroupsY)) {
        throw new RangeError(`A reference frame covers whole workgroups, not ${frame.width}x${frame.height}`);
    }
    for (let workgroupIndex = 0; workgroupIndex < workgroupsX * workgroupsY; workgroupIndex += 1) {
        const workgroup = measureReferenceWorkgroup(
            frame,
            workgroupIndex % workgroupsX,
            Math.floor(workgroupIndex / workgroupsX),
            luminanceCoefficients,
            cutoff
        );
        accumulateReferenceWorkgroup(accumulation, workgroupIndex % PEAK_DETECTION_SLICES, workgroup, histogram);
    }
    return accumulation;
}

/** Returns the PQ the percentile of the accumulated maxRGB histogram falls at, libplacebo's measure_peak. */
function measureReferencePercentile(accumulation: Uint32Array, percentile: number, frameMaximumPQ: number): number {
    const binCounts: number[] = [];
    for (let bin = 0; bin < PEAK_DETECTION_HISTOGRAM_BINS; bin += 1) {
        let count = 0;
        for (let slice = 0; slice < PEAK_DETECTION_SLICES; slice += 1) {
            count += accumulation[PEAK_DETECTION_ACCUMULATION_OFFSETS.histogram + (slice * PEAK_DETECTION_HISTOGRAM_BINS) + bin];
        }
        binCounts.push(count);
    }
    const total = binCounts.reduce((sum: number, count: number): number => sum + count, 0);
    if (total === 0) {
        return frameMaximumPQ;
    }
    const target = Math.ceil(percentile / 100 * total);
    if (target >= total) {
        return frameMaximumPQ;
    }
    const binPQ = (bin: number): number => ((bin + PEAK_DETECTION_HISTOGRAM_BIAS) << HISTOGRAM_SHIFT) / PEAK_DETECTION_PQ_MAXIMUM;
    let sum = 0;
    for (let bin = 0; bin < PEAK_DETECTION_HISTOGRAM_BINS; bin += 1) {
        const next = sum + binCounts[bin];
        if (next < target) {
            sum = next;
            continue;
        }
        const countHigh = next + 1;
        const pqLow = binPQ(bin);
        const pqHigh = countHigh > total ? Math.max(frameMaximumPQ, pqLow) : binPQ(bin + 1);
        return mix(pqLow, pqHigh, (target - sum) / (countHigh - sum));
    }
    return frameMaximumPQ;
}

/**
 * Reduces a frame's accumulation into the next smoothed state, as the reduction pass and libplacebo's update_peak_buf do; an accumulation without
 * workgroups, which a draw that measured nothing leaves, keeps the state.
 */
export function reduceReferenceAccumulation(
    accumulation: Uint32Array,
    state: ReferencePeakState,
    parameters: PeakDetectionParameters
): ReferencePeakState {
    const offsets = PEAK_DETECTION_ACCUMULATION_OFFSETS;
    let workgroups = 0;
    let activeWorkgroups = 0;
    let pqSum = 0;
    let maximumRGB = 0;
    for (let slice = 0; slice < PEAK_DETECTION_SLICES; slice += 1) {
        workgroups += accumulation[offsets.workgroups + slice];
        activeWorkgroups += accumulation[offsets.activeWorkgroups + slice];
        pqSum += accumulation[offsets.pqSum + slice];
        maximumRGB = Math.max(maximumRGB, accumulation[offsets.maximumRGB + slice]);
    }
    if (workgroups === 0) {
        return state;
    }
    let averagePQ = PEAK_DETECTION_BLACK_PQ;
    let peakPQ = PEAK_DETECTION_BLACK_PQ;
    if (activeWorkgroups > 0) {
        averagePQ = pqSum / (activeWorkgroups * PEAK_DETECTION_PQ_MAXIMUM);
        peakPQ = encodePQ(maximumRGB / PEAK_DETECTION_LINEAR_MAXIMUM);
        if (usesPeakDetectionHistogram(parameters)) {
            peakPQ = measureReferencePercentile(accumulation, parameters.percentile, peakPQ);
        }
    }
    if (state.averagePQ === 0) {
        return { averagePQ, peakPQ };
    }
    const epsilon = 1 / PEAK_DETECTION_PQ_MAXIMUM;
    averagePQ = Math.abs(averagePQ - state.averagePQ) < epsilon ? state.averagePQ : averagePQ;
    peakPQ = Math.abs(peakPQ - state.peakPQ) < epsilon ? state.peakPQ : peakPQ;
    const coefficient = getPeakDetectionSmoothingCoefficient(parameters.smoothingPeriod);
    let stateAveragePQ = state.averagePQ + (coefficient * (averagePQ - state.averagePQ));
    let statePeakPQ = state.peakPQ + (coefficient * (peakPQ - state.peakPQ));
    if (parameters.sceneThresholdLow > 0 && parameters.sceneThresholdHigh > 0) {
        const delta = (activeWorkgroups / workgroups) * Math.abs(averagePQ - stateAveragePQ);
        const sceneMix = smoothstep(parameters.sceneThresholdLow / 100, parameters.sceneThresholdHigh / 100, delta);
        stateAveragePQ = mix(stateAveragePQ, averagePQ, sceneMix);
        statePeakPQ = mix(statePeakPQ, peakPQ, sceneMix);
    }
    return { averagePQ: stateAveragePQ, peakPQ: statePeakPQ };
}

/**
 * Returns the scene statistics a state sets: its peak as the input peak, at least paper white, and its average, at most that peak; null for the
 * empty state, which leaves the static settings.
 */
export function getReferenceToneMapping(state: ReferencePeakState, paperWhiteNits: number): ReferenceToneMapping | null {
    if (state.averagePQ === 0) {
        return null;
    }
    const inputPeakNits = Math.max(paperWhiteNits, applyPQEOTF(state.peakPQ));
    return { averageNits: Math.min(inputPeakNits, applyPQEOTF(state.averagePQ)), inputPeakNits };
}
