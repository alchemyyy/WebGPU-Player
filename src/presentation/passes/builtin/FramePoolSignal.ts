// The fixed signal step of the GPU decode route: it samples a decoded pool slot in place and returns 'source' RGB.
// It is the raw YUV signal read from the pool buffer instead of integer textures: the same bilinear sample, chroma siting, range, and matrix.
// It reads each frame's sample size, bit depth, and chroma subsampling from the slot's layout uniform, so frames of every output format share one signal,
// as a stream that changes its format mid-stream needs. Its sampling functions carry a framePool prefix; the matrix function is the raw YUV signal's.
import { assertValidInputColorMetadata, type InputColorMetadata } from '../../../color/ColorMetadata';
import { createRawYUVMatrixWGSL, createSelectedBitDepthRawYUVRangeWGSL } from './BuiltinSignals';
import { joinWGSL } from './BuiltinWGSL';
import type { EngineResource, SignalDefinition } from '../PassTypes';
import type { SupportedRawVideoFrameFormat } from '../../../decode/video/RawVideoFrameCopy';
import { getGPUDecoderFormatFacts, GPU_DECODER_OUTPUT_BIT_DEPTHS, isGPUDecoderOutputFormat } from '../../../decode/video/gpu/GPUDecodeFormats';

/** The signal's entry point: `fn framePoolSignal(coordinate: vec2f) -> vec4f`. */
export const FRAME_POOL_SIGNAL_ENTRY_POINT = 'framePoolSignal';

const FRAME_POOL_SIGNAL_NAME_PREFIX = 'gpu-decode.signal.frame-pool';
const FRAME_POOL_RESOURCES: readonly EngineResource[] = Object.freeze([ 'frame-pool' ]);
// The slot's bit depth, which picks the normalization of its codes
const FRAME_POOL_BIT_DEPTH_EXPRESSION = 'framePoolLayout.bitDepth';

// One sample of a plane, 8 or 16 bits as the slot's layout says
const LOAD_SAMPLE_WGSL = `
fn framePoolLoadSample(planeIndex: u32, position: vec2i) -> f32 {
    let plane = framePoolLayout.planes[planeIndex];
    let bytesPerSample = framePoolLayout.bytesPerComponent;
    let byteAddress = framePoolLayout.slotByteOffset + plane.byteOffset
        + u32(position.y) * plane.bytesPerRow + u32(position.x) * bytesPerSample;
    let sampleMask = select(0xFFFFu, 0xFFu, bytesPerSample == 1u);
    return f32((framePool[byteAddress >> 2u] >> ((byteAddress & 3u) * 8u)) & sampleMask);
}`;

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

// Chroma subsampled across, as at 4:2:0 and 4:2:2, is sited left, so its coordinate moves half a luma sample; 4:4:4 chroma is co-sited
const SAMPLE_YUV_WGSL = `
fn framePoolSampleYUV(textureCoordinate: vec2f) -> vec3f {
    let lumaWidth = framePoolLayout.planes[0].width;
    let chromaOffset = select(0.0, 0.5 / f32(lumaWidth), framePoolLayout.planes[1].width < lumaWidth);
    let chromaTextureCoordinate = textureCoordinate + vec2f(chromaOffset, 0.0);
    return vec3f(
        framePoolSamplePlane(0u, textureCoordinate),
        framePoolSamplePlane(1u, chromaTextureCoordinate),
        framePoolSamplePlane(2u, chromaTextureCoordinate)
    );
}`;

/**
 * Returns the signal step that reads a frame pool slot: a bilinear sample of the slot's planes at a coordinate normalized over the coded frame, converted to 'source' RGB.
 * It binds the 'frame-pool' resource, whose framePool and framePoolLayout PassResources declares, so the built-in color functions apply unchanged.
 * The format and the metadata's bit depth describe the stream's first frames; each frame's own layout decides how its samples read.
 */
export function createFramePoolSignal(format: SupportedRawVideoFrameFormat, metadata: InputColorMetadata): SignalDefinition {
    if (!isGPUDecoderOutputFormat(format)) {
        throw new RangeError(`format: unsupported '${format}'`);
    }
    assertValidInputColorMetadata(metadata);
    const formatBitDepth = getGPUDecoderFormatFacts(format).bitDepth;
    if (metadata.bitDepth !== formatBitDepth) {
        throw new RangeError(`bitDepth: ${metadata.bitDepth}, expected ${formatBitDepth} for ${format}`);
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
            LOAD_SAMPLE_WGSL,
            SAMPLE_PLANE_WGSL,
            SAMPLE_YUV_WGSL,
            createSelectedBitDepthRawYUVRangeWGSL(metadata, GPU_DECODER_OUTPUT_BIT_DEPTHS, FRAME_POOL_BIT_DEPTH_EXPRESSION),
            createRawYUVMatrixWGSL(metadata),
            entryWGSL
        ]),
        entryPoint: FRAME_POOL_SIGNAL_ENTRY_POINT,
        name: `${FRAME_POOL_SIGNAL_NAME_PREFIX}.${format}`,
        resources: FRAME_POOL_RESOURCES,
        sourceKind: 'frame-pool'
    };
}
