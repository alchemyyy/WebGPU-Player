#!/usr/bin/env node
// Assembles every asset the engine serves under libraries/, in the layout the player requests at runtime.
// Usage: node scripts/build.mjs [--production]

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { build } from 'esbuild';

import { ENGINE_ROOT, getLibraryAssets, getWorkerEntryPoints } from './library-assets.mjs';

const DIST_OUTPUT = join(ENGINE_ROOT, 'dist');
const LIBRARIES_OUTPUT = join(DIST_OUTPUT, 'libraries');
// Hosts read the asset key from here to bust caches of the stable asset URLs
const BUILD_INFO_OUTPUT = join(DIST_OUTPUT, 'build-info.json');
const ASSET_KEY_LENGTH = 16;
const PRODUCTION = process.argv.includes('--production');
// Workers only run in WebGPU-capable browsers, so they keep modern syntax
const WORKER_TARGET = 'es2022';

function copyAsset(destination, source) {
    if (!existsSync(source)) {
        throw new Error(`Missing engine asset for libraries/${destination}: ${source}`);
    }
    const target = join(LIBRARIES_OUTPUT, destination);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
}

/** Hashes every served file, so each distinct build gets a distinct cache key. */
function computeAssetKey() {
    const files = [];
    for (const entry of readdirSync(LIBRARIES_OUTPUT, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
            files.push(relative(LIBRARIES_OUTPUT, join(entry.parentPath, entry.name)).split(sep).join('/'));
        }
    }
    files.sort();
    const hash = createHash('sha256');
    for (const file of files) {
        hash.update(file);
        hash.update('\0');
        hash.update(readFileSync(join(LIBRARIES_OUTPUT, file)));
    }
    return hash.digest('hex').slice(0, ASSET_KEY_LENGTH);
}

rmSync(LIBRARIES_OUTPUT, { force: true, recursive: true });
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
    // The single-file decoder glue reads import.meta.url only to derive a script directory it never uses
    logOverride: { 'empty-import-meta': 'silent' },
    minify: PRODUCTION,
    outdir: LIBRARIES_OUTPUT,
    platform: 'browser',
    sourcemap: PRODUCTION ? false : 'linked',
    target: WORKER_TARGET
});

const assetKey = computeAssetKey();
writeFileSync(BUILD_INFO_OUTPUT, `${JSON.stringify({ assetKey }, null, 2)}\n`);
console.log(`webgpu-player: assembled ${LIBRARIES_OUTPUT} (${PRODUCTION ? 'production' : 'development'}, key ${assetKey})`);
