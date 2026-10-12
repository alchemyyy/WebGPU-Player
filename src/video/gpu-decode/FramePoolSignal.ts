// The fixed signal step of the GPU decode route: it samples a decoded pool slot in place and returns 'source' RGB.
// It is the raw YUV signal read from the pool buffer instead of integer textures: the same bilinear sample, chroma siting, range, and matrix.
// Its sampling functions carry a framePool prefix; the range and matrix functions are the raw YUV signal's, which never shares a chain with it.
import { assertValidInputColorMetadata, type InputColorMetadata } from '../../color/ColorMetadata';
import { createRawYUVMatrixWGSL, createRawYUVRangeWGSL, hasLeftSitedChroma } from '../../presentation/passes/builtin/BuiltinSignals';
import { joinWGSL } from '../../presentation/passes/builtin/BuiltinWGSL';
import type { EngineResource, SignalDefinition } from '../../presentation/passes/PassTypes';
import type { SupportedRawVideoFrameFormat } from '../RawVideoFrameCopy';
import { getGPUDecoderFormatFacts, isGPUDecoderOutputFormat, type GPUDecoderFormatFacts } from './GPUDecodeFormats';

/** The signal's entry point: `fn framePoolSignal(coordinate: vec2f) -> vec4f`. */
export const FRAME_POOL_SIGNAL_ENTRY_POINT = 'framePoolSignal';

const FRAME_POOL_SIGNAL_NAME_PREFIX = 'gpu-decode.signal.frame-pool';
const FRAME_POOL_RESOURCES: readonly EngineResource[] = Object.freeze([ 'frame-pool' ]);

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

// The raw YUV signal's manual bilinear sample, with the plane's size from the layout uniform in place of textureDimensions
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

function createSampleYUVWGSL(format: SupportedRawVideoFrameFormat): string {
    const chromaTextureCoordinate = hasLeftSitedChroma(format) ?
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

/**
 * Returns the signal step that reads a frame pool slot: a bilinear sample of the slot's planes at a coordinate normalized over the coded frame, converted to 'source' RGB.
 * It binds the 'frame-pool' resource, whose framePool and framePoolLayout PassResources declares, so the built-in color functions apply unchanged.
 */
export function createFramePoolSignal(format: SupportedRawVideoFrameFormat, metadata: InputColorMetadata): SignalDefinition {
    if (!isGPUDecoderOutputFormat(format)) {
        throw new RangeError(`format: unsupported '${format}'`);
    }
    assertValidInputColorMetadata(metadata);
    const formatFacts = getGPUDecoderFormatFacts(format);
    if (metadata.bitDepth !== formatFacts.bitDepth) {
        throw new RangeError(`bitDepth: ${metadata.bitDepth}, expected ${formatFacts.bitDepth} for ${format}`);
    }
    const entryWGSL = `
fn ${FRAME_POOL_SIGNAL_ENTRY_POINT}(coordinate: vec2f) -> vec4f {
    let normalizedYUV = normalizeRawYUV(framePoolSampleYUV(coordinate));
    let encodedRGB = convertRawYUVToEncodedRGB(normalizedYUV);
    return vec4f(encodedRGB, 1.0);
}`;
    return {
        bypassCondition: null,
        code: joinWGSL([
            createLoadSampleWGSL(formatFacts.bytesPerSample),
            SAMPLE_PLANE_WGSL,
            createSampleYUVWGSL(format),
            createRawYUVRangeWGSL(metadata),
            createRawYUVMatrixWGSL(metadata),
            entryWGSL
        ]),
        entryPoint: FRAME_POOL_SIGNAL_ENTRY_POINT,
        name: `${FRAME_POOL_SIGNAL_NAME_PREFIX}.${format}`,
        resources: FRAME_POOL_RESOURCES,
        sourceKind: 'frame-pool'
    };
}
