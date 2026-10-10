import { afterEach, describe, expect, it, vi } from 'vitest';

import { secondsToMicroseconds, type Microseconds } from 'webgpu-player/MediaTime';
import AudioWorkletController, {
    type AudioWorkletControllerConfiguration,
    type AudioWorkletOutputController
} from 'webgpu-player/audio/output/AudioWorkletController';
import type { AudioWorkletTelemetry, CustomAudioWorkletMessage } from 'webgpu-player/audio/output/AudioWorkletProtocol';
import CustomDecodeAudioBridge, {
    type CustomDecodeAudioSubmission
} from 'webgpu-player/audio/output/CustomDecodeAudioBridge';
import type { DecodeWorkerAudioOutputAttachment } from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import { audioFramesToMicroseconds, requireMicroseconds } from 'webgpu-player/TimeMath';

type PostedMessage = {
    message: CustomAudioWorkletMessage
    transferables: readonly Transferable[]
};

class MockMessagePort extends EventTarget {
    public readonly close = vi.fn();
    public readonly messages: PostedMessage[] = [];
    public readonly start = vi.fn();

    public postMessage(message: CustomAudioWorkletMessage, transferables: Transferable[] = []): void {
        this.messages.push({ message, transferables });
    }

    public dispatchTelemetry(telemetry: AudioWorkletTelemetry): void {
        this.dispatchEvent(new MessageEvent('message', { data: telemetry }));
    }
}

type BridgeHarness = {
    bridge: CustomDecodeAudioBridge
    controller: AudioWorkletController
    port: MockMessagePort
};

const SAMPLE_RATE = 48_000;
const OTHER_SAMPLE_RATE = 44_100;
const CHANNEL_COUNT = 2;
const MONO_CHANNEL_COUNT = 1;
const MAXIMUM_BUFFERED_FRAME_COUNT = 16;
const MAXIMUM_CHUNK_COUNT = 4;
const CHUNK_FRAME_COUNT = 4;
const HALF_CHUNK_FRAME_COUNT = CHUNK_FRAME_COUNT / 2;
const DECODE_GENERATION = 7;
const STALE_DECODE_GENERATION = 6;
const START_TIME_MICROSECONDS = secondsToMicroseconds(1);
const RESTART_TIME_MICROSECONDS = secondsToMicroseconds(5);
// Four frames at 48 kHz last 83 microseconds
const SECOND_CHUNK_TIME_MICROSECONDS = requireMicroseconds(1_000_083);
const SUBMITTED_END_TIME_MICROSECONDS = requireMicroseconds(1_000_166);
// The worklet's consumption count runs across generations, so each generation counts from its flush
const CONSUMED_FRAMES_BEFORE_START = 1_000;
const DROPPED_SAMPLE_FAILURE = 'The audio worklet dropped a decoded sample';
const BACKWARDS_CONSUMPTION_FAILURE = 'Audio worklet consumption telemetry moved backwards';
const AUDIO_CODEC = 'mp4a.40.2';

const configuration: AudioWorkletControllerConfiguration = {
    channelCount: CHANNEL_COUNT,
    maxBufferedFrames: MAXIMUM_BUFFERED_FRAME_COUNT,
    maxChunks: MAXIMUM_CHUNK_COUNT,
    sampleRate: SAMPLE_RATE,
    telemetryIntervalFrames: 128
};

// Every channel a test opens, which the test closes once it ends
const openedPorts: MessagePort[] = [];

afterEach(() => {
    for (const port of openedPorts.splice(0)) {
        port.close();
    }
    vi.unstubAllGlobals();
});

function createHarness(): BridgeHarness {
    const port = new MockMessagePort();
    const node = {
        disconnect: vi.fn(),
        port
    } as unknown as AudioWorkletNode;
    const controller = new AudioWorkletController(node, configuration);
    return {
        bridge: new CustomDecodeAudioBridge(controller),
        controller,
        port
    };
}

function createTelemetry(
    generation: number,
    overrides: Partial<AudioWorkletTelemetry> = {}
): AudioWorkletTelemetry {
    return {
        consumedFrames: CONSUMED_FRAMES_BEFORE_START,
        droppedFrames: 0,
        generation,
        hasPhysicalOutputTimeCorrelation: false,
        mediaTimeContextTimeMicroseconds: null,
        mediaTimeMicroseconds: START_TIME_MICROSECONDS,
        muted: false,
        outputFrames: 0,
        overflowEvents: 0,
        overflowFrames: 0,
        playing: true,
        queuedFrames: 0,
        reason: 'periodic',
        sequence: null,
        staleChunks: 0,
        type: 'telemetry',
        underflowEvents: 0,
        underflowFrames: 0,
        volume: 1,
        ...overrides
    };
}

function createSubmission(
    mediaTimeMicroseconds: Microseconds,
    frameCount = CHUNK_FRAME_COUNT
): CustomDecodeAudioSubmission {
    return {
        durationMicroseconds: audioFramesToMicroseconds(frameCount, SAMPLE_RATE),
        frameCount,
        mediaTimeMicroseconds,
        sampleRate: SAMPLE_RATE
    };
}

function startBridge(
    harness: BridgeHarness,
    decodeGeneration = DECODE_GENERATION,
    startTimeMicroseconds = START_TIME_MICROSECONDS
): { attachment: DecodeWorkerAudioOutputAttachment, onFailure: ReturnType<typeof vi.fn> } {
    const onFailure = vi.fn();
    const attachment = harness.bridge.start({
        audioConfiguration: {
            channelCount: CHANNEL_COUNT,
            codec: AUDIO_CODEC,
            sampleRate: SAMPLE_RATE
        },
        callbacks: { onFailure },
        decodeGeneration,
        startTimeMicroseconds
    });
    openedPorts.push(attachment.port);
    const attachMessage = harness.port.messages.at(-1)?.message;
    if (attachMessage?.type === 'attach-producer') {
        openedPorts.push(attachMessage.port);
    }
    return { attachment, onFailure };
}

/** Delivers the flush's own report, which opens the generation's consumption count. */
function dispatchFlushTelemetry(harness: BridgeHarness): void {
    harness.port.dispatchTelemetry(createTelemetry(harness.controller.generation, { reason: 'flush' }));
}

function dispatchConsumption(harness: BridgeHarness, consumedFrameCount: number): void {
    harness.port.dispatchTelemetry(createTelemetry(harness.controller.generation, {
        consumedFrames: CONSUMED_FRAMES_BEFORE_START + consumedFrameCount
    }));
}

describe('CustomDecodeAudioBridge', () => {
    it('flushes, hands the processor one end of a new producer channel, and returns the other with the credit window', () => {
        const harness = createHarness();

        const { attachment } = startBridge(harness);

        const workletGeneration = harness.controller.generation;
        const [ flushEntry, attachEntry ] = harness.port.messages;
        expect(flushEntry.message).toEqual({
            generation: workletGeneration,
            mediaTimeMicroseconds: START_TIME_MICROSECONDS,
            type: 'flush'
        });
        expect(attachEntry.message).toMatchObject({ generation: workletGeneration, type: 'attach-producer' });
        const processorPort = (attachEntry.message as { port: MessagePort }).port;
        expect(attachEntry.transferables).toEqual([ processorPort ]);
        expect(processorPort).not.toBe(attachment.port);
        expect(attachment).toEqual({
            // The window is the smaller of the protocol credits and the worklet's chunk bound
            audioSampleCredits: MAXIMUM_CHUNK_COUNT,
            channelCount: CHANNEL_COUNT,
            maximumBufferedFrameCount: MAXIMUM_BUFFERED_FRAME_COUNT,
            port: expect.any(MessagePort),
            sampleRate: SAMPLE_RATE,
            workletGeneration
        });
        expect(harness.bridge.initialAudioSampleCredits).toBe(MAXIMUM_CHUNK_COUNT);
        expect(harness.bridge.getTelemetry()).toMatchObject({
            activeDecodeGeneration: DECODE_GENERATION,
            failed: false,
            workletGeneration
        });
    });

    it('follows the producer progress against the worklet consumption for the end-of-stream drain', () => {
        const harness = createHarness();
        const { onFailure } = startBridge(harness);
        dispatchFlushTelemetry(harness);

        expect(harness.bridge.recordSubmission(createSubmission(START_TIME_MICROSECONDS), DECODE_GENERATION)).toBe('recorded');
        expect(harness.bridge.recordSubmission(createSubmission(SECOND_CHUNK_TIME_MICROSECONDS), DECODE_GENERATION)).toBe('recorded');
        dispatchConsumption(harness, HALF_CHUNK_FRAME_COUNT);
        expect(harness.bridge.getTelemetry()).toMatchObject({
            pendingFrameCount: (2 * CHUNK_FRAME_COUNT) - HALF_CHUNK_FRAME_COUNT,
            pendingSampleCount: 2,
            releasedSampleCredits: 0
        });

        dispatchConsumption(harness, CHUNK_FRAME_COUNT);
        expect(harness.bridge.getTelemetry()).toMatchObject({
            pendingFrameCount: CHUNK_FRAME_COUNT,
            pendingSampleCount: 1,
            releasedSampleCredits: 1,
            submittedEndMediaTimeMicroseconds: SUBMITTED_END_TIME_MICROSECONDS,
            submittedFrameCount: 2 * CHUNK_FRAME_COUNT,
            submittedSampleCount: 2
        });
        expect(onFailure).not.toHaveBeenCalled();
    });

    it('accepts consumption the worklet reports before the matching progress arrives', () => {
        const harness = createHarness();
        const { onFailure } = startBridge(harness);
        dispatchFlushTelemetry(harness);

        // The producer's channel and the page's progress are separate paths
        dispatchConsumption(harness, CHUNK_FRAME_COUNT);
        expect(harness.bridge.getTelemetry()).toMatchObject({ pendingFrameCount: 0, pendingSampleCount: 0 });

        harness.bridge.recordSubmission(createSubmission(START_TIME_MICROSECONDS), DECODE_GENERATION);
        expect(harness.bridge.getTelemetry()).toMatchObject({
            pendingFrameCount: 0,
            pendingSampleCount: 0,
            releasedSampleCredits: 1
        });
        expect(onFailure).not.toHaveBeenCalled();
    });

    it.each([ 'overflow', 'stale-generation' ] as const)(
        'fails the generation once when the processor reports %s',
        (reason: 'overflow' | 'stale-generation') => {
            const harness = createHarness();
            const { onFailure } = startBridge(harness);
            dispatchFlushTelemetry(harness);

            harness.port.dispatchTelemetry(createTelemetry(harness.controller.generation, { reason }));
            harness.port.dispatchTelemetry(createTelemetry(harness.controller.generation, { reason }));

            expect(onFailure).toHaveBeenCalledExactlyOnceWith(DROPPED_SAMPLE_FAILURE);
            expect(harness.bridge.getTelemetry().failed).toBe(true);
            // A failed generation accounts no further progress
            expect(harness.bridge.recordSubmission(createSubmission(START_TIME_MICROSECONDS), DECODE_GENERATION))
                .toBe('stale-generation');
        }
    );

    it('ignores the reports of a replaced worklet generation', () => {
        const harness = createHarness();
        const { onFailure } = startBridge(harness);
        const replacedGeneration = harness.controller.generation - 1;

        harness.port.dispatchTelemetry(createTelemetry(replacedGeneration, { reason: 'overflow' }));
        dispatchFlushTelemetry(harness);
        harness.port.dispatchTelemetry(createTelemetry(replacedGeneration, { consumedFrames: 0 }));

        expect(onFailure).not.toHaveBeenCalled();
        expect(harness.bridge.getTelemetry().failed).toBe(false);
    });

    it('fails when the worklet consumption count moves backwards', () => {
        const harness = createHarness();
        const { onFailure } = startBridge(harness);
        dispatchFlushTelemetry(harness);

        dispatchConsumption(harness, -1);

        expect(onFailure).toHaveBeenCalledExactlyOnceWith(BACKWARDS_CONSUMPTION_FAILURE);
    });

    it('counts progress of another decode generation as stale without accounting it', () => {
        const harness = createHarness();
        startBridge(harness);

        expect(harness.bridge.recordSubmission(createSubmission(START_TIME_MICROSECONDS), STALE_DECODE_GENERATION))
            .toBe('stale-generation');

        expect(harness.bridge.getTelemetry()).toMatchObject({
            staleSampleCount: 1,
            submittedFrameCount: 0,
            submittedSampleCount: 0
        });
    });

    it('stops with a flush that detaches the producer, and ignores reports and stops afterwards', () => {
        const harness = createHarness();
        const { onFailure } = startBridge(harness);
        dispatchFlushTelemetry(harness);
        harness.bridge.recordSubmission(createSubmission(START_TIME_MICROSECONDS), DECODE_GENERATION);

        harness.bridge.stop(STALE_DECODE_GENERATION);
        expect(harness.bridge.getTelemetry().activeDecodeGeneration).toBe(DECODE_GENERATION);
        harness.bridge.stop(DECODE_GENERATION);

        expect(harness.port.messages.slice(-2).map(entry => entry.message)).toEqual([
            { playing: false, type: 'playback' },
            { generation: harness.controller.generation, mediaTimeMicroseconds: START_TIME_MICROSECONDS, type: 'flush' }
        ]);
        expect(harness.bridge.getTelemetry()).toMatchObject({
            activeDecodeGeneration: null,
            pendingSampleCount: 0,
            submittedSampleCount: 0,
            workletGeneration: null
        });
        harness.port.dispatchTelemetry(createTelemetry(harness.controller.generation, { reason: 'overflow' }));
        expect(onFailure).not.toHaveBeenCalled();
        const messageCount = harness.port.messages.length;
        harness.bridge.stop();
        expect(harness.port.messages).toHaveLength(messageCount);
    });

    it('starts each generation on a new channel with fresh accounting', () => {
        const harness = createHarness();
        const { attachment: firstAttachment } = startBridge(harness);
        dispatchFlushTelemetry(harness);
        harness.bridge.recordSubmission(createSubmission(START_TIME_MICROSECONDS), DECODE_GENERATION);

        const { attachment: secondAttachment } = startBridge(harness, DECODE_GENERATION + 1, RESTART_TIME_MICROSECONDS);

        expect(secondAttachment.port).not.toBe(firstAttachment.port);
        expect(secondAttachment.workletGeneration).toBe(firstAttachment.workletGeneration + 1);
        expect(harness.bridge.getTelemetry()).toMatchObject({
            activeDecodeGeneration: DECODE_GENERATION + 1,
            staleSampleCount: 0,
            submittedFrameCount: 0,
            submittedSampleCount: 0,
            workletGeneration: secondAttachment.workletGeneration
        });
    });

    it('closes both ends of the channel when the processor cannot take its end', () => {
        const closedPorts: unknown[] = [];
        class RecordingMessagePort {
            public close(): void {
                closedPorts.push(this);
            }
        }
        vi.stubGlobal('MessageChannel', class RecordingMessageChannel {
            public readonly port1 = new RecordingMessagePort();
            public readonly port2 = new RecordingMessagePort();
        });
        const controller: AudioWorkletOutputController = {
            ...({} as AudioWorkletOutputController),
            attachProducer: (): void => {
                throw new Error('The worklet output is gone');
            },
            configuration,
            flush: (): number => DECODE_GENERATION,
            onTelemetry: (): (() => void) => (): void => undefined
        };
        const bridge = new CustomDecodeAudioBridge(controller);

        expect(() => bridge.start({
            audioConfiguration: { channelCount: CHANNEL_COUNT, codec: AUDIO_CODEC, sampleRate: SAMPLE_RATE },
            callbacks: { onFailure: vi.fn() },
            decodeGeneration: DECODE_GENERATION,
            startTimeMicroseconds: START_TIME_MICROSECONDS
        })).toThrow('The worklet output is gone');
        expect(closedPorts).toHaveLength(2);
    });

    it('requires an exact decoded channel layout and sample rate', () => {
        const harness = createHarness();

        expect(() => harness.bridge.start({
            audioConfiguration: { channelCount: MONO_CHANNEL_COUNT, codec: AUDIO_CODEC, sampleRate: SAMPLE_RATE },
            callbacks: { onFailure: vi.fn() },
            decodeGeneration: DECODE_GENERATION,
            startTimeMicroseconds: START_TIME_MICROSECONDS
        })).toThrow('channel count');
        expect(() => harness.bridge.start({
            audioConfiguration: { channelCount: CHANNEL_COUNT, codec: AUDIO_CODEC, sampleRate: OTHER_SAMPLE_RATE },
            callbacks: { onFailure: vi.fn() },
            decodeGeneration: DECODE_GENERATION,
            startTimeMicroseconds: START_TIME_MICROSECONDS
        })).toThrow('sample rate');
        expect(harness.port.messages).toEqual([]);
    });
});
