import { describe, expect, it } from 'vitest';

import {
    markHandledDecodeFailure,
    suppressHandledDecodeFailureRejections
} from 'webgpu-player/pipeline/HandledDecodeFailures';

const UNHANDLED_REJECTION_EVENT = 'unhandledrejection';
const HANDLED_FAILURE_MESSAGE = 'Decode failed with error code -1094995529.';
const UNHANDLED_FAILURE_MESSAGE = 'An unrelated rejection';
const PRIMITIVE_REJECTION_REASON = 'A string reason';

function dispatchRejection(scope: EventTarget, reason: unknown): Event {
    const event = new Event(UNHANDLED_REJECTION_EVENT, { cancelable: true });
    Object.defineProperty(event, 'reason', { value: reason });
    scope.dispatchEvent(event);
    return event;
}

describe('HandledDecodeFailures', () => {
    it('suppresses only the rejection of a failure the worker already caught', () => {
        const scope = new EventTarget();
        suppressHandledDecodeFailureRejections(scope);
        const handledFailure = new Error(HANDLED_FAILURE_MESSAGE);
        markHandledDecodeFailure(handledFailure);

        expect(dispatchRejection(scope, handledFailure).defaultPrevented).toBe(true);
        expect(dispatchRejection(scope, new Error(UNHANDLED_FAILURE_MESSAGE)).defaultPrevented).toBe(false);
    });

    it('leaves primitive rejection reasons reported', () => {
        const scope = new EventTarget();
        suppressHandledDecodeFailureRejections(scope);
        markHandledDecodeFailure(PRIMITIVE_REJECTION_REASON);

        expect(dispatchRejection(scope, PRIMITIVE_REJECTION_REASON).defaultPrevented).toBe(false);
        expect(dispatchRejection(scope, null).defaultPrevented).toBe(false);
    });
});
