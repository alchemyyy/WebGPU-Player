import { describe, expect, it } from 'vitest';

import type { PassRejection, PlanReport } from 'webgpu-player/presentation/passes/PassTypes';

import type { SandboxShaderPass } from '../../../sandbox/src/contracts/SandboxContracts';
import { describeShaderPasses, type ShaderPassRow } from '../../../sandbox/src/ui/diagnostics/ShaderPassRows';
import { createTestShaderPass } from './diagnosticsTestState';

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

const FIRST_PASS_ID = 'first';
const SECOND_PASS_ID = 'second';
const BROKEN_PASS_ID = 'broken';
const BROKEN_ORIGIN = 'broken.wgsl';
const HEADER_FAILURE = 'line 2: unknown directive \'shpae\'';
// The presenter names a pass whose header failed by its 1-based preset position
const POSITIONAL_PASS_NAME = 'pass 1';
const COMPILE_ERROR_REJECTION: PassRejection = { detail: 'line 9: unresolved value \'gian\'', name: GAIN_PASS_NAME, reason: 'compile-error' };
const CONDITION_FALSE_REJECTION: PassRejection = { detail: 'hdr.source', name: GAIN_PASS_NAME, reason: 'condition-false' };
const DUPLICATE_NAME_REJECTION: PassRejection = { detail: 'preset position 2', name: GAIN_PASS_NAME, reason: 'duplicate-name' };
const POSITIONAL_HEADER_REJECTION: PassRejection = { detail: HEADER_FAILURE, name: POSITIONAL_PASS_NAME, reason: 'header-invalid' };
const EMPTY_REPORT: PlanReport = { activePasses: [], inactivePasses: [] };

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

function createShaderPass(id: string, name: string, overrides: Partial<SandboxShaderPass> = {}): SandboxShaderPass {
    return createTestShaderPass(id, createColorPassSource(name), overrides);
}

function createBrokenPass(): SandboxShaderPass {
    return { headerFailure: HEADER_FAILURE, id: BROKEN_PASS_ID, manifest: null, origin: BROKEN_ORIGIN, parameters: {}, source: '' };
}

function describeOne(pass: SandboxShaderPass, planReport: PlanReport): ShaderPassRow {
    return describeShaderPasses([ pass ], planReport)[0];
}

describe('describeShaderPasses', () => {
    it('names a pass by its manifest, or by its origin when its header failed', () => {
        const rows = describeShaderPasses([ createShaderPass(FIRST_PASS_ID, GAIN_PASS_NAME), createBrokenPass() ], EMPTY_REPORT);

        expect(rows.map((row: ShaderPassRow): string => row.name)).toEqual([ GAIN_PASS_NAME, BROKEN_ORIGIN ]);
        expect(rows.map((row: ShaderPassRow): string => row.id)).toEqual([ FIRST_PASS_ID, BROKEN_PASS_ID ]);
    });

    it('shows a pass the active plan runs as active', () => {
        const row = describeOne(createShaderPass(FIRST_PASS_ID, GAIN_PASS_NAME), { activePasses: [ GAIN_PASS_NAME ], inactivePasses: [] });

        expect(row.state).toEqual({ kind: 'active' });
        expect(row.stateText).toBe('active');
        expect(row.stateTone).toBe('success');
    });

    it('shows a left-out pass with its reason and detail, as a failure unless its condition was false', () => {
        const pass = createShaderPass(FIRST_PASS_ID, GAIN_PASS_NAME);
        const failedRow = describeOne(pass, { activePasses: [], inactivePasses: [ COMPILE_ERROR_REJECTION ] });
        const switchedOffRow = describeOne(pass, { activePasses: [], inactivePasses: [ CONDITION_FALSE_REJECTION ] });

        expect(failedRow.stateText).toBe(`${COMPILE_ERROR_REJECTION.reason}: ${COMPILE_ERROR_REJECTION.detail}`);
        expect(failedRow.stateTone).toBe('failure');
        expect(switchedOffRow.stateText).toBe(`${CONDITION_FALSE_REJECTION.reason}: ${CONDITION_FALSE_REJECTION.detail}`);
        expect(switchedOffRow.stateTone).toBe('muted');
    });

    it('shows a header failure under the presenter\'s reason code', () => {
        const row = describeOne(createBrokenPass(), { activePasses: [], inactivePasses: [ POSITIONAL_HEADER_REJECTION ] });

        expect(row.state).toEqual({ failure: HEADER_FAILURE, kind: 'header-failure' });
        expect(row.stateText).toBe(`header-invalid: ${HEADER_FAILURE}`);
        expect(row.stateTone).toBe('failure');
        expect(row.parameters).toEqual([]);
    });

    it('never gives a named pass the presenter\'s positional header failure', () => {
        const rows = describeShaderPasses(
            [ createBrokenPass(), createShaderPass(SECOND_PASS_ID, POSITIONAL_PASS_NAME) ],
            { activePasses: [], inactivePasses: [ POSITIONAL_HEADER_REJECTION ] }
        );

        expect(rows[1].state).toEqual({ kind: 'pending' });
    });

    it('shows a pass no plan has covered yet as pending', () => {
        const row = describeOne(createShaderPass(FIRST_PASS_ID, GAIN_PASS_NAME), { activePasses: [ TINT_PASS_NAME ], inactivePasses: [] });

        expect(row.stateText).toBe('pending');
        expect(row.stateTone).toBe('muted');
    });

    it('gives the first of two passes of one name its active entry and the second its duplicate-name rejection', () => {
        const rows = describeShaderPasses(
            [ createShaderPass(FIRST_PASS_ID, GAIN_PASS_NAME), createShaderPass(SECOND_PASS_ID, GAIN_PASS_NAME) ],
            { activePasses: [ GAIN_PASS_NAME ], inactivePasses: [ DUPLICATE_NAME_REJECTION ] }
        );

        expect(rows[0].state).toEqual({ kind: 'active' });
        expect(rows[1].state).toEqual({ kind: 'left-out', rejection: DUPLICATE_NAME_REJECTION });
    });

    it('gives passes of one name its rejections in report order when none runs', () => {
        const rows = describeShaderPasses(
            [ createShaderPass(FIRST_PASS_ID, GAIN_PASS_NAME), createShaderPass(SECOND_PASS_ID, GAIN_PASS_NAME) ],
            { activePasses: [], inactivePasses: [ COMPILE_ERROR_REJECTION, DUPLICATE_NAME_REJECTION ] }
        );

        expect(rows.map((row: ShaderPassRow): string => row.stateText)).toEqual([
            `${COMPILE_ERROR_REJECTION.reason}: ${COMPILE_ERROR_REJECTION.detail}`,
            `${DUPLICATE_NAME_REJECTION.reason}: ${DUPLICATE_NAME_REJECTION.detail}`
        ]);
    });

    it('offers a field per declared parameter with its range, default, stored value, and step', () => {
        const row = describeOne(createShaderPass(FIRST_PASS_ID, GAIN_PASS_NAME, { parameters: { [GAIN_PARAMETER]: STORED_GAIN } }), EMPTY_REPORT);

        expect(row.parameters).toEqual([
            { defaultValue: GAIN_DEFAULT, maximum: GAIN_MAXIMUM, minimum: GAIN_MINIMUM, name: GAIN_PARAMETER, step: GAIN_STEP, type: 'f32', value: STORED_GAIN },
            { defaultValue: STEPS_DEFAULT, maximum: STEPS_MAXIMUM, minimum: STEPS_MINIMUM, name: STEPS_PARAMETER, step: INTEGER_STEP, type: 'i32', value: STEPS_DEFAULT },
            { defaultValue: FIXED_VALUE, maximum: FIXED_VALUE, minimum: FIXED_VALUE, name: FIXED_PARAMETER, step: null, type: 'f32', value: FIXED_VALUE }
        ]);
    });
});
