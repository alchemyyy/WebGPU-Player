// The contracts of the GPU decode route: a user WGSL compute decoder's manifest, its frame pool, its failures, and its recoveries.
// The engine book's decoder packages chapter describes the design they implement.
import type { TransferableDolbyVisionEncodedFrameMetadata } from '../../../demux/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import type { PassExpression } from '../../../presentation/passes/PassTypes';
import type { VideoFrameFields } from '../VideoFields';
import type { GPUDecoderOutputFormat } from './GPUDecodeFormats';

/**
 * How a package recovers from an error its header names: it conceals the damage and the picture presents, the picture drops,
 * or the picture and every picture up to the next key packet drop while the last good frame holds; an error without one ends the attempt.
 */
export type GPUDecoderErrorRecovery = 'conceal' | 'drop' | 'resync';

/** The recoveries in rising severity; the prelude ranks each by its position plus one, and a fatal error 0. */
export const GPU_DECODER_ERROR_RECOVERIES: readonly GPUDecoderErrorRecovery[] = Object.freeze([ 'conceal', 'drop', 'resync' ]);

/** Returns whether header text names a recovery. */
export function isGPUDecoderErrorRecovery(value: string): value is GPUDecoderErrorRecovery {
    return (GPU_DECODER_ERROR_RECOVERIES as readonly string[]).includes(value);
}

/**
 * What the engine did about a recoverable error instead of failing the attempt: the concealed picture presented,
 * the picture dropped, or the picture and every picture up to the next key packet dropped while the last good frame held.
 */
export type GPUVideoDecodeRecoveryCode = 'concealed' | 'dropped' | 'resynced';

/** The recovery code of each header recovery. */
export const GPU_VIDEO_DECODE_RECOVERY_CODES: Readonly<Record<GPUDecoderErrorRecovery, GPUVideoDecodeRecoveryCode>> = Object.freeze({
    conceal: 'concealed',
    drop: 'dropped',
    resync: 'resynced'
});

/** One recovery: its code, the error's name as the header names it, with `parser ` before a parser's failure, and the failing value. */
export type GPUVideoDecodeRecovery = Readonly<{
    code: GPUVideoDecodeRecoveryCode
    errorName: string
    value: number
}>;

/** How often one kind of recovery happened, counted per code and error name, with the latest one's detail, `<error name>: <value>`. */
export type GPUVideoDecodeRecoveryCount = Readonly<{
    code: GPUVideoDecodeRecoveryCode
    count: number
    detail: string
}>;

/** Returns a recovery's detail, `<error name>: <value>`. */
export function describeGPUVideoDecodeRecovery(recovery: GPUVideoDecodeRecovery): string {
    return `${recovery.errorName}: ${recovery.value}`;
}

/** Returns whether a value crossing a worker boundary is a recovery. */
export function isGPUVideoDecodeRecovery(value: unknown): value is GPUVideoDecodeRecovery {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const recovery = value as Record<string, unknown>;
    return (recovery.code === 'concealed' || recovery.code === 'dropped' || recovery.code === 'resynced')
        && typeof recovery.errorName === 'string'
        && typeof recovery.value === 'number'
        && Number.isSafeInteger(recovery.value)
        && recovery.value >= 0;
}

/** A named scratch buffer a decoder declares. */
export type GPUDecoderBuffer = {
    /** Its size in bytes: a constant, or an expression over the stream and output format facts that the session evaluates. */
    byteLength: PassExpression
    /** Usable with `dispatchWorkgroupsIndirect`, written by an earlier entry point. */
    indirect: boolean
    name: string
};

/** One entry point in a decoder's dispatch sequence; exactly one of workgroupCounts and indirectBuffer is set. */
export type GPUDecoderDispatch = {
    entryPoint: string
    indirectBuffer: string | null
    workgroupCounts: readonly [PassExpression, PassExpression, PassExpression] | null
};

/**
 * A run of consecutive dispatches that repeats a stream-dependent number of times, as a wavefront dispatches once per wave.
 * The entry points find their iteration in the decoder's own state; a count of zero skips the run.
 */
export type GPUDecoderDispatchRepeat = {
    /** How many times the run dispatches: an expression over the stream and output format facts that the session evaluates */
    count: PassExpression
    /** How many dispatches the run holds */
    dispatchCount: number
    /** The run's first dispatch, an index into the decoder's dispatches */
    firstDispatch: number
};

/** The streams a decoder takes. */
export type GPUDecoderAcceptance = {
    /** The codec families it decodes, by the engine's codec names, such as hevc or vc1. */
    codecs: readonly string[]
    /** A condition over `stream.width`, `stream.height`, and `stream.bitDepth`, or null. */
    constraint: PassExpression | null
};

/** A parsed decoder: its `//!` header and its WGSL body. */
export type GPUDecoderManifest = {
    accepts: GPUDecoderAcceptance
    body: string
    bodyFirstLine: number
    buffers: readonly GPUDecoderBuffer[]
    dispatches: readonly GPUDecoderDispatch[]
    /** The recovery of each error code whose line declares one; a code without one is fatal. */
    errorRecoveries: ReadonlyMap<number, GPUDecoderErrorRecovery>
    /** The names of its error codes, the high byte of a status error word, which its parser reports too. */
    errors: ReadonlyMap<number, string>
    /** The package's id, which its versions share, and which hosts store it by. */
    id: string
    /** Whether it decodes a 4:0:0 stream into the 4:2:0 format of the stream's depth, with neutral chroma; eligibility offers a 4:0:0 stream to no other decoder. */
    monochrome: boolean
    name: string
    /** The planar formats it writes; a session decodes into one of them. */
    outputFormats: readonly GPUDecoderOutputFormat[]
    /** The largest packet in bytes, which sizes the packet ring. */
    packetByteLength: number
    /** The version of the parser interface its package's module implements, or null for a decoder that reads the container's packets. */
    parser: number | null
    /** The pool slots the decoder keeps as references. */
    references: number
    /** How many frames presentation order can trail decode order. */
    reorder: number
    /** The runs of dispatches that repeat, in dispatch order, none overlapping another */
    repeats: readonly GPUDecoderDispatchRepeat[]
    requiredFeatures: readonly string[]
    /** The state buffer's size in bytes: a constant, or an expression over the stream and output format facts. */
    stateByteLength: PassExpression
};

/** A decoder's `//!` header without its WGSL body, as a host reads it before it has the package, such as from a server's catalog: what eligibility's fit check reads. */
export type GPUDecoderHeader = Omit<GPUDecoderManifest, 'body' | 'bodyFirstLine'>;

/** Stream facts the planner and the decoder need, from the container or one header parse. */
export type GPUDecodeStreamFacts = {
    bitDepth: number
    codedHeight: number
    codedWidth: number
    visibleRectangle: { height: number; width: number; x: number; y: number }
};

/** A picture's visible size, which a parser may report: its top-left width x height samples, within the pool's coded size. */
export type GPUDecoderPictureSize = Readonly<{
    height: number
    width: number
}>;

/** The largest count a parser reports for a picture's run of a `repeat:` directive, which the directive's own count for the stream caps. */
export const GPU_DECODER_MAXIMUM_REPEAT_COUNT = 0xFFFF_FFFF;

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Returns whether a value crossing a worker boundary is a picture size: a positive integer width and height. */
export function isGPUDecoderPictureSize(value: unknown): value is GPUDecoderPictureSize {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const size = value as Record<string, unknown>;
    return isPositiveInteger(size.width) && isPositiveInteger(size.height);
}

/** Returns whether a value crossing a worker boundary is a picture's repeat counts: one u32 per `repeat:` directive. */
export function isGPUDecoderRepeatCounts(value: unknown): value is readonly number[] {
    return Array.isArray(value)
        && value.every((count: unknown): boolean => typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= GPU_DECODER_MAXIMUM_REPEAT_COUNT);
}

/**
 * A compressed packet the decode worker posts for the GPU decode route, or the GPU record of one picture its decoder's parser made of a packet.
 * Every picture of a packet takes the packet's timestamp, duration, and keyframe flag.
 */
export type GPUDecodePacket = {
    data: ArrayBuffer
    durationMicroseconds: number
    /**
     * The Dolby Vision RPUs of the picture's packet, which its frame carries to presentation, null for none; a repeat of the last good frame carries that frame's.
     * Absent for none, as on a route without Dolby Vision.
     */
    encodedDolbyVisionMetadata?: TransferableDolbyVisionEncodedFrameMetadata | null
    /** The frame's fields as the CPU side knows them, the parser's report or else the container's scan; a decoder's own report replaces them. */
    fields: VideoFrameFields | null
    /** A packet whose picture is lost, as after a parser's recoverable failure: it decodes nothing, and its frame repeats the last good frame at its time. */
    hold: boolean
    keyframe: boolean
    /**
     * The parser's output decisions since the previous picture, as GPU_DECODER_OUTPUT_EVENT words: which earlier pictures, or this one, present or drop.
     * Null for a decoder without a parser, whose frames present in timestamp order behind its reorder depth.
     */
    outputEvents: Uint32Array | null
    /** The recovery a held packet begins, such as the parser failure that lost its picture, which the session counts; null for none. */
    recovery: GPUVideoDecodeRecovery | null
    /**
     * How many times the picture's record runs each `repeat:` directive, in header order, each capped by the directive's count for the stream;
     * null runs every directive its count for the stream, as a decoder without a parser does.
     */
    repeatCounts: readonly number[] | null
    /** Set on the first packet after a seek or start, or after a parser restarted, which clears the decoder's state and restarts the picture numbering. */
    reset: boolean
    timestampMicroseconds: number
    /** The picture's own visible size, which its frame presents; null keeps the stream's visible rectangle. */
    visibleSize: GPUDecoderPictureSize | null
};

/**
 * How a parser reports the output format a picture decodes into: `(chroma_format << 8) | bit_depth`, chroma_format as chroma_format_idc counts it,
 * 0 for 4:0:0, which decodes into the 4:2:0 format of its depth; none, 0, keeps the session's format.
 */
export const GPU_DECODER_PICTURE_FORMAT = Object.freeze({
    bitDepthMask: 0xFF,
    chromaFormatMask: 0xFF,
    chromaFormatShift: 8,
    none: 0
});

/**
 * A parser's output event: bits 0 to 29 hold a picture's index, counted from 0 in decode order since the parser started, wrapping at 2^30.
 * Bit 31 set drops the picture instead of presenting it, as a picture its stream marks not for output; bit 30 is reserved and zero.
 */
export const GPU_DECODER_OUTPUT_EVENT = Object.freeze({
    discardBit: 0x8000_0000,
    pictureIndexMask: 0x3FFF_FFFF,
    pictureIndexModulus: 0x4000_0000,
    reservedBit: 0x4000_0000
});

/**
 * The check a GPU decode session failed; every failure ends the route's attempt.
 * - Creation: 'buffer-size', 'codec-private-size', 'coded-size', 'compile-error', 'decoder-unknown', 'device-unavailable', 'dispatch-count', 'feature-missing', 'format-unsupported', 'out-of-memory', 'packet-size' for a packet ring the device cannot bind, 'pipeline-error', 'pool-size', 'slot-count', 'state-size', 'storage-buffer-count', 'validation-error', 'visible-rectangle'.
 * - Decoding: 'decoder-error', a fatal error the decoder reported in its status, 'device-lost', 'dispatch-count' for a picture's repeat counts that do not match the header, 'output-event', 'packet-size', 'readback-failed', and 'visible-rectangle' for a header rectangle or a picture's visible size outside the pool.
 * An error whose header line declares a recovery is no failure: the session recovers and counts it.
 */
export type GPUVideoDecodeFailureCode =
    | 'accepts'
    | 'buffer-size'
    | 'codec-private-size'
    | 'coded-size'
    | 'compile-error'
    | 'decoder-error'
    | 'decoder-unknown'
    | 'device-lost'
    | 'device-unavailable'
    | 'dispatch-count'
    | 'feature-missing'
    | 'format-unsupported'
    | 'out-of-memory'
    | 'output-event'
    | 'packet-size'
    | 'pipeline-error'
    | 'pool-size'
    | 'readback-failed'
    | 'slot-count'
    | 'state-size'
    | 'storage-buffer-count'
    | 'validation-error'
    | 'visible-rectangle';

/** A failed check and a terse detail with the failing value, such as `packet-size: 4194305 > 4194304`. */
export type GPUVideoDecodeFailure = {
    code: GPUVideoDecodeFailureCode
    detail: string
};

/** A shader compile message, mapped to the decoder's source line or to the generated prelude. */
export type GPUDecoderCompileMessage = {
    column: number
    /** The line in the decoder's source, or in the generated module for the prelude. */
    line: number
    message: string
    source: 'decoder' | 'prelude'
};

/** A session or frame pool that could not be created, with its failure; a compile error also carries every mapped compile message. */
export class GPUVideoDecodeError extends Error {
    readonly compileMessages: readonly GPUDecoderCompileMessage[];
    readonly failure: GPUVideoDecodeFailure;

    constructor(failure: GPUVideoDecodeFailure, compileMessages: readonly GPUDecoderCompileMessage[] = []) {
        super(`${failure.code}: ${failure.detail}`);
        this.name = 'GPUVideoDecodeError';
        this.compileMessages = compileMessages;
        this.failure = failure;
    }
}
