import { describe, expect, it } from 'vitest';

import {
    isSupportedCustomAudioSampleRate,
    requireSupportedCustomAudioSampleRate
} from 'webgpu-player/audio/CustomAudioSampleRate';

const SAMPLE_RATE_LABEL = 'Source sample rate';
const SAMPLE_RATE_ERROR_MESSAGE = `${SAMPLE_RATE_LABEL} must be a positive integer number of Hz`;

// Valid source rates, from 1 Hz to past Chromium's own decoder range of 3 kHz through 768 kHz
const LOWEST_SAMPLE_RATE = 1;
const BELOW_CHROMIUM_DECODER_SAMPLE_RATE = 2_000;
const AAC_LOWEST_SAMPLE_RATE = 7_350;
const IRREGULAR_SAMPLE_RATE = 12_345;
const CD_SAMPLE_RATE = 44_100;
const STUDIO_SAMPLE_RATE = 96_000;
const HDMI_HIGHEST_SAMPLE_RATE = 192_000;
const DXD_SAMPLE_RATE = 352_800;
const CHROMIUM_DECODER_HIGHEST_SAMPLE_RATE = 768_000;
const ABOVE_CHROMIUM_DECODER_SAMPLE_RATE = 1_536_000;

// Malformed decoder or container rates
const ZERO_SAMPLE_RATE = 0;
const NEGATIVE_SAMPLE_RATE = -48_000;
const FRACTIONAL_SAMPLE_RATE = 48_000.5;
const TEXT_SAMPLE_RATE = '48000';

describe('CustomAudioSampleRate', () => {
    it.each([
        LOWEST_SAMPLE_RATE,
        BELOW_CHROMIUM_DECODER_SAMPLE_RATE,
        AAC_LOWEST_SAMPLE_RATE,
        IRREGULAR_SAMPLE_RATE,
        CD_SAMPLE_RATE,
        STUDIO_SAMPLE_RATE,
        HDMI_HIGHEST_SAMPLE_RATE,
        DXD_SAMPLE_RATE,
        CHROMIUM_DECODER_HIGHEST_SAMPLE_RATE,
        ABOVE_CHROMIUM_DECODER_SAMPLE_RATE
    ])('accepts integer source rate %d', sampleRate => {
        expect(isSupportedCustomAudioSampleRate(sampleRate)).toBe(true);
        expect(requireSupportedCustomAudioSampleRate(sampleRate, SAMPLE_RATE_LABEL))
            .toBe(sampleRate);
    });

    it.each([
        ZERO_SAMPLE_RATE,
        NEGATIVE_SAMPLE_RATE,
        FRACTIONAL_SAMPLE_RATE,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        TEXT_SAMPLE_RATE,
        null
    ])('rejects malformed sample rate %s', sampleRate => {
        expect(isSupportedCustomAudioSampleRate(sampleRate)).toBe(false);
        expect(() => requireSupportedCustomAudioSampleRate(sampleRate, SAMPLE_RATE_LABEL))
            .toThrow(SAMPLE_RATE_ERROR_MESSAGE);
    });
});
