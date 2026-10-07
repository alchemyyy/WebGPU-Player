// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
    createNativeVideoCapabilityVector,
    NATIVE_VIDEO_CAPABILITY_VECTOR_CODED_HEIGHT,
    NATIVE_VIDEO_CAPABILITY_VECTOR_CODED_WIDTH,
    type NativeVideoCapabilityVectorCodec
} from 'webgpu-player/capability/vectors/NativeVideoCapabilityVectors';

const EXPECTED_VECTORS: Readonly<Record<
    NativeVideoCapabilityVectorCodec,
    Readonly<{ byteLength: number, codecString: string }>
>> = Object.freeze({
    av1: Object.freeze({
        byteLength: 24,
        codecString: 'av01.0.08M.08'
    }),
    vp8: Object.freeze({
        byteLength: 38,
        codecString: 'vp8'
    }),
    vp9: Object.freeze({
        byteLength: 33,
        codecString: 'vp09.00.10.08'
    })
});

describe('native video capability vectors', () => {
    it.each(Object.entries(EXPECTED_VECTORS))(
        'creates the exact %s keyframe',
        (codecValue, expectedVector) => {
            const codec = codecValue as NativeVideoCapabilityVectorCodec;
            const vector = createNativeVideoCapabilityVector(codec);

            expect(vector).toMatchObject({
                codec,
                codecString: expectedVector.codecString,
                codedHeight: NATIVE_VIDEO_CAPABILITY_VECTOR_CODED_HEIGHT,
                codedWidth: NATIVE_VIDEO_CAPABILITY_VECTOR_CODED_WIDTH
            });
            expect(vector.encodedKeyFrame).toHaveLength(expectedVector.byteLength);
        }
    );

    it('returns independent mutable byte arrays', () => {
        const firstVector = createNativeVideoCapabilityVector('av1');
        const secondVector = createNativeVideoCapabilityVector('av1');
        const originalFirstByte = secondVector.encodedKeyFrame[0];

        firstVector.encodedKeyFrame[0] ^= 0xFF;

        expect(secondVector.encodedKeyFrame[0]).toBe(originalFirstByte);
    });
});
