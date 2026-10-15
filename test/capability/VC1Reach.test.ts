import { describe, expect, it } from 'vitest';

import { supportsCustomContainerCodecCombination } from 'webgpu-player/capability/CustomContainerCodecSupport';
import CustomDecodeCapabilityProbe, {
    CUSTOM_DECODE_AUDIO_PROBES,
    CUSTOM_VIDEO_CODECS,
    selectCustomDecodeProbes,
    type CustomDecodeCapabilities
} from 'webgpu-player/capability/CustomDecodeCapabilities';
import {
    getCustomPlaybackEligibility,
    getGPUVideoDecodeTarget,
    hasPotentialCustomPlaybackVideoRoute
} from 'webgpu-player/capability/CustomPlaybackEligibility';
import type { CustomPlaybackRuntimeAvailability } from 'webgpu-player/capability/CustomPlaybackRuntime';
import type { VideoDecoderPackage } from 'webgpu-player/decode/packages/DecoderPackage';
import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import { createGPUVideoDecoderOffer, type GPUVideoDecoderOffer } from 'webgpu-player/decode/video/gpu/GPUVideoDecoderCatalog';

import { parseFFprobeOutput } from '../../sandbox/src/session/FFprobeOutput';
import { createPlaybackMediaSource } from '../../sandbox/src/session/PlaybackMediaSource';
import {
    createVideoDecoderPackageForTest,
    createVideoDecoderSource,
    readDecoderProjectSource
} from '../helpers/decoderPackages';

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
// A Jellyfin stream path of a WMV3 file remuxed into Matroska
const STREAM_URL = '/Videos/item/stream.mkv';
const RUN_TIME_TICKS = 60_000_000;
const WMV3_WIDTH = 320;
const WMV3_HEIGHT = 240;
const VC1_WIDTH = 1_920;
const VC1_HEIGHT = 1_080;
const FRAME_RATE = 29.97;
const EIGHT_BIT_DEPTH = 8;
const LARGE_FRAME_POOL_BYTE_LIMIT = 2 ** 31;
const MATROSKA_CONTAINER = 'mkv';
// The container names Jellyfin and ffprobe give an ISO base media file, and an MPEG transport stream
const ISO_BASE_MEDIA_CONTAINER = 'mov,mp4,m4a,3gp,3g2,mj2';
const TRANSPORT_STREAM_CONTAINER = 'ts';
const ASF_CONTAINER = 'asf';
/* eslint-disable @typescript-eslint/naming-convention -- ffprobe's JSON keys are snake_case */
// What ffprobe prints of a WMV3 Main profile stream remuxed from ASF into Matroska, and of a VC-1 stream in MP4, where it names no field order
const WMV3_FFPROBE_STREAM = Object.freeze({
    avg_frame_rate: '30000/1001',
    codec_name: 'wmv3',
    codec_tag_string: 'WMV3',
    codec_type: 'video',
    coded_height: WMV3_HEIGHT,
    coded_width: WMV3_WIDTH,
    disposition: { attached_pic: 0, default: 0, forced: 0 },
    height: WMV3_HEIGHT,
    index: 0,
    pix_fmt: 'yuv420p',
    profile: 'Main',
    width: WMV3_WIDTH
});
const VC1_FFPROBE_STREAM = Object.freeze({
    avg_frame_rate: '12000/499',
    codec_name: 'vc1',
    codec_tag_string: 'vc-1',
    codec_type: 'video',
    disposition: { attached_pic: 0, default: 1, forced: 0 },
    height: VC1_HEIGHT,
    index: 0,
    pix_fmt: 'yuv420p',
    profile: 'Advanced',
    width: VC1_WIDTH
});
/* eslint-enable @typescript-eslint/naming-convention */
const FFPROBE_MATROSKA_FORMAT = 'matroska,webm';
const FFPROBE_ISO_BASE_MEDIA_FORMAT = 'mov,mp4,m4a,3gp,3g2,mj2';
const FFPROBE_DURATION = '64.330000';
const SANDBOX_SOURCE_ID = 'local/media.mkv';
// The VC-1 decoder project, whose header the eligibility offers by its accepted codecs, and a package of the Advanced profile alone
const VC1_DECODER_PROJECT = 'vc1';
const VC1_PROJECT_PACKAGE = createVideoDecoderPackageForTest(readDecoderProjectSource(VC1_DECODER_PROJECT));
const ADVANCED_ONLY_PACKAGE = createVideoDecoderPackageForTest(createVideoDecoderSource({ codecs: [ 'vc1' ], name: 'VC-1 Advanced', outputFormats: [ 'I420' ] }));

type StreamFields = Readonly<Record<string, unknown>>;

function createVideoStream(fields: StreamFields): Record<string, unknown> {
    return {
        AverageFrameRate: FRAME_RATE,
        BitDepth: EIGHT_BIT_DEPTH,
        Height: WMV3_HEIGHT,
        Index: 0,
        IsInterlaced: false,
        Type: 'Video',
        VideoRangeType: 'SDR',
        Width: WMV3_WIDTH,
        ...fields
    };
}

function createItem(fields: StreamFields, container: string): Record<string, unknown> {
    return { MediaSources: [ { Container: container, Id: 'source', MediaStreams: [ createVideoStream(fields) ] } ] };
}

/** A direct play of the stream without audio, which the eligibility plays without an audio route. */
function createPlaybackOptions(fields: StreamFields, container: string): Record<string, unknown> {
    return {
        mediaSource: { Container: container, MediaStreams: [ createVideoStream(fields) ], RunTimeTicks: RUN_TIME_TICKS },
        playMethod: 'DirectPlay',
        playerStartPositionTicks: 0,
        source: { kind: 'url', url: STREAM_URL }
    };
}

function createOffers(decoderPackage: VideoDecoderPackage): GPUVideoDecoderOffer[] {
    return decoderPackage.manifest.outputFormats.map((format: GPUDecoderOutputFormat): GPUVideoDecoderOffer =>
        createGPUVideoDecoderOffer(decoderPackage, format, LARGE_FRAME_POOL_BYTE_LIMIT));
}

/** The capabilities of a browser without WebCodecs, in which only decoder packages decode video. */
function probeCapabilitiesWithoutWebCodecs(): Promise<CustomDecodeCapabilities> {
    return new CustomDecodeCapabilityProbe({ audioDecoder: null, videoDecoder: null }).probe();
}

describe('VC-1 and WMV3 reach', () => {
    it('names WMV3 an engine codec of its own, which no engine decoder decodes and no probe settles', async () => {
        const capabilities = await probeCapabilitiesWithoutWebCodecs();

        expect(CUSTOM_VIDEO_CODECS).toContain('wmv3');
        expect(capabilities.video.wmv3).toEqual({ codec: 'wmv3', codecString: 'wmv3', reason: 'no-engine-decoder', status: 'unsupported' });
        expect(selectCustomDecodeProbes(createItem({ Codec: 'wmv3', Profile: 'Main' }, MATROSKA_CONTAINER))).toEqual([ ...CUSTOM_DECODE_AUDIO_PROBES ]);
    });

    it.each([
        [ MATROSKA_CONTAINER, 'wmv3', 'ac3', true ],
        [ 'matroska', 'wmv3', null, true ],
        [ 'mp4', 'wmv3', null, false ],
        [ TRANSPORT_STREAM_CONTAINER, 'wmv3', null, false ],
        [ MATROSKA_CONTAINER, 'vc1', 'dts', true ],
        [ 'mp4', 'vc1', 'aac', true ],
        [ 'mov', 'vc1', 'pcm_s16le', true ],
        [ 'm4v', 'vc1', 'ac3', true ],
        [ TRANSPORT_STREAM_CONTAINER, 'vc1', 'ac3', false ],
        [ ASF_CONTAINER, 'wmv3', null, false ]
    ] as const)('places %s %s with %s audio: %s', (container, videoCodec, audioCodec, supported) => {
        expect(supportsCustomContainerCodecCombination([ container ], videoCodec, audioCodec)).toBe(supported);
    });

    it.each([ 'Simple', 'Main', 'Complex' ])('keeps a Matroska WMV3 %s profile stream eligible for selection', (profile: string) => {
        expect(hasPotentialCustomPlaybackVideoRoute(createItem({ Codec: 'wmv3', Profile: profile }, MATROSKA_CONTAINER))).toBe(true);
    });

    it.each([
        [ 'an Advanced profile WMV3 stream', { Codec: 'wmv3', Profile: 'Advanced' }, MATROSKA_CONTAINER ],
        [ 'a WMV3 stream in an ISO base media file', { Codec: 'wmv3', Profile: 'Main' }, ISO_BASE_MEDIA_CONTAINER ],
        [ 'a WMV3 stream in ASF', { Codec: 'wmv3', Profile: 'Main' }, ASF_CONTAINER ],
        [ 'a Main profile VC-1 stream', { Codec: 'vc1', Profile: 'Main' }, MATROSKA_CONTAINER ],
        [ 'a VC-1 stream in a transport stream', { Codec: 'vc1', Height: VC1_HEIGHT, Profile: 'Advanced', Width: VC1_WIDTH }, TRANSPORT_STREAM_CONTAINER ]
    ])('rejects %s from selection', (_label: string, fields: StreamFields, container: string) => {
        expect(hasPotentialCustomPlaybackVideoRoute(createItem(fields, container))).toBe(false);
    });

    it('keeps an Advanced profile VC-1 stream in an ISO base media file eligible for selection', () => {
        const fields = { Codec: 'vc1', Height: VC1_HEIGHT, Profile: 'Advanced', Width: VC1_WIDTH };

        expect(hasPotentialCustomPlaybackVideoRoute(createItem(fields, ISO_BASE_MEDIA_CONTAINER))).toBe(true);
    });

    it('plays Matroska WMV3 on the frame-pool route of the VC-1 decoder project, whose header accepts wmv3', async () => {
        const options = createPlaybackOptions({ Codec: 'wmv3', Profile: 'Main' }, MATROSKA_CONTAINER);

        const eligibility = getCustomPlaybackEligibility(options, await probeCapabilitiesWithoutWebCodecs(), {
            allowRawHDR: false,
            gpuVideoDecoders: createOffers(VC1_PROJECT_PACKAGE),
            runtimeAvailability: AVAILABLE_RUNTIME
        });

        expect(getGPUVideoDecodeTarget(options)).toEqual({ codec: 'wmv3', format: 'I420' });
        expect(eligibility).toMatchObject({
            eligible: true,
            gpuVideoDecoder: { codec: 'wmv3', decoderId: VC1_PROJECT_PACKAGE.id },
            maximumCodedHeight: WMV3_HEIGHT,
            maximumCodedWidth: WMV3_WIDTH,
            videoDecoderBackend: 'gpu',
            videoOutputMode: 'frame-pool'
        });
    });

    it('offers no WMV3 route on a package that accepts only vc1', async () => {
        const eligibility = getCustomPlaybackEligibility(createPlaybackOptions({ Codec: 'wmv3', Profile: 'Main' }, MATROSKA_CONTAINER), await probeCapabilitiesWithoutWebCodecs(), {
            allowRawHDR: false,
            gpuVideoDecoders: createOffers(ADVANCED_ONLY_PACKAGE),
            runtimeAvailability: AVAILABLE_RUNTIME
        });

        expect(eligibility.eligible).toBe(false);
    });

    it.each([
        [ 'WMV3 in Matroska', WMV3_FFPROBE_STREAM, FFPROBE_MATROSKA_FORMAT, 'wmv3' ],
        [ 'VC-1 in MP4', VC1_FFPROBE_STREAM, FFPROBE_ISO_BASE_MEDIA_FORMAT, 'vc1' ]
    ])('carries the sandbox\'s ffprobe metadata of %s to a frame-pool route', async (_label: string, stream: Readonly<Record<string, unknown>>, formatName: string, codec: string) => {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- ffprobe's JSON keys are snake_case
        const output = parseFFprobeOutput(JSON.stringify({ format: { duration: FFPROBE_DURATION, format_name: formatName }, streams: [ stream ] }));
        const mediaSource = createPlaybackMediaSource(output, [], SANDBOX_SOURCE_ID, false);
        const options = { mediaSource, playMethod: 'DirectPlay', playerStartPositionTicks: 0, source: { kind: 'url', url: STREAM_URL } };

        const eligibility = getCustomPlaybackEligibility(options, await probeCapabilitiesWithoutWebCodecs(), {
            allowRawHDR: false,
            gpuVideoDecoders: createOffers(VC1_PROJECT_PACKAGE),
            runtimeAvailability: AVAILABLE_RUNTIME
        });

        expect(mediaSource.MediaStreams[0]).toMatchObject({ BitDepth: EIGHT_BIT_DEPTH, Codec: codec, IsInterlaced: false });
        expect(hasPotentialCustomPlaybackVideoRoute({ MediaSources: [ mediaSource ] })).toBe(true);
        expect(eligibility).toMatchObject({ eligible: true, gpuVideoDecoder: { codec }, videoOutputMode: 'frame-pool' });
    });

    it('plays an ISO base media VC-1 stream on the frame-pool route', async () => {
        const fields = { Codec: 'vc1', Height: VC1_HEIGHT, Profile: 'Advanced', Width: VC1_WIDTH };

        const eligibility = getCustomPlaybackEligibility(createPlaybackOptions(fields, ISO_BASE_MEDIA_CONTAINER), await probeCapabilitiesWithoutWebCodecs(), {
            allowRawHDR: false,
            gpuVideoDecoders: createOffers(VC1_PROJECT_PACKAGE),
            runtimeAvailability: AVAILABLE_RUNTIME
        });

        expect(eligibility).toMatchObject({ eligible: true, gpuVideoDecoder: { codec: 'vc1' }, videoOutputMode: 'frame-pool' });
    });
});
