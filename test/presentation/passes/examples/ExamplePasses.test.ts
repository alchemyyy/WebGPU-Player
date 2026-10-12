import { describe, expect, it } from 'vitest';

import { SATURATION_COLOR_PASS } from './SaturationColorPass';
import { SHARPEN_KERNEL_PASS } from './SharpenKernelPass';
import { TEMPORAL_BLEND_KERNEL_PASS } from './TemporalBlendKernelPass';

const HEADER_PREFIX = '//! ';
const PARAMETER_PREFIX = 'param ';
const SHAPES: readonly string[] = [ 'color', 'compute', 'kernel', 'scaler' ];
const HOOKS: readonly string[] = [ 'OUTPUT', 'PRESCALE', 'RGB', 'SCALE' ];
const DOMAINS: readonly string[] = [ 'any', 'display', 'linear', 'sdr', 'source' ];
const DIRECTIVES: readonly string[] = [ 'components', 'domain', 'hook', 'input', 'name', 'output', 'replaces', 'save', 'shape', 'when', 'workgroup' ];
const ENTRY_POINTS: Readonly<Record<string, string>> = {
    color: 'fn apply(color: vec4f, position: vec2f) -> vec4f {',
    kernel: 'fn kernel(coordinate: vec2f) -> vec4f {',
    scaler: 'fn scale(coordinate: vec2f) -> vec4f {'
};
const PARAMETER_PATTERN = /^param (\w+): (f32|i32|u32) = (-?\d+(?:\.\d+)?) in \[(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\]$/;
const INPUT_PATTERN = /^([A-Z]+)(?:\[-(\d+)\])?$/;
const PARAMETER_REFERENCE_PATTERN = /\bparameters\.(\w+)/g;
const KERNEL_OUTPUT = 'HOOKED.size, rgba16float';
// The fields of PassResources' presentation uniform that examples read
const PRESENTATION_FIELDS: readonly string[] = [ 'historyValid' ];

type ExamplePass = {
    label: string
    source: string
};

const EXAMPLE_PASSES: readonly ExamplePass[] = [
    { label: 'saturation color pass', source: SATURATION_COLOR_PASS },
    { label: 'sharpen kernel', source: SHARPEN_KERNEL_PASS },
    { label: 'temporal blend kernel', source: TEMPORAL_BLEND_KERNEL_PASS }
];

type PassHeader = {
    body: string
    directives: Map<string, string[]>
    parameters: string[]
};

/** Reads the leading `//! key: value` block of a pass, with parameters kept whole. */
function readHeader(source: string): PassHeader {
    const lines = source.split('\n');
    const directives = new Map<string, string[]>();
    const parameters: string[] = [];
    let lineIndex = 0;
    for (; lineIndex < lines.length && lines[lineIndex].startsWith(HEADER_PREFIX); lineIndex += 1) {
        const directive = lines[lineIndex].slice(HEADER_PREFIX.length);
        if (directive.startsWith(PARAMETER_PREFIX)) {
            parameters.push(directive);
            continue;
        }
        const separatorIndex = directive.indexOf(': ');
        const key = directive.slice(0, separatorIndex);
        directives.set(key, [ ...directives.get(key) ?? [], directive.slice(separatorIndex + 2) ]);
    }
    return { body: lines.slice(lineIndex).join('\n'), directives, parameters };
}

function getSingleDirective(header: PassHeader, key: string): string {
    const values = header.directives.get(key) ?? [];
    expect(values, key).toHaveLength(1);
    return values[0];
}

describe.each(EXAMPLE_PASSES)('the $label', ({ source }) => {
    const header = readHeader(source);

    it('starts with a header of documented directives, then a blank line', () => {
        expect(header.directives.size).toBeGreaterThan(0);
        expect(header.body.startsWith('\n')).toBe(true);
        for (const key of header.directives.keys()) {
            expect(DIRECTIVES).toContain(key);
        }
        expect(getSingleDirective(header, 'name')).not.toBe('');
        expect(SHAPES).toContain(getSingleDirective(header, 'shape'));
        expect(HOOKS).toContain(getSingleDirective(header, 'hook'));
        expect(DOMAINS).toContain(getSingleDirective(header, 'domain'));
    });

    it('defines the entry point of its shape', () => {
        expect(header.body).toContain(ENTRY_POINTS[getSingleDirective(header, 'shape')]);
    });

    it('declares parameters with a default inside their range, and reads exactly those', () => {
        const declaredNames: string[] = [];
        for (const parameter of header.parameters) {
            const match = PARAMETER_PATTERN.exec(parameter);
            if (!match) {
                throw new Error(`Malformed parameter '${parameter}'`);
            }
            const [ , name, , defaultValue, minimum, maximum ] = match;
            expect(Number(defaultValue)).toBeGreaterThanOrEqual(Number(minimum));
            expect(Number(defaultValue)).toBeLessThanOrEqual(Number(maximum));
            declaredNames.push(name);
        }
        const readNames = new Set([ ...header.body.matchAll(PARAMETER_REFERENCE_PATTERN) ].map(match => match[1]));
        expect([ ...readNames ].sort((first: string, second: string): number => first.localeCompare(second)))
            .toEqual([ ...declaredNames ].sort((first: string, second: string): number => first.localeCompare(second)));
    });

    it('reads each input through its accessors, and engine data only through the presentation globals', () => {
        for (const input of header.directives.get('input') ?? []) {
            const match = INPUT_PATTERN.exec(input);
            if (!match) {
                throw new Error(`Malformed input '${input}'`);
            }
            const [ , stage, historyDistance ] = match;
            // History N of a stage has the accessors of an input named <stage>_<N>, such as RGB_1_tex for RGB[-1]
            const accessorPrefix = historyDistance ? `${stage}_${historyDistance}` : stage;
            expect(header.body).toMatch(new RegExp(String.raw`\b${accessorPrefix}_tex(Off)?\(`));
        }
        for (const match of header.body.matchAll(/\bpresentation\.(\w+)/g)) {
            expect(PRESENTATION_FIELDS).toContain(match[1]);
        }
        expect(header.body).not.toMatch(/@group|@binding|renderSettings|textureSample|textureLoad/);
    });

    it('sizes a kernel output by an expression of its input and a texture format', () => {
        if (getSingleDirective(header, 'shape') !== 'kernel') {
            expect(header.directives.has('output')).toBe(false);
            return;
        }
        expect(getSingleDirective(header, 'output')).toBe(KERNEL_OUTPUT);
    });
});

describe('the temporal blend kernel', () => {
    it('reads the previous frame of the RGB stage it hooks', () => {
        const header = readHeader(TEMPORAL_BLEND_KERNEL_PASS);

        expect(header.directives.get('hook')).toEqual([ 'RGB' ]);
        expect(header.directives.get('input')).toEqual([ 'HOOKED', 'RGB[-1]' ]);
        expect(header.body).toContain('presentation.historyValid');
    });
});
