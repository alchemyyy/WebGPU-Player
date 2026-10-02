// @vitest-environment node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    configureEngineAssets,
    ENGINE_LIBRARY_PATHS,
    ENGINE_WORKER_PATHS,
    resolveEngineAssetURL
} from 'webgpu-player/EngineAssets';
import { HEVC_RANGE_EXTENSION_VARIANTS } from 'webgpu-player/custom/HEVCRangeExtensionCapabilities';

import { ENGINE_ROOT } from './helpers/enginePaths';

type AssetTable = readonly (readonly [ string, string ])[];

type LibraryAssetsModule = Readonly<{
    getLibraryAssets: () => AssetTable
    getWorkerEntryPoints: () => AssetTable
}>;

async function loadLibraryAssets(): Promise<LibraryAssetsModule> {
    // Imported by URL, because the build tables are plain JavaScript without declarations
    const moduleURL = pathToFileURL(resolve(ENGINE_ROOT, 'scripts/library-assets.mjs')).href;
    return await import(/* @vite-ignore */ moduleURL) as LibraryAssetsModule;
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
});
