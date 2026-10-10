import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const webSettingsMockState = vi.hoisted(() => ({
    hdrToneMappingEnabled: false
}));
const rawHDRAuthorizationMockState = vi.hoisted(() => ({
    authorized: true,
    prewarmCalls: [] as Array<{ device: GPUDevice, targetFormat: GPUTextureFormat }>
}));
const externalHDRAuthorizationMockState = vi.hoisted(() => ({
    authorizeCalls: [] as GPUDevice[],
    authorized: true,
    prewarmCalls: [] as Array<{ device: GPUDevice, targetFormat: GPUTextureFormat }>
}));
const dolbyVisionAuthorizationMockState = vi.hoisted(() => ({
    authorizeCalls: [] as GPUDevice[],
    // Registries are named <BL format>:<route>, so tests can follow and reject each format's own keys
    authorizeRouteNames: [] as string[],
    authorized: true,
    prewarmCalls: [] as Array<{ device: GPUDevice, targetFormat: GPUTextureFormat }>,
    prewarmRouteNames: [] as string[],
    rejectedRouteNames: new Set<string>(),
    waitRouteNames: [] as string[]
}));

vi.mock('webgpu-player/EngineConfiguration', () => ({
    isHDRToneMappingEnabled: vi.fn((): Promise<boolean> => Promise.resolve(webSettingsMockState.hdrToneMappingEnabled))
}));

vi.mock('webgpu-player/validation/RawHDRPresentationAuthorization', () => ({
    getRawHDRAuthorizationRouteKey: vi.fn(() => (
        'I420P10:bt2020-ncl:bt2020:limited:pq'
    )),
    RawHDRPresentationAuthorizationRegistry: class MockRawHDRAuthorizationRegistry {
        authorize = vi.fn(async () => ({
            status: rawHDRAuthorizationMockState.authorized ? 'authorized' : 'rejected'
        }));

        prewarm = vi.fn((device: GPUDevice, targetFormat: GPUTextureFormat): void => {
            rawHDRAuthorizationMockState.prewarmCalls.push({ device, targetFormat });
        });

        prewarmSDR = vi.fn((device: GPUDevice, targetFormat: GPUTextureFormat): void => {
            rawHDRAuthorizationMockState.prewarmCalls.push({ device, targetFormat });
        });

        waitForPending = vi.fn((): Promise<void> => Promise.resolve());

        isAuthorized = vi.fn((): boolean => rawHDRAuthorizationMockState.authorized);

        getTelemetry = vi.fn((_device: GPUDevice | null, targetFormat: GPUTextureFormat | null) => ({
            authorizedRouteKeys: rawHDRAuthorizationMockState.authorized ?
                [
                    'I420P10:bt2020-ncl:bt2020:limited:pq',
                    'I420P10:bt2020-ncl:bt2020:limited:hlg'
                ] :
                [],
            failureReasons: {},
            vectorVersion: 1,
            pendingRouteKeys: [],
            rejectedRouteKeys: rawHDRAuthorizationMockState.authorized ? [] :
                [
                    'I420P10:bt2020-ncl:bt2020:limited:pq',
                    'I420P10:bt2020-ncl:bt2020:limited:hlg'
                ],
            renderSettingsVersion: 4,
            status: rawHDRAuthorizationMockState.authorized ? 'authorized' : 'rejected',
            targetFormat
        }));
    }
}));

vi.mock('webgpu-player/validation/ExternalHDRPresentationAuthorization', () => ({
    getExternalHDRAuthorizationRouteKey: vi.fn((metadata: { transfer?: string }) => {
        switch (metadata.transfer) {
            case 'hlg':
                return 'external-hevc-main10-bt709-limited:hlg-v1';
            case 'pq':
                return 'external-hevc-main10-bt709-limited:pq-v1';
            default:
                return null;
        }
    }),
    ExternalHDRPresentationAuthorizationRegistry:
    class MockExternalHDRAuthorizationRegistry {
        authorize = vi.fn(async (device: GPUDevice) => {
            externalHDRAuthorizationMockState.authorizeCalls.push(device);
            return {
                status: externalHDRAuthorizationMockState.authorized ?
                    'authorized' :
                    'rejected'
            };
        });

        prewarm = vi.fn((device: GPUDevice, targetFormat: GPUTextureFormat): void => {
            externalHDRAuthorizationMockState.prewarmCalls.push({ device, targetFormat });
        });

        waitForPending = vi.fn((): Promise<void> => Promise.resolve());

        isAuthorized = vi.fn((): boolean => externalHDRAuthorizationMockState.authorized);

        getTelemetry = vi.fn((_device: GPUDevice | null, targetFormat: GPUTextureFormat | null) => ({
            authorizedRouteKeys: externalHDRAuthorizationMockState.authorized ? [
                'external-hevc-main10-bt709-limited:pq-v1',
                'external-hevc-main10-bt709-limited:hlg-v1'
            ] : [],
            failureReasons: {},
            vectorVersion: 1,
            maximumChannelErrors: {},
            pendingRouteKeys: [],
            rejectedRouteKeys: externalHDRAuthorizationMockState.authorized ? [] : [
                'external-hevc-main10-bt709-limited:pq-v1',
                'external-hevc-main10-bt709-limited:hlg-v1'
            ],
            renderSettingsVersion: 4,
            sampleCounts: {},
            status: externalHDRAuthorizationMockState.authorized ?
                'authorized' :
                'rejected',
            targetFormat
        }));
    }
}));

vi.mock('webgpu-player/validation/DolbyVisionPresentationAuthorization', () => ({
    DolbyVisionPresentationAuthorizationRegistry: class MockDolbyVisionAuthorizationRegistry {
        readonly routeName: string;

        constructor(route = 'single-layer', format = 'I420P10') {
            this.routeName = `${format}:${route}`;
        }

        authorize = vi.fn(async (device: GPUDevice) => {
            dolbyVisionAuthorizationMockState.authorizeCalls.push(device);
            dolbyVisionAuthorizationMockState.authorizeRouteNames.push(this.routeName);
            return {
                status: this.isRouteAuthorized() ? 'authorized' : 'rejected'
            };
        });

        prewarm = vi.fn((device: GPUDevice, targetFormat: GPUTextureFormat): void => {
            dolbyVisionAuthorizationMockState.prewarmCalls.push({ device, targetFormat });
            dolbyVisionAuthorizationMockState.prewarmRouteNames.push(this.routeName);
        });

        waitForPending = vi.fn((): Promise<void> => {
            dolbyVisionAuthorizationMockState.waitRouteNames.push(this.routeName);
            return Promise.resolve();
        });

        isAuthorized = vi.fn((): boolean => this.isRouteAuthorized());

        getTelemetry = vi.fn((_device: GPUDevice | null, targetFormat: GPUTextureFormat | null) => ({
            failureReason: this.isRouteAuthorized() ? null : 'pixel-mismatch',
            vectorVersion: 1,
            maximumChannelError: this.isRouteAuthorized() ? 0 : 1,
            renderSettingsVersion: 4,
            routeKey: 'I420P10:dovi-rpu-v1',
            sampleCount: 4,
            status: this.isRouteAuthorized() ? 'authorized' : 'rejected',
            targetFormat
        }));

        isRouteAuthorized(): boolean {
            return dolbyVisionAuthorizationMockState.authorized
                && !dolbyVisionAuthorizationMockState.rejectedRouteNames.has(this.routeName);
        }
    }
}));

import {
    createHLGColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata,
    type InputColorMetadata
} from 'webgpu-player/color/ColorMetadata';
import {
    getRawFormatBitDepth,
    type RawDolbyVisionVideoFrameFormat
} from 'webgpu-player/color/ColorPipelineShader';
import {
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from 'webgpu-player/video/RawVideoFrameCopy';
import {
    DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION,
    type TransferableDolbyVisionEncodedFrameMetadata
} from 'webgpu-player/video/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import { DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH } from 'webgpu-player/video/dolby-vision/DolbyVisionRPUParser';
import {
    DOLBY_VISION_RPU_ENHANCEMENT_LAYER_BIT_DEPTH_WORD_OFFSET
} from 'webgpu-player/video/dolby-vision/DolbyVisionRPUDataLayout';
import {
    parseHEVCHDR10PlusMetadata,
    type HDR10PlusFrameMetadata
} from 'webgpu-player/video/hdr/HDR10PlusMetadata';
import { microsecondsToMilliseconds, secondsToMicroseconds } from 'webgpu-player/MediaTime';
import {
    createDefaultRenderSettings,
    createHDRToSDRRenderSettings,
    RENDER_SETTINGS_UNIFORM_BYTE_LENGTH,
    type RenderSettings
} from 'webgpu-player/presentation/RenderSettings';
import { createDolbyVisionAuthorizationRPUVector } from 'webgpu-player/capability/vectors/DolbyVisionAuthorizationVector';
import WebGPUPresenter, {
    type DecodedWorkerPresentationFrame,
    type PresentationSurface,
    WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS
} from 'webgpu-player/presentation/WebGPUPresenter';
import {
    isWorkerPresentationRequest,
    type WorkerPresentationResponse
} from 'webgpu-player/presentation/WorkerPresentationProtocol';

import { createHDR10PlusHEVCVector } from '../../src/capability/vectors/HDR10PlusVectors';

type MockFunction = ReturnType<typeof vi.fn>;

// Above the 8192 texels a default WebGPU device allows
const ADAPTER_MAXIMUM_TEXTURE_DIMENSION = 16_384;
// An RPU EL bit depth other than the 10 bits a decoded EL holds
const MISMATCHED_ENHANCEMENT_LAYER_BIT_DEPTH = 12;

// The HDR10+ uniform fields and dynamic modes: 0 is static, 1 tone-maps from the scene statistics, 2 follows the curve
const UNIFORM_DYNAMIC_MODE_INDEX = 3;
const UNIFORM_INPUT_PEAK_INDEX = 6;
const UNIFORM_DYNAMIC_TARGET_PEAK_INDEX = 13;
const STATIC_DYNAMIC_MODE = 0;
const SCENE_STATISTICS_DYNAMIC_MODE = 1;
const CURVE_DYNAMIC_MODE = 2;
// The scene peak and curve target of the HDR10+ vectors
const HDR10_PLUS_VECTOR_SCENE_PEAK_NITS = 834.75;
const HDR10_PLUS_VECTOR_CURVE_TARGET_NITS = 1_000;

type Deferred<Value> = {
    promise: Promise<Value>
    reject: (error: unknown) => void
    resolve: (value: Value) => void
};

type CanvasContextHarness = {
    context: GPUCanvasContext
    configure: MockFunction
    getCurrentTexture: MockFunction
    unconfigure: MockFunction
};

type DeviceHarness = {
    createBindGroup: MockFunction
    createBuffer: MockFunction
    createShaderModule: MockFunction
    createTexture: MockFunction
    createRenderPipelineAsync: MockFunction
    device: GPUDevice
    dispatchUncapturedError: (error: GPUError) => boolean
    destroy: MockFunction
    importExternalTexture: MockFunction
    lost: Deferred<GPUDeviceLostInfo>
    popErrorScope: MockFunction
    pushErrorScope: MockFunction
    queueOnSubmittedWorkDone: MockFunction
    queueSubmit: MockFunction
    queueWriteBuffer: MockFunction
    queueWriteTexture: MockFunction
    renderPassSetViewport: MockFunction
    textureDestroy: MockFunction
};

type GPUHarness = {
    devices: DeviceHarness[]
    gpu: GPU
    requestAdapter: MockFunction
    requestDevice: MockFunction
};

type SurfaceHarness = {
    callbacks: Map<number, VideoFrameRequestCallback>
    cancelVideoFrameCallback: MockFunction
    requestVideoFrameCallback: MockFunction
    surface: PresentationSurface
};

let resizeObserverMocks: TestResizeObserver[] = [];

class TestResizeObserver implements ResizeObserver {
    private readonly callback: ResizeObserverCallback;
    private readonly observedElements = new Set<Element>();

    constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        resizeObserverMocks.push(this);
    }

    disconnect(): void {
        this.observedElements.clear();
    }

    observe(target: Element): void {
        this.observedElements.add(target);
    }

    unobserve(target: Element): void {
        this.observedElements.delete(target);
    }

    invokeCallback(): void {
        this.callback([], this);
    }

    notify(target: Element): void {
        if (this.observedElements.has(target)) {
            this.invokeCallback();
        }
    }
}

function notifyResizeObservers(target: Element): void {
    for (const resizeObserver of resizeObserverMocks) {
        resizeObserver.notify(target);
    }
}

let mutationObserverMocks: TestMutationObserver[] = [];

class TestMutationObserver implements MutationObserver {
    private readonly callback: MutationCallback;
    private readonly observedNodes = new Set<Node>();

    constructor(callback: MutationCallback) {
        this.callback = callback;
        mutationObserverMocks.push(this);
    }

    disconnect(): void {
        this.observedNodes.clear();
    }

    observe(target: Node): void {
        this.observedNodes.add(target);
    }

    takeRecords(): MutationRecord[] {
        return [];
    }

    invokeCallback(): void {
        this.callback([], this);
    }

    notify(target: Node): boolean {
        if (!this.observedNodes.has(target)) {
            return false;
        }

        this.invokeCallback();
        return true;
    }
}

function notifyMutationObservers(target: Node): number {
    let notificationCount = 0;
    for (const mutationObserver of mutationObserverMocks) {
        if (mutationObserver.notify(target)) {
            notificationCount += 1;
        }
    }
    return notificationCount;
}

const originalCanvasGetContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext');
const originalDevicePixelRatio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
const originalGPU = Object.getOwnPropertyDescriptor(navigator, 'gpu');
const originalGPUBufferUsage = Object.getOwnPropertyDescriptor(globalThis, 'GPUBufferUsage');
const originalGPUTextureUsage = Object.getOwnPropertyDescriptor(globalThis, 'GPUTextureUsage');
const originalGPUValidationError = Object.getOwnPropertyDescriptor(globalThis, 'GPUValidationError');
const originalMutationObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
const originalSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

function createDeferred<Value>(): Deferred<Value> {
    let rejectPromise: (error: unknown) => void = () => {
        throw new Error('Deferred promise was not initialized');
    };
    let resolvePromise: (value: Value) => void = () => {
        throw new Error('Deferred promise was not initialized');
    };
    const promise = new Promise<Value>((resolve, reject) => {
        rejectPromise = reject;
        resolvePromise = resolve;
    });
    return { promise, reject: rejectPromise, resolve: resolvePromise };
}

function createCanvasContextHarness(): CanvasContextHarness {
    const configure = vi.fn();
    const unconfigure = vi.fn();
    const getCurrentTexture = vi.fn(() => ({
        createView: vi.fn(() => ({}))
    }));
    const context = {
        canvas: document.createElement('canvas'),
        configure,
        getCurrentTexture,
        unconfigure
    } as unknown as GPUCanvasContext;
    return { configure, context, getCurrentTexture, unconfigure };
}

function createDeviceHarness(): DeviceHarness {
    const deviceEventTarget = new EventTarget();
    const lost = createDeferred<GPUDeviceLostInfo>();
    const renderPassSetViewport = vi.fn();
    const renderPass = {
        draw: vi.fn(),
        end: vi.fn(),
        setBindGroup: vi.fn(),
        setPipeline: vi.fn(),
        setViewport: renderPassSetViewport
    };
    const commandEncoder = {
        beginRenderPass: vi.fn(() => renderPass),
        finish: vi.fn(() => ({}))
    };
    const pipeline = {
        getBindGroupLayout: vi.fn(() => ({}))
    };
    const queueSubmit = vi.fn();
    const queueOnSubmittedWorkDone = vi.fn(() => Promise.resolve());
    const queueWriteBuffer = vi.fn();
    const queueWriteTexture = vi.fn();
    const importExternalTexture = vi.fn(() => ({}));
    const createRenderPipelineAsync = vi.fn(() => Promise.resolve(pipeline));
    const createShaderModule = vi.fn(() => ({}));
    const createBindGroup = vi.fn(() => ({}));
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => ({
        destroy: vi.fn(),
        label: descriptor.label
    }));
    const textureDestroy = vi.fn();
    const createTexture = vi.fn((descriptor: GPUTextureDescriptor) => ({
        createView: vi.fn(() => ({ label: descriptor.label })),
        destroy: textureDestroy,
        label: descriptor.label
    }));
    const destroy = vi.fn();
    const popErrorScope = vi.fn(() => Promise.resolve(null));
    const pushErrorScope = vi.fn();
    const device = {
        addEventListener: deviceEventTarget.addEventListener.bind(deviceEventTarget),
        createBindGroup,
        createBuffer,
        createCommandEncoder: vi.fn(() => commandEncoder),
        createRenderPipelineAsync,
        createSampler: vi.fn(() => ({})),
        createShaderModule,
        createTexture,
        destroy,
        features: new Set<GPUFeatureName>(),
        importExternalTexture,
        label: '',
        limits: { maxTextureDimension2D: 8_192 },
        lost: lost.promise,
        popErrorScope,
        pushErrorScope,
        queue: {
            onSubmittedWorkDone: queueOnSubmittedWorkDone,
            submit: queueSubmit,
            writeBuffer: queueWriteBuffer,
            writeTexture: queueWriteTexture
        },
        removeEventListener: deviceEventTarget.removeEventListener.bind(deviceEventTarget)
    } as unknown as GPUDevice;
    const dispatchUncapturedError = (error: GPUError): boolean => {
        const event = new Event('uncapturederror', { cancelable: true });
        Object.defineProperty(event, 'error', { value: error });
        return deviceEventTarget.dispatchEvent(event);
    };

    return {
        createBindGroup,
        createBuffer,
        createShaderModule,
        createTexture,
        createRenderPipelineAsync,
        device,
        dispatchUncapturedError,
        destroy,
        importExternalTexture,
        lost,
        popErrorScope,
        pushErrorScope,
        queueOnSubmittedWorkDone,
        queueSubmit,
        queueWriteBuffer,
        queueWriteTexture,
        renderPassSetViewport,
        textureDestroy
    };
}

function createGPUHarness(deviceCount = 1): GPUHarness {
    const devices: DeviceHarness[] = [];
    for (let deviceIndex = 0; deviceIndex < deviceCount; deviceIndex += 1) {
        devices.push(createDeviceHarness());
    }

    let requestedDeviceIndex = 0;
    const requestDevice = vi.fn(() => {
        const deviceHarness = devices[requestedDeviceIndex];
        requestedDeviceIndex += 1;
        return Promise.resolve(deviceHarness?.device);
    });
    const adapter = {
        limits: { maxTextureDimension2D: ADAPTER_MAXIMUM_TEXTURE_DIMENSION },
        requestDevice
    } as unknown as GPUAdapter;
    const requestAdapter = vi.fn(() => Promise.resolve(adapter));
    const gpu = {
        getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
        requestAdapter
    } as unknown as GPU;
    return { devices, gpu, requestAdapter, requestDevice };
}

function createRectangle(left: number, top: number, width: number, height: number): DOMRect {
    return {
        bottom: top + height,
        height,
        left,
        right: left + width,
        toJSON: () => ({}),
        top,
        width,
        x: left,
        y: top
    };
}

function createSurfaceHarness(width = 1_280, height = 720): SurfaceHarness {
    const container = document.createElement('div');
    const video = document.createElement('video');
    const callbacks = new Map<number, VideoFrameRequestCallback>();
    let nextCallbackId = 1;
    const requestVideoFrameCallback = vi.fn((callback: VideoFrameRequestCallback) => {
        const callbackId = nextCallbackId;
        nextCallbackId += 1;
        callbacks.set(callbackId, callback);
        return callbackId;
    });
    const cancelVideoFrameCallback = vi.fn();

    Object.defineProperties(container, {
        clientHeight: { configurable: true, value: height },
        clientWidth: { configurable: true, value: width }
    });
    Object.defineProperties(video, {
        cancelVideoFrameCallback: { configurable: true, value: cancelVideoFrameCallback },
        readyState: { configurable: true, value: VIDEO_READY_STATE_CURRENT_DATA },
        requestVideoFrameCallback: { configurable: true, value: requestVideoFrameCallback },
        videoHeight: { configurable: true, value: 1_080 },
        videoWidth: { configurable: true, value: 1_920 }
    });
    container.getBoundingClientRect = vi.fn(() => createRectangle(0, 0, width, height));
    video.getBoundingClientRect = vi.fn(() => createRectangle(0, 0, width, height));
    container.appendChild(video);
    document.body.appendChild(container);

    return {
        callbacks,
        cancelVideoFrameCallback,
        requestVideoFrameCallback,
        surface: { container, video }
    };
}

function createFrameMetadata(mediaTime = 1.234567): VideoFrameCallbackMetadata {
    const callbackTime = performance.now();
    return {
        expectedDisplayTime: callbackTime + 1,
        height: 1_080,
        mediaTime,
        presentationTime: callbackTime,
        presentedFrames: 1,
        processingDuration: 0.001,
        width: 1_920
    };
}

function createNeutralBT709VideoFrame(close: MockFunction): VideoFrame {
    return {
        close,
        codedHeight: 2_160,
        codedWidth: 3_840,
        colorSpace: {
            fullRange: false,
            matrix: 'bt709',
            primaries: 'bt709',
            transfer: 'bt709'
        },
        displayHeight: 2_160,
        displayWidth: 3_840
    } as unknown as VideoFrame;
}

type RawPlaneDefinition = {
    bytesPerComponent: 1 | 2
    componentsPerTexel: 1 | 2
    heightDivisor: 1 | 2
    kind: 'u' | 'uv' | 'v' | 'y'
    widthDivisor: 1 | 2
};

function createRawFrame(
    format: SupportedRawVideoFrameFormat,
    metadata: InputColorMetadata,
    codedWidth = 8,
    codedHeight = 4,
    visibleRectangle = { height: codedHeight, width: codedWidth, x: 0, y: 0 }
): TransferableRawVideoFrame {
    const planeDefinitions: RawPlaneDefinition[] = [];
    switch (format) {
        case 'I420':
            planeDefinitions.push(
                { bytesPerComponent: 1, componentsPerTexel: 1, heightDivisor: 1, kind: 'y', widthDivisor: 1 },
                { bytesPerComponent: 1, componentsPerTexel: 1, heightDivisor: 2, kind: 'u', widthDivisor: 2 },
                { bytesPerComponent: 1, componentsPerTexel: 1, heightDivisor: 2, kind: 'v', widthDivisor: 2 }
            );
            break;
        case 'I422':
            planeDefinitions.push(
                { bytesPerComponent: 1, componentsPerTexel: 1, heightDivisor: 1, kind: 'y', widthDivisor: 1 },
                { bytesPerComponent: 1, componentsPerTexel: 1, heightDivisor: 1, kind: 'u', widthDivisor: 2 },
                { bytesPerComponent: 1, componentsPerTexel: 1, heightDivisor: 1, kind: 'v', widthDivisor: 2 }
            );
            break;
        case 'I444':
            planeDefinitions.push(
                { bytesPerComponent: 1, componentsPerTexel: 1, heightDivisor: 1, kind: 'y', widthDivisor: 1 },
                { bytesPerComponent: 1, componentsPerTexel: 1, heightDivisor: 1, kind: 'u', widthDivisor: 1 },
                { bytesPerComponent: 1, componentsPerTexel: 1, heightDivisor: 1, kind: 'v', widthDivisor: 1 }
            );
            break;
        case 'I420P10':
        case 'I420P12':
            planeDefinitions.push(
                { bytesPerComponent: 2, componentsPerTexel: 1, heightDivisor: 1, kind: 'y', widthDivisor: 1 },
                { bytesPerComponent: 2, componentsPerTexel: 1, heightDivisor: 2, kind: 'u', widthDivisor: 2 },
                { bytesPerComponent: 2, componentsPerTexel: 1, heightDivisor: 2, kind: 'v', widthDivisor: 2 }
            );
            break;
        case 'I422P10':
        case 'I422P12':
            planeDefinitions.push(
                { bytesPerComponent: 2, componentsPerTexel: 1, heightDivisor: 1, kind: 'y', widthDivisor: 1 },
                { bytesPerComponent: 2, componentsPerTexel: 1, heightDivisor: 1, kind: 'u', widthDivisor: 2 },
                { bytesPerComponent: 2, componentsPerTexel: 1, heightDivisor: 1, kind: 'v', widthDivisor: 2 }
            );
            break;
        case 'I444P10':
        case 'I444P12':
            planeDefinitions.push(
                { bytesPerComponent: 2, componentsPerTexel: 1, heightDivisor: 1, kind: 'y', widthDivisor: 1 },
                { bytesPerComponent: 2, componentsPerTexel: 1, heightDivisor: 1, kind: 'u', widthDivisor: 1 },
                { bytesPerComponent: 2, componentsPerTexel: 1, heightDivisor: 1, kind: 'v', widthDivisor: 1 }
            );
            break;
        case 'NV12':
            planeDefinitions.push(
                { bytesPerComponent: 1, componentsPerTexel: 1, heightDivisor: 1, kind: 'y', widthDivisor: 1 },
                { bytesPerComponent: 1, componentsPerTexel: 2, heightDivisor: 2, kind: 'uv', widthDivisor: 2 }
            );
            break;
    }

    const planes: TransferableRawVideoFrame['planes'][number][] = [];
    let byteOffset = 0;
    for (const definition of planeDefinitions) {
        const width = Math.ceil(codedWidth / definition.widthDivisor);
        const height = Math.ceil(codedHeight / definition.heightDivisor);
        const rowByteLength = width * definition.componentsPerTexel * definition.bytesPerComponent;
        const bytesPerRow = Math.ceil(rowByteLength / 256) * 256;
        const byteLength = bytesPerRow * height;
        planes.push({
            byteLength,
            byteOffset,
            bytesPerComponent: definition.bytesPerComponent,
            bytesPerRow,
            componentsPerTexel: definition.componentsPerTexel,
            height,
            kind: definition.kind,
            rowByteLength,
            width
        });
        byteOffset += byteLength;
    }

    const durationMicroseconds = secondsToMicroseconds(1 / 24);
    const timestampMicroseconds = secondsToMicroseconds(2);
    return {
        bitDepth: metadata.bitDepth as 8 | 10 | 12,
        codedHeight,
        codedWidth,
        colorSpace: {
            fullRange: metadata.range === 'full',
            matrix: metadata.matrix,
            primaries: metadata.primaries,
            transfer: metadata.transfer === 'pq' ? 'smpte2084' : 'arib-std-b67'
        },
        data: new ArrayBuffer(byteOffset),
        displayHeight: visibleRectangle.height,
        displayWidth: visibleRectangle.width,
        durationMicroseconds,
        format,
        planes,
        timestampMicroseconds,
        visibleRectangle
    };
}

type CompoundDolbyVisionRawFrames = {
    baseFrame: TransferableRawVideoFrame
    enhancementFrame: TransferableRawVideoFrame
};

/** Creates a BL in baseFormat and a half-resolution I420P10 EL in one compound buffer, as the worker posts them. */
function createCompoundDolbyVisionRawFrames(baseFormat: RawDolbyVisionVideoFrameFormat = 'I420P10'): CompoundDolbyVisionRawFrames {
    const baseFrameTemplate = createRawFrame(
        baseFormat,
        createPQColorMetadata({ bitDepth: getRawFormatBitDepth(baseFormat) }),
        8,
        4
    );
    const enhancementFrameTemplate = createRawFrame('I420P10', createPQColorMetadata(), 4, 2);
    const enhancementByteOffset = baseFrameTemplate.data.byteLength;
    const data = new ArrayBuffer(enhancementByteOffset + enhancementFrameTemplate.data.byteLength);
    return {
        baseFrame: {
            ...baseFrameTemplate,
            data
        },
        enhancementFrame: {
            ...enhancementFrameTemplate,
            data,
            planes: enhancementFrameTemplate.planes.map(plane => ({
                ...plane,
                byteOffset: plane.byteOffset + enhancementByteOffset
            }))
        }
    };
}

function createDolbyVisionEncodedMetadata(
    packedRPUData = createDolbyVisionAuthorizationRPUVector(),
    enhancementLayerDisposition: TransferableDolbyVisionEncodedFrameMetadata[
        'enhancementLayerDisposition'
    ] = 'absent',
    hasEnhancementLayerVCL = false
): TransferableDolbyVisionEncodedFrameMetadata {
    return {
        enhancementLayerDisposition,
        hasEnhancementLayerVCL,
        parsedRPUData: [ packedRPUData ],
        schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
    };
}

function installGPU(gpu: GPU): void {
    Object.defineProperty(navigator, 'gpu', {
        configurable: true,
        value: gpu
    });
}

function installCanvasContext(context: GPUCanvasContext | null): void {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        value: vi.fn((contextId: string) => contextId === 'webgpu' ? context : null)
    });
}

function restoreProperty(
    target: object,
    propertyName: PropertyKey,
    descriptor: PropertyDescriptor | undefined
): void {
    if (descriptor) {
        Object.defineProperty(target, propertyName, descriptor);
    } else {
        Reflect.deleteProperty(target, propertyName);
    }
}

const VIDEO_READY_STATE_CURRENT_DATA = 2;

/** Starts a pushed-frame session with a configured raw route and returns the presenter and its fallback handler. */
async function startRawRoutePresentation(
    metadata: InputColorMetadata,
    rawFrameFormat: SupportedRawVideoFrameFormat,
    settings: RenderSettings
): Promise<{ fallbackHandler: MockFunction, presenter: WebGPUPresenter }> {
    webSettingsMockState.hdrToneMappingEnabled = true;
    const gpuHarness = createGPUHarness();
    const contextHarness = createCanvasContextHarness();
    const surfaceHarness = createSurfaceHarness();
    installGPU(gpuHarness.gpu);
    installCanvasContext(contextHarness.context);
    const fallbackHandler = vi.fn();
    const presenter = new WebGPUPresenter(fallbackHandler);

    presenter.startSession(1);
    presenter.setDecodedFramePushMode(true, 1);
    presenter.attach(surfaceHarness.surface, 1);
    await vi.waitFor(() => expect(
        surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
    ).toBeInstanceOf(HTMLCanvasElement));
    await expect(presenter.configureColorPipeline({
        inputMode: 'raw-yuv',
        metadata,
        rawFrameFormat,
        settings
    }, 1)).resolves.toBe(true);
    return { fallbackHandler, presenter };
}

function presentRawFrame(presenter: WebGPUPresenter, frame: TransferableRawVideoFrame): boolean {
    return presenter.presentDecodedFrame({
        durationMicroseconds: frame.durationMicroseconds ?? secondsToMicroseconds(0),
        frame,
        mediaTimeMicroseconds: frame.timestampMicroseconds,
        outputMode: 'raw-planes'
    }, 1);
}

describe('WebGPUPresenter', () => {
    beforeEach(() => {
        mutationObserverMocks = [];
        resizeObserverMocks = [];
        webSettingsMockState.hdrToneMappingEnabled = false;
        rawHDRAuthorizationMockState.authorized = true;
        rawHDRAuthorizationMockState.prewarmCalls = [];
        externalHDRAuthorizationMockState.authorizeCalls = [];
        externalHDRAuthorizationMockState.authorized = true;
        externalHDRAuthorizationMockState.prewarmCalls = [];
        dolbyVisionAuthorizationMockState.authorizeCalls = [];
        dolbyVisionAuthorizationMockState.authorizeRouteNames = [];
        dolbyVisionAuthorizationMockState.authorized = true;
        dolbyVisionAuthorizationMockState.prewarmCalls = [];
        dolbyVisionAuthorizationMockState.prewarmRouteNames = [];
        dolbyVisionAuthorizationMockState.rejectedRouteNames = new Set<string>();
        dolbyVisionAuthorizationMockState.waitRouteNames = [];
        Object.defineProperty(window, 'isSecureContext', {
            configurable: true,
            value: true
        });
        Object.defineProperty(window, 'devicePixelRatio', {
            configurable: true,
            value: 1
        });
        Object.defineProperty(globalThis, 'GPUBufferUsage', {
            configurable: true,
            // WebGPU defines these external names
            // eslint-disable-next-line @typescript-eslint/naming-convention
            value: { COPY_DST: 8, STORAGE: 128, UNIFORM: 64 }
        });
        Object.defineProperty(globalThis, 'GPUValidationError', {
            configurable: true,
            value: class extends Error {}
        });
        Object.defineProperty(globalThis, 'GPUTextureUsage', {
            configurable: true,
            // WebGPU defines these external names
            // eslint-disable-next-line @typescript-eslint/naming-convention
            value: { COPY_DST: 2, TEXTURE_BINDING: 4 }
        });
        Object.defineProperty(globalThis, 'MutationObserver', {
            configurable: true,
            value: TestMutationObserver
        });
        Object.defineProperty(globalThis, 'ResizeObserver', {
            configurable: true,
            value: TestResizeObserver
        });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        restoreProperty(HTMLCanvasElement.prototype, 'getContext', originalCanvasGetContext);
        restoreProperty(navigator, 'gpu', originalGPU);
        restoreProperty(globalThis, 'GPUBufferUsage', originalGPUBufferUsage);
        restoreProperty(globalThis, 'GPUTextureUsage', originalGPUTextureUsage);
        restoreProperty(globalThis, 'GPUValidationError', originalGPUValidationError);
        restoreProperty(globalThis, 'MutationObserver', originalMutationObserver);
        restoreProperty(globalThis, 'ResizeObserver', originalResizeObserver);
        restoreProperty(window, 'devicePixelRatio', originalDevicePixelRatio);
        restoreProperty(window, 'isSecureContext', originalSecureContext);
    });

    it('falls back once in an insecure context without touching playback DOM', async () => {
        Object.defineProperty(window, 'isSecureContext', {
            configurable: true,
            value: false
        });
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);

        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'insecure-context');
        expect(document.querySelector('.webgpuPlayerCanvas')).toBeNull();
        expect(presenter.getTelemetry().state).toBe('fallback');
    });

    it('falls back when no WebGPU adapter is available', async () => {
        const gpuHarness = createGPUHarness();
        gpuHarness.requestAdapter.mockResolvedValue(null);
        installGPU(gpuHarness.gpu);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);

        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'adapter-unavailable');
        expect(gpuHarness.requestDevice).not.toHaveBeenCalled();
        expect(presenter.getTelemetry().state).toBe('fallback');
    });

    it('bounds an adapter request that never settles', async () => {
        vi.useFakeTimers();
        const gpuHarness = createGPUHarness();
        gpuHarness.requestAdapter.mockReturnValue(new Promise<GPUAdapter | null>(() => undefined));
        installGPU(gpuHarness.gpu);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        await vi.advanceTimersByTimeAsync(microsecondsToMilliseconds(WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS));

        expect(fallbackHandler).toHaveBeenCalledOnce();
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'adapter-unavailable');
        expect(gpuHarness.requestDevice).not.toHaveBeenCalled();
        expect(presenter.getTelemetry().state).toBe('fallback');
    });

    it('falls back when WebGPU device acquisition fails', async () => {
        const gpuHarness = createGPUHarness();
        gpuHarness.requestDevice.mockRejectedValue(new Error('simulated device request failure'));
        installGPU(gpuHarness.gpu);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);

        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'device-request-failed');
        expect(presenter.getTelemetry().state).toBe('fallback');
    });

    it('requests the adapter texture maximum so frames past 8192 texels upload', async () => {
        const gpuHarness = createGPUHarness();
        installGPU(gpuHarness.gpu);
        const presenter = new WebGPUPresenter(vi.fn());

        presenter.startSession(1);

        await vi.waitFor(() => expect(gpuHarness.requestDevice).toHaveBeenCalledOnce());
        expect(gpuHarness.requestDevice).toHaveBeenCalledWith({
            requiredLimits: { maxTextureDimension2D: ADAPTER_MAXIMUM_TEXTURE_DIMENSION }
        });
    });

    it('destroys the device and falls back when pipeline creation fails', async () => {
        const gpuHarness = createGPUHarness();
        const deviceHarness = gpuHarness.devices[0];
        deviceHarness.createRenderPipelineAsync.mockRejectedValue(new Error('simulated pipeline creation failure'));
        installGPU(gpuHarness.gpu);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);

        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'pipeline-creation-failed');
        expect(deviceHarness.destroy).toHaveBeenCalledOnce();
        expect(presenter.getTelemetry().state).toBe('fallback');
    });

    it('removes the canvas and falls back when canvas configuration throws', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        contextHarness.configure.mockImplementation(() => {
            throw new Error('simulated canvas configuration failure');
        });
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);

        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'canvas-configuration-failed');
        expect(contextHarness.unconfigure).toHaveBeenCalledOnce();
        expect(surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')).toBeNull();
        expect(presenter.getTelemetry().state).toBe('fallback');
    });

    it('falls back when the initial video frame callback request throws', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        surfaceHarness.requestVideoFrameCallback.mockImplementation(() => {
            throw new Error('simulated frame callback request failure');
        });
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);

        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'request-video-frame-callback-unavailable');
        expect(surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')).toBeNull();
        expect(presenter.getTelemetry().state).toBe('fallback');
    });

    it('falls back when requesting the next video frame callback throws', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        surfaceHarness.requestVideoFrameCallback.mockImplementation(() => {
            throw new Error('simulated next frame callback request failure');
        });

        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());

        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledOnce();
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'request-video-frame-callback-unavailable');
        expect(gpuHarness.devices[0].queueSubmit).toHaveBeenCalledOnce();
        expect(surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')).toBeNull();
        expect(presenter.getTelemetry().state).toBe('fallback');
    });

    it('imports and submits one external texture in the video frame callback task', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());

        const canvas = surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas');
        expect(canvas).toBeInstanceOf(HTMLCanvasElement);
        expect(canvas?.classList.contains('webgpuPlayerCanvas-visible')).toBe(false);

        const callback = surfaceHarness.callbacks.get(1);
        expect(callback).toBeDefined();
        callback?.(performance.now() + 1, createFrameMetadata());

        const deviceHarness = gpuHarness.devices[0];
        expect(deviceHarness.importExternalTexture).toHaveBeenCalledWith({
            colorSpace: 'srgb',
            source: surfaceHarness.surface.video
        });
        expect(deviceHarness.queueWriteBuffer).toHaveBeenCalledOnce();
        expect(deviceHarness.queueSubmit).toHaveBeenCalledOnce();
        expect(deviceHarness.pushErrorScope).toHaveBeenCalledWith('validation');
        expect(deviceHarness.popErrorScope).toHaveBeenCalledOnce();
        expect(canvas?.classList.contains('webgpuPlayerCanvas-visible')).toBe(false);
        expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce();
        expect(presenter.getTelemetry().presentedFrameCount).toBe(0);

        await vi.waitFor(() => {
            expect(canvas?.classList.contains('webgpuPlayerCanvas-visible')).toBe(true);
            expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2);
        });
        expect(presenter.getTelemetry()).toMatchObject({
            fallbackReason: null,
            lastPresentedMediaTimeMicroseconds: 1_234_567,
            mode: 'identity-sdr',
            presentedFrameCount: 1,
            state: 'presenting'
        });
    });

    it('presents and closes an owned decoded frame without a native callback tick', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());
        const closeFrame = vi.fn();
        const frame = {
            close: closeFrame,
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        } as unknown as VideoFrame;

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));

        const submitted = presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame,
            mediaTimeMicroseconds: secondsToMicroseconds(2),
            outputMode: 'video-frame'
        }, 1);

        expect(submitted).toBe(true);
        expect(surfaceHarness.requestVideoFrameCallback).not.toHaveBeenCalled();
        expect(gpuHarness.devices[0].importExternalTexture).toHaveBeenCalledWith({
            colorSpace: 'srgb',
            source: frame
        });
        expect(closeFrame).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
        expect(surfaceHarness.requestVideoFrameCallback).not.toHaveBeenCalled();
        expect(presenter.getTelemetry()).toMatchObject({
            decodedFrameCount: 1,
            lastPresentedMediaTimeMicroseconds: 2_000_000,
            presentationSource: 'decoded'
        });
    });

    it('holds decoded VideoFrame backpressure until submitted GPU work finishes', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        const submittedWork = createDeferred<void>();
        gpuHarness.devices[0].queueOnSubmittedWorkDone.mockReturnValueOnce(submittedWork.promise);
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());
        const closeFrame = vi.fn();
        const submissionCompleted = vi.fn();
        const frame = {
            close: closeFrame,
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        } as unknown as VideoFrame;

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));

        expect(presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame,
            mediaTimeMicroseconds: secondsToMicroseconds(2),
            outputMode: 'video-frame'
        }, 1, submissionCompleted)).toBe(true);

        expect(gpuHarness.devices[0].queueSubmit).toHaveBeenCalledOnce();
        expect(gpuHarness.devices[0].queueOnSubmittedWorkDone).toHaveBeenCalledOnce();
        expect(closeFrame).toHaveBeenCalledOnce();
        expect(submissionCompleted).not.toHaveBeenCalled();

        submittedWork.resolve();
        await vi.waitFor(() => expect(submissionCompleted).toHaveBeenCalledWith(true));
    });

    it('releases decoded VideoFrame backpressure when submitted work rejects', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        const submittedWork = createDeferred<void>();
        gpuHarness.devices[0].queueOnSubmittedWorkDone.mockReturnValueOnce(submittedWork.promise);
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());
        const submissionCompleted = vi.fn();
        const frame = {
            close: vi.fn(),
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        } as unknown as VideoFrame;

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));

        expect(presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame,
            mediaTimeMicroseconds: secondsToMicroseconds(2),
            outputMode: 'video-frame'
        }, 1, submissionCompleted)).toBe(true);

        submittedWork.reject(new Error('device lost'));
        await vi.waitFor(() => expect(submissionCompleted).toHaveBeenCalledWith(false));
    });

    it('presents neutralized native Main10 frames through the authorized HDR shader', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const metadata = createPQColorMetadata();
        const closeFrame = vi.fn();
        const frame = createNeutralBT709VideoFrame(closeFrame);

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'external-hdr',
            metadata,
            settings: createHDRToSDRRenderSettings({
                toneMapping: { inputPeakNits: metadata.nominalPeakNits }
            })
        }, 1)).resolves.toBe(true);

        expect(presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame,
            mediaTimeMicroseconds: secondsToMicroseconds(2),
            outputMode: 'video-frame'
        }, 1)).toBe(true);
        expect(gpuHarness.devices[0].importExternalTexture).toHaveBeenCalledWith({
            colorSpace: 'srgb',
            source: frame
        });
        expect(closeFrame).toHaveBeenCalledOnce();
        const toneMappingShaderDescriptor = gpuHarness.devices[0].createShaderModule.mock.calls
            .map((call: unknown[]) => call[0] as { code: string })
            .find(descriptor => descriptor.code.includes('fn recoverLimitedRangeBT709YUV'));
        expect(toneMappingShaderDescriptor).toBeDefined();
        expect(fallbackHandler).not.toHaveBeenCalled();
    });

    it('requests one generation-safe pushed-frame refresh after device recovery', async () => {
        const gpuHarness = createGPUHarness(2);
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const refreshHandler = vi.fn();
        const presenter = new WebGPUPresenter(vi.fn(), refreshHandler);
        const frame = {
            close: vi.fn(),
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        } as unknown as VideoFrame;

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame,
            mediaTimeMicroseconds: secondsToMicroseconds(2),
            outputMode: 'video-frame'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        gpuHarness.devices[0].lost.resolve({
            message: 'simulated pushed-frame device loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);

        await vi.waitFor(() => expect(gpuHarness.requestDevice).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(refreshHandler).toHaveBeenCalledOnce());
        expect(refreshHandler).toHaveBeenCalledWith(1);
        expect(surfaceHarness.requestVideoFrameCallback).not.toHaveBeenCalled();

        presenter.endSession(2);
        gpuHarness.devices[1].lost.resolve({
            message: 'stale pushed-frame device loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await Promise.resolve();
        await Promise.resolve();
        expect(refreshHandler).toHaveBeenCalledOnce();
    });

    it('refreshes pushed frames only for changed layout and current object-fit state', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const refreshHandler = vi.fn();
        const presenter = new WebGPUPresenter(vi.fn(), refreshHandler);
        const frame = {
            close: vi.fn(),
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        } as unknown as VideoFrame;

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame,
            mediaTimeMicroseconds: secondsToMicroseconds(2),
            outputMode: 'video-frame'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        window.dispatchEvent(new Event('resize'));
        expect(refreshHandler).not.toHaveBeenCalled();

        Object.defineProperties(surfaceHarness.surface.container, {
            clientHeight: { configurable: true, value: 600 },
            clientWidth: { configurable: true, value: 800 }
        });
        surfaceHarness.surface.container.getBoundingClientRect = vi.fn(() => createRectangle(0, 0, 800, 600));
        surfaceHarness.surface.video.getBoundingClientRect = vi.fn(() => createRectangle(0, 0, 800, 600));
        Object.defineProperty(window, 'devicePixelRatio', {
            configurable: true,
            value: 1.5
        });
        window.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('resize'));

        expect(refreshHandler).toHaveBeenCalledOnce();
        expect(refreshHandler).toHaveBeenCalledWith(1);

        surfaceHarness.surface.video.style.objectFit = 'cover';
        presenter.refresh(1);
        presenter.refresh(1);
        expect(refreshHandler).toHaveBeenCalledTimes(2);
        presenter.seek(2);
        presenter.refresh(1);
        presenter.endSession(3);
        window.dispatchEvent(new Event('resize'));
        expect(refreshHandler).toHaveBeenCalledTimes(2);
    });

    it('tracks ResizeObserver geometry changes without refreshing an unchanged layout', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        let layoutHeight = 720;
        let layoutWidth = 1_280;
        Object.defineProperties(surfaceHarness.surface.container, {
            clientHeight: { configurable: true, get: (): number => layoutHeight },
            clientWidth: { configurable: true, get: (): number => layoutWidth }
        });
        surfaceHarness.surface.container.getBoundingClientRect = vi.fn(
            () => createRectangle(0, 0, layoutWidth, layoutHeight)
        );
        surfaceHarness.surface.video.getBoundingClientRect = vi.fn(
            () => createRectangle(0, 0, layoutWidth, layoutHeight)
        );
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const refreshHandler = vi.fn();
        const presenter = new WebGPUPresenter(vi.fn(), refreshHandler);
        const frame = {
            close: vi.fn(),
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        } as unknown as VideoFrame;

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame,
            mediaTimeMicroseconds: secondsToMicroseconds(2),
            outputMode: 'video-frame'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
        const canvas = surfaceHarness.surface.container.querySelector('canvas');

        notifyResizeObservers(surfaceHarness.surface.video);
        expect(refreshHandler).not.toHaveBeenCalled();

        layoutHeight = 225;
        layoutWidth = 400;
        notifyResizeObservers(surfaceHarness.surface.container);
        expect(refreshHandler).toHaveBeenCalledOnce();
        expect(canvas).toMatchObject({ height: 225, width: 400 });
        expect(canvas?.style.height).toBe('225px');
        expect(canvas?.style.width).toBe('400px');

        layoutHeight = 720;
        layoutWidth = 1_280;
        notifyResizeObservers(surfaceHarness.surface.container);
        expect(refreshHandler).toHaveBeenCalledTimes(2);
        expect(canvas).toMatchObject({ height: 720, width: 1_280 });
        expect(canvas?.style.height).toBe('720px');
        expect(canvas?.style.width).toBe('1280px');

        notifyResizeObservers(surfaceHarness.surface.video);
        expect(refreshHandler).toHaveBeenCalledTimes(2);
    });

    it('restores transient animation geometry when the final motion event fires', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        let layoutHeight = 720;
        let layoutWidth = 1_280;
        Object.defineProperties(surfaceHarness.surface.container, {
            clientHeight: { configurable: true, get: (): number => layoutHeight },
            clientWidth: { configurable: true, get: (): number => layoutWidth }
        });
        surfaceHarness.surface.container.getBoundingClientRect = vi.fn(
            () => createRectangle(0, 0, layoutWidth, layoutHeight)
        );
        surfaceHarness.surface.video.getBoundingClientRect = vi.fn(
            () => createRectangle(0, 0, layoutWidth, layoutHeight)
        );
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const refreshHandler = vi.fn();
        const presenter = new WebGPUPresenter(vi.fn(), refreshHandler);
        const frame = {
            close: vi.fn(),
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        } as unknown as VideoFrame;

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame,
            mediaTimeMicroseconds: secondsToMicroseconds(2),
            outputMode: 'video-frame'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
        const canvas = surfaceHarness.surface.container.querySelector('canvas');

        layoutHeight = 225;
        layoutWidth = 400;
        surfaceHarness.surface.container.dispatchEvent(new Event('animationstart', { bubbles: true }));
        expect(refreshHandler).toHaveBeenCalledOnce();
        expect(canvas).toMatchObject({ height: 225, width: 400 });

        layoutHeight = 720;
        layoutWidth = 1_280;
        surfaceHarness.surface.container.dispatchEvent(new Event('animationend', { bubbles: true }));
        expect(refreshHandler).toHaveBeenCalledTimes(2);
        expect(canvas).toMatchObject({ height: 720, width: 1_280 });
        expect(canvas?.style.height).toBe('720px');
        expect(canvas?.style.width).toBe('1280px');
    });

    it('remeasures a restored surface on the first frame after seek', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        let layoutHeight = 720;
        let layoutWidth = 1_280;
        Object.defineProperties(surfaceHarness.surface.container, {
            clientHeight: { configurable: true, get: (): number => layoutHeight },
            clientWidth: { configurable: true, get: (): number => layoutWidth }
        });
        surfaceHarness.surface.container.getBoundingClientRect = vi.fn(
            () => createRectangle(0, 0, layoutWidth, layoutHeight)
        );
        surfaceHarness.surface.video.getBoundingClientRect = vi.fn(
            () => createRectangle(0, 0, layoutWidth, layoutHeight)
        );
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn(), vi.fn());
        const firstFrame = {
            close: vi.fn(),
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        } as unknown as VideoFrame;

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame: firstFrame,
            mediaTimeMicroseconds: secondsToMicroseconds(2),
            outputMode: 'video-frame'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
        const canvas = surfaceHarness.surface.container.querySelector('canvas');

        layoutHeight = 225;
        layoutWidth = 400;
        presenter.refresh(1);
        expect(canvas).toMatchObject({ height: 225, width: 400 });

        layoutHeight = 720;
        layoutWidth = 1_280;
        presenter.seek(2);
        const secondFrame = {
            close: vi.fn(),
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        } as unknown as VideoFrame;
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame: secondFrame,
            mediaTimeMicroseconds: secondsToMicroseconds(3),
            outputMode: 'video-frame'
        }, 2)).toBe(true);

        expect(canvas).toMatchObject({ height: 720, width: 1_280 });
        expect(canvas?.style.height).toBe('720px');
        expect(canvas?.style.width).toBe('1280px');
    });

    it('observes object-fit and object-position changes without source dimension changes', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness(1_000, 1_000);
        surfaceHarness.surface.video.style.objectFit = 'fill';
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const refreshHandler = vi.fn();
        const presenter = new WebGPUPresenter(vi.fn(), refreshHandler);
        const firstFrame = {
            close: vi.fn(),
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        } as unknown as VideoFrame;

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame: firstFrame,
            mediaTimeMicroseconds: secondsToMicroseconds(2),
            outputMode: 'video-frame'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
        expect(mutationObserverMocks).toHaveLength(1);
        expect(gpuHarness.devices[0].renderPassSetViewport).toHaveBeenLastCalledWith(
            0,
            0,
            1_000,
            1_000,
            0,
            1
        );
        const videoRectangle = surfaceHarness.surface.video.getBoundingClientRect as MockFunction;
        const rectangleCallCount = videoRectangle.mock.calls.length;

        surfaceHarness.surface.video.style.objectFit = 'contain';
        expect(window.getComputedStyle(surfaceHarness.surface.video).objectFit).toBe('contain');
        expect(notifyMutationObservers(surfaceHarness.surface.video)).toBe(1);
        expect(videoRectangle).toHaveBeenCalledTimes(rectangleCallCount + 1);
        expect(refreshHandler).toHaveBeenCalledOnce();
        surfaceHarness.surface.video.style.objectPosition = '50% 75%';
        notifyMutationObservers(surfaceHarness.surface.video);
        expect(refreshHandler).toHaveBeenCalledTimes(2);

        surfaceHarness.surface.video.classList.add('geometry-unchanged');
        notifyMutationObservers(surfaceHarness.surface.video);
        expect(refreshHandler).toHaveBeenCalledTimes(2);

        const secondFrame = {
            close: vi.fn(),
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        } as unknown as VideoFrame;
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame: secondFrame,
            mediaTimeMicroseconds: secondsToMicroseconds(3),
            outputMode: 'video-frame'
        }, 1)).toBe(true);
        expect(gpuHarness.devices[0].renderPassSetViewport).toHaveBeenLastCalledWith(
            0,
            328.125,
            1_000,
            562.5,
            0,
            1
        );
    });

    it('observes instantaneous style and class changes on the surface ancestor chain', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        const surfaceAncestor = document.createElement('section');
        document.body.appendChild(surfaceAncestor);
        surfaceAncestor.appendChild(surfaceHarness.surface.container);
        let layoutHeight = 720;
        let layoutWidth = 1_280;
        Object.defineProperties(surfaceHarness.surface.container, {
            clientHeight: { configurable: true, get: (): number => layoutHeight },
            clientWidth: { configurable: true, get: (): number => layoutWidth }
        });
        surfaceHarness.surface.container.getBoundingClientRect = vi.fn(
            () => createRectangle(0, 0, layoutWidth, layoutHeight)
        );
        surfaceHarness.surface.video.getBoundingClientRect = vi.fn(
            () => createRectangle(0, 0, layoutWidth, layoutHeight)
        );
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const refreshHandler = vi.fn();
        const presenter = new WebGPUPresenter(vi.fn(), refreshHandler);
        const frame = {
            close: vi.fn(),
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        } as unknown as VideoFrame;

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame,
            mediaTimeMicroseconds: secondsToMicroseconds(2),
            outputMode: 'video-frame'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
        const canvas = surfaceHarness.surface.container.querySelector('canvas');

        layoutHeight = 225;
        layoutWidth = 400;
        surfaceAncestor.classList.add('compact-player-layout');
        expect(notifyMutationObservers(surfaceAncestor)).toBe(1);
        expect(refreshHandler).toHaveBeenCalledOnce();
        expect(canvas).toMatchObject({ height: 225, width: 400 });

        layoutHeight = 720;
        layoutWidth = 1_280;
        surfaceAncestor.style.transform = 'none';
        expect(notifyMutationObservers(surfaceAncestor)).toBe(1);
        expect(refreshHandler).toHaveBeenCalledTimes(2);
        expect(canvas).toMatchObject({ height: 720, width: 1_280 });
    });

    it('moves presentation resources and observers when the surface is replaced', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const firstSurfaceHarness = createSurfaceHarness();
        const secondSurfaceHarness = createSurfaceHarness(640, 360);
        const addEventListenerSpy = vi.spyOn(firstSurfaceHarness.surface.container, 'addEventListener');
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());

        presenter.startSession(1);
        presenter.attach(firstSurfaceHarness.surface, 1);
        await vi.waitFor(() => expect(firstSurfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        expect(firstSurfaceHarness.surface.container.querySelector(
            '.webgpuPlayerCanvas'
        )).toBeInstanceOf(HTMLCanvasElement);
        const staleResizeObserver = resizeObserverMocks[0];
        const staleMutationObserver = mutationObserverMocks[0];
        const animationEndRegistration = addEventListenerSpy.mock.calls.find(
            (call: unknown[]) => call[0] === 'animationend'
        );
        const staleMotionHandler = animationEndRegistration?.[1] as EventListener | undefined;
        expect(staleResizeObserver).toBeDefined();
        expect(staleMutationObserver).toBeDefined();
        expect(staleMotionHandler).toBeDefined();

        presenter.attach(secondSurfaceHarness.surface, 1);
        await vi.waitFor(() => expect(secondSurfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());

        expect(firstSurfaceHarness.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
        expect(firstSurfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')).toBeNull();
        expect(secondSurfaceHarness.surface.container.querySelector(
            '.webgpuPlayerCanvas'
        )).toBeInstanceOf(HTMLCanvasElement);
        expect(contextHarness.unconfigure).toHaveBeenCalledOnce();
        expect(contextHarness.configure).toHaveBeenCalledTimes(2);

        firstSurfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());
        expect(gpuHarness.devices[0].queueSubmit).not.toHaveBeenCalled();
        secondSurfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());
        await vi.waitFor(() => expect(secondSurfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2));
        const canvas = secondSurfaceHarness.surface.container.querySelector('canvas');
        expect(gpuHarness.devices[0].queueSubmit).toHaveBeenCalledOnce();
        expect(canvas).toMatchObject({
            height: 360,
            width: 640
        });

        Object.defineProperties(secondSurfaceHarness.surface.container, {
            clientHeight: { configurable: true, value: 180 },
            clientWidth: { configurable: true, value: 320 }
        });
        const secondContainerRectangle = vi.fn(() => createRectangle(0, 0, 320, 180));
        const secondVideoRectangle = vi.fn(() => createRectangle(0, 0, 320, 180));
        secondSurfaceHarness.surface.container.getBoundingClientRect = secondContainerRectangle;
        secondSurfaceHarness.surface.video.getBoundingClientRect = secondVideoRectangle;

        staleResizeObserver?.invokeCallback();
        staleMutationObserver?.invokeCallback();
        const staleMotionEvent = new Event('animationend');
        Object.defineProperty(staleMotionEvent, 'target', {
            configurable: true,
            value: firstSurfaceHarness.surface.container
        });
        staleMotionHandler?.(staleMotionEvent);

        expect(secondContainerRectangle).not.toHaveBeenCalled();
        expect(secondVideoRectangle).not.toHaveBeenCalled();
        expect(gpuHarness.devices[0].queueSubmit).toHaveBeenCalledOnce();
        expect(canvas).toMatchObject({ height: 360, width: 640 });

        notifyResizeObservers(secondSurfaceHarness.surface.container);
        expect(secondContainerRectangle).toHaveBeenCalledOnce();
        expect(secondVideoRectangle).toHaveBeenCalledOnce();
        expect(gpuHarness.devices[0].queueSubmit).toHaveBeenCalledTimes(2);
        expect(canvas).toMatchObject({ height: 180, width: 320 });
    });

    it.each([
        [ 'I420', 8, [ 'r8uint', 'r8uint', 'r8uint' ], [ 0, 1, 2, 3, 4 ] ],
        [ 'I420P10', 10, [ 'r16uint', 'r16uint', 'r16uint' ], [ 0, 1, 2, 3, 4 ] ],
        [ 'I420P12', 12, [ 'r16uint', 'r16uint', 'r16uint' ], [ 0, 1, 2, 3, 4 ] ],
        [ 'I422', 8, [ 'r8uint', 'r8uint', 'r8uint' ], [ 0, 1, 2, 3, 4 ] ],
        [ 'I422P10', 10, [ 'r16uint', 'r16uint', 'r16uint' ], [ 0, 1, 2, 3, 4 ] ],
        [ 'I422P12', 12, [ 'r16uint', 'r16uint', 'r16uint' ], [ 0, 1, 2, 3, 4 ] ],
        [ 'I444', 8, [ 'r8uint', 'r8uint', 'r8uint' ], [ 0, 1, 2, 3, 4 ] ],
        [ 'I444P10', 10, [ 'r16uint', 'r16uint', 'r16uint' ], [ 0, 1, 2, 3, 4 ] ],
        [ 'I444P12', 12, [ 'r16uint', 'r16uint', 'r16uint' ], [ 0, 1, 2, 3, 4 ] ],
        [ 'NV12', 8, [ 'r8uint', 'rg8uint' ], [ 0, 1, 2, 3 ] ]
    ] as const)(
        'uploads and binds %s raw planes without importing an external texture',
        async (format, bitDepth, expectedTextureFormats, expectedBindings) => {
            webSettingsMockState.hdrToneMappingEnabled = true;
            const gpuHarness = createGPUHarness();
            const contextHarness = createCanvasContextHarness();
            const surfaceHarness = createSurfaceHarness();
            installGPU(gpuHarness.gpu);
            installCanvasContext(contextHarness.context);
            const presenter = new WebGPUPresenter(vi.fn());
            const metadata = createPQColorMetadata({ bitDepth });

            presenter.startSession(1);
            presenter.setDecodedFramePushMode(true, 1);
            presenter.attach(surfaceHarness.surface, 1);
            await vi.waitFor(() => expect(
                surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
            ).toBeInstanceOf(HTMLCanvasElement));
            await expect(presenter.configureColorPipeline({
                inputMode: 'raw-yuv',
                metadata,
                rawFrameFormat: format,
                settings: createHDRToSDRRenderSettings()
            }, 1)).resolves.toBe(true);

            const rawFrame = createRawFrame(format, metadata);
            const submitted = presenter.presentDecodedFrame({
                durationMicroseconds: rawFrame.durationMicroseconds ?? secondsToMicroseconds(0),
                frame: rawFrame,
                mediaTimeMicroseconds: rawFrame.timestampMicroseconds,
                outputMode: 'raw-planes'
            }, 1);

            expect(submitted).toBe(true);
            const deviceHarness = gpuHarness.devices[0];
            expect(deviceHarness.importExternalTexture).not.toHaveBeenCalled();
            expect(deviceHarness.createTexture.mock.calls.map(call => (
                call[0] as GPUTextureDescriptor
            ).format)).toEqual(expectedTextureFormats);
            expect(deviceHarness.queueWriteTexture).toHaveBeenCalledTimes(rawFrame.planes.length);
            for (let planeIndex = 0; planeIndex < rawFrame.planes.length; planeIndex += 1) {
                const plane = rawFrame.planes[planeIndex];
                const upload = deviceHarness.queueWriteTexture.mock.calls[planeIndex];
                expect(upload[1]).toBe(rawFrame.data);
                expect(upload[2]).toEqual({
                    bytesPerRow: plane.bytesPerRow,
                    offset: plane.byteOffset,
                    rowsPerImage: plane.height
                });
                expect(upload[3]).toEqual({
                    depthOrArrayLayers: 1,
                    height: plane.height,
                    width: plane.width
                });
            }
            const bindGroupDescriptor = deviceHarness.createBindGroup.mock.calls.at(-1)?.[0] as {
                entries: GPUBindGroupEntry[]
            };
            expect(bindGroupDescriptor.entries.map(entry => entry.binding)).toEqual(expectedBindings);
            await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
        }
    );

    it('applies per-frame HDR10+ metadata and clears it on fallback and seek', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(true);
        const deviceHarness = gpuHarness.devices[0];
        deviceHarness.queueWriteBuffer.mockClear();

        const validMetadata = parseHEVCHDR10PlusMetadata(
            createHDR10PlusHEVCVector('valid'),
            { kind: 'annex-b' }
        );
        const validFrame = createRawFrame('I420P10', metadata);
        expect(presenter.presentDecodedFrame({
            HDR10PlusMetadata: validMetadata,
            durationMicroseconds: validFrame.durationMicroseconds ?? secondsToMicroseconds(0),
            frame: validFrame,
            mediaTimeMicroseconds: validFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        const getLastRenderSettingsWrite = (): Uint8Array<ArrayBuffer> => {
            const renderSettingsWrites = deviceHarness.queueWriteBuffer.mock.calls
                .map((call: unknown[]): unknown => call[2])
                .filter((value: unknown): value is Uint8Array<ArrayBuffer> => (
                    value instanceof Uint8Array
                    && value.byteLength === RENDER_SETTINGS_UNIFORM_BYTE_LENGTH
                ));
            const renderSettingsWrite = renderSettingsWrites.at(-1);
            expect(renderSettingsWrite).toBeDefined();
            return renderSettingsWrite as Uint8Array<ArrayBuffer>;
        };
        let renderSettingsWrite = getLastRenderSettingsWrite();
        expect(new Uint32Array(renderSettingsWrite.buffer)[3]).toBe(2);
        expect(new Float32Array(renderSettingsWrite.buffer)[6]).toBeCloseTo(834.75);
        expect(new Float32Array(renderSettingsWrite.buffer)[12]).toBeCloseTo(166.95);
        expect(new Uint32Array(renderSettingsWrite.buffer)[16]).toBe(2);
        expect(presenter.getTelemetry()).toMatchObject({
            appliedHDR10PlusFrameCount: 1,
            lastHDR10PlusMetadataStatus: 'valid',
            staticFallbackHDR10PlusFrameCount: 0
        });
        expect(presenter.getTelemetry().lastHDR10PlusInputPeakNits).toBeCloseTo(834.75);

        const malformedFrame = createRawFrame('I420P10', metadata);
        expect(presenter.presentDecodedFrame({
            HDR10PlusMetadata: parseHEVCHDR10PlusMetadata(
                createHDR10PlusHEVCVector('malformed'),
                { kind: 'annex-b' }
            ),
            durationMicroseconds: malformedFrame.durationMicroseconds ?? secondsToMicroseconds(0),
            frame: malformedFrame,
            mediaTimeMicroseconds: malformedFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(2));

        renderSettingsWrite = getLastRenderSettingsWrite();
        expect(new Uint32Array(renderSettingsWrite.buffer)[3]).toBe(0);
        expect(new Float32Array(renderSettingsWrite.buffer)[6]).toBe(1_000);
        expect(presenter.getTelemetry()).toMatchObject({
            appliedHDR10PlusFrameCount: 1,
            lastHDR10PlusInputPeakNits: null,
            lastHDR10PlusMetadataStatus: 'malformed',
            staticFallbackHDR10PlusFrameCount: 1
        });

        presenter.seek(2);
        renderSettingsWrite = getLastRenderSettingsWrite();
        expect(new Uint32Array(renderSettingsWrite.buffer)[3]).toBe(0);
    });

    it('keeps a manual input peak authoritative over per-frame HDR10+ metadata', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());
        const metadata = createPQColorMetadata();
        const manualSettings = createHDRToSDRRenderSettings({
            toneMapping: { inputPeakNits: 4_000 }
        });

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            automaticInputPeakNits: false,
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: manualSettings
        }, 1)).resolves.toBe(true);
        const deviceHarness = gpuHarness.devices[0];
        deviceHarness.queueWriteBuffer.mockClear();

        const frame = createRawFrame('I420P10', metadata);
        expect(presenter.presentDecodedFrame({
            HDR10PlusMetadata: parseHEVCHDR10PlusMetadata(
                createHDR10PlusHEVCVector('valid'),
                { kind: 'annex-b' }
            ),
            durationMicroseconds: frame.durationMicroseconds ?? secondsToMicroseconds(0),
            frame,
            mediaTimeMicroseconds: frame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        const renderSettingsWrites = deviceHarness.queueWriteBuffer.mock.calls
            .map((call: unknown[]): unknown => call[2])
            .filter((value: unknown): value is Uint8Array<ArrayBuffer> => (
                value instanceof Uint8Array
                && value.byteLength === RENDER_SETTINGS_UNIFORM_BYTE_LENGTH
            ));
        const renderSettingsWrite = renderSettingsWrites.at(-1);
        expect(renderSettingsWrite).toBeDefined();
        const uniformData = renderSettingsWrite as Uint8Array<ArrayBuffer>;
        expect(new Uint32Array(uniformData.buffer)[3]).toBe(2);
        expect(new Float32Array(uniformData.buffer)[6]).toBe(4_000);
        expect(new Uint32Array(uniformData.buffer)[16]).toBe(2);
        expect(presenter.getRenderSettings()).toEqual(manualSettings);
        expect(presenter.getTelemetry()).toMatchObject({
            appliedHDR10PlusFrameCount: 1,
            lastHDR10PlusInputPeakNits: 4_000,
            lastHDR10PlusMetadataStatus: 'valid',
            staticFallbackHDR10PlusFrameCount: 0
        });
    });

    it('applies carried and profile A HDR10+ metadata and counts the carried frames', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(true);
        const deviceHarness = gpuHarness.devices[0];
        const validMetadata = parseHEVCHDR10PlusMetadata(createHDR10PlusHEVCVector('valid'), { kind: 'annex-b' }).metadata;
        const profileAMetadata = parseHEVCHDR10PlusMetadata(createHDR10PlusHEVCVector('profile-a'), { kind: 'annex-b' });
        let presentedFrameCount = 0;
        const presentFrame = async (frameMetadata: HDR10PlusFrameMetadata): Promise<{
            floatValues: Float32Array
            integerValues: Uint32Array
        }> => {
            deviceHarness.queueWriteBuffer.mockClear();
            const frame = createRawFrame('I420P10', metadata);
            expect(presenter.presentDecodedFrame({
                HDR10PlusMetadata: frameMetadata,
                durationMicroseconds: frame.durationMicroseconds ?? secondsToMicroseconds(0),
                frame,
                mediaTimeMicroseconds: frame.timestampMicroseconds,
                outputMode: 'raw-planes'
            }, 1)).toBe(true);
            presentedFrameCount += 1;
            await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(presentedFrameCount));
            const renderSettingsWrite = deviceHarness.queueWriteBuffer.mock.calls
                .map((call: unknown[]): unknown => call[2])
                .filter((value: unknown): value is Uint8Array<ArrayBuffer> => (
                    value instanceof Uint8Array
                    && value.byteLength === RENDER_SETTINGS_UNIFORM_BYTE_LENGTH
                ))
                .at(-1);
            expect(renderSettingsWrite).toBeDefined();
            const uniformBuffer = (renderSettingsWrite as Uint8Array<ArrayBuffer>).buffer;
            return { floatValues: new Float32Array(uniformBuffer), integerValues: new Uint32Array(uniformBuffer) };
        };

        // A frame without metadata of its own renders with the metadata its run carried to it
        let uniform = await presentFrame({ metadata: validMetadata, status: 'absent' });
        expect(uniform.integerValues[UNIFORM_DYNAMIC_MODE_INDEX]).toBe(CURVE_DYNAMIC_MODE);
        expect(uniform.floatValues[UNIFORM_DYNAMIC_TARGET_PEAK_INDEX]).toBe(HDR10_PLUS_VECTOR_CURVE_TARGET_NITS);
        expect(presenter.getTelemetry()).toMatchObject({
            appliedHDR10PlusFrameCount: 1,
            carriedHDR10PlusFrameCount: 1,
            lastHDR10PlusMetadataStatus: 'absent',
            staticFallbackHDR10PlusFrameCount: 0
        });

        // Profile A has no curve, so its targeted display of 0 is never read
        uniform = await presentFrame(profileAMetadata);
        expect(uniform.integerValues[UNIFORM_DYNAMIC_MODE_INDEX]).toBe(SCENE_STATISTICS_DYNAMIC_MODE);
        expect(uniform.floatValues[UNIFORM_INPUT_PEAK_INDEX]).toBeCloseTo(HDR10_PLUS_VECTOR_SCENE_PEAK_NITS);
        expect(uniform.floatValues[UNIFORM_DYNAMIC_TARGET_PEAK_INDEX]).toBe(0);
        expect(presenter.getTelemetry()).toMatchObject({
            appliedHDR10PlusFrameCount: 2,
            carriedHDR10PlusFrameCount: 1,
            lastHDR10PlusMetadataStatus: 'valid'
        });

        uniform = await presentFrame({ metadata: profileAMetadata.metadata, status: 'malformed' });
        expect(uniform.integerValues[UNIFORM_DYNAMIC_MODE_INDEX]).toBe(SCENE_STATISTICS_DYNAMIC_MODE);
        expect(presenter.getTelemetry()).toMatchObject({
            appliedHDR10PlusFrameCount: 3,
            carriedHDR10PlusFrameCount: 2,
            lastHDR10PlusMetadataStatus: 'malformed'
        });

        uniform = await presentFrame({ metadata: null, status: 'unsupported' });
        expect(uniform.integerValues[UNIFORM_DYNAMIC_MODE_INDEX]).toBe(STATIC_DYNAMIC_MODE);
        expect(presenter.getTelemetry()).toMatchObject({
            appliedHDR10PlusFrameCount: 3,
            carriedHDR10PlusFrameCount: 2,
            lastHDR10PlusInputPeakNits: null,
            lastHDR10PlusMetadataStatus: 'unsupported',
            staticFallbackHDR10PlusFrameCount: 1
        });
    });

    it('composes the visible rectangle, reuses matching plane textures, and releases them', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1);
        const deviceHarness = gpuHarness.devices[0];
        deviceHarness.queueWriteBuffer.mockClear();

        const firstFrame = createRawFrame('I420P10', metadata, 8, 4, { height: 4, width: 4, x: 2, y: 0 });
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: firstFrame.durationMicroseconds ?? secondsToMicroseconds(0),
            frame: firstFrame,
            mediaTimeMicroseconds: firstFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);

        expect(deviceHarness.queueWriteBuffer).toHaveBeenCalledOnce();
        const presentationUniforms = deviceHarness.queueWriteBuffer.mock.calls[0][2] as Float32Array<ArrayBuffer>;
        expect(Array.from(presentationUniforms)).toEqual([ 0.5, 1, 0.25, 0 ]);
        expect(deviceHarness.createTexture).toHaveBeenCalledTimes(3);

        const recycleChannel = new MessageChannel();
        recycleChannel.port1.postMessage(firstFrame.data, [ firstFrame.data ]);
        recycleChannel.port1.close();
        recycleChannel.port2.close();
        expect(firstFrame.data.byteLength).toBe(0);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        const secondFrame = createRawFrame('I420P10', metadata);
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: secondFrame.durationMicroseconds ?? secondsToMicroseconds(0),
            frame: secondFrame,
            mediaTimeMicroseconds: secondFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        expect(deviceHarness.createTexture).toHaveBeenCalledTimes(3);
        expect(deviceHarness.queueWriteTexture).toHaveBeenCalledTimes(6);

        const resizedFrame = createRawFrame('I420P10', metadata, 10, 6);
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: resizedFrame.durationMicroseconds ?? secondsToMicroseconds(0),
            frame: resizedFrame,
            mediaTimeMicroseconds: resizedFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        expect(deviceHarness.createTexture).toHaveBeenCalledTimes(6);
        expect(deviceHarness.textureDestroy).toHaveBeenCalledTimes(3);

        presenter.endSession(2);
        expect(deviceHarness.textureDestroy).toHaveBeenCalledTimes(6);
    });

    it('uploads, binds, and releases exactly one per-frame Dolby Vision RPU', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-dolby-vision',
            profile: 8,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings({
                toneMapping: { inputPeakNits: 4_000 }
            })
        }, 1)).resolves.toBe(true);

        const deviceHarness = gpuHarness.devices[0];
        const RPUBufferCallIndex = deviceHarness.createBuffer.mock.calls.findIndex(
            (call: unknown[]) => (
                (call[0] as GPUBufferDescriptor).label === 'WebGPU Dolby Vision per-frame RPU'
            )
        );
        expect(RPUBufferCallIndex).toBeGreaterThanOrEqual(0);
        const RPUBufferDescriptor = deviceHarness.createBuffer.mock.calls[
            RPUBufferCallIndex
        ][0] as GPUBufferDescriptor;
        expect(RPUBufferDescriptor).toMatchObject({
            size: DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
        });
        const RPUBuffer = deviceHarness.createBuffer.mock.results[RPUBufferCallIndex].value as {
            destroy: MockFunction
            label: string
        };
        deviceHarness.queueWriteBuffer.mockClear();

        const packedRPUData = createDolbyVisionAuthorizationRPUVector();
        const rawFrame = createRawFrame('I420P10', createPQColorMetadata());
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: rawFrame.durationMicroseconds ?? secondsToMicroseconds(0),
            encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(packedRPUData),
            frame: rawFrame,
            mediaTimeMicroseconds: rawFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);

        const RPUWrite = deviceHarness.queueWriteBuffer.mock.calls.find((call: unknown[]) => call[0] === RPUBuffer);
        expect(RPUWrite).toBeDefined();
        expect(RPUWrite?.[1]).toBe(0);
        expect(RPUWrite?.[2]).toBe(packedRPUData);
        const bindGroupDescriptor = deviceHarness.createBindGroup.mock.calls.at(-1)?.[0] as {
            entries: GPUBindGroupEntry[]
        };
        expect(bindGroupDescriptor.entries.map(entry => entry.binding)).toEqual([ 0, 1, 2, 3, 4, 5 ]);
        expect(fallbackHandler).not.toHaveBeenCalled();

        presenter.endSession(2);
        expect(RPUBuffer.destroy).toHaveBeenCalledOnce();
    });

    it('presents Profile 7 MEL and explicit FEL HDR10-base fallback frames', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-dolby-vision',
            profile: 7,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(true);

        const deviceHarness = gpuHarness.devices[0];
        const profile7Shader = deviceHarness.createShaderModule.mock.calls
            .map((call: unknown[]) => call[0] as { code: string })
            .find(descriptor => descriptor.code.includes('if (isDolbyVisionFEL())'));
        expect(profile7Shader?.code).toContain('if (isDolbyVisionFEL())');

        const melRPUData = createDolbyVisionAuthorizationRPUVector(7, 'mel');
        const melFrame = createRawFrame('I420P10', createPQColorMetadata());
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: melFrame.durationMicroseconds ?? secondsToMicroseconds(0),
            encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(melRPUData, 'discarded-mel', true),
            frame: melFrame,
            mediaTimeMicroseconds: melFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        const felRPUData = createDolbyVisionAuthorizationRPUVector(7, 'fel');
        const felFrame = createRawFrame('I420P10', createPQColorMetadata());
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: felFrame.durationMicroseconds ?? secondsToMicroseconds(0),
            encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(felRPUData, 'discarded-fel', true),
            frame: felFrame,
            mediaTimeMicroseconds: felFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(2));
        expect(presenter.getTelemetry()).toMatchObject({
            dolbyVisionDualLayerFELBaseFallbackPresentedFrameCount: 1,
            dolbyVisionDualLayerMELPresentedFrameCount: 1
        });

        const RPUBuffers = deviceHarness.queueWriteBuffer.mock.calls
            .map((call: unknown[]) => call[2]);
        expect(RPUBuffers).toContain(melRPUData);
        expect(RPUBuffers).toContain(felRPUData);
        expect(fallbackHandler).not.toHaveBeenCalled();
    });

    it('presents an atomically owned Profile 7 FEL enhancement frame', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-dolby-vision',
            profile: 7,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(true);

        const deviceHarness = gpuHarness.devices[0];
        const fullFELShader = deviceHarness.createShaderModule.mock.calls
            .map((call: unknown[]) => call[0] as { code: string })
            .find(descriptor => descriptor.code.includes('@group(0) @binding(9) var<uniform> enhancement'));
        expect(fullFELShader?.code).toContain(
            'reconstructDolbyVisionBT2020PQWithEnhancement'
        );

        const { baseFrame, enhancementFrame } = createCompoundDolbyVisionRawFrames();
        const packedRPUData = createDolbyVisionAuthorizationRPUVector(7, 'fel');
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: baseFrame.durationMicroseconds ?? secondsToMicroseconds(0),
            encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(packedRPUData, 'decoded-fel', true),
            enhancementFrame,
            frame: baseFrame,
            mediaTimeMicroseconds: baseFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        expect(deviceHarness.createTexture).toHaveBeenCalledTimes(6);
        expect(deviceHarness.queueWriteTexture).toHaveBeenCalledTimes(6);
        const bindGroupDescriptor = deviceHarness.createBindGroup.mock.calls.at(-1)?.[0] as {
            entries: GPUBindGroupEntry[]
        };
        expect(bindGroupDescriptor.entries.map(entry => entry.binding)).toEqual([ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9 ]);
        expect(presenter.getTelemetry()).toMatchObject({
            dolbyVisionDualLayerFELBaseFallbackPresentedFrameCount: 0,
            dolbyVisionDualLayerFELPresentedFrameCount: 1,
            dolbyVisionDualLayerMELPresentedFrameCount: 0
        });
        expect(fallbackHandler).not.toHaveBeenCalled();
    });

    it('presents the base of a Profile 7 FEL frame whose RPU names another EL bit depth', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-dolby-vision',
            profile: 7,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(true);

        const { baseFrame, enhancementFrame } = createCompoundDolbyVisionRawFrames();
        const packedRPUData = createDolbyVisionAuthorizationRPUVector(7, 'fel');
        // The decoded EL holds 10-bit codes, which a 12-bit residual scale would misread
        new DataView(packedRPUData).setUint32(
            DOLBY_VISION_RPU_ENHANCEMENT_LAYER_BIT_DEPTH_WORD_OFFSET * Uint32Array.BYTES_PER_ELEMENT,
            MISMATCHED_ENHANCEMENT_LAYER_BIT_DEPTH,
            true
        );
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: baseFrame.durationMicroseconds ?? secondsToMicroseconds(0),
            encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(packedRPUData, 'decoded-fel', true),
            enhancementFrame,
            frame: baseFrame,
            mediaTimeMicroseconds: baseFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        // Only the base layer's three planes upload
        const deviceHarness = gpuHarness.devices[0];
        expect(deviceHarness.queueWriteTexture).toHaveBeenCalledTimes(3);
        expect(presenter.getTelemetry()).toMatchObject({
            dolbyVisionDualLayerFELBaseFallbackPresentedFrameCount: 1,
            dolbyVisionDualLayerFELPresentedFrameCount: 0
        });
        expect(fallbackHandler).not.toHaveBeenCalled();
    });

    type RawDolbyVisionPresenterHarness = {
        configured: boolean
        deviceHarness: ReturnType<typeof createGPUHarness>['devices'][number]
        fallbackHandler: MockFunction
        presenter: WebGPUPresenter
    };

    /** Attaches a decoded-frame presenter and configures one raw Dolby Vision pipeline. */
    async function createRawDolbyVisionPresenter(
        profile: 4 | 5 | 7 | 8,
        rawFrameFormat: RawDolbyVisionVideoFrameFormat = 'I420P10'
    ): Promise<RawDolbyVisionPresenterHarness> {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        const configured = await presenter.configureColorPipeline({
            inputMode: 'raw-dolby-vision',
            profile,
            rawFrameFormat,
            settings: createHDRToSDRRenderSettings()
        }, 1);
        return { configured, deviceHarness: gpuHarness.devices[0], fallbackHandler, presenter };
    }

    it('presents Profile 7 frames whose EL is absent from the stream', async () => {
        const { configured, fallbackHandler, presenter } = await createRawDolbyVisionPresenter(7);
        expect(configured).toBe(true);

        const layerModes = [ 'mel', 'fel' ] as const;
        for (let frameIndex = 0; frameIndex < layerModes.length; frameIndex += 1) {
            const frame = createRawFrame('I420P10', createPQColorMetadata());
            expect(presenter.presentDecodedFrame({
                durationMicroseconds: frame.durationMicroseconds ?? secondsToMicroseconds(0),
                encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(
                    createDolbyVisionAuthorizationRPUVector(7, layerModes[frameIndex]),
                    'absent',
                    false
                ),
                frame,
                mediaTimeMicroseconds: frame.timestampMicroseconds,
                outputMode: 'raw-planes'
            }, 1)).toBe(true);
            await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(frameIndex + 1));
        }
        // MEL reconstructs exactly from the BL, and FEL presents its HDR10-compatible base
        expect(presenter.getTelemetry()).toMatchObject({
            dolbyVisionDualLayerFELBaseFallbackPresentedFrameCount: 1,
            dolbyVisionDualLayerMELPresentedFrameCount: 1
        });
        expect(fallbackHandler).not.toHaveBeenCalled();
    });

    it('presents Profile 4 MEL and its explicit FEL SDR-base fallback', async () => {
        const {
            configured,
            deviceHarness,
            fallbackHandler,
            presenter
        } = await createRawDolbyVisionPresenter(4);
        expect(configured).toBe(true);
        const profile4Shader = deviceHarness.createShaderModule.mock.calls
            .map((call: unknown[]) => call[0] as { code: string })
            .find(descriptor => descriptor.code.includes('fn presentSDRBaseLayer'));
        expect(profile4Shader?.code).toContain('return presentSDRBaseLayer(rawBaseSignal);');

        const layerModes = [ 'mel', 'fel' ] as const;
        for (let frameIndex = 0; frameIndex < layerModes.length; frameIndex += 1) {
            const layerMode = layerModes[frameIndex];
            const frame = createRawFrame('I420P10', createPQColorMetadata());
            expect(presenter.presentDecodedFrame({
                durationMicroseconds: frame.durationMicroseconds ?? secondsToMicroseconds(0),
                encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(
                    createDolbyVisionAuthorizationRPUVector(4, layerMode),
                    layerMode === 'fel' ? 'discarded-fel' : 'discarded-mel',
                    true
                ),
                frame,
                mediaTimeMicroseconds: frame.timestampMicroseconds,
                outputMode: 'raw-planes'
            }, 1)).toBe(true);
            await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(frameIndex + 1));
        }
        expect(presenter.getTelemetry()).toMatchObject({
            dolbyVisionDualLayerFELBaseFallbackPresentedFrameCount: 1,
            dolbyVisionDualLayerMELPresentedFrameCount: 1
        });
        expect(fallbackHandler).not.toHaveBeenCalled();
    });

    it.each([ 5, 8 ] as const)(
        'presents a single-layer RPU in a Profile %i session whatever its own single-layer profile',
        async profile => {
            const { configured, fallbackHandler, presenter } = await createRawDolbyVisionPresenter(profile);
            expect(configured).toBe(true);

            const RPUProfiles = [ 5, 8 ] as const;
            for (let frameIndex = 0; frameIndex < RPUProfiles.length; frameIndex += 1) {
                const frame = createRawFrame('I420P10', createPQColorMetadata());
                expect(presenter.presentDecodedFrame({
                    durationMicroseconds: frame.durationMicroseconds ?? secondsToMicroseconds(0),
                    encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(
                        createDolbyVisionAuthorizationRPUVector(RPUProfiles[frameIndex])
                    ),
                    frame,
                    mediaTimeMicroseconds: frame.timestampMicroseconds,
                    outputMode: 'raw-planes'
                }, 1)).toBe(true);
                await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(frameIndex + 1));
            }
            expect(fallbackHandler).not.toHaveBeenCalled();
        }
    );

    it('reconstructs a single-layer RPU over 12-bit range-extension planes', async () => {
        const { configured, fallbackHandler, presenter } = await createRawDolbyVisionPresenter(8, 'I420P12');
        expect(configured).toBe(true);

        const frame = createRawFrame('I420P12', createPQColorMetadata({ bitDepth: 12 }));
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: frame.durationMicroseconds ?? secondsToMicroseconds(0),
            encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(
                createDolbyVisionAuthorizationRPUVector(8, 'single-layer', 12)
            ),
            frame,
            mediaTimeMicroseconds: frame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        expect(fallbackHandler).not.toHaveBeenCalled();
    });

    it('rejects an RPU whose base-layer depth differs from the decoded planes', async () => {
        const { configured, fallbackHandler, presenter } = await createRawDolbyVisionPresenter(8, 'I420P12');
        expect(configured).toBe(true);

        const frame = createRawFrame('I420P12', createPQColorMetadata({ bitDepth: 12 }));
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: frame.durationMicroseconds ?? secondsToMicroseconds(0),
            encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(
                createDolbyVisionAuthorizationRPUVector(8, 'single-layer', 10)
            ),
            frame,
            mediaTimeMicroseconds: frame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(false);
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'dolby-vision-metadata-invalid');
    });

    /** Pushes one raw Dolby Vision frame with its RPU, and its paired EL when one is given. */
    function presentRawDolbyVisionFrame(
        presenter: WebGPUPresenter,
        frame: TransferableRawVideoFrame,
        encodedDolbyVisionMetadata: TransferableDolbyVisionEncodedFrameMetadata,
        enhancementFrame?: TransferableRawVideoFrame
    ): boolean {
        return presenter.presentDecodedFrame({
            durationMicroseconds: frame.durationMicroseconds ?? secondsToMicroseconds(0),
            encodedDolbyVisionMetadata,
            enhancementFrame,
            frame,
            mediaTimeMicroseconds: frame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1);
    }

    function getCreatedPlaneTextureFormats(deviceHarness: RawDolbyVisionPresenterHarness['deviceHarness']): string[] {
        return deviceHarness.createTexture.mock.calls.map(
            (call: unknown[]) => String((call[0] as GPUTextureDescriptor).format)
        );
    }

    const DEFAULT_PREWARMED_DOLBY_VISION_ROUTE_NAMES = [
        'I420P10:single-layer',
        'I420P10:profile7-base',
        'I420P10:profile7-fel'
    ];

    it('answers dual-layer authorization queries from each BL format\'s own keys', () => {
        dolbyVisionAuthorizationMockState.rejectedRouteNames = new Set([
            'I422P10:profile7-base',
            'I444P12:profile4-fel'
        ]);
        const presenter = new WebGPUPresenter(vi.fn());

        expect(presenter.isRawDolbyVisionProfile7PresentationAuthorized()).toBe(true);
        expect(presenter.isRawDolbyVisionProfile7PresentationAuthorized('I422P10')).toBe(false);
        expect(presenter.isRawDolbyVisionProfile4PresentationAuthorized('I420')).toBe(true);
        // The base key gates the route; a missing FEL key only withholds the residual
        expect(presenter.isRawDolbyVisionProfile4PresentationAuthorized('I444P12')).toBe(true);
        expect(presenter.getDolbyVisionAuthorizationTelemetry('profile7-base').status).toBe('authorized');
        expect(presenter.getDolbyVisionAuthorizationTelemetry('profile7-base', 'I422P10').status).toBe('rejected');
        expect(presenter.getDolbyVisionAuthorizationTelemetry('profile7-fel', 'I422P10').status).toBe('authorized');
        expect(presenter.getDolbyVisionAuthorizationTelemetry('profile4-base', 'I444P12').status).toBe('authorized');
        expect(presenter.getDolbyVisionAuthorizationTelemetry('profile4-fel', 'I444P12').status).toBe('rejected');
    });

    it.each([
        [ 7, 'I422P10', [ 'I422P10:profile7-base', 'I422P10:profile7-fel' ] ],
        [ 4, 'I444P12', [ 'I444P12:profile4-base', 'I444P12:profile4-fel' ] ],
        [ 4, 'I420', [ 'I420:profile4-base', 'I420:profile4-fel' ] ]
    ] as const)(
        'prewarms and waits for a Profile %i target in %s only on request',
        async (profile, rawFrameFormat, targetRouteNames) => {
            webSettingsMockState.hdrToneMappingEnabled = true;
            installGPU(createGPUHarness().gpu);
            const presenter = new WebGPUPresenter(vi.fn());

            await presenter.prewarmDolbyVisionPresentationAuthorization();
            expect(new Set(dolbyVisionAuthorizationMockState.prewarmRouteNames))
                .toEqual(new Set(DEFAULT_PREWARMED_DOLBY_VISION_ROUTE_NAMES));

            await presenter.prewarmDolbyVisionPresentationAuthorization({ profile, rawFrameFormat });
            expect(new Set(dolbyVisionAuthorizationMockState.prewarmRouteNames)).toEqual(new Set([
                ...DEFAULT_PREWARMED_DOLBY_VISION_ROUTE_NAMES,
                ...targetRouteNames
            ]));

            await presenter.waitForDolbyVisionAuthorizationPrewarm({ profile, rawFrameFormat });
            expect(new Set(dolbyVisionAuthorizationMockState.waitRouteNames)).toEqual(new Set([
                ...DEFAULT_PREWARMED_DOLBY_VISION_ROUTE_NAMES,
                ...targetRouteNames
            ]));
        }
    );

    it.each([
        [ 4, 'I420', 'r8uint', `(rawYUV.x - ${(16).toFixed(9)}) / ${(219).toFixed(9)}` ],
        [ 7, 'I420', 'r8uint', `(rawYUV.x - ${(16).toFixed(9)}) / ${(219).toFixed(9)}` ],
        [ 4, 'I422P10', 'r16uint', `(rawYUV.x - ${(64).toFixed(9)}) / ${(876).toFixed(9)}` ],
        [ 7, 'I420P12', 'r16uint', `(rawYUV.x - ${(256).toFixed(9)}) / ${(3_504).toFixed(9)}` ],
        [ 7, 'I444P12', 'r16uint', `(rawYUV.x - ${(256).toFixed(9)}) / ${(3_504).toFixed(9)}` ]
    ] as const)(
        'presents Profile %i MEL, FEL, and FEL base-fallback frames over %s BL planes',
        async (profile, rawFrameFormat, baseTextureFormat, baseNormalization) => {
            const {
                configured,
                deviceHarness,
                fallbackHandler,
                presenter
            } = await createRawDolbyVisionPresenter(profile, rawFrameFormat);
            expect(configured).toBe(true);
            const felShader = deviceHarness.createShaderModule.mock.calls
                .map((call: unknown[]) => call[0] as { code: string })
                .find(descriptor => descriptor.code.includes('@binding(9) var<uniform> enhancement'));
            expect(felShader?.code).toContain(baseNormalization);

            const bitDepth = getRawFormatBitDepth(rawFrameFormat);
            const melFrame = createRawFrame(rawFrameFormat, createPQColorMetadata({ bitDepth }));
            expect(presentRawDolbyVisionFrame(presenter, melFrame, createDolbyVisionEncodedMetadata(
                createDolbyVisionAuthorizationRPUVector(profile, 'mel', bitDepth),
                'discarded-mel',
                true
            ))).toBe(true);
            await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

            const { baseFrame, enhancementFrame } = createCompoundDolbyVisionRawFrames(rawFrameFormat);
            expect(presentRawDolbyVisionFrame(presenter, baseFrame, createDolbyVisionEncodedMetadata(
                createDolbyVisionAuthorizationRPUVector(profile, 'fel', bitDepth),
                'decoded-fel',
                true
            ), enhancementFrame)).toBe(true);
            await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(2));

            const baseOnlyFrame = createRawFrame(rawFrameFormat, createPQColorMetadata({ bitDepth }));
            expect(presentRawDolbyVisionFrame(presenter, baseOnlyFrame, createDolbyVisionEncodedMetadata(
                createDolbyVisionAuthorizationRPUVector(profile, 'fel', bitDepth),
                'discarded-fel',
                true
            ))).toBe(true);
            await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(3));

            expect(presenter.getTelemetry()).toMatchObject({
                dolbyVisionDualLayerFELBaseFallbackPresentedFrameCount: 1,
                dolbyVisionDualLayerFELPresentedFrameCount: 1,
                dolbyVisionDualLayerMELPresentedFrameCount: 1
            });
            // The BL textures follow the BL format, and the EL always uploads as 10-bit planes
            expect(getCreatedPlaneTextureFormats(deviceHarness)).toEqual([
                baseTextureFormat,
                baseTextureFormat,
                baseTextureFormat,
                'r16uint',
                'r16uint',
                'r16uint'
            ]);
            expect(fallbackHandler).not.toHaveBeenCalled();
        }
    );

    it('fails closed when the BL format\'s own dual-layer base key is not authorized', async () => {
        dolbyVisionAuthorizationMockState.rejectedRouteNames = new Set([ 'I422P12:profile7-base' ]);

        const { configured, fallbackHandler } = await createRawDolbyVisionPresenter(7, 'I422P12');

        expect(configured).toBe(false);
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'hdr-authorization-unavailable');
    });

    it('presents an FEL frame as its base when the BL format\'s FEL key is not authorized', async () => {
        dolbyVisionAuthorizationMockState.rejectedRouteNames = new Set([ 'I444P10:profile7-fel' ]);
        const {
            configured,
            deviceHarness,
            fallbackHandler,
            presenter
        } = await createRawDolbyVisionPresenter(7, 'I444P10');
        expect(configured).toBe(true);
        expect(deviceHarness.createShaderModule.mock.calls.some(
            (call: unknown[]) => (call[0] as { code: string }).code.includes('var<uniform> enhancement')
        )).toBe(false);

        const { baseFrame, enhancementFrame } = createCompoundDolbyVisionRawFrames('I444P10');
        expect(presentRawDolbyVisionFrame(presenter, baseFrame, createDolbyVisionEncodedMetadata(
            createDolbyVisionAuthorizationRPUVector(7, 'fel', 10),
            'decoded-fel',
            true
        ), enhancementFrame)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        expect(presenter.getTelemetry()).toMatchObject({
            dolbyVisionDualLayerFELBaseFallbackPresentedFrameCount: 1,
            dolbyVisionDualLayerFELPresentedFrameCount: 0
        });
        expect(getCreatedPlaneTextureFormats(deviceHarness)).toEqual([ 'r16uint', 'r16uint', 'r16uint' ]);
        expect(fallbackHandler).not.toHaveBeenCalled();
    });

    it.each([
        [ 8, true ],
        [ 10, false ]
    ] as const)(
        'reconstructs single-layer 8-bit I420 planes from an RPU declaring a %i-bit BL: %s',
        async (baseLayerBitDepth, accepted) => {
            const {
                configured,
                deviceHarness,
                fallbackHandler,
                presenter
            } = await createRawDolbyVisionPresenter(8, 'I420');
            expect(configured).toBe(true);

            const frame = createRawFrame('I420', createPQColorMetadata({ bitDepth: 8 }));
            expect(presentRawDolbyVisionFrame(presenter, frame, createDolbyVisionEncodedMetadata(
                createDolbyVisionAuthorizationRPUVector(8, 'single-layer', baseLayerBitDepth)
            ))).toBe(accepted);
            if (!accepted) {
                expect(fallbackHandler).toHaveBeenCalledWith(1, 'dolby-vision-metadata-invalid');
                return;
            }
            await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
            expect(getCreatedPlaneTextureFormats(deviceHarness)).toEqual([ 'r8uint', 'r8uint', 'r8uint' ]);
            expect(fallbackHandler).not.toHaveBeenCalled();
        }
    );

    it('rejects a dual-layer RPU whose BL depth differs from the BL format', async () => {
        const { configured, fallbackHandler, presenter } = await createRawDolbyVisionPresenter(4, 'I422P12');
        expect(configured).toBe(true);

        const frame = createRawFrame('I422P12', createPQColorMetadata({ bitDepth: 12 }));
        expect(presentRawDolbyVisionFrame(presenter, frame, createDolbyVisionEncodedMetadata(
            createDolbyVisionAuthorizationRPUVector(4, 'mel', 10),
            'discarded-mel',
            true
        ))).toBe(false);
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'dolby-vision-metadata-invalid');
    });

    it.each([
        {
            name: 'missing metadata',
            profile: 8 as const,
            toMetadata: (): TransferableDolbyVisionEncodedFrameMetadata | undefined => undefined
        },
        {
            name: 'multiple RPUs',
            profile: 8 as const,
            toMetadata: (): TransferableDolbyVisionEncodedFrameMetadata => ({
                ...createDolbyVisionEncodedMetadata(),
                parsedRPUData: [
                    createDolbyVisionAuthorizationRPUVector(),
                    createDolbyVisionAuthorizationRPUVector()
                ]
            })
        },
        {
            name: 'discarded enhancement-layer data',
            profile: 8 as const,
            toMetadata: (): TransferableDolbyVisionEncodedFrameMetadata => ({
                ...createDolbyVisionEncodedMetadata(),
                enhancementLayerDisposition: 'discarded-mel',
                hasEnhancementLayerVCL: true
            })
        },
        {
            name: 'an incompatible protocol schema',
            profile: 8 as const,
            toMetadata: (): TransferableDolbyVisionEncodedFrameMetadata => ({
                ...createDolbyVisionEncodedMetadata(),
                schemaVersion: 1
            } as unknown as TransferableDolbyVisionEncodedFrameMetadata)
        },
        {
            name: 'a dual-layer RPU in a single-layer session',
            profile: 5 as const,
            toMetadata: (): TransferableDolbyVisionEncodedFrameMetadata => (
                createDolbyVisionEncodedMetadata(createDolbyVisionAuthorizationRPUVector(7, 'mel'))
            )
        },
        {
            name: 'a Profile 7 RPU in a Profile 4 session',
            profile: 4 as const,
            toMetadata: (): TransferableDolbyVisionEncodedFrameMetadata => (
                createDolbyVisionEncodedMetadata(
                    createDolbyVisionAuthorizationRPUVector(7, 'mel'),
                    'discarded-mel',
                    true
                )
            )
        },
        {
            name: 'a discarded FEL disposition without EL VCL',
            profile: 7 as const,
            toMetadata: (): TransferableDolbyVisionEncodedFrameMetadata => (
                createDolbyVisionEncodedMetadata(
                    createDolbyVisionAuthorizationRPUVector(7, 'fel'),
                    'discarded-fel',
                    false
                )
            )
        },
        {
            name: 'a Profile 7 layer disposition mismatch',
            profile: 7 as const,
            toMetadata: (): TransferableDolbyVisionEncodedFrameMetadata => (
                createDolbyVisionEncodedMetadata(
                    createDolbyVisionAuthorizationRPUVector(7, 'mel'),
                    'discarded-fel',
                    true
                )
            )
        }
    ])('fails closed for $name in a Dolby Vision frame', async ({ profile, toMetadata }) => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-dolby-vision',
            profile,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(true);
        const rawFrame = createRawFrame('I420P10', createPQColorMetadata());

        expect(presenter.presentDecodedFrame({
            durationMicroseconds: rawFrame.durationMicroseconds ?? secondsToMicroseconds(0),
            encodedDolbyVisionMetadata: toMetadata(),
            frame: rawFrame,
            mediaTimeMicroseconds: rawFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(false);
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'dolby-vision-metadata-invalid');
        expect(gpuHarness.devices[0].queueWriteTexture).not.toHaveBeenCalled();
    });

    it('rejects malformed raw frame layouts before creating or uploading textures', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1);
        const rawFrame = createRawFrame('I420P10', metadata);
        const firstPlane = rawFrame.planes[0];
        rawFrame.planes = [{ ...firstPlane, bytesPerRow: 128 }, ...rawFrame.planes.slice(1) ];

        expect(presenter.presentDecodedFrame({
            durationMicroseconds: rawFrame.durationMicroseconds ?? secondsToMicroseconds(0),
            frame: rawFrame,
            mediaTimeMicroseconds: rawFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(false);
        expect(gpuHarness.devices[0].createTexture).not.toHaveBeenCalled();
        expect(gpuHarness.devices[0].queueWriteTexture).not.toHaveBeenCalled();
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'decoded-frame-color-mismatch');
    });

    it('does not inspect or upload a raw frame from a stale generation', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1);
        presenter.seek(2);
        const rawFrame = createRawFrame('I420P10', metadata);

        expect(presenter.presentDecodedFrame({
            durationMicroseconds: rawFrame.durationMicroseconds ?? secondsToMicroseconds(0),
            frame: rawFrame,
            mediaTimeMicroseconds: rawFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(false);
        expect(rawFrame.data.byteLength).toBeGreaterThan(0);
        expect(gpuHarness.devices[0].createTexture).not.toHaveBeenCalled();
        expect(gpuHarness.devices[0].queueWriteTexture).not.toHaveBeenCalled();
        expect(fallbackHandler).not.toHaveBeenCalled();
    });

    it('reauthorizes raw HDR presentation on one replacement device', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness(2);
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1);
        const firstFrame = createRawFrame('I420P10', metadata);
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: firstFrame.durationMicroseconds ?? secondsToMicroseconds(0),
            frame: firstFrame,
            mediaTimeMicroseconds: firstFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        gpuHarness.devices[0].lost.resolve({
            message: 'first raw device loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await vi.waitFor(() => expect(gpuHarness.requestDevice).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(presenter.getTelemetry().deviceRecoveryCount).toBe(1));
        expect(gpuHarness.devices[0].textureDestroy).toHaveBeenCalledTimes(3);
        expect(fallbackHandler).not.toHaveBeenCalled();

        const recoveredFrame = createRawFrame('I420P10', metadata);
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: recoveredFrame.durationMicroseconds ?? secondsToMicroseconds(0),
            frame: recoveredFrame,
            mediaTimeMicroseconds: recoveredFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(2));

        gpuHarness.devices[1].lost.resolve({
            message: 'second raw device loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'device-recovery-failed');
    });

    it('reauthorizes external HDR presentation on one replacement device', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness(2);
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'external-hdr',
            metadata,
            settings: createHDRToSDRRenderSettings({
                toneMapping: { inputPeakNits: metadata.nominalPeakNits }
            })
        }, 1)).resolves.toBe(true);

        const firstFrame = createNeutralBT709VideoFrame(vi.fn());
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame: firstFrame,
            mediaTimeMicroseconds: secondsToMicroseconds(2),
            outputMode: 'video-frame'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        gpuHarness.devices[0].lost.resolve({
            message: 'first external HDR device loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await vi.waitFor(() => expect(gpuHarness.requestDevice).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(presenter.getTelemetry().deviceRecoveryCount).toBe(1));
        expect(externalHDRAuthorizationMockState.authorizeCalls).toEqual([ gpuHarness.devices[1].device ]);
        expect(fallbackHandler).not.toHaveBeenCalled();

        const recoveredFrame = createNeutralBT709VideoFrame(vi.fn());
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame: recoveredFrame,
            mediaTimeMicroseconds: secondsToMicroseconds(3),
            outputMode: 'video-frame'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(2));

        gpuHarness.devices[1].lost.resolve({
            message: 'second external HDR device loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'device-recovery-failed');
    });

    it('reauthorizes Dolby Vision presentation on one replacement device', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness(2);
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-dolby-vision',
            profile: 8,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(true);

        const firstFrame = createRawFrame('I420P10', createPQColorMetadata());
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: firstFrame.durationMicroseconds ?? secondsToMicroseconds(0),
            encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(),
            frame: firstFrame,
            mediaTimeMicroseconds: firstFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        gpuHarness.devices[0].lost.resolve({
            message: 'first Dolby Vision device loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await vi.waitFor(() => expect(gpuHarness.requestDevice).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(presenter.getTelemetry().deviceRecoveryCount).toBe(1));
        expect(dolbyVisionAuthorizationMockState.authorizeCalls).toEqual([ gpuHarness.devices[1].device ]);
        expect(gpuHarness.devices[1].createBuffer.mock.calls.some(
            (call: unknown[]) => (
                (call[0] as GPUBufferDescriptor).label
                === 'WebGPU Dolby Vision per-frame RPU'
            )
        )).toBe(true);
        expect(fallbackHandler).not.toHaveBeenCalled();

        const recoveredFrame = createRawFrame('I420P10', createPQColorMetadata());
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: recoveredFrame.durationMicroseconds ?? secondsToMicroseconds(0),
            encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(),
            frame: recoveredFrame,
            mediaTimeMicroseconds: recoveredFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(2));

        gpuHarness.devices[1].lost.resolve({
            message: 'second Dolby Vision device loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'device-recovery-failed');
    });

    it('reauthorizes a Profile 7 FEL route over I422P10 planes on one replacement device', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness(2);
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const presentFELFrame = (): boolean => {
            const { baseFrame, enhancementFrame } = createCompoundDolbyVisionRawFrames('I422P10');
            return presenter.presentDecodedFrame({
                durationMicroseconds: baseFrame.durationMicroseconds ?? secondsToMicroseconds(0),
                encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(
                    createDolbyVisionAuthorizationRPUVector(7, 'fel', 10),
                    'decoded-fel',
                    true
                ),
                enhancementFrame,
                frame: baseFrame,
                mediaTimeMicroseconds: baseFrame.timestampMicroseconds,
                outputMode: 'raw-planes'
            }, 1);
        };

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-dolby-vision',
            profile: 7,
            rawFrameFormat: 'I422P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(true);
        expect(presentFELFrame()).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        gpuHarness.devices[0].lost.resolve({
            message: 'first dual-layer device loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await vi.waitFor(() => expect(gpuHarness.requestDevice).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(presenter.getTelemetry().deviceRecoveryCount).toBe(1));
        // The active route's own BL format keys are reauthorized, never the I420P10 ones
        expect(dolbyVisionAuthorizationMockState.authorizeRouteNames)
            .toEqual([ 'I422P10:profile7-base', 'I422P10:profile7-fel' ]);
        expect(dolbyVisionAuthorizationMockState.authorizeCalls)
            .toEqual([ gpuHarness.devices[1].device, gpuHarness.devices[1].device ]);
        const recoveredBufferLabels = gpuHarness.devices[1].createBuffer.mock.calls.map(
            (call: unknown[]) => (call[0] as GPUBufferDescriptor).label
        );
        expect(recoveredBufferLabels).toEqual(expect.arrayContaining([
            'WebGPU Dolby Vision per-frame RPU',
            'WebGPU Dolby Vision enhancement uniforms'
        ]));
        expect(fallbackHandler).not.toHaveBeenCalled();

        expect(presentFELFrame()).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(2));
        expect(presenter.getTelemetry().dolbyVisionDualLayerFELPresentedFrameCount).toBe(2);

        gpuHarness.devices[1].lost.resolve({
            message: 'second dual-layer device loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'device-recovery-failed');
    });

    it('closes but never imports a pushed decoded frame from a stale generation', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());
        const closeFrame = vi.fn();
        const frame = {
            close: closeFrame,
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        } as unknown as VideoFrame;

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        presenter.seek(2);

        const submitted = presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame,
            mediaTimeMicroseconds: secondsToMicroseconds(2),
            outputMode: 'video-frame'
        }, 1);

        expect(submitted).toBe(false);
        expect(closeFrame).toHaveBeenCalledOnce();
        expect(gpuHarness.devices[0].importExternalTexture).not.toHaveBeenCalled();
    });

    it('keeps HDR input on native video when the tone-mapping flag is disabled', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));

        const configured = await presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1);

        expect(configured).toBe(false);
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'hdr-tone-mapping-disabled');
        expect(surfaceHarness.surface.container.children).toHaveLength(1);
        expect(surfaceHarness.surface.container.firstChild).toBe(surfaceHarness.surface.video);
        expect(presenter.getTelemetry()).toMatchObject({
            fallbackReason: 'hdr-tone-mapping-disabled',
            mode: 'identity-sdr',
            state: 'fallback'
        });
    });

    it('fails closed when the exact current-device raw route is not authorized', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        rawHDRAuthorizationMockState.authorized = false;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));

        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata: createPQColorMetadata(),
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(false);

        expect(fallbackHandler).toHaveBeenCalledWith(1, 'hdr-authorization-unavailable');
        expect(presenter.getTelemetry()).toMatchObject({
            fallbackReason: 'hdr-authorization-unavailable',
            state: 'fallback'
        });
    });

    it('atomically installs a raw PQ-to-SDR shader and resumes presentation', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        const configured = await presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1);

        expect(configured).toBe(true);
        expect(fallbackHandler).not.toHaveBeenCalled();
        expect(gpuHarness.devices[0].createShaderModule).toHaveBeenCalledTimes(4);
        const hdrShaderDescriptor = gpuHarness.devices[0].createShaderModule.mock.calls
            .map((call: unknown[]) => call[0] as { code: string })
            .find(descriptor => descriptor.code.includes('lumaTexture'));
        expect(hdrShaderDescriptor).toBeDefined();
        expect(hdrShaderDescriptor?.code).toContain('fn applyPQEOTF');
        expect(hdrShaderDescriptor?.code).toContain('fn toneMapToSDR');
        expect(surfaceHarness.requestVideoFrameCallback).not.toHaveBeenCalled();
        expect(presenter.getTelemetry()).toMatchObject({
            fallbackReason: null,
            mode: 'hdr-to-sdr',
            state: 'initializing'
        });

        const rawFrame = createRawFrame('I420P10', metadata);
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: rawFrame.durationMicroseconds ?? secondsToMicroseconds(0),
            frame: rawFrame,
            mediaTimeMicroseconds: rawFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
        const hdrBindGroupDescriptor = gpuHarness.devices[0].createBindGroup.mock.calls[0][0] as {
            entries: GPUBindGroupEntry[]
        };
        expect(hdrBindGroupDescriptor.entries.map(entry => entry.binding)).toEqual([ 0, 1, 2, 3, 4 ]);
        expect(presenter.getTelemetry()).toMatchObject({
            lastPresentedMediaTimeMicroseconds: rawFrame.timestampMicroseconds,
            mode: 'hdr-to-sdr',
            state: 'presenting'
        });
    });

    it('bounds a retained-device pipeline rebuild and rejects its late result', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        const deviceHarness = gpuHarness.devices[0];
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(true);
        const retainedPipeline = (presenter as unknown as { pipeline: GPURenderPipeline | null }).pipeline;
        const latePipeline = {
            getBindGroupLayout: vi.fn(() => ({}))
        } as unknown as GPURenderPipeline;
        const pipelineResult = createDeferred<GPURenderPipeline>();
        deviceHarness.createRenderPipelineAsync.mockImplementationOnce(() => pipelineResult.promise);

        presenter.endSession(2);
        vi.useFakeTimers();
        presenter.startSession(3);
        await vi.advanceTimersByTimeAsync(microsecondsToMilliseconds(WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS));

        expect(deviceHarness.createRenderPipelineAsync).toHaveBeenCalledTimes(5);
        expect(fallbackHandler).toHaveBeenCalledOnce();
        expect(fallbackHandler).toHaveBeenCalledWith(3, 'pipeline-creation-failed');
        expect((presenter as unknown as { pipeline: GPURenderPipeline | null }).pipeline).toBe(retainedPipeline);

        pipelineResult.resolve(latePipeline);
        await pipelineResult.promise;
        await Promise.resolve();
        expect((presenter as unknown as { pipeline: GPURenderPipeline | null }).pipeline).toBe(retainedPipeline);
        expect(fallbackHandler).toHaveBeenCalledOnce();
    });

    it('updates live HDR controls through one uniform write without recompiling', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1);

        const deviceHarness = gpuHarness.devices[0];
        expect(deviceHarness.createShaderModule).toHaveBeenCalledTimes(4);
        deviceHarness.queueWriteBuffer.mockClear();
        const updated = presenter.updateRenderSettings(
            createHDRToSDRRenderSettings({
                display: {
                    brightness: 0.25,
                    contrast: 1.5,
                    saturation: 0.75
                },
                toneMapping: {
                    exposure: 0.5,
                    operator: 'reinhard',
                    outputPeakNits: 120
                }
            }),
            1
        );

        expect(updated).toBe(true);
        expect(deviceHarness.createShaderModule).toHaveBeenCalledTimes(4);
        expect(deviceHarness.createRenderPipelineAsync).toHaveBeenCalledTimes(4);
        expect(deviceHarness.queueWriteBuffer).toHaveBeenCalledOnce();
        const uniformWrite = deviceHarness.queueWriteBuffer.mock.calls[0];
        expect(uniformWrite[0]).toMatchObject({
            label: 'WebGPU video render settings uniforms'
        });
        const uniformData = uniformWrite[2] as Uint8Array<ArrayBuffer>;
        const integerValues = new Uint32Array(uniformData.buffer);
        const floatValues = new Float32Array(uniformData.buffer);
        expect(integerValues[1]).toBe(1);
        expect(integerValues[2]).toBe(1);
        expect(floatValues[5]).toBeCloseTo(0.5);
        expect(floatValues[7]).toBeCloseTo(120);
        expect(floatValues[9]).toBeCloseTo(0.25);
        expect(floatValues[10]).toBeCloseTo(1.5);
        expect(floatValues[11]).toBeCloseTo(0.75);
    });

    it('rejects a raw frame whose color description contradicts HDR input', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(true);
        const frame = createRawFrame('I420P10', metadata);
        frame.colorSpace.primaries = 'bt709';

        expect(presenter.presentDecodedFrame({
            durationMicroseconds: frame.durationMicroseconds ?? secondsToMicroseconds(0),
            frame,
            mediaTimeMicroseconds: frame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(false);
        expect(gpuHarness.devices[0].importExternalTexture).not.toHaveBeenCalled();
        expect(gpuHarness.devices[0].queueWriteTexture).not.toHaveBeenCalled();
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'decoded-frame-color-mismatch');
    });

    it.each([
        // A VUI with the BT.2020 10-bit transfer of an HLG-compatible stream has no WebCodecs transfer name
        { accepted: true, primaries: 'bt2020', transfer: null },
        { accepted: true, primaries: 'bt2020', transfer: 'bt709' },
        { accepted: true, primaries: null, transfer: 'arib-std-b67' },
        { accepted: false, primaries: null, transfer: 'bt709' },
        { accepted: false, primaries: 'bt2020', transfer: 'smpte2084' }
    ])('matches raw HLG frame color with unspecified members: %o', async ({
        accepted,
        primaries,
        transfer
    }) => {
        const metadata = createHLGColorMetadata();
        const { fallbackHandler, presenter } = await startRawRoutePresentation(
            metadata,
            'I420P10',
            createHDRToSDRRenderSettings()
        );
        const frame = createRawFrame('I420P10', metadata);
        frame.colorSpace.primaries = primaries;
        frame.colorSpace.transfer = transfer;

        expect(presentRawFrame(presenter, frame)).toBe(accepted);
        if (accepted) {
            await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
            expect(fallbackHandler).not.toHaveBeenCalled();
        } else {
            expect(fallbackHandler).toHaveBeenCalledWith(1, 'decoded-frame-color-mismatch');
        }
    });

    it.each([
        [ 'limited', `(rawYUV.x - ${(64).toFixed(9)}) / ${(876).toFixed(9)}` ],
        [ 'full', `rawYUV.x / ${(1_023).toFixed(9)}` ]
    ] as const)(
        'presents %s-range 10-bit BT.709 SDR I420P10 planes without the HDR tone mapping setting',
        async (range, lumaNormalization) => {
            const gpuHarness = createGPUHarness();
            const contextHarness = createCanvasContextHarness();
            const surfaceHarness = createSurfaceHarness();
            installGPU(gpuHarness.gpu);
            installCanvasContext(contextHarness.context);
            const fallbackHandler = vi.fn();
            const presenter = new WebGPUPresenter(fallbackHandler);
            const metadata = createSDRColorMetadata({ bitDepth: 10, range });

            presenter.startSession(1);
            presenter.setDecodedFramePushMode(true, 1);
            presenter.attach(surfaceHarness.surface, 1);
            await vi.waitFor(() => expect(
                surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
            ).toBeInstanceOf(HTMLCanvasElement));
            await expect(presenter.configureColorPipeline({
                inputMode: 'raw-yuv',
                metadata,
                rawFrameFormat: 'I420P10',
                settings: createDefaultRenderSettings()
            }, 1)).resolves.toBe(true);
            const deviceHarness = gpuHarness.devices[0];
            const rawSDRShader = deviceHarness.createShaderModule.mock.calls
                .map((call: unknown[]) => (call[0] as { code: string }).code)
                .find(code => code.includes('fn normalizeRawYUV'));
            expect(rawSDRShader).toContain(lumaNormalization);
            expect(rawSDRShader).not.toContain('var<uniform> renderSettings');

            const frame = createRawFrame('I420P10', metadata);
            frame.colorSpace.transfer = 'bt709';
            expect(presentRawFrame(presenter, frame)).toBe(true);
            await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

            expect(presenter.getTelemetry().mode).toBe('identity-sdr');
            expect(deviceHarness.createTexture.mock.calls.map(
                (call: unknown[]) => (call[0] as GPUTextureDescriptor).format
            )).toEqual([ 'r16uint', 'r16uint', 'r16uint' ]);
            const bindGroupDescriptor = deviceHarness.createBindGroup.mock.calls.at(-1)?.[0] as {
                entries: GPUBindGroupEntry[]
            };
            expect(bindGroupDescriptor.entries.map(entry => entry.binding)).toEqual([ 0, 1, 2, 3 ]);
            expect(fallbackHandler).not.toHaveBeenCalled();
        }
    );

    it('binds no retained render settings to a raw SDR session that follows an HDR session', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const deviceHarness = gpuHarness.devices[0];
        const startPushedSession = async (generation: number): Promise<void> => {
            presenter.startSession(generation);
            presenter.setDecodedFramePushMode(true, generation);
            presenter.attach(surfaceHarness.surface, generation);
            await vi.waitFor(() => expect(
                surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
            ).toBeInstanceOf(HTMLCanvasElement));
        };
        const presentGenerationFrame = (frame: TransferableRawVideoFrame, generation: number): boolean => (
            presenter.presentDecodedFrame({
                durationMicroseconds: frame.durationMicroseconds ?? secondsToMicroseconds(0),
                frame,
                mediaTimeMicroseconds: frame.timestampMicroseconds,
                outputMode: 'raw-planes'
            }, generation)
        );

        await startPushedSession(1);
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata: createPQColorMetadata(),
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(true);
        expect(presentGenerationFrame(createRawFrame('I420P10', createPQColorMetadata()), 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
        presenter.endSession(2);

        await startPushedSession(3);
        const metadata = createSDRColorMetadata({ bitDepth: 10 });
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createDefaultRenderSettings()
        }, 3)).resolves.toBe(true);
        const frame = createRawFrame('I420P10', metadata);
        frame.colorSpace.transfer = 'bt709';
        expect(presentGenerationFrame(frame, 3)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        // The identity shader declares no render settings binding for the buffer the HDR session left
        const bindGroupDescriptor = deviceHarness.createBindGroup.mock.calls.at(-1)?.[0] as {
            entries: GPUBindGroupEntry[]
        };
        expect(bindGroupDescriptor.entries.map(entry => entry.binding)).toEqual([ 0, 1, 2, 3 ]);
        expect(fallbackHandler).not.toHaveBeenCalled();
    });

    it.each([ 'bt709', 'smpte170m', null ])(
        'accepts a raw BT.709 SDR frame whose transfer is %s',
        async transfer => {
            const metadata = createSDRColorMetadata();
            const { fallbackHandler, presenter } = await startRawRoutePresentation(
                metadata,
                'I420',
                createDefaultRenderSettings()
            );
            const frame = createRawFrame('I420', metadata);
            frame.colorSpace.fullRange = null;
            frame.colorSpace.transfer = transfer;

            expect(presentRawFrame(presenter, frame)).toBe(true);
            await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
            expect(fallbackHandler).not.toHaveBeenCalled();
        }
    );

    it('rejects live renderer updates from stale generations without a GPU write', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1);
        presenter.seek(2);
        gpuHarness.devices[0].queueWriteBuffer.mockClear();

        expect(presenter.updateRenderSettings(createHDRToSDRRenderSettings(), 1)).toBe(false);
        expect(gpuHarness.devices[0].queueWriteBuffer).not.toHaveBeenCalled();
    });

    it('discards an HDR gate result after the presentation generation changes', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        const configuration = presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1);
        presenter.seek(2);

        await expect(configuration).resolves.toBe(false);
        expect(fallbackHandler).not.toHaveBeenCalled();
        expect(gpuHarness.devices[0].createShaderModule).toHaveBeenCalledTimes(3);
        expect(presenter.getTelemetry().mode).toBe('identity-sdr');
    });

    it('rejects an invalid initial submission before revealing or counting the frame', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        const deviceHarness = gpuHarness.devices[0];
        deviceHarness.popErrorScope.mockResolvedValueOnce(new GPUValidationError('simulated invalid submission'));
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        const canvas = surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas');

        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());

        expect(deviceHarness.queueSubmit).toHaveBeenCalledOnce();
        expect(canvas?.classList.contains('webgpuPlayerCanvas-visible')).toBe(false);
        expect(presenter.getTelemetry().presentedFrameCount).toBe(0);
        expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'frame-render-failed');
        expect(presenter.getTelemetry()).toMatchObject({
            fallbackReason: 'frame-render-failed',
            presentedFrameCount: 0,
            state: 'fallback'
        });
    });

    it('bounds initial submission validation and ignores its late result', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        const validationResult = createDeferred<GPUError | null>();
        const deviceHarness = gpuHarness.devices[0];
        deviceHarness.popErrorScope.mockImplementationOnce(() => validationResult.promise);
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        vi.useFakeTimers();
        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());

        await vi.advanceTimersByTimeAsync(microsecondsToMilliseconds(WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS));
        expect(fallbackHandler).toHaveBeenCalledOnce();
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'frame-render-failed');
        expect(surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')).toBeNull();
        expect(presenter.getTelemetry()).toMatchObject({
            fallbackReason: 'frame-render-failed',
            presentedFrameCount: 0,
            state: 'fallback'
        });

        validationResult.resolve(null);
        await validationResult.promise;
        await Promise.resolve();
        expect(fallbackHandler).toHaveBeenCalledOnce();
        expect(presenter.getTelemetry().presentedFrameCount).toBe(0);
        expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce();
    });

    it('latches fallback for an uncaptured validation error on the active device', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        const deviceHarness = gpuHarness.devices[0];
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
        surfaceHarness.callbacks.get(2)?.(performance.now(), createFrameMetadata(2));
        expect(deviceHarness.pushErrorScope).toHaveBeenCalledOnce();
        expect(deviceHarness.popErrorScope).toHaveBeenCalledOnce();
        expect(deviceHarness.queueSubmit).toHaveBeenCalledTimes(2);
        expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(3);
        expect(presenter.getTelemetry().presentedFrameCount).toBe(2);

        const wasNotCancelled = deviceHarness.dispatchUncapturedError(
            new GPUValidationError('simulated late validation error')
        );

        expect(wasNotCancelled).toBe(false);
        expect(fallbackHandler).toHaveBeenCalledOnce();
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'frame-render-failed');
        expect(surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')).toBeNull();
        expect(presenter.getTelemetry().state).toBe('fallback');
    });

    it('cancels seek callbacks and discards a retained stale callback', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        const staleCallback = surfaceHarness.callbacks.get(1);

        presenter.seek(2);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2));
        expect(surfaceHarness.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
        staleCallback?.(performance.now(), createFrameMetadata());
        expect(gpuHarness.devices[0].importExternalTexture).not.toHaveBeenCalled();

        const currentCallback = surfaceHarness.callbacks.get(2);
        currentCallback?.(performance.now(), createFrameMetadata(2));
        expect(gpuHarness.devices[0].importExternalTexture).toHaveBeenCalledOnce();
    });

    it('discards pending submission validation across a seek generation', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        const staleValidation = createDeferred<GPUError | null>();
        const deviceHarness = gpuHarness.devices[0];
        deviceHarness.popErrorScope.mockImplementationOnce(() => staleValidation.promise);
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        const canvas = surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas');
        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());
        expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce();

        presenter.seek(2);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2));
        staleValidation.resolve(null);
        await staleValidation.promise;
        await Promise.resolve();
        expect(canvas?.classList.contains('webgpuPlayerCanvas-visible')).toBe(false);
        expect(presenter.getTelemetry().presentedFrameCount).toBe(0);
        expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2);

        surfaceHarness.callbacks.get(2)?.(performance.now(), createFrameMetadata(2));
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
        expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(3);
    });

    it('removes the canvas and schedules no more frames after import failure', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        gpuHarness.devices[0].importExternalTexture.mockImplementation(() => {
            throw new Error('simulated import failure');
        });
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());

        expect(fallbackHandler).toHaveBeenCalledWith(1, 'frame-import-failed');
        expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce();
        expect(surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')).toBeNull();
        expect(presenter.getTelemetry().fallbackReason).toBe('frame-import-failed');
    });

    it('cancels outstanding frame work and reveals direct video on session end', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        const staleCallback = surfaceHarness.callbacks.get(1);

        presenter.endSession(2);
        staleCallback?.(performance.now(), createFrameMetadata());

        expect(surfaceHarness.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
        expect(gpuHarness.devices[0].importExternalTexture).not.toHaveBeenCalled();
        expect(surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')).toBeNull();
    });

    it('recovers one lost device and falls back after a second loss', async () => {
        const gpuHarness = createGPUHarness(2);
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        const callbackFromLostDevice = surfaceHarness.callbacks.get(1);

        gpuHarness.devices[0].lost.resolve({
            message: 'first simulated loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await vi.waitFor(() => expect(gpuHarness.requestDevice).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2));
        callbackFromLostDevice?.(performance.now(), createFrameMetadata());
        expect(gpuHarness.devices[1].importExternalTexture).not.toHaveBeenCalled();
        expect(presenter.getTelemetry().deviceRecoveryCount).toBe(1);
        expect(fallbackHandler).not.toHaveBeenCalled();

        gpuHarness.devices[1].lost.resolve({
            message: 'second simulated loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'device-recovery-failed');
        expect(surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')).toBeNull();
    });

    it('bounds a device recovery request that never settles', async () => {
        vi.useFakeTimers();
        const gpuHarness = createGPUHarness(2);
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.advanceTimersByTimeAsync(0);
        expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce();
        gpuHarness.requestDevice.mockImplementationOnce(() => (
            new Promise<GPUDevice>(() => undefined)
        ));
        gpuHarness.devices[0].lost.resolve({
            message: 'simulated deferred loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await vi.advanceTimersByTimeAsync(0);
        expect(gpuHarness.requestDevice).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(microsecondsToMilliseconds(WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS));

        expect(fallbackHandler).toHaveBeenCalledOnce();
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'device-recovery-failed');
        expect(surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')).toBeNull();
    });

    it('reveals direct video and rejects stale work while device recovery is pending', async () => {
        const gpuHarness = createGPUHarness(2);
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());
        await vi.waitFor(() => {
            expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2);
        });
        const callbackFromLostDevice = surfaceHarness.callbacks.get(2);
        const visibleCanvas = surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas-visible');
        expect(visibleCanvas).toBeInstanceOf(HTMLCanvasElement);

        const recoveryDevice = createDeferred<GPUDevice>();
        gpuHarness.requestDevice.mockImplementationOnce(() => recoveryDevice.promise);
        gpuHarness.devices[0].lost.resolve({
            message: 'simulated deferred loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);

        await vi.waitFor(() => expect(gpuHarness.requestDevice).toHaveBeenCalledTimes(2));
        expect(surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')).toBeNull();
        expect(presenter.getTelemetry().state).toBe('initializing');

        window.dispatchEvent(new Event('resize'));
        callbackFromLostDevice?.(performance.now(), createFrameMetadata(2));
        expect(gpuHarness.devices[1].importExternalTexture).not.toHaveBeenCalled();
        expect(fallbackHandler).not.toHaveBeenCalled();

        recoveryDevice.resolve(gpuHarness.devices[1].device);
        await vi.waitFor(() => {
            expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(3);
        });
        const recoveredCanvas = surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas');
        expect(recoveredCanvas).toBeInstanceOf(HTMLCanvasElement);
        expect(recoveredCanvas?.classList.contains('webgpuPlayerCanvas-visible')).toBe(false);

        surfaceHarness.callbacks.get(3)?.(performance.now(), createFrameMetadata(3));
        expect(gpuHarness.devices[1].importExternalTexture).toHaveBeenCalledOnce();
        await vi.waitFor(() => {
            expect(recoveredCanvas?.classList.contains('webgpuPlayerCanvas-visible')).toBe(true);
        });
        expect(presenter.getTelemetry().state).toBe('presenting');
        expect(fallbackHandler).not.toHaveBeenCalled();
    });

    it('matches contain aspect handling with a centered render viewport', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness(1_000, 1_000);
        surfaceHarness.surface.video.style.objectFit = 'contain';
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());

        expect(gpuHarness.devices[0].renderPassSetViewport).toHaveBeenCalledWith(
            0,
            218.75,
            1_000,
            562.5,
            0,
            1
        );
    });

    it('recomputes positioned scale-down geometry across DPR and resize changes', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness(1_000, 1_000);
        surfaceHarness.surface.video.style.objectFit = 'scale-down';
        surfaceHarness.surface.video.style.objectPosition = '25% 75%';
        Object.defineProperty(window, 'devicePixelRatio', {
            configurable: true,
            value: 2
        });
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());
        await vi.waitFor(() => {
            expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2);
        });

        expect(gpuHarness.devices[0].renderPassSetViewport).toHaveBeenLastCalledWith(
            0,
            656.25,
            2_000,
            1_125,
            0,
            1
        );
        const canvas = surfaceHarness.surface.container.querySelector('canvas');
        expect(canvas).toMatchObject({ height: 2_000, width: 2_000 });

        Object.defineProperties(surfaceHarness.surface.container, {
            clientHeight: { configurable: true, value: 600 },
            clientWidth: { configurable: true, value: 800 }
        });
        surfaceHarness.surface.container.getBoundingClientRect = vi.fn(() => createRectangle(0, 0, 800, 600));
        surfaceHarness.surface.video.getBoundingClientRect = vi.fn(() => createRectangle(0, 0, 800, 600));
        Object.defineProperty(window, 'devicePixelRatio', {
            configurable: true,
            value: 1.5
        });
        window.dispatchEvent(new Event('resize'));

        expect(gpuHarness.devices[0].renderPassSetViewport).toHaveBeenLastCalledWith(
            0,
            168.75,
            1_200,
            675,
            0,
            1
        );
        expect(canvas).toMatchObject({ height: 900, width: 1_200 });
        expect(canvas?.style.height).toBe('600px');
        expect(canvas?.style.width).toBe('800px');
    });

    it('reuses layout across frames and recomputes it after resize', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());
        const containerRectangle = surfaceHarness.surface.container.getBoundingClientRect as MockFunction;
        const videoRectangle = surfaceHarness.surface.video.getBoundingClientRect as MockFunction;

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2));

        surfaceHarness.callbacks.get(2)?.(performance.now(), createFrameMetadata(2));
        expect(containerRectangle).toHaveBeenCalledOnce();
        expect(videoRectangle).toHaveBeenCalledOnce();

        window.dispatchEvent(new Event('resize'));
        expect(containerRectangle).toHaveBeenCalledTimes(2);
        expect(videoRectangle).toHaveBeenCalledTimes(2);
    });

    it('destroys reusable GPU resources and reacquires them for a later session', async () => {
        const gpuHarness = createGPUHarness(2);
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());

        presenter.destroy();

        expect(gpuHarness.devices[0].destroy).toHaveBeenCalledOnce();
        expect(surfaceHarness.surface.container.querySelector('.webgpuPlayerCanvas')).toBeNull();
        expect(presenter.getTelemetry().state).toBe('idle');

        presenter.startSession(3);
        presenter.attach(surfaceHarness.surface, 3);
        await vi.waitFor(() => expect(gpuHarness.requestDevice).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2));
        expect(gpuHarness.devices[1].destroy).not.toHaveBeenCalled();
    });

    it('falls back if a WebGPU canvas context cannot be acquired', async () => {
        const gpuHarness = createGPUHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(null);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);

        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'canvas-context-unavailable');
        expect(surfaceHarness.surface.container.children).toHaveLength(1);
    });

    describe('worker presentation', () => {
        type FakeMessagePort = {
            close: MockFunction
            onmessage: ((event: MessageEvent<unknown>) => void) | null
            postedMessages: unknown[]
            postMessage: (message: unknown) => void
        };

        type FakeChannel = {
            port1: FakeMessagePort
            port2: FakeMessagePort
        };

        // The decode generation whose run posted the worker frames
        const WORKER_DECODE_GENERATION = 41;
        const WORKER_FRAME_DISPLAY_WIDTH = 1_920;
        const WORKER_FRAME_DISPLAY_HEIGHT = 1_080;
        const FIRST_WORKER_REVISION = 1;
        const SECOND_WORKER_REVISION = 2;
        const LIVE_TONE_MAPPING_EXPOSURE = 0.5;

        const createdChannels: FakeChannel[] = [];
        const transferredCanvases: HTMLCanvasElement[] = [];
        const originalMessageChannel = Object.getOwnPropertyDescriptor(globalThis, 'MessageChannel');
        const originalOffscreenCanvas = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
        const originalTransferControlToOffscreen = Object.getOwnPropertyDescriptor(
            HTMLCanvasElement.prototype,
            'transferControlToOffscreen'
        );

        class TestOffscreenCanvas {}

        function createFakeMessagePort(): FakeMessagePort {
            const postedMessages: unknown[] = [];
            return {
                close: vi.fn(),
                onmessage: null,
                postedMessages,
                postMessage: (message: unknown): void => {
                    postedMessages.push(message);
                }
            };
        }

        class TestMessageChannel implements FakeChannel {
            readonly port1 = createFakeMessagePort();
            readonly port2 = createFakeMessagePort();

            constructor() {
                createdChannels.push(this);
            }
        }

        /** Delivers a renderer message to the presenter's end of the channel. */
        function answerAsRenderer(channel: FakeChannel, response: WorkerPresentationResponse): void {
            channel.port1.onmessage?.({ data: response } as MessageEvent<unknown>);
        }

        function getPostedRequests(channel: FakeChannel, type: string): Array<Record<string, unknown>> {
            return channel.port1.postedMessages.filter((message: unknown): boolean => (
                (message as Record<string, unknown>).type === type
            )) as Array<Record<string, unknown>>;
        }

        function createWorkerFrame(frameId: number): DecodedWorkerPresentationFrame {
            return {
                decodeGeneration: WORKER_DECODE_GENERATION,
                displayHeight: WORKER_FRAME_DISPLAY_HEIGHT,
                displayWidth: WORKER_FRAME_DISPLAY_WIDTH,
                durationMicroseconds: secondsToMicroseconds(0.04),
                frameId,
                mediaTimeMicroseconds: secondsToMicroseconds(frameId + 1),
                outputMode: 'worker-frame'
            };
        }

        function createPresentedResponse(frameId: number, ok: boolean): WorkerPresentationResponse {
            return {
                dolbyVisionDualLayerMode: null,
                frameId,
                generation: WORKER_DECODE_GENERATION,
                gpuWorkCompleted: ok,
                HDR10PlusResult: null,
                ok,
                type: 'presented'
            };
        }

        function requireAttachedChannel(presenter: WebGPUPresenter): FakeChannel {
            const attachment = presenter.createWorkerPresentationAttachment(1);
            const channel = createdChannels.at(-1);
            if (!attachment || !channel) {
                throw new Error('The presenter created no worker presentation attachment');
            }
            expect(attachment.port).toBe(channel.port2);
            expect(attachment.canvas).toBeInstanceOf(TestOffscreenCanvas);
            return channel;
        }

        /** Attaches a renderer that reported ready and accepted the active pipeline. */
        function attachReadyRenderer(presenter: WebGPUPresenter): FakeChannel {
            const channel = requireAttachedChannel(presenter);
            answerAsRenderer(channel, { reason: null, state: 'ready', type: 'status' });
            answerAsRenderer(channel, { ok: true, reason: null, revision: FIRST_WORKER_REVISION, type: 'configured' });
            return channel;
        }

        function getMainCanvas(): Element | null {
            for (const canvas of document.querySelectorAll('.webgpuPlayerCanvas')) {
                if (!transferredCanvases.includes(canvas as HTMLCanvasElement)) {
                    return canvas;
                }
            }
            return null;
        }

        beforeEach(() => {
            createdChannels.length = 0;
            transferredCanvases.length = 0;
            Object.defineProperty(globalThis, 'MessageChannel', { configurable: true, value: TestMessageChannel });
            Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, value: TestOffscreenCanvas });
            Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
                configurable: true,
                value: function transferControlToOffscreen(this: HTMLCanvasElement): OffscreenCanvas {
                    transferredCanvases.push(this);
                    return new TestOffscreenCanvas() as unknown as OffscreenCanvas;
                }
            });
        });

        afterEach(() => {
            restoreProperty(globalThis, 'MessageChannel', originalMessageChannel);
            restoreProperty(globalThis, 'OffscreenCanvas', originalOffscreenCanvas);
            restoreProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', originalTransferControlToOffscreen);
        });

        it('creates a transferred canvas and a renderer channel only for a current pushed-frame session', async () => {
            const idlePresenter = new WebGPUPresenter(vi.fn());
            expect(idlePresenter.createWorkerPresentationAttachment(1)).toBeNull();

            const { presenter } = await startRawRoutePresentation(
                createPQColorMetadata(),
                'I420P10',
                createHDRToSDRRenderSettings()
            );
            expect(presenter.createWorkerPresentationAttachment(2)).toBeNull();
            const channel = requireAttachedChannel(presenter);

            const [ workerCanvas ] = transferredCanvases;
            expect(workerCanvas.isConnected).toBe(true);
            expect(workerCanvas.classList.contains('webgpuPlayerCanvas')).toBe(true);
            expect(workerCanvas.classList.contains('webgpuPlayerCanvas-visible')).toBe(false);
            // The renderer reads the active pipeline before any present
            const [ configureRequest ] = channel.port1.postedMessages;
            expect(isWorkerPresentationRequest(configureRequest)).toBe(true);
            expect(configureRequest).toMatchObject({
                inputMode: 'raw-yuv',
                rawFrameFormat: 'I420P10',
                revision: FIRST_WORKER_REVISION,
                type: 'configure'
            });
        });

        it('presents a worker frame by ID once its renderer is ready and configured, and completes the selection after its GPU work', async () => {
            const { fallbackHandler, presenter } = await startRawRoutePresentation(
                createPQColorMetadata(),
                'I420P10',
                createHDRToSDRRenderSettings()
            );
            const channel = requireAttachedChannel(presenter);
            const completed = vi.fn();

            // A renderer still starting, or still installing its pipeline, refuses the frame without a fallback
            expect(presenter.presentDecodedFrame(createWorkerFrame(0), 1, completed)).toBe(false);
            answerAsRenderer(channel, { reason: null, state: 'ready', type: 'status' });
            expect(presenter.presentDecodedFrame(createWorkerFrame(0), 1, completed)).toBe(false);
            answerAsRenderer(channel, { ok: true, reason: null, revision: FIRST_WORKER_REVISION, type: 'configured' });

            expect(presenter.presentDecodedFrame(createWorkerFrame(1), 1, completed)).toBe(true);
            const [ layoutRequest ] = getPostedRequests(channel, 'layout');
            expect(isWorkerPresentationRequest(layoutRequest)).toBe(true);
            expect(layoutRequest).toMatchObject({ revision: FIRST_WORKER_REVISION });
            expect(getPostedRequests(channel, 'present')).toEqual([ {
                frameId: 1,
                generation: WORKER_DECODE_GENERATION,
                layoutRevision: FIRST_WORKER_REVISION,
                type: 'present'
            } ]);
            await Promise.resolve();
            expect(completed).not.toHaveBeenCalled();

            answerAsRenderer(channel, createPresentedResponse(1, true));
            await vi.waitFor(() => expect(completed).toHaveBeenCalledWith(true));
            const [ workerCanvas ] = transferredCanvases;
            expect(workerCanvas.classList.contains('webgpuPlayerCanvas-visible')).toBe(true);
            expect(getMainCanvas()?.classList.contains('webgpuPlayerCanvas-visible')).toBe(false);
            expect(presenter.getTelemetry()).toMatchObject({ presentedFrameCount: 1, state: 'presenting' });

            // An unchanged layout is not posted again
            expect(presenter.presentDecodedFrame(createWorkerFrame(2), 1, completed)).toBe(true);
            expect(getPostedRequests(channel, 'layout')).toHaveLength(1);
            expect(fallbackHandler).not.toHaveBeenCalled();
        });

        it('discards a worker frame the renderer could not draw, and falls back on a renderer failure', async () => {
            const { fallbackHandler, presenter } = await startRawRoutePresentation(
                createPQColorMetadata(),
                'I420P10',
                createHDRToSDRRenderSettings()
            );
            const channel = attachReadyRenderer(presenter);
            const completed = vi.fn();

            expect(presenter.presentDecodedFrame(createWorkerFrame(0), 1, completed)).toBe(true);
            answerAsRenderer(channel, createPresentedResponse(0, false));
            await vi.waitFor(() => expect(completed).toHaveBeenCalledWith(false));
            expect(transferredCanvases[0].classList.contains('webgpuPlayerCanvas-visible')).toBe(false);
            expect(presenter.getTelemetry().presentedFrameCount).toBe(0);
            expect(fallbackHandler).not.toHaveBeenCalled();

            answerAsRenderer(channel, { reason: 'device-recovery-failed', type: 'failed' });
            expect(fallbackHandler).toHaveBeenCalledWith(1, 'device-recovery-failed');
            expect(transferredCanvases[0].isConnected).toBe(false);
        });

        it('removes the canvas of an unavailable renderer and keeps presenting on the page', async () => {
            const { fallbackHandler, presenter } = await startRawRoutePresentation(
                createPQColorMetadata(),
                'I420P10',
                createHDRToSDRRenderSettings()
            );
            const channel = requireAttachedChannel(presenter);

            answerAsRenderer(channel, { reason: 'gpu-unavailable', state: 'unavailable', type: 'status' });
            expect(transferredCanvases[0].isConnected).toBe(false);
            expect(channel.port1.close).toHaveBeenCalledOnce();
            expect(getPostedRequests(channel, 'detach')).toHaveLength(1);
            expect(fallbackHandler).not.toHaveBeenCalled();
            expect(getMainCanvas()).toBeInstanceOf(HTMLCanvasElement);
            expect(presentRawFrame(presenter, createRawFrame('I420P10', createPQColorMetadata()))).toBe(true);
        });

        it('replaces an earlier attachment and discards the frames its renderer was asked to draw', async () => {
            const { presenter } = await startRawRoutePresentation(
                createPQColorMetadata(),
                'I420P10',
                createHDRToSDRRenderSettings()
            );
            const firstChannel = attachReadyRenderer(presenter);
            const completed = vi.fn();
            expect(presenter.presentDecodedFrame(createWorkerFrame(0), 1, completed)).toBe(true);

            const secondChannel = requireAttachedChannel(presenter);
            await vi.waitFor(() => expect(completed).toHaveBeenCalledWith(false));
            const [ firstCanvas, secondCanvas ] = transferredCanvases;
            expect(firstCanvas.isConnected).toBe(false);
            expect(secondCanvas.isConnected).toBe(true);
            expect(firstChannel.port1.close).toHaveBeenCalledOnce();
            expect(getPostedRequests(firstChannel, 'detach')).toHaveLength(1);
            expect(getPostedRequests(secondChannel, 'configure')).toEqual([
                expect.objectContaining({ revision: FIRST_WORKER_REVISION })
            ]);

            // A late answer of the replaced renderer reaches nothing
            answerAsRenderer(firstChannel, createPresentedResponse(0, true));
            expect(completed).toHaveBeenCalledOnce();
        });

        it('forwards live HDR controls and waits for the renderer to accept a new pipeline', async () => {
            const { fallbackHandler, presenter } = await startRawRoutePresentation(
                createPQColorMetadata(),
                'I420P10',
                createHDRToSDRRenderSettings()
            );
            const channel = attachReadyRenderer(presenter);
            const liveSettings = createHDRToSDRRenderSettings({ toneMapping: { exposure: LIVE_TONE_MAPPING_EXPOSURE } });

            expect(presenter.updateRenderSettings(liveSettings, 1)).toBe(true);
            const [ settingsRequest ] = getPostedRequests(channel, 'settings');
            expect(isWorkerPresentationRequest(settingsRequest)).toBe(true);
            expect(settingsRequest).toMatchObject({ automaticInputPeakNits: true, revision: FIRST_WORKER_REVISION });

            let configurationSettled = false;
            const configurationPromise = presenter.configureColorPipeline({
                inputMode: 'raw-yuv',
                metadata: createPQColorMetadata(),
                rawFrameFormat: 'I420P10',
                settings: createHDRToSDRRenderSettings()
            }, 1).then((configured: boolean): boolean => {
                configurationSettled = true;
                return configured;
            });
            await vi.waitFor(() => expect(getPostedRequests(channel, 'configure')).toHaveLength(2));
            await Promise.resolve();
            expect(configurationSettled).toBe(false);
            expect(presenter.presentDecodedFrame(createWorkerFrame(0), 1, vi.fn())).toBe(false);

            answerAsRenderer(channel, { ok: true, reason: null, revision: SECOND_WORKER_REVISION, type: 'configured' });
            await expect(configurationPromise).resolves.toBe(true);
            expect(presenter.presentDecodedFrame(createWorkerFrame(1), 1, vi.fn())).toBe(true);
            expect(fallbackHandler).not.toHaveBeenCalled();
        });

        it('falls back when the renderer refuses a new pipeline', async () => {
            const { fallbackHandler, presenter } = await startRawRoutePresentation(
                createPQColorMetadata(),
                'I420P10',
                createHDRToSDRRenderSettings()
            );
            const channel = attachReadyRenderer(presenter);

            const configurationPromise = presenter.configureColorPipeline({
                inputMode: 'raw-yuv',
                metadata: createPQColorMetadata(),
                rawFrameFormat: 'I420P10',
                settings: createHDRToSDRRenderSettings()
            }, 1);
            await vi.waitFor(() => expect(getPostedRequests(channel, 'configure')).toHaveLength(2));
            answerAsRenderer(channel, {
                ok: false,
                reason: 'pipeline-creation-failed',
                revision: SECOND_WORKER_REVISION,
                type: 'configured'
            });

            await expect(configurationPromise).resolves.toBe(false);
            expect(fallbackHandler).toHaveBeenCalledWith(1, 'pipeline-creation-failed');
        });

        it('ends the attachment with the session', async () => {
            const { presenter } = await startRawRoutePresentation(
                createPQColorMetadata(),
                'I420P10',
                createHDRToSDRRenderSettings()
            );
            const channel = attachReadyRenderer(presenter);

            presenter.endSession(1);
            expect(transferredCanvases[0].isConnected).toBe(false);
            expect(channel.port1.close).toHaveBeenCalledOnce();
            expect(getPostedRequests(channel, 'detach')).toHaveLength(1);
        });
    });
});
