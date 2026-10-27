// The fixed signal step of the GPU decode route for Dolby Vision: it reads a BL pool slot in place and reconstructs it through the frame's RPU into encoded BT.2020 PQ.
// The reconstruction is the raw Dolby Vision signal's text; only the read differs, the frame pool signal's bilinear sample with chroma at the stream's location.
// No decoder decodes a Dolby Vision EL, so a dual-layer stream reconstructs from its BL alone, as on the raw route: MEL exactly, and FEL as its compatible base.
import { isGPUDecoderOutputFormat, type GPUDecoderOutputFormat } from '../../../decode/video/gpu/GPUDecodeFormats';
import type { ChromaLocation } from '../../../demux/VideoChromaFormat';
import type { DolbyVisionReconstructionProfile } from '../../PresentationInput';
import type { EngineResource, SignalDefinition } from '../PassTypes';
import { createDolbyVisionSignal, type DolbyVisionSignalSource } from './BuiltinSignals';
import { createFramePoolYUVSamplingWGSL, FRAME_POOL_YUV_SAMPLING_FUNCTION } from './FramePoolSignal';

/** The signal's entry point: `fn framePoolDolbyVisionSignal(coordinate: vec2f) -> vec4f`. */
export const FRAME_POOL_DOLBY_VISION_SIGNAL_ENTRY_POINT = 'framePoolDolbyVisionSignal';

const FRAME_POOL_DOLBY_VISION_SIGNAL_NAME_PREFIX = 'gpu-decode.signal.frame-pool-dolby-vision';
const FRAME_POOL_DOLBY_VISION_RESOURCES: readonly EngineResource[] = Object.freeze([ 'frame-pool', 'dolby-vision-rpu' ]);

/**
 * Returns RPU reconstruction of a BL frame pool slot in format, with 4:2:0 chroma at the stream's location, into encoded BT.2020 PQ.
 * It binds the 'frame-pool' and 'dolby-vision-rpu' resources; a dual-layer profile presents an FEL frame as its compatible base, since a frame pool holds no EL.
 */
export function createFramePoolDolbyVisionSignal(
    format: GPUDecoderOutputFormat,
    profile: DolbyVisionReconstructionProfile,
    chromaLocation: ChromaLocation | null = null
): SignalDefinition {
    if (!isGPUDecoderOutputFormat(format)) {
        throw new RangeError(`format: unsupported '${String(format)}'`);
    }
    const source: DolbyVisionSignalSource = {
        baseResources: FRAME_POOL_DOLBY_VISION_RESOURCES,
        baseSamplingFunction: FRAME_POOL_YUV_SAMPLING_FUNCTION,
        baseSamplingWGSL: createFramePoolYUVSamplingWGSL(chromaLocation),
        enhancement: null,
        entryPoint: FRAME_POOL_DOLBY_VISION_SIGNAL_ENTRY_POINT,
        namePrefix: FRAME_POOL_DOLBY_VISION_SIGNAL_NAME_PREFIX,
        sourceKind: 'frame-pool'
    };
    return createDolbyVisionSignal(source, format, profile, false);
}
