import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GPU_COMPLETION_POLL_INTERVAL_MICROSECONDS, waitForGPUCompletion } from 'webgpu-player/GPUCompletion';
import { microsecondsToMilliseconds } from 'webgpu-player/MediaTime';

const POLL_INTERVAL_MILLISECONDS = microsecondsToMilliseconds(GPU_COMPLETION_POLL_INTERVAL_MICROSECONDS);
// Intervals a test lets pass while a completion is pending, and after it settled
const PENDING_INTERVAL_COUNT = 3;
const SETTLED_INTERVAL_COUNT = 4;
const REFUSED_SUBMIT_ERROR = new Error('device lost');
const MAP_ABORTED_ERROR = new Error('mapAsync aborted');

type PolledDevice = Readonly<{
    device: GPUDevice
    submit: ReturnType<typeof vi.fn>
}>;

type Deferred = Readonly<{
    promise: Promise<void>
    reject: (error: unknown) => void
    resolve: () => void
}>;

function createPolledDevice(): PolledDevice {
    const submit = vi.fn();
    return { device: { queue: { submit } } as unknown as GPUDevice, submit };
}

function createDeferred(): Deferred {
    let resolve: () => void = (): void => undefined;
    let reject: (error: unknown) => void = (): void => undefined;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}

describe('waitForGPUCompletion', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: [ 'setInterval', 'clearInterval' ] });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('polls the device with an empty submit each interval while the completion is pending, and stops once it settles', async () => {
        const { device, submit } = createPolledDevice();
        const completion = createDeferred();

        const waited = waitForGPUCompletion(device, completion.promise);
        vi.advanceTimersByTime(POLL_INTERVAL_MILLISECONDS * PENDING_INTERVAL_COUNT);
        const pollsWhilePending = submit.mock.calls.length;
        completion.resolve();
        await waited;
        vi.advanceTimersByTime(POLL_INTERVAL_MILLISECONDS * SETTLED_INTERVAL_COUNT);

        expect(pollsWhilePending).toBe(PENDING_INTERVAL_COUNT);
        expect(submit).toHaveBeenCalledTimes(PENDING_INTERVAL_COUNT);
        expect(submit).toHaveBeenCalledWith([]);
    });

    it('submits nothing for a completion that settles within the first interval', async () => {
        const { device, submit } = createPolledDevice();

        await waitForGPUCompletion(device, Promise.resolve());
        vi.advanceTimersByTime(POLL_INTERVAL_MILLISECONDS * SETTLED_INTERVAL_COUNT);

        expect(submit).not.toHaveBeenCalled();
    });

    it('polls a device once each interval for all its pending completions, until the last settles, and other devices on their own', async () => {
        const first = createPolledDevice();
        const other = createPolledDevice();
        const earlier = createDeferred();
        const later = createDeferred();
        const otherCompletion = createDeferred();

        const earlierWaited = waitForGPUCompletion(first.device, earlier.promise);
        const laterWaited = waitForGPUCompletion(first.device, later.promise);
        void waitForGPUCompletion(other.device, otherCompletion.promise);
        // Every pending interval but the last has both completions pending, and the last only the later one
        vi.advanceTimersByTime(POLL_INTERVAL_MILLISECONDS * (PENDING_INTERVAL_COUNT - 1));
        earlier.resolve();
        await earlierWaited;
        vi.advanceTimersByTime(POLL_INTERVAL_MILLISECONDS);
        const pollsWhileLaterPending = first.submit.mock.calls.length;
        later.resolve();
        await laterWaited;
        vi.advanceTimersByTime(POLL_INTERVAL_MILLISECONDS * SETTLED_INTERVAL_COUNT);

        expect(pollsWhileLaterPending).toBe(PENDING_INTERVAL_COUNT);
        expect(first.submit).toHaveBeenCalledTimes(PENDING_INTERVAL_COUNT);
        expect(other.submit).toHaveBeenCalledTimes(PENDING_INTERVAL_COUNT + SETTLED_INTERVAL_COUNT);
        otherCompletion.resolve();
    });

    it('returns the completion as it is, a rejection included, and stops polling when it rejects', async () => {
        const { device, submit } = createPolledDevice();
        const completion = createDeferred();

        const waited = waitForGPUCompletion(device, completion.promise);
        completion.reject(MAP_ABORTED_ERROR);

        await expect(waited).rejects.toBe(MAP_ABORTED_ERROR);
        vi.advanceTimersByTime(POLL_INTERVAL_MILLISECONDS * SETTLED_INTERVAL_COUNT);
        expect(submit).not.toHaveBeenCalled();
    });

    it('stops polling a device that refuses an empty submit, and polls it again for a later completion', async () => {
        const { device, submit } = createPolledDevice();
        submit.mockImplementationOnce((): void => {
            throw REFUSED_SUBMIT_ERROR;
        });
        const refused = createDeferred();
        const later = createDeferred();

        void waitForGPUCompletion(device, refused.promise);
        vi.advanceTimersByTime(POLL_INTERVAL_MILLISECONDS * PENDING_INTERVAL_COUNT);
        const pollsAfterRefusal = submit.mock.calls.length;
        const laterWaited = waitForGPUCompletion(device, later.promise);
        refused.resolve();
        await refused.promise;
        vi.advanceTimersByTime(POLL_INTERVAL_MILLISECONDS);
        const pollsForLater = submit.mock.calls.length - pollsAfterRefusal;
        later.resolve();
        await laterWaited;

        expect(pollsAfterRefusal).toBe(1);
        // The refused completion's settling leaves the later completion's polling running
        expect(pollsForLater).toBe(1);
    });
});
