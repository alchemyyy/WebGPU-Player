import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluatePassExpression } from 'webgpu-player/presentation/passes/PassExpression';
import type { PassExpression } from 'webgpu-player/presentation/passes/PassTypes';
import { BYTES_PER_WORD, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE } from 'webgpu-player/presentation/WebGPUConstants';
import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import {
    GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH,
    GPU_DECODER_ERROR_CODE_SHIFT,
    GPU_DECODER_MAXIMUM_DISPATCHES,
    GPU_DECODER_PARSER_ABI_VERSION
} from 'webgpu-player/decode/video/gpu/GPUDecodeLimits';
import {
    describeGPUDecoderErrorWord,
    evaluateGPUDecoderByteLength,
    getGPUDecoderFacts,
    GPU_DECODER_PICTURE_FACTS,
    GPU_DECODER_STREAM_FACTS,
    parseGPUDecoderManifest
} from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';
import { createGPUDecoderBindGroupLayoutEntries, createGPUDecoderModule } from 'webgpu-player/decode/video/gpu/GPUDecoderPrelude';
import type { GPUDecoderDispatch, GPUDecoderErrorRecovery, GPUDecoderManifest } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';
import { getGPUDecoderVectorFormats } from 'webgpu-player/decode/video/gpu/GPUDecoderVerification';

import { loadDecoderProjectVideoPackage, readDecoderProjectSource } from '../../../test/helpers/decoderPackages';
import { DECODERS_DIRECTORY } from '../../../test/helpers/enginePaths';
import { installWebGPUGlobals } from '../../../test/decode/video/gpu/webGPUGlobals';

const PROJECT = 'mpeg4';
const PROJECT_FILE_NAME = 'decoder.json';
const DECODER_NAME = 'MPEG-4 Part 2, H.263, and MS-MPEG4';
// The engine's names of the codecs FFmpeg's mpeg4, h263, and msmpeg4 decoders decode
const ACCEPTED_CODECS = [ 'mpeg4', 'h263', 'msmpeg4v3', 'msmpeg4v2', 'msmpeg4v1' ];
const OUTPUT_FORMAT: GPUDecoderOutputFormat = 'I420';
// Two anchors, the forward and backward references of a B picture
const ANCHOR_REFERENCE_COUNT = 2;
// The parser's events present a B picture at once and an anchor once the next anchor is planned, so one frame at most waits undecided
const ANCHOR_OUTPUT_DELAY = 1;
// The state words: the anchors' two pool slots, the picture's type, and the anchor it releases
const STATE_BYTE_LENGTH = 16;
const EMPTY_STATE_BYTE_LENGTH = 0;
// WebGPU's default storage buffers per shader stage, which the decoder's bindings must fit
const DEFAULT_STORAGE_BUFFERS_PER_STAGE = 8;
// WebGPU's default maxComputeWorkgroupsPerDimension
const MAXIMUM_WORKGROUPS_PER_DIMENSION = 65_535;
// The largest pictures the accepts condition takes: at most 4096 samples a side and 9437184 samples
const LARGEST_SIDE = 4_096;
const LARGEST_SAMPLE_COUNT = 9_437_184;
const LARGEST_STREAMS = [
    { codedHeight: LARGEST_SAMPLE_COUNT / LARGEST_SIDE, codedWidth: LARGEST_SIDE },
    { codedHeight: Math.sqrt(LARGEST_SAMPLE_COUNT), codedWidth: Math.sqrt(LARGEST_SAMPLE_COUNT) },
    { codedHeight: LARGEST_SIDE, codedWidth: LARGEST_SAMPLE_COUNT / LARGEST_SIDE }
] as const;
const MACROBLOCK_SIZE = 16;
const FULL_HD_WIDTH = 1920;
const FULL_HD_HEIGHT = 1080;
const FULL_HD_MACROBLOCK_COLUMNS = 120;
const FULL_HD_MACROBLOCK_ROWS = 68;
const EIGHT_BIT_DEPTH = 8;
const TEN_BIT_DEPTH = 10;
const FAILING_VALUE = 1234;
const UNKNOWN_ERROR_CODE = 200;
const MACROBLOCK_LAYER_ERROR_NAME = 'macroblockLayer';
// A picture's setup, its macroblocks' reconstruction, H.263's deblocking filter over all horizontal and then all vertical edges, and its end
const ENTRY_POINTS = [ 'beginPicture', 'reconstruct', 'filterHorizontalEdges', 'filterVerticalEdges', 'finishPicture' ];
const MACROBLOCK_GRID_ENTRY_POINTS = [ 'reconstruct', 'filterHorizontalEdges', 'filterVerticalEdges' ];
const SINGLE_WORKGROUP_ENTRY_POINTS = [ 'beginPicture', 'finishPicture' ];
// Errors of damaged packets, after which the parser restarts at the next key packet.
// The configuration, an unsupported feature, a size beyond the pool or the package's limit, which later pictures repeat, and the record are fatal
const RESYNC_ERROR_NAMES = [ 'sequenceHeader', 'pictureHeader', 'macroblockLayer', 'bitsExhausted' ];
const FATAL_ERROR_NAMES = [ 'configuration', 'unsupportedFeature', 'pictureSize', 'recordInvalid' ];
const RESYNC_RECOVERY: GPUDecoderErrorRecovery = 'resync';
// The body declares each error code once as `const ERROR_<NAME>: u32 = <code>u;`, beside the shift of the code in a status word
const ERROR_DECLARATION_PATTERN = /^const ERROR_([A-Z_]+): u32 = (\d+)u;$/gm;
const ERROR_CODE_SHIFT_NAME = 'CODE_SHIFT';
const WORD_SEPARATOR = '_';
// The record bounds the body shares with the parser through parser/build.rs: a record's header words, the most macroblocks it holds,
// and the most words a macroblock's record takes; each macroblock also takes a word of the offset table
const RECORD_HEADER_WORDS_PATTERN = /^const RECORD_HEADER_WORDS: u32 = (\d+)u;$/m;
const RECORD_MAXIMUM_MACROBLOCKS_PATTERN = /^const RECORD_MAXIMUM_MACROBLOCKS: u32 = (\d+)u;$/m;
const RECORD_MACROBLOCK_MAXIMUM_WORDS_PATTERN = /^const RECORD_MACROBLOCK_MAXIMUM_WORDS: u32 = (\d+)u;$/m;
const OFFSET_TABLE_WORDS_PER_MACROBLOCK = 1;

type DecoderProjectDeclaration = {
    vectors?: ReadonlyArray<{ codecPrivate?: string; decoderOptions?: string[]; format: string }>
};

/** The facts an accepts condition reads of a picture: its size, the pool's size of whole macroblocks, and the bit depth. */
function createAcceptsFacts(width: number, height: number, bitDepth: number): ReadonlyMap<string, number> {
    return new Map([
        [ GPU_DECODER_PICTURE_FACTS.width, width ],
        [ GPU_DECODER_PICTURE_FACTS.height, height ],
        [ GPU_DECODER_STREAM_FACTS.width, Math.ceil(width / MACROBLOCK_SIZE) * MACROBLOCK_SIZE ],
        [ GPU_DECODER_STREAM_FACTS.height, Math.ceil(height / MACROBLOCK_SIZE) * MACROBLOCK_SIZE ],
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

function requireBodyConstant(manifest: GPUDecoderManifest, pattern: RegExp): number {
    const match = pattern.exec(manifest.body);
    if (!match) {
        throw new Error(`No match of ${pattern.source}`);
    }
    return Number(match[1]);
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

/** Returns an UPPER_SNAKE_CASE name in lowerCamelCase, as the header names error codes. */
function toLowerCamelCase(name: string): string {
    return name.toLowerCase().split(WORD_SEPARATOR).map((word: string, wordIndex: number): string => (
        wordIndex === 0 ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`
    )).join('');
}

function findErrorCode(manifest: GPUDecoderManifest, errorName: string): number {
    const code = [ ...manifest.errors ].find(([ , name ]) => name === errorName)?.[0];
    if (code === undefined) {
        throw new Error(`The decoder names no ${errorName} error`);
    }
    return code;
}

describe('the MPEG-4 Part 2, H.263, and MS-MPEG4 decoder package', () => {
    const source = readDecoderProjectSource(PROJECT);
    const manifest = parseGPUDecoderManifest(source);

    it('parses into an 8-bit 4:2:0 decoder of the five codecs driven by its parser, with two anchors and one anchor of output delay', () => {
        expect(manifest.name).toBe(DECODER_NAME);
        expect(manifest.accepts.codecs).toEqual(ACCEPTED_CODECS);
        expect(manifest.outputFormats).toEqual([ OUTPUT_FORMAT ]);
        expect(manifest.parser).toBe(GPU_DECODER_PARSER_ABI_VERSION);
        expect(manifest.references).toBe(ANCHOR_REFERENCE_COUNT);
        expect(manifest.reorder).toBe(ANCHOR_OUTPUT_DELAY);
    });

    it('composes with the prelude of its output format, its body declaring every entry point it dispatches', () => {
        const decoderModule = createGPUDecoderModule(manifest, OUTPUT_FORMAT);

        expect(decoderModule.code.endsWith(manifest.body)).toBe(true);
        expect(decoderModule.code.split('\n').slice(decoderModule.firstBodyLine - 1).join('\n')).toBe(manifest.body);
        for (const entryPoint of new Set(manifest.dispatches.map(dispatch => dispatch.entryPoint))) {
            expect(manifest.body).toMatch(new RegExp(String.raw`@compute @workgroup_size\([^)]*\)\s*fn ${entryPoint}\(`));
        }
    });

    it('accepts 8-bit pictures up to 4096 samples a side and 9437184 samples', () => {
        const constraint = requireConstraint(manifest.accepts.constraint);
        const accepts = (width: number, height: number, bitDepth: number): number => evaluatePassExpression(
            constraint,
            createAcceptsFacts(width, height, bitDepth)
        );

        expect(accepts(FULL_HD_WIDTH, FULL_HD_HEIGHT, EIGHT_BIT_DEPTH)).toBe(1);
        for (const stream of LARGEST_STREAMS) {
            expect(accepts(stream.codedWidth, stream.codedHeight, EIGHT_BIT_DEPTH)).toBe(1);
            expect(accepts(stream.codedWidth, stream.codedHeight + 1, EIGHT_BIT_DEPTH)).toBe(0);
        }
        expect(accepts(FULL_HD_WIDTH, FULL_HD_HEIGHT, TEN_BIT_DEPTH)).toBe(0);
        expect(accepts(LARGEST_SIDE + 1, MACROBLOCK_SIZE, EIGHT_BIT_DEPTH)).toBe(0);
        expect(accepts(MACROBLOCK_SIZE, LARGEST_SIDE + 1, EIGHT_BIT_DEPTH)).toBe(0);
    });

    it('takes in one packet the record of the largest picture it accepts, within the engine\'s packet bound and one default storage binding', () => {
        const constraint = requireConstraint(manifest.accepts.constraint);
        // The most macroblocks of any accepted picture: at each width, the tallest picture the sample count allows
        let largestMacroblockCount = 0;
        for (let width = 1; width <= LARGEST_SIDE; width += 1) {
            const height = Math.min(LARGEST_SIDE, Math.floor(LARGEST_SAMPLE_COUNT / width));
            expect(evaluatePassExpression(constraint, createAcceptsFacts(width, height, EIGHT_BIT_DEPTH))).toBe(1);
            largestMacroblockCount = Math.max(largestMacroblockCount, Math.ceil(width / MACROBLOCK_SIZE) * Math.ceil(height / MACROBLOCK_SIZE));
        }
        const maximumMacroblocks = requireBodyConstant(manifest, RECORD_MAXIMUM_MACROBLOCKS_PATTERN);
        const macroblockWords = requireBodyConstant(manifest, RECORD_MACROBLOCK_MAXIMUM_WORDS_PATTERN) + OFFSET_TABLE_WORDS_PER_MACROBLOCK;
        const largestRecordByteLength = (requireBodyConstant(manifest, RECORD_HEADER_WORDS_PATTERN) + maximumMacroblocks * macroblockWords) * BYTES_PER_WORD;

        expect(largestMacroblockCount).toBeLessThanOrEqual(maximumMacroblocks);
        expect(largestRecordByteLength).toBeLessThanOrEqual(manifest.packetByteLength);
        expect(manifest.packetByteLength).toBeLessThanOrEqual(GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH);
        expect(manifest.packetByteLength).toBeLessThanOrEqual(MAXIMUM_STORAGE_BUFFER_BINDING_SIZE);
    });

    it.each(LARGEST_STREAMS)(
        'keeps its state and no scratch buffer within one storage binding at the largest stream $codedWidth x $codedHeight',
        (stream) => {
            const facts = getGPUDecoderFacts({ bitDepth: EIGHT_BIT_DEPTH, ...stream }, OUTPUT_FORMAT);

            expect(manifest.buffers).toEqual([]);
            expect(evaluateGPUDecoderByteLength(manifest.stateByteLength, facts, EMPTY_STATE_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE))
                .toEqual({ byteLength: STATE_BYTE_LENGTH, kind: 'size' });
        }
    );

    it.each(LARGEST_STREAMS)(
        'plans at most the engine\'s dispatches per packet, each within WebGPU\'s workgroup counts, at the largest stream $codedWidth x $codedHeight',
        (stream) => {
            const facts = getGPUDecoderFacts({ bitDepth: EIGHT_BIT_DEPTH, ...stream }, OUTPUT_FORMAT);

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

    it('dispatches the picture\'s setup, reconstruction, deblocking, and end in order, all directly, with no repeat', () => {
        expect(manifest.dispatches.map(dispatch => dispatch.entryPoint)).toEqual(ENTRY_POINTS);
        expect(manifest.dispatches.every(dispatch => dispatch.indirectBuffer === null)).toBe(true);
        expect(manifest.repeats).toEqual([]);
    });

    it('covers every macroblock of a 1080p stream with a workgroup each', () => {
        const facts = getGPUDecoderFacts({ bitDepth: EIGHT_BIT_DEPTH, codedHeight: FULL_HD_HEIGHT, codedWidth: FULL_HD_WIDTH }, OUTPUT_FORMAT);

        for (const entryPoint of MACROBLOCK_GRID_ENTRY_POINTS) {
            expect(evaluateCounts(requireDispatch(manifest, entryPoint), facts)).toEqual([ FULL_HD_MACROBLOCK_COLUMNS, FULL_HD_MACROBLOCK_ROWS, 1 ]);
        }
        for (const entryPoint of SINGLE_WORKGROUP_ENTRY_POINTS) {
            expect(evaluateCounts(requireDispatch(manifest, entryPoint), facts)).toEqual([ 1, 1, 1 ]);
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
        expect(new Set(manifest.errors.values())).toEqual(new Set([ ...RESYNC_ERROR_NAMES, ...FATAL_ERROR_NAMES ]));
        expect(codeShift).toBe(GPU_DECODER_ERROR_CODE_SHIFT);
    });

    it('resyncs after the errors of damaged packets and ends the attempt on the others', () => {
        const byCode = (first: number, second: number): number => first - second;
        const resyncCodes: number[] = RESYNC_ERROR_NAMES.map((name: string): number => findErrorCode(manifest, name));
        const recoveryCodes: number[] = [ ...manifest.errorRecoveries.keys() ];

        resyncCodes.sort(byCode);
        recoveryCodes.sort(byCode);
        expect(recoveryCodes).toEqual(resyncCodes);
        expect([ ...manifest.errorRecoveries.values() ].every((recovery: GPUDecoderErrorRecovery): boolean => recovery === RESYNC_RECOVERY)).toBe(true);
    });

    it('describes a status error word by its error name and failing value', () => {
        const word = (findErrorCode(manifest, MACROBLOCK_LAYER_ERROR_NAME) << GPU_DECODER_ERROR_CODE_SHIFT) | FAILING_VALUE;

        expect(describeGPUDecoderErrorWord(manifest.errors, word)).toBe(`${MACROBLOCK_LAYER_ERROR_NAME}: ${FAILING_VALUE}`);
        expect(describeGPUDecoderErrorWord(manifest.errors, (UNKNOWN_ERROR_CODE << GPU_DECODER_ERROR_CODE_SHIFT) >>> 0)).toBe(`code ${UNKNOWN_ERROR_CODE}: 0`);
    });

    it('loads as its built package, which carries a self-test vector of each format decoder.json lists', async () => {
        const decoderPackage = await loadDecoderProjectVideoPackage(PROJECT);
        const declaration = JSON.parse(readFileSync(join(DECODERS_DIRECTORY, PROJECT, PROJECT_FILE_NAME), 'utf8')) as DecoderProjectDeclaration;

        expect(decoderPackage.manifest.accepts.codecs).toEqual(ACCEPTED_CODECS);
        expect(decoderPackage.module).not.toBeNull();
        expect(getGPUDecoderVectorFormats(decoderPackage)).toEqual((declaration.vectors ?? []).map(vector => vector.format));
    });
});
