// The fixed signal step of the GPU decode route: it samples a decoded pool slot in place and returns 'source' RGB.
// Its sampling, range, and matrix math are the raw plane route's (createRawYUVColorPipelineWGSL), read from the pool buffer instead of integer textures.
// Function names carry a framePool prefix so they never collide with the built-in library's.
import { assertValidInputColorMetadata, type InputColorMetadata } from '../../color/ColorMetadata';
import type { SignalDefinition } from '../../presentation/passes/PassTypes';
import type { SupportedRawVideoFrameFormat } from '../RawVideoFrameCopy';
import { getGPUDecoderFormatFacts, isGPUDecoderOutputFormat, type GPUDecoderFormatFacts } from './GPUDecodeFormats';

/** The signal's entry point: `fn framePoolSignal(coordinate: vec2f) -> vec4f`. */
export const FRAME_POOL_SIGNAL_ENTRY_POINT = 'framePoolSignal';

const FRAME_POOL_SIGNAL_NAME = 'frame-pool';
const DECIMAL_PLACES = 9;
const EIGHT_BIT_CODE_SCALE_DEPTH = 8;
const NEUTRAL_CHROMA_EIGHT_BIT_CODE = 128;
const LIMITED_BLACK_EIGHT_BIT_CODE = 16;
const LIMITED_LUMA_EIGHT_BIT_RANGE = 219;
const LIMITED_CHROMA_EIGHT_BIT_RANGE = 224;

// The same formatting as ColorPipelineShader, so the range math is the same text
function toWGSLFloat(value: number): string {
    if (!Number.isFinite(value)) {
        throw new RangeError('WGSL constants must be finite');
    }
    return value.toFixed(DECIMAL_PLACES);
}

function createLoadSampleWGSL(bytesPerSample: GPUDecoderFormatFacts['bytesPerSample']): string {
    const sampleMask = bytesPerSample === 1 ? '0xFFu' : '0xFFFFu';
    return `
fn framePoolLoadSample(planeIndex: u32, position: vec2i) -> f32 {
    let plane = framePoolLayout.planes[planeIndex];
    let byteAddress = framePoolLayout.slotByteOffset + plane.byteOffset
        + u32(position.y) * plane.bytesPerRow + u32(position.x) * ${bytesPerSample}u;
    return f32((framePool[byteAddress >> 2u] >> ((byteAddress & 3u) * 8u)) & ${sampleMask});
}`;
}

// The raw plane shader's manual bilinear sample, with the plane's size from the layout uniform in place of textureDimensions
const SAMPLE_PLANE_WGSL = `
fn framePoolSamplePlane(planeIndex: u32, textureCoordinate: vec2f) -> f32 {
    let plane = framePoolLayout.planes[planeIndex];
    let dimensions = vec2f(f32(plane.width), f32(plane.height));
    let samplePosition = textureCoordinate * dimensions - vec2f(0.5);
    let basePosition = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let maximumPosition = vec2i(i32(plane.width), i32(plane.height)) - vec2i(1);
    let topLeft = framePoolLoadSample(planeIndex, clamp(basePosition, vec2i(0), maximumPosition));
    let topRight = framePoolLoadSample(planeIndex, clamp(basePosition + vec2i(1, 0), vec2i(0), maximumPosition));
    let bottomLeft = framePoolLoadSample(planeIndex, clamp(basePosition + vec2i(0, 1), vec2i(0), maximumPosition));
    let bottomRight = framePoolLoadSample(planeIndex, clamp(basePosition + vec2i(1), vec2i(0), maximumPosition));
    return mix(mix(topLeft, topRight, fraction.x), mix(bottomLeft, bottomRight, fraction.x), fraction.y);
}`;

function createSampleYUVWGSL(formatFacts: GPUDecoderFormatFacts): string {
    // HEVC defaults subsampled chroma to horizontal left siting when no location is signaled, as the raw plane shader assumes
    const chromaTextureCoordinate = formatFacts.chromaWidthDivisor === 2 ?
        'textureCoordinate + vec2f(0.5 / f32(framePoolLayout.planes[0].width), 0.0)' :
        'textureCoordinate';
    return `
fn framePoolSampleYUV(textureCoordinate: vec2f) -> vec3f {
    return vec3f(
        framePoolSamplePlane(0u, textureCoordinate),
        framePoolSamplePlane(1u, ${chromaTextureCoordinate}),
        framePoolSamplePlane(2u, ${chromaTextureCoordinate})
    );
}`;
}

// The body of the raw plane shader's normalizeRawYUV
function createNormalizeYUVWGSL(metadata: InputColorMetadata): string {
    const codeScale = 2 ** (metadata.bitDepth - EIGHT_BIT_CODE_SCALE_DEPTH);
    const maximumCode = (2 ** metadata.bitDepth) - 1;
    if (metadata.range === 'full') {
        return `
fn framePoolNormalizeYUV(rawYUV: vec3f) -> vec3f {
    return vec3f(
        rawYUV.x / ${toWGSLFloat(maximumCode)},
        (rawYUV.y - ${toWGSLFloat(NEUTRAL_CHROMA_EIGHT_BIT_CODE * codeScale)}) / ${toWGSLFloat(maximumCode)},
        (rawYUV.z - ${toWGSLFloat(NEUTRAL_CHROMA_EIGHT_BIT_CODE * codeScale)}) / ${toWGSLFloat(maximumCode)}
    );
}`;
    }

    return `
fn framePoolNormalizeYUV(rawYUV: vec3f) -> vec3f {
    return vec3f(
        (rawYUV.x - ${toWGSLFloat(LIMITED_BLACK_EIGHT_BIT_CODE * codeScale)}) / ${toWGSLFloat(LIMITED_LUMA_EIGHT_BIT_RANGE * codeScale)},
        (rawYUV.y - ${toWGSLFloat(NEUTRAL_CHROMA_EIGHT_BIT_CODE * codeScale)}) / ${toWGSLFloat(LIMITED_CHROMA_EIGHT_BIT_RANGE * codeScale)},
        (rawYUV.z - ${toWGSLFloat(NEUTRAL_CHROMA_EIGHT_BIT_CODE * codeScale)}) / ${toWGSLFloat(LIMITED_CHROMA_EIGHT_BIT_RANGE * codeScale)}
    );
}`;
}

// The body of the raw plane shader's convertRawYUVToEncodedRGB
function createConvertYUVWGSL(metadata: InputColorMetadata): string {
    switch (metadata.matrix) {
        case 'bt709':
            return `
fn framePoolConvertYUVToEncodedRGB(normalizedYUV: vec3f) -> vec3f {
    return vec3f(
        normalizedYUV.x + 1.5748 * normalizedYUV.z,
        normalizedYUV.x - 0.187324 * normalizedYUV.y - 0.468124 * normalizedYUV.z,
        normalizedYUV.x + 1.8556 * normalizedYUV.y
    );
}`;
        case 'bt2020-ncl':
            return `
fn framePoolConvertYUVToEncodedRGB(normalizedYUV: vec3f) -> vec3f {
    return vec3f(
        normalizedYUV.x + 1.4746 * normalizedYUV.z,
        normalizedYUV.x - 0.164553 * normalizedYUV.y - 0.571353 * normalizedYUV.z,
        normalizedYUV.x + 1.8814 * normalizedYUV.y
    );
}`;
        // BT.601 uses Kr 0.299 and Kb 0.114 for both its 525 and 625-line systems
        case 'bt470bg':
        case 'smpte170m':
            return `
fn framePoolConvertYUVToEncodedRGB(normalizedYUV: vec3f) -> vec3f {
    return vec3f(
        normalizedYUV.x + 1.402 * normalizedYUV.z,
        normalizedYUV.x - 0.344136 * normalizedYUV.y - 0.714136 * normalizedYUV.z,
        normalizedYUV.x + 1.772 * normalizedYUV.y
    );
}`;
    }
}

/**
 * Returns the signal step that reads a frame pool slot: a bilinear sample of the slot's planes at a coordinate normalized over the coded frame, converted to 'source' RGB.
 * It binds the 'frame-pool' resource, whose framePool and framePoolLayout PassResources declares, so the built-in color functions apply unchanged.
 */
export function createFramePoolSignal(format: SupportedRawVideoFrameFormat, metadata: InputColorMetadata): SignalDefinition {
    if (!isGPUDecoderOutputFormat(format)) {
        throw new RangeError(`A frame pool never holds ${format}`);
    }
    assertValidInputColorMetadata(metadata);
    const formatFacts = getGPUDecoderFormatFacts(format);
    if (metadata.bitDepth !== formatFacts.bitDepth) {
        throw new RangeError('Frame pool format bit depth does not match color metadata');
    }
    const code = [
        createLoadSampleWGSL(formatFacts.bytesPerSample),
        SAMPLE_PLANE_WGSL,
        createSampleYUVWGSL(formatFacts),
        createNormalizeYUVWGSL(metadata),
        createConvertYUVWGSL(metadata),
        `
fn ${FRAME_POOL_SIGNAL_ENTRY_POINT}(coordinate: vec2f) -> vec4f {
    return vec4f(framePoolConvertYUVToEncodedRGB(framePoolNormalizeYUV(framePoolSampleYUV(coordinate))), 1.0);
}`
    ].join('\n');
    return {
        bypassCondition: null,
        code,
        entryPoint: FRAME_POOL_SIGNAL_ENTRY_POINT,
        name: FRAME_POOL_SIGNAL_NAME,
        resources: [ 'frame-pool' ],
        sourceKind: 'frame-pool'
    };
}
