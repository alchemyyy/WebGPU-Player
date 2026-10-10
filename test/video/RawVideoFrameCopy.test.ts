import { VideoSample } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';
import RawFrameBufferPool, {
    MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH
} from 'webgpu-player/video/RawFrameBufferPool';
import {
    copyVideoFramePairToRawPlanes,
    copyVideoFrameToRawPlanes,
    createVideoSampleRawFrameSource,
    getRawVideoFramePairTransferList,
    getRawVideoFrameTransferList,
    hasRawVideoFrameCopyLayout,
    PreparedRawVideoFrameSource,
    RAW_VIDEO_DOLBY_VISION_FRAME_LAYER_COUNT,
    RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT,
    RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT,
    type RawVideoFrameCopyError,
    type RawVideoSourcePlane,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from 'webgpu-player/video/RawVideoFrameCopy';
import { hasValidRawVideoFrameLayout } from 'webgpu-player/presentation/RawYUVGPURenderer';

type MockFunction = ReturnType<typeof vi.fn>;

// The default 4x2 I420 frame takes one aligned row for each of its four plane rows
const DEFAULT_FRAME_COPY_BYTE_LENGTH = 1_024;
const MISMATCHED_SPARE_BYTE_LENGTH = 512;
const ALLOCATION_FAILURE_MESSAGE = 'Array buffer allocation failed';

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
            expect(hasValidRawVideoFrameLayout(result)).toBe(true);
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
            expect(hasValidRawVideoFrameLayout(result)).toBe(true);
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
        expect(hasValidRawVideoFrameLayout(subsampled422Result)).toBe(true);
        expect(hasValidRawVideoFrameLayout(fullChroma444Result)).toBe(true);
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

    it('retries a matching software format without the explicit legacy option', async () => {
        const copyTo = vi.fn(async (
            _destination: AllowSharedBufferSource,
            copyOptions?: VideoFrameCopyToOptions & { format?: string }
        ): Promise<PlaneLayout[]> => {
            if (copyOptions?.format) {
                throw new DOMException('Explicit planar formats are unavailable', 'NotSupportedError');
            }
            return copyOptions?.layout ?? [];
        });
        const frameHarness = createFrameHarness({ copyTo, format: 'I420P10' });

        const result = await copyVideoFrameToRawPlanes(frameHarness.frame, {
            format: 'I420P10'
        });

        expect(result.format).toBe('I420P10');
        expect(frameHarness.copyTo).toHaveBeenCalledTimes(2);
        expect(frameHarness.copyTo.mock.calls[0]?.[1]).toMatchObject({ format: 'I420P10' });
        expect(frameHarness.copyTo.mock.calls[1]?.[1]).not.toHaveProperty('format');
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

describe('createVideoSampleRawFrameSource', () => {
    const codedWidth = 6;
    const codedHeight = 4;
    const chromaWidth = 3;
    const chromaHeight = 2;
    const lumaSampleCount = codedWidth * codedHeight;
    const chromaSampleCount = chromaWidth * chromaHeight;

    function createI420P10Samples(): Uint16Array<ArrayBuffer> {
        const samples = new Uint16Array(lumaSampleCount + (2 * chromaSampleCount));
        for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
            samples[sampleIndex] = 64 + (sampleIndex * 13);
        }
        return samples;
    }

    // A software decoder's packed planes, as the bundled HEVC decoder produces them
    function createPlanarSample(samples: Uint16Array<ArrayBuffer>, rotation: 0 | 90 = 0): VideoSample {
        return new VideoSample(new Uint8Array(samples.buffer), {
            codedHeight,
            codedWidth,
            colorSpace: { fullRange: false, matrix: 'bt709', primaries: 'bt709', transfer: 'bt709' },
            displayHeight: codedHeight,
            displayWidth: codedWidth,
            duration: 0.5,
            format: 'I420P10',
            layout: [
                { offset: 0, stride: codedWidth * 2 },
                { offset: lumaSampleCount * 2, stride: chromaWidth * 2 },
                { offset: (lumaSampleCount + chromaSampleCount) * 2, stride: chromaWidth * 2 }
            ],
            rotation,
            timestamp: 1.5
        });
    }

    it('copies I420P10 planes into the aligned raw layout without constructing a VideoFrame', async () => {
        // Firefox cannot construct a high-bit-depth VideoFrame; this environment has none at all
        expect('VideoFrame' in globalThis).toBe(false);
        const samples = createI420P10Samples();
        const sample = createPlanarSample(samples);

        const rawFrame = await copyVideoFrameToRawPlanes(createVideoSampleRawFrameSource(sample), {
            expectedGeometry: {
                codedHeight,
                codedWidth,
                displayHeight: codedHeight,
                displayWidth: codedWidth
            },
            format: 'I420P10'
        });

        expect(rawFrame).toMatchObject({
            bitDepth: 10,
            codedHeight,
            codedWidth,
            colorSpace: { fullRange: false, matrix: 'bt709', primaries: 'bt709', transfer: 'bt709' },
            displayHeight: codedHeight,
            displayWidth: codedWidth,
            durationMicroseconds: 500_000,
            format: 'I420P10',
            timestampMicroseconds: 1_500_000,
            visibleRectangle: { height: codedHeight, width: codedWidth, x: 0, y: 0 }
        });
        const view = new DataView(rawFrame.data);
        const planeSampleOffsets = [ 0, lumaSampleCount, lumaSampleCount + chromaSampleCount ];
        for (let planeIndex = 0; planeIndex < rawFrame.planes.length; planeIndex += 1) {
            const plane = rawFrame.planes[planeIndex];
            expect(plane.bytesPerRow % RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT).toBe(0);
            for (let row = 0; row < plane.height; row += 1) {
                for (let column = 0; column < plane.width; column += 1) {
                    expect(view.getUint16(plane.byteOffset + (row * plane.bytesPerRow) + (column * 2), true))
                        .toBe(samples[planeSampleOffsets[planeIndex] + (row * plane.width) + column]);
                }
            }
        }
        await expect(sample.copyTo(new Uint8Array(samples.byteLength))).rejects.toThrow('closed');
    });

    it('reports a zero duration as unknown, as the VideoFrame from toVideoFrame does', () => {
        const sample = new VideoSample(new Uint8Array(createI420P10Samples().buffer), {
            codedHeight,
            codedWidth,
            format: 'I420P10',
            timestamp: 0
        });

        expect(createVideoSampleRawFrameSource(sample).duration).toBeNull();
        sample.close();
    });

    it('refuses a rotated sample like a rotated VideoFrame and closes it', async () => {
        const samples = createI420P10Samples();
        const sample = createPlanarSample(samples, 90);

        await expect(copyVideoFrameToRawPlanes(createVideoSampleRawFrameSource(sample), {
            format: 'I420P10'
        })).rejects.toMatchObject({ code: 'unsupported-transform' });
        await expect(sample.copyTo(new Uint8Array(samples.byteLength))).rejects.toThrow('closed');
    });
});

// A decoder's frame whose rows are padded, with an odd chroma width
const PREPARED_CODED_WIDTH = 6;
const PREPARED_CODED_HEIGHT = 4;
const PREPARED_CHROMA_WIDTH = 3;
const PREPARED_CHROMA_HEIGHT = 2;
const PREPARED_LUMA_STRIDE = 8;
const PREPARED_CHROMA_STRIDE = 5;
// A padding sample would surface as 255 or 65535 if any reached the frame
const PREPARED_PADDING_SAMPLE = 0xFFFF;
const PREPARED_DISPLAY_WIDTH = 8;
const PREPARED_DISPLAY_HEIGHT = 4;
const PREPARED_TIMESTAMP_MICROSECONDS = 1_500_000 as Microseconds;
const PREPARED_DURATION_MICROSECONDS = 41_708 as Microseconds;
const ZERO_DURATION_MICROSECONDS = 0 as Microseconds;
const PREPARED_COLOR_SPACE = {
    fullRange: false,
    matrix: 'bt2020-ncl',
    primaries: 'bt2020',
    transfer: 'pq'
} as const;
const EIGHT_BIT_SAMPLE_LIMIT = 256;
const TEN_BIT_SAMPLE_LIMIT = 1_024;
const SAMPLE_PATTERN_STEP = 13;
const SAMPLE_PATTERN_OFFSET = 64;
const MICROSECONDS_PER_SECOND = 1_000_000;
const PREPARED_GEOMETRY = {
    codedHeight: PREPARED_CODED_HEIGHT,
    codedWidth: PREPARED_CODED_WIDTH,
    displayHeight: PREPARED_DISPLAY_HEIGHT,
    displayWidth: PREPARED_DISPLAY_WIDTH
};

type PreparedFrameFormat = 'I420' | 'I420P10';

type DecodedPlaneVector = {
    compact: Uint16Array
    strided: RawVideoSourcePlane
};

/** Builds a decoded plane twice: compact, as a VideoSample packs it, and padded, as a decoder's WASM memory holds it. */
function createDecodedPlane(width: number, height: number, stride: number, firstSample: number, sampleLimit: number): DecodedPlaneVector {
    const compact = new Uint16Array(width * height);
    const strided = new Uint16Array(((height - 1) * stride) + width);
    strided.fill(PREPARED_PADDING_SAMPLE);
    for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
        for (let columnIndex = 0; columnIndex < width; columnIndex += 1) {
            const sampleIndex = (rowIndex * width) + columnIndex;
            const sample = (SAMPLE_PATTERN_OFFSET + ((firstSample + sampleIndex) * SAMPLE_PATTERN_STEP)) % sampleLimit;
            compact[sampleIndex] = sample;
            strided[(rowIndex * stride) + columnIndex] = sample;
        }
    }
    return { compact, strided: { samples: strided, stride } };
}

function createDecodedPlanes(format: PreparedFrameFormat): DecodedPlaneVector[] {
    const sampleLimit = format === 'I420' ? EIGHT_BIT_SAMPLE_LIMIT : TEN_BIT_SAMPLE_LIMIT;
    const lumaSampleCount = PREPARED_CODED_WIDTH * PREPARED_CODED_HEIGHT;
    const chromaSampleCount = PREPARED_CHROMA_WIDTH * PREPARED_CHROMA_HEIGHT;
    const planes: DecodedPlaneVector[] = [];
    planes.push(createDecodedPlane(PREPARED_CODED_WIDTH, PREPARED_CODED_HEIGHT, PREPARED_LUMA_STRIDE, 0, sampleLimit));
    planes.push(createDecodedPlane(
        PREPARED_CHROMA_WIDTH,
        PREPARED_CHROMA_HEIGHT,
        PREPARED_CHROMA_STRIDE,
        lumaSampleCount,
        sampleLimit
    ));
    planes.push(createDecodedPlane(
        PREPARED_CHROMA_WIDTH,
        PREPARED_CHROMA_HEIGHT,
        PREPARED_CHROMA_STRIDE,
        lumaSampleCount + chromaSampleCount,
        sampleLimit
    ));
    return planes;
}

/** Packs the compact planes and makes the VideoSample a software decoder gives Mediabunny. */
function createPackedSample(
    format: PreparedFrameFormat,
    planes: readonly DecodedPlaneVector[],
    durationMicroseconds: Microseconds
): VideoSample {
    const bytesPerSample = format === 'I420' ? 1 : 2;
    const sampleCount = planes.reduce((count: number, plane: DecodedPlaneVector): number => count + plane.compact.length, 0);
    const packedSamples = format === 'I420' ? new Uint8Array(sampleCount) : new Uint16Array(sampleCount);
    const layout: PlaneLayout[] = [];
    let sampleOffset = 0;
    for (const plane of planes) {
        packedSamples.set(plane.compact, sampleOffset);
        layout.push({
            offset: sampleOffset * bytesPerSample,
            stride: (plane === planes[0] ? PREPARED_CODED_WIDTH : PREPARED_CHROMA_WIDTH) * bytesPerSample
        });
        sampleOffset += plane.compact.length;
    }
    return new VideoSample(new Uint8Array(packedSamples.buffer), {
        codedHeight: PREPARED_CODED_HEIGHT,
        codedWidth: PREPARED_CODED_WIDTH,
        colorSpace: PREPARED_COLOR_SPACE as unknown as VideoColorSpaceInit,
        displayHeight: PREPARED_DISPLAY_HEIGHT,
        displayWidth: PREPARED_DISPLAY_WIDTH,
        duration: durationMicroseconds / MICROSECONDS_PER_SECOND,
        format,
        layout,
        timestamp: PREPARED_TIMESTAMP_MICROSECONDS / MICROSECONDS_PER_SECOND
    });
}

function prepareDecodedFrame(
    format: PreparedFrameFormat,
    planes: readonly DecodedPlaneVector[],
    bufferPool: RawFrameBufferPool | null,
    durationMicroseconds: Microseconds = PREPARED_DURATION_MICROSECONDS
): PreparedRawVideoFrameSource {
    return PreparedRawVideoFrameSource.prepare(
        {
            codedHeight: PREPARED_CODED_HEIGHT,
            codedWidth: PREPARED_CODED_WIDTH,
            colorSpace: PREPARED_COLOR_SPACE,
            displayHeight: PREPARED_DISPLAY_HEIGHT,
            displayWidth: PREPARED_DISPLAY_WIDTH,
            durationMicroseconds,
            format,
            timestampMicroseconds: PREPARED_TIMESTAMP_MICROSECONDS
        },
        planes.map((plane: DecodedPlaneVector): RawVideoSourcePlane => plane.strided),
        bufferPool
    );
}

function captureError(action: () => unknown): unknown {
    try {
        action();
    } catch (error) {
        return error;
    }
    return null;
}

/** Requires two raw frames to match in every field and every byte, padding included. */
function expectSameRawFrame(actual: TransferableRawVideoFrame | null, expected: TransferableRawVideoFrame): void {
    expect(actual).not.toBeNull();
    const { data: actualData, ...actualMetadata } = actual as TransferableRawVideoFrame;
    const { data: expectedData, ...expectedMetadata } = expected;
    expect(actualMetadata).toEqual(expectedMetadata);
    expect(new Uint8Array(actualData)).toEqual(new Uint8Array(expectedData));
}

describe('PreparedRawVideoFrameSource', () => {
    it.each([ 'I420', 'I420P10' ] as const)(
        'writes padded %s planes byte for byte as the packed sample chain copies them',
        async (format: PreparedFrameFormat) => {
            const planes = createDecodedPlanes(format);
            const expectedFrame = await copyVideoFrameToRawPlanes(
                createVideoSampleRawFrameSource(createPackedSample(format, planes, PREPARED_DURATION_MICROSECONDS)),
                { expectedGeometry: PREPARED_GEOMETRY, format }
            );

            const preparedFrame = prepareDecodedFrame(format, planes, null);

            expectSameRawFrame(preparedFrame.takeRawFrame(format, PREPARED_GEOMETRY), expectedFrame);
        }
    );

    it('reports a zero duration as unknown, as the packed sample chain does', async () => {
        const planes = createDecodedPlanes('I420P10');
        const expectedFrame = await copyVideoFrameToRawPlanes(
            createVideoSampleRawFrameSource(createPackedSample('I420P10', planes, ZERO_DURATION_MICROSECONDS)),
            { format: 'I420P10' }
        );

        const preparedFrame = prepareDecodedFrame('I420P10', planes, null, ZERO_DURATION_MICROSECONDS);

        expect(preparedFrame.duration).toBeNull();
        expectSameRawFrame(preparedFrame.takeRawFrame('I420P10', PREPARED_GEOMETRY), expectedFrame);
    });

    it('hands its pooled buffer over only in its format at the expected geometry', () => {
        const bufferPool = new RawFrameBufferPool(MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH);
        const preparedFrame = prepareDecodedFrame('I420P10', createDecodedPlanes('I420P10'), bufferPool);

        expect(preparedFrame.takeRawFrame('I420', PREPARED_GEOMETRY)).toBeNull();
        expect(preparedFrame.takeRawFrame('I420P10', {
            ...PREPARED_GEOMETRY,
            displayWidth: PREPARED_CODED_WIDTH
        })).toBeNull();
        const rawFrame = preparedFrame.takeRawFrame('I420P10', PREPARED_GEOMETRY);

        expect(rawFrame?.format).toBe('I420P10');
        // A taken buffer belongs to its transfer, so closing the source keeps it out of the pool
        preparedFrame.close();
        expect(bufferPool.release(rawFrame?.data ?? new ArrayBuffer(0))).toBe(true);
        expect(() => preparedFrame.takeRawFrame('I420P10', PREPARED_GEOMETRY)).toThrow('closed');
    });

    it('writes into a spare from its pool and returns the spare when closed untaken', () => {
        const bufferPool = new RawFrameBufferPool(MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH);
        const firstFrame = prepareDecodedFrame('I420', createDecodedPlanes('I420'), bufferPool);
        const firstBuffer = firstFrame.takeRawFrame('I420', PREPARED_GEOMETRY)?.data;
        bufferPool.release(firstBuffer ?? new ArrayBuffer(0));

        const secondFrame = prepareDecodedFrame('I420', createDecodedPlanes('I420'), bufferPool);
        secondFrame.close();
        secondFrame.close();
        const thirdFrame = prepareDecodedFrame('I420', createDecodedPlanes('I420'), bufferPool);

        expect(thirdFrame.takeRawFrame('I420', PREPARED_GEOMETRY)?.data).toBe(firstBuffer);
    });

    it('copies into a compound buffer through copyTo, as the packed sample chain does', async () => {
        const basePlanes = createDecodedPlanes('I420P10');
        const enhancementPlanes = createDecodedPlanes('I420P10');
        const pairOptions = {
            baseExpectedGeometry: PREPARED_GEOMETRY,
            enhancementExpectedGeometry: PREPARED_GEOMETRY,
            format: 'I420P10'
        } as const;
        const expectedPair = await copyVideoFramePairToRawPlanes(
            createVideoSampleRawFrameSource(createPackedSample('I420P10', basePlanes, PREPARED_DURATION_MICROSECONDS)),
            createVideoSampleRawFrameSource(createPackedSample('I420P10', enhancementPlanes, PREPARED_DURATION_MICROSECONDS)),
            pairOptions
        );
        const baseFrame = prepareDecodedFrame('I420P10', basePlanes, null);
        const enhancementFrame = prepareDecodedFrame('I420P10', enhancementPlanes, null);

        const preparedPair = await copyVideoFramePairToRawPlanes(baseFrame, enhancementFrame, pairOptions);

        expectSameRawFrame(preparedPair.baseFrame, expectedPair.baseFrame);
        expect(preparedPair.enhancementFrame).not.toBeNull();
        expectSameRawFrame(preparedPair.enhancementFrame, expectedPair.enhancementFrame as TransferableRawVideoFrame);
        // The pair copy closes both layers
        await expect(baseFrame.copyTo(new ArrayBuffer(DEFAULT_FRAME_COPY_BYTE_LENGTH), {})).rejects.toThrow('closed');
        await expect(enhancementFrame.copyTo(new ArrayBuffer(DEFAULT_FRAME_COPY_BYTE_LENGTH), {})).rejects.toThrow('closed');
    });

    it('refuses a copy in another format or of part of the frame', async () => {
        const preparedFrame = prepareDecodedFrame('I420P10', createDecodedPlanes('I420P10'), null);
        await expect(copyVideoFrameToRawPlanes(preparedFrame, { format: 'I420' })).rejects.toMatchObject({
            code: 'copy-failed'
        });

        const croppedFrame = prepareDecodedFrame('I420P10', createDecodedPlanes('I420P10'), null);
        await expect(croppedFrame.copyTo(new ArrayBuffer(DEFAULT_FRAME_COPY_BYTE_LENGTH), {
            rect: { height: PREPARED_CHROMA_HEIGHT, width: PREPARED_CHROMA_WIDTH, x: 0, y: 0 }
        })).rejects.toThrow('full coded rectangle');
    });

    it('returns its buffer to the pool when a decoded plane does not hold its rows', () => {
        const planes = createDecodedPlanes('I420');
        const frameByteLength = prepareDecodedFrame('I420', planes, null).takeRawFrame('I420', PREPARED_GEOMETRY)?.data.byteLength;
        const bufferPool = new RawFrameBufferPool(MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH);
        const spareBuffer = new ArrayBuffer(frameByteLength ?? 0);
        bufferPool.release(spareBuffer);
        const truncatedPlanes: DecodedPlaneVector[] = [
            planes[0],
            planes[1],
            {
                compact: planes[2].compact,
                strided: {
                    samples: planes[2].strided.samples.subarray(1),
                    stride: planes[2].strided.stride
                }
            }
        ];

        expect(captureError(() => prepareDecodedFrame('I420', truncatedPlanes, bufferPool))).toMatchObject({
            code: 'invalid-layout'
        });
        expect(prepareDecodedFrame('I420', planes, bufferPool).takeRawFrame('I420', PREPARED_GEOMETRY)?.data).toBe(spareBuffer);
    });

    it('refuses a format whose planes a decoder\'s planes do not map onto', () => {
        expect(captureError(() => prepareDecodedFrame('NV12' as PreparedFrameFormat, createDecodedPlanes('I420'), null)))
            .toMatchObject({ code: 'unsupported-format' });
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
            expect(hasValidRawVideoFrameLayout(result.baseFrame)).toBe(true);
            expect(result.enhancementFrame && hasValidRawVideoFrameLayout(result.enhancementFrame)).toBe(true);
            expect(baseHarness.copyTo.mock.calls[0]?.[1]).toMatchObject({ format });
            expect(enhancementHarness.copyTo.mock.calls[0]?.[1]).toMatchObject({ format: 'I420P10' });
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
