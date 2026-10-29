// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CUSTOM_WAVE_CHANNEL_MASK_STEREO } from 'webgpu-player/audio/processing/CustomWaveChannelLayout';
import { parseAudioDecoderManifest } from 'webgpu-player/decode/audio/AudioDecoderManifest';
import { readWaveFormatAudioTrack } from 'webgpu-player/demux/WaveFormatAudioConfiguration';

import { FakeVideoFrame, createWorkerStartRequest, startDecodeWorker } from '../helpers/decodeWorkerHarness';
import { DECODERS_DIRECTORY } from '../helpers/enginePaths';
import { openFakeWorkletChannel, type FakeWorkletProcessor } from '../helpers/fakeWorkletProcessor';

// The audio decode worker instantiates the scripted module the package selection carries
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

const GENERATION = 41;
const AUDIO_EPOCH = 0;
const AUDIO_SAMPLE_CREDITS = 4;
const WORKLET_GENERATION = 2;
const STEREO_CHANNEL_COUNT = 2;
// The wma project's media: a few H.264 frames beside the 11 WMA v2 packets of its 44.1 kHz stereo vector, in AVI and in Matroska
const WMA_VECTORS_DIRECTORY = join(DECODERS_DIRECTORY, 'wma', 'vectors');
const MEDIA_FILE_NAMES = [ 'wmav2-h264.mkv', 'wmav2-h264.avi' ] as const;
const WMA_V2_PACKET_COUNT = 11;
const WMA_V2_CODEC = 'wmav2';
const WMA_V2_BLOCK_FRAME_COUNT = 2_048;
const WMA_V2_SAMPLE_RATE = 44_100;
const PACKAGE_MANIFEST = parseAudioDecoderManifest([
    '//! id: wma',
    '//! name: WMA',
    '//! decoder: audio',
    '//! accepts: codec in [wmav1, wmav2, wmapro, wmalossless, wmavoice]'
].join('\n'));

const openedProcessors: FakeWorkletProcessor[] = [];

// Each case starts a new worker module, as the other worker tests do, so no state of a previous playback carries over
beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    for (const processor of openedProcessors.splice(0)) {
        processor.close();
    }
    vi.unstubAllGlobals();
});

/** Reads a medium's audio track's WAVEFORMATEX as the worker's demux reads it. */
async function readMediumWaveFormat(media: Uint8Array): Promise<Uint8Array | null> {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(media) });
    try {
        const [ track ] = await input.getAudioTracks();
        const result = readWaveFormatAudioTrack(track);
        return result?.status === 'read' ? result.waveFormat : null;
    } finally {
        input.dispose();
    }
}

describe('the playback worker with a WMA track', () => {
    it.each(MEDIA_FILE_NAMES)('configures the WMA package with %s\'s WAVEFORMATEX before its first packet, and sends it every packet', async (fileName) => {
        const media = readFileSync(join(WMA_VECTORS_DIRECTORY, fileName));
        const silentBlock = {
            channelData: [ new Array<number>(WMA_V2_BLOCK_FRAME_COUNT).fill(0), new Array<number>(WMA_V2_BLOCK_FRAME_COUNT).fill(0) ],
            channelMask: CUSTOM_WAVE_CHANNEL_MASK_STEREO,
            sampleRate: WMA_V2_SAMPLE_RATE
        };
        // The instance the worker's mocked instantiation imports, since both load after the same reset
        const { ScriptedAudioDecoderModule } = await import('../helpers/scriptedAudioDecoderModule');
        const wmaPackage = new ScriptedAudioDecoderModule({ manifest: PACKAGE_MANIFEST, packets: [ { blocks: [ silentBlock ], kind: 'decoded' } ] });
        const workerScope = await startDecodeWorker(new Map([ [ fileName, media ] ]));
        // The H.264 track decodes through Mediabunny's sample path, which wraps each decoded frame in a VideoFrame
        vi.stubGlobal('VideoFrame', FakeVideoFrame);

        workerScope.dispatchRequest(createWorkerStartRequest(fileName, {
            audioOutputMode: 'decoded-pcm',
            audioPackageDecoder: { codec: WMA_V2_CODEC, source: wmaPackage.source },
            audioSampleCredits: AUDIO_SAMPLE_CREDITS,
            audioTrackIndex: 0,
            decodedAudioOutputLayout: 'stereo',
            generation: GENERATION
        }));
        const readyResponse = await workerScope.waitForResponse(response => response.type === 'ready' && response.generation === GENERATION);
        const { attachment, processor } = openFakeWorkletChannel({
            audioSampleCredits: AUDIO_SAMPLE_CREDITS,
            channelCount: STEREO_CHANNEL_COUNT,
            workletGeneration: WORKLET_GENERATION
        });
        openedProcessors.push(processor);
        workerScope.dispatchRequest({ audioEpoch: AUDIO_EPOCH, audioOutput: attachment, generation: GENERATION, type: 'attach-audio-output' });
        await workerScope.waitForStopped(GENERATION);

        expect(readyResponse).toMatchObject({ audio: { codec: WMA_V2_CODEC, sourceChannelCount: STEREO_CHANNEL_COUNT, sourceSampleRate: WMA_V2_SAMPLE_RATE } });
        expect(workerScope.responses.map(response => response.type)).not.toContain('error');
        expect(wmaPackage.configurations).toEqual([ { bytes: await readMediumWaveFormat(media), sentPacketCount: 0 } ]);
        expect(wmaPackage.sentPackets).toHaveLength(WMA_V2_PACKET_COUNT);
    });
});
