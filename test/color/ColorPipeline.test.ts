import { describe, expect, it } from 'vitest';

import {
    createDefaultRenderSettings,
    createHDRToSDRRenderSettings
} from 'webgpu-player/presentation/RenderSettings';
import {
    createHLGColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata,
    type ColorPrimaries
} from 'webgpu-player/color/ColorMetadata';
import {
    applyPQEOTF,
    applyPQOETF,
    applySDREOTF,
    convertIPTPQToLinearRGBNits,
    convertLinearRGBGamut,
    convertLinearRGBNitsToIPTPQ,
    convertYUVToEncodedRGB,
    decodeEncodedRGBToNits,
    encodeSDROutput,
    evaluateSplineToneMapPQ,
    expandYUVRange,
    getLuminanceCoefficients,
    getYUVMatrixCoefficients,
    processEncodedRGB,
    toneMapToSDR,
    type ColorTriplet
} from 'webgpu-player/color/ColorPipeline';

const EVERY_COLOR_PRIMARIES: readonly ColorPrimaries[] = [ 'bt2020', 'bt470bg', 'bt709', 'smpte170m' ];

describe('ColorPipeline', () => {
    it('expands exact 10-bit limited-range code points without clipping overshoot', () => {
        const metadata = createPQColorMetadata();
        const maximumCode = 1_023;

        expect(expandYUVRange([ 64 / maximumCode, 512 / maximumCode, 512 / maximumCode ], metadata)).toEqual([ 0, 0, 0 ]);
        expect(expandYUVRange([ 940 / maximumCode, 64 / maximumCode, 960 / maximumCode ], metadata)).toEqual([ 1, -0.5, 0.5 ]);
        expect(expandYUVRange([ 0, 512 / maximumCode, 512 / maximumCode ], metadata)[0]).toBeLessThan(0);
    });

    it('uses the exact digital center for full-range chroma', () => {
        const metadata = createPQColorMetadata({ range: 'full' });
        const chromaCenter = 512 / 1_023;

        expect(expandYUVRange([ 0.5, chromaCenter, chromaCenter ], metadata)).toEqual([ 0.5, 0, 0 ]);
    });

    it('converts neutral YUV to neutral nonlinear RGB for both matrices', () => {
        const bt709RGB = convertYUVToEncodedRGB([ 0.4, 0, 0 ], 'bt709');
        const bt2020RGB = convertYUVToEncodedRGB([ 0.4, 0, 0 ], 'bt2020-ncl');
        for (const component of [ ...bt709RGB, ...bt2020RGB ]) {
            expect(component).toBeCloseTo(0.4, 12);
        }
    });

    it('matches PQ, HLG, and SDR transfer-function anchors', () => {
        expect(applyPQEOTF(0)).toBe(0);
        expect(applyPQEOTF(1)).toBeCloseTo(10_000, 6);
        expect(applyPQEOTF(0.5080784215)).toBeCloseTo(100, 3);
        for (const component of decodeEncodedRGBToNits(
            [ 0.75, 0.75, 0.75 ],
            createHLGColorMetadata({ nominalPeakNits: 1_000 })
        )) {
            expect(component).toBeCloseTo(203.15, 1);
        }
        expect(applySDREOTF(0.04, 100)).toBeCloseTo(0.888888889, 8);
    });

    it('round trips absolute luminance and neutral BT.2020 through IPTPQc4', () => {
        expect(applyPQOETF(100)).toBeCloseTo(0.5080784215, 9);
        expect(applyPQEOTF(applyPQOETF(1_000))).toBeCloseTo(1_000, 7);

        const perceptualColor = convertLinearRGBNitsToIPTPQ([ 100, 100, 100 ], 'bt2020');
        const roundTripRGB = convertIPTPQToLinearRGBNits(perceptualColor, 'bt2020');
        expect(perceptualColor[0]).toBeCloseTo(applyPQOETF(100), 6);
        expect(perceptualColor[1]).toBeCloseTo(0, 5);
        expect(perceptualColor[2]).toBeCloseTo(0, 5);
        for (const component of roundTripRGB) {
            expect(component).toBeCloseTo(100, 7);
        }
    });

    it('matches static libplacebo spline anchors and stays monotonic', () => {
        const inputLuminances = [ 0, 10, 100, 203, 400, 1_000 ];
        const mappedIntensities = inputLuminances.map((luminanceNits: number) => (
            evaluateSplineToneMapPQ(applyPQOETF(luminanceNits), 1_000, 100)
        ));

        expect(mappedIntensities[0]).toBeCloseTo(applyPQOETF(0.1), 12);
        expect(mappedIntensities[1]).toBeCloseTo(0.2757586086, 9);
        expect(mappedIntensities[2]).toBeCloseTo(0.4151905695, 9);
        expect(mappedIntensities[3]).toBeCloseTo(0.4475811788, 9);
        expect(mappedIntensities.at(-1)).toBeCloseTo(applyPQOETF(100), 12);
        for (let intensityIndex = 1; intensityIndex < mappedIntensities.length; intensityIndex++) {
            expect(mappedIntensities[intensityIndex]).toBeGreaterThan(mappedIntensities[intensityIndex - 1]);
        }
    });

    it('converts BT.2020 linear primaries into BT.709', () => {
        expect(convertLinearRGBGamut([ 1, 0, 0 ], 'bt2020', 'bt709')).toEqual([ 1.660491, -0.12455, -0.018151 ]);
        expect(convertLinearRGBGamut([ 0.2, 0.3, 0.4 ], 'bt709', 'bt709')).toEqual([ 0.2, 0.3, 0.4 ]);
    });

    it('selects YUV coefficients by matrix, sharing BT.601 between SMPTE 170M and BT.470 BG', () => {
        const expandedYUV: ColorTriplet = [ 0.5, 0, 0.5 ];
        for (const matrix of [ 'smpte170m', 'bt470bg' ] as const) {
            const encodedRGB = convertYUVToEncodedRGB(expandedYUV, matrix);
            expect(encodedRGB[0]).toBeCloseTo(0.5 + (1.402 * 0.5), 12);
            expect(encodedRGB[1]).toBeCloseTo(0.5 - (0.714136 * 0.5), 6);
            expect(encodedRGB[2]).toBeCloseTo(0.5, 12);
            expect(getYUVMatrixCoefficients(matrix)).toEqual({ blue: 0.114, green: 0.587, red: 0.299 });
        }
        expect(convertYUVToEncodedRGB(expandedYUV, 'bt709')[0]).toBeCloseTo(0.5 + (1.5748 * 0.5), 12);
        expect(convertYUVToEncodedRGB(expandedYUV, 'bt2020-ncl')[0]).toBeCloseTo(0.5 + (1.4746 * 0.5), 12);
    });

    it('derives luminance from the primaries, with every set summing to unit white', () => {
        expect(getLuminanceCoefficients('smpte170m')).toEqual({ blue: 0.086564, green: 0.701060, red: 0.212376 });
        expect(getLuminanceCoefficients('bt470bg')).toEqual({ blue: 0.071341, green: 0.706655, red: 0.222004 });
        for (const primaries of EVERY_COLOR_PRIMARIES) {
            const coefficients = getLuminanceCoefficients(primaries);
            expect(coefficients.red + coefficients.green + coefficients.blue).toBeCloseTo(1, 5);
        }
    });

    it('converts BT.601 linear primaries through the BT.709 gamut tables and keeps white neutral', () => {
        const linearRGB: ColorTriplet = [ 0.2, 0.5, 0.8 ];

        expect(convertLinearRGBGamut([ 1, 0, 0 ], 'smpte170m', 'bt709')).toEqual([ 0.939542, 0.017772, -0.001622 ]);
        expect(convertLinearRGBGamut([ 1, 0, 0 ], 'bt470bg', 'bt709')).toEqual([ 1.044043, 0, 0 ]);
        expect(convertLinearRGBGamut(linearRGB, 'smpte170m', 'bt2020')).toEqual(
            convertLinearRGBGamut(convertLinearRGBGamut(linearRGB, 'smpte170m', 'bt709'), 'bt709', 'bt2020')
        );
        for (const primaries of EVERY_COLOR_PRIMARIES) {
            const roundTripRGB = convertLinearRGBGamut(
                convertLinearRGBGamut(linearRGB, primaries, 'bt709'),
                'bt709',
                primaries
            );
            for (let componentIndex = 0; componentIndex < 3; componentIndex++) {
                expect(roundTripRGB[componentIndex]).toBeCloseTo(linearRGB[componentIndex], 5);
            }
            for (const component of convertLinearRGBGamut([ 1, 1, 1 ], primaries, 'bt709')) {
                expect(component).toBeCloseTo(1, 5);
            }
        }
    });

    it('round trips BT.601 primaries through IPTPQc4 consistently with the BT.709 path', () => {
        const linearRGBNits: ColorTriplet = [ 100, 50, 25 ];
        for (const primaries of [ 'smpte170m', 'bt470bg' ] as const) {
            const perceptualColor = convertLinearRGBNitsToIPTPQ(linearRGBNits, primaries);
            const roundTripRGB = convertIPTPQToLinearRGBNits(perceptualColor, primaries);
            const bt709PerceptualColor = convertLinearRGBNitsToIPTPQ(
                convertLinearRGBGamut(linearRGBNits, primaries, 'bt709'),
                'bt709'
            );
            for (let componentIndex = 0; componentIndex < 3; componentIndex++) {
                // NOTE: The rounded IPT and LMS stage matrices limit every primaries set to about 2e-6 relative error
                expect(roundTripRGB[componentIndex]).toBeCloseTo(linearRGBNits[componentIndex], 3);
                expect(perceptualColor[componentIndex]).toBeCloseTo(bt709PerceptualColor[componentIndex], 5);
            }
        }
    });

    it('scales HLG by the luminance of its own primaries', () => {
        const encodedGreen: ColorTriplet = [ 0, 0.75, 0 ];
        const smpte170mOutput = decodeEncodedRGBToNits(
            encodedGreen,
            createHLGColorMetadata({ matrix: 'smpte170m', primaries: 'smpte170m' })
        );
        const bt709Output = decodeEncodedRGBToNits(
            encodedGreen,
            createHLGColorMetadata({ matrix: 'bt709', primaries: 'bt709' })
        );

        // At a 1000-nit peak the system gamma is 1.2, so the output scales with luminance to the 0.2 power
        expect(smpte170mOutput[1] / bt709Output[1]).toBeCloseTo((0.701060 / 0.7152) ** 0.2, 10);
    });

    it('tone maps into the configured peak and preserves achromatic samples', () => {
        const settings = createHDRToSDRRenderSettings({
            toneMapping: {
                desaturationStrength: 0,
                operator: 'reinhard'
            }
        }).toneMapping;
        const mappedRGB = toneMapToSDR([ 1_000, 1_000, 1_000 ], settings);

        expect(mappedRGB[0]).toBeCloseTo(100, 8);
        expect(mappedRGB[1]).toBeCloseTo(mappedRGB[0], 10);
        expect(mappedRGB[2]).toBeCloseTo(mappedRGB[0], 10);
    });

    it('supports both SDR output encodings', () => {
        const sRGBOutput = encodeSDROutput([ 0, 50, 100 ], 100, 'srgb');
        const bt709Output = encodeSDROutput([ 0, 50, 100 ], 100, 'bt709');
        const blackPointCompensatedOutput = encodeSDROutput([ 0.1, 50.05, 100 ], 100, 'srgb', 0.1);

        expect(sRGBOutput[0]).toBe(0);
        expect(sRGBOutput[1]).toBeCloseTo(0.735356983, 8);
        expect(sRGBOutput[2]).toBeCloseTo(1, 12);
        expect(bt709Output[0]).toBe(0);
        expect(bt709Output[1]).toBeCloseTo(0.70551509, 8);
        expect(bt709Output[2]).toBeCloseTo(1, 12);
        expect(blackPointCompensatedOutput[0]).toBe(0);
        expect(blackPointCompensatedOutput[1]).toBeCloseTo(0.735356983, 8);
        expect(blackPointCompensatedOutput[2]).toBeCloseTo(1, 12);
    });

    it('leaves identity RGB untouched and bounds HDR-to-SDR output', () => {
        const encodedRGB: ColorTriplet = [ 0.25, 0.5, 0.75 ];
        expect(processEncodedRGB(
            encodedRGB,
            createSDRColorMetadata(),
            createDefaultRenderSettings()
        )).toEqual(encodedRGB);

        const transformedRGB = processEncodedRGB(
            encodedRGB,
            createHLGColorMetadata(),
            createHDRToSDRRenderSettings()
        );
        for (const component of transformedRGB) {
            expect(component).toBeGreaterThanOrEqual(0);
            expect(component).toBeLessThanOrEqual(1);
        }
    });

    it('perceptually compresses BT.2020 primaries without hard channel clipping', () => {
        const encoded100Nits = applyPQOETF(100);
        const settings = createHDRToSDRRenderSettings();
        const metadata = createPQColorMetadata();
        const mappedRed = processEncodedRGB([ encoded100Nits, 0, 0 ], metadata, settings);
        const mappedGreen = processEncodedRGB([ 0, encoded100Nits, 0 ], metadata, settings);
        const mappedBlue = processEncodedRGB([ 0, 0, encoded100Nits ], metadata, settings);

        expect(mappedRed).toEqual(expect.arrayContaining([
            expect.any(Number),
            expect.any(Number),
            expect.any(Number)
        ]));
        expect(mappedRed[0]).toBeCloseTo(0.84929848, 7);
        expect(mappedRed[0]).toBeGreaterThan(mappedRed[1]);
        expect(mappedRed[0]).toBeGreaterThan(mappedRed[2]);
        expect(mappedGreen[1]).toBeGreaterThan(mappedGreen[0]);
        expect(mappedGreen[1]).toBeGreaterThan(mappedGreen[2]);
        expect(mappedBlue[2]).toBeGreaterThan(mappedBlue[0]);
        expect(mappedBlue[2]).toBeGreaterThan(mappedBlue[1]);
        for (const component of [ ...mappedRed, ...mappedGreen, ...mappedBlue ]) {
            expect(component).toBeGreaterThan(0);
            expect(component).toBeLessThan(1);
        }
    });

    it('applies display controls after HDR output encoding', () => {
        const encodedRGB: ColorTriplet = [ 0.25, 0.5, 0.75 ];
        const metadata = createHLGColorMetadata();
        const neutralOutput = processEncodedRGB(encodedRGB, metadata, createHDRToSDRRenderSettings());
        const adjustedOutput = processEncodedRGB(
            encodedRGB,
            metadata,
            createHDRToSDRRenderSettings({
                display: {
                    brightness: 0.1,
                    contrast: 1,
                    saturation: 0
                }
            })
        );

        expect(adjustedOutput[0]).toBeCloseTo(adjustedOutput[1], 10);
        expect(adjustedOutput[1]).toBeCloseTo(adjustedOutput[2], 10);
        expect(adjustedOutput[0]).toBeGreaterThan(neutralOutput[0]);
    });
});
