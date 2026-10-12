// The panel that shows the WGSL pass preset: examples, dropped files, order, parameters, and the plan report.
import { createElement } from '../dom';
import type { Panel, PanelContext } from '../Panel';

/* eslint-disable @typescript-eslint/no-unused-vars -- A placeholder that the diagnostics work replaces */
export function createShaderPanel(context: PanelContext): Panel {
    return { destroy: (): void => undefined, element: createElement('section') };
}
/* eslint-enable @typescript-eslint/no-unused-vars */
