import { describe, expect, it } from 'vitest';

import {
    getHDR10PlusSceneLuminance,
    isHDR10PlusFrameMetadata,
    isHDR10PlusMetadata,
    parseHEVCHDR10PlusMetadata,
    type HDR10PlusMetadata
} from 'webgpu-player/video/hdr/HDR10PlusMetadata';

import { createHDR10PlusHEVCVector } from '../../../src/capability/vectors/HDR10PlusVectors';

const ANNEX_B_FORMAT = { kind: 'annex-b' } as const;
// HDR10+ profile A has no curve and leaves the targeted display at 0
const PROFILE_A_TARGETED_DISPLAY_NITS = 0;
// The scene statistics both profile vectors share
const VECTOR_SCENE_PEAK_NITS = 834.75;
const VECTOR_SCENE_AVERAGE_NITS = 166.95;

function parseVectorMetadata(kind: Parameters<typeof createHDR10PlusHEVCVector>[0]): HDR10PlusMetadata {
    const metadata = parseHEVCHDR10PlusMetadata(createHDR10PlusHEVCVector(kind), ANNEX_B_FORMAT).metadata;
    if (!metadata) {
        throw new Error(`The ${kind} HDR10+ vector has no metadata`);
    }
    return metadata;
}

describe('HDR10PlusMetadata', () => {
    it('parses bounded ST 2094-40 statistics and tone-mapping anchors', () => {
        const result = parseHEVCHDR10PlusMetadata(
            createHDR10PlusHEVCVector('valid'),
            ANNEX_B_FORMAT
        );

        expect(result.status).toBe('valid');
        expect(result.metadata).toMatchObject({
            applicationVersion: 1,
            averageMaxRGBNits: 200,
            distributionMaxRGB: [
                { percentage: 50, percentileNits: 100 },
                { percentage: 99, percentileNits: 900 }
            ],
            maximumSCLNits: [ 1_000, 800, 500 ],
            targetedSystemDisplayMaximumLuminanceNits: 1_000,
            toneMapping: {
                bezierCurveAnchors: [ 256 / 1_023, 768 / 1_023 ],
                kneePointX: 2_048 / 4_095,
                kneePointY: 1_024 / 4_095
            }
        });
        expect(isHDR10PlusFrameMetadata(result)).toBe(true);
        const sceneLuminance = getHDR10PlusSceneLuminance(result.metadata!);
        expect(sceneLuminance.averageNits).toBeCloseTo(166.95);
        expect(sceneLuminance.peakNits).toBeCloseTo(834.75);
    });

    it('accepts profile A statistics without a curve or a targeted display', () => {
        const result = parseHEVCHDR10PlusMetadata(
            createHDR10PlusHEVCVector('profile-a'),
            ANNEX_B_FORMAT
        );

        expect(result.status).toBe('valid');
        expect(result.metadata).toEqual({
            ...parseVectorMetadata('valid'),
            targetedSystemDisplayMaximumLuminanceNits: PROFILE_A_TARGETED_DISPLAY_NITS,
            toneMapping: null
        });
        expect(isHDR10PlusFrameMetadata(result)).toBe(true);
        const sceneLuminance = getHDR10PlusSceneLuminance(result.metadata!);
        expect(sceneLuminance.averageNits).toBeCloseTo(VECTOR_SCENE_AVERAGE_NITS);
        expect(sceneLuminance.peakNits).toBeCloseTo(VECTOR_SCENE_PEAK_NITS);
    });

    it('tone-maps a curve without a targeted display statically, as neither profile', () => {
        expect(parseHEVCHDR10PlusMetadata(
            createHDR10PlusHEVCVector('zero-target-curve'),
            ANNEX_B_FORMAT
        )).toEqual({ metadata: null, status: 'unsupported' });
        expect(isHDR10PlusMetadata({
            ...parseVectorMetadata('valid'),
            targetedSystemDisplayMaximumLuminanceNits: PROFILE_A_TARGETED_DISPLAY_NITS
        })).toBe(false);
    });

    it.each([
        [ 'absent', 'absent' ],
        [ 'malformed', 'malformed' ],
        [ 'conflicting', 'conflicting' ],
        [ 'unsupported', 'unsupported' ]
    ] as const)('classifies %s metadata without leaking a previous frame', (kind, status) => {
        expect(parseHEVCHDR10PlusMetadata(
            createHDR10PlusHEVCVector(kind),
            ANNEX_B_FORMAT
        )).toEqual({ metadata: null, status });
    });

    it('rejects malformed cross-worker metadata and accepts explicit fallback states', () => {
        expect(isHDR10PlusFrameMetadata({
            metadata: null,
            status: 'malformed'
        })).toBe(true);
        expect(isHDR10PlusFrameMetadata({
            metadata: {
                ...(parseHEVCHDR10PlusMetadata(
                    createHDR10PlusHEVCVector('valid'),
                    ANNEX_B_FORMAT
                ).metadata ?? {}),
                maximumSCLNits: [ Number.NaN, 800, 500 ]
            },
            status: 'valid'
        })).toBe(false);
    });

    it('lets only absent and malformed frames carry earlier metadata across a worker boundary', () => {
        const validMetadata = parseVectorMetadata('valid');
        const profileAMetadata = parseVectorMetadata('profile-a');

        for (const status of [ 'absent', 'malformed' ] as const) {
            expect(isHDR10PlusFrameMetadata({ metadata: validMetadata, status })).toBe(true);
            expect(isHDR10PlusFrameMetadata({ metadata: profileAMetadata, status })).toBe(true);
        }
        for (const status of [ 'conflicting', 'unsupported' ] as const) {
            expect(isHDR10PlusFrameMetadata({ metadata: null, status })).toBe(true);
            expect(isHDR10PlusFrameMetadata({ metadata: validMetadata, status })).toBe(false);
        }
        expect(isHDR10PlusFrameMetadata({ metadata: null, status: 'valid' })).toBe(false);
        expect(isHDR10PlusFrameMetadata({
            metadata: { ...validMetadata, averageMaxRGBNits: Number.NaN },
            status: 'absent'
        })).toBe(false);
    });
});
