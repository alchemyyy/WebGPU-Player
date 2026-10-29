// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUDIO_OUTPUT_STAGE_WASM_ASSET } from 'webgpu-player/EngineAssets';
import { CUSTOM_WAVE_CHANNEL_MASK_STEREO } from 'webgpu-player/audio/processing/CustomWaveChannelLayout';
import { parseAudioDecoderManifest } from 'webgpu-player/decode/audio/AudioDecoderManifest';
import {
    isDecodeWorkerResponse,
    MAX_GPU_DECODE_PACKET_CREDITS,
    SOURCE_PROGRESS_REPORT_BYTE_COUNT,
    type DecodeWorkerResponse,
    type DecodeWorkerStartRequest
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import { MICROSECONDS_PER_SECOND, secondsToMicroseconds, type Microseconds } from 'webgpu-player/MediaTime';

import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../helpers/enginePaths';
import { createWorkerStartRequest, startDecodeWorker, type FakeWorkerScope } from '../helpers/decodeWorkerHarness';
import { openFakeWorkletChannel, type FakeWorkletProcessor } from '../helpers/fakeWorkletProcessor';
import { readLibraryAssetSource } from '../helpers/libraryAssets';

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

// The FFmpeg-made vectors of scripts/codec_vector_assets/generate_transport_stream_demux_vectors.py
const TRANSPORT_STREAM_VECTOR_DIRECTORY = join(CODEC_VECTOR_ASSETS_DIRECTORY, 'mpeg-ts');
const MPEG1_FILE_NAME = 'mpeg1video-mp3.ts';
const MPEG2_FILE_NAME = 'mpeg2video-bframes-ac3.ts';
const MPEG2_M2TS_FILE_NAME = 'mpeg2video-bframes-ac3.m2ts';
const VC1_FILE_NAME = 'vc1-advanced.ts';
const VC1_M2TS_FILE_NAME = 'vc1-advanced.m2ts';
// vc1-advanced.ts with its PMT stripped of the VC-1 registration descriptor
const UNREGISTERED_VC1_FILE_NAME = 'vc1-advanced-unregistered.ts';
// The MPEG-2 and stereo AC-3 encode with every timestamp 600 s on, as a Blu-ray title's program clock starts, and 1.4 s more by FFmpeg's muxer delay
const START600_FILE_NAMES = [ 'mpeg2video-ac3-start600.ts', 'mpeg2video-ac3-start600.m2ts' ] as const;
// DTS core alone, as a Blu-ray program carries it: a container without a video track
const AUDIO_ONLY_FILE_NAME = 'dts-core.m2ts';
const NO_VIDEO_TRACK_MESSAGE = 'The container has no video track';
// What FFprobe reads of them, in ticks of the 90 kHz program clock: the AC-3 track starts first, at the format's start_time, and the video 5.3 ms later
const PROGRAM_CLOCK_RATE = 90_000;
const START600_AUDIO_START_TICKS = 54_125_520;
const START600_VIDEO_START_TICKS = 54_126_000;
// The key packet after the first, where a start or resync before the third begins
const START600_SECOND_KEY_PACKET_TICKS = 54_148_500;
// The format's duration: from its start_time to the end of the last frame
const START600_FORMAT_DURATION_MICROSECONDS = 505_333;
const START600_SEEK_MICROSECONDS = 300_000 as Microseconds;
const START600_VIDEO_EPOCH = 1;
const AUDIO_EPOCH = 0;
const AUDIO_SAMPLE_CREDITS = 4;
const NATIVE_AUDIO_SAMPLE_CREDITS = 2;
const WORKLET_GENERATION = 2;
const STEREO_CHANNEL_COUNT = 2;
const AC3_FRAME_COUNT = 1_536;
const AC3_SAMPLE_RATE = 48_000;
const AC3_PACKAGE_MANIFEST = parseAudioDecoderManifest([
    '//! id: scripted-ac3',
    '//! name: Scripted AC-3',
    '//! decoder: audio',
    '//! accepts: codec in [ac3]'
].join('\n'));
const VIDEO_FRAME_COUNT = 12;
const VIDEO_FRAME_RATE = 24;
const ENCODED_SIZE = 192;
const VC1_WIDTH = 1_920;
const VC1_HEIGHT = 1_080;
const MAXIMUM_CODED_DIMENSION = 4_096;
const OUTPUT_FORMAT = 'I420';
const RETURNED_CREDITS = 1;
// The packets FFprobe flags as key frames, in decode order: MPEG-1's groups of six frames, MPEG-2's I-pictures among its B-frames,
// and VC-1's one I-picture, which leads the qualification vector
const MPEG1_KEY_PACKET_INDICES = [ 0, 6 ] as const;
const MPEG2_KEY_PACKET_INDICES = [ 0, 4, 10 ] as const;
const VC1_KEY_PACKET_INDICES = [ 0 ] as const;
const ROUNDING_TOLERANCE_MICROSECONDS = 1;
const VC1_SKIPPED_FRAME_SLOTS = 1;
const MISMATCH_MESSAGE = 'The selected video track does not match the negotiated MPEG-2 route: container-codec: vc1';

type TransportStreamRouteExpectation = Readonly<{
    codec: 'mpeg1video' | 'mpeg2video' | 'vc1'
    codecPrivateByteLength: number
    fileName: string
    height: number
    keyPacketIndices: readonly number[]
    skippedFrameSlots: number
    width: number
}>;

type PacketResponse = Extract<DecodeWorkerResponse, { type: 'packet' }>;
type ReadyResponse = Extract<DecodeWorkerResponse, { type: 'ready' }>;

const TRANSPORT_STREAM_ROUTES: readonly TransportStreamRouteExpectation[] = [
    { codec: 'mpeg1video', codecPrivateByteLength: 12, fileName: MPEG1_FILE_NAME, height: ENCODED_SIZE, keyPacketIndices: MPEG1_KEY_PACKET_INDICES, skippedFrameSlots: 0, width: ENCODED_SIZE },
    { codec: 'mpeg2video', codecPrivateByteLength: 22, fileName: MPEG2_FILE_NAME, height: ENCODED_SIZE, keyPacketIndices: MPEG2_KEY_PACKET_INDICES, skippedFrameSlots: 0, width: ENCODED_SIZE },
    { codec: 'mpeg2video', codecPrivateByteLength: 22, fileName: MPEG2_M2TS_FILE_NAME, height: ENCODED_SIZE, keyPacketIndices: MPEG2_KEY_PACKET_INDICES, skippedFrameSlots: 0, width: ENCODED_SIZE },
    { codec: 'vc1', codecPrivateByteLength: 30, fileName: VC1_FILE_NAME, height: VC1_HEIGHT, keyPacketIndices: VC1_KEY_PACKET_INDICES, skippedFrameSlots: VC1_SKIPPED_FRAME_SLOTS, width: VC1_WIDTH },
    { codec: 'vc1', codecPrivateByteLength: 30, fileName: VC1_M2TS_FILE_NAME, height: VC1_HEIGHT, keyPacketIndices: VC1_KEY_PACKET_INDICES, skippedFrameSlots: VC1_SKIPPED_FRAME_SLOTS, width: VC1_WIDTH },
    { codec: 'vc1', codecPrivateByteLength: 30, fileName: UNREGISTERED_VC1_FILE_NAME, height: VC1_HEIGHT, keyPacketIndices: VC1_KEY_PACKET_INDICES, skippedFrameSlots: VC1_SKIPPED_FRAME_SLOTS, width: VC1_WIDTH }
];

const MEDIA_FILES = new Map<string, Uint8Array>(
    [ MPEG1_FILE_NAME, MPEG2_FILE_NAME, MPEG2_M2TS_FILE_NAME, VC1_FILE_NAME, VC1_M2TS_FILE_NAME, UNREGISTERED_VC1_FILE_NAME, AUDIO_ONLY_FILE_NAME, ...START600_FILE_NAMES ].map(
        (fileName: string): [string, Uint8Array] => [ fileName, new Uint8Array(readFileSync(join(TRANSPORT_STREAM_VECTOR_DIRECTORY, fileName))) ]
    )
);
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

/** Returns each packet's credit as soon as the worker posts it, as a page that decodes at once would. */
function returnPacketCredits(workerScope: FakeWorkerScope): void {
    const postMessage = workerScope.postMessage.bind(workerScope);
    workerScope.postMessage = (message: DecodeWorkerResponse): void => {
        postMessage(message);
        if (message.type === 'packet') {
            void Promise.resolve().then((): void => {
                workerScope.dispatchRequest({ frameCredits: RETURNED_CREDITS, generation: message.generation, type: 'pull' });
            });
        }
    };
}

function createFramePoolRequest(fileName: string, codec: TransportStreamRouteExpectation['codec']): DecodeWorkerStartRequest {
    return createWorkerStartRequest(fileName, {
        frameCredits: MAX_GPU_DECODE_PACKET_CREDITS,
        gpuVideoCodec: codec,
        maximumCodedHeight: MAXIMUM_CODED_DIMENSION,
        maximumCodedWidth: MAXIMUM_CODED_DIMENSION,
        rawVideoFrameFormat: OUTPUT_FORMAT,
        videoDecoderBackend: 'gpu',
        videoOutputMode: 'frame-pool'
    });
}

async function runToStop(request: DecodeWorkerStartRequest): Promise<DecodeWorkerResponse[]> {
    const workerScope = await startDecodeWorker(MEDIA_FILES);
    returnPacketCredits(workerScope);
    workerScope.dispatchRequest(request);
    await workerScope.waitForStopped(request.generation);
    return workerScope.responses;
}

/** Returns a program clock time as Mediabunny's packets carry it, truncated to whole microseconds. */
function getContainerMicroseconds(ticks: number): number {
    return Math.trunc((ticks / PROGRAM_CLOCK_RATE) * MICROSECONDS_PER_SECOND);
}

/** Returns a program clock time on the playback timeline, which starts at the first timestamp of the tracks a run plays. */
function getPlaybackMicroseconds(ticks: number, originTicks: number): number {
    return getContainerMicroseconds(ticks) - getContainerMicroseconds(originTicks);
}

function getPackets(responses: readonly DecodeWorkerResponse[]): PacketResponse[] {
    return responses.filter((response): response is PacketResponse => response.type === 'packet');
}

/** Returns each native audio segment's credit as soon as the worker posts it, as the page's element appends it at once. */
function returnNativeAudioCredits(workerScope: FakeWorkerScope): void {
    const postMessage = workerScope.postMessage.bind(workerScope);
    workerScope.postMessage = (message: DecodeWorkerResponse): void => {
        postMessage(message);
        if (message.type === 'native-audio-media') {
            void Promise.resolve().then((): void => {
                workerScope.dispatchRequest({ audioSampleCredits: RETURNED_CREDITS, generation: message.generation, type: 'pull-audio' });
            });
        }
    };
}

describe('the playback worker\'s focused routes on MPEG-TS and M2TS', () => {
    it.each(TRANSPORT_STREAM_ROUTES)('posts $fileName\'s $codec packets with its first sequence header as codec private data', async (route: TransportStreamRouteExpectation) => {
        const responses = await runToStop(createFramePoolRequest(route.fileName, route.codec));

        expect(responses.filter(response => response.type === 'error')).toEqual([]);
        const ready = responses.find((response): response is ReadyResponse => response.type === 'ready');
        expect(ready).toMatchObject({ codec: route.codec, codedHeight: route.height, codedWidth: route.width });
        expect(ready?.codecPrivate?.byteLength).toBe(route.codecPrivateByteLength);
        const packets = responses.filter((response): response is PacketResponse => response.type === 'packet');
        expect(packets).toHaveLength(VIDEO_FRAME_COUNT);
        const keyPacketIndices = packets.flatMap((packet: PacketResponse, packetIndex: number): number[] => packet.keyframe ? [ packetIndex ] : []);
        expect(keyPacketIndices).toEqual(route.keyPacketIndices);
        // Packets come in decode order with their PES presentation times, which sorted fill one slot per frame from the first;
        // FFmpeg's VC-1 elementary stream demuxer stamped the VC-1 vector's frames after the first one slot late, reserving a slot for B-frames
        const timestamps = packets.map(packet => packet.timestampMicroseconds).sort((left: number, right: number): number => left - right);
        timestamps.forEach((timestamp: number, frameIndex: number): void => {
            const frameSlot = frameIndex === 0 ? 0 : frameIndex + route.skippedFrameSlots;
            const expected = timestamps[0] + secondsToMicroseconds(frameSlot / VIDEO_FRAME_RATE);
            expect(Math.abs(timestamp - expected)).toBeLessThanOrEqual(ROUNDING_TOLERANCE_MICROSECONDS);
        });
    });

    it('names MPEG-1\'s chroma center-sited 4:2:0, as FFmpeg\'s MPEG-1 decoder sets it', async () => {
        const responses = await runToStop(createFramePoolRequest(MPEG1_FILE_NAME, 'mpeg1video'));

        expect(responses.find((response): response is ReadyResponse => response.type === 'ready')?.chromaFormat)
            .toEqual({ location: 'center', subsampling: '4:2:0' });
    });

    it('refuses a VC-1 transport stream track on the MPEG-2 route by its container codec', async () => {
        const responses = await runToStop(createFramePoolRequest(VC1_FILE_NAME, 'mpeg2video'));

        expect(responses.filter(response => response.type === 'error').map(response => response.type === 'error' ? response.message : null)).toEqual([ MISMATCH_MESSAGE ]);
    });

    it('fails a container without a video track as a source no route plays, before its readiness', async () => {
        const responses = await runToStop(createWorkerStartRequest(AUDIO_ONLY_FILE_NAME));

        expect(responses.map(response => response.type)).not.toContain('ready');
        expect(responses.filter(response => response.type === 'error')).toEqual([
            expect.objectContaining({ failureKind: 'source-unsupported', message: NO_VIDEO_TRACK_MESSAGE })
        ]);
    });

    it('reports the source bytes its preparation reads, in steps, and none once ready', async () => {
        const responses = await runToStop(createFramePoolRequest(VC1_FILE_NAME, 'vc1'));

        const readyIndex = responses.findIndex(response => response.type === 'ready');
        const sourceProgress = responses.flatMap((response, responseIndex) => (response.type === 'source-progress' ? [ { byteCount: response.byteCount, responseIndex } ] : []));
        // Preparing the 621 KiB vector reads past the first step
        expect(sourceProgress.length).toBeGreaterThan(0);
        expect(sourceProgress.every(progress => progress.responseIndex < readyIndex)).toBe(true);
        expect(responses.filter(response => response.type === 'source-progress' && !isDecodeWorkerResponse(response))).toEqual([]);
        const byteCounts = sourceProgress.map(progress => progress.byteCount);
        expect(byteCounts[0]).toBeGreaterThanOrEqual(SOURCE_PROGRESS_REPORT_BYTE_COUNT);
        byteCounts.slice(1).forEach((byteCount: number, index: number): void => {
            expect(byteCount - byteCounts[index]).toBeGreaterThanOrEqual(SOURCE_PROGRESS_REPORT_BYTE_COUNT);
        });
    });
});

describe('the playback worker on a transport stream whose program clock starts 600 s on', () => {
    it.each(START600_FILE_NAMES)('posts %s\'s video and native audio on a timeline that starts at 0 and lasts the format\'s duration', async (fileName: string) => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        returnPacketCredits(workerScope);
        returnNativeAudioCredits(workerScope);
        const request: DecodeWorkerStartRequest = {
            ...createFramePoolRequest(fileName, 'mpeg2video'),
            audioOutputMode: 'native-media',
            audioSampleCredits: NATIVE_AUDIO_SAMPLE_CREDITS,
            audioTrackIndex: 0
        };
        workerScope.dispatchRequest(request);
        await workerScope.waitForStopped(request.generation);

        const { responses } = workerScope;
        expect(responses.filter(response => response.type === 'error')).toEqual([]);
        // The audio starts the timeline, and the first frame follows 5.3 ms later, as both do in the container
        expect(responses.find(response => response.type === 'native-audio-media')).toMatchObject({ startTimeMicroseconds: 0 });
        const packets = getPackets(responses);
        expect(packets).toHaveLength(VIDEO_FRAME_COUNT);
        const timestamps = packets.map(packet => packet.timestampMicroseconds).sort((left: number, right: number): number => left - right);
        expect(timestamps[0]).toBe(getPlaybackMicroseconds(START600_VIDEO_START_TICKS, START600_AUDIO_START_TICKS));
        const lastPacket = packets.find(packet => packet.timestampMicroseconds === timestamps.at(-1));
        expect(Math.abs((lastPacket?.timestampMicroseconds ?? 0) + (lastPacket?.durationMicroseconds ?? 0) - START600_FORMAT_DURATION_MICROSECONDS))
            .toBeLessThanOrEqual(ROUNDING_TOLERANCE_MICROSECONDS);
        const progressTimes = responses.flatMap(response => (response.type === 'progress' && response.mediaTimeMicroseconds !== null ? [ response.mediaTimeMicroseconds ] : []));
        expect(progressTimes).not.toEqual([]);
        expect(progressTimes.every(progressTime => progressTime >= 0 && progressTime < START600_FORMAT_DURATION_MICROSECONDS)).toBe(true);
    });

    it('starts a run at a playback time from the key packet at or before it, counted from the first timestamp of the tracks the run plays', async () => {
        const responses = await runToStop({
            ...createFramePoolRequest(START600_FILE_NAMES[0], 'mpeg2video'),
            startTimeMicroseconds: START600_SEEK_MICROSECONDS
        });

        expect(getPackets(responses)[0]).toMatchObject({
            keyframe: true,
            timestampMicroseconds: getPlaybackMicroseconds(START600_SECOND_KEY_PACKET_TICKS, START600_VIDEO_START_TICKS)
        });
    });

    it('resyncs video at a playback time from the key packet at or before it', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const request = createFramePoolRequest(START600_FILE_NAMES[0], 'mpeg2video');
        workerScope.dispatchRequest(request);
        // Its credits held, the first attempt waits once it posted as many packets
        await vi.waitFor(() => {
            expect(getPackets(workerScope.responses)).toHaveLength(MAX_GPU_DECODE_PACKET_CREDITS);
        });
        workerScope.dispatchRequest({
            generation: request.generation,
            targetTimeMicroseconds: START600_SEEK_MICROSECONDS,
            type: 'resync-video',
            videoEpoch: START600_VIDEO_EPOCH
        });
        returnPacketCredits(workerScope);
        workerScope.dispatchRequest({ frameCredits: MAX_GPU_DECODE_PACKET_CREDITS, generation: request.generation, type: 'pull' });
        await workerScope.waitForStopped(request.generation);

        expect(getPackets(workerScope.responses).find(packet => packet.videoEpoch === START600_VIDEO_EPOCH)).toMatchObject({
            keyframe: true,
            timestampMicroseconds: getPlaybackMicroseconds(START600_SECOND_KEY_PACKET_TICKS, START600_VIDEO_START_TICKS)
        });
    });

    it('decodes audio from 0 on the playback timeline, in the package, the worklet, and the audio progress', async () => {
        // The instance the worker's mocked instantiation imports, since both load after the same reset
        const { ScriptedAudioDecoderModule } = await import('../helpers/scriptedAudioDecoderModule');
        const silentBlock = {
            channelData: [ new Array<number>(AC3_FRAME_COUNT).fill(0), new Array<number>(AC3_FRAME_COUNT).fill(0) ],
            channelMask: CUSTOM_WAVE_CHANNEL_MASK_STEREO,
            sampleRate: AC3_SAMPLE_RATE
        };
        const ac3Package = new ScriptedAudioDecoderModule({ manifest: AC3_PACKAGE_MANIFEST, packets: [ { blocks: [ silentBlock ], kind: 'decoded' } ] });
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        // The module instance the worker imported, since both load after the same reset
        const { loadAudioOutputStageModule } = await import('webgpu-player/audio/processing/AudioOutputStageModule');
        await loadAudioOutputStageModule(await readLibraryAssetSource(AUDIO_OUTPUT_STAGE_WASM_ASSET));
        returnPacketCredits(workerScope);
        const request: DecodeWorkerStartRequest = {
            ...createFramePoolRequest(START600_FILE_NAMES[0], 'mpeg2video'),
            audioOutputMode: 'decoded-pcm',
            audioPackageDecoder: { codec: 'ac3', source: ac3Package.source },
            audioSampleCredits: AUDIO_SAMPLE_CREDITS,
            audioTrackIndex: 0,
            decodedAudioOutputLayout: 'stereo'
        };
        workerScope.dispatchRequest(request);
        await workerScope.waitForResponse(response => response.type === 'ready' && response.generation === request.generation);
        const { attachment, processor } = openFakeWorkletChannel({
            audioSampleCredits: AUDIO_SAMPLE_CREDITS,
            channelCount: STEREO_CHANNEL_COUNT,
            workletGeneration: WORKLET_GENERATION
        });
        openedProcessors.push(processor);
        workerScope.dispatchRequest({ audioEpoch: AUDIO_EPOCH, audioOutput: attachment, generation: request.generation, type: 'attach-audio-output' });
        await workerScope.waitForStopped(request.generation);

        expect(workerScope.responses.filter(response => response.type === 'error')).toEqual([]);
        expect(ac3Package.sentPackets[0]?.timestampMicroseconds).toBe(0);
        expect(processor.chunks[0]?.timestampMicroseconds).toBe(0);
        expect(workerScope.responses.find(response => response.type === 'audio-progress')).toMatchObject({ mediaTimeMicroseconds: 0 });
    });
});
