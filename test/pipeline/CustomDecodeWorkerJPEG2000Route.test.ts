// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    MAX_GPU_DECODE_PACKET_CREDITS,
    type DecodeWorkerResponse,
    type DecodeWorkerStartRequest
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';

import { createWorkerStartRequest, decodeToEnd, FakeVideoDecoder, getReadyResponse, startDecodeWorker } from '../helpers/decodeWorkerHarness';
import { DECODERS_DIRECTORY } from '../helpers/enginePaths';
import { createVFWCodecPrivate, createVFWMatroska, VC1_TEST_FRAME_DURATION_MILLISECONDS } from '../helpers/vc1Media';

const VECTOR_DIRECTORY = join(DECODERS_DIRECTORY, 'jpeg2000', 'vectors');
// FFmpeg's Matroska remux of the Digital Cinema 2K profile in X'Y'Z': a V_MS/VFW/FOURCC track of mjp2, 5.1 FLAC, and a JPEG cover attachment
const DIGITAL_CINEMA_FILE_NAME = 'openjpeg-97-cinema2k-xyz12.mkv';
const DIGITAL_CINEMA_WIDTH = 160;
const DIGITAL_CINEMA_HEIGHT = 90;
// Its blocks' times: three frames at 24 per second, in Matroska's milliseconds
const DIGITAL_CINEMA_TIMES_MICROSECONDS = [ 0, 42_000, 83_000 ];
const MOTION_JPEG2000_FILE_NAME = 'openjpeg-97-ict-pcrl-444p12.mj2';
const MOTION_JPEG2000_FRAME_COUNT = 3;
const SYNTHETIC_FILE_NAME = 'vfw.mkv';
// A bare codestream's start, SOC then SIZ, and its Rsiz after Lsiz: the Digital Cinema 2K profile
const CODESTREAM_START = [ 0xFF, 0x4F, 0xFF, 0x51 ];
const RSIZ_OFFSET = 6;
const DIGITAL_CINEMA_2K_PROFILE = 3;
// The synthetic VfW tracks' blocks, which the worker passes on unread: three codestream starts
const SYNTHETIC_CODESTREAMS = [ 1, 2, 3 ].map((frame: number): Uint8Array => new Uint8Array([ ...CODESTREAM_START, frame ]));
// The decoder codec of the JPEG 2000 route, the MJ2 sample entry
const DECODER_CODEC = 'mjp2';
// The GPU decoder's frame-pool route, which writes an XYZ picture as 12-bit 4:4:4
const FRAME_POOL_ROUTE: Partial<DecodeWorkerStartRequest> = {
    frameCredits: MAX_GPU_DECODE_PACKET_CREDITS,
    gpuVideoCodec: 'jpeg2000',
    rawVideoFrameFormat: 'I444P12',
    videoDecoderBackend: 'gpu',
    videoOutputMode: 'frame-pool'
};

type PacketResponse = Extract<DecodeWorkerResponse, { type: 'packet' }>;

function getPacketResponses(responses: readonly DecodeWorkerResponse[]): PacketResponse[] {
    return responses.filter((response: DecodeWorkerResponse): response is PacketResponse => response.type === 'packet');
}

function readVector(fileName: string): Uint8Array {
    return new Uint8Array(readFileSync(join(VECTOR_DIRECTORY, fileName)));
}

async function runToEnd(fileName: string, media: Uint8Array): Promise<DecodeWorkerResponse[]> {
    const workerScope = await startDecodeWorker(new Map([ [ fileName, media ] ]));
    return decodeToEnd(workerScope, createWorkerStartRequest(fileName, FRAME_POOL_ROUTE));
}

/** A Matroska VfW track of a FourCC, whose blocks are the synthetic codestreams. */
function createSyntheticVFWMatroska(fourCC: string): Uint8Array {
    const codecPrivate = createVFWCodecPrivate(fourCC, DIGITAL_CINEMA_WIDTH, DIGITAL_CINEMA_HEIGHT, new Uint8Array(0));
    return createVFWMatroska(codecPrivate, DIGITAL_CINEMA_WIDTH, DIGITAL_CINEMA_HEIGHT, SYNTHETIC_CODESTREAMS.map((data: Uint8Array, index: number) => ({
        data,
        keyframe: true,
        timestampMilliseconds: index * VC1_TEST_FRAME_DURATION_MILLISECONDS
    })));
}

beforeEach(() => {
    vi.resetModules();
    // Mediabunny warns that it maps no codec to a Video for Windows track, which only a decoder package decodes
    vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('CustomDecode.worker JPEG 2000 frame-pool route', () => {
    it('posts a Matroska VfW mjp2 track\'s bare Digital Cinema codestreams at their times, without codec private data, past its cover and audio', async () => {
        const responses = await runToEnd(DIGITAL_CINEMA_FILE_NAME, readVector(DIGITAL_CINEMA_FILE_NAME));

        const ready = getReadyResponse(responses);
        expect(ready).toMatchObject({ codec: DECODER_CODEC, codedHeight: DIGITAL_CINEMA_HEIGHT, codedWidth: DIGITAL_CINEMA_WIDTH });
        expect(ready).not.toHaveProperty('codecPrivate');
        const packets = getPacketResponses(responses);
        expect(packets.map(packet => packet.timestampMicroseconds)).toEqual(DIGITAL_CINEMA_TIMES_MICROSECONDS);
        for (const packet of packets) {
            const data = new Uint8Array(packet.data);
            expect(Array.from(data.subarray(0, CODESTREAM_START.length))).toEqual(CODESTREAM_START);
            expect(new DataView(data.buffer, data.byteOffset).getUint16(RSIZ_OFFSET)).toBe(DIGITAL_CINEMA_2K_PROFILE);
        }
        expect(FakeVideoDecoder.instances).toEqual([]);
    });

    it('posts an MJ2 track\'s samples on the same route', async () => {
        const responses = await runToEnd(MOTION_JPEG2000_FILE_NAME, readVector(MOTION_JPEG2000_FILE_NAME));

        expect(getReadyResponse(responses)).toMatchObject({ codec: DECODER_CODEC });
        expect(getPacketResponses(responses)).toHaveLength(MOTION_JPEG2000_FRAME_COUNT);
    });

    it('takes a VfW track of any FourCC FFmpeg maps to JPEG 2000, in either case', async () => {
        const responses = await runToEnd(SYNTHETIC_FILE_NAME, createSyntheticVFWMatroska('MJ2C'));

        expect(getPacketResponses(responses).map(packet => new Uint8Array(packet.data))).toEqual(SYNTHETIC_CODESTREAMS);
    });

    it('refuses a VfW track of another FourCC on the JPEG 2000 route with the check that failed', async () => {
        const workerScope = await startDecodeWorker(new Map([ [ SYNTHETIC_FILE_NAME, createSyntheticVFWMatroska('XVID') ] ]));
        const request = createWorkerStartRequest(SYNTHETIC_FILE_NAME, FRAME_POOL_ROUTE);

        workerScope.dispatchRequest(request);
        await workerScope.waitForStopped(request.generation);

        expect(workerScope.responses).toContainEqual({
            failureKind: 'source-unsupported',
            generation: request.generation,
            message: 'The selected JPEG 2000 track has no decoder configuration: fourcc: XVID',
            type: 'error'
        });
        expect(getPacketResponses(workerScope.responses)).toEqual([]);
    });
});
