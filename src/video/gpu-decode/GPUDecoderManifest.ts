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

const HEADER_PREFIX = '//!';
const DIRECTIVE_PATTERN = /^\/\/!\s*([A-Za-z]+)\s*:(.*)$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_]\w*$/;
const SIZE_PATTERN = /^(\d+)\s*(B|KiB|MiB)?$/;
const COUNT_PATTERN = /^\d+$/;
const ACCEPTS_PATTERN = /^codec\s+in\s+\[([^\]]*)\]\s*(?:,(.*))?$/;
const INDIRECT_DISPATCH_PATTERN = /^indirect\s+(\S+)$/;
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

const REPEATABLE_DIRECTIVES: ReadonlySet<string> = new Set([ 'buffer', 'dispatch' ]);

const REQUIRED_DIRECTIVES: readonly string[] = [ 'name', 'decoder', 'accepts', 'output', 'packet', 'dispatch' ];

/** A malformed decoder header or body, with the 1-based source line it concerns. */
export class GPUDecoderManifestError extends Error {
    readonly line: number;

    constructor(message: string, line: number) {
        super(message);
        this.name = 'GPUDecoderManifestError';
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

function parseSize(text: string, line: number, subject: string, maximum: number): number {
    const match = SIZE_PATTERN.exec(text);
    if (!match) {
        throw new GPUDecoderManifestError(`${subject} must be a byte count with an optional B, KiB, or MiB unit, not '${text}'`, line);
    }
    const byteLength = Number(match[1]) * getUnitByteLength(match[2]);
    if (byteLength > maximum) {
        throw new GPUDecoderManifestError(`${subject} of ${byteLength} bytes exceeds the ${maximum}-byte limit`, line);
    }
    return byteLength;
}

function parseCount(text: string, line: number, subject: string, maximum: number): number {
    if (!COUNT_PATTERN.test(text)) {
        throw new GPUDecoderManifestError(`${subject} must be a non-negative integer, not '${text}'`, line);
    }
    const count = Number(text);
    if (count > maximum) {
        throw new GPUDecoderManifestError(`${subject} of ${count} exceeds the limit of ${maximum}`, line);
    }
    return count;
}

function requireIdentifier(text: string, line: number, subject: string): string {
    if (!IDENTIFIER_PATTERN.test(text)) {
        throw new GPUDecoderManifestError(`${subject} '${text}' is not a WGSL identifier`, line);
    }
    return text;
}

/** Parses a header expression that reads stream facts only. */
function parseStreamExpression(text: string, line: number, subject: string): PassExpression {
    let expression: PassExpression;
    try {
        expression = parsePassExpression(text);
    } catch (error) {
        if (error instanceof PassExpressionError) {
            throw new GPUDecoderManifestError(`${subject} '${text}' is malformed: ${error.message}`, line);
        }
        throw error;
    }
    for (const identifier of collectPassExpressionIdentifiers(expression)) {
        if (!GPU_DECODER_STREAM_IDENTIFIERS.includes(identifier)) {
            throw new GPUDecoderManifestError(
                `${subject} reads '${identifier}'; only ${GPU_DECODER_STREAM_IDENTIFIERS.join(', ')} are available`,
                line
            );
        }
    }
    return expression;
}

function unquote(text: string): string {
    return text.length >= 2 && text.startsWith(QUOTE) && text.endsWith(QUOTE) ? text.slice(1, -1) : text;
}

function parseCodecIdentifiers(listText: string, line: number): string[] {
    const codecs: string[] = [];
    for (const item of splitTopLevel(listText)) {
        const codec = unquote(item);
        if (codec.length === 0) {
            throw new GPUDecoderManifestError('The accepted codec list has an empty identifier', line);
        }
        if (codecs.includes(codec)) {
            throw new GPUDecoderManifestError(`The accepted codec list names '${codec}' twice`, line);
        }
        codecs.push(codec);
    }
    return codecs;
}

/** Parses `codec in [a, b], <condition>, ...`; several conditions must all hold. */
function parseAccepts(value: string, line: number): GPUDecoderAcceptance {
    const match = ACCEPTS_PATTERN.exec(value);
    if (!match) {
        throw new GPUDecoderManifestError('accepts must read `codec in [<identifiers>]`, optionally followed by conditions', line);
    }
    const codecs = parseCodecIdentifiers(match[1], line);
    const conditionsText = match[2]?.trim() ?? '';
    if (conditionsText.length === 0) {
        return { codecs, constraint: null };
    }
    let constraint: PassExpression | null = null;
    for (const conditionText of splitTopLevel(conditionsText)) {
        const condition = parseStreamExpression(conditionText, line, 'The accepts condition');
        constraint = constraint ? { kind: 'binary', left: constraint, operator: '&&', right: condition } : condition;
    }
    return { codecs, constraint };
}

/** Parses `<name>, <size>` with an optional `indirect` in any position after the name. */
function parseBuffer(value: string, line: number, existingBuffers: readonly GPUDecoderBuffer[]): GPUDecoderBuffer {
    const [ nameText, ...attributes ] = splitTopLevel(value);
    const name = requireIdentifier(nameText, line, 'The buffer name');
    if (GPU_DECODER_RESERVED_IDENTIFIERS.has(name)) {
        throw new GPUDecoderManifestError(`The buffer name '${name}' is reserved by the prelude`, line);
    }
    if (existingBuffers.some(buffer => buffer.name === name)) {
        throw new GPUDecoderManifestError(`The buffer '${name}' is declared twice`, line);
    }
    const sizeTexts = attributes.filter(attribute => attribute !== 'indirect');
    const indirectCount = attributes.length - sizeTexts.length;
    if (sizeTexts.length !== 1 || indirectCount > 1) {
        throw new GPUDecoderManifestError('buffer must read `<name>, <size>`, optionally with `indirect`', line);
    }
    const byteLength = parseSize(sizeTexts[0], line, `The size of buffer '${name}'`, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE);
    const indirect = indirectCount === 1;
    if (indirect && byteLength < INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH) {
        throw new GPUDecoderManifestError(
            `The indirect buffer '${name}' needs at least ${INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH} bytes`,
            line
        );
    }
    if (byteLength === 0) {
        throw new GPUDecoderManifestError(`The buffer '${name}' is empty`, line);
    }
    return { byteLength, indirect, name };
}

/** Parses `<entry point>, <count>[, <count>[, <count>]]` or `<entry point>, indirect <buffer>`. */
function parseDispatch(value: string, line: number): GPUDecoderDispatch {
    const [ entryPointText, ...countTexts ] = splitTopLevel(value);
    const entryPoint = requireIdentifier(entryPointText, line, 'The dispatch entry point');
    const indirectMatch = countTexts.length === 1 ? INDIRECT_DISPATCH_PATTERN.exec(countTexts[0]) : null;
    if (indirectMatch) {
        return {
            entryPoint,
            indirectBuffer: requireIdentifier(indirectMatch[1], line, 'The indirect buffer'),
            workgroupCounts: null
        };
    }
    if (countTexts.length < MINIMUM_DISPATCH_COUNT_COUNT || countTexts.length > MAXIMUM_DISPATCH_COUNT_COUNT) {
        throw new GPUDecoderManifestError('dispatch must read `<entry point>, <1 to 3 workgroup counts>` or `<entry point>, indirect <buffer>`', line);
    }
    const counts: PassExpression[] = countTexts.map(countText => parseStreamExpression(countText, line, 'The workgroup count'));
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
    const framesMatch = parts.length === 3 ? VECTOR_FRAMES_PATTERN.exec(parts[1]) : null;
    const hashMatch = parts.length === 3 ? VECTOR_HASH_PATTERN.exec(parts[2]) : null;
    if (!framesMatch || !hashMatch || parts[0].length === 0) {
        throw new GPUDecoderManifestError('vector must read `<file>, frames <first>-<last>, sha256 <64 hexadecimal digits>`', line);
    }
    const firstFrame = Number(framesMatch[1]);
    const lastFrame = Number(framesMatch[2]);
    if (lastFrame < firstFrame) {
        throw new GPUDecoderManifestError(`The vector's last frame ${lastFrame} precedes its first frame ${firstFrame}`, line);
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
            throw new GPUDecoderManifestError(`'${feature}' is not a device feature name`, line);
        }
        if (features.includes(feature)) {
            throw new GPUDecoderManifestError(`The feature '${feature}' is required twice`, line);
        }
        features.push(feature);
    }
    return features;
}

function parseOutputFormat(value: string, line: number): GPUDecoderOutputFormat {
    if (!isGPUDecoderOutputFormat(value)) {
        throw new GPUDecoderManifestError(`'${value}' is not a planar output format such as I420 or I422P10`, line);
    }
    return value;
}

function parseName(value: string, line: number): string {
    if (value.length === 0) {
        throw new GPUDecoderManifestError('The decoder name is empty', line);
    }
    return value;
}

function requireVideoDecoder(value: string, line: number): void {
    if (value !== 'video') {
        throw new GPUDecoderManifestError(`decoder must be 'video', not '${value}'`, line);
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
            draft.references = parseCount(value, line, 'references', GPU_DECODER_MAXIMUM_REFERENCES);
            return;
        case 'reorder':
            draft.reorder = parseCount(value, line, 'reorder', GPU_DECODER_MAXIMUM_REORDER);
            return;
        case 'packet':
            draft.packetByteLength = parseSize(value, line, 'The packet size', GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH);
            return;
        case 'state':
            draft.stateByteLength = parseSize(value, line, 'The state size', MAXIMUM_STORAGE_BUFFER_BINDING_SIZE);
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
            throw new GPUDecoderManifestError(`Unknown directive '${directive.name}'`, line);
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
            throw new GPUDecoderManifestError('A header line must read `//! <directive>: <value>`', line);
        }
        directives.push({ line, name: match[1], value: match[2].trim() });
    }
    return { bodyFirstLine: lineIndex + 1, directives };
}

function requireDirectiveSet(directives: readonly HeaderDirective[], bodyFirstLine: number): void {
    const seen = new Set<string>();
    for (const directive of directives) {
        if (seen.has(directive.name) && !REPEATABLE_DIRECTIVES.has(directive.name)) {
            throw new GPUDecoderManifestError(`The directive '${directive.name}' appears twice`, directive.line);
        }
        seen.add(directive.name);
    }
    for (const required of REQUIRED_DIRECTIVES) {
        if (!seen.has(required)) {
            throw new GPUDecoderManifestError(`The header has no '${required}' directive`, Math.max(1, bodyFirstLine - 1));
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
        throw new GPUDecoderManifestError(`The body has no entry point 'fn ${entryPoint}('`, located.line);
    }
    // The attributes of a declaration follow the previous declaration's ';' or '}'
    let attributesStart = 0;
    for (const boundary of body.slice(0, declaration.index).matchAll(DECLARATION_BOUNDARY_PATTERN)) {
        attributesStart = (boundary.index ?? 0) + 1;
    }
    if (!body.slice(attributesStart, declaration.index).includes(COMPUTE_ATTRIBUTE)) {
        throw new GPUDecoderManifestError(`The entry point '${entryPoint}' is not declared with ${COMPUTE_ATTRIBUTE}`, located.line);
    }
}

function requireIndirectBuffer(buffers: readonly GPUDecoderBuffer[], located: LocatedDispatch): void {
    const bufferName = located.dispatch.indirectBuffer;
    if (bufferName === null) {
        return;
    }
    const buffer = buffers.find(candidate => candidate.name === bufferName);
    if (!buffer) {
        throw new GPUDecoderManifestError(`The dispatch reads the undeclared buffer '${bufferName}'`, located.line);
    }
    if (!buffer.indirect) {
        throw new GPUDecoderManifestError(`The buffer '${bufferName}' is not declared indirect`, located.line);
    }
}

function requirePreludeOwnedDeclarations(body: string, bodyFirstLine: number): void {
    const binding = BINDING_ATTRIBUTE_PATTERN.exec(body);
    if (binding) {
        throw new GPUDecoderManifestError(
            'The prelude owns every binding; declare scratch buffers with the buffer directive',
            getBodyLine(body, bodyFirstLine, binding.index)
        );
    }
    const enable = ENABLE_DIRECTIVE_PATTERN.exec(body);
    if (enable) {
        throw new GPUDecoderManifestError(
            'The prelude writes enable directives; declare the device feature with the requires directive',
            getBodyLine(body, bodyFirstLine, enable.index)
        );
    }
}

/** Parses and validates a decoder's `//!` header, and checks its body against the dispatch sequence. */
export function parseGPUDecoderManifest(source: string): GPUDecoderManifest {
    const lines = source.split(/\r?\n/);
    const { bodyFirstLine, directives } = readHeader(lines);
    if (directives.length === 0) {
        throw new GPUDecoderManifestError(`A decoder starts with a ${HEADER_PREFIX} header`, 1);
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
    if (!draft.accepts || !draft.outputFormat) {
        throw new GPUDecoderManifestError('The header is incomplete', 1);
    }
    if (draft.packetByteLength === 0) {
        throw new GPUDecoderManifestError('The packet size must be at least 1 byte', directives.find(directive => directive.name === 'packet')?.line ?? 1);
    }

    return {
        accepts: draft.accepts,
        body,
        bodyFirstLine,
        buffers: draft.buffers,
        dispatches: draft.dispatches.map(located => located.dispatch),
        name: draft.name,
        outputFormat: draft.outputFormat,
        packetByteLength: draft.packetByteLength,
        references: draft.references,
        reorder: draft.reorder,
        requiredFeatures: draft.requiredFeatures,
        stateByteLength: draft.stateByteLength,
        vector: draft.vector
    };
}
