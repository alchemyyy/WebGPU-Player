// The built-in HDR peak detection: libplacebo's pl_shader_detect_peak and the smoothing of its update_peak_buf (src/shaders/colorspace.c), as two compute
// passes before a frame's own passes. The first measures the presented part of the frame on the route's signal into an accumulation buffer; the second
// reduces it, smooths it into the state buffer, which a plan keeps across frames, and writes the scene peak and average into the render settings the
// frame's tone mapping then reads, so a frame tone-maps from its own measurement without a readback. The Peak detection section of
// docs/src/architecture.md describes it, and the decisions chapter its libplacebo references.
import type { RGBCoefficients } from '../../../color/ColorPipeline';
import { BYTES_PER_WORD } from '../../WebGPUConstants';
import { toWGSLFloat } from './BuiltinWGSL';

/** libplacebo's pl_peak_detect_params, the defaults of PL_PEAK_DETECT_DEFAULTS and mpv's `--hdr-*` options. */
export type PeakDetectionParameters = Readonly<{
    /** Black cutoff, in PQ percent: luminance below it fades out of the measurement, and a black pixel counts nowhere; 0 disables it */
    blackCutoff: number
    /** The percentile of the frame's maxRGB histogram taken as its peak; 100 or 0 takes the brightest pixel and builds no histogram */
    percentile: number
    /** The frame brightness differences, in PQ percent, between which a scene change fades the smoothing out; either 0 disables it */
    sceneThresholdHigh: number
    sceneThresholdLow: number
    /** The time constant of the IIR low pass that smooths the measurement, in frames; 0 disables it */
    smoothingPeriod: number
}>;

/** libplacebo's PL_PEAK_DETECT_DEFAULTS, which mpv's `--hdr-compute-peak=auto` runs with: `--hdr-peak-decay-rate`, `--hdr-scene-threshold-*`, `--hdr-peak-percentile`. */
export const PEAK_DETECTION_PARAMETERS: PeakDetectionParameters = Object.freeze({
    blackCutoff: 1,
    percentile: 100,
    sceneThresholdHigh: 3,
    sceneThresholdLow: 1,
    smoothingPeriod: 20
});

/** The width and height of a measurement workgroup, libplacebo's 16x16; each invocation measures one point of the presented region. */
export const PEAK_DETECTION_WORKGROUP_SIZE = 16;
const WORKGROUP_INVOCATIONS = PEAK_DETECTION_WORKGROUP_SIZE * PEAK_DETECTION_WORKGROUP_SIZE;

/** Independent slices of the accumulation, which spread the global atomics, as libplacebo's SLICES. */
export const PEAK_DETECTION_SLICES = 12;
/** Fixed-point bits of a PQ luminance (PQ_BITS) and of a linear maxRGB over 10000 nits (LIN_BITS). */
export const PEAK_DETECTION_PQ_BITS = 14;
export const PEAK_DETECTION_PQ_MAXIMUM = (2 ** PEAK_DETECTION_PQ_BITS) - 1;
export const PEAK_DETECTION_LINEAR_BITS = 16;
export const PEAK_DETECTION_LINEAR_MAXIMUM = (2 ** PEAK_DETECTION_LINEAR_BITS) - 1;
/** The histogram's bits (HIST_BITS), biased down by half the PQ range so the SDR part of the frame falls into its first bin. */
export const PEAK_DETECTION_HISTOGRAM_BITS = 7;
export const PEAK_DETECTION_HISTOGRAM_BIAS = 2 ** (PEAK_DETECTION_HISTOGRAM_BITS - 1);
export const PEAK_DETECTION_HISTOGRAM_BINS = (2 ** PEAK_DETECTION_HISTOGRAM_BITS) - PEAK_DETECTION_HISTOGRAM_BIAS;
/** The PQ value libplacebo gives a solid black frame, PL_COLOR_HDR_BLACK, which also keeps a measured state apart from the empty one. */
export const PEAK_DETECTION_BLACK_PQ = 1e-6;

/** Where each field of the accumulation buffer starts, in words: a word per slice of each count and sum, then each slice's histogram. */
export const PEAK_DETECTION_ACCUMULATION_OFFSETS = Object.freeze({
    activeWorkgroups: PEAK_DETECTION_SLICES,
    histogram: 4 * PEAK_DETECTION_SLICES,
    maximumRGB: 3 * PEAK_DETECTION_SLICES,
    pqSum: 2 * PEAK_DETECTION_SLICES,
    workgroups: 0
});
/** The words of the accumulation buffer, which every measured frame starts from zero. */
export const PEAK_DETECTION_ACCUMULATION_WORD_COUNT = PEAK_DETECTION_ACCUMULATION_OFFSETS.histogram + (PEAK_DETECTION_SLICES * PEAK_DETECTION_HISTOGRAM_BINS);
export const PEAK_DETECTION_ACCUMULATION_BYTE_LENGTH = PEAK_DETECTION_ACCUMULATION_WORD_COUNT * BYTES_PER_WORD;

/** The smoothed state, in f32 words: the frame average and the peak in PQ, all 0 before the first measurement. */
export const PEAK_DETECTION_STATE_AVERAGE_PQ_INDEX = 0;
export const PEAK_DETECTION_STATE_PEAK_PQ_INDEX = 1;
export const PEAK_DETECTION_STATE_BYTE_LENGTH = 2 * BYTES_PER_WORD;

/** The variables the passes bind, which the planner declares at their bindings. */
const ACCUMULATION_VARIABLE = 'peakAccumulation';
const STATE_VARIABLE = 'peakState';
/** The render settings the reduction writes, which PassResources declares as the 'render-settings-storage' binding. */
const RENDER_SETTINGS_VARIABLE = 'writableRenderSettings';

/** Returns the coefficient of libplacebo's IIR low pass for a smoothing period in frames: 1 without smoothing. */
export function getPeakDetectionSmoothingCoefficient(smoothingPeriod: number): number {
    return smoothingPeriod === 0 ? 1 : 1 - Math.exp(-1 / smoothingPeriod);
}

/** Returns whether the parameters measure a histogram: a percentile strictly between 0 and 100, as libplacebo's use_histogram. */
export function usesPeakDetectionHistogram(parameters: PeakDetectionParameters): boolean {
    return parameters.percentile > 0 && parameters.percentile < 100;
}

/** Returns the workgroups that measure a presented region of a size in source pixels: one invocation per pixel, rounded up to whole workgroups. */
export function getPeakDetectionWorkgroupCounts(regionWidth: number, regionHeight: number): readonly [number, number, number] {
    return [
        Math.max(Math.ceil(regionWidth / PEAK_DETECTION_WORKGROUP_SIZE), 1),
        Math.max(Math.ceil(regionHeight / PEAK_DETECTION_WORKGROUP_SIZE), 1),
        1
    ];
}

/** Returns the declaration of the accumulation buffer at its binding: atomic words for the measurement, plain ones for the reduction. */
export function createPeakDetectionAccumulationWGSL(binding: number, atomic: boolean): string {
    const access = atomic ? 'read_write' : 'read';
    const word = atomic ? 'atomic<u32>' : 'u32';
    return `@group(0) @binding(${binding}) var<storage, ${access}> ${ACCUMULATION_VARIABLE}: array<${word}, ${PEAK_DETECTION_ACCUMULATION_WORD_COUNT}>;`;
}

/** Returns the declaration of the state buffer at its binding. */
export function createPeakDetectionStateWGSL(binding: number): string {
    return `@group(0) @binding(${binding}) var<storage, read_write> ${STATE_VARIABLE}: array<f32, ${PEAK_DETECTION_STATE_BYTE_LENGTH / BYTES_PER_WORD}>;`;
}

// SMPTE ST 2084 over 10000 nits, normalized both ways, as libplacebo's pq_eotf and pq_eotf_inv
const PQ_FUNCTIONS_WGSL = /* wgsl */ `
fn peakDetectionPQEOTF(encodedValue: f32) -> f32 {
    let inversePower = pow(clamp(encodedValue, 0.0, 1.0), 1.0 / (2523.0 / 32.0));
    let numerator = max(inversePower - (3424.0 / 4096.0), 0.0);
    let denominator = max((2413.0 / 128.0) - (2392.0 / 128.0) * inversePower, 0.0000001);
    return pow(numerator / denominator, 1.0 / (2610.0 / 16384.0));
}

fn peakDetectionPQInverseEOTF(normalizedValue: f32) -> f32 {
    let poweredValue = pow(clamp(normalizedValue, 0.0, 1.0), 2610.0 / 16384.0);
    return pow(((3424.0 / 4096.0) + (2413.0 / 128.0) * poweredValue) / (1.0 + (2392.0 / 128.0) * poweredValue), 2523.0 / 32.0);
}`;

/**
 * Returns the measurement's module code, one invocation per point of the presented region, evenly over it in workgroups of 16x16.
 * Each point decodes the signal's PQ 'source' RGB to linear light, and measures its luminance, through the source's luminance coefficients, and its
 * maxRGB, as libplacebo's pl_shader_detect_peak: the luminance in PQ fixed point, faded out below the black cutoff, sums per workgroup into the
 * workgroup's mean over its points above black, and maxRGB in linear fixed point takes its maximum and, with a percentile, its PQ histogram bin.
 * A workgroup of black points only counts as inactive. Each workgroup adds into the slice of its index.
 * It reads `presentation`, whose coordinate mapping takes a point of the presented region to the signal's coordinate, and the signal's entry point.
 */
export function createPeakDetectionMeasureWGSL(
    signalEntryPoint: string,
    luminanceCoefficients: RGBCoefficients,
    parameters: PeakDetectionParameters = PEAK_DETECTION_PARAMETERS
): string {
    const histogram = usesPeakDetectionHistogram(parameters);
    const cutoff = Math.max(parameters.blackCutoff, 0) / 100;
    const offsets = PEAK_DETECTION_ACCUMULATION_OFFSETS;
    const declarations = [
        'var<workgroup> peakWorkgroupPQSum: atomic<u32>;',
        'var<workgroup> peakWorkgroupMaximumRGB: atomic<u32>;',
        'var<workgroup> peakWorkgroupBlackCount: atomic<u32>;'
    ];
    if (histogram) {
        declarations.push(`var<workgroup> peakWorkgroupHistogram: array<atomic<u32>, ${PEAK_DETECTION_HISTOGRAM_BINS}>;`);
    }
    const histogramClear = histogram ?
        `    if (localIndex < ${PEAK_DETECTION_HISTOGRAM_BINS}u) {
        atomicStore(&peakWorkgroupHistogram[localIndex], 0u);
    }\n` :
        '';
    const cutoffFade = cutoff > 0 ?
        `    luminancePQ *= smoothstep(0.0, ${toWGSLFloat(cutoff)}, luminancePQ);\n` :
        '';
    // A point that fades to black counts in the first bin, which the merge takes the workgroup's black points out of again
    const blackBin = cutoff > 0 ? '    bin = select(bin, 0, pqCode == 0u);\n' : '';
    const histogramAdd = histogram ?
        `    var bin = (i32(${PEAK_DETECTION_PQ_MAXIMUM}.0 * peakDetectionPQInverseEOTF(maximumRGB)) >> ${PEAK_DETECTION_PQ_BITS - PEAK_DETECTION_HISTOGRAM_BITS}u) - ${PEAK_DETECTION_HISTOGRAM_BIAS};
    bin = clamp(bin, 0, ${PEAK_DETECTION_HISTOGRAM_BINS - 1});
${blackBin}    atomicAdd(&peakWorkgroupHistogram[bin], 1u);\n` :
        '';
    const blackCount = cutoff > 0 ?
        `    if (pqCode == 0u) {
        atomicAdd(&peakWorkgroupBlackCount, 1u);
    }\n` :
        '';
    // A black point's bin is the first, which loses them again, so black counts in no bin
    const histogramMerge = histogram ?
        `    if (localIndex < ${PEAK_DETECTION_HISTOGRAM_BINS}u) {
        var binCount = atomicLoad(&peakWorkgroupHistogram[localIndex]);
        if (localIndex == 0u) {
            binCount -= atomicLoad(&peakWorkgroupBlackCount);
        }
        atomicAdd(&${ACCUMULATION_VARIABLE}[${offsets.histogram}u + slice * ${PEAK_DETECTION_HISTOGRAM_BINS}u + localIndex], binCount);
    }\n` :
        '';
    return /* wgsl */ `${declarations.join('\n')}
${PQ_FUNCTIONS_WGSL}

@compute @workgroup_size(${PEAK_DETECTION_WORKGROUP_SIZE}, ${PEAK_DETECTION_WORKGROUP_SIZE})
fn computeMain(
    @builtin(global_invocation_id) invocation: vec3u,
    @builtin(local_invocation_index) localIndex: u32,
    @builtin(num_workgroups) workgroupCounts: vec3u,
    @builtin(workgroup_id) workgroup: vec3u
) {
    if (localIndex == 0u) {
        atomicStore(&peakWorkgroupPQSum, 0u);
        atomicStore(&peakWorkgroupMaximumRGB, 0u);
        atomicStore(&peakWorkgroupBlackCount, 0u);
    }
${histogramClear}    workgroupBarrier();
    let point = (vec2f(invocation.xy) + 0.5) / vec2f(workgroupCounts.xy * ${PEAK_DETECTION_WORKGROUP_SIZE}u);
    let encoded = ${signalEntryPoint}(point * presentation.textureScale + presentation.textureOffset).rgb;
    let linearRGB = vec3f(peakDetectionPQEOTF(encoded.r), peakDetectionPQEOTF(encoded.g), peakDetectionPQEOTF(encoded.b));
    let luminance = dot(linearRGB, vec3f(${toWGSLFloat(luminanceCoefficients.red)}, ${toWGSLFloat(luminanceCoefficients.green)}, ${toWGSLFloat(luminanceCoefficients.blue)}));
    let maximumRGB = clamp(max(linearRGB.r, max(linearRGB.g, linearRGB.b)), 0.0, 1.0);
    let linearCode = u32(${PEAK_DETECTION_LINEAR_MAXIMUM}.0 * maximumRGB);
    var luminancePQ = peakDetectionPQInverseEOTF(clamp(luminance, 0.0, 1.0));
${cutoffFade}    let pqCode = u32(${PEAK_DETECTION_PQ_MAXIMUM}.0 * luminancePQ);
${histogramAdd}    atomicAdd(&peakWorkgroupPQSum, pqCode);
    atomicMax(&peakWorkgroupMaximumRGB, linearCode);
${blackCount}    workgroupBarrier();
    let slice = (workgroup.y * workgroupCounts.x + workgroup.x) % ${PEAK_DETECTION_SLICES}u;
${histogramMerge}    if (localIndex == 0u) {
        let activeCount = ${WORKGROUP_INVOCATIONS}u - atomicLoad(&peakWorkgroupBlackCount);
        atomicAdd(&${ACCUMULATION_VARIABLE}[${offsets.workgroups}u + slice], 1u);
        atomicAdd(&${ACCUMULATION_VARIABLE}[${offsets.activeWorkgroups}u + slice], min(activeCount, 1u));
        if (activeCount > 0u) {
            atomicAdd(&${ACCUMULATION_VARIABLE}[${offsets.pqSum}u + slice], atomicLoad(&peakWorkgroupPQSum) / activeCount);
            atomicMax(&${ACCUMULATION_VARIABLE}[${offsets.maximumRGB}u + slice], atomicLoad(&peakWorkgroupMaximumRGB));
        }
    }
}`;
}

/** Returns libplacebo's measure_peak over the accumulation's histogram: the PQ the percentile falls at, spread evenly within its bin. */
function createPercentileWGSL(percentile: number): string {
    const offsets = PEAK_DETECTION_ACCUMULATION_OFFSETS;
    const binCount = `${ACCUMULATION_VARIABLE}[${offsets.histogram}u + slice * ${PEAK_DETECTION_HISTOGRAM_BINS}u + bin]`;
    const binPQ = (bin: string): string => (
        `f32((${bin} + ${PEAK_DETECTION_HISTOGRAM_BIAS}u) << ${PEAK_DETECTION_PQ_BITS - PEAK_DETECTION_HISTOGRAM_BITS}u) / ${PEAK_DETECTION_PQ_MAXIMUM}.0`
    );
    return /* wgsl */ `
fn measurePeakDetectionPercentile(frameMaximumPQ: f32) -> f32 {
    var total = 0u;
    for (var bin = 0u; bin < ${PEAK_DETECTION_HISTOGRAM_BINS}u; bin += 1u) {
        for (var slice = 0u; slice < ${PEAK_DETECTION_SLICES}u; slice += 1u) {
            total += ${binCount};
        }
    }
    if (total == 0u) {
        return frameMaximumPQ;
    }
    let targetCount = u32(ceil(${toWGSLFloat(percentile / 100)} * f32(total)));
    if (targetCount >= total) {
        return frameMaximumPQ;
    }
    var sum = 0u;
    for (var bin = 0u; bin < ${PEAK_DETECTION_HISTOGRAM_BINS}u; bin += 1u) {
        var next = sum;
        for (var slice = 0u; slice < ${PEAK_DETECTION_SLICES}u; slice += 1u) {
            next += ${binCount};
        }
        if (next < targetCount) {
            sum = next;
            continue;
        }
        let countHigh = next + 1u;
        let pqLow = ${binPQ('bin')};
        var pqHigh = ${binPQ('(bin + 1u)')};
        if (countHigh > total) {
            pqHigh = max(frameMaximumPQ, pqLow);
        }
        return mix(pqLow, pqHigh, f32(targetCount - sum) / f32(countHigh - sum));
    }
    return frameMaximumPQ;
}`;
}

/**
 * Returns the reduction's module code, one invocation, which runs after the measurement, as libplacebo's update_peak_buf.
 * It reduces the slices into the frame's average PQ luminance, the mean of its active workgroups' means, and its peak, the PQ of its maxRGB or of
 * the percentile, a solid black frame taking PL_COLOR_HDR_BLACK for both. The first measurement after a reset sets the state; later ones ignore a
 * change under one PQ code, pass through the IIR low pass, and then mix toward the frame by the scene change's smoothstep of how far the frame's
 * average moved from the smoothed one, weighted by the share of active workgroups.
 * An accumulation without workgroups, as a draw that measured nothing leaves it, keeps the state, as libplacebo ignores a buffer no frame wrote.
 * Unless the state is still empty, it then writes the smoothed peak as the input peak, at least paper white, and the smoothed average as the scene
 * average, at most the input peak, into the render settings with the scene statistics mode, as a frame's Dolby Vision L1 or HDR10+ scene
 * statistics set them; an empty state leaves the static settings.
 */
export function createPeakDetectionReduceWGSL(parameters: PeakDetectionParameters = PEAK_DETECTION_PARAMETERS): string {
    const offsets = PEAK_DETECTION_ACCUMULATION_OFFSETS;
    const histogram = usesPeakDetectionHistogram(parameters);
    const sceneChange = parameters.sceneThresholdLow > 0 && parameters.sceneThresholdHigh > 0;
    const smoothingCoefficient = toWGSLFloat(getPeakDetectionSmoothingCoefficient(parameters.smoothingPeriod));
    // libplacebo's thresholds are in units of 1% PQ
    const sceneChangeMix = sceneChange ?
        `    let delta = (activeWorkgroups / workgroups) * abs(averagePQ - state.x);
    let sceneMix = smoothstep(${toWGSLFloat(parameters.sceneThresholdLow / 100)}, ${toWGSLFloat(parameters.sceneThresholdHigh / 100)}, delta);
    state = mix(state, vec2f(averagePQ, peakPQ), sceneMix);\n` :
        '';
    return /* wgsl */ `${PQ_FUNCTIONS_WGSL}
${histogram ? createPercentileWGSL(parameters.percentile) : ''}

// Returns the smoothed state, the average then the peak in PQ, after a frame's measurement over its workgroups
fn updatePeakDetectionState(previousState: vec2f, workgroups: f32, activeWorkgroups: f32, pqSum: f32, maximumRGB: u32) -> vec2f {
    var averagePQ = ${toWGSLFloat(PEAK_DETECTION_BLACK_PQ)};
    var peakPQ = ${toWGSLFloat(PEAK_DETECTION_BLACK_PQ)};
    if (activeWorkgroups > 0.0) {
        averagePQ = pqSum / (activeWorkgroups * ${PEAK_DETECTION_PQ_MAXIMUM}.0);
        peakPQ = peakDetectionPQInverseEOTF(f32(maximumRGB) / ${PEAK_DETECTION_LINEAR_MAXIMUM}.0);
${histogram ? '        peakPQ = measurePeakDetectionPercentile(peakPQ);\n' : ''}    }
    if (previousState.x == 0.0) {
        return vec2f(averagePQ, peakPQ);
    }
    // Ignore a change under one PQ code, the measurement's rounding
    if (abs(averagePQ - previousState.x) < 1.0 / ${PEAK_DETECTION_PQ_MAXIMUM}.0) {
        averagePQ = previousState.x;
    }
    if (abs(peakPQ - previousState.y) < 1.0 / ${PEAK_DETECTION_PQ_MAXIMUM}.0) {
        peakPQ = previousState.y;
    }
    var state = previousState + ${smoothingCoefficient} * (vec2f(averagePQ, peakPQ) - previousState);
${sceneChangeMix}    return state;
}

@compute @workgroup_size(1)
fn computeMain() {
    var workgroups = 0.0;
    var activeWorkgroups = 0.0;
    var pqSum = 0.0;
    var maximumRGB = 0u;
    for (var slice = 0u; slice < ${PEAK_DETECTION_SLICES}u; slice += 1u) {
        workgroups += f32(${ACCUMULATION_VARIABLE}[${offsets.workgroups}u + slice]);
        activeWorkgroups += f32(${ACCUMULATION_VARIABLE}[${offsets.activeWorkgroups}u + slice]);
        pqSum += f32(${ACCUMULATION_VARIABLE}[${offsets.pqSum}u + slice]);
        maximumRGB = max(maximumRGB, ${ACCUMULATION_VARIABLE}[${offsets.maximumRGB}u + slice]);
    }
    var state = vec2f(${STATE_VARIABLE}[${PEAK_DETECTION_STATE_AVERAGE_PQ_INDEX}], ${STATE_VARIABLE}[${PEAK_DETECTION_STATE_PEAK_PQ_INDEX}]);
    if (workgroups > 0.0) {
        state = updatePeakDetectionState(state, workgroups, activeWorkgroups, pqSum, maximumRGB);
        ${STATE_VARIABLE}[${PEAK_DETECTION_STATE_AVERAGE_PQ_INDEX}] = state.x;
        ${STATE_VARIABLE}[${PEAK_DETECTION_STATE_PEAK_PQ_INDEX}] = state.y;
    }
    if (state.x == 0.0) {
        return;
    }
    let inputPeakNits = max(${RENDER_SETTINGS_VARIABLE}.paperWhiteNits, 10000.0 * peakDetectionPQEOTF(state.y));
    ${RENDER_SETTINGS_VARIABLE}.dynamicHDRMode = 1u;
    ${RENDER_SETTINGS_VARIABLE}.inputPeakNits = inputPeakNits;
    ${RENDER_SETTINGS_VARIABLE}.dynamicSceneAverageNits = min(inputPeakNits, 10000.0 * peakDetectionPQEOTF(state.x));
}`;
}
