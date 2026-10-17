import { describe, expect, it } from 'vitest';

import {
    createHLGColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata
} from 'webgpu-player/color/ColorMetadata';
import {
    createBuiltinChain,
    getBuiltinColorFunctionNames
} from 'webgpu-player/presentation/passes/builtin/BuiltinChains';
import {
    createExternalHDRSignal,
    createExternalIdentitySignal,
    createRawDolbyVisionSignal,
    createRawYUVSignal,
    DEFAULT_CHROMA_LOCATION,
    INTERLACED_SIGNAL_CONDITION
} from 'webgpu-player/presentation/passes/builtin/BuiltinSignals';
import { createFramePoolSignal } from 'webgpu-player/presentation/passes/builtin/FramePoolSignal';
import type {
    BuiltinChain,
    BuiltinChainConfiguration,
    ColorState,
    EngineResource,
    RawDolbyVisionFrameFormat,
    SignalDefinition
} from 'webgpu-player/presentation/passes/PassTypes';
import type { DolbyVisionReconstructionProfile } from 'webgpu-player/presentation/PresentationInput';
import {
    createDefaultRenderSettings,
    createHDRToSDRRenderSettings
} from 'webgpu-player/presentation/RenderSettings';

const TRANSFER_DECODE = 'builtin.transfer-decode';
const TONE_MAP = 'builtin.tone-map';
const OUTPUT_ENCODE = 'builtin.output-encode';
const DISPLAY_CONTROLS = 'builtin.display-controls';
const DITHER = 'builtin.dither';
const SDR_OUTPUT_FUNCTION_NAMES: readonly string[] = [ TRANSFER_DECODE, TONE_MAP, OUTPUT_ENCODE, DISPLAY_CONTROLS, DITHER ];
const HDR_OUTPUT_FUNCTION_NAMES: readonly string[] = [ TRANSFER_DECODE, TONE_MAP, OUTPUT_ENCODE ];
const SDR_OUTPUT_STATES: readonly (readonly [ColorState, ColorState])[] = [
    [ 'source', 'linear' ],
    [ 'linear', 'display-linear' ],
    [ 'display-linear', 'display' ],
    [ 'display', 'display' ],
    [ 'display', 'display' ]
];

const PROFILE_4_FEL_WITHOUT_ENHANCEMENT_BYPASS = 'isDolbyVisionFEL() && enhancement.enhancementPresent == 0u';
const PROFILE_4_FEL_BYPASS = 'isDolbyVisionFEL()';
const SDR_BASE_LAYER_PRESENTATION = 'return presentSDRBaseLayer(rawBaseSignal);';
const HDR10_BASE_LAYER_PRESENTATION = 'encodedBT2020PQ = convertRawYUVToEncodedRGB(normalizeRawYUV(rawBaseSignal));';

const EXTERNAL_RESOURCES: readonly EngineResource[] = [ 'sampler-linear', 'external-texture' ];
const EXTERNAL_DOLBY_VISION_RESOURCES: readonly EngineResource[] = [ 'sampler-linear', 'external-texture', 'dolby-vision-rpu' ];
const RAW_DOLBY_VISION_RESOURCES: readonly EngineResource[] = [ 'planes-yuv', 'dolby-vision-rpu' ];
const RAW_DOLBY_VISION_FEL_RESOURCES: readonly EngineResource[] = [ 'planes-yuv', 'dolby-vision-rpu', 'dolby-vision-enhancement' ];

const DUAL_LAYER_FORMAT: RawDolbyVisionFrameFormat = 'I420P10';
// A deeper format than any default metadata, which the raw route's bit depth check rejects for 10-bit metadata
const MISMATCHED_RAW_FORMAT = 'I420P12';
const NON_NEUTRALIZED_BIT_DEPTH = 12;

const INTERLACED_CHROMA_NAME_SUFFIX = '.interlaced-chroma';
// A location other than the default left, which every route that reads or derives chroma takes
const DECLARED_CHROMA_LOCATION = 'top-left';
// The subsampling at which the external routes derive their planes' chroma
const DECLARED_CHROMA_SUBSAMPLING = '4:2:0';
const EIGHT_BIT_DEPTH = 8;
const TEN_BIT_DEPTH = 10;
// The raw formats whose chroma has half the luma's rows, which an interlaced frame's two fields share
const VERTICALLY_SUBSAMPLED_FORMATS = [
    { bitDepth: EIGHT_BIT_DEPTH, format: 'I420' },
    { bitDepth: TEN_BIT_DEPTH, format: 'I420P10' },
    { bitDepth: EIGHT_BIT_DEPTH, format: 'NV12' }
] as const;
const FULL_HEIGHT_CHROMA_FORMATS = [ 'I422', 'I444' ] as const;

/** The routes with a color track, which take hdrOutput. */
type ColorTrackConfiguration = Exclude<BuiltinChainConfiguration, { route: 'external-identity' }>;

function getColorFunctionNames(chain: BuiltinChain): string[] {
    return chain.colorFunctions.map(colorFunction => colorFunction.name);
}

function createToneMappedConfigurations(hdrOutput: boolean): ColorTrackConfiguration[] {
    const settings = createHDRToSDRRenderSettings();
    const configurations: ColorTrackConfiguration[] = [];
    configurations.push(
        { hdrOutput, metadata: createPQColorMetadata(), route: 'external-hdr', settings },
        { hdrOutput, route: 'external-dolby-vision', settings },
        { format: 'I420P10', hdrOutput, metadata: createHLGColorMetadata(), route: 'raw-yuv', settings },
        { felReconstruction: true, format: DUAL_LAYER_FORMAT, hdrOutput, profile: 7, route: 'raw-dolby-vision', settings },
        { format: 'I420P10', hdrOutput, metadata: createPQColorMetadata(), route: 'frame-pool', settings }
    );
    return configurations;
}

describe('getBuiltinColorFunctionNames', () => {
    it('names every built-in color function in color-track order', () => {
        expect(getBuiltinColorFunctionNames()).toEqual(SDR_OUTPUT_FUNCTION_NAMES);
    });
});

describe('createBuiltinChain', () => {
    it.each(createToneMappedConfigurations(false))('runs the full SDR color track for the $route route', configuration => {
        const chain = createBuiltinChain(configuration);

        expect(chain.sourceIsDisplay).toBe(false);
        expect(getColorFunctionNames(chain)).toEqual(SDR_OUTPUT_FUNCTION_NAMES);
        expect(chain.colorFunctions.map(colorFunction => [ colorFunction.inputState, colorFunction.outputState ])).toEqual(SDR_OUTPUT_STATES);
        // Only dither is pinned to the pass that writes the canvas
        expect(chain.colorFunctions.map(colorFunction => colorFunction.pinnedToOutput)).toEqual([ false, false, false, false, true ]);
        for (const colorFunction of chain.colorFunctions) {
            expect(colorFunction.code).toContain(`fn ${colorFunction.entryPoint}(color: vec4f, position: vec2f) -> vec4f {`);
        }
        expect(chain.signal.code).toContain(`fn ${chain.signal.entryPoint}(coordinate: vec2f) -> vec4f {`);
    });

    it.each(createToneMappedConfigurations(true))('decodes, tone maps, and encodes extended range for HDR output on the $route route', configuration => {
        const chain = createBuiltinChain(configuration);
        const sdrChain = createBuiltinChain({ ...configuration, hdrOutput: false });
        const outputEncode = chain.colorFunctions[2];

        expect(chain.sourceIsDisplay).toBe(false);
        expect(getColorFunctionNames(chain)).toEqual(HDR_OUTPUT_FUNCTION_NAMES);
        expect(chain.colorFunctions.slice(0, 2)).toEqual(sdrChain.colorFunctions.slice(0, 2));
        expect(outputEncode.outputState).toBe('display');
        expect(outputEncode.code).toContain('let relativeRGB = color.rgb / renderSettings.paperWhiteNits;');
        expect(outputEncode.code).toContain('return sign(relativeValue) * encodeSRGB(abs(relativeValue));');
        // Extended range: neither the output peak nor a clamp to 1 limits the encoded values
        expect(outputEncode.code).not.toContain('clamp(');
        expect(outputEncode.code).not.toContain('outputPeakNits');
    });

    it('presents the external identity route without color functions', () => {
        const chain = createBuiltinChain({ metadata: createSDRColorMetadata(), route: 'external-identity' });

        expect(chain.colorFunctions).toEqual([]);
        expect(chain.sourceIsDisplay).toBe(true);
        expect(chain.signal.resources).toEqual(EXTERNAL_RESOURCES);
        expect(chain.signal.sourceKind).toBe('external');
        expect(chain.signal.code).toContain('textureSampleBaseClampToEdge(videoTexture, videoSampler, coordinate)');
    });

    it.each([ false, true ])('presents identity SDR settings on raw planes without color functions, HDR output %s', hdrOutput => {
        const metadata = createSDRColorMetadata();
        const identityChain = createBuiltinChain({ format: 'I420', hdrOutput, metadata, route: 'raw-yuv', settings: createDefaultRenderSettings() });
        const toneMappedChain = createBuiltinChain({ format: 'I420', hdrOutput, metadata, route: 'raw-yuv', settings: createHDRToSDRRenderSettings() });

        expect(identityChain.colorFunctions).toEqual([]);
        expect(identityChain.sourceIsDisplay).toBe(true);
        // The signal is decode-equivalent, so the render settings never change it
        expect(identityChain.signal).toEqual(toneMappedChain.signal);
    });

    it('reads the GPU decoder\'s slots of its output format with the frame pool signal and the raw YUV color track', () => {
        const metadata = createPQColorMetadata();
        const settings = createHDRToSDRRenderSettings();
        const chain = createBuiltinChain({ format: 'I420P10', hdrOutput: false, metadata, route: 'frame-pool', settings });
        const rawChain = createBuiltinChain({ format: 'I420P10', hdrOutput: false, metadata, route: 'raw-yuv', settings });
        const identityChain = createBuiltinChain({
            format: 'I420',
            hdrOutput: false,
            metadata: createSDRColorMetadata(),
            route: 'frame-pool',
            settings: createDefaultRenderSettings()
        });

        expect(chain.signal).toEqual(createFramePoolSignal('I420P10', metadata));
        expect(chain.colorFunctions).toEqual(rawChain.colorFunctions);
        expect(identityChain.signal).toEqual(createFramePoolSignal('I420', createSDRColorMetadata()));
        expect(identityChain.colorFunctions).toEqual([]);
        expect(identityChain.sourceIsDisplay).toBe(true);
    });

    it('binds the plane textures each raw format needs', () => {
        const settings = createDefaultRenderSettings();
        const nv12Chain = createBuiltinChain({ format: 'NV12', hdrOutput: false, metadata: createSDRColorMetadata(), route: 'raw-yuv', settings });
        const planarChain = createBuiltinChain({ format: 'I444', hdrOutput: false, metadata: createSDRColorMetadata(), route: 'raw-yuv', settings });

        expect(nv12Chain.signal.resources).toEqual([ 'planes-nv12' ]);
        expect(planarChain.signal.resources).toEqual([ 'planes-yuv' ]);
        expect(nv12Chain.signal.sourceKind).toBe('planes');
        expect(planarChain.signal.sourceKind).toBe('planes');
    });

    it('reads the RPU for external Dolby Vision', () => {
        const chain = createBuiltinChain({ hdrOutput: false, route: 'external-dolby-vision', settings: createHDRToSDRRenderSettings() });

        expect(chain.signal.resources).toEqual(EXTERNAL_DOLBY_VISION_RESOURCES);
        expect(chain.signal.bypassCondition).toBeNull();
    });

    it('rejects external HDR metadata outside the neutralized Main10 route', () => {
        expect(() => createBuiltinChain({
            hdrOutput: false,
            metadata: createPQColorMetadata({ bitDepth: NON_NEUTRALIZED_BIT_DEPTH }),
            route: 'external-hdr',
            settings: createHDRToSDRRenderSettings()
        })).toThrow(`external-hdr: bitDepth ${NON_NEUTRALIZED_BIT_DEPTH}, expected 10`);
    });

    it('rejects metadata whose bit depth differs from the raw frame format', () => {
        expect(() => createBuiltinChain({
            format: MISMATCHED_RAW_FORMAT,
            hdrOutput: false,
            metadata: createPQColorMetadata(),
            route: 'raw-yuv',
            settings: createHDRToSDRRenderSettings()
        })).toThrow(`bit-depth: ${MISMATCHED_RAW_FORMAT} is 12-bit, metadata 10-bit`);
    });
});

describe('field-aware chroma for deinterlacing plans', () => {
    const settings = createDefaultRenderSettings();

    it.each(VERTICALLY_SUBSAMPLED_FORMATS)('reads $format chroma within each field of a frame marked interlaced', ({ bitDepth, format }) => {
        const metadata = createSDRColorMetadata({ bitDepth });
        const progressiveChain = createBuiltinChain({ format, hdrOutput: false, metadata, route: 'raw-yuv', settings });
        const interlacedChain = createBuiltinChain({ format, hdrOutput: false, interlacedChroma: true, metadata, route: 'raw-yuv', settings });

        expect(interlacedChain.signal.name).toBe(`${progressiveChain.signal.name}${INTERLACED_CHROMA_NAME_SUFFIX}`);
        expect(interlacedChain.signal.code).toContain(`if (${INTERLACED_SIGNAL_CONDITION}) {`);
        expect(interlacedChain.signal.resources).toEqual(progressiveChain.signal.resources);
        expect(interlacedChain.colorFunctions).toEqual(progressiveChain.colorFunctions);
        expect(progressiveChain.signal.code).not.toContain(INTERLACED_SIGNAL_CONDITION);
    });

    it.each(FULL_HEIGHT_CHROMA_FORMATS)('keeps the one %s read, whose chroma rows no two fields share', format => {
        const metadata = createSDRColorMetadata();

        expect(createBuiltinChain({ format, hdrOutput: false, interlacedChroma: true, metadata, route: 'raw-yuv', settings }))
            .toEqual(createBuiltinChain({ format, hdrOutput: false, metadata, route: 'raw-yuv', settings }));
    });

    it('reads the frame pool route\'s chroma within each field only with interlaced chroma', () => {
        const metadata = createSDRColorMetadata();

        expect(createBuiltinChain({ format: 'I420', hdrOutput: false, metadata, route: 'frame-pool', settings }).signal)
            .toEqual(createFramePoolSignal('I420', metadata));
        expect(createBuiltinChain({ format: 'I420', hdrOutput: false, interlacedChroma: true, metadata, route: 'frame-pool', settings }).signal)
            .toEqual(createFramePoolSignal('I420', metadata, true));
    });
});

describe('the stream\'s chroma location', () => {
    const settings = createHDRToSDRRenderSettings();

    it('reaches every route that reads or derives chroma', () => {
        const metadata = createPQColorMetadata();
        const sdrMetadata = createSDRColorMetadata();

        expect(createBuiltinChain({ chromaLocation: DECLARED_CHROMA_LOCATION, format: 'I420P10', hdrOutput: false, metadata, route: 'raw-yuv', settings }).signal)
            .toEqual(createRawYUVSignal('I420P10', metadata, false, DECLARED_CHROMA_LOCATION));
        expect(createBuiltinChain({ chromaLocation: DECLARED_CHROMA_LOCATION, format: 'I420P10', hdrOutput: false, metadata, route: 'frame-pool', settings }).signal)
            .toEqual(createFramePoolSignal('I420P10', metadata, false, DECLARED_CHROMA_LOCATION));
        expect(createBuiltinChain({
            chromaLocation: DECLARED_CHROMA_LOCATION,
            felReconstruction: true,
            format: DUAL_LAYER_FORMAT,
            hdrOutput: false,
            profile: 7,
            route: 'raw-dolby-vision',
            settings
        }).signal).toEqual(createRawDolbyVisionSignal(DUAL_LAYER_FORMAT, 7, true, DECLARED_CHROMA_LOCATION));
        expect(createBuiltinChain({
            chromaLocation: DECLARED_CHROMA_LOCATION,
            chromaSubsampling: DECLARED_CHROMA_SUBSAMPLING,
            hdrOutput: false,
            metadata,
            route: 'external-hdr',
            settings
        }).signal).toEqual(createExternalHDRSignal(metadata, DECLARED_CHROMA_SUBSAMPLING, DECLARED_CHROMA_LOCATION));
        expect(createBuiltinChain({ chromaLocation: DECLARED_CHROMA_LOCATION, chromaSubsampling: DECLARED_CHROMA_SUBSAMPLING, metadata: sdrMetadata, route: 'external-identity' }).signal)
            .toEqual(createExternalIdentitySignal(sdrMetadata, DECLARED_CHROMA_SUBSAMPLING, DECLARED_CHROMA_LOCATION));
    });

    it('reads chroma left where the stream declares no location, as H.264 and HEVC default', () => {
        const metadata = createSDRColorMetadata();
        const undeclaredSignal = createBuiltinChain({ format: 'I420', hdrOutput: false, metadata, route: 'raw-yuv', settings }).signal;

        expect(createBuiltinChain({ chromaLocation: null, format: 'I420', hdrOutput: false, metadata, route: 'raw-yuv', settings }).signal).toEqual(undeclaredSignal);
        expect(createBuiltinChain({ chromaLocation: DEFAULT_CHROMA_LOCATION, format: 'I420', hdrOutput: false, metadata, route: 'raw-yuv', settings }).signal).toEqual(undeclaredSignal);
        expect(createBuiltinChain({ chromaLocation: DECLARED_CHROMA_LOCATION, format: 'I420', hdrOutput: false, metadata, route: 'raw-yuv', settings }).signal)
            .not.toEqual(undeclaredSignal);
    });
});

describe('raw Dolby Vision signals', () => {
    const settings = createHDRToSDRRenderSettings();

    function createSignal(profile: DolbyVisionReconstructionProfile, felReconstruction: boolean): SignalDefinition {
        return createBuiltinChain({ felReconstruction, format: DUAL_LAYER_FORMAT, hdrOutput: false, profile, route: 'raw-dolby-vision', settings }).signal;
    }

    it('presents the Profile 4 SDR base of an FEL frame without its EL past every color function', () => {
        const signal = createSignal(4, true);

        expect(signal.bypassCondition).toBe(PROFILE_4_FEL_WITHOUT_ENHANCEMENT_BYPASS);
        expect(signal.code).toContain(SDR_BASE_LAYER_PRESENTATION);
        expect(signal.resources).toEqual(RAW_DOLBY_VISION_FEL_RESOURCES);
    });

    it('presents the Profile 4 SDR base of every FEL frame when it does not reconstruct FEL', () => {
        const signal = createSignal(4, false);

        expect(signal.bypassCondition).toBe(PROFILE_4_FEL_BYPASS);
        expect(signal.code).toContain(SDR_BASE_LAYER_PRESENTATION);
        expect(signal.code).not.toContain('sampleRawEnhancementYUV');
        expect(signal.resources).toEqual(RAW_DOLBY_VISION_RESOURCES);
    });

    it.each([ false, true ])('keeps the Profile 7 HDR10 base a PQ source, FEL reconstruction %s', felReconstruction => {
        const signal = createSignal(7, felReconstruction);

        expect(signal.bypassCondition).toBeNull();
        expect(signal.code).toContain(HDR10_BASE_LAYER_PRESENTATION);
        expect(signal.code).not.toContain('presentSDRBaseLayer');
        expect(signal.resources).toEqual(felReconstruction ? RAW_DOLBY_VISION_FEL_RESOURCES : RAW_DOLBY_VISION_RESOURCES);
    });

    it.each([ 5, 8 ] as const)('reconstructs single-layer Profile %i without an EL, whatever the FEL flag', profile => {
        const signal = createSignal(profile, true);
        const entryStart = signal.code.indexOf(`fn ${signal.entryPoint}(`);
        const entryFunction = signal.code.slice(entryStart, signal.code.indexOf('\n}', entryStart));

        expect(signal).toEqual(createSignal(profile, false));
        expect(signal.bypassCondition).toBeNull();
        expect(entryFunction).toContain('reconstructDolbyVisionBT2020PQ(\n        sampleRawYUV(coordinate)\n    );');
        expect(entryFunction).not.toContain('isDolbyVisionFEL');
        expect(signal.code).not.toContain('enhancement.');
        expect(signal.resources).toEqual(RAW_DOLBY_VISION_RESOURCES);
    });

    it('gives every chain entry point a distinct name', () => {
        const chain = createBuiltinChain({ felReconstruction: true, format: DUAL_LAYER_FORMAT, hdrOutput: false, profile: 4, route: 'raw-dolby-vision', settings });
        const entryPoints = [ chain.signal.entryPoint, ...chain.colorFunctions.map(colorFunction => colorFunction.entryPoint) ];

        expect(new Set(entryPoints).size).toBe(entryPoints.length);
    });
});
