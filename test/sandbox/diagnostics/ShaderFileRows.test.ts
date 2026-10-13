import { describe, expect, it } from 'vitest';

import type { PassRejection, PlanReport } from 'webgpu-player/presentation/passes/PassTypes';

import type { SandboxFilePass, SandboxShaderFile } from '../../../sandbox/src/contracts/SandboxContracts';
import {
    describeShaderFiles,
    type ShaderFileRow,
    type ShaderParameterField,
    type ShaderPassStateLine
} from '../../../sandbox/src/ui/diagnostics/ShaderFileRows';
import { createTestShaderFile } from './diagnosticsTestState';

const GAIN_PASS_NAME = 'Gain';
const TINT_PASS_NAME = 'Tint';
const GAIN_PARAMETER = 'gain';
const GAIN_DEFAULT = 1;
const GAIN_MINIMUM = 0;
const GAIN_MAXIMUM = 2;
// A hundredth of the gain's range
const GAIN_STEP = 0.02;
const STORED_GAIN = 1.5;
const STEPS_PARAMETER = 'steps';
const STEPS_DEFAULT = 4;
const STEPS_MINIMUM = 1;
const STEPS_MAXIMUM = 16;
const INTEGER_STEP = 1;
const FIXED_PARAMETER = 'fixed';
const FIXED_VALUE = 1;

const FIRST_FILE_ID = 'first';
const SECOND_FILE_ID = 'second';
const BROKEN_FILE_ID = 'broken';
const BROKEN_ORIGIN = 'broken.wgsl';
const HEADER_FAILURE = 'line 2: unknown directive \'shpae\'';
// The presenter names a pass whose header failed by its 1-based preset position
const POSITIONAL_PASS_NAME = 'pass 1';
const COMPILE_ERROR_REJECTION: PassRejection = { detail: 'line 9: unresolved value \'gian\'', name: GAIN_PASS_NAME, reason: 'compile-error' };
const CONDITION_FALSE_REJECTION: PassRejection = { detail: 'hdr.source', name: GAIN_PASS_NAME, reason: 'condition-false' };
const DUPLICATE_NAME_REJECTION: PassRejection = { detail: 'preset position 2', name: GAIN_PASS_NAME, reason: 'duplicate-name' };
const POSITIONAL_HEADER_REJECTION: PassRejection = { detail: HEADER_FAILURE, name: POSITIONAL_PASS_NAME, reason: 'header-invalid' };
const TINT_CONDITION_FALSE_REJECTION: PassRejection = { detail: 'hdr.source', name: TINT_PASS_NAME, reason: 'condition-false' };
const EMPTY_REPORT: PlanReport = { activePasses: [], inactivePasses: [] };
// The row labels the second pass of a file, whose header failed before it declared a name, by its place in the file
const SECOND_FILE_PASS_LABEL = 'pass 2';

function createColorPassSource(name: string): string {
    return [
        `//! name: ${name}`,
        '//! shape: color',
        '//! hook: OUTPUT',
        '//! domain: display',
        `//! param ${GAIN_PARAMETER}: f32 = ${GAIN_DEFAULT} in [${GAIN_MINIMUM}, ${GAIN_MAXIMUM}]`,
        `//! param ${STEPS_PARAMETER}: i32 = ${STEPS_DEFAULT} in [${STEPS_MINIMUM}, ${STEPS_MAXIMUM}]`,
        `//! param ${FIXED_PARAMETER}: f32 = ${FIXED_VALUE} in [${FIXED_VALUE}, ${FIXED_VALUE}]`,
        '',
        'fn apply(color: vec4f, position: vec2f) -> vec4f {',
        '    return color * parameters.gain;',
        '}',
        ''
    ].join('\n');
}

function createShaderFile(id: string, name: string, overrides: Partial<SandboxShaderFile> = {}): SandboxShaderFile {
    return createTestShaderFile(id, createColorPassSource(name), overrides);
}

function createBrokenFilePass(): SandboxFilePass {
    return { headerFailure: HEADER_FAILURE, manifest: null };
}

function createBrokenFile(): SandboxShaderFile {
    return { id: BROKEN_FILE_ID, origin: BROKEN_ORIGIN, parameters: {}, passes: [ createBrokenFilePass() ], source: '' };
}

/** A file of the gain pass, then the tint pass, which declare the same parameters. */
function createTwoPassFile(): SandboxShaderFile {
    return createTestShaderFile(FIRST_FILE_ID, `${createColorPassSource(GAIN_PASS_NAME)}${createColorPassSource(TINT_PASS_NAME)}`);
}

function describeOne(file: SandboxShaderFile, planReport: PlanReport): ShaderFileRow {
    return describeShaderFiles([ file ], planReport)[0];
}

/** Returns the only state line of a single-pass file's row. */
function getOnlyState(row: ShaderFileRow): ShaderPassStateLine {
    expect(row.states).toHaveLength(1);
    return row.states[0];
}

function getStateTexts(row: ShaderFileRow): string[] {
    return row.states.map((state: ShaderPassStateLine): string => state.text);
}

describe('describeShaderFiles', () => {
    it('names a pass by its manifest, or by its origin when its header failed', () => {
        const rows = describeShaderFiles([ createShaderFile(FIRST_FILE_ID, GAIN_PASS_NAME), createBrokenFile() ], EMPTY_REPORT);

        expect(rows.map((row: ShaderFileRow): string => row.name)).toEqual([ GAIN_PASS_NAME, BROKEN_ORIGIN ]);
        expect(rows.map((row: ShaderFileRow): string => row.id)).toEqual([ FIRST_FILE_ID, BROKEN_FILE_ID ]);
    });

    it('shows a pass the active plan runs as active', () => {
        const row = describeOne(createShaderFile(FIRST_FILE_ID, GAIN_PASS_NAME), { activePasses: [ GAIN_PASS_NAME ], inactivePasses: [] });

        expect(getOnlyState(row)).toEqual({ state: { kind: 'active' }, text: 'active', tone: 'success' });
    });

    it('shows a left-out pass with its reason and detail, as a failure unless its condition was false', () => {
        const file = createShaderFile(FIRST_FILE_ID, GAIN_PASS_NAME);
        const failedState = getOnlyState(describeOne(file, { activePasses: [], inactivePasses: [ COMPILE_ERROR_REJECTION ] }));
        const switchedOffState = getOnlyState(describeOne(file, { activePasses: [], inactivePasses: [ CONDITION_FALSE_REJECTION ] }));

        expect(failedState.text).toBe(`${COMPILE_ERROR_REJECTION.reason}: ${COMPILE_ERROR_REJECTION.detail}`);
        expect(failedState.tone).toBe('failure');
        expect(switchedOffState.text).toBe(`${CONDITION_FALSE_REJECTION.reason}: ${CONDITION_FALSE_REJECTION.detail}`);
        expect(switchedOffState.tone).toBe('muted');
    });

    it('shows a header failure under the presenter\'s reason code', () => {
        const row = describeOne(createBrokenFile(), { activePasses: [], inactivePasses: [ POSITIONAL_HEADER_REJECTION ] });

        expect(getOnlyState(row)).toEqual({
            state: { failure: HEADER_FAILURE, kind: 'header-failure' },
            text: `header-invalid: ${HEADER_FAILURE}`,
            tone: 'failure'
        });
        expect(row.parameters).toEqual([]);
    });

    it('never gives a named pass the presenter\'s positional header failure', () => {
        const rows = describeShaderFiles(
            [ createBrokenFile(), createShaderFile(SECOND_FILE_ID, POSITIONAL_PASS_NAME) ],
            { activePasses: [], inactivePasses: [ POSITIONAL_HEADER_REJECTION ] }
        );

        expect(getOnlyState(rows[1]).state).toEqual({ kind: 'pending' });
    });

    it('shows a pass no plan has covered yet as pending', () => {
        const state = getOnlyState(describeOne(createShaderFile(FIRST_FILE_ID, GAIN_PASS_NAME), { activePasses: [ TINT_PASS_NAME ], inactivePasses: [] }));

        expect(state.text).toBe('pending');
        expect(state.tone).toBe('muted');
    });

    it('gives the first of two passes of one name its active entry and the second its duplicate-name rejection', () => {
        const rows = describeShaderFiles(
            [ createShaderFile(FIRST_FILE_ID, GAIN_PASS_NAME), createShaderFile(SECOND_FILE_ID, GAIN_PASS_NAME) ],
            { activePasses: [ GAIN_PASS_NAME ], inactivePasses: [ DUPLICATE_NAME_REJECTION ] }
        );

        expect(getOnlyState(rows[0]).state).toEqual({ kind: 'active' });
        expect(getOnlyState(rows[1]).state).toEqual({ kind: 'left-out', rejection: DUPLICATE_NAME_REJECTION });
    });

    it('gives passes of one name its rejections in report order when none runs', () => {
        const rows = describeShaderFiles(
            [ createShaderFile(FIRST_FILE_ID, GAIN_PASS_NAME), createShaderFile(SECOND_FILE_ID, GAIN_PASS_NAME) ],
            { activePasses: [], inactivePasses: [ COMPILE_ERROR_REJECTION, DUPLICATE_NAME_REJECTION ] }
        );

        expect(rows.map((row: ShaderFileRow): string => getOnlyState(row).text)).toEqual([
            `${COMPILE_ERROR_REJECTION.reason}: ${COMPILE_ERROR_REJECTION.detail}`,
            `${DUPLICATE_NAME_REJECTION.reason}: ${DUPLICATE_NAME_REJECTION.detail}`
        ]);
    });

    it('shows a file of several passes as one row under its origin, with a state line per pass that names it', () => {
        const file = createTwoPassFile();
        const row = describeOne(file, { activePasses: [ GAIN_PASS_NAME ], inactivePasses: [ TINT_CONDITION_FALSE_REJECTION ] });

        expect(row.name).toBe(file.origin);
        expect(getStateTexts(row)).toEqual([
            `${GAIN_PASS_NAME}: active`,
            `${TINT_PASS_NAME}: ${TINT_CONDITION_FALSE_REJECTION.reason}: ${TINT_CONDITION_FALSE_REJECTION.detail}`
        ]);
        expect(row.states.map((state: ShaderPassStateLine): string => state.tone)).toEqual([ 'success', 'muted' ]);
    });

    it('labels a pass of a several-pass file whose header failed by its place in the file', () => {
        const file = createTwoPassFile();
        const brokenFile: SandboxShaderFile = { ...file, passes: [ file.passes[0], createBrokenFilePass() ] };

        expect(getStateTexts(describeOne(brokenFile, EMPTY_REPORT))).toEqual([
            `${GAIN_PASS_NAME}: pending`,
            `${SECOND_FILE_PASS_LABEL}: header-invalid: ${HEADER_FAILURE}`
        ]);
    });

    it('offers each parameter of a file\'s passes once, since the passes share its value', () => {
        const row = describeOne(createTwoPassFile(), EMPTY_REPORT);

        expect(row.parameters.map((field: ShaderParameterField): string => field.name)).toEqual([ GAIN_PARAMETER, STEPS_PARAMETER, FIXED_PARAMETER ]);
    });

    it('offers a field per declared parameter with its range, default, stored value, and step', () => {
        const row = describeOne(createShaderFile(FIRST_FILE_ID, GAIN_PASS_NAME, { parameters: { [GAIN_PARAMETER]: STORED_GAIN } }), EMPTY_REPORT);

        expect(row.parameters).toEqual([
            { defaultValue: GAIN_DEFAULT, maximum: GAIN_MAXIMUM, minimum: GAIN_MINIMUM, name: GAIN_PARAMETER, step: GAIN_STEP, type: 'f32', value: STORED_GAIN },
            { defaultValue: STEPS_DEFAULT, maximum: STEPS_MAXIMUM, minimum: STEPS_MINIMUM, name: STEPS_PARAMETER, step: INTEGER_STEP, type: 'i32', value: STEPS_DEFAULT },
            { defaultValue: FIXED_VALUE, maximum: FIXED_VALUE, minimum: FIXED_VALUE, name: FIXED_PARAMETER, step: null, type: 'f32', value: FIXED_VALUE }
        ]);
    });
});
