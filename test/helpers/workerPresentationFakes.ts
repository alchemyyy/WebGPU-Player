// What the decode worker's renderer finds in a browser, faked for Node: WebGPU with its usage constants, a transferred canvas, the page's end of the renderer's channel, and decoded frames

import { vi } from 'vitest';

import {
    copyVideoFramePairToRawPlanes,
    copyVideoFrameToRawPlanes,
    type RawVideoFrameColorSpace,
    type RawVideoFrameSource,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame,
    type TransferableRawVideoFramePair
} from 'webgpu-player/video/RawVideoFrameCopy';
import type {
    WorkerPresentationRequest,
    WorkerPresentationResponse
} from 'webgpu-player/presentation/WorkerPresentationProtocol';

type MockFunction = ReturnType<typeof vi.fn>;

type Deferred<Value> = {
    promise: Promise<Value>
    resolve: (value: Value) => void
};

// Above the 8192 texels a default WebGPU device allows
export const ADAPTER_MAXIMUM_TEXTURE_DIMENSION = 16_384;
export const DEVICE_MAXIMUM_TEXTURE_DIMENSION = 8_192;
export const PREFERRED_CANVAS_FORMAT: GPUTextureFormat = 'bgra8unorm';
export const INITIAL_CANVAS_WIDTH = 300;
export const INITIAL_CANVAS_HEIGHT = 150;
export const RAW_FRAME_TIMESTAMP_MICROSECONDS = 1_000_000;
export const RAW_FRAME_DURATION_MICROSECONDS = 41_667;
// A frame's decoded PQ color, as a 10-bit HDR10 decoder reports it
export const PQ_FRAME_COLOR_SPACE: RawVideoFrameColorSpace = {
    fullRange: false,
    matrix: 'bt2020-ncl',
    primaries: 'bt2020',
    transfer: 'smpte2084'
};
// The neutral color that the external HDR and Dolby Vision routes rewrite their streams to
export const NEUTRAL_BT709_FRAME_COLOR_SPACE: RawVideoFrameColorSpace = {
    fullRange: false,
    matrix: 'bt709',
    primaries: 'bt709',
    transfer: 'bt709'
};
const ENHANCEMENT_LAYER_FORMAT: SupportedRawVideoFrameFormat = 'I420P10';
// WebGPU's flag values
const GPU_BUFFER_USAGE = Object.freeze({
    // WebGPU defines these external names
    /* eslint-disable @typescript-eslint/naming-convention */
    COPY_DST: 0x0008,
    COPY_SRC: 0x0004,
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    STORAGE: 0x0080,
    UNIFORM: 0x0040
    /* eslint-enable @typescript-eslint/naming-convention */
});
const GPU_TEXTURE_USAGE = Object.freeze({
    // WebGPU defines these external names
    /* eslint-disable @typescript-eslint/naming-convention */
    COPY_DST: 0x02,
    COPY_SRC: 0x01,
    RENDER_ATTACHMENT: 0x10,
    TEXTURE_BINDING: 0x04
    /* eslint-enable @typescript-eslint/naming-convention */
});

export type FakeDeviceHarness = {
    /** The entries of each bind group, in creation order */
    readonly bindGroupEntries: GPUBindGroupEntry[][]
    createBuffer: MockFunction
    createRenderPipelineAsync: MockFunction
    createTexture: MockFunction
    destroy: MockFunction
    device: GPUDevice
    dispatchUncapturedError: (message: string) => void
    importExternalTexture: MockFunction
    /** Loses the device, as the browser does when its GPU process goes */
    lose: () => void
    popErrorScope: MockFunction
    pushErrorScope: MockFunction
    queueOnSubmittedWorkDone: MockFunction
    queueSubmit: MockFunction
    queueWriteBuffer: MockFunction
    queueWriteTexture: MockFunction
    renderPassSetViewport: MockFunction
    textureDestroy: MockFunction
};

export type FakeGPUHarness = {
    devices: FakeDeviceHarness[]
    gpu: GPU
    requestAdapter: MockFunction
    requestDevice: MockFunction
};

export type FakeCanvasHarness = {
    canvas: OffscreenCanvas
    configure: MockFunction
    context: GPUCanvasContext
    getCurrentTexture: MockFunction
    unconfigure: MockFunction
};

function createDeferred<Value>(): Deferred<Value> {
    let resolveValue: (value: Value) => void = (): void => {
        throw new Error('The deferred promise was not initialized');
    };
    const promise = new Promise<Value>(resolve => {
        resolveValue = resolve;
    });
    return { promise, resolve: resolveValue };
}

/** Defines WebGPU's usage constants, which Node lacks; vi.unstubAllGlobals() removes them. */
export function installWebGPUConstants(): void {
    vi.stubGlobal('GPUBufferUsage', GPU_BUFFER_USAGE);
    vi.stubGlobal('GPUTextureUsage', GPU_TEXTURE_USAGE);
}

/** Gives the worker's navigator a WebGPU entry point, or removes it. */
export function installWorkerGPU(gpu: GPU | null): void {
    if (!gpu) {
        Reflect.deleteProperty(navigator, 'gpu');
        return;
    }
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: gpu });
}

/** A device that records what the renderer creates, writes, and submits, and completes submitted work at once. */
export function createFakeDevice(maximumTextureDimension = DEVICE_MAXIMUM_TEXTURE_DIMENSION): FakeDeviceHarness {
    const deviceEventTarget = new EventTarget();
    const lost = createDeferred<GPUDeviceLostInfo>();
    const bindGroupEntries: GPUBindGroupEntry[][] = [];
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
    const textureDestroy = vi.fn();
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => ({
        destroy: vi.fn(),
        label: descriptor.label,
        size: descriptor.size,
        usage: descriptor.usage
    }));
    const createTexture = vi.fn((descriptor: GPUTextureDescriptor) => ({
        createView: vi.fn(() => ({ label: descriptor.label })),
        destroy: textureDestroy,
        label: descriptor.label
    }));
    const createRenderPipelineAsync = vi.fn(() => Promise.resolve(pipeline));
    const importExternalTexture = vi.fn(() => ({}));
    const popErrorScope = vi.fn(() => Promise.resolve(null));
    const pushErrorScope = vi.fn();
    const queueOnSubmittedWorkDone = vi.fn(() => Promise.resolve());
    const queueSubmit = vi.fn();
    const queueWriteBuffer = vi.fn();
    const queueWriteTexture = vi.fn();
    const destroy = vi.fn((): void => {
        lost.resolve({ message: '', reason: 'destroyed' } as GPUDeviceLostInfo);
    });
    const device = {
        addEventListener: deviceEventTarget.addEventListener.bind(deviceEventTarget),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => {
            bindGroupEntries.push([ ...descriptor.entries ]);
            return {};
        }),
        createBuffer,
        createCommandEncoder: vi.fn(() => commandEncoder),
        createRenderPipelineAsync,
        createSampler: vi.fn(() => ({})),
        createShaderModule: vi.fn(() => ({})),
        createTexture,
        destroy,
        importExternalTexture,
        limits: { maxTextureDimension2D: maximumTextureDimension },
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
    return {
        bindGroupEntries,
        createBuffer,
        createRenderPipelineAsync,
        createTexture,
        destroy,
        device,
        dispatchUncapturedError: (message: string): void => {
            const event = new Event('uncapturederror', { cancelable: true });
            Object.defineProperty(event, 'error', { value: { message } });
            deviceEventTarget.dispatchEvent(event);
        },
        importExternalTexture,
        lose: (): void => {
            lost.resolve({ message: 'The GPU process was lost', reason: 'unknown' } as GPUDeviceLostInfo);
        },
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

/** An adapter that hands out the given number of devices in turn, above the default texture limit. */
export function createFakeGPU(deviceCount = 1): FakeGPUHarness {
    const devices: FakeDeviceHarness[] = [];
    for (let deviceIndex = 0; deviceIndex < deviceCount; deviceIndex += 1) {
        devices.push(createFakeDevice());
    }
    let requestedDeviceCount = 0;
    const requestDevice = vi.fn(() => {
        const deviceHarness = devices[requestedDeviceCount];
        requestedDeviceCount += 1;
        return deviceHarness ? Promise.resolve(deviceHarness.device) : Promise.reject(new Error('No device is left'));
    });
    const adapter = {
        limits: { maxTextureDimension2D: ADAPTER_MAXIMUM_TEXTURE_DIMENSION },
        requestDevice
    } as unknown as GPUAdapter;
    const requestAdapter = vi.fn(() => Promise.resolve(adapter));
    const gpu = {
        getPreferredCanvasFormat: vi.fn(() => PREFERRED_CANVAS_FORMAT),
        requestAdapter
    } as unknown as GPU;
    return { devices, gpu, requestAdapter, requestDevice };
}

/** A canvas transferred to a worker: it sizes its own backing store and offers a WebGPU context, or none. */
export class FakeOffscreenCanvas {
    public height = INITIAL_CANVAS_HEIGHT;
    public width = INITIAL_CANVAS_WIDTH;

    public constructor(private readonly context: GPUCanvasContext | null) {}

    public getContext(contextId: string): GPUCanvasContext | null {
        return contextId === 'webgpu' ? this.context : null;
    }
}

/** Creates a transferred canvas whose WebGPU context records its configuration. */
export function createFakeCanvas(): FakeCanvasHarness {
    const configure = vi.fn();
    const unconfigure = vi.fn();
    const getCurrentTexture = vi.fn(() => ({
        createView: vi.fn(() => ({ label: 'canvas texture' }))
    }));
    const context = { configure, getCurrentTexture, unconfigure } as unknown as GPUCanvasContext;
    return {
        canvas: new FakeOffscreenCanvas(context) as unknown as OffscreenCanvas,
        configure,
        context,
        getCurrentTexture,
        unconfigure
    };
}

/** A decoded VideoFrame of the given color, which records its close. */
export function createFakeVideoFrame(
    colorSpace: RawVideoFrameColorSpace,
    codedWidth = 16,
    codedHeight = 8
): VideoFrame {
    return {
        close: vi.fn(),
        codedHeight,
        codedWidth,
        colorSpace,
        displayHeight: codedHeight,
        displayWidth: codedWidth
    } as unknown as VideoFrame;
}

/** A decoded frame whose copy returns the requested layout, as a conforming decoder does. */
export function createRawFrameSource(
    format: SupportedRawVideoFrameFormat,
    codedWidth: number,
    codedHeight: number,
    colorSpace: RawVideoFrameColorSpace = PQ_FRAME_COLOR_SPACE
): RawVideoFrameSource {
    return {
        close: vi.fn(),
        codedHeight,
        codedWidth,
        colorSpace,
        copyTo: vi.fn(async (
            _destination: ArrayBuffer,
            options: VideoFrameCopyToOptions
        ): Promise<PlaneLayout[]> => [ ...(options.layout ?? []) ]),
        displayHeight: codedHeight,
        displayWidth: codedWidth,
        duration: RAW_FRAME_DURATION_MICROSECONDS,
        format,
        timestamp: RAW_FRAME_TIMESTAMP_MICROSECONDS,
        visibleRect: { height: codedHeight, width: codedWidth, x: 0, y: 0 }
    };
}

/** Copies one decoded frame through the production raw copy. */
export function copyRawFrame(
    format: SupportedRawVideoFrameFormat,
    codedWidth: number,
    codedHeight: number,
    colorSpace: RawVideoFrameColorSpace = PQ_FRAME_COLOR_SPACE
): Promise<TransferableRawVideoFrame> {
    return copyVideoFrameToRawPlanes(createRawFrameSource(format, codedWidth, codedHeight, colorSpace), { format });
}

/** Copies a BL in format and, when included, its half-size I420P10 EL through the production pair copy. */
export function copyRawFramePair(
    format: SupportedRawVideoFrameFormat,
    codedWidth: number,
    codedHeight: number,
    includeEnhancementFrame: boolean
): Promise<TransferableRawVideoFramePair> {
    const enhancementWidth = codedWidth / 2;
    const enhancementHeight = codedHeight / 2;
    return copyVideoFramePairToRawPlanes(
        createRawFrameSource(format, codedWidth, codedHeight),
        includeEnhancementFrame ?
            createRawFrameSource(ENHANCEMENT_LAYER_FORMAT, enhancementWidth, enhancementHeight) :
            null,
        {
            enhancementExpectedGeometry: {
                codedHeight: enhancementHeight,
                codedWidth: enhancementWidth,
                displayHeight: enhancementHeight,
                displayWidth: enhancementWidth
            },
            format
        }
    );
}

type ResponseWaiter = {
    matches: (response: WorkerPresentationResponse) => boolean
    resolve: (response: WorkerPresentationResponse) => void
};

/** The page presenter's end of a renderer's channel: it records each response and can wait for one. */
export class RendererPortProbe {
    public readonly responses: WorkerPresentationResponse[] = [];
    private readonly responseWaiters: ResponseWaiter[] = [];

    public constructor(private readonly port: MessagePort) {
        port.onmessage = (event: MessageEvent<WorkerPresentationResponse>): void => {
            this.responses.push(event.data);
            for (let waiterIndex = this.responseWaiters.length - 1; waiterIndex >= 0; waiterIndex -= 1) {
                const waiter = this.responseWaiters[waiterIndex];
                if (waiter.matches(event.data)) {
                    this.responseWaiters.splice(waiterIndex, 1);
                    waiter.resolve(event.data);
                }
            }
        };
    }

    public post(request: WorkerPresentationRequest | Record<string, unknown>): void {
        this.port.postMessage(request);
    }

    /** Resolves with the first matching response from the given index on, already received or received later. */
    public waitForResponse(
        matches: (response: WorkerPresentationResponse) => boolean,
        firstResponseIndex = 0
    ): Promise<WorkerPresentationResponse> {
        const receivedResponse = this.responses.slice(firstResponseIndex).find(matches);
        if (receivedResponse) {
            return Promise.resolve(receivedResponse);
        }
        return new Promise<WorkerPresentationResponse>(resolve => {
            this.responseWaiters.push({ matches, resolve });
        });
    }

    public close(): void {
        this.port.onmessage = null;
        this.port.close();
    }
}
