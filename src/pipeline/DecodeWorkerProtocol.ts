import type { VideoCodec } from 'mediabunny';

import type { Microseconds } from '../MediaTime';
import {
    isWorkerTimingTraceEvent,
    MAXIMUM_TIMING_TRACE_EVENTS_PER_MESSAGE,
    type WorkerTimingTraceEvent
} from '../TimingTrace';
import {
    isTransferableDolbyVisionEncodedFrameMetadata,
    MAXIMUM_DOLBY_VISION_FRAME_RPU_COUNT,
    type TransferableDolbyVisionEncodedFrameMetadata
} from '../video/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import {
    isHDR10PlusFrameMetadata,
    type HDR10PlusFrameMetadata,
    type HDR10PlusFrameMetadataStatus
} from '../video/hdr/HDR10PlusMetadata';
import { isHDR10PlusFrameMetadataStatus } from '../presentation/WorkerPresentationProtocol';
import {
    MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH,
    MAXIMUM_NATIVE_AUDIO_SEGMENT_DURATION_MICROSECONDS
} from '../audio/native/NativeMediaAudioLimits';
import {
    hasRawVideoFrameCopyLayout,
    MAXIMUM_OUTSTANDING_RAW_FRAME_TRANSFER_COUNT,
    RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT,
    RAW_VIDEO_DOLBY_VISION_FRAME_LAYER_COUNT,
    RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT,
    RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT,
    type RawVideoPlaneDescriptor,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from '../video/RawVideoFrameCopy';
import {
    isStaticHDRMetadataScanResult,
    type StaticHDRMetadataScanResult
} from '../video/hdr/StaticHDRMetadata';
import type { CustomAudioOutputChannelCount } from '../audio/processing/CustomAudioChannelLayout';
import {
    assertValidAudioDownmixSettings,
    type AudioDownmixSettings
} from '../audio/processing/CustomAudioDownmix';
import {
    isCustomAudioDownmixAlgorithm,
    type CustomAudioDownmixAlgorithm
} from '../audio/processing/CustomAudioDownmixAlgorithm';
import { isSupportedCustomAudioSampleRate } from '../audio/CustomAudioSampleRate';
import { isDolbyVisionDualLayerProfile } from '../video/dolby-vision/DolbyVisionProfiles';

export const MAX_DECODED_FRAME_CREDITS = 4;
export const MAX_DECODED_RAW_FRAME_CREDITS = MAXIMUM_OUTSTANDING_RAW_FRAME_TRANSFER_COUNT;
export const MAX_DECODED_AUDIO_SAMPLE_CREDITS = 8;
export const MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE = 65_536;
export const MAX_DECODED_AUDIO_CHANNELS = 32;
export const MAXIMUM_VIDEO_STARTUP_PROGRESS_PACKET_COUNT = 512;
const MAXIMUM_CODEC_ASSET_URL_LENGTH = 2_048;
export const MAXIMUM_RENDERER_STATUS_REASON_LENGTH = 256;
// The fields of a frame with its payload, which a worker-frame descriptor never carries
const WORKER_FRAME_PAYLOAD_FIELDS = Object.freeze([
    'encodedDolbyVisionMetadata',
    'enhancementFrame',
    'frame',
    'HDR10PlusMetadata'
] as const);

export type CustomDecodeVideoOutputMode = 'raw-planes' | 'video-frame';
export type CustomDecodeRawVideoFrameFormat =
    | 'I420'
    | 'I420P10'
    | 'I420P12'
    | 'I422'
    | 'I422P10'
    | 'I422P12'
    | 'I444'
    | 'I444P10'
    | 'I444P12';
export type CustomDecodeVideoDecoderBackend =
    | 'bundled-hevc'
    | 'ffmpeg-mpeg2-vc1'
    | 'native'
    | 'openjpeg';
export type CustomDecodeAudioOutputMode = 'decoded-pcm' | 'native-media';
/** Where a generation's frames present: on the page, or in the worker renderer, which keeps them. */
export type CustomDecodePresentationMode = 'main' | 'worker';
/** An RPU reconstruction route: Profiles 4 and 7 are dual-layer, Profiles 5 and 8 single-layer. */
export type CustomDecodeDolbyVisionProfile = 4 | 5 | 7 | 8 | null;
export type CustomDecodeNativeHDRTransfer = 'hlg' | 'pq' | null;
export type CustomDecodeWorkerProgressPhase =
    | 'video-decoder-ready'
    | 'video-key-packet-ready'
    | 'video-packet-decoded'
    | 'video-packet-started';

/**
 * Returns whether a codec's raw planes need its software decoder.
 * Chromium's hardware AV1 and VP9 decoders return opaque surfaces whose planes copyTo cannot expose, while dav1d and libvpx return copyable planes.
 * Chromium has no software HEVC decoder, so HEVC keeps its hardware decoder.
 */
function requiresSoftwareRawPlaneDecode(videoCodec: VideoCodec | null): boolean {
    switch (videoCodec) {
        case 'av1':
        case 'vp9':
            return true;
        default:
            return false;
    }
}

/**
 * Matches a qualified route to the acceleration preference its capability probes measured.
 * Native routes that present the decoder's opaque hardware output prefer hardware.
 * Raw AV1 and VP9 planes prefer software.
 * Every other native route qualifies with no preference, so a codec without a hardware decoder decodes in software, as VP8 does in Chromium on Windows.
 */
export function getCustomDecodeHardwareAcceleration(
    videoOutputMode: CustomDecodeVideoOutputMode,
    videoDecoderBackend: CustomDecodeVideoDecoderBackend = 'native',
    hardwareOutputRequired = false,
    videoCodec: VideoCodec | null = null
): HardwareAcceleration {
    if (videoDecoderBackend !== 'native') {
        return 'prefer-software';
    }
    switch (videoOutputMode) {
        case 'raw-planes':
            return requiresSoftwareRawPlaneDecode(videoCodec) ? 'prefer-software' : 'no-preference';
        case 'video-frame':
            return hardwareOutputRequired ? 'prefer-hardware' : 'no-preference';
    }
}

/**
 * Returns the acceleration preference of a start request's video route on its track's codec.
 * The codec is null for a bundled decoder outside WebCodecs.
 * On a native VideoFrame route, neutralized color marks the external HDR route and the native Dolby Vision base, and a Dolby Vision profile marks external Profile 5.
 * Both present the decoder's opaque hardware output.
 */
export function getCustomDecodeRequestHardwareAcceleration(
    request: Pick<
        DecodeWorkerStartRequest,
        'dolbyVisionProfile' | 'neutralizeHDRColorMetadata' | 'videoDecoderBackend' | 'videoOutputMode'
    >,
    videoCodec: VideoCodec | null
): HardwareAcceleration {
    return getCustomDecodeHardwareAcceleration(
        request.videoOutputMode,
        request.videoDecoderBackend,
        request.neutralizeHDRColorMetadata || request.dolbyVisionProfile !== null,
        videoCodec
    );
}

export type CustomDecodeFailureKind =
    | 'audio-output-failed'
    | 'decode-failed'
    | 'network-failed'
    | 'range-unsupported'
    | 'source-unsupported';

/** Starts a generation's run in the session's worker, which an earlier generation may have used. */
export type DecodeWorkerStartRequest = {
    /** Applies only when decoded multichannel PCM must be presented as stereo. */
    audioDownmixAlgorithm?: CustomAudioDownmixAlgorithm
    /** Applies user channel and output gains after selecting the downmix matrix. */
    audioDownmixSettings?: AudioDownmixSettings
    /** Defaults to decoded-pcm. */
    audioOutputMode?: CustomDecodeAudioOutputMode
    audioSampleCredits: number
    /** Zero-based ordinal within input.getAudioTracks(), not a Jellyfin stream index. */
    audioTrackIndex: number | null
    /** Defaults to stereo and is valid only for decoded PCM audio. */
    decodedAudioOutputChannelCount?: CustomAudioOutputChannelCount
    /** Asks a dual-layer route to leave its EL undecoded, because no qualified decoder decodes it. */
    discardDolbyVisionEnhancementLayer?: boolean
    dolbyVisionProfile: CustomDecodeDolbyVisionProfile
    dolbyVisionRPUParserWASMURL: string
    frameCredits: number
    generation: number
    maximumCodedHeight: number
    maximumCodedWidth: number
    nativeHDRTransfer: CustomDecodeNativeHDRTransfer
    neutralizeHDRColorMetadata: boolean
    /** Defaults to main; in worker mode the worker keeps each frame for its renderer and posts a worker-frame descriptor */
    presentationMode?: CustomDecodePresentationMode
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    /** Asks for the container's duration in the ready response, because the server reported none */
    reportContainerDuration?: boolean
    startTimeMicroseconds: Microseconds
    /** Asks the worker to send its timing events, because the page records a timing trace */
    timingTrace?: boolean
    type: 'start'
    url: string
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
    videoOutputMode: CustomDecodeVideoOutputMode
    /** Zero-based ordinal within input.getVideoTracks(), not a Jellyfin stream index. */
    videoTrackIndex: number
};

export type DecodeWorkerPullRequest = {
    frameCredits: number
    generation: number
    type: 'pull'
};

/** Returns native media audio segment credits; decoded PCM takes its credits from its worklet producer. */
export type DecodeWorkerAudioPullRequest = {
    /** Omitted epochs mean the initial audio attempt, epoch zero. */
    audioEpoch?: number
    audioSampleCredits: number
    generation: number
    type: 'pull-audio'
};

/** The producer's end of a channel to the AudioWorklet processor, with the bounds of the worklet it feeds */
export type DecodeWorkerAudioOutputAttachment = {
    /** The credit window: the most chunks in flight to the processor at once */
    audioSampleCredits: number
    channelCount: number
    /** The processor's queue bound in frames */
    maximumBufferedFrameCount: number
    port: MessagePort
    sampleRate: number
    /** The worklet generation whose chunks the processor accepts on this channel */
    workletGeneration: number
};

/**
 * Gives decoded audio its channel to the AudioWorklet processor once the page's output exists.
 * The epoch's audio attempt waits for it, and its credit window replaces the start request's zero credits.
 */
export type DecodeWorkerAttachAudioOutputRequest = {
    audioEpoch: number
    audioOutput: DecodeWorkerAudioOutputAttachment
    generation: number
    type: 'attach-audio-output'
};

export type DecodeWorkerUpdateAudioDownmixSettingsRequest = {
    audioDownmixSettings: AudioDownmixSettings
    generation: number
    type: 'update-audio-downmix-settings'
};

export type DecodeWorkerRecycleFrameRequest = {
    buffer: ArrayBuffer
    generation: number
    type: 'recycle-frame'
};

/**
 * Gives the worker its renderer: the canvas the presenter transferred and the renderer's end of the presenter's channel.
 * The session sends it once per worker, before the worker's first start, and the worker answers `renderer-status`.
 */
export type DecodeWorkerAttachRendererRequest = {
    canvas: OffscreenCanvas
    /** The generation whose start waits for the renderer's status, which echoes it */
    generation: number
    port: MessagePort
    type: 'attach-renderer'
};

/**
 * Releases worker frames the page dropped, discarded, presented, or abandoned.
 * Each frame of a running run returns a frame credit, as `pull` does; a run that ended or is stopping gets none back.
 * A frame outlives its run until the page releases it, so the page can still present the frames that finished a run; the worker's next start frees any it still holds.
 */
export type DecodeWorkerReleaseFramesRequest = {
    frameIds: readonly number[]
    generation: number
    type: 'release-frames'
};

/** Ends a generation's run; the worker answers `stopped` once the run has released its decoders. */
export type DecodeWorkerStopRequest = {
    generation: number
    type: 'stop'
};

/** Restarts only the video stream from the key packet before a target while audio continues. */
export type DecodeWorkerResyncVideoRequest = {
    generation: number
    targetTimeMicroseconds: Microseconds
    type: 'resync-video'
    /** Increases with every video control request; frames from older epochs are stale. */
    videoEpoch: number
};

/** Ends the current video attempt and releases its decoders while audio continues. */
export type DecodeWorkerSuspendVideoRequest = {
    generation: number
    type: 'suspend-video'
    videoEpoch: number
};

/**
 * Restarts only decoded PCM audio at a target with a new output layout while video continues.
 * The output stage is rebuilt; demux and video are untouched.
 */
export type DecodeWorkerResyncAudioRequest = {
    audioDownmixAlgorithm?: CustomAudioDownmixAlgorithm
    audioDownmixSettings?: AudioDownmixSettings
    /** Increases with every audio resync; samples from older epochs are stale */
    audioEpoch: number
    /** The new worklet's channel, whose credit window replaces the whole old one, since the replaced attempt's chunks never return credits */
    audioOutput: DecodeWorkerAudioOutputAttachment
    decodedAudioOutputChannelCount: CustomAudioOutputChannelCount
    generation: number
    targetTimeMicroseconds: Microseconds
    type: 'resync-audio'
};

export type DecodeWorkerRequest =
    | DecodeWorkerAttachAudioOutputRequest
    | DecodeWorkerAttachRendererRequest
    | DecodeWorkerAudioPullRequest
    | DecodeWorkerPullRequest
    | DecodeWorkerRecycleFrameRequest
    | DecodeWorkerReleaseFramesRequest
    | DecodeWorkerResyncAudioRequest
    | DecodeWorkerResyncVideoRequest
    | DecodeWorkerStartRequest
    | DecodeWorkerStopRequest
    | DecodeWorkerSuspendVideoRequest
    | DecodeWorkerUpdateAudioDownmixSettingsRequest;

export type DecodeWorkerAudioConfiguration = {
    channelCount: number
    codec: string
    sampleRate: number
    sourceChannelCount?: number
    sourceSampleRate?: number
};

export type DecodeWorkerNativeMediaAudioConfiguration = DecodeWorkerAudioConfiguration & {
    mimeType: string
    outputMode: 'native-media'
};

export type DecodeWorkerReadyAudioConfiguration =
    | DecodeWorkerAudioConfiguration
    | DecodeWorkerNativeMediaAudioConfiguration;

export type DecodeWorkerReadyResponse = {
    audio: DecodeWorkerReadyAudioConfiguration | null
    codec: string
    codedHeight: number
    codedWidth: number
    /** The duration in the container's metadata, sent only when the start request asked for it */
    containerDurationMicroseconds?: Microseconds
    displayHeight: number
    displayWidth: number
    generation: number
    staticHDRMetadataScan?: StaticHDRMetadataScanResult
    type: 'ready'
};

type DecodeWorkerFrameResponseBase = {
    durationMicroseconds: Microseconds
    encodedDolbyVisionMetadata?: TransferableDolbyVisionEncodedFrameMetadata
    HDR10PlusMetadata?: HDR10PlusFrameMetadata
    generation: number
    mediaTimeMicroseconds: Microseconds
    type: 'frame'
    /** Omitted epochs mean the initial video attempt, epoch zero. */
    videoEpoch?: number
};

export type DecodeWorkerVideoFrameResponse = DecodeWorkerFrameResponseBase & {
    frame: VideoFrame
    outputMode: 'video-frame'
};

export type DecodeWorkerRawFrameResponse = DecodeWorkerFrameResponseBase & {
    enhancementFrame?: TransferableRawVideoFrame | null
    frame: TransferableRawVideoFrame
    outputMode: 'raw-planes'
};

/** A frame whose payload crosses to the page: a VideoFrame or raw planes, with its metadata. */
export type DecodeWorkerFrameResponse =
    | DecodeWorkerRawFrameResponse
    | DecodeWorkerVideoFrameResponse;

/** Counts what a worker frame's metadata holds, for the session's telemetry; the metadata itself stays in the worker. */
export type DecodeWorkerFrameMetadataSummary = {
    dolbyVision?: {
        enhancementLayerVCL: boolean
        rpuCount: number
    }
    HDR10PlusStatus?: HDR10PlusFrameMetadataStatus
};

/**
 * A frame the worker keeps for its renderer: what the page needs to select and lay it out, without its payload or metadata.
 * The page presents it by ID through the renderer's channel and releases it with `release-frames`.
 */
export type DecodeWorkerFrameDescriptorResponse = {
    displayHeight: number
    displayWidth: number
    durationMicroseconds: Microseconds
    /** Unique within the generation */
    frameId: number
    generation: number
    mediaTimeMicroseconds: Microseconds
    metadataSummary?: DecodeWorkerFrameMetadataSummary
    outputMode: 'worker-frame'
    type: 'frame'
    /** Omitted epochs mean the initial video attempt, epoch zero. */
    videoEpoch?: number
};

/** Reports one chunk the producer posted to the AudioWorklet processor, without its PCM, for readiness, telemetry, and the end-of-stream drain */
export type DecodeWorkerAudioProgressResponse = {
    audioEpoch: number
    durationMicroseconds: Microseconds
    frameCount: number
    generation: number
    mediaTimeMicroseconds: Microseconds
    sampleRate: number
    type: 'audio-progress'
};

export type DecodeWorkerNativeAudioInitializationResponse = {
    data: ArrayBuffer
    generation: number
    type: 'native-audio-init'
};

export type DecodeWorkerNativeAudioMediaResponse = {
    data: ArrayBuffer
    endTimeMicroseconds: Microseconds
    generation: number
    startTimeMicroseconds: Microseconds
    type: 'native-audio-media'
};

export type DecodeWorkerEndedResponse = {
    generation: number
    type: 'ended'
};

export type DecodeWorkerErrorResponse = {
    failureKind: CustomDecodeFailureKind
    generation: number
    message: string
    type: 'error'
};

/**
 * Ends every run, stopped or finished; the worker then takes the next generation's start.
 * A worker runs one generation at a time, so the session sends a start only after the previous run's `stopped`.
 */
export type DecodeWorkerStoppedResponse = {
    generation: number
    /** Asks the session not to reuse the worker, because a decoder whose call failed was left unclosed */
    replaceWorker?: boolean
    type: 'stopped'
};

export type DecodeWorkerProgressResponse = {
    generation: number
    mediaTimeMicroseconds: Microseconds | null
    packetCount: number
    phase: CustomDecodeWorkerProgressPhase
    type: 'progress'
};

export type DecodeWorkerVideoInterruptionReason = 'decoder-reclaimed';

/** Reports a recoverable video decoder loss; video waits for a resync request. */
export type DecodeWorkerVideoInterruptedResponse = {
    generation: number
    reason: DecodeWorkerVideoInterruptionReason
    type: 'video-interrupted'
    videoEpoch: number
};

/** Reports the video track's end while audio may still continue. */
export type DecodeWorkerVideoEndedResponse = {
    generation: number
    type: 'video-ended'
    videoEpoch: number
};

/** Reports the audio track's end while video may still continue. */
export type DecodeWorkerAudioEndedResponse = {
    audioEpoch: number
    generation: number
    type: 'audio-ended'
};

/** Reports the format the audio decoder produces, which can differ from the declared one. */
export type DecodeWorkerAudioSourceFormatResponse = {
    audioEpoch: number
    channelCount: number
    generation: number
    sampleRate: number
    type: 'audio-source-format'
};

/** Carries a batch of the worker's timing trace events. */
export type DecodeWorkerTimingTraceResponse = {
    events: readonly WorkerTimingTraceEvent[]
    generation: number
    type: 'timing-trace'
};

/** Answers `attach-renderer`: an available renderer presents the worker-frames of later worker-mode starts. */
export type DecodeWorkerRendererStatusResponse = {
    available: boolean
    generation: number
    /** Why the renderer is unavailable, for the log; null when it is available */
    reason: string | null
    type: 'renderer-status'
};

export type DecodeWorkerResponse =
    | DecodeWorkerAudioEndedResponse
    | DecodeWorkerAudioProgressResponse
    | DecodeWorkerAudioSourceFormatResponse
    | DecodeWorkerEndedResponse
    | DecodeWorkerErrorResponse
    | DecodeWorkerFrameDescriptorResponse
    | DecodeWorkerFrameResponse
    | DecodeWorkerNativeAudioInitializationResponse
    | DecodeWorkerNativeAudioMediaResponse
    | DecodeWorkerProgressResponse
    | DecodeWorkerReadyResponse
    | DecodeWorkerRendererStatusResponse
    | DecodeWorkerStoppedResponse
    | DecodeWorkerTimingTraceResponse
    | DecodeWorkerVideoEndedResponse
    | DecodeWorkerVideoInterruptedResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function isGeneration(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) > 0;
}

function isMicroseconds(value: unknown): value is Microseconds {
    return Number.isSafeInteger(value);
}

function isFrameCredit(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= MAX_DECODED_FRAME_CREDITS;
}

function isAudioSampleCredit(value: unknown, allowZero: boolean): value is number {
    return Number.isSafeInteger(value) && Number(value) >= (allowZero ? 0 : 1) && Number(value) <= MAX_DECODED_AUDIO_SAMPLE_CREDITS;
}

function isPositiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) > 0;
}

function isVideoEpoch(value: unknown, allowInitialEpoch: boolean): value is number {
    return Number.isSafeInteger(value) && Number(value) >= (allowInitialEpoch ? 0 : 1);
}

function isAudioEpoch(value: unknown, allowInitialEpoch: boolean): value is number {
    return Number.isSafeInteger(value) && Number(value) >= (allowInitialEpoch ? 0 : 1);
}

function hasValidOptionalAudioEpoch(value: Record<string, unknown>): boolean {
    return value.audioEpoch === undefined || isAudioEpoch(value.audioEpoch, true);
}

function isVideoStartupProgressPacketCount(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAXIMUM_VIDEO_STARTUP_PROGRESS_PACKET_COUNT;
}

function isCustomDecodeWorkerProgressPhase(value: unknown): value is CustomDecodeWorkerProgressPhase {
    switch (value) {
        case 'video-decoder-ready':
        case 'video-key-packet-ready':
        case 'video-packet-decoded':
        case 'video-packet-started':
            return true;
        default:
            return false;
    }
}

function isTrackIndex(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isCodedDimension(value: unknown): value is number {
    return isPositiveInteger(value);
}

function isVideoOutputMode(value: unknown): value is CustomDecodeVideoOutputMode {
    return value === 'raw-planes' || value === 'video-frame';
}

function isVideoDecoderBackend(value: unknown): value is CustomDecodeVideoDecoderBackend {
    return value === 'bundled-hevc' || value === 'ffmpeg-mpeg2-vc1' || value === 'native' || value === 'openjpeg';
}

function isNativeHDRTransfer(value: unknown): value is CustomDecodeNativeHDRTransfer {
    return value === null || value === 'hlg' || value === 'pq';
}

function isAudioOutputMode(value: unknown): value is CustomDecodeAudioOutputMode {
    return value === 'decoded-pcm' || value === 'native-media';
}

/** Validates a decoded PCM output layout: stereo, 5.1, or 7.1. */
export function isDecodedAudioOutputChannelCount(value: unknown): value is CustomAudioOutputChannelCount {
    return value === 2 || value === 6 || value === 8;
}

/** Validates downmix gains received across a worker boundary. */
export function isAudioDownmixSettings(value: unknown): value is AudioDownmixSettings {
    if (!isRecord(value)) {
        return false;
    }
    try {
        assertValidAudioDownmixSettings(value as AudioDownmixSettings);
        return true;
    } catch {
        return false;
    }
}

function isValidDecodedAudioOutputSelection(
    value: Record<string, unknown>,
    audioOutputMode: unknown,
    hasAudioTrack: boolean
): boolean {
    if (audioOutputMode !== 'decoded-pcm' || !hasAudioTrack) {
        return value.audioDownmixSettings === undefined && value.decodedAudioOutputChannelCount === undefined;
    }
    const hasValidOutputChannelCount = value.decodedAudioOutputChannelCount === undefined
        || isDecodedAudioOutputChannelCount(value.decodedAudioOutputChannelCount);
    return hasValidOutputChannelCount
        && (value.audioDownmixSettings === undefined
            || isAudioDownmixSettings(value.audioDownmixSettings));
}

function isValidAudioDownmixAlgorithmSelection(
    value: Record<string, unknown>,
    audioOutputMode: unknown,
    hasAudioTrack: boolean
): boolean {
    if (audioOutputMode !== 'decoded-pcm' || !hasAudioTrack) {
        return value.audioDownmixAlgorithm === undefined;
    }
    return value.audioDownmixAlgorithm === undefined || isCustomAudioDownmixAlgorithm(value.audioDownmixAlgorithm);
}

/** Accepts only raw plane formats the worker can copy and the presenter can upload. */
export function isRawVideoFrameFormat(value: unknown): value is CustomDecodeRawVideoFrameFormat {
    switch (value) {
        case 'I420P10':
        case 'I420':
        case 'I420P12':
        case 'I422':
        case 'I422P10':
        case 'I422P12':
        case 'I444':
        case 'I444P10':
        case 'I444P12':
            return true;
        default:
            return false;
    }
}

function isCodecAssetURL(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAXIMUM_CODEC_ASSET_URL_LENGTH) {
        return false;
    }
    try {
        const parsedURL = new URL(value);
        return (parsedURL.protocol === 'http:' || parsedURL.protocol === 'https:')
            && parsedURL.username.length === 0
            && parsedURL.password.length === 0;
    } catch {
        return false;
    }
}

type RawVideoFormatValidation = {
    bitDepth: 8 | 10 | 12
    bytesPerComponent: 1 | 2
    chromaHeightDivisor: 1 | 2
    chromaWidthDivisor: 1 | 2
    planeKinds: readonly RawVideoPlaneDescriptor['kind'][]
};

function getRawVideoFormatValidation(format: unknown): RawVideoFormatValidation | null {
    switch (format) {
        case 'I420':
            return {
                bitDepth: 8,
                bytesPerComponent: 1,
                chromaHeightDivisor: 2,
                chromaWidthDivisor: 2,
                planeKinds: [ 'y', 'u', 'v' ]
            };
        case 'I420P10':
            return {
                bitDepth: 10,
                bytesPerComponent: 2,
                chromaHeightDivisor: 2,
                chromaWidthDivisor: 2,
                planeKinds: [ 'y', 'u', 'v' ]
            };
        case 'I420P12':
            return {
                bitDepth: 12,
                bytesPerComponent: 2,
                chromaHeightDivisor: 2,
                chromaWidthDivisor: 2,
                planeKinds: [ 'y', 'u', 'v' ]
            };
        case 'I422':
            return {
                bitDepth: 8,
                bytesPerComponent: 1,
                chromaHeightDivisor: 1,
                chromaWidthDivisor: 2,
                planeKinds: [ 'y', 'u', 'v' ]
            };
        case 'I422P10':
            return {
                bitDepth: 10,
                bytesPerComponent: 2,
                chromaHeightDivisor: 1,
                chromaWidthDivisor: 2,
                planeKinds: [ 'y', 'u', 'v' ]
            };
        case 'I422P12':
            return {
                bitDepth: 12,
                bytesPerComponent: 2,
                chromaHeightDivisor: 1,
                chromaWidthDivisor: 2,
                planeKinds: [ 'y', 'u', 'v' ]
            };
        case 'I444':
            return {
                bitDepth: 8,
                bytesPerComponent: 1,
                chromaHeightDivisor: 1,
                chromaWidthDivisor: 1,
                planeKinds: [ 'y', 'u', 'v' ]
            };
        case 'I444P10':
            return {
                bitDepth: 10,
                bytesPerComponent: 2,
                chromaHeightDivisor: 1,
                chromaWidthDivisor: 1,
                planeKinds: [ 'y', 'u', 'v' ]
            };
        case 'I444P12':
            return {
                bitDepth: 12,
                bytesPerComponent: 2,
                chromaHeightDivisor: 1,
                chromaWidthDivisor: 1,
                planeKinds: [ 'y', 'u', 'v' ]
            };
        case 'NV12':
            return {
                bitDepth: 8,
                bytesPerComponent: 1,
                chromaHeightDivisor: 2,
                chromaWidthDivisor: 2,
                planeKinds: [ 'y', 'uv' ]
            };
        default:
            return null;
    }
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
    return value === undefined || typeof value === 'boolean';
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
}

function isRawVideoColorSpace(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }

    return (value.fullRange === null || typeof value.fullRange === 'boolean')
        && isNullableString(value.matrix)
        && isNullableString(value.primaries)
        && isNullableString(value.transfer);
}

function isRawVideoRectangle(
    value: unknown,
    codedWidth: number,
    codedHeight: number
): boolean {
    if (!isRecord(value)) {
        return false;
    }

    const x = Number(value.x);
    const y = Number(value.y);
    const width = Number(value.width);
    const height = Number(value.height);
    return Number.isSafeInteger(x)
        && Number.isSafeInteger(y)
        && Number.isSafeInteger(width)
        && Number.isSafeInteger(height)
        && x >= 0
        && y >= 0
        && width > 0
        && height > 0
        && x + width <= codedWidth
        && y + height <= codedHeight;
}

function isRawVideoPlane(
    value: unknown,
    expectedKind: RawVideoPlaneDescriptor['kind'],
    format: SupportedRawVideoFrameFormat,
    codedWidth: number,
    codedHeight: number,
    expectedByteOffset: number
): value is RawVideoPlaneDescriptor {
    if (!isRecord(value) || value.kind !== expectedKind) {
        return false;
    }

    const validation = getRawVideoFormatValidation(format);
    if (!validation) {
        return false;
    }
    const isChromaPlane = expectedKind !== 'y';
    const expectedWidth = isChromaPlane ? Math.ceil(codedWidth / validation.chromaWidthDivisor) : codedWidth;
    const expectedHeight = isChromaPlane ? Math.ceil(codedHeight / validation.chromaHeightDivisor) : codedHeight;
    const expectedBytesPerComponent = validation.bytesPerComponent;
    const expectedComponentsPerTexel = expectedKind === 'uv' ? 2 : 1;
    const rowByteLength = expectedWidth * expectedBytesPerComponent * expectedComponentsPerTexel;
    const bytesPerRow = Number(value.bytesPerRow);
    const byteLength = Number(value.byteLength);
    return value.byteOffset === expectedByteOffset
        && value.bytesPerComponent === expectedBytesPerComponent
        && value.componentsPerTexel === expectedComponentsPerTexel
        && value.width === expectedWidth
        && value.height === expectedHeight
        && value.rowByteLength === rowByteLength
        && Number.isSafeInteger(bytesPerRow)
        && bytesPerRow >= rowByteLength
        && bytesPerRow % RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT === 0
        && Number.isSafeInteger(byteLength)
        && byteLength === bytesPerRow * expectedHeight;
}

function isTransferableRawVideoFrame(value: unknown): value is TransferableRawVideoFrame {
    const frameEndOffset = getTransferableRawVideoFrameEndOffset(value, 0);
    return frameEndOffset !== null && (value as TransferableRawVideoFrame).data.byteLength === frameEndOffset;
}

function getTransferableRawVideoFrameEndOffset(value: unknown, expectedStartOffset: number): number | null {
    if (!isRecord(value)) {
        return null;
    }

    const formatValidation = getRawVideoFormatValidation(value.format);
    const codedWidth = Number(value.codedWidth);
    const codedHeight = Number(value.codedHeight);
    if (
        !formatValidation
        || !(value.data instanceof ArrayBuffer)
        || !isPositiveInteger(value.codedWidth)
        || !isPositiveInteger(value.codedHeight)
        || !isPositiveInteger(value.displayWidth)
        || !isPositiveInteger(value.displayHeight)
        || value.bitDepth !== formatValidation.bitDepth
        || !isRawVideoColorSpace(value.colorSpace)
        || !isMicroseconds(value.timestampMicroseconds)
        || !(value.durationMicroseconds === null
            || (isMicroseconds(value.durationMicroseconds)
                && Number(value.durationMicroseconds) >= 0))
        || !isRawVideoRectangle(value.visibleRectangle, codedWidth, codedHeight)
        || !Array.isArray(value.planes)
        || value.planes.length !== formatValidation.planeKinds.length
    ) {
        return null;
    }

    let expectedByteOffset = expectedStartOffset;
    for (let planeIndex = 0; planeIndex < value.planes.length; planeIndex += 1) {
        const plane = value.planes[planeIndex];
        if (!isRawVideoPlane(
            plane,
            formatValidation.planeKinds[planeIndex],
            value.format as SupportedRawVideoFrameFormat,
            codedWidth,
            codedHeight,
            expectedByteOffset
        )) {
            return null;
        }
        expectedByteOffset += Number((plane as RawVideoPlaneDescriptor).byteLength);
    }
    const frameByteLength = expectedByteOffset - expectedStartOffset;
    return frameByteLength > 0 && expectedByteOffset <= value.data.byteLength ? expectedByteOffset : null;
}

function hasValidRawVideoCopyLayout(value: Record<string, unknown>): boolean {
    if (value.videoOutputMode !== 'raw-planes') {
        return true;
    }
    if (
        !isRawVideoFrameFormat(value.rawVideoFrameFormat)
        || !isCodedDimension(value.maximumCodedWidth)
        || !isCodedDimension(value.maximumCodedHeight)
    ) {
        return false;
    }
    return hasRawVideoFrameCopyLayout({
        codedHeight: Number(value.maximumCodedHeight),
        codedWidth: Number(value.maximumCodedWidth),
        displayHeight: Number(value.maximumCodedHeight),
        displayWidth: Number(value.maximumCodedWidth)
    }, value.rawVideoFrameFormat, getDolbyVisionRawFrameLayerCount(
        isDolbyVisionProfile(value.dolbyVisionProfile) ? value.dolbyVisionProfile : null
    ));
}

/** Returns the raw frame layers one presented frame transfers; dual-layer profiles pair an EL frame. */
export function getDolbyVisionRawFrameLayerCount(profile: CustomDecodeDolbyVisionProfile): number {
    return isDolbyVisionDualLayerProfile(profile) ?
        RAW_VIDEO_DOLBY_VISION_FRAME_LAYER_COUNT :
        RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT;
}

/**
 * Validates an atomic Dolby Vision BL and EL pair in one buffer.
 * The BL takes the route's raw format, and the EL is always 10-bit 4:2:0 whatever the format of its BL.
 */
function isTransferableRawVideoFramePair(baseFrameValue: unknown, enhancementFrameValue: unknown): boolean {
    const baseFrameEndOffset = getTransferableRawVideoFrameEndOffset(baseFrameValue, 0);
    if (baseFrameEndOffset === null) {
        return false;
    }
    const baseFrame = baseFrameValue as TransferableRawVideoFrame;
    if (baseFrame.data.byteLength <= baseFrameEndOffset) {
        return false;
    }
    if (enhancementFrameValue === null) {
        return true;
    }

    const enhancementFrameOffset = Math.ceil(
        baseFrameEndOffset / RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT
    ) * RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT;
    const enhancementFrameEndOffset = getTransferableRawVideoFrameEndOffset(enhancementFrameValue, enhancementFrameOffset);
    if (enhancementFrameEndOffset === null) {
        return false;
    }
    const enhancementFrame = enhancementFrameValue as TransferableRawVideoFrame;
    return enhancementFrame.data === baseFrame.data
        && enhancementFrameEndOffset === baseFrame.data.byteLength
        && enhancementFrame.format === RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT
        && Math.abs(enhancementFrame.timestampMicroseconds - baseFrame.timestampMicroseconds) <= 1;
}

/** Validates a failure kind received across a worker boundary. */
export function isCustomDecodeFailureKind(value: unknown): value is CustomDecodeFailureKind {
    switch (value) {
        case 'audio-output-failed':
        case 'decode-failed':
        case 'network-failed':
        case 'range-unsupported':
        case 'source-unsupported':
            return true;
        default:
            return false;
    }
}

function isAudioConfiguration(value: unknown): value is DecodeWorkerReadyAudioConfiguration {
    if (!isRecord(value)) {
        return false;
    }

    const commonFieldsValid = typeof value.codec === 'string'
        && value.codec.length > 0
        && isPositiveInteger(value.channelCount)
        && Number(value.channelCount) <= MAX_DECODED_AUDIO_CHANNELS
        && isSupportedCustomAudioSampleRate(value.sampleRate);
    if (!commonFieldsValid) {
        return false;
    }
    if ((value.sourceChannelCount !== undefined
            && (!isPositiveInteger(value.sourceChannelCount)
                || Number(value.sourceChannelCount) > MAX_DECODED_AUDIO_CHANNELS))
        || (value.sourceSampleRate !== undefined
            && !isSupportedCustomAudioSampleRate(value.sourceSampleRate))) {
        return false;
    }
    if (value.outputMode === undefined) {
        return true;
    }
    return value.outputMode === 'native-media'
        && (value.codec === 'ac-3' || value.codec === 'ec-3')
        && (value.channelCount === 2 || value.channelCount === 6)
        && value.sampleRate === 48_000
        && typeof value.mimeType === 'string'
        && value.mimeType.length > 0;
}

function isAudioProgressResponse(value: Record<string, unknown>): boolean {
    return isAudioEpoch(value.audioEpoch, true)
        && isMicroseconds(value.mediaTimeMicroseconds)
        && isMicroseconds(value.durationMicroseconds)
        && Number(value.durationMicroseconds) >= 0
        && isPositiveInteger(value.frameCount)
        && Number(value.frameCount) <= MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE
        && isSupportedCustomAudioSampleRate(value.sampleRate);
}

function hasValidOptionalDolbyVisionMetadata(value: Record<string, unknown>): boolean {
    return value.encodedDolbyVisionMetadata === undefined
        || isTransferableDolbyVisionEncodedFrameMetadata(value.encodedDolbyVisionMetadata);
}

function hasValidOptionalHDR10PlusMetadata(value: Record<string, unknown>): boolean {
    return value.HDR10PlusMetadata === undefined || isHDR10PlusFrameMetadata(value.HDR10PlusMetadata);
}

/** Validates a Dolby Vision route profile received across a module or worker boundary. */
export function isDolbyVisionProfile(value: unknown): value is CustomDecodeDolbyVisionProfile {
    return value === null || value === 4 || value === 5 || value === 7 || value === 8;
}

function isVideoResyncRequest(value: Record<string, unknown>): boolean {
    return isVideoEpoch(value.videoEpoch, false) && isMicroseconds(value.targetTimeMicroseconds);
}

function hasValidOptionalAudioDownmix(value: Record<string, unknown>): boolean {
    return (value.audioDownmixAlgorithm === undefined || isCustomAudioDownmixAlgorithm(value.audioDownmixAlgorithm))
        && (value.audioDownmixSettings === undefined || isAudioDownmixSettings(value.audioDownmixSettings));
}

/** Only a dual-layer route has an EL to discard. */
function hasValidDiscardedEnhancementLayer(value: Record<string, unknown>): boolean {
    return isOptionalBoolean(value.discardDolbyVisionEnhancementLayer)
        && (value.discardDolbyVisionEnhancementLayer !== true
            || (isDolbyVisionProfile(value.dolbyVisionProfile)
                && isDolbyVisionDualLayerProfile(value.dolbyVisionProfile)));
}

function isAudioPullRequest(value: Record<string, unknown>): boolean {
    return isAudioSampleCredit(value.audioSampleCredits, false) && hasValidOptionalAudioEpoch(value);
}

/** Validates the producer's end of a worklet channel, with the bounds of the worklet it feeds. */
export function isAudioOutputAttachment(value: unknown): value is DecodeWorkerAudioOutputAttachment {
    return isRecord(value)
        && isAudioSampleCredit(value.audioSampleCredits, false)
        && isDecodedAudioOutputChannelCount(value.channelCount)
        && isPositiveInteger(value.maximumBufferedFrameCount)
        && isSupportedCustomAudioSampleRate(value.sampleRate)
        && isGeneration(value.workletGeneration)
        && isMessagePort(value.port);
}

function isAudioOutputAttachRequest(value: Record<string, unknown>): boolean {
    return isAudioEpoch(value.audioEpoch, true) && isAudioOutputAttachment(value.audioOutput);
}

/** The new worklet's channel carries the layout the resync asks for. */
function isAudioResyncRequest(value: Record<string, unknown>): boolean {
    return isAudioEpoch(value.audioEpoch, false)
        && isDecodedAudioOutputChannelCount(value.decodedAudioOutputChannelCount)
        && isAudioOutputAttachment(value.audioOutput)
        && value.audioOutput.channelCount === value.decodedAudioOutputChannelCount
        && isMicroseconds(value.targetTimeMicroseconds)
        && hasValidOptionalAudioDownmix(value);
}

/** An omitted presentation mode means main. */
function isOptionalPresentationMode(value: unknown): value is CustomDecodePresentationMode | undefined {
    return value === undefined || value === 'main' || value === 'worker';
}

// A page without these constructors cannot present in a worker, and a Node test stubs them
function isOffscreenCanvas(value: unknown): value is OffscreenCanvas {
    return typeof OffscreenCanvas === 'function' && value instanceof OffscreenCanvas;
}

function isMessagePort(value: unknown): value is MessagePort {
    return typeof MessagePort === 'function' && value instanceof MessagePort;
}

/** A renderer attachment carries the transferred canvas and the renderer's end of the presenter's channel. */
function isRendererAttachmentRequest(value: Record<string, unknown>): boolean {
    return isOffscreenCanvas(value.canvas) && isMessagePort(value.port);
}

/** An available renderer gives no reason; an unavailable one gives a bounded one for the log. */
function isRendererStatusResponse(value: Record<string, unknown>): boolean {
    if (typeof value.available !== 'boolean') {
        return false;
    }
    if (value.available) {
        return value.reason === null;
    }
    return typeof value.reason === 'string'
        && value.reason.length > 0
        && value.reason.length <= MAXIMUM_RENDERER_STATUS_REASON_LENGTH;
}

function isFrameId(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** Names each frame once, and never more frames than a run's credits keep outstanding. */
function isReleasedFrameIdList(value: unknown): value is readonly number[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DECODED_FRAME_CREDITS) {
        return false;
    }
    const frameIds = new Set<number>();
    for (const frameId of value) {
        if (!isFrameId(frameId) || frameIds.has(frameId)) {
            return false;
        }
        frameIds.add(frameId);
    }
    return true;
}

/** Validates a message before the decode worker acts on it. */
export function isDecodeWorkerRequest(value: unknown): value is DecodeWorkerRequest {
    if (!isRecord(value) || !isGeneration(value.generation)) {
        return false;
    }

    switch (value.type) {
        case 'start': {
            const hasAudioTrack = isTrackIndex(value.audioTrackIndex);
            const hasNoAudioTrack = value.audioTrackIndex === null;
            const hasValidAudioCredits = isAudioSampleCredit(value.audioSampleCredits, true);
            const audioOutputMode = value.audioOutputMode ?? 'decoded-pcm';
            const hasValidDecodedAudioOutput = isValidDecodedAudioOutputSelection(value, audioOutputMode, hasAudioTrack);
            const hasValidAudioDownmixAlgorithm = isValidAudioDownmixAlgorithmSelection(value, audioOutputMode, hasAudioTrack);
            const hasValidVideoOutput = value.videoOutputMode === 'raw-planes' ?
                isRawVideoFrameFormat(value.rawVideoFrameFormat) :
                value.videoOutputMode === 'video-frame'
                    && value.rawVideoFrameFormat === null;
            const hasValidOpenJPEGRoute = value.videoDecoderBackend !== 'openjpeg'
                || (value.videoOutputMode === 'video-frame'
                    && value.rawVideoFrameFormat === null
                    && value.dolbyVisionProfile === null
                    && value.neutralizeHDRColorMetadata === false
                    && value.nativeHDRTransfer === null);
            const hasValidMPEG2VC1Route = value.videoDecoderBackend !== 'ffmpeg-mpeg2-vc1'
                || (value.videoOutputMode === 'video-frame'
                    && value.rawVideoFrameFormat === null
                    && value.dolbyVisionProfile === null
                    && value.neutralizeHDRColorMetadata === false
                    && value.nativeHDRTransfer === null);
            return typeof value.url === 'string'
                && value.url.length > 0
                && isOptionalBoolean(value.reportContainerDuration)
                && isOptionalBoolean(value.timingTrace)
                && isOptionalPresentationMode(value.presentationMode)
                && isDolbyVisionProfile(value.dolbyVisionProfile)
                && hasValidDiscardedEnhancementLayer(value)
                && isCodecAssetURL(value.dolbyVisionRPUParserWASMURL)
                && isMicroseconds(value.startTimeMicroseconds)
                && isTrackIndex(value.videoTrackIndex)
                && isCodedDimension(value.maximumCodedWidth)
                && isCodedDimension(value.maximumCodedHeight)
                && isVideoOutputMode(value.videoOutputMode)
                && isVideoDecoderBackend(value.videoDecoderBackend)
                && isNativeHDRTransfer(value.nativeHDRTransfer)
                && typeof value.neutralizeHDRColorMetadata === 'boolean'
                && (value.neutralizeHDRColorMetadata ?
                    (value.nativeHDRTransfer !== null
                        && value.videoOutputMode === 'video-frame'
                        && value.videoDecoderBackend === 'native'
                        && value.dolbyVisionProfile === null) :
                    value.nativeHDRTransfer === null)
                && hasValidVideoOutput
                && hasValidRawVideoCopyLayout(value)
                && hasValidOpenJPEGRoute
                && hasValidMPEG2VC1Route
                && isFrameCredit(value.frameCredits)
                && (value.videoOutputMode !== 'raw-planes' || value.frameCredits === MAX_DECODED_RAW_FRAME_CREDITS)
                && (hasAudioTrack || hasNoAudioTrack)
                && isAudioOutputMode(audioOutputMode)
                && hasValidDecodedAudioOutput
                && hasValidAudioDownmixAlgorithm
                && (hasAudioTrack || value.audioOutputMode === undefined)
                && hasValidAudioCredits
                && (hasAudioTrack || Number(value.audioSampleCredits) === 0);
        }
        case 'attach-audio-output':
            return isAudioOutputAttachRequest(value);
        case 'attach-renderer':
            return isRendererAttachmentRequest(value);
        case 'pull':
            return isFrameCredit(value.frameCredits);
        case 'pull-audio':
            return isAudioPullRequest(value);
        case 'recycle-frame':
            return value.buffer instanceof ArrayBuffer && value.buffer.byteLength > 0;
        case 'release-frames':
            return isReleasedFrameIdList(value.frameIds);
        case 'resync-audio':
            return isAudioResyncRequest(value);
        case 'resync-video':
            return isVideoResyncRequest(value);
        case 'stop':
            return true;
        case 'suspend-video':
            return isVideoEpoch(value.videoEpoch, false);
        case 'update-audio-downmix-settings':
            return isAudioDownmixSettings(value.audioDownmixSettings);
        default:
            return false;
    }
}

function isFrameMetadataSummary(value: unknown): value is DecodeWorkerFrameMetadataSummary {
    if (!isRecord(value)) {
        return false;
    }
    const dolbyVision = value.dolbyVision;
    if (dolbyVision !== undefined && !(
        isRecord(dolbyVision)
        && typeof dolbyVision.enhancementLayerVCL === 'boolean'
        && Number.isSafeInteger(dolbyVision.rpuCount)
        && Number(dolbyVision.rpuCount) >= 0
        && Number(dolbyVision.rpuCount) <= MAXIMUM_DOLBY_VISION_FRAME_RPU_COUNT
    )) {
        return false;
    }
    return value.HDR10PlusStatus === undefined || isHDR10PlusFrameMetadataStatus(value.HDR10PlusStatus);
}

/** A descriptor carries no payload and no metadata, which stay with the frame in the worker. */
function isFrameDescriptor(value: Record<string, unknown>): boolean {
    for (const payloadField of WORKER_FRAME_PAYLOAD_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(value, payloadField)) {
            return false;
        }
    }
    return isFrameId(value.frameId)
        && isPositiveInteger(value.displayWidth)
        && isPositiveInteger(value.displayHeight)
        && (value.metadataSummary === undefined || isFrameMetadataSummary(value.metadataSummary));
}

function isDecodeWorkerFrameResponse(value: Record<string, unknown>): boolean {
    if (!isMicroseconds(value.mediaTimeMicroseconds)
        || !isMicroseconds(value.durationMicroseconds)
        || Number(value.durationMicroseconds) < 0
        || !hasValidOptionalDolbyVisionMetadata(value)
        || !hasValidOptionalHDR10PlusMetadata(value)
        || (value.videoEpoch !== undefined && !isVideoEpoch(value.videoEpoch, true))
    ) {
        return false;
    }
    switch (value.outputMode) {
        case 'video-frame':
            return isRecord(value.frame) && typeof value.frame.close === 'function';
        case 'raw-planes': {
            const hasValidFrame = (
                Object.prototype.hasOwnProperty.call(value, 'enhancementFrame') ?
                    isTransferableRawVideoFramePair(value.frame, value.enhancementFrame) :
                    isTransferableRawVideoFrame(value.frame)
            );
            if (!hasValidFrame) {
                return false;
            }
            const frame = value.frame as TransferableRawVideoFrame;
            return frame.timestampMicroseconds === value.mediaTimeMicroseconds
                && (frame.durationMicroseconds === null || frame.durationMicroseconds === value.durationMicroseconds);
        }
        case 'worker-frame':
            return isFrameDescriptor(value);
        default:
            return false;
    }
}

/** Validates a worker response before it mutates the active session. */
export function isDecodeWorkerResponse(value: unknown): value is DecodeWorkerResponse {
    if (!isRecord(value) || !isGeneration(value.generation)) {
        return false;
    }

    switch (value.type) {
        case 'ready':
            return typeof value.codec === 'string'
                && value.codec.length > 0
                && isPositiveInteger(value.codedHeight)
                && isPositiveInteger(value.codedWidth)
                && isPositiveInteger(value.displayHeight)
                && isPositiveInteger(value.displayWidth)
                && (value.audio === null || isAudioConfiguration(value.audio))
                && (!Object.prototype.hasOwnProperty.call(value, 'containerDurationMicroseconds')
                    || (isMicroseconds(value.containerDurationMicroseconds)
                        && Number(value.containerDurationMicroseconds) > 0))
                && (!Object.prototype.hasOwnProperty.call(value, 'staticHDRMetadataScan')
                    || isStaticHDRMetadataScanResult(value.staticHDRMetadataScan));
        case 'frame':
            return isDecodeWorkerFrameResponse(value);
        case 'audio-progress':
            return isAudioProgressResponse(value);
        case 'native-audio-init':
            return value.data instanceof ArrayBuffer
                && value.data.byteLength > 0
                && value.data.byteLength <= MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH;
        case 'native-audio-media': {
            if (!(value.data instanceof ArrayBuffer)
                || value.data.byteLength <= 0
                || value.data.byteLength > MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH
                || !isMicroseconds(value.startTimeMicroseconds)
                || !isMicroseconds(value.endTimeMicroseconds)) {
                return false;
            }
            const durationMicroseconds = Number(value.endTimeMicroseconds) - Number(value.startTimeMicroseconds);
            return durationMicroseconds > 0
                && durationMicroseconds <= MAXIMUM_NATIVE_AUDIO_SEGMENT_DURATION_MICROSECONDS;
        }
        case 'progress':
            return isCustomDecodeWorkerProgressPhase(value.phase)
                && isVideoStartupProgressPacketCount(value.packetCount)
                && (value.mediaTimeMicroseconds === null || isMicroseconds(value.mediaTimeMicroseconds));
        case 'renderer-status':
            return isRendererStatusResponse(value);
        case 'ended':
            return true;
        case 'stopped':
            return isOptionalBoolean(value.replaceWorker);
        case 'error':
            return isCustomDecodeFailureKind(value.failureKind) && typeof value.message === 'string';
        case 'audio-ended':
            return isAudioEpoch(value.audioEpoch, true);
        case 'audio-source-format':
            return isAudioEpoch(value.audioEpoch, true)
                && isPositiveInteger(value.channelCount)
                && Number(value.channelCount) <= MAX_DECODED_AUDIO_CHANNELS
                && isSupportedCustomAudioSampleRate(value.sampleRate);
        case 'video-ended':
            return isVideoEpoch(value.videoEpoch, true);
        case 'video-interrupted':
            return value.reason === 'decoder-reclaimed' && isVideoEpoch(value.videoEpoch, true);
        case 'timing-trace':
            return Array.isArray(value.events)
                && value.events.length > 0
                && value.events.length <= MAXIMUM_TIMING_TRACE_EVENTS_PER_MESSAGE
                && value.events.every(isWorkerTimingTraceEvent);
        default:
            return false;
    }
}
