// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { secondsToMicroseconds } from 'webgpu-player/MediaTime';

import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../helpers/enginePaths';
import {
    createWorkerStartRequest,
    decodeToEnd,
    getFrameResponses,
    getReadyResponse,
    startDecodeWorker
} from '../helpers/decodeWorkerHarness';

// The FFmpeg-made vectors of scripts/codec_vector_assets/generate_AVI_demux_vectors.py
const AVI_VECTOR_DIRECTORY = join(CODEC_VECTOR_ASSETS_DIRECTORY, 'avi');
const VP9_FILE_NAME = 'vp9-aac.avi';
const HEVC_FILE_NAME = 'hevc-ac3.avi';
const MPEG4_FILE_NAME = 'mpeg4-mp3.avi';
const OPENDML_FILE_NAME = 'opendml-like.avi';
const VIDEO_FRAME_COUNT = 12;
const VIDEO_FRAME_RATE = 24;
const DROPPED_FRAME_SLOT_COUNT = 1;
// Seconds round to whole microseconds once in the demuxer and once on the way out
const ROUNDING_TOLERANCE_MICROSECONDS = 1;
const VP9_CODEC_PREFIX = 'vp09.';
// dwLength of the first stream header, after its fourcc and size, as AVIDemux.test.ts patches it
const STREAM_HEADER_FOURCC = 'strh';
const STREAM_HEADER_LENGTH_OFFSET = 8 + 32;
const OPENDML_DECLARED_FRAME_COUNT = 10_000;
const MPEG4_MESSAGE = 'The selected video codec has no decode route: mpeg4';
const HEVC_MESSAGE = 'The selected AVI video track has no presentation order: hevc';
const OPENDML_MESSAGE = 'The selected AVI video track outruns its idx1 index: opendml-index-unread';

function readAVIVector(fileName: string): Uint8Array {
    return new Uint8Array(readFileSync(join(AVI_VECTOR_DIRECTORY, fileName)));
}

/** Declares far more frames in the first stream header than idx1 indexes, as the first RIFF list of an OpenDML file does. */
function createOpenDMLLikeAVI(): Uint8Array {
    const bytes = readAVIVector(VP9_FILE_NAME);
    const streamHeaderOffset = Buffer.from(bytes).indexOf(STREAM_HEADER_FOURCC);
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(streamHeaderOffset + STREAM_HEADER_LENGTH_OFFSET, OPENDML_DECLARED_FRAME_COUNT, true);
    return bytes;
}

const MEDIA_FILES = new Map<string, Uint8Array>([
    [ VP9_FILE_NAME, readAVIVector(VP9_FILE_NAME) ],
    [ HEVC_FILE_NAME, readAVIVector(HEVC_FILE_NAME) ],
    [ MPEG4_FILE_NAME, readAVIVector(MPEG4_FILE_NAME) ],
    [ OPENDML_FILE_NAME, createOpenDMLLikeAVI() ]
]);

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the playback worker on AVI', () => {
    it('decodes VP9 through the owned VP9 path, one packet per frame slot', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(VP9_FILE_NAME));

        expect(getReadyResponse(responses).codec.startsWith(VP9_CODEC_PREFIX)).toBe(true);
        const frameTimes = getFrameResponses(responses).map(response => response.mediaTimeMicroseconds);
        expect(frameTimes).toHaveLength(VIDEO_FRAME_COUNT);
        // FFmpeg's muxer drops the second slot into an empty chunk, so the frames after it run one slot late
        frameTimes.forEach((frameTime: number, frameIndex: number): void => {
            const frameSlot = frameIndex === 0 ? 0 : frameIndex + DROPPED_FRAME_SLOT_COUNT;
            expect(Math.abs(frameTime - secondsToMicroseconds(frameSlot / VIDEO_FRAME_RATE))).toBeLessThanOrEqual(ROUNDING_TOLERANCE_MICROSECONDS);
        });
    });

    it.each([
        [ MPEG4_FILE_NAME, MPEG4_MESSAGE ],
        [ HEVC_FILE_NAME, HEVC_MESSAGE ],
        [ OPENDML_FILE_NAME, OPENDML_MESSAGE ]
    ])('refuses %s with the check that failed', async (fileName: string, message: string) => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const request = createWorkerStartRequest(fileName);

        workerScope.dispatchRequest(request);
        await workerScope.waitForStopped(request.generation);

        expect(workerScope.responses).toContainEqual({ failureKind: 'source-unsupported', generation: request.generation, message, type: 'error' });
        expect(getFrameResponses(workerScope.responses)).toEqual([]);
    });
});
