import {
    getDolbyVisionBaseColorMetadata,
    getDolbyVisionPresentationDescriptor,
    getDolbyVisionPresentationSelection,
    getDolbyVisionProfile7HDR10BaseColorMetadata,
    getDolbyVisionProfile8HDR10BaseColorMetadata,
    getDolbyVisionProfile8HLGBaseColorMetadata,
    getPresentationInputColorMetadata,
    getPresentationVideoTrackOrdinal,
    hasExplicitBT2020HDRColorDescription,
    isDolbyVisionDualLayerProfile,
    type DolbyVisionPresentationDescriptor,
    type DolbyVisionReconstructionProfile
} from '../presentation/PresentationInput';
import type { AudioDecoderPackageSelection } from '../decode/audio/AudioDecoderPackageInstance';
import type { InputColorMetadata } from '../color/ColorMetadata';
import type { AudioDecoderPackage } from '../decode/packages/DecoderPackage';
import {
    jellyfinTicksToMicroseconds,
    type Microseconds
} from '../MediaTime';
import {
    CUSTOM_NATIVE_VIDEO_BIT_DEPTH,
    hasSupportedNativeSDRVideoCodec,
    isCustomPackageVideoCodec,
    type CustomAudioCodec,
    type CustomDecodeCapabilities,
    type CustomNativeHDRHEVCCapability,
    type CustomNativeSurroundAudioCodecCapability,
    type CustomPackageVideoCodec,
    type CustomVideoCodec
} from './CustomDecodeCapabilities';
import {
    getSupportedNativeMediaAudioRoute,
    type NativeMediaAudioCapabilities,
    type NativeMediaAudioCodec
} from './NativeMediaAudioCapabilities';
import {
    getCustomPlaybackRuntimeAvailability,
    type CustomPlaybackRuntimeAvailability,
    type CustomPlaybackRuntimeRequirements
} from './CustomPlaybackRuntime';
import {
    isCustomMediabunnyPCMAudioCodec,
    isSupportedCustomAudioInputLayout,
    isSupportedCustomAudioInputMetadataLayout
} from '../audio/CustomAudioOutputPolicy';
import {
    isCustomPlaybackContainer,
    supportsCustomContainerCodecCombination
} from './CustomContainerCodecSupport';
import {
    getH264ProfileFromJellyfinValue,
    supportsH264JellyfinProfile
} from './H264ProfileCapabilities';
import {
    getExternalHDRAuthorizationRouteKey,
    type ExternalHDRAuthorizationRouteKey,
    type ExternalHDRVideoCodec
} from '../validation/ExternalHDRPresentationAuthorization';
import {
    getRawHDRAuthorizationRouteKey,
    type RawHDRAuthorizationRouteKey
} from '../validation/RawHDRPresentationAuthorization';
import type {
    CustomDecodeAudioOutputMode,
    CustomDecodeNativeHDRTransfer,
    CustomDecodeRawVideoFrameFormat,
    CustomDecodeVideoDecoderBackend,
    CustomDecodeVideoOutputMode
} from '../pipeline/DecodeWorkerProtocol';
import { isCustomDecodeMediaSource, type CustomDecodeMediaSource } from '../demux/CustomDecodeMediaSource';
import { requireMicroseconds } from '../TimeMath';
import {
    getRawFormatBitDepth,
    hasRawVideoFrameCopyLayout,
    RAW_VIDEO_DOLBY_VISION_FRAME_LAYER_COUNT,
    RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT,
    type RawVideoFrameGeometry
} from '../decode/video/RawVideoFrameCopy';
import {
    getHEVCRangeExtensionStreamDefinitionFromMetadata,
    type HEVCRangeExtensionProbeDefinition
} from './HEVCRangeExtensionCapabilities';
import {
    getAV1RawFormatStreamDefinitionFromMetadata,
    type AV1RawFormatProbeDefinition
} from './AV1RawFormatCapabilities';
import {
    getGPUDecoderFormatFacts,
    getGPUDecoderPixelFormatHolding,
    isGPUDecoderMonochromePixelFormat,
    isGPUDecoderOutputFormat,
    type GPUDecoderOutputFormat
} from '../decode/video/gpu/GPUDecodeFormats';
import { findGPUDecoderStreamFitFailure } from '../decode/video/gpu/GPUDecoderStreamFit';
import { createGPUDecodeStreamFacts } from '../decode/video/gpu/GPUFramePool';
import {
    isGPUVideoDecoderSummaryFit,
    type GPUVideoDecoderOffer,
    type GPUVideoDecoderSelection,
    type GPUVideoDecoderSummary
} from '../decode/video/gpu/GPUVideoDecoderCatalog';

const DIRECT_PLAY_METHOD = 'DIRECTPLAY';
// The AV1 external key whose vector proves the AV1 decoder's frames import exactly, which the external Dolby Vision route of AV1 also relies on
const NATIVE_AV1_DOLBY_VISION_DECODE_ROUTE_KEY: ExternalHDRAuthorizationRouteKey = 'external-av1-main10-bt709-limited:pq-v1';
const VIDEO_CODEC_ALIASES: Readonly<Record<string, CustomVideoCodec>> = {
    AVC: 'h264',
    AVC1: 'h264',
    AV1: 'av1',
    H263: 'h263',
    H264: 'h264',
    H265: 'hevc',
    HEVC: 'hevc',
    J2K: 'jpeg2000',
    'JPEG 2000': 'jpeg2000',
    JPEG2000: 'jpeg2000',
    'MPEG-1': 'mpeg1video',
    MPEG1: 'mpeg1video',
    MPEG1VIDEO: 'mpeg1video',
    'MPEG-2': 'mpeg2video',
    MPEG2: 'mpeg2video',
    MPEG2VIDEO: 'mpeg2video',
    MPEG4: 'mpeg4',
    // FFmpeg's decoder name of MS-MPEG4 version 3, the Microsoft variant DivX 3 encodes
    MSMPEG4: 'msmpeg4v3',
    MSMPEG4V1: 'msmpeg4v1',
    MSMPEG4V2: 'msmpeg4v2',
    MSMPEG4V3: 'msmpeg4v3',
    'VC-1': 'vc1',
    VC1: 'vc1',
    VP8: 'vp8',
    VP9: 'vp9',
    // FFmpeg's name of the VC-1 Simple and Main profiles, which ffprobe reports for WMV3 streams
    WMV3: 'wmv3'
};
// Video codecs the engine knows, as ffprobe names them, that neither WebCodecs nor a decoder package decodes: Theora
const VIDEO_CODECS_WITHOUT_ROUTE: ReadonlySet<string> = new Set<string>([
    'THEORA'
]);
// The VC-1 profiles of each codec, as ffprobe names them: vc1 is the Advanced profile, and wmv3 the Simple and Main profiles and the Complex profile, which FFmpeg decodes as Main
const VC1_METADATA_PROFILES: Readonly<Record<'vc1' | 'wmv3', readonly string[]>> = Object.freeze({
    vc1: Object.freeze([ 'ADVANCED' ]),
    wmv3: Object.freeze([ 'SIMPLE', 'MAIN', 'COMPLEX' ])
});
// The frame pool formats of the AV1 streams native routes decode: Main at 4:2:0, 8 or 10 bits
const NATIVE_AV1_OUTPUT_FORMATS: ReadonlySet<GPUDecoderOutputFormat> = new Set<GPUDecoderOutputFormat>([ 'I420', 'I420P10' ]);
// The AV1 profile whose 4:2:0 streams take the ordinary routes; High and Professional raw planes keep their exact format
const AV1_MAIN_PROFILE_NAME = 'Main';

const AUDIO_CODEC_ALIASES = new Map<string, CustomAudioCodec>([
    [ 'AAC', 'aac' ],
    [ 'AC-3', 'ac3' ],
    [ 'AC3', 'ac3' ],
    [ 'E-AC-3', 'eac3' ],
    [ 'EC-3', 'eac3' ],
    [ 'EAC3', 'eac3' ],
    [ 'EC3', 'eac3' ],
    [ 'DCA', 'dts' ],
    [ 'DTS', 'dts' ],
    [ 'FLAC', 'flac' ],
    [ 'MP3', 'mp3' ],
    [ 'OPUS', 'opus' ],
    [ 'MLP', 'mlp' ],
    [ 'PCM_ALAW', 'pcm_alaw' ],
    [ 'PCM_F32BE', 'pcm_f32be' ],
    [ 'PCM_F32LE', 'pcm_f32le' ],
    [ 'PCM_F64BE', 'pcm_f64be' ],
    [ 'PCM_F64LE', 'pcm_f64le' ],
    [ 'PCM_MULAW', 'pcm_mulaw' ],
    [ 'PCM_S16BE', 'pcm_s16be' ],
    [ 'PCM_S16LE', 'pcm_s16le' ],
    [ 'PCM_S24BE', 'pcm_s24be' ],
    [ 'PCM_S24LE', 'pcm_s24le' ],
    [ 'PCM_S32BE', 'pcm_s32be' ],
    [ 'PCM_S32LE', 'pcm_s32le' ],
    [ 'PCM_S8', 'pcm_s8' ],
    [ 'PCM_U8', 'pcm_u8' ],
    [ 'TRUEHD', 'truehd' ],
    [ 'TRUE-HD', 'truehd' ],
    [ 'VORBIS', 'vorbis' ]
]);

type MediaStream = {
    AverageFrameRate?: unknown
    BitDepth?: unknown
    BitRate?: unknown
    ChannelLayout?: unknown
    Channels?: unknown
    Codec?: unknown
    Height?: unknown
    Index?: unknown
    IsInterlaced?: unknown
    Level?: unknown
    PixelFormat?: unknown
    Profile?: unknown
    RealFrameRate?: unknown
    Rotation?: unknown
    SampleRate?: unknown
    Type?: unknown
    Width?: unknown
};

type MediaSource = {
    Container?: unknown
    DefaultAudioStreamIndex?: unknown
    Id?: unknown
    IsInfiniteStream?: unknown
    LiveStreamId?: unknown
    MediaStreams?: unknown
    RunTimeTicks?: unknown
};

type PlaybackOptions = {
    mediaSource?: MediaSource
    playMethod?: unknown
    playerStartPositionTicks?: unknown
    /** The media the worker reads, a CustomDecodeMediaSource */
    source?: unknown
};

type PlaybackSelectionItem = MediaSource & {
    MediaSources?: unknown
};

type PlaybackSelectionOptions = {
    mediaSourceId?: unknown
};

type ParsedPlaybackSource = {
    containerTokens: string[]
    /** Null when the server never probed a runtime; the decoded stream still defines its own end */
    durationMicroseconds: Microseconds | null
    mediaSource: MediaSource
    parsed: true
    source: CustomDecodeMediaSource
    startTimeMicroseconds: Microseconds
    streams: MediaStream[]
};

type PlaybackSourceParseResult = ParsedPlaybackSource | (IneligibleCustomPlayback & {
    parsed: false
});

type AudioStreamSelection =
    | { status: 'invalid' }
    | { status: 'none' }
    | { status: 'selected', stream: MediaStream, trackOrdinal: number };

type VideoStreamSelection =
    | { status: 'invalid' }
    | { status: 'selected', stream: MediaStream, trackOrdinal: number };

type VideoOutputSelection =
    | {
        dolbyVisionProfile?: DolbyVisionReconstructionProfile
        gpuVideoDecoder?: GPUVideoDecoderSelection
        hdr: boolean
        maximumCodedHeight: number
        maximumCodedWidth: number
        nativeHDRTransfer?: Exclude<CustomDecodeNativeHDRTransfer, null>
        nativeVideoDecoderRequired: boolean
        neutralizeHDRColorMetadata: boolean
        rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
        status: 'selected'
        videoDecoderBackend: CustomDecodeVideoDecoderBackend
        videoOutputMode: CustomDecodeVideoOutputMode
    }
    | { reason: CustomPlaybackIneligibilityReason, status: 'invalid' };

type TypedStreamCandidate = {
    jellyfinStreamIndex: number
    stream: MediaStream
};

type AudioOutputSelection =
    | {
        audioDecoder?: AudioDecoderPackageSelection
        outputMode: CustomDecodeAudioOutputMode
        status: 'selected'
    }
    | {
        reason: 'audio-codec-unsupported' | 'audio-layout-unsupported'
        status: 'invalid'
    };

type PlaybackAudioSelection =
    | {
        audioCodec: CustomAudioCodec | null
        audioDecoder?: AudioDecoderPackageSelection
        audioOutputMode: CustomDecodeAudioOutputMode | null
        audioSourceChannelCount: number | null
        audioTrackIndex: number | null
        status: 'selected'
    }
    | {
        reason: 'audio-codec-unsupported' | 'audio-layout-unsupported' | 'audio-track-invalid'
        status: 'invalid'
    };

function getNativeHDRTransferResult(
    videoOutput: Extract<VideoOutputSelection, { status: 'selected' }>
): Pick<EligibleCustomPlayback, 'nativeHDRTransfer'> {
    if (!videoOutput.nativeHDRTransfer) {
        return {};
    }
    return { nativeHDRTransfer: videoOutput.nativeHDRTransfer };
}

function getGPUVideoDecoderResult(
    videoOutput: Extract<VideoOutputSelection, { status: 'selected' }>
): Pick<EligibleCustomPlayback, 'gpuVideoDecoder'> {
    return videoOutput.gpuVideoDecoder ? { gpuVideoDecoder: videoOutput.gpuVideoDecoder } : {};
}

export type CustomPlaybackIneligibilityReason =
    | 'audio-codec-unsupported'
    | 'audio-layout-unsupported'
    | 'audio-track-invalid'
    | 'codec-unsupported'
    | 'container-unsupported'
    | 'hdr-codec-unsupported'
    | 'hdr-presentation-unavailable'
    | 'invalid-options'
    | 'interlaced-video-unsupported'
    | 'live-stream-unsupported'
    | 'metadata-unsupported'
    | 'play-method-unsupported'
    | 'rotation-unsupported'
    | 'runtime-unavailable'
    | 'url-unsupported'
    | 'video-codec-without-route'
    | 'video-track-unavailable';

export type CustomPlaybackEligibilityOptions = {
    /** Single-layer RPU reconstruction is authorized for the stream's raw frame format. */
    allowDolbyVision?: boolean
    /** Profile 4 reconstruction is authorized for the stream's raw frame format. */
    allowDolbyVisionProfile4?: boolean
    /** Profile 7 reconstruction is authorized for the stream's raw frame format. */
    allowDolbyVisionProfile7?: boolean
    /** A GPU decoder may present HDR: the host tone-maps it, and the decoder's vector stands in for a presentation authorization. */
    allowFramePoolHDR?: boolean
    allowNativeDolbyVision?: boolean
    /** External Profile 8 reconstruction is authorized, which AV1 Profile 10 over a compatible or SDR base takes. */
    allowNativeDolbyVisionProfile8?: boolean
    allowNativeDolbyVisionProfile7HDR10Base?: boolean
    allowNativeDolbyVisionProfile8HDR10Base?: boolean
    allowNativeDolbyVisionProfile8HLGBase?: boolean
    allowNativeHDR?: boolean
    allowRawHDR: boolean
    allowRawSDR?: boolean
    /**
     * The host's audio decoder packages, in preference order.
     * The first that decodes the track's codec decodes it to PCM when neither the media element nor the engine's own decoders play it.
     */
    audioDecoders?: readonly AudioDecoderPackage[]
    authorizedExternalHDRRouteKeys?: readonly ExternalHDRAuthorizationRouteKey[]
    authorizedRawHDRRouteKeys?: readonly RawHDRAuthorizationRouteKey[]
    /** The GPU decoders the host's policy lets the frame-pool route choose, on the presenter's device */
    gpuVideoDecoders?: readonly GPUVideoDecoderOffer[]
    nativeMediaAudioCapabilities?: NativeMediaAudioCapabilities | null
    runtimeAvailability: CustomPlaybackRuntimeAvailability
};

/** The options of `hasEligibleCustomVideoRoute`: the eligibility's, without runtime availability, and with summaries of the GPU decoders in place of offers. */
export type CustomVideoRouteOptions = Omit<CustomPlaybackEligibilityOptions, 'gpuVideoDecoders' | 'runtimeAvailability'> & {
    /** The GPU decoder packages a playback could use, which the frame-pool route takes by the offers' fit check where a summary carries its header and the device's limit */
    gpuVideoDecoderSummaries?: readonly GPUVideoDecoderSummary[]
};

export type EligibleCustomPlayback = {
    /** The host's audio decoder package that decodes the decoded PCM route's track, which no engine decoder decodes */
    audioDecoder?: AudioDecoderPackageSelection
    audioOutputMode: CustomDecodeAudioOutputMode | null
    audioSourceChannelCount: number | null
    /** Zero-based ordinal within container audio tracks, not MediaStream.Index. */
    audioTrackIndex: number | null
    /** Null when the server has no runtime for the source */
    durationMicroseconds: Microseconds | null
    dolbyVisionProfile: DolbyVisionReconstructionProfile | null
    eligible: true
    /** The frame-pool route's GPU decoder, which decodes on the presenter's device */
    gpuVideoDecoder?: GPUVideoDecoderSelection
    hdr: boolean
    maximumCodedHeight: number
    maximumCodedWidth: number
    nativeHDRTransfer?: Exclude<CustomDecodeNativeHDRTransfer, null>
    neutralizeHDRColorMetadata: boolean
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    /** The media to play: the input's file, or its URL resolved against the page */
    source: CustomDecodeMediaSource
    startTimeMicroseconds: Microseconds
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
    videoOutputMode: CustomDecodeVideoOutputMode
    /** Zero-based ordinal within container video tracks, not MediaStream.Index. */
    videoTrackIndex: number
};

export type IneligibleCustomPlayback = {
    eligible: false
    reason: CustomPlaybackIneligibilityReason
};

export type CustomPlaybackEligibility = EligibleCustomPlayback | IneligibleCustomPlayback;

function normalizeMetadataValue(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalizedValue = value.trim().toUpperCase();
    return normalizedValue || null;
}

function getHTTPURL(value: string): string | null {
    if (!value.trim()) {
        return null;
    }

    try {
        const parsedURL = new URL(value, globalThis.location?.href);
        if (parsedURL.username || parsedURL.password) {
            return null;
        }
        switch (parsedURL.protocol) {
            case 'http:':
            case 'https:':
                return parsedURL.href;
            default:
                return null;
        }
    } catch {
        return null;
    }
}

/**
 * Returns a URL source resolved against the page, with the host's path pattern for responses that hide Content-Range,
 * or null when its URL is not a credential-free http(s) URL; a file source plays as it is.
 */
function resolvePlaybackMediaSource(source: CustomDecodeMediaSource): CustomDecodeMediaSource | null {
    switch (source.kind) {
        case 'file':
            return source;
        case 'url': {
            const url = getHTTPURL(source.url);
            if (!url) {
                return null;
            }
            return source.hiddenContentRangePathPattern ?
                { hiddenContentRangePathPattern: source.hiddenContentRangePathPattern, kind: 'url', url } :
                { kind: 'url', url };
        }
    }
}

function ticksToMicroseconds(value: unknown, defaultValue: number | null): Microseconds | null {
    if (value == null && defaultValue !== null) {
        return requireMicroseconds(defaultValue);
    }
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        return null;
    }

    return jellyfinTicksToMicroseconds(Number(value));
}

function getContainerTokens(value: unknown): string[] {
    if (typeof value !== 'string') {
        return [];
    }

    const tokens: string[] = [];
    for (const token of value.split(',')) {
        const normalizedToken = normalizeMetadataValue(token);
        if (normalizedToken) {
            tokens.push(normalizedToken);
        }
    }
    return tokens;
}

function getStreams(mediaSource: MediaSource): MediaStream[] {
    const streams: MediaStream[] = [];
    if (!Array.isArray(mediaSource.MediaStreams)) {
        return streams;
    }

    for (const stream of mediaSource.MediaStreams) {
        if (stream && typeof stream === 'object') {
            streams.push(stream as MediaStream);
        }
    }
    return streams;
}

function getJellyfinStreamIndex(stream: MediaStream, fallbackIndex: number): number | null {
    const streamIndex = stream.Index ?? fallbackIndex;
    return Number.isSafeInteger(streamIndex) && Number(streamIndex) >= 0 ?
        Number(streamIndex) :
        null;
}

function getSelectedAudioStream(
    mediaSource: MediaSource,
    streams: readonly MediaStream[]
): AudioStreamSelection {
    const audioStreams: TypedStreamCandidate[] = [];
    for (let streamPosition = 0; streamPosition < streams.length; streamPosition += 1) {
        const stream = streams[streamPosition];
        if (normalizeMetadataValue(stream.Type) !== 'AUDIO') {
            continue;
        }
        const jellyfinStreamIndex = getJellyfinStreamIndex(stream, streamPosition);
        if (jellyfinStreamIndex === null) {
            return { status: 'invalid' };
        }
        audioStreams.push({
            jellyfinStreamIndex,
            stream
        });
    }
    audioStreams.sort((left, right) => left.jellyfinStreamIndex - right.jellyfinStreamIndex);
    if (audioStreams.length === 0) {
        return { status: 'none' };
    }

    const requestedIndex = mediaSource.DefaultAudioStreamIndex;
    if (requestedIndex == null) {
        return {
            status: 'selected',
            stream: audioStreams[0].stream,
            trackOrdinal: 0
        };
    }
    if (!Number.isSafeInteger(requestedIndex) || Number(requestedIndex) < 0) {
        return { status: 'invalid' };
    }

    const trackOrdinal = audioStreams.findIndex(audioStream => (
        audioStream.jellyfinStreamIndex === requestedIndex
    ));
    if (trackOrdinal < 0) {
        return { status: 'invalid' };
    }

    return {
        status: 'selected',
        stream: audioStreams[trackOrdinal].stream,
        trackOrdinal
    };
}

function hasUnsupportedRotation(stream: MediaStream): boolean {
    if (stream.Rotation == null || stream.Rotation === '') {
        return false;
    }
    return !Number.isFinite(Number(stream.Rotation)) || Number(stream.Rotation) !== 0;
}

/**
 * Returns whether a route presents the codec's interlaced streams, outside the Dolby Vision routes, which never deinterlace.
 * The deinterlacing presentation pass takes frames whose rows alternate between the fields, as these codecs' decoders output them.
 * HEVC codes its fields apart as field pictures and JPEG 2000 as a codestream per field, which no decoder weaves into frames.
 */
export function presentsInterlacedVideo(codec: CustomVideoCodec): boolean {
    switch (codec) {
        case 'hevc':
        case 'jpeg2000':
            return false;
        case 'av1':
        case 'h264':
        case 'mpeg1video':
        case 'mpeg2video':
        case 'vc1':
        case 'vp8':
        case 'vp9':
        case 'wmv3':
        case 'mpeg4':
        case 'h263':
        case 'msmpeg4v1':
        case 'msmpeg4v2':
        case 'msmpeg4v3':
            return true;
    }
}

/** Returns whether an interlaced stream's codec codes its fields apart, so no route presents it. */
function codesInterlacedFieldsApart(codec: CustomVideoCodec, stream: MediaStream): boolean {
    return stream.IsInterlaced === true && !presentsInterlacedVideo(codec);
}

/**
 * Returns whether a selected route cannot present the stream's scan: the deinterlacing pass runs on every route but Dolby Vision's, whose profiles are
 * progressive, so a Dolby Vision route takes only a stream its metadata calls progressive.
 */
function refusesVideoScan(videoOutput: Extract<VideoOutputSelection, { status: 'selected' }>, stream: MediaStream): boolean {
    return videoOutput.dolbyVisionProfile !== undefined && stream.IsInterlaced !== false;
}

function getRawVideoFrameFormat(bitDepth: number): CustomDecodeRawVideoFrameFormat | null {
    switch (bitDepth) {
        case 10:
            return 'I420P10';
        case 12:
            return 'I420P12';
        default:
            return null;
    }
}

function isPositiveSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) > 0;
}

function getNativeMediaAudioCodec(codec: CustomAudioCodec): NativeMediaAudioCodec | null {
    if (isCustomMediabunnyPCMAudioCodec(codec)) {
        return null;
    }
    switch (codec) {
        case 'ac3':
        case 'eac3':
            return codec;
        case 'aac':
        case 'dts':
        case 'flac':
        case 'mlp':
        case 'mp3':
        case 'opus':
        case 'truehd':
        case 'vorbis':
            return null;
    }
}

function hasQualifiedDecodedPCMInputLayout(
    codec: CustomAudioCodec,
    stream: MediaStream,
    capabilities: CustomDecodeCapabilities
): boolean {
    if (!isSupportedCustomAudioInputLayout(codec, stream.Channels, stream.SampleRate)) {
        return false;
    }
    // These decoders report no speaker mask, so three channels need Jellyfin's 3.0 layout
    if (!isSupportedCustomAudioInputMetadataLayout(
        codec,
        stream.Channels,
        stream.SampleRate,
        stream.ChannelLayout
    )) {
        return false;
    }
    if (isCustomMediabunnyPCMAudioCodec(codec)) {
        return true;
    }
    if (stream.Channels !== 6) {
        return true;
    }

    switch (codec) {
        case 'aac':
        case 'flac':
        case 'opus':
        case 'vorbis': {
            const surroundCapability: CustomNativeSurroundAudioCodecCapability | undefined =
                capabilities.nativeSurroundAudio?.[codec];
            return surroundCapability?.status === 'supported'
                && surroundCapability.inputChannelCount === stream.Channels;
        }
        case 'ac3':
        case 'dts':
        case 'eac3':
        case 'mlp':
        case 'mp3':
        case 'truehd':
            return false;
    }
}

/** Returns the first of the host's audio decoder packages that decodes a codec no engine decoder decodes, as the codec it decodes it as. */
function findAudioDecoderPackage(
    codec: CustomAudioCodec,
    capabilities: CustomDecodeCapabilities,
    audioDecoders: readonly AudioDecoderPackage[]
): AudioDecoderPackageSelection | null {
    if (capabilities.audio[codec].status === 'supported') {
        return null;
    }
    const decoderPackage = audioDecoders.find((candidate: AudioDecoderPackage): boolean => candidate.manifest.codecs.includes(codec));
    if (!decoderPackage) {
        return null;
    }
    return { codec, source: { manifest: decoderPackage.manifest, memory: decoderPackage.memory, module: decoderPackage.module } };
}

function selectAudioOutput(
    codec: CustomAudioCodec,
    stream: MediaStream,
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    durationKnown: boolean
): AudioOutputSelection {
    const nativeMediaAudioCapabilities = eligibilityOptions.nativeMediaAudioCapabilities;
    const nativeCodec = getNativeMediaAudioCodec(codec);
    // The native media backend sizes its MediaSource from the duration
    if (nativeCodec && nativeMediaAudioCapabilities && durationKnown) {
        const nativeRoute = getSupportedNativeMediaAudioRoute(
            nativeMediaAudioCapabilities,
            nativeCodec,
            Number(stream.Channels),
            Number(stream.SampleRate)
        );
        if (nativeRoute) {
            return { outputMode: 'native-media', status: 'selected' };
        }
    }

    // A package reports its decoded speaker layout, so the declared layout only has to have a decoded PCM presentation path
    const audioDecoder = findAudioDecoderPackage(codec, capabilities, eligibilityOptions.audioDecoders ?? []);
    if (audioDecoder) {
        return isSupportedCustomAudioInputLayout(codec, stream.Channels, stream.SampleRate) ?
            { audioDecoder, outputMode: 'decoded-pcm', status: 'selected' } :
            { reason: 'audio-layout-unsupported', status: 'invalid' };
    }

    if (capabilities.audio[codec].status !== 'supported') {
        const nativeCodecSupported = nativeCodec !== null
            && nativeMediaAudioCapabilities?.audio[nativeCodec].status === 'supported';
        return {
            reason: nativeCodecSupported ?
                'audio-layout-unsupported' :
                'audio-codec-unsupported',
            status: 'invalid'
        };
    }
    if (!hasQualifiedDecodedPCMInputLayout(codec, stream, capabilities)) {
        return { reason: 'audio-layout-unsupported', status: 'invalid' };
    }
    return { outputMode: 'decoded-pcm', status: 'selected' };
}

function normalizeMetadataToken(value: unknown): string | null {
    return normalizeMetadataValue(value)?.replace(/[^A-Z0-9]/g, '') ?? null;
}

function hasSupportedNativeVideoProfile(codec: CustomVideoCodec, stream: MediaStream): boolean {
    const profile = normalizeMetadataToken(stream.Profile);
    switch (codec) {
        case 'h264':
            return profile === 'HIGH';
        case 'hevc':
            return profile === 'MAIN';
        case 'vp8':
            return profile === null || profile === 'PROFILE0';
        case 'vp9':
            return profile === 'PROFILE0' || profile === '0';
        case 'av1':
            return profile === 'MAIN';
        case 'mpeg1video':
        case 'mpeg2video':
        case 'vc1':
        case 'wmv3':
        case 'jpeg2000':
        case 'mpeg4':
        case 'h263':
        case 'msmpeg4v1':
        case 'msmpeg4v2':
        case 'msmpeg4v3':
            return false;
    }
}

function hasSupportedRawVideoProfile(codec: CustomVideoCodec, stream: MediaStream): boolean {
    const profile = normalizeMetadataToken(stream.Profile);
    switch (codec) {
        case 'hevc':
            return profile === 'MAIN10';
        case 'vp9':
            return profile === 'PROFILE2' || profile === '2';
        case 'av1':
            return profile === 'MAIN';
        case 'h264':
        case 'jpeg2000':
        case 'mpeg1video':
        case 'mpeg2video':
        case 'vc1':
        case 'vp8':
        case 'wmv3':
        case 'mpeg4':
        case 'h263':
        case 'msmpeg4v1':
        case 'msmpeg4v2':
        case 'msmpeg4v3':
            return false;
    }
}

// A VideoFrame route's coded size; its decoder is always the browser's own
type SDRVideoSelection = {
    maximumCodedHeight: number
    maximumCodedWidth: number
};

function getHEVCSDRVideoSelection(
    capabilities: CustomDecodeCapabilities,
    stream: MediaStream,
    bitDepth: number
): SDRVideoSelection | null {
    if (!isPositiveSafeInteger(stream.Width) || !isPositiveSafeInteger(stream.Height)) {
        return null;
    }

    if (bitDepth === 10) {
        return supportsNativeMain10HEVC(capabilities.nativeHDRHEVC, 'hevc', stream) ? {
            maximumCodedHeight: stream.Height,
            maximumCodedWidth: stream.Width
        } : null;
    }
    if (
        bitDepth !== CUSTOM_NATIVE_VIDEO_BIT_DEPTH
        || !hasSupportedNativeVideoProfile('hevc', stream)
        || !hasSupportedNativeSDRVideoCodec('hevc', capabilities)
    ) {
        return null;
    }
    return {
        maximumCodedHeight: stream.Height,
        maximumCodedWidth: stream.Width
    };
}

function getOrdinarySDRVideoSelection(
    capabilities: CustomDecodeCapabilities,
    codec: Exclude<CustomVideoCodec, CustomPackageVideoCodec>,
    stream: MediaStream,
    bitDepth: number
): SDRVideoSelection | null {
    if (codec === 'hevc') {
        return getHEVCSDRVideoSelection(capabilities, stream, bitDepth);
    }
    if (
        bitDepth !== CUSTOM_NATIVE_VIDEO_BIT_DEPTH
        || !isPositiveSafeInteger(stream.Width)
        || !isPositiveSafeInteger(stream.Height)
    ) {
        return null;
    }

    const maximumCodedWidth = stream.Width;
    const maximumCodedHeight = stream.Height;
    switch (codec) {
        case 'h264':
            if (
                !capabilities.h264Profiles
                || !supportsH264JellyfinProfile(capabilities.h264Profiles, stream.Profile)
            ) {
                return null;
            }
            break;
        case 'av1':
        case 'vp9':
            if (
                !hasSupportedNativeSDRVideoCodec(codec, capabilities)
                || !hasSupportedNativeVideoProfile(codec, stream)
            ) {
                return null;
            }
            break;
        case 'vp8':
            if (
                capabilities.video[codec].status !== 'supported'
                || !hasSupportedNativeVideoProfile(codec, stream)
            ) {
                return null;
            }
            break;
    }

    return {
        maximumCodedHeight,
        maximumCodedWidth
    };
}

function getStreamRawVideoGeometry(stream: MediaStream): RawVideoFrameGeometry | null {
    if (!isPositiveSafeInteger(stream.Width) || !isPositiveSafeInteger(stream.Height)) {
        return null;
    }
    return {
        codedHeight: stream.Height,
        codedWidth: stream.Width,
        displayHeight: stream.Height,
        displayWidth: stream.Width
    };
}

/** Returns whether the stream's raw frames, with every layer a presented frame pairs, have a copy layout. */
function hasStreamRawVideoFrameCopyLayout(
    stream: MediaStream,
    format: CustomDecodeRawVideoFrameFormat,
    frameLayerCount: number
): boolean {
    const geometry = getStreamRawVideoGeometry(stream);
    return geometry !== null && hasRawVideoFrameCopyLayout(geometry, format, frameLayerCount);
}

/** Selects a native VideoFrame route; a codec only a GPU decoder package decodes has none. */
function getSDRVideoSelection(
    capabilities: CustomDecodeCapabilities,
    codec: CustomVideoCodec,
    stream: MediaStream,
    bitDepth: number
): SDRVideoSelection | null {
    return isCustomPackageVideoCodec(codec) ? null : getOrdinarySDRVideoSelection(capabilities, codec, stream, bitDepth);
}

function supportsRawHDRVideo(
    capabilities: CustomDecodeCapabilities,
    codec: CustomVideoCodec,
    stream: MediaStream,
    format: CustomDecodeRawVideoFrameFormat,
    frameLayerCount = RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT
): boolean {
    if (codec !== 'hevc' && codec !== 'vp9' && codec !== 'av1') {
        return false;
    }
    const capability = capabilities.rawHDRVideo[codec];
    return capability.status === 'supported'
        && capability.format === format
        && capability.bitDepth === stream.BitDepth
        && hasSupportedRawVideoProfile(codec, stream)
        && hasStreamRawVideoFrameCopyLayout(stream, format, frameLayerCount);
}

/** Creates a raw-plane route, which the browser's own decoder decodes. */
function createRawVideoOutputSelection(
    stream: MediaStream,
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat,
    hdr: boolean
): VideoOutputSelection {
    return {
        hdr,
        maximumCodedHeight: Number(stream.Height),
        maximumCodedWidth: Number(stream.Width),
        nativeVideoDecoderRequired: true,
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat,
        status: 'selected',
        videoDecoderBackend: 'native',
        videoOutputMode: 'raw-planes'
    };
}

/**
 * Selects raw planes for SDR that no VideoFrame route decodes: 10-bit 4:2:0 SDR in I420P10.
 * AV1 and VP9 decode it only this way, and HEVC Main 10 needs it without native decode.
 * Each matrix, primaries set, and range has its own raw SDR key.
 */
function selectRawSDRVideoOutput(
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    videoCodec: CustomVideoCodec,
    stream: MediaStream,
    colorMetadata: InputColorMetadata
): VideoOutputSelection | null {
    const rawVideoFrameFormat = getRawVideoFrameFormat(colorMetadata.bitDepth);
    if (eligibilityOptions.allowRawSDR !== true || rawVideoFrameFormat === null) {
        return null;
    }
    const routeKey = getRawHDRAuthorizationRouteKey(rawVideoFrameFormat, colorMetadata);
    if (
        routeKey === null
        || !(eligibilityOptions.authorizedRawHDRRouteKeys ?? []).includes(routeKey)
        || !supportsRawHDRVideo(capabilities, videoCodec, stream, rawVideoFrameFormat)
    ) {
        return null;
    }
    return createRawVideoOutputSelection(stream, rawVideoFrameFormat, false);
}

/** Selects an SDR route: a VideoFrame route first, then raw planes for 10-bit SDR that none of them decodes. */
function selectSDRVideoOutput(
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    videoCodec: CustomVideoCodec,
    stream: MediaStream,
    colorMetadata: InputColorMetadata
): VideoOutputSelection {
    const sdrSelection = getSDRVideoSelection(capabilities, videoCodec, stream, colorMetadata.bitDepth);
    if (!sdrSelection) {
        return selectRawSDRVideoOutput(
            capabilities,
            eligibilityOptions,
            videoCodec,
            stream,
            colorMetadata
        ) ?? { reason: 'codec-unsupported', status: 'invalid' };
    }
    return {
        hdr: false,
        maximumCodedHeight: sdrSelection.maximumCodedHeight,
        maximumCodedWidth: sdrSelection.maximumCodedWidth,
        nativeVideoDecoderRequired: true,
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat: null,
        status: 'selected',
        videoDecoderBackend: 'native',
        videoOutputMode: 'video-frame'
    };
}

function supportsNativeDolbyVisionProfile5(
    capabilities: CustomDecodeCapabilities,
    videoCodec: CustomVideoCodec,
    stream: MediaStream
): boolean {
    const capability = capabilities.nativeDolbyVisionHEVC;
    return videoCodec === 'hevc'
        && capability?.status === 'supported'
        && stream.BitDepth === capability.bitDepth
        && hasSupportedRawVideoProfile(videoCodec, stream)
        && isPositiveSafeInteger(stream.Width)
        && isPositiveSafeInteger(stream.Height);
}

function supportsNativeMain10HEVC(
    capability: CustomNativeHDRHEVCCapability | undefined,
    videoCodec: CustomVideoCodec,
    stream: MediaStream
): capability is CustomNativeHDRHEVCCapability {
    return videoCodec === 'hevc'
        && capability?.status === 'supported'
        && stream.BitDepth === capability.bitDepth
        && hasSupportedRawVideoProfile(videoCodec, stream)
        && isPositiveSafeInteger(stream.Width)
        && isPositiveSafeInteger(stream.Height);
}

/** Returns the native external HDR route's codec, whose decoder a native HDR probe qualified at the stream's depth and profile, or null. */
function getNativeHDRVideoCodec(
    capabilities: CustomDecodeCapabilities,
    videoCodec: CustomVideoCodec,
    stream: MediaStream
): ExternalHDRVideoCodec | null {
    switch (videoCodec) {
        case 'hevc':
            return supportsNativeMain10HEVC(capabilities.nativeHDRHEVC, videoCodec, stream) ? 'hevc' : null;
        case 'av1': {
            const capability = capabilities.nativeHDRAV1;
            return capability?.status === 'supported'
                && stream.BitDepth === capability.bitDepth
                && hasSupportedRawVideoProfile(videoCodec, stream)
                && isPositiveSafeInteger(stream.Width)
                && isPositiveSafeInteger(stream.Height) ?
                'av1' :
                null;
        }
        default:
            return null;
    }
}

/** The native HDR route rewrites the bitstream as BT.2020, so it needs a named BT.2020 HDR description */
function hasExplicitNativeHDRChromaticity(stream: MediaStream): boolean {
    return hasExplicitBT2020HDRColorDescription(stream);
}

function getAuthorizedDolbyVisionNativeBaseMetadata(
    options: unknown,
    eligibilityOptions: CustomPlaybackEligibilityOptions
): InputColorMetadata | null {
    const profile7Metadata = getDolbyVisionProfile7HDR10BaseColorMetadata(options);
    if (profile7Metadata !== null) {
        return eligibilityOptions.allowNativeDolbyVisionProfile7HDR10Base === true ?
            profile7Metadata :
            null;
    }
    const profile8HDR10Metadata = getDolbyVisionProfile8HDR10BaseColorMetadata(options);
    if (profile8HDR10Metadata !== null) {
        return eligibilityOptions.allowNativeDolbyVisionProfile8HDR10Base === true ?
            profile8HDR10Metadata :
            null;
    }
    const profile8HLGMetadata = getDolbyVisionProfile8HLGBaseColorMetadata(options);
    return profile8HLGMetadata !== null
        && eligibilityOptions.allowNativeDolbyVisionProfile8HLGBase === true ?
        profile8HLGMetadata :
        null;
}

/** Returns whether a range extension's exact variant capability passed for its format, bit depth, and chroma. */
function hasSupportedHEVCRangeExtensionVariant(
    capabilities: CustomDecodeCapabilities,
    definition: HEVCRangeExtensionProbeDefinition
): boolean {
    const capability = capabilities.hevcRangeExtensions?.[definition.variant];
    return capability?.status === 'supported'
        && capability.format === definition.format
        && capability.bitDepth === definition.bitDepth
        && capability.chromaFormat === definition.chromaFormat;
}

function selectHEVCRangeExtensionVideoOutput(
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    videoCodec: CustomVideoCodec,
    stream: MediaStream,
    colorMetadata: InputColorMetadata
): VideoOutputSelection | null {
    if (videoCodec !== 'hevc') {
        return null;
    }
    const definition = getHEVCRangeExtensionStreamDefinitionFromMetadata(stream);
    if (!definition) {
        return null;
    }
    const exactColorMetadata: InputColorMetadata = colorMetadata.bitDepth === definition.bitDepth ?
        colorMetadata :
        { ...colorMetadata, bitDepth: definition.bitDepth };
    if (!hasSupportedHEVCRangeExtensionVariant(capabilities, definition)) {
        return {
            reason: exactColorMetadata.transfer === 'sdr' ?
                'codec-unsupported' :
                'hdr-codec-unsupported',
            status: 'invalid'
        };
    }
    const geometry = getStreamRawVideoGeometry(stream);
    if (!geometry || !hasRawVideoFrameCopyLayout(
        geometry,
        definition.format,
        RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT
    )) {
        return { reason: 'metadata-unsupported', status: 'invalid' };
    }
    const hdr = exactColorMetadata.transfer !== 'sdr';
    const presentationAllowed = hdr ?
        eligibilityOptions.allowRawHDR :
        eligibilityOptions.allowRawSDR === true;
    const routeKey = getRawHDRAuthorizationRouteKey(definition.format, exactColorMetadata);
    if (
        !presentationAllowed
        || !routeKey
        || !(eligibilityOptions.authorizedRawHDRRouteKeys ?? []).includes(routeKey)
    ) {
        return {
            reason: hdr ? 'hdr-presentation-unavailable' : 'codec-unsupported',
            status: 'invalid'
        };
    }
    return {
        hdr,
        maximumCodedHeight: geometry.codedHeight,
        maximumCodedWidth: geometry.codedWidth,
        nativeVideoDecoderRequired: true,
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat: definition.format,
        status: 'selected',
        videoDecoderBackend: 'native',
        videoOutputMode: 'raw-planes'
    };
}

/** Returns whether an AV1 raw format's exact variant capability passed for its format, bit depth, and chroma. */
function hasSupportedAV1RawFormatVariant(
    capabilities: CustomDecodeCapabilities,
    definition: AV1RawFormatProbeDefinition
): boolean {
    const capability = capabilities.av1RawFormats?.[definition.variant];
    return capability?.status === 'supported'
        && capability.format === definition.format
        && capability.bitDepth === definition.bitDepth
        && capability.chromaFormat === definition.chromaFormat;
}

/** Returns the AV1 raw format variant of a stream outside Main: High 4:4:4, or Professional 4:2:2 or 12 bits. */
function getAV1RawFormatVariantDefinition(videoCodec: CustomVideoCodec, stream: MediaStream): AV1RawFormatProbeDefinition | null {
    if (videoCodec !== 'av1') {
        return null;
    }
    const definition = getAV1RawFormatStreamDefinitionFromMetadata(stream);
    return definition !== null && definition.jellyfinProfile !== AV1_MAIN_PROFILE_NAME ? definition : null;
}

/**
 * Selects raw planes in the exact format of AV1 outside Main, which no VideoFrame route decodes.
 * Such a stream never falls through to the Main routes, so without its variant capability or raw key a GPU decoder package may still take it.
 */
function selectAV1RawFormatVideoOutput(
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    videoCodec: CustomVideoCodec,
    stream: MediaStream,
    colorMetadata: InputColorMetadata
): VideoOutputSelection | null {
    const definition = getAV1RawFormatVariantDefinition(videoCodec, stream);
    if (!definition) {
        return null;
    }
    const exactColorMetadata: InputColorMetadata = { ...colorMetadata, bitDepth: definition.bitDepth };
    const hdr = exactColorMetadata.transfer !== 'sdr';
    if (!hasSupportedAV1RawFormatVariant(capabilities, definition) || !hasStreamRawVideoFrameCopyLayout(
        stream,
        definition.format,
        RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT
    )) {
        return { reason: hdr ? 'hdr-codec-unsupported' : 'codec-unsupported', status: 'invalid' };
    }
    const presentationAllowed = hdr ?
        eligibilityOptions.allowRawHDR === true :
        eligibilityOptions.allowRawSDR === true;
    const routeKey = getRawHDRAuthorizationRouteKey(definition.format, exactColorMetadata);
    if (!presentationAllowed || !routeKey || !(eligibilityOptions.authorizedRawHDRRouteKeys ?? []).includes(routeKey)) {
        return { reason: hdr ? 'hdr-presentation-unavailable' : 'codec-unsupported', status: 'invalid' };
    }
    return createRawVideoOutputSelection(stream, definition.format, hdr);
}

/** Selects an independently authorized native Dolby Vision compatible base route. */
function selectNativeDolbyVisionBaseOutput(
    options: unknown,
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    videoCodec: CustomVideoCodec,
    videoStream: MediaStream
): VideoOutputSelection | null {
    const colorMetadata = getAuthorizedDolbyVisionNativeBaseMetadata(options, eligibilityOptions);
    if (colorMetadata === null || eligibilityOptions.allowNativeHDR !== true) {
        return null;
    }
    const nativeHDRTransfer = colorMetadata.transfer === 'sdr' ?
        null :
        colorMetadata.transfer;
    if (nativeHDRTransfer === null) {
        return null;
    }

    const routeKey = getExternalHDRAuthorizationRouteKey('hevc', colorMetadata);
    if (
        routeKey === null
        || !(eligibilityOptions.authorizedExternalHDRRouteKeys ?? []).includes(routeKey)
        || !hasExplicitNativeHDRChromaticity(videoStream)
        || !supportsNativeMain10HEVC(capabilities.nativeHDRHEVC, videoCodec, videoStream)
    ) {
        return null;
    }

    return {
        hdr: true,
        maximumCodedHeight: Number(videoStream.Height),
        maximumCodedWidth: Number(videoStream.Width),
        nativeHDRTransfer,
        nativeVideoDecoderRequired: true,
        neutralizeHDRColorMetadata: true,
        rawVideoFrameFormat: null,
        status: 'selected',
        videoDecoderBackend: 'native',
        videoOutputMode: 'video-frame'
    };
}

/** Returns an HEVC base layer's raw format: its range extension's own, I420 for Main, or I420P10 for Main 10. */
function getHEVCDolbyVisionReconstructionFrameFormat(stream: MediaStream): CustomDecodeRawVideoFrameFormat | null {
    const rangeExtensionDefinition = getHEVCRangeExtensionStreamDefinitionFromMetadata(stream);
    if (rangeExtensionDefinition) {
        return rangeExtensionDefinition.format;
    }
    switch (stream.BitDepth) {
        case CUSTOM_NATIVE_VIDEO_BIT_DEPTH:
            return hasSupportedNativeVideoProfile('hevc', stream) ? 'I420' : null;
        case 10:
            return hasSupportedRawVideoProfile('hevc', stream) ? 'I420P10' : null;
        default:
            return null;
    }
}

/** Returns an AV1 base layer's raw format: I420P10 for Main at 10 bits, else its raw format variant's, such as I420 for Main at 8 bits or I444 for High. */
function getAV1DolbyVisionReconstructionFrameFormat(stream: MediaStream): CustomDecodeRawVideoFrameFormat | null {
    if (stream.BitDepth === 10 && hasSupportedRawVideoProfile('av1', stream)) {
        return 'I420P10';
    }
    return getAV1RawFormatStreamDefinitionFromMetadata(stream)?.format ?? null;
}

/** Returns whether a native raw route decodes an AV1 or VP9 stream's planes in a format: its raw format variant's capability, else the raw HDR capability. */
function supportsNativeRawVideoDecode(
    capabilities: CustomDecodeCapabilities,
    videoCodec: CustomVideoCodec,
    stream: MediaStream,
    format: CustomDecodeRawVideoFrameFormat
): boolean {
    const definition = videoCodec === 'av1' ? getAV1RawFormatStreamDefinitionFromMetadata(stream) : null;
    if (definition) {
        return definition.format === format
            && hasSupportedAV1RawFormatVariant(capabilities, definition)
            && hasStreamRawVideoFrameCopyLayout(stream, format, RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT);
    }
    return supportsRawHDRVideo(capabilities, videoCodec, stream, format);
}

/**
 * Returns the raw frame format that RPU reconstruction decodes a Dolby Vision base layer into.
 * An HEVC base layer keeps its own format, and so does an AV1 one: I420P10 for Main at 10 bits, or its raw format variant's.
 * AV1 carries a single-layer RPU only, so a dual-layer profile never reconstructs over AV1.
 */
function getDolbyVisionReconstructionFrameFormat(
    videoCodec: CustomVideoCodec,
    stream: MediaStream,
    dualLayer: boolean
): CustomDecodeRawVideoFrameFormat | null {
    switch (videoCodec) {
        case 'hevc':
            return getHEVCDolbyVisionReconstructionFrameFormat(stream);
        case 'av1':
            return dualLayer ? null : getAV1DolbyVisionReconstructionFrameFormat(stream);
        case 'h264':
        case 'jpeg2000':
        case 'mpeg1video':
        case 'mpeg2video':
        case 'vc1':
        case 'vp8':
        case 'vp9':
        case 'wmv3':
        case 'mpeg4':
        case 'h263':
        case 'msmpeg4v1':
        case 'msmpeg4v2':
        case 'msmpeg4v3':
            return null;
    }
}

/** Returns the raw frame format the presented stream's RPU route would decode, before capability checks. */
export function getDolbyVisionReconstructionRawFrameFormat(options: unknown): CustomDecodeRawVideoFrameFormat | null {
    const selection = getDolbyVisionPresentationSelection(options);
    if (!selection || selection.descriptor.reconstructionProfile === null) {
        return null;
    }
    const mediaStreams = (options as PlaybackOptions).mediaSource?.MediaStreams;
    if (!Array.isArray(mediaStreams)) {
        return null;
    }
    const videoStreams = mediaStreams.filter((stream: unknown): stream is MediaStream => (
        stream !== null
        && typeof stream === 'object'
        && normalizeMetadataValue((stream as MediaStream).Type) === 'VIDEO'
    ));
    const baseLayerStream = videoStreams[selection.baseLayerVideoTrackOrdinal];
    const videoCodec = baseLayerStream ?
        VIDEO_CODEC_ALIASES[normalizeMetadataValue(baseLayerStream.Codec) ?? ''] :
        undefined;
    return videoCodec ?
        getDolbyVisionReconstructionFrameFormat(
            videoCodec,
            baseLayerStream,
            isDolbyVisionDualLayerProfile(selection.descriptor.reconstructionProfile)
        ) :
        null;
}

/**
 * Returns the raw format a stream's raw-plane route decodes into, before capability checks: a range extension's or an AV1 raw format's exact variant,
 * else I420P10 or I420P12 for the profiles the raw HDR probes cover.
 */
function getRawVideoStreamFormat(codec: CustomVideoCodec, stream: MediaStream): CustomDecodeRawVideoFrameFormat | null {
    const exactDefinition = codec === 'hevc' ?
        getHEVCRangeExtensionStreamDefinitionFromMetadata(stream) :
        getAV1RawFormatVariantDefinition(codec, stream);
    if (exactDefinition) {
        return exactDefinition.format;
    }
    return hasSupportedRawVideoProfile(codec, stream) && typeof stream.BitDepth === 'number' ?
        getRawVideoFrameFormat(stream.BitDepth) :
        null;
}

/**
 * Returns the raw key the presented stream's raw-plane route needs, before capability checks, or null when the stream has no raw-plane route.
 * The stream's color, or a Dolby Vision stream's declared base, at the depth of its raw format names the key, so a host can wait for a key that
 * authorizes on first use before eligibility.
 */
export function getRawVideoPresentationRouteKey(options: unknown): RawHDRAuthorizationRouteKey | null {
    const mediaSource = options && typeof options === 'object' ? (options as PlaybackOptions).mediaSource : undefined;
    if (!mediaSource || typeof mediaSource !== 'object') {
        return null;
    }
    const selection = selectVideoStream(options, getStreams(mediaSource));
    if (selection.status !== 'selected') {
        return null;
    }
    const codec: CustomVideoCodec | undefined = VIDEO_CODEC_ALIASES[normalizeMetadataValue(selection.stream.Codec) ?? ''];
    const format = codec ? getRawVideoStreamFormat(codec, selection.stream) : null;
    const colorMetadata = getPresentationInputColorMetadata(options) ?? getDolbyVisionBaseColorMetadata(options);
    return format !== null && colorMetadata !== null ?
        getRawHDRAuthorizationRouteKey(format, { ...colorMetadata, bitDepth: getRawFormatBitDepth(format) }) :
        null;
}

/**
 * Returns whether a native raw route decodes an HEVC base layer's planes.
 * A range extension takes its exact variant capability, and Main 10 takes the raw HDR capability.
 * Main, the only I420 outside the range extensions, has no qualified native raw route.
 */
function supportsHEVCDolbyVisionReconstruction(
    capabilities: CustomDecodeCapabilities,
    stream: MediaStream,
    format: CustomDecodeRawVideoFrameFormat,
    frameLayerCount: number
): boolean {
    const rangeExtensionDefinition = getHEVCRangeExtensionStreamDefinitionFromMetadata(stream);
    if (rangeExtensionDefinition) {
        return hasSupportedHEVCRangeExtensionVariant(capabilities, rangeExtensionDefinition)
            && hasStreamRawVideoFrameCopyLayout(stream, format, frameLayerCount);
    }
    return format !== 'I420' && supportsRawHDRVideo(capabilities, 'hevc', stream, format, frameLayerCount);
}

/**
 * Returns the raw format a native decoder decodes a Dolby Vision base layer into for RPU reconstruction, or null when none does.
 * A dual-layer route reserves its EL even when the descriptor omits it, because the EL is found in-band.
 */
function getDolbyVisionReconstructionSourceFormat(
    capabilities: CustomDecodeCapabilities,
    videoCodec: CustomVideoCodec,
    stream: MediaStream,
    dualLayer: boolean
): CustomDecodeRawVideoFrameFormat | null {
    const format = getDolbyVisionReconstructionFrameFormat(videoCodec, stream, dualLayer);
    if (format === null) {
        return null;
    }
    const frameLayerCount = dualLayer ? RAW_VIDEO_DOLBY_VISION_FRAME_LAYER_COUNT : RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT;
    const supported = videoCodec === 'hevc' ?
        supportsHEVCDolbyVisionReconstruction(capabilities, stream, format, frameLayerCount) :
        supportsNativeRawVideoDecode(capabilities, videoCodec, stream, format);
    return supported ? format : null;
}

/** Returns whether the host authorized the profile's reconstruction for the stream's raw frame format. */
function isDolbyVisionReconstructionAllowed(
    reconstructionProfile: DolbyVisionReconstructionProfile,
    eligibilityOptions: CustomPlaybackEligibilityOptions
): boolean {
    switch (reconstructionProfile) {
        case 4:
            return eligibilityOptions.allowDolbyVisionProfile4 === true;
        case 7:
            return eligibilityOptions.allowDolbyVisionProfile7 === true;
        case 5:
        case 8:
            return eligibilityOptions.allowDolbyVision === true;
    }
}

/**
 * Selects raw-plane RPU reconstruction for any profile with an RPU route.
 * No decoder decodes a dual-layer EL, so a dual-layer route reconstructs from its BL alone: exactly for MEL, and as its base for FEL.
 */
function selectDolbyVisionReconstructionOutput(
    descriptor: DolbyVisionPresentationDescriptor,
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    videoCodec: CustomVideoCodec,
    videoStream: MediaStream
): VideoOutputSelection {
    const reconstructionProfile = descriptor.reconstructionProfile;
    if (reconstructionProfile === null) {
        return { reason: 'hdr-codec-unsupported', status: 'invalid' };
    }
    const presentationAllowed = isDolbyVisionReconstructionAllowed(reconstructionProfile, eligibilityOptions);
    const sourceFormat = getDolbyVisionReconstructionSourceFormat(
        capabilities,
        videoCodec,
        videoStream,
        isDolbyVisionDualLayerProfile(reconstructionProfile)
    );
    if (!presentationAllowed || sourceFormat === null) {
        return {
            reason: presentationAllowed ? 'hdr-codec-unsupported' : 'hdr-presentation-unavailable',
            status: 'invalid'
        };
    }
    return {
        dolbyVisionProfile: reconstructionProfile,
        hdr: true,
        maximumCodedHeight: Number(videoStream.Height),
        maximumCodedWidth: Number(videoStream.Width),
        nativeVideoDecoderRequired: true,
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat: sourceFormat,
        status: 'selected',
        videoDecoderBackend: 'native',
        videoOutputMode: 'raw-planes'
    };
}

/**
 * Selects RPU reconstruction of a Dolby Vision BL that a GPU decoder the host offers decodes into a frame pool.
 * The BL takes the raw RPU route's format, which the host's Dolby Vision key of that format authorizes, and the stream's own GPU decoder format must be it.
 * No decoder decodes an EL, so a dual-layer stream reconstructs from its BL alone, as on the raw route.
 * Without a fitting offer, a summary that decodes the codec into the format selects the route without a decoder, which only negotiation passes.
 */
function selectGPUDolbyVisionVideoOutput(
    options: unknown,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    videoCodec: CustomVideoCodec,
    videoStream: MediaStream,
    gpuVideoDecoderSummaries: readonly GPUVideoDecoderSummary[]
): VideoOutputSelection | null {
    const reconstructionProfile = getDolbyVisionPresentationDescriptor(options)?.reconstructionProfile ?? null;
    if (reconstructionProfile === null || !isDolbyVisionReconstructionAllowed(reconstructionProfile, eligibilityOptions)) {
        return null;
    }
    const format = getDolbyVisionReconstructionFrameFormat(videoCodec, videoStream, isDolbyVisionDualLayerProfile(reconstructionProfile));
    if (
        format === null
        || !isGPUDecoderOutputFormat(format)
        || getGPUDecodeOutputFormat(videoCodec, videoStream, { bitDepth: getGPUDecoderFormatFacts(format).bitDepth }) !== format
        || !isPositiveSafeInteger(videoStream.Width)
        || !isPositiveSafeInteger(videoStream.Height)
    ) {
        return null;
    }
    return selectGPUVideoDecoder(eligibilityOptions, videoCodec, videoStream, {
        dolbyVisionProfile: reconstructionProfile,
        hdr: true,
        maximumCodedHeight: videoStream.Height,
        maximumCodedWidth: videoStream.Width,
        nativeVideoDecoderRequired: false,
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat: format,
        status: 'selected',
        videoDecoderBackend: 'gpu',
        videoOutputMode: 'frame-pool'
    }, gpuVideoDecoderSummaries);
}

/**
 * Selects AV1 Profile 10's RPU reconstruction from the hardware decoder's frames, neutralized to limited BT.709, through the external route of the profile it reconstructs as.
 * The AV1 PQ external key proves the AV1 decoder's frames import exactly; the Profile 5 or 8 key proves the reconstruction.
 */
function selectNativeAV1DolbyVisionOutput(
    descriptor: DolbyVisionPresentationDescriptor,
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    videoCodec: CustomVideoCodec,
    videoStream: MediaStream
): VideoOutputSelection | null {
    const profile = descriptor.reconstructionProfile;
    if (profile !== 5 && profile !== 8) {
        return null;
    }
    const reconstructionAuthorized = profile === 5 ?
        eligibilityOptions.allowNativeDolbyVision === true :
        eligibilityOptions.allowNativeDolbyVisionProfile8 === true;
    if (
        !reconstructionAuthorized
        || descriptor.baseLayerBitDepth !== 10
        || getNativeHDRVideoCodec(capabilities, videoCodec, videoStream) !== 'av1'
        || !(eligibilityOptions.authorizedExternalHDRRouteKeys ?? []).includes(NATIVE_AV1_DOLBY_VISION_DECODE_ROUTE_KEY)
    ) {
        return null;
    }
    return {
        dolbyVisionProfile: profile,
        hdr: true,
        maximumCodedHeight: Number(videoStream.Height),
        maximumCodedWidth: Number(videoStream.Width),
        nativeVideoDecoderRequired: true,
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat: null,
        status: 'selected',
        videoDecoderBackend: 'native',
        videoOutputMode: 'video-frame'
    };
}

/**
 * Selects a Dolby Vision route in this order:
 * - native Profile 5 of HEVC;
 * - native Profile 5 or 8 reconstruction of AV1;
 * - the native compatible base of Profile 7 or 8;
 * - RPU reconstruction from raw planes;
 * - the base layer a compatibility ID declares, which the ordinary routes present, a GPU decoder's RPU reconstruction before the base's own GPU route;
 * - without a declared base, RPU reconstruction from a GPU decoder's frame pool.
 */
function selectDolbyVisionVideoOutput(
    options: unknown,
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    videoCodec: CustomVideoCodec,
    videoStream: MediaStream,
    gpuVideoDecoderSummaries: readonly GPUVideoDecoderSummary[]
): VideoOutputSelection | null {
    const descriptor = getDolbyVisionPresentationDescriptor(options);
    if (!descriptor) {
        return null;
    }
    if (
        descriptor.reconstructionProfile === 5
        && descriptor.baseLayerBitDepth === 10
        && eligibilityOptions.allowNativeDolbyVision === true
        && supportsNativeDolbyVisionProfile5(capabilities, videoCodec, videoStream)
    ) {
        const nativeCapability = capabilities.nativeDolbyVisionHEVC;
        if (!nativeCapability) {
            return { reason: 'hdr-codec-unsupported', status: 'invalid' };
        }
        return {
            dolbyVisionProfile: descriptor.reconstructionProfile,
            hdr: true,
            maximumCodedHeight: Number(videoStream.Height),
            maximumCodedWidth: Number(videoStream.Width),
            nativeVideoDecoderRequired: true,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            status: 'selected',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        };
    }

    const nativeAV1Selection = selectNativeAV1DolbyVisionOutput(descriptor, capabilities, eligibilityOptions, videoCodec, videoStream);
    if (nativeAV1Selection !== null) {
        return nativeAV1Selection;
    }

    const nativeBaseSelection = selectNativeDolbyVisionBaseOutput(
        options,
        capabilities,
        eligibilityOptions,
        videoCodec,
        videoStream
    );

    // Qualified compatible bases prefer native surface decode
    if (nativeBaseSelection !== null) {
        return nativeBaseSelection;
    }

    const reconstructionSelection = selectDolbyVisionReconstructionOutput(
        descriptor,
        capabilities,
        eligibilityOptions,
        videoCodec,
        videoStream
    );
    if (reconstructionSelection.status === 'selected') {
        return reconstructionSelection;
    }
    // A declared base layer is presented by the ordinary routes with its own color metadata
    if (getDolbyVisionBaseColorMetadata(options) !== null) {
        return null;
    }
    return selectGPUDolbyVisionVideoOutput(options, eligibilityOptions, videoCodec, videoStream, gpuVideoDecoderSummaries) ?? reconstructionSelection;
}

/** The planar format a GPU decoder writes for a stream: a range extension's own, else the one that holds its pixel format, else 4:2:0 at the stream's depth. */
function getGPUDecodeOutputFormat(
    videoCodec: CustomVideoCodec,
    stream: MediaStream,
    colorMetadata: Pick<InputColorMetadata, 'bitDepth'>
): GPUDecoderOutputFormat | null {
    const rangeExtensionDefinition = videoCodec === 'hevc' ? getHEVCRangeExtensionStreamDefinitionFromMetadata(stream) : null;
    if (rangeExtensionDefinition) {
        return rangeExtensionDefinition.format;
    }
    const pixelFormat = typeof stream.PixelFormat === 'string' && stream.PixelFormat.trim() !== '' ? stream.PixelFormat : null;
    if (pixelFormat === null) {
        // Without a pixel format, the stream is 4:2:0 at its bit depth
        switch (colorMetadata.bitDepth) {
            case 8:
                return 'I420';
            case 10:
                return 'I420P10';
            case 12:
                return 'I420P12';
            default:
                return null;
        }
    }
    // The pixel format names the chroma subsampling, such as 4:2:2 MPEG-2, and a format no frame pool holds, such as RGB, has no route
    const holding = getGPUDecoderPixelFormatHolding(pixelFormat);
    if (holding === null) {
        return null;
    }
    // An explicit BitDepth must agree with the pixel format's samples; without one, their depth stands if the transfer allows it
    const bitDepthAgrees = typeof stream.BitDepth === 'number' ?
        stream.BitDepth === holding.sampleBitDepth :
        holding.sampleBitDepth >= colorMetadata.bitDepth;
    return bitDepthAgrees ? holding.format : null;
}

/**
 * Selects a GPU decoder the host offers for the stream: the codec, the output format, the decoder's stream conditions over the pool's coded size,
 * and the device's limit on its frame pool, its state and scratch buffers, and its packet ring, so an offer the session would refuse is skipped.
 * A 4:0:0 stream, by its pixel format, goes only to a decoder whose header declares `monochrome`.
 * Its HDR needs the host's tone mapping; no presentation authorization gates it, and whether a package was verified is the host's choice.
 * Without a fitting offer, a summary that takes the stream selects the route without a decoder, which only negotiation passes.
 */
function selectGPUVideoOutput(
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    videoCodec: CustomVideoCodec,
    videoStream: MediaStream,
    colorMetadata: InputColorMetadata,
    gpuVideoDecoderSummaries: readonly GPUVideoDecoderSummary[]
): VideoOutputSelection | null {
    const format = getGPUDecodeOutputFormat(videoCodec, videoStream, colorMetadata);
    const hdr = colorMetadata.transfer !== 'sdr';
    if (
        format === null
        || (hdr && eligibilityOptions.allowFramePoolHDR !== true)
        || !isPositiveSafeInteger(videoStream.Width)
        || !isPositiveSafeInteger(videoStream.Height)
    ) {
        return null;
    }
    return selectGPUVideoDecoder(eligibilityOptions, videoCodec, videoStream, {
        hdr,
        maximumCodedHeight: videoStream.Height,
        maximumCodedWidth: videoStream.Width,
        nativeVideoDecoderRequired: false,
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat: format,
        status: 'selected',
        videoDecoderBackend: 'gpu',
        videoOutputMode: 'frame-pool'
    }, gpuVideoDecoderSummaries);
}

/**
 * Returns a frame-pool route with the first offer that decodes the stream's codec into the route's format and fits the device, else the route without a decoder
 * when a summary decodes the codec into the format, else null.
 */
function selectGPUVideoDecoder(
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    videoCodec: CustomVideoCodec,
    videoStream: MediaStream,
    route: Extract<VideoOutputSelection, { status: 'selected' }> & { maximumCodedHeight: number; maximumCodedWidth: number; rawVideoFrameFormat: GPUDecoderOutputFormat },
    gpuVideoDecoderSummaries: readonly GPUVideoDecoderSummary[]
): VideoOutputSelection | null {
    const format = route.rawVideoFrameFormat;
    const monochrome = typeof videoStream.PixelFormat === 'string' && isGPUDecoderMonochromePixelFormat(videoStream.PixelFormat);
    // The pool takes the picture padded to whole coding blocks, which the container's cropped size omits
    const stream = createGPUDecodeStreamFacts(route.maximumCodedWidth, route.maximumCodedHeight, format);
    for (const offer of eligibilityOptions.gpuVideoDecoders ?? []) {
        if (
            !offer.codecs.includes(videoCodec)
            || (monochrome && !offer.package.manifest.monochrome)
            || offer.format !== format
            || findGPUDecoderStreamFitFailure(offer.package.manifest, stream, format, offer.maximumBufferByteLength) !== null
        ) {
            continue;
        }
        return { ...route, gpuVideoDecoder: { codec: videoCodec, decoderId: offer.decoderId, package: offer.package } };
    }
    const summarized = gpuVideoDecoderSummaries.some((summary: GPUVideoDecoderSummary): boolean => (
        isGPUVideoDecoderSummaryFit(summary, videoCodec, format, route.maximumCodedWidth, route.maximumCodedHeight, monochrome)
    ));
    return summarized ? route : null;
}

/**
 * Selects the video route of a stream with color metadata.
 * A native WebCodecs route comes first, then a GPU decoder the host offers, then one it summarizes; a Dolby Vision stream's GPU decoder reconstructs its RPU when it can.
 */
function selectVideoOutput(
    options: unknown,
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    videoCodec: CustomVideoCodec,
    videoStream: MediaStream,
    gpuVideoDecoderSummaries: readonly GPUVideoDecoderSummary[]
): VideoOutputSelection {
    const dolbyVisionSelection = selectDolbyVisionVideoOutput(
        options,
        capabilities,
        eligibilityOptions,
        videoCodec,
        videoStream,
        gpuVideoDecoderSummaries
    );
    if (dolbyVisionSelection) {
        return dolbyVisionSelection;
    }
    const colorMetadata = getPresentationInputColorMetadata(options)
        ?? getDolbyVisionBaseColorMetadata(options);
    if (!colorMetadata) {
        return { reason: 'metadata-unsupported', status: 'invalid' };
    }
    const nativeSelection = selectColorVideoOutput(capabilities, eligibilityOptions, videoCodec, videoStream, colorMetadata);
    if (nativeSelection.status === 'selected') {
        return nativeSelection;
    }
    return selectGPUDolbyVisionVideoOutput(options, eligibilityOptions, videoCodec, videoStream, gpuVideoDecoderSummaries)
        ?? selectGPUVideoOutput(eligibilityOptions, videoCodec, videoStream, colorMetadata, gpuVideoDecoderSummaries)
        ?? nativeSelection;
}

/**
 * Selects the engine's own route for a stream's color: a range extension's or AV1 raw format's exact variant, then the SDR routes, then the HDR
 * routes.
 */
function selectColorVideoOutput(
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    videoCodec: CustomVideoCodec,
    videoStream: MediaStream,
    colorMetadata: InputColorMetadata
): VideoOutputSelection {
    const rangeExtensionSelection = selectHEVCRangeExtensionVideoOutput(
        capabilities,
        eligibilityOptions,
        videoCodec,
        videoStream,
        colorMetadata
    );
    const exactRawSelection = rangeExtensionSelection ?? selectAV1RawFormatVideoOutput(
        capabilities,
        eligibilityOptions,
        videoCodec,
        videoStream,
        colorMetadata
    );
    if (exactRawSelection) {
        return exactRawSelection;
    }
    const hdr = colorMetadata.transfer !== 'sdr';
    if (!hdr) {
        return selectSDRVideoOutput(capabilities, eligibilityOptions, videoCodec, videoStream, colorMetadata);
    }
    const nativeHDRVideoCodec = getNativeHDRVideoCodec(capabilities, videoCodec, videoStream);
    const externalHDRRouteKey = nativeHDRVideoCodec === null ? null : getExternalHDRAuthorizationRouteKey(nativeHDRVideoCodec, colorMetadata);
    const nativeHDRTransfer = colorMetadata.transfer === 'sdr' ?
        null :
        colorMetadata.transfer;
    if (
        eligibilityOptions.allowNativeHDR === true
        && externalHDRRouteKey !== null
        && (eligibilityOptions.authorizedExternalHDRRouteKeys ?? []).includes(externalHDRRouteKey)
        && nativeHDRTransfer !== null
        && hasExplicitNativeHDRChromaticity(videoStream)
    ) {
        return {
            hdr: true,
            maximumCodedHeight: Number(videoStream.Height),
            maximumCodedWidth: Number(videoStream.Width),
            nativeHDRTransfer,
            nativeVideoDecoderRequired: true,
            neutralizeHDRColorMetadata: true,
            rawVideoFrameFormat: null,
            status: 'selected',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        };
    }
    if (!eligibilityOptions.allowRawHDR) {
        return { reason: 'hdr-presentation-unavailable', status: 'invalid' };
    }

    const rawVideoFrameFormat = getRawVideoFrameFormat(colorMetadata.bitDepth);
    if (!rawVideoFrameFormat) {
        return { reason: 'metadata-unsupported', status: 'invalid' };
    }
    const rawHDRRouteKey = getRawHDRAuthorizationRouteKey(rawVideoFrameFormat, colorMetadata);
    if (!rawHDRRouteKey || !(eligibilityOptions.authorizedRawHDRRouteKeys ?? []).includes(rawHDRRouteKey)) {
        return { reason: 'hdr-presentation-unavailable', status: 'invalid' };
    }
    if (!supportsRawHDRVideo(capabilities, videoCodec, videoStream, rawVideoFrameFormat)) {
        return { reason: 'hdr-codec-unsupported', status: 'invalid' };
    }
    return createRawVideoOutputSelection(videoStream, rawVideoFrameFormat, true);
}

function parsePlaybackSource(
    options: unknown,
    runtimeAvailability: CustomPlaybackRuntimeAvailability
): PlaybackSourceParseResult {
    if (!runtimeAvailability.available) {
        return { eligible: false, parsed: false, reason: 'runtime-unavailable' };
    }
    if (!options || typeof options !== 'object') {
        return { eligible: false, parsed: false, reason: 'invalid-options' };
    }

    const playbackOptions = options as PlaybackOptions;
    if (normalizeMetadataValue(playbackOptions.playMethod) !== DIRECT_PLAY_METHOD) {
        return { eligible: false, parsed: false, reason: 'play-method-unsupported' };
    }
    const mediaSource = playbackOptions.mediaSource;
    if (!mediaSource || typeof mediaSource !== 'object') {
        return { eligible: false, parsed: false, reason: 'invalid-options' };
    }
    if (mediaSource.LiveStreamId || mediaSource.IsInfiniteStream === true) {
        return { eligible: false, parsed: false, reason: 'live-stream-unsupported' };
    }
    const containerTokens = getContainerTokens(mediaSource.Container);
    if (!containerTokens.some(container => (
        isCustomPlaybackContainer(container)
    ))) {
        return { eligible: false, parsed: false, reason: 'container-unsupported' };
    }

    const reportedDurationMicroseconds = ticksToMicroseconds(mediaSource.RunTimeTicks, null);
    // A missing or zero runtime only means the server never probed one; playback ends when the streams do
    const durationMicroseconds = reportedDurationMicroseconds !== null && reportedDurationMicroseconds > 0 ?
        reportedDurationMicroseconds :
        null;
    const startTimeMicroseconds = ticksToMicroseconds(playbackOptions.playerStartPositionTicks, 0);
    if (startTimeMicroseconds === null) {
        return { eligible: false, parsed: false, reason: 'invalid-options' };
    }

    if (!isCustomDecodeMediaSource(playbackOptions.source)) {
        return { eligible: false, parsed: false, reason: 'invalid-options' };
    }
    const source = resolvePlaybackMediaSource(playbackOptions.source);
    if (!source) {
        return { eligible: false, parsed: false, reason: 'url-unsupported' };
    }

    return {
        containerTokens,
        durationMicroseconds,
        mediaSource,
        parsed: true,
        source,
        startTimeMicroseconds,
        streams: getStreams(mediaSource)
    };
}

function selectVideoStream(options: unknown, streams: readonly MediaStream[]): VideoStreamSelection {
    const videoStreams: TypedStreamCandidate[] = [];
    for (let streamPosition = 0; streamPosition < streams.length; streamPosition += 1) {
        const stream = streams[streamPosition];
        if (normalizeMetadataValue(stream.Type) !== 'VIDEO') {
            continue;
        }
        const jellyfinStreamIndex = getJellyfinStreamIndex(stream, streamPosition);
        if (jellyfinStreamIndex === null) {
            return { status: 'invalid' };
        }
        videoStreams.push({
            jellyfinStreamIndex,
            stream
        });
    }

    const videoTrackOrdinal = getPresentationVideoTrackOrdinal(options);
    if (videoTrackOrdinal === null || videoTrackOrdinal >= videoStreams.length) {
        return { status: 'invalid' };
    }

    return {
        status: 'selected',
        stream: videoStreams[videoTrackOrdinal].stream,
        trackOrdinal: videoTrackOrdinal
    };
}

function selectPlaybackAudio(
    mediaSource: MediaSource,
    streams: readonly MediaStream[],
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    durationKnown: boolean
): PlaybackAudioSelection {
    const selectedAudio = getSelectedAudioStream(mediaSource, streams);
    if (selectedAudio.status === 'invalid') {
        return { reason: 'audio-track-invalid', status: 'invalid' };
    }
    if (selectedAudio.status === 'none') {
        return {
            audioCodec: null,
            audioOutputMode: null,
            audioSourceChannelCount: null,
            audioTrackIndex: null,
            status: 'selected'
        };
    }

    const audioCodec = AUDIO_CODEC_ALIASES.get(normalizeMetadataValue(selectedAudio.stream.Codec) ?? '');
    if (!audioCodec) {
        return { reason: 'audio-codec-unsupported', status: 'invalid' };
    }
    const audioOutput = selectAudioOutput(
        audioCodec,
        selectedAudio.stream,
        capabilities,
        eligibilityOptions,
        durationKnown
    );
    if (audioOutput.status === 'invalid') {
        return audioOutput;
    }
    return {
        audioCodec,
        ...(audioOutput.audioDecoder ? { audioDecoder: audioOutput.audioDecoder } : {}),
        audioOutputMode: audioOutput.outputMode,
        audioSourceChannelCount: Number(selectedAudio.stream.Channels),
        audioTrackIndex: selectedAudio.trackOrdinal,
        status: 'selected'
    };
}

function hasPotentialCustomVideoDimensions(stream: MediaStream): boolean {
    return isPositiveSafeInteger(stream.Width) && isPositiveSafeInteger(stream.Height);
}

/**
 * A codec only a decoder package decodes has no native route to rule out, so the host's packages and their headers decide at eligibility.
 * The container rules placed the codec already; FFmpeg names the VC-1 Advanced profile vc1 and the others wmv3, so a profile of the other codec has no route.
 * MPEG-4 Part 2, H.263, and MS-MPEG4 take every profile: the package's header refuses a deeper stream and its parser a Studio profile.
 */
function hasPotentialPackageVideoRoute(codec: CustomPackageVideoCodec, stream: MediaStream): boolean {
    switch (codec) {
        case 'vc1':
        case 'wmv3': {
            const profile = normalizeMetadataToken(stream.Profile);
            return profile === null || VC1_METADATA_PROFILES[codec].includes(profile);
        }
        case 'jpeg2000':
        case 'mpeg1video':
        case 'mpeg2video':
        case 'mpeg4':
        case 'h263':
        case 'msmpeg4v1':
        case 'msmpeg4v2':
        case 'msmpeg4v3':
            return true;
    }
}

/**
 * Returns whether a stream of a codec with native routes is a variant outside their ordinary routes, in the frame pool format given:
 * AV1 outside Main 4:2:0 at 8 or 10 bits, such as High 4:4:4, Professional 4:2:2, or 12-bit, which only its exact raw format or a decoder package
 * decodes, and 4:0:0 HEVC, which neither its native nor its range extension routes take.
 * The prefilter keeps such a stream potential, so the probes and the host's packages decide at eligibility.
 */
function isPackageOnlyVideoVariant(codec: CustomVideoCodec, stream: MediaStream, format: GPUDecoderOutputFormat): boolean {
    switch (codec) {
        case 'av1':
            return !hasSupportedNativeVideoProfile(codec, stream) || !NATIVE_AV1_OUTPUT_FORMATS.has(format);
        case 'hevc':
            return typeof stream.PixelFormat === 'string' && isGPUDecoderMonochromePixelFormat(stream.PixelFormat);
        default:
            return false;
    }
}

function hasPotentialSDRVideoRoute(
    codec: Exclude<CustomVideoCodec, CustomPackageVideoCodec>,
    stream: MediaStream,
    colorMetadata: InputColorMetadata
): boolean {
    // 10-bit 4:2:0 SDR has a raw I420P10 route, with a key for every matrix and primaries set; HEVC Main 10 also decodes natively
    if (colorMetadata.bitDepth === 10) {
        return hasSupportedRawVideoProfile(codec, stream) && hasPotentialCustomVideoDimensions(stream);
    }
    if (colorMetadata.bitDepth !== CUSTOM_NATIVE_VIDEO_BIT_DEPTH) {
        return false;
    }
    switch (codec) {
        case 'h264':
            return getH264ProfileFromJellyfinValue(stream.Profile) !== null
                && hasPotentialCustomVideoDimensions(stream);
        case 'av1':
        case 'hevc':
        case 'vp8':
        case 'vp9':
            return hasSupportedNativeVideoProfile(codec, stream)
                && hasPotentialCustomVideoDimensions(stream);
    }
}

function hasPotentialHDRVideoRoute(
    codec: CustomVideoCodec,
    stream: MediaStream,
    bitDepth: number
): boolean {
    return (bitDepth === 10 || bitDepth === 12)
        && hasSupportedRawVideoProfile(codec, stream)
        && hasPotentialCustomVideoDimensions(stream);
}

function hasCompletePotentialSDRVideoMetadata(stream: MediaStream): boolean {
    return isPositiveSafeInteger(stream.Width)
        && isPositiveSafeInteger(stream.Height)
        && normalizeMetadataToken(stream.Profile) !== null;
}

function hasCompletePotentialHDRVideoMetadata(stream: MediaStream): boolean {
    return normalizeMetadataToken(stream.Profile) !== null
        && isPositiveSafeInteger(stream.Width)
        && isPositiveSafeInteger(stream.Height);
}

type PotentialVideoCodecSelection =
    | { codec: CustomVideoCodec, status: 'selected' }
    | { status: 'unknown' | 'unsupported' };

function selectPotentialVideoCodec(
    stream: MediaStream,
    containerTokens: readonly string[]
): PotentialVideoCodecSelection {
    const normalizedCodec: string | null = normalizeMetadataValue(stream.Codec);
    if (!normalizedCodec) {
        return { status: 'unknown' };
    }
    const codec: CustomVideoCodec | undefined = VIDEO_CODEC_ALIASES[normalizedCodec];
    if (!codec || !supportsCustomContainerCodecCombination(containerTokens, codec, null)) {
        return { status: 'unsupported' };
    }
    return { codec, status: 'selected' };
}

function hasPotentialCustomVideoRoute(mediaSource: MediaSource): boolean {
    const containerTokens = getContainerTokens(mediaSource.Container);
    if (containerTokens.length === 0) {
        return true;
    }
    if (!containerTokens.some(isCustomPlaybackContainer)) {
        return false;
    }

    const playbackOptions = { mediaSource };
    const selectedVideo = selectVideoStream(playbackOptions, getStreams(mediaSource));
    if (selectedVideo.status === 'invalid') {
        return true;
    }

    const codecSelection: PotentialVideoCodecSelection = selectPotentialVideoCodec(
        selectedVideo.stream,
        containerTokens
    );
    if (codecSelection.status !== 'selected') {
        return codecSelection.status === 'unknown';
    }
    const codec: CustomVideoCodec = codecSelection.codec;
    if (codesInterlacedFieldsApart(codec, selectedVideo.stream)
        || hasUnsupportedRotation(selectedVideo.stream)) {
        return false;
    }

    const dolbyVisionDescriptor = getDolbyVisionPresentationDescriptor(playbackOptions);
    if (dolbyVisionDescriptor) {
        return hasPotentialDolbyVisionVideoRoute(
            playbackOptions,
            dolbyVisionDescriptor,
            codec,
            selectedVideo.stream
        );
    }
    return hasPotentialColorVideoRoute(
        getPresentationInputColorMetadata(playbackOptions),
        codec,
        selectedVideo.stream
    );
}

/** A Dolby Vision stream is potential through RPU reconstruction or through its declared base layer. */
function hasPotentialDolbyVisionVideoRoute(
    playbackOptions: { mediaSource: MediaSource },
    descriptor: DolbyVisionPresentationDescriptor,
    codec: CustomVideoCodec,
    stream: MediaStream
): boolean {
    if (!hasCompletePotentialHDRVideoMetadata(stream)) {
        return true;
    }
    if (
        descriptor.reconstructionProfile !== null
        && hasPotentialCustomVideoDimensions(stream)
        && getDolbyVisionReconstructionFrameFormat(
            codec,
            stream,
            isDolbyVisionDualLayerProfile(descriptor.reconstructionProfile)
        ) !== null
    ) {
        return true;
    }
    const baseColorMetadata = getDolbyVisionBaseColorMetadata(playbackOptions);
    return baseColorMetadata !== null && hasPotentialColorVideoRoute(
        baseColorMetadata,
        codec,
        stream
    );
}

/** Incomplete color or profile metadata stays potential; runtime probes decide later. */
function hasPotentialColorVideoRoute(
    colorMetadata: InputColorMetadata | null,
    codec: CustomVideoCodec,
    stream: MediaStream
): boolean {
    if (!colorMetadata) {
        return true;
    }
    if (isCustomPackageVideoCodec(codec)) {
        return hasPotentialPackageVideoRoute(codec, stream);
    }
    const packageFormat = getGPUDecodeOutputFormat(codec, stream, colorMetadata);
    if (packageFormat !== null && isPackageOnlyVideoVariant(codec, stream, packageFormat)) {
        return hasPotentialCustomVideoDimensions(stream);
    }
    const rangeExtensionDefinition = codec === 'hevc' ?
        getHEVCRangeExtensionStreamDefinitionFromMetadata(stream) :
        null;
    if (rangeExtensionDefinition) {
        return hasPotentialCustomVideoDimensions(stream)
            && (colorMetadata.transfer === 'sdr'
                || rangeExtensionDefinition.bitDepth >= 10);
    }
    if (colorMetadata.transfer === 'sdr') {
        if (!hasCompletePotentialSDRVideoMetadata(stream)) {
            return true;
        }
        return hasPotentialSDRVideoRoute(codec, stream, colorMetadata);
    }
    if (!hasCompletePotentialHDRVideoMetadata(stream)) {
        return true;
    }
    return hasPotentialHDRVideoRoute(codec, stream, colorMetadata.bitDepth);
}

function getCompletePlaybackSelectionMediaSources(sourceValues: readonly unknown[]): MediaSource[] | null {
    const sources: MediaSource[] = [];
    for (const sourceValue of sourceValues) {
        if (!sourceValue || typeof sourceValue !== 'object') {
            return null;
        }
        const source = sourceValue as MediaSource;
        if (!Array.isArray(source.MediaStreams)) {
            return null;
        }
        sources.push(source);
    }
    return sources.length > 0 ? sources : null;
}

function getRequestedPlaybackSelectionMediaSource(
    sourceValues: readonly unknown[],
    requestedMediaSourceId: string
): MediaSource[] | null {
    for (const sourceValue of sourceValues) {
        if (!sourceValue || typeof sourceValue !== 'object') {
            continue;
        }
        const source = sourceValue as MediaSource;
        if (source.Id !== requestedMediaSourceId) {
            continue;
        }
        return Array.isArray(source.MediaStreams) ? [ source ] : null;
    }
    return null;
}

function getPlaybackSelectionMediaSources(item: unknown, playOptions: unknown): MediaSource[] | null {
    if (!item || typeof item !== 'object') {
        return null;
    }

    const selectionItem = item as PlaybackSelectionItem;
    if (!Array.isArray(selectionItem.MediaSources)) {
        return Array.isArray(selectionItem.MediaStreams) ? [ selectionItem ] : null;
    }

    const requestedMediaSourceId = playOptions && typeof playOptions === 'object' ?
        (playOptions as PlaybackSelectionOptions).mediaSourceId :
        null;
    if (typeof requestedMediaSourceId === 'string' && requestedMediaSourceId.length > 0) {
        return getRequestedPlaybackSelectionMediaSource(selectionItem.MediaSources, requestedMediaSourceId);
    }
    return getCompletePlaybackSelectionMediaSources(selectionItem.MediaSources);
}

/**
 * Returns false only when item metadata proves every candidate video route is outside the custom decoder's structural envelope.
 * Player selection uses it as a metadata-only prefilter; runtime probes still make the final capability decision after selection.
 */
export function hasPotentialCustomPlaybackVideoRoute(item: unknown, playOptions?: unknown): boolean {
    const mediaSources = getPlaybackSelectionMediaSources(item, playOptions);
    if (!mediaSources) {
        return true;
    }
    return mediaSources.some(hasPotentialCustomVideoRoute);
}

/** The codec family and output format a GPU decoder would decode a playback's video into. */
export type GPUVideoDecodeTarget = Readonly<{
    codec: CustomVideoCodec
    format: GPUDecoderOutputFormat
}>;

/**
 * Returns the codec family and output format a GPU decoder would decode the options' presented video stream into, as the eligibility chooses them, or null when it has neither.
 * A Dolby Vision stream with an RPU route takes that route's format, so a stream without a declared base has a target too.
 * A host verifies only the decoders that match it before eligibility runs.
 */
export function getGPUVideoDecodeTarget(options: unknown): GPUVideoDecodeTarget | null {
    const mediaSource = options && typeof options === 'object' ? (options as { mediaSource?: unknown }).mediaSource : undefined;
    if (!mediaSource || typeof mediaSource !== 'object') {
        return null;
    }
    const selectedVideo = selectVideoStream(options, getStreams(mediaSource as MediaSource));
    if (selectedVideo.status === 'invalid') {
        return null;
    }
    const videoCodec = VIDEO_CODEC_ALIASES[normalizeMetadataValue(selectedVideo.stream.Codec) ?? ''];
    const reconstructionFormat = getDolbyVisionReconstructionRawFrameFormat(options);
    const colorMetadata = reconstructionFormat !== null && isGPUDecoderOutputFormat(reconstructionFormat) ?
        { bitDepth: getGPUDecoderFormatFacts(reconstructionFormat).bitDepth } :
        getPresentationInputColorMetadata(options) ?? getDolbyVisionBaseColorMetadata(options);
    if (!videoCodec || !colorMetadata) {
        return null;
    }
    const format = getGPUDecodeOutputFormat(videoCodec, selectedVideo.stream, colorMetadata);
    return format ? { codec: videoCodec, format } : null;
}

/**
 * Returns the codec of the audio track a playback of the options decodes, as the eligibility selects the track, or null when it selects none or the engine has no name for its codec.
 * A host fetches only the audio decoder packages that decode it before eligibility runs.
 */
export function getPlaybackAudioCodec(options: unknown): CustomAudioCodec | null {
    const mediaSource = options && typeof options === 'object' ? (options as { mediaSource?: unknown }).mediaSource : undefined;
    if (!mediaSource || typeof mediaSource !== 'object') {
        return null;
    }
    const selectedAudio = getSelectedAudioStream(mediaSource as MediaSource, getStreams(mediaSource as MediaSource));
    if (selectedAudio.status !== 'selected') {
        return null;
    }
    return AUDIO_CODEC_ALIASES.get(normalizeMetadataValue(selectedAudio.stream.Codec) ?? '') ?? null;
}

/**
 * Returns whether a media source's presented video stream has an eligible route, judged by the same video selection playback runs.
 * Audio, transport, and runtime availability are ignored.
 * GPU decoders are judged by summaries of the packages a playback could use, since offers exist only once a playback has its packages and its device;
 * a summary with its package's header and the device's buffer limit runs the offers' fit check on the stream.
 * Negotiation uses it to advertise one exact item whose range label no generic route covers.
 */
export function hasEligibleCustomVideoRoute(
    mediaSource: unknown,
    capabilities: CustomDecodeCapabilities,
    routeOptions: CustomVideoRouteOptions
): boolean {
    if (!mediaSource || typeof mediaSource !== 'object') {
        return false;
    }
    const options = { mediaSource };
    const selectedVideo = selectVideoStream(options, getStreams(mediaSource as MediaSource));
    if (selectedVideo.status === 'invalid') {
        return false;
    }
    const videoCodec = VIDEO_CODEC_ALIASES[normalizeMetadataValue(selectedVideo.stream.Codec) ?? ''];
    if (
        !videoCodec
        || hasUnsupportedRotation(selectedVideo.stream)
        || codesInterlacedFieldsApart(videoCodec, selectedVideo.stream)
    ) {
        return false;
    }
    const videoOutput = selectVideoOutput(
        options,
        capabilities,
        routeOptions as CustomPlaybackEligibilityOptions,
        videoCodec,
        selectedVideo.stream,
        routeOptions.gpuVideoDecoderSummaries ?? []
    );
    return videoOutput.status === 'selected' && !refusesVideoScan(videoOutput, selectedVideo.stream);
}

/** Returns the custom playback route for a direct-play VOD source, or the reason the probed pipeline cannot own it. */
export function getCustomPlaybackEligibility(
    options: unknown,
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions
): CustomPlaybackEligibility {
    const parsedSource = parsePlaybackSource(options, eligibilityOptions.runtimeAvailability);
    if (!parsedSource.parsed) {
        return { eligible: false, reason: parsedSource.reason };
    }

    const selectedVideo = selectVideoStream(options, parsedSource.streams);
    if (selectedVideo.status === 'invalid') {
        return { eligible: false, reason: 'video-track-unavailable' };
    }

    const normalizedVideoCodec = normalizeMetadataValue(selectedVideo.stream.Codec) ?? '';
    const videoCodec = VIDEO_CODEC_ALIASES[normalizedVideoCodec];
    if (!videoCodec) {
        return {
            eligible: false,
            reason: VIDEO_CODECS_WITHOUT_ROUTE.has(normalizedVideoCodec) ? 'video-codec-without-route' : 'codec-unsupported'
        };
    }
    if (hasUnsupportedRotation(selectedVideo.stream)) {
        return { eligible: false, reason: 'rotation-unsupported' };
    }
    if (codesInterlacedFieldsApart(videoCodec, selectedVideo.stream)) {
        return { eligible: false, reason: 'interlaced-video-unsupported' };
    }

    // A playback takes a GPU decoder only from an offer, which carries the package its session runs
    const videoOutput = selectVideoOutput(
        options,
        capabilities,
        eligibilityOptions,
        videoCodec,
        selectedVideo.stream,
        []
    );
    if (videoOutput.status === 'invalid') {
        return { eligible: false, reason: videoOutput.reason };
    }
    if (refusesVideoScan(videoOutput, selectedVideo.stream)) {
        return { eligible: false, reason: 'interlaced-video-unsupported' };
    }

    const audioSelection = selectPlaybackAudio(
        parsedSource.mediaSource,
        parsedSource.streams,
        capabilities,
        eligibilityOptions,
        parsedSource.durationMicroseconds !== null
    );
    if (audioSelection.status === 'invalid') {
        return { eligible: false, reason: audioSelection.reason };
    }
    const audioOutputMode = audioSelection.audioOutputMode;
    const audioSourceChannelCount = audioSelection.audioSourceChannelCount;
    const audioTrackIndex = audioSelection.audioTrackIndex;
    const selectedAudioCodec = audioSelection.audioCodec;
    if (!supportsCustomContainerCodecCombination(
        parsedSource.containerTokens,
        videoCodec,
        selectedAudioCodec
    )) {
        return { eligible: false, reason: 'container-unsupported' };
    }

    const runtimeRequirements: CustomPlaybackRuntimeRequirements = {
        audioOutput: audioOutputMode === 'decoded-pcm',
        // Mediabunny decodes PCM and a package decodes its codec, so only the other decoded PCM tracks need the browser's decoder
        nativeAudioDecoder: audioOutputMode === 'decoded-pcm'
            && selectedAudioCodec !== null
            && audioSelection.audioDecoder === undefined
            && !isCustomMediabunnyPCMAudioCodec(selectedAudioCodec),
        nativeVideoDecoder: videoOutput.nativeVideoDecoderRequired
    };
    const sourceRuntimeAvailability = getCustomPlaybackRuntimeAvailability(
        eligibilityOptions.runtimeAvailability.environment,
        runtimeRequirements
    );
    if (!sourceRuntimeAvailability.available) {
        return { eligible: false, reason: 'runtime-unavailable' };
    }

    return {
        ...(audioSelection.audioDecoder ? { audioDecoder: audioSelection.audioDecoder } : {}),
        audioOutputMode,
        audioSourceChannelCount,
        audioTrackIndex,
        durationMicroseconds: parsedSource.durationMicroseconds,
        dolbyVisionProfile: videoOutput.dolbyVisionProfile ?? null,
        eligible: true,
        ...getGPUVideoDecoderResult(videoOutput),
        hdr: videoOutput.hdr,
        maximumCodedHeight: videoOutput.maximumCodedHeight,
        maximumCodedWidth: videoOutput.maximumCodedWidth,
        ...getNativeHDRTransferResult(videoOutput),
        neutralizeHDRColorMetadata: videoOutput.neutralizeHDRColorMetadata,
        rawVideoFrameFormat: videoOutput.rawVideoFrameFormat,
        source: parsedSource.source,
        startTimeMicroseconds: parsedSource.startTimeMicroseconds,
        videoDecoderBackend: videoOutput.videoDecoderBackend,
        videoOutputMode: videoOutput.videoOutputMode,
        videoTrackIndex: selectedVideo.trackOrdinal
    };
}
