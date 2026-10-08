import type { Microseconds } from '../MediaTime';
import type { DecodedPresentationFrame } from '../presentation/WebGPUPresenter';
import type {
    AudioTelemetryListener,
    AudioWorkletControllerOptions
} from '../audio/output/AudioWorkletController';
import type { AudioWorkletTelemetry } from '../audio/output/AudioWorkletProtocol';
import type { CustomAudioOutputChannelCount } from '../audio/processing/CustomAudioChannelLayout';
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
    CustomDecodeAudioOutputMode,
    CustomDecodeDolbyVisionProfile,
    CustomDecodeNativeHDRTransfer,
    CustomDecodeRawVideoFrameFormat,
    CustomDecodeVideoDecoderBackend,
    CustomDecodeVideoOutputMode,
    DecodeWorkerAudioConfiguration
} from './DecodeWorkerProtocol';
import type { MediaClockSnapshot, MonotonicTimeSource } from './MediaClock';
import type { StaticHDRMetadata } from '../video/hdr/StaticHDRMetadata';

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
    audioDownmixAlgorithm?: CustomAudioDownmixAlgorithm
    audioDownmixSettings?: AudioDownmixSettings
    audioOutputMode?: CustomDecodeAudioOutputMode
    audioTrackIndex: number | null
    decodedAudioOutputChannelCount?: CustomAudioOutputChannelCount
    durationMicroseconds: Microseconds | null
    dolbyVisionProfile: CustomDecodeDolbyVisionProfile
    maximumCodedHeight: number
    maximumCodedWidth: number
    nativeHDRTransfer: CustomDecodeNativeHDRTransfer
    neutralizeHDRColorMetadata: boolean
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    startTimeMicroseconds: Microseconds
    url: string
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
    videoOutputMode: CustomDecodeVideoOutputMode
    videoTrackIndex: number
};

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

export type CustomPlaybackHTMLFallbackHook = (
    request: CustomPlaybackFallbackRequest
) => Promise<void> | void;

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
    reconfigure?: (
        configuration: DecodeWorkerAudioConfiguration
    ) => Promise<CustomDecodeAudioBridge>
    setMuted: (muted: boolean) => void
    setPlaying: (playing: boolean) => Promise<void> | void
    setVolume: (volume: number) => void
};

/** The decoded output layout and downmix a live session should switch to */
export type CustomPlaybackAudioOutputOptions = {
    audioDownmixAlgorithm?: CustomAudioDownmixAlgorithm
    audioDownmixSettings?: AudioDownmixSettings
    decodedAudioOutputChannelCount: CustomAudioOutputChannelCount
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
    updateAudioDownmixSettings: (settings: AudioDownmixSettings) => boolean
};

export type CustomVideoDecodeSessionFactory = (
    eventHandler: CustomDecodeSessionEventHandler,
    audioBridgeFactory: CustomDecodeAudioBridgeFactory | null,
    nativeAudioBridgeFactory: CustomDecodeNativeAudioBridgeFactory | null
) => CustomVideoDecodeSession;

export type CustomPlaybackClock = {
    readonly generation: number
    readonly isPaused: boolean
    readonly mediaTimeMicroseconds: Microseconds
    readonly rate: number
    pause: () => number
    reset: (mediaTimeMicroseconds?: Microseconds) => number
    resume: () => number
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

export type CustomPlaybackControllerEventHandler = (
    event: CustomPlaybackControllerEvent
) => void;

export type CustomPlaybackControllerOptions = {
    audioContext?: AudioContext
    audioOutputFactory?: CustomAudioOutputFactory
    audioWorkletOptions?: Omit<AudioWorkletControllerOptions, 'channelCount'>
    clock?: CustomPlaybackClock
    eventHandler?: CustomPlaybackControllerEventHandler
    fallbackHook?: CustomPlaybackHTMLFallbackHook
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
