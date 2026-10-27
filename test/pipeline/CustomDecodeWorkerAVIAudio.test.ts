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
const PCM_S16_BYTES_PER_SAMPLE = 2;
const INT16_FULL_SCALE = 32_768;
const STEREO_CHANNEL_COUNT = 2;
const THREE_CHANNEL_COUNT = 3;
// The generator's pan gives the front right this share of the front left's level
const FRONT_RIGHT_GAIN = 0.8;
// A split channel's gain is rounded to a float, as the output stage computes it
const ROUTING_TOLERANCE = 1e-6;
// Web Audio 5.1 output slots
const FRONT_LEFT_SLOT = 0;
const FRONT_RIGHT_SLOT = 1;
const FRONT_CENTER_SLOT = 2;
const LFE_SLOT = 3;
const SURROUND_LEFT_SLOT = 4;
const SURROUND_RIGHT_SLOT = 5;
// Front left, front center, and LFE, a three-speaker mask the output stage has no layout for
const UNQUALIFIED_THREE_CHANNEL_MASK = 0x0D;

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

const readS16Sample = (view: DataView, byteOffset: number): number => view.getInt16(byteOffset, true) / INT16_FULL_SCALE;
// FFmpeg reads these as 2.1 and 3.0(back) from their WAVE_FORMAT_EXTENSIBLE masks
const TWO_POINT_ONE_VECTOR: PCMVector = {
    bytesPerSample: PCM_S16_BYTES_PER_SAMPLE,
    codec: 'pcm-s16',
    fileName: 'vp9-pcm_s16le-2.1.avi',
    readSample: readS16Sample
};
const THREE_POINT_ZERO_BACK_VECTOR: PCMVector = {
    bytesPerSample: PCM_S16_BYTES_PER_SAMPLE,
    codec: 'pcm-s16',
    fileName: 'vp9-pcm_s16le-3.0-back.avi',
    readSample: readS16Sample
};

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

/** Rewrites the channel mask of the audio stream's WAVE_FORMAT_EXTENSIBLE header, after the strf chunk header, WAVEFORMATEX, and wValidBitsPerSample. */
function withChannelMask(bytes: Uint8Array, channelMask: number): Uint8Array {
    const formatOffset = Buffer.from(bytes).indexOf('strf', Buffer.from(bytes).indexOf('auds')) + 8;
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(formatOffset + 18 + 2, channelMask, true);
    return bytes;
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

async function startWorker(fileName: string, bytes = readAVIVector(fileName)): Promise<FakeWorkerScope> {
    const workerScope = await startDecodeWorker(new Map([ [ fileName, bytes ] ]));
    // The module instance the worker imported, since both load after the same reset
    const { loadAudioOutputStageModule } = await import('webgpu-player/audio/processing/AudioOutputStageModule');
    await loadAudioOutputStageModule(await readLibraryAssetSource(AUDIO_OUTPUT_STAGE_WASM_ASSET));
    return workerScope;
}

/** Plays a vector's audio to a fake worklet of an output layout, and returns each output channel's samples. */
async function decodeToWorklet(vector: PCMVector, outputChannelCount: 2 | 6): Promise<number[][]> {
    const { fileName } = vector;
    const workerScope = await startWorker(fileName);
    workerScope.dispatchRequest(createWorkerStartRequest(fileName, {
        audioTrackIndex: 0,
        decodedAudioOutputChannelCount: outputChannelCount,
        generation: GENERATION
    }));
    const readyResponse = await workerScope.waitForResponse(response => response.type === 'ready' && response.generation === GENERATION);
    expect(readyResponse).toMatchObject({ audio: { codec: vector.codec, sampleRate: SAMPLE_RATE } });
    const { attachment, processor } = openFakeWorkletChannel({
        audioSampleCredits: AUDIO_SAMPLE_CREDITS,
        channelCount: outputChannelCount,
        workletGeneration: WORKLET_GENERATION
    });
    openedProcessors.push(processor);

    workerScope.dispatchRequest({ audioEpoch: 0, audioOutput: attachment, generation: GENERATION, type: 'attach-audio-output' });
    await workerScope.waitForStopped(GENERATION);
    expect(workerScope.responses.filter(response => response.type === 'error')).toEqual([]);
    await vi.waitFor(() => {
        expect(processor.receivedFrameCount).toBe(FRAME_COUNT);
    });
    return Array.from({ length: outputChannelCount }, (_unused, channelIndex) => (
        processor.chunks.flatMap(chunk => Array.from(chunk.channelData[channelIndex]))
    ));
}

function getPeak(channel: readonly number[]): number {
    return channel.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0);
}

/** Requires an output channel to carry one source channel of the interleaved samples, scaled by a gain, at every frame. */
function expectRoutedChannel(output: readonly number[], expected: readonly number[], channelCount: number, sourceChannel: number, gain: number): void {
    const mismatches = output.flatMap((sample, frameIndex) => {
        const routed = expected[(frameIndex * channelCount) + sourceChannel] * gain;
        return Math.abs(sample - routed) <= ROUTING_TOLERANCE ? [] : [ frameIndex ];
    });
    expect(mismatches).toEqual([]);
}

describe('the playback worker on AVI audio', () => {
    it.each(PCM_VECTORS)('decodes 5.1 $codec from WAVE_FORMAT_EXTENSIBLE in WAVE channel order', async vector => {
        const decodedChannels = await decodeToWorklet(vector, FIVE_POINT_ONE_CHANNEL_COUNT);

        // Every decoded sample is the file's own, each in its channel
        const expected = readInterleavedSamples(readAVIVector(vector.fileName), vector);
        expect(expected).toHaveLength(FRAME_COUNT * FIVE_POINT_ONE_CHANNEL_COUNT);
        const mismatches = decodedChannels.flatMap((channel, channelIndex) => channel.flatMap((sample, frameIndex) => (
            sample === expected[(frameIndex * FIVE_POINT_ONE_CHANNEL_COUNT) + channelIndex] ? [] : [ { channelIndex, frameIndex } ]
        )));
        expect(mismatches).toEqual([]);

        // The pan's falling levels show the channels kept their speakers
        const peaks = decodedChannels.map(getPeak);
        peaks.forEach((peak, channelIndex) => {
            expect(Math.abs((peak / peaks[0]) - CHANNEL_GAINS[channelIndex])).toBeLessThan(GAIN_TOLERANCE);
        });
    });

    it('plays the third channel of a 2.1 mask as the LFE, not the front center three channels otherwise mean', async () => {
        const expected = readInterleavedSamples(readAVIVector(TWO_POINT_ONE_VECTOR.fileName), TWO_POINT_ONE_VECTOR);
        const surround = await decodeToWorklet(TWO_POINT_ONE_VECTOR, FIVE_POINT_ONE_CHANNEL_COUNT);
        expectRoutedChannel(surround[FRONT_LEFT_SLOT], expected, THREE_CHANNEL_COUNT, 0, 1);
        expectRoutedChannel(surround[FRONT_RIGHT_SLOT], expected, THREE_CHANNEL_COUNT, 1, 1);
        expectRoutedChannel(surround[LFE_SLOT], expected, THREE_CHANNEL_COUNT, 2, 1);
        expect(getPeak(surround[FRONT_CENTER_SLOT])).toBe(0);
    });

    it('leaves the LFE of a 2.1 mask out of a stereo downmix, where a front center would feed both fronts', async () => {
        // The fronts keep the pan's ratio only without the third channel in both
        const stereo = await decodeToWorklet(TWO_POINT_ONE_VECTOR, STEREO_CHANNEL_COUNT);
        expect(Math.abs((getPeak(stereo[1]) / getPeak(stereo[0])) - FRONT_RIGHT_GAIN)).toBeLessThan(GAIN_TOLERANCE);
    });

    it('splits the third channel of a 3.0(back) mask across the surround pair', async () => {
        const expected = readInterleavedSamples(readAVIVector(THREE_POINT_ZERO_BACK_VECTOR.fileName), THREE_POINT_ZERO_BACK_VECTOR);
        const surround = await decodeToWorklet(THREE_POINT_ZERO_BACK_VECTOR, FIVE_POINT_ONE_CHANNEL_COUNT);
        expectRoutedChannel(surround[FRONT_LEFT_SLOT], expected, THREE_CHANNEL_COUNT, 0, 1);
        expectRoutedChannel(surround[FRONT_RIGHT_SLOT], expected, THREE_CHANNEL_COUNT, 1, 1);
        expectRoutedChannel(surround[SURROUND_LEFT_SLOT], expected, THREE_CHANNEL_COUNT, 2, Math.SQRT1_2);
        expectRoutedChannel(surround[SURROUND_RIGHT_SLOT], expected, THREE_CHANNEL_COUNT, 2, Math.SQRT1_2);
        expect(getPeak(surround[FRONT_CENTER_SLOT])).toBe(0);
        expect(getPeak(surround[LFE_SLOT])).toBe(0);
    });

    it('refuses a channel mask the output stage does not lay out rather than playing it by count', async () => {
        const fileName = TWO_POINT_ONE_VECTOR.fileName;
        const workerScope = await startWorker(fileName, withChannelMask(readAVIVector(fileName), UNQUALIFIED_THREE_CHANNEL_MASK));
        workerScope.dispatchRequest(createWorkerStartRequest(fileName, {
            audioTrackIndex: 0,
            decodedAudioOutputChannelCount: FIVE_POINT_ONE_CHANNEL_COUNT,
            generation: GENERATION
        }));
        await workerScope.waitForStopped(GENERATION);
        expect(workerScope.responses).toContainEqual(expect.objectContaining({
            message: 'The selected audio channel mask is unqualified: 0xd',
            type: 'error'
        }));
    });
});
