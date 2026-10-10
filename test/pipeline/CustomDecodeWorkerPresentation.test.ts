// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    isDecodeWorkerRequest,
    MAX_DECODED_FRAME_CREDITS,
    type DecodeWorkerFrameDescriptorResponse,
    type DecodeWorkerResponse
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import { createDefaultRenderSettings } from 'webgpu-player/presentation/RenderSettings';
import type {
    WorkerPresentationConfigureRequest,
    WorkerPresentationLayoutRequest,
    WorkerPresentationResponse
} from 'webgpu-player/presentation/WorkerPresentationProtocol';

import {
    AV1_HDR10_PLUS_EXPECTATIONS,
    readAV1HDR10PlusVector
} from '../helpers/av1HDR10PlusVectors';
import {
    FakeDecodedVideoFrame,
    FakeVideoDecoder,
    RAW_I420P10_ROUTE,
    createWorkerStartRequest,
    decodeToEnd,
    getFrameDescriptorResponses,
    getFrameResponses,
    startDecodeWorker,
    type FakeWorkerScope
} from '../helpers/decodeWorkerHarness';
import {
    FakeOffscreenCanvas,
    RendererPortProbe,
    createFakeCanvas,
    createFakeGPU,
    installWebGPUConstants,
    installWorkerGPU,
    type FakeGPUHarness
} from '../helpers/workerPresentationFakes';

type AttachedRenderer = {
    page: RendererPortProbe
    status: DecodeWorkerResponse
};

const MEDIA_FILE_NAME = 'hdr10plus.mkv';
const MEDIA_FILES = new Map<string, Uint8Array>([
    [ MEDIA_FILE_NAME, readAV1HDR10PlusVector(MEDIA_FILE_NAME) ]
]);
const FRAME_COUNT = AV1_HDR10_PLUS_EXPECTATIONS.frameCount;
const FIRST_GENERATION = 11;
const SECOND_GENERATION = 12;
const CONFIGURE_REVISION = 1;
const LAYOUT_REVISION = 1;
const BACKING_WIDTH = 640;
const BACKING_HEIGHT = 360;
const IDENTITY_SHADER_CODE = '// identity shader';
// I420P10 has a luma and two chroma planes
const RAW_PLANE_COUNT = 3;
// The frames the page still holds when a run ends on its own: one selected and one queued
const HELD_TAIL_FRAME_COUNT = 2;
const UNKNOWN_FRAME_ID = 1_000_000;
const ATTACHED_RENDERER_REASON = 'This worker already has a renderer';
// Long enough for a run that got a credit back to post its next frame
const SILENCE_MILLISECONDS = 100;

const openProbes: RendererPortProbe[] = [];

function wait(milliseconds: number): Promise<void> {
    return new Promise<void>(resolve => {
        setTimeout(resolve, milliseconds);
    });
}

/** Records the frames each video decoder outputs, so a test can see which of them the worker closed. */
function recordDecodedFrames(): FakeDecodedVideoFrame[] {
    const decodedFrames: FakeDecodedVideoFrame[] = [];
    class RecordingVideoDecoder extends FakeVideoDecoder {
        public constructor(init: VideoDecoderInit) {
            super({
                error: init.error,
                output: (frame: VideoFrame): void => {
                    decodedFrames.push(frame as unknown as FakeDecodedVideoFrame);
                    init.output(frame);
                }
            });
        }
    }
    vi.stubGlobal('VideoDecoder', RecordingVideoDecoder);
    return decodedFrames;
}

/**
 * Attaches a renderer, as the session does before a worker's first start, and waits for its status.
 * The renderer takes a device of the fake GPU, or finds no WebGPU without one.
 */
async function attachRenderer(workerScope: FakeWorkerScope, gpuHarness: FakeGPUHarness | null): Promise<AttachedRenderer> {
    installWorkerGPU(gpuHarness?.gpu ?? null);
    const channel = new MessageChannel();
    const page = new RendererPortProbe(channel.port2);
    openProbes.push(page);
    const firstResponseIndex = workerScope.responses.length;
    const request = {
        canvas: createFakeCanvas().canvas,
        generation: FIRST_GENERATION,
        port: channel.port1,
        type: 'attach-renderer'
    };
    expect(isDecodeWorkerRequest(request)).toBe(true);
    workerScope.dispatchRequest(request);
    const status = await workerScope.waitForResponse(
        (response: DecodeWorkerResponse): boolean => response.type === 'renderer-status'
            && workerScope.responses.indexOf(response) >= firstResponseIndex
    );
    return { page, status };
}

/** Installs the identity route in the renderer and lays its canvas out, as the page presenter does. */
async function configureIdentityRoute(page: RendererPortProbe): Promise<void> {
    const configureRequest: WorkerPresentationConfigureRequest = {
        automaticInputPeakNits: true,
        dolbyVisionFELReconstruction: false,
        dolbyVisionProfile: null,
        inputColorMetadata: null,
        inputMode: 'external-texture',
        rawFrameFormat: null,
        revision: CONFIGURE_REVISION,
        settings: createDefaultRenderSettings(),
        shaderCode: IDENTITY_SHADER_CODE,
        type: 'configure'
    };
    const layoutRequest: WorkerPresentationLayoutRequest = {
        backingHeight: BACKING_HEIGHT,
        backingWidth: BACKING_WIDTH,
        presentation: {
            textureOffsetX: 0,
            textureOffsetY: 0,
            textureScaleX: 1,
            textureScaleY: 1,
            viewportHeight: BACKING_HEIGHT,
            viewportWidth: BACKING_WIDTH,
            viewportX: 0,
            viewportY: 0
        },
        revision: LAYOUT_REVISION,
        type: 'layout'
    };
    page.post(configureRequest);
    page.post(layoutRequest);
    expect(await page.waitForResponse((response: WorkerPresentationResponse): boolean => response.type === 'configured'))
        .toEqual({ ok: true, reason: null, revision: CONFIGURE_REVISION, type: 'configured' });
}

async function presentFrame(page: RendererPortProbe, descriptor: DecodeWorkerFrameDescriptorResponse): Promise<boolean> {
    const firstResponseIndex = page.responses.length;
    page.post({
        frameId: descriptor.frameId,
        generation: descriptor.generation,
        layoutRevision: LAYOUT_REVISION,
        type: 'present'
    });
    const response = await page.waitForResponse(
        (candidate: WorkerPresentationResponse): boolean => candidate.type === 'presented' && candidate.frameId === descriptor.frameId,
        firstResponseIndex
    );
    return response.type === 'presented' && response.ok;
}

function releaseFrame(workerScope: FakeWorkerScope, descriptor: DecodeWorkerFrameDescriptorResponse): void {
    workerScope.dispatchRequest({ frameIds: [ descriptor.frameId ], generation: descriptor.generation, type: 'release-frames' });
}

/**
 * Holds the worker-frame descriptors the worker posts, as a page that has not presented them yet does.
 * Past the tail count, the oldest held frame is released; without one, every frame stays held.
 */
function holdWorkerFrames(workerScope: FakeWorkerScope, tailFrameCount: number | null = null): DecodeWorkerFrameDescriptorResponse[] {
    const heldDescriptors: DecodeWorkerFrameDescriptorResponse[] = [];
    const deliver = workerScope.postMessage.bind(workerScope);
    workerScope.postMessage = (message: DecodeWorkerResponse): void => {
        if (message.type !== 'frame' || message.outputMode !== 'worker-frame') {
            deliver(message);
            return;
        }
        heldDescriptors.push(message);
        if (tailFrameCount !== null && heldDescriptors.length > tailFrameCount) {
            const releasedDescriptor = heldDescriptors.shift() as DecodeWorkerFrameDescriptorResponse;
            void Promise.resolve().then((): void => {
                releaseFrame(workerScope, releasedDescriptor);
            });
        }
    };
    return heldDescriptors;
}

beforeEach(() => {
    vi.resetModules();
    installWebGPUConstants();
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
});

afterEach(() => {
    for (const probe of openProbes.splice(0)) {
        probe.close();
    }
    installWorkerGPU(null);
    vi.unstubAllGlobals();
});

describe('the playback worker presenting in its renderer', () => {
    it('attaches a renderer that answers ready on the page\'s channel and the decode channel, and declines a second one', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const gpuHarness = createFakeGPU();

        const renderer = await attachRenderer(workerScope, gpuHarness);

        expect(renderer.status).toEqual({ available: true, generation: FIRST_GENERATION, reason: null, type: 'renderer-status' });
        expect(await renderer.page.waitForResponse((response: WorkerPresentationResponse): boolean => response.type === 'status'))
            .toEqual({ reason: null, state: 'ready', type: 'status' });

        const secondRenderer = await attachRenderer(workerScope, gpuHarness);
        expect(secondRenderer.status).toEqual({
            available: false,
            generation: FIRST_GENERATION,
            reason: ATTACHED_RENDERER_REASON,
            type: 'renderer-status'
        });
        expect(await secondRenderer.page.waitForResponse((response: WorkerPresentationResponse): boolean => response.type === 'status'))
            .toEqual({ reason: 'canvas-context-unavailable', state: 'unavailable', type: 'status' });
    });

    it('answers unavailable on both channels in a worker without WebGPU', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);

        const renderer = await attachRenderer(workerScope, null);

        expect(renderer.status).toEqual({ available: false, generation: FIRST_GENERATION, reason: 'gpu-unavailable', type: 'renderer-status' });
        expect(await renderer.page.waitForResponse((response: WorkerPresentationResponse): boolean => response.type === 'status'))
            .toEqual({ reason: 'gpu-unavailable', state: 'unavailable', type: 'status' });
    });

    it('keeps a worker-mode run\'s VideoFrames, posts descriptors in their place, and closes each frame the page releases', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        await attachRenderer(workerScope, createFakeGPU());
        const decodedFrames = recordDecodedFrames();

        const mainResponses = await decodeToEnd(workerScope, createWorkerStartRequest(MEDIA_FILE_NAME, {
            generation: FIRST_GENERATION
        }));
        const workerResponses = await decodeToEnd(workerScope, createWorkerStartRequest(MEDIA_FILE_NAME, {
            generation: SECOND_GENERATION,
            presentationMode: 'worker'
        }));

        // Main mode still posts each frame with its payload
        const mainFrames = getFrameResponses(mainResponses);
        expect(mainFrames).toHaveLength(FRAME_COUNT);
        expect(getFrameDescriptorResponses(mainResponses)).toEqual([]);
        expect(getFrameResponses(workerResponses)).toEqual([]);
        const descriptors = getFrameDescriptorResponses(workerResponses);
        expect(descriptors.map(descriptor => descriptor.mediaTimeMicroseconds))
            .toEqual(mainFrames.map(frame => frame.mediaTimeMicroseconds));
        expect(descriptors.map(descriptor => descriptor.metadataSummary?.HDR10PlusStatus))
            .toEqual(mainFrames.map(frame => frame.HDR10PlusMetadata?.status));
        expect(new Set(descriptors.map(descriptor => descriptor.frameId)).size).toBe(FRAME_COUNT);
        for (const descriptor of descriptors) {
            expect([ descriptor.displayWidth, descriptor.displayHeight ])
                .toEqual([ AV1_HDR10_PLUS_EXPECTATIONS.width, AV1_HDR10_PLUS_EXPECTATIONS.height ]);
        }
        // The harness closes the main run's frames as the page would, and the worker closes each released one
        expect(decodedFrames.every(frame => frame.close.mock.calls.length === 1)).toBe(true);
    });

    it('uploads a worker-mode run\'s raw planes as it keeps them, and its decoder copies reuse one buffer', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const gpuHarness = createFakeGPU();
        await attachRenderer(workerScope, gpuHarness);
        const deviceHarness = gpuHarness.devices[0];

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MEDIA_FILE_NAME, {
            ...RAW_I420P10_ROUTE,
            generation: FIRST_GENERATION,
            presentationMode: 'worker'
        }));

        expect(getFrameDescriptorResponses(responses)).toHaveLength(FRAME_COUNT);
        expect(getFrameResponses(responses)).toEqual([]);
        expect(deviceHarness.queueWriteTexture).toHaveBeenCalledTimes(FRAME_COUNT * RAW_PLANE_COUNT);
        const uploadedBuffers = new Set<unknown>(deviceHarness.queueWriteTexture.mock.calls.map((call: unknown[]) => call[1]));
        expect(uploadedBuffers.size).toBe(1);
    });

    it('keeps the tail of a run that ended on its own, which the page presents and releases after stopped', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const gpuHarness = createFakeGPU();
        const renderer = await attachRenderer(workerScope, gpuHarness);
        await configureIdentityRoute(renderer.page);
        const decodedFrames = recordDecodedFrames();
        const heldDescriptors = holdWorkerFrames(workerScope, HELD_TAIL_FRAME_COUNT);

        workerScope.dispatchRequest(createWorkerStartRequest(MEDIA_FILE_NAME, {
            generation: FIRST_GENERATION,
            presentationMode: 'worker'
        }));
        await workerScope.waitForStopped(FIRST_GENERATION);

        expect(workerScope.responses.some(response => response.type === 'ended')).toBe(true);
        expect(heldDescriptors).toHaveLength(HELD_TAIL_FRAME_COUNT);
        const tailFrames = decodedFrames.slice(-HELD_TAIL_FRAME_COUNT);
        expect(tailFrames.every(frame => frame.close.mock.calls.length === 0)).toBe(true);
        for (const descriptor of heldDescriptors) {
            expect(await presentFrame(renderer.page, descriptor)).toBe(true);
        }
        expect(gpuHarness.devices[0].importExternalTexture.mock.calls.map((call: unknown[]) => (
            (call[0] as GPUExternalTextureDescriptor).source
        ))).toEqual(tailFrames);
        expect(tailFrames.every(frame => frame.close.mock.calls.length === 1)).toBe(true);

        for (const descriptor of heldDescriptors) {
            releaseFrame(workerScope, descriptor);
        }
        // A released frame presents no more
        expect(await presentFrame(renderer.page, heldDescriptors[0])).toBe(false);
    });

    it('frees the frames an earlier run left when the next run starts', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const renderer = await attachRenderer(workerScope, createFakeGPU());
        await configureIdentityRoute(renderer.page);
        const decodedFrames = recordDecodedFrames();
        const heldDescriptors = holdWorkerFrames(workerScope, HELD_TAIL_FRAME_COUNT);
        workerScope.dispatchRequest(createWorkerStartRequest(MEDIA_FILE_NAME, {
            generation: FIRST_GENERATION,
            presentationMode: 'worker'
        }));
        await workerScope.waitForStopped(FIRST_GENERATION);
        const leftoverFrames = decodedFrames.slice(-HELD_TAIL_FRAME_COUNT);
        expect(leftoverFrames.every(frame => frame.close.mock.calls.length === 0)).toBe(true);

        workerScope.dispatchRequest(createWorkerStartRequest(MEDIA_FILE_NAME, { generation: SECOND_GENERATION }));
        await workerScope.waitForStopped(SECOND_GENERATION);

        expect(leftoverFrames.every(frame => frame.close.mock.calls.length === 1)).toBe(true);
        expect(await presentFrame(renderer.page, heldDescriptors[0])).toBe(false);
    });

    it('frees a stopped run\'s frames before it posts stopped', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const decodedFrames = recordDecodedFrames();
        const heldDescriptors = holdWorkerFrames(workerScope);
        workerScope.dispatchRequest(createWorkerStartRequest(MEDIA_FILE_NAME, {
            generation: FIRST_GENERATION,
            presentationMode: 'worker'
        }));
        // The run keeps as many frames as its credits and then waits for a release
        await vi.waitFor(() => expect(heldDescriptors).toHaveLength(MAX_DECODED_FRAME_CREDITS));

        workerScope.dispatchRequest({ generation: FIRST_GENERATION, type: 'stop' });
        await workerScope.waitForStopped(FIRST_GENERATION);

        expect(decodedFrames.length).toBeGreaterThanOrEqual(MAX_DECODED_FRAME_CREDITS);
        expect(decodedFrames.every(frame => frame.close.mock.calls.length === 1)).toBe(true);
    });

    it('returns a credit for a released frame only while the run still keeps it', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const heldDescriptors = holdWorkerFrames(workerScope);
        workerScope.dispatchRequest(createWorkerStartRequest(MEDIA_FILE_NAME, {
            generation: FIRST_GENERATION,
            presentationMode: 'worker'
        }));
        await vi.waitFor(() => expect(heldDescriptors).toHaveLength(MAX_DECODED_FRAME_CREDITS));
        const [ firstDescriptor ] = heldDescriptors;

        workerScope.dispatchRequest({ frameIds: [ UNKNOWN_FRAME_ID ], generation: FIRST_GENERATION, type: 'release-frames' });
        await wait(SILENCE_MILLISECONDS);
        expect(heldDescriptors).toHaveLength(MAX_DECODED_FRAME_CREDITS);

        releaseFrame(workerScope, firstDescriptor);
        await vi.waitFor(() => expect(heldDescriptors).toHaveLength(MAX_DECODED_FRAME_CREDITS + 1));
        // The same frame released again returns nothing more
        releaseFrame(workerScope, firstDescriptor);
        await wait(SILENCE_MILLISECONDS);
        expect(heldDescriptors).toHaveLength(MAX_DECODED_FRAME_CREDITS + 1);

        workerScope.dispatchRequest({ generation: FIRST_GENERATION, type: 'stop' });
        await workerScope.waitForStopped(FIRST_GENERATION);
    });
});
