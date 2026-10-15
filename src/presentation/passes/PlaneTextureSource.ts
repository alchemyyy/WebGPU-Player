// The plane route's ingress: raw frame layout validation, one integer texture per plane, and the plane uploads.
import {
    RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT,
    type RawVideoPlaneDescriptor,
    type RawVideoPlaneKind,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from '../../decode/video/RawVideoFrameCopy';
import { PLANE_R16_FORMAT, PLANE_R8_FORMAT, PLANE_RG16_FORMAT, PLANE_RG8_FORMAT } from '../WebGPUConstants';

/** One plane's texture, whose sample type is uint whatever its bit depth. */
export type PlaneTexture = {
    kind: RawVideoPlaneKind
    texture: GPUTexture
    view: GPUTextureView
};

/** The textures of one frame layer, reused while its format and coded size hold. */
export type PlaneTextureSet = {
    codedHeight: number
    codedWidth: number
    format: SupportedRawVideoFrameFormat
    planes: readonly PlaneTexture[]
};

type ExpectedPlane = {
    bytesPerComponent: 1 | 2
    componentsPerTexel: 1 | 2
    height: number
    kind: RawVideoPlaneKind
    width: number
};

type PlanarFormatGeometry = {
    bytesPerComponent: 1 | 2
    chromaHeightDivisor: 1 | 2
    chromaWidthDivisor: 1 | 2
};

function getPlanarFormatGeometry(format: SupportedRawVideoFrameFormat): PlanarFormatGeometry {
    switch (format) {
        case 'I420':
        case 'NV12':
            return { bytesPerComponent: 1, chromaHeightDivisor: 2, chromaWidthDivisor: 2 };
        case 'I420P10':
        case 'I420P12':
            return { bytesPerComponent: 2, chromaHeightDivisor: 2, chromaWidthDivisor: 2 };
        case 'I422':
            return { bytesPerComponent: 1, chromaHeightDivisor: 1, chromaWidthDivisor: 2 };
        case 'I422P10':
        case 'I422P12':
            return { bytesPerComponent: 2, chromaHeightDivisor: 1, chromaWidthDivisor: 2 };
        case 'I444':
            return { bytesPerComponent: 1, chromaHeightDivisor: 1, chromaWidthDivisor: 1 };
        case 'I444P10':
        case 'I444P12':
            return { bytesPerComponent: 2, chromaHeightDivisor: 1, chromaWidthDivisor: 1 };
    }
}

function createExpectedPlanes(format: SupportedRawVideoFrameFormat, codedWidth: number, codedHeight: number): readonly ExpectedPlane[] {
    const geometry = getPlanarFormatGeometry(format);
    const bytesPerComponent = geometry.bytesPerComponent;
    const chromaWidth = Math.ceil(codedWidth / geometry.chromaWidthDivisor);
    const chromaHeight = Math.ceil(codedHeight / geometry.chromaHeightDivisor);
    const expectedPlanes: ExpectedPlane[] = [];
    expectedPlanes.push({ bytesPerComponent, componentsPerTexel: 1, height: codedHeight, kind: 'y', width: codedWidth });
    // NV12 interleaves U and V in one two-component plane
    if (format === 'NV12') {
        expectedPlanes.push({ bytesPerComponent, componentsPerTexel: 2, height: chromaHeight, kind: 'uv', width: chromaWidth });
        return expectedPlanes;
    }
    expectedPlanes.push(
        { bytesPerComponent, componentsPerTexel: 1, height: chromaHeight, kind: 'u', width: chromaWidth },
        { bytesPerComponent, componentsPerTexel: 1, height: chromaHeight, kind: 'v', width: chromaWidth }
    );
    return expectedPlanes;
}

function alignBytesPerRow(rowByteLength: number): number {
    return Math.ceil(rowByteLength / RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT) * RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT;
}

/** Returns the frame geometry check that fails, as `geometry: <detail>`, or null. */
function getFrameGeometryFailure(frame: TransferableRawVideoFrame): string | null {
    const rectangle = frame.visibleRectangle;
    const geometry = getPlanarFormatGeometry(frame.format);
    const positiveValues: readonly (readonly [string, number])[] = [
        [ 'codedWidth', frame.codedWidth ],
        [ 'codedHeight', frame.codedHeight ],
        [ 'displayWidth', frame.displayWidth ],
        [ 'displayHeight', frame.displayHeight ],
        [ 'visible width', rectangle.width ],
        [ 'visible height', rectangle.height ]
    ];
    for (const [ name, value ] of positiveValues) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            return `geometry: ${name} ${value} is not a positive integer`;
        }
    }
    if (!Number.isSafeInteger(rectangle.x) || !Number.isSafeInteger(rectangle.y) || rectangle.x < 0 || rectangle.y < 0) {
        return `geometry: visible origin ${rectangle.x},${rectangle.y} is not a non-negative integer`;
    }
    if (rectangle.x % geometry.chromaWidthDivisor !== 0 || rectangle.y % geometry.chromaHeightDivisor !== 0) {
        return `geometry: visible origin ${rectangle.x},${rectangle.y} is not chroma-aligned for ${frame.format}`;
    }
    if (rectangle.x + rectangle.width > frame.codedWidth || rectangle.y + rectangle.height > frame.codedHeight) {
        return `geometry: visible ${rectangle.x},${rectangle.y} ${rectangle.width}x${rectangle.height} exceeds coded ${frame.codedWidth}x${frame.codedHeight}`;
    }
    return null;
}

/** Returns the first field of a plane that differs from the layout the uploads read, as `plane <kind>: <field> <actual>, expected <value>`. */
function getPlaneFailure(plane: RawVideoPlaneDescriptor, expectedPlane: ExpectedPlane, expectedByteOffset: number): string | null {
    const rowByteLength = expectedPlane.width * expectedPlane.componentsPerTexel * expectedPlane.bytesPerComponent;
    const bytesPerRow = alignBytesPerRow(rowByteLength);
    const fields: readonly (readonly [string, number | string, number | string])[] = [
        [ 'kind', plane.kind, expectedPlane.kind ],
        [ 'width', plane.width, expectedPlane.width ],
        [ 'height', plane.height, expectedPlane.height ],
        [ 'componentsPerTexel', plane.componentsPerTexel, expectedPlane.componentsPerTexel ],
        [ 'bytesPerComponent', plane.bytesPerComponent, expectedPlane.bytesPerComponent ],
        [ 'rowByteLength', plane.rowByteLength, rowByteLength ],
        [ 'bytesPerRow', plane.bytesPerRow, bytesPerRow ],
        [ 'byteOffset', plane.byteOffset, expectedByteOffset ],
        [ 'byteLength', plane.byteLength, bytesPerRow * expectedPlane.height ]
    ];
    for (const [ field, actual, expected ] of fields) {
        if (actual !== expected) {
            return `plane ${expectedPlane.kind}: ${field} ${actual}, expected ${expected}`;
        }
    }
    return null;
}

/**
 * Returns which check a raw frame's layout fails, as a terse `<check>: <detail>`, or null for the exact layout the uploads read.
 * That layout is the planes in order, back to back from an aligned offset, at aligned rows, inside the frame's buffer.
 */
export function getRawPlaneLayoutFailure(frame: TransferableRawVideoFrame): string | null {
    const geometryFailure = getFrameGeometryFailure(frame);
    if (geometryFailure !== null) {
        return geometryFailure;
    }
    const expectedPlanes = createExpectedPlanes(frame.format, frame.codedWidth, frame.codedHeight);
    if (frame.planes.length !== expectedPlanes.length) {
        return `plane-count: ${frame.planes.length}, expected ${expectedPlanes.length}`;
    }
    const firstByteOffset = frame.planes[0].byteOffset;
    if (!Number.isSafeInteger(firstByteOffset) || firstByteOffset < 0 || firstByteOffset % RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT !== 0) {
        return `plane-offset: ${firstByteOffset} is not a multiple of ${RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT}`;
    }
    let expectedByteOffset = firstByteOffset;
    for (let planeIndex = 0; planeIndex < expectedPlanes.length; planeIndex += 1) {
        const plane = frame.planes[planeIndex];
        const planeFailure = getPlaneFailure(plane, expectedPlanes[planeIndex], expectedByteOffset);
        if (planeFailure !== null) {
            return planeFailure;
        }
        expectedByteOffset += plane.byteLength;
    }
    if (expectedByteOffset > frame.data.byteLength) {
        return `buffer-length: planes end at ${expectedByteOffset}, buffer holds ${frame.data.byteLength}`;
    }
    return null;
}

/** Returns whether a raw frame has the exact padded plane layout the uploads read. */
export function hasValidRawPlaneLayout(frame: TransferableRawVideoFrame): boolean {
    return getRawPlaneLayoutFailure(frame) === null;
}

/** Returns whether a texture set holds a frame's format at its coded size, so the frame uploads into it. */
export function isPlaneTextureSetCompatible(
    textureSet: PlaneTextureSet | null,
    frame: TransferableRawVideoFrame
): textureSet is PlaneTextureSet {
    return textureSet !== null
        && textureSet.format === frame.format
        && textureSet.codedHeight === frame.codedHeight
        && textureSet.codedWidth === frame.codedWidth;
}

function getPlaneTextureFormat(plane: RawVideoPlaneDescriptor): GPUTextureFormat {
    switch (plane.bytesPerComponent) {
        case 1:
            return plane.componentsPerTexel === 2 ? PLANE_RG8_FORMAT : PLANE_R8_FORMAT;
        case 2:
            return plane.componentsPerTexel === 2 ? PLANE_RG16_FORMAT : PLANE_R16_FORMAT;
    }
}

/** Destroys a texture set's textures. */
export function destroyPlaneTextureSet(textureSet: PlaneTextureSet | null): void {
    if (!textureSet) {
        return;
    }
    for (const plane of textureSet.planes) {
        plane.texture.destroy();
    }
}

/** Creates one integer texture per plane of a validated frame; on failure, it destroys the textures it created. */
export function createPlaneTextureSet(device: GPUDevice, frame: TransferableRawVideoFrame, label: string): PlaneTextureSet {
    const maximumTextureDimension = device.limits.maxTextureDimension2D;
    const planes: PlaneTexture[] = [];
    try {
        for (const plane of frame.planes) {
            if (plane.width > maximumTextureDimension || plane.height > maximumTextureDimension) {
                throw new RangeError(`plane-size: ${plane.kind} ${plane.width}x${plane.height} exceeds ${maximumTextureDimension}`);
            }
            const texture = device.createTexture({
                format: getPlaneTextureFormat(plane),
                label: `${label} ${plane.kind.toUpperCase()} plane`,
                size: { height: plane.height, width: plane.width },
                usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING
            });
            planes.push({ kind: plane.kind, texture, view: texture.createView() });
        }
    } catch (error) {
        destroyPlaneTextureSet({ codedHeight: frame.codedHeight, codedWidth: frame.codedWidth, format: frame.format, planes });
        throw error;
    }
    return { codedHeight: frame.codedHeight, codedWidth: frame.codedWidth, format: frame.format, planes };
}

/** Uploads every plane of a frame into a compatible texture set with queue.writeTexture, straight from the frame's buffer. */
export function uploadPlanes(device: GPUDevice, textureSet: PlaneTextureSet, frame: TransferableRawVideoFrame): void {
    for (let planeIndex = 0; planeIndex < frame.planes.length; planeIndex += 1) {
        const plane = frame.planes[planeIndex];
        const planeTexture = textureSet.planes[planeIndex];
        if (planeTexture.kind !== plane.kind) {
            throw new Error(`plane-order: plane ${planeIndex} is ${plane.kind}, its texture holds ${planeTexture.kind}`);
        }
        device.queue.writeTexture(
            { texture: planeTexture.texture },
            frame.data,
            { bytesPerRow: plane.bytesPerRow, offset: plane.byteOffset, rowsPerImage: plane.height },
            { height: plane.height, width: plane.width }
        );
    }
}
