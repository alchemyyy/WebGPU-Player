// The shader panel's rows: each preset file's name, the state of each of its passes in the plan report, and its parameter fields.
import type {
    PassParameter,
    PassParameterType,
    PassRejection,
    PassRejectionReason,
    PlanReport
} from 'webgpu-player/presentation/passes/PassTypes';

import type { SandboxFilePass, SandboxShaderFile } from '../../contracts/SandboxContracts';
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

/** One pass of a row's file: its state, as text that names the pass when the file holds several. */
export type ShaderPassStateLine = Readonly<{
    state: ShaderPassState
    text: string
    tone: DiagnosticTone
}>;

export type ShaderFileRow = Readonly<{
    id: string
    /** The name of the file's only pass, or the file's origin for a file of several passes or a header failure */
    name: string
    origin: string
    /** The parameters of the file's passes, each name once, since the passes share its value */
    parameters: readonly ShaderParameterField[]
    /** One line per pass of the file, in file order */
    states: readonly ShaderPassStateLine[]
}>;

// The presenter names a header failure by preset position, so the rows show the header failure the pass itself carries
const HEADER_INVALID_REASON: PassRejectionReason = 'header-invalid';
const ACTIVE_STATE_TEXT = 'active';
const PENDING_STATE_TEXT = 'pending';
// Labels a pass of a several-pass file whose header failed before it declared a name, followed by its place in the file
const UNNAMED_FILE_PASS_PREFIX = 'pass ';
const INTEGER_PARAMETER_STEP = 1;
const FLOAT_PARAMETER_STEPS_PER_RANGE = 100;

/**
 * Describes the preset's files in order, matching each of their passes to the plan report by name.
 * Among passes of one name, the first takes the name's active entry and the rest take its rejections in report order, as the presenter reports duplicates by preset position.
 */
export function describeShaderFiles(files: readonly SandboxShaderFile[], planReport: PlanReport): ShaderFileRow[] {
    const activeNames = new Set<string>(planReport.activePasses);
    const rejectionsByName = groupRejectionsByName(planReport.inactivePasses);
    const claimedActiveNames = new Set<string>();
    const rows: ShaderFileRow[] = [];
    for (const file of files) {
        const severalPasses = file.passes.length > 1;
        const states: ShaderPassStateLine[] = [];
        for (const [ passIndex, filePass ] of file.passes.entries()) {
            const state = getPassState(filePass, activeNames, claimedActiveNames, rejectionsByName);
            const stateText = formatShaderPassState(state);
            const label = filePass.manifest?.name ?? `${UNNAMED_FILE_PASS_PREFIX}${passIndex + 1}`;
            states.push({ state, text: severalPasses ? `${label}: ${stateText}` : stateText, tone: getShaderPassStateTone(state) });
        }
        const onlyManifest = severalPasses ? null : file.passes.at(0)?.manifest ?? null;
        rows.push({
            id: file.id,
            name: onlyManifest?.name ?? file.origin,
            origin: file.origin,
            parameters: describeParameters(file),
            states
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
    filePass: SandboxFilePass,
    activeNames: ReadonlySet<string>,
    claimedActiveNames: Set<string>,
    rejectionsByName: ReadonlyMap<string, PassRejection[]>
): ShaderPassState {
    if (filePass.manifest === null) {
        return { failure: filePass.headerFailure ?? MISSING_VALUE_TEXT, kind: 'header-failure' };
    }
    const name = filePass.manifest.name;
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

function describeParameters(file: SandboxShaderFile): ShaderParameterField[] {
    const fields: ShaderParameterField[] = [];
    // The parser rejects a parameter that a file's passes declare differently, so each name's first declaration stands for all of them
    const parameters = file.passes.flatMap((filePass: SandboxFilePass): readonly PassParameter[] => filePass.manifest?.parameters ?? []);
    for (const parameter of parameters) {
        if (fields.some((field: ShaderParameterField): boolean => field.name === parameter.name)) {
            continue;
        }
        fields.push({
            defaultValue: parameter.defaultValue,
            maximum: parameter.maximum,
            minimum: parameter.minimum,
            name: parameter.name,
            step: getParameterStep(parameter),
            type: parameter.type,
            value: Object.hasOwn(file.parameters, parameter.name) ? file.parameters[parameter.name] : parameter.defaultValue
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
