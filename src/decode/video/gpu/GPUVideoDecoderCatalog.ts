// The GPU video decoders a playback may choose: the video decoder packages a host hands the engine, each offered to the eligibility for one output format.
// A decoder takes a stream when the stream matches its accepts and its frame pool, buffers, and packet ring fit the device; the engine's book describes selection.
// Before a playback has its packages, a host summarizes them, and a summary that carries the package's header judges a stream by the same fit check.
import type { VideoDecoderPackage } from '../../packages/DecoderPackage';
import type { GPUDecoderOutputFormat } from './GPUDecodeFormats';
import { findGPUDecoderAcceptsFailure, findGPUDecoderStreamFitFailure } from './GPUDecoderStreamFit';
import type { GPUDecoderHeader } from './GPUDecodeTypes';
import { createGPUDecodeStreamFacts } from './GPUFramePool';

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

/** What a GPU decoder package decodes, as a host knows it before a playback has the package: its codec families and output formats, and its header when the host has it. */
export type GPUVideoDecoderSummary = Readonly<{
    codecs: readonly string[]
    /** The package's header, such as a server's catalog carries; a summary without one takes every stream of its codecs and formats */
    header?: GPUDecoderHeader
    /** The buffer limit of the device a playback would decode on, as an offer carries it; without one, a header judges its `accepts` and `monochrome` alone */
    maximumBufferByteLength?: number
    outputFormats: readonly string[]
}>;

/**
 * Returns whether a summarized decoder takes a stream of a codec that the container sizes width x height, decoded into format, as an offer's fit check judges it:
 * its codecs and formats, then with a header its `monochrome` for a 4:0:0 stream, its `accepts` conditions, and on a device whose limit is given its frame pool and buffers.
 */
export function isGPUVideoDecoderSummaryFit(
    summary: GPUVideoDecoderSummary,
    codec: string,
    format: GPUDecoderOutputFormat,
    width: number,
    height: number,
    monochrome: boolean
): boolean {
    if (!summary.codecs.includes(codec) || !summary.outputFormats.includes(format)) {
        return false;
    }
    const header = summary.header;
    if (header === undefined) {
        return true;
    }
    if (monochrome && !header.monochrome) {
        return false;
    }
    const stream = createGPUDecodeStreamFacts(width, height, format);
    const failure = summary.maximumBufferByteLength === undefined ?
        findGPUDecoderAcceptsFailure(header, stream, format) :
        findGPUDecoderStreamFitFailure(header, stream, format, summary.maximumBufferByteLength);
    return failure === null;
}
