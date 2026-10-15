// Fake commands and a real store for panel tests: every command is a mock that succeeds.
import { vi } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';

import {
    createInitialSandboxState,
    type SandboxLibraryCommands,
    type SandboxSessionCommands,
    type SandboxState
} from '../../../sandbox/src/contracts/SandboxContracts';
import type { PanelContext } from '../../../sandbox/src/ui/Panel';
import { createStore } from '../../../sandbox/src/ui/Store';

const START_TIME = 0 as Microseconds;

export function createFakeSession(): SandboxSessionCommands {
    return {
        addDecoderPackages: vi.fn((): Promise<void> => Promise.resolve()),
        addExampleShaderPass: vi.fn((): Promise<void> => Promise.resolve()),
        addShaderFiles: vi.fn((): Promise<void> => Promise.resolve()),
        getCurrentTimeMicroseconds: vi.fn((): Microseconds => START_TIME),
        getExampleShaderPasses: vi.fn((): [] => []),
        moveShaderFile: vi.fn((): Promise<void> => Promise.resolve()),
        openMedia: vi.fn((): Promise<void> => Promise.resolve()),
        pause: vi.fn(),
        play: vi.fn((): Promise<void> => Promise.resolve()),
        removeDecoderPackage: vi.fn((): Promise<void> => Promise.resolve()),
        removeShaderFile: vi.fn((): Promise<void> => Promise.resolve()),
        seek: vi.fn(),
        selectAudioTrack: vi.fn((): Promise<void> => Promise.resolve()),
        selectSubtitle: vi.fn((): Promise<void> => Promise.resolve()),
        setHDROutputEnabled: vi.fn((): Promise<void> => Promise.resolve()),
        setMuted: vi.fn(),
        setRenderSettings: vi.fn(),
        setRouteOverride: vi.fn((): Promise<void> => Promise.resolve()),
        setShaderParameter: vi.fn(),
        setVolume: vi.fn(),
        verifyDecoderPackage: vi.fn((): Promise<void> => Promise.resolve())
    };
}

export function createFakeLibrary(): SandboxLibraryCommands {
    return {
        pickDirectory: vi.fn((): Promise<void> => Promise.resolve()),
        resolveMedia: vi.fn((path: string) => Promise.resolve({ file: new File([], path), path, subtitleFiles: [] })),
        restore: vi.fn((): Promise<void> => Promise.resolve())
    };
}

/** A panel context with fake commands over a store in the initial state. */
export function createFakePanelContext(): PanelContext {
    return {
        library: createFakeLibrary(),
        session: createFakeSession(),
        store: createStore<SandboxState>(createInitialSandboxState())
    };
}
