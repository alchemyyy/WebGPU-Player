// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
    createNativeVideoCapabilityFixture,
    NATIVE_VIDEO_CAPABILITY_FIXTURE_CODED_HEIGHT,
    NATIVE_VIDEO_CAPABILITY_FIXTURE_CODED_WIDTH,
    type NativeVideoCapabilityFixtureCodec
} from 'webgpu-player/custom/NativeVideoCapabilityFixtures';

const EXPECTED_FIXTURES: Readonly<Record<
    NativeVideoCapabilityFixtureCodec,
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

describe('native video capability fixtures', () => {
    it.each(Object.entries(EXPECTED_FIXTURES))(
        'creates the exact %s keyframe',
        (codecValue, expectedFixture) => {
            const codec = codecValue as NativeVideoCapabilityFixtureCodec;
            const fixture = createNativeVideoCapabilityFixture(codec);

            expect(fixture).toMatchObject({
                codec,
                codecString: expectedFixture.codecString,
                codedHeight: NATIVE_VIDEO_CAPABILITY_FIXTURE_CODED_HEIGHT,
                codedWidth: NATIVE_VIDEO_CAPABILITY_FIXTURE_CODED_WIDTH
            });
            expect(fixture.encodedKeyFrame).toHaveLength(expectedFixture.byteLength);
        }
    );

    it('returns independent mutable byte arrays', () => {
        const firstFixture = createNativeVideoCapabilityFixture('av1');
        const secondFixture = createNativeVideoCapabilityFixture('av1');
        const originalFirstByte = secondFixture.encodedKeyFrame[0];

        firstFixture.encodedKeyFrame[0] ^= 0xFF;

        expect(secondFixture.encodedKeyFrame[0]).toBe(originalFirstByte);
    });
});
