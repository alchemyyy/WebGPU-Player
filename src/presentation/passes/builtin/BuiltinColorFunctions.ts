// The built-in color track: the legacy fused shader's processColor, split into one color function per transition.
// Apart from the entry points, the WGSL is the legacy text, so the default chains render exactly as that shader did.
import { assertValidInputColorMetadata, HDR_REFERENCE_WHITE_NITS, type InputColorMetadata } from '../../../color/ColorMetadata';
import {
    getGamutToBT709Matrix,
    getLuminanceCoefficients,
    getRGBToIPTLMSMatrix,
    type ColorMatrix,
    type ColorTriplet
} from '../../../color/ColorPipeline';
import { collectTopLevelDeclarations, renameWGSLIdentifiers } from '../PassPrelude';
import type { BuiltinColorFunction, EngineResource, SignalLinearLight } from '../PassTypes';
import { joinWGSL, toWGSLFloat } from './BuiltinWGSL';

const TRANSFER_DECODE_NAME = 'builtin.transfer-decode';
const TONE_MAP_NAME = 'builtin.tone-map';
const OUTPUT_ENCODE_NAME = 'builtin.output-encode';
const DISPLAY_CONTROLS_NAME = 'builtin.display-controls';
const DITHER_NAME = 'builtin.dither';
// Identity SDR outside BT.709 primaries, which no user pass replaces
const SDR_GAMUT_NAME = 'builtin.sdr-gamut';

/** The built-in color function names in color-track order, which a user color pass's `replaces` may name. */
export const BUILTIN_COLOR_FUNCTION_NAMES: readonly string[] = Object.freeze([
    TRANSFER_DECODE_NAME,
    TONE_MAP_NAME,
    OUTPUT_ENCODE_NAME,
    DISPLAY_CONTROLS_NAME,
    DITHER_NAME
]);

const TRANSFER_DECODE_ENTRY_POINT = 'applyBuiltinTransferDecode';
const TONE_MAP_ENTRY_POINT = 'applyBuiltinToneMap';
const OUTPUT_ENCODE_ENTRY_POINT = 'applyBuiltinOutputEncode';
const DISPLAY_CONTROLS_ENTRY_POINT = 'applyBuiltinDisplayControls';
const DITHER_ENTRY_POINT = 'applyBuiltinDither';
const SDR_GAMUT_ENTRY_POINT = 'applyBuiltinSDRGamut';

const NO_RESOURCES: readonly EngineResource[] = Object.freeze([]);
const RENDER_SETTINGS_RESOURCES: readonly EngineResource[] = Object.freeze([ 'render-settings' ]);

// The transfer functions linear light renames, and the prefix that keeps them apart from the built-in transfer decode's
const TRANSFER_DECODE_FUNCTION = 'decodeInputTransfer';
const TRANSFER_ENCODE_FUNCTION = 'encodeInputTransfer';
const LINEAR_LIGHT_NAME_PREFIX = 'passLight';

// BT.2100 HLG system gamma: 1.2 at a 1000-nit display, extended to other peaks
const HLG_REFERENCE_SYSTEM_GAMMA = 1.2;
const HLG_SYSTEM_GAMMA_SLOPE = 0.42;
const HLG_REFERENCE_PEAK_NITS = 1_000;

/** Formats a 3x3 matrix times a vec3f expression as three WGSL dot products, one per matrix row. */
function createColorMatrixProductWGSL(matrix: ColorMatrix, vectorExpression: string): string {
    const rowProducts = matrix.map((row: ColorTriplet): string => `        dot(${vectorExpression}, vec3f(
            ${toWGSLFloat(row[0])},
            ${toWGSLFloat(row[1])},
            ${toWGSLFloat(row[2])}
        ))`);
    return `vec3f(
${rowProducts.join(',\n')}
    )`;
}

function createTransferDecodeWGSL(metadata: InputColorMetadata): string {
    switch (metadata.transfer) {
        case 'pq':
            return `
fn applyPQEOTF(encodedValue: f32) -> f32 {
    let inversePower = pow(clamp(encodedValue, 0.0, 1.0), 1.0 / (2523.0 / 32.0));
    let numerator = max(inversePower - (3424.0 / 4096.0), 0.0);
    let denominator = max((2413.0 / 128.0) - (2392.0 / 128.0) * inversePower, 0.0000001);
    return 10000.0 * pow(numerator / denominator, 1.0 / (2610.0 / 16384.0));
}

fn decodeInputTransfer(encodedRGB: vec3f) -> vec3f {
    return vec3f(
        applyPQEOTF(encodedRGB.r),
        applyPQEOTF(encodedRGB.g),
        applyPQEOTF(encodedRGB.b)
    );
}`;
        case 'sdr':
            return `
fn applySDREOTF(encodedValue: f32) -> f32 {
    if (encodedValue < 0.081) {
        return (encodedValue / 4.5) * ${toWGSLFloat(metadata.sdrReferenceWhiteNits)};
    }
    return pow((encodedValue + 0.099) / 1.099, 1.0 / 0.45)
        * ${toWGSLFloat(metadata.sdrReferenceWhiteNits)};
}

fn decodeInputTransfer(encodedRGB: vec3f) -> vec3f {
    return vec3f(
        applySDREOTF(encodedRGB.r),
        applySDREOTF(encodedRGB.g),
        applySDREOTF(encodedRGB.b)
    );
}`;
        case 'hlg': {
            const luminanceCoefficients = getLuminanceCoefficients(metadata.primaries);
            const systemGamma = HLG_REFERENCE_SYSTEM_GAMMA
                + (HLG_SYSTEM_GAMMA_SLOPE * Math.log10(metadata.nominalPeakNits / HLG_REFERENCE_PEAK_NITS));
            return `
fn applyHLGInverseOETF(encodedValue: f32) -> f32 {
    let clampedValue = clamp(encodedValue, 0.0, 1.0);
    if (clampedValue <= 0.5) {
        return clampedValue * clampedValue / 3.0;
    }
    let hlgA = 0.178832770;
    let hlgB = 1.0 - 4.0 * hlgA;
    let hlgC = 0.5 - hlgA * log(4.0 * hlgA);
    return (exp((clampedValue - hlgC) / hlgA) + hlgB) / 12.0;
}

fn decodeInputTransfer(encodedRGB: vec3f) -> vec3f {
    let sceneRGB = vec3f(
        applyHLGInverseOETF(encodedRGB.r),
        applyHLGInverseOETF(encodedRGB.g),
        applyHLGInverseOETF(encodedRGB.b)
    );
    let sceneLuminance = max(dot(
        sceneRGB,
        vec3f(
            ${toWGSLFloat(luminanceCoefficients.red)},
            ${toWGSLFloat(luminanceCoefficients.green)},
            ${toWGSLFloat(luminanceCoefficients.blue)}
        )
    ), 0.0);
    if (sceneLuminance == 0.0) {
        return vec3f(0.0);
    }
    let luminanceScale = ${toWGSLFloat(metadata.nominalPeakNits)}
        * pow(sceneLuminance, ${toWGSLFloat(systemGamma - 1)});
    return sceneRGB * luminanceScale;
}`;
        }
    }
}

/** Returns `fn encodeInputTransfer(linearNits: vec3f) -> vec3f`, the exact inverse of createTransferDecodeWGSL's decodeInputTransfer. */
function createTransferEncodeWGSL(metadata: InputColorMetadata): string {
    switch (metadata.transfer) {
        case 'pq':
            return `
fn applyPQInverseEOTF(linearNits: f32) -> f32 {
    let poweredValue = pow(clamp(linearNits / 10000.0, 0.0, 1.0), 2610.0 / 16384.0);
    return pow(((3424.0 / 4096.0) + (2413.0 / 128.0) * poweredValue) / (1.0 + (2392.0 / 128.0) * poweredValue), 2523.0 / 32.0);
}

fn encodeInputTransfer(linearNits: vec3f) -> vec3f {
    return vec3f(
        applyPQInverseEOTF(linearNits.r),
        applyPQInverseEOTF(linearNits.g),
        applyPQInverseEOTF(linearNits.b)
    );
}`;
        case 'sdr':
            return `
fn applySDRInverseEOTF(linearNits: f32) -> f32 {
    let linearValue = linearNits / ${toWGSLFloat(metadata.sdrReferenceWhiteNits)};
    if (linearValue < 0.081 / 4.5) {
        return linearValue * 4.5;
    }
    return 1.099 * pow(linearValue, 0.45) - 0.099;
}

fn encodeInputTransfer(linearNits: vec3f) -> vec3f {
    return vec3f(
        applySDRInverseEOTF(linearNits.r),
        applySDRInverseEOTF(linearNits.g),
        applySDRInverseEOTF(linearNits.b)
    );
}`;
        case 'hlg': {
            const luminanceCoefficients = getLuminanceCoefficients(metadata.primaries);
            const systemGamma = HLG_REFERENCE_SYSTEM_GAMMA
                + (HLG_SYSTEM_GAMMA_SLOPE * Math.log10(metadata.nominalPeakNits / HLG_REFERENCE_PEAK_NITS));
            return `
fn applyHLGOETF(sceneValue: f32) -> f32 {
    let clampedValue = clamp(sceneValue, 0.0, 1.0);
    if (clampedValue <= 1.0 / 12.0) {
        return sqrt(3.0 * clampedValue);
    }
    let hlgA = 0.178832770;
    let hlgB = 1.0 - 4.0 * hlgA;
    let hlgC = 0.5 - hlgA * log(4.0 * hlgA);
    return hlgA * log(12.0 * clampedValue - hlgB) + hlgC;
}

fn encodeInputTransfer(linearNits: vec3f) -> vec3f {
    // The display luminance is the peak times the scene luminance to the system gamma, which the inverse OOTF undoes
    let displayLuminance = max(dot(
        linearNits,
        vec3f(
            ${toWGSLFloat(luminanceCoefficients.red)},
            ${toWGSLFloat(luminanceCoefficients.green)},
            ${toWGSLFloat(luminanceCoefficients.blue)}
        )
    ), 0.0);
    if (displayLuminance == 0.0) {
        return vec3f(0.0);
    }
    let sceneLuminance = pow(displayLuminance / ${toWGSLFloat(metadata.nominalPeakNits)}, ${toWGSLFloat(1 / systemGamma)});
    let sceneRGB = linearNits / (${toWGSLFloat(metadata.nominalPeakNits)} * pow(sceneLuminance, ${toWGSLFloat(systemGamma - 1)}));
    return vec3f(applyHLGOETF(sceneRGB.r), applyHLGOETF(sceneRGB.g), applyHLGOETF(sceneRGB.b));
}`;
        }
    }
}

/**
 * Returns the source's transfer function for the prelude's linearize and delinearize: the built-in transfer decode's own code and its inverse, renamed apart
 * from the built-in function a module may hold beside them, with the nits of mpv's linear 1.0.
 */
export function createSignalLinearLight(metadata: InputColorMetadata): SignalLinearLight {
    assertValidInputColorMetadata(metadata);
    const code = joinWGSL([ createTransferDecodeWGSL(metadata), createTransferEncodeWGSL(metadata) ]);
    const renames = new Map<string, string>();
    for (const name of collectTopLevelDeclarations(code)) {
        renames.set(name, `${LINEAR_LIGHT_NAME_PREFIX}${name[0].toUpperCase()}${name.slice(1)}`);
    }
    return {
        code: renameWGSLIdentifiers(code, renames),
        decodeEntryPoint: renames.get(TRANSFER_DECODE_FUNCTION) ?? TRANSFER_DECODE_FUNCTION,
        encodeEntryPoint: renames.get(TRANSFER_ENCODE_FUNCTION) ?? TRANSFER_ENCODE_FUNCTION,
        referenceWhiteNits: metadata.transfer === 'sdr' ? metadata.sdrReferenceWhiteNits : HDR_REFERENCE_WHITE_NITS
    };
}

function createGamutConversionWGSL(metadata: InputColorMetadata): string {
    const toBT709Matrix = getGamutToBT709Matrix(metadata.primaries);
    if (!toBT709Matrix) {
        return `
fn convertToBT709(linearRGB: vec3f) -> vec3f {
    return linearRGB;
}`;
    }

    return `
fn convertToBT709(linearRGB: vec3f) -> vec3f {
    return ${createColorMatrixProductWGSL(toBT709Matrix, 'linearRGB')};
}`;
}

function createIPTSourceConversionWGSL(metadata: InputColorMetadata): string {
    return `
fn convertSourceRGBToIPTLMS(linearRGBNits: vec3f) -> vec3f {
    return ${createColorMatrixProductWGSL(getRGBToIPTLMSMatrix(metadata.primaries), 'linearRGBNits')};
}`;
}

const TONE_MAP_FUNCTIONS_WGSL = /* wgsl */ `
fn evaluateToneMapCurve(normalizedLuminance: f32) -> f32 {
    let value = max(normalizedLuminance, 0.0);
    if (renderSettings.toneMapOperator == 0u) {
        return clamp(
        (value * (2.51 * value + 0.03)) / (value * (2.43 * value + 0.59) + 0.14),
        0.0,
        1.0
        );
    }
    return value / (1.0 + value);
}

fn encodePerceptualPQ(luminanceNits: f32) -> f32 {
    let normalizedLuminance = clamp(luminanceNits / 10000.0, 0.0, 1.0);
    let poweredLuminance = pow(normalizedLuminance, 2610.0 / 16384.0);
    let encodedValue = ((3424.0 / 4096.0) + (2413.0 / 128.0) * poweredLuminance)
        / (1.0 + (2392.0 / 128.0) * poweredLuminance);
    return pow(encodedValue, 2523.0 / 32.0);
}

fn decodePerceptualPQ(encodedValue: f32) -> f32 {
    let inversePower = pow(clamp(encodedValue, 0.0, 1.0), 1.0 / (2523.0 / 32.0));
    let numerator = max(inversePower - (3424.0 / 4096.0), 0.0);
    let denominator = max(
        (2413.0 / 128.0) - (2392.0 / 128.0) * inversePower,
        0.0000001
    );
    return 10000.0 * pow(numerator / denominator, 1.0 / (2610.0 / 16384.0));
}

fn convertLinearRGBNitsToIPTPQ(linearRGBNits: vec3f) -> vec3f {
    let linearLMS = convertSourceRGBToIPTLMS(max(linearRGBNits, vec3f(0.0)));
    let encodedLMS = vec3f(
        encodePerceptualPQ(linearLMS.r),
        encodePerceptualPQ(linearLMS.g),
        encodePerceptualPQ(linearLMS.b)
    );
    return vec3f(
        dot(encodedLMS, vec3f(0.4, 0.4, 0.2)),
        dot(encodedLMS, vec3f(4.455, -4.851, 0.396)),
        dot(encodedLMS, vec3f(0.8056, 0.3572, -1.1628))
    );
}

fn convertIPTPQToBT709Nits(perceptualColor: vec3f) -> vec3f {
    let encodedLMS = vec3f(
        dot(perceptualColor, vec3f(1.0, 0.0975689, 0.205226)),
        dot(perceptualColor, vec3f(1.0, -0.113876, 0.133217)),
        dot(perceptualColor, vec3f(1.0, 0.0326151, -0.676887))
    );
    let linearLMS = vec3f(
        decodePerceptualPQ(encodedLMS.r),
        decodePerceptualPQ(encodedLMS.g),
        decodePerceptualPQ(encodedLMS.b)
    );
    return vec3f(
        dot(linearLMS, vec3f(6.173532657683, -5.320898820809, 0.147354885063)),
        dot(linearLMS, vec3f(-1.324031910094, 2.560269770177, -0.236238618417)),
        dot(linearLMS, vec3f(-0.011598387923, -0.264921446713, 1.276526337036))
    );
}

fn evaluateSmoothstep(edge0: f32, edge1: f32, value: f32) -> f32 {
    if (edge0 == edge1) {
        return select(0.0, 1.0, value >= edge0);
    }
    let normalizedValue = clamp((value - edge0) / (edge1 - edge0), 0.0, 1.0);
    return normalizedValue * normalizedValue * (3.0 - 2.0 * normalizedValue);
}

fn evaluateSplineToneMapPQ(inputIntensityPQ: f32) -> f32 {
    let inputMinimum = encodePerceptualPQ(0.000001);
    let inputMaximum = encodePerceptualPQ(renderSettings.inputPeakNits);
    let outputMinimum = encodePerceptualPQ(renderSettings.outputPeakNits / 1000.0);
    let outputMaximum = encodePerceptualPQ(renderSettings.outputPeakNits);
    var sourcePivot = mix(inputMinimum, inputMaximum, 0.4);
    if (renderSettings.dynamicHDRMode == 1u
        && renderSettings.dynamicSceneAverageNits > 0.0) {
        sourcePivot = clamp(
            encodePerceptualPQ(renderSettings.dynamicSceneAverageNits),
            mix(inputMinimum, inputMaximum, 0.1),
            mix(inputMinimum, inputMaximum, 0.8)
        );
    }
    let sourceTarget = (sourcePivot - inputMinimum) / (inputMaximum - inputMinimum);
    let adaptedPivot = mix(outputMinimum, outputMaximum, sourceTarget);
    let tuning = 1.0
        - evaluateSmoothstep(0.8, 0.4, sourceTarget)
        * evaluateSmoothstep(0.1, 0.4, sourceTarget);
    let adaptation = mix(0.4, 1.0, tuning);
    let destinationPivot = clamp(
        mix(sourcePivot, adaptedPivot, adaptation),
        mix(outputMinimum, outputMaximum, 0.1),
        mix(outputMinimum, outputMaximum, 0.8)
    );
    let linearSlope = (destinationPivot - outputMinimum)
        / (sourcePivot - inputMinimum);
    let peakRatio = inputMaximum / outputMaximum - 1.0;
    let slopeRatio = clamp(1.5 * peakRatio, 0.2, 1.2);
    let pivotSlope = pow(linearSlope, 0.5 * slopeRatio);

    let inputMinimumOffset = inputMinimum - sourcePivot;
    let inputMaximumOffset = inputMaximum - sourcePivot;
    let outputMinimumOffset = outputMinimum - destinationPivot;
    let outputMaximumOffset = outputMaximum - destinationPivot;
    let lowerQuadratic = (outputMinimumOffset - pivotSlope * inputMinimumOffset)
        / (inputMinimumOffset * inputMinimumOffset);
    let upperDenominator = 2.0 * inputMaximumOffset * inputMaximumOffset;
    let upperCubic = (pivotSlope * inputMaximumOffset - outputMaximumOffset)
        / (inputMaximumOffset * upperDenominator);
    let upperQuadratic = -3.0 * (pivotSlope * inputMaximumOffset - outputMaximumOffset)
        / upperDenominator;

    let inputOffset = clamp(inputIntensityPQ, inputMinimum, inputMaximum) - sourcePivot;
    var mappedOffset: f32;
    if (inputOffset > 0.0) {
        mappedOffset = ((upperCubic * inputOffset + upperQuadratic)
            * inputOffset + pivotSlope) * inputOffset;
    } else {
        mappedOffset = (lowerQuadratic * inputOffset + pivotSlope) * inputOffset;
    }
    return clamp(mappedOffset + destinationPivot, outputMinimum, outputMaximum);
}

fn getHDR10PlusBezierAnchor(anchorIndex: u32) -> f32 {
    if (anchorIndex < 4u) {
        return renderSettings.dynamicBezierAnchors0[anchorIndex];
    }
    if (anchorIndex < 8u) {
        return renderSettings.dynamicBezierAnchors1[anchorIndex - 4u];
    }
    if (anchorIndex < 12u) {
        return renderSettings.dynamicBezierAnchors2[anchorIndex - 8u];
    }
    return renderSettings.dynamicBezierAnchors3[anchorIndex - 12u];
}

fn getBinomialCoefficient(degree: u32, index: u32) -> f32 {
    let symmetricIndex = min(index, degree - index);
    var coefficient = 1.0;
    for (var factorIndex = 1u; factorIndex <= symmetricIndex; factorIndex += 1u) {
        coefficient *= f32(degree + 1u - factorIndex) / f32(factorIndex);
    }
    return coefficient;
}

fn getHDR10PlusIntercept(degree: u32, kneeX: f32, kneeY: f32) -> f32 {
    if (kneeX <= 0.0 || kneeY >= 1.0) {
        return 1.0 / f32(degree);
    }
    let slope = kneeY / kneeX * (1.0 - kneeX) / (1.0 - kneeY);
    return min(slope / f32(degree), 1.0);
}

fn getHDR10PlusControlPoint(
    pointIndex: u32,
    degree: u32,
    kneeX: f32,
    kneeY: f32,
    targetPeakNits: f32
) -> f32 {
    var controlPoint = select(
        getHDR10PlusBezierAnchor(pointIndex - 1u),
        1.0,
        pointIndex == degree
    );
    let outputPeakNits = renderSettings.outputPeakNits;
    if (outputPeakNits < targetPeakNits) {
        let adaptation = max(outputPeakNits / targetPeakNits, 0.0);
        if (pointIndex == 1u) {
            controlPoint = mix(
                getHDR10PlusIntercept(degree, kneeX, kneeY),
                controlPoint,
                adaptation
            );
        } else {
            controlPoint = mix(1.0, controlPoint, adaptation);
        }
    } else if (outputPeakNits > targetPeakNits
        && renderSettings.inputPeakNits > targetPeakNits) {
        let adaptation = pow(clamp(
            1.0 - (outputPeakNits - targetPeakNits)
                / (renderSettings.inputPeakNits - targetPeakNits),
            0.0,
            1.0
        ), 1.4);
        if (pointIndex == 1u) {
            controlPoint = mix(
                getHDR10PlusIntercept(degree, kneeX, kneeY),
                controlPoint,
                adaptation
            );
        } else if (pointIndex < degree) {
            controlPoint = mix(
                f32(pointIndex) / f32(degree),
                controlPoint,
                adaptation
            );
        }
    }
    return controlPoint;
}

fn toneMapHDR10PlusPerceptualToSDR(linearInputNits: vec3f) -> vec3f {
    let exposedRGB = max(
        linearInputNits * pow(2.0, renderSettings.exposure),
        vec3f(0.0)
    );
    let sourceIPT = convertLinearRGBNitsToIPTPQ(exposedRGB);
    let originalIntensity = sourceIPT.x;
    let originalNits = decodePerceptualPQ(originalIntensity);
    let degree = renderSettings.dynamicBezierAnchorCount + 1u;
    let targetPeakNits = clamp(
        renderSettings.dynamicTargetPeakNits,
        1.0,
        renderSettings.inputPeakNits
    );
    var kneeX = clamp(renderSettings.dynamicKneeX, 0.0, 1.0);
    var kneeY = clamp(renderSettings.dynamicKneeY, 0.0, 1.0);
    if (renderSettings.outputPeakNits < targetPeakNits) {
        let adaptation = max(renderSettings.outputPeakNits / targetPeakNits, 0.0);
        kneeX *= adaptation;
        kneeY *= adaptation;
        let beta = f32(degree) * kneeX / max(1.0 - kneeX, 0.000001);
        let constrainedKnee = min(
            kneeX * renderSettings.inputPeakNits / renderSettings.outputPeakNits,
            beta / (beta + 1.0)
        );
        kneeY = mix(constrainedKnee, kneeY, adaptation);
    } else if (renderSettings.outputPeakNits > targetPeakNits
        && renderSettings.inputPeakNits > targetPeakNits) {
        let adaptation = pow(clamp(
            1.0 - (renderSettings.outputPeakNits - targetPeakNits)
                / (renderSettings.inputPeakNits - targetPeakNits),
            0.0,
            1.0
        ), 1.4);
        kneeY *= targetPeakNits / renderSettings.outputPeakNits;
        let linearKnee = kneeX * renderSettings.outputPeakNits
            / renderSettings.inputPeakNits;
        kneeY = mix(linearKnee, kneeY, adaptation);
    }

    let normalizedInput = clamp(
        originalNits / renderSettings.inputPeakNits,
        0.0,
        1.0
    );
    var normalizedOutput = 0.0;
    if (normalizedInput <= kneeX && kneeX > 0.0) {
        normalizedOutput = normalizedInput * kneeY / kneeX;
    } else {
        let curvePosition = clamp(
            (normalizedInput - kneeX) / max(1.0 - kneeX, 0.000001),
            0.0,
            1.0
        );
        var bezierValue = 0.0;
        for (var pointIndex = 0u; pointIndex <= degree; pointIndex += 1u) {
            var controlPoint = 0.0;
            if (pointIndex > 0u) {
                controlPoint = getHDR10PlusControlPoint(
                    pointIndex,
                    degree,
                    kneeX,
                    kneeY,
                    targetPeakNits
                );
            }
            bezierValue += getBinomialCoefficient(degree, pointIndex)
                * pow(curvePosition, f32(pointIndex))
                * pow(1.0 - curvePosition, f32(degree - pointIndex))
                * controlPoint;
        }
        normalizedOutput = kneeY + (1.0 - kneeY) * bezierValue;
    }
    let mappedIntensity = encodePerceptualPQ(
        clamp(normalizedOutput, 0.0, 1.0) * renderSettings.outputPeakNits
    );
    if (originalIntensity <= 0.0000001 || mappedIntensity <= 0.0000001) {
        return vec3f(0.0);
    }
    let originalHull = max(calculateIPTChromaHull(originalIntensity), 0.0000001);
    let mappedHull = calculateIPTChromaHull(mappedIntensity);
    let chromaScale = clamp(min(
        originalIntensity / mappedIntensity,
        mappedHull / originalHull
    ), 0.0, 1.0);
    return perceptuallyMapIPTPQToBT709(vec3f(
        mappedIntensity,
        sourceIPT.yz * chromaScale
    ));
}

fn calculateIPTChromaHull(intensity: f32) -> f32 {
    return ((intensity - 6.0) * intensity + 9.0) * intensity;
}

fn calculateComponentGamutScale(
    component: f32,
    neutralComponent: f32
) -> f32 {
    let chromaDelta = component - neutralComponent;
    if (component > renderSettings.outputPeakNits && chromaDelta > 0.0) {
        return (renderSettings.outputPeakNits - neutralComponent) / chromaDelta;
    }
    if (component < 0.0 && chromaDelta < 0.0) {
        return -neutralComponent / chromaDelta;
    }
    return 1.0;
}

fn perceptuallyMapIPTPQToBT709(perceptualColor: vec3f) -> vec3f {
    let targetRGB = convertIPTPQToBT709Nits(perceptualColor);
    let neutralRGB = convertIPTPQToBT709Nits(vec3f(perceptualColor.x, 0.0, 0.0));
    var hardChromaScale = 1.0;
    hardChromaScale = min(
        hardChromaScale,
        calculateComponentGamutScale(targetRGB.r, neutralRGB.r)
    );
    hardChromaScale = min(
        hardChromaScale,
        calculateComponentGamutScale(targetRGB.g, neutralRGB.g)
    );
    hardChromaScale = min(
        hardChromaScale,
        calculateComponentGamutScale(targetRGB.b, neutralRGB.b)
    );
    hardChromaScale = clamp(hardChromaScale, 0.0, 1.0);
    let outOfGamutAmount = 1.0 - hardChromaScale;
    let perceptualChromaScale = hardChromaScale * (
        1.0 - renderSettings.desaturationStrength
            * outOfGamutAmount * outOfGamutAmount
    );
    return clamp(
        neutralRGB + (targetRGB - neutralRGB) * perceptualChromaScale,
        vec3f(0.0),
        vec3f(renderSettings.outputPeakNits)
    );
}

fn toneMapSplinePerceptualToSDR(linearInputNits: vec3f) -> vec3f {
    let exposedRGB = max(
        linearInputNits * pow(2.0, renderSettings.exposure),
        vec3f(0.0)
    );
    let sourceIPT = convertLinearRGBNitsToIPTPQ(exposedRGB);
    let originalIntensity = sourceIPT.x;
    let mappedIntensity = evaluateSplineToneMapPQ(originalIntensity);
    if (originalIntensity <= 0.0000001 || mappedIntensity <= 0.0000001) {
        return vec3f(0.0);
    }
    let originalHull = max(calculateIPTChromaHull(originalIntensity), 0.0000001);
    let mappedHull = calculateIPTChromaHull(mappedIntensity);
    let chromaScale = clamp(min(
        originalIntensity / mappedIntensity,
        mappedHull / originalHull
    ), 0.0, 1.0);
    return perceptuallyMapIPTPQToBT709(vec3f(
        mappedIntensity,
        sourceIPT.yz * chromaScale
    ));
}

fn toneMapToSDR(linearBT709Nits: vec3f) -> vec3f {
    let exposedRGB = max(
        linearBT709Nits * pow(2.0, renderSettings.exposure),
        vec3f(0.0)
    );
    let inputLuminance = dot(exposedRGB, vec3f(0.2126, 0.7152, 0.0722));
    if (inputLuminance <= 0.0) {
        return vec3f(0.0);
    }
    let peakCurveValue = evaluateToneMapCurve(
        renderSettings.inputPeakNits / renderSettings.paperWhiteNits
    );
    let inputCurveValue = evaluateToneMapCurve(
        inputLuminance / renderSettings.paperWhiteNits
    );
    let mappedLuminance = renderSettings.outputPeakNits
        * clamp(inputCurveValue / peakCurveValue, 0.0, 1.0);
    let mappedRGB = exposedRGB * (mappedLuminance / inputLuminance);
    let highlightAmount = renderSettings.desaturationStrength * clamp(
        (inputLuminance - renderSettings.paperWhiteNits)
            / max(
                renderSettings.inputPeakNits - renderSettings.paperWhiteNits,
                0.000001
            ),
        0.0,
        1.0
    );
    return clamp(
        mappedRGB + (vec3f(mappedLuminance) - mappedRGB) * highlightAmount,
        vec3f(0.0),
        vec3f(renderSettings.outputPeakNits)
    );
}`;

// Legacy processColor returned black unless renderSettings.version matched its shader.
// A plan now generates the uniform layout together with its shader, so the check is dropped
const TONE_MAP_ENTRY_WGSL = /* wgsl */ `
fn ${TONE_MAP_ENTRY_POINT}(color: vec4f, position: vec2f) -> vec4f {
    let linearInputNits = color.rgb;
    var toneMappedNits: vec3f;
    if (renderSettings.dynamicHDRMode == 2u) {
        toneMappedNits = toneMapHDR10PlusPerceptualToSDR(linearInputNits);
    } else if (renderSettings.toneMapOperator == 2u) {
        toneMappedNits = toneMapSplinePerceptualToSDR(linearInputNits);
    } else {
        let linearBT709Nits = convertToBT709(linearInputNits);
        toneMappedNits = toneMapToSDR(linearBT709Nits);
    }
    return vec4f(toneMappedNits, color.a);
}`;

const SRGB_ENCODE_WGSL = /* wgsl */ `
fn encodeSRGB(linearValue: f32) -> f32 {
    if (linearValue <= 0.0031308) {
        return 12.92 * linearValue;
    }
    return 1.055 * pow(linearValue, 1.0 / 2.4) - 0.055;
}`;

const SDR_OUTPUT_ENCODE_WGSL = /* wgsl */ `
fn encodeOutputComponent(componentNits: f32) -> f32 {
    let outputMinimumNits = select(
        0.0,
        renderSettings.outputPeakNits / 1000.0,
        renderSettings.toneMapOperator == 2u
    );
    let linearValue = clamp(
        (componentNits - outputMinimumNits)
            / (renderSettings.outputPeakNits - outputMinimumNits),
        0.0,
        1.0
    );
    return encodeSRGB(linearValue);
}

fn ${OUTPUT_ENCODE_ENTRY_POINT}(color: vec4f, position: vec2f) -> vec4f {
    let toneMappedNits = color.rgb;
    let encodedOutputRGB = vec3f(
        encodeOutputComponent(toneMappedNits.r),
        encodeOutputComponent(toneMappedNits.g),
        encodeOutputComponent(toneMappedNits.b)
    );
    return vec4f(encodedOutputRGB, color.a);
}`;

// A float16 canvas in the 'srgb' color space takes extended-range sRGB-encoded values, where 1.0 is SDR white.
// So linear nits relative to paper white are encoded with the sRGB curve mirrored below zero, and never clamped
const HDR_OUTPUT_ENCODE_WGSL = /* wgsl */ `
fn encodeExtendedSRGB(relativeValue: f32) -> f32 {
    return sign(relativeValue) * encodeSRGB(abs(relativeValue));
}

fn ${OUTPUT_ENCODE_ENTRY_POINT}(color: vec4f, position: vec2f) -> vec4f {
    let relativeRGB = color.rgb / renderSettings.paperWhiteNits;
    return vec4f(
        encodeExtendedSRGB(relativeRGB.r),
        encodeExtendedSRGB(relativeRGB.g),
        encodeExtendedSRGB(relativeRGB.b),
        color.a
    );
}`;

const DISPLAY_CONTROLS_WGSL = /* wgsl */ `
fn applyDisplayControls(encodedRGB: vec3f) -> vec3f {
    let luminance = dot(encodedRGB, vec3f(0.2126, 0.7152, 0.0722));
    let saturatedRGB = vec3f(luminance)
        + (encodedRGB - vec3f(luminance)) * renderSettings.saturation;
    let contrastedRGB = (saturatedRGB - vec3f(0.5)) * renderSettings.contrast
        + vec3f(0.5);
    return clamp(
        contrastedRGB + vec3f(renderSettings.brightness),
        vec3f(0.0),
        vec3f(1.0)
    );
}

fn ${DISPLAY_CONTROLS_ENTRY_POINT}(color: vec4f, position: vec2f) -> vec4f {
    return vec4f(applyDisplayControls(color.rgb), color.a);
}`;

const DITHER_WGSL = /* wgsl */ `
fn applyOutputDither(encodedRGB: vec3f, pixelCoordinate: vec2f) -> vec3f {
    let noise = fract(
        52.9829189 * fract(dot(pixelCoordinate, vec2f(0.06711056, 0.00583715)))
    ) - 0.5;
    return clamp(encodedRGB + vec3f(noise / 255.0), vec3f(0.0), vec3f(1.0));
}

fn ${DITHER_ENTRY_POINT}(color: vec4f, position: vec2f) -> vec4f {
    return vec4f(applyOutputDither(color.rgb, position), color.a);
}`;

const SDR_OUTPUT_ENCODE_COLOR_FUNCTION: BuiltinColorFunction = Object.freeze({
    code: joinWGSL([ SRGB_ENCODE_WGSL, SDR_OUTPUT_ENCODE_WGSL ]),
    entryPoint: OUTPUT_ENCODE_ENTRY_POINT,
    inputState: 'display-linear',
    name: OUTPUT_ENCODE_NAME,
    outputState: 'display',
    pinnedToOutput: false,
    resources: RENDER_SETTINGS_RESOURCES
});

const HDR_OUTPUT_ENCODE_COLOR_FUNCTION: BuiltinColorFunction = Object.freeze({
    code: joinWGSL([ SRGB_ENCODE_WGSL, HDR_OUTPUT_ENCODE_WGSL ]),
    entryPoint: OUTPUT_ENCODE_ENTRY_POINT,
    inputState: 'display-linear',
    name: OUTPUT_ENCODE_NAME,
    outputState: 'display',
    pinnedToOutput: false,
    resources: RENDER_SETTINGS_RESOURCES
});

const DISPLAY_CONTROLS_COLOR_FUNCTION: BuiltinColorFunction = Object.freeze({
    code: joinWGSL([ DISPLAY_CONTROLS_WGSL ]),
    entryPoint: DISPLAY_CONTROLS_ENTRY_POINT,
    inputState: 'display',
    name: DISPLAY_CONTROLS_NAME,
    outputState: 'display',
    pinnedToOutput: false,
    resources: RENDER_SETTINGS_RESOURCES
});

const DITHER_COLOR_FUNCTION: BuiltinColorFunction = Object.freeze({
    code: joinWGSL([ DITHER_WGSL ]),
    entryPoint: DITHER_ENTRY_POINT,
    inputState: 'display',
    name: DITHER_NAME,
    outputState: 'display',
    // Dither noise must not pass through a scaler, so it runs in the pass that writes the canvas
    pinnedToOutput: true,
    resources: NO_RESOURCES
});

function createTransferDecodeColorFunction(metadata: InputColorMetadata): BuiltinColorFunction {
    const entryWGSL = `
fn ${TRANSFER_DECODE_ENTRY_POINT}(color: vec4f, position: vec2f) -> vec4f {
    return vec4f(decodeInputTransfer(color.rgb), color.a);
}`;
    return {
        code: joinWGSL([ createTransferDecodeWGSL(metadata), entryWGSL ]),
        entryPoint: TRANSFER_DECODE_ENTRY_POINT,
        inputState: 'source',
        name: TRANSFER_DECODE_NAME,
        outputState: 'linear',
        pinnedToOutput: false,
        // The transfer constants come from the metadata, so decoding reads no binding
        resources: NO_RESOURCES
    };
}

function createToneMapColorFunction(metadata: InputColorMetadata): BuiltinColorFunction {
    return {
        code: joinWGSL([
            createGamutConversionWGSL(metadata),
            createIPTSourceConversionWGSL(metadata),
            TONE_MAP_FUNCTIONS_WGSL,
            TONE_MAP_ENTRY_WGSL
        ]),
        entryPoint: TONE_MAP_ENTRY_POINT,
        inputState: 'linear',
        name: TONE_MAP_NAME,
        outputState: 'display-linear',
        pinnedToOutput: false,
        resources: RENDER_SETTINGS_RESOURCES
    };
}

/**
 * Returns identity SDR's gamut conversion, from display-encoded RGB in the metadata's primaries to display-encoded BT.709, or null for BT.709 primaries
 * and for HDR: the BT.709 curve decodes each component, the primaries' linear matrix converts it, the result clips to [0, 1], and the curve encodes it again.
 */
export function createSDRGamutColorFunction(metadata: InputColorMetadata): BuiltinColorFunction | null {
    assertValidInputColorMetadata(metadata);
    const toBT709Matrix = metadata.transfer === 'sdr' ? getGamutToBT709Matrix(metadata.primaries) : null;
    if (!toBT709Matrix) {
        return null;
    }
    const code = `
fn decodeSDRGamutComponent(encodedValue: f32) -> f32 {
    if (encodedValue < 0.081) {
        return encodedValue / 4.5;
    }
    return pow((encodedValue + 0.099) / 1.099, 1.0 / 0.45);
}

fn encodeSDRGamutComponent(linearValue: f32) -> f32 {
    if (linearValue < 0.018) {
        return linearValue * 4.5;
    }
    return 1.099 * pow(linearValue, 0.45) - 0.099;
}

fn ${SDR_GAMUT_ENTRY_POINT}(color: vec4f, position: vec2f) -> vec4f {
    let linearRGB = vec3f(
        decodeSDRGamutComponent(color.r),
        decodeSDRGamutComponent(color.g),
        decodeSDRGamutComponent(color.b)
    );
    let linearBT709RGB = clamp(${createColorMatrixProductWGSL(toBT709Matrix, 'linearRGB')}, vec3f(0.0), vec3f(1.0));
    return vec4f(
        encodeSDRGamutComponent(linearBT709RGB.r),
        encodeSDRGamutComponent(linearBT709RGB.g),
        encodeSDRGamutComponent(linearBT709RGB.b),
        color.a
    );
}`;
    return {
        code,
        entryPoint: SDR_GAMUT_ENTRY_POINT,
        inputState: 'source',
        name: SDR_GAMUT_NAME,
        outputState: 'display',
        pinnedToOutput: false,
        // The matrix comes from the metadata, so the conversion reads no binding
        resources: NO_RESOURCES
    };
}

/**
 * Returns the default color functions for source metadata, in color-track order.
 * SDR output decodes, tone maps, encodes sRGB, applies the display controls, and dithers, as the legacy processColor did.
 * HDR output decodes, tone maps, and encodes extended-range sRGB relative to paper white, without display controls or dither.
 */
export function createBuiltinColorFunctions(metadata: InputColorMetadata, hdrOutput: boolean): readonly BuiltinColorFunction[] {
    assertValidInputColorMetadata(metadata);
    const colorFunctions: BuiltinColorFunction[] = [];
    colorFunctions.push(createTransferDecodeColorFunction(metadata), createToneMapColorFunction(metadata));
    if (hdrOutput) {
        colorFunctions.push(HDR_OUTPUT_ENCODE_COLOR_FUNCTION);
        return colorFunctions;
    }
    colorFunctions.push(SDR_OUTPUT_ENCODE_COLOR_FUNCTION, DISPLAY_CONTROLS_COLOR_FUNCTION, DITHER_COLOR_FUNCTION);
    return colorFunctions;
}
