// Parses a WGSL video decoder's `//!` header into its manifest.
// The engine never parses the WGSL body; it only checks that the dispatched entry points exist and that the body leaves bindings and enable directives to the prelude.
// The engine book's decoder packages chapter describes the header.
import { DecoderHeaderError, getDecoderErrorName, readDecoderHeader, type DecoderHeaderDirective } from '../../packages/DecoderHeader';
import { findDecoderPackageIdFailure } from '../../packages/DecoderPackageIdentity';
import {
    collectPassExpressionIdentifiers,
    evaluatePassExpression,
    parsePassExpression,
    PassExpressionError
} from '../../../presentation/passes/PassExpression';
import type { PassExpression } from '../../../presentation/passes/PassTypes';
import { INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE } from '../../../presentation/WebGPUConstants';
import { getGPUDecoderFormatFacts, isGPUDecoderOutputFormat, type GPUDecoderOutputFormat } from './GPUDecodeFormats';
import {
    GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH,
    GPU_DECODE_MAXIMUM_SCRATCH_BUFFER_BYTE_LENGTH,
    GPU_DECODER_ERROR_CODE_SHIFT,
    GPU_DECODER_MAXIMUM_ERROR_CODE,
    GPU_DECODER_MAXIMUM_REFERENCES,
    GPU_DECODER_MAXIMUM_REORDER,
    GPU_DECODER_PARSER_ABI_VERSION,
    KIBIBYTE,
    MEBIBYTE
} from './GPUDecodeLimits';
import { GPU_DECODER_RESERVED_IDENTIFIERS } from './GPUDecoderPrelude';
import {
    type GPUDecodeStreamFacts,
    type GPUDecoderAcceptance,
    type GPUDecoderBuffer,
    type GPUDecoderDispatch,
    type GPUDecoderDispatchRepeat,
    type GPUDecoderErrorRecovery,
    type GPUDecoderManifest,
    type GPUDecoderPictureSize,
    isGPUDecoderErrorRecovery
} from './GPUDecodeTypes';

/** The stream facts a decoder's accepts constraint, dispatch counts, and sizes read, by their expression names. */
export const GPU_DECODER_STREAM_FACTS = Object.freeze({
    bitDepth: 'stream.bitDepth',
    height: 'stream.height',
    width: 'stream.width'
});

/** The output format facts a decoder's state and buffer sizes read, by their expression names. */
export const GPU_DECODER_OUTPUT_FACTS = Object.freeze({
    bitDepth: 'output.bitDepth',
    bytesPerSample: 'output.bytesPerSample',
    chromaHeightDivisor: 'output.chromaHeightDivisor',
    chromaWidthDivisor: 'output.chromaWidthDivisor'
});

/** Every stream fact name a decoder expression may read. */
export const GPU_DECODER_STREAM_IDENTIFIERS: readonly string[] = Object.freeze([
    GPU_DECODER_STREAM_FACTS.width,
    GPU_DECODER_STREAM_FACTS.height,
    GPU_DECODER_STREAM_FACTS.bitDepth
]);

/**
 * The picture facts only a decoder's accepts constraint reads, by their expression names: the size of the pictures a pool must hold,
 * before the rounding up to whole coding blocks that the stream facts' pool size takes.
 */
export const GPU_DECODER_PICTURE_FACTS = Object.freeze({
    height: 'picture.height',
    width: 'picture.width'
});

/** Every fact name an accepts constraint may read: the stream's, then the picture's. */
export const GPU_DECODER_ACCEPTS_IDENTIFIERS: readonly string[] = Object.freeze([
    ...GPU_DECODER_STREAM_IDENTIFIERS,
    GPU_DECODER_PICTURE_FACTS.width,
    GPU_DECODER_PICTURE_FACTS.height
]);

/** Every fact name a size or dispatch count expression may read: the stream's, then the output format's. */
export const GPU_DECODER_FACT_IDENTIFIERS: readonly string[] = Object.freeze([
    ...GPU_DECODER_STREAM_IDENTIFIERS,
    GPU_DECODER_OUTPUT_FACTS.bitDepth,
    GPU_DECODER_OUTPUT_FACTS.bytesPerSample,
    GPU_DECODER_OUTPUT_FACTS.chromaHeightDivisor,
    GPU_DECODER_OUTPUT_FACTS.chromaWidthDivisor
]);

/** The check a decoder's header or body failed, named after the directive or part it concerns. */
export type GPUDecoderManifestErrorCode =
    | 'accepts-expression'
    | 'accepts-identifier'
    | 'accepts-syntax'
    | 'body-binding'
    | 'body-enable'
    | 'buffer-duplicate'
    | 'buffer-expression'
    | 'buffer-identifier'
    | 'buffer-name'
    | 'buffer-reserved'
    | 'buffer-size'
    | 'buffer-syntax'
    | 'codec-duplicate'
    | 'codec-empty'
    | 'codec-syntax'
    | 'decoder-kind'
    | 'directive-missing'
    | 'directive-repeated'
    | 'directive-unknown'
    | 'dispatch-buffer'
    | 'dispatch-expression'
    | 'dispatch-identifier'
    | 'dispatch-indirect'
    | 'dispatch-syntax'
    | 'entry-point-missing'
    | 'entry-point-stage'
    | 'error-code'
    | 'error-duplicate'
    | 'error-recovery'
    | 'error-syntax'
    | 'header-missing'
    | 'header-syntax'
    | 'id-length'
    | 'id-syntax'
    | 'monochrome-syntax'
    | 'name-empty'
    | 'output-duplicate'
    | 'output-format'
    | 'packet-size'
    | 'packet-syntax'
    | 'parser-syntax'
    | 'parser-version'
    | 'references-limit'
    | 'references-syntax'
    | 'reorder-limit'
    | 'reorder-syntax'
    | 'repeat-expression'
    | 'repeat-identifier'
    | 'repeat-incomplete'
    | 'repeat-nested'
    | 'repeat-syntax'
    | 'requires-duplicate'
    | 'requires-syntax'
    | 'state-expression'
    | 'state-identifier'
    | 'state-size';

const IDENTIFIER_PATTERN = /^[A-Za-z_]\w*$/;
const CODEC_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SIZE_PATTERN = /^(\d+)\s*(B|KiB|MiB)?$/;
const COUNT_PATTERN = /^\d+$/;
const ACCEPTS_PATTERN = /^codec\s+in\s+\[([^\]]*)\]\s*(?:,(.*))?$/;
const INDIRECT_DISPATCH_PATTERN = /^indirect\s+(\S+)$/;
// The buffer attribute that makes a scratch buffer usable for indirect dispatch
const INDIRECT_ATTRIBUTE = 'indirect';
const FEATURE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const BINDING_ATTRIBUTE_PATTERN = /@(group|binding)\s*\(/;
const ENABLE_DIRECTIVE_PATTERN = /^[ \t]*enable\s/m;
const COMPUTE_ATTRIBUTE = '@compute';
const QUOTE = '"';
const MINIMUM_DISPATCH_COUNT_COUNT = 1;
const MAXIMUM_DISPATCH_COUNT_COUNT = 3;
// The characters that end a declaration, after which the next declaration's attributes start
const STATEMENT_END = ';';
const BLOCK_END = '}';
// An error line's parts: its code and name, then an optional recovery
const ERROR_PART_COUNT = 2;
const RECOVERABLE_ERROR_PART_COUNT = 3;
const REPEAT_PART_COUNT = 2;
const MINIMUM_REPEAT_DISPATCH_COUNT = 1;
// A buffer, the state, and a packet hold at least one byte; an indirect buffer holds its arguments
const MINIMUM_BYTE_LENGTH = 1;
const EMPTY_STATE_BYTE_LENGTH = 0;
const MINIMUM_ERROR_CODE = 1;

const REPEATABLE_DIRECTIVES: ReadonlySet<string> = new Set([ 'buffer', 'dispatch', 'error', 'repeat' ]);

const REQUIRED_DIRECTIVES: readonly string[] = [ 'id', 'name', 'decoder', 'accepts', 'output', 'packet', 'dispatch' ];

const VIDEO_DECODER_KIND = 'video';
// The one value of the monochrome directive, by which a decoder declares that it takes 4:0:0 streams
const MONOCHROME_SUPPORTED_VALUE = 'yes';

/** A malformed decoder header or body: the failed check, a terse detail with the failing value, and the 1-based source line. */
export class GPUDecoderManifestError extends Error {
    readonly code: GPUDecoderManifestErrorCode;
    readonly detail: string;
    readonly line: number;

    constructor(code: GPUDecoderManifestErrorCode, detail: string, line: number) {
        super(`${code}: ${detail}`);
        this.name = 'GPUDecoderManifestError';
        this.code = code;
        this.detail = detail;
        this.line = line;
    }
}

type LocatedDispatch = {
    dispatch: GPUDecoderDispatch
    line: number
};

/** A repeat whose run still waits for dispatches: how many, and the repeat's line. */
type OpenRepeat = {
    line: number
    remainingDispatchCount: number
    repeat: GPUDecoderDispatchRepeat
};

/** The codes of one expression directive's checks. */
type ExpressionCodes = {
    expression: GPUDecoderManifestErrorCode
    identifier: GPUDecoderManifestErrorCode
};

/** The codes of one size directive's checks. */
type SizeCodes = {
    expression: GPUDecoderManifestErrorCode
    identifier: GPUDecoderManifestErrorCode
    size: GPUDecoderManifestErrorCode
};

type ManifestDraft = {
    accepts: GPUDecoderAcceptance | null
    buffers: GPUDecoderBuffer[]
    dispatches: LocatedDispatch[]
    errorRecoveries: Map<number, GPUDecoderErrorRecovery>
    errors: Map<number, string>
    id: string
    monochrome: boolean
    name: string
    openRepeat: OpenRepeat | null
    outputFormats: GPUDecoderOutputFormat[] | null
    packetByteLength: number
    parser: number | null
    references: number
    reorder: number
    repeats: GPUDecoderDispatchRepeat[]
    requiredFeatures: string[]
    stateByteLength: PassExpression
};

const ACCEPTS_EXPRESSION_CODES: ExpressionCodes = { expression: 'accepts-expression', identifier: 'accepts-identifier' };
const DISPATCH_EXPRESSION_CODES: ExpressionCodes = { expression: 'dispatch-expression', identifier: 'dispatch-identifier' };
const REPEAT_EXPRESSION_CODES: ExpressionCodes = { expression: 'repeat-expression', identifier: 'repeat-identifier' };
const STATE_SIZE_CODES: SizeCodes = { expression: 'state-expression', identifier: 'state-identifier', size: 'state-size' };
const BUFFER_SIZE_CODES: SizeCodes = { expression: 'buffer-expression', identifier: 'buffer-identifier', size: 'buffer-size' };

/** Quotes header text in a detail, so an empty or spaced value stays visible. */
function quote(text: string): string {
    return `'${text}'`;
}

function getUnitByteLength(unit: string | undefined): number {
    switch (unit) {
        case 'KiB':
            return KIBIBYTE;
        case 'MiB':
            return MEBIBYTE;
        default:
            return 1;
    }
}

/** Splits text at commas outside parentheses, brackets, and quotes. */
function splitTopLevel(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quoted = false;
    let partStart = 0;
    for (let characterIndex = 0; characterIndex < text.length; characterIndex += 1) {
        const character = text[characterIndex];
        if (character === QUOTE) {
            quoted = !quoted;
        } else if (!quoted) {
            switch (character) {
                case '(':
                case '[':
                    depth += 1;
                    break;
                case ')':
                case ']':
                    depth -= 1;
                    break;
                case ',':
                    if (depth === 0) {
                        parts.push(text.slice(partStart, characterIndex).trim());
                        partStart = characterIndex + 1;
                    }
                    break;
                default:
                    break;
            }
        }
    }
    parts.push(text.slice(partStart).trim());
    return parts;
}

/** Parses a byte count with an optional B, KiB, or MiB unit. */
function parseByteLength(text: string, line: number, code: GPUDecoderManifestErrorCode): number {
    const match = SIZE_PATTERN.exec(text);
    if (!match) {
        throw new GPUDecoderManifestError(code, quote(text), line);
    }
    return Number(match[1]) * getUnitByteLength(match[2]);
}

/** Requires a byte length within [minimum, maximum], reporting `<subject> <value> < <minimum>` or `<subject> <value> > <maximum>`. */
function requireByteRange(
    byteLength: number,
    minimum: number,
    maximum: number,
    line: number,
    code: GPUDecoderManifestErrorCode,
    subject: string
): void {
    const prefix = subject.length > 0 ? `${subject} ` : '';
    if (byteLength < minimum) {
        throw new GPUDecoderManifestError(code, `${prefix}${byteLength} < ${minimum}`, line);
    }
    if (byteLength > maximum) {
        throw new GPUDecoderManifestError(code, `${prefix}${byteLength} > ${maximum}`, line);
    }
}

function parseCount(
    text: string,
    line: number,
    syntaxCode: GPUDecoderManifestErrorCode,
    limitCode: GPUDecoderManifestErrorCode,
    maximum: number
): number {
    if (!COUNT_PATTERN.test(text)) {
        throw new GPUDecoderManifestError(syntaxCode, quote(text), line);
    }
    const count = Number(text);
    if (count > maximum) {
        throw new GPUDecoderManifestError(limitCode, `${count} > ${maximum}`, line);
    }
    return count;
}

function requireIdentifier(text: string, line: number, code: GPUDecoderManifestErrorCode): string {
    if (!IDENTIFIER_PATTERN.test(text)) {
        throw new GPUDecoderManifestError(code, quote(text), line);
    }
    return text;
}

/** Parses a header expression that reads only the given fact names. */
function parseFactExpression(text: string, line: number, codes: ExpressionCodes, identifiers: readonly string[]): PassExpression {
    let expression: PassExpression;
    try {
        expression = parsePassExpression(text);
    } catch (error) {
        if (error instanceof PassExpressionError) {
            throw new GPUDecoderManifestError(codes.expression, `${quote(text)} ${error.message}`, line);
        }
        throw error;
    }
    for (const identifier of collectPassExpressionIdentifiers(expression)) {
        if (!identifiers.includes(identifier)) {
            throw new GPUDecoderManifestError(codes.identifier, quote(identifier), line);
        }
    }
    return expression;
}

/**
 * Parses a size: a byte count with an optional unit, checked against [minimum, maximum] here, or an expression over the stream and output facts.
 * The session checks an expression's value when it evaluates it for a stream.
 */
function parseSizeExpression(text: string, line: number, codes: SizeCodes, minimum: number, maximum: number, subject: string): PassExpression {
    const match = SIZE_PATTERN.exec(text);
    if (match) {
        const byteLength = Number(match[1]) * getUnitByteLength(match[2]);
        requireByteRange(byteLength, minimum, maximum, line, codes.size, subject);
        return { kind: 'number', value: byteLength };
    }
    return parseFactExpression(text, line, { expression: codes.expression, identifier: codes.identifier }, GPU_DECODER_FACT_IDENTIFIERS);
}

function unquote(text: string): string {
    return text.length >= 2 && text.startsWith(QUOTE) && text.endsWith(QUOTE) ? text.slice(1, -1) : text;
}

function parseCodecFamilies(listText: string, line: number): string[] {
    const codecs: string[] = [];
    for (const [ itemIndex, item ] of splitTopLevel(listText).entries()) {
        const codec = unquote(item);
        if (codec.length === 0) {
            throw new GPUDecoderManifestError('codec-empty', `position ${itemIndex + 1}`, line);
        }
        if (!CODEC_PATTERN.test(codec)) {
            throw new GPUDecoderManifestError('codec-syntax', quote(codec), line);
        }
        if (codecs.includes(codec)) {
            throw new GPUDecoderManifestError('codec-duplicate', quote(codec), line);
        }
        codecs.push(codec);
    }
    return codecs;
}

/** Parses `codec in [a, b], <condition>, ...`; several conditions must all hold. */
function parseAccepts(value: string, line: number): GPUDecoderAcceptance {
    const match = ACCEPTS_PATTERN.exec(value);
    if (!match) {
        throw new GPUDecoderManifestError('accepts-syntax', quote(value), line);
    }
    const codecs = parseCodecFamilies(match[1], line);
    const conditionsText = match[2]?.trim() ?? '';
    if (conditionsText.length === 0) {
        return { codecs, constraint: null };
    }
    let constraint: PassExpression | null = null;
    for (const conditionText of splitTopLevel(conditionsText)) {
        const condition = parseFactExpression(conditionText, line, ACCEPTS_EXPRESSION_CODES, GPU_DECODER_ACCEPTS_IDENTIFIERS);
        constraint = constraint ? { kind: 'binary', left: constraint, operator: '&&', right: condition } : condition;
    }
    return { codecs, constraint };
}

/** Parses `<name>, <size>` with an optional `indirect` in any position after the name. */
function parseBuffer(value: string, line: number, existingBuffers: readonly GPUDecoderBuffer[]): GPUDecoderBuffer {
    const [ nameText, ...attributes ] = splitTopLevel(value);
    const name = requireIdentifier(nameText, line, 'buffer-name');
    if (GPU_DECODER_RESERVED_IDENTIFIERS.has(name)) {
        throw new GPUDecoderManifestError('buffer-reserved', quote(name), line);
    }
    if (existingBuffers.some(buffer => buffer.name === name)) {
        throw new GPUDecoderManifestError('buffer-duplicate', quote(name), line);
    }
    const sizeTexts = attributes.filter(attribute => attribute !== INDIRECT_ATTRIBUTE);
    const indirectCount = attributes.length - sizeTexts.length;
    if (sizeTexts.length !== 1 || indirectCount > 1) {
        throw new GPUDecoderManifestError('buffer-syntax', quote(value), line);
    }
    const indirect = indirectCount === 1;
    const minimumByteLength = indirect ? INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH : MINIMUM_BYTE_LENGTH;
    // The session checks the size against the device's own buffer and binding limits
    const byteLength = parseSizeExpression(sizeTexts[0], line, BUFFER_SIZE_CODES, minimumByteLength, GPU_DECODE_MAXIMUM_SCRATCH_BUFFER_BYTE_LENGTH, quote(name));
    return { byteLength, indirect, name };
}

/** Parses `<entry point>, <count>[, <count>[, <count>]]` or `<entry point>, indirect <buffer>`. */
function parseDispatch(value: string, line: number): GPUDecoderDispatch {
    const [ entryPointText, ...countTexts ] = splitTopLevel(value);
    const entryPoint = requireIdentifier(entryPointText, line, 'dispatch-syntax');
    const indirectMatch = countTexts.length === 1 ? INDIRECT_DISPATCH_PATTERN.exec(countTexts[0]) : null;
    if (indirectMatch) {
        return {
            entryPoint,
            indirectBuffer: requireIdentifier(indirectMatch[1], line, 'dispatch-syntax'),
            workgroupCounts: null
        };
    }
    if (countTexts.length < MINIMUM_DISPATCH_COUNT_COUNT || countTexts.length > MAXIMUM_DISPATCH_COUNT_COUNT) {
        throw new GPUDecoderManifestError('dispatch-syntax', quote(value), line);
    }
    const counts: PassExpression[] = countTexts.map(countText => parseFactExpression(
        countText,
        line,
        DISPATCH_EXPRESSION_CODES,
        GPU_DECODER_FACT_IDENTIFIERS
    ));
    while (counts.length < MAXIMUM_DISPATCH_COUNT_COUNT) {
        counts.push({ kind: 'number', value: 1 });
    }
    return {
        entryPoint,
        indirectBuffer: null,
        workgroupCounts: [ counts[0], counts[1], counts[2] ]
    };
}

/** Parses `<count>, <dispatches>`: the run of the next dispatches directives repeats count times, an expression the session evaluates per stream. */
function parseRepeat(value: string, line: number, firstDispatch: number): GPUDecoderDispatchRepeat {
    const parts = splitTopLevel(value);
    if (parts.length !== REPEAT_PART_COUNT || !COUNT_PATTERN.test(parts[1]) || Number(parts[1]) < MINIMUM_REPEAT_DISPATCH_COUNT) {
        throw new GPUDecoderManifestError('repeat-syntax', quote(value), line);
    }
    return {
        count: parseFactExpression(parts[0], line, REPEAT_EXPRESSION_CODES, GPU_DECODER_FACT_IDENTIFIERS),
        dispatchCount: Number(parts[1]),
        firstDispatch
    };
}

/** Opens a repeat's run; the dispatches directives that follow fill it. */
function openRepeat(draft: ManifestDraft, value: string, line: number): void {
    if (draft.openRepeat) {
        throw new GPUDecoderManifestError('repeat-nested', `${draft.openRepeat.remainingDispatchCount} dispatches of line ${draft.openRepeat.line} missing`, line);
    }
    const repeat = parseRepeat(value, line, draft.dispatches.length);
    draft.repeats.push(repeat);
    draft.openRepeat = { line, remainingDispatchCount: repeat.dispatchCount, repeat };
}

/** Adds a dispatch, counting it toward an open repeat's run. */
function addDispatch(draft: ManifestDraft, value: string, line: number): void {
    draft.dispatches.push({ dispatch: parseDispatch(value, line), line });
    if (draft.openRepeat) {
        draft.openRepeat.remainingDispatchCount -= 1;
        if (draft.openRepeat.remainingDispatchCount === 0) {
            draft.openRepeat = null;
        }
    }
}

/** An error line: its code, its name, and its recovery, or null for a fatal error. */
type ParsedError = Readonly<{
    code: number
    name: string
    recovery: GPUDecoderErrorRecovery | null
}>;

/**
 * Parses `<code>, <name>[, <recovery>]`: a code from 1 to 255, the high byte of a status error word, the identifier that names it,
 * and how the package recovers from it, `conceal`, `drop`, or `resync`; without one the error ends the attempt.
 */
function parseError(value: string, line: number, errors: ReadonlyMap<number, string>): ParsedError {
    const parts = splitTopLevel(value);
    if (
        (parts.length !== ERROR_PART_COUNT && parts.length !== RECOVERABLE_ERROR_PART_COUNT)
        || !COUNT_PATTERN.test(parts[0])
        || !IDENTIFIER_PATTERN.test(parts[1])
    ) {
        throw new GPUDecoderManifestError('error-syntax', quote(value), line);
    }
    const code = Number(parts[0]);
    if (code < MINIMUM_ERROR_CODE || code > GPU_DECODER_MAXIMUM_ERROR_CODE) {
        throw new GPUDecoderManifestError('error-code', `${code} outside [${MINIMUM_ERROR_CODE}, ${GPU_DECODER_MAXIMUM_ERROR_CODE}]`, line);
    }
    if (errors.has(code) || [ ...errors.values() ].includes(parts[1])) {
        throw new GPUDecoderManifestError('error-duplicate', quote(value), line);
    }
    const recoveryText = parts.at(ERROR_PART_COUNT) ?? null;
    if (recoveryText !== null && !isGPUDecoderErrorRecovery(recoveryText)) {
        throw new GPUDecoderManifestError('error-recovery', quote(recoveryText), line);
    }
    return { code, name: parts[1], recovery: recoveryText };
}

function parseParserVersion(value: string, line: number): number {
    if (!COUNT_PATTERN.test(value)) {
        throw new GPUDecoderManifestError('parser-syntax', quote(value), line);
    }
    const version = Number(value);
    if (version !== GPU_DECODER_PARSER_ABI_VERSION) {
        throw new GPUDecoderManifestError('parser-version', `${version}, expected ${GPU_DECODER_PARSER_ABI_VERSION}`, line);
    }
    return version;
}

function parseRequiredFeatures(value: string, line: number): string[] {
    const features: string[] = [];
    for (const feature of splitTopLevel(value)) {
        if (!FEATURE_PATTERN.test(feature)) {
            throw new GPUDecoderManifestError('requires-syntax', quote(feature), line);
        }
        if (features.includes(feature)) {
            throw new GPUDecoderManifestError('requires-duplicate', quote(feature), line);
        }
        features.push(feature);
    }
    return features;
}

/** Parses the formats a decoder writes, in the order it lists them. */
function parseOutputFormats(value: string, line: number): GPUDecoderOutputFormat[] {
    const formats: GPUDecoderOutputFormat[] = [];
    for (const format of splitTopLevel(value)) {
        if (!isGPUDecoderOutputFormat(format)) {
            throw new GPUDecoderManifestError('output-format', quote(format), line);
        }
        if (formats.includes(format)) {
            throw new GPUDecoderManifestError('output-duplicate', quote(format), line);
        }
        formats.push(format);
    }
    return formats;
}

function parseName(value: string, line: number): string {
    if (value.length === 0) {
        throw new GPUDecoderManifestError('name-empty', quote(value), line);
    }
    return value;
}

/** Reads the package's id, which stays the same across its versions. */
function parseId(value: string, line: number): string {
    const failure = findDecoderPackageIdFailure(value);
    if (failure) {
        throw new GPUDecoderManifestError(failure.code, failure.detail, line);
    }
    return value;
}

function requireVideoDecoder(value: string, line: number): void {
    if (value !== VIDEO_DECODER_KIND) {
        throw new GPUDecoderManifestError('decoder-kind', quote(value), line);
    }
}

/** Reads the monochrome directive, whose one value declares that the decoder takes 4:0:0 streams; a decoder without it takes none. */
function parseMonochrome(value: string, line: number): boolean {
    if (value !== MONOCHROME_SUPPORTED_VALUE) {
        throw new GPUDecoderManifestError('monochrome-syntax', quote(value), line);
    }
    return true;
}

/** Applies one directive to the draft. */
function applyDirective(draft: ManifestDraft, directive: DecoderHeaderDirective): void {
    const { line, value } = directive;
    switch (directive.name) {
        case 'id':
            draft.id = parseId(value, line);
            return;
        case 'name':
            draft.name = parseName(value, line);
            return;
        case 'decoder':
            requireVideoDecoder(value, line);
            return;
        case 'accepts':
            draft.accepts = parseAccepts(value, line);
            return;
        case 'output':
            draft.outputFormats = parseOutputFormats(value, line);
            return;
        case 'monochrome':
            draft.monochrome = parseMonochrome(value, line);
            return;
        case 'references':
            draft.references = parseCount(value, line, 'references-syntax', 'references-limit', GPU_DECODER_MAXIMUM_REFERENCES);
            return;
        case 'reorder':
            draft.reorder = parseCount(value, line, 'reorder-syntax', 'reorder-limit', GPU_DECODER_MAXIMUM_REORDER);
            return;
        case 'packet':
            draft.packetByteLength = parseByteLength(value, line, 'packet-syntax');
            requireByteRange(draft.packetByteLength, MINIMUM_BYTE_LENGTH, GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH, line, 'packet-size', '');
            return;
        case 'state':
            draft.stateByteLength = parseSizeExpression(value, line, STATE_SIZE_CODES, EMPTY_STATE_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE, '');
            return;
        case 'buffer':
            draft.buffers.push(parseBuffer(value, line, draft.buffers));
            return;
        case 'requires':
            draft.requiredFeatures = parseRequiredFeatures(value, line);
            return;
        case 'dispatch':
            addDispatch(draft, value, line);
            return;
        case 'repeat':
            openRepeat(draft, value, line);
            return;
        case 'error': {
            const parsed = parseError(value, line, draft.errors);
            draft.errors.set(parsed.code, parsed.name);
            if (parsed.recovery !== null) {
                draft.errorRecoveries.set(parsed.code, parsed.recovery);
            }
            return;
        }
        case 'parser':
            draft.parser = parseParserVersion(value, line);
            return;
        default:
            throw new GPUDecoderManifestError('directive-unknown', quote(directive.name), line);
    }
}

/** Reads a decoder source's header, reporting a line that is no directive as the 'header-syntax' check. */
function readHeader(lines: readonly string[]): { bodyFirstLine: number; directives: DecoderHeaderDirective[] } {
    try {
        return readDecoderHeader(lines);
    } catch (error) {
        if (error instanceof DecoderHeaderError) {
            throw new GPUDecoderManifestError('header-syntax', error.detail, error.line);
        }
        throw error;
    }
}

function requireDirectiveSet(directives: readonly DecoderHeaderDirective[], bodyFirstLine: number): void {
    const seen = new Set<string>();
    for (const directive of directives) {
        if (seen.has(directive.name) && !REPEATABLE_DIRECTIVES.has(directive.name)) {
            throw new GPUDecoderManifestError('directive-repeated', quote(directive.name), directive.line);
        }
        seen.add(directive.name);
    }
    for (const required of REQUIRED_DIRECTIVES) {
        if (!seen.has(required)) {
            throw new GPUDecoderManifestError('directive-missing', quote(required), Math.max(1, bodyFirstLine - 1));
        }
    }
}

function getBodyLine(body: string, bodyFirstLine: number, characterIndex: number): number {
    let line = bodyFirstLine;
    for (let index = 0; index < characterIndex; index += 1) {
        if (body[index] === '\n') {
            line += 1;
        }
    }
    return line;
}

/** Requires `fn <entry point>(` in the body, declared with @compute among the attributes before it. */
function requireComputeEntryPoint(body: string, located: LocatedDispatch): void {
    const entryPoint = located.dispatch.entryPoint;
    // Entry points are validated identifiers, so they are safe inside a pattern
    const declaration = new RegExp(String.raw`\bfn\s+${entryPoint}\s*\(`).exec(body);
    if (!declaration) {
        throw new GPUDecoderManifestError('entry-point-missing', quote(entryPoint), located.line);
    }
    // The attributes of a declaration follow the previous declaration's ';' or '}'
    const attributesStart = Math.max(
        body.lastIndexOf(STATEMENT_END, declaration.index - 1),
        body.lastIndexOf(BLOCK_END, declaration.index - 1)
    ) + 1;
    if (!body.slice(attributesStart, declaration.index).includes(COMPUTE_ATTRIBUTE)) {
        throw new GPUDecoderManifestError('entry-point-stage', quote(entryPoint), located.line);
    }
}

function requireIndirectBuffer(buffers: readonly GPUDecoderBuffer[], located: LocatedDispatch): void {
    const bufferName = located.dispatch.indirectBuffer;
    if (bufferName === null) {
        return;
    }
    const buffer = buffers.find(candidate => candidate.name === bufferName);
    if (!buffer) {
        throw new GPUDecoderManifestError('dispatch-buffer', quote(bufferName), located.line);
    }
    if (!buffer.indirect) {
        throw new GPUDecoderManifestError('dispatch-indirect', quote(bufferName), located.line);
    }
}

/** Returns the trimmed text of the body line that starts at characterIndex. */
function getLineText(body: string, characterIndex: number): string {
    const lineEnd = body.indexOf('\n', characterIndex);
    return body.slice(characterIndex, lineEnd < 0 ? body.length : lineEnd).trim();
}

function requirePreludeOwnedDeclarations(body: string, bodyFirstLine: number): void {
    const binding = BINDING_ATTRIBUTE_PATTERN.exec(body);
    if (binding) {
        throw new GPUDecoderManifestError('body-binding', quote(`@${binding[1]}`), getBodyLine(body, bodyFirstLine, binding.index));
    }
    const enable = ENABLE_DIRECTIVE_PATTERN.exec(body);
    if (enable) {
        throw new GPUDecoderManifestError('body-enable', quote(getLineText(body, enable.index)), getBodyLine(body, bodyFirstLine, enable.index));
    }
}

/** Returns a directive's value that requireDirectiveSet guarantees, for the type checker. */
function requireParsed<Value>(value: Value | null, directive: string, line: number): Value {
    if (value === null) {
        throw new GPUDecoderManifestError('directive-missing', quote(directive), line);
    }
    return value;
}

/**
 * Parses and validates a decoder's `//!` header, and checks its body against the dispatch sequence.
 * Throws a GPUDecoderManifestError with the failed check's code, a terse detail, and the source line.
 */
export function parseGPUDecoderManifest(source: string): GPUDecoderManifest {
    const lines = source.split(/\r?\n/);
    const { bodyFirstLine, directives } = readHeader(lines);
    if (directives.length === 0) {
        throw new GPUDecoderManifestError('header-missing', quote(lines[0] ?? ''), 1);
    }
    requireDirectiveSet(directives, bodyFirstLine);

    const draft: ManifestDraft = {
        accepts: null,
        buffers: [],
        dispatches: [],
        errorRecoveries: new Map<number, GPUDecoderErrorRecovery>(),
        errors: new Map<number, string>(),
        id: '',
        monochrome: false,
        name: '',
        openRepeat: null,
        outputFormats: null,
        packetByteLength: 0,
        parser: null,
        references: 0,
        reorder: 0,
        repeats: [],
        requiredFeatures: [],
        stateByteLength: { kind: 'number', value: EMPTY_STATE_BYTE_LENGTH }
    };
    for (const directive of directives) {
        applyDirective(draft, directive);
    }
    if (draft.openRepeat) {
        const { line, remainingDispatchCount, repeat } = draft.openRepeat;
        throw new GPUDecoderManifestError('repeat-incomplete', `${remainingDispatchCount} of ${repeat.dispatchCount} dispatches missing`, line);
    }
    const outputFormats = requireParsed(draft.outputFormats, 'output', 1);

    const body = lines.slice(bodyFirstLine - 1).join('\n');
    requirePreludeOwnedDeclarations(body, bodyFirstLine);
    // A decoder may dispatch one entry point many times, as HEVC does once per wave; its declaration is checked at its first dispatch
    const checkedEntryPoints = new Set<string>();
    for (const located of draft.dispatches) {
        requireIndirectBuffer(draft.buffers, located);
        if (!checkedEntryPoints.has(located.dispatch.entryPoint)) {
            requireComputeEntryPoint(body, located);
            checkedEntryPoints.add(located.dispatch.entryPoint);
        }
    }

    return {
        accepts: requireParsed(draft.accepts, 'accepts', 1),
        body,
        bodyFirstLine,
        buffers: draft.buffers,
        dispatches: draft.dispatches.map(located => located.dispatch),
        errorRecoveries: draft.errorRecoveries,
        errors: draft.errors,
        id: draft.id,
        monochrome: draft.monochrome,
        name: draft.name,
        outputFormats,
        packetByteLength: draft.packetByteLength,
        parser: draft.parser,
        references: draft.references,
        reorder: draft.reorder,
        repeats: draft.repeats,
        requiredFeatures: draft.requiredFeatures,
        stateByteLength: draft.stateByteLength
    };
}

/**
 * Returns the facts a decoder's accepts constraint reads: the stream facts of its pool, as getGPUDecoderFacts gives them,
 * and the size of the pictures the pool must hold, before the pool's rounding up to whole coding blocks.
 */
export function getGPUDecoderAcceptsFacts(
    stream: Pick<GPUDecodeStreamFacts, 'bitDepth' | 'codedHeight' | 'codedWidth'>,
    format: GPUDecoderOutputFormat,
    pictureSize: GPUDecoderPictureSize
): ReadonlyMap<string, number> {
    const facts = new Map<string, number>(getGPUDecoderFacts(stream, format));
    facts.set(GPU_DECODER_PICTURE_FACTS.width, pictureSize.width);
    facts.set(GPU_DECODER_PICTURE_FACTS.height, pictureSize.height);
    return facts;
}

/** Returns the facts a decoder's size and dispatch count expressions read, for a stream decoded into one output format. */
export function getGPUDecoderFacts(stream: Pick<GPUDecodeStreamFacts, 'bitDepth' | 'codedHeight' | 'codedWidth'>, format: GPUDecoderOutputFormat): ReadonlyMap<string, number> {
    const formatFacts = getGPUDecoderFormatFacts(format);
    return new Map<string, number>([
        [ GPU_DECODER_STREAM_FACTS.width, stream.codedWidth ],
        [ GPU_DECODER_STREAM_FACTS.height, stream.codedHeight ],
        [ GPU_DECODER_STREAM_FACTS.bitDepth, stream.bitDepth ],
        [ GPU_DECODER_OUTPUT_FACTS.bitDepth, formatFacts.bitDepth ],
        [ GPU_DECODER_OUTPUT_FACTS.bytesPerSample, formatFacts.bytesPerSample ],
        [ GPU_DECODER_OUTPUT_FACTS.chromaHeightDivisor, formatFacts.chromaHeightDivisor ],
        [ GPU_DECODER_OUTPUT_FACTS.chromaWidthDivisor, formatFacts.chromaWidthDivisor ]
    ]);
}

/** A size expression's value for a stream: whole bytes, or a terse detail of why the expression gives no size. */
export type GPUDecoderByteLengthResult =
    | Readonly<{ byteLength: number; kind: 'size' }>
    | Readonly<{ detail: string; kind: 'invalid' }>;

function invalidByteLength(detail: string): GPUDecoderByteLengthResult {
    return { detail, kind: 'invalid' };
}

/**
 * Evaluates a size expression to whole bytes within [minimum, maximum]; a fractional value rounds up.
 * An invalid result's `<value>` detail is the caller's to prefix with its subject.
 */
export function evaluateGPUDecoderByteLength(
    expression: PassExpression,
    facts: ReadonlyMap<string, number>,
    minimum: number,
    maximum: number
): GPUDecoderByteLengthResult {
    let value: number;
    try {
        value = evaluatePassExpression(expression, facts);
    } catch (error) {
        if (error instanceof PassExpressionError) {
            return invalidByteLength(error.message);
        }
        throw error;
    }
    const byteLength = Math.ceil(value);
    if (!Number.isSafeInteger(byteLength)) {
        return invalidByteLength(`${value} is not a byte count`);
    }
    if (byteLength < minimum) {
        return invalidByteLength(`${byteLength} < ${minimum}`);
    }
    if (byteLength > maximum) {
        return invalidByteLength(`${byteLength} > ${maximum}`);
    }
    return { byteLength, kind: 'size' };
}

/** Returns `<name>: <value>` for a status error word, `(code << 24) | value`, by the decoder's error names, or `code <code>: <value>` for a code it does not name. */
export function describeGPUDecoderErrorWord(errors: ReadonlyMap<number, string>, errorWord: number): string {
    const code = errorWord >>> GPU_DECODER_ERROR_CODE_SHIFT;
    const value = errorWord & ((1 << GPU_DECODER_ERROR_CODE_SHIFT) - 1);
    return `${getDecoderErrorName(errors, code)}: ${value}`;
}
