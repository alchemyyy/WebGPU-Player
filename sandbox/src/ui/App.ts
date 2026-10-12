// The overlay layout: it mounts every panel into its region above the full-window player surface.
import type { PanelContext } from './Panel';

export type SandboxAppContext = PanelContext & Readonly<{
    overlay: HTMLElement
}>;

/* eslint-disable @typescript-eslint/no-unused-vars -- A placeholder that the UI shell work replaces */
export function mountSandboxApp(context: SandboxAppContext): void {
    // The UI shell work mounts the panels here
}
/* eslint-enable @typescript-eslint/no-unused-vars */
