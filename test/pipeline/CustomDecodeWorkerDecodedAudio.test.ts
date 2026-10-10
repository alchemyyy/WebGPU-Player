// @vitest-environment node

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUDIO_OUTPUT_STAGE_WASM_ASSET } from 'webgpu-player/EngineAssets';
import {
    isDecodeWorkerResponse,
    type DecodeWorkerAudioOutputAttachment,
    type DecodeWorkerResponse,
    type DecodeWorkerStartRequest
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';

import {
    createDecodedAudioMedia,
    DECODED_AUDIO_MEDIA_CHANNEL_COUNT,
    DECODED_AUDIO_MEDIA_CODEC,
    DECODED_AUDIO_MEDIA_FILE_NAME,
    DECODED_AUDIO_MEDIA_FRAME_COUNT,
    DECODED_AUDIO_MEDIA_SAMPLE_RATE,
    getDecodedAudioMediaSample
} from '../helpers/decodedAudioMedia';
import {
    createWorkerStartRequest,
    startDecodeWorker,
    type FakeWorkerScope
} from '../helpers/decodeWorkerHarness';
import {
    openFakeWorkletChannel,
    type FakeWorkletChannelOptions,
    type FakeWorkletProcessor
} from '../helpers/fakeWorkletProcessor';
import { InProcessAudioDecodeWorker } from '../helpers/inProcessAudioDecodeWorker';
import { readDecoderWASMSource } from '../helpers/libraryAssets';

type AudioProgressResponse = Extract<DecodeWorkerResponse, { type: 'audio-progress' }>;

const GENERATION = 31;
const OTHER_GENERATION = 32;
const NEXT_GENERATION = 33;
// The playback worker's sibling under the asset base, as it resolves the URL from its own
const AUDIO_DECODE_WORKER_URL = 'https://example.test/web/libraries/webgpu-player/CustomAudioDecode.worker.js';
const LOST_WORKER_MESSAGE = 'Script failed to load';
const LOST_WORKER_FAILURE = `The audio decode worker failed: ${LOST_WORKER_MESSAGE}`;
const INITIAL_AUDIO_EPOCH = 0;
const RESYNC_AUDIO_EPOCH = 1;
const UNISSUED_AUDIO_EPOCH = 5;
const AUDIO_SAMPLE_CREDITS = 4;
const HELD_AUDIO_SAMPLE_CREDITS = 2;
const RESYNC_AUDIO_SAMPLE_CREDITS = 3;
const WORKLET_GENERATION = 2;
const RESYNC_WORKLET_GENERATION = 3;
// The resync changes the layout to 5.1, which carries the stereo source in its front pair
const RESYNC_OUTPUT_CHANNEL_COUNT = 6;
const RESYNC_TARGET_MICROSECONDS = 500_000;
const MICROSECONDS_PER_SECOND = 1_000_000;
// The tone starts at zero seconds, so a resync to half a second keeps the second half of its frames
const RESYNC_FRAME_COUNT = DECODED_AUDIO_MEDIA_FRAME_COUNT
    - ((RESYNC_TARGET_MICROSECONDS * DECODED_AUDIO_MEDIA_SAMPLE_RATE) / MICROSECONDS_PER_SECOND);
// The frames whose samples the first chunk must carry unchanged
const COMPARED_FRAME_COUNT = 64;
// Long enough for the worker to post more, were it not waiting
const SETTLE_MILLISECONDS = 50;
const DROPPED_SAMPLE_FAILURE = 'The audio worklet dropped a decoded sample';

let mediaFiles: Map<string, Uint8Array>;
const openedProcessors: FakeWorkletProcessor[] = [];

beforeAll(async () => {
    mediaFiles = new Map([ [ DECODED_AUDIO_MEDIA_FILE_NAME, await createDecodedAudioMedia() ] ]);
});

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    for (const processor of openedProcessors.splice(0)) {
        processor.close();
    }
    vi.unstubAllGlobals();
});

function createDecodedAudioStartRequest(generation = GENERATION): DecodeWorkerStartRequest {
    return createWorkerStartRequest(DECODED_AUDIO_MEDIA_FILE_NAME, {
        audioTrackIndex: 0,
        decodedAudioOutputChannelCount: DECODED_AUDIO_MEDIA_CHANNEL_COUNT,
        generation
    });
}

/** Loads the worker with the WebAssembly output stage the asset build serves, as its first output stage would fetch it. */
async function startWorker(): Promise<FakeWorkerScope> {
    const workerScope = await startDecodeWorker(mediaFiles);
    // The module instance the worker imported, since both load after the same reset
    const { loadAudioOutputStageModule } = await import('webgpu-player/audio/processing/AudioOutputStageModule');
    await loadAudioOutputStageModule(await readDecoderWASMSource(AUDIO_OUTPUT_STAGE_WASM_ASSET));
    return workerScope;
}

/** Starts the decoded audio run and waits for its readiness, which the page's output follows. */
async function startRun(workerScope: FakeWorkerScope, generation = GENERATION): Promise<DecodeWorkerResponse> {
    workerScope.dispatchRequest(createDecodedAudioStartRequest(generation));
    return workerScope.waitForResponse(response => response.type === 'ready' && response.generation === generation);
}

function openChannel(options: FakeWorkletChannelOptions): {
    attachment: DecodeWorkerAudioOutputAttachment
    processor: FakeWorkletProcessor
} {
    const channel = openFakeWorkletChannel(options);
    openedProcessors.push(channel.processor);
    return channel;
}

function attachAudioOutput(
    workerScope: FakeWorkerScope,
    audioOutput: DecodeWorkerAudioOutputAttachment,
    audioEpoch = INITIAL_AUDIO_EPOCH,
    generation = GENERATION
): void {
    workerScope.dispatchRequest({ audioEpoch, audioOutput, generation, type: 'attach-audio-output' });
}

function getAudioProgress(responses: readonly DecodeWorkerResponse[], audioEpoch: number): AudioProgressResponse[] {
    return responses.filter((response): response is AudioProgressResponse => (
        response.type === 'audio-progress' && response.audioEpoch === audioEpoch
    ));
}

function waitForSettled(): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, SETTLE_MILLISECONDS);
    });
}

/** Waits until the worklet holds a frame count, and requires that no more follow. */
async function waitForFrames(processor: FakeWorkletProcessor, frameCount: number): Promise<void> {
    await vi.waitFor(() => {
        expect(processor.receivedFrameCount).toBeGreaterThanOrEqual(frameCount);
    });
    await waitForSettled();
    expect(processor.receivedFrameCount).toBe(frameCount);
}

describe('the playback worker feeding the AudioWorklet directly', () => {
    it('posts decoded PCM straight to the worklet and only its progress to the page', async () => {
        const workerScope = await startWorker();
        const readyResponse = await startRun(workerScope);
        expect(readyResponse).toMatchObject({
            audio: {
                channelCount: DECODED_AUDIO_MEDIA_CHANNEL_COUNT,
                codec: DECODED_AUDIO_MEDIA_CODEC,
                sampleRate: DECODED_AUDIO_MEDIA_SAMPLE_RATE
            }
        });
        const { attachment, processor } = openChannel({
            audioSampleCredits: AUDIO_SAMPLE_CREDITS,
            channelCount: DECODED_AUDIO_MEDIA_CHANNEL_COUNT,
            workletGeneration: WORKLET_GENERATION
        });

        attachAudioOutput(workerScope, attachment);
        await workerScope.waitForStopped(GENERATION);

        const responses = workerScope.responses;
        expect(responses.filter(response => !isDecodeWorkerResponse(response))).toEqual([]);
        expect(responses.map(response => response.type)).not.toContain('error');
        expect(responses).toContainEqual({ audioEpoch: INITIAL_AUDIO_EPOCH, generation: GENERATION, type: 'audio-ended' });
        expect(responses.slice(-2).map(response => response.type)).toEqual([ 'ended', 'stopped' ]);

        // Every chunk reached the worklet in order, for the worklet generation it was attached for; the channel delivers the last ones after the run stopped
        await waitForFrames(processor, DECODED_AUDIO_MEDIA_FRAME_COUNT);
        expect(processor.chunks.map(chunk => chunk.sequence)).toEqual(processor.chunks.map((_chunk, chunkIndex) => chunkIndex + 1));
        expect(processor.chunks.every(chunk => chunk.generation === WORKLET_GENERATION)).toBe(true);
        const firstChunk = processor.chunks[0];
        for (let frameIndex = 0; frameIndex < COMPARED_FRAME_COUNT; frameIndex += 1) {
            for (let channelIndex = 0; channelIndex < DECODED_AUDIO_MEDIA_CHANNEL_COUNT; channelIndex += 1) {
                expect(firstChunk.channelData[channelIndex][frameIndex]).toBe(getDecodedAudioMediaSample(frameIndex, channelIndex));
            }
        }

        // The page learns each chunk's place and length, never its PCM
        const progress = getAudioProgress(responses, INITIAL_AUDIO_EPOCH);
        expect(progress.map(({ frameCount, mediaTimeMicroseconds, sampleRate }) => ({ frameCount, mediaTimeMicroseconds, sampleRate })))
            .toEqual(processor.chunks.map(chunk => ({
                frameCount: chunk.channelData[0].length,
                mediaTimeMicroseconds: chunk.timestampMicroseconds,
                sampleRate: DECODED_AUDIO_MEDIA_SAMPLE_RATE
            })));
        expect(progress.some(response => 'channelData' in response)).toBe(false);
        // The finished run closes its end, and the worklet plays out what it holds
        await vi.waitFor(() => {
            expect(processor.closed).toBe(true);
        });
    });

    it('holds decoded audio at the worklet credit window until the worklet plays a chunk', async () => {
        const workerScope = await startWorker();
        await startRun(workerScope);
        const { attachment, processor } = openChannel({
            audioSampleCredits: HELD_AUDIO_SAMPLE_CREDITS,
            channelCount: DECODED_AUDIO_MEDIA_CHANNEL_COUNT,
            holdReleases: true,
            workletGeneration: WORKLET_GENERATION
        });

        attachAudioOutput(workerScope, attachment);
        await vi.waitFor(() => {
            expect(processor.chunks).toHaveLength(HELD_AUDIO_SAMPLE_CREDITS);
        });
        await waitForSettled();
        expect(processor.chunks).toHaveLength(HELD_AUDIO_SAMPLE_CREDITS);

        processor.releaseHeld(1);
        await vi.waitFor(() => {
            expect(processor.chunks).toHaveLength(HELD_AUDIO_SAMPLE_CREDITS + 1);
        });
        await waitForSettled();
        expect(processor.chunks).toHaveLength(HELD_AUDIO_SAMPLE_CREDITS + 1);
        expect(getAudioProgress(workerScope.responses, INITIAL_AUDIO_EPOCH)).toHaveLength(HELD_AUDIO_SAMPLE_CREDITS + 1);

        // A stopped run closes its producer without reporting the chunks the worklet still holds
        workerScope.dispatchRequest({ generation: GENERATION, type: 'stop' });
        await workerScope.waitForStopped(GENERATION);
        expect(workerScope.responses.map(response => response.type)).not.toContain('error');
        await vi.waitFor(() => {
            expect(processor.closed).toBe(true);
        });
    });

    it('restarts decoded audio in a new layout on the new worklet channel a resync carries, and closes the replaced one', async () => {
        const workerScope = await startWorker();
        await startRun(workerScope);
        const initialChannel = openChannel({
            audioSampleCredits: HELD_AUDIO_SAMPLE_CREDITS,
            channelCount: DECODED_AUDIO_MEDIA_CHANNEL_COUNT,
            holdReleases: true,
            workletGeneration: WORKLET_GENERATION
        });
        attachAudioOutput(workerScope, initialChannel.attachment);
        await vi.waitFor(() => {
            expect(initialChannel.processor.chunks).toHaveLength(HELD_AUDIO_SAMPLE_CREDITS);
        });
        const resyncedChannel = openChannel({
            audioSampleCredits: RESYNC_AUDIO_SAMPLE_CREDITS,
            channelCount: RESYNC_OUTPUT_CHANNEL_COUNT,
            workletGeneration: RESYNC_WORKLET_GENERATION
        });

        workerScope.dispatchRequest({
            audioEpoch: RESYNC_AUDIO_EPOCH,
            audioOutput: resyncedChannel.attachment,
            decodedAudioOutputChannelCount: RESYNC_OUTPUT_CHANNEL_COUNT,
            generation: GENERATION,
            targetTimeMicroseconds: RESYNC_TARGET_MICROSECONDS,
            type: 'resync-audio'
        });
        await workerScope.waitForStopped(GENERATION);

        await vi.waitFor(() => {
            expect(initialChannel.processor.closed).toBe(true);
        });
        expect(initialChannel.processor.chunks).toHaveLength(HELD_AUDIO_SAMPLE_CREDITS);
        const resyncedChunks = resyncedChannel.processor.chunks;
        expect(resyncedChunks.every(chunk => (
            chunk.generation === RESYNC_WORKLET_GENERATION && chunk.channelData.length === RESYNC_OUTPUT_CHANNEL_COUNT
        ))).toBe(true);
        // The new attempt starts its sequences, its timeline, and its frames afresh at the target
        await waitForFrames(resyncedChannel.processor, RESYNC_FRAME_COUNT);
        expect(resyncedChunks[0]).toMatchObject({ sequence: 1, timestampMicroseconds: RESYNC_TARGET_MICROSECONDS });
        expect(getAudioProgress(workerScope.responses, INITIAL_AUDIO_EPOCH)).toHaveLength(HELD_AUDIO_SAMPLE_CREDITS);
        expect(getAudioProgress(workerScope.responses, RESYNC_AUDIO_EPOCH)).toHaveLength(resyncedChunks.length);
        expect(workerScope.responses).toContainEqual({ audioEpoch: RESYNC_AUDIO_EPOCH, generation: GENERATION, type: 'audio-ended' });
        expect(workerScope.responses.map(response => response.type)).not.toContain('error');
    });

    it('fails the run as an audio output failure when the worklet drops a chunk', async () => {
        const workerScope = await startWorker();
        await startRun(workerScope);
        const { attachment, processor } = openChannel({
            audioSampleCredits: AUDIO_SAMPLE_CREDITS,
            channelCount: DECODED_AUDIO_MEDIA_CHANNEL_COUNT,
            workletGeneration: WORKLET_GENERATION
        });
        processor.dropNext('overflow');

        attachAudioOutput(workerScope, attachment);

        await expect(workerScope.waitForResponse(response => response.type === 'error')).resolves.toEqual({
            failureKind: 'audio-output-failed',
            generation: GENERATION,
            message: DROPPED_SAMPLE_FAILURE,
            type: 'error'
        });
        await workerScope.waitForStopped(GENERATION);
    });

    it('closes a worklet channel that no attempt of the run will open', async () => {
        const workerScope = await startWorker();
        await startRun(workerScope);
        const unissuedEpochChannel = openChannel({
            audioSampleCredits: AUDIO_SAMPLE_CREDITS,
            channelCount: DECODED_AUDIO_MEDIA_CHANNEL_COUNT,
            workletGeneration: WORKLET_GENERATION
        });
        const otherGenerationChannel = openChannel({
            audioSampleCredits: AUDIO_SAMPLE_CREDITS,
            channelCount: DECODED_AUDIO_MEDIA_CHANNEL_COUNT,
            workletGeneration: WORKLET_GENERATION
        });

        attachAudioOutput(workerScope, unissuedEpochChannel.attachment, UNISSUED_AUDIO_EPOCH);
        attachAudioOutput(workerScope, otherGenerationChannel.attachment, INITIAL_AUDIO_EPOCH, OTHER_GENERATION);

        await vi.waitFor(() => {
            expect(unissuedEpochChannel.processor.closed).toBe(true);
            expect(otherGenerationChannel.processor.closed).toBe(true);
        });
        // The run still waits for its own channel, then plays to its end
        expect(getAudioProgress(workerScope.responses, INITIAL_AUDIO_EPOCH)).toEqual([]);
        const { attachment, processor } = openChannel({
            audioSampleCredits: AUDIO_SAMPLE_CREDITS,
            channelCount: DECODED_AUDIO_MEDIA_CHANNEL_COUNT,
            workletGeneration: WORKLET_GENERATION
        });
        attachAudioOutput(workerScope, attachment);
        await workerScope.waitForStopped(GENERATION);
        await waitForFrames(processor, DECODED_AUDIO_MEDIA_FRAME_COUNT);
        expect(unissuedEpochChannel.processor.chunks).toEqual([]);
    });

    it('spawns one audio decode worker for its decoded PCM runs and keeps it for later runs', async () => {
        const workerScope = await startWorker();
        for (const generation of [ GENERATION, NEXT_GENERATION ]) {
            await startRun(workerScope, generation);
            const { attachment, processor } = openChannel({
                audioSampleCredits: AUDIO_SAMPLE_CREDITS,
                channelCount: DECODED_AUDIO_MEDIA_CHANNEL_COUNT,
                workletGeneration: WORKLET_GENERATION
            });
            attachAudioOutput(workerScope, attachment, INITIAL_AUDIO_EPOCH, generation);
            await expect(workerScope.waitForStopped(generation)).resolves.toEqual({ generation, type: 'stopped' });
            await waitForFrames(processor, DECODED_AUDIO_MEDIA_FRAME_COUNT);
        }

        expect(InProcessAudioDecodeWorker.instances.map(audioDecodeWorker => audioDecodeWorker.url)).toEqual([ AUDIO_DECODE_WORKER_URL ]);
        expect(workerScope.responses.map(response => response.type)).not.toContain('error');
    });

    it('fails a decoded PCM run as an audio output failure when its audio decode worker is lost, and asks for a fresh worker', async () => {
        const workerScope = await startWorker();
        await startRun(workerScope);
        const [ audioDecodeWorker ] = InProcessAudioDecodeWorker.instances;

        audioDecodeWorker.onerror?.({ message: LOST_WORKER_MESSAGE } as ErrorEvent);

        await expect(workerScope.waitForResponse(response => response.type === 'error')).resolves.toEqual({
            failureKind: 'audio-output-failed',
            generation: GENERATION,
            message: LOST_WORKER_FAILURE,
            type: 'error'
        });
        await expect(workerScope.waitForStopped(GENERATION)).resolves.toEqual({
            generation: GENERATION,
            replaceWorker: true,
            type: 'stopped'
        });
        expect(audioDecodeWorker.terminated).toBe(true);
    });
});
