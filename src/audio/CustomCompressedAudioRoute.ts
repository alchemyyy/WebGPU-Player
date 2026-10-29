import { isSupportedCustomAudioSampleRate } from './CustomAudioSampleRate';

export type DTSProfileToken =
    | 'DTS'
    | 'DTS9624'
    | 'DTSES'
    | 'DTSHDHRA'
    | 'DTSHDMA'
    | 'DTSHDMADTSX';

export type EAC3InputRoute = Readonly<{
    channelCount: 1 | 2 | 6 | 8
    metadataLayouts: readonly string[] | null
}>;

export type DTSInputRoute = Readonly<{
    channelCount: 1 | 2 | 3 | 5 | 6 | 7 | 8
    /** Jellyfin ChannelLayout values the route requires, or null for any */
    metadataLayouts: readonly string[] | null
    profileTokens: readonly DTSProfileToken[]
    sampleRate: 48_000 | 96_000 | 192_000
}>;

export type TrueHDCapabilityVectorRoute = Readonly<{
    channelCount: 2 | 6
    codec: 'mlp' | 'truehd'
    metadataLayouts: null
    sampleRate: 48_000 | 96_000 | 192_000
    sampleRateConstraint: 'bounded'
}>;

export type TrueHDInputRoute = Readonly<{
    channelCount: 1 | 2 | 6 | 8
    codec: 'mlp' | 'truehd'
    metadataLayouts: readonly string[] | null
    sampleRate: 48_000 | 96_000 | 192_000
    sampleRateConstraint: 'bounded' | 'exact'
}>;

export const EAC3_SUPPORTED_INPUT_ROUTES = Object.freeze([
    // The decoder reports mono's speaker mask, so the shared mixer places it
    Object.freeze({ channelCount: 1, metadataLayouts: null }),
    Object.freeze({ channelCount: 2, metadataLayouts: null }),
    Object.freeze({ channelCount: 6, metadataLayouts: null }),
    Object.freeze({
        channelCount: 8,
        metadataLayouts: Object.freeze([ '7.1' ] as const)
    })
] as const) satisfies readonly EAC3InputRoute[];

export const DTS_PROFILE_VALUE_BY_TOKEN: Readonly<Record<DTSProfileToken, string>> = Object.freeze({
    DTS: 'DTS',
    DTS9624: 'DTS 96/24',
    DTSES: 'DTS-ES',
    DTSHDHRA: 'DTS-HD HRA',
    DTSHDMA: 'DTS-HD MA',
    DTSHDMADTSX: 'DTS-HD MA + DTS:X'
});

/** Every DTS profile Jellyfin names, in the order the profile conditions list them; each carries a core or a lossless stream libdcadec decodes. */
export const DTS_PROFILE_TOKENS: readonly DTSProfileToken[] = Object.freeze([
    'DTS',
    'DTS9624',
    'DTSES',
    'DTSHDHRA',
    'DTSHDMA',
    'DTSHDMADTSX'
]);

// The dcadec samples and FFmpeg's DTS core encodes in src/capability/vectors/test/dts/, which the dts decoder project's tests decode through the package
export const DTS_CAPABILITY_VECTOR_ROUTES = Object.freeze([
    // FFmpeg's stereo and 5.0(side) core encodes, one tone per channel, decode to 0x3 and 0x607 with every tone in its place
    Object.freeze({
        channelCount: 2,
        metadataLayouts: null,
        profileTokens: Object.freeze([ 'DTS' ] as const),
        sampleRate: 48_000
    }),
    Object.freeze({
        channelCount: 5,
        metadataLayouts: null,
        profileTokens: Object.freeze([ 'DTS' ] as const),
        sampleRate: 48_000
    }),
    Object.freeze({
        channelCount: 6,
        metadataLayouts: null,
        profileTokens: Object.freeze([ 'DTS' ] as const),
        sampleRate: 48_000
    }),
    Object.freeze({
        channelCount: 6,
        metadataLayouts: null,
        profileTokens: Object.freeze([ 'DTS9624' ] as const),
        sampleRate: 96_000
    }),
    // The XCh sample decodes to the WAVE 6.1 mask, 0x70F, its back center apart from the side pair
    Object.freeze({
        channelCount: 7,
        metadataLayouts: null,
        profileTokens: Object.freeze([ 'DTSES' ] as const),
        sampleRate: 48_000
    }),
    Object.freeze({
        channelCount: 8,
        metadataLayouts: null,
        profileTokens: Object.freeze([ 'DTSHDHRA' ] as const),
        sampleRate: 48_000
    }),
    Object.freeze({
        channelCount: 8,
        metadataLayouts: null,
        profileTokens: Object.freeze([ 'DTSHDMA', 'DTSHDMADTSX' ] as const),
        sampleRate: 48_000
    }),
    Object.freeze({
        channelCount: 8,
        metadataLayouts: null,
        profileTokens: Object.freeze([ 'DTSHDMA', 'DTSHDMADTSX' ] as const),
        sampleRate: 96_000
    }),
    Object.freeze({
        channelCount: 6,
        metadataLayouts: null,
        profileTokens: Object.freeze([ 'DTSHDMA', 'DTSHDMADTSX' ] as const),
        sampleRate: 192_000
    })
] as const) satisfies readonly DTSInputRoute[];

/*
 * Routes no encoder this project can run produces a vector for: DTS-HD MA, HRA, and DTS-ES encodes need DTS's own tools.
 * libdcadec reports every block's WAVE speaker mask and outputs its planes in WAVE order, which the engine checks before it mixes, so each route below
 * is a bed whose mask the core or XCh vectors show the package reports, or that FFmpeg's port of libdcadec reports for such a stream, and the output
 * stage places: a mask without a layout fails the attempt as decode-failed, which renegotiates.
 */
const DTS_COMPOSED_INPUT_ROUTES = Object.freeze([
    // Mono's speaker mask, for every profile
    Object.freeze({
        channelCount: 1,
        metadataLayouts: null,
        profileTokens: DTS_PROFILE_TOKENS,
        sampleRate: 48_000
    }),
    // A stereo core or lossless stream, as the stereo core vector reports it
    Object.freeze({
        channelCount: 2,
        metadataLayouts: null,
        profileTokens: Object.freeze([ 'DTS9624', 'DTSHDHRA', 'DTSHDMA', 'DTSHDMADTSX' ] as const),
        sampleRate: 48_000
    }),
    // Three-channel beds decode to the 2.1, 3.0, or 3.0(back) speaker mask
    Object.freeze({
        channelCount: 3,
        metadataLayouts: Object.freeze([ '2.1', '3.0' ] as const),
        profileTokens: Object.freeze([ 'DTS', 'DTS9624', 'DTSHDHRA', 'DTSHDMA', 'DTSHDMADTSX' ] as const),
        sampleRate: 48_000
    }),
    // Five channels decode to 5.0(side), as the 5.0 core vector reports it, or to 4.1
    Object.freeze({
        channelCount: 5,
        metadataLayouts: Object.freeze([ '4.1', '5.0' ] as const),
        profileTokens: Object.freeze([ 'DTS9624', 'DTSHDHRA', 'DTSHDMA', 'DTSHDMADTSX' ] as const),
        sampleRate: 48_000
    }),
    // DTS-ES Matrix matrixes its back center into a 5.1 core, which decodes as 5.1
    Object.freeze({
        channelCount: 6,
        metadataLayouts: null,
        profileTokens: Object.freeze([ 'DTSES', 'DTSHDHRA' ] as const),
        sampleRate: 48_000
    }),
    // A lossless 6.1 bed decodes to the same 6.1 mask as DTS-ES's XCh
    Object.freeze({
        channelCount: 7,
        metadataLayouts: Object.freeze([ '6.1' ] as const),
        profileTokens: Object.freeze([ 'DTSHDHRA', 'DTSHDMA', 'DTSHDMADTSX' ] as const),
        sampleRate: 48_000
    })
] as const) satisfies readonly DTSInputRoute[];

/** Production routes, each backed by a vector's profile, speaker mask, and plane order, or composed from the speaker masks the package reports. */
export const DTS_SUPPORTED_INPUT_ROUTES = Object.freeze([
    ...DTS_CAPABILITY_VECTOR_ROUTES,
    ...DTS_COMPOSED_INPUT_ROUTES
] as const) satisfies readonly DTSInputRoute[];

export const TRUEHD_CAPABILITY_VECTOR_ROUTES = Object.freeze([
    Object.freeze({
        channelCount: 2,
        codec: 'truehd',
        metadataLayouts: null,
        sampleRate: 48_000,
        sampleRateConstraint: 'bounded'
    }),
    Object.freeze({
        channelCount: 6,
        codec: 'truehd',
        metadataLayouts: null,
        sampleRate: 96_000,
        sampleRateConstraint: 'bounded'
    }),
    Object.freeze({
        channelCount: 6,
        codec: 'truehd',
        metadataLayouts: null,
        sampleRate: 192_000,
        sampleRateConstraint: 'bounded'
    }),
    Object.freeze({
        channelCount: 2,
        codec: 'mlp',
        metadataLayouts: null,
        sampleRate: 48_000,
        sampleRateConstraint: 'bounded'
    })
] as const) satisfies readonly TrueHDCapabilityVectorRoute[];

const TRUEHD_COMPOSED_INPUT_ROUTES = Object.freeze([
    // FFmpeg reports mono's speaker mask, so the shared mixer places it
    Object.freeze({
        channelCount: 1,
        codec: 'truehd',
        metadataLayouts: null,
        sampleRate: 48_000,
        sampleRateConstraint: 'bounded'
    }),
    Object.freeze({
        channelCount: 1,
        codec: 'mlp',
        metadataLayouts: null,
        sampleRate: 48_000,
        sampleRateConstraint: 'bounded'
    }),
    Object.freeze({
        channelCount: 8,
        codec: 'truehd',
        metadataLayouts: Object.freeze([ '7.1' ] as const),
        sampleRate: 48_000,
        sampleRateConstraint: 'exact'
    })
] as const) satisfies readonly TrueHDInputRoute[];

/** Production routes backed by exact decoder and decoded channel-layout evidence. */
export const TRUEHD_SUPPORTED_INPUT_ROUTES = Object.freeze([
    ...TRUEHD_CAPABILITY_VECTOR_ROUTES,
    ...TRUEHD_COMPOSED_INPUT_ROUTES
] as const) satisfies readonly TrueHDInputRoute[];

/** Matches Jellyfin ChannelLayout metadata against a route's required layouts. */
export function hasCustomAudioMetadataLayout(channelLayout: unknown, metadataLayouts: readonly string[] | null): boolean {
    if (metadataLayouts === null) {
        return true;
    }
    if (typeof channelLayout !== 'string') {
        return false;
    }
    return metadataLayouts.includes(channelLayout.trim().toLowerCase());
}

function doesTrueHDInputRouteMatch(
    route: TrueHDInputRoute,
    codec: string,
    channelCount: unknown,
    sampleRate: number
): boolean {
    if (route.codec !== codec || route.channelCount !== channelCount) {
        return false;
    }
    switch (route.sampleRateConstraint) {
        case 'bounded':
            return true;
        case 'exact':
            return route.sampleRate === sampleRate;
    }
}

/** Accepts only production-qualified TrueHD/MLP codec, channel, and rate tuples. */
export function isSupportedTrueHDInputRoute(
    codec: string,
    channelCount: unknown,
    sampleRate: unknown
): boolean {
    if (!isSupportedCustomAudioSampleRate(sampleRate)) {
        return false;
    }
    for (const route of TRUEHD_SUPPORTED_INPUT_ROUTES) {
        if (doesTrueHDInputRouteMatch(route, codec, channelCount, sampleRate)) {
            return true;
        }
    }
    return false;
}
