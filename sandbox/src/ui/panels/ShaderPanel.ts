// The panel that shows the WGSL pass preset: examples, dropped files, order, parameters, and the plan report.
import type { PlanReport } from 'webgpu-player/presentation/passes/PassTypes';

import type {
    ExampleShaderPass,
    SandboxSessionCommands,
    SandboxShaderPass,
    SandboxState
} from '../../contracts/SandboxContracts';
import { reportCommandRejection } from '../commands';
import {
    describeShaderPasses,
    type ShaderParameterField,
    type ShaderPassRow
} from '../diagnostics/ShaderPassRows';
import { createTupleSelector } from '../diagnostics/TupleSelector';
import { createElement } from '../dom';
import type { Panel, PanelContext } from '../Panel';
import { subscribeSelection } from '../Store';

import './ShaderPanel.css';

// The drag data type of dropped files
const FILES_DRAG_TYPE = 'Files';
const DRAG_ACTIVE_CLASS = 'shader-panel-drag-active';
const NO_EXAMPLE_VALUE = '';
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

type ShaderInputs = readonly [passes: readonly SandboxShaderPass[], planReport: PlanReport];

/** One pass's row, kept across updates so a focused parameter input keeps its focus and its typing. */
type PassRowView = Readonly<{
    element: HTMLLIElement
    moveDown: HTMLButtonElement
    moveUp: HTMLButtonElement
    name: HTMLElement
    parameterInputs: ReadonlyMap<string, HTMLInputElement>
    state: HTMLElement
}>;

export function createShaderPanel(context: PanelContext): Panel {
    const session = context.session;
    const passList = createElement('ol', { className: 'shader-pass-list' });
    const emptyHint = createElement('p', { className: 'shader-panel-hint', text: EMPTY_PRESET_TEXT });
    const element = createElement('section', { className: 'shader-panel' }, [
        createHeader(session),
        passList,
        emptyHint,
        createElement('p', { className: 'shader-panel-hint', text: DROP_HINT_TEXT })
    ]);
    listenForDroppedFiles(element, session);
    let rowViews = new Map<string, PassRowView>();
    const destroy = subscribeSelection(
        context.store,
        createTupleSelector((state: SandboxState): ShaderInputs => [ state.presentation.passes, state.presentation.report ]),
        ([ passes, planReport ]: ShaderInputs): void => {
            const rows = describeShaderPasses(passes, planReport);
            rowViews = renderRows(passList, rowViews, rows, session);
            emptyHint.hidden = rows.length > 0;
        }
    );
    return { destroy, element };
}

function createHeader(session: SandboxSessionCommands): HTMLElement {
    const exampleSelect = createExampleSelect(session.getExampleShaderPasses());
    exampleSelect.addEventListener('change', (): void => {
        const exampleId = exampleSelect.value;
        // The placeholder comes back, so choosing the same example again adds another copy
        exampleSelect.value = NO_EXAMPLE_VALUE;
        if (exampleId !== NO_EXAMPLE_VALUE) {
            session.addExampleShaderPass(exampleId).catch(reportCommandRejection);
        }
    });
    const fileInput = createElement('input', { attributes: { multiple: '', type: 'file' }, className: 'shader-panel-file-input' });
    fileInput.hidden = true;
    fileInput.addEventListener('change', (): void => {
        const files = Array.from(fileInput.files ?? []);
        // Clearing the input lets the same files be chosen again
        fileInput.value = '';
        if (files.length > 0) {
            session.addShaderPasses(files).catch(reportCommandRejection);
        }
    });
    const openButton = createButton(OPEN_FILES_TEXT, (): void => {
        fileInput.click();
    });
    return createElement('div', { className: 'shader-panel-header' }, [
        createElement('h3', { className: 'shader-panel-title', text: TITLE_TEXT }),
        exampleSelect,
        openButton,
        fileInput
    ]);
}

function createExampleSelect(examples: readonly ExampleShaderPass[]): HTMLSelectElement {
    const options: Node[] = [];
    options.push(createElement('option', { attributes: { value: NO_EXAMPLE_VALUE }, text: EXAMPLE_PLACEHOLDER_TEXT }));
    for (const example of examples) {
        options.push(createElement('option', { attributes: { value: example.id }, text: example.name }));
    }
    const select = createElement('select', { className: 'shader-panel-examples' }, options);
    select.disabled = examples.length === 0;
    return select;
}

/** Hands every file dropped on the panel to the session, which reports the ones that are not WGSL passes. */
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
            session.addShaderPasses(files).catch(reportCommandRejection);
        }
    });
}

function carriesFiles(event: DragEvent): boolean {
    return event.dataTransfer !== null && Array.from(event.dataTransfer.types).includes(FILES_DRAG_TYPE);
}

/**
 * Brings the list to the rows' order, reusing each pass's row by its id and creating rows only for new passes.
 * Stale rows go first, so rows that stay are moved only when the order changed.
 */
function renderRows(
    passList: HTMLElement,
    previousViews: ReadonlyMap<string, PassRowView>,
    rows: readonly ShaderPassRow[],
    session: SandboxSessionCommands
): Map<string, PassRowView> {
    const views = new Map<string, PassRowView>();
    const placements: (readonly [ShaderPassRow, PassRowView])[] = [];
    for (const row of rows) {
        const view = previousViews.get(row.id) ?? createRowView(row, session);
        views.set(row.id, view);
        placements.push([ row, view ]);
    }
    for (const [ passId, view ] of previousViews) {
        if (!views.has(passId)) {
            passList.removeChild(view.element);
        }
    }
    for (const [ index, [ row, view ] ] of placements.entries()) {
        updateRowView(view, row, index, rows.length);
        const currentChild = passList.children.item(index);
        if (currentChild !== view.element) {
            passList.insertBefore(view.element, currentChild);
        }
    }
    return views;
}

function createRowView(row: ShaderPassRow, session: SandboxSessionCommands): PassRowView {
    const name = createElement('span', { attributes: { title: row.origin }, className: 'shader-pass-name' });
    const state = createElement('span', { className: 'shader-pass-state' });
    const moveUp = createButton(MOVE_UP_TEXT, (): void => {
        session.moveShaderPass(row.id, MOVE_UP_OFFSET).catch(reportCommandRejection);
    });
    const moveDown = createButton(MOVE_DOWN_TEXT, (): void => {
        session.moveShaderPass(row.id, MOVE_DOWN_OFFSET).catch(reportCommandRejection);
    });
    const remove = createButton(REMOVE_TEXT, (): void => {
        session.removeShaderPass(row.id).catch(reportCommandRejection);
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
            createElement('span', { className: 'shader-pass-parameter-range', text: `[${field.minimum}, ${field.maximum}]` })
        ]));
    }
    const element = createElement('li', { className: 'shader-pass' }, [
        createElement('div', { className: 'shader-pass-header' }, [
            name,
            state,
            createElement('span', { className: 'shader-pass-actions' }, [ moveUp, moveDown, remove ])
        ]),
        createElement('div', { className: 'shader-pass-parameters' }, parameterFields)
    ]);
    return { element, moveDown, moveUp, name, parameterInputs, state };
}

function createParameterInput(passId: string, field: ShaderParameterField, session: SandboxSessionCommands): HTMLInputElement {
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
        session.setShaderParameter(passId, field.name, input.valueAsNumber);
    });
    return input;
}

function updateRowView(view: PassRowView, row: ShaderPassRow, index: number, rowCount: number): void {
    setText(view.name, row.name);
    setText(view.state, row.stateText);
    view.state.dataset.tone = row.stateTone;
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

function setText(element: HTMLElement, text: string): void {
    if (element.textContent !== text) {
        element.textContent = text;
    }
}

function createButton(text: string, onClick: () => void): HTMLButtonElement {
    const button = createElement('button', { attributes: { type: 'button' }, text });
    button.addEventListener('click', onClick);
    return button;
}
