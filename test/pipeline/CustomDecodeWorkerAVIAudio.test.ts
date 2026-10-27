// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUDIO_OUTPUT_STAGE_WASM_ASSET } from 'webgpu-player/EngineAssets';

import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../helpers/enginePaths';
import { createWorkerStartRequest, startDecodeWorker, type FakeWorkerScope } from '../helpers/decodeWorkerHarness';
import { openFakeWorkletChannel, type FakeWorkletProcessor } from '../helpers/fakeWorkletProcessor';
import { readLibraryAssetSource } from '../helpers/libraryAssets';

// The FFmpeg-made vectors of scripts/codec_vector_assets/generate_AVI_demux_vectors.py
const AVI_VECTOR_DIRECTORY = join(CODEC_VECTOR_ASSETS_DIRECTORY, 'avi');
const GENERATION = 41;
const WORKLET_GENERATION = 2;
// Chunks the worklet may hold unplayed, as the decoded audio tests grant
const AUDIO_SAMPLE_CREDITS = 4;
const FIVE_POINT_ONE_CHANNEL_COUNT = 6;
const SAMPLE_RATE = 48_000;
// The generator's half-second tone
const FRAME_COUNT = 24_000;
// The generator's pan gives each channel, in WAVE order, this share of the tone's level
const CHANNEL_GAINS = [ 1, 0.8, 0.6, 0.4, 0.3, 0.2 ];
const GAIN_TOLERANCE = 1e-3;
// FFmpeg's AVI muxer writes each audio chunk in the movi list as '01wb', its size, and its samples
const AUDIO_CHUNK_ID = '01wb';
const INT24_FULL_SCALE = 2 ** 23;
const PCM_S24_BYTES_PER_SAMPLE = 3;
const PCM_F32_BYTES_PER_SAMPLE = 4;

type PCMVector = Readonly<{
    bytesPerSample: number
    codec: string
    fileName: string
    readSample: (view: DataView, byteOffset: number) => number
}>;

const PCM_VECTORS: readonly PCMVector[] = [
    {
        bytesPerSample: PCM_S24_BYTES_PER_SAMPLE,
        codec: 'pcm-s24',
        fileName: 'vp9-pcm_s24le-5.1.avi',
        // FFmpeg's pcm_s24le decoder widens each sample to 32 bits, which a float scales back to the same value
        readSample: (view: DataView, byteOffset: number): number => Math.fround(
            ((view.getInt8(byteOffset + 2) * 65_536) + view.getUint16(byteOffset, true)) / INT24_FULL_SCALE
        )
    },
    {
        bytesPerSample: PCM_F32_BYTES_PER_SAMPLE,
        codec: 'pcm-f32',
        fileName: 'vp9-pcm_f32le-5.1.avi',
        readSample: (view: DataView, byteOffset: number): number => view.getFloat32(byteOffset, true)
    }
];

const openedProcessors: FakeWorkletProcessor[] = [];

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    for (const processor of openedProcessors.splice(0)) {
        processor.close();
    }
    vi.unstubAllGlobals();
});

function readAVIVector(fileName: string): Uint8Array {
    return new Uint8Array(readFileSync(join(AVI_VECTOR_DIRECTORY, fileName)));
}

/** Reads the interleaved samples of every audio chunk straight from the file's bytes, in file order. */
function readInterleavedSamples(bytes: Uint8Array, vector: PCMVector): number[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = Buffer.from(bytes).toString('latin1');
    const samples: number[] = [];
    // The idx1 index after the movi list names the chunks again, without their samples
    const indexOffset = text.lastIndexOf('idx1');
    let chunkOffset = text.indexOf(AUDIO_CHUNK_ID, text.indexOf('movi'));
    while (chunkOffset >= 0 && chunkOffset < indexOffset) {
        const chunkSize = view.getUint32(chunkOffset + 4, true);
        for (let byteOffset = chunkOffset + 8; byteOffset < chunkOffset + 8 + chunkSize; byteOffset += vector.bytesPerSample) {
            samples.push(vector.readSample(view, byteOffset));
        }
        chunkOffset = text.indexOf(AUDIO_CHUNK_ID, chunkOffset + 8 + chunkSize);
    }
    return samples;
}

async function startWorker(fileName: string): Promise<FakeWorkerScope> {
    const workerScope = await startDecodeWorker(new Map([ [ fileName, readAVIVector(fileName) ] ]));
    // The module instance the worker imported, since both load after the same reset
    const { loadAudioOutputStageModule } = await import('webgpu-player/audio/processing/AudioOutputStageModule');
    await loadAudioOutputStageModule(await readLibraryAssetSource(AUDIO_OUTPUT_STAGE_WASM_ASSET));
    return workerScope;
}

describe('the playback worker on AVI audio', () => {
    it.each(PCM_VECTORS)('decodes 5.1 $codec from WAVE_FORMAT_EXTENSIBLE in WAVE channel order', async vector => {
        const workerScope = await startWorker(vector.fileName);
        workerScope.dispatchRequest(createWorkerStartRequest(vector.fileName, {
            audioTrackIndex: 0,
            decodedAudioOutputChannelCount: FIVE_POINT_ONE_CHANNEL_COUNT,
            generation: GENERATION
        }));
        const readyResponse = await workerScope.waitForResponse(response => response.type === 'ready' && response.generation === GENERATION);
        expect(readyResponse).toMatchObject({
            audio: { channelCount: FIVE_POINT_ONE_CHANNEL_COUNT, codec: vector.codec, sampleRate: SAMPLE_RATE }
        });
        const { attachment, processor } = openFakeWorkletChannel({
            audioSampleCredits: AUDIO_SAMPLE_CREDITS,
            channelCount: FIVE_POINT_ONE_CHANNEL_COUNT,
            workletGeneration: WORKLET_GENERATION
        });
        openedProcessors.push(processor);

        workerScope.dispatchRequest({ audioEpoch: 0, audioOutput: attachment, generation: GENERATION, type: 'attach-audio-output' });
        await workerScope.waitForStopped(GENERATION);
        expect(workerScope.responses.filter(response => response.type === 'error')).toEqual([]);
        await vi.waitFor(() => {
            expect(processor.receivedFrameCount).toBe(FRAME_COUNT);
        });

        // Every decoded sample is the file's own, each in its channel
        const expected = readInterleavedSamples(readAVIVector(vector.fileName), vector);
        expect(expected).toHaveLength(FRAME_COUNT * FIVE_POINT_ONE_CHANNEL_COUNT);
        const decodedChannels = Array.from({ length: FIVE_POINT_ONE_CHANNEL_COUNT }, (_unused, channelIndex) => (
            processor.chunks.flatMap(chunk => Array.from(chunk.channelData[channelIndex]))
        ));
        const mismatches = decodedChannels.flatMap((channel, channelIndex) => channel.flatMap((sample, frameIndex) => (
            sample === expected[(frameIndex * FIVE_POINT_ONE_CHANNEL_COUNT) + channelIndex] ? [] : [ { channelIndex, frameIndex } ]
        )));
        expect(mismatches).toEqual([]);

        // The pan's falling levels show the channels kept their speakers
        const peaks = decodedChannels.map(channel => channel.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0));
        peaks.forEach((peak, channelIndex) => {
            expect(Math.abs((peak / peaks[0]) - CHANNEL_GAINS[channelIndex])).toBeLessThan(GAIN_TOLERANCE);
        });
    });
});
