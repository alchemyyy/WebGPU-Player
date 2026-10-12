// Parses the `//!` header of a user pass into its PassManifest; overhual/passes.md documents the grammar.
import { BUILTIN_COLOR_FUNCTION_NAMES } from './builtin/BuiltinColorFunctions';
import { collectPassExpressionIdentifiers, parsePassExpression, PassExpressionError } from './PassExpression';
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

    constructor(message: string, line: number) {
        super(message);
        this.name = 'PassManifestError';
        this.line = line;
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
    parameters: readonly ParameterEntry[]
};

type ComponentCount = NonNullable<PassManifest['components']>;

type OutputSize = Pick<PassOutput, 'height' | 'width'>;

const HEADER_PREFIX = '//!';
const PARAMETER_KEYWORD = 'param';
// A missing directive has no line of its own
const MISSING_DIRECTIVE_LINE = 1;

const HOOKED = 'HOOKED';
const SCALER_HOOK: PresentationStage = 'SCALE';
const DEFAULT_DOMAIN: ColorDomain = 'any';
const MAXIMUM_NAME_LENGTH = 64;
/** The deepest history an input can read, as in `RGB[-8]`. */
const MAXIMUM_HISTORY_DEPTH = 8;
const MAXIMUM_PARAMETER_COUNT = 32;

const SHAPES: readonly PassShape[] = [ 'color', 'kernel', 'scaler', 'compute' ];
const STAGES: readonly PresentationStage[] = [ 'OUTPUT', 'PRESCALE', 'RGB', 'SCALE' ];
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
const REPEATABLE_DIRECTIVES: readonly Directive[] = [ 'input' ];

// The plan-time facts every expression may read
const GLOBAL_FACTS: readonly string[] = [
    'source.width',
    'source.height',
    'output.width',
    'output.height',
    'frame.rate',
    'hdr.source',
    'hdr.output'
];
// The global sizes; a texture with one of these names would shadow its facts
const GLOBAL_SIZE_NAMES: readonly string[] = [ 'source', 'output' ];
const WIDTH_SUFFIX = '.width';
const HEIGHT_SUFFIX = '.height';
const SIZE_SUFFIX = '.size';

const KERNEL_OUTPUT_FORMATS: readonly GPUTextureFormat[] = [
    'rgba16float',
    'rg16float',
    'r16float',
    'rgba32float',
    'r32float',
    'rgb10a2unorm',
    'rgba8unorm'
];
// A compute pass writes through a storage texture, so its format must be a core WebGPU storage format
const COMPUTE_OUTPUT_FORMATS: readonly GPUTextureFormat[] = [ 'rgba16float', 'rgba32float', 'r32float', 'rgba8unorm' ];
const DEFAULT_KERNEL_OUTPUT_FORMAT: GPUTextureFormat = 'rgba16float';

const AXIS_NAMES: readonly string[] = [ 'x', 'y', 'z' ];
// WebGPU's default maxComputeWorkgroupSizeX, Y, and Z, and maxComputeInvocationsPerWorkgroup
const MAXIMUM_WORKGROUP_SIZE: readonly number[] = [ 256, 256, 64 ];
const MAXIMUM_WORKGROUP_INVOCATIONS = 256;
// The value of a workgroup size or a dispatch count that a header omits
const DEFAULT_AXIS_VALUE = 1;

const I32_MINIMUM = -2_147_483_648;
const I32_MAXIMUM = 2_147_483_647;
const U32_MAXIMUM = 4_294_967_295;

const LINE_BREAK_PATTERN = /\r?\n/;
const WHITESPACE_PATTERN = /\s+/;
const IDENTIFIER_PATTERN = /^[A-Za-z_]\w*$/;
const HISTORY_INPUT_PATTERN = /^([A-Za-z_]\w*)\s*\[\s*-\s*(\d+)\s*\]$/;
// History input NAME[-N] has the accessors of NAME_historyN, so no texture name may end like that
const HISTORY_ACCESSOR_SUFFIX_PATTERN = /_history\d+$/;
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
const SCALER_HOOK_MESSAGE = `A scaler must hook ${SCALER_HOOK}`;
const SCALER_INPUT_MESSAGE = `A scaler reads only ${HOOKED}`;
const PARAMETER_COUNT_MESSAGE = `A pass declares at most ${MAXIMUM_PARAMETER_COUNT} parameters`;

/** Narrows a header word to one of the words a directive allows. */
function isOneOf<Word extends string>(words: readonly Word[], value: string): value is Word {
    return (words as readonly string[]).includes(value);
}

function isDirective(key: string): key is Directive {
    return Object.hasOwn(DIRECTIVE_SHAPES, key);
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

/** Splits a source into its header entries and its body, after optional leading blank lines. */
function readHeader(source: string): PassHeader {
    const lines = source.split(LINE_BREAK_PATTERN);
    let lineIndex = 0;
    while (lineIndex < lines.length && lines[lineIndex].trim() === '') {
        lineIndex += 1;
    }
    const headerStartIndex = lineIndex;
    const entries = new Map<Directive, HeaderEntry[]>();
    const parameters: ParameterEntry[] = [];
    for (; lineIndex < lines.length && lines[lineIndex].startsWith(HEADER_PREFIX); lineIndex += 1) {
        readHeaderLine(lines[lineIndex].slice(HEADER_PREFIX.length).trim(), lineIndex + 1, entries, parameters);
    }
    if (lineIndex === headerStartIndex) {
        throw new PassManifestError(MISSING_HEADER_MESSAGE, MISSING_DIRECTIVE_LINE);
    }
    // lineIndex is the 0-based index of the first body line
    return { body: lines.slice(lineIndex).join('\n'), bodyFirstLine: lineIndex + 1, entries, parameters };
}

function getEntry(header: PassHeader, directive: Directive): HeaderEntry | null {
    return header.entries.get(directive)?.[0] ?? null;
}

function requireEntry(header: PassHeader, directive: Directive): HeaderEntry {
    const entry = getEntry(header, directive);
    if (!entry) {
        throw new PassManifestError(`Missing required directive '${directive}'`, MISSING_DIRECTIVE_LINE);
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
    const names: string[] = [ HOOKED ];
    for (const input of inputs) {
        if (!names.includes(input.name)) {
            names.push(input.name);
        }
    }
    return names;
}

/** Returns the identifiers output and dispatch expressions may read: the global facts and the input sizes. */
function getSizeExpressionIdentifiers(inputs: readonly PassInput[]): string[] {
    const identifiers: string[] = [ ...GLOBAL_FACTS ];
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
    const hook = readWord(entry, STAGES, 'hook');
    if (shape === 'scaler' && hook !== SCALER_HOOK) {
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
        return [ { historyOffset: 0, name: HOOKED } ];
    }
    const inputs: PassInput[] = [];
    for (const entry of entries) {
        const input = parseInput(entry);
        if (inputs.some((declared: PassInput): boolean => declared.name === input.name && declared.historyOffset === input.historyOffset)) {
            throw new PassManifestError(`Duplicate input '${entry.value}'`, entry.line);
        }
        if (shape === 'scaler' && (input.name !== HOOKED || input.historyOffset !== 0)) {
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
    if (entry.value === HOOKED || isOneOf(STAGES, entry.value)) {
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
    const formats = shape === 'compute' ? COMPUTE_OUTPUT_FORMATS : KERNEL_OUTPUT_FORMATS;
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
                    format: DEFAULT_KERNEL_OUTPUT_FORMAT,
                    height: createIdentifier(HOOKED + HEIGHT_SUFFIX),
                    width: createIdentifier(HOOKED + WIDTH_SUFFIX)
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
    return entry ? parseExpression(entry.value, GLOBAL_FACTS, entry.line) : null;
}

/** Parses `<x>[, <y>[, <z>]]` positive integers within WebGPU's default workgroup limits; omitted sizes are 1. */
function parseWorkgroupSize(entry: HeaderEntry): PassWorkgroup['size'] {
    const parts = splitTopLevel(entry.value, entry.line);
    if (parts.length > AXIS_NAMES.length) {
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
                `Workgroup ${AXIS_NAMES[axisIndex]} size ${axisSize} exceeds ${MAXIMUM_WORKGROUP_SIZE[axisIndex]}`,
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
    if (parts.length > AXIS_NAMES.length) {
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

/** Parses and validates a user pass's `//!` header into a typed manifest. */
export function parsePassManifest(source: string): PassManifest {
    const header = readHeader(source);
    const name = readName(header);
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
