// The panel that shows the WGSL preset's pass files: examples, dropped files, order, parameters, and the plan report.
import { PASS_FILE_EXTENSION } from 'webgpu-player/presentation/passes/PassLanguage';
import type { PlanReport } from 'webgpu-player/presentation/passes/PassTypes';

import type {
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
import { carriesFiles, createElement, reconcileKeyedChildren, setTextContent } from '../dom';
import type { Panel, PanelContext } from '../Panel';
import { subscribeSelection } from '../Store';
import { createChoiceSelect, type Choice } from './ChoiceSelect';
import { createDefaultButton } from './DefaultButton';

import './ShaderPanel.css';

const DRAG_ACTIVE_CLASS = 'shader-panel-drag-active';
// The example selector's placeholder choice
const NO_EXAMPLE = null;
const ANY_STEP = 'any';
const MOVE_UP_OFFSET = -1;
const MOVE_DOWN_OFFSET = 1;
const TITLE_TEXT = 'WGSL passes';
const EXAMPLE_PLACEHOLDER_TEXT = 'Add an example...';
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
    listenForDroppedFiles(element, session);
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
        createExampleSelect(session),
        openButton,
        fileInput
    ]);
}

/** Lists the session's examples under a placeholder, which comes back after each pick, so picking one example again adds another copy. */
function createExampleSelect(session: SandboxSessionCommands): HTMLSelectElement {
    const examples = session.getExampleShaderPasses();
    const exampleSelect = createChoiceSelect<string | null>((exampleId: string | null): void => {
        exampleSelect.setValue(NO_EXAMPLE);
        if (exampleId !== NO_EXAMPLE) {
            session.addExampleShaderPass(exampleId).catch(reportCommandRejection);
        }
    });
    const choices: Choice<string | null>[] = [];
    choices.push({ label: EXAMPLE_PLACEHOLDER_TEXT, value: NO_EXAMPLE });
    for (const example of examples) {
        choices.push({ label: example.name, value: example.id });
    }
    exampleSelect.setChoices(choices);
    exampleSelect.setValue(NO_EXAMPLE);
    exampleSelect.element.className = 'shader-panel-examples';
    exampleSelect.element.disabled = examples.length === 0;
    return exampleSelect.element;
}

/** Hands every file dropped on the panel to the session, which reports the ones that are not WGSL pass files. */
function listenForDroppedFiles(element: HTMLElement, session: SandboxSessionCommands): void {
    // Entering and leaving child elements fires in pairs, so the panel is left once the count returns to zero
    let dragDepth = 0;
    element.addEventListener('dragenter', (event: DragEvent): void => {
        if (!carriesFiles(event)) {
            return;
        }
        event.preventDefault();
        dragDepth += 1;
        element.classList.add(DRAG_ACTIVE_CLASS);
    });
    element.addEventListener('dragover', (event: DragEvent): void => {
        if (!carriesFiles(event) || event.dataTransfer === null) {
            return;
        }
        // Cancelling dragover is what makes the panel a drop target
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    });
    element.addEventListener('dragleave', (event: DragEvent): void => {
        if (!carriesFiles(event)) {
            return;
        }
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
            element.classList.remove(DRAG_ACTIVE_CLASS);
        }
    });
    element.addEventListener('drop', (event: DragEvent): void => {
        if (!carriesFiles(event) || event.dataTransfer === null) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        dragDepth = 0;
        element.classList.remove(DRAG_ACTIVE_CLASS);
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) {
            session.addShaderFiles(files).catch(reportCommandRejection);
        }
    });
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
