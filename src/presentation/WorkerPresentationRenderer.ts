// The decode worker's renderer: it draws the frames that worker-mode runs keep into the canvas the page transferred, with a GPU device of its own
// The page selects each frame and lays out the canvas; the renderer authorizes the page's pipeline on its own device, and answers each present once the frame's GPU work ended

import type { InputColorMetadata } from '../color/ColorMetadata';
import { isRawDolbyVisionVideoFrameFormat, type RawDolbyVisionVideoFrameFormat } from '../color/ColorPipelineShader';
import { recordTimingWait, startTimingWait } from '../TimingTrace';
import {
    DolbyVisionPresentationAuthorizationRegistry,
    type DolbyVisionAuthorizationRoute
} from '../validation/DolbyVisionPresentationAuthorization';
import { ExternalDolbyVisionPresentationAuthorizationRegistry } from '../validation/ExternalDolbyVisionPresentationAuthorization';
import {
    ExternalHDRPresentationAuthorizationRegistry,
    getExternalHDRAuthorizationRouteKey
} from '../validation/ExternalHDRPresentationAuthorization';
import { discardErrorScope } from '../validation/GPUErrorScope';
import {
    getRawHDRAuthorizationRouteKey,
    RawHDRPresentationAuthorizationRegistry
} from '../validation/RawHDRPresentationAuthorization';
import { isDolbyVisionDualLayerProfile } from '../video/dolby-vision/DolbyVisionProfiles';
import { DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH } from '../video/dolby-vision/DolbyVisionRPUParser';
import type { SupportedRawVideoFrameFormat } from '../video/RawVideoFrameCopy';
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
    rawDolbyVisionEnhancementFrameRouteMatches,
    rawDolbyVisionFrameRouteMatches,
    rawFrameRouteMatches,
    type DualLayerDolbyVisionRPUData
} from './DecodedFramePresentation';
import { createExternalTextureRenderPipeline, drawExternalTextureFrame } from './ExternalTextureGPURenderer';
import type { DolbyVisionReconstructionProfile } from './PresentationInput';
import {
    createRawYUVEnhancementUniformBuffer,
    createRawYUVRenderPipeline,
    createRawYUVRenderSettingsUniformBuffer,
    drawRawYUVFrame,
    writeRawYUVRenderSettingsUniform
} from './RawYUVGPURenderer';
import type { HDR10PlusFrameRenderSettings, HDRToSDRRenderSettings, RenderSettings } from './RenderSettings';
import {
    requestPresentationDevice,
    waitForWebGPUResourceOperation,
    WEBGPU_RESOURCE_OPERATION_TIMEOUT
} from './WebGPUResourceOperation';
import WorkerFrameStore, {
    type KeptWorkerFrame,
    type KeptWorkerRawFrame,
    type KeptWorkerVideoFrame
} from './WorkerFrameStore';
import {
    isWorkerPresentationRequest,
    type PresentationFallbackReason,
    type WorkerPresentationConfigureRequest,
    type WorkerPresentationDolbyVisionDualLayerMode,
    type WorkerPresentationHDR10PlusResult,
    type WorkerPresentationInputMode,
    type WorkerPresentationLayout,
    type WorkerPresentationLayoutRequest,
    type WorkerPresentationPresentRequest,
    type WorkerPresentationResponse,
    type WorkerPresentationSettingsRequest,
    type WorkerPresentationStatusResponse
} from './WorkerPresentationProtocol';

const FLOATS_PER_PRESENTATION_UNIFORM = 4;
// A native Profile 5 decode outputs its 10-bit BL as an opaque frame
const EXTERNAL_DOLBY_VISION_BASE_LAYER_BIT_DEPTH = 10;
// One recovery for the worker's life, as the page presenter allows one for each session
const MAXIMUM_DEVICE_RECOVERY_ATTEMPT_COUNT = 1;
// What a worker that already renders answers a further attachment, whose canvas it cannot take
const DECLINED_ATTACHMENT_REASON: PresentationFallbackReason = 'canvas-context-unavailable';

export type WorkerPresentationRendererOptions = {
    /** The canvas the page transferred, whose backing store the renderer sizes */
    canvas: OffscreenCanvas
    frameStore: WorkerFrameStore
    /** The renderer's end of the page presenter's channel */
    port: MessagePort
};

/** The pipeline a configure installed, with the route it presents. */
type ActiveConfiguration = {
    automaticInputPeakNits: boolean
    dolbyVisionFELReconstruction: boolean
    dolbyVisionProfile: DolbyVisionReconstructionProfile | null
    inputColorMetadata: InputColorMetadata | null
    inputMode: WorkerPresentationInputMode
    pipeline: GPURenderPipeline
    rawFrameFormat: SupportedRawVideoFrameFormat | null
    /** The configure it came from, which a later configure of the same object skips */
    request: WorkerPresentationConfigureRequest
    revision: number
    settings: RenderSettings
};

type ConfigurationOutcome =
    | { kind: 'installed' }
    | { kind: 'refused', reason: PresentationFallbackReason }
    // The device was lost, or the renderer detached, while the configuration was being built
    | { kind: 'superseded' };

/** A submitted draw, until its validation and GPU work end. */
type FrameDraw = {
    configuration: ActiveConfiguration
    device: GPUDevice
    dolbyVisionDualLayerMode: WorkerPresentationDolbyVisionDualLayerMode | null
    /** The first submission of a pipeline validates in an error scope */
    validationResult: Promise<GPUError | null> | null
};

type FrameSubmission = FrameDraw & {
    HDR10PlusResult: WorkerPresentationHDR10PlusResult | null
};

/** The authorization registries one raw Dolby Vision route renders through. */
type RawDolbyVisionAuthorizations = {
    base: DolbyVisionPresentationAuthorizationRegistry
    fel: DolbyVisionPresentationAuthorizationRegistry | null
};

/** Returns the worker's WebGPU entry point, which a worker without WebGPU lacks. */
function getWorkerGPU(): GPU | null {
    const workerNavigator = (globalThis as { navigator?: Partial<NavigatorGPU> }).navigator;
    return workerNavigator?.gpu ?? null;
}

/** Returns the transferred canvas's WebGPU context, which a browser without WebGPU in OffscreenCanvas refuses. */
function getCanvasContext(canvas: OffscreenCanvas): GPUCanvasContext | null {
    if (typeof canvas.getContext !== 'function') {
        return null;
    }
    try {
        return canvas.getContext('webgpu');
    } catch (error) {
        console.warn('The transferred canvas has no WebGPU context', error);
        return null;
    }
}

function destroyBuffer(buffer: GPUBuffer | null): void {
    try {
        buffer?.destroy();
    } catch (error) {
        console.warn('Unable to destroy a worker renderer buffer', error);
    }
}

function closeVideoFrame(frame: VideoFrame): void {
    try {
        frame.close();
    } catch (error) {
        console.warn('Unable to close a presented VideoFrame', error);
    }
}

/**
 * Declines an attachment that a worker which already renders cannot take, so the page removes its canvas.
 * A worker takes one attachment for its life.
 */
export function declineWorkerPresentationAttachment(port: MessagePort): void {
    const statusResponse: WorkerPresentationStatusResponse = {
        reason: DECLINED_ATTACHMENT_REASON,
        state: 'unavailable',
        type: 'status'
    };
    try {
        port.postMessage(statusResponse);
    } catch (error) {
        console.warn('Unable to decline a worker presentation attachment', error);
    }
    port.close();
}

/**
 * Draws a decode worker's kept frames into the canvas its page transferred, with a device of its own, for the worker's life.
 * It reports `status` once its device and canvas context exist, installs a configure only after authorizing its route on that device, and answers each present once the frame's GPU work completed or failed.
 * A lost device is recovered once; frames uploaded to it are lost.
 */
export default class WorkerPresentationRenderer {
    private readonly canvas: OffscreenCanvas;
    private readonly frameStore: WorkerFrameStore;
    private readonly port: MessagePort;
    private readonly presentationUniformValues = new Float32Array(FLOATS_PER_PRESENTATION_UNIFORM);
    private readonly externalDolbyVisionAuthorization = new ExternalDolbyVisionPresentationAuthorizationRegistry();
    private readonly externalHDRAuthorization = new ExternalHDRPresentationAuthorizationRegistry();
    private readonly rawDolbyVisionAuthorizations = new Map<string, DolbyVisionPresentationAuthorizationRegistry>();
    private readonly rawHDRAuthorization = new RawHDRPresentationAuthorizationRegistry();

    private canvasContext: GPUCanvasContext | null = null;
    private canvasFormat: GPUTextureFormat | null = null;
    private configuration: ActiveConfiguration | null = null;
    private detached = false;
    private device: GPUDevice | null = null;
    private deviceRecoveryAttemptCount = 0;
    private dolbyVisionEnhancementUniformBuffer: GPUBuffer | null = null;
    private dolbyVisionRPUStorageBuffer: GPUBuffer | null = null;
    private dynamicHDR10PlusSettingsActive = false;
    private failed = false;
    /** The newest configure received, which a configure in progress or a device recovery installs */
    private latestConfigureRequest: WorkerPresentationConfigureRequest | null = null;
    private layout: WorkerPresentationLayout | null = null;
    /** Serializes configures and the device recovery, which each wait for GPU work */
    private operationQueue: Promise<void> = Promise.resolve();
    /** Live settings sent for a configure that is still being installed */
    private pendingSettingsRequest: WorkerPresentationSettingsRequest | null = null;
    private presentationUniformBuffer: GPUBuffer | null = null;
    private renderSettingsUniformBuffer: GPUBuffer | null = null;
    private sampler: GPUSampler | null = null;
    private submissionValidated = false;

    public constructor(options: WorkerPresentationRendererOptions) {
        this.canvas = options.canvas;
        this.frameStore = options.frameStore;
        this.port = options.port;
    }

    /**
     * Takes the canvas's WebGPU context and a device, answers `status` on the port, and then serves the port's requests.
     * Returns why the renderer is unavailable, or null once it is ready; an unavailable renderer releases its port.
     */
    public async start(): Promise<PresentationFallbackReason | null> {
        const unavailableReason = await this.acquireDevice();
        if (unavailableReason !== null) {
            this.postResponse({ reason: unavailableReason, state: 'unavailable', type: 'status' });
            this.detach();
            return unavailableReason;
        }
        this.postResponse({ reason: null, state: 'ready', type: 'status' });
        // The port holds the requests sent meanwhile, the first configure among them, until the handler is set
        this.port.onmessage = (event: MessageEvent<unknown>): void => {
            this.handleMessage(event.data);
        };
        return null;
    }

    /** Takes the canvas context if needed, requests a device, and configures the context with it; returns why it could not. */
    private async acquireDevice(): Promise<PresentationFallbackReason | null> {
        if (globalThis.isSecureContext === false) {
            return 'insecure-context';
        }
        const gpu = getWorkerGPU();
        if (!gpu) {
            return 'gpu-unavailable';
        }
        const canvasContext = this.canvasContext ?? getCanvasContext(this.canvas);
        if (!canvasContext) {
            return 'canvas-context-unavailable';
        }
        this.canvasContext = canvasContext;

        const deviceRequest = await requestPresentationDevice(gpu);
        if (deviceRequest.failureReason !== null) {
            return deviceRequest.failureReason;
        }
        const device = deviceRequest.device;
        if (this.detached) {
            device.destroy();
            return 'device-request-failed';
        }

        let canvasFormat: GPUTextureFormat;
        try {
            canvasFormat = gpu.getPreferredCanvasFormat();
            canvasContext.configure({
                alphaMode: 'opaque',
                colorSpace: 'srgb',
                device,
                format: canvasFormat
            });
        } catch (error) {
            console.warn('The worker renderer could not configure its canvas', error);
            device.destroy();
            return 'canvas-configuration-failed';
        }
        try {
            this.presentationUniformBuffer = device.createBuffer({
                label: 'WebGPU video presentation uniforms',
                size: this.presentationUniformValues.byteLength,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM
            });
            this.sampler = device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear'
            });
        } catch (error) {
            console.warn('The worker renderer could not create its presentation resources', error);
            this.presentationUniformBuffer = null;
            this.sampler = null;
            device.destroy();
            return 'pipeline-creation-failed';
        }

        this.canvasFormat = canvasFormat;
        this.device = device;
        device.addEventListener('uncapturederror', (event: GPUUncapturedErrorEvent): void => {
            this.handleUncapturedError(device, event);
        });
        void device.lost.then((lostInfo: GPUDeviceLostInfo): void => {
            this.handleDeviceLoss(device, lostInfo);
        });
        this.frameStore.setDevice(device);
        return null;
    }

    private handleMessage(value: unknown): void {
        if (this.detached) {
            return;
        }
        if (!isWorkerPresentationRequest(value)) {
            console.warn('The worker presentation renderer received an invalid request');
            this.fail('frame-render-failed');
            return;
        }
        switch (value.type) {
            case 'configure':
                this.latestConfigureRequest = value;
                this.enqueueOperation((): Promise<void> => this.configure(value));
                return;
            case 'settings':
                this.handleSettings(value);
                return;
            case 'layout':
                this.applyLayout(value);
                return;
            case 'present':
                this.present(value);
                return;
            case 'detach':
                this.detach();
                return;
        }
    }

    /** Runs one configure or recovery after the ones before it; one that throws fails the renderer. */
    private enqueueOperation(operation: () => Promise<void>): void {
        const runOperation = (): Promise<void> => (this.detached ? Promise.resolve() : operation());
        this.operationQueue = this.operationQueue.then(runOperation).catch((error: unknown): void => {
            console.warn('A worker presentation renderer operation failed', error);
            this.fail('pipeline-creation-failed');
        });
    }

    private async configure(request: WorkerPresentationConfigureRequest): Promise<void> {
        // A newer configure replaces this one, and the page waits only for the newest; a recovery may have installed it already
        if (
            this.latestConfigureRequest !== request
            || this.configuration?.request === request
            || this.failed
            || !this.device
        ) {
            return;
        }
        const outcome = await this.installConfiguration(request);
        switch (outcome.kind) {
            case 'installed':
                this.postResponse({ ok: true, reason: null, revision: request.revision, type: 'configured' });
                return;
            case 'refused':
                this.postResponse({ ok: false, reason: outcome.reason, revision: request.revision, type: 'configured' });
                return;
            case 'superseded':
                // The recovery the device loss queued installs the newest configure and answers it
                return;
        }
    }

    /** Builds a configure's pipeline and buffers on the current device and authorizes its route there before installing it. */
    private async installConfiguration(request: WorkerPresentationConfigureRequest): Promise<ConfigurationOutcome> {
        const device = this.device;
        const canvasFormat = this.canvasFormat;
        if (!device || !canvasFormat) {
            return { kind: 'superseded' };
        }

        const [ pipeline, authorized ] = await Promise.all([
            this.createPipeline(device, canvasFormat, request),
            this.authorizeRoute(device, canvasFormat, request)
        ]);
        if (!this.isDeviceCurrent(device)) {
            return { kind: 'superseded' };
        }
        if (!authorized) {
            return { kind: 'refused', reason: 'hdr-authorization-unavailable' };
        }
        if (!pipeline || !this.prepareRouteBuffers(device, request)) {
            return { kind: 'refused', reason: 'pipeline-creation-failed' };
        }

        const configuration: ActiveConfiguration = {
            automaticInputPeakNits: request.automaticInputPeakNits,
            dolbyVisionFELReconstruction: request.dolbyVisionFELReconstruction,
            dolbyVisionProfile: request.dolbyVisionProfile,
            inputColorMetadata: request.inputColorMetadata,
            inputMode: request.inputMode,
            pipeline,
            rawFrameFormat: request.rawFrameFormat,
            request,
            revision: request.revision,
            settings: request.settings
        };
        this.configuration = configuration;
        this.dynamicHDR10PlusSettingsActive = false;
        this.submissionValidated = false;
        const settingsRequest = this.pendingSettingsRequest;
        if (settingsRequest && settingsRequest.revision <= configuration.revision) {
            this.pendingSettingsRequest = null;
            if (settingsRequest.revision === configuration.revision) {
                this.applySettings(configuration, settingsRequest);
            }
        }
        return { kind: 'installed' };
    }

    /** Creates a configure's pipeline as the page presenter does; returns null when it fails or times out. */
    private async createPipeline(
        device: GPUDevice,
        canvasFormat: GPUTextureFormat,
        request: WorkerPresentationConfigureRequest
    ): Promise<GPURenderPipeline | null> {
        try {
            const pipelineResult = await waitForWebGPUResourceOperation(isExternalInputMode(request.inputMode) ?
                createExternalTextureRenderPipeline(device, canvasFormat, request.shaderCode) :
                createRawYUVRenderPipeline(device, canvasFormat, request.shaderCode));
            if (pipelineResult === WEBGPU_RESOURCE_OPERATION_TIMEOUT) {
                console.warn('The worker renderer timed out creating its pipeline');
                return null;
            }
            return pipelineResult;
        } catch (error) {
            console.warn('The worker renderer could not create its pipeline', error);
            return null;
        }
    }

    /** Authorizes a configure's route on this device with the probes the page presenter ran on its own. */
    private async authorizeRoute(
        device: GPUDevice,
        canvasFormat: GPUTextureFormat,
        request: WorkerPresentationConfigureRequest
    ): Promise<boolean> {
        const settings = request.settings;
        switch (request.inputMode) {
            case 'external-texture':
                return true;
            case 'external-hdr': {
                const metadata = request.inputColorMetadata;
                const routeKey = metadata ? getExternalHDRAuthorizationRouteKey(metadata) : null;
                if (!metadata || !routeKey || settings.mode !== 'hdr-to-sdr') {
                    return false;
                }
                const decision = await this.externalHDRAuthorization.authorize(device, canvasFormat, routeKey);
                return decision.status === 'authorized'
                    && this.externalHDRAuthorization.isAuthorized(device, canvasFormat, metadata, settings);
            }
            case 'external-dolby-vision': {
                if (settings.mode !== 'hdr-to-sdr') {
                    return false;
                }
                const decision = await this.externalDolbyVisionAuthorization.authorize(device, canvasFormat);
                return decision.status === 'authorized'
                    && this.externalDolbyVisionAuthorization.isAuthorized(device, canvasFormat, settings);
            }
            case 'raw-yuv': {
                const metadata = request.inputColorMetadata;
                const format = request.rawFrameFormat;
                const routeKey = metadata && format ? getRawHDRAuthorizationRouteKey(format, metadata) : null;
                if (!metadata || !format || !routeKey) {
                    return false;
                }
                const decision = await this.rawHDRAuthorization.authorize(device, canvasFormat, routeKey);
                return decision.status === 'authorized'
                    && this.rawHDRAuthorization.isAuthorized(device, canvasFormat, metadata, settings, format);
            }
            case 'raw-dolby-vision':
                return this.authorizeRawDolbyVisionRoute(device, canvasFormat, request);
        }
    }

    /** Authorizes a raw Dolby Vision route's base, and its FEL residual when the configure reconstructs it. */
    private async authorizeRawDolbyVisionRoute(
        device: GPUDevice,
        canvasFormat: GPUTextureFormat,
        request: WorkerPresentationConfigureRequest
    ): Promise<boolean> {
        const settings = request.settings;
        const format = request.rawFrameFormat;
        const profile = request.dolbyVisionProfile;
        if (!format || !isRawDolbyVisionVideoFrameFormat(format) || profile === null || settings.mode !== 'hdr-to-sdr') {
            return false;
        }
        const authorizations = this.getRawDolbyVisionAuthorizations(profile, format);
        const baseDecision = await authorizations.base.authorize(device, canvasFormat);
        if (
            baseDecision.status !== 'authorized'
            || !authorizations.base.isAuthorized(device, canvasFormat, settings, format)
        ) {
            return false;
        }
        if (!request.dolbyVisionFELReconstruction) {
            return true;
        }
        const felAuthorization = authorizations.fel;
        if (!felAuthorization) {
            return false;
        }
        const felDecision = await felAuthorization.authorize(device, canvasFormat);
        return felDecision.status === 'authorized'
            && felAuthorization.isAuthorized(device, canvasFormat, settings, format);
    }

    private getRawDolbyVisionAuthorization(
        route: DolbyVisionAuthorizationRoute,
        format: RawDolbyVisionVideoFrameFormat
    ): DolbyVisionPresentationAuthorizationRegistry {
        const authorizationKey = `${format}:${route}`;
        const cachedAuthorization = this.rawDolbyVisionAuthorizations.get(authorizationKey);
        if (cachedAuthorization) {
            return cachedAuthorization;
        }
        const authorization = new DolbyVisionPresentationAuthorizationRegistry(route, format);
        this.rawDolbyVisionAuthorizations.set(authorizationKey, authorization);
        return authorization;
    }

    /** Returns the registries of a profile's routes, as the page presenter selects them. */
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

    /** Writes the static render settings and creates the Dolby Vision buffers a route binds; returns false when that fails. */
    private prepareRouteBuffers(device: GPUDevice, request: WorkerPresentationConfigureRequest): boolean {
        try {
            if (request.settings.mode === 'hdr-to-sdr') {
                const renderSettingsUniformBuffer = this.renderSettingsUniformBuffer
                    ?? createRawYUVRenderSettingsUniformBuffer(device);
                this.renderSettingsUniformBuffer = renderSettingsUniformBuffer;
                writeRawYUVRenderSettingsUniform(device, renderSettingsUniformBuffer, request.settings);
            }
            if (isDolbyVisionInputMode(request.inputMode)) {
                this.dolbyVisionRPUStorageBuffer ??= device.createBuffer({
                    label: 'WebGPU Dolby Vision per-frame RPU',
                    size: DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH,
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
                });
            } else {
                destroyBuffer(this.dolbyVisionRPUStorageBuffer);
                this.dolbyVisionRPUStorageBuffer = null;
            }
            if (request.dolbyVisionFELReconstruction) {
                this.dolbyVisionEnhancementUniformBuffer ??= createRawYUVEnhancementUniformBuffer(device);
            } else {
                destroyBuffer(this.dolbyVisionEnhancementUniformBuffer);
                this.dolbyVisionEnhancementUniformBuffer = null;
            }
            return true;
        } catch (error) {
            console.warn('The worker renderer could not create its route buffers', error);
            return false;
        }
    }

    /** Applies live HDR-to-SDR controls to the configure they were sent for, or keeps them for a configure still being installed. */
    private handleSettings(request: WorkerPresentationSettingsRequest): void {
        const configuration = this.configuration;
        if (configuration?.revision === request.revision) {
            this.applySettings(configuration, request);
            return;
        }
        if (request.revision > (configuration?.revision ?? 0)) {
            this.pendingSettingsRequest = request;
        }
    }

    private applySettings(configuration: ActiveConfiguration, request: WorkerPresentationSettingsRequest): void {
        const device = this.device;
        if (!device || configuration.settings.mode !== 'hdr-to-sdr') {
            return;
        }
        try {
            const renderSettingsUniformBuffer = this.renderSettingsUniformBuffer
                ?? createRawYUVRenderSettingsUniformBuffer(device);
            this.renderSettingsUniformBuffer = renderSettingsUniformBuffer;
            writeRawYUVRenderSettingsUniform(device, renderSettingsUniformBuffer, request.settings);
        } catch (error) {
            console.warn('The worker renderer could not update its render settings', error);
            return;
        }
        configuration.settings = request.settings;
        configuration.automaticInputPeakNits = request.automaticInputPeakNits;
        this.dynamicHDR10PlusSettingsActive = false;
    }

    /** Keeps the newest layout and sizes the canvas backing store to it, since the page sizes only the canvas element. */
    private applyLayout(request: WorkerPresentationLayoutRequest): void {
        if (this.layout && request.revision <= this.layout.revision) {
            return;
        }
        this.layout = {
            backingHeight: request.backingHeight,
            backingWidth: request.backingWidth,
            presentation: request.presentation,
            revision: request.revision
        };
        if (this.canvas.width !== request.backingWidth) {
            this.canvas.width = request.backingWidth;
        }
        if (this.canvas.height !== request.backingHeight) {
            this.canvas.height = request.backingHeight;
        }
    }

    /**
     * Draws a kept frame the page selected, with the checks the page presenter applies to a frame it draws itself.
     * A frame the renderer cannot draw now, such as one already released or uploaded to a lost device, answers not presented; a frame that breaks its route fails the renderer.
     */
    private present(request: WorkerPresentationPresentRequest): void {
        const keptFrame = this.frameStore.getFrame(request.generation, request.frameId);
        const configuration = this.configuration;
        const device = this.device;
        const layout = this.layout;
        if (
            this.failed
            || !keptFrame
            || !configuration
            || !device
            || !layout
            || layout.revision !== request.layoutRevision
        ) {
            this.postNotPresented(request);
            return;
        }

        let submission: FrameSubmission | null = null;
        try {
            submission = this.submitFrame(keptFrame, configuration, device, layout);
        } catch (error) {
            console.warn('The worker renderer could not present a frame', error);
            this.fail('frame-import-failed');
        }
        if (!submission) {
            this.postNotPresented(request);
            return;
        }
        void this.completePresentation(request, submission);
    }

    /** Applies a frame's HDR10+ tone mapping and draws it; returns null when it did not draw. */
    private submitFrame(
        keptFrame: KeptWorkerFrame,
        configuration: ActiveConfiguration,
        device: GPUDevice,
        layout: WorkerPresentationLayout
    ): FrameSubmission | null {
        let HDR10PlusResult: WorkerPresentationHDR10PlusResult | null = null;
        if (configuration.settings.mode === 'hdr-to-sdr') {
            const dynamicFrameSettings = getHDR10PlusFrameRenderSettings(
                keptFrame.HDR10PlusMetadata,
                configuration.inputMode,
                configuration.inputColorMetadata,
                configuration.settings,
                configuration.automaticInputPeakNits
            );
            if (!this.writeFrameRenderSettings(device, configuration.settings, dynamicFrameSettings)) {
                this.fail('frame-render-failed');
                return null;
            }
            HDR10PlusResult = {
                inputPeakNits: dynamicFrameSettings?.inputPeakNits ?? null,
                metadataStatus: keptFrame.HDR10PlusMetadata?.status ?? 'absent'
            };
        }

        let frameDraw: FrameDraw | null;
        switch (keptFrame.outputMode) {
            case 'video-frame':
                frameDraw = this.drawVideoFrame(keptFrame, configuration, device, layout);
                break;
            case 'raw-planes':
                frameDraw = this.drawRawFrame(keptFrame, configuration, device, layout);
                break;
        }
        return frameDraw ? { ...frameDraw, HDR10PlusResult } : null;
    }

    /** Writes a frame's dynamic HDR10+ settings, or the static ones again after a dynamic frame; returns false when the uniform cannot be written. */
    private writeFrameRenderSettings(
        device: GPUDevice,
        settings: HDRToSDRRenderSettings,
        dynamicFrameSettings: HDR10PlusFrameRenderSettings | null
    ): boolean {
        if (!dynamicFrameSettings && !this.dynamicHDR10PlusSettingsActive) {
            return true;
        }
        const renderSettingsUniformBuffer = this.renderSettingsUniformBuffer;
        if (!renderSettingsUniformBuffer) {
            return false;
        }
        try {
            writeRawYUVRenderSettingsUniform(device, renderSettingsUniformBuffer, settings, dynamicFrameSettings);
        } catch (error) {
            console.warn('The worker renderer could not write HDR10+ render settings', error);
            return false;
        }
        this.dynamicHDR10PlusSettingsActive = dynamicFrameSettings !== null;
        return true;
    }

    /** Draws a kept VideoFrame once and closes it, whether or not it drew. */
    private drawVideoFrame(
        keptFrame: KeptWorkerVideoFrame,
        configuration: ActiveConfiguration,
        device: GPUDevice,
        layout: WorkerPresentationLayout
    ): FrameDraw | null {
        const frame = this.frameStore.takeVideoFrame(keptFrame);
        if (!frame) {
            // Presented already
            return null;
        }
        try {
            const refusalReason = this.prepareVideoFrame(keptFrame, frame, configuration, device);
            if (refusalReason) {
                return this.refuseFrame(refusalReason);
            }
            return this.drawExternalTexture(frame, configuration, device, layout);
        } finally {
            // As on the page, the frame closes after its submission, and its credit returns once the GPU work completes
            closeVideoFrame(frame);
        }
    }

    /**
     * Checks a VideoFrame against the route, and writes its RPU on an external Dolby Vision route.
     * Returns why the frame breaks the route, or null when it draws.
     */
    private prepareVideoFrame(
        keptFrame: KeptWorkerVideoFrame,
        frame: VideoFrame,
        configuration: ActiveConfiguration,
        device: GPUDevice
    ): PresentationFallbackReason | null {
        switch (configuration.inputMode) {
            case 'external-texture':
                return configuration.inputColorMetadata
                    && !decodedFrameColorMatches(frame, configuration.inputColorMetadata) ?
                    'decoded-frame-color-mismatch' :
                    null;
            case 'external-dolby-vision': {
                const storageBuffer = this.dolbyVisionRPUStorageBuffer;
                if (
                    configuration.dolbyVisionProfile !== 5
                    || !storageBuffer
                    || !decodedNeutralBT709FrameColorMatches(frame)
                    || !this.isExternalDolbyVisionAuthorized(configuration)
                ) {
                    return 'decoded-frame-color-mismatch';
                }
                const packedRPUData = getSingleLayerDolbyVisionRPUData(
                    keptFrame.encodedDolbyVisionMetadata,
                    EXTERNAL_DOLBY_VISION_BASE_LAYER_BIT_DEPTH
                );
                if (!packedRPUData) {
                    return 'dolby-vision-metadata-invalid';
                }
                device.queue.writeBuffer(storageBuffer, 0, packedRPUData);
                return null;
            }
            case 'external-hdr': {
                const metadata = configuration.inputColorMetadata;
                return !metadata
                    || !decodedNeutralBT709FrameColorMatches(frame)
                    || !this.isExternalHDRAuthorized(configuration, metadata) ?
                    'decoded-frame-color-mismatch' :
                    null;
            }
            case 'raw-dolby-vision':
            case 'raw-yuv':
                return 'decoded-frame-color-mismatch';
        }
    }

    private drawExternalTexture(
        frame: VideoFrame,
        configuration: ActiveConfiguration,
        device: GPUDevice,
        layout: WorkerPresentationLayout
    ): FrameDraw {
        const canvasContext = this.canvasContext;
        const sampler = this.sampler;
        const presentationUniformBuffer = this.presentationUniformBuffer;
        const renderSettingsUniformBuffer = configuration.settings.mode === 'hdr-to-sdr' ?
            this.renderSettingsUniformBuffer :
            null;
        const dolbyVisionRPUStorageBuffer = configuration.inputMode === 'external-dolby-vision' ?
            this.dolbyVisionRPUStorageBuffer :
            null;
        if (
            !canvasContext
            || !sampler
            || !presentationUniformBuffer
            || (configuration.settings.mode === 'hdr-to-sdr' && !renderSettingsUniformBuffer)
            || (configuration.inputMode === 'external-dolby-vision' && !dolbyVisionRPUStorageBuffer)
        ) {
            throw new Error('The worker renderer resources are incomplete');
        }

        const validateSubmission = !this.submissionValidated;
        if (validateSubmission) {
            device.pushErrorScope('validation');
        }
        try {
            drawExternalTextureFrame({
                device,
                dolbyVisionRPUStorageBuffer,
                pipeline: configuration.pipeline,
                presentation: layout.presentation,
                presentationUniformBuffer,
                presentationUniformValues: this.presentationUniformValues,
                renderSettingsUniformBuffer,
                sampler,
                source: frame,
                targetView: canvasContext.getCurrentTexture().createView()
            });
        } catch (error) {
            if (validateSubmission) {
                discardErrorScope(device);
            }
            throw error;
        }
        return {
            configuration,
            device,
            dolbyVisionDualLayerMode: null,
            validationResult: validateSubmission ? device.popErrorScope() : null
        };
    }

    private drawRawFrame(
        keptFrame: KeptWorkerRawFrame,
        configuration: ActiveConfiguration,
        device: GPUDevice,
        layout: WorkerPresentationLayout
    ): FrameDraw | null {
        const format = configuration.rawFrameFormat;
        if (!format) {
            return this.refuseFrame('decoded-frame-color-mismatch');
        }
        switch (configuration.inputMode) {
            case 'raw-yuv':
                return this.drawRawYUVFrame(keptFrame, configuration, device, layout, format);
            case 'raw-dolby-vision':
                return this.drawRawDolbyVisionFrame(keptFrame, configuration, device, layout, format);
            case 'external-dolby-vision':
            case 'external-hdr':
            case 'external-texture':
                return this.refuseFrame('decoded-frame-color-mismatch');
        }
    }

    private drawRawYUVFrame(
        keptFrame: KeptWorkerRawFrame,
        configuration: ActiveConfiguration,
        device: GPUDevice,
        layout: WorkerPresentationLayout,
        format: SupportedRawVideoFrameFormat
    ): FrameDraw | null {
        const metadata = configuration.inputColorMetadata;
        if (
            !metadata
            || !this.isRawHDRAuthorized(configuration, metadata, format)
            || !rawFrameRouteMatches(keptFrame, metadata, format)
        ) {
            return this.refuseFrame('decoded-frame-color-mismatch');
        }
        return this.drawUploadedRawFrame(keptFrame, configuration, device, layout, false, null);
    }

    private drawRawDolbyVisionFrame(
        keptFrame: KeptWorkerRawFrame,
        configuration: ActiveConfiguration,
        device: GPUDevice,
        layout: WorkerPresentationLayout,
        format: SupportedRawVideoFrameFormat
    ): FrameDraw | null {
        const profile = configuration.dolbyVisionProfile;
        const storageBuffer = this.dolbyVisionRPUStorageBuffer;
        if (
            profile === null
            || !storageBuffer
            || !this.isRawDolbyVisionAuthorized(configuration, format, profile)
            || !rawDolbyVisionFrameRouteMatches(keptFrame, format)
            || !rawDolbyVisionEnhancementFrameRouteMatches(keptFrame)
            || (!isDolbyVisionDualLayerProfile(profile) && keptFrame.enhancementFrame !== undefined)
        ) {
            return this.refuseFrame('decoded-frame-color-mismatch');
        }

        let packedRPUData: ArrayBuffer | null = null;
        let dualLayerRPUData: DualLayerDolbyVisionRPUData | null = null;
        switch (profile) {
            case 5:
            case 8:
                packedRPUData = getSingleLayerDolbyVisionRPUData(
                    keptFrame.encodedDolbyVisionMetadata,
                    keptFrame.frame.bitDepth
                );
                break;
            case 4:
            case 7:
                dualLayerRPUData = getDualLayerDolbyVisionRPUData(
                    keptFrame.encodedDolbyVisionMetadata,
                    profile,
                    keptFrame.frame.bitDepth,
                    Boolean(keptFrame.enhancementFrame)
                );
                packedRPUData = dualLayerRPUData?.packedRPUData ?? null;
                break;
        }
        if (!packedRPUData) {
            return this.refuseFrame('dolby-vision-metadata-invalid');
        }

        device.queue.writeBuffer(storageBuffer, 0, packedRPUData);
        const composedEnhancementFrame = getComposedEnhancementFrame(
            dualLayerRPUData,
            configuration.dolbyVisionFELReconstruction,
            keptFrame.enhancementFrame
        );
        return this.drawUploadedRawFrame(
            keptFrame,
            configuration,
            device,
            layout,
            composedEnhancementFrame !== null,
            dualLayerRPUData ? getDualLayerPresentation(dualLayerRPUData, composedEnhancementFrame) : null
        );
    }

    /** Draws a raw frame from the textures its planes were uploaded into when it was kept. */
    private drawUploadedRawFrame(
        keptFrame: KeptWorkerRawFrame,
        configuration: ActiveConfiguration,
        device: GPUDevice,
        layout: WorkerPresentationLayout,
        composesEnhancementLayer: boolean,
        dolbyVisionDualLayerMode: WorkerPresentationDolbyVisionDualLayerMode | null
    ): FrameDraw | null {
        switch (keptFrame.uploadState) {
            case 'uploaded':
                break;
            case 'invalid-layout':
                return this.refuseFrame('decoded-frame-color-mismatch');
            case 'upload-failed':
                return this.refuseFrame('frame-import-failed');
            case 'lost':
                // Its planes went with a lost device, or were kept while there was none
                return null;
        }
        const textureSlot = keptFrame.textureSlot;
        const textureSet = textureSlot?.textureSet ?? null;
        if (!textureSlot || !textureSet || textureSet.device !== device) {
            return null;
        }
        const enhancementTextureSet = composesEnhancementLayer ? textureSlot.enhancementTextureSet : null;
        const canvasContext = this.canvasContext;
        const presentationUniformBuffer = this.presentationUniformBuffer;
        const renderSettingsUniformBuffer = configuration.settings.mode === 'hdr-to-sdr' ?
            this.renderSettingsUniformBuffer :
            null;
        if (
            (composesEnhancementLayer && !enhancementTextureSet)
            || !canvasContext
            || !presentationUniformBuffer
            || (configuration.settings.mode === 'hdr-to-sdr' && !renderSettingsUniformBuffer)
        ) {
            throw new Error('The worker renderer raw presentation resources are incomplete');
        }

        const validateSubmission = !this.submissionValidated;
        if (validateSubmission) {
            device.pushErrorScope('validation');
        }
        try {
            drawRawYUVFrame({
                device,
                dolbyVisionEnhancementUniformBuffer: configuration.dolbyVisionFELReconstruction ?
                    this.dolbyVisionEnhancementUniformBuffer ?? undefined :
                    undefined,
                dolbyVisionRPUStorageBuffer: configuration.inputMode === 'raw-dolby-vision' ?
                    this.dolbyVisionRPUStorageBuffer ?? undefined :
                    undefined,
                enhancementTextureSet,
                frame: keptFrame.frame,
                pipeline: configuration.pipeline,
                presentation: layout.presentation,
                presentationUniformBuffer,
                renderSettingsUniformBuffer,
                targetView: canvasContext.getCurrentTexture().createView(),
                textureSet
            });
        } catch (error) {
            if (validateSubmission) {
                discardErrorScope(device);
            }
            throw error;
        }
        return {
            configuration,
            device,
            dolbyVisionDualLayerMode,
            validationResult: validateSubmission ? device.popErrorScope() : null
        };
    }

    private isRawHDRAuthorized(
        configuration: ActiveConfiguration,
        metadata: InputColorMetadata,
        format: SupportedRawVideoFrameFormat
    ): boolean {
        const device = this.device;
        const canvasFormat = this.canvasFormat;
        return device !== null
            && canvasFormat !== null
            && this.rawHDRAuthorization.isAuthorized(device, canvasFormat, metadata, configuration.settings, format);
    }

    private isExternalHDRAuthorized(configuration: ActiveConfiguration, metadata: InputColorMetadata): boolean {
        const device = this.device;
        const canvasFormat = this.canvasFormat;
        return configuration.settings.mode === 'hdr-to-sdr'
            && device !== null
            && canvasFormat !== null
            && this.externalHDRAuthorization.isAuthorized(device, canvasFormat, metadata, configuration.settings);
    }

    private isExternalDolbyVisionAuthorized(configuration: ActiveConfiguration): boolean {
        const device = this.device;
        const canvasFormat = this.canvasFormat;
        return configuration.settings.mode === 'hdr-to-sdr'
            && device !== null
            && canvasFormat !== null
            && this.externalDolbyVisionAuthorization.isAuthorized(device, canvasFormat, configuration.settings);
    }

    private isRawDolbyVisionAuthorized(
        configuration: ActiveConfiguration,
        format: SupportedRawVideoFrameFormat,
        profile: DolbyVisionReconstructionProfile
    ): boolean {
        const device = this.device;
        const canvasFormat = this.canvasFormat;
        return isRawDolbyVisionVideoFrameFormat(format)
            && configuration.settings.mode === 'hdr-to-sdr'
            && device !== null
            && canvasFormat !== null
            && this.getRawDolbyVisionAuthorizations(profile, format).base.isAuthorized(
                device,
                canvasFormat,
                configuration.settings,
                format
            );
    }

    /** Waits for a submitted frame's validation and GPU work, records the GPU wait, and answers the present. */
    private async completePresentation(
        request: WorkerPresentationPresentRequest,
        submission: FrameSubmission
    ): Promise<void> {
        const submittedAtEpochMilliseconds = startTimingWait();
        const gpuWorkDone = submission.device.queue.onSubmittedWorkDone().then(
            (): boolean => true,
            (): boolean => false
        );
        const validationResult = submission.validationResult;
        if (validationResult && !await this.resolveSubmissionValidation(submission, validationResult)) {
            this.postNotPresented(request);
            return;
        }
        const gpuWorkCompleted = await gpuWorkDone;
        recordTimingWait('gpu-work-done', submittedAtEpochMilliseconds, { completed: gpuWorkCompleted });
        this.postResponse({
            dolbyVisionDualLayerMode: submission.dolbyVisionDualLayerMode,
            frameId: request.frameId,
            generation: request.generation,
            gpuWorkCompleted,
            HDR10PlusResult: submission.HDR10PlusResult,
            ok: true,
            type: 'presented'
        });
    }

    /** Waits, bounded, for a first submission's validation scope; a failed one fails the renderer. Returns whether the frame presented. */
    private async resolveSubmissionValidation(
        submission: FrameSubmission,
        validationResult: Promise<GPUError | null>
    ): Promise<boolean> {
        let validationError: GPUError | null | typeof WEBGPU_RESOURCE_OPERATION_TIMEOUT;
        try {
            validationError = await waitForWebGPUResourceOperation(validationResult);
        } catch (error) {
            if (this.isDeviceCurrent(submission.device)) {
                console.warn('Unable to resolve the worker renderer validation scope', error);
                this.fail('frame-render-failed');
            }
            return false;
        }
        // A frame drawn on a lost device does not present, and recovery decides what follows
        if (!this.isDeviceCurrent(submission.device)) {
            return false;
        }
        if (validationError === WEBGPU_RESOURCE_OPERATION_TIMEOUT) {
            console.warn('The worker renderer submission validation timed out');
            this.fail('frame-render-failed');
            return false;
        }
        if (validationError) {
            console.warn('The worker renderer submission validation failed', validationError.message);
            this.fail('frame-render-failed');
            return false;
        }
        if (this.configuration === submission.configuration) {
            this.submissionValidated = true;
        }
        return true;
    }

    private postNotPresented(request: WorkerPresentationPresentRequest): void {
        this.postResponse({
            dolbyVisionDualLayerMode: null,
            frameId: request.frameId,
            generation: request.generation,
            gpuWorkCompleted: false,
            HDR10PlusResult: null,
            ok: false,
            type: 'presented'
        });
    }

    /** Fails the renderer for a frame that breaks its route, as the page presenter falls back for one it draws; returns null for the frame. */
    private refuseFrame(reason: PresentationFallbackReason): null {
        this.fail(reason);
        return null;
    }

    private handleUncapturedError(device: GPUDevice, event: GPUUncapturedErrorEvent): void {
        if (!this.isDeviceCurrent(device) || this.failed) {
            return;
        }
        event.preventDefault();
        console.warn('Uncaptured WebGPU error in the worker renderer', event.error.message);
        this.fail('frame-render-failed');
    }

    /** Recovers a lost device once for the worker's life, and fails the renderer after that. */
    private handleDeviceLoss(lostDevice: GPUDevice, lostInfo: GPUDeviceLostInfo): void {
        if (!this.isDeviceCurrent(lostDevice)) {
            return;
        }
        console.warn(`The worker renderer's WebGPU device was lost: ${lostInfo.reason}`, lostInfo.message);
        this.releaseDeviceResources();
        if (this.failed) {
            return;
        }
        if (this.deviceRecoveryAttemptCount >= MAXIMUM_DEVICE_RECOVERY_ATTEMPT_COUNT) {
            this.fail('device-recovery-failed');
            return;
        }
        this.deviceRecoveryAttemptCount += 1;
        this.enqueueOperation((): Promise<void> => this.recoverDevice());
    }

    /** Takes a new device, configures the canvas with it, and installs the newest configure again, which re-authorizes its route. */
    private async recoverDevice(): Promise<void> {
        if (this.failed) {
            return;
        }
        const unavailableReason = await this.acquireDevice();
        if (this.detached) {
            return;
        }
        if (unavailableReason !== null) {
            console.warn(`The worker renderer could not recover its device: ${unavailableReason}`);
            this.fail('device-recovery-failed');
            return;
        }
        const request = this.latestConfigureRequest;
        if (!request) {
            return;
        }
        const outcome = await this.installConfiguration(request);
        switch (outcome.kind) {
            case 'installed':
                // The page may still wait for this configure, which the loss interrupted
                this.postResponse({ ok: true, reason: null, revision: request.revision, type: 'configured' });
                return;
            case 'refused':
                this.fail('device-recovery-failed');
                return;
            case 'superseded':
                return;
        }
    }

    /** Drops every resource of the current device; frames uploaded to it are lost. */
    private releaseDeviceResources(): void {
        this.device = null;
        this.configuration = null;
        this.presentationUniformBuffer = null;
        this.renderSettingsUniformBuffer = null;
        this.dolbyVisionRPUStorageBuffer = null;
        this.dolbyVisionEnhancementUniformBuffer = null;
        this.sampler = null;
        this.dynamicHDR10PlusSettingsActive = false;
        this.submissionValidated = false;
        this.frameStore.setDevice(null);
        try {
            this.canvasContext?.unconfigure();
        } catch (error) {
            console.warn('Unable to unconfigure the worker canvas', error);
        }
    }

    /** Ends the attachment: the kept frames, which nothing can present any more, are freed, the device is destroyed, and the port closed. */
    private detach(): void {
        if (this.detached) {
            return;
        }
        const device = this.device;
        this.releaseDeviceResources();
        this.detached = true;
        this.frameStore.releaseAll();
        this.port.onmessage = null;
        this.port.close();
        device?.destroy();
    }

    /** Reports a failure once; the page falls back as it does for its own and then detaches the renderer. */
    private fail(reason: PresentationFallbackReason): void {
        if (this.failed || this.detached) {
            return;
        }
        this.failed = true;
        console.warn(`The worker presentation renderer failed: ${reason}`);
        this.postResponse({ reason, type: 'failed' });
    }

    private isDeviceCurrent(device: GPUDevice): boolean {
        return !this.detached && this.device === device;
    }

    private postResponse(response: WorkerPresentationResponse): void {
        if (this.detached) {
            return;
        }
        try {
            this.port.postMessage(response);
        } catch (error) {
            console.warn('Unable to reach the page presenter', error);
        }
    }
}
