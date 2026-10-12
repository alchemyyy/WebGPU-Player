import { describe, expect, it } from 'vitest';

import { evaluatePassExpression, parsePassExpression, PassExpressionError } from 'webgpu-player/presentation/passes/PassExpression';
import type { PassExpression } from 'webgpu-player/presentation/passes/PassTypes';
import {
    INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH,
    MAXIMUM_STORAGE_BUFFER_BINDING_SIZE,
    SHADER_F16_FEATURE,
    SUBGROUPS_FEATURE
} from 'webgpu-player/presentation/WebGPUConstants';
import {
    GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH,
    GPU_DECODER_MAXIMUM_REFERENCES,
    GPU_DECODER_MAXIMUM_REORDER,
    KIBIBYTE,
    MEBIBYTE
} from 'webgpu-player/video/gpu-decode/GPUDecodeLimits';
import {
    GPU_DECODER_STREAM_FACTS,
    GPUDecoderManifestError,
    type GPUDecoderManifestErrorCode,
    parseGPUDecoderManifest
} from 'webgpu-player/video/gpu-decode/GPUDecoderManifest';

const DECODER_NAME = 'ProRes 422';
const PACKET_MEBIBYTES = 16;
const STATE_KIBIBYTES = 64;
const SLICE_DISPATCH_BYTE_LENGTH = INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH;
const COEFFICIENT_MEBIBYTES = 2;
const REFERENCES = 2;
const REORDER = 1;
const VECTOR_FILE = 'prores-422-hq.mov';
const VECTOR_FIRST_FRAME = 0;
const VECTOR_LAST_FRAME = 2;
const VECTOR_HASH = 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90';
const MAXIMUM_WIDTH = 8192;
const MAXIMUM_HEIGHT = 4320;
const UHD_WIDTH = 3840;
const UHD_HEIGHT = 2160;
const OVERSIZED_WIDTH = 10_240;
const TEN_BIT_DEPTH = 10;
const BLOCK_SIZE = 16;

// Values one past each bound, and malformed values, for the rejection table
const OVERSIZED_PACKET_MEBIBYTES = 65;
const OVERSIZED_STATE_MEBIBYTES = 129;
const EXCESS_REFERENCES = GPU_DECODER_MAXIMUM_REFERENCES + 1;
const EXCESS_REORDER = GPU_DECODER_MAXIMUM_REORDER + 1;
const SHORT_INDIRECT_BYTE_LENGTH = 8;
const SCRATCH_BYTE_LENGTH = 64;
const MALFORMED_SIZE = '4 GB';
const MALFORMED_STATE_SIZE = 'lots';
const MALFORMED_COUNT = '-1';
const MALFORMED_FEATURE = 'Shader F16';
const MALFORMED_CONDITION = 'stream.width <';
const UNKNOWN_DIRECTIVE = 'workgroup';
const AUDIO_DECODER_KIND = 'audio';
const SEMI_PLANAR_FORMAT = 'NV12';
const FOREIGN_FACT = 'output.width';
const RESERVED_BUFFER_NAME = 'state';
const SCRATCH_BUFFER_NAME = 'scratch';
const INVALID_BUFFER_NAME = '1scratch';
const MISSING_BUFFER_NAME = 'missing';
const MISSING_ENTRY_POINT = 'missingEntry';
const DUPLICATE_CODEC = 'apch';
// The 1-based position of the empty item in `codec in [apch, ]`
const EMPTY_CODEC_POSITION = 2;
const ENTRY_POINT = 'parseFrameHeader';
const BODY_ENABLE_DIRECTIVE = 'enable f16;';

const BODY = `
@compute @workgroup_size(1)
fn parseFrameHeader() {
}

@compute @workgroup_size(64)
fn decodeSlices(@builtin(global_invocation_id) id: vec3u) {
}

@compute @workgroup_size(8, 8)
fn inverseTransform(@builtin(global_invocation_id) id: vec3u) {
}`;
const COMPLETE_HEADER: readonly string[] = [
    `//! name: ${DECODER_NAME}`,
    '//! decoder: video',
    `//! accepts: codec in [apch, apcn, "raw "], stream.width <= ${MAXIMUM_WIDTH}, stream.height <= ${MAXIMUM_HEIGHT}`,
    '//! output: I422P10',
    `//! references: ${REFERENCES}`,
    `//! reorder: ${REORDER}`,
    `//! packet: ${PACKET_MEBIBYTES} MiB`,
    `//! state: ${STATE_KIBIBYTES} KiB`,
    `//! buffer: sliceDispatch, indirect, ${SLICE_DISPATCH_BYTE_LENGTH}`,
    `//! buffer: coefficients, ${COEFFICIENT_MEBIBYTES} MiB`,
    `//! requires: ${SUBGROUPS_FEATURE}, ${SHADER_F16_FEATURE}`,
    '//! dispatch: parseFrameHeader, 1',
    '//! dispatch: decodeSlices, indirect sliceDispatch',
    `//! dispatch: inverseTransform, ceil(stream.width / ${BLOCK_SIZE}), max(stream.height / ${BLOCK_SIZE}, 1)`,
    `//! vector: ${VECTOR_FILE}, frames ${VECTOR_FIRST_FRAME}-${VECTOR_LAST_FRAME}, sha256 ${VECTOR_HASH}`
];
const MINIMAL_HEADER: readonly string[] = [
    '//! name: Minimal',
    '//! decoder: video',
    '//! accepts: codec in [V_UNCOMPRESSED]',
    '//! output: I420',
    '//! packet: 4096',
    `//! dispatch: ${ENTRY_POINT}, 1`
];
// The lines of MINIMAL_HEADER's directives, and the line a directive appended to it takes
const DECODER_LINE = 2;
const ACCEPTS_LINE = 3;
const OUTPUT_LINE = 4;
const PACKET_LINE = 5;
const DISPATCH_LINE = 6;
const APPENDED_LINE = MINIMAL_HEADER.length + 1;

function createSource(header: readonly string[], body: string = BODY): string {
    return `${header.join('\n')}\n${body}`;
}

function createStreamFacts(width: number, height: number, bitDepth: number): ReadonlyMap<string, number> {
    return new Map([
        [ GPU_DECODER_STREAM_FACTS.width, width ],
        [ GPU_DECODER_STREAM_FACTS.height, height ],
        [ GPU_DECODER_STREAM_FACTS.bitDepth, bitDepth ]
    ]);
}

function replaceHeaderLine(header: readonly string[], directive: string, replacement: string): string[] {
    return header.map(line => (line.startsWith(`//! ${directive}:`) ? replacement : line));
}

function quote(text: string): string {
    return `'${text}'`;
}

/** Returns the expression parser's message for malformed text, which a manifest error detail carries after the text. */
function getExpressionErrorMessage(text: string): string {
    try {
        parsePassExpression(text);
    } catch (error) {
        if (error instanceof PassExpressionError) {
            return error.message;
        }
        throw error;
    }
    throw new Error(`'${text}' parsed`);
}

function getParseError(source: string): GPUDecoderManifestError {
    try {
        parseGPUDecoderManifest(source);
    } catch (error) {
        if (error instanceof GPUDecoderManifestError) {
            return error;
        }
        throw error;
    }
    throw new Error('The source parsed without an error');
}

/** A header the parser rejects: a description, the header lines, and the line, code, and detail of the error. */
type RejectionCase = readonly [string, readonly string[], number, GPUDecoderManifestErrorCode, string];

const REJECTION_CASES: readonly RejectionCase[] = [
    [ 'an unknown directive', [ ...MINIMAL_HEADER, `//! ${UNKNOWN_DIRECTIVE}: 64` ], APPENDED_LINE, 'directive-unknown', quote(UNKNOWN_DIRECTIVE) ],
    [ 'a repeated single directive', [ ...MINIMAL_HEADER, '//! output: I444' ], APPENDED_LINE, 'directive-repeated', quote('output') ],
    [ 'a malformed header line', [ ...MINIMAL_HEADER, '//! output I444' ], APPENDED_LINE, 'header-syntax', quote('//! output I444') ],
    [ 'an empty name', replaceHeaderLine(MINIMAL_HEADER, 'name', '//! name:'), 1, 'name-empty', quote('') ],
    [ 'an audio decoder', replaceHeaderLine(MINIMAL_HEADER, 'decoder', `//! decoder: ${AUDIO_DECODER_KIND}`), DECODER_LINE, 'decoder-kind', quote(AUDIO_DECODER_KIND) ],
    [ 'semi-planar output', replaceHeaderLine(MINIMAL_HEADER, 'output', `//! output: ${SEMI_PLANAR_FORMAT}`), OUTPUT_LINE, 'output-format', quote(SEMI_PLANAR_FORMAT) ],
    [ 'a size with an unknown unit', replaceHeaderLine(MINIMAL_HEADER, 'packet', `//! packet: ${MALFORMED_SIZE}`), PACKET_LINE, 'packet-syntax', quote(MALFORMED_SIZE) ],
    [
        'an oversized packet',
        replaceHeaderLine(MINIMAL_HEADER, 'packet', `//! packet: ${OVERSIZED_PACKET_MEBIBYTES} MiB`),
        PACKET_LINE,
        'packet-size',
        `${OVERSIZED_PACKET_MEBIBYTES * MEBIBYTE} > ${GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH}`
    ],
    [ 'an empty packet', replaceHeaderLine(MINIMAL_HEADER, 'packet', '//! packet: 0'), PACKET_LINE, 'packet-size', '0 < 1' ],
    [
        'too many references',
        [ ...MINIMAL_HEADER, `//! references: ${EXCESS_REFERENCES}` ],
        APPENDED_LINE,
        'references-limit',
        `${EXCESS_REFERENCES} > ${GPU_DECODER_MAXIMUM_REFERENCES}`
    ],
    [ 'a negative reorder depth', [ ...MINIMAL_HEADER, `//! reorder: ${MALFORMED_COUNT}` ], APPENDED_LINE, 'reorder-syntax', quote(MALFORMED_COUNT) ],
    [ 'too deep a reorder', [ ...MINIMAL_HEADER, `//! reorder: ${EXCESS_REORDER}` ], APPENDED_LINE, 'reorder-limit', `${EXCESS_REORDER} > ${GPU_DECODER_MAXIMUM_REORDER}` ],
    [ 'a malformed state size', [ ...MINIMAL_HEADER, `//! state: ${MALFORMED_STATE_SIZE}` ], APPENDED_LINE, 'state-syntax', quote(MALFORMED_STATE_SIZE) ],
    [
        'an oversized state',
        [ ...MINIMAL_HEADER, `//! state: ${OVERSIZED_STATE_MEBIBYTES} MiB` ],
        APPENDED_LINE,
        'state-size',
        `${OVERSIZED_STATE_MEBIBYTES * MEBIBYTE} > ${MAXIMUM_STORAGE_BUFFER_BINDING_SIZE}`
    ],
    [ 'accepts without a codec list', replaceHeaderLine(MINIMAL_HEADER, 'accepts', '//! accepts: stream.width <= 4096'), ACCEPTS_LINE, 'accepts-syntax', quote('stream.width <= 4096') ],
    [
        'an accepts condition on another fact',
        replaceHeaderLine(MINIMAL_HEADER, 'accepts', `//! accepts: codec in [apch], ${FOREIGN_FACT} > 0`),
        ACCEPTS_LINE,
        'accepts-identifier',
        quote(FOREIGN_FACT)
    ],
    [
        'a malformed accepts condition',
        replaceHeaderLine(MINIMAL_HEADER, 'accepts', `//! accepts: codec in [apch], ${MALFORMED_CONDITION}`),
        ACCEPTS_LINE,
        'accepts-expression',
        `${quote(MALFORMED_CONDITION)} ${getExpressionErrorMessage(MALFORMED_CONDITION)}`
    ],
    [ 'an empty codec identifier', replaceHeaderLine(MINIMAL_HEADER, 'accepts', '//! accepts: codec in [apch, ]'), ACCEPTS_LINE, 'codec-empty', `position ${EMPTY_CODEC_POSITION}` ],
    [
        'a repeated codec identifier',
        replaceHeaderLine(MINIMAL_HEADER, 'accepts', `//! accepts: codec in [${DUPLICATE_CODEC}, ${DUPLICATE_CODEC}]`),
        ACCEPTS_LINE,
        'codec-duplicate',
        quote(DUPLICATE_CODEC)
    ],
    [
        'a buffer named after a prelude binding',
        [ ...MINIMAL_HEADER, `//! buffer: ${RESERVED_BUFFER_NAME}, ${SCRATCH_BYTE_LENGTH}` ],
        APPENDED_LINE,
        'buffer-reserved',
        quote(RESERVED_BUFFER_NAME)
    ],
    [
        'a buffer name that is not an identifier',
        [ ...MINIMAL_HEADER, `//! buffer: ${INVALID_BUFFER_NAME}, ${SCRATCH_BYTE_LENGTH}` ],
        APPENDED_LINE,
        'buffer-name',
        quote(INVALID_BUFFER_NAME)
    ],
    [
        'a repeated buffer',
        [ ...MINIMAL_HEADER, `//! buffer: ${SCRATCH_BUFFER_NAME}, ${SCRATCH_BYTE_LENGTH}`, `//! buffer: ${SCRATCH_BUFFER_NAME}, ${SCRATCH_BYTE_LENGTH}` ],
        APPENDED_LINE + 1,
        'buffer-duplicate',
        quote(SCRATCH_BUFFER_NAME)
    ],
    [
        'a buffer without a size',
        [ ...MINIMAL_HEADER, `//! buffer: ${SCRATCH_BUFFER_NAME}, indirect` ],
        APPENDED_LINE,
        'buffer-syntax',
        quote(`${SCRATCH_BUFFER_NAME}, indirect`)
    ],
    [
        'a short indirect buffer',
        [ ...MINIMAL_HEADER, `//! buffer: ${SCRATCH_BUFFER_NAME}, indirect, ${SHORT_INDIRECT_BYTE_LENGTH}` ],
        APPENDED_LINE,
        'buffer-size',
        `${quote(SCRATCH_BUFFER_NAME)} ${SHORT_INDIRECT_BYTE_LENGTH} < ${INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH}`
    ],
    [ 'an empty buffer', [ ...MINIMAL_HEADER, `//! buffer: ${SCRATCH_BUFFER_NAME}, 0` ], APPENDED_LINE, 'buffer-size', `${quote(SCRATCH_BUFFER_NAME)} 0 < 1` ],
    [ 'a malformed feature', [ ...MINIMAL_HEADER, `//! requires: ${MALFORMED_FEATURE}` ], APPENDED_LINE, 'requires-syntax', quote(MALFORMED_FEATURE) ],
    [
        'a repeated feature',
        [ ...MINIMAL_HEADER, `//! requires: ${SUBGROUPS_FEATURE}, ${SUBGROUPS_FEATURE}` ],
        APPENDED_LINE,
        'requires-duplicate',
        quote(SUBGROUPS_FEATURE)
    ],
    [
        'four workgroup counts',
        replaceHeaderLine(MINIMAL_HEADER, 'dispatch', `//! dispatch: ${ENTRY_POINT}, 1, 1, 1, 1`),
        DISPATCH_LINE,
        'dispatch-syntax',
        quote(`${ENTRY_POINT}, 1, 1, 1, 1`)
    ],
    [
        'a workgroup count on another fact',
        replaceHeaderLine(MINIMAL_HEADER, 'dispatch', `//! dispatch: ${ENTRY_POINT}, ${FOREIGN_FACT}`),
        DISPATCH_LINE,
        'dispatch-identifier',
        quote(FOREIGN_FACT)
    ],
    [
        'an indirect dispatch of an undeclared buffer',
        replaceHeaderLine(MINIMAL_HEADER, 'dispatch', `//! dispatch: ${ENTRY_POINT}, indirect ${MISSING_BUFFER_NAME}`),
        DISPATCH_LINE,
        'dispatch-buffer',
        quote(MISSING_BUFFER_NAME)
    ],
    [
        'an indirect dispatch of a plain buffer',
        [
            ...replaceHeaderLine(MINIMAL_HEADER, 'dispatch', `//! dispatch: ${ENTRY_POINT}, indirect ${SCRATCH_BUFFER_NAME}`),
            `//! buffer: ${SCRATCH_BUFFER_NAME}, ${SCRATCH_BYTE_LENGTH}`
        ],
        DISPATCH_LINE,
        'dispatch-indirect',
        quote(SCRATCH_BUFFER_NAME)
    ],
    [
        'a dispatch of a missing entry point',
        replaceHeaderLine(MINIMAL_HEADER, 'dispatch', `//! dispatch: ${MISSING_ENTRY_POINT}, 1`),
        DISPATCH_LINE,
        'entry-point-missing',
        quote(MISSING_ENTRY_POINT)
    ],
    [ 'a malformed vector', [ ...MINIMAL_HEADER, '//! vector: clip.mkv, frames 0-2' ], APPENDED_LINE, 'vector-syntax', quote('clip.mkv, frames 0-2') ],
    [ 'a vector whose frames run backwards', [ ...MINIMAL_HEADER, `//! vector: clip.mkv, frames 2-1, sha256 ${VECTOR_HASH}` ], APPENDED_LINE, 'vector-frames', '2 > 1' ]
];

describe('parseGPUDecoderManifest', () => {
    it('parses every directive of a complete header', () => {
        const manifest = parseGPUDecoderManifest(createSource(COMPLETE_HEADER));

        expect(manifest.name).toBe(DECODER_NAME);
        expect(manifest.accepts.codecs).toEqual([ 'apch', 'apcn', 'raw ' ]);
        expect(manifest.outputFormat).toBe('I422P10');
        expect(manifest.references).toBe(REFERENCES);
        expect(manifest.reorder).toBe(REORDER);
        expect(manifest.packetByteLength).toBe(PACKET_MEBIBYTES * MEBIBYTE);
        expect(manifest.stateByteLength).toBe(STATE_KIBIBYTES * KIBIBYTE);
        expect(manifest.buffers).toEqual([
            { byteLength: SLICE_DISPATCH_BYTE_LENGTH, indirect: true, name: 'sliceDispatch' },
            { byteLength: COEFFICIENT_MEBIBYTES * MEBIBYTE, indirect: false, name: 'coefficients' }
        ]);
        expect(manifest.requiredFeatures).toEqual([ SUBGROUPS_FEATURE, SHADER_F16_FEATURE ]);
        expect(manifest.dispatches.map(dispatch => dispatch.entryPoint)).toEqual([
            'parseFrameHeader',
            'decodeSlices',
            'inverseTransform'
        ]);
        expect(manifest.dispatches[1]).toEqual({ entryPoint: 'decodeSlices', indirectBuffer: 'sliceDispatch', workgroupCounts: null });
        expect(manifest.vector).toEqual({
            file: VECTOR_FILE,
            firstFrame: VECTOR_FIRST_FRAME,
            lastFrame: VECTOR_LAST_FRAME,
            sha256: VECTOR_HASH.toLowerCase()
        });
        expect(manifest.bodyFirstLine).toBe(COMPLETE_HEADER.length + 1);
        expect(manifest.body).toBe(BODY);
    });

    it('fills omitted workgroup counts with 1 and keeps function calls whole', () => {
        const manifest = parseGPUDecoderManifest(createSource(COMPLETE_HEADER));
        const facts = createStreamFacts(UHD_WIDTH, UHD_HEIGHT, TEN_BIT_DEPTH);

        const evaluateCounts = (counts: readonly PassExpression[] | null): number[] => (counts ?? []).map(
            count => evaluatePassExpression(count, facts)
        );
        expect(evaluateCounts(manifest.dispatches[0].workgroupCounts)).toEqual([ 1, 1, 1 ]);
        expect(evaluateCounts(manifest.dispatches[2].workgroupCounts)).toEqual([
            UHD_WIDTH / BLOCK_SIZE,
            Math.ceil(UHD_HEIGHT / BLOCK_SIZE),
            1
        ]);
    });

    it('joins several accepts conditions so that all of them must hold', () => {
        const constraint = parseGPUDecoderManifest(createSource(COMPLETE_HEADER)).accepts.constraint;
        if (!constraint) {
            throw new Error('The accepts constraint is missing');
        }

        expect(evaluatePassExpression(constraint, createStreamFacts(UHD_WIDTH, UHD_HEIGHT, TEN_BIT_DEPTH))).toBe(1);
        expect(evaluatePassExpression(constraint, createStreamFacts(OVERSIZED_WIDTH, UHD_HEIGHT, TEN_BIT_DEPTH))).toBe(0);
    });

    it('defaults the optional directives', () => {
        const manifest = parseGPUDecoderManifest(createSource(MINIMAL_HEADER));

        expect(manifest.accepts).toEqual({ codecs: [ 'V_UNCOMPRESSED' ], constraint: null });
        expect(manifest.references).toBe(0);
        expect(manifest.reorder).toBe(0);
        expect(manifest.stateByteLength).toBe(0);
        expect(manifest.buffers).toEqual([]);
        expect(manifest.requiredFeatures).toEqual([]);
        expect(manifest.vector).toBeNull();
    });

    it('accepts an indirect flag after the buffer size and skips blank header lines', () => {
        const header = [
            ...MINIMAL_HEADER,
            '//!',
            `//! buffer: sliceDispatch, ${SLICE_DISPATCH_BYTE_LENGTH} B, indirect`
        ];

        expect(parseGPUDecoderManifest(createSource(header)).buffers).toEqual([
            { byteLength: SLICE_DISPATCH_BYTE_LENGTH, indirect: true, name: 'sliceDispatch' }
        ]);
    });

    it.each(REJECTION_CASES)('rejects %s with its code, detail, and line', (
        _description: string,
        header: readonly string[],
        line: number,
        code: GPUDecoderManifestErrorCode,
        detail: string
    ) => {
        const error = getParseError(createSource(header));

        expect({ code: error.code, detail: error.detail, line: error.line }).toEqual({ code, detail, line });
        expect(error.message).toBe(`${code}: ${detail}`);
    });

    it.each([ 'name', 'decoder', 'accepts', 'output', 'packet', 'dispatch' ])('requires the %s directive', (directive: string) => {
        const header = MINIMAL_HEADER.filter(line => !line.startsWith(`//! ${directive}:`));

        const error = getParseError(createSource(header));

        expect({ code: error.code, detail: error.detail }).toEqual({ code: 'directive-missing', detail: quote(directive) });
    });

    it('rejects a source without a header on its first line', () => {
        const source = BODY.trimStart();

        const error = getParseError(source);

        expect({ code: error.code, detail: error.detail, line: error.line }).toEqual({
            code: 'header-missing',
            detail: quote(source.split('\n')[0]),
            line: 1
        });
    });

    it('rejects an entry point declared without @compute', () => {
        const body = `\nfn ${ENTRY_POINT}() {\n}`;

        const error = getParseError(createSource(MINIMAL_HEADER, body));

        expect({ code: error.code, detail: error.detail, line: error.line }).toEqual({
            code: 'entry-point-stage',
            detail: quote(ENTRY_POINT),
            line: DISPATCH_LINE
        });
    });

    it('rejects bindings and enable directives in the body on their body lines', () => {
        const bindingBody = `${BODY}\n@group(0) @binding(9) var<storage, read_write> extra: array<u32>;`;
        const enableBody = `\n${BODY_ENABLE_DIRECTIVE}${BODY}`;
        const bodyFirstLine = MINIMAL_HEADER.length + 1;

        const bindingError = getParseError(createSource(MINIMAL_HEADER, bindingBody));
        const enableError = getParseError(createSource(MINIMAL_HEADER, enableBody));

        expect({ code: bindingError.code, detail: bindingError.detail, line: bindingError.line }).toEqual({
            code: 'body-binding',
            detail: quote('@group'),
            line: bodyFirstLine + BODY.split('\n').length
        });
        expect({ code: enableError.code, detail: enableError.detail, line: enableError.line }).toEqual({
            code: 'body-enable',
            detail: quote(BODY_ENABLE_DIRECTIVE),
            line: bodyFirstLine + 1
        });
    });
});
