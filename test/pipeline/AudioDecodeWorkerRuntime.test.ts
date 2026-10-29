// @vitest-environment node

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AUDIO_OUTPUT_STAGE_WASM_ASSET } from 'webgpu-player/EngineAssets';
import type { Microseconds } from 'webgpu-player/MediaTime';
import { parseAudioDecoderManifest } from 'webgpu-player/decode/audio/AudioDecoderManifest';
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
import {
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR,
    CUSTOM_WAVE_CHANNEL_MASK_STEREO
} from 'webgpu-player/audio/processing/CustomWaveChannelLayout';
import { startAudioDecodeWorkerRuntime } from 'webgpu-player/pipeline/AudioDecodeWorkerRuntime';
import type { DecodeWorkerAudioOutputAttachment } from 'webgpu-player/pipeline/DecodeWorkerProtocol';

import { getAudioDecoderErrorCode } from '../helpers/audioDecoderPackageResults';
import { getDecodedAudioMediaSample } from '../helpers/decodedAudioMedia';
import {
    openFakeWorkletChannel,
    type FakeWorkletChannelOptions,
    type FakeWorkletProcessor
} from '../helpers/fakeWorkletProcessor';
import { readLibraryAssetSource } from '../helpers/libraryAssets';
import { SCRIPTED_AUDIO_DECODER_HANDLE, ScriptedAudioDecoderModule, type ScriptedAudioPacket } from '../helpers/scriptedAudioDecoderModule';

// Package attempts instantiate the scripted modules their sources carry
vi.mock('webgpu-player/decode/packages/DecoderPackageImports', async (importOriginal) => {
    const original = await importOriginal<typeof import('webgpu-player/decode/packages/DecoderPackageImports')>();
    return {
        ...original,
        instantiateDecoderPackage: async (module: WebAssembly.Module) => {
            const { instantiateScriptedAudioDecoderModule } = await import('../helpers/scriptedAudioDecoderModule');
            return instantiateScriptedAudioDecoderModule(module);
        }
    };
});

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
const PACKAGE_ROUTE_CODEC = 'truehd';
const PACKAGE_BACKEND = 'package';
const PACKAGE_CONVERT_ERROR = 'convert';
const PACKAGE_CONVERT_ERROR_CODE = 3;
// A packet's failure value, which the runtime reports with the manifest's name of its error
const PACKAGE_FAILURE_VALUE = 1;
const PACKAGE_FAILURE = `audio decoder ${PACKAGE_CONVERT_ERROR}: ${PACKAGE_FAILURE_VALUE}`;
const PACKAGE_MANIFEST = parseAudioDecoderManifest([
    '//! id: scripted',
    '//! name: Scripted',
    '//! decoder: audio',
    `//! accepts: codec in [${PACKAGE_ROUTE_CODEC}]`,
    `//! error: ${PACKAGE_CONVERT_ERROR_CODE}, ${PACKAGE_CONVERT_ERROR}`
].join('\n'));
// A package that renders object audio: it takes the output layout's mask and binaural rendering, and reports the objects it renders per block
const OBJECT_PACKAGE_MANIFEST = parseAudioDecoderManifest([
    '//! id: scripted-objects',
    '//! name: Scripted objects',
    '//! decoder: audio',
    `//! accepts: codec in [${PACKAGE_ROUTE_CODEC}]`,
    '//! option: 1, renderChannelMask',
    '//! option: 2, renderBinaural',
    '//! attribute: 1, objectCount'
].join('\n'));
const SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_COUNT = 12;
// The objects the scripted package reports rendering from the second half of its packets on
const RENDERED_OBJECT_COUNT = 11;
// The batches an attempt renders before a live binaural switch
const BATCHES_BEFORE_BINAURAL_SWITCH = 2;
// A WMA track's WAVEFORMATEX, which a package attempt's decoder configures with before its first packet
const PACKAGE_CODEC_PRIVATE = Uint8Array.of(0x61, 0x01, 0x02, 0x00, 0x44, 0xAC, 0x00, 0x00, 0x40, 0x1F, 0x00, 0x00, 0x73, 0x01, 0x10, 0x00, 0x00, 0x00);
const PACKAGE_CONFIGURE_FAILURE_VALUE = 0x161;
const PACKAGE_CONFIGURE_FAILURE = `audio decoder ${PACKAGE_CONVERT_ERROR}: ${PACKAGE_CONFIGURE_FAILURE_VALUE}`;
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
    // The served output stage, which every runtime of this file reuses
    await loadAudioOutputStageModule(await readLibraryAssetSource(AUDIO_OUTPUT_STAGE_WASM_ASSET));
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
        channelMask: null,
        decoderBackend: 'pcm',
        outputLayout: 'stereo',
        packageCodecPrivate: null,
        packageDecoder: null,
        renderBinaural: false,
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

/** A scripted package whose every packet decodes to the tone sample of its position, as one stereo block at the sample's time. */
function createTonePackage(): ScriptedAudioDecoderModule {
    const packets: ScriptedAudioPacket[] = [];
    for (let sampleIndex = 0; sampleIndex < SAMPLES_PER_BATCH * BATCH_COUNT; sampleIndex += 1) {
        const sample = createToneSample(sampleIndex);
        packets.push({
            blocks: [ {
                channelData: sample.channelData.map((plane: Float32Array): number[] => Array.from(plane)),
                channelMask: CUSTOM_WAVE_CHANNEL_MASK_STEREO,
                sampleRate: sample.sampleRate,
                timestampMicroseconds: sample.mediaTimeMicroseconds
            } ],
            kind: 'decoded'
        });
    }
    return new ScriptedAudioDecoderModule({ manifest: PACKAGE_MANIFEST, packets });
}

/**
 * A scripted object audio package whose every packet decodes to the tone sample of its position in one layout,
 * reporting no objects for the first half of its packets and RENDERED_OBJECT_COUNT after.
 */
function createObjectPackage(channelMask: number, channelCount: number): ScriptedAudioDecoderModule {
    const packets: ScriptedAudioPacket[] = [];
    const packetCount = SAMPLES_PER_BATCH * BATCH_COUNT;
    for (let sampleIndex = 0; sampleIndex < packetCount; sampleIndex += 1) {
        const sample = createToneSample(sampleIndex, channelCount);
        packets.push({
            blocks: [ {
                attributes: { objectCount: sampleIndex < packetCount / 2 ? 0 : RENDERED_OBJECT_COUNT },
                channelData: sample.channelData.map((plane: Float32Array): number[] => Array.from(plane)),
                channelMask,
                sampleRate: sample.sampleRate,
                timestampMicroseconds: sample.mediaTimeMicroseconds
            } ],
            kind: 'decoded'
        });
    }
    return new ScriptedAudioDecoderModule({ manifest: OBJECT_PACKAGE_MANIFEST, packets });
}

function getObjectCounts(channel: RuntimeChannel): number[] {
    return channel.responses.flatMap(response => (response.type === 'object-count' ? [ response.objectCount ] : []));
}

/** Batches one packet per tone sample at the sample's time, as the decode worker batches a track's packets. */
function createTonePacketBatches(): AudioDecodeWorkerPacketBatch[] {
    const batches: AudioDecodeWorkerPacketBatch[] = [];
    for (let batchIndex = 0; batchIndex < BATCH_COUNT; batchIndex += 1) {
        const packetTimestampsMicroseconds: Microseconds[] = [];
        for (let sampleOffset = 0; sampleOffset < SAMPLES_PER_BATCH; sampleOffset += 1) {
            packetTimestampsMicroseconds.push((((batchIndex * SAMPLES_PER_BATCH) + sampleOffset) * SAMPLE_DURATION_MICROSECONDS) as Microseconds);
        }
        batches.push({
            data: new ArrayBuffer(PACKET_BYTE_LENGTH * SAMPLES_PER_BATCH),
            kind: 'packets',
            packetByteLengths: packetTimestampsMicroseconds.map((): number => PACKET_BYTE_LENGTH),
            packetTimestampsMicroseconds
        });
    }
    return batches;
}

/** Runs an attempt on a runtime of its own until it finishes, fed the batches, with the decoder the overrides choose. */
async function runAttempt(
    batches: readonly AudioDecodeWorkerInputBatch[],
    overrides: Partial<AudioDecodeWorkerOpenAttemptRequest>
): Promise<{ channel: RuntimeChannel; processor: FakeWorkletProcessor }> {
    const channel = openRuntime();
    const { attachment, processor } = openWorklet();
    channel.send(createOpenRequest({ audioOutput: attachment, ...overrides }), [ attachment.port ]);

    await sendBatchesOnCredits(channel, batches);
    channel.send({ ...ATTEMPT_KEY, type: 'finish-attempt' });
    await waitForResponse(channel, { ...ATTEMPT_KEY, type: 'attempt-finished' });
    return { channel, processor };
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

    it('decodes a package attempt with the host\'s package, which renders what the same samples render as PCM', async () => {
        const tonePackage = createTonePackage();

        const decodedPCM = await runAttempt(createToneBatches(BATCH_COUNT), {});
        const packaged = await runAttempt(createTonePacketBatches(), {
            decoderBackend: PACKAGE_BACKEND,
            packageDecoder: { codec: PACKAGE_ROUTE_CODEC, source: tonePackage.source },
            routeCodec: PACKAGE_ROUTE_CODEC
        });

        expect(getFailures(packaged.channel)).toEqual([]);
        await vi.waitFor(() => {
            expect(decodedPCM.processor.receivedFrameCount).toBe(TOTAL_FRAME_COUNT);
            expect(packaged.processor.receivedFrameCount).toBe(TOTAL_FRAME_COUNT);
        }, WAIT_OPTIONS);
        expect(tonePackage.sentPackets.map(packet => packet.timestampMicroseconds))
            .toEqual(createTonePacketBatches().flatMap(batch => batch.packetTimestampsMicroseconds));
        expect(packaged.channel.responses.filter(response => response.type === 'source-format')).toEqual([
            { ...ATTEMPT_KEY, channelCount: STEREO_CHANNEL_COUNT, sampleRate: SAMPLE_RATE, type: 'source-format' }
        ]);
        expect(getProgress(packaged.channel)).toEqual(getProgress(decodedPCM.channel));
        expect(packaged.processor.chunks.map(chunk => chunk.channelData)).toEqual(decodedPCM.processor.chunks.map(chunk => chunk.channelData));
    });

    it('sets an object audio package\'s render options before its first packet, takes a live binaural switch between packets, and reports its objects', async () => {
        const objectPackage = createObjectPackage(CUSTOM_WAVE_CHANNEL_MASK_STEREO, STEREO_CHANNEL_COUNT);
        const channel = openRuntime();
        const { attachment, processor } = openWorklet();
        channel.send(createOpenRequest({
            audioOutput: attachment,
            decoderBackend: PACKAGE_BACKEND,
            packageDecoder: { codec: PACKAGE_ROUTE_CODEC, source: objectPackage.source },
            routeCodec: PACKAGE_ROUTE_CODEC
        }), [ attachment.port ]);
        const batches = createTonePacketBatches();

        await sendBatchesOnCredits(channel, batches.slice(0, BATCHES_BEFORE_BINAURAL_SWITCH));
        await vi.waitFor(() => {
            expect(getReturnedInputCredits(channel)).toBe(BATCHES_BEFORE_BINAURAL_SWITCH);
        }, WAIT_OPTIONS);
        channel.send({ binauralHeadphones: true, generation: GENERATION, type: 'update-binaural' });
        // Another run's switch never reaches this attempt
        channel.send({ binauralHeadphones: false, generation: GENERATION + 1, type: 'update-binaural' });
        for (const batch of batches.slice(BATCHES_BEFORE_BINAURAL_SWITCH)) {
            await vi.waitFor(() => {
                expect(AUDIO_DECODE_WORKER_INPUT_CREDITS + getReturnedInputCredits(channel)).toBeGreaterThan(batches.indexOf(batch));
            }, WAIT_OPTIONS);
            sendBatch(channel, batch);
        }
        channel.send({ ...ATTEMPT_KEY, type: 'finish-attempt' });
        await waitForResponse(channel, { ...ATTEMPT_KEY, type: 'attempt-finished' });

        expect(getFailures(channel)).toEqual([]);
        const packetsBeforeSwitch = BATCHES_BEFORE_BINAURAL_SWITCH * SAMPLES_PER_BATCH;
        expect(objectPackage.options).toEqual([
            { name: 'renderChannelMask', sentPacketCount: 0, value: CUSTOM_WAVE_CHANNEL_MASK_STEREO },
            { name: 'renderBinaural', sentPacketCount: 0, value: 0 },
            { name: 'renderBinaural', sentPacketCount: packetsBeforeSwitch, value: 1 }
        ]);
        expect(getObjectCounts(channel)).toEqual([ 0, RENDERED_OBJECT_COUNT ]);
        await vi.waitFor(() => {
            expect(processor.receivedFrameCount).toBe(TOTAL_FRAME_COUNT);
        }, WAIT_OPTIONS);
    });

    it('sets no render option on a package that declares none, and reports no objects', async () => {
        const tonePackage = createTonePackage();

        const packaged = await runAttempt(createTonePacketBatches(), {
            decoderBackend: PACKAGE_BACKEND,
            packageDecoder: { codec: PACKAGE_ROUTE_CODEC, source: tonePackage.source },
            routeCodec: PACKAGE_ROUTE_CODEC
        });

        expect(getFailures(packaged.channel)).toEqual([]);
        expect(tonePackage.options).toEqual([]);
        expect(getObjectCounts(packaged.channel)).toEqual([]);
    });

    it('plays a package\'s 7.1.4 render to a 7.1.4 worklet channel for channel, with the 7.1.4 mask set before its first packet', async () => {
        const objectPackage = createObjectPackage(CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR, SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_COUNT);
        const channel = openRuntime();
        const { attachment, processor } = openWorklet({ channelCount: SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_COUNT });
        channel.send(createOpenRequest({
            audioOutput: attachment,
            decoderBackend: PACKAGE_BACKEND,
            outputLayout: '7.1.4',
            packageDecoder: { codec: PACKAGE_ROUTE_CODEC, source: objectPackage.source },
            routeCodec: PACKAGE_ROUTE_CODEC
        }), [ attachment.port ]);

        await sendBatchesOnCredits(channel, createTonePacketBatches());
        channel.send({ ...ATTEMPT_KEY, type: 'finish-attempt' });
        await waitForResponse(channel, { ...ATTEMPT_KEY, type: 'attempt-finished' });

        expect(getFailures(channel)).toEqual([]);
        expect(objectPackage.options).toEqual([
            { name: 'renderChannelMask', sentPacketCount: 0, value: CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR },
            { name: 'renderBinaural', sentPacketCount: 0, value: 0 }
        ]);
        expect(channel.responses.filter(response => response.type === 'source-format')).toEqual([
            { ...ATTEMPT_KEY, channelCount: SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_COUNT, sampleRate: SAMPLE_RATE, type: 'source-format' }
        ]);
        await vi.waitFor(() => {
            expect(processor.receivedFrameCount).toBe(TOTAL_FRAME_COUNT);
        }, WAIT_OPTIONS);
        // Each of the twelve speakers plays its own decoded channel, unmixed and unlimited
        const [ firstChunk ] = processor.chunks;
        expect(firstChunk.channelData).toHaveLength(SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_COUNT);
        for (let channelIndex = 0; channelIndex < SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_COUNT; channelIndex += 1) {
            const expected = createToneSample(0, SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_COUNT).channelData[channelIndex].subarray(0, COMPARED_FRAME_COUNT);
            expect(firstChunk.channelData[channelIndex].subarray(0, COMPARED_FRAME_COUNT), `channel ${channelIndex}`).toEqual(expected);
        }
    });

    it('folds a package\'s 7.1.4 render into a 7.1 worklet channel', async () => {
        const objectPackage = createObjectPackage(CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR, SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_COUNT);
        const sevenPointOneChannelCount = 8;
        const channel = openRuntime();
        const { attachment, processor } = openWorklet({ channelCount: sevenPointOneChannelCount });
        channel.send(createOpenRequest({
            audioOutput: attachment,
            decoderBackend: PACKAGE_BACKEND,
            outputLayout: '7.1',
            packageDecoder: { codec: PACKAGE_ROUTE_CODEC, source: objectPackage.source },
            routeCodec: PACKAGE_ROUTE_CODEC
        }), [ attachment.port ]);

        await sendBatchesOnCredits(channel, createTonePacketBatches());
        channel.send({ ...ATTEMPT_KEY, type: 'finish-attempt' });
        await waitForResponse(channel, { ...ATTEMPT_KEY, type: 'attempt-finished' });

        expect(getFailures(channel)).toEqual([]);
        await vi.waitFor(() => {
            expect(processor.receivedFrameCount).toBe(TOTAL_FRAME_COUNT);
        }, WAIT_OPTIONS);
        expect(processor.chunks.every(chunk => chunk.channelData.length === sevenPointOneChannelCount)).toBe(true);
        // The side channels have no height above them and pass through
        const sample = createToneSample(0, SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_COUNT);
        const [ firstChunk ] = processor.chunks;
        expect(firstChunk.channelData[6].subarray(0, COMPARED_FRAME_COUNT)).toEqual(sample.channelData[6].subarray(0, COMPARED_FRAME_COUNT));
    });

    it('fails a package attempt with its package\'s named error when a packet fails to decode', async () => {
        const failingPackage = new ScriptedAudioDecoderModule({
            manifest: PACKAGE_MANIFEST,
            packets: [ {
                failure: { code: getAudioDecoderErrorCode(PACKAGE_MANIFEST, PACKAGE_CONVERT_ERROR), value: PACKAGE_FAILURE_VALUE },
                kind: 'failed'
            } ]
        });
        const channel = openRuntime();
        const { attachment } = openWorklet();
        channel.send(createOpenRequest({
            audioOutput: attachment,
            decoderBackend: PACKAGE_BACKEND,
            packageDecoder: { codec: PACKAGE_ROUTE_CODEC, source: failingPackage.source },
            routeCodec: PACKAGE_ROUTE_CODEC
        }), [ attachment.port ]);

        sendBatch(channel, {
            data: new ArrayBuffer(PACKET_BYTE_LENGTH),
            kind: 'packets',
            packetByteLengths: [ PACKET_BYTE_LENGTH ],
            packetTimestampsMicroseconds: [ START_TIME_MICROSECONDS ]
        });

        await waitForResponse(channel, {
            ...ATTEMPT_KEY,
            failureKind: 'decode-failed',
            message: PACKAGE_FAILURE,
            type: 'attempt-failed'
        });
    });

    it('configures each package attempt\'s decoder once with the track\'s codec private data, before its first packet', async () => {
        const tonePackage = createTonePackage();
        const packageAttempt: Partial<AudioDecodeWorkerOpenAttemptRequest> = {
            decoderBackend: PACKAGE_BACKEND,
            packageCodecPrivate: PACKAGE_CODEC_PRIVATE,
            packageDecoder: { codec: PACKAGE_ROUTE_CODEC, source: tonePackage.source },
            routeCodec: PACKAGE_ROUTE_CODEC
        };

        const first = await runAttempt(createTonePacketBatches(), packageAttempt);
        const firstAttemptPacketCount = tonePackage.sentPackets.length;
        const second = await runAttempt(createTonePacketBatches(), packageAttempt);

        expect([ ...getFailures(first.channel), ...getFailures(second.channel) ]).toEqual([]);
        expect(tonePackage.configurations).toEqual([
            { bytes: PACKAGE_CODEC_PRIVATE, sentPacketCount: 0 },
            { bytes: PACKAGE_CODEC_PRIVATE, sentPacketCount: firstAttemptPacketCount }
        ]);
    });

    it('configures no package decoder of a track without codec private data', async () => {
        const tonePackage = createTonePackage();

        const packaged = await runAttempt(createTonePacketBatches(), {
            decoderBackend: PACKAGE_BACKEND,
            packageDecoder: { codec: PACKAGE_ROUTE_CODEC, source: tonePackage.source },
            routeCodec: PACKAGE_ROUTE_CODEC
        });

        expect(getFailures(packaged.channel)).toEqual([]);
        expect(tonePackage.configurations).toEqual([]);
    });

    it('fails a package attempt with its package\'s named error when its codec private data fails to configure, and sends it no packet', async () => {
        const refusingPackage = new ScriptedAudioDecoderModule({
            configureFailure: { code: getAudioDecoderErrorCode(PACKAGE_MANIFEST, PACKAGE_CONVERT_ERROR), value: PACKAGE_CONFIGURE_FAILURE_VALUE },
            manifest: PACKAGE_MANIFEST,
            packets: [ { blocks: [], kind: 'decoded' } ]
        });
        const channel = openRuntime();
        const { attachment } = openWorklet();
        channel.send(createOpenRequest({
            audioOutput: attachment,
            decoderBackend: PACKAGE_BACKEND,
            packageCodecPrivate: PACKAGE_CODEC_PRIVATE,
            packageDecoder: { codec: PACKAGE_ROUTE_CODEC, source: refusingPackage.source },
            routeCodec: PACKAGE_ROUTE_CODEC
        }), [ attachment.port ]);

        await waitForResponse(channel, {
            ...ATTEMPT_KEY,
            failureKind: 'decode-failed',
            message: PACKAGE_CONFIGURE_FAILURE,
            type: 'attempt-failed'
        });
        expect(refusingPackage.sentPackets).toEqual([]);
        expect(refusingPackage.destroyedHandles).toEqual([ SCRIPTED_AUDIO_DECODER_HANDLE ]);
    });

    it('drains a package decoder once at the end of its track, and renders the frames it held back after its packets\' frames', async () => {
        const silentBlock = {
            channelData: [ new Array<number>(SAMPLE_FRAME_COUNT).fill(0), new Array<number>(SAMPLE_FRAME_COUNT).fill(0) ],
            channelMask: CUSTOM_WAVE_CHANNEL_MASK_STEREO,
            sampleRate: SAMPLE_RATE
        };
        const drainingPackage = new ScriptedAudioDecoderModule({
            drainedBlocks: [ silentBlock ],
            manifest: PACKAGE_MANIFEST,
            packets: [ { blocks: [ { ...silentBlock, timestampMicroseconds: START_TIME_MICROSECONDS } ], kind: 'decoded' } ]
        });

        const packaged = await runAttempt([ {
            data: new ArrayBuffer(PACKET_BYTE_LENGTH),
            kind: 'packets',
            packetByteLengths: [ PACKET_BYTE_LENGTH ],
            packetTimestampsMicroseconds: [ START_TIME_MICROSECONDS ]
        } ], {
            decoderBackend: PACKAGE_BACKEND,
            packageDecoder: { codec: PACKAGE_ROUTE_CODEC, source: drainingPackage.source },
            routeCodec: PACKAGE_ROUTE_CODEC
        });

        expect(getFailures(packaged.channel)).toEqual([]);
        expect(drainingPackage.drainCount).toBe(1);
        await vi.waitFor(() => {
            expect(packaged.processor.receivedFrameCount).toBe(2 * SAMPLE_FRAME_COUNT);
        }, WAIT_OPTIONS);
    });

    it('starts drained frames without a timestamp at the last packet\'s time when no packet output any, as after a seek onto a track\'s last packet', async () => {
        const drainingPackage = new ScriptedAudioDecoderModule({
            drainedBlocks: [ {
                channelData: [ new Array<number>(SAMPLE_FRAME_COUNT).fill(0), new Array<number>(SAMPLE_FRAME_COUNT).fill(0) ],
                channelMask: CUSTOM_WAVE_CHANNEL_MASK_STEREO,
                sampleRate: SAMPLE_RATE
            } ],
            manifest: PACKAGE_MANIFEST,
            packets: [ { blocks: [], kind: 'decoded' } ]
        });

        const packaged = await runAttempt([ {
            data: new ArrayBuffer(PACKET_BYTE_LENGTH),
            kind: 'packets',
            packetByteLengths: [ PACKET_BYTE_LENGTH ],
            packetTimestampsMicroseconds: [ START_TIME_MICROSECONDS ]
        } ], {
            decoderBackend: PACKAGE_BACKEND,
            packageDecoder: { codec: PACKAGE_ROUTE_CODEC, source: drainingPackage.source },
            routeCodec: PACKAGE_ROUTE_CODEC
        });

        expect(getFailures(packaged.channel)).toEqual([]);
        await vi.waitFor(() => {
            expect(packaged.processor.receivedFrameCount).toBe(SAMPLE_FRAME_COUNT);
        }, WAIT_OPTIONS);
        expect(getProgress(packaged.channel)[0]).toMatchObject({ mediaTimeMicroseconds: START_TIME_MICROSECONDS });
    });
});
