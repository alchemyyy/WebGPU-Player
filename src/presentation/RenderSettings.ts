import { requireSettingRange } from '../color/ColorMetadata';

export const RENDER_SETTINGS_VERSION = 7;
export const RENDER_SETTINGS_UNIFORM_BYTE_LENGTH = 144;

export const HDR_RENDER_SETTING_RANGES = Object.freeze({
    brightness: Object.freeze({ maximum: 1, minimum: -1, step: 0.01 }),
    contrast: Object.freeze({ maximum: 4, minimum: 0, step: 0.01 }),
    desaturationStrength: Object.freeze({ maximum: 1, minimum: 0, step: 0.01 }),
    exposure: Object.freeze({ maximum: 16, minimum: -16, step: 0.1 }),
    inputPeakNits: Object.freeze({ maximum: 10_000, minimum: 1, step: 1 }),
    outputPeakNits: Object.freeze({ maximum: 10_000, minimum: 1, step: 1 }),
    paperWhiteNits: Object.freeze({ maximum: 10_000, minimum: 1, step: 1 }),
    saturation: Object.freeze({ maximum: 4, minimum: 0, step: 0.01 })
});

export type RenderMode = 'hdr-to-sdr' | 'identity-sdr';
// The configured WebGPU canvas uses the sRGB output color space
export type OutputTransfer = 'srgb';
export type ToneMapOperator = 'aces' | 'reinhard' | 'spline';

export type ToneMappingSettings = {
    desaturationStrength: number
    exposure: number
    inputPeakNits: number
    operator: ToneMapOperator
    outputPeakNits: number
    paperWhiteNits: number
};

export type DisplaySettings = {
    brightness: number
    contrast: number
    saturation: number
};

export type IdentitySDRRenderSettings = {
    mode: 'identity-sdr'
    version: typeof RENDER_SETTINGS_VERSION
};

export type HDRToSDRRenderSettings = {
    display: DisplaySettings
    mode: 'hdr-to-sdr'
    outputTransfer: OutputTransfer
    toneMapping: ToneMappingSettings
    version: typeof RENDER_SETTINGS_VERSION
};

export type RenderSettings = HDRToSDRRenderSettings | IdentitySDRRenderSettings;

export type HDRToSDRRenderSettingsOverrides = {
    display?: Partial<DisplaySettings>
    outputTransfer?: OutputTransfer
    toneMapping?: Partial<ToneMappingSettings>
};

export type HDR10PlusFrameRenderSettings = Readonly<{
    averageNits: number
    inputPeakNits: number
    /** Read only with a curve; HDR10+ profile A, which has none, leaves it 0. */
    targetedSystemDisplayMaximumLuminanceNits: number
    toneMapping: Readonly<{
        bezierCurveAnchors: readonly number[]
        kneePointX: number
        kneePointY: number
    }> | null
}>;

const DEFAULT_TONE_MAPPING_SETTINGS: ToneMappingSettings = {
    desaturationStrength: 0.25,
    exposure: 0,
    inputPeakNits: 1_000,
    operator: 'reinhard',
    outputPeakNits: 100,
    paperWhiteNits: 203
};

const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
    brightness: 0,
    contrast: 1,
    saturation: 1
};

const ACES_OPERATOR_CODE = 0;
const REINHARD_OPERATOR_CODE = 1;
const SPLINE_OPERATOR_CODE = 2;
const SRGB_OUTPUT_TRANSFER_CODE = 1;

const UNIFORM_VERSION_INDEX = 0;
const UNIFORM_OPERATOR_INDEX = 1;
const UNIFORM_OUTPUT_TRANSFER_INDEX = 2;
const UNIFORM_DYNAMIC_MODE_INDEX = 3;
const UNIFORM_DESATURATION_INDEX = 4;
const UNIFORM_EXPOSURE_INDEX = 5;
const UNIFORM_INPUT_PEAK_INDEX = 6;
const UNIFORM_OUTPUT_PEAK_INDEX = 7;
const UNIFORM_PAPER_WHITE_INDEX = 8;
const UNIFORM_BRIGHTNESS_INDEX = 9;
const UNIFORM_CONTRAST_INDEX = 10;
const UNIFORM_SATURATION_INDEX = 11;
const UNIFORM_DYNAMIC_SCENE_AVERAGE_INDEX = 12;
const UNIFORM_DYNAMIC_TARGET_PEAK_INDEX = 13;
const UNIFORM_DYNAMIC_KNEE_X_INDEX = 14;
const UNIFORM_DYNAMIC_KNEE_Y_INDEX = 15;
const UNIFORM_DYNAMIC_ANCHOR_COUNT_INDEX = 16;
const UNIFORM_DYNAMIC_ANCHOR_START_INDEX = 20;
const MAXIMUM_DYNAMIC_ANCHOR_COUNT = 15;

/** Throws unless a setting is finite and inside its HDR_RENDER_SETTING_RANGES range. */
function requireHDRSettingRange(name: keyof typeof HDR_RENDER_SETTING_RANGES, value: number): void {
    const range = HDR_RENDER_SETTING_RANGES[name];
    requireSettingRange(name, value, range.minimum, range.maximum);
}

/** Throws `<field>: <value> <problem>` when renderer settings cannot produce a deterministic color transform. */
export function assertValidRenderSettings(settings: RenderSettings): void {
    if (settings.version !== RENDER_SETTINGS_VERSION) {
        throw new RangeError(`settings version: ${settings.version}, expected ${RENDER_SETTINGS_VERSION}`);
    }

    switch (settings.mode) {
        case 'identity-sdr':
            return;
        case 'hdr-to-sdr':
            break;
        default:
            throw new RangeError(`mode: unsupported '${String((settings as { mode: unknown }).mode)}'`);
    }

    if (settings.outputTransfer !== 'srgb') {
        throw new RangeError(`outputTransfer: unsupported '${String(settings.outputTransfer)}'`);
    }
    switch (settings.toneMapping.operator) {
        case 'aces':
        case 'reinhard':
        case 'spline':
            break;
        default:
            throw new RangeError(`operator: unsupported '${String(settings.toneMapping.operator)}'`);
    }

    const toneMapping = settings.toneMapping;
    requireHDRSettingRange('inputPeakNits', toneMapping.inputPeakNits);
    requireHDRSettingRange('outputPeakNits', toneMapping.outputPeakNits);
    requireHDRSettingRange('paperWhiteNits', toneMapping.paperWhiteNits);
    if (toneMapping.paperWhiteNits > toneMapping.inputPeakNits) {
        throw new RangeError(`paperWhiteNits: ${toneMapping.paperWhiteNits} above inputPeakNits ${toneMapping.inputPeakNits}`);
    }
    requireHDRSettingRange('exposure', toneMapping.exposure);
    requireHDRSettingRange('desaturationStrength', toneMapping.desaturationStrength);
    requireHDRSettingRange('brightness', settings.display.brightness);
    requireHDRSettingRange('contrast', settings.display.contrast);
    requireHDRSettingRange('saturation', settings.display.saturation);
}

/** Returns independent identity settings for a new presentation session. */
export function createDefaultRenderSettings(): IdentitySDRRenderSettings {
    return {
        mode: 'identity-sdr',
        version: RENDER_SETTINGS_VERSION
    };
}

/** Returns independent HDR-to-SDR settings with validated overrides. */
export function createHDRToSDRRenderSettings(overrides: HDRToSDRRenderSettingsOverrides = {}): HDRToSDRRenderSettings {
    const display: DisplaySettings = {
        ...DEFAULT_DISPLAY_SETTINGS,
        ...overrides.display
    };
    const toneMapping: ToneMappingSettings = {
        ...DEFAULT_TONE_MAPPING_SETTINGS,
        ...overrides.toneMapping
    };
    const settings: HDRToSDRRenderSettings = {
        display,
        mode: 'hdr-to-sdr',
        outputTransfer: overrides.outputTransfer ?? 'srgb',
        toneMapping,
        version: RENDER_SETTINGS_VERSION
    };
    assertValidRenderSettings(settings);
    return settings;
}

function getToneMapOperatorCode(operator: ToneMapOperator): number {
    switch (operator) {
        case 'aces':
            return ACES_OPERATOR_CODE;
        case 'reinhard':
            return REINHARD_OPERATOR_CODE;
        case 'spline':
            return SPLINE_OPERATOR_CODE;
    }
}

function getOutputTransferCode(outputTransfer: OutputTransfer): number {
    if (outputTransfer !== 'srgb') {
        throw new RangeError(`outputTransfer: unsupported '${String(outputTransfer)}'`);
    }
    return SRGB_OUTPUT_TRANSFER_CODE;
}

/** Throws `dynamic <field>: <value> <problem>` when one frame's HDR10+ settings cannot drive the tone mapper. */
function assertValidDynamicFrameSettings(settings: HDRToSDRRenderSettings, dynamicFrameSettings: HDR10PlusFrameRenderSettings): void {
    const toneMapping = dynamicFrameSettings.toneMapping;
    const anchors = toneMapping?.bezierCurveAnchors ?? [];
    requireSettingRange(
        'dynamic inputPeakNits',
        dynamicFrameSettings.inputPeakNits,
        settings.toneMapping.paperWhiteNits,
        HDR_RENDER_SETTING_RANGES.inputPeakNits.maximum
    );
    requireSettingRange('dynamic averageNits', dynamicFrameSettings.averageNits, 0, dynamicFrameSettings.inputPeakNits);
    if (anchors.length > MAXIMUM_DYNAMIC_ANCHOR_COUNT) {
        throw new RangeError(`dynamic anchors: ${anchors.length} above ${MAXIMUM_DYNAMIC_ANCHOR_COUNT}`);
    }
    for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex += 1) {
        requireSettingRange(`dynamic anchor ${anchorIndex}`, anchors[anchorIndex], 0, 1);
    }
    // Only the curve adapts from the targeted display; the scene statistics mode never reads it
    if (toneMapping === null) {
        return;
    }
    requireSettingRange(
        'dynamic targetedSystemDisplayMaximumLuminanceNits',
        dynamicFrameSettings.targetedSystemDisplayMaximumLuminanceNits,
        HDR_RENDER_SETTING_RANGES.outputPeakNits.minimum,
        HDR_RENDER_SETTING_RANGES.outputPeakNits.maximum
    );
    requireSettingRange('dynamic kneePointX', toneMapping.kneePointX, 0, 1);
    requireSettingRange('dynamic kneePointY', toneMapping.kneePointY, 0, 1);
    if (anchors.length === 0) {
        throw new RangeError('dynamic anchors: none for a curve');
    }
}

/** Serializes adjustable renderer controls into the versioned WGSL layout. */
export function createRenderSettingsUniformData(
    settings: HDRToSDRRenderSettings,
    dynamicFrameSettings: HDR10PlusFrameRenderSettings | null = null
): Uint8Array<ArrayBuffer> {
    assertValidRenderSettings(settings);

    const buffer = new ArrayBuffer(RENDER_SETTINGS_UNIFORM_BYTE_LENGTH);
    const integerValues = new Uint32Array(buffer);
    const floatValues = new Float32Array(buffer);
    integerValues[UNIFORM_VERSION_INDEX] = settings.version;
    integerValues[UNIFORM_OPERATOR_INDEX] = getToneMapOperatorCode(settings.toneMapping.operator);
    integerValues[UNIFORM_OUTPUT_TRANSFER_INDEX] = getOutputTransferCode(settings.outputTransfer);
    floatValues[UNIFORM_DESATURATION_INDEX] = settings.toneMapping.desaturationStrength;
    floatValues[UNIFORM_EXPOSURE_INDEX] = settings.toneMapping.exposure;
    floatValues[UNIFORM_INPUT_PEAK_INDEX] = settings.toneMapping.inputPeakNits;
    floatValues[UNIFORM_OUTPUT_PEAK_INDEX] = settings.toneMapping.outputPeakNits;
    floatValues[UNIFORM_PAPER_WHITE_INDEX] = settings.toneMapping.paperWhiteNits;
    floatValues[UNIFORM_BRIGHTNESS_INDEX] = settings.display.brightness;
    floatValues[UNIFORM_CONTRAST_INDEX] = settings.display.contrast;
    floatValues[UNIFORM_SATURATION_INDEX] = settings.display.saturation;
    if (dynamicFrameSettings) {
        assertValidDynamicFrameSettings(settings, dynamicFrameSettings);
        const toneMapping = dynamicFrameSettings.toneMapping;
        const anchors = toneMapping?.bezierCurveAnchors ?? [];

        integerValues[UNIFORM_DYNAMIC_MODE_INDEX] = toneMapping ? 2 : 1;
        floatValues[UNIFORM_INPUT_PEAK_INDEX] = dynamicFrameSettings.inputPeakNits;
        floatValues[UNIFORM_DYNAMIC_SCENE_AVERAGE_INDEX] = dynamicFrameSettings.averageNits;
        floatValues[UNIFORM_DYNAMIC_TARGET_PEAK_INDEX] = toneMapping ? dynamicFrameSettings.targetedSystemDisplayMaximumLuminanceNits : 0;
        floatValues[UNIFORM_DYNAMIC_KNEE_X_INDEX] = toneMapping?.kneePointX ?? 0;
        floatValues[UNIFORM_DYNAMIC_KNEE_Y_INDEX] = toneMapping?.kneePointY ?? 0;
        integerValues[UNIFORM_DYNAMIC_ANCHOR_COUNT_INDEX] = anchors.length;
        for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex += 1) {
            floatValues[UNIFORM_DYNAMIC_ANCHOR_START_INDEX + anchorIndex] = anchors[anchorIndex];
        }
    }
    return new Uint8Array(buffer);
}
