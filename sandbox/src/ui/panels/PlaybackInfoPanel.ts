// The panel that shows detailed playback info: media, route, clock, and presentation telemetry.
import { createElement } from '../dom';
import type { Panel, PanelContext } from '../Panel';

/* eslint-disable @typescript-eslint/no-unused-vars -- A placeholder that the diagnostics work replaces */
export function createPlaybackInfoPanel(context: PanelContext): Panel {
    return { destroy: (): void => undefined, element: createElement('section') };
}
/* eslint-enable @typescript-eslint/no-unused-vars */
