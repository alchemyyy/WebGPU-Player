import { describe, expect, it, vi } from 'vitest';

import type { PlanReport } from 'webgpu-player/presentation/passes/PassTypes';

import type { ExampleShaderPass, SandboxShaderPass } from '../../../sandbox/src/contracts/SandboxContracts';
import type { Panel } from '../../../sandbox/src/ui/Panel';
import { createShaderPanel } from '../../../sandbox/src/ui/panels/ShaderPanel';
import { createTestPanelContext, createTestShaderPass, type TestPanelContext } from './diagnosticsTestState';

const GAIN_PASS_NAME = 'Gain';
const TINT_PASS_NAME = 'Tint';
const GAIN_PARAMETER = 'gain';
const GAIN_DEFAULT = 1;
const STORED_GAIN = 1.25;
const TYPED_GAIN = 1.75;
const COMMITTED_GAIN = 0.5;
const GAIN_PASS_ID = 'gain-pass';
const TINT_PASS_ID = 'tint-pass';
const EXAMPLES: readonly ExampleShaderPass[] = [
    { id: 'sharpen', name: 'Sharpen kernel', source: '' },
    { id: 'temporal', name: 'Temporal blend', source: '' }
];
const NO_EXAMPLE_VALUE = '';
const DROPPED_WGSL_FILE = new File([ '' ], 'grain.wgsl');
const DROPPED_TEXT_FILE = new File([ '' ], 'notes.txt');
const FILES_DRAG_TYPE = 'Files';
const TEXT_DRAG_TYPE = 'text/plain';
const MOVE_UP_OFFSET = -1;
const MOVE_DOWN_OFFSET = 1;
const REJECTION_MESSAGE = 'example-unknown: sharpen';
const COMPILE_ERROR_DETAIL = 'line 9: unresolved value \'gian\'';

const ROW_SELECTOR = '.shader-pass';
const NAME_SELECTOR = '.shader-pass-name';
const STATE_SELECTOR = '.shader-pass-state';
const PARAMETER_INPUT_SELECTOR = '.shader-pass-parameter-input';
const EXAMPLE_SELECTOR = '.shader-panel-examples';
const FILE_INPUT_SELECTOR = '.shader-panel-file-input';
const DRAG_ACTIVE_CLASS = 'shader-panel-drag-active';
const MOVE_UP_BUTTON_INDEX = 0;
const MOVE_DOWN_BUTTON_INDEX = 1;
const REMOVE_BUTTON_INDEX = 2;

function createColorPassSource(name: string): string {
    return [
        `//! name: ${name}`,
        '//! shape: color',
        '//! hook: OUTPUT',
        '//! domain: display',
        `//! param ${GAIN_PARAMETER}: f32 = ${GAIN_DEFAULT} in [0, 2]`,
        '',
        'fn apply(color: vec4f, position: vec2f) -> vec4f {',
        '    return color * parameters.gain;',
        '}',
        ''
    ].join('\n');
}

function createPasses(gainParameters: Readonly<Record<string, number>> = {}): SandboxShaderPass[] {
    return [
        createTestShaderPass(GAIN_PASS_ID, createColorPassSource(GAIN_PASS_NAME), { parameters: gainParameters }),
        createTestShaderPass(TINT_PASS_ID, createColorPassSource(TINT_PASS_NAME))
    ];
}

function publishPasses(context: TestPanelContext, passes: readonly SandboxShaderPass[], planReport?: PlanReport): void {
    context.store.setState(state => ({ presentation: { ...state.presentation, passes, report: planReport ?? state.presentation.report } }));
}

function getRows(panel: Panel): HTMLElement[] {
    return [ ...panel.element.querySelectorAll<HTMLElement>(ROW_SELECTOR) ];
}

function getButtons(row: HTMLElement): HTMLButtonElement[] {
    return [ ...row.querySelectorAll<HTMLButtonElement>('button') ];
}

function requireInput(row: HTMLElement): HTMLInputElement {
    const input = row.querySelector<HTMLInputElement>(PARAMETER_INPUT_SELECTOR);
    if (!input) {
        throw new Error('missing parameter input');
    }
    return input;
}

/** A drag event whose data carries the files and types, which jsdom's events lack. */
function createDragEvent(type: string, files: readonly File[], types: readonly string[]): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { dropEffect: 'none', files, types } });
    return event;
}

describe('createShaderPanel', () => {
    it('offers the session\'s examples and adds the chosen one, returning to the placeholder', () => {
        const context = createTestPanelContext(undefined, EXAMPLES);
        const panel = createShaderPanel(context);
        const select = panel.element.querySelector<HTMLSelectElement>(EXAMPLE_SELECTOR);
        if (!select) {
            throw new Error('missing example selector');
        }

        expect([ ...select.options ].map((option: HTMLOptionElement): string => option.value)).toEqual([ NO_EXAMPLE_VALUE, EXAMPLES[0].id, EXAMPLES[1].id ]);
        select.value = EXAMPLES[1].id;
        select.dispatchEvent(new Event('change'));

        expect(context.session.addExampleShaderPass).toHaveBeenCalledWith(EXAMPLES[1].id);
        expect(select.value).toBe(NO_EXAMPLE_VALUE);
        panel.destroy();
    });

    it('disables the example selector when the session offers none', () => {
        const panel = createShaderPanel(createTestPanelContext());

        expect(panel.element.querySelector<HTMLSelectElement>(EXAMPLE_SELECTOR)?.disabled).toBe(true);
        panel.destroy();
    });

    it('hands every dropped file to the session, which reports the ones that are not WGSL', () => {
        const context = createTestPanelContext();
        const panel = createShaderPanel(context);
        const drop = createDragEvent('drop', [ DROPPED_WGSL_FILE, DROPPED_TEXT_FILE ], [ FILES_DRAG_TYPE ]);

        panel.element.dispatchEvent(drop);

        expect(context.session.addShaderPasses).toHaveBeenCalledWith([ DROPPED_WGSL_FILE, DROPPED_TEXT_FILE ]);
        expect(drop.defaultPrevented).toBe(true);
        panel.destroy();
    });

    it('leaves drags that carry no files to the page', () => {
        const context = createTestPanelContext();
        const panel = createShaderPanel(context);
        const drop = createDragEvent('drop', [], [ TEXT_DRAG_TYPE ]);

        panel.element.dispatchEvent(drop);

        expect(context.session.addShaderPasses).not.toHaveBeenCalled();
        expect(drop.defaultPrevented).toBe(false);
        panel.destroy();
    });

    it('highlights the panel while files are dragged over it, across its child elements', () => {
        const panel = createShaderPanel(createTestPanelContext());
        const child = panel.element.firstElementChild;
        if (!child) {
            throw new Error('missing child element');
        }

        panel.element.dispatchEvent(createDragEvent('dragenter', [], [ FILES_DRAG_TYPE ]));
        child.dispatchEvent(createDragEvent('dragenter', [], [ FILES_DRAG_TYPE ]));
        panel.element.dispatchEvent(createDragEvent('dragleave', [], [ FILES_DRAG_TYPE ]));

        expect(panel.element.classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
        child.dispatchEvent(createDragEvent('dragleave', [], [ FILES_DRAG_TYPE ]));

        expect(panel.element.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
        panel.destroy();
    });

    it('hands files chosen in the file dialog to the session', () => {
        const context = createTestPanelContext();
        const panel = createShaderPanel(context);
        const fileInput = panel.element.querySelector<HTMLInputElement>(FILE_INPUT_SELECTOR);
        if (!fileInput) {
            throw new Error('missing file input');
        }

        Object.defineProperty(fileInput, 'files', { configurable: true, value: [ DROPPED_WGSL_FILE ] });
        fileInput.dispatchEvent(new Event('change'));

        expect(context.session.addShaderPasses).toHaveBeenCalledWith([ DROPPED_WGSL_FILE ]);
        panel.destroy();
    });

    it('shows each pass\'s name and state, and moves and removes it through the session', () => {
        const context = createTestPanelContext();
        const panel = createShaderPanel(context);

        publishPasses(context, createPasses(), {
            activePasses: [ GAIN_PASS_NAME ],
            inactivePasses: [ { detail: COMPILE_ERROR_DETAIL, name: TINT_PASS_NAME, reason: 'compile-error' } ]
        });
        const [ gainRow, tintRow ] = getRows(panel);

        expect(gainRow.querySelector(NAME_SELECTOR)?.textContent).toBe(GAIN_PASS_NAME);
        expect(gainRow.querySelector(STATE_SELECTOR)?.textContent).toBe('active');
        expect(tintRow.querySelector(STATE_SELECTOR)?.textContent).toBe(`compile-error: ${COMPILE_ERROR_DETAIL}`);
        expect(tintRow.querySelector<HTMLElement>(STATE_SELECTOR)?.dataset.tone).toBe('failure');
        expect(getButtons(gainRow)[MOVE_UP_BUTTON_INDEX].disabled).toBe(true);
        expect(getButtons(tintRow)[MOVE_DOWN_BUTTON_INDEX].disabled).toBe(true);

        getButtons(gainRow)[MOVE_DOWN_BUTTON_INDEX].click();
        getButtons(tintRow)[MOVE_UP_BUTTON_INDEX].click();
        getButtons(tintRow)[REMOVE_BUTTON_INDEX].click();

        expect(context.session.moveShaderPass.mock.calls).toEqual([ [ GAIN_PASS_ID, MOVE_DOWN_OFFSET ], [ TINT_PASS_ID, MOVE_UP_OFFSET ] ]);
        expect(context.session.removeShaderPass).toHaveBeenCalledWith(TINT_PASS_ID);
        panel.destroy();
    });

    it('sets a parameter through the session when its input commits a value', () => {
        const context = createTestPanelContext();
        const panel = createShaderPanel(context);

        publishPasses(context, createPasses({ [GAIN_PARAMETER]: STORED_GAIN }));
        const input = requireInput(getRows(panel)[0]);

        expect(input.valueAsNumber).toBe(STORED_GAIN);
        input.value = String(COMMITTED_GAIN);
        input.dispatchEvent(new Event('change'));

        expect(context.session.setShaderParameter).toHaveBeenCalledWith(GAIN_PASS_ID, GAIN_PARAMETER, COMMITTED_GAIN);
        panel.destroy();
    });

    it('keeps its rows across updates, leaving the value being typed in a focused input alone', () => {
        const context = createTestPanelContext();
        const panel = createShaderPanel(context);
        document.body.append(panel.element);

        publishPasses(context, createPasses());
        const [ gainRow, tintRow ] = getRows(panel);
        const gainInput = requireInput(gainRow);
        gainInput.focus();
        gainInput.value = String(TYPED_GAIN);
        publishPasses(context, createPasses({ [GAIN_PARAMETER]: STORED_GAIN }));

        expect(getRows(panel)).toEqual([ gainRow, tintRow ]);
        expect(gainInput.valueAsNumber).toBe(TYPED_GAIN);
        expect(document.activeElement).toBe(gainInput);
        gainInput.blur();
        publishPasses(context, createPasses({ [GAIN_PARAMETER]: STORED_GAIN }));

        expect(gainInput.valueAsNumber).toBe(STORED_GAIN);
        panel.destroy();
        panel.element.remove();
    });

    it('reorders its rows with the preset and drops the rows of removed passes', () => {
        const context = createTestPanelContext();
        const panel = createShaderPanel(context);

        publishPasses(context, createPasses());
        const [ gainRow, tintRow ] = getRows(panel);
        publishPasses(context, [ ...createPasses() ].reverse());

        expect(getRows(panel)).toEqual([ tintRow, gainRow ]);
        publishPasses(context, createPasses().slice(1));

        expect(getRows(panel)).toEqual([ tintRow ]);
        panel.destroy();
    });

    it('logs a rejected command to the console', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
        const context = createTestPanelContext(undefined, EXAMPLES);
        const rejection = new Error(REJECTION_MESSAGE);
        context.session.addExampleShaderPass.mockRejectedValue(rejection);
        const panel = createShaderPanel(context);
        const select = panel.element.querySelector<HTMLSelectElement>(EXAMPLE_SELECTOR);
        if (!select) {
            throw new Error('missing example selector');
        }

        select.value = EXAMPLES[0].id;
        select.dispatchEvent(new Event('change'));

        await vi.waitFor((): void => {
            expect(consoleError).toHaveBeenCalledWith(expect.anything(), rejection);
        });
        panel.destroy();
    });
});
