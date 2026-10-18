#!/usr/bin/env node
// Builds the decoder projects in wgpud/ into their packages in bin/wgpud/<project>.wasm.
// A project is a folder with a decoder.json, which names its decoder source: one file, or a list of WGSL files the package carries joined in
// order, the header in the first. A project with a Makefile builds its module with `make module`,
// and a project whose decoder.json lists vectors packs the <project>.vectors that scripts/codec_vector_assets/generate_decoder_package_vectors.py writes.
// Every package must load with the engine's own loader, as any host loads it. The engine itself names no project.
// Every module builds at once, each output line prefixed with its project's name; once all builds end, the packages pack in order.
// Usage: node scripts/decoder-packages.mjs [--check] [<project> ...]
//   --check  builds into a scratch folder and fails unless every package matches the one in bin/wgpud/
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { DECODER_BUILD_DIRECTORY, DECODER_OUTPUT_DIRECTORY, DECODERS_DIRECTORY, LAYOUT } from '../tools/constants.mjs';
import { assembleDecoderPackage, checkDecoderPackage, joinDecoderSources } from '../tools/decoder-package-format.mjs';

const PROJECT_FILE_NAME = 'decoder.json';
const MAKEFILE_NAME = 'Makefile';
const MODULE_FILE_NAME = 'module.wasm';
const MODULE_TARGET = 'module';
const VECTORS_EXTENSION = '.vectors';
const PACKAGE_EXTENSION = '.wasm';
const CHECK_FLAG = '--check';
const OUTPUT_PREFIX_SEPARATOR = ' | ';

/** Returns a project's folder relative to the engine root, as messages name it. */
function getProjectPath(name) {
    return `${LAYOUT.decodersDirectory}/${name}`;
}

/** Returns the names of the decoder projects, the folders of wgpud/ that hold a decoder.json. */
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
        throw new Error(`${getProjectPath(name)}/${PROJECT_FILE_NAME} names no decoder source`);
    }
    return {
        decoderFiles,
        directory,
        hasModule: existsSync(join(directory, MAKEFILE_NAME)),
        hasVectors: Array.isArray(declaration.vectors) && declaration.vectors.length > 0,
        name
    };
}

/** Copies one output stream of a module build to the given stream, each line prefixed, and resolves when the stream ends. */
function forwardLines(input, output, prefix) {
    const lines = createInterface({ crlfDelay: Infinity, input });
    lines.on('line', line => output.write(`${prefix}${line}\n`));
    return new Promise(resolve => {
        lines.once('close', resolve);
    });
}

/** Builds a project's module with its Makefile, beside the other projects' builds, and returns its bytes. */
async function buildModule(project) {
    const projectPath = getProjectPath(project.name);
    const prefix = `${project.name}${OUTPUT_PREFIX_SEPARATOR}`;
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- make is a developer tool resolved from PATH, as the WebAssembly build's is
    const child = spawn('make', [ '-C', project.directory, MODULE_TARGET ], { stdio: [ 'ignore', 'pipe', 'pipe' ] });
    const forwarding = Promise.all([
        forwardLines(child.stdout, process.stdout, prefix),
        forwardLines(child.stderr, process.stderr, prefix)
    ]);
    const exitStatus = await new Promise((resolve, reject) => {
        child.once('error', error => {
            reject(new Error(`make for ${projectPath} did not start: ${error.message}`));
        });
        // A build that a signal ends reports the signal's name
        child.once('close', (code, signal) => {
            resolve(code ?? signal);
        });
    });
    await forwarding;
    if (exitStatus !== 0) {
        throw new Error(`make module failed for ${projectPath} with status ${exitStatus}`);
    }
    return new Uint8Array(readFileSync(join(DECODER_BUILD_DIRECTORY, project.name, MODULE_FILE_NAME)));
}

/** Reads a project's vectors section, which must exist when its decoder.json lists vectors. */
function readVectors(project) {
    const vectorsPath = join(project.directory, `${project.name}${VECTORS_EXTENSION}`);
    if (!existsSync(vectorsPath)) {
        throw new Error(`Missing ${getProjectPath(project.name)}/${project.name}${VECTORS_EXTENSION}; run scripts/codec_vector_assets/generate_decoder_package_vectors.py`);
    }
    return new Uint8Array(readFileSync(vectorsPath));
}

/** Packs and checks one project's package from its built module, or null for a project without one, returning its bytes. */
async function assemblePackage(project, moduleBinary) {
    const source = joinDecoderSources(project.decoderFiles.map(fileName => ({
        name: fileName,
        text: readFileSync(join(project.directory, fileName), 'utf8')
    })));
    const vectorsSection = project.hasVectors ? readVectors(project) : null;
    const packageBytes = assembleDecoderPackage(moduleBinary, source, vectorsSection);
    try {
        await checkDecoderPackage(packageBytes);
    } catch (error) {
        throw new Error(`${getProjectPath(project.name)} does not load: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
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
    const projects = (requestedProjects.length > 0 ? requestedProjects : listProjects()).map(readProject);
    // Each build spends most of its time in one serial chain, such as a configure script's compiler probes, so the builds overlap well
    const moduleBuilds = await Promise.allSettled(projects.map(project => (project.hasModule ? buildModule(project) : null)));
    const outputDirectory = isCheck ? mkdtempSync(join(tmpdir(), 'decoder-packages-')) : DECODER_OUTPUT_DIRECTORY;
    const failures = [];
    let clean = true;
    try {
        mkdirSync(outputDirectory, { recursive: true });
        for (const [ index, project ] of projects.entries()) {
            const moduleBuild = moduleBuilds[index];
            if (moduleBuild.status === 'rejected') {
                failures.push(moduleBuild.reason);
                continue;
            }
            let packageBytes;
            try {
                packageBytes = await assemblePackage(project, moduleBuild.value);
            } catch (error) {
                failures.push(error);
                continue;
            }
            const fileName = `${project.name}${PACKAGE_EXTENSION}`;
            if (!isCheck) {
                writeFileSync(join(outputDirectory, fileName), packageBytes);
                console.log(`Packed ${getProjectPath(project.name)} into ${join(outputDirectory, fileName)} (${packageBytes.byteLength} bytes)`);
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
    // A failed build or load check fails the run once every other package has packed
    if (failures.length > 0) {
        const messages = failures.map(failure => (failure instanceof Error ? failure.message : String(failure)));
        throw new AggregateError(failures, messages.join('\n'));
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
