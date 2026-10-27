// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_GPU_DECODE_PACKET_CREDITS, type DecodeWorkerResponse, type DecodeWorkerStartRequest } from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import { secondsToMicroseconds } from 'webgpu-player/MediaTime';

import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../helpers/enginePaths';
import { createWorkerStartRequest, startDecodeWorker, type FakeWorkerScope } from '../helpers/decodeWorkerHarness';

// The FFmpeg-made vectors of scripts/codec_vector_assets/generate_transport_stream_demux_vectors.py
const TRANSPORT_STREAM_VECTOR_DIRECTORY = join(CODEC_VECTOR_ASSETS_DIRECTORY, 'mpeg-ts');
const MPEG1_FILE_NAME = 'mpeg1video-mp3.ts';
const MPEG2_FILE_NAME = 'mpeg2video-bframes-ac3.ts';
const MPEG2_M2TS_FILE_NAME = 'mpeg2video-bframes-ac3.m2ts';
const VC1_FILE_NAME = 'vc1-advanced.ts';
const VC1_M2TS_FILE_NAME = 'vc1-advanced.m2ts';
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
    { codec: 'vc1', codecPrivateByteLength: 30, fileName: VC1_M2TS_FILE_NAME, height: VC1_HEIGHT, keyPacketIndices: VC1_KEY_PACKET_INDICES, skippedFrameSlots: VC1_SKIPPED_FRAME_SLOTS, width: VC1_WIDTH }
];

const MEDIA_FILES = new Map<string, Uint8Array>(
    [ MPEG1_FILE_NAME, MPEG2_FILE_NAME, MPEG2_M2TS_FILE_NAME, VC1_FILE_NAME, VC1_M2TS_FILE_NAME ].map(
        (fileName: string): [string, Uint8Array] => [ fileName, new Uint8Array(readFileSync(join(TRANSPORT_STREAM_VECTOR_DIRECTORY, fileName))) ]
    )
);

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
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
});
