// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DecodeWorkerResponse } from 'webgpu-player/pipeline/DecodeWorkerProtocol';

import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../helpers/enginePaths';
import { createWorkerStartRequest, startDecodeWorker } from '../helpers/decodeWorkerHarness';

// An H.264 track, which decodes through Mediabunny's sample cursor
const H264_FILE_NAME = 'h264-bframes-mp3-vbr.avi';
const MEDIA_FILES = new Map<string, Uint8Array>([
    [ H264_FILE_NAME, new Uint8Array(readFileSync(join(CODEC_VECTOR_ASSETS_DIRECTORY, 'avi', H264_FILE_NAME))) ]
]);
// What the fork's cursor rejects a start with when the track has no key packet decoding can start at
const NO_STARTING_KEY_PACKET_MESSAGE = 'The track has no key packet that decoding can start at.';
const OTHER_CURSOR_MESSAGE = 'Decoding error.';

type ErrorResponse = Extract<DecodeWorkerResponse, { type: 'error' }>;

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.doUnmock('webgpu-player/demux/TrackIteration');
    vi.unstubAllGlobals();
});

/** Runs the H.264 track with a sample cursor whose first read rejects with a message, and returns the run's failure. */
async function runWithRejectedCursor(message: string): Promise<ErrorResponse | undefined> {
    // The worker imports the iteration module after this reset, so it takes the cursor that rejects
    vi.doMock('webgpu-player/demux/TrackIteration', async (importOriginal) => ({
        ...await importOriginal<typeof import('webgpu-player/demux/TrackIteration')>(),
        iterateVideoSamples: () => {
            const iterator = {
                next: (): Promise<never> => Promise.reject(new Error(message)),
                return: async (): Promise<IteratorReturnResult<undefined>> => ({ done: true, value: undefined }),
                [Symbol.asyncIterator]: () => iterator
            };
            return iterator;
        }
    }));
    const workerScope = await startDecodeWorker(MEDIA_FILES);
    const request = createWorkerStartRequest(H264_FILE_NAME);
    workerScope.dispatchRequest(request);
    await workerScope.waitForStopped(request.generation);
    return workerScope.responses.find((response): response is ErrorResponse => response.type === 'error');
}

describe('the playback worker\'s failure kinds', () => {
    it('reports a track without a key packet decoding can start at as a source no route can play', async () => {
        await expect(runWithRejectedCursor(NO_STARTING_KEY_PACKET_MESSAGE)).resolves.toMatchObject({ failureKind: 'source-unsupported' });
    });

    it('keeps any other failure of the sample cursor a decode failure', async () => {
        await expect(runWithRejectedCursor(OTHER_CURSOR_MESSAGE)).resolves.toMatchObject({ failureKind: 'decode-failed' });
    });
});
