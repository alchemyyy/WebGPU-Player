// Parses a user WGSL video decoder's `//!` header into its manifest.
// The engine never parses the WGSL body; it only checks that the dispatched entry points exist and that the body leaves bindings and enable directives to the prelude.
// overhual/decoders.md in the engine root describes the module format.
import {
    collectPassExpressionIdentifiers,
    parsePassExpression,
    PassExpressionError
} from '../../presentation/passes/PassExpression';
import type { PassExpression } from '../../presentation/passes/PassTypes';
import { INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE } from '../../presentation/WebGPUConstants';
import { isGPUDecoderOutputFormat, type GPUDecoderOutputFormat } from './GPUDecodeFormats';
import {
    GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH,
    GPU_DECODER_MAXIMUM_REFERENCES,
    GPU_DECODER_MAXIMUM_REORDER,
    KIBIBYTE,
    MEBIBYTE
} from './GPUDecodeLimits';
import { GPU_DECODER_RESERVED_IDENTIFIERS } from './GPUDecoderPrelude';
import type {
    GPUDecoderAcceptance,
    GPUDecoderBuffer,
    GPUDecoderDispatch,
    GPUDecoderManifest,
    GPUDecoderVector
} from './GPUDecodeTypes';

/** The stream facts a decoder's accepts constraint and dispatch counts read, by their expression names. */
export const GPU_DECODER_STREAM_FACTS = Object.freeze({
    bitDepth: 'stream.bitDepth',
    height: 'stream.height',
    width: 'stream.width'
});

/** Every stream fact name a decoder expression may read. */
export const GPU_DECODER_STREAM_IDENTIFIERS: readonly string[] = Object.freeze([
    GPU_DECODER_STREAM_FACTS.width,
    GPU_DECODER_STREAM_FACTS.height,
    GPU_DECODER_STREAM_FACTS.bitDepth
]);

/** The check a decoder's header or body failed, named after the directive or part it concerns. */
export type GPUDecoderManifestErrorCode =
    | 'accepts-expression'
    | 'accepts-identifier'
    | 'accepts-syntax'
    | 'body-binding'
    | 'body-enable'
    | 'buffer-duplicate'
    | 'buffer-name'
    | 'buffer-reserved'
    | 'buffer-size'
    | 'buffer-syntax'
    | 'codec-duplicate'
    | 'codec-empty'
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
    | 'header-missing'
    | 'header-syntax'
    | 'name-empty'
    | 'output-format'
    | 'packet-size'
    | 'packet-syntax'
    | 'references-limit'
    | 'references-syntax'
    | 'reorder-limit'
    | 'reorder-syntax'
    | 'requires-duplicate'
    | 'requires-syntax'
    | 'state-size'
    | 'state-syntax'
    | 'vector-frames'
    | 'vector-syntax';

const HEADER_PREFIX = '//!';
const DIRECTIVE_PATTERN = /^\/\/!\s*([A-Za-z]+)\s*:(.*)$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_]\w*$/;
const SIZE_PATTERN = /^(\d+)\s*(B|KiB|MiB)?$/;
const COUNT_PATTERN = /^\d+$/;
const ACCEPTS_PATTERN = /^codec\s+in\s+\[([^\]]*)\]\s*(?:,(.*))?$/;
const INDIRECT_DISPATCH_PATTERN = /^indirect\s+(\S+)$/;
// The buffer attribute that makes a scratch buffer usable for indirect dispatch
const INDIRECT_ATTRIBUTE = 'indirect';
const VECTOR_FRAMES_PATTERN = /^frames\s+(\d+)\s*-\s*(\d+)$/;
const VECTOR_HASH_PATTERN = /^sha256\s+([0-9A-Fa-f]{64})$/;
const FEATURE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const BINDING_ATTRIBUTE_PATTERN = /@(group|binding)\s*\(/;
const ENABLE_DIRECTIVE_PATTERN = /^[ \t]*enable\s/m;
const COMPUTE_ATTRIBUTE = '@compute';
const QUOTE = '"';
const MINIMUM_DISPATCH_COUNT_COUNT = 1;
const MAXIMUM_DISPATCH_COUNT_COUNT = 3;
const DECLARATION_BOUNDARY_PATTERN = /[;}]/g;
const VECTOR_PART_COUNT = 3;
// A buffer, the state, and a packet hold at least one byte; an indirect buffer holds its arguments
const MINIMUM_BYTE_LENGTH = 1;
const EMPTY_STATE_BYTE_LENGTH = 0;

const REPEATABLE_DIRECTIVES: ReadonlySet<string> = new Set([ 'buffer', 'dispatch' ]);

const REQUIRED_DIRECTIVES: readonly string[] = [ 'name', 'decoder', 'accepts', 'output', 'packet', 'dispatch' ];

const VIDEO_DECODER_KIND = 'video';

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

type HeaderDirective = {
    line: number
    name: string
    value: string
};

type LocatedDispatch = {
    dispatch: GPUDecoderDispatch
    line: number
};

/** The codes of one expression directive's checks. */
type ExpressionCodes = {
    expression: GPUDecoderManifestErrorCode
    identifier: GPUDecoderManifestErrorCode
};

/** The codes of one size directive's checks. */
type SizeCodes = {
    size: GPUDecoderManifestErrorCode
    syntax: GPUDecoderManifestErrorCode
};

type ManifestDraft = {
    accepts: GPUDecoderAcceptance | null
    buffers: GPUDecoderBuffer[]
    dispatches: LocatedDispatch[]
    name: string
    outputFormat: GPUDecoderOutputFormat | null
    packetByteLength: number
    references: number
    reorder: number
    requiredFeatures: string[]
    stateByteLength: number
    vector: GPUDecoderVector | null
};

const ACCEPTS_EXPRESSION_CODES: ExpressionCodes = { expression: 'accepts-expression', identifier: 'accepts-identifier' };
const DISPATCH_EXPRESSION_CODES: ExpressionCodes = { expression: 'dispatch-expression', identifier: 'dispatch-identifier' };
const PACKET_SIZE_CODES: SizeCodes = { size: 'packet-size', syntax: 'packet-syntax' };
const STATE_SIZE_CODES: SizeCodes = { size: 'state-size', syntax: 'state-syntax' };

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

function parseSize(text: string, line: number, codes: SizeCodes, minimum: number, maximum: number): number {
    const byteLength = parseByteLength(text, line, codes.syntax);
    requireByteRange(byteLength, minimum, maximum, line, codes.size, '');
    return byteLength;
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

/** Parses a header expression that reads stream facts only. */
function parseStreamExpression(text: string, line: number, codes: ExpressionCodes): PassExpression {
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
        if (!GPU_DECODER_STREAM_IDENTIFIERS.includes(identifier)) {
            throw new GPUDecoderManifestError(codes.identifier, quote(identifier), line);
        }
    }
    return expression;
}

function unquote(text: string): string {
    return text.length >= 2 && text.startsWith(QUOTE) && text.endsWith(QUOTE) ? text.slice(1, -1) : text;
}

function parseCodecIdentifiers(listText: string, line: number): string[] {
    const codecs: string[] = [];
    for (const [ itemIndex, item ] of splitTopLevel(listText).entries()) {
        const codec = unquote(item);
        if (codec.length === 0) {
            throw new GPUDecoderManifestError('codec-empty', `position ${itemIndex + 1}`, line);
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
    const codecs = parseCodecIdentifiers(match[1], line);
    const conditionsText = match[2]?.trim() ?? '';
    if (conditionsText.length === 0) {
        return { codecs, constraint: null };
    }
    let constraint: PassExpression | null = null;
    for (const conditionText of splitTopLevel(conditionsText)) {
        const condition = parseStreamExpression(conditionText, line, ACCEPTS_EXPRESSION_CODES);
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
    const byteLength = parseByteLength(sizeTexts[0], line, 'buffer-syntax');
    const indirect = indirectCount === 1;
    const minimumByteLength = indirect ? INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH : MINIMUM_BYTE_LENGTH;
    requireByteRange(byteLength, minimumByteLength, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE, line, 'buffer-size', quote(name));
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
    const counts: PassExpression[] = countTexts.map(countText => parseStreamExpression(countText, line, DISPATCH_EXPRESSION_CODES));
    while (counts.length < MAXIMUM_DISPATCH_COUNT_COUNT) {
        counts.push({ kind: 'number', value: 1 });
    }
    return {
        entryPoint,
        indirectBuffer: null,
        workgroupCounts: [ counts[0], counts[1], counts[2] ]
    };
}

/** Parses `<file>, frames <first>-<last>, sha256 <hex>`. */
function parseVector(value: string, line: number): GPUDecoderVector {
    const parts = splitTopLevel(value);
    const framesMatch = parts.length === VECTOR_PART_COUNT ? VECTOR_FRAMES_PATTERN.exec(parts[1]) : null;
    const hashMatch = parts.length === VECTOR_PART_COUNT ? VECTOR_HASH_PATTERN.exec(parts[2]) : null;
    if (!framesMatch || !hashMatch || parts[0].length === 0) {
        throw new GPUDecoderManifestError('vector-syntax', quote(value), line);
    }
    const firstFrame = Number(framesMatch[1]);
    const lastFrame = Number(framesMatch[2]);
    if (lastFrame < firstFrame) {
        throw new GPUDecoderManifestError('vector-frames', `${firstFrame} > ${lastFrame}`, line);
    }
    return {
        file: unquote(parts[0]),
        firstFrame,
        lastFrame,
        sha256: hashMatch[1].toLowerCase()
    };
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

function parseOutputFormat(value: string, line: number): GPUDecoderOutputFormat {
    if (!isGPUDecoderOutputFormat(value)) {
        throw new GPUDecoderManifestError('output-format', quote(value), line);
    }
    return value;
}

function parseName(value: string, line: number): string {
    if (value.length === 0) {
        throw new GPUDecoderManifestError('name-empty', quote(value), line);
    }
    return value;
}

function requireVideoDecoder(value: string, line: number): void {
    if (value !== VIDEO_DECODER_KIND) {
        throw new GPUDecoderManifestError('decoder-kind', quote(value), line);
    }
}

/** Applies one directive to the draft. */
function applyDirective(draft: ManifestDraft, directive: HeaderDirective): void {
    const { line, value } = directive;
    switch (directive.name) {
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
            draft.outputFormat = parseOutputFormat(value, line);
            return;
        case 'references':
            draft.references = parseCount(value, line, 'references-syntax', 'references-limit', GPU_DECODER_MAXIMUM_REFERENCES);
            return;
        case 'reorder':
            draft.reorder = parseCount(value, line, 'reorder-syntax', 'reorder-limit', GPU_DECODER_MAXIMUM_REORDER);
            return;
        case 'packet':
            draft.packetByteLength = parseSize(value, line, PACKET_SIZE_CODES, MINIMUM_BYTE_LENGTH, GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH);
            return;
        case 'state':
            draft.stateByteLength = parseSize(value, line, STATE_SIZE_CODES, EMPTY_STATE_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE);
            return;
        case 'buffer':
            draft.buffers.push(parseBuffer(value, line, draft.buffers));
            return;
        case 'requires':
            draft.requiredFeatures = parseRequiredFeatures(value, line);
            return;
        case 'dispatch':
            draft.dispatches.push({ dispatch: parseDispatch(value, line), line });
            return;
        case 'vector':
            draft.vector = parseVector(value, line);
            return;
        default:
            throw new GPUDecoderManifestError('directive-unknown', quote(directive.name), line);
    }
}

/** Reads the leading `//!` lines; a blank `//!` line is allowed and skipped. */
function readHeader(lines: readonly string[]): { bodyFirstLine: number; directives: HeaderDirective[] } {
    const directives: HeaderDirective[] = [];
    let lineIndex = 0;
    for (; lineIndex < lines.length && lines[lineIndex].trimStart().startsWith(HEADER_PREFIX); lineIndex += 1) {
        const text = lines[lineIndex].trim();
        if (text === HEADER_PREFIX) {
            continue;
        }
        const match = DIRECTIVE_PATTERN.exec(text);
        const line = lineIndex + 1;
        if (!match) {
            throw new GPUDecoderManifestError('header-syntax', quote(text), line);
        }
        directives.push({ line, name: match[1], value: match[2].trim() });
    }
    return { bodyFirstLine: lineIndex + 1, directives };
}

function requireDirectiveSet(directives: readonly HeaderDirective[], bodyFirstLine: number): void {
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
    let attributesStart = 0;
    for (const boundary of body.slice(0, declaration.index).matchAll(DECLARATION_BOUNDARY_PATTERN)) {
        attributesStart = (boundary.index ?? 0) + 1;
    }
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
        name: '',
        outputFormat: null,
        packetByteLength: 0,
        references: 0,
        reorder: 0,
        requiredFeatures: [],
        stateByteLength: 0,
        vector: null
    };
    for (const directive of directives) {
        applyDirective(draft, directive);
    }

    const body = lines.slice(bodyFirstLine - 1).join('\n');
    requirePreludeOwnedDeclarations(body, bodyFirstLine);
    for (const located of draft.dispatches) {
        requireIndirectBuffer(draft.buffers, located);
        requireComputeEntryPoint(body, located);
    }

    return {
        accepts: requireParsed(draft.accepts, 'accepts', 1),
        body,
        bodyFirstLine,
        buffers: draft.buffers,
        dispatches: draft.dispatches.map(located => located.dispatch),
        name: draft.name,
        outputFormat: requireParsed(draft.outputFormat, 'output', 1),
        packetByteLength: draft.packetByteLength,
        references: draft.references,
        reorder: draft.reorder,
        requiredFeatures: draft.requiredFeatures,
        stateByteLength: draft.stateByteLength,
        vector: draft.vector
    };
}
