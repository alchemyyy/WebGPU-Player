import { describe, expect, it } from 'vitest';

import {
    DecodedVideoGeometryError,
    exceedsNegotiatedCodedSize,
    requireConsistentDecodedVideoGeometry
} from 'webgpu-player/custom/DecodedVideoGeometry';
import type { RawVideoFrameGeometry } from 'webgpu-player/custom/RawVideoFrameCopy';

const SELECTED_TRACK_GEOMETRY: RawVideoFrameGeometry = {
    codedHeight: 180,
    codedWidth: 320,
    displayHeight: 180,
    displayWidth: 320
};

describe('exceedsNegotiatedCodedSize', () => {
    it('accepts block-aligned coded sizes above a cropped route', () => {
        // A 2076-line letterboxed HEVC picture is coded as 2080 lines
        expect(exceedsNegotiatedCodedSize(3_840, 2_080, 3_840, 2_076)).toBe(false);
        expect(exceedsNegotiatedCodedSize(1_920, 1_088, 1_920, 1_080)).toBe(false);
        expect(exceedsNegotiatedCodedSize(1_984, 1_144, 1_920, 1_080)).toBe(false);
    });

    it('rejects coded sizes beyond the alignment tolerance in either dimension', () => {
        expect(exceedsNegotiatedCodedSize(1_985, 1_080, 1_920, 1_080)).toBe(true);
        expect(exceedsNegotiatedCodedSize(1_920, 1_145, 1_920, 1_080)).toBe(true);
        expect(exceedsNegotiatedCodedSize(3_840, 2_160, 3_840, 2_076)).toBe(true);
    });
});

describe('requireConsistentDecodedVideoGeometry', () => {
    it('accepts bounded coded-frame padding and locks the actual geometry', () => {
        const decodedGeometry: RawVideoFrameGeometry = {
            codedHeight: 194,
            codedWidth: 320,
            displayHeight: 180,
            displayWidth: 320
        };

        const lockedGeometry = requireConsistentDecodedVideoGeometry(
            decodedGeometry,
            SELECTED_TRACK_GEOMETRY,
            1_920,
            1_080,
            null
        );

        expect(lockedGeometry).toEqual(decodedGeometry);
        expect(lockedGeometry).not.toBe(decodedGeometry);
        expect(requireConsistentDecodedVideoGeometry(
            decodedGeometry,
            SELECTED_TRACK_GEOMETRY,
            1_920,
            1_080,
            lockedGeometry
        )).toBe(lockedGeometry);
    });

    it('accepts a bounded decoder-applied display crop', () => {
        const decodedGeometry: RawVideoFrameGeometry = {
            codedHeight: 180,
            codedWidth: 320,
            displayHeight: 176,
            displayWidth: 320
        };

        expect(requireConsistentDecodedVideoGeometry(
            decodedGeometry,
            SELECTED_TRACK_GEOMETRY,
            1_920,
            1_080,
            null
        )).toEqual(decodedGeometry);
    });

    it('rejects decoded display geometry outside the track tolerance', () => {
        expect(() => requireConsistentDecodedVideoGeometry(
            {
                codedHeight: 260,
                codedWidth: 320,
                displayHeight: 245,
                displayWidth: 320
            },
            SELECTED_TRACK_GEOMETRY,
            1_920,
            1_080,
            null
        )).toThrowError(new DecodedVideoGeometryError(
            'Decoded frame display geometry exceeds the selected video track tolerance'
        ));
    });

    it('rejects decoded coded geometry above the negotiated maximum', () => {
        expect(() => requireConsistentDecodedVideoGeometry(
            {
                codedHeight: 1_088,
                codedWidth: 1_920,
                displayHeight: 180,
                displayWidth: 320
            },
            SELECTED_TRACK_GEOMETRY,
            1_920,
            1_080,
            null
        )).toThrowError(new DecodedVideoGeometryError(
            'Decoded frame coded geometry exceeds its negotiated decode route'
        ));
    });

    it('accepts bounded decoder padding above a full route dimension', () => {
        const selectedTrackGeometry: RawVideoFrameGeometry = {
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        };
        const decodedGeometry: RawVideoFrameGeometry = {
            codedHeight: 1_088,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        };

        expect(requireConsistentDecodedVideoGeometry(
            decodedGeometry,
            selectedTrackGeometry,
            1_920,
            1_080,
            null
        )).toEqual(decodedGeometry);
    });

    it('accepts a block-aligned selected track above a cropped route', () => {
        const selectedTrackGeometry: RawVideoFrameGeometry = {
            codedHeight: 2_080,
            codedWidth: 3_840,
            displayHeight: 2_080,
            displayWidth: 3_840
        };
        const decodedGeometry: RawVideoFrameGeometry = {
            codedHeight: 2_080,
            codedWidth: 3_840,
            displayHeight: 2_076,
            displayWidth: 3_840
        };

        expect(requireConsistentDecodedVideoGeometry(
            decodedGeometry,
            selectedTrackGeometry,
            3_840,
            2_076,
            null
        )).toEqual(decodedGeometry);
    });

    it('rejects a selected track coded beyond the cropped route tolerance', () => {
        const oversizedGeometry: RawVideoFrameGeometry = {
            codedHeight: 2_160,
            codedWidth: 3_840,
            displayHeight: 2_160,
            displayWidth: 3_840
        };

        expect(() => requireConsistentDecodedVideoGeometry(
            oversizedGeometry,
            oversizedGeometry,
            3_840,
            2_076,
            null
        )).toThrowError(new DecodedVideoGeometryError(
            'Decoded frame coded geometry exceeds its negotiated decode route'
        ));
    });

    it('rejects geometry changes after the first decoded frame', () => {
        const lockedGeometry: RawVideoFrameGeometry = {
            codedHeight: 194,
            codedWidth: 320,
            displayHeight: 180,
            displayWidth: 320
        };

        expect(() => requireConsistentDecodedVideoGeometry(
            {
                ...lockedGeometry,
                codedHeight: 196
            },
            SELECTED_TRACK_GEOMETRY,
            1_920,
            1_080,
            lockedGeometry
        )).toThrowError(new DecodedVideoGeometryError(
            'Decoded frame geometry changed after the first decoded frame'
        ));
    });
});
