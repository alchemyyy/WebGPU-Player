import { describe, expect, it } from 'vitest';

import { createPQColorMetadata, createSDRColorMetadata } from 'webgpu-player/color/ColorMetadata';
import { createBuiltinChain } from 'webgpu-player/presentation/passes/builtin/BuiltinChains';
import { parsePassExpression } from 'webgpu-player/presentation/passes/PassExpression';
import type {
    BuiltinChain,
    PassManifest,
    PlanFacts,
    PlanRequest,
    PlannedBinding,
    PlannedOutput,
    PlannedPass,
    PresentationPlan
} from 'webgpu-player/presentation/passes/PassTypes';
import { planPresentation } from 'webgpu-player/presentation/passes/PresentationPlanner';
import { createDefaultRenderSettings, createHDRToSDRRenderSettings } from 'webgpu-player/presentation/RenderSettings';

const SOURCE_WIDTH = 1920;
const SOURCE_HEIGHT = 1080;
const OUTPUT_WIDTH = 2560;
const OUTPUT_HEIGHT = 1440;
const MAXIMUM_TEXTURE_DIMENSION = 8192;
const SDR_OUTPUT: PlannedOutput = { colorSpace: 'srgb', format: 'bgra8unorm', toneMapping: 'standard' };
const BODY_FIRST_LINE = 7;
const HDR_FORMAT = 'I420P10';

const TRANSFER_DECODE_ENTRY_POINT = 'applyBuiltinTransferDecode';
const TONE_MAP_ENTRY_POINT = 'applyBuiltinToneMap';
const OUTPUT_ENCODE_ENTRY_POINT = 'applyBuiltinOutputEncode';
const DISPLAY_CONTROLS_ENTRY_POINT = 'applyBuiltinDisplayControls';
const DITHER_ENTRY_POINT = 'applyBuiltinDither';
const SDR_STEP_ENTRY_POINTS: readonly string[] = [
    TRANSFER_DECODE_ENTRY_POINT,
    TONE_MAP_ENTRY_POINT,
    OUTPUT_ENCODE_ENTRY_POINT,
    DISPLAY_CONTROLS_ENTRY_POINT,
    DITHER_ENTRY_POINT
];
const SIGNAL_ENTRY_POINT = 'sampleBuiltinSignal';
const TONE_MAP_NAME = 'builtin.tone-map';
const PROFILE_4_BYPASS = 'isDolbyVisionFEL()';

const COLOR_BODY = `
fn luma(color: vec3f) -> f32 {
    return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

fn apply(color: vec4f, position: vec2f) -> vec4f {
    return vec4f(mix(vec3f(luma(color.rgb)), color.rgb, parameters.gain), color.a);
}
`;
const KERNEL_BODY = `
fn kernel(coordinate: vec2f) -> vec4f {
    return HOOKED_tex(coordinate);
}
`;
const SCALER_BODY = `
fn scale(coordinate: vec2f) -> vec4f {
    return HOOKED_tex(coordinate);
}
`;
const COMPUTE_BODY = `
fn compute(id: vec3u) {
    if (any(id.xy >= TARGET_size())) {
        return;
    }
    TARGET_store(id.xy, HOOKED_tex((vec2f(id.xy) + vec2f(0.5)) / vec2f(TARGET_size())));
}
`;
const GAIN_PARAMETER = { defaultValue: 1, maximum: 2, minimum: 0, name: 'gain', type: 'f32' } as const;
const HOOKED_SIZE_OUTPUT = { format: 'rgba16float', height: parsePassExpression('HOOKED.height'), width: parsePassExpression('HOOKED.width') } as const;
const WORKGROUP_SIZE = 8;
const COMPUTE_WORKGROUP = {
    dispatch: [ parsePassExpression(`ceil(HOOKED.width / ${WORKGROUP_SIZE})`), parsePassExpression(`ceil(HOOKED.height / ${WORKGROUP_SIZE})`), parsePassExpression('1') ],
    size: [ WORKGROUP_SIZE, WORKGROUP_SIZE, 1 ]
} as const;

function createHDRChain(): BuiltinChain {
    return createBuiltinChain({ format: HDR_FORMAT, hdrOutput: false, metadata: createPQColorMetadata(), route: 'raw-yuv', settings: createHDRToSDRRenderSettings() });
}

function createIdentityChain(): BuiltinChain {
    return createBuiltinChain({ format: 'I420', hdrOutput: false, metadata: createSDRColorMetadata({ bitDepth: 8 }), route: 'raw-yuv', settings: createDefaultRenderSettings() });
}

function createFacts(overrides: Partial<PlanFacts> = {}): PlanFacts {
    return {
        frameRate: null,
        hdrOutput: false,
        hdrSource: true,
        outputHeight: OUTPUT_HEIGHT,
        outputWidth: OUTPUT_WIDTH,
        sourceHeight: SOURCE_HEIGHT,
        sourceWidth: SOURCE_WIDTH,
        ...overrides
    };
}

function createManifest(overrides: Partial<PassManifest> & Pick<PassManifest, 'body' | 'name' | 'shape'>): PassManifest {
    return {
        bodyFirstLine: BODY_FIRST_LINE,
        components: null,
        domain: 'any',
        hook: 'OUTPUT',
        inputs: [],
        offset: null,
        output: null,
        parameters: [],
        replaces: null,
        save: null,
        when: null,
        workgroup: null,
        ...overrides
    };
}

function createColorPass(overrides: Partial<PassManifest> = {}): PassManifest {
    return createManifest({ body: COLOR_BODY, domain: 'display', name: 'Saturation', parameters: [ GAIN_PARAMETER ], shape: 'color', ...overrides });
}

function createKernelPass(overrides: Partial<PassManifest> = {}): PassManifest {
    return createManifest({
        body: KERNEL_BODY,
        inputs: [ { historyOffset: 0, name: 'HOOKED' } ],
        name: 'Copy',
        output: HOOKED_SIZE_OUTPUT,
        shape: 'kernel',
        ...overrides
    });
}

function plan(chain: BuiltinChain, passes: readonly PassManifest[], facts: PlanFacts = createFacts()): PresentationPlan {
    return planPresentation({ chain, device: { features: new Set<string>(), maximumTextureDimension: MAXIMUM_TEXTURE_DIMENSION }, facts, output: SDR_OUTPUT, passes });
}

/** Returns the entry points of a pass's color steps, in the order its module calls them. */
function getStepCalls(pass: PlannedPass): string[] {
    return [ ...pass.code.matchAll(/color = (\w+)\(color, /g) ].map((match: RegExpMatchArray): string => match[1]);
}

function getTextureBindings(pass: PlannedPass): Extract<PlannedBinding, { kind: 'texture' }>[] {
    return pass.bindings.filter((binding: PlannedBinding): binding is Extract<PlannedBinding, { kind: 'texture' }> => binding.kind === 'texture');
}

describe('planPresentation without user passes', () => {
    it('plans one object-fit pass that reads the source and writes the output', () => {
        const presentationPlan = plan(createHDRChain(), []);

        expect(presentationPlan.passes).toHaveLength(1);
        const [ pass ] = presentationPlan.passes;
        expect(pass.target).toEqual({ kind: 'output' });
        expect(pass.coordinateMapping).toBe('object-fit');
        expect(pass.inputTextureId).toBeNull();
        expect(pass.kind).toBe('render');
        expect(pass.code).toContain(`var color = ${SIGNAL_ENTRY_POINT}(textureCoordinate);`);
        expect(getStepCalls(pass)).toEqual(SDR_STEP_ENTRY_POINTS);
        expect(presentationPlan.textures).toEqual([]);
        expect(presentationPlan.sourceKind).toBe('planes');
        expect(presentationPlan.usesRenderSettings).toBe(true);
    });

    it('binds the presentation uniform first, then the engine resources of the signal and the steps', () => {
        const [ pass ] = plan(createHDRChain(), []).passes;

        expect(pass.bindings).toEqual([
            { binding: 0, kind: 'presentation' },
            { binding: 1, kind: 'engine', resource: 'plane-luma' },
            { binding: 2, kind: 'engine', resource: 'plane-chroma-u' },
            { binding: 3, kind: 'engine', resource: 'plane-chroma-v' },
            { binding: 4, kind: 'engine', resource: 'render-settings' }
        ]);
    });

    it('presents identity SDR as the signal alone, without render settings', () => {
        const presentationPlan = plan(createIdentityChain(), []);

        expect(presentationPlan.passes).toHaveLength(1);
        expect(getStepCalls(presentationPlan.passes[0])).toEqual([]);
        expect(presentationPlan.passes[0].code).toContain(`let color = ${SIGNAL_ENTRY_POINT}(textureCoordinate);`);
        expect(presentationPlan.usesRenderSettings).toBe(false);
    });

    it('accepts 1x1 facts, since a default plan sizes nothing from them', () => {
        const presentationPlan = plan(createHDRChain(), [], createFacts({ outputHeight: 1, outputWidth: 1, sourceHeight: 1, sourceWidth: 1 }));

        expect(presentationPlan.passes).toHaveLength(1);
    });

    it('guards every step with the Profile 4 bypass in the pass that reads the signal', () => {
        const chain = createBuiltinChain({
            felReconstruction: false,
            format: HDR_FORMAT,
            hdrOutput: false,
            profile: 4,
            route: 'raw-dolby-vision',
            settings: createHDRToSDRRenderSettings()
        });
        const [ pass ] = plan(chain, []).passes;

        expect(pass.code).toContain(`if (${PROFILE_4_BYPASS}) {\n        return color;\n    }`);
        expect(pass.code.indexOf(PROFILE_4_BYPASS)).toBeLessThan(pass.code.indexOf(`color = ${TRANSFER_DECODE_ENTRY_POINT}(`));
    });
});

describe('planPresentation with color passes', () => {
    it('fuses a display color pass after the output encode and before the display controls and dither', () => {
        const presentationPlan = plan(createHDRChain(), [ createColorPass() ]);

        expect(presentationPlan.passes).toHaveLength(1);
        expect(getStepCalls(presentationPlan.passes[0])).toEqual([
            TRANSFER_DECODE_ENTRY_POINT,
            TONE_MAP_ENTRY_POINT,
            OUTPUT_ENCODE_ENTRY_POINT,
            'user0_apply',
            DISPLAY_CONTROLS_ENTRY_POINT,
            DITHER_ENTRY_POINT
        ]);
        expect(presentationPlan.report.activePasses).toEqual([ 'Saturation' ]);
        expect(presentationPlan.parameterSets).toEqual([ { parameters: [ GAIN_PARAMETER ], passName: 'Saturation' } ]);
    });

    it('renames the body\'s module-scope names, entry point, and parameters, but not member names', () => {
        const [ pass ] = plan(createHDRChain(), [ createColorPass() ]).passes;

        expect(pass.code).toContain('fn user0_luma(color: vec3f) -> f32 {');
        expect(pass.code).toContain('fn user0_apply(color: vec4f, position: vec2f) -> vec4f {');
        expect(pass.code).toContain('mix(vec3f(user0_luma(color.rgb)), color.rgb, user0_parameters.gain)');
        expect(pass.code).toContain('var<uniform> user0_parameters: user0_Parameters;');
        expect(pass.bindings).toContainEqual({ binding: 5, kind: 'parameters', passName: 'Saturation' });
    });

    it('maps the body\'s generated lines back to its source lines', () => {
        const [ pass ] = plan(createHDRChain(), [ createColorPass() ]).passes;
        const [ mapping ] = pass.lineMap;
        const generatedLines = pass.code.split('\n');

        expect(pass.lineMap).toHaveLength(1);
        expect(mapping.passName).toBe('Saturation');
        expect(mapping.firstSourceLine).toBe(BODY_FIRST_LINE);
        expect(mapping.lineCount).toBe(COLOR_BODY.split('\n').length);
        expect(generatedLines[mapping.firstGeneratedLine]).toBe('fn user0_luma(color: vec3f) -> f32 {');
    });

    it('places a linear color pass right after the transfer decode', () => {
        const [ pass ] = plan(createHDRChain(), [ createColorPass({ domain: 'linear' }) ]).passes;

        expect(getStepCalls(pass).slice(0, 2)).toEqual([ TRANSFER_DECODE_ENTRY_POINT, 'user0_apply' ]);
    });

    it('replaces a built-in color function in its place on the track', () => {
        const replacement = createColorPass({ domain: 'any', hook: null, name: 'Tone map', replaces: TONE_MAP_NAME });
        const [ pass ] = plan(createHDRChain(), [ replacement ]).passes;

        expect(getStepCalls(pass)).toEqual([
            TRANSFER_DECODE_ENTRY_POINT,
            'user0_apply',
            OUTPUT_ENCODE_ENTRY_POINT,
            DISPLAY_CONTROLS_ENTRY_POINT,
            DITHER_ENTRY_POINT
        ]);
        expect(pass.code).not.toContain(`fn ${TONE_MAP_ENTRY_POINT}(`);
    });

    it('rejects replacing a function the route does not run', () => {
        const replacement = createColorPass({ domain: 'any', hook: null, name: 'Tone map', replaces: TONE_MAP_NAME });
        const presentationPlan = plan(createIdentityChain(), [ replacement ]);

        expect(presentationPlan.report.activePasses).toEqual([]);
        expect(presentationPlan.report.inactivePasses).toEqual([ { detail: TONE_MAP_NAME, name: 'Tone map', reason: 'replaced-function-missing' } ]);
    });

    it('rejects a linear pass after a display kernel, since tone mapping cannot be undone', () => {
        const kernel = createKernelPass({ domain: 'display', name: 'Sharpen' });
        const linearPass = createColorPass({ domain: 'linear', name: 'Exposure' });
        const presentationPlan = plan(createHDRChain(), [ kernel, linearPass ]);

        expect(presentationPlan.report.activePasses).toEqual([ 'Sharpen' ]);
        expect(presentationPlan.report.inactivePasses).toEqual([ { detail: 'linear from display', name: 'Exposure', reason: 'domain-unreachable' } ]);
    });
});

describe('planPresentation with kernels, scalers, and compute passes', () => {
    it('renders the scaler into an output-size texture for an OUTPUT kernel, which then writes the output', () => {
        const presentationPlan = plan(createHDRChain(), [ createKernelPass({ domain: 'sdr', name: 'Sharpen' }) ]);
        const [ scalePass, kernelPass ] = presentationPlan.passes;

        expect(presentationPlan.passes).toHaveLength(2);
        expect(scalePass.target).toEqual({ kind: 'texture', textureId: 'scale' });
        expect(scalePass.coordinateMapping).toBe('object-fit');
        expect(getStepCalls(scalePass)).toEqual([ TRANSFER_DECODE_ENTRY_POINT, TONE_MAP_ENTRY_POINT, OUTPUT_ENCODE_ENTRY_POINT ]);
        expect(kernelPass.target).toEqual({ kind: 'output' });
        expect(kernelPass.coordinateMapping).toBe('identity');
        expect(kernelPass.inputTextureId).toBe('scale');
        expect(getStepCalls(kernelPass)).toEqual([ DISPLAY_CONTROLS_ENTRY_POINT, DITHER_ENTRY_POINT ]);
        expect(presentationPlan.textures).toEqual([
            { format: 'rgba16float', height: OUTPUT_HEIGHT, historyDepth: 0, id: 'scale', storage: false, width: OUTPUT_WIDTH }
        ]);
    });

    it('materializes the signal at source size for an RGB kernel, and scales its texture bilinearly', () => {
        const presentationPlan = plan(createHDRChain(), [ createKernelPass({ hook: 'RGB' }) ]);
        const [ signalPass, kernelPass, scalePass ] = presentationPlan.passes;

        expect(presentationPlan.passes).toHaveLength(3);
        expect(signalPass.target).toEqual({ kind: 'texture', textureId: 'signal' });
        expect(signalPass.coordinateMapping).toBe('identity');
        expect(signalPass.inputTextureId).toBeNull();
        expect(getStepCalls(signalPass)).toEqual([]);
        expect(kernelPass.target).toEqual({ kind: 'texture', textureId: 'pass:Copy' });
        expect(scalePass.inputTextureId).toBe('pass:Copy');
        expect(scalePass.coordinateMapping).toBe('object-fit');
        expect(scalePass.code).toContain('var color = engineInput_tex(textureCoordinate);');
        expect(getStepCalls(scalePass)).toEqual(SDR_STEP_ENTRY_POINTS);
        expect(presentationPlan.textures.map(texture => [ texture.id, texture.width, texture.height ])).toEqual([
            [ 'signal', SOURCE_WIDTH, SOURCE_HEIGHT ],
            [ 'pass:Copy', SOURCE_WIDTH, SOURCE_HEIGHT ]
        ]);
    });

    it('reads a user scaler\'s input from the materialized signal, through the object-fit mapping', () => {
        const scaler = createManifest({ body: SCALER_BODY, hook: 'SCALE', inputs: [ { historyOffset: 0, name: 'HOOKED' } ], name: 'Scaler', shape: 'scaler' });
        const presentationPlan = plan(createHDRChain(), [ scaler ]);
        const [ signalPass, scalerPass ] = presentationPlan.passes;

        expect(presentationPlan.passes).toHaveLength(2);
        expect(signalPass.target).toEqual({ kind: 'texture', textureId: 'signal' });
        expect(scalerPass.coordinateMapping).toBe('object-fit');
        expect(scalerPass.target).toEqual({ kind: 'output' });
        expect(scalerPass.code).toContain('var color = user0_scale(textureCoordinate);');
        expect(getStepCalls(scalerPass)).toEqual(SDR_STEP_ENTRY_POINTS);
    });

    it('runs only the first scaler', () => {
        const firstScaler = createManifest({ body: SCALER_BODY, hook: 'SCALE', name: 'First', shape: 'scaler' });
        const secondScaler = createManifest({ body: SCALER_BODY, hook: 'SCALE', name: 'Second', shape: 'scaler' });
        const presentationPlan = plan(createHDRChain(), [ firstScaler, secondScaler ]);

        expect(presentationPlan.report.activePasses).toEqual([ 'First' ]);
        expect(presentationPlan.report.inactivePasses).toEqual([ { detail: '\'First\' runs', name: 'Second', reason: 'extra-scaler' } ]);
    });

    it('dispatches a compute pass into a storage texture, which a final pass presents', () => {
        const compute = createManifest({
            body: COMPUTE_BODY,
            inputs: [ { historyOffset: 0, name: 'HOOKED' } ],
            name: 'Compute',
            output: HOOKED_SIZE_OUTPUT,
            shape: 'compute',
            workgroup: COMPUTE_WORKGROUP
        });
        const presentationPlan = plan(createHDRChain(), [ compute ]);
        const computePass = presentationPlan.passes[1];
        const outputPass = presentationPlan.passes[2];

        expect(presentationPlan.passes).toHaveLength(3);
        expect(computePass.kind).toBe('compute');
        expect(computePass.target).toBeNull();
        expect(computePass.workgroupCounts).toEqual([ OUTPUT_WIDTH / WORKGROUP_SIZE, OUTPUT_HEIGHT / WORKGROUP_SIZE, 1 ]);
        expect(getTextureBindings(computePass).map(binding => [ binding.access, binding.textureId ])).toEqual([
            [ 'sampled', 'scale' ],
            [ 'storage', 'pass:Compute' ]
        ]);
        expect(computePass.code).toContain(`@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE}, 1)`);
        expect(outputPass.target).toEqual({ kind: 'output' });
        expect(outputPass.inputTextureId).toBe('pass:Compute');
        expect(presentationPlan.textures.find(texture => texture.id === 'pass:Compute')?.storage).toBe(true);
    });

    it('gives a stage read with history a ring, and binds the earlier slot', () => {
        const temporal = createKernelPass({
            hook: 'RGB',
            inputs: [ { historyOffset: 0, name: 'HOOKED' }, { historyOffset: -1, name: 'RGB' } ],
            name: 'Temporal'
        });
        const presentationPlan = plan(createHDRChain(), [ temporal ]);
        const temporalPass = presentationPlan.passes[1];

        expect(getTextureBindings(temporalPass).map(binding => [ binding.textureId, binding.historyOffset ])).toEqual([
            [ 'signal', 0 ],
            [ 'pass:Temporal', -1 ]
        ]);
        expect(temporalPass.code).toContain('fn RGB_history1_tex(coordinate: vec2f) -> vec4f {');
        expect(presentationPlan.textures.find(texture => texture.id === 'pass:Temporal')?.historyDepth).toBe(1);
    });

    it('carries later color steps in a pass of their own once a saving pass read the image as it was', () => {
        const saver = createKernelPass({ hook: 'RGB', name: 'Saver', save: 'saved' });
        const colorPass = createColorPass({ domain: 'any', hook: 'RGB' });
        const presentationPlan = plan(createHDRChain(), [ saver, colorPass ]);

        expect(presentationPlan.passes.map((pass: PlannedPass): string => pass.label)).toEqual([
            'Presentation signal',
            'Presentation pass \'Saver\'',
            'Presentation color',
            'Presentation scale'
        ]);
        expect(getStepCalls(presentationPlan.passes[2])).toEqual([ 'user1_apply' ]);
    });

    it('completes the color track in the signal pass of a bypassing signal before a kernel reads it', () => {
        const chain = createBuiltinChain({
            felReconstruction: false,
            format: HDR_FORMAT,
            hdrOutput: false,
            profile: 4,
            route: 'raw-dolby-vision',
            settings: createHDRToSDRRenderSettings()
        });
        const presentationPlan = plan(chain, [ createKernelPass({ hook: 'RGB' }) ]);
        const [ signalPass, , scalePass ] = presentationPlan.passes;

        expect(getStepCalls(signalPass)).toEqual([ TRANSFER_DECODE_ENTRY_POINT, TONE_MAP_ENTRY_POINT, OUTPUT_ENCODE_ENTRY_POINT ]);
        expect(signalPass.code).toContain(`if (${PROFILE_4_BYPASS}) {`);
        expect(getStepCalls(scalePass)).toEqual([ DISPLAY_CONTROLS_ENTRY_POINT, DITHER_ENTRY_POINT ]);
    });
});

describe('planPresentation reports', () => {
    it('leaves out a pass whose condition is false, without a conflict', () => {
        const presentationPlan = plan(createHDRChain(), [ createColorPass({ when: parsePassExpression('output.width < source.width') }) ]);

        expect(presentationPlan.report.inactivePasses).toEqual([ { detail: '', name: 'Saturation', reason: 'condition-false' } ]);
        expect(presentationPlan.passes).toHaveLength(1);
    });

    it('rejects an SDR pass on an HDR output', () => {
        const presentationPlan = plan(createHDRChain(), [ createKernelPass({ domain: 'sdr' }) ], createFacts({ hdrOutput: true }));

        expect(presentationPlan.report.inactivePasses).toEqual([ { detail: 'sdr', name: 'Copy', reason: 'sdr-on-hdr-output' } ]);
    });

    it('rejects a second pass with the same name', () => {
        const presentationPlan = plan(createHDRChain(), [ createColorPass(), createColorPass() ]);

        expect(presentationPlan.report.activePasses).toEqual([ 'Saturation' ]);
        expect(presentationPlan.report.inactivePasses).toEqual([ { detail: 'position 2', name: 'Saturation', reason: 'duplicate-name' } ]);
    });

    it('rejects an input that no earlier pass saves', () => {
        const presentationPlan = plan(createHDRChain(), [ createKernelPass({ inputs: [ { historyOffset: 0, name: 'missing' } ] }) ]);

        expect(presentationPlan.report.inactivePasses).toEqual([ { detail: '\'missing\'', name: 'Copy', reason: 'input-unknown' } ]);
    });

    it('rejects an output size beyond the device limit', () => {
        const oversized = createKernelPass({ output: { ...HOOKED_SIZE_OUTPUT, width: parsePassExpression(`${MAXIMUM_TEXTURE_DIMENSION + 1}`) } });
        const presentationPlan = plan(createHDRChain(), [ oversized ]);

        expect(presentationPlan.report.inactivePasses).toEqual([
            { detail: `width ${MAXIMUM_TEXTURE_DIMENSION + 1} outside [1, ${MAXIMUM_TEXTURE_DIMENSION}]`, name: 'Copy', reason: 'output-size' }
        ]);
        expect(presentationPlan.passes).toHaveLength(1);
    });
});

describe('planPresentation color step names', () => {
    it('names each pass\'s color steps in order, built-in functions by name and user passes by manifest name', () => {
        const presentationPlan = plan(createHDRChain(), [ createColorPass() ]);

        expect(presentationPlan.passes[0].colorSteps).toEqual([
            'builtin.transfer-decode',
            'builtin.tone-map',
            'builtin.output-encode',
            'Saturation',
            'builtin.display-controls',
            'builtin.dither'
        ]);
    });
});

describe('planPresentation with deinterlacing', () => {
    // An anamorphic 576i frame, which displays wider than its samples
    const FRAME_WIDTH = 720;
    const FRAME_HEIGHT = 576;
    const DISPLAY_WIDTH = 1024;
    const DEINTERLACE_BIT_DEPTH = 10;
    const DEINTERLACE = { bitDepth: DEINTERLACE_BIT_DEPTH, frameHeight: FRAME_HEIGHT, frameWidth: FRAME_WIDTH } as const;
    const SIGNAL_LABEL = 'Presentation signal';
    const DEINTERLACE_LABEL = 'Presentation deinterlace';
    const SCALE_LABEL = 'Presentation scale';
    const DEINTERLACE_SCORE_BIAS_LITERAL = `0x1p-${DEINTERLACE_BIT_DEPTH}f`;
    // The pass runs no color step, which the scaler's pass takes
    const DEINTERLACE_CORE = 'let color = applyBuiltinDeinterlace(input.position.xy);';

    function planDeinterlaced(chain: BuiltinChain, passes: readonly PassManifest[], deinterlace: PlanRequest['deinterlace'] = DEINTERLACE): PresentationPlan {
        return planPresentation({
            chain,
            deinterlace,
            device: { features: new Set<string>(), maximumTextureDimension: MAXIMUM_TEXTURE_DIMENSION },
            facts: createFacts({ sourceHeight: FRAME_HEIGHT, sourceWidth: DISPLAY_WIDTH }),
            output: SDR_OUTPUT,
            passes
        });
    }

    it('makes the signal a ring of the frame\'s own size, which the deinterlacing pass reads three frames deep before the scaler', () => {
        const presentationPlan = planDeinterlaced(createHDRChain(), []);

        expect(presentationPlan.passes.map((pass: PlannedPass): string => pass.label)).toEqual([ SIGNAL_LABEL, DEINTERLACE_LABEL, SCALE_LABEL ]);
        expect(presentationPlan.deinterlace).toEqual(DEINTERLACE);
        expect(presentationPlan.textures).toEqual([
            { format: 'rgba16float', height: FRAME_HEIGHT, historyDepth: 2, id: 'signal', storage: false, width: FRAME_WIDTH },
            { format: 'rgba16float', height: FRAME_HEIGHT, historyDepth: 0, id: 'deinterlace', storage: false, width: FRAME_WIDTH }
        ]);
        const [ signalPass, deinterlacePass, scalePass ] = presentationPlan.passes;
        expect(signalPass.target).toEqual({ kind: 'texture', textureId: 'signal' });
        expect(signalPass.coordinateMapping).toBe('identity');
        expect(getStepCalls(signalPass)).toEqual([]);
        expect(deinterlacePass.target).toEqual({ kind: 'texture', textureId: 'deinterlace' });
        expect(deinterlacePass.inputTextureId).toBe('signal');
        expect(getTextureBindings(deinterlacePass).map(binding => [ binding.textureId, binding.historyOffset ])).toEqual([ [ 'signal', 0 ], [ 'signal', -1 ], [ 'signal', -2 ] ]);
        expect(deinterlacePass.code).toContain(DEINTERLACE_CORE);
        expect(deinterlacePass.code).toContain(DEINTERLACE_SCORE_BIAS_LITERAL);
        expect(deinterlacePass.code).toContain('var deinterlaceSignal_history2_texture: texture_2d<f32>;');
        expect(scalePass.inputTextureId).toBe('deinterlace');
        expect(scalePass.target).toEqual({ kind: 'output' });
        expect(getStepCalls(scalePass)).toEqual(SDR_STEP_ENTRY_POINTS);
    });

    it('hands user passes at RGB the deinterlaced image at the frame\'s size', () => {
        const presentationPlan = planDeinterlaced(createHDRChain(), [ createKernelPass({ domain: 'source', hook: 'RGB' }) ]);

        expect(presentationPlan.report.activePasses).toEqual([ 'Copy' ]);
        const copyPass = presentationPlan.passes.find((pass: PlannedPass): boolean => pass.label === 'Presentation pass \'Copy\'');
        expect(copyPass?.inputTextureId).toBe('deinterlace');
        expect(presentationPlan.textures.find(texture => texture.id === 'pass:Copy')).toMatchObject({ height: FRAME_HEIGHT, width: FRAME_WIDTH });
    });

    it('plans no deinterlacing without a request, or for a signal whose bypass skips the color track', () => {
        const profile4Chain = createBuiltinChain({
            felReconstruction: false,
            format: HDR_FORMAT,
            hdrOutput: false,
            profile: 4,
            route: 'raw-dolby-vision',
            settings: createHDRToSDRRenderSettings()
        });

        expect(planDeinterlaced(createHDRChain(), [], null).deinterlace).toBeNull();
        expect(planDeinterlaced(createHDRChain(), [], null).passes).toHaveLength(1);
        expect(planDeinterlaced(profile4Chain, []).deinterlace).toBeNull();
        expect(planDeinterlaced(profile4Chain, []).passes).toHaveLength(1);
    });

    it('fails on a frame size the device cannot hold', () => {
        expect(() => planDeinterlaced(createHDRChain(), [], { ...DEINTERLACE, frameWidth: MAXIMUM_TEXTURE_DIMENSION + 1 }))
            .toThrow(`deinterlace-size: frame width ${MAXIMUM_TEXTURE_DIMENSION + 1} outside [1, ${MAXIMUM_TEXTURE_DIMENSION}]`);
    });
});

describe('planPresentation with plane passes', () => {
    const CHROMA_WIDTH = SOURCE_WIDTH / 2;
    const CHROMA_HEIGHT = SOURCE_HEIGHT / 2;
    // Left-sited 4:2:0 chroma lies half a luma sample, a quarter of a chroma sample, left of its texel's center
    const LEFT_SITED_CHROMA_OFFSET = 0.25;
    const LUMA_LABEL = 'Presentation luma plane';
    const CHROMA_LABEL = 'Presentation chroma plane';
    const NATIVE_LABEL = 'Presentation native';
    const MERGE_LABEL = 'Presentation merge';
    const SCALE_LABEL = 'Presentation scale';
    const SIGNAL_LABEL = 'Presentation signal';
    const UPSCALER_LABEL = 'Presentation pass \'Chroma upscaler\'';
    const MAIN_LABEL = 'Presentation pass \'Main\'';
    const ZERO_VECTOR = 'vec2f(0.000000000, 0.000000000)';
    const DOUBLER_OFFSET = -0.5;
    const DOUBLING_FACTOR = 2;
    const DEEP_BIT_DEPTH = 12;
    const CHROMA_INPUT = { historyOffset: 0, name: 'CHROMA' } as const;
    const LUMA_INPUT = { historyOffset: 0, name: 'LUMA' } as const;
    const HOOKED_INPUT = { historyOffset: 0, name: 'HOOKED' } as const;
    const LUMA_SIZE_OUTPUT = { format: 'rgba16float', height: parsePassExpression('LUMA.height'), width: parsePassExpression('LUMA.width') } as const;
    const DOUBLED_OUTPUT = {
        format: 'rgba16float',
        height: parsePassExpression(`HOOKED.height * ${DOUBLING_FACTOR}`),
        width: parsePassExpression(`HOOKED.width * ${DOUBLING_FACTOR}`)
    } as const;
    const SUBSAMPLED_CONDITION = parsePassExpression('chroma.width < source.width');

    function createSDRChain(): BuiltinChain {
        return createBuiltinChain({ format: 'I420', hdrOutput: false, metadata: createSDRColorMetadata({ bitDepth: 8 }), route: 'raw-yuv', settings: createHDRToSDRRenderSettings() });
    }

    function createExternalChain(): BuiltinChain {
        return createBuiltinChain({ hdrOutput: false, metadata: createPQColorMetadata(), route: 'external-hdr', settings: createHDRToSDRRenderSettings() });
    }

    /** A chroma upscaler's last pass: chroma at luma's size, aligned with the reference grid, as KrigBilateral's is. */
    function createChromaUpscaler(overrides: Partial<PassManifest> = {}): PassManifest {
        return createKernelPass({
            hook: 'CHROMA',
            inputs: [ HOOKED_INPUT, LUMA_INPUT ],
            name: 'Chroma upscaler',
            offset: { kind: 'align' },
            output: LUMA_SIZE_OUTPUT,
            when: SUBSAMPLED_CONDITION,
            ...overrides
        });
    }

    function createLumaDoubler(): PassManifest {
        return createKernelPass({
            hook: 'LUMA',
            name: 'Luma doubler',
            offset: { kind: 'pixels', x: DOUBLER_OFFSET, y: DOUBLER_OFFSET },
            output: DOUBLED_OUTPUT
        });
    }

    function findPass(presentationPlan: PresentationPlan, label: string): PlannedPass {
        const pass = presentationPlan.passes.find((candidate: PlannedPass): boolean => candidate.label === label);
        if (pass === undefined) {
            throw new Error(`No pass '${label}'`);
        }
        return pass;
    }

    function getLabels(presentationPlan: PresentationPlan): string[] {
        return presentationPlan.passes.map((pass: PlannedPass): string => pass.label);
    }

    function toVector(x: number, y: number): string {
        return `vec2f(${x.toFixed(9)}, ${y.toFixed(9)})`;
    }

    it('reads chroma apart at its own size, merges the upscaled chroma with the source\'s luma, and converts as the signal does', () => {
        const presentationPlan = plan(createSDRChain(), [ createChromaUpscaler() ]);

        expect(presentationPlan.report.activePasses).toEqual([ 'Chroma upscaler' ]);
        expect(getLabels(presentationPlan)).toEqual([ CHROMA_LABEL, LUMA_LABEL, UPSCALER_LABEL, MERGE_LABEL, SCALE_LABEL ]);
        expect(presentationPlan.textures.map(texture => [ texture.id, texture.format, texture.width, texture.height ])).toEqual([
            [ 'plane:chroma', 'rg16float', CHROMA_WIDTH, CHROMA_HEIGHT ],
            [ 'pass:Chroma upscaler', 'rgba16float', SOURCE_WIDTH, SOURCE_HEIGHT ],
            [ 'plane:luma', 'r16float', SOURCE_WIDTH, SOURCE_HEIGHT ],
            [ 'merge', 'rgba16float', SOURCE_WIDTH, SOURCE_HEIGHT ]
        ]);
        const chromaPass = findPass(presentationPlan, CHROMA_LABEL);
        expect(chromaPass.inputTextureId).toBeNull();
        expect(chromaPass.coordinateMapping).toBe('identity');
        expect(chromaPass.code).toContain('let color = vec4f(readSignalChroma(textureCoordinate) / getSignalCodeScale(), 0.0, 1.0);');
        const mergePass = findPass(presentationPlan, MERGE_LABEL);
        expect(mergePass.inputTextureId).toBeNull();
        expect(getTextureBindings(mergePass).map(binding => binding.textureId)).toEqual([ 'pass:Chroma upscaler' ]);
        expect(mergePass.code).toContain('let luma = readSignalLuma(sourceCoordinate);');
        expect(mergePass.code).toContain(`let chroma = planeChroma_tex(referenceCoordinate + ${ZERO_VECTOR}).xy * scale;`);
        expect(mergePass.code).toContain('return convertSignalCodes(codes);');
        expect(mergePass.code).toContain('let color = mergeSignalPlanes(textureCoordinate, input.textureCoordinate);');
        expect(getStepCalls(findPass(presentationPlan, SCALE_LABEL))).toEqual(SDR_STEP_ENTRY_POINTS);
    });

    it('gives each input its texture\'s offset, the hooked chroma its siting, and an aligned output the reference grid\'s', () => {
        const presentationPlan = plan(createSDRChain(), [ createChromaUpscaler() ]);
        const upscalerCode = findPass(presentationPlan, UPSCALER_LABEL).code;

        expect(upscalerCode).toContain(`fn HOOKED_offset() -> vec2f {\n    return ${toVector(LEFT_SITED_CHROMA_OFFSET, 0)};\n}`);
        expect(upscalerCode).toContain(`fn LUMA_offset() -> vec2f {\n    return ${ZERO_VECTOR};\n}`);
        expect(findPass(presentationPlan, MERGE_LABEL).code).toContain(`fn planeChroma_offset() -> vec2f {\n    return ${ZERO_VECTOR};\n}`);
    });

    it('resamples unaligned chroma onto luma\'s grid through its offset, scaled to its new pixels', () => {
        const presentationPlan = plan(createSDRChain(), [ createChromaUpscaler({ offset: null }) ]);
        const scaledOffset = LEFT_SITED_CHROMA_OFFSET * (SOURCE_WIDTH / CHROMA_WIDTH);

        expect(findPass(presentationPlan, MERGE_LABEL).code).toContain(
            `let chroma = planeChroma_tex(referenceCoordinate + ${toVector(scaledOffset / SOURCE_WIDTH, 0)}).xy * scale;`
        );
    });

    it('sizes plan-time expressions from the chroma plane, which is the source\'s size where a route derives its planes from RGB', () => {
        expect(plan(createSDRChain(), [ createChromaUpscaler() ]).report.activePasses).toEqual([ 'Chroma upscaler' ]);
        expect(plan(createExternalChain(), [ createChromaUpscaler() ]).report.inactivePasses).toEqual([
            { detail: '', name: 'Chroma upscaler', reason: 'condition-false' }
        ]);
    });

    it('runs a luma pass on the derived luma of a route without decoded planes, and reads chroma from the signal', () => {
        const presentationPlan = plan(createExternalChain(), [ createKernelPass({ hook: 'LUMA', name: 'Luma' }) ]);
        const mergeCode = findPass(presentationPlan, MERGE_LABEL).code;

        expect(presentationPlan.report.activePasses).toEqual([ 'Luma' ]);
        expect(mergeCode).toContain('let chroma = readSignalSitedChroma(referenceSourceCoordinate);');
        expect(mergeCode).toContain('let luma = planeLuma_tex(imageCoordinate).x * scale;');
        expect(mergeCode).toContain(`dot(${SIGNAL_ENTRY_POINT}(coordinate).rgb, DERIVED_PLANE_LUMA_WEIGHTS)`);
    });

    it('merges onto a resized luma\'s grid, and the scaler corrects the image\'s offset', () => {
        const presentationPlan = plan(createSDRChain(), [ createLumaDoubler() ]);
        const doubledWidth = SOURCE_WIDTH * DOUBLING_FACTOR;
        const doubledHeight = SOURCE_HEIGHT * DOUBLING_FACTOR;
        const shift = toVector(DOUBLER_OFFSET / doubledWidth, DOUBLER_OFFSET / doubledHeight);
        const mergeCode = findPass(presentationPlan, MERGE_LABEL).code;

        expect(getLabels(presentationPlan)).toEqual([ LUMA_LABEL, 'Presentation pass \'Luma doubler\'', MERGE_LABEL, SCALE_LABEL ]);
        expect(presentationPlan.textures.find(texture => texture.id === 'merge')).toMatchObject({ height: doubledHeight, width: doubledWidth });
        expect(mergeCode).toContain(`let referenceSourceCoordinate = sourceCoordinate - ${shift} * presentation.textureScale;`);
        expect(mergeCode).toContain('let chroma = readSignalSitedChroma(referenceSourceCoordinate);');
        expect(findPass(presentationPlan, SCALE_LABEL).code).toContain(`var color = engineInput_tex((textureCoordinate + ${shift}));`);
    });

    it('carries the image\'s offset through an RGB pass to the scaler', () => {
        const presentationPlan = plan(createSDRChain(), [ createLumaDoubler(), createKernelPass({ domain: 'source', hook: 'RGB', name: 'Main' }) ]);
        const doubledWidth = SOURCE_WIDTH * DOUBLING_FACTOR;
        const doubledHeight = SOURCE_HEIGHT * DOUBLING_FACTOR;

        expect(findPass(presentationPlan, MAIN_LABEL).code).toContain(`fn HOOKED_offset() -> vec2f {\n    return ${toVector(DOUBLER_OFFSET, DOUBLER_OFFSET)};\n}`);
        expect(findPass(presentationPlan, SCALE_LABEL).code).toContain(
            `engineInput_tex((textureCoordinate + ${toVector(DOUBLER_OFFSET / doubledWidth, DOUBLER_OFFSET / doubledHeight)}))`
        );
    });

    it('reads a plane apart for a later pass that binds it, and keeps the signal\'s own conversion', () => {
        const presentationPlan = plan(createSDRChain(), [ createKernelPass({ hook: 'RGB', inputs: [ HOOKED_INPUT, LUMA_INPUT ], name: 'Main' }) ]);

        expect(getLabels(presentationPlan)).toEqual([ SIGNAL_LABEL, LUMA_LABEL, MAIN_LABEL, SCALE_LABEL ]);
        expect(getTextureBindings(findPass(presentationPlan, MAIN_LABEL)).map(binding => binding.textureId)).toEqual([ 'signal', 'plane:luma' ]);
    });

    it('merges into NATIVE for a NATIVE pass, and converts the image from what that pass leaves', () => {
        const presentationPlan = plan(createSDRChain(), [ createKernelPass({ hook: 'NATIVE', name: 'Native' }) ]);

        expect(getLabels(presentationPlan)).toEqual([ NATIVE_LABEL, 'Presentation pass \'Native\'', MERGE_LABEL, SCALE_LABEL ]);
        expect(findPass(presentationPlan, NATIVE_LABEL).code).toContain('return vec4f(codes / scale, 1.0);');
        expect(findPass(presentationPlan, MERGE_LABEL).code).toContain('let codes = planeNative_tex(imageCoordinate).xyz * scale;');
    });

    it('takes 32-bit float planes for codes deeper than 10 bits', () => {
        const chain = createBuiltinChain({
            format: 'I420P12',
            hdrOutput: false,
            metadata: createPQColorMetadata({ bitDepth: DEEP_BIT_DEPTH }),
            route: 'raw-yuv',
            settings: createHDRToSDRRenderSettings()
        });
        const presentationPlan = plan(chain, [ createChromaUpscaler() ]);

        expect(presentationPlan.textures.find(texture => texture.id === 'plane:chroma')?.format).toBe('rg32float');
        expect(presentationPlan.textures.find(texture => texture.id === 'plane:luma')?.format).toBe('r32float');
    });

    it('leaves plane passes out on a Dolby Vision route, with the passes that read a plane stage', () => {
        const chain = createBuiltinChain({
            felReconstruction: false,
            format: HDR_FORMAT,
            hdrOutput: false,
            profile: 8,
            route: 'raw-dolby-vision',
            settings: createHDRToSDRRenderSettings()
        });
        const reader = createKernelPass({ hook: 'RGB', inputs: [ HOOKED_INPUT, CHROMA_INPUT ], name: 'Reader' });
        const presentationPlan = plan(chain, [ createChromaUpscaler({ when: null }), reader ]);

        expect(presentationPlan.report.inactivePasses).toEqual([
            { detail: chain.signal.name, name: 'Chroma upscaler', reason: 'planes-unavailable' },
            { detail: chain.signal.name, name: 'Reader', reason: 'planes-unavailable' }
        ]);
        expect(presentationPlan.passes).toHaveLength(1);
    });

    it('leaves plane passes out of a deinterlacing plan, whose deinterlacer reads the signal\'s RGB', () => {
        const presentationPlan = planPresentation({
            chain: createSDRChain(),
            deinterlace: { bitDepth: 8, frameHeight: SOURCE_HEIGHT, frameWidth: SOURCE_WIDTH },
            device: { features: new Set<string>(), maximumTextureDimension: MAXIMUM_TEXTURE_DIMENSION },
            facts: createFacts(),
            output: SDR_OUTPUT,
            passes: [ createChromaUpscaler() ]
        });

        expect(presentationPlan.report.inactivePasses).toEqual([ { detail: 'deinterlacing', name: 'Chroma upscaler', reason: 'planes-unavailable' } ]);
    });

    it('rejects a plane pass whose domain is a color state, since planes come before the color track', () => {
        const presentationPlan = plan(createSDRChain(), [ createChromaUpscaler({ domain: 'source' }) ]);

        expect(presentationPlan.report.inactivePasses).toEqual([ { detail: 'source at CHROMA', name: 'Chroma upscaler', reason: 'domain-unreachable' } ]);
        expect(presentationPlan.passes).toHaveLength(1);
    });

    it('rejects reading CHROMA from a LUMA pass, which runs before it', () => {
        const presentationPlan = plan(createSDRChain(), [ createKernelPass({ hook: 'LUMA', inputs: [ HOOKED_INPUT, CHROMA_INPUT ], name: 'Luma' }) ]);

        expect(presentationPlan.report.inactivePasses).toEqual([ { detail: 'CHROMA at LUMA', name: 'Luma', reason: 'input-after-hook' } ]);
    });
});
