// Builders of the engine telemetry and media descriptions the playback info tests describe, idle unless overridden.
import type { AudioWorkletTelemetry } from 'webgpu-player/audio/output/AudioWorkletProtocol';
import type { CustomDecodeAudioBridgeTelemetry } from 'webgpu-player/audio/output/CustomDecodeAudioBridge';
import { EXTERNAL_HDR_AUTHORIZATION_VECTOR_VERSION } from 'webgpu-player/capability/vectors/ExternalHDRAuthorizationVector';
import type { Microseconds } from 'webgpu-player/MediaTime';
import type { CustomDecodeSessionTelemetry } from 'webgpu-player/pipeline/CustomDecodeSession';
import type { CustomPlaybackTelemetry } from 'webgpu-player/pipeline/CustomPlaybackControllerTypes';
import { RENDER_SETTINGS_VERSION } from 'webgpu-player/presentation/RenderSettings';
import type { PresentationTelemetry } from 'webgpu-player/presentation/WebGPUPresenter';
import { requireMicroseconds } from 'webgpu-player/TimeMath';
import {
    DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
    DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION,
    type DolbyVisionAuthorizationTelemetry
} from 'webgpu-player/validation/DolbyVisionPresentationAuthorization';
import {
    EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
    EXTERNAL_DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION,
    type ExternalDolbyVisionAuthorizationTelemetry
} from 'webgpu-player/validation/ExternalDolbyVisionPresentationAuthorization';
import type { ExternalHDRAuthorizationTelemetry } from 'webgpu-player/validation/ExternalHDRPresentationAuthorization';
import {
    RAW_HDR_AUTHORIZATION_VECTOR_VERSION,
    type RawHDRAuthorizationTelemetry
} from 'webgpu-player/validation/RawHDRPresentationAuthorization';

import type {
    AudioTrackDescription,
    MediaDescription,
    SubtitleTrackDescription,
    VideoTrackDescription
} from '../../../sandbox/src/contracts/SandboxContracts';

const ZERO_MICROSECONDS = requireMicroseconds(0);
const TEST_MEDIA_PATH = 'movies/test.mkv';
const TEST_CONTAINER = 'matroska';
const TEST_VIDEO_CODEC = 'hevc';
const TEST_AUDIO_CODEC = 'aac';
const TEST_SUBTITLE_CODEC = 'subrip';
const TEST_WIDTH = 1920;
const TEST_HEIGHT = 1080;
const TEST_CHANNEL_COUNT = 2;
const TEST_SAMPLE_RATE = 48_000;
const TEST_PLAYBACK_RATE = 1;
const TEST_GENERATION = 1;
const TEST_VOLUME = 1;
const TEST_GAIN = 1;

export function createDecodeSessionTelemetry(overrides: Partial<CustomDecodeSessionTelemetry> = {}): CustomDecodeSessionTelemetry {
    return {
        abandonedRawFrameCount: 0,
        activeGeneration: null,
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
        gpuVideoDecode: null,
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
        receivedFrameCount: 0,
        receivedHDR10PlusAbsentFrameCount: 0,
        receivedHDR10PlusConflictingFrameCount: 0,
        receivedHDR10PlusMalformedFrameCount: 0,
        receivedHDR10PlusUnsupportedFrameCount: 0,
        receivedHDR10PlusValidFrameCount: 0,
        receivedNativeAudioSegmentCount: 0,
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
        workerReused: false,
        ...overrides
    };
}

export function createControllerTelemetry(overrides: Partial<CustomPlaybackTelemetry> = {}): CustomPlaybackTelemetry {
    return {
        activeGeneration: null,
        audioBridge: null,
        audioOutput: null,
        audioOutputSwitchPending: false,
        audioPath: 'disabled',
        clock: { generation: TEST_GENERATION, mediaTimeMicroseconds: ZERO_MICROSECONDS, paused: true, playbackRate: TEST_PLAYBACK_RATE },
        currentTimeMicroseconds: ZERO_MICROSECONDS,
        discardedStaleVideoFrameCount: 0,
        durationMicroseconds: null,
        fallbackCount: 0,
        fallbackReason: null,
        lastErrorMessage: null,
        lastVideoDecodeLag: null,
        muted: false,
        normalizationGain: TEST_GAIN,
        pageHidden: false,
        playCount: 0,
        presentationTiming: {
            clockResetCount: 0,
            largestClockJumpMicroseconds: ZERO_MICROSECONDS,
            lateFrameCount: 0,
            worstFrameLagMicroseconds: ZERO_MICROSECONDS
        },
        staleEventCount: 0,
        startupDurationMicroseconds: null,
        state: 'idle',
        videoDecode: createDecodeSessionTelemetry(),
        videoResyncPending: false,
        videoSuspended: false,
        volume: TEST_VOLUME,
        ...overrides
    };
}

export function createPresenterTelemetry(overrides: Partial<PresentationTelemetry> = {}): PresentationTelemetry {
    return {
        appliedHDR10PlusFrameCount: 0,
        carriedHDR10PlusFrameCount: 0,
        decodedFrameCount: 0,
        deviceRecoveryCount: 0,
        dolbyVisionDualLayerFELBaseFallbackPresentedFrameCount: 0,
        dolbyVisionDualLayerFELPresentedFrameCount: 0,
        dolbyVisionDualLayerMELPresentedFrameCount: 0,
        dolbyVisionFELAuthorizationFailure: null,
        fallbackDetail: null,
        fallbackReason: null,
        firstFrameLatencyMicroseconds: null,
        firstPresentedMediaTimeMicroseconds: null,
        lastCallbackTimeMicroseconds: null,
        lastExpectedDisplayTimeMicroseconds: null,
        lastHDR10PlusInputPeakNits: null,
        lastHDR10PlusMetadataStatus: null,
        lastPresentedMediaTimeMicroseconds: null,
        mode: 'identity-sdr',
        nativeFrameCount: 0,
        presentationSkipReason: null,
        presentationSource: null,
        presentedFrameCount: 0,
        sessionStartedMicroseconds: ZERO_MICROSECONDS,
        staticFallbackHDR10PlusFrameCount: 0,
        state: 'idle',
        ...overrides
    };
}

export function createWorkletTelemetry(overrides: Partial<AudioWorkletTelemetry> = {}): AudioWorkletTelemetry {
    return {
        consumedFrames: 0,
        droppedFrames: 0,
        generation: TEST_GENERATION,
        hasPhysicalOutputTimeCorrelation: false,
        mediaTimeContextTimeMicroseconds: null,
        mediaTimeMicroseconds: ZERO_MICROSECONDS,
        muted: false,
        outputFrames: 0,
        overflowEvents: 0,
        overflowFrames: 0,
        playing: false,
        queuedFrames: 0,
        reason: 'periodic',
        sequence: null,
        staleChunks: 0,
        type: 'telemetry',
        underflowEvents: 0,
        underflowFrames: 0,
        volume: TEST_VOLUME,
        ...overrides
    };
}

export function createBridgeTelemetry(overrides: Partial<CustomDecodeAudioBridgeTelemetry> = {}): CustomDecodeAudioBridgeTelemetry {
    return {
        activeDecodeGeneration: null,
        failed: false,
        pendingFrameCount: 0,
        pendingSampleCount: 0,
        releasedSampleCredits: 0,
        staleSampleCount: 0,
        submittedEndMediaTimeMicroseconds: null,
        submittedFrameCount: 0,
        submittedSampleCount: 0,
        workletGeneration: null,
        ...overrides
    };
}

export function createRawHDRAuthorization(overrides: Partial<RawHDRAuthorizationTelemetry> = {}): RawHDRAuthorizationTelemetry {
    return {
        authorizedRouteKeys: [],
        failureDetails: {},
        failureReasons: {},
        pendingRouteKeys: [],
        rejectedRouteKeys: [],
        renderSettingsVersion: RENDER_SETTINGS_VERSION,
        status: 'unavailable',
        targetFormat: null,
        vectorVersion: RAW_HDR_AUTHORIZATION_VECTOR_VERSION,
        ...overrides
    };
}

export function createExternalHDRAuthorization(overrides: Partial<ExternalHDRAuthorizationTelemetry> = {}): ExternalHDRAuthorizationTelemetry {
    return {
        authorizedRouteKeys: [],
        failureDetails: {},
        failureReasons: {},
        maximumChannelErrors: {},
        pendingRouteKeys: [],
        rejectedRouteKeys: [],
        renderSettingsVersion: RENDER_SETTINGS_VERSION,
        sampleCounts: {},
        status: 'unavailable',
        targetFormat: null,
        vectorVersion: EXTERNAL_HDR_AUTHORIZATION_VECTOR_VERSION,
        ...overrides
    };
}

export function createDolbyVisionAuthorization(overrides: Partial<DolbyVisionAuthorizationTelemetry> = {}): DolbyVisionAuthorizationTelemetry {
    return {
        failureDetail: null,
        failureReason: null,
        maximumChannelError: null,
        renderSettingsVersion: RENDER_SETTINGS_VERSION,
        routeKey: DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
        sampleCount: 0,
        status: 'unavailable',
        targetFormat: null,
        vectorVersion: DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION,
        ...overrides
    };
}

export function createExternalDolbyVisionAuthorization(
    overrides: Partial<ExternalDolbyVisionAuthorizationTelemetry> = {}
): ExternalDolbyVisionAuthorizationTelemetry {
    return {
        failureDetail: null,
        failureReason: null,
        maximumChannelError: null,
        maximumInputChannelError: null,
        renderSettingsVersion: RENDER_SETTINGS_VERSION,
        routeKey: EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
        sampleCount: 0,
        status: 'unavailable',
        targetFormat: null,
        vectorVersion: EXTERNAL_DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION,
        ...overrides
    };
}

export function createVideoTrack(overrides: Partial<VideoTrackDescription> = {}): VideoTrackDescription {
    return {
        bitDepth: null,
        codec: TEST_VIDEO_CODEC,
        codedHeight: TEST_HEIGHT,
        codedWidth: TEST_WIDTH,
        color: null,
        displayHeight: TEST_HEIGHT,
        displayWidth: TEST_WIDTH,
        dolbyVision: null,
        dynamicRange: 'sdr',
        frameRate: null,
        index: 0,
        language: null,
        level: null,
        name: null,
        profile: null,
        ...overrides
    };
}

export function createAudioTrack(overrides: Partial<AudioTrackDescription> = {}): AudioTrackDescription {
    return {
        channelCount: TEST_CHANNEL_COUNT,
        codec: TEST_AUDIO_CODEC,
        profile: null,
        default: false,
        index: 1,
        language: null,
        name: null,
        sampleRate: TEST_SAMPLE_RATE,
        ...overrides
    };
}

export function createSubtitleTrack(overrides: Partial<SubtitleTrackDescription> = {}): SubtitleTrackDescription {
    return {
        codec: TEST_SUBTITLE_CODEC,
        default: false,
        forced: false,
        index: 2,
        language: null,
        name: null,
        textBased: true,
        ...overrides
    };
}

export function createMediaDescription(overrides: Partial<MediaDescription> = {}): MediaDescription {
    return {
        audioTracks: [],
        container: TEST_CONTAINER,
        durationMicroseconds: null,
        path: TEST_MEDIA_PATH,
        sizeBytes: 0,
        subtitleTracks: [],
        videoTracks: [],
        ...overrides
    };
}

/** Integer microseconds from a test's named value. */
export function microseconds(value: number): Microseconds {
    return requireMicroseconds(value);
}
