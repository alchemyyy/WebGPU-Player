// @vitest-environment node

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTrueHDExactCapabilityVectors } from '#codec_vector_assets/truehd/TrueHDExactCapabilityVectors';
import { AUDIO_OUTPUT_STAGE_WASM_ASSET, TRUEHD_DECODER_WASM_ASSET } from 'webgpu-player/EngineAssets';
import type { Microseconds } from 'webgpu-player/MediaTime';
import { loadTrueHDDecoderModule } from 'webgpu-player/audio/decoders/TrueHDSoftwareAudioDecoder';
import { loadAudioOutputStageModule } from 'webgpu-player/audio/processing/AudioOutputStageModule';
import { createDefaultAudioDownmixSettings } from 'webgpu-player/audio/processing/CustomAudioDownmix';
import { DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM } from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import {
    AUDIO_DECODE_WORKER_INPUT_CREDITS,
    getAudioDecodeWorkerInputTransferList,
    isAudioDecodeWorkerResponse,
    type AudioDecodeWorkerAttemptKey,
    type AudioDecodeWorkerInputBatch,
    type AudioDecodeWorkerOpenAttemptRequest,
    type AudioDecodeWorkerPacketBatch,
    type AudioDecodeWorkerPCMBatch,
    type AudioDecodeWorkerPCMSample,
    type AudioDecodeWorkerRequest,
    type AudioDecodeWorkerResponse
} from 'webgpu-player/pipeline/AudioDecodeWorkerProtocol';
import { startAudioDecodeWorkerRuntime } from 'webgpu-player/pipeline/AudioDecodeWorkerRuntime';
import type { DecodeWorkerAudioOutputAttachment } from 'webgpu-player/pipeline/DecodeWorkerProtocol';

import { getDecodedAudioMediaSample } from '../helpers/decodedAudioMedia';
import {
    openFakeWorkletChannel,
    type FakeWorkletChannelOptions,
    type FakeWorkletProcessor
} from '../helpers/fakeWorkletProcessor';
import { readDecoderWASMSource } from '../helpers/libraryAssets';

type ProgressResponse = Extract<AudioDecodeWorkerResponse, { type: 'progress' }>;

const GENERATION = 12;
const INITIAL_AUDIO_EPOCH = 0;
const UNOPENED_AUDIO_EPOCH = 3;
const ATTEMPT_KEY: AudioDecodeWorkerAttemptKey = { audioEpoch: INITIAL_AUDIO_EPOCH, generation: GENERATION };
const WORKLET_GENERATION = 5;
const AUDIO_SAMPLE_CREDITS = 4;
const HELD_AUDIO_SAMPLE_CREDITS = 2;
const STEREO_CHANNEL_COUNT = 2;
// Quad is no decoded PCM route's layout
const UNQUALIFIED_CHANNEL_COUNT = 4;
const SAMPLE_RATE = 48_000;
const PCM_ROUTE_CODEC = 'pcm-s16';
const TRUEHD_ROUTE_CODEC = 'truehd';
// Matroska timestamps count milliseconds
const MATROSKA_TIME_RESOLUTION = 1_000;
const START_TIME_MICROSECONDS = 0 as Microseconds;
const FIRST_BATCH_INDEX = 0;
// 20 ms samples, two to a batch, as the decode worker batches 40 ms; each batch renders to one chunk at the minimum chunk length
const SAMPLE_FRAME_COUNT = 960;
const SAMPLE_DURATION_MICROSECONDS = 20_000;
const SAMPLES_PER_BATCH = 2;
const BATCH_COUNT = 25;
const TOTAL_FRAME_COUNT = SAMPLE_FRAME_COUNT * SAMPLES_PER_BATCH * BATCH_COUNT;
// The frames whose samples the first chunk must carry unchanged
const COMPARED_FRAME_COUNT = 64;
// Long enough for the runtime to post more, were it not waiting
const SETTLE_MILLISECONDS = 50;
const WAIT_OPTIONS = { interval: 1, timeout: 5_000 } as const;
const PACKET_BYTE_LENGTH = 16;
const TRUEHD_PACKETS_PER_BATCH = 48;
const DROPPED_SAMPLE_FAILURE = 'The audio worklet dropped a decoded sample';
const INPUT_CREDIT_FAILURE = 'Decoded audio input exceeded its credits';
const INPUT_KIND_FAILURE = 'Decoded audio input does not match the attempt decoder';

/** The decode worker's end of a channel to a runtime, which records every response */
class RuntimeChannel {
    public readonly responses: AudioDecodeWorkerResponse[] = [];
    private readonly port: MessagePort;

    public constructor() {
        const channel = new MessageChannel();
        this.port = channel.port1;
        this.port.onmessage = (event: MessageEvent<unknown>): void => {
            if (!isAudioDecodeWorkerResponse(event.data)) {
                throw new TypeError('The runtime posted an invalid response');
            }
            this.responses.push(event.data);
        };
        startAudioDecodeWorkerRuntime(channel.port2);
        channel.port2.start();
    }

    public send(request: AudioDecodeWorkerRequest, transfer: Transferable[] = []): void {
        this.port.postMessage(request, transfer);
    }

    public close(): void {
        this.port.close();
    }
}

const openedChannels: RuntimeChannel[] = [];
const openedProcessors: FakeWorkletProcessor[] = [];

beforeAll(async () => {
    // The served binaries, which every runtime of this file reuses
    await loadAudioOutputStageModule(await readDecoderWASMSource(AUDIO_OUTPUT_STAGE_WASM_ASSET));
    await loadTrueHDDecoderModule(await readDecoderWASMSource(TRUEHD_DECODER_WASM_ASSET));
});

afterEach(() => {
    for (const processor of openedProcessors.splice(0)) {
        processor.close();
    }
    for (const channel of openedChannels.splice(0)) {
        channel.close();
    }
});

function openRuntime(): RuntimeChannel {
    const channel = new RuntimeChannel();
    openedChannels.push(channel);
    return channel;
}

function openWorklet(options: Partial<FakeWorkletChannelOptions> = {}): {
    attachment: DecodeWorkerAudioOutputAttachment
    processor: FakeWorkletProcessor
} {
    const channel = openFakeWorkletChannel({
        audioSampleCredits: AUDIO_SAMPLE_CREDITS,
        channelCount: STEREO_CHANNEL_COUNT,
        workletGeneration: WORKLET_GENERATION,
        ...options
    });
    openedProcessors.push(channel.processor);
    return channel;
}

function createOpenRequest(overrides: Partial<AudioDecodeWorkerOpenAttemptRequest> = {}): AudioDecodeWorkerOpenAttemptRequest {
    return {
        ...ATTEMPT_KEY,
        audioDownmixAlgorithm: DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
        audioDownmixSettings: createDefaultAudioDownmixSettings(),
        audioOutput: null,
        decoderBackend: 'pcm',
        outputChannelCount: STEREO_CHANNEL_COUNT,
        routeCodec: PCM_ROUTE_CODEC,
        sourceSampleRate: SAMPLE_RATE,
        startTimeMicroseconds: START_TIME_MICROSECONDS,
        timeResolution: MATROSKA_TIME_RESOLUTION,
        type: 'open-attempt',
        ...overrides
    };
}

/** Opens an attempt with the worklet channel in its open request, as a resync's attempt opens. */
function openAttempt(channel: RuntimeChannel, audioOutput: DecodeWorkerAudioOutputAttachment | null): void {
    channel.send(createOpenRequest({ audioOutput }), audioOutput ? [ audioOutput.port ] : []);
}

function createToneSample(sampleIndex: number, channelCount = STEREO_CHANNEL_COUNT): AudioDecodeWorkerPCMSample {
    const firstFrameIndex = sampleIndex * SAMPLE_FRAME_COUNT;
    const channelData: Float32Array[] = [];
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        const channel = new Float32Array(SAMPLE_FRAME_COUNT);
        for (let frameIndex = 0; frameIndex < SAMPLE_FRAME_COUNT; frameIndex += 1) {
            channel[frameIndex] = getDecodedAudioMediaSample(firstFrameIndex + frameIndex, channelIndex);
        }
        channelData.push(channel);
    }
    return {
        channelCount,
        channelData,
        frameCount: SAMPLE_FRAME_COUNT,
        mediaTimeMicroseconds: (sampleIndex * SAMPLE_DURATION_MICROSECONDS) as Microseconds,
        sampleRate: SAMPLE_RATE
    };
}

function createToneBatch(batchIndex: number, channelCount = STEREO_CHANNEL_COUNT): AudioDecodeWorkerPCMBatch {
    const samples: AudioDecodeWorkerPCMSample[] = [];
    for (let sampleOffset = 0; sampleOffset < SAMPLES_PER_BATCH; sampleOffset += 1) {
        samples.push(createToneSample((batchIndex * SAMPLES_PER_BATCH) + sampleOffset, channelCount));
    }
    return { kind: 'pcm', samples };
}

function sendBatch(channel: RuntimeChannel, batch: AudioDecodeWorkerInputBatch): void {
    channel.send({ ...ATTEMPT_KEY, batch, type: 'input' }, getAudioDecodeWorkerInputTransferList(batch));
}

function getReturnedInputCredits(channel: RuntimeChannel): number {
    let inputCredits = 0;
    for (const response of channel.responses) {
        if (response.type === 'input-credit') {
            inputCredits += response.inputCredits;
        }
    }
    return inputCredits;
}

/** Sends each batch on a credit, the initial ones and then one per rendered batch, as the decode worker does. */
async function sendBatchesOnCredits(channel: RuntimeChannel, batches: readonly AudioDecodeWorkerInputBatch[]): Promise<void> {
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        await vi.waitFor(() => {
            expect(AUDIO_DECODE_WORKER_INPUT_CREDITS + getReturnedInputCredits(channel)).toBeGreaterThan(batchIndex);
        }, WAIT_OPTIONS);
        sendBatch(channel, batches[batchIndex]);
    }
}

function createToneBatches(batchCount: number): AudioDecodeWorkerPCMBatch[] {
    const batches: AudioDecodeWorkerPCMBatch[] = [];
    for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
        batches.push(createToneBatch(batchIndex));
    }
    return batches;
}

function getProgress(channel: RuntimeChannel): ProgressResponse[] {
    return channel.responses.filter((response): response is ProgressResponse => response.type === 'progress');
}

function getFailures(channel: RuntimeChannel): AudioDecodeWorkerResponse[] {
    return channel.responses.filter(response => response.type === 'attempt-failed');
}

async function waitForResponse(channel: RuntimeChannel, expected: AudioDecodeWorkerResponse): Promise<void> {
    await vi.waitFor(() => {
        expect(channel.responses).toContainEqual(expected);
    }, WAIT_OPTIONS);
}

function waitForSettled(): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, SETTLE_MILLISECONDS);
    });
}

describe('the audio decode worker runtime', () => {
    it('renders batches to the worklet, credits each back once rendered, and finishes after the tails', async () => {
        const channel = openRuntime();
        const { attachment, processor } = openWorklet();
        openAttempt(channel, attachment);

        await sendBatchesOnCredits(channel, createToneBatches(BATCH_COUNT));
        channel.send({ ...ATTEMPT_KEY, type: 'finish-attempt' });
        await waitForResponse(channel, { ...ATTEMPT_KEY, type: 'attempt-finished' });

        expect(getFailures(channel)).toEqual([]);
        expect(getReturnedInputCredits(channel)).toBe(BATCH_COUNT);
        expect(channel.responses.filter(response => response.type === 'source-format')).toEqual([
            { ...ATTEMPT_KEY, channelCount: STEREO_CHANNEL_COUNT, sampleRate: SAMPLE_RATE, type: 'source-format' }
        ]);
        await vi.waitFor(() => {
            expect(processor.receivedFrameCount).toBe(TOTAL_FRAME_COUNT);
        }, WAIT_OPTIONS);
        expect(processor.chunks.every(chunk => chunk.generation === WORKLET_GENERATION)).toBe(true);
        // The decode worker learns each chunk's place and length, never its PCM
        expect(getProgress(channel).map(({ frameCount, mediaTimeMicroseconds }) => ({ frameCount, mediaTimeMicroseconds })))
            .toEqual(processor.chunks.map(chunk => ({
                frameCount: chunk.channelData[0].length,
                mediaTimeMicroseconds: chunk.timestampMicroseconds
            })));
        for (let frameIndex = 0; frameIndex < COMPARED_FRAME_COUNT; frameIndex += 1) {
            for (let channelIndex = 0; channelIndex < STEREO_CHANNEL_COUNT; channelIndex += 1) {
                expect(processor.chunks[0].channelData[channelIndex][frameIndex]).toBe(getDecodedAudioMediaSample(frameIndex, channelIndex));
            }
        }

        // A finished attempt keeps its channel, so the worklet plays out what it holds, until the attempt closes
        expect(processor.closed).toBe(false);
        channel.send({ ...ATTEMPT_KEY, type: 'close-attempt' });
        await waitForResponse(channel, { ...ATTEMPT_KEY, type: 'attempt-closed' });
        await vi.waitFor(() => {
            expect(processor.closed).toBe(true);
        }, WAIT_OPTIONS);
    });

    it('holds batches at the worklet credit window and credits a batch only once it is rendered', async () => {
        const channel = openRuntime();
        const { attachment, processor } = openWorklet({ audioSampleCredits: HELD_AUDIO_SAMPLE_CREDITS, holdReleases: true });
        openAttempt(channel, attachment);
        for (const batch of createToneBatches(AUDIO_DECODE_WORKER_INPUT_CREDITS)) {
            sendBatch(channel, batch);
        }

        // Each batch is one chunk, so the window holds as many rendered batches as chunks
        await vi.waitFor(() => {
            expect(processor.chunks).toHaveLength(HELD_AUDIO_SAMPLE_CREDITS);
        }, WAIT_OPTIONS);
        await waitForSettled();
        expect(processor.chunks).toHaveLength(HELD_AUDIO_SAMPLE_CREDITS);
        expect(getReturnedInputCredits(channel)).toBe(HELD_AUDIO_SAMPLE_CREDITS);

        processor.releaseHeld(1);
        await vi.waitFor(() => {
            expect(getReturnedInputCredits(channel)).toBe(HELD_AUDIO_SAMPLE_CREDITS + 1);
        }, WAIT_OPTIONS);
        await waitForSettled();
        expect(processor.chunks).toHaveLength(HELD_AUDIO_SAMPLE_CREDITS + 1);
        expect(getProgress(channel)).toHaveLength(HELD_AUDIO_SAMPLE_CREDITS + 1);
        expect(getFailures(channel)).toEqual([]);
    });

    it('closes the worklet channel at once when an attempt closes mid-batch, and answers once it released the rest', async () => {
        const channel = openRuntime();
        const { attachment, processor } = openWorklet({ audioSampleCredits: HELD_AUDIO_SAMPLE_CREDITS, holdReleases: true });
        openAttempt(channel, attachment);
        for (const batch of createToneBatches(AUDIO_DECODE_WORKER_INPUT_CREDITS)) {
            sendBatch(channel, batch);
        }
        await vi.waitFor(() => {
            expect(processor.chunks).toHaveLength(HELD_AUDIO_SAMPLE_CREDITS);
        }, WAIT_OPTIONS);

        channel.send({ ...ATTEMPT_KEY, type: 'close-attempt' });

        await waitForResponse(channel, { ...ATTEMPT_KEY, type: 'attempt-closed' });
        await vi.waitFor(() => {
            expect(processor.closed).toBe(true);
        }, WAIT_OPTIONS);
        // The closed attempt neither fails nor finishes, and its later batches are dropped
        sendBatch(channel, createToneBatch(AUDIO_DECODE_WORKER_INPUT_CREDITS));
        await waitForSettled();
        expect(channel.responses.map(response => response.type)).not.toContain('attempt-failed');
        expect(channel.responses.map(response => response.type)).not.toContain('attempt-finished');
        expect(processor.chunks).toHaveLength(HELD_AUDIO_SAMPLE_CREDITS);
    });

    it('takes the initial attempt\'s channel once attached, and closes a channel no open attempt takes', async () => {
        const channel = openRuntime();
        openAttempt(channel, null);
        const unopenedEpochWorklet = openWorklet();
        const { attachment, processor } = openWorklet();

        channel.send(
            { audioEpoch: UNOPENED_AUDIO_EPOCH, audioOutput: unopenedEpochWorklet.attachment, generation: GENERATION, type: 'attach-output' },
            [ unopenedEpochWorklet.attachment.port ]
        );
        channel.send({ ...ATTEMPT_KEY, audioOutput: attachment, type: 'attach-output' }, [ attachment.port ]);
        await sendBatchesOnCredits(channel, createToneBatches(AUDIO_DECODE_WORKER_INPUT_CREDITS));
        channel.send({ ...ATTEMPT_KEY, type: 'finish-attempt' });

        await waitForResponse(channel, { ...ATTEMPT_KEY, type: 'attempt-finished' });
        await vi.waitFor(() => {
            expect(unopenedEpochWorklet.processor.closed).toBe(true);
            expect(processor.receivedFrameCount).toBe(SAMPLE_FRAME_COUNT * SAMPLES_PER_BATCH * AUDIO_DECODE_WORKER_INPUT_CREDITS);
        }, WAIT_OPTIONS);
        expect(unopenedEpochWorklet.processor.chunks).toEqual([]);
    });

    it('fails an attempt whose decoded layout no route qualifies as an unsupported source', async () => {
        const channel = openRuntime();
        const { attachment } = openWorklet();
        openAttempt(channel, attachment);

        sendBatch(channel, createToneBatch(FIRST_BATCH_INDEX, UNQUALIFIED_CHANNEL_COUNT));

        await vi.waitFor(() => {
            expect(getFailures(channel)).toMatchObject([ { ...ATTEMPT_KEY, failureKind: 'source-unsupported' } ]);
        }, WAIT_OPTIONS);
    });

    it('fails as an audio output failure when the worklet drops a chunk, while it waits for more input', async () => {
        const channel = openRuntime();
        const { attachment, processor } = openWorklet();
        processor.dropNext('overflow');
        openAttempt(channel, attachment);

        sendBatch(channel, createToneBatch(FIRST_BATCH_INDEX));

        await waitForResponse(channel, {
            ...ATTEMPT_KEY,
            failureKind: 'audio-output-failed',
            message: DROPPED_SAMPLE_FAILURE,
            type: 'attempt-failed'
        });
    });

    it('fails an attempt sent more batches than its credits', async () => {
        const channel = openRuntime();
        // Without a worklet channel nothing renders, so no credit returns
        openAttempt(channel, null);

        for (const batch of createToneBatches(AUDIO_DECODE_WORKER_INPUT_CREDITS + 1)) {
            sendBatch(channel, batch);
        }

        await waitForResponse(channel, {
            ...ATTEMPT_KEY,
            failureKind: 'decode-failed',
            message: INPUT_CREDIT_FAILURE,
            type: 'attempt-failed'
        });
    });

    it('fails a sample attempt sent packets', async () => {
        const channel = openRuntime();
        const { attachment } = openWorklet();
        openAttempt(channel, attachment);
        const packetBatch: AudioDecodeWorkerPacketBatch = {
            data: new ArrayBuffer(PACKET_BYTE_LENGTH),
            kind: 'packets',
            packetByteLengths: [ PACKET_BYTE_LENGTH ],
            packetTimestampsMicroseconds: [ START_TIME_MICROSECONDS ]
        };

        sendBatch(channel, packetBatch);

        await waitForResponse(channel, {
            ...ATTEMPT_KEY,
            failureKind: 'decode-failed',
            message: INPUT_KIND_FAILURE,
            type: 'attempt-failed'
        });
    });

    it('decodes a TrueHD attempt\'s packet batches with the bundled decoder', async () => {
        const vector = createTrueHDExactCapabilityVectors().find(candidate => (
            candidate.codec === 'truehd' && candidate.sampleRate === SAMPLE_RATE && candidate.channelCount === STEREO_CHANNEL_COUNT
        ));
        if (!vector) {
            throw new Error('The TrueHD vectors have no 48 kHz stereo stream');
        }
        const batches: AudioDecodeWorkerPacketBatch[] = [];
        for (let firstIndex = 0; firstIndex < vector.accessUnits.length; firstIndex += TRUEHD_PACKETS_PER_BATCH) {
            const accessUnits = vector.accessUnits.slice(firstIndex, firstIndex + TRUEHD_PACKETS_PER_BATCH);
            const data = new Uint8Array(accessUnits.reduce((byteLength, accessUnit) => byteLength + accessUnit.byteLength, 0));
            let byteOffset = 0;
            for (const accessUnit of accessUnits) {
                data.set(accessUnit, byteOffset);
                byteOffset += accessUnit.byteLength;
            }
            batches.push({
                data: data.buffer,
                kind: 'packets',
                packetByteLengths: accessUnits.map(accessUnit => accessUnit.byteLength),
                packetTimestampsMicroseconds: vector.expectedOutputs
                    .slice(firstIndex, firstIndex + TRUEHD_PACKETS_PER_BATCH)
                    .map(expected => expected.mediaTimeMicroseconds as Microseconds)
            });
        }
        const decodedFrameCount = vector.expectedOutputs.reduce((frameCount, expected) => frameCount + expected.frameCount, 0);
        const channel = openRuntime();
        const { attachment, processor } = openWorklet();
        channel.send(createOpenRequest({
            audioOutput: attachment,
            decoderBackend: 'truehd',
            routeCodec: TRUEHD_ROUTE_CODEC
        }), [ attachment.port ]);

        await sendBatchesOnCredits(channel, batches);
        channel.send({ ...ATTEMPT_KEY, type: 'finish-attempt' });

        await waitForResponse(channel, { ...ATTEMPT_KEY, type: 'attempt-finished' });
        expect(getFailures(channel)).toEqual([]);
        await vi.waitFor(() => {
            expect(processor.receivedFrameCount).toBe(decodedFrameCount);
        }, WAIT_OPTIONS);
        expect(getProgress(channel).reduce((frameCount, response) => frameCount + response.frameCount, 0)).toBe(decodedFrameCount);
    });
});
