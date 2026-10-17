// Builders of the plans, routes, and preset passes the diagnostics tests feed the panels and their helpers.
import { parsePassFile, type PassFileEntry } from 'webgpu-player/presentation/passes/PassManifest';
import type {
    PlannedBinding,
    PlannedOutput,
    PlannedPass,
    PlannedTexture,
    PresentationPlan
} from 'webgpu-player/presentation/passes/PassTypes';

import type { ActiveRoute, SandboxFilePass, SandboxShaderFile } from '../../../sandbox/src/contracts/SandboxContracts';

/** One sampled texture binding of a pass. */
export type TextureRead = Readonly<{
    historyOffset: number
    textureId: string
}>;

export const TEST_CANVAS_OUTPUT: PlannedOutput = { colorSpace: 'srgb', format: 'bgra8unorm', toneMapping: 'standard' };
export const TEST_ROUTE_SELECTION = 'eligible: native decoder';

/** Returns a render pass that writes the canvas and reads the source, with the overrides applied. */
export function createPlannedPass(overrides: Partial<PlannedPass> & Pick<PlannedPass, 'label'>): PlannedPass {
    return {
        bindings: [],
        code: '',
        colorSteps: [],
        coordinateMapping: 'identity',
        indirectBufferId: null,
        inputTextureId: null,
        kind: 'render',
        lineMap: [],
        target: { kind: 'output' },
        workgroupCounts: null,
        ...overrides
    };
}

/** Returns sampled bindings for the reads, numbered from the first binding. */
export function createSampledBindings(reads: readonly TextureRead[], firstBinding = 0): PlannedBinding[] {
    const bindings: PlannedBinding[] = [];
    for (const [ index, read ] of reads.entries()) {
        bindings.push({ access: 'sampled', binding: firstBinding + index, historyOffset: read.historyOffset, kind: 'texture', textureId: read.textureId });
    }
    return bindings;
}

export function createPlannedTexture(overrides: Partial<PlannedTexture> & Pick<PlannedTexture, 'height' | 'id' | 'width'>): PlannedTexture {
    return {
        format: 'rgba16float',
        historyDepth: 0,
        storage: false,
        ...overrides
    };
}

export function createPresentationPlan(overrides: Partial<PresentationPlan> & Pick<PresentationPlan, 'passes'>): PresentationPlan {
    return {
        buffers: [],
        deinterlace: null,
        output: TEST_CANVAS_OUTPUT,
        parameterSets: [],
        passTextures: [],
        report: { activePasses: [], inactivePasses: [] },
        sourceKind: 'planes',
        textures: [],
        usesRenderSettings: false,
        ...overrides
    };
}

/** A preset file parsed from its source, as the session publishes one, with no stored parameter values. */
export function createTestShaderFile(id: string, source: string, overrides: Partial<SandboxShaderFile> = {}): SandboxShaderFile {
    const passes = parsePassFile(source).map((entry: PassFileEntry): SandboxFilePass => ({
        headerFailure: entry.error === null ? null : `line ${entry.error.line}: ${entry.error.message}`,
        manifest: entry.manifest
    }));
    return { id, origin: `${id}.wgsl`, parameters: {}, passes, source, ...overrides };
}

export function createActiveRoute(overrides: Partial<ActiveRoute> = {}): ActiveRoute {
    return {
        audioOutputMode: 'decoded-pcm',
        dolbyVisionProfile: null,
        gpuVideoDecoder: null,
        nativeHDRTransfer: null,
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat: null,
        selection: TEST_ROUTE_SELECTION,
        videoDecoderBackend: 'native',
        videoOutputMode: 'video-frame',
        ...overrides
    };
}
