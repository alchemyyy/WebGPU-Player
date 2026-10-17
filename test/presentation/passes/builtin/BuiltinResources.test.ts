import { describe, expect, it } from 'vitest';

import {
    createHLGColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata
} from 'webgpu-player/color/ColorMetadata';
import { createBuiltinChain } from 'webgpu-player/presentation/passes/builtin/BuiltinChains';
import {
    createEngineBindingWGSL,
    createEngineStructsWGSL,
    expandEngineResource
} from 'webgpu-player/presentation/passes/PassResources';
import type {
    BuiltinChain,
    BuiltinChainConfiguration,
    EngineBindingResource,
    EngineResource,
    RawDolbyVisionFrameFormat
} from 'webgpu-player/presentation/passes/PassTypes';
import type { DolbyVisionReconstructionProfile } from 'webgpu-player/presentation/PresentationInput';
import {
    createDefaultRenderSettings,
    createHDRToSDRRenderSettings
} from 'webgpu-player/presentation/RenderSettings';
import type { SupportedRawVideoFrameFormat } from 'webgpu-player/decode/video/RawVideoFrameCopy';

const ENGINE_RESOURCES: readonly EngineResource[] = [
    'dolby-vision-enhancement',
    'dolby-vision-rpu',
    'external-texture',
    'frame-pool',
    'planes-nv12',
    'planes-yuv',
    'render-settings',
    'sampler-linear'
];
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
const DOLBY_VISION_PROFILES: readonly DolbyVisionReconstructionProfile[] = [ 4, 5, 7, 8 ];
const OUTPUT_KINDS: readonly boolean[] = [ false, true ];

// Identifiers, each with the parenthesis that makes it a call when one follows
const IDENTIFIER_TOKEN_PATTERN = /\w+\(?/g;

type EngineVariable = {
    /** The member names of the variable's struct, empty for textures and samplers. */
    fields: ReadonlySet<string>
    name: string
    /** The resource groups whose bindings declare the variable. */
    resources: ReadonlySet<EngineResource>
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

/** Returns the member names of a struct that an engine binding's declarations define, or none when the type is not a struct. */
function getStructFields(binding: EngineBindingResource, typeName: string): Set<string> {
    const fields = new Set<string>();
    const structs = createEngineStructsWGSL([ binding ]);
    const structStart = structs.indexOf(`struct ${typeName} {`);
    if (structStart < 0) {
        return fields;
    }
    const structBody = structs.slice(structs.indexOf('{', structStart) + 1, structs.indexOf('}', structStart));
    for (const line of structBody.split('\n')) {
        const separatorIndex = line.indexOf(':');
        if (separatorIndex > 0) {
            fields.add(line.slice(0, separatorIndex).trim());
        }
    }
    return fields;
}

/** Returns a binding declaration's variable name and type, such as `renderSettings` and `RenderSettingsUniforms`. */
function parseBindingDeclaration(declaration: string): { name: string; typeName: string } {
    const separatorIndex = declaration.indexOf(':');
    const beforeSeparator = declaration.slice(0, separatorIndex);
    return {
        name: beforeSeparator.slice(beforeSeparator.lastIndexOf(' ') + 1),
        typeName: declaration.slice(separatorIndex + 1, declaration.indexOf(';')).trim()
    };
}

/** Reads every engine binding's WGSL variable from PassResources, with the resource groups that declare it. */
function getEngineVariables(): Map<string, EngineVariable> {
    const variables = new Map<string, { fields: Set<string>; name: string; resources: Set<EngineResource> }>();
    for (const resource of ENGINE_RESOURCES) {
        for (const binding of expandEngineResource(resource)) {
            const declaration = parseBindingDeclaration(createEngineBindingWGSL(binding, 0));
            const variable = variables.get(declaration.name) ?? {
                fields: getStructFields(binding, declaration.typeName),
                name: declaration.name,
                resources: new Set<EngineResource>()
            };
            variable.resources.add(resource);
            variables.set(variable.name, variable);
        }
    }
    return variables;
}

function getCalledFunctions(code: string): string[] {
    const calledFunctions: string[] = [];
    for (const match of code.matchAll(IDENTIFIER_TOKEN_PATTERN)) {
        if (match[0].endsWith('(')) {
            calledFunctions.push(match[0].slice(0, -1));
        }
    }
    return calledFunctions;
}

const ENGINE_VARIABLES = getEngineVariables();

function getReferencedVariables(code: string): EngineVariable[] {
    return [ ...ENGINE_VARIABLES.values() ].filter((variable: EngineVariable): boolean =>
        new RegExp(String.raw`\b${variable.name}\b`).test(code)
    );
}

/** Expects code to read engine bindings only through the variables its resources declare, and to need every resource it lists. */
function expectResourcesMatchCode(code: string, resources: readonly EngineResource[]): void {
    const referencedVariables = getReferencedVariables(code);
    for (const variable of referencedVariables) {
        expect(resources.some((resource: EngineResource): boolean => variable.resources.has(resource)), variable.name).toBe(true);
        for (const fieldMatch of code.matchAll(new RegExp(String.raw`\b${variable.name}\.(\w+)`, 'g'))) {
            expect(variable.fields.has(fieldMatch[1]), `${variable.name}.${fieldMatch[1]}`).toBe(true);
        }
    }
    for (const resource of resources) {
        expect(referencedVariables.some((variable: EngineVariable): boolean => variable.resources.has(resource)), resource).toBe(true);
    }
    // The planner owns every binding and struct declaration, and built-in code needs neither the pass globals nor parameters
    expect(code).not.toMatch(/@group|@binding|^var|^struct /m);
    expect(code).not.toMatch(/\b(presentation|parameters)\./);
}

function createChains(): { chain: BuiltinChain; label: string }[] {
    const settings = createHDRToSDRRenderSettings();
    const configurations: BuiltinChainConfiguration[] = [
        { metadata: null, route: 'external-identity' },
        { chromaSubsampling: '4:2:0', metadata: createSDRColorMetadata(), route: 'external-identity' }
    ];
    for (const hdrOutput of OUTPUT_KINDS) {
        configurations.push(
            { hdrOutput, metadata: createPQColorMetadata(), route: 'external-hdr', settings },
            { hdrOutput, metadata: createHLGColorMetadata(), route: 'external-hdr', settings },
            { hdrOutput, route: 'external-dolby-vision', settings }
        );
        for (const format of RAW_YUV_FORMATS) {
            const bitDepth = getBitDepth(format);
            configurations.push(
                { format, hdrOutput, metadata: createSDRColorMetadata({ bitDepth }), route: 'raw-yuv', settings: createDefaultRenderSettings() },
                { format, hdrOutput, metadata: createSDRColorMetadata({ bitDepth, range: 'full' }), route: 'raw-yuv', settings },
                { format, hdrOutput, metadata: createPQColorMetadata({ bitDepth }), route: 'raw-yuv', settings },
                { format, hdrOutput, metadata: createHLGColorMetadata({ bitDepth }), route: 'raw-yuv', settings }
            );
        }
        for (const format of RAW_DOLBY_VISION_FORMATS) {
            for (const profile of DOLBY_VISION_PROFILES) {
                configurations.push(
                    { felReconstruction: false, format, hdrOutput, profile, route: 'raw-dolby-vision', settings },
                    { felReconstruction: true, format, hdrOutput, profile, route: 'raw-dolby-vision', settings }
                );
            }
        }
    }
    return configurations.map((configuration: BuiltinChainConfiguration) => {
        const chain = createBuiltinChain(configuration);
        const metadataLabel = 'metadata' in configuration && configuration.metadata !== null ?
            ` with ${configuration.metadata.range}-range ${configuration.metadata.transfer} metadata` :
            '';
        const outputLabel = 'hdrOutput' in configuration && configuration.hdrOutput ? 'HDR output' : 'SDR output';
        const settingsLabel = chain.sourceIsDisplay ? 'identity' : 'tone mapped';
        return { chain, label: `${chain.signal.name}${metadataLabel}, ${settingsLabel}, for ${outputLabel}` };
    });
}

describe('built-in engine binding names', () => {
    it('reads PassResources variables for every engine binding', () => {
        expect([ ...ENGINE_VARIABLES.keys() ].sort((first: string, second: string): number => first.localeCompare(second))).toEqual([
            'chromaTexture',
            'chromaUTexture',
            'chromaVTexture',
            'dolbyVisionRPU',
            'enhancement',
            'enhancementChromaUTexture',
            'enhancementChromaVTexture',
            'enhancementLumaTexture',
            'framePool',
            'framePoolLayout',
            'lumaTexture',
            'renderSettings',
            'videoSampler',
            'videoTexture'
        ]);
    });

    it.each(createChains())('match the resources of $label', ({ chain }) => {
        expectResourcesMatchCode(chain.signal.code, chain.signal.resources);
        for (const colorFunction of chain.colorFunctions) {
            expectResourcesMatchCode(colorFunction.code, colorFunction.resources);
        }

        const bypassCondition = chain.signal.bypassCondition;
        if (bypassCondition !== null) {
            // A bypass condition is evaluated beside the signal, so it may read only the signal's resources and functions
            expect(getReferencedVariables(bypassCondition).every((variable: EngineVariable): boolean =>
                chain.signal.resources.some((resource: EngineResource): boolean => variable.resources.has(resource))
            )).toBe(true);
            for (const calledFunction of getCalledFunctions(bypassCondition)) {
                expect(chain.signal.code).toContain(`fn ${calledFunction}(`);
            }
        }
    });
});
