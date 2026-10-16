// The panel that shows the WGSL preset's pass files: the engine's built passes, dropped files, order, parameters, and the plan report.
import { PASS_FILE_EXTENSION } from 'webgpu-player/presentation/passes/PassLanguage';
import type { PlanReport } from 'webgpu-player/presentation/passes/PassTypes';

import type {
    BuiltShaderPass,
    SandboxSessionCommands,
    SandboxShaderFile,
    SandboxState
} from '../../contracts/SandboxContracts';
import { reportCommandRejection } from '../commands';
import {
    describeShaderFiles,
    type ShaderFileRow,
    type ShaderParameterField
} from '../diagnostics/ShaderFileRows';
import { createTupleSelector } from '../diagnostics/TupleSelector';
import { createElement, reconcileKeyedChildren, setTextContent } from '../dom';
import { listenForDroppedFiles } from '../FileDrop';
import type { Panel, PanelContext } from '../Panel';
import { subscribeSelection } from '../Store';
import { createChoiceSelect, type Choice } from './ChoiceSelect';
import { createDefaultButton } from './DefaultButton';

import './ShaderPanel.css';

const DRAG_ACTIVE_CLASS = 'shader-panel-drag-active';
// The built pass selector's placeholder choice
const NO_BUILT_PASS = null;
const ANY_STEP = 'any';
const MOVE_UP_OFFSET = -1;
const MOVE_DOWN_OFFSET = 1;
const TITLE_TEXT = 'WGSL passes';
const BUILT_PASS_PLACEHOLDER_TEXT = 'Add a bundled pass...';
const OPEN_FILES_TEXT = 'Open files...';
const MOVE_UP_TEXT = 'Up';
const MOVE_DOWN_TEXT = 'Down';
const REMOVE_TEXT = 'Remove';
const EMPTY_PRESET_TEXT = 'No passes: the route presents through its built-in chain';
const DROP_HINT_TEXT = 'Drop WGSL files here to add passes';

type ShaderInputs = readonly [files: readonly SandboxShaderFile[], planReport: PlanReport];

/** One file's row, kept across updates so a focused parameter input keeps its focus and its typing. */
type FileRowView = Readonly<{
    element: HTMLLIElement
    moveDown: HTMLButtonElement
    moveUp: HTMLButtonElement
    name: HTMLElement
    parameterInputs: ReadonlyMap<string, HTMLInputElement>
    /** One line per pass of the file, whose passes are fixed for the row's lifetime */
    states: readonly HTMLElement[]
}>;

export function createShaderPanel(context: PanelContext): Panel {
    const session = context.session;
    const fileList = createElement('ol', { className: 'shader-pass-list' });
    const emptyHint = createElement('p', { className: 'shader-panel-hint', text: EMPTY_PRESET_TEXT });
    const element = createElement('section', { className: 'shader-panel' }, [
        createHeader(session),
        fileList,
        emptyHint,
        createElement('p', { className: 'shader-panel-hint', text: DROP_HINT_TEXT })
    ]);
    // The session reports each dropped file that is not a WGSL pass file
    listenForDroppedFiles(element, DRAG_ACTIVE_CLASS, (files: File[]): void => {
        session.addShaderFiles(files).catch(reportCommandRejection);
    });
    let rowViews = new Map<string, FileRowView>();
    const destroy = subscribeSelection(
        context.store,
        createTupleSelector((state: SandboxState): ShaderInputs => [ state.presentation.files, state.presentation.report ]),
        ([ files, planReport ]: ShaderInputs): void => {
            const rows = describeShaderFiles(files, planReport);
            rowViews = reconcileKeyedChildren(fileList, rowViews, rows, {
                createView: (row: ShaderFileRow): FileRowView => createRowView(row, session),
                getElement: (view: FileRowView): Element => view.element,
                getKey: (row: ShaderFileRow): string => row.id,
                updateView: (view: FileRowView, row: ShaderFileRow, index: number): void => {
                    updateRowView(view, row, index, rows.length);
                }
            });
            emptyHint.hidden = rows.length > 0;
        }
    );
    return { destroy, element };
}

function createHeader(session: SandboxSessionCommands): HTMLElement {
    const fileInput = createElement('input', {
        attributes: { accept: PASS_FILE_EXTENSION, multiple: '', type: 'file' },
        className: 'shader-panel-file-input'
    });
    fileInput.hidden = true;
    fileInput.addEventListener('change', (): void => {
        const files = Array.from(fileInput.files ?? []);
        // Clearing the input lets the same files be chosen again
        fileInput.value = '';
        if (files.length > 0) {
            session.addShaderFiles(files).catch(reportCommandRejection);
        }
    });
    const openButton = createButton(OPEN_FILES_TEXT, (): void => {
        fileInput.click();
    });
    return createElement('div', { className: 'shader-panel-header' }, [
        createElement('h3', { className: 'shader-panel-title', text: TITLE_TEXT }),
        createBuiltPassSelect(session),
        openButton,
        fileInput
    ]);
}

/**
 * Lists the engine's built pass files under a placeholder, which comes back after each pick, so picking one again adds another copy.
 * The list loads from the dev server; until it has, and when it lists none, as a static build does, the selector stays disabled.
 */
function createBuiltPassSelect(session: SandboxSessionCommands): HTMLSelectElement {
    let builtPasses: readonly BuiltShaderPass[] = [];
    const passSelect = createChoiceSelect<string | null>((fileName: string | null): void => {
        passSelect.setValue(NO_BUILT_PASS);
        const builtPass = builtPasses.find((candidate: BuiltShaderPass): boolean => candidate.fileName === fileName);
        if (builtPass) {
            session.addBuiltShaderPass(builtPass).catch(reportCommandRejection);
        }
    });
    const placeholder: Choice<string | null> = { label: BUILT_PASS_PLACEHOLDER_TEXT, value: NO_BUILT_PASS };
    passSelect.setChoices([ placeholder ]);
    passSelect.setValue(NO_BUILT_PASS);
    passSelect.element.className = 'shader-panel-built-passes';
    passSelect.element.disabled = true;
    session.listBuiltShaderPasses().then((listedPasses: readonly BuiltShaderPass[]): void => {
        builtPasses = listedPasses;
        passSelect.setChoices([
            placeholder,
            ...listedPasses.map((builtPass: BuiltShaderPass): Choice<string | null> => ({ label: builtPass.fileName, value: builtPass.fileName }))
        ]);
        passSelect.setValue(NO_BUILT_PASS);
        passSelect.element.disabled = listedPasses.length === 0;
    }).catch(reportCommandRejection);
    return passSelect.element;
}

function createRowView(row: ShaderFileRow, session: SandboxSessionCommands): FileRowView {
    const name = createElement('span', { attributes: { title: row.origin }, className: 'shader-pass-name' });
    const states = row.states.map((): HTMLElement => createElement('div', { className: 'shader-pass-state' }));
    const moveUp = createButton(MOVE_UP_TEXT, (): void => {
        session.moveShaderFile(row.id, MOVE_UP_OFFSET).catch(reportCommandRejection);
    });
    const moveDown = createButton(MOVE_DOWN_TEXT, (): void => {
        session.moveShaderFile(row.id, MOVE_DOWN_OFFSET).catch(reportCommandRejection);
    });
    const remove = createButton(REMOVE_TEXT, (): void => {
        session.removeShaderFile(row.id).catch(reportCommandRejection);
    });
    const parameterInputs = new Map<string, HTMLInputElement>();
    const parameterFields: Node[] = [];
    for (const field of row.parameters) {
        const input = createParameterInput(row.id, field, session);
        parameterInputs.set(field.name, input);
        parameterFields.push(createElement('label', {
            attributes: { title: `${field.type}, default ${field.defaultValue}` },
            className: 'shader-pass-parameter'
        }, [
            createElement('span', { className: 'shader-pass-parameter-name', text: field.name }),
            input,
            createElement('span', { className: 'shader-pass-parameter-range', text: `[${field.minimum}, ${field.maximum}]` }),
            createDefaultButton(String(field.defaultValue), (): void => {
                session.setShaderParameter(row.id, field.name, field.defaultValue);
            })
        ]));
    }
    // Each state goes on its own line, since a report detail is too long to share one with the name in the narrow column
    const element = createElement('li', { className: 'shader-pass' }, [
        createElement('div', { className: 'shader-pass-header' }, [
            name,
            createElement('span', { className: 'shader-pass-actions' }, [ moveUp, moveDown, remove ])
        ]),
        ...states,
        createElement('div', { className: 'shader-pass-parameters' }, parameterFields)
    ]);
    return { element, moveDown, moveUp, name, parameterInputs, states };
}

function createParameterInput(fileId: string, field: ShaderParameterField, session: SandboxSessionCommands): HTMLInputElement {
    const input = createElement('input', {
        attributes: {
            max: String(field.maximum),
            min: String(field.minimum),
            step: field.step === null ? ANY_STEP : String(field.step),
            type: 'number'
        },
        className: 'shader-pass-parameter-input'
    });
    // A cleared input commits NaN, which the session reports as an invalid parameter
    input.addEventListener('change', (): void => {
        session.setShaderParameter(fileId, field.name, input.valueAsNumber);
    });
    return input;
}

function updateRowView(view: FileRowView, row: ShaderFileRow, index: number, rowCount: number): void {
    setTextContent(view.name, row.name);
    for (const [ stateIndex, stateLine ] of row.states.entries()) {
        const state = view.states[stateIndex];
        setTextContent(state, stateLine.text);
        state.dataset.tone = stateLine.tone;
    }
    view.moveUp.disabled = index === 0;
    view.moveDown.disabled = index === rowCount - 1;
    for (const field of row.parameters) {
        const input = view.parameterInputs.get(field.name);
        // The value being typed wins over the stored one until the input commits it
        if (input && input !== document.activeElement) {
            input.value = String(field.value);
        }
    }
}

function createButton(text: string, onClick: () => void): HTMLButtonElement {
    const button = createElement('button', { attributes: { type: 'button' }, text });
    button.addEventListener('click', onClick);
    return button;
}
