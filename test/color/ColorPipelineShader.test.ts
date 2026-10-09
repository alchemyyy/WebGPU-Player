import { describe, expect, it } from 'vitest';

import {
    createDefaultRenderSettings,
    createHDRToSDRRenderSettings
} from 'webgpu-player/presentation/RenderSettings';
import {
    createHLGColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata
} from 'webgpu-player/color/ColorMetadata';
import {
    createExternalDolbyVisionColorPipelineWGSL,
    createExternalDolbyVisionInputProbeWGSL,
    createExternalHDRColorPipelineWGSL,
    createRawDolbyVisionColorPipelineWGSL,
    createRawDolbyVisionProfile4ColorPipelineWGSL,
    createRawDolbyVisionProfile4FELColorPipelineWGSL,
    createRawDolbyVisionProfile7ColorPipelineWGSL,
    createRawDolbyVisionProfile7FELColorPipelineWGSL,
    createRawYUVColorPipelineWGSL,
    getRawFormatBitDepth,
    isRawDolbyVisionVideoFrameFormat
} from 'webgpu-player/color/ColorPipelineShader';

/** Returns one generated WGSL function, from its signature to its closing brace. */
function getWGSLFunction(shader: string, functionName: string): string {
    const functionStart = shader.indexOf(`fn ${functionName}(`);
    if (functionStart < 0) {
        throw new Error(`The shader has no ${functionName} function`);
    }
    return shader.slice(functionStart, shader.indexOf('\n}', functionStart) + 2);
}

function getRawTestBitDepth(format: string): 8 | 10 | 12 {
    if (format.endsWith('P10')) {
        return 10;
    }
    if (format.endsWith('P12')) {
        return 12;
    }
    return 8;
}

describe('shared color stages', () => {
    it('generates the ordered PQ-to-SDR processing stages', () => {
        const shader = createExternalHDRColorPipelineWGSL(
            createPQColorMetadata(),
            createHDRToSDRRenderSettings({
                toneMapping: { operator: 'reinhard' }
            })
        );
        const processFunction = shader.slice(shader.indexOf('fn processColor'));

        expect(shader).toContain('fn applyPQEOTF');
        expect(shader).toContain('fn convertToBT709');
        expect(shader).toContain('fn toneMapToSDR');
        expect(shader).toContain('fn applyOutputDither');
        expect(shader).toContain('noise / 255.0');
        expect(shader).toContain('@binding(3) var<uniform> renderSettings');
        expect(shader).toContain('renderSettings.toneMapOperator == 0u');
        expect(shader).toContain('renderSettings.toneMapOperator == 2u');
        expect(shader).toContain('fn evaluateSplineToneMapPQ');
        expect(shader).toContain('fn toneMapHDR10PlusPerceptualToSDR');
        expect(shader).toContain('fn getHDR10PlusBezierAnchor');
        expect(shader).toContain('renderSettings.dynamicHDRMode == 2u');
        expect(shader).toContain('dynamicBezierAnchors3: vec4f');
        expect(shader).toContain('renderSettings.outputPeakNits / 1000.0');
        expect(shader).toContain('componentNits - outputMinimumNits');
        expect(shader).toContain('fn perceptuallyMapIPTPQToBT709');
        expect(shader).not.toContain('fn encodeBT709');
        expect(processFunction.indexOf('decodeInputTransfer')).toBeLessThan(processFunction.indexOf('convertToBT709'));
        expect(processFunction.indexOf('convertToBT709')).toBeLessThan(processFunction.indexOf('toneMapToSDR'));
        expect(shader).toContain('return encodeSRGB(linearValue);');
    });

    it('keeps the specialized shader stable across live settings changes', () => {
        const metadata = createPQColorMetadata();
        const firstShader = createExternalHDRColorPipelineWGSL(metadata, createHDRToSDRRenderSettings());
        const secondShader = createExternalHDRColorPipelineWGSL(
            metadata,
            createHDRToSDRRenderSettings({
                display: {
                    brightness: 0.2,
                    contrast: 1.4,
                    saturation: 0.7
                },
                toneMapping: {
                    desaturationStrength: 0.8,
                    exposure: 1,
                    inputPeakNits: 4_000,
                    operator: 'reinhard',
                    outputPeakNits: 120,
                    paperWhiteNits: 250
                }
            })
        );

        expect(secondShader).toBe(firstShader);
        expect(firstShader).toContain('renderSettings.brightness');
        expect(firstShader).toContain('renderSettings.contrast');
        expect(firstShader).toContain('renderSettings.saturation');
        expect(firstShader).not.toContain('4000.000000000');
    });

    it('injects HLG display metadata into the generated shader', () => {
        const shader = createExternalHDRColorPipelineWGSL(
            createHLGColorMetadata({ nominalPeakNits: 2_000 }),
            createHDRToSDRRenderSettings()
        );

        expect(shader).toContain('fn applyHLGInverseOETF');
        expect(shader).toContain('2000.000000000');
        expect(shader).toContain('sceneLuminance');
    });

    it('retains a literal identity stage for the default mode', () => {
        const shader = createRawYUVColorPipelineWGSL(
            createSDRColorMetadata(),
            createDefaultRenderSettings(),
            'I420'
        );

        expect(shader).toContain(`fn processColor(encodedRGB: vec3f, pixelCoordinate: vec2f) -> vec3f {
    return encodedRGB;
}`);
        expect(shader).not.toContain('fn applyOutputDither');
    });

    it('shares spline and IPT/PQ gamut mapping across every HDR input route', () => {
        const settings = createHDRToSDRRenderSettings();
        const metadata = createPQColorMetadata();
        const shaders = [
            createExternalHDRColorPipelineWGSL(metadata, settings),
            createRawYUVColorPipelineWGSL(metadata, settings, 'I420P10'),
            createExternalDolbyVisionColorPipelineWGSL(settings),
            createRawDolbyVisionColorPipelineWGSL(settings, 'I420P10'),
            createRawDolbyVisionProfile7ColorPipelineWGSL(settings, 'I420P10'),
            createRawDolbyVisionProfile7FELColorPipelineWGSL(settings, 'I420P10'),
            createRawDolbyVisionProfile4ColorPipelineWGSL(settings, 'I420P10'),
            createRawDolbyVisionProfile4FELColorPipelineWGSL(settings, 'I420P10')
        ];

        for (const shader of shaders) {
            expect(shader).toContain('fn convertLinearRGBNitsToIPTPQ');
            expect(shader).toContain('fn evaluateSplineToneMapPQ');
            expect(shader).toContain('fn perceptuallyMapIPTPQToBT709');
            expect(shader).toContain('renderSettings.toneMapOperator == 2u');
        }
    });
});

describe('createExternalDolbyVisionColorPipelineWGSL', () => {
    it('inverts limited-range BT.709 before Profile 5 reconstruction', () => {
        const shader = createExternalDolbyVisionColorPipelineWGSL(createHDRToSDRRenderSettings());
        const fragmentFunction = shader.slice(shader.indexOf('@fragment'));

        expect(shader).toContain('@binding(1) var videoTexture: texture_external');
        expect(shader).toContain('@binding(3) var<uniform> renderSettings');
        expect(shader).toContain('@binding(4) var<storage, read> dolbyVisionRPU');
        expect(shader).toContain('dot(encodedBT709RGB, vec3f(0.2126, 0.7152, 0.0722))');
        expect(shader).toContain('(normalizedLuma * 876.0) + 64.0');
        expect(shader).toContain('(normalizedChromaBlue * 896.0) + 512.0');
        expect(shader).toContain('(normalizedChromaRed * 896.0) + 512.0');
        expect(fragmentFunction).toContain(`reconstructDolbyVisionBT2020PQ(
        recoverDolbyVisionBaseSignal(encodedBT709RGB)
    )`);
        expect(fragmentFunction.indexOf('reconstructDolbyVisionBT2020PQ')).toBeLessThan(fragmentFunction.indexOf('processColor'));
    });

    it('keeps the external Dolby Vision shader stable across live settings', () => {
        const firstShader = createExternalDolbyVisionColorPipelineWGSL(createHDRToSDRRenderSettings());
        const secondShader = createExternalDolbyVisionColorPipelineWGSL(
            createHDRToSDRRenderSettings({
                display: { brightness: 0.2, contrast: 1.1, saturation: 0.9 },
                toneMapping: { inputPeakNits: 4_000 }
            })
        );

        expect(secondShader).toBe(firstShader);
    });
});

describe('createExternalDolbyVisionInputProbeWGSL', () => {
    it('reports recovered 10-bit base signals before nonlinear reconstruction', () => {
        const shader = createExternalDolbyVisionInputProbeWGSL();
        const fragmentFunction = shader.slice(shader.indexOf('@fragment'));

        expect(shader).toContain('@binding(1) var videoTexture: texture_external');
        expect(shader).toContain('fn recoverLimitedRangeBT709YUV');
        expect(fragmentFunction).toContain('let recoveredBaseSignal = recoverLimitedRangeBT709YUV(encodedBT709RGB);');
        expect(fragmentFunction).toContain('return vec4f(recoveredBaseSignal / 1023.0, 1.0);');
        expect(shader).not.toContain('reconstructDolbyVisionBT2020PQ');
        expect(shader).not.toContain('processColor');
    });
});

describe('createExternalHDRColorPipelineWGSL', () => {
    it('recovers neutralized limited-range Main10 YUV before PQ processing', () => {
        const shader = createExternalHDRColorPipelineWGSL(createPQColorMetadata(), createHDRToSDRRenderSettings());
        const fragmentFunction = shader.slice(shader.indexOf('@fragment'));

        expect(shader).toContain('@binding(1) var videoTexture: texture_external');
        expect(shader).toContain('@binding(3) var<uniform> renderSettings');
        expect(shader).toContain('fn recoverLimitedRangeBT709YUV');
        expect(shader).toContain('(normalizedLuma * 876.0) + 64.0');
        expect(shader).toContain('(rawYUV.x - 64.000000000) / 876.000000000');
        expect(shader).toContain('normalizedYUV.x + 1.4746 * normalizedYUV.z');
        expect(shader).toContain('fn applyPQEOTF');
        expect(fragmentFunction.indexOf('recoverLimitedRangeBT709YUV')).toBeLessThan(fragmentFunction.indexOf('normalizeRawYUV'));
        expect(fragmentFunction.indexOf('convertRawYUVToEncodedRGB')).toBeLessThan(fragmentFunction.indexOf('processColor'));
    });

    it('specializes HLG and remains stable across live renderer settings', () => {
        const metadata = createHLGColorMetadata();
        const firstShader = createExternalHDRColorPipelineWGSL(metadata, createHDRToSDRRenderSettings());
        const secondShader = createExternalHDRColorPipelineWGSL(
            metadata,
            createHDRToSDRRenderSettings({
                display: { brightness: 0.1, contrast: 1.2, saturation: 0.8 },
                toneMapping: { inputPeakNits: 2_000 }
            })
        );

        expect(firstShader).toContain('fn applyHLGInverseOETF');
        expect(secondShader).toBe(firstShader);
    });

    it('rejects metadata outside the exact neutralized Main10 route', () => {
        expect(() => createExternalHDRColorPipelineWGSL(
            createPQColorMetadata({ bitDepth: 12 }),
            createHDRToSDRRenderSettings()
        )).toThrow('limited-range 10-bit BT.2020');
        expect(() => createExternalHDRColorPipelineWGSL(
            createPQColorMetadata({ range: 'full' }),
            createHDRToSDRRenderSettings()
        )).toThrow('limited-range 10-bit BT.2020');
        expect(() => createExternalHDRColorPipelineWGSL(
            createSDRColorMetadata({ bitDepth: 10, matrix: 'bt2020-ncl', primaries: 'bt2020' }),
            createHDRToSDRRenderSettings()
        )).toThrow('limited-range 10-bit BT.2020');
    });
});

describe('createRawYUVColorPipelineWGSL', () => {
    it('generates planar 10-bit BT.2020 limited-range conversion before PQ decoding', () => {
        const shader = createRawYUVColorPipelineWGSL(
            createPQColorMetadata(),
            createHDRToSDRRenderSettings(),
            'I420P10'
        );
        const fragmentFunction = shader.slice(shader.indexOf('@fragment'));

        expect(shader).not.toContain('texture_external');
        expect(shader).toContain('@binding(1) var lumaTexture: texture_2d<u32>');
        expect(shader).toContain('@binding(2) var chromaUTexture: texture_2d<u32>');
        expect(shader).toContain('@binding(3) var chromaVTexture: texture_2d<u32>');
        expect(shader).toContain('@binding(4) var<uniform> renderSettings');
        expect(shader).toContain('(rawYUV.x - 64.000000000) / 876.000000000');
        expect(shader).toContain('(rawYUV.y - 512.000000000) / 896.000000000');
        expect(shader).toContain('normalizedYUV.x + 1.4746 * normalizedYUV.z');
        expect(fragmentFunction.indexOf('normalizeRawYUV')).toBeLessThan(fragmentFunction.indexOf('convertRawYUVToEncodedRGB'));
        expect(shader.indexOf('fn convertRawYUVToEncodedRGB')).toBeLessThan(shader.indexOf('fn applyPQEOTF'));
    });

    it('generates interleaved 8-bit NV12 BT.709 full-range bindings', () => {
        const shader = createRawYUVColorPipelineWGSL(
            createSDRColorMetadata({ range: 'full' }),
            createHDRToSDRRenderSettings(),
            'NV12'
        );

        expect(shader).toContain('@binding(2) var chromaTexture: texture_2d<u32>');
        expect(shader).not.toContain('chromaVTexture');
        expect(shader).toContain('@binding(3) var<uniform> renderSettings');
        expect(shader).toContain('rawYUV.x / 255.000000000');
        expect(shader).toContain('(rawYUV.y - 128.000000000) / 255.000000000');
        expect(shader).toContain('normalizedYUV.x + 1.5748 * normalizedYUV.z');
    });

    it.each([ 'I420', 'I420P10', 'I420P12', 'I422', 'I422P10', 'I422P12' ] as const)(
        'applies deterministic HEVC horizontal left chroma siting to %s',
        format => {
            const bitDepth = getRawTestBitDepth(format);
            const shader = createRawYUVColorPipelineWGSL(
                createSDRColorMetadata({ bitDepth }),
                createDefaultRenderSettings(),
                format
            );

            const leftSitedCoordinate = 'textureCoordinate + vec2f(0.5 / f32(textureDimensions(lumaTexture).x), 0.0)';
            expect(shader).toContain(`sampleChromaU(${leftSitedCoordinate})`);
            expect(shader).toContain(`sampleChromaV(${leftSitedCoordinate})`);
        }
    );

    it.each([ 'I444', 'I444P10', 'I444P12' ] as const)(
        'does not shift full-resolution %s chroma samples',
        format => {
            const bitDepth = getRawTestBitDepth(format);
            const shader = createRawYUVColorPipelineWGSL(
                createSDRColorMetadata({ bitDepth }),
                createDefaultRenderSettings(),
                format
            );

            expect(shader).toContain('sampleChromaU(textureCoordinate)');
            expect(shader).toContain('sampleChromaV(textureCoordinate)');
            expect(shader).not.toContain('0.5 / f32(textureDimensions(lumaTexture).x)');
        }
    );

    it('rejects metadata whose bit depth differs from the copied frame format', () => {
        expect(() => createRawYUVColorPipelineWGSL(
            createPQColorMetadata({ bitDepth: 10 }),
            createHDRToSDRRenderSettings(),
            'I420P12'
        )).toThrow('Raw frame format bit depth does not match color metadata');
    });

    it('keeps the raw shader stable across live setting changes', () => {
        const metadata = createHLGColorMetadata();
        const firstShader = createRawYUVColorPipelineWGSL(
            metadata,
            createHDRToSDRRenderSettings(),
            'I420P10'
        );
        const secondShader = createRawYUVColorPipelineWGSL(
            metadata,
            createHDRToSDRRenderSettings({
                display: { brightness: 0.1, contrast: 1.2, saturation: 0.8 },
                toneMapping: { inputPeakNits: 2_000 }
            }),
            'I420P10'
        );

        expect(secondShader).toBe(firstShader);
    });

    it('generates the BT.601 YUV matrix for both SMPTE 170M and BT.470 BG', () => {
        for (const matrix of [ 'smpte170m', 'bt470bg' ] as const) {
            const shader = createRawYUVColorPipelineWGSL(
                createSDRColorMetadata({ matrix, primaries: matrix }),
                createDefaultRenderSettings(),
                'I420'
            );
            const matrixFunction = getWGSLFunction(shader, 'convertRawYUVToEncodedRGB');

            expect(matrixFunction).toContain('normalizedYUV.x + 1.402 * normalizedYUV.z');
            expect(matrixFunction).toContain('normalizedYUV.x - 0.344136 * normalizedYUV.y - 0.714136 * normalizedYUV.z');
            expect(matrixFunction).toContain('normalizedYUV.x + 1.772 * normalizedYUV.y');
        }
    });

    it.each([
        {
            gamutValues: [],
            iptValues: [ '0.295764081', '0.623072451', '0.081166749' ],
            primaries: 'bt709'
        },
        {
            gamutValues: [ '1.660491000', '-0.587641000', '-0.072850000' ],
            iptValues: [ '0.412036387', '0.523911912', '0.064054982' ],
            primaries: 'bt2020'
        },
        {
            gamutValues: [ '0.939542000', '0.050181000', '0.010277000', '-0.001622000' ],
            iptValues: [ '0.288824557', '0.616246090', '0.094932633' ],
            primaries: 'smpte170m'
        },
        {
            gamutValues: [ '1.044043000', '-0.044043000', '0.988207000' ],
            iptValues: [ '0.308790480', '0.611003282', '0.080209519' ],
            primaries: 'bt470bg'
        }
    ] as const)('converts $primaries linear light through its gamut and IPT tables', ({
        gamutValues,
        iptValues,
        primaries
    }) => {
        const shader = createRawYUVColorPipelineWGSL(
            createSDRColorMetadata({ primaries }),
            createHDRToSDRRenderSettings(),
            'I420'
        );
        const gamutFunction = getWGSLFunction(shader, 'convertToBT709');
        const iptFunction = getWGSLFunction(shader, 'convertSourceRGBToIPTLMS');

        if (gamutValues.length === 0) {
            expect(gamutFunction).toContain('return linearRGB;');
        }
        for (const gamutValue of gamutValues) {
            expect(gamutFunction).toContain(gamutValue);
        }
        for (const iptValue of iptValues) {
            expect(iptFunction).toContain(iptValue);
        }
    });

    it('weights HLG scene luminance by the luminance of its primaries', () => {
        const smpte170mShader = createRawYUVColorPipelineWGSL(
            createHLGColorMetadata({ matrix: 'smpte170m', primaries: 'smpte170m' }),
            createHDRToSDRRenderSettings(),
            'I420P10'
        );
        const bt2020Shader = createRawYUVColorPipelineWGSL(
            createHLGColorMetadata(),
            createHDRToSDRRenderSettings(),
            'I420P10'
        );
        const smpte170mTransfer = getWGSLFunction(smpte170mShader, 'decodeInputTransfer');
        const bt2020Transfer = getWGSLFunction(bt2020Shader, 'decodeInputTransfer');

        for (const coefficient of [ '0.212376000', '0.701060000', '0.086564000' ]) {
            expect(smpte170mTransfer).toContain(coefficient);
        }
        for (const coefficient of [ '0.262700000', '0.678000000', '0.059300000' ]) {
            expect(bt2020Transfer).toContain(coefficient);
        }
    });
});

describe('createRawDolbyVisionColorPipelineWGSL', () => {
    it('reconstructs raw base-layer code values before the HDR pipeline', () => {
        const shader = createRawDolbyVisionColorPipelineWGSL(createHDRToSDRRenderSettings(), 'I420P10');
        const fragmentFunction = shader.slice(shader.indexOf('@fragment'));

        expect(shader).not.toContain('texture_external');
        expect(shader).toContain('@binding(1) var lumaTexture: texture_2d<u32>');
        expect(shader).toContain('@binding(2) var chromaUTexture: texture_2d<u32>');
        expect(shader).toContain('@binding(3) var chromaVTexture: texture_2d<u32>');
        expect(shader).toContain('@binding(4) var<uniform> renderSettings');
        expect(shader).toContain('@binding(5) var<storage, read> dolbyVisionRPU');
        expect(shader).not.toContain('fn normalizeRawYUV');
        expect(shader).not.toContain('fn convertRawYUVToEncodedRGB');
        expect(shader).toContain('rawBaseSignal / (codeValueCount - 1.0)');
        expect(fragmentFunction).toContain(`let encodedBT2020PQ = reconstructDolbyVisionBT2020PQ(
        sampleRawYUV(textureCoordinate)
    );`);
        expect(fragmentFunction.indexOf('reconstructDolbyVisionBT2020PQ')).toBeLessThan(fragmentFunction.indexOf('processColor'));
    });

    it('keeps the Dolby Vision shader stable across live setting changes', () => {
        const firstShader = createRawDolbyVisionColorPipelineWGSL(createHDRToSDRRenderSettings(), 'I420P12');
        const secondShader = createRawDolbyVisionColorPipelineWGSL(
            createHDRToSDRRenderSettings({
                display: { brightness: 0.1, contrast: 1.2, saturation: 0.8 },
                toneMapping: { inputPeakNits: 4_000 }
            }),
            'I420P12'
        );

        expect(secondShader).toBe(firstShader);
    });
});

describe('createRawDolbyVisionProfile7ColorPipelineWGSL', () => {
    it('reconstructs MEL and explicitly uses the compatible HDR10 base for FEL', () => {
        const shader = createRawDolbyVisionProfile7ColorPipelineWGSL(createHDRToSDRRenderSettings(), 'I420P10');
        const fragmentFunction = shader.slice(shader.indexOf('@fragment'));

        expect(shader).toContain('fn isDolbyVisionFEL() -> bool');
        expect(shader).toContain('fn normalizeRawYUV');
        expect(shader).toContain('fn convertRawYUVToEncodedRGB');
        expect(fragmentFunction).toContain('if (isDolbyVisionFEL())');
        expect(fragmentFunction).toContain('convertRawYUVToEncodedRGB(normalizeRawYUV(rawBaseSignal))');
        expect(fragmentFunction).toContain('encodedBT2020PQ = reconstructDolbyVisionBT2020PQ(rawBaseSignal)');
        expect(fragmentFunction.indexOf('isDolbyVisionFEL')).toBeLessThan(fragmentFunction.indexOf('processColor'));
    });

    it('keeps the Profile 7 shader stable across live setting changes', () => {
        const firstShader = createRawDolbyVisionProfile7ColorPipelineWGSL(createHDRToSDRRenderSettings(), 'I420P10');
        const secondShader = createRawDolbyVisionProfile7ColorPipelineWGSL(
            createHDRToSDRRenderSettings({
                display: { brightness: 0.1, contrast: 1.2, saturation: 0.8 },
                toneMapping: { inputPeakNits: 4_000 }
            }),
            'I420P10'
        );

        expect(secondShader).toBe(firstShader);
    });
});

describe('raw Dolby Vision frame formats', () => {
    it.each([
        'I420',
        'I420P10',
        'I420P12',
        'I422',
        'I422P10',
        'I422P12',
        'I444',
        'I444P10',
        'I444P12'
    ] as const)('reconstructs single-layer %s planes by the RPU base-layer depth', format => {
        expect(isRawDolbyVisionVideoFrameFormat(format)).toBe(true);
        const shader = createRawDolbyVisionColorPipelineWGSL(createHDRToSDRRenderSettings(), format);

        expect(shader).toContain('rawBaseSignal / (codeValueCount - 1.0)');
        expect(getRawFormatBitDepth(format)).toBe(getRawTestBitDepth(format));
    });

    it('excludes semi-planar NV12, which no RPU route decodes into', () => {
        expect(isRawDolbyVisionVideoFrameFormat('NV12')).toBe(false);
    });
});

describe('createRawDolbyVisionProfile4ColorPipelineWGSL', () => {
    it.each([
        [ 'base', createRawDolbyVisionProfile4ColorPipelineWGSL ],
        [ 'FEL', createRawDolbyVisionProfile4FELColorPipelineWGSL ]
    ] as const)(
        'presents the SDR base of an FEL frame without its EL from the %s shader, bypassing tone mapping',
        (_label, createShader) => {
            const shader = createShader(createHDRToSDRRenderSettings(), 'I420P10');
            const fragmentFunction = shader.slice(shader.indexOf('@fragment'));

            expect(shader).toContain('fn presentSDRBaseLayer(rawBaseSignal: vec3f) -> vec4f');
            // The SDR base uses BT.709 limited range at 10 bits
            expect(shader).toContain('normalizedYUV.x + 1.5748 * normalizedYUV.z');
            expect(shader).toContain(`(rawYUV.x - ${(64).toFixed(9)}) / ${(876).toFixed(9)}`);
            expect(fragmentFunction).toContain('return presentSDRBaseLayer(rawBaseSignal);');
            expect(fragmentFunction).toContain('encodedBT2020PQ = reconstructDolbyVisionBT2020PQ(rawBaseSignal)');
        }
    );

    it('keeps the Profile 7 HDR10-base fallback out of the Profile 4 shader', () => {
        const profile7Shader = createRawDolbyVisionProfile7ColorPipelineWGSL(createHDRToSDRRenderSettings(), 'I420P10');

        expect(profile7Shader).not.toContain('presentSDRBaseLayer');
        expect(profile7Shader).toContain('normalizedYUV.x + 1.4746 * normalizedYUV.z');
    });
});

describe('dual-layer Dolby Vision over every BL format', () => {
    const leftSitedChromaCoordinate =
        'textureCoordinate + vec2f(0.5 / f32(textureDimensions(lumaTexture).x), 0.0)';
    const dualLayerGenerators = [
        [ 'Profile 4', createRawDolbyVisionProfile4ColorPipelineWGSL, false, 'sdr' ],
        [ 'Profile 4 FEL', createRawDolbyVisionProfile4FELColorPipelineWGSL, true, 'sdr' ],
        [ 'Profile 7', createRawDolbyVisionProfile7ColorPipelineWGSL, false, 'hdr10' ],
        [ 'Profile 7 FEL', createRawDolbyVisionProfile7FELColorPipelineWGSL, true, 'hdr10' ]
    ] as const;

    describe.each([
        'I420',
        'I420P10',
        'I420P12',
        'I422',
        'I422P10',
        'I422P12',
        'I444',
        'I444P10',
        'I444P12'
    ] as const)('over %s BL planes', format => {
        it.each(dualLayerGenerators)(
            'generates the %s shader with the base at the format depth and the EL as I420P10',
            (_label, createShader, reconstructsFEL, baseLayerFallback) => {
                const shader = createShader(createHDRToSDRRenderSettings(), format);
                const fragmentFunction = shader.slice(shader.indexOf('@fragment'));
                const codeScale = 2 ** (getRawTestBitDepth(format) - 8);
                const chromaCoordinate = format.startsWith('I444') ?
                    'textureCoordinate' :
                    leftSitedChromaCoordinate;

                expect(shader).toContain('@binding(1) var lumaTexture: texture_2d<u32>');
                expect(shader).toContain('@binding(2) var chromaUTexture: texture_2d<u32>');
                expect(shader).toContain('@binding(3) var chromaVTexture: texture_2d<u32>');
                expect(shader).toContain('@binding(4) var<uniform> renderSettings');
                expect(shader).toContain('@binding(5) var<storage, read> dolbyVisionRPU');
                expect(shader).toContain(`sampleChromaU(${chromaCoordinate})`);
                expect(shader).toContain(`sampleChromaV(${chromaCoordinate})`);
                // The compatible base normalizes limited-range codes at the BL format's own depth
                expect(getWGSLFunction(shader, 'normalizeRawYUV')).toContain(
                    `(rawYUV.x - ${(16 * codeScale).toFixed(9)}) / ${(219 * codeScale).toFixed(9)}`
                );
                expect(getWGSLFunction(shader, 'normalizeRawYUV')).toContain(
                    `(rawYUV.z - ${(128 * codeScale).toFixed(9)}) / ${(224 * codeScale).toFixed(9)}`
                );
                expect(getWGSLFunction(shader, 'convertRawYUVToEncodedRGB')).toContain(
                    baseLayerFallback === 'sdr' ?
                        'normalizedYUV.x + 1.5748 * normalizedYUV.z' :
                        'normalizedYUV.x + 1.4746 * normalizedYUV.z'
                );
                expect(fragmentFunction).toContain(
                    baseLayerFallback === 'sdr' ?
                        'return presentSDRBaseLayer(rawBaseSignal);' :
                        'encodedBT2020PQ = convertRawYUVToEncodedRGB(normalizeRawYUV(rawBaseSignal));'
                );
                expect(fragmentFunction).toContain(
                    'encodedBT2020PQ = reconstructDolbyVisionBT2020PQ(rawBaseSignal)'
                );
                expect(shader.includes('fn presentSDRBaseLayer')).toBe(baseLayerFallback === 'sdr');
                expect(shader.includes('@binding(6) var enhancementLumaTexture: texture_2d<u32>'))
                    .toBe(reconstructsFEL);
                expect(shader.includes('@binding(9) var<uniform> enhancement')).toBe(reconstructsFEL);
                // The EL keeps its own 4:2:0 siting whatever the BL subsampling
                expect(shader.includes('-1.0 / lumaDimensions.x')).toBe(reconstructsFEL);
                expect(fragmentFunction.includes('sampleRawEnhancementYUV(textureCoordinate)'))
                    .toBe(reconstructsFEL);
            }
        );
    });

    it('keeps a dual-layer shader stable across live setting changes outside I420P10', () => {
        const firstShader = createRawDolbyVisionProfile4FELColorPipelineWGSL(
            createHDRToSDRRenderSettings(),
            'I444P12'
        );
        const secondShader = createRawDolbyVisionProfile4FELColorPipelineWGSL(
            createHDRToSDRRenderSettings({
                display: { brightness: 0.1, contrast: 1.2, saturation: 0.8 },
                toneMapping: { inputPeakNits: 4_000 }
            }),
            'I444P12'
        );

        expect(secondShader).toBe(firstShader);
    });
});

describe('createRawDolbyVisionProfile7FELColorPipelineWGSL', () => {
    it('binds, sites, and composes the decoded EL before Dolby color matrices', () => {
        const shader = createRawDolbyVisionProfile7FELColorPipelineWGSL(createHDRToSDRRenderSettings(), 'I420P10');
        const fragmentFunction = shader.slice(shader.indexOf('@fragment'));

        expect(shader).toContain('@binding(6) var enhancementLumaTexture');
        expect(shader).toContain('@binding(7) var enhancementChromaUTexture');
        expect(shader).toContain('@binding(8) var enhancementChromaVTexture');
        expect(shader).toContain('@binding(9) var<uniform> enhancement');
        expect(shader).toContain('-0.5 / dimensions.x');
        expect(shader).toContain('-1.0 / lumaDimensions.x');
        expect(fragmentFunction).toContain('enhancement.enhancementPresent != 0u');
        expect(fragmentFunction).toContain('reconstructDolbyVisionBT2020PQWithEnhancement');
        expect(fragmentFunction).toContain('convertRawYUVToEncodedRGB(normalizeRawYUV(rawBaseSignal))');
    });
});
