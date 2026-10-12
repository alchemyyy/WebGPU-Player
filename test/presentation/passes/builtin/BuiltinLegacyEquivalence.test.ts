import { describe, expect, it } from 'vitest';

import {
    createHLGColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata,
    type ColorPrimaries,
    type ColorRange,
    type ColorTransfer,
    type InputColorMetadata,
    type YUVMatrix
} from 'webgpu-player/color/ColorMetadata';
import {
    createExternalDolbyVisionColorPipelineWGSL,
    createExternalHDRColorPipelineWGSL,
    createRawDolbyVisionColorPipelineWGSL,
    createRawDolbyVisionProfile4ColorPipelineWGSL,
    createRawDolbyVisionProfile4FELColorPipelineWGSL,
    createRawDolbyVisionProfile7ColorPipelineWGSL,
    createRawDolbyVisionProfile7FELColorPipelineWGSL,
    createRawYUVColorPipelineWGSL
} from 'webgpu-player/color/ColorPipelineShader';
import {
    createDolbyVisionColorFunctionsWGSL,
    createDolbyVisionColorTransformWGSL
} from 'webgpu-player/color/DolbyVisionColorTransform';
import identityShader from 'webgpu-player/presentation/identity.wgsl';
import { createBuiltinChain } from 'webgpu-player/presentation/passes/builtin/BuiltinChains';
import type {
    BuiltinChain,
    RawDolbyVisionFrameFormat
} from 'webgpu-player/presentation/passes/PassTypes';
import type { DolbyVisionReconstructionProfile } from 'webgpu-player/presentation/PresentationInput';
import {
    createDefaultRenderSettings,
    createHDRToSDRRenderSettings,
    type HDRToSDRRenderSettings,
    type RenderSettings,
    type ToneMapOperator
} from 'webgpu-player/presentation/RenderSettings';
import type { SupportedRawVideoFrameFormat } from 'webgpu-player/video/RawVideoFrameCopy';

const RAW_DOLBY_VISION_FORMATS: readonly RawDolbyVisionFrameFormat[] = [
    'I420',
    'I420P10',
    'I420P12',
    'I422',
    'I422P10',
    'I422P12',
    'I444',
    'I444P10',
    'I444P12'
];
const RAW_YUV_FORMATS: readonly SupportedRawVideoFrameFormat[] = [ ...RAW_DOLBY_VISION_FORMATS, 'NV12' ];
const TONE_MAP_OPERATORS: readonly ToneMapOperator[] = [ 'aces', 'reinhard', 'spline' ];
const TRANSFERS: readonly ColorTransfer[] = [ 'hlg', 'pq', 'sdr' ];
const RANGES: readonly ColorRange[] = [ 'full', 'limited' ];
const COLOR_DESCRIPTIONS: readonly { matrix: YUVMatrix; primaries: ColorPrimaries }[] = [
    { matrix: 'bt709', primaries: 'bt709' },
    { matrix: 'bt2020-ncl', primaries: 'bt2020' },
    { matrix: 'smpte170m', primaries: 'smpte170m' },
    { matrix: 'bt470bg', primaries: 'bt470bg' }
];
const DOLBY_VISION_PROFILES: readonly DolbyVisionReconstructionProfile[] = [ 4, 5, 7, 8 ];
const FEL_RECONSTRUCTION_FLAGS: readonly boolean[] = [ false, true ];
// An HLG nominal peak other than the 1000-nit reference, so the generated system gamma differs from 1.2
const HLG_NOMINAL_PEAK_NITS = 2_000;
const EXTERNAL_HDR_METADATA: readonly InputColorMetadata[] = [
    createPQColorMetadata(),
    createHLGColorMetadata(),
    createHLGColorMetadata({ nominalPeakNits: HLG_NOMINAL_PEAK_NITS })
];
const RPU_BINDINGS: readonly number[] = [ 0, 4, 5 ];

// The legacy functions the built-in chains replace: the fused shader's fragment entry point and its one color function
const LEGACY_ENTRY_POINT = 'fragmentMain';
const LEGACY_COLOR_PROCESSOR = 'processColor';

const FUNCTION_DEFINITION_PATTERN = /^fn (\w+)\(/gm;
// Identifiers, each with the parenthesis that makes it a call when one follows, and lone parentheses
const CALL_TOKEN_PATTERN = /\w+\(?|[()]/g;
const CALL_OPENING = '(';
const CALL_CLOSING = ')';

type ShaderAnalysis = {
    /** The calls of the entry points, in evaluation order. */
    callSequence: readonly string[]
    entryPoints: readonly string[]
    functions: ReadonlyMap<string, string>
    /** The functions the entry points call directly or indirectly, sorted. */
    reachable: readonly string[]
};

function getBitDepth(format: SupportedRawVideoFrameFormat): number {
    if (format.endsWith('P10')) {
        return 10;
    }
    if (format.endsWith('P12')) {
        return 12;
    }
    return 8;
}

/** Returns every module-scope WGSL function by name, from its signature to its closing brace; a repeated name fails. */
function getWGSLFunctions(shader: string): Map<string, string> {
    const functions = new Map<string, string>();
    for (const match of shader.matchAll(FUNCTION_DEFINITION_PATTERN)) {
        const functionStart = match.index;
        if (functions.has(match[1])) {
            throw new Error(`The shader defines ${match[1]} twice`);
        }
        functions.set(match[1], shader.slice(functionStart, shader.indexOf('\n}', functionStart) + 2));
    }
    return functions;
}

function getFunctionBody(functionText: string): string {
    return functionText.slice(functionText.indexOf('{'));
}

/** Returns the known functions a function body calls, in textual order with repeats. */
function getCalledFunctions(functionText: string, knownFunctions: ReadonlyMap<string, string>): string[] {
    const calledFunctions: string[] = [];
    for (const match of getFunctionBody(functionText).matchAll(CALL_TOKEN_PATTERN)) {
        const calledName = match[0].slice(0, -1);
        if (match[0].endsWith(CALL_OPENING) && knownFunctions.has(calledName)) {
            calledFunctions.push(calledName);
        }
    }
    return calledFunctions;
}

/** Returns the functions the entry points call directly or indirectly, without the entry points, sorted. */
function getReachableFunctions(functions: ReadonlyMap<string, string>, entryPoints: readonly string[]): string[] {
    const reachable = new Set<string>();
    const pending: string[] = [ ...entryPoints ];
    let current = pending.pop();
    while (current !== undefined) {
        for (const calledName of getCalledFunctions(functions.get(current) ?? '', functions)) {
            if (!reachable.has(calledName) && !entryPoints.includes(calledName)) {
                reachable.add(calledName);
                pending.push(calledName);
            }
        }
        current = pending.pop();
    }
    return [ ...reachable ].sort((first: string, second: string): number => first.localeCompare(second));
}

/** Returns the calls of known functions in a function body in evaluation order, each after the calls in its arguments. */
function getCallSequence(functionText: string, knownFunctions: ReadonlyMap<string, string>): string[] {
    const sequence: string[] = [];
    // One entry per open parenthesis: the known function it calls, or null for any other parenthesis
    const openParentheses: (string | null)[] = [];
    for (const match of getFunctionBody(functionText).matchAll(CALL_TOKEN_PATTERN)) {
        const token = match[0];
        if (token === CALL_CLOSING) {
            const closedCall = openParentheses.pop();
            if (closedCall) {
                sequence.push(closedCall);
            }
        } else if (token.endsWith(CALL_OPENING)) {
            const calledName = token.slice(0, -1);
            openParentheses.push(knownFunctions.has(calledName) ? calledName : null);
        }
    }
    return sequence;
}

const legacyAnalyses = new Map<string, ShaderAnalysis>();

/** Analyzes a fused legacy shader as one signal and color track, where processColor stands for the color functions. */
function analyzeLegacyShader(shader: string): ShaderAnalysis {
    const cachedAnalysis = legacyAnalyses.get(shader);
    if (cachedAnalysis) {
        return cachedAnalysis;
    }
    const functions = getWGSLFunctions(shader);
    const entryPoint = functions.get(LEGACY_ENTRY_POINT);
    if (!entryPoint) {
        throw new Error('The legacy shader has no fragment entry point');
    }
    const colorProcessor = functions.get(LEGACY_COLOR_PROCESSOR);
    const colorProcessorSequence = colorProcessor ? getCallSequence(colorProcessor, functions) : [];
    const analysis: ShaderAnalysis = {
        callSequence: getCallSequence(entryPoint, functions).flatMap((name: string): string[] =>
            name === LEGACY_COLOR_PROCESSOR ? colorProcessorSequence : [ name ]
        ),
        entryPoints: [ LEGACY_ENTRY_POINT ],
        functions,
        reachable: getReachableFunctions(functions, [ LEGACY_ENTRY_POINT ])
            .filter((name: string): boolean => name !== LEGACY_COLOR_PROCESSOR)
    };
    legacyAnalyses.set(shader, analysis);
    return analysis;
}

/** Analyzes a built-in chain as the planner fuses it: the signal, then each color function in chain order. */
function analyzeChain(chain: BuiltinChain): ShaderAnalysis {
    const entryPoints = [ chain.signal.entryPoint, ...chain.colorFunctions.map(colorFunction => colorFunction.entryPoint) ];
    const functions = getWGSLFunctions([ chain.signal.code, ...chain.colorFunctions.map(colorFunction => colorFunction.code) ].join('\n\n'));
    const callSequence = entryPoints.flatMap((entryPoint: string): string[] => {
        const entryFunction = functions.get(entryPoint);
        if (!entryFunction) {
            throw new Error(`The chain does not define its entry point ${entryPoint}`);
        }
        return getCallSequence(entryFunction, functions);
    });
    return { callSequence, entryPoints, functions, reachable: getReachableFunctions(functions, entryPoints) };
}

function expectLegacyEquivalence(chain: BuiltinChain, legacyShader: string): void {
    const legacy = analyzeLegacyShader(legacyShader);
    const builtin = analyzeChain(chain);

    // The chain runs exactly the legacy functions, each with its legacy text, and defines nothing else
    expect(builtin.reachable).toEqual(legacy.reachable);
    for (const name of builtin.reachable) {
        expect(builtin.functions.get(name), name).toBe(legacy.functions.get(name));
    }
    expect([ ...builtin.functions.keys() ].filter((name: string): boolean =>
        !builtin.reachable.includes(name) && !builtin.entryPoints.includes(name)
    )).toEqual([]);
    // The signal and the color function entry points call them in the legacy order
    expect(builtin.callSequence).toEqual(legacy.callSequence);
}

function createMetadata(
    transfer: ColorTransfer,
    overrides: Pick<InputColorMetadata, 'bitDepth' | 'matrix' | 'primaries' | 'range'>
): InputColorMetadata {
    switch (transfer) {
        case 'hlg':
            return createHLGColorMetadata({ ...overrides, nominalPeakNits: HLG_NOMINAL_PEAK_NITS });
        case 'pq':
            return createPQColorMetadata(overrides);
        case 'sdr':
            return createSDRColorMetadata(overrides);
    }
}

function createHDRSettingsVariants(): HDRToSDRRenderSettings[] {
    return TONE_MAP_OPERATORS.map((operator: ToneMapOperator): HDRToSDRRenderSettings =>
        createHDRToSDRRenderSettings({ toneMapping: { operator } })
    );
}

function createSettingsVariants(): RenderSettings[] {
    const settings: RenderSettings[] = [];
    settings.push(createDefaultRenderSettings(), ...createHDRSettingsVariants());
    return settings;
}

function getLegacyRawDolbyVisionShader(
    settings: HDRToSDRRenderSettings,
    format: RawDolbyVisionFrameFormat,
    profile: DolbyVisionReconstructionProfile,
    felReconstruction: boolean
): string {
    switch (profile) {
        case 4:
            return felReconstruction ?
                createRawDolbyVisionProfile4FELColorPipelineWGSL(settings, format) :
                createRawDolbyVisionProfile4ColorPipelineWGSL(settings, format);
        case 7:
            return felReconstruction ?
                createRawDolbyVisionProfile7FELColorPipelineWGSL(settings, format) :
                createRawDolbyVisionProfile7ColorPipelineWGSL(settings, format);
        case 5:
        case 8:
            return createRawDolbyVisionColorPipelineWGSL(settings, format);
    }
}

describe('the call sequence extraction', () => {
    it('orders nested calls by evaluation, arguments first', () => {
        const functions = getWGSLFunctions(`
fn inner(value: f32) -> f32 {
    return value;
}

fn outer(value: f32, other: f32) -> f32 {
    return value + other;
}

fn entry() -> f32 {
    return outer(inner(1.0), vec2f(inner(2.0)).x);
}`);

        expect(getCallSequence(functions.get('entry') ?? '', functions)).toEqual([ 'inner', 'inner', 'outer' ]);
    });
});

describe('the Dolby Vision RPU functions generator', () => {
    it.each(RPU_BINDINGS)('is the legacy generator at binding %i without its struct and binding', binding => {
        const legacyTransform = createDolbyVisionColorTransformWGSL(binding);
        const functionsOnly = createDolbyVisionColorFunctionsWGSL();

        expect(legacyTransform.endsWith(functionsOnly)).toBe(true);
        expect(functionsOnly).not.toContain('@binding');
        expect(functionsOnly).not.toContain('struct DolbyVisionRPUData');
        expect(legacyTransform.slice(0, legacyTransform.length - functionsOnly.length))
            .toContain(`@group(0) @binding(${binding}) var<storage, read> dolbyVisionRPU: DolbyVisionRPUData;`);
    });
});

describe('external chains match the legacy shaders', () => {
    it('presents the identity route as the identity shader does', () => {
        expectLegacyEquivalence(createBuiltinChain({ route: 'external-identity' }), identityShader);
    });

    describe.each(EXTERNAL_HDR_METADATA)('external HDR with $transfer metadata peaking at $nominalPeakNits nits', metadata => {
        it.each(createHDRSettingsVariants())('with the $toneMapping.operator operator', settings => {
            expectLegacyEquivalence(
                createBuiltinChain({ hdrOutput: false, metadata, route: 'external-hdr', settings }),
                createExternalHDRColorPipelineWGSL(metadata, settings)
            );
        });
    });

    it.each(createHDRSettingsVariants())('reconstructs external Dolby Vision with the $toneMapping.operator operator', settings => {
        expectLegacyEquivalence(
            createBuiltinChain({ hdrOutput: false, route: 'external-dolby-vision', settings }),
            createExternalDolbyVisionColorPipelineWGSL(settings)
        );
    });
});

describe.each(RAW_YUV_FORMATS)('raw YUV chains over %s planes match the legacy shader', format => {
    const metadataVariants: InputColorMetadata[] = [];
    for (const transfer of TRANSFERS) {
        for (const range of RANGES) {
            for (const colorDescription of COLOR_DESCRIPTIONS) {
                metadataVariants.push(createMetadata(transfer, { ...colorDescription, bitDepth: getBitDepth(format), range }));
            }
        }
    }

    it.each(metadataVariants)('for $transfer $range-range $matrix metadata in $primaries primaries', metadata => {
        for (const settings of createSettingsVariants()) {
            expectLegacyEquivalence(
                createBuiltinChain({ format, hdrOutput: false, metadata, route: 'raw-yuv', settings }),
                createRawYUVColorPipelineWGSL(metadata, settings, format)
            );
        }
    });
});

describe.each(RAW_DOLBY_VISION_FORMATS)('raw Dolby Vision chains over %s BL planes match the legacy shaders', format => {
    describe.each(DOLBY_VISION_PROFILES)('Profile %i', profile => {
        it.each(FEL_RECONSTRUCTION_FLAGS)('with FEL reconstruction %s', felReconstruction => {
            for (const settings of createHDRSettingsVariants()) {
                expectLegacyEquivalence(
                    createBuiltinChain({ felReconstruction, format, hdrOutput: false, profile, route: 'raw-dolby-vision', settings }),
                    getLegacyRawDolbyVisionShader(settings, format, profile, felReconstruction)
                );
            }
        });
    });
});
