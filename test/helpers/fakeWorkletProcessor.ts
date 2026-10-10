// The AudioWorklet processor's end of a producer channel, which plays the processor's part in worker tests

import type {
    AudioWorkletEnqueueMessage,
    AudioWorkletReleaseReason
} from 'webgpu-player/audio/output/AudioWorkletProtocol';
import type { DecodeWorkerAudioOutputAttachment } from 'webgpu-player/pipeline/DecodeWorkerProtocol';

export const FAKE_WORKLET_SAMPLE_RATE = 48_000;
// Two seconds at 48 kHz, as the worklet ring holds
export const FAKE_WORKLET_MAXIMUM_BUFFERED_FRAME_COUNT = 96_000;

export type FakeWorkletChannelOptions = Readonly<{
    audioSampleCredits: number
    channelCount: number
    /** Keeps every chunk unplayed until the test releases it */
    holdReleases?: boolean
    workletGeneration: number
}>;

/**
 * Receives a producer's chunks as the processor does and returns each one played, at once or when the test releases it.
 * It records a copy of every chunk, since a release transfers the chunk's buffers back, and whether the producer closed its end.
 */
export class FakeWorkletProcessor {
    public readonly chunks: AudioWorkletEnqueueMessage[] = [];
    private readonly heldChunks: AudioWorkletEnqueueMessage[] = [];
    private nextDropReason: AudioWorkletReleaseReason | null = null;
    private producerClosed = false;

    public constructor(
        private readonly port: MessagePort,
        private readonly holdReleases: boolean
    ) {
        port.addEventListener('close', (): void => {
            this.producerClosed = true;
        });
        port.onmessage = (event: MessageEvent<unknown>): void => {
            this.receive(event.data);
        };
    }

    /** Whether the producer's end of the channel is closed */
    public get closed(): boolean {
        return this.producerClosed;
    }

    /** The chunks the processor holds unplayed */
    public get heldChunkCount(): number {
        return this.heldChunks.length;
    }

    /** The frames of every chunk received, in order */
    public get receivedFrameCount(): number {
        return this.chunks.reduce((frameCount, chunk) => frameCount + chunk.channelData[0].length, 0);
    }

    /** Returns the oldest held chunks, played or dropped for a reason. */
    public releaseHeld(chunkCount: number, reason: AudioWorkletReleaseReason = 'consumed'): void {
        for (const chunk of this.heldChunks.splice(0, chunkCount)) {
            this.release(chunk, reason);
        }
    }

    /** Returns the next chunk dropped for a reason, as an overflowing or stale chunk would be. */
    public dropNext(reason: AudioWorkletReleaseReason): void {
        this.nextDropReason = reason;
    }

    public close(): void {
        this.port.onmessage = null;
        this.port.close();
    }

    private receive(message: unknown): void {
        const chunk = message as AudioWorkletEnqueueMessage;
        if (chunk?.type !== 'enqueue') {
            return;
        }
        this.chunks.push({ ...chunk, channelData: chunk.channelData.map(channel => channel.slice()) });
        if (this.nextDropReason !== null) {
            const reason = this.nextDropReason;
            this.nextDropReason = null;
            this.release(chunk, reason);
            return;
        }
        if (this.holdReleases) {
            this.heldChunks.push(chunk);
            return;
        }
        this.release(chunk, 'consumed');
    }

    private release(chunk: AudioWorkletEnqueueMessage, reason: AudioWorkletReleaseReason): void {
        const channelBuffers: ArrayBuffer[] = [];
        for (const channel of chunk.channelData) {
            const buffer = channel.buffer as ArrayBuffer;
            if (!channelBuffers.includes(buffer)) {
                channelBuffers.push(buffer);
            }
        }
        this.port.postMessage({ channelBuffers, reason, sequence: chunk.sequence, type: 'released' }, channelBuffers);
    }
}

/** Opens a producer channel to a fake processor, and returns it with the attachment the page hands the worker. */
export function openFakeWorkletChannel(options: FakeWorkletChannelOptions): {
    attachment: DecodeWorkerAudioOutputAttachment
    processor: FakeWorkletProcessor
} {
    const channel = new MessageChannel();
    return {
        attachment: {
            audioSampleCredits: options.audioSampleCredits,
            channelCount: options.channelCount,
            maximumBufferedFrameCount: FAKE_WORKLET_MAXIMUM_BUFFERED_FRAME_COUNT,
            port: channel.port2,
            sampleRate: FAKE_WORKLET_SAMPLE_RATE,
            workletGeneration: options.workletGeneration
        },
        processor: new FakeWorkletProcessor(channel.port1, options.holdReleases ?? false)
    };
}
