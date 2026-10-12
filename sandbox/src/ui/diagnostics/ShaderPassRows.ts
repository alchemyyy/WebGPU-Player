// The shader panel's rows: each preset pass's name, its state in the plan report, and its parameter fields.
import type {
    PassParameter,
    PassParameterType,
    PassRejection,
    PassRejectionReason,
    PlanReport
} from 'webgpu-player/presentation/passes/PassTypes';

import type { SandboxShaderPass } from '../../contracts/SandboxContracts';
import {
    formatPassRejection,
    getPassRejectionTone,
    MISSING_VALUE_TEXT,
    type DiagnosticTone
} from './DiagnosticsFormat';

/**
 * - 'active': the active plan runs it.
 * - 'left-out': the plan report names the check that kept it out.
 * - 'header-failure': its header did not parse, so it never reaches a plan.
 * - 'pending': no plan has covered it yet, such as before media opens.
 */
export type ShaderPassState =
    | Readonly<{ failure: string; kind: 'header-failure' }>
    | Readonly<{ kind: 'active' }>
    | Readonly<{ kind: 'left-out'; rejection: PassRejection }>
    | Readonly<{ kind: 'pending' }>;

export type ShaderParameterField = Readonly<{
    defaultValue: number
    maximum: number
    minimum: number
    name: string
    /** The input's step: 1 for integer types, a hundredth of the range for f32, or null for any value when the range is empty */
    step: number | null
    type: PassParameterType
    /** The stored value, or the default while none is stored */
    value: number
}>;

export type ShaderPassRow = Readonly<{
    id: string
    /** The manifest's name, or the pass's origin when its header failed */
    name: string
    origin: string
    parameters: readonly ShaderParameterField[]
    state: ShaderPassState
    stateText: string
    stateTone: DiagnosticTone
}>;

// The presenter names a header failure by preset position, so the rows show the header failure the pass itself carries
const HEADER_INVALID_REASON: PassRejectionReason = 'header-invalid';
const ACTIVE_STATE_TEXT = 'active';
const PENDING_STATE_TEXT = 'pending';
const INTEGER_PARAMETER_STEP = 1;
const FLOAT_PARAMETER_STEPS_PER_RANGE = 100;

/**
 * Describes the preset's passes in order, matching each to the plan report by name.
 * Among passes of one name, the first takes the name's active entry and the rest take its rejections in report order, as the presenter reports duplicates by preset position.
 */
export function describeShaderPasses(passes: readonly SandboxShaderPass[], planReport: PlanReport): ShaderPassRow[] {
    const activeNames = new Set<string>(planReport.activePasses);
    const rejectionsByName = groupRejectionsByName(planReport.inactivePasses);
    const claimedActiveNames = new Set<string>();
    const rows: ShaderPassRow[] = [];
    for (const pass of passes) {
        const state = getPassState(pass, activeNames, claimedActiveNames, rejectionsByName);
        rows.push({
            id: pass.id,
            name: pass.manifest?.name ?? pass.origin,
            origin: pass.origin,
            parameters: describeParameters(pass),
            state,
            stateText: formatShaderPassState(state),
            stateTone: getShaderPassStateTone(state)
        });
    }
    return rows;
}

function groupRejectionsByName(rejections: readonly PassRejection[]): Map<string, PassRejection[]> {
    const rejectionsByName = new Map<string, PassRejection[]>();
    for (const rejection of rejections) {
        if (rejection.reason === HEADER_INVALID_REASON) {
            continue;
        }
        const nameRejections = rejectionsByName.get(rejection.name) ?? [];
        nameRejections.push(rejection);
        rejectionsByName.set(rejection.name, nameRejections);
    }
    return rejectionsByName;
}

function getPassState(
    pass: SandboxShaderPass,
    activeNames: ReadonlySet<string>,
    claimedActiveNames: Set<string>,
    rejectionsByName: ReadonlyMap<string, PassRejection[]>
): ShaderPassState {
    if (pass.manifest === null) {
        return { failure: pass.headerFailure ?? MISSING_VALUE_TEXT, kind: 'header-failure' };
    }
    const name = pass.manifest.name;
    if (activeNames.has(name) && !claimedActiveNames.has(name)) {
        claimedActiveNames.add(name);
        return { kind: 'active' };
    }
    const rejection = rejectionsByName.get(name)?.shift();
    return rejection ? { kind: 'left-out', rejection } : { kind: 'pending' };
}

function formatShaderPassState(state: ShaderPassState): string {
    switch (state.kind) {
        case 'active':
            return ACTIVE_STATE_TEXT;
        case 'header-failure':
            return `${HEADER_INVALID_REASON}: ${state.failure}`;
        case 'left-out':
            return formatPassRejection(state.rejection);
        case 'pending':
            return PENDING_STATE_TEXT;
    }
}

function getShaderPassStateTone(state: ShaderPassState): DiagnosticTone {
    switch (state.kind) {
        case 'active':
            return 'success';
        case 'header-failure':
            return 'failure';
        case 'left-out':
            return getPassRejectionTone(state.rejection);
        case 'pending':
            return 'muted';
    }
}

function describeParameters(pass: SandboxShaderPass): ShaderParameterField[] {
    const fields: ShaderParameterField[] = [];
    for (const parameter of pass.manifest?.parameters ?? []) {
        fields.push({
            defaultValue: parameter.defaultValue,
            maximum: parameter.maximum,
            minimum: parameter.minimum,
            name: parameter.name,
            step: getParameterStep(parameter),
            type: parameter.type,
            value: Object.hasOwn(pass.parameters, parameter.name) ? pass.parameters[parameter.name] : parameter.defaultValue
        });
    }
    return fields;
}

function getParameterStep(parameter: PassParameter): number | null {
    switch (parameter.type) {
        case 'i32':
        case 'u32':
            return INTEGER_PARAMETER_STEP;
        case 'f32': {
            const range = parameter.maximum - parameter.minimum;
            return range > 0 ? range / FLOAT_PARAMETER_STEPS_PER_RANGE : null;
        }
    }
}
