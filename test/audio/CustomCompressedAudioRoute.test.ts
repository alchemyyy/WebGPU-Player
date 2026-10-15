import { describe, expect, it } from 'vitest';

import {
    DTS_SUPPORTED_INPUT_ROUTES,
    hasCustomAudioMetadataLayout,
    isSupportedTrueHDInputRoute
} from 'webgpu-player/audio/CustomCompressedAudioRoute';

const MONO_CHANNEL_COUNT = 1;
const THREE_CHANNEL_COUNT = 3;
const SEVEN_POINT_ONE_CHANNEL_COUNT = 8;
// The one rate eight-channel TrueHD is composed at
const TRUEHD_SEVEN_POINT_ONE_SAMPLE_RATE = 48_000;
const HIGH_SAMPLE_RATE = 96_000;
const CD_SAMPLE_RATE = 44_100;
const SEVEN_POINT_ONE_LAYOUT = '7.1';

describe('CustomCompressedAudioRoute', () => {
    it('lists the composed DTS routes in the shared route table', () => {
        expect(DTS_SUPPORTED_INPUT_ROUTES).toContainEqual({
            channelCount: THREE_CHANNEL_COUNT,
            metadataLayouts: [ '2.1', '3.0' ],
            profileTokens: [ 'DTSHDMA', 'DTSHDMADTSX' ],
            sampleRate: TRUEHD_SEVEN_POINT_ONE_SAMPLE_RATE
        });
        expect(DTS_SUPPORTED_INPUT_ROUTES.filter(route => route.channelCount === MONO_CHANNEL_COUNT))
            .toHaveLength(1);
    });

    it('matches Jellyfin channel-layout metadata case- and space-insensitively', () => {
        expect(hasCustomAudioMetadataLayout(undefined, null)).toBe(true);
        expect(hasCustomAudioMetadataLayout(` ${SEVEN_POINT_ONE_LAYOUT} `, [ SEVEN_POINT_ONE_LAYOUT ])).toBe(true);
        expect(hasCustomAudioMetadataLayout('STEREO', [ 'stereo' ])).toBe(true);
        expect(hasCustomAudioMetadataLayout(undefined, [ SEVEN_POINT_ONE_LAYOUT ])).toBe(false);
        expect(hasCustomAudioMetadataLayout(SEVEN_POINT_ONE_CHANNEL_COUNT, [ SEVEN_POINT_ONE_LAYOUT ])).toBe(false);
    });

    it('accepts eight-channel TrueHD only at exactly 48 kHz', () => {
        expect(isSupportedTrueHDInputRoute('truehd', SEVEN_POINT_ONE_CHANNEL_COUNT, TRUEHD_SEVEN_POINT_ONE_SAMPLE_RATE)).toBe(true);

        expect(isSupportedTrueHDInputRoute('truehd', SEVEN_POINT_ONE_CHANNEL_COUNT, HIGH_SAMPLE_RATE)).toBe(false);
        expect(isSupportedTrueHDInputRoute('mlp', SEVEN_POINT_ONE_CHANNEL_COUNT, TRUEHD_SEVEN_POINT_ONE_SAMPLE_RATE)).toBe(false);
    });

    it('accepts mono TrueHD and MLP at any bounded rate', () => {
        for (const codec of [ 'truehd', 'mlp' ]) {
            expect(isSupportedTrueHDInputRoute(codec, MONO_CHANNEL_COUNT, TRUEHD_SEVEN_POINT_ONE_SAMPLE_RATE)).toBe(true);
            expect(isSupportedTrueHDInputRoute(codec, MONO_CHANNEL_COUNT, HIGH_SAMPLE_RATE)).toBe(true);
            expect(isSupportedTrueHDInputRoute(codec, MONO_CHANNEL_COUNT, CD_SAMPLE_RATE)).toBe(true);
            expect(isSupportedTrueHDInputRoute(codec, THREE_CHANNEL_COUNT, TRUEHD_SEVEN_POINT_ONE_SAMPLE_RATE)).toBe(false);
        }
    });
});
