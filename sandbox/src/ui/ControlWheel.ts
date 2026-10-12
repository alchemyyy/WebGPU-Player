// Scrolling over a slider or a value box moves its value and applies it at once, as dragging the slider or committing the box does.

export type WheelControl = Readonly<{
    kind: 'slider' | 'value-box'
    maximum: number | null
    minimum: number | null
    /** Null for step="any" */
    step: number | null
    value: number
}>;

export type WheelDirection = -1 | 1;

const CONTROL_SELECTOR = 'input[type="range"], input[type="number"]';
const SLIDER_TYPE = 'range';
const ANY_STEP = 'any';
// What a missing or invalid step attribute means, and a range input's limits when its attributes leave them out
const DEFAULT_STEP = 1;
const DEFAULT_SLIDER_MINIMUM = 0;
const DEFAULT_SLIDER_MAXIMUM = 100;
// A notch moves a slider a fiftieth of its range, or a five-hundredth with Shift, and never less than one step
const SLIDER_NOTCHES_PER_RANGE = 50;
const FINE_SLIDER_NOTCHES_PER_RANGE = 500;
// A value box moves one step per notch; one with step="any" moves a hundredth of its range, or one unit without limits
const STEPLESS_NOTCHES_PER_RANGE = 100;
// Digits a snapped value keeps, which drops binary floating-point noise such as 1.1500000000000001
const SNAP_PRECISION_DIGITS = 12;

/**
 * Returns the direction a wheel event moves a value: up increases it, and down decreases it; null when it does not move.
 * Browsers turn the wheel horizontal under Shift, so a vertical delta of 0 falls back to the horizontal one.
 */
export function getWheelDirection(deltaX: number, deltaY: number): WheelDirection | null {
    const delta = deltaY === 0 ? deltaX : deltaY;
    if (delta === 0) {
        return null;
    }
    return delta < 0 ? 1 : -1;
}

function getWheelIncrement(control: WheelControl, fine: boolean): number {
    const span = control.minimum !== null && control.maximum !== null ? control.maximum - control.minimum : null;
    switch (control.kind) {
        case 'slider':
            return Math.max((span ?? 0) / (fine ? FINE_SLIDER_NOTCHES_PER_RANGE : SLIDER_NOTCHES_PER_RANGE), control.step ?? 0);
        case 'value-box':
            return control.step ?? (span === null ? DEFAULT_STEP : span / STEPLESS_NOTCHES_PER_RANGE);
    }
}

/** Returns a control's value one wheel notch away, snapped to its steps from its minimum and clamped to its limits. */
export function getWheelValue(control: WheelControl, direction: WheelDirection, fine: boolean): number {
    const moved = control.value + direction * getWheelIncrement(control, fine);
    const base = control.minimum ?? 0;
    const snapped = control.step === null ? moved : base + Math.round((moved - base) / control.step) * control.step;
    const clamped = Math.min(Math.max(snapped, control.minimum ?? -Infinity), control.maximum ?? Infinity);
    return Number(clamped.toPrecision(SNAP_PRECISION_DIGITS));
}

function readOptionalNumber(text: string): number | null {
    const value = Number(text);
    return text !== '' && Number.isFinite(value) ? value : null;
}

/** Returns a control's step: null for "any", in any case, and the default for a missing or invalid one. */
function readStep(input: HTMLInputElement): number | null {
    if (input.step.toLowerCase() === ANY_STEP) {
        return null;
    }
    const step = readOptionalNumber(input.step);
    return step !== null && step > 0 ? step : DEFAULT_STEP;
}

/** Reads a slider or value box as the HTML attributes define it, defaults included. */
function readWheelControl(input: HTMLInputElement): WheelControl {
    const slider = input.type === SLIDER_TYPE;
    const minimum = readOptionalNumber(input.min) ?? (slider ? DEFAULT_SLIDER_MINIMUM : null);
    const maximum = readOptionalNumber(input.max) ?? (slider ? DEFAULT_SLIDER_MAXIMUM : null);
    // An empty value box starts from its minimum
    const value = Number.isNaN(input.valueAsNumber) ? minimum ?? 0 : input.valueAsNumber;
    return { kind: slider ? 'slider' : 'value-box', maximum, minimum, step: readStep(input), value };
}

/** Moves the slider or value box under the pointer by one notch per wheel event, below a root, for the page's lifetime. */
export function bindControlWheel(root: HTMLElement): void {
    root.addEventListener('wheel', (event: WheelEvent): void => {
        const input = event.target instanceof Element ? event.target.closest<HTMLInputElement>(CONTROL_SELECTOR) : null;
        const direction = getWheelDirection(event.deltaX, event.deltaY);
        if (!input || input.disabled || input.readOnly || direction === null) {
            return;
        }
        // The page stays put, and a focused value box does not also step itself
        event.preventDefault();
        const value = String(getWheelValue(readWheelControl(input), direction, event.shiftKey));
        if (value === input.value) {
            return;
        }
        input.value = value;
        // The panels apply a slider on input and a value box on change, which dragging and committing fire
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { passive: false });
}
