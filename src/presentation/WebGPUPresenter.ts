import { isHDRToneMappingEnabled } from '../EngineConfiguration';
import { recordTimingWait, startTimingWait } from '../TimingTrace';

import {
    microsecondsToMilliseconds,
    millisecondsToMicroseconds,
    secondsToMicroseconds,
    type Microseconds
} from '../MediaTime';
import {
    assertValidRenderSettings,
    createDefaultRenderSettings,
    type HDR10PlusFrameRenderSettings,
    type HDRToSDRRenderSettings,
    type IdentitySDRRenderSettings,
    type RenderMode,
    type RenderSettings
} from './RenderSettings';
import {
    assertValidInputColorMetadata,
    type InputColorMetadata
} from '../color/ColorMetadata';
import {
    createExternalDolbyVisionColorPipelineWGSL,
    createExternalHDRColorPipelineWGSL,
    createRawDolbyVisionColorPipelineWGSL,
    createRawDolbyVisionProfile4ColorPipelineWGSL,
    createRawDolbyVisionProfile4FELColorPipelineWGSL,
    createRawDolbyVisionProfile7ColorPipelineWGSL,
    createRawDolbyVisionProfile7FELColorPipelineWGSL,
    createRawYUVColorPipelineWGSL,
    isRawDolbyVisionVideoFrameFormat,
    type RawDolbyVisionVideoFrameFormat
} from '../color/ColorPipelineShader';
import {
    isDolbyVisionDualLayerProfile,
    type DolbyVisionReconstructionProfile
} from './PresentationInput';
import { DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH } from '../video/dolby-vision/DolbyVisionRPUParser';
import {
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from '../video/RawVideoFrameCopy';
import { type TransferableDolbyVisionEncodedFrameMetadata } from '../video/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import { type HDR10PlusFrameMetadata } from '../video/hdr/HDR10PlusMetadata';
import {
    createRawYUVRenderSettingsUniformBuffer,
    createRawYUVEnhancementUniformBuffer,
    createRawYUVRenderPipeline,
    destroyRawPlaneTextureSet,
    renderRawYUVFrame,
    writeRawYUVRenderSettingsUniform,
    type RawPlaneTextureSet
} from './RawYUVGPURenderer';
import {
    decodedFrameColorMatches,
    decodedNeutralBT709FrameColorMatches,
    getComposedEnhancementFrame,
    getDualLayerDolbyVisionRPUData,
    getDualLayerPresentation,
    getHDR10PlusFrameRenderSettings,
    getSingleLayerDolbyVisionRPUData,
    isDolbyVisionInputMode,
    isExternalInputMode,
    rawDolbyVisionEnhancementFrameDescriptorMatches,
    rawDolbyVisionFrameDescriptorMatches,
    rawFrameDescriptorMatches,
    type DualLayerDolbyVisionRPUData
} from './DecodedFramePresentation';
import { createExternalTextureRenderPipeline, drawExternalTextureFrame } from './ExternalTextureGPURenderer';
import {
    requestPresentationDevice,
    waitForWebGPUResourceOperation,
    WEBGPU_RESOURCE_OPERATION_TIMEOUT,
    WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS
} from './WebGPUResourceOperation';
import {
    calculateTexturePresentationGeometry,
    type TexturePresentationGeometry
} from './PresentationGeometry';
import {
    isWorkerPresentationResponse,
    type PresentationFallbackReason,
    type WorkerPresentationAttachment,
    type WorkerPresentationConfigureRequest,
    type WorkerPresentationDolbyVisionDualLayerMode,
    type WorkerPresentationHDR10PlusResult,
    type WorkerPresentationInputMode,
    type WorkerPresentationLayoutRequest,
    type WorkerPresentationPresentedResponse,
    type WorkerPresentationRequest,
    type WorkerPresentationSettingsRequest
} from './WorkerPresentationProtocol';
import {
    DolbyVisionPresentationAuthorizationRegistry,
    type DolbyVisionAuthorizationRoute,
    type DolbyVisionAuthorizationTelemetry
} from '../validation/DolbyVisionPresentationAuthorization';
import {
    ExternalDolbyVisionPresentationAuthorizationRegistry,
    type ExternalDolbyVisionAuthorizationTelemetry
} from '../validation/ExternalDolbyVisionPresentationAuthorization';
import {
    ExternalHDRPresentationAuthorizationRegistry,
    getExternalHDRAuthorizationRouteKey,
    type ExternalHDRAuthorizationRouteKey,
    type ExternalHDRAuthorizationTelemetry
} from '../validation/ExternalHDRPresentationAuthorization';
import {
    getRawHDRAuthorizationRouteKey,
    RawHDRPresentationAuthorizationRegistry,
    type RawHDRAuthorizationRouteKey,
    type RawHDRAuthorizationTelemetry
} from '../validation/RawHDRPresentationAuthorization';
import identityShader from './identity.wgsl';

const CANVAS_CLASS = 'webgpuPlayerCanvas';
const CANVAS_VISIBLE_CLASS = 'webgpuPlayerCanvas-visible';
const FLOATS_PER_PRESENTATION_UNIFORM = 4;
const LAYOUT_MOTION_END_EVENTS = [
    'animationcancel',
    'animationend',
    'transitioncancel',
    'transitionend'
] as const;
const LAYOUT_MOTION_ITERATION_EVENT = 'animationiteration';
const LAYOUT_MOTION_START_EVENTS = [ 'animationstart', 'transitionrun' ] as const;
const MAX_DEVICE_RECOVERY_ATTEMPTS = 1;
const MIN_CANVAS_DIMENSION = 1;
// The texture dimension every WebGPU device supports, for a layout before the page's own device exists
const WEBGPU_DEFAULT_MAXIMUM_TEXTURE_DIMENSION = 8_192;
const VIDEO_READY_STATE_CURRENT_DATA = 2;
export const RAW_HDR_NEGOTIATION_WAIT_MICROSECONDS = millisecondsToMicroseconds(5_000);
// The raw Dolby Vision BL format whose routes are prewarmed, and which authorization queries default to
const PREWARMED_RAW_DOLBY_VISION_FRAME_FORMAT: RawDolbyVisionVideoFrameFormat = 'I420P10';

// The worker renderer bounds its own waits the same way, so the bound lives with the shared wait
export { WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS };

function waitForRawHDRNegotiationProbe(operation: Promise<void>): Promise<void> {
    return new Promise<void>(resolve => {
        let settled = false;
        const settle = (): void => {
            if (settled) {
                return;
            }
            settled = true;
            globalThis.clearTimeout(timeout);
            resolve();
        };
        const timeout = globalThis.setTimeout(settle, microsecondsToMilliseconds(RAW_HDR_NEGOTIATION_WAIT_MICROSECONDS));
        operation.then(settle, settle);
    });
}

export type PresentationSurface = {
    container: HTMLDivElement
    video: HTMLVideoElement
};

// The worker renderer reports the same reasons, so the list lives with its protocol
export type { PresentationFallbackReason };

export type PresentationTelemetry = {
    appliedHDR10PlusFrameCount: number
    /** Applied HDR10+ frames whose metadata was carried from an earlier frame, because they had no valid metadata of their own. */
    carriedHDR10PlusFrameCount: number
    decodedFrameCount: number
    deviceRecoveryCount: number
    /** Dual-layer (Profile 4 or 7) FEL frames that presented their compatible base without the EL. */
    dolbyVisionDualLayerFELBaseFallbackPresentedFrameCount: number
    dolbyVisionDualLayerFELPresentedFrameCount: number
    dolbyVisionDualLayerMELPresentedFrameCount: number
    fallbackReason: PresentationFallbackReason | null
    firstFrameLatencyMicroseconds: Microseconds | null
    firstPresentedMediaTimeMicroseconds: Microseconds | null
    lastCallbackTimeMicroseconds: Microseconds | null
    lastExpectedDisplayTimeMicroseconds: Microseconds | null
    lastPresentedMediaTimeMicroseconds: Microseconds | null
    lastHDR10PlusInputPeakNits: number | null
    lastHDR10PlusMetadataStatus: HDR10PlusFrameMetadata['status'] | null
    mode: RenderMode
    nativeFrameCount: number
    presentationSource: 'decoded' | 'native' | null
    presentedFrameCount: number
    staticFallbackHDR10PlusFrameCount: number
    sessionStartedMicroseconds: Microseconds
    state: 'fallback' | 'idle' | 'initializing' | 'presenting'
};

export type DecodedVideoPresentationFrame = {
    durationMicroseconds: Microseconds
    encodedDolbyVisionMetadata?: TransferableDolbyVisionEncodedFrameMetadata
    HDR10PlusMetadata?: HDR10PlusFrameMetadata
    frame: VideoFrame
    mediaTimeMicroseconds: Microseconds
    outputMode: 'video-frame'
};

export type DecodedRawPresentationFrame = {
    durationMicroseconds: Microseconds
    encodedDolbyVisionMetadata?: TransferableDolbyVisionEncodedFrameMetadata
    HDR10PlusMetadata?: HDR10PlusFrameMetadata
    enhancementFrame?: TransferableRawVideoFrame | null
    frame: TransferableRawVideoFrame
    mediaTimeMicroseconds: Microseconds
    outputMode: 'raw-planes'
};

/** A frame the decode worker keeps for its renderer, which the presenter asks to draw it by ID. */
export type DecodedWorkerPresentationFrame = {
    /** The decode generation whose run keeps the frame */
    decodeGeneration: number
    displayHeight: number
    displayWidth: number
    durationMicroseconds: Microseconds
    frameId: number
    mediaTimeMicroseconds: Microseconds
    outputMode: 'worker-frame'
};

export type DecodedPresentationFrame =
    | DecodedRawPresentationFrame
    | DecodedVideoPresentationFrame
    | DecodedWorkerPresentationFrame;

/** A frame whose payload reached the page. */
type DecodedPayloadPresentationFrame = DecodedRawPresentationFrame | DecodedVideoPresentationFrame;

export type IdentityColorPipelineConfiguration = {
    settings: IdentitySDRRenderSettings
};

export type RawHDRColorPipelineConfiguration = {
    inputMode: 'raw-yuv'
    metadata: InputColorMetadata
    rawFrameFormat: SupportedRawVideoFrameFormat
    settings: RenderSettings
};

export type RawDolbyVisionColorPipelineConfiguration = {
    inputMode: 'raw-dolby-vision'
    profile: DolbyVisionReconstructionProfile
    /** The BL format of every profile; a dual-layer EL is always I420P10. */
    rawFrameFormat: RawDolbyVisionVideoFrameFormat
    settings: HDRToSDRRenderSettings
};

export type ExternalDolbyVisionColorPipelineConfiguration = {
    inputMode: 'external-dolby-vision'
    profile: 5
    settings: HDRToSDRRenderSettings
};

export type ExternalHDRColorPipelineConfiguration = {
    inputMode: 'external-hdr'
    metadata: InputColorMetadata
    settings: HDRToSDRRenderSettings
};

export type PresentationColorPipelineConfiguration = (
    | ExternalDolbyVisionColorPipelineConfiguration
    | ExternalHDRColorPipelineConfiguration
    | IdentityColorPipelineConfiguration
    | RawDolbyVisionColorPipelineConfiguration
    | RawHDRColorPipelineConfiguration
) & {
    /** Defaults to true for callers without a persisted manual peak policy. */
    automaticInputPeakNits?: boolean
};

type PresentationInputMode = WorkerPresentationInputMode;

type PresentationFallbackHandler = (generation: number, reason: PresentationFallbackReason) => void;

type DecodedPresentationRefreshHandler = (generation: number) => void;

type PendingFrameCallback = {
    generation: number
    id: number
    video: HTMLVideoElement
};

type DolbyVisionDualLayerPresentation = WorkerPresentationDolbyVisionDualLayerMode;

type FrameSubmission = {
    device: GPUDevice
    dolbyVisionDualLayerMode?: DolbyVisionDualLayerPresentation
    validationResult: Promise<GPUError | null> | null
};

/** The authorization registries one raw Dolby Vision route renders through. */
type RawDolbyVisionAuthorizations = {
    base: DolbyVisionPresentationAuthorizationRegistry
    fel: DolbyVisionPresentationAuthorizationRegistry | null
};

type RawDolbyVisionAuthorizationKey = `${RawDolbyVisionVideoFrameFormat}:${DolbyVisionAuthorizationRoute}`;

export type DolbyVisionReconstructionTarget = {
    profile: DolbyVisionReconstructionProfile
    rawFrameFormat: RawDolbyVisionVideoFrameFormat
};

type PendingColorConfiguration = {
    generation: number
    revision: number
};

type PreparedColorPipeline = {
    dolbyVisionFELReconstruction?: boolean
    dolbyVisionProfile: DolbyVisionReconstructionProfile | null
    inputMode: PresentationInputMode
    inputColorMetadata: InputColorMetadata | null
    rawFrameFormat: SupportedRawVideoFrameFormat | null
    settings: RenderSettings
    shaderCode: string
};

type PendingSubmissionValidation = {
    device: GPUDevice
    generation: number
    resourceEpoch: number
    validationResult: Promise<GPUError | null>
};

type CanvasGeometry = {
    cssHeight: number
    cssWidth: number
    height: number
    width: number
};

type CachedPresentationLayout = {
    devicePixelRatio: number
    geometry: CanvasGeometry
    presentation: TexturePresentation
    videoHeight: number
    videoWidth: number
};

type TexturePresentation = TexturePresentationGeometry;

type CachedWorkerPresentationLayout = CachedPresentationLayout & {
    revision: number
};

/** A frame the presenter asked the renderer to draw, until the renderer answers. */
type PendingWorkerPresent = {
    callbackTimeMicroseconds: Microseconds
    completed: ((gpuWorkCompleted: boolean) => void) | undefined
    decodeGeneration: number
    frameId: number
    /** The presentation generation that selected the frame */
    generation: number
    mediaTimeMicroseconds: Microseconds
};

/** How a configure the presenter waited for ended; released means the attachment went first. */
type WorkerRendererConfigurationAnswer = 'accepted' | 'refused' | 'released' | 'timeout';

type PendingWorkerRendererConfiguration = {
    resolve: (answer: WorkerRendererConfigurationAnswer) => void
    revision: number
};

/**
 * The renderer of one decode worker: the canvas it draws into, its channel, and what it accepted.
 * A worker attaches once, so a replaced worker gets a new attachment and the old canvas goes.
 */
type WorkerRendererAttachment = {
    canvas: HTMLCanvasElement
    /** The latest configure revision the renderer accepted */
    configuredRevision: number
    /** The latest configure revision sent */
    configureRevision: number
    layout: CachedWorkerPresentationLayout | null
    layoutDirty: boolean
    layoutRevision: number
    pendingConfiguration: PendingWorkerRendererConfiguration | null
    readonly pendingPresents: PendingWorkerPresent[]
    port: MessagePort
    status: 'pending' | 'ready'
};

function getMonotonicMicroseconds(): Microseconds {
    return millisecondsToMicroseconds(performance.now());
}

/** Reports whether this page can hand a canvas and a channel to a worker. */
function canTransferCanvasToWorker(): boolean {
    return typeof OffscreenCanvas === 'function'
        && typeof MessageChannel === 'function'
        && typeof HTMLCanvasElement === 'function'
        && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function';
}

/** Calls a selection's completion handler outside the presenter's own call stack, as GPU completion does. */
function notifyWorkerFrameCompletion(
    completed: ((gpuWorkCompleted: boolean) => void) | undefined,
    gpuWorkCompleted: boolean
): void {
    if (!completed) {
        return;
    }
    void Promise.resolve().then((): void => {
        try {
            completed(gpuWorkCompleted);
        } catch (error) {
            console.warn('Worker frame completion handler failed', error);
        }
    });
}

function createTelemetry(settings: RenderSettings): PresentationTelemetry {
    return {
        appliedHDR10PlusFrameCount: 0,
        carriedHDR10PlusFrameCount: 0,
        decodedFrameCount: 0,
        deviceRecoveryCount: 0,
        dolbyVisionDualLayerFELBaseFallbackPresentedFrameCount: 0,
        dolbyVisionDualLayerFELPresentedFrameCount: 0,
        dolbyVisionDualLayerMELPresentedFrameCount: 0,
        fallbackReason: null,
        firstFrameLatencyMicroseconds: null,
        firstPresentedMediaTimeMicroseconds: null,
        lastCallbackTimeMicroseconds: null,
        lastExpectedDisplayTimeMicroseconds: null,
        lastPresentedMediaTimeMicroseconds: null,
        lastHDR10PlusInputPeakNits: null,
        lastHDR10PlusMetadataStatus: null,
        mode: settings.mode,
        nativeFrameCount: 0,
        presentationSource: null,
        presentedFrameCount: 0,
        sessionStartedMicroseconds: getMonotonicMicroseconds(),
        staticFallbackHDR10PlusFrameCount: 0,
        state: 'idle'
    };
}

function cloneRenderSettings(settings: RenderSettings): RenderSettings {
    switch (settings.mode) {
        case 'identity-sdr':
            return { ...settings };
        case 'hdr-to-sdr':
            return {
                ...settings,
                display: { ...settings.display },
                toneMapping: { ...settings.toneMapping }
            };
    }
}

/** Presents frames from an owned HTML video without taking over playback. */
export default class WebGPUPresenter {
    private readonly fallbackHandler: PresentationFallbackHandler;
    private readonly decodedPresentationRefreshHandler: DecodedPresentationRefreshHandler;
    private readonly presentationUniformValues = new Float32Array(FLOATS_PER_PRESENTATION_UNIFORM);
    private readonly externalDolbyVisionAuthorization = new ExternalDolbyVisionPresentationAuthorizationRegistry();
    private readonly externalHDRAuthorization = new ExternalHDRPresentationAuthorizationRegistry();
    // Every raw Dolby Vision route authorizes each raw frame format on first use, apart from the prewarmed I420P10 single-layer and Profile 7 routes
    private readonly rawDolbyVisionAuthorizations = new Map<
        RawDolbyVisionAuthorizationKey,
        DolbyVisionPresentationAuthorizationRegistry
    >();
    private readonly rawHDRAuthorization = new RawHDRPresentationAuthorizationRegistry();

    private activeGeneration = 0;
    private automaticInputPeakNits = true;
    private activeDolbyVisionProfile: DolbyVisionReconstructionProfile | null = null;
    private activeDolbyVisionFELReconstruction = false;
    private activeInputColorMetadata: InputColorMetadata | null = null;
    private activeInputMode: PresentationInputMode = 'external-texture';
    private activeRawFrameFormat: SupportedRawVideoFrameFormat | null = null;
    private cachedPresentationLayout: CachedPresentationLayout | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private canvasContext: GPUCanvasContext | null = null;
    private canvasFormat: GPUTextureFormat | null = null;
    private colorConfigurationRevision = 0;
    private configuredDevice: GPUDevice | null = null;
    private device: GPUDevice | null = null;
    private deviceRecoveryAttempts = 0;
    private deviceResourceEpoch = 0;
    private decodedFramePushActive = false;
    private dynamicHDR10PlusSettingsActive = false;
    private fallbackLatched = false;
    private dolbyVisionRPUStorageBuffer: GPUBuffer | null = null;
    private dolbyVisionEnhancementUniformBuffer: GPUBuffer | null = null;
    private initializationFailureReason: PresentationFallbackReason = 'gpu-unavailable';
    private initializationPromise: Promise<boolean> | null = null;
    private layoutHandlingRevision = 0;
    private layoutInvalidationHandler: (() => void) | null = null;
    private layoutMutationObserver: MutationObserver | null = null;
    private pendingFrameCallback: PendingFrameCallback | null = null;
    private pendingColorConfiguration: PendingColorConfiguration | null = null;
    private pendingSubmissionValidation: PendingSubmissionValidation | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private pipelineShaderCode: string | null = null;
    private presentationLayoutDirty = true;
    private presentationUniformBuffer: GPUBuffer | null = null;
    private renderSettingsUniformBuffer: GPUBuffer | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private rawPlaneTextureSet: RawPlaneTextureSet | null = null;
    private enhancementRawPlaneTextureSet: RawPlaneTextureSet | null = null;
    private sampler: GPUSampler | null = null;
    private sessionActive = false;
    private settings: RenderSettings = createDefaultRenderSettings();
    private surface: PresentationSurface | null = null;
    private submissionValidated = false;
    private telemetry = createTelemetry(this.settings);
    private desiredShaderCode = identityShader;
    /** The decode worker's renderer, which presents worker-frames in a canvas of its own */
    private workerRenderer: WorkerRendererAttachment | null = null;

    constructor(
        fallbackHandler: PresentationFallbackHandler,
        decodedPresentationRefreshHandler: DecodedPresentationRefreshHandler = (): void => undefined
    ) {
        this.fallbackHandler = fallbackHandler;
        this.decodedPresentationRefreshHandler = decodedPresentationRefreshHandler;
        this.scheduleDevicePrewarm();
    }

    private scheduleDevicePrewarm(): void {
        void Promise.resolve().then((): void => {
            void isHDRToneMappingEnabled().then((featureEnabled: boolean): void => {
                if (featureEnabled) {
                    void this.ensureDevice();
                }
            });
        });
    }

    /** Starts a new presentation session without delaying HTML playback. */
    startSession(generation: number): void {
        this.cancelFrameCallback();
        this.unbindLayoutHandling();
        this.removeCanvas();
        this.detachWorkerRenderer();
        this.destroyRawPlaneTextures();
        this.destroyDolbyVisionRPUStorageBuffer();
        this.destroyDolbyVisionEnhancementUniformBuffer();

        this.activeGeneration = generation;
        this.automaticInputPeakNits = true;
        this.activeDolbyVisionProfile = null;
        this.activeDolbyVisionFELReconstruction = false;
        this.activeInputColorMetadata = null;
        this.activeInputMode = 'external-texture';
        this.activeRawFrameFormat = null;
        this.colorConfigurationRevision += 1;
        this.decodedFramePushActive = false;
        this.desiredShaderCode = identityShader;
        this.deviceRecoveryAttempts = 0;
        this.dynamicHDR10PlusSettingsActive = false;
        this.fallbackLatched = false;
        this.pendingColorConfiguration = null;
        this.pendingSubmissionValidation = null;
        this.sessionActive = true;
        this.settings = createDefaultRenderSettings();
        this.submissionValidated = false;
        this.surface = null;
        this.telemetry = createTelemetry(this.settings);
        this.telemetry.state = 'initializing';

        void this.prepareGeneration(generation);
    }

    /** Attaches presentation to the owned backend surface. */
    attach(surface: PresentationSurface, generation: number): void {
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }

        if (surface.video.parentElement !== surface.container) {
            this.fallback(generation, 'canvas-context-unavailable');
            return;
        }

        const previousSurface = this.surface;
        if (
            previousSurface
            && (previousSurface.container !== surface.container || previousSurface.video !== surface.video)
        ) {
            this.cancelFrameCallback();
            this.discardPendingSubmissionValidation();
            this.unbindLayoutHandling();
            this.removeCanvas();
            // The worker canvas sits in the old surface, which shows nothing more
            this.detachWorkerRenderer();
        }

        this.surface = surface;
        this.invalidatePresentationLayout();
        void this.activateSurface(generation);
    }

    /** Invalidates pending frame work while continuing the same backend session. */
    seek(generation: number): void {
        if (!this.sessionActive) {
            return;
        }

        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.colorConfigurationRevision += 1;
        this.pendingColorConfiguration = null;
        this.activeGeneration = generation;
        this.invalidatePresentationLayout();
        if (this.settings.mode === 'hdr-to-sdr') {
            this.writeRenderSettingsUniform(this.settings);
            this.dynamicHDR10PlusSettingsActive = false;
        }
        if (this.surface && !this.fallbackLatched) {
            void this.activateSurface(generation);
        }
    }

    /** Refreshes geometry and object-fit state without changing generations. */
    refresh(generation: number): void {
        if (!this.isCurrent(generation) || this.fallbackLatched || !this.surface) {
            return;
        }

        if (this.decodedFramePushActive) {
            if (!this.resynchronizeDecodedPresentationLayouts()) {
                return;
            }
            this.requestDecodedPresentationRefresh(generation);
            return;
        }
        this.invalidatePresentationLayout();
        this.renderCurrentFrameOrFallback(generation);
    }

    /** Recomputes the page and worker canvas layouts, and reports whether either changed. */
    private resynchronizeDecodedPresentationLayouts(): boolean {
        const pageLayoutChanged = this.resynchronizeCachedPresentationLayout();
        const workerLayoutChanged = this.resynchronizeWorkerPresentationLayout();
        return pageLayoutChanged || workerLayoutChanged;
    }

    /** Ends presentation while retaining reusable GPU resources. */
    endSession(generation: number): void {
        this.activeGeneration = generation;
        this.colorConfigurationRevision += 1;
        this.sessionActive = false;
        this.automaticInputPeakNits = true;
        this.activeDolbyVisionProfile = null;
        this.activeDolbyVisionFELReconstruction = false;
        this.activeInputColorMetadata = null;
        this.activeInputMode = 'external-texture';
        this.activeRawFrameFormat = null;
        this.decodedFramePushActive = false;
        this.dynamicHDR10PlusSettingsActive = false;
        this.pendingColorConfiguration = null;
        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.unbindLayoutHandling();
        this.removeCanvas();
        this.detachWorkerRenderer();
        this.destroyRawPlaneTextures();
        this.destroyDolbyVisionRPUStorageBuffer();
        this.destroyDolbyVisionEnhancementUniformBuffer();
        this.surface = null;
        this.telemetry.state = 'idle';
    }

    /** Releases reusable GPU resources while allowing a later fresh session. */
    destroy(): void {
        this.endSession(this.activeGeneration + 1);
        this.deviceResourceEpoch += 1;
        const device = this.device;
        this.device = null;
        this.pipeline = null;
        this.pipelineShaderCode = null;
        this.presentationUniformBuffer = null;
        this.renderSettingsUniformBuffer = null;
        this.sampler = null;
        this.canvasFormat = null;
        this.configuredDevice = null;
        this.initializationPromise = null;
        device?.destroy();
    }

    /** Returns a snapshot of current presentation telemetry. */
    getTelemetry(): PresentationTelemetry {
        return { ...this.telemetry };
    }

    /** Returns a detached snapshot of the active renderer controls. */
    getRenderSettings(): RenderSettings {
        return cloneRenderSettings(this.settings);
    }

    /** Starts non-diagnostic raw HDR probes without delaying playback. */
    async prewarmRawHDRPresentationAuthorization(): Promise<void> {
        const featureEnabled = await isHDRToneMappingEnabled();
        if (!featureEnabled || !await this.ensureDevice()) {
            return;
        }
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (device && targetFormat) {
            this.rawHDRAuthorization.prewarm(device, targetFormat);
        }
    }

    /** Starts exact raw SDR GPU-output probes independently from HDR settings. */
    async prewarmRawSDRPresentationAuthorization(): Promise<void> {
        if (!await this.ensureDevice()) {
            return;
        }
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (device && targetFormat) {
            this.rawHDRAuthorization.prewarmSDR(device, targetFormat);
        }
    }

    /** Starts native Main10 decode and external-texture probes without delaying playback. */
    async prewarmExternalHDRPresentationAuthorization(): Promise<void> {
        const featureEnabled = await isHDRToneMappingEnabled();
        if (!featureEnabled || !await this.ensureDevice()) {
            return;
        }
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (device && targetFormat) {
            this.externalHDRAuthorization.prewarm(device, targetFormat);
        }
    }

    /**
     * Starts the exact Dolby Vision storage-buffer probes without delaying playback.
     * The I420P10 single-layer and Profile 7 routes always run; a reconstruction target adds its own routes in its raw frame format.
     */
    async prewarmDolbyVisionPresentationAuthorization(target: DolbyVisionReconstructionTarget | null = null): Promise<void> {
        const featureEnabled = await isHDRToneMappingEnabled();
        if (!featureEnabled || !await this.ensureDevice()) {
            return;
        }
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (device && targetFormat) {
            this.externalDolbyVisionAuthorization.prewarm(device, targetFormat);
            for (const authorization of this.getPrewarmedDolbyVisionAuthorizations(target)) {
                authorization.prewarm(device, targetFormat);
            }
        }
    }

    /** Waits a tightly bounded already-running prewarm before profile negotiation. */
    async waitForRawHDRAuthorizationPrewarm(): Promise<void> {
        await waitForRawHDRNegotiationProbe(
            this.prewarmRawHDRPresentationAuthorization().then((): Promise<void> => {
                const device = this.device;
                const targetFormat = this.canvasFormat;
                return device && targetFormat ?
                    this.rawHDRAuthorization.waitForPending(device, targetFormat) :
                    Promise.resolve();
            })
        );
    }

    /** Waits a tightly bounded already-running native Main10 presentation probe. */
    async waitForExternalHDRAuthorizationPrewarm(): Promise<void> {
        await waitForRawHDRNegotiationProbe(
            this.prewarmExternalHDRPresentationAuthorization().then((): Promise<void> => {
                const device = this.device;
                const targetFormat = this.canvasFormat;
                return device && targetFormat ?
                    this.externalHDRAuthorization.waitForPending(device, targetFormat) :
                    Promise.resolve();
            })
        );
    }

    /** Waits a tightly bounded already-running Dolby Vision probe. */
    async waitForDolbyVisionAuthorizationPrewarm(target: DolbyVisionReconstructionTarget | null = null): Promise<void> {
        await waitForRawHDRNegotiationProbe(
            this.prewarmDolbyVisionPresentationAuthorization(target).then((): Promise<void> => {
                const device = this.device;
                const targetFormat = this.canvasFormat;
                if (!device || !targetFormat) {
                    return Promise.resolve();
                }
                const pendingProbes: Promise<void>[] = [
                    this.externalDolbyVisionAuthorization.waitForPending(device, targetFormat)
                ];
                for (const authorization of this.getPrewarmedDolbyVisionAuthorizations(target)) {
                    pendingProbes.push(authorization.waitForPending(device, targetFormat));
                }
                return Promise.all(pendingProbes).then((): void => undefined);
            })
        );
    }

    /** Returns only settled exact-device routes for negotiation and eligibility. */
    getAuthorizedRawHDRRouteKeys(): readonly RawHDRAuthorizationRouteKey[] {
        return this.rawHDRAuthorization.getTelemetry(this.device, this.canvasFormat).authorizedRouteKeys;
    }

    /** Returns only settled native Main10 external-texture routes. */
    getAuthorizedExternalHDRRouteKeys(): readonly ExternalHDRAuthorizationRouteKey[] {
        return this.externalHDRAuthorization.getTelemetry(this.device, this.canvasFormat).authorizedRouteKeys;
    }

    /** Returns bounded native Main10 external-texture authorization state. */
    getExternalHDRAuthorizationTelemetry(): ExternalHDRAuthorizationTelemetry {
        return this.externalHDRAuthorization.getTelemetry(this.device, this.canvasFormat);
    }

    /** Returns bounded raw authorization state without exposing GPU objects. */
    getRawHDRAuthorizationTelemetry(): RawHDRAuthorizationTelemetry {
        return this.rawHDRAuthorization.getTelemetry(this.device, this.canvasFormat);
    }

    /**
     * Returns one raw Dolby Vision route's authorization state for one BL format, without GPU objects.
     * The Profile 4 and 7 base routes cover MEL and the base-layer fallback; their FEL routes cover the FEL residual.
     */
    getDolbyVisionAuthorizationTelemetry(
        route: DolbyVisionAuthorizationRoute,
        format: RawDolbyVisionVideoFrameFormat = PREWARMED_RAW_DOLBY_VISION_FRAME_FORMAT
    ): DolbyVisionAuthorizationTelemetry {
        return this.getRawDolbyVisionAuthorization(route, format).getTelemetry(this.device, this.canvasFormat);
    }

    /** Returns exact external Profile 5 authorization state without GPU objects. */
    getExternalDolbyVisionAuthorizationTelemetry(): ExternalDolbyVisionAuthorizationTelemetry {
        return this.externalDolbyVisionAuthorization.getTelemetry(this.device, this.canvasFormat);
    }

    /** Returns only settled raw-plane single-layer Dolby Vision authorization for one frame format. */
    isRawDolbyVisionPresentationAuthorized(
        format: RawDolbyVisionVideoFrameFormat = PREWARMED_RAW_DOLBY_VISION_FRAME_FORMAT
    ): boolean {
        return this.isRawDolbyVisionRoutePresentationAuthorized(8, format);
    }

    /** Returns only settled raw-plane Profile 4 authorization for one BL frame format. */
    isRawDolbyVisionProfile4PresentationAuthorized(
        format: RawDolbyVisionVideoFrameFormat = PREWARMED_RAW_DOLBY_VISION_FRAME_FORMAT
    ): boolean {
        return this.isRawDolbyVisionRoutePresentationAuthorized(4, format);
    }

    /** Returns only settled raw-plane Profile 7 authorization for one BL frame format. */
    isRawDolbyVisionProfile7PresentationAuthorized(
        format: RawDolbyVisionVideoFrameFormat = PREWARMED_RAW_DOLBY_VISION_FRAME_FORMAT
    ): boolean {
        return this.isRawDolbyVisionRoutePresentationAuthorized(7, format);
    }

    /** Returns only settled external-texture Profile 5 authorization. */
    isExternalDolbyVisionPresentationAuthorized(): boolean {
        return this.settings.mode === 'hdr-to-sdr' ?
            this.isActiveExternalDolbyVisionAuthorized() :
            this.externalDolbyVisionAuthorization.getTelemetry(this.device, this.canvasFormat).status === 'authorized';
    }

    /** Selects clock-driven decoded-frame ticks before a surface is attached. */
    setDecodedFramePushMode(enabled: boolean, generation: number): void {
        if (!this.isCurrent(generation)) {
            return;
        }

        this.decodedFramePushActive = enabled;
        if (enabled) {
            this.cancelFrameCallback();
        } else {
            this.scheduleFrameCallback(generation);
        }
    }

    /**
     * Creates the canvas a decode worker's renderer draws into, transferred, with the renderer's end of a new channel.
     * A worker takes one attachment for its life, and a new one removes the previous canvas, since a canvas transfers only once.
     * Returns null outside push mode, without a surface, or where the page cannot hand a canvas to a worker.
     */
    createWorkerPresentationAttachment(generation: number): WorkerPresentationAttachment | null {
        const surface = this.surface;
        if (
            !this.isCurrent(generation)
            || this.fallbackLatched
            || !this.decodedFramePushActive
            || !surface
            || !canTransferCanvasToWorker()
        ) {
            return null;
        }

        let canvas: HTMLCanvasElement;
        let offscreenCanvas: OffscreenCanvas;
        let channel: MessageChannel;
        try {
            canvas = document.createElement('canvas');
            canvas.classList.add(CANVAS_CLASS);
            canvas.setAttribute('aria-hidden', 'true');
            offscreenCanvas = canvas.transferControlToOffscreen();
            channel = new MessageChannel();
        } catch (error) {
            console.warn('Unable to create a worker presentation canvas', error);
            return null;
        }

        this.detachWorkerRenderer();
        surface.container.appendChild(canvas);
        const attachment: WorkerRendererAttachment = {
            canvas,
            configuredRevision: 0,
            configureRevision: 0,
            layout: null,
            layoutDirty: true,
            layoutRevision: 0,
            pendingConfiguration: null,
            pendingPresents: [],
            port: channel.port1,
            status: 'pending'
        };
        channel.port1.onmessage = (event: MessageEvent<unknown>): void => {
            this.handleWorkerRendererMessage(attachment, event.data);
        };
        this.workerRenderer = attachment;
        // A pending color configuration sends its own once prepared; the renderer reads its configure before any present
        if (!this.pendingColorConfiguration && this.sendWorkerRendererConfiguration(attachment) === null) {
            this.detachWorkerRenderer();
            return null;
        }
        return { canvas: offscreenCanvas, port: channel.port2 };
    }

    /**
     * Takes ownership of one clock-selected decoded frame and closes it on every path.
     * This path does not require a native video-frame callback.
     * The completion handler runs once the GPU work of a VideoFrame or a worker frame completed or failed.
     */
    presentDecodedFrame(
        decodedFrame: DecodedPresentationFrame,
        generation: number,
        videoFrameSubmissionCompleted?: (gpuWorkCompleted: boolean) => void
    ): boolean {
        try {
            if (!this.isCurrent(generation) || this.fallbackLatched) {
                return false;
            }
            if (
                !Number.isSafeInteger(decodedFrame.mediaTimeMicroseconds)
                || !Number.isSafeInteger(decodedFrame.durationMicroseconds)
                || decodedFrame.durationMicroseconds < 0
            ) {
                this.fallback(generation, 'frame-render-failed');
                return false;
            }
            if (decodedFrame.outputMode === 'worker-frame') {
                return this.presentWorkerFrame(decodedFrame, generation, videoFrameSubmissionCompleted);
            }
            if (
                this.pendingColorConfiguration?.generation === generation
                || this.pendingSubmissionValidation
                || !this.hasReadyPresentationResources()
            ) {
                return false;
            }
            if (!this.applyHDR10PlusFrameMetadata(decodedFrame, generation)) {
                return false;
            }

            let frameWidth: number;
            let frameHeight: number;
            let submission: FrameSubmission | null;
            switch (decodedFrame.outputMode) {
                case 'raw-planes': {
                    frameWidth = decodedFrame.frame.displayWidth;
                    frameHeight = decodedFrame.frame.displayHeight;
                    submission = this.renderDecodedRawFrame(decodedFrame, generation);
                    break;
                }
                case 'video-frame':
                    frameWidth = decodedFrame.frame.displayWidth
                        || decodedFrame.frame.codedWidth;
                    frameHeight = decodedFrame.frame.displayHeight
                        || decodedFrame.frame.codedHeight;
                    submission = this.renderDecodedVideoFrame(decodedFrame, generation);
                    break;
            }
            if (frameWidth <= 0 || frameHeight <= 0) {
                this.fallback(generation, 'frame-render-failed');
                return false;
            }

            this.decodedFramePushActive = true;
            this.cancelFrameCallback();
            if (!submission) {
                return false;
            }

            const callbackTimeMicroseconds = getMonotonicMicroseconds();
            this.completeSubmission(submission, generation, () => {
                if (!this.isCurrent(generation) || this.fallbackLatched) {
                    return;
                }
                this.recordPresentedFrame(
                    decodedFrame.mediaTimeMicroseconds,
                    callbackTimeMicroseconds,
                    callbackTimeMicroseconds,
                    'decoded'
                );
                this.recordDolbyVisionDualLayerPresentation(submission);
            });
            if (decodedFrame.outputMode === 'video-frame' && videoFrameSubmissionCompleted) {
                this.notifyWhenGPUWorkCompleted(submission.device, videoFrameSubmissionCompleted);
            }
            return true;
        } catch (error) {
            console.warn('WebGPU decoded frame presentation failed', error);
            this.fallback(generation, 'frame-import-failed');
            return false;
        } finally {
            if (decodedFrame.outputMode === 'video-frame') {
                decodedFrame.frame.close();
            }
        }
    }

    /** Atomically selects identity external-texture or raw YUV HDR presentation. */
    async configureColorPipeline(
        configuration: PresentationColorPipelineConfiguration,
        generation: number
    ): Promise<boolean> {
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return false;
        }

        const revision = this.colorConfigurationRevision + 1;
        this.colorConfigurationRevision = revision;
        const pendingConfiguration: PendingColorConfiguration = { generation, revision };
        this.pendingColorConfiguration = pendingConfiguration;
        this.suspendForColorConfiguration();

        const preparedPipeline = await this.prepareColorPipeline(configuration, pendingConfiguration);
        if (!preparedPipeline || !this.isColorConfigurationCurrent(pendingConfiguration)) {
            return false;
        }

        const pipelineInstalled = await this.installPipelineShader(
            preparedPipeline.shaderCode,
            pendingConfiguration,
            preparedPipeline.inputMode
        );
        if (!this.isColorConfigurationCurrent(pendingConfiguration)) {
            return false;
        }
        if (!pipelineInstalled) {
            this.failColorConfiguration(pendingConfiguration, 'pipeline-creation-failed');
            return false;
        }
        if (
            preparedPipeline.settings.mode === 'hdr-to-sdr'
            && !this.writeRenderSettingsUniform(preparedPipeline.settings)
        ) {
            this.failColorConfiguration(pendingConfiguration, 'pipeline-creation-failed');
            return false;
        }
        this.dynamicHDR10PlusSettingsActive = false;
        if (isDolbyVisionInputMode(preparedPipeline.inputMode)
            && !this.createDolbyVisionRPUStorageBuffer()) {
            this.failColorConfiguration(pendingConfiguration, 'pipeline-creation-failed');
            return false;
        }
        if (preparedPipeline.dolbyVisionFELReconstruction && !this.createDolbyVisionEnhancementUniformBuffer()) {
            this.failColorConfiguration(pendingConfiguration, 'pipeline-creation-failed');
            return false;
        }
        if (!preparedPipeline.dolbyVisionFELReconstruction) {
            this.destroyDolbyVisionEnhancementUniformBuffer();
        }

        this.desiredShaderCode = preparedPipeline.shaderCode;
        this.activeDolbyVisionProfile = preparedPipeline.dolbyVisionProfile;
        this.activeDolbyVisionFELReconstruction = preparedPipeline.dolbyVisionFELReconstruction ?? false;
        this.activeInputMode = preparedPipeline.inputMode;
        this.activeInputColorMetadata = preparedPipeline.inputColorMetadata ?
            { ...preparedPipeline.inputColorMetadata } :
            null;
        this.activeRawFrameFormat = preparedPipeline.rawFrameFormat;
        this.automaticInputPeakNits = configuration.automaticInputPeakNits ?? true;
        this.settings = preparedPipeline.settings;
        this.telemetry.mode = preparedPipeline.settings.mode;
        // The worker renderer presents with the same pipeline, so it installs it before presentation resumes
        if (!await this.configureWorkerRenderer(pendingConfiguration)) {
            return false;
        }
        this.pendingColorConfiguration = null;
        this.resumeAfterColorConfiguration(generation);
        return true;
    }

    /**
     * Sends the worker renderer the pipeline just prepared, and waits for its answer once the renderer is ready.
     * A renderer still starting takes the configure when it reads its port, and its frames wait for its answer.
     */
    private async configureWorkerRenderer(pendingConfiguration: PendingColorConfiguration): Promise<boolean> {
        const attachment = this.workerRenderer;
        if (!attachment) {
            return true;
        }
        const revision = this.sendWorkerRendererConfiguration(attachment);
        if (revision === null) {
            this.failColorConfiguration(pendingConfiguration, 'pipeline-creation-failed');
            return false;
        }
        if (attachment.status !== 'ready') {
            return true;
        }

        const answer = await this.waitForWorkerRendererConfiguration(attachment, revision);
        if (!this.isColorConfigurationCurrent(pendingConfiguration)) {
            return false;
        }
        switch (answer) {
            case 'accepted':
            case 'released':
                return true;
            case 'refused':
                // The refusal already latched its fallback
                return false;
            case 'timeout':
                this.failColorConfiguration(pendingConfiguration, 'pipeline-creation-failed');
                return false;
        }
    }

    /** Sends the active pipeline to the worker renderer and returns its revision, or null when the channel refuses it. */
    private sendWorkerRendererConfiguration(attachment: WorkerRendererAttachment): number | null {
        const revision = attachment.configureRevision + 1;
        const configureRequest: WorkerPresentationConfigureRequest = {
            automaticInputPeakNits: this.automaticInputPeakNits,
            dolbyVisionFELReconstruction: this.activeDolbyVisionFELReconstruction,
            dolbyVisionProfile: this.activeDolbyVisionProfile,
            inputColorMetadata: this.activeInputColorMetadata ? { ...this.activeInputColorMetadata } : null,
            inputMode: this.activeInputMode,
            rawFrameFormat: this.activeRawFrameFormat,
            revision,
            settings: cloneRenderSettings(this.settings),
            shaderCode: this.desiredShaderCode,
            type: 'configure'
        };
        if (!this.postWorkerRendererRequest(attachment, configureRequest)) {
            return null;
        }
        attachment.configureRevision = revision;
        return revision;
    }

    /** Resolves with the renderer's answer to one configure, bounded as other GPU resource operations are. */
    private waitForWorkerRendererConfiguration(
        attachment: WorkerRendererAttachment,
        revision: number
    ): Promise<WorkerRendererConfigurationAnswer> {
        return new Promise<WorkerRendererConfigurationAnswer>(resolve => {
            let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
            const pendingConfiguration: PendingWorkerRendererConfiguration = {
                resolve: (answer: WorkerRendererConfigurationAnswer): void => {
                    if (timeout !== null) {
                        globalThis.clearTimeout(timeout);
                        timeout = null;
                    }
                    resolve(answer);
                },
                revision
            };
            attachment.pendingConfiguration?.resolve('released');
            attachment.pendingConfiguration = pendingConfiguration;
            timeout = globalThis.setTimeout((): void => {
                timeout = null;
                if (attachment.pendingConfiguration === pendingConfiguration) {
                    attachment.pendingConfiguration = null;
                }
                resolve('timeout');
            }, microsecondsToMilliseconds(WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS));
        });
    }

    /** Posts one request to the worker renderer; a channel that refuses it reports false. */
    private postWorkerRendererRequest(attachment: WorkerRendererAttachment, request: WorkerPresentationRequest): boolean {
        try {
            attachment.port.postMessage(request);
            return true;
        } catch (error) {
            console.warn('Unable to reach the worker presentation renderer', error);
            return false;
        }
    }

    private createRenderSettingsUniformBuffer(device: GPUDevice): GPUBuffer {
        return createRawYUVRenderSettingsUniformBuffer(device);
    }

    private writeRenderSettingsUniform(
        settings: HDRToSDRRenderSettings,
        dynamicFrameSettings: HDR10PlusFrameRenderSettings | null = null
    ): boolean {
        const device = this.device;
        if (!device) {
            return false;
        }

        try {
            const renderSettingsUniformBuffer = this.renderSettingsUniformBuffer
                ?? this.createRenderSettingsUniformBuffer(device);
            writeRawYUVRenderSettingsUniform(device, renderSettingsUniformBuffer, settings, dynamicFrameSettings);
            this.renderSettingsUniformBuffer = renderSettingsUniformBuffer;
            return true;
        } catch (error) {
            console.warn('Unable to update WebGPU render settings uniforms', error);
            return false;
        }
    }

    private applyHDR10PlusFrameMetadata(decodedFrame: DecodedPayloadPresentationFrame, generation: number): boolean {
        if (!this.isCurrent(generation) || this.settings.mode !== 'hdr-to-sdr') {
            return true;
        }

        const frameMetadata = decodedFrame.HDR10PlusMetadata;
        const status = frameMetadata?.status ?? 'absent';
        this.telemetry.lastHDR10PlusMetadataStatus = status;
        const dynamicFrameSettings = getHDR10PlusFrameRenderSettings(
            frameMetadata,
            this.activeInputMode,
            this.activeInputColorMetadata,
            this.settings,
            this.automaticInputPeakNits
        );

        if (dynamicFrameSettings || this.dynamicHDR10PlusSettingsActive) {
            if (!this.writeRenderSettingsUniform(this.settings, dynamicFrameSettings)) {
                this.fallback(generation, 'frame-render-failed');
                return false;
            }
            this.dynamicHDR10PlusSettingsActive = dynamicFrameSettings !== null;
        }
        if (dynamicFrameSettings) {
            this.telemetry.appliedHDR10PlusFrameCount += 1;
            if (status !== 'valid') {
                this.telemetry.carriedHDR10PlusFrameCount += 1;
            }
            this.telemetry.lastHDR10PlusInputPeakNits = dynamicFrameSettings.inputPeakNits;
        } else {
            this.telemetry.staticFallbackHDR10PlusFrameCount += 1;
            this.telemetry.lastHDR10PlusInputPeakNits = null;
        }
        return true;
    }

    /** Updates live HDR controls through uniforms without rebuilding the shader. */
    updateRenderSettings(
        settings: HDRToSDRRenderSettings,
        generation: number,
        automaticInputPeakNits: boolean = this.automaticInputPeakNits
    ): boolean {
        if (
            !this.isCurrent(generation)
            || this.fallbackLatched
            || this.pendingColorConfiguration !== null
            || this.settings.mode !== 'hdr-to-sdr'
        ) {
            return false;
        }

        try {
            if (typeof automaticInputPeakNits !== 'boolean') {
                throw new TypeError('Automatic input peak policy must be boolean');
            }
            assertValidRenderSettings(settings);
            if (!this.writeRenderSettingsUniform(settings)) {
                return false;
            }
            this.dynamicHDR10PlusSettingsActive = false;
        } catch (error) {
            console.warn('Invalid live WebGPU render settings', error);
            return false;
        }

        this.settings = cloneRenderSettings(settings);
        this.automaticInputPeakNits = automaticInputPeakNits;
        this.postWorkerRendererSettings(settings, automaticInputPeakNits);
        this.requestDecodedPresentationRefresh(generation);
        return true;
    }

    /** Gives the worker renderer the live controls of the configure it last received. */
    private postWorkerRendererSettings(settings: HDRToSDRRenderSettings, automaticInputPeakNits: boolean): void {
        const attachment = this.workerRenderer;
        // A renderer that has no configure yet takes these controls with its first one
        if (!attachment || attachment.configureRevision === 0) {
            return;
        }
        const settingsRequest: WorkerPresentationSettingsRequest = {
            automaticInputPeakNits,
            revision: attachment.configureRevision,
            settings: {
                ...settings,
                display: { ...settings.display },
                toneMapping: { ...settings.toneMapping }
            },
            type: 'settings'
        };
        this.postWorkerRendererRequest(attachment, settingsRequest);
    }

    private async prepareColorPipeline(
        configuration: PresentationColorPipelineConfiguration,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<PreparedColorPipeline | null> {
        if ('inputMode' in configuration) {
            switch (configuration.inputMode) {
                case 'external-dolby-vision':
                    return this.prepareExternalDolbyVisionColorPipeline(configuration, pendingConfiguration);
                case 'external-hdr':
                    return this.prepareExternalHDRColorPipeline(configuration, pendingConfiguration);
                case 'raw-dolby-vision':
                    return this.prepareRawDolbyVisionColorPipeline(configuration, pendingConfiguration);
                case 'raw-yuv':
                    return this.prepareRawHDRColorPipeline(configuration, pendingConfiguration);
            }
        }

        try {
            assertValidRenderSettings(configuration.settings);
        } catch (error) {
            console.warn('Invalid WebGPU identity color configuration', error);
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid');
            return null;
        }
        return {
            dolbyVisionProfile: null,
            inputMode: 'external-texture',
            inputColorMetadata: null,
            rawFrameFormat: null,
            settings: cloneRenderSettings(configuration.settings),
            shaderCode: identityShader
        };
    }

    private async prepareExternalDolbyVisionColorPipeline(
        configuration: ExternalDolbyVisionColorPipelineConfiguration,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<PreparedColorPipeline | null> {
        try {
            assertValidRenderSettings(configuration.settings);
        } catch (error) {
            console.warn('Invalid WebGPU external Dolby Vision color configuration', error);
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid');
            return null;
        }
        if (configuration.settings.mode !== 'hdr-to-sdr') {
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid');
            return null;
        }

        const featureEnabled = await isHDRToneMappingEnabled();
        if (!this.isColorConfigurationCurrent(pendingConfiguration)) {
            return null;
        }
        if (!featureEnabled) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-tone-mapping-disabled');
            return null;
        }
        const initialized = await this.ensureDevice();
        if (!initialized || !this.isColorConfigurationCurrent(pendingConfiguration)) {
            return null;
        }
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (
            !device
            || !targetFormat
            || !this.externalDolbyVisionAuthorization.isAuthorized(device, targetFormat, configuration.settings)
        ) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-authorization-unavailable');
            return null;
        }

        let shaderCode: string;
        try {
            shaderCode = createExternalDolbyVisionColorPipelineWGSL(configuration.settings);
        } catch (error) {
            console.warn('Invalid WebGPU external Dolby Vision shader configuration', error);
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid');
            return null;
        }
        return {
            dolbyVisionProfile: configuration.profile,
            inputMode: 'external-dolby-vision',
            inputColorMetadata: null,
            rawFrameFormat: null,
            settings: cloneRenderSettings(configuration.settings),
            shaderCode
        };
    }

    private async prepareExternalHDRColorPipeline(
        configuration: ExternalHDRColorPipelineConfiguration,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<PreparedColorPipeline | null> {
        try {
            assertValidInputColorMetadata(configuration.metadata);
            assertValidRenderSettings(configuration.settings);
        } catch (error) {
            console.warn('Invalid WebGPU external HDR color configuration', error);
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid');
            return null;
        }
        if (
            configuration.settings.mode !== 'hdr-to-sdr'
            || !getExternalHDRAuthorizationRouteKey(configuration.metadata)
        ) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid');
            return null;
        }

        const featureEnabled = await isHDRToneMappingEnabled();
        if (!this.isColorConfigurationCurrent(pendingConfiguration)) {
            return null;
        }
        if (!featureEnabled) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-tone-mapping-disabled');
            return null;
        }
        const initialized = await this.ensureDevice();
        if (!initialized || !this.isColorConfigurationCurrent(pendingConfiguration)) {
            return null;
        }
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (
            !device
            || !targetFormat
            || !this.externalHDRAuthorization.isAuthorized(
                device,
                targetFormat,
                configuration.metadata,
                configuration.settings
            )
        ) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-authorization-unavailable');
            return null;
        }

        let shaderCode: string;
        try {
            shaderCode = createExternalHDRColorPipelineWGSL(configuration.metadata, configuration.settings);
        } catch (error) {
            console.warn('Invalid WebGPU external HDR shader configuration', error);
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid');
            return null;
        }
        return {
            dolbyVisionProfile: null,
            inputMode: 'external-hdr',
            inputColorMetadata: { ...configuration.metadata },
            rawFrameFormat: null,
            settings: cloneRenderSettings(configuration.settings),
            shaderCode
        };
    }

    private async prepareRawHDRColorPipeline(
        configuration: RawHDRColorPipelineConfiguration,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<PreparedColorPipeline | null> {
        if (!this.validateRawHDRColorConfiguration(configuration)) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid');
            return null;
        }

        const featureEnabled = configuration.settings.mode === 'identity-sdr'
            || await isHDRToneMappingEnabled();
        if (!this.isColorConfigurationCurrent(pendingConfiguration)) {
            return null;
        }
        if (!featureEnabled) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-tone-mapping-disabled');
            return null;
        }

        const initialized = await this.ensureDevice();
        if (!initialized || !this.isColorConfigurationCurrent(pendingConfiguration)) {
            return null;
        }
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (
            !device
            || !targetFormat
            || !this.rawHDRAuthorization.isAuthorized(
                device,
                targetFormat,
                configuration.metadata,
                configuration.settings,
                configuration.rawFrameFormat
            )
        ) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-authorization-unavailable');
            return null;
        }

        let shaderCode: string;
        try {
            shaderCode = createRawYUVColorPipelineWGSL(
                configuration.metadata,
                configuration.settings,
                configuration.rawFrameFormat
            );
        } catch (error) {
            console.warn('Invalid WebGPU raw HDR color configuration', error);
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid');
            return null;
        }

        return {
            dolbyVisionProfile: null,
            inputMode: 'raw-yuv',
            inputColorMetadata: { ...configuration.metadata },
            rawFrameFormat: configuration.rawFrameFormat,
            settings: cloneRenderSettings(configuration.settings),
            shaderCode
        };
    }

    private async prepareRawDolbyVisionColorPipeline(
        configuration: RawDolbyVisionColorPipelineConfiguration,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<PreparedColorPipeline | null> {
        try {
            assertValidRenderSettings(configuration.settings);
        } catch (error) {
            console.warn('Invalid WebGPU Dolby Vision color configuration', error);
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid');
            return null;
        }
        if (configuration.settings.mode !== 'hdr-to-sdr') {
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid');
            return null;
        }

        const featureEnabled = await isHDRToneMappingEnabled();
        if (!this.isColorConfigurationCurrent(pendingConfiguration)) {
            return null;
        }
        if (!featureEnabled) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-tone-mapping-disabled');
            return null;
        }
        const initialized = await this.ensureDevice();
        if (!initialized || !this.isColorConfigurationCurrent(pendingConfiguration)) {
            return null;
        }
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (!isRawDolbyVisionVideoFrameFormat(configuration.rawFrameFormat)) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid');
            return null;
        }
        const authorizations = this.getRawDolbyVisionAuthorizations(
            configuration.profile,
            configuration.rawFrameFormat
        );
        if (
            !device
            || !targetFormat
            || !authorizations.base.isAuthorized(
                device,
                targetFormat,
                configuration.settings,
                configuration.rawFrameFormat
            )
        ) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-authorization-unavailable');
            return null;
        }

        let shaderCode: string;
        const dolbyVisionFELReconstruction = authorizations.fel !== null
            && authorizations.fel.isAuthorized(
                device,
                targetFormat,
                configuration.settings,
                configuration.rawFrameFormat
            );
        try {
            shaderCode = this.createRawDolbyVisionShader(configuration, dolbyVisionFELReconstruction);
        } catch (error) {
            console.warn('Invalid WebGPU Dolby Vision shader configuration', error);
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid');
            return null;
        }
        return {
            dolbyVisionFELReconstruction,
            dolbyVisionProfile: configuration.profile,
            inputMode: 'raw-dolby-vision',
            inputColorMetadata: null,
            rawFrameFormat: configuration.rawFrameFormat,
            settings: cloneRenderSettings(configuration.settings),
            shaderCode
        };
    }

    private createDolbyVisionRPUStorageBuffer(): boolean {
        if (this.dolbyVisionRPUStorageBuffer) {
            return true;
        }
        const device = this.device;
        if (!device) {
            return false;
        }
        try {
            this.dolbyVisionRPUStorageBuffer = device.createBuffer({
                label: 'WebGPU Dolby Vision per-frame RPU',
                size: DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
            });
            return true;
        } catch (error) {
            console.warn('Unable to create WebGPU Dolby Vision RPU buffer', error);
            return false;
        }
    }

    private createDolbyVisionEnhancementUniformBuffer(): boolean {
        if (this.dolbyVisionEnhancementUniformBuffer) {
            return true;
        }
        const device = this.device;
        if (!device) {
            return false;
        }
        try {
            this.dolbyVisionEnhancementUniformBuffer = createRawYUVEnhancementUniformBuffer(device);
            return true;
        } catch (error) {
            console.warn('Unable to create WebGPU Dolby Vision enhancement buffer', error);
            return false;
        }
    }

    private validateRawHDRColorConfiguration(configuration: RawHDRColorPipelineConfiguration): boolean {
        try {
            assertValidInputColorMetadata(configuration.metadata);
            assertValidRenderSettings(configuration.settings);
        } catch (error) {
            console.warn('Invalid WebGPU HDR color configuration', error);
            return false;
        }

        let validTransfer: boolean;
        switch (configuration.metadata.transfer) {
            case 'hlg':
            case 'pq':
                validTransfer = configuration.settings.mode === 'hdr-to-sdr';
                break;
            case 'sdr':
                validTransfer = configuration.settings.mode === 'identity-sdr';
                break;
        }
        if (!validTransfer) {
            return false;
        }

        switch (configuration.rawFrameFormat) {
            case 'I420':
            case 'I422':
            case 'I444':
            case 'NV12':
                return configuration.metadata.bitDepth === 8;
            case 'I420P10':
            case 'I422P10':
            case 'I444P10':
                return configuration.metadata.bitDepth === 10;
            case 'I420P12':
            case 'I422P12':
            case 'I444P12':
                return configuration.metadata.bitDepth === 12;
        }
    }

    private isActiveRawHDRAuthorized(metadata: InputColorMetadata, format: SupportedRawVideoFrameFormat): boolean {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        return device !== null
            && targetFormat !== null
            && this.rawHDRAuthorization.isAuthorized(device, targetFormat, metadata, this.settings, format);
    }

    private isActiveExternalHDRAuthorized(metadata: InputColorMetadata): boolean {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        return this.settings.mode === 'hdr-to-sdr'
            && device !== null
            && targetFormat !== null
            && this.externalHDRAuthorization.isAuthorized(device, targetFormat, metadata, this.settings);
    }

    private createRawDolbyVisionShader(
        configuration: RawDolbyVisionColorPipelineConfiguration,
        reconstructsFEL: boolean
    ): string {
        const settings = configuration.settings;
        const format = configuration.rawFrameFormat;
        switch (configuration.profile) {
            case 4:
                return reconstructsFEL ?
                    createRawDolbyVisionProfile4FELColorPipelineWGSL(settings, format) :
                    createRawDolbyVisionProfile4ColorPipelineWGSL(settings, format);
            case 7:
                return reconstructsFEL ?
                    createRawDolbyVisionProfile7FELColorPipelineWGSL(settings, format) :
                    createRawDolbyVisionProfile7ColorPipelineWGSL(settings, format);
            case 5:
            case 8:
                return createRawDolbyVisionColorPipelineWGSL(settings, format);
        }
    }

    private getRawDolbyVisionAuthorization(
        route: DolbyVisionAuthorizationRoute,
        format: RawDolbyVisionVideoFrameFormat
    ): DolbyVisionPresentationAuthorizationRegistry {
        const authorizationKey: RawDolbyVisionAuthorizationKey = `${format}:${route}`;
        const cachedAuthorization = this.rawDolbyVisionAuthorizations.get(authorizationKey);
        if (cachedAuthorization) {
            return cachedAuthorization;
        }
        const authorization = new DolbyVisionPresentationAuthorizationRegistry(route, format);
        this.rawDolbyVisionAuthorizations.set(authorizationKey, authorization);
        return authorization;
    }

    private getRawDolbyVisionAuthorizations(
        profile: DolbyVisionReconstructionProfile,
        format: RawDolbyVisionVideoFrameFormat
    ): RawDolbyVisionAuthorizations {
        switch (profile) {
            case 4:
                return {
                    base: this.getRawDolbyVisionAuthorization('profile4-base', format),
                    fel: this.getRawDolbyVisionAuthorization('profile4-fel', format)
                };
            case 7:
                return {
                    base: this.getRawDolbyVisionAuthorization('profile7-base', format),
                    fel: this.getRawDolbyVisionAuthorization('profile7-fel', format)
                };
            case 5:
            case 8:
                return {
                    base: this.getRawDolbyVisionAuthorization('single-layer', format),
                    fel: null
                };
        }
    }

    private getPrewarmedDolbyVisionAuthorizations(
        target: DolbyVisionReconstructionTarget | null
    ): DolbyVisionPresentationAuthorizationRegistry[] {
        const authorizations: DolbyVisionPresentationAuthorizationRegistry[] = [];
        authorizations.push(
            this.getRawDolbyVisionAuthorization('single-layer', PREWARMED_RAW_DOLBY_VISION_FRAME_FORMAT),
            this.getRawDolbyVisionAuthorization('profile7-base', PREWARMED_RAW_DOLBY_VISION_FRAME_FORMAT),
            this.getRawDolbyVisionAuthorization('profile7-fel', PREWARMED_RAW_DOLBY_VISION_FRAME_FORMAT)
        );
        if (!target) {
            return authorizations;
        }
        const targetAuthorizations = this.getRawDolbyVisionAuthorizations(target.profile, target.rawFrameFormat);
        for (const authorization of [ targetAuthorizations.base, targetAuthorizations.fel ]) {
            if (authorization && !authorizations.includes(authorization)) {
                authorizations.push(authorization);
            }
        }
        return authorizations;
    }

    private isRawDolbyVisionRoutePresentationAuthorized(
        profile: DolbyVisionReconstructionProfile,
        format: RawDolbyVisionVideoFrameFormat
    ): boolean {
        return this.settings.mode === 'hdr-to-sdr' ?
            this.isActiveRawDolbyVisionAuthorized(format, profile) :
            this.getRawDolbyVisionAuthorizations(profile, format).base.getTelemetry(
                this.device,
                this.canvasFormat
            ).status === 'authorized';
    }

    private isActiveRawDolbyVisionAuthorized(
        format: SupportedRawVideoFrameFormat,
        profile: DolbyVisionReconstructionProfile | null
    ): boolean {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        return profile !== null
            && isRawDolbyVisionVideoFrameFormat(format)
            && this.settings.mode === 'hdr-to-sdr'
            && device !== null
            && targetFormat !== null
            && this.getRawDolbyVisionAuthorizations(profile, format).base.isAuthorized(
                device,
                targetFormat,
                this.settings,
                format
            );
    }

    private isActiveExternalDolbyVisionAuthorized(): boolean {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        return this.settings.mode === 'hdr-to-sdr'
            && device !== null
            && targetFormat !== null
            && this.externalDolbyVisionAuthorization.isAuthorized(device, targetFormat, this.settings);
    }

    private suspendForColorConfiguration(): void {
        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.unbindLayoutHandling();
        this.removeCanvas();
        this.destroyRawPlaneTextures();
        this.destroyDolbyVisionRPUStorageBuffer();
        this.telemetry.state = 'initializing';
    }

    private resumeAfterColorConfiguration(generation: number): void {
        if (!this.surface || !this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }
        if (!this.createAndConfigureCanvas()) {
            this.fallback(generation, this.initializationFailureReason);
            return;
        }

        this.scheduleFrameCallback(generation);
    }

    private failColorConfiguration(
        pendingConfiguration: PendingColorConfiguration,
        reason: PresentationFallbackReason
    ): void {
        if (!this.isColorConfigurationCurrent(pendingConfiguration)) {
            return;
        }

        this.pendingColorConfiguration = null;
        this.fallback(pendingConfiguration.generation, reason);
    }

    private isColorConfigurationCurrent(pendingConfiguration: PendingColorConfiguration): boolean {
        return this.pendingColorConfiguration === pendingConfiguration
            && this.colorConfigurationRevision === pendingConfiguration.revision
            && this.isCurrent(pendingConfiguration.generation)
            && !this.fallbackLatched;
    }

    private async installPipelineShader(
        shaderCode: string,
        pendingConfiguration: PendingColorConfiguration,
        inputMode: PreparedColorPipeline['inputMode']
    ): Promise<boolean> {
        const initialized = await this.ensureDevice();
        if (!initialized || !this.isColorConfigurationCurrent(pendingConfiguration)) {
            return false;
        }
        if (this.pipeline && this.pipelineShaderCode === shaderCode) {
            return true;
        }

        const device = this.device;
        const canvasFormat = this.canvasFormat;
        if (!device || !canvasFormat) {
            return false;
        }

        let pipeline: GPURenderPipeline;
        try {
            const pipelineResult = await waitForWebGPUResourceOperation(
                this.createRenderPipeline(device, canvasFormat, shaderCode, !isExternalInputMode(inputMode))
            );
            if (pipelineResult === WEBGPU_RESOURCE_OPERATION_TIMEOUT) {
                this.initializationFailureReason = 'pipeline-creation-failed';
                return false;
            }
            pipeline = pipelineResult;
        } catch (error) {
            console.warn('WebGPU color pipeline creation failed', error);
            return false;
        }

        if (!this.isColorConfigurationCurrent(pendingConfiguration) || this.device !== device) {
            return false;
        }

        this.pipeline = pipeline;
        this.pipelineShaderCode = shaderCode;
        this.submissionValidated = false;
        return true;
    }

    private async prepareGeneration(generation: number): Promise<void> {
        const initialized = await this.ensureDevice();
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }

        if (!initialized) {
            this.fallback(generation, this.initializationFailureReason);
        }
    }

    private async activateSurface(generation: number): Promise<void> {
        if (this.pendingColorConfiguration?.generation === generation) {
            return;
        }

        const initialized = await this.ensureDevice();
        if (!this.isCurrent(generation) || this.fallbackLatched || !this.surface) {
            return;
        }

        if (!initialized) {
            this.fallback(generation, this.initializationFailureReason);
            return;
        }

        if (!this.createAndConfigureCanvas()) {
            this.fallback(generation, this.initializationFailureReason);
            return;
        }

        this.scheduleFrameCallback(generation);
    }

    private async ensureDevice(): Promise<boolean> {
        let initialized = this.hasBaseDeviceResources();
        if (!initialized && !this.initializationPromise) {
            const resourceEpoch = this.deviceResourceEpoch;
            this.initializationPromise = this.initializeDeviceResources(resourceEpoch);
        }

        const initializationPromise = this.initializationPromise;
        try {
            if (initializationPromise) {
                initialized = await initializationPromise;
            }
        } catch (error) {
            console.warn('Unexpected WebGPU initialization failure', error);
            this.initializationFailureReason = 'pipeline-creation-failed';
            return false;
        } finally {
            if (initializationPromise && this.initializationPromise === initializationPromise) {
                this.initializationPromise = null;
            }
        }

        if (!initialized || !this.hasBaseDeviceResources()) {
            return false;
        }

        return this.ensureDesiredPipeline();
    }

    private hasBaseDeviceResources(): boolean {
        return this.device !== null
            && this.sampler !== null
            && this.presentationUniformBuffer !== null
            && this.canvasFormat !== null;
    }

    private async ensureDesiredPipeline(): Promise<boolean> {
        if (this.pipeline && this.pipelineShaderCode === this.desiredShaderCode) {
            return true;
        }

        const device = this.device;
        const canvasFormat = this.canvasFormat;
        const shaderCode = this.desiredShaderCode;
        const generation = this.activeGeneration;
        const resourceEpoch = this.deviceResourceEpoch;
        if (!device || !canvasFormat) {
            return false;
        }

        let pipelineResult: GPURenderPipeline | typeof WEBGPU_RESOURCE_OPERATION_TIMEOUT;
        try {
            pipelineResult = await waitForWebGPUResourceOperation(
                this.createRenderPipeline(
                    device,
                    canvasFormat,
                    shaderCode,
                    !isExternalInputMode(this.activeInputMode)
                )
            );
        } catch (error) {
            console.warn('WebGPU pipeline creation failed', error);
            this.initializationFailureReason = 'pipeline-creation-failed';
            return false;
        }
        if (pipelineResult === WEBGPU_RESOURCE_OPERATION_TIMEOUT) {
            this.initializationFailureReason = 'pipeline-creation-failed';
            return false;
        }
        if (
            this.deviceResourceEpoch !== resourceEpoch
            || this.activeGeneration !== generation
            || this.device !== device
            || this.desiredShaderCode !== shaderCode
        ) {
            return false;
        }

        this.pipeline = pipelineResult;
        this.pipelineShaderCode = shaderCode;
        this.submissionValidated = false;
        return true;
    }

    private createRenderPipeline(
        device: GPUDevice,
        canvasFormat: GPUTextureFormat,
        shaderCode: string,
        rawYUV: boolean
    ): Promise<GPURenderPipeline> {
        if (rawYUV) {
            return createRawYUVRenderPipeline(device, canvasFormat, shaderCode);
        }
        return createExternalTextureRenderPipeline(device, canvasFormat, shaderCode);
    }

    private async initializeDeviceResources(resourceEpoch: number): Promise<boolean> {
        if (!window.isSecureContext) {
            this.initializationFailureReason = 'insecure-context';
            return false;
        }

        const gpu = navigator.gpu;
        if (!gpu) {
            this.initializationFailureReason = 'gpu-unavailable';
            return false;
        }

        const deviceRequest = await requestPresentationDevice(gpu);
        if (deviceRequest.failureReason !== null) {
            this.initializationFailureReason = deviceRequest.failureReason;
            return false;
        }
        const device = deviceRequest.device;
        if (this.deviceResourceEpoch !== resourceEpoch) {
            device.destroy();
            return false;
        }

        try {
            const canvasFormat = gpu.getPreferredCanvasFormat();
            const shaderCode = this.desiredShaderCode;
            const pipelineResult = await waitForWebGPUResourceOperation(
                this.createRenderPipeline(
                    device,
                    canvasFormat,
                    shaderCode,
                    !isExternalInputMode(this.activeInputMode)
                )
            );
            if (pipelineResult === WEBGPU_RESOURCE_OPERATION_TIMEOUT) {
                device.destroy();
                this.initializationFailureReason = 'pipeline-creation-failed';
                return false;
            }
            const pipeline = pipelineResult;
            if (this.deviceResourceEpoch !== resourceEpoch) {
                device.destroy();
                return false;
            }
            const sampler = device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear'
            });
            const presentationUniformBuffer = device.createBuffer({
                label: 'WebGPU video presentation uniforms',
                size: this.presentationUniformValues.byteLength,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM
            });
            let renderSettingsUniformBuffer: GPUBuffer | null = null;
            if (this.settings.mode === 'hdr-to-sdr') {
                renderSettingsUniformBuffer = this.createRenderSettingsUniformBuffer(device);
                writeRawYUVRenderSettingsUniform(device, renderSettingsUniformBuffer, this.settings);
            }

            this.canvasFormat = canvasFormat;
            this.device = device;
            this.pipeline = pipeline;
            this.pipelineShaderCode = shaderCode;
            this.presentationUniformBuffer = presentationUniformBuffer;
            this.renderSettingsUniformBuffer = renderSettingsUniformBuffer;
            this.dynamicHDR10PlusSettingsActive = false;
            this.sampler = sampler;
            this.rawHDRAuthorization.prewarmSDR(device, canvasFormat);
            void isHDRToneMappingEnabled().then((enabled: boolean): void => {
                if (enabled && this.device === device && this.canvasFormat === canvasFormat) {
                    this.rawHDRAuthorization.prewarm(device, canvasFormat);
                    this.externalHDRAuthorization.prewarm(device, canvasFormat);
                    this.externalDolbyVisionAuthorization.prewarm(device, canvasFormat);
                    for (const authorization of this.getPrewarmedDolbyVisionAuthorizations(null)) {
                        authorization.prewarm(device, canvasFormat);
                    }
                }
            });
            device.addEventListener('uncapturederror', event => {
                this.handleUncapturedError(device, event);
            });
            void device.lost.then(deviceLostInfo => this.handleDeviceLoss(device, deviceLostInfo));
            return true;
        } catch (error) {
            console.warn('WebGPU pipeline creation failed', error);
            device.destroy();
            this.initializationFailureReason = 'pipeline-creation-failed';
            return false;
        }
    }

    private createAndConfigureCanvas(): boolean {
        const surface = this.surface;
        const device = this.device;
        const canvasFormat = this.canvasFormat;
        if (!surface || !device || !canvasFormat) {
            this.initializationFailureReason = 'canvas-context-unavailable';
            return false;
        }

        if (!this.canvas) {
            const canvas = document.createElement('canvas');
            canvas.classList.add(CANVAS_CLASS);
            canvas.setAttribute('aria-hidden', 'true');

            const canvasContext = canvas.getContext('webgpu');
            if (!canvasContext) {
                this.initializationFailureReason = 'canvas-context-unavailable';
                return false;
            }

            surface.container.appendChild(canvas);
            this.canvas = canvas;
            this.canvasContext = canvasContext;
            this.bindLayoutHandling(surface);
        }

        if (this.configuredDevice === device) {
            return true;
        }

        try {
            this.canvasContext?.configure({
                alphaMode: 'opaque',
                colorSpace: 'srgb',
                device,
                format: canvasFormat
            });
            this.configuredDevice = device;
            return true;
        } catch (error) {
            console.warn('WebGPU canvas configuration failed', error);
            this.initializationFailureReason = 'canvas-configuration-failed';
            return false;
        }
    }

    private scheduleFrameCallback(generation: number): void {
        const video = this.surface?.video;
        if (
            !video
            || !this.isCurrent(generation)
            || this.activeInputMode !== 'external-texture'
            || this.decodedFramePushActive
            || this.pendingFrameCallback
            || this.pendingSubmissionValidation
        ) {
            return;
        }

        if (typeof video.requestVideoFrameCallback !== 'function') {
            this.fallback(generation, 'request-video-frame-callback-unavailable');
            return;
        }

        let callbackId = 0;
        try {
            callbackId = video.requestVideoFrameCallback((callbackTimeMilliseconds, metadata) => {
                this.handleVideoFrame(video, generation, callbackId, callbackTimeMilliseconds, metadata);
            });
        } catch (error) {
            console.warn('Video frame callback request failed', error);
            this.fallback(generation, 'request-video-frame-callback-unavailable');
            return;
        }
        this.pendingFrameCallback = { generation, id: callbackId, video };
    }

    private handleVideoFrame(
        video: HTMLVideoElement,
        generation: number,
        callbackId: number,
        callbackTimeMilliseconds: DOMHighResTimeStamp,
        metadata: VideoFrameCallbackMetadata
    ): void {
        const pendingFrameCallback = this.pendingFrameCallback;
        const isPendingCallback = pendingFrameCallback?.generation === generation
            && pendingFrameCallback.id === callbackId
            && pendingFrameCallback.video === video;
        if (!isPendingCallback) {
            return;
        }
        this.pendingFrameCallback = null;

        if (!this.isCurrent(generation) || this.fallbackLatched || this.surface?.video !== video) {
            return;
        }

        let mediaTimeMicroseconds: Microseconds;
        let callbackTimeMicroseconds: Microseconds;
        let expectedDisplayTimeMicroseconds: Microseconds;
        try {
            mediaTimeMicroseconds = secondsToMicroseconds(metadata.mediaTime);
            callbackTimeMicroseconds = millisecondsToMicroseconds(callbackTimeMilliseconds);
            expectedDisplayTimeMicroseconds = millisecondsToMicroseconds(metadata.expectedDisplayTime);
        } catch (error) {
            console.warn('Invalid video frame timestamp', error);
            this.fallback(generation, 'frame-render-failed');
            return;
        }

        try {
            const submission = this.renderFrameCallbackSource(video, generation);
            if (!submission) {
                this.scheduleFrameCallback(generation);
                return;
            }

            this.completeFrameSubmission(
                submission,
                generation,
                video,
                mediaTimeMicroseconds,
                callbackTimeMicroseconds,
                expectedDisplayTimeMicroseconds
            );
        } catch (error) {
            console.warn('WebGPU video frame presentation failed', error);
            this.fallback(generation, 'frame-import-failed');
        }
    }

    private renderFrameCallbackSource(video: HTMLVideoElement, generation: number): FrameSubmission | null {
        if (this.activeInputMode !== 'external-texture') {
            this.fallback(generation, 'decoded-frame-color-mismatch');
            return null;
        }
        return this.renderCurrentFrame(video);
    }

    private renderDecodedVideoFrame(
        decodedFrame: DecodedVideoPresentationFrame,
        generation: number
    ): FrameSubmission | null {
        const frame = decodedFrame.frame;
        switch (this.activeInputMode) {
            case 'external-texture':
                if (this.activeInputColorMetadata
                    && !decodedFrameColorMatches(frame, this.activeInputColorMetadata)) {
                    this.fallback(generation, 'decoded-frame-color-mismatch');
                    return null;
                }
                break;
            case 'external-dolby-vision': {
                const device = this.device;
                const profile = this.activeDolbyVisionProfile;
                const storageBuffer = this.dolbyVisionRPUStorageBuffer;
                if (
                    !device
                    || profile !== 5
                    || !storageBuffer
                    || !decodedNeutralBT709FrameColorMatches(frame)
                    || !this.isActiveExternalDolbyVisionAuthorized()
                ) {
                    this.fallback(generation, 'decoded-frame-color-mismatch');
                    return null;
                }
                const packedRPUData = getSingleLayerDolbyVisionRPUData(
                    decodedFrame.encodedDolbyVisionMetadata,
                    10
                );
                if (!packedRPUData) {
                    this.fallback(generation, 'dolby-vision-metadata-invalid');
                    return null;
                }
                device.queue.writeBuffer(storageBuffer, 0, packedRPUData);
                break;
            }
            case 'external-hdr': {
                const metadata = this.activeInputColorMetadata;
                if (
                    !metadata
                    || !decodedNeutralBT709FrameColorMatches(frame)
                    || !this.isActiveExternalHDRAuthorized(metadata)
                ) {
                    this.fallback(generation, 'decoded-frame-color-mismatch');
                    return null;
                }
                break;
            }
            case 'raw-dolby-vision':
            case 'raw-yuv':
                this.fallback(generation, 'decoded-frame-color-mismatch');
                return null;
        }

        const frameWidth = frame.displayWidth || frame.codedWidth;
        const frameHeight = frame.displayHeight || frame.codedHeight;
        return this.renderCurrentFrame(frame, frameWidth, frameHeight);
    }

    private renderDecodedRawFrame(
        decodedFrame: DecodedRawPresentationFrame,
        generation: number
    ): FrameSubmission | null {
        const format = this.activeRawFrameFormat;
        if (!format) {
            this.fallback(generation, 'decoded-frame-color-mismatch');
            return null;
        }
        switch (this.activeInputMode) {
            case 'raw-yuv':
                return this.renderDecodedRawYUVFrame(decodedFrame, generation, format);
            case 'raw-dolby-vision':
                return this.renderDecodedRawDolbyVisionFrame(decodedFrame, generation, format);
            case 'external-dolby-vision':
            case 'external-hdr':
            case 'external-texture':
                this.fallback(generation, 'decoded-frame-color-mismatch');
                return null;
        }
    }

    private renderDecodedRawYUVFrame(
        decodedFrame: DecodedRawPresentationFrame,
        generation: number,
        format: SupportedRawVideoFrameFormat
    ): FrameSubmission | null {
        const inputColorMetadata = this.activeInputColorMetadata;
        if (
            !inputColorMetadata
            || !this.isActiveRawHDRAuthorized(inputColorMetadata, format)
            || !rawFrameDescriptorMatches(decodedFrame, inputColorMetadata, format)
        ) {
            this.fallback(generation, 'decoded-frame-color-mismatch');
            return null;
        }
        return this.renderRawFrame(decodedFrame.frame);
    }

    private renderDecodedRawDolbyVisionFrame(
        decodedFrame: DecodedRawPresentationFrame,
        generation: number,
        format: SupportedRawVideoFrameFormat
    ): FrameSubmission | null {
        const device = this.device;
        const profile = this.activeDolbyVisionProfile;
        const storageBuffer = this.dolbyVisionRPUStorageBuffer;
        if (
            !device
            || !profile
            || !storageBuffer
            || !this.isActiveRawDolbyVisionAuthorized(format, profile)
            || !rawDolbyVisionFrameDescriptorMatches(decodedFrame, format)
            || !rawDolbyVisionEnhancementFrameDescriptorMatches(decodedFrame)
            || (!isDolbyVisionDualLayerProfile(profile) && decodedFrame.enhancementFrame !== undefined)
        ) {
            this.fallback(generation, 'decoded-frame-color-mismatch');
            return null;
        }

        let packedRPUData: ArrayBuffer | null = null;
        let dualLayerRPUData: DualLayerDolbyVisionRPUData | null = null;
        switch (profile) {
            case 5:
            case 8:
                packedRPUData = getSingleLayerDolbyVisionRPUData(
                    decodedFrame.encodedDolbyVisionMetadata,
                    decodedFrame.frame.bitDepth
                );
                break;
            case 4:
            case 7:
                dualLayerRPUData = getDualLayerDolbyVisionRPUData(
                    decodedFrame.encodedDolbyVisionMetadata,
                    profile,
                    decodedFrame.frame.bitDepth,
                    Boolean(decodedFrame.enhancementFrame)
                );
                packedRPUData = dualLayerRPUData?.packedRPUData ?? null;
                break;
        }
        if (!packedRPUData) {
            this.fallback(generation, 'dolby-vision-metadata-invalid');
            return null;
        }

        device.queue.writeBuffer(storageBuffer, 0, packedRPUData);
        const enhancementFrame = getComposedEnhancementFrame(
            dualLayerRPUData,
            this.activeDolbyVisionFELReconstruction,
            decodedFrame.enhancementFrame
        );
        const submission = this.renderRawFrame(decodedFrame.frame, enhancementFrame);
        if (!submission || !dualLayerRPUData) {
            return submission;
        }
        return {
            ...submission,
            dolbyVisionDualLayerMode: getDualLayerPresentation(dualLayerRPUData, enhancementFrame)
        };
    }

    private hasReadyPresentationResources(): boolean {
        return this.surface !== null
            && this.canvas !== null
            && this.canvasContext !== null
            && this.device !== null
            && this.pipeline !== null
            && this.sampler !== null
            && this.presentationUniformBuffer !== null
            && (this.settings.mode === 'identity-sdr' || this.renderSettingsUniformBuffer !== null)
            && (!isDolbyVisionInputMode(this.activeInputMode) || this.dolbyVisionRPUStorageBuffer !== null)
            && (!this.activeDolbyVisionFELReconstruction || this.dolbyVisionEnhancementUniformBuffer !== null);
    }

    private renderCurrentFrame(
        source?: HTMLVideoElement | VideoFrame,
        sourceWidth?: number,
        sourceHeight?: number
    ): FrameSubmission | null {
        if (!isExternalInputMode(this.activeInputMode)) {
            throw new Error('The active WebGPU pipeline does not accept external textures');
        }

        const surface = this.surface;
        const canvas = this.canvas;
        const canvasContext = this.canvasContext;
        const device = this.device;
        const pipeline = this.pipeline;
        const renderSettingsUniformBuffer = this.renderSettingsUniformBuffer;
        const sampler = this.sampler;
        const presentationUniformBuffer = this.presentationUniformBuffer;
        if (
            !surface
            || !canvas
            || !canvasContext
            || !device
            || !pipeline
            || !sampler
            || !presentationUniformBuffer
            || (this.settings.mode === 'hdr-to-sdr' && !renderSettingsUniformBuffer)
        ) {
            throw new Error('WebGPU presentation resources are incomplete');
        }

        const layout = this.getPresentationLayout(
            surface,
            canvas,
            device,
            sourceWidth ?? surface.video.videoWidth,
            sourceHeight ?? surface.video.videoHeight
        );
        if (!layout) {
            return null;
        }

        const validateSubmission = !this.submissionValidated;
        if (validateSubmission) {
            device.pushErrorScope('validation');
        }

        try {
            let dolbyVisionRPUStorageBuffer: GPUBuffer | null = null;
            if (this.activeInputMode === 'external-dolby-vision') {
                dolbyVisionRPUStorageBuffer = this.dolbyVisionRPUStorageBuffer;
                if (!dolbyVisionRPUStorageBuffer) {
                    throw new Error('The external Dolby Vision RPU buffer is unavailable');
                }
            }
            drawExternalTextureFrame({
                device,
                dolbyVisionRPUStorageBuffer,
                pipeline,
                presentation: layout.presentation,
                presentationUniformBuffer,
                presentationUniformValues: this.presentationUniformValues,
                renderSettingsUniformBuffer: this.settings.mode === 'hdr-to-sdr' ? renderSettingsUniformBuffer : null,
                sampler,
                source: source ?? surface.video,
                targetView: canvasContext.getCurrentTexture().createView()
            });
        } catch (error) {
            if (validateSubmission) {
                this.discardErrorScope(device);
            }
            throw error;
        }

        return {
            device,
            validationResult: validateSubmission ? device.popErrorScope() : null
        };
    }

    private renderRawFrame(
        frame: TransferableRawVideoFrame,
        enhancementFrame: TransferableRawVideoFrame | null = null
    ): FrameSubmission | null {
        const surface = this.surface;
        const canvas = this.canvas;
        const canvasContext = this.canvasContext;
        const device = this.device;
        const pipeline = this.pipeline;
        const presentationUniformBuffer = this.presentationUniformBuffer;
        const renderSettingsUniformBuffer = this.renderSettingsUniformBuffer;
        if (
            isExternalInputMode(this.activeInputMode)
            || this.activeRawFrameFormat !== frame.format
            || !surface
            || !canvas
            || !canvasContext
            || !device
            || !pipeline
            || !presentationUniformBuffer
            || (this.settings.mode === 'hdr-to-sdr' && !renderSettingsUniformBuffer)
        ) {
            throw new Error('WebGPU raw presentation resources are incomplete');
        }

        const layout = this.getPresentationLayout(
            surface,
            canvas,
            device,
            frame.displayWidth,
            frame.displayHeight
        );
        if (!layout) {
            return null;
        }

        const validateSubmission = !this.submissionValidated;
        if (validateSubmission) {
            device.pushErrorScope('validation');
        }

        try {
            const renderResult = renderRawYUVFrame({
                device,
                dolbyVisionEnhancementUniformBuffer:
                    this.activeDolbyVisionFELReconstruction ?
                        this.dolbyVisionEnhancementUniformBuffer ?? undefined :
                        undefined,
                dolbyVisionRPUStorageBuffer: this.activeInputMode === 'raw-dolby-vision' ?
                    this.dolbyVisionRPUStorageBuffer ?? undefined :
                    undefined,
                enhancementFrame,
                enhancementTextureSet: this.enhancementRawPlaneTextureSet,
                frame,
                pipeline,
                presentation: layout.presentation,
                presentationUniformBuffer,
                // The buffer outlives an HDR session, and an identity SDR shader declares no binding for it
                renderSettingsUniformBuffer: this.settings.mode === 'hdr-to-sdr' ?
                    renderSettingsUniformBuffer :
                    null,
                targetView: canvasContext.getCurrentTexture().createView(),
                textureSet: this.rawPlaneTextureSet
            });
            this.enhancementRawPlaneTextureSet = renderResult.enhancementTextureSet;
            this.rawPlaneTextureSet = renderResult.textureSet;
            this.presentationUniformValues.set(renderResult.presentationUniformValues);
        } catch (error) {
            if (validateSubmission) {
                this.discardErrorScope(device);
            }
            throw error;
        }

        return {
            device,
            validationResult: validateSubmission ? device.popErrorScope() : null
        };
    }

    private completeFrameSubmission(
        submission: FrameSubmission,
        generation: number,
        video: HTMLVideoElement,
        mediaTimeMicroseconds: Microseconds,
        callbackTimeMicroseconds: Microseconds,
        expectedDisplayTimeMicroseconds: Microseconds
    ): void {
        this.completeSubmission(submission, generation, () => {
            if (!this.isCurrent(generation) || this.surface?.video !== video) {
                return;
            }

            this.recordPresentedFrame(
                mediaTimeMicroseconds,
                callbackTimeMicroseconds,
                expectedDisplayTimeMicroseconds,
                'native'
            );
            this.recordDolbyVisionDualLayerPresentation(submission);
            this.scheduleFrameCallback(generation);
        });
    }

    private recordDolbyVisionDualLayerPresentation(submission: FrameSubmission): void {
        this.recordDolbyVisionDualLayerMode(submission.dolbyVisionDualLayerMode);
    }

    private recordDolbyVisionDualLayerMode(dolbyVisionDualLayerMode: DolbyVisionDualLayerPresentation | null | undefined): void {
        switch (dolbyVisionDualLayerMode) {
            case 'fel':
                this.telemetry.dolbyVisionDualLayerFELPresentedFrameCount += 1;
                break;
            case 'fel-base-fallback':
                this.telemetry.dolbyVisionDualLayerFELBaseFallbackPresentedFrameCount += 1;
                break;
            case 'mel':
                this.telemetry.dolbyVisionDualLayerMELPresentedFrameCount += 1;
                break;
            case null:
            case undefined:
                break;
        }
    }

    private completeSubmission(
        submission: FrameSubmission,
        generation: number,
        validatedHandler: () => void
    ): void {
        if (!submission.validationResult) {
            this.markCanvasPresented();
            validatedHandler();
            return;
        }

        const pendingValidation: PendingSubmissionValidation = {
            device: submission.device,
            generation,
            resourceEpoch: this.deviceResourceEpoch,
            validationResult: submission.validationResult
        };
        this.pendingSubmissionValidation = pendingValidation;
        void this.resolveSubmissionValidation(pendingValidation, validatedHandler);
    }

    /** Releases external VideoFrame backpressure only after GPU use finishes. */
    private notifyWhenGPUWorkCompleted(
        device: GPUDevice,
        completedHandler: (gpuWorkCompleted: boolean) => void
    ): void {
        const submittedAtEpochMilliseconds = startTimingWait();
        const notify = (gpuWorkCompleted: boolean): void => {
            recordTimingWait('gpu-work-done', submittedAtEpochMilliseconds, { completed: gpuWorkCompleted });
            try {
                completedHandler(gpuWorkCompleted);
            } catch (error) {
                console.warn('Decoded VideoFrame completion handler failed', error);
            }
        };
        void device.queue.onSubmittedWorkDone().then((): void => notify(true), (): void => notify(false));
    }

    /** Waits the bounded raw SDR prewarm used for Rext negotiation. */
    async waitForRawSDRAuthorizationPrewarm(): Promise<void> {
        await waitForRawHDRNegotiationProbe(
            this.prewarmRawSDRPresentationAuthorization().then((): Promise<void> => {
                const device = this.device;
                const targetFormat = this.canvasFormat;
                return device && targetFormat ?
                    this.rawHDRAuthorization.waitForPending(device, targetFormat) :
                    Promise.resolve();
            })
        );
    }

    private async resolveSubmissionValidation(
        pendingValidation: PendingSubmissionValidation,
        validatedHandler: () => void
    ): Promise<void> {
        let validationResult: GPUError | null | typeof WEBGPU_RESOURCE_OPERATION_TIMEOUT;
        try {
            validationResult = await waitForWebGPUResourceOperation(pendingValidation.validationResult);
        } catch (error) {
            if (this.pendingSubmissionValidation !== pendingValidation) {
                return;
            }

            this.pendingSubmissionValidation = null;
            console.warn('Unable to resolve the WebGPU submission validation scope', error);
            this.fallback(pendingValidation.generation, 'frame-render-failed');
            return;
        }

        if (this.pendingSubmissionValidation !== pendingValidation) {
            return;
        }
        this.pendingSubmissionValidation = null;

        if (
            !this.isCurrent(pendingValidation.generation)
            || this.fallbackLatched
            || this.deviceResourceEpoch !== pendingValidation.resourceEpoch
            || this.device !== pendingValidation.device
        ) {
            return;
        }

        if (validationResult === WEBGPU_RESOURCE_OPERATION_TIMEOUT) {
            console.warn('WebGPU submission validation timed out');
            this.fallback(pendingValidation.generation, 'frame-render-failed');
            return;
        }

        if (validationResult) {
            console.warn('WebGPU submission validation failed', validationResult.message);
            this.fallback(pendingValidation.generation, 'frame-render-failed');
            return;
        }

        this.submissionValidated = true;
        this.markCanvasPresented();
        validatedHandler();
    }

    private markCanvasPresented(): void {
        this.canvas?.classList.add(CANVAS_VISIBLE_CLASS);
        // Exactly one canvas shows
        this.workerRenderer?.canvas.classList.remove(CANVAS_VISIBLE_CLASS);
        this.telemetry.state = 'presenting';
    }

    private markWorkerCanvasPresented(attachment: WorkerRendererAttachment): void {
        attachment.canvas.classList.add(CANVAS_VISIBLE_CLASS);
        this.canvas?.classList.remove(CANVAS_VISIBLE_CLASS);
        this.telemetry.state = 'presenting';
    }

    /**
     * Asks the worker renderer to draw a frame the decode worker keeps; the completion handler runs once the frame's GPU work ended.
     * A frame the renderer cannot take yet is refused, as a pending color configuration refuses one on the page.
     */
    private presentWorkerFrame(
        decodedFrame: DecodedWorkerPresentationFrame,
        generation: number,
        completed: ((gpuWorkCompleted: boolean) => void) | undefined
    ): boolean {
        const attachment = this.workerRenderer;
        const surface = this.surface;
        if (!attachment || !surface) {
            // Only a renderer can draw a frame that never left the worker
            this.fallback(generation, 'frame-render-failed');
            return false;
        }
        if (
            this.pendingColorConfiguration?.generation === generation
            || attachment.status !== 'ready'
            || attachment.configuredRevision !== attachment.configureRevision
        ) {
            return false;
        }
        if (decodedFrame.displayWidth <= 0 || decodedFrame.displayHeight <= 0) {
            this.fallback(generation, 'frame-render-failed');
            return false;
        }

        this.decodedFramePushActive = true;
        this.cancelFrameCallback();
        const layout = this.getWorkerPresentationLayout(
            surface,
            attachment,
            decodedFrame.displayWidth,
            decodedFrame.displayHeight
        );
        if (!layout) {
            return false;
        }
        if (!this.postWorkerRendererRequest(attachment, {
            frameId: decodedFrame.frameId,
            generation: decodedFrame.decodeGeneration,
            layoutRevision: layout.revision,
            type: 'present'
        })) {
            this.fallback(generation, 'frame-render-failed');
            return false;
        }
        attachment.pendingPresents.push({
            callbackTimeMicroseconds: getMonotonicMicroseconds(),
            completed,
            decodeGeneration: decodedFrame.decodeGeneration,
            frameId: decodedFrame.frameId,
            generation,
            mediaTimeMicroseconds: decodedFrame.mediaTimeMicroseconds
        });
        return true;
    }

    private handleWorkerRendererMessage(attachment: WorkerRendererAttachment, value: unknown): void {
        if (this.workerRenderer !== attachment) {
            return;
        }
        if (!isWorkerPresentationResponse(value)) {
            console.warn('The worker presentation renderer sent an invalid message');
            this.fallback(this.activeGeneration, 'frame-render-failed');
            return;
        }

        switch (value.type) {
            case 'status':
                if (value.state === 'ready') {
                    attachment.status = 'ready';
                    return;
                }
                // The session presents on the page instead, so the renderer's canvas goes
                this.detachWorkerRenderer();
                return;
            case 'configured': {
                if (value.revision !== attachment.configureRevision) {
                    // A newer configure is on its way
                    return;
                }
                const pendingConfiguration = attachment.pendingConfiguration?.revision === value.revision ?
                    attachment.pendingConfiguration :
                    null;
                if (pendingConfiguration) {
                    attachment.pendingConfiguration = null;
                }
                if (!value.ok) {
                    pendingConfiguration?.resolve('refused');
                    this.fallback(this.activeGeneration, value.reason ?? 'pipeline-creation-failed');
                    return;
                }
                attachment.configuredRevision = value.revision;
                pendingConfiguration?.resolve('accepted');
                return;
            }
            case 'presented':
                this.completeWorkerFramePresentation(attachment, value);
                return;
            case 'failed':
                this.fallback(this.activeGeneration, value.reason);
                return;
        }
    }

    /** Records a frame the renderer drew, as a validated submission is recorded on the page, and releases its selection. */
    private completeWorkerFramePresentation(
        attachment: WorkerRendererAttachment,
        response: WorkerPresentationPresentedResponse
    ): void {
        const pendingPresentIndex = attachment.pendingPresents.findIndex((pendingPresent: PendingWorkerPresent): boolean => (
            pendingPresent.decodeGeneration === response.generation && pendingPresent.frameId === response.frameId
        ));
        if (pendingPresentIndex < 0) {
            return;
        }
        const [ pendingPresent ] = attachment.pendingPresents.splice(pendingPresentIndex, 1);
        if (response.ok && this.isCurrent(pendingPresent.generation) && !this.fallbackLatched) {
            this.markWorkerCanvasPresented(attachment);
            this.recordPresentedFrame(
                pendingPresent.mediaTimeMicroseconds,
                pendingPresent.callbackTimeMicroseconds,
                pendingPresent.callbackTimeMicroseconds,
                'decoded'
            );
            this.recordDolbyVisionDualLayerMode(response.dolbyVisionDualLayerMode);
            this.recordWorkerHDR10PlusResult(response.HDR10PlusResult);
        }
        notifyWorkerFrameCompletion(pendingPresent.completed, response.ok && response.gpuWorkCompleted);
    }

    /** Counts a worker frame's HDR10+ result as the page counts the frames it tone-maps itself. */
    private recordWorkerHDR10PlusResult(result: WorkerPresentationHDR10PlusResult | null): void {
        if (!result) {
            return;
        }
        this.telemetry.lastHDR10PlusMetadataStatus = result.metadataStatus;
        if (result.inputPeakNits === null) {
            this.telemetry.staticFallbackHDR10PlusFrameCount += 1;
            this.telemetry.lastHDR10PlusInputPeakNits = null;
            return;
        }
        this.telemetry.appliedHDR10PlusFrameCount += 1;
        if (result.metadataStatus !== 'valid') {
            this.telemetry.carriedHDR10PlusFrameCount += 1;
        }
        this.telemetry.lastHDR10PlusInputPeakNits = result.inputPeakNits;
    }

    /**
     * Ends the worker renderer's attachment: the renderer releases its device, its canvas leaves the page, and frames it was asked to draw are discarded.
     * The decode worker keeps the attachment's frames until the session releases them.
     */
    private detachWorkerRenderer(): void {
        const attachment = this.workerRenderer;
        if (!attachment) {
            return;
        }
        this.workerRenderer = null;
        attachment.port.onmessage = null;
        this.postWorkerRendererRequest(attachment, { type: 'detach' });
        attachment.port.close();
        attachment.canvas.remove();
        const pendingConfiguration = attachment.pendingConfiguration;
        attachment.pendingConfiguration = null;
        pendingConfiguration?.resolve('released');
        for (const pendingPresent of attachment.pendingPresents.splice(0)) {
            notifyWorkerFrameCompletion(pendingPresent.completed, false);
        }
    }

    /**
     * Returns the layout a worker frame of this size draws in, posting it to the renderer when it changed.
     * The canvas element keeps its page geometry here, while the renderer sizes the backing store it took over.
     */
    private getWorkerPresentationLayout(
        surface: PresentationSurface,
        attachment: WorkerRendererAttachment,
        sourceWidth: number,
        sourceHeight: number
    ): CachedWorkerPresentationLayout | null {
        const devicePixelRatio = Math.max(window.devicePixelRatio || 1, 1);
        const cachedLayout = attachment.layout;
        if (
            cachedLayout
            && !attachment.layoutDirty
            && cachedLayout.devicePixelRatio === devicePixelRatio
            && cachedLayout.videoHeight === sourceHeight
            && cachedLayout.videoWidth === sourceWidth
        ) {
            return cachedLayout;
        }

        const geometry = this.synchronizeCanvasGeometry(
            surface,
            attachment.canvas,
            this.device?.limits.maxTextureDimension2D ?? WEBGPU_DEFAULT_MAXIMUM_TEXTURE_DIMENSION,
            devicePixelRatio,
            false
        );
        if (!geometry) {
            attachment.layoutDirty = true;
            return null;
        }
        const layout: CachedPresentationLayout = {
            devicePixelRatio,
            geometry,
            presentation: this.calculateTexturePresentation(surface.video, geometry, sourceWidth, sourceHeight),
            videoHeight: sourceHeight,
            videoWidth: sourceWidth
        };
        attachment.layoutDirty = false;
        if (cachedLayout && this.presentationLayoutsMatch(cachedLayout, layout)) {
            return cachedLayout;
        }

        const revision = attachment.layoutRevision + 1;
        const layoutRequest: WorkerPresentationLayoutRequest = {
            backingHeight: geometry.height,
            backingWidth: geometry.width,
            presentation: layout.presentation,
            revision,
            type: 'layout'
        };
        if (!this.postWorkerRendererRequest(attachment, layoutRequest)) {
            attachment.layoutDirty = true;
            return null;
        }
        attachment.layoutRevision = revision;
        attachment.layout = { ...layout, revision };
        return attachment.layout;
    }

    /** Recomputes the worker canvas layout after a layout change, and reports whether the renderer got a new one. */
    private resynchronizeWorkerPresentationLayout(): boolean {
        const attachment = this.workerRenderer;
        const surface = this.surface;
        const cachedLayout = attachment?.layout ?? null;
        if (!attachment || !surface || !cachedLayout) {
            return false;
        }
        attachment.layoutDirty = true;
        const updatedLayout = this.getWorkerPresentationLayout(
            surface,
            attachment,
            cachedLayout.videoWidth,
            cachedLayout.videoHeight
        );
        return updatedLayout !== null && updatedLayout.revision !== cachedLayout.revision;
    }

    private discardErrorScope(device: GPUDevice): void {
        let discardedScope: Promise<GPUError | null>;
        // popErrorScope can also fail synchronously when the scope stack is unavailable
        // eslint-disable-next-line sonarjs/no-try-promise
        try {
            discardedScope = device.popErrorScope();
        } catch (error) {
            console.warn('Unable to discard the WebGPU validation scope', error);
            return;
        }

        void discardedScope.catch(error => {
            console.warn('Unable to discard the WebGPU validation scope', error);
        });
    }

    /**
     * Places a canvas over the video and returns its CSS and backing sizes.
     * A canvas transferred to the worker renderer keeps its backing store there, so only the page canvas is resized here.
     */
    private synchronizeCanvasGeometry(
        surface: PresentationSurface,
        canvas: HTMLCanvasElement,
        maximumDimension: number,
        devicePixelRatio: number,
        resizesBackingStore: boolean
    ): CanvasGeometry | null {
        const containerRectangle = surface.container.getBoundingClientRect();
        const videoRectangle = surface.video.getBoundingClientRect();
        if (videoRectangle.width <= 0 || videoRectangle.height <= 0) {
            return null;
        }

        const containerScaleX = surface.container.clientWidth > 0 ?
            containerRectangle.width / surface.container.clientWidth :
            1;
        const containerScaleY = surface.container.clientHeight > 0 ?
            containerRectangle.height / surface.container.clientHeight :
            1;
        const normalizedScaleX = containerScaleX > 0 ? containerScaleX : 1;
        const normalizedScaleY = containerScaleY > 0 ? containerScaleY : 1;
        const canvasLeft = (videoRectangle.left - containerRectangle.left) / normalizedScaleX;
        const canvasTop = (videoRectangle.top - containerRectangle.top) / normalizedScaleY;
        const canvasWidth = videoRectangle.width / normalizedScaleX;
        const canvasHeight = videoRectangle.height / normalizedScaleY;

        canvas.style.left = `${canvasLeft}px`;
        canvas.style.top = `${canvasTop}px`;
        canvas.style.width = `${canvasWidth}px`;
        canvas.style.height = `${canvasHeight}px`;

        const backingScale = Math.min(
            devicePixelRatio,
            maximumDimension / canvasWidth,
            maximumDimension / canvasHeight
        );
        const backingWidth = Math.max(MIN_CANVAS_DIMENSION, Math.round(canvasWidth * backingScale));
        const backingHeight = Math.max(MIN_CANVAS_DIMENSION, Math.round(canvasHeight * backingScale));

        if (resizesBackingStore && canvas.width !== backingWidth) {
            canvas.width = backingWidth;
        }
        if (resizesBackingStore && canvas.height !== backingHeight) {
            canvas.height = backingHeight;
        }

        return {
            cssHeight: canvasHeight,
            cssWidth: canvasWidth,
            height: backingHeight,
            width: backingWidth
        };
    }

    private getPresentationLayout(
        surface: PresentationSurface,
        canvas: HTMLCanvasElement,
        device: GPUDevice,
        sourceWidth: number,
        sourceHeight: number
    ): CachedPresentationLayout | null {
        if (sourceWidth <= 0 || sourceHeight <= 0) {
            this.invalidatePresentationLayout();
            return null;
        }

        const devicePixelRatio = Math.max(window.devicePixelRatio || 1, 1);
        const cachedLayout = this.cachedPresentationLayout;
        if (
            cachedLayout
            && !this.presentationLayoutDirty
            && cachedLayout.devicePixelRatio === devicePixelRatio
            && cachedLayout.videoHeight === sourceHeight
            && cachedLayout.videoWidth === sourceWidth
        ) {
            return cachedLayout;
        }

        this.invalidatePresentationLayout();
        const geometry = this.synchronizeCanvasGeometry(
            surface,
            canvas,
            device.limits.maxTextureDimension2D,
            devicePixelRatio,
            true
        );
        if (!geometry) {
            return null;
        }

        const presentation = this.calculateTexturePresentation(surface.video, geometry, sourceWidth, sourceHeight);
        const layout: CachedPresentationLayout = {
            devicePixelRatio,
            geometry,
            presentation,
            videoHeight: sourceHeight,
            videoWidth: sourceWidth
        };
        this.cachedPresentationLayout = layout;
        this.presentationLayoutDirty = false;
        return layout;
    }

    private calculateTexturePresentation(
        video: HTMLVideoElement,
        geometry: CanvasGeometry,
        sourceWidth: number,
        sourceHeight: number
    ): TexturePresentation {
        const computedStyle = window.getComputedStyle(video);
        return calculateTexturePresentationGeometry({
            objectFit: computedStyle.objectFit || 'fill',
            objectPosition: computedStyle.objectPosition || '50% 50%',
            sourceHeight,
            sourceWidth,
            targetCSSHeight: geometry.cssHeight,
            targetCSSWidth: geometry.cssWidth,
            targetPixelHeight: geometry.height,
            targetPixelWidth: geometry.width
        });
    }

    private recordPresentedFrame(
        mediaTimeMicroseconds: Microseconds,
        callbackTimeMicroseconds: Microseconds,
        expectedDisplayTimeMicroseconds: Microseconds,
        presentationSource: 'decoded' | 'native'
    ): void {
        this.telemetry.lastCallbackTimeMicroseconds = callbackTimeMicroseconds;
        this.telemetry.lastExpectedDisplayTimeMicroseconds = expectedDisplayTimeMicroseconds;
        this.telemetry.lastPresentedMediaTimeMicroseconds = mediaTimeMicroseconds;
        this.telemetry.presentationSource = presentationSource;
        this.telemetry.presentedFrameCount += 1;
        switch (presentationSource) {
            case 'decoded':
                this.telemetry.decodedFrameCount += 1;
                break;
            case 'native':
                this.telemetry.nativeFrameCount += 1;
                break;
        }

        if (this.telemetry.firstPresentedMediaTimeMicroseconds == null) {
            this.telemetry.firstPresentedMediaTimeMicroseconds = mediaTimeMicroseconds;
            this.telemetry.firstFrameLatencyMicroseconds = millisecondsToMicroseconds(
                Number(callbackTimeMicroseconds - this.telemetry.sessionStartedMicroseconds)
                / 1_000
            );
        }
    }

    private invalidatePresentationLayout(): void {
        this.presentationLayoutDirty = true;
        if (this.workerRenderer) {
            this.workerRenderer.layoutDirty = true;
        }
    }

    private readonly handleLayoutInvalidation = (): void => {
        if (!this.sessionActive || this.fallbackLatched) {
            return;
        }

        if (!this.resynchronizeDecodedPresentationLayouts()) {
            return;
        }
        if (this.decodedFramePushActive) {
            this.requestDecodedPresentationRefresh(this.activeGeneration);
            return;
        }
        this.renderCurrentFrameOrFallback(this.activeGeneration);
    };

    private resynchronizeCachedPresentationLayout(): boolean {
        const cachedLayout = this.cachedPresentationLayout;
        const surface = this.surface;
        const canvas = this.canvas;
        const device = this.device;
        this.invalidatePresentationLayout();
        if (!cachedLayout || !surface || !canvas || !device) {
            return false;
        }

        const updatedLayout = this.getPresentationLayout(
            surface,
            canvas,
            device,
            cachedLayout.videoWidth,
            cachedLayout.videoHeight
        );
        if (!updatedLayout) {
            return false;
        }
        return !this.presentationLayoutsMatch(cachedLayout, updatedLayout);
    }

    private presentationLayoutsMatch(first: CachedPresentationLayout, second: CachedPresentationLayout): boolean {
        return first.devicePixelRatio === second.devicePixelRatio
            && first.videoHeight === second.videoHeight
            && first.videoWidth === second.videoWidth
            && first.geometry.cssHeight === second.geometry.cssHeight
            && first.geometry.cssWidth === second.geometry.cssWidth
            && first.geometry.height === second.geometry.height
            && first.geometry.width === second.geometry.width
            && first.presentation.textureOffsetX === second.presentation.textureOffsetX
            && first.presentation.textureOffsetY === second.presentation.textureOffsetY
            && first.presentation.textureScaleX === second.presentation.textureScaleX
            && first.presentation.textureScaleY === second.presentation.textureScaleY
            && first.presentation.viewportHeight === second.presentation.viewportHeight
            && first.presentation.viewportWidth === second.presentation.viewportWidth
            && first.presentation.viewportX === second.presentation.viewportX
            && first.presentation.viewportY === second.presentation.viewportY;
    }

    private requestDecodedPresentationRefresh(generation: number): void {
        if (
            !this.decodedFramePushActive
            || !this.surface
            || !this.isCurrent(generation)
            || this.fallbackLatched
        ) {
            return;
        }

        this.decodedPresentationRefreshHandler(generation);
    }

    private renderCurrentFrameOrFallback(generation: number): void {
        const video = this.surface?.video;
        if (
            !this.isCurrent(generation)
            || this.activeInputMode !== 'external-texture'
            || !video
            || video.readyState < VIDEO_READY_STATE_CURRENT_DATA
            || !this.canvas
            || !this.canvasContext
            || !this.device
            || !this.pipeline
            || !this.presentationUniformBuffer
            || !this.sampler
            || (this.settings.mode === 'hdr-to-sdr' && !this.renderSettingsUniformBuffer)
            || this.pendingSubmissionValidation
        ) {
            return;
        }

        this.cancelFrameCallback();
        try {
            const submission = this.renderCurrentFrame();
            if (!submission) {
                this.scheduleFrameCallback(generation);
                return;
            }

            this.completeSubmission(submission, generation, () => {
                this.scheduleFrameCallback(generation);
            });
        } catch (error) {
            console.warn('WebGPU resize presentation failed', error);
            this.fallback(generation, 'frame-render-failed');
        }
    }

    private readonly handleLayoutMotionStart = (event: Event): void => {
        if (!this.isObservedLayoutTarget(event.target)) {
            return;
        }

        this.handleLayoutInvalidation();
    };

    private readonly handleLayoutMotionIteration = (event: Event): void => {
        if (!this.isObservedLayoutTarget(event.target)) {
            return;
        }

        this.handleLayoutInvalidation();
    };

    private readonly handleLayoutMotionEnd = (event: Event): void => {
        if (!this.isObservedLayoutTarget(event.target)) {
            return;
        }

        // The final event is required because transforms do not trigger ResizeObserver
        this.handleLayoutInvalidation();
    };

    private isObservedLayoutTarget(target: EventTarget | null): boolean {
        if (!(target instanceof HTMLElement)) {
            return false;
        }

        return target.isSameNode(this.surface?.container ?? null)
            || target.isSameNode(this.surface?.video ?? null);
    }

    private bindLayoutHandling(surface: PresentationSurface): void {
        this.unbindLayoutHandling();
        const layoutHandlingRevision = this.layoutHandlingRevision;
        const layoutInvalidationHandler = (): void => {
            if (this.layoutHandlingRevision !== layoutHandlingRevision) {
                return;
            }
            this.handleLayoutInvalidation();
        };
        this.layoutInvalidationHandler = layoutInvalidationHandler;
        if (typeof ResizeObserver === 'function') {
            this.resizeObserver = new ResizeObserver(layoutInvalidationHandler);
            this.resizeObserver.observe(surface.container);
            this.resizeObserver.observe(surface.video);
        }
        if (typeof MutationObserver === 'function') {
            this.layoutMutationObserver = new MutationObserver(layoutInvalidationHandler);
            const observerOptions: MutationObserverInit = {
                attributeFilter: [ 'class', 'style' ],
                attributes: true
            };
            const mutationTargets: HTMLElement[] = [];
            mutationTargets.push(surface.video);
            let mutationTarget: HTMLElement | null = surface.container;
            while (mutationTarget) {
                mutationTargets.push(mutationTarget);
                mutationTarget = mutationTarget.parentElement;
            }
            for (const target of mutationTargets) {
                this.layoutMutationObserver.observe(target, observerOptions);
            }
        }
        for (const eventName of LAYOUT_MOTION_START_EVENTS) {
            surface.container.addEventListener(eventName, this.handleLayoutMotionStart, true);
        }
        surface.container.addEventListener(LAYOUT_MOTION_ITERATION_EVENT, this.handleLayoutMotionIteration, true);
        for (const eventName of LAYOUT_MOTION_END_EVENTS) {
            surface.container.addEventListener(eventName, this.handleLayoutMotionEnd, true);
        }
        window.addEventListener('resize', layoutInvalidationHandler);
    }

    private unbindLayoutHandling(): void {
        this.layoutHandlingRevision += 1;
        const container = this.surface?.container;
        if (container) {
            for (const eventName of LAYOUT_MOTION_START_EVENTS) {
                container.removeEventListener(eventName, this.handleLayoutMotionStart, true);
            }
            container.removeEventListener(LAYOUT_MOTION_ITERATION_EVENT, this.handleLayoutMotionIteration, true);
            for (const eventName of LAYOUT_MOTION_END_EVENTS) {
                container.removeEventListener(eventName, this.handleLayoutMotionEnd, true);
            }
        }
        this.layoutMutationObserver?.disconnect();
        this.layoutMutationObserver = null;
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        if (this.layoutInvalidationHandler) {
            window.removeEventListener('resize', this.layoutInvalidationHandler);
            this.layoutInvalidationHandler = null;
        }
    }

    private cancelFrameCallback(): void {
        const pendingFrameCallback = this.pendingFrameCallback;
        this.pendingFrameCallback = null;
        if (!pendingFrameCallback) {
            return;
        }

        try {
            pendingFrameCallback.video.cancelVideoFrameCallback(pendingFrameCallback.id);
        } catch (error) {
            console.warn('Unable to cancel the video frame callback', error);
        }
    }

    private discardPendingSubmissionValidation(): void {
        if (!this.pendingSubmissionValidation) {
            return;
        }

        this.pendingSubmissionValidation = null;
        this.submissionValidated = false;
    }

    private removeCanvas(): void {
        try {
            this.canvasContext?.unconfigure();
        } catch (error) {
            console.warn('Unable to unconfigure the WebGPU canvas', error);
        }
        this.canvas?.remove();
        this.canvas = null;
        this.canvasContext = null;
        this.cachedPresentationLayout = null;
        this.invalidatePresentationLayout();
        this.configuredDevice = null;
    }

    private destroyRawPlaneTextures(): void {
        const textureSet = this.rawPlaneTextureSet;
        const enhancementTextureSet = this.enhancementRawPlaneTextureSet;
        this.rawPlaneTextureSet = null;
        this.enhancementRawPlaneTextureSet = null;
        try {
            destroyRawPlaneTextureSet(textureSet);
            destroyRawPlaneTextureSet(enhancementTextureSet);
        } catch (error) {
            console.warn('Unable to destroy WebGPU raw video plane textures', error);
        }
    }

    private destroyDolbyVisionRPUStorageBuffer(): void {
        const storageBuffer = this.dolbyVisionRPUStorageBuffer;
        this.dolbyVisionRPUStorageBuffer = null;
        try {
            storageBuffer?.destroy();
        } catch (error) {
            console.warn('Unable to destroy WebGPU Dolby Vision RPU buffer', error);
        }
    }

    private destroyDolbyVisionEnhancementUniformBuffer(): void {
        const uniformBuffer = this.dolbyVisionEnhancementUniformBuffer;
        this.dolbyVisionEnhancementUniformBuffer = null;
        try {
            uniformBuffer?.destroy();
        } catch (error) {
            console.warn('Unable to destroy WebGPU Dolby Vision enhancement buffer', error);
        }
    }

    private async handleDeviceLoss(lostDevice: GPUDevice, deviceLostInfo: GPUDeviceLostInfo): Promise<void> {
        if (this.device !== lostDevice) {
            return;
        }

        console.warn(`WebGPU device lost: ${deviceLostInfo.reason}`, deviceLostInfo.message);
        this.deviceResourceEpoch += 1;
        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.unbindLayoutHandling();
        this.removeCanvas();
        this.destroyRawPlaneTextures();
        this.destroyDolbyVisionRPUStorageBuffer();
        this.destroyDolbyVisionEnhancementUniformBuffer();
        this.device = null;
        this.pipeline = null;
        this.pipelineShaderCode = null;
        this.presentationUniformBuffer = null;
        this.renderSettingsUniformBuffer = null;
        this.dynamicHDR10PlusSettingsActive = false;
        this.sampler = null;
        this.submissionValidated = false;
        this.configuredDevice = null;

        const generation = this.activeGeneration;
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }
        this.telemetry.state = 'initializing';

        if (this.deviceRecoveryAttempts >= MAX_DEVICE_RECOVERY_ATTEMPTS) {
            this.fallback(generation, 'device-recovery-failed');
            return;
        }

        this.deviceRecoveryAttempts += 1;
        this.telemetry.deviceRecoveryCount = this.deviceRecoveryAttempts;
        const recovered = await this.ensureDevice();
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }

        if (!recovered) {
            this.fallback(generation, 'device-recovery-failed');
            return;
        }

        let presentationReauthorized = true;
        switch (this.activeInputMode) {
            case 'external-texture':
                break;
            case 'external-hdr':
                presentationReauthorized = await this.reauthorizeExternalHDRPresentation(generation);
                break;
            case 'external-dolby-vision':
            case 'raw-dolby-vision':
                presentationReauthorized = await this.reauthorizeDolbyVisionPresentation(
                    generation
                ) && this.createDolbyVisionRPUStorageBuffer()
                    && (
                        !this.activeDolbyVisionFELReconstruction
                        || this.createDolbyVisionEnhancementUniformBuffer()
                    );
                break;
            case 'raw-yuv':
                presentationReauthorized = await this.reauthorizeRawHDRPresentation(generation);
                break;
        }
        if (!presentationReauthorized) {
            if (this.isCurrent(generation) && !this.fallbackLatched) {
                this.fallback(generation, 'device-recovery-failed');
            }
            return;
        }

        if (this.pendingColorConfiguration?.generation === generation) {
            return;
        }

        if (!this.createAndConfigureCanvas()) {
            this.fallback(generation, 'device-recovery-failed');
            return;
        }

        if (this.decodedFramePushActive) {
            this.requestDecodedPresentationRefresh(generation);
        } else {
            this.scheduleFrameCallback(generation);
        }
    }

    private async reauthorizeRawHDRPresentation(generation: number): Promise<boolean> {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        const metadata = this.activeInputColorMetadata;
        const rawFrameFormat = this.activeRawFrameFormat;
        if (
            !device
            || !targetFormat
            || !metadata
            || !rawFrameFormat
            || this.settings.mode !== 'hdr-to-sdr'
        ) {
            return false;
        }
        const routeKey = getRawHDRAuthorizationRouteKey(rawFrameFormat, metadata);
        if (!routeKey) {
            return false;
        }

        const decision = await this.rawHDRAuthorization.authorize(device, targetFormat, routeKey);
        if (
            !this.isCurrent(generation)
            || this.fallbackLatched
            || this.device !== device
            || decision.status !== 'authorized'
        ) {
            return false;
        }
        return this.rawHDRAuthorization.isAuthorized(
            device,
            targetFormat,
            metadata,
            this.settings,
            rawFrameFormat
        );
    }

    private async reauthorizeExternalHDRPresentation(generation: number): Promise<boolean> {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        const metadata = this.activeInputColorMetadata;
        if (
            !device
            || !targetFormat
            || !metadata
            || this.settings.mode !== 'hdr-to-sdr'
        ) {
            return false;
        }
        const routeKey = getExternalHDRAuthorizationRouteKey(metadata);
        if (!routeKey) {
            return false;
        }

        const decision = await this.externalHDRAuthorization.authorize(device, targetFormat, routeKey);
        if (
            !this.isCurrent(generation)
            || this.fallbackLatched
            || this.device !== device
            || decision.status !== 'authorized'
        ) {
            return false;
        }
        return this.externalHDRAuthorization.isAuthorized(device, targetFormat, metadata, this.settings);
    }

    private async reauthorizeDolbyVisionPresentation(generation: number): Promise<boolean> {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (!device || !targetFormat || this.settings.mode !== 'hdr-to-sdr') {
            return false;
        }
        const externalInput = this.activeInputMode === 'external-dolby-vision';
        const rawFrameFormat = this.activeRawFrameFormat;
        const activeProfile = this.activeDolbyVisionProfile;
        if (externalInput) {
            const externalDecision = await this.externalDolbyVisionAuthorization.authorize(device, targetFormat);
            return this.isCurrent(generation)
                && !this.fallbackLatched
                && this.device === device
                && externalDecision.status === 'authorized'
                && this.externalDolbyVisionAuthorization.isAuthorized(device, targetFormat, this.settings);
        }
        if (!rawFrameFormat || !isRawDolbyVisionVideoFrameFormat(rawFrameFormat) || activeProfile === null) {
            return false;
        }
        const rawAuthorizations = this.getRawDolbyVisionAuthorizations(activeProfile, rawFrameFormat);
        const decision = await rawAuthorizations.base.authorize(device, targetFormat);
        if (
            !this.isCurrent(generation)
            || this.fallbackLatched
            || this.device !== device
            || decision.status !== 'authorized'
        ) {
            return false;
        }
        const felAuthorization = this.activeDolbyVisionFELReconstruction ?
            rawAuthorizations.fel :
            null;
        if (felAuthorization) {
            const felDecision = await felAuthorization.authorize(device, targetFormat);
            if (
                !this.isCurrent(generation)
                || this.fallbackLatched
                || this.device !== device
                || felDecision.status !== 'authorized'
            ) {
                return false;
            }
        }
        return rawAuthorizations.base.isAuthorized(device, targetFormat, this.settings, rawFrameFormat) && (
            felAuthorization === null
            || felAuthorization.isAuthorized(device, targetFormat, this.settings, rawFrameFormat)
        );
    }

    private handleUncapturedError(device: GPUDevice, event: GPUUncapturedErrorEvent): void {
        if (this.device !== device) {
            return;
        }

        const generation = this.activeGeneration;
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }

        event.preventDefault();
        console.warn('Uncaptured WebGPU error', event.error.message);
        this.fallback(generation, 'frame-render-failed');
    }

    private fallback(generation: number, reason: PresentationFallbackReason): void {
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }

        this.fallbackLatched = true;
        this.colorConfigurationRevision += 1;
        this.pendingColorConfiguration = null;
        this.telemetry.fallbackReason = reason;
        this.telemetry.state = 'fallback';
        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.unbindLayoutHandling();
        this.removeCanvas();
        this.detachWorkerRenderer();
        this.destroyRawPlaneTextures();
        this.destroyDolbyVisionRPUStorageBuffer();
        this.destroyDolbyVisionEnhancementUniformBuffer();
        this.decodedFramePushActive = false;
        this.activeInputColorMetadata = null;
        this.activeDolbyVisionProfile = null;
        this.activeDolbyVisionFELReconstruction = false;
        this.activeInputMode = 'external-texture';
        this.activeRawFrameFormat = null;
        this.surface = null;
        console.warn(`WebGPU presentation disabled for this session: ${reason}`);
        this.fallbackHandler(generation, reason);
    }

    private isCurrent(generation: number): boolean {
        return this.sessionActive && this.activeGeneration === generation;
    }
}
