// The contracts of the GPU decode route: a user WGSL compute decoder's manifest and its frame pool.
// overhual/decoders.md in the engine root describes the design they implement.
import type { PassExpression } from '../../presentation/passes/PassTypes';
import type { SupportedRawVideoFrameFormat } from '../RawVideoFrameCopy';

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
    firstFrame: number
    lastFrame: number
    /** The lowercase hexadecimal SHA-256 of the decoded planes of those frames, concatenated in frame order. */
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
    outputFormat: SupportedRawVideoFrameFormat
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
