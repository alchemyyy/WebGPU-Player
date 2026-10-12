// The panel that shows the active presentation plan as a flow graph.
import { createElement } from '../dom';
import type { Panel, PanelContext } from '../Panel';

/* eslint-disable @typescript-eslint/no-unused-vars -- A placeholder that the diagnostics work replaces */
export function createPipelineGraphPanel(context: PanelContext): Panel {
    return { destroy: (): void => undefined, element: createElement('section') };
}
/* eslint-enable @typescript-eslint/no-unused-vars */
