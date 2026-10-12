import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindControlWheel, getWheelDirection, getWheelValue, type WheelControl } from '../../../sandbox/src/ui/ControlWheel';

// One mouse wheel notch, as browsers report it in pixels; negative is up
const NOTCH_UP = -100;
const NOTCH_DOWN = 100;
// The tone mapping's nits slider, where a notch moves a fiftieth of 1 to 10000, snapped to whole nits
const NITS_SLIDER: WheelControl = { kind: 'slider', maximum: 10_000, minimum: 1, step: 1, value: 1_000 };
const NITS_AFTER_NOTCH_UP = 1_200;
const NITS_AFTER_NOTCH_DOWN = 800;
const NITS_AFTER_FINE_NOTCH_UP = 1_020;
const NITS_NEAR_MAXIMUM = 9_990;
// A slider whose fine share of its range is below its step, which a notch still moves
const DESATURATION_SLIDER: WheelControl = { kind: 'slider', maximum: 1, minimum: 0, step: 0.01, value: 0.25 };
const DESATURATION_AFTER_FINE_NOTCH_UP = 0.26;
// The exposure slider, whose coarse notch of 0.64 snaps to its 0.1 steps
const EXPOSURE_SLIDER: WheelControl = { kind: 'slider', maximum: 16, minimum: -16, step: 0.1, value: 0 };
const EXPOSURE_AFTER_NOTCH_UP = 0.6;
// A WGSL pass parameter box, which moves one step per notch without floating-point noise
const SATURATION_BOX: WheelControl = { kind: 'value-box', maximum: 2, minimum: 0, step: 0.05, value: 1.1 };
const SATURATION_AFTER_NOTCH_UP = 1.15;
// A box with step="any" moves a hundredth of its range, and one without limits or a step moves one unit
const STEPLESS_BOX: WheelControl = { kind: 'value-box', maximum: 2, minimum: 0, step: null, value: 1 };
const STEPLESS_AFTER_NOTCH_UP = 1.02;
const UNBOUNDED_BOX: WheelControl = { kind: 'value-box', maximum: null, minimum: null, step: 1, value: 5 };
const UNBOUNDED_AFTER_NOTCH_DOWN = 4;
// The DOM controls for the binding
const VOLUME_ATTRIBUTES = { max: '1', min: '0', step: '0.01', type: 'range', value: '0.5' };
const VOLUME_AFTER_NOTCH_UP = '0.52';
const PARAMETER_ATTRIBUTES = { max: '2', min: '0', step: '0.05', type: 'number', value: '1' };
const PARAMETER_AFTER_NOTCH_DOWN = '0.95';
const PARAMETER_AT_MINIMUM = '0';

type DispatchedWheel = Readonly<{
    changeCount: number
    defaultPrevented: boolean
    inputCount: number
}>;

/** Creates an element with attributes in a bound root on the page. */
function createBoundElement(tagName: string, attributes: Readonly<Record<string, string>>): HTMLElement {
    const root = document.body.appendChild(document.createElement('div'));
    bindControlWheel(root);
    const element = root.appendChild(document.createElement(tagName));
    for (const [ name, value ] of Object.entries(attributes)) {
        element.setAttribute(name, value);
    }
    return element;
}

/** Dispatches one wheel notch on a target and counts the input and change events it fired. */
function dispatchWheel(target: Element, init: WheelEventInit): DispatchedWheel {
    const inputListener = vi.fn();
    const changeListener = vi.fn();
    target.addEventListener('input', inputListener);
    target.addEventListener('change', changeListener);
    const event = new WheelEvent('wheel', { ...init, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return { changeCount: changeListener.mock.calls.length, defaultPrevented: event.defaultPrevented, inputCount: inputListener.mock.calls.length };
}

describe('ControlWheel', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('moves up on wheel up and down on wheel down, through the horizontal delta under Shift', () => {
        expect(getWheelDirection(0, NOTCH_UP)).toBe(1);
        expect(getWheelDirection(0, NOTCH_DOWN)).toBe(-1);
        expect(getWheelDirection(NOTCH_UP, 0)).toBe(1);
        expect(getWheelDirection(0, 0)).toBeNull();
    });

    it('moves a slider a fiftieth of its range per notch, a tenth as far when fine, and never less than a step', () => {
        expect(getWheelValue(NITS_SLIDER, 1, false)).toBe(NITS_AFTER_NOTCH_UP);
        expect(getWheelValue(NITS_SLIDER, -1, false)).toBe(NITS_AFTER_NOTCH_DOWN);
        expect(getWheelValue(NITS_SLIDER, 1, true)).toBe(NITS_AFTER_FINE_NOTCH_UP);
        expect(getWheelValue(DESATURATION_SLIDER, 1, true)).toBe(DESATURATION_AFTER_FINE_NOTCH_UP);
        expect(getWheelValue(EXPOSURE_SLIDER, 1, false)).toBe(EXPOSURE_AFTER_NOTCH_UP);
        expect(getWheelValue({ ...NITS_SLIDER, value: NITS_NEAR_MAXIMUM }, 1, false)).toBe(NITS_SLIDER.maximum);
    });

    it('moves a value box one step per notch, a stepless one a hundredth of its range, and an unbounded one freely', () => {
        expect(getWheelValue(SATURATION_BOX, 1, false)).toBe(SATURATION_AFTER_NOTCH_UP);
        expect(getWheelValue(SATURATION_BOX, 1, true)).toBe(SATURATION_AFTER_NOTCH_UP);
        expect(getWheelValue(STEPLESS_BOX, 1, false)).toBe(STEPLESS_AFTER_NOTCH_UP);
        expect(getWheelValue(UNBOUNDED_BOX, -1, false)).toBe(UNBOUNDED_AFTER_NOTCH_DOWN);
    });

    it('applies a slider and a value box at once, with the events dragging and committing fire', () => {
        const volume = createBoundElement('input', VOLUME_ATTRIBUTES) as HTMLInputElement;
        const parameter = createBoundElement('input', PARAMETER_ATTRIBUTES) as HTMLInputElement;

        expect(dispatchWheel(volume, { deltaY: NOTCH_UP })).toEqual({ changeCount: 1, defaultPrevented: true, inputCount: 1 });
        expect(volume.value).toBe(VOLUME_AFTER_NOTCH_UP);
        expect(dispatchWheel(parameter, { deltaY: NOTCH_DOWN })).toEqual({ changeCount: 1, defaultPrevented: true, inputCount: 1 });
        expect(parameter.value).toBe(PARAMETER_AFTER_NOTCH_DOWN);
    });

    it('keeps the page from scrolling at a limit without firing events, and leaves other elements and disabled controls alone', () => {
        const parameter = createBoundElement('input', { ...PARAMETER_ATTRIBUTES, value: PARAMETER_AT_MINIMUM }) as HTMLInputElement;
        const disabled = createBoundElement('input', { ...VOLUME_ATTRIBUTES, disabled: '' });
        const label = createBoundElement('span', {});

        expect(dispatchWheel(parameter, { deltaY: NOTCH_DOWN })).toEqual({ changeCount: 0, defaultPrevented: true, inputCount: 0 });
        expect(parameter.value).toBe(PARAMETER_AT_MINIMUM);
        expect(dispatchWheel(disabled, { deltaY: NOTCH_UP })).toEqual({ changeCount: 0, defaultPrevented: false, inputCount: 0 });
        expect(dispatchWheel(label, { deltaY: NOTCH_UP })).toEqual({ changeCount: 0, defaultPrevented: false, inputCount: 0 });
    });
});
