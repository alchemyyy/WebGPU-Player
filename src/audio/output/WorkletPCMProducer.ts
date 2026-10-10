import { MICROSECONDS_PER_SECOND, type Microseconds } from '../../MediaTime';
import {
    addMicroseconds,
    audioFramesToMicroseconds
} from '../../TimeMath';
import type PCMChannelPool from '../processing/PCMChannelPool';
import { requirePositiveSafeInteger } from '../SafeIntegerValidation';
import type {
    AudioWorkletEnqueueMessage,
    AudioWorkletReleaseReason,
    AudioWorkletReleasedMessage
} from './AudioWorkletProtocol';

const CLOSED_MESSAGE = 'The decoded audio output is closed';
const CAPACITY_MESSAGE = 'Decoded audio exceeded the bounded worklet queue';
const DISCONTINUITY_MESSAGE = 'Decoded audio timestamps contain a gap or overlap';
const SHAPE_MESSAGE = 'Decoded audio does not match the worklet output layout';
const TRANSFER_MESSAGE = 'Unable to transfer decoded audio to the worklet';
const DROPPED_MESSAGE = 'The audio worklet dropped a decoded sample';
const UNKNOWN_RELEASE_MESSAGE = 'The audio worklet released a sample it was never sent';
const CREDIT_MESSAGE = 'Unable to replenish decoded audio credits';

export type WorkletPCMProducerOptions = Readonly<{
    /** The credit window: the most chunks in flight to the processor at once */
    audioSampleCredits: number
    channelCount: number
    /** Takes the buffers the processor returns, for the output stage to reuse */
    channelPool?: PCMChannelPool | null
    maximumBufferedFrameCount: number
    /** Returns the credit of each chunk the processor played to its end */
    onCreditsReleased: (audioSampleCredits: number) => void
    /** Reports, once, a chunk the processor dropped or a release the producer cannot account for */
    onFailure: (message: string) => void
    /** The producer's end of its channel to the processor */
    port: MessagePort
    sampleRate: number
    /** The worklet generation every chunk carries; the processor drops chunks of any other */
    workletGeneration: number
}>;

/** One output chunk, in the shape the decoded audio output stage emits */
export type WorkletPCMChunk = Readonly<{
    channelData: readonly Float32Array[]
    durationMicroseconds: Microseconds
    frameCount: number
    mediaTimeMicroseconds: Microseconds
    sampleRate: number
}>;

export type WorkletPCMProducerTelemetry = Readonly<{
    consumedChunkCount: number
    failed: boolean
    pendingChunkCount: number
    pendingFrameCount: number
    submittedChunkCount: number
    submittedEndMediaTimeMicroseconds: Microseconds | null
    submittedFrameCount: number
}>;

type PendingChunk = {
    frameCount: number
    sequence: number
};

/** Fails the decoded audio output: a chunk breaks its continuity or bounds, or the processor dropped one. */
export class WorkletPCMProducerError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'WorkletPCMProducerError';
    }
}

function isReleaseReason(value: unknown): value is AudioWorkletReleaseReason {
    switch (value) {
        case 'consumed':
        case 'invalid':
        case 'overflow':
        case 'stale-generation':
            return true;
        default:
            return false;
    }
}

function isReleasedMessage(value: unknown): value is AudioWorkletReleasedMessage {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const message = value as Partial<AudioWorkletReleasedMessage>;
    return message.type === 'released'
        && Number.isSafeInteger(message.sequence)
        && Number(message.sequence) > 0
        && isReleaseReason(message.reason)
        && Array.isArray(message.channelBuffers)
        && message.channelBuffers.every(buffer => buffer instanceof ArrayBuffer);
}

/**
 * Feeds one AudioWorklet processor over their own channel, for one worklet generation, so decoded PCM never waits on the page.
 * It owns the credit window: each chunk takes a credit, which returns once the processor has played the chunk to its end, together with its buffers for reuse.
 * Each chunk is checked as the page's bridge checked it, so a gap, an overlap, or an overflow fails the audio output before the processor sees the chunk.
 */
export default class WorkletPCMProducer {
    private readonly channelCount: number;
    private readonly channelPool: PCMChannelPool | null;
    private closed = false;
    private consumedChunkCount = 0;
    private expectedNextMediaTimeMicroseconds: Microseconds | null = null;
    private failureMessage: string | null = null;
    private readonly maximumBufferedFrameCount: number;
    private readonly maximumPendingChunkCount: number;
    private nextSequence = 1;
    private readonly onCreditsReleased: (audioSampleCredits: number) => void;
    private readonly onFailure: (message: string) => void;
    private readonly pendingChunks: PendingChunk[] = [];
    private pendingFrameCount = 0;
    private readonly port: MessagePort;
    private readonly sampleRate: number;
    private submittedChunkCount = 0;
    private submittedFrameCount = 0;
    private readonly workletGeneration: number;

    public constructor(options: WorkletPCMProducerOptions) {
        this.maximumPendingChunkCount = requirePositiveSafeInteger(options.audioSampleCredits, 'Decoded audio credit window');
        this.channelCount = requirePositiveSafeInteger(options.channelCount, 'Worklet output channel count');
        this.channelPool = options.channelPool ?? null;
        this.maximumBufferedFrameCount = requirePositiveSafeInteger(options.maximumBufferedFrameCount, 'Worklet buffered frame bound');
        this.onCreditsReleased = options.onCreditsReleased;
        this.onFailure = options.onFailure;
        this.port = options.port;
        this.sampleRate = requirePositiveSafeInteger(options.sampleRate, 'Worklet output sample rate');
        this.workletGeneration = requirePositiveSafeInteger(options.workletGeneration, 'Worklet generation');
        // Assigning the handler starts the port
        this.port.onmessage = (event: MessageEvent<unknown>): void => {
            this.handleMessage(event.data);
        };
    }

    /**
     * Posts one chunk to the processor, transferring its buffers, after checking its layout, its bounds, and its continuity with the previous chunk.
     * Throws WorkletPCMProducerError instead of posting a chunk the processor would drop.
     * The caller holds a credit for the chunk.
     */
    public submit(chunk: WorkletPCMChunk): void {
        if (this.closed) {
            throw new WorkletPCMProducerError(CLOSED_MESSAGE);
        }
        if (this.failureMessage !== null) {
            throw new WorkletPCMProducerError(this.failureMessage);
        }
        const frameCount = this.requireChunkShape(chunk);
        if (this.pendingChunks.length >= this.maximumPendingChunkCount
            || frameCount > this.maximumBufferedFrameCount - this.pendingFrameCount) {
            this.rejectChunk(CAPACITY_MESSAGE);
        }
        const nextMediaTimeMicroseconds = this.getNextContinuousMediaTime(chunk, frameCount);
        if (nextMediaTimeMicroseconds === null) {
            this.rejectChunk(DISCONTINUITY_MESSAGE);
        }

        const sequence = this.nextSequence;
        const transfer: ArrayBuffer[] = [];
        for (const channel of chunk.channelData) {
            const buffer = channel.buffer as ArrayBuffer;
            if (!transfer.includes(buffer)) {
                transfer.push(buffer);
            }
        }
        const message: AudioWorkletEnqueueMessage = {
            channelData: chunk.channelData,
            generation: this.workletGeneration,
            sequence,
            timestampMicroseconds: chunk.mediaTimeMicroseconds,
            type: 'enqueue'
        };
        try {
            this.port.postMessage(message, transfer);
        } catch {
            this.rejectChunk(TRANSFER_MESSAGE);
        }

        this.nextSequence += 1;
        this.pendingChunks.push({ frameCount, sequence });
        this.pendingFrameCount += frameCount;
        this.expectedNextMediaTimeMicroseconds = nextMediaTimeMicroseconds;
        this.submittedChunkCount += 1;
        this.submittedFrameCount += frameCount;
    }

    /** Closes the channel; the processor drops whatever was still in flight on it. */
    public close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.port.onmessage = null;
        this.port.close();
        this.pendingChunks.length = 0;
        this.pendingFrameCount = 0;
    }

    /** Why the output failed, or null while it is healthy */
    public get failure(): string | null {
        return this.failureMessage;
    }

    /** Returns the credit and continuity accounting, for diagnostics. */
    public getTelemetry(): WorkletPCMProducerTelemetry {
        return {
            consumedChunkCount: this.consumedChunkCount,
            failed: this.failureMessage !== null,
            pendingChunkCount: this.pendingChunks.length,
            pendingFrameCount: this.pendingFrameCount,
            submittedChunkCount: this.submittedChunkCount,
            submittedEndMediaTimeMicroseconds: this.expectedNextMediaTimeMicroseconds,
            submittedFrameCount: this.submittedFrameCount
        };
    }

    private handleMessage(value: unknown): void {
        if (this.closed || !isReleasedMessage(value)) {
            return;
        }
        for (const buffer of value.channelBuffers) {
            this.channelPool?.give(buffer);
        }
        const pendingChunkIndex = this.pendingChunks.findIndex(pendingChunk => pendingChunk.sequence === value.sequence);
        if (pendingChunkIndex < 0) {
            this.reportFailure(UNKNOWN_RELEASE_MESSAGE);
            return;
        }
        const [ pendingChunk ] = this.pendingChunks.splice(pendingChunkIndex, 1);
        this.pendingFrameCount -= pendingChunk.frameCount;
        if (value.reason !== 'consumed') {
            this.reportFailure(DROPPED_MESSAGE);
            return;
        }
        this.consumedChunkCount += 1;
        try {
            this.onCreditsReleased(1);
        } catch {
            this.reportFailure(CREDIT_MESSAGE);
        }
    }

    /** Checks the planar layout the processor expects and returns the chunk's frame count. */
    private requireChunkShape(chunk: WorkletPCMChunk): number {
        const frameCount = chunk.frameCount;
        if (!Number.isSafeInteger(frameCount)
            || frameCount <= 0
            || chunk.channelData.length !== this.channelCount) {
            this.rejectChunk(SHAPE_MESSAGE);
        }
        for (const channel of chunk.channelData) {
            if (!(channel instanceof Float32Array)
                || channel.length !== frameCount
                || !(channel.buffer instanceof ArrayBuffer)) {
                this.rejectChunk(SHAPE_MESSAGE);
            }
        }
        return frameCount;
    }

    private getNextContinuousMediaTime(chunk: WorkletPCMChunk, frameCount: number): Microseconds | null {
        if (chunk.sampleRate !== this.sampleRate) {
            return null;
        }
        const timestampToleranceMicroseconds = Math.ceil(MICROSECONDS_PER_SECOND / chunk.sampleRate);
        const expectedMediaTimeMicroseconds = this.expectedNextMediaTimeMicroseconds;
        if (expectedMediaTimeMicroseconds !== null
            && Math.abs(chunk.mediaTimeMicroseconds - expectedMediaTimeMicroseconds) > timestampToleranceMicroseconds) {
            return null;
        }
        try {
            const calculatedDurationMicroseconds = audioFramesToMicroseconds(frameCount, chunk.sampleRate);
            if (Math.abs(chunk.durationMicroseconds - calculatedDurationMicroseconds) > timestampToleranceMicroseconds) {
                return null;
            }
            return addMicroseconds(chunk.mediaTimeMicroseconds, calculatedDurationMicroseconds);
        } catch {
            return null;
        }
    }

    /** Fails a chunk before it is posted; the throw carries the failure to the caller. */
    private rejectChunk(message: string): never {
        this.failureMessage ??= message;
        throw new WorkletPCMProducerError(message);
    }

    /** Reports a failure the processor's channel revealed, once. */
    private reportFailure(message: string): void {
        if (this.failureMessage !== null) {
            return;
        }
        this.failureMessage = message;
        try {
            this.onFailure(message);
        } catch {
            // A failure callback must not escape the channel's message task
        }
    }
}
