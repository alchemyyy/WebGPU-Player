import type { Microseconds } from '../../MediaTime';

export type TransferablePlanarPCM = {
    channelData: readonly Float32Array[]
    timestampMicroseconds: Microseconds
};

/** One PCM chunk, from the page on the node's port or from a producer on its own channel */
export type AudioWorkletEnqueueMessage = {
    channelData: readonly Float32Array[]
    generation: number
    sequence: number
    timestampMicroseconds: Microseconds
    type: 'enqueue'
};

/** Clears the queue and starts a generation; it also detaches the producer, whose chunks belong to the generation it replaces */
export type AudioWorkletFlushMessage = {
    generation: number
    mediaTimeMicroseconds: Microseconds
    type: 'flush'
};

/**
 * Hands the processor its end of a producer's channel, for the generation the preceding flush started.
 * The producer's chunks then reach the processor without the page, and their releases go back to it.
 */
export type AudioWorkletAttachProducerMessage = {
    generation: number
    port: MessagePort
    type: 'attach-producer'
};

/** Why the processor returned a producer's chunk: played to its end, or dropped at enqueue */
export type AudioWorkletReleaseReason = 'consumed' | 'invalid' | 'overflow' | 'stale-generation';

/** Returns one chunk to its producer with its channel buffers; a consumed chunk returns its credit */
export type AudioWorkletReleasedMessage = {
    channelBuffers: ArrayBuffer[]
    reason: AudioWorkletReleaseReason
    sequence: number
    type: 'released'
};

export type AudioWorkletPlaybackMessage = {
    playing: boolean
    type: 'playback'
};

export type AudioWorkletGainMessage = {
    muted: boolean
    type: 'gain'
    volume: number
};

export type AudioWorkletDestroyMessage = {
    type: 'destroy'
};

export type AudioWorkletDeactivateMessage = {
    generation: number
    leaseId: number
    type: 'deactivate'
};

export type AudioWorkletDeactivatedMessage = {
    leaseId: number
    type: 'deactivated'
};

export type AudioWorkletRetiredMessage = {
    type: 'retired'
};

export type CustomAudioWorkletMessage =
    | AudioWorkletAttachProducerMessage
    | AudioWorkletDeactivateMessage
    | AudioWorkletDestroyMessage
    | AudioWorkletEnqueueMessage
    | AudioWorkletFlushMessage
    | AudioWorkletGainMessage
    | AudioWorkletPlaybackMessage;

export type AudioWorkletTelemetryReason =
    | 'enqueue'
    | 'flush'
    | 'overflow'
    | 'periodic'
    | 'stale-generation'
    | 'underflow'
    | 'underflow-recovered';

export type AudioSignalTelemetry = {
    analyzedFrameCount: number
    analyzedSampleCount: number
    clippedSampleCount: number
    nonFiniteSampleCount: number
    samplePeak: number
    sampleSquareSum: number
};

export type AudioWorkletTelemetry = {
    consumedFrames: number
    droppedFrames: number
    generation: number
    hasPhysicalOutputTimeCorrelation: boolean
    mediaTimeContextTimeMicroseconds: Microseconds | null
    mediaTimeMicroseconds: Microseconds
    muted: boolean
    outputFrames: number
    overflowEvents: number
    overflowFrames: number
    playing: boolean
    queuedFrames: number
    reason: AudioWorkletTelemetryReason
    sequence: number | null
    signal?: AudioSignalTelemetry
    staleChunks: number
    type: 'telemetry'
    underflowEvents: number
    underflowFrames: number
    volume: number
};
