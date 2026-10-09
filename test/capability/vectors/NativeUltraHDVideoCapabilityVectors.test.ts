// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
    createNativeUltraHDVideoCapabilityVector,
    NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODECS,
    NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODED_HEIGHT,
    NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODED_WIDTH,
    type NativeUltraHDVideoCapabilityVectorCodec
} from 'webgpu-player/capability/vectors/NativeUltraHDVideoCapabilityVectors';

type ExpectedVector = Readonly<{
    byteLength: number
    codecString: string
}>;

const EXPECTED_VECTORS: Readonly<Record<NativeUltraHDVideoCapabilityVectorCodec, ExpectedVector>> = Object.freeze({
    av1: Object.freeze({
        byteLength: 49,
        codecString: 'av01.0.12M.08'
    }),
    hevc: Object.freeze({
        byteLength: 2_086,
        codecString: 'hvc1.1.6.L153.B0'
    }),
    vp9: Object.freeze({
        byteLength: 731,
        codecString: 'vp09.00.51.08'
    })
});

describe('native Ultra HD video capability vectors', () => {
    it.each(NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODECS)(
        'creates the exact %s 3840x2160 keyframe',
        codec => {
            const expectedVector: ExpectedVector = EXPECTED_VECTORS[codec];
            const vector = createNativeUltraHDVideoCapabilityVector(codec);

            expect(vector).toMatchObject({
                codec,
                codecString: expectedVector.codecString,
                codedHeight: NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODED_HEIGHT,
                codedWidth: NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODED_WIDTH
            });
            expect(vector.encodedKeyFrame).toHaveLength(expectedVector.byteLength);
        }
    );

    it('returns independent mutable keyframe arrays', () => {
        const firstVector = createNativeUltraHDVideoCapabilityVector('hevc');
        const secondVector = createNativeUltraHDVideoCapabilityVector('hevc');
        const originalFirstByte: number = secondVector.encodedKeyFrame[0];

        firstVector.encodedKeyFrame[0] ^= 0xFF;

        expect(secondVector.encodedKeyFrame[0]).toBe(originalFirstByte);
    });
});
