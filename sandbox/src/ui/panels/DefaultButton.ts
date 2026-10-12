// The button beside a slider, value box, or select that sets it back to its default.
import { createElement } from '../dom';

const DEFAULT_BUTTON_TEXT = 'Default';
const DEFAULT_BUTTON_CLASS = 'default-button';
const DEFAULT_TITLE_PREFIX = 'Default: ';

/** Names the default a button returns to in its title. */
export function setDefaultButtonText(button: HTMLButtonElement, defaultText: string): void {
    button.title = `${DEFAULT_TITLE_PREFIX}${defaultText}`;
}

/** Creates a default button whose title names the default; a click calls onClick, which applies it. */
export function createDefaultButton(defaultText: string, onClick: () => void): HTMLButtonElement {
    const button = createElement('button', { attributes: { type: 'button' }, className: DEFAULT_BUTTON_CLASS, text: DEFAULT_BUTTON_TEXT });
    setDefaultButtonText(button, defaultText);
    button.addEventListener('click', onClick);
    return button;
}
