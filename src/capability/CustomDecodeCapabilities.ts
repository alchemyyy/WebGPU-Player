import {
    createRawHDRCapabilityVector,
    RAW_HDR_CAPABILITY_VECTOR_CODED_HEIGHT,
    RAW_HDR_CAPABILITY_VECTOR_CODED_WIDTH
} from './vectors/RawHDRCapabilityVectors';
import H264ProfileCapabilityProbe, { describeH264ProfileProbeSteps, type H264ProfileCapabilities } from './H264ProfileCapabilities';
import { fetchCapabilityAsset } from './CapabilityAssetLoading';
import CapabilityProbeStore, {
    getDefaultCapabilityProbeStore,
    hasCapabilityProbeTimeout,
    isDefinitiveCapabilityProbeResult
} from './CapabilityProbeStore';
import { CAPABILITY_PROBE_TIMEOUT, type CapabilityProbeBackgroundRun, type CapabilityProbeQueue } from './CapabilityProbeManager';
import CapabilityProbeSession, { CapabilityProbeBlock, type RecordedCapabilityProbeQueue } from './CapabilityProbeSession';
import {
    describeAudioConfigCheck,
    describeAudioDecode,
    describeVideoConfigCheck,
    describeVideoDecode,
    getLargestCapabilityProbeStepCost,
    type AudioCapabilityProbeStep,
    type CapabilityProbeStep,
    type VideoCapabilityProbeStep
} from './CapabilityProbeSteps';
import { readBrowserIdentity, type BrowserIdentity } from './BrowserDefects';
import { canHoldVideoFrameFormat } from './VideoFrameFormatSupport';
import { MICROSECONDS_PER_SECOND } from '../MediaTime';
import { createHEVCExactCapabilityAccessUnit } from './vectors/HEVCExactCapabilityVectors';
import {
    getCustomDecodeHardwareAcceleration,
    type CustomDecodeRawVideoFrameFormat
} from '../pipeline/DecodeWorkerProtocol';
import {
    getHEVCRangeExtensionNegotiationVariants,
    HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS,
    HEVC_RANGE_EXTENSION_VARIANTS,
    type HEVCRangeExtensionCapability,
    type HEVCRangeExtensionProbeDefinition,
    type HEVCRangeExtensionVariant
} from './HEVCRangeExtensionCapabilities';
import {
    AV1_RAW_FORMAT_PROBE_DEFINITIONS,
    AV1_RAW_FORMAT_VARIANTS,
    getAV1RawFormatStreamDefinitionFromMetadata,
    type AV1RawFormatCapability,
    type AV1RawFormatProbeDefinition,
    type AV1RawFormatVariant
} from './AV1RawFormatCapabilities';
import {
    H264_RAW_FORMAT_PROBE_DEFINITIONS,
    H264_RAW_FORMAT_VARIANTS,
    getH264RawFormatNegotiationVariants,
    type H264RawFormatCapability,
    type H264RawFormatProbeDefinition,
    type H264RawFormatVariant
} from './H264RawFormatCapabilities';
import {
    getPresentationInputColorMetadata,
    isKnownSDRPresentationInput
} from '../presentation/PresentationInput';
import {
    createNativeAudioCapabilityVector,
    type NativeAudioCapabilityVector
} from './vectors/NativeAudioCapabilityVectors';
import {
    createNativeSurroundAudioCapabilityVector,
    NATIVE_SURROUND_AUDIO_CAPABILITY_VECTOR_CHANNEL_COUNT,
    NATIVE_SURROUND_AUDIO_CAPABILITY_VECTOR_CODECS,
    NATIVE_SURROUND_AUDIO_CAPABILITY_VECTOR_SAMPLE_RATE,
    type NativeSurroundAudioCapabilityVector
} from './vectors/NativeSurroundAudioCapabilityVectors';
import {
    createNativeSevenPointOneAudioCapabilityVector,
    NATIVE_SEVEN_POINT_ONE_AUDIO_CAPABILITY_VECTOR_CHANNEL_COUNT,
    NATIVE_SEVEN_POINT_ONE_AUDIO_CAPABILITY_VECTOR_CODECS,
    type NativeSevenPointOneAudioCapabilityVector
} from './vectors/NativeSevenPointOneAudioCapabilityVectors';
import { matchesNativeAudioChannelTones, type NativeAudioChannelTone } from './NativeAudioChannelTones';
import { copyAudioDataPlanes } from './AudioDataPlanes';
import {
    createNativeUltraHDVideoCapabilityVector,
    NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODECS,
    type NativeUltraHDVideoCapabilityVector
} from './vectors/NativeUltraHDVideoCapabilityVectors';
import { createNativeVideoCapabilityVector } from './vectors/NativeVideoCapabilityVectors';
import type {
    CustomAudioCodec,
    CustomMediabunnyPCMAudioCodec,
    CustomPackageAudioCodec,
    CustomWebCodecsAudioCodec
} from '../audio/CustomAudioCodec';
import { resolveEngineAssetURL, type EngineLibraryPath } from '../EngineAssets';

export {
    CUSTOM_AUDIO_CODECS,
    CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS,
    CUSTOM_PACKAGE_AUDIO_CODECS,
    CUSTOM_WEB_CODECS_AUDIO_CODECS,
    type CustomAudioCodec,
    type CustomMediabunnyPCMAudioCodec,
    type CustomPackageAudioCodec,
    type CustomWebCodecsAudioCodec
} from '../audio/CustomAudioCodec';

export const CUSTOM_VIDEO_CODECS = [
    'h264',
    'hevc',
    'vp8',
    'vp9',
    'av1',
    // FFmpeg's codec for MPEG-1 video, which its MPEG-2 decoder's code decodes under its own codec ID
    'mpeg1video',
    'mpeg2video',
    'vc1',
    // FFmpeg's codec for the VC-1 Simple and Main profiles, which its VC-1 decoder decodes under its own codec ID
    'wmv3',
    'jpeg2000',
    // MPEG-4 Part 2 (DivX, Xvid), H.263, and the Microsoft MPEG-4 variants FFmpeg names apart from it, which one decoder package decodes
    'mpeg4',
    'h263',
    'msmpeg4v1',
    'msmpeg4v2',
    'msmpeg4v3'
] as const;
/** The video codecs no browser decodes, which only a host's GPU decoder package plays. */
export const CUSTOM_PACKAGE_VIDEO_CODECS = [
    'mpeg1video',
    'mpeg2video',
    'vc1',
    'wmv3',
    'jpeg2000',
    'mpeg4',
    'h263',
    'msmpeg4v1',
    'msmpeg4v2',
    'msmpeg4v3'
] as const satisfies readonly (typeof CUSTOM_VIDEO_CODECS[number])[];
export const CUSTOM_RAW_HDR_VIDEO_CODECS = [ 'hevc', 'vp9', 'av1' ] as const;
export const CUSTOM_NATIVE_SURROUND_AUDIO_CODECS = NATIVE_SURROUND_AUDIO_CAPABILITY_VECTOR_CODECS;
export const CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS = NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODECS;
export const CUSTOM_NATIVE_VIDEO_BIT_DEPTH = 8;
const NATIVE_SDR_VIDEO_VECTOR_CODED_HEIGHT = 1_080;
const NATIVE_SDR_VIDEO_VECTOR_CODED_WIDTH = 1_920;
const NATIVE_DOLBY_VISION_HEVC_VECTOR_CODED_HEIGHT = 2_160;
const NATIVE_DOLBY_VISION_HEVC_VECTOR_CODED_WIDTH = 3_840;
const NATIVE_HDR_HEVC_VECTOR_CODED_HEIGHT = 2_160;
const NATIVE_HDR_HEVC_VECTOR_CODED_WIDTH = 3_840;
const JPEG2000_CODEC_STRING = 'mjp2';

export type CustomVideoCodec = typeof CUSTOM_VIDEO_CODECS[number];
export type CustomPackageVideoCodec = typeof CUSTOM_PACKAGE_VIDEO_CODECS[number];
export type CustomRawHDRVideoCodec = typeof CUSTOM_RAW_HDR_VIDEO_CODECS[number];

const CUSTOM_PACKAGE_VIDEO_CODEC_SET: ReadonlySet<CustomVideoCodec> = new Set<CustomVideoCodec>(CUSTOM_PACKAGE_VIDEO_CODECS);

/** Returns whether only a decoder package decodes a video codec. */
export function isCustomPackageVideoCodec(codec: CustomVideoCodec): codec is CustomPackageVideoCodec {
    return CUSTOM_PACKAGE_VIDEO_CODEC_SET.has(codec);
}
export type CustomNativeSurroundAudioCodec = typeof CUSTOM_NATIVE_SURROUND_AUDIO_CODECS[number];
export type CustomNativeUltraHDVideoCodec = typeof CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS[number];
export type CustomDecodeCodec = CustomAudioCodec | CustomVideoCodec;
// A probe outside the negotiated item's selection is not probed, which is never a verdict
export type CustomDecodeCapabilityStatus = 'not-probed' | 'supported' | 'unsupported' | 'unknown';
export type CustomDecodeCapabilityReason =
    | 'api-unavailable'
    | 'config-supported'
    | 'config-unsupported'
    | 'decode-output-missing'
    | 'decode-output-verified'
    // Mediabunny decodes the codec itself, as it does PCM
    | 'mediabunny-decoder'
    // Neither the browser's decoders nor Mediabunny decode the codec; a media element or a decoder package may still play it
    | 'no-engine-decoder'
    | 'not-probed'
    | 'probe-exception'
    | 'probe-timeout'
    // The step never ran: a declared browser defect crashes it, or it stopped an earlier page alone
    | 'browser-defect'
    | 'stopped-page';

/** The audio probes, which every item runs because a playing item can switch to any of its audio tracks. */
export const CUSTOM_DECODE_AUDIO_PROBES = [
    'native-audio',
    'native-surround-audio',
    'native-seven-point-one-audio'
] as const;

// The codecs whose ordinary SDR route has a decoded-output vector; H.264 qualifies per profile instead
type NativeSDRVideoProbeCodec = 'av1' | 'hevc' | 'vp8' | 'vp9';

export type CustomDecodeAudioProbe = typeof CUSTOM_DECODE_AUDIO_PROBES[number];
export type CustomDecodeVideoProbe =
    | 'h264-profiles'
    | 'native-dolby-vision-hevc'
    | 'native-hdr-av1'
    | 'native-hdr-hevc'
    | `av1-raw-format:${AV1RawFormatVariant}`
    | `h264-raw-format:${H264RawFormatVariant}`
    | `hevc-range-extension:${HEVCRangeExtensionVariant}`
    | `native-sdr:${NativeSDRVideoProbeCodec}`
    | `native-ultra-hd:${CustomNativeUltraHDVideoCodec}`
    | `raw:${CustomRawHDRVideoCodec}`;
export type CustomDecodeProbe = CustomDecodeAudioProbe | CustomDecodeVideoProbe;
export type CustomDecodeProbeState = 'not-probed' | 'probed';

export type CustomDecodeCodecCapability<Codec extends CustomDecodeCodec> = {
    codec: Codec
    codecString: string
    reason: CustomDecodeCapabilityReason
    status: CustomDecodeCapabilityStatus
};

export type CustomDecodeProbeReason =
    | 'api-unavailable'
    | 'complete'
    | 'partial-api'
    | 'probe-exceptions';

export type CustomDecodeProbeTelemetry = {
    audioProbeCount: number
    mediabunnyAudioCodecCount: number
    nativeSurroundAudioProbeCount: number
    nativeHDRVideoProbeCount: number
    nativeUltraHDVideoProbeCount: number
    rawHDRVideoProbeCount: number
    reason: CustomDecodeProbeReason
    supportedAudioCodecCount: number
    supportedNativeSurroundAudioCodecCount: number
    supportedNativeHDRVideoCodecCount: number
    supportedNativeUltraHDVideoCodecCount: number
    supportedRawHDRVideoCodecCount: number
    supportedVideoCodecCount: number
    unknownAudioCodecCount: number
    unknownNativeSurroundAudioCodecCount: number
    unknownNativeHDRVideoCodecCount: number
    unknownNativeUltraHDVideoCodecCount: number
    unknownVideoCodecCount: number
    videoProbeCount: number
};

export type CustomDecodeCapabilities = {
    audio: Readonly<Record<CustomAudioCodec, CustomDecodeCodecCapability<CustomAudioCodec>>>
    /** The exact raw formats of AV1 outside Main 10, each a probe of its own; AV1 Main 10 qualifies through `rawHDRVideo.av1` */
    av1RawFormats?: Readonly<Record<AV1RawFormatVariant, AV1RawFormatCapability>>
    h264Profiles?: H264ProfileCapabilities
    /** The exact raw formats of H.264 beyond 8-bit 4:2:0, each a probe of its own */
    h264RawFormats?: Readonly<Record<H264RawFormatVariant, H264RawFormatCapability>>
    hevcRangeExtensions?: Readonly<Record<HEVCRangeExtensionVariant, HEVCRangeExtensionCapability>>
    nativeDolbyVisionHEVC?: CustomNativeDolbyVisionHEVCCapability
    nativeHDRAV1?: CustomNativeHDRAV1Capability
    nativeHDRHEVC?: CustomNativeHDRHEVCCapability
    /** The 5.1 verdicts of the WebCodecs codecs, from 5.1 silence vectors */
    nativeSurroundAudio?: Readonly<Record<CustomNativeSurroundAudioCodec, CustomNativeSurroundAudioCodecCapability>>
    /** The 7.1 verdicts of the same codecs, kept apart from their 5.1 verdicts: 8-channel tone vectors that also prove WAVE 7.1 plane order */
    nativeSevenPointOneAudio?: Readonly<Record<CustomNativeSurroundAudioCodec, CustomNativeSurroundAudioCodecCapability>>
    nativeUltraHDVideo?: Readonly<Record<CustomNativeUltraHDVideoCodec, CustomNativeUltraHDVideoCodecCapability>>
    /**
     * Whether this result ran each probe.
     * A probe outside the item's selection is not probed: its status entries read `not-probed`, and its H.264 result is omitted.
     */
    probeStates?: Readonly<Record<CustomDecodeProbe, CustomDecodeProbeState>>
    rawHDRVideo: Readonly<Record<CustomRawHDRVideoCodec, CustomRawHDRVideoCodecCapability>>
    telemetry: Readonly<CustomDecodeProbeTelemetry>
    video: Readonly<Record<CustomVideoCodec, CustomDecodeCodecCapability<CustomVideoCodec>>>
};

/** A WebCodecs codec's surround verdict for one input layout: 6 channels (5.1) or 8 (7.1). */
export type CustomNativeSurroundAudioCodecCapability = CustomDecodeCodecCapability<CustomNativeSurroundAudioCodec> & {
    inputChannelCount: typeof NATIVE_SURROUND_AUDIO_CAPABILITY_VECTOR_CHANNEL_COUNT
        | typeof NATIVE_SEVEN_POINT_ONE_AUDIO_CAPABILITY_VECTOR_CHANNEL_COUNT
    sampleRate: typeof NATIVE_SURROUND_AUDIO_CAPABILITY_VECTOR_SAMPLE_RATE
};

export type CustomNativeUltraHDVideoCodecCapability = CustomDecodeCodecCapability<CustomNativeUltraHDVideoCodec> & {
    bitDepth: typeof CUSTOM_NATIVE_VIDEO_BIT_DEPTH
};

/** Returns whether an exact SDR output vector qualified the native codec route. */
export function hasSupportedNativeSDRVideoCodec(
    codec: CustomNativeUltraHDVideoCodec,
    capabilities: Pick<CustomDecodeCapabilities, 'nativeUltraHDVideo' | 'video'>
): boolean {
    return capabilities.video[codec].status === 'supported'
        || capabilities.nativeUltraHDVideo?.[codec].status === 'supported';
}

export type CustomNativeDolbyVisionHEVCCapability = CustomDecodeCodecCapability<'hevc'> & {
    bitDepth: 10
    profile: 5
};

export type CustomNativeHDRHEVCCapability = CustomDecodeCodecCapability<'hevc'> & {
    bitDepth: 10
};

/** AV1 Main at 10 bits decoded to the hardware decoder's opaque frames, which the native external HDR route presents. */
export type CustomNativeHDRAV1Capability = CustomDecodeCodecCapability<'av1'> & {
    bitDepth: 10
};

export type CustomRawHDRVideoCapabilityReason =
    | 'api-unavailable'
    | 'config-unsupported'
    | 'not-probed'
    | 'output-copy-supported'
    | 'output-copy-unsupported'
    | 'probe-exception'
    | 'probe-timeout'
    | 'runtime-unavailable'
    // The step never ran: a declared browser defect crashes it, or it stopped an earlier page alone
    | 'browser-defect'
    | 'stopped-page';

export type CustomRawHDRVideoCodecCapability = {
    bitDepth: 10
    codec: CustomRawHDRVideoCodec
    codecString: string
    format: 'I420P10'
    reason: CustomRawHDRVideoCapabilityReason
    status: CustomDecodeCapabilityStatus
};

export type RawHDRVideoOutputProbeRequest = {
    codec: CustomRawHDRVideoCodec | 'h264'
    configuration: VideoDecoderConfig
    encodedChunks: readonly Readonly<{
        data: Uint8Array
        timestamp: number
        type: 'delta' | 'key'
    }>[]
    expectedCodedHeight: number
    expectedCodedWidth: number
    // In output order, which is presentation order
    expectedDecodedFrames: readonly Readonly<{
        fingerprint: number
        timestamp: number
    }>[]
    expectedFormat: CustomDecodeRawVideoFrameFormat
};

export type RawHDRVideoOutputProbe = (
    probeRequest: RawHDRVideoOutputProbeRequest
) => Promise<RawHDRVideoOutputProbeResult>;

export type RawHDRVideoOutputProbeResult = Readonly<{
    outputCopySupported: boolean
}>;

export type NativeDolbyVisionVideoOutputProbeRequest = {
    configuration: VideoDecoderConfig
    encodedKeyFrame: Uint8Array
    expectedCodedHeight: number
    expectedCodedWidth: number
};

export type NativeDolbyVisionVideoOutputProbe = (
    probeRequest: NativeDolbyVisionVideoOutputProbeRequest
) => Promise<NativeDolbyVisionVideoOutputProbeResult>;

export type NativeDolbyVisionVideoOutputProbeResult = Readonly<{
    outputSupported: boolean
}>;

export type NativeVideoOutputProbeRequest = {
    codec: CustomVideoCodec
    configuration: VideoDecoderConfig
    encodedKeyFrame: Uint8Array
    expectedCodedHeight: number
    expectedCodedWidth: number
    expectedDisplayHeight: number
    expectedDisplayWidth: number
    expectedTimestamp: number
};

export type NativeVideoOutputProbe = (probeRequest: NativeVideoOutputProbeRequest) => Promise<boolean>;

type NativeAudioOutputProbeRequestBase = {
    codec: CustomWebCodecsAudioCodec
    configuration: AudioDecoderConfig
    encodedChunks: readonly Readonly<{
        data: Uint8Array
        duration: number
        timestamp: number
    }>[]
    expectedNumberOfChannels: number
    expectedSampleRate: number
};

/** A silence vector expects one exact silent AudioData. */
export type NativeAudioSilenceOutputProbeRequest = NativeAudioOutputProbeRequestBase & {
    channelTones?: undefined
    expectedNumberOfFrames: number
    expectedTimestamp: number
};

/** A tone vector expects its source channels' tones, one per decoded plane in source order, across every AudioData it decodes to. */
export type NativeAudioToneOutputProbeRequest = NativeAudioOutputProbeRequestBase & {
    channelTones: readonly NativeAudioChannelTone[]
};

export type NativeAudioOutputProbeRequest = NativeAudioSilenceOutputProbeRequest | NativeAudioToneOutputProbeRequest;

export type NativeAudioOutputProbe = (probeRequest: NativeAudioOutputProbeRequest) => Promise<boolean>;

type RawHDRVideoFrameCopyToOptions = Omit<VideoFrameCopyToOptions, 'format'> & {
    format: CustomDecodeRawVideoFrameFormat
};

/** Downloads a range-extension vector; a background probe asks for low priority. */
export type HEVCRangeExtensionVectorLoader = (assetPath: EngineLibraryPath, priority: RequestPriority) => Promise<ArrayBuffer>;

export type WebCodecsCapabilityEnvironment = {
    audioDecoder?: Pick<typeof AudioDecoder, 'isConfigSupported'> | null
    av1RawFormatVectorLoader?: HEVCRangeExtensionVectorLoader | null
    /** The browser the declared defects are matched against; this browser's when absent */
    browserIdentity?: BrowserIdentity
    /** Whether a VideoFrame can hold a raw format at all; trying one when absent */
    canHoldVideoFrameFormat?: (format: CustomDecodeRawVideoFrameFormat) => boolean
    h264ProfileProbe?: Pick<H264ProfileCapabilityProbe, 'probe'> | null
    h264RawFormatVectorLoader?: HEVCRangeExtensionVectorLoader | null
    /** The threads the device runs at once, which bound the decoders the probes open together; navigator's when absent, null when unknown */
    hardwareConcurrency?: number | null
    hevcRangeExtensionVectorLoader?: HEVCRangeExtensionVectorLoader | null
    nativeAudioOutputProbe?: NativeAudioOutputProbe | null
    nativeDolbyVisionVideoOutputProbe?: NativeDolbyVisionVideoOutputProbe | null
    nativeHDRVideoOutputProbe?: NativeDolbyVisionVideoOutputProbe | null
    nativeVideoOutputProbe?: NativeVideoOutputProbe | null
    rawHDRVideoOutputProbe?: RawHDRVideoOutputProbe | null
    videoDecoder?: Pick<typeof VideoDecoder, 'isConfigSupported'> | null
};

type VideoProbeDefinition = {
    codec: CustomVideoCodec
    config: VideoDecoderConfig
    outputVector?: {
        encodedKeyFrame: Uint8Array
        expectedCodedHeight: number
        expectedCodedWidth: number
        expectedDisplayHeight: number
        expectedDisplayWidth: number
    }
};

type DecodedVideoProbeDefinition = VideoProbeDefinition & {
    outputVector: NonNullable<VideoProbeDefinition['outputVector']>
};

type NativeSDRVideoProbeDefinition = DecodedVideoProbeDefinition & {
    codec: NativeSDRVideoProbeCodec
};

type NativeUltraHDVideoProbeDefinition = DecodedVideoProbeDefinition & {
    codec: CustomNativeUltraHDVideoCodec
};

type AudioProbeOutputVector = {
    channelTones?: undefined
    encodedChunks: NativeAudioCapabilityVector['encodedChunks']
        | NativeSurroundAudioCapabilityVector['encodedChunks']
    expectedNumberOfChannels: number
    expectedNumberOfFrames: number
    expectedSampleRate: number
    expectedTimestamp: number
} | {
    channelTones: readonly NativeAudioChannelTone[]
    encodedChunks: NativeSevenPointOneAudioCapabilityVector['encodedChunks']
    expectedNumberOfChannels: number
    expectedSampleRate: number
};

type AudioProbeDefinition = {
    codec: CustomWebCodecsAudioCodec
    config: AudioDecoderConfig
    outputVector: AudioProbeOutputVector
};

type NativeSurroundAudioProbeDefinition = AudioProbeDefinition & {
    codec: CustomNativeSurroundAudioCodec
    inputChannelCount: CustomNativeSurroundAudioCodecCapability['inputChannelCount']
};

// The codec string a capability reports for a codec no probe settles
type AudioCodecStringDefinition<Codec extends CustomAudioCodec> = Readonly<{
    codec: Codec
    codecString: string
}>;

type RawHDRVideoProbeDefinition = {
    codec: CustomRawHDRVideoCodec
    config: VideoDecoderConfig
    encodedKeyFrame: Uint8Array
    expectedDecodedFrameFingerprint: number
};

type DecoderCapabilityAPI<Config> = {
    isConfigSupported: (config: Config) => Promise<{ supported?: boolean }>
};

const REPRESENTATIVE_RAW_HDR_VIDEO_WIDTH = RAW_HDR_CAPABILITY_VECTOR_CODED_WIDTH;
const REPRESENTATIVE_RAW_HDR_VIDEO_HEIGHT = RAW_HDR_CAPABILITY_VECTOR_CODED_HEIGHT;
const VIDEO_OUTPUT_PROBE_TIMEOUT_MILLISECONDS = 2_000;
const RAW_HDR_FINGERPRINT_COLUMN_SAMPLE_COUNT = 64;
const RAW_HDR_FINGERPRINT_ROW_SAMPLE_COUNT = 36;
const RAW_HDR_FNV1A_OFFSET_BASIS = 2_166_136_261;
const RAW_HDR_FNV1A_PRIME = 16_777_619;
const NATIVE_VIDEO_MAXIMUM_HORIZONTAL_CODED_ALIGNMENT = 256;
const NATIVE_VIDEO_MAXIMUM_VERTICAL_CODED_ALIGNMENT = 64;
const NATIVE_AUDIO_MAXIMUM_ABSOLUTE_SILENCE_SAMPLE = 0.000_001;
const HEVC_MAIN10_BLACK_DECODED_FRAME_FINGERPRINT = 3_873_342_648;
const NATIVE_HEVC_SDR_ACCESS_UNIT = createHEVCExactCapabilityAccessUnit('main-1080p');
const NATIVE_DOLBY_VISION_HEVC_ACCESS_UNIT = createHEVCExactCapabilityAccessUnit('main10-4k');
const NATIVE_HDR_HEVC_ACCESS_UNIT = createHEVCExactCapabilityAccessUnit('main10-4k');
const NATIVE_AV1_SDR_VECTOR = createNativeVideoCapabilityVector('av1');
const NATIVE_VP8_SDR_VECTOR = createNativeVideoCapabilityVector('vp8');
const NATIVE_VP9_SDR_VECTOR = createNativeVideoCapabilityVector('vp9');
const NATIVE_ULTRA_HD_HEVC_VECTOR: NativeUltraHDVideoCapabilityVector = createNativeUltraHDVideoCapabilityVector('hevc');
const NATIVE_ULTRA_HD_VP9_VECTOR: NativeUltraHDVideoCapabilityVector = createNativeUltraHDVideoCapabilityVector('vp9');
const NATIVE_ULTRA_HD_AV1_VECTOR: NativeUltraHDVideoCapabilityVector = createNativeUltraHDVideoCapabilityVector('av1');
const NATIVE_AAC_AUDIO_VECTOR: NativeAudioCapabilityVector = createNativeAudioCapabilityVector('aac');
const NATIVE_OPUS_AUDIO_VECTOR: NativeAudioCapabilityVector = createNativeAudioCapabilityVector('opus');
const NATIVE_FLAC_AUDIO_VECTOR: NativeAudioCapabilityVector = createNativeAudioCapabilityVector('flac');
const NATIVE_MP3_AUDIO_VECTOR: NativeAudioCapabilityVector = createNativeAudioCapabilityVector('mp3');
const NATIVE_VORBIS_AUDIO_VECTOR: NativeAudioCapabilityVector = createNativeAudioCapabilityVector('vorbis');
const defaultH264ProfileCapabilityProbe = new H264ProfileCapabilityProbe();

/**
 * One background run of a probe, which a negotiation promotes when it needs the same probe.
 * Until then each decode waits for the run's gate before it joins the manager, and its downloads are low priority.
 */
class BackgroundCapabilityProbeRun implements CapabilityProbeBackgroundRun {
    public promoted = false;
    public readonly promotion: Promise<void>;
    /** Whether a step timed out, or was refused, while the run was in the background */
    public timedOut = false;
    private readonly gate: (run: BackgroundCapabilityProbeRun) => Promise<void>;
    private resolvePromotion: () => void = (): void => undefined;

    public constructor(gate: (run: BackgroundCapabilityProbeRun) => Promise<void>) {
        this.gate = gate;
        this.promotion = new Promise<void>((resolve) => {
            this.resolvePromotion = resolve;
        });
    }

    /** Runs the rest of the probe at full speed: no gate, and downloads at the default priority. */
    public promote(): void {
        this.promoted = true;
        this.resolvePromotion();
    }

    /** Waits for the gate, or returns at once once promoted; a promotion ends a wait in progress. */
    public waitForTurn(): Promise<void> {
        return this.promoted ? Promise.resolve() : this.gate(this);
    }
}

// The configuration-only H.264 probe; the per-profile probe supplies the decoded-output evidence
const H264_CONFIGURATION_PROBE_DEFINITION: VideoProbeDefinition = {
    codec: 'h264',
    config: {
        codec: 'avc1.640028',
        codedHeight: NATIVE_SDR_VIDEO_VECTOR_CODED_HEIGHT,
        codedWidth: NATIVE_SDR_VIDEO_VECTOR_CODED_WIDTH,
        hardwareAcceleration: getCustomDecodeHardwareAcceleration('video-frame'),
        optimizeForLatency: true
    }
};

const NATIVE_SDR_VIDEO_PROBE_DEFINITIONS: readonly NativeSDRVideoProbeDefinition[] = [
    {
        codec: 'hevc',
        config: {
            codec: 'hvc1.1.6.L120.B0',
            codedHeight: NATIVE_SDR_VIDEO_VECTOR_CODED_HEIGHT,
            codedWidth: NATIVE_SDR_VIDEO_VECTOR_CODED_WIDTH,
            hardwareAcceleration: getCustomDecodeHardwareAcceleration('video-frame'),
            optimizeForLatency: true
        },
        outputVector: {
            encodedKeyFrame: new Uint8Array(NATIVE_HEVC_SDR_ACCESS_UNIT),
            expectedCodedHeight: NATIVE_SDR_VIDEO_VECTOR_CODED_HEIGHT,
            expectedCodedWidth: NATIVE_SDR_VIDEO_VECTOR_CODED_WIDTH,
            expectedDisplayHeight: NATIVE_SDR_VIDEO_VECTOR_CODED_HEIGHT,
            expectedDisplayWidth: NATIVE_SDR_VIDEO_VECTOR_CODED_WIDTH
        }
    },
    {
        codec: 'vp8',
        config: {
            codec: 'vp8',
            codedHeight: NATIVE_SDR_VIDEO_VECTOR_CODED_HEIGHT,
            codedWidth: NATIVE_SDR_VIDEO_VECTOR_CODED_WIDTH,
            hardwareAcceleration: getCustomDecodeHardwareAcceleration('video-frame'),
            optimizeForLatency: true
        },
        outputVector: {
            encodedKeyFrame: NATIVE_VP8_SDR_VECTOR.encodedKeyFrame,
            expectedCodedHeight: NATIVE_VP8_SDR_VECTOR.codedHeight,
            expectedCodedWidth: NATIVE_VP8_SDR_VECTOR.codedWidth,
            expectedDisplayHeight: NATIVE_VP8_SDR_VECTOR.codedHeight,
            expectedDisplayWidth: NATIVE_VP8_SDR_VECTOR.codedWidth
        }
    },
    {
        codec: 'vp9',
        config: {
            codec: 'vp09.00.10.08',
            codedHeight: NATIVE_SDR_VIDEO_VECTOR_CODED_HEIGHT,
            codedWidth: NATIVE_SDR_VIDEO_VECTOR_CODED_WIDTH,
            hardwareAcceleration: getCustomDecodeHardwareAcceleration('video-frame'),
            optimizeForLatency: true
        },
        outputVector: {
            encodedKeyFrame: NATIVE_VP9_SDR_VECTOR.encodedKeyFrame,
            expectedCodedHeight: NATIVE_VP9_SDR_VECTOR.codedHeight,
            expectedCodedWidth: NATIVE_VP9_SDR_VECTOR.codedWidth,
            expectedDisplayHeight: NATIVE_VP9_SDR_VECTOR.codedHeight,
            expectedDisplayWidth: NATIVE_VP9_SDR_VECTOR.codedWidth
        }
    },
    {
        codec: 'av1',
        config: {
            codec: 'av01.0.08M.08',
            codedHeight: NATIVE_SDR_VIDEO_VECTOR_CODED_HEIGHT,
            codedWidth: NATIVE_SDR_VIDEO_VECTOR_CODED_WIDTH,
            hardwareAcceleration: getCustomDecodeHardwareAcceleration('video-frame'),
            optimizeForLatency: true
        },
        outputVector: {
            encodedKeyFrame: NATIVE_AV1_SDR_VECTOR.encodedKeyFrame,
            expectedCodedHeight: NATIVE_AV1_SDR_VECTOR.codedHeight,
            expectedCodedWidth: NATIVE_AV1_SDR_VECTOR.codedWidth,
            expectedDisplayHeight: NATIVE_AV1_SDR_VECTOR.codedHeight,
            expectedDisplayWidth: NATIVE_AV1_SDR_VECTOR.codedWidth
        }
    }
];

function createNativeUltraHDVideoProbeDefinition(
    vector: NativeUltraHDVideoCapabilityVector
): NativeUltraHDVideoProbeDefinition {
    return {
        codec: vector.codec,
        config: {
            codec: vector.codecString,
            codedHeight: vector.codedHeight,
            codedWidth: vector.codedWidth,
            hardwareAcceleration: getCustomDecodeHardwareAcceleration('video-frame'),
            optimizeForLatency: true
        },
        outputVector: {
            encodedKeyFrame: vector.encodedKeyFrame,
            expectedCodedHeight: vector.codedHeight,
            expectedCodedWidth: vector.codedWidth,
            expectedDisplayHeight: vector.codedHeight,
            expectedDisplayWidth: vector.codedWidth
        }
    };
}

const NATIVE_ULTRA_HD_VIDEO_PROBE_DEFINITIONS: readonly NativeUltraHDVideoProbeDefinition[] = [
    createNativeUltraHDVideoProbeDefinition(NATIVE_ULTRA_HD_HEVC_VECTOR),
    createNativeUltraHDVideoProbeDefinition(NATIVE_ULTRA_HD_VP9_VECTOR),
    createNativeUltraHDVideoProbeDefinition(NATIVE_ULTRA_HD_AV1_VECTOR)
];

const NATIVE_DOLBY_VISION_HEVC_PROBE_DEFINITION = {
    codec: 'hevc',
    config: {
        codec: 'hev1.2.4.H150.B0',
        codedHeight: NATIVE_DOLBY_VISION_HEVC_VECTOR_CODED_HEIGHT,
        codedWidth: NATIVE_DOLBY_VISION_HEVC_VECTOR_CODED_WIDTH,
        hardwareAcceleration: getCustomDecodeHardwareAcceleration('video-frame', true),
        optimizeForLatency: true
    }
} as const satisfies VideoProbeDefinition;

const NATIVE_HDR_HEVC_PROBE_DEFINITION = {
    codec: 'hevc',
    config: {
        codec: 'hvc1.2.4.L153.B0',
        codedHeight: NATIVE_HDR_HEVC_VECTOR_CODED_HEIGHT,
        codedWidth: NATIVE_HDR_HEVC_VECTOR_CODED_WIDTH,
        hardwareAcceleration: getCustomDecodeHardwareAcceleration('video-frame', true),
        optimizeForLatency: true
    }
} as const satisfies VideoProbeDefinition;

function createAudioProbeDefinition(
    vector: NativeAudioCapabilityVector | NativeSurroundAudioCapabilityVector
): AudioProbeDefinition {
    return {
        codec: vector.codec,
        config: {
            codec: vector.codecString,
            ...(vector.description ? { description: vector.description.slice() } : {}),
            numberOfChannels: vector.numberOfChannels,
            sampleRate: vector.sampleRate
        },
        outputVector: {
            encodedChunks: vector.encodedChunks,
            expectedNumberOfChannels: vector.numberOfChannels,
            expectedNumberOfFrames: vector.expectedOutputFrameCount,
            expectedSampleRate: vector.sampleRate,
            expectedTimestamp: vector.expectedOutputTimestamp
        }
    };
}

const AUDIO_PROBE_DEFINITIONS: readonly AudioProbeDefinition[] = [
    createAudioProbeDefinition(NATIVE_AAC_AUDIO_VECTOR),
    createAudioProbeDefinition(NATIVE_OPUS_AUDIO_VECTOR),
    createAudioProbeDefinition(NATIVE_FLAC_AUDIO_VECTOR),
    createAudioProbeDefinition(NATIVE_MP3_AUDIO_VECTOR),
    createAudioProbeDefinition(NATIVE_VORBIS_AUDIO_VECTOR)
];

function createNativeSurroundAudioProbeDefinitions():
readonly NativeSurroundAudioProbeDefinition[] {
    const definitions: NativeSurroundAudioProbeDefinition[] = [];
    for (const codec of NATIVE_SURROUND_AUDIO_CAPABILITY_VECTOR_CODECS) {
        const vector = createNativeSurroundAudioCapabilityVector(codec);
        definitions.push({
            ...createAudioProbeDefinition(vector),
            codec,
            inputChannelCount: vector.numberOfChannels
        });
    }
    return definitions;
}

const NATIVE_SURROUND_AUDIO_PROBE_DEFINITIONS: readonly NativeSurroundAudioProbeDefinition[] = createNativeSurroundAudioProbeDefinitions();

function createNativeSevenPointOneAudioProbeDefinitions():
readonly NativeSurroundAudioProbeDefinition[] {
    const definitions: NativeSurroundAudioProbeDefinition[] = [];
    for (const codec of NATIVE_SEVEN_POINT_ONE_AUDIO_CAPABILITY_VECTOR_CODECS) {
        const vector = createNativeSevenPointOneAudioCapabilityVector(codec);
        definitions.push({
            codec,
            config: {
                codec: vector.codecString,
                description: vector.description.slice(),
                numberOfChannels: vector.numberOfChannels,
                sampleRate: vector.sampleRate
            },
            inputChannelCount: vector.numberOfChannels,
            outputVector: {
                channelTones: vector.channelTones,
                encodedChunks: vector.encodedChunks,
                expectedNumberOfChannels: vector.numberOfChannels,
                expectedSampleRate: vector.sampleRate
            }
        });
    }
    return definitions;
}

const NATIVE_SEVEN_POINT_ONE_AUDIO_PROBE_DEFINITIONS: readonly NativeSurroundAudioProbeDefinition[] =
    createNativeSevenPointOneAudioProbeDefinitions();

const MEDIABUNNY_PCM_AUDIO_CODEC_DEFINITIONS: readonly AudioCodecStringDefinition<CustomMediabunnyPCMAudioCodec>[] = [
    { codec: 'pcm_s16le', codecString: 'pcm-s16' },
    { codec: 'pcm_s16be', codecString: 'pcm-s16be' },
    { codec: 'pcm_s24le', codecString: 'pcm-s24' },
    { codec: 'pcm_s24be', codecString: 'pcm-s24be' },
    { codec: 'pcm_s32le', codecString: 'pcm-s32' },
    { codec: 'pcm_s32be', codecString: 'pcm-s32be' },
    { codec: 'pcm_f32le', codecString: 'pcm-f32' },
    { codec: 'pcm_f32be', codecString: 'pcm-f32be' },
    { codec: 'pcm_f64le', codecString: 'pcm-f64' },
    { codec: 'pcm_f64be', codecString: 'pcm-f64be' },
    { codec: 'pcm_u8', codecString: 'pcm-u8' },
    { codec: 'pcm_s8', codecString: 'pcm-s8' },
    { codec: 'pcm_mulaw', codecString: 'ulaw' },
    { codec: 'pcm_alaw', codecString: 'alaw' }
];

const PACKAGE_AUDIO_CODEC_DEFINITIONS: readonly AudioCodecStringDefinition<CustomPackageAudioCodec>[] = [
    { codec: 'ac3', codecString: 'ac-3' },
    { codec: 'eac3', codecString: 'ec-3' },
    { codec: 'dts', codecString: 'dts' },
    { codec: 'mlp', codecString: 'mlp' },
    { codec: 'truehd', codecString: 'truehd' },
    // No codec string names WMA, so its capability carries FFmpeg's decoder names
    { codec: 'wmav1', codecString: 'wmav1' },
    { codec: 'wmav2', codecString: 'wmav2' },
    { codec: 'wmapro', codecString: 'wmapro' },
    { codec: 'wmalossless', codecString: 'wmalossless' },
    { codec: 'wmavoice', codecString: 'wmavoice' }
];

const VP9_PROFILE_2_VECTOR = createRawHDRCapabilityVector('vp9');
const AV1_MAIN_10_VECTOR = createRawHDRCapabilityVector('av1');
const HEVC_MAIN10_ACCESS_UNIT = createHEVCExactCapabilityAccessUnit('main10-4k');
// The runtime requests each probe's hint for its codec: raw AV1 and VP9 planes come from the software decoders
const RAW_HDR_VIDEO_PROBE_DEFINITIONS: readonly RawHDRVideoProbeDefinition[] = [
    {
        codec: 'hevc',
        config: {
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: REPRESENTATIVE_RAW_HDR_VIDEO_HEIGHT,
            codedWidth: REPRESENTATIVE_RAW_HDR_VIDEO_WIDTH,
            hardwareAcceleration: getCustomDecodeHardwareAcceleration('raw-planes', false, 'hevc'),
            optimizeForLatency: true
        },
        encodedKeyFrame: new Uint8Array(HEVC_MAIN10_ACCESS_UNIT),
        expectedDecodedFrameFingerprint: HEVC_MAIN10_BLACK_DECODED_FRAME_FINGERPRINT
    },
    {
        codec: 'vp9',
        config: {
            codec: 'vp09.02.10.10',
            codedHeight: REPRESENTATIVE_RAW_HDR_VIDEO_HEIGHT,
            codedWidth: REPRESENTATIVE_RAW_HDR_VIDEO_WIDTH,
            hardwareAcceleration: getCustomDecodeHardwareAcceleration('raw-planes', false, 'vp9'),
            optimizeForLatency: true
        },
        encodedKeyFrame: VP9_PROFILE_2_VECTOR.encodedKeyFrame,
        expectedDecodedFrameFingerprint: VP9_PROFILE_2_VECTOR.decodedFrameFingerprint
    },
    {
        codec: 'av1',
        config: {
            codec: 'av01.0.08M.10',
            codedHeight: REPRESENTATIVE_RAW_HDR_VIDEO_HEIGHT,
            codedWidth: REPRESENTATIVE_RAW_HDR_VIDEO_WIDTH,
            hardwareAcceleration: getCustomDecodeHardwareAcceleration('raw-planes', false, 'av1'),
            optimizeForLatency: true
        },
        encodedKeyFrame: AV1_MAIN_10_VECTOR.encodedKeyFrame,
        expectedDecodedFrameFingerprint: AV1_MAIN_10_VECTOR.decodedFrameFingerprint
    }
];

// The raw route's 4K AV1 Main 10 keyframe, decoded by the hardware decoder to an opaque frame
const NATIVE_HDR_AV1_PROBE_DEFINITION = {
    codec: 'av1',
    config: {
        codec: AV1_MAIN_10_VECTOR.codecString,
        codedHeight: AV1_MAIN_10_VECTOR.codedHeight,
        codedWidth: AV1_MAIN_10_VECTOR.codedWidth,
        hardwareAcceleration: getCustomDecodeHardwareAcceleration('video-frame', true),
        optimizeForLatency: true
    }
} as const satisfies VideoProbeDefinition;

// The configuration a native SDR decode runs: the probe's, at its vector's coded size
function getNativeVideoOutputConfig(definition: DecodedVideoProbeDefinition): VideoDecoderConfig {
    return {
        ...definition.config,
        codedHeight: definition.outputVector.expectedCodedHeight,
        codedWidth: definition.outputVector.expectedCodedWidth
    };
}

// A silence vector decodes to its expected frames; a tone vector to its packets' durations at its sample rate
function getAudioDecodedFrameCount(vector: AudioProbeOutputVector): number {
    if (!vector.channelTones) {
        return vector.expectedNumberOfFrames;
    }
    let durationMicroseconds = 0;
    for (const chunk of vector.encodedChunks) {
        durationMicroseconds += chunk.duration;
    }
    return Math.ceil(durationMicroseconds * vector.expectedSampleRate / MICROSECONDS_PER_SECOND);
}

// Each decode's descriptor, which its probe and the manager's limits share
function describeNativeAudioDecode(definition: AudioProbeDefinition): AudioCapabilityProbeStep {
    return describeAudioDecode(definition.config, getAudioDecodedFrameCount(definition.outputVector));
}

// Native SDR frames come out 8-bit 4:2:0
function describeNativeVideoDecode(definition: DecodedVideoProbeDefinition): VideoCapabilityProbeStep {
    return describeVideoDecode(getNativeVideoOutputConfig(definition), 'I420');
}

// The native HDR routes' frames come out 10-bit 4:2:0, which they present without a copy
function describeNativeHDRVideoDecode(config: VideoDecoderConfig): VideoCapabilityProbeStep {
    return describeVideoDecode(config, 'I420P10');
}

// A raw probe decodes into its format and copies a frame out in it
function describeRawVideoDecode(config: VideoDecoderConfig, format: CustomDecodeRawVideoFrameFormat): VideoCapabilityProbeStep {
    return describeVideoDecode(config, format, format);
}

/** Returns every browser call the probe definitions can make: each configuration check, and each decode at its vector's size and format. */
function describeDefinitionSteps(): CapabilityProbeStep[] {
    const steps: CapabilityProbeStep[] = [];
    for (const definition of [ ...AUDIO_PROBE_DEFINITIONS, ...NATIVE_SURROUND_AUDIO_PROBE_DEFINITIONS, ...NATIVE_SEVEN_POINT_ONE_AUDIO_PROBE_DEFINITIONS ]) {
        steps.push(describeAudioConfigCheck(definition.config), describeNativeAudioDecode(definition));
    }
    steps.push(describeVideoConfigCheck(H264_CONFIGURATION_PROBE_DEFINITION.config), ...describeH264ProfileProbeSteps());
    for (const definition of [ ...NATIVE_SDR_VIDEO_PROBE_DEFINITIONS, ...NATIVE_ULTRA_HD_VIDEO_PROBE_DEFINITIONS ]) {
        steps.push(describeVideoConfigCheck(definition.config), describeNativeVideoDecode(definition));
    }
    for (const definition of RAW_HDR_VIDEO_PROBE_DEFINITIONS) {
        steps.push(describeVideoConfigCheck(definition.config), describeRawVideoDecode(definition.config, 'I420P10'));
    }
    for (const definition of [
        ...Object.values(HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS),
        ...Object.values(AV1_RAW_FORMAT_PROBE_DEFINITIONS),
        ...Object.values(H264_RAW_FORMAT_PROBE_DEFINITIONS)
    ]) {
        steps.push(describeVideoConfigCheck(definition.config), describeRawVideoDecode(definition.config, definition.format));
    }
    for (const { config } of [ NATIVE_DOLBY_VISION_HEVC_PROBE_DEFINITION, NATIVE_HDR_HEVC_PROBE_DEFINITION, NATIVE_HDR_AV1_PROBE_DEFINITION ]) {
        steps.push(describeVideoConfigCheck(config), describeNativeHDRVideoDecode(config));
    }
    return steps;
}

/** The most decoded bytes any one probe call holds, which bounds what the page's calls hold together: the largest runs beside none but checks. */
const CAPABILITY_PROBE_DEFINITION_BYTES = getLargestCapabilityProbeStepCost(describeDefinitionSteps()).bytes;

// The threads the browser reports, or null when it hides them
function readHardwareConcurrency(): number | null {
    const hardwareConcurrency = (globalThis.navigator as ConstrainedClientNavigator | undefined)?.hardwareConcurrency;
    return typeof hardwareConcurrency === 'number' ? hardwareConcurrency : null;
}

/** Returns how many decoders the probes open together: one per thread the device runs at once, or one when the count is unknown. */
function getCapabilityProbeDecoderLimit(hardwareConcurrency: number | null): number {
    return hardwareConcurrency !== null && Number.isSafeInteger(hardwareConcurrency) && hardwareConcurrency > 0 ? hardwareConcurrency : 1;
}

function getNativeSDRVideoProbe(codec: NativeSDRVideoProbeCodec): CustomDecodeVideoProbe {
    return `native-sdr:${codec}`;
}

function getNativeUltraHDVideoProbe(codec: CustomNativeUltraHDVideoCodec): CustomDecodeVideoProbe {
    return `native-ultra-hd:${codec}`;
}

function getRawVideoProbe(codec: CustomRawHDRVideoCodec): CustomDecodeVideoProbe {
    return `raw:${codec}`;
}

function getHEVCRangeExtensionVideoProbe(variant: HEVCRangeExtensionVariant): CustomDecodeVideoProbe {
    return `hevc-range-extension:${variant}`;
}

function getAV1RawFormatVideoProbe(variant: AV1RawFormatVariant): CustomDecodeVideoProbe {
    return `av1-raw-format:${variant}`;
}

function getH264RawFormatVideoProbe(variant: H264RawFormatVariant): CustomDecodeVideoProbe {
    return `h264-raw-format:${variant}`;
}

const NATIVE_SDR_VIDEO_PROBES: readonly CustomDecodeVideoProbe[] = NATIVE_SDR_VIDEO_PROBE_DEFINITIONS.map(
    (definition: NativeSDRVideoProbeDefinition): CustomDecodeVideoProbe => getNativeSDRVideoProbe(definition.codec)
);
const NATIVE_ULTRA_HD_VIDEO_PROBES: readonly CustomDecodeVideoProbe[] = NATIVE_ULTRA_HD_VIDEO_PROBE_DEFINITIONS.map(
    (definition: NativeUltraHDVideoProbeDefinition): CustomDecodeVideoProbe => getNativeUltraHDVideoProbe(definition.codec)
);
const RAW_VIDEO_PROBES: readonly CustomDecodeVideoProbe[] = RAW_HDR_VIDEO_PROBE_DEFINITIONS.map(
    (definition: RawHDRVideoProbeDefinition): CustomDecodeVideoProbe => getRawVideoProbe(definition.codec)
);

/** Every video probe, in the order a run starts them; an item without stream metadata runs them all. */
export const CUSTOM_DECODE_VIDEO_PROBES: readonly CustomDecodeVideoProbe[] = [
    'h264-profiles',
    ...NATIVE_SDR_VIDEO_PROBES,
    ...NATIVE_ULTRA_HD_VIDEO_PROBES,
    ...RAW_VIDEO_PROBES,
    ...HEVC_RANGE_EXTENSION_VARIANTS.map(getHEVCRangeExtensionVideoProbe),
    ...AV1_RAW_FORMAT_VARIANTS.map(getAV1RawFormatVideoProbe),
    ...H264_RAW_FORMAT_VARIANTS.map(getH264RawFormatVideoProbe),
    'native-dolby-vision-hevc',
    'native-hdr-av1',
    'native-hdr-hevc'
];

// The probes of the native external HDR route's decoders
const NATIVE_HDR_VIDEO_PROBES: readonly CustomDecodeVideoProbe[] = [
    'native-hdr-av1',
    'native-hdr-hevc'
];

// The video configuration probes the telemetry counts
const VIDEO_CONFIGURATION_PROBES: readonly CustomDecodeVideoProbe[] = [
    'h264-profiles',
    ...NATIVE_SDR_VIDEO_PROBES,
    ...NATIVE_ULTRA_HD_VIDEO_PROBES,
    'native-dolby-vision-hevc',
    'native-hdr-av1',
    'native-hdr-hevc'
];

/**
 * The video probes every HDR item runs, whatever its codec.
 * An HDR source can transcode to HEVC or AV1 and keep HDR, and the augmented profile's ranges for those codecs bound that output, so they must come from settled probes.
 */
const HDR_TRANSCODE_TARGET_VIDEO_PROBES: readonly CustomDecodeVideoProbe[] = [
    'native-sdr:hevc',
    'native-ultra-hd:hevc',
    'raw:hevc',
    'native-hdr-hevc',
    'native-sdr:av1',
    'native-ultra-hd:av1',
    'raw:av1'
];

// NOTE: Mirrors the codec names eligibility accepts; a name missing here would leave its codec unprobed
const CUSTOM_VIDEO_CODEC_NAMES: ReadonlyMap<string, CustomVideoCodec> = new Map<string, CustomVideoCodec>([
    [ 'AV1', 'av1' ],
    [ 'AVC', 'h264' ],
    [ 'AVC1', 'h264' ],
    [ 'H263', 'h263' ],
    [ 'H264', 'h264' ],
    [ 'H265', 'hevc' ],
    [ 'HEVC', 'hevc' ],
    [ 'J2K', 'jpeg2000' ],
    [ 'JPEG 2000', 'jpeg2000' ],
    [ 'JPEG2000', 'jpeg2000' ],
    [ 'MPEG-1', 'mpeg1video' ],
    [ 'MPEG1', 'mpeg1video' ],
    [ 'MPEG1VIDEO', 'mpeg1video' ],
    [ 'MPEG-2', 'mpeg2video' ],
    [ 'MPEG2', 'mpeg2video' ],
    [ 'MPEG2VIDEO', 'mpeg2video' ],
    [ 'MPEG4', 'mpeg4' ],
    [ 'MSMPEG4', 'msmpeg4v3' ],
    [ 'MSMPEG4V1', 'msmpeg4v1' ],
    [ 'MSMPEG4V2', 'msmpeg4v2' ],
    [ 'MSMPEG4V3', 'msmpeg4v3' ],
    [ 'VC-1', 'vc1' ],
    [ 'VC1', 'vc1' ],
    [ 'VP8', 'vp8' ],
    [ 'VP9', 'vp9' ],
    [ 'WMV3', 'wmv3' ]
]);

function mixRawHDRFingerprintValue(fingerprint: number, value: number): number {
    let mixedFingerprint = Math.imul((fingerprint ^ (value & 0xFF)) >>> 0, RAW_HDR_FNV1A_PRIME) >>> 0;
    mixedFingerprint = Math.imul((mixedFingerprint ^ ((value >>> 8) & 0xFF)) >>> 0, RAW_HDR_FNV1A_PRIME) >>> 0;
    return mixedFingerprint;
}

function mixRawHDRPlaneFingerprint(
    fingerprint: number,
    destination: Uint8Array,
    layout: PlaneLayout,
    width: number,
    height: number,
    bytesPerComponent: 1 | 2
): number | null {
    const minimumStride = width * bytesPerComponent;
    const finalByteOffset = layout.offset
        + ((height - 1) * layout.stride)
        + minimumStride;
    if (!Number.isSafeInteger(layout.offset)
        || layout.offset < 0
        || !Number.isSafeInteger(layout.stride)
        || layout.stride < minimumStride
        || finalByteOffset > destination.byteLength) {
        return null;
    }

    let mixedFingerprint = mixRawHDRFingerprintValue(fingerprint, width);
    mixedFingerprint = mixRawHDRFingerprintValue(mixedFingerprint, height);
    for (let rowSampleIndex = 0; rowSampleIndex < RAW_HDR_FINGERPRINT_ROW_SAMPLE_COUNT; rowSampleIndex += 1) {
        const rowIndex = Math.floor(rowSampleIndex * (height - 1) / (RAW_HDR_FINGERPRINT_ROW_SAMPLE_COUNT - 1));
        for (
            let columnSampleIndex = 0;
            columnSampleIndex < RAW_HDR_FINGERPRINT_COLUMN_SAMPLE_COUNT;
            columnSampleIndex += 1
        ) {
            const columnIndex = Math.floor(
                columnSampleIndex * (width - 1)
                    / (RAW_HDR_FINGERPRINT_COLUMN_SAMPLE_COUNT - 1)
            );
            const byteOffset = layout.offset
                + (rowIndex * layout.stride)
                + (columnIndex * bytesPerComponent);
            const sample = bytesPerComponent === 1 ?
                destination[byteOffset] :
                destination[byteOffset] | (destination[byteOffset + 1] << 8);
            mixedFingerprint = mixRawHDRFingerprintValue(mixedFingerprint, sample);
        }
    }
    return mixedFingerprint;
}

function createRawHDRFrameFingerprint(
    destination: Uint8Array,
    layouts: readonly PlaneLayout[],
    width: number,
    height: number,
    format: CustomDecodeRawVideoFrameFormat
): number | null {
    if (layouts.length !== 3) {
        return null;
    }
    let bytesPerComponent: 1 | 2;
    let chromaWidthDivisor: 1 | 2;
    let chromaHeightDivisor: 1 | 2;
    switch (format) {
        case 'I420':
            bytesPerComponent = 1;
            chromaWidthDivisor = 2;
            chromaHeightDivisor = 2;
            break;
        case 'I420P10':
        case 'I420P12':
            bytesPerComponent = 2;
            chromaWidthDivisor = 2;
            chromaHeightDivisor = 2;
            break;
        case 'I422':
            bytesPerComponent = 1;
            chromaWidthDivisor = 2;
            chromaHeightDivisor = 1;
            break;
        case 'I422P10':
        case 'I422P12':
            bytesPerComponent = 2;
            chromaWidthDivisor = 2;
            chromaHeightDivisor = 1;
            break;
        case 'I444':
            bytesPerComponent = 1;
            chromaWidthDivisor = 1;
            chromaHeightDivisor = 1;
            break;
        case 'I444P10':
        case 'I444P12':
            bytesPerComponent = 2;
            chromaWidthDivisor = 1;
            chromaHeightDivisor = 1;
            break;
    }
    const chromaWidth = Math.ceil(width / chromaWidthDivisor);
    const chromaHeight = Math.ceil(height / chromaHeightDivisor);
    const lumaFingerprint = mixRawHDRPlaneFingerprint(
        RAW_HDR_FNV1A_OFFSET_BASIS,
        destination,
        layouts[0],
        width,
        height,
        bytesPerComponent
    );
    if (lumaFingerprint === null) {
        return null;
    }
    const chromaBlueFingerprint = mixRawHDRPlaneFingerprint(
        lumaFingerprint,
        destination,
        layouts[1],
        chromaWidth,
        chromaHeight,
        bytesPerComponent
    );
    if (chromaBlueFingerprint === null) {
        return null;
    }
    return mixRawHDRPlaneFingerprint(
        chromaBlueFingerprint,
        destination,
        layouts[2],
        chromaWidth,
        chromaHeight,
        bytesPerComponent
    );
}

type CopiedRawHDRFrame = Readonly<{
    destination: Uint8Array
    layouts: readonly PlaneLayout[]
}>;

async function copyDecodedRawHDRFrame(
    decodedFrame: VideoFrame,
    expectedFormat: CustomDecodeRawVideoFrameFormat,
    destination: Uint8Array | null
): Promise<CopiedRawHDRFrame | null> {
    // The spec's copy options accept only RGB formats, so a frame already in the expected format copies without one
    const copyOptions: RawHDRVideoFrameCopyToOptions | undefined = String(decodedFrame.format) === expectedFormat ?
        undefined :
        { format: expectedFormat };
    const browserCopyOptions = copyOptions as unknown as VideoFrameCopyToOptions | undefined;
    let allocationSize: number;
    try {
        allocationSize = decodedFrame.allocationSize(browserCopyOptions);
    } catch {
        return null;
    }
    const output = destination?.byteLength === allocationSize ?
        destination :
        new Uint8Array(allocationSize);
    try {
        return {
            destination: output,
            layouts: await decodedFrame.copyTo(output, browserCopyOptions)
        };
    } catch {
        return null;
    }
}

/** Creates the exact decoded-frame copy probe for raw HDR output. */
export function createRawHDRVideoOutputProbe(): RawHDRVideoOutputProbe | null {
    if (typeof globalThis.VideoDecoder !== 'function'
        || typeof globalThis.EncodedVideoChunk !== 'function') {
        return null;
    }

    return async (probeRequest: RawHDRVideoOutputProbeRequest): Promise<RawHDRVideoOutputProbeResult> => {
        const unsupportedResult: RawHDRVideoOutputProbeResult = Object.freeze({
            outputCopySupported: false
        });
        let acceptingFrame = true;
        let decoderError: DOMException | null = null;
        let destination: Uint8Array | null = null;
        let outputCount = 0;
        let outputMatches = true;
        let processingTail: Promise<void> = Promise.resolve();
        const ownedFrames = new Set<VideoFrame>();
        // A frame whose copy is pending stays open until that copy settles; closing it mid-copy is undefined in browsers
        const copyingFrames = new Set<VideoFrame>();

        const closeOwnedFrame = (frame: VideoFrame): void => {
            if (!ownedFrames.delete(frame)) {
                return;
            }
            frame.close();
        };

        const processFrame = async (
            frame: VideoFrame,
            expectedFrame: RawHDRVideoOutputProbeRequest['expectedDecodedFrames'][number]
                | undefined
        ): Promise<void> => {
            try {
                if (!acceptingFrame || !expectedFrame) {
                    outputMatches = false;
                    return;
                }
                // A software decoder may pad the coded width, as libvpx pads 3840 to 3904; the copy and the fingerprint cover the visible rectangle
                const visibleRectangle = frame.visibleRect ?? { height: frame.codedHeight, width: frame.codedWidth };
                if (visibleRectangle.height !== probeRequest.expectedCodedHeight
                    || visibleRectangle.width !== probeRequest.expectedCodedWidth
                    || frame.timestamp !== expectedFrame.timestamp) {
                    outputMatches = false;
                    return;
                }
                copyingFrames.add(frame);
                const copiedFrame = await copyDecodedRawHDRFrame(frame, probeRequest.expectedFormat, destination);
                if (!copiedFrame) {
                    outputMatches = false;
                    return;
                }
                destination = copiedFrame.destination;
                if (createRawHDRFrameFingerprint(
                    destination,
                    copiedFrame.layouts,
                    probeRequest.expectedCodedWidth,
                    probeRequest.expectedCodedHeight,
                    probeRequest.expectedFormat
                ) !== expectedFrame.fingerprint) {
                    outputMatches = false;
                }
            } catch {
                outputMatches = false;
            } finally {
                copyingFrames.delete(frame);
                closeOwnedFrame(frame);
            }
        };

        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        const decoder = new VideoDecoder({
            error: (error: DOMException): void => {
                decoderError = error;
            },
            output: (frame: VideoFrame): void => {
                if (!acceptingFrame) {
                    frame.close();
                    return;
                }
                const expectedFrame = probeRequest.expectedDecodedFrames[outputCount];
                outputCount += 1;
                ownedFrames.add(frame);
                processingTail = processingTail.then(() => (
                    processFrame(frame, expectedFrame)
                ));
            }
        });
        let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
        try {
            if (probeRequest.encodedChunks.length === 0
                || probeRequest.encodedChunks.length !== probeRequest.expectedDecodedFrames.length) {
                return unsupportedResult;
            }
            decoder.configure({ ...probeRequest.configuration });
            const runOutputProbe = async (): Promise<RawHDRVideoOutputProbeResult> => {
                try {
                    for (const encodedChunk of probeRequest.encodedChunks) {
                        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
                        decoder.decode(new EncodedVideoChunk({
                            data: encodedChunk.data,
                            timestamp: encodedChunk.timestamp,
                            type: encodedChunk.type
                        }));
                    }
                    await decoder.flush();
                } catch {
                    return unsupportedResult;
                }
                await processingTail;
                return Object.freeze({
                    outputCopySupported: decoderError === null
                        && outputCount === probeRequest.expectedDecodedFrames.length
                        && outputMatches
                });
            };
            return await Promise.race([
                runOutputProbe(),
                new Promise<RawHDRVideoOutputProbeResult>(resolve => {
                    timeout = globalThis.setTimeout(
                        () => resolve(unsupportedResult),
                        VIDEO_OUTPUT_PROBE_TIMEOUT_MILLISECONDS
                    );
                })
            ]);
        } finally {
            acceptingFrame = false;
            for (const frame of ownedFrames) {
                if (!copyingFrames.has(frame)) {
                    closeOwnedFrame(frame);
                }
            }
            if (timeout !== null) {
                globalThis.clearTimeout(timeout);
            }
            if (decoder.state !== 'closed') {
                decoder.close();
            }
            // The probe settles only after a pending copy, so its caller never releases resources the browser still uses
            await processingTail;
        }
    };
}

function nativeAudioDataMatchesRequest(
    audioData: AudioData,
    probeRequest: NativeAudioSilenceOutputProbeRequest
): boolean {
    const expectedDuration: number = Math.round(
        (probeRequest.expectedNumberOfFrames * 1_000_000)
        / probeRequest.expectedSampleRate
    );
    if (
        audioData.numberOfChannels !== probeRequest.expectedNumberOfChannels
        || audioData.numberOfFrames !== probeRequest.expectedNumberOfFrames
        || audioData.sampleRate !== probeRequest.expectedSampleRate
        || audioData.timestamp !== probeRequest.expectedTimestamp
        || audioData.duration !== expectedDuration
    ) {
        return false;
    }
    const planes = copyAudioDataPlanes(audioData);
    return planes !== null && planes.every(samples => samples.every(sample => (
        Number.isFinite(sample) && Math.abs(sample) <= NATIVE_AUDIO_MAXIMUM_ABSOLUTE_SILENCE_SAMPLE
    )));
}

// Copies each plane of a tone vector's AudioData, or returns null for output of another layout or one that does not copy
function copyNativeAudioTonePlanes(
    audioData: AudioData,
    probeRequest: NativeAudioToneOutputProbeRequest
): Float32Array[] | null {
    if (audioData.numberOfChannels !== probeRequest.expectedNumberOfChannels
        || audioData.sampleRate !== probeRequest.expectedSampleRate) {
        return null;
    }
    return copyAudioDataPlanes(audioData);
}

function concatenateNativeAudioPlanes(outputs: readonly (readonly Float32Array[])[], channelCount: number): Float32Array[] {
    const planes: Float32Array[] = [];
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        let frameCount = 0;
        for (const output of outputs) {
            frameCount += output[channelIndex].length;
        }
        const plane = new Float32Array(frameCount);
        let offset = 0;
        for (const output of outputs) {
            plane.set(output[channelIndex], offset);
            offset += output[channelIndex].length;
        }
        planes.push(plane);
    }
    return planes;
}

/**
 * Creates the decoded AudioData probe for native WebCodecs audio.
 * A silence vector must decode to one exact silent AudioData; a tone vector to AudioData of its layout whose planes carry its tones in source order.
 */
export function createNativeAudioOutputProbe(): NativeAudioOutputProbe | null {
    if (typeof globalThis.AudioDecoder !== 'function'
        || typeof globalThis.EncodedAudioChunk !== 'function') {
        return null;
    }

    return async (probeRequest: NativeAudioOutputProbeRequest): Promise<boolean> => {
        let acceptingOutput = true;
        let decoderError: DOMException | null = null;
        let outputCount = 0;
        let outputMatches = true;
        const tonePlanes: Float32Array[][] = [];
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        const decoder: AudioDecoder = new AudioDecoder({
            error: (error: DOMException): void => {
                decoderError = error;
            },
            output: (audioData: AudioData): void => {
                try {
                    // NOTE: Firefox emits an empty AudioData for the Vorbis priming packet; Mediabunny skips it at runtime
                    if (!acceptingOutput || audioData.numberOfFrames === 0) {
                        return;
                    }
                    outputCount += 1;
                    if (probeRequest.channelTones) {
                        const planes = outputMatches ? copyNativeAudioTonePlanes(audioData, probeRequest) : null;
                        outputMatches = planes !== null;
                        if (planes) {
                            tonePlanes.push(planes);
                        }
                    } else {
                        outputMatches = outputMatches
                            && nativeAudioDataMatchesRequest(audioData, probeRequest);
                    }
                } finally {
                    audioData.close();
                }
            }
        });
        let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
        try {
            decoder.configure({ ...probeRequest.configuration });
            const runOutputProbe = async (): Promise<boolean> => {
                for (const chunk of probeRequest.encodedChunks) {
                    // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
                    decoder.decode(new EncodedAudioChunk({
                        data: chunk.data,
                        duration: chunk.duration,
                        timestamp: chunk.timestamp,
                        type: 'key'
                    }));
                }
                await decoder.flush();
                if (decoderError !== null || outputCount === 0 || !outputMatches) {
                    return false;
                }
                if (!probeRequest.channelTones) {
                    return outputCount === 1;
                }
                return matchesNativeAudioChannelTones(
                    concatenateNativeAudioPlanes(tonePlanes, probeRequest.expectedNumberOfChannels),
                    probeRequest.expectedSampleRate,
                    probeRequest.channelTones
                );
            };
            return await Promise.race([
                runOutputProbe(),
                new Promise<boolean>(resolve => {
                    timeout = globalThis.setTimeout(() => resolve(false), VIDEO_OUTPUT_PROBE_TIMEOUT_MILLISECONDS);
                })
            ]);
        } finally {
            acceptingOutput = false;
            if (timeout !== null) {
                globalThis.clearTimeout(timeout);
            }
            if (decoder.state !== 'closed') {
                decoder.close();
            }
        }
    };
}

function nativeVideoFrameMatchesRequest(frame: VideoFrame, probeRequest: NativeVideoOutputProbeRequest): boolean {
    const visibleRectangle = frame.visibleRect;
    const maximumCodedHeight = Math.ceil(
        probeRequest.expectedCodedHeight / NATIVE_VIDEO_MAXIMUM_VERTICAL_CODED_ALIGNMENT
    ) * NATIVE_VIDEO_MAXIMUM_VERTICAL_CODED_ALIGNMENT;
    const maximumCodedWidth = Math.ceil(
        probeRequest.expectedCodedWidth / NATIVE_VIDEO_MAXIMUM_HORIZONTAL_CODED_ALIGNMENT
    ) * NATIVE_VIDEO_MAXIMUM_HORIZONTAL_CODED_ALIGNMENT;
    return visibleRectangle !== null
        && visibleRectangle.x === 0
        && visibleRectangle.y === 0
        && visibleRectangle.height === probeRequest.expectedCodedHeight
        && visibleRectangle.width === probeRequest.expectedCodedWidth
        && frame.codedHeight >= probeRequest.expectedCodedHeight
        && frame.codedHeight <= maximumCodedHeight
        && frame.codedWidth >= probeRequest.expectedCodedWidth
        && frame.codedWidth <= maximumCodedWidth
        && frame.displayHeight === probeRequest.expectedDisplayHeight
        && frame.displayWidth === probeRequest.expectedDisplayWidth
        && frame.timestamp === probeRequest.expectedTimestamp;
}

/** Creates the exact decoded-frame probe for ordinary native SDR codecs. */
export function createNativeVideoOutputProbe(): NativeVideoOutputProbe | null {
    if (typeof globalThis.VideoDecoder !== 'function'
        || typeof globalThis.EncodedVideoChunk !== 'function') {
        return null;
    }

    return async (probeRequest: NativeVideoOutputProbeRequest): Promise<boolean> => {
        let acceptingFrame = true;
        let decoderError: DOMException | null = null;
        let outputCount = 0;
        let outputMatches = true;
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        const decoder = new VideoDecoder({
            error: (error: DOMException): void => {
                decoderError = error;
            },
            output: (frame: VideoFrame): void => {
                try {
                    if (!acceptingFrame) {
                        return;
                    }
                    outputCount += 1;
                    outputMatches = outputMatches
                        && nativeVideoFrameMatchesRequest(frame, probeRequest);
                } finally {
                    frame.close();
                }
            }
        });
        let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
        try {
            decoder.configure({ ...probeRequest.configuration });
            const runOutputProbe = async (): Promise<boolean> => {
                // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
                decoder.decode(new EncodedVideoChunk({
                    data: probeRequest.encodedKeyFrame,
                    timestamp: probeRequest.expectedTimestamp,
                    type: 'key'
                }));
                await decoder.flush();
                return decoderError === null && outputCount === 1 && outputMatches;
            };
            return await Promise.race([
                runOutputProbe(),
                new Promise<boolean>(resolve => {
                    timeout = globalThis.setTimeout(() => resolve(false), VIDEO_OUTPUT_PROBE_TIMEOUT_MILLISECONDS);
                })
            ]);
        } finally {
            acceptingFrame = false;
            if (timeout !== null) {
                globalThis.clearTimeout(timeout);
            }
            if (decoder.state !== 'closed') {
                decoder.close();
            }
        }
    };
}

/** Creates the exact decoded-frame probe for native Profile 5. */
export function createNativeDolbyVisionVideoOutputProbe():
NativeDolbyVisionVideoOutputProbe | null {
    if (typeof globalThis.VideoDecoder !== 'function'
        || typeof globalThis.EncodedVideoChunk !== 'function') {
        return null;
    }

    return async (
        probeRequest: NativeDolbyVisionVideoOutputProbeRequest
    ): Promise<NativeDolbyVisionVideoOutputProbeResult> => {
        const unsupportedResult: NativeDolbyVisionVideoOutputProbeResult = Object.freeze({
            outputSupported: false
        });
        let acceptingFrame = true;
        let decoderError: DOMException | null = null;
        let outputCount = 0;
        let outputMatches = true;

        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        const decoder = new VideoDecoder({
            error: (error: DOMException): void => {
                decoderError = error;
            },
            output: (frame: VideoFrame): void => {
                try {
                    if (!acceptingFrame) {
                        return;
                    }
                    outputCount += 1;
                    outputMatches = outputMatches
                        && outputCount === 1
                        && frame.timestamp === 0
                        && frame.codedHeight === probeRequest.expectedCodedHeight
                        && frame.codedWidth === probeRequest.expectedCodedWidth
                        && frame.displayHeight > 0
                        && frame.displayWidth > 0;
                } finally {
                    frame.close();
                }
            }
        });
        let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
        try {
            decoder.configure({ ...probeRequest.configuration });
            const runOutputProbe = async (): Promise<
                NativeDolbyVisionVideoOutputProbeResult
            > => {
                try {
                    // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
                    decoder.decode(new EncodedVideoChunk({
                        data: probeRequest.encodedKeyFrame,
                        timestamp: 0,
                        type: 'key'
                    }));
                    await decoder.flush();
                } catch {
                    return unsupportedResult;
                }
                return Object.freeze({
                    outputSupported: decoderError === null
                        && outputCount === 1
                        && outputMatches
                });
            };
            return await Promise.race([
                runOutputProbe(),
                new Promise<NativeDolbyVisionVideoOutputProbeResult>(resolve => {
                    timeout = globalThis.setTimeout(
                        () => resolve(unsupportedResult),
                        VIDEO_OUTPUT_PROBE_TIMEOUT_MILLISECONDS
                    );
                })
            ]);
        } finally {
            acceptingFrame = false;
            if (timeout !== null) {
                globalThis.clearTimeout(timeout);
            }
            if (decoder.state !== 'closed') {
                decoder.close();
            }
        }
    };
}

/** Reuses the Profile 5 output probe for ordinary native HEVC Main 10 HDR. */
export function createNativeHDRVideoOutputProbe(): NativeDolbyVisionVideoOutputProbe | null {
    return createNativeDolbyVisionVideoOutputProbe();
}

function loadRawFormatVector(assetPath: EngineLibraryPath, priority: RequestPriority): Promise<ArrayBuffer> {
    return fetchCapabilityAsset(resolveEngineAssetURL(assetPath), priority);
}

function getDefaultEnvironment(): WebCodecsCapabilityEnvironment {
    return {
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        audioDecoder: typeof globalThis.AudioDecoder === 'function' ? globalThis.AudioDecoder : null,
        av1RawFormatVectorLoader: typeof globalThis.fetch === 'function' ?
            loadRawFormatVector :
            null,
        browserIdentity: readBrowserIdentity(),
        canHoldVideoFrameFormat,
        h264ProfileProbe: defaultH264ProfileCapabilityProbe,
        h264RawFormatVectorLoader: typeof globalThis.fetch === 'function' ?
            loadRawFormatVector :
            null,
        hardwareConcurrency: readHardwareConcurrency(),
        hevcRangeExtensionVectorLoader: typeof globalThis.fetch === 'function' ?
            loadRawFormatVector :
            null,
        nativeAudioOutputProbe: createNativeAudioOutputProbe(),
        nativeDolbyVisionVideoOutputProbe: createNativeDolbyVisionVideoOutputProbe(),
        nativeHDRVideoOutputProbe: createNativeHDRVideoOutputProbe(),
        nativeVideoOutputProbe: createNativeVideoOutputProbe(),
        rawHDRVideoOutputProbe: createRawHDRVideoOutputProbe(),
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        videoDecoder: typeof globalThis.VideoDecoder === 'function' ? globalThis.VideoDecoder : null
    };
}

function createUnavailableCapability<Codec extends CustomDecodeCodec>(
    codec: Codec,
    codecString: string
): CustomDecodeCodecCapability<Codec> {
    return Object.freeze({
        codec,
        codecString,
        reason: 'api-unavailable',
        status: 'unknown'
    });
}

function createNotProbedCapability<Codec extends CustomDecodeCodec>(
    codec: Codec,
    codecString: string
): CustomDecodeCodecCapability<Codec> {
    return Object.freeze({
        codec,
        codecString,
        reason: 'not-probed',
        status: 'not-probed'
    });
}

/** Creates the capability of a PCM codec, which Mediabunny decodes itself without a probe. */
function createMediabunnyAudioCapability(
    definition: AudioCodecStringDefinition<CustomMediabunnyPCMAudioCodec>
): CustomDecodeCodecCapability<CustomAudioCodec> {
    return Object.freeze({
        codec: definition.codec,
        codecString: definition.codecString,
        reason: 'mediabunny-decoder',
        status: 'supported'
    });
}

/** Creates the capability of a codec the engine has no decoder of; a media element or a decoder package may still play it. */
function createNoEngineDecoderCapability<Codec extends CustomDecodeCodec>(
    codec: Codec,
    codecString: string
): CustomDecodeCodecCapability<Codec> {
    return Object.freeze({
        codec,
        codecString,
        reason: 'no-engine-decoder',
        status: 'unsupported'
    });
}

async function probeH264Profiles(
    profileProbe: Pick<H264ProfileCapabilityProbe, 'probe'> | null | undefined,
    queue: RecordedCapabilityProbeQueue
): Promise<H264ProfileCapabilities> {
    if (profileProbe) {
        try {
            return await profileProbe.probe(queue);
        } catch {
            // Fall through to the unavailable result
        }
    }
    return new H264ProfileCapabilityProbe({
        outputProbe: null,
        videoDecoder: null
    }).probe(queue);
}

async function probeRawHDRVideoConfig(
    definition: RawHDRVideoProbeDefinition,
    decoder: DecoderCapabilityAPI<VideoDecoderConfig> | null | undefined,
    outputProbe: RawHDRVideoOutputProbe | null | undefined,
    canHoldFormat: (format: CustomDecodeRawVideoFrameFormat) => boolean,
    queue: RecordedCapabilityProbeQueue
): Promise<CustomRawHDRVideoCodecCapability> {
    const baseCapability = {
        bitDepth: 10 as const,
        codec: definition.codec,
        codecString: definition.config.codec,
        format: 'I420P10' as const
    };
    if (!decoder || !outputProbe) {
        return Object.freeze({
            ...baseCapability,
            reason: 'api-unavailable',
            status: 'unknown'
        });
    }
    // A browser whose VideoFrame cannot hold the format can never copy it out, so no decoder is asked
    if (!canHoldFormat(baseCapability.format)) {
        return Object.freeze({
            ...baseCapability,
            reason: 'output-copy-unsupported',
            status: 'unsupported'
        });
    }

    try {
        const support = await queue.check(() => decoder.isConfigSupported({ ...definition.config }), describeVideoConfigCheck(definition.config));
        if (support === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                ...baseCapability,
                reason: 'probe-timeout',
                status: 'unknown'
            });
        }
        if (support instanceof CapabilityProbeBlock) {
            return Object.freeze({
                ...baseCapability,
                reason: support.reason,
                status: 'unsupported'
            });
        }
        if (support.supported !== true) {
            return Object.freeze({
                ...baseCapability,
                reason: 'config-unsupported',
                status: 'unsupported'
            });
        }
        // A decoder pool may refuse the decode only for the decoders of the calls beside it, so the manager confirms a refusal alone
        const outputProbeResult = await queue.runTimed(() => outputProbe({
            codec: definition.codec,
            configuration: definition.config,
            encodedChunks: [ {
                data: definition.encodedKeyFrame.slice(),
                timestamp: 0,
                type: 'key'
            } ],
            expectedCodedHeight: REPRESENTATIVE_RAW_HDR_VIDEO_HEIGHT,
            expectedCodedWidth: REPRESENTATIVE_RAW_HDR_VIDEO_WIDTH,
            expectedDecodedFrames: [ {
                fingerprint: definition.expectedDecodedFrameFingerprint,
                timestamp: 0
            } ],
            expectedFormat: baseCapability.format
        }), describeRawVideoDecode(definition.config, baseCapability.format), { confirm: (result): boolean => !result.outputCopySupported });
        if (outputProbeResult === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                ...baseCapability,
                reason: 'probe-timeout',
                status: 'unknown'
            });
        }
        if (outputProbeResult instanceof CapabilityProbeBlock) {
            return Object.freeze({
                ...baseCapability,
                reason: outputProbeResult.reason,
                status: 'unsupported'
            });
        }
        if (!outputProbeResult.outputCopySupported) {
            return Object.freeze({
                ...baseCapability,
                reason: 'output-copy-unsupported',
                status: 'unsupported'
            });
        }
        return Object.freeze({
            ...baseCapability,
            reason: 'output-copy-supported',
            status: 'supported'
        });
    } catch {
        return Object.freeze({
            ...baseCapability,
            reason: 'probe-exception',
            status: 'unknown'
        });
    }
}

function createHEVCRangeExtensionBaseCapability(
    definition: HEVCRangeExtensionProbeDefinition
): Omit<HEVCRangeExtensionCapability, 'reason' | 'status'> {
    return {
        bitDepth: definition.bitDepth,
        chromaFormat: definition.chromaFormat,
        codec: 'hevc',
        codecString: definition.config.codec,
        format: definition.format,
        jellyfinProfile: definition.jellyfinProfile,
        pixelFormat: definition.pixelFormat,
        variant: definition.variant
    };
}

function createAV1RawFormatBaseCapability(
    definition: AV1RawFormatProbeDefinition
): Omit<AV1RawFormatCapability, 'reason' | 'status'> {
    return {
        bitDepth: definition.bitDepth,
        chromaFormat: definition.chromaFormat,
        codec: 'av1',
        codecString: definition.config.codec,
        format: definition.format,
        jellyfinProfile: definition.jellyfinProfile,
        pixelFormat: definition.pixelFormat,
        variant: definition.variant
    };
}

function createH264RawFormatBaseCapability(
    definition: H264RawFormatProbeDefinition
): Omit<H264RawFormatCapability, 'reason' | 'status'> {
    return {
        bitDepth: definition.bitDepth,
        chromaFormat: definition.chromaFormat,
        codec: 'h264',
        codecString: definition.config.codec,
        format: definition.format,
        jellyfinProfile: definition.jellyfinProfile,
        pixelFormat: definition.pixelFormat,
        variant: definition.variant
    };
}

// What an exact raw format probe decides: a range extension's, an AV1 raw format's, or an H.264 raw format's verdict
type ExactRawFormatProbeOutcome = Readonly<Pick<HEVCRangeExtensionCapability, 'reason' | 'status'>>;

/**
 * Qualifies one exact raw format: its configuration, then its downloaded vector's decode, copy format, and fingerprints.
 * The access units decode in their order, and their frames output in presentation order, which their timestamps give.
 */
async function probeExactRawFormatConfig<BaseCapability extends object>(
    codec: 'av1' | 'h264' | 'hevc',
    definition: Pick<HEVCRangeExtensionProbeDefinition, 'accessUnits' | 'assetPath' | 'config' | 'format'>,
    baseCapability: BaseCapability,
    environment: WebCodecsCapabilityEnvironment,
    vectorLoader: HEVCRangeExtensionVectorLoader | null | undefined,
    queue: RecordedCapabilityProbeQueue
): Promise<Readonly<BaseCapability> & ExactRawFormatProbeOutcome> {
    const { videoDecoder: decoder, rawHDRVideoOutputProbe: outputProbe } = environment;
    if (!decoder || !outputProbe || !vectorLoader) {
        return Object.freeze({
            ...baseCapability,
            reason: 'api-unavailable',
            status: 'unknown'
        });
    }
    // A browser whose VideoFrame cannot hold the format can never copy it out, so neither a decoder nor a download is spent on it
    if (!(environment.canHoldVideoFrameFormat ?? canHoldVideoFrameFormat)(definition.format)) {
        return Object.freeze({
            ...baseCapability,
            reason: 'output-copy-unsupported',
            status: 'unsupported'
        });
    }

    // The vector downloads alongside the configuration check and every other selected probe's assets
    const vectorDownload: Promise<ArrayBuffer | null> = vectorLoader(definition.assetPath, queue.assetPriority).then(
        (vectorBuffer: ArrayBuffer): ArrayBuffer => vectorBuffer,
        (): null => null
    );
    try {
        const support = await queue.check(() => decoder.isConfigSupported({ ...definition.config }), describeVideoConfigCheck(definition.config));
        if (support === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                ...baseCapability,
                reason: 'probe-timeout',
                status: 'unknown'
            });
        }
        if (support instanceof CapabilityProbeBlock) {
            return Object.freeze({
                ...baseCapability,
                reason: support.reason,
                status: 'unsupported'
            });
        }
        if (support.supported !== true) {
            return Object.freeze({
                ...baseCapability,
                reason: 'config-unsupported',
                status: 'unsupported'
            });
        }

        // NOTE: The download finishes before the timed decode, so a slow link never times out the decode's step
        const vectorBuffer = await vectorDownload;
        if (!vectorBuffer) {
            return Object.freeze({
                ...baseCapability,
                reason: 'asset-unavailable',
                status: 'unknown'
            });
        }
        // A decoder pool may refuse the decode only for the decoders of the calls beside it, so the manager confirms a refusal alone
        const outputProbeResult = await queue.runTimed(async () => {
            const vectorBytes = new Uint8Array(vectorBuffer);
            const encodedChunks: Array<
                RawHDRVideoOutputProbeRequest['encodedChunks'][number]
            > = [];
            const expectedDecodedFrames: Array<
                RawHDRVideoOutputProbeRequest['expectedDecodedFrames'][number]
            > = [];
            let byteOffset = 0;
            for (const accessUnit of definition.accessUnits) {
                const nextByteOffset = byteOffset + accessUnit.byteLength;
                if (!Number.isSafeInteger(accessUnit.byteLength)
                    || accessUnit.byteLength <= 0
                    || nextByteOffset > vectorBytes.byteLength) {
                    return Object.freeze({ outputCopySupported: false });
                }
                encodedChunks.push({
                    data: vectorBytes.slice(byteOffset, nextByteOffset),
                    timestamp: accessUnit.timestamp,
                    type: accessUnit.type
                });
                expectedDecodedFrames.push({
                    fingerprint: accessUnit.expectedDecodedFrameFingerprint,
                    timestamp: accessUnit.timestamp
                });
                byteOffset = nextByteOffset;
            }
            if (byteOffset !== vectorBytes.byteLength) {
                return Object.freeze({ outputCopySupported: false });
            }
            // A B access unit presents before the access unit it follows in decode order
            expectedDecodedFrames.sort((first, second): number => first.timestamp - second.timestamp);
            return outputProbe({
                codec,
                configuration: definition.config,
                encodedChunks,
                expectedCodedHeight: Number(definition.config.codedHeight),
                expectedCodedWidth: Number(definition.config.codedWidth),
                expectedDecodedFrames,
                expectedFormat: definition.format
            });
        }, describeRawVideoDecode(definition.config, definition.format), { confirm: (result): boolean => !result.outputCopySupported });
        if (outputProbeResult === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                ...baseCapability,
                reason: 'probe-timeout',
                status: 'unknown'
            });
        }
        if (outputProbeResult instanceof CapabilityProbeBlock) {
            return Object.freeze({
                ...baseCapability,
                reason: outputProbeResult.reason,
                status: 'unsupported'
            });
        }
        if (!outputProbeResult.outputCopySupported) {
            return Object.freeze({
                ...baseCapability,
                reason: 'output-copy-unsupported',
                status: 'unsupported'
            });
        }
        return Object.freeze({
            ...baseCapability,
            reason: 'output-copy-supported',
            status: 'supported'
        });
    } catch {
        return Object.freeze({
            ...baseCapability,
            reason: 'probe-exception',
            status: 'unknown'
        });
    }
}

async function probeVideoConfig(
    definition: VideoProbeDefinition,
    decoder: DecoderCapabilityAPI<VideoDecoderConfig> | null | undefined,
    queue: RecordedCapabilityProbeQueue
): Promise<CustomDecodeCodecCapability<CustomVideoCodec>> {
    if (!decoder) {
        return createUnavailableCapability(definition.codec, definition.config.codec);
    }

    try {
        const support = await queue.check(() => decoder.isConfigSupported({ ...definition.config }), describeVideoConfigCheck(definition.config));
        if (support === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: 'probe-timeout',
                status: 'unknown'
            });
        }
        if (support instanceof CapabilityProbeBlock) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: support.reason,
                status: 'unsupported'
            });
        }
        return Object.freeze({
            codec: definition.codec,
            codecString: definition.config.codec,
            reason: support.supported ? 'config-supported' : 'config-unsupported',
            status: support.supported ? 'supported' : 'unsupported'
        });
    } catch {
        return Object.freeze({
            codec: definition.codec,
            codecString: definition.config.codec,
            reason: 'probe-exception',
            status: 'unknown'
        });
    }
}

async function probeNativeAudioConfig(
    definition: AudioProbeDefinition,
    decoder: DecoderCapabilityAPI<AudioDecoderConfig> | null | undefined,
    outputProbe: NativeAudioOutputProbe | null | undefined,
    queue: RecordedCapabilityProbeQueue
): Promise<CustomDecodeCodecCapability<CustomWebCodecsAudioCodec>> {
    if (!decoder) {
        return createUnavailableCapability(definition.codec, definition.config.codec);
    }

    try {
        const support = await queue.check(() => decoder.isConfigSupported({ ...definition.config }), describeAudioConfigCheck(definition.config));
        if (support === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: 'probe-timeout',
                status: 'unknown'
            });
        }
        if (support instanceof CapabilityProbeBlock) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: support.reason,
                status: 'unsupported'
            });
        }
        if (support.supported !== true) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: 'config-unsupported',
                status: 'unsupported'
            });
        }
        if (!outputProbe) {
            return createUnavailableCapability(definition.codec, definition.config.codec);
        }

        const vector: AudioProbeDefinition['outputVector'] = definition.outputVector;
        const encodedChunks: Array<{
            data: Uint8Array
            duration: number
            timestamp: number
        }> = [];
        for (const chunk of vector.encodedChunks) {
            encodedChunks.push({
                data: chunk.data.slice(),
                duration: chunk.duration,
                timestamp: chunk.timestamp
            });
        }
        const requestBase = {
            codec: definition.codec,
            configuration: { ...definition.config },
            encodedChunks,
            expectedNumberOfChannels: vector.expectedNumberOfChannels,
            expectedSampleRate: vector.expectedSampleRate
        };
        const probeRequest: NativeAudioOutputProbeRequest = vector.channelTones ?
            { ...requestBase, channelTones: vector.channelTones } :
            {
                ...requestBase,
                expectedNumberOfFrames: vector.expectedNumberOfFrames,
                expectedTimestamp: vector.expectedTimestamp
            };
        // A decoder pool may refuse the decode only for the decoders of the calls beside it, so the manager confirms a refusal alone
        const outputSupported = await queue.runTimed(() => outputProbe(probeRequest), describeNativeAudioDecode(definition), {
            confirm: (supported): boolean => !supported
        });
        if (outputSupported === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: 'probe-timeout',
                status: 'unknown'
            });
        }
        if (outputSupported instanceof CapabilityProbeBlock) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: outputSupported.reason,
                status: 'unsupported'
            });
        }
        return Object.freeze({
            codec: definition.codec,
            codecString: definition.config.codec,
            reason: outputSupported ? 'decode-output-verified' : 'decode-output-missing',
            status: outputSupported ? 'supported' : 'unsupported'
        });
    } catch {
        return Object.freeze({
            codec: definition.codec,
            codecString: definition.config.codec,
            reason: 'probe-exception',
            status: 'unknown'
        });
    }
}

async function probeNativeSurroundAudioConfig(
    definition: NativeSurroundAudioProbeDefinition,
    decoder: DecoderCapabilityAPI<AudioDecoderConfig> | null | undefined,
    outputProbe: NativeAudioOutputProbe | null | undefined,
    queue: RecordedCapabilityProbeQueue
): Promise<CustomNativeSurroundAudioCodecCapability> {
    const capability = await probeNativeAudioConfig(definition, decoder, outputProbe, queue);
    return Object.freeze({
        codec: definition.codec,
        codecString: capability.codecString,
        inputChannelCount: definition.inputChannelCount,
        reason: capability.reason,
        sampleRate: NATIVE_SURROUND_AUDIO_CAPABILITY_VECTOR_SAMPLE_RATE,
        status: capability.status
    });
}

function createNativeSurroundAudioProbePromises(
    definitions: readonly NativeSurroundAudioProbeDefinition[],
    environment: WebCodecsCapabilityEnvironment,
    queue: RecordedCapabilityProbeQueue
): Array<Promise<CustomNativeSurroundAudioCodecCapability>> {
    const probePromises: Array<Promise<CustomNativeSurroundAudioCodecCapability>> = [];
    for (const definition of definitions) {
        probePromises.push(probeNativeSurroundAudioConfig(
            definition,
            environment.audioDecoder,
            environment.nativeAudioOutputProbe,
            queue
        ));
    }
    return probePromises;
}

function createNativeSurroundAudioCapabilities(
    capabilities: readonly CustomNativeSurroundAudioCodecCapability[]
): Readonly<Record<
        CustomNativeSurroundAudioCodec,
        CustomNativeSurroundAudioCodecCapability
    >> {
    const capabilitiesByCodec = {} as Record<
        CustomNativeSurroundAudioCodec,
        CustomNativeSurroundAudioCodecCapability
    >;
    for (const capability of capabilities) {
        capabilitiesByCodec[capability.codec] = capability;
    }
    return Object.freeze(capabilitiesByCodec);
}

// Counts the selected 5.1 and 7.1 probes together
function getNativeSurroundAudioProbeCount(environment: WebCodecsCapabilityEnvironment, selection: ReadonlySet<CustomDecodeProbe>): number {
    if (!environment.audioDecoder || !environment.nativeAudioOutputProbe) {
        return 0;
    }
    return (selection.has('native-surround-audio') ? NATIVE_SURROUND_AUDIO_PROBE_DEFINITIONS.length : 0)
        + (selection.has('native-seven-point-one-audio') ? NATIVE_SEVEN_POINT_ONE_AUDIO_PROBE_DEFINITIONS.length : 0);
}

async function probeNativeVideoConfig(
    definition: DecodedVideoProbeDefinition,
    decoder: DecoderCapabilityAPI<VideoDecoderConfig> | null | undefined,
    outputProbe: NativeVideoOutputProbe | null | undefined,
    queue: RecordedCapabilityProbeQueue
): Promise<CustomDecodeCodecCapability<CustomVideoCodec>> {
    if (!decoder) {
        return createUnavailableCapability(definition.codec, definition.config.codec);
    }

    try {
        const support = await queue.check(() => decoder.isConfigSupported({ ...definition.config }), describeVideoConfigCheck(definition.config));
        if (support === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: 'probe-timeout',
                status: 'unknown'
            });
        }
        if (support instanceof CapabilityProbeBlock) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: support.reason,
                status: 'unsupported'
            });
        }
        if (support.supported !== true) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: 'config-unsupported',
                status: 'unsupported'
            });
        }
        if (!outputProbe) {
            return createUnavailableCapability(definition.codec, definition.config.codec);
        }

        const vector = definition.outputVector;
        // A decoder pool may refuse the decode only for the decoders of the calls beside it, so the manager confirms a refusal alone
        const outputSupported = await queue.runTimed(() => outputProbe({
            codec: definition.codec,
            configuration: getNativeVideoOutputConfig(definition),
            encodedKeyFrame: vector.encodedKeyFrame.slice(),
            expectedCodedHeight: vector.expectedCodedHeight,
            expectedCodedWidth: vector.expectedCodedWidth,
            expectedDisplayHeight: vector.expectedDisplayHeight,
            expectedDisplayWidth: vector.expectedDisplayWidth,
            expectedTimestamp: 0
        }), describeNativeVideoDecode(definition), { confirm: (supported): boolean => !supported });
        if (outputSupported === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: 'probe-timeout',
                status: 'unknown'
            });
        }
        if (outputSupported instanceof CapabilityProbeBlock) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: outputSupported.reason,
                status: 'unsupported'
            });
        }
        return Object.freeze({
            codec: definition.codec,
            codecString: definition.config.codec,
            reason: outputSupported ? 'decode-output-verified' : 'decode-output-missing',
            status: outputSupported ? 'supported' : 'unsupported'
        });
    } catch {
        return Object.freeze({
            codec: definition.codec,
            codecString: definition.config.codec,
            reason: 'probe-exception',
            status: 'unknown'
        });
    }
}

async function probeNativeUltraHDVideoConfig(
    definition: NativeUltraHDVideoProbeDefinition,
    decoder: DecoderCapabilityAPI<VideoDecoderConfig> | null | undefined,
    outputProbe: NativeVideoOutputProbe | null | undefined,
    queue: RecordedCapabilityProbeQueue
): Promise<CustomNativeUltraHDVideoCodecCapability> {
    const capability: CustomDecodeCodecCapability<CustomVideoCodec> =
        await probeNativeVideoConfig(definition, decoder, outputProbe, queue);
    return Object.freeze({
        bitDepth: CUSTOM_NATIVE_VIDEO_BIT_DEPTH,
        codec: definition.codec,
        codecString: capability.codecString,
        reason: capability.reason,
        status: capability.status
    });
}

function createNativeUltraHDVideoCapabilities(
    capabilities: readonly CustomNativeUltraHDVideoCodecCapability[]
): Readonly<Record<
        CustomNativeUltraHDVideoCodec,
        CustomNativeUltraHDVideoCodecCapability
    >> {
    const capabilitiesByCodec = {} as Record<
        CustomNativeUltraHDVideoCodec,
        CustomNativeUltraHDVideoCodecCapability
    >;
    for (const capability of capabilities) {
        capabilitiesByCodec[capability.codec] = capability;
    }
    return Object.freeze(capabilitiesByCodec);
}

function getSelectedProbeCount(
    selection: ReadonlySet<CustomDecodeProbe>,
    probes: readonly CustomDecodeProbe[]
): number {
    return probes.filter((probe: CustomDecodeProbe): boolean => selection.has(probe)).length;
}

function getNativeUltraHDVideoProbeCount(
    environment: WebCodecsCapabilityEnvironment,
    selection: ReadonlySet<CustomDecodeProbe>
): number {
    return environment.videoDecoder && environment.nativeVideoOutputProbe ?
        getSelectedProbeCount(selection, NATIVE_ULTRA_HD_VIDEO_PROBES) :
        0;
}

function getVideoProbeCount(
    environment: WebCodecsCapabilityEnvironment,
    selection: ReadonlySet<CustomDecodeProbe>
): number {
    return environment.videoDecoder ? getSelectedProbeCount(selection, VIDEO_CONFIGURATION_PROBES) : 0;
}

type NativeHEVCFrameRouteProbeCapability = {
    reason: CustomDecodeCapabilityReason
    status: CustomDecodeCapabilityStatus
};

async function probeNativeHEVCFrameRoute(
    configuration: VideoDecoderConfig,
    encodedKeyFrame: Uint8Array,
    expectedCodedHeight: number,
    expectedCodedWidth: number,
    decoder: DecoderCapabilityAPI<VideoDecoderConfig> | null | undefined,
    outputProbe: NativeDolbyVisionVideoOutputProbe | null | undefined,
    queue: RecordedCapabilityProbeQueue
): Promise<NativeHEVCFrameRouteProbeCapability> {
    const unavailableCapability: NativeHEVCFrameRouteProbeCapability = {
        reason: 'api-unavailable',
        status: 'unknown'
    };
    if (!decoder || !outputProbe) {
        return unavailableCapability;
    }

    try {
        const support = await queue.check(() => decoder.isConfigSupported({ ...configuration }), describeVideoConfigCheck(configuration));
        if (support === CAPABILITY_PROBE_TIMEOUT) {
            return {
                ...unavailableCapability,
                reason: 'probe-timeout'
            };
        }
        if (support instanceof CapabilityProbeBlock) {
            return {
                reason: support.reason,
                status: 'unsupported'
            };
        }
        if (support.supported !== true) {
            return {
                ...unavailableCapability,
                reason: 'config-unsupported',
                status: 'unsupported'
            };
        }

        // A decoder pool may refuse the decode only for the decoders of the calls beside it, so the manager confirms a refusal alone
        const outputProbeResult = await queue.runTimed(() => outputProbe({
            configuration,
            encodedKeyFrame: new Uint8Array(encodedKeyFrame),
            expectedCodedHeight,
            expectedCodedWidth
        }), describeNativeHDRVideoDecode(configuration), { confirm: (result): boolean => !result.outputSupported });
        if (outputProbeResult === CAPABILITY_PROBE_TIMEOUT) {
            return {
                ...unavailableCapability,
                reason: 'probe-timeout'
            };
        }
        if (outputProbeResult instanceof CapabilityProbeBlock) {
            return {
                reason: outputProbeResult.reason,
                status: 'unsupported'
            };
        }
        if (!outputProbeResult.outputSupported) {
            return {
                ...unavailableCapability,
                reason: 'decode-output-missing',
                status: 'unsupported'
            };
        }
        return {
            reason: 'decode-output-verified',
            status: 'supported'
        };
    } catch {
        return {
            ...unavailableCapability,
            reason: 'probe-exception'
        };
    }
}

async function probeNativeDolbyVisionHEVC(
    decoder: DecoderCapabilityAPI<VideoDecoderConfig> | null | undefined,
    outputProbe: NativeDolbyVisionVideoOutputProbe | null | undefined,
    queue: RecordedCapabilityProbeQueue
): Promise<CustomNativeDolbyVisionHEVCCapability> {
    const routeCapability = await probeNativeHEVCFrameRoute(
        NATIVE_DOLBY_VISION_HEVC_PROBE_DEFINITION.config,
        new Uint8Array(NATIVE_DOLBY_VISION_HEVC_ACCESS_UNIT),
        NATIVE_DOLBY_VISION_HEVC_VECTOR_CODED_HEIGHT,
        NATIVE_DOLBY_VISION_HEVC_VECTOR_CODED_WIDTH,
        decoder,
        outputProbe,
        queue
    );
    return Object.freeze({
        codec: NATIVE_DOLBY_VISION_HEVC_PROBE_DEFINITION.codec,
        codecString: NATIVE_DOLBY_VISION_HEVC_PROBE_DEFINITION.config.codec,
        bitDepth: 10 as const,
        profile: 5 as const,
        ...routeCapability
    });
}

async function probeNativeHDRHEVC(
    decoder: DecoderCapabilityAPI<VideoDecoderConfig> | null | undefined,
    outputProbe: NativeDolbyVisionVideoOutputProbe | null | undefined,
    queue: RecordedCapabilityProbeQueue
): Promise<CustomNativeHDRHEVCCapability> {
    const routeCapability = await probeNativeHEVCFrameRoute(
        NATIVE_HDR_HEVC_PROBE_DEFINITION.config,
        new Uint8Array(NATIVE_HDR_HEVC_ACCESS_UNIT),
        NATIVE_HDR_HEVC_VECTOR_CODED_HEIGHT,
        NATIVE_HDR_HEVC_VECTOR_CODED_WIDTH,
        decoder,
        outputProbe,
        queue
    );
    return Object.freeze({
        codec: NATIVE_HDR_HEVC_PROBE_DEFINITION.codec,
        codecString: NATIVE_HDR_HEVC_PROBE_DEFINITION.config.codec,
        bitDepth: 10 as const,
        ...routeCapability
    });
}

async function probeNativeHDRAV1(
    decoder: DecoderCapabilityAPI<VideoDecoderConfig> | null | undefined,
    outputProbe: NativeDolbyVisionVideoOutputProbe | null | undefined,
    queue: RecordedCapabilityProbeQueue
): Promise<CustomNativeHDRAV1Capability> {
    const routeCapability = await probeNativeHEVCFrameRoute(
        NATIVE_HDR_AV1_PROBE_DEFINITION.config,
        AV1_MAIN_10_VECTOR.encodedKeyFrame,
        AV1_MAIN_10_VECTOR.codedHeight,
        AV1_MAIN_10_VECTOR.codedWidth,
        decoder,
        outputProbe,
        queue
    );
    return Object.freeze({
        bitDepth: 10 as const,
        codec: NATIVE_HDR_AV1_PROBE_DEFINITION.codec,
        codecString: NATIVE_HDR_AV1_PROBE_DEFINITION.config.codec,
        ...routeCapability
    });
}

function getProbeReason(
    environment: WebCodecsCapabilityEnvironment,
    capabilities: readonly CustomDecodeCodecCapability<CustomDecodeCodec>[]
): CustomDecodeProbeReason {
    if (capabilities.some(capability => (
        capability.reason === 'probe-exception'
        || capability.reason === 'probe-timeout'
    ))) {
        return 'probe-exceptions';
    }
    if (!environment.audioDecoder && !environment.videoDecoder) {
        return 'api-unavailable';
    }
    if (!environment.audioDecoder || !environment.videoDecoder) {
        return 'partial-api';
    }
    return 'complete';
}

function getSupportedVideoCodecCount(
    capabilities: Pick<CustomDecodeCapabilities, 'nativeUltraHDVideo' | 'video'>,
    h264Profiles: H264ProfileCapabilities | undefined
): number {
    let supportedCount = 0;
    for (const codec of CUSTOM_VIDEO_CODECS) {
        switch (codec) {
            case 'h264':
                if (Object.values(h264Profiles ?? {}).some(capability => (
                    capability.status === 'supported'
                    && capability.evidence === 'decoded-output'
                ))) {
                    supportedCount += 1;
                }
                break;
            case 'av1':
            case 'hevc':
            case 'vp9':
                if (hasSupportedNativeSDRVideoCodec(codec, capabilities)) {
                    supportedCount += 1;
                }
                break;
            default:
                if (capabilities.video[codec].status === 'supported') {
                    supportedCount += 1;
                }
                break;
        }
    }
    return supportedCount;
}

function createAudioProbePromises(
    environment: WebCodecsCapabilityEnvironment,
    queue: RecordedCapabilityProbeQueue
): Array<Promise<CustomDecodeCodecCapability<CustomAudioCodec>>> {
    const probePromises: Array<Promise<CustomDecodeCodecCapability<CustomAudioCodec>>> = [];
    for (const definition of AUDIO_PROBE_DEFINITIONS) {
        probePromises.push(probeNativeAudioConfig(
            definition,
            environment.audioDecoder,
            environment.nativeAudioOutputProbe,
            queue
        ));
    }
    return probePromises;
}

function createHEVCRangeExtensionCapabilities(
    capabilities: readonly HEVCRangeExtensionCapability[]
): Readonly<Record<HEVCRangeExtensionVariant, HEVCRangeExtensionCapability>> {
    const hevcRangeExtensions = {} as Record<
        HEVCRangeExtensionVariant,
        HEVCRangeExtensionCapability
    >;
    for (const capability of capabilities) {
        hevcRangeExtensions[capability.variant] = capability;
    }
    return Object.freeze(hevcRangeExtensions);
}

function createNotProbedNativeUltraHDVideoCapability(
    definition: NativeUltraHDVideoProbeDefinition
): CustomNativeUltraHDVideoCodecCapability {
    return Object.freeze({
        bitDepth: CUSTOM_NATIVE_VIDEO_BIT_DEPTH,
        codec: definition.codec,
        codecString: definition.config.codec,
        reason: 'not-probed',
        status: 'not-probed'
    });
}

function createNotProbedRawVideoCapability(definition: RawHDRVideoProbeDefinition): CustomRawHDRVideoCodecCapability {
    return Object.freeze({
        bitDepth: 10,
        codec: definition.codec,
        codecString: definition.config.codec,
        format: 'I420P10',
        reason: 'not-probed',
        status: 'not-probed'
    });
}

function createNotProbedHEVCRangeExtensionCapability(variant: HEVCRangeExtensionVariant): HEVCRangeExtensionCapability {
    return Object.freeze({
        ...createHEVCRangeExtensionBaseCapability(HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant]),
        reason: 'not-probed',
        status: 'not-probed'
    });
}

function createNotProbedAV1RawFormatCapability(variant: AV1RawFormatVariant): AV1RawFormatCapability {
    return Object.freeze({
        ...createAV1RawFormatBaseCapability(AV1_RAW_FORMAT_PROBE_DEFINITIONS[variant]),
        reason: 'not-probed',
        status: 'not-probed'
    });
}

function createAV1RawFormatCapabilities(
    capabilities: readonly AV1RawFormatCapability[]
): Readonly<Record<AV1RawFormatVariant, AV1RawFormatCapability>> {
    const av1RawFormats = {} as Record<AV1RawFormatVariant, AV1RawFormatCapability>;
    for (const capability of capabilities) {
        av1RawFormats[capability.variant] = capability;
    }
    return Object.freeze(av1RawFormats);
}

function createNotProbedH264RawFormatCapability(variant: H264RawFormatVariant): H264RawFormatCapability {
    return Object.freeze({
        ...createH264RawFormatBaseCapability(H264_RAW_FORMAT_PROBE_DEFINITIONS[variant]),
        reason: 'not-probed',
        status: 'not-probed'
    });
}

function createH264RawFormatCapabilities(
    capabilities: readonly H264RawFormatCapability[]
): Readonly<Record<H264RawFormatVariant, H264RawFormatCapability>> {
    const h264RawFormats = {} as Record<H264RawFormatVariant, H264RawFormatCapability>;
    for (const capability of capabilities) {
        h264RawFormats[capability.variant] = capability;
    }
    return Object.freeze(h264RawFormats);
}

const NOT_PROBED_NATIVE_DOLBY_VISION_HEVC_CAPABILITY: CustomNativeDolbyVisionHEVCCapability = Object.freeze({
    bitDepth: 10,
    codec: 'hevc',
    codecString: NATIVE_DOLBY_VISION_HEVC_PROBE_DEFINITION.config.codec,
    profile: 5,
    reason: 'not-probed',
    status: 'not-probed'
});

const NOT_PROBED_NATIVE_HDR_HEVC_CAPABILITY: CustomNativeHDRHEVCCapability = Object.freeze({
    bitDepth: 10,
    codec: 'hevc',
    codecString: NATIVE_HDR_HEVC_PROBE_DEFINITION.config.codec,
    reason: 'not-probed',
    status: 'not-probed'
});

const NOT_PROBED_NATIVE_HDR_AV1_CAPABILITY: CustomNativeHDRAV1Capability = Object.freeze({
    bitDepth: 10,
    codec: 'av1',
    codecString: NATIVE_HDR_AV1_PROBE_DEFINITION.config.codec,
    reason: 'not-probed',
    status: 'not-probed'
});

// The audio probes' results when a run leaves them out, as it does once one was in a browser call when a page stopped
const NOT_PROBED_NATIVE_AUDIO_CAPABILITIES: readonly CustomDecodeCodecCapability<CustomAudioCodec>[] = Object.freeze(AUDIO_PROBE_DEFINITIONS.map(
    (definition: AudioProbeDefinition): CustomDecodeCodecCapability<CustomAudioCodec> => createNotProbedCapability(definition.codec, definition.config.codec)
));

function createNotProbedNativeSurroundAudioCapabilities(
    definitions: readonly NativeSurroundAudioProbeDefinition[]
): readonly CustomNativeSurroundAudioCodecCapability[] {
    return Object.freeze(definitions.map((definition: NativeSurroundAudioProbeDefinition): CustomNativeSurroundAudioCodecCapability => Object.freeze({
        codec: definition.codec,
        codecString: definition.config.codec,
        inputChannelCount: definition.inputChannelCount,
        reason: 'not-probed',
        sampleRate: NATIVE_SURROUND_AUDIO_CAPABILITY_VECTOR_SAMPLE_RATE,
        status: 'not-probed'
    })));
}

const NOT_PROBED_NATIVE_SURROUND_AUDIO_CAPABILITIES = createNotProbedNativeSurroundAudioCapabilities(NATIVE_SURROUND_AUDIO_PROBE_DEFINITIONS);
const NOT_PROBED_NATIVE_SEVEN_POINT_ONE_AUDIO_CAPABILITIES = createNotProbedNativeSurroundAudioCapabilities(NATIVE_SEVEN_POINT_ONE_AUDIO_PROBE_DEFINITIONS);

// Dolby Vision and incomplete metadata are unknown
type VideoStreamDynamicRange = 'sdr' | 'static-hdr' | 'unknown';

type ProbeSelectionMediaStream = {
    BitDepth?: unknown
    Codec?: unknown
    Type?: unknown
};

type ProbeSelectionMediaSource = {
    MediaStreams?: unknown
};

type ProbeSelectionItem = ProbeSelectionMediaSource & {
    MediaSources?: unknown
};

function normalizeMetadataValue(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const normalizedValue = value.trim().toUpperCase();
    return normalizedValue || null;
}

function hasMediaStreamMetadata(value: unknown): value is { MediaStreams: readonly unknown[] } {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const mediaStreams = (value as ProbeSelectionMediaSource).MediaStreams;
    return Array.isArray(mediaStreams) && mediaStreams.length > 0;
}

/** Returns the stream lists of an item's sources, or null when the item or any of its sources lacks stream metadata. */
function getItemMediaStreamLists(item: unknown): Array<readonly unknown[]> | null {
    if (!item || typeof item !== 'object') {
        return null;
    }
    const selectionItem = item as ProbeSelectionItem;
    if (!Array.isArray(selectionItem.MediaSources)) {
        return hasMediaStreamMetadata(selectionItem) ? [ selectionItem.MediaStreams ] : null;
    }
    const mediaStreamLists: Array<readonly unknown[]> = [];
    for (const mediaSource of selectionItem.MediaSources) {
        if (!hasMediaStreamMetadata(mediaSource)) {
            return null;
        }
        mediaStreamLists.push(mediaSource.MediaStreams);
    }
    return mediaStreamLists.length > 0 ? mediaStreamLists : null;
}

function getVideoMediaStreams(mediaStreamLists: ReadonlyArray<readonly unknown[]>): ProbeSelectionMediaStream[] {
    const videoStreams: ProbeSelectionMediaStream[] = [];
    for (const mediaStreams of mediaStreamLists) {
        for (const stream of mediaStreams) {
            if (
                stream
                && typeof stream === 'object'
                && normalizeMetadataValue((stream as ProbeSelectionMediaStream).Type) === 'VIDEO'
            ) {
                videoStreams.push(stream as ProbeSelectionMediaStream);
            }
        }
    }
    return videoStreams;
}

/** Classifies a video stream's range: positively identified SDR, static PQ or HLG, or unknown. */
function getVideoStreamDynamicRange(stream: ProbeSelectionMediaStream): VideoStreamDynamicRange {
    const presentationOptions = { mediaSource: { MediaStreams: [ stream ] } };
    if (isKnownSDRPresentationInput(presentationOptions)) {
        return 'sdr';
    }
    const transfer = getPresentationInputColorMetadata(presentationOptions)?.transfer;
    return transfer === 'pq' || transfer === 'hlg' ? 'static-hdr' : 'unknown';
}

/** Returns whether a stream may carry more than 8 bits; an absent or unreadable depth may. */
function mayExceedNativeVideoBitDepth(stream: ProbeSelectionMediaStream): boolean {
    const bitDepth: number = stream.BitDepth == null || stream.BitDepth === '' ?
        Number.NaN :
        Number(stream.BitDepth);
    return !Number.isFinite(bitDepth) || bitDepth > CUSTOM_NATIVE_VIDEO_BIT_DEPTH;
}

function addHEVCStreamProbes(
    stream: ProbeSelectionMediaStream,
    dynamicRange: VideoStreamDynamicRange,
    beyondNativeSDR: boolean,
    probes: Set<CustomDecodeVideoProbe>
): void {
    probes.add('native-sdr:hevc');
    probes.add('native-ultra-hd:hevc');
    const rangeExtensionVariants = getHEVCRangeExtensionNegotiationVariants(stream);
    for (const variant of rangeExtensionVariants) {
        probes.add(getHEVCRangeExtensionVideoProbe(variant));
    }
    // A range extension decodes only through its own variants
    if (beyondNativeSDR && rangeExtensionVariants.length === 0) {
        probes.add('native-hdr-hevc');
        probes.add('raw:hevc');
    }
    // An unknown range may be Dolby Vision, whose Profile 5 has a native route
    if (dynamicRange === 'unknown') {
        probes.add('native-dolby-vision-hevc');
    }
}

/**
 * Adds the exact raw format probe of an AV1 stream outside Main 10: High and Professional always, since only raw planes or a package decode them, and
 * Main at 8 bits only beyond native SDR, where Dolby Vision reconstruction needs its I420 planes.
 */
function addAV1RawFormatProbe(stream: ProbeSelectionMediaStream, beyondNativeSDR: boolean, probes: Set<CustomDecodeVideoProbe>): void {
    const definition = getAV1RawFormatStreamDefinitionFromMetadata(stream);
    if (definition && (beyondNativeSDR || definition.jellyfinProfile !== 'Main')) {
        probes.add(getAV1RawFormatVideoProbe(definition.variant));
    }
}

function addVideoStreamProbes(
    stream: ProbeSelectionMediaStream,
    codec: CustomVideoCodec,
    dynamicRange: VideoStreamDynamicRange,
    probes: Set<CustomDecodeVideoProbe>
): void {
    // HDR, Dolby Vision, and depths beyond 8 bits present through raw planes or native HEVC Main 10
    const beyondNativeSDR = dynamicRange !== 'sdr' || mayExceedNativeVideoBitDepth(stream);
    switch (codec) {
        case 'av1':
            probes.add(getNativeSDRVideoProbe(codec));
            probes.add(getNativeUltraHDVideoProbe(codec));
            if (beyondNativeSDR) {
                probes.add('native-hdr-av1');
                probes.add(getRawVideoProbe(codec));
            }
            addAV1RawFormatProbe(stream, beyondNativeSDR, probes);
            break;
        case 'vp9':
            probes.add(getNativeSDRVideoProbe(codec));
            probes.add(getNativeUltraHDVideoProbe(codec));
            if (beyondNativeSDR) {
                probes.add(getRawVideoProbe(codec));
            }
            break;
        case 'h264':
            probes.add('h264-profiles');
            // A profile beyond High negotiates only when every variant it codes at the stream's depth qualifies
            for (const variant of getH264RawFormatNegotiationVariants(stream)) {
                probes.add(getH264RawFormatVideoProbe(variant));
            }
            break;
        case 'hevc':
            addHEVCStreamProbes(stream, dynamicRange, beyondNativeSDR, probes);
            break;
        case 'jpeg2000':
        case 'mpeg1video':
        case 'mpeg2video':
        case 'vc1':
        case 'wmv3':
        case 'mpeg4':
        case 'h263':
        case 'msmpeg4v1':
        case 'msmpeg4v2':
        case 'msmpeg4v3':
            // Only a GPU decoder package decodes these, and it verifies itself
            break;
        case 'vp8':
            probes.add(getNativeSDRVideoProbe(codec));
            break;
    }
}

/** Returns the video probes an item's streams need, or null when its metadata cannot scope them. */
function selectItemVideoProbes(item: unknown): ReadonlySet<CustomDecodeVideoProbe> | null {
    const mediaStreamLists = getItemMediaStreamLists(item);
    if (!mediaStreamLists) {
        return null;
    }
    const probes = new Set<CustomDecodeVideoProbe>();
    let HDRSourcePresent = false;
    for (const stream of getVideoMediaStreams(mediaStreamLists)) {
        const codecName = normalizeMetadataValue(stream.Codec);
        // A video stream that names no codec could need any probe
        if (!codecName) {
            return null;
        }
        const dynamicRange = getVideoStreamDynamicRange(stream);
        HDRSourcePresent ||= dynamicRange !== 'sdr';
        const codec = CUSTOM_VIDEO_CODEC_NAMES.get(codecName);
        // A codec no custom route decodes needs no probe of its own
        if (codec) {
            addVideoStreamProbes(stream, codec, dynamicRange, probes);
        }
    }
    if (HDRSourcePresent) {
        for (const probe of HDR_TRANSCODE_TARGET_VIDEO_PROBES) {
            probes.add(probe);
        }
    }
    return probes;
}

/**
 * Returns the probes an item needs, in the order a run starts them.
 * Every audio probe runs, because a playing item can switch to any of its audio tracks.
 * The video probes follow the union of the video streams across the item's sources, and an item without stream metadata runs them all.
 */
export function selectCustomDecodeProbes(item: unknown): readonly CustomDecodeProbe[] {
    const videoProbes = selectItemVideoProbes(item);
    const selection: CustomDecodeProbe[] = [ ...CUSTOM_DECODE_AUDIO_PROBES ];
    for (const probe of CUSTOM_DECODE_VIDEO_PROBES) {
        if (!videoProbes || videoProbes.has(probe)) {
            selection.push(probe);
        }
    }
    return selection;
}

/**
 * Returns whether a result ran every probe an item or media source selects.
 * A result without probe states ran every probe.
 */
export function hasProbedCustomDecodeSelection(capabilities: CustomDecodeCapabilities, item: unknown): boolean {
    const probeStates = capabilities.probeStates;
    if (!probeStates) {
        return true;
    }
    return selectCustomDecodeProbes(item).every((probe: CustomDecodeProbe): boolean => probeStates[probe] === 'probed');
}

function createProbeStates(
    selection: ReadonlySet<CustomDecodeProbe>
): Readonly<Record<CustomDecodeProbe, CustomDecodeProbeState>> {
    const probeStates = {} as Record<CustomDecodeProbe, CustomDecodeProbeState>;
    for (const probe of [ ...CUSTOM_DECODE_AUDIO_PROBES, ...CUSTOM_DECODE_VIDEO_PROBES ]) {
        probeStates[probe] = selection.has(probe) ? 'probed' : 'not-probed';
    }
    return Object.freeze(probeStates);
}

type AudioProbeResults = Readonly<{
    nativeAudio: readonly CustomDecodeCodecCapability<CustomAudioCodec>[]
    nativeSevenPointOneAudio: readonly CustomNativeSurroundAudioCodecCapability[]
    nativeSurroundAudio: readonly CustomNativeSurroundAudioCodecCapability[]
}>;

type H264ProbeResult = Readonly<{
    configuration: CustomDecodeCodecCapability<CustomVideoCodec>
    profiles: H264ProfileCapabilities
}>;

// An unselected probe holds its not-probed result, or null for the H.264 probe
type VideoProbeResults = Readonly<{
    av1RawFormats: readonly AV1RawFormatCapability[]
    h264: H264ProbeResult | null
    h264RawFormats: readonly H264RawFormatCapability[]
    hevcRangeExtensions: readonly HEVCRangeExtensionCapability[]
    nativeDolbyVisionHEVC: CustomNativeDolbyVisionHEVCCapability
    nativeHDRAV1: CustomNativeHDRAV1Capability
    nativeHDRHEVC: CustomNativeHDRHEVCCapability
    nativeSDRVideo: readonly CustomDecodeCodecCapability<CustomVideoCodec>[]
    nativeUltraHDVideo: readonly CustomNativeUltraHDVideoCodecCapability[]
    rawVideo: readonly CustomRawHDRVideoCodecCapability[]
}>;

type ProbeTelemetryCapabilities = Pick<CustomDecodeCapabilities, 'h264Profiles'> & Required<Pick<
    CustomDecodeCapabilities,
    | 'audio'
    | 'nativeDolbyVisionHEVC'
    | 'nativeHDRAV1'
    | 'nativeHDRHEVC'
    | 'nativeSevenPointOneAudio'
    | 'nativeSurroundAudio'
    | 'nativeUltraHDVideo'
    | 'rawHDRVideo'
    | 'video'
>>;

async function probeH264(
    environment: WebCodecsCapabilityEnvironment,
    queue: RecordedCapabilityProbeQueue
): Promise<H264ProbeResult> {
    const [ configuration, profiles ] = await Promise.all([
        probeVideoConfig(H264_CONFIGURATION_PROBE_DEFINITION, environment.videoDecoder, queue),
        probeH264Profiles(environment.h264ProfileProbe, queue)
    ]);
    return { configuration, profiles };
}

function createVideoCodecCapabilities(
    videoResults: VideoProbeResults
): Readonly<Record<CustomVideoCodec, CustomDecodeCodecCapability<CustomVideoCodec>>> {
    const videoCapabilities: Array<CustomDecodeCodecCapability<CustomVideoCodec>> = [];
    videoCapabilities.push(
        videoResults.h264?.configuration
            ?? createNotProbedCapability('h264', H264_CONFIGURATION_PROBE_DEFINITION.config.codec),
        ...videoResults.nativeSDRVideo,
        // JPEG 2000's codec string is its MJ2 sample entry; the others' are their names
        ...CUSTOM_PACKAGE_VIDEO_CODECS.map((codec: CustomPackageVideoCodec): CustomDecodeCodecCapability<CustomVideoCodec> => (
            createNoEngineDecoderCapability(codec, codec === 'jpeg2000' ? JPEG2000_CODEC_STRING : codec)
        ))
    );
    const video = {} as Record<CustomVideoCodec, CustomDecodeCodecCapability<CustomVideoCodec>>;
    for (const capability of videoCapabilities) {
        video[capability.codec] = capability;
    }
    return Object.freeze(video);
}

function createAudioCodecCapabilities(
    audioResults: AudioProbeResults
): Readonly<Record<CustomAudioCodec, CustomDecodeCodecCapability<CustomAudioCodec>>> {
    const audioCapabilities: Array<CustomDecodeCodecCapability<CustomAudioCodec>> = [];
    audioCapabilities.push(...audioResults.nativeAudio);
    for (const definition of MEDIABUNNY_PCM_AUDIO_CODEC_DEFINITIONS) {
        audioCapabilities.push(createMediabunnyAudioCapability(definition));
    }
    for (const definition of PACKAGE_AUDIO_CODEC_DEFINITIONS) {
        audioCapabilities.push(createNoEngineDecoderCapability(definition.codec, definition.codecString));
    }
    const audio = {} as Record<CustomAudioCodec, CustomDecodeCodecCapability<CustomAudioCodec>>;
    for (const capability of audioCapabilities) {
        audio[capability.codec] = capability;
    }
    return Object.freeze(audio);
}

function createRawHDRVideoCapabilities(
    probedCapabilities: readonly CustomRawHDRVideoCodecCapability[]
): Readonly<Record<CustomRawHDRVideoCodec, CustomRawHDRVideoCodecCapability>> {
    const rawHDRVideo = {} as Record<CustomRawHDRVideoCodec, CustomRawHDRVideoCodecCapability>;
    for (const capability of probedCapabilities) {
        rawHDRVideo[capability.codec] = capability;
    }
    return Object.freeze(rawHDRVideo);
}

function countCapabilityStatus(
    capabilities: ReadonlyArray<Readonly<{ status: CustomDecodeCapabilityStatus }>>,
    status: CustomDecodeCapabilityStatus
): number {
    return capabilities.filter((capability: Readonly<{ status: CustomDecodeCapabilityStatus }>): boolean => (
        capability.status === status
    )).length;
}

function createProbeTelemetry(
    environment: WebCodecsCapabilityEnvironment,
    selection: ReadonlySet<CustomDecodeProbe>,
    capabilities: ProbeTelemetryCapabilities
): Readonly<CustomDecodeProbeTelemetry> {
    const audioCapabilities = Object.values(capabilities.audio);
    const videoCapabilities = Object.values(capabilities.video);
    // The surround telemetry counts the 5.1 and the 7.1 verdicts together
    const nativeSurroundAudioCapabilities = [
        ...Object.values(capabilities.nativeSurroundAudio),
        ...Object.values(capabilities.nativeSevenPointOneAudio)
    ];
    const nativeUltraHDVideoCapabilities = Object.values(capabilities.nativeUltraHDVideo);
    const allCapabilities: Array<CustomDecodeCodecCapability<CustomDecodeCodec>> = [];
    allCapabilities.push(
        ...videoCapabilities,
        ...audioCapabilities,
        capabilities.nativeDolbyVisionHEVC,
        capabilities.nativeHDRAV1,
        capabilities.nativeHDRHEVC,
        ...nativeSurroundAudioCapabilities,
        ...nativeUltraHDVideoCapabilities
    );
    const nativeHDRVideoOutputAvailable = Boolean(environment.videoDecoder && environment.nativeHDRVideoOutputProbe);
    const rawVideoOutputAvailable = Boolean(environment.videoDecoder && environment.rawHDRVideoOutputProbe);
    return Object.freeze({
        audioProbeCount: environment.audioDecoder && selection.has('native-audio') ? AUDIO_PROBE_DEFINITIONS.length : 0,
        mediabunnyAudioCodecCount: MEDIABUNNY_PCM_AUDIO_CODEC_DEFINITIONS.length,
        nativeSurroundAudioProbeCount: getNativeSurroundAudioProbeCount(environment, selection),
        nativeHDRVideoProbeCount: nativeHDRVideoOutputAvailable ? getSelectedProbeCount(selection, NATIVE_HDR_VIDEO_PROBES) : 0,
        nativeUltraHDVideoProbeCount: getNativeUltraHDVideoProbeCount(environment, selection),
        rawHDRVideoProbeCount: rawVideoOutputAvailable ? getSelectedProbeCount(selection, RAW_VIDEO_PROBES) : 0,
        reason: getProbeReason(environment, allCapabilities),
        supportedAudioCodecCount: countCapabilityStatus(audioCapabilities, 'supported'),
        supportedNativeSurroundAudioCodecCount: countCapabilityStatus(nativeSurroundAudioCapabilities, 'supported'),
        supportedNativeHDRVideoCodecCount: countCapabilityStatus([ capabilities.nativeHDRAV1, capabilities.nativeHDRHEVC ], 'supported'),
        supportedNativeUltraHDVideoCodecCount: countCapabilityStatus(nativeUltraHDVideoCapabilities, 'supported'),
        supportedRawHDRVideoCodecCount: countCapabilityStatus(Object.values(capabilities.rawHDRVideo), 'supported'),
        supportedVideoCodecCount: getSupportedVideoCodecCount(capabilities, capabilities.h264Profiles),
        unknownAudioCodecCount: countCapabilityStatus(audioCapabilities, 'unknown'),
        unknownNativeSurroundAudioCodecCount: countCapabilityStatus(nativeSurroundAudioCapabilities, 'unknown'),
        unknownNativeHDRVideoCodecCount: countCapabilityStatus([ capabilities.nativeHDRAV1, capabilities.nativeHDRHEVC ], 'unknown'),
        unknownNativeUltraHDVideoCodecCount: countCapabilityStatus(nativeUltraHDVideoCapabilities, 'unknown'),
        unknownVideoCodecCount: countCapabilityStatus(videoCapabilities, 'unknown'),
        videoProbeCount: getVideoProbeCount(environment, selection)
    });
}

function createCustomDecodeCapabilities(
    environment: WebCodecsCapabilityEnvironment,
    selection: ReadonlySet<CustomDecodeProbe>,
    audioResults: AudioProbeResults,
    videoResults: VideoProbeResults
): CustomDecodeCapabilities {
    const capabilities: ProbeTelemetryCapabilities = {
        // An H.264 profile result is absent when the probe did not run
        ...(videoResults.h264 ? { h264Profiles: videoResults.h264.profiles } : {}),
        audio: createAudioCodecCapabilities(audioResults),
        nativeDolbyVisionHEVC: videoResults.nativeDolbyVisionHEVC,
        nativeHDRAV1: videoResults.nativeHDRAV1,
        nativeHDRHEVC: videoResults.nativeHDRHEVC,
        nativeSevenPointOneAudio: createNativeSurroundAudioCapabilities(audioResults.nativeSevenPointOneAudio),
        nativeSurroundAudio: createNativeSurroundAudioCapabilities(audioResults.nativeSurroundAudio),
        nativeUltraHDVideo: createNativeUltraHDVideoCapabilities(videoResults.nativeUltraHDVideo),
        rawHDRVideo: createRawHDRVideoCapabilities(videoResults.rawVideo),
        video: createVideoCodecCapabilities(videoResults)
    };
    return Object.freeze({
        ...capabilities,
        av1RawFormats: createAV1RawFormatCapabilities(videoResults.av1RawFormats),
        h264RawFormats: createH264RawFormatCapabilities(videoResults.h264RawFormats),
        hevcRangeExtensions: createHEVCRangeExtensionCapabilities(videoResults.hevcRangeExtensions),
        probeStates: createProbeStates(selection),
        telemetry: createProbeTelemetry(environment, selection, capabilities)
    });
}

/** The longest a background probe step waits for an idle period before it runs anyway. */
export const BACKGROUND_PROBE_IDLE_TIMEOUT_MILLISECONDS = 2_000;
/** How long a held background step waits before it looks again: while media plays, or around a negotiation. */
export const BACKGROUND_PROBE_RECHECK_MILLISECONDS = 1_000;
/** How long background probes hold off after a negotiation settles, the time its playback takes to start. */
export const BACKGROUND_PROBE_NEGOTIATION_HOLD_MILLISECONDS = 10_000;
// A client with fewer threads than this gets no warm-up, nor one that asks to save data
const WARM_UP_MINIMUM_HARDWARE_CONCURRENCY = 4;

export type CustomDecodeCapabilityProbeOptions = Readonly<{
    /** Returns whether media plays; background probes wait while it does */
    isPlaybackActive?: () => boolean
    now?: () => number
    /** Whether a negotiation a stored verdict served reruns its probe in the background; defaults to true */
    refreshAfterUse?: boolean
    /** The verdicts kept across page loads; without one, every page probes again */
    store?: CapabilityProbeStore | null
    /** Resolves at the next idle period, or as soon as `cancel` settles */
    waitForIdle?: (cancel: Promise<void>) => Promise<void>
}>;

type ProbeStarter = (queue: RecordedCapabilityProbeQueue, environment: WebCodecsCapabilityEnvironment) => Promise<unknown>;

// A warm-up runs a probe nothing asked for yet; a refresh reruns one whose stored verdict a negotiation used
type BackgroundProbeKind = 'refresh' | 'warm-up';

type BackgroundProbeOutcome = Readonly<{
    // A timed-out or failed background run never becomes the page's result
    discarded: boolean
    result: unknown
}>;

type BackgroundProbe = Readonly<{
    outcome: Promise<BackgroundProbeOutcome>
    run: BackgroundCapabilityProbeRun
}>;

/** A host's background task, which waits behind the page's background probes, and whose promise settles whether it ran. */
type BackgroundTask = Readonly<{
    settle: (ran: boolean) => void
    task: () => Promise<void>
}>;

/** Resolves after a delay, or as soon as `cancel` settles. */
function waitForDelay(milliseconds: number, cancel: Promise<void>): Promise<void> {
    return new Promise<void>((resolve) => {
        const timeout = globalThis.setTimeout(resolve, milliseconds);
        void cancel.then((): void => {
            globalThis.clearTimeout(timeout);
            resolve();
        });
    });
}

/**
 * Resolves at the next idle period, after at most BACKGROUND_PROBE_IDLE_TIMEOUT_MILLISECONDS, or as soon as `cancel` settles.
 * Without requestIdleCallback, as on WebKit, it waits that whole bound.
 */
function waitForIdlePeriod(cancel: Promise<void>): Promise<void> {
    if (typeof globalThis.requestIdleCallback !== 'function') {
        return waitForDelay(BACKGROUND_PROBE_IDLE_TIMEOUT_MILLISECONDS, cancel);
    }
    return new Promise<void>((resolve) => {
        // eslint-disable-next-line compat/compat -- Feature-detected above; WebKit waits out the bound instead
        const handle = globalThis.requestIdleCallback((): void => resolve(), { timeout: BACKGROUND_PROBE_IDLE_TIMEOUT_MILLISECONDS });
        void cancel.then((): void => {
            globalThis.cancelIdleCallback(handle);
            resolve();
        });
    });
}

/**
 * Probes decode capabilities per item; each probe runs once per page, and a later item reuses its result.
 * A probe with a stored verdict for this fingerprint takes it at once and, unless refresh after use is off, reruns in the background, and each verdict a run reaches is stored.
 */
export default class CustomDecodeCapabilityProbe {
    private backgroundDriverActive = false;
    private readonly backgroundProbes = new Map<CustomDecodeProbe, BackgroundProbe>();
    private readonly backgroundQueue = new Map<CustomDecodeProbe, BackgroundProbeKind>();
    // Host tasks run one at a time, each once the probes queued before its turn are done
    private readonly backgroundTasks: BackgroundTask[] = [];
    private environment: WebCodecsCapabilityEnvironment | null;
    private isPlaybackActive: () => boolean;
    private negotiationCount = 0;
    private negotiationHoldEnd = Number.NEGATIVE_INFINITY;
    private readonly now: () => number;
    private refreshAfterUse: boolean;
    private readonly probeResults = new Map<CustomDecodeProbe, Promise<unknown>>();
    private probeStarters: ReadonlyMap<CustomDecodeProbe, ProbeStarter> | null = null;
    private session: CapabilityProbeSession | null = null;
    private readonly selectionResults = new Map<string, Promise<CustomDecodeCapabilities>>();
    private readonly store: CapabilityProbeStore | null;
    // The probes whose page result is still the stored verdict, which a clear drops
    private readonly storedProbes = new Set<CustomDecodeProbe>();
    private readonly waitForIdle: (cancel: Promise<void>) => Promise<void>;
    private warmUpStarted = false;

    public constructor(
        environment: WebCodecsCapabilityEnvironment | null = null,
        options: CustomDecodeCapabilityProbeOptions = {}
    ) {
        this.environment = environment;
        this.isPlaybackActive = options.isPlaybackActive ?? ((): boolean => false);
        this.now = options.now ?? ((): number => globalThis.performance.now());
        this.refreshAfterUse = options.refreshAfterUse ?? true;
        this.store = options.store ?? null;
        this.waitForIdle = options.waitForIdle ?? waitForIdlePeriod;
        this.store?.onClear((): void => this.forgetStoredVerdicts());
    }

    /**
     * Returns the capabilities an item needs; items that select the same probes share one result.
     * Without an item, or for one without stream metadata, every probe runs.
     * A probe a background run has started is promoted to full speed and shared; one it timed out on runs again.
     */
    public probe(item?: unknown): Promise<CustomDecodeCapabilities> {
        const selection = selectCustomDecodeProbes(item);
        const selectionKey = selection.join(',');
        let capabilities = this.selectionResults.get(selectionKey);
        if (!capabilities) {
            capabilities = this.runProbes(new Set<CustomDecodeProbe>(selection));
            this.selectionResults.set(selectionKey, capabilities);
        }
        this.holdBackgroundFor(capabilities);
        return capabilities;
    }

    /** Sets what background probes ask before each step, so none runs while media plays. */
    public setPlaybackActivity(isPlaybackActive: () => boolean): void {
        this.isPlaybackActive = isPlaybackActive;
    }

    /**
     * Sets whether a negotiation a stored verdict served reruns its probe in the background.
     * Turning it off schedules no further refresh; a refresh already queued still runs.
     */
    public setRefreshAfterUse(refreshAfterUse: boolean): void {
        this.refreshAfterUse = refreshAfterUse;
    }

    /**
     * Starts every probe without a result or stored verdict in the background, once per page.
     * Each step waits for an idle period, for no negotiation to be under way or just settled, and for no media to play, and its downloads are low priority.
     */
    public warmUp(): void {
        if (this.warmUpStarted) {
            return;
        }
        this.warmUpStarted = true;
        this.scheduleBackgroundProbes([ ...CUSTOM_DECODE_AUDIO_PROBES, ...CUSTOM_DECODE_VIDEO_PROBES ], 'warm-up');
    }

    /**
     * Returns the probe's session, whose manager runs every browser call of its probes side by side within the device's limits,
     * and which blocks, orders, and records each call. The page's other probes join the page's default one.
     */
    public getSession(): CapabilityProbeSession {
        if (!this.session) {
            const environment = this.getEnvironment();
            const hardwareConcurrency = environment.hardwareConcurrency === undefined ? readHardwareConcurrency() : environment.hardwareConcurrency;
            this.session = new CapabilityProbeSession({
                browserIdentity: environment.browserIdentity ?? readBrowserIdentity(),
                limits: { bytes: CAPABILITY_PROBE_DEFINITION_BYTES, decoders: getCapabilityProbeDecoderLimit(hardwareConcurrency) },
                store: this.store,
                timeoutMilliseconds: VIDEO_OUTPUT_PROBE_TIMEOUT_MILLISECONDS
            });
        }
        return this.session;
    }

    /**
     * Runs a task in the background once every background probe queued ahead of its turn is done, at a turn the probes would take:
     * an idle period with no negotiation under way or just settled and no media playing. Tasks run one at a time, in the order they came.
     * Resolves whether it ran; a task that rejects counts as run. A page whose background halted, after a background timeout or once its probing stopped, drops it.
     */
    public runInBackground(task: () => Promise<void>): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            this.backgroundTasks.push({ settle: resolve, task });
            this.startBackgroundDriver();
        });
    }

    private getEnvironment(): WebCodecsCapabilityEnvironment {
        this.environment ??= getDefaultEnvironment();
        return this.environment;
    }

    private async runProbes(selection: ReadonlySet<CustomDecodeProbe>): Promise<CustomDecodeCapabilities> {
        const environment = this.getEnvironment();
        const session = this.getSession();
        // A step that stopped an earlier page alone never runs again for this fingerprint, and its suspects run last and alone
        await session.readQuarantine();
        const audioProbes = this.startAudioProbes(selection);
        // Video decodes join the manager behind every audio probe, so a video timeout never costs audio its verdicts
        const videoProbes = this.startVideoProbes(selection, session.manager.after(audioProbes));
        const [ audioResults, videoResults ] = await Promise.all([ audioProbes, videoProbes ]);
        return createCustomDecodeCapabilities(environment, selection, audioResults, videoResults);
    }

    /** Starts every selected audio probe once per page; every item selects them all, because a playing item can switch to any of its audio tracks. */
    private async startAudioProbes(selection: ReadonlySet<CustomDecodeProbe>): Promise<AudioProbeResults> {
        const queue = this.getSession().manager.queue;
        const [ nativeAudio, nativeSurroundAudio, nativeSevenPointOneAudio ] = await Promise.all([
            this.startSelectedProbe(selection, 'native-audio', queue, NOT_PROBED_NATIVE_AUDIO_CAPABILITIES),
            this.startSelectedProbe(selection, 'native-surround-audio', queue, NOT_PROBED_NATIVE_SURROUND_AUDIO_CAPABILITIES),
            this.startSelectedProbe(selection, 'native-seven-point-one-audio', queue, NOT_PROBED_NATIVE_SEVEN_POINT_ONE_AUDIO_CAPABILITIES)
        ]);
        return { nativeAudio, nativeSevenPointOneAudio, nativeSurroundAudio };
    }

    /** Starts the selected video probes that no earlier item started; an unselected probe resolves as not probed. */
    private async startVideoProbes(
        selection: ReadonlySet<CustomDecodeProbe>,
        videoQueue: CapabilityProbeQueue
    ): Promise<VideoProbeResults> {
        const h264 = this.startSelectedProbe<H264ProbeResult | null>(selection, 'h264-profiles', videoQueue, null);
        const nativeSDRVideo = Promise.all(NATIVE_SDR_VIDEO_PROBE_DEFINITIONS.map(
            (definition: NativeSDRVideoProbeDefinition): Promise<CustomDecodeCodecCapability<CustomVideoCodec>> => (
                this.startSelectedProbe(
                    selection,
                    getNativeSDRVideoProbe(definition.codec),
                    videoQueue,
                    createNotProbedCapability<CustomVideoCodec>(definition.codec, definition.config.codec)
                )
            )
        ));
        const nativeUltraHDVideo = Promise.all(NATIVE_ULTRA_HD_VIDEO_PROBE_DEFINITIONS.map(
            (definition: NativeUltraHDVideoProbeDefinition): Promise<CustomNativeUltraHDVideoCodecCapability> => (
                this.startSelectedProbe(
                    selection,
                    getNativeUltraHDVideoProbe(definition.codec),
                    videoQueue,
                    createNotProbedNativeUltraHDVideoCapability(definition)
                )
            )
        ));
        const rawVideo = Promise.all(RAW_HDR_VIDEO_PROBE_DEFINITIONS.map(
            (definition: RawHDRVideoProbeDefinition): Promise<CustomRawHDRVideoCodecCapability> => (
                this.startSelectedProbe(
                    selection,
                    getRawVideoProbe(definition.codec),
                    videoQueue,
                    createNotProbedRawVideoCapability(definition)
                )
            )
        ));
        const hevcRangeExtensions = Promise.all(HEVC_RANGE_EXTENSION_VARIANTS.map(
            (variant: HEVCRangeExtensionVariant): Promise<HEVCRangeExtensionCapability> => (
                this.startSelectedProbe(
                    selection,
                    getHEVCRangeExtensionVideoProbe(variant),
                    videoQueue,
                    createNotProbedHEVCRangeExtensionCapability(variant)
                )
            )
        ));
        const av1RawFormats = Promise.all(AV1_RAW_FORMAT_VARIANTS.map(
            (variant: AV1RawFormatVariant): Promise<AV1RawFormatCapability> => (
                this.startSelectedProbe(
                    selection,
                    getAV1RawFormatVideoProbe(variant),
                    videoQueue,
                    createNotProbedAV1RawFormatCapability(variant)
                )
            )
        ));
        const h264RawFormats = Promise.all(H264_RAW_FORMAT_VARIANTS.map(
            (variant: H264RawFormatVariant): Promise<H264RawFormatCapability> => (
                this.startSelectedProbe(
                    selection,
                    getH264RawFormatVideoProbe(variant),
                    videoQueue,
                    createNotProbedH264RawFormatCapability(variant)
                )
            )
        ));
        const nativeDolbyVisionHEVC = this.startSelectedProbe(
            selection,
            'native-dolby-vision-hevc',
            videoQueue,
            NOT_PROBED_NATIVE_DOLBY_VISION_HEVC_CAPABILITY
        );
        const nativeHDRAV1 = this.startSelectedProbe(selection, 'native-hdr-av1', videoQueue, NOT_PROBED_NATIVE_HDR_AV1_CAPABILITY);
        const nativeHDRHEVC = this.startSelectedProbe(selection, 'native-hdr-hevc', videoQueue, NOT_PROBED_NATIVE_HDR_HEVC_CAPABILITY);
        return {
            av1RawFormats: await av1RawFormats,
            h264: await h264,
            h264RawFormats: await h264RawFormats,
            hevcRangeExtensions: await hevcRangeExtensions,
            nativeDolbyVisionHEVC: await nativeDolbyVisionHEVC,
            nativeHDRAV1: await nativeHDRAV1,
            nativeHDRHEVC: await nativeHDRHEVC,
            nativeSDRVideo: await nativeSDRVideo,
            nativeUltraHDVideo: await nativeUltraHDVideo,
            rawVideo: await rawVideo
        };
    }

    /** Returns how to start each probe on a queue and an environment; each identifier always starts the same probe. */
    private getProbeStarter(probe: CustomDecodeProbe): ProbeStarter {
        this.probeStarters ??= createProbeStarters();
        const starter = this.probeStarters.get(probe);
        if (!starter) {
            throw new RangeError(`Unknown capability probe: ${probe}`);
        }
        return starter;
    }

    /** Runs a probe on a view of the manager, through the session, which blocks, orders, and records each of its browser calls. */
    private runRecorded(probe: CustomDecodeProbe, queue: CapabilityProbeQueue): Promise<unknown> {
        return this.getProbeStarter(probe)(this.getSession().record(queue, probe), this.getEnvironment());
    }

    /**
     * Starts a probe once per page for a negotiation; a later run shares its promise.
     * A background run of the same probe is promoted and shared, unless it timed out, when the probe runs again here.
     */
    private startProbe<Result>(probe: CustomDecodeProbe, queue: CapabilityProbeQueue): Promise<Result> {
        let probeResult = this.probeResults.get(probe);
        if (!probeResult) {
            const background = this.backgroundProbes.get(probe);
            if (background) {
                background.run.promote();
                probeResult = background.outcome.then((outcome: BackgroundProbeOutcome): unknown => (
                    outcome.discarded ? this.runProbe(probe, queue) : outcome.result
                ));
            } else {
                probeResult = this.readStoredVerdictOrRunProbe(probe, queue);
            }
            this.probeResults.set(probe, probeResult);
        }
        // Each identifier always starts the same probe, so its promise carries that probe's result type
        return probeResult as Promise<Result>;
    }

    /** Starts a selected probe once per page; a probe outside the selection resolves to its not-probed result. */
    private startSelectedProbe<Result>(
        selection: ReadonlySet<CustomDecodeProbe>,
        probe: CustomDecodeProbe,
        queue: CapabilityProbeQueue,
        notProbedResult: Result
    ): Promise<Result> {
        return selection.has(probe) ? this.startProbe(probe, queue) : Promise.resolve(notProbedResult);
    }

    /** Takes a stored verdict at once and, unless refresh after use is off, reruns its probe in the background; else runs the probe now. */
    private async readStoredVerdictOrRunProbe(probe: CustomDecodeProbe, queue: CapabilityProbeQueue): Promise<unknown> {
        const storedVerdict = await this.store?.read(probe) ?? null;
        if (storedVerdict === null) {
            return this.runProbe(probe, queue);
        }
        this.storedProbes.add(probe);
        this.store?.recordServedVerdict();
        if (this.refreshAfterUse) {
            this.scheduleBackgroundProbes([ probe ], 'refresh');
        }
        return storedVerdict;
    }

    /** Runs a probe and stores its result when it is a verdict throughout. */
    private async runProbe(probe: CustomDecodeProbe, queue: CapabilityProbeQueue): Promise<unknown> {
        const result = await this.runRecorded(probe, queue);
        void this.store?.write(probe, result);
        return result;
    }

    /** Holds background probes while a negotiation runs and for a while after it, while its playback starts. */
    private holdBackgroundFor(capabilities: Promise<CustomDecodeCapabilities>): void {
        this.negotiationCount += 1;
        const release = (): void => {
            this.negotiationCount -= 1;
            this.negotiationHoldEnd = this.now() + BACKGROUND_PROBE_NEGOTIATION_HOLD_MILLISECONDS;
        };
        capabilities.then(release, release);
    }

    private isBackgroundClear(): boolean {
        return this.negotiationCount === 0 && this.now() >= this.negotiationHoldEnd && !this.isPlaybackActive();
    }

    /** Waits for a background step's turn: an idle period with no negotiation near and no media playing, or the run's promotion. */
    private readonly waitForBackgroundTurn = async (run: BackgroundCapabilityProbeRun): Promise<void> => {
        while (!run.promoted) {
            await this.waitForIdle(run.promotion);
            if (run.promoted || this.isBackgroundClear()) {
                return;
            }
            await waitForDelay(BACKGROUND_PROBE_RECHECK_MILLISECONDS, run.promotion);
        }
    };

    private scheduleBackgroundProbes(probes: readonly CustomDecodeProbe[], kind: BackgroundProbeKind): void {
        for (const probe of probes) {
            if (!this.backgroundQueue.has(probe)) {
                this.backgroundQueue.set(probe, kind);
            }
        }
        this.startBackgroundDriver();
    }

    private startBackgroundDriver(): void {
        if (!this.backgroundDriverActive) {
            this.backgroundDriverActive = true;
            void this.runBackgroundQueue();
        }
    }

    /**
     * Runs the background probes one after another, so at most one is ever behind a negotiation's probes in the manager,
     * and then the host's tasks, each after the probes queued by its turn.
     * A probe that had a suspect step in flight runs after every other, so the serial round that retries the suspects comes last.
     */
    private async runBackgroundQueue(): Promise<void> {
        try {
            const session = this.getSession();
            await session.readQuarantine();
            while ((this.backgroundQueue.size > 0 || this.backgroundTasks.length > 0) && !session.manager.isBackgroundHalted) {
                const queued = [ ...this.backgroundQueue ];
                if (queued.length > 0) {
                    const [ probe, kind ] = queued.find(([ queuedProbe ]): boolean => !session.holdsSuspectSteps(queuedProbe)) ?? queued[0];
                    this.backgroundQueue.delete(probe);
                    await this.runBackgroundProbe(probe, kind);
                } else {
                    await this.runBackgroundTask(this.backgroundTasks[0]);
                    this.backgroundTasks.shift();
                }
            }
            // After a background timeout only negotiations probe, so the work it left is never joined by more
            this.backgroundQueue.clear();
            for (const backgroundTask of this.backgroundTasks.splice(0)) {
                backgroundTask.settle(false);
            }
        } finally {
            this.backgroundDriverActive = false;
        }
    }

    private async runBackgroundTask(backgroundTask: BackgroundTask): Promise<void> {
        // No negotiation promotes a host's task, so only a background turn starts it
        await new BackgroundCapabilityProbeRun(this.waitForBackgroundTurn).waitForTurn();
        try {
            await backgroundTask.task();
        } catch {
            // The task reports its own failures
        }
        backgroundTask.settle(true);
    }

    private async runBackgroundProbe(probe: CustomDecodeProbe, kind: BackgroundProbeKind): Promise<void> {
        // A warm-up leaves a stored verdict to the negotiation that uses it; nothing reruns a result this page measured
        const stored = kind === 'warm-up' && (await this.store?.read(probe) ?? null) !== null;
        if (stored || (this.probeResults.has(probe) && !this.storedProbes.has(probe))) {
            return;
        }
        const run = new BackgroundCapabilityProbeRun(this.waitForBackgroundTurn);
        const outcome = this.startBackgroundRun(probe, run);
        this.backgroundProbes.set(probe, { outcome, run });
        const { discarded, result } = await outcome;
        this.backgroundProbes.delete(probe);
        if (discarded) {
            return;
        }
        void this.store?.write(probe, result);
        // A promoted run is already the page's result, and a refresh that reached no verdict leaves the stored one
        if (run.promoted
            || (kind === 'refresh' && !isDefinitiveCapabilityProbeResult(result))
            || (this.probeResults.has(probe) && !this.storedProbes.has(probe))) {
            return;
        }
        this.probeResults.set(probe, Promise.resolve(result));
        this.storedProbes.delete(probe);
        this.selectionResults.clear();
    }

    private async startBackgroundRun(probe: CustomDecodeProbe, run: BackgroundCapabilityProbeRun): Promise<BackgroundProbeOutcome> {
        try {
            await run.waitForTurn();
            const result = await this.runRecorded(probe, this.getSession().manager.background(run));
            return { discarded: run.timedOut || hasCapabilityProbeTimeout(result), result };
        } catch {
            return { discarded: true, result: null };
        }
    }

    /** Drops the stored verdicts the page holds, so the next negotiation probes them again. */
    private forgetStoredVerdicts(): void {
        for (const probe of this.storedProbes) {
            this.probeResults.delete(probe);
        }
        this.storedProbes.clear();
        this.selectionResults.clear();
    }
}

/** Returns how to start each probe on a queue and an environment; a run passes its own, which record the probe's browser calls. */
function createProbeStarters(): ReadonlyMap<CustomDecodeProbe, ProbeStarter> {
    const starters = new Map<CustomDecodeProbe, ProbeStarter>([
        [ 'native-audio', (queue, environment) => Promise.all(createAudioProbePromises(environment, queue)) ],
        [ 'native-surround-audio', (queue, environment) => Promise.all(createNativeSurroundAudioProbePromises(
            NATIVE_SURROUND_AUDIO_PROBE_DEFINITIONS,
            environment,
            queue
        )) ],
        [ 'native-seven-point-one-audio', (queue, environment) => Promise.all(createNativeSurroundAudioProbePromises(
            NATIVE_SEVEN_POINT_ONE_AUDIO_PROBE_DEFINITIONS,
            environment,
            queue
        )) ],
        [ 'h264-profiles', (queue, environment) => probeH264(environment, queue) ],
        [ 'native-dolby-vision-hevc', (queue, environment) => probeNativeDolbyVisionHEVC(
            environment.videoDecoder,
            environment.nativeDolbyVisionVideoOutputProbe,
            queue
        ) ],
        [ 'native-hdr-hevc', (queue, environment) => probeNativeHDRHEVC(environment.videoDecoder, environment.nativeHDRVideoOutputProbe, queue) ],
        [ 'native-hdr-av1', (queue, environment) => probeNativeHDRAV1(environment.videoDecoder, environment.nativeHDRVideoOutputProbe, queue) ]
    ]);
    for (const definition of NATIVE_SDR_VIDEO_PROBE_DEFINITIONS) {
        starters.set(getNativeSDRVideoProbe(definition.codec), (queue, environment) => probeNativeVideoConfig(
            definition,
            environment.videoDecoder,
            environment.nativeVideoOutputProbe,
            queue
        ));
    }
    for (const definition of NATIVE_ULTRA_HD_VIDEO_PROBE_DEFINITIONS) {
        starters.set(getNativeUltraHDVideoProbe(definition.codec), (queue, environment) => probeNativeUltraHDVideoConfig(
            definition,
            environment.videoDecoder,
            environment.nativeVideoOutputProbe,
            queue
        ));
    }
    for (const definition of RAW_HDR_VIDEO_PROBE_DEFINITIONS) {
        starters.set(getRawVideoProbe(definition.codec), (queue, environment) => probeRawHDRVideoConfig(
            definition,
            environment.videoDecoder,
            environment.rawHDRVideoOutputProbe,
            environment.canHoldVideoFrameFormat ?? canHoldVideoFrameFormat,
            queue
        ));
    }
    for (const variant of HEVC_RANGE_EXTENSION_VARIANTS) {
        const definition = HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant];
        starters.set(getHEVCRangeExtensionVideoProbe(variant), (queue, environment) => probeExactRawFormatConfig(
            'hevc',
            definition,
            createHEVCRangeExtensionBaseCapability(definition),
            environment,
            environment.hevcRangeExtensionVectorLoader,
            queue
        ));
    }
    for (const variant of AV1_RAW_FORMAT_VARIANTS) {
        const definition = AV1_RAW_FORMAT_PROBE_DEFINITIONS[variant];
        starters.set(getAV1RawFormatVideoProbe(variant), (queue, environment) => probeExactRawFormatConfig(
            'av1',
            definition,
            createAV1RawFormatBaseCapability(definition),
            environment,
            environment.av1RawFormatVectorLoader,
            queue
        ));
    }
    for (const variant of H264_RAW_FORMAT_VARIANTS) {
        const definition = H264_RAW_FORMAT_PROBE_DEFINITIONS[variant];
        starters.set(getH264RawFormatVideoProbe(variant), (queue, environment) => probeExactRawFormatConfig(
            'h264',
            definition,
            createH264RawFormatBaseCapability(definition),
            environment,
            environment.h264RawFormatVectorLoader,
            queue
        ));
    }
    return starters;
}

type ConstrainedClientNavigator = Readonly<{
    connection?: Readonly<{ saveData?: unknown }>
    hardwareConcurrency?: unknown
}>;

/** Returns whether a client asks to save data or has few threads, where a speculative warm-up would cost browsing more than it saves. */
function isConstrainedClient(): boolean {
    const browser = globalThis.navigator as ConstrainedClientNavigator | undefined;
    const hardwareConcurrency = browser?.hardwareConcurrency;
    return browser?.connection?.saveData === true
        || (typeof hardwareConcurrency === 'number' && hardwareConcurrency < WARM_UP_MINIMUM_HARDWARE_CONCURRENCY);
}

const defaultCapabilityProbe = new CustomDecodeCapabilityProbe(null, { store: getDefaultCapabilityProbeStore() });

/**
 * Probes what an item needs and reuses each probe's result for the page's lifetime.
 * Every audio probe runs; the video probes follow the item's streams, and no item, or one without stream metadata, runs them all.
 * A stored verdict for this fingerprint answers at once; see configureCapabilityProbeStore.
 */
export function probeCustomDecodeCapabilities(item?: unknown): Promise<CustomDecodeCapabilities> {
    return defaultCapabilityProbe.probe(item);
}

/** The page's probe session: the native media audio probe runs its playbacks on its manager, beside the WebCodecs probes. */
export function getDefaultCapabilityProbeSession(): CapabilityProbeSession {
    return defaultCapabilityProbe.getSession();
}

export type CustomDecodeCapabilityBackgroundConfiguration = Readonly<{
    /** Returns whether the host plays media; background probes wait while it does */
    isPlaybackActive: () => boolean
    /** Whether a negotiation a stored verdict served reruns its probe in the background; defaults to true */
    refreshAfterUse?: boolean
}>;

/**
 * Tells the page's background probes when media plays, so they never compete with a playback, and whether a used stored verdict is refreshed.
 * Each call replaces the previous configuration; a refresh queued before refresh after use was turned off still runs.
 */
export function configureCustomDecodeCapabilityBackground(configuration: CustomDecodeCapabilityBackgroundConfiguration): void {
    defaultCapabilityProbe.setPlaybackActivity(configuration.isPlaybackActive);
    defaultCapabilityProbe.setRefreshAfterUse(configuration.refreshAfterUse ?? true);
}

/**
 * Starts the page's probes in the background before the first negotiation, which then finds them done or promotes them.
 * A client that asks to save data, or has fewer than four threads, is not warmed; returns whether the warm-up started.
 */
export function warmCustomDecodeCapabilities(): boolean {
    if (isConstrainedClient()) {
        return false;
    }
    defaultCapabilityProbe.warmUp();
    return true;
}

/**
 * Runs a task in the background of the page's capability probes, after the probes queued ahead of it, at a turn they would take:
 * an idle period with no negotiation near and no media playing. One task runs at a time; resolves whether it ran.
 */
export function runCustomDecodeBackgroundTask(task: () => Promise<void>): Promise<boolean> {
    return defaultCapabilityProbe.runInBackground(task);
}
