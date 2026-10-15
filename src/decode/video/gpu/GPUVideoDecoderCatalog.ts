// The GPU video decoders a playback may choose: the video decoder packages a host hands the engine, each offered to the eligibility for one output format.
// A decoder takes a stream when the stream matches its accepts and its frame pool, buffers, and packet ring fit the device; the engine's book describes selection.
import type { VideoDecoderPackage } from '../../packages/DecoderPackage';
import type { GPUDecoderOutputFormat } from './GPUDecodeFormats';

/** The GPU decoder a route plays through: the codec family it decodes the stream as, its package's id, which its versions share, and its package. */
export type GPUVideoDecoderSelection = Readonly<{
    codec: string
    decoderId: string
    package: VideoDecoderPackage
}>;

/** A decoder a playback may choose for one output format, with the buffer limit of the device it would run on. */
export type GPUVideoDecoderOffer = Readonly<{
    /** The codec families it decodes */
    codecs: readonly string[]
    /** Its package's id, the one its header declares */
    decoderId: string
    /** The output format it is offered for */
    format: GPUDecoderOutputFormat
    /** The largest buffer the device holds whole as one storage binding, which bounds the frame pool and each state, scratch, and packet ring buffer */
    maximumBufferByteLength: number
    package: VideoDecoderPackage
}>;

/** Returns a package's offer of one output format on a device with the given buffer limit. */
export function createGPUVideoDecoderOffer(
    decoderPackage: VideoDecoderPackage,
    format: GPUDecoderOutputFormat,
    maximumBufferByteLength: number
): GPUVideoDecoderOffer {
    return {
        codecs: decoderPackage.manifest.accepts.codecs,
        decoderId: decoderPackage.id,
        format,
        maximumBufferByteLength,
        package: decoderPackage
    };
}
