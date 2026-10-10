import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    copyVideoFramePairToRawPlanes,
    type RawVideoFrameSource,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame,
    type TransferableRawVideoFramePair
} from 'webgpu-player/video/RawVideoFrameCopy';
import {
    drawRawYUVFrame,
    renderRawYUVFrame,
    uploadRawYUVFrame,
    type RawYUVTexturePresentation
} from 'webgpu-player/presentation/RawYUVGPURenderer';

type MockFunction = ReturnType<typeof vi.fn>;

type MockTextureView = {
    textureIndex: number
};

type RendererHarness = {
    bindGroupEntries: GPUBindGroupEntry[]
    device: GPUDevice
    enhancementUniformBuffer: GPUBuffer
    queueSubmit: MockFunction
    queueWriteBuffer: MockFunction
    queueWriteTexture: MockFunction
    textureDescriptors: GPUTextureDescriptor[]
    textureDestroy: MockFunction
};

const BASE_CODED_WIDTH = 160;
const BASE_CODED_HEIGHT = 4;
const ENHANCEMENT_CODED_WIDTH = 80;
const ENHANCEMENT_CODED_HEIGHT = 2;
const ENHANCEMENT_FIRST_BINDING = 6;
const ENHANCEMENT_UNIFORM_BINDING = 9;
// A planar format's luma and two chroma planes
const PLANAR_PLANE_COUNT = 3;
const FULL_FRAME_PRESENTATION: RawYUVTexturePresentation = {
    textureOffsetX: 0,
    textureOffsetY: 0,
    textureScaleX: 1,
    textureScaleY: 1,
    viewportHeight: BASE_CODED_HEIGHT,
    viewportWidth: BASE_CODED_WIDTH,
    viewportX: 0,
    viewportY: 0
};

const originalGPUBufferUsage = Object.getOwnPropertyDescriptor(globalThis, 'GPUBufferUsage');
const originalGPUTextureUsage = Object.getOwnPropertyDescriptor(globalThis, 'GPUTextureUsage');

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

function createRendererHarness(): RendererHarness {
    const bindGroupEntries: GPUBindGroupEntry[] = [];
    const textureDescriptors: GPUTextureDescriptor[] = [];
    const textureDestroy = vi.fn();
    const queueSubmit = vi.fn();
    const queueWriteBuffer = vi.fn();
    const queueWriteTexture = vi.fn();
    const renderPass = {
        draw: vi.fn(),
        end: vi.fn(),
        setBindGroup: vi.fn(),
        setPipeline: vi.fn(),
        setViewport: vi.fn()
    };
    const device = {
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => {
            bindGroupEntries.push(...descriptor.entries);
            return {};
        }),
        createCommandEncoder: vi.fn(() => ({
            beginRenderPass: vi.fn(() => renderPass),
            finish: vi.fn(() => ({}))
        })),
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
            const textureIndex = textureDescriptors.length;
            textureDescriptors.push(descriptor);
            const view: MockTextureView = { textureIndex };
            return {
                createView: vi.fn(() => view),
                destroy: textureDestroy
            };
        }),
        limits: { maxTextureDimension2D: 8_192 },
        queue: {
            submit: queueSubmit,
            writeBuffer: queueWriteBuffer,
            writeTexture: queueWriteTexture
        }
    } as unknown as GPUDevice;
    return {
        bindGroupEntries,
        device,
        enhancementUniformBuffer: { label: 'enhancement' } as unknown as GPUBuffer,
        queueSubmit,
        queueWriteBuffer,
        queueWriteTexture,
        textureDescriptors,
        textureDestroy
    };
}

/** A decoded frame whose copy returns the requested layout, as a conforming decoder does. */
function createRawFrameSource(
    format: SupportedRawVideoFrameFormat,
    codedWidth: number,
    codedHeight: number
): RawVideoFrameSource {
    return {
        close: vi.fn(),
        codedHeight,
        codedWidth,
        colorSpace: {
            fullRange: false,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            transfer: 'smpte2084'
        },
        copyTo: vi.fn(async (
            _destination: ArrayBuffer,
            options: VideoFrameCopyToOptions
        ): Promise<PlaneLayout[]> => [ ...(options.layout ?? []) ]),
        displayHeight: codedHeight,
        displayWidth: codedWidth,
        duration: 41_667,
        format,
        timestamp: 1_000_000,
        visibleRect: { height: codedHeight, width: codedWidth, x: 0, y: 0 }
    };
}

/** Copies a BL in format and an I420P10 EL through the production pair copy. */
function copyRawFramePair(format: SupportedRawVideoFrameFormat, includeEnhancementFrame = true): Promise<TransferableRawVideoFramePair> {
    return copyVideoFramePairToRawPlanes(
        createRawFrameSource(format, BASE_CODED_WIDTH, BASE_CODED_HEIGHT),
        includeEnhancementFrame ?
            createRawFrameSource('I420P10', ENHANCEMENT_CODED_WIDTH, ENHANCEMENT_CODED_HEIGHT) :
            null,
        {
            enhancementExpectedGeometry: {
                codedHeight: ENHANCEMENT_CODED_HEIGHT,
                codedWidth: ENHANCEMENT_CODED_WIDTH,
                displayHeight: ENHANCEMENT_CODED_HEIGHT,
                displayWidth: ENHANCEMENT_CODED_WIDTH
            },
            format
        }
    );
}

function renderRawFramePair(
    harness: RendererHarness,
    frame: TransferableRawVideoFrame,
    enhancementFrame: TransferableRawVideoFrame | null
): ReturnType<typeof renderRawYUVFrame> {
    return renderRawYUVFrame({
        device: harness.device,
        dolbyVisionEnhancementUniformBuffer: harness.enhancementUniformBuffer,
        dolbyVisionRPUStorageBuffer: { label: 'rpu' } as unknown as GPUBuffer,
        enhancementFrame,
        enhancementTextureSet: null,
        frame,
        pipeline: {
            getBindGroupLayout: vi.fn(() => ({}))
        } as unknown as GPURenderPipeline,
        presentation: FULL_FRAME_PRESENTATION,
        presentationUniformBuffer: { label: 'presentation' } as unknown as GPUBuffer,
        renderSettingsUniformBuffer: { label: 'settings' } as unknown as GPUBuffer,
        targetView: {} as GPUTextureView,
        textureSet: null
    });
}

function getTextureSizes(descriptors: readonly GPUTextureDescriptor[]): Array<[number, number]> {
    return descriptors.map((descriptor: GPUTextureDescriptor): [number, number] => {
        const size = descriptor.size as GPUExtent3DDict;
        return [ size.width, size.height ?? 1 ];
    });
}

function getBoundTextureIndex(bindGroupEntries: readonly GPUBindGroupEntry[], binding: number): number | undefined {
    const entry = bindGroupEntries.find(candidate => candidate.binding === binding);
    return (entry?.resource as MockTextureView | undefined)?.textureIndex;
}

function getEnhancementUniformWrite(harness: RendererHarness): Uint32Array | undefined {
    const uniformWrite = harness.queueWriteBuffer.mock.calls.find((call: unknown[]) => call[0] === harness.enhancementUniformBuffer);
    return uniformWrite?.[2] as Uint32Array | undefined;
}

describe('renderRawYUVFrame Dolby Vision pairs', () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, 'GPUBufferUsage', {
            configurable: true,
            // WebGPU defines these external names
            // eslint-disable-next-line @typescript-eslint/naming-convention
            value: { COPY_DST: 8, STORAGE: 128, UNIFORM: 64 }
        });
        Object.defineProperty(globalThis, 'GPUTextureUsage', {
            configurable: true,
            // WebGPU defines these external names
            // eslint-disable-next-line @typescript-eslint/naming-convention
            value: { COPY_DST: 2, TEXTURE_BINDING: 4 }
        });
    });

    afterEach(() => {
        restoreProperty(globalThis, 'GPUBufferUsage', originalGPUBufferUsage);
        restoreProperty(globalThis, 'GPUTextureUsage', originalGPUTextureUsage);
    });

    it.each([
        [ 'I420', 'r8uint', [ [ 160, 4 ], [ 80, 2 ], [ 80, 2 ] ] ],
        [ 'I422P10', 'r16uint', [ [ 160, 4 ], [ 80, 4 ], [ 80, 4 ] ] ],
        [ 'I444P12', 'r16uint', [ [ 160, 4 ], [ 160, 4 ], [ 160, 4 ] ] ]
    ] as const)(
        'uploads a %s BL in its own format and binds its I420P10 EL',
        async (format, baseTextureFormat, baseTextureSizes) => {
            const harness = createRendererHarness();
            const { baseFrame, enhancementFrame } = await copyRawFramePair(format);

            const result = renderRawFramePair(harness, baseFrame, enhancementFrame);

            expect(result.textureSet.format).toBe(format);
            expect(result.enhancementTextureSet?.format).toBe('I420P10');
            expect(harness.textureDescriptors.map(descriptor => descriptor.format)).toEqual([
                baseTextureFormat,
                baseTextureFormat,
                baseTextureFormat,
                'r16uint',
                'r16uint',
                'r16uint'
            ]);
            expect(getTextureSizes(harness.textureDescriptors)).toEqual([
                ...baseTextureSizes,
                [ 80, 2 ],
                [ 40, 1 ],
                [ 40, 1 ]
            ]);
            const uploadedPlaneOffsets = harness.queueWriteTexture.mock.calls.map(
                (call: unknown[]) => (call[2] as GPUTexelCopyBufferLayout).offset
            );
            expect(uploadedPlaneOffsets).toEqual([
                ...baseFrame.planes.map(plane => plane.byteOffset),
                ...(enhancementFrame?.planes.map(plane => plane.byteOffset) ?? [])
            ]);
            expect(harness.queueWriteTexture.mock.calls.every((call: unknown[]) => call[1] === baseFrame.data)).toBe(true);
            for (let planeIndex = 0; planeIndex < 3; planeIndex += 1) {
                expect(getBoundTextureIndex(harness.bindGroupEntries, planeIndex + 1)).toBe(planeIndex);
                expect(getBoundTextureIndex(harness.bindGroupEntries, ENHANCEMENT_FIRST_BINDING + planeIndex)).toBe(planeIndex + 3);
            }
            expect(harness.bindGroupEntries.map(entry => entry.binding)).toEqual([
                0, 1, 2, 3, 4, 5, 6, 7, 8, ENHANCEMENT_UNIFORM_BINDING
            ]);
            expect(Array.from(getEnhancementUniformWrite(harness) ?? [])).toEqual([ 1, 0, 0, 0 ]);
            expect(harness.queueSubmit).toHaveBeenCalledOnce();
        }
    );

    it('fills the unsampled EL bindings with the 8-bit BL planes when the EL is absent', async () => {
        const harness = createRendererHarness();
        const { baseFrame, enhancementFrame } = await copyRawFramePair('I420', false);

        const result = renderRawFramePair(harness, baseFrame, enhancementFrame);

        expect(result.enhancementTextureSet).toBeNull();
        expect(harness.textureDescriptors.map(descriptor => descriptor.format)).toEqual([
            'r8uint',
            'r8uint',
            'r8uint'
        ]);
        for (let planeIndex = 0; planeIndex < 3; planeIndex += 1) {
            expect(getBoundTextureIndex(harness.bindGroupEntries, ENHANCEMENT_FIRST_BINDING + planeIndex)).toBe(planeIndex);
        }
        expect(Array.from(getEnhancementUniformWrite(harness) ?? [])).toEqual([ 0, 0, 0, 0 ]);
    });

    it('draws an uploaded pair without uploading it again, and presents its BL alone when its EL is not composed', async () => {
        const harness = createRendererHarness();
        const { baseFrame, enhancementFrame } = await copyRawFramePair('I420P10');
        const uploadResult = uploadRawYUVFrame({
            device: harness.device,
            enhancementFrame,
            frame: baseFrame,
            textureSet: null
        });
        const uploadCount = harness.queueWriteTexture.mock.calls.length;

        drawRawYUVFrame({
            device: harness.device,
            dolbyVisionEnhancementUniformBuffer: harness.enhancementUniformBuffer,
            dolbyVisionRPUStorageBuffer: { label: 'rpu' } as unknown as GPUBuffer,
            enhancementTextureSet: null,
            frame: baseFrame,
            pipeline: {
                getBindGroupLayout: vi.fn(() => ({}))
            } as unknown as GPURenderPipeline,
            presentation: FULL_FRAME_PRESENTATION,
            presentationUniformBuffer: { label: 'presentation' } as unknown as GPUBuffer,
            renderSettingsUniformBuffer: { label: 'settings' } as unknown as GPUBuffer,
            targetView: {} as GPUTextureView,
            textureSet: uploadResult.textureSet
        });

        expect(uploadResult.enhancementTextureSet?.format).toBe('I420P10');
        expect(harness.queueWriteTexture).toHaveBeenCalledTimes(uploadCount);
        for (let planeIndex = 0; planeIndex < PLANAR_PLANE_COUNT; planeIndex += 1) {
            expect(getBoundTextureIndex(harness.bindGroupEntries, ENHANCEMENT_FIRST_BINDING + planeIndex)).toBe(planeIndex);
        }
        expect(Array.from(getEnhancementUniformWrite(harness) ?? [])).toEqual([ 0, 0, 0, 0 ]);
        expect(harness.queueSubmit).toHaveBeenCalledOnce();
    });

    it('refuses an EL in another format and releases the textures it created', async () => {
        const harness = createRendererHarness();
        const { baseFrame } = await copyRawFramePair('I422P10', false);

        // The BL itself is a valid I422P10 layout in the shared buffer, but no EL binding samples 4:2:2
        expect(() => renderRawFramePair(harness, baseFrame, baseFrame)).toThrow(
            'Raw Dolby Vision enhancement frame layout is invalid'
        );
        expect(harness.textureDescriptors).toHaveLength(3);
        expect(harness.textureDestroy).toHaveBeenCalledTimes(3);
        expect(harness.queueSubmit).not.toHaveBeenCalled();
    });
});
