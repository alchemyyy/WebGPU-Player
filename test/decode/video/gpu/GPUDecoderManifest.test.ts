import { describe, expect, it } from 'vitest';

import { evaluatePassExpression, parsePassExpression, PassExpressionError } from 'webgpu-player/presentation/passes/PassExpression';
import type { PassExpression } from 'webgpu-player/presentation/passes/PassTypes';
import {
    INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH,
    MAXIMUM_STORAGE_BUFFER_BINDING_SIZE,
    SHADER_F16_FEATURE,
    SUBGROUPS_FEATURE
} from 'webgpu-player/presentation/WebGPUConstants';
import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import {
    GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH,
    GPU_DECODER_ERROR_CODE_SHIFT,
    GPU_DECODER_PARSER_ABI_VERSION,
    GPU_DECODER_MAXIMUM_ERROR_CODE,
    GPU_DECODER_MAXIMUM_REFERENCES,
    GPU_DECODER_MAXIMUM_REORDER,
    KIBIBYTE,
    MEBIBYTE
} from 'webgpu-player/decode/video/gpu/GPUDecodeLimits';
import {
    describeGPUDecoderErrorWord,
    evaluateGPUDecoderByteLength,
    getGPUDecoderAcceptsFacts,
    getGPUDecoderFacts,
    GPU_DECODER_ACCEPTS_IDENTIFIERS,
    GPU_DECODER_FACT_IDENTIFIERS,
    GPU_DECODER_OUTPUT_FACTS,
    GPU_DECODER_PICTURE_FACTS,
    GPU_DECODER_STREAM_FACTS,
    type GPUDecoderByteLengthResult,
    GPUDecoderManifestError,
    type GPUDecoderManifestErrorCode,
    parseGPUDecoderHeader,
    parseGPUDecoderManifest
} from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';
import type { GPUDecodeStreamFacts } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';
import { DECODER_PACKAGE_ID_MAXIMUM_LENGTH } from 'webgpu-player/decode/packages/DecoderPackageIdentity';

const DECODER_NAME = 'ProRes 422';
const DECODER_ID = 'prores-422';
const MINIMAL_DECODER_ID = 'minimal';
// An id the header form refuses, and one a character past the longest
const UPPERCASE_DECODER_ID = 'ProRes';
const OVERLONG_DECODER_ID = 'p'.repeat(DECODER_PACKAGE_ID_MAXIMUM_LENGTH + 1);
const CODEC_FAMILY = 'prores';
// A family with a hyphen, which the complete header quotes as a list item may be
const HYPHENATED_CODEC_FAMILY = 'prores-raw';
// Listed 10-bit first, an order the manifest keeps
const OUTPUT_FORMATS: readonly GPUDecoderOutputFormat[] = [ 'I422P10', 'I422' ];
const TEN_BIT_OUTPUT_FORMAT: GPUDecoderOutputFormat = 'I422P10';
const EIGHT_BIT_OUTPUT_FORMAT: GPUDecoderOutputFormat = 'I422';
const PACKET_MEBIBYTES = 16;
const STATE_KIBIBYTES = 64;
const SLICE_DISPATCH_BYTE_LENGTH = INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH;
const COEFFICIENT_MEBIBYTES = 2;
// Two rows of the widest plane, sized by the output format's sample size
const ROW_BUFFER_ROW_COUNT = 2;
const ROW_BUFFER_SIZE = `stream.width * output.bytesPerSample * ${ROW_BUFFER_ROW_COUNT}`;
const REFERENCES = 2;
const REORDER = 1;
const SLICE_ERROR_CODE = 3;
const SLICE_ERROR_NAME = 'sliceData';
// The highest code, the whole high byte of a status error word
const HEADER_ERROR_CODE = GPU_DECODER_MAXIMUM_ERROR_CODE;
const HEADER_ERROR_NAME = 'frameHeader';
const MINIMUM_ERROR_CODE = 1;
// Errors a decoder resyncs from and one it cannot recover from, and a recovery no header may name
const RESYNC_ERROR_CODE = 19;
const RESYNC_ERROR_NAME = 'bitsExhausted';
const FATAL_ERROR_CODE = 2;
const FATAL_ERROR_NAME = 'pictureSize';
const UNKNOWN_ERROR_RECOVERY = 'skip';
const MAXIMUM_WIDTH = 8192;
const MAXIMUM_HEIGHT = 4320;
const UHD_WIDTH = 3840;
const UHD_HEIGHT = 2160;
const OVERSIZED_WIDTH = 10_240;
const TEN_BIT_DEPTH = 10;
const EIGHT_BIT_DEPTH = 8;
const BLOCK_SIZE = 16;
// Bytes of one workgroup row of the inverse transform: 64 invocations of one word each
const ROW_BYTES_PER_WORKGROUP = 256;
const UHD_STREAM: Pick<GPUDecodeStreamFacts, 'bitDepth' | 'codedHeight' | 'codedWidth'> = {
    bitDepth: TEN_BIT_DEPTH,
    codedHeight: UHD_HEIGHT,
    codedWidth: UHD_WIDTH
};

// Values one past each bound, and malformed values, for the rejection table
const OVERSIZED_PACKET_MEBIBYTES = 513;
const OVERSIZED_STATE_MEBIBYTES = 129;
const EXCESS_REFERENCES = GPU_DECODER_MAXIMUM_REFERENCES + 1;
const EXCESS_REORDER = GPU_DECODER_MAXIMUM_REORDER + 1;
const SHORT_INDIRECT_BYTE_LENGTH = 8;
const SCRATCH_BYTE_LENGTH = 64;
const MALFORMED_SIZE = '4 GB';
// A state size that reads as an identifier, which names no fact
const UNKNOWN_FACT_STATE_SIZE = 'lots';
const MALFORMED_STATE_EXPRESSION = 'stream.width *';
const MALFORMED_BUFFER_EXPRESSION = 'ceil(stream.width';
const MALFORMED_COUNT = '-1';
const MALFORMED_FEATURE = 'Shader F16';
const MALFORMED_CONDITION = 'stream.width <';
const UNKNOWN_DIRECTIVE = 'workgroup';
const UNKNOWN_HYPHENATED_DIRECTIVE = 'frame-rate';
const UNDERSCORED_DIRECTIVE_LINE = '//! parser_version: 1';
const AUDIO_DECODER_KIND = 'audio';
const SEMI_PLANAR_FORMAT = 'NV12';
const FOREIGN_FACT = 'output.width';
const OUTPUT_FACT_IN_ACCEPTS = GPU_DECODER_OUTPUT_FACTS.bitDepth;
// A picture fact, which only accepts conditions read
const PICTURE_FACT_IN_SIZE = GPU_DECODER_PICTURE_FACTS.width;
// UHD's height rounded up to whole coding blocks of 64, and a bound on the UHD picture's area that the pool's rounding crosses
const UHD_CODED_HEIGHT = 2_176;
const UHD_PICTURE_AREA = UHD_WIDTH * UHD_HEIGHT;
const PICTURE_AREA_ACCEPTS_LINE = `//! accepts: codec in [${CODEC_FAMILY}], ${GPU_DECODER_PICTURE_FACTS.width} * ${GPU_DECODER_PICTURE_FACTS.height} <= ${UHD_PICTURE_AREA}`;
const POOL_AREA_ACCEPTS_LINE = `//! accepts: codec in [${CODEC_FAMILY}], ${GPU_DECODER_STREAM_FACTS.width} * ${GPU_DECODER_STREAM_FACTS.height} <= ${UHD_PICTURE_AREA}`;
const RESERVED_BUFFER_NAME = 'state';
const RESERVED_FORMAT_CONSTANT_NAME = 'SAMPLE_BYTES';
const SCRATCH_BUFFER_NAME = 'scratch';
const INVALID_BUFFER_NAME = '1scratch';
const MISSING_BUFFER_NAME = 'missing';
const MISSING_ENTRY_POINT = 'missingEntry';
const DUPLICATE_CODEC = 'apch';
const UPPERCASE_CODEC = 'HEVC';
const UNDERSCORED_CODEC = 'V_UNCOMPRESSED';
const TRAILING_HYPHEN_CODEC = 'prores-';
const SPACED_CODEC = 'raw ';
// The 1-based position of the empty item in `codec in [prores, ]`
const EMPTY_CODEC_POSITION = 2;
const UNSUPPORTED_PARSER_VERSION = GPU_DECODER_PARSER_ABI_VERSION + 1;
const MALFORMED_PARSER_VERSION = 'v1';
// The monochrome directive's one value, and values it does not take
const MONOCHROME_DIRECTIVE_LINE = '//! monochrome: yes';
const NEGATIVE_MONOCHROME_VALUE = 'no';
const CAPITALIZED_MONOCHROME_VALUE = 'Yes';
const ZERO_ERROR_CODE = 0;
const OVERSIZED_ERROR_CODE = GPU_DECODER_MAXIMUM_ERROR_CODE + 1;
const MALFORMED_ERROR_NAME = 'slice data';
// The vector directive a package's vectors section replaced, which no header carries
const VECTOR_DIRECTIVE = 'vector';
const VECTOR_DIRECTIVE_LINE = `//! ${VECTOR_DIRECTIVE}: I420, frames 0-2, sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`;
const ENTRY_POINT = 'parseFrameHeader';
const BODY_ENABLE_DIRECTIVE = 'enable f16;';

// Byte length expressions and their values, for a 64x36 8-bit stream decoded to I420
const SIZE_STREAM_WIDTH = 64;
const SIZE_STREAM_HEIGHT = 36;
const SIZE_STREAM: Pick<GPUDecodeStreamFacts, 'bitDepth' | 'codedHeight' | 'codedWidth'> = {
    bitDepth: EIGHT_BIT_DEPTH,
    codedHeight: SIZE_STREAM_HEIGHT,
    codedWidth: SIZE_STREAM_WIDTH
};
const SIZE_FORMAT: GPUDecoderOutputFormat = 'I420';
const SIZE_STREAM_SAMPLE_COUNT = SIZE_STREAM_WIDTH * SIZE_STREAM_HEIGHT;
// 64 / 3 is 21.33, which rounds up
const FRACTIONAL_SIZE = 'stream.width / 3';
const FRACTIONAL_SIZE_BYTE_LENGTH = 22;
// 64 / 128 is half a byte, which rounds up to one
const HALF_BYTE_SIZE = 'stream.width / 128';
const WHOLE_SIZE = 'stream.width * stream.height';
const EMPTY_SIZE = `stream.width - ${SIZE_STREAM_WIDTH}`;
// An 8-bit stream divides by zero
const ZERO_DIVISOR_SIZE = `stream.width / (stream.bitDepth - ${EIGHT_BIT_DEPTH})`;
const OUTPUT_FACT_SIZE_FACTOR = 4;
const OUTPUT_FACT_SIZE = `output.bitDepth * ${OUTPUT_FACT_SIZE_FACTOR}`;
const MINIMUM_BYTE_LENGTH = 1;
const SMALL_MAXIMUM_BYTE_LENGTH = 1024;
// 4096^5 is 2^60, past the safe integers
const HUGE_WIDTH = 4096;
const HUGE_SIZE = 'stream.width * stream.width * stream.width * stream.width * stream.width';
const HUGE_SIZE_VALUE = HUGE_WIDTH ** 5;
const DIVISION_BY_ZERO_MESSAGE = 'Division by zero';

// A status error word's failing value, and a code no decoder names
const FAILING_VALUE = 1234;
const UNNAMED_ERROR_CODE = 200;

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
    `//! accepts: codec in [${CODEC_FAMILY}, "${HYPHENATED_CODEC_FAMILY}"], stream.width <= ${MAXIMUM_WIDTH}, stream.height <= ${MAXIMUM_HEIGHT}`,
    `//! output: ${OUTPUT_FORMATS.join(', ')}`,
    MONOCHROME_DIRECTIVE_LINE,
    `//! parser: ${GPU_DECODER_PARSER_ABI_VERSION}`,
    `//! references: ${REFERENCES}`,
    `//! reorder: ${REORDER}`,
    `//! packet: ${PACKET_MEBIBYTES} MiB`,
    `//! state: ${STATE_KIBIBYTES} KiB`,
    `//! buffer: sliceDispatch, indirect, ${SLICE_DISPATCH_BYTE_LENGTH}`,
    `//! buffer: coefficients, ${COEFFICIENT_MEBIBYTES} MiB`,
    `//! buffer: rows, ${ROW_BUFFER_SIZE}`,
    `//! requires: ${SUBGROUPS_FEATURE}, ${SHADER_F16_FEATURE}`,
    `//! error: ${SLICE_ERROR_CODE}, ${SLICE_ERROR_NAME}`,
    `//! error: ${HEADER_ERROR_CODE}, ${HEADER_ERROR_NAME}`,
    '//! dispatch: parseFrameHeader, 1',
    '//! dispatch: decodeSlices, indirect sliceDispatch',
    `//! dispatch: inverseTransform, ceil(stream.width * output.bytesPerSample / ${ROW_BYTES_PER_WORKGROUP}), max(stream.height / ${BLOCK_SIZE}, 1)`,
    `//! id: ${DECODER_ID}`
];
const MINIMAL_CODEC_FAMILY = 'uncompressed';
const MINIMAL_OUTPUT_FORMAT: GPUDecoderOutputFormat = 'I420';
// The id comes last, so the other directives keep their lines
const MINIMAL_HEADER: readonly string[] = [
    '//! name: Minimal',
    '//! decoder: video',
    `//! accepts: codec in [${MINIMAL_CODEC_FAMILY}]`,
    `//! output: ${MINIMAL_OUTPUT_FORMAT}`,
    '//! packet: 4096',
    `//! dispatch: ${ENTRY_POINT}, 1`,
    `//! id: ${MINIMAL_DECODER_ID}`
];
// The lines of MINIMAL_HEADER's directives, and the line a directive appended to it takes
const DECODER_LINE = 2;
const ACCEPTS_LINE = 3;
const OUTPUT_LINE = 4;
const PACKET_LINE = 5;
const DISPATCH_LINE = 6;
const ID_LINE = 7;
const APPENDED_LINE = MINIMAL_HEADER.length + 1;

/** One output format's facts as an independent table states them: bit depth, bytes per sample, and the chroma width and height divisors. */
type FormatFactsCase = readonly [GPUDecoderOutputFormat, number, number, number, number];

const FORMAT_FACTS_CASES: readonly FormatFactsCase[] = [
    [ 'I420', 8, 1, 2, 2 ],
    [ 'I420P10', 10, 2, 2, 2 ],
    [ 'I420P12', 12, 2, 2, 2 ],
    [ 'I422', 8, 1, 2, 1 ],
    [ 'I422P10', 10, 2, 2, 1 ],
    [ 'I422P12', 12, 2, 2, 1 ],
    [ 'I444', 8, 1, 1, 1 ],
    [ 'I444P10', 10, 2, 1, 1 ],
    [ 'I444P12', 12, 2, 1, 1 ]
];

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

function evaluateCounts(counts: readonly PassExpression[] | null, facts: ReadonlyMap<string, number>): number[] {
    return (counts ?? []).map(count => evaluatePassExpression(count, facts));
}

/** Builds a status error word: the code in the high byte and the failing value below it. */
function createErrorWord(code: number, value: number): number {
    return ((code << GPU_DECODER_ERROR_CODE_SHIFT) | value) >>> 0;
}

function createSizeResult(byteLength: number): GPUDecoderByteLengthResult {
    return { byteLength, kind: 'size' };
}

function createInvalidResult(detail: string): GPUDecoderByteLengthResult {
    return { detail, kind: 'invalid' };
}

/** A header the parser rejects: a description, the header lines, and the line, code, and detail of the error. */
type RejectionCase = readonly [string, readonly string[], number, GPUDecoderManifestErrorCode, string];

const REJECTION_CASES: readonly RejectionCase[] = [
    [ 'an unknown directive', [ ...MINIMAL_HEADER, `//! ${UNKNOWN_DIRECTIVE}: 64` ], APPENDED_LINE, 'directive-unknown', quote(UNKNOWN_DIRECTIVE) ],
    [
        'an unknown hyphenated directive',
        [ ...MINIMAL_HEADER, `//! ${UNKNOWN_HYPHENATED_DIRECTIVE}: 24` ],
        APPENDED_LINE,
        'directive-unknown',
        quote(UNKNOWN_HYPHENATED_DIRECTIVE)
    ],
    [ 'a directive name with an underscore', [ ...MINIMAL_HEADER, UNDERSCORED_DIRECTIVE_LINE ], APPENDED_LINE, 'header-syntax', quote(UNDERSCORED_DIRECTIVE_LINE) ],
    [ 'a repeated single directive', [ ...MINIMAL_HEADER, '//! output: I444' ], APPENDED_LINE, 'directive-repeated', quote('output') ],
    [ 'a malformed header line', [ ...MINIMAL_HEADER, '//! output I444' ], APPENDED_LINE, 'header-syntax', quote('//! output I444') ],
    [ 'an empty name', replaceHeaderLine(MINIMAL_HEADER, 'name', '//! name:'), 1, 'name-empty', quote('') ],
    [ 'an uppercase id', replaceHeaderLine(MINIMAL_HEADER, 'id', `//! id: ${UPPERCASE_DECODER_ID}`), ID_LINE, 'id-syntax', quote(UPPERCASE_DECODER_ID) ],
    [ 'an empty id', replaceHeaderLine(MINIMAL_HEADER, 'id', '//! id:'), ID_LINE, 'id-syntax', quote('') ],
    [
        'an id past the longest',
        replaceHeaderLine(MINIMAL_HEADER, 'id', `//! id: ${OVERLONG_DECODER_ID}`),
        ID_LINE,
        'id-length',
        `${OVERLONG_DECODER_ID.length} > ${DECODER_PACKAGE_ID_MAXIMUM_LENGTH}`
    ],
    [ 'a repeated id', [ ...MINIMAL_HEADER, `//! id: ${DECODER_ID}` ], APPENDED_LINE, 'directive-repeated', quote('id') ],
    [ 'an audio decoder', replaceHeaderLine(MINIMAL_HEADER, 'decoder', `//! decoder: ${AUDIO_DECODER_KIND}`), DECODER_LINE, 'decoder-kind', quote(AUDIO_DECODER_KIND) ],
    [ 'semi-planar output', replaceHeaderLine(MINIMAL_HEADER, 'output', `//! output: I420, ${SEMI_PLANAR_FORMAT}`), OUTPUT_LINE, 'output-format', quote(SEMI_PLANAR_FORMAT) ],
    [ 'an empty output list', replaceHeaderLine(MINIMAL_HEADER, 'output', '//! output:'), OUTPUT_LINE, 'output-format', quote('') ],
    [ 'a repeated output format', replaceHeaderLine(MINIMAL_HEADER, 'output', '//! output: I420, I444, I420'), OUTPUT_LINE, 'output-duplicate', quote('I420') ],
    [
        'a parser version the engine does not drive',
        [ ...MINIMAL_HEADER, `//! parser: ${UNSUPPORTED_PARSER_VERSION}` ],
        APPENDED_LINE,
        'parser-version',
        `${UNSUPPORTED_PARSER_VERSION}, expected ${GPU_DECODER_PARSER_ABI_VERSION}`
    ],
    [
        'a parser version that is not a number',
        [ ...MINIMAL_HEADER, `//! parser: ${MALFORMED_PARSER_VERSION}` ],
        APPENDED_LINE,
        'parser-syntax',
        quote(MALFORMED_PARSER_VERSION)
    ],
    [
        'a repeated parser',
        [ ...MINIMAL_HEADER, `//! parser: ${GPU_DECODER_PARSER_ABI_VERSION}`, `//! parser: ${GPU_DECODER_PARSER_ABI_VERSION}` ],
        APPENDED_LINE + 1,
        'directive-repeated',
        quote('parser')
    ],
    // A decoder takes 4:0:0 only by declaring it, so the directive has no negative or other spelling
    [ 'a monochrome value other than yes', [ ...MINIMAL_HEADER, `//! monochrome: ${NEGATIVE_MONOCHROME_VALUE}` ], APPENDED_LINE, 'monochrome-syntax', quote(NEGATIVE_MONOCHROME_VALUE) ],
    [
        'a capitalized monochrome value',
        [ ...MINIMAL_HEADER, `//! monochrome: ${CAPITALIZED_MONOCHROME_VALUE}` ],
        APPENDED_LINE,
        'monochrome-syntax',
        quote(CAPITALIZED_MONOCHROME_VALUE)
    ],
    [ 'a repeated monochrome', [ ...MINIMAL_HEADER, MONOCHROME_DIRECTIVE_LINE, MONOCHROME_DIRECTIVE_LINE ], APPENDED_LINE + 1, 'directive-repeated', quote('monochrome') ],
    [
        'a packet size with an unknown unit',
        replaceHeaderLine(MINIMAL_HEADER, 'packet', `//! packet: ${MALFORMED_SIZE}`),
        PACKET_LINE,
        'packet-expression',
        `${quote(MALFORMED_SIZE)} ${getExpressionErrorMessage(MALFORMED_SIZE)}`
    ],
    [ 'a packet size on another fact', replaceHeaderLine(MINIMAL_HEADER, 'packet', `//! packet: ${FOREIGN_FACT} * 4`), PACKET_LINE, 'packet-identifier', quote(FOREIGN_FACT) ],
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
    [
        'a state size naming no fact',
        [ ...MINIMAL_HEADER, `//! state: ${UNKNOWN_FACT_STATE_SIZE}` ],
        APPENDED_LINE,
        'state-identifier',
        quote(UNKNOWN_FACT_STATE_SIZE)
    ],
    [ 'a state size on another fact', [ ...MINIMAL_HEADER, `//! state: ${FOREIGN_FACT} * 4` ], APPENDED_LINE, 'state-identifier', quote(FOREIGN_FACT) ],
    [
        'a state size with an unknown unit',
        [ ...MINIMAL_HEADER, `//! state: ${MALFORMED_SIZE}` ],
        APPENDED_LINE,
        'state-expression',
        `${quote(MALFORMED_SIZE)} ${getExpressionErrorMessage(MALFORMED_SIZE)}`
    ],
    [
        'a malformed state expression',
        [ ...MINIMAL_HEADER, `//! state: ${MALFORMED_STATE_EXPRESSION}` ],
        APPENDED_LINE,
        'state-expression',
        `${quote(MALFORMED_STATE_EXPRESSION)} ${getExpressionErrorMessage(MALFORMED_STATE_EXPRESSION)}`
    ],
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
        replaceHeaderLine(MINIMAL_HEADER, 'accepts', `//! accepts: codec in [${CODEC_FAMILY}], ${FOREIGN_FACT} > 0`),
        ACCEPTS_LINE,
        'accepts-identifier',
        quote(FOREIGN_FACT)
    ],
    [
        'an accepts condition on an output fact, which only sizes and counts read',
        replaceHeaderLine(MINIMAL_HEADER, 'accepts', `//! accepts: codec in [${CODEC_FAMILY}], ${OUTPUT_FACT_IN_ACCEPTS} == ${TEN_BIT_DEPTH}`),
        ACCEPTS_LINE,
        'accepts-identifier',
        quote(OUTPUT_FACT_IN_ACCEPTS)
    ],
    [
        'a malformed accepts condition',
        replaceHeaderLine(MINIMAL_HEADER, 'accepts', `//! accepts: codec in [${CODEC_FAMILY}], ${MALFORMED_CONDITION}`),
        ACCEPTS_LINE,
        'accepts-expression',
        `${quote(MALFORMED_CONDITION)} ${getExpressionErrorMessage(MALFORMED_CONDITION)}`
    ],
    [
        'an empty codec family',
        replaceHeaderLine(MINIMAL_HEADER, 'accepts', `//! accepts: codec in [${CODEC_FAMILY}, ]`),
        ACCEPTS_LINE,
        'codec-empty',
        `position ${EMPTY_CODEC_POSITION}`
    ],
    [
        'a repeated codec family',
        replaceHeaderLine(MINIMAL_HEADER, 'accepts', `//! accepts: codec in [${DUPLICATE_CODEC}, ${DUPLICATE_CODEC}]`),
        ACCEPTS_LINE,
        'codec-duplicate',
        quote(DUPLICATE_CODEC)
    ],
    [
        'a codec family repeated in quotes',
        replaceHeaderLine(MINIMAL_HEADER, 'accepts', `//! accepts: codec in [${CODEC_FAMILY}, "${CODEC_FAMILY}"]`),
        ACCEPTS_LINE,
        'codec-duplicate',
        quote(CODEC_FAMILY)
    ],
    [
        'an uppercase codec family',
        replaceHeaderLine(MINIMAL_HEADER, 'accepts', `//! accepts: codec in [${UPPERCASE_CODEC}]`),
        ACCEPTS_LINE,
        'codec-syntax',
        quote(UPPERCASE_CODEC)
    ],
    [
        'a codec family with an underscore, as a Matroska codec ID has',
        replaceHeaderLine(MINIMAL_HEADER, 'accepts', `//! accepts: codec in [${UNDERSCORED_CODEC}]`),
        ACCEPTS_LINE,
        'codec-syntax',
        quote(UNDERSCORED_CODEC)
    ],
    [
        'a codec family ending in a hyphen',
        replaceHeaderLine(MINIMAL_HEADER, 'accepts', `//! accepts: codec in [${TRAILING_HYPHEN_CODEC}]`),
        ACCEPTS_LINE,
        'codec-syntax',
        quote(TRAILING_HYPHEN_CODEC)
    ],
    [
        'a quoted codec family with a space',
        replaceHeaderLine(MINIMAL_HEADER, 'accepts', `//! accepts: codec in ["${SPACED_CODEC}"]`),
        ACCEPTS_LINE,
        'codec-syntax',
        quote(SPACED_CODEC)
    ],
    [
        'a buffer named after a prelude binding',
        [ ...MINIMAL_HEADER, `//! buffer: ${RESERVED_BUFFER_NAME}, ${SCRATCH_BYTE_LENGTH}` ],
        APPENDED_LINE,
        'buffer-reserved',
        quote(RESERVED_BUFFER_NAME)
    ],
    [
        'a buffer named after a prelude format constant',
        [ ...MINIMAL_HEADER, `//! buffer: ${RESERVED_FORMAT_CONSTANT_NAME}, ${SCRATCH_BYTE_LENGTH}` ],
        APPENDED_LINE,
        'buffer-reserved',
        quote(RESERVED_FORMAT_CONSTANT_NAME)
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
    [
        'a buffer size on another fact',
        [ ...MINIMAL_HEADER, `//! buffer: ${SCRATCH_BUFFER_NAME}, ${FOREIGN_FACT} * 4` ],
        APPENDED_LINE,
        'buffer-identifier',
        quote(FOREIGN_FACT)
    ],
    [
        'a buffer size on a picture fact, which only accepts reads',
        [ ...MINIMAL_HEADER, `//! buffer: ${SCRATCH_BUFFER_NAME}, ${PICTURE_FACT_IN_SIZE} * 4` ],
        APPENDED_LINE,
        'buffer-identifier',
        quote(PICTURE_FACT_IN_SIZE)
    ],
    [ 'a state size on a picture fact', [ ...MINIMAL_HEADER, `//! state: ${PICTURE_FACT_IN_SIZE} * 4` ], APPENDED_LINE, 'state-identifier', quote(PICTURE_FACT_IN_SIZE) ],
    [
        'a malformed buffer expression',
        [ ...MINIMAL_HEADER, `//! buffer: ${SCRATCH_BUFFER_NAME}, ${MALFORMED_BUFFER_EXPRESSION}` ],
        APPENDED_LINE,
        'buffer-expression',
        `${quote(MALFORMED_BUFFER_EXPRESSION)} ${getExpressionErrorMessage(MALFORMED_BUFFER_EXPRESSION)}`
    ],
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
        'a workgroup count on a picture fact',
        replaceHeaderLine(MINIMAL_HEADER, 'dispatch', `//! dispatch: ${ENTRY_POINT}, ${PICTURE_FACT_IN_SIZE}`),
        DISPATCH_LINE,
        'dispatch-identifier',
        quote(PICTURE_FACT_IN_SIZE)
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
    [
        'an error code of 0, which a status word reads as no error',
        [ ...MINIMAL_HEADER, `//! error: ${ZERO_ERROR_CODE}, ${SLICE_ERROR_NAME}` ],
        APPENDED_LINE,
        'error-code',
        `${ZERO_ERROR_CODE} outside [${MINIMUM_ERROR_CODE}, ${GPU_DECODER_MAXIMUM_ERROR_CODE}]`
    ],
    [
        'an error code past the high byte',
        [ ...MINIMAL_HEADER, `//! error: ${OVERSIZED_ERROR_CODE}, ${SLICE_ERROR_NAME}` ],
        APPENDED_LINE,
        'error-code',
        `${OVERSIZED_ERROR_CODE} outside [${MINIMUM_ERROR_CODE}, ${GPU_DECODER_MAXIMUM_ERROR_CODE}]`
    ],
    [ 'an error without a name', [ ...MINIMAL_HEADER, `//! error: ${SLICE_ERROR_CODE}` ], APPENDED_LINE, 'error-syntax', quote(String(SLICE_ERROR_CODE)) ],
    [
        'an error name that is not an identifier',
        [ ...MINIMAL_HEADER, `//! error: ${SLICE_ERROR_CODE}, ${MALFORMED_ERROR_NAME}` ],
        APPENDED_LINE,
        'error-syntax',
        quote(`${SLICE_ERROR_CODE}, ${MALFORMED_ERROR_NAME}`)
    ],
    [
        'a negative error code',
        [ ...MINIMAL_HEADER, `//! error: ${MALFORMED_COUNT}, ${SLICE_ERROR_NAME}` ],
        APPENDED_LINE,
        'error-syntax',
        quote(`${MALFORMED_COUNT}, ${SLICE_ERROR_NAME}`)
    ],
    [
        'a repeated error code',
        [ ...MINIMAL_HEADER, `//! error: ${SLICE_ERROR_CODE}, ${SLICE_ERROR_NAME}`, `//! error: ${SLICE_ERROR_CODE}, ${HEADER_ERROR_NAME}` ],
        APPENDED_LINE + 1,
        'error-duplicate',
        quote(`${SLICE_ERROR_CODE}, ${HEADER_ERROR_NAME}`)
    ],
    [
        'a repeated error name',
        [ ...MINIMAL_HEADER, `//! error: ${SLICE_ERROR_CODE}, ${SLICE_ERROR_NAME}`, `//! error: ${HEADER_ERROR_CODE}, ${SLICE_ERROR_NAME}` ],
        APPENDED_LINE + 1,
        'error-duplicate',
        quote(`${HEADER_ERROR_CODE}, ${SLICE_ERROR_NAME}`)
    ],
    [
        'an error recovery no header may name',
        [ ...MINIMAL_HEADER, `//! error: ${SLICE_ERROR_CODE}, ${SLICE_ERROR_NAME}, ${UNKNOWN_ERROR_RECOVERY}` ],
        APPENDED_LINE,
        'error-recovery',
        quote(UNKNOWN_ERROR_RECOVERY)
    ],
    [
        'an error line with a part past its recovery',
        [ ...MINIMAL_HEADER, `//! error: ${SLICE_ERROR_CODE}, ${SLICE_ERROR_NAME}, conceal, drop` ],
        APPENDED_LINE,
        'error-syntax',
        quote(`${SLICE_ERROR_CODE}, ${SLICE_ERROR_NAME}, conceal, drop`)
    ],
    [
        'a vector directive, which a package\'s vectors section replaced',
        [ ...MINIMAL_HEADER, VECTOR_DIRECTIVE_LINE ],
        APPENDED_LINE,
        'directive-unknown',
        quote(VECTOR_DIRECTIVE)
    ]
];

describe('parseGPUDecoderManifest', () => {
    it('parses every directive of a complete header', () => {
        const manifest = parseGPUDecoderManifest(createSource(COMPLETE_HEADER));

        expect(manifest.id).toBe(DECODER_ID);
        expect(manifest.name).toBe(DECODER_NAME);
        expect(manifest.accepts.codecs).toEqual([ CODEC_FAMILY, HYPHENATED_CODEC_FAMILY ]);
        expect(manifest.outputFormats).toEqual(OUTPUT_FORMATS);
        expect(manifest.monochrome).toBe(true);
        expect(manifest.parser).toBe(GPU_DECODER_PARSER_ABI_VERSION);
        expect(manifest.references).toBe(REFERENCES);
        expect(manifest.reorder).toBe(REORDER);
        expect(manifest.packetByteLength).toEqual({ kind: 'number', value: PACKET_MEBIBYTES * MEBIBYTE });
        expect(manifest.stateByteLength).toEqual({ kind: 'number', value: STATE_KIBIBYTES * KIBIBYTE });
        expect(manifest.buffers.map(buffer => [ buffer.name, buffer.indirect ])).toEqual([
            [ 'sliceDispatch', true ],
            [ 'coefficients', false ],
            [ 'rows', false ]
        ]);
        expect(manifest.buffers[0].byteLength).toEqual({ kind: 'number', value: SLICE_DISPATCH_BYTE_LENGTH });
        expect(manifest.buffers[1].byteLength).toEqual({ kind: 'number', value: COEFFICIENT_MEBIBYTES * MEBIBYTE });
        expect(manifest.requiredFeatures).toEqual([ SUBGROUPS_FEATURE, SHADER_F16_FEATURE ]);
        expect(manifest.errors).toEqual(new Map([ [ SLICE_ERROR_CODE, SLICE_ERROR_NAME ], [ HEADER_ERROR_CODE, HEADER_ERROR_NAME ] ]));
        expect(manifest.dispatches.map(dispatch => dispatch.entryPoint)).toEqual([
            'parseFrameHeader',
            'decodeSlices',
            'inverseTransform'
        ]);
        expect(manifest.dispatches[1]).toEqual({ entryPoint: 'decodeSlices', indirectBuffer: 'sliceDispatch', workgroupCounts: null });
        expect(manifest.bodyFirstLine).toBe(COMPLETE_HEADER.length + 1);
        expect(manifest.body).toBe(BODY);
    });

    it('fills omitted workgroup counts with 1 and reads the output format\'s facts in workgroup counts', () => {
        const manifest = parseGPUDecoderManifest(createSource(COMPLETE_HEADER));
        const tenBitFacts = getGPUDecoderFacts(UHD_STREAM, TEN_BIT_OUTPUT_FORMAT);
        const eightBitFacts = getGPUDecoderFacts(UHD_STREAM, EIGHT_BIT_OUTPUT_FORMAT);

        expect(evaluateCounts(manifest.dispatches[0].workgroupCounts, tenBitFacts)).toEqual([ 1, 1, 1 ]);
        // Two-byte samples take twice the workgroups across a row
        expect(evaluateCounts(manifest.dispatches[2].workgroupCounts, tenBitFacts)).toEqual([
            2 * UHD_WIDTH / ROW_BYTES_PER_WORKGROUP,
            Math.ceil(UHD_HEIGHT / BLOCK_SIZE),
            1
        ]);
        expect(evaluateCounts(manifest.dispatches[2].workgroupCounts, eightBitFacts)).toEqual([
            UHD_WIDTH / ROW_BYTES_PER_WORKGROUP,
            Math.ceil(UHD_HEIGHT / BLOCK_SIZE),
            1
        ]);
    });

    it('sizes a buffer by an expression over the stream and the output format, and keeps literal sizes as numbers', () => {
        const manifest = parseGPUDecoderManifest(createSource(COMPLETE_HEADER));
        const rowBuffer = manifest.buffers[2];

        expect(evaluatePassExpression(rowBuffer.byteLength, getGPUDecoderFacts(UHD_STREAM, TEN_BIT_OUTPUT_FORMAT))).toBe(UHD_WIDTH * 2 * ROW_BUFFER_ROW_COUNT);
        expect(evaluatePassExpression(rowBuffer.byteLength, getGPUDecoderFacts(UHD_STREAM, EIGHT_BIT_OUTPUT_FORMAT))).toBe(UHD_WIDTH * ROW_BUFFER_ROW_COUNT);
    });

    it('sizes the state by an expression, which the session checks against its bounds', () => {
        const header = [ ...MINIMAL_HEADER, `//! state: ${WHOLE_SIZE}`, `//! buffer: ${SCRATCH_BUFFER_NAME}, indirect, ${EMPTY_SIZE}` ];

        const manifest = parseGPUDecoderManifest(createSource(header));

        const facts = getGPUDecoderFacts(SIZE_STREAM, SIZE_FORMAT);
        expect(evaluatePassExpression(manifest.stateByteLength, facts)).toBe(SIZE_STREAM_SAMPLE_COUNT);
        // An expression that evaluates below the indirect minimum parses; the session reports it as 'buffer-size'
        expect(evaluatePassExpression(manifest.buffers[0].byteLength, facts)).toBe(0);
        expect(manifest.buffers[0].indirect).toBe(true);
    });

    it('sizes the packet by an expression over the stream and the output format, which the session checks against its bounds', () => {
        const manifest = parseGPUDecoderManifest(createSource(replaceHeaderLine(MINIMAL_HEADER, 'packet', `//! packet: ${WHOLE_SIZE}`)));

        expect(evaluatePassExpression(manifest.packetByteLength, getGPUDecoderFacts(SIZE_STREAM, SIZE_FORMAT))).toBe(SIZE_STREAM_SAMPLE_COUNT);
    });

    it('joins several accepts conditions so that all of them must hold', () => {
        const constraint = parseGPUDecoderManifest(createSource(COMPLETE_HEADER)).accepts.constraint;
        if (!constraint) {
            throw new Error('The accepts constraint is missing');
        }

        expect(evaluatePassExpression(constraint, createStreamFacts(UHD_WIDTH, UHD_HEIGHT, TEN_BIT_DEPTH))).toBe(1);
        expect(evaluatePassExpression(constraint, createStreamFacts(OVERSIZED_WIDTH, UHD_HEIGHT, TEN_BIT_DEPTH))).toBe(0);
    });

    it('reads the picture facts in accepts conditions, the size before the pool\'s rounding that the stream facts take', () => {
        const pictureConstraint = parseGPUDecoderManifest(createSource(replaceHeaderLine(MINIMAL_HEADER, 'accepts', PICTURE_AREA_ACCEPTS_LINE))).accepts.constraint;
        const poolConstraint = parseGPUDecoderManifest(createSource(replaceHeaderLine(MINIMAL_HEADER, 'accepts', POOL_AREA_ACCEPTS_LINE))).accepts.constraint;
        if (!pictureConstraint || !poolConstraint) {
            throw new Error('An accepts constraint is missing');
        }
        const facts = getGPUDecoderAcceptsFacts({ ...UHD_STREAM, codedHeight: UHD_CODED_HEIGHT }, TEN_BIT_OUTPUT_FORMAT, { height: UHD_HEIGHT, width: UHD_WIDTH });

        expect(evaluatePassExpression(pictureConstraint, facts)).toBe(1);
        expect(evaluatePassExpression(poolConstraint, facts)).toBe(0);
    });

    it('defaults the optional directives', () => {
        const manifest = parseGPUDecoderManifest(createSource(MINIMAL_HEADER));

        expect(manifest.accepts).toEqual({ codecs: [ MINIMAL_CODEC_FAMILY ], constraint: null });
        expect(manifest.outputFormats).toEqual([ MINIMAL_OUTPUT_FORMAT ]);
        // A decoder that does not declare monochrome takes no 4:0:0 stream
        expect(manifest.monochrome).toBe(false);
        expect(manifest.parser).toBeNull();
        expect(manifest.references).toBe(0);
        expect(manifest.reorder).toBe(0);
        expect(manifest.stateByteLength).toEqual({ kind: 'number', value: 0 });
        expect(manifest.buffers).toEqual([]);
        expect(manifest.requiredFeatures).toEqual([]);
        expect(manifest.errors.size).toBe(0);
    });

    it('keeps the output formats in the order the header lists them', () => {
        const header = replaceHeaderLine(MINIMAL_HEADER, 'output', '//! output: I444P12, I420, I422P10');

        expect(parseGPUDecoderManifest(createSource(header)).outputFormats).toEqual([ 'I444P12', 'I420', 'I422P10' ]);
    });

    it('names error codes from 1 through 255', () => {
        const header = [
            ...MINIMAL_HEADER,
            `//! error: ${MINIMUM_ERROR_CODE}, ${SLICE_ERROR_NAME}`,
            `//! error: ${GPU_DECODER_MAXIMUM_ERROR_CODE}, ${HEADER_ERROR_NAME}`
        ];

        const manifest = parseGPUDecoderManifest(createSource(header));

        expect(manifest.errors).toEqual(new Map([
            [ MINIMUM_ERROR_CODE, SLICE_ERROR_NAME ],
            [ GPU_DECODER_MAXIMUM_ERROR_CODE, HEADER_ERROR_NAME ]
        ]));
        // An error line without a recovery is fatal
        expect(manifest.errorRecoveries.size).toBe(0);
    });

    it('reads each error line\'s recovery, conceal, drop, or resync, and leaves a line without one fatal', () => {
        const header = [
            ...MINIMAL_HEADER,
            `//! error: ${SLICE_ERROR_CODE}, ${SLICE_ERROR_NAME}, conceal`,
            `//! error: ${HEADER_ERROR_CODE}, ${HEADER_ERROR_NAME}, drop`,
            `//! error: ${RESYNC_ERROR_CODE}, ${RESYNC_ERROR_NAME},resync`,
            `//! error: ${FATAL_ERROR_CODE}, ${FATAL_ERROR_NAME}`
        ];

        const manifest = parseGPUDecoderManifest(createSource(header));

        expect(manifest.errorRecoveries).toEqual(new Map([
            [ SLICE_ERROR_CODE, 'conceal' ],
            [ HEADER_ERROR_CODE, 'drop' ],
            [ RESYNC_ERROR_CODE, 'resync' ]
        ]));
        expect(manifest.errors.get(RESYNC_ERROR_CODE)).toBe(RESYNC_ERROR_NAME);
        expect(manifest.errors.get(FATAL_ERROR_CODE)).toBe(FATAL_ERROR_NAME);
    });

    it('accepts an indirect flag after the buffer size and skips blank header lines', () => {
        const header = [
            ...MINIMAL_HEADER,
            '//!',
            `//! buffer: sliceDispatch, ${SLICE_DISPATCH_BYTE_LENGTH} B, indirect`
        ];

        expect(parseGPUDecoderManifest(createSource(header)).buffers).toEqual([
            { byteLength: { kind: 'number', value: SLICE_DISPATCH_BYTE_LENGTH }, indirect: true, name: 'sliceDispatch' }
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

    it.each([ 'id', 'name', 'decoder', 'accepts', 'output', 'packet', 'dispatch' ])('requires the %s directive', (directive: string) => {
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

describe('parseGPUDecoderHeader', () => {
    // The checks of a decoder's body, which a header alone cannot run
    const BODY_CHECK_CODES: ReadonlySet<GPUDecoderManifestErrorCode> = new Set([ 'body-binding', 'body-enable', 'entry-point-missing', 'entry-point-stage' ]);

    function getHeaderParseError(header: readonly string[]): GPUDecoderManifestError {
        try {
            parseGPUDecoderHeader(header.join('\n'));
        } catch (error) {
            if (error instanceof GPUDecoderManifestError) {
                return error;
            }
            throw error;
        }
        throw new Error('The header parsed');
    }

    it('reads a header without its body as the manifest reads it', () => {
        const { body, bodyFirstLine, ...header } = parseGPUDecoderManifest(createSource(COMPLETE_HEADER));

        expect(parseGPUDecoderHeader(COMPLETE_HEADER.join('\n'))).toEqual(header);
        expect({ body, bodyFirstLine }).toEqual({ body: BODY, bodyFirstLine: COMPLETE_HEADER.length + 1 });
    });

    it('reads a whole source\'s header without reading its body', () => {
        const header = replaceHeaderLine(MINIMAL_HEADER, 'dispatch', `//! dispatch: ${MISSING_ENTRY_POINT}, 1`);

        expect(parseGPUDecoderHeader(createSource(header)).dispatches[0].entryPoint).toBe(MISSING_ENTRY_POINT);
        expect(getParseError(createSource(header)).code).toBe('entry-point-missing');
    });

    it.each(REJECTION_CASES.filter(rejection => !BODY_CHECK_CODES.has(rejection[3])))('rejects %s as the manifest does', (
        _description: string,
        header: readonly string[],
        line: number,
        code: GPUDecoderManifestErrorCode,
        detail: string
    ) => {
        const error = getHeaderParseError(header);

        expect({ code: error.code, detail: error.detail, line: error.line }).toEqual({ code, detail, line });
    });
});

describe('getGPUDecoderFacts', () => {
    it('reads the coded size, not the visible rectangle, and the stream\'s own bit depth', () => {
        const stream: GPUDecodeStreamFacts = {
            bitDepth: TEN_BIT_DEPTH,
            codedHeight: UHD_HEIGHT,
            codedWidth: UHD_WIDTH,
            visibleRectangle: { height: UHD_HEIGHT / 2, width: UHD_WIDTH / 2, x: 0, y: 0 }
        };

        const facts = getGPUDecoderFacts(stream, EIGHT_BIT_OUTPUT_FORMAT);

        expect(facts.get(GPU_DECODER_STREAM_FACTS.width)).toBe(UHD_WIDTH);
        expect(facts.get(GPU_DECODER_STREAM_FACTS.height)).toBe(UHD_HEIGHT);
        expect(facts.get(GPU_DECODER_STREAM_FACTS.bitDepth)).toBe(TEN_BIT_DEPTH);
        expect(facts.get(GPU_DECODER_OUTPUT_FACTS.bitDepth)).toBe(EIGHT_BIT_DEPTH);
    });

    it('holds exactly the facts a size or dispatch count expression may read', () => {
        const facts = getGPUDecoderFacts(UHD_STREAM, TEN_BIT_OUTPUT_FORMAT);

        expect(new Set(facts.keys())).toEqual(new Set(GPU_DECODER_FACT_IDENTIFIERS));
    });

    it('gives accepts conditions every fact they may read, the picture size beside the pool\'s', () => {
        const facts = getGPUDecoderAcceptsFacts({ ...UHD_STREAM, codedHeight: UHD_CODED_HEIGHT }, TEN_BIT_OUTPUT_FORMAT, { height: UHD_HEIGHT, width: UHD_WIDTH });

        expect(GPU_DECODER_ACCEPTS_IDENTIFIERS.every(identifier => facts.has(identifier))).toBe(true);
        expect(facts.get(GPU_DECODER_STREAM_FACTS.height)).toBe(UHD_CODED_HEIGHT);
        expect(facts.get(GPU_DECODER_PICTURE_FACTS.width)).toBe(UHD_WIDTH);
        expect(facts.get(GPU_DECODER_PICTURE_FACTS.height)).toBe(UHD_HEIGHT);
    });

    it.each(FORMAT_FACTS_CASES)('reads the %s output format\'s sample layout', (
        format: GPUDecoderOutputFormat,
        bitDepth: number,
        bytesPerSample: number,
        chromaWidthDivisor: number,
        chromaHeightDivisor: number
    ) => {
        const facts = getGPUDecoderFacts(UHD_STREAM, format);

        expect([
            facts.get(GPU_DECODER_OUTPUT_FACTS.bitDepth),
            facts.get(GPU_DECODER_OUTPUT_FACTS.bytesPerSample),
            facts.get(GPU_DECODER_OUTPUT_FACTS.chromaWidthDivisor),
            facts.get(GPU_DECODER_OUTPUT_FACTS.chromaHeightDivisor)
        ]).toEqual([ bitDepth, bytesPerSample, chromaWidthDivisor, chromaHeightDivisor ]);
    });
});

describe('evaluateGPUDecoderByteLength', () => {
    const facts = getGPUDecoderFacts(SIZE_STREAM, SIZE_FORMAT);

    it('rounds a fractional size up to whole bytes', () => {
        expect(evaluateGPUDecoderByteLength(parsePassExpression(FRACTIONAL_SIZE), facts, MINIMUM_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE))
            .toEqual(createSizeResult(FRACTIONAL_SIZE_BYTE_LENGTH));
        expect(evaluateGPUDecoderByteLength(parsePassExpression(HALF_BYTE_SIZE), facts, MINIMUM_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE))
            .toEqual(createSizeResult(MINIMUM_BYTE_LENGTH));
    });

    it('returns a whole size at either bound', () => {
        const expression = parsePassExpression(WHOLE_SIZE);

        expect(evaluateGPUDecoderByteLength(expression, facts, SIZE_STREAM_SAMPLE_COUNT, SIZE_STREAM_SAMPLE_COUNT))
            .toEqual(createSizeResult(SIZE_STREAM_SAMPLE_COUNT));
    });

    it('reads the output format\'s facts', () => {
        expect(evaluateGPUDecoderByteLength(parsePassExpression(OUTPUT_FACT_SIZE), facts, MINIMUM_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE))
            .toEqual(createSizeResult(EIGHT_BIT_DEPTH * OUTPUT_FACT_SIZE_FACTOR));
    });

    it('reports a size below the minimum or above the maximum with its rounded value', () => {
        expect(evaluateGPUDecoderByteLength(parsePassExpression(EMPTY_SIZE), facts, MINIMUM_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE))
            .toEqual(createInvalidResult(`0 < ${MINIMUM_BYTE_LENGTH}`));
        expect(evaluateGPUDecoderByteLength(parsePassExpression(WHOLE_SIZE), facts, MINIMUM_BYTE_LENGTH, SMALL_MAXIMUM_BYTE_LENGTH))
            .toEqual(createInvalidResult(`${SIZE_STREAM_SAMPLE_COUNT} > ${SMALL_MAXIMUM_BYTE_LENGTH}`));
        expect(evaluateGPUDecoderByteLength(parsePassExpression(FRACTIONAL_SIZE), facts, MINIMUM_BYTE_LENGTH, FRACTIONAL_SIZE_BYTE_LENGTH - 1))
            .toEqual(createInvalidResult(`${FRACTIONAL_SIZE_BYTE_LENGTH} > ${FRACTIONAL_SIZE_BYTE_LENGTH - 1}`));
    });

    it('reports an expression the facts cannot evaluate with the evaluator\'s message', () => {
        const streamOnlyFacts = createStreamFacts(SIZE_STREAM.codedWidth, SIZE_STREAM.codedHeight, SIZE_STREAM.bitDepth);

        expect(evaluateGPUDecoderByteLength(parsePassExpression(ZERO_DIVISOR_SIZE), facts, MINIMUM_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE))
            .toEqual(createInvalidResult(DIVISION_BY_ZERO_MESSAGE));
        expect(evaluateGPUDecoderByteLength(parsePassExpression(OUTPUT_FACT_SIZE), streamOnlyFacts, MINIMUM_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE))
            .toEqual(createInvalidResult(`Unknown identifier '${GPU_DECODER_OUTPUT_FACTS.bitDepth}'`));
    });

    it('reports a value past the safe integers as no byte count', () => {
        const hugeFacts = createStreamFacts(HUGE_WIDTH, HUGE_WIDTH, EIGHT_BIT_DEPTH);

        expect(evaluateGPUDecoderByteLength(parsePassExpression(HUGE_SIZE), hugeFacts, MINIMUM_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE))
            .toEqual(createInvalidResult(`${HUGE_SIZE_VALUE} is not a byte count`));
    });
});

describe('describeGPUDecoderErrorWord', () => {
    const errors: ReadonlyMap<number, string> = new Map([
        [ SLICE_ERROR_CODE, SLICE_ERROR_NAME ],
        [ HEADER_ERROR_CODE, HEADER_ERROR_NAME ]
    ]);

    it('names the error code and keeps the failing value', () => {
        expect(describeGPUDecoderErrorWord(errors, createErrorWord(SLICE_ERROR_CODE, FAILING_VALUE))).toBe(`${SLICE_ERROR_NAME}: ${FAILING_VALUE}`);
        expect(describeGPUDecoderErrorWord(errors, createErrorWord(SLICE_ERROR_CODE, 0))).toBe(`${SLICE_ERROR_NAME}: 0`);
    });

    it('names a code the decoder does not name by its number', () => {
        expect(describeGPUDecoderErrorWord(errors, createErrorWord(UNNAMED_ERROR_CODE, FAILING_VALUE))).toBe(`code ${UNNAMED_ERROR_CODE}: ${FAILING_VALUE}`);
        expect(describeGPUDecoderErrorWord(new Map(), createErrorWord(SLICE_ERROR_CODE, FAILING_VALUE))).toBe(`code ${SLICE_ERROR_CODE}: ${FAILING_VALUE}`);
    });

    it('reads a code in the word\'s sign bit as unsigned, whether the word is signed or not', () => {
        const unsignedWord = createErrorWord(HEADER_ERROR_CODE, FAILING_VALUE);
        // The same bits as a signed 32-bit integer, as WGSL i32 arithmetic or a bitwise operator leaves them
        const signedWord = unsignedWord | 0;

        expect(signedWord).toBeLessThan(0);
        expect(describeGPUDecoderErrorWord(errors, unsignedWord)).toBe(`${HEADER_ERROR_NAME}: ${FAILING_VALUE}`);
        expect(describeGPUDecoderErrorWord(errors, signedWord)).toBe(`${HEADER_ERROR_NAME}: ${FAILING_VALUE}`);
    });
});
