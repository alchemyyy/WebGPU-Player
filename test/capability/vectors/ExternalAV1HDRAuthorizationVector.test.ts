import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    createExternalAV1HDRAuthorizationTemporalUnit,
    EXTERNAL_AV1_HDR_AUTHORIZATION_CODEC,
    EXTERNAL_AV1_HDR_AUTHORIZATION_CODED_HEIGHT,
    EXTERNAL_AV1_HDR_AUTHORIZATION_CODED_WIDTH,
    EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_SAMPLES,
    EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_SHA256
} from 'webgpu-player/capability/vectors/ExternalAV1HDRAuthorizationVector';
import { parseAV1OBUs } from 'webgpu-player/demux/av1/AV1OBUParser';
import { findAV1SequenceHeader } from 'webgpu-player/demux/av1/AV1SequenceHeaderParser';

describe('ExternalAV1HDRAuthorizationVector', () => {
    it('contains one 10-bit limited BT.2020 PQ temporal unit of the declared size and codec', () => {
        const temporalUnit = createExternalAV1HDRAuthorizationTemporalUnit();
        const sequenceHeader = findAV1SequenceHeader(temporalUnit);

        // The runtime shader signature embeds this digest, so it must describe the embedded bytes
        expect(EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_SHA256).toBe(createHash('sha256').update(temporalUnit).digest('hex'));
        expect(parseAV1OBUs(temporalUnit).map(obu => obu.type)).toEqual([ 2, 1, 6 ]);
        expect(sequenceHeader).toMatchObject({
            colorConfig: {
                bitDepth: 10,
                colorDescriptionPresent: true,
                colorPrimaries: 9,
                fullRange: false,
                matrixCoefficients: 9,
                monochrome: false,
                subsamplingX: 1,
                subsamplingY: 1,
                transferCharacteristics: 16
            },
            maximumFrameHeight: EXTERNAL_AV1_HDR_AUTHORIZATION_CODED_HEIGHT,
            maximumFrameWidth: EXTERNAL_AV1_HDR_AUTHORIZATION_CODED_WIDTH,
            profile: 0
        });
        // The codec names the profile, the first operating point's level and tier, and the bit depth the header codes
        const operatingPoint = sequenceHeader?.operatingPoints[0];
        expect(operatingPoint && sequenceHeader && [
            'av01',
            sequenceHeader.profile,
            `${String(operatingPoint.levelIndex).padStart(2, '0')}${operatingPoint.tier === 1 ? 'H' : 'M'}`,
            String(sequenceHeader.colorConfig.bitDepth).padStart(2, '0')
        ].join('.')).toBe(EXTERNAL_AV1_HDR_AUTHORIZATION_CODEC);
    });

    it('returns an independent copy and samples inside the picture', () => {
        const first = createExternalAV1HDRAuthorizationTemporalUnit();
        first.fill(0);

        expect(createExternalAV1HDRAuthorizationTemporalUnit()).not.toEqual(first);
        expect(EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_SAMPLES).toHaveLength(8);
        for (const sample of EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_SAMPLES) {
            expect(sample.sampleX).toBeLessThan(EXTERNAL_AV1_HDR_AUTHORIZATION_CODED_WIDTH);
            expect(sample.sampleY).toBeLessThan(EXTERNAL_AV1_HDR_AUTHORIZATION_CODED_HEIGHT);
        }
    });
});
