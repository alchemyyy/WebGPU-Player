// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MICROSECONDS_PER_SECOND, type Microseconds } from 'webgpu-player/MediaTime';
import type {
    DecodeWorkerPrefetchSourceRequest,
    DecodeWorkerResponse,
    DecodeWorkerStartRequest
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';

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

type ProbedRequest = Readonly<{
    signal: AbortSignal | null
    url: string
}>;

type FetchProbe = Readonly<{
    getRequestCount: () => number
    release: () => void
    requests: readonly ProbedRequest[]
}>;

// Eight VP9 frames in two groups of four, one cluster each, in WebM
const MEDIA_FILE_NAME = 'hdr10plus.webm';
// The same bytes at another URL, as another item's stream
const OTHER_MEDIA_FILE_NAME = 'other.webm';
const MEDIA_FILES = new Map<string, Uint8Array>([
    [ MEDIA_FILE_NAME, readVP9HDR10PlusVector(MEDIA_FILE_NAME) ],
    [ OTHER_MEDIA_FILE_NAME, readVP9HDR10PlusVector(MEDIA_FILE_NAME) ]
]);
const SECOND_KEY_FRAME_INDEX = VP9_HDR10_PLUS_EXPECTATIONS.frames.findIndex(
    (frame: HDR10PlusVectorFrame, frameIndex: number): boolean => frameIndex > 0 && frame.keyFrame
);
// The frame a seek lands in, after the second group's key frame, whose decode the run drops
const SEEK_FRAME_INDEX = SECOND_KEY_FRAME_INDEX + 1;
// Frames back and forth across both groups, as a viewer scrubs the timeline
const SCRUB_FRAME_INDEXES = [ 6, 1, 5, 0, 7, 3, 4, 2 ] as const;
const FIRST_GENERATION = 1;
const FIRST_PREFETCH_ID = 1;

/** Halfway into a frame, so a seek lands inside it. */
function getMidFrameMicroseconds(frameIndex: number): Microseconds {
    return Math.round(((frameIndex + 0.5) * MICROSECONDS_PER_SECOND) / VP9_HDR10_PLUS_EXPECTATIONS.frameRate) as Microseconds;
}

function createRequest(generation: number, frameIndex: number): DecodeWorkerStartRequest {
    return createWorkerStartRequest(MEDIA_FILE_NAME, { generation, startTimeMicroseconds: getMidFrameMicroseconds(frameIndex) });
}

/** Returns the URL the worker reads a served file from. */
function getServedURL(fileName: string): string {
    const source = createWorkerStartRequest(fileName).source;
    if (source.kind !== 'url') {
        throw new Error('The harness serves its files by URL');
    }
    return source.url;
}

/** Starts reading a served file's head before any run over it, as the page does while its host negotiates the playback. */
function createPrefetchRequest(prefetchId: number, fileName: string): DecodeWorkerPrefetchSourceRequest {
    return { prefetchId, source: { kind: 'url', url: getServedURL(fileName) }, type: 'prefetch-source' };
}

/**
 * Records the media requests the worker makes, and holds the first response back until released, so the reads of the first run, or of the
 * prefetch, wait on it.
 */
function probeFetches(): FetchProbe {
    const servingFetch = globalThis.fetch;
    const requests: ProbedRequest[] = [];
    let release = (): void => undefined;
    const released = new Promise<void>(resolve => {
        release = resolve;
    });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, requestInit?: RequestInit): Promise<Response> => {
        requests.push({ signal: requestInit?.signal ?? null, url: String(input) });
        if (requests.length === 1) {
            await released;
        }
        return servingFetch(input, requestInit);
    });
    return { getRequestCount: (): number => requests.length, release, requests };
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

describe('the playback worker over a prefetched source', () => {
    it('starts the head read before any run, and the run over the same URL continues on its response', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const fetchProbe = probeFetches();

        workerScope.dispatchRequest(createPrefetchRequest(FIRST_PREFETCH_ID, MEDIA_FILE_NAME));
        await vi.waitFor(() => {
            expect(fetchProbe.getRequestCount()).toBe(1);
        });
        expect(fetchProbe.requests[0].url).toBe(getServedURL(MEDIA_FILE_NAME));
        // The run's reads wait on the prefetch's response, which arrives only after the run started
        const decoding = decodeToEnd(workerScope, createRequest(FIRST_GENERATION, 0));
        fetchProbe.release();
        const responses = await decoding;

        expect(getErrorResponses(workerScope)).toEqual([]);
        expect(getFrameResponses(responses)).toHaveLength(VP9_HDR10_PLUS_EXPECTATIONS.frames.length);
        expect(fetchProbe.getRequestCount()).toBe(1);
    });

    it('aborts the head read of a prefetch that a run over another URL does not take, and reads that URL anew', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const fetchProbe = probeFetches();

        workerScope.dispatchRequest(createPrefetchRequest(FIRST_PREFETCH_ID, OTHER_MEDIA_FILE_NAME));
        await vi.waitFor(() => {
            expect(fetchProbe.getRequestCount()).toBe(1);
        });
        const decoding = decodeToEnd(workerScope, createRequest(FIRST_GENERATION, 0));
        await vi.waitFor(() => {
            expect(fetchProbe.requests[0].signal?.aborted).toBe(true);
        });
        fetchProbe.release();
        const responses = await decoding;

        expect(getErrorResponses(workerScope)).toEqual([]);
        expect(getFrameResponses(responses)).toHaveLength(VP9_HDR10_PLUS_EXPECTATIONS.frames.length);
        expect(fetchProbe.requests.map((request: ProbedRequest): string => request.url)).toEqual([
            getServedURL(OTHER_MEDIA_FILE_NAME),
            getServedURL(MEDIA_FILE_NAME)
        ]);
    });

    it('aborts the head read once its own prefetch is released, and leaves it to a release of another', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const fetchProbe = probeFetches();

        workerScope.dispatchRequest(createPrefetchRequest(FIRST_PREFETCH_ID, MEDIA_FILE_NAME));
        await vi.waitFor(() => {
            expect(fetchProbe.getRequestCount()).toBe(1);
        });
        workerScope.dispatchRequest({ prefetchId: FIRST_PREFETCH_ID + 1, type: 'release-prefetch' });
        expect(fetchProbe.requests[0].signal?.aborted).toBe(false);
        workerScope.dispatchRequest({ prefetchId: FIRST_PREFETCH_ID, type: 'release-prefetch' });
        expect(fetchProbe.requests[0].signal?.aborted).toBe(true);
        fetchProbe.release();

        // A run over the released URL reads it anew
        await decodeToEnd(workerScope, createRequest(FIRST_GENERATION, 0));
        expect(getErrorResponses(workerScope)).toEqual([]);
        expect(fetchProbe.getRequestCount()).toBe(2);
    });

    it('ignores a prefetch while a run holds the worker, and a release once a run took the prefetch over', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const fetchProbe = probeFetches();
        fetchProbe.release();

        workerScope.dispatchRequest(createPrefetchRequest(FIRST_PREFETCH_ID, MEDIA_FILE_NAME));
        const request = createRequest(FIRST_GENERATION, 0);
        workerScope.dispatchRequest(request);
        // The run holds the worker from its start, so another prefetch takes nothing from it
        workerScope.dispatchRequest(createPrefetchRequest(FIRST_PREFETCH_ID + 1, OTHER_MEDIA_FILE_NAME));
        // The release the page posts once the start is over arrives in a later task, after the run took the source over
        await new Promise<void>((resolve): void => {
            setTimeout(resolve, 0);
        });
        workerScope.dispatchRequest({ prefetchId: FIRST_PREFETCH_ID, type: 'release-prefetch' });
        await workerScope.waitForStopped(request.generation);
        await decodeToEnd(workerScope, createRequest(FIRST_GENERATION + 1, SEEK_FRAME_INDEX));

        expect(getErrorResponses(workerScope)).toEqual([]);
        expect(fetchProbe.getRequestCount()).toBe(1);
    });

    it('takes a prefetch once its run got stop, while the run still unwinds, and the next run continues on its response', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const fetchProbe = probeFetches();

        // The stopped run's read waits, so the run is still current, though stopped, when the prefetch arrives in the same task as its stop
        workerScope.dispatchRequest(createRequest(FIRST_GENERATION, 0));
        await vi.waitFor(() => {
            expect(fetchProbe.getRequestCount()).toBe(1);
        });
        workerScope.dispatchRequest({ generation: FIRST_GENERATION, type: 'stop' });
        workerScope.dispatchRequest(createPrefetchRequest(FIRST_PREFETCH_ID, OTHER_MEDIA_FILE_NAME));
        await vi.waitFor(() => {
            expect(fetchProbe.getRequestCount()).toBe(2);
        });
        expect(fetchProbe.requests[1].url).toBe(getServedURL(OTHER_MEDIA_FILE_NAME));
        fetchProbe.release();
        // The stopped run's release leaves the source the prefetch acquired after it
        await workerScope.waitForStopped(FIRST_GENERATION);
        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(OTHER_MEDIA_FILE_NAME, { generation: FIRST_GENERATION + 1 }));

        expect(getErrorResponses(workerScope)).toEqual([]);
        expect(getFrameResponses(responses)).toHaveLength(VP9_HDR10_PLUS_EXPECTATIONS.frames.length);
        expect(fetchProbe.getRequestCount()).toBe(2);
    });
});
