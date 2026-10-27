// The fixed signal step of the GPU decode route: it samples a decoded pool slot in place and returns 'source' RGB.
// It is the raw YUV signal read from the pool buffer instead of integer textures: the same bilinear sample, chroma siting, range, and matrix.
// It reads each frame's sample size, bit depth, and chroma subsampling from the slot's layout uniform, so frames of every output format share one signal,
// as a stream that changes its format mid-stream needs; the stream's chroma location, which places 4:2:0 chroma, is compiled in.
// Its sampling functions carry a framePool prefix; the matrix function is the raw YUV signal's.
import { assertValidInputColorMetadata, type InputColorMetadata } from '../../../color/ColorMetadata';
import type { ChromaLocation } from '../../../demux/VideoChromaFormat';
import {
    createImagePlaneFunctionsWGSL,
    createInterlacedChromaReadWGSL,
    createPlaneTransformWGSL,
    createRawYUVMatrixWGSL,
    createSelectedBitDepthRawYUVRangeWGSL,
    getChromaLocationLumaShift,
    getChromaPlaneOffset,
    getPlaneFormats,
    HORIZONTALLY_SUBSAMPLED_CHROMA_LOCATION,
    INTERLACED_SIGNAL_CONDITION,
    PLANE_ENTRY_POINT_FIELDS,
    SIGNAL_PLANE_ENTRY_POINTS
} from './BuiltinSignals';
import { joinWGSL, toWGSLFloat } from './BuiltinWGSL';
import type { EngineResource, SignalDefinition, SignalPlanes } from '../PassTypes';
import type { SupportedRawVideoFrameFormat } from '../../../decode/video/RawVideoFrameCopy';
import {
    getGPUDecoderFormatFacts,
    GPU_DECODER_OUTPUT_BIT_DEPTHS,
    type GPUDecoderOutputFormat,
    isGPUDecoderOutputFormat
} from '../../../decode/video/gpu/GPUDecodeFormats';

/** The signal's entry point: `fn framePoolSignal(coordinate: vec2f) -> vec4f`. */
export const FRAME_POOL_SIGNAL_ENTRY_POINT = 'framePoolSignal';

const FRAME_POOL_SIGNAL_NAME_PREFIX = 'gpu-decode.signal.frame-pool';
// Names the signal that reads interlaced chroma within each field
const INTERLACED_CHROMA_NAME_SUFFIX = '.interlaced-chroma';
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

// The samples of a plane that lie in the frame's visible picture, first and last on each axis: the visible rectangle in luma samples, widened to whole
// samples of a subsampled plane, which no tap leaves, so a picture whose size is not a multiple of the pool's padding, or whose decoder writes rows it
// crops, reads its own edge samples there, as the raw route's texture of the picture and FFmpeg's scaler after cropping do
const PLANE_BOUNDS_WGSL = `
fn framePoolPlaneBounds(planeIndex: u32) -> vec4i {
    let lumaSize = vec2u(framePoolLayout.planes[0].width, framePoolLayout.planes[0].height);
    let planeSize = vec2u(framePoolLayout.planes[planeIndex].width, framePoolLayout.planes[planeIndex].height);
    let divisor = (lumaSize + planeSize - vec2u(1u)) / planeSize;
    let visibleEnd = framePoolLayout.visibleOrigin + framePoolLayout.visibleSize;
    let minimumPosition = min(framePoolLayout.visibleOrigin / divisor, planeSize - vec2u(1u));
    let maximumPosition = clamp((visibleEnd + divisor - vec2u(1u)) / divisor, minimumPosition + vec2u(1u), planeSize) - vec2u(1u);
    return vec4i(vec2i(minimumPosition), vec2i(maximumPosition));
}`;

// The raw YUV signal's manual bilinear sample, with the plane's size from the layout uniform in place of textureDimensions and its taps clamped to the
// visible picture's samples in place of the texture's
const SAMPLE_PLANE_WGSL = `${PLANE_BOUNDS_WGSL}

fn framePoolSamplePlane(planeIndex: u32, textureCoordinate: vec2f) -> f32 {
    let plane = framePoolLayout.planes[planeIndex];
    let dimensions = vec2f(f32(plane.width), f32(plane.height));
    let samplePosition = textureCoordinate * dimensions - vec2f(0.5);
    let basePosition = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let bounds = framePoolPlaneBounds(planeIndex);
    let minimumPosition = bounds.xy;
    let maximumPosition = bounds.zw;
    let topLeft = framePoolLoadSample(planeIndex, clamp(basePosition, minimumPosition, maximumPosition));
    let topRight = framePoolLoadSample(planeIndex, clamp(basePosition + vec2i(1, 0), minimumPosition, maximumPosition));
    let bottomLeft = framePoolLoadSample(planeIndex, clamp(basePosition + vec2i(0, 1), minimumPosition, maximumPosition));
    let bottomRight = framePoolLoadSample(planeIndex, clamp(basePosition + vec2i(1), minimumPosition, maximumPosition));
    return mix(mix(topLeft, topRight, fraction.x), mix(bottomLeft, bottomRight, fraction.x), fraction.y);
}`;

/**
 * Returns `fn framePoolChromaShift() -> vec2f`: where the slot's chroma samples lie from their texel centers, normalized over its luma plane,
 * positive left and up, as getChromaLumaShift places them by the slot's own subsampling: 4:2:0 chroma at the stream's location, 4:2:2 chroma on its
 * left luma column, and 4:4:4 chroma on its luma samples.
 */
function createChromaShiftWGSL(chromaLocation: ChromaLocation | null): string {
    const [ horizontalShift, verticalShift ] = getChromaLocationLumaShift(chromaLocation);
    const [ horizontallySubsampledShift ] = getChromaLocationLumaShift(HORIZONTALLY_SUBSAMPLED_CHROMA_LOCATION);
    return `
fn framePoolChromaShift() -> vec2f {
    let lumaSize = vec2u(framePoolLayout.planes[0].width, framePoolLayout.planes[0].height);
    let subsampled = vec2u(framePoolLayout.planes[1].width, framePoolLayout.planes[1].height) < lumaSize;
    var shift = vec2f(select(0.0, ${toWGSLFloat(horizontallySubsampledShift)}, subsampled.x), 0.0);
    if (subsampled.y) {
        shift = vec2f(${toWGSLFloat(horizontalShift)}, ${toWGSLFloat(verticalShift)});
    }
    return shift / vec2f(lumaSize);
}`;
}

const SAMPLE_YUV_WGSL = `
fn framePoolSampleYUV(textureCoordinate: vec2f) -> vec3f {
    let chromaTextureCoordinate = textureCoordinate + framePoolChromaShift();
    return vec3f(
        framePoolSamplePlane(0u, textureCoordinate),
        framePoolSamplePlane(1u, chromaTextureCoordinate),
        framePoolSamplePlane(2u, chromaTextureCoordinate)
    );
}`;

// A deinterlacing plan's read: 4:2:0 chroma of a frame the presentation uniform marks interlaced is read within each field, whose own siting places its rows,
// so its coordinate takes the horizontal shift alone
const INTERLACED_SAMPLE_YUV_WGSL = `
fn framePoolSampleYUV(textureCoordinate: vec2f) -> vec3f {
    let chromaShift = framePoolChromaShift();
    if (${INTERLACED_SIGNAL_CONDITION} && framePoolLayout.planes[1].height < framePoolLayout.planes[0].height) {
        let fieldChromaTextureCoordinate = textureCoordinate + vec2f(chromaShift.x, 0.0);
        return vec3f(
            framePoolSamplePlane(0u, textureCoordinate),
            framePoolSampleInterlacedChroma(1u, fieldChromaTextureCoordinate),
            framePoolSampleInterlacedChroma(2u, fieldChromaTextureCoordinate)
        );
    }
    let chromaTextureCoordinate = textureCoordinate + chromaShift;
    return vec3f(
        framePoolSamplePlane(0u, textureCoordinate),
        framePoolSamplePlane(1u, chromaTextureCoordinate),
        framePoolSamplePlane(2u, chromaTextureCoordinate)
    );
}`;

// The plane reads of plane passes: each plane on its own grid, chroma sited as the signal reads it, and the slot's own code scale and conversion
const PLANES_WGSL = `
fn ${SIGNAL_PLANE_ENTRY_POINTS.luma}(coordinate: vec2f) -> f32 {
    return framePoolSamplePlane(0u, coordinate);
}

fn ${SIGNAL_PLANE_ENTRY_POINTS.chroma}(coordinate: vec2f) -> vec2f {
    return vec2f(framePoolSamplePlane(1u, coordinate), framePoolSamplePlane(2u, coordinate));
}

fn ${SIGNAL_PLANE_ENTRY_POINTS.sitedChroma}(textureCoordinate: vec2f) -> vec2f {
    return ${SIGNAL_PLANE_ENTRY_POINTS.chroma}(textureCoordinate + framePoolChromaShift());
}

fn ${SIGNAL_PLANE_ENTRY_POINTS.codeScale}() -> f32 {
    return f32((1u << ${FRAME_POOL_BIT_DEPTH_EXPRESSION}) - 1u);
}

fn ${SIGNAL_PLANE_ENTRY_POINTS.conversion}(codes: vec3f) -> vec4f {
    return vec4f(convertRawYUVToEncodedRGB(normalizeRawYUV(codes)), 1.0);
}`;

/**
 * Returns the planes of the frame pool signal for a stream of the format: its subsampling and siting at the stream's location, read per slot as the signal reads them.
 * The transform, which planes derived from the signal's RGB take, holds the stream's metadata at the format's bit depth.
 */
function createFramePoolPlanes(format: GPUDecoderOutputFormat, metadata: InputColorMetadata, chromaLocation: ChromaLocation | null): SignalPlanes {
    const facts = getGPUDecoderFormatFacts(format);
    const divisors = { chromaHeightDivisor: facts.chromaHeightDivisor, chromaWidthDivisor: facts.chromaWidthDivisor };
    const chromaOffset = getChromaPlaneOffset(chromaLocation, divisors);
    return {
        ...getPlaneFormats(facts.bitDepth),
        ...divisors,
        ...PLANE_ENTRY_POINT_FIELDS,
        chromaOffset,
        rgb: false,
        code: joinWGSL([ PLANES_WGSL ]),
        imageCode: createImagePlaneFunctionsWGSL(chromaOffset, divisors),
        transformCode: createPlaneTransformWGSL({ ...metadata, bitDepth: facts.bitDepth })
    };
}

const SAMPLE_INTERLACED_CHROMA_WGSL = createInterlacedChromaReadWGSL(
    'framePoolSampleInterlacedChroma(planeIndex: u32, textureCoordinate: vec2f) -> f32',
    'vec2i(i32(framePoolLayout.planes[planeIndex].width), i32(framePoolLayout.planes[planeIndex].height))',
    'framePoolPlaneBounds(planeIndex)',
    'i32(framePoolLayout.planes[0].height)',
    (column: string, row: string): string => `framePoolLoadSample(planeIndex, vec2i(${column}, ${row}))`
);

/** The function the frame pool's sampling WGSL declares, which returns a slot's bilinear YUV codes at a coordinate normalized over the coded frame. */
export const FRAME_POOL_YUV_SAMPLING_FUNCTION = 'framePoolSampleYUV';

/**
 * Returns the WGSL that samples the bound slot through its layout uniform as the frame pool signal does, progressively, with 4:2:0 chroma at the stream's location:
 * the function FRAME_POOL_YUV_SAMPLING_FUNCTION names and those it calls.
 */
export function createFramePoolYUVSamplingWGSL(chromaLocation: ChromaLocation | null): string {
    return joinWGSL([ LOAD_SAMPLE_WGSL, SAMPLE_PLANE_WGSL, createChromaShiftWGSL(chromaLocation), SAMPLE_YUV_WGSL ]);
}

/**
 * Returns the signal step that reads a frame pool slot: a bilinear sample of the slot's planes at a coordinate normalized over the coded frame, converted to 'source' RGB.
 * It binds the 'frame-pool' resource, whose framePool and framePoolLayout PassResources declares, so the built-in color functions apply unchanged.
 * The format and the metadata's bit depth describe the stream's first frames; each frame's own layout decides how its samples read, and a slot's 4:2:0
 * chroma is read at the stream's location.
 * With interlacedChroma, as a deinterlacing plan's signal, a slot's 4:2:0 chroma is read within each field of a frame the presentation uniform marks interlaced.
 */
export function createFramePoolSignal(
    format: SupportedRawVideoFrameFormat,
    metadata: InputColorMetadata,
    interlacedChroma: boolean = false,
    chromaLocation: ChromaLocation | null = null
): SignalDefinition {
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
            createChromaShiftWGSL(chromaLocation),
            ...(interlacedChroma ? [ SAMPLE_INTERLACED_CHROMA_WGSL, INTERLACED_SAMPLE_YUV_WGSL ] : [ SAMPLE_YUV_WGSL ]),
            createSelectedBitDepthRawYUVRangeWGSL(metadata, GPU_DECODER_OUTPUT_BIT_DEPTHS, FRAME_POOL_BIT_DEPTH_EXPRESSION),
            createRawYUVMatrixWGSL(metadata),
            entryWGSL
        ]),
        entryPoint: FRAME_POOL_SIGNAL_ENTRY_POINT,
        name: `${FRAME_POOL_SIGNAL_NAME_PREFIX}.${format}${interlacedChroma ? INTERLACED_CHROMA_NAME_SUFFIX : ''}`,
        planes: createFramePoolPlanes(format, metadata, chromaLocation),
        resources: FRAME_POOL_RESOURCES,
        sourceKind: 'frame-pool'
    };
}
