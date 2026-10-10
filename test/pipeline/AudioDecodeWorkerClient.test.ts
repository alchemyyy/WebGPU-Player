// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';
import { createDefaultAudioDownmixSettings } from 'webgpu-player/audio/processing/CustomAudioDownmix';
import { DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM } from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import AudioDecodeWorkerClient, {
    AudioDecodeWorkerAttemptError,
    AudioDecodeWorkerPacketBatchBuilder,
    AudioDecodeWorkerPCMBatchBuilder,
    type AudioDecodeWorkerAttemptListener,
    type AudioDecodeWorkerAttemptOptions
} from 'webgpu-player/pipeline/AudioDecodeWorkerClient';
import {
    AUDIO_DECODE_WORKER_BATCH_DURATION_MICROSECONDS,
    AUDIO_DECODE_WORKER_INPUT_CREDITS,
    MAXIMUM_AUDIO_DECODE_WORKER_BATCH_INPUT_COUNT,
    MAXIMUM_AUDIO_DECODE_WORKER_PACKET_BATCH_BYTE_LENGTH,
    type AudioDecodeWorkerAttemptKey,
    type AudioDecodeWorkerPCMBatch,
    type AudioDecodeWorkerPCMSample,
    type AudioDecodeWorkerResponse
} from 'webgpu-player/pipeline/AudioDecodeWorkerProtocol';
import type { DecodeWorkerAudioOutputAttachment } from 'webgpu-player/pipeline/DecodeWorkerProtocol';

const GENERATION = 9;
const AUDIO_EPOCH = 1;
const OTHER_AUDIO_EPOCH = 2;
const ATTEMPT_KEY: AudioDecodeWorkerAttemptKey = { audioEpoch: AUDIO_EPOCH, generation: GENERATION };
const STEREO_CHANNEL_COUNT = 2;
const SAMPLE_RATE = 48_000;
const AUDIO_SAMPLE_CREDITS = 4;
// Two seconds at 48 kHz, as the worklet ring holds
const MAXIMUM_BUFFERED_FRAME_COUNT = 96_000;
const WORKLET_GENERATION = 6;
const MATROSKA_TIME_RESOLUTION = 1_000;
const START_TIME_MICROSECONDS = 0 as Microseconds;
const ONE_INPUT_CREDIT = 1;
const FRAME_COUNT = 480;
const PROGRESS_DURATION_MICROSECONDS = 10_000;
const WORKER_ERROR_MESSAGE = 'Script failed to load';
const WORKER_FAILURE_MESSAGE = `The audio decode worker failed: ${WORKER_ERROR_MESSAGE}`;
const WORKER_UNAVAILABLE_MESSAGE = 'Workers are unavailable';
const WORKER_START_FAILURE_MESSAGE = `Unable to start the audio decode worker: ${WORKER_UNAVAILABLE_MESSAGE}`;
const INVALID_RESPONSE_MESSAGE = 'The audio decode worker sent an invalid response';
const UNKNOWN_RESPONSE_TYPE = 'attempt-unknown';
const DECODE_FAILURE_MESSAGE = 'Bundled DTS synchronization was not recovered by the seek target';
// A DTS core frame of 512 samples at 48 kHz lasts 10.67 ms
const DTS_PACKET_BYTE_LENGTH = 2_012;
const DTS_PACKET_DURATION_MICROSECONDS = 10_667;
// More than the builder's first buffer, so a batch grows
const LARGE_PACKET_BYTE_LENGTH = 48 * 1024;
const LARGE_PACKET_COUNT = 3;
// TrueHD access units are 1/1200 s apart, closer than the batch span over a full batch
const TRUEHD_PACKET_BYTE_LENGTH = 64;
const TRUEHD_PACKET_DURATION_MICROSECONDS = 833;
const AAC_SAMPLE_DURATION_MICROSECONDS = 21_333;
// Three AAC samples span the batch duration
const SPANNING_AAC_SAMPLE_COUNT = 3;
// Samples this close never span the batch duration, so only their count closes the batch
const NEGLIGIBLE_SAMPLE_STEP_MICROSECONDS = 1;
// Packet bytes count up from a seed, so each packet's bytes differ from the others'
const BYTE_VALUE_COUNT = 256;
const FIRST_PACKET_SEED = 1;
const SECOND_PACKET_SEED = 2;
const FILLER_PACKET_SEED = 0;

/** A dedicated Worker as the decode worker sees it: posted requests, their transfers, and the events it fires */
class FakeAudioDecodeWorker {
    public onerror: ((event: ErrorEvent) => void) | null = null;
    public onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    public onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
    public readonly requests: unknown[] = [];
    public readonly terminate = vi.fn();
    public readonly transfers: Transferable[][] = [];

    public postMessage(message: unknown, transfer: Transferable[] = []): void {
        this.requests.push(message);
        this.transfers.push([ ...transfer ]);
    }

    public respond(response: AudioDecodeWorkerResponse | Record<string, unknown>): void {
        this.onmessage?.({ data: response } as MessageEvent<unknown>);
    }

    public fail(message: string): void {
        this.onerror?.({ message } as ErrorEvent);
    }
}

const openedPorts: MessagePort[] = [];

afterEach(() => {
    for (const port of openedPorts.splice(0)) {
        port.close();
    }
});

function createListener(): AudioDecodeWorkerAttemptListener & {
    onChange: ReturnType<typeof vi.fn>
    onProgress: ReturnType<typeof vi.fn>
    onSourceFormat: ReturnType<typeof vi.fn>
} {
    return { onChange: vi.fn(), onProgress: vi.fn(), onSourceFormat: vi.fn() };
}

function createOptions(audioOutput: DecodeWorkerAudioOutputAttachment | null = null): AudioDecodeWorkerAttemptOptions {
    return {
        ...ATTEMPT_KEY,
        audioDownmixAlgorithm: DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
        audioDownmixSettings: createDefaultAudioDownmixSettings(),
        audioOutput,
        decoderBackend: 'dts',
        outputChannelCount: STEREO_CHANNEL_COUNT,
        routeCodec: 'dts',
        sourceSampleRate: SAMPLE_RATE,
        startTimeMicroseconds: START_TIME_MICROSECONDS,
        timeResolution: MATROSKA_TIME_RESOLUTION
    };
}

function createAttachment(): DecodeWorkerAudioOutputAttachment {
    const channel = new MessageChannel();
    openedPorts.push(channel.port1, channel.port2);
    return {
        audioSampleCredits: AUDIO_SAMPLE_CREDITS,
        channelCount: STEREO_CHANNEL_COUNT,
        maximumBufferedFrameCount: MAXIMUM_BUFFERED_FRAME_COUNT,
        port: channel.port2,
        sampleRate: SAMPLE_RATE,
        workletGeneration: WORKLET_GENERATION
    };
}

function openClient(): { client: AudioDecodeWorkerClient, worker: FakeAudioDecodeWorker } {
    const worker = new FakeAudioDecodeWorker();
    const client = new AudioDecodeWorkerClient((): Worker => worker as unknown as Worker);
    return { client, worker };
}

function createPCMSample(mediaTimeMicroseconds: number): AudioDecodeWorkerPCMSample {
    return {
        channelCount: STEREO_CHANNEL_COUNT,
        channelData: [ new Float32Array(FRAME_COUNT), new Float32Array(FRAME_COUNT) ],
        frameCount: FRAME_COUNT,
        mediaTimeMicroseconds: mediaTimeMicroseconds as Microseconds,
        sampleRate: SAMPLE_RATE
    };
}

function createPacketData(byteLength: number, seed: number): Uint8Array {
    const data = new Uint8Array(byteLength);
    for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
        data[byteIndex] = (seed + byteIndex) % BYTE_VALUE_COUNT;
    }
    return data;
}

describe('the audio decode worker client', () => {
    it('opens an attempt and spends one input credit per batch until the worker credits one back', () => {
        const { client, worker } = openClient();
        const listener = createListener();

        const attempt = client.openAttempt(createOptions(), listener);

        expect(worker.requests).toEqual([ { ...createOptions(), type: 'open-attempt' } ]);
        for (let creditIndex = 0; creditIndex < AUDIO_DECODE_WORKER_INPUT_CREDITS; creditIndex += 1) {
            expect(attempt.takeInputCredit()).toBe(true);
        }
        expect(attempt.takeInputCredit()).toBe(false);

        worker.respond({ ...ATTEMPT_KEY, inputCredits: ONE_INPUT_CREDIT, type: 'input-credit' });
        expect(listener.onChange).toHaveBeenCalledTimes(1);
        expect(attempt.takeInputCredit()).toBe(true);
        expect(attempt.takeInputCredit()).toBe(false);
    });

    it('transfers a batch\'s buffers, a resync\'s channel with the open request, and an attached channel', () => {
        const { client, worker } = openClient();
        const resyncOutput = createAttachment();
        const attempt = client.openAttempt(createOptions(resyncOutput), createListener());
        const attachedOutput = createAttachment();
        const batch: AudioDecodeWorkerPCMBatch = { kind: 'pcm', samples: [ createPCMSample(START_TIME_MICROSECONDS) ] };

        attempt.sendInput(batch);
        attempt.attachOutput(attachedOutput);
        attempt.finish();

        expect(worker.transfers).toEqual([
            [ resyncOutput.port ],
            [ batch.samples[0].channelData[0].buffer, batch.samples[0].channelData[1].buffer ],
            [ attachedOutput.port ],
            []
        ]);
        expect(worker.requests.map(request => (request as { type: string }).type)).toEqual([
            'open-attempt',
            'input',
            'attach-output',
            'finish-attempt'
        ]);
    });

    it('relays an open attempt\'s progress, format, finish, and failure, and settles its closure on the worker\'s answer', async () => {
        const { client, worker } = openClient();
        const listener = createListener();
        const attempt = client.openAttempt(createOptions(), listener);
        const progress: AudioDecodeWorkerResponse = {
            ...ATTEMPT_KEY,
            durationMicroseconds: PROGRESS_DURATION_MICROSECONDS as Microseconds,
            frameCount: FRAME_COUNT,
            mediaTimeMicroseconds: START_TIME_MICROSECONDS,
            sampleRate: SAMPLE_RATE,
            type: 'progress'
        };
        const sourceFormat: AudioDecodeWorkerResponse = {
            ...ATTEMPT_KEY,
            channelCount: STEREO_CHANNEL_COUNT,
            sampleRate: SAMPLE_RATE,
            type: 'source-format'
        };

        worker.respond(progress);
        worker.respond(sourceFormat);
        worker.respond({ ...ATTEMPT_KEY, type: 'attempt-finished' });
        worker.respond({ ...ATTEMPT_KEY, failureKind: 'decode-failed', message: DECODE_FAILURE_MESSAGE, type: 'attempt-failed' });
        // Another attempt's responses never reach this one
        worker.respond({ ...progress, audioEpoch: OTHER_AUDIO_EPOCH });

        expect(listener.onProgress).toHaveBeenCalledExactlyOnceWith(progress);
        expect(listener.onSourceFormat).toHaveBeenCalledExactlyOnceWith(sourceFormat);
        expect(attempt.finished).toBe(true);
        expect(attempt.failure).toEqual({ failureKind: 'decode-failed', message: DECODE_FAILURE_MESSAGE });
        const error = new AudioDecodeWorkerAttemptError({ failureKind: 'decode-failed', message: DECODE_FAILURE_MESSAGE });
        expect(error).toMatchObject({ failureKind: 'decode-failed', message: DECODE_FAILURE_MESSAGE, name: 'AudioDecodeWorkerAttemptError' });

        let closed = false;
        const closure = attempt.close().then((): void => {
            closed = true;
        });
        expect(attempt.close()).toBe(attempt.close());
        expect(worker.requests.at(-1)).toEqual({ ...ATTEMPT_KEY, type: 'close-attempt' });
        await Promise.resolve();
        expect(closed).toBe(false);
        // A closed attempt reports no more progress
        worker.respond(progress);
        expect(listener.onProgress).toHaveBeenCalledTimes(1);

        worker.respond({ ...ATTEMPT_KEY, type: 'attempt-closed' });
        await closure;
        expect(closed).toBe(true);
    });

    it('fails every attempt as an audio output failure when the worker errors, and stops it', async () => {
        const { client, worker } = openClient();
        const listener = createListener();
        const attempt = client.openAttempt(createOptions(), listener);
        const closure = attempt.close();

        worker.fail(WORKER_ERROR_MESSAGE);

        expect(client.failure).toBe(WORKER_FAILURE_MESSAGE);
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        expect(attempt.failure).toEqual({ failureKind: 'audio-output-failed', message: WORKER_FAILURE_MESSAGE });
        expect(listener.onChange).toHaveBeenCalled();
        // The lost worker released everything with itself
        await expect(closure).resolves.toBeUndefined();

        const resyncOutput = createAttachment();
        const closeSpy = vi.spyOn(resyncOutput.port, 'close');
        const laterAttempt = client.openAttempt(createOptions(resyncOutput), createListener());
        expect(laterAttempt.failure).toEqual({ failureKind: 'audio-output-failed', message: WORKER_FAILURE_MESSAGE });
        expect(closeSpy).toHaveBeenCalledTimes(1);
        await expect(laterAttempt.close()).resolves.toBeUndefined();
        expect(worker.requests).toHaveLength(2);
    });

    it('fails when the worker cannot start, or answers out of contract', () => {
        const unavailableClient = new AudioDecodeWorkerClient((): Worker => {
            throw new TypeError(WORKER_UNAVAILABLE_MESSAGE);
        });
        expect(unavailableClient.failure).toBe(WORKER_START_FAILURE_MESSAGE);
        expect(unavailableClient.openAttempt(createOptions(), createListener()).failure)
            .toEqual({ failureKind: 'audio-output-failed', message: WORKER_START_FAILURE_MESSAGE });

        const { client, worker } = openClient();
        const attempt = client.openAttempt(createOptions(), createListener());
        worker.respond({ ...ATTEMPT_KEY, type: UNKNOWN_RESPONSE_TYPE });
        expect(client.failure).toBe(INVALID_RESPONSE_MESSAGE);
        expect(attempt.failure).toEqual({ failureKind: 'audio-output-failed', message: INVALID_RESPONSE_MESSAGE });
    });
});

describe('the audio decode worker batch builders', () => {
    it('copies packets back to back, so the demuxer may reuse what it lent', () => {
        const builder = new AudioDecodeWorkerPacketBatchBuilder();
        const firstPacket = createPacketData(DTS_PACKET_BYTE_LENGTH, FIRST_PACKET_SEED);
        const secondPacket = createPacketData(DTS_PACKET_BYTE_LENGTH, SECOND_PACKET_SEED);

        builder.add(firstPacket, START_TIME_MICROSECONDS);
        builder.add(secondPacket, DTS_PACKET_DURATION_MICROSECONDS as Microseconds);
        firstPacket.fill(FILLER_PACKET_SEED);
        const batch = builder.take();

        expect(batch).toMatchObject({
            kind: 'packets',
            packetByteLengths: [ DTS_PACKET_BYTE_LENGTH, DTS_PACKET_BYTE_LENGTH ],
            packetTimestampsMicroseconds: [ START_TIME_MICROSECONDS, DTS_PACKET_DURATION_MICROSECONDS ]
        });
        const data = new Uint8Array(batch?.data ?? new ArrayBuffer(0));
        expect(data.subarray(0, DTS_PACKET_BYTE_LENGTH)).toEqual(createPacketData(DTS_PACKET_BYTE_LENGTH, FIRST_PACKET_SEED));
        expect(data.subarray(DTS_PACKET_BYTE_LENGTH, DTS_PACKET_BYTE_LENGTH + DTS_PACKET_BYTE_LENGTH)).toEqual(secondPacket);
        // The next batch starts empty
        expect(builder.take()).toBeNull();
    });

    it('grows its buffer for packets past the first one', () => {
        const builder = new AudioDecodeWorkerPacketBatchBuilder();
        const packets: Uint8Array[] = [];
        for (let packetIndex = 0; packetIndex < LARGE_PACKET_COUNT; packetIndex += 1) {
            const packet = createPacketData(LARGE_PACKET_BYTE_LENGTH, packetIndex);
            packets.push(packet);
            builder.add(packet, START_TIME_MICROSECONDS);
        }

        const data = new Uint8Array(builder.take()?.data ?? new ArrayBuffer(0));
        for (let packetIndex = 0; packetIndex < LARGE_PACKET_COUNT; packetIndex += 1) {
            const packetOffset = packetIndex * LARGE_PACKET_BYTE_LENGTH;
            expect(data.subarray(packetOffset, packetOffset + LARGE_PACKET_BYTE_LENGTH)).toEqual(packets[packetIndex]);
        }
    });

    it('closes a packet batch at its media time span, its packet count, or its byte length', () => {
        const spanBuilder = new AudioDecodeWorkerPacketBatchBuilder();
        let packetTimeMicroseconds = START_TIME_MICROSECONDS as number;
        while (!spanBuilder.isFull()) {
            spanBuilder.add(createPacketData(DTS_PACKET_BYTE_LENGTH, FILLER_PACKET_SEED), packetTimeMicroseconds as Microseconds);
            packetTimeMicroseconds += DTS_PACKET_DURATION_MICROSECONDS;
        }
        const spanTimestamps = spanBuilder.take()?.packetTimestampsMicroseconds ?? [];
        expect(spanTimestamps.at(-1)).toBeGreaterThanOrEqual(AUDIO_DECODE_WORKER_BATCH_DURATION_MICROSECONDS);
        expect(spanTimestamps.at(-2)).toBeLessThan(AUDIO_DECODE_WORKER_BATCH_DURATION_MICROSECONDS);

        const countBuilder = new AudioDecodeWorkerPacketBatchBuilder();
        for (let packetIndex = 0; packetIndex < MAXIMUM_AUDIO_DECODE_WORKER_BATCH_INPUT_COUNT - 1; packetIndex += 1) {
            countBuilder.add(createPacketData(TRUEHD_PACKET_BYTE_LENGTH, FILLER_PACKET_SEED), START_TIME_MICROSECONDS);
        }
        expect(countBuilder.isFull()).toBe(false);
        countBuilder.add(
            createPacketData(TRUEHD_PACKET_BYTE_LENGTH, FILLER_PACKET_SEED),
            TRUEHD_PACKET_DURATION_MICROSECONDS as Microseconds
        );
        expect(countBuilder.isFull()).toBe(true);

        const byteBuilder = new AudioDecodeWorkerPacketBatchBuilder();
        byteBuilder.add(
            createPacketData(MAXIMUM_AUDIO_DECODE_WORKER_PACKET_BATCH_BYTE_LENGTH, FILLER_PACKET_SEED),
            START_TIME_MICROSECONDS
        );
        expect(byteBuilder.isFull()).toBe(true);
    });

    it('closes a sample batch at its media time span or its sample count', () => {
        const spanBuilder = new AudioDecodeWorkerPCMBatchBuilder();
        for (let sampleIndex = 0; sampleIndex < SPANNING_AAC_SAMPLE_COUNT; sampleIndex += 1) {
            expect(spanBuilder.isFull()).toBe(false);
            spanBuilder.add(createPCMSample(sampleIndex * AAC_SAMPLE_DURATION_MICROSECONDS));
        }
        expect(spanBuilder.isFull()).toBe(true);
        expect(spanBuilder.take()?.samples).toHaveLength(SPANNING_AAC_SAMPLE_COUNT);
        expect(spanBuilder.take()).toBeNull();

        const countBuilder = new AudioDecodeWorkerPCMBatchBuilder();
        for (let sampleIndex = 0; sampleIndex < MAXIMUM_AUDIO_DECODE_WORKER_BATCH_INPUT_COUNT; sampleIndex += 1) {
            expect(countBuilder.isFull()).toBe(false);
            countBuilder.add(createPCMSample(sampleIndex * NEGLIGIBLE_SAMPLE_STEP_MICROSECONDS));
        }
        expect(countBuilder.isFull()).toBe(true);
    });
});
