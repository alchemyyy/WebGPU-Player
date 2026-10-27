// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    MAX_GPU_DECODE_PACKET_CREDITS,
    type DecodeWorkerResponse,
    type DecodeWorkerStartRequest
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';

import { createWorkerStartRequest, getReadyResponse, startDecodeWorker } from '../helpers/decodeWorkerHarness';
import { MPEG4_VECTORS, readMPEG4VectorFiles, readVOPType, returnPacketCredits, type MPEG4Vector } from '../helpers/mpeg4Vectors';

const BITMAP_INFO_HEADER_BYTE_LENGTH = 40;
const HEADER_SIZE_OFFSET = 0;
const WIDTH_OFFSET = 4;
const HEIGHT_OFFSET = 8;
const PLANES_OFFSET = 12;
const BIT_COUNT_OFFSET = 14;
const FOURCC_OFFSET = 16;
const FOURCC_BYTE_LENGTH = 4;
const START_CODE_PREFIX = [ 0x00, 0x00, 0x01 ];
const ROUNDING_TOLERANCE_MICROSECONDS = 1;
// The GPU decoder's frame-pool route, whose decoder package takes the codec
const FRAME_POOL_ROUTE: Partial<DecodeWorkerStartRequest> = {
    frameCredits: MAX_GPU_DECODE_PACKET_CREDITS,
    rawVideoFrameFormat: 'I420',
    videoDecoderBackend: 'gpu',
    videoOutputMode: 'frame-pool'
};

type PacketResponse = Extract<DecodeWorkerResponse, { type: 'packet' }>;

const MEDIA_FILES = readMPEG4VectorFiles();

function getPacketResponses(responses: readonly DecodeWorkerResponse[]): PacketResponse[] {
    return responses.filter((response: DecodeWorkerResponse): response is PacketResponse => response.type === 'packet');
}

async function runToStop(request: DecodeWorkerStartRequest): Promise<DecodeWorkerResponse[]> {
    const workerScope = await startDecodeWorker(MEDIA_FILES);
    returnPacketCredits(workerScope);
    workerScope.dispatchRequest(request);
    await workerScope.waitForStopped(request.generation);
    return workerScope.responses;
}

function expectTimes(actualMicroseconds: readonly number[], firstFrameSlot: number, frameMicroseconds: number): void {
    expect(actualMicroseconds.length).toBeGreaterThan(0);
    actualMicroseconds.forEach((actual: number, frameIndex: number): void => {
        expect(Math.abs(actual - (firstFrameSlot + frameIndex) * frameMicroseconds)).toBeLessThanOrEqual(ROUNDING_TOLERANCE_MICROSECONDS);
    });
}

beforeEach(() => {
    vi.resetModules();
    // Mediabunny warns that it maps no codec to a VfW, s263, or V_MPEG4/MS/V3 track, which only a decoder package decodes
    vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('CustomDecode.worker MPEG-4 Part 2, H.263, and MS-MPEG4 frame-pool routes', () => {
    it.each(MPEG4_VECTORS)('posts $fileName to the $codec route behind a BITMAPINFOHEADER of its coded size and $fourCC', async (vector: MPEG4Vector) => {
        const responses = await runToStop(createWorkerStartRequest(vector.fileName, { ...FRAME_POOL_ROUTE, gpuVideoCodec: vector.codec }));

        expect(responses.filter(response => response.type === 'error')).toEqual([]);
        const ready = getReadyResponse(responses);
        expect(ready).toMatchObject({ codec: vector.codec, codedHeight: vector.codedHeight, codedWidth: vector.codedWidth });
        const description = new Uint8Array(ready.codecPrivate ?? new ArrayBuffer(0));
        const header = new DataView(description.buffer, 0, BITMAP_INFO_HEADER_BYTE_LENGTH);
        expect(header.getUint32(HEADER_SIZE_OFFSET, true)).toBe(BITMAP_INFO_HEADER_BYTE_LENGTH);
        expect(header.getInt32(WIDTH_OFFSET, true)).toBe(vector.codedWidth);
        expect(header.getInt32(HEIGHT_OFFSET, true)).toBe(vector.codedHeight);
        expect(header.getUint16(PLANES_OFFSET, true)).toBe(1);
        expect(header.getUint16(BIT_COUNT_OFFSET, true)).toBe(24);
        expect(String.fromCharCode(...description.subarray(FOURCC_OFFSET, FOURCC_OFFSET + FOURCC_BYTE_LENGTH))).toBe(vector.fourCC);
        const extradata = description.subarray(BITMAP_INFO_HEADER_BYTE_LENGTH);
        expect(extradata.byteLength).toBe(vector.extradataByteLength);
        if (extradata.byteLength > 0) {
            // The VOS, VO, and VOL headers, each after its start code
            expect(Array.from(extradata.subarray(0, START_CODE_PREFIX.length))).toEqual(START_CODE_PREFIX);
        }
    });

    it.each(MPEG4_VECTORS.filter(vector => vector.presentation !== null))(
        'stamps $fileName\'s packets with the times FFmpeg presents their VOPs at, in decode order',
        async (vector: MPEG4Vector) => {
            const responses = await runToStop(createWorkerStartRequest(vector.fileName, { ...FRAME_POOL_ROUTE, gpuVideoCodec: vector.codec }));

            const presented = [ ...getPacketResponses(responses) ].sort((left: PacketResponse, right: PacketResponse): number => left.timestampMicroseconds - right.timestampMicroseconds);
            // In timestamp order, the VOPs follow FFmpeg's output order, one frame slot each; AVI and VfW tracks' first anchor presents when the next outputs it
            expect(presented.map(packet => readVOPType(new Uint8Array(packet.data))).join('')).toBe(vector.presentation?.types);
            expectTimes(presented.map(packet => packet.timestampMicroseconds), vector.presentation?.firstFrameSlot ?? 0, vector.frameMicroseconds);
        }
    );

    it.each(MPEG4_VECTORS.filter(vector => vector.presentation === null))('stamps $fileName\'s pictures, which code no B pictures, in decode order', async (vector: MPEG4Vector) => {
        const responses = await runToStop(createWorkerStartRequest(vector.fileName, { ...FRAME_POOL_ROUTE, gpuVideoCodec: vector.codec }));

        expectTimes(getPacketResponses(responses).map(packet => packet.timestampMicroseconds), 0, vector.frameMicroseconds);
    });

    it.each([
        [ 'a DIV3 AVI track on the MPEG-4 Part 2 route', 'msmpeg4v3.avi', 'mpeg4', 'The selected MPEG-4 Part 2 track has no decoder configuration: fourcc: DIV3' ],
        [ 'an XVID VfW track on the MS-MPEG4 v3 route', 'mpeg4-b-vfw.mkv', 'msmpeg4v3', 'The selected MS-MPEG4 v3 track has no decoder configuration: fourcc: XVID' ],
        [ 'an MP42 VfW track on the H.263 route', 'msmpeg4v2-vfw.mkv', 'h263', 'The selected H.263 track has no decoder configuration: fourcc: MP42' ],
        [ 'an XVID AVI track on the H.263 route', 'mpeg4-b-xvid.avi', 'h263', 'The selected H.263 track has no decoder configuration: fourcc: XVID' ],
        [ 'an mp4v sample entry on the H.263 route', 'mpeg4-b.mp4', 'h263', 'The selected video track does not match the negotiated H.263 route: codec-id: mp4v' ],
        [ 'a V_MPEG4/MS/V3 track on the MS-MPEG4 v2 route', 'msmpeg4v3.mkv', 'msmpeg4v2', 'The selected video track does not match the negotiated MS-MPEG4 v2 route: codec-id: V_MPEG4/MS/V3' ],
        [ 'a codec-less AVI track on a route of another codec', 'h263.avi', 'hevc', 'The selected video track has no decode route: fourcc: H263' ]
    ])('refuses %s with the check that failed', async (_label: string, fileName: string, gpuVideoCodec: string, message: string) => {
        const request = createWorkerStartRequest(fileName, { ...FRAME_POOL_ROUTE, gpuVideoCodec });

        const responses = await runToStop(request);

        expect(responses).toContainEqual({ failureKind: 'source-unsupported', generation: request.generation, message, type: 'error' });
        expect(getPacketResponses(responses)).toEqual([]);
    });

    it.each([
        [ 'msmpeg4v3.avi', 'The selected video track has no decode route: fourcc: DIV3' ],
        [ 'msmpeg4v2-vfw.mkv', 'The selected video track has no decode route: codec-id: V_MS/VFW/FOURCC' ]
    ])('refuses codec-less %s on the browser\'s decoder, by its codec ID', async (fileName: string, message: string) => {
        const request = createWorkerStartRequest(fileName);

        const responses = await runToStop(request);

        expect(responses).toContainEqual({ failureKind: 'source-unsupported', generation: request.generation, message, type: 'error' });
    });
});
