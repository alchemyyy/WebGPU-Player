import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAnimationLoop } from '../../../sandbox/src/ui/AnimationLoop';

// The timestamp every fake frame passes; the loop ignores it
const FRAME_TIMESTAMP_MILLISECONDS = 16;
const FRAME_FAILURE_MESSAGE = 'frame-failed';

type FakeFrameScheduler = Readonly<{
    pendingFrameCount: () => number
    /** Runs every callback requested before the call, as one animation frame */
    runFrame: () => void
}>;

/** Replaces requestAnimationFrame and cancelAnimationFrame with a queue the test drains one frame at a time. */
function installFakeFrameScheduler(): FakeFrameScheduler {
    const pendingCallbacks = new Map<number, FrameRequestCallback>();
    let nextRequestId = 1;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
        const requestId = nextRequestId;
        nextRequestId += 1;
        pendingCallbacks.set(requestId, callback);
        return requestId;
    });
    vi.stubGlobal('cancelAnimationFrame', (requestId: number): void => {
        pendingCallbacks.delete(requestId);
    });
    return {
        pendingFrameCount: (): number => pendingCallbacks.size,
        runFrame: (): void => {
            const callbacks: FrameRequestCallback[] = [ ...pendingCallbacks.values() ];
            pendingCallbacks.clear();
            for (const callback of callbacks) {
                callback(FRAME_TIMESTAMP_MILLISECONDS);
            }
        }
    };
}

describe('AnimationLoop', () => {
    let scheduler: FakeFrameScheduler;

    beforeEach(() => {
        scheduler = installFakeFrameScheduler();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('calls the callback once per frame from start until stop', () => {
        const onFrame = vi.fn();
        const loop = createAnimationLoop(onFrame);
        scheduler.runFrame();
        expect(onFrame).not.toHaveBeenCalled();

        loop.start();
        scheduler.runFrame();
        scheduler.runFrame();
        expect(onFrame).toHaveBeenCalledTimes(2);

        loop.stop();
        scheduler.runFrame();
        expect(onFrame).toHaveBeenCalledTimes(2);
        expect(scheduler.pendingFrameCount()).toBe(0);
    });

    it('keeps one pending frame when a running loop starts again', () => {
        const onFrame = vi.fn();
        const loop = createAnimationLoop(onFrame);
        loop.start();
        loop.start();
        expect(scheduler.pendingFrameCount()).toBe(1);

        scheduler.runFrame();
        expect(onFrame).toHaveBeenCalledTimes(1);
        expect(scheduler.pendingFrameCount()).toBe(1);
    });

    it('ends when the callback stops it, and keeps one frame when the callback stops and starts it', () => {
        let stopsInCallback = true;
        const loop = createAnimationLoop(() => {
            loop.stop();
            if (!stopsInCallback) {
                loop.start();
            }
        });
        loop.start();
        scheduler.runFrame();
        expect(scheduler.pendingFrameCount()).toBe(0);

        stopsInCallback = false;
        loop.start();
        scheduler.runFrame();
        expect(scheduler.pendingFrameCount()).toBe(1);
    });

    it('ends when the callback throws, until the next start', () => {
        const onFrame = vi.fn((): void => {
            throw new Error(FRAME_FAILURE_MESSAGE);
        });
        const loop = createAnimationLoop(onFrame);
        loop.start();
        expect(() => scheduler.runFrame()).toThrow(FRAME_FAILURE_MESSAGE);
        expect(scheduler.pendingFrameCount()).toBe(0);

        onFrame.mockImplementation((): void => undefined);
        loop.start();
        scheduler.runFrame();
        expect(onFrame).toHaveBeenCalledTimes(2);
        expect(scheduler.pendingFrameCount()).toBe(1);
    });
});
