import type { RawVideoFrameGeometry } from './RawVideoFrameCopy';

// Covers codec block alignment and decoder surface padding; HEVC coding blocks reach 64 px
const MAXIMUM_DECODER_CODED_PADDING = 64;

/** Describes a decoded frame geometry violation at the worker boundary. */
export class DecodedVideoGeometryError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'DecodedVideoGeometryError';
    }
}

function isPositiveSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

function geometriesMatch(firstGeometry: RawVideoFrameGeometry, secondGeometry: RawVideoFrameGeometry): boolean {
    return firstGeometry.codedHeight === secondGeometry.codedHeight
        && firstGeometry.codedWidth === secondGeometry.codedWidth
        && firstGeometry.displayHeight === secondGeometry.displayHeight
        && firstGeometry.displayWidth === secondGeometry.displayWidth;
}

/**
 * Returns whether a coded size exceeds its negotiated decode route.
 * Routes are negotiated from the server's cropped picture size, while containers and decoders report the block-aligned coded size, such as 2080 lines for a 2076-line HEVC picture.
 */
export function exceedsNegotiatedCodedSize(
    codedWidth: number,
    codedHeight: number,
    maximumCodedWidth: number,
    maximumCodedHeight: number
): boolean {
    return codedWidth - maximumCodedWidth > MAXIMUM_DECODER_CODED_PADDING
        || codedHeight - maximumCodedHeight > MAXIMUM_DECODER_CODED_PADDING;
}

/**
 * Accepts decoder padding while locking the first decoded geometry for the remainder of a playback generation.
 */
export function requireConsistentDecodedVideoGeometry(
    candidateGeometry: RawVideoFrameGeometry,
    selectedTrackGeometry: RawVideoFrameGeometry,
    maximumCodedWidth: number,
    maximumCodedHeight: number,
    lockedGeometry: RawVideoFrameGeometry | null
): RawVideoFrameGeometry {
    const dimensions = [
        candidateGeometry.codedHeight,
        candidateGeometry.codedWidth,
        candidateGeometry.displayHeight,
        candidateGeometry.displayWidth,
        selectedTrackGeometry.displayHeight,
        selectedTrackGeometry.displayWidth,
        selectedTrackGeometry.codedHeight,
        selectedTrackGeometry.codedWidth,
        maximumCodedHeight,
        maximumCodedWidth
    ];
    if (!dimensions.every(isPositiveSafeInteger)) {
        throw new DecodedVideoGeometryError('Decoded frame geometry is invalid');
    }
    if (
        Math.abs(candidateGeometry.displayWidth - selectedTrackGeometry.displayWidth) > MAXIMUM_DECODER_CODED_PADDING
        || Math.abs(candidateGeometry.displayHeight - selectedTrackGeometry.displayHeight) > MAXIMUM_DECODER_CODED_PADDING
    ) {
        throw new DecodedVideoGeometryError('Decoded frame display geometry exceeds the selected video track tolerance');
    }
    if (
        exceedsNegotiatedCodedSize(selectedTrackGeometry.codedWidth, selectedTrackGeometry.codedHeight, maximumCodedWidth, maximumCodedHeight)
        || candidateGeometry.codedWidth - selectedTrackGeometry.codedWidth > MAXIMUM_DECODER_CODED_PADDING
        || candidateGeometry.codedHeight - selectedTrackGeometry.codedHeight > MAXIMUM_DECODER_CODED_PADDING
    ) {
        throw new DecodedVideoGeometryError('Decoded frame coded geometry exceeds its negotiated decode route');
    }
    if (lockedGeometry !== null) {
        if (!geometriesMatch(candidateGeometry, lockedGeometry)) {
            throw new DecodedVideoGeometryError('Decoded frame geometry changed after the first decoded frame');
        }
        return lockedGeometry;
    }

    return { ...candidateGeometry };
}
