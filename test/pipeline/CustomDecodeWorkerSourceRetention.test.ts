// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MICROSECONDS_PER_SECOND, type Microseconds } from 'webgpu-player/MediaTime';
import type { DecodeWorkerResponse, DecodeWorkerStartRequest } from 'webgpu-player/pipeline/DecodeWorkerProtocol';

import {
    FakeVideoDecoder,
    createWorkerStartRequest,
    decodeToEnd,
    getFrameResponses,
    startDecodeWorker,
    type FakeWorkerScope
} from '../helpers/decodeWorkerHarness';
import type { HDR10PlusVectorFrame } from '../helpers/hdr10PlusVectors';
import { readVP9HDR10PlusVector, VP9_HDR10_PLUS_EXPECTATIONS } from '../helpers/vp9HDR10PlusVectors';

type FetchProbe = Readonly<{
    getRequestCount: () => number
    release: () => void
}>;

// Eight VP9 frames in two groups of four, one cluster each, in WebM
const MEDIA_FILE_NAME = 'hdr10plus.webm';
const MEDIA_FILES = new Map<string, Uint8Array>([ [ MEDIA_FILE_NAME, readVP9HDR10PlusVector(MEDIA_FILE_NAME) ] ]);
const SECOND_KEY_FRAME_INDEX = VP9_HDR10_PLUS_EXPECTATIONS.frames.findIndex(
    (frame: HDR10PlusVectorFrame, frameIndex: number): boolean => frameIndex > 0 && frame.keyFrame
);
// The frame a seek lands in, after the second group's key frame, whose decode the run drops
const SEEK_FRAME_INDEX = SECOND_KEY_FRAME_INDEX + 1;
// Frames back and forth across both groups, as a viewer scrubs the timeline
const SCRUB_FRAME_INDEXES = [ 6, 1, 5, 0, 7, 3, 4, 2 ] as const;
const FIRST_GENERATION = 1;

/** Halfway into a frame, so a seek lands inside it. */
function getMidFrameMicroseconds(frameIndex: number): Microseconds {
    return Math.round(((frameIndex + 0.5) * MICROSECONDS_PER_SECOND) / VP9_HDR10_PLUS_EXPECTATIONS.frameRate) as Microseconds;
}

function createRequest(generation: number, frameIndex: number): DecodeWorkerStartRequest {
    return createWorkerStartRequest(MEDIA_FILE_NAME, { generation, startTimeMicroseconds: getMidFrameMicroseconds(frameIndex) });
}

/** Counts the media requests the worker makes, and holds the first response back until released, so the first run's reads wait on it. */
function probeFetches(): FetchProbe {
    const servingFetch = globalThis.fetch;
    let requestCount = 0;
    let release = (): void => undefined;
    const released = new Promise<void>(resolve => {
        release = resolve;
    });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, requestInit?: RequestInit): Promise<Response> => {
        requestCount += 1;
        if (requestCount === 1) {
            await released;
        }
        return servingFetch(input, requestInit);
    });
    return { getRequestCount: (): number => requestCount, release };
}

function getErrorResponses(workerScope: FakeWorkerScope): DecodeWorkerResponse[] {
    return workerScope.responses.filter((response: DecodeWorkerResponse): boolean => response.type === 'error');
}

/** Requires a run that seeked into the second group to post its frames from the one the seek landed in. */
function requireSeekFrames(responses: readonly DecodeWorkerResponse[]): void {
    const decoder = FakeVideoDecoder.instances.at(-1);
    if (!decoder) {
        throw new Error('The run opened no decoder');
    }
    // The run decodes from the group's key frame, and drops the frames before the one the seek landed in
    expect(decoder.chunks.map(chunk => chunk.type === 'key')).toEqual(
        VP9_HDR10_PLUS_EXPECTATIONS.frames.slice(SECOND_KEY_FRAME_INDEX).map(frame => frame.keyFrame)
    );
    expect(getFrameResponses(responses).map(response => response.mediaTimeMicroseconds)).toEqual(
        decoder.chunks.slice(SEEK_FRAME_INDEX - SECOND_KEY_FRAME_INDEX).map(chunk => chunk.timestamp)
    );
}

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the playback worker over one URL from run to run', () => {
    it('reads on the stopped run\'s response, though the run stopped while its read waited', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const fetchProbe = probeFetches();

        workerScope.dispatchRequest(createRequest(FIRST_GENERATION, 0));
        await vi.waitFor(() => {
            expect(fetchProbe.getRequestCount()).toBe(1);
        });
        workerScope.dispatchRequest({ generation: FIRST_GENERATION, type: 'stop' });
        await workerScope.waitForStopped(FIRST_GENERATION);
        fetchProbe.release();
        const responses = await decodeToEnd(workerScope, createRequest(FIRST_GENERATION + 1, SEEK_FRAME_INDEX));

        expect(getErrorResponses(workerScope)).toEqual([]);
        requireSeekFrames(responses);
        expect(fetchProbe.getRequestCount()).toBe(1);
    });

    it('plays on from a seek after rapid scrubbing, with every run reading the one source', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const fetchProbe = probeFetches();
        fetchProbe.release();

        let generation = FIRST_GENERATION;
        for (const [ scrubIndex, frameIndex ] of SCRUB_FRAME_INDEXES.entries()) {
            const request = createRequest(generation, frameIndex);
            workerScope.dispatchRequest(request);
            // Every other run stops once ready, the rest before they open their input
            if (scrubIndex % 2 === 0) {
                await workerScope.waitForResponse(response => response.type === 'ready' && response.generation === request.generation);
            }
            workerScope.dispatchRequest({ generation: request.generation, type: 'stop' });
            await workerScope.waitForStopped(request.generation);
            generation += 1;
        }
        const responses = await decodeToEnd(workerScope, createRequest(generation, SEEK_FRAME_INDEX));

        expect(getErrorResponses(workerScope)).toEqual([]);
        requireSeekFrames(responses);
        expect(fetchProbe.getRequestCount()).toBe(1);
    });
});
