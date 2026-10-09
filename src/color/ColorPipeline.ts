import {
    assertValidRenderSettings,
    RENDER_SETTINGS_VERSION,
    type DisplaySettings,
    type HDRToSDRRenderSettings,
    type RenderSettings,
    type ToneMappingSettings
} from '../presentation/RenderSettings';
import {
    assertValidInputColorMetadata,
    type ColorPrimaries,
    type InputColorMetadata,
    type YUVMatrix
} from './ColorMetadata';

export type ColorTriplet = readonly [number, number, number];
export type ReferenceSDROutputTransfer = 'bt709' | 'srgb';

const ACES_A = 2.51;
const ACES_B = 0.03;
const ACES_C = 2.43;
const ACES_D = 0.59;
const ACES_E = 0.14;
const HLG_A = 0.17883277;
const HLG_B = 1 - (4 * HLG_A);
const HLG_C = 0.5 - (HLG_A * Math.log(4 * HLG_A));
const PQ_C1 = 3424 / 4096;
const PQ_C2 = 2413 / 128;
const PQ_C3 = 2392 / 128;
const PQ_M1 = 2610 / 16384;
const PQ_M2 = 2523 / 32;
const PQ_PEAK_NITS = 10_000;
const HDR_BLACK_NITS = 0.000_001;
const SDR_CONTRAST = 1_000;
const SPLINE_KNEE_ADAPTATION = 0.4;
const SPLINE_KNEE_DEFAULT = 0.4;
const SPLINE_KNEE_MAXIMUM = 0.8;
const SPLINE_KNEE_MINIMUM = 0.1;
const SPLINE_SLOPE_OFFSET = 0.2;
const SPLINE_SLOPE_TUNING = 1.5;
const SPLINE_CONTRAST = 0.5;

export type ColorMatrix = readonly [ColorTriplet, ColorTriplet, ColorTriplet];
type LegacyToneMapOperator = Exclude<ToneMappingSettings['operator'], 'spline'>;

/** Red, green, and blue weights of a luminance or luma sum. */
export type RGBCoefficients = Readonly<{
    blue: number
    green: number
    red: number
}>;

// Relative luminance, the Y row of RGB to XYZ, of each primaries set from its H.273 chromaticities under D65
const BT709_LUMINANCE_COEFFICIENTS: RGBCoefficients = { blue: 0.0722, green: 0.7152, red: 0.2126 };
const BT2020_LUMINANCE_COEFFICIENTS: RGBCoefficients = { blue: 0.0593, green: 0.6780, red: 0.2627 };
const SMPTE170M_LUMINANCE_COEFFICIENTS: RGBCoefficients = {
    blue: 0.086564,
    green: 0.701060,
    red: 0.212376
};
const BT470BG_LUMINANCE_COEFFICIENTS: RGBCoefficients = {
    blue: 0.071341,
    green: 0.706655,
    red: 0.222004
};
// BT.601 fixes Kr and Kb for both its 525 and 625-line primaries, so its matrix is not their luminance
const BT601_MATRIX_COEFFICIENTS: RGBCoefficients = { blue: 0.114, green: 0.587, red: 0.299 };

// Linear-light conversions between each primaries set and BT.709, from the H.273 chromaticities under D65
const BT2020_TO_BT709_GAMUT: ColorMatrix = [
    [ 1.660491, -0.587641, -0.072850 ],
    [ -0.124550, 1.132900, -0.008349 ],
    [ -0.018151, -0.100579, 1.118730 ]
];
const SMPTE170M_TO_BT709_GAMUT: ColorMatrix = [
    [ 0.939542, 0.050181, 0.010277 ],
    [ 0.017772, 0.965793, 0.016435 ],
    [ -0.001622, -0.004370, 1.005991 ]
];
const BT470BG_TO_BT709_GAMUT: ColorMatrix = [
    [ 1.044043, -0.044043, 0 ],
    [ 0, 1, 0 ],
    [ 0, 0.011793, 0.988207 ]
];
const BT709_TO_BT2020_GAMUT: ColorMatrix = [
    [ 0.627404, 0.329283, 0.043313 ],
    [ 0.069097, 0.919540, 0.011362 ],
    [ 0.016391, 0.088013, 0.895595 ]
];
const BT709_TO_SMPTE170M_GAMUT: ColorMatrix = [
    [ 1.065379, -0.055401, -0.009978 ],
    [ -0.019633, 1.036363, -0.016731 ],
    [ 0.001632, 0.004412, 0.993956 ]
];
const BT709_TO_BT470BG_GAMUT: ColorMatrix = [
    [ 0.957815, 0.042185, 0 ],
    [ 0, 1, 0 ],
    [ 0, -0.011934, 1.011934 ]
];

// libplacebo IPTPQc4 HPE matrices with four percent cone crosstalk
const BT709_RGB_TO_IPT_LMS: ColorMatrix = [
    [ 0.295764080594, 0.623072450736, 0.081166749035 ],
    [ 0.156191976513, 0.727251644307, 0.116557934317 ],
    [ 0.035102284710, 0.156589948771, 0.808303025242 ]
];
const BT2020_RGB_TO_IPT_LMS: ColorMatrix = [
    [ 0.412036386719, 0.523911912035, 0.064054981611 ],
    [ 0.166660218723, 0.720395213485, 0.112946122929 ],
    [ 0.024112358560, 0.075474962757, 0.900407937406 ]
];
// BT709_RGB_TO_IPT_LMS times the exact BT.601 to BT.709 gamut conversion
const SMPTE170M_RGB_TO_IPT_LMS: ColorMatrix = [
    [ 0.288824557305, 0.616246090240, 0.094932632820 ],
    [ 0.159484800122, 0.709703043629, 0.130813711386 ],
    [ 0.034452280391, 0.149462853268, 0.816080125064 ]
];
const BT470BG_RGB_TO_IPT_LMS: ColorMatrix = [
    [ 0.308790479740, 0.611003281765, 0.080209518860 ],
    [ 0.163071172342, 0.721747060290, 0.115183322506 ],
    [ 0.036648301964, 0.164576554862, 0.798770401897 ]
];
const IPT_LMS_TO_BT709_RGB: ColorMatrix = [
    [ 6.173532657683, -5.320898820809, 0.147354885063 ],
    [ -1.324031910094, 2.560269770177, -0.236238618417 ],
    [ -0.011598387923, -0.264921446713, 1.276526337036 ]
];
const IPT_LMS_TO_BT2020_RGB: ColorMatrix = [
    [ 3.436814829107, -2.506773801082, 0.069951928006 ],
    [ -0.791058237834, 1.983601669423, -0.192544834310 ],
    [ -0.025726806109, -0.099141766410, 1.124874144431 ]
];
// The exact BT.709 to BT.601 gamut conversion times IPT_LMS_TO_BT709_RGB
const IPT_LMS_TO_SMPTE170M_RGB: ColorMatrix = [
    [ 6.650620511838, -5.807971795602, 0.157339245483 ],
    [ -1.493185948114, 2.762264193554, -0.269078918721 ],
    [ -0.007294884663, -0.260707262076, 1.268008588083 ]
];
const IPT_LMS_TO_BT470BG_RGB: ColorMatrix = [
    [ 5.857246129788, -4.988429866809, 0.131172902735 ],
    [ -1.324031910094, 2.560269770177, -0.236238618417 ],
    [ 0.004064353714, -0.298637623081, 1.294579858417 ]
];
const IPT_LMS_TO_IPT: ColorMatrix = [
    [ 0.4, 0.4, 0.2 ],
    [ 4.455, -4.851, 0.396 ],
    [ 0.8056, 0.3572, -1.1628 ]
];
const IPT_TO_IPT_LMS: ColorMatrix = [
    [ 1, 0.0975689, 0.205226 ],
    [ 1, -0.113876, 0.133217 ],
    [ 1, 0.0326151, -0.676887 ]
];

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}

function mapTriplet(value: ColorTriplet, transform: (component: number) => number): ColorTriplet {
    return [ transform(value[0]), transform(value[1]), transform(value[2]) ];
}

function mix(firstValue: number, secondValue: number, amount: number): number {
    return firstValue + ((secondValue - firstValue) * amount);
}

function multiplyColorMatrix(matrix: ColorMatrix, value: ColorTriplet): ColorTriplet {
    return [
        (matrix[0][0] * value[0]) + (matrix[0][1] * value[1]) + (matrix[0][2] * value[2]),
        (matrix[1][0] * value[0]) + (matrix[1][1] * value[1]) + (matrix[1][2] * value[2]),
        (matrix[2][0] * value[0]) + (matrix[2][1] * value[1]) + (matrix[2][2] * value[2])
    ];
}

function smoothstep(edge0: number, edge1: number, value: number): number {
    if (edge0 === edge1) {
        return value >= edge0 ? 1 : 0;
    }

    const normalizedValue = clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return normalizedValue * normalizedValue * (3 - (2 * normalizedValue));
}

/** Returns the relative luminance weights of linear RGB in a primaries set. */
export function getLuminanceCoefficients(primaries: ColorPrimaries): RGBCoefficients {
    switch (primaries) {
        case 'bt2020':
            return BT2020_LUMINANCE_COEFFICIENTS;
        case 'bt470bg':
            return BT470BG_LUMINANCE_COEFFICIENTS;
        case 'bt709':
            return BT709_LUMINANCE_COEFFICIENTS;
        case 'smpte170m':
            return SMPTE170M_LUMINANCE_COEFFICIENTS;
    }
}

/** Returns the Kr, Kg, and Kb weights of a YUV matrix; the matrix selects them, not the primaries. */
export function getYUVMatrixCoefficients(matrix: YUVMatrix): RGBCoefficients {
    switch (matrix) {
        // BT.709 and BT.2020 define their matrices from their own primaries' luminance
        case 'bt2020-ncl':
            return BT2020_LUMINANCE_COEFFICIENTS;
        case 'bt709':
            return BT709_LUMINANCE_COEFFICIENTS;
        case 'bt470bg':
        case 'smpte170m':
            return BT601_MATRIX_COEFFICIENTS;
    }
}

/** Returns the linear-light conversion from a primaries set to BT.709, or null for BT.709 itself. */
export function getGamutToBT709Matrix(primaries: ColorPrimaries): ColorMatrix | null {
    switch (primaries) {
        case 'bt2020':
            return BT2020_TO_BT709_GAMUT;
        case 'bt470bg':
            return BT470BG_TO_BT709_GAMUT;
        case 'bt709':
            return null;
        case 'smpte170m':
            return SMPTE170M_TO_BT709_GAMUT;
    }
}

/** Returns the linear-light conversion from BT.709 to a primaries set, or null for BT.709 itself. */
export function getGamutFromBT709Matrix(primaries: ColorPrimaries): ColorMatrix | null {
    switch (primaries) {
        case 'bt2020':
            return BT709_TO_BT2020_GAMUT;
        case 'bt470bg':
            return BT709_TO_BT470BG_GAMUT;
        case 'bt709':
            return null;
        case 'smpte170m':
            return BT709_TO_SMPTE170M_GAMUT;
    }
}

function calculateLuminance(linearRGB: ColorTriplet, primaries: ColorPrimaries): number {
    const coefficients = getLuminanceCoefficients(primaries);
    return (linearRGB[0] * coefficients.red) + (linearRGB[1] * coefficients.green) + (linearRGB[2] * coefficients.blue);
}

function applyHLGInverseOETF(encodedValue: number): number {
    const clampedValue = clamp(encodedValue, 0, 1);
    if (clampedValue <= 0.5) {
        return (clampedValue * clampedValue) / 3;
    }

    return (Math.exp((clampedValue - HLG_C) / HLG_A) + HLG_B) / 12;
}

function evaluateToneMapCurve(normalizedLuminance: number, operator: LegacyToneMapOperator): number {
    const nonNegativeLuminance = Math.max(normalizedLuminance, 0);
    switch (operator) {
        case 'aces':
            return clamp(
                (nonNegativeLuminance * ((ACES_A * nonNegativeLuminance) + ACES_B))
                    / ((nonNegativeLuminance * ((ACES_C * nonNegativeLuminance) + ACES_D)) + ACES_E),
                0,
                1
            );
        case 'reinhard':
            return nonNegativeLuminance / (1 + nonNegativeLuminance);
    }
}

/** Expands normalized digital YUV codes into full-range luma and centered chroma. */
export function expandYUVRange(encodedYUV: ColorTriplet, metadata: InputColorMetadata): ColorTriplet {
    assertValidInputColorMetadata(metadata);
    const maximumCode = (2 ** metadata.bitDepth) - 1;
    const chromaCenterCode = 2 ** (metadata.bitDepth - 1);
    if (metadata.range === 'full') {
        return [
            encodedYUV[0],
            encodedYUV[1] - (chromaCenterCode / maximumCode),
            encodedYUV[2] - (chromaCenterCode / maximumCode)
        ];
    }

    const codeScale = 2 ** (metadata.bitDepth - 8);
    const lumaBlackCode = 16 * codeScale;
    const lumaWhiteCode = 235 * codeScale;
    const chromaExcursion = 224 * codeScale;
    return [
        ((encodedYUV[0] * maximumCode) - lumaBlackCode) / (lumaWhiteCode - lumaBlackCode),
        ((encodedYUV[1] * maximumCode) - chromaCenterCode) / chromaExcursion,
        ((encodedYUV[2] * maximumCode) - chromaCenterCode) / chromaExcursion
    ];
}

/** Converts full-range YUV into nonlinear RGB without clipping legal overshoot. */
export function convertYUVToEncodedRGB(expandedYUV: ColorTriplet, matrix: YUVMatrix): ColorTriplet {
    const matrixCoefficients = getYUVMatrixCoefficients(matrix);
    const luma = expandedYUV[0];
    const blueDifference = expandedYUV[1];
    const redDifference = expandedYUV[2];
    const red = luma + (2 * (1 - matrixCoefficients.red) * redDifference);
    const blue = luma + (2 * (1 - matrixCoefficients.blue) * blueDifference);
    const green = (luma - (matrixCoefficients.red * red) - (matrixCoefficients.blue * blue)) / matrixCoefficients.green;
    return [ red, green, blue ];
}

/** Applies the SMPTE ST 2084 EOTF and returns absolute luminance in nits. */
export function applyPQEOTF(encodedValue: number): number {
    const clampedValue = clamp(encodedValue, 0, 1);
    const inversePower = clampedValue ** (1 / PQ_M2);
    const numerator = Math.max(inversePower - PQ_C1, 0);
    const denominator = Math.max(PQ_C2 - (PQ_C3 * inversePower), Number.EPSILON);
    return PQ_PEAK_NITS * ((numerator / denominator) ** (1 / PQ_M1));
}

/** Applies the SMPTE ST 2084 inverse EOTF to absolute luminance in nits. */
export function applyPQOETF(luminanceNits: number): number {
    if (!Number.isFinite(luminanceNits)) {
        throw new RangeError('PQ luminance must be finite');
    }

    const normalizedLuminance = clamp(luminanceNits / PQ_PEAK_NITS, 0, 1);
    const poweredLuminance = normalizedLuminance ** PQ_M1;
    const encodedValue = (PQ_C1 + (PQ_C2 * poweredLuminance)) / (1 + (PQ_C3 * poweredLuminance));
    return encodedValue ** PQ_M2;
}

/** Returns the conversion from linear RGB in a primaries set to IPTPQc4 LMS. */
export function getRGBToIPTLMSMatrix(primaries: ColorPrimaries): ColorMatrix {
    switch (primaries) {
        case 'bt2020':
            return BT2020_RGB_TO_IPT_LMS;
        case 'bt470bg':
            return BT470BG_RGB_TO_IPT_LMS;
        case 'bt709':
            return BT709_RGB_TO_IPT_LMS;
        case 'smpte170m':
            return SMPTE170M_RGB_TO_IPT_LMS;
    }
}

function getIPTLMSToRGBMatrix(primaries: ColorPrimaries): ColorMatrix {
    switch (primaries) {
        case 'bt2020':
            return IPT_LMS_TO_BT2020_RGB;
        case 'bt470bg':
            return IPT_LMS_TO_BT470BG_RGB;
        case 'bt709':
            return IPT_LMS_TO_BT709_RGB;
        case 'smpte170m':
            return IPT_LMS_TO_SMPTE170M_RGB;
    }
}

/** Converts absolute linear RGB into libplacebo-compatible IPTPQc4 coordinates. */
export function convertLinearRGBNitsToIPTPQ(linearRGBNits: ColorTriplet, primaries: ColorPrimaries): ColorTriplet {
    const nonNegativeRGB = mapTriplet(linearRGBNits, (component: number): number => Math.max(component, 0));
    const linearLMS = multiplyColorMatrix(getRGBToIPTLMSMatrix(primaries), nonNegativeRGB);
    const encodedLMS = mapTriplet(linearLMS, applyPQOETF);
    return multiplyColorMatrix(IPT_LMS_TO_IPT, encodedLMS);
}

/** Converts IPTPQc4 coordinates into absolute linear RGB for the selected gamut. */
export function convertIPTPQToLinearRGBNits(perceptualColor: ColorTriplet, primaries: ColorPrimaries): ColorTriplet {
    const encodedLMS = multiplyColorMatrix(IPT_TO_IPT_LMS, perceptualColor);
    const linearLMS = mapTriplet(encodedLMS, applyPQEOTF);
    return multiplyColorMatrix(getIPTLMSToRGBMatrix(primaries), linearLMS);
}

/** Evaluates libplacebo's static single-pivot spline in PQ space. */
export function evaluateSplineToneMapPQ(
    inputIntensityPQ: number,
    inputPeakNits: number,
    outputPeakNits: number
): number {
    if (!Number.isFinite(inputIntensityPQ)
        || !Number.isFinite(inputPeakNits)
        || !Number.isFinite(outputPeakNits)
        || inputPeakNits <= 0
        || outputPeakNits <= 0) {
        throw new RangeError('Spline tone-map values must be positive and finite');
    }

    // Match libplacebo's nominal PQ and SDR black points before constructing the spline.
    // These offsets are significant because the curve is in PQ
    const inputMinimum = applyPQOETF(HDR_BLACK_NITS);
    const inputMaximum = applyPQOETF(inputPeakNits);
    const outputMinimum = applyPQOETF(outputPeakNits / SDR_CONTRAST);
    const outputMaximum = applyPQOETF(outputPeakNits);
    const sourcePivot = mix(inputMinimum, inputMaximum, SPLINE_KNEE_DEFAULT);
    const sourceTarget = (sourcePivot - inputMinimum) / (inputMaximum - inputMinimum);
    const adaptedPivot = mix(outputMinimum, outputMaximum, sourceTarget);
    const tuning = 1 - (
        smoothstep(SPLINE_KNEE_MAXIMUM, SPLINE_KNEE_DEFAULT, sourceTarget)
        * smoothstep(SPLINE_KNEE_MINIMUM, SPLINE_KNEE_DEFAULT, sourceTarget)
    );
    const adaptation = mix(SPLINE_KNEE_ADAPTATION, 1, tuning);
    const destinationPivot = clamp(
        mix(sourcePivot, adaptedPivot, adaptation),
        mix(outputMinimum, outputMaximum, SPLINE_KNEE_MINIMUM),
        mix(outputMinimum, outputMaximum, SPLINE_KNEE_MAXIMUM)
    );
    const linearSlope = (destinationPivot - outputMinimum) / (sourcePivot - inputMinimum);
    const peakRatio = (inputMaximum / outputMaximum) - 1;
    const slopeRatio = clamp(SPLINE_SLOPE_TUNING * peakRatio, SPLINE_SLOPE_OFFSET, 1 + SPLINE_SLOPE_OFFSET);
    const pivotSlope = linearSlope ** ((1 - SPLINE_CONTRAST) * slopeRatio);

    const inputMinimumOffset = inputMinimum - sourcePivot;
    const inputMaximumOffset = inputMaximum - sourcePivot;
    const outputMinimumOffset = outputMinimum - destinationPivot;
    const outputMaximumOffset = outputMaximum - destinationPivot;
    const lowerQuadratic = (outputMinimumOffset - (pivotSlope * inputMinimumOffset)) / (inputMinimumOffset * inputMinimumOffset);
    const upperDenominator = 2 * inputMaximumOffset * inputMaximumOffset;
    const upperCubic = ((pivotSlope * inputMaximumOffset) - outputMaximumOffset) / (inputMaximumOffset * upperDenominator);
    const upperQuadratic = -3 * ((pivotSlope * inputMaximumOffset) - outputMaximumOffset) / upperDenominator;

    const inputOffset = clamp(inputIntensityPQ, inputMinimum, inputMaximum) - sourcePivot;
    const mappedOffset = inputOffset > 0 ?
        (((upperCubic * inputOffset) + upperQuadratic) * inputOffset + pivotSlope) * inputOffset :
        ((lowerQuadratic * inputOffset) + pivotSlope) * inputOffset;
    return clamp(mappedOffset + destinationPivot, outputMinimum, outputMaximum);
}

/** Applies the BT.709 inverse transfer function and scales it to reference white. */
export function applySDREOTF(encodedValue: number, referenceWhiteNits: number): number {
    if (!Number.isFinite(referenceWhiteNits) || referenceWhiteNits <= 0) {
        throw new RangeError('SDR reference white must be positive and finite');
    }

    const linearValue = encodedValue < 0.081 ?
        encodedValue / 4.5 :
        ((encodedValue + 0.099) / 1.099) ** (1 / 0.45);
    return linearValue * referenceWhiteNits;
}

/** Decodes nonlinear RGB into absolute linear-light RGB in nits. */
export function decodeEncodedRGBToNits(encodedRGB: ColorTriplet, metadata: InputColorMetadata): ColorTriplet {
    assertValidInputColorMetadata(metadata);
    switch (metadata.transfer) {
        case 'pq':
            return mapTriplet(encodedRGB, applyPQEOTF);
        case 'sdr':
            return mapTriplet(encodedRGB, (component: number): number => applySDREOTF(component, metadata.sdrReferenceWhiteNits));
        case 'hlg': {
            const sceneLinearRGB = mapTriplet(encodedRGB, applyHLGInverseOETF);
            const sceneLuminance = Math.max(calculateLuminance(sceneLinearRGB, metadata.primaries), 0);
            if (sceneLuminance === 0) {
                return [ 0, 0, 0 ];
            }

            const systemGamma = 1.2 + (0.42 * Math.log10(metadata.nominalPeakNits / 1_000));
            const luminanceScale = metadata.nominalPeakNits * (sceneLuminance ** (systemGamma - 1));
            return mapTriplet(sceneLinearRGB, (component: number): number => component * luminanceScale);
        }
    }
}

/** Converts linear-light RGB between the supported display primaries. */
export function convertLinearRGBGamut(
    linearRGB: ColorTriplet,
    sourcePrimaries: ColorPrimaries,
    destinationPrimaries: ColorPrimaries
): ColorTriplet {
    if (sourcePrimaries === destinationPrimaries) {
        return [ linearRGB[0], linearRGB[1], linearRGB[2] ];
    }

    // Every conversion passes through BT.709, so each primaries set needs only its two BT.709 matrices
    const toBT709Matrix = getGamutToBT709Matrix(sourcePrimaries);
    const linearBT709RGB = toBT709Matrix ?
        multiplyColorMatrix(toBT709Matrix, linearRGB) :
        linearRGB;
    const fromBT709Matrix = getGamutFromBT709Matrix(destinationPrimaries);
    return fromBT709Matrix ?
        multiplyColorMatrix(fromBT709Matrix, linearBT709RGB) :
        [ linearBT709RGB[0], linearBT709RGB[1], linearBT709RGB[2] ];
}

function calculateIPTChromaHull(intensity: number): number {
    return ((intensity - 6) * intensity + 9) * intensity;
}

function calculateComponentGamutScale(
    component: number,
    neutralComponent: number,
    outputPeakNits: number
): number {
    const chromaDelta = component - neutralComponent;
    if (component > outputPeakNits && chromaDelta > 0) {
        return (outputPeakNits - neutralComponent) / chromaDelta;
    }
    if (component < 0 && chromaDelta < 0) {
        return -neutralComponent / chromaDelta;
    }
    return 1;
}

function perceptuallyMapIPTPQToBT709(perceptualColor: ColorTriplet, settings: ToneMappingSettings): ColorTriplet {
    const targetRGB = convertIPTPQToLinearRGBNits(perceptualColor, 'bt709');
    const neutralRGB = convertIPTPQToLinearRGBNits([ perceptualColor[0], 0, 0 ], 'bt709');
    let hardChromaScale = 1;
    for (let componentIndex = 0; componentIndex < 3; componentIndex++) {
        hardChromaScale = Math.min(
            hardChromaScale,
            calculateComponentGamutScale(
                targetRGB[componentIndex],
                neutralRGB[componentIndex],
                settings.outputPeakNits
            )
        );
    }
    hardChromaScale = clamp(hardChromaScale, 0, 1);

    // Preserve in-gamut colors and progressively compress extreme chroma
    const outOfGamutAmount = 1 - hardChromaScale;
    const perceptualChromaScale = hardChromaScale * (1 - (settings.desaturationStrength * outOfGamutAmount * outOfGamutAmount));
    return [
        clamp(neutralRGB[0] + ((targetRGB[0] - neutralRGB[0]) * perceptualChromaScale), 0, settings.outputPeakNits),
        clamp(neutralRGB[1] + ((targetRGB[1] - neutralRGB[1]) * perceptualChromaScale), 0, settings.outputPeakNits),
        clamp(neutralRGB[2] + ((targetRGB[2] - neutralRGB[2]) * perceptualChromaScale), 0, settings.outputPeakNits)
    ];
}

function toneMapSplinePerceptualToSDR(
    linearInputNits: ColorTriplet,
    sourcePrimaries: ColorPrimaries,
    settings: ToneMappingSettings
): ColorTriplet {
    const exposureScale = 2 ** settings.exposure;
    const exposedRGB = mapTriplet(linearInputNits, (component: number): number => Math.max(component * exposureScale, 0));
    const sourceIPT = convertLinearRGBNitsToIPTPQ(exposedRGB, sourcePrimaries);
    const originalIntensity = sourceIPT[0];
    const mappedIntensity = evaluateSplineToneMapPQ(originalIntensity, settings.inputPeakNits, settings.outputPeakNits);
    if (originalIntensity <= Number.EPSILON || mappedIntensity <= Number.EPSILON) {
        return [ 0, 0, 0 ];
    }

    const originalHull = Math.max(calculateIPTChromaHull(originalIntensity), Number.EPSILON);
    const mappedHull = calculateIPTChromaHull(mappedIntensity);
    const chromaScale = clamp(Math.min(originalIntensity / mappedIntensity, mappedHull / originalHull), 0, 1);
    return perceptuallyMapIPTPQToBT709([
        mappedIntensity,
        sourceIPT[1] * chromaScale,
        sourceIPT[2] * chromaScale
    ], settings);
}

/** Compresses absolute BT.709 linear light into the configured SDR luminance range. */
export function toneMapToSDR(linearBT709Nits: ColorTriplet, settings: ToneMappingSettings): ColorTriplet {
    const temporarySettings: HDRToSDRRenderSettings = {
        display: {
            brightness: 0,
            contrast: 1,
            saturation: 1
        },
        mode: 'hdr-to-sdr',
        outputTransfer: 'srgb',
        toneMapping: settings,
        version: RENDER_SETTINGS_VERSION
    };
    assertValidRenderSettings(temporarySettings);

    if (settings.operator === 'spline') {
        return toneMapSplinePerceptualToSDR(linearBT709Nits, 'bt709', settings);
    }

    const exposureScale = 2 ** settings.exposure;
    const exposedRGB = mapTriplet(linearBT709Nits, (component: number): number => Math.max(component * exposureScale, 0));
    const inputLuminance = calculateLuminance(exposedRGB, 'bt709');
    if (inputLuminance <= 0) {
        return [ 0, 0, 0 ];
    }

    const peakCurveValue = evaluateToneMapCurve(settings.inputPeakNits / settings.paperWhiteNits, settings.operator);
    const inputCurveValue = evaluateToneMapCurve(inputLuminance / settings.paperWhiteNits, settings.operator);
    const mappedLuminance = settings.outputPeakNits * clamp(inputCurveValue / peakCurveValue, 0, 1);
    const luminanceScale = mappedLuminance / inputLuminance;
    const mappedRGB = mapTriplet(exposedRGB, (component: number): number => component * luminanceScale);
    const highlightRange = Math.max(settings.inputPeakNits - settings.paperWhiteNits, Number.EPSILON);
    const highlightAmount = settings.desaturationStrength * clamp((inputLuminance - settings.paperWhiteNits) / highlightRange, 0, 1);
    return mapTriplet(mappedRGB, (component: number): number => clamp(
        component + ((mappedLuminance - component) * highlightAmount),
        0,
        settings.outputPeakNits
    ));
}

function applyDisplayControls(encodedRGB: ColorTriplet, settings: DisplaySettings): ColorTriplet {
    const luminance = calculateLuminance(encodedRGB, 'bt709');
    const saturatedRGB = mapTriplet(encodedRGB, (component: number): number => luminance + ((component - luminance) * settings.saturation));
    return mapTriplet(saturatedRGB, (component: number): number => clamp(((component - 0.5) * settings.contrast) + 0.5 + settings.brightness, 0, 1));
}

/** Encodes absolute linear-light RGB for an SDR swap-chain target. */
export function encodeSDROutput(
    linearRGBNits: ColorTriplet,
    outputPeakNits: number,
    transfer: ReferenceSDROutputTransfer,
    outputMinimumNits = 0
): ColorTriplet {
    if (!Number.isFinite(outputPeakNits)
        || !Number.isFinite(outputMinimumNits)
        || outputPeakNits <= 0
        || outputMinimumNits < 0
        || outputMinimumNits >= outputPeakNits) {
        throw new RangeError('Output luminance range must be positive and finite');
    }

    return mapTriplet(linearRGBNits, (component: number): number => {
        const linearValue = clamp((component - outputMinimumNits) / (outputPeakNits - outputMinimumNits), 0, 1);
        switch (transfer) {
            case 'bt709':
                return linearValue < 0.018 ?
                    4.5 * linearValue :
                    (1.099 * (linearValue ** 0.45)) - 0.099;
            case 'srgb':
                return linearValue <= 0.0031308 ?
                    12.92 * linearValue :
                    (1.055 * (linearValue ** (1 / 2.4))) - 0.055;
        }
    });
}

/** Applies the reference color pipeline to an already converted nonlinear RGB sample. */
export function processEncodedRGB(
    encodedRGB: ColorTriplet,
    metadata: InputColorMetadata,
    settings: RenderSettings
): ColorTriplet {
    assertValidInputColorMetadata(metadata);
    assertValidRenderSettings(settings);
    if (settings.mode === 'identity-sdr') {
        return [ encodedRGB[0], encodedRGB[1], encodedRGB[2] ];
    }

    const decodedRGB = decodeEncodedRGBToNits(encodedRGB, metadata);
    const toneMappedRGB = settings.toneMapping.operator === 'spline' ?
        toneMapSplinePerceptualToSDR(decodedRGB, metadata.primaries, settings.toneMapping) :
        toneMapToSDR(convertLinearRGBGamut(decodedRGB, metadata.primaries, 'bt709'), settings.toneMapping);
    const encodedOutputRGB = encodeSDROutput(
        toneMappedRGB,
        settings.toneMapping.outputPeakNits,
        settings.outputTransfer,
        settings.toneMapping.operator === 'spline' ?
            settings.toneMapping.outputPeakNits / SDR_CONTRAST :
            0
    );
    return applyDisplayControls(encodedOutputRGB, settings.display);
}

/** Applies range, matrix, transfer, gamut, tone-map, and output stages to YUV. */
export function processEncodedYUV(
    encodedYUV: ColorTriplet,
    metadata: InputColorMetadata,
    settings: RenderSettings
): ColorTriplet {
    const expandedYUV = expandYUVRange(encodedYUV, metadata);
    const encodedRGB = convertYUVToEncodedRGB(expandedYUV, metadata.matrix);
    return processEncodedRGB(encodedRGB, metadata, settings);
}
