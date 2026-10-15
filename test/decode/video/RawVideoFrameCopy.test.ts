import { describe, expect, it, vi } from 'vitest';

import RawFrameBufferPool, {
    MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH
} from 'webgpu-player/decode/video/RawFrameBufferPool';
import {
    copyVideoFramePairToRawPlanes,
    copyVideoFrameToRawPlanes,
    getRawFormatBitDepth,
    getRawVideoFramePairTransferList,
    getRawVideoFrameTransferList,
    hasRawVideoFrameCopyLayout,
    isRawDolbyVisionVideoFrameFormat,
    RAW_VIDEO_DOLBY_VISION_FRAME_LAYER_COUNT,
    RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT,
    RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT,
    type RawVideoFrameCopyError,
    type SupportedRawVideoFrameFormat
} from 'webgpu-player/decode/video/RawVideoFrameCopy';
import { getRawPlaneLayoutFailure } from 'webgpu-player/presentation/passes/PlaneTextureSource';

type MockFunction = ReturnType<typeof vi.fn>;

// The default 4x2 I420 frame takes one aligned row for each of its four plane rows
const DEFAULT_FRAME_COPY_BYTE_LENGTH = 1_024;
const MISMATCHED_SPARE_BYTE_LENGTH = 512;
const ALLOCATION_FAILURE_MESSAGE = 'Array buffer allocation failed';
// The spec rejects any non-RGB format in copy options, even the frame's own
const EXPLICIT_PLANAR_FORMAT_REJECTION_MESSAGE = 'I420P10 is unsupported in ParseVideoFrameCopyToOptions';
// What a layout check reports for a pair copy that returned no EL
const MISSING_ENHANCEMENT_FRAME_DETAIL = 'enhancement-frame: null';
// Each format's code bit depth, and whether RPU reconstruction samples it; semi-planar NV12 has no RPU route
const RAW_FORMAT_FACTS: readonly (readonly [SupportedRawVideoFrameFormat, number, boolean])[] = [
    [ 'I420', 8, true ],
    [ 'I420P10', 10, true ],
    [ 'I420P12', 12, true ],
    [ 'I422', 8, true ],
    [ 'I422P10', 10, true ],
    [ 'I422P12', 12, true ],
    [ 'I444', 8, true ],
    [ 'I444P10', 10, true ],
    [ 'I444P12', 12, true ],
    [ 'NV12', 8, false ]
];
const UNSUPPORTED_RAW_FORMAT = 'RGBA';

const ULTRA_HD_8K_GEOMETRY = {
    codedHeight: 4_320,
    codedWidth: 7_680,
    displayHeight: 4_320,
    displayWidth: 7_680
};
const ULTRA_HD_16K_GEOMETRY = {
    codedHeight: 8_640,
    codedWidth: 15_360,
    displayHeight: 8_640,
    displayWidth: 15_360
};
// A row this wide aligns past the safe integer range
const UNREPRESENTABLE_GEOMETRY = {
    codedHeight: 2,
    codedWidth: Number.MAX_SAFE_INTEGER,
    displayHeight: 2,
    displayWidth: Number.MAX_SAFE_INTEGER
};
// An I420 BL this size has a representable copy, but not beside an I420P10 EL reserved at its coded size
const COMPOUND_UNREPRESENTABLE_CODED_WIDTH = 2 ** 26;
const COMPOUND_UNREPRESENTABLE_CODED_HEIGHT = 2 ** 25;
const COMPOUND_UNREPRESENTABLE_GEOMETRY = {
    codedHeight: COMPOUND_UNREPRESENTABLE_CODED_HEIGHT,
    codedWidth: COMPOUND_UNREPRESENTABLE_CODED_WIDTH,
    displayHeight: COMPOUND_UNREPRESENTABLE_CODED_HEIGHT,
    displayWidth: COMPOUND_UNREPRESENTABLE_CODED_WIDTH
};

type FrameHarness = {
    close: MockFunction
    copyTo: MockFunction
    frame: VideoFrame
};

type FrameOptions = {
    codedHeight?: number
    codedWidth?: number
    colorSpace?: {
        fullRange: boolean | null
        matrix: string | null
        primaries: string | null
        transfer: string | null
    }
    copyTo?: MockFunction
    displayHeight?: number
    displayWidth?: number
    duration?: number | null
    flip?: unknown
    format?: string | null
    rotation?: unknown
    timestamp?: number
    visibleRectangle?: {
        height: number
        width: number
        x: number
        y: number
    } | null
};

function createRectangle(
    x: number,
    y: number,
    width: number,
    height: number
): DOMRectReadOnly {
    return {
        bottom: y + height,
        height,
        left: x,
        right: x + width,
        toJSON: () => ({}),
        top: y,
        width,
        x,
        y
    };
}

function createFrameHarness(options: FrameOptions = {}): FrameHarness {
    const codedHeight = options.codedHeight ?? 2;
    const codedWidth = options.codedWidth ?? 4;
    const close = vi.fn();
    const copyTo = options.copyTo ?? vi.fn(
        async (
            _destination: AllowSharedBufferSource,
            copyOptions?: VideoFrameCopyToOptions
        ): Promise<PlaneLayout[]> => copyOptions?.layout ?? []
    );
    const visibleRectangle = options.visibleRectangle === null ?
        null :
        createRectangle(
            options.visibleRectangle?.x ?? 0,
            options.visibleRectangle?.y ?? 0,
            options.visibleRectangle?.width ?? codedWidth,
            options.visibleRectangle?.height ?? codedHeight
        );
    const frame = {
        close,
        codedHeight,
        codedWidth,
        colorSpace: options.colorSpace ?? {
            fullRange: false,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            transfer: 'smpte2084'
        },
        copyTo,
        displayHeight: options.displayHeight ?? codedHeight,
        displayWidth: options.displayWidth ?? codedWidth,
        duration: options.duration === undefined ? 41_667 : options.duration,
        flip: options.flip,
        format: options.format === undefined ? 'I420' : options.format,
        rotation: options.rotation,
        timestamp: options.timestamp ?? 1_000_000,
        visibleRect: visibleRectangle
    } as unknown as VideoFrame;
    return { close, copyTo, frame };
}

async function expectCopyFailure(
    promise: Promise<unknown>,
    code: RawVideoFrameCopyError['code']
): Promise<void> {
    await expect(promise).rejects.toMatchObject({
        code,
        name: 'RawVideoFrameCopyError'
    });
}

describe('copyVideoFrameToRawPlanes', () => {
    it('copies I420 into three exact 256-byte-aligned plane layouts', async () => {
        const frameHarness = createFrameHarness();

        const result = await copyVideoFrameToRawPlanes(frameHarness.frame);

        expect(frameHarness.copyTo).toHaveBeenCalledOnce();
        const [ destination, copyOptions ] = frameHarness.copyTo.mock.calls[0] as [
            ArrayBuffer,
            VideoFrameCopyToOptions
        ];
        expect(destination).toBe(result.data);
        expect(destination.byteLength).toBe(1_024);
        expect(copyOptions).toEqual({
            layout: [
                { offset: 0, stride: RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT },
                { offset: 512, stride: RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT },
                { offset: 768, stride: RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT }
            ],
            rect: { height: 2, width: 4, x: 0, y: 0 }
        });
        expect(result).toMatchObject({
            bitDepth: 8,
            codedHeight: 2,
            codedWidth: 4,
            colorSpace: {
                fullRange: false,
                matrix: 'bt2020-ncl',
                primaries: 'bt2020',
                transfer: 'smpte2084'
            },
            displayHeight: 2,
            displayWidth: 4,
            durationMicroseconds: 41_667,
            format: 'I420',
            timestampMicroseconds: 1_000_000,
            visibleRectangle: { height: 2, width: 4, x: 0, y: 0 }
        });
        expect(result.planes).toEqual([
            {
                byteLength: 512,
                byteOffset: 0,
                bytesPerComponent: 1,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: 2,
                kind: 'y',
                rowByteLength: 4,
                width: 4
            },
            {
                byteLength: 256,
                byteOffset: 512,
                bytesPerComponent: 1,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: 1,
                kind: 'u',
                rowByteLength: 2,
                width: 2
            },
            {
                byteLength: 256,
                byteOffset: 768,
                bytesPerComponent: 1,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: 1,
                kind: 'v',
                rowByteLength: 2,
                width: 2
            }
        ]);
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it('reuses a spare of the copy layout\'s byte length from the pool', async () => {
        const frameHarness = createFrameHarness();
        const bufferPool = new RawFrameBufferPool(MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH);
        const spareBuffer = new ArrayBuffer(DEFAULT_FRAME_COPY_BYTE_LENGTH);
        bufferPool.release(spareBuffer);

        const result = await copyVideoFrameToRawPlanes(frameHarness.frame, { bufferPool });

        expect(result.data).toBe(spareBuffer);
        expect(frameHarness.copyTo).toHaveBeenCalledWith(
            spareBuffer,
            expect.any(Object)
        );
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it('allocates a correctly sized buffer instead of reusing a spare of another size', async () => {
        const frameHarness = createFrameHarness();
        const bufferPool = new RawFrameBufferPool(MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH);
        const mismatchedBuffer = new ArrayBuffer(MISMATCHED_SPARE_BYTE_LENGTH);
        bufferPool.release(mismatchedBuffer);

        const result = await copyVideoFrameToRawPlanes(frameHarness.frame, { bufferPool });

        expect(result.data).not.toBe(mismatchedBuffer);
        expect(result.data.byteLength).toBe(DEFAULT_FRAME_COPY_BYTE_LENGTH);
        expect(bufferPool.take(MISMATCHED_SPARE_BYTE_LENGTH)).toBe(mismatchedBuffer);
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it('reports a buffer the pool cannot allocate before copying', async () => {
        const frameHarness = createFrameHarness();
        const failingPool = {
            take: (): never => {
                throw new RangeError(ALLOCATION_FAILURE_MESSAGE);
            }
        } as unknown as RawFrameBufferPool;

        await expect(copyVideoFrameToRawPlanes(
            frameHarness.frame,
            { bufferPool: failingPool }
        )).rejects.toMatchObject({ code: 'allocation-failed', message: ALLOCATION_FAILURE_MESSAGE });
        expect(frameHarness.copyTo).not.toHaveBeenCalled();
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it('copies odd-sized NV12 into luma and interleaved chroma planes', async () => {
        const frameHarness = createFrameHarness({
            codedHeight: 3,
            codedWidth: 5,
            format: 'NV12'
        });

        const result = await copyVideoFrameToRawPlanes(frameHarness.frame);

        expect(result.data.byteLength).toBe(1_280);
        expect(result.planes).toEqual([
            expect.objectContaining({
                byteLength: 768,
                byteOffset: 0,
                bytesPerComponent: 1,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: 3,
                kind: 'y',
                rowByteLength: 5,
                width: 5
            }),
            expect.objectContaining({
                byteLength: 512,
                byteOffset: 768,
                bytesPerComponent: 1,
                bytesPerRow: 256,
                componentsPerTexel: 2,
                height: 2,
                kind: 'uv',
                rowByteLength: 6,
                width: 3
            })
        ]);
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it.each([
        [ 'I420P10', 10, [ 8, 4, 4 ] ],
        [ 'I420P12', 12, [ 8, 4, 4 ] ],
        [ 'I422P10', 10, [ 8, 4, 4 ] ],
        [ 'I422P12', 12, [ 8, 4, 4 ] ],
        [ 'I444P10', 10, [ 8, 8, 8 ] ],
        [ 'I444P12', 12, [ 8, 8, 8 ] ]
    ] as const)(
        'copies %s through little-endian 16-bit component storage',
        async (
            format: SupportedRawVideoFrameFormat,
            bitDepth: number,
            expectedRowByteLengths: readonly number[]
        ) => {
            const frameHarness = createFrameHarness({ format });

            const result = await copyVideoFrameToRawPlanes(frameHarness.frame);

            expect(result.bitDepth).toBe(bitDepth);
            expect(result.planes.map(plane => plane.bytesPerComponent)).toEqual([ 2, 2, 2 ]);
            expect(result.planes.map(plane => plane.rowByteLength)).toEqual(
                expectedRowByteLengths
            );
            expect(getRawPlaneLayoutFailure(result)).toBeNull();
            expect(frameHarness.close).toHaveBeenCalledOnce();
        }
    );

    it.each([
        [ 'I420', [ 4, 2, 2 ], [ 2, 1, 1 ] ],
        [ 'I422', [ 4, 2, 2 ], [ 2, 2, 2 ] ],
        [ 'I444', [ 4, 4, 4 ], [ 2, 2, 2 ] ]
    ] as const)(
        'copies exact 8-bit %s chroma geometry',
        async (
            format: SupportedRawVideoFrameFormat,
            expectedRowByteLengths: readonly number[],
            expectedPlaneHeights: readonly number[]
        ) => {
            const result = await copyVideoFrameToRawPlanes(
                createFrameHarness({ format }).frame
            );

            expect(result.planes.map(plane => plane.rowByteLength)).toEqual(
                expectedRowByteLengths
            );
            expect(result.planes.map(plane => plane.height)).toEqual(expectedPlaneHeights);
            expect(getRawPlaneLayoutFailure(result)).toBeNull();
        }
    );

    it('aligns visible rectangles to each chroma subsampling grid', async () => {
        const subsampled422Result = await copyVideoFrameToRawPlanes(createFrameHarness({
            codedHeight: 4,
            codedWidth: 6,
            format: 'I422',
            visibleRectangle: { height: 2, width: 4, x: 2, y: 1 }
        }).frame);
        const fullChroma444Result = await copyVideoFrameToRawPlanes(createFrameHarness({
            codedHeight: 4,
            codedWidth: 6,
            format: 'I444',
            visibleRectangle: { height: 2, width: 4, x: 1, y: 1 }
        }).frame);

        expect(subsampled422Result.visibleRectangle).toEqual({
            height: 2,
            width: 4,
            x: 2,
            y: 1
        });
        expect(fullChroma444Result.visibleRectangle).toEqual({
            height: 2,
            width: 4,
            x: 1,
            y: 1
        });
        expect(getRawPlaneLayoutFailure(subsampled422Result)).toBeNull();
        expect(getRawPlaneLayoutFailure(fullChroma444Result)).toBeNull();
    });

    it('rejects only the subsampled axes with misaligned crop offsets', async () => {
        const subsampled422Frame = createFrameHarness({
            codedHeight: 4,
            codedWidth: 6,
            format: 'I422',
            visibleRectangle: { height: 2, width: 4, x: 1, y: 1 }
        });

        await expectCopyFailure(
            copyVideoFrameToRawPlanes(subsampled422Frame.frame),
            'invalid-dimensions'
        );
    });

    it('copies a null-format hardware frame into the explicitly requested raw format', async () => {
        const frameHarness = createFrameHarness({ format: null });

        const result = await copyVideoFrameToRawPlanes(frameHarness.frame, {
            format: 'I420P10'
        });

        const copyOptions = frameHarness.copyTo.mock.calls[0]?.[1] as (
            VideoFrameCopyToOptions & { format?: string }
        );
        expect(copyOptions.format).toBe('I420P10');
        expect(result).toMatchObject({ bitDepth: 10, format: 'I420P10' });
        expect(result.planes.map(plane => plane.bytesPerComponent)).toEqual([ 2, 2, 2 ]);
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it('copies a frame already in the requested format without the format option', async () => {
        const copyTo = vi.fn(async (
            _destination: AllowSharedBufferSource,
            copyOptions?: VideoFrameCopyToOptions & { format?: string }
        ): Promise<PlaneLayout[]> => {
            if (copyOptions?.format) {
                throw new DOMException(EXPLICIT_PLANAR_FORMAT_REJECTION_MESSAGE, 'NotSupportedError');
            }
            return copyOptions?.layout ?? [];
        });
        const frameHarness = createFrameHarness({ copyTo, format: 'I420P10' });

        const result = await copyVideoFrameToRawPlanes(frameHarness.frame, {
            format: 'I420P10'
        });

        expect(result.format).toBe('I420P10');
        expect(frameHarness.copyTo).toHaveBeenCalledOnce();
        expect(frameHarness.copyTo.mock.calls[0]?.[1]).not.toHaveProperty('format');
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it('preserves display, crop, timing, and nullable color metadata', async () => {
        const frameHarness = createFrameHarness({
            codedHeight: 1_088,
            codedWidth: 1_920,
            colorSpace: {
                fullRange: null,
                matrix: null,
                primaries: null,
                transfer: null
            },
            displayHeight: 720,
            displayWidth: 1_280,
            duration: null,
            timestamp: -50_000,
            visibleRectangle: { height: 1_080, width: 1_920, x: 0, y: 4 }
        });

        const result = await copyVideoFrameToRawPlanes(frameHarness.frame);

        expect(result).toMatchObject({
            colorSpace: {
                fullRange: null,
                matrix: null,
                primaries: null,
                transfer: null
            },
            displayHeight: 720,
            displayWidth: 1_280,
            durationMicroseconds: null,
            timestampMicroseconds: -50_000,
            visibleRectangle: { height: 1_080, width: 1_920, x: 0, y: 4 }
        });
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it.each([ null, 'RGBA', 'RGBX', 'BGRA', 'I420A' ])(
        'rejects unsupported or alpha format %s and closes the frame',
        async (format: string | null) => {
            const frameHarness = createFrameHarness({ format });

            await expectCopyFailure(
                copyVideoFrameToRawPlanes(frameHarness.frame),
                'unsupported-format'
            );

            expect(frameHarness.copyTo).not.toHaveBeenCalled();
            expect(frameHarness.close).toHaveBeenCalledOnce();
        }
    );

    it.each([
        { flip: true },
        { flip: 'invalid' },
        { rotation: 90 },
        { rotation: 180 },
        { rotation: 'invalid' }
    ])('rejects unsupported frame transform %#', async (frameOptions: FrameOptions) => {
        const frameHarness = createFrameHarness(frameOptions);

        await expectCopyFailure(
            copyVideoFrameToRawPlanes(frameHarness.frame),
            'unsupported-transform'
        );

        expect(frameHarness.copyTo).not.toHaveBeenCalled();
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it('accepts explicit identity transform metadata', async () => {
        const frameHarness = createFrameHarness({ flip: false, rotation: 0 });

        const result = await copyVideoFrameToRawPlanes(frameHarness.frame);

        expect(result.format).toBe('I420');
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it.each([
        { codedWidth: 0 },
        { codedHeight: Number.NaN },
        { displayWidth: Number.POSITIVE_INFINITY },
        { displayHeight: 0 },
        { duration: -1 },
        { timestamp: Number.MAX_SAFE_INTEGER + 1 },
        { visibleRectangle: null },
        { visibleRectangle: { height: 2, width: 4, x: 2, y: 0 } },
        {
            codedWidth: 6,
            visibleRectangle: { height: 2, width: 4, x: 1, y: 0 }
        },
        {
            codedHeight: 4,
            visibleRectangle: { height: 2, width: 4, x: 0, y: 1 }
        },
        { visibleRectangle: { height: 1.5, width: 4, x: 0, y: 0 } }
    ])('rejects invalid frame metadata %#', async (frameOptions: FrameOptions) => {
        const frameHarness = createFrameHarness(frameOptions);

        await expectCopyFailure(
            copyVideoFrameToRawPlanes(frameHarness.frame),
            'invalid-dimensions'
        );

        expect(frameHarness.copyTo).not.toHaveBeenCalled();
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it('rejects frame geometry that differs from the negotiated track before copying', async () => {
        const frameHarness = createFrameHarness();

        await expectCopyFailure(copyVideoFrameToRawPlanes(frameHarness.frame, {
            expectedGeometry: {
                codedHeight: 2,
                codedWidth: 4,
                displayHeight: 2,
                displayWidth: 8
            }
        }), 'invalid-dimensions');
        expect(frameHarness.copyTo).not.toHaveBeenCalled();
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it('rejects a returned layout that differs from the requested layout', async () => {
        const copyTo = vi.fn(async () => [ { offset: 0, stride: 4 } ]);
        const frameHarness = createFrameHarness({ copyTo });

        await expectCopyFailure(
            copyVideoFrameToRawPlanes(frameHarness.frame),
            'invalid-layout'
        );

        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it('wraps copy failure and closes the frame exactly once', async () => {
        const copyTo = vi.fn(async () => {
            throw new Error('copy rejected');
        });
        const frameHarness = createFrameHarness({ copyTo });

        const resultPromise = copyVideoFrameToRawPlanes(frameHarness.frame);
        await expect(resultPromise).rejects.toMatchObject({
            code: 'copy-failed',
            message: 'copy rejected'
        });

        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it('does not let a throwing close hide a successful copy', async () => {
        const frameHarness = createFrameHarness();
        frameHarness.close.mockImplementation(() => {
            throw new Error('close rejected');
        });

        const result = await copyVideoFrameToRawPlanes(frameHarness.frame);

        expect(result.format).toBe('I420');
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it('returns the raw ArrayBuffer as the only transferable', async () => {
        const frameHarness = createFrameHarness();
        const result = await copyVideoFrameToRawPlanes(frameHarness.frame);

        const transferList = getRawVideoFrameTransferList(result);

        expect(transferList).toEqual([ result.data ]);
        expect(transferList).not.toBe(getRawVideoFrameTransferList(result));
    });
});

describe('hasRawVideoFrameCopyLayout', () => {
    it.each([
        { format: 'I420P10', geometry: ULTRA_HD_16K_GEOMETRY, label: '16K 10-bit' },
        { format: 'I444P12', geometry: ULTRA_HD_8K_GEOMETRY, label: '8K 4:4:4 12-bit' }
    ] as const)('describes a single $label layer, whatever its size', ({ format, geometry }) => {
        expect(hasRawVideoFrameCopyLayout(geometry, format, RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT)).toBe(true);
    });

    it.each([ 'I420', 'I420P10', 'I444P12' ] as const)('describes a 16K %s BL beside its EL', format => {
        expect(hasRawVideoFrameCopyLayout(
            ULTRA_HD_16K_GEOMETRY,
            format,
            RAW_VIDEO_DOLBY_VISION_FRAME_LAYER_COUNT
        )).toBe(true);
    });

    it('refuses only a layout whose byte length leaves the safe integer range', () => {
        expect(hasRawVideoFrameCopyLayout(UNREPRESENTABLE_GEOMETRY, 'I420P10')).toBe(false);
        expect(hasRawVideoFrameCopyLayout(
            COMPOUND_UNREPRESENTABLE_GEOMETRY,
            'I420',
            RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT
        )).toBe(true);
        // The EL is reserved as I420P10 at the BL's coded size, twice the bytes of an 8-bit BL
        expect(hasRawVideoFrameCopyLayout(
            COMPOUND_UNREPRESENTABLE_GEOMETRY,
            'I420',
            RAW_VIDEO_DOLBY_VISION_FRAME_LAYER_COUNT
        )).toBe(false);
    });
});

describe('copyVideoFramePairToRawPlanes', () => {
    const enhancementGeometry = {
        codedHeight: 2,
        codedWidth: 2,
        displayHeight: 2,
        displayWidth: 2
    };

    it('copies BL and EL plane regions into one atomic transferable buffer', async () => {
        const baseHarness = createFrameHarness({ format: 'I420P10' });
        const enhancementHarness = createFrameHarness({
            codedHeight: 2,
            codedWidth: 2,
            format: 'I420P10'
        });

        const result = await copyVideoFramePairToRawPlanes(
            baseHarness.frame,
            enhancementHarness.frame,
            {
                enhancementExpectedGeometry: enhancementGeometry,
                format: 'I420P10'
            }
        );

        expect(result.enhancementFrame).not.toBeNull();
        expect(result.enhancementFrame?.data).toBe(result.baseFrame.data);
        expect(result.baseFrame.data.byteLength).toBe(2_048);
        expect(result.baseFrame.planes.map(plane => plane.byteOffset)).toEqual([
            0,
            512,
            768
        ]);
        expect(result.enhancementFrame?.planes.map(plane => plane.byteOffset)).toEqual([
            1_024,
            1_536,
            1_792
        ]);
        expect(baseHarness.copyTo.mock.calls[0]?.[0]).toBe(result.baseFrame.data);
        expect(enhancementHarness.copyTo.mock.calls[0]?.[0]).toBe(result.baseFrame.data);
        expect(baseHarness.close).toHaveBeenCalledOnce();
        expect(enhancementHarness.close).toHaveBeenCalledOnce();
        expect(getRawVideoFramePairTransferList(result)).toEqual([
            result.baseFrame.data
        ]);
    });

    it('reserves the same compound allocation after EL degradation', async () => {
        const pairedBaseHarness = createFrameHarness({ format: 'I420P10' });
        const enhancementHarness = createFrameHarness({
            codedHeight: 2,
            codedWidth: 2,
            format: 'I420P10'
        });
        const pairedResult = await copyVideoFramePairToRawPlanes(
            pairedBaseHarness.frame,
            enhancementHarness.frame,
            {
                enhancementExpectedGeometry: enhancementGeometry,
                format: 'I420P10'
            }
        );
        const baseOnlyHarness = createFrameHarness({ format: 'I420P10' });
        const bufferPool = new RawFrameBufferPool(MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH);
        bufferPool.release(pairedResult.baseFrame.data);

        const baseOnlyResult = await copyVideoFramePairToRawPlanes(
            baseOnlyHarness.frame,
            null,
            {
                bufferPool,
                enhancementExpectedGeometry: enhancementGeometry,
                format: 'I420P10'
            }
        );

        expect(baseOnlyResult.baseFrame.data).toBe(pairedResult.baseFrame.data);
        expect(baseOnlyResult.enhancementFrame).toBeNull();
        expect(baseOnlyHarness.copyTo).toHaveBeenCalledOnce();
        expect(baseOnlyHarness.close).toHaveBeenCalledOnce();
    });

    it('closes both owned frames when either plane copy fails', async () => {
        const baseHarness = createFrameHarness({ format: 'I420P10' });
        const enhancementHarness = createFrameHarness({
            codedHeight: 2,
            codedWidth: 2,
            copyTo: vi.fn(async (): Promise<PlaneLayout[]> => {
                throw new Error('enhancement copy failed');
            }),
            format: 'I420P10'
        });

        await expect(copyVideoFramePairToRawPlanes(
            baseHarness.frame,
            enhancementHarness.frame,
            {
                enhancementExpectedGeometry: enhancementGeometry,
                format: 'I420P10'
            }
        )).rejects.toMatchObject({
            code: 'copy-failed',
            message: 'enhancement copy failed'
        });
        expect(baseHarness.close).toHaveBeenCalledOnce();
        expect(enhancementHarness.close).toHaveBeenCalledOnce();
    });

    it('rejects an EL geometry mismatch before either copy begins', async () => {
        const baseHarness = createFrameHarness({ format: 'I420P10' });
        const enhancementHarness = createFrameHarness({
            codedHeight: 4,
            codedWidth: 4,
            format: 'I420P10'
        });

        await expectCopyFailure(copyVideoFramePairToRawPlanes(
            baseHarness.frame,
            enhancementHarness.frame,
            {
                enhancementExpectedGeometry: enhancementGeometry,
                format: 'I420P10'
            }
        ), 'invalid-dimensions');
        expect(baseHarness.copyTo).not.toHaveBeenCalled();
        expect(enhancementHarness.copyTo).not.toHaveBeenCalled();
        expect(baseHarness.close).toHaveBeenCalledOnce();
        expect(enhancementHarness.close).toHaveBeenCalledOnce();
    });

    // 160 samples span more than one 256-byte row at 16 bits, so every BL format gets its own layout
    const wideBaseGeometry = {
        codedHeight: 4,
        codedWidth: 160,
        displayHeight: 4,
        displayWidth: 160
    };
    const wideEnhancementGeometry = {
        codedHeight: 2,
        codedWidth: 80,
        displayHeight: 2,
        displayWidth: 80
    };
    // The 80x2 I420P10 EL takes one aligned row per plane row: 512 luma bytes and 256 per chroma plane
    const wideEnhancementPlaneOffsets = [ 0, 512, 768 ];
    const wideEnhancementByteLength = 1_024;

    function createWideBaseHarness(format: SupportedRawVideoFrameFormat): FrameHarness {
        return createFrameHarness({ codedHeight: 4, codedWidth: 160, format });
    }

    function createWideEnhancementHarness(format: string | null = 'I420P10'): FrameHarness {
        return createFrameHarness({ codedHeight: 2, codedWidth: 80, format });
    }

    it.each([
        [ 'I420', 8, 1, [ 0, 1_024, 1_536 ], 2_048 ],
        [ 'I422P10', 10, 2, [ 0, 2_048, 3_072 ], 4_096 ],
        [ 'I444P12', 12, 2, [ 0, 2_048, 4_096 ], 6_144 ]
    ] as const)(
        'copies a %s BL and its I420P10 EL into one aligned buffer',
        async (
            format: SupportedRawVideoFrameFormat,
            bitDepth: number,
            bytesPerComponent: number,
            basePlaneOffsets: readonly number[],
            baseByteLength: number
        ) => {
            const baseHarness = createWideBaseHarness(format);
            const enhancementHarness = createWideEnhancementHarness();

            const result = await copyVideoFramePairToRawPlanes(
                baseHarness.frame,
                enhancementHarness.frame,
                {
                    baseExpectedGeometry: wideBaseGeometry,
                    enhancementExpectedGeometry: wideEnhancementGeometry,
                    format
                }
            );

            expect(result.baseFrame).toMatchObject({ bitDepth, codedHeight: 4, codedWidth: 160, format });
            expect(result.baseFrame.planes.map(plane => plane.byteOffset)).toEqual(basePlaneOffsets);
            expect(result.baseFrame.planes.every(plane => plane.bytesPerComponent === bytesPerComponent))
                .toBe(true);
            expect(result.enhancementFrame).toMatchObject({
                bitDepth: 10,
                codedHeight: 2,
                codedWidth: 80,
                format: 'I420P10'
            });
            expect(baseByteLength % RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT).toBe(0);
            expect(result.enhancementFrame?.planes.map(plane => plane.byteOffset)).toEqual(
                wideEnhancementPlaneOffsets.map(offset => baseByteLength + offset)
            );
            expect(result.enhancementFrame?.planes.map(plane => plane.bytesPerComponent)).toEqual([ 2, 2, 2 ]);
            expect(result.enhancementFrame?.data).toBe(result.baseFrame.data);
            expect(result.baseFrame.data.byteLength).toBe(baseByteLength + wideEnhancementByteLength);
            expect(getRawPlaneLayoutFailure(result.baseFrame)).toBeNull();
            expect(result.enhancementFrame ? getRawPlaneLayoutFailure(result.enhancementFrame) : MISSING_ENHANCEMENT_FRAME_DETAIL).toBeNull();
            // Both layers already decode in their requested formats, so neither copy names one
            expect(baseHarness.copyTo.mock.calls[0]?.[1]).not.toHaveProperty('format');
            expect(enhancementHarness.copyTo.mock.calls[0]?.[1]).not.toHaveProperty('format');
            expect(getRawVideoFramePairTransferList(result)).toEqual([ result.baseFrame.data ]);
            expect(baseHarness.close).toHaveBeenCalledOnce();
            expect(enhancementHarness.close).toHaveBeenCalledOnce();
        }
    );

    it('reserves the I420P10 EL region when an I444P12 BL arrives alone', async () => {
        const pairedResult = await copyVideoFramePairToRawPlanes(
            createWideBaseHarness('I444P12').frame,
            createWideEnhancementHarness().frame,
            {
                enhancementExpectedGeometry: wideEnhancementGeometry,
                format: 'I444P12'
            }
        );
        const baseOnlyHarness = createWideBaseHarness('I444P12');
        const bufferPool = new RawFrameBufferPool(MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH);
        bufferPool.release(pairedResult.baseFrame.data);

        const baseOnlyResult = await copyVideoFramePairToRawPlanes(
            baseOnlyHarness.frame,
            null,
            {
                bufferPool,
                enhancementExpectedGeometry: wideEnhancementGeometry,
                format: 'I444P12'
            }
        );

        expect(baseOnlyResult.baseFrame.data).toBe(pairedResult.baseFrame.data);
        expect(baseOnlyResult.baseFrame.data.byteLength).toBe(6_144 + wideEnhancementByteLength);
        expect(baseOnlyResult.enhancementFrame).toBeNull();
        expect(baseOnlyHarness.close).toHaveBeenCalledOnce();
    });

    it.each([ 'I420', 'I422P10' ])(
        'refuses an EL decoded as %s before either copy begins',
        async (enhancementFormat: string) => {
            const baseHarness = createWideBaseHarness('I422P10');
            const enhancementHarness = createWideEnhancementHarness(enhancementFormat);

            await expectCopyFailure(copyVideoFramePairToRawPlanes(
                baseHarness.frame,
                enhancementHarness.frame,
                {
                    enhancementExpectedGeometry: wideEnhancementGeometry,
                    format: 'I422P10'
                }
            ), 'unsupported-format');
            expect(baseHarness.copyTo).not.toHaveBeenCalled();
            expect(enhancementHarness.copyTo).not.toHaveBeenCalled();
            expect(baseHarness.close).toHaveBeenCalledOnce();
            expect(enhancementHarness.close).toHaveBeenCalledOnce();
        }
    );

    it('copies an opaque EL through an explicit I420P10 request', async () => {
        const enhancementHarness = createWideEnhancementHarness(null);

        const result = await copyVideoFramePairToRawPlanes(
            createWideBaseHarness('I420').frame,
            enhancementHarness.frame,
            {
                enhancementExpectedGeometry: wideEnhancementGeometry,
                format: 'I420'
            }
        );

        expect(enhancementHarness.copyTo.mock.calls[0]?.[1]).toMatchObject({ format: 'I420P10' });
        expect(result.enhancementFrame).toMatchObject({ bitDepth: 10, format: 'I420P10' });
    });
});

describe('raw frame format facts', () => {
    it.each(RAW_FORMAT_FACTS)('gives %s a %i-bit code depth, Dolby Vision base layer %s', (format, bitDepth, dolbyVisionBaseLayer) => {
        expect(getRawFormatBitDepth(format)).toBe(bitDepth);
        expect(isRawDolbyVisionVideoFrameFormat(format)).toBe(dolbyVisionBaseLayer);
    });

    it('names no other format a Dolby Vision base layer', () => {
        expect(isRawDolbyVisionVideoFrameFormat(UNSUPPORTED_RAW_FORMAT)).toBe(false);
    });
});
