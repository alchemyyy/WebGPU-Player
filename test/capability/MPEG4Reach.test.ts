import { describe, expect, it } from 'vitest';

import { supportsCustomContainerCodecCombination } from 'webgpu-player/capability/CustomContainerCodecSupport';
import CustomDecodeCapabilityProbe, {
    CUSTOM_DECODE_AUDIO_PROBES,
    CUSTOM_PACKAGE_VIDEO_CODECS,
    selectCustomDecodeProbes,
    type CustomDecodeCapabilities
} from 'webgpu-player/capability/CustomDecodeCapabilities';
import {
    getCustomPlaybackEligibility,
    type CustomPlaybackEligibility,
    getGPUVideoDecodeTarget,
    hasEligibleCustomVideoRoute,
    hasPotentialCustomPlaybackVideoRoute
} from 'webgpu-player/capability/CustomPlaybackEligibility';
import type { CustomPlaybackRuntimeAvailability } from 'webgpu-player/capability/CustomPlaybackRuntime';
import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import {
    createGPUVideoDecoderOffer,
    type GPUVideoDecoderOffer,
    type GPUVideoDecoderSummary
} from 'webgpu-player/decode/video/gpu/GPUVideoDecoderCatalog';

import { createVideoDecoderPackageForTest, readDecoderProjectSource } from '../helpers/decoderPackages';

const AVAILABLE_RUNTIME: CustomPlaybackRuntimeAvailability = {
    available: true,
    environment: {
        animationFrame: true,
        audioContext: true,
        audioData: true,
        audioDecoder: true,
        audioWorklet: true,
        secureContext: true,
        videoDecoder: true,
        videoFrame: true,
        webGPU: true,
        worker: true
    },
    reason: null
};
const STREAM_URL = '/Videos/item/stream';
const RUN_TIME_TICKS = 60_000_000;
const WIDTH = 720;
const HEIGHT = 480;
const FRAME_RATE = 25;
const EIGHT_BIT_DEPTH = 8;
const TEN_BIT_DEPTH = 10;
const LARGE_FRAME_POOL_BYTE_LIMIT = 2 ** 31;
const MATROSKA_CONTAINER = 'mkv';
const AVI_CONTAINER = 'avi';
// The container names Jellyfin and ffprobe give an ISO base media file, which a 3GP file shares
const ISO_BASE_MEDIA_CONTAINER = 'mov,mp4,m4a,3gp,3g2,mj2';
const PACKAGE_CODECS = [ 'mpeg4', 'h263', 'msmpeg4v1', 'msmpeg4v2', 'msmpeg4v3' ] as const;
// The decoder project of the five codecs, whose header the eligibility offers by its accepted codecs
const MPEG4_PROJECT_PACKAGE = createVideoDecoderPackageForTest(readDecoderProjectSource('mpeg4'));
// What a host knows of the package before a playback has it and the device
const MPEG4_SUMMARY: GPUVideoDecoderSummary = {
    codecs: MPEG4_PROJECT_PACKAGE.manifest.accepts.codecs,
    header: MPEG4_PROJECT_PACKAGE.manifest,
    maximumBufferByteLength: LARGE_FRAME_POOL_BYTE_LIMIT,
    outputFormats: MPEG4_PROJECT_PACKAGE.manifest.outputFormats
};

type StreamFields = Readonly<Record<string, unknown>>;

function createVideoStream(fields: StreamFields): Record<string, unknown> {
    return {
        AverageFrameRate: FRAME_RATE,
        BitDepth: EIGHT_BIT_DEPTH,
        Height: HEIGHT,
        Index: 0,
        IsInterlaced: false,
        Type: 'Video',
        VideoRangeType: 'SDR',
        Width: WIDTH,
        ...fields
    };
}

function createMediaSource(fields: StreamFields, container: string): Record<string, unknown> {
    return { Container: container, Id: 'source', MediaStreams: [ createVideoStream(fields) ], RunTimeTicks: RUN_TIME_TICKS };
}

/** A direct play of the stream without audio, which the eligibility plays without an audio route. */
function createPlaybackOptions(fields: StreamFields, container: string): Record<string, unknown> {
    return {
        mediaSource: createMediaSource(fields, container),
        playMethod: 'DirectPlay',
        playerStartPositionTicks: 0,
        source: { kind: 'url', url: STREAM_URL }
    };
}

function createOffers(): GPUVideoDecoderOffer[] {
    return MPEG4_PROJECT_PACKAGE.manifest.outputFormats.map((format: GPUDecoderOutputFormat): GPUVideoDecoderOffer =>
        createGPUVideoDecoderOffer(MPEG4_PROJECT_PACKAGE, format, LARGE_FRAME_POOL_BYTE_LIMIT));
}

/** The capabilities of a browser without WebCodecs, in which only decoder packages decode video. */
function probeCapabilitiesWithoutWebCodecs(): Promise<CustomDecodeCapabilities> {
    return new CustomDecodeCapabilityProbe({ audioDecoder: null, videoDecoder: null }).probe();
}

async function getEligibility(fields: StreamFields, container: string, gpuVideoDecoders: readonly GPUVideoDecoderOffer[]): Promise<CustomPlaybackEligibility> {
    return getCustomPlaybackEligibility(createPlaybackOptions(fields, container), await probeCapabilitiesWithoutWebCodecs(), {
        allowRawHDR: false,
        gpuVideoDecoders,
        runtimeAvailability: AVAILABLE_RUNTIME
    });
}

// Each codec in the containers FFmpeg writes it to: Matroska and AVI for all five, and ISO base media for MPEG-4 Part 2 and H.263
const PLACED_STREAMS: ReadonlyArray<readonly [ string, string, string ]> = [
    ...PACKAGE_CODECS.map((codec: string): [ string, string, string ] => [ codec, MATROSKA_CONTAINER, codec ]),
    ...PACKAGE_CODECS.map((codec: string): [ string, string, string ] => [ codec, AVI_CONTAINER, codec ]),
    [ 'mpeg4', ISO_BASE_MEDIA_CONTAINER, 'mpeg4' ],
    [ 'h263', ISO_BASE_MEDIA_CONTAINER, 'h263' ],
    // ffprobe's names, as Jellyfin reports them, and FFmpeg's decoder name of MS-MPEG4 version 3
    [ 'MPEG4', AVI_CONTAINER, 'mpeg4' ],
    [ 'msmpeg4', AVI_CONTAINER, 'msmpeg4v3' ]
];

describe('MPEG-4 Part 2, H.263, and MS-MPEG4 reach', () => {
    it('names the five codecs package-only engine codecs, which no engine decoder decodes and no probe settles', async () => {
        const capabilities = await probeCapabilitiesWithoutWebCodecs();

        for (const codec of PACKAGE_CODECS) {
            expect(CUSTOM_PACKAGE_VIDEO_CODECS).toContain(codec);
            expect(capabilities.video[codec]).toEqual({ codec, codecString: codec, reason: 'no-engine-decoder', status: 'unsupported' });
            expect(selectCustomDecodeProbes({ MediaSources: [ createMediaSource({ Codec: codec }, AVI_CONTAINER) ] })).toEqual([ ...CUSTOM_DECODE_AUDIO_PROBES ]);
        }
    });

    it.each([
        ...PACKAGE_CODECS.map(codec => [ MATROSKA_CONTAINER, codec, 'mp3', true ] as const),
        ...PACKAGE_CODECS.map(codec => [ AVI_CONTAINER, codec, 'mp3', true ] as const),
        [ 'mp4', 'mpeg4', 'aac', true ],
        [ 'mov', 'mpeg4', null, true ],
        [ '3gp', 'h263', 'aac', true ],
        [ 'mp4', 'h263', null, true ],
        [ 'mp4', 'msmpeg4v3', null, false ],
        [ 'mov', 'msmpeg4v2', null, false ],
        [ 'webm', 'mpeg4', null, false ],
        [ 'ts', 'mpeg4', null, false ]
    ] as const)('places %s %s with %s audio: %s', (container, videoCodec, audioCodec, supported) => {
        expect(supportsCustomContainerCodecCombination([ container ], videoCodec, audioCodec)).toBe(supported);
    });

    it.each(PLACED_STREAMS)('plays %s in %s on the package\'s frame-pool route, as %s', async (streamCodec: string, container: string, codec: string) => {
        const fields = { Codec: streamCodec, Profile: 'Advanced Simple Profile' };

        expect(hasPotentialCustomPlaybackVideoRoute({ MediaSources: [ createMediaSource(fields, container) ] })).toBe(true);
        expect(getGPUVideoDecodeTarget(createPlaybackOptions(fields, container))).toEqual({ codec, format: 'I420' });
        expect(await getEligibility(fields, container, createOffers())).toMatchObject({
            eligible: true,
            gpuVideoDecoder: { codec, decoderId: MPEG4_PROJECT_PACKAGE.id },
            maximumCodedHeight: HEIGHT,
            maximumCodedWidth: WIDTH,
            videoDecoderBackend: 'gpu',
            videoOutputMode: 'frame-pool'
        });
        expect(hasEligibleCustomVideoRoute(createMediaSource(fields, container), await probeCapabilitiesWithoutWebCodecs(), {
            allowRawHDR: false,
            gpuVideoDecoderSummaries: [ MPEG4_SUMMARY ]
        })).toBe(true);
    });

    it.each(PLACED_STREAMS)('declines %s in %s without a package that decodes it', async (streamCodec: string, container: string) => {
        const fields = { Codec: streamCodec };

        expect(await getEligibility(fields, container, [])).toEqual({ eligible: false, reason: 'codec-unsupported' });
        expect(hasEligibleCustomVideoRoute(createMediaSource(fields, container), await probeCapabilitiesWithoutWebCodecs(), {
            allowRawHDR: false,
            gpuVideoDecoderSummaries: []
        })).toBe(false);
    });

    it('declines a stream deeper than the package\'s header accepts', async () => {
        const eligibility = await getEligibility({ BitDepth: TEN_BIT_DEPTH, Codec: 'mpeg4', Profile: 'Simple Studio Profile' }, MATROSKA_CONTAINER, createOffers());

        expect(eligibility.eligible).toBe(false);
    });

    it.each([
        [ 'MS-MPEG4 version 3 in an ISO base media file', 'msmpeg4v3', ISO_BASE_MEDIA_CONTAINER ],
        [ 'MPEG-4 Part 2 in WebM', 'mpeg4', 'webm' ]
    ])('rejects %s from selection', (_label: string, codec: string, container: string) => {
        expect(hasPotentialCustomPlaybackVideoRoute({ MediaSources: [ createMediaSource({ Codec: codec }, container) ] })).toBe(false);
    });

    it.each([
        [ 'theora', 'video-codec-without-route' ],
        // FFmpeg names H.263+ apart from H.263, and no package decodes it under that name
        [ 'h263p', 'codec-unsupported' ]
    ])('still declines %s as %s', async (codec: string, reason: string) => {
        expect(await getEligibility({ Codec: codec }, MATROSKA_CONTAINER, createOffers())).toEqual({ eligible: false, reason });
    });
});
