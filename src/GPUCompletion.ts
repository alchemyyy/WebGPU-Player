// Completions of a device's queue work, polled so that every browser settles them promptly.
// Firefox completes onSubmittedWorkDone() and mapAsync() only when its GPU process polls the device: at the end of a queue.submit, or every 100 ms
// (bug 1870699), where Chrome completes them within milliseconds of the GPU finishing. An empty submit polls the device without adding work,
// so while a completion is pending the page submits one each interval; a completion that settles within the first interval submits none.
import { microsecondsToMilliseconds, millisecondsToMicroseconds } from './MediaTime';

// The wait before each poll; browsers hold a repeating timer to at least 4 ms after its first few repeats
export const GPU_COMPLETION_POLL_INTERVAL_MICROSECONDS = millisecondsToMicroseconds(2);

/** A device's polling: how many completions joined it and are still pending, and the timer that polls while any is. */
type DevicePolling = {
    pendingCount: number
    timer: ReturnType<typeof globalThis.setInterval>
};

const devicePolling = new WeakMap<GPUDevice, DevicePolling>();

/**
 * Returns a completion of a device's queue work, such as its onSubmittedWorkDone() or the mapAsync() of a buffer its work writes,
 * and polls the device with empty submits while it is pending, so a browser that completes queue work only when the device is polled settles it within an interval.
 */
export function waitForGPUCompletion<Value>(device: GPUDevice, completion: Promise<Value>): Promise<Value> {
    const polling = joinPolling(device);
    const leave = (): void => {
        leavePolling(device, polling);
    };
    completion.then(leave, leave);
    return completion;
}

function joinPolling(device: GPUDevice): DevicePolling {
    const current = devicePolling.get(device);
    if (current) {
        current.pendingCount += 1;
        return current;
    }
    const polling: DevicePolling = {
        pendingCount: 1,
        timer: globalThis.setInterval((): void => {
            pollDevice(device);
        }, microsecondsToMilliseconds(GPU_COMPLETION_POLL_INTERVAL_MICROSECONDS))
    };
    devicePolling.set(device, polling);
    return polling;
}

/** Ends one completion's share of the polling it joined, which stops once none is pending, unless a refused poll stopped it already. */
function leavePolling(device: GPUDevice, polling: DevicePolling): void {
    polling.pendingCount -= 1;
    if (polling.pendingCount === 0 && devicePolling.get(device) === polling) {
        stopPolling(device, polling);
    }
}

/** Polls a device with an empty submit; a device that refuses one is polled no more, and its pending completions settle on their own. */
function pollDevice(device: GPUDevice): void {
    try {
        device.queue.submit([]);
    } catch {
        const polling = devicePolling.get(device);
        if (polling) {
            stopPolling(device, polling);
        }
    }
}

function stopPolling(device: GPUDevice, polling: DevicePolling): void {
    globalThis.clearInterval(polling.timer);
    devicePolling.delete(device);
}
