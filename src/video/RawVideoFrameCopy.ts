import { type VideoSample } from 'mediabunny';

import { type Microseconds } from '../MediaTime';
import type RawFrameBufferPool from './RawFrameBufferPool';

export const RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT = 256;

export const RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT = 1;
export const RAW_VIDEO_DOLBY_VISION_FRAME_LAYER_COUNT = 2;
// Paces in-flight transferable buffers; a frame of any size is copied
export const MAXIMUM_OUTSTANDING_RAW_FRAME_TRANSFER_COUNT = 2;
// A Profile 4 or 7 EL is 10-bit 4:2:0 whatever the format of its BL
export const RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT = 'I420P10';

export type SupportedRawVideoFrameFormat =
    | 'I420'
    | 'I420P10'
    | 'I420P12'
    | 'I422'
    | 'I422P10'
    | 'I422P12'
    | 'I444'
    | 'I444P10'
    | 'I444P12'
    | 'NV12';

export type RawVideoFrameCopyOptions = {
    /** Supplies the destination, which it allocates when no spare fits; without one the copy allocates its own */
    bufferPool?: RawFrameBufferPool | null
    expectedGeometry?: RawVideoFrameGeometry
    format?: SupportedRawVideoFrameFormat
};

export type RawVideoFramePairCopyOptions = {
    baseExpectedGeometry?: RawVideoFrameGeometry
    /** Supplies the compound destination, which it allocates when no spare fits; without one the copy allocates its own */
    bufferPool?: RawFrameBufferPool | null
    enhancementExpectedGeometry: RawVideoFrameGeometry
    /** The BL format; the EL is always copied as RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT */
    format: SupportedRawVideoFrameFormat
};

export type RawVideoFrameGeometry = {
    codedHeight: number
    codedWidth: number
    displayHeight: number
    displayWidth: number
};

export type RawVideoPlaneKind = 'u' | 'uv' | 'v' | 'y';

export type RawVideoFrameRectangle = {
    height: number
    width: number
    x: number
    y: number
};

export type RawVideoFrameColorSpace = {
    fullRange: boolean | null
    matrix: string | null
    primaries: string | null
    transfer: string | null
};

/**
 * The decoded frame a raw copy reads and then closes.
 * A VideoFrame is one; a decoder sample that holds CPU planes is adapted by createVideoSampleRawFrameSource, so its planes are copied without a VideoFrame.
 * A PreparedRawVideoFrameSource is one too, whose decoder already wrote its planes into the raw layout.
 */
export type RawVideoFrameSource = {
    readonly codedHeight: number
    readonly codedWidth: number
    readonly colorSpace: Readonly<RawVideoFrameColorSpace>
    readonly displayHeight: number
    readonly displayWidth: number
    /** Microseconds, or null when unknown, as a VideoFrame reports it */
    readonly duration: number | null
    readonly flip?: unknown
    readonly format: string | null
    readonly rotation?: unknown
    /** Microseconds, as a VideoFrame reports it */
    readonly timestamp: number
    readonly visibleRect: Readonly<RawVideoFrameRectangle> | null
    close(): void
    copyTo(destination: ArrayBuffer, options: VideoFrameCopyToOptions): Promise<PlaneLayout[]>
};

export type RawVideoPlaneDescriptor = {
    byteLength: number
    byteOffset: number
    bytesPerComponent: 1 | 2
    bytesPerRow: number
    componentsPerTexel: 1 | 2
    height: number
    kind: RawVideoPlaneKind
    rowByteLength: number
    width: number
};

export type TransferableRawVideoFrame = {
    bitDepth: 8 | 10 | 12
    codedHeight: number
    codedWidth: number
    colorSpace: RawVideoFrameColorSpace
    data: ArrayBuffer
    displayHeight: number
    displayWidth: number
    durationMicroseconds: Microseconds | null
    format: SupportedRawVideoFrameFormat
    planes: readonly RawVideoPlaneDescriptor[]
    timestampMicroseconds: Microseconds
    visibleRectangle: RawVideoFrameRectangle
};

export type TransferableRawVideoFramePair = {
    baseFrame: TransferableRawVideoFrame
    enhancementFrame: TransferableRawVideoFrame | null
};

export type RawVideoFrameCopyFailureCode =
    | 'allocation-failed'
    | 'copy-failed'
    | 'invalid-dimensions'
    | 'invalid-layout'
    | 'unsupported-format'
    | 'unsupported-transform';

type RawVideoPlaneDefinition = {
    bytesPerComponent: 1 | 2
    componentsPerTexel: 1 | 2
    heightDivisor: 1 | 2
    kind: RawVideoPlaneKind
    widthDivisor: 1 | 2
};

type RawVideoFormatDefinition = {
    bitDepth: 8 | 10 | 12
    chromaHeightDivisor: 1 | 2
    chromaWidthDivisor: 1 | 2
    format: SupportedRawVideoFrameFormat
    planes: readonly RawVideoPlaneDefinition[]
};

type PreparedRawVideoFrame = {
    copyByteLength: number
    copyByteOffset: number
    copyLayouts: PlaneLayout[]
    format: RawVideoFormatDefinition
    planes: readonly RawVideoPlaneDescriptor[]
    visibleRectangle: RawVideoFrameRectangle
};

const I420_8_BIT_PLANES: readonly RawVideoPlaneDefinition[] = [
    {
        bytesPerComponent: 1,
        componentsPerTexel: 1,
        heightDivisor: 1,
        kind: 'y',
        widthDivisor: 1
    },
    {
        bytesPerComponent: 1,
        componentsPerTexel: 1,
        heightDivisor: 2,
        kind: 'u',
        widthDivisor: 2
    },
    {
        bytesPerComponent: 1,
        componentsPerTexel: 1,
        heightDivisor: 2,
        kind: 'v',
        widthDivisor: 2
    }
];

const I420_16_BIT_PLANES: readonly RawVideoPlaneDefinition[] = [
    {
        bytesPerComponent: 2,
        componentsPerTexel: 1,
        heightDivisor: 1,
        kind: 'y',
        widthDivisor: 1
    },
    {
        bytesPerComponent: 2,
        componentsPerTexel: 1,
        heightDivisor: 2,
        kind: 'u',
        widthDivisor: 2
    },
    {
        bytesPerComponent: 2,
        componentsPerTexel: 1,
        heightDivisor: 2,
        kind: 'v',
        widthDivisor: 2
    }
];

function createPlanarRawVideoPlanes(
    bytesPerComponent: 1 | 2,
    chromaWidthDivisor: 1 | 2,
    chromaHeightDivisor: 1 | 2
): readonly RawVideoPlaneDefinition[] {
    const planes: RawVideoPlaneDefinition[] = [];
    planes.push({
        bytesPerComponent,
        componentsPerTexel: 1,
        heightDivisor: 1,
        kind: 'y',
        widthDivisor: 1
    });
    planes.push({
        bytesPerComponent,
        componentsPerTexel: 1,
        heightDivisor: chromaHeightDivisor,
        kind: 'u',
        widthDivisor: chromaWidthDivisor
    });
    planes.push({
        bytesPerComponent,
        componentsPerTexel: 1,
        heightDivisor: chromaHeightDivisor,
        kind: 'v',
        widthDivisor: chromaWidthDivisor
    });
    return planes;
}

const I422_8_BIT_PLANES = createPlanarRawVideoPlanes(1, 2, 1);
const I422_16_BIT_PLANES = createPlanarRawVideoPlanes(2, 2, 1);
const I444_8_BIT_PLANES = createPlanarRawVideoPlanes(1, 1, 1);
const I444_16_BIT_PLANES = createPlanarRawVideoPlanes(2, 1, 1);

const NV12_PLANES: readonly RawVideoPlaneDefinition[] = [
    {
        bytesPerComponent: 1,
        componentsPerTexel: 1,
        heightDivisor: 1,
        kind: 'y',
        widthDivisor: 1
    },
    {
        bytesPerComponent: 1,
        componentsPerTexel: 2,
        heightDivisor: 2,
        kind: 'uv',
        widthDivisor: 2
    }
];

/** Describes a deterministic failure while extracting raw VideoFrame planes. */
export class RawVideoFrameCopyError extends Error {
    public readonly code: RawVideoFrameCopyFailureCode;

    public constructor(code: RawVideoFrameCopyFailureCode, message: string) {
        super(message);
        this.code = code;
        this.name = 'RawVideoFrameCopyError';
    }
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function alignTo(value: number, alignment: number): number {
    return Math.ceil(value / alignment) * alignment;
}

function isPositiveSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

function getFormatDefinition(format: string | null): RawVideoFormatDefinition {
    switch (format) {
        case 'I420':
            return {
                bitDepth: 8,
                chromaHeightDivisor: 2,
                chromaWidthDivisor: 2,
                format,
                planes: I420_8_BIT_PLANES
            };
        case 'I420P10':
            return {
                bitDepth: 10,
                chromaHeightDivisor: 2,
                chromaWidthDivisor: 2,
                format,
                planes: I420_16_BIT_PLANES
            };
        case 'I420P12':
            return {
                bitDepth: 12,
                chromaHeightDivisor: 2,
                chromaWidthDivisor: 2,
                format,
                planes: I420_16_BIT_PLANES
            };
        case 'I422':
            return {
                bitDepth: 8,
                chromaHeightDivisor: 1,
                chromaWidthDivisor: 2,
                format,
                planes: I422_8_BIT_PLANES
            };
        case 'I422P10':
            return {
                bitDepth: 10,
                chromaHeightDivisor: 1,
                chromaWidthDivisor: 2,
                format,
                planes: I422_16_BIT_PLANES
            };
        case 'I422P12':
            return {
                bitDepth: 12,
                chromaHeightDivisor: 1,
                chromaWidthDivisor: 2,
                format,
                planes: I422_16_BIT_PLANES
            };
        case 'I444':
            return {
                bitDepth: 8,
                chromaHeightDivisor: 1,
                chromaWidthDivisor: 1,
                format,
                planes: I444_8_BIT_PLANES
            };
        case 'I444P10':
            return {
                bitDepth: 10,
                chromaHeightDivisor: 1,
                chromaWidthDivisor: 1,
                format,
                planes: I444_16_BIT_PLANES
            };
        case 'I444P12':
            return {
                bitDepth: 12,
                chromaHeightDivisor: 1,
                chromaWidthDivisor: 1,
                format,
                planes: I444_16_BIT_PLANES
            };
        case 'NV12':
            return {
                bitDepth: 8,
                chromaHeightDivisor: 2,
                chromaWidthDivisor: 2,
                format,
                planes: NV12_PLANES
            };
        default:
            throw new RawVideoFrameCopyError('unsupported-format', `Raw VideoFrame format ${String(format)} is not supported`);
    }
}

function assertNoTransform(frame: RawVideoFrameSource): void {
    if (frame.flip !== undefined && frame.flip !== false) {
        throw new RawVideoFrameCopyError('unsupported-transform', 'Flipped VideoFrames require a transform pass before raw presentation');
    }
    if (frame.rotation !== undefined && frame.rotation !== 0) {
        throw new RawVideoFrameCopyError('unsupported-transform', 'Rotated VideoFrames require a transform pass before raw presentation');
    }
}

/** Refuses an EL whose decoder reports a format other than the one every dual-layer route composes. */
function assertEnhancementFrameFormat(frame: RawVideoFrameSource): void {
    // A null format is opaque, so the requested copy format decides, as it does for the BL
    if (frame.format !== null && frame.format !== RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT) {
        throw new RawVideoFrameCopyError(
            'unsupported-format',
            `Dolby Vision enhancement frame format ${frame.format} is not ${RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT}`
        );
    }
}

function getVisibleRectangle(frame: RawVideoFrameSource, format: RawVideoFormatDefinition): RawVideoFrameRectangle {
    const rectangle = frame.visibleRect;
    if (!rectangle) {
        throw new RawVideoFrameCopyError('invalid-dimensions', 'The VideoFrame does not have a visible rectangle');
    }

    const values = [ rectangle.x, rectangle.y, rectangle.width, rectangle.height ];
    if (!values.every((value: number): boolean => Number.isSafeInteger(value))) {
        throw new RawVideoFrameCopyError('invalid-dimensions', 'The VideoFrame visible rectangle must contain integer coordinates');
    }
    if (
        rectangle.x < 0
        || rectangle.y < 0
        || rectangle.width <= 0
        || rectangle.height <= 0
        || rectangle.x % format.chromaWidthDivisor !== 0
        || rectangle.y % format.chromaHeightDivisor !== 0
        || rectangle.x + rectangle.width > frame.codedWidth
        || rectangle.y + rectangle.height > frame.codedHeight
    ) {
        throw new RawVideoFrameCopyError('invalid-dimensions', 'The VideoFrame visible rectangle exceeds its coded dimensions');
    }

    return {
        height: rectangle.height,
        width: rectangle.width,
        x: rectangle.x,
        y: rectangle.y
    };
}

function getColorSpace(frame: RawVideoFrameSource): RawVideoFrameColorSpace {
    return {
        fullRange: frame.colorSpace.fullRange,
        matrix: frame.colorSpace.matrix === null ? null : String(frame.colorSpace.matrix),
        primaries: frame.colorSpace.primaries === null ? null : String(frame.colorSpace.primaries),
        transfer: frame.colorSpace.transfer === null ? null : String(frame.colorSpace.transfer)
    };
}

function assertValidFrameMetadata(frame: RawVideoFrameSource, expectedGeometry: RawVideoFrameGeometry | undefined): void {
    if (
        !isPositiveSafeInteger(frame.codedWidth)
        || !isPositiveSafeInteger(frame.codedHeight)
        || !isPositiveSafeInteger(frame.displayWidth)
        || !isPositiveSafeInteger(frame.displayHeight)
        || !Number.isSafeInteger(frame.timestamp)
        || (frame.duration !== null && !isNonNegativeSafeInteger(frame.duration))
    ) {
        throw new RawVideoFrameCopyError('invalid-dimensions', 'The VideoFrame geometry or timestamp metadata is invalid');
    }
    if (expectedGeometry && (
        frame.codedWidth !== expectedGeometry.codedWidth
        || frame.codedHeight !== expectedGeometry.codedHeight
        || frame.displayWidth !== expectedGeometry.displayWidth
        || frame.displayHeight !== expectedGeometry.displayHeight
    )) {
        throw new RawVideoFrameCopyError('invalid-dimensions', 'The VideoFrame geometry changed from its negotiated track configuration');
    }
}

function prepareFrame(
    frame: RawVideoFrameSource,
    format: RawVideoFormatDefinition,
    expectedGeometry: RawVideoFrameGeometry | undefined
): PreparedRawVideoFrame {
    assertValidFrameMetadata(frame, expectedGeometry);
    const visibleRectangle = getVisibleRectangle(frame, format);
    const planes: RawVideoPlaneDescriptor[] = [];
    const copyLayouts: PlaneLayout[] = [];
    let copyByteLength = 0;

    for (const planeDefinition of format.planes) {
        const width = Math.ceil(frame.codedWidth / planeDefinition.widthDivisor);
        const height = Math.ceil(frame.codedHeight / planeDefinition.heightDivisor);
        const rowByteLength = width * planeDefinition.componentsPerTexel * planeDefinition.bytesPerComponent;
        const bytesPerRow = alignTo(rowByteLength, RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT);
        const byteLength = bytesPerRow * height;
        if (
            !isPositiveSafeInteger(width)
            || !isPositiveSafeInteger(height)
            || !isPositiveSafeInteger(rowByteLength)
            || !isPositiveSafeInteger(bytesPerRow)
            || !isPositiveSafeInteger(byteLength)
            || !isNonNegativeSafeInteger(copyByteLength)
            || !isPositiveSafeInteger(copyByteLength + byteLength)
        ) {
            throw new RawVideoFrameCopyError('invalid-dimensions', 'The raw VideoFrame copy layout is not representable');
        }

        planes.push({
            byteLength,
            byteOffset: copyByteLength,
            bytesPerComponent: planeDefinition.bytesPerComponent,
            bytesPerRow,
            componentsPerTexel: planeDefinition.componentsPerTexel,
            height,
            kind: planeDefinition.kind,
            rowByteLength,
            width
        });
        copyLayouts.push({
            offset: copyByteLength,
            stride: bytesPerRow
        });
        copyByteLength += byteLength;
    }

    return {
        copyByteLength,
        copyByteOffset: 0,
        copyLayouts,
        format,
        planes,
        visibleRectangle
    };
}

function returnedLayoutsMatch(returnedLayouts: readonly PlaneLayout[], preparedFrame: PreparedRawVideoFrame): boolean {
    if (returnedLayouts.length !== preparedFrame.planes.length) {
        return false;
    }

    return returnedLayouts.every((returnedLayout: PlaneLayout, index: number): boolean => {
        const plane = preparedFrame.planes[index];
        const finalRowEnd = returnedLayout.offset + (returnedLayout.stride * (plane.height - 1)) + plane.rowByteLength;
        return Number.isSafeInteger(returnedLayout.offset)
            && Number.isSafeInteger(returnedLayout.stride)
            && returnedLayout.offset === plane.byteOffset
            && returnedLayout.stride === plane.bytesPerRow
            && finalRowEnd <= preparedFrame.copyByteOffset + preparedFrame.copyByteLength;
    });
}

function shiftPreparedFrame(preparedFrame: PreparedRawVideoFrame, copyByteOffset: number): PreparedRawVideoFrame {
    if (!isNonNegativeSafeInteger(copyByteOffset)) {
        throw new RawVideoFrameCopyError('invalid-layout', 'The raw VideoFrame copy offset is invalid');
    }
    return {
        ...preparedFrame,
        copyByteOffset,
        copyLayouts: preparedFrame.copyLayouts.map((layout: PlaneLayout): PlaneLayout => ({
            offset: layout.offset + copyByteOffset,
            stride: layout.stride
        })),
        planes: preparedFrame.planes.map((plane: RawVideoPlaneDescriptor): RawVideoPlaneDescriptor => ({
            ...plane,
            byteOffset: plane.byteOffset + copyByteOffset
        }))
    };
}

type RawVideoFrameCopyToOptions = Omit<VideoFrameCopyToOptions, 'format'> & {
    format: SupportedRawVideoFrameFormat
};

async function copyFrameData(
    frame: RawVideoFrameSource,
    data: ArrayBuffer,
    preparedFrame: PreparedRawVideoFrame,
    requestedFormat: SupportedRawVideoFrameFormat | undefined
): Promise<PlaneLayout[]> {
    const baseOptions: VideoFrameCopyToOptions = {
        layout: preparedFrame.copyLayouts,
        rect: {
            height: frame.codedHeight,
            width: frame.codedWidth,
            x: 0,
            y: 0
        }
    };
    if (!requestedFormat) {
        return frame.copyTo(data, baseOptions);
    }

    const requestedOptions: RawVideoFrameCopyToOptions = {
        ...baseOptions,
        format: requestedFormat
    };
    try {
        return await frame.copyTo(data, requestedOptions as unknown as VideoFrameCopyToOptions);
    } catch (error) {
        if (frame.format !== requestedFormat) {
            throw error;
        }

        // Older Chromium versions reject explicit non-RGB formats even when the decoded frame already exposes that format
        return frame.copyTo(data, baseOptions);
    }
}

async function copyPreparedFrameData(
    frame: RawVideoFrameSource,
    data: ArrayBuffer,
    preparedFrame: PreparedRawVideoFrame,
    requestedFormat: SupportedRawVideoFrameFormat | undefined,
    layoutMismatchMessage: string
): Promise<void> {
    let returnedLayouts: PlaneLayout[];
    try {
        returnedLayouts = await copyFrameData(frame, data, preparedFrame, requestedFormat);
    } catch (error) {
        throw new RawVideoFrameCopyError('copy-failed', getErrorMessage(error));
    }
    if (!returnedLayoutsMatch(returnedLayouts, preparedFrame)) {
        throw new RawVideoFrameCopyError('invalid-layout', layoutMismatchMessage);
    }
}

function closeFrame(frame: RawVideoFrameSource): void {
    try {
        frame.close();
    } catch {
        // Ownership ends even if a platform implementation throws while closing
    }
}

function allocateRawFrameBuffer(copyByteLength: number, bufferPool: RawFrameBufferPool | null | undefined): ArrayBuffer {
    try {
        return bufferPool ? bufferPool.take(copyByteLength) : new ArrayBuffer(copyByteLength);
    } catch (error) {
        throw new RawVideoFrameCopyError('allocation-failed', getErrorMessage(error));
    }
}

function createTransferableRawVideoFrame(
    frame: RawVideoFrameSource,
    data: ArrayBuffer,
    preparedFrame: PreparedRawVideoFrame
): TransferableRawVideoFrame {
    return {
        bitDepth: preparedFrame.format.bitDepth,
        codedHeight: frame.codedHeight,
        codedWidth: frame.codedWidth,
        colorSpace: getColorSpace(frame),
        data,
        displayHeight: frame.displayHeight,
        displayWidth: frame.displayWidth,
        durationMicroseconds: frame.duration as Microseconds | null,
        format: preparedFrame.format.format,
        planes: preparedFrame.planes,
        timestampMicroseconds: frame.timestamp as Microseconds,
        visibleRectangle: preparedFrame.visibleRectangle
    };
}

function getRawFrameCopyByteLength(geometry: RawVideoFrameGeometry, format: RawVideoFormatDefinition): number {
    const dimensions = [
        geometry.codedHeight,
        geometry.codedWidth,
        geometry.displayHeight,
        geometry.displayWidth
    ];
    if (dimensions.some((dimension: number): boolean => !isPositiveSafeInteger(dimension))) {
        throw new RawVideoFrameCopyError('invalid-dimensions', 'The reserved raw VideoFrame geometry is invalid');
    }

    let copyByteLength = 0;
    for (const plane of format.planes) {
        const width = Math.ceil(geometry.codedWidth / plane.widthDivisor);
        const height = Math.ceil(geometry.codedHeight / plane.heightDivisor);
        const rowByteLength = width * plane.componentsPerTexel * plane.bytesPerComponent;
        const bytesPerRow = alignTo(rowByteLength, RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT);
        copyByteLength += bytesPerRow * height;
    }
    if (!isPositiveSafeInteger(copyByteLength)) {
        throw new RawVideoFrameCopyError('invalid-dimensions', 'The reserved raw VideoFrame copy layout is not representable');
    }
    return copyByteLength;
}

/**
 * Returns whether every layer of a frame has a representable aligned copy layout; no frame is too large.
 * The first layer is the BL in format, and each further layer is a Dolby Vision EL reserved as I420P10 at the BL's coded size, which bounds the EL's own size.
 */
export function hasRawVideoFrameCopyLayout(
    geometry: RawVideoFrameGeometry,
    format: SupportedRawVideoFrameFormat,
    frameLayerCount = RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT
): boolean {
    if (!isPositiveSafeInteger(frameLayerCount)) {
        return false;
    }
    try {
        const baseCopyByteLength = getRawFrameCopyByteLength(geometry, getFormatDefinition(format));
        const enhancementLayerCount = frameLayerCount - RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT;
        const enhancementCopyByteLength = enhancementLayerCount > 0 ?
            getRawFrameCopyByteLength(geometry, getFormatDefinition(RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT)) :
            0;
        return isPositiveSafeInteger(baseCopyByteLength + (enhancementCopyByteLength * enhancementLayerCount));
    } catch {
        return false;
    }
}

/**
 * Adapts a decoder sample that holds CPU planes to a raw copy source, so its planes are copied without constructing a VideoFrame, which Firefox refuses for high-bit-depth formats such as I420P10.
 * The geometry, timing, and color are those of the VideoFrame VideoSample.toVideoFrame would create; a rotated sample is refused like a rotated VideoFrame.
 */
export function createVideoSampleRawFrameSource(sample: VideoSample): RawVideoFrameSource {
    const durationMicroseconds = sample.microsecondDuration;
    return {
        close: (): void => sample.close(),
        codedHeight: sample.codedHeight,
        codedWidth: sample.codedWidth,
        colorSpace: sample.colorSpace,
        copyTo: (destination: ArrayBuffer, options: VideoFrameCopyToOptions): Promise<PlaneLayout[]> => (
            sample.copyTo(destination, options)
        ),
        displayHeight: sample.squarePixelHeight,
        displayWidth: sample.squarePixelWidth,
        // toVideoFrame omits a zero duration, which the VideoFrame then reports as null
        duration: durationMicroseconds === 0 ? null : durationMicroseconds,
        format: sample.format,
        rotation: sample.rotation,
        timestamp: sample.microsecondTimestamp,
        visibleRect: {
            height: sample.visibleRect.height,
            width: sample.visibleRect.width,
            x: sample.visibleRect.left,
            y: sample.visibleRect.top
        }
    };
}

/**
 * Copies a plane's rows from one stride to another, counted in the elements of each array, in one pass when neither side pads its rows.
 * Both arrays start at the plane's first row, and a destination of bytes narrows 16-bit samples to their low byte.
 */
export function copyRawVideoPlaneRows(
    source: Uint8Array | Uint16Array,
    sourceStride: number,
    destination: Uint8Array | Uint16Array,
    destinationStride: number,
    rowLength: number,
    rowCount: number
): void {
    if (sourceStride === rowLength && destinationStride === rowLength) {
        destination.set(source.subarray(0, rowLength * rowCount));
        return;
    }
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const sourceOffset = rowIndex * sourceStride;
        destination.set(source.subarray(sourceOffset, sourceOffset + rowLength), rowIndex * destinationStride);
    }
}

/** One plane of a software decoder's frame: samples whose rows start a stride apart, from the first sample to the end of the last row, counted in samples. */
export type RawVideoSourcePlane = Readonly<{
    samples: Uint8Array | Uint16Array
    stride: number
}>;

/** What a prepared frame reports: the metadata of the VideoFrame its decoder's sample would make. */
export type PreparedRawVideoFrameMetadata = Readonly<{
    codedHeight: number
    codedWidth: number
    colorSpace: Readonly<RawVideoFrameColorSpace>
    displayHeight: number
    displayWidth: number
    durationMicroseconds: Microseconds
    /** The decoded format, which the planes are written in */
    format: SupportedRawVideoFrameFormat
    timestampMicroseconds: Microseconds
}>;

/** Returns the definition of a format whose planes a decoder's planes map onto one for one, each a single component. */
function getPreparableFormatDefinition(format: SupportedRawVideoFrameFormat, sourcePlaneCount: number): RawVideoFormatDefinition {
    const formatDefinition = getFormatDefinition(format);
    if (
        formatDefinition.planes.length !== sourcePlaneCount
        || formatDefinition.planes.some((plane: RawVideoPlaneDefinition): boolean => plane.componentsPerTexel !== 1)
    ) {
        throw new RawVideoFrameCopyError('unsupported-format', `A decoder's planes cannot be prepared as ${format}`);
    }
    return formatDefinition;
}

/** Writes one decoded plane's rows into its aligned plane, narrowing 16-bit samples to bytes in an 8-bit format. */
function writeSourcePlane(source: RawVideoSourcePlane, plane: RawVideoPlaneDescriptor, data: ArrayBuffer): void {
    if (
        !Number.isSafeInteger(source.stride)
        || source.stride < plane.width
        || source.samples.length !== ((plane.height - 1) * source.stride) + plane.width
    ) {
        throw new RawVideoFrameCopyError('invalid-layout', `The decoded ${plane.kind} plane does not hold its rows`);
    }
    switch (plane.bytesPerComponent) {
        case 1:
            copyRawVideoPlaneRows(
                source.samples,
                source.stride,
                new Uint8Array(data, plane.byteOffset, plane.byteLength),
                plane.bytesPerRow,
                plane.width,
                plane.height
            );
            return;
        case 2:
            copyRawVideoPlaneRows(
                source.samples,
                source.stride,
                new Uint16Array(data, plane.byteOffset, plane.byteLength / Uint16Array.BYTES_PER_ELEMENT),
                plane.bytesPerRow / Uint16Array.BYTES_PER_ELEMENT,
                plane.width,
                plane.height
            );
            return;
    }
}

function isFullCodedRectangle(rectangle: DOMRectInit | undefined, codedWidth: number, codedHeight: number): boolean {
    return rectangle === undefined || (
        (rectangle.x ?? 0) === 0
        && (rectangle.y ?? 0) === 0
        && (rectangle.width ?? codedWidth) === codedWidth
        && (rectangle.height ?? codedHeight) === codedHeight
    );
}

/**
 * A decoded frame whose planes were written, while its decoder still held them, into the aligned layout copyVideoFrameToRawPlanes produces in the frame's own format.
 * A raw transfer of that format and geometry takes its buffer as it is; any other copy reads it through copyTo.
 * Closing a frame that was never taken returns its buffer to its pool.
 */
export class PreparedRawVideoFrameSource implements RawVideoFrameSource {
    public readonly codedHeight: number;
    public readonly codedWidth: number;
    public readonly colorSpace: Readonly<RawVideoFrameColorSpace>;
    public readonly displayHeight: number;
    public readonly displayWidth: number;
    public readonly duration: number | null;
    public readonly format: SupportedRawVideoFrameFormat;
    public readonly timestamp: number;
    public readonly visibleRect: Readonly<RawVideoFrameRectangle>;
    private rawFrame: TransferableRawVideoFrame | null = null;

    private constructor(metadata: PreparedRawVideoFrameMetadata, private readonly bufferPool: RawFrameBufferPool | null) {
        this.codedHeight = metadata.codedHeight;
        this.codedWidth = metadata.codedWidth;
        this.colorSpace = {
            fullRange: metadata.colorSpace.fullRange,
            matrix: metadata.colorSpace.matrix,
            primaries: metadata.colorSpace.primaries,
            transfer: metadata.colorSpace.transfer
        };
        this.displayHeight = metadata.displayHeight;
        this.displayWidth = metadata.displayWidth;
        // A VideoFrame made without a duration reports null, as the one from VideoSample.toVideoFrame does for zero
        this.duration = metadata.durationMicroseconds === 0 ? null : metadata.durationMicroseconds;
        this.format = metadata.format;
        this.timestamp = metadata.timestampMicroseconds;
        this.visibleRect = {
            height: metadata.codedHeight,
            width: metadata.codedWidth,
            x: 0,
            y: 0
        };
    }

    /**
     * Writes a software decoder's planes, in luma then chroma order, into the aligned layout of the frame's format.
     * The buffer comes from the pool, which allocates when no spare fits, or is allocated when there is no pool.
     */
    public static prepare(
        metadata: PreparedRawVideoFrameMetadata,
        planes: readonly RawVideoSourcePlane[],
        bufferPool: RawFrameBufferPool | null
    ): PreparedRawVideoFrameSource {
        const source = new PreparedRawVideoFrameSource(metadata, bufferPool);
        const preparedFrame = prepareFrame(source, getPreparableFormatDefinition(metadata.format, planes.length), undefined);
        const data = allocateRawFrameBuffer(preparedFrame.copyByteLength, bufferPool);
        try {
            for (let planeIndex = 0; planeIndex < planes.length; planeIndex += 1) {
                writeSourcePlane(planes[planeIndex], preparedFrame.planes[planeIndex], data);
            }
        } catch (error) {
            bufferPool?.release(data);
            throw error;
        }
        source.rawFrame = createTransferableRawVideoFrame(source, data, preparedFrame);
        return source;
    }

    /** Returns an untaken buffer to its pool; later calls do nothing. */
    public close(): void {
        const rawFrame = this.rawFrame;
        this.rawFrame = null;
        if (rawFrame) {
            this.bufferPool?.release(rawFrame.data);
        }
    }

    /**
     * Copies the prepared planes into a destination layout, as a VideoFrame copies its own format.
     * Only the full coded rectangle in the frame's own format is offered, which is all a raw copy asks for.
     */
    public async copyTo(destination: ArrayBuffer, options: VideoFrameCopyToOptions): Promise<PlaneLayout[]> {
        const rawFrame = this.requireRawFrame();
        const requestedFormat = (options as { format?: unknown }).format;
        if (requestedFormat !== undefined && requestedFormat !== this.format) {
            throw new TypeError(`A prepared ${this.format} frame cannot be copied as ${String(requestedFormat)}`);
        }
        if (!isFullCodedRectangle(options.rect, this.codedWidth, this.codedHeight)) {
            throw new TypeError('A prepared frame copies only its full coded rectangle');
        }
        const layouts = options.layout;
        if (!layouts || layouts.length !== rawFrame.planes.length) {
            throw new TypeError('A prepared frame copy needs one layout for each plane');
        }

        const copiedLayouts: PlaneLayout[] = [];
        for (let planeIndex = 0; planeIndex < rawFrame.planes.length; planeIndex += 1) {
            const plane = rawFrame.planes[planeIndex];
            const layout = layouts[planeIndex];
            const destinationByteLength = (layout.stride * (plane.height - 1)) + plane.rowByteLength;
            if (
                !isNonNegativeSafeInteger(layout.offset)
                || !Number.isSafeInteger(layout.stride)
                || layout.stride < plane.rowByteLength
                || !Number.isSafeInteger(layout.offset + destinationByteLength)
                || layout.offset + destinationByteLength > destination.byteLength
            ) {
                throw new RangeError(`The prepared ${plane.kind} plane does not fit its destination layout`);
            }
            copyRawVideoPlaneRows(
                new Uint8Array(rawFrame.data, plane.byteOffset, plane.byteLength),
                plane.bytesPerRow,
                new Uint8Array(destination, layout.offset, destinationByteLength),
                layout.stride,
                plane.rowByteLength,
                plane.height
            );
            copiedLayouts.push({ offset: layout.offset, stride: layout.stride });
        }
        return copiedLayouts;
    }

    /**
     * Hands over the prepared frame when it is in format at the expected geometry, after which this source holds nothing.
     * Returns null and keeps the frame when either differs, so the caller copies it instead.
     */
    public takeRawFrame(
        format: SupportedRawVideoFrameFormat,
        expectedGeometry: RawVideoFrameGeometry
    ): TransferableRawVideoFrame | null {
        const rawFrame = this.requireRawFrame();
        if (
            rawFrame.format !== format
            || rawFrame.codedWidth !== expectedGeometry.codedWidth
            || rawFrame.codedHeight !== expectedGeometry.codedHeight
            || rawFrame.displayWidth !== expectedGeometry.displayWidth
            || rawFrame.displayHeight !== expectedGeometry.displayHeight
        ) {
            return null;
        }
        this.rawFrame = null;
        return rawFrame;
    }

    private requireRawFrame(): TransferableRawVideoFrame {
        if (!this.rawFrame) {
            throw new Error('The prepared raw frame is closed');
        }
        return this.rawFrame;
    }
}

/**
 * Takes ownership of one decoded frame, copies its complete coded planar YUV planes in the exposed or requested format, and closes the frame exactly once.
 * The destination comes from the buffer pool when one is given, so the raw presentation cycle reuses its buffers.
 */
export async function copyVideoFrameToRawPlanes(
    frame: RawVideoFrameSource,
    options: RawVideoFrameCopyOptions = {}
): Promise<TransferableRawVideoFrame> {
    try {
        assertNoTransform(frame);
        const format = getFormatDefinition(options.format ?? frame.format);
        const preparedFrame = prepareFrame(frame, format, options.expectedGeometry);
        const data = allocateRawFrameBuffer(preparedFrame.copyByteLength, options.bufferPool);

        let returnedLayouts: PlaneLayout[];
        try {
            returnedLayouts = await copyFrameData(frame, data, preparedFrame, options.format);
        } catch (error) {
            throw new RawVideoFrameCopyError('copy-failed', getErrorMessage(error));
        }
        if (!returnedLayoutsMatch(returnedLayouts, preparedFrame)) {
            throw new RawVideoFrameCopyError(
                'invalid-layout',
                'VideoFrame.copyTo returned a layout that differs from the requested layout'
            );
        }

        return createTransferableRawVideoFrame(frame, data, preparedFrame);
    } finally {
        closeFrame(frame);
    }
}

/**
 * Takes ownership of a decoded BL and optional EL frame and copies both into one fixed-size transferable buffer: the BL in the requested format, then the EL as I420P10 at the next aligned offset.
 * The reserved EL region keeps recycling exact even when the EL decoder degrades and a BL-only frame is emitted.
 */
export async function copyVideoFramePairToRawPlanes(
    baseFrame: RawVideoFrameSource,
    enhancementFrame: RawVideoFrameSource | null,
    options: RawVideoFramePairCopyOptions
): Promise<TransferableRawVideoFramePair> {
    try {
        assertNoTransform(baseFrame);
        if (enhancementFrame) {
            assertNoTransform(enhancementFrame);
            assertEnhancementFrameFormat(enhancementFrame);
        }
        const format = getFormatDefinition(options.format);
        const enhancementFormat = getFormatDefinition(RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT);
        const preparedBaseFrame = prepareFrame(baseFrame, format, options.baseExpectedGeometry);
        const enhancementByteOffset = alignTo(preparedBaseFrame.copyByteLength, RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT);
        const reservedEnhancementByteLength = getRawFrameCopyByteLength(options.enhancementExpectedGeometry, enhancementFormat);
        let preparedEnhancementFrame: PreparedRawVideoFrame | null = null;
        if (enhancementFrame) {
            preparedEnhancementFrame = shiftPreparedFrame(
                prepareFrame(enhancementFrame, enhancementFormat, options.enhancementExpectedGeometry),
                enhancementByteOffset
            );
            if (preparedEnhancementFrame.copyByteLength !== reservedEnhancementByteLength) {
                throw new RawVideoFrameCopyError(
                    'invalid-layout',
                    'The decoded enhancement frame differs from its reserved copy layout'
                );
            }
        }
        const compoundByteLength = enhancementByteOffset + reservedEnhancementByteLength;
        if (!isPositiveSafeInteger(compoundByteLength)) {
            throw new RawVideoFrameCopyError('invalid-dimensions', 'The compound raw VideoFrame copy is not representable');
        }
        const data = allocateRawFrameBuffer(compoundByteLength, options.bufferPool);

        await copyPreparedFrameData(
            baseFrame,
            data,
            preparedBaseFrame,
            options.format,
            'Base VideoFrame.copyTo returned a layout that differs from the requested layout'
        );

        if (enhancementFrame && preparedEnhancementFrame) {
            await copyPreparedFrameData(
                enhancementFrame,
                data,
                preparedEnhancementFrame,
                RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT,
                'Enhancement VideoFrame.copyTo returned a layout that differs from the requested layout'
            );
        }

        return {
            baseFrame: createTransferableRawVideoFrame(baseFrame, data, preparedBaseFrame),
            enhancementFrame: enhancementFrame && preparedEnhancementFrame ?
                createTransferableRawVideoFrame(enhancementFrame, data, preparedEnhancementFrame) :
                null
        };
    } finally {
        closeFrame(baseFrame);
        if (enhancementFrame && enhancementFrame !== baseFrame) {
            closeFrame(enhancementFrame);
        }
    }
}

/** Returns the single-use transfer list for a copied raw frame descriptor. */
export function getRawVideoFrameTransferList(frame: TransferableRawVideoFrame): Transferable[] {
    const transferList: Transferable[] = [];
    transferList.push(frame.data);
    return transferList;
}

/** Returns the one-buffer transfer list for an atomic BL/EL frame pair. */
export function getRawVideoFramePairTransferList(framePair: TransferableRawVideoFramePair): Transferable[] {
    if (framePair.enhancementFrame && framePair.enhancementFrame.data !== framePair.baseFrame.data) {
        throw new TypeError('A compound raw frame pair must share one ArrayBuffer');
    }
    const transferList: Transferable[] = [];
    transferList.push(framePair.baseFrame.data);
    return transferList;
}
