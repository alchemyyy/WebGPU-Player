// The built-in signals: each route's fixed, decode-equivalent read of its source into 'source' RGB.
// Apart from the entry points, the WGSL is the legacy fused shader's text, so every route samples and reconstructs exactly as that shader did.
import {
    assertValidInputColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata,
    type InputColorMetadata
} from '../../../color/ColorMetadata';
import { createDolbyVisionColorFunctionsWGSL } from '../../../color/DolbyVisionColorTransform';
import { getRawFormatBitDepth, type SupportedRawVideoFrameFormat } from '../../../video/RawVideoFrameCopy';
import type { DolbyVisionReconstructionProfile } from '../../PresentationInput';
import type { EngineResource, RawDolbyVisionFrameFormat, SignalDefinition } from '../PassTypes';
import { joinWGSL, toWGSLFloat } from './BuiltinWGSL';

/** The compatible base a dual-layer signal presents for an FEL frame whose EL it does not reconstruct. */
type DolbyVisionDualLayerBaseFallback = 'hdr10' | 'sdr';

const SIGNAL_ENTRY_POINT = 'sampleBuiltinSignal';
const SIGNAL_NAME_PREFIX = 'builtin.signal';

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

// The Profile 4 frames that present their SDR base unmodified: FEL frames whose EL is missing, or every FEL frame when the signal does not reconstruct FEL
const FEL_WITHOUT_ENHANCEMENT_CONDITION = 'isDolbyVisionFEL() && enhancement.enhancementPresent == 0u';
const FEL_CONDITION = 'isDolbyVisionFEL()';

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

/**
 * Returns whether the raw signals treat a format's chroma as left-sited: each chroma sample lies on its left luma sample, half a luma sample left of its texel center.
 * HEVC defaults horizontally subsampled planar chroma to left siting when no location is signaled.
 */
export function hasLeftSitedChroma(format: SupportedRawVideoFrameFormat): boolean {
    return format.startsWith('I420') || format.startsWith('I422');
}

/** Generates the manual bilinear reads of the plane textures, which PassResources declares, as one YUV code triplet. */
function createRawYUVSamplingWGSL(format: SupportedRawVideoFrameFormat): string {
    const chromaTextureCoordinate = hasLeftSitedChroma(format) ?
        'textureCoordinate + vec2f(0.5 / f32(textureDimensions(lumaTexture).x), 0.0)' :
        'textureCoordinate';
    if (format === 'NV12') {
        return joinWGSL([ LUMA_SAMPLING_WGSL, NV12_CHROMA_SAMPLING_WGSL, `
fn sampleRawYUV(textureCoordinate: vec2f) -> vec3f {
    let chroma = sampleChroma(${chromaTextureCoordinate});
    return vec3f(sampleLuma(textureCoordinate), chroma.x, chroma.y);
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

/** Returns `fn normalizeRawYUV(rawYUV: vec3f) -> vec3f`, which maps YUV codes of the metadata's bit depth and range to normalized YUV. */
export function createRawYUVRangeWGSL(metadata: InputColorMetadata): string {
    const codeScale = 2 ** (metadata.bitDepth - REFERENCE_CODE_BIT_DEPTH);
    const maximumCode = (2 ** metadata.bitDepth) - 1;
    if (metadata.range === 'full') {
        return `
fn normalizeRawYUV(rawYUV: vec3f) -> vec3f {
    return vec3f(
        rawYUV.x / ${toWGSLFloat(maximumCode)},
        (rawYUV.y - ${toWGSLFloat(CHROMA_CENTER_CODE * codeScale)}) / ${toWGSLFloat(maximumCode)},
        (rawYUV.z - ${toWGSLFloat(CHROMA_CENTER_CODE * codeScale)}) / ${toWGSLFloat(maximumCode)}
    );
}`;
    }

    return `
fn normalizeRawYUV(rawYUV: vec3f) -> vec3f {
    return vec3f(
        (rawYUV.x - ${toWGSLFloat(LIMITED_LUMA_BLACK_CODE * codeScale)}) / ${toWGSLFloat(LIMITED_LUMA_EXCURSION * codeScale)},
        (rawYUV.y - ${toWGSLFloat(CHROMA_CENTER_CODE * codeScale)}) / ${toWGSLFloat(LIMITED_CHROMA_EXCURSION * codeScale)},
        (rawYUV.z - ${toWGSLFloat(CHROMA_CENTER_CODE * codeScale)}) / ${toWGSLFloat(LIMITED_CHROMA_EXCURSION * codeScale)}
    );
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

/** Returns the bilinear read of the external texture, which the identity route presents unchanged. */
export function createExternalIdentitySignal(): SignalDefinition {
    return {
        bypassCondition: null,
        code: joinWGSL([ `
fn ${SIGNAL_ENTRY_POINT}(coordinate: vec2f) -> vec4f {
    return vec4f(textureSampleBaseClampToEdge(videoTexture, videoSampler, coordinate).rgb, 1.0);
}` ]),
        entryPoint: SIGNAL_ENTRY_POINT,
        name: `${SIGNAL_NAME_PREFIX}.external-identity`,
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
export function createExternalHDRSignal(metadata: InputColorMetadata): SignalDefinition {
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
        resources: EXTERNAL_DOLBY_VISION_RESOURCES,
        sourceKind: 'external'
    };
}

/** Returns the manual bilinear YUV read of raw planes in format, normalized by the metadata's range and converted by its matrix. */
export function createRawYUVSignal(format: SupportedRawVideoFrameFormat, metadata: InputColorMetadata): SignalDefinition {
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
    return {
        bypassCondition: null,
        code: joinWGSL([
            createRawYUVSamplingWGSL(format),
            createRawYUVRangeWGSL(metadata),
            createRawYUVMatrixWGSL(metadata),
            entryWGSL
        ]),
        entryPoint: SIGNAL_ENTRY_POINT,
        name: `${SIGNAL_NAME_PREFIX}.raw-yuv.${format}`,
        resources: format === 'NV12' ? NV12_RESOURCES : PLANAR_RESOURCES,
        sourceKind: 'planes'
    };
}

/** Returns single-layer RPU reconstruction of raw BL codes into encoded BT.2020 PQ. */
function createRawDolbyVisionSingleLayerSignal(format: RawDolbyVisionFrameFormat, profile: 5 | 8): SignalDefinition {
    const entryWGSL = `
fn ${SIGNAL_ENTRY_POINT}(coordinate: vec2f) -> vec4f {
    let encodedBT2020PQ = reconstructDolbyVisionBT2020PQ(
        sampleRawYUV(coordinate)
    );
    return vec4f(encodedBT2020PQ, 1.0);
}`;
    return {
        bypassCondition: null,
        code: joinWGSL([ createRawYUVSamplingWGSL(format), createDolbyVisionColorFunctionsWGSL(), entryWGSL ]),
        entryPoint: SIGNAL_ENTRY_POINT,
        name: `${SIGNAL_NAME_PREFIX}.raw-dolby-vision.profile-${profile}.${format}`,
        resources: RAW_DOLBY_VISION_RESOURCES,
        sourceKind: 'planes'
    };
}

/**
 * Returns dual-layer MEL reconstruction, optional FEL residual reconstruction, and the compatible base an FEL frame falls back to without its EL.
 * Profile 7 falls back to its HDR10 base, a normal PQ source; Profile 4 to its SDR base, which bypassCondition presents unmodified.
 * The BL is sampled in its own planar format and the EL always as I420P10.
 */
function createRawDolbyVisionDualLayerSignal(
    format: RawDolbyVisionFrameFormat,
    profile: 4 | 7,
    felReconstruction: boolean
): SignalDefinition {
    const baseLayerFallback: DolbyVisionDualLayerBaseFallback = profile === 4 ? 'sdr' : 'hdr10';
    const baseLayerMetadata = getDolbyVisionDualLayerBaseMetadata(baseLayerFallback, format);
    const baseLayerFallbackStatement = baseLayerFallback === 'hdr10' ?
        'encodedBT2020PQ = convertRawYUVToEncodedRGB(normalizeRawYUV(rawBaseSignal));' :
        'return presentSDRBaseLayer(rawBaseSignal);';
    const felStatement = felReconstruction ?
        `if (enhancement.enhancementPresent != 0u) {
            encodedBT2020PQ = reconstructDolbyVisionBT2020PQWithEnhancement(
                rawBaseSignal,
                sampleRawEnhancementYUV(coordinate),
                true
            );
        } else {
            ${baseLayerFallbackStatement}
        }` :
        baseLayerFallbackStatement;
    const entryWGSL = `
fn ${SIGNAL_ENTRY_POINT}(coordinate: vec2f) -> vec4f {
    let rawBaseSignal = sampleRawYUV(coordinate);
    var encodedBT2020PQ: vec3f;
    if (isDolbyVisionFEL()) {
        ${felStatement}
    } else {
        encodedBT2020PQ = reconstructDolbyVisionBT2020PQ(rawBaseSignal);
    }
    return vec4f(encodedBT2020PQ, 1.0);
}`;

    const declarations: string[] = [];
    declarations.push(createRawYUVSamplingWGSL(format));
    if (felReconstruction) {
        declarations.push(ENHANCEMENT_SAMPLING_WGSL);
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
        entryPoint: SIGNAL_ENTRY_POINT,
        name: `${SIGNAL_NAME_PREFIX}.raw-dolby-vision.profile-${profile}${felReconstruction ? '-fel' : ''}.${format}`,
        resources: felReconstruction ? RAW_DOLBY_VISION_FEL_RESOURCES : RAW_DOLBY_VISION_RESOURCES,
        sourceKind: 'planes'
    };
}

/**
 * Returns RPU reconstruction of raw BL planes in format into encoded BT.2020 PQ.
 * Profiles 5 and 8 are single-layer, so felReconstruction applies only to the dual-layer Profiles 4 and 7.
 */
export function createRawDolbyVisionSignal(
    format: RawDolbyVisionFrameFormat,
    profile: DolbyVisionReconstructionProfile,
    felReconstruction: boolean
): SignalDefinition {
    switch (profile) {
        case 4:
        case 7:
            return createRawDolbyVisionDualLayerSignal(format, profile, felReconstruction);
        case 5:
        case 8:
            return createRawDolbyVisionSingleLayerSignal(format, profile);
    }
}
