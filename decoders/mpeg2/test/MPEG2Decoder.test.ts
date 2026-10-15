import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluatePassExpression } from 'webgpu-player/presentation/passes/PassExpression';
import type { PassExpression } from 'webgpu-player/presentation/passes/PassTypes';
import { BYTES_PER_WORD, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE } from 'webgpu-player/presentation/WebGPUConstants';
import { getGPUDecoderFormatFacts, type GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import {
    GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH,
    GPU_DECODER_ERROR_CODE_SHIFT,
    GPU_DECODER_MAXIMUM_DISPATCHES
} from 'webgpu-player/decode/video/gpu/GPUDecodeLimits';
import {
    describeGPUDecoderErrorWord,
    evaluateGPUDecoderByteLength,
    getGPUDecoderFacts,
    GPU_DECODER_STREAM_FACTS,
    parseGPUDecoderManifest
} from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';
import { createGPUDecoderBindGroupLayoutEntries, createGPUDecoderModule } from 'webgpu-player/decode/video/gpu/GPUDecoderPrelude';
import type { GPUDecoderBuffer, GPUDecoderDispatch, GPUDecoderManifest } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';
import { getGPUDecoderVectorFormats } from 'webgpu-player/decode/video/gpu/GPUDecoderVerification';

import { loadDecoderProjectVideoPackage, readDecoderProjectSource } from '../../../test/helpers/decoderPackages';
import { DECODERS_DIRECTORY } from '../../../test/helpers/enginePaths';
import { installWebGPUGlobals } from '../../../test/decode/video/gpu/webGPUGlobals';

const PROJECT = 'mpeg2';
const PROJECT_FILE_NAME = 'decoder.json';
const DECODER_NAME = 'MPEG-2 Video';
// MPEG-1 too, whose syntax the decoder reads as FFmpeg's mpeg1video decoder does
const ACCEPTED_CODECS = [ 'mpeg2video', 'mpeg1video' ];
// MPEG-2's 4:2:0, 4:2:2, and 4:4:4 chroma formats, all 8-bit
const OUTPUT_FORMATS: readonly GPUDecoderOutputFormat[] = [ 'I420', 'I422', 'I444' ];
// The forward and backward anchors of a B picture
const ANCHOR_REFERENCE_COUNT = 2;
// An anchor waits for the next one; an anchor split into field packets waits one packet more, and so does a split frame's first field
const REORDER_DEPTH = 3;
const SCRATCH_BUFFER_NAMES = [ 'pictureState', 'macroblocks', 'coefficients' ];
const INDIRECT_BUFFER_NAME = 'pictureState';
const MACROBLOCKS_BUFFER_NAME = 'macroblocks';
const COEFFICIENTS_BUFFER_NAME = 'coefficients';
const PICTURE_STATE_BUFFER_NAME = 'pictureState';
// WebGPU's default storage buffers per shader stage, which the decoder's bindings must fit
const DEFAULT_STORAGE_BUFFERS_PER_STAGE = 8;
// WebGPU's default maxComputeWorkgroupsPerDimension
const MAXIMUM_WORKGROUPS_PER_DIMENSION = 65_535;
// horizontal_size and vertical_size reach 16383 with their extensions, which the pool rounds up to 64
const LARGEST_SIDE = 16_384;
const SMALLEST_POOL_SIDE = 64;
const LARGEST_STREAMS = [
    { codedHeight: LARGEST_SIDE, codedWidth: LARGEST_SIDE },
    { codedHeight: SMALLEST_POOL_SIDE, codedWidth: LARGEST_SIDE },
    { codedHeight: LARGEST_SIDE, codedWidth: SMALLEST_POOL_SIDE }
] as const;
const FULL_HD_WIDTH = 1920;
const FULL_HD_PADDED_HEIGHT = 1088;
const FULL_HD_MACROBLOCK_COLUMNS = 120;
const FULL_HD_MACROBLOCK_ROWS = 68;
const EIGHT_BIT_DEPTH = 8;
const TEN_BIT_DEPTH = 10;
const MACROBLOCK_SIZE = 16;
// A macroblock record's words, and a coefficient entry's: a word each
const MACROBLOCK_RECORD_BYTE_LENGTH = 40;
// A coefficient costs at least two bits, so a packet's bytes bound its coefficient entries
const ENTRIES_PER_PACKET_BYTE = 4;
const COEFFICIENTS_PER_BLOCK = 64;
// Blocks per macroblock: four luma blocks, and two, four, or eight chroma blocks
const LUMA_BLOCKS = 4;
const MINIMUM_BUFFER_BYTE_LENGTH = 1;
const EMPTY_STATE_BYTE_LENGTH = 0;
const LOOKUP_WORKGROUP_SIZE = 64;
const FAILING_VALUE = 1234;
const UNKNOWN_ERROR_CODE = 200;
const COEFFICIENTS_ERROR_NAME = 'coefficients';
const ENTRY_POINTS = [
    'loadLookups',
    'preparePacket',
    'countStartCodes',
    'prefixStartCodes',
    'listStartCodes',
    'parseHeaders',
    'prepareSlices',
    'allocateSlices',
    'copyFrame',
    'decodeSlices',
    'checkSlices',
    'reconstructPicture',
    'nextPicture',
    'reconstructPicture',
    'finishPacket'
];
const INDIRECT_ENTRY_POINTS = new Set([ 'countStartCodes', 'listStartCodes', 'prepareSlices', 'decodeSlices' ]);
const MACROBLOCK_GRID_ENTRY_POINTS = new Set([ 'copyFrame', 'reconstructPicture' ]);
// The body declares each error code once as `const ERROR_<NAME>: u32 = <code>u;`, beside the shift of the code in a status word
const ERROR_DECLARATION_PATTERN = /^const ERROR_([A-Z_]+): u32 = (\d+)u;$/gm;
const ERROR_CODE_SHIFT_NAME = 'CODE_SHIFT';
const WORD_SEPARATOR = '_';
const PICTURE_STATE_WORDS_PATTERN = /^const PICTURE_STATE_WORDS: u32 = (\d+)u;$/m;
const LOOKUP_WORD_COUNT_PATTERN = /^const LOOKUP_WORD_COUNT: u32 = (\d+)u;$/m;
const LOOKUP_WORDS_PATTERN = /^const LOOKUP_WORDS = array<u32, (\d+)>\(([\s\S]*?)\);$/m;
const LOOKUP_WORD_PATTERN = /0x[0-9A-F]{8}u/g;

type DecoderProjectDeclaration = {
    vectors?: ReadonlyArray<{ decoderOptions?: string[]; format: string }>
};

function createStreamFacts(width: number, height: number, bitDepth: number): ReadonlyMap<string, number> {
    return new Map([
        [ GPU_DECODER_STREAM_FACTS.width, width ],
        [ GPU_DECODER_STREAM_FACTS.height, height ],
        [ GPU_DECODER_STREAM_FACTS.bitDepth, bitDepth ]
    ]);
}

function requireConstraint(constraint: PassExpression | null): PassExpression {
    if (!constraint) {
        throw new Error('The decoder accepts every stream');
    }
    return constraint;
}

function requireDispatch(manifest: GPUDecoderManifest, entryPoint: string): GPUDecoderDispatch {
    const dispatch = manifest.dispatches.find(candidate => candidate.entryPoint === entryPoint);
    if (!dispatch) {
        throw new Error(`No dispatch of ${entryPoint}`);
    }
    return dispatch;
}

function requireBuffer(manifest: GPUDecoderManifest, name: string): GPUDecoderBuffer {
    const buffer = manifest.buffers.find(candidate => candidate.name === name);
    if (!buffer) {
        throw new Error(`No buffer ${name}`);
    }
    return buffer;
}

function requireMatch(pattern: RegExp, text: string): RegExpExecArray {
    const match = pattern.exec(text);
    if (!match) {
        throw new Error(`No match of ${pattern.source}`);
    }
    return match;
}

function evaluateCounts(dispatch: GPUDecoderDispatch, facts: ReadonlyMap<string, number>): number[] {
    return (dispatch.workgroupCounts ?? []).map(count => evaluatePassExpression(count, facts));
}

function evaluateBufferByteLength(buffer: GPUDecoderBuffer, facts: ReadonlyMap<string, number>): number {
    const result = evaluateGPUDecoderByteLength(buffer.byteLength, facts, MINIMUM_BUFFER_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE);
    if (result.kind !== 'size') {
        throw new Error(`${buffer.name}: ${result.detail}`);
    }
    return result.byteLength;
}

/** Counts a packet's dispatches with every repeat's run expanded, as the session plans them. */
function countPlannedDispatches(manifest: GPUDecoderManifest, facts: ReadonlyMap<string, number>): number {
    let dispatchCount = manifest.dispatches.length;
    for (const repeat of manifest.repeats) {
        dispatchCount += (evaluatePassExpression(repeat.count, facts) - 1) * repeat.dispatchCount;
    }
    return dispatchCount;
}

/** The blocks a macroblock of a format codes: four luma blocks and the chroma blocks of its subsampling. */
function getBlocksPerMacroblock(format: GPUDecoderOutputFormat): number {
    const formatFacts = getGPUDecoderFormatFacts(format);
    return LUMA_BLOCKS + 2 * LUMA_BLOCKS / (formatFacts.chromaWidthDivisor * formatFacts.chromaHeightDivisor);
}

/** Returns an UPPER_SNAKE_CASE name in lowerCamelCase, as the header names error codes. */
function toLowerCamelCase(name: string): string {
    return name.toLowerCase().split(WORD_SEPARATOR).map((word: string, wordIndex: number): string => (
        wordIndex === 0 ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`
    )).join('');
}

function readProjectDeclaration(): DecoderProjectDeclaration {
    return JSON.parse(readFileSync(join(DECODERS_DIRECTORY, PROJECT, PROJECT_FILE_NAME), 'utf8')) as DecoderProjectDeclaration;
}

describe('the WGSL MPEG-2 decoder', () => {
    const source = readDecoderProjectSource(PROJECT);
    const manifest = parseGPUDecoderManifest(source);

    it('parses into an 8-bit decoder of every MPEG-2 chroma format with two anchors and three frames of reordering, reading container packets', () => {
        expect(manifest.name).toBe(DECODER_NAME);
        expect(manifest.accepts.codecs).toEqual(ACCEPTED_CODECS);
        expect(manifest.outputFormats).toEqual(OUTPUT_FORMATS);
        expect(manifest.parser).toBeNull();
        expect(manifest.references).toBe(ANCHOR_REFERENCE_COUNT);
        expect(manifest.reorder).toBe(REORDER_DEPTH);
        expect(manifest.packetByteLength).toBeLessThanOrEqual(GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH);
    });

    it.each(OUTPUT_FORMATS)('composes with the prelude of %s, its body declaring every entry point it dispatches', (format: GPUDecoderOutputFormat) => {
        const decoderModule = createGPUDecoderModule(manifest, format);

        expect(decoderModule.code.endsWith(manifest.body)).toBe(true);
        expect(decoderModule.code.split('\n').slice(decoderModule.firstBodyLine - 1).join('\n')).toBe(manifest.body);
        for (const entryPoint of new Set(manifest.dispatches.map(dispatch => dispatch.entryPoint))) {
            expect(manifest.body).toMatch(new RegExp(String.raw`@compute @workgroup_size\([^)]*\)\s*fn ${entryPoint}\(`));
        }
    });

    it('accepts 8-bit streams up to the largest picture MPEG-2 codes', () => {
        const constraint = requireConstraint(manifest.accepts.constraint);
        const accepts = (width: number, height: number, bitDepth: number): number => evaluatePassExpression(
            constraint,
            createStreamFacts(width, height, bitDepth)
        );

        expect(accepts(FULL_HD_WIDTH, FULL_HD_PADDED_HEIGHT, EIGHT_BIT_DEPTH)).toBe(1);
        for (const stream of LARGEST_STREAMS) {
            expect(accepts(stream.codedWidth, stream.codedHeight, EIGHT_BIT_DEPTH)).toBe(1);
        }
        expect(accepts(LARGEST_SIDE + SMALLEST_POOL_SIDE, FULL_HD_PADDED_HEIGHT, EIGHT_BIT_DEPTH)).toBe(0);
        expect(accepts(FULL_HD_WIDTH, LARGEST_SIDE + SMALLEST_POOL_SIDE, EIGHT_BIT_DEPTH)).toBe(0);
        expect(accepts(FULL_HD_WIDTH, FULL_HD_PADDED_HEIGHT, TEN_BIT_DEPTH)).toBe(0);
    });

    it.each(OUTPUT_FORMATS.flatMap(format => LARGEST_STREAMS.map(stream => ({ format, ...stream }))))(
        'sizes its state and scratch buffers within one storage binding each for $format at $codedWidth x $codedHeight',
        ({ codedHeight, codedWidth, format }) => {
            const facts = getGPUDecoderFacts({ bitDepth: EIGHT_BIT_DEPTH, codedHeight, codedWidth }, format);

            expect(manifest.buffers.map(buffer => buffer.name)).toEqual(SCRATCH_BUFFER_NAMES);
            for (const buffer of manifest.buffers) {
                expect(evaluateGPUDecoderByteLength(buffer.byteLength, facts, MINIMUM_BUFFER_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE).kind).toBe('size');
                expect(buffer.indirect).toBe(buffer.name === INDIRECT_BUFFER_NAME);
            }
            expect(evaluateGPUDecoderByteLength(manifest.stateByteLength, facts, EMPTY_STATE_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE).kind).toBe('size');
        }
    );

    it.each(OUTPUT_FORMATS)('keeps a record for every macroblock of the pool and an entry for every coefficient of a %s packet', (format: GPUDecoderOutputFormat) => {
        const fullHD = getGPUDecoderFacts({ bitDepth: EIGHT_BIT_DEPTH, codedHeight: FULL_HD_PADDED_HEIGHT, codedWidth: FULL_HD_WIDTH }, format);
        const largest = getGPUDecoderFacts({ bitDepth: EIGHT_BIT_DEPTH, codedHeight: LARGEST_SIDE, codedWidth: LARGEST_SIDE }, format);
        const fullHDMacroblocks = FULL_HD_MACROBLOCK_COLUMNS * FULL_HD_MACROBLOCK_ROWS;
        const largestMacroblocks = (LARGEST_SIDE / MACROBLOCK_SIZE) ** 2;
        const blockEntryBytes = COEFFICIENTS_PER_BLOCK * BYTES_PER_WORD * getBlocksPerMacroblock(format);
        const packetEntryBytes = ENTRIES_PER_PACKET_BYTE * BYTES_PER_WORD * manifest.packetByteLength;

        expect(evaluateBufferByteLength(requireBuffer(manifest, MACROBLOCKS_BUFFER_NAME), fullHD)).toBe(fullHDMacroblocks * MACROBLOCK_RECORD_BYTE_LENGTH);
        expect(evaluateBufferByteLength(requireBuffer(manifest, MACROBLOCKS_BUFFER_NAME), largest)).toBe(largestMacroblocks * MACROBLOCK_RECORD_BYTE_LENGTH);
        // Every block's entries at most, or a whole packet's, whichever is smaller; no packet within the bound can overflow either
        expect(evaluateBufferByteLength(requireBuffer(manifest, COEFFICIENTS_BUFFER_NAME), fullHD)).toBe(Math.min(fullHDMacroblocks * blockEntryBytes, packetEntryBytes));
        expect(evaluateBufferByteLength(requireBuffer(manifest, COEFFICIENTS_BUFFER_NAME), largest)).toBe(Math.min(largestMacroblocks * blockEntryBytes, packetEntryBytes));
        expect(packetEntryBytes).toBeLessThanOrEqual(MAXIMUM_STORAGE_BUFFER_BINDING_SIZE);
    });

    it('sizes pictureState to the words its body lays out', () => {
        const facts = getGPUDecoderFacts({ bitDepth: EIGHT_BIT_DEPTH, codedHeight: FULL_HD_PADDED_HEIGHT, codedWidth: FULL_HD_WIDTH }, OUTPUT_FORMATS[0]);
        const words = Number(requireMatch(PICTURE_STATE_WORDS_PATTERN, manifest.body)[1]);

        expect(evaluateBufferByteLength(requireBuffer(manifest, PICTURE_STATE_BUFFER_NAME), facts)).toBe(words * BYTES_PER_WORD);
    });

    it('copies every lookup word with loadLookups', () => {
        const facts = createStreamFacts(FULL_HD_WIDTH, FULL_HD_PADDED_HEIGHT, EIGHT_BIT_DEPTH);
        const wordCount = Number(requireMatch(LOOKUP_WORD_COUNT_PATTERN, manifest.body)[1]);
        const lookupArray = requireMatch(LOOKUP_WORDS_PATTERN, manifest.body);
        const workgroups = evaluateCounts(requireDispatch(manifest, 'loadLookups'), facts)[0];

        expect(Number(lookupArray[1])).toBe(wordCount);
        expect(lookupArray[2].match(LOOKUP_WORD_PATTERN)?.length).toBe(wordCount);
        expect(workgroups * LOOKUP_WORKGROUP_SIZE).toBeGreaterThanOrEqual(wordCount);
        expect((workgroups - 1) * LOOKUP_WORKGROUP_SIZE).toBeLessThan(wordCount);
    });

    it.each(OUTPUT_FORMATS.flatMap(format => LARGEST_STREAMS.map(stream => ({ format, ...stream }))))(
        'plans at most the engine\'s dispatches per packet, each within WebGPU\'s workgroup counts, for $format at $codedWidth x $codedHeight',
        ({ codedHeight, codedWidth, format }) => {
            const facts = getGPUDecoderFacts({ bitDepth: EIGHT_BIT_DEPTH, codedHeight, codedWidth }, format);

            expect(countPlannedDispatches(manifest, facts)).toBeLessThanOrEqual(GPU_DECODER_MAXIMUM_DISPATCHES);
            for (const dispatch of manifest.dispatches) {
                for (const count of evaluateCounts(dispatch, facts)) {
                    expect(Number.isInteger(count) && count >= 0 && count <= MAXIMUM_WORKGROUPS_PER_DIMENSION).toBe(true);
                }
            }
        }
    );

    it('fits the default storage buffers of a shader stage', () => {
        const restoreGlobals = installWebGPUGlobals();
        try {
            const storageEntries = createGPUDecoderBindGroupLayoutEntries(manifest.buffers.length)
                .filter(entry => entry.buffer?.type !== 'uniform');

            expect(storageEntries.length).toBeLessThanOrEqual(DEFAULT_STORAGE_BUFFERS_PER_STAGE);
        } finally {
            restoreGlobals();
        }
    });

    it('dispatches the lookups, the start code scan, the headers, the slices, both pictures of a frame through one pipeline, and the packet\'s end in order', () => {
        expect(manifest.dispatches.map(dispatch => dispatch.entryPoint)).toEqual(ENTRY_POINTS);
        expect(manifest.repeats).toEqual([]);
        for (const dispatch of manifest.dispatches) {
            expect(dispatch.indirectBuffer).toBe(INDIRECT_ENTRY_POINTS.has(dispatch.entryPoint) ? INDIRECT_BUFFER_NAME : null);
        }
    });

    it('covers every macroblock of a 1080 stream with one workgroup each', () => {
        const facts = createStreamFacts(FULL_HD_WIDTH, FULL_HD_PADDED_HEIGHT, EIGHT_BIT_DEPTH);

        for (const dispatch of manifest.dispatches.filter(candidate => MACROBLOCK_GRID_ENTRY_POINTS.has(candidate.entryPoint))) {
            expect(evaluateCounts(dispatch, facts)).toEqual([ FULL_HD_MACROBLOCK_COLUMNS, FULL_HD_MACROBLOCK_ROWS, 1 ]);
        }
    });

    it('names in its header exactly the error codes its body declares, each within a status word\'s high byte', () => {
        const declaredErrors = new Map<number, string>();
        let codeShift: number | null = null;
        for (const [ , name, value ] of manifest.body.matchAll(ERROR_DECLARATION_PATTERN)) {
            if (name === ERROR_CODE_SHIFT_NAME) {
                codeShift = Number(value);
            } else {
                declaredErrors.set(Number(value), toLowerCamelCase(name));
            }
        }

        expect(manifest.errors).toEqual(declaredErrors);
        expect(codeShift).toBe(GPU_DECODER_ERROR_CODE_SHIFT);
    });

    it('describes a status error word by its error name and failing value', () => {
        const coefficientsCode = [ ...manifest.errors ].find(([ , name ]) => name === COEFFICIENTS_ERROR_NAME)?.[0];
        if (coefficientsCode === undefined) {
            throw new Error(`The decoder names no ${COEFFICIENTS_ERROR_NAME} error`);
        }
        const word = (coefficientsCode << GPU_DECODER_ERROR_CODE_SHIFT) | FAILING_VALUE;

        expect(describeGPUDecoderErrorWord(manifest.errors, word)).toBe(`${COEFFICIENTS_ERROR_NAME}: ${FAILING_VALUE}`);
        expect(describeGPUDecoderErrorWord(manifest.errors, (UNKNOWN_ERROR_CODE << GPU_DECODER_ERROR_CODE_SHIFT) >>> 0)).toBe(`code ${UNKNOWN_ERROR_CODE}: 0`);
    });

    it('lists one vector per output format, each decoded by FFmpeg with its simple IDCT', () => {
        const vectors = readProjectDeclaration().vectors ?? [];

        expect(vectors.map(vector => vector.format)).toEqual(OUTPUT_FORMATS);
        for (const vector of vectors) {
            expect(vector.decoderOptions).toEqual([ '-idct', 'simple' ]);
        }
    });

    it('loads as its built package, which carries a self-test vector of each format decoder.json lists', async () => {
        const decoderPackage = await loadDecoderProjectVideoPackage(PROJECT);

        expect(decoderPackage.manifest.accepts.codecs).toEqual(ACCEPTED_CODECS);
        expect(decoderPackage.manifest.body).toBe(manifest.body);
        expect(getGPUDecoderVectorFormats(decoderPackage)).toEqual((readProjectDeclaration().vectors ?? []).map(vector => vector.format));
    });
});
