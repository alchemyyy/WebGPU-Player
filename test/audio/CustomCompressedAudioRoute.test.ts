import { describe, expect, it } from 'vitest';

import {
    DTS_SUPPORTED_INPUT_ROUTES,
    hasCustomAudioMetadataLayout,
    isSupportedDTSInputRoute,
    isSupportedEAC3InputRoute,
    isSupportedTrueHDInputRoute,
    isSupportedTrueHDMetadataRoute
} from 'webgpu-player/audio/CustomCompressedAudioRoute';

describe('CustomCompressedAudioRoute', () => {
    it('accepts stereo DTS-HD MA without broadening other DTS profiles', () => {
        expect(isSupportedDTSInputRoute(2, 48_000, 'DTSHDMA')).toBe(true);
        expect(isSupportedDTSInputRoute(2, 96_000, 'DTSHDMA')).toBe(true);

        expect(isSupportedDTSInputRoute(2, 48_000, 'DTS')).toBe(false);
        expect(isSupportedDTSInputRoute(2, 48_000, 'DTS9624')).toBe(false);
        expect(isSupportedDTSInputRoute(2, 48_000, 'DTSHDHRA')).toBe(false);
        expect(isSupportedDTSInputRoute(2, 96_001, 'DTSHDMA')).toBe(false);
    });

    it.each([ 'DTS', 'DTS9624', 'DTSHDHRA', 'DTSHDMA', 'DTSHDMADTSX' ])(
        'accepts mono %s, whose decoded speaker mask the mixer places',
        profileToken => {
            expect(isSupportedDTSInputRoute(1, 48_000, profileToken)).toBe(true);
            expect(isSupportedDTSInputRoute(1, 96_000, profileToken)).toBe(true);
        }
    );

    it('accepts three-channel DTS-HD MA only with a 2.1 or 3.0 layout', () => {
        for (const profileToken of [ 'DTSHDMA', 'DTSHDMADTSX' ]) {
            expect(isSupportedDTSInputRoute(3, 48_000, profileToken, '2.1')).toBe(true);
            // Jellyfin cuts 3.0(back) to 3.0; the decoder's speaker mask tells them apart
            expect(isSupportedDTSInputRoute(3, 96_000, profileToken, ' 3.0 ')).toBe(true);
            expect(isSupportedDTSInputRoute(3, 48_000, profileToken, '3 channels')).toBe(false);
            expect(isSupportedDTSInputRoute(3, 48_000, profileToken)).toBe(false);
        }
        expect(isSupportedDTSInputRoute(3, 48_000, 'DTS', '3.0')).toBe(false);
        expect(isSupportedDTSInputRoute(3, 48_000, 'DTSHDHRA', '2.1')).toBe(false);
        expect(isSupportedDTSInputRoute(1, 48_000, 'DTSES')).toBe(false);
    });

    it('lists the composed DTS routes in the shared route table', () => {
        expect(DTS_SUPPORTED_INPUT_ROUTES).toContainEqual({
            channelCount: 3,
            metadataLayouts: [ '2.1', '3.0' ],
            profileTokens: [ 'DTSHDMA', 'DTSHDMADTSX' ],
            sampleRate: 48_000
        });
        expect(DTS_SUPPORTED_INPUT_ROUTES.filter(route => route.channelCount === 1))
            .toHaveLength(1);
    });

    it('matches Jellyfin channel-layout metadata case- and space-insensitively', () => {
        expect(hasCustomAudioMetadataLayout(undefined, null)).toBe(true);
        expect(hasCustomAudioMetadataLayout(' 7.1 ', [ '7.1' ])).toBe(true);
        expect(hasCustomAudioMetadataLayout('STEREO', [ 'stereo' ])).toBe(true);
        expect(hasCustomAudioMetadataLayout(undefined, [ '7.1' ])).toBe(false);
        expect(hasCustomAudioMetadataLayout(8, [ '7.1' ])).toBe(false);
    });

    it.each([
        [ 1, 48_000, undefined ],
        [ 2, 48_000, undefined ],
        [ 6, 44_100, undefined ],
        [ 8, 48_000, '7.1' ],
        [ 8, 48_000, ' 7.1 ' ]
    ] as const)(
        'accepts qualified %i-channel E-AC-3 route',
        (channelCount, sampleRate, channelLayout) => {
            expect(isSupportedEAC3InputRoute(
                channelCount,
                sampleRate,
                channelLayout
            )).toBe(true);
        }
    );

    it.each([
        [ 8, 48_000, undefined ],
        [ 8, 48_000, '8 channels' ],
        [ 8, 48_000, '5.1' ],
        [ 7, 48_000, '7.1' ],
        [ 3, 48_000, '3.0' ],
        [ 8, 192_001, '7.1' ]
    ] as const)(
        'rejects unqualified %i-channel E-AC-3 route',
        (channelCount, sampleRate, channelLayout) => {
            expect(isSupportedEAC3InputRoute(
                channelCount,
                sampleRate,
                channelLayout
            )).toBe(false);
        }
    );

    it('accepts only the composed 48 kHz standard 7.1 TrueHD route', () => {
        expect(isSupportedTrueHDInputRoute('truehd', 8, 48_000)).toBe(true);
        expect(isSupportedTrueHDMetadataRoute(
            'truehd',
            8,
            48_000,
            '7.1'
        )).toBe(true);
        expect(isSupportedTrueHDMetadataRoute(
            'truehd',
            8,
            48_000,
            ' 7.1 '
        )).toBe(true);

        expect(isSupportedTrueHDInputRoute('truehd', 8, 96_000)).toBe(false);
        expect(isSupportedTrueHDMetadataRoute(
            'truehd',
            8,
            48_000,
            undefined
        )).toBe(false);
        expect(isSupportedTrueHDMetadataRoute(
            'truehd',
            8,
            48_000,
            '8 channels'
        )).toBe(false);
        expect(isSupportedTrueHDMetadataRoute('mlp', 8, 48_000, '7.1')).toBe(false);
    });

    it('accepts mono TrueHD and MLP at any bounded rate without layout metadata', () => {
        for (const codec of [ 'truehd', 'mlp' ]) {
            expect(isSupportedTrueHDInputRoute(codec, 1, 48_000)).toBe(true);
            expect(isSupportedTrueHDInputRoute(codec, 1, 96_000)).toBe(true);
            expect(isSupportedTrueHDMetadataRoute(codec, 1, 44_100, undefined)).toBe(true);
            expect(isSupportedTrueHDInputRoute(codec, 3, 48_000)).toBe(false);
        }
    });
});
