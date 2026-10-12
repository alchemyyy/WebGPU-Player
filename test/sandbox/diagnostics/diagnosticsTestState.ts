// Builders of the plans, routes, telemetry, and panel contexts the diagnostics tests feed the panels and their helpers.
import { type Mock, vi } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';
import { parsePassManifest } from 'webgpu-player/presentation/passes/PassManifest';
import type {
    PlannedBinding,
    PlannedOutput,
    PlannedPass,
    PlannedTexture,
    PresentationPlan
} from 'webgpu-player/presentation/passes/PassTypes';
import { requireMicroseconds } from 'webgpu-player/TimeMath';

import {
    createInitialSandboxState,
    type ActiveRoute,
    type ExampleShaderPass,
    type SandboxLibraryCommands,
    type SandboxMediaFile,
    type SandboxSessionCommands,
    type SandboxShaderPass,
    type SandboxState
} from '../../../sandbox/src/contracts/SandboxContracts';
import type { PanelContext } from '../../../sandbox/src/ui/Panel';
import { createStore } from '../../../sandbox/src/ui/Store';

/** Session commands whose calls a test reads; the asynchronous ones resolve at once. */
export type TestSessionCommands = { [Command in keyof SandboxSessionCommands]: Mock<SandboxSessionCommands[Command]> };

export type TestPanelContext = PanelContext & Readonly<{
    session: TestSessionCommands
}>;

const TEST_CURRENT_TIME_MICROSECONDS = 0;

function resolveCommand(): Promise<void> {
    return Promise.resolve();
}

export function createTestSessionCommands(examples: readonly ExampleShaderPass[] = []): TestSessionCommands {
    return {
        addExampleShaderPass: vi.fn<SandboxSessionCommands['addExampleShaderPass']>(resolveCommand),
        addShaderPasses: vi.fn<SandboxSessionCommands['addShaderPasses']>(resolveCommand),
        getCurrentTimeMicroseconds: vi.fn<SandboxSessionCommands['getCurrentTimeMicroseconds']>(
            (): Microseconds => requireMicroseconds(TEST_CURRENT_TIME_MICROSECONDS)
        ),
        getExampleShaderPasses: vi.fn<SandboxSessionCommands['getExampleShaderPasses']>((): readonly ExampleShaderPass[] => examples),
        moveShaderPass: vi.fn<SandboxSessionCommands['moveShaderPass']>(resolveCommand),
        openMedia: vi.fn<SandboxSessionCommands['openMedia']>(resolveCommand),
        pause: vi.fn<SandboxSessionCommands['pause']>(),
        play: vi.fn<SandboxSessionCommands['play']>(resolveCommand),
        removeShaderPass: vi.fn<SandboxSessionCommands['removeShaderPass']>(resolveCommand),
        seek: vi.fn<SandboxSessionCommands['seek']>(),
        selectAudioTrack: vi.fn<SandboxSessionCommands['selectAudioTrack']>(resolveCommand),
        selectSubtitle: vi.fn<SandboxSessionCommands['selectSubtitle']>(resolveCommand),
        setHDROutputEnabled: vi.fn<SandboxSessionCommands['setHDROutputEnabled']>(resolveCommand),
        setMuted: vi.fn<SandboxSessionCommands['setMuted']>(),
        setRenderSettings: vi.fn<SandboxSessionCommands['setRenderSettings']>(),
        setRouteOverride: vi.fn<SandboxSessionCommands['setRouteOverride']>(resolveCommand),
        setShaderParameter: vi.fn<SandboxSessionCommands['setShaderParameter']>(),
        setVolume: vi.fn<SandboxSessionCommands['setVolume']>()
    };
}

function createTestLibraryCommands(): SandboxLibraryCommands {
    return {
        pickDirectory: vi.fn<SandboxLibraryCommands['pickDirectory']>(resolveCommand),
        resolveMedia: vi.fn<SandboxLibraryCommands['resolveMedia']>((): Promise<SandboxMediaFile> => Promise.reject(new Error('not-used: library'))),
        restore: vi.fn<SandboxLibraryCommands['restore']>(resolveCommand)
    };
}

/** A panel context over a store of the state, with session commands that record their calls. */
export function createTestPanelContext(
    state: SandboxState = createInitialSandboxState(),
    examples: readonly ExampleShaderPass[] = []
): TestPanelContext {
    return { library: createTestLibraryCommands(), session: createTestSessionCommands(examples), store: createStore<SandboxState>(state) };
}

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
        output: TEST_CANVAS_OUTPUT,
        parameterSets: [],
        report: { activePasses: [], inactivePasses: [] },
        sourceKind: 'planes',
        textures: [],
        usesRenderSettings: false,
        ...overrides
    };
}

/** A preset pass parsed from its source, as the session publishes one, with no stored parameter values. */
export function createTestShaderPass(id: string, source: string, overrides: Partial<SandboxShaderPass> = {}): SandboxShaderPass {
    return { headerFailure: null, id, manifest: parsePassManifest(source), origin: `${id}.wgsl`, parameters: {}, source, ...overrides };
}

export function createActiveRoute(overrides: Partial<ActiveRoute> = {}): ActiveRoute {
    return {
        audioOutputMode: 'decoded-pcm',
        dolbyVisionProfile: null,
        nativeHDRTransfer: null,
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat: null,
        selection: TEST_ROUTE_SELECTION,
        videoDecoderBackend: 'native',
        videoOutputMode: 'video-frame',
        ...overrides
    };
}
