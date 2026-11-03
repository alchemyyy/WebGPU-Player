#!/usr/bin/env node
// Installs the pinned releases of the decoder packages and the pass files into bin/wgpud/ and bin/wgpup/.
// tools/pinned-releases.json pins each release file by file: the GitHub repository it comes from, its tag, and the SHA-256 of every file it
// installs, the release's .wasm packages or .wgsl pass files. A download must match its pin.
// A file already in place that matches its pin stays. A file this script installed, which bin/installed-releases.json records, is replaced
// when the pin names other bytes and removed when the pin no longer names it. Any other file, such as one that npm run decoders or
// npm run passes built from the wgpud/ or wgpup/ submodule, stays, so a local build is never lost.
// build.sh and sandbox.sh run it before they build or serve anything; it needs the network only for a file it installs.
// Usage: node scripts/pinned-releases.mjs [--force]
//          --force  installs every pinned file over local builds too, and removes every file an earlier pin installed
//        node scripts/pinned-releases.mjs --pin <decoders|passes> <tag>
//          pins the files of the release <tag> from its SHA256SUMS, then installs them
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
    DECODER_OUTPUT_DIRECTORY,
    INSTALLED_RELEASES_FILE,
    LAYOUT,
    PASS_OUTPUT_DIRECTORY,
    PINNED_RELEASES_FILE
} from '../tools/constants.mjs';

const FORCE_FLAG = '--force';
const PIN_FLAG = '--pin';
const PIN_ARGUMENT_COUNT = 3;
const USAGE = 'node scripts/pinned-releases.mjs [--force], or node scripts/pinned-releases.mjs --pin <decoders|passes> <tag>';
// The releases the engine pins: which of a release's files it installs, and where
const RELEASES = Object.freeze({
    decoders: { fileExtension: '.wasm', outputDirectory: DECODER_OUTPUT_DIRECTORY, outputPath: LAYOUT.decoderOutputDirectory },
    passes: { fileExtension: '.wgsl', outputDirectory: PASS_OUTPUT_DIRECTORY, outputPath: LAYOUT.passOutputDirectory }
});
// Every release lists the SHA-256 of its files in this file, one line per file as sha256sum writes it: the digest, a space,
// a space or a *, and the file name
const CHECKSUMS_FILE_NAME = 'SHA256SUMS';
const CHECKSUM_LINE_PATTERN = /^([\da-f]{64}) [ *](.+)$/u;
// A release file installs under its own name, never into another folder
const FILE_NAME_PATTERN = /^\w[\w.-]*$/u;
const DOWNLOAD_TIMEOUT_MILLISECONDS = 120_000;
// A download lands in the output folder's parent under this suffix, outside the folder a host lists, then replaces its target whole
const PARTIAL_DOWNLOAD_SUFFIX = '.download';

/** Returns the message of an error, with its cause's, such as the network failure behind fetch's own message. */
function describeError(error) {
    if (!(error instanceof Error)) {
        return String(error);
    }
    return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

/** Returns the SHA-256 of bytes, in lowercase hex. */
function getDigest(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

/** Returns the SHA-256 of a file, or null when there is none. */
function getFileDigest(path) {
    return existsSync(path) ? getDigest(readFileSync(path)) : null;
}

function readJSONFile(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJSONFile(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Returns a copy of a record with its keys in code point order, so a JSON file lists files in a stable order. */
function sortByKey(record) {
    return Object.fromEntries(Object.entries(record).sort(([ first ], [ second ]) => (first < second ? -1 : 1)));
}

/** Returns the download URL of one file of a GitHub release. */
function getReleaseFileURL(repository, tag, fileName) {
    return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
}

/** Downloads a URL's bytes; any status but success fails. */
async function download(url) {
    let response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MILLISECONDS) });
    } catch (error) {
        throw new Error(`release-download-failed: ${url}: ${describeError(error)}`, { cause: error });
    }
    if (!response.ok) {
        throw new Error(`release-download-failed: ${url}: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}

/** Returns the pin of one release, which must name its repository, its tag, and its files with their SHA-256. */
function readPin(pins, name) {
    const pin = pins[name];
    const isPin = typeof pin?.repository === 'string' && typeof pin.tag === 'string'
        && typeof pin.files === 'object' && pin.files !== null;
    if (!isPin) {
        throw new Error(`release-pin-invalid: ${LAYOUT.pinnedReleasesFile} names no repository, tag, and files for ${name}`);
    }
    for (const fileName of Object.keys(pin.files)) {
        if (!FILE_NAME_PATTERN.test(fileName) || !fileName.endsWith(RELEASES[name].fileExtension)) {
            throw new Error(`release-pin-invalid: ${LAYOUT.pinnedReleasesFile} pins ${JSON.stringify(fileName)} for ${name}`);
        }
    }
    return pin;
}

/** Returns the pin of every file of the release <tag> that the engine installs, from the release's SHA256SUMS. */
async function pinRelease(name, tag, repository) {
    const { fileExtension } = RELEASES[name];
    const checksums = new TextDecoder().decode(await download(getReleaseFileURL(repository, tag, CHECKSUMS_FILE_NAME)));
    const files = {};
    for (const line of checksums.split('\n').map(text => text.trimEnd()).filter(text => text.length > 0)) {
        const match = CHECKSUM_LINE_PATTERN.exec(line);
        if (match === null) {
            throw new Error(`release-checksums-invalid: ${CHECKSUMS_FILE_NAME} of ${repository} ${tag} holds ${JSON.stringify(line)}`);
        }
        const [ , digest, fileName ] = match;
        if (fileName.endsWith(fileExtension) && FILE_NAME_PATTERN.test(fileName)) {
            files[fileName] = digest;
        }
    }
    if (Object.keys(files).length === 0) {
        throw new Error(`release-files-missing: ${CHECKSUMS_FILE_NAME} of ${repository} ${tag} lists no ${fileExtension} file`);
    }
    return { repository, tag, files: sortByKey(files) };
}

/** Downloads one pinned file, checks it against its pin, and writes it into the output folder whole. */
async function installFile(pin, fileName, digest, outputDirectory) {
    const bytes = await download(getReleaseFileURL(pin.repository, pin.tag, fileName));
    const downloadedDigest = getDigest(bytes);
    if (downloadedDigest !== digest) {
        throw new Error(`release-file-mismatch: ${fileName} of ${pin.repository} ${pin.tag} has SHA-256 ${downloadedDigest}, `
            + `but ${LAYOUT.pinnedReleasesFile} pins ${digest}`);
    }
    const partialPath = join(dirname(outputDirectory), `${fileName}${PARTIAL_DOWNLOAD_SUFFIX}`);
    writeFileSync(partialPath, bytes);
    renameSync(partialPath, join(outputDirectory, fileName));
}

/**
 * Installs the pinned files of one release, and returns the files this script holds installed in its folder afterwards, with their SHA-256.
 * installedFiles holds the ones it held installed before.
 */
async function installRelease(name, pin, installedFiles, force) {
    const { outputDirectory, outputPath } = RELEASES[name];
    const label = `pinned-releases: ${name} ${pin.tag}`;
    mkdirSync(outputDirectory, { recursive: true });
    const nowInstalled = {};
    const downloads = [];
    const localBuilds = [];
    for (const [ fileName, digest ] of Object.entries(pin.files)) {
        const currentDigest = getFileDigest(join(outputDirectory, fileName));
        if (currentDigest === digest) {
            nowInstalled[fileName] = digest;
        } else if (currentDigest === null || force || installedFiles[fileName] === currentDigest) {
            downloads.push(installFile(pin, fileName, digest, outputDirectory).then(() => {
                nowInstalled[fileName] = digest;
            }));
        } else {
            localBuilds.push(fileName);
        }
    }
    await Promise.all(downloads);

    // A file an earlier pin installed and this one does not name goes, unless it changed since, as a local build over it would
    const removedFiles = [];
    for (const [ fileName, digest ] of Object.entries(installedFiles)) {
        const path = join(outputDirectory, fileName);
        if (!Object.hasOwn(pin.files, fileName) && existsSync(path) && (force || getFileDigest(path) === digest)) {
            rmSync(path);
            removedFiles.push(fileName);
        }
    }

    const fileCount = Object.keys(pin.files).length;
    if (downloads.length === 0) {
        console.log(`${label}: ${Object.keys(nowInstalled).length} of ${fileCount} files up to date in ${outputPath}`);
    } else {
        console.log(`${label}: installed ${downloads.length} of ${fileCount} files into ${outputPath}`);
    }
    if (removedFiles.length > 0) {
        console.log(`${label}: removed ${removedFiles.join(', ')}, which the pin no longer names`);
    }
    for (const fileName of localBuilds) {
        console.log(`${label}: kept the local build ${outputPath}/${fileName}; --force installs the pinned file over it`);
    }
    return sortByKey(nowInstalled);
}

async function main() {
    const argumentsList = process.argv.slice(2);
    const pins = readJSONFile(PINNED_RELEASES_FILE);
    let names = Object.keys(RELEASES);
    let force = false;
    if (argumentsList[0] === PIN_FLAG) {
        const [ , name, tag ] = argumentsList;
        if (argumentsList.length !== PIN_ARGUMENT_COUNT || !Object.hasOwn(RELEASES, name)) {
            throw new Error(`release-usage: ${USAGE}`);
        }
        // A pin needs only its repository from the file, so a release can be pinned before the other one is
        const repository = pins[name]?.repository;
        if (typeof repository !== 'string') {
            throw new Error(`release-pin-invalid: ${LAYOUT.pinnedReleasesFile} names no repository for ${name}`);
        }
        pins[name] = await pinRelease(name, tag, repository);
        writeJSONFile(PINNED_RELEASES_FILE, pins);
        console.log(`pinned-releases: pinned ${name} ${tag} in ${LAYOUT.pinnedReleasesFile}`);
        names = [ name ];
    } else if (argumentsList.length === 1 && argumentsList[0] === FORCE_FLAG) {
        force = true;
    } else if (argumentsList.length > 0) {
        throw new Error(`release-usage: ${USAGE}`);
    }

    const installed = existsSync(INSTALLED_RELEASES_FILE) ? readJSONFile(INSTALLED_RELEASES_FILE) : {};
    for (const name of names) {
        const pin = readPin(pins, name);
        const files = await installRelease(name, pin, installed[name]?.files ?? {}, force);
        installed[name] = { repository: pin.repository, tag: pin.tag, files };
        writeJSONFile(INSTALLED_RELEASES_FILE, installed);
    }
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
