// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    FakeVideoDecoder,
    createWorkerStartRequest,
    decodeToEnd,
    getFrameResponses,
    getReadyResponse,
    startDecodeWorker
} from '../helpers/decodeWorkerHarness';
import { requirePostedHDR10PlusResult } from '../helpers/hdr10PlusVectors';
import {
    readVP9HDR10PlusVector,
    VP9_HDR10_PLUS_EXPECTATIONS,
    type VP9HDR10PlusVector
} from '../helpers/vp9HDR10PlusVectors';

const VP9_PROFILE_2_CODEC_PREFIX = 'vp09.02.';
const MEDIA_FILES = new Map<string, Uint8Array>(VP9_HDR10_PLUS_EXPECTATIONS.vectors.map(vector => [
    vector.fileName,
    readVP9HDR10PlusVector(vector.fileName)
]));

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the playback worker on a VP9 track', () => {
    it.each(VP9_HDR10_PLUS_EXPECTATIONS.vectors.map(vector => [ vector.fileName, vector ] as const))(
        'decodes %s in the owned VP9 path and posts each frame with its HDR10+',
        async (_fileName: string, vector: VP9HDR10PlusVector) => {
            const workerScope = await startDecodeWorker(MEDIA_FILES);

            const responses = await decodeToEnd(workerScope, createWorkerStartRequest(vector.fileName));

            expect(getReadyResponse(responses).codec.startsWith(VP9_PROFILE_2_CODEC_PREFIX)).toBe(true);
            // The owned path decodes every packet in its one native decoder
            expect(FakeVideoDecoder.instances).toHaveLength(1);
            const [ decoder ] = FakeVideoDecoder.instances;
            expect(decoder.configuration).toMatchObject({ optimizeForLatency: true });
            expect(decoder.configuration?.codec.startsWith(VP9_PROFILE_2_CODEC_PREFIX)).toBe(true);
            expect(decoder.chunks.map(chunk => chunk.type === 'key')).toEqual(
                VP9_HDR10_PLUS_EXPECTATIONS.frames.map(frame => frame.keyFrame)
            );
            expect(decoder.state).toBe('closed');

            const frameResponses = getFrameResponses(responses);
            expect(frameResponses.map(response => response.mediaTimeMicroseconds)).toEqual(
                decoder.chunks.map(chunk => chunk.timestamp)
            );
            // Mediabunny's sample sink never attaches HDR10+, so every frame carrying it proves the owned path
            for (const [ frameIndex, frameResponse ] of frameResponses.entries()) {
                expect(frameResponse.outputMode).toBe('video-frame');
                requirePostedHDR10PlusResult(frameResponse.HDR10PlusMetadata, VP9_HDR10_PLUS_EXPECTATIONS.frames[frameIndex]);
            }
        }
    );
});
