import { describe, expect, it } from 'vitest';

import type { ColorTriplet } from 'webgpu-player/color/ColorPipeline';
import {
    applyExternalFrameCalibration,
    fitExternalFrameCalibration,
    recoverLimitedRangeBT709Codes,
    type ExternalFrameCalibrationSample
} from 'webgpu-player/color/ExternalFrameCalibration';

// Grays across the luma range and colors on both sides of the chroma center, as the authorization vectors hold them
const FRAME_CODES: readonly ColorTriplet[] = [
    [ 283, 512, 512 ],
    [ 503, 512, 512 ],
    [ 722, 512, 512 ],
    [ 525, 612, 412 ],
    [ 705, 412, 612 ]
];
// A browser whose levels read each component this much scaled and offset, in 10-bit codes, before its BT.709 conversion
const BROWSER_GAIN: ColorTriplet = [ 0.99, 1.01, 0.995 ];
const BROWSER_OFFSET: ColorTriplet = [ 1.5, -2, 3 ];

/** Converts codes, read at a browser's own levels, to the BT.709 limited-range RGB the recovery inverts, unclipped. */
function convertAtBrowserLevels(codes: ColorTriplet): ColorTriplet {
    const browserCodes = codes.map((code: number, component: number): number => (code * BROWSER_GAIN[component]) + BROWSER_OFFSET[component]);
    const luma = (browserCodes[0] - 64) / 876;
    const chromaBlue = (browserCodes[1] - 512) / 896;
    const chromaRed = (browserCodes[2] - 512) / 896;
    return [
        luma + (1.5748 * chromaRed),
        luma - (0.187324 * chromaBlue) - (0.468124 * chromaRed),
        luma + (1.8556 * chromaBlue)
    ];
}

function createSamples(codes: readonly ColorTriplet[]): ExternalFrameCalibrationSample[] {
    return codes.map((rawYUVCode: ColorTriplet): ExternalFrameCalibrationSample => ({ encodedRGB: convertAtBrowserLevels(rawYUVCode), rawYUVCode }));
}

describe('fitExternalFrameCalibration', () => {
    it('fits the levels that recover every code a browser read at levels of its own', () => {
        const fit = fitExternalFrameCalibration(createSamples(FRAME_CODES));
        if (!fit.calibration) {
            throw new Error(fit.failure);
        }

        // A code between the vector's recovers too, so the levels hold across the range
        for (const codes of [ ...FRAME_CODES, [ 400, 470, 560 ] as const ]) {
            const recovered = applyExternalFrameCalibration(recoverLimitedRangeBT709Codes(convertAtBrowserLevels(codes)), fit.calibration);
            for (const component of [ 0, 1, 2 ]) {
                expect(recovered[component]).toBeCloseTo(codes[component], 4);
            }
        }
    });

    it('leaves out a sample whose RGB the browser clipped, which no longer says what the frame holds', () => {
        const clippedSample: ExternalFrameCalibrationSample = { encodedRGB: [ 1, 0.8, 0.6 ], rawYUVCode: [ 795, 412, 612 ] };

        expect(fitExternalFrameCalibration([ ...createSamples(FRAME_CODES), clippedSample ])).toEqual(fitExternalFrameCalibration(createSamples(FRAME_CODES)));
    });

    it('fits nothing from samples that hold one code of a component', () => {
        expect(fitExternalFrameCalibration(createSamples(FRAME_CODES.slice(0, 3)))).toEqual({
            calibration: null,
            failure: 'Cb: 1 distinct codes among 3 unclipped samples, expected 2 or more'
        });
    });
});
