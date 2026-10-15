// @vitest-environment node

import { createHash } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import {
    DECODER_PACKAGE_SECTIONS,
    DecoderPackageError,
    loadDecoderPackage,
    type DecoderPackageErrorCode
} from 'webgpu-player/decode/packages/DecoderPackage';
import { DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES } from 'webgpu-player/decode/packages/DecoderPackageImports';
import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import { GPU_DECODER_PARSER_ABI_VERSION } from 'webgpu-player/decode/video/gpu/GPUDecodeLimits';
import { GPU_DECODER_PARSER_EXPORTS } from 'webgpu-player/decode/video/gpu/GPUDecoderParser';
import { parseGPUDecoderManifest } from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';
import { encodeGPUDecoderVectorSet, type GPUDecoderVector } from 'webgpu-player/decode/video/gpu/GPUDecoderVectorSet';
import { createGPUDecodeStreamFacts } from 'webgpu-player/decode/video/gpu/GPUFramePool';

import { createAudioDecoderSource, createAudioDecoderStubModuleBinary } from '../../helpers/audioDecoderPackageStubs';
import {
    createParserStubDefinition,
    createParserStubModuleBinary,
    createMemoryImport,
    createVideoDecoderPackageForTest,
    createVideoDecoderSource,
    encodeVideoDecoderPackageFileForTest,
    loadDecoderPackageFormatTool,
    STUB_MODULE_MEMORY_PAGES,
    TEST_DECODER_OUTPUT_FORMAT,
    type DecoderPackageFormatTool
} from '../../helpers/decoderPackages';
import { encodeWebAssemblyModule, toArrayBuffer, type WebAssemblyLimitsDefinition } from '../../helpers/webAssemblyModuleEncoder';

const VIDEO_DECODER_NAME = 'Planar copy';
const OTHER_VIDEO_DECODER_NAME = 'Planar copy 2';
const VIDEO_DECODER_ID = 'planar-copy';
const OTHER_VIDEO_DECODER_ID = 'planar-copy-two';
// An id the header form refuses, and the 1-based line the test sources declare their id on
const MALFORMED_VIDEO_DECODER_ID = 'Planar_Copy';
const ID_LINE = 1;
const AUDIO_DECODER_NAME = 'E-AC-3 stub';
const AUDIO_DECODER_ID = 'eac3-stub';
const AUDIO_DECODER_CODECS: readonly string[] = [ 'eac3' ];
// An audio header's missing directive check names its first line
const AUDIO_MISSING_DIRECTIVE_LINE = 1;
const HEADER_PREFIX = '//!';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
// A parser memory that declares a maximum within the engine's bound, which the package keeps
const DECLARED_MAXIMUM_PAGES = 8;
const DECLARED_MAXIMUM_MEMORY_LIMITS: WebAssemblyLimitsDefinition = { initialPages: STUB_MODULE_MEMORY_PAGES, maximumPages: DECLARED_MAXIMUM_PAGES };
// Vectors of two formats, each one 64x64 keyframe, and a format the test decoder does not write
const SECOND_VECTOR_FORMAT: GPUDecoderOutputFormat = 'I420P10';
const UNWRITTEN_VECTOR_FORMAT: GPUDecoderOutputFormat = 'I444';
const VECTOR_SHA256 = '0123456789abcdef'.repeat(4);
const VECTOR_FIRST_FRAME = 0;
const VECTOR_LAST_FRAME = 0;
const VECTOR_SIZE = 64;
const VECTOR_PACKET_BYTE_LENGTH = 24;
const VECTOR_PACKET_DURATION_MICROSECONDS = 40_000;
// A vectors section whose first word is no magic
const MALFORMED_VECTORS_SECTION_BYTE_LENGTH = 12;
const MALFORMED_VECTORS_DETAIL = 'magic 0x0';
const NOT_WEBASSEMBLY = new TextEncoder().encode('not a module');
// A lone continuation byte, which no UTF-8 text starts with
const INVALID_UTF8 = Uint8Array.of(0x80);
const ABORT_FUNCTION = 'abort';
const UNKNOWN_DECODER_KIND = 'subtitle';
// The detail of a header that names no kind at all, as a malformed header line makes it
const NO_KIND_DETAIL = '\'\'';
const MALFORMED_HEADER_LINE = '//! h264: yes';
// Two exports a parser must have, in the order the interface lists them
// Exports of both interface versions and exports version 2 added, in the order the engine lists them
const OMITTED_PARSER_EXPORTS = [ 'pictureRepeatCount', 'plan', 'planNext', 'reset' ] as const;
const SHARED_MEMORY_LIMITS: WebAssemblyLimitsDefinition = { initialPages: 1, maximumPages: DECLARED_MAXIMUM_PAGES, shared: true };
const WIDE_MEMORY_LIMITS: WebAssemblyLimitsDefinition = { initialPages: 1, wide: true };
const OVERSIZED_INITIAL_PAGES = DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES + 1;
// A video header without its output directive, whose check names the header's last line
const OUTPUTLESS_VIDEO_SOURCE = [
    `//! id: ${VIDEO_DECODER_ID}`,
    `//! name: ${VIDEO_DECODER_NAME}`,
    '//! decoder: video',
    '//! accepts: codec in [hevc]',
    '//! packet: 1 KiB',
    '//! dispatch: decodePicture, 1',
    '',
    '@compute @workgroup_size(1)',
    'fn decodePicture() {}'
].join('\n');
const OUTPUTLESS_VIDEO_SOURCE_HEADER_LAST_LINE = 6;

let tool: DecoderPackageFormatTool;

beforeAll(async () => {
    tool = await loadDecoderPackageFormatTool();
});

function assemble(moduleBinary: Uint8Array | null, source: string, vectorsSection: Uint8Array | null = null): ArrayBuffer {
    return toArrayBuffer(tool.assembleDecoderPackage(moduleBinary, source, vectorsSection));
}

/** Returns the 1-based line of a video source's last header line, which a video header's missing directive check names. */
function getHeaderLastLine(source: string): number {
    const lines = source.split('\n');
    let headerLineCount = 0;
    while (headerLineCount < lines.length && lines[headerLineCount].startsWith(HEADER_PREFIX)) {
        headerLineCount += 1;
    }
    return headerLineCount;
}

function encodeMemoryImportModule(limits: WebAssemblyLimitsDefinition): Uint8Array {
    return encodeWebAssemblyModule({ imports: [ createMemoryImport(limits) ] });
}

function createVector(format: GPUDecoderOutputFormat): GPUDecoderVector {
    return {
        codecPrivate: null,
        firstFrame: VECTOR_FIRST_FRAME,
        format,
        lastFrame: VECTOR_LAST_FRAME,
        packets: [ {
            data: new ArrayBuffer(VECTOR_PACKET_BYTE_LENGTH),
            durationMicroseconds: VECTOR_PACKET_DURATION_MICROSECONDS,
            keyframe: true,
            timestampMicroseconds: 0
        } ],
        sha256: VECTOR_SHA256,
        stream: createGPUDecodeStreamFacts(VECTOR_SIZE, VECTOR_SIZE, format)
    };
}

/** A video decoder source that writes both vector formats. */
function createVectorSource(): string {
    return createVideoDecoderSource({
        name: VIDEO_DECODER_NAME,
        outputFormats: [ TEST_DECODER_OUTPUT_FORMAT, SECOND_VECTOR_FORMAT ]
    });
}

/** Requires a load to reject with the package check that names the code, and its detail when given. */
async function expectPackageError(loading: Promise<unknown>, code: DecoderPackageErrorCode, detail?: string): Promise<void> {
    const error = await loading.then((): null => null, (reason: unknown): unknown => reason);

    expect(error).toBeInstanceOf(DecoderPackageError);
    expect(error).toMatchObject(detail === undefined ?
        { code, name: 'DecoderPackageError' } :
        { code, detail, message: `${code}: ${detail}`, name: 'DecoderPackageError' });
}

describe('loadDecoderPackage', () => {
    it('loads a video decoder without code: its manifest and module, and neither memory nor vectors', async () => {
        const source = createVideoDecoderSource({ name: VIDEO_DECODER_NAME });

        const decoderPackage = await loadDecoderPackage(assemble(null, source));

        expect(decoderPackage).toMatchObject({ kind: 'video', memory: null, name: VIDEO_DECODER_NAME, vectors: null });
        expect(decoderPackage.manifest).toEqual(parseGPUDecoderManifest(source));
        expect(decoderPackage.module).toBeInstanceOf(WebAssembly.Module);
        expect(WebAssembly.Module.customSections(decoderPackage.module, DECODER_PACKAGE_SECTIONS.decoder)).toHaveLength(1);
    });

    it('identifies a package by its header\'s id, and each version by the SHA-256 of its file', async () => {
        const bytes = assemble(null, createVideoDecoderSource({ id: VIDEO_DECODER_ID, name: VIDEO_DECODER_NAME }));

        const decoderPackage = await loadDecoderPackage(bytes);
        const reloadedPackage = await loadDecoderPackage(bytes.slice(0));
        const rebuiltPackage = await loadDecoderPackage(assemble(null, createVideoDecoderSource({ id: VIDEO_DECODER_ID, name: OTHER_VIDEO_DECODER_NAME })));
        const otherPackage = await loadDecoderPackage(assemble(null, createVideoDecoderSource({ id: OTHER_VIDEO_DECODER_ID, name: VIDEO_DECODER_NAME })));

        expect(decoderPackage.id).toBe(VIDEO_DECODER_ID);
        expect(decoderPackage.contentHash).toMatch(SHA256_PATTERN);
        expect(decoderPackage.contentHash).toBe(createHash('sha256').update(new Uint8Array(bytes)).digest('hex'));
        expect(reloadedPackage).toMatchObject({ contentHash: decoderPackage.contentHash, id: VIDEO_DECODER_ID });
        expect(rebuiltPackage.id).toBe(VIDEO_DECODER_ID);
        expect(rebuiltPackage.contentHash).not.toBe(decoderPackage.contentHash);
        expect(otherPackage.id).toBe(OTHER_VIDEO_DECODER_ID);
    });

    it('refuses a video or audio package without an id, or with a malformed one, as its manifest\'s check', async () => {
        const videoSourceWithoutId = createVideoDecoderSource({ id: null });
        const audioModule = createAudioDecoderStubModuleBinary();

        await expectPackageError(
            loadDecoderPackage(assemble(null, videoSourceWithoutId)),
            'package-manifest',
            `directive-missing: 'id' (line ${getHeaderLastLine(videoSourceWithoutId)})`
        );
        await expectPackageError(
            loadDecoderPackage(assemble(null, createVideoDecoderSource({ id: MALFORMED_VIDEO_DECODER_ID }))),
            'package-manifest',
            `id-syntax: '${MALFORMED_VIDEO_DECODER_ID}' (line ${ID_LINE})`
        );
        await expectPackageError(
            loadDecoderPackage(assemble(audioModule, createAudioDecoderSource(AUDIO_DECODER_NAME, AUDIO_DECODER_CODECS, null))),
            'package-manifest',
            `directive-missing: 'id' (line ${AUDIO_MISSING_DIRECTIVE_LINE})`
        );
        await expectPackageError(
            loadDecoderPackage(assemble(audioModule, createAudioDecoderSource(AUDIO_DECODER_NAME, AUDIO_DECODER_CODECS, MALFORMED_VIDEO_DECODER_ID))),
            'package-manifest',
            `id-syntax: '${MALFORMED_VIDEO_DECODER_ID}' (line ${ID_LINE})`
        );
    });

    it('loads a video decoder with a parser, giving its memory the engine\'s bound unless it declares a smaller one', async () => {
        const source = createVideoDecoderSource({ name: VIDEO_DECODER_NAME, parser: true });
        const boundedModule = encodeWebAssemblyModule({ ...createParserStubDefinition(), imports: [ createMemoryImport(DECLARED_MAXIMUM_MEMORY_LIMITS) ] });

        const decoderPackage = await loadDecoderPackage(assemble(createParserStubModuleBinary(), source));
        const boundedPackage = await loadDecoderPackage(assemble(boundedModule, source));

        expect(decoderPackage).toMatchObject({
            kind: 'video',
            manifest: { parser: GPU_DECODER_PARSER_ABI_VERSION },
            memory: { initialPages: STUB_MODULE_MEMORY_PAGES, maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES }
        });
        expect(boundedPackage.memory).toEqual({ initialPages: STUB_MODULE_MEMORY_PAGES, maximumPages: DECLARED_MAXIMUM_PAGES });
    });

    it('refuses a parser that lacks exports of the interface, naming each one', async () => {
        const source = createVideoDecoderSource({ parser: true });
        const missingExports = OMITTED_PARSER_EXPORTS.map(key => GPU_DECODER_PARSER_EXPORTS[key]).join(', ');

        await expectPackageError(loadDecoderPackage(assemble(createParserStubModuleBinary({ omittedExports: OMITTED_PARSER_EXPORTS }), source)), 'package-export', missingExports);
        await expectPackageError(loadDecoderPackage(assemble(null, source)), 'package-export');
    });

    it('refuses a parser that imports no memory', async () => {
        const moduleBinary = createParserStubModuleBinary({ importsMemory: false });

        await expectPackageError(
            loadDecoderPackage(assemble(moduleBinary, createVideoDecoderSource({ parser: true }))),
            'package-memory',
            'the parser imports no env.memory'
        );
    });

    it('carries a vectors section of the formats the decoder writes, which may leave formats out', async () => {
        const fullSection = encodeGPUDecoderVectorSet([ createVector(TEST_DECODER_OUTPUT_FORMAT), createVector(SECOND_VECTOR_FORMAT) ]);
        const partialSection = encodeGPUDecoderVectorSet([ createVector(SECOND_VECTOR_FORMAT) ]);

        for (const section of [ fullSection, partialSection ]) {
            const decoderPackage = await loadDecoderPackage(assemble(null, createVectorSource(), section));

            if (decoderPackage.kind !== 'video' || !decoderPackage.vectors) {
                throw new Error('Expected a video package with its vectors section');
            }
            expect(new Uint8Array(decoderPackage.vectors)).toEqual(section);
        }
    });

    it('refuses a malformed vectors section, and a vector of a format the decoder does not write', async () => {
        const unwrittenSection = encodeGPUDecoderVectorSet([ createVector(TEST_DECODER_OUTPUT_FORMAT), createVector(UNWRITTEN_VECTOR_FORMAT) ]);

        await expectPackageError(
            loadDecoderPackage(assemble(null, createVectorSource(), new Uint8Array(MALFORMED_VECTORS_SECTION_BYTE_LENGTH))),
            'package-vectors',
            MALFORMED_VECTORS_DETAIL
        );
        await expectPackageError(
            loadDecoderPackage(assemble(null, createVectorSource(), unwrittenSection)),
            'package-vectors',
            `${UNWRITTEN_VECTOR_FORMAT} is not an output format`
        );
    });

    it('refuses a file that is no WebAssembly module', async () => {
        await expectPackageError(loadDecoderPackage(toArrayBuffer(NOT_WEBASSEMBLY)), 'package-invalid');
    });

    it('refuses a module without a decoder section, or with a section it carries twice', async () => {
        const source = new TextEncoder().encode(createVideoDecoderSource());
        const twoDecoderSections = tool.appendCustomSection(tool.assembleDecoderPackage(null, createVideoDecoderSource(), null), DECODER_PACKAGE_SECTIONS.decoder, source);
        const vectorsSection = encodeGPUDecoderVectorSet([ createVector(TEST_DECODER_OUTPUT_FORMAT) ]);
        const twoVectorsSections = tool.appendCustomSection(tool.assembleDecoderPackage(null, createVideoDecoderSource(), vectorsSection), DECODER_PACKAGE_SECTIONS.vectors, vectorsSection);

        await expectPackageError(loadDecoderPackage(toArrayBuffer(tool.createEmptyModule())), 'package-section-missing', DECODER_PACKAGE_SECTIONS.decoder);
        await expectPackageError(loadDecoderPackage(toArrayBuffer(twoDecoderSections)), 'package-section-repeated', `${DECODER_PACKAGE_SECTIONS.decoder} 2 times`);
        await expectPackageError(loadDecoderPackage(toArrayBuffer(twoVectorsSections)), 'package-section-repeated', `${DECODER_PACKAGE_SECTIONS.vectors} 2 times`);
    });

    it('refuses a decoder section that is no UTF-8 text', async () => {
        const bytes = tool.appendCustomSection(tool.createEmptyModule(), DECODER_PACKAGE_SECTIONS.decoder, INVALID_UTF8);

        await expectPackageError(loadDecoderPackage(toArrayBuffer(bytes)), 'package-encoding');
    });

    it('refuses an import no package may declare', async () => {
        const moduleBinary = encodeWebAssemblyModule({ imports: [ { kind: 'function', module: 'env', name: ABORT_FUNCTION } ] });

        await expectPackageError(loadDecoderPackage(assemble(moduleBinary, createVideoDecoderSource())), 'package-import', `env.${ABORT_FUNCTION} function`);
    });

    it.each([
        { detail: 'defines its own memory instead of importing env.memory', moduleBinary: encodeWebAssemblyModule({ memory: { initialPages: 1 } }), subject: 'a memory of its own' },
        { detail: 'shared memory', moduleBinary: encodeMemoryImportModule(SHARED_MEMORY_LIMITS), subject: 'a shared memory' },
        { detail: 'memory64', moduleBinary: encodeMemoryImportModule(WIDE_MEMORY_LIMITS), subject: 'a 64-bit memory' },
        {
            detail: `${OVERSIZED_INITIAL_PAGES} initial pages > ${DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES}`,
            moduleBinary: encodeMemoryImportModule({ initialPages: OVERSIZED_INITIAL_PAGES }),
            subject: 'a memory that starts past the bound'
        }
    ])('refuses $subject, which the engine cannot bound', async ({ detail, moduleBinary }) => {
        await expectPackageError(loadDecoderPackage(assemble(moduleBinary, createVideoDecoderSource())), 'package-memory', detail);
    });

    it('refuses a header that names no kind the engine decodes', async () => {
        const malformedHeaderSource = `${MALFORMED_HEADER_LINE}\n${createVideoDecoderSource()}`;

        await expectPackageError(loadDecoderPackage(assemble(null, createVideoDecoderSource({ decoderKind: UNKNOWN_DECODER_KIND }))), 'package-kind', `'${UNKNOWN_DECODER_KIND}'`);
        await expectPackageError(loadDecoderPackage(assemble(null, createVideoDecoderSource({ decoderKind: null }))), 'package-kind', NO_KIND_DETAIL);
        await expectPackageError(loadDecoderPackage(assemble(null, malformedHeaderSource)), 'package-kind', NO_KIND_DETAIL);
    });

    it('refuses a malformed video manifest with its check and line', async () => {
        await expectPackageError(
            loadDecoderPackage(assemble(null, OUTPUTLESS_VIDEO_SOURCE)),
            'package-manifest',
            `directive-missing: 'output' (line ${OUTPUTLESS_VIDEO_SOURCE_HEADER_LAST_LINE})`
        );
    });

    it('loads an audio decoder as the audio kind, with its id, module, and bounded memory', async () => {
        const decoderPackage = await loadDecoderPackage(assemble(createAudioDecoderStubModuleBinary(), createAudioDecoderSource(AUDIO_DECODER_NAME, AUDIO_DECODER_CODECS, AUDIO_DECODER_ID)));

        expect(decoderPackage).toMatchObject({
            id: AUDIO_DECODER_ID,
            kind: 'audio',
            memory: { initialPages: STUB_MODULE_MEMORY_PAGES, maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES },
            name: AUDIO_DECODER_NAME
        });
        expect(decoderPackage.contentHash).toMatch(SHA256_PATTERN);
        expect(decoderPackage).not.toHaveProperty('vectors');
    });

    it('refuses an audio decoder without its interface or its memory, or with vectors', async () => {
        const source = createAudioDecoderSource(AUDIO_DECODER_NAME);
        const vectorsSection = encodeGPUDecoderVectorSet([ createVector(TEST_DECODER_OUTPUT_FORMAT) ]);

        await expectPackageError(loadDecoderPackage(assemble(null, source)), 'package-export');
        await expectPackageError(loadDecoderPackage(assemble(createAudioDecoderStubModuleBinary(false), source)), 'package-memory', 'the decoder imports no env.memory');
        await expectPackageError(loadDecoderPackage(assemble(createAudioDecoderStubModuleBinary(), source, vectorsSection)), 'package-vectors', 'an audio decoder carries no vectors');
    });

    it('makes of a file what the tests\' in-memory packages stand in for', async () => {
        for (const hasParser of [ false, true ]) {
            const source = createVideoDecoderSource({ name: VIDEO_DECODER_NAME, parser: hasParser });
            const inMemoryPackage = createVideoDecoderPackageForTest(source);

            const loadedPackage = await loadDecoderPackage(toArrayBuffer(encodeVideoDecoderPackageFileForTest(source, hasParser)));

            expect(loadedPackage).toMatchObject({
                contentHash: inMemoryPackage.contentHash,
                id: inMemoryPackage.id,
                kind: inMemoryPackage.kind,
                manifest: inMemoryPackage.manifest,
                memory: inMemoryPackage.memory,
                name: inMemoryPackage.name,
                vectors: inMemoryPackage.vectors
            });
        }
    });

    // Limits no one memory satisfies would otherwise load a package whose every instantiation fails to link
    it('refuses a module that imports env.memory twice', async () => {
        const moduleBinary = encodeWebAssemblyModule({ imports: [ createMemoryImport(DECLARED_MAXIMUM_MEMORY_LIMITS), createMemoryImport() ] });

        await expectPackageError(loadDecoderPackage(assemble(moduleBinary, createVideoDecoderSource())), 'package-import');
    });
});
