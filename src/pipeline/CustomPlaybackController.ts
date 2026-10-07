import {
    microsecondsToMilliseconds,
    millisecondsToMicroseconds,
    type Microseconds
} from '../MediaTime';
import type { DecodedPresentationFrame } from '../presentation/WebGPUPresenter';
import AudioWorkletController from '../audio/output/AudioWorkletController';
import type { AudioWorkletTelemetry } from '../audio/output/AudioWorkletProtocol';
import { assertSupportedCustomAudioOutputLayout } from '../audio/CustomAudioOutputPolicy';
import { selectCustomAudioOutputChannelCountForMaximum } from '../audio/NativeMultichannelAudioOutput';
import {
    assertValidAudioDownmixSettings,
    type AudioDownmixSettings
} from '../audio/processing/CustomAudioDownmix';
import {
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
    isCustomAudioDownmixAlgorithm,
    type CustomAudioDownmixAlgorithm
} from '../audio/processing/CustomAudioDownmixAlgorithm';
import { CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT } from '../audio/processing/CustomAudioChannelLayout';
import CustomDecodeAudioBridge from '../audio/output/CustomDecodeAudioBridge';
import CustomDecodeSession, {
    type CustomDecodeAudioBridgeFactory,
    type CustomDecodeNativeAudioBridgeFactory,
    type CustomDecodeSessionEvent
} from './CustomDecodeSession';
import {
    getDolbyVisionRawFrameLayerCount,
    isDolbyVisionProfile,
    type CustomDecodeAudioOutputMode,
    type DecodeWorkerAudioConfiguration
} from './DecodeWorkerProtocol';
import MediaClock from './MediaClock';
import { hasRawVideoFrameResourceBudget } from '../video/RawVideoFrameCopy';
import { addMicroseconds, requireMicroseconds } from '../TimeMath';
import type {
    CustomAudioOutput,
    CustomAudioOutputBinding,
    CustomAudioOutputFactory,
    CustomPlaybackAudioOutputOptions,
    CustomPlaybackControllerEvent,
    CustomPlaybackControllerEventHandler,
    CustomPlaybackControllerOptions,
    CustomPlaybackFallbackDisposition,
    CustomPlaybackFallbackReason,
    CustomPlaybackFallbackRequest,
    CustomPlaybackHTMLFallbackHook,
    CustomPlaybackClock,
    CustomPlaybackPlayOptions,
    CustomPlaybackStartResult,
    CustomPlaybackState,
    CustomPlaybackTelemetry,
    CustomPlaybackVideoDecodeLagTelemetry,
    CustomVideoDecodeSession,
    CustomVideoDecodeSessionFactory
} from './CustomPlaybackControllerTypes';

export const DEFAULT_CUSTOM_PLAYBACK_STARTUP_TIMEOUT_MICROSECONDS =
    millisecondsToMicroseconds(20_000);
export const DEFAULT_CUSTOM_PLAYBACK_STOP_TIMEOUT_MICROSECONDS =
    millisecondsToMicroseconds(1_500);
export const DEFAULT_CUSTOM_PLAYBACK_TIME_UPDATE_INTERVAL_MICROSECONDS =
    millisecondsToMicroseconds(250);
export const DEFAULT_CUSTOM_PLAYBACK_VIDEO_STARVATION_GRACE_MICROSECONDS =
    millisecondsToMicroseconds(100);
export const DEFAULT_CUSTOM_PLAYBACK_STALL_TIMEOUT_MICROSECONDS =
    millisecondsToMicroseconds(10_000);
export const DEFAULT_CUSTOM_PLAYBACK_MAXIMUM_VIDEO_DECODE_LAG_MICROSECONDS =
    millisecondsToMicroseconds(2_000);
export const DEFAULT_CUSTOM_PLAYBACK_UNCORRELATED_AUDIO_DRAIN_GRACE_MICROSECONDS =
    millisecondsToMicroseconds(2_000);
// Matches Chromium's delay before it disables a hidden page's video track
export const CUSTOM_PLAYBACK_BACKGROUND_VIDEO_SUSPENSION_DELAY_MICROSECONDS =
    millisecondsToMicroseconds(10_000);
// After a hidden period, frames ending further behind the clock are never presented
export const CUSTOM_PLAYBACK_VIDEO_CATCH_UP_TOLERANCE_MICROSECONDS =
    millisecondsToMicroseconds(100);

// A live layout switch resumes audio this far ahead, so decode fills it before the clock arrives
export const CUSTOM_PLAYBACK_AUDIO_OUTPUT_SWITCH_LEAD_MICROSECONDS =
    millisecondsToMicroseconds(250);
export const CUSTOM_PLAYBACK_AUDIO_OUTPUT_SWITCH_TIMEOUT_MICROSECONDS =
    millisecondsToMicroseconds(5_000);

const MINIMUM_CUSTOM_PLAYBACK_UNCORRELATED_AUDIO_DRAIN_GRACE_MICROSECONDS =
    millisecondsToMicroseconds(100);
const CUSTOM_PLAYBACK_AUDIO_DRAIN_LATENCY_SAFETY_MICROSECONDS =
    millisecondsToMicroseconds(100);

type PendingStartup = {
    completing: boolean
    desiredPlaying: boolean
    generation: number
    phase: 'seeking' | 'starting'
    promise: Promise<CustomPlaybackStartResult>
    resolve: (result: CustomPlaybackStartResult) => void
    settled: boolean
    startedAtMicroseconds: Microseconds
    timer: ReturnType<typeof globalThis.setTimeout>
    mediaReady: boolean
};

type ClockStarvation = 'audio' | 'video';

type DrainedAudioTail = {
    endMediaTimeMicroseconds: Microseconds | null
    outputTelemetry: AudioWorkletTelemetry
};

type DrainedAudioState = {
    drained: boolean
    endMediaTimeMicroseconds: Microseconds | null
};

/** A live decoded-audio layout switch waiting for its new audio to fill and start */
type AudioOutputSwitch = {
    audioEpoch: number | null
    generation: number
    // The new audio filled, so only the clock reaching the target remains
    ready: boolean
    revision: number
    startTimer: ReturnType<typeof globalThis.setTimeout> | null
    targetTimeMicroseconds: Microseconds
    // Bounds the fill only; a filled switch may wait out a pause
    timeoutTimer: ReturnType<typeof globalThis.setTimeout> | null
};

const MAXIMUM_CONTROLLER_TIMEOUT_MICROSECONDS = millisecondsToMicroseconds(60_000);
const ZERO_MICROSECONDS = millisecondsToMicroseconds(0);

function createVideoDecodeSession(
    eventHandler: (event: CustomDecodeSessionEvent) => void,
    audioBridgeFactory: CustomDecodeAudioBridgeFactory | null,
    nativeAudioBridgeFactory: CustomDecodeNativeAudioBridgeFactory | null
): CustomVideoDecodeSession {
    return new CustomDecodeSession(
        eventHandler,
        undefined,
        null,
        audioBridgeFactory,
        nativeAudioBridgeFactory
    );
}

function createNoopEventHandler(): CustomPlaybackControllerEventHandler {
    return (): void => undefined;
}

function createNoopFallbackHook(): CustomPlaybackHTMLFallbackHook {
    return (): void => undefined;
}

function defaultMonotonicTimeSource(): Microseconds {
    return millisecondsToMicroseconds(performance.now());
}

function requirePositiveTimeout(value: Microseconds, label: string): Microseconds {
    requireMicroseconds(value, label);
    if (value <= 0 || value > MAXIMUM_CONTROLLER_TIMEOUT_MICROSECONDS) {
        throw new RangeError(`${label} must be from 1 through 60000000 microseconds`);
    }
    return value;
}

function validateTrackIndex(trackIndex: number, label: string): void {
    if (!Number.isSafeInteger(trackIndex) || trackIndex < 0) {
        throw new RangeError(`${label} must be a non-negative safe integer`);
    }
}

function validateCodedDimension(
    value: number,
    label: string
): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${label} must be a positive safe integer`);
    }
}

function validateAudioDownmixSettings(
    options: CustomPlaybackPlayOptions,
    audioOutputMode: CustomDecodeAudioOutputMode
): void {
    if (options.audioDownmixSettings === undefined) {
        return;
    }
    if (options.audioTrackIndex === null || audioOutputMode !== 'decoded-pcm') {
        throw new TypeError('Audio downmix settings require decoded PCM audio');
    }
    assertValidAudioDownmixSettings(options.audioDownmixSettings);
}

function validateAudioPlayOptions(options: CustomPlaybackPlayOptions): void {
    if (options.audioTrackIndex !== null) {
        validateTrackIndex(options.audioTrackIndex, 'Audio track index');
    }
    const audioOutputMode = options.audioOutputMode ?? 'decoded-pcm';
    if (audioOutputMode !== 'decoded-pcm' && audioOutputMode !== 'native-media') {
        throw new TypeError('Custom playback audio output mode is invalid');
    }
    if (options.audioTrackIndex === null && options.audioOutputMode !== undefined) {
        throw new TypeError('Custom playback cannot select an audio output mode without audio');
    }
    if (options.audioDownmixAlgorithm !== undefined
        && !isCustomAudioDownmixAlgorithm(options.audioDownmixAlgorithm)) {
        throw new TypeError('Custom playback audio downmix algorithm is invalid');
    }
    if (options.audioDownmixAlgorithm !== undefined
        && options.audioTrackIndex === null) {
        throw new TypeError('Custom playback cannot select a downmix algorithm without audio');
    }
    const decodedAudioOutputChannelCount = options.decodedAudioOutputChannelCount;
    if (decodedAudioOutputChannelCount !== undefined
        && decodedAudioOutputChannelCount !== 2
        && decodedAudioOutputChannelCount !== 6
        && decodedAudioOutputChannelCount !== 8) {
        throw new RangeError('Decoded audio output channel count must be 2, 6, or 8');
    }
    if (decodedAudioOutputChannelCount !== undefined
        && (options.audioTrackIndex === null || audioOutputMode !== 'decoded-pcm')) {
        throw new TypeError('Decoded audio output channels require decoded PCM audio');
    }
    validateAudioDownmixSettings(options, audioOutputMode);
}

/** Resolves the algorithm the decode worker applies when none was chosen */
function getAudioDownmixAlgorithm(options: CustomPlaybackPlayOptions): CustomAudioDownmixAlgorithm {
    return options.audioDownmixAlgorithm ?? DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM;
}

function validateAudioOutputOptions(options: CustomPlaybackAudioOutputOptions): void {
    const outputChannelCount = options.decodedAudioOutputChannelCount;
    if (outputChannelCount !== 2 && outputChannelCount !== 6 && outputChannelCount !== 8) {
        throw new RangeError('Decoded audio output channel count must be 2, 6, or 8');
    }
    if (options.audioDownmixAlgorithm !== undefined
        && !isCustomAudioDownmixAlgorithm(options.audioDownmixAlgorithm)) {
        throw new TypeError('Custom playback audio downmix algorithm is invalid');
    }
    if (options.audioDownmixSettings !== undefined) {
        assertValidAudioDownmixSettings(options.audioDownmixSettings);
    }
}

function validateHDRColorNeutralization(options: CustomPlaybackPlayOptions): void {
    if (typeof options.neutralizeHDRColorMetadata !== 'boolean') {
        throw new TypeError('Custom playback HDR color neutralization flag is invalid');
    }
    if (!options.neutralizeHDRColorMetadata) {
        if (options.nativeHDRTransfer !== null) {
            throw new TypeError('Custom playback cannot retain an inactive native HDR transfer');
        }
        return;
    }
    if (
        (options.nativeHDRTransfer !== 'hlg' && options.nativeHDRTransfer !== 'pq')
        || options.videoOutputMode !== 'video-frame'
        || options.videoDecoderBackend !== 'native'
        || options.dolbyVisionProfile !== null
    ) {
        throw new TypeError('HDR color neutralization requires native non-Dolby VideoFrame output');
    }
}

function validateVideoDecoderRoute(options: CustomPlaybackPlayOptions): void {
    switch (options.videoDecoderBackend) {
        case 'bundled-hevc':
        case 'native':
            return;
        case 'ffmpeg-mpeg2-vc1':
        case 'openjpeg':
            if (
                options.videoOutputMode !== 'video-frame'
                || options.rawVideoFrameFormat !== null
                || options.dolbyVisionProfile !== null
                || options.neutralizeHDRColorMetadata
                || options.nativeHDRTransfer !== null
            ) {
                throw new TypeError('Software video playback requires an SDR VideoFrame route');
            }
            return;
        default:
            throw new TypeError('Custom playback video decoder backend is invalid');
    }
}

function validateRawVideoFrameResourceBudget(options: CustomPlaybackPlayOptions): void {
    if (options.videoOutputMode !== 'raw-planes') {
        return;
    }
    if (options.rawVideoFrameFormat === null) {
        throw new TypeError('Raw custom playback requires a requested raw frame format');
    }
    if (!hasRawVideoFrameResourceBudget({
        codedHeight: options.maximumCodedHeight,
        codedWidth: options.maximumCodedWidth,
        displayHeight: options.maximumCodedHeight,
        displayWidth: options.maximumCodedWidth
    }, options.rawVideoFrameFormat, getDolbyVisionRawFrameLayerCount(options.dolbyVisionProfile))) {
        throw new RangeError('Raw custom playback exceeds its transfer memory budget');
    }
}

function validatePlayOptions(options: CustomPlaybackPlayOptions): void {
    requireMicroseconds(options.startTimeMicroseconds, 'Playback start time');
    if (!isDolbyVisionProfile(options.dolbyVisionProfile)) {
        throw new TypeError('Custom playback Dolby Vision profile is invalid');
    }
    if (options.durationMicroseconds !== null) {
        requireMicroseconds(options.durationMicroseconds, 'Playback duration');
        if (options.durationMicroseconds < 0) {
            throw new RangeError('Playback duration cannot be negative');
        }
    }
    if (typeof options.url !== 'string' || options.url.length === 0) {
        throw new TypeError('Custom playback URL must be a non-empty string');
    }
    validateVideoDecoderRoute(options);
    validateHDRColorNeutralization(options);
    validateCodedDimension(
        options.maximumCodedWidth,
        'Maximum coded width'
    );
    validateCodedDimension(
        options.maximumCodedHeight,
        'Maximum coded height'
    );
    validateTrackIndex(options.videoTrackIndex, 'Video track index');
    validateAudioPlayOptions(options);
    switch (options.videoOutputMode) {
        case 'raw-planes':
            validateRawVideoFrameResourceBudget(options);
            break;
        case 'video-frame':
            if (options.rawVideoFrameFormat !== null) {
                throw new TypeError('VideoFrame custom playback cannot request a raw frame format');
            }
            break;
        default:
            throw new TypeError('Custom playback video output mode is invalid');
    }
}

function copyPlayOptions(options: CustomPlaybackPlayOptions): CustomPlaybackPlayOptions {
    return {
        audioDownmixAlgorithm: options.audioDownmixAlgorithm,
        audioDownmixSettings: options.audioDownmixSettings ?
            { ...options.audioDownmixSettings } :
            undefined,
        audioOutputMode: options.audioOutputMode,
        audioTrackIndex: options.audioTrackIndex,
        decodedAudioOutputChannelCount: options.decodedAudioOutputChannelCount,
        durationMicroseconds: options.durationMicroseconds,
        dolbyVisionProfile: options.dolbyVisionProfile,
        maximumCodedHeight: options.maximumCodedHeight,
        maximumCodedWidth: options.maximumCodedWidth,
        nativeHDRTransfer: options.nativeHDRTransfer,
        neutralizeHDRColorMetadata: options.neutralizeHDRColorMetadata,
        rawVideoFrameFormat: options.rawVideoFrameFormat,
        startTimeMicroseconds: options.startTimeMicroseconds,
        url: options.url,
        videoDecoderBackend: options.videoDecoderBackend,
        videoOutputMode: options.videoOutputMode,
        videoTrackIndex: options.videoTrackIndex
    };
}

function hasSameAudioLayout(
    left: DecodeWorkerAudioConfiguration,
    right: DecodeWorkerAudioConfiguration
): boolean {
    return left.channelCount === right.channelCount
        && left.sampleRate === right.sampleRate;
}

function getFallbackDisposition(
    reason: CustomPlaybackFallbackReason
): CustomPlaybackFallbackDisposition {
    switch (reason) {
        case 'audio-output-failed':
        case 'audio-output-unavailable':
        case 'lifecycle-failed':
        case 'playback-rate-unsupported':
            return 'same-session-native';
        case 'decode-failed':
        case 'ended-before-ready':
        case 'network-failed':
        case 'playback-stalled':
        case 'range-unsupported':
        case 'source-unsupported':
        case 'startup-timeout':
            return 'renegotiate-source';
    }
}

function createDefaultAudioOutputFactory(
    options: CustomPlaybackControllerOptions
): CustomAudioOutputFactory | null {
    if (options.audioOutputFactory) {
        return options.audioOutputFactory;
    }
    if (!options.audioContext && !options.audioWorkletOptions) {
        return null;
    }
    if (!options.audioContext || !options.audioWorkletOptions) {
        throw new TypeError('AudioContext and AudioWorklet options must be provided together');
    }

    const audioContext = options.audioContext;
    const audioWorkletOptions = { ...options.audioWorkletOptions };
    return async (
        configuration: DecodeWorkerAudioConfiguration
    ): Promise<CustomAudioOutputBinding> => {
        if (audioContext.sampleRate !== configuration.sampleRate) {
            throw new RangeError('Decoded audio sample rate does not match the AudioContext');
        }
        const output = await AudioWorkletController.create(audioContext, {
            ...audioWorkletOptions,
            channelCount: configuration.channelCount
        });
        return {
            bridge: new CustomDecodeAudioBridge(output),
            configuration: { ...configuration },
            output
        };
    };
}

/** Owns a custom decode, audio-output, and media-clock playback lifecycle. */
export default class CustomPlaybackController {
    private activeGeneration: number | null = null;
    private audioBinding: CustomAudioOutputBinding | null = null;
    private audioOutput: CustomAudioOutput | null = null;
    private readonly audioOutputFactory: CustomAudioOutputFactory | null;
    private audioOutputCreationRevision = 0;
    private audioOutputDeviceUnsubscribe: (() => void) | null = null;
    private audioOutputPromise: Promise<CustomAudioOutputBinding> | null = null;
    private audioOutputPromiseConfiguration: DecodeWorkerAudioConfiguration | null = null;
    /** Settles once an in-flight live layout switch has rebuilt its output stage */
    private audioOutputReconfiguration: Promise<void> = Promise.resolve();
    private audioOutputSwitch: AudioOutputSwitch | null = null;
    private audioOutputSwitchRevision = 0;
    private audioPath: CustomPlaybackTelemetry['audioPath'] = 'disabled';
    private audioTelemetryUnsubscribe: (() => void) | null = null;
    private awaitingPostSeekVideoFrame = false;
    private readonly clock: CustomPlaybackClock;
    private clockStarvation: ClockStarvation | null = null;
    private currentGeneration = 0;
    private currentSource: CustomPlaybackPlayOptions | null = null;
    private destroyed = false;
    private discardedStaleVideoFrameCount = 0;
    private destroyPromise: Promise<void> | null = null;
    private readonly eventHandler: CustomPlaybackControllerEventHandler;
    private fallbackCount = 0;
    private fallbackGeneration: number | null = null;
    private fallbackReason: CustomPlaybackFallbackReason | null = null;
    private readonly fallbackHook: CustomPlaybackHTMLFallbackHook;
    private lastErrorMessage: string | null = null;
    private lastTimeUpdateMonotonicMicroseconds: Microseconds | null = null;
    private lastVideoDecodeLag: CustomPlaybackVideoDecodeLagTelemetry | null = null;
    private readonly monotonicTimeSource: () => Microseconds;
    private readonly maximumVideoDecodeLagMicroseconds: Microseconds;
    private muted = false;
    private normalizationGain = 1;
    private readonly nativeAudioBridgeFactory: CustomDecodeNativeAudioBridgeFactory | null;
    private nativeAudioClockGeneration: number | null = null;
    private nativeAudioClockTimeMicroseconds: Microseconds | null = null;
    private pageHidden = false;
    private pageHiddenAtMicroseconds: Microseconds | null = null;
    private pendingEndedGeneration: number | null = null;
    private lastDrainedVideoFrameEndTimeMicroseconds: Microseconds | null = null;
    private readonly pendingPresentationFrames = new Set<DecodedPresentationFrame>();
    private pendingStartup: PendingStartup | null = null;
    private readonly pipelineStopTimeoutMicroseconds: Microseconds;
    private readonly playbackStallTimeoutMicroseconds: Microseconds;
    private playbackStarvationStartedAtMicroseconds: Microseconds | null = null;
    private playCount = 0;
    private readonly startupTimeoutMicroseconds: Microseconds;
    private startupDurationMicroseconds: Microseconds | null = null;
    private staleEventCount = 0;
    private state: CustomPlaybackState = 'idle';
    private terminalAudioDrainDeadlineMicroseconds: Microseconds | null = null;
    private terminalAudioDrainGeneration: number | null = null;
    private terminalAudioTailReleased = false;
    private readonly videoDecodeSession: CustomVideoDecodeSession;
    private readonly timeUpdateIntervalMicroseconds: Microseconds;
    private volume = 1;
    /** Drops late frames unpresented until video reaches the clock after a hidden period */
    private videoCatchUpActive = false;
    private videoDecodeLagWaitActive = false;
    private videoFrameMissStartedAtMicroseconds: Microseconds | null = null;
    /** Set after a video resync until the first frame of the new epoch is taken */
    private videoResyncPending = false;
    /** Set while the video decoder is released for a hidden page */
    private videoSuspended = false;
    private waitingForVideoFrame = false;
    private videoStarvationAnchorMediaTimeMicroseconds: Microseconds | null = null;
    private videoStarvationAnchorMonotonicTimeMicroseconds: Microseconds | null = null;

    public constructor(options: CustomPlaybackControllerOptions = {}) {
        this.eventHandler = options.eventHandler ?? createNoopEventHandler();
        this.fallbackHook = options.fallbackHook ?? createNoopFallbackHook();
        this.monotonicTimeSource = options.monotonicTimeSource ?? defaultMonotonicTimeSource;
        this.clock = options.clock ?? new MediaClock(this.monotonicTimeSource);
        this.maximumVideoDecodeLagMicroseconds = requirePositiveTimeout(
            options.maximumVideoDecodeLagMicroseconds
                ?? DEFAULT_CUSTOM_PLAYBACK_MAXIMUM_VIDEO_DECODE_LAG_MICROSECONDS,
            'Maximum video decode lag'
        );
        this.pipelineStopTimeoutMicroseconds = requirePositiveTimeout(
            options.pipelineStopTimeoutMicroseconds
                ?? DEFAULT_CUSTOM_PLAYBACK_STOP_TIMEOUT_MICROSECONDS,
            'Pipeline stop timeout'
        );
        this.startupTimeoutMicroseconds = requirePositiveTimeout(
            options.startupTimeoutMicroseconds
                ?? DEFAULT_CUSTOM_PLAYBACK_STARTUP_TIMEOUT_MICROSECONDS,
            'Playback startup timeout'
        );
        this.playbackStallTimeoutMicroseconds = requirePositiveTimeout(
            options.playbackStallTimeoutMicroseconds
                ?? DEFAULT_CUSTOM_PLAYBACK_STALL_TIMEOUT_MICROSECONDS,
            'Playback stall timeout'
        );
        this.timeUpdateIntervalMicroseconds = requirePositiveTimeout(
            options.timeUpdateIntervalMicroseconds
                ?? DEFAULT_CUSTOM_PLAYBACK_TIME_UPDATE_INTERVAL_MICROSECONDS,
            'Time update interval'
        );
        this.audioOutputFactory = createDefaultAudioOutputFactory(options);
        this.nativeAudioBridgeFactory = options.nativeAudioBridgeFactory ?? null;
        const videoDecodeSessionFactory: CustomVideoDecodeSessionFactory =
            options.videoDecodeSessionFactory ?? createVideoDecodeSession;
        this.videoDecodeSession = videoDecodeSessionFactory(
            this.handleVideoDecodeEvent,
            this.audioOutputFactory ? this.createAudioBridge : null,
            this.nativeAudioBridgeFactory
        );
    }

    public get currentTimeMicroseconds(): Microseconds {
        const generation = this.activeGeneration;
        if (generation === null
            || this.currentSource?.audioOutputMode !== 'native-media'
            || !this.videoDecodeSession.getNativeAudioTimeMicroseconds) {
            return this.clock.mediaTimeMicroseconds;
        }

        const nativeAudioTimeMicroseconds =
            this.videoDecodeSession.getNativeAudioTimeMicroseconds();
        if (nativeAudioTimeMicroseconds !== null) {
            requireMicroseconds(nativeAudioTimeMicroseconds, 'Native audio clock time');
            this.nativeAudioClockGeneration = generation;
            this.nativeAudioClockTimeMicroseconds = nativeAudioTimeMicroseconds;
            this.clock.synchronize(nativeAudioTimeMicroseconds);
            return nativeAudioTimeMicroseconds;
        }
        if (this.nativeAudioClockGeneration === generation
            && this.nativeAudioClockTimeMicroseconds !== null) {
            return this.nativeAudioClockTimeMicroseconds;
        }
        return this.clock.mediaTimeMicroseconds;
    }

    public get durationMicroseconds(): Microseconds | null {
        return this.currentSource?.durationMicroseconds ?? null;
    }

    public get playbackRate(): number {
        return this.clock.rate;
    }

    public get playbackState(): CustomPlaybackState {
        return this.state;
    }

    /** Starts a fresh custom source and advances its clock after bounded preparation. */
    public play(options: CustomPlaybackPlayOptions): Promise<CustomPlaybackStartResult> {
        return this.beginPlayback(options, true, 'starting');
    }

    /** Pauses the application-owned clock and PCM output. */
    public pause(): void {
        this.requireUsable();
        if (this.pendingStartup) {
            this.pendingStartup.desiredPlaying = false;
            return;
        }
        if (this.state !== 'playing') {
            return;
        }

        this.videoFrameMissStartedAtMicroseconds = null;
        const generation = this.requireActiveGeneration();
        if (!this.clock.isPaused) {
            this.clock.pause();
        }
        if (this.clockStarvation === 'video') {
            this.videoStarvationAnchorMonotonicTimeMicroseconds = null;
        }
        this.playbackStarvationStartedAtMicroseconds = null;
        const audioOutputSwitch = this.audioOutputSwitch;
        if (audioOutputSwitch && audioOutputSwitch.startTimer !== null) {
            // Resume restarts the countdown, so the new audio still starts on the clock
            globalThis.clearTimeout(audioOutputSwitch.startTimer);
            audioOutputSwitch.startTimer = null;
        }
        void this.setAudioPlaying(false).catch((error: unknown): void => {
            this.activateFallback(generation, 'audio-output-failed', this.getErrorMessage(error));
        });
        this.setState('paused', generation);
        this.emitTimeUpdate();
    }

    /** Resumes a prepared or paused source without restarting decoders. */
    public resume(): void {
        this.requireUsable();
        if (this.pendingStartup) {
            this.pendingStartup.desiredPlaying = true;
            return;
        }
        if (this.state !== 'paused') {
            return;
        }

        const generation = this.requireActiveGeneration();
        if (this.clockStarvation === 'video') {
            this.videoStarvationAnchorMediaTimeMicroseconds = this.currentTimeMicroseconds;
            this.videoStarvationAnchorMonotonicTimeMicroseconds = this.readMonotonicTime();
        } else if (this.clockStarvation === null) {
            this.clock.resume();
        }
        if (this.hasActivePlaybackWait()) {
            this.playbackStarvationStartedAtMicroseconds = this.readMonotonicTime();
        }
        void this.setAudioPlaying(true).catch((error: unknown): void => {
            this.activateFallback(generation, 'audio-output-failed', this.getErrorMessage(error));
        });
        this.setState('playing', generation);
        if (this.audioOutputSwitch) {
            this.scheduleSwitchedAudioStart(this.audioOutputSwitch.revision);
        }
        if (this.clockStarvation === null && !this.waitingForVideoFrame) {
            this.emitEvent({ generation, type: 'playing' });
        }
        this.emitTimeUpdate();
    }

    /** Restarts both decode paths at one signed integer-microsecond timestamp. */
    public seek(mediaTimeMicroseconds: Microseconds): Promise<CustomPlaybackStartResult> {
        this.requireUsable();
        requireMicroseconds(mediaTimeMicroseconds, 'Seek time');
        if (!this.currentSource
            || this.state === 'fallback'
            || this.state === 'idle'
            || this.state === 'stopping') {
            throw new Error('Custom playback does not have an active seekable source');
        }

        const desiredPlaying = this.state === 'playing'
            || this.pendingStartup?.desiredPlaying === true;
        const seekOptions: CustomPlaybackPlayOptions = {
            ...this.currentSource,
            startTimeMicroseconds: mediaTimeMicroseconds
        };
        return this.beginPlayback(seekOptions, desiredPlaying, 'seeking');
    }

    /** Sets normalized output gain without changing mute state. */
    public setVolume(volume: number): void {
        this.requireUsable();
        if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
            throw new RangeError('Custom playback volume must be between zero and one');
        }

        this.volume = volume;
        this.applyOutputGain();
    }

    /** Sets the session normalization multiplier independently of the user volume. */
    public setNormalizationGain(normalizationGain: number): void {
        this.requireUsable();
        if (!Number.isFinite(normalizationGain) || normalizationGain < 0) {
            throw new RangeError('Audio normalization gain must be finite and non-negative');
        }

        this.normalizationGain = normalizationGain;
        this.applyOutputGain();
    }

    /** Applies live gains only to an owned decoded multichannel stereo route. */
    public updateAudioDownmixSettings(settings: AudioDownmixSettings): boolean {
        this.requireUsable();
        assertValidAudioDownmixSettings(settings);

        const currentSource = this.currentSource;
        if (!currentSource
            || (currentSource.audioOutputMode ?? 'decoded-pcm') !== 'decoded-pcm'
            || currentSource.audioTrackIndex === null
            || (currentSource.decodedAudioOutputChannelCount ?? 2) !== 2) {
            return false;
        }

        const settingsSnapshot: AudioDownmixSettings = { ...settings };
        this.currentSource = {
            ...currentSource,
            audioDownmixSettings: settingsSnapshot
        };
        const activeGeneration = this.activeGeneration;
        if (activeGeneration === null
            || this.videoDecodeSession.getTelemetry().activeGeneration
                !== activeGeneration) {
            return false;
        }
        return this.videoDecodeSession.updateAudioDownmixSettings(settingsSnapshot);
    }

    public setMuted(muted: boolean): void {
        this.requireUsable();
        this.muted = muted;
        this.audioOutput?.setMuted(muted);
        this.videoDecodeSession.setNativeAudioMuted?.(muted);
    }

    /** Reports whether client-side audio switching can avoid server renegotiation. */
    public canSetAudioStreamIndex(): boolean {
        if (this.destroyed) {
            return false;
        }
        return this.audioOutputFactory !== null || this.nativeAudioBridgeFactory !== null;
    }

    /** Restarts decode generations with the selected owned audio route. */
    public setAudioStreamIndex(
        audioStreamIndex: number,
        audioOutputMode: CustomDecodeAudioOutputMode =
        this.currentSource?.audioOutputMode ?? 'decoded-pcm',
        decodedAudioOutputChannelCount = this.currentSource?.decodedAudioOutputChannelCount,
        audioDownmixSettings: AudioDownmixSettings | undefined =
        this.currentSource?.audioDownmixSettings
    ): Promise<CustomPlaybackStartResult> {
        this.requireUsable();
        validateTrackIndex(audioStreamIndex, 'Audio stream index');
        if (!this.currentSource || !this.isAudioOutputModeAvailable(audioOutputMode)) {
            throw new Error('Client-side audio stream switching is unavailable');
        }
        if (this.state === 'fallback'
            || this.state === 'idle'
            || this.state === 'stopping') {
            throw new Error('Custom playback does not have an active audio-switchable source');
        }

        const desiredPlaying = this.state === 'playing'
            || this.pendingStartup?.desiredPlaying === true;
        const switchTimeMicroseconds = this.currentTimeMicroseconds;
        const switchOptions: CustomPlaybackPlayOptions = {
            ...this.currentSource,
            audioDownmixSettings: audioOutputMode === 'decoded-pcm' ?
                audioDownmixSettings :
                undefined,
            audioOutputMode,
            audioTrackIndex: audioStreamIndex,
            decodedAudioOutputChannelCount: audioOutputMode === 'decoded-pcm' ?
                decodedAudioOutputChannelCount :
                undefined,
            startTimeMicroseconds: switchTimeMicroseconds
        };
        return this.beginPlayback(switchOptions, desiredPlaying, 'seeking');
    }

    /** Returns how many channels the active decoded output's device accepts. */
    public getAudioOutputMaximumChannelCount(): number | null {
        return this.audioOutput?.getMaximumChannelCount?.() ?? null;
    }

    /**
     * Switches decoded audio to a new output layout and downmix while video keeps
     * playing. Audio rests briefly while the new layout fills, and the clock keeps
     * running. The channel count is a ceiling: output keeps the source's own speaker
     * layout when it fits and is mixed down to stereo otherwise. Resolves false when
     * the live switch is unavailable or did not start.
     */
    public async reconfigureAudioOutput(
        options: CustomPlaybackAudioOutputOptions
    ): Promise<boolean> {
        this.requireUsable();
        validateAudioOutputOptions(options);
        const generation = this.activeGeneration;
        const previousSource = this.currentSource;
        const binding = this.audioBinding;
        const output = binding?.output ?? null;
        const resyncAudio = this.videoDecodeSession.resyncAudio;
        if (generation === null
            || !previousSource
            || !binding
            || !output?.reconfigure
            || !resyncAudio
            || this.pendingStartup
            || (this.state !== 'playing' && this.state !== 'paused')
            || (previousSource.audioOutputMode ?? 'decoded-pcm') !== 'decoded-pcm'
            || previousSource.audioTrackIndex === null) {
            return false;
        }

        const sourceChannelCount = binding.configuration.sourceChannelCount
            ?? binding.configuration.channelCount;
        // Only stereo converts layouts, so a speaker bed the source cannot fill mixes down
        const outputChannelCount = selectCustomAudioOutputChannelCountForMaximum(
            options.decodedAudioOutputChannelCount,
            sourceChannelCount
        );
        // Later seeks and track switches start with the newest requested downmix
        const requestedSource: CustomPlaybackPlayOptions = {
            ...previousSource,
            audioDownmixAlgorithm: options.audioDownmixAlgorithm
                ?? previousSource.audioDownmixAlgorithm,
            audioDownmixSettings: options.audioDownmixSettings ?
                { ...options.audioDownmixSettings } :
                previousSource.audioDownmixSettings
        };
        // A pending switch already moved the source to the layout it is filling
        const currentOutputChannelCount = previousSource.decodedAudioOutputChannelCount
            ?? CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT;
        // The algorithm only matters when surround is mixed down to stereo
        const algorithmChanged = outputChannelCount === CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT
            && sourceChannelCount > CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT
            && getAudioDownmixAlgorithm(requestedSource) !== getAudioDownmixAlgorithm(previousSource);
        if (outputChannelCount === currentOutputChannelCount && !algorithmChanged) {
            this.currentSource = requestedSource;
            if (options.audioDownmixSettings) {
                this.updateAudioDownmixSettings(options.audioDownmixSettings);
            }
            return true;
        }

        this.clearAudioOutputSwitch();
        const revision = this.advanceAudioOutputSwitchRevision();
        const targetTimeMicroseconds = this.getAudioOutputSwitchTarget();
        this.audioOutputSwitch = {
            audioEpoch: null,
            generation,
            ready: false,
            revision,
            startTimer: null,
            targetTimeMicroseconds,
            timeoutTimer: globalThis.setTimeout((): void => {
                this.failAudioOutputSwitch(
                    revision,
                    'The decoded audio output switch exceeded its bounded timeout'
                );
            }, microsecondsToMilliseconds(CUSTOM_PLAYBACK_AUDIO_OUTPUT_SWITCH_TIMEOUT_MICROSECONDS))
        };
        const switchedSource: CustomPlaybackPlayOptions = {
            ...requestedSource,
            decodedAudioOutputChannelCount: outputChannelCount
        };
        this.currentSource = switchedSource;

        try {
            await this.waitBounded(
                Promise.resolve(output.setPlaying(false)),
                'Custom audio suspension exceeded its bound'
            );
            if (!this.isAudioOutputSwitchCurrent(revision)) {
                return false;
            }
            const audioEpoch = await resyncAudio.call(this.videoDecodeSession, {
                audioDownmixAlgorithm: switchedSource.audioDownmixAlgorithm,
                audioDownmixSettings: switchedSource.audioDownmixSettings,
                createAudioBridge: async (
                    configuration: DecodeWorkerAudioConfiguration
                ): Promise<CustomDecodeAudioBridge> => {
                    const reconfiguration = output.reconfigure?.(configuration)
                        ?? Promise.reject(new Error('Custom audio output cannot change its layout'));
                    this.audioOutputReconfiguration = reconfiguration.then(
                        (): void => undefined,
                        (): void => undefined
                    );
                    const bridge = await reconfiguration;
                    if (this.audioBinding?.output === output) {
                        this.audioBinding = {
                            bridge,
                            configuration: { ...configuration },
                            output
                        };
                    }
                    return bridge;
                },
                decodedAudioOutputChannelCount: outputChannelCount,
                targetTimeMicroseconds
            });
            if (!this.isAudioOutputSwitchCurrent(revision)) {
                return false;
            }
            if (audioEpoch === null) {
                // The session was not in a state that can switch; keep the old layout
                this.clearAudioOutputSwitch();
                this.currentSource = previousSource;
                this.restartAudioAfterSwitch(generation);
                return false;
            }
            const audioOutputSwitch = this.audioOutputSwitch;
            if (audioOutputSwitch) {
                audioOutputSwitch.audioEpoch = audioEpoch;
            }
            const decodeTelemetry = this.videoDecodeSession.getTelemetry();
            if (decodeTelemetry.audioEpoch === audioEpoch && !decodeTelemetry.audioResyncPending) {
                // The new epoch filled before this continuation ran
                this.completeAudioOutputSwitch(revision);
            }
            return true;
        } catch (error) {
            this.failAudioOutputSwitch(revision, this.getErrorMessage(error));
            return false;
        }
    }

    private isAudioOutputModeAvailable(audioOutputMode: CustomDecodeAudioOutputMode): boolean {
        switch (audioOutputMode) {
            case 'decoded-pcm':
                return this.audioOutputFactory !== null;
            case 'native-media':
                return this.nativeAudioBridgeFactory !== null;
        }
    }

    /** Changes clock rate when the active audio adapter can supply rate-adjusted PCM. */
    public setPlaybackRate(playbackRate: number): boolean {
        this.requireUsable();
        if (!Number.isFinite(playbackRate) || playbackRate <= 0) {
            throw new RangeError('Custom playback rate must be finite and greater than zero');
        }

        const generation = this.activeGeneration;
        const hasAudio = typeof this.currentSource?.audioTrackIndex === 'number';
        if (hasAudio && playbackRate !== 1) {
            this.activateFallback(
                generation,
                'playback-rate-unsupported',
                'The custom audio path cannot produce rate-adjusted PCM'
            );
            return false;
        }

        this.clock.setPlaybackRate(playbackRate);
        if (this.clockStarvation === 'video') {
            this.videoStarvationAnchorMediaTimeMicroseconds = this.currentTimeMicroseconds;
            this.videoStarvationAnchorMonotonicTimeMicroseconds = this.readMonotonicTime();
        }
        this.emitTimeUpdate();
        return true;
    }

    /** Supplies the renderer with the newest decoded frame for its target time. */
    public takeFrame(targetTimeMicroseconds: Microseconds): DecodedPresentationFrame | null {
        requireMicroseconds(targetTimeMicroseconds, 'Presentation target time');
        const generation = this.activeGeneration;
        if (generation === null
            || (this.state !== 'playing' && this.state !== 'paused')) {
            return null;
        }
        if (this.shouldAbortFrameTake(generation)) {
            return null;
        }

        const presentationFrame = this.videoDecodeSession.takeFrame(targetTimeMicroseconds);
        if (!presentationFrame && this.state === 'playing') {
            this.handleMissingVideoFrame(generation);
        } else if (presentationFrame) {
            // The session drops replaced epochs, so any frame completes a resync
            this.videoResyncPending = false;
            if (
                this.discardLateCatchUpFrame(presentationFrame, targetTimeMicroseconds, generation)
                || this.handleExcessivelyLaggingVideoFrame(
                    presentationFrame,
                    targetTimeMicroseconds,
                    generation
                )
            ) {
                return null;
            }
            this.awaitingPostSeekVideoFrame = false;
            this.videoDecodeLagWaitActive = false;
            this.videoFrameMissStartedAtMicroseconds = null;
            this.pendingPresentationFrames.add(presentationFrame);
            this.recoverVideoStarvation(presentationFrame);
            this.endVideoFrameWait(generation);
        }
        this.emitTimeUpdateIfDue();
        this.completeEndedPlaybackIfDrained(generation);
        return presentationFrame;
    }

    private shouldAbortFrameTake(generation: number): boolean {
        this.completeEndedPlaybackIfDrained(generation);
        return this.playbackState === 'ended'
            || (this.state === 'playing' && this.hasPlaybackStallExceeded(generation));
    }

    /** Takes a frame against the controller's application-owned clock. */
    public takeCurrentFrame(): DecodedPresentationFrame | null {
        return this.takeFrame(this.getCurrentPresentationTargetTime());
    }

    /**
     * Applies page visibility. A returning page restarts video alone from the keyframe
     * preceding the clock when its decoder was released or fell behind while hidden.
     * Returns whether a video resync was requested.
     */
    public setPageVisibility(visible: boolean): boolean {
        const pageHidden = !visible;
        if (this.destroyed || this.pageHidden === pageHidden) {
            return false;
        }

        this.pageHidden = pageHidden;
        if (pageHidden) {
            this.pageHiddenAtMicroseconds = this.readMonotonicTime();
            return false;
        }

        this.pageHiddenAtMicroseconds = null;
        if (this.activeGeneration === null
            || (this.state !== 'playing' && this.state !== 'paused')) {
            return false;
        }

        // Hidden time is not decode starvation, so bounded waits restart now
        this.videoFrameMissStartedAtMicroseconds = null;
        if (this.waitingForVideoFrame && this.clockStarvation !== 'audio') {
            this.playbackStarvationStartedAtMicroseconds = this.readMonotonicTime();
        }
        // An ended video track has no frames left to resync or catch up
        if (this.hasVideoTrackEnded()) {
            return false;
        }
        const targetTimeMicroseconds = this.getCurrentPresentationTargetTime();
        if (this.videoSuspended
            || (!this.videoResyncPending && this.isVideoDecodeBehind(
                targetTimeMicroseconds,
                this.maximumVideoDecodeLagMicroseconds
            ))) {
            return this.requestVideoResync(targetTimeMicroseconds);
        }
        // A short backlog is decoded through, but its late frames are never presented
        if (this.isVideoDecodeBehind(
            targetTimeMicroseconds,
            CUSTOM_PLAYBACK_VIDEO_CATCH_UP_TOLERANCE_MICROSECONDS
        )) {
            this.videoCatchUpActive = true;
        }
        return false;
    }

    /**
     * Consumes due frames while the page is hidden so decode keeps pace with the audio clock.
     * After the suspension delay, an eligible video decoder is released until the page returns.
     */
    public drainBackgroundVideo(): void {
        const generation = this.activeGeneration;
        const pageHiddenAtMicroseconds = this.pageHiddenAtMicroseconds;
        if (this.destroyed
            || !this.pageHidden
            || pageHiddenAtMicroseconds === null
            || generation === null
            || this.state !== 'playing'
            || this.videoSuspended) {
            return;
        }

        const hiddenDurationMicroseconds = this.readMonotonicTime() - pageHiddenAtMicroseconds;
        if (hiddenDurationMicroseconds >= CUSTOM_PLAYBACK_BACKGROUND_VIDEO_SUSPENSION_DELAY_MICROSECONDS
            && this.canSuspendBackgroundVideo()
            && this.videoDecodeSession.suspendVideo?.()) {
            this.videoSuspended = true;
            this.videoResyncPending = false;
            this.completeEndedPlaybackIfDrained(generation);
            return;
        }

        const presentationFrame = this.videoDecodeSession.takeFrame(
            this.getCurrentPresentationTargetTime()
        );
        if (presentationFrame) {
            this.videoResyncPending = false;
            this.recordDrainedVideoFrameEnd(presentationFrame);
            if (!this.discardStaleVideoFrame(presentationFrame)) {
                this.activateFallback(
                    generation,
                    'lifecycle-failed',
                    'A background custom video frame could not be released'
                );
                return;
            }
        }
        this.emitTimeUpdateIfDue();
        this.completeEndedPlaybackIfDrained(generation);
    }

    /** Acknowledges the renderer's safe release point for a transferred frame. */
    public notifyFramePresented(presentationFrame: DecodedPresentationFrame): boolean {
        if (!this.pendingPresentationFrames.delete(presentationFrame)) {
            return false;
        }
        if (!this.videoDecodeSession.acknowledgeFrame(presentationFrame)) {
            return false;
        }

        const generation = this.activeGeneration;
        if (generation !== null) {
            this.recordDrainedVideoFrameEnd(presentationFrame);
            this.completeEndedPlaybackIfDrained(generation);
        }
        return true;
    }

    /** Acknowledges that the renderer discarded a transferred decoded frame. */
    public notifyFrameDiscarded(presentationFrame: DecodedPresentationFrame): boolean {
        if (!this.pendingPresentationFrames.delete(presentationFrame)) {
            return false;
        }
        if (!this.videoDecodeSession.discardFrame(presentationFrame)) {
            return false;
        }

        const generation = this.activeGeneration;
        if (generation !== null) {
            this.recordDrainedVideoFrameEnd(presentationFrame);
            this.completeEndedPlaybackIfDrained(generation);
        }
        return true;
    }

    /** Emits an integration-facing integer-microsecond timing snapshot. */
    public emitTimeUpdate(): void {
        const generation = this.activeGeneration;
        if (generation === null) {
            return;
        }

        this.lastTimeUpdateMonotonicMicroseconds = this.readMonotonicTime();
        this.emitEvent({
            currentTimeMicroseconds: this.currentTimeMicroseconds,
            durationMicroseconds: this.durationMicroseconds,
            generation,
            type: 'timeupdate'
        });
    }

    /** Returns bounded decoder, audio, clock, and fallback diagnostics. */
    public getTelemetry(): CustomPlaybackTelemetry {
        const currentTimeMicroseconds = this.currentTimeMicroseconds;
        return {
            activeGeneration: this.activeGeneration,
            audioBridge: this.audioBinding?.bridge.getTelemetry() ?? null,
            audioOutput: this.audioOutput?.getTelemetry() ?? null,
            audioOutputSwitchPending: this.audioOutputSwitch !== null,
            audioPath: this.audioPath,
            clock: this.clock.snapshot(),
            currentTimeMicroseconds,
            discardedStaleVideoFrameCount: this.discardedStaleVideoFrameCount,
            durationMicroseconds: this.durationMicroseconds,
            fallbackCount: this.fallbackCount,
            fallbackReason: this.fallbackReason,
            lastErrorMessage: this.lastErrorMessage,
            lastVideoDecodeLag: this.lastVideoDecodeLag ?
                { ...this.lastVideoDecodeLag } :
                null,
            muted: this.muted,
            normalizationGain: this.normalizationGain,
            pageHidden: this.pageHidden,
            playCount: this.playCount,
            staleEventCount: this.staleEventCount,
            startupDurationMicroseconds: this.startupDurationMicroseconds,
            state: this.state,
            videoDecode: this.videoDecodeSession.getTelemetry(),
            videoResyncPending: this.videoResyncPending,
            videoSuspended: this.videoSuspended,
            volume: this.volume
        };
    }

    /** Stops all pipelines and permanently releases the AudioWorklet output. */
    public destroy(): Promise<void> {
        if (this.destroyPromise) {
            return this.destroyPromise;
        }

        this.destroyed = true;
        this.destroyPromise = this.stopController().then(
            (): Promise<void> => this.destroyAudioResources(),
            async (error: unknown): Promise<void> => {
                this.lastErrorMessage = this.getErrorMessage(error);
                await this.destroyAudioResources();
            }
        );
        return this.destroyPromise;
    }

    private beginPlayback(
        options: CustomPlaybackPlayOptions,
        desiredPlaying: boolean,
        phase: PendingStartup['phase']
    ): Promise<CustomPlaybackStartResult> {
        this.requireUsable();
        validatePlayOptions(options);
        const generation = this.advanceGeneration();
        this.supersedePendingStartup();
        this.clearAudioOutputSwitch();
        this.activeGeneration = generation;
        this.currentSource = copyPlayOptions(options);
        this.nativeAudioClockGeneration = null;
        this.nativeAudioClockTimeMicroseconds = null;
        this.fallbackGeneration = null;
        this.fallbackReason = null;
        this.lastErrorMessage = null;
        this.lastVideoDecodeLag = null;
        this.startupDurationMicroseconds = null;
        this.lastTimeUpdateMonotonicMicroseconds = null;
        this.discardedStaleVideoFrameCount = 0;
        this.awaitingPostSeekVideoFrame = phase === 'seeking';
        this.resetDrainAndStarvationState();
        this.playCount += 1;
        this.audioPath = options.audioTrackIndex === null ? 'disabled' : 'pending';
        this.clock.reset(options.startTimeMicroseconds);
        this.setState(phase, generation);
        this.emitEvent({ generation, reason: 'startup', type: 'waiting' });
        this.emitTimeUpdate();

        const pendingStartup = this.createPendingStartup(
            generation,
            desiredPlaying,
            phase
        );
        this.pendingStartup = pendingStartup;
        void this.prepareGeneration(generation, options);
        return pendingStartup.promise;
    }

    private createPendingStartup(
        generation: number,
        desiredPlaying: boolean,
        phase: PendingStartup['phase']
    ): PendingStartup {
        let resolveStartup: (result: CustomPlaybackStartResult) => void = () => {
            throw new Error('Startup promise was not initialized');
        };
        const promise = new Promise<CustomPlaybackStartResult>(resolve => {
            resolveStartup = resolve;
        });
        const timer = globalThis.setTimeout(() => {
            this.activateFallback(
                generation,
                'startup-timeout',
                'Custom playback preparation exceeded its bounded timeout'
            );
        }, microsecondsToMilliseconds(this.startupTimeoutMicroseconds));
        return {
            completing: false,
            desiredPlaying,
            generation,
            phase,
            promise,
            resolve: resolveStartup,
            settled: false,
            startedAtMicroseconds: this.readMonotonicTime(),
            timer,
            mediaReady: false
        };
    }

    private async prepareGeneration(
        generation: number,
        options: CustomPlaybackPlayOptions
    ): Promise<void> {
        try {
            await this.waitBounded(
                this.setAudioPlaying(false),
                'Custom audio suspension exceeded its bound'
            );
        } catch (error) {
            this.activateFallback(
                generation,
                'audio-output-failed',
                this.getErrorMessage(error)
            );
            return;
        }

        if (!this.isGenerationActive(generation)) {
            return;
        }

        try {
            await this.waitBounded(this.stopDecodePipelines(), 'Decoder shutdown timed out');
            if (!this.isGenerationActive(generation)) {
                return;
            }

            if (options.audioTrackIndex !== null) {
                switch (options.audioOutputMode ?? 'decoded-pcm') {
                    case 'decoded-pcm':
                        if (!this.audioOutputFactory) {
                            this.activateFallback(
                                generation,
                                'audio-output-unavailable',
                                'No custom PCM output is configured'
                            );
                            return;
                        }
                        break;
                    case 'native-media':
                        if (!this.nativeAudioBridgeFactory) {
                            this.activateFallback(
                                generation,
                                'audio-output-unavailable',
                                'No owned native media audio output is configured'
                            );
                            return;
                        }
                        break;
                }
            }

            if (!this.isGenerationActive(generation)) {
                return;
            }
            const activeOptions = this.currentSource;
            if (!activeOptions) {
                return;
            }
            this.videoDecodeSession.start({
                audioDownmixAlgorithm: activeOptions.audioDownmixAlgorithm,
                audioDownmixSettings: activeOptions.audioDownmixSettings,
                audioOutputMode: activeOptions.audioOutputMode,
                audioTrackIndex: activeOptions.audioTrackIndex,
                decodedAudioOutputChannelCount:
                    activeOptions.decodedAudioOutputChannelCount,
                durationMicroseconds: activeOptions.durationMicroseconds,
                dolbyVisionProfile: activeOptions.dolbyVisionProfile,
                generation,
                maximumCodedHeight: activeOptions.maximumCodedHeight,
                maximumCodedWidth: activeOptions.maximumCodedWidth,
                nativeHDRTransfer: activeOptions.nativeHDRTransfer,
                neutralizeHDRColorMetadata: activeOptions.neutralizeHDRColorMetadata,
                rawVideoFrameFormat: activeOptions.rawVideoFrameFormat,
                startTimeMicroseconds: activeOptions.startTimeMicroseconds,
                url: activeOptions.url,
                videoDecoderBackend: activeOptions.videoDecoderBackend,
                videoOutputMode: activeOptions.videoOutputMode,
                videoTrackIndex: activeOptions.videoTrackIndex
            });
        } catch (error) {
            this.activateFallback(
                generation,
                'lifecycle-failed',
                this.getErrorMessage(error)
            );
        }
    }

    private readonly handleVideoDecodeEvent = (event: CustomDecodeSessionEvent): void => {
        if (!this.isGenerationActive(event.generation)) {
            this.staleEventCount += 1;
            return;
        }

        switch (event.type) {
            case 'audio-resynced':
                this.handleAudioResynced(event);
                break;
            case 'configured':
                this.handleVideoConfigured(event);
                break;
            case 'ready':
                this.handleVideoReady(event);
                break;
            case 'ended':
                this.videoFrameMissStartedAtMicroseconds = null;
                if (this.audioOutputSwitch) {
                    // A tail shorter than the startup minimum still drains in the new layout
                    this.startSwitchedAudioOutput(this.audioOutputSwitch.revision);
                }
                if (this.pendingStartup?.generation === event.generation) {
                    this.activateFallback(
                        event.generation,
                        'ended-before-ready',
                        'The video decode stream ended before startup completed'
                    );
                    return;
                }
                if (this.state === 'ended'
                    || this.pendingEndedGeneration === event.generation) {
                    return;
                }
                this.pendingEndedGeneration = event.generation;
                this.completeEndedPlaybackIfDrained(event.generation);
                break;
            case 'error':
                this.activateFallback(
                    event.generation,
                    event.failureKind,
                    event.message
                );
                break;
            case 'video-interrupted':
                this.handleVideoInterrupted();
                break;
        }
    };

    /** Recovers a reclaimed video decoder now, or on return when the page is hidden. */
    private handleVideoInterrupted(): void {
        if (this.pageHidden && this.canSuspendBackgroundVideo() && !this.pendingStartup) {
            this.videoSuspended = true;
            this.videoResyncPending = false;
            return;
        }
        this.requestVideoResync(this.getCurrentPresentationTargetTime());
    }

    private handleVideoConfigured(
        event: Extract<CustomDecodeSessionEvent, { type: 'configured' }>
    ): void {
        if (this.pendingStartup?.generation !== event.generation) {
            return;
        }

        this.audioPath = event.audio ? 'pending' : 'disabled';
        if (event.staticHDRMetadata) {
            this.emitEvent({
                generation: event.generation,
                metadata: event.staticHDRMetadata,
                type: 'static-hdr-metadata'
            });
        }
    }

    private handleVideoReady(
        event: Extract<CustomDecodeSessionEvent, { type: 'ready' }>
    ): void {
        if (this.pendingStartup?.generation !== event.generation) {
            return;
        }

        this.audioPath = event.audio ? 'ready' : 'disabled';
        if (this.currentSource?.audioOutputMode === 'native-media') {
            this.videoDecodeSession.setNativeAudioVolume?.(this.getNativeOutputGain());
            this.videoDecodeSession.setNativeAudioMuted?.(this.muted);
        }
        this.pendingStartup.mediaReady = true;
        void this.completeStartupIfReady(event.generation);
    }

    private async completeStartupIfReady(generation: number): Promise<void> {
        const pendingStartup = this.pendingStartup;
        if (!pendingStartup
            || pendingStartup.generation !== generation
            || !pendingStartup.mediaReady
            || pendingStartup.completing) {
            return;
        }

        pendingStartup.completing = true;
        try {
            let appliedPlaying = pendingStartup.desiredPlaying;
            while (true) {
                appliedPlaying = pendingStartup.desiredPlaying;
                await this.setAudioPlaying(appliedPlaying);
                if (!this.isPendingStartupActive(pendingStartup)) {
                    return;
                }
                if (appliedPlaying === pendingStartup.desiredPlaying) {
                    break;
                }
            }

            if (appliedPlaying) {
                this.clock.resume();
                this.setState('playing', generation);
            } else {
                this.setState('paused', generation);
            }
        } catch (error) {
            this.activateFallback(
                generation,
                'audio-output-failed',
                this.getErrorMessage(error)
            );
            return;
        } finally {
            if (this.pendingStartup === pendingStartup) {
                pendingStartup.completing = false;
            }
        }

        if (!this.isPendingStartupActive(pendingStartup)) {
            return;
        }

        this.startupDurationMicroseconds = requireMicroseconds(
            this.readMonotonicTime() - pendingStartup.startedAtMicroseconds,
            'Startup duration'
        );
        this.settlePendingStartup({
            fallbackReason: null,
            generation,
            status: 'started'
        });
        this.emitEvent({
            durationMicroseconds: this.durationMicroseconds,
            generation,
            startupDurationMicroseconds: this.startupDurationMicroseconds,
            type: 'ready'
        });
        if (pendingStartup.desiredPlaying) {
            this.emitEvent({ generation, type: 'playing' });
        }
        this.emitTimeUpdate();
    }

    private finishEndedPlayback(generation: number): void {
        if (!this.isGenerationActive(generation)
            || this.pendingEndedGeneration !== generation) {
            return;
        }

        this.pendingEndedGeneration = null;
        this.clockStarvation = null;
        this.playbackStarvationStartedAtMicroseconds = null;
        this.videoDecodeLagWaitActive = false;
        this.videoFrameMissStartedAtMicroseconds = null;
        this.videoStarvationAnchorMediaTimeMicroseconds = null;
        this.videoStarvationAnchorMonotonicTimeMicroseconds = null;
        this.waitingForVideoFrame = false;
        if (!this.clock.isPaused) {
            this.clock.pause();
        }
        void this.setAudioPlaying(false).catch((error: unknown): void => {
            this.lastErrorMessage = this.getErrorMessage(error);
        });
        this.setState('ended', generation);
        this.emitTimeUpdate();
        this.emitEvent({ generation, type: 'ended' });
    }

    private completeEndedPlaybackIfDrained(generation: number): void {
        if (this.pendingEndedGeneration !== generation
            || !this.isGenerationActive(generation)) {
            return;
        }

        const drainedAudioState = this.getDrainedAudioState(generation);
        if (!drainedAudioState.drained) {
            return;
        }
        const audioEndTimeMicroseconds = drainedAudioState.endMediaTimeMicroseconds;

        const queuedFrameCount = this.videoDecodeSession.getTelemetry().queuedFrameCount;
        if (queuedFrameCount !== 0) {
            return;
        }

        if (this.pendingPresentationFrames.size !== 0) {
            return;
        }

        let finalMediaEndTimeMicroseconds = this.lastDrainedVideoFrameEndTimeMicroseconds;
        if (audioEndTimeMicroseconds !== null
            && (finalMediaEndTimeMicroseconds === null
                || audioEndTimeMicroseconds > finalMediaEndTimeMicroseconds)) {
            finalMediaEndTimeMicroseconds = audioEndTimeMicroseconds;
        }
        if (finalMediaEndTimeMicroseconds !== null
            && this.currentTimeMicroseconds < finalMediaEndTimeMicroseconds) {
            return;
        }

        if (this.pendingEndedGeneration !== generation) {
            return;
        }
        this.finishEndedPlayback(generation);
    }

    private getDrainedAudioState(generation: number): DrainedAudioState {
        if (typeof this.currentSource?.audioTrackIndex !== 'number') {
            return { drained: true, endMediaTimeMicroseconds: null };
        }
        if (this.currentSource.audioOutputMode === 'native-media') {
            return {
                drained: true,
                endMediaTimeMicroseconds: this.currentTimeMicroseconds
            };
        }

        const drainedAudioTail = this.getDrainedAudioTail(generation);
        if (!drainedAudioTail || !this.updateTerminalAudioDrain(generation, drainedAudioTail)) {
            return { drained: false, endMediaTimeMicroseconds: null };
        }
        return {
            drained: true,
            endMediaTimeMicroseconds: drainedAudioTail.endMediaTimeMicroseconds
        };
    }

    private getDrainedAudioTail(generation: number): DrainedAudioTail | null {
        const audioBinding = this.audioBinding;
        const audioOutput = this.audioOutput;
        const bridgeTelemetry = audioBinding?.bridge.getTelemetry();
        if (!audioBinding
            || !audioOutput
            || audioBinding.output !== audioOutput
            || !bridgeTelemetry
            || bridgeTelemetry.activeDecodeGeneration !== generation
            || bridgeTelemetry.workletGeneration === null
            || bridgeTelemetry.pendingFrameCount !== 0
            || bridgeTelemetry.pendingSampleCount !== 0
            || (bridgeTelemetry.submittedSampleCount > 0
                && bridgeTelemetry.submittedEndMediaTimeMicroseconds === null)) {
            return null;
        }

        const outputTelemetry = audioOutput.getTelemetry();
        if (!outputTelemetry
            || outputTelemetry.generation !== bridgeTelemetry.workletGeneration
            || outputTelemetry.generation !== audioOutput.generation
            || outputTelemetry.queuedFrames !== 0) {
            return null;
        }

        return {
            endMediaTimeMicroseconds: bridgeTelemetry.submittedEndMediaTimeMicroseconds,
            outputTelemetry
        };
    }

    private getTerminalAudioTailFromUnderflow(
        telemetry: AudioWorkletTelemetry,
        generation: number
    ): DrainedAudioTail | null {
        const bridgeTelemetry = this.audioBinding?.bridge.getTelemetry();
        if (this.pendingEndedGeneration !== generation
            || typeof this.currentSource?.audioTrackIndex !== 'number'
            || telemetry.queuedFrames !== 0
            || !bridgeTelemetry
            || bridgeTelemetry.activeDecodeGeneration !== generation
            || bridgeTelemetry.workletGeneration !== telemetry.generation
            || (bridgeTelemetry.submittedSampleCount > 0
                && bridgeTelemetry.submittedEndMediaTimeMicroseconds === null)) {
            return null;
        }

        return {
            endMediaTimeMicroseconds: bridgeTelemetry.submittedEndMediaTimeMicroseconds,
            outputTelemetry: telemetry
        };
    }

    private updateTerminalAudioDrain(
        generation: number,
        drainedAudioTail: DrainedAudioTail
    ): boolean {
        this.prepareTerminalAudioDrain(generation);
        if (this.terminalAudioTailReleased) {
            return true;
        }

        const audioEndTimeMicroseconds = drainedAudioTail.endMediaTimeMicroseconds;
        if (audioEndTimeMicroseconds === null) {
            this.releaseTerminalAudioTail();
            return true;
        }

        return drainedAudioTail.outputTelemetry.hasPhysicalOutputTimeCorrelation ?
            this.updateCorrelatedTerminalAudioDrain(
                drainedAudioTail.outputTelemetry,
                audioEndTimeMicroseconds
            ) :
            this.updateUncorrelatedTerminalAudioDrain(audioEndTimeMicroseconds);
    }

    private prepareTerminalAudioDrain(generation: number): void {
        if (this.terminalAudioDrainGeneration !== generation) {
            this.terminalAudioDrainDeadlineMicroseconds = null;
            this.terminalAudioDrainGeneration = generation;
            this.terminalAudioTailReleased = false;
        }

        const playbackWasWaiting = this.hasActivePlaybackWait();
        this.clockStarvation = null;
        this.playbackStarvationStartedAtMicroseconds = null;
        this.videoDecodeLagWaitActive = false;
        this.videoFrameMissStartedAtMicroseconds = null;
        this.videoStarvationAnchorMediaTimeMicroseconds = null;
        this.videoStarvationAnchorMonotonicTimeMicroseconds = null;
        this.waitingForVideoFrame = false;
        if (playbackWasWaiting && this.state === 'playing') {
            this.emitEvent({ generation, type: 'playing' });
        }
    }

    private updateCorrelatedTerminalAudioDrain(
        outputTelemetry: AudioWorkletTelemetry,
        audioEndTimeMicroseconds: Microseconds
    ): boolean {
        this.terminalAudioDrainDeadlineMicroseconds = null;
        const correlatedMediaTimeMicroseconds = requireMicroseconds(
            Math.min(outputTelemetry.mediaTimeMicroseconds, audioEndTimeMicroseconds),
            'Correlated terminal audio time'
        );
        this.clock.synchronize(correlatedMediaTimeMicroseconds);
        if (this.state === 'playing' && this.clock.isPaused) {
            this.clock.resume();
        }
        if (outputTelemetry.mediaTimeMicroseconds < audioEndTimeMicroseconds) {
            return false;
        }

        this.releaseTerminalAudioTail();
        return true;
    }

    private updateUncorrelatedTerminalAudioDrain(
        audioEndTimeMicroseconds: Microseconds
    ): boolean {
        const monotonicTimeMicroseconds = this.readMonotonicTime();
        if (this.terminalAudioDrainDeadlineMicroseconds === null) {
            if (this.state === 'playing' && !this.clock.isPaused) {
                this.clock.pause();
            }
            this.terminalAudioDrainDeadlineMicroseconds = addMicroseconds(
                monotonicTimeMicroseconds,
                this.getUncorrelatedAudioDrainGraceMicroseconds()
            );
        }
        if (monotonicTimeMicroseconds < this.terminalAudioDrainDeadlineMicroseconds) {
            return false;
        }

        this.clock.synchronize(requireMicroseconds(
            Math.max(this.currentTimeMicroseconds, audioEndTimeMicroseconds),
            'Uncorrelated terminal audio release time'
        ));
        this.releaseTerminalAudioTail();
        return true;
    }

    private releaseTerminalAudioTail(): void {
        this.terminalAudioDrainDeadlineMicroseconds = null;
        this.terminalAudioTailReleased = true;
        if (this.state === 'playing' && this.clock.isPaused) {
            this.clock.resume();
        }
    }

    private getUncorrelatedAudioDrainGraceMicroseconds(): Microseconds {
        const getEstimatedOutputLatencyMicroseconds =
            this.audioOutput?.getEstimatedOutputLatencyMicroseconds;
        if (!getEstimatedOutputLatencyMicroseconds) {
            return DEFAULT_CUSTOM_PLAYBACK_UNCORRELATED_AUDIO_DRAIN_GRACE_MICROSECONDS;
        }

        let estimatedOutputLatencyMicroseconds: Microseconds | null;
        try {
            estimatedOutputLatencyMicroseconds = getEstimatedOutputLatencyMicroseconds.call(
                this.audioOutput
            );
        } catch {
            return DEFAULT_CUSTOM_PLAYBACK_UNCORRELATED_AUDIO_DRAIN_GRACE_MICROSECONDS;
        }
        if (estimatedOutputLatencyMicroseconds === null
            || !Number.isSafeInteger(estimatedOutputLatencyMicroseconds)
            || estimatedOutputLatencyMicroseconds < 0) {
            return DEFAULT_CUSTOM_PLAYBACK_UNCORRELATED_AUDIO_DRAIN_GRACE_MICROSECONDS;
        }

        const conservativeGraceMicroseconds = estimatedOutputLatencyMicroseconds
            + CUSTOM_PLAYBACK_AUDIO_DRAIN_LATENCY_SAFETY_MICROSECONDS;
        return requireMicroseconds(
            Math.min(
                DEFAULT_CUSTOM_PLAYBACK_UNCORRELATED_AUDIO_DRAIN_GRACE_MICROSECONDS,
                Math.max(
                    MINIMUM_CUSTOM_PLAYBACK_UNCORRELATED_AUDIO_DRAIN_GRACE_MICROSECONDS,
                    conservativeGraceMicroseconds
                )
            ),
            'Uncorrelated terminal audio drain grace'
        );
    }

    private recordDrainedVideoFrameEnd(
        presentationFrame: DecodedPresentationFrame
    ): void {
        const frameEndTimeMicroseconds = addMicroseconds(
            presentationFrame.mediaTimeMicroseconds,
            presentationFrame.durationMicroseconds > 0 ?
                presentationFrame.durationMicroseconds :
                ZERO_MICROSECONDS
        );
        if (this.lastDrainedVideoFrameEndTimeMicroseconds === null
            || frameEndTimeMicroseconds > this.lastDrainedVideoFrameEndTimeMicroseconds) {
            this.lastDrainedVideoFrameEndTimeMicroseconds = frameEndTimeMicroseconds;
        }
    }

    private activateFallback(
        generation: number | null,
        reason: CustomPlaybackFallbackReason,
        message: string
    ): void {
        if (generation === null
            || !this.isGenerationActive(generation)
            || this.fallbackGeneration === generation) {
            return;
        }

        this.fallbackGeneration = generation;
        this.fallbackCount += 1;
        this.fallbackReason = reason;
        this.lastErrorMessage = message;
        this.clearAudioOutputSwitch();
        this.resetDrainAndStarvationState();
        this.audioPath = 'unavailable';
        const mediaTimeMicroseconds = this.currentTimeMicroseconds;
        void this.setAudioPlaying(false).catch((error: unknown): void => {
            this.lastErrorMessage = `${message}; ${this.getErrorMessage(error)}`;
        });
        if (!this.clock.isPaused) {
            this.clock.pause();
        }
        this.emitEvent({ generation, message, recoverable: true, type: 'error' });
        this.settlePendingStartup({ fallbackReason: reason, generation, status: 'fallback' });
        this.advanceGeneration();
        this.activeGeneration = null;
        this.nativeAudioClockGeneration = null;
        this.nativeAudioClockTimeMicroseconds = null;
        this.setState('fallback', generation);

        const fallbackRequest: CustomPlaybackFallbackRequest = {
            disposition: getFallbackDisposition(reason),
            generation,
            mediaTimeMicroseconds,
            preserveHTMLSession: true,
            reason
        };
        this.emitEvent({ request: fallbackRequest, type: 'fallback-requested' });
        try {
            const fallbackResult = this.fallbackHook(fallbackRequest);
            void Promise.resolve(fallbackResult).catch((error: unknown): void => {
                this.handleFallbackHookFailure(generation, error);
            });
        } catch (error) {
            this.handleFallbackHookFailure(generation, error);
        }
        void this.stopDecodePipelines().catch((error: unknown): void => {
            this.lastErrorMessage = this.getErrorMessage(error);
        });
    }

    private handleFallbackHookFailure(generation: number, error: unknown): void {
        this.lastErrorMessage = this.getErrorMessage(error);
        if (this.state === 'fallback') {
            this.setState('error', generation);
            this.emitEvent({
                generation,
                message: this.lastErrorMessage,
                recoverable: false,
                type: 'error'
            });
        }
    }

    private readonly createAudioBridge = async (
        configuration: DecodeWorkerAudioConfiguration
    ): Promise<CustomDecodeAudioBridge> => {
        // A live layout switch finishes rebuilding before a new generation picks an output
        await this.audioOutputReconfiguration;
        const binding = await this.getOrCreateAudioBinding(configuration);
        return binding.bridge;
    };

    private getOrCreateAudioBinding(
        configuration: DecodeWorkerAudioConfiguration
    ): Promise<CustomAudioOutputBinding> {
        try {
            assertSupportedCustomAudioOutputLayout(
                configuration.channelCount,
                configuration.sampleRate
            );
        } catch (error) {
            return Promise.reject(error);
        }
        if (!this.audioOutputFactory) {
            return Promise.reject(new Error('Custom audio output is unavailable'));
        }
        if (this.audioBinding
            && hasSameAudioLayout(this.audioBinding.configuration, configuration)) {
            this.audioBinding = {
                ...this.audioBinding,
                configuration: { ...configuration }
            };
            return Promise.resolve(this.audioBinding);
        }
        if (this.audioOutputPromise
            && this.audioOutputPromiseConfiguration
            && hasSameAudioLayout(this.audioOutputPromiseConfiguration, configuration)) {
            return this.audioOutputPromise;
        }

        const creationRevision = this.advanceAudioOutputCreationRevision();
        const creationPromise = this.createAudioBinding(
            configuration,
            creationRevision
        ).catch((error: unknown): never => {
            if (this.audioOutputPromise === creationPromise) {
                this.audioOutputPromise = null;
                this.audioOutputPromiseConfiguration = null;
            }
            throw error;
        });
        this.audioOutputPromise = creationPromise;
        this.audioOutputPromiseConfiguration = { ...configuration };
        return creationPromise;
    }

    private async createAudioBinding(
        configuration: DecodeWorkerAudioConfiguration,
        creationRevision: number
    ): Promise<CustomAudioOutputBinding> {
        if (this.destroyed) {
            throw new Error('Custom playback was destroyed during audio initialization');
        }
        if (this.audioBinding
            && hasSameAudioLayout(this.audioBinding.configuration, configuration)) {
            this.audioBinding = {
                ...this.audioBinding,
                configuration: { ...configuration }
            };
            return this.audioBinding;
        }
        if (!this.audioOutputFactory) {
            throw new Error('Custom audio output is unavailable');
        }

        const factoryPromise = Promise.resolve(this.audioOutputFactory({ ...configuration }));
        let binding: CustomAudioOutputBinding;
        try {
            binding = await this.waitBounded(
                factoryPromise,
                'Custom audio output initialization exceeded its bound',
                this.startupTimeoutMicroseconds
            );
        } catch (error) {
            void factoryPromise.then(
                (lateBinding: CustomAudioOutputBinding): Promise<void> => (
                    this.destroyAudioOutput(lateBinding.output)
                ),
                (): void => undefined
            );
            throw error;
        }
        if (!hasSameAudioLayout(binding.configuration, configuration)) {
            await this.destroyAudioOutput(binding.output);
            throw new RangeError('Custom audio output factory returned the wrong layout');
        }
        if (!this.canAcceptAudioBinding(creationRevision)) {
            await this.destroyAudioOutput(binding.output);
            throw new Error('Custom audio initialization outlived its playback generation');
        }

        this.audioTelemetryUnsubscribe?.();
        this.audioTelemetryUnsubscribe = null;
        this.audioOutputDeviceUnsubscribe?.();
        this.audioOutputDeviceUnsubscribe = null;
        const previousAudioOutput = this.audioBinding?.output ?? null;
        if (previousAudioOutput && previousAudioOutput !== binding.output) {
            this.audioBinding = null;
            if (this.audioOutput === previousAudioOutput) {
                this.audioOutput = null;
            }
            await this.destroyAudioOutput(previousAudioOutput);
        }
        try {
            binding.output.setVolume(this.getOutputGain());
            binding.output.setMuted(this.muted);
            await this.waitBounded(
                Promise.resolve(binding.output.setPlaying(false)),
                'Custom audio initialization suspension exceeded its bound'
            );
        } catch (error) {
            await this.destroyAudioOutput(binding.output);
            throw error;
        }
        if (!this.canAcceptAudioBinding(creationRevision)) {
            await this.destroyAudioOutput(binding.output);
            throw new Error('Custom audio initialization outlived its playback generation');
        }
        this.audioBinding = {
            ...binding,
            configuration: { ...configuration }
        };
        this.audioOutput = binding.output;
        this.audioTelemetryUnsubscribe = binding.output.onTelemetry(
            this.handleAudioOutputTelemetry
        );
        this.audioOutputDeviceUnsubscribe = binding.output.onOutputDeviceChange?.(
            this.handleAudioOutputDeviceChange
        ) ?? null;
        return this.audioBinding;
    }

    private canAcceptAudioBinding(creationRevision: number): boolean {
        return !this.destroyed
            && this.audioOutputCreationRevision === creationRevision
            && this.activeGeneration !== null
            && typeof this.currentSource?.audioTrackIndex === 'number';
    }

    /** Resumes a running clock's switch ahead of it, clamped to the end of the media */
    private getAudioOutputSwitchTarget(): Microseconds {
        const currentTimeMicroseconds = this.clock.mediaTimeMicroseconds;
        // A paused or audio-starved clock waits for the new audio, so it needs no lead
        if (this.state !== 'playing' || this.clock.isPaused) {
            return currentTimeMicroseconds;
        }
        const targetTimeMicroseconds = addMicroseconds(
            currentTimeMicroseconds,
            CUSTOM_PLAYBACK_AUDIO_OUTPUT_SWITCH_LEAD_MICROSECONDS
        );
        const durationMicroseconds = this.durationMicroseconds;
        return durationMicroseconds !== null && targetTimeMicroseconds >= durationMicroseconds ?
            currentTimeMicroseconds :
            targetTimeMicroseconds;
    }

    private isAudioOutputSwitchCurrent(revision: number): boolean {
        const audioOutputSwitch = this.audioOutputSwitch;
        return audioOutputSwitch !== null
            && audioOutputSwitch.revision === revision
            && this.isGenerationActive(audioOutputSwitch.generation);
    }

    private readonly handleAudioResynced = (
        event: Extract<CustomDecodeSessionEvent, { type: 'audio-resynced' }>
    ): void => {
        const audioOutputSwitch = this.audioOutputSwitch;
        // A switch whose epoch is not yet known checks readiness when its resync resolves
        if (audioOutputSwitch?.audioEpoch === event.audioEpoch) {
            this.completeAudioOutputSwitch(audioOutputSwitch.revision);
        }
    };

    /** Marks the new layout filled, then starts it once playing reaches the switch target */
    private completeAudioOutputSwitch(revision: number): void {
        const audioOutputSwitch = this.audioOutputSwitch;
        if (!audioOutputSwitch
            || !this.isAudioOutputSwitchCurrent(revision)
            || audioOutputSwitch.ready) {
            return;
        }
        audioOutputSwitch.ready = true;
        if (audioOutputSwitch.timeoutTimer !== null) {
            globalThis.clearTimeout(audioOutputSwitch.timeoutTimer);
            audioOutputSwitch.timeoutTimer = null;
        }
        this.releaseRetiredAudioStarvation(audioOutputSwitch.generation);
        this.scheduleSwitchedAudioStart(revision);
    }

    /** Times a filled layout's start to the clock; while paused, resume schedules it */
    private scheduleSwitchedAudioStart(revision: number): void {
        const audioOutputSwitch = this.audioOutputSwitch;
        if (!audioOutputSwitch
            || !audioOutputSwitch.ready
            || audioOutputSwitch.startTimer !== null
            || this.state !== 'playing'
            || !this.isAudioOutputSwitchCurrent(revision)) {
            return;
        }

        const delayMicroseconds = requireMicroseconds(
            audioOutputSwitch.targetTimeMicroseconds - this.clock.mediaTimeMicroseconds,
            'Audio output switch delay'
        );
        if (delayMicroseconds <= 0) {
            this.startSwitchedAudioOutput(revision);
            return;
        }
        audioOutputSwitch.startTimer = globalThis.setTimeout((): void => {
            this.startSwitchedAudioOutput(revision);
        }, microsecondsToMilliseconds(delayMicroseconds));
    }

    private startSwitchedAudioOutput(revision: number): void {
        if (!this.isAudioOutputSwitchCurrent(revision)) {
            return;
        }
        const generation = this.audioOutputSwitch?.generation ?? null;
        this.clearAudioOutputSwitch();
        if (generation !== null) {
            this.releaseRetiredAudioStarvation(generation);
            this.restartAudioAfterSwitch(generation);
        }
    }

    /**
     * Resumes a clock that was waiting on the retired output's underflow. The new
     * output starts filled, so it never reports a recovery of its own.
     */
    private releaseRetiredAudioStarvation(generation: number): void {
        if (this.clockStarvation !== 'audio') {
            return;
        }
        this.clockStarvation = null;
        if (this.state === 'playing') {
            this.clock.resume();
            if (!this.waitingForVideoFrame) {
                this.emitEvent({ generation, type: 'playing' });
            }
        }
        this.clearPlaybackStarvationIfRecovered();
        this.emitTimeUpdateIfDue();
    }

    private restartAudioAfterSwitch(generation: number): void {
        if (!this.isGenerationActive(generation) || this.state !== 'playing') {
            return;
        }
        void this.setAudioPlaying(true).catch((error: unknown): void => {
            this.activateFallback(generation, 'audio-output-failed', this.getErrorMessage(error));
        });
    }

    private failAudioOutputSwitch(revision: number, message: string): void {
        if (!this.isAudioOutputSwitchCurrent(revision)) {
            return;
        }
        const generation = this.audioOutputSwitch?.generation ?? null;
        this.clearAudioOutputSwitch();
        if (generation !== null) {
            this.activateFallback(generation, 'audio-output-failed', message);
        }
    }

    private clearAudioOutputSwitch(): void {
        const audioOutputSwitch = this.audioOutputSwitch;
        if (!audioOutputSwitch) {
            return;
        }
        this.audioOutputSwitch = null;
        if (audioOutputSwitch.timeoutTimer !== null) {
            globalThis.clearTimeout(audioOutputSwitch.timeoutTimer);
        }
        if (audioOutputSwitch.startTimer !== null) {
            globalThis.clearTimeout(audioOutputSwitch.startTimer);
        }
    }

    private advanceAudioOutputSwitchRevision(): number {
        if (this.audioOutputSwitchRevision === Number.MAX_SAFE_INTEGER) {
            throw new RangeError('Custom audio output switch revision exhausted');
        }
        this.audioOutputSwitchRevision += 1;
        return this.audioOutputSwitchRevision;
    }

    private readonly handleAudioOutputDeviceChange = (): void => {
        const generation = this.activeGeneration;
        if (generation === null || this.destroyed) {
            return;
        }
        this.emitEvent({
            generation,
            maximumChannelCount: this.getAudioOutputMaximumChannelCount(),
            type: 'audio-output-changed'
        });
    };

    private readonly handleAudioOutputTelemetry = (
        telemetry: AudioWorkletTelemetry
    ): void => {
        const generation = this.activeGeneration;
        const audioOutput = this.audioOutput;
        const bridgeTelemetry = this.audioBinding?.bridge.getTelemetry();
        // A pending layout switch must not move the clock to its idle new output
        const telemetryMatchesActiveAudio = generation !== null
            && this.pendingStartup === null
            && this.audioOutputSwitch === null
            && typeof this.currentSource?.audioTrackIndex === 'number'
            && audioOutput !== null
            && this.audioBinding?.output === audioOutput
            && telemetry.generation === audioOutput.generation
            && bridgeTelemetry?.activeDecodeGeneration === generation
            && bridgeTelemetry.workletGeneration === telemetry.generation;

        if (telemetryMatchesActiveAudio) {
            this.handleActiveAudioTelemetry(telemetry, generation);
            this.completeEndedPlaybackIfDrained(generation);
        } else if (audioOutput && telemetry.generation !== audioOutput.generation) {
            this.staleEventCount += 1;
        }
        this.emitEvent({ telemetry: this.getTelemetry(), type: 'telemetry' });
    };

    private setAudioPlaying(playing: boolean): Promise<void> {
        const operations: Promise<void>[] = [];
        const audioOutput = this.audioOutput;
        // A pending layout switch starts its output itself once the new audio has filled
        if (audioOutput && !(playing && this.audioOutputSwitch)) {
            try {
                operations.push(Promise.resolve(audioOutput.setPlaying(playing)));
            } catch (error) {
                operations.push(Promise.reject(error));
            }
        }

        const setNativeAudioPlaying = this.videoDecodeSession.setNativeAudioPlaying;
        if (setNativeAudioPlaying) {
            try {
                operations.push(Promise.resolve(setNativeAudioPlaying.call(
                    this.videoDecodeSession,
                    playing
                )));
            } catch (error) {
                operations.push(Promise.reject(error));
            }
        }
        return Promise.all(operations).then((): void => undefined);
    }

    private applyOutputGain(): void {
        this.audioOutput?.setVolume(this.getOutputGain());
        this.videoDecodeSession.setNativeAudioVolume?.(this.getNativeOutputGain());
    }

    private getOutputGain(): number {
        return this.volume * this.normalizationGain;
    }

    private getNativeOutputGain(): number {
        return Math.min(this.getOutputGain(), 1);
    }

    private handleActiveAudioTelemetry(
        telemetry: AudioWorkletTelemetry,
        generation: number
    ): void {
        switch (telemetry.reason) {
            case 'underflow':
                this.handleAudioUnderflow(telemetry, generation);
                return;
            case 'underflow-recovered':
                this.handleAudioUnderflowRecovery(telemetry, generation);
                return;
            case 'periodic':
                if (
                    telemetry.hasPhysicalOutputTimeCorrelation
                    && this.state === 'playing'
                    && this.clockStarvation === null
                    && !(this.pendingEndedGeneration === generation
                        && this.terminalAudioTailReleased)
                ) {
                    this.clock.synchronize(telemetry.mediaTimeMicroseconds);
                    this.emitTimeUpdateIfDue();
                }
                return;
            case 'enqueue':
            case 'flush':
            case 'overflow':
            case 'stale-generation':
                return;
        }
    }

    private handleAudioUnderflow(
        telemetry: AudioWorkletTelemetry,
        generation: number
    ): void {
        if (this.state !== 'playing' || this.clockStarvation === 'audio') {
            return;
        }

        const terminalAudioTail = this.getTerminalAudioTailFromUnderflow(
            telemetry,
            generation
        );
        if (terminalAudioTail) {
            this.updateTerminalAudioDrain(generation, terminalAudioTail);
            this.emitTimeUpdateIfDue();
            return;
        }

        const playbackWasWaiting = this.hasActivePlaybackWait();
        if (telemetry.hasPhysicalOutputTimeCorrelation) {
            this.clock.synchronize(telemetry.mediaTimeMicroseconds);
        }
        if (!this.clock.isPaused) {
            this.clock.pause();
        }
        this.clockStarvation = 'audio';
        if (!playbackWasWaiting) {
            this.playbackStarvationStartedAtMicroseconds = this.readMonotonicTime();
        }
        if (!playbackWasWaiting) {
            this.emitEvent({ generation, reason: 'audio-buffer', type: 'waiting' });
        }
        this.emitTimeUpdateIfDue();
    }

    private handleAudioUnderflowRecovery(
        telemetry: AudioWorkletTelemetry,
        generation: number
    ): void {
        if (this.clockStarvation === 'audio') {
            this.clockStarvation = null;
            if (this.state === 'playing') {
                if (telemetry.hasPhysicalOutputTimeCorrelation) {
                    this.clock.synchronize(telemetry.mediaTimeMicroseconds);
                }
                this.clock.resume();
                if (!this.waitingForVideoFrame) {
                    this.emitEvent({ generation, type: 'playing' });
                }
            }
        } else if (
            telemetry.hasPhysicalOutputTimeCorrelation
            && this.state === 'playing'
            && this.clockStarvation === null
        ) {
            this.clock.synchronize(telemetry.mediaTimeMicroseconds);
        }
        this.clearPlaybackStarvationIfRecovered();
        this.emitTimeUpdateIfDue();
    }

    private handleMissingVideoFrame(generation: number): void {
        if (this.hasVideoTrackEnded()) {
            this.videoFrameMissStartedAtMicroseconds = null;
            this.endVideoFrameWait(generation);
            return;
        }

        const decodeTelemetry = this.videoDecodeSession.getTelemetry();
        if (
            decodeTelemetry.queuedFrameCount > 0
            || decodeTelemetry.pendingFrameCount > 0
            || this.pendingPresentationFrames.size > 0
            || this.pendingEndedGeneration === generation
        ) {
            this.videoFrameMissStartedAtMicroseconds = null;
            return;
        }

        const monotonicTimeMicroseconds = this.readMonotonicTime();
        if (this.videoFrameMissStartedAtMicroseconds === null) {
            this.videoFrameMissStartedAtMicroseconds = monotonicTimeMicroseconds;
            return;
        }
        const missDurationMicroseconds = monotonicTimeMicroseconds
            - this.videoFrameMissStartedAtMicroseconds;
        if (missDurationMicroseconds < 0) {
            throw new RangeError('Monotonic time moved backwards while waiting for a video frame');
        }
        if (
            missDurationMicroseconds
                < DEFAULT_CUSTOM_PLAYBACK_VIDEO_STARVATION_GRACE_MICROSECONDS
            || this.waitingForVideoFrame
        ) {
            return;
        }

        this.beginVideoFrameWait(generation, monotonicTimeMicroseconds);
    }

    private handleStaleVideoFrame(
        generation: number,
        videoDecodeLag: CustomPlaybackVideoDecodeLagTelemetry
    ): void {
        this.lastVideoDecodeLag = { ...videoDecodeLag };
        this.discardedStaleVideoFrameCount += 1;
        this.videoDecodeLagWaitActive = true;
        this.videoFrameMissStartedAtMicroseconds = null;
        this.beginVideoFrameWait(generation, this.readMonotonicTime());
    }

    private handleExcessivelyLaggingVideoFrame(
        presentationFrame: DecodedPresentationFrame,
        targetTimeMicroseconds: Microseconds,
        generation: number
    ): boolean {
        const videoDecodeLag = this.getExcessiveVideoDecodeLag(
            presentationFrame,
            targetTimeMicroseconds,
            generation
        );
        if (!videoDecodeLag) {
            return false;
        }
        // Seek preroll and a delayed RAF can each produce one stale frame
        // Release its decode credit and apply the bounded starvation policy
        if (!this.discardStaleVideoFrame(presentationFrame)) {
            this.activateFallback(
                generation,
                'lifecycle-failed',
                'A stale custom video frame could not be released'
            );
            return true;
        }

        this.handleStaleVideoFrame(generation, videoDecodeLag);
        this.emitTimeUpdateIfDue();
        this.completeEndedPlaybackIfDrained(generation);
        return true;
    }

    private beginVideoFrameWait(
        generation: number,
        monotonicTimeMicroseconds: Microseconds
    ): void {
        if (this.hasVideoTrackEnded()) {
            return;
        }

        const playbackWasWaiting = this.hasActivePlaybackWait();
        this.beginVideoStarvationIfNeeded();
        this.waitingForVideoFrame = true;
        if (playbackWasWaiting || this.state !== 'playing') {
            return;
        }

        this.playbackStarvationStartedAtMicroseconds = monotonicTimeMicroseconds;
        this.emitEvent({
            generation,
            reason: 'video-frame',
            type: 'waiting'
        });
    }

    /** Ends a video-frame wait because a frame arrived or the video track ended. */
    private endVideoFrameWait(generation: number): void {
        if (this.waitingForVideoFrame) {
            this.waitingForVideoFrame = false;
            if (this.state === 'playing' && this.clockStarvation === null) {
                this.emitEvent({ generation, type: 'playing' });
            }
        }
        this.clearPlaybackStarvationIfRecovered();
    }

    /** Audio can outlast the video track, which then holds its last frame instead of waiting. */
    private hasVideoTrackEnded(): boolean {
        return typeof this.currentSource?.audioTrackIndex === 'number'
            && this.videoDecodeSession.getTelemetry().videoEnded;
    }

    private hasActivePlaybackWait(): boolean {
        return this.clockStarvation !== null || this.waitingForVideoFrame;
    }

    private hasPlaybackStallExceeded(generation: number): boolean {
        const starvationStartedAtMicroseconds = this.playbackStarvationStartedAtMicroseconds;
        if (starvationStartedAtMicroseconds === null || !this.hasActivePlaybackWait()) {
            return false;
        }

        const starvationDurationMicroseconds = this.readMonotonicTime()
            - starvationStartedAtMicroseconds;
        if (starvationDurationMicroseconds < 0) {
            throw new RangeError('Monotonic time moved backwards during playback starvation');
        }
        if (starvationDurationMicroseconds < this.playbackStallTimeoutMicroseconds) {
            return false;
        }

        this.activateFallback(
            generation,
            'playback-stalled',
            this.getPlaybackStallMessage(generation)
        );
        return true;
    }

    private getPlaybackStallMessage(generation: number): string {
        const videoDecodeLag = this.lastVideoDecodeLag;
        if (!this.videoDecodeLagWaitActive
            || !videoDecodeLag
            || videoDecodeLag.generation !== generation) {
            return 'Custom playback remained starved beyond its bounded timeout';
        }

        return 'Custom video decoding remained behind the playback clock'
            + `: target ${videoDecodeLag.targetTimeMicroseconds} microseconds`
            + `, stale frame end ${videoDecodeLag.frameEndTimeMicroseconds} microseconds`
            + `, gap ${videoDecodeLag.gapMicroseconds} microseconds`
            + `, post-seek ${videoDecodeLag.postSeek}`;
    }

    private getExcessiveVideoDecodeLag(
        presentationFrame: DecodedPresentationFrame,
        targetTimeMicroseconds: Microseconds,
        generation: number
    ): CustomPlaybackVideoDecodeLagTelemetry | null {
        const frameEndMicroseconds = addMicroseconds(
            presentationFrame.mediaTimeMicroseconds,
            presentationFrame.durationMicroseconds > 0 ?
                presentationFrame.durationMicroseconds :
                ZERO_MICROSECONDS
        );
        const gapMicroseconds = requireMicroseconds(
            targetTimeMicroseconds - frameEndMicroseconds,
            'Video decode lag'
        );
        if (gapMicroseconds <= this.maximumVideoDecodeLagMicroseconds) {
            return null;
        }

        return {
            frameEndTimeMicroseconds: frameEndMicroseconds,
            gapMicroseconds,
            generation,
            postSeek: this.awaitingPostSeekVideoFrame,
            targetTimeMicroseconds
        };
    }

    private discardStaleVideoFrame(
        presentationFrame: DecodedPresentationFrame
    ): boolean {
        let released = false;
        try {
            released = this.videoDecodeSession.discardFrame(presentationFrame);
        } catch {
            released = false;
        } finally {
            if (presentationFrame.outputMode === 'video-frame') {
                try {
                    presentationFrame.frame.close();
                } catch {
                    // Ownership still ends if a platform close implementation throws
                }
            }
        }
        return released;
    }

    private clearPlaybackStarvationIfRecovered(): void {
        if (!this.hasActivePlaybackWait()) {
            this.playbackStarvationStartedAtMicroseconds = null;
        }
    }

    /**
     * Only audio-clocked native decode is released while hidden.
     * Software decoders keep draining because a keyframe resync is costly for them.
     * An ended video track has already released its decoder.
     */
    private canSuspendBackgroundVideo(): boolean {
        return typeof this.currentSource?.audioTrackIndex === 'number'
            && this.currentSource.videoDecoderBackend === 'native'
            && !this.videoDecodeSession.getTelemetry().videoEnded;
    }

    /** Reports whether the newest decoded frame ends more than the tolerance before the target. */
    private isVideoDecodeBehind(
        targetTimeMicroseconds: Microseconds,
        toleranceMicroseconds: Microseconds
    ): boolean {
        const lastFrameEndMediaTimeMicroseconds =
            this.videoDecodeSession.getTelemetry().lastFrameEndMediaTimeMicroseconds;
        return lastFrameEndMediaTimeMicroseconds !== null
            && targetTimeMicroseconds - lastFrameEndMediaTimeMicroseconds > toleranceMicroseconds;
    }

    /** Restarts video alone at the target while audio and the clock continue. */
    private requestVideoResync(targetTimeMicroseconds: Microseconds): boolean {
        this.videoSuspended = false;
        if (!this.videoDecodeSession.resyncVideo?.(targetTimeMicroseconds)) {
            return false;
        }

        this.videoCatchUpActive = true;
        this.videoResyncPending = true;
        this.awaitingPostSeekVideoFrame = true;
        this.videoDecodeLagWaitActive = false;
        this.videoFrameMissStartedAtMicroseconds = null;
        return true;
    }

    /**
     * Drops a frame the clock already passed while video catches up after a hidden
     * period, so the backlog is skipped instead of shown fast-forward.
     */
    private discardLateCatchUpFrame(
        presentationFrame: DecodedPresentationFrame,
        targetTimeMicroseconds: Microseconds,
        generation: number
    ): boolean {
        if (!this.videoCatchUpActive) {
            return false;
        }

        const frameEndMicroseconds = addMicroseconds(
            presentationFrame.mediaTimeMicroseconds,
            presentationFrame.durationMicroseconds > 0 ?
                presentationFrame.durationMicroseconds :
                ZERO_MICROSECONDS
        );
        if (targetTimeMicroseconds - frameEndMicroseconds
            <= CUSTOM_PLAYBACK_VIDEO_CATCH_UP_TOLERANCE_MICROSECONDS) {
            this.videoCatchUpActive = false;
            return false;
        }
        if (!this.discardStaleVideoFrame(presentationFrame)) {
            this.activateFallback(
                generation,
                'lifecycle-failed',
                'A late custom video frame could not be released'
            );
            return true;
        }

        this.discardedStaleVideoFrameCount += 1;
        this.videoFrameMissStartedAtMicroseconds = null;
        // The bounded stall timeout still limits a decoder that cannot catch up
        this.beginVideoFrameWait(generation, this.readMonotonicTime());
        this.emitTimeUpdateIfDue();
        this.completeEndedPlaybackIfDrained(generation);
        return true;
    }

    private beginVideoStarvationIfNeeded(): void {
        if (this.clockStarvation !== null
            || typeof this.currentSource?.audioTrackIndex === 'number') {
            return;
        }

        if (!this.clock.isPaused) {
            this.clock.pause();
        }
        this.clockStarvation = 'video';
        this.videoStarvationAnchorMediaTimeMicroseconds = this.currentTimeMicroseconds;
        this.videoStarvationAnchorMonotonicTimeMicroseconds = this.readMonotonicTime();
    }

    private recoverVideoStarvation(presentationFrame: DecodedPresentationFrame): void {
        if (this.clockStarvation !== 'video') {
            return;
        }

        this.clock.synchronize(presentationFrame.mediaTimeMicroseconds);
        this.clockStarvation = null;
        this.videoStarvationAnchorMediaTimeMicroseconds = null;
        this.videoStarvationAnchorMonotonicTimeMicroseconds = null;
        if (this.state === 'playing') {
            this.clock.resume();
        }
    }

    private getCurrentPresentationTargetTime(): Microseconds {
        if (this.clockStarvation !== 'video'
            || this.state !== 'playing'
            || this.videoStarvationAnchorMediaTimeMicroseconds === null
            || this.videoStarvationAnchorMonotonicTimeMicroseconds === null) {
            return this.currentTimeMicroseconds;
        }

        const monotonicTimeMicroseconds = this.readMonotonicTime();
        const elapsedMicroseconds = monotonicTimeMicroseconds
            - this.videoStarvationAnchorMonotonicTimeMicroseconds;
        if (elapsedMicroseconds < 0) {
            throw new RangeError('Monotonic time moved backwards during video starvation');
        }
        const scaledElapsedMicroseconds = requireMicroseconds(
            Math.round(elapsedMicroseconds * this.clock.rate),
            'Video starvation elapsed time'
        );
        return addMicroseconds(
            this.videoStarvationAnchorMediaTimeMicroseconds,
            scaledElapsedMicroseconds
        );
    }

    private emitTimeUpdateIfDue(): void {
        if (this.activeGeneration === null) {
            return;
        }

        const monotonicTimeMicroseconds = this.readMonotonicTime();
        if (this.lastTimeUpdateMonotonicMicroseconds !== null
            && monotonicTimeMicroseconds - this.lastTimeUpdateMonotonicMicroseconds
                < this.timeUpdateIntervalMicroseconds) {
            return;
        }
        this.lastTimeUpdateMonotonicMicroseconds = monotonicTimeMicroseconds;
        this.emitEvent({
            currentTimeMicroseconds: this.currentTimeMicroseconds,
            durationMicroseconds: this.durationMicroseconds,
            generation: this.activeGeneration,
            type: 'timeupdate'
        });
    }

    private async stopController(): Promise<void> {
        const stoppedGeneration = this.activeGeneration;
        const controlGeneration = this.advanceGeneration();
        this.clearAudioOutputSwitch();
        this.activeGeneration = null;
        this.nativeAudioClockGeneration = null;
        this.nativeAudioClockTimeMicroseconds = null;
        this.resetDrainAndStarvationState();
        if (stoppedGeneration !== null) {
            this.settlePendingStartup({
                fallbackReason: null,
                generation: stoppedGeneration,
                status: 'stopped'
            });
        }
        this.setState('stopping', controlGeneration);
        const audioStopPromise = this.setAudioPlaying(false).catch((error: unknown): void => {
            this.lastErrorMessage = this.getErrorMessage(error);
        });
        this.clock.reset(ZERO_MICROSECONDS);

        return this.waitBounded(
            Promise.all([
                audioStopPromise,
                this.stopDecodePipelines()
            ]),
            'Custom playback shutdown exceeded its bound'
        ).catch((error: unknown): void => {
            this.lastErrorMessage = this.getErrorMessage(error);
        }).then((): void => {
            if (this.currentGeneration === controlGeneration) {
                this.currentSource = null;
                this.audioPath = 'disabled';
                this.waitingForVideoFrame = false;
                this.setState('idle', controlGeneration);
            }
        });
    }

    private stopDecodePipelines(): Promise<void> {
        return this.videoDecodeSession.stop();
    }

    private async destroyAudioResources(): Promise<void> {
        const outputs = new Set<CustomAudioOutput>();
        if (this.audioOutput) {
            outputs.add(this.audioOutput);
        }
        if (this.audioBinding) {
            outputs.add(this.audioBinding.output);
        }

        this.audioTelemetryUnsubscribe?.();
        this.audioTelemetryUnsubscribe = null;
        this.audioOutputDeviceUnsubscribe?.();
        this.audioOutputDeviceUnsubscribe = null;
        this.clearAudioOutputSwitch();
        const pendingOutputPromise = this.audioOutputPromise;
        this.advanceAudioOutputCreationRevision();
        this.audioBinding = null;
        this.audioOutput = null;
        this.audioOutputPromise = null;
        this.audioOutputPromiseConfiguration = null;
        if (pendingOutputPromise) {
            // A browser factory may never settle; creation revisioning makes a
            // late result self-dispose without blocking stop or replacement
            void pendingOutputPromise.then(
                (binding: CustomAudioOutputBinding): Promise<void> | void => {
                    if (!outputs.has(binding.output)) {
                        return this.destroyAudioOutput(binding.output);
                    }
                },
                (): void => undefined
            );
        }

        const destroyPromises: Promise<void>[] = [];
        for (const output of outputs) {
            destroyPromises.push(this.destroyAudioOutput(output));
        }
        await Promise.all(destroyPromises);
    }

    private async destroyAudioOutput(output: CustomAudioOutput): Promise<void> {
        try {
            await this.waitBounded(
                Promise.resolve(output.destroy()),
                'Custom audio output destruction exceeded its bound'
            );
        } catch (error) {
            const message = this.getErrorMessage(error);
            this.lastErrorMessage = this.lastErrorMessage ?
                `${this.lastErrorMessage}; ${message}` :
                message;
        }
    }

    private waitBounded<Result>(
        promise: PromiseLike<Result>,
        timeoutMessage: string,
        timeoutMicroseconds: Microseconds = this.pipelineStopTimeoutMicroseconds
    ): Promise<Result> {
        requirePositiveTimeout(timeoutMicroseconds, 'Operation timeout');
        return new Promise<Result>((resolve, reject) => {
            let settled = false;
            const timer = globalThis.setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                reject(new Error(timeoutMessage));
            }, microsecondsToMilliseconds(timeoutMicroseconds));
            Promise.resolve(promise).then(
                (result: Result): void => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    globalThis.clearTimeout(timer);
                    resolve(result);
                },
                (error: unknown): void => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    globalThis.clearTimeout(timer);
                    reject(error);
                }
            );
        });
    }

    private supersedePendingStartup(): void {
        const pendingStartup = this.pendingStartup;
        if (!pendingStartup) {
            return;
        }
        this.settlePendingStartup({
            fallbackReason: null,
            generation: pendingStartup.generation,
            status: 'superseded'
        });
    }

    private isPendingStartupActive(pendingStartup: PendingStartup): boolean {
        return this.pendingStartup === pendingStartup
            && !pendingStartup.settled
            && this.isGenerationActive(pendingStartup.generation);
    }

    private resetDrainAndStarvationState(): void {
        this.pendingEndedGeneration = null;
        this.lastDrainedVideoFrameEndTimeMicroseconds = null;
        this.pendingPresentationFrames.clear();
        this.clockStarvation = null;
        this.playbackStarvationStartedAtMicroseconds = null;
        this.videoDecodeLagWaitActive = false;
        this.videoFrameMissStartedAtMicroseconds = null;
        this.videoStarvationAnchorMediaTimeMicroseconds = null;
        this.videoStarvationAnchorMonotonicTimeMicroseconds = null;
        this.waitingForVideoFrame = false;
        this.terminalAudioDrainDeadlineMicroseconds = null;
        this.terminalAudioDrainGeneration = null;
        this.terminalAudioTailReleased = false;
        this.videoCatchUpActive = false;
        this.videoResyncPending = false;
        this.videoSuspended = false;
    }

    private settlePendingStartup(result: CustomPlaybackStartResult): void {
        const pendingStartup = this.pendingStartup;
        if (!pendingStartup
            || pendingStartup.generation !== result.generation
            || pendingStartup.settled) {
            return;
        }

        pendingStartup.settled = true;
        globalThis.clearTimeout(pendingStartup.timer);
        this.pendingStartup = null;
        pendingStartup.resolve(result);
    }

    private setState(state: CustomPlaybackState, generation: number): void {
        if (this.state === state) {
            return;
        }

        const previousState = this.state;
        this.state = state;
        this.emitEvent({ generation, previousState, state, type: 'statechange' });
    }

    private emitEvent(event: CustomPlaybackControllerEvent): void {
        try {
            this.eventHandler(event);
        } catch (error) {
            console.warn('Custom playback controller event handler failed', error);
        }
    }

    private readMonotonicTime(): Microseconds {
        return requireMicroseconds(this.monotonicTimeSource(), 'Monotonic time');
    }

    private advanceGeneration(): number {
        if (this.currentGeneration === Number.MAX_SAFE_INTEGER) {
            throw new RangeError('Custom playback generation exhausted');
        }
        this.currentGeneration += 1;
        return this.currentGeneration;
    }

    private advanceAudioOutputCreationRevision(): number {
        if (this.audioOutputCreationRevision === Number.MAX_SAFE_INTEGER) {
            throw new RangeError('Custom audio output creation revision exhausted');
        }
        this.audioOutputCreationRevision += 1;
        return this.audioOutputCreationRevision;
    }

    private isGenerationActive(generation: number): boolean {
        return this.activeGeneration === generation && !this.destroyed;
    }

    private requireActiveGeneration(): number {
        if (this.activeGeneration === null) {
            throw new Error('Custom playback has no active generation');
        }
        return this.activeGeneration;
    }

    private requireUsable(): void {
        if (this.destroyed) {
            throw new Error('Custom playback controller is destroyed');
        }
    }

    private getErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
