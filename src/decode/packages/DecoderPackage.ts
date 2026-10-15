// A decoder package: one WebAssembly module file whose custom sections carry the decoder's manifest and, for a video decoder, its WGSL and optional self-test vectors.
// A video decoder's module is its CPU parser, or holds no code at all; an audio decoder's module decodes.
// A package carries no JavaScript: its module imports only the memory the engine bounds and inert system calls, so a host may load packages from anyone.
// The engine knows no package of its own: a host hands it the packages it loads.
// The engine book's decoder packages chapter describes the format.
import {
    AudioDecoderManifestError,
    parseAudioDecoderManifest,
    type AudioDecoderManifest
} from '../audio/AudioDecoderManifest';
import { findMissingAudioDecoderExports } from '../audio/AudioDecoderPackageInstance';
import { findMissingGPUDecoderParserExports } from '../video/gpu/GPUDecoderParser';
import { GPUDecoderManifestError, parseGPUDecoderManifest } from '../video/gpu/GPUDecoderManifest';
import { GPUDecoderVectorSetError, parseGPUDecoderVectorSet } from '../video/gpu/GPUDecoderVectorSet';
import type { GPUDecoderManifest } from '../video/gpu/GPUDecodeTypes';
import { readWebAssemblyBinaryFacts, WebAssemblyBinaryError } from './DecoderPackageBinary';
import DecoderPackageFormat from './DecoderPackageFormat.json';
import { readDecoderKind } from './DecoderHeader';
import type { DecoderPackageVersion } from './DecoderPackageIdentity';
import {
    boundDecoderPackageMemory,
    findForbiddenDecoderPackageImport,
    type DecoderPackageMemoryLimits
} from './DecoderPackageImports';

/** The custom sections of a decoder package, which DecoderPackageFormat.json names for the engine and its package tools alike. */
export const DECODER_PACKAGE_SECTIONS = Object.freeze({
    /** The manifest, and for a video decoder the WGSL after it, as UTF-8 text */
    decoder: DecoderPackageFormat.decoderSection,
    /** A video decoder's optional self-test vectors, which run only when a host verifies the package */
    vectors: DecoderPackageFormat.vectorsSection
});

/** The file extension of decoder packages. */
export const DECODER_PACKAGE_FILE_EXTENSION = '.wasm';

/** The check a package failed. */
export type DecoderPackageErrorCode =
    | 'package-encoding'
    | 'package-export'
    | 'package-import'
    | 'package-invalid'
    | 'package-kind'
    | 'package-manifest'
    | 'package-memory'
    | 'package-section-missing'
    | 'package-section-repeated'
    | 'package-vectors';

/** A package the engine refuses: the failed check and a terse detail with the failing value. */
export class DecoderPackageError extends Error {
    readonly code: DecoderPackageErrorCode;
    readonly detail: string;

    constructor(code: DecoderPackageErrorCode, detail: string) {
        super(`${code}: ${detail}`);
        this.name = 'DecoderPackageError';
        this.code = code;
        this.detail = detail;
    }
}

/**
 * What every package has: the id its header declares, which hosts store it by and its versions share,
 * the lowercase hexadecimal SHA-256 of its file, which tells its versions apart, its module, and its memory limits.
 */
type DecoderPackageBase = DecoderPackageVersion & Readonly<{
    /** The memory each instance of its module gets, or null for a module that imports none */
    memory: DecoderPackageMemoryLimits | null
    /** Its compiled module, which workers receive to instantiate their own instances */
    module: WebAssembly.Module
    name: string
}>;

/** A video decoder package: its WGSL manifest, its parser module if it has one, and its self-test vectors if it carries them. */
export type VideoDecoderPackage = DecoderPackageBase & Readonly<{
    kind: 'video'
    manifest: GPUDecoderManifest
    /** The vectors section, which verifyGPUDecoderPackage parses, or null when the package carries no vectors */
    vectors: ArrayBuffer | null
}>;

/** An audio decoder package: its manifest and the module that decodes. */
export type AudioDecoderPackage = DecoderPackageBase & Readonly<{
    kind: 'audio'
    manifest: AudioDecoderManifest
}>;

export type DecoderPackage = AudioDecoderPackage | VideoDecoderPackage;

const HASH_ALGORITHM = 'SHA-256';
const HEXADECIMAL_RADIX = 16;
const BYTE_HEXADECIMAL_DIGIT_COUNT = 2;
const VIDEO_KIND = 'video';
const AUDIO_KIND = 'audio';

async function computeContentHash(bytes: ArrayBuffer): Promise<string> {
    // eslint-disable-next-line compat/compat -- Packages load in secure contexts and workers, where crypto.subtle exists
    const digest = new Uint8Array(await crypto.subtle.digest(HASH_ALGORITHM, bytes));
    let hexadecimal = '';
    for (const byte of digest) {
        hexadecimal += byte.toString(HEXADECIMAL_RADIX).padStart(BYTE_HEXADECIMAL_DIGIT_COUNT, '0');
    }
    return hexadecimal;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Returns the one custom section of a name, or null when the package has none; two of one name are refused. */
function readSingleSection(module: WebAssembly.Module, name: string): ArrayBuffer | null {
    const sections = WebAssembly.Module.customSections(module, name);
    if (sections.length > 1) {
        throw new DecoderPackageError('package-section-repeated', `${name} ${sections.length} times`);
    }
    return sections[0] ?? null;
}

function decodeSource(section: ArrayBuffer): string {
    try {
        // eslint-disable-next-line compat/compat -- Decoder packages load only in WebGPU browsers, which all have TextDecoder
        return new TextDecoder('utf-8', { fatal: true }).decode(section);
    } catch (error) {
        throw new DecoderPackageError('package-encoding', describeError(error));
    }
}

function parseVideoManifest(source: string): GPUDecoderManifest {
    try {
        return parseGPUDecoderManifest(source);
    } catch (error) {
        if (error instanceof GPUDecoderManifestError) {
            throw new DecoderPackageError('package-manifest', `${error.code}: ${error.detail} (line ${error.line})`);
        }
        throw error;
    }
}

function parseAudioManifest(source: string): AudioDecoderManifest {
    try {
        return parseAudioDecoderManifest(source);
    } catch (error) {
        if (error instanceof AudioDecoderManifestError) {
            throw new DecoderPackageError('package-manifest', `${error.code}: ${error.detail} (line ${error.line})`);
        }
        throw error;
    }
}

/** Checks the imports against what packages may import, and bounds the memory the module imports. */
function requireImports(bytes: ArrayBuffer): DecoderPackageMemoryLimits | null {
    let facts;
    try {
        facts = readWebAssemblyBinaryFacts(bytes);
    } catch (error) {
        if (error instanceof WebAssemblyBinaryError) {
            throw new DecoderPackageError('package-invalid', error.message);
        }
        throw error;
    }
    const forbiddenImport = findForbiddenDecoderPackageImport(facts.imports);
    if (forbiddenImport !== null) {
        throw new DecoderPackageError('package-import', forbiddenImport);
    }
    if (facts.definesMemory) {
        throw new DecoderPackageError('package-memory', 'defines its own memory instead of importing env.memory');
    }
    if (!facts.memoryImport) {
        return null;
    }
    const bound = boundDecoderPackageMemory(facts.memoryImport);
    if (bound.kind === 'unbounded') {
        throw new DecoderPackageError('package-memory', bound.detail);
    }
    return bound.limits;
}

/** Requires a video package's parser exports and memory when its manifest declares a parser. */
function requireParser(module: WebAssembly.Module, manifest: GPUDecoderManifest, memory: DecoderPackageMemoryLimits | null): void {
    if (manifest.parser === null) {
        return;
    }
    const missingExports = findMissingGPUDecoderParserExports(module);
    if (missingExports.length > 0) {
        throw new DecoderPackageError('package-export', missingExports.join(', '));
    }
    if (!memory) {
        throw new DecoderPackageError('package-memory', 'the parser imports no env.memory');
    }
}

/** Returns a video package's vectors section, checked to be well formed and to hold vectors of formats the decoder writes only, or null when it carries none. */
function readVectors(module: WebAssembly.Module, manifest: GPUDecoderManifest): ArrayBuffer | null {
    const vectors = readSingleSection(module, DECODER_PACKAGE_SECTIONS.vectors);
    if (!vectors) {
        return null;
    }
    let parsed;
    try {
        parsed = parseGPUDecoderVectorSet(vectors);
    } catch (error) {
        if (error instanceof GPUDecoderVectorSetError) {
            throw new DecoderPackageError('package-vectors', error.message);
        }
        throw error;
    }
    for (const format of parsed.keys()) {
        if (!manifest.outputFormats.includes(format)) {
            throw new DecoderPackageError('package-vectors', `${format} is not an output format`);
        }
    }
    return vectors;
}

/**
 * Compiles and checks a decoder package file, returning its manifest, its compiled module, its header's id, and its content hash.
 * Rejects with a DecoderPackageError naming the check that failed: the module, its sections, its manifest, which holds its id, its imports, its memory, its exports, or its vectors.
 */
export async function loadDecoderPackage(bytes: ArrayBuffer): Promise<DecoderPackage> {
    let module: WebAssembly.Module;
    try {
        module = await WebAssembly.compile(bytes);
    } catch (error) {
        throw new DecoderPackageError('package-invalid', describeError(error));
    }
    const section = readSingleSection(module, DECODER_PACKAGE_SECTIONS.decoder);
    if (!section) {
        throw new DecoderPackageError('package-section-missing', DECODER_PACKAGE_SECTIONS.decoder);
    }
    const source = decodeSource(section);
    const memory = requireImports(bytes);
    const contentHash = await computeContentHash(bytes);
    const kind = readDecoderKind(source);
    switch (kind) {
        case VIDEO_KIND: {
            const manifest = parseVideoManifest(source);
            requireParser(module, manifest, memory);
            return { contentHash, id: manifest.id, kind: 'video', manifest, memory, module, name: manifest.name, vectors: readVectors(module, manifest) };
        }
        case AUDIO_KIND: {
            const manifest = parseAudioManifest(source);
            const missingExports = findMissingAudioDecoderExports(module);
            if (missingExports.length > 0) {
                throw new DecoderPackageError('package-export', missingExports.join(', '));
            }
            if (!memory) {
                throw new DecoderPackageError('package-memory', 'the decoder imports no env.memory');
            }
            if (readSingleSection(module, DECODER_PACKAGE_SECTIONS.vectors)) {
                throw new DecoderPackageError('package-vectors', 'an audio decoder carries no vectors');
            }
            return { contentHash, id: manifest.id, kind: 'audio', manifest, memory, module, name: manifest.name };
        }
        default:
            throw new DecoderPackageError('package-kind', `'${kind ?? ''}'`);
    }
}
