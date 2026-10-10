// Bounds the WebGPU requests and resource operations that presentation waits for, on the page and in the decode worker's renderer

import { microsecondsToMilliseconds, millisecondsToMicroseconds } from '../MediaTime';

export const WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS = millisecondsToMicroseconds(5_000);
/** What a bounded wait resolves with once its operation outlasted the bound. */
export const WEBGPU_RESOURCE_OPERATION_TIMEOUT = Symbol('webgpu-resource-operation-timeout');

/** Why no presentation device could be requested. */
export type PresentationDeviceRequestFailureReason = 'adapter-unavailable' | 'device-request-failed';

export type PresentationDeviceRequestResult =
    | {
        device: GPUDevice
        failureReason: null
    }
    | {
        device: null
        failureReason: PresentationDeviceRequestFailureReason
    };

/** Resolves with an operation's value, or with the timeout marker once the bound passed; a rejection passes through. */
export function waitForWebGPUResourceOperation<Value>(
    promise: Promise<Value>
): Promise<Value | typeof WEBGPU_RESOURCE_OPERATION_TIMEOUT> {
    return new Promise<Value | typeof WEBGPU_RESOURCE_OPERATION_TIMEOUT>((resolve, reject) => {
        const timeout = globalThis.setTimeout((): void => {
            resolve(WEBGPU_RESOURCE_OPERATION_TIMEOUT);
        }, microsecondsToMilliseconds(WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS));
        promise.then((value: Value): void => {
            globalThis.clearTimeout(timeout);
            resolve(value);
        }, (error: unknown): void => {
            globalThis.clearTimeout(timeout);
            reject(error);
        });
    });
}

function failDeviceRequest(failureReason: PresentationDeviceRequestFailureReason): PresentationDeviceRequestResult {
    return { device: null, failureReason };
}

/**
 * Requests an adapter and then a device, each wait bounded.
 * The device takes the adapter's own 2D texture limit, because a default device stops textures at 8192 texels.
 * A device that arrives after its wait timed out is destroyed.
 */
export async function requestPresentationDevice(gpu: GPU): Promise<PresentationDeviceRequestResult> {
    let adapter: GPUAdapter | null;
    try {
        const adapterResult = await waitForWebGPUResourceOperation(gpu.requestAdapter());
        if (adapterResult === WEBGPU_RESOURCE_OPERATION_TIMEOUT) {
            return failDeviceRequest('adapter-unavailable');
        }
        adapter = adapterResult;
    } catch (error) {
        console.warn('WebGPU adapter request failed', error);
        return failDeviceRequest('adapter-unavailable');
    }
    if (!adapter) {
        return failDeviceRequest('adapter-unavailable');
    }

    try {
        const devicePromise = adapter.requestDevice({
            requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D }
        });
        const deviceResult = await waitForWebGPUResourceOperation(devicePromise);
        if (deviceResult === WEBGPU_RESOURCE_OPERATION_TIMEOUT) {
            void devicePromise.then((lateDevice: GPUDevice): void => {
                lateDevice.destroy();
            }, (): void => undefined);
            return failDeviceRequest('device-request-failed');
        }
        return { device: deviceResult, failureReason: null };
    } catch (error) {
        console.warn('WebGPU device request failed', error);
        return failDeviceRequest('device-request-failed');
    }
}
