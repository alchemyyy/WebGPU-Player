// The key that hides and shows every panel, so the video can be seen unobstructed.

/** The overlay toggle key, as KeyboardEvent.key reports it without Shift. */
export const OVERLAY_TOGGLE_KEY = 'h';

// Keys typed into these elements stay theirs
const TEXT_ENTRY_SELECTOR = 'input, select, textarea, [contenteditable]';

/** Returns whether a key press toggles the panels: the toggle key in either case, without Alt, Control, or Meta, outside text entry, and not repeated. */
export function isOverlayToggle(event: KeyboardEvent): boolean {
    if (event.key.toLowerCase() !== OVERLAY_TOGGLE_KEY || event.repeat || event.altKey || event.ctrlKey || event.metaKey) {
        return false;
    }
    return !(event.target instanceof Element && event.target.closest(TEXT_ENTRY_SELECTOR) !== null);
}
