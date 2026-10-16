#!/usr/bin/env node
// Assembles every asset the engine serves, in the layout the player requests at runtime.
// The output locations come from tools/constants.json.
// Usage: node scripts/build.mjs [--production]

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { build } from 'esbuild';

import {
    BUILD_INFO_FILE,
    ENGINE_ROOT,
    LIBRARY_OUTPUT_DIRECTORY,
    PASS_OUTPUT_DIRECTORY,
    PASSES_DIRECTORY,
    WASM_OUTPUT_DIRECTORY
} from '../tools/constants.mjs';
import { getLibraryAssets, getWorkerEntryPoints } from './library-assets.mjs';

const ASSET_KEY_LENGTH = 16;
const PRODUCTION = process.argv.includes('--production');
// Workers only run in WebGPU-capable browsers, so they keep modern syntax
const WORKER_TARGET = 'es2022';

const PASS_FILE_EXTENSION = '.wgsl';
function copyAsset(destination, source) {
    if (!existsSync(source)) {
        // A WebAssembly build from before a kit gained an output lacks that output
        const remedy = source.startsWith(WASM_OUTPUT_DIRECTORY) ? '; rebuild the engine\'s WebAssembly with make -C wasm all' : '';
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

// The engine's WebAssembly is a build output too, from a separate toolchain, so a fresh checkout builds it once
/**
 * Copies the pass files of every pass project into the pass output folder, flat, so a host serves them from one place, and returns how many it copied.
 * A pass file is a WGSL file at a project's top level; two of the same name fail the build.
 */
function assemblePasses() {
    rmSync(PASS_OUTPUT_DIRECTORY, { force: true, recursive: true });
    mkdirSync(PASS_OUTPUT_DIRECTORY, { recursive: true });
    const projectByFileName = new Map();
    for (const project of readdirSync(PASSES_DIRECTORY, { withFileTypes: true })) {
        if (!project.isDirectory()) {
            continue;
        }
        const projectDirectory = join(PASSES_DIRECTORY, project.name);
        for (const entry of readdirSync(projectDirectory, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(PASS_FILE_EXTENSION)) {
                continue;
            }
            const earlierProject = projectByFileName.get(entry.name);
            if (earlierProject !== undefined) {
                throw new Error(`pass-name-duplicate: ${entry.name} in ${earlierProject} and ${project.name}`);
            }
            projectByFileName.set(entry.name, project.name);
            copyFileSync(join(projectDirectory, entry.name), join(PASS_OUTPUT_DIRECTORY, entry.name));
        }
    }
    return projectByFileName.size;
}

if (!existsSync(WASM_OUTPUT_DIRECTORY)) {
    throw new Error(`The engine's WebAssembly is not built in ${WASM_OUTPUT_DIRECTORY}. `
        + 'Run make -C wasm all from the engine root; docs/src/decoders.md lists the toolchain.');
}

rmSync(LIBRARY_OUTPUT_DIRECTORY, { force: true, recursive: true });
for (const [ destination, source ] of getLibraryAssets()) {
    copyAsset(destination, source);
}

// Classic workers, which find the engine's assets from their own URL
await build({
    absWorkingDir: ENGINE_ROOT,
    bundle: true,
    entryPoints: getWorkerEntryPoints().map(([ destination, source ]) => ({
        in: source,
        out: destination.replace(/\.js$/u, '')
    })),
    format: 'iife',
    logLevel: 'warning',
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

// The pass files sit beside the libraries, outside the asset key: a host offers them, and the engine never requests one itself
const passCount = assemblePasses();
console.log(`webgpu-player: assembled ${passCount} pass files into ${PASS_OUTPUT_DIRECTORY}`);
