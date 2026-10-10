// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DecodeWorkerResponse } from 'webgpu-player/pipeline/DecodeWorkerProtocol';

import {
    FakeVideoDecoder,
    createWorkerStartRequest,
    decodeToEnd,
    getFrameResponses,
    startDecodeWorker
} from '../helpers/decodeWorkerHarness';
import {
    readVP9HDR10PlusVector,
    VP9_HDR10_PLUS_EXPECTATIONS
} from '../helpers/vp9HDR10PlusVectors';

const [ LIFECYCLE_VECTOR ] = VP9_HDR10_PLUS_EXPECTATIONS.vectors;
const MEDIA_FILES = new Map<string, Uint8Array>([
    [ LIFECYCLE_VECTOR.fileName, readVP9HDR10PlusVector(LIFECYCLE_VECTOR.fileName) ]
]);
const FIRST_RUN_GENERATION = 11;
const SECOND_RUN_GENERATION = 12;
const UNHANDLED_REJECTION_EVENT = 'unhandledrejection';
const LEFT_OPEN_DECODER_FAILURE_MESSAGE = 'A custom decoder call failed';

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function getResponseTypes(responses: readonly DecodeWorkerResponse[], generation: number): DecodeWorkerResponse['type'][] {
    const responseTypes: DecodeWorkerResponse['type'][] = [];
    for (const response of responses) {
        if (response.generation === generation) {
            responseTypes.push(response.type);
        }
    }
    return responseTypes;
}

/** Dispatches the rejection Mediabunny leaves when it skips a failed decoder's close() */
function dispatchUnhandledRejection(scope: EventTarget, reason: unknown): Event {
    const event = new Event(UNHANDLED_REJECTION_EVENT, { cancelable: true });
    Object.defineProperty(event, 'reason', { value: reason });
    scope.dispatchEvent(event);
    return event;
}

describe('the playback worker across generations', () => {
    it('runs one generation after another in the same worker', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);

        const firstResponses = await decodeToEnd(workerScope, createWorkerStartRequest(LIFECYCLE_VECTOR.fileName, {
            generation: FIRST_RUN_GENERATION
        }));
        // A seek starts the next generation in the worker the first one used
        const secondResponses = await decodeToEnd(workerScope, createWorkerStartRequest(LIFECYCLE_VECTOR.fileName, {
            generation: SECOND_RUN_GENERATION
        }));

        expect(secondResponses.every(response => response.generation === SECOND_RUN_GENERATION)).toBe(true);
        expect(getFrameResponses(secondResponses).map(response => response.mediaTimeMicroseconds)).toEqual(
            getFrameResponses(firstResponses).map(response => response.mediaTimeMicroseconds)
        );
        // Each run opens its own decoder and closes it before its stopped
        expect(FakeVideoDecoder.instances).toHaveLength(2);
        expect(FakeVideoDecoder.instances.map(decoder => decoder.state)).toEqual([ 'closed', 'closed' ]);
    });

    it('starts a superseding generation only after the replaced run posted stopped', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const firstRunReady = workerScope.waitForResponse(
            response => response.type === 'ready' && response.generation === FIRST_RUN_GENERATION
        );
        workerScope.dispatchRequest(createWorkerStartRequest(LIFECYCLE_VECTOR.fileName, {
            generation: FIRST_RUN_GENERATION
        }));
        await firstRunReady;

        // The next start arrives while the first run decodes, without a stop
        await decodeToEnd(workerScope, createWorkerStartRequest(LIFECYCLE_VECTOR.fileName, {
            generation: SECOND_RUN_GENERATION
        }));

        const responses = workerScope.responses;
        const firstRunResponseTypes = getResponseTypes(responses, FIRST_RUN_GENERATION);
        expect(firstRunResponseTypes).not.toContain('ended');
        expect(firstRunResponseTypes.filter(responseType => responseType === 'stopped')).toHaveLength(1);
        const firstRunStoppedIndex = responses.findIndex(
            response => response.type === 'stopped' && response.generation === FIRST_RUN_GENERATION
        );
        const secondRunFirstResponseIndex = responses.findIndex(response => response.generation === SECOND_RUN_GENERATION);
        expect(secondRunFirstResponseIndex).toBeGreaterThan(firstRunStoppedIndex);
    });

    it('posts only stopped for a run replaced before it began', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);

        workerScope.dispatchRequest(createWorkerStartRequest(LIFECYCLE_VECTOR.fileName, {
            generation: FIRST_RUN_GENERATION
        }));
        await decodeToEnd(workerScope, createWorkerStartRequest(LIFECYCLE_VECTOR.fileName, {
            generation: SECOND_RUN_GENERATION
        }));

        // The replaced run never opened its input, so only the second run created a decoder
        expect(getResponseTypes(workerScope.responses, FIRST_RUN_GENERATION)).toEqual([ 'stopped' ]);
        expect(FakeVideoDecoder.instances).toHaveLength(1);
    });

    it('asks to be replaced once a failed decoder was left open', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        // The registry the worker module consults, since both import the same module instance
        const { markHandledDecodeFailure } = await import('webgpu-player/pipeline/HandledDecodeFailures');
        const firstResponses = await decodeToEnd(workerScope, createWorkerStartRequest(LIFECYCLE_VECTOR.fileName, {
            generation: FIRST_RUN_GENERATION
        }));
        expect(firstResponses.at(-1)).toEqual({ generation: FIRST_RUN_GENERATION, type: 'stopped' });

        const leftOpenDecoderFailure = new Error(LEFT_OPEN_DECODER_FAILURE_MESSAGE);
        markHandledDecodeFailure(leftOpenDecoderFailure);
        expect(dispatchUnhandledRejection(workerScope, leftOpenDecoderFailure).defaultPrevented).toBe(true);

        const secondResponses = await decodeToEnd(workerScope, createWorkerStartRequest(LIFECYCLE_VECTOR.fileName, {
            generation: SECOND_RUN_GENERATION
        }));
        expect(secondResponses.at(-1)).toEqual({ generation: SECOND_RUN_GENERATION, replaceWorker: true, type: 'stopped' });
    });
});
