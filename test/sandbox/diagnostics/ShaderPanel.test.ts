import { describe, expect, it, vi } from 'vitest';

import type { PlanReport } from 'webgpu-player/presentation/passes/PassTypes';

import type { BuiltShaderPass, SandboxShaderFile } from '../../../sandbox/src/contracts/SandboxContracts';
import type { Panel, PanelContext } from '../../../sandbox/src/ui/Panel';
import { createShaderPanel } from '../../../sandbox/src/ui/panels/ShaderPanel';
import { createFakePanelContext } from '../shell/sandboxFakes';
import { createTestShaderFile } from './diagnosticsTestState';

const GAIN_PASS_NAME = 'Gain';
const TINT_PASS_NAME = 'Tint';
const GAIN_PARAMETER = 'gain';
const GAIN_DEFAULT = 1;
const STORED_GAIN = 1.25;
const TYPED_GAIN = 1.75;
const COMMITTED_GAIN = 0.5;
const GAIN_FILE_ID = 'gain-file';
const TINT_FILE_ID = 'tint-file';
const BUILT_PASSES: readonly BuiltShaderPass[] = [
    { fileName: 'sharpen.wgsl', url: '/wgpup/sharpen.wgsl' },
    { fileName: 'temporal-blend.wgsl', url: '/wgpup/temporal-blend.wgsl' }
];
const BUILT_PASS_PLACEHOLDER_INDEX = 0;
// The placeholder takes the first option, so each built pass's option follows its index
const SECOND_BUILT_PASS_OPTION_INDEX = 2;
const LISTING_REJECTION_MESSAGE = 'built-passes-unavailable: /__sandbox/built-passes HTTP 404';
const DROPPED_WGSL_FILE = new File([ '' ], 'grain.wgsl');
const DROPPED_TEXT_FILE = new File([ '' ], 'notes.txt');
const FILES_DRAG_TYPE = 'Files';
const TEXT_DRAG_TYPE = 'text/plain';
const MOVE_UP_OFFSET = -1;
const MOVE_DOWN_OFFSET = 1;
const REJECTION_MESSAGE = 'built-pass-unavailable: sharpen.wgsl HTTP 404';
const COMPILE_ERROR_DETAIL = 'line 9: unresolved value \'gian\'';

const ROW_SELECTOR = '.shader-pass';
const NAME_SELECTOR = '.shader-pass-name';
const STATE_SELECTOR = '.shader-pass-state';
const PARAMETER_INPUT_SELECTOR = '.shader-pass-parameter-input';
const DEFAULT_BUTTON_SELECTOR = '.default-button';
const BUILT_PASS_SELECTOR = '.shader-panel-built-passes';
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

function createFiles(gainParameters: Readonly<Record<string, number>> = {}): SandboxShaderFile[] {
    return [
        createTestShaderFile(GAIN_FILE_ID, createColorPassSource(GAIN_PASS_NAME), { parameters: gainParameters }),
        createTestShaderFile(TINT_FILE_ID, createColorPassSource(TINT_PASS_NAME))
    ];
}

function publishFiles(context: PanelContext, files: readonly SandboxShaderFile[], planReport?: PlanReport): void {
    context.store.setState(state => ({ presentation: { ...state.presentation, files, report: planReport ?? state.presentation.report } }));
}

/** A fake context whose session lists the built passes. */
function createContextWithBuiltPasses(): PanelContext {
    const context = createFakePanelContext();
    vi.mocked(context.session.listBuiltShaderPasses).mockResolvedValue(BUILT_PASSES);
    return context;
}

function requireBuiltPassSelect(panel: Panel): HTMLSelectElement {
    const select = panel.element.querySelector<HTMLSelectElement>(BUILT_PASS_SELECTOR);
    if (!select) {
        throw new Error('missing built pass selector');
    }
    return select;
}

/** Returns the built pass selector once the session's list has filled it. */
async function requireLoadedBuiltPassSelect(panel: Panel): Promise<HTMLSelectElement> {
    const select = requireBuiltPassSelect(panel);
    await vi.waitFor((): void => {
        expect(select.disabled).toBe(false);
    });
    return select;
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
    it('offers the session\'s built passes and adds the chosen one, returning to the placeholder', async () => {
        const context = createContextWithBuiltPasses();
        const panel = createShaderPanel(context);
        const select = await requireLoadedBuiltPassSelect(panel);

        expect([ ...select.options ].slice(BUILT_PASS_PLACEHOLDER_INDEX + 1).map((option: HTMLOptionElement): string | null => option.textContent))
            .toEqual(BUILT_PASSES.map((builtPass: BuiltShaderPass): string => builtPass.fileName));
        expect(select.selectedIndex).toBe(BUILT_PASS_PLACEHOLDER_INDEX);
        select.selectedIndex = SECOND_BUILT_PASS_OPTION_INDEX;
        select.dispatchEvent(new Event('change'));

        expect(context.session.addBuiltShaderPass).toHaveBeenCalledWith(BUILT_PASSES[1]);
        expect(select.selectedIndex).toBe(BUILT_PASS_PLACEHOLDER_INDEX);
        panel.destroy();
    });

    it('adds nothing when the placeholder is chosen', async () => {
        const context = createContextWithBuiltPasses();
        const panel = createShaderPanel(context);
        const select = await requireLoadedBuiltPassSelect(panel);

        select.dispatchEvent(new Event('change'));

        expect(context.session.addBuiltShaderPass).not.toHaveBeenCalled();
        panel.destroy();
    });

    it('keeps the built pass selector disabled when the session lists none', async () => {
        const context = createFakePanelContext();
        const panel = createShaderPanel(context);

        await vi.waitFor((): void => {
            expect(context.session.listBuiltShaderPasses).toHaveBeenCalledOnce();
        });
        await Promise.resolve();
        expect(requireBuiltPassSelect(panel).disabled).toBe(true);
        panel.destroy();
    });

    it('keeps the built pass selector disabled and logs the rejection when the dev server lists nothing', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
        const context = createFakePanelContext();
        const rejection = new Error(LISTING_REJECTION_MESSAGE);
        vi.mocked(context.session.listBuiltShaderPasses).mockRejectedValue(rejection);
        const panel = createShaderPanel(context);

        await vi.waitFor((): void => {
            expect(consoleError).toHaveBeenCalledWith(expect.anything(), rejection);
        });
        expect(requireBuiltPassSelect(panel).disabled).toBe(true);
        consoleError.mockRestore();
        panel.destroy();
    });

    it('hands every dropped file to the session, which reports the ones that are not WGSL', () => {
        const context = createFakePanelContext();
        const panel = createShaderPanel(context);
        const drop = createDragEvent('drop', [ DROPPED_WGSL_FILE, DROPPED_TEXT_FILE ], [ FILES_DRAG_TYPE ]);

        panel.element.dispatchEvent(drop);

        expect(context.session.addShaderFiles).toHaveBeenCalledWith([ DROPPED_WGSL_FILE, DROPPED_TEXT_FILE ]);
        expect(drop.defaultPrevented).toBe(true);
        panel.destroy();
    });

    it('leaves drags that carry no files to the page', () => {
        const context = createFakePanelContext();
        const panel = createShaderPanel(context);
        const drop = createDragEvent('drop', [], [ TEXT_DRAG_TYPE ]);

        panel.element.dispatchEvent(drop);

        expect(context.session.addShaderFiles).not.toHaveBeenCalled();
        expect(drop.defaultPrevented).toBe(false);
        panel.destroy();
    });

    it('highlights the panel while files are dragged over it, across its child elements', () => {
        const panel = createShaderPanel(createFakePanelContext());
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
        const context = createFakePanelContext();
        const panel = createShaderPanel(context);
        const fileInput = panel.element.querySelector<HTMLInputElement>(FILE_INPUT_SELECTOR);
        if (!fileInput) {
            throw new Error('missing file input');
        }

        Object.defineProperty(fileInput, 'files', { configurable: true, value: [ DROPPED_WGSL_FILE ] });
        fileInput.dispatchEvent(new Event('change'));

        expect(context.session.addShaderFiles).toHaveBeenCalledWith([ DROPPED_WGSL_FILE ]);
        panel.destroy();
    });

    it('shows each pass\'s name and state, and moves and removes it through the session', () => {
        const context = createFakePanelContext();
        const panel = createShaderPanel(context);

        publishFiles(context, createFiles(), {
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

        expect(vi.mocked(context.session.moveShaderFile).mock.calls).toEqual([ [ GAIN_FILE_ID, MOVE_DOWN_OFFSET ], [ TINT_FILE_ID, MOVE_UP_OFFSET ] ]);
        expect(context.session.removeShaderFile).toHaveBeenCalledWith(TINT_FILE_ID);
        panel.destroy();
    });

    it('sets a parameter through the session when its input commits a value', () => {
        const context = createFakePanelContext();
        const panel = createShaderPanel(context);

        publishFiles(context, createFiles({ [GAIN_PARAMETER]: STORED_GAIN }));
        const input = requireInput(getRows(panel)[0]);

        expect(input.valueAsNumber).toBe(STORED_GAIN);
        input.value = String(COMMITTED_GAIN);
        input.dispatchEvent(new Event('change'));

        expect(context.session.setShaderParameter).toHaveBeenCalledWith(GAIN_FILE_ID, GAIN_PARAMETER, COMMITTED_GAIN);
        panel.destroy();
    });

    it('returns a parameter to its manifest default with the button beside it', () => {
        const context = createFakePanelContext();
        const panel = createShaderPanel(context);

        publishFiles(context, createFiles({ [GAIN_PARAMETER]: STORED_GAIN }));
        const defaultButton = getRows(panel)[0].querySelector<HTMLButtonElement>(DEFAULT_BUTTON_SELECTOR);
        defaultButton?.click();

        expect(defaultButton?.title).toBe(`Default: ${GAIN_DEFAULT}`);
        expect(context.session.setShaderParameter).toHaveBeenCalledWith(GAIN_FILE_ID, GAIN_PARAMETER, GAIN_DEFAULT);
        panel.destroy();
    });

    it('keeps its rows across updates, leaving the value being typed in a focused input alone', () => {
        const context = createFakePanelContext();
        const panel = createShaderPanel(context);
        document.body.append(panel.element);

        publishFiles(context, createFiles());
        const [ gainRow, tintRow ] = getRows(panel);
        const gainInput = requireInput(gainRow);
        gainInput.focus();
        gainInput.value = String(TYPED_GAIN);
        publishFiles(context, createFiles({ [GAIN_PARAMETER]: STORED_GAIN }));

        expect(getRows(panel)).toEqual([ gainRow, tintRow ]);
        expect(gainInput.valueAsNumber).toBe(TYPED_GAIN);
        expect(document.activeElement).toBe(gainInput);
        gainInput.blur();
        publishFiles(context, createFiles({ [GAIN_PARAMETER]: STORED_GAIN }));

        expect(gainInput.valueAsNumber).toBe(STORED_GAIN);
        panel.destroy();
        panel.element.remove();
    });

    it('reorders its rows with the preset and drops the rows of removed files', () => {
        const context = createFakePanelContext();
        const panel = createShaderPanel(context);

        publishFiles(context, createFiles());
        const [ gainRow, tintRow ] = getRows(panel);
        publishFiles(context, [ ...createFiles() ].reverse());

        expect(getRows(panel)).toEqual([ tintRow, gainRow ]);
        publishFiles(context, createFiles().slice(1));

        expect(getRows(panel)).toEqual([ tintRow ]);
        panel.destroy();
    });

    it('logs a rejected command to the console', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
        const context = createContextWithBuiltPasses();
        const rejection = new Error(REJECTION_MESSAGE);
        vi.mocked(context.session.addBuiltShaderPass).mockRejectedValue(rejection);
        const panel = createShaderPanel(context);
        const select = await requireLoadedBuiltPassSelect(panel);

        select.selectedIndex = SECOND_BUILT_PASS_OPTION_INDEX;
        select.dispatchEvent(new Event('change'));

        await vi.waitFor((): void => {
            expect(consoleError).toHaveBeenCalledWith(expect.anything(), rejection);
        });
        panel.destroy();
    });
});
