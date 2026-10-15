// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    MAX_GPU_DECODE_PACKET_CREDITS,
    type DecodeWorkerResponse,
    type DecodeWorkerStartRequest
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';

import { createWorkerStartRequest, decodeToEnd, startDecodeWorker } from '../helpers/decodeWorkerHarness';
import { createHEVCMatroska } from '../helpers/hevcMatroskaVector';

const MATROSKA_FILE_NAME = 'hevc-main10.mkv';
// The frame-pool route for a GPU HEVC decoder writing I420P10, which decodes nothing in the worker
const FRAME_POOL_ROUTE: Partial<DecodeWorkerStartRequest> = {
    frameCredits: MAX_GPU_DECODE_PACKET_CREDITS,
    gpuVideoCodec: 'hevc',
    rawVideoFrameFormat: 'I420P10',
    videoDecoderBackend: 'gpu',
    videoOutputMode: 'frame-pool'
};
// The harness serves its media under /media/, a path a host's pattern names, and a pattern that names another path
const MEDIA_PATH_PATTERN = /\/media\/[^/]+\.mkv$/i;
const OTHER_PATH_PATTERN = /\/Videos\/[^/]+\/stream(?:\.[^/]+)?$/i;
const PARTIAL_CONTENT_STATUS = 206;
const CONTENT_RANGE_HEADER = 'Content-Range';
const CROSS_ORIGIN_RESPONSE_TYPE = 'cors';

/** Wraps the served fetch so every 206 arrives as a cross-origin response that hides its Content-Range, as some media servers send it. */
function hideContentRanges(): void {
    const servingFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, requestInit?: RequestInit): Promise<Response> => {
        const response = await servingFetch(input, requestInit);
        if (response.status !== PARTIAL_CONTENT_STATUS) {
            return response;
        }
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        const headers = new Headers(response.headers);
        headers.delete(CONTENT_RANGE_HEADER);
        const hiddenResponse = new Response(response.body, { headers, status: PARTIAL_CONTENT_STATUS });
        Object.defineProperty(hiddenResponse, 'type', { value: CROSS_ORIGIN_RESPONSE_TYPE });
        Object.defineProperty(hiddenResponse, 'url', { value: String(input) });
        return hiddenResponse;
    });
}

function createRequest(hiddenContentRangePathPattern: RegExp | null): DecodeWorkerStartRequest {
    const request = createWorkerStartRequest(MATROSKA_FILE_NAME, FRAME_POOL_ROUTE);
    if (request.source.kind !== 'url' || hiddenContentRangePathPattern === null) {
        return request;
    }
    return { ...request, source: { ...request.source, hiddenContentRangePathPattern } };
}

function getPacketCount(responses: readonly DecodeWorkerResponse[]): number {
    return responses.filter((response: DecodeWorkerResponse): boolean => response.type === 'packet').length;
}

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('CustomDecode.worker ranged reads of responses that hide Content-Range', () => {
    it('plays from a path the source\'s pattern names', async () => {
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, await createHEVCMatroska('length-prefixed') ] ]));
        hideContentRanges();

        const responses = await decodeToEnd(workerScope, createRequest(MEDIA_PATH_PATTERN));

        expect(getPacketCount(responses)).toBe(1);
    });

    it.each([
        { pattern: null, subject: 'no pattern' },
        { pattern: OTHER_PATH_PATTERN, subject: 'a pattern of another path' }
    ])('fails the run as range-unsupported with $subject', async ({ pattern }) => {
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, await createHEVCMatroska('length-prefixed') ] ]));
        hideContentRanges();
        const request = createRequest(pattern);

        workerScope.dispatchRequest(request);
        await workerScope.waitForStopped(request.generation);

        expect(workerScope.responses).toContainEqual(expect.objectContaining({ failureKind: 'range-unsupported', generation: request.generation, type: 'error' }));
        expect(getPacketCount(workerScope.responses)).toBe(0);
    });
});
