import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { createVideoDecodeFence } from 'webgpu-player/decode/video/native/VideoDecodeFence';

import { settle } from '../../../helpers/ownedVideoStreamFakes';
import {
    createDeferred,
    createWebGPUDeviceHarness,
    installWebGPUGlobals,
    type WebGPUDeviceHarness
} from '../../../helpers/webGPUDeviceHarness';

type FakeFrame = { close: Mock };

type FenceGPU = Readonly<{
    deviceHarness: WebGPUDeviceHarness
    gpu: GPU
    requestAdapter: Mock
}>;

function createFrame(): FakeFrame {
    return { close: vi.fn() };
}

function asVideoFrame(frame: FakeFrame): VideoFrame {
    return frame as unknown as VideoFrame;
}

/** A GPU whose adapter gives one mock device, whose compute pipelines expose their bind group layout as the fence's pipeline needs. */
function createFenceGPU(adapterAvailable = true): FenceGPU {
    const deviceHarness = createWebGPUDeviceHarness();
    deviceHarness.createComputePipelineAsync.mockImplementation((descriptor: GPUComputePipelineDescriptor) => Promise.resolve({
        descriptor,
        getBindGroupLayout: vi.fn(() => ({}))
    }));
    const requestAdapter = vi.fn(() => Promise.resolve(adapterAvailable ?
        { requestDevice: vi.fn(() => Promise.resolve(deviceHarness.device)) } :
        null));
    return { deviceHarness, gpu: { requestAdapter } as unknown as GPU, requestAdapter };
}

describe('createVideoDecodeFence', () => {
    let restoreWebGPUGlobals: () => void = (): void => undefined;

    beforeEach(() => {
        restoreWebGPUGlobals = installWebGPUGlobals();
    });

    afterEach(() => {
        restoreWebGPUGlobals();
    });

    it('resolves at once and closes the frame where the worker has no WebGPU', async () => {
        const fence = createVideoDecodeFence(undefined);
        const frame = createFrame();

        fence.prewarm();
        await fence.wait(asVideoFrame(frame));

        expect(frame.close).toHaveBeenCalledOnce();
    });

    it('lets frames through while its device is being created, which the first wait starts once', async () => {
        const { deviceHarness, gpu, requestAdapter } = createFenceGPU();
        const fence = createVideoDecodeFence(gpu);
        const frames = [ createFrame(), createFrame() ];

        await fence.wait(asVideoFrame(frames[0]));
        await fence.wait(asVideoFrame(frames[1]));

        expect(requestAdapter).toHaveBeenCalledOnce();
        expect(deviceHarness.importExternalTexture).not.toHaveBeenCalled();
        for (const frame of frames) {
            expect(frame.close).toHaveBeenCalledOnce();
        }
    });

    it('resolves once the GPU finished a one-texel read of the frame, and closes the frame only then', async () => {
        const { deviceHarness, gpu } = createFenceGPU();
        const workDone = createDeferred<undefined>();
        deviceHarness.queueOnSubmittedWorkDone.mockReturnValueOnce(workDone.promise);
        const fence = createVideoDecodeFence(gpu);
        fence.prewarm();
        await settle();
        const frame = createFrame();

        let resolved = false;
        const waiting = fence.wait(asVideoFrame(frame)).then((): void => {
            resolved = true;
        });
        await settle();

        expect(deviceHarness.importExternalTexture).toHaveBeenCalledOnce();
        expect(deviceHarness.importExternalTexture.mock.calls[0][0]).toMatchObject({ source: frame });
        expect(deviceHarness.queueSubmit).toHaveBeenCalledOnce();
        expect(resolved).toBe(false);
        expect(frame.close).not.toHaveBeenCalled();

        workDone.resolve(undefined);
        await waiting;
        expect(frame.close).toHaveBeenCalledOnce();
    });

    it('serves no fence once the browser refuses an adapter', async () => {
        const { gpu, requestAdapter } = createFenceGPU(false);
        const fence = createVideoDecodeFence(gpu);

        fence.prewarm();
        await settle();
        const frame = createFrame();
        await fence.wait(asVideoFrame(frame));
        fence.prewarm();

        expect(requestAdapter).toHaveBeenCalledOnce();
        expect(frame.close).toHaveBeenCalledOnce();
    });

    it('serves no fence after its device is lost', async () => {
        const { deviceHarness, gpu } = createFenceGPU();
        const fence = createVideoDecodeFence(gpu);
        fence.prewarm();
        await settle();

        deviceHarness.lost.resolve({ message: 'lost', reason: 'unknown' } as GPUDeviceLostInfo);
        await settle();
        await fence.wait(asVideoFrame(createFrame()));

        expect(deviceHarness.importExternalTexture).not.toHaveBeenCalled();
    });

    it('serves no fence after its device could not import a decoded frame', async () => {
        const { deviceHarness, gpu } = createFenceGPU();
        deviceHarness.importExternalTexture.mockImplementationOnce(() => {
            throw new TypeError('importExternalTexture: unsupported source');
        });
        const fence = createVideoDecodeFence(gpu);
        fence.prewarm();
        await settle();
        const refusedFrame = createFrame();

        await fence.wait(asVideoFrame(refusedFrame));
        await fence.wait(asVideoFrame(createFrame()));

        expect(refusedFrame.close).toHaveBeenCalledOnce();
        expect(deviceHarness.importExternalTexture).toHaveBeenCalledOnce();
        expect(deviceHarness.queueSubmit).not.toHaveBeenCalled();
    });
});
