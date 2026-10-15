// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    MAX_GPU_DECODE_PACKET_CREDITS,
    type DecodeWorkerResponse,
    type DecodeWorkerStartRequest
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import { MATROSKA_MPEG1_CODEC_ID, MATROSKA_MPEG2_CODEC_ID } from 'webgpu-player/demux/mpeg/MatroskaMPEGVideoConfiguration';

import {
    createWorkerStartRequest,
    decodeToEnd,
    FakeVideoDecoder,
    getReadyResponse,
    startDecodeWorker
} from '../helpers/decodeWorkerHarness';
import { createVideoTrackMatroska, type SyntheticMatroskaBlock } from '../helpers/matroskaElements';

const MATROSKA_FILE_NAME = 'mpeg2.mkv';
const CODED_WIDTH = 720;
const CODED_HEIGHT = 576;
const FRAME_MILLISECONDS = 40;
const FRAME_MICROSECONDS = 40_000;
// A sequence header's start code, then bytes the worker passes on unread, as FFmpeg's Matroska demuxer passes the CodecPrivate
const SEQUENCE_HEADER_CODEC_PRIVATE = new Uint8Array([ 0x00, 0x00, 0x01, 0xB3, 0x2D, 0x02, 0x40, 0x33, 0x24, 0x9F, 0x23, 0x81 ]);
// Picture start codes and payload; the worker never parses an MPEG-2 picture
const PICTURE_PAYLOAD = new Uint8Array([ 0x00, 0x00, 0x01, 0x00, 0x5A, 0xA5 ]);
const PACKET_COUNT = 3;
// The GPU decoder's frame-pool route, whose decoder package takes MPEG-2
const FRAME_POOL_ROUTE: Partial<DecodeWorkerStartRequest> = {
    frameCredits: MAX_GPU_DECODE_PACKET_CREDITS,
    gpuVideoCodec: 'mpeg2video',
    rawVideoFrameFormat: 'I420',
    videoDecoderBackend: 'gpu',
    videoOutputMode: 'frame-pool'
};

type PacketResponse = Extract<DecodeWorkerResponse, { type: 'packet' }>;

function getPacketResponses(responses: readonly DecodeWorkerResponse[]): PacketResponse[] {
    return responses.filter((response: DecodeWorkerResponse): response is PacketResponse => response.type === 'packet');
}

function createBlocks(): SyntheticMatroskaBlock[] {
    return Array.from({ length: PACKET_COUNT }, (_value: unknown, blockIndex: number): SyntheticMatroskaBlock => ({
        data: PICTURE_PAYLOAD,
        keyframe: blockIndex === 0,
        timestampMilliseconds: blockIndex * FRAME_MILLISECONDS
    }));
}

function createMPEGMatroska(codecPrivate: Uint8Array | null, codecID: string = MATROSKA_MPEG2_CODEC_ID): Uint8Array {
    return createVideoTrackMatroska({
        blocks: createBlocks(),
        codecID,
        codecPrivate,
        defaultDurationMilliseconds: FRAME_MILLISECONDS,
        pixelHeight: CODED_HEIGHT,
        pixelWidth: CODED_WIDTH
    });
}

beforeEach(() => {
    vi.resetModules();
    // Mediabunny warns that it maps no codec to V_MPEG2, which only a decoder package decodes
    vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('CustomDecode.worker MPEG-1 and MPEG-2 frame-pool routes', () => {
    it('hands the decoder package the track\'s CodecPrivate and posts its packets', async () => {
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, createMPEGMatroska(SEQUENCE_HEADER_CODEC_PRIVATE) ] ]));

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MATROSKA_FILE_NAME, FRAME_POOL_ROUTE));

        const ready = getReadyResponse(responses);
        expect(ready).toMatchObject({ codec: 'mpeg2video', codedHeight: CODED_HEIGHT, codedWidth: CODED_WIDTH });
        expect(new Uint8Array(ready.codecPrivate ?? new ArrayBuffer(0))).toEqual(SEQUENCE_HEADER_CODEC_PRIVATE);
        expect(getPacketResponses(responses).map(packet => packet.timestampMicroseconds))
            .toEqual(Array.from({ length: PACKET_COUNT }, (_value: unknown, packetIndex: number): number => packetIndex * FRAME_MICROSECONDS));
        expect(FakeVideoDecoder.instances).toEqual([]);
    });

    it('hands over no codec private data for a track without a CodecPrivate, whose packets carry the sequence headers', async () => {
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, createMPEGMatroska(null) ] ]));

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MATROSKA_FILE_NAME, FRAME_POOL_ROUTE));

        expect(getReadyResponse(responses)).not.toHaveProperty('codecPrivate');
        expect(getPacketResponses(responses)).toHaveLength(PACKET_COUNT);
    });

    it('reads an MPEG-1 track as its own codec, with its CodecPrivate', async () => {
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, createMPEGMatroska(SEQUENCE_HEADER_CODEC_PRIVATE, MATROSKA_MPEG1_CODEC_ID) ] ]));

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MATROSKA_FILE_NAME, { ...FRAME_POOL_ROUTE, gpuVideoCodec: 'mpeg1video' }));

        const ready = getReadyResponse(responses);
        expect(ready).toMatchObject({ codec: 'mpeg1video' });
        expect(new Uint8Array(ready.codecPrivate ?? new ArrayBuffer(0))).toEqual(SEQUENCE_HEADER_CODEC_PRIVATE);
        expect(getPacketResponses(responses)).toHaveLength(PACKET_COUNT);
    });

    it('refuses an MPEG-1 track on the MPEG-2 route, whose package may not decode MPEG-1', async () => {
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, createMPEGMatroska(SEQUENCE_HEADER_CODEC_PRIVATE, MATROSKA_MPEG1_CODEC_ID) ] ]));
        const request = createWorkerStartRequest(MATROSKA_FILE_NAME, FRAME_POOL_ROUTE);

        workerScope.dispatchRequest(request);
        await workerScope.waitForStopped(request.generation);

        expect(workerScope.responses).toContainEqual({
            failureKind: 'source-unsupported',
            generation: request.generation,
            message: `The selected video track does not match the negotiated MPEG-2 route: codec-id: ${MATROSKA_MPEG1_CODEC_ID}`,
            type: 'error'
        });
        expect(getPacketResponses(workerScope.responses)).toEqual([]);
    });
});
