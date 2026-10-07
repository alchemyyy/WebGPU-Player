// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
    createRawHDRCapabilityVector,
    RAW_HDR_CAPABILITY_VECTOR_CODED_HEIGHT,
    RAW_HDR_CAPABILITY_VECTOR_CODED_WIDTH
} from 'webgpu-player/capability/vectors/RawHDRCapabilityVectors';

const AV1_EXPECTED_BYTE_LENGTH = 806;
const EXPECTED_DECODED_FRAME_FINGERPRINT = 4_080_076_472;
const VP9_EXPECTED_BYTE_LENGTH = 2_957;

describe('raw HDR capability vectors', () => {
    it('creates the exact 4K AV1 Main10 keyframe', () => {
        const vector = createRawHDRCapabilityVector('av1');

        expect(vector).toMatchObject({
            codec: 'av1',
            codecString: 'av01.0.08M.10',
            codedHeight: RAW_HDR_CAPABILITY_VECTOR_CODED_HEIGHT,
            codedWidth: RAW_HDR_CAPABILITY_VECTOR_CODED_WIDTH,
            decodedFrameFingerprint: EXPECTED_DECODED_FRAME_FINGERPRINT
        });
        expect(vector.encodedKeyFrame).toHaveLength(AV1_EXPECTED_BYTE_LENGTH);
    });

    it('creates the exact 4K VP9 Profile 2 keyframe', () => {
        const vector = createRawHDRCapabilityVector('vp9');

        expect(vector).toMatchObject({
            codec: 'vp9',
            codecString: 'vp09.02.10.10',
            codedHeight: RAW_HDR_CAPABILITY_VECTOR_CODED_HEIGHT,
            codedWidth: RAW_HDR_CAPABILITY_VECTOR_CODED_WIDTH,
            decodedFrameFingerprint: EXPECTED_DECODED_FRAME_FINGERPRINT
        });
        expect(vector.encodedKeyFrame).toHaveLength(VP9_EXPECTED_BYTE_LENGTH);
    });

    it('returns independent mutable byte arrays', () => {
        const firstVector = createRawHDRCapabilityVector('av1');
        const secondVector = createRawHDRCapabilityVector('av1');
        const originalFirstByte = secondVector.encodedKeyFrame[0];

        firstVector.encodedKeyFrame[0] ^= 0xFF;

        expect(secondVector.encodedKeyFrame[0]).toBe(originalFirstByte);
    });
});
