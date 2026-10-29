// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
    matchesNativeAudioChannelTones,
    NATIVE_AUDIO_CHANNEL_TONE_ANALYSIS_FRAME_COUNT
} from 'webgpu-player/capability/NativeAudioChannelTones';
import { NATIVE_SEVEN_POINT_ONE_AUDIO_CAPABILITY_VECTOR_CHANNEL_TONES } from 'webgpu-player/capability/vectors/NativeSevenPointOneAudioCapabilityVectors';

const SAMPLE_RATE = 48_000;
const FRAME_COUNT = 4_096;
const SOURCE_AMPLITUDE = 0.25;
const TONES = NATIVE_SEVEN_POINT_ONE_AUDIO_CAPABILITY_VECTOR_CHANNEL_TONES;
// Where each layout puts the WAVE 7.1 source channels FL, FR, FC, LFE, BL, BR, SL, SR
const VORBIS_AND_OPUS_ORDER = [ 0, 2, 1, 6, 7, 4, 5, 3 ];
// A decoder reading the side pair as the front-center pair of 7.1(wide) moves it before the back pair
const WIDE_ORDER = [ 0, 1, 2, 3, 6, 7, 4, 5 ];

function createTone(frequency: number, amplitude: number, frameCount = FRAME_COUNT): Float32Array {
    const samples = new Float32Array(frameCount);
    for (let index = 0; index < frameCount; index += 1) {
        samples[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE);
    }
    return samples;
}

/** Decoded planes carrying the source channels in the given order, each source channel at its own amplitude. */
function createPlanes(order: readonly number[], amplitudes: readonly number[] = TONES.map(() => SOURCE_AMPLITUDE)): Float32Array[] {
    return order.map((sourceChannel: number): Float32Array => createTone(TONES[sourceChannel].frequency, amplitudes[sourceChannel]));
}

const WAVE_ORDER = [ 0, 1, 2, 3, 4, 5, 6, 7 ];

describe('matchesNativeAudioChannelTones', () => {
    it('accepts planes in WAVE 7.1 order', () => {
        expect(matchesNativeAudioChannelTones(createPlanes(WAVE_ORDER), SAMPLE_RATE, TONES)).toBe(true);
    });

    it('accepts a strongly attenuated LFE, and refuses one below its floor', () => {
        const attenuated = TONES.map((_tone, index: number): number => (index === 3 ? 0.03 : SOURCE_AMPLITUDE));
        const silentLFE = TONES.map((_tone, index: number): number => (index === 3 ? 0.01 : SOURCE_AMPLITUDE));

        expect(matchesNativeAudioChannelTones(createPlanes(WAVE_ORDER, attenuated), SAMPLE_RATE, TONES)).toBe(true);
        expect(matchesNativeAudioChannelTones(createPlanes(WAVE_ORDER, silentLFE), SAMPLE_RATE, TONES)).toBe(false);
    });

    it.each([
        [ 'Vorbis and Opus', VORBIS_AND_OPUS_ORDER ],
        [ '7.1(wide)', WIDE_ORDER ],
        [ 'swapped center and LFE', [ 0, 1, 3, 2, 4, 5, 6, 7 ] ],
        [ 'swapped left and right', [ 1, 0, 2, 3, 4, 5, 6, 7 ] ]
    ])('refuses planes in %s order', (_name, order) => {
        expect(matchesNativeAudioChannelTones(createPlanes(order), SAMPLE_RATE, TONES)).toBe(false);
    });

    it('refuses six planes, and nine', () => {
        expect(matchesNativeAudioChannelTones(createPlanes(WAVE_ORDER).slice(0, 6), SAMPLE_RATE, TONES)).toBe(false);
        expect(matchesNativeAudioChannelTones([ ...createPlanes(WAVE_ORDER), new Float32Array(FRAME_COUNT) ], SAMPLE_RATE, TONES)).toBe(false);
    });

    it('refuses silence', () => {
        const silence = TONES.map(() => new Float32Array(FRAME_COUNT));

        expect(matchesNativeAudioChannelTones(silence, SAMPLE_RATE, TONES)).toBe(false);
    });

    it('refuses a plane that mixes another channel in without a clear margin', () => {
        const planes = createPlanes(WAVE_ORDER);
        const leak = createTone(TONES[6].frequency, SOURCE_AMPLITUDE / 5);
        for (let index = 0; index < FRAME_COUNT; index += 1) {
            planes[4][index] += leak[index];
        }

        expect(matchesNativeAudioChannelTones(planes, SAMPLE_RATE, TONES)).toBe(false);
    });

    it('refuses output shorter than the analysis window, or planes of unequal length', () => {
        const short = WAVE_ORDER.map((channel: number): Float32Array => (
            createTone(TONES[channel].frequency, SOURCE_AMPLITUDE, NATIVE_AUDIO_CHANNEL_TONE_ANALYSIS_FRAME_COUNT - 1)
        ));
        const unequal = createPlanes(WAVE_ORDER);
        unequal[7] = unequal[7].subarray(1);

        expect(matchesNativeAudioChannelTones(short, SAMPLE_RATE, TONES)).toBe(false);
        expect(matchesNativeAudioChannelTones(unequal, SAMPLE_RATE, TONES)).toBe(false);
    });

    it('refuses non-finite samples', () => {
        const planes = createPlanes(WAVE_ORDER);
        planes[0][FRAME_COUNT / 2] = Number.NaN;

        expect(matchesNativeAudioChannelTones(planes, SAMPLE_RATE, TONES)).toBe(false);
    });
});
