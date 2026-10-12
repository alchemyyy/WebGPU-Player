// The contracts of the GPU decode route: a user WGSL compute decoder's manifest, its frame pool, and its failures.
// overhual/decoders.md in the engine root describes the design they implement.
import type { PassExpression } from '../../presentation/passes/PassTypes';
import type { GPUDecoderOutputFormat } from './GPUDecodeFormats';

/** A named scratch buffer a decoder declares. */
export type GPUDecoderBuffer = {
    byteLength: number
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

export type GPUDecoderVector = {
    file: string
    /** The first checked frame, counted in presentation order from the vector's first frame. */
    firstFrame: number
    lastFrame: number
    /**
     * The lowercase hexadecimal SHA-256 of the checked frames' planes, frame after frame.
     * Each frame contributes its luma plane, then its two chroma planes, at the stream's coded size, rows tightly packed and 16-bit samples little-endian.
     * That is FFmpeg's rawvideo output of those frames in the decoder's planar format, such as yuv422p10le, when the coded size is the visible size.
     */
    sha256: string
};

/** The streams a decoder takes. */
export type GPUDecoderAcceptance = {
    /** Container codec identifiers, such as MOV sample entry types or Matroska codec IDs. */
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
    name: string
    /** The planar format the decoder writes into a pool slot. */
    outputFormat: GPUDecoderOutputFormat
    /** The largest packet in bytes, which sizes the packet ring. */
    packetByteLength: number
    /** The pool slots the decoder keeps as references. */
    references: number
    /** How many frames presentation order can trail decode order. */
    reorder: number
    requiredFeatures: readonly string[]
    stateByteLength: number
    vector: GPUDecoderVector | null
};

/** Stream facts the planner and the decoder need, from the container or one header parse. */
export type GPUDecodeStreamFacts = {
    bitDepth: number
    codedHeight: number
    codedWidth: number
    visibleRectangle: { height: number; width: number; x: number; y: number }
};

/** A compressed packet the decode worker posts for the GPU decode route. */
export type GPUDecodePacket = {
    data: ArrayBuffer
    durationMicroseconds: number
    keyframe: boolean
    /** Set on the first packet after a seek or start, which clears the decoder's state. */
    reset: boolean
    timestampMicroseconds: number
};

/**
 * The check a GPU decode session failed; every failure ends the route's attempt.
 * - Creation: 'codec-private-size', 'coded-size', 'compile-error', 'dispatch-count', 'feature-missing', 'out-of-memory', 'pipeline-error', 'pool-size', 'slot-count', 'storage-buffer-count', 'validation-error', 'visible-rectangle'.
 * - Decoding: 'decoder-error', which the decoder reported in its status, 'device-lost', 'packet-size', and 'readback-failed'.
 */
export type GPUVideoDecodeFailureCode =
    | 'codec-private-size'
    | 'coded-size'
    | 'compile-error'
    | 'decoder-error'
    | 'device-lost'
    | 'dispatch-count'
    | 'feature-missing'
    | 'out-of-memory'
    | 'packet-size'
    | 'pipeline-error'
    | 'pool-size'
    | 'readback-failed'
    | 'slot-count'
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
