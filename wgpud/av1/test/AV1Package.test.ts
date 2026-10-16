// @vitest-environment node

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { VideoDecoderPackage } from 'webgpu-player/decode/packages/DecoderPackage';
import { instantiateDecoderPackage } from 'webgpu-player/decode/packages/DecoderPackageImports';
import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import { GPU_DECODER_PARSER_ABI_VERSION } from 'webgpu-player/decode/video/gpu/GPUDecodeLimits';
import { parseGPUDecoderManifest } from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';
import { parseGPUDecoderVectorSet, type GPUDecoderVector } from 'webgpu-player/decode/video/gpu/GPUDecoderVectorSet';

import {
    loadDecoderPackageFormatTool,
    loadDecoderProjectVideoPackage,
    readDecoderProjectSourceFiles,
    readDecoderProjectVectors,
    type DecoderSourceFile
} from '../../../test/helpers/decoderPackages';
import { DECODERS_DIRECTORY } from '../../../test/helpers/enginePaths';

/** The parser exports the module's own checks call, beyond the engine's version 1 set. */
type AV1ParserExports = Record<string, (...values: number[]) => number>;

/** An instance of the package's module: its exports, its parser handle, and its memory. */
type AV1ParserSession = Readonly<{ exports: AV1ParserExports; handle: number; memory: WebAssembly.Memory }>;

const PROJECT = 'av1';
// av1.wgsl, then the four GPU families in the order the package carries them
const DECODER_FILES = [ 'av1.wgsl', 'wgsl/transform.wgsl', 'wgsl/intra.wgsl', 'wgsl/inter.wgsl', 'wgsl/filters.wgsl' ];
const DECODER_NAME = 'AV1';
const OUTPUT_FORMAT_COUNT = 9;
const SOURCE_MARKER_PREFIX = '// Decoder source: ';
const LINE_BREAK = '\n';
// ERROR_ declarations of av1.wgsl that name an error code, not the error word's layout
const ERROR_CODE_DECLARATION = /^const ERROR_(?!CODE_SHIFT|VALUE_MASK)[A-Z0-9_]+: u32 = (\d+)u;$/gm;
// Sources of the join's own checks: a header file, then body files with and without a final line break
const HEADER_SOURCE: DecoderSourceFile = { name: 'first.wgsl', text: '//! name: First\n// The body\n' };
const UNTERMINATED_SOURCE: DecoderSourceFile = { name: 'second.wgsl', text: 'fn second() {}' };
const TERMINATED_SOURCE: DecoderSourceFile = { name: 'third.wgsl', text: 'fn third() {}\n' };
const LATER_HEADER_SOURCE: DecoderSourceFile = { name: 'later.wgsl', text: '// A helper\n//! name: Later\n' };
const LATER_HEADER_FAILURE = /later\.wgsl line 2 is a header line/;
// The parser interface the AV1 module implements; the engine drives it once parser-v2 lands, which enables the package checks
const AV1_PARSER_INTERFACE_VERSION: number = 2;
const ENGINE_DRIVES_AV1_PARSER = GPU_DECODER_PARSER_ABI_VERSION === AV1_PARSER_INTERFACE_VERSION;
const AV1_PARSER_WAIT_REASON = `the engine drives parser interface ${GPU_DECODER_PARSER_ABI_VERSION}, the AV1 parser implements ${AV1_PARSER_INTERFACE_VERSION}`;
// Parser call statuses of interface 2 and its output events
const STATUS_SUCCESS = 0;
const STATUS_NO_PICTURE = 1;
const STATUS_MORE_PICTURES = 3;
// A packet whose last picture finished takes no more plan_next calls
const STATUS_PACKET_DONE = STATUS_NO_PICTURE;
const EVENT_DROP_BIT = 0x8000_0000;
const EVENT_INDEX_MASK = 0x3FFF_FFFF;
const BYTES_PER_WORD = 4;
const VECTORS_FILE = join(DECODERS_DIRECTORY, PROJECT, `${PROJECT}.vectors`);

describe('The AV1 project\'s decoder sources', () => {
    it('lists av1.wgsl, then the transform, intra, inter, and filters families', () => {
        expect(readDecoderProjectSourceFiles(PROJECT).map((source: DecoderSourceFile): string => source.name)).toEqual(DECODER_FILES);
    });

    it('joins later files after a line that names each, ending an unterminated file with a line break', async () => {
        const tool = await loadDecoderPackageFormatTool();

        expect(tool.joinDecoderSources([ HEADER_SOURCE, UNTERMINATED_SOURCE, TERMINATED_SOURCE ])).toBe(
            `${HEADER_SOURCE.text}${SOURCE_MARKER_PREFIX}${UNTERMINATED_SOURCE.name}${LINE_BREAK}${UNTERMINATED_SOURCE.text}${LINE_BREAK}`
            + `${SOURCE_MARKER_PREFIX}${TERMINATED_SOURCE.name}${LINE_BREAK}${TERMINATED_SOURCE.text}`
        );
        expect(tool.joinDecoderSources([ HEADER_SOURCE ])).toBe(HEADER_SOURCE.text);
    });

    it('rejects a header line in any file but the first, and a decoder without files', async () => {
        const tool = await loadDecoderPackageFormatTool();

        expect(() => tool.joinDecoderSources([ HEADER_SOURCE, LATER_HEADER_SOURCE ])).toThrow(LATER_HEADER_FAILURE);
        expect(() => tool.joinDecoderSources([])).toThrow();
    });

    it('reads as one decoder: av1.wgsl\'s header, every dispatched entry point, and a named error for each ERROR_ code', async () => {
        const tool = await loadDecoderPackageFormatTool();
        const source = tool.joinDecoderSources(readDecoderProjectSourceFiles(PROJECT));
        const manifest = parseGPUDecoderManifest(source);
        const errorCodes = [ ...source.matchAll(ERROR_CODE_DECLARATION) ].map((match: RegExpMatchArray): number => Number(match[1]));

        expect(manifest.name).toBe(DECODER_NAME);
        expect(manifest.outputFormats).toHaveLength(OUTPUT_FORMAT_COUNT);
        expect([ ...manifest.errors.keys() ].sort((first: number, second: number): number => first - second)).toEqual(errorCodes);
    });
});

describe.skipIf(!ENGINE_DRIVES_AV1_PARSER)(`The AV1 package's parser, once ${AV1_PARSER_WAIT_REASON} no longer holds`, () => {
    it('loads with parser interface 2', async () => {
        const decoderPackage = await loadDecoderProjectVideoPackage(PROJECT);

        expect(decoderPackage.manifest.parser).toBe(AV1_PARSER_INTERFACE_VERSION);
    });

    it('plans each vector packet\'s pictures and presents every checked frame once', async () => {
        const decoderPackage = await loadDecoderProjectVideoPackage(PROJECT);
        const vectors: ReadonlyMap<GPUDecoderOutputFormat, GPUDecoderVector> = existsSync(VECTORS_FILE) ?
            parseGPUDecoderVectorSet(readDecoderProjectVectors(PROJECT)) :
            new Map<GPUDecoderOutputFormat, GPUDecoderVector>();
        for (const [ format, vector ] of vectors) {
            const session = await createParserSession(decoderPackage);
            if (vector.codecPrivate) {
                writeInput(session, vector.codecPrivate);
                expect(session.exports.parser_configure(session.handle, vector.codecPrivate.byteLength), format).toBe(STATUS_SUCCESS);
            }
            const presented = vector.packets.flatMap(packet => decodePacket(session, new Uint8Array(packet.data), format));
            session.exports.parser_destroy(session.handle);

            expect(new Set(presented).size, format).toBe(presented.length);
            expect(presented.length, format).toBeGreaterThan(vector.lastFrame);
        }
    });
});

/** Instantiates the package's module as the engine would, with a parser instance. */
async function createParserSession(decoderPackage: VideoDecoderPackage): Promise<AV1ParserSession> {
    const { instance, memory } = await instantiateDecoderPackage(decoderPackage.module, decoderPackage.memory);
    if (!memory) {
        throw new Error('The AV1 parser imports no memory');
    }
    const exports = instance.exports as unknown as AV1ParserExports;
    return { exports, handle: exports.parser_create(), memory };
}

function writeInput(session: AV1ParserSession, bytes: Uint8Array): void {
    const pointer = session.exports.parser_reserve_input(session.handle, bytes.byteLength) >>> 0;
    new Uint8Array(session.memory.buffer, pointer, bytes.byteLength).set(bytes);
}

/** Plans a packet, then finishes each of its pictures; returns the indices of the pictures it presents. */
function decodePacket(session: AV1ParserSession, bytes: Uint8Array, format: string): number[] {
    const { exports, handle, memory } = session;
    const presented: number[] = [];
    writeInput(session, bytes);
    let status = exports.parser_plan(handle, bytes.byteLength);
    while (status === STATUS_SUCCESS || status === STATUS_MORE_PICTURES) {
        expect(exports.parser_finish(handle, 0), format).toBe(STATUS_SUCCESS);
        const event = new Uint32Array(memory.buffer, exports.parser_event_pointer(handle) >>> 0, 1)[0];
        expect(exports.parser_output_byte_length(handle) % BYTES_PER_WORD, format).toBe(0);
        if ((event & EVENT_DROP_BIT) === 0) {
            presented.push(event & EVENT_INDEX_MASK);
        }
        status = status === STATUS_MORE_PICTURES ? exports.parser_plan_next(handle) : STATUS_PACKET_DONE;
    }
    return presented;
}
