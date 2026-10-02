// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
    createNativeUltraHDVideoCapabilityFixture,
    NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODECS,
    NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODED_HEIGHT,
    NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODED_WIDTH,
    type NativeUltraHDVideoCapabilityFixtureCodec
} from 'webgpu-player/custom/NativeUltraHDVideoCapabilityFixtures';

type ExpectedFixture = Readonly<{
    byteLength: number
    codecString: string
}>;

const EXPECTED_FIXTURES: Readonly<Record<
    NativeUltraHDVideoCapabilityFixtureCodec,
    ExpectedFixture
>> = Object.freeze({
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

describe('native Ultra HD video capability fixtures', () => {
    it.each(NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODECS)(
        'creates the exact %s 3840x2160 keyframe',
        codec => {
            const expectedFixture: ExpectedFixture = EXPECTED_FIXTURES[codec];
            const fixture = createNativeUltraHDVideoCapabilityFixture(codec);

            expect(fixture).toMatchObject({
                codec,
                codecString: expectedFixture.codecString,
                codedHeight: NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODED_HEIGHT,
                codedWidth: NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODED_WIDTH
            });
            expect(fixture.encodedKeyFrame).toHaveLength(expectedFixture.byteLength);
        }
    );

    it('returns independent mutable keyframe arrays', () => {
        const firstFixture = createNativeUltraHDVideoCapabilityFixture('hevc');
        const secondFixture = createNativeUltraHDVideoCapabilityFixture('hevc');
        const originalFirstByte: number = secondFixture.encodedKeyFrame[0];

        firstFixture.encodedKeyFrame[0] ^= 0xFF;

        expect(secondFixture.encodedKeyFrame[0]).toBe(originalFirstByte);
    });
});
