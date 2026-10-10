import { createEngineWorker } from '../EngineAssets';
import type { Microseconds } from '../MediaTime';
import { ingestWorkerTimingEvents, isTimingTraceActive, recordTimingEvent } from '../TimingTrace';
import type { DecodedPresentationFrame } from '../presentation/WebGPUPresenter';
import type CustomDecodeAudioBridge from '../audio/output/CustomDecodeAudioBridge';
import type CustomDecodeNativeAudioBridge from '../audio/native/CustomDecodeNativeAudioBridge';
import type { CustomAudioOutputChannelCount } from '../audio/processing/CustomAudioChannelLayout';
import {
    assertValidAudioDownmixSettings,
    type AudioDownmixSettings
} from '../audio/processing/CustomAudioDownmix';
import {
    isCustomAudioDownmixAlgorithm,
    type CustomAudioDownmixAlgorithm
} from '../audio/processing/CustomAudioDownmixAlgorithm';
import {
    DecodedVideoGeometryError,
    exceedsNegotiatedCodedSize,
    requireConsistentDecodedVideoGeometry
} from '../video/DecodedVideoGeometry';
import { resolveDolbyVisionRPUParserWASMURL } from '../video/dolby-vision/DolbyVisionRPUParser';
import {
    addMicroseconds,
    audioFramesToMicroseconds,
    requireMicroseconds
} from '../TimeMath';
import {
    getDolbyVisionRawFrameLayerCount,
    isDecodeWorkerResponse,
    isDolbyVisionProfile,
    isRawVideoFrameFormat,
    MAX_DECODED_FRAME_CREDITS,
    MAX_DECODED_RAW_FRAME_CREDITS,
    type CustomDecodeFailureKind,
    type CustomDecodeAudioOutputMode,
    type CustomDecodeDolbyVisionProfile,
    type CustomDecodeNativeHDRTransfer,
    type CustomDecodeWorkerProgressPhase,
    type CustomDecodeRawVideoFrameFormat,
    type CustomDecodeVideoDecoderBackend,
    type CustomDecodeVideoOutputMode,
    type DecodeWorkerAudioConfiguration,
    type DecodeWorkerAudioEndedResponse,
    type DecodeWorkerAudioOutputAttachment,
    type DecodeWorkerAudioProgressResponse,
    type DecodeWorkerAudioSourceFormatResponse,
    type DecodeWorkerFrameResponse,
    type DecodeWorkerReadyResponse,
    type DecodeWorkerNativeAudioInitializationResponse,
    type DecodeWorkerNativeAudioMediaResponse,
    type DecodeWorkerNativeMediaAudioConfiguration,
    type DecodeWorkerReadyAudioConfiguration,
    type DecodeWorkerRequest,
    type DecodeWorkerResponse,
    type DecodeWorkerResyncAudioRequest,
    type DecodeWorkerStartRequest,
    type DecodeWorkerStoppedResponse,
    type DecodeWorkerVideoEndedResponse,
    type DecodeWorkerVideoInterruptedResponse,
    type DecodeWorkerVideoInterruptionReason
} from './DecodeWorkerProtocol';
import {
    hasRawVideoFrameCopyLayout,
    type RawVideoFrameGeometry
} from '../video/RawVideoFrameCopy';
import type {
    StaticHDRMetadata,
    StaticHDRMetadataScanStatus
} from '../video/hdr/StaticHDRMetadata';

const WORKER_STOP_TIMEOUT_MILLISECONDS = 1_000;
const MINIMUM_DECODED_AUDIO_STARTUP_BUFFER_MICROSECONDS = 100_000;
const FRAME_QUEUE_BOUND_FAILURE = 'The custom decode frame queue exceeded its bound';
const UNEXPECTED_FRAME_OUTPUT_MODE_FAILURE = 'The custom decode worker returned an unexpected video output mode';

export type CustomDecodeSessionStartOptions = {
    audioDownmixAlgorithm?: CustomAudioDownmixAlgorithm
    audioDownmixSettings?: AudioDownmixSettings
    audioOutputMode?: CustomDecodeAudioOutputMode
    audioTrackIndex?: number | null
    decodedAudioOutputChannelCount?: CustomAudioOutputChannelCount
    discardDolbyVisionEnhancementLayer?: boolean
    durationMicroseconds?: Microseconds | null
    dolbyVisionProfile: CustomDecodeDolbyVisionProfile
    generation: number
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

export type CustomDecodeAudioResyncOptions = {
    audioDownmixAlgorithm?: CustomAudioDownmixAlgorithm
    audioDownmixSettings?: AudioDownmixSettings
    /** Builds the output for the new layout after the previous bridge has stopped */
    createAudioBridge: (audioConfiguration: DecodeWorkerAudioConfiguration) => Promise<CustomDecodeAudioBridge>
    decodedAudioOutputChannelCount: CustomAudioOutputChannelCount
    targetTimeMicroseconds: Microseconds
};

export type CustomDecodeSessionEvent =
    | {
        generation: number
        type: 'audio-ended'
    }
    | {
        audioEpoch: number
        generation: number
        type: 'audio-resynced'
    }
    | {
        audio: DecodeWorkerReadyAudioConfiguration | null
        codec: string
        generation: number
        staticHDRMetadata?: StaticHDRMetadata
        type: 'configured'
    }
    | {
        audio: DecodeWorkerReadyAudioConfiguration | null
        codec: string
        /** The container's duration, present only when the server reported none */
        containerDurationMicroseconds?: Microseconds
        generation: number
        staticHDRMetadata?: StaticHDRMetadata
        type: 'ready'
    }
    | {
        failureKind: CustomDecodeFailureKind
        generation: number
        message: string
        type: 'error'
    }
    | {
        generation: number
        type: 'ended'
    }
    | {
        generation: number
        reason: DecodeWorkerVideoInterruptionReason
        type: 'video-interrupted'
    };

export type CustomDecodeSessionTelemetry = {
    activeGeneration: number | null
    abandonedRawFrameCount: number
    audioChannelCount: number | null
    audioCodec: string | null
    /** The current audio epoch reached the end of its track; video may still continue */
    audioEnded: boolean
    /** The current decoded audio attempt; samples from earlier epochs are stale */
    audioEpoch: number
    audioResyncCount: number
    /** A resynced audio epoch has not yet buffered its startup minimum */
    audioResyncPending: boolean
    audioSampleRate: number | null
    /** The decoded channel count once audio binds, else the declared one */
    audioSourceChannelCount: number | null
    /** The decoded rate once audio binds, else the declared one */
    audioSourceSampleRate: number | null
    /** The channel count the audio decoder produces, null until the first decoded output */
    decodedAudioSourceChannelCount: number | null
    droppedFrameCount: number
    failureKind: CustomDecodeFailureKind | null
    firstFrameMediaTimeMicroseconds: Microseconds | null
    lastAudioMediaTimeMicroseconds: Microseconds | null
    lastFrameEndMediaTimeMicroseconds: Microseconds | null
    lastFrameMediaTimeMicroseconds: Microseconds | null
    nativeAudioClockReady: boolean
    /** The native audio element played to the end of its media and no longer drives the clock */
    nativeAudioEnded: boolean
    peakFrameCount: number
    pendingFrameCount: number
    queuedFrameCount: number
    receivedAudioFrameCount: number
    receivedAudioSampleCount: number
    receivedDolbyVisionEnhancementFrameCount: number
    receivedDolbyVisionFrameCount: number
    receivedDolbyVisionRPUCount: number
    receivedHDR10PlusAbsentFrameCount: number
    receivedHDR10PlusConflictingFrameCount: number
    receivedHDR10PlusMalformedFrameCount: number
    receivedHDR10PlusUnsupportedFrameCount: number
    receivedHDR10PlusValidFrameCount: number
    receivedNativeAudioSegmentCount: number
    receivedFrameCount: number
    recycledRawFrameCount: number
    staleAudioSampleCount: number
    staleFrameCount: number
    state: 'configured' | 'ended' | 'error' | 'idle' | 'ready' | 'starting'
    staticHDRMetadataFirstAccessUnitIndex: number | null
    staticHDRMetadataScanAccessUnitCount: number
    staticHDRMetadataStatus: StaticHDRMetadataScanStatus | null
    submittedAudioFrameCount: number
    submittedAudioSampleCount: number
    submittedVideoPacketCount: number
    takenFrameCount: number
    /** The current video epoch reached the end of its track; no more frames arrive */
    videoEnded: boolean
    videoEpoch: number
    videoProgressPhase: CustomDecodeWorkerProgressPhase | null
    videoResyncCount: number
    videoSuspensionCount: number
    /** The current generation runs in the worker an earlier generation used */
    workerReused: boolean
};

export type CustomDecodeSessionEventHandler = (event: CustomDecodeSessionEvent) => void;
export type CustomDecodeWorkerFactory = () => Worker;
export type CustomDecodeAudioBridgeFactory = (
    audioConfiguration: DecodeWorkerAudioConfiguration
) => CustomDecodeAudioBridge | Promise<CustomDecodeAudioBridge>;
export type CustomDecodeNativeAudioBridgeFactory = () => CustomDecodeNativeAudioBridge;

type QueuedFrame = {
    generationRecord: GenerationRecord
    presentationFrame: DecodedPresentationFrame
};

/** The session's decode worker, which runs one generation at a time and outlives each of them. */
type WorkerRecord = {
    errorHandler: (event: ErrorEvent) => void
    /** A generation's start already reached the worker */
    hasRunGeneration: boolean
    messageHandler: (event: MessageEvent<unknown>) => void
    /** Runs no further generation: a run failed or broke the protocol, or the worker asked for it */
    replacementRequired: boolean
    /** The generation whose run the worker holds until it posts `stopped`; null while it is idle */
    runningGeneration: GenerationRecord | null
    /** Bounds the acknowledgement of a run the session asked to stop */
    stopTimer: ReturnType<typeof globalThis.setTimeout> | null
    terminated: boolean
    /** Mediabunny keeps the decoders a backend registers for the worker's life, so another backend gets a new worker */
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
    worker: Worker
};

/** One decode generation: its run in the worker, and the credits, epochs, readiness, and audio paths the page keeps for it. */
type GenerationRecord = {
    audioConfiguration: DecodeWorkerReadyAudioConfiguration | null
    /** Latest requested audio attempt; samples from earlier epochs are stale */
    audioEpoch: number
    audioEpochSubmittedFrameCount: number
    audioMediaReady: boolean
    audioResyncPending: boolean
    audioOutputMode: CustomDecodeAudioOutputMode
    audioRequested: boolean
    /** The current audio epoch reached the end of its track */
    audioTrackEnded: boolean
    configurationReceived: boolean
    /** The worker posted 'ended': both streams finished */
    decodeEnded: boolean
    decodedAudioOutputChannelCount: CustomAudioOutputChannelCount | null
    decodedVideoGeometry: RawVideoFrameGeometry | null
    generation: number
    maximumCodedHeight: number
    maximumCodedWidth: number
    nativeAudioBridgeStarted: boolean
    nativeAudioElementEnded: boolean
    nativeAudioEndOfStreamAccepted: boolean
    nativeAudioEndOfStreamRequested: boolean
    resolveRetirement: () => void
    /** Settles once the run posted `stopped` or its worker was terminated */
    retirementPromise: Promise<void>
    /** The run is over, or its start never reached a worker */
    runStopped: boolean
    startRequest: DecodeWorkerStartRequest
    startTimeMicroseconds: Microseconds
    /** The session posted `stop` for the run */
    stopRequested: boolean
    durationMicroseconds: Microseconds | null
    videoGeometry: RawVideoFrameGeometry | null
    videoCodec: string | null
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
    /** Latest requested video attempt; frames from earlier epochs are stale */
    videoEpoch: number
    videoMediaReady: boolean
    videoOutputMode: CustomDecodeVideoOutputMode
    staticHDRMetadata: StaticHDRMetadata | null
    /** The container's duration, reported only for a source the server never probed */
    containerDurationMicroseconds: Microseconds | null
    /** The worker that took the generation's start; null while the start waits for a free worker */
    workerRecord: WorkerRecord | null
};

function createTelemetry(): CustomDecodeSessionTelemetry {
    return {
        activeGeneration: null,
        abandonedRawFrameCount: 0,
        audioChannelCount: null,
        audioCodec: null,
        audioEnded: false,
        audioEpoch: 0,
        audioResyncCount: 0,
        audioResyncPending: false,
        audioSampleRate: null,
        audioSourceChannelCount: null,
        audioSourceSampleRate: null,
        decodedAudioSourceChannelCount: null,
        droppedFrameCount: 0,
        failureKind: null,
        firstFrameMediaTimeMicroseconds: null,
        lastAudioMediaTimeMicroseconds: null,
        lastFrameEndMediaTimeMicroseconds: null,
        lastFrameMediaTimeMicroseconds: null,
        nativeAudioClockReady: false,
        nativeAudioEnded: false,
        peakFrameCount: 0,
        pendingFrameCount: 0,
        queuedFrameCount: 0,
        receivedAudioFrameCount: 0,
        receivedAudioSampleCount: 0,
        receivedDolbyVisionEnhancementFrameCount: 0,
        receivedDolbyVisionFrameCount: 0,
        receivedDolbyVisionRPUCount: 0,
        receivedHDR10PlusAbsentFrameCount: 0,
        receivedHDR10PlusConflictingFrameCount: 0,
        receivedHDR10PlusMalformedFrameCount: 0,
        receivedHDR10PlusUnsupportedFrameCount: 0,
        receivedHDR10PlusValidFrameCount: 0,
        receivedNativeAudioSegmentCount: 0,
        receivedFrameCount: 0,
        recycledRawFrameCount: 0,
        staleAudioSampleCount: 0,
        staleFrameCount: 0,
        state: 'idle',
        staticHDRMetadataFirstAccessUnitIndex: null,
        staticHDRMetadataScanAccessUnitCount: 0,
        staticHDRMetadataStatus: null,
        submittedAudioFrameCount: 0,
        submittedAudioSampleCount: 0,
        submittedVideoPacketCount: 0,
        takenFrameCount: 0,
        videoEnded: false,
        videoEpoch: 0,
        videoProgressPhase: null,
        videoResyncCount: 0,
        videoSuspensionCount: 0,
        workerReused: false
    };
}

function createDefaultWorker(): Worker {
    return createEngineWorker('webgpu-player/CustomDecode.worker.js');
}

function isValidGeneration(generation: number): boolean {
    return Number.isSafeInteger(generation) && generation > 0;
}

function isValidCodedDimension(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

function isValidTrackIndex(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

function isValidOptionalTrackIndex(value: number | null | undefined): boolean {
    return value == null || isValidTrackIndex(value);
}

function isValidVideoOutputMode(value: string): value is CustomDecodeVideoOutputMode {
    return value === 'raw-planes' || value === 'video-frame';
}

function isValidVideoDecoderBackend(value: string): value is CustomDecodeVideoDecoderBackend {
    return value === 'bundled-hevc' || value === 'ffmpeg-mpeg2-vc1' || value === 'native' || value === 'openjpeg';
}

function isNativeMediaAudioConfiguration(
    configuration: DecodeWorkerReadyAudioConfiguration
): configuration is DecodeWorkerNativeMediaAudioConfiguration {
    return 'outputMode' in configuration && configuration.outputMode === 'native-media';
}

function hasValidRawVideoFrameFormat(options: CustomDecodeSessionStartOptions): boolean {
    switch (options.videoOutputMode) {
        case 'raw-planes':
            return isRawVideoFrameFormat(options.rawVideoFrameFormat);
        case 'video-frame':
            return options.rawVideoFrameFormat === null;
    }
}

function validateRawVideoFrameCopyLayout(options: CustomDecodeSessionStartOptions): void {
    if (options.videoOutputMode !== 'raw-planes') {
        return;
    }

    const rawVideoFrameFormat = options.rawVideoFrameFormat;
    if (rawVideoFrameFormat === null || !hasRawVideoFrameCopyLayout({
        codedHeight: options.maximumCodedHeight,
        codedWidth: options.maximumCodedWidth,
        displayHeight: options.maximumCodedHeight,
        displayWidth: options.maximumCodedWidth
    }, rawVideoFrameFormat, getDolbyVisionRawFrameLayerCount(options.dolbyVisionProfile))) {
        throw new RangeError('Custom decode raw-frame route has no representable copy layout');
    }
}

function closeFrameFromUnknownMessage(value: unknown): void {
    if (!value || typeof value !== 'object') {
        return;
    }

    const frame = (value as { frame?: unknown }).frame;
    if (frame && typeof frame === 'object' && typeof (frame as { close?: unknown }).close === 'function') {
        (frame as { close: () => void }).close();
    }
}

function closePresentationFrame(presentationFrame: DecodedPresentationFrame): void {
    if (presentationFrame.outputMode !== 'video-frame') {
        return;
    }

    try {
        presentationFrame.frame.close();
    } catch {
        // Ownership ends even if a platform implementation throws while closing
    }
}

function validateDecodedAudioOutputChannelCount(
    options: CustomDecodeSessionStartOptions,
    audioOutputMode: CustomDecodeAudioOutputMode
): void {
    const outputChannelCount = options.decodedAudioOutputChannelCount;
    if (outputChannelCount !== undefined
        && outputChannelCount !== 2
        && outputChannelCount !== 6
        && outputChannelCount !== 8) {
        throw new RangeError('Decoded audio output channel count must be 2, 6, or 8');
    }
    if (outputChannelCount !== undefined && (options.audioTrackIndex == null || audioOutputMode !== 'decoded-pcm')) {
        throw new TypeError('Decoded audio output channels require decoded PCM audio');
    }
    if (options.audioDownmixSettings !== undefined) {
        if (options.audioTrackIndex == null || audioOutputMode !== 'decoded-pcm') {
            throw new TypeError('Audio downmix settings require decoded PCM audio');
        }
        assertValidAudioDownmixSettings(options.audioDownmixSettings);
    }
}

function validateAudioDownmixAlgorithm(options: CustomDecodeSessionStartOptions): void {
    if (options.audioDownmixAlgorithm === undefined) {
        return;
    }
    if (!isCustomAudioDownmixAlgorithm(options.audioDownmixAlgorithm)) {
        throw new TypeError('Custom decode audio downmix algorithm is invalid');
    }
    if (options.audioTrackIndex == null) {
        throw new TypeError('Custom decode cannot select a downmix algorithm without audio');
    }
}

function getReadyAudioConfigurationError(
    generationRecord: GenerationRecord,
    audioConfiguration: DecodeWorkerReadyAudioConfiguration | null
): string | null {
    if (generationRecord.audioRequested !== Boolean(audioConfiguration)) {
        return 'Decoded audio configuration did not match the request';
    }
    if (!audioConfiguration) {
        return null;
    }

    const responseOutputMode = isNativeMediaAudioConfiguration(audioConfiguration) ? 'native-media' : 'decoded-pcm';
    if (responseOutputMode !== generationRecord.audioOutputMode) {
        return 'Decoded audio output mode did not match the request';
    }
    if (responseOutputMode === 'decoded-pcm' && audioConfiguration.channelCount !== generationRecord.decodedAudioOutputChannelCount) {
        return 'Decoded audio channel count did not match the request';
    }
    return null;
}

function validateAudioStartOptions(
    options: CustomDecodeSessionStartOptions,
    decodedAudioAvailable: boolean,
    nativeAudioAvailable: boolean
): void {
    if (!isValidOptionalTrackIndex(options.audioTrackIndex)) {
        throw new RangeError('Custom decode audio track index must be a non-negative safe integer');
    }
    const audioOutputMode = options.audioOutputMode ?? 'decoded-pcm';
    if (audioOutputMode !== 'decoded-pcm' && audioOutputMode !== 'native-media') {
        throw new TypeError('Custom decode audio output mode is invalid');
    }
    if (options.durationMicroseconds != null) {
        requireMicroseconds(options.durationMicroseconds, 'Custom decode duration');
        if (options.durationMicroseconds <= 0) {
            throw new RangeError('Custom decode duration must be positive');
        }
    }
    if (options.audioTrackIndex == null && options.audioOutputMode !== undefined) {
        throw new TypeError('Custom decode cannot select an audio output mode without audio');
    }
    validateAudioDownmixAlgorithm(options);
    validateDecodedAudioOutputChannelCount(options, audioOutputMode);
    if (options.audioTrackIndex == null) {
        return;
    }
    if (audioOutputMode === 'decoded-pcm' && !decodedAudioAvailable) {
        throw new Error('Custom audio decode requires an AudioWorklet bridge');
    }
    if (audioOutputMode === 'native-media' && (!nativeAudioAvailable || options.durationMicroseconds == null)) {
        throw new Error('Native media audio requires an owned backend factory and a finite duration');
    }
}

function validateHDRStartOptions(options: CustomDecodeSessionStartOptions): void {
    if (typeof options.neutralizeHDRColorMetadata !== 'boolean') {
        throw new TypeError('Custom decode HDR color neutralization flag is invalid');
    }
    if (options.nativeHDRTransfer !== null && options.nativeHDRTransfer !== 'hlg' && options.nativeHDRTransfer !== 'pq') {
        throw new TypeError('Custom decode native HDR transfer is invalid');
    }
    const invalidRoute = options.neutralizeHDRColorMetadata ?
        (options.nativeHDRTransfer === null
            || options.videoOutputMode !== 'video-frame'
            || options.videoDecoderBackend !== 'native'
            || options.dolbyVisionProfile !== null) :
        options.nativeHDRTransfer !== null;
    if (invalidRoute) {
        throw new TypeError('HDR color neutralization requires native non-Dolby VideoFrame output');
    }
}

/**
 * Owns one bounded, generation-safe custom decode session and its decode worker.
 * The worker outlives generations: it runs one at a time, and a start waits until the previous run has stopped.
 */
export default class CustomDecodeSession {
    private activeAudioBridge: CustomDecodeAudioBridge | null = null;
    private activeNativeAudioBridge: CustomDecodeNativeAudioBridge | null = null;
    private readonly audioBridgeFactory: CustomDecodeAudioBridgeFactory | null;
    private readonly configuredAudioBridge: CustomDecodeAudioBridge | null;
    private destroyed = false;
    private readonly eventHandler: CustomDecodeSessionEventHandler;
    private readonly nativeAudioBridgeFactory: CustomDecodeNativeAudioBridgeFactory | null;
    private nativeAudioStopScheduled = false;
    private nativeAudioStopTail: Promise<void> = Promise.resolve();
    private readonly workerFactory: CustomDecodeWorkerFactory;
    private readonly queuedFrames: QueuedFrame[] = [];
    private readonly pendingFrames = new Map<DecodedPresentationFrame, GenerationRecord>();

    private activeGeneration: GenerationRecord | null = null;
    private telemetry = createTelemetry();
    /** Created by the first start, and replaced only after a failure or an unacknowledged stop */
    private workerRecord: WorkerRecord | null = null;

    /** Creates an idle session; its first start creates the decode worker. */
    public constructor(
        eventHandler: CustomDecodeSessionEventHandler = () => undefined,
        workerFactory: CustomDecodeWorkerFactory = createDefaultWorker,
        audioBridge: CustomDecodeAudioBridge | null = null,
        audioBridgeFactory: CustomDecodeAudioBridgeFactory | null = null,
        nativeAudioBridgeFactory: CustomDecodeNativeAudioBridgeFactory | null = null
    ) {
        if (audioBridge && audioBridgeFactory) {
            throw new TypeError('Provide either a decoded audio bridge or a bridge factory, not both');
        }
        this.audioBridgeFactory = audioBridgeFactory;
        this.configuredAudioBridge = audioBridge;
        this.eventHandler = eventHandler;
        this.nativeAudioBridgeFactory = nativeAudioBridgeFactory;
        this.workerFactory = workerFactory;
    }

    /**
     * Starts a generation and retires any previous one.
     * The worker takes the start once the previous run has posted `stopped`, or once the stop bound has replaced the worker.
     */
    public start(options: CustomDecodeSessionStartOptions): void {
        if (this.destroyed) {
            throw new Error('The custom decode session is destroyed');
        }
        this.validateStartOptions(options);

        const previousGeneration = this.activeGeneration;
        this.activeGeneration = null;
        this.stopActiveAudioPaths(previousGeneration?.generation ?? null);
        if (previousGeneration) {
            this.retireGeneration(previousGeneration);
        }
        this.closeQueuedFrames();
        this.clearPendingFrames();

        this.telemetry = createTelemetry();
        this.telemetry.activeGeneration = options.generation;
        this.telemetry.state = 'starting';

        let startRequest: DecodeWorkerStartRequest;
        try {
            startRequest = this.createStartRequest(options);
        } catch {
            this.failSession(options.generation, 'decode-failed', 'Unable to start the custom decode worker');
            return;
        }
        this.activeGeneration = this.createGenerationRecord(options, startRequest);
        this.startPendingGeneration();
    }

    /**
     * Stops decoding and closes queued frames.
     * Resolves once the worker has acknowledged the stop, or has been replaced after the bound, and keeps it for the next start.
     */
    public stop(): Promise<void> {
        const generationRecord = this.activeGeneration;
        this.activeGeneration = null;
        this.stopActiveAudioPaths(generationRecord?.generation ?? null);
        this.closeQueuedFrames();
        this.clearPendingFrames();
        this.telemetry.activeGeneration = null;
        this.telemetry.state = 'idle';

        if (generationRecord) {
            this.retireGeneration(generationRecord);
        }

        const stopPromises: Promise<void>[] = [];
        if (this.nativeAudioStopScheduled) {
            stopPromises.push(this.nativeAudioStopTail);
        }
        // A start that waited for a retiring run leaves that run behind
        const runningGeneration = this.workerRecord?.runningGeneration ?? null;
        if (runningGeneration) {
            stopPromises.push(runningGeneration.retirementPromise);
        }
        switch (stopPromises.length) {
            case 0:
                return Promise.resolve();
            case 1:
                return stopPromises[0];
            default:
                return Promise.all(stopPromises).then((): void => undefined);
        }
    }

    /**
     * Stops decoding and terminates the worker at once; a later start throws.
     * Call stop() first to give the run its bound to finish.
     */
    public destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        void this.stop().catch((): void => undefined);
        const workerRecord = this.workerRecord;
        if (workerRecord) {
            this.terminateWorker(workerRecord);
        }
    }

    /** Returns a snapshot of custom decode state and queue accounting. */
    public getTelemetry(): CustomDecodeSessionTelemetry {
        return {
            ...this.telemetry,
            queuedFrameCount: this.queuedFrames.length
        };
    }

    /**
     * Posts a live gain snapshot only after a stereo decoded PCM worker is configured.
     * Any declared source can decode to a bed that folds down.
     */
    public updateAudioDownmixSettings(settings: AudioDownmixSettings): boolean {
        assertValidAudioDownmixSettings(settings);
        const generationRecord = this.activeGeneration;
        if (!generationRecord
            || !this.isGenerationCurrent(generationRecord)
            || !generationRecord.configurationReceived
            || (this.telemetry.state !== 'configured' && this.telemetry.state !== 'ready')
            || generationRecord.audioOutputMode !== 'decoded-pcm'
            || generationRecord.decodedAudioOutputChannelCount !== 2) {
            return false;
        }

        const audioConfiguration = generationRecord.audioConfiguration;
        if (!audioConfiguration
            || isNativeMediaAudioConfiguration(audioConfiguration)
            || audioConfiguration.channelCount !== 2) {
            return false;
        }

        try {
            this.postRequest(generationRecord, {
                audioDownmixSettings: { ...settings },
                generation: generationRecord.generation,
                type: 'update-audio-downmix-settings'
            });
            return true;
        } catch {
            return false;
        }
    }

    /** Returns native audio time only after decoded element progress qualified it, and never once the element played to the end of its media. */
    public getNativeAudioTimeMicroseconds(): Microseconds | null {
        if (this.telemetry.nativeAudioEnded) {
            return null;
        }
        return this.activeNativeAudioBridge?.getAuthoritativeTimeMicroseconds() ?? null;
    }

    /** Starts or pauses the optional owned native audio element. */
    public async setNativeAudioPlaying(playing: boolean): Promise<void> {
        const nativeAudioBridge = this.activeNativeAudioBridge;
        if (!nativeAudioBridge) {
            return;
        }
        if (!await nativeAudioBridge.setPlaying(playing)) {
            throw new Error('Native media audio generation became stale');
        }
    }

    public setNativeAudioVolume(volume: number): void {
        this.activeNativeAudioBridge?.setVolume(volume);
    }

    public setNativeAudioMuted(muted: boolean): void {
        this.activeNativeAudioBridge?.setMuted(muted);
    }

    /** Transfers the newest decoded frame at or before the HTML clock time. */
    public takeFrame(targetTimeMicroseconds: Microseconds): DecodedPresentationFrame | null {
        requireMicroseconds(targetTimeMicroseconds, 'Presentation target time');

        let selectedFrameIndex = -1;
        for (let frameIndex = 0; frameIndex < this.queuedFrames.length; frameIndex += 1) {
            if (this.queuedFrames[frameIndex].presentationFrame.mediaTimeMicroseconds > targetTimeMicroseconds) {
                break;
            }
            selectedFrameIndex = frameIndex;
        }

        if (selectedFrameIndex < 0) {
            return null;
        }

        const consumedFrames = this.queuedFrames.splice(0, selectedFrameIndex + 1);
        const selectedQueuedFrame = consumedFrames.pop();
        if (!selectedQueuedFrame) {
            return null;
        }
        this.telemetry.queuedFrameCount = this.queuedFrames.length;
        this.telemetry.droppedFrameCount += consumedFrames.length;
        for (let frameIndex = 0; frameIndex < consumedFrames.length; frameIndex += 1) {
            const droppedFrame = consumedFrames[frameIndex];
            recordTimingEvent('frame-dropped', {
                mediaTimeMicroseconds: droppedFrame.presentationFrame.mediaTimeMicroseconds,
                targetTimeMicroseconds
            });
            if (droppedFrame.presentationFrame.outputMode === 'video-frame') {
                closePresentationFrame(droppedFrame.presentationFrame);
                continue;
            }
            if (!this.recycleFrameBuffer(droppedFrame.generationRecord, droppedFrame.presentationFrame.frame.data)) {
                this.abandonPresentationFrame(droppedFrame.presentationFrame);
                for (let abandonedFrameIndex = frameIndex + 1; abandonedFrameIndex < consumedFrames.length; abandonedFrameIndex += 1) {
                    this.abandonPresentationFrame(consumedFrames[abandonedFrameIndex].presentationFrame);
                }
                this.abandonPresentationFrame(selectedQueuedFrame.presentationFrame);
                return null;
            }
        }

        this.telemetry.takenFrameCount += 1;
        this.pendingFrames.set(selectedQueuedFrame.presentationFrame, selectedQueuedFrame.generationRecord);
        this.telemetry.pendingFrameCount = this.pendingFrames.size;
        if (selectedQueuedFrame.presentationFrame.outputMode === 'video-frame') {
            this.requestReplacementFrames(selectedQueuedFrame.generationRecord, consumedFrames.length);
        }

        return selectedQueuedFrame.presentationFrame;
    }

    /** Releases one selected frame credit at the renderer's safe release point. */
    public acknowledgeFrame(presentationFrame: DecodedPresentationFrame): boolean {
        return this.releasePendingFrame(presentationFrame);
    }

    /** Releases one selected frame credit after the presentation owner discards it. */
    public discardFrame(presentationFrame: DecodedPresentationFrame): boolean {
        return this.releasePendingFrame(presentationFrame);
    }

    /**
     * Restarts only video decode from the keyframe preceding the target.
     * Audio is untouched; queued frames from earlier video epochs are discarded.
     */
    public resyncVideo(targetTimeMicroseconds: Microseconds): boolean {
        requireMicroseconds(targetTimeMicroseconds, 'Video resync target time');
        const generationRecord = this.beginVideoEpoch();
        if (!generationRecord) {
            return false;
        }

        try {
            this.postRequest(generationRecord, {
                generation: generationRecord.generation,
                targetTimeMicroseconds,
                type: 'resync-video',
                videoEpoch: generationRecord.videoEpoch
            });
        } catch {
            this.handleDecodeProtocolFailure(generationRecord, 'Unable to resynchronize custom video decode');
            return false;
        }
        this.telemetry.videoResyncCount += 1;
        this.discardQueuedVideoFrames(generationRecord);
        // Returning discarded credits can itself fail the session
        return this.isGenerationCurrent(generationRecord);
    }

    /** Releases the video decoder until the next resync while audio continues. */
    public suspendVideo(): boolean {
        const generationRecord = this.beginVideoEpoch();
        if (!generationRecord) {
            return false;
        }

        try {
            this.postRequest(generationRecord, {
                generation: generationRecord.generation,
                type: 'suspend-video',
                videoEpoch: generationRecord.videoEpoch
            });
        } catch {
            this.handleDecodeProtocolFailure(generationRecord, 'Unable to suspend custom video decode');
            return false;
        }
        this.telemetry.videoSuspensionCount += 1;
        this.discardQueuedVideoFrames(generationRecord);
        return this.isGenerationCurrent(generationRecord);
    }

    /**
     * Restarts only decoded audio at a target with a new output layout while video continues.
     * The previous bridge stops at once and samples from earlier audio epochs are discarded.
     * Resolves to the new epoch, or null when not issued.
     */
    public async resyncAudio(options: CustomDecodeAudioResyncOptions): Promise<number | null> {
        requireMicroseconds(options.targetTimeMicroseconds, 'Audio resync target time');
        const outputChannelCount = options.decodedAudioOutputChannelCount;
        if (outputChannelCount !== 2 && outputChannelCount !== 6 && outputChannelCount !== 8) {
            throw new RangeError('Decoded audio output channel count must be 2, 6, or 8');
        }
        if (options.audioDownmixAlgorithm !== undefined && !isCustomAudioDownmixAlgorithm(options.audioDownmixAlgorithm)) {
            throw new TypeError('Custom decode audio downmix algorithm is invalid');
        }
        if (options.audioDownmixSettings !== undefined) {
            assertValidAudioDownmixSettings(options.audioDownmixSettings);
        }

        const generationRecord = this.activeGeneration;
        const audioConfiguration = generationRecord?.audioConfiguration ?? null;
        if (!generationRecord
            || !this.isGenerationCurrent(generationRecord)
            || this.telemetry.state !== 'ready'
            || generationRecord.audioOutputMode !== 'decoded-pcm'
            || !audioConfiguration
            || isNativeMediaAudioConfiguration(audioConfiguration)) {
            return null;
        }

        // A newer resync supersedes one still building its bridge
        const audioEpoch = generationRecord.audioEpoch + 1;
        generationRecord.audioEpoch = audioEpoch;
        generationRecord.audioEpochSubmittedFrameCount = 0;
        generationRecord.audioResyncPending = true;
        generationRecord.audioTrackEnded = false;
        this.telemetry.audioEnded = false;
        this.telemetry.audioEpoch = audioEpoch;
        this.telemetry.audioResyncPending = true;
        // PCM queued for the old layout is discarded with its bridge
        this.activeAudioBridge?.stop(generationRecord.generation);
        this.activeAudioBridge = null;

        const resyncedAudioConfiguration: DecodeWorkerAudioConfiguration = {
            ...audioConfiguration,
            channelCount: outputChannelCount
        };
        let audioBridge: CustomDecodeAudioBridge;
        try {
            audioBridge = await options.createAudioBridge(resyncedAudioConfiguration);
        } catch {
            if (this.isAudioEpochCurrent(generationRecord, audioEpoch)) {
                this.handleAudioOutputFailure(generationRecord, 'Unable to create the resynchronized audio output');
            }
            return null;
        }
        if (!this.isAudioEpochCurrent(generationRecord, audioEpoch)) {
            return null;
        }
        // Decode can finish while the bridge is built; the finished run never sees the resync, so the bridge starts empty and lets playback drain to its end
        const decodeEnded = this.isDecodeEnded();

        generationRecord.audioConfiguration = resyncedAudioConfiguration;
        generationRecord.decodedAudioOutputChannelCount = outputChannelCount;
        this.activeAudioBridge = audioBridge;
        let audioOutput: DecodeWorkerAudioOutputAttachment;
        try {
            audioOutput = audioBridge.start({
                audioConfiguration: resyncedAudioConfiguration,
                callbacks: {
                    onFailure: message => {
                        if (generationRecord.audioEpoch === audioEpoch) {
                            this.handleAudioOutputFailure(generationRecord, message);
                        }
                    }
                },
                decodeGeneration: generationRecord.generation,
                startTimeMicroseconds: options.targetTimeMicroseconds
            });
        } catch {
            this.handleAudioOutputFailure(generationRecord, 'Unable to resynchronize decoded audio');
            return null;
        }
        if (decodeEnded) {
            // The finished run takes no channel
            audioOutput.port.close();
            generationRecord.audioResyncPending = false;
            this.telemetry.audioResyncPending = false;
        } else if (!this.postAudioResync(generationRecord, audioEpoch, audioOutput, options)) {
            return null;
        }
        this.telemetry.audioChannelCount = outputChannelCount;
        this.telemetry.audioResyncCount += 1;
        return audioEpoch;
    }

    /** Restarts the worker's audio attempt with the new worklet's channel; returns false once the failure is handled. */
    private postAudioResync(
        generationRecord: GenerationRecord,
        audioEpoch: number,
        audioOutput: DecodeWorkerAudioOutputAttachment,
        options: CustomDecodeAudioResyncOptions
    ): boolean {
        const resyncRequest: DecodeWorkerResyncAudioRequest = {
            audioEpoch,
            audioOutput,
            decodedAudioOutputChannelCount: options.decodedAudioOutputChannelCount,
            generation: generationRecord.generation,
            targetTimeMicroseconds: options.targetTimeMicroseconds,
            type: 'resync-audio'
        };
        if (options.audioDownmixAlgorithm !== undefined) {
            resyncRequest.audioDownmixAlgorithm = options.audioDownmixAlgorithm;
        }
        if (options.audioDownmixSettings !== undefined) {
            resyncRequest.audioDownmixSettings = { ...options.audioDownmixSettings };
        }
        try {
            this.postRequest(generationRecord, resyncRequest, [ audioOutput.port ]);
            return true;
        } catch {
            audioOutput.port.close();
            this.handleAudioOutputFailure(generationRecord, 'Unable to resynchronize decoded audio');
            return false;
        }
    }

    private isAudioEpochCurrent(generationRecord: GenerationRecord, audioEpoch: number): boolean {
        return this.isGenerationCurrent(generationRecord)
            && generationRecord.audioEpoch === audioEpoch
            && (this.telemetry.state === 'ready' || this.isDecodeEnded());
    }

    private isDecodeEnded(): boolean {
        return this.telemetry.state === 'ended';
    }

    private validateStartOptions(options: CustomDecodeSessionStartOptions): void {
        if (!isValidGeneration(options.generation)) {
            throw new RangeError('Custom decode generation must be a positive safe integer');
        }
        if (!isDolbyVisionProfile(options.dolbyVisionProfile)) {
            throw new TypeError('Custom decode Dolby Vision profile is invalid');
        }
        requireMicroseconds(options.startTimeMicroseconds, 'Custom decode start time');
        if (typeof options.url !== 'string' || !options.url) {
            throw new TypeError('Custom decode URL must be a non-empty string');
        }
        if (!isValidCodedDimension(options.maximumCodedWidth) || !isValidCodedDimension(options.maximumCodedHeight)) {
            throw new RangeError('Custom decode coded dimensions must be positive safe integers');
        }
        if (!isValidTrackIndex(options.videoTrackIndex)) {
            throw new RangeError('Custom decode video track index must be a non-negative safe integer');
        }
        validateAudioStartOptions(
            options,
            Boolean(this.configuredAudioBridge || this.audioBridgeFactory),
            this.nativeAudioBridgeFactory !== null
        );
        if (!isValidVideoOutputMode(options.videoOutputMode)) {
            throw new TypeError('Custom decode video output mode is invalid');
        }
        if (!isValidVideoDecoderBackend(options.videoDecoderBackend)) {
            throw new TypeError('Custom decode video decoder backend is invalid');
        }
        if (
            (options.videoDecoderBackend === 'ffmpeg-mpeg2-vc1'
                || options.videoDecoderBackend === 'openjpeg')
            && (options.videoOutputMode !== 'video-frame'
                || options.rawVideoFrameFormat !== null
                || options.dolbyVisionProfile !== null
                || options.neutralizeHDRColorMetadata
                || options.nativeHDRTransfer !== null)
        ) {
            throw new TypeError('Software video decode requires an SDR VideoFrame route');
        }
        validateHDRStartOptions(options);
        if (!hasValidRawVideoFrameFormat(options)) {
            const message = options.videoOutputMode === 'raw-planes' ?
                'Raw custom decode requires a requested raw frame format' :
                'VideoFrame custom decode cannot request a raw frame format';
            throw new TypeError(message);
        }
        validateRawVideoFrameCopyLayout(options);
    }

    private createStartRequest(options: CustomDecodeSessionStartOptions): DecodeWorkerStartRequest {
        const audioOutputMode = options.audioOutputMode ?? 'decoded-pcm';
        const startRequest: DecodeWorkerStartRequest = {
            audioSampleCredits: 0,
            audioTrackIndex: options.audioTrackIndex ?? null,
            ...(options.discardDolbyVisionEnhancementLayer ? { discardDolbyVisionEnhancementLayer: true } : {}),
            dolbyVisionProfile: options.dolbyVisionProfile,
            dolbyVisionRPUParserWASMURL: resolveDolbyVisionRPUParserWASMURL(),
            frameCredits: options.videoOutputMode === 'raw-planes' ? MAX_DECODED_RAW_FRAME_CREDITS : MAX_DECODED_FRAME_CREDITS,
            generation: options.generation,
            maximumCodedHeight: options.maximumCodedHeight,
            maximumCodedWidth: options.maximumCodedWidth,
            nativeHDRTransfer: options.nativeHDRTransfer,
            neutralizeHDRColorMetadata: options.neutralizeHDRColorMetadata,
            rawVideoFrameFormat: options.rawVideoFrameFormat,
            ...(options.durationMicroseconds == null ? { reportContainerDuration: true } : {}),
            startTimeMicroseconds: options.startTimeMicroseconds,
            ...(isTimingTraceActive() ? { timingTrace: true } : {}),
            type: 'start',
            url: options.url,
            videoDecoderBackend: options.videoDecoderBackend,
            videoOutputMode: options.videoOutputMode,
            videoTrackIndex: options.videoTrackIndex
        };
        if (options.audioDownmixSettings !== undefined) {
            startRequest.audioDownmixSettings = { ...options.audioDownmixSettings };
        }
        if (audioOutputMode === 'native-media') {
            startRequest.audioOutputMode = 'native-media';
        }
        if (audioOutputMode === 'decoded-pcm' && options.audioDownmixAlgorithm !== undefined) {
            startRequest.audioDownmixAlgorithm = options.audioDownmixAlgorithm;
        }
        if (options.decodedAudioOutputChannelCount !== undefined) {
            startRequest.decodedAudioOutputChannelCount = options.decodedAudioOutputChannelCount;
        }
        return startRequest;
    }

    private createGenerationRecord(
        options: CustomDecodeSessionStartOptions,
        startRequest: DecodeWorkerStartRequest
    ): GenerationRecord {
        let resolveRetirement: () => void = (): void => undefined;
        const retirementPromise = new Promise<void>(resolve => {
            resolveRetirement = resolve;
        });
        return {
            audioConfiguration: null,
            audioEpoch: 0,
            audioEpochSubmittedFrameCount: 0,
            audioMediaReady: false,
            audioResyncPending: false,
            audioOutputMode: options.audioOutputMode ?? 'decoded-pcm',
            audioRequested: options.audioTrackIndex != null,
            audioTrackEnded: false,
            configurationReceived: false,
            decodeEnded: false,
            decodedAudioOutputChannelCount:
                (options.audioOutputMode ?? 'decoded-pcm') === 'decoded-pcm'
                    && options.audioTrackIndex != null ?
                    options.decodedAudioOutputChannelCount ?? 2 :
                    null,
            decodedVideoGeometry: null,
            generation: options.generation,
            maximumCodedHeight: options.maximumCodedHeight,
            maximumCodedWidth: options.maximumCodedWidth,
            nativeAudioBridgeStarted: false,
            nativeAudioElementEnded: false,
            nativeAudioEndOfStreamAccepted: false,
            nativeAudioEndOfStreamRequested: false,
            resolveRetirement,
            retirementPromise,
            runStopped: false,
            startRequest,
            startTimeMicroseconds: options.startTimeMicroseconds,
            stopRequested: false,
            durationMicroseconds: options.durationMicroseconds ?? null,
            videoCodec: null,
            videoDecoderBackend: options.videoDecoderBackend,
            videoEpoch: 0,
            videoGeometry: null,
            videoMediaReady: false,
            videoOutputMode: options.videoOutputMode,
            staticHDRMetadata: null,
            containerDurationMicroseconds: null,
            workerRecord: null
        };
    }

    private createWorkerRecord(worker: Worker, videoDecoderBackend: CustomDecodeVideoDecoderBackend): WorkerRecord {
        const workerRecord: WorkerRecord = {
            errorHandler: (): void => undefined,
            hasRunGeneration: false,
            messageHandler: (): void => undefined,
            replacementRequired: false,
            runningGeneration: null,
            stopTimer: null,
            terminated: false,
            videoDecoderBackend,
            worker
        };

        workerRecord.messageHandler = event => {
            this.handleWorkerMessage(workerRecord, event.data);
        };
        workerRecord.errorHandler = event => {
            event.preventDefault();
            this.handleWorkerCrash(workerRecord);
        };
        worker.addEventListener('message', workerRecord.messageHandler);
        worker.addEventListener('error', workerRecord.errorHandler);
        return workerRecord;
    }

    /**
     * Posts the active generation's start once the worker is free, creating the worker at the first start.
     * Overlapping runs are unsafe: a stopping run waits for every bundled HEVC decoder in its worker, the next run's included.
     */
    private startPendingGeneration(): void {
        const generationRecord = this.activeGeneration;
        if (!generationRecord || generationRecord.workerRecord || generationRecord.runStopped || this.destroyed) {
            return;
        }

        let workerRecord = this.workerRecord;
        if (workerRecord
            && (workerRecord.replacementRequired || workerRecord.videoDecoderBackend !== generationRecord.videoDecoderBackend)) {
            // A worker this generation will not reuse gives way at once, even while its run still stops
            this.terminateWorker(workerRecord);
            workerRecord = null;
        }
        if (workerRecord?.runningGeneration) {
            // The previous run's acknowledgement, or its stop bound, resumes this start
            return;
        }

        if (!workerRecord) {
            try {
                workerRecord = this.createWorkerRecord(this.workerFactory(), generationRecord.videoDecoderBackend);
            } catch {
                this.activeGeneration = null;
                this.failSession(generationRecord.generation, 'decode-failed', 'Unable to create the custom decode worker');
                return;
            }
            this.workerRecord = workerRecord;
        }

        generationRecord.workerRecord = workerRecord;
        workerRecord.runningGeneration = generationRecord;
        this.telemetry.workerReused = workerRecord.hasRunGeneration;
        workerRecord.hasRunGeneration = true;
        try {
            this.postRequest(generationRecord, generationRecord.startRequest);
        } catch {
            this.failGenerationWithUnusableWorker(generationRecord, 'Unable to start the custom decode worker');
        }
    }

    /**
     * Ends a generation's run.
     * A start that never reached the worker is dropped; a running one gets `stop`, and its worker is terminated if it does not acknowledge within the bound.
     */
    private retireGeneration(generationRecord: GenerationRecord): void {
        const workerRecord = generationRecord.workerRecord;
        if (!workerRecord) {
            this.completeRun(generationRecord);
            return;
        }
        if (generationRecord.runStopped || generationRecord.stopRequested) {
            return;
        }

        generationRecord.stopRequested = true;
        try {
            this.postRequest(generationRecord, {
                generation: generationRecord.generation,
                type: 'stop'
            });
        } catch {
            this.terminateWorker(workerRecord);
            return;
        }
        workerRecord.stopTimer = globalThis.setTimeout(() => {
            workerRecord.stopTimer = null;
            console.warn(`Custom decode worker generation ${generationRecord.generation} did not acknowledge shutdown`);
            this.terminateWorker(workerRecord);
            this.startPendingGeneration();
        }, WORKER_STOP_TIMEOUT_MILLISECONDS);
    }

    /** Frees the worker once its run posted `stopped`, finished or stopped, and hands it to a waiting start. */
    private handleRunStopped(workerRecord: WorkerRecord, message: DecodeWorkerStoppedResponse): void {
        const generationRecord = workerRecord.runningGeneration;
        if (!generationRecord || generationRecord.generation !== message.generation) {
            return;
        }

        if (message.replaceWorker === true) {
            workerRecord.replacementRequired = true;
        }
        this.clearStopTimer(workerRecord);
        workerRecord.runningGeneration = null;
        this.completeRun(generationRecord);
        if (workerRecord.replacementRequired) {
            this.terminateWorker(workerRecord);
        }
        this.startPendingGeneration();
    }

    /** Terminates a worker and ends the run it held; the next start creates a new worker. */
    private terminateWorker(workerRecord: WorkerRecord): void {
        if (workerRecord.terminated) {
            return;
        }

        workerRecord.terminated = true;
        this.clearStopTimer(workerRecord);
        workerRecord.worker.removeEventListener('message', workerRecord.messageHandler);
        workerRecord.worker.removeEventListener('error', workerRecord.errorHandler);
        workerRecord.worker.terminate();
        if (this.workerRecord === workerRecord) {
            this.workerRecord = null;
        }
        const runningGeneration = workerRecord.runningGeneration;
        workerRecord.runningGeneration = null;
        if (runningGeneration) {
            this.completeRun(runningGeneration);
        }
    }

    private clearStopTimer(workerRecord: WorkerRecord): void {
        if (workerRecord.stopTimer === null) {
            return;
        }
        globalThis.clearTimeout(workerRecord.stopTimer);
        workerRecord.stopTimer = null;
    }

    /** Keeps a worker from taking another generation: an idle one terminates at once, a busy one once its run stops. */
    private requireWorkerReplacement(workerRecord: WorkerRecord): void {
        workerRecord.replacementRequired = true;
        if (!workerRecord.runningGeneration) {
            this.terminateWorker(workerRecord);
        }
    }

    /** Returns the active generation if its run is in this worker; losing such a worker fails the generation. */
    private getDependentGeneration(workerRecord: WorkerRecord): GenerationRecord | null {
        const generationRecord = this.activeGeneration;
        return generationRecord !== null && workerRecord.runningGeneration === generationRecord ? generationRecord : null;
    }

    private completeRun(generationRecord: GenerationRecord): void {
        generationRecord.runStopped = true;
        generationRecord.resolveRetirement();
    }

    private handleWorkerMessage(workerRecord: WorkerRecord, messageValue: unknown): void {
        if (!isDecodeWorkerResponse(messageValue)) {
            closeFrameFromUnknownMessage(messageValue);
            this.handleWorkerFault(workerRecord, 'The custom decode worker sent an invalid message');
            return;
        }

        switch (messageValue.type) {
            case 'stopped':
                this.handleRunStopped(workerRecord, messageValue);
                return;
            case 'timing-trace':
                // A retired generation's timing still explains the moments before its replacement
                ingestWorkerTimingEvents(messageValue.events);
                return;
            default:
                break;
        }

        const generationRecord = this.activeGeneration;
        if (
            !generationRecord
            || generationRecord.workerRecord !== workerRecord
            || messageValue.generation !== generationRecord.generation
            || this.telemetry.activeGeneration !== generationRecord.generation
        ) {
            this.handleStaleMessage(workerRecord, messageValue);
            return;
        }

        switch (messageValue.type) {
            case 'progress':
                this.telemetry.submittedVideoPacketCount = messageValue.packetCount;
                this.telemetry.videoProgressPhase = messageValue.phase;
                break;
            case 'ready':
                this.handleReadyResponse(generationRecord, messageValue);
                break;
            case 'frame':
                this.handleFrameResponse(generationRecord, messageValue);
                break;
            case 'video-ended':
                this.handleVideoEndedResponse(generationRecord, messageValue);
                break;
            case 'audio-ended':
                this.handleAudioEndedResponse(generationRecord, messageValue);
                break;
            case 'audio-source-format':
                this.handleAudioSourceFormatResponse(generationRecord, messageValue);
                break;
            case 'video-interrupted':
                this.handleVideoInterruptedResponse(generationRecord, messageValue);
                break;
            case 'audio-progress':
                this.recordAudioProgress(generationRecord, messageValue);
                break;
            case 'native-audio-init':
                this.enqueueNativeAudioInitialization(generationRecord, messageValue);
                break;
            case 'native-audio-media':
                this.enqueueNativeAudioMedia(generationRecord, messageValue);
                break;
            case 'ended':
                this.handleWorkerEnded(generationRecord);
                break;
            case 'error':
                this.failGeneration(generationRecord, messageValue.failureKind, messageValue.message);
                break;
        }
    }

    /** Drops a message of a retired generation; a run that failed still keeps its worker from taking another generation. */
    private handleStaleMessage(workerRecord: WorkerRecord, message: DecodeWorkerResponse): void {
        switch (message.type) {
            case 'frame':
                switch (message.outputMode) {
                    case 'raw-planes':
                        this.telemetry.abandonedRawFrameCount += 1;
                        break;
                    case 'video-frame':
                        message.frame.close();
                        break;
                }
                this.telemetry.staleFrameCount += 1;
                break;
            case 'audio-progress':
            case 'native-audio-init':
            case 'native-audio-media':
                this.telemetry.staleAudioSampleCount += 1;
                break;
            case 'error':
                // A failed run may leave a decoder open
                this.requireWorkerReplacement(workerRecord);
                this.startPendingGeneration();
                break;
            default:
                break;
        }
    }

    /** Fails the active generation if it needs the misbehaving worker; the worker is replaced either way. */
    private handleWorkerFault(workerRecord: WorkerRecord, message: string): void {
        const dependentGeneration = this.getDependentGeneration(workerRecord);
        this.requireWorkerReplacement(workerRecord);
        if (dependentGeneration) {
            this.failGeneration(dependentGeneration, 'decode-failed', message);
            return;
        }
        this.startPendingGeneration();
    }

    private handleWorkerCrash(workerRecord: WorkerRecord): void {
        const dependentGeneration = this.getDependentGeneration(workerRecord);
        this.terminateWorker(workerRecord);
        if (dependentGeneration) {
            this.failGeneration(dependentGeneration, 'decode-failed', 'The custom decode worker crashed');
            return;
        }
        // A start that waited for the crashed worker's run takes a new worker
        this.startPendingGeneration();
    }

    private handleReadyResponse(generationRecord: GenerationRecord, message: DecodeWorkerReadyResponse): void {
        if (generationRecord.configurationReceived || this.telemetry.state !== 'starting') {
            this.handleDecodeProtocolFailure(generationRecord, 'The custom decode worker sent duplicate readiness');
            return;
        }
        if (exceedsNegotiatedCodedSize(
            message.codedWidth,
            message.codedHeight,
            generationRecord.maximumCodedWidth,
            generationRecord.maximumCodedHeight
        )) {
            this.handleDecodeProtocolFailure(generationRecord, 'The selected video track exceeds its negotiated decode route');
            return;
        }
        const audioConfiguration = message.audio;
        const videoCodec = message.codec;
        generationRecord.configurationReceived = true;
        generationRecord.audioConfiguration = audioConfiguration;
        generationRecord.videoGeometry = {
            codedHeight: message.codedHeight,
            codedWidth: message.codedWidth,
            displayHeight: message.displayHeight,
            displayWidth: message.displayWidth
        };
        const audioConfigurationError = getReadyAudioConfigurationError(generationRecord, audioConfiguration);
        if (audioConfigurationError) {
            this.handleAudioOutputFailure(generationRecord, audioConfigurationError);
            return;
        }

        generationRecord.videoCodec = videoCodec;
        generationRecord.containerDurationMicroseconds = message.containerDurationMicroseconds ?? null;
        const staticHDRMetadataScan = message.staticHDRMetadataScan ?? null;
        generationRecord.staticHDRMetadata = staticHDRMetadataScan?.metadata ?? null;
        this.telemetry.staticHDRMetadataFirstAccessUnitIndex = staticHDRMetadataScan?.firstMetadataAccessUnitIndex ?? null;
        this.telemetry.staticHDRMetadataScanAccessUnitCount = staticHDRMetadataScan?.accessUnitCount ?? 0;
        this.telemetry.staticHDRMetadataStatus = staticHDRMetadataScan?.status ?? null;
        generationRecord.audioMediaReady = audioConfiguration === null;
        this.telemetry.state = 'configured';
        this.emitEvent({
            audio: audioConfiguration,
            codec: videoCodec,
            generation: generationRecord.generation,
            ...(generationRecord.staticHDRMetadata ? { staticHDRMetadata: generationRecord.staticHDRMetadata } : {}),
            type: 'configured'
        });

        if (!audioConfiguration) {
            this.completeReady(generationRecord, videoCodec, null, null);
            return;
        }

        if (isNativeMediaAudioConfiguration(audioConfiguration)) {
            this.completeNativeAudioReady(generationRecord, audioConfiguration);
            return;
        }

        if (this.configuredAudioBridge) {
            this.completeReady(generationRecord, videoCodec, audioConfiguration, this.configuredAudioBridge);
            return;
        }

        const audioBridgeFactory = this.audioBridgeFactory;
        if (!audioBridgeFactory) {
            this.handleAudioOutputFailure(generationRecord, 'Decoded audio has no configured output');
            return;
        }

        let audioBridgeResult: CustomDecodeAudioBridge | Promise<CustomDecodeAudioBridge>;
        try {
            audioBridgeResult = audioBridgeFactory(audioConfiguration);
        } catch {
            this.handleAudioOutputFailure(generationRecord, 'Unable to create decoded audio output');
            return;
        }
        void Promise.resolve(audioBridgeResult).then(
            audioBridge => {
                if (!this.isGenerationCurrent(generationRecord)) {
                    return;
                }
                this.completeReady(generationRecord, videoCodec, audioConfiguration, audioBridge);
            },
            (): void => {
                if (this.isGenerationCurrent(generationRecord)) {
                    this.handleAudioOutputFailure(generationRecord, 'Unable to create decoded audio output');
                }
            }
        );
    }

    private completeNativeAudioReady(
        generationRecord: GenerationRecord,
        audioConfiguration: DecodeWorkerNativeMediaAudioConfiguration
    ): void {
        void this.startNativeAudioBridge(generationRecord, audioConfiguration);
    }

    private async startNativeAudioBridge(
        generationRecord: GenerationRecord,
        audioConfiguration: DecodeWorkerNativeMediaAudioConfiguration
    ): Promise<void> {
        const bridgeFactory = this.nativeAudioBridgeFactory;
        const durationMicroseconds = generationRecord.durationMicroseconds;
        if (!bridgeFactory || durationMicroseconds === null) {
            this.handleAudioOutputFailure(generationRecord, 'Native media audio has no configured output');
            return;
        }

        try {
            await this.nativeAudioStopTail;
        } catch {
            if (this.isGenerationCurrent(generationRecord)) {
                this.handleAudioOutputFailure(generationRecord, 'Unable to retire the previous native media audio output');
            }
            return;
        }
        if (!this.isGenerationCurrent(generationRecord)) {
            return;
        }

        let nativeAudioBridge: CustomDecodeNativeAudioBridge;
        try {
            nativeAudioBridge = bridgeFactory();
        } catch {
            this.handleAudioOutputFailure(generationRecord, 'Unable to create native media audio output');
            return;
        }
        this.activeNativeAudioBridge = nativeAudioBridge;
        try {
            const started = await nativeAudioBridge.start({
                audioConfiguration,
                callbacks: {
                    onClockReady: generation => {
                        if (this.isGenerationCurrent(generationRecord)
                            && this.activeNativeAudioBridge === nativeAudioBridge
                            && generation === generationRecord.generation) {
                            this.telemetry.nativeAudioClockReady = true;
                        }
                    },
                    onCreditsReleased: audioSegmentCredits => {
                        this.requestReplacementAudioSamples(generationRecord, audioSegmentCredits);
                    },
                    onFailure: message => {
                        this.handleAudioOutputFailure(generationRecord, message);
                    },
                    onEvent: event => {
                        if (event.type === 'ended'
                            && this.isGenerationCurrent(generationRecord)
                            && this.activeNativeAudioBridge === nativeAudioBridge
                            && event.generation === generationRecord.generation) {
                            // Only an ended stream reaches the end of its media
                            generationRecord.nativeAudioElementEnded = true;
                            this.telemetry.nativeAudioEnded = true;
                            this.completeNativeAudioWorkerEndedIfReady(generationRecord);
                        }
                    }
                },
                durationMicroseconds,
                generation: generationRecord.generation,
                startTimeMicroseconds: generationRecord.startTimeMicroseconds
            });
            if (!started || !this.isGenerationCurrent(generationRecord) || this.activeNativeAudioBridge !== nativeAudioBridge) {
                return;
            }
            generationRecord.nativeAudioBridgeStarted = true;
            this.requestReplacementAudioSamples(generationRecord, nativeAudioBridge.initialAudioSegmentCredits);
            // An audio track that ended while the output was opening completes now
            this.completeEndedAudioTrack(generationRecord);
        } catch {
            if (this.isGenerationCurrent(generationRecord) && this.activeNativeAudioBridge === nativeAudioBridge) {
                this.handleAudioOutputFailure(generationRecord, 'Unable to initialize native media audio output');
            }
        }
    }

    private completeReady(
        generationRecord: GenerationRecord,
        videoCodec: string,
        audioConfiguration: DecodeWorkerAudioConfiguration | null,
        audioBridge: CustomDecodeAudioBridge | null
    ): void {
        if (!this.isGenerationCurrent(generationRecord)) {
            return;
        }

        if (audioConfiguration && audioBridge) {
            this.activeAudioBridge = audioBridge;
            let audioOutput: DecodeWorkerAudioOutputAttachment;
            try {
                audioOutput = audioBridge.start({
                    audioConfiguration,
                    callbacks: {
                        onFailure: message => {
                            this.handleAudioOutputFailure(generationRecord, message);
                        }
                    },
                    decodeGeneration: generationRecord.generation,
                    startTimeMicroseconds: generationRecord.startTimeMicroseconds
                });
            } catch {
                this.handleAudioOutputFailure(generationRecord, 'Unable to initialize decoded audio output');
                return;
            }
            this.attachAudioOutput(generationRecord, audioOutput);
            // Wait for the first submitted PCM sample before starting the clock
            return;
        }

        this.emitReadyEventIfMediaReady(generationRecord);
    }

    private emitReadyEventIfMediaReady(generationRecord: GenerationRecord): void {
        const videoCodec = generationRecord.videoCodec;
        if (
            !this.isGenerationCurrent(generationRecord)
            || this.telemetry.state !== 'configured'
            || !generationRecord.configurationReceived
            || !generationRecord.audioMediaReady
            || !generationRecord.videoMediaReady
            || !videoCodec
        ) {
            return;
        }

        const audioConfiguration = generationRecord.audioConfiguration;
        this.telemetry.audioChannelCount = audioConfiguration?.channelCount ?? null;
        this.telemetry.audioCodec = audioConfiguration?.codec ?? null;
        this.telemetry.audioSampleRate = audioConfiguration?.sampleRate ?? null;
        // A decoded source format reported before readiness outranks the declared one
        if (this.telemetry.decodedAudioSourceChannelCount === null) {
            this.telemetry.audioSourceChannelCount = audioConfiguration?.sourceChannelCount ?? null;
            this.telemetry.audioSourceSampleRate = audioConfiguration?.sourceSampleRate ?? null;
        }
        this.telemetry.state = 'ready';
        this.emitEvent({
            audio: generationRecord.audioConfiguration,
            codec: videoCodec,
            ...(generationRecord.containerDurationMicroseconds !== null ? {
                containerDurationMicroseconds: generationRecord.containerDurationMicroseconds
            } : {}),
            generation: generationRecord.generation,
            ...(generationRecord.staticHDRMetadata ? {
                staticHDRMetadata: generationRecord.staticHDRMetadata
            } : {}),
            type: 'ready'
        });
    }

    /** A generation stays current after its run stops on its own, so an ended session still drains and ends its native element. */
    private isGenerationCurrent(generationRecord: GenerationRecord): boolean {
        return this.activeGeneration === generationRecord && this.telemetry.activeGeneration === generationRecord.generation;
    }

    /**
     * Advances the video epoch of a generation whose start reached the worker.
     * A start still waiting for the worker has no video attempt to replace, and an ended run cannot restart video.
     */
    private beginVideoEpoch(): GenerationRecord | null {
        const generationRecord = this.activeGeneration;
        if (!generationRecord
            || !this.isGenerationCurrent(generationRecord)
            || !generationRecord.workerRecord
            || this.telemetry.state === 'ended') {
            return null;
        }

        generationRecord.videoEpoch += 1;
        this.telemetry.videoEnded = false;
        this.telemetry.videoEpoch = generationRecord.videoEpoch;
        return generationRecord;
    }

    /** Discards queued frames of replaced video epochs and returns their decode credits. */
    private discardQueuedVideoFrames(generationRecord: GenerationRecord): void {
        const discardedFrames = this.queuedFrames.splice(0);
        this.telemetry.queuedFrameCount = 0;
        this.telemetry.staleFrameCount += discardedFrames.length;
        let releasedFrameCredits = 0;
        for (const discardedFrame of discardedFrames) {
            const presentationFrame = discardedFrame.presentationFrame;
            if (presentationFrame.outputMode === 'video-frame') {
                closePresentationFrame(presentationFrame);
                releasedFrameCredits += 1;
                continue;
            }
            if (!this.recycleFrameBuffer(discardedFrame.generationRecord, presentationFrame.frame.data)) {
                this.abandonPresentationFrame(presentationFrame);
            }
        }
        this.requestReplacementFrames(generationRecord, releasedFrameCredits);
    }

    private handleFrameResponse(generationRecord: GenerationRecord, message: DecodeWorkerFrameResponse): void {
        // A mismatched output mode still reaches the enqueue protocol failure
        if ((message.videoEpoch ?? 0) !== generationRecord.videoEpoch
            && message.outputMode === generationRecord.videoOutputMode) {
            this.discardStaleEpochFrame(generationRecord, message);
            return;
        }
        this.enqueueFrame(generationRecord, message);
    }

    private handleVideoEndedResponse(generationRecord: GenerationRecord, message: DecodeWorkerVideoEndedResponse): void {
        // A replaced epoch's end says nothing about the restarted video
        if (message.videoEpoch === generationRecord.videoEpoch) {
            this.telemetry.videoEnded = true;
        }
    }

    private handleAudioEndedResponse(generationRecord: GenerationRecord, message: DecodeWorkerAudioEndedResponse): void {
        // A replaced epoch's end says nothing about the restarted audio
        if (message.audioEpoch !== generationRecord.audioEpoch) {
            return;
        }
        generationRecord.audioTrackEnded = true;
        this.telemetry.audioEnded = true;
        this.completeEndedAudioTrack(generationRecord);
        if (this.isGenerationCurrent(generationRecord)) {
            this.emitEvent({ generation: generationRecord.generation, type: 'audio-ended' });
        }
    }

    /**
     * Lets an audio track that ended stand in for the PCM a start, a seek, or a resync waits for, since none will arrive past its end.
     * It also ends a native-media stream, so its element plays out instead of stalling.
     * Waits until the epoch's output exists.
     */
    private completeEndedAudioTrack(generationRecord: GenerationRecord): void {
        if (!generationRecord.audioTrackEnded || !this.isGenerationCurrent(generationRecord)) {
            return;
        }
        if (generationRecord.audioOutputMode === 'native-media') {
            const nativeAudioBridge = this.activeNativeAudioBridge;
            if (!generationRecord.nativeAudioBridgeStarted || !nativeAudioBridge) {
                return;
            }
            this.requestNativeAudioEndOfStream(generationRecord, nativeAudioBridge);
        } else if (!this.activeAudioBridge) {
            return;
        }
        if (generationRecord.audioResyncPending) {
            generationRecord.audioResyncPending = false;
            this.telemetry.audioResyncPending = false;
            this.emitEvent({
                audioEpoch: generationRecord.audioEpoch,
                generation: generationRecord.generation,
                type: 'audio-resynced'
            });
            return;
        }
        generationRecord.audioMediaReady = true;
        this.emitReadyEventIfMediaReady(generationRecord);
    }

    /** Records the decoded source format of the current audio epoch, which outranks the declared one. */
    private handleAudioSourceFormatResponse(
        generationRecord: GenerationRecord,
        message: DecodeWorkerAudioSourceFormatResponse
    ): void {
        if (message.audioEpoch !== generationRecord.audioEpoch) {
            return;
        }
        this.telemetry.decodedAudioSourceChannelCount = message.channelCount;
        this.telemetry.audioSourceChannelCount = message.channelCount;
        this.telemetry.audioSourceSampleRate = message.sampleRate;
    }

    /** Marks the native media stream complete once, so its element plays to the end of its media. */
    private requestNativeAudioEndOfStream(
        generationRecord: GenerationRecord,
        nativeAudioBridge: CustomDecodeNativeAudioBridge
    ): void {
        if (generationRecord.nativeAudioEndOfStreamRequested) {
            return;
        }
        generationRecord.nativeAudioEndOfStreamRequested = true;
        void nativeAudioBridge.endOfStream(generationRecord.generation).then(ended => {
            if (!this.isGenerationCurrent(generationRecord) || this.activeNativeAudioBridge !== nativeAudioBridge) {
                return;
            }
            if (!ended) {
                this.handleAudioOutputFailure(generationRecord, 'Native audio output rejected end of stream');
                return;
            }
            generationRecord.nativeAudioEndOfStreamAccepted = true;
            this.completeNativeAudioWorkerEndedIfReady(generationRecord);
        });
    }

    private handleVideoInterruptedResponse(
        generationRecord: GenerationRecord,
        message: DecodeWorkerVideoInterruptedResponse
    ): void {
        // An interruption of a replaced epoch is superseded by the pending request
        if (message.videoEpoch !== generationRecord.videoEpoch) {
            return;
        }
        this.emitEvent({
            generation: generationRecord.generation,
            reason: message.reason,
            type: 'video-interrupted'
        });
    }

    /** Drops a frame that was in flight when its video epoch was replaced. */
    private discardStaleEpochFrame(generationRecord: GenerationRecord, message: DecodeWorkerFrameResponse): void {
        this.telemetry.staleFrameCount += 1;
        if (message.outputMode === 'video-frame') {
            message.frame.close();
            this.requestReplacementFrames(generationRecord, 1);
            return;
        }
        if (!this.recycleFrameBuffer(generationRecord, message.frame.data)) {
            this.telemetry.abandonedRawFrameCount += 1;
        }
    }

    private stopActiveAudioPaths(generation: number | null): void {
        this.activeAudioBridge?.stop(generation);
        this.activeAudioBridge = null;
        if (this.activeNativeAudioBridge) {
            const nativeAudioBridge = this.activeNativeAudioBridge;
            const stopPromise = generation === null ? nativeAudioBridge.stop() : nativeAudioBridge.stop(generation);
            this.nativeAudioStopScheduled = true;
            this.nativeAudioStopTail = Promise.all([
                this.nativeAudioStopTail,
                stopPromise
            ]).then((): void => undefined);
            void this.nativeAudioStopTail.catch((): void => undefined);
            this.activeNativeAudioBridge = null;
        }
    }

    private handleDecodeProtocolFailure(generationRecord: GenerationRecord, message: string): void {
        if (!this.isGenerationCurrent(generationRecord)) {
            return;
        }
        this.failGeneration(generationRecord, 'decode-failed', message);
    }

    private enqueueFrame(generationRecord: GenerationRecord, message: DecodeWorkerFrameResponse): void {
        if (!this.validateRawFrameGeometry(generationRecord, message)) {
            return;
        }
        const maximumQueuedFrames = generationRecord.videoOutputMode === 'raw-planes' ?
            MAX_DECODED_RAW_FRAME_CREDITS :
            MAX_DECODED_FRAME_CREDITS;
        const boundedFrameCount = generationRecord.videoOutputMode === 'raw-planes' ?
            this.queuedFrames.length + this.pendingFrames.size :
            this.queuedFrames.length;
        if (message.outputMode !== generationRecord.videoOutputMode || boundedFrameCount >= maximumQueuedFrames) {
            if (message.outputMode === 'video-frame') {
                message.frame.close();
            } else {
                this.telemetry.abandonedRawFrameCount += 1;
            }
            const messageText = message.outputMode === generationRecord.videoOutputMode ?
                FRAME_QUEUE_BOUND_FAILURE :
                UNEXPECTED_FRAME_OUTPUT_MODE_FAILURE;
            this.failGeneration(generationRecord, 'decode-failed', messageText);
            return;
        }

        let presentationFrame: DecodedPresentationFrame;
        switch (message.outputMode) {
            case 'raw-planes':
                presentationFrame = {
                    durationMicroseconds: message.durationMicroseconds,
                    encodedDolbyVisionMetadata: message.encodedDolbyVisionMetadata,
                    HDR10PlusMetadata: message.HDR10PlusMetadata,
                    enhancementFrame: message.enhancementFrame,
                    frame: message.frame,
                    mediaTimeMicroseconds: message.mediaTimeMicroseconds,
                    outputMode: message.outputMode
                };
                break;
            case 'video-frame':
                presentationFrame = {
                    durationMicroseconds: message.durationMicroseconds,
                    encodedDolbyVisionMetadata: message.encodedDolbyVisionMetadata,
                    HDR10PlusMetadata: message.HDR10PlusMetadata,
                    frame: message.frame,
                    mediaTimeMicroseconds: message.mediaTimeMicroseconds,
                    outputMode: message.outputMode
                };
                break;
        }
        const queuedFrame: QueuedFrame = {
            generationRecord,
            presentationFrame
        };
        let insertionIndex = this.queuedFrames.length;
        while (
            insertionIndex > 0
            && this.queuedFrames[insertionIndex - 1].presentationFrame.mediaTimeMicroseconds
                > presentationFrame.mediaTimeMicroseconds
        ) {
            insertionIndex -= 1;
        }
        this.queuedFrames.splice(insertionIndex, 0, queuedFrame);

        generationRecord.videoMediaReady = true;
        this.telemetry.firstFrameMediaTimeMicroseconds ??= presentationFrame.mediaTimeMicroseconds;
        this.telemetry.lastFrameMediaTimeMicroseconds = presentationFrame.mediaTimeMicroseconds;
        this.telemetry.lastFrameEndMediaTimeMicroseconds = addMicroseconds(
            presentationFrame.mediaTimeMicroseconds,
            presentationFrame.durationMicroseconds
        );
        this.telemetry.queuedFrameCount = this.queuedFrames.length;
        this.telemetry.peakFrameCount = Math.max(this.telemetry.peakFrameCount, this.queuedFrames.length + this.pendingFrames.size);
        this.telemetry.receivedFrameCount += 1;
        recordTimingEvent('frame-arrived', {
            durationMicroseconds: presentationFrame.durationMicroseconds,
            mediaTimeMicroseconds: presentationFrame.mediaTimeMicroseconds,
            pendingFrameCount: this.pendingFrames.size,
            queuedFrameCount: this.queuedFrames.length
        });
        this.recordDolbyVisionMetadata(message);
        this.recordHDR10PlusMetadata(message);
        this.emitReadyEventIfMediaReady(generationRecord);
    }

    private recordDolbyVisionMetadata(message: DecodeWorkerFrameResponse): void {
        const metadata = message.encodedDolbyVisionMetadata;
        if (!metadata) {
            return;
        }

        this.telemetry.receivedDolbyVisionFrameCount += 1;
        this.telemetry.receivedDolbyVisionRPUCount += metadata.parsedRPUData.length;
        if (metadata.hasEnhancementLayerVCL) {
            this.telemetry.receivedDolbyVisionEnhancementFrameCount += 1;
        }
    }

    private recordHDR10PlusMetadata(message: DecodeWorkerFrameResponse): void {
        switch (message.HDR10PlusMetadata?.status) {
            case 'absent':
                this.telemetry.receivedHDR10PlusAbsentFrameCount += 1;
                break;
            case 'conflicting':
                this.telemetry.receivedHDR10PlusConflictingFrameCount += 1;
                break;
            case 'malformed':
                this.telemetry.receivedHDR10PlusMalformedFrameCount += 1;
                break;
            case 'unsupported':
                this.telemetry.receivedHDR10PlusUnsupportedFrameCount += 1;
                break;
            case 'valid':
                this.telemetry.receivedHDR10PlusValidFrameCount += 1;
                break;
            case undefined:
                break;
        }
    }

    private validateRawFrameGeometry(generationRecord: GenerationRecord, message: DecodeWorkerFrameResponse): boolean {
        if (message.outputMode !== 'raw-planes') {
            return true;
        }
        const videoGeometry = generationRecord.videoGeometry;
        if (!videoGeometry) {
            this.telemetry.abandonedRawFrameCount += 1;
            this.handleDecodeProtocolFailure(generationRecord, 'Decoded raw frame arrived before video track configuration');
            return false;
        }
        try {
            generationRecord.decodedVideoGeometry = requireConsistentDecodedVideoGeometry(
                {
                    codedHeight: message.frame.codedHeight,
                    codedWidth: message.frame.codedWidth,
                    displayHeight: message.frame.displayHeight,
                    displayWidth: message.frame.displayWidth
                },
                videoGeometry,
                generationRecord.maximumCodedWidth,
                generationRecord.maximumCodedHeight,
                generationRecord.decodedVideoGeometry
            );
            return true;
        } catch (error) {
            this.telemetry.abandonedRawFrameCount += 1;
            const messageText = error instanceof DecodedVideoGeometryError ?
                error.message :
                'Decoded raw frame geometry is invalid';
            this.handleDecodeProtocolFailure(generationRecord, messageText);
            return false;
        }
    }

    /**
     * Accounts one chunk the worker's producer posted straight to the worklet.
     * Readiness, telemetry, and the bridge's drain accounting follow the progress, since the PCM itself never passes this thread.
     */
    private recordAudioProgress(generationRecord: GenerationRecord, message: DecodeWorkerAudioProgressResponse): void {
        if (message.audioEpoch !== generationRecord.audioEpoch) {
            // A replaced attempt's chunks went to a channel its worklet flush detached
            this.telemetry.staleAudioSampleCount += 1;
            return;
        }
        this.telemetry.lastAudioMediaTimeMicroseconds = message.mediaTimeMicroseconds;
        this.telemetry.receivedAudioFrameCount += message.frameCount;
        this.telemetry.receivedAudioSampleCount += 1;

        const audioConfiguration = generationRecord.audioConfiguration;
        const audioBridge = this.activeAudioBridge;
        if (!audioConfiguration || !audioBridge || message.sampleRate !== audioConfiguration.sampleRate) {
            this.handleAudioOutputFailure(generationRecord, 'Decoded audio did not match the configured output');
            return;
        }

        if (audioBridge.recordSubmission(message, generationRecord.generation) === 'stale-generation') {
            this.telemetry.staleAudioSampleCount += 1;
            this.handleAudioOutputFailure(generationRecord, 'Decoded audio output generation became stale');
            return;
        }
        this.telemetry.submittedAudioFrameCount += message.frameCount;
        this.telemetry.submittedAudioSampleCount += 1;
        if (generationRecord.audioResyncPending) {
            this.recordResyncedAudioSubmission(generationRecord, message.frameCount, message.sampleRate);
            return;
        }
        generationRecord.audioMediaReady = audioFramesToMicroseconds(
            this.telemetry.submittedAudioFrameCount,
            message.sampleRate
        ) >= MINIMUM_DECODED_AUDIO_STARTUP_BUFFER_MICROSECONDS;
        this.emitReadyEventIfMediaReady(generationRecord);
    }

    /** Reports a resynced epoch once it has buffered the same minimum as startup */
    private recordResyncedAudioSubmission(
        generationRecord: GenerationRecord,
        frameCount: number,
        sampleRate: number
    ): void {
        generationRecord.audioEpochSubmittedFrameCount += frameCount;
        if (audioFramesToMicroseconds(
            generationRecord.audioEpochSubmittedFrameCount,
            sampleRate
        ) < MINIMUM_DECODED_AUDIO_STARTUP_BUFFER_MICROSECONDS) {
            return;
        }
        generationRecord.audioResyncPending = false;
        this.telemetry.audioResyncPending = false;
        this.emitEvent({
            audioEpoch: generationRecord.audioEpoch,
            generation: generationRecord.generation,
            type: 'audio-resynced'
        });
    }

    private enqueueNativeAudioInitialization(
        generationRecord: GenerationRecord,
        message: DecodeWorkerNativeAudioInitializationResponse
    ): void {
        const nativeAudioBridge = this.activeNativeAudioBridge;
        if (generationRecord.audioOutputMode !== 'native-media' || !nativeAudioBridge) {
            this.handleDecodeProtocolFailure(
                generationRecord,
                'The custom decode worker returned unexpected native audio initialization'
            );
            return;
        }
        void nativeAudioBridge.enqueueInitialization(message);
    }

    private enqueueNativeAudioMedia(generationRecord: GenerationRecord, message: DecodeWorkerNativeAudioMediaResponse): void {
        const nativeAudioBridge = this.activeNativeAudioBridge;
        if (generationRecord.audioOutputMode !== 'native-media' || !nativeAudioBridge) {
            this.handleDecodeProtocolFailure(generationRecord, 'The custom decode worker returned unexpected native audio media');
            return;
        }
        this.telemetry.lastAudioMediaTimeMicroseconds = message.startTimeMicroseconds;
        this.telemetry.receivedAudioSampleCount += 1;
        this.telemetry.receivedNativeAudioSegmentCount += 1;
        void nativeAudioBridge.enqueueMedia(message).then(appended => {
            if (appended && this.isGenerationCurrent(generationRecord) && this.activeNativeAudioBridge === nativeAudioBridge) {
                generationRecord.audioMediaReady = true;
                this.emitReadyEventIfMediaReady(generationRecord);
            }
        });
    }

    private handleWorkerEnded(generationRecord: GenerationRecord): void {
        generationRecord.decodeEnded = true;
        if (generationRecord.audioOutputMode !== 'native-media' || !generationRecord.audioRequested) {
            this.completeWorkerEnded(generationRecord);
            return;
        }
        const nativeAudioBridge = this.activeNativeAudioBridge;
        if (!nativeAudioBridge) {
            this.handleAudioOutputFailure(generationRecord, 'Native audio output ended without an active backend');
            return;
        }
        // The audio end usually requested end of stream already; a bridge still opening requests it once started
        if (generationRecord.nativeAudioBridgeStarted) {
            this.requestNativeAudioEndOfStream(generationRecord, nativeAudioBridge);
        }
        this.completeNativeAudioWorkerEndedIfReady(generationRecord);
    }

    /** Ends a native-media session once decode ended and the element played out its completed stream. */
    private completeNativeAudioWorkerEndedIfReady(generationRecord: GenerationRecord): void {
        // Audio that ended before video ends its element first; video still plays on
        if (!generationRecord.decodeEnded || !generationRecord.nativeAudioElementEnded || !generationRecord.nativeAudioEndOfStreamAccepted) {
            return;
        }
        this.completeWorkerEnded(generationRecord);
    }

    private completeWorkerEnded(generationRecord: GenerationRecord): void {
        if (!this.isGenerationCurrent(generationRecord) || this.telemetry.state === 'ended') {
            return;
        }
        this.telemetry.state = 'ended';
        this.emitEvent({ generation: generationRecord.generation, type: 'ended' });
    }

    private requestReplacementFrames(generationRecord: GenerationRecord, frameCredits: number): void {
        if (!this.isGenerationCurrent(generationRecord) || frameCredits <= 0) {
            return;
        }

        try {
            this.postRequest(generationRecord, {
                frameCredits,
                generation: generationRecord.generation,
                type: 'pull'
            });
        } catch {
            this.failGenerationWithUnusableWorker(generationRecord, 'Unable to request more decoded frames');
        }
    }

    /** Returns native media audio segment credits; decoded PCM takes its credits from the worker's producer. */
    private requestReplacementAudioSamples(generationRecord: GenerationRecord, audioSampleCredits: number): void {
        if (
            this.activeGeneration !== generationRecord
            || audioSampleCredits <= 0
            || !Number.isSafeInteger(audioSampleCredits)
        ) {
            return;
        }

        try {
            this.postRequest(generationRecord, {
                audioSampleCredits,
                generation: generationRecord.generation,
                type: 'pull-audio'
            });
        } catch {
            this.handleAudioOutputFailure(generationRecord, 'Unable to request more decoded audio');
        }
    }

    /** Hands the worker's producer its channel to the worklet; the epoch's audio attempt starts once the channel arrives. */
    private attachAudioOutput(generationRecord: GenerationRecord, audioOutput: DecodeWorkerAudioOutputAttachment): void {
        try {
            this.postRequest(generationRecord, {
                audioEpoch: generationRecord.audioEpoch,
                audioOutput,
                generation: generationRecord.generation,
                type: 'attach-audio-output'
            }, [ audioOutput.port ]);
        } catch {
            audioOutput.port.close();
            this.handleAudioOutputFailure(generationRecord, 'Unable to attach decoded audio output');
        }
    }

    private handleAudioOutputFailure(generationRecord: GenerationRecord, message: string): void {
        if (this.activeGeneration !== generationRecord) {
            return;
        }
        this.failGeneration(generationRecord, 'audio-output-failed', message);
    }

    /**
     * Fails a generation: its outputs stop, its frames close, and its run retires.
     * Its worker is replaced rather than reused, since a failed run may leave decoder state behind.
     */
    private failGeneration(
        generationRecord: GenerationRecord,
        failureKind: CustomDecodeFailureKind,
        message: string
    ): void {
        if (this.activeGeneration === generationRecord) {
            this.activeGeneration = null;
        }
        this.stopActiveAudioPaths(generationRecord.generation);
        this.closeQueuedFrames();
        this.clearPendingFrames();
        this.retireGeneration(generationRecord);
        const workerRecord = generationRecord.workerRecord;
        if (workerRecord) {
            this.requireWorkerReplacement(workerRecord);
        }
        this.failSession(generationRecord.generation, failureKind, message);
    }

    /** Fails a generation whose worker refused a message; a worker that cannot take messages cannot finish its run either. */
    private failGenerationWithUnusableWorker(generationRecord: GenerationRecord, message: string): void {
        const workerRecord = generationRecord.workerRecord;
        if (workerRecord) {
            this.terminateWorker(workerRecord);
        }
        this.failGeneration(generationRecord, 'decode-failed', message);
    }

    private failSession(
        generation: number,
        failureKind: CustomDecodeFailureKind,
        message: string
    ): void {
        this.telemetry.activeGeneration = generation;
        this.telemetry.failureKind = failureKind;
        this.telemetry.state = 'error';
        this.emitEvent({ failureKind, generation, message, type: 'error' });
    }

    private emitEvent(event: CustomDecodeSessionEvent): void {
        try {
            this.eventHandler(event);
        } catch (error) {
            console.warn('Custom decode session event handler failed', error);
        }
    }

    /** Posts to the worker that took the generation's start; an idle worker drops requests of a run that already stopped. */
    private postRequest(
        generationRecord: GenerationRecord,
        request: DecodeWorkerRequest,
        transfer?: Transferable[]
    ): void {
        const workerRecord = generationRecord.workerRecord;
        if (!workerRecord) {
            throw new Error('The custom decode generation has not reached its worker');
        }
        workerRecord.worker.postMessage(request, transfer ?? []);
    }

    private abandonPresentationFrame(presentationFrame: DecodedPresentationFrame): void {
        if (presentationFrame.outputMode === 'raw-planes') {
            this.telemetry.abandonedRawFrameCount += 1;
            return;
        }

        closePresentationFrame(presentationFrame);
    }

    private closeQueuedFrames(): void {
        for (const queuedFrame of this.queuedFrames) {
            this.abandonPresentationFrame(queuedFrame.presentationFrame);
        }
        this.queuedFrames.length = 0;
        this.telemetry.queuedFrameCount = 0;
    }

    private clearPendingFrames(): void {
        for (const presentationFrame of this.pendingFrames.keys()) {
            this.abandonPresentationFrame(presentationFrame);
        }
        this.pendingFrames.clear();
        this.telemetry.pendingFrameCount = 0;
    }

    private releasePendingFrame(presentationFrame: DecodedPresentationFrame): boolean {
        const generationRecord = this.pendingFrames.get(presentationFrame);
        if (!generationRecord) {
            return false;
        }

        this.pendingFrames.delete(presentationFrame);
        this.telemetry.pendingFrameCount = this.pendingFrames.size;
        if (presentationFrame.outputMode === 'raw-planes') {
            if (!this.recycleFrameBuffer(generationRecord, presentationFrame.frame.data)) {
                this.abandonPresentationFrame(presentationFrame);
            }
        } else {
            this.requestReplacementFrames(generationRecord, 1);
        }
        return true;
    }

    private recycleFrameBuffer(generationRecord: GenerationRecord, buffer: ArrayBuffer): boolean {
        if (!this.isGenerationCurrent(generationRecord)) {
            return false;
        }

        try {
            this.postRequest(generationRecord, {
                buffer,
                generation: generationRecord.generation,
                type: 'recycle-frame'
            }, [ buffer ]);
            this.telemetry.recycledRawFrameCount += 1;
            return true;
        } catch {
            this.failGenerationWithUnusableWorker(generationRecord, 'Unable to recycle the decoded raw frame buffer');
            return false;
        }
    }
}
