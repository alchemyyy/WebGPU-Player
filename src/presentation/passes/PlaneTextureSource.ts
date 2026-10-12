// The plane route's ingress: raw frame layout validation, one integer texture per plane, and the plane uploads.
import {
    RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT,
    type RawVideoPlaneDescriptor,
    type RawVideoPlaneKind,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from '../../video/RawVideoFrameCopy';

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

function hasValidFrameGeometry(frame: TransferableRawVideoFrame): boolean {
    const rectangle = frame.visibleRectangle;
    const geometry = getPlanarFormatGeometry(frame.format);
    const integerValues = [
        frame.codedHeight,
        frame.codedWidth,
        frame.displayHeight,
        frame.displayWidth,
        rectangle.height,
        rectangle.width,
        rectangle.x,
        rectangle.y
    ];
    return integerValues.every((value: number): boolean => Number.isSafeInteger(value))
        && frame.codedHeight > 0
        && frame.codedWidth > 0
        && frame.displayHeight > 0
        && frame.displayWidth > 0
        && rectangle.height > 0
        && rectangle.width > 0
        && rectangle.x >= 0
        && rectangle.y >= 0
        && rectangle.x % geometry.chromaWidthDivisor === 0
        && rectangle.y % geometry.chromaHeightDivisor === 0
        && rectangle.x + rectangle.width <= frame.codedWidth
        && rectangle.y + rectangle.height <= frame.codedHeight;
}

function planeMatches(plane: RawVideoPlaneDescriptor, expectedPlane: ExpectedPlane, expectedByteOffset: number): boolean {
    const rowByteLength = expectedPlane.width * expectedPlane.componentsPerTexel * expectedPlane.bytesPerComponent;
    const bytesPerRow = alignBytesPerRow(rowByteLength);
    return plane.byteLength === bytesPerRow * expectedPlane.height
        && plane.byteOffset === expectedByteOffset
        && plane.bytesPerComponent === expectedPlane.bytesPerComponent
        && plane.bytesPerRow === bytesPerRow
        && plane.componentsPerTexel === expectedPlane.componentsPerTexel
        && plane.height === expectedPlane.height
        && plane.kind === expectedPlane.kind
        && plane.rowByteLength === rowByteLength
        && plane.width === expectedPlane.width;
}

/** Returns whether a raw frame has the exact padded plane layout the uploads read: planes in order, back to back, at aligned rows. */
export function hasValidRawPlaneLayout(frame: TransferableRawVideoFrame): boolean {
    if (!hasValidFrameGeometry(frame)) {
        return false;
    }
    const expectedPlanes = createExpectedPlanes(frame.format, frame.codedWidth, frame.codedHeight);
    const firstPlane = frame.planes[0];
    if (
        frame.planes.length !== expectedPlanes.length
        || !firstPlane
        || !Number.isSafeInteger(firstPlane.byteOffset)
        || firstPlane.byteOffset < 0
        || firstPlane.byteOffset % RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT !== 0
    ) {
        return false;
    }
    let expectedByteOffset = firstPlane.byteOffset;
    for (let planeIndex = 0; planeIndex < expectedPlanes.length; planeIndex += 1) {
        const plane = frame.planes[planeIndex];
        if (!planeMatches(plane, expectedPlanes[planeIndex], expectedByteOffset)) {
            return false;
        }
        expectedByteOffset += plane.byteLength;
    }
    return Number.isSafeInteger(expectedByteOffset)
        && expectedByteOffset > firstPlane.byteOffset
        && expectedByteOffset <= frame.data.byteLength;
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
            return plane.componentsPerTexel === 2 ? 'rg8uint' : 'r8uint';
        case 2:
            return plane.componentsPerTexel === 2 ? 'rg16uint' : 'r16uint';
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
                throw new RangeError('Raw video plane exceeds the GPU texture limit');
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
            throw new Error('Raw video plane texture order changed unexpectedly');
        }
        device.queue.writeTexture(
            { texture: planeTexture.texture },
            frame.data,
            { bytesPerRow: plane.bytesPerRow, offset: plane.byteOffset, rowsPerImage: plane.height },
            { height: plane.height, width: plane.width }
        );
    }
}
