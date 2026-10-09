#!/usr/bin/env node
// Assembles every asset the engine serves, in the layout the player requests at runtime.
// The output locations come from tools/constants.json.
// Usage: node scripts/build.mjs [--production]

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { build } from 'esbuild';

import { BUILD_INFO_FILE, ENGINE_ROOT, LIBRARY_OUTPUT_DIRECTORY, WASM_OUTPUT_DIRECTORY } from '../tools/constants.mjs';
import { getLibraryAssets, getWorkerEntryPoints } from './library-assets.mjs';

const ASSET_KEY_LENGTH = 16;
const PRODUCTION = process.argv.includes('--production');
// Workers only run in WebGPU-capable browsers, so they keep modern syntax
const WORKER_TARGET = 'es2022';

function copyAsset(destination, source) {
    if (!existsSync(source)) {
        // A decoder build from before a kit gained an output lacks that output
        const remedy = source.startsWith(WASM_OUTPUT_DIRECTORY) ? '; rebuild the decoders with make -C wasm sources all' : '';
        throw new Error(`Missing engine asset for libraries/${destination}: ${source}${remedy}`);
    }
    const target = join(LIBRARY_OUTPUT_DIRECTORY, destination);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
}

/** Hashes every served file, so each distinct build gets a distinct cache key. */
function computeAssetKey() {
    const files = [];
    for (const entry of readdirSync(LIBRARY_OUTPUT_DIRECTORY, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
            files.push(relative(LIBRARY_OUTPUT_DIRECTORY, join(entry.parentPath, entry.name)).split(sep).join('/'));
        }
    }
    files.sort();
    const hash = createHash('sha256');
    for (const file of files) {
        hash.update(file);
        hash.update('\0');
        hash.update(readFileSync(join(LIBRARY_OUTPUT_DIRECTORY, file)));
    }
    return hash.digest('hex').slice(0, ASSET_KEY_LENGTH);
}

// The decoders are build outputs too, from a separate toolchain, so a fresh checkout builds them once
if (!existsSync(WASM_OUTPUT_DIRECTORY)) {
    throw new Error(`The WebAssembly decoders are not built in ${WASM_OUTPUT_DIRECTORY}. `
        + 'Run make -C wasm sources all from the engine root; docs/src/decoders.md lists the toolchain.');
}

rmSync(LIBRARY_OUTPUT_DIRECTORY, { force: true, recursive: true });
for (const [ destination, source ] of getLibraryAssets()) {
    copyAsset(destination, source);
}

// Classic workers, because the decoder glue loads through importScripts
await build({
    absWorkingDir: ENGINE_ROOT,
    bundle: true,
    entryPoints: getWorkerEntryPoints().map(([ destination, source ]) => ({
        in: source,
        out: destination.replace(/\.js$/u, '')
    })),
    format: 'iife',
    logLevel: 'warning',
    // The audio decoder glue reads import.meta.url only to locate its WASM, which the engine always locates for it
    logOverride: { 'empty-import-meta': 'silent' },
    minify: PRODUCTION,
    outdir: LIBRARY_OUTPUT_DIRECTORY,
    platform: 'browser',
    sourcemap: PRODUCTION ? false : 'linked',
    target: WORKER_TARGET
});

const assetKey = computeAssetKey();
mkdirSync(dirname(BUILD_INFO_FILE), { recursive: true });
writeFileSync(BUILD_INFO_FILE, `${JSON.stringify({ assetKey }, null, 2)}\n`);
console.log(`webgpu-player: assembled ${LIBRARY_OUTPUT_DIRECTORY} (${PRODUCTION ? 'production' : 'development'}, key ${assetKey})`);
