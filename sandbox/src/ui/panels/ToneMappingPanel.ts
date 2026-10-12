// The tone mapping controls: the HDR-to-SDR render settings over the engine's ranges, and HDR output.
import {
    assertValidRenderSettings,
    createHDRToSDRRenderSettings,
    HDR_RENDER_SETTING_RANGES,
    type HDRToSDRRenderSettings,
    type RenderSettings,
    type ToneMapOperator
} from 'webgpu-player/presentation/RenderSettings';

import type { SandboxState } from '../../contracts/SandboxContracts';
import { reportCommandRejection } from '../commands';
import { createElement } from '../dom';
import type { Panel, PanelContext } from '../Panel';
import { subscribeSelection } from '../Store';
import { createChoiceSelect, listRecordChoices } from './ChoiceSelect';

import './ToneMappingPanel.css';

type RangedSettingName = keyof typeof HDR_RENDER_SETTING_RANGES;

type RangedSettingControl = Readonly<{
    name: RangedSettingName
    numberInput: HTMLInputElement
    rangeInput: HTMLInputElement
}>;

// The ranged settings in panel order, with their labels; the record type makes the list cover every range the engine declares
const RANGED_SETTING_LABELS: Readonly<Record<RangedSettingName, string>> = {
    exposure: 'Exposure',
    inputPeakNits: 'Input peak nits',
    outputPeakNits: 'Output peak nits',
    paperWhiteNits: 'Paper white nits',
    desaturationStrength: 'Desaturation',
    brightness: 'Brightness',
    contrast: 'Contrast',
    saturation: 'Saturation'
};
const TONE_MAP_OPERATOR_LABELS: Readonly<Record<ToneMapOperator, string>> = {
    aces: 'ACES',
    reinhard: 'Reinhard',
    spline: 'Spline'
};
// The mode line before the presenter reports settings
const NO_PRESENTER_MODE = 'none';

/** Returns one ranged setting's value. */
function readRangedSetting(settings: HDRToSDRRenderSettings, name: RangedSettingName): number {
    switch (name) {
        case 'brightness':
        case 'contrast':
        case 'saturation':
            return settings.display[name];
        case 'desaturationStrength':
        case 'exposure':
        case 'inputPeakNits':
        case 'outputPeakNits':
        case 'paperWhiteNits':
            return settings.toneMapping[name];
    }
}

/** Returns new settings with one ranged setting replaced. */
function withRangedSetting(settings: HDRToSDRRenderSettings, name: RangedSettingName, value: number): HDRToSDRRenderSettings {
    switch (name) {
        case 'brightness':
        case 'contrast':
        case 'saturation':
            return { ...settings, display: { ...settings.display, [name]: value } };
        case 'desaturationStrength':
        case 'exposure':
        case 'inputPeakNits':
        case 'outputPeakNits':
        case 'paperWhiteNits':
            return { ...settings, toneMapping: { ...settings.toneMapping, [name]: value } };
    }
}

export function createToneMappingPanel(context: PanelContext): Panel {
    const { session, store } = context;
    // The settings the controls show: the presenter's while it tone-maps, else the last ones sent, or the engine's defaults
    let settings: HDRToSDRRenderSettings = createHDRToSDRRenderSettings();
    const controls: RangedSettingControl[] = [];

    const modeElement = createElement('span', { className: 'tone-mapping-mode' });
    const resetButton = createElement('button', { text: 'Reset' });
    const hdrOutputInput = createElement('input', { attributes: { type: 'checkbox' } });
    const validationElement = createElement('div', { className: 'tone-mapping-validation' });
    validationElement.hidden = true;

    const renderControls = (): void => {
        operatorSelect.setValue(settings.toneMapping.operator);
        for (const control of controls) {
            const value = String(readRangedSetting(settings, control.name));
            control.rangeInput.value = value;
            control.numberInput.value = value;
        }
    };

    /** Sends settings the engine accepts; settings it rejects show its terse reason, and the controls return to the current settings. */
    const applySettings = (nextSettings: HDRToSDRRenderSettings): void => {
        try {
            assertValidRenderSettings(nextSettings);
        } catch (error) {
            validationElement.textContent = error instanceof Error ? error.message : String(error);
            validationElement.hidden = false;
            renderControls();
            return;
        }
        validationElement.hidden = true;
        settings = nextSettings;
        session.setRenderSettings(nextSettings);
        renderControls();
    };

    const operatorSelect = createChoiceSelect<ToneMapOperator>((operator: ToneMapOperator): void => {
        applySettings({ ...settings, toneMapping: { ...settings.toneMapping, operator } });
    });
    operatorSelect.setChoices(listRecordChoices(TONE_MAP_OPERATOR_LABELS));

    const rows: HTMLElement[] = [];
    for (const [ settingName, label ] of Object.entries(RANGED_SETTING_LABELS)) {
        const name = settingName as RangedSettingName;
        const range = HDR_RENDER_SETTING_RANGES[name];
        const rangeAttributes: Readonly<Record<string, string>> = {
            max: String(range.maximum),
            min: String(range.minimum),
            step: String(range.step)
        };
        const rangeInput = createElement('input', { attributes: { ...rangeAttributes, type: 'range' } });
        const numberInput = createElement('input', { attributes: { ...rangeAttributes, type: 'number' } });
        // The slider applies while it moves; typed values apply once committed
        rangeInput.addEventListener('input', (): void => {
            applySettings(withRangedSetting(settings, name, rangeInput.valueAsNumber));
        });
        numberInput.addEventListener('change', (): void => {
            applySettings(withRangedSetting(settings, name, numberInput.valueAsNumber));
        });
        controls.push({ name, numberInput, rangeInput });
        rows.push(createElement('label', { className: 'tone-mapping-row' }, [ createElement('span', { text: label }), rangeInput, numberInput ]));
    }

    resetButton.addEventListener('click', (): void => {
        applySettings(createHDRToSDRRenderSettings());
    });
    hdrOutputInput.addEventListener('change', (): void => {
        session.setHDROutputEnabled(hdrOutputInput.checked).catch((error: unknown): void => {
            reportCommandRejection(error);
            hdrOutputInput.checked = store.getState().presentation.hdrOutput;
        });
    });

    const element = createElement('section', { className: 'tone-mapping-panel' }, [
        createElement('header', { className: 'tone-mapping-header' }, [ createElement('span', { text: 'Tone mapping' }), modeElement, resetButton ]),
        createElement('label', { className: 'tone-mapping-toggle' }, [ hdrOutputInput, createElement('span', { text: 'HDR output' }) ]),
        createElement('label', { className: 'tone-mapping-row' }, [ createElement('span', { text: 'Operator' }), operatorSelect.element ]),
        ...rows,
        validationElement
    ]);

    const unsubscribers: (() => void)[] = [
        subscribeSelection(store, (state: SandboxState): RenderSettings | null => state.presentation.renderSettings, (renderSettings: RenderSettings | null): void => {
            modeElement.textContent = renderSettings?.mode ?? NO_PRESENTER_MODE;
            if (renderSettings?.mode === 'hdr-to-sdr') {
                settings = renderSettings;
            }
            renderControls();
        }),
        subscribeSelection(store, (state: SandboxState): boolean => state.presentation.hdrOutput, (hdrOutput: boolean): void => {
            hdrOutputInput.checked = hdrOutput;
        })
    ];

    return {
        destroy: (): void => {
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }
        },
        element
    };
}
