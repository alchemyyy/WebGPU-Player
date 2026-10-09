// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type MockInstance
} from 'vitest';

import {
    MAX_DECODED_RAW_FRAME_CREDITS,
    type DecodeWorkerStartRequest
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import { createDolbyVisionAuthorizationRPUVector } from 'webgpu-player/capability/vectors/DolbyVisionAuthorizationVector';
import type DolbyVisionRPUParserSession from 'webgpu-player/video/dolby-vision/DolbyVisionRPUParserSession';

import {
    AV1_HDR10_PLUS_EXPECTATIONS,
    AV1_HDR10_PLUS_STATIC_HDR_METADATA,
    readAV1HDR10PlusVector
} from '../helpers/av1HDR10PlusVectors';
import {
    DOLBY_VISION_RPU_PARSER_WASM_URL,
    FakeVideoDecoder,
    createWorkerStartRequest,
    decodeToEnd,
    getFrameResponses,
    getReadyResponse,
    startDecodeWorker
} from '../helpers/decodeWorkerHarness';
import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../helpers/enginePaths';
import { requirePostedHDR10PlusResult } from '../helpers/hdr10PlusVectors';

const HDR10_PLUS_MATROSKA_FILE_NAME = 'hdr10plus.mkv';
const HDR10_PLUS_MP4_FILE_NAME = 'hdr10plus.mp4';
const DOLBY_VISION_FILE_NAME = 'profile10.1.mkv';
// The Profile 10.1 vector has four frames; its RPUs code Profile 8
const DOLBY_VISION_VECTOR_FRAME_COUNT = 4;
const DOLBY_VISION_RPU_PROFILE = 8;
// metadata_type 4 and the Dolby Vision ITU-T T.35 header, which start every RPU metadata OBU payload
const DOLBY_VISION_METADATA_PREFIX: readonly number[] = [ 0x04, 0xB5, 0x00, 0x3B, 0x00, 0x00, 0x08, 0x00 ];
// A raw-plane route in I420P10, whose frame credits are its raw buffers
const RAW_I420P10_ROUTE: Partial<DecodeWorkerStartRequest> = {
    frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
    rawVideoFrameFormat: 'I420P10',
    videoOutputMode: 'raw-planes'
};
const FRAMES = AV1_HDR10_PLUS_EXPECTATIONS.frames;
const MEDIA_FILES = new Map<string, Uint8Array>([
    [ HDR10_PLUS_MATROSKA_FILE_NAME, readAV1HDR10PlusVector(HDR10_PLUS_MATROSKA_FILE_NAME) ],
    [ HDR10_PLUS_MP4_FILE_NAME, readAV1HDR10PlusVector(HDR10_PLUS_MP4_FILE_NAME) ],
    [
        DOLBY_VISION_FILE_NAME,
        new Uint8Array(readFileSync(resolve(CODEC_VECTOR_ASSETS_DIRECTORY, 'dolby-vision-av1', DOLBY_VISION_FILE_NAME)))
    ]
]);

function containsBytes(data: Uint8Array, bytes: readonly number[]): boolean {
    for (let offset = 0; offset + bytes.length <= data.byteLength; offset += 1) {
        if (bytes.every((byteValue: number, byteIndex: number): boolean => data[offset + byteIndex] === byteValue)) {
            return true;
        }
    }
    return false;
}

function getDecodedChunks(): readonly Uint8Array[] {
    expect(FakeVideoDecoder.instances).toHaveLength(1);
    return FakeVideoDecoder.instances[0].chunks.map(chunk => chunk.data);
}

/** Spies on the RPU parser sessions of the worker module that the next import loads. */
async function spyOnRPUParserSessions(): Promise<MockInstance<typeof DolbyVisionRPUParserSession.create>> {
    const { default: RPUParserSession } = await import('webgpu-player/video/dolby-vision/DolbyVisionRPUParserSession');
    return vi.spyOn(RPUParserSession, 'create');
}

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('CustomDecode.worker AV1 route', () => {
    it.each([ HDR10_PLUS_MATROSKA_FILE_NAME, HDR10_PLUS_MP4_FILE_NAME ])(
        'decodes %s through the owned path and posts each raw frame with its own HDR10+ result',
        async (fileName: string) => {
            const createSession = await spyOnRPUParserSessions();
            const workerScope = await startDecodeWorker(MEDIA_FILES);

            const responses = await decodeToEnd(workerScope, createWorkerStartRequest(fileName, RAW_I420P10_ROUTE));

            expect(createSession).not.toHaveBeenCalled();
            expect(getDecodedChunks()).toHaveLength(AV1_HDR10_PLUS_EXPECTATIONS.frameCount);
            expect(getReadyResponse(responses).staticHDRMetadataScan).toEqual({
                accessUnitCount: AV1_HDR10_PLUS_EXPECTATIONS.frameCount,
                firstMetadataAccessUnitIndex: 0,
                metadata: AV1_HDR10_PLUS_STATIC_HDR_METADATA,
                status: 'valid'
            });
            const frameResponses = getFrameResponses(responses);
            expect(frameResponses.map(response => response.outputMode)).toEqual(FRAMES.map(() => 'raw-planes'));
            // Mediabunny's sample sink never attaches HDR10+, so every frame carrying its own proves the owned path
            for (const [ frameIndex, frameResponse ] of frameResponses.entries()) {
                requirePostedHDR10PlusResult(frameResponse.HDR10PlusMetadata, FRAMES[frameIndex]);
            }
            expect(frameResponses.map(response => response.encodedDolbyVisionMetadata)).toEqual(FRAMES.map(() => undefined));
        }
    );

    it('posts each VideoFrame with its own HDR10+ result', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(HDR10_PLUS_MATROSKA_FILE_NAME));

        const frameResponses = getFrameResponses(responses);
        expect(frameResponses.map(response => response.outputMode)).toEqual(FRAMES.map(() => 'video-frame'));
        for (const [ frameIndex, frameResponse ] of frameResponses.entries()) {
            requirePostedHDR10PlusResult(frameResponse.HDR10PlusMetadata, FRAMES[frameIndex]);
        }
    });

    it('loads the RPU parser on a Dolby Vision route and parses each RPU for its frame', async () => {
        const createSession = await spyOnRPUParserSessions();
        const session = {
            close: vi.fn(),
            parseAV1ITUTT35: vi.fn((): Promise<ArrayBuffer> => Promise.resolve(
                createDolbyVisionAuthorizationRPUVector(DOLBY_VISION_RPU_PROFILE)
            ))
        };
        createSession.mockReturnValue(session as unknown as DolbyVisionRPUParserSession);
        const workerScope = await startDecodeWorker(MEDIA_FILES);

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(DOLBY_VISION_FILE_NAME, {
            ...RAW_I420P10_ROUTE,
            dolbyVisionProfile: DOLBY_VISION_RPU_PROFILE
        }));

        expect(createSession).toHaveBeenCalledOnce();
        expect(createSession.mock.calls[0][0]).toBe(DOLBY_VISION_RPU_PARSER_WASM_URL);
        expect(session.parseAV1ITUTT35).toHaveBeenCalledTimes(DOLBY_VISION_VECTOR_FRAME_COUNT);
        expect(session.close).toHaveBeenCalledOnce();
        expect(getReadyResponse(responses).staticHDRMetadataScan).toBeUndefined();
        const frameResponses = getFrameResponses(responses);
        expect(frameResponses.map(response => response.encodedDolbyVisionMetadata?.parsedRPUData)).toEqual(
            new Array(DOLBY_VISION_VECTOR_FRAME_COUNT).fill([ expect.any(ArrayBuffer) ])
        );
        expect(frameResponses.map(response => response.HDR10PlusMetadata?.status)).toEqual(
            new Array(DOLBY_VISION_VECTOR_FRAME_COUNT).fill('absent')
        );
        expect(getDecodedChunks().some(chunk => containsBytes(chunk, DOLBY_VISION_METADATA_PREFIX))).toBe(false);
    });

    it('strips the RPUs of a Dolby Vision track unparsed on a route without Dolby Vision', async () => {
        const createSession = await spyOnRPUParserSessions();
        const workerScope = await startDecodeWorker(MEDIA_FILES);

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(DOLBY_VISION_FILE_NAME, RAW_I420P10_ROUTE));

        expect(createSession).not.toHaveBeenCalled();
        const frameResponses = getFrameResponses(responses);
        expect(frameResponses).toHaveLength(DOLBY_VISION_VECTOR_FRAME_COUNT);
        expect(frameResponses.map(response => response.encodedDolbyVisionMetadata)).toEqual(
            new Array(DOLBY_VISION_VECTOR_FRAME_COUNT).fill(undefined)
        );
        // Mediabunny's sample sink would pass the RPU OBUs to the decoder, so their absence proves the owned path
        const decodedChunks = getDecodedChunks();
        expect(decodedChunks).toHaveLength(DOLBY_VISION_VECTOR_FRAME_COUNT);
        expect(decodedChunks.some(chunk => containsBytes(chunk, DOLBY_VISION_METADATA_PREFIX))).toBe(false);
        // The PQ base has a PQ sequence header but no MDCV or CLL metadata OBU
        expect(getReadyResponse(responses).staticHDRMetadataScan?.status).toBe('absent');
    });
});
