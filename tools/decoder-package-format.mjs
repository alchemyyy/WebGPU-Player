// Writes decoder packages: a WebAssembly module with the custom sections that carry its manifest, its WGSL, and its self-test vectors.
// scripts/decoder-packages.mjs and tools/pack-decoder-package.mjs share it; src/decode/packages/DecoderPackage.ts reads what it writes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { build } from 'esbuild';

import { ENGINE_ROOT, SOURCE_DIRECTORY } from './constants.mjs';

const PACKAGE_FORMAT = JSON.parse(readFileSync(join(SOURCE_DIRECTORY, 'decode', 'packages', 'DecoderPackageFormat.json'), 'utf8'));
const PACKAGE_LOADER_ENTRY = join(SOURCE_DIRECTORY, 'decode', 'packages', 'DecoderPackage.ts');

/** The custom section names a package carries, which src/decode/packages/DecoderPackageFormat.json declares once. */
export const DECODER_PACKAGE_SECTIONS = Object.freeze({
    decoder: PACKAGE_FORMAT.decoderSection,
    vectors: PACKAGE_FORMAT.vectorsSection
});

const MAGIC = [ 0x00, 0x61, 0x73, 0x6D ];
const VERSION = [ 0x01, 0x00, 0x00, 0x00 ];
const CUSTOM_SECTION_ID = 0;
const LEB128_PAYLOAD_MASK = 0x7F;
const LEB128_CONTINUATION = 0x80;
const LEB128_BITS_PER_BYTE = 7;
// A decoder source's header lines start with this; only the first file of a decoder's sources may hold them
const DECODER_HEADER_LINE_PREFIX = '//!';
// The comment line that names each later file of a joined decoder source, so a compile message's line leads back to its file
const DECODER_SOURCE_MARKER_PREFIX = '// Decoder source: ';
const LINE_BREAK = '\n';
const LINE_PATTERN = /\r?\n/;

/** Encodes an unsigned integer as LEB128. */
function encodeU32(value) {
    const bytes = [];
    let remaining = value;
    do {
        let byte = remaining & LEB128_PAYLOAD_MASK;
        remaining = Math.floor(remaining / (2 ** LEB128_BITS_PER_BYTE));
        if (remaining > 0) {
            byte |= LEB128_CONTINUATION;
        }
        bytes.push(byte);
    } while (remaining > 0);
    return Uint8Array.from(bytes);
}

/** Returns the smallest module binary, the magic and version, which a package without code starts from. */
export function createEmptyModule() {
    return Uint8Array.from([ ...MAGIC, ...VERSION ]);
}

/** Returns whether bytes start like a WebAssembly module binary. */
export function isModuleBinary(bytes) {
    return bytes.byteLength >= MAGIC.length + VERSION.length && MAGIC.every((value, index) => bytes[index] === value);
}

/** Returns a module binary with one more custom section: id 0, its byte length, its name, and its payload. */
export function appendCustomSection(binary, name, payload) {
    const nameBytes = new TextEncoder().encode(name);
    const nameLength = encodeU32(nameBytes.byteLength);
    const contentByteLength = nameLength.byteLength + nameBytes.byteLength + payload.byteLength;
    const sectionLength = encodeU32(contentByteLength);
    const result = new Uint8Array(binary.byteLength + 1 + sectionLength.byteLength + contentByteLength);
    let offset = 0;
    result.set(binary, offset);
    offset += binary.byteLength;
    result[offset] = CUSTOM_SECTION_ID;
    offset += 1;
    result.set(sectionLength, offset);
    offset += sectionLength.byteLength;
    result.set(nameLength, offset);
    offset += nameLength.byteLength;
    result.set(nameBytes, offset);
    offset += nameBytes.byteLength;
    result.set(payload, offset);
    return result;
}

/**
 * Joins a decoder's source files, each `{ name, text }`, in order into the one decoder source its package carries: the first file whole,
 * with the header, then each later file after a comment line that names it. Throws when no file is given or a later file holds a header line.
 */
export function joinDecoderSources(sources) {
    if (sources.length === 0) {
        throw new Error('A decoder names no source file');
    }
    let joined = sources[0].text;
    for (const source of sources.slice(1)) {
        const headerLineIndex = source.text.split(LINE_PATTERN).findIndex(line => line.startsWith(DECODER_HEADER_LINE_PREFIX));
        if (headerLineIndex >= 0) {
            throw new Error(`${source.name} line ${headerLineIndex + 1} is a header line, which only ${sources[0].name} may hold`);
        }
        if (!joined.endsWith(LINE_BREAK)) {
            joined += LINE_BREAK;
        }
        joined += `${DECODER_SOURCE_MARKER_PREFIX}${source.name}${LINE_BREAK}${source.text}`;
    }
    return joined;
}

/**
 * Assembles a package: the module binary, or an empty module for a package without code, with its decoder source and, when given, its vectors section.
 * Throws when the module binary is no WebAssembly module.
 */
export function assembleDecoderPackage(moduleBinary, decoderSource, vectorsSection) {
    const binary = moduleBinary ?? createEmptyModule();
    if (!isModuleBinary(binary)) {
        throw new Error('The module is no WebAssembly binary');
    }
    let packageBytes = appendCustomSection(binary, DECODER_PACKAGE_SECTIONS.decoder, new TextEncoder().encode(decoderSource));
    if (vectorsSection) {
        packageBytes = appendCustomSection(packageBytes, DECODER_PACKAGE_SECTIONS.vectors, vectorsSection);
    }
    return packageBytes;
}

/** Bundles one of the engine's TypeScript modules for Node and imports it, so a tool runs the engine's own code. */
export async function importEngineModule(entryPath) {
    const result = await build({
        absWorkingDir: ENGINE_ROOT,
        bundle: true,
        entryPoints: [ entryPath ],
        format: 'esm',
        logLevel: 'warning',
        platform: 'node',
        write: false
    });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

let packageLoader = null;

/** Loads package bytes with the engine's own loader, which rejects with the check they fail, such as `package-import: env.abort`. */
export async function checkDecoderPackage(packageBytes) {
    packageLoader ??= importEngineModule(PACKAGE_LOADER_ENTRY);
    const { loadDecoderPackage } = await packageLoader;
    return loadDecoderPackage(packageBytes.slice().buffer);
}
