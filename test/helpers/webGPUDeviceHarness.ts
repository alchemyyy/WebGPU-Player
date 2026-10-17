// A mock GPUDevice for the presentation executor, the authorization readbacks, and the presenter.
// It validates nothing; it records what the code under test asks of the device, and serves readbacks from a test callback.
import { vi, type Mock } from 'vitest';

import type { ColorTriplet } from 'webgpu-player/color/ColorPipeline';

type MockFunction = Mock;

type Float16DataView = DataView & {
    setFloat16: (byteOffset: number, value: number, littleEndian?: boolean) => void
};

export type Deferred<Value> = {
    promise: Promise<Value>
    reject: (error: unknown) => void
    resolve: (value: Value) => void
};

export type MockGPUBuffer = {
    bytes: Uint8Array
    descriptor: GPUBufferDescriptor
    destroy: MockFunction
    getMappedRange: MockFunction
    label: string
    mapAsync: MockFunction
    size: number
    unmap: MockFunction
    usage: number
};

export type MockGPUTextureView = {
    label: string
    texture: MockGPUTexture
};

export type MockGPUTexture = {
    createView: MockFunction
    depthOrArrayLayers: number
    descriptor: GPUTextureDescriptor
    destroy: MockFunction
    format: GPUTextureFormat
    height: number
    label: string
    usage: number
    width: number
};

export type MockGPUShaderModule = {
    descriptor: GPUShaderModuleDescriptor
    getCompilationInfo: () => Promise<{ messages: GPUCompilationMessage[] }>
};

export type MockGPURenderPipeline = {
    descriptor: GPURenderPipelineDescriptor
    getBindGroupLayout: MockFunction
};

export type RecordedBufferWrite = {
    buffer: MockGPUBuffer
    bufferOffset: number
    bytes: Uint8Array
};

export type RecordedTextureWrite = {
    data: unknown
    dataLayout: GPUTexelCopyBufferLayout
    size: GPUExtent3D
    texture: MockGPUTexture
};

export type RecordedRenderPass = {
    bindGroup: unknown
    descriptor: GPURenderPassDescriptor
    drawVertexCounts: number[]
    pipeline: unknown
    viewport: readonly number[] | null
};

/** One texel a readback copies; renderPassCount counts every render pass encoded on the device so far. */
export type ReadbackTexel = {
    renderPassCount: number
    sampleX: number
    sampleY: number
    texture: MockGPUTexture
};

/** Returns the linear RGB a readback finds at a texel, or undefined for a texel the test does not expect to read. */
export type ReadbackSource = (texel: ReadbackTexel) => ColorTriplet | undefined;

export type WebGPUDeviceHarnessOptions = {
    mapAsync?: () => Promise<void>
    maximumTextureDimension?: number
    readPixel?: ReadbackSource
};

export type WebGPUDeviceHarness = {
    bufferWrites: RecordedBufferWrite[]
    buffers: MockGPUBuffer[]
    /** The compile messages each new shader module reports; tests replace it to fail compilation */
    compileMessages: (descriptor: GPUShaderModuleDescriptor) => GPUCompilationMessage[]
    createBindGroup: MockFunction
    createBindGroupLayout: MockFunction
    createBuffer: MockFunction
    createComputePipelineAsync: MockFunction
    createRenderPipelineAsync: MockFunction
    createSampler: MockFunction
    createShaderModule: MockFunction
    createTexture: MockFunction
    destroy: MockFunction
    device: GPUDevice
    dispatchUncapturedError: (error: GPUError) => boolean
    importExternalTexture: MockFunction
    lost: Deferred<GPUDeviceLostInfo>
    popErrorScope: MockFunction
    pushErrorScope: MockFunction
    queueOnSubmittedWorkDone: MockFunction
    queueSubmit: MockFunction
    queueWriteBuffer: MockFunction
    queueWriteTexture: MockFunction
    renderPassSetViewport: MockFunction
    renderPasses: RecordedRenderPass[]
    textureDestroy: MockFunction
    textureWrites: RecordedTextureWrite[]
    textures: MockGPUTexture[]
};

export const DEFAULT_MAXIMUM_TEXTURE_DIMENSION = 8_192;

const OPAQUE_ALPHA = 1;
const UNORM8_MAXIMUM = 255;
const FLOAT16_BYTE_LENGTH = 2;

// WebGPU's flag values, which jsdom does not define
const WEBGPU_GLOBALS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    GPUBufferUsage: { COPY_DST: 8, COPY_SRC: 4, INDEX: 16, INDIRECT: 256, MAP_READ: 1, MAP_WRITE: 2, QUERY_RESOLVE: 512, STORAGE: 128, UNIFORM: 64, VERTEX: 32 },
    GPUMapMode: { READ: 1, WRITE: 2 },
    GPUShaderStage: { COMPUTE: 4, FRAGMENT: 2, VERTEX: 1 },
    // eslint-disable-next-line @typescript-eslint/naming-convention
    GPUTextureUsage: { COPY_DST: 2, COPY_SRC: 1, RENDER_ATTACHMENT: 16, STORAGE_BINDING: 8, TEXTURE_BINDING: 4 }
};

/** Defines WebGPU's flag globals and returns the function that restores the previous globals. */
export function installWebGPUGlobals(): () => void {
    const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
    for (const [ name, value ] of Object.entries(WEBGPU_GLOBALS)) {
        originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, value });
    }
    return (): void => {
        for (const [ name, descriptor ] of originalDescriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    };
}

export function createDeferred<Value>(): Deferred<Value> {
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

function getExtentDimension(size: GPUExtent3D, dimension: 'height' | 'width'): number {
    if (Symbol.iterator in Object(size)) {
        const values = [ ...(size as Iterable<number>) ];
        return dimension === 'width' ? values[0] ?? 1 : values[1] ?? 1;
    }
    return Number((size as GPUExtent3DDict)[dimension] ?? 1);
}

function toUnorm8(value: number): number {
    return Math.round(Math.min(Math.max(value, 0), 1) * UNORM8_MAXIMUM);
}

/** Writes one texel of a readback in the copied texture's format. */
function writeReadbackTexel(buffer: MockGPUBuffer, byteOffset: number, format: GPUTextureFormat, linearRGB: ColorTriplet): void {
    switch (format) {
        case 'bgra8unorm':
            buffer.bytes.set([ toUnorm8(linearRGB[2]), toUnorm8(linearRGB[1]), toUnorm8(linearRGB[0]), UNORM8_MAXIMUM ], byteOffset);
            return;
        case 'rgba8unorm':
            buffer.bytes.set([ toUnorm8(linearRGB[0]), toUnorm8(linearRGB[1]), toUnorm8(linearRGB[2]), UNORM8_MAXIMUM ], byteOffset);
            return;
        case 'rgba16float': {
            const view = new DataView(buffer.bytes.buffer, buffer.bytes.byteOffset, buffer.bytes.byteLength) as Float16DataView;
            const components = [ linearRGB[0], linearRGB[1], linearRGB[2], OPAQUE_ALPHA ];
            for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
                view.setFloat16(byteOffset + (componentIndex * FLOAT16_BYTE_LENGTH), components[componentIndex], true);
            }
            return;
        }
        default:
            throw new Error(`The mock readback does not encode ${format}`);
    }
}

/** Creates a mock device whose resources record their descriptors and whose queue records every write. */
export function createWebGPUDeviceHarness(options: WebGPUDeviceHarnessOptions = {}): WebGPUDeviceHarness {
    const deviceEventTarget = new EventTarget();
    const lost = createDeferred<GPUDeviceLostInfo>();
    const bufferWrites: RecordedBufferWrite[] = [];
    const buffers: MockGPUBuffer[] = [];
    const textures: MockGPUTexture[] = [];
    const textureWrites: RecordedTextureWrite[] = [];
    const renderPasses: RecordedRenderPass[] = [];
    const textureDestroy = vi.fn();
    const renderPassSetViewport = vi.fn();
    const harness = {} as WebGPUDeviceHarness;
    harness.compileMessages = (): GPUCompilationMessage[] => [];

    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor): MockGPUBuffer => {
        const bytes = new Uint8Array(Number(descriptor.size));
        const buffer: MockGPUBuffer = {
            bytes,
            descriptor,
            destroy: vi.fn(),
            getMappedRange: vi.fn((offset = 0, size = bytes.byteLength) => bytes.buffer.slice(offset, offset + size)),
            label: descriptor.label ?? '',
            mapAsync: vi.fn(() => options.mapAsync?.() ?? Promise.resolve()),
            size: Number(descriptor.size),
            unmap: vi.fn(),
            usage: descriptor.usage
        };
        buffers.push(buffer);
        return buffer;
    });
    const createTexture = vi.fn((descriptor: GPUTextureDescriptor): MockGPUTexture => {
        const label = descriptor.label ?? '';
        const texture = {
            depthOrArrayLayers: 1,
            descriptor,
            // Each texture records its own destruction, and textureDestroy counts every texture's
            destroy: vi.fn((): void => {
                textureDestroy();
            }),
            format: descriptor.format,
            height: getExtentDimension(descriptor.size, 'height'),
            label,
            usage: descriptor.usage,
            width: getExtentDimension(descriptor.size, 'width')
        } as MockGPUTexture;
        texture.createView = vi.fn((): MockGPUTextureView => ({ label, texture }));
        textures.push(texture);
        return texture;
    });
    const createShaderModule = vi.fn((descriptor: GPUShaderModuleDescriptor): MockGPUShaderModule => ({
        descriptor,
        getCompilationInfo: () => Promise.resolve({ messages: harness.compileMessages(descriptor) })
    }));
    const createRenderPipelineAsync = vi.fn((descriptor: GPURenderPipelineDescriptor) => Promise.resolve({
        descriptor,
        getBindGroupLayout: vi.fn(() => ({}))
    } as MockGPURenderPipeline));
    const createComputePipelineAsync = vi.fn((descriptor: GPUComputePipelineDescriptor) => Promise.resolve({ descriptor }));
    const createBindGroup = vi.fn((descriptor: GPUBindGroupDescriptor) => ({ descriptor }));
    const createBindGroupLayout = vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => ({ descriptor }));
    const createSampler = vi.fn((descriptor?: GPUSamplerDescriptor) => ({ descriptor }));
    const importExternalTexture = vi.fn((descriptor: GPUExternalTextureDescriptor) => ({ descriptor }));
    const queueSubmit = vi.fn();
    const queueOnSubmittedWorkDone = vi.fn(() => Promise.resolve());
    const queueWriteBuffer = vi.fn((
        buffer: MockGPUBuffer,
        bufferOffset: number,
        data: ArrayBuffer | ArrayBufferView,
        dataOffset = 0,
        size?: number
    ): void => {
        const source = ArrayBuffer.isView(data) ?
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength) :
            new Uint8Array(data);
        const elementByteLength = ArrayBuffer.isView(data) && 'BYTES_PER_ELEMENT' in data ? Number(data.BYTES_PER_ELEMENT) : 1;
        const byteOffset = dataOffset * elementByteLength;
        const byteLength = size === undefined ? source.byteLength - byteOffset : size * elementByteLength;
        const bytes = source.slice(byteOffset, byteOffset + byteLength);
        bufferWrites.push({ buffer, bufferOffset, bytes });
    });
    const queueWriteTexture = vi.fn((
        destination: GPUTexelCopyTextureInfo,
        data: unknown,
        dataLayout: GPUTexelCopyBufferLayout,
        size: GPUExtent3D
    ): void => {
        textureWrites.push({ data, dataLayout, size, texture: destination.texture as unknown as MockGPUTexture });
    });

    const createCommandEncoder = vi.fn(() => ({
        beginComputePass: vi.fn(() => ({
            dispatchWorkgroups: vi.fn(),
            dispatchWorkgroupsIndirect: vi.fn(),
            end: vi.fn(),
            setBindGroup: vi.fn(),
            setPipeline: vi.fn()
        })),
        beginRenderPass: vi.fn((descriptor: GPURenderPassDescriptor) => {
            const renderPass: RecordedRenderPass = {
                bindGroup: null,
                descriptor,
                drawVertexCounts: [],
                pipeline: null,
                viewport: null
            };
            renderPasses.push(renderPass);
            return {
                draw: vi.fn((vertexCount: number): void => {
                    renderPass.drawVertexCounts.push(vertexCount);
                }),
                end: vi.fn(),
                setBindGroup: vi.fn((_index: number, bindGroup: unknown): void => {
                    renderPass.bindGroup = bindGroup;
                }),
                setPipeline: vi.fn((pipeline: unknown): void => {
                    renderPass.pipeline = pipeline;
                }),
                setViewport: vi.fn((...viewport: number[]): void => {
                    renderPass.viewport = viewport;
                    renderPassSetViewport(...viewport);
                })
            };
        }),
        copyTextureToBuffer: vi.fn((source: GPUTexelCopyTextureInfo, destination: GPUTexelCopyBufferInfo): void => {
            const origin = (source.origin ?? {}) as GPUOrigin3DDict;
            const texture = source.texture as unknown as MockGPUTexture;
            const sampleX = Number(origin.x ?? 0);
            const sampleY = Number(origin.y ?? 0);
            const linearRGB = options.readPixel?.({ renderPassCount: renderPasses.length, sampleX, sampleY, texture });
            if (!linearRGB) {
                throw new Error(`Unexpected readback of ${texture.label} at (${sampleX}, ${sampleY})`);
            }
            writeReadbackTexel(destination.buffer as unknown as MockGPUBuffer, Number(destination.offset ?? 0), texture.format, linearRGB);
        }),
        finish: vi.fn(() => ({}))
    }));
    const destroy = vi.fn();
    const popErrorScope = vi.fn(() => Promise.resolve(null));
    const pushErrorScope = vi.fn();
    const device = {
        addEventListener: deviceEventTarget.addEventListener.bind(deviceEventTarget),
        createBindGroup,
        createBindGroupLayout,
        createBuffer,
        createCommandEncoder,
        createComputePipelineAsync,
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => ({ descriptor })),
        createRenderPipelineAsync,
        createSampler,
        createShaderModule,
        createTexture,
        destroy,
        features: new Set<GPUFeatureName>(),
        importExternalTexture,
        label: '',
        limits: { maxTextureDimension2D: options.maximumTextureDimension ?? DEFAULT_MAXIMUM_TEXTURE_DIMENSION },
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

    Object.assign(harness, {
        bufferWrites,
        buffers,
        createBindGroup,
        createBindGroupLayout,
        createBuffer,
        createComputePipelineAsync,
        createRenderPipelineAsync,
        createSampler,
        createShaderModule,
        createTexture,
        destroy,
        device,
        dispatchUncapturedError: (error: GPUError): boolean => {
            const event = new Event('uncapturederror', { cancelable: true });
            Object.defineProperty(event, 'error', { value: error });
            return deviceEventTarget.dispatchEvent(event);
        },
        importExternalTexture,
        lost,
        popErrorScope,
        pushErrorScope,
        queueOnSubmittedWorkDone,
        queueSubmit,
        queueWriteBuffer,
        queueWriteTexture,
        renderPassSetViewport,
        renderPasses,
        textureDestroy,
        textureWrites,
        textures
    });
    return harness;
}

/** Returns the writes to the buffers with a label, in queue order. */
export function getBufferWrites(harness: WebGPUDeviceHarness, label: string): RecordedBufferWrite[] {
    return harness.bufferWrites.filter((write: RecordedBufferWrite): boolean => write.buffer.label === label);
}

/** Returns the buffers created with a label, in creation order. */
export function getBuffers(harness: WebGPUDeviceHarness, label: string): MockGPUBuffer[] {
    return harness.buffers.filter((buffer: MockGPUBuffer): boolean => buffer.label === label);
}

/** Returns the textures whose label starts with a prefix, in creation order. */
export function getTextures(harness: WebGPUDeviceHarness, labelPrefix: string): MockGPUTexture[] {
    return harness.textures.filter((texture: MockGPUTexture): boolean => texture.label.startsWith(labelPrefix));
}

/** Returns the shader code of every module created on the device, in creation order. */
export function getShaderCodes(harness: WebGPUDeviceHarness): string[] {
    return harness.createShaderModule.mock.calls.map((call: unknown[]): string => (call[0] as GPUShaderModuleDescriptor).code);
}
