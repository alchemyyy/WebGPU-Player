import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluatePassExpression } from 'webgpu-player/presentation/passes/PassExpression';
import type { PassExpression } from 'webgpu-player/presentation/passes/PassTypes';
import { MAXIMUM_STORAGE_BUFFER_BINDING_SIZE } from 'webgpu-player/presentation/WebGPUConstants';
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
    GPU_DECODER_STREAM_FACTS,
    parseGPUDecoderManifest
} from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';
import { createGPUDecoderBindGroupLayoutEntries, createGPUDecoderModule } from 'webgpu-player/decode/video/gpu/GPUDecoderPrelude';
import type { GPUDecoderDispatch, GPUDecoderErrorRecovery, GPUDecoderManifest } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';
import { getGPUDecoderVectorFormats } from 'webgpu-player/decode/video/gpu/GPUDecoderVerification';

import { loadDecoderProjectVideoPackage, readDecoderProjectSource } from '../../../test/helpers/decoderPackages';
import { DECODERS_DIRECTORY } from '../../../test/helpers/enginePaths';
import { installWebGPUGlobals } from '../../../test/decode/video/gpu/webGPUGlobals';

const PROJECT = 'vc1';
const PROJECT_FILE_NAME = 'decoder.json';
// FFmpeg's vc1 decoder decodes both codecs: vc1, the Advanced profile, and wmv3, the Simple and Main profiles
const ACCEPTED_CODECS = [ 'vc1', 'wmv3' ];
const OUTPUT_FORMAT: GPUDecoderOutputFormat = 'I420';
// Two anchors, the forward and backward references of a B picture
const ANCHOR_REFERENCE_COUNT = 2;
// The parser's events present a B picture at once and an anchor once the next anchor is planned, so one frame at most waits undecided
const ANCHOR_OUTPUT_DELAY = 1;
const SCRATCH_BUFFER_NAMES = [ 'pictureState', 'macroblocks', 'blockData' ];
// WebGPU's default storage buffers per shader stage, which the decoder's bindings must fit
const DEFAULT_STORAGE_BUFFERS_PER_STAGE = 8;
// WebGPU's default maxComputeWorkgroupsPerDimension
const MAXIMUM_WORKGROUPS_PER_DIMENSION = 65_535;
// The largest pictures the accepts condition takes: at most 4096 samples a side and 4194304 luma samples, 16384 macroblocks
const LARGEST_SIDE = 4_096;
const LARGEST_LUMA_SAMPLE_COUNT = 4_194_304;
const LARGEST_STREAMS = [
    { codedHeight: LARGEST_LUMA_SAMPLE_COUNT / LARGEST_SIDE, codedWidth: LARGEST_SIDE },
    { codedHeight: Math.sqrt(LARGEST_LUMA_SAMPLE_COUNT), codedWidth: Math.sqrt(LARGEST_LUMA_SAMPLE_COUNT) },
    { codedHeight: LARGEST_SIDE, codedWidth: LARGEST_LUMA_SAMPLE_COUNT / LARGEST_SIDE }
] as const;
const FULL_HD_WIDTH = 1920;
const FULL_HD_PADDED_HEIGHT = 1088;
const FULL_HD_MACROBLOCK_COLUMNS = 120;
const FULL_HD_MACROBLOCK_ROWS = 68;
// The interlaced frame loop filter: 16 invocations per macroblock column and 8 per macroblock row, 64 to a workgroup
const FULL_HD_FRAME_LINE_COLUMN_WORKGROUPS = 30;
const FULL_HD_FRAME_LINE_ROW_WORKGROUPS = 9;
const EIGHT_BIT_DEPTH = 8;
const TEN_BIT_DEPTH = 10;
const MINIMUM_BUFFER_BYTE_LENGTH = 1;
const EMPTY_STATE_BYTE_LENGTH = 0;
const FAILING_VALUE = 1234;
const UNKNOWN_ERROR_CODE = 200;
const MACROBLOCK_LAYER_ERROR_NAME = 'macroblockLayer';
// The picture setup from the record, the passes of a field, and the frame-only filter passes
const SETUP_ENTRY_POINTS = [ 'beginPicture', 'expandRecord', 'copyPicture' ];
const PASS_ENTRY_POINTS = [
    'reconstruct',
    'overlapVerticalEdges',
    'overlapHorizontalEdges',
    'putIntra',
    'filterHorizontalBlockEdges',
    'filterHorizontalSubblockEdges',
    'filterVerticalBlockEdges',
    'filterVerticalSubblockEdges'
];
const FRAME_LINE_ENTRY_POINTS = [ 'filterFrameHorizontalLines', 'filterFrameVerticalLines' ];
// The parse entry points the parser replaced, none of which the body may keep
const REMOVED_ENTRY_POINTS = [ 'preparePicture', 'findStartCodes', 'unescapePacket', 'decodePSlices', 'decodeX8Slices', 'predictIntraBlocks', 'loadTables0' ];
// Errors of damaged packets, after which the parser restarts at the next key packet.
// The configuration, the sequence, an unsupported feature, the record, and a size beyond the pool or the package's limit, which later pictures repeat, are fatal
const RESYNC_ERROR_NAMES = [ 'pictureHeader', 'bitplane', 'startCodes', 'macroblockLayer', 'bitsExhausted', 'pictureTooShort' ];
const RESYNC_RECOVERY: GPUDecoderErrorRecovery = 'resync';
// The body declares each error code once as `const ERROR_<NAME>: u32 = <code>u;`, beside the shift of the code in a status word
const ERROR_DECLARATION_PATTERN = /^const ERROR_([A-Z_]+): u32 = (\d+)u;$/gm;
const ERROR_CODE_SHIFT_NAME = 'CODE_SHIFT';
const WORD_SEPARATOR = '_';

type DecoderProjectDeclaration = {
    vectors?: ReadonlyArray<{ format: string }>
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

function readProjectVectorFormats(): string[] {
    const declaration = JSON.parse(readFileSync(join(DECODERS_DIRECTORY, PROJECT, PROJECT_FILE_NAME), 'utf8')) as DecoderProjectDeclaration;
    return (declaration.vectors ?? []).map(vector => vector.format);
}

function findErrorCode(manifest: GPUDecoderManifest, errorName: string): number {
    const code = [ ...manifest.errors ].find(([ , name ]) => name === errorName)?.[0];
    if (code === undefined) {
        throw new Error(`The decoder names no ${errorName} error`);
    }
    return code;
}

describe('the VC-1 decoder package', () => {
    const source = readDecoderProjectSource(PROJECT);
    const manifest = parseGPUDecoderManifest(source);

    it('parses into an 8-bit 4:2:0 decoder of VC-1 and WMV3 driven by its parser, with two anchors and one anchor of output delay', () => {
        expect(manifest.accepts.codecs).toEqual(ACCEPTED_CODECS);
        expect(manifest.outputFormats).toEqual([ OUTPUT_FORMAT ]);
        expect(manifest.parser).toBe(GPU_DECODER_PARSER_ABI_VERSION);
        expect(manifest.references).toBe(ANCHOR_REFERENCE_COUNT);
        expect(manifest.reorder).toBe(ANCHOR_OUTPUT_DELAY);
        expect(manifest.packetByteLength).toBeLessThanOrEqual(GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH);
    });

    it('composes with the prelude of its output format, its body declaring every entry point it dispatches and none of the parse stage', () => {
        const decoderModule = createGPUDecoderModule(manifest, OUTPUT_FORMAT);

        expect(decoderModule.code.endsWith(manifest.body)).toBe(true);
        expect(decoderModule.code.split('\n').slice(decoderModule.firstBodyLine - 1).join('\n')).toBe(manifest.body);
        for (const entryPoint of new Set(manifest.dispatches.map(dispatch => dispatch.entryPoint))) {
            expect(manifest.body).toMatch(new RegExp(String.raw`@compute @workgroup_size\([^)]*\)\s*fn ${entryPoint}\(`));
        }
        for (const entryPoint of REMOVED_ENTRY_POINTS) {
            expect(manifest.body).not.toMatch(new RegExp(String.raw`\bfn ${entryPoint}\(`));
        }
    });

    it('accepts 8-bit streams up to its largest picture', () => {
        const constraint = requireConstraint(manifest.accepts.constraint);
        const accepts = (width: number, height: number, bitDepth: number): number => evaluatePassExpression(
            constraint,
            createStreamFacts(width, height, bitDepth)
        );

        expect(accepts(FULL_HD_WIDTH, FULL_HD_PADDED_HEIGHT, EIGHT_BIT_DEPTH)).toBe(1);
        for (const stream of LARGEST_STREAMS) {
            expect(accepts(stream.codedWidth, stream.codedHeight, EIGHT_BIT_DEPTH)).toBe(1);
            expect(accepts(stream.codedWidth, stream.codedHeight + 1, EIGHT_BIT_DEPTH)).toBe(0);
        }
        expect(accepts(FULL_HD_WIDTH, FULL_HD_PADDED_HEIGHT, TEN_BIT_DEPTH)).toBe(0);
        expect(accepts(LARGEST_SIDE + 1, 1, EIGHT_BIT_DEPTH)).toBe(0);
    });

    it.each(LARGEST_STREAMS)(
        'sizes its state and scratch buffers within one storage binding each at the largest stream $codedWidth x $codedHeight',
        (stream) => {
            const facts = getGPUDecoderFacts({ bitDepth: EIGHT_BIT_DEPTH, ...stream }, OUTPUT_FORMAT);

            expect(manifest.buffers.map(buffer => buffer.name)).toEqual(SCRATCH_BUFFER_NAMES);
            for (const buffer of manifest.buffers) {
                expect(evaluateGPUDecoderByteLength(buffer.byteLength, facts, MINIMUM_BUFFER_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE).kind).toBe('size');
                expect(buffer.indirect).toBe(false);
            }
            expect(evaluateGPUDecoderByteLength(manifest.stateByteLength, facts, EMPTY_STATE_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE).kind).toBe('size');
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

    it('dispatches the picture setup from its record, both field passes through the same pipelines, and the picture\'s end in order, all directly', () => {
        const expected = [
            ...SETUP_ENTRY_POINTS,
            ...PASS_ENTRY_POINTS,
            ...FRAME_LINE_ENTRY_POINTS,
            'nextPass',
            ...PASS_ENTRY_POINTS,
            'finishPicture'
        ];

        expect(manifest.dispatches.map(dispatch => dispatch.entryPoint)).toEqual(expected);
        expect(manifest.dispatches.every(dispatch => dispatch.indirectBuffer === null)).toBe(true);
    });

    it('covers every macroblock and every interlaced frame line segment of a 1080p stream', () => {
        const facts = createStreamFacts(FULL_HD_WIDTH, FULL_HD_PADDED_HEIGHT, EIGHT_BIT_DEPTH);

        expect(evaluateCounts(requireDispatch(manifest, 'expandRecord'), facts)).toEqual([ FULL_HD_MACROBLOCK_COLUMNS, FULL_HD_MACROBLOCK_ROWS, 1 ]);
        expect(evaluateCounts(requireDispatch(manifest, 'reconstruct'), facts)).toEqual([ FULL_HD_MACROBLOCK_COLUMNS, FULL_HD_MACROBLOCK_ROWS, 1 ]);
        expect(evaluateCounts(requireDispatch(manifest, 'filterFrameHorizontalLines'), facts)).toEqual([ FULL_HD_FRAME_LINE_COLUMN_WORKGROUPS, 1, 1 ]);
        expect(evaluateCounts(requireDispatch(manifest, 'filterFrameVerticalLines'), facts)).toEqual([ FULL_HD_FRAME_LINE_ROW_WORKGROUPS, 1, 1 ]);
        expect(evaluateCounts(requireDispatch(manifest, 'beginPicture'), facts)).toEqual([ 1, 1, 1 ]);
        expect(evaluateCounts(requireDispatch(manifest, 'nextPass'), facts)).toEqual([ 1, 1, 1 ]);
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

        expect(decoderPackage.manifest.accepts.codecs).toEqual(ACCEPTED_CODECS);
        expect(decoderPackage.module).not.toBeNull();
        expect(getGPUDecoderVectorFormats(decoderPackage)).toEqual(readProjectVectorFormats());
    });
});
