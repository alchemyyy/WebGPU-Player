// The built-in signals: each route's fixed, decode-equivalent read of its source into 'source' RGB.
// Apart from the entry points and chroma siting, the WGSL is the legacy fused shader's text, so every route samples and reconstructs as that shader did.
// Chroma is read where the stream declares it lies, which the legacy shader fixed at left for planar formats and at the texel center for NV12.
import {
    assertValidInputColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata,
    type InputColorMetadata,
    type YUVMatrix
} from '../../../color/ColorMetadata';
import { createDolbyVisionColorFunctionsWGSL } from '../../../color/DolbyVisionColorTransform';
import { getRawFormatBitDepth, type SupportedRawVideoFrameFormat } from '../../../decode/video/RawVideoFrameCopy';
import type { ChromaLocation, ChromaSubsampling } from '../../../demux/VideoChromaFormat';
import type { DolbyVisionReconstructionProfile } from '../../PresentationInput';
import {
    HALF_FLOAT_PLANE_MAXIMUM_BIT_DEPTH,
    PLANE_CHROMA_FLOAT_FORMAT,
    PLANE_CHROMA_HALF_FLOAT_FORMAT,
    PLANE_LUMA_FLOAT_FORMAT,
    PLANE_LUMA_HALF_FLOAT_FORMAT,
    PLANE_NATIVE_FLOAT_FORMAT,
    PLANE_NATIVE_HALF_FLOAT_FORMAT
} from '../../WebGPUConstants';
import { PRESENTATION_FIELD_STATE } from '../PassResources';
import type { EngineResource, PresentationSourceKind, RawDolbyVisionFrameFormat, SignalDefinition, SignalPlanes } from '../PassTypes';
import { joinWGSL, toWGSLFloat } from './BuiltinWGSL';

/** The compatible base a dual-layer signal presents for an FEL frame whose EL it does not reconstruct. */
type DolbyVisionDualLayerBaseFallback = 'hdr10' | 'sdr';

const SIGNAL_ENTRY_POINT = 'sampleBuiltinSignal';
const SIGNAL_NAME_PREFIX = 'builtin.signal';
// Names a signal that reads interlaced chroma within each field
const INTERLACED_CHROMA_NAME_SUFFIX = '.interlaced-chroma';

const EXTERNAL_RESOURCES: readonly EngineResource[] = Object.freeze([ 'sampler-linear', 'external-texture' ]);
const EXTERNAL_DOLBY_VISION_RESOURCES: readonly EngineResource[] = Object.freeze([
    'sampler-linear',
    'external-texture',
    'dolby-vision-rpu'
]);
const NV12_RESOURCES: readonly EngineResource[] = Object.freeze([ 'planes-nv12' ]);
const PLANAR_RESOURCES: readonly EngineResource[] = Object.freeze([ 'planes-yuv' ]);
const RAW_DOLBY_VISION_RESOURCES: readonly EngineResource[] = Object.freeze([ 'planes-yuv', 'dolby-vision-rpu' ]);
const RAW_DOLBY_VISION_FEL_RESOURCES: readonly EngineResource[] = Object.freeze([
    'planes-yuv',
    'dolby-vision-rpu',
    'dolby-vision-enhancement'
]);

// The external route decodes HDR from access units neutralized to 10-bit BT.709
const EXTERNAL_HDR_BIT_DEPTH = 10;

// YUV code levels at 8 bits, which deeper formats scale by 2 to the power of the extra bits
const REFERENCE_CODE_BIT_DEPTH = 8;
const LIMITED_LUMA_BLACK_CODE = 16;
const LIMITED_LUMA_EXCURSION = 219;
const CHROMA_CENTER_CODE = 128;
const LIMITED_CHROMA_EXCURSION = 224;
// The indentation of a range expression's closing line in a function body, and in a switch clause's body
const FUNCTION_BODY_INDENTATION = '    ';
const CASE_BODY_INDENTATION = '            ';

// The Profile 4 frames that present their SDR base unmodified: FEL frames whose EL is missing, or every FEL frame when the signal does not reconstruct FEL
const FEL_WITHOUT_ENHANCEMENT_CONDITION = 'isDolbyVisionFEL() && enhancement.enhancementPresent == 0u';
const FEL_CONDITION = 'isDolbyVisionFEL()';

/** Where 4:2:0 chroma lies when the stream declares no location: on the left luma column between two rows, the default of H.264 and HEVC. */
export const DEFAULT_CHROMA_LOCATION: ChromaLocation = 'left';
/** Where 4:2:2 chroma lies whatever the stream declares: on its left luma column, which H.264 and HEVC fix for it. */
export const HORIZONTALLY_SUBSAMPLED_CHROMA_LOCATION: ChromaLocation = 'left';
// Each location's chroma site from its chroma texel's center, in luma samples, positive left and up: a site on the left column lies half a luma sample
// left of the center, a site on the top row half a sample above it, and a site on the bottom row half a sample below it
const HALF_LUMA_SAMPLE = 0.5;
const CHROMA_LOCATION_LUMA_SHIFTS: Readonly<Record<ChromaLocation, readonly [number, number]>> = Object.freeze({
    bottom: Object.freeze([ 0, -HALF_LUMA_SAMPLE ] as const),
    'bottom-left': Object.freeze([ HALF_LUMA_SAMPLE, -HALF_LUMA_SAMPLE ] as const),
    center: Object.freeze([ 0, 0 ] as const),
    left: Object.freeze([ HALF_LUMA_SAMPLE, 0 ] as const),
    top: Object.freeze([ 0, HALF_LUMA_SAMPLE ] as const),
    'top-left': Object.freeze([ HALF_LUMA_SAMPLE, HALF_LUMA_SAMPLE ] as const)
});
// The subsampling divisor of a plane that is not subsampled, and of a subsampled one
const FULL_RESOLUTION_DIVISOR = 1;
const SUBSAMPLED_DIVISOR = 2;

// The plane functions every signal with planes defines, which the planner's plane passes call, and the functions of its transform and image reads
export const SIGNAL_PLANE_ENTRY_POINTS = Object.freeze({
    chroma: 'readSignalChroma',
    codeScale: 'getSignalCodeScale',
    conversion: 'convertSignalCodes',
    imageRead: 'readPlaneImage',
    imageSize: 'getPlaneImageSize',
    luma: 'readSignalLuma',
    planesToRGB: 'convertSignalPlaneValues',
    rgbToPlanes: 'deriveSignalPlaneValues',
    sitedChroma: 'readSignalSitedChroma'
});

// Each matrix's luma weights of red and blue, by which planes derive from RGB and convert back exactly
const MATRIX_LUMA_WEIGHTS: Readonly<Record<YUVMatrix, readonly [number, number]>> = Object.freeze({
    'bt2020-ncl': [ 0.2627, 0.0593 ],
    bt470bg: [ 0.299, 0.114 ],
    bt709: [ 0.2126, 0.0722 ],
    smpte170m: [ 0.299, 0.114 ]
});
// Planes derived from RGB hold normalized plane values, which a code scale of 1 leaves as they are
const DERIVED_PLANE_CODE_SCALE = 1;
const NO_CHROMA_OFFSET: readonly [number, number] = Object.freeze([ 0, 0 ]);

/** A chroma plane's subsampling, as each axis's divisor of the luma plane's size. */
export type ChromaDivisors = Pick<SignalPlanes, 'chromaHeightDivisor' | 'chromaWidthDivisor'>;

// The subsampling divisors of each chroma subsampling a stream declares
const FULL_RESOLUTION_DIVISORS: ChromaDivisors = Object.freeze({
    chromaHeightDivisor: FULL_RESOLUTION_DIVISOR,
    chromaWidthDivisor: FULL_RESOLUTION_DIVISOR
});
const CHROMA_SUBSAMPLING_DIVISORS: ReadonlyMap<ChromaSubsampling, ChromaDivisors> = new Map([
    [ '4:2:0', { chromaHeightDivisor: SUBSAMPLED_DIVISOR, chromaWidthDivisor: SUBSAMPLED_DIVISOR } ],
    [ '4:2:2', { chromaHeightDivisor: FULL_RESOLUTION_DIVISOR, chromaWidthDivisor: SUBSAMPLED_DIVISOR } ],
    [ '4:4:4', FULL_RESOLUTION_DIVISORS ]
]);
// The entry points of every signal's planes, whatever their code
export const PLANE_ENTRY_POINT_FIELDS = Object.freeze({
    chromaEntryPoint: SIGNAL_PLANE_ENTRY_POINTS.chroma,
    codeScaleEntryPoint: SIGNAL_PLANE_ENTRY_POINTS.codeScale,
    conversionEntryPoint: SIGNAL_PLANE_ENTRY_POINTS.conversion,
    imageReadEntryPoint: SIGNAL_PLANE_ENTRY_POINTS.imageRead,
    imageSizeEntryPoint: SIGNAL_PLANE_ENTRY_POINTS.imageSize,
    lumaEntryPoint: SIGNAL_PLANE_ENTRY_POINTS.luma,
    planesToRGBEntryPoint: SIGNAL_PLANE_ENTRY_POINTS.planesToRGB,
    rgbToPlanesEntryPoint: SIGNAL_PLANE_ENTRY_POINTS.rgbToPlanes,
    sitedChromaEntryPoint: SIGNAL_PLANE_ENTRY_POINTS.sitedChroma
});

const SIGNAL_PLANE_CONVERSION_WGSL = /* wgsl */ `
fn ${SIGNAL_PLANE_ENTRY_POINTS.conversion}(codes: vec3f) -> vec4f {
    return vec4f(convertRawYUVToEncodedRGB(normalizeRawYUV(codes)), 1.0);
}`;

const DERIVED_PLANE_CONVERSION_WGSL = /* wgsl */ `
fn ${SIGNAL_PLANE_ENTRY_POINTS.conversion}(codes: vec3f) -> vec4f {
    return vec4f(${SIGNAL_PLANE_ENTRY_POINTS.planesToRGB}(codes), 1.0);
}`;

// The image an external signal's planes derive from: the signal's own RGB, at the browser's texture size
const EXTERNAL_PLANE_IMAGE_WGSL = /* wgsl */ `
fn ${SIGNAL_PLANE_ENTRY_POINTS.imageRead}(coordinate: vec2f) -> vec3f {
    return ${SIGNAL_ENTRY_POINT}(coordinate).rgb;
}

fn ${SIGNAL_PLANE_ENTRY_POINTS.imageSize}() -> vec2f {
    return vec2f(textureDimensions(videoTexture));
}`;

const BT709_LIMITED_YUV_RECOVERY_WGSL = /* wgsl */ `
fn recoverLimitedRangeBT709YUV(encodedBT709RGB: vec3f) -> vec3f {
    let normalizedLuma = dot(encodedBT709RGB, vec3f(0.2126, 0.7152, 0.0722));
    let normalizedChromaBlue = (encodedBT709RGB.b - normalizedLuma) / 1.8556;
    let normalizedChromaRed = (encodedBT709RGB.r - normalizedLuma) / 1.5748;
    return vec3f(
        (normalizedLuma * 876.0) + 64.0,
        (normalizedChromaBlue * 896.0) + 512.0,
        (normalizedChromaRed * 896.0) + 512.0
    );
}`;

const DOLBY_VISION_BASE_SIGNAL_RECOVERY_WGSL = /* wgsl */ `
fn recoverDolbyVisionBaseSignal(encodedBT709RGB: vec3f) -> vec3f {
    return recoverLimitedRangeBT709YUV(encodedBT709RGB);
}`;

// An SDR base is already display encoded, so it bypasses HDR tone mapping exactly like identity SDR
const SDR_BASE_LAYER_PRESENTATION_WGSL = /* wgsl */ `
fn presentSDRBaseLayer(rawBaseSignal: vec3f) -> vec4f {
    return vec4f(
        clamp(convertRawYUVToEncodedRGB(normalizeRawYUV(rawBaseSignal)), vec3f(0.0), vec3f(1.0)),
        1.0
    );
}`;

const BT709_MATRIX_WGSL = /* wgsl */ `
fn convertRawYUVToEncodedRGB(normalizedYUV: vec3f) -> vec3f {
    return vec3f(
        normalizedYUV.x + 1.5748 * normalizedYUV.z,
        normalizedYUV.x - 0.187324 * normalizedYUV.y - 0.468124 * normalizedYUV.z,
        normalizedYUV.x + 1.8556 * normalizedYUV.y
    );
}`;

const BT2020_NCL_MATRIX_WGSL = /* wgsl */ `
fn convertRawYUVToEncodedRGB(normalizedYUV: vec3f) -> vec3f {
    return vec3f(
        normalizedYUV.x + 1.4746 * normalizedYUV.z,
        normalizedYUV.x - 0.164553 * normalizedYUV.y - 0.571353 * normalizedYUV.z,
        normalizedYUV.x + 1.8814 * normalizedYUV.y
    );
}`;

const BT601_MATRIX_WGSL = /* wgsl */ `
fn convertRawYUVToEncodedRGB(normalizedYUV: vec3f) -> vec3f {
    return vec3f(
        normalizedYUV.x + 1.402 * normalizedYUV.z,
        normalizedYUV.x - 0.344136 * normalizedYUV.y - 0.714136 * normalizedYUV.z,
        normalizedYUV.x + 1.772 * normalizedYUV.y
    );
}`;

// The EL keeps its own 4:2:0 siting whatever the BL subsampling
const ENHANCEMENT_SAMPLING_WGSL = /* wgsl */ `
fn sampleEnhancementLuma(textureCoordinate: vec2f) -> f32 {
    let dimensions = vec2f(textureDimensions(enhancementLumaTexture));
    let layerCoordinate = textureCoordinate + vec2f(-0.5 / dimensions.x, 0.0);
    let samplePosition = layerCoordinate * dimensions - vec2f(0.5);
    let basePosition = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let maximumPosition = vec2i(textureDimensions(enhancementLumaTexture)) - vec2i(1);
    let topLeft = f32(textureLoad(enhancementLumaTexture, clamp(basePosition, vec2i(0), maximumPosition), 0).r);
    let topRight = f32(textureLoad(enhancementLumaTexture, clamp(basePosition + vec2i(1, 0), vec2i(0), maximumPosition), 0).r);
    let bottomLeft = f32(textureLoad(enhancementLumaTexture, clamp(basePosition + vec2i(0, 1), vec2i(0), maximumPosition), 0).r);
    let bottomRight = f32(textureLoad(enhancementLumaTexture, clamp(basePosition + vec2i(1), vec2i(0), maximumPosition), 0).r);
    return mix(mix(topLeft, topRight, fraction.x), mix(bottomLeft, bottomRight, fraction.x), fraction.y);
}

fn sampleEnhancementChromaU(textureCoordinate: vec2f) -> f32 {
    let lumaDimensions = vec2f(textureDimensions(enhancementLumaTexture));
    let dimensions = vec2f(textureDimensions(enhancementChromaUTexture));
    let layerAndSitingCoordinate = textureCoordinate + vec2f(-1.0 / lumaDimensions.x, 0.0);
    let samplePosition = layerAndSitingCoordinate * dimensions - vec2f(0.5);
    let basePosition = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let maximumPosition = vec2i(textureDimensions(enhancementChromaUTexture)) - vec2i(1);
    let topLeft = f32(textureLoad(enhancementChromaUTexture, clamp(basePosition, vec2i(0), maximumPosition), 0).r);
    let topRight = f32(textureLoad(enhancementChromaUTexture, clamp(basePosition + vec2i(1, 0), vec2i(0), maximumPosition), 0).r);
    let bottomLeft = f32(textureLoad(enhancementChromaUTexture, clamp(basePosition + vec2i(0, 1), vec2i(0), maximumPosition), 0).r);
    let bottomRight = f32(textureLoad(enhancementChromaUTexture, clamp(basePosition + vec2i(1), vec2i(0), maximumPosition), 0).r);
    return mix(mix(topLeft, topRight, fraction.x), mix(bottomLeft, bottomRight, fraction.x), fraction.y);
}

fn sampleEnhancementChromaV(textureCoordinate: vec2f) -> f32 {
    let lumaDimensions = vec2f(textureDimensions(enhancementLumaTexture));
    let dimensions = vec2f(textureDimensions(enhancementChromaVTexture));
    let layerAndSitingCoordinate = textureCoordinate + vec2f(-1.0 / lumaDimensions.x, 0.0);
    let samplePosition = layerAndSitingCoordinate * dimensions - vec2f(0.5);
    let basePosition = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let maximumPosition = vec2i(textureDimensions(enhancementChromaVTexture)) - vec2i(1);
    let topLeft = f32(textureLoad(enhancementChromaVTexture, clamp(basePosition, vec2i(0), maximumPosition), 0).r);
    let topRight = f32(textureLoad(enhancementChromaVTexture, clamp(basePosition + vec2i(1, 0), vec2i(0), maximumPosition), 0).r);
    let bottomLeft = f32(textureLoad(enhancementChromaVTexture, clamp(basePosition + vec2i(0, 1), vec2i(0), maximumPosition), 0).r);
    let bottomRight = f32(textureLoad(enhancementChromaVTexture, clamp(basePosition + vec2i(1), vec2i(0), maximumPosition), 0).r);
    return mix(mix(topLeft, topRight, fraction.x), mix(bottomLeft, bottomRight, fraction.x), fraction.y);
}

fn sampleRawEnhancementYUV(textureCoordinate: vec2f) -> vec3f {
    return vec3f(
        sampleEnhancementLuma(textureCoordinate),
        sampleEnhancementChromaU(textureCoordinate),
        sampleEnhancementChromaV(textureCoordinate)
    );
}`;

const LUMA_SAMPLING_WGSL = /* wgsl */ `
fn sampleLuma(textureCoordinate: vec2f) -> f32 {
    let dimensions = vec2f(textureDimensions(lumaTexture));
    let samplePosition = textureCoordinate * dimensions - vec2f(0.5);
    let basePosition = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let maximumPosition = vec2i(textureDimensions(lumaTexture)) - vec2i(1);
    let topLeft = f32(textureLoad(lumaTexture, clamp(basePosition, vec2i(0), maximumPosition), 0).r);
    let topRight = f32(textureLoad(lumaTexture, clamp(basePosition + vec2i(1, 0), vec2i(0), maximumPosition), 0).r);
    let bottomLeft = f32(textureLoad(lumaTexture, clamp(basePosition + vec2i(0, 1), vec2i(0), maximumPosition), 0).r);
    let bottomRight = f32(textureLoad(lumaTexture, clamp(basePosition + vec2i(1), vec2i(0), maximumPosition), 0).r);
    return mix(mix(topLeft, topRight, fraction.x), mix(bottomLeft, bottomRight, fraction.x), fraction.y);
}`;

const NV12_CHROMA_SAMPLING_WGSL = /* wgsl */ `
fn sampleChroma(textureCoordinate: vec2f) -> vec2f {
    let dimensions = vec2f(textureDimensions(chromaTexture));
    let samplePosition = textureCoordinate * dimensions - vec2f(0.5);
    let basePosition = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let maximumPosition = vec2i(textureDimensions(chromaTexture)) - vec2i(1);
    let topLeft = vec2f(textureLoad(chromaTexture, clamp(basePosition, vec2i(0), maximumPosition), 0).rg);
    let topRight = vec2f(textureLoad(chromaTexture, clamp(basePosition + vec2i(1, 0), vec2i(0), maximumPosition), 0).rg);
    let bottomLeft = vec2f(textureLoad(chromaTexture, clamp(basePosition + vec2i(0, 1), vec2i(0), maximumPosition), 0).rg);
    let bottomRight = vec2f(textureLoad(chromaTexture, clamp(basePosition + vec2i(1), vec2i(0), maximumPosition), 0).rg);
    return mix(mix(topLeft, topRight, fraction.x), mix(bottomLeft, bottomRight, fraction.x), fraction.y);
}`;

const PLANAR_CHROMA_SAMPLING_WGSL = /* wgsl */ `
fn sampleChromaU(textureCoordinate: vec2f) -> f32 {
    let dimensions = vec2f(textureDimensions(chromaUTexture));
    let samplePosition = textureCoordinate * dimensions - vec2f(0.5);
    let basePosition = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let maximumPosition = vec2i(textureDimensions(chromaUTexture)) - vec2i(1);
    let topLeft = f32(textureLoad(chromaUTexture, clamp(basePosition, vec2i(0), maximumPosition), 0).r);
    let topRight = f32(textureLoad(chromaUTexture, clamp(basePosition + vec2i(1, 0), vec2i(0), maximumPosition), 0).r);
    let bottomLeft = f32(textureLoad(chromaUTexture, clamp(basePosition + vec2i(0, 1), vec2i(0), maximumPosition), 0).r);
    let bottomRight = f32(textureLoad(chromaUTexture, clamp(basePosition + vec2i(1), vec2i(0), maximumPosition), 0).r);
    return mix(mix(topLeft, topRight, fraction.x), mix(bottomLeft, bottomRight, fraction.x), fraction.y);
}

fn sampleChromaV(textureCoordinate: vec2f) -> f32 {
    let dimensions = vec2f(textureDimensions(chromaVTexture));
    let samplePosition = textureCoordinate * dimensions - vec2f(0.5);
    let basePosition = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let maximumPosition = vec2i(textureDimensions(chromaVTexture)) - vec2i(1);
    let topLeft = f32(textureLoad(chromaVTexture, clamp(basePosition, vec2i(0), maximumPosition), 0).r);
    let topRight = f32(textureLoad(chromaVTexture, clamp(basePosition + vec2i(1, 0), vec2i(0), maximumPosition), 0).r);
    let bottomLeft = f32(textureLoad(chromaVTexture, clamp(basePosition + vec2i(0, 1), vec2i(0), maximumPosition), 0).r);
    let bottomRight = f32(textureLoad(chromaVTexture, clamp(basePosition + vec2i(1), vec2i(0), maximumPosition), 0).r);
    return mix(mix(topLeft, topRight, fraction.x), mix(bottomLeft, bottomRight, fraction.x), fraction.y);
}`;

/** Returns where chroma at a location lies from its chroma texel's center, in luma samples, positive left and up; null is the default location. */
export function getChromaLocationLumaShift(chromaLocation: ChromaLocation | null): readonly [number, number] {
    return CHROMA_LOCATION_LUMA_SHIFTS[chromaLocation ?? DEFAULT_CHROMA_LOCATION];
}

/**
 * Returns where a plane's chroma samples lie from its texel centers, in luma samples, positive left and up: 4:2:0 chroma, the only kind subsampled down,
 * at the stream's location, 4:2:2 chroma on its left luma column, and chroma at the luma's size on its luma samples.
 */
export function getChromaLumaShift(chromaLocation: ChromaLocation | null, divisors: ChromaDivisors): readonly [number, number] {
    if (divisors.chromaHeightDivisor > FULL_RESOLUTION_DIVISOR) {
        return getChromaLocationLumaShift(chromaLocation);
    }
    return divisors.chromaWidthDivisor > FULL_RESOLUTION_DIVISOR ? getChromaLocationLumaShift(HORIZONTALLY_SUBSAMPLED_CHROMA_LOCATION) : NO_CHROMA_OFFSET;
}

/** Returns the formats a signal's planes are read apart into for codes of a bit depth. */
export function getPlaneFormats(bitDepth: number): Pick<SignalPlanes, 'chromaFormat' | 'lumaFormat' | 'nativeFormat'> {
    return bitDepth > HALF_FLOAT_PLANE_MAXIMUM_BIT_DEPTH ?
        { chromaFormat: PLANE_CHROMA_FLOAT_FORMAT, lumaFormat: PLANE_LUMA_FLOAT_FORMAT, nativeFormat: PLANE_NATIVE_FLOAT_FORMAT } :
        { chromaFormat: PLANE_CHROMA_HALF_FLOAT_FORMAT, lumaFormat: PLANE_LUMA_HALF_FLOAT_FORMAT, nativeFormat: PLANE_NATIVE_HALF_FLOAT_FORMAT };
}

/** Returns the chroma plane's offset in its own pixels: where getChromaLumaShift places its samples from its texel centers, over its subsampling. */
export function getChromaPlaneOffset(chromaLocation: ChromaLocation | null, divisors: ChromaDivisors): readonly [number, number] {
    const [ horizontalShift, verticalShift ] = getChromaLumaShift(chromaLocation, divisors);
    if (horizontalShift === 0 && verticalShift === 0) {
        return NO_CHROMA_OFFSET;
    }
    return Object.freeze([ horizontalShift / divisors.chromaWidthDivisor, verticalShift / divisors.chromaHeightDivisor ]);
}

/**
 * Returns `fn deriveSignalPlaneValues(color: vec3f) -> vec3f` and `fn convertSignalPlaneValues(planes: vec3f) -> vec3f`: 'source' RGB to the normalized
 * Y, Cb, and Cr plane values of the metadata's matrix, range, and bit depth, a code over the largest code, and back, each the other's exact inverse.
 */
export function createPlaneTransformWGSL(metadata: Pick<InputColorMetadata, 'bitDepth' | 'matrix' | 'range'>): string {
    const [ redWeight, blueWeight ] = MATRIX_LUMA_WEIGHTS[metadata.matrix];
    const greenWeight = 1 - redWeight - blueWeight;
    // The scales of the color differences, which span [-0.5, 0.5]
    const blueDifferenceScale = 2 * (1 - blueWeight);
    const redDifferenceScale = 2 * (1 - redWeight);
    const codeScale = 2 ** (metadata.bitDepth - REFERENCE_CODE_BIT_DEPTH);
    const maximumCode = (2 ** metadata.bitDepth) - 1;
    const limited = metadata.range === 'limited';
    // Plane value = code / maximum code, with the codes of createRawYUVRangeWGSL's range
    const lumaScale = limited ? (LIMITED_LUMA_EXCURSION * codeScale) / maximumCode : 1;
    const lumaOffset = limited ? (LIMITED_LUMA_BLACK_CODE * codeScale) / maximumCode : 0;
    const chromaScale = limited ? (LIMITED_CHROMA_EXCURSION * codeScale) / maximumCode : 1;
    const chromaCenter = (CHROMA_CENTER_CODE * codeScale) / maximumCode;
    const weights = [ redWeight, greenWeight, blueWeight ].map(toWGSLFloat).join(', ');
    return `
fn ${SIGNAL_PLANE_ENTRY_POINTS.rgbToPlanes}(color: vec3f) -> vec3f {
    let luma = dot(color, vec3f(${weights}));
    let chroma = vec2f((color.b - luma) / ${toWGSLFloat(blueDifferenceScale)}, (color.r - luma) / ${toWGSLFloat(redDifferenceScale)});
    return vec3f(luma * ${toWGSLFloat(lumaScale)} + ${toWGSLFloat(lumaOffset)}, chroma * ${toWGSLFloat(chromaScale)} + vec2f(${toWGSLFloat(chromaCenter)}));
}

fn ${SIGNAL_PLANE_ENTRY_POINTS.planesToRGB}(planes: vec3f) -> vec3f {
    let luma = (planes.x - ${toWGSLFloat(lumaOffset)}) / ${toWGSLFloat(lumaScale)};
    let chroma = (planes.yz - vec2f(${toWGSLFloat(chromaCenter)})) / ${toWGSLFloat(chromaScale)};
    let red = luma + ${toWGSLFloat(redDifferenceScale)} * chroma.y;
    let blue = luma + ${toWGSLFloat(blueDifferenceScale)} * chroma.x;
    return vec3f(red, (luma - ${toWGSLFloat(redWeight)} * red - ${toWGSLFloat(blueWeight)} * blue) / ${toWGSLFloat(greenWeight)}, blue);
}`;
}

/**
 * Returns the plane functions over a read of codes at a normalized coordinate of the luma grid, such as the transform of an RGB image:
 * luma and sited chroma read where they are asked, and unsited chroma, which a chroma texel's center names, at its sample's site, the chroma offset
 * in luma pixels before it, as the raw signals read their planes.
 */
function createPlaneFunctionsWGSL(
    readCodes: (coordinate: string) => string,
    codeScale: number,
    chromaOffset: readonly [number, number],
    divisors: ChromaDivisors,
    conversionWGSL: string
): string {
    const lumaPixelShiftX = chromaOffset[0] * divisors.chromaWidthDivisor;
    const lumaPixelShiftY = chromaOffset[1] * divisors.chromaHeightDivisor;
    const chromaSiteCoordinate = lumaPixelShiftX === 0 && lumaPixelShiftY === 0 ?
        'coordinate' :
        `coordinate - vec2f(${toWGSLFloat(lumaPixelShiftX)}, ${toWGSLFloat(lumaPixelShiftY)}) / ${SIGNAL_PLANE_ENTRY_POINTS.imageSize}()`;
    return joinWGSL([ `
fn ${SIGNAL_PLANE_ENTRY_POINTS.luma}(coordinate: vec2f) -> f32 {
    return ${readCodes('coordinate')}.x;
}

fn ${SIGNAL_PLANE_ENTRY_POINTS.chroma}(coordinate: vec2f) -> vec2f {
    return ${readCodes(chromaSiteCoordinate)}.yz;
}

fn ${SIGNAL_PLANE_ENTRY_POINTS.sitedChroma}(coordinate: vec2f) -> vec2f {
    return ${readCodes('coordinate')}.yz;
}

fn ${SIGNAL_PLANE_ENTRY_POINTS.codeScale}() -> f32 {
    return ${toWGSLFloat(codeScale)};
}`, conversionWGSL ]);
}

/** Returns the plane functions derived from an RGB image through the transform, which the plan or the signal defines the image's reads of. */
export function createImagePlaneFunctionsWGSL(
    chromaOffset: readonly [number, number],
    divisors: ChromaDivisors
): string {
    return createPlaneFunctionsWGSL(
        (coordinate: string): string => `${SIGNAL_PLANE_ENTRY_POINTS.rgbToPlanes}(${SIGNAL_PLANE_ENTRY_POINTS.imageRead}(${coordinate}))`,
        DERIVED_PLANE_CODE_SCALE,
        chromaOffset,
        divisors,
        DERIVED_PLANE_CONVERSION_WGSL
    );
}

/** Returns the divisors of a declared chroma subsampling, or chroma at the image's size when the stream declares none. */
function getChromaSubsamplingDivisors(chromaSubsampling: ChromaSubsampling | null): ChromaDivisors {
    return (chromaSubsampling === null ? null : CHROMA_SUBSAMPLING_DIVISORS.get(chromaSubsampling)) ?? FULL_RESOLUTION_DIVISORS;
}

function getRawChromaDivisors(format: SupportedRawVideoFrameFormat): ChromaDivisors {
    if (format === 'NV12' || format.startsWith('I420')) {
        return { chromaHeightDivisor: SUBSAMPLED_DIVISOR, chromaWidthDivisor: SUBSAMPLED_DIVISOR };
    }
    if (format.startsWith('I422')) {
        return { chromaHeightDivisor: FULL_RESOLUTION_DIVISOR, chromaWidthDivisor: SUBSAMPLED_DIVISOR };
    }
    return { chromaHeightDivisor: FULL_RESOLUTION_DIVISOR, chromaWidthDivisor: FULL_RESOLUTION_DIVISOR };
}

/** Returns the planes of the raw YUV signal: its own plane reads, chroma siting at the stream's location, range, and matrix. */
function createRawYUVPlanes(format: SupportedRawVideoFrameFormat, metadata: InputColorMetadata, chromaLocation: ChromaLocation | null): SignalPlanes {
    const chromaRead = format === 'NV12' ?
        'sampleChroma(coordinate)' :
        'vec2f(sampleChromaU(coordinate), sampleChromaV(coordinate))';
    const divisors = getRawChromaDivisors(format);
    const chromaOffset = getChromaPlaneOffset(chromaLocation, divisors);
    return {
        ...divisors,
        ...getPlaneFormats(metadata.bitDepth),
        ...PLANE_ENTRY_POINT_FIELDS,
        chromaOffset,
        // No route presents RGB-coded video, so every signal's planes are Y, Cb, and Cr
        rgb: false,
        code: joinWGSL([ `
fn ${SIGNAL_PLANE_ENTRY_POINTS.luma}(coordinate: vec2f) -> f32 {
    return sampleLuma(coordinate);
}

fn ${SIGNAL_PLANE_ENTRY_POINTS.chroma}(coordinate: vec2f) -> vec2f {
    return ${chromaRead};
}

fn ${SIGNAL_PLANE_ENTRY_POINTS.sitedChroma}(textureCoordinate: vec2f) -> vec2f {
    return ${SIGNAL_PLANE_ENTRY_POINTS.chroma}(${getChromaTextureCoordinateWGSL(getChromaLumaShift(chromaLocation, divisors))});
}

fn ${SIGNAL_PLANE_ENTRY_POINTS.codeScale}() -> f32 {
    return ${toWGSLFloat((2 ** metadata.bitDepth) - 1)};
}`, SIGNAL_PLANE_CONVERSION_WGSL ]),
        imageCode: createImagePlaneFunctionsWGSL(chromaOffset, divisors),
        transformCode: createPlaneTransformWGSL(metadata)
    };
}

/**
 * Returns the planes of a signal the browser already converted to RGB: they derive from the signal's RGB through the stream's own matrix and range,
 * with chroma at the stream's subsampling and location, read at each chroma sample's site; without a declared subsampling, chroma has the image's size.
 */
function createExternalPlanes(
    metadata: InputColorMetadata,
    chromaSubsampling: ChromaSubsampling | null,
    chromaLocation: ChromaLocation | null
): SignalPlanes {
    const divisors = getChromaSubsamplingDivisors(chromaSubsampling);
    const chromaOffset = getChromaPlaneOffset(chromaLocation, divisors);
    const imageCode = createImagePlaneFunctionsWGSL(chromaOffset, divisors);
    return {
        ...divisors,
        ...getPlaneFormats(metadata.bitDepth),
        ...PLANE_ENTRY_POINT_FIELDS,
        chromaOffset,
        rgb: false,
        code: joinWGSL([ EXTERNAL_PLANE_IMAGE_WGSL, imageCode ]),
        imageCode,
        transformCode: createPlaneTransformWGSL(metadata)
    };
}

/**
 * Returns the planes of the external HDR signal: the 10-bit codes the signal recovers from the browser's BT.709 texture, exactly as it recovers them,
 * with chroma at the stream's subsampling and location; the signal's own range and matrix convert them.
 */
function createExternalHDRPlanes(
    metadata: InputColorMetadata,
    chromaSubsampling: ChromaSubsampling | null,
    chromaLocation: ChromaLocation | null
): SignalPlanes {
    const divisors = getChromaSubsamplingDivisors(chromaSubsampling);
    const chromaOffset = getChromaPlaneOffset(chromaLocation, divisors);
    const readCodes = (coordinate: string): string => (
        `recoverLimitedRangeBT709YUV(textureSampleBaseClampToEdge(videoTexture, videoSampler, ${coordinate}).rgb)`
    );
    return {
        ...divisors,
        ...getPlaneFormats(metadata.bitDepth),
        ...PLANE_ENTRY_POINT_FIELDS,
        chromaOffset,
        rgb: false,
        code: joinWGSL([
            EXTERNAL_PLANE_IMAGE_WGSL,
            createPlaneFunctionsWGSL(readCodes, (2 ** EXTERNAL_HDR_BIT_DEPTH) - 1, chromaOffset, divisors, SIGNAL_PLANE_CONVERSION_WGSL)
        ]),
        imageCode: createImagePlaneFunctionsWGSL(chromaOffset, divisors),
        transformCode: createPlaneTransformWGSL(metadata)
    };
}

/** Returns whether a format's chroma has half the luma's rows, whose rows an interlaced frame's two fields share. */
function hasVerticallySubsampledChroma(format: SupportedRawVideoFrameFormat): boolean {
    return format === 'NV12' || format.startsWith('I420');
}

/**
 * The condition under which a deinterlacing plan's signal reads chroma within each field: the presentation uniform marks the frame interlaced.
 * Each 4:2:0 field carries its own chroma rows, alternating with the other field's, so a progressive read would blend the two fields' colors.
 */
export const INTERLACED_SIGNAL_CONDITION = `(presentation.fieldState & ${PRESENTATION_FIELD_STATE.interlacedSignal}u) != 0u`;

/**
 * Returns the WGSL of a field-aware bilinear chroma read: the luma row a coordinate falls on names its field, and the read takes that field's chroma rows,
 * every other row of the plane, at the field's own siting, MPEG-2's for interlaced 4:2:0: the top field's chroma lies a quarter of a field row below its
 * luma rows, the bottom field's three quarters, so a still frame's chroma sits where a progressive frame's does.
 * The horizontal read is the progressive one, so its coordinate carries the location's horizontal shift alone, and the vertical siting stays MPEG-2's
 * whatever the stream declares; dimensions, bounds, lumaHeight, and the load are WGSL expressions of the plane it reads, bounds a vec4i of the first (xy) and
 * last (zw) samples its taps may read, within which each field keeps its own rows.
 */
export function createInterlacedChromaReadWGSL(
    signature: string,
    dimensions: string,
    bounds: string,
    lumaHeight: string,
    load: (column: string, row: string) => string
): string {
    return `
fn ${signature} {
    let dimensions = ${dimensions};
    let bounds = ${bounds};
    let lumaHeight = ${lumaHeight};
    let lumaRow = clamp(i32(floor(textureCoordinate.y * f32(lumaHeight))), 0, lumaHeight - 1);
    let field = lumaRow & 1;
    let firstFieldRow = (bounds.y - field + 1) / 2;
    let lastFieldRow = max((bounds.w - field) / 2, firstFieldRow);
    let fieldPosition = (f32(lumaRow >> 1u) - 0.25 - 0.5 * f32(field)) * 0.5;
    let fieldRow = i32(floor(fieldPosition));
    let rowFraction = fieldPosition - floor(fieldPosition);
    let topRow = clamp(clamp(fieldRow, firstFieldRow, lastFieldRow) * 2 + field, bounds.y, bounds.w);
    let bottomRow = clamp(clamp(fieldRow + 1, firstFieldRow, lastFieldRow) * 2 + field, bounds.y, bounds.w);
    let columnPosition = textureCoordinate.x * f32(dimensions.x) - 0.5;
    let leftColumn = clamp(i32(floor(columnPosition)), bounds.x, bounds.z);
    let rightColumn = clamp(i32(floor(columnPosition)) + 1, bounds.x, bounds.z);
    let columnFraction = fract(columnPosition);
    let topLeft = ${load('leftColumn', 'topRow')};
    let topRight = ${load('rightColumn', 'topRow')};
    let bottomLeft = ${load('leftColumn', 'bottomRow')};
    let bottomRight = ${load('rightColumn', 'bottomRow')};
    return mix(mix(topLeft, topRight, columnFraction), mix(bottomLeft, bottomRight, columnFraction), rowFraction);
}`;
}

const LUMA_TEXTURE_HEIGHT = 'i32(textureDimensions(lumaTexture).y)';

function createTextureInterlacedChromaReadWGSL(functionName: string, textureName: string, valueType: 'f32' | 'vec2f'): string {
    const channels = valueType === 'f32' ? '.r' : '.rg';
    return createInterlacedChromaReadWGSL(
        `${functionName}(textureCoordinate: vec2f) -> ${valueType}`,
        `vec2i(textureDimensions(${textureName}))`,
        `vec4i(vec2i(0), vec2i(textureDimensions(${textureName})) - vec2i(1))`,
        LUMA_TEXTURE_HEIGHT,
        (column: string, row: string): string => `${valueType}(textureLoad(${textureName}, vec2i(${column}, ${row}), 0)${channels})`
    );
}

/**
 * Returns the WGSL coordinate at which the raw signals read chroma for `textureCoordinate`, a coordinate of the luma grid: the chroma sites' shift in luma samples
 * past it, so a chroma sample that lies left of or above its texel's center is read where it lies.
 */
function getChromaTextureCoordinateWGSL(chromaLumaShift: readonly [number, number]): string {
    const [ horizontalShift, verticalShift ] = chromaLumaShift;
    if (horizontalShift === 0 && verticalShift === 0) {
        return 'textureCoordinate';
    }
    const horizontal = horizontalShift === 0 ? '0.0' : `${toWGSLFloat(horizontalShift)} / f32(textureDimensions(lumaTexture).x)`;
    const vertical = verticalShift === 0 ? '0.0' : `${toWGSLFloat(verticalShift)} / f32(textureDimensions(lumaTexture).y)`;
    return `textureCoordinate + vec2f(${horizontal}, ${vertical})`;
}

/**
 * Generates the manual bilinear reads of the plane textures, which PassResources declares, as one YUV code triplet, with chroma at the stream's location.
 * With interlacedChroma, a 4:2:0 format's reads take chroma within each field of a frame the presentation uniform marks interlaced.
 */
function createRawYUVSamplingWGSL(
    format: SupportedRawVideoFrameFormat,
    interlacedChroma: boolean = false,
    chromaLocation: ChromaLocation | null = null
): string {
    const chromaLumaShift = getChromaLumaShift(chromaLocation, getRawChromaDivisors(format));
    const chromaTextureCoordinate = getChromaTextureCoordinateWGSL(chromaLumaShift);
    // A field read places chroma rows by the field's own siting, so its coordinate takes the horizontal shift alone
    const fieldChromaTextureCoordinate = getChromaTextureCoordinateWGSL([ chromaLumaShift[0], 0 ]);
    const fieldAware = interlacedChroma && hasVerticallySubsampledChroma(format);
    if (format === 'NV12') {
        if (fieldAware) {
            return joinWGSL([ LUMA_SAMPLING_WGSL, NV12_CHROMA_SAMPLING_WGSL, createTextureInterlacedChromaReadWGSL('sampleInterlacedChroma', 'chromaTexture', 'vec2f'), `
fn sampleRawYUV(textureCoordinate: vec2f) -> vec3f {
    var chroma = sampleChroma(${chromaTextureCoordinate});
    if (${INTERLACED_SIGNAL_CONDITION}) {
        chroma = sampleInterlacedChroma(${fieldChromaTextureCoordinate});
    }
    return vec3f(sampleLuma(textureCoordinate), chroma.x, chroma.y);
}` ]);
        }
        return joinWGSL([ LUMA_SAMPLING_WGSL, NV12_CHROMA_SAMPLING_WGSL, `
fn sampleRawYUV(textureCoordinate: vec2f) -> vec3f {
    let chroma = sampleChroma(${chromaTextureCoordinate});
    return vec3f(sampleLuma(textureCoordinate), chroma.x, chroma.y);
}` ]);
    }

    if (fieldAware) {
        return joinWGSL([
            LUMA_SAMPLING_WGSL,
            PLANAR_CHROMA_SAMPLING_WGSL,
            createTextureInterlacedChromaReadWGSL('sampleInterlacedChromaU', 'chromaUTexture', 'f32'),
            createTextureInterlacedChromaReadWGSL('sampleInterlacedChromaV', 'chromaVTexture', 'f32'),
            `
fn sampleRawYUV(textureCoordinate: vec2f) -> vec3f {
    if (${INTERLACED_SIGNAL_CONDITION}) {
        return vec3f(
            sampleLuma(textureCoordinate),
            sampleInterlacedChromaU(${fieldChromaTextureCoordinate}),
            sampleInterlacedChromaV(${fieldChromaTextureCoordinate})
        );
    }
    return vec3f(
        sampleLuma(textureCoordinate),
        sampleChromaU(${chromaTextureCoordinate}),
        sampleChromaV(${chromaTextureCoordinate})
    );
}` ]);
    }

    return joinWGSL([ LUMA_SAMPLING_WGSL, PLANAR_CHROMA_SAMPLING_WGSL, `
fn sampleRawYUV(textureCoordinate: vec2f) -> vec3f {
    return vec3f(
        sampleLuma(textureCoordinate),
        sampleChromaU(${chromaTextureCoordinate}),
        sampleChromaV(${chromaTextureCoordinate})
    );
}` ]);
}

/** Returns the vec3f expression that maps `rawYUV`, codes of the metadata's bit depth and range, to normalized YUV, its lines indented by `indentation`. */
function createRawYUVRangeExpression(metadata: InputColorMetadata, indentation: string): string {
    const codeScale = 2 ** (metadata.bitDepth - REFERENCE_CODE_BIT_DEPTH);
    const maximumCode = (2 ** metadata.bitDepth) - 1;
    const components = metadata.range === 'full' ?
        [
            `rawYUV.x / ${toWGSLFloat(maximumCode)}`,
            `(rawYUV.y - ${toWGSLFloat(CHROMA_CENTER_CODE * codeScale)}) / ${toWGSLFloat(maximumCode)}`,
            `(rawYUV.z - ${toWGSLFloat(CHROMA_CENTER_CODE * codeScale)}) / ${toWGSLFloat(maximumCode)}`
        ] :
        [
            `(rawYUV.x - ${toWGSLFloat(LIMITED_LUMA_BLACK_CODE * codeScale)}) / ${toWGSLFloat(LIMITED_LUMA_EXCURSION * codeScale)}`,
            `(rawYUV.y - ${toWGSLFloat(CHROMA_CENTER_CODE * codeScale)}) / ${toWGSLFloat(LIMITED_CHROMA_EXCURSION * codeScale)}`,
            `(rawYUV.z - ${toWGSLFloat(CHROMA_CENTER_CODE * codeScale)}) / ${toWGSLFloat(LIMITED_CHROMA_EXCURSION * codeScale)}`
        ];
    const componentLines = components.map((component: string): string => `${indentation}    ${component}`);
    return `vec3f(\n${componentLines.join(',\n')}\n${indentation})`;
}

/** Returns `fn normalizeRawYUV(rawYUV: vec3f) -> vec3f`, which maps YUV codes of the metadata's bit depth and range to normalized YUV. */
export function createRawYUVRangeWGSL(metadata: InputColorMetadata): string {
    return `
fn normalizeRawYUV(rawYUV: vec3f) -> vec3f {
    return ${createRawYUVRangeExpression(metadata, FUNCTION_BODY_INDENTATION)};
}`;
}

/**
 * Returns `fn normalizeRawYUV(rawYUV: vec3f) -> vec3f` for codes of any of the given bit depths, which a WGSL `u32` expression picks at run time,
 * such as a frame pool slot's, at the metadata's range: one branch per depth, each createRawYUVRangeWGSL's arithmetic for it, so results stay bit for bit
 * those of a signal compiled for that depth. The last depth takes every other value.
 */
export function createSelectedBitDepthRawYUVRangeWGSL(metadata: InputColorMetadata, bitDepths: readonly number[], bitDepthExpression: string): string {
    const branches = bitDepths.map((bitDepth: number, depthIndex: number): string => {
        const selector = depthIndex === bitDepths.length - 1 ? 'default' : `case ${bitDepth}u`;
        return `        ${selector}: {
            return ${createRawYUVRangeExpression({ ...metadata, bitDepth }, CASE_BODY_INDENTATION)};
        }`;
    });
    return `
fn normalizeRawYUV(rawYUV: vec3f) -> vec3f {
    switch (${bitDepthExpression}) {
${branches.join('\n')}
    }
}`;
}

/** Returns `fn convertRawYUVToEncodedRGB(normalizedYUV: vec3f) -> vec3f`, the metadata's YUV to RGB matrix. */
export function createRawYUVMatrixWGSL(metadata: InputColorMetadata): string {
    switch (metadata.matrix) {
        case 'bt709':
            return BT709_MATRIX_WGSL;
        case 'bt2020-ncl':
            return BT2020_NCL_MATRIX_WGSL;
        // BT.601 uses Kr 0.299 and Kb 0.114 for both its 525 and 625-line systems
        case 'bt470bg':
        case 'smpte170m':
            return BT601_MATRIX_WGSL;
    }
}

/**
 * Returns the limited-range compatible base an FEL frame without its EL presents, at the bit depth of its BL format.
 * The per-frame checks hold that depth equal to the RPU's BL bit depth, which reconstruction normalizes by.
 */
function getDolbyVisionDualLayerBaseMetadata(
    baseLayerFallback: DolbyVisionDualLayerBaseFallback,
    format: RawDolbyVisionFrameFormat
): InputColorMetadata {
    const bitDepth = getRawFormatBitDepth(format);
    switch (baseLayerFallback) {
        case 'hdr10':
            return createPQColorMetadata({ bitDepth });
        case 'sdr':
            // Profile 4 declares an SDR-compatible base layer, which an FEL frame without its EL presents unmodified
            return createSDRColorMetadata({ bitDepth });
    }
}

function getDolbyVisionDualLayerBypassCondition(
    baseLayerFallback: DolbyVisionDualLayerBaseFallback,
    felReconstruction: boolean
): string | null {
    if (baseLayerFallback !== 'sdr') {
        return null;
    }
    return felReconstruction ? FEL_WITHOUT_ENHANCEMENT_CONDITION : FEL_CONDITION;
}

/**
 * Returns the bilinear read of the external texture, which the identity route presents unchanged.
 * Its planes derive from the RGB through the stream's metadata, the conversion the browser made, so it has none while the metadata is unknown.
 */
export function createExternalIdentitySignal(
    metadata: InputColorMetadata | null,
    chromaSubsampling: ChromaSubsampling | null = null,
    chromaLocation: ChromaLocation | null = null
): SignalDefinition {
    if (metadata !== null) {
        assertValidInputColorMetadata(metadata);
    }
    return {
        bypassCondition: null,
        code: joinWGSL([ `
fn ${SIGNAL_ENTRY_POINT}(coordinate: vec2f) -> vec4f {
    return vec4f(textureSampleBaseClampToEdge(videoTexture, videoSampler, coordinate).rgb, 1.0);
}` ]),
        entryPoint: SIGNAL_ENTRY_POINT,
        name: `${SIGNAL_NAME_PREFIX}.external-identity`,
        planes: metadata === null ? null : createExternalPlanes(metadata, chromaSubsampling, chromaLocation),
        resources: EXTERNAL_RESOURCES,
        sourceKind: 'external'
    };
}

/** Throws `external-hdr: <field> <value>, expected <values>` unless metadata is the limited-range 10-bit BT.2020 PQ or HLG the neutralization recovers. */
function assertExternalHDRMetadata(metadata: InputColorMetadata): void {
    const fields: readonly (readonly [string, number | string, readonly (number | string)[]])[] = [
        [ 'bitDepth', metadata.bitDepth, [ EXTERNAL_HDR_BIT_DEPTH ] ],
        [ 'matrix', metadata.matrix, [ 'bt2020-ncl' ] ],
        [ 'primaries', metadata.primaries, [ 'bt2020' ] ],
        [ 'range', metadata.range, [ 'limited' ] ],
        [ 'transfer', metadata.transfer, [ 'pq', 'hlg' ] ]
    ];
    for (const [ field, value, expectedValues ] of fields) {
        if (!expectedValues.includes(value)) {
            throw new RangeError(`external-hdr: ${field} ${value}, expected ${expectedValues.join(' or ')}`);
        }
    }
}

/** Returns the recovery of neutralized 10-bit HDR YUV from Chromium's opaque BT.709 texture, converted to encoded RGB. */
export function createExternalHDRSignal(
    metadata: InputColorMetadata,
    chromaSubsampling: ChromaSubsampling | null = null,
    chromaLocation: ChromaLocation | null = null
): SignalDefinition {
    assertValidInputColorMetadata(metadata);
    assertExternalHDRMetadata(metadata);

    const entryWGSL = `
fn ${SIGNAL_ENTRY_POINT}(coordinate: vec2f) -> vec4f {
    let encodedBT709RGB = textureSampleBaseClampToEdge(
        videoTexture,
        videoSampler,
        coordinate
    ).rgb;
    let rawYUV = recoverLimitedRangeBT709YUV(encodedBT709RGB);
    let normalizedYUV = normalizeRawYUV(rawYUV);
    let encodedHDRRGB = convertRawYUVToEncodedRGB(normalizedYUV);
    return vec4f(encodedHDRRGB, 1.0);
}`;
    return {
        bypassCondition: null,
        code: joinWGSL([
            BT709_LIMITED_YUV_RECOVERY_WGSL,
            createRawYUVRangeWGSL(metadata),
            createRawYUVMatrixWGSL(metadata),
            entryWGSL
        ]),
        entryPoint: SIGNAL_ENTRY_POINT,
        name: `${SIGNAL_NAME_PREFIX}.external-hdr`,
        planes: createExternalHDRPlanes(metadata, chromaSubsampling, chromaLocation),
        resources: EXTERNAL_RESOURCES,
        sourceKind: 'external'
    };
}

/** Returns Profile 5 reconstruction from Chromium's opaque BT.709 texture into encoded BT.2020 PQ. */
export function createExternalDolbyVisionSignal(): SignalDefinition {
    const entryWGSL = `
fn ${SIGNAL_ENTRY_POINT}(coordinate: vec2f) -> vec4f {
    let encodedBT709RGB = textureSampleBaseClampToEdge(
        videoTexture,
        videoSampler,
        coordinate
    ).rgb;
    let encodedBT2020PQ = reconstructDolbyVisionBT2020PQ(
        recoverDolbyVisionBaseSignal(encodedBT709RGB)
    );
    return vec4f(encodedBT2020PQ, 1.0);
}`;
    return {
        bypassCondition: null,
        code: joinWGSL([
            createDolbyVisionColorFunctionsWGSL(),
            BT709_LIMITED_YUV_RECOVERY_WGSL,
            DOLBY_VISION_BASE_SIGNAL_RECOVERY_WGSL,
            entryWGSL
        ]),
        entryPoint: SIGNAL_ENTRY_POINT,
        name: `${SIGNAL_NAME_PREFIX}.external-dolby-vision`,
        planes: null,
        resources: EXTERNAL_DOLBY_VISION_RESOURCES,
        sourceKind: 'external'
    };
}

/**
 * Returns the manual bilinear YUV read of raw planes in format, with 4:2:0 chroma at the stream's location, normalized by the metadata's range and
 * converted by its matrix.
 * With interlacedChroma, as a deinterlacing plan's signal, 4:2:0 chroma is read within each field of a frame the presentation uniform marks interlaced.
 */
export function createRawYUVSignal(
    format: SupportedRawVideoFrameFormat,
    metadata: InputColorMetadata,
    interlacedChroma: boolean = false,
    chromaLocation: ChromaLocation | null = null
): SignalDefinition {
    assertValidInputColorMetadata(metadata);
    const formatBitDepth = getRawFormatBitDepth(format);
    if (metadata.bitDepth !== formatBitDepth) {
        throw new RangeError(`bit-depth: ${format} is ${formatBitDepth}-bit, metadata ${metadata.bitDepth}-bit`);
    }

    const entryWGSL = `
fn ${SIGNAL_ENTRY_POINT}(coordinate: vec2f) -> vec4f {
    let normalizedYUV = normalizeRawYUV(sampleRawYUV(coordinate));
    let encodedRGB = convertRawYUVToEncodedRGB(normalizedYUV);
    return vec4f(encodedRGB, 1.0);
}`;
    // Only 4:2:0 chroma has rows the two fields share, so other formats keep their one read
    const fieldAwareChroma = interlacedChroma && hasVerticallySubsampledChroma(format);
    return {
        bypassCondition: null,
        code: joinWGSL([
            createRawYUVSamplingWGSL(format, fieldAwareChroma, chromaLocation),
            createRawYUVRangeWGSL(metadata),
            createRawYUVMatrixWGSL(metadata),
            entryWGSL
        ]),
        entryPoint: SIGNAL_ENTRY_POINT,
        name: `${SIGNAL_NAME_PREFIX}.raw-yuv.${format}${fieldAwareChroma ? INTERLACED_CHROMA_NAME_SUFFIX : ''}`,
        planes: createRawYUVPlanes(format, metadata, chromaLocation),
        resources: format === 'NV12' ? NV12_RESOURCES : PLANAR_RESOURCES,
        sourceKind: 'planes'
    };
}

/**
 * How a Dolby Vision signal reads its layers: the WGSL whose function returns a coordinate's BL codes, and the EL's read where the source holds an EL,
 * with the resources, source, entry point, and name of the signal.
 * The raw planes and the frame pool each have one, and the reconstruction around them is the same text, so both present the same codes alike.
 */
export type DolbyVisionSignalSource = Readonly<{
    /** The resources of a signal that reads the BL and the RPU */
    baseResources: readonly EngineResource[]
    /** `fn <name>(textureCoordinate: vec2f) -> vec3f`: the BL's codes at a coordinate normalized over the BL's coded frame */
    baseSamplingFunction: string
    baseSamplingWGSL: string
    /** The EL's read at the same coordinate and the resources of a signal that composes it; null for a source that holds no EL */
    enhancement: Readonly<{ resources: readonly EngineResource[]; samplingFunction: string; samplingWGSL: string }> | null
    entryPoint: string
    /** What the profile, an FEL mark, and the format follow in the signal's name */
    namePrefix: string
    sourceKind: PresentationSourceKind
}>;

/** Returns how the raw Dolby Vision signal reads a BL of raw planes in format, with 4:2:0 chroma at the stream's location, and its I420P10 EL. */
function createRawDolbyVisionSignalSource(format: RawDolbyVisionFrameFormat, chromaLocation: ChromaLocation | null): DolbyVisionSignalSource {
    return {
        baseResources: RAW_DOLBY_VISION_RESOURCES,
        baseSamplingFunction: 'sampleRawYUV',
        baseSamplingWGSL: createRawYUVSamplingWGSL(format, false, chromaLocation),
        enhancement: {
            resources: RAW_DOLBY_VISION_FEL_RESOURCES,
            samplingFunction: 'sampleRawEnhancementYUV',
            samplingWGSL: ENHANCEMENT_SAMPLING_WGSL
        },
        entryPoint: SIGNAL_ENTRY_POINT,
        namePrefix: `${SIGNAL_NAME_PREFIX}.raw-dolby-vision`,
        sourceKind: 'planes'
    };
}

/** Returns single-layer RPU reconstruction of a source's BL codes into encoded BT.2020 PQ. */
function createDolbyVisionSingleLayerSignal(source: DolbyVisionSignalSource, format: RawDolbyVisionFrameFormat, profile: 5 | 8): SignalDefinition {
    const entryWGSL = `
fn ${source.entryPoint}(coordinate: vec2f) -> vec4f {
    let encodedBT2020PQ = reconstructDolbyVisionBT2020PQ(
        ${source.baseSamplingFunction}(coordinate)
    );
    return vec4f(encodedBT2020PQ, 1.0);
}`;
    return {
        bypassCondition: null,
        code: joinWGSL([ source.baseSamplingWGSL, createDolbyVisionColorFunctionsWGSL(), entryWGSL ]),
        entryPoint: source.entryPoint,
        name: `${source.namePrefix}.profile-${profile}.${format}`,
        planes: null,
        resources: source.baseResources,
        sourceKind: source.sourceKind
    };
}

/**
 * Returns dual-layer MEL reconstruction, optional FEL residual reconstruction, and the compatible base an FEL frame falls back to without its EL.
 * Profile 7 falls back to its HDR10 base, a normal PQ source; Profile 4 to its SDR base, which bypassCondition presents unmodified.
 * The BL is sampled in its own planar format, with 4:2:0 chroma at the stream's location, and the EL as its source holds it.
 */
function createDolbyVisionDualLayerSignal(
    source: DolbyVisionSignalSource,
    format: RawDolbyVisionFrameFormat,
    profile: 4 | 7,
    felReconstruction: boolean
): SignalDefinition {
    const enhancement = felReconstruction ? source.enhancement : null;
    if (felReconstruction && !enhancement) {
        throw new RangeError(`felReconstruction: ${source.namePrefix} holds no enhancement layer`);
    }
    const baseLayerFallback: DolbyVisionDualLayerBaseFallback = profile === 4 ? 'sdr' : 'hdr10';
    const baseLayerMetadata = getDolbyVisionDualLayerBaseMetadata(baseLayerFallback, format);
    const baseLayerFallbackStatement = baseLayerFallback === 'hdr10' ?
        'encodedBT2020PQ = convertRawYUVToEncodedRGB(normalizeRawYUV(rawBaseSignal));' :
        'return presentSDRBaseLayer(rawBaseSignal);';
    const felStatement = enhancement ?
        `if (enhancement.enhancementPresent != 0u) {
            encodedBT2020PQ = reconstructDolbyVisionBT2020PQWithEnhancement(
                rawBaseSignal,
                ${enhancement.samplingFunction}(coordinate),
                true
            );
        } else {
            ${baseLayerFallbackStatement}
        }` :
        baseLayerFallbackStatement;
    const entryWGSL = `
fn ${source.entryPoint}(coordinate: vec2f) -> vec4f {
    let rawBaseSignal = ${source.baseSamplingFunction}(coordinate);
    var encodedBT2020PQ: vec3f;
    if (isDolbyVisionFEL()) {
        ${felStatement}
    } else {
        encodedBT2020PQ = reconstructDolbyVisionBT2020PQ(rawBaseSignal);
    }
    return vec4f(encodedBT2020PQ, 1.0);
}`;

    const declarations: string[] = [];
    declarations.push(source.baseSamplingWGSL);
    if (enhancement) {
        declarations.push(enhancement.samplingWGSL);
    }
    declarations.push(
        createDolbyVisionColorFunctionsWGSL(),
        createRawYUVRangeWGSL(baseLayerMetadata),
        createRawYUVMatrixWGSL(baseLayerMetadata)
    );
    if (baseLayerFallback === 'sdr') {
        declarations.push(SDR_BASE_LAYER_PRESENTATION_WGSL);
    }
    declarations.push(entryWGSL);
    return {
        bypassCondition: getDolbyVisionDualLayerBypassCondition(baseLayerFallback, felReconstruction),
        code: joinWGSL(declarations),
        entryPoint: source.entryPoint,
        name: `${source.namePrefix}.profile-${profile}${felReconstruction ? '-fel' : ''}.${format}`,
        planes: null,
        resources: enhancement ? enhancement.resources : source.baseResources,
        sourceKind: source.sourceKind
    };
}

/**
 * Returns RPU reconstruction of the BL codes a source reads, in format, into encoded BT.2020 PQ.
 * Profiles 5 and 8 are single-layer, so felReconstruction applies only to the dual-layer Profiles 4 and 7, and only to a source that holds an EL.
 */
export function createDolbyVisionSignal(
    source: DolbyVisionSignalSource,
    format: RawDolbyVisionFrameFormat,
    profile: DolbyVisionReconstructionProfile,
    felReconstruction: boolean
): SignalDefinition {
    switch (profile) {
        case 4:
        case 7:
            return createDolbyVisionDualLayerSignal(source, format, profile, felReconstruction);
        case 5:
        case 8:
            return createDolbyVisionSingleLayerSignal(source, format, profile);
    }
}

/**
 * Returns RPU reconstruction of raw BL planes in format, with 4:2:0 chroma at the stream's location, into encoded BT.2020 PQ.
 * Profiles 5 and 8 are single-layer, so felReconstruction applies only to the dual-layer Profiles 4 and 7, whose EL is I420P10.
 */
export function createRawDolbyVisionSignal(
    format: RawDolbyVisionFrameFormat,
    profile: DolbyVisionReconstructionProfile,
    felReconstruction: boolean,
    chromaLocation: ChromaLocation | null = null
): SignalDefinition {
    return createDolbyVisionSignal(createRawDolbyVisionSignalSource(format, chromaLocation), format, profile, felReconstruction);
}
