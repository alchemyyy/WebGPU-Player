// @vitest-environment node

import { basename } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    AUDIO_OUTPUT_STAGE_WASM_ASSET,
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
// The output stage is the engine's own code, so its folder carries the engine's license
const AUDIO_OUTPUT_STAGE_LICENSE_ASSET = 'audio-output-stage/LICENSE.txt';
const ENGINE_LICENSE_FILE_NAME = 'LICENSE';
const HEVC_DECODER_GLUE_ASSET = 'ffmpeg-hevc/ffmpeg-hevc.js' satisfies EngineLibraryPath;
const HEVC_DECODER_WASM_ASSET = 'ffmpeg-hevc/ffmpeg-hevc.wasm' satisfies EngineLibraryPath;
// The HEVC decoder is FFmpeg under the LGPL, so its folder carries FFmpeg's license, and the bridge's source under the engine's license
const HEVC_DECODER_FFMPEG_LICENSE_ASSET = 'ffmpeg-hevc/LICENSE.ffmpeg.txt';
const HEVC_DECODER_BRIDGE_SOURCE_ASSET = 'ffmpeg-hevc/ffmpeg_hevc_bridge.c';
const HEVC_DECODER_BRIDGE_LICENSE_ASSET = 'ffmpeg-hevc/LICENSE.bridge.txt';
const FFMPEG_LICENSE_FILE_NAME = 'FFmpeg-COPYING.LGPLv2.1';
const HEVC_DECODER_BRIDGE_SOURCE_FILE_NAME = 'ffmpeg_hevc_bridge.c';

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

    it('serves the audio output stage binary with the engine license beside it', async () => {
        const { getLibraryAssets } = await loadLibraryAssets();
        const assets = getLibraryAssets();
        expect(assets.filter(([ destination ]) => destination === AUDIO_OUTPUT_STAGE_WASM_ASSET)).toHaveLength(1);
        const license = assets.find(([ destination ]) => destination === AUDIO_OUTPUT_STAGE_LICENSE_ASSET);
        expect(license?.[1]).toMatch(new RegExp(`[\\\\/]${ENGINE_LICENSE_FILE_NAME}$`, 'u'));
    });

    it('serves the HEVC decoder with FFmpeg\'s license and its bridge\'s source and license beside it', async () => {
        const { getLibraryAssets } = await loadLibraryAssets();
        const assets = getLibraryAssets();
        // The file names of the sources the build copies to a path, of which a served path has one
        const getSourceFileNames = (path: string): string[] => assets
            .filter(([ destination ]) => destination === path)
            .map((asset: readonly [ string, string ]): string => basename(asset[1]));

        for (const path of [ HEVC_DECODER_GLUE_ASSET, HEVC_DECODER_WASM_ASSET ]) {
            expect(getSourceFileNames(path)).toEqual([ basename(path) ]);
        }
        expect(getSourceFileNames(HEVC_DECODER_FFMPEG_LICENSE_ASSET)).toEqual([ FFMPEG_LICENSE_FILE_NAME ]);
        expect(getSourceFileNames(HEVC_DECODER_BRIDGE_SOURCE_ASSET)).toEqual([ HEVC_DECODER_BRIDGE_SOURCE_FILE_NAME ]);
        expect(getSourceFileNames(HEVC_DECODER_BRIDGE_LICENSE_ASSET)).toEqual([ ENGINE_LICENSE_FILE_NAME ]);
    });
});

describe('engine asset URLs', () => {
    it('returns the bare path without a location', () => {
        expect(resolveEngineAssetURL(HEVC_DECODER_GLUE_ASSET)).toBe(HEVC_DECODER_GLUE_ASSET);
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
        expect(resolveEngineAssetURL(HEVC_DECODER_WASM_ASSET)).toBe(
            `${ASSET_BASE_URL}${HEVC_DECODER_WASM_ASSET}?v=${CACHE_KEY}`
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

    it('resolves the audio output stage beside the playback worker with the build\'s cache key', () => {
        expect(resolveInWorker('webgpu-player/CustomDecode.worker.js', AUDIO_OUTPUT_STAGE_WASM_ASSET)).toBe(
            `${ASSET_BASE_URL}${AUDIO_OUTPUT_STAGE_WASM_ASSET}?v=${CACHE_KEY}`
        );
    });
});
