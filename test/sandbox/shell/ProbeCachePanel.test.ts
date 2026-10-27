import { afterEach, describe, expect, it } from 'vitest';

import {
    CAPABILITY_PROBE_STORE_KEY,
    clearStoredCapabilityProbeVerdicts,
    configureCapabilityProbeStore,
    getDefaultCapabilityProbeStore
} from 'webgpu-player/capability/CapabilityProbeStore';

import { createProbeCachePanel } from '../../../sandbox/src/ui/panels/ProbeCachePanel';
import { createFakePanelContext } from './sandboxFakes';

const BUILD_KEY = 'asset-key-server-start';
const SUPPORTED_HEVC = Object.freeze({ codec: 'hevc', codecString: 'hvc1.1.6.L120.90', reason: 'decode-output-verified', status: 'supported' });
const CLEAR_BUTTON_TEXT = 'Clear probe cache';

describe('ProbeCachePanel', () => {
    afterEach(() => {
        clearStoredCapabilityProbeVerdicts();
        configureCapabilityProbeStore({ buildKey: '' });
    });

    it('shows the stored verdicts and the latest start, and clears the store', async () => {
        configureCapabilityProbeStore({ buildKey: BUILD_KEY });
        await getDefaultCapabilityProbeStore().write('native-sdr:hevc', SUPPORTED_HEVC);
        const context = createFakePanelContext();
        const panel = createProbeCachePanel(context);

        expect(panel.element.textContent).toContain('1 verdicts');
        expect(panel.element.textContent).toContain(`build ${BUILD_KEY}`);
        context.store.setState({ capabilityProbes: { negotiationMilliseconds: 12.34 } });
        expect(panel.element.textContent).toContain('Latest start waited 12.3 ms for its probes');

        const clearButton = [ ...panel.element.querySelectorAll('button') ].find((button) => button.textContent === CLEAR_BUTTON_TEXT);
        clearButton?.click();

        expect(globalThis.localStorage.getItem(CAPABILITY_PROBE_STORE_KEY)).toBeNull();
        expect(panel.element.textContent).toContain('Nothing stored');
        panel.destroy();
    });
});
