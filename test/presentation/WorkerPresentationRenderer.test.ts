// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authorizationMockState = vi.hoisted(() => {
    const state = {
        authorizeCalls: [] as Array<{ device: GPUDevice, registryName: string }>,
        rejectedRegistryNames: new Set<string>(),
        isAuthorized: (registryName: string): boolean => !state.rejectedRegistryNames.has(registryName),
        recordAuthorization: (device: GPUDevice, registryName: string): { status: 'authorized' | 'rejected' } => {
            state.authorizeCalls.push({ device, registryName });
            return { status: state.isAuthorized(registryName) ? 'authorized' : 'rejected' };
        }
    };
    return state;
});

vi.mock('webgpu-player/validation/RawHDRPresentationAuthorization', () => ({
    getRawHDRAuthorizationRouteKey: vi.fn((format: string, metadata: { transfer: string }) => `${format}:${metadata.transfer}`),
    RawHDRPresentationAuthorizationRegistry: class MockRawHDRAuthorizationRegistry {
        authorize = vi.fn(async (device: GPUDevice) => authorizationMockState.recordAuthorization(device, 'raw-hdr'));

        isAuthorized = vi.fn((): boolean => authorizationMockState.isAuthorized('raw-hdr'));
    }
}));

vi.mock('webgpu-player/validation/ExternalHDRPresentationAuthorization', () => ({
    getExternalHDRAuthorizationRouteKey: vi.fn((metadata: { transfer: string }) => `external-hevc-main10:${metadata.transfer}`),
    ExternalHDRPresentationAuthorizationRegistry: class MockExternalHDRAuthorizationRegistry {
        authorize = vi.fn(async (device: GPUDevice) => authorizationMockState.recordAuthorization(device, 'external-hdr'));

        isAuthorized = vi.fn((): boolean => authorizationMockState.isAuthorized('external-hdr'));
    }
}));

vi.mock('webgpu-player/validation/ExternalDolbyVisionPresentationAuthorization', () => ({
    ExternalDolbyVisionPresentationAuthorizationRegistry: class MockExternalDolbyVisionAuthorizationRegistry {
        authorize = vi.fn(async (device: GPUDevice) => authorizationMockState.recordAuthorization(device, 'external-dolby-vision'));

        isAuthorized = vi.fn((): boolean => authorizationMockState.isAuthorized('external-dolby-vision'));
    }
}));

vi.mock('webgpu-player/validation/DolbyVisionPresentationAuthorization', () => ({
    DolbyVisionPresentationAuthorizationRegistry: class MockDolbyVisionAuthorizationRegistry {
        readonly registryName: string;

        constructor(route = 'single-layer', format = 'I420P10') {
            this.registryName = `${format}:${route}`;
        }

        authorize = vi.fn(async (device: GPUDevice) => authorizationMockState.recordAuthorization(device, this.registryName));

        isAuthorized = vi.fn((): boolean => authorizationMockState.isAuthorized(this.registryName));
    }
}));

import { createDolbyVisionAuthorizationRPUVector } from 'webgpu-player/capability/vectors/DolbyVisionAuthorizationVector';
import { createPQColorMetadata } from 'webgpu-player/color/ColorMetadata';
import type { Microseconds } from 'webgpu-player/MediaTime';
import {
    createDefaultRenderSettings,
    createHDRToSDRRenderSettings,
    createRenderSettingsUniformData,
    type HDRToSDRRenderSettings
} from 'webgpu-player/presentation/RenderSettings';
import WorkerFrameStore, { type WorkerFrameDescription } from 'webgpu-player/presentation/WorkerFrameStore';
import WorkerPresentationRenderer, {
    declineWorkerPresentationAttachment
} from 'webgpu-player/presentation/WorkerPresentationRenderer';
import {
    isWorkerPresentationRequest,
    isWorkerPresentationResponse,
    type PresentationFallbackReason,
    type WorkerPresentationConfigureRequest,
    type WorkerPresentationLayoutRequest,
    type WorkerPresentationPresentedResponse,
    type WorkerPresentationResponse
} from 'webgpu-player/presentation/WorkerPresentationProtocol';
import { startWorkerTimingTrace, stopWorkerTimingTrace, type WorkerTimingTraceEvent } from 'webgpu-player/TimingTrace';
import {
    DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION,
    type TransferableDolbyVisionEncodedFrameMetadata
} from 'webgpu-player/video/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import {
    parseHEVCHDR10PlusMetadata,
    type HDR10PlusFrameMetadata
} from 'webgpu-player/video/hdr/HDR10PlusMetadata';
import type { RawVideoFrameColorSpace } from 'webgpu-player/video/RawVideoFrameCopy';

import { createHDR10PlusHEVCVector } from '../../src/capability/vectors/HDR10PlusVectors';
import {
    ADAPTER_MAXIMUM_TEXTURE_DIMENSION,
    NEUTRAL_BT709_FRAME_COLOR_SPACE,
    PQ_FRAME_COLOR_SPACE,
    PREFERRED_CANVAS_FORMAT,
    RAW_FRAME_DURATION_MICROSECONDS,
    RAW_FRAME_TIMESTAMP_MICROSECONDS,
    FakeOffscreenCanvas,
    RendererPortProbe,
    copyRawFrame,
    copyRawFramePair,
    createFakeCanvas,
    createFakeGPU,
    createFakeVideoFrame,
    installWebGPUConstants,
    installWorkerGPU,
    type FakeCanvasHarness,
    type FakeDeviceHarness,
    type FakeGPUHarness
} from '../helpers/workerPresentationFakes';

type RendererHarness = {
    canvasHarness: FakeCanvasHarness
    frameStore: WorkerFrameStore
    gpuHarness: FakeGPUHarness
    page: RendererPortProbe
    renderer: WorkerPresentationRenderer
    unavailableReason: PresentationFallbackReason | null
};

/** The worker's WebGPU entry point and the transferred canvas of a renderer that cannot start. */
type UnavailableRendererSetup = {
    canvas: OffscreenCanvas
    gpu: GPU | null
};

const GENERATION = 5;
const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
const FIRST_LAYOUT_REVISION = 1;
const SECOND_LAYOUT_REVISION = 2;
const UNKNOWN_FRAME_ID = 1_000;
const FRAME_WIDTH = 16;
const FRAME_HEIGHT = 8;
const BACKING_WIDTH = 640;
const BACKING_HEIGHT = 360;
const VIEWPORT_X = 0;
const VIEWPORT_Y = 20;
const VIEWPORT_WIDTH = 640;
const VIEWPORT_HEIGHT = 320;
const IDENTITY_SHADER_CODE = '// identity shader';
const RAW_SHADER_CODE = '// raw YUV shader';
const DOLBY_VISION_SHADER_CODE = '// Dolby Vision shader';
// The 10-bit base layer of every Dolby Vision vector here
const DOLBY_VISION_BASE_LAYER_BIT_DEPTH = 10;
// The binding of the RPU storage buffer, of the first EL plane, and of the EL flag uniform in a raw Dolby Vision pipeline
const RAW_DOLBY_VISION_RPU_BINDING = 5;
const RAW_ENHANCEMENT_FIRST_PLANE_BINDING = 6;
const RAW_ENHANCEMENT_UNIFORM_BINDING = 9;
// The scene peak of the valid HDR10+ vector, which the automatic input peak adopts
const HDR10_PLUS_VECTOR_SCENE_PEAK_NITS = 834.75;
const LIVE_PAPER_WHITE_NITS = 250;
const RENDER_SETTINGS_BUFFER_LABEL = 'WebGPU video render settings uniforms';
const DOLBY_VISION_RPU_BUFFER_LABEL = 'WebGPU Dolby Vision per-frame RPU';
const DOLBY_VISION_ENHANCEMENT_BUFFER_LABEL = 'WebGPU Dolby Vision enhancement uniforms';
// The kinds of presentation failure that a test watches for
const FAILED_RESPONSE_TYPE = 'failed';
const PRESENTED_RESPONSE_TYPE = 'presented';
// A request missing every field a present needs
const INVALID_PRESENT_REQUEST = { type: 'present' };
// Long enough for a renderer that would answer to have answered
const SILENCE_MILLISECONDS = 50;

const openProbes: RendererPortProbe[] = [];

function wait(milliseconds: number): Promise<void> {
    return new Promise<void>(resolve => {
        setTimeout(resolve, milliseconds);
    });
}

function createDescription(
    HDR10PlusMetadata: HDR10PlusFrameMetadata | null = null,
    encodedDolbyVisionMetadata: TransferableDolbyVisionEncodedFrameMetadata | null = null
): WorkerFrameDescription {
    return {
        durationMicroseconds: RAW_FRAME_DURATION_MICROSECONDS as Microseconds,
        encodedDolbyVisionMetadata,
        generation: GENERATION,
        HDR10PlusMetadata,
        mediaTimeMicroseconds: RAW_FRAME_TIMESTAMP_MICROSECONDS as Microseconds
    };
}

function createDolbyVisionMetadata(
    packedRPUData: ArrayBuffer,
    enhancementLayerDisposition: TransferableDolbyVisionEncodedFrameMetadata['enhancementLayerDisposition'] = 'absent',
    hasEnhancementLayerVCL = false
): TransferableDolbyVisionEncodedFrameMetadata {
    return {
        enhancementLayerDisposition,
        hasEnhancementLayerVCL,
        parsedRPUData: [ packedRPUData ],
        schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
    };
}

function createConfigureRequest(overrides: Partial<WorkerPresentationConfigureRequest> = {}): WorkerPresentationConfigureRequest {
    const request: WorkerPresentationConfigureRequest = {
        automaticInputPeakNits: true,
        dolbyVisionFELReconstruction: false,
        dolbyVisionProfile: null,
        inputColorMetadata: null,
        inputMode: 'external-texture',
        rawFrameFormat: null,
        revision: FIRST_REVISION,
        settings: createDefaultRenderSettings(),
        shaderCode: IDENTITY_SHADER_CODE,
        type: 'configure',
        ...overrides
    };
    expect(isWorkerPresentationRequest(request)).toBe(true);
    return request;
}

function createRawYUVConfigureRequest(overrides: Partial<WorkerPresentationConfigureRequest> = {}): WorkerPresentationConfigureRequest {
    return createConfigureRequest({
        inputColorMetadata: createPQColorMetadata(),
        inputMode: 'raw-yuv',
        rawFrameFormat: 'I420P10',
        settings: createHDRToSDRRenderSettings(),
        shaderCode: RAW_SHADER_CODE,
        ...overrides
    });
}

function createRawDolbyVisionConfigureRequest(
    dolbyVisionProfile: 4 | 5 | 7 | 8,
    dolbyVisionFELReconstruction: boolean
): WorkerPresentationConfigureRequest {
    return createConfigureRequest({
        dolbyVisionFELReconstruction,
        dolbyVisionProfile,
        inputMode: 'raw-dolby-vision',
        rawFrameFormat: 'I420P10',
        settings: createHDRToSDRRenderSettings(),
        shaderCode: DOLBY_VISION_SHADER_CODE
    });
}

function createLayoutRequest(revision = FIRST_LAYOUT_REVISION): WorkerPresentationLayoutRequest {
    return {
        backingHeight: BACKING_HEIGHT,
        backingWidth: BACKING_WIDTH,
        presentation: {
            textureOffsetX: 0,
            textureOffsetY: 0,
            textureScaleX: 1,
            textureScaleY: 1,
            viewportHeight: VIEWPORT_HEIGHT,
            viewportWidth: VIEWPORT_WIDTH,
            viewportX: VIEWPORT_X,
            viewportY: VIEWPORT_Y
        },
        revision,
        type: 'layout'
    };
}

async function startRenderer(gpuHarness: FakeGPUHarness = createFakeGPU(2)): Promise<RendererHarness> {
    installWorkerGPU(gpuHarness.gpu);
    const canvasHarness = createFakeCanvas();
    const frameStore = new WorkerFrameStore();
    const channel = new MessageChannel();
    const renderer = new WorkerPresentationRenderer({ canvas: canvasHarness.canvas, frameStore, port: channel.port1 });
    const page = new RendererPortProbe(channel.port2);
    openProbes.push(page);
    const unavailableReason = await renderer.start();
    return { canvasHarness, frameStore, gpuHarness, page, renderer, unavailableReason };
}

async function configure(
    harness: RendererHarness,
    request: WorkerPresentationConfigureRequest
): Promise<WorkerPresentationResponse> {
    const firstResponseIndex = harness.page.responses.length;
    harness.page.post(request);
    return harness.page.waitForResponse(
        (response: WorkerPresentationResponse): boolean => response.type === 'configured' && response.revision === request.revision,
        firstResponseIndex
    );
}

/** Configures a route and lays the canvas out, as the page presenter does before its first present. */
async function prepareRoute(harness: RendererHarness, request: WorkerPresentationConfigureRequest): Promise<void> {
    const configuredResponse = await configure(harness, request);
    expect(configuredResponse).toEqual({ ok: true, reason: null, revision: request.revision, type: 'configured' });
    harness.page.post(createLayoutRequest());
}

async function present(
    harness: RendererHarness,
    frameId: number,
    layoutRevision = FIRST_LAYOUT_REVISION
): Promise<WorkerPresentationPresentedResponse> {
    const firstResponseIndex = harness.page.responses.length;
    harness.page.post({ frameId, generation: GENERATION, layoutRevision, type: 'present' });
    const response = await harness.page.waitForResponse(
        (candidate: WorkerPresentationResponse): boolean => candidate.type === 'presented' && candidate.frameId === frameId,
        firstResponseIndex
    );
    if (response.type !== 'presented') {
        throw new Error('The matched response is not a presented response');
    }
    expect(isWorkerPresentationResponse(response)).toBe(true);
    return response;
}

function waitForFailure(harness: RendererHarness): Promise<WorkerPresentationResponse> {
    return harness.page.waitForResponse((response: WorkerPresentationResponse): boolean => response.type === FAILED_RESPONSE_TYPE);
}

function getBufferWrites(deviceHarness: FakeDeviceHarness, label: string): unknown[][] {
    return deviceHarness.queueWriteBuffer.mock.calls.filter((call: unknown[]) => (call[0] as { label?: string }).label === label);
}

function getLastBufferWrite(deviceHarness: FakeDeviceHarness, label: string): Uint8Array {
    const bufferWrites = getBufferWrites(deviceHarness, label);
    const lastWrite = bufferWrites.at(-1);
    if (!lastWrite) {
        throw new Error(`Nothing was written to ${label}`);
    }
    const data = lastWrite[2] as ArrayBufferView | ArrayBuffer;
    return ArrayBuffer.isView(data) ?
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength) :
        new Uint8Array(data);
}

function getBoundBindings(deviceHarness: FakeDeviceHarness): number[] {
    const bindGroupEntries = deviceHarness.bindGroupEntries.at(-1) ?? [];
    return bindGroupEntries.map((entry: GPUBindGroupEntry): number => entry.binding);
}

function getRenderSettingsUniformBytes(settings: HDRToSDRRenderSettings): Uint8Array {
    const data = createRenderSettingsUniformData(settings);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function keepRawYUVFrame(harness: RendererHarness, colorSpace: RawVideoFrameColorSpace = PQ_FRAME_COLOR_SPACE): Promise<number> {
    return copyRawFrame('I420P10', FRAME_WIDTH, FRAME_HEIGHT, colorSpace).then(
        (rawFrame): number => harness.frameStore.keepRawFrame(createDescription(), rawFrame, undefined)
    );
}

beforeEach(() => {
    installWebGPUConstants();
    authorizationMockState.authorizeCalls.length = 0;
    authorizationMockState.rejectedRegistryNames.clear();
    vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
});

afterEach(() => {
    for (const probe of openProbes.splice(0)) {
        probe.close();
    }
    stopWorkerTimingTrace();
    installWorkerGPU(null);
    vi.unstubAllGlobals();
});

describe('WorkerPresentationRenderer', () => {
    it('reports ready once it has a device of its own and the canvas context configured with it', async () => {
        const harness = await startRenderer();

        expect(harness.unavailableReason).toBeNull();
        expect(await harness.page.waitForResponse((response: WorkerPresentationResponse): boolean => response.type === 'status'))
            .toEqual({ reason: null, state: 'ready', type: 'status' });
        expect(harness.gpuHarness.requestDevice).toHaveBeenCalledWith({
            requiredLimits: { maxTextureDimension2D: ADAPTER_MAXIMUM_TEXTURE_DIMENSION }
        });
        expect(harness.canvasHarness.configure).toHaveBeenCalledWith({
            alphaMode: 'opaque',
            colorSpace: 'srgb',
            device: harness.gpuHarness.devices[0].device,
            format: PREFERRED_CANVAS_FORMAT
        });
    });

    it.each([
        [ 'gpu-unavailable', (_gpuHarness: FakeGPUHarness, canvasHarness: FakeCanvasHarness): UnavailableRendererSetup => ({
            canvas: canvasHarness.canvas,
            gpu: null
        }) ],
        [ 'canvas-context-unavailable', (gpuHarness: FakeGPUHarness): UnavailableRendererSetup => ({
            canvas: new FakeOffscreenCanvas(null) as unknown as OffscreenCanvas,
            gpu: gpuHarness.gpu
        }) ],
        [ 'adapter-unavailable', (gpuHarness: FakeGPUHarness, canvasHarness: FakeCanvasHarness): UnavailableRendererSetup => {
            gpuHarness.requestAdapter.mockResolvedValue(null);
            return { canvas: canvasHarness.canvas, gpu: gpuHarness.gpu };
        } ],
        [ 'canvas-configuration-failed', (gpuHarness: FakeGPUHarness, canvasHarness: FakeCanvasHarness): UnavailableRendererSetup => {
            canvasHarness.configure.mockImplementation((): void => {
                throw new TypeError('The canvas refused the device');
            });
            return { canvas: canvasHarness.canvas, gpu: gpuHarness.gpu };
        } ]
    ] as const)('answers unavailable for %s and releases its port', async (reason, prepare) => {
        const gpuHarness = createFakeGPU();
        const setup = prepare(gpuHarness, createFakeCanvas());
        installWorkerGPU(setup.gpu);
        const channel = new MessageChannel();
        const page = new RendererPortProbe(channel.port2);
        openProbes.push(page);
        const renderer = new WorkerPresentationRenderer({
            canvas: setup.canvas,
            frameStore: new WorkerFrameStore(),
            port: channel.port1
        });

        expect(await renderer.start()).toBe(reason);

        expect(await page.waitForResponse((response: WorkerPresentationResponse): boolean => response.type === 'status'))
            .toEqual({ reason, state: 'unavailable', type: 'status' });
        // A device it took before the failure goes with it
        for (const deviceHarness of gpuHarness.devices) {
            expect(deviceHarness.destroy.mock.calls.length).toBe(gpuHarness.requestDevice.mock.calls.length);
        }
        page.post(createConfigureRequest());
        await wait(SILENCE_MILLISECONDS);
        expect(page.responses).toHaveLength(1);
    });

    it('declines a further attachment, which the page answers by removing its canvas', async () => {
        const channel = new MessageChannel();
        const page = new RendererPortProbe(channel.port2);
        openProbes.push(page);

        declineWorkerPresentationAttachment(channel.port1);

        expect(await page.waitForResponse((response: WorkerPresentationResponse): boolean => response.type === 'status'))
            .toEqual({ reason: 'canvas-context-unavailable', state: 'unavailable', type: 'status' });
    });

    it('installs a configure only after authorizing its route on its own device', async () => {
        const harness = await startRenderer();
        const deviceHarness = harness.gpuHarness.devices[0];

        expect(await configure(harness, createRawYUVConfigureRequest()))
            .toEqual({ ok: true, reason: null, revision: FIRST_REVISION, type: 'configured' });

        expect(authorizationMockState.authorizeCalls).toEqual([ { device: deviceHarness.device, registryName: 'raw-hdr' } ]);
        expect(deviceHarness.createRenderPipelineAsync).toHaveBeenCalledOnce();
        expect(getLastBufferWrite(deviceHarness, RENDER_SETTINGS_BUFFER_LABEL))
            .toEqual(getRenderSettingsUniformBytes(createHDRToSDRRenderSettings()));
    });

    it.each([
        [ 'its device does not authorize the route', 'hdr-authorization-unavailable' ],
        [ 'its pipeline cannot be created', 'pipeline-creation-failed' ]
    ] as const)('refuses a configure when %s', async (_situation, reason) => {
        const harness = await startRenderer();
        if (reason === 'hdr-authorization-unavailable') {
            authorizationMockState.rejectedRegistryNames.add('raw-hdr');
        } else {
            harness.gpuHarness.devices[0].createRenderPipelineAsync.mockRejectedValueOnce(new Error('The shader did not compile'));
        }

        expect(await configure(harness, createRawYUVConfigureRequest()))
            .toEqual({ ok: false, reason, revision: FIRST_REVISION, type: 'configured' });
    });

    it('presents a kept VideoFrame once, closes it after its submission, and answers after its GPU work', async () => {
        const harness = await startRenderer();
        const deviceHarness = harness.gpuHarness.devices[0];
        await prepareRoute(harness, createConfigureRequest());
        const frame = createFakeVideoFrame(NEUTRAL_BT709_FRAME_COLOR_SPACE);
        const frameId = harness.frameStore.keepVideoFrame(createDescription(), frame);
        let completeGPUWork: () => void = (): void => undefined;
        deviceHarness.queueOnSubmittedWorkDone.mockImplementationOnce(() => new Promise<void>(resolve => {
            completeGPUWork = resolve;
        }));

        const presentedResponse = present(harness, frameId);
        await vi.waitFor(() => expect(deviceHarness.queueSubmit).toHaveBeenCalledOnce());
        await wait(SILENCE_MILLISECONDS);
        expect(harness.page.responses.some((response: WorkerPresentationResponse): boolean => response.type === PRESENTED_RESPONSE_TYPE))
            .toBe(false);
        completeGPUWork();

        expect(await presentedResponse).toEqual({
            dolbyVisionDualLayerMode: null,
            frameId,
            generation: GENERATION,
            gpuWorkCompleted: true,
            HDR10PlusResult: null,
            ok: true,
            type: 'presented'
        });
        expect(deviceHarness.importExternalTexture).toHaveBeenCalledWith({ colorSpace: 'srgb', source: frame });
        expect(frame.close).toHaveBeenCalledOnce();
        // The first submission of a pipeline is validated
        expect(deviceHarness.pushErrorScope).toHaveBeenCalledWith('validation');
        expect(deviceHarness.renderPassSetViewport).toHaveBeenCalledWith(VIEWPORT_X, VIEWPORT_Y, VIEWPORT_WIDTH, VIEWPORT_HEIGHT, 0, 1);
        expect([ harness.canvasHarness.canvas.width, harness.canvasHarness.canvas.height ]).toEqual([ BACKING_WIDTH, BACKING_HEIGHT ]);

        // A VideoFrame presents once
        expect((await present(harness, frameId)).ok).toBe(false);
        expect(deviceHarness.queueSubmit).toHaveBeenCalledOnce();
    });

    it('answers not presented for a frame it does not keep, or one selected for a layout it does not have', async () => {
        const harness = await startRenderer();
        await prepareRoute(harness, createConfigureRequest());
        const frameId = harness.frameStore.keepVideoFrame(createDescription(), createFakeVideoFrame(NEUTRAL_BT709_FRAME_COLOR_SPACE));

        expect(await present(harness, UNKNOWN_FRAME_ID)).toEqual({
            dolbyVisionDualLayerMode: null,
            frameId: UNKNOWN_FRAME_ID,
            generation: GENERATION,
            gpuWorkCompleted: false,
            HDR10PlusResult: null,
            ok: false,
            type: 'presented'
        });
        expect((await present(harness, frameId, SECOND_LAYOUT_REVISION)).ok).toBe(false);
        expect(harness.gpuHarness.devices[0].queueSubmit).not.toHaveBeenCalled();
    });

    it('draws a raw frame from the textures its planes were uploaded into when it was kept', async () => {
        const harness = await startRenderer();
        const deviceHarness = harness.gpuHarness.devices[0];
        await prepareRoute(harness, createRawYUVConfigureRequest());
        const frameId = await keepRawYUVFrame(harness);
        const uploadCount = deviceHarness.queueWriteTexture.mock.calls.length;
        expect(uploadCount).toBeGreaterThan(0);

        const presentedResponse = await present(harness, frameId);

        expect(presentedResponse.ok).toBe(true);
        expect(presentedResponse.HDR10PlusResult).toEqual({ inputPeakNits: null, metadataStatus: 'absent' });
        expect(deviceHarness.queueWriteTexture).toHaveBeenCalledTimes(uploadCount);
        expect(deviceHarness.queueSubmit).toHaveBeenCalledOnce();
        // The presentation uniform, three planes, and the render settings
        expect(getBoundBindings(deviceHarness)).toEqual([ 0, 1, 2, 3, 4 ]);
        // A raw frame can draw again, as a repaint does
        expect((await present(harness, frameId)).ok).toBe(true);
    });

    it('applies a frame\'s HDR10+ metadata as the page presenter does and reports what it applied', async () => {
        const harness = await startRenderer();
        const deviceHarness = harness.gpuHarness.devices[0];
        await prepareRoute(harness, createRawYUVConfigureRequest());
        const HDR10PlusMetadata = parseHEVCHDR10PlusMetadata(createHDR10PlusHEVCVector('valid'), { kind: 'annex-b' });
        const dynamicRawFrame = await copyRawFrame('I420P10', FRAME_WIDTH, FRAME_HEIGHT);
        const dynamicFrameId = harness.frameStore.keepRawFrame(createDescription(HDR10PlusMetadata), dynamicRawFrame, undefined);
        const staticFrameId = await keepRawYUVFrame(harness);

        const dynamicResponse = await present(harness, dynamicFrameId);
        expect(dynamicResponse.HDR10PlusResult?.metadataStatus).toBe('valid');
        expect(dynamicResponse.HDR10PlusResult?.inputPeakNits).toBeCloseTo(HDR10_PLUS_VECTOR_SCENE_PEAK_NITS);
        expect(getLastBufferWrite(deviceHarness, RENDER_SETTINGS_BUFFER_LABEL))
            .not.toEqual(getRenderSettingsUniformBytes(createHDRToSDRRenderSettings()));

        // The next frame without metadata tone-maps with the static settings again
        expect((await present(harness, staticFrameId)).HDR10PlusResult).toEqual({ inputPeakNits: null, metadataStatus: 'absent' });
        expect(getLastBufferWrite(deviceHarness, RENDER_SETTINGS_BUFFER_LABEL))
            .toEqual(getRenderSettingsUniformBytes(createHDRToSDRRenderSettings()));
    });

    it('applies live settings to the installed configure, and keeps those sent for a configure still being installed', async () => {
        const harness = await startRenderer();
        const deviceHarness = harness.gpuHarness.devices[0];
        await prepareRoute(harness, createRawYUVConfigureRequest());
        const liveSettings = createHDRToSDRRenderSettings({ toneMapping: { paperWhiteNits: LIVE_PAPER_WHITE_NITS } });

        harness.page.post({ automaticInputPeakNits: true, revision: FIRST_REVISION, settings: liveSettings, type: 'settings' });
        await vi.waitFor(() => expect(getLastBufferWrite(deviceHarness, RENDER_SETTINGS_BUFFER_LABEL))
            .toEqual(getRenderSettingsUniformBytes(liveSettings)));

        const pendingConfigured = configure(harness, createRawYUVConfigureRequest({ revision: SECOND_REVISION }));
        harness.page.post({ automaticInputPeakNits: true, revision: SECOND_REVISION, settings: liveSettings, type: 'settings' });
        expect((await pendingConfigured).type).toBe('configured');
        expect(getLastBufferWrite(deviceHarness, RENDER_SETTINGS_BUFFER_LABEL)).toEqual(getRenderSettingsUniformBytes(liveSettings));
    });

    it('fails with a color mismatch for a raw frame whose color breaks the route', async () => {
        const harness = await startRenderer();
        await prepareRoute(harness, createRawYUVConfigureRequest());
        const frameId = await keepRawYUVFrame(harness, NEUTRAL_BT709_FRAME_COLOR_SPACE);

        expect((await present(harness, frameId)).ok).toBe(false);
        expect(await waitForFailure(harness)).toEqual({ reason: 'decoded-frame-color-mismatch', type: 'failed' });
        expect(harness.gpuHarness.devices[0].queueSubmit).not.toHaveBeenCalled();
    });

    it('writes a Profile 7 FEL frame\'s RPU and composes its EL from the textures it was kept in', async () => {
        const harness = await startRenderer();
        const deviceHarness = harness.gpuHarness.devices[0];
        await prepareRoute(harness, createRawDolbyVisionConfigureRequest(7, true));
        const packedRPUData = createDolbyVisionAuthorizationRPUVector(7, 'fel', DOLBY_VISION_BASE_LAYER_BIT_DEPTH);
        const framePair = await copyRawFramePair('I420P10', FRAME_WIDTH, FRAME_HEIGHT, true);
        const frameId = harness.frameStore.keepRawFrame(
            createDescription(null, createDolbyVisionMetadata(packedRPUData, 'decoded-fel', true)),
            framePair.baseFrame,
            framePair.enhancementFrame
        );

        const presentedResponse = await present(harness, frameId);

        expect(authorizationMockState.authorizeCalls.map(call => call.registryName)).toEqual([
            'I420P10:profile7-base',
            'I420P10:profile7-fel'
        ]);
        expect(presentedResponse.ok).toBe(true);
        expect(presentedResponse.dolbyVisionDualLayerMode).toBe('fel');
        expect(getLastBufferWrite(deviceHarness, DOLBY_VISION_RPU_BUFFER_LABEL)).toEqual(new Uint8Array(packedRPUData));
        expect(Array.from(new Uint32Array(getLastBufferWrite(deviceHarness, DOLBY_VISION_ENHANCEMENT_BUFFER_LABEL).slice().buffer)))
            .toEqual([ 1, 0, 0, 0 ]);
        const bindings = getBoundBindings(deviceHarness);
        expect(bindings).toContain(RAW_DOLBY_VISION_RPU_BINDING);
        expect(bindings).toContain(RAW_ENHANCEMENT_FIRST_PLANE_BINDING);
        expect(bindings).toContain(RAW_ENHANCEMENT_UNIFORM_BINDING);
    });

    it('fails a Dolby Vision frame whose RPU does not reconstruct the route', async () => {
        const harness = await startRenderer();
        await prepareRoute(harness, createRawDolbyVisionConfigureRequest(8, false));
        const frameId = await keepRawYUVFrame(harness);

        expect((await present(harness, frameId)).ok).toBe(false);
        expect(await waitForFailure(harness)).toEqual({ reason: 'dolby-vision-metadata-invalid', type: 'failed' });
    });

    it('recovers one device loss on a new device, where kept frames of the lost one present as not presented', async () => {
        const harness = await startRenderer();
        const [ firstDeviceHarness, secondDeviceHarness ] = harness.gpuHarness.devices;
        await prepareRoute(harness, createRawYUVConfigureRequest());
        const lostFrameId = await keepRawYUVFrame(harness);

        firstDeviceHarness.lose();

        // The newest configure is installed again, its route authorized on the new device
        await vi.waitFor(() => expect(harness.page.responses.filter(
            (response: WorkerPresentationResponse): boolean => response.type === 'configured'
        )).toHaveLength(2));
        expect(authorizationMockState.authorizeCalls.map(call => call.device)).toEqual([
            firstDeviceHarness.device,
            secondDeviceHarness.device
        ]);
        expect(harness.canvasHarness.configure).toHaveBeenLastCalledWith(expect.objectContaining({ device: secondDeviceHarness.device }));
        expect((await present(harness, lostFrameId)).ok).toBe(false);
        const recoveredFrameId = await keepRawYUVFrame(harness);
        expect((await present(harness, recoveredFrameId)).ok).toBe(true);
        expect(secondDeviceHarness.queueSubmit).toHaveBeenCalledOnce();

        secondDeviceHarness.lose();
        expect(await waitForFailure(harness)).toEqual({ reason: 'device-recovery-failed', type: 'failed' });
    });

    it('fails when it cannot recover its device', async () => {
        const harness = await startRenderer(createFakeGPU(1));
        await prepareRoute(harness, createConfigureRequest());

        harness.gpuHarness.devices[0].lose();

        expect(await waitForFailure(harness)).toEqual({ reason: 'device-recovery-failed', type: 'failed' });
    });

    it('fails on an uncaptured GPU error and on a request it cannot read', async () => {
        const firstHarness = await startRenderer();
        firstHarness.gpuHarness.devices[0].dispatchUncapturedError('The draw was invalid');
        expect(await waitForFailure(firstHarness)).toEqual({ reason: 'frame-render-failed', type: 'failed' });

        const secondHarness = await startRenderer();
        secondHarness.page.post(INVALID_PRESENT_REQUEST);
        expect(await waitForFailure(secondHarness)).toEqual({ reason: 'frame-render-failed', type: 'failed' });
    });

    it('records the GPU wait of each frame it presents in the worker timing trace', async () => {
        const recordedEvents: WorkerTimingTraceEvent[] = [];
        startWorkerTimingTrace((events: WorkerTimingTraceEvent[]): void => {
            recordedEvents.push(...events);
        });
        const harness = await startRenderer();
        await prepareRoute(harness, createConfigureRequest());
        const frameId = harness.frameStore.keepVideoFrame(createDescription(), createFakeVideoFrame(NEUTRAL_BT709_FRAME_COLOR_SPACE));

        await present(harness, frameId);
        stopWorkerTimingTrace();

        const GPUWaits = recordedEvents.filter((event: WorkerTimingTraceEvent): boolean => event.kind === 'gpu-work-done');
        expect(GPUWaits).toHaveLength(1);
        expect(GPUWaits[0].fields).toEqual(expect.objectContaining({ completed: true }));
    });

    it('detaches: frees every kept frame, destroys its device, and answers nothing more', async () => {
        const harness = await startRenderer();
        const deviceHarness = harness.gpuHarness.devices[0];
        await prepareRoute(harness, createRawYUVConfigureRequest());
        const frame = createFakeVideoFrame(PQ_FRAME_COLOR_SPACE);
        const videoFrameId = harness.frameStore.keepVideoFrame(createDescription(), frame);
        await keepRawYUVFrame(harness);

        harness.page.post({ type: 'detach' });

        await vi.waitFor(() => expect(deviceHarness.destroy).toHaveBeenCalledOnce());
        expect(frame.close).toHaveBeenCalledOnce();
        expect(harness.frameStore.getFrameCount(GENERATION)).toBe(0);
        expect(harness.canvasHarness.unconfigure).toHaveBeenCalled();
        const responseCount = harness.page.responses.length;
        harness.page.post({ frameId: videoFrameId, generation: GENERATION, layoutRevision: FIRST_LAYOUT_REVISION, type: 'present' });
        await wait(SILENCE_MILLISECONDS);
        expect(harness.page.responses).toHaveLength(responseCount);
    });
});
