// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    AUDIO_OUTPUT_STAGE_WASM_ASSET,
    configureEngineAssets,
    ENGINE_LIBRARY_PATHS,
    ENGINE_WORKER_PATHS,
    resolveEngineAssetURL,
    type EngineLibraryPath,
    type EngineWorkerPath
} from 'webgpu-player/EngineAssets';
import { HEVC_RANGE_EXTENSION_VARIANTS } from 'webgpu-player/capability/HEVCRangeExtensionCapabilities';

import { loadLibraryAssets } from './helpers/libraryAssets';

const PAGE_URL = 'https://example.test/web/index.html';
const ASSET_BASE_URL = 'https://example.test/web/libraries/';
const CACHE_KEY = 'build-1';
const RPU_PARSER_ASSET = 'libdovi/dovi-rpu-parser.wasm' satisfies EngineLibraryPath;
// The output stage is the engine's own code, so its folder carries the engine's license
const AUDIO_OUTPUT_STAGE_LICENSE_ASSET = 'audio-output-stage/LICENSE.txt';
const ENGINE_LICENSE_FILE_NAME = 'LICENSE';
// A host hands the engine its decoder packages, so the engine serves none
const DECODER_PACKAGE_EXTENSION = '.wasm';
const ENGINE_WASM_ASSETS: readonly string[] = [ AUDIO_OUTPUT_STAGE_WASM_ASSET, RPU_PARSER_ASSET ];

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
        const copiedDestinations = new Set<string>(getLibraryAssets().map(([ destination ]) => destination));
        const missingPaths = ENGINE_LIBRARY_PATHS.filter(path => !copiedDestinations.has(path));
        expect(missingPaths).toEqual([]);
    });

    it('covers every HEVC range-extension qualification stream', () => {
        for (const variant of HEVC_RANGE_EXTENSION_VARIANTS) {
            expect(ENGINE_LIBRARY_PATHS).toContain(`webgpu-player/hevc-rext/${variant}.bin`);
        }
    });

    it('serves only its own WebAssembly modules and no decoder package', async () => {
        const { getLibraryAssets } = await loadLibraryAssets();
        const servedModules = getLibraryAssets()
            .map(([ destination ]) => destination)
            .filter((destination: string): boolean => destination.endsWith(DECODER_PACKAGE_EXTENSION));
        expect(new Set(servedModules)).toEqual(new Set(ENGINE_WASM_ASSETS));
    });

    it('serves the audio output stage binary with the engine license beside it', async () => {
        const { getLibraryAssets } = await loadLibraryAssets();
        const assets = getLibraryAssets();
        expect(assets.filter(([ destination ]) => destination === AUDIO_OUTPUT_STAGE_WASM_ASSET)).toHaveLength(1);
        const license = assets.find(([ destination ]) => destination === AUDIO_OUTPUT_STAGE_LICENSE_ASSET);
        expect(license?.[1]).toMatch(new RegExp(`[\\\\/]${ENGINE_LICENSE_FILE_NAME}$`, 'u'));
    });
});

describe('engine asset URLs', () => {
    it('returns the bare path without a location', () => {
        expect(resolveEngineAssetURL(RPU_PARSER_ASSET)).toBe(RPU_PARSER_ASSET);
    });

    it('resolves against libraries/ beside the page by default', () => {
        vi.stubGlobal('location', { href: 'https://example.test/web/index.html#!/details' });
        expect(resolveEngineAssetURL(RPU_PARSER_ASSET)).toBe(
            `https://example.test/web/libraries/${RPU_PARSER_ASSET}`
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
        expect(resolveEngineAssetURL(RPU_PARSER_ASSET)).toBe(
            `${ASSET_BASE_URL}${RPU_PARSER_ASSET}?v=${CACHE_KEY}`
        );
    });

    it('gives the page and every worker one URL per library', () => {
        for (const path of ENGINE_LIBRARY_PATHS) {
            vi.stubGlobal('location', { href: PAGE_URL });
            configureEngineAssets({ baseURL: ASSET_BASE_URL, cacheKey: CACHE_KEY });
            const pageURL = resolveEngineAssetURL(path);
            vi.unstubAllGlobals();

            expect(pageURL).toBe(`${ASSET_BASE_URL}${path}?v=${CACHE_KEY}`);
            for (const workerPath of ENGINE_WORKER_PATHS) {
                expect(resolveInWorker(workerPath, path)).toBe(pageURL);
                vi.unstubAllGlobals();
            }
        }
    });

    it('resolves the audio output stage beside the playback worker with the build\'s cache key', () => {
        expect(resolveInWorker('webgpu-player/CustomDecode.worker.js', AUDIO_OUTPUT_STAGE_WASM_ASSET)).toBe(
            `${ASSET_BASE_URL}${AUDIO_OUTPUT_STAGE_WASM_ASSET}?v=${CACHE_KEY}`
        );
    });
});
