import {
    assertValidInputColorMetadata,
    createPQColorMetadata,
    type InputColorMetadata
} from '../../../color/ColorMetadata';
import { assertValidRenderSettings, type RenderSettings } from '../../RenderSettings';
import type { BuiltinChain, BuiltinChainConfiguration, SignalDefinition } from '../PassTypes';
import { BUILTIN_COLOR_FUNCTION_NAMES, createBuiltinColorFunctions, createSignalLinearLight } from './BuiltinColorFunctions';
import {
    createExternalDolbyVisionSignal,
    createExternalHDRSignal,
    createExternalIdentitySignal,
    createRawDolbyVisionSignal,
    createRawYUVSignal
} from './BuiltinSignals';

// Dolby Vision reconstruction produces full-range BT.2020 PQ, which the color track decodes
const DOLBY_VISION_OUTPUT_METADATA = createPQColorMetadata({ range: 'full' });

/** Pairs a signal with the default color functions and the transfer function of its metadata; identity SDR settings present the signal unchanged. */
function createColorTrackChain(
    signal: SignalDefinition,
    metadata: InputColorMetadata,
    settings: RenderSettings,
    hdrOutput: boolean
): BuiltinChain {
    assertValidInputColorMetadata(metadata);
    assertValidRenderSettings(settings);
    const linearLight = createSignalLinearLight(metadata);
    if (settings.mode === 'identity-sdr') {
        // The legacy identity processColor returned its input unchanged, without dither
        return { colorFunctions: [], linearLight, signal, sourceIsDisplay: true };
    }
    return { colorFunctions: createBuiltinColorFunctions(metadata, hdrOutput), linearLight, signal, sourceIsDisplay: false };
}

/** Builds a route's built-in chain: its fixed signal and its default color functions, with the legacy fused shader's math in its order. */
export function createBuiltinChain(configuration: BuiltinChainConfiguration): BuiltinChain {
    switch (configuration.route) {
        case 'external-identity':
            return {
                colorFunctions: [],
                linearLight: configuration.metadata === null ? null : createSignalLinearLight(configuration.metadata),
                signal: createExternalIdentitySignal(configuration.metadata, configuration.chromaSubsampling ?? null),
                sourceIsDisplay: true
            };
        case 'external-hdr':
            return createColorTrackChain(
                createExternalHDRSignal(configuration.metadata, configuration.chromaSubsampling ?? null),
                configuration.metadata,
                configuration.settings,
                configuration.hdrOutput
            );
        case 'external-dolby-vision':
            return createColorTrackChain(
                createExternalDolbyVisionSignal(),
                DOLBY_VISION_OUTPUT_METADATA,
                configuration.settings,
                configuration.hdrOutput
            );
        case 'raw-yuv':
            return createColorTrackChain(
                createRawYUVSignal(configuration.format, configuration.metadata, configuration.interlacedChroma === true),
                configuration.metadata,
                configuration.settings,
                configuration.hdrOutput
            );
        case 'raw-dolby-vision':
            return createColorTrackChain(
                createRawDolbyVisionSignal(configuration.format, configuration.profile, configuration.felReconstruction),
                DOLBY_VISION_OUTPUT_METADATA,
                configuration.settings,
                configuration.hdrOutput
            );
        case 'frame-pool':
            // The GPU decode route supplies the signal, and the color track is the raw YUV route's
            return createColorTrackChain(
                configuration.interlacedChroma === true && configuration.interlacedSignal ? configuration.interlacedSignal : configuration.signal,
                configuration.metadata,
                configuration.settings,
                configuration.hdrOutput
            );
    }
}

/** Returns the built-in color function names in color-track order, which a user color pass's `replaces` may name. */
export function getBuiltinColorFunctionNames(): readonly string[] {
    return BUILTIN_COLOR_FUNCTION_NAMES;
}
