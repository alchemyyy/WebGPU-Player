import { describe, expect, it } from 'vitest';

import type { RouteOverride } from '../../../sandbox/src/contracts/SandboxContracts';
import { createRouteOverridePanel } from '../../../sandbox/src/ui/panels/RouteOverridePanel';
import { createFakePanelContext } from './sandboxFakes';

const FORCED_OVERRIDE: RouteOverride = { decoder: 'gpu', transport: 'raw-planes' };
const AUTO_DEFAULT_TITLE = 'Default: Auto';
const DEFAULT_BUTTON_SELECTOR = '.default-button';

describe('RouteOverridePanel', () => {
    it('returns the decoder and the transport to auto, sending only a change, since each change restarts the media', () => {
        const context = createFakePanelContext();
        const panel = createRouteOverridePanel(context);
        const [ decoderDefaultButton, transportDefaultButton ] = panel.element.querySelectorAll<HTMLButtonElement>(DEFAULT_BUTTON_SELECTOR);

        decoderDefaultButton.click();
        transportDefaultButton.click();
        expect(context.session.setRouteOverride).not.toHaveBeenCalled();

        context.store.setState((state) => ({ route: { ...state.route, override: FORCED_OVERRIDE } }));
        decoderDefaultButton.click();
        transportDefaultButton.click();

        expect(decoderDefaultButton.title).toBe(AUTO_DEFAULT_TITLE);
        expect(context.session.setRouteOverride).toHaveBeenCalledWith({ ...FORCED_OVERRIDE, decoder: 'auto' });
        expect(context.session.setRouteOverride).toHaveBeenCalledWith({ ...FORCED_OVERRIDE, transport: 'auto' });
        panel.destroy();
    });
});
