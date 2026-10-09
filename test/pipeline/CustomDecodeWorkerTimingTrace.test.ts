// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    isDecodeWorkerRequest,
    isDecodeWorkerResponse,
    type DecodeWorkerResponse
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import type { WorkerTimingTraceEvent } from 'webgpu-player/TimingTrace';

import {
    createWorkerStartRequest,
    getFrameResponses,
    startDecodeWorker
} from '../helpers/decodeWorkerHarness';
import {
    readVP9HDR10PlusVector,
    VP9_HDR10_PLUS_EXPECTATIONS
} from '../helpers/vp9HDR10PlusVectors';

const [ TRACED_VECTOR ] = VP9_HDR10_PLUS_EXPECTATIONS.vectors;
const MEDIA_FILES = new Map<string, Uint8Array>([
    [ TRACED_VECTOR.fileName, readVP9HDR10PlusVector(TRACED_VECTOR.fileName) ]
]);
const SUCCESSFUL_RANGE_STATUS = 206;

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function getTimingEvents(responses: readonly DecodeWorkerResponse[]): WorkerTimingTraceEvent[] {
    return responses.flatMap((response: DecodeWorkerResponse): readonly WorkerTimingTraceEvent[] => (
        response.type === 'timing-trace' ? response.events : []
    ));
}

describe('the playback worker with a timing trace', () => {
    it('sends its fetch, packet read, and frame output timing before it reports the run stopped', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const request = createWorkerStartRequest(TRACED_VECTOR.fileName, { timingTrace: true });
        expect(isDecodeWorkerRequest(request)).toBe(true);

        workerScope.dispatchRequest(request);
        await workerScope.stopped;

        const responses = workerScope.responses;
        const responseTypes = responses.map(response => response.type);
        expect(responseTypes).not.toContain('error');
        expect(responseTypes.slice(-2)).toEqual([ 'timing-trace', 'stopped' ]);
        // The session drops any response its validator rejects
        expect(responses.filter(response => !isDecodeWorkerResponse(response))).toEqual([]);

        const events = getTimingEvents(responses);
        const fetchEvents = events.filter(event => event.kind === 'fetch');
        expect(fetchEvents.length).toBeGreaterThan(0);
        expect(fetchEvents.every(event => event.fields.status === SUCCESSFUL_RANGE_STATUS)).toBe(true);
        expect(events.some(event => event.kind === 'video-read' && event.fields.source === 'packet')).toBe(true);
        // Every posted frame has its output event, in posting order
        expect(events.filter(event => event.kind === 'video-frame-output').map(event => event.fields.mediaTimeMicroseconds)).toEqual(
            getFrameResponses(responses).map(response => response.mediaTimeMicroseconds)
        );
    });

    it('sends no timing events when the page records no trace', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);

        workerScope.dispatchRequest(createWorkerStartRequest(TRACED_VECTOR.fileName));
        await workerScope.stopped;

        expect(workerScope.responses.map(response => response.type)).not.toContain('timing-trace');
    });
});
