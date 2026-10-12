import { afterEach, describe, expect, it } from 'vitest';

import { isOverlayToggle, OVERLAY_TOGGLE_KEY } from '../../../sandbox/src/ui/OverlayToggle';

const OTHER_KEY = 'j';

/** Dispatches a key press on a target and returns whether it toggles the panels. */
function pressKey(target: EventTarget, init: KeyboardEventInit): boolean {
    let toggles = false;
    const listener = (event: Event): void => {
        toggles = isOverlayToggle(event as KeyboardEvent);
    };
    document.addEventListener('keydown', listener);
    target.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }));
    document.removeEventListener('keydown', listener);
    return toggles;
}

describe('isOverlayToggle', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('toggles on the key in either case outside text entry', () => {
        const button = document.body.appendChild(document.createElement('button'));
        expect(pressKey(document.body, { key: OVERLAY_TOGGLE_KEY })).toBe(true);
        expect(pressKey(document.body, { key: OVERLAY_TOGGLE_KEY.toUpperCase(), shiftKey: true })).toBe(true);
        expect(pressKey(button, { key: OVERLAY_TOGGLE_KEY })).toBe(true);
    });

    it('ignores other keys, modified and repeated presses', () => {
        expect(pressKey(document.body, { key: OTHER_KEY })).toBe(false);
        expect(pressKey(document.body, { ctrlKey: true, key: OVERLAY_TOGGLE_KEY })).toBe(false);
        expect(pressKey(document.body, { altKey: true, key: OVERLAY_TOGGLE_KEY })).toBe(false);
        expect(pressKey(document.body, { key: OVERLAY_TOGGLE_KEY, metaKey: true })).toBe(false);
        expect(pressKey(document.body, { key: OVERLAY_TOGGLE_KEY, repeat: true })).toBe(false);
    });

    it('leaves the key to inputs, selects, text areas, and editable content', () => {
        const editable = document.createElement('div');
        editable.setAttribute('contenteditable', 'true');
        const editableChild = editable.appendChild(document.createElement('span'));
        const targets: readonly Element[] = [
            document.createElement('input'),
            document.createElement('select'),
            document.createElement('textarea'),
            editable
        ];
        for (const target of targets) {
            document.body.appendChild(target);
            expect(pressKey(target, { key: OVERLAY_TOGGLE_KEY })).toBe(false);
        }
        expect(pressKey(editableChild, { key: OVERLAY_TOGGLE_KEY })).toBe(false);
    });
});
