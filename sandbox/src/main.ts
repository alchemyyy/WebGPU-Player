// The sandbox: the engine's player on a full-window surface, with overlay panels for testing it against local media.
import { configureEngineAssets } from 'webgpu-player/EngineAssets';
import { configureEngineFeatureFlags } from 'webgpu-player/EngineConfiguration';

import LAYOUT from '../../tools/constants.json';
import { createInitialSandboxState, type SandboxState } from './contracts/SandboxContracts';
import { createMediaLibrary } from './library/MediaLibrary';
import { createSandboxSession } from './session/SandboxSession';
import { mountSandboxApp } from './ui/App';
import { requireElement } from './ui/dom';
import { createStore } from './ui/Store';

// The presenter's canvas styles, which every host imports
import 'webgpu-player/style.css';
import './ui/theme.css';

// The dev server serves the engine's output folder at its root, so the build info sits at its path below that folder
const BUILD_INFO_URL = `/${LAYOUT.buildInfoFile.slice(LAYOUT.outputDirectory.length + 1)}`;
const SURFACE_SELECTOR = '#sandbox-surface';
const OVERLAY_SELECTOR = '#sandbox-overlay';

type BuildInfo = Readonly<{ assetKey: string }>;

/** Reads the asset build's cache key, which every engine asset URL carries. */
async function readAssetKey(): Promise<string> {
    const response = await fetch(BUILD_INFO_URL);
    if (!response.ok) {
        throw new Error(`build-info: HTTP ${response.status} for ${BUILD_INFO_URL}; run node scripts/build.mjs`);
    }
    const buildInfo = await response.json() as BuildInfo;
    return buildInfo.assetKey;
}

async function startSandbox(): Promise<void> {
    configureEngineAssets({ cacheKey: await readAssetKey() });
    configureEngineFeatureFlags({ isHDRToneMappingEnabled: () => Promise.resolve(true) });
    const store = createStore<SandboxState>(createInitialSandboxState());
    const session = createSandboxSession({ store, surfaceContainer: requireElement<HTMLDivElement>(document, SURFACE_SELECTOR) });
    const library = createMediaLibrary(store);
    mountSandboxApp({ library, overlay: requireElement<HTMLElement>(document, OVERLAY_SELECTOR), session, store });
    await library.restore(false);
}

void startSandbox();
