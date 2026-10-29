import type { Microseconds } from '../MediaTime';
import type { DecodedPresentationFrame, DecodedVideoStreamFacts } from '../presentation/WebGPUPresenter';
import type { AudioDecoderPackageSelection } from '../decode/audio/AudioDecoderPackageInstance';
import type {
    AudioTelemetryListener,
    AudioWorkletControllerOptions
} from '../audio/output/AudioWorkletController';
import type { AudioWorkletTelemetry } from '../audio/output/AudioWorkletProtocol';
import type { CustomAudioOutputLayout } from '../audio/processing/CustomAudioChannelLayout';
import type { AudioDownmixSettings } from '../audio/processing/CustomAudioDownmix';
import type { CustomAudioDownmixAlgorithm } from '../audio/processing/CustomAudioDownmixAlgorithm';
import type CustomDecodeAudioBridge from '../audio/output/CustomDecodeAudioBridge';
import type { CustomDecodeAudioBridgeTelemetry } from '../audio/output/CustomDecodeAudioBridge';
import type {
    CustomDecodeAudioBridgeFactory,
    CustomDecodeAudioResyncOptions,
    CustomDecodeNativeAudioBridgeFactory,
    CustomDecodeSessionEvent,
    CustomDecodeSessionEventHandler,
    CustomDecodeSessionStartOptions,
    CustomDecodeSessionTelemetry
} from './CustomDecodeSession';
import type {
    CustomDecodeFailureKind,
    CustomDecodeAudioMetadataLayout,
    CustomDecodeAudioOutputMode,
    CustomDecodeDolbyVisionProfile,
    CustomDecodeNativeHDRTransfer,
    CustomDecodeRawVideoFrameFormat,
    CustomDecodeVideoDecoderBackend,
    CustomDecodeVideoOutputMode,
    DecodeWorkerAudioConfiguration
} from './DecodeWorkerProtocol';
import type { MediaClockSnapshot, MonotonicTimeSource } from './MediaClock';
import type { CustomDecodeMediaSource } from '../demux/CustomDecodeMediaSource';
import type { GPUVideoDecodeSessionFactory } from '../decode/video/gpu/GPUVideoDecodeFeed';
import type { GPUVideoDecoderSelection } from '../decode/video/gpu/GPUVideoDecoderCatalog';
import type { StaticHDRMetadata } from '../demux/hdr/StaticHDRMetadata';

export type CustomPlaybackState =
    | 'ended'
    | 'error'
    | 'fallback'
    | 'idle'
    | 'paused'
    | 'playing'
    | 'seeking'
    | 'starting'
    | 'stopping';

export type CustomPlaybackFallbackReason =
    | CustomDecodeFailureKind
    | 'audio-output-unavailable'
    | 'ended-before-ready'
    | 'lifecycle-failed'
    | 'playback-stalled'
    | 'playback-rate-unsupported'
    | 'startup-timeout';

export type CustomPlaybackFallbackDisposition =
    | 'renegotiate-source'
    | 'same-session-native';

export type CustomPlaybackPlayOptions = {
    /** The host's audio decoder package that decodes the decoded PCM route's track, in place of the engine's decoders */
    audioDecoder?: AudioDecoderPackageSelection
    audioDownmixAlgorithm?: CustomAudioDownmixAlgorithm
    audioDownmixSettings?: AudioDownmixSettings
    /**
     * The selected audio track's layout as the host's media metadata declares it, which screens a track whose container declares a count no layout has,
     * or lays out the channels of a decoder without a speaker mask; decoded or native audio only
     */
    audioMetadataLayout?: CustomDecodeAudioMetadataLayout
    audioOutputMode?: CustomDecodeAudioOutputMode
    /**
     * The audio decoder package renders the track's object audio, Dolby Atmos in E-AC-3 or TrueHD, so a live layout switch keeps the whole layout
     * instead of the source's floor
     */
    audioRendersObjects?: boolean
    audioTrackIndex: number | null
    /** Asks a package that declares `renderBinaural` for binaural headphone rendering whenever the output is stereo; decoded PCM only */
    binauralHeadphones?: boolean
    /** The layout decoded PCM plays to; defaults to stereo */
    decodedAudioOutputLayout?: CustomAudioOutputLayout
    durationMicroseconds: Microseconds | null
    dolbyVisionProfile: CustomDecodeDolbyVisionProfile
    /** The frame-pool route's GPU decoder; set exactly on that route */
    gpuVideoDecoder?: GPUVideoDecoderSelection
    maximumCodedHeight: number
    maximumCodedWidth: number
    nativeHDRTransfer: CustomDecodeNativeHDRTransfer
    neutralizeHDRColorMetadata: boolean
    /** The decoded planar format of the raw-plane and frame-pool routes */
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    source: CustomDecodeMediaSource
    startTimeMicroseconds: Microseconds
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
    videoOutputMode: CustomDecodeVideoOutputMode
    videoTrackIndex: number
};

/**
 * The route a client-side audio switch plays its new track on.
 * An omitted output mode, output layout, downmix, or binaural setting keeps the current source's; an omitted decoder package, object rendering,
 * or metadata layout is none.
 */
export type CustomPlaybackAudioSwitch = Pick<
    CustomPlaybackPlayOptions,
    | 'audioDecoder'
    | 'audioDownmixSettings'
    | 'audioMetadataLayout'
    | 'audioOutputMode'
    | 'audioRendersObjects'
    | 'binauralHeadphones'
    | 'decodedAudioOutputLayout'
>;

export type CustomPlaybackStartResult = {
    fallbackReason: CustomPlaybackFallbackReason | null
    generation: number
    status: 'fallback' | 'started' | 'stopped' | 'superseded'
};

export type CustomPlaybackFallbackRequest = {
    disposition: CustomPlaybackFallbackDisposition
    generation: number
    mediaTimeMicroseconds: Microseconds
    preserveHTMLSession: true
    reason: CustomPlaybackFallbackReason
};

export type CustomPlaybackHTMLFallbackHook = (request: CustomPlaybackFallbackRequest) => Promise<void> | void;

export type CustomAudioOutput = {
    readonly generation: number
    destroy: () => Promise<void> | void
    getEstimatedOutputLatencyMicroseconds?: () => Microseconds | null
    /** Returns how many channels the current sink accepts, or null when unknown */
    getMaximumChannelCount?: () => number | null
    getTelemetry: () => AudioWorkletTelemetry | null
    /** Reports each completed change of the physical output device */
    onOutputDeviceChange?: (listener: () => void) => () => void
    onTelemetry: (listener: AudioTelemetryListener) => () => void
    /** Rebuilds the output stage for a new layout on the same device and returns its bridge */
    reconfigure?: (configuration: DecodeWorkerAudioConfiguration) => Promise<CustomDecodeAudioBridge>
    setMuted: (muted: boolean) => void
    setPlaying: (playing: boolean) => Promise<void> | void
    setVolume: (volume: number) => void
};

/** The decoded output layout and downmix a live session should switch to */
export type CustomPlaybackAudioOutputOptions = {
    audioDownmixAlgorithm?: CustomAudioDownmixAlgorithm
    audioDownmixSettings?: AudioDownmixSettings
    /** Binaural headphone rendering; a change that keeps the layout switches between packets without a resync */
    binauralHeadphones?: boolean
    decodedAudioOutputLayout: CustomAudioOutputLayout
};

export type CustomAudioOutputBinding = {
    bridge: CustomDecodeAudioBridge
    configuration: DecodeWorkerAudioConfiguration
    output: CustomAudioOutput
};

export type CustomAudioOutputFactory = (
    configuration: DecodeWorkerAudioConfiguration
) => CustomAudioOutputBinding | Promise<CustomAudioOutputBinding>;

export type CustomVideoDecodeSession = {
    acknowledgeFrame: (presentationFrame: DecodedPresentationFrame) => boolean
    /** Terminates the decode worker, which every generation of the session shares */
    destroy: () => void
    discardFrame: (presentationFrame: DecodedPresentationFrame) => boolean
    getTelemetry: () => CustomDecodeSessionTelemetry
    getNativeAudioTimeMicroseconds?: () => Microseconds | null
    setNativeAudioMuted?: (muted: boolean) => void
    setNativeAudioPlaying?: (playing: boolean) => Promise<void>
    setNativeAudioVolume?: (volume: number) => void
    resyncAudio?: (options: CustomDecodeAudioResyncOptions) => Promise<number | null>
    resyncVideo?: (targetTimeMicroseconds: Microseconds) => boolean
    start: (options: CustomDecodeSessionStartOptions) => void
    stop: () => Promise<void>
    suspendVideo?: () => boolean
    takeFrame: (targetTimeMicroseconds: Microseconds) => DecodedPresentationFrame | null
    updateAudioBinaural?: (binauralHeadphones: boolean) => boolean
    updateAudioDownmixSettings: (settings: AudioDownmixSettings) => boolean
};

export type CustomVideoDecodeSessionFactory = (
    eventHandler: CustomDecodeSessionEventHandler,
    audioBridgeFactory: CustomDecodeAudioBridgeFactory | null,
    nativeAudioBridgeFactory: CustomDecodeNativeAudioBridgeFactory | null,
    gpuVideoDecodeSessionFactory: GPUVideoDecodeSessionFactory | null
) => CustomVideoDecodeSession;

/**
 * Prepares presentation for what a starting generation's track declares before its first frame, such as by building the plan those facts make;
 * the generation reports ready only once it settles.
 */
export type CustomPlaybackVideoPresentationPreparer = (facts: DecodedVideoStreamFacts) => Promise<void>;

export type CustomPlaybackClock = {
    readonly generation: number
    readonly isPaused: boolean
    readonly mediaTimeMicroseconds: Microseconds
    readonly rate: number
    pause: () => number
    reset: (mediaTimeMicroseconds?: Microseconds) => number
    /** Resumes, first holding the media time for the start hold, as a starting audio output is heard that much later */
    resume: (startHoldMicroseconds?: Microseconds) => number
    seek: (mediaTimeMicroseconds: Microseconds) => number
    setPlaybackRate: (playbackRate: number) => number
    snapshot: () => MediaClockSnapshot
    synchronize: (mediaTimeMicroseconds: Microseconds) => void
};

export type CustomPlaybackVideoDecodeLagTelemetry = {
    frameEndTimeMicroseconds: Microseconds
    gapMicroseconds: Microseconds
    generation: number
    postSeek: boolean
    targetTimeMicroseconds: Microseconds
};

/** How the presented video kept to the clock in the current generation. */
export type CustomPlaybackPresentationTimingTelemetry = {
    /** Clock re-anchors that moved the clock by at least one 60 Hz refresh */
    clockResetCount: number
    /** The largest clock re-anchor, in either direction */
    largestClockJumpMicroseconds: Microseconds
    /** Frames taken after the clock had already passed the end of their display interval */
    lateFrameCount: number
    /** The largest lag of a taken frame behind the clock */
    worstFrameLagMicroseconds: Microseconds
};

export type CustomPlaybackTelemetry = {
    activeGeneration: number | null
    audioBridge: CustomDecodeAudioBridgeTelemetry | null
    audioOutput: AudioWorkletTelemetry | null
    /** A live output layout switch is waiting for its new audio */
    audioOutputSwitchPending: boolean
    audioPath: 'disabled' | 'pending' | 'ready' | 'unavailable'
    clock: MediaClockSnapshot
    currentTimeMicroseconds: Microseconds
    discardedStaleVideoFrameCount: number
    durationMicroseconds: Microseconds | null
    fallbackCount: number
    fallbackReason: CustomPlaybackFallbackReason | null
    lastErrorMessage: string | null
    lastVideoDecodeLag: CustomPlaybackVideoDecodeLagTelemetry | null
    muted: boolean
    normalizationGain: number
    pageHidden: boolean
    playCount: number
    presentationTiming: CustomPlaybackPresentationTimingTelemetry
    staleEventCount: number
    startupDurationMicroseconds: Microseconds | null
    state: CustomPlaybackState
    videoDecode: CustomDecodeSessionTelemetry
    videoResyncPending: boolean
    videoSuspended: boolean
    volume: number
};

export type CustomPlaybackControllerEvent =
    | {
        generation: number
        /** Channels the new device accepts, or null when unknown */
        maximumChannelCount: number | null
        type: 'audio-output-changed'
    }
    | {
        generation: number
        metadata: StaticHDRMetadata
        type: 'static-hdr-metadata'
    }
    | {
        generation: number
        previousState: CustomPlaybackState
        state: CustomPlaybackState
        type: 'statechange'
    }
    | {
        generation: number
        durationMicroseconds: Microseconds | null
        startupDurationMicroseconds: Microseconds
        type: 'ready'
    }
    | {
        generation: number
        type: 'playing'
    }
    | {
        currentTimeMicroseconds: Microseconds
        durationMicroseconds: Microseconds | null
        generation: number
        type: 'timeupdate'
    }
    | {
        generation: number
        reason: 'audio-buffer' | 'startup' | 'video-frame'
        type: 'waiting'
    }
    | {
        generation: number
        type: 'ended'
    }
    | {
        generation: number
        message: string
        recoverable: boolean
        type: 'error'
    }
    | {
        request: CustomPlaybackFallbackRequest
        type: 'fallback-requested'
    }
    | {
        telemetry: CustomPlaybackTelemetry
        type: 'telemetry'
    };

export type CustomPlaybackControllerEventHandler = (event: CustomPlaybackControllerEvent) => void;

export type CustomPlaybackControllerOptions = {
    audioContext?: AudioContext
    audioOutputFactory?: CustomAudioOutputFactory
    audioWorkletOptions?: Omit<AudioWorkletControllerOptions, 'channelCount'>
    clock?: CustomPlaybackClock
    eventHandler?: CustomPlaybackControllerEventHandler
    fallbackHook?: CustomPlaybackHTMLFallbackHook
    /** Creates the frame-pool route's GPU decode sessions on the presenter's device; that route is unavailable without it */
    gpuVideoDecodeSessionFactory?: GPUVideoDecodeSessionFactory
    monotonicTimeSource?: MonotonicTimeSource
    nativeAudioBridgeFactory?: CustomDecodeNativeAudioBridgeFactory
    maximumVideoDecodeLagMicroseconds?: Microseconds
    pipelineStopTimeoutMicroseconds?: Microseconds
    playbackStallTimeoutMicroseconds?: Microseconds
    /** Longest startup overall, even while it progresses; never shorter than startupTimeoutMicroseconds */
    startupCeilingMicroseconds?: Microseconds
    /** Longest startup period without progress */
    startupTimeoutMicroseconds?: Microseconds
    timeUpdateIntervalMicroseconds?: Microseconds
    videoDecodeSessionFactory?: CustomVideoDecodeSessionFactory
};

export type { CustomDecodeSessionEvent };
