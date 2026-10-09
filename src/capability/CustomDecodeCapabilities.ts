import {
    createRawHDRCapabilityVector,
    RAW_HDR_CAPABILITY_VECTOR_CODED_HEIGHT,
    RAW_HDR_CAPABILITY_VECTOR_CODED_WIDTH
} from './vectors/RawHDRCapabilityVectors';
import H264ProfileCapabilityProbe, { type H264ProfileCapabilities } from './H264ProfileCapabilities';
import { fetchCapabilityAsset } from './CapabilityAssetLoading';
import {
    prepareBundledHEVCExactCapabilities,
    probeBundledHEVCExactCapabilities,
    type BundledHEVCExactCapabilities
} from './exact/HEVCExactCapabilityProbe';
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
    createNativeUltraHDVideoCapabilityVector,
    NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODECS,
    type NativeUltraHDVideoCapabilityVector
} from './vectors/NativeUltraHDVideoCapabilityVectors';
import { createNativeVideoCapabilityVector } from './vectors/NativeVideoCapabilityVectors';
import {
    prepareJPEG2000ExactCapability,
    probeJPEG2000ExactCapability,
    type JPEG2000ExactCapability
} from './exact/JPEG2000ExactCapabilityProbe';
import {
    prepareDTSExactCapability,
    probeDTSExactCapability,
    type DTSExactCapability
} from './exact/DTSExactCapabilityProbe';
import {
    prepareTrueHDExactCapability,
    probeTrueHDExactCapability,
    type TrueHDExactCapability
} from './exact/TrueHDExactCapabilityProbe';
import {
    prepareMPEG2ExactCapability,
    prepareVC1ExactCapability,
    probeMPEG2ExactCapability,
    probeVC1ExactCapability,
    type MPEG2VC1ExactCapability
} from './exact/MPEG2VC1ExactCapabilityProbe';
import type {
    CustomAudioCodec,
    CustomBundledAudioCodec
} from '../audio/CustomAudioCodec';
import { resolveEngineAssetURL, type EngineLibraryPath } from '../EngineAssets';

export {
    CUSTOM_AUDIO_CODECS,
    CUSTOM_BUNDLED_AUDIO_CODECS,
    CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS,
    CUSTOM_WEB_CODECS_AUDIO_CODECS,
    type CustomAudioCodec,
    type CustomBundledAudioCodec,
    type CustomMediabunnyPCMAudioCodec
} from '../audio/CustomAudioCodec';

export const CUSTOM_VIDEO_CODECS = [
    'h264',
    'hevc',
    'vp8',
    'vp9',
    'av1',
    'mpeg2video',
    'vc1',
    'jpeg2000'
] as const;
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
export type CustomRawHDRVideoCodec = typeof CUSTOM_RAW_HDR_VIDEO_CODECS[number];
export type CustomNativeSurroundAudioCodec = typeof CUSTOM_NATIVE_SURROUND_AUDIO_CODECS[number];
export type CustomNativeUltraHDVideoCodec = typeof CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS[number];
export type CustomDecodeCodec = CustomAudioCodec | CustomVideoCodec;
// A probe outside the negotiated item's selection is not probed, which is never a verdict
export type CustomDecodeCapabilityStatus = 'not-probed' | 'supported' | 'unsupported' | 'unknown';
export type CustomDecodeCapabilityReason =
    | 'api-unavailable'
    | 'bundled-software-decoder'
    | 'config-supported'
    | 'config-unsupported'
    | 'decode-output-missing'
    | 'decode-output-verified'
    | 'not-probed'
    | 'probe-exception'
    | 'probe-timeout'
    | 'throughput-insufficient';

/** The audio probes, which every item runs because a playing item can switch to any of its audio tracks. */
export const CUSTOM_DECODE_AUDIO_PROBES = [
    'native-audio',
    'native-surround-audio',
    'bundled-dts',
    'bundled-truehd'
] as const;

// The codecs whose ordinary SDR route has a decoded-output vector; H.264 qualifies per profile instead
type NativeSDRVideoProbeCodec = 'av1' | 'hevc' | 'vp8' | 'vp9';

export type CustomDecodeAudioProbe = typeof CUSTOM_DECODE_AUDIO_PROBES[number];
export type CustomDecodeVideoProbe =
    | 'bundled-hevc'
    | 'bundled-jpeg2000'
    | 'bundled-mpeg2'
    | 'bundled-vc1'
    | 'h264-profiles'
    | 'native-dolby-vision-hevc'
    | 'native-hdr-hevc'
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
    bundledAudioCodecCount: number
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
    bundledDTS?: DTSExactCapability
    bundledHEVC?: BundledHEVCExactCapabilities
    bundledJPEG2000?: JPEG2000ExactCapability
    bundledMPEG2?: MPEG2VC1ExactCapability
    bundledVC1?: MPEG2VC1ExactCapability
    bundledTrueHD?: TrueHDExactCapability
    h264Profiles?: H264ProfileCapabilities
    hevcRangeExtensions?: Readonly<Record<HEVCRangeExtensionVariant, HEVCRangeExtensionCapability>>
    nativeDolbyVisionHEVC?: CustomNativeDolbyVisionHEVCCapability
    nativeHDRHEVC?: CustomNativeHDRHEVCCapability
    nativeSurroundAudio?: Readonly<Record<CustomNativeSurroundAudioCodec, CustomNativeSurroundAudioCodecCapability>>
    nativeUltraHDVideo?: Readonly<Record<CustomNativeUltraHDVideoCodec, CustomNativeUltraHDVideoCodecCapability>>
    /**
     * Whether this result ran each probe.
     * A probe outside the item's selection is not probed: its status entries read `not-probed`, and its exact or H.264 result is omitted.
     */
    probeStates?: Readonly<Record<CustomDecodeProbe, CustomDecodeProbeState>>
    rawHDRVideo: Readonly<Record<CustomRawHDRVideoCodec, CustomRawHDRVideoCodecCapability>>
    telemetry: Readonly<CustomDecodeProbeTelemetry>
    video: Readonly<Record<CustomVideoCodec, CustomDecodeCodecCapability<CustomVideoCodec>>>
};

export type CustomNativeSurroundAudioCodecCapability = CustomDecodeCodecCapability<CustomNativeSurroundAudioCodec> & {
    inputChannelCount: typeof NATIVE_SURROUND_AUDIO_CAPABILITY_VECTOR_CHANNEL_COUNT
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

export type CustomRawHDRVideoCapabilityReason =
    | 'api-unavailable'
    | 'bundled-software-decoder'
    | 'config-unsupported'
    | 'not-probed'
    | 'output-copy-supported'
    | 'output-copy-unsupported'
    | 'probe-exception'
    | 'probe-timeout'
    | 'runtime-unavailable';

export type CustomRawHDRVideoCodecCapability = {
    bitDepth: 10
    codec: CustomRawHDRVideoCodec
    codecString: string
    format: 'I420P10'
    reason: CustomRawHDRVideoCapabilityReason
    status: CustomDecodeCapabilityStatus
};

export type RawHDRVideoOutputProbeRequest = {
    codec: CustomRawHDRVideoCodec
    configuration: VideoDecoderConfig
    encodedChunks: readonly Readonly<{
        data: Uint8Array
        timestamp: number
        type: 'delta' | 'key'
    }>[]
    expectedCodedHeight: number
    expectedCodedWidth: number
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

export type NativeAudioOutputProbeRequest = {
    codec: Exclude<CustomAudioCodec, CustomBundledAudioCodec>
    configuration: AudioDecoderConfig
    encodedChunks: readonly Readonly<{
        data: Uint8Array
        duration: number
        timestamp: number
    }>[]
    expectedNumberOfChannels: number
    expectedNumberOfFrames: number
    expectedSampleRate: number
    expectedTimestamp: number
};

export type NativeAudioOutputProbe = (probeRequest: NativeAudioOutputProbeRequest) => Promise<boolean>;

type RawHDRVideoFrameCopyToOptions = Omit<VideoFrameCopyToOptions, 'format'> & {
    format: CustomDecodeRawVideoFrameFormat
};

export type HEVCRangeExtensionVectorLoader = (assetPath: EngineLibraryPath) => Promise<ArrayBuffer>;

/** An exact probe; prepare starts its downloads ahead of its turn in the heavy queue. */
export type ExactCapabilityProbe<Capability> = {
    prepare?: () => void
    probe: () => Promise<Capability>
};

export type WebCodecsCapabilityEnvironment = {
    audioDecoder?: Pick<typeof AudioDecoder, 'isConfigSupported'> | null
    bundledDTSExactProbe?: ExactCapabilityProbe<DTSExactCapability> | null
    bundledHEVCExactProbe?: ExactCapabilityProbe<BundledHEVCExactCapabilities> | null
    bundledJPEG2000ExactProbe?: ExactCapabilityProbe<JPEG2000ExactCapability> | null
    bundledMPEG2ExactProbe?: ExactCapabilityProbe<MPEG2VC1ExactCapability> | null
    bundledVC1ExactProbe?: ExactCapabilityProbe<MPEG2VC1ExactCapability> | null
    bundledTrueHDExactProbe?: ExactCapabilityProbe<TrueHDExactCapability> | null
    h264ProfileProbe?: Pick<H264ProfileCapabilityProbe, 'probe'> | null
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

type AudioProbeDefinition = {
    codec: Exclude<CustomAudioCodec, CustomBundledAudioCodec>
    config: AudioDecoderConfig
    outputVector: {
        encodedChunks: NativeAudioCapabilityVector['encodedChunks']
            | NativeSurroundAudioCapabilityVector['encodedChunks']
        expectedNumberOfChannels: number
        expectedNumberOfFrames: number
        expectedSampleRate: number
        expectedTimestamp: number
    }
};

type NativeSurroundAudioProbeDefinition = AudioProbeDefinition & {
    codec: CustomNativeSurroundAudioCodec
};

type BundledAudioCodecDefinition = {
    codec: CustomBundledAudioCodec
    codecString: string
};

type RawHDRVideoProbeDefinition = {
    codec: CustomRawHDRVideoCodec
    config: VideoDecoderConfig
    encodedKeyFrame: Uint8Array
    expectedDecodedFrameFingerprint: number
};

type DecoderCapabilityAPI<Config> = {
    isConfigSupported: (config: Config) => Promise<{ supported?: boolean }>
};

type CodecProbeDefinition<Codec extends CustomDecodeCodec, Config extends { codec: string }> = {
    codec: Codec
    config: Config
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
const CAPABILITY_PROBE_TIMEOUT = Symbol('custom-decode-capability-probe-timeout');
const defaultH264ProfileCapabilityProbe = new H264ProfileCapabilityProbe();
const defaultBundledHEVCExactProbe: ExactCapabilityProbe<BundledHEVCExactCapabilities> = {
    prepare: prepareBundledHEVCExactCapabilities,
    probe: probeBundledHEVCExactCapabilities
};
const defaultBundledDTSExactProbe: ExactCapabilityProbe<DTSExactCapability> = {
    prepare: prepareDTSExactCapability,
    probe: probeDTSExactCapability
};
const defaultBundledTrueHDExactProbe: ExactCapabilityProbe<TrueHDExactCapability> = {
    prepare: prepareTrueHDExactCapability,
    probe: probeTrueHDExactCapability
};
const defaultBundledJPEG2000ExactProbe: ExactCapabilityProbe<JPEG2000ExactCapability> = {
    prepare: prepareJPEG2000ExactCapability,
    probe: probeJPEG2000ExactCapability
};
const defaultBundledMPEG2ExactProbe: ExactCapabilityProbe<MPEG2VC1ExactCapability> = {
    prepare: prepareMPEG2ExactCapability,
    probe: probeMPEG2ExactCapability
};
const defaultBundledVC1ExactProbe: ExactCapabilityProbe<MPEG2VC1ExactCapability> = {
    prepare: prepareVC1ExactCapability,
    probe: probeVC1ExactCapability
};

function waitForCapabilityProbe<Value>(promise: Promise<Value>): Promise<Value | typeof CAPABILITY_PROBE_TIMEOUT> {
    return new Promise<Value | typeof CAPABILITY_PROBE_TIMEOUT>((resolve, reject) => {
        let settled = false;
        const timeout = globalThis.setTimeout((): void => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(CAPABILITY_PROBE_TIMEOUT);
        }, VIDEO_OUTPUT_PROBE_TIMEOUT_MILLISECONDS);
        promise.then((value: Value): void => {
            if (settled) {
                return;
            }
            settled = true;
            globalThis.clearTimeout(timeout);
            resolve(value);
        }, (error: unknown): void => {
            if (settled) {
                return;
            }
            settled = true;
            globalThis.clearTimeout(timeout);
            reject(error);
        });
    });
}

// A view of the page's heavy probe scheduler; the video probes' view waits for the audio probes
type HeavyCapabilityProbeQueue = Pick<SerializedHeavyCapabilityProbeScheduler, 'run' | 'runTimed'>;

/** Runs decoder-backed capability probes without competing for decode resources. */
class SerializedHeavyCapabilityProbeScheduler {
    private probeChain: Promise<void> = Promise.resolve();
    private timedOut = false;

    /** Enqueues a probe which provides its own bounded completion. */
    public run<Value>(probe: () => Promise<Value>): Promise<Value | typeof CAPABILITY_PROBE_TIMEOUT> {
        return this.enqueue(probe, false);
    }

    /** Enqueues a probe with the common output-probe timeout. */
    public runTimed<Value>(probe: () => Promise<Value>): Promise<Value | typeof CAPABILITY_PROBE_TIMEOUT> {
        return this.enqueue(probe, true);
    }

    /** Returns a queue onto this one whose probes join it only once the gate settles. */
    public after(gate: Promise<unknown>): HeavyCapabilityProbeQueue {
        const settledGate: Promise<void> = gate.then((): void => undefined, (): void => undefined);
        return {
            run: <Value>(probe: () => Promise<Value>) => settledGate.then(() => this.run(probe)),
            runTimed: <Value>(probe: () => Promise<Value>) => settledGate.then(() => this.runTimed(probe))
        };
    }

    private enqueue<Value>(
        probe: () => Promise<Value>,
        useTimeout: boolean
    ): Promise<Value | typeof CAPABILITY_PROBE_TIMEOUT> {
        const resultPromise = this.probeChain.then(async () => {
            if (this.timedOut) {
                return CAPABILITY_PROBE_TIMEOUT;
            }
            if (!useTimeout) {
                return probe();
            }

            const result = await waitForCapabilityProbe(probe());
            if (result === CAPABILITY_PROBE_TIMEOUT) {
                // Do not start another decoder while the timed-out work may still be active
                this.timedOut = true;
            }
            return result;
        });
        this.probeChain = resultPromise.then((): void => undefined, (): void => undefined);
        return resultPromise;
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
        hardwareAcceleration: getCustomDecodeHardwareAcceleration('video-frame', 'native', true),
        optimizeForLatency: true
    }
} as const satisfies VideoProbeDefinition;

const NATIVE_HDR_HEVC_PROBE_DEFINITION = {
    codec: 'hevc',
    config: {
        codec: 'hvc1.2.4.L153.B0',
        codedHeight: NATIVE_HDR_HEVC_VECTOR_CODED_HEIGHT,
        codedWidth: NATIVE_HDR_HEVC_VECTOR_CODED_WIDTH,
        hardwareAcceleration: getCustomDecodeHardwareAcceleration('video-frame', 'native', true),
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
            codec
        });
    }
    return definitions;
}

const NATIVE_SURROUND_AUDIO_PROBE_DEFINITIONS: readonly NativeSurroundAudioProbeDefinition[] = createNativeSurroundAudioProbeDefinitions();

const BUNDLED_AUDIO_CODEC_DEFINITIONS: readonly BundledAudioCodecDefinition[] = [
    { codec: 'ac3', codecString: 'ac-3' },
    { codec: 'eac3', codecString: 'ec-3' },
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
            hardwareAcceleration: getCustomDecodeHardwareAcceleration('raw-planes', 'native', false, 'hevc'),
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
            hardwareAcceleration: getCustomDecodeHardwareAcceleration('raw-planes', 'native', false, 'vp9'),
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
            hardwareAcceleration: getCustomDecodeHardwareAcceleration('raw-planes', 'native', false, 'av1'),
            optimizeForLatency: true
        },
        encodedKeyFrame: AV1_MAIN_10_VECTOR.encodedKeyFrame,
        expectedDecodedFrameFingerprint: AV1_MAIN_10_VECTOR.decodedFrameFingerprint
    }
];

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
    'bundled-hevc',
    'bundled-jpeg2000',
    'bundled-mpeg2',
    'bundled-vc1',
    'native-dolby-vision-hevc',
    'native-hdr-hevc'
];

// The video configuration probes the telemetry counts
const VIDEO_CONFIGURATION_PROBES: readonly CustomDecodeVideoProbe[] = [
    'h264-profiles',
    ...NATIVE_SDR_VIDEO_PROBES,
    ...NATIVE_ULTRA_HD_VIDEO_PROBES,
    'native-dolby-vision-hevc',
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
    'bundled-hevc',
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
    [ 'H264', 'h264' ],
    [ 'H265', 'hevc' ],
    [ 'HEVC', 'hevc' ],
    [ 'J2K', 'jpeg2000' ],
    [ 'JPEG 2000', 'jpeg2000' ],
    [ 'JPEG2000', 'jpeg2000' ],
    [ 'MPEG-2', 'mpeg2video' ],
    [ 'MPEG2', 'mpeg2video' ],
    [ 'MPEG2VIDEO', 'mpeg2video' ],
    [ 'VC-1', 'vc1' ],
    [ 'VC1', 'vc1' ],
    [ 'VP8', 'vp8' ],
    [ 'VP9', 'vp9' ]
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
    const copyOptions: RawHDRVideoFrameCopyToOptions = { format: expectedFormat };
    const browserCopyOptions = copyOptions as unknown as VideoFrameCopyToOptions;
    let allocationSize: number;
    try {
        allocationSize = decodedFrame.allocationSize(browserCopyOptions);
    } catch {
        return null;
    }
    let output = destination?.byteLength === allocationSize ?
        destination :
        new Uint8Array(allocationSize);
    try {
        return {
            destination: output,
            layouts: await decodedFrame.copyTo(output, browserCopyOptions)
        };
    } catch {
        if (String(decodedFrame.format) !== expectedFormat) {
            return null;
        }
    }

    // Current Chromium can reject an explicit native format
    const nativeAllocationSize = decodedFrame.allocationSize();
    if (output.byteLength !== nativeAllocationSize) {
        output = new Uint8Array(nativeAllocationSize);
    }
    return {
        destination: output,
        layouts: await decodedFrame.copyTo(output)
    };
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
                if (frame.codedHeight !== probeRequest.expectedCodedHeight
                    || frame.codedWidth !== probeRequest.expectedCodedWidth
                    || frame.timestamp !== expectedFrame.timestamp) {
                    outputMatches = false;
                    return;
                }
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
                frame.close();
            }
            ownedFrames.clear();
            if (timeout !== null) {
                globalThis.clearTimeout(timeout);
            }
            if (decoder.state !== 'closed') {
                decoder.close();
            }
        }
    };
}

function nativeAudioDataMatchesRequest(
    audioData: AudioData,
    probeRequest: NativeAudioOutputProbeRequest
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

    try {
        for (let channelIndex = 0; channelIndex < probeRequest.expectedNumberOfChannels; channelIndex += 1) {
            const samples: Float32Array = new Float32Array(probeRequest.expectedNumberOfFrames);
            audioData.copyTo(samples, {
                format: 'f32-planar',
                planeIndex: channelIndex
            });
            for (const sample of samples) {
                if (!Number.isFinite(sample)
                    || Math.abs(sample) > NATIVE_AUDIO_MAXIMUM_ABSOLUTE_SILENCE_SAMPLE) {
                    return false;
                }
            }
        }
    } catch {
        return false;
    }
    return true;
}

/** Creates the exact decoded AudioData probe for native WebCodecs audio. */
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
                    outputMatches = outputMatches
                        && nativeAudioDataMatchesRequest(audioData, probeRequest);
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
                return decoderError === null && outputCount === 1 && outputMatches;
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

function loadHEVCRangeExtensionVector(assetPath: EngineLibraryPath): Promise<ArrayBuffer> {
    return fetchCapabilityAsset(resolveEngineAssetURL(assetPath));
}

function getDefaultEnvironment(): WebCodecsCapabilityEnvironment {
    return {
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        audioDecoder: typeof globalThis.AudioDecoder === 'function' ? globalThis.AudioDecoder : null,
        bundledDTSExactProbe: defaultBundledDTSExactProbe,
        bundledHEVCExactProbe: defaultBundledHEVCExactProbe,
        bundledJPEG2000ExactProbe: defaultBundledJPEG2000ExactProbe,
        bundledMPEG2ExactProbe: defaultBundledMPEG2ExactProbe,
        bundledVC1ExactProbe: defaultBundledVC1ExactProbe,
        bundledTrueHDExactProbe: defaultBundledTrueHDExactProbe,
        h264ProfileProbe: defaultH264ProfileCapabilityProbe,
        hevcRangeExtensionVectorLoader: typeof globalThis.fetch === 'function' ?
            loadHEVCRangeExtensionVector :
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

function hasSupportedBundledHEVCProfile(
    exactCapabilities: BundledHEVCExactCapabilities | null | undefined,
    profile: 'main' | 'main10'
): boolean {
    return Object.values(exactCapabilities?.qualifications ?? {}).some(qualification => (
        qualification.profile === profile && qualification.status === 'supported'
    ));
}

function createBundledHEVCRawHDRCapability(
    exactCapabilities: BundledHEVCExactCapabilities | null | undefined
): CustomRawHDRVideoCodecCapability {
    const main10Qualifications = Object.values(exactCapabilities?.qualifications ?? {})
        .filter(qualification => qualification.profile === 'main10');
    const supportedQualification = main10Qualifications.find(qualification => qualification.status === 'supported');
    const representativeQualification = supportedQualification ?? main10Qualifications[0];
    const baseCapability = {
        bitDepth: 10 as const,
        codec: 'hevc' as const,
        codecString: representativeQualification?.codecString ?? 'hvc1.2.4.L153.B0',
        format: 'I420P10' as const
    };
    if (!representativeQualification) {
        return Object.freeze({
            ...baseCapability,
            reason: 'runtime-unavailable',
            status: 'unknown'
        });
    }
    if (!supportedQualification) {
        return Object.freeze({
            ...baseCapability,
            reason: 'output-copy-unsupported',
            status: 'unsupported'
        });
    }
    return Object.freeze({
        ...baseCapability,
        reason: 'bundled-software-decoder',
        status: 'supported'
    });
}

function selectHEVCRawHDRCapability(
    nativeCapability: CustomRawHDRVideoCodecCapability,
    bundledCapability: CustomRawHDRVideoCodecCapability
): CustomRawHDRVideoCodecCapability {
    if (nativeCapability.status === 'supported') {
        return nativeCapability;
    }
    if (bundledCapability.status === 'supported') {
        return bundledCapability;
    }
    if (nativeCapability.reason === 'api-unavailable') {
        return bundledCapability;
    }
    if (nativeCapability.status === 'unknown') {
        return nativeCapability;
    }
    if (bundledCapability.status === 'unknown') {
        return bundledCapability;
    }
    return nativeCapability;
}

function createRawHDRVideoCapabilities(
    probedCapabilities: readonly CustomRawHDRVideoCodecCapability[],
    bundledHEVC: BundledHEVCExactCapabilities | null
): Record<CustomRawHDRVideoCodec, CustomRawHDRVideoCodecCapability> {
    const capabilities = {} as Record<
        CustomRawHDRVideoCodec,
        CustomRawHDRVideoCodecCapability
    >;
    const bundledHEVCCapability = createBundledHEVCRawHDRCapability(bundledHEVC);
    for (const capability of probedCapabilities) {
        switch (capability.codec) {
            case 'hevc':
                // The bundled qualification decides raw HEVC only beside the native raw probe it always runs with
                capabilities.hevc = capability.status === 'not-probed' ?
                    capability :
                    selectHEVCRawHDRCapability(capability, bundledHEVCCapability);
                break;
            case 'vp9':
                capabilities.vp9 = capability;
                break;
            case 'av1':
                capabilities.av1 = capability;
                break;
        }
    }
    return capabilities;
}

async function probeOptionalExactCapability<Capability>(
    exactProbe: ExactCapabilityProbe<Capability> | null | undefined,
    heavyProbeScheduler: HeavyCapabilityProbeQueue
): Promise<Capability | null> {
    if (!exactProbe) {
        return null;
    }
    try {
        const capability = await heavyProbeScheduler.run(() => exactProbe.probe());
        return capability === CAPABILITY_PROBE_TIMEOUT ? null : capability;
    } catch {
        return null;
    }
}

function createBundledJPEG2000Capability(
    exactCapability: JPEG2000ExactCapability | null
): CustomDecodeCodecCapability<'jpeg2000'> {
    if (!exactCapability) {
        return createUnavailableCapability('jpeg2000', JPEG2000_CODEC_STRING);
    }
    if (exactCapability.status === 'supported') {
        return Object.freeze({
            codec: 'jpeg2000',
            codecString: exactCapability.codecString,
            reason: 'bundled-software-decoder',
            status: 'supported'
        });
    }

    let reason: CustomDecodeCapabilityReason;
    switch (exactCapability.reason) {
        case 'api-unavailable':
            reason = 'api-unavailable';
            break;
        case 'probe-timeout':
            reason = 'probe-timeout';
            break;
        case 'decode-error':
        case 'output-mismatch':
            reason = 'decode-output-missing';
            break;
        case 'asset-unavailable':
        case 'worker-create-failed':
        case 'worker-error':
        case 'worker-message-invalid':
            reason = 'probe-exception';
            break;
        case 'decode-output-verified':
            reason = 'decode-output-missing';
            break;
    }
    return Object.freeze({
        codec: 'jpeg2000',
        codecString: exactCapability.codecString,
        reason,
        status: exactCapability.status
    });
}

function createBundledMPEG2VC1Capability(
    codec: 'mpeg2video' | 'vc1',
    exactCapability: MPEG2VC1ExactCapability | null
): CustomDecodeCodecCapability<'mpeg2video' | 'vc1'> {
    if (!exactCapability) {
        return createUnavailableCapability(codec, codec);
    }
    if (exactCapability.codec !== codec) {
        return Object.freeze({
            codec,
            codecString: codec,
            reason: 'decode-output-missing',
            status: 'unsupported'
        });
    }
    if (exactCapability.status === 'supported') {
        return Object.freeze({
            codec,
            codecString: codec,
            reason: 'bundled-software-decoder',
            status: 'supported'
        });
    }

    let reason: CustomDecodeCapabilityReason;
    switch (exactCapability.reason) {
        case 'api-unavailable':
            reason = 'api-unavailable';
            break;
        case 'probe-timeout':
            reason = 'probe-timeout';
            break;
        case 'decode-error':
        case 'output-mismatch':
            reason = 'decode-output-missing';
            break;
        case 'asset-unavailable':
        case 'worker-create-failed':
        case 'worker-error':
        case 'worker-message-invalid':
            reason = 'probe-exception';
            break;
        case 'decode-output-verified':
            reason = 'decode-output-missing';
            break;
    }
    return Object.freeze({
        codec,
        codecString: codec,
        reason,
        status: exactCapability.status
    });
}

function createBundledDTSCapability(exactCapability: DTSExactCapability | null): CustomDecodeCodecCapability<'dts'> {
    if (!exactCapability) {
        return createUnavailableCapability('dts', 'dts');
    }
    if (exactCapability.status === 'supported') {
        return Object.freeze({
            codec: 'dts',
            codecString: exactCapability.codecString,
            reason: 'bundled-software-decoder',
            status: 'supported'
        });
    }

    let reason: CustomDecodeCapabilityReason;
    switch (exactCapability.reason) {
        case 'api-unavailable':
            reason = 'api-unavailable';
            break;
        case 'probe-timeout':
            reason = 'probe-timeout';
            break;
        case 'throughput-insufficient':
            reason = 'throughput-insufficient';
            break;
        case 'decode-error':
        case 'output-mismatch':
            reason = 'decode-output-missing';
            break;
        case 'asset-unavailable':
        case 'worker-create-failed':
        case 'worker-error':
        case 'worker-message-invalid':
            reason = 'probe-exception';
            break;
        case 'decode-output-verified':
            reason = 'decode-output-missing';
            break;
    }
    return Object.freeze({
        codec: 'dts',
        codecString: exactCapability.codecString,
        reason,
        status: exactCapability.status
    });
}

function createBundledTrueHDCapability<Codec extends 'mlp' | 'truehd'>(
    exactCapability: TrueHDExactCapability | null,
    codec: Codec
): CustomDecodeCodecCapability<Codec> {
    if (!exactCapability) {
        return createUnavailableCapability(codec, codec);
    }
    if (exactCapability.status === 'supported') {
        return Object.freeze({
            codec,
            codecString: codec,
            reason: 'bundled-software-decoder',
            status: 'supported'
        });
    }

    let reason: CustomDecodeCapabilityReason;
    switch (exactCapability.reason) {
        case 'api-unavailable':
            reason = 'api-unavailable';
            break;
        case 'probe-timeout':
            reason = 'probe-timeout';
            break;
        case 'throughput-insufficient':
            reason = 'throughput-insufficient';
            break;
        case 'decode-error':
        case 'major-sync-recovery-failed':
        case 'output-mismatch':
            reason = 'decode-output-missing';
            break;
        case 'asset-unavailable':
        case 'worker-create-failed':
        case 'worker-error':
        case 'worker-message-invalid':
            reason = 'probe-exception';
            break;
        case 'decode-output-verified':
            reason = 'decode-output-missing';
            break;
    }
    return Object.freeze({
        codec,
        codecString: codec,
        reason,
        status: exactCapability.status
    });
}

function createBundledAudioCapability(
    definition: BundledAudioCodecDefinition
): CustomDecodeCodecCapability<CustomAudioCodec> {
    return Object.freeze({
        codec: definition.codec,
        codecString: definition.codecString,
        reason: 'bundled-software-decoder',
        status: 'supported'
    });
}

async function probeH264Profiles(
    profileProbe: Pick<H264ProfileCapabilityProbe, 'probe'> | null | undefined,
    heavyProbeScheduler: HeavyCapabilityProbeQueue
): Promise<H264ProfileCapabilities> {
    if (profileProbe) {
        try {
            const capabilities = await heavyProbeScheduler.run(() => profileProbe.probe());
            if (capabilities !== CAPABILITY_PROBE_TIMEOUT) {
                return capabilities;
            }
        } catch {
            // Fall through to the unavailable result
        }
    }
    return new H264ProfileCapabilityProbe({
        outputProbe: null,
        videoDecoder: null
    }).probe();
}

async function probeRawHDRVideoConfig(
    definition: RawHDRVideoProbeDefinition,
    decoder: DecoderCapabilityAPI<VideoDecoderConfig> | null | undefined,
    outputProbe: RawHDRVideoOutputProbe | null | undefined,
    heavyProbeScheduler: HeavyCapabilityProbeQueue
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

    try {
        const support = await waitForCapabilityProbe(decoder.isConfigSupported({ ...definition.config }));
        if (support === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                ...baseCapability,
                reason: 'probe-timeout',
                status: 'unknown'
            });
        }
        if (support.supported !== true) {
            return Object.freeze({
                ...baseCapability,
                reason: 'config-unsupported',
                status: 'unsupported'
            });
        }
        const outputProbeResult = await heavyProbeScheduler.runTimed(() => outputProbe({
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
            expectedFormat: 'I420P10'
        }));
        if (outputProbeResult === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                ...baseCapability,
                reason: 'probe-timeout',
                status: 'unknown'
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

async function probeHEVCRangeExtensionConfig(
    definition: HEVCRangeExtensionProbeDefinition,
    decoder: DecoderCapabilityAPI<VideoDecoderConfig> | null | undefined,
    outputProbe: RawHDRVideoOutputProbe | null | undefined,
    vectorLoader: HEVCRangeExtensionVectorLoader | null | undefined,
    heavyProbeScheduler: HeavyCapabilityProbeQueue
): Promise<HEVCRangeExtensionCapability> {
    const baseCapability = createHEVCRangeExtensionBaseCapability(definition);
    if (!decoder || !outputProbe || !vectorLoader) {
        return Object.freeze({
            ...baseCapability,
            reason: 'api-unavailable',
            status: 'unknown'
        });
    }

    // The vector downloads alongside the configuration check and every other selected probe's assets
    const vectorDownload: Promise<ArrayBuffer | null> = vectorLoader(definition.assetPath).then(
        (vectorBuffer: ArrayBuffer): ArrayBuffer => vectorBuffer,
        (): null => null
    );
    try {
        const support = await waitForCapabilityProbe(decoder.isConfigSupported({ ...definition.config }));
        if (support === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                ...baseCapability,
                reason: 'probe-timeout',
                status: 'unknown'
            });
        }
        if (support.supported !== true) {
            return Object.freeze({
                ...baseCapability,
                reason: 'config-unsupported',
                status: 'unsupported'
            });
        }

        // NOTE: The download finishes before the timed decode, so a slow link never times out the shared queue
        const vectorBuffer = await vectorDownload;
        if (!vectorBuffer) {
            return Object.freeze({
                ...baseCapability,
                reason: 'asset-unavailable',
                status: 'unknown'
            });
        }
        const outputProbeResult = await heavyProbeScheduler.runTimed(async () => {
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
            return outputProbe({
                codec: 'hevc',
                configuration: definition.config,
                encodedChunks,
                expectedCodedHeight: Number(definition.config.codedHeight),
                expectedCodedWidth: Number(definition.config.codedWidth),
                expectedDecodedFrames,
                expectedFormat: definition.format
            });
        });
        if (outputProbeResult === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                ...baseCapability,
                reason: 'probe-timeout',
                status: 'unknown'
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

async function probeConfig<Codec extends CustomDecodeCodec, Config extends { codec: string }>(
    definition: CodecProbeDefinition<Codec, Config>,
    decoder: DecoderCapabilityAPI<Config> | null | undefined
): Promise<CustomDecodeCodecCapability<Codec>> {
    if (!decoder) {
        return createUnavailableCapability(definition.codec, definition.config.codec);
    }

    try {
        const support = await waitForCapabilityProbe(decoder.isConfigSupported({ ...definition.config }));
        if (support === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: 'probe-timeout',
                status: 'unknown'
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
    heavyProbeScheduler: HeavyCapabilityProbeQueue
): Promise<CustomDecodeCodecCapability<Exclude<CustomAudioCodec, CustomBundledAudioCodec>>> {
    if (!decoder) {
        return createUnavailableCapability(definition.codec, definition.config.codec);
    }

    try {
        const support = await waitForCapabilityProbe(decoder.isConfigSupported({ ...definition.config }));
        if (support === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: 'probe-timeout',
                status: 'unknown'
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
        const outputSupported = await heavyProbeScheduler.runTimed(() => outputProbe({
            codec: definition.codec,
            configuration: { ...definition.config },
            encodedChunks,
            expectedNumberOfChannels: vector.expectedNumberOfChannels,
            expectedNumberOfFrames: vector.expectedNumberOfFrames,
            expectedSampleRate: vector.expectedSampleRate,
            expectedTimestamp: vector.expectedTimestamp
        }));
        if (outputSupported === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: 'probe-timeout',
                status: 'unknown'
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
    heavyProbeScheduler: HeavyCapabilityProbeQueue
): Promise<CustomNativeSurroundAudioCodecCapability> {
    const capability = await probeNativeAudioConfig(definition, decoder, outputProbe, heavyProbeScheduler);
    return Object.freeze({
        codec: definition.codec,
        codecString: capability.codecString,
        inputChannelCount: NATIVE_SURROUND_AUDIO_CAPABILITY_VECTOR_CHANNEL_COUNT,
        reason: capability.reason,
        sampleRate: NATIVE_SURROUND_AUDIO_CAPABILITY_VECTOR_SAMPLE_RATE,
        status: capability.status
    });
}

function createNativeSurroundAudioProbePromises(
    environment: WebCodecsCapabilityEnvironment,
    heavyProbeScheduler: HeavyCapabilityProbeQueue
): Array<Promise<CustomNativeSurroundAudioCodecCapability>> {
    const probePromises: Array<Promise<CustomNativeSurroundAudioCodecCapability>> = [];
    for (const definition of NATIVE_SURROUND_AUDIO_PROBE_DEFINITIONS) {
        probePromises.push(probeNativeSurroundAudioConfig(
            definition,
            environment.audioDecoder,
            environment.nativeAudioOutputProbe,
            heavyProbeScheduler
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

function getNativeSurroundAudioProbeCount(environment: WebCodecsCapabilityEnvironment): number {
    return environment.audioDecoder && environment.nativeAudioOutputProbe ?
        NATIVE_SURROUND_AUDIO_PROBE_DEFINITIONS.length :
        0;
}

async function probeNativeVideoConfig(
    definition: DecodedVideoProbeDefinition,
    decoder: DecoderCapabilityAPI<VideoDecoderConfig> | null | undefined,
    outputProbe: NativeVideoOutputProbe | null | undefined,
    heavyProbeScheduler: HeavyCapabilityProbeQueue
): Promise<CustomDecodeCodecCapability<CustomVideoCodec>> {
    if (!decoder) {
        return createUnavailableCapability(definition.codec, definition.config.codec);
    }

    try {
        const support = await waitForCapabilityProbe(decoder.isConfigSupported({ ...definition.config }));
        if (support === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: 'probe-timeout',
                status: 'unknown'
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
        const outputSupported = await heavyProbeScheduler.runTimed(() => outputProbe({
            codec: definition.codec,
            configuration: {
                ...definition.config,
                codedHeight: vector.expectedCodedHeight,
                codedWidth: vector.expectedCodedWidth
            },
            encodedKeyFrame: vector.encodedKeyFrame.slice(),
            expectedCodedHeight: vector.expectedCodedHeight,
            expectedCodedWidth: vector.expectedCodedWidth,
            expectedDisplayHeight: vector.expectedDisplayHeight,
            expectedDisplayWidth: vector.expectedDisplayWidth,
            expectedTimestamp: 0
        }));
        if (outputSupported === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: 'probe-timeout',
                status: 'unknown'
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
    heavyProbeScheduler: HeavyCapabilityProbeQueue
): Promise<CustomNativeUltraHDVideoCodecCapability> {
    const capability: CustomDecodeCodecCapability<CustomVideoCodec> =
        await probeNativeVideoConfig(definition, decoder, outputProbe, heavyProbeScheduler);
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
    const bundledProbeCount = Number(Boolean(environment.bundledJPEG2000ExactProbe) && selection.has('bundled-jpeg2000'))
        + Number(Boolean(environment.bundledMPEG2ExactProbe) && selection.has('bundled-mpeg2'))
        + Number(Boolean(environment.bundledVC1ExactProbe) && selection.has('bundled-vc1'));
    if (!environment.videoDecoder) {
        return bundledProbeCount;
    }
    return getSelectedProbeCount(selection, VIDEO_CONFIGURATION_PROBES) + bundledProbeCount;
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
    heavyProbeScheduler: HeavyCapabilityProbeQueue
): Promise<NativeHEVCFrameRouteProbeCapability> {
    const unavailableCapability: NativeHEVCFrameRouteProbeCapability = {
        reason: 'api-unavailable',
        status: 'unknown'
    };
    if (!decoder || !outputProbe) {
        return unavailableCapability;
    }

    try {
        const support = await waitForCapabilityProbe(decoder.isConfigSupported({
            ...configuration
        }));
        if (support === CAPABILITY_PROBE_TIMEOUT) {
            return {
                ...unavailableCapability,
                reason: 'probe-timeout'
            };
        }
        if (support.supported !== true) {
            return {
                ...unavailableCapability,
                reason: 'config-unsupported',
                status: 'unsupported'
            };
        }

        const outputProbeResult = await heavyProbeScheduler.runTimed(() => outputProbe({
            configuration,
            encodedKeyFrame: new Uint8Array(encodedKeyFrame),
            expectedCodedHeight,
            expectedCodedWidth
        }));
        if (outputProbeResult === CAPABILITY_PROBE_TIMEOUT) {
            return {
                ...unavailableCapability,
                reason: 'probe-timeout'
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
    heavyProbeScheduler: HeavyCapabilityProbeQueue
): Promise<CustomNativeDolbyVisionHEVCCapability> {
    const routeCapability = await probeNativeHEVCFrameRoute(
        NATIVE_DOLBY_VISION_HEVC_PROBE_DEFINITION.config,
        new Uint8Array(NATIVE_DOLBY_VISION_HEVC_ACCESS_UNIT),
        NATIVE_DOLBY_VISION_HEVC_VECTOR_CODED_HEIGHT,
        NATIVE_DOLBY_VISION_HEVC_VECTOR_CODED_WIDTH,
        decoder,
        outputProbe,
        heavyProbeScheduler
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
    heavyProbeScheduler: HeavyCapabilityProbeQueue
): Promise<CustomNativeHDRHEVCCapability> {
    const routeCapability = await probeNativeHEVCFrameRoute(
        NATIVE_HDR_HEVC_PROBE_DEFINITION.config,
        new Uint8Array(NATIVE_HDR_HEVC_ACCESS_UNIT),
        NATIVE_HDR_HEVC_VECTOR_CODED_HEIGHT,
        NATIVE_HDR_HEVC_VECTOR_CODED_WIDTH,
        decoder,
        outputProbe,
        heavyProbeScheduler
    );
    return Object.freeze({
        codec: NATIVE_HDR_HEVC_PROBE_DEFINITION.codec,
        codecString: NATIVE_HDR_HEVC_PROBE_DEFINITION.config.codec,
        bitDepth: 10 as const,
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
    h264Profiles: H264ProfileCapabilities | undefined,
    bundledHEVC: BundledHEVCExactCapabilities | undefined
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
            case 'hevc':
                if (
                    hasSupportedNativeSDRVideoCodec(codec, capabilities)
                    || hasSupportedBundledHEVCProfile(bundledHEVC, 'main')
                ) {
                    supportedCount += 1;
                }
                break;
            case 'av1':
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
    heavyProbeScheduler: HeavyCapabilityProbeQueue
): Array<Promise<CustomDecodeCodecCapability<CustomAudioCodec>>> {
    const probePromises: Array<Promise<CustomDecodeCodecCapability<CustomAudioCodec>>> = [];
    for (const definition of AUDIO_PROBE_DEFINITIONS) {
        probePromises.push(probeNativeAudioConfig(
            definition,
            environment.audioDecoder,
            environment.nativeAudioOutputProbe,
            heavyProbeScheduler
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
    // The bundled decoder backs Main without native decode, raw Main 10 planes, and every dual-layer EL
    probes.add('bundled-hevc');
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
        case 'vp9':
            probes.add(getNativeSDRVideoProbe(codec));
            probes.add(getNativeUltraHDVideoProbe(codec));
            if (beyondNativeSDR) {
                probes.add(getRawVideoProbe(codec));
            }
            break;
        case 'h264':
            probes.add('h264-profiles');
            break;
        case 'hevc':
            addHEVCStreamProbes(stream, dynamicRange, beyondNativeSDR, probes);
            break;
        case 'jpeg2000':
            probes.add('bundled-jpeg2000');
            break;
        case 'mpeg2video':
            probes.add('bundled-mpeg2');
            break;
        case 'vc1':
            probes.add('bundled-vc1');
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

/** Starts every selected exact probe's downloads at once; their decodes still take turns in the heavy queue. */
function prepareExactProbes(
    selection: ReadonlySet<CustomDecodeProbe>,
    environment: WebCodecsCapabilityEnvironment
): void {
    const exactProbes: Array<readonly [ CustomDecodeProbe, ExactCapabilityProbe<unknown> | null | undefined ]> = [
        [ 'bundled-dts', environment.bundledDTSExactProbe ],
        [ 'bundled-truehd', environment.bundledTrueHDExactProbe ],
        [ 'bundled-hevc', environment.bundledHEVCExactProbe ],
        [ 'bundled-jpeg2000', environment.bundledJPEG2000ExactProbe ],
        [ 'bundled-mpeg2', environment.bundledMPEG2ExactProbe ],
        [ 'bundled-vc1', environment.bundledVC1ExactProbe ]
    ];
    for (const [ probe, exactProbe ] of exactProbes) {
        if (!selection.has(probe)) {
            continue;
        }
        try {
            exactProbe?.prepare?.();
        } catch {
            // A probe whose downloads cannot start early downloads them in its turn
        }
    }
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
    bundledDTS: DTSExactCapability | null
    bundledTrueHD: TrueHDExactCapability | null
    nativeAudio: readonly CustomDecodeCodecCapability<CustomAudioCodec>[]
    nativeSurroundAudio: readonly CustomNativeSurroundAudioCodecCapability[]
}>;

type H264ProbeResult = Readonly<{
    configuration: CustomDecodeCodecCapability<CustomVideoCodec>
    profiles: H264ProfileCapabilities
}>;

// An unselected probe holds its not-probed result, or null for an exact or H.264 probe
type VideoProbeResults = Readonly<{
    bundledHEVC: BundledHEVCExactCapabilities | null
    bundledJPEG2000: JPEG2000ExactCapability | null
    bundledMPEG2: MPEG2VC1ExactCapability | null
    bundledVC1: MPEG2VC1ExactCapability | null
    h264: H264ProbeResult | null
    hevcRangeExtensions: readonly HEVCRangeExtensionCapability[]
    nativeDolbyVisionHEVC: CustomNativeDolbyVisionHEVCCapability
    nativeHDRHEVC: CustomNativeHDRHEVCCapability
    nativeSDRVideo: readonly CustomDecodeCodecCapability<CustomVideoCodec>[]
    nativeUltraHDVideo: readonly CustomNativeUltraHDVideoCodecCapability[]
    rawVideo: readonly CustomRawHDRVideoCodecCapability[]
}>;

type ExactCapabilities = Pick<
    CustomDecodeCapabilities,
    | 'bundledDTS'
    | 'bundledHEVC'
    | 'bundledJPEG2000'
    | 'bundledMPEG2'
    | 'bundledTrueHD'
    | 'bundledVC1'
    | 'h264Profiles'
>;

type ProbeTelemetryCapabilities = ExactCapabilities & Required<Pick<
    CustomDecodeCapabilities,
    | 'audio'
    | 'nativeDolbyVisionHEVC'
    | 'nativeHDRHEVC'
    | 'nativeSurroundAudio'
    | 'nativeUltraHDVideo'
    | 'rawHDRVideo'
    | 'video'
>>;

async function probeH264(
    environment: WebCodecsCapabilityEnvironment,
    heavyProbeScheduler: HeavyCapabilityProbeQueue
): Promise<H264ProbeResult> {
    const [ configuration, profiles ] = await Promise.all([
        probeConfig(H264_CONFIGURATION_PROBE_DEFINITION, environment.videoDecoder),
        probeH264Profiles(environment.h264ProfileProbe, heavyProbeScheduler)
    ]);
    return { configuration, profiles };
}

function createVideoCodecCapabilities(
    selection: ReadonlySet<CustomDecodeProbe>,
    videoResults: VideoProbeResults
): Readonly<Record<CustomVideoCodec, CustomDecodeCodecCapability<CustomVideoCodec>>> {
    const videoCapabilities: Array<CustomDecodeCodecCapability<CustomVideoCodec>> = [];
    videoCapabilities.push(
        videoResults.h264?.configuration
            ?? createNotProbedCapability('h264', H264_CONFIGURATION_PROBE_DEFINITION.config.codec),
        ...videoResults.nativeSDRVideo,
        selection.has('bundled-jpeg2000') ?
            createBundledJPEG2000Capability(videoResults.bundledJPEG2000) :
            createNotProbedCapability('jpeg2000', JPEG2000_CODEC_STRING),
        selection.has('bundled-mpeg2') ?
            createBundledMPEG2VC1Capability('mpeg2video', videoResults.bundledMPEG2) :
            createNotProbedCapability('mpeg2video', 'mpeg2video'),
        selection.has('bundled-vc1') ?
            createBundledMPEG2VC1Capability('vc1', videoResults.bundledVC1) :
            createNotProbedCapability('vc1', 'vc1')
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
    audioCapabilities.push(createBundledDTSCapability(audioResults.bundledDTS));
    audioCapabilities.push(createBundledTrueHDCapability(audioResults.bundledTrueHD, 'mlp'));
    audioCapabilities.push(createBundledTrueHDCapability(audioResults.bundledTrueHD, 'truehd'));
    for (const definition of BUNDLED_AUDIO_CODEC_DEFINITIONS) {
        audioCapabilities.push(createBundledAudioCapability(definition));
    }
    const audio = {} as Record<CustomAudioCodec, CustomDecodeCodecCapability<CustomAudioCodec>>;
    for (const capability of audioCapabilities) {
        audio[capability.codec] = capability;
    }
    return Object.freeze(audio);
}

/** Returns the exact and H.264 profile results that ran and settled; an absent one claims nothing. */
function createExactCapabilities(
    audioResults: AudioProbeResults,
    videoResults: VideoProbeResults
): ExactCapabilities {
    const exactCapabilities: ExactCapabilities = {};
    if (audioResults.bundledDTS) {
        exactCapabilities.bundledDTS = audioResults.bundledDTS;
    }
    if (videoResults.bundledHEVC) {
        exactCapabilities.bundledHEVC = videoResults.bundledHEVC;
    }
    if (videoResults.bundledJPEG2000) {
        exactCapabilities.bundledJPEG2000 = videoResults.bundledJPEG2000;
    }
    if (videoResults.bundledMPEG2) {
        exactCapabilities.bundledMPEG2 = videoResults.bundledMPEG2;
    }
    if (audioResults.bundledTrueHD) {
        exactCapabilities.bundledTrueHD = audioResults.bundledTrueHD;
    }
    if (videoResults.bundledVC1) {
        exactCapabilities.bundledVC1 = videoResults.bundledVC1;
    }
    if (videoResults.h264) {
        exactCapabilities.h264Profiles = videoResults.h264.profiles;
    }
    return exactCapabilities;
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
    const nativeSurroundAudioCapabilities = Object.values(capabilities.nativeSurroundAudio);
    const nativeUltraHDVideoCapabilities = Object.values(capabilities.nativeUltraHDVideo);
    const allCapabilities: Array<CustomDecodeCodecCapability<CustomDecodeCodec>> = [];
    allCapabilities.push(
        ...videoCapabilities,
        ...audioCapabilities,
        capabilities.nativeDolbyVisionHEVC,
        capabilities.nativeHDRHEVC,
        ...nativeSurroundAudioCapabilities,
        ...nativeUltraHDVideoCapabilities
    );
    const nativeHDRVideoOutputAvailable = Boolean(environment.videoDecoder && environment.nativeHDRVideoOutputProbe);
    const rawVideoOutputAvailable = Boolean(environment.videoDecoder && environment.rawHDRVideoOutputProbe);
    return Object.freeze({
        audioProbeCount: environment.audioDecoder ? AUDIO_PROBE_DEFINITIONS.length : 0,
        // Plus DTS, MLP, and TrueHD
        bundledAudioCodecCount: BUNDLED_AUDIO_CODEC_DEFINITIONS.length + 3,
        nativeSurroundAudioProbeCount: getNativeSurroundAudioProbeCount(environment),
        nativeHDRVideoProbeCount: Number(nativeHDRVideoOutputAvailable && selection.has('native-hdr-hevc')),
        nativeUltraHDVideoProbeCount: getNativeUltraHDVideoProbeCount(environment, selection),
        rawHDRVideoProbeCount: rawVideoOutputAvailable ? getSelectedProbeCount(selection, RAW_VIDEO_PROBES) : 0,
        reason: getProbeReason(environment, allCapabilities),
        supportedAudioCodecCount: countCapabilityStatus(audioCapabilities, 'supported'),
        supportedNativeSurroundAudioCodecCount: countCapabilityStatus(nativeSurroundAudioCapabilities, 'supported'),
        supportedNativeHDRVideoCodecCount: countCapabilityStatus([ capabilities.nativeHDRHEVC ], 'supported'),
        supportedNativeUltraHDVideoCodecCount: countCapabilityStatus(nativeUltraHDVideoCapabilities, 'supported'),
        supportedRawHDRVideoCodecCount: countCapabilityStatus(Object.values(capabilities.rawHDRVideo), 'supported'),
        supportedVideoCodecCount: getSupportedVideoCodecCount(
            capabilities,
            capabilities.h264Profiles,
            capabilities.bundledHEVC
        ),
        unknownAudioCodecCount: countCapabilityStatus(audioCapabilities, 'unknown'),
        unknownNativeSurroundAudioCodecCount: countCapabilityStatus(nativeSurroundAudioCapabilities, 'unknown'),
        unknownNativeHDRVideoCodecCount: countCapabilityStatus([ capabilities.nativeHDRHEVC ], 'unknown'),
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
        ...createExactCapabilities(audioResults, videoResults),
        audio: createAudioCodecCapabilities(audioResults),
        nativeDolbyVisionHEVC: videoResults.nativeDolbyVisionHEVC,
        nativeHDRHEVC: videoResults.nativeHDRHEVC,
        nativeSurroundAudio: createNativeSurroundAudioCapabilities(audioResults.nativeSurroundAudio),
        nativeUltraHDVideo: createNativeUltraHDVideoCapabilities(videoResults.nativeUltraHDVideo),
        rawHDRVideo: Object.freeze(createRawHDRVideoCapabilities(videoResults.rawVideo, videoResults.bundledHEVC)),
        video: createVideoCodecCapabilities(selection, videoResults)
    };
    return Object.freeze({
        ...capabilities,
        hevcRangeExtensions: createHEVCRangeExtensionCapabilities(videoResults.hevcRangeExtensions),
        probeStates: createProbeStates(selection),
        telemetry: createProbeTelemetry(environment, selection, capabilities)
    });
}

/** Probes decode capabilities per item; each probe runs once per page, and a later item reuses its result. */
export default class CustomDecodeCapabilityProbe {
    private environment: WebCodecsCapabilityEnvironment | null;
    // One queue for the page, so probes started for different items still run one heavy probe at a time
    private readonly heavyProbeScheduler = new SerializedHeavyCapabilityProbeScheduler();
    private readonly probeResults = new Map<CustomDecodeProbe, Promise<unknown>>();
    private readonly selectionResults = new Map<string, Promise<CustomDecodeCapabilities>>();

    public constructor(environment: WebCodecsCapabilityEnvironment | null = null) {
        this.environment = environment;
    }

    /**
     * Returns the capabilities an item needs; items that select the same probes share one result.
     * Without an item, or for one without stream metadata, every probe runs.
     */
    public probe(item?: unknown): Promise<CustomDecodeCapabilities> {
        const selection = selectCustomDecodeProbes(item);
        const selectionKey = selection.join(',');
        let capabilities = this.selectionResults.get(selectionKey);
        if (!capabilities) {
            capabilities = this.runProbes(new Set<CustomDecodeProbe>(selection));
            this.selectionResults.set(selectionKey, capabilities);
        }
        return capabilities;
    }

    private async runProbes(selection: ReadonlySet<CustomDecodeProbe>): Promise<CustomDecodeCapabilities> {
        const environment = this.environment ?? getDefaultEnvironment();
        this.environment = environment;
        prepareExactProbes(selection, environment);
        const audioProbes = this.startAudioProbes(environment);
        // Video work joins the heavy queue behind every audio probe, so a video timeout never costs audio its verdicts
        const videoProbes = this.startVideoProbes(
            selection,
            environment,
            this.heavyProbeScheduler.after(audioProbes)
        );
        const [ audioResults, videoResults ] = await Promise.all([ audioProbes, videoProbes ]);
        return createCustomDecodeCapabilities(environment, selection, audioResults, videoResults);
    }

    /** Starts every audio probe once per page, because a playing item can switch to any of its audio tracks. */
    private async startAudioProbes(environment: WebCodecsCapabilityEnvironment): Promise<AudioProbeResults> {
        const heavyProbeScheduler = this.heavyProbeScheduler;
        const [ nativeAudio, nativeSurroundAudio, bundledDTS, bundledTrueHD ] = await Promise.all([
            this.startProbe('native-audio', () => Promise.all(
                createAudioProbePromises(environment, heavyProbeScheduler)
            )),
            this.startProbe('native-surround-audio', () => Promise.all(
                createNativeSurroundAudioProbePromises(environment, heavyProbeScheduler)
            )),
            this.startProbe('bundled-dts', () => probeOptionalExactCapability(
                environment.bundledDTSExactProbe,
                heavyProbeScheduler
            )),
            this.startProbe('bundled-truehd', () => probeOptionalExactCapability(
                environment.bundledTrueHDExactProbe,
                heavyProbeScheduler
            ))
        ]);
        return { bundledDTS, bundledTrueHD, nativeAudio, nativeSurroundAudio };
    }

    /** Starts the selected video probes that no earlier item started, in queue order; an unselected probe resolves as not probed. */
    private async startVideoProbes(
        selection: ReadonlySet<CustomDecodeProbe>,
        environment: WebCodecsCapabilityEnvironment,
        videoQueue: HeavyCapabilityProbeQueue
    ): Promise<VideoProbeResults> {
        const h264 = this.startSelectedProbe<H264ProbeResult | null>(
            selection,
            'h264-profiles',
            () => probeH264(environment, videoQueue),
            null
        );
        const nativeSDRVideo = Promise.all(NATIVE_SDR_VIDEO_PROBE_DEFINITIONS.map(
            (definition: NativeSDRVideoProbeDefinition): Promise<CustomDecodeCodecCapability<CustomVideoCodec>> => (
                this.startSelectedProbe<CustomDecodeCodecCapability<CustomVideoCodec>>(
                    selection,
                    getNativeSDRVideoProbe(definition.codec),
                    () => probeNativeVideoConfig(
                        definition,
                        environment.videoDecoder,
                        environment.nativeVideoOutputProbe,
                        videoQueue
                    ),
                    createNotProbedCapability(definition.codec, definition.config.codec)
                )
            )
        ));
        const nativeUltraHDVideo = Promise.all(NATIVE_ULTRA_HD_VIDEO_PROBE_DEFINITIONS.map(
            (definition: NativeUltraHDVideoProbeDefinition): Promise<CustomNativeUltraHDVideoCodecCapability> => (
                this.startSelectedProbe(
                    selection,
                    getNativeUltraHDVideoProbe(definition.codec),
                    () => probeNativeUltraHDVideoConfig(
                        definition,
                        environment.videoDecoder,
                        environment.nativeVideoOutputProbe,
                        videoQueue
                    ),
                    createNotProbedNativeUltraHDVideoCapability(definition)
                )
            )
        ));
        const rawVideo = Promise.all(RAW_HDR_VIDEO_PROBE_DEFINITIONS.map(
            (definition: RawHDRVideoProbeDefinition): Promise<CustomRawHDRVideoCodecCapability> => (
                this.startSelectedProbe(
                    selection,
                    getRawVideoProbe(definition.codec),
                    () => probeRawHDRVideoConfig(
                        definition,
                        environment.videoDecoder,
                        environment.rawHDRVideoOutputProbe,
                        videoQueue
                    ),
                    createNotProbedRawVideoCapability(definition)
                )
            )
        ));
        const hevcRangeExtensions = Promise.all(HEVC_RANGE_EXTENSION_VARIANTS.map(
            (variant: HEVCRangeExtensionVariant): Promise<HEVCRangeExtensionCapability> => (
                this.startSelectedProbe(
                    selection,
                    getHEVCRangeExtensionVideoProbe(variant),
                    () => probeHEVCRangeExtensionConfig(
                        HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant],
                        environment.videoDecoder,
                        environment.rawHDRVideoOutputProbe,
                        environment.hevcRangeExtensionVectorLoader,
                        videoQueue
                    ),
                    createNotProbedHEVCRangeExtensionCapability(variant)
                )
            )
        ));
        const bundledHEVC = this.startSelectedProbe<BundledHEVCExactCapabilities | null>(
            selection,
            'bundled-hevc',
            () => probeOptionalExactCapability(environment.bundledHEVCExactProbe, videoQueue),
            null
        );
        const bundledJPEG2000 = this.startSelectedProbe<JPEG2000ExactCapability | null>(
            selection,
            'bundled-jpeg2000',
            () => probeOptionalExactCapability(environment.bundledJPEG2000ExactProbe, videoQueue),
            null
        );
        const bundledMPEG2 = this.startSelectedProbe<MPEG2VC1ExactCapability | null>(
            selection,
            'bundled-mpeg2',
            () => probeOptionalExactCapability(environment.bundledMPEG2ExactProbe, videoQueue),
            null
        );
        const bundledVC1 = this.startSelectedProbe<MPEG2VC1ExactCapability | null>(
            selection,
            'bundled-vc1',
            () => probeOptionalExactCapability(environment.bundledVC1ExactProbe, videoQueue),
            null
        );
        const nativeDolbyVisionHEVC = this.startSelectedProbe(
            selection,
            'native-dolby-vision-hevc',
            () => probeNativeDolbyVisionHEVC(
                environment.videoDecoder,
                environment.nativeDolbyVisionVideoOutputProbe,
                videoQueue
            ),
            NOT_PROBED_NATIVE_DOLBY_VISION_HEVC_CAPABILITY
        );
        const nativeHDRHEVC = this.startSelectedProbe(
            selection,
            'native-hdr-hevc',
            () => probeNativeHDRHEVC(environment.videoDecoder, environment.nativeHDRVideoOutputProbe, videoQueue),
            NOT_PROBED_NATIVE_HDR_HEVC_CAPABILITY
        );
        return {
            bundledHEVC: await bundledHEVC,
            bundledJPEG2000: await bundledJPEG2000,
            bundledMPEG2: await bundledMPEG2,
            bundledVC1: await bundledVC1,
            h264: await h264,
            hevcRangeExtensions: await hevcRangeExtensions,
            nativeDolbyVisionHEVC: await nativeDolbyVisionHEVC,
            nativeHDRHEVC: await nativeHDRHEVC,
            nativeSDRVideo: await nativeSDRVideo,
            nativeUltraHDVideo: await nativeUltraHDVideo,
            rawVideo: await rawVideo
        };
    }

    /** Starts a probe once per page; a later run shares its promise. */
    private startProbe<Result>(probe: CustomDecodeProbe, start: () => Promise<Result>): Promise<Result> {
        // Each identifier always starts the same probe, so its promise carries that probe's result type
        const startedProbe = this.probeResults.get(probe) as Promise<Result> | undefined;
        if (startedProbe) {
            return startedProbe;
        }
        const probeResult = start();
        this.probeResults.set(probe, probeResult);
        return probeResult;
    }

    /** Starts a selected probe once per page; a probe outside the selection resolves to its not-probed result. */
    private startSelectedProbe<Result>(
        selection: ReadonlySet<CustomDecodeProbe>,
        probe: CustomDecodeProbe,
        start: () => Promise<Result>,
        notProbedResult: Result
    ): Promise<Result> {
        return selection.has(probe) ? this.startProbe(probe, start) : Promise.resolve(notProbedResult);
    }
}

const defaultCapabilityProbe = new CustomDecodeCapabilityProbe();

/**
 * Probes what an item needs and reuses each probe's result for the page's lifetime.
 * Every audio probe runs; the video probes follow the item's streams, and no item, or one without stream metadata, runs them all.
 */
export function probeCustomDecodeCapabilities(item?: unknown): Promise<CustomDecodeCapabilities> {
    return defaultCapabilityProbe.probe(item);
}
