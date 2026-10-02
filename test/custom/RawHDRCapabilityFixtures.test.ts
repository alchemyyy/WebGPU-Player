// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
    createRawHDRCapabilityFixture,
    RAW_HDR_CAPABILITY_FIXTURE_CODED_HEIGHT,
    RAW_HDR_CAPABILITY_FIXTURE_CODED_WIDTH
} from 'webgpu-player/custom/RawHDRCapabilityFixtures';

const AV1_EXPECTED_BYTE_LENGTH = 806;
const EXPECTED_DECODED_FRAME_FINGERPRINT = 4_080_076_472;
const VP9_EXPECTED_BYTE_LENGTH = 2_957;

describe('raw HDR capability fixtures', () => {
    it('creates the exact 4K AV1 Main10 keyframe', () => {
        const fixture = createRawHDRCapabilityFixture('av1');

        expect(fixture).toMatchObject({
            codec: 'av1',
            codecString: 'av01.0.08M.10',
            codedHeight: RAW_HDR_CAPABILITY_FIXTURE_CODED_HEIGHT,
            codedWidth: RAW_HDR_CAPABILITY_FIXTURE_CODED_WIDTH,
            decodedFrameFingerprint: EXPECTED_DECODED_FRAME_FINGERPRINT
        });
        expect(fixture.encodedKeyFrame).toHaveLength(AV1_EXPECTED_BYTE_LENGTH);
    });

    it('creates the exact 4K VP9 Profile 2 keyframe', () => {
        const fixture = createRawHDRCapabilityFixture('vp9');

        expect(fixture).toMatchObject({
            codec: 'vp9',
            codecString: 'vp09.02.10.10',
            codedHeight: RAW_HDR_CAPABILITY_FIXTURE_CODED_HEIGHT,
            codedWidth: RAW_HDR_CAPABILITY_FIXTURE_CODED_WIDTH,
            decodedFrameFingerprint: EXPECTED_DECODED_FRAME_FINGERPRINT
        });
        expect(fixture.encodedKeyFrame).toHaveLength(VP9_EXPECTED_BYTE_LENGTH);
    });

    it('returns independent mutable byte arrays', () => {
        const firstFixture = createRawHDRCapabilityFixture('av1');
        const secondFixture = createRawHDRCapabilityFixture('av1');
        const originalFirstByte = secondFixture.encodedKeyFrame[0];

        firstFixture.encodedKeyFrame[0] ^= 0xFF;

        expect(secondFixture.encodedKeyFrame[0]).toBe(originalFirstByte);
    });
});
