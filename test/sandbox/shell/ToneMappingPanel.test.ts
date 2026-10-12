import { describe, expect, it, vi } from 'vitest';

import { createHDRToSDRRenderSettings, type HDRToSDRRenderSettings } from 'webgpu-player/presentation/RenderSettings';

import { createToneMappingPanel } from '../../../sandbox/src/ui/panels/ToneMappingPanel';
import { createFakePanelContext } from './sandboxFakes';

const EXPOSURE_LABEL = 'Exposure';
const PAPER_WHITE_LABEL = 'Paper white nits';
const RAISED_EXPOSURE = 1.5;
const PRESENTER_EXPOSURE = 2;
const DEFAULT_SETTINGS: HDRToSDRRenderSettings = createHDRToSDRRenderSettings();
// One nit above the default input peak, which the engine rejects for paper white
const PAPER_WHITE_ABOVE_PEAK_NITS = DEFAULT_SETTINGS.toneMapping.inputPeakNits + 1;
const PAPER_WHITE_REJECTION = `paperWhiteNits: ${PAPER_WHITE_ABOVE_PEAK_NITS} above inputPeakNits ${DEFAULT_SETTINGS.toneMapping.inputPeakNits}`;

type SettingInputs = Readonly<{ numberInput: HTMLInputElement; rangeInput: HTMLInputElement }>;

/** Finds the slider and number of the row a label names. */
function findSettingInputs(panelElement: HTMLElement, label: string): SettingInputs {
    for (const row of panelElement.querySelectorAll('.tone-mapping-row')) {
        if (row.firstElementChild?.textContent !== label) {
            continue;
        }
        const rangeInput = row.querySelector<HTMLInputElement>('input[type="range"]');
        const numberInput = row.querySelector<HTMLInputElement>('input[type="number"]');
        if (rangeInput !== null && numberInput !== null) {
            return { numberInput, rangeInput };
        }
    }
    throw new Error(`missing-row: ${label}`);
}

/** Types a value into a number input and commits it, which fires change. */
function commitNumber(input: HTMLInputElement, value: number): void {
    input.value = String(value);
    input.dispatchEvent(new Event('change'));
}

describe('ToneMappingPanel', () => {
    it('shows the engine defaults, and sends a changed setting', () => {
        const context = createFakePanelContext();
        const panel = createToneMappingPanel(context);
        const exposureInputs = findSettingInputs(panel.element, EXPOSURE_LABEL);
        expect(exposureInputs.numberInput.value).toBe(String(DEFAULT_SETTINGS.toneMapping.exposure));

        commitNumber(exposureInputs.numberInput, RAISED_EXPOSURE);
        expect(context.session.setRenderSettings).toHaveBeenCalledWith({
            ...DEFAULT_SETTINGS,
            toneMapping: { ...DEFAULT_SETTINGS.toneMapping, exposure: RAISED_EXPOSURE }
        });
        expect(exposureInputs.rangeInput.value).toBe(String(RAISED_EXPOSURE));
    });

    it('keeps settings the engine rejects from the session, shows its reason, and restores the control', () => {
        const context = createFakePanelContext();
        const panel = createToneMappingPanel(context);
        const paperWhiteInputs = findSettingInputs(panel.element, PAPER_WHITE_LABEL);

        commitNumber(paperWhiteInputs.numberInput, PAPER_WHITE_ABOVE_PEAK_NITS);
        expect(context.session.setRenderSettings).not.toHaveBeenCalled();
        const validationElement = panel.element.querySelector<HTMLElement>('.tone-mapping-validation');
        expect(validationElement?.hidden).toBe(false);
        expect(validationElement?.textContent).toBe(PAPER_WHITE_REJECTION);
        expect(paperWhiteInputs.numberInput.value).toBe(String(DEFAULT_SETTINGS.toneMapping.paperWhiteNits));
    });

    it('follows the presenter settings and HDR output, and sends the HDR output toggle', () => {
        const context = createFakePanelContext();
        const panel = createToneMappingPanel(context);
        const presenterSettings = createHDRToSDRRenderSettings({ toneMapping: { exposure: PRESENTER_EXPOSURE } });
        context.store.setState((state) => ({ presentation: { ...state.presentation, hdrOutput: true, renderSettings: presenterSettings } }));

        expect(findSettingInputs(panel.element, EXPOSURE_LABEL).numberInput.value).toBe(String(PRESENTER_EXPOSURE));
        expect(panel.element.querySelector('.tone-mapping-mode')?.textContent).toBe(presenterSettings.mode);
        const hdrOutputInput = panel.element.querySelector<HTMLInputElement>('input[type="checkbox"]');
        expect(hdrOutputInput?.checked).toBe(true);

        // A click fires change only on a connected checkbox
        document.body.append(panel.element);
        hdrOutputInput?.click();
        panel.element.remove();
        expect(vi.mocked(context.session.setHDROutputEnabled)).toHaveBeenCalledWith(false);
    });
});
