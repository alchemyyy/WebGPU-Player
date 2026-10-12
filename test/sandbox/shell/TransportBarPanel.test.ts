import { describe, expect, it } from 'vitest';

import { DEFAULT_VOLUME } from '../../../sandbox/src/contracts/SandboxContracts';
import { createTransportBarPanel } from '../../../sandbox/src/ui/panels/TransportBarPanel';
import { createFakePanelContext } from './sandboxFakes';

const DEFAULT_BUTTON_SELECTOR = '.default-button';

describe('TransportBarPanel', () => {
    it('returns the volume to its default with the button beside the slider', () => {
        const context = createFakePanelContext();
        const panel = createTransportBarPanel(context);

        panel.element.querySelector<HTMLButtonElement>(DEFAULT_BUTTON_SELECTOR)?.click();

        expect(context.session.setVolume).toHaveBeenCalledWith(DEFAULT_VOLUME);
        panel.destroy();
    });
});
