import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluatePassExpression } from 'webgpu-player/presentation/passes/PassExpression';
import type { PassExpression } from 'webgpu-player/presentation/passes/PassTypes';
import { BYTES_PER_WORD, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE } from 'webgpu-player/presentation/WebGPUConstants';
import { getGPUDecoderFormatFacts, GPU_DECODER_OUTPUT_FORMATS, type GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import {
    GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH,
    GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT,
    GPU_DECODER_ERROR_CODE_SHIFT,
    GPU_DECODER_PARSER_ABI_VERSION,
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

const PROJECT = 'jpeg2000';
const PROJECT_FILE_NAME = 'decoder.json';
const DECODER_NAME = 'JPEG 2000';
const ACCEPTED_CODECS = [ 'jpeg2000' ];
// Every picture is intra coded and presents as it decodes
const REFERENCE_COUNT = 0;
const REORDER_DEPTH = 0;
const SCRATCH_BUFFER_NAMES = [ 'control', 'coefficients', 'transformScratch' ];
const INDIRECT_BUFFER_NAME = 'control';
// The transforms' source and destination, each one word per sample of the picture's three planes
const COEFFICIENT_BUFFER_NAMES = [ 'coefficients', 'transformScratch' ];
// WebGPU's default storage buffers per shader stage, which the decoder's bindings must fit
const DEFAULT_STORAGE_BUFFERS_PER_STAGE = 8;
// WebGPU's default maxComputeWorkgroupsPerDimension
const MAXIMUM_WORKGROUPS_PER_DIMENSION = 65_535;
// The largest coded side and area the header accepts; the area keeps a 4:4:4 picture's coefficient words within one storage binding
const MAXIMUM_SIDE = 8192;
const MAXIMUM_PICTURE_AREA = 11_010_048;
const FULL_HD_WIDTH = 1920;
const FULL_HD_CODED_HEIGHT = 1088;
const EIGHT_BIT_DEPTH = 8;
const TWELVE_BIT_DEPTH = 12;
const MINIMUM_BUFFER_BYTE_LENGTH = 1;
const EMPTY_STATE_BYTE_LENGTH = 0;
const ENTRY_POINTS = [
    'beginPicture',
    'clearCoefficients',
    'planCodeBlocks',
    'decodeCodeBlocks',
    'planSmallLevels',
    'transformSmallLevels',
    'planHorizontal',
    'transformHorizontal',
    'planVertical',
    'transformVertical',
    'writeOutput'
];
// Each indirect pass follows the one-workgroup pass that sizes it in the control buffer
const INDIRECT_ENTRY_POINTS = new Set([ 'clearCoefficients', 'decodeCodeBlocks', 'transformSmallLevels', 'transformHorizontal', 'transformVertical' ]);
// The larger wavelet levels' passes, which repeat once per level a picture can have above RECORD_SMALL_LEVEL_SIZE samples
const REPEATED_ENTRY_POINTS = [ 'planHorizontal', 'transformHorizontal', 'planVertical', 'transformVertical' ];
// Coded sides with the larger levels a tile-component of that side can have: one per halving that leaves it above 64 samples
const LARGER_LEVEL_CASES: ReadonlyArray<readonly [number, number]> = [
    [ 64, 0 ],
    [ 128, 1 ],
    [ FULL_HD_WIDTH, 5 ],
    [ 4096, 6 ],
    [ 4160, 7 ],
    [ MAXIMUM_SIDE, 7 ]
];
// The record bounds the body shares with the parser through parser/build.rs
const RECORD_MAXIMUM_BYTE_LENGTH_PATTERN = /^const RECORD_MAXIMUM_BYTE_LENGTH: u32 = (\d+)u;$/m;
const RECORD_MAXIMUM_BIG_ITERATIONS_PATTERN = /^const RECORD_MAXIMUM_BIG_ITERATIONS: u32 = (\d+)u;$/m;
const RECORD_MAXIMUM_PICTURE_SIDE_PATTERN = /^const RECORD_MAXIMUM_PICTURE_SIDE: u32 = (\d+)u;$/m;
const RECORD_MAXIMUM_PICTURE_AREA_PATTERN = /^const RECORD_MAXIMUM_PICTURE_AREA: u32 = (\d+)u;$/m;
// The body declares each error code once as `const ERROR_<NAME>: u32 = <code>u;`, beside the shift of the code in a status word
const ERROR_DECLARATION_PATTERN = /^const ERROR_([A-Z_]+): u32 = (\d+)u;$/gm;
const ERROR_CODE_SHIFT_NAME = 'CODE_SHIFT';
const WORD_SEPARATOR = '_';
const PACKET_DATA_ERROR_NAME = 'packetData';
const FAILING_VALUE = 4321;
// The prelude's format constants, which the body must leave to the prelude
const PRELUDE_FORMAT_CONSTANT_NAMES = [ 'OUTPUT_BIT_DEPTH', 'OUTPUT_CHROMA_FORMAT', 'SAMPLE_BYTES', 'SAMPLES_PER_WORD', 'SAMPLE_MASK' ];
// Vector files name their wavelet as the generator writes them; FFmpeg decodes the 9/7 ones on its integer path under the bitexact flag
const IRREVERSIBLE_VECTOR_PATTERN = /-97-/u;
const BITEXACT_DECODER_OPTIONS = [ '-flags', 'bitexact' ];

// FFmpeg's tier-1 neighbour flags: the significance of the eight neighbours, as its context tables are indexed
const SIGNIFICANT_NORTH = 0x01;
const SIGNIFICANT_EAST = 0x02;
const SIGNIFICANT_WEST = 0x04;
const SIGNIFICANT_SOUTH = 0x08;
const SIGNIFICANT_NORTH_EAST = 0x10;
const SIGNIFICANT_NORTH_WEST = 0x20;
const SIGNIFICANT_SOUTH_EAST = 0x40;
const SIGNIFICANT_SOUTH_WEST = 0x80;
const HORIZONTAL_NEIGHBOURS = [ SIGNIFICANT_EAST, SIGNIFICANT_WEST ];
const VERTICAL_NEIGHBOURS = [ SIGNIFICANT_NORTH, SIGNIFICANT_SOUTH ];
const DIAGONAL_NEIGHBOURS = [ SIGNIFICANT_NORTH_EAST, SIGNIFICANT_NORTH_WEST, SIGNIFICANT_SOUTH_EAST, SIGNIFICANT_SOUTH_WEST ];
const NEIGHBOUR_FLAG_COUNT = 256;
// ISO/IEC 15444-1 Table D.1 for the LL, LH, and HL bands: by significant horizontal neighbours, vertical ones, and diagonal ones up to two
const SIGNIFICANCE_CONTEXTS_BY_DIRECT_COUNTS = [
    [ [ 0, 1, 2 ], [ 3, 3, 3 ], [ 4, 4, 4 ] ],
    [ [ 5, 6, 6 ], [ 7, 7, 7 ], [ 7, 7, 7 ] ],
    [ [ 8, 8, 8 ], [ 8, 8, 8 ], [ 8, 8, 8 ] ]
];
const COUNTED_DIRECT_DIAGONALS = 2;
// Table D.1 for the HH band: by significant diagonal neighbours up to three, then horizontal and vertical ones together up to two
const SIGNIFICANCE_CONTEXTS_BY_DIAGONAL_COUNTS = [ [ 0, 1, 2 ], [ 3, 4, 5 ], [ 6, 7, 7 ], [ 8, 8, 8 ] ];
const COUNTED_DIAGONALS = 3;
const COUNTED_DIRECT_NEIGHBOURS = 2;
// The sign table's index: the four direct neighbours' significance, then their signs, north, south, west, east, from bit 4
const SIGN_INDEX_SIGNIFICANCE_MASK = 0xF;
const SIGN_INDEX_SIGN_SHIFT = 4;
const NEGATIVE_NORTH = 0x1;
const NEGATIVE_SOUTH = 0x2;
const NEGATIVE_WEST = 0x4;
const NEGATIVE_EAST = 0x8;
const SIGN_INDEX_COUNT = 256;
// Bands by FFmpeg's position: LL, HL, LH, HH; HL swaps the horizontal and vertical counts, and HH weighs the diagonals first
const BAND_COUNT = 4;
const HORIZONTAL_HIGH_BAND = 1;
const DIAGONAL_BAND = 3;
const SIGNIFICANCE_CONTEXT_BITS = 4;
const SIGN_XOR_SHIFT = 4;
// ISO/IEC 15444-1 Table D.3 as FFmpeg indexes it: by each axis' neighbours, 0 insignificant, 1 negative, 2 positive
const SIGN_CONTRIBUTIONS = [ [ 0, -1, 1 ], [ -1, -1, 0 ], [ 1, 0, 1 ] ];
const SIGN_CONTEXT_LABELS = [ [ 13, 12, 11 ], [ 10, 9, 10 ], [ 11, 12, 13 ] ];
const SIGN_XOR_BITS = [ [ 1, 1, 1 ], [ 1, 0, 0 ], [ 0, 0, 0 ] ];
const INSIGNIFICANT_CONTRIBUTION = 0;
const NEGATIVE_CONTRIBUTION = 1;
const POSITIVE_CONTRIBUTION = 2;
// ISO/IEC 15444-1 Table C.2: each MQ state's Qe, its next state after an MPS and after an LPS, and whether an LPS switches the MPS
const MQ_STATE_TABLE: ReadonlyArray<readonly [number, number, number, number]> = [
    [ 0x5601, 1, 1, 1 ], [ 0x3401, 2, 6, 0 ], [ 0x1801, 3, 9, 0 ], [ 0x0AC1, 4, 12, 0 ],
    [ 0x0521, 5, 29, 0 ], [ 0x0221, 38, 33, 0 ], [ 0x5601, 7, 6, 1 ], [ 0x5401, 8, 14, 0 ],
    [ 0x4801, 9, 14, 0 ], [ 0x3801, 10, 14, 0 ], [ 0x3001, 11, 17, 0 ], [ 0x2401, 12, 18, 0 ],
    [ 0x1C01, 13, 20, 0 ], [ 0x1601, 29, 21, 0 ], [ 0x5601, 15, 14, 1 ], [ 0x5401, 16, 14, 0 ],
    [ 0x5101, 17, 15, 0 ], [ 0x4801, 18, 16, 0 ], [ 0x3801, 19, 17, 0 ], [ 0x3401, 20, 18, 0 ],
    [ 0x3001, 21, 19, 0 ], [ 0x2801, 22, 19, 0 ], [ 0x2401, 23, 20, 0 ], [ 0x2201, 24, 21, 0 ],
    [ 0x1C01, 25, 22, 0 ], [ 0x1801, 26, 23, 0 ], [ 0x1601, 27, 24, 0 ], [ 0x1401, 28, 25, 0 ],
    [ 0x1201, 29, 26, 0 ], [ 0x1101, 30, 27, 0 ], [ 0x0AC1, 31, 28, 0 ], [ 0x09C1, 32, 29, 0 ],
    [ 0x08A1, 33, 30, 0 ], [ 0x0521, 34, 31, 0 ], [ 0x0441, 35, 32, 0 ], [ 0x02A1, 36, 33, 0 ],
    [ 0x0221, 37, 34, 0 ], [ 0x0141, 38, 35, 0 ], [ 0x0111, 39, 36, 0 ], [ 0x0085, 40, 37, 0 ],
    [ 0x0049, 41, 38, 0 ], [ 0x0025, 42, 39, 0 ], [ 0x0015, 43, 40, 0 ], [ 0x0009, 44, 41, 0 ],
    [ 0x0005, 45, 42, 0 ], [ 0x0001, 45, 43, 0 ], [ 0x5601, 46, 46, 0 ]
];
// The body's MQ words, one per state and MPS at index state * 2 + MPS: Qe in the low 16 bits, then the next index after an MPS, then after an LPS
const MQ_SYMBOL_VALUES = 2;
const MQ_NEXT_MPS_SHIFT = 16;
const MQ_NEXT_LPS_SHIFT = 24;

type DecoderProjectDeclaration = {
    vectors?: ReadonlyArray<{ decoderOptions?: string[]; format: string; path: string }>
};

function createStreamFacts(width: number, height: number, bitDepth: number): ReadonlyMap<string, number> {
    return new Map([
        [ GPU_DECODER_STREAM_FACTS.width, width ],
        [ GPU_DECODER_STREAM_FACTS.height, height ],
        [ GPU_DECODER_STREAM_FACTS.bitDepth, bitDepth ]
    ]);
}

function createFormatFacts(width: number, height: number, format: GPUDecoderOutputFormat): ReadonlyMap<string, number> {
    return getGPUDecoderFacts({ bitDepth: getGPUDecoderFormatFacts(format).bitDepth, codedHeight: height, codedWidth: width }, format);
}

function requireConstraint(constraint: PassExpression | null): PassExpression {
    if (!constraint) {
        throw new Error('The decoder accepts every stream');
    }
    return constraint;
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

function evaluateBufferByteLength(buffer: GPUDecoderBuffer, facts: ReadonlyMap<string, number>): number {
    const result = evaluateGPUDecoderByteLength(buffer.byteLength, facts, MINIMUM_BUFFER_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE);
    if (result.kind !== 'size') {
        throw new Error(`${buffer.name}: ${result.detail}`);
    }
    return result.byteLength;
}

function evaluateCounts(dispatch: GPUDecoderDispatch, facts: ReadonlyMap<string, number>): number[] {
    return (dispatch.workgroupCounts ?? []).map(count => evaluatePassExpression(count, facts));
}

/** Counts a packet's dispatches with every repeat's run expanded, as the session plans them. */
function countPlannedDispatches(manifest: GPUDecoderManifest, facts: ReadonlyMap<string, number>): number {
    let dispatchCount = manifest.dispatches.length;
    for (const repeat of manifest.repeats) {
        dispatchCount += (evaluatePassExpression(repeat.count, facts) - 1) * repeat.dispatchCount;
    }
    return dispatchCount;
}

/** Returns the widest pool coded size of each pool height the decoder accepts: whole 64-sample blocks within its side and area. */
function getLargestAcceptedCodedSizes(): Array<readonly [number, number]> {
    const sizes: Array<readonly [number, number]> = [];
    for (let height = GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT; height <= MAXIMUM_SIDE; height += GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT) {
        const widestBlocks = Math.floor(MAXIMUM_PICTURE_AREA / height / GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT);
        sizes.push([ Math.min(MAXIMUM_SIDE, widestBlocks * GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT), height ]);
    }
    return sizes;
}

/** Returns an UPPER_SNAKE_CASE name in lowerCamelCase, as the header names error codes. */
function toLowerCamelCase(name: string): string {
    return name.toLowerCase().split(WORD_SEPARATOR).map((word: string, wordIndex: number): string => (
        wordIndex === 0 ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`
    )).join('');
}

/** Reads a u32 table the body declares as `const <name> = array<u32, <count>>(...)`. */
function readTable(body: string, name: string): number[] {
    const declaration = requireMatch(new RegExp(String.raw`^const ${name} = array<u32, (\d+)>\(([^)]*)\);$`, 'm'), body);
    const values = declaration[2].split(',').map((value: string): number => Number.parseInt(value.trim(), 10));
    expect(values).toHaveLength(Number(declaration[1]));
    return values;
}

function countSetFlags(flags: number, neighbours: readonly number[]): number {
    return neighbours.filter((neighbour: number): boolean => (flags & neighbour) !== 0).length;
}

/** FFmpeg's getsigctxno, Table D.1: a sample's significance context in a band from its neighbours' significance. */
function getSignificanceContext(flags: number, band: number): number {
    const horizontal = countSetFlags(flags, HORIZONTAL_NEIGHBOURS);
    const vertical = countSetFlags(flags, VERTICAL_NEIGHBOURS);
    const diagonal = countSetFlags(flags, DIAGONAL_NEIGHBOURS);
    switch (band) {
        case DIAGONAL_BAND:
            return SIGNIFICANCE_CONTEXTS_BY_DIAGONAL_COUNTS[Math.min(diagonal, COUNTED_DIAGONALS)][Math.min(horizontal + vertical, COUNTED_DIRECT_NEIGHBOURS)];
        case HORIZONTAL_HIGH_BAND:
            return SIGNIFICANCE_CONTEXTS_BY_DIRECT_COUNTS[vertical][horizontal][Math.min(diagonal, COUNTED_DIRECT_DIAGONALS)];
        default:
            return SIGNIFICANCE_CONTEXTS_BY_DIRECT_COUNTS[horizontal][vertical][Math.min(diagonal, COUNTED_DIRECT_DIAGONALS)];
    }
}

function getSignContribution(isSignificant: boolean, isNegative: boolean): number {
    if (!isSignificant) {
        return INSIGNIFICANT_CONTRIBUTION;
    }
    return isNegative ? NEGATIVE_CONTRIBUTION : POSITIVE_CONTRIBUTION;
}

/** FFmpeg's getsgnctxno, Table D.3: the sign context of a sign table index, with the bit it XORs the decision with at SIGN_XOR_SHIFT. */
function getSignContextWord(index: number): number {
    const flags = index & SIGN_INDEX_SIGNIFICANCE_MASK;
    const signs = index >> SIGN_INDEX_SIGN_SHIFT;
    const contribution = (significant: number, negative: number): number => getSignContribution((flags & significant) !== 0, (signs & negative) !== 0);
    const horizontal = SIGN_CONTRIBUTIONS[contribution(SIGNIFICANT_EAST, NEGATIVE_EAST)][contribution(SIGNIFICANT_WEST, NEGATIVE_WEST)] + 1;
    const vertical = SIGN_CONTRIBUTIONS[contribution(SIGNIFICANT_SOUTH, NEGATIVE_SOUTH)][contribution(SIGNIFICANT_NORTH, NEGATIVE_NORTH)] + 1;
    return SIGN_CONTEXT_LABELS[horizontal][vertical] | (SIGN_XOR_BITS[horizontal][vertical] << SIGN_XOR_SHIFT);
}

/** FFmpeg's MQ tables from Table C.2, one word per state and MPS. */
function getMQStateWords(): number[] {
    const words: number[] = [];
    for (const [ probability, nextAfterMPS, nextAfterLPS, switchesMPS ] of MQ_STATE_TABLE) {
        for (let mostProbableSymbol = 0; mostProbableSymbol < MQ_SYMBOL_VALUES; mostProbableSymbol += 1) {
            const nextMPSIndex = MQ_SYMBOL_VALUES * nextAfterMPS + mostProbableSymbol;
            const nextLPSIndex = MQ_SYMBOL_VALUES * nextAfterLPS + (mostProbableSymbol ^ switchesMPS);
            words.push((probability | (nextMPSIndex << MQ_NEXT_MPS_SHIFT) | (nextLPSIndex << MQ_NEXT_LPS_SHIFT)) >>> 0);
        }
    }
    return words;
}

function readProjectDeclaration(): DecoderProjectDeclaration {
    return JSON.parse(readFileSync(join(DECODERS_DIRECTORY, PROJECT, PROJECT_FILE_NAME), 'utf8')) as DecoderProjectDeclaration;
}

describe('the WGSL JPEG 2000 decoder', () => {
    const source = readDecoderProjectSource(PROJECT);
    const manifest = parseGPUDecoderManifest(source);

    it('parses into one decoder of every planar format, driven by its parser, without references or reordering', () => {
        expect(manifest.name).toBe(DECODER_NAME);
        expect(manifest.accepts.codecs).toEqual(ACCEPTED_CODECS);
        expect(manifest.outputFormats).toEqual(GPU_DECODER_OUTPUT_FORMATS);
        expect(manifest.parser).toBe(GPU_DECODER_PARSER_ABI_VERSION);
        expect(manifest.references).toBe(REFERENCE_COUNT);
        expect(manifest.reorder).toBe(REORDER_DEPTH);
    });

    it('takes packets up to the record bound its parser enforces, within the packet ring\'s bound', () => {
        const recordByteLength = Number(requireMatch(RECORD_MAXIMUM_BYTE_LENGTH_PATTERN, manifest.body)[1]);

        expect(manifest.packetByteLength).toBe(recordByteLength);
        expect(manifest.packetByteLength).toBeLessThanOrEqual(GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH);
    });

    it.each(GPU_DECODER_OUTPUT_FORMATS)('composes with the prelude of %s, its body declaring every entry point it dispatches', (format: GPUDecoderOutputFormat) => {
        const facts = getGPUDecoderFormatFacts(format);

        const decoderModule = createGPUDecoderModule(manifest, format);

        expect(decoderModule.code.endsWith(manifest.body)).toBe(true);
        expect(decoderModule.code).toContain(`const OUTPUT_BIT_DEPTH: u32 = ${facts.bitDepth}u;`);
        expect(decoderModule.code).toContain(`const SAMPLE_BYTES: u32 = ${facts.bytesPerSample}u;`);
        for (const entryPoint of new Set(manifest.dispatches.map(dispatch => dispatch.entryPoint))) {
            expect(manifest.body).toMatch(new RegExp(String.raw`@compute @workgroup_size\([^)]*\)\s*fn ${entryPoint}\(`));
        }
    });

    it('leaves the output format\'s constants to the prelude', () => {
        for (const name of PRELUDE_FORMAT_CONSTANT_NAMES) {
            expect(manifest.body).not.toMatch(new RegExp(String.raw`\bconst ${name}\b`));
        }
    });

    it('accepts streams up to 8192 samples on a side within the picture area its coefficient buffers hold', () => {
        const constraint = requireConstraint(manifest.accepts.constraint);
        const accepts = (width: number, height: number, bitDepth: number): number => evaluatePassExpression(
            constraint,
            createStreamFacts(width, height, bitDepth)
        );
        const shortSide = MAXIMUM_PICTURE_AREA / MAXIMUM_SIDE;

        expect(accepts(FULL_HD_WIDTH, FULL_HD_CODED_HEIGHT, EIGHT_BIT_DEPTH)).toBe(1);
        expect(accepts(MAXIMUM_SIDE, shortSide, TWELVE_BIT_DEPTH)).toBe(1);
        expect(accepts(shortSide, MAXIMUM_SIDE, TWELVE_BIT_DEPTH)).toBe(1);
        expect(accepts(MAXIMUM_SIDE + GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT, GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT, EIGHT_BIT_DEPTH)).toBe(0);
        expect(accepts(GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT, MAXIMUM_SIDE + GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT, EIGHT_BIT_DEPTH)).toBe(0);
        expect(accepts(MAXIMUM_SIDE, shortSide + GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT, EIGHT_BIT_DEPTH)).toBe(0);
    });

    it('fails a codestream in its parser past the same largest picture', () => {
        expect(Number(requireMatch(RECORD_MAXIMUM_PICTURE_SIDE_PATTERN, manifest.body)[1])).toBe(MAXIMUM_SIDE);
        expect(Number(requireMatch(RECORD_MAXIMUM_PICTURE_AREA_PATTERN, manifest.body)[1])).toBe(MAXIMUM_PICTURE_AREA);
    });

    it('keeps the state and every scratch buffer within one default storage binding for every format at every largest accepted size', () => {
        const constraint = requireConstraint(manifest.accepts.constraint);
        const failures: string[] = [];

        expect(manifest.buffers.map(buffer => buffer.name)).toEqual(SCRATCH_BUFFER_NAMES);
        for (const [ width, height ] of getLargestAcceptedCodedSizes()) {
            for (const format of GPU_DECODER_OUTPUT_FORMATS) {
                const facts = createFormatFacts(width, height, format);
                expect(evaluatePassExpression(constraint, facts)).toBe(1);
                const stateByteLength = evaluateGPUDecoderByteLength(manifest.stateByteLength, facts, EMPTY_STATE_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE);
                if (stateByteLength.kind === 'invalid') {
                    failures.push(`${format} ${width}x${height} state ${stateByteLength.detail}`);
                }
                for (const buffer of manifest.buffers) {
                    const byteLength = evaluateGPUDecoderByteLength(buffer.byteLength, facts, MINIMUM_BUFFER_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE);
                    if (byteLength.kind === 'invalid') {
                        failures.push(`${format} ${width}x${height} ${buffer.name} ${byteLength.detail}`);
                    }
                }
            }
        }

        expect(failures).toEqual([]);
    });

    it.each(GPU_DECODER_OUTPUT_FORMATS)('sizes both %s coefficient buffers as one word per sample of the three planes', (format: GPUDecoderOutputFormat) => {
        const formatFacts = getGPUDecoderFormatFacts(format);
        const chromaSamplesPerPlane = FULL_HD_WIDTH * FULL_HD_CODED_HEIGHT / (formatFacts.chromaWidthDivisor * formatFacts.chromaHeightDivisor);
        const facts = createFormatFacts(FULL_HD_WIDTH, FULL_HD_CODED_HEIGHT, format);

        for (const name of COEFFICIENT_BUFFER_NAMES) {
            expect(evaluateBufferByteLength(requireBuffer(manifest, name), facts)).toBe(BYTES_PER_WORD * (FULL_HD_WIDTH * FULL_HD_CODED_HEIGHT + 2 * chromaSamplesPerPlane));
        }
    });

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

    it('checks the record, decodes the code blocks, reconstructs the wavelet levels, then writes the planes, each indirect pass sized by the pass before it', () => {
        expect(manifest.dispatches.map(dispatch => dispatch.entryPoint)).toEqual(ENTRY_POINTS);
        expect(requireBuffer(manifest, INDIRECT_BUFFER_NAME).indirect).toBe(true);
        for (const dispatch of manifest.dispatches) {
            expect(dispatch.indirectBuffer).toBe(INDIRECT_ENTRY_POINTS.has(dispatch.entryPoint) ? INDIRECT_BUFFER_NAME : null);
        }
    });

    it.each(LARGER_LEVEL_CASES)('repeats the larger levels\' passes for a %i-sample side as often as such a side has levels above 64 samples, %i', (side: number, levelCount: number) => {
        expect(manifest.repeats).toHaveLength(1);
        const [ repeat ] = manifest.repeats;

        expect(manifest.dispatches.slice(repeat.firstDispatch, repeat.firstDispatch + repeat.dispatchCount).map(dispatch => dispatch.entryPoint)).toEqual(REPEATED_ENTRY_POINTS);
        expect(evaluatePassExpression(repeat.count, createStreamFacts(side, GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT, EIGHT_BIT_DEPTH))).toBe(levelCount);
        expect(evaluatePassExpression(repeat.count, createStreamFacts(GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT, side, EIGHT_BIT_DEPTH))).toBe(levelCount);
    });

    it('repeats the larger levels\' passes at the largest side exactly as often as the parser allows a picture to need them', () => {
        const [ repeat ] = manifest.repeats;
        const maximumIterations = Number(requireMatch(RECORD_MAXIMUM_BIG_ITERATIONS_PATTERN, manifest.body)[1]);

        expect(evaluatePassExpression(repeat.count, createStreamFacts(MAXIMUM_SIDE, MAXIMUM_PICTURE_AREA / MAXIMUM_SIDE, EIGHT_BIT_DEPTH))).toBe(maximumIterations);
    });

    it('plans at most the engine\'s dispatches per packet, each within WebGPU\'s workgroup counts, for every format at every largest accepted size', () => {
        const failures: string[] = [];
        for (const [ width, height ] of getLargestAcceptedCodedSizes()) {
            for (const format of GPU_DECODER_OUTPUT_FORMATS) {
                const facts = createFormatFacts(width, height, format);
                if (countPlannedDispatches(manifest, facts) > GPU_DECODER_MAXIMUM_DISPATCHES) {
                    failures.push(`${format} ${width}x${height} dispatches`);
                }
                for (const dispatch of manifest.dispatches) {
                    const counts = evaluateCounts(dispatch, facts);
                    if (!counts.every(count => Number.isInteger(count) && count >= 0 && count <= MAXIMUM_WORKGROUPS_PER_DIMENSION)) {
                        failures.push(`${format} ${width}x${height} ${dispatch.entryPoint} ${counts.join('x')}`);
                    }
                }
            }
        }

        expect(failures).toEqual([]);
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
        const packetDataCode = [ ...manifest.errors ].find(([ , name ]) => name === PACKET_DATA_ERROR_NAME)?.[0];
        if (packetDataCode === undefined) {
            throw new Error(`The decoder names no ${PACKET_DATA_ERROR_NAME} error`);
        }

        expect(describeGPUDecoderErrorWord(manifest.errors, (packetDataCode << GPU_DECODER_ERROR_CODE_SHIFT) | FAILING_VALUE)).toBe(`${PACKET_DATA_ERROR_NAME}: ${FAILING_VALUE}`);
    });

    it('declares FFmpeg\'s significance and sign context tables of Tables D.1 and D.3, and its MQ states of Table C.2', () => {
        const significanceContexts = Array.from({ length: NEIGHBOUR_FLAG_COUNT }, (_value: unknown, flags: number): number => {
            let word = 0;
            for (let band = 0; band < BAND_COUNT; band += 1) {
                word |= getSignificanceContext(flags, band) << (band * SIGNIFICANCE_CONTEXT_BITS);
            }
            return word;
        });
        const signContexts = Array.from({ length: SIGN_INDEX_COUNT }, (_value: unknown, index: number): number => getSignContextWord(index));

        expect(readTable(manifest.body, 'SIGNIFICANCE_CONTEXTS')).toEqual(significanceContexts);
        expect(readTable(manifest.body, 'SIGN_CONTEXTS')).toEqual(signContexts);
        expect(readTable(manifest.body, 'MQ_STATES')).toEqual(getMQStateWords());
    });

    it('lists one vector per output format, the 9/7 ones decoded on FFmpeg\'s integer path', () => {
        const vectors = readProjectDeclaration().vectors ?? [];

        expect(vectors.map(vector => vector.format)).toEqual(GPU_DECODER_OUTPUT_FORMATS);
        for (const vector of vectors) {
            expect(vector.decoderOptions, vector.path).toEqual(IRREVERSIBLE_VECTOR_PATTERN.test(vector.path) ? BITEXACT_DECODER_OPTIONS : undefined);
        }
    });

    it('loads as its built package, which carries a self-test vector of each format decoder.json lists', async () => {
        const decoderPackage = await loadDecoderProjectVideoPackage(PROJECT);

        expect(decoderPackage.manifest.body).toBe(manifest.body);
        expect(decoderPackage.memory).not.toBeNull();
        expect(getGPUDecoderVectorFormats(decoderPackage)).toEqual((readProjectDeclaration().vectors ?? []).map(vector => vector.format));
    });
});
