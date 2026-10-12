import { describe, expect, it } from 'vitest';

import { BUILTIN_COLOR_FUNCTION_NAMES } from 'webgpu-player/presentation/passes/builtin/BuiltinColorFunctions';
import catmullRomScalerShader from 'webgpu-player/presentation/passes/builtin/CatmullRomScaler.wgsl';
import { parsePassExpression } from 'webgpu-player/presentation/passes/PassExpression';
import { parsePassManifest, PassManifestError } from 'webgpu-player/presentation/passes/PassManifest';
import type {
    PassExpression,
    PassInput,
    PassManifest,
    PassOutput,
    PassWorkgroup
} from 'webgpu-player/presentation/passes/PassTypes';

import { SATURATION_COLOR_PASS } from './examples/SaturationColorPass';
import { SHARPEN_KERNEL_PASS } from './examples/SharpenKernelPass';
import { TEMPORAL_BLEND_KERNEL_PASS } from './examples/TemporalBlendKernelPass';

const LF = '\n';
const CRLF = '\r\n';
const CARRIAGE_RETURN = '\r';
const BODY_LINES: readonly string[] = [
    'fn kernel(coordinate: vec2f) -> vec4f {',
    '    return HOOKED_tex(coordinate);',
    '}'
];
// createSource puts a blank line between the header and the body lines, and that blank line starts the body
const EXPECTED_BODY = [ '', ...BODY_LINES ].join(LF);
// Whitespace-only lines count as blank before the header
const LEADING_BLANK_LINES: readonly string[] = [ '', '   ', '\t' ];
// A missing directive has no line of its own
const MISSING_DIRECTIVE_LINE = 1;
// The text that ends an example's header: its last line break, then a blank line
const EXAMPLE_HEADER_END = '\n\n';

const PASS_NAME = 'Test pass';
const NAME_LINE = `//! name: ${PASS_NAME}`;
// A kernel header after its name line
const KERNEL_DIRECTIVES: readonly string[] = [ '//! shape: kernel', '//! hook: OUTPUT' ];
const KERNEL_HEADER: readonly string[] = [ NAME_LINE, ...KERNEL_DIRECTIVES ];
const COLOR_HEADER: readonly string[] = [ NAME_LINE, '//! shape: color', '//! hook: OUTPUT' ];
const REPLACED_FUNCTION = 'builtin.tone-map';
const REPLACING_COLOR_HEADER: readonly string[] = [ NAME_LINE, '//! shape: color', `//! replaces: ${REPLACED_FUNCTION}` ];
const SCALER_HEADER: readonly string[] = [ NAME_LINE, '//! shape: scaler', '//! hook: SCALE' ];
const COMPUTE_WORKGROUP_SIZE = 8;
const COMPUTE_WORKGROUP_LINE = `//! workgroup: ${COMPUTE_WORKGROUP_SIZE}, ${COMPUTE_WORKGROUP_SIZE}`;
// A compute header before its output and workgroup lines
const COMPUTE_PREAMBLE: readonly string[] = [ NAME_LINE, '//! shape: compute', '//! hook: OUTPUT' ];
const COMPUTE_HEADER_WITHOUT_WORKGROUP: readonly string[] = [ ...COMPUTE_PREAMBLE, '//! output: HOOKED.size, rgba16float' ];
const COMPUTE_HEADER: readonly string[] = [ ...COMPUTE_HEADER_WITHOUT_WORKGROUP, COMPUTE_WORKGROUP_LINE ];

const MAXIMUM_NAME_LENGTH = 64;
const LONGEST_NAME = 'N'.repeat(MAXIMUM_NAME_LENGTH);
const OVERLONG_NAME = 'N'.repeat(MAXIMUM_NAME_LENGTH + 1);
// A character outside the Basic Multilingual Plane, two UTF-16 code units long, which counts once toward the name length
const ASTRAL_CHARACTER = '\u{1F3AC}';
const MAXIMUM_PARAMETER_COUNT = 32;
const EXTRA_PARAMETER_LINE = '//! param overflow: f32 = 0 in [0, 1]';
const MAXIMUM_HISTORY_DEPTH = 8;
const I32_EXTREMES_LINE = '//! param offset: i32 = 0 in [-2147483648, 2147483647]';
const U32_EXTREMES_LINE = '//! param mask: u32 = 0 in [0, 4294967295]';
const F32_EXTREMES_LINE = '//! param gain: f32 = 0 in [-3.4e38, 3.4e38]';
const I32_MINIMUM = -2_147_483_648;
const I32_MAXIMUM = 2_147_483_647;
const U32_MAXIMUM = 4_294_967_295;
const F32_EXTREME = 3.4e38;

const KERNEL_OUTPUT_FORMATS: readonly GPUTextureFormat[] = [
    'rgba16float',
    'rg16float',
    'r16float',
    'rgba32float',
    'r32float',
    'rgb10a2unorm',
    'rgba8unorm'
];
const COMPUTE_OUTPUT_FORMATS: readonly GPUTextureFormat[] = [ 'rgba16float', 'rgba32float', 'r32float', 'rgba8unorm' ];
const COMPONENT_COUNTS: readonly number[] = [ 1, 2, 3, 4 ];

const GLOBAL_FACT_LIST = 'source.width, source.height, output.width, output.height, frame.rate, hdr.source, hdr.output';
const HOOKED_SIZE_FACT_LIST = `${GLOBAL_FACT_LIST}, HOOKED.width, HOOKED.height`;

const MISSING_HEADER_MESSAGE = 'The pass has no //! header';
const MALFORMED_LINE_MESSAGE = "Expected '<directive>: <value>' or 'param <name>: <type> = <default> in [<minimum>, <maximum>]'";
const MALFORMED_PARAMETER_MESSAGE = "Expected 'param <name>: <type> = <default> in [<minimum>, <maximum>]'";
const MALFORMED_OUTPUT_MESSAGE = "Expected '<NAME>.size, <format>' or '<width>, <height>, <format>'";
const MALFORMED_WORKGROUP_MESSAGE = "Expected 'workgroup: <x>[, <y>[, <z>]]'";
const MALFORMED_DISPATCH_MESSAGE = "Expected 'dispatch: <x>[, <y>[, <z>]]'";
const MALFORMED_INPUT_SUFFIX = 'expected <NAME> or <NAME>[-<N>]';
const UNKNOWN_DIRECTIVE_MESSAGE = "Unknown directive 'sampler'";
const COMPONENTS_MESSAGE = 'Components must be one of 1, 2, 3, 4';
const HISTORY_ACCESSOR_SUFFIX_MESSAGE = 'ends in _history<digits>, which history accessors use';
const SCALER_INPUT_MESSAGE = 'A scaler reads only HOOKED';
const PARAMETER_COUNT_MESSAGE = 'A pass declares at most 32 parameters';
// Messages of the expression parser, which manifest errors keep
const UNBALANCED_PARENTHESIS_MESSAGE = 'Unbalanced parenthesis';
const TRAILING_OPERATOR_MESSAGE = 'Expression ends with an operator';
const EMPTY_EXPRESSION_MESSAGE = 'Empty expression';
const UNKNOWN_FUNCTION_MESSAGE = "Unknown function 'sqrt'";

function createIdentifier(name: string): PassExpression {
    return { kind: 'identifier', name };
}

function createNumber(value: number): PassExpression {
    return { kind: 'number', value };
}

function createCeilDivision(dividend: PassExpression, divisor: number): PassExpression {
    return {
        arguments: [ { kind: 'binary', left: dividend, operator: '/', right: createNumber(divisor) } ],
        kind: 'call',
        name: 'ceil'
    };
}

const HOOKED_INPUT: PassInput = { historyOffset: 0, name: 'HOOKED' };
const HOOKED_WIDTH = createIdentifier('HOOKED.width');
const HOOKED_HEIGHT = createIdentifier('HOOKED.height');
const HOOKED_SIZE_OUTPUT: PassOutput = { format: 'rgba16float', height: HOOKED_HEIGHT, width: HOOKED_WIDTH };
// The value of an omitted workgroup size or dispatch count
const OMITTED_AXIS_VALUE = 1;

const DEFAULT_KERNEL_MANIFEST: PassManifest = {
    body: EXPECTED_BODY,
    bodyFirstLine: KERNEL_HEADER.length + 1,
    components: null,
    domain: 'any',
    hook: 'OUTPUT',
    inputs: [ HOOKED_INPUT ],
    name: PASS_NAME,
    output: HOOKED_SIZE_OUTPUT,
    parameters: [],
    replaces: null,
    save: null,
    shape: 'kernel',
    when: null,
    workgroup: null
};
const COLOR_MANIFEST: PassManifest = {
    ...DEFAULT_KERNEL_MANIFEST,
    bodyFirstLine: COLOR_HEADER.length + 1,
    inputs: [],
    output: null,
    shape: 'color'
};
const REPLACING_COLOR_MANIFEST: PassManifest = {
    ...COLOR_MANIFEST,
    bodyFirstLine: REPLACING_COLOR_HEADER.length + 1,
    hook: null,
    replaces: REPLACED_FUNCTION
};
const SCALER_MANIFEST: PassManifest = {
    ...DEFAULT_KERNEL_MANIFEST,
    bodyFirstLine: SCALER_HEADER.length + 1,
    hook: 'SCALE',
    output: null,
    shape: 'scaler'
};
const COMPUTE_MANIFEST: PassManifest = {
    ...DEFAULT_KERNEL_MANIFEST,
    bodyFirstLine: COMPUTE_HEADER.length + 1,
    shape: 'compute',
    workgroup: {
        dispatch: [
            createCeilDivision(HOOKED_WIDTH, COMPUTE_WORKGROUP_SIZE),
            createCeilDivision(HOOKED_HEIGHT, COMPUTE_WORKGROUP_SIZE),
            createNumber(OMITTED_AXIS_VALUE)
        ],
        size: [ COMPUTE_WORKGROUP_SIZE, COMPUTE_WORKGROUP_SIZE, OMITTED_AXIS_VALUE ]
    }
};

const FULL_KERNEL_NAME = 'Full   kernel';
const FULL_KERNEL_WIDTH = 'max(LUMA.width, 16) * 2';
const FULL_KERNEL_HEIGHT = 'HOOKED.height / 2';
const FULL_KERNEL_CONDITION = 'output.width >= source.width * 1.5 && hdr.source == 0';
// Every kernel directive, with irregular whitespace around the tokens
const FULL_KERNEL_HEADER: readonly string[] = [
    `//!   name:   ${FULL_KERNEL_NAME}  `,
    '//! shape :kernel',
    '//!hook: RGB',
    '//! input: HOOKED',
    '//! input: LUMA',
    '//! input:  RGB [ - 2 ] ',
    '//! save:  DETAIL',
    `//! output: ${FULL_KERNEL_WIDTH},  ${FULL_KERNEL_HEIGHT} , rg16float`,
    '//! components: 2',
    '//! domain: linear',
    `//! when: ${FULL_KERNEL_CONDITION}`,
    '//!  param   strength :f32= -0.25   in[ -1.5e1 ,+2.5E-1 ]',
    '//! param radius: i32 = 3 in [-4, 4]',
    '//! param taps: u32 = 8 in [1, 16]'
];
const FULL_KERNEL_MANIFEST: PassManifest = {
    body: EXPECTED_BODY,
    bodyFirstLine: FULL_KERNEL_HEADER.length + 1,
    components: 2,
    domain: 'linear',
    hook: 'RGB',
    inputs: [ HOOKED_INPUT, { historyOffset: 0, name: 'LUMA' }, { historyOffset: -2, name: 'RGB' } ],
    name: FULL_KERNEL_NAME,
    output: { format: 'rg16float', height: parsePassExpression(FULL_KERNEL_HEIGHT), width: parsePassExpression(FULL_KERNEL_WIDTH) },
    parameters: [
        { defaultValue: -0.25, maximum: 0.25, minimum: -15, name: 'strength', type: 'f32' },
        { defaultValue: 3, maximum: 4, minimum: -4, name: 'radius', type: 'i32' },
        { defaultValue: 8, maximum: 16, minimum: 1, name: 'taps', type: 'u32' }
    ],
    replaces: null,
    save: 'DETAIL',
    shape: 'kernel',
    when: parsePassExpression(FULL_KERNEL_CONDITION),
    workgroup: null
};

const FULL_COMPUTE_WORKGROUP_SIZE = 16;
const FULL_COMPUTE_WIDTH = 'ceil(STATE.width / 2)';
const FULL_COMPUTE_HEIGHT = 'ceil(STATE.height / 2)';
const FULL_COMPUTE_CONDITION = 'frame.rate > 0';
// Every compute directive but dispatch; a pass that saves STATE and reads its own previous frame
const FULL_COMPUTE_HEADER: readonly string[] = [
    '//! name: Reduction',
    '//! shape: compute',
    '//! hook: PRESCALE',
    '//! input: STATE[-1]',
    `//! output: ${FULL_COMPUTE_WIDTH}, ${FULL_COMPUTE_HEIGHT}, r32float`,
    '//! save: STATE',
    '//! components: 1',
    `//! workgroup: ${FULL_COMPUTE_WORKGROUP_SIZE}, ${FULL_COMPUTE_WORKGROUP_SIZE}`,
    `//! when: ${FULL_COMPUTE_CONDITION}`
];
const FULL_COMPUTE_MANIFEST: PassManifest = {
    body: EXPECTED_BODY,
    bodyFirstLine: FULL_COMPUTE_HEADER.length + 1,
    components: 1,
    domain: 'any',
    hook: 'PRESCALE',
    inputs: [ { historyOffset: -1, name: 'STATE' } ],
    name: 'Reduction',
    output: { format: 'r32float', height: parsePassExpression(FULL_COMPUTE_HEIGHT), width: parsePassExpression(FULL_COMPUTE_WIDTH) },
    parameters: [],
    replaces: null,
    save: 'STATE',
    shape: 'compute',
    when: parsePassExpression(FULL_COMPUTE_CONDITION),
    workgroup: {
        dispatch: [
            createCeilDivision(parsePassExpression(FULL_COMPUTE_WIDTH), FULL_COMPUTE_WORKGROUP_SIZE),
            createCeilDivision(parsePassExpression(FULL_COMPUTE_HEIGHT), FULL_COMPUTE_WORKGROUP_SIZE),
            createNumber(OMITTED_AXIS_VALUE)
        ],
        size: [ FULL_COMPUTE_WORKGROUP_SIZE, FULL_COMPUTE_WORKGROUP_SIZE, OMITTED_AXIS_VALUE ]
    }
};

type SizeReferenceCase = {
    headerLines: readonly string[]
    label: string
    output: PassOutput
};

const SIZE_REFERENCE_CASES: readonly SizeReferenceCase[] = [
    {
        headerLines: [ ...KERNEL_HEADER, '//! input: LUMA[-1]', '//! output: LUMA.size, r16float' ],
        label: 'the base name of a history input',
        output: { format: 'r16float', height: createIdentifier('LUMA.height'), width: createIdentifier('LUMA.width') }
    },
    {
        headerLines: [ ...KERNEL_HEADER, '//! output: source.size, rgba32float' ],
        label: 'the source',
        output: { format: 'rgba32float', height: createIdentifier('source.height'), width: createIdentifier('source.width') }
    },
    {
        headerLines: [ ...KERNEL_HEADER, '//! output: output.size, rgb10a2unorm' ],
        label: 'the output',
        output: { format: 'rgb10a2unorm', height: createIdentifier('output.height'), width: createIdentifier('output.width') }
    }
];

type WorkgroupSizeCase = {
    size: PassWorkgroup['size']
    text: string
};

const WORKGROUP_SIZE_CASES: readonly WorkgroupSizeCase[] = [
    { size: [ 64, 1, 1 ], text: '64' },
    { size: [ 16, 16, 1 ], text: '16, 16' },
    { size: [ 4, 4, 16 ], text: '4,4,16' },
    { size: [ 256, 1, 1 ], text: '256' },
    { size: [ 1, 256, 1 ], text: '1, 256' },
    { size: [ 1, 1, 64 ], text: '1, 1, 64' }
];

const DISPATCH_X = 'ceil(output.width / 16)';
const DISPATCH_Y = 'max(HOOKED.height, source.height) / 8';
const DISPATCH_Z = '2';

type DispatchCase = {
    dispatch: PassWorkgroup['dispatch']
    text: string
};

const DISPATCH_CASES: readonly DispatchCase[] = [
    {
        dispatch: [ parsePassExpression(DISPATCH_X), createNumber(OMITTED_AXIS_VALUE), createNumber(OMITTED_AXIS_VALUE) ],
        text: DISPATCH_X
    },
    {
        dispatch: [ parsePassExpression(DISPATCH_X), parsePassExpression(DISPATCH_Y), createNumber(OMITTED_AXIS_VALUE) ],
        text: `${DISPATCH_X}, ${DISPATCH_Y}`
    },
    {
        dispatch: [ parsePassExpression(DISPATCH_X), parsePassExpression(DISPATCH_Y), parsePassExpression(DISPATCH_Z) ],
        text: `${DISPATCH_X}, ${DISPATCH_Y}, ${DISPATCH_Z}`
    }
];

type HeaderlessCase = {
    label: string
    source: string
};

const HEADERLESS_CASES: readonly HeaderlessCase[] = [
    { label: 'an empty source', source: '' },
    { label: 'blank lines alone', source: LEADING_BLANK_LINES.join(LF) },
    { label: 'a body without a header', source: BODY_LINES.join(LF) },
    { label: 'header lines after the body starts', source: [ ...BODY_LINES, ...KERNEL_HEADER ].join(LF) },
    { label: 'indented header lines', source: KERNEL_HEADER.map((line: string): string => `    ${line}`).join(LF) },
    { label: 'a plain comment before the header', source: [ '// A sharpener', ...KERNEL_HEADER ].join(LF) }
];

type ErrorCase = {
    headerLines: readonly string[]
    label: string
    line: number
    message: string
};

/** Appends an offending line to a valid header, so the error is on the line after that header. */
function appendLine(headerLines: readonly string[], offendingLine: string): Pick<ErrorCase, 'headerLines' | 'line'> {
    return { headerLines: [ ...headerLines, offendingLine ], line: headerLines.length + 1 };
}

/** Declares distinct, valid f32 parameters. */
function createParameterLines(count: number): string[] {
    const lines: string[] = [];
    for (let parameterIndex = 0; parameterIndex < count; parameterIndex += 1) {
        lines.push(`//! param parameter${parameterIndex}: f32 = 0 in [0, 1]`);
    }
    return lines;
}

const HEADER_FORM_ERROR_CASES: readonly ErrorCase[] = [
    { label: 'a line without a colon', message: MALFORMED_LINE_MESSAGE, ...appendLine(KERNEL_HEADER, '//! domain any') },
    { label: 'an empty header line', message: MALFORMED_LINE_MESSAGE, ...appendLine(KERNEL_HEADER, '//!') },
    { label: 'a line without a directive', message: MALFORMED_LINE_MESSAGE, ...appendLine(KERNEL_HEADER, '//! : any') },
    { label: 'a parameter without a name', message: MALFORMED_PARAMETER_MESSAGE, ...appendLine(KERNEL_HEADER, '//! param: f32 = 1 in [0, 2]') },
    {
        label: 'a parameter with two names',
        message: MALFORMED_PARAMETER_MESSAGE,
        ...appendLine(KERNEL_HEADER, '//! param gain boost: f32 = 1 in [0, 2]')
    },
    { label: 'an unknown directive', message: UNKNOWN_DIRECTIVE_MESSAGE, ...appendLine(KERNEL_HEADER, '//! sampler: linear') },
    { label: 'a directive in another case', message: "Unknown directive 'Domain'", ...appendLine(KERNEL_HEADER, '//! Domain: any') },
    { label: 'a two-word directive', message: "Unknown directive 'color space'", ...appendLine(KERNEL_HEADER, '//! color space: srgb') },
    { label: 'an object property name', message: "Unknown directive 'constructor'", ...appendLine(KERNEL_HEADER, '//! constructor: any') },
    { label: 'a repeated directive', message: "Repeated directive 'name'", ...appendLine(KERNEL_HEADER, '//! name: Again') },
    { label: 'a directive without a value', message: "Directive 'domain' has no value", ...appendLine(KERNEL_HEADER, '//! domain:  ') },
    {
        headerLines: [ '//! name:', ...KERNEL_DIRECTIVES ],
        label: 'an empty name',
        line: 1,
        message: "Directive 'name' has no value"
    }
];

const REQUIRED_DIRECTIVE_ERROR_CASES: readonly ErrorCase[] = [
    {
        headerLines: KERNEL_DIRECTIVES,
        label: 'a missing name',
        line: MISSING_DIRECTIVE_LINE,
        message: "Missing required directive 'name'"
    },
    {
        headerLines: [ NAME_LINE, '//! hook: OUTPUT' ],
        label: 'a missing shape',
        line: MISSING_DIRECTIVE_LINE,
        message: "Missing required directive 'shape'"
    },
    {
        headerLines: [ NAME_LINE, '//! shape: kernel' ],
        label: 'a kernel without a hook',
        line: MISSING_DIRECTIVE_LINE,
        message: "Missing required directive 'hook'"
    },
    {
        headerLines: [ NAME_LINE, '//! shape: color' ],
        label: 'a color pass without a hook or replaces',
        line: MISSING_DIRECTIVE_LINE,
        message: "Missing required directive 'hook'"
    },
    {
        headerLines: [ ...COMPUTE_PREAMBLE, COMPUTE_WORKGROUP_LINE ],
        label: 'a compute pass without an output',
        line: MISSING_DIRECTIVE_LINE,
        message: "Missing required directive 'output'"
    },
    {
        headerLines: COMPUTE_HEADER_WITHOUT_WORKGROUP,
        label: 'a compute pass without a workgroup',
        line: MISSING_DIRECTIVE_LINE,
        message: "Missing required directive 'workgroup'"
    },
    {
        headerLines: [ ...COMPUTE_HEADER_WITHOUT_WORKGROUP, '//! dispatch: 1' ],
        label: 'a dispatch without a workgroup',
        line: MISSING_DIRECTIVE_LINE,
        message: "Missing required directive 'workgroup'"
    }
];

const SHAPE_ERROR_CASES: readonly ErrorCase[] = [
    {
        headerLines: [ `//! name: ${OVERLONG_NAME}`, ...KERNEL_DIRECTIVES ],
        label: 'a name longer than 64 characters',
        line: 1,
        message: 'The name is longer than 64 characters'
    },
    {
        headerLines: [ NAME_LINE, '//! shape: shader', '//! hook: OUTPUT' ],
        label: 'an unknown shape',
        line: 2,
        message: "Unknown shape 'shader'; expected color, kernel, scaler, compute"
    },
    { label: 'an input in a color pass', message: "A color pass cannot declare 'input'", ...appendLine(COLOR_HEADER, '//! input: HOOKED') },
    {
        label: 'an output in a color pass',
        message: "A color pass cannot declare 'output'",
        ...appendLine(COLOR_HEADER, '//! output: HOOKED.size, rgba16float')
    },
    {
        label: 'components in a color pass',
        message: "A color pass cannot declare 'components'",
        ...appendLine(COLOR_HEADER, '//! components: 1')
    },
    {
        label: 'an output in a scaler',
        message: "A scaler pass cannot declare 'output'",
        ...appendLine(SCALER_HEADER, '//! output: HOOKED.size, rgba16float')
    },
    { label: 'a save in a scaler', message: "A scaler pass cannot declare 'save'", ...appendLine(SCALER_HEADER, '//! save: SCALED') },
    {
        label: 'replaces in a scaler',
        message: "A scaler pass cannot declare 'replaces'",
        ...appendLine(SCALER_HEADER, `//! replaces: ${REPLACED_FUNCTION}`)
    },
    {
        label: 'replaces in a kernel',
        message: "A kernel pass cannot declare 'replaces'",
        ...appendLine(KERNEL_HEADER, `//! replaces: ${REPLACED_FUNCTION}`)
    },
    { label: 'a workgroup in a kernel', message: "A kernel pass cannot declare 'workgroup'", ...appendLine(KERNEL_HEADER, COMPUTE_WORKGROUP_LINE) },
    { label: 'a dispatch in a kernel', message: "A kernel pass cannot declare 'dispatch'", ...appendLine(KERNEL_HEADER, '//! dispatch: 1') },
    {
        label: 'replaces in a compute pass',
        message: "A compute pass cannot declare 'replaces'",
        ...appendLine(COMPUTE_HEADER, '//! replaces: builtin.dither')
    }
];

const HOOK_AND_DOMAIN_ERROR_CASES: readonly ErrorCase[] = [
    {
        headerLines: [ NAME_LINE, '//! shape: color', '//! replaces: builtin.sharpen' ],
        label: 'an unknown replaced function',
        line: 3,
        message: `Unknown built-in color function 'builtin.sharpen'; expected ${BUILTIN_COLOR_FUNCTION_NAMES.join(', ')}`
    },
    {
        label: 'a hook with replaces',
        message: 'A color pass with replaces cannot declare a hook',
        ...appendLine(REPLACING_COLOR_HEADER, '//! hook: OUTPUT')
    },
    {
        label: 'a domain with replaces',
        message: 'A color pass with replaces cannot declare a domain',
        ...appendLine(REPLACING_COLOR_HEADER, '//! domain: linear')
    },
    {
        headerLines: [ NAME_LINE, '//! shape: kernel', '//! hook: MAIN' ],
        label: 'an unknown hook',
        line: 3,
        message: "Unknown hook 'MAIN'; expected OUTPUT, PRESCALE, RGB, SCALE"
    },
    {
        headerLines: [ NAME_LINE, '//! shape: scaler', '//! hook: OUTPUT' ],
        label: 'a scaler off the SCALE hook',
        line: 3,
        message: 'A scaler must hook SCALE'
    },
    {
        label: 'an unknown domain',
        message: "Unknown domain 'hdr'; expected any, display, linear, sdr, source",
        ...appendLine(KERNEL_HEADER, '//! domain: hdr')
    }
];

const INPUT_AND_SAVE_ERROR_CASES: readonly ErrorCase[] = [
    { label: 'a positive history offset', message: `Malformed input 'RGB[1]'; ${MALFORMED_INPUT_SUFFIX}`, ...appendLine(KERNEL_HEADER, '//! input: RGB[1]') },
    {
        label: 'a fractional history offset',
        message: `Malformed input 'RGB[-1.5]'; ${MALFORMED_INPUT_SUFFIX}`,
        ...appendLine(KERNEL_HEADER, '//! input: RGB[-1.5]')
    },
    { label: 'an input that is not an identifier', message: `Malformed input '2X'; ${MALFORMED_INPUT_SUFFIX}`, ...appendLine(KERNEL_HEADER, '//! input: 2X') },
    { label: 'a history depth of 0', message: 'History depth 0 is outside 1 to 8', ...appendLine(KERNEL_HEADER, '//! input: RGB[-0]') },
    { label: 'a history depth beyond 8', message: 'History depth 9 is outside 1 to 8', ...appendLine(KERNEL_HEADER, '//! input: RGB[-9]') },
    {
        headerLines: [ ...KERNEL_HEADER, '//! input: RGB[-1]', '//! input: RGB [-1]' ],
        label: 'a duplicate input',
        line: KERNEL_HEADER.length + 2,
        message: "Duplicate input 'RGB [-1]'"
    },
    { label: 'an input named like a global size', message: "'source' is reserved for global facts", ...appendLine(KERNEL_HEADER, '//! input: source') },
    {
        label: 'an input named like a history accessor',
        message: `'RGB_history1' ${HISTORY_ACCESSOR_SUFFIX_MESSAGE}`,
        ...appendLine(KERNEL_HEADER, '//! input: RGB_history1')
    },
    { label: 'a scaler reading another input', message: SCALER_INPUT_MESSAGE, ...appendLine(SCALER_HEADER, '//! input: RGB') },
    { label: 'a scaler reading history', message: SCALER_INPUT_MESSAGE, ...appendLine(SCALER_HEADER, '//! input: HOOKED[-1]') },
    {
        label: 'a save name that is not an identifier',
        message: "Save name 'sharp-edges' is not an identifier",
        ...appendLine(KERNEL_HEADER, '//! save: sharp-edges')
    },
    { label: 'saving to HOOKED', message: "Cannot save to the stage name 'HOOKED'", ...appendLine(KERNEL_HEADER, '//! save: HOOKED') },
    { label: 'saving to a stage', message: "Cannot save to the stage name 'PRESCALE'", ...appendLine(KERNEL_HEADER, '//! save: PRESCALE') },
    { label: 'saving to a global size', message: "'output' is reserved for global facts", ...appendLine(KERNEL_HEADER, '//! save: output') },
    {
        label: 'saving to a history accessor name',
        message: `'DETAIL_history2' ${HISTORY_ACCESSOR_SUFFIX_MESSAGE}`,
        ...appendLine(KERNEL_HEADER, '//! save: DETAIL_history2')
    }
];

const OUTPUT_ERROR_CASES: readonly ErrorCase[] = [
    { label: 'a size reference without a format', message: MALFORMED_OUTPUT_MESSAGE, ...appendLine(KERNEL_HEADER, '//! output: HOOKED.size') },
    { label: 'an output of four parts', message: MALFORMED_OUTPUT_MESSAGE, ...appendLine(KERNEL_HEADER, '//! output: 1, 2, 3, rgba16float') },
    {
        label: 'a size expression in place of a size reference',
        message: MALFORMED_OUTPUT_MESSAGE,
        ...appendLine(KERNEL_HEADER, '//! output: HOOKED.width * 2, rgba16float')
    },
    {
        label: 'a size reference to an undeclared input',
        message: "Unknown size 'LUMA.size'; expected HOOKED.size, source.size, output.size",
        ...appendLine(KERNEL_HEADER, '//! output: LUMA.size, rgba16float')
    },
    {
        label: 'a kernel format outside the list',
        message: `Format 'bgra8unorm' is not a kernel output format; expected ${KERNEL_OUTPUT_FORMATS.join(', ')}`,
        ...appendLine(KERNEL_HEADER, '//! output: HOOKED.size, bgra8unorm')
    },
    {
        headerLines: [ ...COMPUTE_PREAMBLE, '//! output: HOOKED.size, rg16float', COMPUTE_WORKGROUP_LINE ],
        label: 'a compute format that cannot be a storage texture',
        line: COMPUTE_PREAMBLE.length + 1,
        message: `Format 'rg16float' is not a compute output format; expected ${COMPUTE_OUTPUT_FORMATS.join(', ')}`
    },
    {
        label: 'a malformed size expression',
        message: TRAILING_OPERATOR_MESSAGE,
        ...appendLine(KERNEL_HEADER, '//! output: HOOKED.width *, HOOKED.height, rgba16float')
    },
    {
        label: 'an unknown function in a size expression',
        message: UNKNOWN_FUNCTION_MESSAGE,
        ...appendLine(KERNEL_HEADER, '//! output: sqrt(HOOKED.width), HOOKED.height, rgba16float')
    },
    {
        label: 'an unclosed parenthesis',
        message: UNBALANCED_PARENTHESIS_MESSAGE,
        ...appendLine(KERNEL_HEADER, '//! output: max(HOOKED.width, 2, HOOKED.height, rgba16float')
    },
    {
        label: 'a stray closing parenthesis',
        message: UNBALANCED_PARENTHESIS_MESSAGE,
        ...appendLine(KERNEL_HEADER, '//! output: HOOKED.width), HOOKED.height, rgba16float')
    },
    {
        label: 'an unknown identifier in a size expression',
        message: `Unknown identifier 'stream.width'; expected ${HOOKED_SIZE_FACT_LIST}`,
        ...appendLine(KERNEL_HEADER, '//! output: stream.width, HOOKED.height, rgba16float')
    },
    { label: 'zero components', message: COMPONENTS_MESSAGE, ...appendLine(KERNEL_HEADER, '//! components: 0') },
    { label: 'five components', message: COMPONENTS_MESSAGE, ...appendLine(KERNEL_HEADER, '//! components: 5') },
    { label: 'fractional components', message: COMPONENTS_MESSAGE, ...appendLine(KERNEL_HEADER, '//! components: 2.0') },
    {
        label: 'a condition on an input size',
        message: `Unknown identifier 'HOOKED.width'; expected ${GLOBAL_FACT_LIST}`,
        ...appendLine(KERNEL_HEADER, '//! when: HOOKED.width > 960')
    },
    { label: 'a malformed condition', message: TRAILING_OPERATOR_MESSAGE, ...appendLine(KERNEL_HEADER, '//! when: output.width >=') }
];

const PARAMETER_ERROR_CASES: readonly ErrorCase[] = [
    { label: 'a parameter without a range', message: MALFORMED_PARAMETER_MESSAGE, ...appendLine(KERNEL_HEADER, '//! param strength: f32 = 0.5') },
    {
        label: 'a parameter without a default',
        message: MALFORMED_PARAMETER_MESSAGE,
        ...appendLine(KERNEL_HEADER, '//! param strength: f32 in [0, 1]')
    },
    {
        label: 'a range of one bound',
        message: MALFORMED_PARAMETER_MESSAGE,
        ...appendLine(KERNEL_HEADER, '//! param strength: f32 = 0.5 in [0]')
    },
    {
        label: 'a range of three bounds',
        message: MALFORMED_PARAMETER_MESSAGE,
        ...appendLine(KERNEL_HEADER, '//! param strength: f32 = 0.5 in [0, 1, 2]')
    },
    {
        label: 'a parameter name that is not an identifier',
        message: "Parameter name '2x' is not an identifier",
        ...appendLine(KERNEL_HEADER, '//! param 2x: f32 = 0.5 in [0, 1]')
    },
    {
        label: 'an unknown parameter type',
        message: "Unknown parameter type 'f64'; expected f32, i32, u32",
        ...appendLine(KERNEL_HEADER, '//! param strength: f64 = 0.5 in [0, 1]')
    },
    {
        label: 'a number without an integer part',
        message: "Malformed number '.5'",
        ...appendLine(KERNEL_HEADER, '//! param strength: f32 = .5 in [0, 1]')
    },
    {
        label: 'a hexadecimal number',
        message: "Malformed number '0x1'",
        ...appendLine(KERNEL_HEADER, '//! param strength: f32 = 0x1 in [0, 1]')
    },
    {
        label: 'a word in place of a bound',
        message: "Malformed number 'one'",
        ...appendLine(KERNEL_HEADER, '//! param strength: f32 = 0.5 in [0, one]')
    },
    {
        label: 'a default above the maximum',
        message: "Parameter 'strength' default 2 is outside [0, 1]",
        ...appendLine(KERNEL_HEADER, '//! param strength: f32 = 2 in [0, 1]')
    },
    {
        label: 'a default below the minimum',
        message: "Parameter 'strength' default -1 is outside [0, 1]",
        ...appendLine(KERNEL_HEADER, '//! param strength: f32 = -1 in [0, 1]')
    },
    {
        label: 'a minimum above the maximum',
        message: "Parameter 'strength' default 0.5 is outside [1, 0]",
        ...appendLine(KERNEL_HEADER, '//! param strength: f32 = 0.5 in [1, 0]')
    },
    {
        label: 'a fractional i32',
        message: "1.5 is not a valid i32 value for parameter 'radius'",
        ...appendLine(KERNEL_HEADER, '//! param radius: i32 = 1.5 in [0, 4]')
    },
    {
        label: 'an i32 beyond 32 bits',
        message: "2147483648 is not a valid i32 value for parameter 'radius'",
        ...appendLine(KERNEL_HEADER, '//! param radius: i32 = 0 in [0, 2147483648]')
    },
    {
        label: 'a negative u32',
        message: "-1 is not a valid u32 value for parameter 'taps'",
        ...appendLine(KERNEL_HEADER, '//! param taps: u32 = 1 in [-1, 4]')
    },
    {
        label: 'a u32 beyond 32 bits',
        message: "4294967296 is not a valid u32 value for parameter 'taps'",
        ...appendLine(KERNEL_HEADER, '//! param taps: u32 = 1 in [0, 4294967296]')
    },
    {
        label: 'an f32 beyond its range',
        message: "1e39 is not a valid f32 value for parameter 'gain'",
        ...appendLine(KERNEL_HEADER, '//! param gain: f32 = 0 in [0, 1e39]')
    },
    {
        headerLines: [ ...KERNEL_HEADER, '//! param strength: f32 = 0.5 in [0, 1]', '//! param strength: f32 = 0.25 in [0, 1]' ],
        label: 'a duplicate parameter',
        line: KERNEL_HEADER.length + 2,
        message: "Duplicate parameter 'strength'"
    },
    {
        label: 'a parameter beyond 32',
        message: PARAMETER_COUNT_MESSAGE,
        ...appendLine([ ...KERNEL_HEADER, ...createParameterLines(MAXIMUM_PARAMETER_COUNT) ], EXTRA_PARAMETER_LINE)
    }
];

const WORKGROUP_ERROR_CASES: readonly ErrorCase[] = [
    {
        label: 'a workgroup of four sizes',
        message: MALFORMED_WORKGROUP_MESSAGE,
        ...appendLine(COMPUTE_HEADER_WITHOUT_WORKGROUP, '//! workgroup: 4, 4, 4, 4')
    },
    {
        label: 'a workgroup size of 0',
        message: "Workgroup size '0' is not a positive integer",
        ...appendLine(COMPUTE_HEADER_WITHOUT_WORKGROUP, '//! workgroup: 0, 8')
    },
    {
        label: 'a fractional workgroup size',
        message: "Workgroup size '8.5' is not a positive integer",
        ...appendLine(COMPUTE_HEADER_WITHOUT_WORKGROUP, '//! workgroup: 8.5')
    },
    {
        label: 'a workgroup wider than 256',
        message: 'Workgroup x size 512 exceeds 256',
        ...appendLine(COMPUTE_HEADER_WITHOUT_WORKGROUP, '//! workgroup: 512')
    },
    {
        label: 'a workgroup taller than 256',
        message: 'Workgroup y size 257 exceeds 256',
        ...appendLine(COMPUTE_HEADER_WITHOUT_WORKGROUP, '//! workgroup: 1, 257')
    },
    {
        label: 'a workgroup deeper than 64',
        message: 'Workgroup z size 65 exceeds 64',
        ...appendLine(COMPUTE_HEADER_WITHOUT_WORKGROUP, '//! workgroup: 1, 1, 65')
    },
    {
        label: 'a workgroup of more than 256 invocations',
        message: 'A workgroup of 512 invocations exceeds 256',
        ...appendLine(COMPUTE_HEADER_WITHOUT_WORKGROUP, '//! workgroup: 32, 16')
    },
    { label: 'a dispatch of four counts', message: MALFORMED_DISPATCH_MESSAGE, ...appendLine(COMPUTE_HEADER, '//! dispatch: 1, 1, 1, 1') },
    { label: 'an empty dispatch count', message: EMPTY_EXPRESSION_MESSAGE, ...appendLine(COMPUTE_HEADER, '//! dispatch: 8,') },
    {
        label: 'an unknown identifier in a dispatch',
        message: `Unknown identifier 'stream.width'; expected ${HOOKED_SIZE_FACT_LIST}`,
        ...appendLine(COMPUTE_HEADER, '//! dispatch: ceil(stream.width / 8)')
    },
    {
        label: 'an unclosed dispatch call',
        message: UNBALANCED_PARENTHESIS_MESSAGE,
        ...appendLine(COMPUTE_HEADER, '//! dispatch: ceil(output.width / 8')
    }
];

/** The text after the blank line that ends an example's header. */
function getBodyAfterHeader(source: string): string {
    return source.slice(source.indexOf(EXAMPLE_HEADER_END) + 1);
}

const SATURATION_MANIFEST: PassManifest = {
    body: getBodyAfterHeader(SATURATION_COLOR_PASS),
    // After five header lines
    bodyFirstLine: 6,
    components: null,
    domain: 'display',
    hook: 'OUTPUT',
    inputs: [],
    name: 'Saturation',
    output: null,
    parameters: [ { defaultValue: 1.2, maximum: 2, minimum: 0, name: 'saturation', type: 'f32' } ],
    replaces: null,
    save: null,
    shape: 'color',
    when: null,
    workgroup: null
};
const SHARPEN_MANIFEST: PassManifest = {
    body: getBodyAfterHeader(SHARPEN_KERNEL_PASS),
    // After seven header lines
    bodyFirstLine: 8,
    components: null,
    domain: 'sdr',
    hook: 'OUTPUT',
    inputs: [ HOOKED_INPUT ],
    name: 'Sharpen',
    output: HOOKED_SIZE_OUTPUT,
    parameters: [ { defaultValue: 0.5, maximum: 1, minimum: 0, name: 'strength', type: 'f32' } ],
    replaces: null,
    save: null,
    shape: 'kernel',
    when: null,
    workgroup: null
};
const TEMPORAL_BLEND_MANIFEST: PassManifest = {
    body: getBodyAfterHeader(TEMPORAL_BLEND_KERNEL_PASS),
    // After eight header lines
    bodyFirstLine: 9,
    components: null,
    domain: 'any',
    hook: 'RGB',
    inputs: [ HOOKED_INPUT, { historyOffset: -1, name: 'RGB' } ],
    name: 'Temporal blend',
    output: HOOKED_SIZE_OUTPUT,
    parameters: [ { defaultValue: 0.5, maximum: 1, minimum: 0, name: 'blend', type: 'f32' } ],
    replaces: null,
    save: null,
    shape: 'kernel',
    when: null,
    workgroup: null
};
const CATMULL_ROM_MANIFEST: PassManifest = {
    body: getBodyAfterHeader(catmullRomScalerShader),
    // After five header lines
    bodyFirstLine: 6,
    components: null,
    domain: 'any',
    hook: 'SCALE',
    inputs: [ HOOKED_INPUT ],
    name: 'Catmull-Rom',
    output: null,
    parameters: [],
    replaces: null,
    save: null,
    shape: 'scaler',
    when: null,
    workgroup: null
};

type ExampleCase = {
    expected: PassManifest
    label: string
    source: string
};

const EXAMPLE_CASES: readonly ExampleCase[] = [
    { expected: SATURATION_MANIFEST, label: 'saturation color pass', source: SATURATION_COLOR_PASS },
    { expected: SHARPEN_MANIFEST, label: 'sharpen kernel', source: SHARPEN_KERNEL_PASS },
    { expected: TEMPORAL_BLEND_MANIFEST, label: 'temporal blend kernel', source: TEMPORAL_BLEND_KERNEL_PASS },
    { expected: CATMULL_ROM_MANIFEST, label: 'Catmull-Rom scaler', source: catmullRomScalerShader }
];

/** Joins header lines, a blank line, and the body lines into a pass source. */
function createSource(headerLines: readonly string[], lineBreak: string = LF): string {
    return [ ...headerLines, '', ...BODY_LINES ].join(lineBreak);
}

/** Parses a source that must fail, and returns its manifest error. */
function captureManifestError(source: string): PassManifestError {
    try {
        parsePassManifest(source);
    } catch (error) {
        if (error instanceof PassManifestError) {
            return error;
        }
        throw error;
    }
    throw new Error('The pass header parsed without an error');
}

describe('pass manifest directives', () => {
    it('applies every default to a kernel with only the required directives', () => {
        expect(parsePassManifest(createSource(KERNEL_HEADER))).toEqual(DEFAULT_KERNEL_MANIFEST);
    });

    it('reads every kernel directive, with any whitespace around the tokens', () => {
        expect(parsePassManifest(createSource(FULL_KERNEL_HEADER))).toEqual(FULL_KERNEL_MANIFEST);
    });

    it.each(SIZE_REFERENCE_CASES)('sizes an output by $label', ({ headerLines, output }) => {
        expect(parsePassManifest(createSource(headerLines)).output).toEqual(output);
    });

    it.each(KERNEL_OUTPUT_FORMATS)('writes a kernel output as %s', format => {
        const manifest = parsePassManifest(createSource([ ...KERNEL_HEADER, `//! output: HOOKED.size, ${format}` ]));

        expect(manifest.output).toEqual({ ...HOOKED_SIZE_OUTPUT, format });
    });

    it.each(COMPONENT_COUNTS)('declares %i components', componentCount => {
        const manifest = parsePassManifest(createSource([ ...KERNEL_HEADER, `//! components: ${componentCount}` ]));

        expect(manifest.components).toBe(componentCount);
    });

    it('reads a color pass, which has no inputs and no output', () => {
        expect(parsePassManifest(createSource(COLOR_HEADER))).toEqual(COLOR_MANIFEST);
    });

    it('reads a color pass with replaces, which has no hook and any domain', () => {
        expect(parsePassManifest(createSource(REPLACING_COLOR_HEADER))).toEqual(REPLACING_COLOR_MANIFEST);
    });

    it.each(BUILTIN_COLOR_FUNCTION_NAMES)('replaces %s', functionName => {
        const manifest = parsePassManifest(createSource([ NAME_LINE, '//! shape: color', `//! replaces: ${functionName}` ]));

        expect(manifest.replaces).toBe(functionName);
        expect(manifest.hook).toBeNull();
    });

    it('reads a scaler, which reads HOOKED alone and has no output', () => {
        expect(parsePassManifest(createSource(SCALER_HEADER))).toEqual(SCALER_MANIFEST);
        expect(parsePassManifest(createSource([ ...SCALER_HEADER, '//! input: HOOKED' ]))).toEqual({
            ...SCALER_MANIFEST,
            bodyFirstLine: SCALER_HEADER.length + 2
        });
    });

    it('reads a compute pass, whose default dispatch covers its output with workgroups', () => {
        expect(parsePassManifest(createSource(COMPUTE_HEADER))).toEqual(COMPUTE_MANIFEST);
    });

    it('reads every compute directive, and builds the default dispatch from the output expressions', () => {
        expect(parsePassManifest(createSource(FULL_COMPUTE_HEADER))).toEqual(FULL_COMPUTE_MANIFEST);
    });

    it.each(COMPUTE_OUTPUT_FORMATS)('writes a compute output as %s', format => {
        const manifest = parsePassManifest(createSource([ ...COMPUTE_PREAMBLE, `//! output: HOOKED.size, ${format}`, COMPUTE_WORKGROUP_LINE ]));

        expect(manifest.output).toEqual({ ...HOOKED_SIZE_OUTPUT, format });
    });

    it.each(WORKGROUP_SIZE_CASES)('reads the workgroup size $text, with omitted sizes of 1', ({ size, text }) => {
        const manifest = parsePassManifest(createSource([ ...COMPUTE_HEADER_WITHOUT_WORKGROUP, `//! workgroup: ${text}` ]));

        expect(manifest.workgroup?.size).toEqual(size);
    });

    it.each(DISPATCH_CASES)('reads the dispatch $text, with omitted counts of 1', ({ dispatch, text }) => {
        const manifest = parsePassManifest(createSource([ ...COMPUTE_HEADER, `//! dispatch: ${text}` ]));

        expect(manifest.workgroup).toEqual({ dispatch, size: COMPUTE_MANIFEST.workgroup?.size });
    });

    it('lets a dispatch read the size of a declared input', () => {
        const manifest = parsePassManifest(createSource([ ...COMPUTE_HEADER, '//! input: STATE', '//! dispatch: STATE.width' ]));

        expect(manifest.workgroup?.dispatch[0]).toEqual(createIdentifier('STATE.width'));
    });

    it('accepts the longest name, counted in characters', () => {
        const astralName = ASTRAL_CHARACTER.repeat(MAXIMUM_NAME_LENGTH);

        expect(parsePassManifest(createSource([ `//! name: ${LONGEST_NAME}`, ...KERNEL_DIRECTIVES ])).name).toBe(LONGEST_NAME);
        expect(parsePassManifest(createSource([ `//! name: ${astralName}`, ...KERNEL_DIRECTIVES ])).name).toBe(astralName);
    });

    it('accepts 32 parameters and the deepest history', () => {
        const manifest = parsePassManifest(createSource([
            ...KERNEL_HEADER,
            '//! input: RGB[-1]',
            `//! input: RGB[-${MAXIMUM_HISTORY_DEPTH}]`,
            ...createParameterLines(MAXIMUM_PARAMETER_COUNT)
        ]));

        expect(manifest.parameters).toHaveLength(MAXIMUM_PARAMETER_COUNT);
        expect(manifest.inputs).toEqual([ { historyOffset: -1, name: 'RGB' }, { historyOffset: -MAXIMUM_HISTORY_DEPTH, name: 'RGB' } ]);
    });

    it('accepts the extremes of each parameter type', () => {
        const manifest = parsePassManifest(createSource([ ...KERNEL_HEADER, I32_EXTREMES_LINE, U32_EXTREMES_LINE, F32_EXTREMES_LINE ]));

        expect(manifest.parameters).toEqual([
            { defaultValue: 0, maximum: I32_MAXIMUM, minimum: I32_MINIMUM, name: 'offset', type: 'i32' },
            { defaultValue: 0, maximum: U32_MAXIMUM, minimum: 0, name: 'mask', type: 'u32' },
            { defaultValue: 0, maximum: F32_EXTREME, minimum: -F32_EXTREME, name: 'gain', type: 'f32' }
        ]);
    });
});

describe('pass manifest line accounting', () => {
    it('reads CRLF line endings as LF', () => {
        const manifest = parsePassManifest(createSource(FULL_KERNEL_HEADER, CRLF));

        expect(manifest).toEqual(FULL_KERNEL_MANIFEST);
        expect(manifest.body).not.toContain(CARRIAGE_RETURN);
    });

    it('reports errors on their line in a CRLF source', () => {
        const error = captureManifestError(createSource([ ...KERNEL_HEADER, '//! sampler: linear' ], CRLF));

        expect(error.message).toBe(UNKNOWN_DIRECTIVE_MESSAGE);
        expect(error.line).toBe(KERNEL_HEADER.length + 1);
    });

    it('counts blank lines before the header', () => {
        const manifest = parsePassManifest([ ...LEADING_BLANK_LINES, createSource(KERNEL_HEADER) ].join(LF));

        expect(manifest.bodyFirstLine).toBe(LEADING_BLANK_LINES.length + KERNEL_HEADER.length + 1);
        expect(manifest.body).toBe(EXPECTED_BODY);
    });

    it('reports errors on their line after blank lines', () => {
        const error = captureManifestError([ ...LEADING_BLANK_LINES, createSource([ ...KERNEL_HEADER, '//! sampler: linear' ]) ].join(LF));

        expect(error.message).toBe(UNKNOWN_DIRECTIVE_MESSAGE);
        expect(error.line).toBe(LEADING_BLANK_LINES.length + KERNEL_HEADER.length + 1);
    });

    it('starts the body on the line after the header, without a blank line between them', () => {
        const manifest = parsePassManifest([ ...KERNEL_HEADER, ...BODY_LINES ].join(LF));

        expect(manifest.bodyFirstLine).toBe(KERNEL_HEADER.length + 1);
        expect(manifest.body).toBe(BODY_LINES.join(LF));
    });

    it('reads a header without a body', () => {
        const manifest = parsePassManifest(KERNEL_HEADER.join(LF));

        expect(manifest.bodyFirstLine).toBe(KERNEL_HEADER.length + 1);
        expect(manifest.body).toBe('');
    });

    it('ends the header at the first line without the prefix', () => {
        // After the blank line, a //! line is a WGSL comment in the body, and its directive does not apply
        const bodyLines = [ '', '//! domain: linear', ...BODY_LINES ];
        const manifest = parsePassManifest([ ...KERNEL_HEADER, ...bodyLines ].join(LF));

        expect(manifest.domain).toBe(DEFAULT_KERNEL_MANIFEST.domain);
        expect(manifest.bodyFirstLine).toBe(KERNEL_HEADER.length + 1);
        expect(manifest.body).toBe(bodyLines.join(LF));
    });
});

describe('pass manifest errors', () => {
    it.each(HEADERLESS_CASES)('rejects $label on line 1', ({ source }) => {
        const error = captureManifestError(source);

        expect(error.message).toBe(MISSING_HEADER_MESSAGE);
        expect(error.line).toBe(MISSING_DIRECTIVE_LINE);
    });

    it('names its errors PassManifestError', () => {
        const error = captureManifestError(createSource([ ...KERNEL_HEADER, '//! sampler: linear' ]));

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('PassManifestError');
    });

    describe.each([
        { cases: HEADER_FORM_ERROR_CASES, group: 'header line' },
        { cases: REQUIRED_DIRECTIVE_ERROR_CASES, group: 'required directive' },
        { cases: SHAPE_ERROR_CASES, group: 'name and shape' },
        { cases: HOOK_AND_DOMAIN_ERROR_CASES, group: 'replaces, hook, and domain' },
        { cases: INPUT_AND_SAVE_ERROR_CASES, group: 'input and save' },
        { cases: OUTPUT_ERROR_CASES, group: 'output, components, and when' },
        { cases: PARAMETER_ERROR_CASES, group: 'parameter' },
        { cases: WORKGROUP_ERROR_CASES, group: 'workgroup and dispatch' }
    ])('$group errors', ({ cases }) => {
        it.each(cases)('rejects $label on line $line', ({ headerLines, line, message }) => {
            const error = captureManifestError(createSource(headerLines));

            expect(error.message).toBe(message);
            expect(error.line).toBe(line);
        });
    });
});

describe('the example passes', () => {
    it.each(EXAMPLE_CASES)('parse the $label', ({ expected, source }) => {
        expect(parsePassManifest(source)).toEqual(expected);
    });
});
