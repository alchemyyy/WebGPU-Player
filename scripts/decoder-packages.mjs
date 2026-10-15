#!/usr/bin/env node
// Builds the decoder projects in decoders/ into their packages in bin/decoders/<project>.wasm.
// A project is a folder with a decoder.json, which names its decoder source: one file, or a list of WGSL files the package carries joined in
// order, the header in the first. A project with a Makefile builds its module with `make module`,
// and a project whose decoder.json lists vectors packs the <project>.vectors that scripts/codec_vector_assets/generate_decoder_package_vectors.py writes.
// Every package must load with the engine's own loader, as any host loads it. The engine itself names no project.
// Usage: node scripts/decoder-packages.mjs [--check] [<project> ...]
//   --check  builds into a scratch folder and fails unless every package matches the one in bin/decoders/
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DECODER_BUILD_DIRECTORY, DECODER_OUTPUT_DIRECTORY, DECODERS_DIRECTORY } from '../tools/constants.mjs';
import { assembleDecoderPackage, checkDecoderPackage, joinDecoderSources } from '../tools/decoder-package-format.mjs';

const PROJECT_FILE_NAME = 'decoder.json';
const MAKEFILE_NAME = 'Makefile';
const MODULE_FILE_NAME = 'module.wasm';
const MODULE_TARGET = 'module';
const VECTORS_EXTENSION = '.vectors';
const PACKAGE_EXTENSION = '.wasm';
const CHECK_FLAG = '--check';

/** Returns the names of the decoder projects, the folders of decoders/ that hold a decoder.json. */
function listProjects() {
    return readdirSync(DECODERS_DIRECTORY, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && existsSync(join(DECODERS_DIRECTORY, entry.name, PROJECT_FILE_NAME)))
        .map(entry => entry.name)
        .sort();
}

/** Returns whether a decoder.json value names a file. */
function isFileName(value) {
    return typeof value === 'string' && value.length > 0;
}

/** Reads a project's decoder.json: its decoder source files, relative to the project, and whether it lists vectors. */
function readProject(name) {
    const directory = join(DECODERS_DIRECTORY, name);
    const declaration = JSON.parse(readFileSync(join(directory, PROJECT_FILE_NAME), 'utf8'));
    const decoderFiles = Array.isArray(declaration.decoder) ? declaration.decoder : [ declaration.decoder ];
    if (decoderFiles.length === 0 || !decoderFiles.every(isFileName)) {
        throw new Error(`decoders/${name}/${PROJECT_FILE_NAME} names no decoder source`);
    }
    return {
        decoderFiles,
        directory,
        hasModule: existsSync(join(directory, MAKEFILE_NAME)),
        hasVectors: Array.isArray(declaration.vectors) && declaration.vectors.length > 0,
        name
    };
}

/** Builds a project's module with its Makefile and returns its bytes. */
function buildModule(project) {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- make is a developer tool resolved from PATH, as the WebAssembly build's is
    const result = spawnSync('make', [ '-C', project.directory, MODULE_TARGET ], { stdio: 'inherit' });
    if (result.error) {
        throw new Error(`make for decoders/${project.name} did not start: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`make module failed for decoders/${project.name} with status ${result.status}`);
    }
    return new Uint8Array(readFileSync(join(DECODER_BUILD_DIRECTORY, project.name, MODULE_FILE_NAME)));
}

/** Reads a project's vectors section, which must exist when its decoder.json lists vectors. */
function readVectors(project) {
    const vectorsPath = join(project.directory, `${project.name}${VECTORS_EXTENSION}`);
    if (!existsSync(vectorsPath)) {
        throw new Error(`Missing decoders/${project.name}/${project.name}${VECTORS_EXTENSION}; run scripts/codec_vector_assets/generate_decoder_package_vectors.py`);
    }
    return new Uint8Array(readFileSync(vectorsPath));
}

/** Builds and checks one project's package, returning its bytes. */
async function buildPackage(project) {
    const moduleBinary = project.hasModule ? buildModule(project) : null;
    const source = joinDecoderSources(project.decoderFiles.map(fileName => ({
        name: fileName,
        text: readFileSync(join(project.directory, fileName), 'utf8')
    })));
    const vectorsSection = project.hasVectors ? readVectors(project) : null;
    const packageBytes = assembleDecoderPackage(moduleBinary, source, vectorsSection);
    try {
        await checkDecoderPackage(packageBytes);
    } catch (error) {
        throw new Error(`decoders/${project.name} does not load: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    return packageBytes;
}

/** Returns whether two byte arrays hold the same bytes. */
function equalBytes(first, second) {
    return first.byteLength === second.byteLength && first.every((value, index) => value === second[index]);
}

async function main() {
    const argumentsList = process.argv.slice(2);
    const isCheck = argumentsList.includes(CHECK_FLAG);
    const requestedProjects = argumentsList.filter(argument => argument !== CHECK_FLAG);
    const projectNames = requestedProjects.length > 0 ? requestedProjects : listProjects();
    const outputDirectory = isCheck ? mkdtempSync(join(tmpdir(), 'decoder-packages-')) : DECODER_OUTPUT_DIRECTORY;
    let clean = true;
    try {
        mkdirSync(outputDirectory, { recursive: true });
        for (const name of projectNames) {
            const packageBytes = await buildPackage(readProject(name));
            const fileName = `${name}${PACKAGE_EXTENSION}`;
            if (!isCheck) {
                writeFileSync(join(outputDirectory, fileName), packageBytes);
                console.log(`Packed decoders/${name} into ${join(outputDirectory, fileName)} (${packageBytes.byteLength} bytes)`);
                continue;
            }
            const committedPath = join(DECODER_OUTPUT_DIRECTORY, fileName);
            const matches = existsSync(committedPath) && equalBytes(new Uint8Array(readFileSync(committedPath)), packageBytes);
            console.log(`${matches ? 'identical' : 'DIFFERS'}: ${fileName}`);
            clean &&= matches;
        }
    } finally {
        if (isCheck) {
            rmSync(outputDirectory, { force: true, recursive: true });
        }
    }
    if (!clean) {
        process.exitCode = 1;
    }
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
