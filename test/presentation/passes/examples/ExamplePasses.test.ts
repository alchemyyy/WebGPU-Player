import { describe, expect, it } from 'vitest';

import { EXAMPLE_PASSES } from 'webgpu-player/presentation/passes/examples/ExamplePasses';
import { TEMPORAL_BLEND_KERNEL_PASS } from 'webgpu-player/presentation/passes/examples/TemporalBlendKernelPass';
import { parsePassManifest } from 'webgpu-player/presentation/passes/PassManifest';
import type { PassInput, PassShape } from 'webgpu-player/presentation/passes/PassTypes';

const ENTRY_POINTS: Readonly<Record<PassShape, string>> = {
    color: 'fn apply(color: vec4f, position: vec2f) -> vec4f {',
    compute: 'fn compute(id: vec3u) {',
    kernel: 'fn kernel(coordinate: vec2f) -> vec4f {',
    scaler: 'fn scale(coordinate: vec2f) -> vec4f {'
};
const PARAMETER_REFERENCE_PATTERN = /\bparameters\.(\w+)/g;
const PRESENTATION_REFERENCE_PATTERN = /\bpresentation\.(\w+)/g;
const ENGINE_ACCESS_PATTERN = /@group|@binding|renderSettings|textureSample|textureLoad/;
// History N of an input has the accessors of <NAME>_history<N>, such as RGB_history1_tex for RGB[-1]
const HISTORY_ACCESSOR_INFIX = '_history';
// The fields of PassResources' presentation uniform that examples read
const PRESENTATION_FIELDS: readonly string[] = [ 'historyValid' ];
// The header ends with a blank line, so the body starts with a line break
const BODY_START = '\n';

const TEMPORAL_HOOK = 'RGB';
const TEMPORAL_INPUTS: readonly PassInput[] = [
    { historyOffset: 0, name: 'HOOKED' },
    { historyOffset: -1, name: 'RGB' }
];
const HISTORY_VALID_READ = 'presentation.historyValid';
// The examples a host lists, in order
const EXAMPLE_IDS: readonly string[] = [ 'saturation', 'sharpen', 'temporal-blend', 'catmull-rom' ];

function sortNames(names: Iterable<string>): string[] {
    return [ ...names ].sort((first: string, second: string): number => first.localeCompare(second));
}

/** Returns the prefix of an input's accessors: its name, or <NAME>_history<N> for history N. */
function getAccessorPrefix(input: PassInput): string {
    return input.historyOffset === 0 ? input.name : `${input.name}${HISTORY_ACCESSOR_INFIX}${-input.historyOffset}`;
}

describe('the example catalog', () => {
    it('lists each example once, by a stable id', () => {
        expect(EXAMPLE_PASSES.map(example => example.id)).toEqual(EXAMPLE_IDS);
    });
});

describe.each(EXAMPLE_PASSES)('the $id example', ({ name, source }) => {
    const manifest = parsePassManifest(source);

    it('takes its name from its header', () => {
        expect(name).toBe(manifest.name);
    });

    it('separates its header from its body with a blank line', () => {
        expect(manifest.body.startsWith(BODY_START)).toBe(true);
    });

    it('defines the entry point of its shape', () => {
        expect(manifest.body).toContain(ENTRY_POINTS[manifest.shape]);
    });

    it('reads exactly the parameters it declares', () => {
        const readNames = new Set([ ...manifest.body.matchAll(PARAMETER_REFERENCE_PATTERN) ].map(match => match[1]));
        const declaredNames = manifest.parameters.map(parameter => parameter.name);

        expect(sortNames(readNames)).toEqual(sortNames(declaredNames));
    });

    it('reads each input through its accessors, and engine data only through the presentation globals', () => {
        for (const input of manifest.inputs) {
            expect(manifest.body).toMatch(new RegExp(String.raw`\b${getAccessorPrefix(input)}_tex(Off)?\(`));
        }
        for (const match of manifest.body.matchAll(PRESENTATION_REFERENCE_PATTERN)) {
            expect(PRESENTATION_FIELDS).toContain(match[1]);
        }
        expect(manifest.body).not.toMatch(ENGINE_ACCESS_PATTERN);
    });
});

describe('the temporal blend kernel', () => {
    it('reads the previous frame of the RGB stage it hooks', () => {
        const manifest = parsePassManifest(TEMPORAL_BLEND_KERNEL_PASS);

        expect(manifest.hook).toBe(TEMPORAL_HOOK);
        expect(manifest.inputs).toEqual(TEMPORAL_INPUTS);
        expect(manifest.body).toContain(HISTORY_VALID_READ);
    });
});
