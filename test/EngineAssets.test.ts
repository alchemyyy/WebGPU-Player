// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    configureEngineAssets,
    DTS_DECODER_WASM_ASSET,
    EAC3_DECODER_WASM_ASSET,
    ENGINE_LIBRARY_PATHS,
    ENGINE_WORKER_PATHS,
    resolveEngineAssetURL,
    TRUEHD_DECODER_WASM_ASSET,
    type EngineLibraryPath,
    type EngineWorkerPath
} from 'webgpu-player/EngineAssets';
import { HEVC_RANGE_EXTENSION_VARIANTS } from 'webgpu-player/capability/HEVCRangeExtensionCapabilities';

import { loadLibraryAssets } from './helpers/libraryAssets';

const PAGE_URL = 'https://example.test/web/index.html';
const ASSET_BASE_URL = 'https://example.test/web/libraries/';
const CACHE_KEY = 'build-1';
const AUDIO_DECODER_WASM_ASSETS = [ DTS_DECODER_WASM_ASSET, EAC3_DECODER_WASM_ASSET, TRUEHD_DECODER_WASM_ASSET ] as const;

/** Resolves a path as the worker at the given asset path would, from its own URL. */
function resolveInWorker(workerPath: EngineWorkerPath, path: EngineLibraryPath): string {
    vi.stubGlobal('location', { href: `${ASSET_BASE_URL}${workerPath}?v=${CACHE_KEY}` });
    vi.stubGlobal('importScripts', () => undefined);
    return resolveEngineAssetURL(path);
}

afterEach(() => {
    configureEngineAssets({});
    vi.unstubAllGlobals();
});

describe('engine asset manifest', () => {
    it('names exactly the workers the build bundles', async () => {
        const { getWorkerEntryPoints } = await loadLibraryAssets();
        const bundledWorkers = getWorkerEntryPoints().map(([ destination ]) => destination);
        expect(bundledWorkers).toHaveLength(ENGINE_WORKER_PATHS.length);
        expect(new Set(bundledWorkers)).toEqual(new Set(ENGINE_WORKER_PATHS));
    });

    it('names only libraries the build copies', async () => {
        const { getLibraryAssets } = await loadLibraryAssets();
        const copiedDestinations = new Set(getLibraryAssets().map(([ destination ]) => destination));
        const missingPaths = ENGINE_LIBRARY_PATHS.filter(path => !copiedDestinations.has(path));
        expect(missingPaths).toEqual([]);
    });

    it('covers every HEVC range-extension qualification stream', () => {
        for (const variant of HEVC_RANGE_EXTENSION_VARIANTS) {
            expect(ENGINE_LIBRARY_PATHS).toContain(`webgpu-player/hevc-rext/${variant}.bin`);
        }
    });

    it('serves each audio decoder binary as its own file', async () => {
        const { getLibraryAssets } = await loadLibraryAssets();
        const copiedDestinations = getLibraryAssets().map(([ destination ]) => destination);
        for (const path of AUDIO_DECODER_WASM_ASSETS) {
            expect(copiedDestinations.filter(destination => destination === path)).toHaveLength(1);
        }
    });
});

describe('engine asset URLs', () => {
    it('returns the bare path without a location', () => {
        expect(resolveEngineAssetURL('hevcjs/hevc-decode.js')).toBe('hevcjs/hevc-decode.js');
    });

    it('resolves against libraries/ beside the page by default', () => {
        vi.stubGlobal('location', { href: 'https://example.test/web/index.html#!/details' });
        expect(resolveEngineAssetURL('libdovi/dovi-rpu-parser.wasm')).toBe(
            'https://example.test/web/libraries/libdovi/dovi-rpu-parser.wasm'
        );
    });

    it('applies the configured base and cache key', () => {
        vi.stubGlobal('location', { href: 'https://example.test/web/index.html' });
        configureEngineAssets({ baseURL: 'https://cdn.example.test/engine', cacheKey: 'build-1' });
        expect(resolveEngineAssetURL('webgpu-player/CustomDecode.worker.js')).toBe(
            'https://cdn.example.test/engine/webgpu-player/CustomDecode.worker.js?v=build-1'
        );
    });

    it('resolves inside a worker from the worker URL and its cache key', () => {
        vi.stubGlobal('location', {
            href: 'https://example.test/web/libraries/webgpu-player/CustomDecode.worker.js?v=build-1'
        });
        vi.stubGlobal('importScripts', () => undefined);
        configureEngineAssets({ baseURL: 'https://ignored.example.test/', cacheKey: 'ignored' });
        expect(resolveEngineAssetURL('hevcjs/hevc-decode.wasm')).toBe(
            'https://example.test/web/libraries/hevcjs/hevc-decode.wasm?v=build-1'
        );
    });

    it('gives the page, the probe workers, and the playback worker one URL per audio decoder binary', () => {
        for (const path of AUDIO_DECODER_WASM_ASSETS) {
            vi.stubGlobal('location', { href: PAGE_URL });
            configureEngineAssets({ baseURL: ASSET_BASE_URL, cacheKey: CACHE_KEY });
            const pageURL = resolveEngineAssetURL(path);
            vi.unstubAllGlobals();

            expect(pageURL).toBe(`${ASSET_BASE_URL}${path}?v=${CACHE_KEY}`);
            expect(resolveInWorker('webgpu-player/DTSExactCapabilityProbe.worker.js', path)).toBe(pageURL);
            expect(resolveInWorker('webgpu-player/TrueHDExactCapabilityProbe.worker.js', path)).toBe(pageURL);
            expect(resolveInWorker('webgpu-player/CustomDecode.worker.js', path)).toBe(pageURL);
            vi.unstubAllGlobals();
        }
    });
});
