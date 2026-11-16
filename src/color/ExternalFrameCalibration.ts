// Levels that correct the 10-bit codes the external routes recover from Chromium's texture of a hardware frame.
// Chromium converts a frame neutralized to limited BT.709 into an 8-bit texture before page shaders see it, and the external signals invert
// that conversion with BT.709's 10-bit limited-range levels. Where Chromium's own conversion uses other levels, each recovered component is off
// by a scale and an offset, which levels fitted to an authorization vector's known codes take off again.
import type { ColorTriplet } from './ColorPipeline';

/**
 * Per-component levels: a recovered luma, Cb, or Cr code times its gain, plus its offset in 10-bit codes, is the frame's own code.
 * Identity levels leave the recovery as it is.
 */
export type ExternalFrameCalibration = Readonly<{
    gain: ColorTriplet
    offset: ColorTriplet
}>;

/** A point of an authorization vector: the browser's encoded RGB there, and the 10-bit YUV codes the frame holds. */
export type ExternalFrameCalibrationSample = Readonly<{
    encodedRGB: ColorTriplet
    rawYUVCode: ColorTriplet
}>;

/** The levels fitted to a vector's samples, or why none fit. */
export type ExternalFrameCalibrationFit =
    | { calibration: ExternalFrameCalibration; failure: null }
    | { calibration: null; failure: string };

type ComponentLevels = { gain: number; offset: number };

/** One component's levels, or why they cannot be fitted. */
type ComponentFit = { failure: null; levels: ComponentLevels } | { failure: string; levels: null };

export const IDENTITY_EXTERNAL_FRAME_CALIBRATION: ExternalFrameCalibration = Object.freeze({
    gain: Object.freeze([ 1, 1, 1 ] as const),
    offset: Object.freeze([ 0, 0, 0 ] as const)
});

// BT.709's luma coefficients and color difference scales, and the 10-bit limited-range levels, as recoverLimitedRangeBT709YUV in BuiltinSignals.ts writes them
const BT709_RED_LUMA_COEFFICIENT = 0.2126;
const BT709_GREEN_LUMA_COEFFICIENT = 0.7152;
const BT709_BLUE_LUMA_COEFFICIENT = 0.0722;
const BT709_BLUE_DIFFERENCE_SCALE = 1.8556;
const BT709_RED_DIFFERENCE_SCALE = 1.5748;
const LIMITED_LUMA_BLACK_CODE = 64;
const LIMITED_LUMA_EXCURSION = 876;
const CHROMA_CENTER_CODE = 512;
const LIMITED_CHROMA_EXCURSION = 896;
// Levels no conversion's levels differ by, even full range taken for limited: a fit beyond them read something other than levels
const MINIMUM_GAIN = 0.8;
const MAXIMUM_GAIN = 1.25;
const MAXIMUM_OFFSET_CODES = 128;
const COMPONENT_NAMES = [ 'luma', 'Cb', 'Cr' ] as const;

/** Returns the 10-bit codes the external signals' BT.709 recovery reads from the browser's encoded RGB, before levels. */
export function recoverLimitedRangeBT709Codes(encodedRGB: ColorTriplet): ColorTriplet {
    const [ red, green, blue ] = encodedRGB;
    const luma = (BT709_RED_LUMA_COEFFICIENT * red) + (BT709_GREEN_LUMA_COEFFICIENT * green) + (BT709_BLUE_LUMA_COEFFICIENT * blue);
    return [
        (luma * LIMITED_LUMA_EXCURSION) + LIMITED_LUMA_BLACK_CODE,
        (((blue - luma) / BT709_BLUE_DIFFERENCE_SCALE) * LIMITED_CHROMA_EXCURSION) + CHROMA_CENTER_CODE,
        (((red - luma) / BT709_RED_DIFFERENCE_SCALE) * LIMITED_CHROMA_EXCURSION) + CHROMA_CENTER_CODE
    ];
}

/** Returns recovered codes with the levels applied, as the external signals apply them. */
export function applyExternalFrameCalibration(codes: ColorTriplet, calibration: ExternalFrameCalibration): ColorTriplet {
    return [
        (codes[0] * calibration.gain[0]) + calibration.offset[0],
        (codes[1] * calibration.gain[1]) + calibration.offset[1],
        (codes[2] * calibration.gain[2]) + calibration.offset[2]
    ];
}

/** Returns whether the browser left every channel of a sample's RGB unclipped, so the RGB still says which codes the frame holds there. */
export function isUnclippedExternalFrameRGB(encodedRGB: ColorTriplet): boolean {
    return encodedRGB.every((channel: number): boolean => channel > 0 && channel < 1);
}

function getMean(values: readonly number[]): number {
    return values.reduce((sum: number, value: number): number => sum + value, 0) / values.length;
}

// Fits one component's gain and offset by least squares
function fitComponentLevels(recoveredCodes: readonly number[], frameCodes: readonly number[], name: string): ComponentFit {
    const distinctCodeCount = new Set(frameCodes).size;
    if (distinctCodeCount < 2) {
        return { failure: `${name}: ${distinctCodeCount} distinct codes among ${frameCodes.length} unclipped samples, expected 2 or more`, levels: null };
    }
    const recoveredMean = getMean(recoveredCodes);
    const frameMean = getMean(frameCodes);
    let covariance = 0;
    let variance = 0;
    for (let sampleIndex = 0; sampleIndex < recoveredCodes.length; sampleIndex += 1) {
        const recoveredDeviation = recoveredCodes[sampleIndex] - recoveredMean;
        covariance += recoveredDeviation * (frameCodes[sampleIndex] - frameMean);
        variance += recoveredDeviation * recoveredDeviation;
    }
    const gain = covariance / variance;
    const offset = frameMean - (gain * recoveredMean);
    // A recovery that reads every code alike leaves a gain that is not finite, which the bounds refuse as well
    if (!(gain >= MINIMUM_GAIN && gain <= MAXIMUM_GAIN && Math.abs(offset) <= MAXIMUM_OFFSET_CODES)) {
        return {
            failure: `${name}: gain ${gain.toFixed(4)} and offset ${offset.toFixed(2)}, `
                + `expected a gain from ${MINIMUM_GAIN} to ${MAXIMUM_GAIN} and an offset within ${MAXIMUM_OFFSET_CODES} codes`,
            levels: null
        };
    }
    return { failure: null, levels: { gain, offset } };
}

/**
 * Fits each component's levels by least squares over the samples whose RGB the browser did not clip. It fails when a component has fewer than two
 * distinct codes among those samples, or when its levels are not ones a conversion could differ by.
 */
export function fitExternalFrameCalibration(samples: readonly ExternalFrameCalibrationSample[]): ExternalFrameCalibrationFit {
    const unclippedSamples = samples.filter((sample: ExternalFrameCalibrationSample): boolean => isUnclippedExternalFrameRGB(sample.encodedRGB));
    const recoveredCodes = unclippedSamples.map((sample: ExternalFrameCalibrationSample): ColorTriplet => recoverLimitedRangeBT709Codes(sample.encodedRGB));
    const levels: ComponentLevels[] = [];
    for (const [ componentIndex, name ] of COMPONENT_NAMES.entries()) {
        const componentFit = fitComponentLevels(
            recoveredCodes.map((codes: ColorTriplet): number => codes[componentIndex]),
            unclippedSamples.map((sample: ExternalFrameCalibrationSample): number => sample.rawYUVCode[componentIndex]),
            name
        );
        if (componentFit.levels === null) {
            return { calibration: null, failure: componentFit.failure };
        }
        levels.push(componentFit.levels);
    }
    const [ luma, chromaBlue, chromaRed ] = levels;
    return {
        calibration: {
            gain: [ luma.gain, chromaBlue.gain, chromaRed.gain ],
            offset: [ luma.offset, chromaBlue.offset, chromaRed.offset ]
        },
        failure: null
    };
}
