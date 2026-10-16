// Video decoder packages for tests: decoder sources, a parser module whose exports return constants, packages assembled with the engine's package tool,
// packages built in memory for code that only passes one along, and the decoder projects' sources, vectors, and built packages.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AudioDecoderModuleSource } from 'webgpu-player/decode/audio/AudioDecoderPackageInstance';
import {
    DECODER_PACKAGE_SECTIONS,
    loadDecoderPackage,
    type DecoderPackage,
    type VideoDecoderPackage
} from 'webgpu-player/decode/packages/DecoderPackage';
import { DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES } from 'webgpu-player/decode/packages/DecoderPackageImports';
import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import { GPU_DECODER_PARSER_ABI_VERSION } from 'webgpu-player/decode/video/gpu/GPUDecodeLimits';
import {
    GPU_DECODER_PARSER_EXPORTS,
    GPU_DECODER_PARSER_OPTIONAL_EXPORTS,
    GPU_DECODER_PARSER_STATUS
} from 'webgpu-player/decode/video/gpu/GPUDecoderParser';
import { parseGPUDecoderManifest } from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';
import { GPU_DECODER_MAXIMUM_REPEAT_COUNT, GPU_DECODER_PICTURE_FORMAT } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';

import { DECODER_OUTPUT_DIRECTORY, DECODERS_DIRECTORY, ENGINE_ROOT } from './enginePaths';
import {
    encodeI32Const,
    encodeI32SequenceBody,
    encodeWebAssemblyModule,
    toArrayBuffer,
    type WebAssemblyDataSegmentDefinition,
    type WebAssemblyFunctionDefinition,
    type WebAssemblyLimitsDefinition,
    type WebAssemblyMemoryImportDefinition,
    type WebAssemblyModuleDefinition
} from './webAssemblyModuleEncoder';

/** One file of a decoder's sources, by its name in the project, as the package tool joins them. */
export type DecoderSourceFile = Readonly<{ name: string, text: string }>;

/** The engine's package tool, which its package build and tools/pack-decoder-package.mjs assemble packages with. */
export type DecoderPackageFormatTool = Readonly<{
    appendCustomSection: (binary: Uint8Array, name: string, payload: Uint8Array) => Uint8Array
    assembleDecoderPackage: (moduleBinary: Uint8Array | null, decoderSource: string, vectorsSection: Uint8Array | null) => Uint8Array
    createEmptyModule: () => Uint8Array
    joinDecoderSources: (sources: readonly DecoderSourceFile[]) => string
}>;

/** A parser export, by the engine's key for it. */
export type ParserExportKey = keyof typeof GPU_DECODER_PARSER_EXPORTS;

/** What a parser stub module declares: the constant each export returns, exports it leaves out, its memory import, and data in that memory. */
export type ParserStubOptions = Readonly<{
    dataSegments?: readonly WebAssemblyDataSegmentDefinition[]
    /** Whether it imports env.memory, as the interface requires */
    importsMemory?: boolean
    omittedExports?: readonly ParserExportKey[]
    /** The picture fields word the optional `parser_picture_fields` returns; without it, the stub leaves that export out */
    pictureFields?: number
    /** Results an export returns call after call, the last one repeating, in place of its constant; they live in the stub's memory */
    resultSequences?: Partial<Readonly<Record<ParserExportKey, readonly number[]>>>
    results?: Partial<Readonly<Record<ParserExportKey, number>>>
}>;

/** What a test video decoder source declares beyond the required directives. */
export type VideoDecoderSourceOptions = Readonly<{
    /** Conditions over the stream and picture facts its accepts directive adds after the codec list, such as `picture.width <= 4096` */
    acceptsConditions?: readonly string[]
    codecs?: readonly string[]
    /** The kind its decoder directive names, video unless set; null leaves the directive out */
    decoderKind?: string | null
    /** Header lines after the required ones, such as `//! buffer:` directives */
    extraDirectives?: readonly string[]
    /** The package id its id directive declares, TEST_DECODER_ID unless set; null leaves the directive out */
    id?: string | null
    name?: string
    outputFormats?: readonly GPUDecoderOutputFormat[]
    parser?: boolean
}>;

/** The memory every package may import, by its module and field name. */
export const PACKAGE_MEMORY_IMPORT_MODULE = 'env';
export const PACKAGE_MEMORY_IMPORT_NAME = 'memory';

/** The pages a stub module's memory starts with. */
export const STUB_MODULE_MEMORY_PAGES = 1;

/** The handle a parser stub's create returns, nonzero as a live instance's is. */
export const PARSER_STUB_HANDLE = 16;

/** Where a parser stub reserves its input, inside its first page. */
export const PARSER_STUB_INPUT_POINTER = 1_024;

/** The units a parser stub's plans have. */
export const PARSER_STUB_PLAN_UNIT_COUNT = 1;

/** Where a parser stub keeps its result sequences: each a cursor word, then its results, past the areas tests write their data to. */
export const PARSER_STUB_SEQUENCE_AREA_POINTER = 32_768;

/** The entry point a test decoder source dispatches. */
export const TEST_DECODER_ENTRY_POINT = 'decodePicture';

/** The codec and output format a test decoder source takes and writes unless its options say otherwise. */
export const TEST_DECODER_CODEC = 'hevc';
export const TEST_DECODER_OUTPUT_FORMAT: GPUDecoderOutputFormat = 'I420';

/** The package id a test decoder source declares unless its options say otherwise. */
export const TEST_DECODER_ID = 'test-decoder';

const TEST_DECODER_NAME = 'Test decoder';
const VIDEO_DECODER_KIND = 'video';
const TEST_DECODER_PACKET_SIZE = '1 KiB';
// The package tool sits beside tools/constants.json, which enginePaths reads the layout from
const DECODER_PACKAGE_FORMAT_TOOL_FILE = join(ENGINE_ROOT, 'tools', 'decoder-package-format.mjs');
// A decoder project's descriptor, its vectors file, and its package, as scripts/decoder-packages.mjs names them
const DECODER_PROJECT_FILE_NAME = 'decoder.json';
const VECTORS_SECTION_EXTENSION = '.vectors';
const PACKAGE_FILE_EXTENSION = '.wasm';

// A stub's pictures report no visible size or format, its configure and pictures no largest picture, and every picture runs each repeat its header's count
const NO_PICTURE_SIZE = 0;

const PARSER_STUB_RESULTS: Readonly<Record<ParserExportKey, number>> = Object.freeze({
    abiVersion: GPU_DECODER_PARSER_ABI_VERSION,
    configure: GPU_DECODER_PARSER_STATUS.success,
    create: PARSER_STUB_HANDLE,
    decode: GPU_DECODER_PARSER_STATUS.success,
    decodeNext: GPU_DECODER_PARSER_STATUS.noPicture,
    destroy: 0,
    errorCode: 0,
    errorValue: 0,
    eventCount: 0,
    eventPointer: 0,
    finish: GPU_DECODER_PARSER_STATUS.success,
    maximumPictureHeight: NO_PICTURE_SIZE,
    maximumPictureWidth: NO_PICTURE_SIZE,
    outputByteLength: 0,
    outputPointer: 0,
    parse: GPU_DECODER_PARSER_STATUS.success,
    pictureFormat: GPU_DECODER_PICTURE_FORMAT.none,
    pictureHeight: NO_PICTURE_SIZE,
    pictureRepeatCount: GPU_DECODER_MAXIMUM_REPEAT_COUNT,
    pictureWidth: NO_PICTURE_SIZE,
    plan: GPU_DECODER_PARSER_STATUS.success,
    planNext: GPU_DECODER_PARSER_STATUS.noPicture,
    planUnitCount: PARSER_STUB_PLAN_UNIT_COUNT,
    reserveInput: PARSER_STUB_INPUT_POINTER,
    reset: 0
});

/** Returns the smallest valid video decoder source: the required directives, one dispatch, and its entry point. */
export function createVideoDecoderSource(options: VideoDecoderSourceOptions = {}): string {
    const decoderKind = options.decoderKind === undefined ? VIDEO_DECODER_KIND : options.decoderKind;
    const id = options.id === undefined ? TEST_DECODER_ID : options.id;
    const codecList = (options.codecs ?? [ TEST_DECODER_CODEC ]).join(', ');
    const acceptsConditions = [ `codec in [${codecList}]`, ...(options.acceptsConditions ?? []) ];
    const header = [
        ...(id === null ? [] : [ `//! id: ${id}` ]),
        `//! name: ${options.name ?? TEST_DECODER_NAME}`,
        ...(decoderKind === null ? [] : [ `//! decoder: ${decoderKind}` ]),
        `//! accepts: ${acceptsConditions.join(', ')}`,
        `//! output: ${(options.outputFormats ?? [ TEST_DECODER_OUTPUT_FORMAT ]).join(', ')}`,
        `//! packet: ${TEST_DECODER_PACKET_SIZE}`,
        `//! dispatch: ${TEST_DECODER_ENTRY_POINT}, 1`,
        ...(options.parser ? [ `//! parser: ${GPU_DECODER_PARSER_ABI_VERSION}` ] : []),
        ...(options.extraDirectives ?? [])
    ];
    return `${header.join('\n')}

@compute @workgroup_size(1)
fn ${TEST_DECODER_ENTRY_POINT}() {
}
`;
}

/** The import of the memory a package's module links against, with the limits it declares. */
export function createMemoryImport(limits: WebAssemblyLimitsDefinition = { initialPages: STUB_MODULE_MEMORY_PAGES }): WebAssemblyMemoryImportDefinition {
    return { kind: 'memory', limits, module: PACKAGE_MEMORY_IMPORT_MODULE, name: PACKAGE_MEMORY_IMPORT_NAME };
}

/** Returns functions that each return a constant, exported under the given names. */
export function createConstantFunctions(results: ReadonlyMap<string, number>): WebAssemblyFunctionDefinition[] {
    return [ ...results ].map(([ name, result ]: [ string, number ]): WebAssemblyFunctionDefinition => ({
        body: encodeI32Const(result),
        name,
        results: [ 'i32' ]
    }));
}

/** A result sequence's functions and the data that holds it: its cursor word, then its results. */
type ResultSequenceDefinition = Readonly<{
    dataSegments: WebAssemblyDataSegmentDefinition[]
    functions: WebAssemblyFunctionDefinition[]
}>;

/** Lays the stub's result sequences out one after another in its sequence area, each export reading its own. */
function createResultSequences(resultSequences: ParserStubOptions['resultSequences'], omittedExports: ReadonlySet<ParserExportKey>): ResultSequenceDefinition {
    const dataSegments: WebAssemblyDataSegmentDefinition[] = [];
    const functions: WebAssemblyFunctionDefinition[] = [];
    let cursorAddress = PARSER_STUB_SEQUENCE_AREA_POINTER;
    for (const [ key, sequence ] of Object.entries(resultSequences ?? {}) as Array<[ ParserExportKey, readonly number[] ]>) {
        if (omittedExports.has(key) || sequence.length === 0) {
            continue;
        }
        const firstValueAddress = cursorAddress + Uint32Array.BYTES_PER_ELEMENT;
        const lastValueAddress = firstValueAddress + (sequence.length - 1) * Uint32Array.BYTES_PER_ELEMENT;
        const words = Uint32Array.from([ firstValueAddress, ...sequence.map((result: number): number => result >>> 0) ]);
        dataSegments.push({ bytes: new Uint8Array(words.buffer), offset: cursorAddress });
        functions.push({ body: encodeI32SequenceBody(cursorAddress, lastValueAddress), name: GPU_DECODER_PARSER_EXPORTS[key], results: [ 'i32' ] });
        cursorAddress += words.byteLength;
    }
    return { dataSegments, functions };
}

/**
 * Returns the definition of a parser module of interface version 2 whose every export returns a constant, or a sequence of results, as the options set them:
 * by default a live instance that plans one-unit pictures, one per packet, and succeeds at everything with empty outputs and no events.
 */
export function createParserStubDefinition(options: ParserStubOptions = {}): WebAssemblyModuleDefinition {
    const results = { ...PARSER_STUB_RESULTS, ...options.results };
    const omittedExports = new Set<ParserExportKey>(options.omittedExports ?? []);
    const sequences = createResultSequences(options.resultSequences, omittedExports);
    const sequencedNames = new Set(sequences.functions.map((definition: WebAssemblyFunctionDefinition): string => definition.name));
    const exportedResults = new Map<string, number>();
    for (const key of Object.keys(GPU_DECODER_PARSER_EXPORTS) as ParserExportKey[]) {
        if (!omittedExports.has(key) && !sequencedNames.has(GPU_DECODER_PARSER_EXPORTS[key])) {
            exportedResults.set(GPU_DECODER_PARSER_EXPORTS[key], results[key]);
        }
    }
    if (options.pictureFields !== undefined) {
        exportedResults.set(GPU_DECODER_PARSER_OPTIONAL_EXPORTS.pictureFields, options.pictureFields);
    }
    return {
        dataSegments: [ ...(options.dataSegments ?? []), ...sequences.dataSegments ],
        functions: [ ...createConstantFunctions(exportedResults), ...sequences.functions ],
        imports: options.importsMemory === false ? [] : [ createMemoryImport() ]
    };
}

/** Returns the binary of a parser stub module. */
export function createParserStubModuleBinary(options: ParserStubOptions = {}): Uint8Array<ArrayBuffer> {
    return encodeWebAssemblyModule(createParserStubDefinition(options));
}

/** Loads the engine's package tool; it is plain JavaScript without declarations, so it is imported by URL. */
export async function loadDecoderPackageFormatTool(): Promise<DecoderPackageFormatTool> {
    return await import(/* @vite-ignore */ pathToFileURL(DECODER_PACKAGE_FORMAT_TOOL_FILE).href) as DecoderPackageFormatTool;
}

/** Assembles a package file with the engine's package tool, returning its bytes as a fetched file arrives. */
export async function assembleDecoderPackageFile(
    moduleBinary: Uint8Array | null,
    decoderSource: string,
    vectorsSection: Uint8Array | null = null
): Promise<ArrayBuffer> {
    const tool = await loadDecoderPackageFormatTool();
    return toArrayBuffer(tool.assembleDecoderPackage(moduleBinary, decoderSource, vectorsSection));
}

/** Loads package bytes and requires a video package. */
export async function loadVideoDecoderPackage(bytes: ArrayBuffer): Promise<VideoDecoderPackage> {
    const decoderPackage: DecoderPackage = await loadDecoderPackage(bytes);
    if (decoderPackage.kind !== 'video') {
        throw new Error(`Expected a video decoder package, got '${decoderPackage.kind}'`);
    }
    return decoderPackage;
}

/** Returns the file of a package built in memory: the parser stub when the source declares a parser, else a module without code, and the source. */
export function encodeVideoDecoderPackageFileForTest(source: string, hasParser: boolean): Uint8Array<ArrayBuffer> {
    return encodeWebAssemblyModule({
        ...(hasParser ? createParserStubDefinition() : {}),
        customSections: [ { name: DECODER_PACKAGE_SECTIONS.decoder, payload: new TextEncoder().encode(source) } ]
    });
}

/**
 * Returns the video decoder package that a file of the source loads as, built in memory for code that only passes a package along.
 * A source that declares a parser gets the parser stub, with its memory bounded as the loader bounds it; any other gets a module without code.
 * Its id is the one its header declares, and its content hash the SHA-256 of that file, as the loader computes it. It carries no vectors section.
 */
export function createVideoDecoderPackageForTest(source: string): VideoDecoderPackage {
    const manifest = parseGPUDecoderManifest(source);
    const hasParser = manifest.parser !== null;
    const bytes = encodeVideoDecoderPackageFileForTest(source, hasParser);
    return {
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        id: manifest.id,
        kind: 'video',
        manifest,
        memory: hasParser ? { initialPages: STUB_MODULE_MEMORY_PAGES, maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES } : null,
        module: new WebAssembly.Module(bytes),
        name: manifest.name,
        vectors: null
    };
}

/** Reads the source files a decoder project's decoder.json names, one file or a list, in the order its package joins them. */
export function readDecoderProjectSourceFiles(project: string): DecoderSourceFile[] {
    const directory = join(DECODERS_DIRECTORY, project);
    const declaration = JSON.parse(readFileSync(join(directory, DECODER_PROJECT_FILE_NAME), 'utf8')) as { decoder: string | readonly string[] };
    const fileNames: readonly string[] = typeof declaration.decoder === 'string' ? [ declaration.decoder ] : declaration.decoder;
    return fileNames.map((fileName: string): DecoderSourceFile => ({ name: fileName, text: readFileSync(join(directory, fileName), 'utf8') }));
}

/**
 * Reads the decoder source of a project whose decoder.json names one file, as the package build packs it.
 * A project of several files fails: the package tool's joinDecoderSources joins them, and esbuild, which the tool imports, refuses to load under jsdom.
 */
export function readDecoderProjectSource(project: string): string {
    const sourceFiles: DecoderSourceFile[] = readDecoderProjectSourceFiles(project);
    if (sourceFiles.length !== 1) {
        throw new Error(`${join(DECODERS_DIRECTORY, project)} has ${sourceFiles.length} source files; join readDecoderProjectSourceFiles with the package tool`);
    }
    return sourceFiles[0].text;
}

/** Returns a decoder project's video package built in memory from its source, for code that reads only its manifest or passes it along. */
export function createDecoderProjectVideoPackageForTest(project: string): VideoDecoderPackage {
    return createVideoDecoderPackageForTest(readDecoderProjectSource(project));
}

/** Reads a decoder project's vectors section, wgpud/<project>/<project>.vectors, which the package build packs as it is. */
export function readDecoderProjectVectors(project: string): ArrayBuffer {
    return toArrayBuffer(new Uint8Array(readFileSync(join(DECODERS_DIRECTORY, project, `${project}${VECTORS_SECTION_EXTENSION}`))));
}

/** Reads a decoder project's package from bin/wgpud, which `npm run decoders` builds; a missing one fails with that instruction. */
export function readDecoderProjectPackageFile(project: string): ArrayBuffer {
    const packagePath = join(DECODER_OUTPUT_DIRECTORY, `${project}${PACKAGE_FILE_EXTENSION}`);
    if (!existsSync(packagePath)) {
        throw new Error(`Missing ${packagePath}; build it with npm run decoders -- ${project}`);
    }
    return toArrayBuffer(new Uint8Array(readFileSync(packagePath)));
}

/** Loads a decoder project's built video package, such as the HEVC decoder with its Rust parser. */
export function loadDecoderProjectVideoPackage(project: string): Promise<VideoDecoderPackage> {
    return loadVideoDecoderPackage(readDecoderProjectPackageFile(project));
}

/** Loads a decoder project's built audio package as the module source an audio decoder takes. */
export async function loadDecoderProjectAudioSource(project: string): Promise<AudioDecoderModuleSource> {
    const decoderPackage: DecoderPackage = await loadDecoderPackage(readDecoderProjectPackageFile(project));
    if (decoderPackage.kind !== 'audio') {
        throw new Error(`Expected an audio decoder package, got '${decoderPackage.kind}'`);
    }
    return { manifest: decoderPackage.manifest, memory: decoderPackage.memory, module: decoderPackage.module };
}
