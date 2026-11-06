import { afterEach, describe, expect, it } from 'vitest';

import {
    CAPABILITY_PROBE_STORE_KEY,
    clearStoredCapabilityProbeVerdicts,
    configureCapabilityProbeStore,
    getDefaultCapabilityProbeStore,
    type CapabilityProbeCeiling
} from 'webgpu-player/capability/CapabilityProbeStore';

import { createProbeCachePanel, describeStoredProbeVerdicts } from '../../../sandbox/src/ui/panels/ProbeCachePanel';
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

    it('shows each probe that stopped a page with the steps it had in flight', () => {
        const text = describeStoredProbeVerdicts({
            ageMilliseconds: 0,
            blockedSteps: [],
            ceiling: null,
            crashedProbes: [
                { probe: 'h264-profiles', steps: [] },
                { probe: 'native-audio', steps: [ 'check mp4a.40.2', 'decode aac' ] }
            ],
            fingerprint: { adapter: null, buildKey: BUILD_KEY, userAgent: 'Mozilla/5.0', userAgentData: null },
            probes: [],
            suspectSteps: [],
            writtenAtMilliseconds: 0
        });

        expect(text.split('\n')).toEqual(expect.arrayContaining([
            'crashed h264-profiles',
            'crashed native-audio (check mp4a.40.2, decode aac)'
        ]));
        expect(text).not.toMatch(/^(blocked|suspect|ceiling)/mu);
    });

    it('shows the blocked steps, the suspect steps, and the concurrency ceiling', () => {
        const text = describeStoredProbeVerdicts({
            ageMilliseconds: 0,
            blockedSteps: [ 'decode mp4a.40.2 6ch 48000Hz' ],
            ceiling: { bytes: 1024, decoders: 2 },
            crashedProbes: [],
            fingerprint: { adapter: null, buildKey: BUILD_KEY, userAgent: 'Mozilla/5.0', userAgentData: null },
            probes: [],
            suspectSteps: [ 'decode hvc1.2.4.L153.B0 3840x2160 prefer-hardware' ],
            writtenAtMilliseconds: 0
        });
        const lines = text.split('\n');

        expect(lines.filter((line) => line.startsWith('blocked'))).toEqual([ expect.stringContaining('decode mp4a.40.2 6ch 48000Hz') ]);
        expect(lines.filter((line) => line.startsWith('suspect'))).toEqual([ expect.stringContaining('decode hvc1.2.4.L153.B0 3840x2160 prefer-hardware') ]);
        expect(lines.filter((line) => line.startsWith('ceiling'))).toEqual([ expect.stringMatching(/1024.*2/u) ]);
    });

    it('shows only the capped dimensions of the ceiling', () => {
        const describeCeiling = (ceiling: CapabilityProbeCeiling): string[] => describeStoredProbeVerdicts({
            ageMilliseconds: 0,
            blockedSteps: [],
            ceiling,
            crashedProbes: [],
            fingerprint: { adapter: null, buildKey: BUILD_KEY, userAgent: 'Mozilla/5.0', userAgentData: null },
            probes: [],
            suspectSteps: [],
            writtenAtMilliseconds: 0
        }).split('\n').filter((line) => line.startsWith('ceiling'));

        expect(describeCeiling({ bytes: null, decoders: 47 })).toEqual([ 'ceiling 47 decoders' ]);
        expect(describeCeiling({ bytes: 1_048_575, decoders: null })).toEqual([ 'ceiling 1048575 bytes' ]);
    });
});
