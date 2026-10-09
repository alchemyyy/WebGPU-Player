// Renders a book's PlantUML diagrams to SVG, once per diagram mode, so the book can show the variant that matches its theme.
// A book keeps its sources in diagrams/ and its rendered SVGs in src/diagrams/, as named in constants.json for this engine's book.
// The pinned PlantUML jar is downloaded into bin/plantuml/ on first use and checked against its SHA-256.
// Usage: node tools/render-diagrams.mjs [--check | --watch] [book directory ...]
//   With no book directory, it renders this engine's book.
//   --check renders into a temporary folder and fails when a committed SVG differs or is missing.
//   --watch renders again whenever a source in a book's diagrams/ or the engine's theme changes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import {
    DOCUMENTATION_DIAGRAM_OUTPUT_DIRECTORY,
    DOCUMENTATION_DIAGRAMS_DIRECTORY,
    DOCUMENTATION_DIRECTORY,
    PLANTUML_OUTPUT_DIRECTORY
} from './constants.mjs';

const PLANTUML_VERSION = '1.2026.2';
const PLANTUML_JAR_NAME = `plantuml-mit-${PLANTUML_VERSION}.jar`;
const PLANTUML_JAR_URL = `https://github.com/plantuml/plantuml/releases/download/v${PLANTUML_VERSION}/${PLANTUML_JAR_NAME}`;
const PLANTUML_JAR_SHA256 = '397fe169dd408b0f039e8b7be2a12c2d52d35a3399802921b8c84f29cf39e45a';
const PLANTUML_JAR_FILE = join(PLANTUML_OUTPUT_DIRECTORY, PLANTUML_JAR_NAME);

const DIAGRAM_MODES = Object.freeze([ 'light', 'dark' ]);
const DIAGRAM_SOURCE_EXTENSION = '.puml';
const DIAGRAM_START_PATTERN = /^@startuml\b/m;
const CHECK_FLAG = '--check';
const WATCH_FLAG = '--watch';
const WATCH_DEBOUNCE_MILLISECONDS = 300;

// A book's diagram folders, relative to the book root, follow this engine's book
const DIAGRAM_SOURCE_FOLDER = relative(DOCUMENTATION_DIRECTORY, DOCUMENTATION_DIAGRAMS_DIRECTORY);
const DIAGRAM_OUTPUT_FOLDER = relative(DOCUMENTATION_DIRECTORY, DOCUMENTATION_DIAGRAM_OUTPUT_DIRECTORY);

/**
 * Returns the SHA-256 of a byte buffer as lowercase hex.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function getSHA256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Downloads the pinned PlantUML jar unless a verified copy is already present.
 * @returns {Promise<void>}
 */
async function ensurePlantUMLJar() {
    if (existsSync(PLANTUML_JAR_FILE) && getSHA256(readFileSync(PLANTUML_JAR_FILE)) === PLANTUML_JAR_SHA256) {
        return;
    }
    console.log(`Downloading ${PLANTUML_JAR_URL}`);
    const response = await fetch(PLANTUML_JAR_URL);
    if (!response.ok) {
        throw new Error(`Downloading PlantUML failed with HTTP ${response.status}`);
    }
    const jarBytes = new Uint8Array(await response.arrayBuffer());
    const jarSHA256 = getSHA256(jarBytes);
    if (jarSHA256 !== PLANTUML_JAR_SHA256) {
        throw new Error(`The downloaded PlantUML jar has SHA-256 ${jarSHA256}, not the pinned ${PLANTUML_JAR_SHA256}`);
    }
    mkdirSync(PLANTUML_OUTPUT_DIRECTORY, { recursive: true });
    writeFileSync(PLANTUML_JAR_FILE, jarBytes);
}

/**
 * Lists the diagram sources of a book, skipping include-only files such as the theme, which have no @startuml.
 * @param {string} sourceDirectory
 * @returns {string[]}
 */
function listDiagramSources(sourceDirectory) {
    if (!existsSync(sourceDirectory)) {
        return [];
    }
    const sources = [];
    for (const fileName of readdirSync(sourceDirectory).sort()) {
        if (!fileName.endsWith(DIAGRAM_SOURCE_EXTENSION)) {
            continue;
        }
        const sourceFile = join(sourceDirectory, fileName);
        if (DIAGRAM_START_PATTERN.test(readFileSync(sourceFile, 'utf8'))) {
            sources.push(sourceFile);
        }
    }
    return sources;
}

/**
 * Returns the rendered file name of a diagram in one mode, such as architecture-layers.dark.svg.
 * @param {string} sourceFile
 * @param {string} mode
 * @returns {string}
 */
function getRenderedFileName(sourceFile, mode) {
    return `${basename(sourceFile, DIAGRAM_SOURCE_EXTENSION)}.${mode}.svg`;
}

/**
 * Renders every source in every mode into a directory, and returns whether PlantUML succeeded.
 * @param {string[]} sourceFiles
 * @param {string} renderDirectory
 * @returns {boolean}
 */
function renderDiagrams(sourceFiles, renderDirectory) {
    let succeeded = true;
    for (const mode of DIAGRAM_MODES) {
        const modeDirectory = join(renderDirectory, mode);
        mkdirSync(modeDirectory, { recursive: true });
        // NOTE: PlantUML names each output after its source and exits nonzero when any diagram has an error
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- Java is a developer tool resolved from PATH
        const result = spawnSync('java', [
            '-Djava.awt.headless=true',
            '-jar', PLANTUML_JAR_FILE,
            '-tsvg',
            '-charset', 'UTF-8',
            '--ignore-startuml-filename',
            `-DDIAGRAM_MODE=${mode}`,
            '-o', modeDirectory,
            ...sourceFiles
        ], { encoding: 'utf8' });
        if (result.error) {
            throw new Error(`Running Java failed (${result.error.message}); PlantUML needs Java 11 or later on PATH`);
        }
        if (result.status !== 0) {
            succeeded = false;
            console.error(`PlantUML failed in ${mode} mode:\n${result.stdout}${result.stderr}`);
        }
        for (const sourceFile of sourceFiles) {
            const plainFile = join(modeDirectory, `${basename(sourceFile, DIAGRAM_SOURCE_EXTENSION)}.svg`);
            if (existsSync(plainFile)) {
                renameSync(plainFile, join(renderDirectory, getRenderedFileName(sourceFile, mode)));
            }
        }
        rmSync(modeDirectory, { recursive: true, force: true });
    }
    return succeeded;
}

/**
 * Lists the rendered SVGs in an output directory, which a source rename or removal can leave behind.
 * @param {string} outputDirectory
 * @returns {string[]}
 */
function listRenderedFiles(outputDirectory) {
    if (!existsSync(outputDirectory)) {
        return [];
    }
    return readdirSync(outputDirectory).filter(fileName => DIAGRAM_MODES.some(mode => fileName.endsWith(`.${mode}.svg`)));
}

/**
 * Copies one rendered SVG over its committed copy when they differ, or reports the difference in check mode, and returns whether it was current.
 * @param {string} fileName
 * @param {string} renderDirectory
 * @param {string} outputDirectory
 * @param {boolean} isCheck
 * @returns {boolean}
 */
function syncRenderedFile(fileName, renderDirectory, outputDirectory, isCheck) {
    const renderedFile = join(renderDirectory, fileName);
    const committedFile = join(outputDirectory, fileName);
    if (!existsSync(renderedFile)) {
        console.error(`Not rendered: ${fileName}`);
        return false;
    }
    const renderedBytes = readFileSync(renderedFile);
    if (existsSync(committedFile) && renderedBytes.equals(readFileSync(committedFile))) {
        return true;
    }
    if (isCheck) {
        console.error(`Stale: ${relative(process.cwd(), committedFile)}`);
        return false;
    }
    writeFileSync(committedFile, renderedBytes);
    console.log(`Rendered: ${relative(process.cwd(), committedFile)}`);
    return true;
}

/**
 * Removes rendered SVGs that no source produces, or reports them in check mode, and returns whether there were none.
 * @param {Set<string>} expectedFileNames
 * @param {string} outputDirectory
 * @param {boolean} isCheck
 * @returns {boolean}
 */
function removeOrphanedFiles(expectedFileNames, outputDirectory, isCheck) {
    let isClean = true;
    for (const fileName of listRenderedFiles(outputDirectory)) {
        if (expectedFileNames.has(fileName)) {
            continue;
        }
        const orphanFile = join(outputDirectory, fileName);
        if (isCheck) {
            isClean = false;
            console.error(`No source: ${relative(process.cwd(), orphanFile)}`);
        } else {
            rmSync(orphanFile);
            console.log(`Removed: ${relative(process.cwd(), orphanFile)}`);
        }
    }
    return isClean;
}

/**
 * Renders one book's diagrams into its output folder, or compares them with it, and returns whether the book is clean.
 * @param {string} bookDirectory
 * @param {boolean} isCheck
 * @returns {boolean}
 */
function processBook(bookDirectory, isCheck) {
    const sourceDirectory = join(bookDirectory, DIAGRAM_SOURCE_FOLDER);
    const outputDirectory = join(bookDirectory, DIAGRAM_OUTPUT_FOLDER);
    const sourceFiles = listDiagramSources(sourceDirectory);
    const expectedFileNames = new Set(sourceFiles.flatMap(sourceFile => DIAGRAM_MODES.map(mode => getRenderedFileName(sourceFile, mode))));
    const renderDirectory = mkdtempSync(join(tmpdir(), 'render-diagrams-'));
    try {
        let isClean = renderDiagrams(sourceFiles, renderDirectory);
        if (!isCheck) {
            mkdirSync(outputDirectory, { recursive: true });
        }
        for (const fileName of expectedFileNames) {
            isClean = syncRenderedFile(fileName, renderDirectory, outputDirectory, isCheck) && isClean;
        }
        return removeOrphanedFiles(expectedFileNames, outputDirectory, isCheck) && isClean;
    } finally {
        rmSync(renderDirectory, { recursive: true, force: true });
    }
}

/**
 * Renders every book again whenever a diagram source or the shared theme changes.
 * @param {string[]} bookDirectories
 * @returns {void}
 */
function watchBooks(bookDirectories) {
    const watchedDirectories = new Set([ DOCUMENTATION_DIAGRAMS_DIRECTORY, ...bookDirectories.map(bookDirectory => join(bookDirectory, DIAGRAM_SOURCE_FOLDER)) ]);
    let pendingTimer = null;
    const scheduleRender = () => {
        clearTimeout(pendingTimer);
        pendingTimer = setTimeout(() => {
            for (const bookDirectory of bookDirectories) {
                processBook(bookDirectory, false);
            }
        }, WATCH_DEBOUNCE_MILLISECONDS);
    };
    for (const directory of watchedDirectories) {
        if (existsSync(directory)) {
            watch(directory, (eventType, fileName) => {
                if (fileName?.endsWith(DIAGRAM_SOURCE_EXTENSION)) {
                    scheduleRender();
                }
            });
        }
    }
    console.log('Watching for diagram changes; press Ctrl+C to stop');
}

const argumentsList = process.argv.slice(2);
const isCheck = argumentsList.includes(CHECK_FLAG);
const isWatch = argumentsList.includes(WATCH_FLAG);
if (isCheck && isWatch) {
    throw new Error(`${CHECK_FLAG} and ${WATCH_FLAG} cannot be combined`);
}
const bookArguments = argumentsList.filter(argument => argument !== CHECK_FLAG && argument !== WATCH_FLAG);
const bookDirectories = bookArguments.length > 0 ? bookArguments.map(argument => resolve(argument)) : [ DOCUMENTATION_DIRECTORY ];

await ensurePlantUMLJar();
let isClean = true;
for (const bookDirectory of bookDirectories) {
    isClean = processBook(bookDirectory, isCheck) && isClean;
}
if (isWatch) {
    watchBooks(bookDirectories);
} else if (!isClean) {
    process.exitCode = 1;
}
