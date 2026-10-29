import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    CUSTOM_AUDIO_CODECS,
    CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS,
    CUSTOM_NATIVE_SURROUND_AUDIO_CODECS,
    CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS,
    CUSTOM_PACKAGE_AUDIO_CODECS,
    CUSTOM_VIDEO_CODECS,
    type CustomNativeSurroundAudioCodec,
    type CustomNativeSurroundAudioCodecCapability,
    type CustomNativeUltraHDVideoCodec,
    type CustomNativeUltraHDVideoCodecCapability,
    type CustomAudioCodec,
    type CustomDecodeCapabilities,
    type CustomDecodeCodecCapability,
    type CustomRawHDRVideoCodec,
    type CustomRawHDRVideoCodecCapability,
    type CustomVideoCodec
} from 'webgpu-player/capability/CustomDecodeCapabilities';
import {
    getCustomPlaybackEligibility,
    getDolbyVisionReconstructionRawFrameFormat,
    getAudioMetadataLayout,
    getGPUVideoDecodeTarget,
    getPlaybackAudioCodec,
    playbackAudioNeedsObjectRendering,
    getRawVideoPresentationRouteKey,
    hasEligibleCustomVideoRoute,
    hasPotentialCustomPlaybackVideoRoute,
    presentsInterlacedVideo,
    type CustomAudioRenderTarget,
    type CustomPlaybackEligibility,
    type CustomPlaybackEligibilityOptions,
    type CustomVideoRouteOptions
} from 'webgpu-player/capability/CustomPlaybackEligibility';
import {
    HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS,
    HEVC_RANGE_EXTENSION_VARIANTS,
    type HEVCRangeExtensionCapability,
    type HEVCRangeExtensionVariant
} from 'webgpu-player/capability/HEVCRangeExtensionCapabilities';
import {
    AV1_RAW_FORMAT_PROBE_DEFINITIONS,
    AV1_RAW_FORMAT_VARIANTS,
    type AV1RawFormatCapability,
    type AV1RawFormatVariant
} from 'webgpu-player/capability/AV1RawFormatCapabilities';
import {
    H264_RAW_FORMAT_PROBE_DEFINITIONS,
    H264_RAW_FORMAT_VARIANTS,
    type H264RawFormatCapability,
    type H264RawFormatVariant
} from 'webgpu-player/capability/H264RawFormatCapabilities';
import type { CustomPlaybackRuntimeAvailability } from 'webgpu-player/capability/CustomPlaybackRuntime';
import type {
    NativeMediaAudioCapabilities,
    NativeMediaAudioChannelCount,
    NativeMediaAudioCodec,
    NativeMediaAudioCodecCapability,
    NativeMediaAudioLayoutCapability
} from 'webgpu-player/capability/NativeMediaAudioCapabilities';
import {
    H264_JELLYFIN_PROFILE_NAMES,
    H264_PROFILE_PROBE_CODED_HEIGHT,
    H264_PROFILE_PROBE_CODED_WIDTH,
    H264_PROFILES,
    type H264ProfileCapabilities
} from 'webgpu-player/capability/H264ProfileCapabilities';
import type { AudioDecoderPackage, VideoDecoderPackage } from 'webgpu-player/decode/packages/DecoderPackage';
import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import { MEBIBYTE } from 'webgpu-player/decode/video/gpu/GPUDecodeLimits';
import {
    createGPUVideoDecoderOffer,
    type GPUVideoDecoderOffer,
    type GPUVideoDecoderSummary
} from 'webgpu-player/decode/video/gpu/GPUVideoDecoderCatalog';
import type { ExternalHDRAuthorizationRouteKey } from 'webgpu-player/validation/ExternalHDRPresentationAuthorization';
import type { RawHDRAuthorizationRouteKey } from 'webgpu-player/validation/RawHDRPresentationAuthorization';

import { createAudioDecoderPackageForTest } from '../helpers/audioDecoderPackageStubs';
import { createDecoderProjectVideoPackageForTest, createVideoDecoderPackageForTest, createVideoDecoderSource } from '../helpers/decoderPackages';

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

// HEVC codes interlaced video as field pictures and JPEG 2000 as a codestream per field
const FIELDS_APART_VIDEO_CODECS: ReadonlySet<CustomVideoCodec> = new Set<CustomVideoCodec>([ 'hevc', 'jpeg2000' ]);

const PQ_AUTHORIZATION = {
    allowRawHDR: true,
    authorizedRawHDRRouteKeys: [
        'I420P10:bt2020-ncl:bt2020:limited:pq'
    ] as const,
    runtimeAvailability: AVAILABLE_RUNTIME
};

// A Jellyfin stream path, which eligibility resolves against the page
const STREAM_URL = '/Videos/item/stream.mp4?api_key=secret';
// The path pattern a host sets on a URL source whose cross-origin 206 responses hide Content-Range
const HIDDEN_CONTENT_RANGE_PATH_PATTERN = /\/Videos\/[^/]+\/stream(?:\.[^/]+)?$/i;
const LOCAL_FILE_NAME = 'movie.mp4';
const FILE_URL = 'file:///movie.mkv';
const CREDENTIAL_URL = 'http://user:password@localhost/movie.mkv';
const EMPTY_URL = '';

const ULTRA_HD_CODED_WIDTH = 3_840;
const ULTRA_HD_CODED_HEIGHT = 2_160;
const DCI_4K_CODED_WIDTH = 4_096;
const DCI_4K_CODED_HEIGHT = 2_160;
const ULTRA_HD_8K_CODED_WIDTH = 7_680;
const ULTRA_HD_8K_CODED_HEIGHT = 4_320;
const ULTRA_HD_16K_CODED_WIDTH = 15_360;
const ULTRA_HD_16K_CODED_HEIGHT = 8_640;

// Uncommon source rates, which the resampler converts like any other; a browser decoder judges its own per item
const SUB_3_KHZ_SAMPLE_RATE = 2_999;
const ABOVE_192_KHZ_SAMPLE_RATE = 192_001;
const DXD_SAMPLE_RATE = 352_800;
const DOUBLE_DXD_SAMPLE_RATE = 705_600;
// Malformed declared rates
const ZERO_SAMPLE_RATE = 0;
const FRACTIONAL_SAMPLE_RATE = 48_000.5;

// A device whose largest buffer holds 2 GiB
const LARGE_FRAME_POOL_BYTE_LIMIT = 2 ** 31;
// Decoder packages a host offers for the codecs no engine decoder decodes, declaring the codecs their decoder projects accept
const MPEG2_VIDEO_PACKAGE = createVideoDecoderPackageForTest(createVideoDecoderSource({ codecs: [ 'mpeg2video' ], id: 'mpeg2', name: 'MPEG-2', outputFormats: [ 'I420' ] }));
// MPEG-2 packages as the decoder project builds them, writing every chroma format the codec has
const MPEG2_CHROMA_VIDEO_PACKAGE = createVideoDecoderPackageForTest(createVideoDecoderSource({
    codecs: [ 'mpeg2video' ],
    id: 'mpeg2-chroma',
    name: 'MPEG-2 4:2:0, 4:2:2, and 4:4:4',
    outputFormats: [ 'I420', 'I422', 'I444' ]
}));
const MPEG_VIDEO_PACKAGE = createVideoDecoderPackageForTest(createVideoDecoderSource({
    codecs: [ 'mpeg2video', 'mpeg1video' ],
    id: 'mpeg',
    name: 'MPEG-1 and MPEG-2',
    outputFormats: [ 'I420', 'I422', 'I444' ]
}));
const JPEG2000_DEEP_VIDEO_PACKAGE = createVideoDecoderPackageForTest(createVideoDecoderSource({
    codecs: [ 'jpeg2000' ],
    id: 'jpeg2000-deep',
    name: 'JPEG 2000 at 10 bits',
    outputFormats: [ 'I444P10' ]
}));
const VC1_VIDEO_PACKAGE = createVideoDecoderPackageForTest(createVideoDecoderSource({ codecs: [ 'vc1' ], id: 'vc1', name: 'VC-1', outputFormats: [ 'I420' ] }));
const JPEG2000_VIDEO_PACKAGE = createVideoDecoderPackageForTest(createVideoDecoderSource({ codecs: [ 'jpeg2000' ], id: 'jpeg2000', name: 'JPEG 2000', outputFormats: [ 'I420' ] }));
// The engine's HEVC decoder project, whose stream limits and output formats the GPU route checks, and which declares 4:0:0
const HEVC_DECODER_PROJECT = 'hevc';
const HEVC_VIDEO_PACKAGE = createDecoderProjectVideoPackageForTest(HEVC_DECODER_PROJECT);
// The engine's JPEG 2000 decoder project, whose parser fails greyscale pictures as colourSpace, so it declares no 4:0:0
const JPEG2000_DECODER_PROJECT = 'jpeg2000';
const JPEG2000_PROJECT_VIDEO_PACKAGE = createDecoderProjectVideoPackageForTest(JPEG2000_DECODER_PROJECT);
// The header line by which a decoder takes 4:0:0 streams
const MONOCHROME_DIRECTIVE_LINE = '//! monochrome: yes';
const DOLBY_AUDIO_PACKAGE = createAudioDecoderPackageForTest('E-AC-3', [ 'eac3', 'ac3' ], 'eac3');
const DTS_AUDIO_PACKAGE = createAudioDecoderPackageForTest('DTS', [ 'dts' ], 'dts');
const TRUEHD_AUDIO_PACKAGE = createAudioDecoderPackageForTest('TrueHD', [ 'mlp', 'truehd' ], 'truehd');
const AUDIO_PACKAGES = [ DOLBY_AUDIO_PACKAGE, DTS_AUDIO_PACKAGE, TRUEHD_AUDIO_PACKAGE ] as const;
const WMA_AUDIO_PACKAGE = createAudioDecoderPackageForTest('WMA', [ 'wmav1', 'wmav2', 'wmapro', 'wmalossless', 'wmavoice' ], 'wma');

function createCapability<Codec extends CustomAudioCodec | CustomVideoCodec>(
    codec: Codec,
    supported: boolean
): CustomDecodeCodecCapability<Codec> {
    return {
        codec,
        codecString: codec,
        reason: supported ? 'config-supported' : 'config-unsupported',
        status: supported ? 'supported' : 'unsupported'
    };
}

// The capability of a codec only a decoder package decodes, which no probe settles
function createNoEngineDecoderCapability<Codec extends CustomAudioCodec | CustomVideoCodec>(codec: Codec): CustomDecodeCodecCapability<Codec> {
    return {
        codec,
        codecString: codec,
        reason: 'no-engine-decoder',
        status: 'unsupported'
    };
}

/** Offers every format a video package writes on a device with a large frame pool limit. */
function createVideoDecoderOffers(decoderPackage: VideoDecoderPackage): GPUVideoDecoderOffer[] {
    return decoderPackage.manifest.outputFormats.map((format: GPUDecoderOutputFormat): GPUVideoDecoderOffer =>
        createGPUVideoDecoderOffer(decoderPackage, format, LARGE_FRAME_POOL_BYTE_LIMIT));
}

/** The GPU route a video package's offer selects. */
function createPackageVideoRoute(decoderPackage: VideoDecoderPackage, codec: CustomVideoCodec): Record<string, unknown> {
    return {
        eligible: true,
        gpuVideoDecoder: { codec, decoderId: decoderPackage.id, package: decoderPackage },
        videoDecoderBackend: 'gpu',
        videoOutputMode: 'frame-pool'
    };
}

function createH264ProfileCapabilities(): H264ProfileCapabilities {
    const capabilities = {} as Record<typeof H264_PROFILES[number], H264ProfileCapabilities[typeof H264_PROFILES[number]]>;
    for (const profile of H264_PROFILES) {
        capabilities[profile] = Object.freeze({
            codecString: profile,
            codedHeight: H264_PROFILE_PROBE_CODED_HEIGHT,
            codedWidth: H264_PROFILE_PROBE_CODED_WIDTH,
            evidence: 'decoded-output',
            jellyfinProfileName: H264_JELLYFIN_PROFILE_NAMES[profile],
            profile,
            reason: 'decode-output-verified',
            status: 'supported'
        });
    }
    return Object.freeze(capabilities);
}

function createCapabilities(): CustomDecodeCapabilities {
    const createRawHDRCapability = (codec: CustomRawHDRVideoCodec): CustomRawHDRVideoCodecCapability => ({
        bitDepth: 10,
        codec,
        codecString: codec === 'hevc' ? 'hvc1.2.4.L153.B0' : codec,
        format: 'I420P10',
        reason: 'output-copy-supported',
        status: 'supported'
    });
    const audio = {} as Record<CustomAudioCodec, CustomDecodeCodecCapability<CustomAudioCodec>>;
    for (const codec of CUSTOM_AUDIO_CODECS) {
        audio[codec] = createCapability(codec, true);
    }
    for (const codec of CUSTOM_PACKAGE_AUDIO_CODECS) {
        audio[codec] = createNoEngineDecoderCapability(codec);
    }
    return {
        audio,
        h264Profiles: createH264ProfileCapabilities(),
        nativeDolbyVisionHEVC: {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hev1.2.4.H150.B0',
            profile: 5,
            reason: 'decode-output-verified',
            status: 'supported'
        },
        nativeHDRHEVC: {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hvc1.2.4.L153.B0',
            reason: 'decode-output-verified',
            status: 'supported'
        },
        rawHDRVideo: {
            av1: createRawHDRCapability('av1'),
            hevc: createRawHDRCapability('hevc'),
            vp9: createRawHDRCapability('vp9')
        },
        telemetry: {
            audioProbeCount: 5,
            mediabunnyAudioCodecCount: CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS.length,
            nativeSurroundAudioProbeCount: 0,
            nativeHDRVideoProbeCount: 1,
            nativeUltraHDVideoProbeCount: 0,
            rawHDRVideoProbeCount: 2,
            reason: 'complete',
            supportedAudioCodecCount: 7,
            supportedNativeSurroundAudioCodecCount: 0,
            supportedNativeHDRVideoCodecCount: 1,
            supportedNativeUltraHDVideoCodecCount: 0,
            supportedRawHDRVideoCodecCount: 3,
            supportedVideoCodecCount: 5,
            unknownAudioCodecCount: 0,
            unknownNativeSurroundAudioCodecCount: 0,
            unknownNativeHDRVideoCodecCount: 0,
            unknownNativeUltraHDVideoCodecCount: 0,
            unknownVideoCodecCount: 0,
            videoProbeCount: 5
        },
        video: {
            av1: createCapability('av1', true),
            h264: createCapability('h264', true),
            hevc: createCapability('hevc', true),
            h263: createNoEngineDecoderCapability('h263'),
            jpeg2000: createNoEngineDecoderCapability('jpeg2000'),
            mpeg1video: createNoEngineDecoderCapability('mpeg1video'),
            mpeg2video: createNoEngineDecoderCapability('mpeg2video'),
            mpeg4: createNoEngineDecoderCapability('mpeg4'),
            msmpeg4v1: createNoEngineDecoderCapability('msmpeg4v1'),
            msmpeg4v2: createNoEngineDecoderCapability('msmpeg4v2'),
            msmpeg4v3: createNoEngineDecoderCapability('msmpeg4v3'),
            vc1: createNoEngineDecoderCapability('vc1'),
            vp8: createCapability('vp8', true),
            wmv3: createNoEngineDecoderCapability('wmv3'),
            vp9: createCapability('vp9', true)
        }
    };
}

function createCapabilitiesWithoutNativeHEVC(): CustomDecodeCapabilities {
    const capabilities = createCapabilities();
    capabilities.nativeHDRHEVC = undefined;
    capabilities.video = {
        ...capabilities.video,
        hevc: createCapability('hevc', false)
    };
    return capabilities;
}

/** Returns capabilities whose AV1 raw format variants all qualified. */
function createAV1RawFormatCapabilities(): CustomDecodeCapabilities {
    const capabilities = createCapabilities();
    const av1RawFormats = {} as Record<AV1RawFormatVariant, AV1RawFormatCapability>;
    for (const variant of AV1_RAW_FORMAT_VARIANTS) {
        const definition = AV1_RAW_FORMAT_PROBE_DEFINITIONS[variant];
        av1RawFormats[variant] = {
            bitDepth: definition.bitDepth,
            chromaFormat: definition.chromaFormat,
            codec: 'av1',
            codecString: definition.config.codec,
            format: definition.format,
            jellyfinProfile: definition.jellyfinProfile,
            pixelFormat: definition.pixelFormat,
            reason: 'output-copy-supported',
            status: 'supported',
            variant
        };
    }
    capabilities.av1RawFormats = av1RawFormats;
    return capabilities;
}

/** The capabilities with a verified hardware AV1 Main 10 decoder, which the native AV1 HDR and Dolby Vision routes need. */
function createNativeAV1Capabilities(): CustomDecodeCapabilities {
    return {
        ...createCapabilities(),
        nativeHDRAV1: { bitDepth: 10, codec: 'av1', codecString: 'av01.0.08M.10', reason: 'decode-output-verified', status: 'supported' }
    };
}

function createNativeSurroundAudioCapabilities(
    supportedCodecs: ReadonlySet<CustomNativeSurroundAudioCodec>,
    inputChannelCount: CustomNativeSurroundAudioCodecCapability['inputChannelCount'] = 6
): NonNullable<CustomDecodeCapabilities['nativeSurroundAudio']> {
    const codecStrings: Readonly<Record<CustomNativeSurroundAudioCodec, string>> = {
        aac: 'mp4a.40.2',
        flac: 'flac',
        opus: 'opus',
        vorbis: 'vorbis'
    };
    const capabilities = {} as Record<CustomNativeSurroundAudioCodec, CustomNativeSurroundAudioCodecCapability>;
    for (const codec of CUSTOM_NATIVE_SURROUND_AUDIO_CODECS) {
        const supported: boolean = supportedCodecs.has(codec);
        capabilities[codec] = {
            codec,
            codecString: codecStrings[codec],
            inputChannelCount,
            reason: supported ? 'decode-output-verified' : 'decode-output-missing',
            sampleRate: 48_000,
            status: supported ? 'supported' : 'unsupported'
        };
    }
    return capabilities;
}

function createNativeUltraHDVideoCapabilities(
    supportedCodecs: ReadonlySet<CustomNativeUltraHDVideoCodec>
): NonNullable<CustomDecodeCapabilities['nativeUltraHDVideo']> {
    const codecStrings: Readonly<Record<CustomNativeUltraHDVideoCodec, string>> = {
        av1: 'av01.0.12M.08',
        hevc: 'hvc1.1.6.L153.B0',
        vp9: 'vp09.00.51.08'
    };
    const capabilities = {} as Record<CustomNativeUltraHDVideoCodec, CustomNativeUltraHDVideoCodecCapability>;
    for (const codec of CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS) {
        const supported: boolean = supportedCodecs.has(codec);
        capabilities[codec] = {
            bitDepth: 8,
            codec,
            codecString: codecStrings[codec],
            reason: supported ? 'decode-output-verified' : 'decode-output-missing',
            status: supported ? 'supported' : 'unsupported'
        };
    }
    return capabilities;
}

function createNativeMediaAudioCapabilities(supportedRoutes: ReadonlySet<string>): NativeMediaAudioCapabilities {
    const audio = {} as Record<NativeMediaAudioCodec, NativeMediaAudioCodecCapability>;
    for (const codec of [ 'ac3', 'eac3' ] as const) {
        const codecString = codec === 'ac3' ? 'ac-3' : 'ec-3';
        const mimeType = `audio/mp4; codecs="${codecString}"`;
        const layouts = {} as Record<NativeMediaAudioChannelCount, NativeMediaAudioLayoutCapability>;
        let codecSupported = false;
        for (const channelCount of [ 2, 6 ] as const) {
            const supported = supportedRoutes.has(`${codec}:${channelCount}:48000`);
            codecSupported ||= supported;
            layouts[channelCount] = {
                channelCount,
                codec,
                codecString,
                mimeType,
                reason: supported ? 'decoded-playback-advanced' : 'playback-not-advanced',
                sampleRate: 48_000,
                status: supported ? 'supported' : 'unsupported'
            };
        }
        audio[codec] = {
            codec,
            codecString,
            layouts,
            mimeType,
            status: codecSupported ? 'supported' : 'unsupported'
        };
    }
    return {
        audio,
        telemetry: {
            probeCount: 4,
            supportedLayoutCount: supportedRoutes.size,
            unknownLayoutCount: 0
        }
    };
}

function createOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        mediaSource: {
            Container: 'mov,mp4,m4a,3gp,3g2,mj2',
            DefaultAudioStreamIndex: 1,
            MediaStreams: [
                {
                    BitDepth: 8,
                    Codec: 'h264',
                    Height: 1_080,
                    Index: 0,
                    IsInterlaced: false,
                    Profile: 'High',
                    Type: 'Video',
                    VideoRangeType: 'SDR',
                    Width: 1_920
                },
                {
                    Channels: 2,
                    Codec: 'aac',
                    Index: 1,
                    SampleRate: 48_000,
                    Type: 'Audio'
                }
            ],
            RunTimeTicks: 60_000_000
        },
        playMethod: 'DirectPlay',
        playerStartPositionTicks: 10_000_000,
        source: { kind: 'url', url: STREAM_URL },
        ...overrides
    };
}

function createProfile7HDR10BaseOptions(): Record<string, unknown> {
    return createOptions({
        mediaSource: {
            Container: 'mkv',
            DefaultAudioStreamIndex: 1,
            MediaStreams: [
                {
                    AverageFrameRate: 23.976025,
                    BitDepth: 10,
                    BitRate: 96_900_000,
                    BlPresentFlag: true,
                    Codec: 'hevc',
                    ColorPrimaries: 'bt2020',
                    ColorRange: 'tv',
                    ColorSpace: 'bt2020nc',
                    ColorTransfer: 'smpte2084',
                    DvBlSignalCompatibilityId: 6,
                    DvProfile: 7,
                    ElPresentFlag: true,
                    Height: 2_160,
                    Index: 0,
                    IsInterlaced: false,
                    Level: 153,
                    Profile: 'Main 10',
                    RealFrameRate: 23.976025,
                    RpuPresentFlag: true,
                    Type: 'Video',
                    VideoRange: 'HDR',
                    VideoRangeType: 'DOVIWithEL',
                    Width: 3_840
                },
                {
                    BitDepth: 24,
                    Channels: 2,
                    Codec: 'flac',
                    Index: 1,
                    SampleRate: 48_000,
                    Type: 'Audio'
                }
            ],
            RunTimeTicks: 60_000_000
        }
    });
}

function createProfile8HLGBaseOptions(): Record<string, unknown> {
    return createOptions({
        mediaSource: {
            Container: 'mkv',
            DefaultAudioStreamIndex: 1,
            MediaStreams: [
                {
                    AverageFrameRate: 59.94,
                    BitDepth: 10,
                    BitRate: 80_000_000,
                    BlPresentFlag: true,
                    Codec: 'hevc',
                    ColorPrimaries: 'bt2020',
                    ColorRange: 'tv',
                    ColorSpace: 'bt2020nc',
                    ColorTransfer: 'hlg',
                    DvBlSignalCompatibilityId: 4,
                    DvProfile: 8,
                    ElPresentFlag: false,
                    Height: 2_160,
                    Index: 0,
                    IsInterlaced: false,
                    Level: 153,
                    Profile: 'Main 10',
                    RealFrameRate: 59.94,
                    RpuPresentFlag: true,
                    Type: 'Video',
                    VideoRange: 'HDR',
                    VideoRangeType: 'DOVIWithHLG',
                    Width: 3_840
                },
                {
                    BitDepth: 24,
                    Channels: 2,
                    Codec: 'flac',
                    Index: 1,
                    SampleRate: 48_000,
                    Type: 'Audio'
                }
            ],
            RunTimeTicks: 60_000_000
        }
    });
}

function createPlaybackSelectionItem(
    videoStream: Record<string, unknown>,
    container = 'mkv',
    sourceId = 'source'
): Record<string, unknown> {
    return {
        MediaSources: [{
            Container: container,
            Id: sourceId,
            MediaStreams: [{
                Height: 1_080,
                Index: 0,
                IsInterlaced: false,
                Type: 'Video',
                VideoRangeType: 'SDR',
                Width: 1_920,
                ...videoStream
            }]
        }]
    };
}

describe('CustomPlaybackEligibility', () => {
    it('keeps an exact supported H264 route eligible for wrapper selection', () => {
        const item = createPlaybackSelectionItem({
            BitDepth: 8,
            Codec: 'H264',
            Profile: 'High'
        });

        expect(hasPotentialCustomPlaybackVideoRoute(item)).toBe(true);
    });

    it.each([
        [ 'MPEG-2', { AverageFrameRate: 29.97003, BitDepth: 8, Codec: 'MPEG2VIDEO', Height: 480, Profile: 'Main', Width: 720 }, 'mkv' ],
        [ 'H264', { BitDepth: 8, Codec: 'H264', Profile: 'High' }, 'mkv' ],
        [ 'Advanced VC-1', { AverageFrameRate: 29.97003, BitDepth: 8, Codec: 'VC1', Profile: 'Advanced' }, 'mkv' ]
    ])('keeps interlaced %s potential, as its frames weave both fields for the deinterlacing pass', (_label, videoStream, container) => {
        expect(hasPotentialCustomPlaybackVideoRoute(createPlaybackSelectionItem({ ...videoStream, IsInterlaced: true }, container))).toBe(true);
    });

    it.each([
        [ 'HEVC', { BitDepth: 10, Codec: 'HEVC', Profile: 'Main 10' }, 'mkv' ],
        [ 'JPEG 2000', { BitDepth: 12, Codec: 'JPEG2000', PixelFormat: 'yuv444p12le' }, 'mj2' ]
    ])('routes interlaced %s, which codes its fields apart, to the HTML player', (_label, videoStream, container) => {
        expect(hasPotentialCustomPlaybackVideoRoute(createPlaybackSelectionItem({ ...videoStream, IsInterlaced: true }, container))).toBe(false);
        expect(hasPotentialCustomPlaybackVideoRoute(createPlaybackSelectionItem(videoStream, container))).toBe(true);
    });

    it('presents interlaced video of every codec but those that code their fields apart', () => {
        for (const codec of CUSTOM_VIDEO_CODECS) {
            expect(presentsInterlacedVideo(codec)).toBe(!FIELDS_APART_VIDEO_CODECS.has(codec));
        }
    });

    it.each([
        // 10-bit AV1 and VP9 have only the raw I420P10 route, which Profile 0 cannot take
        [ '10-bit SDR VP9 Profile 0', {
            BitDepth: 10,
            Codec: 'VP9',
            Profile: 'Profile 0'
        } ],
        // 8-bit Main reconstructs only from its exact raw format, which its PixelFormat names
        [ '8-bit Dolby Vision 10.0 AV1 without a PixelFormat', {
            BitDepth: 8,
            BlPresentFlag: true,
            Codec: 'AV1',
            DvBlSignalCompatibilityId: 0,
            DvProfile: 10,
            Profile: 'Main',
            RpuPresentFlag: true,
            VideoRangeType: 'DOVI'
        } ],
        // AV1 carries no EL, and compatibility ID 0 declares no base
        [ 'dual-layer Dolby Vision AV1', {
            BitDepth: 10,
            BlPresentFlag: true,
            Codec: 'AV1',
            DvBlSignalCompatibilityId: 0,
            DvProfile: 7,
            ElPresentFlag: true,
            Profile: 'Main',
            RpuPresentFlag: true,
            VideoRangeType: 'DOVIWithEL'
        } ]
    ])('routes exact unsupported %s metadata to the HTML player', (_label, videoStream) => {
        const item = createPlaybackSelectionItem(videoStream);

        expect(hasPotentialCustomPlaybackVideoRoute(item)).toBe(false);
    });

    it.each([
        [ 'AV1 Main', { Codec: 'AV1', Profile: 'Main' } ],
        [ 'VP9 Profile 2', { Codec: 'VP9', Profile: 'Profile 2' } ],
        [ 'full-range AV1 Main', { Codec: 'AV1', ColorRange: 'pc', Profile: 'Main' } ],
        // Each matrix and primaries set has its own raw SDR key
        [ 'BT.601 AV1 Main', { Codec: 'AV1', ColorPrimaries: 'smpte170m', ColorSpace: 'smpte170m', ColorTransfer: 'smpte170m', Profile: 'Main' } ],
        [ 'BT.2020 VP9 Profile 2', { Codec: 'VP9', ColorPrimaries: 'bt2020', ColorSpace: 'bt2020nc', ColorTransfer: 'bt2020-10', Profile: 'Profile 2' } ],
        // HEVC Main 10 SDR also decodes natively, which presents BT.601 color
        [ 'BT.601 HEVC Main 10', {
            Codec: 'HEVC',
            ColorPrimaries: 'smpte170m',
            ColorSpace: 'smpte170m',
            ColorTransfer: 'smpte170m',
            Profile: 'Main 10'
        } ]
    ])('keeps 10-bit SDR %s eligible for wrapper selection', (_label, videoStream) => {
        const item = createPlaybackSelectionItem({
            AverageFrameRate: 24,
            BitDepth: 10,
            Height: 1_632,
            Width: 3_840,
            ...videoStream
        });

        expect(hasPotentialCustomPlaybackVideoRoute(item)).toBe(true);
    });

    it('keeps high-frame-rate progressive MPEG-2 eligible for wrapper selection', () => {
        const item = createPlaybackSelectionItem({
            AverageFrameRate: 120,
            BitDepth: 8,
            Codec: 'MPEG2VIDEO',
            Height: 2_160,
            Profile: 'Main',
            Width: 3_840
        });

        expect(hasPotentialCustomPlaybackVideoRoute(item)).toBe(true);
    });

    it('keeps exact HEVC Main 10 SDR metadata eligible for wrapper selection', () => {
        const item = createPlaybackSelectionItem({
            BitDepth: 10,
            Codec: 'HEVC',
            Profile: 'Main 10'
        });

        expect(hasPotentialCustomPlaybackVideoRoute(item)).toBe(true);
    });

    it('keeps exact progressive Advanced VC-1 metadata eligible for selection', () => {
        const item = createPlaybackSelectionItem({
            AverageFrameRate: 23.976,
            BitDepth: 8,
            Codec: 'VC1',
            Profile: 'Advanced'
        });

        expect(hasPotentialCustomPlaybackVideoRoute(item)).toBe(true);
    });

    // Only a decoder package decodes these, so the prefilter leaves profile, chroma, and depth to the host's packages
    it.each([
        [ '4:2:2 MPEG-2', { BitDepth: 8, Codec: 'MPEG2VIDEO', PixelFormat: 'yuv422p', Profile: '4:2:2' }, 'mkv' ],
        [ 'profile-less 4:4:4 MPEG-2', { BitDepth: 8, Codec: 'MPEG2VIDEO', PixelFormat: 'yuv444p', Profile: null }, 'mkv' ],
        [ '12-bit JPEG 2000', { BitDepth: 12, Codec: 'JPEG2000', PixelFormat: 'yuv444p12le' }, 'mj2' ],
        [ 'PQ JPEG 2000', {
            BitDepth: 12,
            Codec: 'JPEG2000',
            ColorPrimaries: 'bt2020',
            ColorSpace: 'bt2020nc',
            ColorTransfer: 'smpte2084',
            VideoRangeType: 'HDR10'
        }, 'mov' ]
    ])('keeps %s potential for its decoder packages', (_label, videoStream, container) => {
        expect(hasPotentialCustomPlaybackVideoRoute(createPlaybackSelectionItem(videoStream, container))).toBe(true);
    });

    it('rejects a VC-1 stream with a WMV3 profile, which FFmpeg names wmv3', () => {
        expect(hasPotentialCustomPlaybackVideoRoute(createPlaybackSelectionItem({ BitDepth: 8, Codec: 'VC1', Profile: 'Main' }))).toBe(false);
    });

    it('uses the requested media source instead of an unrelated supported alternate', () => {
        const unsupportedSource = (
            createPlaybackSelectionItem({
                BitDepth: 8,
                Codec: 'PRORES',
                Profile: null
            }, 'mkv', 'unsupported').MediaSources as unknown[]
        )[0];
        const supportedSource = (
            createPlaybackSelectionItem({
                BitDepth: 8,
                Codec: 'H264',
                Profile: 'High'
            }, 'mkv', 'supported').MediaSources as unknown[]
        )[0];
        const item = { MediaSources: [ supportedSource, unsupportedSource ] };

        expect(hasPotentialCustomPlaybackVideoRoute(item)).toBe(true);
        expect(hasPotentialCustomPlaybackVideoRoute(item, {
            mediaSourceId: 'unsupported'
        })).toBe(false);
    });

    it('does not reject wrapper selection when source metadata is unavailable', () => {
        expect(hasPotentialCustomPlaybackVideoRoute({ Id: 'metadata-pending' })).toBe(true);
    });

    it.each([
        [ 'interlace state', { BitDepth: 8, Codec: 'H264', Profile: 'High' }, {
            IsInterlaced: undefined
        } ],
        [ 'profile', { BitDepth: 8, Codec: 'H264' }, {} ],
        [ 'dimensions', { BitDepth: 8, Codec: 'H264', Profile: 'High' }, {
            Width: undefined
        } ],
        [ 'frame rate', { BitDepth: 8, Codec: 'MPEG2VIDEO', Profile: 'Main' }, {} ]
    ])('keeps the wrapper available when %s metadata is incomplete', (
        _label,
        videoStream,
        sourceOverrides
    ) => {
        const item = createPlaybackSelectionItem({
            ...videoStream,
            ...sourceOverrides
        });

        expect(hasPotentialCustomPlaybackVideoRoute(item)).toBe(true);
    });

    it('rejects a known unsupported codec even when unrelated metadata is incomplete', () => {
        const item = createPlaybackSelectionItem({
            BitDepth: undefined,
            Codec: 'PRORES',
            IsInterlaced: undefined,
            Profile: undefined
        });

        expect(hasPotentialCustomPlaybackVideoRoute(item)).toBe(false);
    });

    it.each([ 'MPEG2VIDEO', 'MPEG2', 'MPEG-2' ])(
        'decodes progressive Matroska MPEG-2 named %s only on an offered decoder package',
        (codecName) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = 'mkv';
            mediaSource.MediaStreams[0] = {
                AverageFrameRate: 24,
                BitDepth: 8,
                BitRate: 1_500_000_000,
                Codec: codecName,
                Height: 1_080,
                Index: 0,
                IsInterlaced: false,
                Profile: 'Main',
                Type: 'Video',
                VideoRangeType: 'SDR',
                Width: 1_920
            };

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toEqual({ eligible: false, reason: 'codec-unsupported' });
            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                {
                    allowRawHDR: false,
                    gpuVideoDecoders: createVideoDecoderOffers(MPEG2_VIDEO_PACKAGE),
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            )).toMatchObject({
                ...createPackageVideoRoute(MPEG2_VIDEO_PACKAGE, 'mpeg2video'),
                maximumCodedHeight: 1_080,
                maximumCodedWidth: 1_920,
                rawVideoFrameFormat: 'I420'
            });
        }
    );

    it('composes a VC-1 decoder package with an AC-3 audio decoder package', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mkv';
        mediaSource.MediaStreams[0] = {
            AverageFrameRate: 23.976,
            BitDepth: 8,
            Codec: 'VC1',
            Height: 1_080,
            Index: 0,
            IsInterlaced: false,
            Profile: 'Advanced',
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 1_920
        };
        mediaSource.MediaStreams[1] = {
            Channels: 2,
            Codec: 'ac3',
            Index: 1,
            SampleRate: 48_000,
            Type: 'Audio'
        };

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            {
                allowRawHDR: false,
                audioDecoders: AUDIO_PACKAGES,
                gpuVideoDecoders: createVideoDecoderOffers(VC1_VIDEO_PACKAGE),
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            ...createPackageVideoRoute(VC1_VIDEO_PACKAGE, 'vc1'),
            audioDecoder: { codec: 'ac3', source: { manifest: DOLBY_AUDIO_PACKAGE.manifest } },
            audioOutputMode: 'decoded-pcm',
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920
        });
    });

    it('composes a VC-1 decoder package with a 5.1 DTS audio decoder package', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mkv';
        mediaSource.MediaStreams[0] = {
            AverageFrameRate: 23.976,
            BitDepth: 8,
            Codec: 'VC1',
            Height: 1_080,
            Index: 0,
            IsInterlaced: false,
            Profile: 'Advanced',
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 1_920
        };
        mediaSource.MediaStreams[1] = {
            Channels: 6,
            Codec: 'dts',
            Index: 1,
            Profile: 'DTS',
            SampleRate: 48_000,
            Type: 'Audio'
        };

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            {
                allowRawHDR: false,
                audioDecoders: AUDIO_PACKAGES,
                gpuVideoDecoders: createVideoDecoderOffers(VC1_VIDEO_PACKAGE),
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            ...createPackageVideoRoute(VC1_VIDEO_PACKAGE, 'vc1'),
            audioDecoder: { codec: 'dts', source: { manifest: DTS_AUDIO_PACKAGE.manifest } },
            audioOutputMode: 'decoded-pcm',
            audioSourceChannelCount: 6
        });
    });

    it('composes a VC-1 decoder package with a TrueHD audio decoder package', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mkv';
        mediaSource.MediaStreams[0] = {
            AverageFrameRate: 23.976,
            BitDepth: 8,
            Codec: 'VC1',
            Height: 1_080,
            Index: 0,
            IsInterlaced: false,
            Profile: 'Advanced',
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 1_920
        };
        mediaSource.MediaStreams[1] = {
            Channels: 2,
            Codec: 'truehd',
            Index: 1,
            SampleRate: 48_000,
            Type: 'Audio'
        };

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            {
                allowRawHDR: false,
                audioDecoders: AUDIO_PACKAGES,
                gpuVideoDecoders: createVideoDecoderOffers(VC1_VIDEO_PACKAGE),
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            ...createPackageVideoRoute(VC1_VIDEO_PACKAGE, 'vc1'),
            audioDecoder: { codec: 'truehd', source: { manifest: TRUEHD_AUDIO_PACKAGE.manifest } },
            audioOutputMode: 'decoded-pcm',
            audioSourceChannelCount: 2
        });
    });

    it('composes a JPEG 2000 decoder package with Mediabunny PCM audio', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mj2';
        mediaSource.MediaStreams[0] = {
            AverageFrameRate: 24,
            BitDepth: 8,
            Codec: 'JPEG2000',
            Height: 540,
            Index: 0,
            IsInterlaced: false,
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 960
        };
        mediaSource.MediaStreams[1] = {
            Channels: 2,
            Codec: 'pcm_s16le',
            Index: 1,
            SampleRate: 48_000,
            Type: 'Audio'
        };

        const eligibility = getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            {
                allowRawHDR: false,
                gpuVideoDecoders: createVideoDecoderOffers(JPEG2000_VIDEO_PACKAGE),
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        );

        expect(eligibility).toMatchObject({
            ...createPackageVideoRoute(JPEG2000_VIDEO_PACKAGE, 'jpeg2000'),
            audioOutputMode: 'decoded-pcm',
            audioSourceChannelCount: 2
        });
        expect(eligibility).not.toHaveProperty('audioDecoder');
    });

    it('presents interlaced VC-1 on its decoder package, whose frames weave both fields, and refuses interlaced JPEG 2000, a codestream per field', () => {
        const createInterlacedOptions = (container: string, videoStream: Record<string, unknown>): Record<string, unknown> => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[0] = { Height: 1_080, Index: 0, IsInterlaced: true, Type: 'Video', VideoRangeType: 'SDR', Width: 1_920, ...videoStream };
            return options;
        };
        const vc1Options = createInterlacedOptions('mkv', { AverageFrameRate: 29.97, BitDepth: 8, Codec: 'VC1', Profile: 'Advanced' });
        const jpeg2000Options = createInterlacedOptions('mj2', { AverageFrameRate: 29.97, BitDepth: 8, Codec: 'JPEG2000' });

        expect(getCustomPlaybackEligibility(vc1Options, createCapabilities(), {
            allowRawHDR: false,
            gpuVideoDecoders: createVideoDecoderOffers(VC1_VIDEO_PACKAGE),
            runtimeAvailability: AVAILABLE_RUNTIME
        })).toMatchObject(createPackageVideoRoute(VC1_VIDEO_PACKAGE, 'vc1'));
        expect(getCustomPlaybackEligibility(jpeg2000Options, createCapabilities(), {
            allowRawHDR: false,
            gpuVideoDecoders: createVideoDecoderOffers(JPEG2000_VIDEO_PACKAGE),
            runtimeAvailability: AVAILABLE_RUNTIME
        })).toEqual({ eligible: false, reason: 'interlaced-video-unsupported' });
    });

    // A decoder package's own stream constraint, not the stream's profile, bounds what it takes
    it.each([
        [ 'no offered package', { AverageFrameRate: 24 }, 'mkv', false, false ],
        [ 'high frame rate', { AverageFrameRate: 120 }, 'mkv', true, true ],
        [ 'larger width', { AverageFrameRate: 24, Width: 7_680 }, 'mkv', true, true ],
        [ 'larger height', { AverageFrameRate: 24, Height: 4_320 }, 'mkv', true, true ],
        [ 'a bit depth the package does not write', { AverageFrameRate: 24, BitDepth: 10 }, 'mkv', true, false ],
        [ 'non-Main profile', { AverageFrameRate: 24, Profile: 'Simple' }, 'mkv', true, true ],
        [ 'missing profile', { AverageFrameRate: 24, Profile: null }, 'mkv', true, true ],
        // Its decoder weaves field pictures into frames, which the deinterlacing pass presents
        [ 'interlaced frames', { AverageFrameRate: 24, IsInterlaced: true }, 'mkv', true, true ],
        // The fork's demuxer reads MPEG-2 in MPEG-TS and M2TS; the mpegts alias names no rule
        [ 'MPEG-TS container', { AverageFrameRate: 24 }, 'ts', true, true ],
        [ 'MPEG-TS alias container', { AverageFrameRate: 24 }, 'mpegts', true, false ],
        [ 'MTS container', { AverageFrameRate: 24 }, 'mts', true, true ],
        [ 'M2TS container', { AverageFrameRate: 24 }, 'm2ts', true, true ],
        [ 'MPEG-PS container', { AverageFrameRate: 24 }, 'mpegps', true, false ],
        [ 'MPEG container', { AverageFrameRate: 24 }, 'mpeg', true, false ],
        [ 'MPG container', { AverageFrameRate: 24 }, 'mpg', true, false ],
        [ 'VOB container', { AverageFrameRate: 24 }, 'vob', true, false ],
        [ 'MOV container', { AverageFrameRate: 24 }, 'mov', true, false ],
        [ 'MP4 container', { AverageFrameRate: 24 }, 'mp4', true, false ],
        [ 'other container', { AverageFrameRate: 24 }, 'webm', true, false ]
    ] as const)(
        'handles MPEG-2 with %s',
        (_label, metadataOverride, container, offerPackage, expectedEligible) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[0] = {
                BitDepth: 8,
                Codec: 'MPEG2VIDEO',
                Height: 1_080,
                Index: 0,
                IsInterlaced: false,
                Profile: 'Main',
                Type: 'Video',
                VideoRangeType: 'SDR',
                Width: 1_920,
                ...metadataOverride
            };

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                {
                    allowRawHDR: false,
                    gpuVideoDecoders: offerPackage ? createVideoDecoderOffers(MPEG2_VIDEO_PACKAGE) : [],
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            ).eligible).toBe(expectedEligible);
        }
    );

    // The pixel format names the chroma subsampling a package must write
    it.each([
        [ 'yuv420p', 'Main', 'I420' ],
        [ 'yuv422p', '4:2:2', 'I422' ],
        [ 'yuv444p', null, 'I444' ]
    ] as const)('decodes MPEG-2 in %s into the frame pool format holding it', (pixelFormat, profile, format) => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mkv';
        mediaSource.MediaStreams[0] = {
            AverageFrameRate: 25,
            BitDepth: 8,
            Codec: 'MPEG2VIDEO',
            Height: 576,
            Index: 0,
            IsInterlaced: false,
            PixelFormat: pixelFormat,
            Profile: profile,
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 720
        };

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            {
                allowRawHDR: false,
                gpuVideoDecoders: createVideoDecoderOffers(MPEG2_CHROMA_VIDEO_PACKAGE),
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            ...createPackageVideoRoute(MPEG2_CHROMA_VIDEO_PACKAGE, 'mpeg2video'),
            rawVideoFrameFormat: format
        });
    });

    it.each([
        [ 'a package that writes only 4:2:0', MPEG2_VIDEO_PACKAGE, { PixelFormat: 'yuv422p' } ],
        [ 'a pixel format no frame pool holds', MPEG2_CHROMA_VIDEO_PACKAGE, { PixelFormat: 'yuv411p' } ],
        [ 'a BitDepth its pixel format contradicts', MPEG2_CHROMA_VIDEO_PACKAGE, { BitDepth: 10, PixelFormat: 'yuv422p' } ]
    ] as const)('leaves 4:2:2 MPEG-2 ineligible with %s', (_label, decoderPackage, metadataOverride) => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mkv';
        mediaSource.MediaStreams[0] = {
            AverageFrameRate: 25,
            BitDepth: 8,
            Codec: 'MPEG2VIDEO',
            Height: 576,
            Index: 0,
            IsInterlaced: false,
            Profile: '4:2:2',
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 720,
            ...metadataOverride
        };

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            {
                allowRawHDR: false,
                gpuVideoDecoders: createVideoDecoderOffers(decoderPackage),
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        ).eligible).toBe(false);
    });

    // MPEG-1 is its own codec, as FFmpeg names it, so a package that accepts only MPEG-2 is never offered it
    it.each([
        [ 'a package that accepts MPEG-1', MPEG_VIDEO_PACKAGE, true ],
        [ 'a package that accepts only MPEG-2', MPEG2_CHROMA_VIDEO_PACKAGE, false ]
    ] as const)('decodes Matroska MPEG-1 only on %s', (_label, decoderPackage, expectedEligible) => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mkv';
        mediaSource.MediaStreams[0] = {
            AverageFrameRate: 25,
            BitDepth: 8,
            Codec: 'mpeg1video',
            Height: 288,
            Index: 0,
            IsInterlaced: false,
            PixelFormat: 'yuv420p',
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 352
        };

        const eligibility = getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            {
                allowRawHDR: false,
                gpuVideoDecoders: createVideoDecoderOffers(decoderPackage),
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        );
        if (expectedEligible) {
            expect(eligibility).toMatchObject({ ...createPackageVideoRoute(decoderPackage, 'mpeg1video'), rawVideoFrameFormat: 'I420' });
        } else {
            expect(eligibility.eligible).toBe(false);
        }
    });

    // A 9-bit stream decodes into 10-bit planes, its samples shifted up; an 11-bit one would present dark in 12-bit planes, so it has no route
    it.each([
        [ '9-bit samples in 10-bit planes', 9, 'yuv444p9le', true ],
        [ '11-bit samples in 12-bit planes', 11, 'yuv444p12le', false ]
    ] as const)('decides JPEG 2000 with %s', (_label, bitDepth, pixelFormat, expectedEligible) => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mj2';
        mediaSource.MediaStreams[0] = {
            AverageFrameRate: 24,
            BitDepth: bitDepth,
            Codec: 'JPEG2000',
            Height: 1_080,
            Index: 0,
            IsInterlaced: false,
            PixelFormat: pixelFormat,
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 1_920
        };

        const eligibility = getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            {
                allowRawHDR: false,
                gpuVideoDecoders: createVideoDecoderOffers(JPEG2000_DEEP_VIDEO_PACKAGE),
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        );
        if (expectedEligible) {
            expect(eligibility).toMatchObject({ ...createPackageVideoRoute(JPEG2000_DEEP_VIDEO_PACKAGE, 'jpeg2000'), rawVideoFrameFormat: 'I444P10' });
        } else {
            expect(eligibility.eligible).toBe(false);
        }
    });

    it('takes the pixel format\'s depth when the stream declares no BitDepth', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mj2';
        mediaSource.MediaStreams[0] = {
            AverageFrameRate: 24,
            Codec: 'JPEG2000',
            Height: 1_080,
            Index: 0,
            IsInterlaced: false,
            PixelFormat: 'yuv444p10le',
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 1_920
        };

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            {
                allowRawHDR: false,
                gpuVideoDecoders: createVideoDecoderOffers(JPEG2000_DEEP_VIDEO_PACKAGE),
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            ...createPackageVideoRoute(JPEG2000_DEEP_VIDEO_PACKAGE, 'jpeg2000'),
            rawVideoFrameFormat: 'I444P10'
        });
    });

    it.each([ 'JPEG2000', 'JPEG 2000', 'J2K' ])(
        'decodes MJ2 JPEG 2000 named %s only on an offered decoder package',
        (codecName) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = 'mj2';
            mediaSource.MediaStreams[0] = {
                AverageFrameRate: 24,
                BitDepth: 8,
                Codec: codecName,
                Height: 540,
                Index: 0,
                IsInterlaced: false,
                Type: 'Video',
                VideoRangeType: 'SDR',
                Width: 960
            };

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toEqual({ eligible: false, reason: 'codec-unsupported' });
            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                {
                    allowRawHDR: false,
                    gpuVideoDecoders: createVideoDecoderOffers(JPEG2000_VIDEO_PACKAGE),
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            )).toMatchObject({
                ...createPackageVideoRoute(JPEG2000_VIDEO_PACKAGE, 'jpeg2000'),
                maximumCodedHeight: 540,
                maximumCodedWidth: 960,
                rawVideoFrameFormat: 'I420'
            });
        }
    );

    it.each([
        [ 'no offered package', { AverageFrameRate: 24 }, 'mj2', false, false ],
        [ 'high frame rate', { AverageFrameRate: 120 }, 'mj2', true, true ],
        [ 'larger width', { AverageFrameRate: 24, Width: 7_680 }, 'mj2', true, true ],
        [ 'larger height', { AverageFrameRate: 24, Height: 4_320 }, 'mj2', true, true ],
        [ 'a bit depth the package does not write', { AverageFrameRate: 24, BitDepth: 10 }, 'mj2', true, false ],
        [ 'unqualified container', { AverageFrameRate: 24 }, 'mp4', true, false ]
    ] as const)(
        'handles JPEG 2000 with %s',
        (_label, metadataOverride, container, offerPackage, expectedEligible) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[0] = {
                BitDepth: 8,
                Codec: 'JPEG2000',
                Height: 540,
                Index: 0,
                IsInterlaced: false,
                Type: 'Video',
                VideoRangeType: 'SDR',
                Width: 960,
                ...metadataOverride
            };

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                {
                    allowRawHDR: false,
                    gpuVideoDecoders: offerPackage ? createVideoDecoderOffers(JPEG2000_VIDEO_PACKAGE) : [],
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            ).eligible).toBe(expectedEligible);
        }
    );

    it.each([
        [ 'untagged, as Jellyfin reports it', {}, 'mkv', true ],
        [ 'tagged BT.709 limited range', { ColorPrimaries: 'bt709', ColorSpace: 'bt709', ColorTransfer: 'bt709' }, 'mkv', true ],
        [ 'in MJ2', {}, 'mj2', true ],
        [ 'tagged BT.2020 primaries, which the decoder\'s BT.709 Y\'CbCr would misstate', { ColorPrimaries: 'bt2020' }, 'mkv', false ],
        [ 'tagged full range', { ColorRange: 'pc' }, 'mkv', false ],
        [ 'a BitDepth other than its 12-bit samples', { BitDepth: 10 }, 'mkv', false ]
    ] as const)('decodes Digital Cinema JPEG 2000 in X\'Y\'Z\' %s into 12-bit 4:4:4 on its package', (_label, metadataOverride, container, expectedEligible) => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = container;
        mediaSource.MediaStreams[0] = {
            AverageFrameRate: 24,
            BitDepth: 12,
            Codec: 'jpeg2000',
            Height: 858,
            Index: 0,
            IsInterlaced: false,
            PixelFormat: 'xyz12le',
            Profile: 'JPEG 2000 digital cinema 2K',
            Type: 'Video',
            VideoRange: 'SDR',
            VideoRangeType: 'SDR',
            Width: 2_048,
            ...metadataOverride
        };

        const eligibility = getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            {
                allowRawHDR: false,
                gpuVideoDecoders: createVideoDecoderOffers(JPEG2000_PROJECT_VIDEO_PACKAGE),
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        );
        if (expectedEligible) {
            expect(eligibility).toMatchObject({ ...createPackageVideoRoute(JPEG2000_PROJECT_VIDEO_PACKAGE, 'jpeg2000'), rawVideoFrameFormat: 'I444P12' });
        } else {
            expect(eligibility.eligible).toBe(false);
        }
    });

    it('takes X\'Y\'Z\' only from JPEG 2000, and only on a package that writes 12-bit 4:4:4', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mkv';
        const stream = { BitDepth: 12, Height: 858, Index: 0, IsInterlaced: false, PixelFormat: 'xyz12le', Type: 'Video', VideoRangeType: 'SDR', Width: 2_048 };
        const eligible = (codec: string, decoderPackage: VideoDecoderPackage): boolean => {
            mediaSource.MediaStreams[0] = { ...stream, Codec: codec };
            return getCustomPlaybackEligibility(options, createCapabilities(), {
                allowRawHDR: false,
                gpuVideoDecoders: createVideoDecoderOffers(decoderPackage),
                runtimeAvailability: AVAILABLE_RUNTIME
            }).eligible;
        };

        expect(eligible('jpeg2000', JPEG2000_PROJECT_VIDEO_PACKAGE)).toBe(true);
        expect(eligible('jpeg2000', JPEG2000_DEEP_VIDEO_PACKAGE)).toBe(false);
        expect(eligible('hevc', HEVC_VIDEO_PACKAGE)).toBe(false);
    });

    it.each([
        [ 'missing', undefined ],
        [ 'arbitrarily high', 1_500_000_000 ]
    ])('decodes HEVC Main that no native route takes on the HEVC decoder package with %s source bitrate', (_label, bitrate) => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0] = {
            AverageFrameRate: 24,
            BitDepth: 8,
            BitRate: bitrate,
            Codec: 'hevc',
            Height: 1_080,
            Index: 0,
            IsInterlaced: false,
            Level: 120,
            Profile: 'Main',
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 1_920
        };

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilitiesWithoutNativeHEVC(),
            {
                allowRawHDR: false,
                gpuVideoDecoders: createVideoDecoderOffers(HEVC_VIDEO_PACKAGE),
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            ...createPackageVideoRoute(HEVC_VIDEO_PACKAGE, 'hevc'),
            rawVideoFrameFormat: 'I420'
        });
    });

    it.each([
        [ 'missing frame rate', { AverageFrameRate: undefined } ],
        [ 'non-finite frame rate', { AverageFrameRate: Number.NaN } ],
        [ 'high frame rate', { AverageFrameRate: 120 } ],
        [ 'missing level', { Level: undefined } ],
        [ 'high level', { Level: 186 } ]
    ])('decodes HEVC Main on the HEVC decoder package independently of %s', (_label, metadataOverride) => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0] = {
            AverageFrameRate: 24,
            BitDepth: 8,
            BitRate: 12_000_000,
            Codec: 'hevc',
            Height: 1_080,
            Index: 0,
            IsInterlaced: false,
            Level: 120,
            Profile: 'Main',
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 1_920,
            ...metadataOverride
        };

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilitiesWithoutNativeHEVC(),
            {
                allowRawHDR: false,
                gpuVideoDecoders: createVideoDecoderOffers(HEVC_VIDEO_PACKAGE),
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            ...createPackageVideoRoute(HEVC_VIDEO_PACKAGE, 'hevc'),
            rawVideoFrameFormat: 'I420'
        });
    });

    it.each([
        { height: ULTRA_HD_CODED_HEIGHT, label: 'UHD', width: ULTRA_HD_CODED_WIDTH },
        { height: DCI_4K_CODED_HEIGHT, label: 'DCI 4K', width: DCI_4K_CODED_WIDTH }
    ])('takes a $label frame that no native route decodes on the HEVC decoder package', ({ height, width }) => {
        // Neither HEVC Main nor Main 10 decodes natively, and the raw Main 10 planes need a presentation authorization
        const capabilities = createCapabilitiesWithoutNativeHEVC();
        const eligibilityOptions = {
            allowFramePoolHDR: true,
            allowRawHDR: false,
            gpuVideoDecoders: createVideoDecoderOffers(HEVC_VIDEO_PACKAGE),
            runtimeAvailability: AVAILABLE_RUNTIME
        };
        const createHEVCOptions = (videoStream: Record<string, unknown>): Record<string, unknown> => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.MediaStreams[0] = {
                Codec: 'hevc',
                Height: height,
                Index: 0,
                IsInterlaced: false,
                Type: 'Video',
                Width: width,
                ...videoStream
            };
            return options;
        };

        expect(getCustomPlaybackEligibility(
            createHEVCOptions({ BitDepth: 8, Profile: 'Main', VideoRangeType: 'SDR' }),
            capabilities,
            eligibilityOptions
        )).toMatchObject({
            ...createPackageVideoRoute(HEVC_VIDEO_PACKAGE, 'hevc'),
            hdr: false,
            maximumCodedHeight: height,
            maximumCodedWidth: width,
            rawVideoFrameFormat: 'I420'
        });
        expect(getCustomPlaybackEligibility(
            createHEVCOptions({
                BitDepth: 10,
                ColorPrimaries: 'bt2020',
                ColorSpace: 'bt2020nc',
                ColorTransfer: 'smpte2084',
                Profile: 'Main 10',
                VideoRange: 'HDR',
                VideoRangeType: 'HDR10'
            }),
            capabilities,
            eligibilityOptions
        )).toMatchObject({
            ...createPackageVideoRoute(HEVC_VIDEO_PACKAGE, 'hevc'),
            hdr: true,
            rawVideoFrameFormat: 'I420P10'
        });
    });

    it.each([
        'Constrained Baseline',
        'Baseline',
        'Main'
    ])('accepts exact verified H264 profile %s', profile => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0].Profile = profile;

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({ eligible: true, videoOutputMode: 'video-frame' });
    });

    it('rejects H264 when exact profile evidence is absent', () => {
        const capabilities = createCapabilities();
        delete capabilities.h264Profiles;

        expect(getCustomPlaybackEligibility(
            createOptions(),
            capabilities,
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });
    });

    it.each([
        { colorPrimaries: 'smpte170m', colorSpace: 'smpte170m', colorTransfer: 'bt709' },
        { colorPrimaries: 'smpte170m', colorSpace: 'smpte170m', colorTransfer: 'smpte170m' }
    ])(
        'selects native H.264 SDR tagged with SMPTE 170M color and $colorTransfer transfer',
        ({ colorPrimaries, colorSpace, colorTransfer }) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.MediaStreams[0] = {
                BitDepth: 8,
                Codec: 'h264',
                ColorPrimaries: colorPrimaries,
                ColorSpace: colorSpace,
                ColorTransfer: colorTransfer,
                Height: 528,
                Index: 0,
                IsInterlaced: false,
                Profile: 'High',
                Type: 'Video',
                VideoRangeType: 'SDR',
                Width: 704
            };

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                eligible: true,
                hdr: false,
                maximumCodedHeight: 528,
                maximumCodedWidth: 704,
                rawVideoFrameFormat: null,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame'
            });
        }
    );

    it('selects typed video and audio ordinals with integer-microsecond timing', () => {
        expect(getCustomPlaybackEligibility(
            createOptions(),
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({
            audioTrackIndex: 0,
            durationMicroseconds: 6_000_000,
            eligible: true,
            hdr: false,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 1_000_000,
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        });
    });

    it('translates non-contiguous Jellyfin indexes across interleaved stream types', () => {
        const options = createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 41,
                MediaStreams: [
                    { Codec: 'subrip', Index: 3, Type: 'Subtitle' },
                    { Channels: 2, Codec: 'opus', Index: 41, SampleRate: 48_000, Type: 'Audio' },
                    {
                        BitDepth: 8,
                        Codec: 'h264',
                        Height: 1_080,
                        Index: 9,
                        IsInterlaced: false,
                        Profile: 'High',
                        Type: 'Video',
                        VideoRangeType: 'SDR',
                        Width: 1_920
                    },
                    { Codec: 'bin_data', Index: 17, Type: 'Data' },
                    { Channels: 2, Codec: 'aac', Index: 24, SampleRate: 48_000, Type: 'Audio' },
                    { Codec: 'ass', Index: 30, Type: 'Subtitle' }
                ],
                RunTimeTicks: 60_000_000
            }
        });

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({
            audioTrackIndex: 1,
            eligible: true,
            videoTrackIndex: 0
        });
    });

    describe('external streams', () => {
        const EMBEDDED_VIDEO_STREAM = {
            BitDepth: 8,
            Codec: 'h264',
            Height: 1_080,
            Index: 1,
            IsExternal: false,
            IsInterlaced: false,
            Profile: 'High',
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 1_920
        };
        // Jellyfin numbers an external file's streams before the container's
        const EXTERNAL_AUDIO_STREAM = { Channels: 2, Codec: 'aac', Index: 0, IsExternal: true, SampleRate: 48_000, Type: 'Audio' };

        function createExternalAudioOptions(defaultAudioStreamIndex: number | null): unknown {
            return createOptions({
                mediaSource: {
                    Container: 'mkv',
                    DefaultAudioStreamIndex: defaultAudioStreamIndex,
                    MediaStreams: [
                        EXTERNAL_AUDIO_STREAM,
                        EMBEDDED_VIDEO_STREAM,
                        { Channels: 2, Codec: 'opus', Index: 2, IsExternal: false, SampleRate: 48_000, Type: 'Audio' },
                        { Channels: 2, Codec: 'aac', Index: 3, SampleRate: 48_000, Type: 'Audio' }
                    ],
                    RunTimeTicks: 60_000_000
                }
            });
        }

        it.each([
            { audioTrackIndex: 0, defaultAudioStreamIndex: 2 },
            { audioTrackIndex: 1, defaultAudioStreamIndex: 3 }
        ])('counts embedded audio stream $defaultAudioStreamIndex as container ordinal $audioTrackIndex past an external one', ({ audioTrackIndex, defaultAudioStreamIndex }) => {
            expect(getCustomPlaybackEligibility(
                createExternalAudioOptions(defaultAudioStreamIndex),
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({ audioTrackIndex, eligible: true, videoTrackIndex: 0 });
        });

        it('refuses a selected external audio stream, which the container does not hold, rather than play an embedded one', () => {
            expect(getCustomPlaybackEligibility(
                createExternalAudioOptions(0),
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toEqual({ eligible: false, reason: 'audio-track-external' });
        });

        it('takes the first audio stream by index without a selection, which an external one can be', () => {
            expect(getCustomPlaybackEligibility(
                createExternalAudioOptions(null),
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toEqual({ eligible: false, reason: 'audio-track-external' });
        });

        it('selects the codec of the embedded audio stream, not the external one before it', () => {
            expect(getPlaybackAudioCodec(createExternalAudioOptions(2))).toBe('opus');
            expect(getPlaybackAudioCodec(createExternalAudioOptions(0))).toBeNull();
        });

        it('presents the first embedded video stream, past an external one of a codec no route plays', () => {
            const options = createOptions({
                mediaSource: {
                    Container: 'mkv',
                    DefaultAudioStreamIndex: 2,
                    MediaStreams: [
                        { ...EMBEDDED_VIDEO_STREAM, Codec: 'prores', Index: 0, IsExternal: true, Profile: 'HQ' },
                        EMBEDDED_VIDEO_STREAM,
                        { Channels: 2, Codec: 'opus', Index: 2, SampleRate: 48_000, Type: 'Audio' }
                    ],
                    RunTimeTicks: 60_000_000
                }
            });

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({ audioTrackIndex: 0, eligible: true, videoTrackIndex: 0 });
        });
    });

    it.each([
        { audioCodec: 'ac3', codec: 'ac3' },
        { audioCodec: 'AC-3', codec: 'ac3' },
        { audioCodec: 'eac3', codec: 'eac3' },
        { audioCodec: 'E-AC-3', codec: 'eac3' },
        { audioCodec: 'ec-3', codec: 'eac3' }
    ])(
        'decodes Dolby audio named $audioCodec only on an audio decoder package',
        ({ audioCodec, codec }) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                MediaStreams: Array<{ Codec: string }>
            };
            mediaSource.MediaStreams[1].Codec = audioCodec;

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toEqual({ eligible: false, reason: 'audio-codec-unsupported' });
            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioDecoder: { codec, source: { manifest: DOLBY_AUDIO_PACKAGE.manifest } },
                audioOutputMode: 'decoded-pcm',
                audioTrackIndex: 0,
                eligible: true
            });
        }
    );

    it.each([
        { channelCount: 4, expected: { eligible: false, reason: 'audio-layout-unsupported' } },
        { channelCount: 5, expected: { audioOutputMode: 'decoded-pcm', audioSourceChannelCount: 5, eligible: true } },
        { channelCount: 6, expected: { audioOutputMode: 'decoded-pcm', audioSourceChannelCount: 6, eligible: true } }
    ])('decodes $channelCount-channel AC-3 on its package as the 3/2 bed decodes, with and without its LFE', ({ channelCount, expected }) => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[1] = { ...mediaSource.MediaStreams[1], Channels: channelCount, Codec: 'ac3', SampleRate: 48_000 };

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject(expected);
    });

    it('hands playback Jellyfin\'s channel count of the selected track as its metadata layout, and none without audio', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            DefaultAudioStreamIndex?: number | null
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[1] = { ...mediaSource.MediaStreams[1], Channels: 6, Codec: 'ac3', SampleRate: 48_000 };
        const eligibility = getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: AVAILABLE_RUNTIME }
        );
        mediaSource.DefaultAudioStreamIndex = null;
        mediaSource.MediaStreams.splice(1, 1);
        const silentEligibility = getCustomPlaybackEligibility(options, createCapabilities(), { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME });

        expect(eligibility.eligible && getAudioMetadataLayout(eligibility)).toEqual({ channelCount: 6 });
        expect(silentEligibility).toMatchObject({ audioTrackIndex: null, eligible: true });
        expect(silentEligibility.eligible && getAudioMetadataLayout(silentEligibility)).toBeUndefined();
    });

    it.each([ 8, 16, 20, 24, 32 ])(
        'accepts qualified stereo FLAC independently of its %i-bit source depth',
        bitDepth => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = 'mkv';
            mediaSource.MediaStreams[1] = {
                BitDepth: bitDepth,
                Channels: 2,
                Codec: 'flac',
                Index: 1,
                SampleRate: 48_000,
                Type: 'Audio'
            };

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioOutputMode: 'decoded-pcm',
                audioSourceChannelCount: 2,
                eligible: true
            });
        }
    );

    it.each([
        [ 3_000, undefined ],
        [ 8_000, 1 ],
        [ 12_345, 1_500_000_000 ],
        [ 44_100, 1_000_000 ],
        [ 48_000, 1_300_000 ],
        [ 88_200, 5_000_000 ],
        [ 96_000, 50_000_000 ],
        [ 176_400, 500_000_000 ],
        [ 192_000, 2_000_000_000 ]
    ] as const)(
        'accepts 24-bit stereo FLAC at %i Hz independently of encoded bitrate %s',
        (sampleRate, bitrate) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = 'mkv';
            mediaSource.MediaStreams[1] = {
                BitDepth: 24,
                BitRate: bitrate,
                Channels: 2,
                Codec: 'flac',
                Index: 1,
                SampleRate: sampleRate,
                Type: 'Audio'
            };

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioOutputMode: 'decoded-pcm',
                audioSourceChannelCount: 2,
                eligible: true
            });
        }
    );

    it.each([
        { eligible: true, sampleRate: SUB_3_KHZ_SAMPLE_RATE },
        { eligible: true, sampleRate: ABOVE_192_KHZ_SAMPLE_RATE },
        { eligible: true, sampleRate: DXD_SAMPLE_RATE },
        { eligible: true, sampleRate: DOUBLE_DXD_SAMPLE_RATE },
        { eligible: false, sampleRate: ZERO_SAMPLE_RATE },
        { eligible: false, sampleRate: FRACTIONAL_SAMPLE_RATE }
    ])('decides stereo FLAC at $sampleRate Hz only by whether the rate is well formed', ({
        eligible,
        sampleRate
    }) => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mkv';
        mediaSource.MediaStreams[1] = {
            BitDepth: 24,
            BitRate: 1_300_000,
            Channels: 2,
            Codec: 'flac',
            Index: 1,
            SampleRate: sampleRate,
            Type: 'Audio'
        };

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject(eligible ?
            { audioOutputMode: 'decoded-pcm', eligible: true } :
            { eligible: false, reason: 'audio-layout-unsupported' });
    });

    it.each([
        [ 'webm', 'h264', 'High', 'opus' ],
        [ 'ts', 'vp9', 'Profile 0', 'aac' ],
        [ 'webm', 'vp9', 'Profile 0', 'ac3' ]
    ])(
        'rejects unsupported %s/%s/%s/%s container combinations',
        (container, videoCodec, videoProfile, audioCodec) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[0].Codec = videoCodec;
            mediaSource.MediaStreams[0].Profile = videoProfile;
            mediaSource.MediaStreams[1].Codec = audioCodec;

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toEqual({ eligible: false, reason: 'container-unsupported' });
        }
    );

    it('selects raw-plane output for an allowed HEVC/PQ Matroska source', () => {
        const hdrOptions = createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 1,
                MediaStreams: [
                    {
                        BitDepth: 10,
                        BitRate: 40_000_000,
                        Codec: 'hevc',
                        ColorPrimaries: 'bt2020',
                        ColorRange: 'tv',
                        ColorSpace: 'bt2020nc',
                        ColorTransfer: 'smpte2084',
                        Height: 2_160,
                        Index: 0,
                        IsInterlaced: false,
                        Level: 153,
                        Profile: 'Main 10',
                        RealFrameRate: 24,
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'HDR10',
                        Width: 3_840
                    },
                    { Channels: 2, Codec: 'flac', Index: 1, SampleRate: 48_000, Type: 'Audio' }
                ],
                RunTimeTicks: 60_000_000
            }
        });

        expect(getCustomPlaybackEligibility(
            hdrOptions,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
        expect(getCustomPlaybackEligibility(
            hdrOptions,
            createCapabilities(),
            { allowRawHDR: true, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
        expect(getCustomPlaybackEligibility(
            hdrOptions,
            createCapabilities(),
            {
                allowNativeHDR: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
        expect(getCustomPlaybackEligibility(
            hdrOptions,
            createCapabilities(),
            {
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:pq-v1'
                ],
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            eligible: true,
            hdr: true,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true,
            rawVideoFrameFormat: null,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
        const nativeHDRMediaSource = hdrOptions.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        for (const bitrate of [ undefined, 1_500_000_000 ]) {
            nativeHDRMediaSource.MediaStreams[0].BitRate = bitrate;
            expect(getCustomPlaybackEligibility(
                hdrOptions,
                createCapabilities(),
                {
                    allowNativeHDR: true,
                    allowRawHDR: false,
                    authorizedExternalHDRRouteKeys: [
                        'external-hevc-main10-bt709-limited:pq-v1'
                    ],
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            )).toMatchObject({
                eligible: true,
                nativeHDRTransfer: 'pq',
                videoDecoderBackend: 'native'
            });
        }
        nativeHDRMediaSource.MediaStreams[0].BitRate = 40_000_000;
        delete nativeHDRMediaSource.MediaStreams[0].ColorRange;
        expect(getCustomPlaybackEligibility(
            hdrOptions,
            createCapabilities(),
            {
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:pq-v1'
                ],
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            eligible: true,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true
        });
        nativeHDRMediaSource.MediaStreams[0].ColorRange = 'tv';
        expect(getCustomPlaybackEligibility(
            hdrOptions,
            createCapabilities(),
            {
                allowRawHDR: true,
                authorizedRawHDRRouteKeys: [
                    'I420P10:bt2020-ncl:bt2020:limited:hlg'
                ],
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
        expect(getCustomPlaybackEligibility(hdrOptions, createCapabilities(), PQ_AUTHORIZATION)).toMatchObject({
            eligible: true,
            hdr: true,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        });
    });

    it.each([
        { field: 'Profile', label: 'profile', value: 'Main' },
        { field: 'BitDepth', label: 'bit depth', value: 8 },
        { field: 'ColorTransfer', label: 'transfer authorization', value: 'arib-std-b67' }
    ] as const)(
        'rejects native HDR outside its exact $label bound',
        ({ field, value }) => {
            const options = createOptions({
                mediaSource: {
                    Container: 'mkv',
                    DefaultAudioStreamIndex: 1,
                    MediaStreams: [ {
                        BitDepth: 10,
                        BitRate: 40_000_000,
                        Codec: 'hevc',
                        ColorPrimaries: 'bt2020',
                        ColorRange: 'tv',
                        ColorSpace: 'bt2020nc',
                        ColorTransfer: 'smpte2084',
                        Height: 2_160,
                        Index: 0,
                        IsInterlaced: false,
                        Level: 153,
                        Profile: 'Main 10',
                        RealFrameRate: 60,
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'HDR10',
                        Width: 3_840
                    }, {
                        Channels: 2,
                        Codec: 'flac',
                        Index: 1,
                        SampleRate: 48_000,
                        Type: 'Audio'
                    } ],
                    RunTimeTicks: 60_000_000
                }
            });
            const mediaSource = options.mediaSource as {
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.MediaStreams[0][field] = value;

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                {
                    allowNativeHDR: true,
                    allowRawHDR: false,
                    authorizedExternalHDRRouteKeys: [
                        'external-hevc-main10-bt709-limited:pq-v1'
                    ],
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            ).eligible).toBe(false);
        }
    );

    it('uses source dimensions beyond the qualification vector for native HDR', () => {
        const options = createOptions({
            mediaSource: {
                Container: 'mkv',
                MediaStreams: [ {
                    BitDepth: 10,
                    Codec: 'hevc',
                    ColorPrimaries: 'bt2020',
                    ColorRange: 'tv',
                    ColorSpace: 'bt2020nc',
                    ColorTransfer: 'smpte2084',
                    Height: 4_320,
                    Index: 0,
                    IsInterlaced: false,
                    Level: 183,
                    Profile: 'Main 10',
                    RealFrameRate: 24,
                    Type: 'Video',
                    VideoRangeType: 'HDR10',
                    Width: 7_680
                } ],
                RunTimeTicks: 60_000_000
            }
        });

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            {
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:pq-v1'
                ],
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            eligible: true,
            maximumCodedHeight: 4_320,
            maximumCodedWidth: 7_680,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
    });

    it('rejects native HDR when required color metadata is missing', () => {
        const options = createOptions({
            mediaSource: {
                Container: 'mkv',
                MediaStreams: [ {
                    BitDepth: 10,
                    BitRate: 24_000_000,
                    Codec: 'hevc',
                    ColorPrimaries: 'bt2020',
                    ColorSpace: 'bt2020nc',
                    Height: 2_160,
                    Index: 0,
                    IsInterlaced: false,
                    Level: 153,
                    Profile: 'Main 10',
                    RealFrameRate: 24,
                    Type: 'Video',
                    VideoRangeType: 'HDR10',
                    Width: 3_840
                } ],
                RunTimeTicks: 60_000_000
            }
        });

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            {
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:pq-v1'
                ],
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        ).eligible).toBe(false);
    });

    it('never takes the native HDR route on defaulted reserved or unknown color fields', () => {
        for (const colorDescription of [
            { ColorPrimaries: 'reserved', ColorSpace: 'bt2020nc', ColorTransfer: 'smpte2084' },
            { ColorPrimaries: 'bt2020', ColorSpace: 'unknown', ColorTransfer: 'smpte2084' },
            { ColorPrimaries: 'bt2020', ColorSpace: 'bt2020nc', ColorTransfer: 'unspecified' }
        ]) {
            const options = createOptions({
                mediaSource: {
                    Container: 'mkv',
                    MediaStreams: [ {
                        BitDepth: 10,
                        BitRate: 24_000_000,
                        Codec: 'hevc',
                        ...colorDescription,
                        Height: 2_160,
                        Index: 0,
                        IsInterlaced: false,
                        Level: 153,
                        Profile: 'Main 10',
                        RealFrameRate: 24,
                        Type: 'Video',
                        VideoRangeType: 'HDR10',
                        Width: 3_840
                    } ],
                    RunTimeTicks: 60_000_000
                }
            });

            const eligibility = getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                {
                    allowNativeHDR: true,
                    allowRawHDR: false,
                    authorizedExternalHDRRouteKeys: [
                        'external-hevc-main10-bt709-limited:pq-v1'
                    ],
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            );
            expect(eligibility.eligible && eligibility.neutralizeHDRColorMetadata).toBe(false);
        }
    });

    it('keeps native and raw Dolby Vision authorization routes separate', () => {
        const dolbyVisionOptions = createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 1,
                MediaStreams: [
                    {
                        BitDepth: 10,
                        BitRate: 24_000_000,
                        BlPresentFlag: true,
                        Codec: 'hevc',
                        DvBlSignalCompatibilityId: 0,
                        DvProfile: 5,
                        ElPresentFlag: false,
                        Height: 2_076,
                        Index: 0,
                        IsInterlaced: false,
                        Level: 150,
                        Profile: 'Main 10',
                        RealFrameRate: 24,
                        RpuPresentFlag: true,
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'DOVI',
                        Width: 3_840
                    },
                    { Channels: 2, Codec: 'flac', Index: 1, SampleRate: 48_000, Type: 'Audio' }
                ],
                RunTimeTicks: 60_000_000
            }
        });

        expect(getCustomPlaybackEligibility(
            dolbyVisionOptions,
            createCapabilities(),
            {
                allowDolbyVision: false,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
        expect(getCustomPlaybackEligibility(
            dolbyVisionOptions,
            createCapabilities(),
            {
                allowDolbyVision: false,
                allowNativeDolbyVision: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            eligible: true,
            hdr: true,
            maximumCodedHeight: 2_076,
            maximumCodedWidth: 3_840,
            rawVideoFrameFormat: null,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
        expect(getCustomPlaybackEligibility(
            dolbyVisionOptions,
            createCapabilities(),
            {
                allowDolbyVision: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            eligible: true,
            hdr: true,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        });

        const dolbyVisionMediaSource = dolbyVisionOptions.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        const profile8Options = {
            ...dolbyVisionOptions,
            mediaSource: {
                ...dolbyVisionMediaSource,
                MediaStreams: dolbyVisionMediaSource.MediaStreams.map(stream => ({ ...stream }))
            }
        };
        const profile8MediaSource = profile8Options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        profile8MediaSource.MediaStreams[0].DvBlSignalCompatibilityId = 1;
        profile8MediaSource.MediaStreams[0].DvProfile = 8;
        expect(getCustomPlaybackEligibility(
            profile8Options,
            createCapabilities(),
            {
                allowDolbyVision: false,
                allowNativeDolbyVision: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
    });

    it.each([
        { expectedEligible: true, streamFrameRate: 60, supported: true },
        { expectedEligible: true, streamFrameRate: 120, supported: true },
        { expectedEligible: false, streamFrameRate: 24, supported: false }
    ])(
        'does not use a native Profile 5 vector as a $streamFrameRate fps ceiling',
        ({ expectedEligible, streamFrameRate, supported }) => {
            const capabilities = createCapabilities();
            const nativeDolbyVisionHEVC = capabilities.nativeDolbyVisionHEVC;
            if (!nativeDolbyVisionHEVC) {
                throw new Error('The native Dolby Vision capability vector is missing');
            }
            capabilities.nativeDolbyVisionHEVC = {
                ...nativeDolbyVisionHEVC,
                reason: supported ? 'decode-output-verified' : 'decode-output-missing',
                status: supported ? 'supported' : 'unsupported'
            };
            const options = createOptions({
                mediaSource: {
                    Container: 'mkv',
                    DefaultAudioStreamIndex: 1,
                    MediaStreams: [
                        {
                            BitDepth: 10,
                            BitRate: 24_000_000,
                            BlPresentFlag: true,
                            Codec: 'hevc',
                            DvBlSignalCompatibilityId: 0,
                            DvProfile: 5,
                            ElPresentFlag: false,
                            Height: 2_076,
                            Index: 0,
                            IsInterlaced: false,
                            Level: 150,
                            Profile: 'Main 10',
                            RealFrameRate: streamFrameRate,
                            RpuPresentFlag: true,
                            Type: 'Video',
                            VideoRange: 'HDR',
                            VideoRangeType: 'DOVI',
                            Width: 3_840
                        },
                        {
                            Channels: 2,
                            Codec: 'flac',
                            Index: 1,
                            SampleRate: 48_000,
                            Type: 'Audio'
                        }
                    ],
                    RunTimeTicks: 60_000_000
                }
            });

            const result = getCustomPlaybackEligibility(
                options,
                capabilities,
                {
                    allowDolbyVision: false,
                    allowNativeDolbyVision: true,
                    allowRawHDR: false,
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            );

            expect(result.eligible).toBe(expectedEligible);
            if (expectedEligible) {
                expect(result).toMatchObject({
                    videoDecoderBackend: 'native',
                    videoOutputMode: 'video-frame'
                });
            } else {
                expect(result).toEqual({
                    eligible: false,
                    reason: 'hdr-presentation-unavailable'
                });
            }
        }
    );

    it('accepts standards-consistent 8K Level 6.1 native Profile 5 metadata', () => {
        const options = createOptions({
            mediaSource: {
                Container: 'mkv',
                MediaStreams: [ {
                    BitDepth: 10,
                    BlPresentFlag: true,
                    Codec: 'hevc',
                    DvBlSignalCompatibilityId: 0,
                    DvProfile: 5,
                    ElPresentFlag: false,
                    Height: 4_320,
                    Index: 0,
                    IsInterlaced: false,
                    Level: 183,
                    Profile: 'Main 10',
                    RealFrameRate: 24,
                    RpuPresentFlag: true,
                    Type: 'Video',
                    VideoRangeType: 'DOVI',
                    Width: 7_680
                } ],
                RunTimeTicks: 60_000_000
            }
        });

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            {
                allowDolbyVision: false,
                allowNativeDolbyVision: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            eligible: true,
            maximumCodedHeight: 4_320,
            maximumCodedWidth: 7_680,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
    });

    it('requires the separately authorized Profile 7 presentation route', () => {
        const profile7Options = createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 1,
                MediaStreams: [
                    {
                        BitDepth: 10,
                        BitRate: 10_000_000,
                        BlPresentFlag: true,
                        Codec: 'hevc',
                        DvBlSignalCompatibilityId: 6,
                        DvProfile: 7,
                        ElPresentFlag: true,
                        Height: 1_080,
                        Index: 0,
                        IsInterlaced: false,
                        Level: 120,
                        Profile: 'Main 10',
                        RealFrameRate: 24,
                        RpuPresentFlag: true,
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'DOVIWithEL',
                        Width: 1_920
                    },
                    { Channels: 2, Codec: 'flac', Index: 1, SampleRate: 48_000, Type: 'Audio' }
                ],
                RunTimeTicks: 60_000_000
            }
        });

        expect(getCustomPlaybackEligibility(
            profile7Options,
            createCapabilities(),
            {
                allowDolbyVision: true,
                allowDolbyVisionProfile7: false,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
        expect(getCustomPlaybackEligibility(
            profile7Options,
            createCapabilities(),
            {
                allowDolbyVision: false,
                allowDolbyVisionProfile7: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            dolbyVisionProfile: 7,
            eligible: true,
            hdr: true,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        });
    });

    it.each([
        {
            compatibilityID: 2,
            enhancementLayerPresent: false,
            profile: 8,
            rangeType: 'DOVIWithSDR'
        },
        {
            compatibilityID: 1,
            enhancementLayerPresent: false,
            profile: 8,
            rangeType: 'DOVIWithHDR10Plus'
        },
        {
            compatibilityID: 6,
            enhancementLayerPresent: true,
            profile: 7,
            rangeType: 'DOVIWithELHDR10Plus'
        },
        // Compatibility IDs outside each profile's standard set reconstruct from the RPU, which ignores the ID.
        // Jellyfin labels them DOVIInvalid, or by transfer when the ID is outside its own Dolby Vision set
        { compatibilityID: 0, enhancementLayerPresent: false, profile: 8, rangeType: 'DOVIInvalid' },
        { compatibilityID: 6, enhancementLayerPresent: false, profile: 8, rangeType: 'DOVIInvalid' },
        { compatibilityID: 3, enhancementLayerPresent: false, profile: 8, rangeType: 'HDR10' },
        { compatibilityID: 15, enhancementLayerPresent: false, profile: 8, rangeType: 'HDR10' },
        { compatibilityID: 0, enhancementLayerPresent: true, profile: 7, rangeType: 'DOVIWithEL' },
        { compatibilityID: 2, enhancementLayerPresent: true, profile: 7, rangeType: 'DOVIWithEL' },
        { compatibilityID: 15, enhancementLayerPresent: true, profile: 7, rangeType: 'HDR10' },
        { compatibilityID: 1, enhancementLayerPresent: false, profile: 5, rangeType: 'DOVI' },
        { compatibilityID: 15, enhancementLayerPresent: false, profile: 5, rangeType: 'HDR10' }
    ])('selects the raw Dolby Vision route for $rangeType with profile $profile and compatibility ID $compatibilityID', ({
        compatibilityID,
        enhancementLayerPresent,
        profile,
        rangeType
    }) => {
        const options = createOptions({
            mediaSource: {
                Container: 'mkv',
                MediaStreams: [ {
                    BitDepth: 10,
                    BlPresentFlag: true,
                    Codec: 'hevc',
                    DvBlSignalCompatibilityId: compatibilityID,
                    DvProfile: profile,
                    ElPresentFlag: enhancementLayerPresent,
                    Hdr10PlusPresentFlag: rangeType.includes('HDR10Plus'),
                    Height: 1_080,
                    Index: 0,
                    IsInterlaced: false,
                    Level: 120,
                    Profile: 'Main 10',
                    RpuPresentFlag: true,
                    Type: 'Video',
                    VideoRangeType: rangeType,
                    Width: 1_920
                } ],
                RunTimeTicks: 60_000_000
            }
        });
        const mediaSource = (options as {
            mediaSource: Record<string, unknown>
        }).mediaSource;

        expect(hasPotentialCustomPlaybackVideoRoute({
            MediaSources: [ mediaSource ]
        })).toBe(true);
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            {
                allowDolbyVision: profile !== 7,
                allowDolbyVisionProfile7: profile === 7,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            dolbyVisionProfile: profile,
            eligible: true,
            hdr: true,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        });
    });

    it.each([
        { compatibilityID: 1, profile: 7, rangeType: 'DOVIWithEL' },
        { compatibilityID: 6, profile: 8, rangeType: 'DOVIInvalid' }
    ])('prefers the native HDR10 base that compatibility ID $compatibilityID declares for profile $profile', ({
        compatibilityID,
        profile,
        rangeType
    }) => {
        const options = createProfile7HDR10BaseOptions();
        const videoStream = (options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        }).MediaStreams[0];
        videoStream.DvBlSignalCompatibilityId = compatibilityID;
        videoStream.DvProfile = profile;
        videoStream.ElPresentFlag = profile === 7;
        videoStream.VideoRangeType = rangeType;

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            {
                allowDolbyVision: true,
                allowDolbyVisionProfile7: true,
                allowNativeDolbyVisionProfile7HDR10Base: true,
                allowNativeDolbyVisionProfile8HDR10Base: true,
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:pq-v1'
                ],
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            dolbyVisionProfile: null,
            eligible: true,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
    });

    it.each([ 7, 8 ])(
        'reconstructs profile %i from its RPU when compatibility ID 0 declares no displayable base',
        profile => {
            const options = createProfile7HDR10BaseOptions();
            const videoStream = (options.mediaSource as {
                MediaStreams: Array<Record<string, unknown>>
            }).MediaStreams[0];
            videoStream.DvBlSignalCompatibilityId = 0;
            videoStream.DvProfile = profile;
            videoStream.ElPresentFlag = profile === 7;
            videoStream.VideoRangeType = profile === 7 ? 'DOVIWithEL' : 'DOVIInvalid';

            // The base layer's PQ metadata is exact, but the stream says the base is not meant to be shown on its own
            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                {
                    allowDolbyVision: true,
                    allowDolbyVisionProfile7: true,
                    allowNativeDolbyVisionProfile7HDR10Base: true,
                    allowNativeDolbyVisionProfile8HDR10Base: true,
                    allowNativeHDR: true,
                    allowRawHDR: false,
                    authorizedExternalHDRRouteKeys: [
                        'external-hevc-main10-bt709-limited:pq-v1'
                    ],
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            )).toMatchObject({
                dolbyVisionProfile: profile,
                eligible: true,
                rawVideoFrameFormat: 'I420P10',
                videoOutputMode: 'raw-planes'
            });
        }
    );

    it('prefers the native Profile 7 HDR10 base independently of source dimensions', () => {
        const profile7Options = createProfile7HDR10BaseOptions();
        const capabilities = createCapabilities();
        const eligibilityOptions = {
            allowDolbyVisionProfile7: true,
            allowNativeDolbyVisionProfile7HDR10Base: true,
            allowNativeHDR: true,
            allowRawHDR: false,
            authorizedExternalHDRRouteKeys: [
                'external-hevc-main10-bt709-limited:pq-v1'
            ] as const,
            runtimeAvailability: AVAILABLE_RUNTIME
        };

        expect(getCustomPlaybackEligibility(profile7Options, capabilities, eligibilityOptions)).toMatchObject({
            dolbyVisionProfile: null,
            eligible: true,
            hdr: true,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true,
            rawVideoFrameFormat: null,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });

        const mediaSource = profile7Options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0].Height = 1_080;
        mediaSource.MediaStreams[0].Level = 120;
        mediaSource.MediaStreams[0].Width = 1_920;
        expect(getCustomPlaybackEligibility(profile7Options, capabilities, eligibilityOptions)).toMatchObject({
            dolbyVisionProfile: null,
            eligible: true,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true,
            rawVideoFrameFormat: null,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
    });

    it('retains raw Profile 7 MEL/FEL reconstruction when its native HDR10 base is unavailable', () => {
        const capabilities = createCapabilities();
        capabilities.nativeHDRHEVC = undefined;

        expect(getCustomPlaybackEligibility(
            createProfile7HDR10BaseOptions(),
            capabilities,
            {
                allowDolbyVisionProfile7: true,
                allowNativeDolbyVisionProfile7HDR10Base: true,
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:pq-v1'
                ],
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            dolbyVisionProfile: 7,
            eligible: true,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes'
        });
    });

    it('prefers the native Profile 8.1 HDR10 base independently of source resolution', () => {
        const profile8Options = createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 1,
                MediaStreams: [
                    {
                        AverageFrameRate: 23.976025,
                        BitDepth: 10,
                        BitRate: 91_000_000,
                        BlPresentFlag: true,
                        Codec: 'hevc',
                        ColorPrimaries: 'bt2020',
                        ColorRange: 'tv',
                        ColorSpace: 'bt2020nc',
                        ColorTransfer: 'smpte2084',
                        DvBlSignalCompatibilityId: 1,
                        DvProfile: 8,
                        ElPresentFlag: false,
                        Height: 2_160,
                        Index: 0,
                        IsInterlaced: false,
                        Level: 153,
                        Profile: 'Main 10',
                        RealFrameRate: 23.976025,
                        RpuPresentFlag: true,
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'DOVIWithHDR10',
                        Width: 3_840
                    },
                    {
                        BitDepth: 24,
                        Channels: 2,
                        Codec: 'flac',
                        Index: 1,
                        SampleRate: 48_000,
                        Type: 'Audio'
                    }
                ],
                RunTimeTicks: 60_000_000
            }
        });
        const capabilities = createCapabilities();
        capabilities.rawHDRVideo.hevc.codecString = 'hvc1.2.4.L120.B0';
        const eligibilityOptions = {
            allowDolbyVision: true,
            allowNativeDolbyVisionProfile8HDR10Base: true,
            allowNativeHDR: true,
            allowRawHDR: false,
            authorizedExternalHDRRouteKeys: [
                'external-hevc-main10-bt709-limited:pq-v1'
            ] as const,
            runtimeAvailability: AVAILABLE_RUNTIME
        };

        expect(getCustomPlaybackEligibility(profile8Options, capabilities, eligibilityOptions)).toMatchObject({
            dolbyVisionProfile: null,
            eligible: true,
            hdr: true,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true,
            rawVideoFrameFormat: null,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });

        const mediaSource = profile8Options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0].Height = 1_080;
        mediaSource.MediaStreams[0].Level = 120;
        mediaSource.MediaStreams[0].Width = 1_920;
        expect(getCustomPlaybackEligibility(profile8Options, capabilities, eligibilityOptions)).toMatchObject({
            dolbyVisionProfile: null,
            eligible: true,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true,
            rawVideoFrameFormat: null,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
    });

    it('retains raw Profile 8.1 reconstruction when its native HDR10 base is unavailable', () => {
        const profile8Options = createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 1,
                MediaStreams: [
                    {
                        AverageFrameRate: 23.976025,
                        BitDepth: 10,
                        BitRate: 91_000_000,
                        BlPresentFlag: true,
                        Codec: 'hevc',
                        ColorPrimaries: 'bt2020',
                        ColorRange: 'tv',
                        ColorSpace: 'bt2020nc',
                        ColorTransfer: 'smpte2084',
                        DvBlSignalCompatibilityId: 1,
                        DvProfile: 8,
                        ElPresentFlag: false,
                        Height: 2_160,
                        Index: 0,
                        IsInterlaced: false,
                        Level: 153,
                        Profile: 'Main 10',
                        RealFrameRate: 23.976025,
                        RpuPresentFlag: true,
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'DOVIWithHDR10',
                        Width: 3_840
                    },
                    {
                        BitDepth: 24,
                        Channels: 2,
                        Codec: 'flac',
                        Index: 1,
                        SampleRate: 48_000,
                        Type: 'Audio'
                    }
                ],
                RunTimeTicks: 60_000_000
            }
        });
        const capabilities = createCapabilities();
        capabilities.nativeHDRHEVC = undefined;

        expect(getCustomPlaybackEligibility(
            profile8Options,
            capabilities,
            {
                allowDolbyVision: true,
                allowNativeDolbyVisionProfile8HDR10Base: true,
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:pq-v1'
                ],
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            dolbyVisionProfile: 8,
            eligible: true,
            rawVideoFrameFormat: 'I420P10',
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes'
        });
    });

    it('prefers the qualified native Profile 8.4 HLG base over raw reconstruction', () => {
        expect(getCustomPlaybackEligibility(
            createProfile8HLGBaseOptions(),
            createCapabilities(),
            {
                allowDolbyVision: true,
                allowNativeDolbyVisionProfile8HLGBase: true,
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:hlg-v1'
                ],
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            dolbyVisionProfile: null,
            eligible: true,
            hdr: true,
            nativeHDRTransfer: 'hlg',
            neutralizeHDRColorMetadata: true,
            rawVideoFrameFormat: null,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
    });

    it('retains raw Profile 8.4 reconstruction when its native HLG base is unavailable', () => {
        const capabilities = createCapabilities();
        capabilities.nativeHDRHEVC = undefined;

        expect(getCustomPlaybackEligibility(
            createProfile8HLGBaseOptions(),
            capabilities,
            {
                allowDolbyVision: true,
                allowNativeDolbyVisionProfile8HLGBase: true,
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:hlg-v1'
                ],
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            dolbyVisionProfile: 8,
            eligible: true,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes'
        });
    });

    it('selects the base track from Jellyfin separate-track Profile 7 metadata', () => {
        const profile7Options = createOptions({
            mediaSource: {
                Container: 'mp4',
                DefaultAudioStreamIndex: 2,
                MediaStreams: [
                    {
                        AverageFrameRate: 24,
                        BitDepth: 10,
                        BitRate: 24_000_000,
                        Codec: 'hevc',
                        ColorPrimaries: 'bt2020',
                        ColorSpace: 'bt2020nc',
                        ColorTransfer: 'smpte2084',
                        Height: 2_160,
                        Index: 0,
                        IsInterlaced: false,
                        Level: 153,
                        Profile: 'Main 10',
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'HDR10',
                        Width: 3_840
                    },
                    {
                        AverageFrameRate: 24,
                        BitDepth: 10,
                        BlPresentFlag: 0,
                        Codec: 'hevc',
                        DvBlSignalCompatibilityId: 6,
                        DvProfile: 7,
                        ElPresentFlag: 1,
                        Height: 1_080,
                        Index: 1,
                        IsInterlaced: false,
                        Level: 153,
                        Profile: 'Main 10',
                        RpuPresentFlag: 1,
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'DOVIWithEL',
                        Width: 1_920
                    },
                    {
                        Channels: 2,
                        Codec: 'aac',
                        Index: 2,
                        SampleRate: 48_000,
                        Type: 'Audio'
                    }
                ],
                RunTimeTicks: 60_000_000
            }
        });

        expect(getCustomPlaybackEligibility(
            profile7Options,
            createCapabilities(),
            {
                allowDolbyVisionProfile7: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            audioTrackIndex: 0,
            eligible: true,
            hdr: true,
            rawVideoFrameFormat: 'I420P10',
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        });
    });

    it('selects Jellyfin\'s first independent video track', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams.splice(1, 0, {
            AverageFrameRate: 24,
            BitDepth: 8,
            Codec: 'h264',
            Height: 720,
            Index: 2,
            IsInterlaced: false,
            Profile: 'High',
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 1_280
        });

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({
            eligible: true,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            videoTrackIndex: 0
        });
    });

    it('direct plays the first independent 4K HDR10 track with selected AC3 audio on an audio decoder package', () => {
        const options = createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 7,
                MediaStreams: [
                    {
                        AverageFrameRate: 23.976025,
                        BitDepth: 10,
                        BitRate: 49_800_000,
                        Codec: 'hevc',
                        ColorPrimaries: 'bt2020',
                        ColorRange: 'tv',
                        ColorSpace: 'bt2020nc',
                        ColorTransfer: 'smpte2084',
                        Height: 2_160,
                        Index: 3,
                        IsInterlaced: false,
                        Level: 153,
                        Profile: 'Main 10',
                        RealFrameRate: 23.976025,
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'HDR10',
                        Width: 3_840
                    },
                    {
                        AverageFrameRate: 23.976025,
                        BitDepth: 10,
                        BitRate: 6_500_000,
                        Codec: 'hevc',
                        ColorPrimaries: 'bt2020',
                        ColorRange: 'tv',
                        ColorSpace: 'bt2020nc',
                        ColorTransfer: 'smpte2084',
                        Height: 1_080,
                        Index: 4,
                        IsInterlaced: false,
                        Level: 153,
                        Profile: 'Main 10',
                        RealFrameRate: 23.976025,
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'HDR10',
                        Width: 1_920
                    },
                    {
                        Channels: 2,
                        Codec: 'flac',
                        Index: 5,
                        SampleRate: 48_000,
                        Type: 'Audio'
                    },
                    {
                        Channels: 6,
                        Codec: 'ac3',
                        Index: 7,
                        SampleRate: 48_000,
                        Type: 'Audio'
                    }
                ],
                RunTimeTicks: 82_800_000_000
            },
            source: { kind: 'url', url: '/Videos/item/stream.mkv?api_key=secret' }
        });

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { ...PQ_AUTHORIZATION, audioDecoders: AUDIO_PACKAGES }
        )).toMatchObject({
            audioDecoder: { codec: 'ac3', source: { manifest: DOLBY_AUDIO_PACKAGE.manifest } },
            audioOutputMode: 'decoded-pcm',
            audioSourceChannelCount: 6,
            audioTrackIndex: 1,
            eligible: true,
            hdr: true,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            rawVideoFrameFormat: 'I420P10',
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        });
    });

    it('presents interlaced H264 on the native route, whose frames the deinterlacing pass takes', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0].IsInterlaced = true;

        expect(getCustomPlaybackEligibility(options, createCapabilities(), PQ_AUTHORIZATION)).toMatchObject({
            eligible: true,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
        expect(hasEligibleCustomVideoRoute(options.mediaSource, createCapabilities(), PQ_AUTHORIZATION)).toBe(true);
    });

    it('rejects interlaced HEVC, which codes its fields as pictures, before starting a decoder', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0].Codec = 'hevc';
        mediaSource.MediaStreams[0].IsInterlaced = true;

        expect(getCustomPlaybackEligibility(options, createCapabilities(), PQ_AUTHORIZATION)).toEqual({
            eligible: false,
            reason: 'interlaced-video-unsupported'
        });
        expect(hasEligibleCustomVideoRoute(options.mediaSource, createCapabilities(), PQ_AUTHORIZATION)).toBe(false);
    });

    it.each([
        { label: 'missing', value: undefined },
        { label: 'null', value: null },
        { label: 'string false', value: 'false' },
        { label: 'numeric zero', value: 0 }
    ])('takes $label interlace metadata as an unknown scan, which each frame\'s own fields settle', ({ value }) => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        if (value === undefined) {
            delete mediaSource.MediaStreams[0].IsInterlaced;
        } else {
            mediaSource.MediaStreams[0].IsInterlaced = value;
        }

        expect(getCustomPlaybackEligibility(options, createCapabilities(), PQ_AUTHORIZATION)).toMatchObject({ eligible: true, videoOutputMode: 'video-frame' });
    });

    it('keeps a Dolby Vision route, which never deinterlaces, to streams called progressive, and presents others on the base layer\'s route', () => {
        const createUnknownScanOptions = (): Record<string, unknown> => {
            const options = createProfile8HLGBaseOptions();
            delete (options.mediaSource as { MediaStreams: Array<Record<string, unknown>> }).MediaStreams[0].IsInterlaced;
            return options;
        };
        const eligibilityOptions: CustomPlaybackEligibilityOptions = {
            allowDolbyVision: true,
            allowNativeDolbyVisionProfile8HLGBase: true,
            allowNativeHDR: true,
            allowRawHDR: false,
            authorizedExternalHDRRouteKeys: [ 'external-hevc-main10-bt709-limited:hlg-v1' ],
            runtimeAvailability: AVAILABLE_RUNTIME
        };
        const reconstructionCapabilities = createCapabilities();
        reconstructionCapabilities.nativeHDRHEVC = undefined;

        // Without the native base, the route is RPU reconstruction
        expect(getCustomPlaybackEligibility(createUnknownScanOptions(), reconstructionCapabilities, eligibilityOptions)).toEqual({
            eligible: false,
            reason: 'interlaced-video-unsupported'
        });
        expect(getCustomPlaybackEligibility(createProfile8HLGBaseOptions(), reconstructionCapabilities, eligibilityOptions))
            .toMatchObject({ dolbyVisionProfile: 8, eligible: true });
        expect(getCustomPlaybackEligibility(createUnknownScanOptions(), createCapabilities(), eligibilityOptions)).toMatchObject({
            dolbyVisionProfile: null,
            eligible: true,
            videoOutputMode: 'video-frame'
        });
    });

    it('requires an exact copyable raw HDR codec and format, at any frame size', () => {
        const hdrOptions = createOptions({
            mediaSource: {
                Container: 'mkv',
                MediaStreams: [ {
                    AverageFrameRate: 24,
                    BitDepth: 10,
                    Codec: 'vp9',
                    ColorPrimaries: 'bt2020',
                    ColorSpace: 'bt2020nc',
                    ColorTransfer: 'smpte2084',
                    Height: 2_160,
                    Index: 0,
                    IsInterlaced: false,
                    Profile: 'Profile 2',
                    Type: 'Video',
                    VideoRangeType: 'HDR10',
                    Width: 3_840
                } ],
                RunTimeTicks: 60_000_000
            }
        });
        const baseCapabilities = createCapabilities();
        const rawHDRVideoCapabilities = baseCapabilities.rawHDRVideo;
        const unsupportedCapabilities: CustomDecodeCapabilities = {
            ...baseCapabilities,
            rawHDRVideo: {
                ...rawHDRVideoCapabilities,
                vp9: {
                    ...rawHDRVideoCapabilities.vp9,
                    reason: 'output-copy-unsupported',
                    status: 'unsupported'
                }
            }
        };

        expect(getCustomPlaybackEligibility(
            hdrOptions,
            unsupportedCapabilities,
            PQ_AUTHORIZATION
        )).toEqual({ eligible: false, reason: 'hdr-codec-unsupported' });

        const mediaSource = hdrOptions.mediaSource as {
            MediaStreams: Array<{ Height: number, Width: number }>
        };
        for (const [ width, height ] of [
            [ ULTRA_HD_8K_CODED_WIDTH, ULTRA_HD_8K_CODED_HEIGHT ],
            [ ULTRA_HD_16K_CODED_WIDTH, ULTRA_HD_16K_CODED_HEIGHT ]
        ] as const) {
            mediaSource.MediaStreams[0].Width = width;
            mediaSource.MediaStreams[0].Height = height;
            expect(getCustomPlaybackEligibility(hdrOptions, baseCapabilities, PQ_AUTHORIZATION)).toMatchObject({
                eligible: true,
                maximumCodedHeight: height,
                maximumCodedWidth: width,
                videoOutputMode: 'raw-planes'
            });
        }
    });

    it('selects the authorized raw HEVC route for HDR10+ input', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0] = {
            AverageFrameRate: 24,
            BitDepth: 10,
            Codec: 'hevc',
            ColorPrimaries: 'bt2020',
            ColorSpace: 'bt2020nc',
            ColorTransfer: 'smpte2084',
            Hdr10PlusPresentFlag: true,
            Height: 2_160,
            Index: 0,
            IsInterlaced: false,
            Level: 153,
            Profile: 'Main 10',
            Type: 'Video',
            VideoRangeType: 'HDR10Plus',
            Width: 3_840
        };

        expect(getCustomPlaybackEligibility(options, createCapabilities(), PQ_AUTHORIZATION)).toMatchObject({
            eligible: true,
            hdr: true,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        });
    });

    it.each([
        [ 'missing rate', undefined, undefined, true ],
        [ 'non-finite real rate', Number.NaN, 24, true ],
        [ 'rate above the qualification vector', 31, undefined, true ],
        [ 'numeric average fallback', undefined, 30, true ],
        [ 'string average metadata', undefined, '24', true ],
        [ 'real rate preference', 30, 60, true ]
    ])(
        'does not use native raw HDR vector frame rate as a source ceiling: %s',
        (_label, realFrameRate, averageFrameRate, expectedEligible) => {
            const options = createOptions({
                mediaSource: {
                    Container: 'mkv',
                    MediaStreams: [ {
                        AverageFrameRate: averageFrameRate,
                        BitDepth: 10,
                        Codec: 'vp9',
                        ColorPrimaries: 'bt2020',
                        ColorSpace: 'bt2020nc',
                        ColorTransfer: 'smpte2084',
                        Height: 2_160,
                        Index: 0,
                        IsInterlaced: false,
                        Profile: 'Profile 2',
                        RealFrameRate: realFrameRate,
                        Type: 'Video',
                        VideoRangeType: 'HDR10',
                        Width: 3_840
                    } ],
                    RunTimeTicks: 60_000_000
                }
            });

            const result = getCustomPlaybackEligibility(options, createCapabilities(), PQ_AUTHORIZATION);
            expect(result.eligible).toBe(expectedEligible);
            if (!expectedEligible) {
                expect(result).toEqual({ eligible: false, reason: 'hdr-codec-unsupported' });
            }
        }
    );

    it('does not treat a Main10 qualification vector as a 4K source ceiling', () => {
        const baseCapabilities = createCapabilities();
        const capabilities: CustomDecodeCapabilities = {
            ...baseCapabilities,
            rawHDRVideo: {
                ...baseCapabilities.rawHDRVideo,
                hevc: {
                    ...baseCapabilities.rawHDRVideo.hevc,
                    codecString: 'hvc1.2.4.L120.B0'
                }
            }
        };
        const options = createOptions({
            mediaSource: {
                Container: 'mkv',
                MediaStreams: [ {
                    BitDepth: 10,
                    BitRate: 12_000_000,
                    Codec: 'hevc',
                    ColorPrimaries: 'bt2020',
                    ColorSpace: 'bt2020nc',
                    ColorTransfer: 'smpte2084',
                    Height: 1_080,
                    Index: 0,
                    IsInterlaced: false,
                    Level: 120,
                    Profile: 'Main 10',
                    RealFrameRate: 24,
                    Type: 'Video',
                    VideoRangeType: 'HDR10',
                    Width: 1_920
                } ],
                RunTimeTicks: 60_000_000
            }
        });

        expect(getCustomPlaybackEligibility(options, capabilities, PQ_AUTHORIZATION)).toMatchObject({
            eligible: true,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            videoDecoderBackend: 'native'
        });

        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0].Height = 2_160;
        mediaSource.MediaStreams[0].Width = 3_840;
        expect(getCustomPlaybackEligibility(options, capabilities, PQ_AUTHORIZATION)).toMatchObject({
            eligible: true,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            videoDecoderBackend: 'native'
        });
    });

    it('uses source dimensions for native decode while retaining bit-depth and profile checks', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        const videoStream = mediaSource.MediaStreams[0];

        videoStream.Height = 4_320;
        videoStream.Width = 7_680;
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({
            eligible: true,
            maximumCodedHeight: 4_320,
            maximumCodedWidth: 7_680,
            videoOutputMode: 'video-frame'
        });

        videoStream.Height = 1_080;
        videoStream.Width = 1_920;
        videoStream.Profile = 'Main';
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({ eligible: true, videoOutputMode: 'video-frame' });

        const capabilitiesWithoutMain = createCapabilities();
        const h264Profiles = capabilitiesWithoutMain.h264Profiles as H264ProfileCapabilities;
        const mainCapability = h264Profiles.main;
        const exactProfileCapabilities: CustomDecodeCapabilities = {
            ...capabilitiesWithoutMain,
            h264Profiles: {
                ...h264Profiles,
                main: {
                    ...mainCapability,
                    evidence: 'configuration',
                    reason: 'config-supported-only',
                    status: 'unknown'
                }
            }
        };
        expect(getCustomPlaybackEligibility(
            options,
            exactProfileCapabilities,
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });

        videoStream.Profile = 'High';
        videoStream.BitDepth = 10;
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });
    });

    it.each([
        { codec: 'hevc', profile: 'Main' },
        { codec: 'vp9', profile: 'Profile 0' },
        { codec: 'av1', profile: 'Main' }
    ] as const)(
        'does not turn the native Ultra HD $codec vector dimensions into a ceiling',
        ({ codec, profile }) => {
            const baseCapabilities: CustomDecodeCapabilities = createCapabilities();
            const capabilities: CustomDecodeCapabilities = {
                ...baseCapabilities,
                nativeUltraHDVideo: createNativeUltraHDVideoCapabilities(new Set([ codec ])),
                video: {
                    ...baseCapabilities.video,
                    [codec]: createCapability(codec, false)
                }
            };
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.MediaStreams[0] = {
                BitDepth: 8,
                Codec: codec,
                Height: 2_160,
                Index: 0,
                IsInterlaced: false,
                Profile: profile,
                Type: 'Video',
                VideoRangeType: 'SDR',
                Width: 3_840
            };

            expect(getCustomPlaybackEligibility(
                options,
                capabilities,
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                eligible: true,
                maximumCodedHeight: 2_160,
                maximumCodedWidth: 3_840,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame'
            });

            mediaSource.MediaStreams[0].Height = 4_320;
            mediaSource.MediaStreams[0].Width = 7_680;
            expect(getCustomPlaybackEligibility(
                options,
                capabilities,
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                eligible: true,
                maximumCodedHeight: 4_320,
                maximumCodedWidth: 7_680,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame'
            });
        }
    );

    it('selects 4K HEVC Main with six-channel E-AC-3 from Ultra HD evidence', () => {
        const baseCapabilities: CustomDecodeCapabilities = createCapabilities();
        const capabilities: CustomDecodeCapabilities = {
            ...baseCapabilities,
            nativeUltraHDVideo: createNativeUltraHDVideoCapabilities(new Set([ 'hevc' ])),
            video: {
                ...baseCapabilities.video,
                hevc: createCapability('hevc', false)
            }
        };
        const options = createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 1,
                MediaStreams: [
                    {
                        AverageFrameRate: 23.98,
                        BitDepth: 8,
                        BitRate: 15_500_000,
                        Codec: 'hevc',
                        ColorPrimaries: 'bt709',
                        ColorSpace: 'bt709',
                        ColorTransfer: 'bt709',
                        Height: 1_920,
                        Index: 0,
                        IsInterlaced: false,
                        Level: 150,
                        Profile: 'Main',
                        RealFrameRate: 23.98,
                        Type: 'Video',
                        VideoRangeType: 'SDR',
                        Width: 3_840
                    },
                    {
                        BitRate: 640_000,
                        Channels: 6,
                        Codec: 'eac3',
                        Index: 1,
                        Profile: 'Dolby Digital Plus + Dolby Atmos',
                        SampleRate: 48_000,
                        Type: 'Audio'
                    }
                ],
                RunTimeTicks: 36_000_000_000
            },
            source: { kind: 'url', url: '/Videos/item/stream.mkv' }
        });

        expect(getCustomPlaybackEligibility(
            options,
            capabilities,
            { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({
            audioDecoder: { codec: 'eac3' },
            audioOutputMode: 'decoded-pcm',
            audioSourceChannelCount: 6,
            audioTrackIndex: 0,
            eligible: true,
            hdr: false,
            maximumCodedHeight: 1_920,
            maximumCodedWidth: 3_840,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        });
    });

    it.each([
        { bitRate: 9_124_431, height: 2_160, width: 3_840 },
        { bitRate: 200_000_000, height: 4_320, width: 7_680 }
    ])(
        'selects native HEVC Main 10 SDR with E-AC-3 at $width x $height',
        ({ bitRate, height, width }) => {
            const capabilities: CustomDecodeCapabilities = createCapabilities();
            const options = createOptions({
                mediaSource: {
                    Container: 'mkv',
                    DefaultAudioStreamIndex: 3,
                    MediaStreams: [
                        {
                            Codec: 'subrip',
                            Index: 1,
                            IsExternal: true,
                            Type: 'Subtitle'
                        },
                        {
                            AverageFrameRate: 23.98,
                            BitDepth: 10,
                            BitRate: bitRate,
                            Codec: 'hevc',
                            ColorPrimaries: 'bt709',
                            ColorSpace: 'bt709',
                            ColorTransfer: 'bt709',
                            Height: height,
                            Index: 2,
                            IsInterlaced: false,
                            Level: 150,
                            Profile: 'Main 10',
                            RealFrameRate: 23.98,
                            Type: 'Video',
                            VideoRangeType: 'SDR',
                            Width: width
                        },
                        {
                            BitRate: 256_000,
                            Channels: 6,
                            Codec: 'eac3',
                            Index: 3,
                            Profile: null,
                            SampleRate: 48_000,
                            Type: 'Audio'
                        }
                    ],
                    RunTimeTicks: 36_000_000_000
                },
                source: { kind: 'url', url: '/Videos/item/stream.mkv' }
            });

            expect(getCustomPlaybackEligibility(
                options,
                capabilities,
                { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioDecoder: { codec: 'eac3' },
                audioOutputMode: 'decoded-pcm',
                audioSourceChannelCount: 6,
                audioTrackIndex: 0,
                eligible: true,
                hdr: false,
                maximumCodedHeight: height,
                maximumCodedWidth: width,
                neutralizeHDRColorMetadata: false,
                rawVideoFrameFormat: null,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame',
                videoTrackIndex: 0
            });
        }
    );

    // SMPTE 170M and BT.2020 10-bit transfers are the BT.709 OETF, so both sources stay on the SDR route
    it.each([
        {
            colorPrimaries: 'smpte170m',
            colorSpace: 'smpte170m',
            colorTransfer: 'smpte170m',
            height: 478,
            width: 712
        },
        {
            colorPrimaries: 'bt2020',
            colorSpace: 'bt2020nc',
            colorTransfer: 'bt2020-10',
            height: 2_160,
            width: 3_840
        }
    ])(
        'selects native HEVC Main 10 SDR tagged with BT.601 or BT.2020-10 color at $width x $height',
        ({ colorPrimaries, colorSpace, colorTransfer, height, width }) => {
            const capabilities: CustomDecodeCapabilities = createCapabilities();
            const options = createOptions({
                mediaSource: {
                    Container: 'mkv',
                    DefaultAudioStreamIndex: 3,
                    MediaStreams: [
                        {
                            Codec: 'subrip',
                            Index: 1,
                            IsExternal: true,
                            Type: 'Subtitle'
                        },
                        {
                            AverageFrameRate: 23.98,
                            BitDepth: 10,
                            BitRate: 9_124_431,
                            Codec: 'hevc',
                            ColorPrimaries: colorPrimaries,
                            ColorSpace: colorSpace,
                            ColorTransfer: colorTransfer,
                            Height: height,
                            Index: 2,
                            IsInterlaced: false,
                            Level: 150,
                            Profile: 'Main 10',
                            RealFrameRate: 23.98,
                            Type: 'Video',
                            VideoRangeType: 'SDR',
                            Width: width
                        },
                        {
                            BitRate: 256_000,
                            Channels: 6,
                            Codec: 'eac3',
                            Index: 3,
                            Profile: null,
                            SampleRate: 48_000,
                            Type: 'Audio'
                        }
                    ],
                    RunTimeTicks: 36_000_000_000
                },
                source: { kind: 'url', url: '/Videos/item/stream.mkv' }
            });

            expect(getCustomPlaybackEligibility(
                options,
                capabilities,
                { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioDecoder: { codec: 'eac3' },
                audioOutputMode: 'decoded-pcm',
                audioSourceChannelCount: 6,
                audioTrackIndex: 0,
                eligible: true,
                hdr: false,
                maximumCodedHeight: height,
                maximumCodedWidth: width,
                neutralizeHDRColorMetadata: false,
                rawVideoFrameFormat: null,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame',
                videoTrackIndex: 0
            });
        }
    );

    it('rejects HEVC Main 10 SDR without exact native decoded-output evidence', () => {
        const capabilities: CustomDecodeCapabilities = createCapabilities();
        const nativeMain10Capability = capabilities.nativeHDRHEVC;
        if (!nativeMain10Capability) {
            throw new Error('Expected native Main 10 HEVC capability vector');
        }
        capabilities.nativeHDRHEVC = {
            ...nativeMain10Capability,
            reason: 'decode-output-missing',
            status: 'unsupported'
        };
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0] = {
            BitDepth: 10,
            Codec: 'hevc',
            ColorPrimaries: 'bt709',
            ColorSpace: 'bt709',
            ColorTransfer: 'bt709',
            Height: 2_160,
            Index: 0,
            IsInterlaced: false,
            Profile: 'Main 10',
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 3_840
        };

        expect(getCustomPlaybackEligibility(
            options,
            capabilities,
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });
    });

    it('does not treat the optional Ultra HD qualification vector as a native ceiling', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0] = {
            BitDepth: 8,
            Codec: 'hevc',
            Height: 2_160,
            Index: 0,
            IsInterlaced: false,
            Profile: 'Main',
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 3_840
        };
        const baseCapabilities: CustomDecodeCapabilities = createCapabilities();
        const capabilities: CustomDecodeCapabilities = {
            ...baseCapabilities,
            nativeUltraHDVideo: createNativeUltraHDVideoCapabilities(new Set())
        };

        expect(getCustomPlaybackEligibility(
            options,
            capabilities,
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({
            eligible: true,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
    });

    it('uses only source-path-specific runtime requirements', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mkv';
        mediaSource.MediaStreams[0] = {
            BitDepth: 10,
            BitRate: 40_000_000,
            Codec: 'hevc',
            ColorPrimaries: 'bt2020',
            ColorSpace: 'bt2020nc',
            ColorTransfer: 'smpte2084',
            Height: 2_160,
            Index: 0,
            IsInterlaced: false,
            Level: 153,
            Profile: 'Main 10',
            RealFrameRate: 24,
            Type: 'Video',
            VideoRangeType: 'HDR10',
            Width: 3_840
        };
        mediaSource.MediaStreams[1].Codec = 'ac3';
        // Packages decode without the browser's decoders
        const packageRuntime: CustomPlaybackRuntimeAvailability = {
            available: true,
            environment: {
                ...AVAILABLE_RUNTIME.environment,
                audioData: false,
                audioDecoder: false,
                videoDecoder: false
            },
            reason: null
        };
        // Neither a VideoFrame nor a raw route decodes the HEVC, so it takes the GPU decoder
        const capabilities = createCapabilitiesWithoutNativeHEVC();
        capabilities.rawHDRVideo = {
            ...capabilities.rawHDRVideo,
            hevc: {
                ...capabilities.rawHDRVideo.hevc,
                reason: 'output-copy-unsupported',
                status: 'unsupported'
            }
        };
        const eligibilityOptions = {
            allowFramePoolHDR: true,
            allowRawHDR: true,
            audioDecoders: AUDIO_PACKAGES,
            authorizedRawHDRRouteKeys: PQ_AUTHORIZATION.authorizedRawHDRRouteKeys,
            gpuVideoDecoders: createVideoDecoderOffers(HEVC_VIDEO_PACKAGE),
            runtimeAvailability: packageRuntime
        };

        expect(getCustomPlaybackEligibility(options, capabilities, eligibilityOptions)).toMatchObject({
            audioDecoder: { codec: 'ac3' },
            eligible: true,
            videoOutputMode: 'frame-pool'
        });

        mediaSource.MediaStreams[1].Codec = 'aac';
        expect(getCustomPlaybackEligibility(
            options,
            capabilities,
            eligibilityOptions
        )).toEqual({ eligible: false, reason: 'runtime-unavailable' });

        mediaSource.MediaStreams.splice(1, 1);
        mediaSource.MediaStreams[0].Codec = 'vp9';
        mediaSource.MediaStreams[0].Profile = 'Profile 2';
        expect(getCustomPlaybackEligibility(
            options,
            capabilities,
            eligibilityOptions
        )).toEqual({ eligible: false, reason: 'runtime-unavailable' });
    });

    it('requires browser audio output only when an audio track is selected', () => {
        const options = createOptions();
        const noAudioRuntime: CustomPlaybackRuntimeAvailability = {
            available: true,
            environment: {
                ...AVAILABLE_RUNTIME.environment,
                audioContext: false,
                audioWorklet: false
            },
            reason: null
        };

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: noAudioRuntime }
        )).toEqual({ eligible: false, reason: 'runtime-unavailable' });

        const mediaSource = options.mediaSource as {
            DefaultAudioStreamIndex?: number | null
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.DefaultAudioStreamIndex = null;
        mediaSource.MediaStreams.splice(1, 1);
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: noAudioRuntime }
        )).toMatchObject({ audioTrackIndex: null, eligible: true });
    });

    it('selects only an exact qualified owned native-media audio route', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[1] = {
            Channels: 6,
            Codec: 'eac3',
            Index: 1,
            SampleRate: 48_000,
            Type: 'Audio'
        };
        const baseCapabilities = createCapabilities();
        const capabilities: CustomDecodeCapabilities = {
            ...baseCapabilities,
            audio: {
                ...baseCapabilities.audio,
                eac3: createCapability('eac3', false)
            }
        };
        const nativeMediaAudioCapabilities = createNativeMediaAudioCapabilities(new Set([ 'eac3:6:48000' ]));
        const nativeOnlyRuntime: CustomPlaybackRuntimeAvailability = {
            available: true,
            environment: {
                ...AVAILABLE_RUNTIME.environment,
                audioContext: false,
                audioData: false,
                audioDecoder: false,
                audioWorklet: false
            },
            reason: null
        };

        expect(getCustomPlaybackEligibility(options, capabilities, {
            allowRawHDR: false,
            nativeMediaAudioCapabilities,
            runtimeAvailability: nativeOnlyRuntime
        })).toMatchObject({
            audioOutputMode: 'native-media',
            audioTrackIndex: 0,
            eligible: true
        });

        mediaSource.MediaStreams[1].Channels = 2;
        expect(getCustomPlaybackEligibility(options, capabilities, {
            allowRawHDR: false,
            nativeMediaAudioCapabilities,
            runtimeAvailability: nativeOnlyRuntime
        })).toEqual({ eligible: false, reason: 'audio-layout-unsupported' });
    });

    it('plays a source whose runtime the server never probed', () => {
        for (const runTimeTicks of [ undefined, null, 0 ]) {
            const options = createOptions();
            (options.mediaSource as Record<string, unknown>).RunTimeTicks = runTimeTicks;

            expect(getCustomPlaybackEligibility(options, createCapabilities(), {
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            })).toMatchObject({
                durationMicroseconds: null,
                eligible: true
            });
        }
    });

    it('uses decoded PCM instead of native media when the duration is unknown', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as Record<string, unknown> & {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[1].Codec = 'ac3';
        delete mediaSource.RunTimeTicks;

        expect(getCustomPlaybackEligibility(options, createCapabilities(), {
            allowRawHDR: false,
            audioDecoders: AUDIO_PACKAGES,
            nativeMediaAudioCapabilities: createNativeMediaAudioCapabilities(new Set([ 'ac3:2:48000' ])),
            runtimeAvailability: AVAILABLE_RUNTIME
        })).toMatchObject({
            audioDecoder: { codec: 'ac3' },
            audioOutputMode: 'decoded-pcm',
            durationMicroseconds: null,
            eligible: true
        });
    });

    it('prefers qualified native media over an audio decoder package for the same layout', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[1].Codec = 'ac3';

        const eligibility = getCustomPlaybackEligibility(options, createCapabilities(), {
            allowRawHDR: false,
            audioDecoders: AUDIO_PACKAGES,
            nativeMediaAudioCapabilities: createNativeMediaAudioCapabilities(new Set([ 'ac3:2:48000' ])),
            runtimeAvailability: AVAILABLE_RUNTIME
        });

        expect(eligibility).toMatchObject({
            audioOutputMode: 'native-media',
            eligible: true
        });
        expect(eligibility).not.toHaveProperty('audioDecoder');
    });

    it('selects an audio decoder package for 5.1 AC-3 and E-AC-3 input', () => {
        for (const codec of [ 'ac3', 'eac3' ] as const) {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.MediaStreams[1].Channels = 6;
            mediaSource.MediaStreams[1].Codec = codec;

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioDecoder: { codec },
                audioOutputMode: 'decoded-pcm',
                audioSourceChannelCount: 6,
                audioTrackIndex: 0,
                eligible: true
            });
        }
    });

    // Jellyfin cuts 7.1(wide) to 7.1, so the package's decoded speaker mask, not the metadata, screens wide beds
    it.each([ '7.1', undefined, '8 channels', '5.1' ] as const)(
        'leaves eight-channel E-AC-3 with metadata layout %s to the package\'s speaker mask',
        channelLayout => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.MediaStreams[1].ChannelLayout = channelLayout;
            mediaSource.MediaStreams[1].Channels = 8;
            mediaSource.MediaStreams[1].Codec = 'eac3';

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioDecoder: { codec: 'eac3' },
                audioOutputMode: 'decoded-pcm',
                audioSourceChannelCount: 8,
                eligible: true
            });
        }
    );

    it.each([
        [ 'DTS-HD MA', 2, 48_000 ],
        [ 'DTS-HD MA', 2, 96_000 ],
        [ 'DTS', 6, 48_000 ],
        [ 'DTS 96/24', 6, 96_000 ],
        [ 'DTS-HD HRA', 6, 48_000 ],
        [ 'DTS-HD HRA', 8, 48_000 ],
        [ 'DTS-HD MA', 8, 48_000 ],
        [ 'DTS-HD MA', 6, 96_001 ],
        [ 'DTS-HD MA', 6, 192_000 ],
        [ 'DTS-HD MA + DTS:X', 8, 48_000 ],
        [ 'DTS', 6, 12_345 ]
    ] as const)(
        'selects the DTS audio decoder package for Matroska %s',
        (profile, channelCount, sampleRate) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = 'mkv';
            mediaSource.MediaStreams[1].Channels = channelCount;
            mediaSource.MediaStreams[1].Codec = 'dts';
            mediaSource.MediaStreams[1].Profile = profile;
            mediaSource.MediaStreams[1].SampleRate = sampleRate;
            // A package decodes without the browser's audio decoder
            const packageRuntime: CustomPlaybackRuntimeAvailability = {
                available: true,
                environment: {
                    ...AVAILABLE_RUNTIME.environment,
                    audioData: false,
                    audioDecoder: false
                },
                reason: null
            };

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: packageRuntime }
            )).toMatchObject({
                audioDecoder: { codec: 'dts', source: { manifest: DTS_AUDIO_PACKAGE.manifest } },
                audioOutputMode: 'decoded-pcm',
                audioTrackIndex: 0,
                eligible: true
            });
        }
    );

    it.each([
        { channelCount: 2, eligible: true, profile: 'DTS' },
        { channelCount: 2, eligible: true, profile: 'DTS-HD HRA' },
        { channelCount: 3, eligible: true, profile: 'DTS' },
        { channelCount: 5, eligible: true, profile: 'DTS-HD MA' },
        { channelCount: 7, eligible: true, profile: 'DTS-ES' },
        { channelCount: 7, eligible: true, profile: 'DTS-HD MA' },
        // A 4.0 bed has no layout
        { channelCount: 4, eligible: false, profile: 'DTS-HD MA' }
    ])('decodes $channelCount-channel $profile on the DTS package: $eligible', ({ channelCount, eligible, profile }) => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mkv';
        mediaSource.MediaStreams[1].Channels = channelCount;
        mediaSource.MediaStreams[1].Codec = 'dts';
        mediaSource.MediaStreams[1].Profile = profile;
        mediaSource.MediaStreams[1].SampleRate = 48_000;

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject(eligible ?
            { audioDecoder: { codec: 'dts' }, audioOutputMode: 'decoded-pcm', audioSourceChannelCount: channelCount, eligible: true } :
            { eligible: false, reason: 'audio-layout-unsupported' });
    });

    it('accepts the Matroska DCA alias through the same DTS package', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'matroska';
        mediaSource.MediaStreams[1].Channels = 6;
        mediaSource.MediaStreams[1].Codec = 'dca';
        mediaSource.MediaStreams[1].Profile = 'DTS';

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({
            audioDecoder: { codec: 'dts' },
            audioOutputMode: 'decoded-pcm',
            eligible: true
        });
    });

    it.each([ 'm2ts', 'mts', 'ts' ] as const)(
        'plays DTS from %s, which the fork demuxes as a Blu-ray program carries it',
        container => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[1].Channels = 8;
            mediaSource.MediaStreams[1].Codec = 'dts';
            mediaSource.MediaStreams[1].Profile = 'DTS-HD MA';

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioDecoder: { codec: 'dts' },
                audioOutputMode: 'decoded-pcm',
                eligible: true
            });
        }
    );

    it('rejects DTS without an audio decoder package', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mkv';
        mediaSource.MediaStreams[1].Channels = 8;
        mediaSource.MediaStreams[1].Codec = 'dts';
        mediaSource.MediaStreams[1].Profile = 'DTS-HD MA';

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, audioDecoders: [ DOLBY_AUDIO_PACKAGE, TRUEHD_AUDIO_PACKAGE ], runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'audio-codec-unsupported' });
    });

    describe('WMA', () => {
        // A package decodes without the browser's audio decoder
        const packageRuntime: CustomPlaybackRuntimeAvailability = {
            available: true,
            environment: {
                ...AVAILABLE_RUNTIME.environment,
                audioData: false,
                audioDecoder: false
            },
            reason: null
        };

        function getWMAEligibility(container: string, codec: string, channelCount: number, audioDecoders: readonly AudioDecoderPackage[]): CustomPlaybackEligibility {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[1].Channels = channelCount;
            mediaSource.MediaStreams[1].Codec = codec;
            mediaSource.MediaStreams[1].Profile = undefined;
            mediaSource.MediaStreams[1].SampleRate = 44_100;
            return getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, audioDecoders, runtimeAvailability: packageRuntime }
            );
        }

        it.each([
            [ 'mkv', 'wmav1', 2 ],
            [ 'mkv', 'wmav2', 1 ],
            [ 'avi', 'wmav2', 2 ],
            [ 'mkv', 'wmapro', 6 ],
            [ 'avi', 'wmapro', 8 ],
            [ 'mkv', 'wmalossless', 2 ],
            [ 'mkv', 'wmavoice', 1 ]
        ] as const)('selects the WMA audio decoder package for %s %s with %i channels', (container, codec, channelCount) => {
            expect(getWMAEligibility(container, codec, channelCount, [ ...AUDIO_PACKAGES, WMA_AUDIO_PACKAGE ])).toMatchObject({
                audioDecoder: { codec, source: { manifest: WMA_AUDIO_PACKAGE.manifest } },
                audioOutputMode: 'decoded-pcm',
                audioSourceChannelCount: channelCount,
                audioTrackIndex: 0,
                eligible: true
            });
        });

        it.each([
            // WMA v2 holds at most two channels, WMA Voice one, and no route presents 6.1
            [ 'wmav2', 6 ],
            [ 'wmavoice', 2 ],
            [ 'wmapro', 7 ]
        ] as const)('rejects %s with %i channels, which its decoder does not output in a layout a route presents', (codec, channelCount) => {
            expect(getWMAEligibility('mkv', codec, channelCount, [ WMA_AUDIO_PACKAGE ])).toEqual({ eligible: false, reason: 'audio-layout-unsupported' });
        });

        it('rejects WMA without a WMA package, and from a container whose demuxer reads no WAVEFORMATEX', () => {
            expect(getWMAEligibility('mkv', 'wmav2', 2, AUDIO_PACKAGES)).toEqual({ eligible: false, reason: 'audio-codec-unsupported' });
            expect(getWMAEligibility('mp4', 'wmav2', 2, [ WMA_AUDIO_PACKAGE ])).toEqual({ eligible: false, reason: 'container-unsupported' });
        });
    });

    it.each([
        [ 'mkv', 'truehd', 'Dolby TrueHD', 2, 48_000, undefined ],
        [ 'matroska', 'truehd', 'Dolby TrueHD + Dolby Atmos', 6, 96_000, undefined ],
        [ 'mkv', 'truehd', 'Dolby TrueHD + Dolby Atmos', 8, 48_000, '7.1' ],
        [ 'mkv', 'mlp', undefined, 2, 48_000, undefined ]
    ] as const)(
        'selects the TrueHD audio decoder package for %s/%s',
        (container, codec, profile, channelCount, sampleRate, channelLayout) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[1].Channels = channelCount;
            mediaSource.MediaStreams[1].Codec = codec;
            mediaSource.MediaStreams[1].Profile = profile;
            mediaSource.MediaStreams[1].SampleRate = sampleRate;
            mediaSource.MediaStreams[1].ChannelLayout = channelLayout;
            // A package decodes without the browser's audio decoder
            const packageRuntime: CustomPlaybackRuntimeAvailability = {
                available: true,
                environment: {
                    ...AVAILABLE_RUNTIME.environment,
                    audioData: false,
                    audioDecoder: false
                },
                reason: null
            };

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: packageRuntime }
            )).toMatchObject({
                audioDecoder: { codec, source: { manifest: TRUEHD_AUDIO_PACKAGE.manifest } },
                audioOutputMode: 'decoded-pcm',
                audioTrackIndex: 0,
                eligible: true
            });
        }
    );

    it('rejects TrueHD layouts without a presentation path, and TrueHD without an audio decoder package', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mkv';
        mediaSource.MediaStreams[1].ChannelLayout = '7.1';
        mediaSource.MediaStreams[1].Channels = 8;
        mediaSource.MediaStreams[1].Codec = 'truehd';
        mediaSource.MediaStreams[1].Profile = 'Dolby TrueHD + Dolby Atmos';
        mediaSource.MediaStreams[1].SampleRate = 96_000;

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'audio-layout-unsupported' });

        mediaSource.MediaStreams[1].Channels = 6;
        mediaSource.MediaStreams[1].ChannelLayout = undefined;
        mediaSource.MediaStreams[1].SampleRate = 48_000;
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'audio-codec-unsupported' });
    });

    it.each([
        [ 'mov,mp4,m4a,3gp,3g2,mj2', 'dts', 'DTS-HD MA', 8, 48_000, undefined ],
        [ 'mp4', 'dts', 'DTS', 6, 48_000, undefined ],
        [ 'mov', 'dts', 'DTS-HD MA', 1, 96_000, undefined ],
        [ 'mov,mp4,m4a,3gp,3g2,mj2', 'truehd', 'Dolby TrueHD', 6, 96_000, undefined ],
        [ 'm4v', 'truehd', 'Dolby TrueHD + Dolby Atmos', 8, 48_000, '7.1' ]
    ] as const)(
        'selects the %s %s package route through the mapped ISO BMFF sample entry',
        (container, codec, profile, channelCount, sampleRate, channelLayout) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[1].ChannelLayout = channelLayout;
            mediaSource.MediaStreams[1].Channels = channelCount;
            mediaSource.MediaStreams[1].Codec = codec;
            mediaSource.MediaStreams[1].Profile = profile;
            mediaSource.MediaStreams[1].SampleRate = sampleRate;

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioDecoder: { codec },
                audioOutputMode: 'decoded-pcm',
                audioSourceChannelCount: channelCount,
                audioTrackIndex: 0,
                eligible: true
            });
        }
    );

    it('keeps MLP Matroska-only', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[1].Codec = 'mlp';

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'container-unsupported' });
    });

    it.each([
        [ 'mkv', 'dts', 'DTS' ],
        [ 'mkv', 'dts', 'DTS-HD MA' ],
        [ 'mkv', 'flac', undefined ],
        [ 'mkv', 'ac3', undefined ],
        [ 'mkv', 'eac3', undefined ],
        [ 'mkv', 'truehd', 'Dolby TrueHD' ],
        [ 'mov,mp4,m4a,3gp,3g2,mj2', 'aac', 'HE-AACv2' ],
        [ 'mov,mp4,m4a,3gp,3g2,mj2', 'mp3', undefined ]
    ] as const)(
        'selects decoded PCM for mono %s %s, which the mixer centers or duplicates',
        (container, codec, profile) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[1].Channels = 1;
            mediaSource.MediaStreams[1].Codec = codec;
            mediaSource.MediaStreams[1].Profile = profile;

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioOutputMode: 'decoded-pcm',
                audioSourceChannelCount: 1,
                eligible: true
            });
        }
    );

    // Jellyfin cuts 3.0(back) to 3.0, which only a decoder speaker mask can tell apart, so a package's three-channel DTS needs no layout
    it.each([
        [ 'dts', 'DTS-HD MA', '2.1', true ],
        [ 'dts', 'DTS-HD MA', '3.0', true ],
        [ 'dts', 'DTS-HD MA + DTS:X', '3.0', true ],
        [ 'dts', 'DTS-HD MA', '3 channels', true ],
        [ 'dts', 'DTS-HD MA', undefined, true ],
        [ 'dts', 'DTS', '3.0', true ],
        [ 'flac', undefined, '3.0', true ],
        [ 'aac', undefined, '3.0', true ],
        [ 'opus', undefined, '3.0', true ],
        [ 'vorbis', undefined, '3.0', true ],
        [ 'pcm_s16le', undefined, '3.0', true ],
        [ 'aac', undefined, '2.1', false ],
        [ 'ac3', undefined, '2.1', false ],
        [ 'ac3', undefined, '3.0', false ],
        [ 'opus', undefined, undefined, false ],
        [ 'eac3', undefined, '3.0', false ]
    ] as const)(
        'qualifies three-channel %s %s with layout %s: %s',
        (codec, profile, channelLayout, eligible) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = 'mkv';
            mediaSource.MediaStreams[1].ChannelLayout = channelLayout;
            mediaSource.MediaStreams[1].Channels = 3;
            mediaSource.MediaStreams[1].Codec = codec;
            mediaSource.MediaStreams[1].Profile = profile;

            const eligibility = getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: AVAILABLE_RUNTIME }
            );

            expect(eligibility).toEqual(eligible ?
                expect.objectContaining({ audioSourceChannelCount: 3, eligible: true }) :
                { eligible: false, reason: 'audio-layout-unsupported' });
        }
    );

    it.each([ 'm2ts', 'mts', 'ts' ] as const)(
        'does not advertise TrueHD in the unsupported Mediabunny %s demux route',
        container => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[1].Channels = 6;
            mediaSource.MediaStreams[1].Codec = 'truehd';
            mediaSource.MediaStreams[1].SampleRate = 96_000;

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, audioDecoders: AUDIO_PACKAGES, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toEqual({ eligible: false, reason: 'container-unsupported' });
        }
    );

    it.each([
        [ 'mkv', 'pcm_s24le', 1, 44_100 ],
        [ 'mkv', 'pcm_f64le', 6, 96_000 ],
        [ 'mov', 'pcm_s8', 2, 192_000 ],
        [ 'mov', 'pcm_s24le', 2, 12_345 ],
        [ 'mov', 'pcm_s24le', 2, SUB_3_KHZ_SAMPLE_RATE ],
        [ 'mov', 'pcm_s24le', 2, ABOVE_192_KHZ_SAMPLE_RATE ],
        [ 'mkv', 'pcm_s24le', 2, DXD_SAMPLE_RATE ],
        [ 'mov', 'pcm_mulaw', 1, 8_000 ],
        [ 'mov', 'pcm_alaw', 1, 8_000 ]
    ] as const)(
        'selects Mediabunny PCM for %s/%s at %i channels and %i Hz',
        (container, codec, channelCount, sampleRate) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[1].Channels = channelCount;
            mediaSource.MediaStreams[1].Codec = codec;
            mediaSource.MediaStreams[1].SampleRate = sampleRate;
            const PCMRuntime: CustomPlaybackRuntimeAvailability = {
                available: true,
                environment: {
                    ...AVAILABLE_RUNTIME.environment,
                    audioData: false,
                    audioDecoder: false
                },
                reason: null
            };

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: PCMRuntime }
            )).toMatchObject({
                audioOutputMode: 'decoded-pcm',
                audioTrackIndex: 0,
                eligible: true
            });
        }
    );

    it.each([
        [ 'mkv', 'pcm_s8', 2, 48_000, 'container-unsupported' ],
        [ 'mkv', 'pcm_f32be', 2, 48_000, 'container-unsupported' ],
        [ 'mp4', 'pcm_alaw', 1, 8_000, 'container-unsupported' ],
        [ 'mov', 'pcm_s24le', 8, 48_000, 'audio-layout-unsupported' ],
        [ 'mov', 'pcm_s24le', 2, ZERO_SAMPLE_RATE, 'audio-layout-unsupported' ],
        [ 'mov', 'pcm_s24le', 2, FRACTIONAL_SAMPLE_RATE, 'audio-layout-unsupported' ]
    ] as const)(
        'rejects unimplemented PCM route %s/%s/%i/%i',
        (container, codec, channelCount, sampleRate, reason) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[1].Channels = channelCount;
            mediaSource.MediaStreams[1].Codec = codec;
            mediaSource.MediaStreams[1].SampleRate = sampleRate;

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toEqual({ eligible: false, reason });
        }
    );

    it.each([ 'aac', 'opus', 'flac', 'vorbis' ] as const)(
        'selects decoded PCM for exact qualified native 5.1 %s input',
        codec => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.MediaStreams[1].Channels = 6;
            mediaSource.MediaStreams[1].Codec = codec;
            const capabilities: CustomDecodeCapabilities = {
                ...createCapabilities(),
                nativeSurroundAudio: createNativeSurroundAudioCapabilities(new Set([ codec ]))
            };

            expect(getCustomPlaybackEligibility(
                options,
                capabilities,
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioOutputMode: 'decoded-pcm',
                audioTrackIndex: 0,
                eligible: true
            });
        }
    );

    it.each([ 'aac', 'opus', 'flac', 'vorbis' ] as const)(
        'selects decoded PCM for 7.1 %s input only with its 7.1 verdict',
        codec => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.MediaStreams[1].Channels = 8;
            mediaSource.MediaStreams[1].ChannelLayout = '7.1';
            mediaSource.MediaStreams[1].Codec = codec;
            const fivePointOneOnly: CustomDecodeCapabilities = {
                ...createCapabilities(),
                nativeSurroundAudio: createNativeSurroundAudioCapabilities(new Set([ codec ]))
            };
            const sevenPointOne: CustomDecodeCapabilities = {
                ...createCapabilities(),
                nativeSevenPointOneAudio: createNativeSurroundAudioCapabilities(new Set([ codec ]), 8)
            };

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toEqual({ eligible: false, reason: 'audio-layout-unsupported' });
            expect(getCustomPlaybackEligibility(
                options,
                fivePointOneOnly,
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toEqual({ eligible: false, reason: 'audio-layout-unsupported' });
            expect(getCustomPlaybackEligibility(
                options,
                sevenPointOne,
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioOutputMode: 'decoded-pcm',
                audioTrackIndex: 0,
                eligible: true
            });
        }
    );

    it('keeps 5.1 on its own verdict when only the 7.1 verdict holds', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[1].Channels = 6;
        mediaSource.MediaStreams[1].Codec = 'opus';

        expect(getCustomPlaybackEligibility(
            options,
            {
                ...createCapabilities(),
                nativeSevenPointOneAudio: createNativeSurroundAudioCapabilities(new Set([ 'opus' ]), 8)
            },
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'audio-layout-unsupported' });
    });

    it('refuses 7.1 MP3 whatever the 7.1 verdicts', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[1].Channels = 8;
        mediaSource.MediaStreams[1].Codec = 'mp3';

        expect(getCustomPlaybackEligibility(
            options,
            {
                ...createCapabilities(),
                nativeSevenPointOneAudio: createNativeSurroundAudioCapabilities(new Set(CUSTOM_NATIVE_SURROUND_AUDIO_CODECS), 8)
            },
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'audio-layout-unsupported' });
    });

    it.each([
        [ undefined, 3_000 ],
        [ 1, 12_345 ],
        [ 50_000_000, 96_000 ],
        [ 1_500_000_000, 192_000 ]
    ] as const)(
        'ignores encoded audio bitrate %s at source rate %i',
        (bitrate, sampleRate) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.MediaStreams[1].BitRate = bitrate;
            mediaSource.MediaStreams[1].SampleRate = sampleRate;

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioOutputMode: 'decoded-pcm',
                eligible: true
            });
        }
    );

    it('does not apply the surround downmix claim without exact output evidence', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[1].Channels = 6;
        mediaSource.MediaStreams[1].Codec = 'aac';

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'audio-layout-unsupported' });
    });

    it.each([
        [ 2, ZERO_SAMPLE_RATE ],
        [ 2, FRACTIONAL_SAMPLE_RATE ],
        [ undefined, 48_000 ],
        [ 2, undefined ]
    ])('rejects an unmeasured selected audio layout %#', (channelCount, sampleRate) => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[1].Channels = channelCount;
        mediaSource.MediaStreams[1].SampleRate = sampleRate;

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'audio-layout-unsupported' });
    });

    it.each([
        [ { playMethod: 'Transcode' }, 'play-method-unsupported' ],
        [ { mediaSource: { Container: 'flv', MediaStreams: [], RunTimeTicks: 1 } }, 'container-unsupported' ],
        [ { source: { kind: 'url', url: FILE_URL } }, 'url-unsupported' ],
        [ { source: { kind: 'url', url: CREDENTIAL_URL } }, 'url-unsupported' ],
        [ { source: { kind: 'url', url: EMPTY_URL } }, 'invalid-options' ],
        [ { source: { file: LOCAL_FILE_NAME, kind: 'file' } }, 'invalid-options' ],
        [ { source: undefined }, 'invalid-options' ]
    ])('rejects unsafe source overrides %#', (overrides, reason) => {
        expect(getCustomPlaybackEligibility(
            createOptions(overrides),
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason });
    });

    it('resolves a URL source against the page', () => {
        expect(getCustomPlaybackEligibility(
            createOptions(),
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({ eligible: true, source: { kind: 'url', url: new URL(STREAM_URL, globalThis.location.href).href } });
    });

    it('keeps the host\'s path pattern for responses that hide Content-Range, and adds none of its own', () => {
        const resolvedURL = new URL(STREAM_URL, globalThis.location.href).href;
        const withPattern = getCustomPlaybackEligibility(
            createOptions({ source: { hiddenContentRangePathPattern: HIDDEN_CONTENT_RANGE_PATH_PATTERN, kind: 'url', url: STREAM_URL } }),
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        );
        const withoutPattern = getCustomPlaybackEligibility(
            createOptions(),
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        );

        expect(withPattern.eligible && withPattern.source).toEqual({ hiddenContentRangePathPattern: HIDDEN_CONTENT_RANGE_PATH_PATTERN, kind: 'url', url: resolvedURL });
        expect(withoutPattern.eligible && withoutPattern.source).toEqual({ kind: 'url', url: resolvedURL });
    });

    it('plays a file source as it is', () => {
        const source = { file: new File([], LOCAL_FILE_NAME), kind: 'file' };

        const eligibility = getCustomPlaybackEligibility(
            createOptions({ source }),
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        );

        expect(eligibility.eligible && eligibility.source).toBe(source);
    });

    it('requires the full runtime and measured selected codecs', () => {
        const baseCapabilities = createCapabilities();
        const capabilities: CustomDecodeCapabilities = {
            ...baseCapabilities,
            audio: {
                ...baseCapabilities.audio,
                aac: createCapability('aac', false)
            }
        };
        expect(getCustomPlaybackEligibility(
            createOptions(),
            capabilities,
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'audio-codec-unsupported' });

        expect(getCustomPlaybackEligibility(
            createOptions(),
            createCapabilities(),
            {
                allowRawHDR: false,
                runtimeAvailability: {
                    ...AVAILABLE_RUNTIME,
                    available: false,
                    reason: 'webgpu-unavailable'
                }
            }
        )).toEqual({ eligible: false, reason: 'runtime-unavailable' });
    });
});

describe('Dolby Vision routes beyond the standard Profile 5, 7, and 8 shapes', () => {
    const PQ_EXTERNAL_ROUTE_KEY = 'external-hevc-main10-bt709-limited:pq-v1';
    const SDR_BASE_COLORS = {
        ColorPrimaries: 'bt709',
        ColorSpace: 'bt709',
        ColorTransfer: 'bt709'
    } as const;
    const PQ_BASE_COLORS = {
        ColorPrimaries: 'bt2020',
        ColorSpace: 'bt2020nc',
        ColorTransfer: 'smpte2084'
    } as const;
    const MAIN_12_STREAM = {
        BitDepth: 12,
        PixelFormat: 'yuv420p12le',
        Profile: 'Main 12'
    } as const;

    function createDolbyVisionOptions(videoStream: Record<string, unknown>): Record<string, unknown> {
        return createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 1,
                MediaStreams: [
                    {
                        BitDepth: 10,
                        BlPresentFlag: true,
                        Codec: 'hevc',
                        Height: 1_080,
                        Index: 0,
                        IsInterlaced: false,
                        Level: 120,
                        Profile: 'Main 10',
                        RpuPresentFlag: true,
                        Type: 'Video',
                        Width: 1_920,
                        ...videoStream
                    },
                    {
                        Channels: 2,
                        Codec: 'aac',
                        Index: 1,
                        SampleRate: 48_000,
                        Type: 'Audio'
                    }
                ],
                RunTimeTicks: 60_000_000
            }
        });
    }

    function createRangeExtensionCapabilities(): CustomDecodeCapabilities {
        const hevcRangeExtensions = {} as Record<HEVCRangeExtensionVariant, HEVCRangeExtensionCapability>;
        for (const variant of HEVC_RANGE_EXTENSION_VARIANTS) {
            const definition = HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant];
            hevcRangeExtensions[variant] = {
                bitDepth: definition.bitDepth,
                chromaFormat: definition.chromaFormat,
                codec: 'hevc',
                codecString: definition.config.codec,
                format: definition.format,
                jellyfinProfile: definition.jellyfinProfile,
                pixelFormat: definition.pixelFormat,
                reason: 'output-copy-supported',
                status: 'supported',
                variant
            };
        }
        return { ...createCapabilities(), hevcRangeExtensions };
    }

    it('reconstructs Profile 7 without its EL through the dual-layer route', () => {
        expect(getCustomPlaybackEligibility(
            createDolbyVisionOptions({
                DvBlSignalCompatibilityId: 0,
                DvProfile: 7,
                ElPresentFlag: false,
                VideoRangeType: 'DOVIWithEL'
            }),
            createCapabilities(),
            {
                allowDolbyVisionProfile7: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            dolbyVisionProfile: 7,
            eligible: true,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        });
    });

    it('presents the native HDR10 base of Profile 7 without its EL', () => {
        expect(getCustomPlaybackEligibility(
            createDolbyVisionOptions({
                ...PQ_BASE_COLORS,
                DvBlSignalCompatibilityId: 6,
                DvProfile: 7,
                ElPresentFlag: false,
                VideoRange: 'HDR',
                VideoRangeType: 'DOVIWithEL'
            }),
            createCapabilities(),
            {
                allowNativeDolbyVisionProfile7HDR10Base: true,
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [ PQ_EXTERNAL_ROUTE_KEY ],
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            dolbyVisionProfile: null,
            eligible: true,
            nativeHDRTransfer: 'pq',
            videoOutputMode: 'video-frame'
        });
    });

    it('reconstructs Profile 8 that signals an EL through the single-layer route', () => {
        expect(getCustomPlaybackEligibility(
            createDolbyVisionOptions({
                DvBlSignalCompatibilityId: 0,
                DvProfile: 8,
                ElPresentFlag: true,
                VideoRangeType: 'DOVIInvalid'
            }),
            createCapabilities(),
            {
                allowDolbyVision: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            dolbyVisionProfile: 8,
            eligible: true,
            rawVideoFrameFormat: 'I420P10'
        });
    });

    it('reconstructs Profile 4 through the dual-layer route', () => {
        expect(getCustomPlaybackEligibility(
            createDolbyVisionOptions({
                ...SDR_BASE_COLORS,
                DvBlSignalCompatibilityId: 2,
                DvProfile: 4,
                ElPresentFlag: true,
                VideoRangeType: 'SDR'
            }),
            createCapabilities(),
            {
                allowDolbyVisionProfile4: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            dolbyVisionProfile: 4,
            eligible: true,
            hdr: true,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        });
    });

    it('presents the SDR base of Profile 4 when its RPU route is unavailable', () => {
        expect(getCustomPlaybackEligibility(
            createDolbyVisionOptions({
                ...SDR_BASE_COLORS,
                DvBlSignalCompatibilityId: 2,
                DvProfile: 4,
                ElPresentFlag: true,
                VideoRangeType: 'SDR'
            }),
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({
            dolbyVisionProfile: null,
            eligible: true,
            hdr: false,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
    });

    it('presents the SDR base of Profile 9 AVC through the native H.264 route', () => {
        const options = createDolbyVisionOptions({
            ...SDR_BASE_COLORS,
            BitDepth: 8,
            Codec: 'h264',
            DvBlSignalCompatibilityId: 2,
            DvProfile: 9,
            Profile: 'High',
            VideoRangeType: 'SDR'
        });

        expect(hasPotentialCustomPlaybackVideoRoute({
            MediaSources: [ (options as { mediaSource: unknown }).mediaSource ]
        })).toBe(true);
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({
            dolbyVisionProfile: null,
            eligible: true,
            hdr: false,
            rawVideoFrameFormat: null,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
    });

    it.each([
        [ 0, 5 ],
        [ null, 5 ],
        [ 1, 8 ],
        [ 4, 8 ]
    ])('reconstructs the Profile 20 base view with compatibility ID %s as single-layer Profile %i', (
        compatibilityID,
        expectedProfile
    ) => {
        expect(getCustomPlaybackEligibility(
            createDolbyVisionOptions({
                ...(compatibilityID === null ? {} : {
                    DvBlSignalCompatibilityId: compatibilityID
                }),
                DvProfile: 20,
                VideoRangeType: 'SDR'
            }),
            createCapabilities(),
            {
                allowDolbyVision: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            dolbyVisionProfile: expectedProfile,
            eligible: true,
            rawVideoFrameFormat: 'I420P10'
        });
    });

    it('presents the declared PQ base of Profile 20 when its RPU route is unavailable', () => {
        expect(getCustomPlaybackEligibility(
            createDolbyVisionOptions({
                ...PQ_BASE_COLORS,
                DvBlSignalCompatibilityId: 1,
                DvProfile: 20,
                VideoRange: 'SDR',
                VideoRangeType: 'SDR'
            }),
            createCapabilities(),
            PQ_AUTHORIZATION
        )).toMatchObject({
            dolbyVisionProfile: null,
            eligible: true,
            hdr: true,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        });
    });

    it('presents the SDR base of Profile 8.2 when its RPU route is unavailable', () => {
        expect(getCustomPlaybackEligibility(
            createDolbyVisionOptions({
                ...SDR_BASE_COLORS,
                DvBlSignalCompatibilityId: 2,
                DvProfile: 8,
                VideoRangeType: 'DOVIWithSDR'
            }),
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({
            dolbyVisionProfile: null,
            eligible: true,
            hdr: false,
            videoOutputMode: 'video-frame'
        });
    });

    it('reconstructs Dolby Vision on a Main 12 source in its range-extension format', () => {
        expect(getCustomPlaybackEligibility(
            createDolbyVisionOptions({
                ...MAIN_12_STREAM,
                DvBlSignalCompatibilityId: 0,
                DvProfile: 8,
                VideoRangeType: 'DOVIInvalid'
            }),
            createRangeExtensionCapabilities(),
            {
                allowDolbyVision: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            dolbyVisionProfile: 8,
            eligible: true,
            rawVideoFrameFormat: 'I420P12',
            videoDecoderBackend: 'native'
        });
    });

    it('presents the declared HDR10 base of a Main 12 source through its range-extension route', () => {
        expect(getCustomPlaybackEligibility(
            createDolbyVisionOptions({
                ...MAIN_12_STREAM,
                ...PQ_BASE_COLORS,
                DvBlSignalCompatibilityId: 1,
                DvProfile: 8,
                VideoRangeType: 'DOVIWithHDR10'
            }),
            createRangeExtensionCapabilities(),
            {
                allowRawHDR: true,
                authorizedRawHDRRouteKeys: [ 'I420P12:bt2020-ncl:bt2020:limited:pq' ],
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            dolbyVisionProfile: null,
            eligible: true,
            hdr: true,
            rawVideoFrameFormat: 'I420P12'
        });
    });

    it('reconstructs Profile 7 over a Main 12 base in its range-extension format', () => {
        expect(getCustomPlaybackEligibility(
            createDolbyVisionOptions({
                ...MAIN_12_STREAM,
                DvBlSignalCompatibilityId: 0,
                DvProfile: 7,
                ElPresentFlag: true,
                VideoRangeType: 'DOVIWithEL'
            }),
            createRangeExtensionCapabilities(),
            {
                allowDolbyVisionProfile7: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            dolbyVisionProfile: 7,
            eligible: true,
            hdr: true,
            rawVideoFrameFormat: 'I420P12',
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes'
        });
    });

    it('reconstructs 8-bit Main only on a GPU decoder, the one route that reads its planes, and fails closed without one', () => {
        const options = createDolbyVisionOptions({
            BitDepth: 8,
            DvBlSignalCompatibilityId: 0,
            DvProfile: 8,
            Profile: 'Main',
            VideoRangeType: 'DOVIInvalid'
        });
        const eligibilityOptions = { allowDolbyVision: true, allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME };

        expect(getCustomPlaybackEligibility(options, createCapabilities(), eligibilityOptions))
            .toEqual({ eligible: false, reason: 'hdr-codec-unsupported' });
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { ...eligibilityOptions, gpuVideoDecoders: createVideoDecoderOffers(HEVC_VIDEO_PACKAGE) }
        )).toMatchObject({
            dolbyVisionProfile: 8,
            eligible: true,
            hdr: true,
            rawVideoFrameFormat: 'I420',
            videoDecoderBackend: 'gpu',
            videoOutputMode: 'frame-pool'
        });
    });

    it.each([
        [ {}, 'I420P10' ],
        [ MAIN_12_STREAM, 'I420P12' ],
        // Dual-layer profiles reconstruct in a range extension's own format, and 8-bit Main in I420
        [ { ...MAIN_12_STREAM, DvProfile: 7, ElPresentFlag: true }, 'I420P12' ],
        [ { DvProfile: 4, ElPresentFlag: true, PixelFormat: 'yuv422p10le', Profile: 'Rext' }, 'I422P10' ],
        [ { BitDepth: 8, Profile: 'Main' }, 'I420' ],
        [ { BitDepth: 8, DvProfile: 7, ElPresentFlag: true, Profile: 'Main' }, 'I420' ],
        [ { Codec: 'av1', DvProfile: 10, Profile: 'Main' }, 'I420P10' ],
        [ { Codec: 'av1', DvBlSignalCompatibilityId: 1, DvProfile: 10, Profile: 'Main' }, 'I420P10' ],
        // AV1 carries no EL; its RPU route takes Main at 10 bits, or the exact raw format its PixelFormat names
        [ { Codec: 'av1', DvProfile: 7, ElPresentFlag: true, Profile: 'Main' }, null ],
        [ { BitDepth: 8, Codec: 'av1', DvProfile: 10, Profile: 'Main' }, null ],
        [ { BitDepth: 8, Codec: 'av1', DvProfile: 10, PixelFormat: 'yuv420p', Profile: 'Main' }, 'I420' ],
        [ { BitDepth: 10, Codec: 'av1', DvProfile: 10, PixelFormat: 'yuv444p10le', Profile: 'High' }, 'I444P10' ],
        [ { BitDepth: 12, Codec: 'av1', DvProfile: 10, Profile: 'Professional' }, null ],
        [ { BitDepth: 12, Codec: 'av1', DvProfile: 10, PixelFormat: 'yuv422p12le', Profile: 'Professional' }, 'I422P12' ],
        [ { BitDepth: 8, Codec: 'h264', DvProfile: 9, Profile: 'High' }, null ],
        [ { Codec: 'vp9', DvProfile: 8, Profile: 'Profile 2' }, null ],
        [ { BitDepth: 10, Profile: 'Main' }, null ],
        [ { Codec: undefined }, null ]
    ])('reports the reconstruction frame format of %o as %s', (videoStream, format) => {
        expect(getDolbyVisionReconstructionRawFrameFormat(createDolbyVisionOptions({
            DvBlSignalCompatibilityId: 0,
            DvProfile: 8,
            ...videoStream
        }))).toBe(format);
    });

    it('judges an item video route exactly like playback eligibility', () => {
        const profile4Options = createDolbyVisionOptions({
            ...SDR_BASE_COLORS,
            DvBlSignalCompatibilityId: 0,
            DvProfile: 4,
            ElPresentFlag: true,
            VideoRangeType: 'SDR'
        });
        const mediaSource = (profile4Options as { mediaSource: unknown }).mediaSource;

        expect(hasEligibleCustomVideoRoute(mediaSource, createCapabilities(), {
            allowDolbyVisionProfile4: true,
            allowRawHDR: false
        })).toBe(true);
        // Compatibility ID 0 declares no base, so without the RPU route nothing presents the stream
        expect(hasEligibleCustomVideoRoute(mediaSource, createCapabilities(), {
            allowRawHDR: false
        })).toBe(false);
    });

    describe('AV1 Profile 10', () => {
        const HLG_BASE_COLORS = {
            ColorPrimaries: 'bt2020',
            ColorSpace: 'bt2020nc',
            ColorTransfer: 'arib-std-b67'
        } as const;
        const DECLARED_BASE_AUTHORIZATION = {
            allowRawHDR: true,
            allowRawSDR: true,
            authorizedRawHDRRouteKeys: [
                'I420P10:bt2020-ncl:bt2020:limited:hlg',
                'I420P10:bt2020-ncl:bt2020:limited:pq',
                'I420P10:bt709:bt709:limited:sdr'
            ] as const,
            runtimeAvailability: AVAILABLE_RUNTIME
        };

        function createProfile10Options(
            compatibilityID: number | null,
            videoStream: Record<string, unknown>
        ): Record<string, unknown> {
            return createDolbyVisionOptions({
                Codec: 'av1',
                ...(compatibilityID === null ? {} : {
                    DvBlSignalCompatibilityId: compatibilityID
                }),
                DvProfile: 10,
                Profile: 'Main',
                ...videoStream
            });
        }

        describe('on the native external Dolby Vision route', () => {
            const AV1_DECODE_KEY = 'external-av1-main10-bt709-limited:pq-v1' as const;
            const NATIVE_ROUTE = {
                eligible: true,
                neutralizeHDRColorMetadata: false,
                rawVideoFrameFormat: null,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame'
            } as const;

            function createNativeOptions(overrides: Partial<CustomPlaybackEligibilityOptions> = {}): CustomPlaybackEligibilityOptions {
                return {
                    ...DECLARED_BASE_AUTHORIZATION,
                    allowDolbyVision: true,
                    allowNativeDolbyVision: true,
                    allowNativeDolbyVisionProfile8: true,
                    authorizedExternalHDRRouteKeys: [ AV1_DECODE_KEY ],
                    ...overrides
                };
            }

            it.each([
                { colors: {}, compatibilityID: 0, profile: 5, rangeType: 'DOVI' },
                { colors: PQ_BASE_COLORS, compatibilityID: 1, profile: 8, rangeType: 'DOVIWithHDR10' },
                { colors: SDR_BASE_COLORS, compatibilityID: 2, profile: 8, rangeType: 'DOVIWithSDR' },
                { colors: HLG_BASE_COLORS, compatibilityID: 4, profile: 8, rangeType: 'DOVIWithHLG' }
            ])('reconstructs $rangeType as Profile $profile from hardware frames', ({ colors, compatibilityID, profile, rangeType }) => {
                expect(getCustomPlaybackEligibility(
                    createProfile10Options(compatibilityID, { ...colors, VideoRangeType: rangeType }),
                    createNativeAV1Capabilities(),
                    createNativeOptions()
                )).toMatchObject({ ...NATIVE_ROUTE, dolbyVisionProfile: profile });
            });

            it.each([
                { label: 'without the AV1 decoder key', overrides: { authorizedExternalHDRRouteKeys: [ 'external-hevc-main10-bt709-limited:pq-v1' as const ] } },
                { label: 'without the external Profile 8 key', overrides: { allowNativeDolbyVisionProfile8: false } }
            ])('keeps raw I420P10 reconstruction $label', ({ overrides }) => {
                expect(getCustomPlaybackEligibility(
                    createProfile10Options(1, { ...PQ_BASE_COLORS, VideoRangeType: 'DOVIWithHDR10' }),
                    createNativeAV1Capabilities(),
                    createNativeOptions(overrides)
                )).toMatchObject({ dolbyVisionProfile: 8, rawVideoFrameFormat: 'I420P10', videoOutputMode: 'raw-planes' });
            });

            it('keeps raw reconstruction without a verified AV1 hardware decoder, and Profile 5 needs its own key', () => {
                expect(getCustomPlaybackEligibility(
                    createProfile10Options(1, { ...PQ_BASE_COLORS, VideoRangeType: 'DOVIWithHDR10' }),
                    createCapabilities(),
                    createNativeOptions()
                )).toMatchObject({ rawVideoFrameFormat: 'I420P10' });
                expect(getCustomPlaybackEligibility(
                    createProfile10Options(0, { VideoRangeType: 'DOVI' }),
                    createNativeAV1Capabilities(),
                    createNativeOptions({ allowNativeDolbyVision: false })
                )).toMatchObject({ dolbyVisionProfile: 5, rawVideoFrameFormat: 'I420P10' });
            });

            it('opens no external Profile 8 route to HEVC, whose compatible base stays native without its RPU', () => {
                const eligibility = getCustomPlaybackEligibility(
                    createDolbyVisionOptions({ ...PQ_BASE_COLORS, DvBlSignalCompatibilityId: 1, DvProfile: 8, VideoRangeType: 'DOVIWithHDR10' }),
                    createCapabilities(),
                    createNativeOptions({ authorizedExternalHDRRouteKeys: [ AV1_DECODE_KEY ] })
                );

                expect(eligibility).not.toMatchObject({ dolbyVisionProfile: 8, videoOutputMode: 'video-frame' });
            });
        });

        // Jellyfin's range labels; a stream without a compatibility ID is labeled by its transfer
        it.each([
            { colors: {}, compatibilityID: 0, rangeType: 'DOVI', reconstructionProfile: 5 },
            { colors: PQ_BASE_COLORS, compatibilityID: 1, rangeType: 'DOVIWithHDR10', reconstructionProfile: 8 },
            { colors: SDR_BASE_COLORS, compatibilityID: 2, rangeType: 'DOVIWithSDR', reconstructionProfile: 8 },
            { colors: HLG_BASE_COLORS, compatibilityID: 4, rangeType: 'DOVIWithHLG', reconstructionProfile: 8 },
            { colors: PQ_BASE_COLORS, compatibilityID: null, rangeType: 'HDR10', reconstructionProfile: 5 },
            { colors: PQ_BASE_COLORS, compatibilityID: 3, rangeType: 'DOVIInvalid', reconstructionProfile: 8 }
        ])('reconstructs $rangeType with ID $compatibilityID as Profile $reconstructionProfile in raw I420P10', ({
            colors,
            compatibilityID,
            rangeType,
            reconstructionProfile
        }) => {
            const options = createProfile10Options(compatibilityID, {
                ...colors,
                VideoRangeType: rangeType
            });
            const mediaSource = (options as { mediaSource: unknown }).mediaSource;

            expect(hasPotentialCustomPlaybackVideoRoute({ MediaSources: [ mediaSource ] })).toBe(true);
            expect(getDolbyVisionReconstructionRawFrameFormat(options)).toBe('I420P10');
            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                {
                    allowDolbyVision: true,
                    allowRawHDR: false,
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            )).toMatchObject({
                dolbyVisionProfile: reconstructionProfile,
                eligible: true,
                hdr: true,
                neutralizeHDRColorMetadata: false,
                rawVideoFrameFormat: 'I420P10',
                videoDecoderBackend: 'native',
                videoOutputMode: 'raw-planes'
            });
            expect(hasEligibleCustomVideoRoute(mediaSource, createCapabilities(), {
                allowDolbyVision: true,
                allowRawHDR: false
            })).toBe(true);
        });

        it.each([
            { colors: PQ_BASE_COLORS, compatibilityID: 1, hdr: true, rangeType: 'DOVIWithHDR10' },
            { colors: SDR_BASE_COLORS, compatibilityID: 2, hdr: false, rangeType: 'DOVIWithSDR' },
            { colors: HLG_BASE_COLORS, compatibilityID: 4, hdr: true, rangeType: 'DOVIWithHLG' }
        ])('presents the declared base of $rangeType through raw I420P10 when its RPU route is unavailable', ({
            colors,
            compatibilityID,
            hdr,
            rangeType
        }) => {
            const options = createProfile10Options(compatibilityID, {
                ...colors,
                VideoRangeType: rangeType
            });

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                DECLARED_BASE_AUTHORIZATION
            )).toMatchObject({
                dolbyVisionProfile: null,
                eligible: true,
                hdr,
                neutralizeHDRColorMetadata: false,
                rawVideoFrameFormat: 'I420P10',
                videoDecoderBackend: 'native',
                videoOutputMode: 'raw-planes'
            });
            expect(hasEligibleCustomVideoRoute(
                (options as { mediaSource: unknown }).mediaSource,
                createCapabilities(),
                DECLARED_BASE_AUTHORIZATION
            )).toBe(true);
        });

        // 10.0 has an IPT base, and the other IDs declare none, so only the RPU presents these streams
        it.each([
            { colors: {}, compatibilityID: 0, rangeType: 'DOVI' },
            { colors: PQ_BASE_COLORS, compatibilityID: null, rangeType: 'HDR10' },
            { colors: PQ_BASE_COLORS, compatibilityID: 3, rangeType: 'DOVIInvalid' }
        ])('fails closed for $rangeType with ID $compatibilityID when its RPU route is unauthorized', ({
            colors,
            compatibilityID,
            rangeType
        }) => {
            const options = createProfile10Options(compatibilityID, {
                ...colors,
                VideoRangeType: rangeType
            });

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                DECLARED_BASE_AUTHORIZATION
            )).toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
            expect(hasEligibleCustomVideoRoute(
                (options as { mediaSource: unknown }).mediaSource,
                createCapabilities(),
                DECLARED_BASE_AUTHORIZATION
            )).toBe(false);
        });

        it.each([
            { colors: {}, compatibilityID: 0, rangeType: 'DOVI', reason: 'hdr-codec-unsupported' },
            {
                colors: PQ_BASE_COLORS,
                compatibilityID: 1,
                rangeType: 'DOVIWithHDR10',
                reason: 'hdr-codec-unsupported'
            },
            // The SDR base falls through the SDR routes, whose reason is codec-unsupported
            { colors: SDR_BASE_COLORS, compatibilityID: 2, rangeType: 'DOVIWithSDR', reason: 'codec-unsupported' }
        ])('rejects $rangeType when raw AV1 decode is unqualified, which its declared base also needs', ({
            colors,
            compatibilityID,
            rangeType,
            reason
        }) => {
            const capabilities = createCapabilities();
            capabilities.rawHDRVideo = {
                ...capabilities.rawHDRVideo,
                av1: {
                    ...capabilities.rawHDRVideo.av1,
                    reason: 'output-copy-unsupported',
                    status: 'unsupported'
                }
            };

            expect(getCustomPlaybackEligibility(
                createProfile10Options(compatibilityID, { ...colors, VideoRangeType: rangeType }),
                capabilities,
                { ...DECLARED_BASE_AUTHORIZATION, allowDolbyVision: true }
            )).toEqual({ eligible: false, reason });
        });

        it('takes neither native HEVC Dolby Vision route for AV1', () => {
            const eligibilityOptions = {
                allowDolbyVision: true,
                allowNativeDolbyVision: true,
                allowNativeDolbyVisionProfile8HDR10Base: true,
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [ PQ_EXTERNAL_ROUTE_KEY ] as const,
                runtimeAvailability: AVAILABLE_RUNTIME
            };

            expect(getCustomPlaybackEligibility(
                createProfile10Options(0, { VideoRange: 'HDR', VideoRangeType: 'DOVI' }),
                createCapabilities(),
                eligibilityOptions
            )).toMatchObject({
                dolbyVisionProfile: 5,
                rawVideoFrameFormat: 'I420P10',
                videoOutputMode: 'raw-planes'
            });
            expect(getCustomPlaybackEligibility(
                createProfile10Options(1, {
                    ...PQ_BASE_COLORS,
                    ColorRange: 'tv',
                    VideoRange: 'HDR',
                    VideoRangeType: 'DOVIWithHDR10'
                }),
                createCapabilities(),
                eligibilityOptions
            )).toMatchObject({
                dolbyVisionProfile: 8,
                neutralizeHDRColorMetadata: false,
                rawVideoFrameFormat: 'I420P10',
                videoOutputMode: 'raw-planes'
            });
        });

        it('never reconstructs a dual-layer profile over AV1', () => {
            const eligibilityOptions = {
                ...DECLARED_BASE_AUTHORIZATION,
                allowDolbyVisionProfile7: true
            };

            // Compatibility ID 6 declares a PQ base, which the raw AV1 route presents
            expect(getCustomPlaybackEligibility(
                createProfile10Options(6, {
                    ...PQ_BASE_COLORS,
                    DvProfile: 7,
                    ElPresentFlag: true,
                    VideoRangeType: 'DOVIWithEL'
                }),
                createCapabilities(),
                eligibilityOptions
            )).toMatchObject({
                dolbyVisionProfile: null,
                eligible: true,
                hdr: true,
                rawVideoFrameFormat: 'I420P10'
            });
            expect(getCustomPlaybackEligibility(
                createProfile10Options(0, {
                    DvProfile: 7,
                    ElPresentFlag: true,
                    VideoRangeType: 'DOVIWithEL'
                }),
                createCapabilities(),
                eligibilityOptions
            )).toEqual({ eligible: false, reason: 'hdr-codec-unsupported' });
        });

        it('presents an 8-bit 10.2 base through the native AV1 route when no qualified raw format holds its RPU route', () => {
            expect(getCustomPlaybackEligibility(
                createProfile10Options(2, {
                    ...SDR_BASE_COLORS,
                    BitDepth: 8,
                    VideoRangeType: 'DOVIWithSDR'
                }),
                createCapabilities(),
                {
                    allowDolbyVision: true,
                    allowRawHDR: false,
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            )).toMatchObject({
                dolbyVisionProfile: null,
                eligible: true,
                hdr: false,
                rawVideoFrameFormat: null,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame'
            });
        });

        it.each([
            { colors: {}, compatibilityID: 0, format: 'I420', reconstructionProfile: 5, videoStream: { BitDepth: 8, PixelFormat: 'yuv420p' } },
            {
                colors: SDR_BASE_COLORS,
                compatibilityID: 2,
                format: 'I420',
                reconstructionProfile: 8,
                videoStream: { BitDepth: 8, PixelFormat: 'yuv420p' }
            },
            {
                colors: PQ_BASE_COLORS,
                compatibilityID: 1,
                format: 'I444P10',
                reconstructionProfile: 8,
                videoStream: { BitDepth: 10, PixelFormat: 'yuv444p10le', Profile: 'High' }
            },
            {
                colors: {},
                compatibilityID: 0,
                format: 'I422',
                reconstructionProfile: 5,
                videoStream: { BitDepth: 8, PixelFormat: 'yuv422p', Profile: 'Professional' }
            }
        ] as const)('reconstructs $format Profile 10 with ID $compatibilityID from its qualified exact raw format', ({
            colors,
            compatibilityID,
            format,
            reconstructionProfile,
            videoStream
        }) => {
            const options = createProfile10Options(compatibilityID, { ...colors, ...videoStream });
            const eligibilityOptions = { allowDolbyVision: true, allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME };

            expect(hasPotentialCustomPlaybackVideoRoute({ MediaSources: [ (options as { mediaSource: unknown }).mediaSource ] })).toBe(true);
            expect(getDolbyVisionReconstructionRawFrameFormat(options)).toBe(format);
            expect(getCustomPlaybackEligibility(options, createAV1RawFormatCapabilities(), eligibilityOptions)).toMatchObject({
                dolbyVisionProfile: reconstructionProfile,
                eligible: true,
                hdr: true,
                rawVideoFrameFormat: format,
                videoDecoderBackend: 'native',
                videoOutputMode: 'raw-planes'
            });
            // Without the format's qualification the RPU route is ineligible, and only a declared base can play
            const unqualified = getCustomPlaybackEligibility(options, createCapabilities(), eligibilityOptions);
            expect(unqualified).not.toMatchObject({ dolbyVisionProfile: reconstructionProfile });
        });
    });

    describe('8-bit HEVC Main', () => {
        const MAIN_STREAM = { BitDepth: 8, Profile: 'Main' } as const;

        it.each([
            { compatibilityID: 0, dualLayer: false, profile: 5, rangeType: 'DOVI' },
            { compatibilityID: 0, dualLayer: false, profile: 8, rangeType: 'DOVIInvalid' },
            { compatibilityID: 0, dualLayer: true, profile: 7, rangeType: 'DOVIWithEL' }
        ])('fails closed for Profile $profile without a declared base, since no native raw route reads I420', ({
            compatibilityID,
            dualLayer,
            profile,
            rangeType
        }) => {
            const options = createDolbyVisionOptions({
                ...MAIN_STREAM,
                DvBlSignalCompatibilityId: compatibilityID,
                DvProfile: profile,
                ElPresentFlag: dualLayer,
                VideoRangeType: rangeType
            });

            expect(getDolbyVisionReconstructionRawFrameFormat(options)).toBe('I420');
            // The native Profile 5 route is 10-bit only
            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                {
                    allowDolbyVision: true,
                    allowDolbyVisionProfile7: true,
                    allowNativeDolbyVision: true,
                    allowRawHDR: false,
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            )).toEqual({ eligible: false, reason: 'hdr-codec-unsupported' });
        });

        it.each([
            { profile: 4, rangeType: 'SDR' },
            { profile: 8, rangeType: 'DOVIWithSDR' }
        ])('presents the declared SDR base of Profile $profile through VF-SDR without its RPU route', ({
            profile,
            rangeType
        }) => {
            expect(getCustomPlaybackEligibility(
                createDolbyVisionOptions({
                    ...MAIN_STREAM,
                    ...SDR_BASE_COLORS,
                    DvBlSignalCompatibilityId: 2,
                    DvProfile: profile,
                    ElPresentFlag: profile === 4,
                    VideoRangeType: rangeType
                }),
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                dolbyVisionProfile: null,
                eligible: true,
                hdr: false,
                rawVideoFrameFormat: null,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame'
            });
        });

        it('rejects 10-bit metadata under the 8-bit Main profile', () => {
            const options = createDolbyVisionOptions({
                BitDepth: 10,
                DvBlSignalCompatibilityId: 0,
                DvProfile: 8,
                Profile: 'Main',
                VideoRangeType: 'DOVIInvalid'
            });

            expect(hasPotentialCustomPlaybackVideoRoute({
                MediaSources: [ (options as { mediaSource: unknown }).mediaSource ]
            })).toBe(false);
            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                {
                    allowDolbyVision: true,
                    allowRawHDR: false,
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            )).toEqual({ eligible: false, reason: 'hdr-codec-unsupported' });
        });
    });

    describe('dual-layer reconstruction over range extensions', () => {
        function createRangeExtensionOptions(
            variant: HEVCRangeExtensionVariant,
            videoStream: Record<string, unknown>
        ): Record<string, unknown> {
            const definition = HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant];
            return createDolbyVisionOptions({
                BitDepth: definition.bitDepth,
                ElPresentFlag: true,
                PixelFormat: definition.pixelFormat,
                Profile: 'Rext',
                ...videoStream
            });
        }

        it.each([
            { compatibilityID: 0, format: 'I422P10', profile: 7, rangeType: 'DOVIWithEL', variant: 'main422-10' },
            { compatibilityID: 2, format: 'I444P12', profile: 4, rangeType: 'SDR', variant: 'main444-12' }
        ] as const)('reconstructs Profile $profile over $variant in $format', ({
            compatibilityID,
            format,
            profile,
            rangeType,
            variant
        }) => {
            const options = createRangeExtensionOptions(variant, {
                DvBlSignalCompatibilityId: compatibilityID,
                DvProfile: profile,
                VideoRangeType: rangeType
            });

            expect(hasPotentialCustomPlaybackVideoRoute({
                MediaSources: [ (options as { mediaSource: unknown }).mediaSource ]
            })).toBe(true);
            expect(getDolbyVisionReconstructionRawFrameFormat(options)).toBe(format);
            expect(getCustomPlaybackEligibility(
                options,
                createRangeExtensionCapabilities(),
                {
                    allowDolbyVisionProfile4: profile === 4,
                    allowDolbyVisionProfile7: profile === 7,
                    allowRawHDR: false,
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            )).toMatchObject({
                dolbyVisionProfile: profile,
                eligible: true,
                hdr: true,
                neutralizeHDRColorMetadata: false,
                rawVideoFrameFormat: format,
                videoDecoderBackend: 'native',
                videoOutputMode: 'raw-planes'
            });
        });

        it('presents the declared base through the variant\'s raw route without reconstruction', () => {
            expect(getCustomPlaybackEligibility(
                createRangeExtensionOptions('main444-12', {
                    DvBlSignalCompatibilityId: 2,
                    DvProfile: 4,
                    VideoRangeType: 'SDR'
                }),
                createRangeExtensionCapabilities(),
                {
                    allowRawHDR: false,
                    allowRawSDR: true,
                    authorizedRawHDRRouteKeys: [ 'I444P12:bt709:bt709:limited:sdr' ],
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            )).toMatchObject({
                dolbyVisionProfile: null,
                eligible: true,
                hdr: false,
                rawVideoFrameFormat: 'I444P12',
                videoDecoderBackend: 'native',
                videoOutputMode: 'raw-planes'
            });
        });

        it('requires the exact variant capability', () => {
            const capabilities = createRangeExtensionCapabilities();
            const hevcRangeExtensions = capabilities.hevcRangeExtensions as Record<
                HEVCRangeExtensionVariant,
                HEVCRangeExtensionCapability
            >;
            capabilities.hevcRangeExtensions = {
                ...hevcRangeExtensions,
                'main422-10': {
                    ...hevcRangeExtensions['main422-10'],
                    reason: 'output-copy-unsupported',
                    status: 'unsupported'
                }
            };

            expect(getCustomPlaybackEligibility(
                createRangeExtensionOptions('main422-10', {
                    DvBlSignalCompatibilityId: 0,
                    DvProfile: 7,
                    VideoRangeType: 'DOVIWithEL'
                }),
                capabilities,
                {
                    allowDolbyVisionProfile7: true,
                    allowRawHDR: false,
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            )).toEqual({ eligible: false, reason: 'hdr-codec-unsupported' });
        });
    });

    describe('dual-layer reconstruction from the base layer alone', () => {
        // No decoder decodes an EL: MEL reconstructs exactly without it, and FEL presents its base

        it('reconstructs Profile 7 instead of presenting its declared PQ base', () => {
            const eligibility = getCustomPlaybackEligibility(
                createDolbyVisionOptions({
                    ...PQ_BASE_COLORS,
                    DvBlSignalCompatibilityId: 6,
                    DvProfile: 7,
                    ElPresentFlag: true,
                    VideoRange: 'HDR',
                    VideoRangeType: 'DOVIWithEL'
                }),
                createRangeExtensionCapabilities(),
                {
                    ...PQ_AUTHORIZATION,
                    allowDolbyVisionProfile7: true
                }
            );

            expect(eligibility).toMatchObject({
                dolbyVisionProfile: 7,
                eligible: true,
                hdr: true,
                rawVideoFrameFormat: 'I420P10',
                videoDecoderBackend: 'native',
                videoOutputMode: 'raw-planes'
            });
            expect(eligibility).not.toHaveProperty('discardDolbyVisionEnhancementLayer');
        });

        it('reconstructs Profile 4 instead of presenting its declared SDR base', () => {
            expect(getCustomPlaybackEligibility(
                createDolbyVisionOptions({
                    ...SDR_BASE_COLORS,
                    DvBlSignalCompatibilityId: 2,
                    DvProfile: 4,
                    ElPresentFlag: true,
                    VideoRangeType: 'SDR'
                }),
                createRangeExtensionCapabilities(),
                {
                    allowDolbyVisionProfile4: true,
                    allowRawHDR: false,
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            )).toMatchObject({
                dolbyVisionProfile: 4,
                eligible: true,
                hdr: true,
                videoDecoderBackend: 'native',
                videoOutputMode: 'raw-planes'
            });
        });

        it.each([
            { format: 'I420P10', label: 'Main 10', videoStream: {} },
            { format: 'I422P10', label: 'a range extension', videoStream: { PixelFormat: 'yuv422p10le', Profile: 'Rext' } }
        ])('reconstructs Profile 7 over $label without a declared base or its EL', ({
            format,
            videoStream
        }) => {
            expect(getCustomPlaybackEligibility(
                createDolbyVisionOptions({
                    DvBlSignalCompatibilityId: 0,
                    DvProfile: 7,
                    ElPresentFlag: true,
                    VideoRangeType: 'DOVIWithEL',
                    ...videoStream
                }),
                createRangeExtensionCapabilities(),
                {
                    allowDolbyVisionProfile7: true,
                    allowRawHDR: false,
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            )).toMatchObject({
                dolbyVisionProfile: 7,
                eligible: true,
                rawVideoFrameFormat: format
            });
        });

        it('keeps single-layer reconstruction, which has no EL', () => {
            const eligibility = getCustomPlaybackEligibility(
                createDolbyVisionOptions({
                    DvBlSignalCompatibilityId: 0,
                    DvProfile: 8,
                    VideoRangeType: 'DOVIInvalid'
                }),
                createRangeExtensionCapabilities(),
                {
                    allowDolbyVision: true,
                    allowRawHDR: false,
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            );

            expect(eligibility).toMatchObject({
                dolbyVisionProfile: 8,
                eligible: true,
                rawVideoFrameFormat: 'I420P10',
                videoDecoderBackend: 'native'
            });
            expect(eligibility).not.toHaveProperty('discardDolbyVisionEnhancementLayer');
        });
    });
});

describe('10-bit raw SDR route', () => {
    const RAW_SDR_AUTHORIZATION = {
        allowRawHDR: false,
        allowRawSDR: true,
        authorizedRawHDRRouteKeys: [
            'I420P10:bt709:bt709:full:sdr',
            'I420P10:bt709:bt709:limited:sdr'
        ] as const,
        runtimeAvailability: AVAILABLE_RUNTIME
    };
    const RAW_SDR_ROUTE = {
        dolbyVisionProfile: null,
        eligible: true,
        hdr: false,
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat: 'I420P10',
        videoOutputMode: 'raw-planes'
    } as const;

    function createSDROptions(videoStream: Record<string, unknown>): Record<string, unknown> {
        return createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 1,
                MediaStreams: [
                    {
                        AverageFrameRate: 24,
                        BitDepth: 10,
                        ColorPrimaries: 'bt709',
                        ColorSpace: 'bt709',
                        ColorTransfer: 'bt709',
                        Height: 2_160,
                        Index: 0,
                        IsInterlaced: false,
                        Type: 'Video',
                        VideoRange: 'SDR',
                        VideoRangeType: 'SDR',
                        Width: 3_840,
                        ...videoStream
                    },
                    {
                        Channels: 2,
                        Codec: 'aac',
                        Index: 1,
                        SampleRate: 48_000,
                        Type: 'Audio'
                    }
                ],
                RunTimeTicks: 60_000_000
            }
        });
    }

    it.each([
        { codec: 'av1', colorRange: 'tv', profile: 'Main' },
        { codec: 'vp9', colorRange: 'pc', profile: 'Profile 2' }
    ])('selects native raw I420P10 for $codec $profile SDR in $colorRange range', ({
        codec,
        colorRange,
        profile
    }) => {
        const options = createSDROptions({
            Codec: codec,
            ColorRange: colorRange,
            Profile: profile
        });

        expect(hasPotentialCustomPlaybackVideoRoute({
            MediaSources: [ (options as { mediaSource: unknown }).mediaSource ]
        })).toBe(true);
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            RAW_SDR_AUTHORIZATION
        )).toMatchObject({ ...RAW_SDR_ROUTE, videoDecoderBackend: 'native' });
    });

    it('decodes HEVC Main 10 SDR to native raw I420P10 without a native VideoFrame route', () => {
        const options = createSDROptions({ Codec: 'hevc', Profile: 'Main 10' });

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilitiesWithoutNativeHEVC(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilitiesWithoutNativeHEVC(),
            RAW_SDR_AUTHORIZATION
        )).toMatchObject({ ...RAW_SDR_ROUTE, videoDecoderBackend: 'native' });
        // The raw route decodes with the browser's decoder
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilitiesWithoutNativeHEVC(),
            {
                ...RAW_SDR_AUTHORIZATION,
                runtimeAvailability: {
                    ...AVAILABLE_RUNTIME,
                    environment: { ...AVAILABLE_RUNTIME.environment, videoDecoder: false }
                }
            }
        )).toEqual({ eligible: false, reason: 'runtime-unavailable' });
    });

    it('keeps HEVC Main 10 SDR on the native VideoFrame route when native decode qualifies', () => {
        expect(getCustomPlaybackEligibility(
            createSDROptions({ Codec: 'hevc', Profile: 'Main 10' }),
            createCapabilities(),
            RAW_SDR_AUTHORIZATION
        )).toMatchObject({
            eligible: true,
            hdr: false,
            rawVideoFrameFormat: null,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
    });

    it('plays HEVC Main 10 SDR that Jellyfin flags as carrying HDR10+ as SDR, since HDR10+ only applies to PQ', () => {
        expect(getCustomPlaybackEligibility(
            createSDROptions({ Codec: 'hevc', Hdr10PlusPresentFlag: true, Profile: 'Main 10' }),
            createCapabilities(),
            RAW_SDR_AUTHORIZATION
        )).toMatchObject({
            eligible: true,
            hdr: false,
            neutralizeHDRColorMetadata: false,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
    });

    it('presents the declared 10-bit SDR base of HEVC Profile 8.2 through raw I420P10 without native HEVC', () => {
        expect(getCustomPlaybackEligibility(
            createSDROptions({
                BlPresentFlag: true,
                Codec: 'hevc',
                DvBlSignalCompatibilityId: 2,
                DvProfile: 8,
                Profile: 'Main 10',
                RpuPresentFlag: true,
                VideoRangeType: 'DOVIWithSDR'
            }),
            createCapabilitiesWithoutNativeHEVC(),
            RAW_SDR_AUTHORIZATION
        )).toMatchObject({ ...RAW_SDR_ROUTE, videoDecoderBackend: 'native' });
    });

    it.each([
        {
            label: 'without the raw SDR flag',
            eligibilityOptions: { ...RAW_SDR_AUTHORIZATION, allowRawSDR: false }
        },
        {
            label: 'without its own route key',
            eligibilityOptions: {
                ...RAW_SDR_AUTHORIZATION,
                authorizedRawHDRRouteKeys: [ 'I420P10:bt709:bt709:full:sdr' ] as const
            }
        }
    ])('rejects limited-range AV1 10-bit SDR $label', ({ eligibilityOptions }) => {
        expect(getCustomPlaybackEligibility(
            createSDROptions({ Codec: 'av1', Profile: 'Main' }),
            createCapabilities(),
            eligibilityOptions
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });
    });

    // Each matrix, primaries set, and range has its own raw SDR key, which authorizes on first use outside BT.709
    it.each([
        {
            colors: { ColorPrimaries: 'smpte170m', ColorSpace: 'smpte170m', ColorTransfer: 'smpte170m' },
            label: 'BT.601',
            routeKey: 'I420P10:smpte170m:smpte170m:limited:sdr'
        },
        {
            colors: { ColorPrimaries: 'bt470bg', ColorRange: 'pc', ColorSpace: 'bt470bg', ColorTransfer: 'bt709' },
            label: 'full-range 625-line BT.601',
            routeKey: 'I420P10:bt470bg:bt470bg:full:sdr'
        },
        {
            colors: { ColorPrimaries: 'bt2020', ColorSpace: 'bt2020nc', ColorTransfer: 'bt2020-10' },
            label: 'BT.2020',
            routeKey: 'I420P10:bt2020-ncl:bt2020:limited:sdr'
        }
    ] as const)('presents $label 10-bit SDR on AV1 and VP9 through its own raw SDR key', ({ colors, routeKey }) => {
        for (const codecProfile of [
            { Codec: 'av1', Profile: 'Main' },
            { Codec: 'vp9', Profile: 'Profile 2' }
        ]) {
            const options = createSDROptions({ ...colors, ...codecProfile });

            expect(hasPotentialCustomPlaybackVideoRoute({
                MediaSources: [ (options as { mediaSource: unknown }).mediaSource ]
            })).toBe(true);
            expect(getRawVideoPresentationRouteKey(options)).toBe(routeKey);
            // The prewarmed BT.709 keys never stand in for another color's
            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                RAW_SDR_AUTHORIZATION
            )).toEqual({ eligible: false, reason: 'codec-unsupported' });
            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { ...RAW_SDR_AUTHORIZATION, authorizedRawHDRRouteKeys: [ ...RAW_SDR_AUTHORIZATION.authorizedRawHDRRouteKeys, routeKey ] }
            )).toMatchObject({ ...RAW_SDR_ROUTE, videoDecoderBackend: 'native' });
        }
    });

    it('requires the codec\'s raw capability and its profile, at any frame size', () => {
        const capabilities = createCapabilities();
        capabilities.rawHDRVideo = {
            ...capabilities.rawHDRVideo,
            vp9: {
                ...capabilities.rawHDRVideo.vp9,
                reason: 'output-copy-unsupported',
                status: 'unsupported'
            }
        };

        expect(getCustomPlaybackEligibility(
            createSDROptions({ Codec: 'vp9', Profile: 'Profile 2' }),
            capabilities,
            RAW_SDR_AUTHORIZATION
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });
        expect(getCustomPlaybackEligibility(
            createSDROptions({ Codec: 'vp9', Profile: 'Profile 0' }),
            createCapabilities(),
            RAW_SDR_AUTHORIZATION
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });
        expect(getCustomPlaybackEligibility(
            createSDROptions({
                Codec: 'av1',
                Height: ULTRA_HD_16K_CODED_HEIGHT,
                Profile: 'Main',
                Width: ULTRA_HD_16K_CODED_WIDTH
            }),
            createCapabilities(),
            RAW_SDR_AUTHORIZATION
        )).toMatchObject({
            eligible: true,
            maximumCodedHeight: ULTRA_HD_16K_CODED_HEIGHT,
            maximumCodedWidth: ULTRA_HD_16K_CODED_WIDTH,
            videoOutputMode: 'raw-planes'
        });
    });
});

describe('GPU video decode route', () => {
    // A device with WebGPU's default 256 MiB, which a 2160p Main 10 pool outgrows
    const DEFAULT_FRAME_POOL_BYTE_LIMIT = 256 * MEBIBYTE;
    // A scratch buffer of 40 bytes a coded sample: 334 MB at 3840x2176, past the default 256 MiB and within 2 GiB, while a pool of three slots fits either
    const LARGE_SCRATCH_BYTES_PER_SAMPLE = 40;
    const FULL_HD_CODED_WIDTH = 1_920;
    const FULL_HD_CODED_HEIGHT = 1_080;
    const HEVC_PACKAGE = HEVC_VIDEO_PACKAGE;
    const HEVC_GPU_DECODER = { codec: 'hevc', decoderId: HEVC_PACKAGE.id, package: HEVC_PACKAGE } as const;
    // Decoders a host may list before the one a stream takes: one of another codec, and one of another output format
    const VP9_PACKAGE = createVideoDecoderPackageForTest(createVideoDecoderSource({ codecs: [ 'vp9' ], id: 'vp9', name: 'VP9', outputFormats: [ 'I420P10' ] }));
    const EIGHT_BIT_HEVC_PACKAGE = createVideoDecoderPackageForTest(createVideoDecoderSource({ id: 'hevc-8-bit', name: 'HEVC 8-bit', outputFormats: [ 'I420' ] }));
    const FIRST_TEN_BIT_HEVC_PACKAGE = createVideoDecoderPackageForTest(createVideoDecoderSource({ id: 'hevc-10-bit', name: 'HEVC 10-bit', outputFormats: [ 'I420P10' ] }));
    const SECOND_TEN_BIT_HEVC_PACKAGE = createVideoDecoderPackageForTest(createVideoDecoderSource({ id: 'hevc-10-bit-too', name: 'HEVC 10-bit too', outputFormats: [ 'I420P10' ] }));
    const UNSUPPORTED_VIDEO_CODEC = 'theora';
    const HDR10_STREAM = {
        ColorPrimaries: 'bt2020',
        ColorSpace: 'bt2020nc',
        ColorTransfer: 'smpte2084',
        VideoRange: 'HDR',
        VideoRangeType: 'HDR10'
    } as const;
    const GPU_ROUTE = {
        eligible: true,
        gpuVideoDecoder: HEVC_GPU_DECODER,
        neutralizeHDRColorMetadata: false,
        videoDecoderBackend: 'gpu',
        videoOutputMode: 'frame-pool'
    } as const;

    function createGPUOptions(videoStream: Record<string, unknown>): Record<string, unknown> {
        return createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 1,
                MediaStreams: [
                    {
                        BitDepth: 10,
                        Codec: 'hevc',
                        ColorPrimaries: 'bt709',
                        ColorRange: 'tv',
                        ColorSpace: 'bt709',
                        ColorTransfer: 'bt709',
                        Height: ULTRA_HD_CODED_HEIGHT,
                        Index: 0,
                        IsInterlaced: false,
                        Profile: 'Main 10',
                        Type: 'Video',
                        VideoRange: 'SDR',
                        VideoRangeType: 'SDR',
                        Width: ULTRA_HD_CODED_WIDTH,
                        ...videoStream
                    },
                    {
                        Channels: 2,
                        Codec: 'aac',
                        Index: 1,
                        SampleRate: 48_000,
                        Type: 'Audio'
                    }
                ],
                RunTimeTicks: 60_000_000
            }
        });
    }

    /** The HEVC decoder's offer of every format it writes on a device with the given pool limit. */
    function createHEVCOffers(maximumPoolByteLength: number): GPUVideoDecoderOffer[] {
        return HEVC_PACKAGE.manifest.outputFormats.map((format: GPUDecoderOutputFormat): GPUVideoDecoderOffer =>
            createGPUVideoDecoderOffer(HEVC_PACKAGE, format, maximumPoolByteLength));
    }

    function createOffer(decoderPackage: VideoDecoderPackage, format: GPUDecoderOutputFormat): GPUVideoDecoderOffer {
        return createGPUVideoDecoderOffer(decoderPackage, format, LARGE_FRAME_POOL_BYTE_LIMIT);
    }

    function createGPUEligibilityOptions(maximumPoolByteLength = LARGE_FRAME_POOL_BYTE_LIMIT) {
        return {
            allowRawHDR: false,
            gpuVideoDecoders: createHEVCOffers(maximumPoolByteLength),
            runtimeAvailability: AVAILABLE_RUNTIME
        };
    }

    it('decodes HEVC that no native route takes on the offered GPU decoder', () => {
        const options = createGPUOptions({});

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilitiesWithoutNativeHEVC(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilitiesWithoutNativeHEVC(),
            createGPUEligibilityOptions()
        )).toMatchObject({
            ...GPU_ROUTE,
            hdr: false,
            maximumCodedHeight: ULTRA_HD_CODED_HEIGHT,
            maximumCodedWidth: ULTRA_HD_CODED_WIDTH,
            rawVideoFrameFormat: 'I420P10'
        });
    });

    it('keeps a native raw route ahead of the GPU decoder', () => {
        const eligibility = getCustomPlaybackEligibility(
            createGPUOptions({}),
            createCapabilitiesWithoutNativeHEVC(),
            {
                ...createGPUEligibilityOptions(),
                allowRawSDR: true,
                authorizedRawHDRRouteKeys: [ 'I420P10:bt709:bt709:limited:sdr' ] as const
            }
        );

        expect(eligibility).toMatchObject({ videoDecoderBackend: 'native', videoOutputMode: 'raw-planes' });
        expect(eligibility).not.toHaveProperty('gpuVideoDecoder');
    });

    it('needs neither a raw presentation authorization nor a WebCodecs decoder', () => {
        expect(getCustomPlaybackEligibility(
            createGPUOptions({}),
            createCapabilitiesWithoutNativeHEVC(),
            {
                ...createGPUEligibilityOptions(),
                runtimeAvailability: {
                    ...AVAILABLE_RUNTIME,
                    environment: { ...AVAILABLE_RUNTIME.environment, videoDecoder: false }
                }
            }
        )).toMatchObject({ ...GPU_ROUTE, rawVideoFrameFormat: 'I420P10' });
    });

    it('keeps a native route ahead of the GPU decoder', () => {
        const eligibility = getCustomPlaybackEligibility(createGPUOptions({}), createCapabilities(), createGPUEligibilityOptions());

        expect(eligibility).toMatchObject({ videoDecoderBackend: 'native', videoOutputMode: 'video-frame' });
        expect(eligibility).not.toHaveProperty('gpuVideoDecoder');
    });

    it('presents GPU-decoded HDR only when the host tone-maps it', () => {
        const options = createGPUOptions(HDR10_STREAM);

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilitiesWithoutNativeHEVC(),
            createGPUEligibilityOptions()
        )).toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilitiesWithoutNativeHEVC(),
            { ...createGPUEligibilityOptions(), allowFramePoolHDR: true }
        )).toMatchObject({ ...GPU_ROUTE, hdr: true, rawVideoFrameFormat: 'I420P10' });
    });

    it.each([
        { format: 'I420', videoStream: { BitDepth: 8, Profile: 'Main' } },
        { format: 'I422P10', videoStream: { PixelFormat: 'yuv422p10le', Profile: 'Rext' } },
        { format: 'I444P12', videoStream: { BitDepth: 12, PixelFormat: 'yuv444p12le', Profile: 'Rext' } }
    ] as const)('decodes to $format, the format of the stream\'s depth and chroma', ({ format, videoStream }) => {
        expect(getCustomPlaybackEligibility(
            createGPUOptions(videoStream),
            createCapabilitiesWithoutNativeHEVC(),
            createGPUEligibilityOptions()
        )).toMatchObject({ ...GPU_ROUTE, rawVideoFrameFormat: format });
    });

    it.each([
        { format: 'I420', videoStream: { BitDepth: 8, PixelFormat: 'gray', Profile: 'Rext' } },
        { format: 'I420P10', videoStream: { BitDepth: 10, PixelFormat: 'gray10le', Profile: 'Rext' } },
        { format: 'I420P12', videoStream: { BitDepth: 12, PixelFormat: 'gray12le', Profile: 'Rext' } }
    ] as const)('decodes 4:0:0 HEVC in $videoStream.PixelFormat to $format, which no native route takes', ({ format, videoStream }) => {
        expect(getCustomPlaybackEligibility(
            createGPUOptions(videoStream),
            createCapabilities(),
            createGPUEligibilityOptions()
        )).toMatchObject({ ...GPU_ROUTE, rawVideoFrameFormat: format });
        expect(hasPotentialCustomPlaybackVideoRoute(createPlaybackSelectionItem({ ...videoStream, Codec: 'HEVC' }))).toBe(true);
    });

    it('passes over a GPU decoder whose frame pool the device cannot hold', () => {
        expect(getCustomPlaybackEligibility(
            createGPUOptions({}),
            createCapabilitiesWithoutNativeHEVC(),
            createGPUEligibilityOptions(DEFAULT_FRAME_POOL_BYTE_LIMIT)
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });
        expect(getCustomPlaybackEligibility(
            createGPUOptions({ Height: FULL_HD_CODED_HEIGHT, Width: FULL_HD_CODED_WIDTH }),
            createCapabilitiesWithoutNativeHEVC(),
            createGPUEligibilityOptions(DEFAULT_FRAME_POOL_BYTE_LIMIT)
        )).toMatchObject({ ...GPU_ROUTE, maximumCodedHeight: FULL_HD_CODED_HEIGHT, maximumCodedWidth: FULL_HD_CODED_WIDTH });
    });

    it('offers a 4:0:0 stream only to a decoder whose header declares monochrome', () => {
        const monochromePackage = createVideoDecoderPackageForTest(createVideoDecoderSource({
            extraDirectives: [ MONOCHROME_DIRECTIVE_LINE ],
            id: 'hevc-monochrome',
            name: 'HEVC 10-bit with 4:0:0',
            outputFormats: [ 'I420P10' ]
        }));
        const options = createGPUOptions({ PixelFormat: 'gray10le', Profile: 'Rext' });
        const withOffers = (offers: GPUVideoDecoderOffer[]): CustomPlaybackEligibilityOptions => ({ ...createGPUEligibilityOptions(), gpuVideoDecoders: offers });

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            withOffers([ createOffer(FIRST_TEN_BIT_HEVC_PACKAGE, 'I420P10') ])
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            withOffers([ createOffer(FIRST_TEN_BIT_HEVC_PACKAGE, 'I420P10'), createOffer(monochromePackage, 'I420P10') ])
        )).toMatchObject({ ...GPU_ROUTE, gpuVideoDecoder: { codec: 'hevc', decoderId: monochromePackage.id, package: monochromePackage }, rawVideoFrameFormat: 'I420P10' });
        // A stream of a 4:2:0 pixel format still goes to the first offer
        expect(getCustomPlaybackEligibility(
            createGPUOptions({ PixelFormat: 'yuv420p10le' }),
            createCapabilitiesWithoutNativeHEVC(),
            withOffers([ createOffer(FIRST_TEN_BIT_HEVC_PACKAGE, 'I420P10'), createOffer(monochromePackage, 'I420P10') ])
        )).toMatchObject({ ...GPU_ROUTE, gpuVideoDecoder: { decoderId: FIRST_TEN_BIT_HEVC_PACKAGE.id }, rawVideoFrameFormat: 'I420P10' });
    });

    it('offers grey JPEG 2000 to no package, since the JPEG 2000 decoder project does not declare monochrome', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mj2';
        mediaSource.MediaStreams[0] = {
            AverageFrameRate: 24,
            BitDepth: 8,
            Codec: 'JPEG2000',
            Height: 540,
            Index: 0,
            IsInterlaced: false,
            PixelFormat: 'gray',
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 960
        };
        const eligibilityOptions: CustomPlaybackEligibilityOptions = {
            allowRawHDR: false,
            gpuVideoDecoders: createVideoDecoderOffers(JPEG2000_PROJECT_VIDEO_PACKAGE),
            runtimeAvailability: AVAILABLE_RUNTIME
        };

        expect(JPEG2000_PROJECT_VIDEO_PACKAGE.manifest.monochrome).toBe(false);
        expect(getCustomPlaybackEligibility(options, createCapabilities(), eligibilityOptions)).toEqual({ eligible: false, reason: 'codec-unsupported' });
        mediaSource.MediaStreams[0].PixelFormat = 'yuv420p';
        expect(getCustomPlaybackEligibility(options, createCapabilities(), eligibilityOptions))
            .toMatchObject({ ...createPackageVideoRoute(JPEG2000_PROJECT_VIDEO_PACKAGE, 'jpeg2000'), rawVideoFrameFormat: 'I420' });
    });

    it('passes over a GPU decoder whose scratch buffer the device cannot hold at the stream\'s size', () => {
        const scratchHungryPackage = createVideoDecoderPackageForTest(createVideoDecoderSource({
            extraDirectives: [ `//! buffer: scratch, ${LARGE_SCRATCH_BYTES_PER_SAMPLE} * stream.width * stream.height` ],
            id: 'hevc-scratch',
            name: 'HEVC with a large scratch buffer',
            outputFormats: [ 'I420P10' ]
        }));
        const createOptionsWithLimit = (maximumBufferByteLength: number): CustomPlaybackEligibilityOptions => ({
            ...createGPUEligibilityOptions(),
            gpuVideoDecoders: [ createGPUVideoDecoderOffer(scratchHungryPackage, 'I420P10', maximumBufferByteLength) ]
        });

        expect(getCustomPlaybackEligibility(
            createGPUOptions({}),
            createCapabilitiesWithoutNativeHEVC(),
            createOptionsWithLimit(DEFAULT_FRAME_POOL_BYTE_LIMIT)
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });
        expect(getCustomPlaybackEligibility(
            createGPUOptions({}),
            createCapabilitiesWithoutNativeHEVC(),
            createOptionsWithLimit(LARGE_FRAME_POOL_BYTE_LIMIT)
        )).toMatchObject({ ...GPU_ROUTE, gpuVideoDecoder: { codec: 'hevc', decoderId: scratchHungryPackage.id, package: scratchHungryPackage } });
    });

    it('passes over a GPU decoder whose stream limits reject the picture', () => {
        expect(getCustomPlaybackEligibility(
            createGPUOptions({ Height: ULTRA_HD_8K_CODED_HEIGHT, Width: ULTRA_HD_8K_CODED_WIDTH }),
            createCapabilitiesWithoutNativeHEVC(),
            createGPUEligibilityOptions()
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });
    });

    it('offers a GPU decoder only to its own codec', () => {
        const capabilities = createCapabilities();
        capabilities.rawHDRVideo = {
            ...capabilities.rawHDRVideo,
            vp9: { ...capabilities.rawHDRVideo.vp9, reason: 'output-copy-unsupported', status: 'unsupported' }
        };

        expect(getCustomPlaybackEligibility(
            createGPUOptions({ Codec: 'vp9', Profile: 'Profile 2' }),
            capabilities,
            createGPUEligibilityOptions()
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });
    });

    it('chooses the first offer in the host\'s order that decodes the codec into the stream\'s format, with that offer\'s package', () => {
        const offers = [
            createOffer(VP9_PACKAGE, 'I420P10'),
            createOffer(EIGHT_BIT_HEVC_PACKAGE, 'I420'),
            createOffer(FIRST_TEN_BIT_HEVC_PACKAGE, 'I420P10'),
            createOffer(SECOND_TEN_BIT_HEVC_PACKAGE, 'I420P10')
        ];

        expect(getCustomPlaybackEligibility(
            createGPUOptions({ Height: FULL_HD_CODED_HEIGHT, Width: FULL_HD_CODED_WIDTH }),
            createCapabilitiesWithoutNativeHEVC(),
            { ...createGPUEligibilityOptions(), gpuVideoDecoders: offers }
        )).toMatchObject({
            ...GPU_ROUTE,
            gpuVideoDecoder: { codec: 'hevc', decoderId: FIRST_TEN_BIT_HEVC_PACKAGE.id, package: FIRST_TEN_BIT_HEVC_PACKAGE },
            rawVideoFrameFormat: 'I420P10'
        });
    });

    describe('hasEligibleCustomVideoRoute', () => {
        // What a host knows of the HEVC decoder before a playback has the package and the device
        const HEVC_SUMMARY: GPUVideoDecoderSummary = {
            codecs: HEVC_PACKAGE.manifest.accepts.codecs,
            outputFormats: HEVC_PACKAGE.manifest.outputFormats
        };
        const SUMMARY_ROUTE_OPTIONS: CustomVideoRouteOptions = { allowRawHDR: false, gpuVideoDecoderSummaries: [ HEVC_SUMMARY ] };
        // What a server's catalog adds: the package's header
        const HEVC_HEADER_SUMMARY: GPUVideoDecoderSummary = { ...HEVC_SUMMARY, header: HEVC_PACKAGE.manifest };
        // WebGPU's default largest storage binding, 128 MiB, below its default largest buffer
        const DEFAULT_STORAGE_BINDING_BYTE_LIMIT = 128 * MEBIBYTE;
        const ULTRA_HD_8K_STREAM = { Height: ULTRA_HD_8K_CODED_HEIGHT, Width: ULTRA_HD_8K_CODED_WIDTH };
        const FULL_HD_STREAM = { Height: FULL_HD_CODED_HEIGHT, Width: FULL_HD_CODED_WIDTH };
        const HD_STREAM = { Height: 720, Width: 1280 };
        const MONOCHROME_PIXEL_FORMAT = 'gray10le';
        // Profile 8.1, whose compatibility ID 1 declares an HDR10 base
        const DOLBY_VISION_HDR10_BASE_STREAM = {
            ...HDR10_STREAM,
            BlPresentFlag: true,
            DvBlSignalCompatibilityId: 1,
            DvProfile: 8,
            RpuPresentFlag: true,
            VideoRangeType: 'DOVIWithHDR10'
        } as const;

        function createGPUMediaSource(videoStream: Record<string, unknown>): unknown {
            return (createGPUOptions(videoStream) as { mediaSource: unknown }).mediaSource;
        }

        it('takes a GPU decoder by its summary, since no offer exists before a playback', () => {
            const mediaSource = createGPUMediaSource({});

            expect(hasEligibleCustomVideoRoute(mediaSource, createCapabilitiesWithoutNativeHEVC(), { allowRawHDR: false })).toBe(false);
            expect(hasEligibleCustomVideoRoute(mediaSource, createCapabilitiesWithoutNativeHEVC(), SUMMARY_ROUTE_OPTIONS)).toBe(true);
        });

        it.each([
            { codecs: [ 'vp9' ], outputFormats: [ 'I420P10' ], subject: 'another codec' },
            { codecs: [ 'hevc' ], outputFormats: [ 'I420' ], subject: 'another output format' }
        ])('passes over a summary of $subject', ({ codecs, outputFormats }) => {
            expect(hasEligibleCustomVideoRoute(
                createGPUMediaSource({}),
                createCapabilitiesWithoutNativeHEVC(),
                { ...SUMMARY_ROUTE_OPTIONS, gpuVideoDecoderSummaries: [ { codecs, outputFormats } ] }
            )).toBe(false);
        });

        it('takes a summary without its package\'s header by codec and format alone, leaving the decoder\'s conditions to the playback\'s offers', () => {
            const videoStream = ULTRA_HD_8K_STREAM;

            expect(hasEligibleCustomVideoRoute(createGPUMediaSource(videoStream), createCapabilitiesWithoutNativeHEVC(), SUMMARY_ROUTE_OPTIONS)).toBe(true);
            expect(getCustomPlaybackEligibility(
                createGPUOptions(videoStream),
                createCapabilitiesWithoutNativeHEVC(),
                createGPUEligibilityOptions()
            )).toEqual({ eligible: false, reason: 'codec-unsupported' });
        });

        it('runs the offers\' fit check with a summary\'s header, and the device\'s buffer limit where the summary gives it', () => {
            const takesStream = (videoStream: Record<string, unknown>, maximumBufferByteLength?: number): boolean => hasEligibleCustomVideoRoute(
                createGPUMediaSource(videoStream),
                createCapabilitiesWithoutNativeHEVC(),
                {
                    ...SUMMARY_ROUTE_OPTIONS,
                    gpuVideoDecoderSummaries: [ { ...HEVC_HEADER_SUMMARY, ...(maximumBufferByteLength === undefined ? {} : { maximumBufferByteLength }) } ]
                }
            );

            // The header's accepts alone: 8K's pool of 7680x4352 is past the decoder's 8912896 samples, and 2160p's 3840x2176 within them
            expect(takesStream(ULTRA_HD_8K_STREAM)).toBe(false);
            expect(takesStream({})).toBe(true);
            // Its pool of 29 I420P10 slots: 727 MB at 2160p and 186 MB at 1080p
            expect(takesStream({}, LARGE_FRAME_POOL_BYTE_LIMIT)).toBe(true);
            expect(takesStream({}, DEFAULT_FRAME_POOL_BYTE_LIMIT)).toBe(false);
            expect(takesStream(FULL_HD_STREAM, DEFAULT_STORAGE_BINDING_BYTE_LIMIT)).toBe(false);
            expect(takesStream(HD_STREAM, DEFAULT_STORAGE_BINDING_BYTE_LIMIT)).toBe(true);
        });

        it('judges a stream by a summary as a playback judges it by the offers on the same device', () => {
            for (const videoStream of [ FULL_HD_STREAM, HD_STREAM ]) {
                const offered = getCustomPlaybackEligibility(
                    createGPUOptions(videoStream),
                    createCapabilitiesWithoutNativeHEVC(),
                    createGPUEligibilityOptions(DEFAULT_STORAGE_BINDING_BYTE_LIMIT)
                ).eligible;

                expect(hasEligibleCustomVideoRoute(
                    createGPUMediaSource(videoStream),
                    createCapabilitiesWithoutNativeHEVC(),
                    { ...SUMMARY_ROUTE_OPTIONS, gpuVideoDecoderSummaries: [ { ...HEVC_HEADER_SUMMARY, maximumBufferByteLength: DEFAULT_STORAGE_BINDING_BYTE_LIMIT } ] }
                )).toBe(offered);
            }
        });

        it('takes a 4:0:0 stream only by a summary whose header declares monochrome', () => {
            const mediaSource = createGPUMediaSource({ PixelFormat: MONOCHROME_PIXEL_FORMAT });
            const takesStream = (summary: GPUVideoDecoderSummary): boolean => hasEligibleCustomVideoRoute(
                mediaSource,
                createCapabilitiesWithoutNativeHEVC(),
                { ...SUMMARY_ROUTE_OPTIONS, gpuVideoDecoderSummaries: [ summary ] }
            );

            expect(takesStream(HEVC_HEADER_SUMMARY)).toBe(true);
            expect(takesStream({ ...HEVC_HEADER_SUMMARY, header: { ...HEVC_PACKAGE.manifest, monochrome: false } })).toBe(false);
        });

        it('presents summarized HDR only when the host tone-maps it', () => {
            const mediaSource = createGPUMediaSource(HDR10_STREAM);

            expect(hasEligibleCustomVideoRoute(mediaSource, createCapabilitiesWithoutNativeHEVC(), SUMMARY_ROUTE_OPTIONS)).toBe(false);
            expect(hasEligibleCustomVideoRoute(
                mediaSource,
                createCapabilitiesWithoutNativeHEVC(),
                { ...SUMMARY_ROUTE_OPTIONS, allowFramePoolHDR: true }
            )).toBe(true);
        });

        it('refuses a declared Dolby Vision base past the summarized decoder\'s accepts, and takes one the device holds', () => {
            const routeOptions: CustomVideoRouteOptions = {
                ...SUMMARY_ROUTE_OPTIONS,
                allowFramePoolHDR: true,
                gpuVideoDecoderSummaries: [ { ...HEVC_HEADER_SUMMARY, maximumBufferByteLength: LARGE_FRAME_POOL_BYTE_LIMIT } ]
            };

            expect(hasEligibleCustomVideoRoute(
                createGPUMediaSource({ ...DOLBY_VISION_HDR10_BASE_STREAM, ...ULTRA_HD_8K_STREAM }),
                createCapabilitiesWithoutNativeHEVC(),
                routeOptions
            )).toBe(false);
            expect(hasEligibleCustomVideoRoute(
                createGPUMediaSource(DOLBY_VISION_HDR10_BASE_STREAM),
                createCapabilitiesWithoutNativeHEVC(),
                routeOptions
            )).toBe(true);
        });

        it('presents a declared Dolby Vision base on a summarized decoder, as a playback presents it on the offer', () => {
            const routeOptions: CustomVideoRouteOptions = { ...SUMMARY_ROUTE_OPTIONS, allowFramePoolHDR: true };

            expect(hasEligibleCustomVideoRoute(
                createGPUMediaSource(DOLBY_VISION_HDR10_BASE_STREAM),
                createCapabilitiesWithoutNativeHEVC(),
                routeOptions
            )).toBe(true);
            expect(getCustomPlaybackEligibility(
                createGPUOptions(DOLBY_VISION_HDR10_BASE_STREAM),
                createCapabilitiesWithoutNativeHEVC(),
                { ...createGPUEligibilityOptions(), allowFramePoolHDR: true }
            )).toMatchObject({ ...GPU_ROUTE, dolbyVisionProfile: null, hdr: true, rawVideoFrameFormat: 'I420P10' });
            // Compatibility ID 0 declares no base, and without the host's authorization of its RPU route no frame pool reconstructs it
            expect(hasEligibleCustomVideoRoute(
                createGPUMediaSource({ ...DOLBY_VISION_HDR10_BASE_STREAM, DvBlSignalCompatibilityId: 0, VideoRangeType: 'DOVIInvalid' }),
                createCapabilitiesWithoutNativeHEVC(),
                routeOptions
            )).toBe(false);
        });
    });

    describe('getGPUVideoDecodeTarget', () => {
        it.each([
            { codec: 'hevc', format: 'I420P10', subject: 'Main 10 SDR', videoStream: {} },
            { codec: 'hevc', format: 'I420', subject: 'Main', videoStream: { BitDepth: 8, Profile: 'Main' } },
            { codec: 'hevc', format: 'I422P10', subject: 'a 4:2:2 range extension', videoStream: { PixelFormat: 'yuv422p10le', Profile: 'Rext' } },
            { codec: 'hevc', format: 'I420P10', subject: 'HDR10, by its depth alone', videoStream: HDR10_STREAM },
            { codec: 'vp9', format: 'I420P10', subject: 'VP9 Profile 2', videoStream: { Codec: 'vp9', Profile: 'Profile 2' } }
        ] as const)('decodes $subject as $codec into $format, as the route would', ({ codec, format, videoStream }) => {
            expect(getGPUVideoDecodeTarget(createGPUOptions(videoStream))).toEqual({ codec, format });
        });

        it('names no target without a media source, or for a codec the engine has no name for', () => {
            expect(getGPUVideoDecodeTarget(createGPUOptions({ Codec: UNSUPPORTED_VIDEO_CODEC }))).toBeNull();
            expect(getGPUVideoDecodeTarget({ ...createGPUOptions({}), mediaSource: undefined })).toBeNull();
            expect(getGPUVideoDecodeTarget(null)).toBeNull();
        });
    });

    describe('Dolby Vision reconstruction on a GPU decoder', () => {
        // Profile 5, whose compatibility ID 0 declares no base, so only an RPU route presents it
        const PROFILE_5_STREAM = {
            BlPresentFlag: true,
            DvBlSignalCompatibilityId: 0,
            DvProfile: 5,
            RpuPresentFlag: true,
            VideoRange: 'HDR',
            VideoRangeType: 'DOVI'
        } as const;
        // Profile 8.1, whose compatibility ID 1 declares an HDR10 base
        const PROFILE_8_1_STREAM = {
            ...HDR10_STREAM,
            BlPresentFlag: true,
            DvBlSignalCompatibilityId: 1,
            DvProfile: 8,
            RpuPresentFlag: true,
            VideoRangeType: 'DOVIWithHDR10'
        } as const;
        // Profile 8.2, whose compatibility ID 2 declares the SDR base createGPUOptions describes
        const PROFILE_8_2_STREAM = {
            BlPresentFlag: true,
            DvBlSignalCompatibilityId: 2,
            DvProfile: 8,
            RpuPresentFlag: true,
            VideoRangeType: 'DOVIWithSDR'
        } as const;
        const DOLBY_VISION_GPU_ROUTE = { ...GPU_ROUTE, hdr: true, rawVideoFrameFormat: 'I420P10' } as const;

        /** Capabilities in which neither a VideoFrame nor a raw route decodes HEVC, as in a browser without WebCodecs HEVC. */
        function createCapabilitiesWithoutHEVC(): CustomDecodeCapabilities {
            const capabilities = createCapabilitiesWithoutNativeHEVC();
            capabilities.nativeDolbyVisionHEVC = undefined;
            capabilities.rawHDRVideo = {
                ...capabilities.rawHDRVideo,
                hevc: { ...capabilities.rawHDRVideo.hevc, reason: 'output-copy-unsupported', status: 'unsupported' }
            };
            return capabilities;
        }

        it('reconstructs Profile 5 that only the HEVC decoder package decodes, once the host authorized its RPU route', () => {
            const options = createGPUOptions(PROFILE_5_STREAM);

            expect(getCustomPlaybackEligibility(options, createCapabilitiesWithoutHEVC(), createGPUEligibilityOptions()))
                .toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
            // The RPU route's flag, not allowFramePoolHDR, which gates static HDR alone, lets the frame pool reconstruct
            expect(getCustomPlaybackEligibility(options, createCapabilitiesWithoutHEVC(), { ...createGPUEligibilityOptions(), allowDolbyVision: true }))
                .toMatchObject({ ...DOLBY_VISION_GPU_ROUTE, dolbyVisionProfile: 5 });
        });

        it('keeps the reconstruction\'s reason without an offer that decodes the BL into the RPU route\'s format', () => {
            const options = createGPUOptions(PROFILE_5_STREAM);
            const eligibilityOptions = { allowDolbyVision: true, allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME };

            expect(getCustomPlaybackEligibility(options, createCapabilitiesWithoutHEVC(), eligibilityOptions))
                .toEqual({ eligible: false, reason: 'hdr-codec-unsupported' });
            expect(getCustomPlaybackEligibility(
                options,
                createCapabilitiesWithoutHEVC(),
                { ...eligibilityOptions, gpuVideoDecoders: [ createOffer(EIGHT_BIT_HEVC_PACKAGE, 'I420') ] }
            )).toEqual({ eligible: false, reason: 'hdr-codec-unsupported' });
        });

        it('keeps the native and raw RPU routes ahead of the GPU decoder', () => {
            const eligibilityOptions = { ...createGPUEligibilityOptions(), allowDolbyVision: true, allowNativeDolbyVision: true };

            expect(getCustomPlaybackEligibility(createGPUOptions(PROFILE_5_STREAM), createCapabilities(), eligibilityOptions))
                .toMatchObject({ dolbyVisionProfile: 5, videoDecoderBackend: 'native', videoOutputMode: 'video-frame' });
            expect(getCustomPlaybackEligibility(createGPUOptions(PROFILE_5_STREAM), createCapabilities(), { ...eligibilityOptions, allowNativeDolbyVision: false }))
                .toMatchObject({ dolbyVisionProfile: 5, videoDecoderBackend: 'native', videoOutputMode: 'raw-planes' });
        });

        it('reconstructs Profile 8.1 on the GPU decoder before its declared HDR10 base takes the decoder', () => {
            const options = createGPUOptions(PROFILE_8_1_STREAM);
            const eligibilityOptions = { ...createGPUEligibilityOptions(), allowFramePoolHDR: true };

            expect(getCustomPlaybackEligibility(options, createCapabilitiesWithoutHEVC(), { ...eligibilityOptions, allowDolbyVision: true }))
                .toMatchObject({ ...DOLBY_VISION_GPU_ROUTE, dolbyVisionProfile: 8 });
            expect(getCustomPlaybackEligibility(options, createCapabilitiesWithoutHEVC(), eligibilityOptions))
                .toMatchObject({ ...DOLBY_VISION_GPU_ROUTE, dolbyVisionProfile: null });
        });

        it('keeps a native route of the declared base ahead of the GPU decoder', () => {
            const capabilities = createCapabilities();
            capabilities.rawHDRVideo = {
                ...capabilities.rawHDRVideo,
                hevc: { ...capabilities.rawHDRVideo.hevc, reason: 'output-copy-unsupported', status: 'unsupported' }
            };

            expect(getCustomPlaybackEligibility(
                createGPUOptions(PROFILE_8_2_STREAM),
                capabilities,
                { ...createGPUEligibilityOptions(), allowDolbyVision: true }
            )).toMatchObject({ dolbyVisionProfile: null, hdr: false, videoDecoderBackend: 'native', videoOutputMode: 'video-frame' });
        });

        it.each([
            { allowance: { allowDolbyVisionProfile7: true }, profile: 7, rangeType: 'DOVIWithEL' },
            { allowance: { allowDolbyVisionProfile4: true }, profile: 4, rangeType: 'DOVIWithEL' }
        ] as const)('reconstructs dual-layer Profile $profile from its BL alone on the GPU decoder', ({ allowance, profile, rangeType }) => {
            const options = createGPUOptions({
                ...PROFILE_5_STREAM,
                DvProfile: profile,
                ElPresentFlag: true,
                VideoRangeType: rangeType
            });

            expect(getCustomPlaybackEligibility(options, createCapabilitiesWithoutHEVC(), { ...createGPUEligibilityOptions(), allowDolbyVision: true }))
                .toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
            expect(getCustomPlaybackEligibility(options, createCapabilitiesWithoutHEVC(), { ...createGPUEligibilityOptions(), ...allowance }))
                .toMatchObject({ ...DOLBY_VISION_GPU_ROUTE, dolbyVisionProfile: profile });
        });

        it('refuses an interlaced Dolby Vision stream, which no Dolby Vision route deinterlaces', () => {
            expect(getCustomPlaybackEligibility(
                createGPUOptions({ ...PROFILE_5_STREAM, IsInterlaced: true }),
                createCapabilitiesWithoutHEVC(),
                { ...createGPUEligibilityOptions(), allowDolbyVision: true }
            )).toEqual({ eligible: false, reason: 'interlaced-video-unsupported' });
        });

        it('takes the decoder by its summary at negotiation, and names the RPU route\'s format as the decoder\'s target', () => {
            const options = createGPUOptions(PROFILE_5_STREAM);
            const summaryOptions: CustomVideoRouteOptions = {
                allowDolbyVision: true,
                allowRawHDR: false,
                gpuVideoDecoderSummaries: [ { codecs: HEVC_PACKAGE.manifest.accepts.codecs, outputFormats: HEVC_PACKAGE.manifest.outputFormats } ]
            };

            expect(hasEligibleCustomVideoRoute((options as { mediaSource: unknown }).mediaSource, createCapabilitiesWithoutHEVC(), summaryOptions)).toBe(true);
            expect(getGPUVideoDecodeTarget(options)).toEqual({ codec: 'hevc', format: 'I420P10' });
            expect(getGPUVideoDecodeTarget(createGPUOptions({ ...PROFILE_5_STREAM, BitDepth: 8, Profile: 'Main' }))).toEqual({ codec: 'hevc', format: 'I420' });
        });
    });

    describe('getPlaybackAudioCodec', () => {
        const DTS_STREAM_INDEX = 2;
        const DTS_CHANNEL_COUNT = 6;
        const DTS_SAMPLE_RATE = 48_000;
        // A Jellyfin stream index no track of the source has
        const UNSELECTED_STREAM_INDEX = 7;
        const UNNAMED_AUDIO_CODEC = 'atrac3';

        /** The GPU playback's options with a DTS track after its AAC track, and the default audio index given. */
        function createTwoTrackOptions(defaultAudioStreamIndex: number | null, secondCodec = 'DTS'): Record<string, unknown> {
            const options = createGPUOptions({});
            const mediaSource = options.mediaSource as { MediaStreams: unknown[] };
            return {
                ...options,
                mediaSource: {
                    ...mediaSource,
                    DefaultAudioStreamIndex: defaultAudioStreamIndex,
                    MediaStreams: [
                        ...mediaSource.MediaStreams,
                        { Channels: DTS_CHANNEL_COUNT, Codec: secondCodec, Index: DTS_STREAM_INDEX, SampleRate: DTS_SAMPLE_RATE, Type: 'Audio' }
                    ]
                }
            };
        }

        it('names the codec of the track the default audio index selects, by the engine\'s name for it', () => {
            expect(getPlaybackAudioCodec(createGPUOptions({}))).toBe('aac');
            expect(getPlaybackAudioCodec(createTwoTrackOptions(DTS_STREAM_INDEX))).toBe('dts');
            expect(getPlaybackAudioCodec(createTwoTrackOptions(null))).toBe('aac');
        });

        it('names no codec for an index no track has, a codec the engine has no name for, or no media source', () => {
            expect(getPlaybackAudioCodec(createTwoTrackOptions(UNSELECTED_STREAM_INDEX))).toBeNull();
            expect(getPlaybackAudioCodec(createTwoTrackOptions(DTS_STREAM_INDEX, UNNAMED_AUDIO_CODEC))).toBeNull();
            expect(getPlaybackAudioCodec({ ...createGPUOptions({}), mediaSource: undefined })).toBeNull();
            expect(getPlaybackAudioCodec(null)).toBeNull();
        });
    });
});

describe('AV1 on a decoder package', () => {
    const AV1_PACKAGE = createVideoDecoderPackageForTest(createVideoDecoderSource({
        codecs: [ 'av1' ],
        id: 'av1',
        name: 'AV1',
        outputFormats: [ 'I420', 'I420P10', 'I420P12', 'I422', 'I422P10', 'I422P12', 'I444', 'I444P10', 'I444P12' ]
    }));
    const AV1_PACKAGE_ROUTE = createPackageVideoRoute(AV1_PACKAGE, 'av1');
    const BT709_SDR_STREAM = {
        ColorPrimaries: 'bt709',
        ColorRange: 'tv',
        ColorSpace: 'bt709',
        ColorTransfer: 'bt709',
        VideoRange: 'SDR',
        VideoRangeType: 'SDR'
    } as const;
    const BT601_SDR_STREAM = {
        ColorPrimaries: 'smpte170m',
        ColorSpace: 'smpte170m',
        ColorTransfer: 'smpte170m'
    } as const;
    const HDR10_STREAM = {
        ColorPrimaries: 'bt2020',
        ColorSpace: 'bt2020nc',
        ColorTransfer: 'smpte2084',
        VideoRange: 'HDR',
        VideoRangeType: 'HDR10'
    } as const;
    // Variants only a package decodes: native routes take AV1 Main at 4:2:0, 8 or 10 bits
    const PACKAGE_ONLY_STREAMS = [
        { format: 'I444', subject: 'High 4:4:4', videoStream: { BitDepth: 8, PixelFormat: 'yuv444p', Profile: 'High' } },
        { format: 'I444P10', subject: 'High 10-bit 4:4:4', videoStream: { BitDepth: 10, PixelFormat: 'yuv444p10le', Profile: 'High' } },
        { format: 'I422', subject: 'Professional 4:2:2', videoStream: { BitDepth: 8, PixelFormat: 'yuv422p', Profile: 'Professional' } },
        { format: 'I422P12', subject: 'Professional 12-bit 4:2:2', videoStream: { BitDepth: 12, PixelFormat: 'yuv422p12le', Profile: 'Professional' } },
        { format: 'I420P12', subject: 'Professional 12-bit 4:2:0', videoStream: { BitDepth: 12, PixelFormat: 'yuv420p12le', Profile: 'Professional' } }
    ] as const;
    // Main at 10 bits without its raw SDR key, which authorizes on first use outside BT.709: no native route takes it until the key settles
    const UNROUTED_MAIN_STREAM = { format: 'I420P10', subject: 'Main 10-bit BT.601 SDR', videoStream: { ...BT601_SDR_STREAM, BitDepth: 10, Profile: 'Main' } } as const;

    function createAV1Options(videoStream: Record<string, unknown>): Record<string, unknown> {
        return createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 1,
                MediaStreams: [
                    {
                        ...BT709_SDR_STREAM,
                        BitDepth: 8,
                        Codec: 'av1',
                        Height: 1_080,
                        Index: 0,
                        IsInterlaced: false,
                        Profile: 'Main',
                        Type: 'Video',
                        Width: 1_920,
                        ...videoStream
                    },
                    {
                        Channels: 2,
                        Codec: 'aac',
                        Index: 1,
                        SampleRate: 48_000,
                        Type: 'Audio'
                    }
                ],
                RunTimeTicks: 60_000_000
            }
        });
    }

    function createAV1EligibilityOptions(): CustomPlaybackEligibilityOptions {
        return { allowRawHDR: false, gpuVideoDecoders: createVideoDecoderOffers(AV1_PACKAGE), runtimeAvailability: AVAILABLE_RUNTIME };
    }

    it.each([ ...PACKAGE_ONLY_STREAMS, UNROUTED_MAIN_STREAM ])('decodes AV1 $subject, which no native route takes, on an offered package as $format', ({ format, videoStream }) => {
        const options = createAV1Options(videoStream);

        expect(getCustomPlaybackEligibility(options, createCapabilities(), { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }))
            .toMatchObject({ eligible: false });
        expect(getCustomPlaybackEligibility(options, createCapabilities(), createAV1EligibilityOptions()))
            .toMatchObject({ ...AV1_PACKAGE_ROUTE, hdr: false, rawVideoFrameFormat: format });
    });

    it.each(PACKAGE_ONLY_STREAMS)('keeps AV1 $subject potential for wrapper selection, since a package may take it', ({ videoStream }) => {
        expect(hasPotentialCustomPlaybackVideoRoute(createPlaybackSelectionItem({ ...videoStream, Codec: 'AV1' }))).toBe(true);
    });

    it('reconstructs 12-bit Profile 10, which no native or raw route decodes, on the frame pool of an offered package once its RPU route is allowed', () => {
        const options = createAV1Options({
            BitDepth: 12,
            BlPresentFlag: true,
            ColorPrimaries: undefined,
            ColorSpace: undefined,
            ColorTransfer: undefined,
            DvBlSignalCompatibilityId: 0,
            DvProfile: 10,
            PixelFormat: 'yuv420p12le',
            Profile: 'Professional',
            RpuPresentFlag: true,
            VideoRange: 'HDR',
            VideoRangeType: 'DOVI'
        });

        expect(getCustomPlaybackEligibility(options, createCapabilities(), createAV1EligibilityOptions()))
            .toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
        expect(getCustomPlaybackEligibility(options, createCapabilities(), { ...createAV1EligibilityOptions(), allowDolbyVision: true }))
            .toMatchObject({ ...AV1_PACKAGE_ROUTE, dolbyVisionProfile: 5, hdr: true, rawVideoFrameFormat: 'I420P12' });
    });

    it('keeps AV1 Main at 10 bits in BT.601 potential, since its own raw SDR key may authorize', () => {
        expect(hasPotentialCustomPlaybackVideoRoute(createPlaybackSelectionItem({ ...UNROUTED_MAIN_STREAM.videoStream, Codec: 'AV1' }))).toBe(true);
    });

    it.each(PACKAGE_ONLY_STREAMS)('presents AV1 $subject from its qualified exact raw format ahead of the package', ({ format, videoStream }) => {
        const options = createAV1Options(videoStream);
        const routeKey = `${format}:bt709:bt709:limited:sdr` as const;
        const eligibilityOptions = {
            ...createAV1EligibilityOptions(),
            allowRawSDR: true,
            authorizedRawHDRRouteKeys: [ routeKey ]
        };

        expect(getRawVideoPresentationRouteKey(options)).toBe(routeKey);
        expect(getCustomPlaybackEligibility(options, createAV1RawFormatCapabilities(), eligibilityOptions)).toMatchObject({
            eligible: true,
            hdr: false,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            rawVideoFrameFormat: format,
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes'
        });
        // Without its raw key, or its format's qualification, the package takes it, and without either nothing does
        expect(getCustomPlaybackEligibility(options, createAV1RawFormatCapabilities(), createAV1EligibilityOptions()))
            .toMatchObject({ ...AV1_PACKAGE_ROUTE, rawVideoFrameFormat: format });
        expect(getCustomPlaybackEligibility(options, createCapabilities(), eligibilityOptions))
            .toMatchObject({ ...AV1_PACKAGE_ROUTE, rawVideoFrameFormat: format });
        expect(getCustomPlaybackEligibility(options, createCapabilities(), { ...eligibilityOptions, gpuVideoDecoders: [] }))
            .toEqual({ eligible: false, reason: 'codec-unsupported' });
    });

    it('presents AV1 High 4:4:4 in BT.2020 SDR only through its own first-use raw key', () => {
        const options = createAV1Options({
            ColorPrimaries: 'bt2020',
            ColorSpace: 'bt2020nc',
            ColorTransfer: 'bt2020-10',
            PixelFormat: 'yuv444p',
            Profile: 'High'
        });
        const eligibilityOptions = { allowRawHDR: false, allowRawSDR: true, runtimeAvailability: AVAILABLE_RUNTIME };

        expect(getRawVideoPresentationRouteKey(options)).toBe('I444:bt2020-ncl:bt2020:limited:sdr');
        expect(getCustomPlaybackEligibility(options, createAV1RawFormatCapabilities(), {
            ...eligibilityOptions,
            authorizedRawHDRRouteKeys: [ 'I444:bt709:bt709:limited:sdr' ]
        })).toEqual({ eligible: false, reason: 'codec-unsupported' });
        expect(getCustomPlaybackEligibility(options, createAV1RawFormatCapabilities(), {
            ...eligibilityOptions,
            authorizedRawHDRRouteKeys: [ 'I444:bt2020-ncl:bt2020:limited:sdr' ]
        })).toMatchObject({ eligible: true, rawVideoFrameFormat: 'I444', videoOutputMode: 'raw-planes' });
    });

    it('presents AV1 High 10-bit HDR10 from raw I444P10 through its raw HDR key', () => {
        const options = createAV1Options({ ...HDR10_STREAM, BitDepth: 10, PixelFormat: 'yuv444p10le', Profile: 'High' });

        expect(getCustomPlaybackEligibility(options, createAV1RawFormatCapabilities(), {
            allowRawHDR: true,
            authorizedRawHDRRouteKeys: [ 'I444P10:bt2020-ncl:bt2020:limited:pq' ],
            runtimeAvailability: AVAILABLE_RUNTIME
        })).toMatchObject({ eligible: true, hdr: true, rawVideoFrameFormat: 'I444P10', videoOutputMode: 'raw-planes' });
        expect(getCustomPlaybackEligibility(options, createAV1RawFormatCapabilities(), {
            allowRawHDR: true,
            authorizedRawHDRRouteKeys: [ 'I420P10:bt2020-ncl:bt2020:limited:pq' ],
            runtimeAvailability: AVAILABLE_RUNTIME
        })).toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
    });

    it('keeps 8-bit AV1 Main SDR on its native route whatever its I420 raw format qualification', () => {
        expect(getCustomPlaybackEligibility(
            createAV1Options({ PixelFormat: 'yuv420p' }),
            createAV1RawFormatCapabilities(),
            { allowRawHDR: false, allowRawSDR: true, authorizedRawHDRRouteKeys: [ 'I420:bt709:bt709:limited:sdr' ], runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({ eligible: true, rawVideoFrameFormat: null, videoOutputMode: 'video-frame' });
    });

    it('decodes 10-bit AV1 HDR10 on the package when raw HDR is unavailable and the host tone-maps frame-pool HDR', () => {
        const options = createAV1Options({ ...HDR10_STREAM, BitDepth: 10 });

        expect(getCustomPlaybackEligibility(options, createCapabilities(), createAV1EligibilityOptions()))
            .toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
        expect(getCustomPlaybackEligibility(options, createCapabilities(), { ...createAV1EligibilityOptions(), allowFramePoolHDR: true }))
            .toMatchObject({ ...AV1_PACKAGE_ROUTE, hdr: true, rawVideoFrameFormat: 'I420P10' });
    });

    it('decodes 12-bit 4:0:0 AV1 only on a package that declares monochrome', () => {
        const monochromeAV1Package = createVideoDecoderPackageForTest(createVideoDecoderSource({
            codecs: [ 'av1' ],
            extraDirectives: [ MONOCHROME_DIRECTIVE_LINE ],
            id: 'av1-monochrome',
            name: 'AV1 with 4:0:0',
            outputFormats: [ 'I420', 'I420P10', 'I420P12' ]
        }));
        const options = createAV1Options({ BitDepth: 12, PixelFormat: 'gray12le', Profile: 'Professional' });

        expect(getCustomPlaybackEligibility(options, createCapabilities(), createAV1EligibilityOptions()))
            .toEqual({ eligible: false, reason: 'codec-unsupported' });
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { ...createAV1EligibilityOptions(), gpuVideoDecoders: [ ...createVideoDecoderOffers(AV1_PACKAGE), ...createVideoDecoderOffers(monochromeAV1Package) ] }
        )).toMatchObject({ ...createPackageVideoRoute(monochromeAV1Package, 'av1'), rawVideoFrameFormat: 'I420P12' });
        expect(hasPotentialCustomPlaybackVideoRoute(createPlaybackSelectionItem({ BitDepth: 12, Codec: 'AV1', PixelFormat: 'gray12le', Profile: 'Professional' }))).toBe(true);
    });

    it('keeps the native AV1 Main route ahead of the package', () => {
        const eligibility = getCustomPlaybackEligibility(createAV1Options({}), createCapabilities(), createAV1EligibilityOptions());

        expect(eligibility).toMatchObject({ videoDecoderBackend: 'native', videoOutputMode: 'video-frame' });
        expect(eligibility).not.toHaveProperty('gpuVideoDecoder');
    });

    it('rules out AV1 whose pixel format no frame pool holds, such as RGB', () => {
        expect(hasPotentialCustomPlaybackVideoRoute(createPlaybackSelectionItem({ BitDepth: 8, Codec: 'AV1', PixelFormat: 'gbrp', Profile: 'High' }))).toBe(false);
    });
});

describe('H.264 beyond 8-bit 4:2:0 on raw planes', () => {
    const BT709_SDR_STREAM = {
        ColorPrimaries: 'bt709',
        ColorRange: 'tv',
        ColorSpace: 'bt709',
        ColorTransfer: 'bt709',
        VideoRange: 'SDR',
        VideoRangeType: 'SDR'
    } as const;
    const HLG_STREAM = {
        ColorPrimaries: 'bt2020',
        ColorSpace: 'bt2020nc',
        ColorTransfer: 'arib-std-b67',
        VideoRange: 'HDR',
        VideoRangeType: 'HLG'
    } as const;
    const VARIANT_STREAMS = [
        { format: 'I420P10', variant: 'high420-10', videoStream: { BitDepth: 10, PixelFormat: 'yuv420p10le', Profile: 'High 10' } },
        { format: 'I422', variant: 'high422-8', videoStream: { BitDepth: 8, PixelFormat: 'yuv422p', Profile: 'High 4:2:2' } },
        { format: 'I422P10', variant: 'high422-10', videoStream: { BitDepth: 10, PixelFormat: 'yuv422p10le', Profile: 'High 4:2:2 Intra' } },
        { format: 'I444', variant: 'high444-8', videoStream: { BitDepth: 8, PixelFormat: 'yuv444p', Profile: 'High 4:4:4 Predictive' } },
        { format: 'I444P10', variant: 'high444-10', videoStream: { BitDepth: 10, PixelFormat: 'yuv444p10le', Profile: 'High 4:4:4 Intra' } }
    ] as const;

    function createH264Options(videoStream: Record<string, unknown>, container = 'mkv'): Record<string, unknown> {
        return createOptions({
            mediaSource: {
                Container: container,
                DefaultAudioStreamIndex: 1,
                MediaStreams: [
                    {
                        ...BT709_SDR_STREAM,
                        BitDepth: 8,
                        Codec: 'h264',
                        Height: 1_080,
                        Index: 0,
                        IsInterlaced: false,
                        Profile: 'High',
                        Type: 'Video',
                        Width: 1_920,
                        ...videoStream
                    },
                    { Channels: 2, Codec: 'aac', Index: 1, SampleRate: 48_000, Type: 'Audio' }
                ],
                RunTimeTicks: 60_000_000
            }
        });
    }

    /** Returns capabilities whose H.264 raw format variants qualified, all but the unqualified ones. */
    function createH264RawFormatCapabilities(unqualifiedVariants: readonly H264RawFormatVariant[] = []): CustomDecodeCapabilities {
        const capabilities = createCapabilities();
        const h264RawFormats = {} as Record<H264RawFormatVariant, H264RawFormatCapability>;
        for (const variant of H264_RAW_FORMAT_VARIANTS) {
            const definition = H264_RAW_FORMAT_PROBE_DEFINITIONS[variant];
            const qualified = !unqualifiedVariants.includes(variant);
            h264RawFormats[variant] = {
                bitDepth: definition.bitDepth,
                chromaFormat: definition.chromaFormat,
                codec: 'h264',
                codecString: definition.config.codec,
                format: definition.format,
                jellyfinProfile: definition.jellyfinProfile,
                pixelFormat: definition.pixelFormat,
                reason: qualified ? 'output-copy-supported' : 'output-copy-unsupported',
                status: qualified ? 'supported' : 'unsupported',
                variant
            };
        }
        capabilities.h264RawFormats = h264RawFormats;
        return capabilities;
    }

    function createRawSDROptions(format: string): CustomPlaybackEligibilityOptions {
        return {
            allowRawHDR: false,
            allowRawSDR: true,
            authorizedRawHDRRouteKeys: [ `${format}:bt709:bt709:limited:sdr` as RawHDRAuthorizationRouteKey ],
            runtimeAvailability: AVAILABLE_RUNTIME
        };
    }

    it.each(VARIANT_STREAMS)('presents $videoStream.Profile $format from its qualified $variant variant on native raw planes', ({ format, variant, videoStream }) => {
        const options = createH264Options(videoStream);

        expect(getRawVideoPresentationRouteKey(options)).toBe(`${format}:bt709:bt709:limited:sdr`);
        expect(getCustomPlaybackEligibility(options, createH264RawFormatCapabilities(), createRawSDROptions(format))).toMatchObject({
            eligible: true,
            hdr: false,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            rawVideoFrameFormat: format,
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes'
        });
        // An unqualified variant, a missing raw key, or no raw SDR presentation never falls through to the High route
        expect(getCustomPlaybackEligibility(options, createH264RawFormatCapabilities([ variant ]), createRawSDROptions(format)))
            .toEqual({ eligible: false, reason: 'codec-unsupported' });
        expect(getCustomPlaybackEligibility(options, createCapabilities(), createRawSDROptions(format)))
            .toEqual({ eligible: false, reason: 'codec-unsupported' });
        expect(getCustomPlaybackEligibility(options, createH264RawFormatCapabilities(), { ...createRawSDROptions(format), authorizedRawHDRRouteKeys: [] }))
            .toEqual({ eligible: false, reason: 'codec-unsupported' });
        expect(getCustomPlaybackEligibility(options, createH264RawFormatCapabilities(), { ...createRawSDROptions(format), allowRawSDR: false }))
            .toEqual({ eligible: false, reason: 'codec-unsupported' });
        expect(hasPotentialCustomPlaybackVideoRoute(createPlaybackSelectionItem({ ...videoStream, Codec: 'H264' }))).toBe(true);
    });

    it('takes each variant only through its own qualification', () => {
        const options = createH264Options(VARIANT_STREAMS[2].videoStream);

        expect(getCustomPlaybackEligibility(options, createH264RawFormatCapabilities([ 'high422-8', 'high444-10' ]), createRawSDROptions('I422P10')))
            .toMatchObject({ eligible: true, rawVideoFrameFormat: 'I422P10' });
        expect(getCustomPlaybackEligibility(options, createH264RawFormatCapabilities([ 'high422-10' ]), createRawSDROptions('I422P10')))
            .toEqual({ eligible: false, reason: 'codec-unsupported' });
    });

    it('keeps 8-bit High on its native VideoFrame route whatever the raw format qualifications', () => {
        const eligibility = getCustomPlaybackEligibility(createH264Options({ PixelFormat: 'yuv420p' }), createH264RawFormatCapabilities(), {
            ...createRawSDROptions('I420'),
            authorizedRawHDRRouteKeys: [ 'I420:bt709:bt709:limited:sdr' ]
        });

        expect(eligibility).toMatchObject({ eligible: true, rawVideoFrameFormat: null, videoDecoderBackend: 'native', videoOutputMode: 'video-frame' });
    });

    it.each([
        // No variant takes these, and no other route presents them
        [ '8-bit 4:2:0 coded under High 10', { BitDepth: 8, PixelFormat: 'yuv420p', Profile: 'High 10' } ],
        [ '12-bit 4:4:4', { BitDepth: 12, PixelFormat: 'yuv444p12le', Profile: 'High 4:4:4 Predictive' } ],
        [ 'RGB 4:4:4', { BitDepth: 8, PixelFormat: 'gbrp', Profile: 'High 4:4:4 Predictive' } ],
        [ '10-bit 4:0:0', { BitDepth: 10, PixelFormat: 'gray10le', Profile: 'High 10' } ]
    ])('refuses H.264 %s, which no route presents', (_subject, videoStream) => {
        expect(getCustomPlaybackEligibility(createH264Options(videoStream), createH264RawFormatCapabilities(), {
            allowRawHDR: true,
            allowRawSDR: true,
            authorizedRawHDRRouteKeys: H264_RAW_FORMAT_VARIANTS.map(variant => (
                `${H264_RAW_FORMAT_PROBE_DEFINITIONS[variant].format}:bt709:bt709:limited:sdr` as RawHDRAuthorizationRouteKey
            )),
            runtimeAvailability: AVAILABLE_RUNTIME
        })).toEqual({ eligible: false, reason: 'codec-unsupported' });
    });

    it('presents 10-bit HLG High 4:2:2 from raw I422P10 through its raw HDR key only', () => {
        const options = createH264Options({ ...HLG_STREAM, BitDepth: 10, PixelFormat: 'yuv422p10le', Profile: 'High 4:2:2' });
        const routeKey = 'I422P10:bt2020-ncl:bt2020:limited:hlg';

        expect(getRawVideoPresentationRouteKey(options)).toBe(routeKey);
        expect(getCustomPlaybackEligibility(options, createH264RawFormatCapabilities(), {
            allowRawHDR: true,
            authorizedRawHDRRouteKeys: [ routeKey ],
            runtimeAvailability: AVAILABLE_RUNTIME
        })).toMatchObject({ eligible: true, hdr: true, rawVideoFrameFormat: 'I422P10', videoOutputMode: 'raw-planes' });
        expect(getCustomPlaybackEligibility(options, createH264RawFormatCapabilities(), {
            allowRawHDR: false,
            authorizedRawHDRRouteKeys: [ routeKey ],
            runtimeAvailability: AVAILABLE_RUNTIME
        })).toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
        expect(getCustomPlaybackEligibility(options, createH264RawFormatCapabilities([ 'high422-10' ]), {
            allowRawHDR: true,
            authorizedRawHDRRouteKeys: [ routeKey ],
            runtimeAvailability: AVAILABLE_RUNTIME
        })).toEqual({ eligible: false, reason: 'hdr-codec-unsupported' });
    });

    it('presents interlaced High 4:2:2 in MPEG-TS on raw planes, which the deinterlacing pass takes', () => {
        const options = createH264Options({ BitDepth: 8, FieldOrder: 'tt', IsInterlaced: true, PixelFormat: 'yuv422p', Profile: 'High 4:2:2' }, 'ts');

        expect(getCustomPlaybackEligibility(options, createH264RawFormatCapabilities(), createRawSDROptions('I422')))
            .toMatchObject({ eligible: true, rawVideoFrameFormat: 'I422', videoOutputMode: 'raw-planes' });
        expect(hasPotentialCustomPlaybackVideoRoute(createPlaybackSelectionItem({
            BitDepth: 8,
            Codec: 'H264',
            IsInterlaced: true,
            PixelFormat: 'yuv422p',
            Profile: 'High 4:2:2'
        }, 'ts'))).toBe(true);
    });
});

describe('AVI and codecs without a route', () => {
    const AVI_CONTAINER = 'avi';
    // jsdom's own user agent names AppleWebKit without Chrome, which Mediabunny takes for WebKit
    const CHROMIUM_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    const SAFARI_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function createAVIOptions(videoCodec: string, audioCodec: string): Record<string, unknown> {
        const options = createOptions();
        const mediaSource = options.mediaSource as { Container: string, MediaStreams: Array<Record<string, unknown>> };
        mediaSource.Container = AVI_CONTAINER;
        mediaSource.MediaStreams[0].Codec = videoCodec;
        mediaSource.MediaStreams[1].Codec = audioCodec;
        return options;
    }

    it.each([
        [ 'Chromium', CHROMIUM_USER_AGENT ],
        [ 'WebKit', SAFARI_USER_AGENT ]
    ])('plays H.264 with B-frames and MP3 from AVI on %s, since the fork stamps each picture with its presentation time', (_runtime, userAgent) => {
        vi.stubGlobal('navigator', { userAgent });

        expect(getCustomPlaybackEligibility(
            createAVIOptions('h264', 'mp3'),
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({ eligible: true });
        expect(hasPotentialCustomPlaybackVideoRoute(createPlaybackSelectionItem({ BitDepth: 8, Codec: 'h264', Profile: 'High' }, AVI_CONTAINER)))
            .toBe(true);
    });

    it('plays HEVC from AVI, whose pictures the fork stamps with their presentation times', () => {
        const options = createAVIOptions('hevc', 'mp3');
        (options.mediaSource as { MediaStreams: Array<Record<string, unknown>> }).MediaStreams[0].Profile = 'Main';

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({ eligible: true });
        expect(hasPotentialCustomPlaybackVideoRoute(createPlaybackSelectionItem({ BitDepth: 8, Codec: 'hevc', Profile: 'Main' }, AVI_CONTAINER)))
            .toBe(true);
    });

    it.each([ 'theora', 'THEORA' ])('declines %s as a known codec without a route', (videoCodec) => {
        expect(getCustomPlaybackEligibility(
            createAVIOptions(videoCodec, 'mp3'),
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'video-codec-without-route' });
        expect(hasPotentialCustomPlaybackVideoRoute(createPlaybackSelectionItem({ Codec: videoCodec }, AVI_CONTAINER))).toBe(false);
    });

    it('still names an unknown codec unsupported', () => {
        expect(getCustomPlaybackEligibility(
            createAVIOptions('cinepak', 'mp3'),
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });
    });
});

describe('AV1 on the native external HDR route', () => {
    const AV1_PQ_ROUTE_KEY = 'external-av1-main10-bt709-limited:pq-v1';
    const AV1_HLG_ROUTE_KEY = 'external-av1-main10-bt709-limited:hlg-v1';
    const HEVC_PQ_ROUTE_KEY = 'external-hevc-main10-bt709-limited:pq-v1';
    const RAW_PQ_ROUTE_KEY = 'I420P10:bt2020-ncl:bt2020:limited:pq';
    const BT2020_COLORS = { ColorPrimaries: 'bt2020', ColorRange: 'tv', ColorSpace: 'bt2020nc' } as const;
    const NATIVE_ROUTE = {
        eligible: true,
        hdr: true,
        maximumCodedHeight: 2_160,
        maximumCodedWidth: 3_840,
        neutralizeHDRColorMetadata: true,
        rawVideoFrameFormat: null,
        videoDecoderBackend: 'native',
        videoOutputMode: 'video-frame'
    } as const;

    function createHDRAV1Options(videoStream: Record<string, unknown> = {}): Record<string, unknown> {
        return createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 1,
                MediaStreams: [
                    {
                        ...BT2020_COLORS,
                        BitDepth: 10,
                        Codec: 'av1',
                        ColorTransfer: 'smpte2084',
                        Height: 2_160,
                        Index: 0,
                        IsInterlaced: false,
                        Profile: 'Main',
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'HDR10',
                        Width: 3_840,
                        ...videoStream
                    },
                    { Channels: 2, Codec: 'aac', Index: 1, SampleRate: 48_000, Type: 'Audio' }
                ],
                RunTimeTicks: 60_000_000
            }
        });
    }

    function createEligibilityOptions(authorizedExternalHDRRouteKeys: readonly ExternalHDRAuthorizationRouteKey[]): CustomPlaybackEligibilityOptions {
        return {
            allowNativeHDR: true,
            allowRawHDR: true,
            authorizedExternalHDRRouteKeys,
            authorizedRawHDRRouteKeys: [ RAW_PQ_ROUTE_KEY ],
            runtimeAvailability: AVAILABLE_RUNTIME
        };
    }

    it.each([
        { label: 'HDR10', stream: { ColorTransfer: 'smpte2084', VideoRangeType: 'HDR10' }, routeKey: AV1_PQ_ROUTE_KEY, transfer: 'pq' },
        { label: 'HDR10+', stream: { ColorTransfer: 'smpte2084', VideoRangeType: 'HDR10Plus' }, routeKey: AV1_PQ_ROUTE_KEY, transfer: 'pq' },
        { label: 'HLG', stream: { ColorTransfer: 'arib-std-b67', VideoRangeType: 'HLG' }, routeKey: AV1_HLG_ROUTE_KEY, transfer: 'hlg' }
    ] as const)('presents $label AV1 as neutralized hardware frames once $routeKey is authorized', ({ routeKey, stream, transfer }) => {
        expect(getCustomPlaybackEligibility(
            createHDRAV1Options(stream),
            createNativeAV1Capabilities(),
            { ...createEligibilityOptions([ routeKey ]), authorizedRawHDRRouteKeys: [ `I420P10:bt2020-ncl:bt2020:limited:${transfer}` ] }
        )).toMatchObject({ ...NATIVE_ROUTE, nativeHDRTransfer: transfer });
    });

    it('falls back to raw I420P10 without the AV1 key, which the HEVC key does not stand in for', () => {
        for (const routeKeys of [ [], [ HEVC_PQ_ROUTE_KEY ], [ AV1_HLG_ROUTE_KEY ] ] as const) {
            expect(getCustomPlaybackEligibility(
                createHDRAV1Options(),
                createNativeAV1Capabilities(),
                createEligibilityOptions(routeKeys)
            )).toMatchObject({ eligible: true, neutralizeHDRColorMetadata: false, rawVideoFrameFormat: 'I420P10', videoOutputMode: 'raw-planes' });
        }
    });

    it('falls back to raw I420P10 without a verified native AV1 Main 10 decoder or outside its profile and depth', () => {
        const unverifiedCapabilities = createCapabilities();
        expect(getCustomPlaybackEligibility(createHDRAV1Options(), unverifiedCapabilities, createEligibilityOptions([ AV1_PQ_ROUTE_KEY ])))
            .toMatchObject({ eligible: true, rawVideoFrameFormat: 'I420P10' });
        expect(getCustomPlaybackEligibility(
            createHDRAV1Options({ BitDepth: 12, PixelFormat: 'yuv420p12le', Profile: 'Professional' }),
            createNativeAV1Capabilities(),
            createEligibilityOptions([ AV1_PQ_ROUTE_KEY ])
        )).not.toMatchObject({ neutralizeHDRColorMetadata: true });
    });

    it('keeps the AV1 key off an HEVC stream, whose route needs the HEVC key', () => {
        const hevcOptions = createHDRAV1Options({ Codec: 'hevc', Profile: 'Main 10' });

        expect(getCustomPlaybackEligibility(hevcOptions, createNativeAV1Capabilities(), createEligibilityOptions([ AV1_PQ_ROUTE_KEY ])))
            .toMatchObject({ eligible: true, neutralizeHDRColorMetadata: false, rawVideoFrameFormat: 'I420P10' });
        expect(getCustomPlaybackEligibility(hevcOptions, createNativeAV1Capabilities(), createEligibilityOptions([ HEVC_PQ_ROUTE_KEY ])))
            .toMatchObject({ ...NATIVE_ROUTE, nativeHDRTransfer: 'pq' });
    });

    it('needs the host to allow native HDR and a named BT.2020 description', () => {
        expect(getCustomPlaybackEligibility(
            createHDRAV1Options(),
            createNativeAV1Capabilities(),
            { ...createEligibilityOptions([ AV1_PQ_ROUTE_KEY ]), allowNativeHDR: false }
        )).toMatchObject({ rawVideoFrameFormat: 'I420P10' });
        expect(getCustomPlaybackEligibility(
            createHDRAV1Options({ ColorPrimaries: undefined }),
            createNativeAV1Capabilities(),
            createEligibilityOptions([ AV1_PQ_ROUTE_KEY ])
        )).toMatchObject({ rawVideoFrameFormat: 'I420P10' });
    });
});

describe('Dolby Atmos audio eligibility', () => {
    const OBJECT_AUDIO_OPTIONS: ReadonlyMap<number, string> = new Map([ [ 1, 'renderChannelMask' ], [ 2, 'renderBinaural' ] ]);
    const RENDERING_DOLBY_PACKAGE: AudioDecoderPackage = {
        ...DOLBY_AUDIO_PACKAGE,
        manifest: { ...DOLBY_AUDIO_PACKAGE.manifest, options: OBJECT_AUDIO_OPTIONS }
    };
    const RENDERING_TRUEHD_PACKAGE: AudioDecoderPackage = {
        ...TRUEHD_AUDIO_PACKAGE,
        manifest: { ...TRUEHD_AUDIO_PACKAGE.manifest, options: OBJECT_AUDIO_OPTIONS }
    };
    const EAC3_ATMOS_PROFILE = 'Dolby Digital Plus + Dolby Atmos';
    const TRUEHD_ATMOS_PROFILE = 'Dolby TrueHD + Dolby Atmos';

    function createAudioOptions(codec: string, channelCount: number, profile: string | undefined): unknown {
        const options = createOptions();
        const stream = (options.mediaSource as { MediaStreams: Array<Record<string, unknown>> }).MediaStreams[1];
        stream.Codec = codec;
        stream.Channels = channelCount;
        stream.ChannelLayout = channelCount === 8 ? '7.1' : '5.1';
        stream.SampleRate = 48_000;
        stream.Profile = profile;
        return options;
    }

    function getAudioEligibility(
        options: unknown,
        audioRenderTarget: CustomAudioRenderTarget | undefined,
        audioDecoders: readonly AudioDecoderPackage[] = [ RENDERING_DOLBY_PACKAGE, RENDERING_TRUEHD_PACKAGE ]
    ): CustomPlaybackEligibility {
        return getCustomPlaybackEligibility(options, createCapabilities(), {
            allowRawHDR: false,
            audioDecoders,
            ...(audioRenderTarget ? { audioRenderTarget } : {}),
            nativeMediaAudioCapabilities: createNativeMediaAudioCapabilities(new Set([ 'eac3:6:48000' ])),
            runtimeAvailability: AVAILABLE_RUNTIME
        });
    }

    it.each([
        { binauralHeadphones: false, speakerLayout: '7.1.4' },
        { binauralHeadphones: false, speakerLayout: '5.1.2' },
        // 7.1 has speakers the 5.1 core lacks
        { binauralHeadphones: false, speakerLayout: '7.1' },
        { binauralHeadphones: true, speakerLayout: 'stereo' }
    ] as const)('prefers a rendering package over native media for E-AC-3 Atmos on $speakerLayout, binaural $binauralHeadphones', audioRenderTarget => {
        expect(getAudioEligibility(createAudioOptions('eac3', 6, EAC3_ATMOS_PROFILE), audioRenderTarget)).toMatchObject({
            audioDecoder: { codec: 'eac3', source: { manifest: { options: OBJECT_AUDIO_OPTIONS } } },
            audioOutputMode: 'decoded-pcm',
            audioRendersObjects: true,
            audioSourceChannelCount: 6,
            eligible: true
        });
    });

    it.each([
        { binauralHeadphones: false, speakerLayout: '5.1' },
        { binauralHeadphones: false, speakerLayout: 'stereo' },
        // Binaural rendering only renders a stereo output
        { binauralHeadphones: true, speakerLayout: '5.1' }
    ] as const)('keeps E-AC-3 Atmos on native media when $speakerLayout, binaural $binauralHeadphones, needs no objects', audioRenderTarget => {
        const eligibility = getAudioEligibility(createAudioOptions('eac3', 6, EAC3_ATMOS_PROFILE), audioRenderTarget);

        expect(eligibility).toMatchObject({ audioOutputMode: 'native-media', eligible: true });
        expect(eligibility).not.toHaveProperty('audioRendersObjects');
    });

    it('keeps native media for E-AC-3 without Atmos, for Atmos without a render target, and without a rendering package', () => {
        const heightTarget: CustomAudioRenderTarget = { binauralHeadphones: false, speakerLayout: '7.1.4' };
        const eligibilities = [
            getAudioEligibility(createAudioOptions('eac3', 6, undefined), heightTarget),
            getAudioEligibility(createAudioOptions('eac3', 6, EAC3_ATMOS_PROFILE), undefined),
            getAudioEligibility(createAudioOptions('eac3', 6, EAC3_ATMOS_PROFILE), heightTarget, AUDIO_PACKAGES)
        ];

        for (const eligibility of eligibilities) {
            expect(eligibility).toMatchObject({ audioOutputMode: 'native-media', eligible: true });
            expect(eligibility).not.toHaveProperty('audioRendersObjects');
        }
    });

    it('renders TrueHD Atmos objects with a package that declares them, and plays its 7.1 presentation with one that does not', () => {
        const options = createAudioOptions('truehd', 8, TRUEHD_ATMOS_PROFILE);
        const target: CustomAudioRenderTarget = { binauralHeadphones: false, speakerLayout: '7.1' };

        expect(getAudioEligibility(options, target)).toMatchObject({
            audioDecoder: { codec: 'truehd' },
            audioRendersObjects: true,
            audioSourceChannelCount: 8,
            eligible: true
        });
        const stockEligibility = getAudioEligibility(options, target, AUDIO_PACKAGES);
        expect(stockEligibility).toMatchObject({ audioDecoder: { codec: 'truehd' }, audioOutputMode: 'decoded-pcm', eligible: true });
        expect(stockEligibility).not.toHaveProperty('audioRendersObjects');
    });

    it('tells a host before eligibility whether the selected track\'s Atmos objects must render', () => {
        const heightTarget: CustomAudioRenderTarget = { binauralHeadphones: false, speakerLayout: '7.1.4' };
        const coveredTarget: CustomAudioRenderTarget = { binauralHeadphones: false, speakerLayout: '5.1' };

        expect(playbackAudioNeedsObjectRendering(createAudioOptions('eac3', 6, EAC3_ATMOS_PROFILE), heightTarget)).toBe(true);
        expect(playbackAudioNeedsObjectRendering(createAudioOptions('eac3', 6, EAC3_ATMOS_PROFILE), { binauralHeadphones: true, speakerLayout: 'stereo' })).toBe(true);
        expect(playbackAudioNeedsObjectRendering(createAudioOptions('eac3', 6, EAC3_ATMOS_PROFILE), coveredTarget)).toBe(false);
        expect(playbackAudioNeedsObjectRendering(createAudioOptions('eac3', 6, undefined), heightTarget)).toBe(false);
        expect(playbackAudioNeedsObjectRendering(createAudioOptions('truehd', 8, TRUEHD_ATMOS_PROFILE), heightTarget)).toBe(true);
        expect(playbackAudioNeedsObjectRendering(createAudioOptions('eac3', 6, EAC3_ATMOS_PROFILE), undefined)).toBe(false);
        expect(playbackAudioNeedsObjectRendering({}, heightTarget)).toBe(false);
    });

    it('still checks the declared layout of an Atmos stream', () => {
        const eligibility = getAudioEligibility(
            createAudioOptions('truehd', 7, TRUEHD_ATMOS_PROFILE),
            { binauralHeadphones: false, speakerLayout: '7.1.4' }
        );

        expect(eligibility).toMatchObject({ eligible: false, reason: 'audio-layout-unsupported' });
    });
});
