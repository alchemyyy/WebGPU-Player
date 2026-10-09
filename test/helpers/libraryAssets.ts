import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DecoderWASMSource } from 'webgpu-player/DecoderWASMSource';
import type { EngineLibraryPath } from 'webgpu-player/EngineAssets';

import { SCRIPTS_DIRECTORY } from './enginePaths';

export type LibraryAssetTable = readonly (readonly [ string, string ])[];

export type LibraryAssetsModule = Readonly<{
    getLibraryAssets: () => LibraryAssetTable
    getWorkerEntryPoints: () => LibraryAssetTable
}>;

/** Loads the asset build's tables, which map each served file to its source. */
export async function loadLibraryAssets(): Promise<LibraryAssetsModule> {
    // Imported by URL, because the build tables are plain JavaScript without declarations
    const moduleURL = pathToFileURL(resolve(SCRIPTS_DIRECTORY, 'library-assets.mjs')).href;
    return await import(/* @vite-ignore */ moduleURL) as LibraryAssetsModule;
}

/**
 * Reads a served decoder binary from the file the asset build copies it from.
 * Tests pass it as bytes, as a caller that already fetched the binary would, because Node has no server for its URL.
 */
export async function readDecoderWASMSource(path: EngineLibraryPath): Promise<DecoderWASMSource> {
    const { getLibraryAssets } = await loadLibraryAssets();
    const asset = getLibraryAssets().find(([ destination ]) => destination === path);
    if (!asset) {
        throw new Error(`The asset build serves no ${path}`);
    }
    return { bytes: new Uint8Array(readFileSync(asset[1])).buffer, kind: 'bytes' };
}
