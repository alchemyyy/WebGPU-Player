import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createPlaneTextureSet,
    destroyPlaneTextureSet,
    getRawPlaneLayoutFailure,
    hasValidRawPlaneLayout,
    isPlaneTextureSetCompatible,
    uploadPlanes
} from 'webgpu-player/presentation/passes/PlaneTextureSource';
import {
    copyVideoFrameToRawPlanes,
    RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT,
    type RawVideoFrameRectangle,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from 'webgpu-player/decode/video/RawVideoFrameCopy';

type MockFunction = ReturnType<typeof vi.fn>;

type TextureHarness = {
    createTexture: MockFunction
    device: GPUDevice
    textureDestroy: MockFunction
    writeTexture: MockFunction
};

// WebGPU's flag values, which jsdom does not define
// eslint-disable-next-line @typescript-eslint/naming-convention
const GPU_TEXTURE_USAGE = { COPY_DST: 2, TEXTURE_BINDING: 4 } as const;

const CODED_WIDTH = 64;
const CODED_HEIGHT = 40;
const FULL_RECTANGLE: RawVideoFrameRectangle = { height: CODED_HEIGHT, width: CODED_WIDTH, x: 0, y: 0 };
// Chroma-aligned for 4:2:0, inside the coded size
const INSET_RECTANGLE: RawVideoFrameRectangle = { height: 36, width: 56, x: 4, y: 2 };
// An odd origin, which no 4:2:0 chroma sample starts at
const CHROMA_MISALIGNED_RECTANGLE: RawVideoFrameRectangle = { height: 36, width: 56, x: 3, y: 2 };
const OVERFLOWING_RECTANGLE: RawVideoFrameRectangle = { height: CODED_HEIGHT, width: CODED_WIDTH, x: 2, y: 0 };
const UNALIGNED_BYTE_OFFSET = 16;
const PLANE_GAP_BYTE_LENGTH = RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT;
// A device limit below the coded width
const SMALL_TEXTURE_DIMENSION = 32;
const DEVICE_TEXTURE_DIMENSION = 8_192;
const TEXTURE_LABEL = 'Test planes';
const TEXTURE_CREATION_FAILURE = 'Texture creation failed';
const TIMESTAMP_MICROSECONDS = 1_000_000;
const FRAME_DURATION_MICROSECONDS = 41_667;

const originalGPUTextureUsage = Object.getOwnPropertyDescriptor(globalThis, 'GPUTextureUsage');

function restoreProperty(target: object, propertyName: string, descriptor: PropertyDescriptor | undefined): void {
    if (descriptor) {
        Object.defineProperty(target, propertyName, descriptor);
    } else {
        Reflect.deleteProperty(target, propertyName);
    }
}

function createTextureHarness(maximumTextureDimension = DEVICE_TEXTURE_DIMENSION): TextureHarness {
    const textureDestroy = vi.fn();
    const createTexture = vi.fn((descriptor: GPUTextureDescriptor) => ({
        createView: vi.fn(() => ({ label: descriptor.label })),
        destroy: textureDestroy,
        label: descriptor.label
    }));
    const writeTexture = vi.fn();
    const device = {
        createTexture,
        limits: { maxTextureDimension2D: maximumTextureDimension },
        queue: { writeTexture }
    } as unknown as GPUDevice;
    return { createTexture, device, textureDestroy, writeTexture };
}

/** Copies a frame through the production copy, which writes the exact padded layout. */
function copyFrame(format: SupportedRawVideoFrameFormat, visibleRectangle = FULL_RECTANGLE): Promise<TransferableRawVideoFrame> {
    return copyVideoFrameToRawPlanes({
        close: vi.fn(),
        codedHeight: CODED_HEIGHT,
        codedWidth: CODED_WIDTH,
        colorSpace: { fullRange: false, matrix: 'bt709', primaries: 'bt709', transfer: 'bt709' },
        copyTo: vi.fn(async (_destination: ArrayBuffer, options: VideoFrameCopyToOptions): Promise<PlaneLayout[]> => [
            ...(options.layout ?? [])
        ]),
        displayHeight: visibleRectangle.height,
        displayWidth: visibleRectangle.width,
        duration: FRAME_DURATION_MICROSECONDS,
        format,
        timestamp: TIMESTAMP_MICROSECONDS,
        visibleRect: visibleRectangle
    });
}

function shiftPlanes(frame: TransferableRawVideoFrame, byteOffset: number, firstShiftedPlane: number): TransferableRawVideoFrame {
    return {
        ...frame,
        data: new ArrayBuffer(frame.data.byteLength + byteOffset),
        planes: frame.planes.map((plane, planeIndex) => (
            planeIndex >= firstShiftedPlane ? { ...plane, byteOffset: plane.byteOffset + byteOffset } : plane
        ))
    };
}

describe('hasValidRawPlaneLayout', () => {
    it.each([ 'I420', 'I420P10', 'I422', 'I444P12', 'NV12' ] as const)('accepts the production copy of %s', async format => {
        expect(hasValidRawPlaneLayout(await copyFrame(format))).toBe(true);
    });

    it('accepts a chroma-aligned visible rectangle inside the coded frame', async () => {
        expect(hasValidRawPlaneLayout(await copyFrame('I420', INSET_RECTANGLE))).toBe(true);
    });

    it('refuses visible rectangles that leave the coded frame or split a chroma sample, naming the failed check', async () => {
        const frame = await copyFrame('I420');

        expect(hasValidRawPlaneLayout({ ...frame, visibleRectangle: OVERFLOWING_RECTANGLE })).toBe(false);
        expect(getRawPlaneLayoutFailure({ ...frame, visibleRectangle: OVERFLOWING_RECTANGLE })).toMatch(/^geometry: visible .* exceeds coded /);
        expect(getRawPlaneLayoutFailure({ ...frame, visibleRectangle: CHROMA_MISALIGNED_RECTANGLE })).toMatch(/^geometry: visible origin .* is not chroma-aligned for I420$/);
    });

    it('refuses planes that are unaligned, apart, missing, reordered, or past the buffer, naming the failed check', async () => {
        const frame = await copyFrame('I420');
        const [ lumaPlane, chromaUPlane, chromaVPlane ] = frame.planes;

        expect(getRawPlaneLayoutFailure(shiftPlanes(frame, UNALIGNED_BYTE_OFFSET, 0))).toMatch(/^plane-offset: \d+ is not a multiple of \d+$/);
        expect(getRawPlaneLayoutFailure(shiftPlanes(frame, PLANE_GAP_BYTE_LENGTH, 1))).toMatch(/^plane u: byteOffset \d+, expected \d+$/);
        expect(getRawPlaneLayoutFailure({ ...frame, planes: [ lumaPlane, chromaUPlane ] })).toBe('plane-count: 2, expected 3');
        expect(getRawPlaneLayoutFailure({ ...frame, planes: [ lumaPlane, { ...chromaVPlane, byteOffset: chromaUPlane.byteOffset }, chromaUPlane ] }))
            .toBe('plane u: kind v, expected u');
        expect(getRawPlaneLayoutFailure({ ...frame, data: new ArrayBuffer(frame.data.byteLength - 1) })).toMatch(/^buffer-length: planes end at \d+, buffer holds \d+$/);
    });

    it('accepts planes shifted together to an aligned offset', async () => {
        const frame = await copyFrame('I420P10');

        expect(hasValidRawPlaneLayout(shiftPlanes(frame, RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT, 0))).toBe(true);
    });
});

describe('plane texture sets', () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, 'GPUTextureUsage', { configurable: true, value: GPU_TEXTURE_USAGE });
    });

    afterEach(() => {
        restoreProperty(globalThis, 'GPUTextureUsage', originalGPUTextureUsage);
    });

    it.each([
        [ 'I420', [ 'r8uint', 'r8uint', 'r8uint' ] ],
        [ 'NV12', [ 'r8uint', 'rg8uint' ] ],
        [ 'I422P10', [ 'r16uint', 'r16uint', 'r16uint' ] ]
    ] as const)('creates %s planes as integer textures', async (format, textureFormats) => {
        const harness = createTextureHarness();
        const frame = await copyFrame(format);

        const textureSet = createPlaneTextureSet(harness.device, frame, TEXTURE_LABEL);

        const descriptors = harness.createTexture.mock.calls.map((call: unknown[]) => call[0] as GPUTextureDescriptor);
        expect(descriptors.map(descriptor => descriptor.format)).toEqual(textureFormats);
        expect(descriptors.map(descriptor => descriptor.size)).toEqual(frame.planes.map(plane => ({ height: plane.height, width: plane.width })));
        expect(descriptors.every(descriptor => descriptor.usage === (GPU_TEXTURE_USAGE.COPY_DST | GPU_TEXTURE_USAGE.TEXTURE_BINDING))).toBe(true);
        expect(descriptors[0].label).toBe(`${TEXTURE_LABEL} Y plane`);
        expect(textureSet.planes.map(plane => plane.kind)).toEqual(frame.planes.map(plane => plane.kind));
        expect(isPlaneTextureSetCompatible(textureSet, frame)).toBe(true);
    });

    it('reports a set incompatible with another format or coded size', async () => {
        const harness = createTextureHarness();
        const frame = await copyFrame('I420');
        const textureSet = createPlaneTextureSet(harness.device, frame, TEXTURE_LABEL);

        expect(isPlaneTextureSetCompatible(null, frame)).toBe(false);
        expect(isPlaneTextureSetCompatible(textureSet, { ...frame, format: 'I420P10' })).toBe(false);
        expect(isPlaneTextureSetCompatible(textureSet, { ...frame, codedWidth: CODED_WIDTH * 2 })).toBe(false);
    });

    it('refuses planes beyond the device texture limit', async () => {
        const harness = createTextureHarness(SMALL_TEXTURE_DIMENSION);
        const frame = await copyFrame('I420');

        expect(() => createPlaneTextureSet(harness.device, frame, TEXTURE_LABEL)).toThrow(RangeError);
        expect(harness.createTexture).not.toHaveBeenCalled();
    });

    it('destroys the textures it created when a later plane fails', async () => {
        const harness = createTextureHarness();
        const frame = await copyFrame('I420');
        const createTexture = harness.createTexture.getMockImplementation();
        harness.createTexture.mockImplementation((descriptor: GPUTextureDescriptor) => {
            if (harness.createTexture.mock.calls.length > 1) {
                throw new Error(TEXTURE_CREATION_FAILURE);
            }
            return createTexture?.(descriptor);
        });

        expect(() => createPlaneTextureSet(harness.device, frame, TEXTURE_LABEL)).toThrow(TEXTURE_CREATION_FAILURE);
        expect(harness.textureDestroy).toHaveBeenCalledOnce();
    });

    it('uploads every plane from the frame buffer at its offset and row pitch, and destroys the set', async () => {
        const harness = createTextureHarness();
        const frame = await copyFrame('I420P10');
        const textureSet = createPlaneTextureSet(harness.device, frame, TEXTURE_LABEL);

        uploadPlanes(harness.device, textureSet, frame);
        destroyPlaneTextureSet(textureSet);

        expect(harness.writeTexture.mock.calls).toEqual(frame.planes.map((plane, planeIndex) => [
            { texture: textureSet.planes[planeIndex].texture },
            frame.data,
            { bytesPerRow: plane.bytesPerRow, offset: plane.byteOffset, rowsPerImage: plane.height },
            { height: plane.height, width: plane.width }
        ]));
        expect(harness.textureDestroy).toHaveBeenCalledTimes(frame.planes.length);
    });
});
