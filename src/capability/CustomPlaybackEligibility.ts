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
import type { InputColorMetadata } from '../color/ColorMetadata';
import {
    jellyfinTicksToMicroseconds,
    type Microseconds
} from '../MediaTime';
import {
    CUSTOM_BUNDLED_AUDIO_CODECS,
    CUSTOM_NATIVE_VIDEO_BIT_DEPTH,
    hasSupportedNativeSDRVideoCodec,
    type CustomAudioCodec,
    type CustomDecodeCapabilities,
    type CustomNativeHDRHEVCCapability,
    type CustomNativeSurroundAudioCodecCapability,
    type CustomRawHDRVideoCodec,
    type CustomRawHDRVideoCodecCapability,
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
    isSupportedDTSInputRoute,
    isSupportedEAC3InputRoute,
    isSupportedTrueHDMetadataRoute
} from '../audio/CustomCompressedAudioRoute';
import {
    getH264ProfileFromJellyfinValue,
    supportsH264JellyfinProfile
} from './H264ProfileCapabilities';
import {
    getExternalHDRAuthorizationRouteKey,
    type ExternalHDRAuthorizationRouteKey
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
import { requireMicroseconds } from '../TimeMath';
import {
    hasRawVideoFrameCopyLayout,
    RAW_VIDEO_DOLBY_VISION_FRAME_LAYER_COUNT,
    RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT,
    type RawVideoFrameGeometry
} from '../video/RawVideoFrameCopy';
import {
    getHEVCRangeExtensionStreamDefinitionFromMetadata,
    type HEVCRangeExtensionProbeDefinition
} from './HEVCRangeExtensionCapabilities';

const DIRECT_PLAY_METHOD = 'DIRECTPLAY';
const BUNDLED_AUDIO_CODEC_SET = new Set<CustomAudioCodec>(CUSTOM_BUNDLED_AUDIO_CODECS);
const VIDEO_CODEC_ALIASES: Readonly<Record<string, CustomVideoCodec>> = {
    AVC: 'h264',
    AVC1: 'h264',
    AV1: 'av1',
    H264: 'h264',
    H265: 'hevc',
    HEVC: 'hevc',
    J2K: 'jpeg2000',
    'JPEG 2000': 'jpeg2000',
    JPEG2000: 'jpeg2000',
    'MPEG-2': 'mpeg2video',
    MPEG2: 'mpeg2video',
    MPEG2VIDEO: 'mpeg2video',
    'VC-1': 'vc1',
    VC1: 'vc1',
    VP8: 'vp8',
    VP9: 'vp9'
};

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
    url?: unknown
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
    startTimeMicroseconds: Microseconds
    streams: MediaStream[]
    url: string
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
        discardDolbyVisionEnhancementLayer?: true
        dolbyVisionProfile?: DolbyVisionReconstructionProfile
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

function getDiscardedEnhancementLayerResult(
    videoOutput: Extract<VideoOutputSelection, { status: 'selected' }>
): Pick<EligibleCustomPlayback, 'discardDolbyVisionEnhancementLayer'> {
    return videoOutput.discardDolbyVisionEnhancementLayer ?
        { discardDolbyVisionEnhancementLayer: true } :
        {};
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
    | 'video-track-unavailable';

export type CustomPlaybackEligibilityOptions = {
    /** Single-layer RPU reconstruction is authorized for the stream's raw frame format. */
    allowDolbyVision?: boolean
    /** Profile 4 reconstruction is authorized for the stream's raw frame format. */
    allowDolbyVisionProfile4?: boolean
    /** Profile 7 reconstruction is authorized for the stream's raw frame format. */
    allowDolbyVisionProfile7?: boolean
    allowNativeDolbyVision?: boolean
    allowNativeDolbyVisionProfile7HDR10Base?: boolean
    allowNativeDolbyVisionProfile8HDR10Base?: boolean
    allowNativeDolbyVisionProfile8HLGBase?: boolean
    allowNativeHDR?: boolean
    allowRawHDR: boolean
    allowRawSDR?: boolean
    authorizedExternalHDRRouteKeys?: readonly ExternalHDRAuthorizationRouteKey[]
    authorizedRawHDRRouteKeys?: readonly RawHDRAuthorizationRouteKey[]
    nativeMediaAudioCapabilities?: NativeMediaAudioCapabilities | null
    runtimeAvailability: CustomPlaybackRuntimeAvailability
};

export type EligibleCustomPlayback = {
    audioOutputMode: CustomDecodeAudioOutputMode | null
    audioSourceChannelCount: number | null
    /** Zero-based ordinal within container audio tracks, not MediaStream.Index. */
    audioTrackIndex: number | null
    /**
     * Set when a dual-layer route reconstructs without its EL, because no qualified decoder decodes it.
     * MEL still reconstructs exactly, and FEL presents its base.
     */
    discardDolbyVisionEnhancementLayer?: true
    /** Null when the server has no runtime for the source */
    durationMicroseconds: Microseconds | null
    dolbyVisionProfile: DolbyVisionReconstructionProfile | null
    eligible: true
    hdr: boolean
    maximumCodedHeight: number
    maximumCodedWidth: number
    nativeHDRTransfer?: Exclude<CustomDecodeNativeHDRTransfer, null>
    neutralizeHDRColorMetadata: boolean
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    startTimeMicroseconds: Microseconds
    url: string
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

function getHTTPURL(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim()) {
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
    if (codec === 'eac3') {
        return isSupportedEAC3InputRoute(stream.Channels, stream.SampleRate, stream.ChannelLayout);
    }
    if (codec === 'dts') {
        const profile = normalizeMetadataToken(stream.Profile);
        if (capabilities.bundledDTS?.status !== 'supported') {
            return false;
        }
        return isSupportedDTSInputRoute(stream.Channels, stream.SampleRate, profile, stream.ChannelLayout);
    }
    if (codec === 'mlp' || codec === 'truehd') {
        const exactCapability = capabilities.bundledTrueHD;
        return exactCapability?.status === 'supported'
            && exactCapability.channelBedOnly
            && exactCapability.objectAudioRendered === false
            && exactCapability.passthrough === false
            && exactCapability.codecs.includes(codec)
            && isSupportedTrueHDMetadataRoute(
                codec,
                stream.Channels,
                stream.SampleRate,
                stream.ChannelLayout
            );
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
        case 'ac3':
            return true;
        case 'aac':
        case 'flac':
        case 'opus':
        case 'vorbis': {
            const surroundCapability: CustomNativeSurroundAudioCodecCapability | undefined =
                capabilities.nativeSurroundAudio?.[codec];
            return surroundCapability?.status === 'supported'
                && surroundCapability.inputChannelCount === stream.Channels;
        }
        case 'mp3':
            return false;
    }
}

function selectAudioOutput(
    codec: CustomAudioCodec,
    stream: MediaStream,
    capabilities: CustomDecodeCapabilities,
    nativeMediaAudioCapabilities: NativeMediaAudioCapabilities | null | undefined,
    durationKnown: boolean
): AudioOutputSelection {
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

function hasSupportedBundledHEVCProfile(
    capabilities: CustomDecodeCapabilities,
    profile: 'main' | 'main10'
): boolean {
    return Object.values(capabilities.bundledHEVC?.qualifications ?? {}).some(qualification => (
        qualification.profile === profile && qualification.status === 'supported'
    ));
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
        case 'mpeg2video':
        case 'vc1':
        case 'jpeg2000':
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
        case 'mpeg2video':
        case 'vc1':
        case 'vp8':
            return false;
    }
}

type SDRVideoSelection = {
    maximumCodedHeight: number
    maximumCodedWidth: number
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
};

function getJPEG2000SDRVideoSelection(
    capabilities: CustomDecodeCapabilities,
    stream: MediaStream,
    bitDepth: number
): SDRVideoSelection | null {
    const capability = capabilities.bundledJPEG2000;
    if (
        capability?.status !== 'supported'
        || capability.bitDepth !== bitDepth
        || !isPositiveSafeInteger(stream.Width)
        || !isPositiveSafeInteger(stream.Height)
    ) {
        return null;
    }
    return {
        maximumCodedHeight: Number(stream.Height),
        maximumCodedWidth: Number(stream.Width),
        videoDecoderBackend: 'openjpeg'
    };
}

function getMPEG2VC1SDRSelection(
    capabilities: CustomDecodeCapabilities,
    codec: 'mpeg2video' | 'vc1',
    stream: MediaStream,
    bitDepth: number
): SDRVideoSelection | null {
    const capability = codec === 'vc1' ?
        capabilities.bundledVC1 :
        capabilities.bundledMPEG2;
    const requiredProfile = codec === 'vc1' ? 'ADVANCED' : 'MAIN';
    if (
        capability?.status !== 'supported'
        || bitDepth !== CUSTOM_NATIVE_VIDEO_BIT_DEPTH
        || normalizeMetadataToken(stream.Profile) !== requiredProfile
        || !isPositiveSafeInteger(stream.Width)
        || !isPositiveSafeInteger(stream.Height)
    ) {
        return null;
    }
    return {
        maximumCodedHeight: Number(stream.Height),
        maximumCodedWidth: Number(stream.Width),
        videoDecoderBackend: 'ffmpeg-mpeg2-vc1'
    };
}

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
            maximumCodedWidth: stream.Width,
            videoDecoderBackend: 'native'
        } : null;
    }
    if (bitDepth !== CUSTOM_NATIVE_VIDEO_BIT_DEPTH || !hasSupportedNativeVideoProfile('hevc', stream)) {
        return null;
    }
    if (hasSupportedNativeSDRVideoCodec('hevc', capabilities)) {
        return {
            maximumCodedHeight: stream.Height,
            maximumCodedWidth: stream.Width,
            videoDecoderBackend: 'native'
        };
    }
    if (!hasSupportedBundledHEVCProfile(capabilities, 'main')) {
        return null;
    }
    return {
        maximumCodedHeight: stream.Height,
        maximumCodedWidth: stream.Width,
        videoDecoderBackend: 'bundled-hevc'
    };
}

function getOrdinarySDRVideoSelection(
    capabilities: CustomDecodeCapabilities,
    codec: Exclude<CustomVideoCodec, 'jpeg2000' | 'mpeg2video' | 'vc1'>,
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
        maximumCodedWidth,
        videoDecoderBackend: 'native'
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

function getSDRVideoSelection(
    capabilities: CustomDecodeCapabilities,
    codec: CustomVideoCodec,
    stream: MediaStream,
    bitDepth: number
): SDRVideoSelection | null {
    if (codec === 'jpeg2000') {
        return getJPEG2000SDRVideoSelection(capabilities, stream, bitDepth);
    }
    if (codec === 'mpeg2video' || codec === 'vc1') {
        return getMPEG2VC1SDRSelection(capabilities, codec, stream, bitDepth);
    }
    return getOrdinarySDRVideoSelection(capabilities, codec, stream, bitDepth);
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
    if (capability.status !== 'supported'
        || capability.format !== format
        || capability.bitDepth !== stream.BitDepth
        || !hasSupportedRawVideoProfile(codec, stream)
        || !hasStreamRawVideoFrameCopyLayout(stream, format, frameLayerCount)) {
        return false;
    }
    if (capability.reason !== 'bundled-software-decoder') {
        return true;
    }
    return hasSupportedBundledHEVCProfile(capabilities, 'main10');
}

/** Returns the decoder behind a raw capability: the bundled HEVC decoder when it qualified, else native. */
function getRawVideoDecoderBackend(capability: CustomRawHDRVideoCodecCapability): CustomDecodeVideoDecoderBackend {
    return capability.reason === 'bundled-software-decoder' ? 'bundled-hevc' : 'native';
}

/** Creates a raw-plane route decoded by a codec's raw capability. */
function createRawVideoOutputSelection(
    capability: CustomRawHDRVideoCodecCapability,
    stream: MediaStream,
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat,
    hdr: boolean
): VideoOutputSelection {
    const videoDecoderBackend = getRawVideoDecoderBackend(capability);
    return {
        hdr,
        maximumCodedHeight: Number(stream.Height),
        maximumCodedWidth: Number(stream.Width),
        nativeVideoDecoderRequired: videoDecoderBackend === 'native',
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat,
        status: 'selected',
        videoDecoderBackend,
        videoOutputMode: 'raw-planes'
    };
}

/**
 * Selects raw planes for SDR that no VideoFrame route decodes: 10-bit 4:2:0 SDR in I420P10.
 * AV1 and VP9 decode it only this way, and HEVC Main 10 needs it without native decode.
 * The raw SDR keys are BT.709 only, so BT.601 and BT.2020 SDR have no raw route.
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
    return createRawVideoOutputSelection(
        capabilities.rawHDRVideo[videoCodec as CustomRawHDRVideoCodec],
        stream,
        rawVideoFrameFormat,
        false
    );
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
        nativeVideoDecoderRequired: sdrSelection.videoDecoderBackend === 'native',
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat: null,
        status: 'selected',
        videoDecoderBackend: sdrSelection.videoDecoderBackend,
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

    const routeKey = getExternalHDRAuthorizationRouteKey(colorMetadata);
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

type DolbyVisionReconstructionSource = {
    format: CustomDecodeRawVideoFrameFormat
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
};

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

/**
 * Returns the raw frame format that RPU reconstruction decodes a Dolby Vision base layer into.
 * An HEVC base layer keeps its own format, and AV1 Main at 10 bits decodes to I420P10.
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
            return !dualLayer && stream.BitDepth === 10 && hasSupportedRawVideoProfile(videoCodec, stream) ?
                'I420P10' :
                null;
        case 'h264':
        case 'jpeg2000':
        case 'mpeg2video':
        case 'vc1':
        case 'vp8':
        case 'vp9':
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
 * Returns the decoder of an HEVC base layer's raw planes.
 * A range extension takes its exact variant capability, and Main 10 takes the raw HDR capability.
 * Main takes the bundled decoder's Main qualification, since it has no qualified native raw route.
 */
function getHEVCDolbyVisionReconstructionSource(
    capabilities: CustomDecodeCapabilities,
    stream: MediaStream,
    format: CustomDecodeRawVideoFrameFormat,
    frameLayerCount: number
): DolbyVisionReconstructionSource | null {
    const rangeExtensionDefinition = getHEVCRangeExtensionStreamDefinitionFromMetadata(stream);
    if (rangeExtensionDefinition) {
        return hasSupportedHEVCRangeExtensionVariant(capabilities, rangeExtensionDefinition)
            && hasStreamRawVideoFrameCopyLayout(stream, format, frameLayerCount) ?
            { format, videoDecoderBackend: 'native' } :
            null;
    }
    // Outside the range extensions only HEVC Main is I420
    if (format === 'I420') {
        return hasSupportedBundledHEVCProfile(capabilities, 'main')
            && hasStreamRawVideoFrameCopyLayout(stream, format, frameLayerCount) ?
            { format, videoDecoderBackend: 'bundled-hevc' } :
            null;
    }
    return supportsRawHDRVideo(capabilities, 'hevc', stream, format, frameLayerCount) ?
        { format, videoDecoderBackend: getRawVideoDecoderBackend(capabilities.rawHDRVideo.hevc) } :
        null;
}

/**
 * Returns the decoder of a Dolby Vision base layer's raw planes for RPU reconstruction.
 * A dual-layer route reserves its EL even when the descriptor omits it, because the EL is found in-band.
 */
function getDolbyVisionReconstructionSource(
    capabilities: CustomDecodeCapabilities,
    videoCodec: CustomVideoCodec,
    stream: MediaStream,
    dualLayer: boolean
): DolbyVisionReconstructionSource | null {
    const format = getDolbyVisionReconstructionFrameFormat(videoCodec, stream, dualLayer);
    if (format === null) {
        return null;
    }
    if (videoCodec === 'hevc') {
        return getHEVCDolbyVisionReconstructionSource(
            capabilities,
            stream,
            format,
            dualLayer ? RAW_VIDEO_DOLBY_VISION_FRAME_LAYER_COUNT : RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT
        );
    }
    // AV1 decodes natively; the bundled decoder is HEVC only
    return supportsRawHDRVideo(capabilities, videoCodec, stream, format) ?
        { format, videoDecoderBackend: 'native' } :
        null;
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

/** Selects raw-plane RPU reconstruction for any profile with an RPU route. */
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
    const source = getDolbyVisionReconstructionSource(
        capabilities,
        videoCodec,
        videoStream,
        isDolbyVisionDualLayerProfile(reconstructionProfile)
    );
    if (!presentationAllowed || !source) {
        return {
            reason: presentationAllowed ? 'hdr-codec-unsupported' : 'hdr-presentation-unavailable',
            status: 'invalid'
        };
    }
    // The bundled HEVC decoder decodes every dual-layer EL.
    // Without its Main 10 qualification the route reconstructs from the BL alone: exactly for MEL, and as its base for FEL
    const discardEnhancementLayer = isDolbyVisionDualLayerProfile(reconstructionProfile)
        && !hasSupportedBundledHEVCProfile(capabilities, 'main10');
    return {
        ...(discardEnhancementLayer ? { discardDolbyVisionEnhancementLayer: true as const } : {}),
        dolbyVisionProfile: reconstructionProfile,
        hdr: true,
        maximumCodedHeight: Number(videoStream.Height),
        maximumCodedWidth: Number(videoStream.Width),
        nativeVideoDecoderRequired: source.videoDecoderBackend === 'native',
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat: source.format,
        status: 'selected',
        videoDecoderBackend: source.videoDecoderBackend,
        videoOutputMode: 'raw-planes'
    };
}

/**
 * Selects a Dolby Vision route in this order:
 * - native Profile 5;
 * - the native compatible base of Profile 7 or 8;
 * - RPU reconstruction;
 * - the base layer a compatibility ID declares, which the ordinary routes present.
 */
function selectDolbyVisionVideoOutput(
    options: unknown,
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    videoCodec: CustomVideoCodec,
    videoStream: MediaStream
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
    return getDolbyVisionBaseColorMetadata(options) === null ? reconstructionSelection : null;
}

function selectVideoOutput(
    options: unknown,
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    videoCodec: CustomVideoCodec,
    videoStream: MediaStream
): VideoOutputSelection {
    const dolbyVisionSelection = selectDolbyVisionVideoOutput(
        options,
        capabilities,
        eligibilityOptions,
        videoCodec,
        videoStream
    );
    if (dolbyVisionSelection) {
        return dolbyVisionSelection;
    }
    const colorMetadata = getPresentationInputColorMetadata(options)
        ?? getDolbyVisionBaseColorMetadata(options);
    if (!colorMetadata) {
        return { reason: 'metadata-unsupported', status: 'invalid' };
    }
    const rangeExtensionSelection = selectHEVCRangeExtensionVideoOutput(
        capabilities,
        eligibilityOptions,
        videoCodec,
        videoStream,
        colorMetadata
    );
    if (rangeExtensionSelection) {
        return rangeExtensionSelection;
    }
    const hdr = colorMetadata.transfer !== 'sdr';
    if (!hdr) {
        return selectSDRVideoOutput(capabilities, eligibilityOptions, videoCodec, videoStream, colorMetadata);
    }
    const externalHDRRouteKey = getExternalHDRAuthorizationRouteKey(colorMetadata);
    const nativeHDRTransfer = colorMetadata.transfer === 'sdr' ?
        null :
        colorMetadata.transfer;
    const nativeHDRCapability = capabilities.nativeHDRHEVC;
    if (
        eligibilityOptions.allowNativeHDR === true
        && externalHDRRouteKey !== null
        && (eligibilityOptions.authorizedExternalHDRRouteKeys ?? []).includes(externalHDRRouteKey)
        && nativeHDRTransfer !== null
        && hasExplicitNativeHDRChromaticity(videoStream)
        && supportsNativeMain10HEVC(nativeHDRCapability, videoCodec, videoStream)
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
    return createRawVideoOutputSelection(
        capabilities.rawHDRVideo[videoCodec as CustomRawHDRVideoCodec],
        videoStream,
        rawVideoFrameFormat,
        true
    );
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

    const url = getHTTPURL(playbackOptions.url);
    if (!url) {
        return { eligible: false, parsed: false, reason: 'url-unsupported' };
    }

    return {
        containerTokens,
        durationMicroseconds,
        mediaSource,
        parsed: true,
        startTimeMicroseconds,
        streams: getStreams(mediaSource),
        url
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
    nativeMediaAudioCapabilities: NativeMediaAudioCapabilities | null | undefined,
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
        nativeMediaAudioCapabilities,
        durationKnown
    );
    if (audioOutput.status === 'invalid') {
        return audioOutput;
    }
    return {
        audioCodec,
        audioOutputMode: audioOutput.outputMode,
        audioSourceChannelCount: Number(selectedAudio.stream.Channels),
        audioTrackIndex: selectedAudio.trackOrdinal,
        status: 'selected'
    };
}

function hasPotentialCustomVideoDimensions(stream: MediaStream): boolean {
    return isPositiveSafeInteger(stream.Width) && isPositiveSafeInteger(stream.Height);
}

function hasPotentialSDRVideoRoute(
    codec: CustomVideoCodec,
    stream: MediaStream,
    containerTokens: readonly string[],
    colorMetadata: InputColorMetadata
): boolean {
    // 10-bit 4:2:0 SDR has a raw I420P10 route, whose keys are BT.709 only; HEVC Main 10 also decodes natively
    if (colorMetadata.bitDepth === 10) {
        return hasSupportedRawVideoProfile(codec, stream)
            && hasPotentialCustomVideoDimensions(stream)
            && (codec === 'hevc' || getRawHDRAuthorizationRouteKey('I420P10', colorMetadata) !== null);
    }
    if (colorMetadata.bitDepth !== CUSTOM_NATIVE_VIDEO_BIT_DEPTH) {
        return false;
    }
    switch (codec) {
        case 'mpeg2video':
        case 'vc1':
            return containerTokens.some(container => container === 'MKV' || container === 'MATROSKA')
                && normalizeMetadataToken(stream.Profile) === (codec === 'vc1' ? 'ADVANCED' : 'MAIN')
                && hasPotentialCustomVideoDimensions(stream);
        case 'jpeg2000':
            return containerTokens.some(container => container === 'MJ2' || container === 'MOV')
                && hasPotentialCustomVideoDimensions(stream);
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

function hasCompletePotentialSDRVideoMetadata(codec: CustomVideoCodec, stream: MediaStream): boolean {
    if (!isPositiveSafeInteger(stream.Width) || !isPositiveSafeInteger(stream.Height)) {
        return false;
    }
    switch (codec) {
        case 'jpeg2000':
        case 'mpeg2video':
        case 'vc1':
            return codec === 'jpeg2000' || normalizeMetadataToken(stream.Profile) !== null;
        case 'av1':
        case 'h264':
        case 'hevc':
        case 'vp8':
        case 'vp9':
            return normalizeMetadataToken(stream.Profile) !== null;
    }
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
    if (selectedVideo.stream.IsInterlaced === true
        || hasUnsupportedRotation(selectedVideo.stream)) {
        return false;
    }
    if (selectedVideo.stream.IsInterlaced !== false) {
        return true;
    }

    const dolbyVisionDescriptor = getDolbyVisionPresentationDescriptor(playbackOptions);
    if (dolbyVisionDescriptor) {
        return hasPotentialDolbyVisionVideoRoute(
            playbackOptions,
            dolbyVisionDescriptor,
            codec,
            selectedVideo.stream,
            containerTokens
        );
    }
    return hasPotentialColorVideoRoute(
        getPresentationInputColorMetadata(playbackOptions),
        codec,
        selectedVideo.stream,
        containerTokens
    );
}

/** A Dolby Vision stream is potential through RPU reconstruction or through its declared base layer. */
function hasPotentialDolbyVisionVideoRoute(
    playbackOptions: { mediaSource: MediaSource },
    descriptor: DolbyVisionPresentationDescriptor,
    codec: CustomVideoCodec,
    stream: MediaStream,
    containerTokens: readonly string[]
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
        stream,
        containerTokens
    );
}

/** Incomplete color or profile metadata stays potential; runtime probes decide later. */
function hasPotentialColorVideoRoute(
    colorMetadata: InputColorMetadata | null,
    codec: CustomVideoCodec,
    stream: MediaStream,
    containerTokens: readonly string[]
): boolean {
    if (!colorMetadata) {
        return true;
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
        if (!hasCompletePotentialSDRVideoMetadata(codec, stream)) {
            return true;
        }
        return hasPotentialSDRVideoRoute(codec, stream, containerTokens, colorMetadata);
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

/**
 * Returns whether a media source's presented video stream has an eligible route, judged by the same video selection playback runs.
 * Audio, transport, and runtime availability are ignored.
 * Negotiation uses it to advertise one exact item whose range label no generic route covers.
 */
export function hasEligibleCustomVideoRoute(
    mediaSource: unknown,
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: Omit<CustomPlaybackEligibilityOptions, 'runtimeAvailability'>
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
        || selectedVideo.stream.IsInterlaced !== false
    ) {
        return false;
    }
    return selectVideoOutput(
        options,
        capabilities,
        eligibilityOptions as CustomPlaybackEligibilityOptions,
        videoCodec,
        selectedVideo.stream
    ).status === 'selected';
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

    const videoCodec = VIDEO_CODEC_ALIASES[normalizeMetadataValue(selectedVideo.stream.Codec) ?? ''];
    if (!videoCodec) {
        return { eligible: false, reason: 'codec-unsupported' };
    }
    if (hasUnsupportedRotation(selectedVideo.stream)) {
        return { eligible: false, reason: 'rotation-unsupported' };
    }
    if (selectedVideo.stream.IsInterlaced !== false) {
        return { eligible: false, reason: 'interlaced-video-unsupported' };
    }

    const videoOutput = selectVideoOutput(
        options,
        capabilities,
        eligibilityOptions,
        videoCodec,
        selectedVideo.stream
    );
    if (videoOutput.status === 'invalid') {
        return { eligible: false, reason: videoOutput.reason };
    }

    const audioSelection = selectPlaybackAudio(
        parsedSource.mediaSource,
        parsedSource.streams,
        capabilities,
        eligibilityOptions.nativeMediaAudioCapabilities,
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
        nativeAudioDecoder: audioOutputMode === 'decoded-pcm'
            && selectedAudioCodec !== null
            && !BUNDLED_AUDIO_CODEC_SET.has(selectedAudioCodec),
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
        audioOutputMode,
        audioSourceChannelCount,
        audioTrackIndex,
        ...getDiscardedEnhancementLayerResult(videoOutput),
        durationMicroseconds: parsedSource.durationMicroseconds,
        dolbyVisionProfile: videoOutput.dolbyVisionProfile ?? null,
        eligible: true,
        hdr: videoOutput.hdr,
        maximumCodedHeight: videoOutput.maximumCodedHeight,
        maximumCodedWidth: videoOutput.maximumCodedWidth,
        ...getNativeHDRTransferResult(videoOutput),
        neutralizeHDRColorMetadata: videoOutput.neutralizeHDRColorMetadata,
        rawVideoFrameFormat: videoOutput.rawVideoFrameFormat,
        startTimeMicroseconds: parsedSource.startTimeMicroseconds,
        url: parsedSource.url,
        videoDecoderBackend: videoOutput.videoDecoderBackend,
        videoOutputMode: videoOutput.videoOutputMode,
        videoTrackIndex: selectedVideo.trackOrdinal
    };
}
