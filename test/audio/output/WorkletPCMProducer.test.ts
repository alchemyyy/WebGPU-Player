import { describe, expect, it, vi } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';
import type { AudioWorkletReleaseReason } from 'webgpu-player/audio/output/AudioWorkletProtocol';
import WorkletPCMProducer, {
    WorkletPCMProducerError,
    type WorkletPCMChunk,
    type WorkletPCMProducerOptions
} from 'webgpu-player/audio/output/WorkletPCMProducer';
import PCMChannelPool from 'webgpu-player/audio/processing/PCMChannelPool';
import { audioFramesToMicroseconds, requireMicroseconds } from 'webgpu-player/TimeMath';

const SAMPLE_RATE = 48_000;
const OTHER_SAMPLE_RATE = 44_100;
const CHANNEL_COUNT = 2;
const AUDIO_SAMPLE_CREDITS = 2;
// Two seconds at 48 kHz, as the worklet ring holds
const MAXIMUM_BUFFERED_FRAME_COUNT = 96_000;
const WORKLET_GENERATION = 3;
const CHUNK_FRAME_COUNT = 4;
const POOLED_CHUNK_FRAME_COUNT = 480;
const POOL_CHANNEL_FRAME_CAPACITY = 12_000;
const POOL_MAXIMUM_BUFFER_COUNT = 8;
const FIRST_CHUNK_TIME_MICROSECONDS = requireMicroseconds(1_000_000);
// Four frames at 48 kHz last 83 microseconds, and the tolerance is one sample period of 21 microseconds
const CONTINUOUS_CHUNK_TIME_MICROSECONDS = requireMicroseconds(1_000_083);
const DRIFTED_CHUNK_TIME_MICROSECONDS = requireMicroseconds(1_000_104);
const GAPPED_CHUNK_TIME_MICROSECONDS = requireMicroseconds(1_000_105);
const OVERLAPPED_CHUNK_TIME_MICROSECONDS = requireMicroseconds(1_000_061);
const FIRST_SEQUENCE = 1;
const UNSENT_SEQUENCE = 9;
const CAPACITY_FAILURE = 'Decoded audio exceeded the bounded worklet queue';
const DISCONTINUITY_FAILURE = 'Decoded audio timestamps contain a gap or overlap';
const SHAPE_FAILURE = 'Decoded audio does not match the worklet output layout';
const CLOSED_FAILURE = 'The decoded audio output is closed';
const DROPPED_FAILURE = 'The audio worklet dropped a decoded sample';
const UNKNOWN_RELEASE_FAILURE = 'The audio worklet released a sample it was never sent';
const CREDIT_FAILURE = 'Unable to replenish decoded audio credits';
const TRANSFER_FAILURE = 'Unable to transfer decoded audio to the worklet';

/** The producer's end of its channel: it records posts and delivers the processor's releases. */
class FakeProducerPort {
    public readonly close = vi.fn();
    public onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    public readonly postedMessages: unknown[] = [];
    public readonly postedTransfers: Transferable[][] = [];
    public postFailure: Error | null = null;

    public postMessage(message: unknown, transfer: Transferable[] = []): void {
        if (this.postFailure) {
            throw this.postFailure;
        }
        this.postedMessages.push(message);
        this.postedTransfers.push([ ...transfer ]);
    }

    public deliverRelease(sequence: number, reason: AudioWorkletReleaseReason, channelBuffers: ArrayBuffer[] = []): void {
        this.deliver({ channelBuffers, reason, sequence, type: 'released' });
    }

    public deliver(data: unknown): void {
        this.onmessage?.({ data } as MessageEvent<unknown>);
    }
}

type ProducerHarness = {
    channelPool: PCMChannelPool
    onCreditsReleased: ReturnType<typeof vi.fn>
    onFailure: ReturnType<typeof vi.fn>
    port: FakeProducerPort
    producer: WorkletPCMProducer
};

function createProducer(overrides: Partial<WorkletPCMProducerOptions> = {}): ProducerHarness {
    const channelPool = new PCMChannelPool(POOL_CHANNEL_FRAME_CAPACITY, POOL_MAXIMUM_BUFFER_COUNT);
    const onCreditsReleased = vi.fn();
    const onFailure = vi.fn();
    const port = new FakeProducerPort();
    const producer = new WorkletPCMProducer({
        audioSampleCredits: AUDIO_SAMPLE_CREDITS,
        channelCount: CHANNEL_COUNT,
        channelPool,
        maximumBufferedFrameCount: MAXIMUM_BUFFERED_FRAME_COUNT,
        onCreditsReleased,
        onFailure,
        port: port as unknown as MessagePort,
        sampleRate: SAMPLE_RATE,
        workletGeneration: WORKLET_GENERATION,
        ...overrides
    });
    return { channelPool, onCreditsReleased, onFailure, port, producer };
}

function createChunk(
    mediaTimeMicroseconds: Microseconds,
    frameCount = CHUNK_FRAME_COUNT,
    sampleRate = SAMPLE_RATE,
    channelCount = CHANNEL_COUNT
): WorkletPCMChunk {
    return {
        channelData: Array.from({ length: channelCount }, (): Float32Array => new Float32Array(frameCount)),
        durationMicroseconds: audioFramesToMicroseconds(frameCount, sampleRate),
        frameCount,
        mediaTimeMicroseconds,
        sampleRate
    };
}

function expectSubmitFailure(producer: WorkletPCMProducer, chunk: WorkletPCMChunk, message: string): void {
    expect(() => producer.submit(chunk)).toThrow(new WorkletPCMProducerError(message));
}

describe('WorkletPCMProducer', () => {
    it('posts a chunk in the enqueue shape with its buffers transferred, and takes back its credit and buffers once played', () => {
        const harness = createProducer();
        const channelData = [ harness.channelPool.take(POOLED_CHUNK_FRAME_COUNT), harness.channelPool.take(POOLED_CHUNK_FRAME_COUNT) ];
        harness.producer.submit({
            channelData,
            durationMicroseconds: audioFramesToMicroseconds(POOLED_CHUNK_FRAME_COUNT, SAMPLE_RATE),
            frameCount: POOLED_CHUNK_FRAME_COUNT,
            mediaTimeMicroseconds: FIRST_CHUNK_TIME_MICROSECONDS,
            sampleRate: SAMPLE_RATE
        });

        expect(harness.port.postedMessages).toEqual([ {
            channelData,
            generation: WORKLET_GENERATION,
            sequence: FIRST_SEQUENCE,
            timestampMicroseconds: FIRST_CHUNK_TIME_MICROSECONDS,
            type: 'enqueue'
        } ]);
        expect(harness.port.postedTransfers).toEqual([ channelData.map(channel => channel.buffer) ]);
        expect(harness.producer.getTelemetry()).toMatchObject({
            pendingChunkCount: 1,
            pendingFrameCount: POOLED_CHUNK_FRAME_COUNT,
            submittedChunkCount: 1
        });

        harness.port.deliverRelease(FIRST_SEQUENCE, 'consumed', channelData.map(channel => channel.buffer as ArrayBuffer));

        expect(harness.onCreditsReleased).toHaveBeenCalledExactlyOnceWith(1);
        expect(harness.channelPool.spareBufferCount).toBe(CHANNEL_COUNT);
        expect(harness.producer.getTelemetry()).toMatchObject({
            consumedChunkCount: 1,
            failed: false,
            pendingChunkCount: 0,
            pendingFrameCount: 0
        });
        expect(harness.onFailure).not.toHaveBeenCalled();
    });

    it('rejects a chunk beyond its credit window without posting it, and stays failed', () => {
        const harness = createProducer({ audioSampleCredits: 1 });
        harness.producer.submit(createChunk(FIRST_CHUNK_TIME_MICROSECONDS));

        expectSubmitFailure(harness.producer, createChunk(CONTINUOUS_CHUNK_TIME_MICROSECONDS), CAPACITY_FAILURE);

        expect(harness.port.postedMessages).toHaveLength(1);
        expect(harness.producer.failure).toBe(CAPACITY_FAILURE);
        harness.port.deliverRelease(FIRST_SEQUENCE, 'consumed');
        expectSubmitFailure(harness.producer, createChunk(CONTINUOUS_CHUNK_TIME_MICROSECONDS), CAPACITY_FAILURE);
    });

    it('rejects a chunk that would overfill the worklet queue', () => {
        const harness = createProducer({ maximumBufferedFrameCount: CHUNK_FRAME_COUNT + 1 });
        harness.producer.submit(createChunk(FIRST_CHUNK_TIME_MICROSECONDS));

        expectSubmitFailure(harness.producer, createChunk(CONTINUOUS_CHUNK_TIME_MICROSECONDS), CAPACITY_FAILURE);
    });

    it.each([
        [ 'gap', GAPPED_CHUNK_TIME_MICROSECONDS ],
        [ 'overlap', OVERLAPPED_CHUNK_TIME_MICROSECONDS ]
    ])('rejects a timestamp %s beyond one sample period', (_label: string, mediaTimeMicroseconds: Microseconds) => {
        const harness = createProducer();
        harness.producer.submit(createChunk(FIRST_CHUNK_TIME_MICROSECONDS));

        expectSubmitFailure(harness.producer, createChunk(mediaTimeMicroseconds), DISCONTINUITY_FAILURE);
        expect(harness.port.postedMessages).toHaveLength(1);
    });

    it('accepts timestamp drift of exactly one sample period and starts continuity at its first chunk', () => {
        const harness = createProducer();

        harness.producer.submit(createChunk(FIRST_CHUNK_TIME_MICROSECONDS));
        harness.producer.submit(createChunk(DRIFTED_CHUNK_TIME_MICROSECONDS));

        expect(harness.port.postedMessages).toHaveLength(AUDIO_SAMPLE_CREDITS);
        expect(harness.producer.getTelemetry().submittedEndMediaTimeMicroseconds).toBe(
            DRIFTED_CHUNK_TIME_MICROSECONDS + audioFramesToMicroseconds(CHUNK_FRAME_COUNT, SAMPLE_RATE)
        );
    });

    it('rejects a chunk whose rate, duration, or layout does not match the worklet', () => {
        expectSubmitFailure(
            createProducer().producer,
            createChunk(FIRST_CHUNK_TIME_MICROSECONDS, CHUNK_FRAME_COUNT, OTHER_SAMPLE_RATE),
            DISCONTINUITY_FAILURE
        );
        expectSubmitFailure(
            createProducer().producer,
            { ...createChunk(FIRST_CHUNK_TIME_MICROSECONDS), durationMicroseconds: requireMicroseconds(0) },
            DISCONTINUITY_FAILURE
        );
        expectSubmitFailure(
            createProducer().producer,
            createChunk(FIRST_CHUNK_TIME_MICROSECONDS, CHUNK_FRAME_COUNT, SAMPLE_RATE, CHANNEL_COUNT + 1),
            SHAPE_FAILURE
        );
        expectSubmitFailure(
            createProducer().producer,
            {
                ...createChunk(FIRST_CHUNK_TIME_MICROSECONDS),
                channelData: [ new Float32Array(CHUNK_FRAME_COUNT), new Float32Array(CHUNK_FRAME_COUNT - 1) ]
            },
            SHAPE_FAILURE
        );
    });

    it('fails a chunk the channel cannot transfer', () => {
        const harness = createProducer();
        harness.port.postFailure = new Error('DataCloneError');

        expectSubmitFailure(harness.producer, createChunk(FIRST_CHUNK_TIME_MICROSECONDS), TRANSFER_FAILURE);
        expect(harness.producer.getTelemetry()).toMatchObject({ failed: true, pendingChunkCount: 0 });
    });

    it('reports a chunk the processor dropped once, without returning its credit', () => {
        const harness = createProducer();
        harness.producer.submit(createChunk(FIRST_CHUNK_TIME_MICROSECONDS));
        harness.producer.submit(createChunk(CONTINUOUS_CHUNK_TIME_MICROSECONDS));

        harness.port.deliverRelease(FIRST_SEQUENCE, 'overflow');
        harness.port.deliverRelease(FIRST_SEQUENCE + 1, 'stale-generation');

        expect(harness.onFailure).toHaveBeenCalledExactlyOnceWith(DROPPED_FAILURE);
        expect(harness.onCreditsReleased).not.toHaveBeenCalled();
        expect(harness.producer.failure).toBe(DROPPED_FAILURE);
        expectSubmitFailure(harness.producer, createChunk(CONTINUOUS_CHUNK_TIME_MICROSECONDS), DROPPED_FAILURE);
    });

    it('reports a release it never sent and a credit callback that throws', () => {
        const unknownReleaseHarness = createProducer();
        unknownReleaseHarness.port.deliverRelease(UNSENT_SEQUENCE, 'consumed');
        expect(unknownReleaseHarness.onFailure).toHaveBeenCalledExactlyOnceWith(UNKNOWN_RELEASE_FAILURE);

        const throwingCreditHarness = createProducer({
            onCreditsReleased: (): void => {
                throw new Error('The run is gone');
            }
        });
        throwingCreditHarness.producer.submit(createChunk(FIRST_CHUNK_TIME_MICROSECONDS));
        throwingCreditHarness.port.deliverRelease(FIRST_SEQUENCE, 'consumed');
        expect(throwingCreditHarness.onFailure).toHaveBeenCalledExactlyOnceWith(CREDIT_FAILURE);
    });

    it('ignores malformed messages, and closes its channel once', () => {
        const harness = createProducer();
        harness.producer.submit(createChunk(FIRST_CHUNK_TIME_MICROSECONDS));
        harness.port.deliver({ reason: 'consumed', sequence: FIRST_SEQUENCE, type: 'released' });
        harness.port.deliver({ channelBuffers: [], reason: 'played', sequence: FIRST_SEQUENCE, type: 'released' });
        harness.port.deliver(null);
        expect(harness.onCreditsReleased).not.toHaveBeenCalled();
        expect(harness.onFailure).not.toHaveBeenCalled();

        harness.producer.close();
        harness.producer.close();

        expect(harness.port.close).toHaveBeenCalledOnce();
        expect(harness.port.onmessage).toBeNull();
        expect(harness.producer.getTelemetry()).toMatchObject({ pendingChunkCount: 0, pendingFrameCount: 0 });
        expectSubmitFailure(harness.producer, createChunk(CONTINUOUS_CHUNK_TIME_MICROSECONDS), CLOSED_FAILURE);
    });

    it('rejects a credit window, a layout, a bound, a rate, or a generation that is not a positive safe integer', () => {
        expect(() => createProducer({ audioSampleCredits: 0 })).toThrow(RangeError);
        expect(() => createProducer({ channelCount: 0 })).toThrow(RangeError);
        expect(() => createProducer({ maximumBufferedFrameCount: 0 })).toThrow(RangeError);
        expect(() => createProducer({ sampleRate: 0 })).toThrow(RangeError);
        expect(() => createProducer({ workletGeneration: 0 })).toThrow(RangeError);
    });
});
