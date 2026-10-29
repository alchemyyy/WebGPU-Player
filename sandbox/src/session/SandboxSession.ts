// The sandbox's playback session: it probes a picked file with ffprobe, chooses the route through the engine's eligibility, and drives the engine's presenter, controller, and frame loop.
import { CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE } from 'webgpu-player/audio/CustomAudioOutputPolicy';
import CustomDecodeNativeAudioBridge from 'webgpu-player/audio/native/CustomDecodeNativeAudioBridge';
import { selectCustomAudioOutputLayout, selectCustomAudioSpeakerLayout } from 'webgpu-player/audio/NativeMultichannelAudioOutput';
import { prewarmBrowserAudioContext, type BrowserAudioContextPrewarmLease } from 'webgpu-player/audio/output/BrowserAudioContextPrewarm';
import {
    createBrowserCustomAudioOutputFactory,
    type BrowserCustomAudioOutputOptions
} from 'webgpu-player/audio/output/BrowserCustomAudioOutput';
import { getWebGPUAudioOutputManager } from 'webgpu-player/audio/output/WebGPUAudioOutputManager';
import { createDefaultAudioDownmixSettings } from 'webgpu-player/audio/processing/CustomAudioDownmix';
import { DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM } from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import { probeCustomDecodeCapabilities } from 'webgpu-player/capability/CustomDecodeCapabilities';
import {
    getAudioMetadataLayout,
    getCustomPlaybackEligibility,
    type CustomAudioRenderTarget,
    type EligibleCustomPlayback
} from 'webgpu-player/capability/CustomPlaybackEligibility';
import { getCustomPlaybackRuntimeAvailability } from 'webgpu-player/capability/CustomPlaybackRuntime';
import { probeCachedNativeMediaAudioCapabilities } from 'webgpu-player/capability/NativeMediaAudioCapabilities';
import { type Microseconds } from 'webgpu-player/MediaTime';
import type { CustomDecodeMediaSource } from 'webgpu-player/demux/CustomDecodeMediaSource';
import CustomPlaybackController from 'webgpu-player/pipeline/CustomPlaybackController';
import type {
    CustomPlaybackControllerEvent,
    CustomPlaybackFallbackRequest,
    CustomPlaybackPlayOptions,
    CustomPlaybackStartResult,
    CustomPlaybackState
} from 'webgpu-player/pipeline/CustomPlaybackControllerTypes';
import CustomPlaybackFrameLoop from 'webgpu-player/pipeline/CustomPlaybackFrameLoop';
import type { DeinterlaceMode } from 'webgpu-player/presentation/DeinterlaceTimeline';
import { PASS_FILE_EXTENSION } from 'webgpu-player/presentation/passes/PassLanguage';
import { parsePassFile, type PassFileEntry } from 'webgpu-player/presentation/passes/PassManifest';
import type { PassParameter } from 'webgpu-player/presentation/passes/PassTypes';
import {
    alignPresentationInputBitDepth,
    configurePresentationColorPipeline,
    createGPUVideoDecodeSessionFactory,
    DEFAULT_DOLBY_VISION_RAW_FRAME_FORMAT,
    EMPTY_PRESENTATION_INPUT,
    getCustomPresentationEligibilityOptions,
    getGPUVideoDecoderOffers,
    getStaticHDRRenderSettings,
    isWebGPUPresentationInput,
    readPresentationInput,
    type GPUVideoDecodeSessionFactoryOptions,
    type HDRRenderConfiguration,
    type PresentationInput
} from 'webgpu-player/presentation/PresentationSetup';
import {
    createHDRToSDRRenderSettings,
    HDR_RENDER_SETTING_RANGES,
    type HDRToSDRRenderSettings
} from 'webgpu-player/presentation/RenderSettings';
import WebGPUPresenter, {
    type PresentationFallbackReason,
    type PresentationPresetFile,
    type PresentationSurface
} from 'webgpu-player/presentation/WebGPUPresenter';
import { requireMicroseconds } from 'webgpu-player/TimeMath';
import type { DolbyVisionAuthorizationRoute } from 'webgpu-player/validation/DolbyVisionPresentationAuthorization';
import { isRawDolbyVisionVideoFrameFormat } from 'webgpu-player/decode/video/RawVideoFrameCopy';

import {
    appendSandboxFailure,
    DEFAULT_SUBTITLE_SELECTION,
    describeError,
    getDefaultAudioTrackIndex,
    type ActiveRoute,
    type AuthorizationTelemetry,
    type BuiltShaderPass,
    type PlaybackState,
    type PlaybackStatus,
    type AudioOutputSettings,
    type RouteOverride,
    type SandboxFailure,
    type SandboxFilePass,
    type SandboxMediaFile,
    type SandboxSessionCommands,
    type SandboxShaderFile,
    type SandboxState,
    type SubtitleSelection
} from '../contracts/SandboxContracts';
import type { SandboxStore } from '../ui/Panel';
import { fetchBuiltPassSource, listBuiltPasses } from './BuiltPasses';
import { createSandboxDecoderPackages } from './DecoderPackages';
import { createFFmpegTool, type FFmpegTool } from './FFmpegTool';
import { isContainerVideoStream, type FFprobeStream } from './FFprobeOutput';
import { probeMedia, type ProbedMedia } from './MediaProbe';
import { createPlaybackMediaSource } from './PlaybackMediaSource';
import {
    allowsGPUVideoDecoders,
    describeUnmetRouteOverride,
    narrowCapabilitiesForDecoder,
    narrowPresentationOptionsForTransport
} from './RouteOverride';
import { parseWebVTTCues } from './WebVTTCues';

export type SandboxSessionOptions = Readonly<{
    store: SandboxStore
    /** The full-window element the presenter's surface fills */
    surfaceContainer: HTMLDivElement
}>;

/** One open file's playback: what the probe found, and the engine objects of its current route. */
type Playback = {
    /** The audio context lease the route's audio output takes, released when the route stops */
    audioPrewarm: BrowserAudioContextPrewarmLease | null
    controller: CustomPlaybackController | null
    eligibility: EligibleCustomPlayback | null
    frameLoop: CustomPlaybackFrameLoop | null
    /** The presentation generation the route started in */
    generation: number
    input: PresentationInput
    /** The clock when the last route stopped, where a restart resumes */
    lastTimeMicroseconds: Microseconds
    media: SandboxMediaFile
    options: unknown
    probe: ProbedMedia
};

type FailureLayer = SandboxFailure['layer'];

// The play method the eligibility accepts; the sandbox reads the file directly
const DIRECT_PLAY_METHOD = 'DirectPlay';
const TELEMETRY_INTERVAL_MILLISECONDS = 250;
// The diagnostics panel shows the output's peak, RMS, and clipping, which the audio thread computes only on request
const SANDBOX_AUDIO_OUTPUT_OPTIONS: BrowserCustomAudioOutputOptions = Object.freeze({ analyzeSignal: true });
// Every packet's GPU decode work submits whole, slicing's default
const SANDBOX_GPU_VIDEO_DECODE_SESSION_OPTIONS: GPUVideoDecodeSessionFactoryOptions = Object.freeze({ slicing: false });
const START_TIME = requireMicroseconds(0);
const NO_MEDIA_PLAYING_DETAIL = 'no media playing';
const NO_MEDIA_OPEN_DETAIL = 'no media open';
const HIDDEN_DOCUMENT_STATE = 'hidden';
const VISIBILITY_CHANGE_EVENT = 'visibilitychange';
// What a route chosen without an override says about its choice
const ELIGIBILITY_SELECTION = 'eligibility';
const FILE_ID_PREFIX = 'file-';
const FIRST_FILE_NUMBER = 1;
const SINGLE_LAYER_AUTHORIZATION_ROUTE: DolbyVisionAuthorizationRoute = 'single-layer';
const DUAL_LAYER_AUTHORIZATION_ROUTES: ReadonlyMap<number, DolbyVisionAuthorizationRoute> = new Map<number, DolbyVisionAuthorizationRoute>([
    [ 4, 'profile4-fel' ],
    [ 7, 'profile7-fel' ]
]);
const PLAYBACK_STATUSES: Readonly<Record<CustomPlaybackState, PlaybackStatus>> = {
    ended: 'ended',
    error: 'failed',
    fallback: 'failed',
    idle: 'idle',
    paused: 'paused',
    playing: 'playing',
    seeking: 'seeking',
    starting: 'loading',
    stopping: 'loading'
};
const NO_AUTHORIZATION_TELEMETRY: AuthorizationTelemetry = Object.freeze({
    dolbyVision: null,
    externalDolbyVision: null,
    externalHDR: null,
    rawHDR: null
});

/** An error a command rejects with after recording its failure */
class RecordedCommandFailure extends Error {}

/** Returns whether the page is visible, and so gets animation frames. */
function isPageVisible(): boolean {
    // eslint-disable-next-line compat/compat -- The sandbox runs only where WebGPU does
    return !(typeof document !== 'undefined' && document.visibilityState === HIDDEN_DOCUMENT_STATE);
}

/** Returns the HDR settings that follow a stream's detected peak, with paper white no brighter than the peak. */
function createAutomaticRenderSettings(detectedInputPeakNits: number): HDRToSDRRenderSettings {
    const defaults = createHDRToSDRRenderSettings();
    const range = HDR_RENDER_SETTING_RANGES.inputPeakNits;
    const inputPeakNits = Math.min(Math.max(detectedInputPeakNits, range.minimum), range.maximum);
    return createHDRToSDRRenderSettings({
        toneMapping: { inputPeakNits, paperWhiteNits: Math.min(defaults.toneMapping.paperWhiteNits, inputPeakNits) }
    });
}

/** Describes a preset file for the shader panel: each of its passes, with its manifest when its header parses, else its header failure. */
function describeShaderFile(id: string, origin: string, source: string, parameters: Readonly<Record<string, number>>): SandboxShaderFile {
    const passes = parsePassFile(source).map((entry: PassFileEntry): SandboxFilePass => (
        entry.manifest === null ?
            { headerFailure: `line ${entry.error.line}: ${entry.error.message}`, manifest: null } :
            { headerFailure: null, manifest: entry.manifest }
    ));
    return { id, origin, parameters, passes, source };
}

/**
 * Returns the controller's play options for the eligibility's route from a time.
 * Decoded PCM takes the default downmix, the binaural setting, and the output layout the speaker layout gives the source: the whole layout for object audio, else its floor.
 */
function createPlayOptions(
    eligibility: EligibleCustomPlayback,
    startTimeMicroseconds: Microseconds,
    decodedAudio: boolean,
    audioRenderTarget: CustomAudioRenderTarget
): CustomPlaybackPlayOptions {
    return {
        ...(eligibility.audioDecoder ? { audioDecoder: eligibility.audioDecoder } : {}),
        audioDownmixAlgorithm: decodedAudio ? DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM : undefined,
        audioDownmixSettings: decodedAudio ? createDefaultAudioDownmixSettings() : undefined,
        audioMetadataLayout: getAudioMetadataLayout(eligibility),
        audioOutputMode: eligibility.audioOutputMode ?? undefined,
        audioRendersObjects: decodedAudio ? eligibility.audioRendersObjects === true : undefined,
        audioTrackIndex: eligibility.audioTrackIndex,
        binauralHeadphones: decodedAudio ? audioRenderTarget.binauralHeadphones : undefined,
        decodedAudioOutputLayout: decodedAudio ?
            selectCustomAudioOutputLayout(
                audioRenderTarget.speakerLayout,
                eligibility.audioSourceChannelCount,
                eligibility.audioRendersObjects === true
            ) :
            undefined,
        dolbyVisionProfile: eligibility.dolbyVisionProfile,
        durationMicroseconds: eligibility.durationMicroseconds,
        ...(eligibility.gpuVideoDecoder ? { gpuVideoDecoder: eligibility.gpuVideoDecoder } : {}),
        maximumCodedHeight: eligibility.maximumCodedHeight,
        maximumCodedWidth: eligibility.maximumCodedWidth,
        nativeHDRTransfer: eligibility.nativeHDRTransfer ?? null,
        neutralizeHDRColorMetadata: eligibility.neutralizeHDRColorMetadata,
        rawVideoFrameFormat: eligibility.rawVideoFrameFormat,
        source: eligibility.source,
        startTimeMicroseconds,
        videoDecoderBackend: eligibility.videoDecoderBackend,
        videoOutputMode: eligibility.videoOutputMode,
        videoTrackIndex: eligibility.videoTrackIndex
    };
}

function getFirstVideoTrackIndex(probe: ProbedMedia): number | null {
    return probe.output.streams.find((stream: FFprobeStream): boolean => isContainerVideoStream(stream))?.index ?? null;
}

function describeRoute(eligibility: EligibleCustomPlayback, override: RouteOverride): ActiveRoute {
    const overridden = override.decoder !== 'auto' || override.transport !== 'auto';
    return {
        audioOutputMode: eligibility.audioOutputMode,
        dolbyVisionProfile: eligibility.dolbyVisionProfile,
        gpuVideoDecoder: eligibility.gpuVideoDecoder ?? null,
        nativeHDRTransfer: eligibility.nativeHDRTransfer ?? null,
        neutralizeHDRColorMetadata: eligibility.neutralizeHDRColorMetadata,
        rawVideoFrameFormat: eligibility.rawVideoFrameFormat,
        selection: overridden ? `override decoder ${override.decoder}, transport ${override.transport}` : ELIGIBILITY_SELECTION,
        videoDecoderBackend: eligibility.videoDecoderBackend,
        videoOutputMode: eligibility.videoOutputMode
    };
}

export function createSandboxSession(options: SandboxSessionOptions): SandboxSessionCommands {
    const { store } = options;
    // The presenter places its canvas over the video's box and fits frames by its object-fit, so the video stays in the layout; theme.css hides it
    const video = document.createElement('video');
    video.muted = true;
    options.surfaceContainer.append(video);
    const surface: PresentationSurface = { container: options.surfaceContainer, video };
    let tool: FFmpegTool | null = null;
    let playback: Playback | null = null;
    let presentationGeneration = 0;
    let openRevision = 0;
    let subtitleRevision = 0;
    let fileNumber = FIRST_FILE_NUMBER;
    let files: SandboxShaderFile[] = [];
    // The tone mapping panel's settings, which replace the automatic ones until media changes
    let renderSettingsOverride: HDRToSDRRenderSettings | null = null;
    let telemetryTimer: ReturnType<typeof globalThis.setInterval> | null = null;

    const getTool = (): FFmpegTool => {
        tool ??= createFFmpegTool();
        return tool;
    };

    const recordFailure = (layer: FailureLayer, code: string, detail: string): void => {
        store.setState((state: SandboxState): Partial<SandboxState> => ({
            failures: appendSandboxFailure(state.failures, { code, detail, layer, timeMilliseconds: performance.now() })
        }));
    };

    /** Records a failure and returns the error the command rejects with. */
    const failCommand = (layer: FailureLayer, code: string, detail: string): Error => {
        recordFailure(layer, code, detail);
        return new RecordedCommandFailure(`${code}: ${detail}`);
    };

    /** Releases an audio context lease, which does nothing once an audio output took it. */
    const releaseAudioPrewarm = (audioPrewarm: BrowserAudioContextPrewarmLease): void => {
        audioPrewarm.close().catch((error: unknown): void => {
            recordFailure('session', 'audio-prewarm-release-failed', describeError(error));
        });
    };

    const releaseRouteAudioPrewarm = (current: Playback): void => {
        const audioPrewarm = current.audioPrewarm;
        current.audioPrewarm = null;
        if (audioPrewarm) {
            releaseAudioPrewarm(audioPrewarm);
        }
    };

    const publishPlayback = (update: Partial<PlaybackState>): void => {
        store.setState((state: SandboxState): Partial<SandboxState> => ({ playback: { ...state.playback, ...update } }));
    };

    /** Returns the playing route's controller, or records the command's failure and returns null. */
    const findController = (code: string): CustomPlaybackController | null => {
        const controller = playback?.controller ?? null;
        if (!controller) {
            recordFailure('session', code, NO_MEDIA_PLAYING_DETAIL);
        }
        return controller;
    };

    const advanceGeneration = (): number => {
        presentationGeneration += 1;
        return presentationGeneration;
    };

    const createHDRRenderConfiguration = (detectedInputPeakNits: number): HDRRenderConfiguration => (
        renderSettingsOverride === null ?
            { automaticInputPeakNits: true, settings: createAutomaticRenderSettings(detectedInputPeakNits) } :
            { automaticInputPeakNits: false, settings: renderSettingsOverride }
    );

    const getAuthorizationTelemetry = (current: Playback): AuthorizationTelemetry => {
        const eligibility = current.eligibility;
        const rawFormat = eligibility?.rawVideoFrameFormat ?? null;
        const dolbyVisionFormat = rawFormat !== null && isRawDolbyVisionVideoFrameFormat(rawFormat) ? rawFormat : DEFAULT_DOLBY_VISION_RAW_FRAME_FORMAT;
        const dolbyVisionRoute = DUAL_LAYER_AUTHORIZATION_ROUTES.get(eligibility?.dolbyVisionProfile ?? 0) ?? SINGLE_LAYER_AUTHORIZATION_ROUTE;
        const hasDolbyVision = current.input.dolbyVisionDescriptor !== null;
        return {
            dolbyVision: hasDolbyVision ? presenter.getDolbyVisionAuthorizationTelemetry(dolbyVisionRoute, dolbyVisionFormat) : null,
            externalDolbyVision: hasDolbyVision ? presenter.getExternalDolbyVisionAuthorizationTelemetry() : null,
            externalHDR: presenter.getExternalHDRAuthorizationTelemetry(),
            rawHDR: presenter.getRawHDRAuthorizationTelemetry()
        };
    };

    const publishTelemetry = (): void => {
        const current = playback;
        if (!current) {
            return;
        }
        const controller = current.controller;
        store.setState((state: SandboxState): Partial<SandboxState> => ({
            playback: { ...state.playback, durationMicroseconds: controller?.durationMicroseconds ?? current.probe.description.durationMicroseconds },
            presentation: {
                ...state.presentation,
                plan: presenter.getActivePresentationPlan(),
                renderSettings: presenter.getRenderSettings(),
                report: presenter.getPresentationPlanReport()
            },
            telemetry: {
                authorization: getAuthorizationTelemetry(current),
                controller: controller?.getTelemetry() ?? null,
                presenter: presenter.getTelemetry()
            }
        }));
    };

    const startTelemetry = (): void => {
        telemetryTimer ??= globalThis.setInterval(publishTelemetry, TELEMETRY_INTERVAL_MILLISECONDS);
    };

    const stopTelemetry = (): void => {
        if (telemetryTimer !== null) {
            globalThis.clearInterval(telemetryTimer);
            telemetryTimer = null;
        }
    };

    /** Stops the current route's engine objects, keeping the open media and its clock. */
    const stopRoute = (current: Playback): void => {
        current.frameLoop?.destroy();
        current.frameLoop = null;
        const controller = current.controller;
        current.controller = null;
        current.eligibility = null;
        presenter.endSession(advanceGeneration());
        if (controller) {
            current.lastTimeMicroseconds = controller.currentTimeMicroseconds;
            void controller.destroy();
        }
        releaseRouteAudioPrewarm(current);
    };

    const isRouteCurrent = (current: Playback, controller: CustomPlaybackController): boolean => (
        playback === current && current.controller === controller
    );

    const handleStartResult = (current: Playback, controller: CustomPlaybackController, result: CustomPlaybackStartResult): void => {
        if (!isRouteCurrent(current, controller)) {
            return;
        }
        if (result.status === 'fallback') {
            recordFailure('session', 'start-fallback', result.fallbackReason ?? result.status);
            publishPlayback({ status: 'failed' });
            return;
        }
        if (result.status === 'started' && controller.playbackState === 'paused') {
            current.frameLoop?.schedule(false);
        }
    };

    const handleControllerEvent = (current: Playback, controller: CustomPlaybackController, event: CustomPlaybackControllerEvent): void => {
        if (!isRouteCurrent(current, controller)) {
            return;
        }
        const frameLoop = current.frameLoop;
        switch (event.type) {
            case 'statechange':
                publishPlayback({ status: PLAYBACK_STATUSES[event.state] });
                if (event.state === 'paused' || event.state === 'playing') {
                    // A paused route polls once for its first frame; a playing one presents every frame
                    frameLoop?.cancel();
                    frameLoop?.schedule(event.state === 'playing');
                }
                break;
            case 'ready':
                publishPlayback({ durationMicroseconds: event.durationMicroseconds ?? current.probe.description.durationMicroseconds });
                if (controller.playbackState === 'paused') {
                    frameLoop?.schedule(false);
                }
                break;
            case 'playing':
                frameLoop?.schedule(true);
                break;
            case 'ended':
                frameLoop?.cancel();
                break;
            case 'error':
                recordFailure('session', event.recoverable ? 'pipeline-error' : 'pipeline-failed', event.message);
                break;
            case 'static-hdr-metadata': {
                const settings = getStaticHDRRenderSettings({
                    createHDRRenderConfiguration,
                    currentSettings: presenter.getRenderSettings(),
                    eligibility: current.eligibility,
                    input: current.input,
                    metadata: event.metadata,
                    options: current.options
                });
                if (settings) {
                    presenter.updateRenderSettings(settings, presentationGeneration, true);
                }
                break;
            }
            case 'audio-output-changed':
            case 'fallback-requested':
            case 'telemetry':
            case 'timeupdate':
            case 'waiting':
                break;
        }
    };

    /** The controller asks the host to fall back to a browser player, which the sandbox has not; it reports the reason and stops. */
    const handleFallback = (current: Playback, controller: CustomPlaybackController, fallbackRequest: CustomPlaybackFallbackRequest): void => {
        if (!isRouteCurrent(current, controller)) {
            return;
        }
        recordFailure('session', 'fallback', `${fallbackRequest.reason} at ${fallbackRequest.mediaTimeMicroseconds} us`);
        publishPlayback({ status: 'failed' });
        stopRoute(current);
    };

    const handlePresentationFallback = (generation: number, reason: PresentationFallbackReason, detail: string): void => {
        if (generation !== presentationGeneration) {
            return;
        }
        recordFailure('presenter', reason, detail);
        publishPlayback({ status: 'failed' });
    };

    /** A paused route presents its frame again after a settings change: the decoder re-decodes the frame at the clock in a new generation. */
    const handleDecodedPresentationRefresh = (generation: number): void => {
        const current = playback;
        const controller = current?.controller;
        if (!current || !controller || generation !== presentationGeneration || controller.playbackState !== 'paused') {
            return;
        }
        const refreshGeneration = advanceGeneration();
        current.frameLoop?.setPresentationGeneration(refreshGeneration);
        presenter.seek(refreshGeneration);
        presenter.setDecodedFramePushMode(true, refreshGeneration);
        controller.seek(controller.currentTimeMicroseconds).then((result: CustomPlaybackStartResult): void => {
            handleStartResult(current, controller, result);
        }, (error: unknown): void => {
            recordFailure('session', 'refresh-failed', describeError(error));
        });
    };

    const presenter = new WebGPUPresenter(handlePresentationFallback, handleDecodedPresentationRefresh);
    // The frame-pool route decodes on the presenter's device, so its sessions come from the presenter
    const gpuVideoDecodeSessionFactory = createGPUVideoDecodeSessionFactory(presenter, SANDBOX_GPU_VIDEO_DECODE_SESSION_OPTIONS);
    // The user's decoder packages, which playbacks prefer to the engine's, kept across reloads
    const decoderPackages = createSandboxDecoderPackages({
        publish: (packages): void => {
            store.setState({ decoders: { packages } });
        },
        recordFailure: (code: string, detail: string): void => {
            recordFailure('decoders', code, detail);
        }
    });
    decoderPackages.restore().catch((error: unknown): void => {
        recordFailure('decoders', 'package-restore-failed', describeError(error));
    });
    // A hidden page gets no animation frames, so the frame loop drains decoded video on a timer until it returns
    document.addEventListener(VISIBILITY_CHANGE_EVENT, (): void => {
        playback?.frameLoop?.synchronizePageVisibility(isPageVisible());
    });

    const createController = (current: Playback, eligibility: EligibleCustomPlayback, audioPrewarm: BrowserAudioContextPrewarmLease | null): CustomPlaybackController => {
        const reference: { controller: CustomPlaybackController | null } = { controller: null };
        const hasAudio = eligibility.audioTrackIndex !== null;
        const controller = new CustomPlaybackController({
            audioOutputFactory: hasAudio ?
                createBrowserCustomAudioOutputFactory(audioPrewarm, getWebGPUAudioOutputManager(), SANDBOX_AUDIO_OUTPUT_OPTIONS) :
                undefined,
            eventHandler: (event: CustomPlaybackControllerEvent): void => {
                if (reference.controller) {
                    handleControllerEvent(current, reference.controller, event);
                }
            },
            fallbackHook: (fallbackRequest: CustomPlaybackFallbackRequest): void => {
                if (reference.controller) {
                    handleFallback(current, reference.controller, fallbackRequest);
                }
            },
            gpuVideoDecodeSessionFactory,
            nativeAudioBridgeFactory: hasAudio ? (): CustomDecodeNativeAudioBridge => new CustomDecodeNativeAudioBridge() : undefined
        });
        reference.controller = controller;
        return controller;
    };

    /**
     * Plays the open media on a route from a time: the eligibility chooses the route among what the override leaves, the presenter takes its color pipeline, and the controller plays.
     * Rejects with the failure it recorded when the media is ineligible or the route cannot present.
     */
    const runRoute = async (current: Playback, generation: number, startTimeMicroseconds: Microseconds): Promise<void> => {
        const isCurrent = (): boolean => playback === current && presentationGeneration === generation;
        const state = store.getState();
        const override = state.route.override;
        const audioTrackIndex = state.tracks.audioTrackIndex;
        const source: CustomDecodeMediaSource = { file: current.media.file, kind: 'file' };
        const mediaSource = {
            ...createPlaybackMediaSource(current.probe.output, current.probe.frames, current.media.path, audioTrackIndex !== null),
            ...(audioTrackIndex === null ? {} : { DefaultAudioStreamIndex: audioTrackIndex })
        };
        const playOptions = { mediaSource, playMethod: DIRECT_PLAY_METHOD, source };
        current.options = playOptions;
        current.input = readPresentationInput(playOptions);
        if (!isWebGPUPresentationInput(playOptions, current.input, true)) {
            throw failCommand('session', 'presentation-unavailable', `${current.media.path} has no presentable color description`);
        }
        presenter.startSession(generation);
        publishPlayback({ status: 'loading' });

        const probeStartMilliseconds = performance.now();
        const [ capabilities, nativeMediaAudioCapabilities ] = await Promise.all([
            probeCustomDecodeCapabilities(mediaSource),
            probeCachedNativeMediaAudioCapabilities()
        ]);
        store.setState({ capabilityProbes: { negotiationMilliseconds: performance.now() - probeStartMilliseconds } });
        const presentationOptions = await getCustomPresentationEligibilityOptions(presenter, {
            input: current.input,
            isCurrent,
            isHDRToneMappingEnabled: (): Promise<boolean> => Promise.resolve(true),
            options: playOptions
        });
        if (!presentationOptions || !isCurrent()) {
            return;
        }
        const gpuVideoDecoders = allowsGPUVideoDecoders(override.decoder) ?
            await getGPUVideoDecoderOffers(presenter, decoderPackages.getVideoDecoders(), playOptions) :
            [];
        if (!isCurrent()) {
            return;
        }
        // The speaker layout the setting resolves to on the session's audio context, which decides whether Atmos objects render
        const audioOutputSettings = store.getState().audioOutput;
        const audioRenderTarget: CustomAudioRenderTarget = {
            binauralHeadphones: audioOutputSettings.binauralHeadphones,
            speakerLayout: selectCustomAudioSpeakerLayout(
                audioOutputSettings.speakerLayout,
                current.audioPrewarm?.audioContext.destination.maxChannelCount ?? null
            )
        };
        const eligibility = getCustomPlaybackEligibility(playOptions, narrowCapabilitiesForDecoder(capabilities, override.decoder), {
            ...narrowPresentationOptionsForTransport(presentationOptions, override.transport),
            audioDecoders: decoderPackages.getAudioDecoders(),
            audioRenderTarget,
            gpuVideoDecoders,
            nativeMediaAudioCapabilities,
            runtimeAvailability: getCustomPlaybackRuntimeAvailability()
        });
        if (!eligibility.eligible) {
            throw failCommand('session', 'ineligible', eligibility.reason);
        }
        const unmetOverride = describeUnmetRouteOverride(override, eligibility);
        if (unmetOverride !== null) {
            recordFailure('session', 'route-override-unmet', unmetOverride);
        }
        const decodedAudio = eligibility.audioTrackIndex !== null && eligibility.audioOutputMode === 'decoded-pcm';
        if (!decodedAudio) {
            // Only decoded PCM plays through the session's audio context
            releaseRouteAudioPrewarm(current);
        }
        current.eligibility = eligibility;
        current.input = alignPresentationInputBitDepth(current.input, eligibility.rawVideoFrameFormat);
        store.setState({ route: { active: describeRoute(eligibility, override), override } });

        presenter.setDecodedFramePushMode(true, generation);
        presenter.attach(surface, generation);
        const configured = await configurePresentationColorPipeline(presenter, {
            clearDetectedInputPeak: (): void => undefined,
            createHDRRenderConfiguration,
            dolbyVisionProfile: eligibility.dolbyVisionProfile,
            eligibility,
            generation,
            input: current.input,
            options: playOptions,
            rawVideoFrameFormat: eligibility.rawVideoFrameFormat,
            videoOutputMode: eligibility.videoOutputMode
        });
        if (!isCurrent()) {
            return;
        }
        if (!configured) {
            throw failCommand('presenter', 'color-pipeline-unavailable', `${eligibility.videoOutputMode} ${eligibility.rawVideoFrameFormat ?? 'videoframe'}`);
        }

        const audioPrewarm = current.audioPrewarm;
        const controller = createController(current, eligibility, audioPrewarm);
        current.controller = controller;
        const frameLoop = new CustomPlaybackFrameLoop({
            controller,
            isCurrent: (): boolean => isRouteCurrent(current, controller),
            onFailure: (error: unknown): void => {
                recordFailure('presenter', 'frame-presentation-failed', describeError(error));
            },
            presenter,
            presentationGeneration: generation
        });
        current.frameLoop = frameLoop;
        frameLoop.synchronizePageVisibility(isPageVisible());
        const result = await controller.play(createPlayOptions(eligibility, startTimeMicroseconds, decodedAudio, audioRenderTarget));
        handleStartResult(current, controller, result);
    };

    /**
     * Starts the open media on a route from a time, and gives the route the audio context lease.
     * A failed start records its failure, stops what it set up unless a newer start replaced it, and rejects.
     */
    const startRoute = async (current: Playback, startTimeMicroseconds: Microseconds, audioPrewarm: BrowserAudioContextPrewarmLease): Promise<void> => {
        const generation = advanceGeneration();
        current.generation = generation;
        current.audioPrewarm = audioPrewarm;
        try {
            await runRoute(current, generation, startTimeMicroseconds);
        } catch (error) {
            if (playback === current && current.generation === generation) {
                if (!(error instanceof RecordedCommandFailure)) {
                    recordFailure('session', 'route-start-failed', describeError(error));
                }
                publishPlayback({ status: 'failed' });
                stopRoute(current);
            }
            throw error;
        }
    };

    /** Restarts the open media where its clock stopped, with the user's activation for a new audio context, as a track or route change needs. */
    const restartRoute = async (code: string): Promise<void> => {
        const current = playback;
        if (!current) {
            throw failCommand('session', code, NO_MEDIA_OPEN_DETAIL);
        }
        const audioPrewarm = prewarmBrowserAudioContext(CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE);
        stopRoute(current);
        await startRoute(current, current.lastTimeMicroseconds, audioPrewarm);
    };

    const applyPreset = async (): Promise<void> => {
        store.setState((state: SandboxState): Partial<SandboxState> => ({ presentation: { ...state.presentation, files } }));
        const report = await presenter.setPresentationPreset(files.map((file: SandboxShaderFile): PresentationPresetFile => (
            { parameters: file.parameters, source: file.source }
        )));
        store.setState((state: SandboxState): Partial<SandboxState> => ({ presentation: { ...state.presentation, files, report } }));
    };

    const addFile = (origin: string, source: string): void => {
        files = [ ...files, describeShaderFile(`${FILE_ID_PREFIX}${fileNumber}`, origin, source, {}) ];
        fileNumber += 1;
    };

    const requireFileIndex = (fileId: string, code: string): number => {
        const index = files.findIndex((file: SandboxShaderFile): boolean => file.id === fileId);
        if (index < 0) {
            throw failCommand('shader', code, `no file ${fileId}`);
        }
        return index;
    };

    /** Reads a subtitle selection as WebVTT: an embedded track, or a subtitle file beside the media, through ffmpeg. */
    const readSubtitleWebVTT = (current: Playback, selection: SubtitleSelection): Promise<string> => {
        switch (selection.kind) {
            case 'embedded':
                return getTool().convertSubtitleToWebVTT(current.media.file, selection.trackIndex);
            case 'file': {
                const subtitleFile = current.media.subtitleFiles.find(
                    (candidate: SandboxMediaFile['subtitleFiles'][number]): boolean => candidate.path === selection.path
                );
                if (!subtitleFile) {
                    return Promise.reject(new Error(`no subtitle file ${selection.path}`));
                }
                return getTool().convertSubtitleToWebVTT(subtitleFile.file, null);
            }
        }
    };

    return {
        addBuiltShaderPass: async (pass: BuiltShaderPass): Promise<void> => {
            let source: string;
            try {
                source = await fetchBuiltPassSource(pass);
            } catch (error) {
                throw failCommand('shader', 'built-pass-unavailable', describeError(error));
            }
            addFile(pass.fileName, source);
            await applyPreset();
        },
        addDecoderPackages: (chosenFiles: readonly File[]): Promise<void> => decoderPackages.add(chosenFiles),
        addShaderFiles: async (chosenFiles: readonly File[]): Promise<void> => {
            for (const chosenFile of chosenFiles) {
                if (!chosenFile.name.toLowerCase().endsWith(PASS_FILE_EXTENSION)) {
                    recordFailure('shader', 'shader-file-unsupported', chosenFile.name);
                    continue;
                }
                addFile(chosenFile.name, await chosenFile.text());
            }
            await applyPreset();
        },
        getCurrentTimeMicroseconds: (): Microseconds => playback?.controller?.currentTimeMicroseconds ?? playback?.lastTimeMicroseconds ?? START_TIME,
        listBuiltShaderPasses: (): Promise<readonly BuiltShaderPass[]> => listBuiltPasses(),
        moveShaderFile: (fileId: string, offset: -1 | 1): Promise<void> => {
            const index = requireFileIndex(fileId, 'shader-move-failed');
            const targetIndex = index + offset;
            if (targetIndex < 0 || targetIndex >= files.length) {
                return Promise.resolve();
            }
            const reordered = [ ...files ];
            [ reordered[index], reordered[targetIndex] ] = [ reordered[targetIndex], reordered[index] ];
            files = reordered;
            return applyPreset();
        },
        openMedia: async (media: SandboxMediaFile): Promise<void> => {
            openRevision += 1;
            const revision = openRevision;
            // The audio context opens while the click's activation lasts, before the probe's awaits
            const audioPrewarm = prewarmBrowserAudioContext(CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE);
            if (playback) {
                stopRoute(playback);
                playback = null;
            }
            stopTelemetry();
            renderSettingsOverride = null;
            subtitleRevision += 1;
            store.setState({
                media: null,
                playback: { ...store.getState().playback, durationMicroseconds: null, status: 'loading' },
                route: { active: null, override: store.getState().route.override },
                subtitleCues: [],
                telemetry: { authorization: NO_AUTHORIZATION_TELEMETRY, controller: null, presenter: null }
            });
            let probe: ProbedMedia;
            try {
                probe = await probeMedia(getTool(), media.file, media.path);
            } catch (error) {
                releaseAudioPrewarm(audioPrewarm);
                publishPlayback({ status: 'failed' });
                throw failCommand('probe', 'probe-failed', `${media.path} ${describeError(error)}`);
            }
            if (revision !== openRevision) {
                releaseAudioPrewarm(audioPrewarm);
                return;
            }
            for (const warning of probe.warnings) {
                const [ code, ...detail ] = warning.split(': ');
                recordFailure('probe', code, detail.join(': '));
            }
            const current: Playback = {
                audioPrewarm: null,
                controller: null,
                eligibility: null,
                frameLoop: null,
                generation: presentationGeneration,
                input: EMPTY_PRESENTATION_INPUT,
                lastTimeMicroseconds: START_TIME,
                media,
                options: null,
                probe
            };
            playback = current;
            store.setState({
                media: probe.description,
                playback: { ...store.getState().playback, durationMicroseconds: probe.description.durationMicroseconds },
                tracks: {
                    audioTrackIndex: getDefaultAudioTrackIndex(probe.description),
                    subtitle: DEFAULT_SUBTITLE_SELECTION,
                    videoTrackIndex: getFirstVideoTrackIndex(probe)
                }
            });
            startTelemetry();
            await startRoute(current, START_TIME, audioPrewarm);
        },
        pause: (): void => {
            findController('pause-failed')?.pause();
        },
        play: (): Promise<void> => {
            const controller = findController('play-failed');
            if (!controller) {
                return Promise.reject(new Error(`play-failed: ${NO_MEDIA_PLAYING_DETAIL}`));
            }
            controller.resume();
            return Promise.resolve();
        },
        removeDecoderPackage: (packageId: string): Promise<void> => decoderPackages.remove(packageId),
        removeShaderFile: (fileId: string): Promise<void> => {
            const index = requireFileIndex(fileId, 'shader-remove-failed');
            files = files.filter((_file: SandboxShaderFile, fileIndex: number): boolean => fileIndex !== index);
            return applyPreset();
        },
        seek: (timeMicroseconds: Microseconds): void => {
            const current = playback;
            const controller = findController('seek-failed');
            if (!current || !controller) {
                return;
            }
            const seekGeneration = advanceGeneration();
            presenter.seek(seekGeneration);
            current.frameLoop?.setPresentationGeneration(seekGeneration);
            presenter.setDecodedFramePushMode(true, seekGeneration);
            controller.seek(timeMicroseconds).then((result: CustomPlaybackStartResult): void => {
                handleStartResult(current, controller, result);
            }, (error: unknown): void => {
                recordFailure('session', 'seek-failed', describeError(error));
            });
        },
        selectAudioTrack: (trackIndex: number | null): Promise<void> => {
            store.setState((state: SandboxState): Partial<SandboxState> => ({ tracks: { ...state.tracks, audioTrackIndex: trackIndex } }));
            return restartRoute('audio-track-failed');
        },
        selectSubtitle: async (selection: SubtitleSelection | null): Promise<void> => {
            subtitleRevision += 1;
            const revision = subtitleRevision;
            store.setState((state: SandboxState): Partial<SandboxState> => ({ subtitleCues: [], tracks: { ...state.tracks, subtitle: selection } }));
            const current = playback;
            if (selection === null) {
                return;
            }
            if (!current) {
                throw failCommand('subtitle', 'subtitle-unavailable', NO_MEDIA_OPEN_DETAIL);
            }
            let text: string;
            try {
                text = await readSubtitleWebVTT(current, selection);
            } catch (error) {
                throw failCommand('subtitle', 'subtitle-unreadable', describeError(error));
            }
            if (revision === subtitleRevision && playback === current) {
                store.setState({ subtitleCues: parseWebVTTCues(text) });
            }
        },
        setDeinterlaceMode: async (mode: DeinterlaceMode): Promise<void> => {
            try {
                await presenter.setDeinterlaceMode(mode);
            } catch (error) {
                throw failCommand('presenter', 'deinterlace-mode-failed', describeError(error));
            }
            store.setState((state: SandboxState): Partial<SandboxState> => ({ presentation: { ...state.presentation, deinterlaceMode: mode } }));
        },
        setHDROutputEnabled: async (enabled: boolean): Promise<void> => {
            try {
                await presenter.setHDROutputEnabled(enabled);
            } catch (error) {
                throw failCommand('presenter', 'hdr-output-failed', describeError(error));
            }
            store.setState((state: SandboxState): Partial<SandboxState> => ({ presentation: { ...state.presentation, hdrOutput: enabled } }));
        },
        setMuted: (muted: boolean): void => {
            playback?.controller?.setMuted(muted);
            publishPlayback({ muted });
        },
        setRenderSettings: (settings: HDRToSDRRenderSettings): void => {
            // Without an HDR route presenting, the settings wait for the next one
            renderSettingsOverride = settings;
            presenter.updateRenderSettings(settings, presentationGeneration, false);
            store.setState((state: SandboxState): Partial<SandboxState> => ({ presentation: { ...state.presentation, renderSettings: presenter.getRenderSettings() } }));
        },
        setAudioOutputSettings: (settings: AudioOutputSettings): Promise<void> => {
            store.setState({ audioOutput: settings });
            return playback ? restartRoute('audio-output-settings-failed') : Promise.resolve();
        },
        setRouteOverride: (override: RouteOverride): Promise<void> => {
            store.setState((state: SandboxState): Partial<SandboxState> => ({ route: { ...state.route, override } }));
            return playback ? restartRoute('route-override-failed') : Promise.resolve();
        },
        setShaderParameter: (fileId: string, parameterName: string, value: number): void => {
            const index = requireFileIndex(fileId, 'shader-parameter-failed');
            const changedFile = files[index];
            files = files.map((candidate: SandboxShaderFile, fileIndex: number): SandboxShaderFile => (
                fileIndex === index ? { ...candidate, parameters: { ...candidate.parameters, [parameterName]: value } } : candidate
            ));
            store.setState((state: SandboxState): Partial<SandboxState> => ({ presentation: { ...state.presentation, files } }));
            // The file's passes share the value, so each pass that declares the parameter, as a uniform or a constant, takes it
            for (const filePass of changedFile.passes) {
                const manifest = filePass.manifest;
                const declared = manifest !== null && [ ...manifest.parameters, ...manifest.constants ]
                    .some((parameter: PassParameter): boolean => parameter.name === parameterName);
                if (!declared) {
                    continue;
                }
                try {
                    presenter.setPresentationParameter(manifest.name, parameterName, value);
                } catch (error) {
                    // A pass that is not running takes the stored value when the preset next applies
                    recordFailure('shader', 'shader-parameter-pending', describeError(error));
                }
            }
        },
        setVolume: (volume: number): void => {
            playback?.controller?.setVolume(volume);
            publishPlayback({ volume });
        },
        verifyDecoderPackage: async (packageId: string): Promise<void> => {
            const device = await presenter.getGPUVideoDecodeDevice();
            if (!device) {
                throw failCommand('decoders', 'package-verify-failed', 'the presenter has no device');
            }
            await decoderPackages.verify(packageId, device);
        }
    };
}
