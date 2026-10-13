// Parses a pass file, whose passes each start with a `//!` header, into PassManifests; overhual/passes.md documents the grammar.
import {
    INTERMEDIATE_TEXTURE_FORMAT,
    MAXIMUM_WORKGROUP_INVOCATIONS,
    MAXIMUM_WORKGROUP_SIZE,
    RENDER_OUTPUT_FORMATS,
    STORAGE_OUTPUT_FORMATS,
    U32_VALUE_COUNT,
    WORKGROUP_AXIS_NAMES
} from '../WebGPUConstants';
import { BUILTIN_COLOR_FUNCTION_NAMES } from './builtin/BuiltinColorFunctions';
import { collectPassExpressionIdentifiers, parsePassExpression, PassExpressionError } from './PassExpression';
import {
    GLOBAL_FACT_NAMES,
    GLOBAL_SIZE_NAMES,
    HEIGHT_SUFFIX,
    HISTORY_ACCESSOR_INFIX,
    HOOKED_INPUT_NAME,
    MAXIMUM_HISTORY_DEPTH,
    MAXIMUM_PARAMETER_COUNT,
    SCALER_STAGE,
    SIZE_SUFFIX,
    STAGE_ORDER,
    WIDTH_SUFFIX
} from './PassLanguage';
import type {
    ColorDomain,
    PassExpression,
    PassInput,
    PassManifest,
    PassOutput,
    PassParameter,
    PassParameterType,
    PassShape,
    PassWorkgroup,
    PresentationStage
} from './PassTypes';

/** A pass header that cannot be parsed, with the 1-based source line it failed on. */
export class PassManifestError extends Error {
    readonly line: number;
    /** The pass's name when the header declared one before the check that failed, otherwise null. */
    readonly passName: string | null;

    constructor(message: string, line: number, passName: string | null = null) {
        super(message);
        this.name = 'PassManifestError';
        this.line = line;
        this.passName = passName;
    }
}

type Directive =
    | 'components'
    | 'dispatch'
    | 'domain'
    | 'hook'
    | 'input'
    | 'name'
    | 'output'
    | 'replaces'
    | 'save'
    | 'shape'
    | 'when'
    | 'workgroup';

/** A directive's trimmed value, with its 1-based source line. */
type HeaderEntry = {
    line: number
    value: string
};

/** A `param <name>: <declaration>` line, with its 1-based source line. */
type ParameterEntry = {
    declaration: string
    line: number
    name: string
};

type PassHeader = {
    body: string
    bodyFirstLine: number
    /** Each directive's entries in source order; only `input` repeats. */
    entries: ReadonlyMap<Directive, readonly HeaderEntry[]>
    /** The 1-based line of the header's first line, where a missing directive is reported. */
    firstLine: number
    parameters: readonly ParameterEntry[]
};

/** One pass's lines in its file, as 0-based line indices: its header from headerStart, and its body from bodyStart up to bodyEnd. */
type PassBlock = {
    bodyEnd: number
    bodyStart: number
    headerStart: number
};

/** A parameter an earlier pass of the file declared, which a later declaration of its name must match. */
type FileParameter = {
    parameter: PassParameter
    passName: string
};

/** One pass of a pass file, in file order: its manifest, or the header error that keeps it from parsing. */
export type PassFileEntry =
    | Readonly<{ error: null; manifest: PassManifest }>
    | Readonly<{ error: PassManifestError; manifest: null }>;

type ComponentCount = NonNullable<PassManifest['components']>;

type OutputSize = Pick<PassOutput, 'height' | 'width'>;

const HEADER_PREFIX = '//!';
const PARAMETER_KEYWORD = 'param';
// A missing header has no line of its own
const MISSING_HEADER_LINE = 1;

const DEFAULT_DOMAIN: ColorDomain = 'any';
const MAXIMUM_NAME_LENGTH = 64;

const SHAPES: readonly PassShape[] = [ 'color', 'kernel', 'scaler', 'compute' ];
const DOMAINS: readonly ColorDomain[] = [ 'any', 'display', 'linear', 'sdr', 'source' ];
const PARAMETER_TYPES: readonly PassParameterType[] = [ 'f32', 'i32', 'u32' ];
const COMPONENT_COUNTS: readonly ComponentCount[] = [ 1, 2, 3, 4 ];

// The shapes that write a texture of their own
const TEXTURE_SHAPES: readonly PassShape[] = [ 'kernel', 'compute' ];

// The shapes each directive is allowed in; `param` lines are allowed in every shape
const DIRECTIVE_SHAPES: Readonly<Record<Directive, readonly PassShape[]>> = {
    components: TEXTURE_SHAPES,
    dispatch: [ 'compute' ],
    domain: SHAPES,
    hook: SHAPES,
    input: [ 'kernel', 'scaler', 'compute' ],
    name: SHAPES,
    output: TEXTURE_SHAPES,
    replaces: [ 'color' ],
    save: TEXTURE_SHAPES,
    shape: SHAPES,
    when: SHAPES,
    workgroup: [ 'compute' ]
};
// Own keys only, so a prototype name such as toString is not a directive
const DIRECTIVE_NAMES: ReadonlySet<string> = new Set<string>(Object.keys(DIRECTIVE_SHAPES));
const REPEATABLE_DIRECTIVES: readonly Directive[] = [ 'input' ];

// The value of a workgroup size or a dispatch count that a header omits
const DEFAULT_AXIS_VALUE = 1;

const I32_MINIMUM = -2_147_483_648;
const I32_MAXIMUM = 2_147_483_647;
const U32_MAXIMUM = U32_VALUE_COUNT - 1;

const LINE_BREAK_PATTERN = /\r?\n/;
const WHITESPACE_PATTERN = /\s+/;
const IDENTIFIER_PATTERN = /^[A-Za-z_]\w*$/;
const HISTORY_INPUT_PATTERN = /^([A-Za-z_]\w*)\s*\[\s*-\s*(\d+)\s*\]$/;
// History input NAME[-N] has the accessors of NAME_historyN, so no texture name may end like that
const HISTORY_ACCESSOR_SUFFIX_PATTERN = new RegExp(`${HISTORY_ACCESSOR_INFIX}\\d+$`);
const SIZE_REFERENCE_PATTERN = /^([A-Za-z_]\w*)\.size$/;
const PARAMETER_DECLARATION_PATTERN = /^(\w+)\s*=\s*(\S+)\s+in\s*\[([^\]]*)\]$/;
const NUMBER_PATTERN = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

const MISSING_HEADER_MESSAGE = 'The pass has no //! header';
const MALFORMED_LINE_MESSAGE = "Expected '<directive>: <value>' or 'param <name>: <type> = <default> in [<minimum>, <maximum>]'";
const MALFORMED_PARAMETER_MESSAGE = "Expected 'param <name>: <type> = <default> in [<minimum>, <maximum>]'";
const MALFORMED_OUTPUT_MESSAGE = "Expected '<NAME>.size, <format>' or '<width>, <height>, <format>'";
const MALFORMED_WORKGROUP_MESSAGE = "Expected 'workgroup: <x>[, <y>[, <z>]]'";
const MALFORMED_DISPATCH_MESSAGE = "Expected 'dispatch: <x>[, <y>[, <z>]]'";
// The expression parser's message for the same mistake
const UNBALANCED_PARENTHESIS_MESSAGE = 'Unbalanced parenthesis';
const REPLACING_HOOK_MESSAGE = 'A color pass with replaces cannot declare a hook';
const REPLACING_DOMAIN_MESSAGE = 'A color pass with replaces cannot declare a domain';
const SCALER_HOOK_MESSAGE = `A scaler must hook ${SCALER_STAGE}`;
const SCALER_INPUT_MESSAGE = `A scaler reads only ${HOOKED_INPUT_NAME}`;
const PARAMETER_COUNT_MESSAGE = `A pass declares at most ${MAXIMUM_PARAMETER_COUNT} parameters`;
// The number of passes parsePassManifest takes
const SINGLE_PASS_COUNT = 1;

/** Narrows a header word to one of the words a directive allows. */
function isOneOf<Word extends string>(words: readonly Word[], value: string): value is Word {
    return (words as readonly string[]).includes(value);
}

function isDirective(key: string): key is Directive {
    return DIRECTIVE_NAMES.has(key);
}

function createIdentifier(name: string): PassExpression {
    return { kind: 'identifier', name };
}

function createNumber(value: number): PassExpression {
    return { kind: 'number', value };
}

/** Files one header line's text after `//!` under its directive, or as a parameter. */
function readHeaderLine(text: string, line: number, entries: Map<Directive, HeaderEntry[]>, parameters: ParameterEntry[]): void {
    const colonIndex = text.indexOf(':');
    if (colonIndex <= 0) {
        throw new PassManifestError(MALFORMED_LINE_MESSAGE, line);
    }
    const key = text.slice(0, colonIndex).trim();
    const value = text.slice(colonIndex + 1).trim();
    const keyWords = key.split(WHITESPACE_PATTERN);
    if (keyWords[0] === PARAMETER_KEYWORD) {
        if (keyWords.length !== 2) {
            throw new PassManifestError(MALFORMED_PARAMETER_MESSAGE, line);
        }
        parameters.push({ declaration: value, line, name: keyWords[1] });
        return;
    }
    if (!isDirective(key)) {
        throw new PassManifestError(`Unknown directive '${key}'`, line);
    }
    const directiveEntries = entries.get(key) ?? [];
    if (directiveEntries.length > 0 && !REPEATABLE_DIRECTIVES.includes(key)) {
        throw new PassManifestError(`Repeated directive '${key}'`, line);
    }
    if (value === '') {
        throw new PassManifestError(`Directive '${key}' has no value`, line);
    }
    directiveEntries.push({ line, value });
    entries.set(key, directiveEntries);
}

function isHeaderLine(line: string): boolean {
    return line.startsWith(HEADER_PREFIX);
}

/**
 * Splits a file's lines into its passes, as mpv splits its user shaders: each pass is a run of header lines, then its body up to the next header line.
 * Only blank lines may come before the first header; a file that starts any other way has no passes.
 */
function findPassBlocks(lines: readonly string[]): PassBlock[] {
    let lineIndex = 0;
    while (lineIndex < lines.length && lines[lineIndex].trim() === '') {
        lineIndex += 1;
    }
    const blocks: PassBlock[] = [];
    while (lineIndex < lines.length && isHeaderLine(lines[lineIndex])) {
        const headerStart = lineIndex;
        while (lineIndex < lines.length && isHeaderLine(lines[lineIndex])) {
            lineIndex += 1;
        }
        const bodyStart = lineIndex;
        while (lineIndex < lines.length && !isHeaderLine(lines[lineIndex])) {
            lineIndex += 1;
        }
        blocks.push({ bodyEnd: lineIndex, bodyStart, headerStart });
    }
    return blocks;
}

/** Reads one pass's header entries and its body, with lines counted from the file's first line. */
function readHeader(lines: readonly string[], block: PassBlock): PassHeader {
    const entries = new Map<Directive, HeaderEntry[]>();
    const parameters: ParameterEntry[] = [];
    for (let lineIndex = block.headerStart; lineIndex < block.bodyStart; lineIndex += 1) {
        readHeaderLine(lines[lineIndex].slice(HEADER_PREFIX.length).trim(), lineIndex + 1, entries, parameters);
    }
    return {
        body: lines.slice(block.bodyStart, block.bodyEnd).join('\n'),
        bodyFirstLine: block.bodyStart + 1,
        entries,
        firstLine: block.headerStart + 1,
        parameters
    };
}

function getEntry(header: PassHeader, directive: Directive): HeaderEntry | null {
    return header.entries.get(directive)?.[0] ?? null;
}

/** Returns a required directive's entry; a missing one has no line of its own, so it is reported on the header's first line. */
function requireEntry(header: PassHeader, directive: Directive): HeaderEntry {
    const entry = getEntry(header, directive);
    if (!entry) {
        throw new PassManifestError(`Missing required directive '${directive}'`, header.firstLine);
    }
    return entry;
}

/** Reads a directive whose value must be one of its words. */
function readWord<Word extends string>(entry: HeaderEntry, words: readonly Word[], description: string): Word {
    if (!isOneOf(words, entry.value)) {
        throw new PassManifestError(`Unknown ${description} '${entry.value}'; expected ${words.join(', ')}`, entry.line);
    }
    return entry.value;
}

/** Splits a value at the commas outside parentheses, so a function call's arguments stay in one part. */
function splitTopLevel(value: string, line: number): string[] {
    const parts: string[] = [];
    let depth = 0;
    let partStart = 0;
    for (let characterIndex = 0; characterIndex < value.length; characterIndex += 1) {
        switch (value[characterIndex]) {
            case '(':
                depth += 1;
                break;
            case ')':
                // A stray closing parenthesis stays in its part, for the expression parser to report
                depth = Math.max(depth - 1, 0);
                break;
            case ',':
                if (depth === 0) {
                    parts.push(value.slice(partStart, characterIndex).trim());
                    partStart = characterIndex + 1;
                }
                break;
            default:
                break;
        }
    }
    if (depth > 0) {
        throw new PassManifestError(UNBALANCED_PARENTHESIS_MESSAGE, line);
    }
    parts.push(value.slice(partStart).trim());
    return parts;
}

/** Parses expression text, reporting a malformed expression on its directive's line. */
function parseExpressionText(text: string, line: number): PassExpression {
    try {
        return parsePassExpression(text);
    } catch (error) {
        if (error instanceof PassExpressionError) {
            throw new PassManifestError(error.message, line);
        }
        throw error;
    }
}

/** Parses an expression of a directive that may read only the given identifiers. */
function parseExpression(text: string, identifiers: readonly string[], line: number): PassExpression {
    const expression = parseExpressionText(text, line);
    const unknownIdentifier = collectPassExpressionIdentifiers(expression)
        .find((identifier: string): boolean => !identifiers.includes(identifier));
    if (unknownIdentifier !== undefined) {
        throw new PassManifestError(`Unknown identifier '${unknownIdentifier}'; expected ${identifiers.join(', ')}`, line);
    }
    return expression;
}

/** Returns HOOKED and each input's base name once: the textures whose sizes output and dispatch expressions read. */
function getSizedInputNames(inputs: readonly PassInput[]): string[] {
    const names: string[] = [ HOOKED_INPUT_NAME ];
    for (const input of inputs) {
        if (!names.includes(input.name)) {
            names.push(input.name);
        }
    }
    return names;
}

/** Returns the identifiers output and dispatch expressions may read: the global facts and the input sizes. */
function getSizeExpressionIdentifiers(inputs: readonly PassInput[]): string[] {
    const identifiers: string[] = [ ...GLOBAL_FACT_NAMES ];
    for (const name of getSizedInputNames(inputs)) {
        identifiers.push(name + WIDTH_SUFFIX, name + HEIGHT_SUFFIX);
    }
    return identifiers;
}

function readName(header: PassHeader): string {
    const entry = requireEntry(header, 'name');
    // Counted in code points, so a character outside the Basic Multilingual Plane counts once
    if ([ ...entry.value ].length > MAXIMUM_NAME_LENGTH) {
        throw new PassManifestError(`The name is longer than ${MAXIMUM_NAME_LENGTH} characters`, entry.line);
    }
    return entry.value;
}

/** Rejects directives that the pass's shape does not take, on the first line of each. */
function requireDirectivesOfShape(header: PassHeader, shape: PassShape): void {
    for (const [ directive, entries ] of header.entries) {
        if (!DIRECTIVE_SHAPES[directive].includes(shape)) {
            throw new PassManifestError(`A ${shape} pass cannot declare '${directive}'`, entries[0].line);
        }
    }
}

function readReplaces(header: PassHeader): string | null {
    const entry = getEntry(header, 'replaces');
    if (!entry) {
        return null;
    }
    if (!BUILTIN_COLOR_FUNCTION_NAMES.includes(entry.value)) {
        throw new PassManifestError(
            `Unknown built-in color function '${entry.value}'; expected ${BUILTIN_COLOR_FUNCTION_NAMES.join(', ')}`,
            entry.line
        );
    }
    return entry.value;
}

/** Rejects a directive that another directive rules out. */
function rejectEntry(header: PassHeader, directive: Directive, message: string): void {
    const entry = getEntry(header, directive);
    if (entry) {
        throw new PassManifestError(message, entry.line);
    }
}

/** Reads the hook, which a color pass with replaces does not have, since it runs in the replaced function's place. */
function readHook(header: PassHeader, shape: PassShape, replaces: string | null): PresentationStage | null {
    if (replaces !== null) {
        rejectEntry(header, 'hook', REPLACING_HOOK_MESSAGE);
        return null;
    }
    const entry = requireEntry(header, 'hook');
    const hook = readWord(entry, STAGE_ORDER, 'hook');
    if (shape === 'scaler' && hook !== SCALER_STAGE) {
        throw new PassManifestError(SCALER_HOOK_MESSAGE, entry.line);
    }
    return hook;
}

/** Reads the domain, which a color pass with replaces takes from the replaced function's color states. */
function readDomain(header: PassHeader, replaces: string | null): ColorDomain {
    if (replaces !== null) {
        rejectEntry(header, 'domain', REPLACING_DOMAIN_MESSAGE);
        return DEFAULT_DOMAIN;
    }
    const entry = getEntry(header, 'domain');
    return entry ? readWord(entry, DOMAINS, 'domain') : DEFAULT_DOMAIN;
}

/** Rejects texture names that would shadow a global size or a history input's accessors. */
function requireTextureName(name: string, line: number): void {
    if (GLOBAL_SIZE_NAMES.includes(name)) {
        throw new PassManifestError(`'${name}' is reserved for global facts`, line);
    }
    if (HISTORY_ACCESSOR_SUFFIX_PATTERN.test(name)) {
        throw new PassManifestError(`'${name}' ends in _history<digits>, which history accessors use`, line);
    }
}

/** Parses `<NAME>` or `<NAME>[-<N>]`. */
function parseInput(entry: HeaderEntry): PassInput {
    if (IDENTIFIER_PATTERN.test(entry.value)) {
        requireTextureName(entry.value, entry.line);
        return { historyOffset: 0, name: entry.value };
    }
    const match = HISTORY_INPUT_PATTERN.exec(entry.value);
    if (!match) {
        throw new PassManifestError(`Malformed input '${entry.value}'; expected <NAME> or <NAME>[-<N>]`, entry.line);
    }
    const [ , name, depthText ] = match;
    requireTextureName(name, entry.line);
    const depth = Number(depthText);
    if (depth < 1 || depth > MAXIMUM_HISTORY_DEPTH) {
        throw new PassManifestError(`History depth ${depthText} is outside 1 to ${MAXIMUM_HISTORY_DEPTH}`, entry.line);
    }
    return { historyOffset: -depth, name };
}

/** Reads the inputs; kernels, scalers, and compute passes read HOOKED when they declare none. */
function readInputs(header: PassHeader, shape: PassShape): PassInput[] {
    if (shape === 'color') {
        return [];
    }
    const entries = header.entries.get('input') ?? [];
    if (entries.length === 0) {
        return [ { historyOffset: 0, name: HOOKED_INPUT_NAME } ];
    }
    const inputs: PassInput[] = [];
    for (const entry of entries) {
        const input = parseInput(entry);
        if (inputs.some((declared: PassInput): boolean => declared.name === input.name && declared.historyOffset === input.historyOffset)) {
            throw new PassManifestError(`Duplicate input '${entry.value}'`, entry.line);
        }
        if (shape === 'scaler' && (input.name !== HOOKED_INPUT_NAME || input.historyOffset !== 0)) {
            throw new PassManifestError(SCALER_INPUT_MESSAGE, entry.line);
        }
        inputs.push(input);
    }
    return inputs;
}

function readSave(header: PassHeader): string | null {
    const entry = getEntry(header, 'save');
    if (!entry) {
        return null;
    }
    if (!IDENTIFIER_PATTERN.test(entry.value)) {
        throw new PassManifestError(`Save name '${entry.value}' is not an identifier`, entry.line);
    }
    if (entry.value === HOOKED_INPUT_NAME || isOneOf(STAGE_ORDER, entry.value)) {
        throw new PassManifestError(`Cannot save to the stage name '${entry.value}'`, entry.line);
    }
    requireTextureName(entry.value, entry.line);
    return entry.value;
}

/** Expands `<NAME>.size` into the width and height identifiers of HOOKED, an input, the source, or the output. */
function readSizeReference(text: string, inputs: readonly PassInput[], line: number): OutputSize {
    const match = SIZE_REFERENCE_PATTERN.exec(text);
    if (!match) {
        throw new PassManifestError(MALFORMED_OUTPUT_MESSAGE, line);
    }
    const [ , name ] = match;
    const sizeNames = [ ...getSizedInputNames(inputs), ...GLOBAL_SIZE_NAMES ];
    if (!sizeNames.includes(name)) {
        const expectedSizes = sizeNames.map((sizeName: string): string => sizeName + SIZE_SUFFIX);
        throw new PassManifestError(`Unknown size '${text}'; expected ${expectedSizes.join(', ')}`, line);
    }
    return { height: createIdentifier(name + HEIGHT_SUFFIX), width: createIdentifier(name + WIDTH_SUFFIX) };
}

/** Reads the size parts of an output: one `<NAME>.size`, or a width and a height expression. */
function readOutputSize(sizeParts: readonly string[], inputs: readonly PassInput[], line: number): OutputSize {
    switch (sizeParts.length) {
        case 1:
            return readSizeReference(sizeParts[0], inputs, line);
        case 2: {
            const identifiers = getSizeExpressionIdentifiers(inputs);
            const width = parseExpression(sizeParts[0], identifiers, line);
            return { height: parseExpression(sizeParts[1], identifiers, line), width };
        }
        default:
            throw new PassManifestError(MALFORMED_OUTPUT_MESSAGE, line);
    }
}

function parseOutput(entry: HeaderEntry, shape: PassShape, inputs: readonly PassInput[]): PassOutput {
    const parts = splitTopLevel(entry.value, entry.line);
    const { height, width } = readOutputSize(parts.slice(0, -1), inputs, entry.line);
    const format = parts[parts.length - 1];
    const formats = shape === 'compute' ? STORAGE_OUTPUT_FORMATS : RENDER_OUTPUT_FORMATS;
    if (!isOneOf(formats, format)) {
        throw new PassManifestError(`Format '${format}' is not a ${shape} output format; expected ${formats.join(', ')}`, entry.line);
    }
    return { format, height, width };
}

/** Reads the output of a kernel, which defaults to HOOKED's size, or of a compute pass, which must declare it. */
function readOutput(header: PassHeader, shape: PassShape, inputs: readonly PassInput[]): PassOutput | null {
    switch (shape) {
        case 'color':
        case 'scaler':
            return null;
        case 'kernel': {
            const entry = getEntry(header, 'output');
            if (!entry) {
                return {
                    format: INTERMEDIATE_TEXTURE_FORMAT,
                    height: createIdentifier(HOOKED_INPUT_NAME + HEIGHT_SUFFIX),
                    width: createIdentifier(HOOKED_INPUT_NAME + WIDTH_SUFFIX)
                };
            }
            return parseOutput(entry, shape, inputs);
        }
        case 'compute':
            return parseOutput(requireEntry(header, 'output'), shape, inputs);
    }
}

function readComponents(header: PassHeader): ComponentCount | null {
    const entry = getEntry(header, 'components');
    if (!entry) {
        return null;
    }
    const count = COMPONENT_COUNTS.find((candidate: ComponentCount): boolean => String(candidate) === entry.value);
    if (count === undefined) {
        throw new PassManifestError(`Components must be one of ${COMPONENT_COUNTS.join(', ')}`, entry.line);
    }
    return count;
}

function readWhen(header: PassHeader): PassExpression | null {
    const entry = getEntry(header, 'when');
    return entry ? parseExpression(entry.value, GLOBAL_FACT_NAMES, entry.line) : null;
}

/** Parses `<x>[, <y>[, <z>]]` positive integers within WebGPU's default workgroup limits; omitted sizes are 1. */
function parseWorkgroupSize(entry: HeaderEntry): PassWorkgroup['size'] {
    const parts = splitTopLevel(entry.value, entry.line);
    if (parts.length > WORKGROUP_AXIS_NAMES.length) {
        throw new PassManifestError(MALFORMED_WORKGROUP_MESSAGE, entry.line);
    }
    const size: [number, number, number] = [ DEFAULT_AXIS_VALUE, DEFAULT_AXIS_VALUE, DEFAULT_AXIS_VALUE ];
    for (const [ axisIndex, part ] of parts.entries()) {
        if (!POSITIVE_INTEGER_PATTERN.test(part)) {
            throw new PassManifestError(`Workgroup size '${part}' is not a positive integer`, entry.line);
        }
        const axisSize = Number(part);
        if (axisSize > MAXIMUM_WORKGROUP_SIZE[axisIndex]) {
            throw new PassManifestError(
                `Workgroup ${WORKGROUP_AXIS_NAMES[axisIndex]} size ${axisSize} exceeds ${MAXIMUM_WORKGROUP_SIZE[axisIndex]}`,
                entry.line
            );
        }
        size[axisIndex] = axisSize;
    }
    const invocationCount = size[0] * size[1] * size[2];
    if (invocationCount > MAXIMUM_WORKGROUP_INVOCATIONS) {
        throw new PassManifestError(
            `A workgroup of ${invocationCount} invocations exceeds ${MAXIMUM_WORKGROUP_INVOCATIONS}`,
            entry.line
        );
    }
    return size;
}

/** Parses `<x>[, <y>[, <z>]]` workgroup count expressions; omitted counts are 1. */
function parseDispatch(entry: HeaderEntry, inputs: readonly PassInput[]): PassWorkgroup['dispatch'] {
    const parts = splitTopLevel(entry.value, entry.line);
    if (parts.length > WORKGROUP_AXIS_NAMES.length) {
        throw new PassManifestError(MALFORMED_DISPATCH_MESSAGE, entry.line);
    }
    const identifiers = getSizeExpressionIdentifiers(inputs);
    const counts = parts.map((part: string): PassExpression => parseExpression(part, identifiers, entry.line));
    return [
        counts[0],
        counts.at(1) ?? createNumber(DEFAULT_AXIS_VALUE),
        counts.at(2) ?? createNumber(DEFAULT_AXIS_VALUE)
    ];
}

/** Builds `ceil(<extent> / <workgroup size>)`, the workgroups that cover an output extent. */
function createWorkgroupCount(extent: PassExpression, workgroupSize: number): PassExpression {
    return {
        arguments: [ { kind: 'binary', left: extent, operator: '/', right: createNumber(workgroupSize) } ],
        kind: 'call',
        name: 'ceil'
    };
}

/** Reads a compute pass's workgroup size and dispatch, which by default covers its output. */
function readWorkgroup(header: PassHeader, inputs: readonly PassInput[], output: PassOutput): PassWorkgroup {
    const size = parseWorkgroupSize(requireEntry(header, 'workgroup'));
    const dispatchEntry = getEntry(header, 'dispatch');
    const dispatch: PassWorkgroup['dispatch'] = dispatchEntry ?
        parseDispatch(dispatchEntry, inputs) :
        [
            createWorkgroupCount(output.width, size[0]),
            createWorkgroupCount(output.height, size[1]),
            createNumber(DEFAULT_AXIS_VALUE)
        ];
    return { dispatch, size };
}

function isRepresentable(value: number, type: PassParameterType): boolean {
    switch (type) {
        case 'f32':
            return Number.isFinite(Math.fround(value));
        case 'i32':
            return Number.isInteger(value) && value >= I32_MINIMUM && value <= I32_MAXIMUM;
        case 'u32':
            return Number.isInteger(value) && value >= 0 && value <= U32_MAXIMUM;
    }
}

/** Parses one of a parameter's numbers, a decimal literal that its type must represent. */
function parseParameterValue(text: string, type: PassParameterType, entry: ParameterEntry): number {
    if (!NUMBER_PATTERN.test(text)) {
        throw new PassManifestError(`Malformed number '${text}'`, entry.line);
    }
    const value = Number(text);
    if (!isRepresentable(value, type)) {
        throw new PassManifestError(`${text} is not a valid ${type} value for parameter '${entry.name}'`, entry.line);
    }
    return value;
}

/** Parses `<type> = <default> in [<minimum>, <maximum>]`. */
function parseParameter(entry: ParameterEntry): PassParameter {
    if (!IDENTIFIER_PATTERN.test(entry.name)) {
        throw new PassManifestError(`Parameter name '${entry.name}' is not an identifier`, entry.line);
    }
    const match = PARAMETER_DECLARATION_PATTERN.exec(entry.declaration);
    const rangeTexts = match ? match[3].split(',').map((text: string): string => text.trim()) : [];
    if (!match || rangeTexts.length !== 2) {
        throw new PassManifestError(MALFORMED_PARAMETER_MESSAGE, entry.line);
    }
    const [ , type, defaultText ] = match;
    if (!isOneOf(PARAMETER_TYPES, type)) {
        throw new PassManifestError(`Unknown parameter type '${type}'; expected ${PARAMETER_TYPES.join(', ')}`, entry.line);
    }
    const [ minimumText, maximumText ] = rangeTexts;
    const [ defaultValue, minimum, maximum ] = [ defaultText, minimumText, maximumText ]
        .map((text: string): number => parseParameterValue(text, type, entry));
    if (defaultValue < minimum || defaultValue > maximum) {
        throw new PassManifestError(
            `Parameter '${entry.name}' default ${defaultText} is outside [${minimumText}, ${maximumText}]`,
            entry.line
        );
    }
    return { defaultValue, maximum, minimum, name: entry.name, type };
}

function readParameters(entries: readonly ParameterEntry[]): PassParameter[] {
    const parameters: PassParameter[] = [];
    for (const entry of entries) {
        if (parameters.length === MAXIMUM_PARAMETER_COUNT) {
            throw new PassManifestError(PARAMETER_COUNT_MESSAGE, entry.line);
        }
        if (parameters.some((declared: PassParameter): boolean => declared.name === entry.name)) {
            throw new PassManifestError(`Duplicate parameter '${entry.name}'`, entry.line);
        }
        parameters.push(parseParameter(entry));
    }
    return parameters;
}

/** Reads every directive after the name into the manifest. */
function readManifest(header: PassHeader, name: string): PassManifest {
    const shape = readWord(requireEntry(header, 'shape'), SHAPES, 'shape');
    requireDirectivesOfShape(header, shape);
    const replaces = readReplaces(header);
    const hook = readHook(header, shape, replaces);
    const domain = readDomain(header, replaces);
    const inputs = readInputs(header, shape);
    const save = readSave(header);
    const output = readOutput(header, shape, inputs);
    const components = readComponents(header);
    const when = readWhen(header);
    const workgroup = shape === 'compute' && output ? readWorkgroup(header, inputs, output) : null;
    const parameters = readParameters(header.parameters);
    return {
        body: header.body,
        bodyFirstLine: header.bodyFirstLine,
        components,
        domain,
        hook,
        inputs,
        name,
        output,
        parameters,
        replaces,
        save,
        shape,
        when,
        workgroup
    };
}

function parametersMatch(first: PassParameter, second: PassParameter): boolean {
    return first.type === second.type
        && first.defaultValue === second.defaultValue
        && first.minimum === second.minimum
        && first.maximum === second.maximum;
}

/** Rejects a parameter that an earlier pass of the file declared differently, since a file's passes share each parameter's value; then records the pass's parameters. */
function requireFileParameters(header: PassHeader, manifest: PassManifest, fileParameters: Map<string, FileParameter>): void {
    for (const [ parameterIndex, parameter ] of manifest.parameters.entries()) {
        const declared = fileParameters.get(parameter.name);
        if (declared && !parametersMatch(declared.parameter, parameter)) {
            throw new PassManifestError(
                `Parameter '${parameter.name}' differs from its declaration in '${declared.passName}'`,
                header.parameters[parameterIndex].line
            );
        }
    }
    for (const parameter of manifest.parameters) {
        if (!fileParameters.has(parameter.name)) {
            fileParameters.set(parameter.name, { parameter, passName: manifest.name });
        }
    }
}

/** Parses and validates one pass of a file; a failure after the name was read carries that name, so a report can name the pass. */
function parsePassBlock(lines: readonly string[], block: PassBlock, fileParameters: Map<string, FileParameter>): PassManifest {
    const header = readHeader(lines, block);
    const name = readName(header);
    try {
        const manifest = readManifest(header, name);
        requireFileParameters(header, manifest, fileParameters);
        return manifest;
    } catch (error) {
        if (error instanceof PassManifestError) {
            throw new PassManifestError(error.message, error.line, name);
        }
        throw error;
    }
}

function createMissingHeaderError(): PassManifestError {
    return new PassManifestError(MISSING_HEADER_MESSAGE, MISSING_HEADER_LINE);
}

/**
 * Parses a pass file into its passes in file order, each a `//!` header and the body up to the next header line, as in mpv's user shaders.
 * Each pass parses on its own, so a malformed header leaves the file's other passes in place, and every line counts from the file's first line.
 * A file whose first non-blank line is not a header is one entry, with the missing header error.
 */
export function parsePassFile(source: string): PassFileEntry[] {
    const lines = source.split(LINE_BREAK_PATTERN);
    const blocks = findPassBlocks(lines);
    if (blocks.length === 0) {
        return [ { error: createMissingHeaderError(), manifest: null } ];
    }
    const fileParameters = new Map<string, FileParameter>();
    const entries: PassFileEntry[] = [];
    for (const block of blocks) {
        try {
            entries.push({ error: null, manifest: parsePassBlock(lines, block, fileParameters) });
        } catch (error) {
            if (!(error instanceof PassManifestError)) {
                throw error;
            }
            entries.push({ error, manifest: null });
        }
    }
    return entries;
}

/**
 * Parses and validates a source that holds exactly one pass into a typed manifest.
 * A source of several passes fails on the second pass's first line; parsePassFile reads such files.
 */
export function parsePassManifest(source: string): PassManifest {
    const lines = source.split(LINE_BREAK_PATTERN);
    const blocks = findPassBlocks(lines);
    if (blocks.length === 0) {
        throw createMissingHeaderError();
    }
    if (blocks.length > SINGLE_PASS_COUNT) {
        throw new PassManifestError(`The source holds ${blocks.length} passes; expected one`, blocks[SINGLE_PASS_COUNT].headerStart + 1);
    }
    return parsePassBlock(lines, blocks[0], new Map<string, FileParameter>());
}
