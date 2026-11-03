#!/usr/bin/env node
// Copies the pass files of every pass project in the wgpup/ submodule into bin/wgpup/, flat, as a host serves them, in place of the files
// of the pinned passes release, so a pass edited there can be offered and picked in the sandbox.
// A pass file is a WGSL file at a project's top level; two of the same name fail the build, as the passes repository's release does.
// Usage: node scripts/pass-files.mjs
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { LAYOUT, PASS_OUTPUT_DIRECTORY, PASSES_DIRECTORY } from '../tools/constants.mjs';

const PASS_FILE_EXTENSION = '.wgsl';

/** Returns every pass file of every pass project by file name, with its project and its path; two of the same name fail. */
function listPassFiles() {
    const projects = existsSync(PASSES_DIRECTORY) ? readdirSync(PASSES_DIRECTORY, { withFileTypes: true }).filter(entry => entry.isDirectory()) : [];
    const passFiles = new Map();
    for (const project of projects) {
        const projectDirectory = join(PASSES_DIRECTORY, project.name);
        for (const entry of readdirSync(projectDirectory, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(PASS_FILE_EXTENSION)) {
                continue;
            }
            const earlier = passFiles.get(entry.name);
            if (earlier !== undefined) {
                throw new Error(`pass-name-duplicate: ${entry.name} in ${earlier.project} and ${project.name}`);
            }
            passFiles.set(entry.name, { path: join(projectDirectory, entry.name), project: project.name });
        }
    }
    // An uninitialized submodule is an empty folder, which must not empty the pass output folder
    if (passFiles.size === 0) {
        throw new Error(`pass-projects-missing: no pass file in ${LAYOUT.passesDirectory}/; run git submodule update --init ${LAYOUT.passesDirectory}`);
    }
    return passFiles;
}

try {
    const passFiles = listPassFiles();
    rmSync(PASS_OUTPUT_DIRECTORY, { force: true, recursive: true });
    mkdirSync(PASS_OUTPUT_DIRECTORY, { recursive: true });
    for (const [ fileName, { path } ] of passFiles) {
        copyFileSync(path, join(PASS_OUTPUT_DIRECTORY, fileName));
    }
    console.log(`webgpu-player: copied ${passFiles.size} pass files into ${PASS_OUTPUT_DIRECTORY}`);
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
