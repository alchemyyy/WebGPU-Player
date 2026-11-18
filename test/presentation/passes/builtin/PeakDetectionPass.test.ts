import { describe, expect, it } from 'vitest';

import { applyPQOETF, getLuminanceCoefficients, type ColorTriplet } from 'webgpu-player/color/ColorPipeline';
import {
    createPeakDetectionMeasureWGSL,
    createPeakDetectionReduceWGSL,
    getPeakDetectionSmoothingCoefficient,
    getPeakDetectionWorkgroupCounts,
    PEAK_DETECTION_ACCUMULATION_OFFSETS,
    PEAK_DETECTION_ACCUMULATION_WORD_COUNT,
    PEAK_DETECTION_BLACK_PQ,
    PEAK_DETECTION_HISTOGRAM_BIAS,
    PEAK_DETECTION_HISTOGRAM_BINS,
    PEAK_DETECTION_PARAMETERS,
    PEAK_DETECTION_PQ_MAXIMUM,
    PEAK_DETECTION_SLICES
} from 'webgpu-player/presentation/passes/builtin/PeakDetectionPass';

import {
    createUniformReferenceFrame,
    EMPTY_REFERENCE_PEAK_STATE,
    encodeNeutralNits,
    getReferenceToneMapping,
    measureReferenceFrame,
    reduceReferenceAccumulation,
    type ReferenceFrame,
    type ReferencePeakState
} from '../../../helpers/peakDetectionReference';

const BT2020_LUMINANCE = getLuminanceCoefficients('bt2020');
const SIGNAL_ENTRY_POINT = 'sampleBuiltinSignal';
// libplacebo's high-quality percentile, mpv's `--hdr-peak-percentile=99.995` in its high-quality profile
const HIGH_QUALITY_PERCENTILE = 99.995;
const PQ_CODE = 1 / PEAK_DETECTION_PQ_MAXIMUM;
const BLACK: ColorTriplet = [ 0, 0, 0 ];
const PAPER_WHITE_NITS = 203;
const DIM_NITS = 100;
const SLIGHTLY_BRIGHTER_NITS = 105;
const PICTURE_NITS = 200;
const BRIGHT_SCENE_NITS = 1_000;
const HIGHLIGHT_NITS = 4_000;
// 2 workgroups square, and a letterbox of it: a workgroup row of black above and below
const PICTURE_SIZE = 32;
const LETTERBOX_HEIGHT = 64;
const LETTERBOX_BAR = 16;
// 100 workgroups, 25600 points, of which one is a highlight
const HISTOGRAM_FRAME_SIZE = 160;

function measureAndReduce(
    frame: ReferenceFrame,
    state: ReferencePeakState = EMPTY_REFERENCE_PEAK_STATE,
    parameters = PEAK_DETECTION_PARAMETERS
): ReferencePeakState {
    return reduceReferenceAccumulation(measureReferenceFrame(frame, BT2020_LUMINANCE, parameters), state, parameters);
}

function createNeutralFrame(nits: number, size = PICTURE_SIZE): ReferenceFrame {
    return createUniformReferenceFrame(size, size, encodeNeutralNits(nits));
}

function sumSlices(accumulation: Uint32Array, offset: number): number {
    return accumulation.subarray(offset, offset + PEAK_DETECTION_SLICES).reduce((sum: number, word: number): number => sum + word, 0);
}

describe('PeakDetectionPass', () => {
    it('lays out libplacebo\'s accumulation: a word per slice of each count and sum, then each slice\'s histogram', () => {
        expect(PEAK_DETECTION_PARAMETERS).toEqual({ blackCutoff: 1, percentile: 100, sceneThresholdHigh: 3, sceneThresholdLow: 1, smoothingPeriod: 20 });
        expect(PEAK_DETECTION_HISTOGRAM_BINS).toBe(64);
        expect(PEAK_DETECTION_HISTOGRAM_BIAS).toBe(64);
        expect(PEAK_DETECTION_ACCUMULATION_WORD_COUNT).toBe(4 * PEAK_DETECTION_SLICES + (PEAK_DETECTION_SLICES * PEAK_DETECTION_HISTOGRAM_BINS));
        expect(getPeakDetectionSmoothingCoefficient(20)).toBeCloseTo(1 - Math.exp(-1 / 20), 15);
        expect(getPeakDetectionSmoothingCoefficient(0)).toBe(1);
    });

    it('dispatches a workgroup per 16x16 points of the presented region, at least one', () => {
        expect(getPeakDetectionWorkgroupCounts(3_840, 2_160)).toEqual([ 240, 135, 1 ]);
        expect(getPeakDetectionWorkgroupCounts(1_440, 540)).toEqual([ 90, 34, 1 ]);
        expect(getPeakDetectionWorkgroupCounts(0, 0)).toEqual([ 1, 1, 1 ]);
    });

    it('measures a frame\'s average PQ luminance and the PQ of its maxRGB, in their fixed-point codes', () => {
        const state = measureAndReduce(createNeutralFrame(DIM_NITS));

        expect(Math.abs(state.averagePQ - applyPQOETF(DIM_NITS))).toBeLessThan(PQ_CODE);
        // maxRGB keeps 16 bits over 10000 nits, 0.15 nits
        expect(state.peakPQ).toBeCloseTo(applyPQOETF(DIM_NITS), 3);
        expect(state.peakPQ).toBeLessThanOrEqual(applyPQOETF(DIM_NITS));
    });

    it('leaves black bars out of the average, as libplacebo\'s black cutoff leaves out workgroups of black', () => {
        const picture = encodeNeutralNits(PICTURE_NITS);
        const letterbox: ReferenceFrame = {
            height: LETTERBOX_HEIGHT,
            sample: (_x: number, y: number): ColorTriplet => (y < LETTERBOX_BAR || y >= LETTERBOX_HEIGHT - LETTERBOX_BAR ? BLACK : picture),
            width: PICTURE_SIZE
        };
        const accumulation = measureReferenceFrame(letterbox, BT2020_LUMINANCE, PEAK_DETECTION_PARAMETERS);

        expect(sumSlices(accumulation, PEAK_DETECTION_ACCUMULATION_OFFSETS.workgroups)).toBe(8);
        expect(sumSlices(accumulation, PEAK_DETECTION_ACCUMULATION_OFFSETS.activeWorkgroups)).toBe(4);
        expect(reduceReferenceAccumulation(accumulation, EMPTY_REFERENCE_PEAK_STATE, PEAK_DETECTION_PARAMETERS))
            .toEqual(measureAndReduce(createNeutralFrame(PICTURE_NITS)));
    });

    it('averages a workgroup over its points above the black cutoff, and over all of them without one', () => {
        const picture = encodeNeutralNits(PICTURE_NITS);
        const halfBlack: ReferenceFrame = { height: 16, sample: (x: number): ColorTriplet => (x < 8 ? BLACK : picture), width: 16 };
        const withoutCutoff = { ...PEAK_DETECTION_PARAMETERS, blackCutoff: 0 };

        expect(measureAndReduce(halfBlack).averagePQ).toBeCloseTo(measureAndReduce(createNeutralFrame(PICTURE_NITS)).averagePQ, 12);
        expect(measureAndReduce(halfBlack, EMPTY_REFERENCE_PEAK_STATE, withoutCutoff).averagePQ)
            .toBeCloseTo(measureAndReduce(createNeutralFrame(PICTURE_NITS)).averagePQ / 2, 3);
    });

    it('gives a solid black frame PL_COLOR_HDR_BLACK, which still counts as measured', () => {
        const state = measureAndReduce(createUniformReferenceFrame(PICTURE_SIZE, PICTURE_SIZE, BLACK));

        expect(state).toEqual({ averagePQ: PEAK_DETECTION_BLACK_PQ, peakPQ: PEAK_DETECTION_BLACK_PQ });
    });

    it('starts from the first measurement, holds a steady shot, and smooths small changes through libplacebo\'s IIR low pass', () => {
        const dim = measureAndReduce(createNeutralFrame(DIM_NITS));
        expect(measureAndReduce(createNeutralFrame(DIM_NITS), dim)).toEqual(dim);

        const brighterFrame = measureAndReduce(createNeutralFrame(SLIGHTLY_BRIGHTER_NITS));
        const smoothed = measureAndReduce(createNeutralFrame(SLIGHTLY_BRIGHTER_NITS), dim);
        const coefficient = getPeakDetectionSmoothingCoefficient(PEAK_DETECTION_PARAMETERS.smoothingPeriod);
        // Under the low scene threshold the frame only moves the state by the coefficient's share
        expect(smoothed.averagePQ).toBeCloseTo(dim.averagePQ + (coefficient * (brighterFrame.averagePQ - dim.averagePQ)), 12);
        expect(smoothed.peakPQ).toBeCloseTo(dim.peakPQ + (coefficient * (brighterFrame.peakPQ - dim.peakPQ)), 12);
    });

    it('resets to a frame past the high scene threshold, and fades the smoothing out between the thresholds', () => {
        const dim = measureAndReduce(createNeutralFrame(DIM_NITS));
        const bright = measureAndReduce(createNeutralFrame(BRIGHT_SCENE_NITS));
        expect(measureAndReduce(createNeutralFrame(BRIGHT_SCENE_NITS), dim)).toEqual(bright);

        // A change of 2% PQ after the low pass falls between libplacebo's 1% and 3%
        const coefficient = getPeakDetectionSmoothingCoefficient(PEAK_DETECTION_PARAMETERS.smoothingPeriod);
        const betweenPQ = dim.averagePQ + (0.02 / (1 - coefficient));
        const between = createUniformReferenceFrame(PICTURE_SIZE, PICTURE_SIZE, [ betweenPQ, betweenPQ, betweenPQ ]);
        const betweenFrame = measureAndReduce(between);
        const mixed = measureAndReduce(between, dim);
        expect(mixed.averagePQ).toBeGreaterThan(dim.averagePQ + (coefficient * (betweenFrame.averagePQ - dim.averagePQ)));
        expect(mixed.averagePQ).toBeLessThan(betweenFrame.averagePQ);
    });

    it('takes the percentile of the maxRGB histogram as the peak, spread evenly within its bin, so an isolated highlight sets no peak', () => {
        const dim = encodeNeutralNits(DIM_NITS);
        const highlight = encodeNeutralNits(HIGHLIGHT_NITS);
        const frame: ReferenceFrame = {
            height: HISTOGRAM_FRAME_SIZE,
            sample: (x: number, y: number): ColorTriplet => (x === 0 && y === 0 ? highlight : dim),
            width: HISTOGRAM_FRAME_SIZE
        };
        const highQuality = { ...PEAK_DETECTION_PARAMETERS, percentile: HIGH_QUALITY_PERCENTILE };

        expect(measureAndReduce(frame).peakPQ).toBeCloseTo(applyPQOETF(HIGHLIGHT_NITS), 3);
        // The dim points fill the bin from PQ code 65 << 7, and the target, 25599 of 25600 points, lies 25599/25600 of the way up it
        const binLow = (65 << 7) / PEAK_DETECTION_PQ_MAXIMUM;
        const binHigh = (66 << 7) / PEAK_DETECTION_PQ_MAXIMUM;
        expect(measureAndReduce(frame, EMPTY_REFERENCE_PEAK_STATE, highQuality).peakPQ).toBeCloseTo(binLow + ((binHigh - binLow) * 25_599 / 25_600), 12);
    });

    it('tone-maps from the smoothed peak, at least paper white, and the smoothed average, at most that peak', () => {
        const bright = measureAndReduce(createNeutralFrame(BRIGHT_SCENE_NITS));
        expect(getReferenceToneMapping(bright, PAPER_WHITE_NITS)?.inputPeakNits).toBeCloseTo(BRIGHT_SCENE_NITS, -1);
        expect(getReferenceToneMapping(bright, PAPER_WHITE_NITS)?.averageNits).toBeCloseTo(BRIGHT_SCENE_NITS, -1);
        const dim = measureAndReduce(createNeutralFrame(DIM_NITS));
        expect(getReferenceToneMapping(dim, PAPER_WHITE_NITS)?.inputPeakNits).toBe(PAPER_WHITE_NITS);
        // Before any measurement the static settings stay
        expect(getReferenceToneMapping(EMPTY_REFERENCE_PEAK_STATE, PAPER_WHITE_NITS)).toBeNull();
    });

    it('keeps the smoothed state through a draw that measured nothing, as a paused redraw leaves the accumulation', () => {
        const dim = measureAndReduce(createNeutralFrame(DIM_NITS));
        const smoothed = measureAndReduce(createNeutralFrame(SLIGHTLY_BRIGHTER_NITS), dim);
        const unmeasured = new Uint32Array(PEAK_DETECTION_ACCUMULATION_WORD_COUNT);

        expect(reduceReferenceAccumulation(unmeasured, smoothed, PEAK_DETECTION_PARAMETERS)).toBe(smoothed);
        expect(reduceReferenceAccumulation(unmeasured, EMPTY_REFERENCE_PEAK_STATE, PEAK_DETECTION_PARAMETERS)).toBe(EMPTY_REFERENCE_PEAK_STATE);
        const reduction = createPeakDetectionReduceWGSL();
        expect(reduction).toContain('if (workgroups > 0.0) {\n        state = updatePeakDetectionState(');
        expect(reduction).toContain('if (state.x == 0.0) {\n        return;\n    }\n    let inputPeakNits');
    });

    it('generates the measurement with libplacebo\'s black cutoff, and its histogram only for a percentile', () => {
        const measurement = createPeakDetectionMeasureWGSL(SIGNAL_ENTRY_POINT, BT2020_LUMINANCE);
        expect(measurement).toContain(`${SIGNAL_ENTRY_POINT}(point * presentation.textureScale + presentation.textureOffset).rgb`);
        expect(measurement).toContain('vec3f(0.262700000, 0.678000000, 0.059300000)');
        expect(measurement).toContain('luminancePQ *= smoothstep(0.0, 0.010000000, luminancePQ);');
        expect(measurement).toContain('@compute @workgroup_size(16, 16)');
        expect(measurement).not.toContain('peakWorkgroupHistogram');
        expect(createPeakDetectionMeasureWGSL(SIGNAL_ENTRY_POINT, BT2020_LUMINANCE, { ...PEAK_DETECTION_PARAMETERS, percentile: HIGH_QUALITY_PERCENTILE }))
            .toContain('atomicAdd(&peakWorkgroupHistogram[bin], 1u);');
        const withoutCutoff = createPeakDetectionMeasureWGSL(SIGNAL_ENTRY_POINT, BT2020_LUMINANCE, { ...PEAK_DETECTION_PARAMETERS, blackCutoff: 0 });
        expect(withoutCutoff).not.toContain('smoothstep');
        expect(withoutCutoff).not.toContain('atomicAdd(&peakWorkgroupBlackCount');
    });

    it('generates the reduction with libplacebo\'s smoothing and scene change, writing the scene statistics mode into the render settings', () => {
        const reduction = createPeakDetectionReduceWGSL();
        expect(reduction).toContain('var state = previousState + 0.048770575 * (vec2f(averagePQ, peakPQ) - previousState);');
        expect(reduction).toContain('smoothstep(0.010000000, 0.030000000, delta)');
        expect(reduction).toContain('writableRenderSettings.dynamicHDRMode = 1u;');
        expect(reduction).toContain('writableRenderSettings.inputPeakNits = inputPeakNits;');
        expect(reduction).not.toContain('measurePeakDetectionPercentile');
        expect(createPeakDetectionReduceWGSL({ ...PEAK_DETECTION_PARAMETERS, percentile: HIGH_QUALITY_PERCENTILE }))
            .toContain('peakPQ = measurePeakDetectionPercentile(peakPQ);');
        expect(createPeakDetectionReduceWGSL({ ...PEAK_DETECTION_PARAMETERS, sceneThresholdLow: 0 })).not.toContain('delta');
        expect(createPeakDetectionReduceWGSL({ ...PEAK_DETECTION_PARAMETERS, smoothingPeriod: 0 })).toContain('previousState + 1.000000000 *');
    });
});
