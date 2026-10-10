import type { Microseconds } from '../../MediaTime';
import type { AudioWorkletOutputController } from './AudioWorkletController';
import type { AudioWorkletTelemetry } from './AudioWorkletProtocol';
import {
    MAX_DECODED_AUDIO_SAMPLE_CREDITS,
    type DecodeWorkerAudioConfiguration,
    type DecodeWorkerAudioOutputAttachment
} from '../../pipeline/DecodeWorkerProtocol';
import {
    addMicroseconds,
    requireMicroseconds
} from '../../TimeMath';

export type CustomDecodeAudioBridgeCallbacks = {
    onFailure: (message: string) => void
};

export type CustomDecodeAudioBridgeStartOptions = {
    audioConfiguration: DecodeWorkerAudioConfiguration
    callbacks: CustomDecodeAudioBridgeCallbacks
    decodeGeneration: number
    startTimeMicroseconds: Microseconds
};

/** What the producer posted to the worklet: one chunk's progress, without its PCM */
export type CustomDecodeAudioSubmission = {
    durationMicroseconds: Microseconds
    frameCount: number
    mediaTimeMicroseconds: Microseconds
    sampleRate: number
};

export type CustomDecodeAudioBridgeRecordResult = 'recorded' | 'stale-generation';

export type CustomDecodeAudioBridgeTelemetry = {
    activeDecodeGeneration: number | null
    failed: boolean
    /** Submitted frames the worklet has not yet played */
    pendingFrameCount: number
    /** Submitted chunks the worklet has not yet played to their end */
    pendingSampleCount: number
    /** Submitted chunks the worklet played to their end */
    releasedSampleCredits: number
    staleSampleCount: number
    submittedEndMediaTimeMicroseconds: Microseconds | null
    submittedFrameCount: number
    submittedSampleCount: number
    workletGeneration: number | null
};

function requireGeneration(generation: number): number {
    if (!Number.isSafeInteger(generation) || generation <= 0) {
        throw new RangeError('Decode generation must be a positive safe integer');
    }
    return generation;
}

/**
 * Runs one AudioWorkletController's side of decoded audio while the producer in a worker feeds the processor directly.
 * It starts each decode generation with a flush and a new channel for the producer, stops it, and fails it on the processor's overflow and stale-generation reports.
 * It also follows the producer's progress against the processor's consumption, which the end-of-stream drain reads.
 */
export default class CustomDecodeAudioBridge {
    private activeDecodeGeneration: number | null = null;
    private callbacks: CustomDecodeAudioBridgeCallbacks | null = null;
    private consumedFrameCount = 0;
    private consumptionBaseline: number | null = null;
    private failed = false;
    private lastConsumedFrames = 0;
    private lastMediaTimeMicroseconds: Microseconds = requireMicroseconds(0);
    private readonly maximumPendingSampleCount: number;
    /** The cumulative submitted frame count at the end of each chunk the worklet has not played to its end */
    private readonly pendingSampleEndFrames: number[] = [];
    private releasedSampleCredits = 0;
    private staleSampleCount = 0;
    private submittedEndMediaTimeMicroseconds: Microseconds | null = null;
    private submittedFrameCount = 0;
    private submittedSampleCount = 0;
    private unsubscribeTelemetry: (() => void) | null = null;
    private workletGeneration: number | null = null;

    public constructor(private readonly controller: AudioWorkletOutputController) {
        this.maximumPendingSampleCount = Math.min(MAX_DECODED_AUDIO_SAMPLE_CREDITS, controller.configuration.maxChunks);
    }

    /** Returns the fixed credit window the producer bounds its in-flight chunks with. */
    public get initialAudioSampleCredits(): number {
        return this.maximumPendingSampleCount;
    }

    /**
     * Flushes old PCM, binds a new decode generation to the worklet, and hands the processor one end of a new producer channel.
     * Returns the other end, with the worklet generation, the credit window, and the queue's bounds, for the producer.
     */
    public start(options: CustomDecodeAudioBridgeStartOptions): DecodeWorkerAudioOutputAttachment {
        const decodeGeneration = requireGeneration(options.decodeGeneration);
        const startTimeMicroseconds = requireMicroseconds(options.startTimeMicroseconds, 'Audio bridge start time');
        this.validateAudioConfiguration(options.audioConfiguration);

        this.resetGenerationState();
        this.activeDecodeGeneration = decodeGeneration;
        this.callbacks = options.callbacks;
        this.failed = false;
        this.lastMediaTimeMicroseconds = startTimeMicroseconds;
        this.releasedSampleCredits = 0;
        this.staleSampleCount = 0;
        this.unsubscribeTelemetry = this.controller.onTelemetry(this.handleTelemetry);
        const workletGeneration = this.controller.flush(startTimeMicroseconds);
        this.workletGeneration = workletGeneration;
        // The flush detached any earlier producer, so the processor takes this channel for the new generation only
        const channel = new MessageChannel();
        try {
            this.controller.attachProducer(channel.port1);
        } catch (error) {
            channel.port1.close();
            channel.port2.close();
            throw error;
        }
        const configuration = this.controller.configuration;
        return {
            audioSampleCredits: this.maximumPendingSampleCount,
            channelCount: configuration.channelCount,
            maximumBufferedFrameCount: configuration.maxBufferedFrames,
            port: channel.port2,
            sampleRate: configuration.sampleRate,
            workletGeneration
        };
    }

    /** Records one chunk the producer posted, as its progress reports it, if the decode generation is current. */
    public recordSubmission(
        submission: CustomDecodeAudioSubmission,
        decodeGeneration: number
    ): CustomDecodeAudioBridgeRecordResult {
        if (decodeGeneration !== this.activeDecodeGeneration || this.failed) {
            this.staleSampleCount += 1;
            return 'stale-generation';
        }
        this.submittedFrameCount += submission.frameCount;
        this.submittedSampleCount += 1;
        this.submittedEndMediaTimeMicroseconds = addMicroseconds(
            submission.mediaTimeMicroseconds,
            submission.durationMicroseconds
        );
        this.pendingSampleEndFrames.push(this.submittedFrameCount);
        // The processor can report a chunk's consumption before its progress reaches this thread
        this.releaseConsumedSamples();
        return 'recorded';
    }

    /** Stops one active generation; the flush detaches the producer and invalidates queued PCM. */
    public stop(decodeGeneration: number | null = this.activeDecodeGeneration): void {
        if (this.activeDecodeGeneration === null) {
            return;
        }
        if (decodeGeneration !== null && decodeGeneration !== this.activeDecodeGeneration) {
            return;
        }

        this.resetGenerationState();
        this.activeDecodeGeneration = null;
        this.callbacks = null;
        this.workletGeneration = null;
        try {
            this.controller.setPlaying(false);
            this.controller.flush(this.lastMediaTimeMicroseconds);
        } catch {
            // The output may already have been destroyed by its owner
        }
    }

    /** Returns the submission and consumption accounting, for diagnostics and the end-of-stream drain. */
    public getTelemetry(): CustomDecodeAudioBridgeTelemetry {
        return {
            activeDecodeGeneration: this.activeDecodeGeneration,
            failed: this.failed,
            pendingFrameCount: Math.max(0, this.submittedFrameCount - this.consumedFrameCount),
            pendingSampleCount: this.pendingSampleEndFrames.length,
            releasedSampleCredits: this.releasedSampleCredits,
            staleSampleCount: this.staleSampleCount,
            submittedEndMediaTimeMicroseconds: this.submittedEndMediaTimeMicroseconds,
            submittedFrameCount: this.submittedFrameCount,
            submittedSampleCount: this.submittedSampleCount,
            workletGeneration: this.workletGeneration
        };
    }

    private readonly handleTelemetry = (telemetry: AudioWorkletTelemetry): void => {
        if (
            this.activeDecodeGeneration === null
            || telemetry.generation !== this.workletGeneration
            || this.failed
        ) {
            return;
        }

        if (
            !Number.isSafeInteger(telemetry.mediaTimeMicroseconds)
            || !Number.isSafeInteger(telemetry.consumedFrames)
            || telemetry.consumedFrames < 0
            || !Number.isSafeInteger(telemetry.queuedFrames)
            || telemetry.queuedFrames < 0
        ) {
            this.notifyFailure('Audio worklet returned invalid queue telemetry');
            return;
        }

        this.lastMediaTimeMicroseconds = requireMicroseconds(
            telemetry.mediaTimeMicroseconds,
            'Audio worklet media time'
        );
        if (this.consumptionBaseline === null) {
            // The flush's own report opens the generation's consumption count
            this.consumptionBaseline = telemetry.consumedFrames;
            this.lastConsumedFrames = telemetry.consumedFrames;
        } else if (telemetry.consumedFrames < this.lastConsumedFrames) {
            this.notifyFailure('Audio worklet consumption telemetry moved backwards');
            return;
        } else {
            this.lastConsumedFrames = telemetry.consumedFrames;
            this.consumedFrameCount = telemetry.consumedFrames - this.consumptionBaseline;
            this.releaseConsumedSamples();
        }

        if (telemetry.reason === 'overflow' || telemetry.reason === 'stale-generation') {
            this.notifyFailure('The audio worklet dropped a decoded sample');
        }
    };

    /** Unsubscribes from worklet telemetry and drops the accounting of the current generation. */
    private resetGenerationState(): void {
        this.unsubscribeTelemetry?.();
        this.unsubscribeTelemetry = null;
        this.pendingSampleEndFrames.length = 0;
        this.consumedFrameCount = 0;
        this.consumptionBaseline = null;
        this.lastConsumedFrames = 0;
        this.submittedEndMediaTimeMicroseconds = null;
        this.submittedFrameCount = 0;
        this.submittedSampleCount = 0;
    }

    /** Counts the chunks the worklet played to their end. */
    private releaseConsumedSamples(): void {
        while (this.pendingSampleEndFrames.length > 0 && this.pendingSampleEndFrames[0] <= this.consumedFrameCount) {
            this.pendingSampleEndFrames.shift();
            this.releasedSampleCredits += 1;
        }
    }

    private notifyFailure(message: string): void {
        if (this.failed) {
            return;
        }

        this.failed = true;
        try {
            this.callbacks?.onFailure(message);
        } catch {
            // Session callbacks must not escape the audio telemetry task
        }
    }

    private validateAudioConfiguration(audioConfiguration: DecodeWorkerAudioConfiguration): void {
        if (audioConfiguration.channelCount !== this.controller.configuration.channelCount) {
            throw new RangeError('Decoded audio channel count does not match the AudioWorklet output');
        }
        if (audioConfiguration.sampleRate !== this.controller.configuration.sampleRate) {
            throw new RangeError('Decoded audio sample rate does not match the AudioWorklet output');
        }
        if (typeof audioConfiguration.codec !== 'string' || !audioConfiguration.codec) {
            throw new TypeError('Decoded audio codec must be a non-empty string');
        }
    }
}
