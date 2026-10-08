import { describe, expect, it } from 'vitest';

import {
    assertSupportedCustomAudioOutputLayout,
    CUSTOM_NON_SURROUND_INPUT_CHANNEL_COUNTS,
    CUSTOM_SURROUND_INPUT_CHANNEL_COUNT,
    CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT,
    CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE,
    getSupportedCustomAudioInputChannelCounts,
    isCustomMediabunnyPCMAudioCodec,
    isMediabunnyPCMDecoderCodec,
    isSupportedCustomAudioInputLayout,
    isSupportedCustomAudioInputMetadataLayout,
    isSupportedCustomAudioOutputLayout
} from 'webgpu-player/audio/CustomAudioOutputPolicy';

describe('CustomAudioOutputPolicy', () => {
    it('accepts only the measured stereo and native multichannel 48 kHz layouts', () => {
        expect(isSupportedCustomAudioOutputLayout(
            CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT,
            CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE
        )).toBe(true);
        expect(isSupportedCustomAudioOutputLayout(6, 48_000)).toBe(true);
        expect(isSupportedCustomAudioOutputLayout(8, 48_000)).toBe(true);

        expect(isSupportedCustomAudioOutputLayout(1, 48_000)).toBe(false);
        expect(isSupportedCustomAudioOutputLayout(7, 48_000)).toBe(false);
        expect(isSupportedCustomAudioOutputLayout(2, 44_100)).toBe(false);
        expect(isSupportedCustomAudioOutputLayout('2', 48_000)).toBe(false);
        expect(isSupportedCustomAudioOutputLayout(2, '48000')).toBe(false);
    });

    it('rejects unsupported layouts with a stable diagnostic', () => {
        expect(() => assertSupportedCustomAudioOutputLayout(7, 48_000)).toThrow(
            'Custom audio output requires 2, 6, or 8 channels at 48000 Hz'
        );
    });

    it('accepts mono, 3.0, and the implemented 5.1 downmix input layouts', () => {
        for (const codec of [
            'aac',
            'flac',
            'opus',
            'vorbis'
        ] as const) {
            expect(getSupportedCustomAudioInputChannelCounts(codec)).toEqual([
                1,
                CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT,
                3,
                CUSTOM_SURROUND_INPUT_CHANNEL_COUNT
            ]);
            expect(isSupportedCustomAudioInputLayout(codec, 1, 24_000)).toBe(true);
            expect(isSupportedCustomAudioInputLayout(codec, 3, 48_000)).toBe(true);
            expect(isSupportedCustomAudioInputLayout(codec, 6, 48_000)).toBe(true);
            expect(isSupportedCustomAudioInputLayout(codec, 4, 48_000)).toBe(false);
        }
        // Jellyfin reports AC-3 2/1 and 3/0 alike as 3.0, so three-channel AC-3 transcodes
        expect(getSupportedCustomAudioInputChannelCounts('ac3')).toEqual([
            1,
            CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT,
            CUSTOM_SURROUND_INPUT_CHANNEL_COUNT
        ]);
        expect(isSupportedCustomAudioInputLayout('ac3', 1, 48_000)).toBe(true);
        expect(isSupportedCustomAudioInputLayout('ac3', 3, 48_000)).toBe(false);
        expect(isSupportedCustomAudioInputLayout('ac3', 6, 48_000)).toBe(true);
        expect(getSupportedCustomAudioInputChannelCounts('mp3')).toEqual([ 1, 2 ]);
        expect(getSupportedCustomAudioInputChannelCounts('mp3'))
            .toBe(CUSTOM_NON_SURROUND_INPUT_CHANNEL_COUNTS);
        expect(isSupportedCustomAudioInputLayout('mp3', 1, 22_050)).toBe(true);
        expect(isSupportedCustomAudioInputLayout('mp3', 6, 48_000)).toBe(false);
        expect(getSupportedCustomAudioInputChannelCounts('eac3')).toEqual([ 1, 2, 6, 8 ]);
        expect(isSupportedCustomAudioInputLayout('eac3', 1, 48_000)).toBe(true);
        expect(isSupportedCustomAudioInputLayout('eac3', 3, 48_000)).toBe(false);
        expect(isSupportedCustomAudioInputLayout('eac3', 2, 48_000)).toBe(true);
        expect(isSupportedCustomAudioInputLayout('eac3', 6, 48_000)).toBe(true);
        expect(isSupportedCustomAudioInputLayout('eac3', 8, 48_000)).toBe(true);
        expect(isSupportedCustomAudioInputLayout('eac3', 6, 44_100)).toBe(true);
        expect(isSupportedCustomAudioInputLayout('eac3', 6, 12_345)).toBe(true);
        expect(isSupportedCustomAudioInputLayout('eac3', 6, 192_001)).toBe(false);
        expect(isSupportedCustomAudioInputLayout('eac3', '6', 48_000)).toBe(false);
    });

    it('accepts measured and composed DTS channel beds at every bounded sample rate', () => {
        expect(getSupportedCustomAudioInputChannelCounts('dts')).toEqual([
            1,
            2,
            3,
            6,
            7,
            8
        ]);
        for (const [ channelCount, sampleRate ] of [
            [ 1, 48_000 ],
            [ 2, 48_000 ],
            [ 3, 48_000 ],
            [ 6, 48_000 ],
            [ 6, 12_345 ],
            [ 7, 44_100 ],
            [ 8, 96_000 ],
            [ 8, 192_000 ]
        ] as const) {
            expect(isSupportedCustomAudioInputLayout('dts', channelCount, sampleRate))
                .toBe(true);
        }
        expect(isSupportedCustomAudioInputLayout('dts', 4, 48_000)).toBe(false);
        expect(isSupportedCustomAudioInputLayout('dts', 8, 2_999)).toBe(false);
        expect(isSupportedCustomAudioInputLayout('dts', 8, 192_001)).toBe(false);
    });

    it('accepts vector and composed TrueHD channel-bed routes', () => {
        expect(getSupportedCustomAudioInputChannelCounts('truehd')).toEqual([ 1, 2, 6, 8 ]);
        for (const [ channelCount, sampleRate ] of [
            [ 1, 48_000 ],
            [ 1, 96_000 ],
            [ 2, 48_000 ],
            [ 2, 96_000 ],
            [ 6, 44_100 ],
            [ 6, 96_000 ],
            [ 6, 192_000 ],
            [ 8, 48_000 ]
        ] as const) {
            expect(isSupportedCustomAudioInputLayout('truehd', channelCount, sampleRate))
                .toBe(true);
        }
        expect(isSupportedCustomAudioInputLayout('truehd', 8, 96_000)).toBe(false);
        expect(isSupportedCustomAudioInputLayout('truehd', 3, 48_000)).toBe(false);
        expect(isSupportedCustomAudioInputLayout('truehd', 6, 192_001)).toBe(false);
        expect(getSupportedCustomAudioInputChannelCounts('mlp')).toEqual([ 1, 2 ]);
        expect(isSupportedCustomAudioInputLayout('mlp', 1, 48_000)).toBe(true);
        expect(isSupportedCustomAudioInputLayout('mlp', 2, 48_000)).toBe(true);
        expect(isSupportedCustomAudioInputLayout('mlp', 2, 12_345)).toBe(true);
        expect(isSupportedCustomAudioInputLayout('mlp', 6, 48_000)).toBe(false);
    });

    it('requires Jellyfin 3.0 metadata for three channels without a decoder speaker mask', () => {
        expect(isSupportedCustomAudioInputMetadataLayout('aac', 3, 48_000, '3.0')).toBe(true);
        expect(isSupportedCustomAudioInputMetadataLayout('flac', 3, 96_000, ' 3.0 ')).toBe(true);
        expect(isSupportedCustomAudioInputMetadataLayout('pcm_s16le', 3, 48_000, '3.0'))
            .toBe(true);
        expect(isSupportedCustomAudioInputMetadataLayout('vorbis', 3, 44_100, '3.0')).toBe(true);
        expect(isSupportedCustomAudioInputMetadataLayout('aac', 3, 48_000, '2.1')).toBe(false);
        // AC-3 3.0(back) also arrives as 3.0, and its decoder reports no speaker mask
        expect(isSupportedCustomAudioInputMetadataLayout('ac3', 3, 48_000, '3.0')).toBe(false);
        expect(isSupportedCustomAudioInputMetadataLayout('opus', 3, 48_000, undefined))
            .toBe(false);
        // Other layouts need no metadata
        expect(isSupportedCustomAudioInputMetadataLayout('aac', 1, 24_000, undefined))
            .toBe(true);
        expect(isSupportedCustomAudioInputMetadataLayout('aac', 6, 48_000, undefined))
            .toBe(true);
        expect(isSupportedCustomAudioInputMetadataLayout('mp3', 3, 48_000, '3.0')).toBe(false);
    });

    it('accepts the complete Mediabunny PCM family through shared normalization', () => {
        for (const codec of [
            'pcm_s16le',
            'pcm_s16be',
            'pcm_s24le',
            'pcm_s24be',
            'pcm_s32le',
            'pcm_s32be',
            'pcm_f32le',
            'pcm_f32be',
            'pcm_f64le',
            'pcm_f64be',
            'pcm_u8',
            'pcm_s8',
            'pcm_mulaw',
            'pcm_alaw'
        ] as const) {
            expect(isCustomMediabunnyPCMAudioCodec(codec)).toBe(true);
            expect(getSupportedCustomAudioInputChannelCounts(codec)).toEqual([ 1, 2, 3, 6 ]);
            expect(isSupportedCustomAudioInputLayout(codec, 1, 44_100)).toBe(true);
            expect(isSupportedCustomAudioInputLayout(codec, 3, 48_000)).toBe(true);
            expect(isSupportedCustomAudioInputLayout(codec, 2, 12_345)).toBe(true);
            expect(isSupportedCustomAudioInputLayout(codec, 6, 96_000)).toBe(true);
        }

        expect(isMediabunnyPCMDecoderCodec('pcm-s24')).toBe(true);
        expect(isMediabunnyPCMDecoderCodec('pcm-f64be')).toBe(true);
        expect(isMediabunnyPCMDecoderCodec('ulaw')).toBe(true);
        expect(isMediabunnyPCMDecoderCodec('alaw')).toBe(true);
        expect(isSupportedCustomAudioInputLayout('pcm-s24', 2, 44_100)).toBe(true);
        expect(isSupportedCustomAudioInputLayout('ulaw', 1, 8_000)).toBe(true);
        expect(isSupportedCustomAudioInputLayout('pcm-s24', 8, 48_000)).toBe(false);
        expect(isSupportedCustomAudioInputLayout('pcm-s24', 2, 2_999)).toBe(false);
        expect(isCustomMediabunnyPCMAudioCodec('pcm-s64le')).toBe(false);
        expect(isMediabunnyPCMDecoderCodec('pcm-s64')).toBe(false);
    });
});
