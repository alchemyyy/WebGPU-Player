import { describe, expect, it } from 'vitest';

import {
    DTS_PROFILE_TOKENS,
    DTS_SUPPORTED_INPUT_ROUTES,
    hasCustomAudioMetadataLayout,
    isSupportedTrueHDInputRoute,
    type DTSProfileToken
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
            profileTokens: [ 'DTS', 'DTS9624', 'DTSHDHRA', 'DTSHDMA', 'DTSHDMADTSX' ],
            sampleRate: TRUEHD_SEVEN_POINT_ONE_SAMPLE_RATE
        });
        expect(DTS_SUPPORTED_INPUT_ROUTES.filter(route => route.channelCount === MONO_CHANNEL_COUNT))
            .toHaveLength(1);
    });

    it.each([
        // Stereo and 5.0: every profile with such a core or lossless bed; DTS-ES extends a 5.1 core
        { channelCount: 2, profiles: [ 'DTS', 'DTS9624', 'DTSHDHRA', 'DTSHDMA', 'DTSHDMADTSX' ] },
        { channelCount: 5, profiles: [ 'DTS', 'DTS9624', 'DTSHDHRA', 'DTSHDMA', 'DTSHDMADTSX' ] },
        { channelCount: 6, profiles: [ 'DTS', 'DTS9624', 'DTSES', 'DTSHDHRA', 'DTSHDMA', 'DTSHDMADTSX' ] },
        // Seven channels: DTS-ES's XCh and the lossless 6.1 beds, never a core alone
        { channelCount: 7, profiles: [ 'DTSES', 'DTSHDHRA', 'DTSHDMA', 'DTSHDMADTSX' ] }
    ])('routes $channelCount-channel DTS of exactly the profiles that carry such a bed', ({ channelCount, profiles }) => {
        const routedProfiles = new Set<DTSProfileToken>(DTS_SUPPORTED_INPUT_ROUTES
            .filter(route => route.channelCount === channelCount)
            .flatMap(route => route.profileTokens));

        expect(DTS_PROFILE_TOKENS.filter(profile => routedProfiles.has(profile))).toEqual(profiles);
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
