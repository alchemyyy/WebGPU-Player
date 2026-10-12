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
    createRenderSettingsUniformData,
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
    isDolbyVisionDualLayerProfile,
    type DolbyVisionReconstructionProfile
} from './PresentationInput';
import { decodeDolbyVisionRPUSnapshot } from '../video/dolby-vision/DolbyVisionRPUParser';
import {
    getRawFormatBitDepth,
    isRawDolbyVisionVideoFrameFormat,
    RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT,
    type RawDolbyVisionVideoFrameFormat,
    type RawVideoFrameColorSpace,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from '../video/RawVideoFrameCopy';
import {
    getDolbyVisionEncodedFrameMetadataFailure,
    isTransferableDolbyVisionEncodedFrameMetadata,
    type TransferableDolbyVisionEncodedFrameMetadata
} from '../video/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import {
    getHDR10PlusSceneLuminance,
    isHDR10PlusFrameMetadata,
    type HDR10PlusFrameMetadata
} from '../video/hdr/HDR10PlusMetadata';
import { createBuiltinChain } from './passes/builtin/BuiltinChains';
import type {
    BuiltinChainConfiguration,
    PlanFacts,
    PlannedOutput,
    PlanRequest,
    PresentationFrameSource,
    PresentationPlan
} from './passes/PassTypes';
import { getRawPlaneLayoutFailure } from './passes/PlaneTextureSource';
import {
    configurePresentationCanvas,
    createPlannedOutput,
    PresentationCompileError,
    PresentationExecutor
} from './passes/PresentationExecutor';
import { planPresentation } from './passes/PresentationPlanner';
import {
    calculateTexturePresentationGeometry,
    type TexturePresentationGeometry
} from './PresentationGeometry';
import { VALIDATION_ERROR_FILTER } from './WebGPUConstants';
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

const CANVAS_CLASS = 'webgpuPlayerCanvas';
const CANVAS_VISIBLE_CLASS = 'webgpuPlayerCanvas-visible';
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
const VIDEO_READY_STATE_CURRENT_DATA = 2;
export const WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS = millisecondsToMicroseconds(5_000);
export const RAW_HDR_NEGOTIATION_WAIT_MICROSECONDS = millisecondsToMicroseconds(5_000);
const WEBGPU_RESOURCE_OPERATION_TIMEOUT = Symbol('webgpu-resource-operation-timeout');
// The raw Dolby Vision BL format whose routes are prewarmed, and which authorization queries default to
const PREWARMED_RAW_DOLBY_VISION_FRAME_FORMAT: RawDolbyVisionVideoFrameFormat = 'I420P10';
// The external Profile 5 route recovers 10-bit codes, so its RPU must declare a 10-bit base layer
const EXTERNAL_DOLBY_VISION_BASE_LAYER_BIT_DEPTH = 10;
// A new frame more than this many frame durations after the previous one is a discontinuity, which starts history over
const HISTORY_DISCONTINUITY_FRAME_DURATIONS = 2.5;
// The size facts take before a frame or a canvas measures them; default plans never depend on sizes
const UNKNOWN_PLAN_DIMENSION = 1;
// The native and identity SDR route: the browser's own conversion, presented as it is
const EXTERNAL_IDENTITY_CHAIN_CONFIGURATION: BuiltinChainConfiguration = { route: 'external-identity' };
const NEUTRAL_BT709_COLOR_DESCRIPTION = 'bt709:bt709:bt709:limited';

function waitForWebGPUResourceOperation<Value>(
    promise: Promise<Value>
): Promise<Value | typeof WEBGPU_RESOURCE_OPERATION_TIMEOUT> {
    return new Promise<Value | typeof WEBGPU_RESOURCE_OPERATION_TIMEOUT>((resolve, reject) => {
        const timeout = globalThis.setTimeout((): void => {
            resolve(WEBGPU_RESOURCE_OPERATION_TIMEOUT);
        }, microsecondsToMilliseconds(WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS));
        promise.then((value: Value): void => {
            globalThis.clearTimeout(timeout);
            resolve(value);
        }, (error: unknown): void => {
            globalThis.clearTimeout(timeout);
            reject(error);
        });
    });
}

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

export type PresentationFallbackReason =
    | 'adapter-unavailable'
    | 'canvas-context-unavailable'
    | 'canvas-configuration-failed'
    | 'device-recovery-failed'
    | 'device-request-failed'
    | 'decoded-frame-color-mismatch'
    | 'dolby-vision-metadata-invalid'
    | 'frame-import-failed'
    | 'frame-render-failed'
    | 'gpu-unavailable'
    | 'hdr-authorization-unavailable'
    | 'hdr-color-configuration-invalid'
    | 'hdr-tone-mapping-disabled'
    | 'insecure-context'
    | 'pipeline-creation-failed'
    | 'request-video-frame-callback-unavailable';

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
    /** Why a dual-layer route presents FEL frames as their base: the FEL authorization's failure; null while FEL reconstructs or the route has no FEL. */
    dolbyVisionFELAuthorizationFailure: string | null
    /** What failed, with the failing value, beside fallbackReason. */
    fallbackDetail: string | null
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
    /** The decode session's video epoch; a change starts temporal history over. */
    videoEpoch?: number
};

export type DecodedRawPresentationFrame = {
    durationMicroseconds: Microseconds
    encodedDolbyVisionMetadata?: TransferableDolbyVisionEncodedFrameMetadata
    HDR10PlusMetadata?: HDR10PlusFrameMetadata
    enhancementFrame?: TransferableRawVideoFrame | null
    frame: TransferableRawVideoFrame
    mediaTimeMicroseconds: Microseconds
    outputMode: 'raw-planes'
    /** The decode session's video epoch; a change starts temporal history over. */
    videoEpoch?: number
};

export type DecodedPresentationFrame =
    | DecodedRawPresentationFrame
    | DecodedVideoPresentationFrame;

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

type PresentationInputMode =
    | 'external-dolby-vision'
    | 'external-hdr'
    | 'external-texture'
    | 'raw-dolby-vision'
    | 'raw-yuv';

/** Receives a session's fallback: its code, and a terse detail with the failing value. */
type PresentationFallbackHandler = (generation: number, reason: PresentationFallbackReason, detail: string) => void;

type DecodedPresentationRefreshHandler = (generation: number) => void;

type PendingFrameCallback = {
    generation: number
    id: number
    video: HTMLVideoElement
};

type DolbyVisionDualLayerPresentation =
    | 'fel'
    | 'fel-base-fallback'
    | 'mel';

type FrameSubmission = {
    device: GPUDevice
    dolbyVisionDualLayerMode?: DolbyVisionDualLayerPresentation
    validationResult: Promise<GPUError | null> | null
};

type DualLayerDolbyVisionRPUData = {
    enhancementLayerBitDepth: number
    layerMode: 'fel' | 'mel'
    packedRPUData: ArrayBuffer
};

/** A frame's RPU, or the check that refused it as a terse `<check>: <detail>`. */
type DolbyVisionRPUResult<Data> = { data: Data; failure: null } | { data: null; failure: string };

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
    /** The route's built-in chain, which the presentation plan is built from. */
    chainConfiguration: BuiltinChainConfiguration
    dolbyVisionFELAuthorizationFailure: string | null
    dolbyVisionFELReconstruction: boolean
    dolbyVisionProfile: DolbyVisionReconstructionProfile | null
    inputMode: PresentationInputMode
    inputColorMetadata: InputColorMetadata | null
    rawFrameFormat: SupportedRawVideoFrameFormat | null
    settings: RenderSettings
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

/** When a frame presents: a new frame advances history, and a redraw repeats the last new frame. */
type FrameTiming = {
    /** The frame's own duration, or null when only the interval since the previous frame is known. */
    durationMicroseconds: number | null
    newFrame: boolean
    timestampMicroseconds: number
    videoEpoch: number | null
};

/** The last new frame, which the next new frame's timestamp is checked against. */
type PresentedFrameTiming = {
    durationMicroseconds: number | null
    timestampMicroseconds: number
    videoEpoch: number | null
};

/** An executor built for the current plan inputs, the active executor when it already renders them, or what failed. */
type ExecutorBuildResult =
    | { executor: PresentationExecutor; kind: 'built'; plan: PresentationPlan; planKey: string }
    | { detail: string; kind: 'failed' }
    | { kind: 'current' };

type ExecutorBuild = {
    device: GPUDevice
    promise: Promise<string | null>
    revision: number
};

function getMonotonicMicroseconds(): Microseconds {
    return millisecondsToMicroseconds(performance.now());
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Prefixes a check's failure with its subject, or passes null through. */
function prefixFailure(subject: string, failure: string | null): string | null {
    return failure === null ? null : `${subject}: ${failure}`;
}

function describeRange(fullRange: boolean | null): string {
    if (fullRange === null) {
        return 'unspecified';
    }
    return fullRange ? 'full' : 'limited';
}

function describeVideoFrameColor(frame: VideoFrame): string {
    const colorSpace = frame.colorSpace;
    return [
        String(colorSpace.transfer),
        String(colorSpace.primaries),
        String(colorSpace.matrix),
        describeRange(colorSpace.fullRange ?? null)
    ].join(':');
}

function describeMetadataColor(metadata: InputColorMetadata): string {
    return `${metadata.transfer}:${metadata.primaries}:${metadata.matrix}:${metadata.range}`;
}

/** Returns whether a route's chain reads an HDR signal, the planner's `hdr.source` fact. */
function isHDRSourceConfiguration(configuration: BuiltinChainConfiguration): boolean {
    switch (configuration.route) {
        case 'external-identity':
            return false;
        case 'external-dolby-vision':
        case 'raw-dolby-vision':
            return true;
        case 'external-hdr':
        case 'frame-pool':
        case 'raw-yuv':
            return configuration.metadata.transfer !== 'sdr';
    }
}

/** Returns a plan's identity: everything its GPU resources and modules come from, apart from its report. */
function getPlanKey(plan: PresentationPlan): string {
    return JSON.stringify({ ...plan, report: null });
}

function plannedOutputsMatch(first: PlannedOutput | null, second: PlannedOutput): boolean {
    return first !== null
        && first.colorSpace === second.colorSpace
        && first.format === second.format
        && first.toneMapping === second.toneMapping;
}

/** Describes why an executor could not be created: the first compile message, or the creation error. */
function describeExecutorCreationError(error: unknown): string {
    if (error instanceof PresentationCompileError) {
        const message = error.messages[0];
        return message ?
            `compile: ${message.passName ?? 'engine'} line ${message.line}:${message.column}: ${message.message}` :
            'compile: no messages';
    }
    return `executor: ${getErrorMessage(error)}`;
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
        dolbyVisionFELAuthorizationFailure: null,
        fallbackDetail: null,
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

/** Returns how a decoded frame's color description differs from the metadata, or null when it matches. */
function getDecodedFrameColorFailure(frame: VideoFrame, metadata: InputColorMetadata): string | null {
    const actualColor = describeVideoFrameColor(frame);
    const expectedColor = describeMetadataColor(metadata);
    return actualColor === expectedColor ? null : `color: ${actualColor}, expected ${expectedColor}`;
}

/** Returns how a decoded frame differs from the neutralized BT.709 limited-range description, or null when it matches. */
function getNeutralBT709FrameColorFailure(frame: VideoFrame): string | null {
    const actualColor = describeVideoFrameColor(frame);
    return actualColor === NEUTRAL_BT709_COLOR_DESCRIPTION ? null : `color: ${actualColor}, expected ${NEUTRAL_BT709_COLOR_DESCRIPTION}`;
}

function isExternalInputMode(inputMode: PresentationInputMode): boolean {
    return inputMode === 'external-texture'
        || inputMode === 'external-hdr'
        || inputMode === 'external-dolby-vision';
}

/** Returns whether a raw frame's transfer agrees with the metadata; a null transfer is unspecified. */
function rawFrameTransferMatches(colorSpace: RawVideoFrameColorSpace, metadata: InputColorMetadata): boolean {
    const transfer = colorSpace.transfer;
    if (transfer === null) {
        return true;
    }
    switch (metadata.transfer) {
        case 'hlg':
            // NOTE: An HLG-compatible VUI signals a BT.2020 transfer, which uses the BT.709 curve.
            // A decoder may report that transfer as bt709 instead of null
            return transfer === 'arib-std-b67'
                || transfer === 'hlg'
                || (transfer === 'bt709' && colorSpace.primaries === 'bt2020');
        case 'pq':
            return transfer === 'pq' || transfer === 'smpte2084';
        case 'sdr':
            // SMPTE 170M uses the BT.709 OETF
            return transfer === 'bt709' || transfer === 'smpte170m';
    }
}

/** Returns whether a raw frame color member agrees with the metadata; a null member is unspecified. */
function rawFrameColorMemberMatches(frameValue: string | null, metadataValue: string): boolean {
    return frameValue === null || frameValue === metadataValue;
}

/** Returns the first color member of a raw frame that contradicts the metadata, or null when none does. */
function getRawFrameColorFailure(frame: TransferableRawVideoFrame, metadata: InputColorMetadata): string | null {
    const colorSpace = frame.colorSpace;
    if (frame.bitDepth !== metadata.bitDepth) {
        return `bit-depth: ${frame.bitDepth}, expected ${metadata.bitDepth}`;
    }
    if (colorSpace.fullRange !== null && colorSpace.fullRange !== (metadata.range === 'full')) {
        return `range: ${describeRange(colorSpace.fullRange)}, expected ${metadata.range}`;
    }
    if (!rawFrameColorMemberMatches(colorSpace.matrix, metadata.matrix)) {
        return `matrix: ${colorSpace.matrix}, expected ${metadata.matrix}`;
    }
    if (!rawFrameColorMemberMatches(colorSpace.primaries, metadata.primaries)) {
        return `primaries: ${colorSpace.primaries}, expected ${metadata.primaries}`;
    }
    if (!rawFrameTransferMatches(colorSpace, metadata)) {
        return `transfer: ${colorSpace.transfer}, expected ${metadata.transfer}`;
    }
    return null;
}

/** Returns how a raw frame's own timing contradicts the decoded frame that carries it, or null. */
function getRawFrameTimingFailure(decodedFrame: DecodedRawPresentationFrame): string | null {
    const frame = decodedFrame.frame;
    if (frame.timestampMicroseconds !== decodedFrame.mediaTimeMicroseconds) {
        return `timestamp: ${frame.timestampMicroseconds}, expected ${decodedFrame.mediaTimeMicroseconds}`;
    }
    if (frame.durationMicroseconds !== null && frame.durationMicroseconds !== decodedFrame.durationMicroseconds) {
        return `duration: ${frame.durationMicroseconds}, expected ${decodedFrame.durationMicroseconds}`;
    }
    return null;
}

function getRawFrameDescriptorFailure(
    decodedFrame: DecodedRawPresentationFrame,
    metadata: InputColorMetadata,
    format: SupportedRawVideoFrameFormat
): string | null {
    const frame = decodedFrame.frame;
    if (frame.format !== format) {
        return `format: ${frame.format}, expected ${format}`;
    }
    return getRawFrameTimingFailure(decodedFrame)
        ?? getRawFrameColorFailure(frame, metadata)
        ?? prefixFailure('layout', getRawPlaneLayoutFailure(frame));
}

function getRawDolbyVisionFrameDescriptorFailure(
    decodedFrame: DecodedRawPresentationFrame,
    format: SupportedRawVideoFrameFormat
): string | null {
    const frame = decodedFrame.frame;
    if (!isRawDolbyVisionVideoFrameFormat(format)) {
        return `format: ${format} is not a Dolby Vision base layer format`;
    }
    if (frame.format !== format) {
        return `format: ${frame.format}, expected ${format}`;
    }
    if (frame.bitDepth !== getRawFormatBitDepth(format)) {
        return `bit-depth: ${frame.bitDepth}, expected ${getRawFormatBitDepth(format)}`;
    }
    return getRawFrameTimingFailure(decodedFrame) ?? prefixFailure('layout', getRawPlaneLayoutFailure(frame));
}

function getRawDolbyVisionEnhancementFrameFailure(decodedFrame: DecodedRawPresentationFrame): string | null {
    const enhancementFrame = decodedFrame.enhancementFrame;
    if (!enhancementFrame) {
        return null;
    }
    const baseFrame = decodedFrame.frame;
    const hasCompatibleDimensions = (
        enhancementFrame.codedWidth === baseFrame.codedWidth
        && enhancementFrame.codedHeight === baseFrame.codedHeight
    ) || (
        enhancementFrame.codedWidth * 2 === baseFrame.codedWidth
        && enhancementFrame.codedHeight * 2 === baseFrame.codedHeight
    );
    const enhancementBitDepth = getRawFormatBitDepth(RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT);
    if (enhancementFrame.data !== baseFrame.data) {
        return 'enhancement-buffer: not the base layer\'s buffer';
    }
    if (enhancementFrame.format !== RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT) {
        return `enhancement-format: ${enhancementFrame.format}, expected ${RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT}`;
    }
    if (enhancementFrame.bitDepth !== enhancementBitDepth) {
        return `enhancement-bit-depth: ${enhancementFrame.bitDepth}, expected ${enhancementBitDepth}`;
    }
    if (!hasCompatibleDimensions) {
        return `enhancement-size: ${enhancementFrame.codedWidth}x${enhancementFrame.codedHeight} beside base ${baseFrame.codedWidth}x${baseFrame.codedHeight}`;
    }
    if (Math.abs(enhancementFrame.timestampMicroseconds - decodedFrame.mediaTimeMicroseconds) > 1) {
        return `enhancement-timestamp: ${enhancementFrame.timestampMicroseconds}, expected ${decodedFrame.mediaTimeMicroseconds}`;
    }
    return prefixFailure('enhancement-layout', getRawPlaneLayoutFailure(enhancementFrame));
}

function createRPUFailure<Data>(failure: string): DolbyVisionRPUResult<Data> {
    return { data: null, failure };
}

/**
 * Returns the one single-layer RPU of a frame, or the check that refused it.
 * Profile 5 and 8 RPUs reconstruct through the same RPU-driven transform, so either is accepted whatever the container profile says (Profile 20 base views carry either).
 */
function getSingleLayerDolbyVisionRPUData(
    metadata: TransferableDolbyVisionEncodedFrameMetadata | undefined,
    expectedBaseLayerBitDepth: number
): DolbyVisionRPUResult<ArrayBuffer> {
    if (!isTransferableDolbyVisionEncodedFrameMetadata(metadata)) {
        return createRPUFailure(getDolbyVisionEncodedFrameMetadataFailure(metadata) ?? 'metadata: malformed');
    }
    if (metadata.hasEnhancementLayerVCL || metadata.enhancementLayerDisposition !== 'absent') {
        return createRPUFailure(`enhancement-layer: ${metadata.enhancementLayerDisposition}, expected absent`);
    }
    if (metadata.parsedRPUData.length !== 1) {
        return createRPUFailure(`rpu-count: ${metadata.parsedRPUData.length}, expected 1`);
    }
    const packedRPUData = metadata.parsedRPUData[0];
    let snapshot: ReturnType<typeof decodeDolbyVisionRPUSnapshot>;
    try {
        snapshot = decodeDolbyVisionRPUSnapshot(packedRPUData);
    } catch (error) {
        return createRPUFailure(`rpu: ${getErrorMessage(error)}`);
    }
    if (snapshot.profile !== 5 && snapshot.profile !== 8) {
        return createRPUFailure(`rpu-profile: ${snapshot.profile}, expected 5 or 8`);
    }
    if (snapshot.layerMode !== 'single-layer') {
        return createRPUFailure(`rpu-layer: ${snapshot.layerMode}, expected single-layer`);
    }
    if (snapshot.baseLayerBitDepth !== expectedBaseLayerBitDepth) {
        return createRPUFailure(`rpu-bit-depth: ${snapshot.baseLayerBitDepth}, expected ${expectedBaseLayerBitDepth}`);
    }
    if (!snapshot.disableResidual) {
        return createRPUFailure('rpu-residual: enabled');
    }
    if (snapshot.nlqActive) {
        return createRPUFailure('rpu-nlq: active');
    }
    return { data: packedRPUData, failure: null };
}

/** Returns the EL disposition a dual-layer frame must report for its EL state. */
function getExpectedDualLayerDisposition(
    layerMode: 'fel' | 'mel',
    hasEnhancementLayerVCL: boolean,
    hasDecodedEnhancementFrame: boolean
): TransferableDolbyVisionEncodedFrameMetadata['enhancementLayerDisposition'] {
    if (!hasEnhancementLayerVCL) {
        return 'absent';
    }
    if (hasDecodedEnhancementFrame) {
        return layerMode === 'fel' ? 'decoded-fel' : 'decoded-mel';
    }
    return layerMode === 'fel' ? 'discarded-fel' : 'discarded-mel';
}

/**
 * Returns the one dual-layer RPU of a Profile 4 or 7 frame, or the check that refused it.
 * A frame whose EL is absent from the stream is accepted: MEL reconstructs exactly from the BL, and FEL presents its compatible base.
 */
function getDualLayerDolbyVisionRPUData(
    metadata: TransferableDolbyVisionEncodedFrameMetadata | undefined,
    expectedProfile: 4 | 7,
    expectedBaseLayerBitDepth: number,
    hasDecodedEnhancementFrame: boolean
): DolbyVisionRPUResult<DualLayerDolbyVisionRPUData> {
    if (!isTransferableDolbyVisionEncodedFrameMetadata(metadata)) {
        return createRPUFailure(getDolbyVisionEncodedFrameMetadataFailure(metadata) ?? 'metadata: malformed');
    }
    if (metadata.parsedRPUData.length !== 1) {
        return createRPUFailure(`rpu-count: ${metadata.parsedRPUData.length}, expected 1`);
    }
    if (hasDecodedEnhancementFrame && !metadata.hasEnhancementLayerVCL) {
        return createRPUFailure('enhancement-layer: decoded EL without EL VCL');
    }
    const packedRPUData = metadata.parsedRPUData[0];
    let snapshot: ReturnType<typeof decodeDolbyVisionRPUSnapshot>;
    try {
        snapshot = decodeDolbyVisionRPUSnapshot(packedRPUData);
    } catch (error) {
        return createRPUFailure(`rpu: ${getErrorMessage(error)}`);
    }
    if (snapshot.profile !== expectedProfile) {
        return createRPUFailure(`rpu-profile: ${snapshot.profile}, expected ${expectedProfile}`);
    }
    if (snapshot.baseLayerBitDepth !== expectedBaseLayerBitDepth) {
        return createRPUFailure(`rpu-bit-depth: ${snapshot.baseLayerBitDepth}, expected ${expectedBaseLayerBitDepth}`);
    }
    if (snapshot.disableResidual) {
        return createRPUFailure('rpu-residual: disabled');
    }
    if (snapshot.layerMode === 'single-layer') {
        return createRPUFailure('rpu-layer: single-layer, expected fel or mel');
    }
    // MEL carries no active residual and FEL always does
    if (snapshot.nlqActive !== (snapshot.layerMode === 'fel')) {
        return createRPUFailure(`rpu-nlq: ${snapshot.nlqActive ? 'active' : 'inactive'} for ${snapshot.layerMode}`);
    }
    const expectedDisposition = getExpectedDualLayerDisposition(
        snapshot.layerMode,
        metadata.hasEnhancementLayerVCL,
        hasDecodedEnhancementFrame
    );
    if (metadata.enhancementLayerDisposition !== expectedDisposition) {
        return createRPUFailure(`enhancement-layer: ${metadata.enhancementLayerDisposition}, expected ${expectedDisposition}`);
    }
    return {
        data: {
            enhancementLayerBitDepth: snapshot.enhancementLayerBitDepth,
            layerMode: snapshot.layerMode,
            packedRPUData
        },
        failure: null
    };
}

/**
 * Returns the EL a frame composes, if any.
 * The EL texture holds the EL decoder's 10-bit codes, so an RPU that scales its residual by another depth presents its base instead, as a frame whose EL failed to decode does.
 */
function getComposedEnhancementFrame(
    rpuData: DualLayerDolbyVisionRPUData | null,
    reconstructsFEL: boolean,
    enhancementFrame: TransferableRawVideoFrame | null | undefined
): TransferableRawVideoFrame | null {
    if (
        !reconstructsFEL
        || !enhancementFrame
        || rpuData?.enhancementLayerBitDepth !== getRawFormatBitDepth(RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT)
    ) {
        return null;
    }
    return enhancementFrame;
}

function getDualLayerPresentation(
    rpuData: DualLayerDolbyVisionRPUData,
    composedEnhancementFrame: TransferableRawVideoFrame | null
): DolbyVisionDualLayerPresentation {
    if (rpuData.layerMode === 'mel') {
        return 'mel';
    }
    return composedEnhancementFrame ? 'fel' : 'fel-base-fallback';
}

function getDecodedFrameTiming(decodedFrame: DecodedPresentationFrame): FrameTiming {
    return {
        durationMicroseconds: decodedFrame.durationMicroseconds,
        newFrame: true,
        timestampMicroseconds: decodedFrame.mediaTimeMicroseconds,
        videoEpoch: decodedFrame.videoEpoch ?? null
    };
}

/** Presents frames from an owned HTML video without taking over playback. */
export default class WebGPUPresenter {
    private readonly fallbackHandler: PresentationFallbackHandler;
    private readonly decodedPresentationRefreshHandler: DecodedPresentationRefreshHandler;
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
    private configuredOutput: PlannedOutput | null = null;
    // The route's built-in chain, which every plan builds on
    private desiredChainConfiguration: BuiltinChainConfiguration = EXTERNAL_IDENTITY_CHAIN_CONFIGURATION;
    private device: GPUDevice | null = null;
    private deviceRecoveryAttempts = 0;
    private deviceResourceEpoch = 0;
    private decodedFramePushActive = false;
    private dynamicHDR10PlusSettingsActive = false;
    private executor: PresentationExecutor | null = null;
    private executorBuild: ExecutorBuild | null = null;
    private executorPlan: PresentationPlan | null = null;
    private executorPlanKey: string | null = null;
    // The plan revision the active executor answers
    private executorRevision = -1;
    private fallbackLatched = false;
    private initializationFailureDetail = 'navigator.gpu undefined';
    private initializationFailureReason: PresentationFallbackReason = 'gpu-unavailable';
    private initializationPromise: Promise<boolean> | null = null;
    private lastNewFrame: PresentedFrameTiming | null = null;
    private layoutHandlingRevision = 0;
    private layoutInvalidationHandler: (() => void) | null = null;
    private layoutMutationObserver: MutationObserver | null = null;
    private pendingFrameCallback: PendingFrameCallback | null = null;
    private pendingColorConfiguration: PendingColorConfiguration | null = null;
    private pendingSubmissionValidation: PendingSubmissionValidation | null = null;
    // Advances whenever a plan input changes: the route, the device, or the output
    private planRevision = 0;
    private presentationLayoutDirty = true;
    // The render settings uniform the active route last wrote, which a new executor takes over
    private renderSettingsData: ArrayBuffer | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private sessionActive = false;
    private settings: RenderSettings = createDefaultRenderSettings();
    private surface: PresentationSurface | null = null;
    private submissionValidated = false;
    private telemetry = createTelemetry(this.settings);

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

        this.activeGeneration = generation;
        this.automaticInputPeakNits = true;
        this.activeDolbyVisionProfile = null;
        this.activeDolbyVisionFELReconstruction = false;
        this.activeInputColorMetadata = null;
        this.activeInputMode = 'external-texture';
        this.activeRawFrameFormat = null;
        this.colorConfigurationRevision += 1;
        this.decodedFramePushActive = false;
        this.setDesiredChainConfiguration(EXTERNAL_IDENTITY_CHAIN_CONFIGURATION);
        this.deviceRecoveryAttempts = 0;
        this.dynamicHDR10PlusSettingsActive = false;
        this.fallbackLatched = false;
        this.pendingColorConfiguration = null;
        this.pendingSubmissionValidation = null;
        this.renderSettingsData = null;
        this.resetPresentationHistory();
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
            this.fallback(generation, 'canvas-context-unavailable', 'surface: the video is not a child of the container');
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
        this.resetPresentationHistory();
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
            if (!this.resynchronizeCachedPresentationLayout()) {
                return;
            }
            this.requestDecodedPresentationRefresh(generation);
            return;
        }
        this.invalidatePresentationLayout();
        this.renderCurrentFrameOrFallback(generation);
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
        this.releaseRouteResources();
        this.surface = null;
        this.telemetry.state = 'idle';
    }

    /** Releases reusable GPU resources while allowing a later fresh session. */
    destroy(): void {
        this.endSession(this.activeGeneration + 1);
        this.deviceResourceEpoch += 1;
        const device = this.device;
        this.device = null;
        this.releaseExecutor();
        this.canvasFormat = null;
        this.configuredDevice = null;
        this.configuredOutput = null;
        this.initializationPromise = null;
        this.planRevision += 1;
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
            this.getActiveExternalDolbyVisionAuthorizationFailure() === null :
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
     * Takes ownership of one clock-selected decoded frame and closes it on every path.
     * This path does not require a native video-frame callback.
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
                this.fallback(
                    generation,
                    'frame-render-failed',
                    `timing: media time ${decodedFrame.mediaTimeMicroseconds}, duration ${decodedFrame.durationMicroseconds}`
                );
                return false;
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
                this.fallback(generation, 'frame-render-failed', `frame-size: ${frameWidth}x${frameHeight}`);
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
            this.fallback(generation, 'frame-import-failed', getErrorMessage(error));
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

        const installFailure = await this.installPreparedExecutor(preparedPipeline, pendingConfiguration);
        if (!this.isColorConfigurationCurrent(pendingConfiguration)) {
            return false;
        }
        if (installFailure !== null) {
            this.failColorConfiguration(pendingConfiguration, 'pipeline-creation-failed', installFailure);
            return false;
        }
        if (preparedPipeline.settings.mode === 'hdr-to-sdr') {
            const writeFailure = this.writeRenderSettingsUniform(preparedPipeline.settings);
            if (writeFailure !== null) {
                this.failColorConfiguration(pendingConfiguration, 'pipeline-creation-failed', writeFailure);
                return false;
            }
        } else {
            this.renderSettingsData = null;
        }
        this.dynamicHDR10PlusSettingsActive = false;

        this.activeDolbyVisionProfile = preparedPipeline.dolbyVisionProfile;
        this.activeDolbyVisionFELReconstruction = preparedPipeline.dolbyVisionFELReconstruction;
        this.activeInputMode = preparedPipeline.inputMode;
        this.activeInputColorMetadata = preparedPipeline.inputColorMetadata ?
            { ...preparedPipeline.inputColorMetadata } :
            null;
        this.activeRawFrameFormat = preparedPipeline.rawFrameFormat;
        this.automaticInputPeakNits = configuration.automaticInputPeakNits ?? true;
        this.settings = preparedPipeline.settings;
        this.telemetry.dolbyVisionFELAuthorizationFailure = preparedPipeline.dolbyVisionFELAuthorizationFailure;
        this.telemetry.mode = preparedPipeline.settings.mode;
        this.pendingColorConfiguration = null;
        this.resumeAfterColorConfiguration(generation);
        return true;
    }

    /** Writes the render settings uniform and keeps it for executors built later; returns what failed, or null. */
    private writeRenderSettingsUniform(
        settings: HDRToSDRRenderSettings,
        dynamicFrameSettings: HDR10PlusFrameRenderSettings | null = null
    ): string | null {
        try {
            const renderSettingsData = createRenderSettingsUniformData(settings, dynamicFrameSettings).buffer;
            this.executor?.writeRenderSettings(renderSettingsData);
            this.renderSettingsData = renderSettingsData;
            return null;
        } catch (error) {
            return `render-settings: ${getErrorMessage(error)}`;
        }
    }

    private applyHDR10PlusFrameMetadata(decodedFrame: DecodedPresentationFrame, generation: number): boolean {
        if (!this.isCurrent(generation) || this.settings.mode !== 'hdr-to-sdr') {
            return true;
        }

        const frameMetadata = decodedFrame.HDR10PlusMetadata;
        const status = frameMetadata?.status ?? 'absent';
        this.telemetry.lastHDR10PlusMetadataStatus = status;
        let dynamicFrameSettings: HDR10PlusFrameRenderSettings | null = null;
        const supportsHDR10Plus = (
            this.activeInputMode === 'external-hdr'
            || this.activeInputMode === 'raw-yuv'
        ) && this.activeInputColorMetadata?.transfer === 'pq';
        // An absent or malformed frame may carry its run's last metadata, which applies as a valid frame's own does
        if (
            supportsHDR10Plus
            && isHDR10PlusFrameMetadata(frameMetadata)
            && frameMetadata.metadata
        ) {
            const sceneLuminance = getHDR10PlusSceneLuminance(frameMetadata.metadata);
            const inputPeakNits = this.automaticInputPeakNits ?
                Math.max(
                    this.settings.toneMapping.paperWhiteNits,
                    sceneLuminance.peakNits ?? this.settings.toneMapping.inputPeakNits
                ) :
                this.settings.toneMapping.inputPeakNits;
            const averageNits = Math.min(inputPeakNits, Math.max(0, sceneLuminance.averageNits ?? 0));
            dynamicFrameSettings = {
                averageNits,
                inputPeakNits,
                targetedSystemDisplayMaximumLuminanceNits:
                    frameMetadata.metadata.targetedSystemDisplayMaximumLuminanceNits,
                toneMapping: frameMetadata.metadata.toneMapping
            };
        }

        if (dynamicFrameSettings || this.dynamicHDR10PlusSettingsActive) {
            const writeFailure = this.writeRenderSettingsUniform(this.settings, dynamicFrameSettings);
            if (writeFailure !== null) {
                this.fallback(generation, 'frame-render-failed', writeFailure);
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

        if (typeof automaticInputPeakNits !== 'boolean') {
            console.warn(`render-settings: automatic input peak policy ${String(automaticInputPeakNits)} is not boolean`);
            return false;
        }
        const writeFailure = this.writeRenderSettingsUniform(settings);
        if (writeFailure !== null) {
            console.warn(writeFailure);
            return false;
        }
        this.dynamicHDR10PlusSettingsActive = false;

        this.settings = cloneRenderSettings(settings);
        this.automaticInputPeakNits = automaticInputPeakNits;
        this.requestDecodedPresentationRefresh(generation);
        return true;
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
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid', getErrorMessage(error));
            return null;
        }
        return {
            chainConfiguration: EXTERNAL_IDENTITY_CHAIN_CONFIGURATION,
            dolbyVisionFELAuthorizationFailure: null,
            dolbyVisionFELReconstruction: false,
            dolbyVisionProfile: null,
            inputMode: 'external-texture',
            inputColorMetadata: null,
            rawFrameFormat: null,
            settings: cloneRenderSettings(configuration.settings)
        };
    }

    /** Validates a route's chain configuration by building its chain; returns what is invalid, or null. */
    private validateChainConfiguration(configuration: BuiltinChainConfiguration): string | null {
        try {
            createBuiltinChain(configuration);
            return null;
        } catch (error) {
            return getErrorMessage(error);
        }
    }

    /** Waits for the HDR feature gate and the device; returns false after failing or abandoning the configuration. */
    private async awaitHDRConfigurationPrerequisites(pendingConfiguration: PendingColorConfiguration): Promise<boolean> {
        const featureEnabled = await isHDRToneMappingEnabled();
        if (!this.isColorConfigurationCurrent(pendingConfiguration)) {
            return false;
        }
        if (!featureEnabled) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-tone-mapping-disabled', 'hdrToneMappingEnabled false');
            return false;
        }
        const initialized = await this.ensureDevice();
        return initialized && this.isColorConfigurationCurrent(pendingConfiguration);
    }

    private async prepareExternalDolbyVisionColorPipeline(
        configuration: ExternalDolbyVisionColorPipelineConfiguration,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<PreparedColorPipeline | null> {
        try {
            assertValidRenderSettings(configuration.settings);
        } catch (error) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid', getErrorMessage(error));
            return null;
        }
        if (configuration.settings.mode !== 'hdr-to-sdr') {
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-color-configuration-invalid',
                `mode: ${String(configuration.settings.mode)}, expected hdr-to-sdr`
            );
            return null;
        }

        if (!await this.awaitHDRConfigurationPrerequisites(pendingConfiguration)) {
            return null;
        }
        const authorizationFailure = this.getExternalDolbyVisionAuthorizationFailure();
        if (authorizationFailure !== null) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-authorization-unavailable', authorizationFailure);
            return null;
        }

        const chainConfiguration: BuiltinChainConfiguration = {
            hdrOutput: false,
            route: 'external-dolby-vision',
            settings: configuration.settings
        };
        const chainFailure = this.validateChainConfiguration(chainConfiguration);
        if (chainFailure !== null) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid', chainFailure);
            return null;
        }
        return {
            chainConfiguration,
            dolbyVisionFELAuthorizationFailure: null,
            dolbyVisionFELReconstruction: false,
            dolbyVisionProfile: configuration.profile,
            inputMode: 'external-dolby-vision',
            inputColorMetadata: null,
            rawFrameFormat: null,
            settings: cloneRenderSettings(configuration.settings)
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
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid', getErrorMessage(error));
            return null;
        }
        if (configuration.settings.mode !== 'hdr-to-sdr') {
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-color-configuration-invalid',
                `mode: ${String(configuration.settings.mode)}, expected hdr-to-sdr`
            );
            return null;
        }
        if (!getExternalHDRAuthorizationRouteKey(configuration.metadata)) {
            const metadata = configuration.metadata;
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-color-configuration-invalid',
                `route-unsupported: ${metadata.bitDepth}-bit ${metadata.matrix}:${metadata.primaries}:${metadata.range}:${metadata.transfer}`
            );
            return null;
        }

        if (!await this.awaitHDRConfigurationPrerequisites(pendingConfiguration)) {
            return null;
        }
        const authorizationFailure = this.getExternalHDRAuthorizationFailure(configuration.metadata);
        if (authorizationFailure !== null) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-authorization-unavailable', authorizationFailure);
            return null;
        }

        const chainConfiguration: BuiltinChainConfiguration = {
            hdrOutput: false,
            metadata: { ...configuration.metadata },
            route: 'external-hdr',
            settings: configuration.settings
        };
        const chainFailure = this.validateChainConfiguration(chainConfiguration);
        if (chainFailure !== null) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid', chainFailure);
            return null;
        }
        return {
            chainConfiguration,
            dolbyVisionFELAuthorizationFailure: null,
            dolbyVisionFELReconstruction: false,
            dolbyVisionProfile: null,
            inputMode: 'external-hdr',
            inputColorMetadata: { ...configuration.metadata },
            rawFrameFormat: null,
            settings: cloneRenderSettings(configuration.settings)
        };
    }

    private async prepareRawHDRColorPipeline(
        configuration: RawHDRColorPipelineConfiguration,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<PreparedColorPipeline | null> {
        const configurationFailure = this.getRawHDRColorConfigurationFailure(configuration);
        if (configurationFailure !== null) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid', configurationFailure);
            return null;
        }

        const featureEnabled = configuration.settings.mode === 'identity-sdr'
            || await isHDRToneMappingEnabled();
        if (!this.isColorConfigurationCurrent(pendingConfiguration)) {
            return null;
        }
        if (!featureEnabled) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-tone-mapping-disabled', 'hdrToneMappingEnabled false');
            return null;
        }

        const initialized = await this.ensureDevice();
        if (!initialized || !this.isColorConfigurationCurrent(pendingConfiguration)) {
            return null;
        }
        const authorizationFailure = this.getRawHDRAuthorizationFailure(configuration.metadata, configuration.rawFrameFormat);
        if (authorizationFailure !== null) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-authorization-unavailable', authorizationFailure);
            return null;
        }

        const chainConfiguration: BuiltinChainConfiguration = {
            format: configuration.rawFrameFormat,
            hdrOutput: false,
            metadata: { ...configuration.metadata },
            route: 'raw-yuv',
            settings: configuration.settings
        };
        const chainFailure = this.validateChainConfiguration(chainConfiguration);
        if (chainFailure !== null) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid', chainFailure);
            return null;
        }

        return {
            chainConfiguration,
            dolbyVisionFELAuthorizationFailure: null,
            dolbyVisionFELReconstruction: false,
            dolbyVisionProfile: null,
            inputMode: 'raw-yuv',
            inputColorMetadata: { ...configuration.metadata },
            rawFrameFormat: configuration.rawFrameFormat,
            settings: cloneRenderSettings(configuration.settings)
        };
    }

    private async prepareRawDolbyVisionColorPipeline(
        configuration: RawDolbyVisionColorPipelineConfiguration,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<PreparedColorPipeline | null> {
        try {
            assertValidRenderSettings(configuration.settings);
        } catch (error) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid', getErrorMessage(error));
            return null;
        }
        if (configuration.settings.mode !== 'hdr-to-sdr') {
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-color-configuration-invalid',
                `mode: ${String(configuration.settings.mode)}, expected hdr-to-sdr`
            );
            return null;
        }

        if (!await this.awaitHDRConfigurationPrerequisites(pendingConfiguration)) {
            return null;
        }
        const format = configuration.rawFrameFormat;
        if (!isRawDolbyVisionVideoFrameFormat(format)) {
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-color-configuration-invalid',
                `format: ${String(format)} is not a Dolby Vision base layer format`
            );
            return null;
        }
        const authorizations = this.getRawDolbyVisionAuthorizations(configuration.profile, format);
        const baseAuthorizationFailure = this.getRawDolbyVisionAuthorizationFailure(authorizations.base, format);
        if (baseAuthorizationFailure !== null) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-authorization-unavailable', baseAuthorizationFailure);
            return null;
        }

        // An FEL route that is not authorized presents FEL frames as their base, and telemetry says why
        const felAuthorizationFailure = authorizations.fel === null ?
            null :
            this.getRawDolbyVisionAuthorizationFailure(authorizations.fel, format);
        const dolbyVisionFELReconstruction = authorizations.fel !== null && felAuthorizationFailure === null;
        const chainConfiguration: BuiltinChainConfiguration = {
            felReconstruction: dolbyVisionFELReconstruction,
            format,
            hdrOutput: false,
            profile: configuration.profile,
            route: 'raw-dolby-vision',
            settings: configuration.settings
        };
        const chainFailure = this.validateChainConfiguration(chainConfiguration);
        if (chainFailure !== null) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid', chainFailure);
            return null;
        }
        return {
            chainConfiguration,
            dolbyVisionFELAuthorizationFailure: felAuthorizationFailure,
            dolbyVisionFELReconstruction,
            dolbyVisionProfile: configuration.profile,
            inputMode: 'raw-dolby-vision',
            inputColorMetadata: null,
            rawFrameFormat: format,
            settings: cloneRenderSettings(configuration.settings)
        };
    }

    /** Returns why a raw configuration cannot present: invalid metadata or settings, a transfer the mode cannot render, or a depth the format cannot hold. */
    private getRawHDRColorConfigurationFailure(configuration: RawHDRColorPipelineConfiguration): string | null {
        try {
            assertValidInputColorMetadata(configuration.metadata);
            assertValidRenderSettings(configuration.settings);
        } catch (error) {
            return getErrorMessage(error);
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
            return `mode: ${configuration.settings.mode} cannot present ${configuration.metadata.transfer}`;
        }

        const formatBitDepth = getRawFormatBitDepth(configuration.rawFrameFormat);
        return configuration.metadata.bitDepth === formatBitDepth ?
            null :
            `bit-depth: ${configuration.metadata.bitDepth}, ${configuration.rawFrameFormat} holds ${formatBitDepth}`;
    }

    private getRawHDRAuthorizationFailure(metadata: InputColorMetadata, format: SupportedRawVideoFrameFormat): string | null {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (!device || !targetFormat) {
            return 'device: unavailable';
        }
        return this.rawHDRAuthorization.getAuthorizationFailure(device, targetFormat, metadata, format);
    }

    private getExternalHDRAuthorizationFailure(metadata: InputColorMetadata): string | null {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (!device || !targetFormat) {
            return 'device: unavailable';
        }
        return this.externalHDRAuthorization.getAuthorizationFailure(device, targetFormat, metadata);
    }

    /** Returns why the active external HDR route is not authorized for the metadata, including a mode that tone maps nothing. */
    private getActiveExternalHDRAuthorizationFailure(metadata: InputColorMetadata): string | null {
        return this.settings.mode === 'hdr-to-sdr' ?
            this.getExternalHDRAuthorizationFailure(metadata) :
            `mode: ${this.settings.mode}, expected hdr-to-sdr`;
    }

    private getRawDolbyVisionAuthorizationFailure(
        authorization: DolbyVisionPresentationAuthorizationRegistry,
        format: SupportedRawVideoFrameFormat
    ): string | null {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (!device || !targetFormat) {
            return 'device: unavailable';
        }
        return authorization.getAuthorizationFailure(device, targetFormat, format);
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
            this.getActiveRawDolbyVisionAuthorizationFailure(format, profile) === null :
            this.getRawDolbyVisionAuthorizations(profile, format).base.getTelemetry(
                this.device,
                this.canvasFormat
            ).status === 'authorized';
    }

    /** Returns why the active raw Dolby Vision route is not authorized for a BL format, or null when it is. */
    private getActiveRawDolbyVisionAuthorizationFailure(
        format: SupportedRawVideoFrameFormat,
        profile: DolbyVisionReconstructionProfile | null
    ): string | null {
        if (profile === null) {
            return 'profile: none configured';
        }
        if (!isRawDolbyVisionVideoFrameFormat(format)) {
            return `format: ${format} is not a Dolby Vision base layer format`;
        }
        if (this.settings.mode !== 'hdr-to-sdr') {
            return `mode: ${this.settings.mode}, expected hdr-to-sdr`;
        }
        return this.getRawDolbyVisionAuthorizationFailure(this.getRawDolbyVisionAuthorizations(profile, format).base, format);
    }

    private getExternalDolbyVisionAuthorizationFailure(): string | null {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (!device || !targetFormat) {
            return 'device: unavailable';
        }
        return this.externalDolbyVisionAuthorization.getAuthorizationFailure(device, targetFormat);
    }

    /** Returns why the active external Profile 5 route is not authorized, including a mode that tone maps nothing. */
    private getActiveExternalDolbyVisionAuthorizationFailure(): string | null {
        return this.settings.mode === 'hdr-to-sdr' ?
            this.getExternalDolbyVisionAuthorizationFailure() :
            `mode: ${this.settings.mode}, expected hdr-to-sdr`;
    }

    private suspendForColorConfiguration(): void {
        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.unbindLayoutHandling();
        this.removeCanvas();
        this.telemetry.state = 'initializing';
    }

    private resumeAfterColorConfiguration(generation: number): void {
        if (!this.surface || !this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }
        if (!this.createAndConfigureCanvas()) {
            this.fallback(generation, this.initializationFailureReason, this.initializationFailureDetail);
            return;
        }

        this.scheduleFrameCallback(generation);
    }

    private failColorConfiguration(
        pendingConfiguration: PendingColorConfiguration,
        reason: PresentationFallbackReason,
        detail: string
    ): void {
        if (!this.isColorConfigurationCurrent(pendingConfiguration)) {
            return;
        }

        this.pendingColorConfiguration = null;
        this.fallback(pendingConfiguration.generation, reason, detail);
    }

    private isColorConfigurationCurrent(pendingConfiguration: PendingColorConfiguration): boolean {
        return this.pendingColorConfiguration === pendingConfiguration
            && this.colorConfigurationRevision === pendingConfiguration.revision
            && this.isCurrent(pendingConfiguration.generation)
            && !this.fallbackLatched;
    }

    /** Makes a prepared route the plan's chain and builds its executor; returns what failed, or null. */
    private async installPreparedExecutor(
        preparedPipeline: PreparedColorPipeline,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<string | null> {
        const initialized = await this.ensureDevice();
        if (!this.isColorConfigurationCurrent(pendingConfiguration)) {
            return null;
        }
        if (!initialized) {
            return `device: ${this.initializationFailureReason}: ${this.initializationFailureDetail}`;
        }
        this.setDesiredChainConfiguration(preparedPipeline.chainConfiguration);
        return this.ensureDesiredExecutor();
    }

    /** Sets the route's chain; a different chain advances the plan revision, so the next frame's executor is rebuilt for it. */
    private setDesiredChainConfiguration(configuration: BuiltinChainConfiguration): void {
        if (configuration === this.desiredChainConfiguration) {
            return;
        }
        this.desiredChainConfiguration = configuration;
        this.planRevision += 1;
    }

    private async prepareGeneration(generation: number): Promise<void> {
        const initialized = await this.ensureDevice();
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }

        if (!initialized) {
            this.fallback(generation, this.initializationFailureReason, this.initializationFailureDetail);
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
            this.fallback(generation, this.initializationFailureReason, this.initializationFailureDetail);
            return;
        }

        if (!this.createAndConfigureCanvas()) {
            this.fallback(generation, this.initializationFailureReason, this.initializationFailureDetail);
            return;
        }

        this.scheduleFrameCallback(generation);
    }

    /** Records why initialization failed for the fallback that reports it, and returns false. */
    private failInitialization(reason: PresentationFallbackReason, detail: string): false {
        this.initializationFailureReason = reason;
        this.initializationFailureDetail = detail;
        return false;
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
            return this.failInitialization('pipeline-creation-failed', `initialization: ${getErrorMessage(error)}`);
        } finally {
            if (initializationPromise && this.initializationPromise === initializationPromise) {
                this.initializationPromise = null;
            }
        }

        if (!initialized || !this.hasBaseDeviceResources()) {
            return false;
        }

        const executorFailure = await this.ensureDesiredExecutor();
        return executorFailure === null || this.failInitialization('pipeline-creation-failed', executorFailure);
    }

    private hasBaseDeviceResources(): boolean {
        return this.device !== null && this.canvasFormat !== null;
    }

    /**
     * Ensures the active executor answers the current plan inputs, building one when they changed; returns what failed, or null.
     * Concurrent callers share one build, and inputs that change during a build start another for the new inputs.
     */
    private async ensureDesiredExecutor(): Promise<string | null> {
        for (;;) {
            const device = this.device;
            const canvasFormat = this.canvasFormat;
            if (!device || !canvasFormat) {
                return 'device: unavailable';
            }
            if (this.executor && this.executorRevision === this.planRevision) {
                return null;
            }
            const revision = this.planRevision;
            let build = this.executorBuild;
            if (!build || build.revision !== revision || build.device !== device) {
                build = { device, promise: this.buildAndInstallExecutor(device, canvasFormat, revision), revision };
                this.executorBuild = build;
            }
            const failure = await build.promise;
            if (this.executorBuild === build) {
                this.executorBuild = null;
            }
            if (this.planRevision === revision && this.device === device) {
                return failure;
            }
        }
    }

    /** Builds the executor for one plan revision and installs it unless the inputs moved on; returns what failed, or null. */
    private async buildAndInstallExecutor(device: GPUDevice, canvasFormat: GPUTextureFormat, revision: number): Promise<string | null> {
        const resourceEpoch = this.deviceResourceEpoch;
        const result = await this.buildExecutor(device, canvasFormat);
        switch (result.kind) {
            case 'current':
                this.executorRevision = revision;
                return null;
            case 'failed':
                return result.detail;
            case 'built':
                if (this.deviceResourceEpoch !== resourceEpoch || this.device !== device || this.planRevision !== revision) {
                    result.executor.destroy();
                    return null;
                }
                this.installExecutor(result.executor, result.plan, result.planKey, revision);
                return null;
        }
    }

    /** Plans the route's chain for the current facts and creates its executor, unless the active executor already renders that plan. */
    private async buildExecutor(device: GPUDevice, canvasFormat: GPUTextureFormat): Promise<ExecutorBuildResult> {
        let plan: PresentationPlan;
        try {
            plan = planPresentation(this.createPlanRequest(device, canvasFormat));
        } catch (error) {
            return { detail: `plan: ${getErrorMessage(error)}`, kind: 'failed' };
        }
        const planKey = getPlanKey(plan);
        if (this.executor && this.device === device && this.executorPlanKey === planKey) {
            return { kind: 'current' };
        }
        const executorPromise = PresentationExecutor.create(device, plan);
        let executorResult: PresentationExecutor | typeof WEBGPU_RESOURCE_OPERATION_TIMEOUT;
        try {
            executorResult = await waitForWebGPUResourceOperation(executorPromise);
        } catch (error) {
            return { detail: describeExecutorCreationError(error), kind: 'failed' };
        }
        if (executorResult === WEBGPU_RESOURCE_OPERATION_TIMEOUT) {
            void executorPromise.then((lateExecutor: PresentationExecutor): void => {
                lateExecutor.destroy();
            }, (): void => undefined);
            return {
                detail: `executor: timeout after ${microsecondsToMilliseconds(WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS)} ms`,
                kind: 'failed'
            };
        }
        return { executor: executorResult, kind: 'built', plan, planKey };
    }

    /** Returns the plan request of the route's chain: SDR output in the canvas format, and the best-known facts. */
    private createPlanRequest(device: GPUDevice, canvasFormat: GPUTextureFormat): PlanRequest {
        return {
            chain: createBuiltinChain(this.desiredChainConfiguration),
            device: {
                features: device.features,
                maximumTextureDimension: device.limits.maxTextureDimension2D
            },
            facts: this.getPlanFacts(),
            output: createPlannedOutput(false, canvasFormat),
            passes: []
        };
    }

    /** Returns the plan facts the presenter knows: the last measured source and output sizes, 1x1 until a frame measures them. */
    private getPlanFacts(): PlanFacts {
        const layout = this.cachedPresentationLayout;
        return {
            frameRate: null,
            hdrOutput: false,
            hdrSource: isHDRSourceConfiguration(this.desiredChainConfiguration),
            outputHeight: layout ? Math.max(layout.presentation.viewportHeight, UNKNOWN_PLAN_DIMENSION) : UNKNOWN_PLAN_DIMENSION,
            outputWidth: layout ? Math.max(layout.presentation.viewportWidth, UNKNOWN_PLAN_DIMENSION) : UNKNOWN_PLAN_DIMENSION,
            sourceHeight: layout ? Math.max(layout.videoHeight, UNKNOWN_PLAN_DIMENSION) : UNKNOWN_PLAN_DIMENSION,
            sourceWidth: layout ? Math.max(layout.videoWidth, UNKNOWN_PLAN_DIMENSION) : UNKNOWN_PLAN_DIMENSION
        };
    }

    /** Swaps in a new executor: it takes over the render settings and the canvas output, and the old one is destroyed. */
    private installExecutor(executor: PresentationExecutor, plan: PresentationPlan, planKey: string, revision: number): void {
        const previousExecutor = this.executor;
        this.executor = executor;
        this.executorPlan = plan;
        this.executorPlanKey = planKey;
        this.executorRevision = revision;
        this.submissionValidated = false;
        if (this.renderSettingsData) {
            executor.writeRenderSettings(this.renderSettingsData);
        }
        previousExecutor?.destroy();
    }

    private releaseExecutor(): void {
        const executor = this.executor;
        this.executor = null;
        this.executorPlan = null;
        this.executorPlanKey = null;
        this.executorRevision = -1;
        executor?.destroy();
    }

    /** Releases the route's GPU resources, its executor's textures and buffers among them, while the device stays for a later session. */
    private releaseRouteResources(): void {
        this.releaseExecutor();
        this.setDesiredChainConfiguration(EXTERNAL_IDENTITY_CHAIN_CONFIGURATION);
        this.renderSettingsData = null;
    }

    private async initializeDeviceResources(resourceEpoch: number): Promise<boolean> {
        if (!window.isSecureContext) {
            return this.failInitialization('insecure-context', 'isSecureContext false');
        }

        const gpu = navigator.gpu;
        if (!gpu) {
            return this.failInitialization('gpu-unavailable', 'navigator.gpu undefined');
        }

        let adapter: GPUAdapter | null;
        try {
            const adapterResult = await waitForWebGPUResourceOperation(gpu.requestAdapter());
            if (adapterResult === WEBGPU_RESOURCE_OPERATION_TIMEOUT) {
                return this.failInitialization(
                    'adapter-unavailable',
                    `requestAdapter: timeout after ${microsecondsToMilliseconds(WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS)} ms`
                );
            }
            adapter = adapterResult;
        } catch (error) {
            return this.failInitialization('adapter-unavailable', `requestAdapter: ${getErrorMessage(error)}`);
        }

        if (!adapter) {
            return this.failInitialization('adapter-unavailable', 'requestAdapter: null');
        }

        let device: GPUDevice;
        try {
            // A default device stops textures at 8192 texels; the adapter's own maximum takes any larger frame it can
            const devicePromise = adapter.requestDevice({
                requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D }
            });
            const deviceResult = await waitForWebGPUResourceOperation(devicePromise);
            if (deviceResult === WEBGPU_RESOURCE_OPERATION_TIMEOUT) {
                void devicePromise.then((lateDevice: GPUDevice): void => {
                    lateDevice.destroy();
                }, (): void => undefined);
                return this.failInitialization(
                    'device-request-failed',
                    `requestDevice: timeout after ${microsecondsToMilliseconds(WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS)} ms`
                );
            }
            device = deviceResult;
        } catch (error) {
            return this.failInitialization('device-request-failed', `requestDevice: ${getErrorMessage(error)}`);
        }
        if (this.deviceResourceEpoch !== resourceEpoch) {
            device.destroy();
            return false;
        }

        // The device and its first executor are created together, so a device that cannot render is never kept
        const canvasFormat = gpu.getPreferredCanvasFormat();
        const revision = this.planRevision;
        let result: ExecutorBuildResult;
        try {
            result = await this.buildExecutor(device, canvasFormat);
        } catch (error) {
            device.destroy();
            return this.failInitialization('pipeline-creation-failed', `executor: ${getErrorMessage(error)}`);
        }
        if (result.kind !== 'built') {
            device.destroy();
            return this.failInitialization('pipeline-creation-failed', result.kind === 'failed' ? result.detail : 'executor: none built');
        }
        if (this.deviceResourceEpoch !== resourceEpoch) {
            result.executor.destroy();
            device.destroy();
            return false;
        }

        this.canvasFormat = canvasFormat;
        this.device = device;
        this.dynamicHDR10PlusSettingsActive = false;
        this.renderSettingsData = this.settings.mode === 'hdr-to-sdr' ?
            createRenderSettingsUniformData(this.settings).buffer :
            null;
        this.installExecutor(result.executor, result.plan, result.planKey, revision);
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
    }

    private createAndConfigureCanvas(): boolean {
        const surface = this.surface;
        const device = this.device;
        const canvasFormat = this.canvasFormat;
        if (!surface || !device || !canvasFormat) {
            return this.failInitialization('canvas-context-unavailable', `canvas: ${surface ? 'device' : 'surface'} unavailable`);
        }

        if (!this.canvas) {
            const canvas = document.createElement('canvas');
            canvas.classList.add(CANVAS_CLASS);
            canvas.setAttribute('aria-hidden', 'true');

            const canvasContext = canvas.getContext('webgpu');
            if (!canvasContext) {
                return this.failInitialization('canvas-context-unavailable', 'getContext: webgpu null');
            }

            surface.container.appendChild(canvas);
            this.canvas = canvas;
            this.canvasContext = canvasContext;
            this.bindLayoutHandling(surface);
        }

        const canvasContext = this.canvasContext;
        const output = this.executorPlan?.output ?? createPlannedOutput(false, canvasFormat);
        if (!canvasContext) {
            return this.failInitialization('canvas-context-unavailable', 'getContext: webgpu null');
        }
        if (this.configuredDevice === device && plannedOutputsMatch(this.configuredOutput, output)) {
            return true;
        }

        try {
            configurePresentationCanvas(canvasContext, device, output);
            this.configuredDevice = device;
            this.configuredOutput = output;
            return true;
        } catch (error) {
            return this.failInitialization('canvas-configuration-failed', `configure: ${getErrorMessage(error)}`);
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
            this.fallback(generation, 'request-video-frame-callback-unavailable', 'requestVideoFrameCallback undefined');
            return;
        }

        let callbackId = 0;
        try {
            callbackId = video.requestVideoFrameCallback((callbackTimeMilliseconds, metadata) => {
                this.handleVideoFrame(video, generation, callbackId, callbackTimeMilliseconds, metadata);
            });
        } catch (error) {
            this.fallback(generation, 'request-video-frame-callback-unavailable', `requestVideoFrameCallback: ${getErrorMessage(error)}`);
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
            this.fallback(generation, 'frame-render-failed', `frame-callback-time: ${getErrorMessage(error)}`);
            return;
        }

        try {
            const submission = this.renderFrameCallbackSource(video, generation, {
                durationMicroseconds: null,
                newFrame: true,
                timestampMicroseconds: mediaTimeMicroseconds,
                videoEpoch: null
            });
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
            this.fallback(generation, 'frame-import-failed', getErrorMessage(error));
        }
    }

    private renderFrameCallbackSource(video: HTMLVideoElement, generation: number, timing: FrameTiming): FrameSubmission | null {
        if (this.activeInputMode !== 'external-texture') {
            this.fallback(generation, 'decoded-frame-color-mismatch', `input-mode: ${this.activeInputMode}, expected external-texture`);
            return null;
        }
        return this.submitFrame({ kind: 'external', source: video }, video.videoWidth, video.videoHeight, timing);
    }

    private renderDecodedVideoFrame(
        decodedFrame: DecodedVideoPresentationFrame,
        generation: number
    ): FrameSubmission | null {
        const frame = decodedFrame.frame;
        switch (this.activeInputMode) {
            case 'external-texture': {
                const metadata = this.activeInputColorMetadata;
                const colorFailure = metadata ? getDecodedFrameColorFailure(frame, metadata) : null;
                if (colorFailure !== null) {
                    this.fallback(generation, 'decoded-frame-color-mismatch', colorFailure);
                    return null;
                }
                break;
            }
            case 'external-dolby-vision': {
                const executor = this.executor;
                const profile = this.activeDolbyVisionProfile;
                const frameFailure = (profile === 5 ? null : `profile: ${profile}, expected 5`)
                    ?? getNeutralBT709FrameColorFailure(frame)
                    ?? prefixFailure('authorization', this.getActiveExternalDolbyVisionAuthorizationFailure());
                if (frameFailure !== null || !executor) {
                    this.fallback(generation, 'decoded-frame-color-mismatch', frameFailure ?? 'executor: unavailable');
                    return null;
                }
                const rpu = getSingleLayerDolbyVisionRPUData(
                    decodedFrame.encodedDolbyVisionMetadata,
                    EXTERNAL_DOLBY_VISION_BASE_LAYER_BIT_DEPTH
                );
                if (rpu.failure !== null) {
                    this.fallback(generation, 'dolby-vision-metadata-invalid', rpu.failure);
                    return null;
                }
                executor.writeDolbyVisionRPU(rpu.data);
                break;
            }
            case 'external-hdr': {
                const metadata = this.activeInputColorMetadata;
                const frameFailure = metadata ?
                    getNeutralBT709FrameColorFailure(frame)
                        ?? prefixFailure('authorization', this.getActiveExternalHDRAuthorizationFailure(metadata)) :
                    'metadata: none configured';
                if (frameFailure !== null) {
                    this.fallback(generation, 'decoded-frame-color-mismatch', frameFailure);
                    return null;
                }
                break;
            }
            case 'raw-dolby-vision':
            case 'raw-yuv':
                this.fallback(generation, 'decoded-frame-color-mismatch', `input-mode: ${this.activeInputMode} takes raw planes, not a VideoFrame`);
                return null;
        }

        const frameWidth = frame.displayWidth || frame.codedWidth;
        const frameHeight = frame.displayHeight || frame.codedHeight;
        return this.submitFrame({ kind: 'external', source: frame }, frameWidth, frameHeight, getDecodedFrameTiming(decodedFrame));
    }

    private renderDecodedRawFrame(
        decodedFrame: DecodedRawPresentationFrame,
        generation: number
    ): FrameSubmission | null {
        const format = this.activeRawFrameFormat;
        if (!format) {
            this.fallback(generation, 'decoded-frame-color-mismatch', 'raw-format: none configured');
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
                this.fallback(generation, 'decoded-frame-color-mismatch', `input-mode: ${this.activeInputMode} takes a VideoFrame, not raw planes`);
                return null;
        }
    }

    private renderDecodedRawYUVFrame(
        decodedFrame: DecodedRawPresentationFrame,
        generation: number,
        format: SupportedRawVideoFrameFormat
    ): FrameSubmission | null {
        const inputColorMetadata = this.activeInputColorMetadata;
        const frameFailure = inputColorMetadata ?
            prefixFailure('authorization', this.getRawHDRAuthorizationFailure(inputColorMetadata, format))
                ?? getRawFrameDescriptorFailure(decodedFrame, inputColorMetadata, format) :
            'metadata: none configured';
        if (frameFailure !== null) {
            this.fallback(generation, 'decoded-frame-color-mismatch', frameFailure);
            return null;
        }
        const frame = decodedFrame.frame;
        return this.submitFrame(
            { enhancementFrame: null, frame, kind: 'planes' },
            frame.displayWidth,
            frame.displayHeight,
            getDecodedFrameTiming(decodedFrame)
        );
    }

    private renderDecodedRawDolbyVisionFrame(
        decodedFrame: DecodedRawPresentationFrame,
        generation: number,
        format: SupportedRawVideoFrameFormat
    ): FrameSubmission | null {
        const executor = this.executor;
        const profile = this.activeDolbyVisionProfile;
        const singleLayerEnhancementFailure = profile !== null
            && !isDolbyVisionDualLayerProfile(profile)
            && decodedFrame.enhancementFrame !== undefined ?
            `enhancement-layer: profile ${profile} carries none` :
            null;
        const frameFailure = prefixFailure('authorization', this.getActiveRawDolbyVisionAuthorizationFailure(format, profile))
            ?? getRawDolbyVisionFrameDescriptorFailure(decodedFrame, format)
            ?? getRawDolbyVisionEnhancementFrameFailure(decodedFrame)
            ?? singleLayerEnhancementFailure;
        if (frameFailure !== null || !executor || profile === null) {
            this.fallback(generation, 'decoded-frame-color-mismatch', frameFailure ?? 'executor: unavailable');
            return null;
        }

        let packedRPUData: ArrayBuffer;
        let dualLayerRPUData: DualLayerDolbyVisionRPUData | null = null;
        switch (profile) {
            case 5:
            case 8: {
                const rpu = getSingleLayerDolbyVisionRPUData(
                    decodedFrame.encodedDolbyVisionMetadata,
                    decodedFrame.frame.bitDepth
                );
                if (rpu.failure !== null) {
                    this.fallback(generation, 'dolby-vision-metadata-invalid', rpu.failure);
                    return null;
                }
                packedRPUData = rpu.data;
                break;
            }
            case 4:
            case 7: {
                const rpu = getDualLayerDolbyVisionRPUData(
                    decodedFrame.encodedDolbyVisionMetadata,
                    profile,
                    decodedFrame.frame.bitDepth,
                    Boolean(decodedFrame.enhancementFrame)
                );
                if (rpu.failure !== null) {
                    this.fallback(generation, 'dolby-vision-metadata-invalid', rpu.failure);
                    return null;
                }
                dualLayerRPUData = rpu.data;
                packedRPUData = rpu.data.packedRPUData;
                break;
            }
        }

        executor.writeDolbyVisionRPU(packedRPUData);
        const enhancementFrame = getComposedEnhancementFrame(
            dualLayerRPUData,
            this.activeDolbyVisionFELReconstruction,
            decodedFrame.enhancementFrame
        );
        const frame = decodedFrame.frame;
        const submission = this.submitFrame(
            { enhancementFrame, frame, kind: 'planes' },
            frame.displayWidth,
            frame.displayHeight,
            getDecodedFrameTiming(decodedFrame)
        );
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
            && this.executor !== null;
    }

    /**
     * Records one frame through the executor into the canvas and submits it once.
     * A new frame that does not follow the previous one in time first starts history over.
     */
    private submitFrame(
        source: PresentationFrameSource,
        sourceWidth: number,
        sourceHeight: number,
        timing: FrameTiming
    ): FrameSubmission | null {
        const surface = this.surface;
        const canvas = this.canvas;
        const canvasContext = this.canvasContext;
        const device = this.device;
        const executor = this.executor;
        if (!surface || !canvas || !canvasContext || !device || !executor) {
            throw new Error('presentation-resources: incomplete');
        }
        if (isExternalInputMode(this.activeInputMode) !== (source.kind === 'external')) {
            throw new Error(`source: ${source.kind} frame for input mode ${this.activeInputMode}`);
        }

        const layout = this.getPresentationLayout(surface, canvas, device, sourceWidth, sourceHeight);
        if (!layout) {
            return null;
        }

        if (timing.newFrame) {
            this.resetHistoryOnDiscontinuity(executor, timing);
        }
        const validateSubmission = !this.submissionValidated;
        if (validateSubmission) {
            device.pushErrorScope(VALIDATION_ERROR_FILTER);
        }

        try {
            const commandEncoder = device.createCommandEncoder();
            executor.encode(commandEncoder, {
                geometry: layout.presentation,
                newFrame: timing.newFrame,
                skippedFrameCount: 0,
                source,
                target: canvasContext.getCurrentTexture().createView(),
                timestampMicroseconds: timing.timestampMicroseconds
            });
            device.queue.submit([ commandEncoder.finish() ]);
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

    /** Starts history over before a new frame whose epoch changed, whose timestamp went back, or that jumped past 2.5 frame durations. */
    private resetHistoryOnDiscontinuity(executor: PresentationExecutor, timing: FrameTiming): void {
        const previousFrame = this.lastNewFrame;
        const elapsedMicroseconds = previousFrame ? timing.timestampMicroseconds - previousFrame.timestampMicroseconds : null;
        // A frame without its own duration takes the interval since the previous frame as one
        const durationMicroseconds = timing.durationMicroseconds
            ?? (elapsedMicroseconds !== null && elapsedMicroseconds > 0 ? elapsedMicroseconds : null);
        this.lastNewFrame = {
            durationMicroseconds,
            timestampMicroseconds: timing.timestampMicroseconds,
            videoEpoch: timing.videoEpoch
        };
        if (!previousFrame || elapsedMicroseconds === null) {
            return;
        }
        const epochChanged = timing.videoEpoch !== null
            && previousFrame.videoEpoch !== null
            && timing.videoEpoch !== previousFrame.videoEpoch;
        const previousDuration = previousFrame.durationMicroseconds;
        const jumped = previousDuration !== null
            && previousDuration > 0
            && elapsedMicroseconds > HISTORY_DISCONTINUITY_FRAME_DURATIONS * previousDuration;
        if (epochChanged || elapsedMicroseconds < 0 || jumped) {
            executor.resetHistory();
        }
    }

    /** Starts temporal history over for a seek or a new generation; the next frame follows nothing. */
    private resetPresentationHistory(): void {
        this.lastNewFrame = null;
        this.executor?.resetHistory();
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
        switch (submission.dolbyVisionDualLayerMode) {
            case 'fel':
                this.telemetry.dolbyVisionDualLayerFELPresentedFrameCount += 1;
                break;
            case 'fel-base-fallback':
                this.telemetry.dolbyVisionDualLayerFELBaseFallbackPresentedFrameCount += 1;
                break;
            case 'mel':
                this.telemetry.dolbyVisionDualLayerMELPresentedFrameCount += 1;
                break;
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
                console.warn(`frame-completion-handler: ${getErrorMessage(error)}`);
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
            this.fallback(pendingValidation.generation, 'frame-render-failed', `validation-scope: ${getErrorMessage(error)}`);
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
            this.fallback(
                pendingValidation.generation,
                'frame-render-failed',
                `validation: timeout after ${microsecondsToMilliseconds(WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS)} ms`
            );
            return;
        }

        if (validationResult) {
            this.fallback(pendingValidation.generation, 'frame-render-failed', `validation: ${validationResult.message}`);
            return;
        }

        this.submissionValidated = true;
        this.markCanvasPresented();
        validatedHandler();
    }

    private markCanvasPresented(): void {
        this.canvas?.classList.add(CANVAS_VISIBLE_CLASS);
        this.telemetry.state = 'presenting';
    }

    private discardErrorScope(device: GPUDevice): void {
        let discardedScope: Promise<GPUError | null>;
        // popErrorScope can also fail synchronously when the scope stack is unavailable
        // eslint-disable-next-line sonarjs/no-try-promise
        try {
            discardedScope = device.popErrorScope();
        } catch (error) {
            console.warn(`validation-scope-discard: ${getErrorMessage(error)}`);
            return;
        }

        void discardedScope.catch(error => {
            console.warn(`validation-scope-discard: ${getErrorMessage(error)}`);
        });
    }

    private synchronizeCanvasGeometry(
        surface: PresentationSurface,
        canvas: HTMLCanvasElement,
        device: GPUDevice,
        devicePixelRatio: number
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

        const maximumDimension = device.limits.maxTextureDimension2D;
        const backingScale = Math.min(
            devicePixelRatio,
            maximumDimension / canvasWidth,
            maximumDimension / canvasHeight
        );
        const backingWidth = Math.max(MIN_CANVAS_DIMENSION, Math.round(canvasWidth * backingScale));
        const backingHeight = Math.max(MIN_CANVAS_DIMENSION, Math.round(canvasHeight * backingScale));

        if (canvas.width !== backingWidth) {
            canvas.width = backingWidth;
        }
        if (canvas.height !== backingHeight) {
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
        const geometry = this.synchronizeCanvasGeometry(surface, canvas, device, devicePixelRatio);
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
    }

    private readonly handleLayoutInvalidation = (): void => {
        if (!this.sessionActive || this.fallbackLatched) {
            return;
        }

        if (!this.resynchronizeCachedPresentationLayout()) {
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

    /** Redraws the video element's current frame for a layout change; a redraw repeats the last frame's history. */
    private renderCurrentFrameOrFallback(generation: number): void {
        const video = this.surface?.video;
        if (
            !this.isCurrent(generation)
            || this.activeInputMode !== 'external-texture'
            || !video
            || video.readyState < VIDEO_READY_STATE_CURRENT_DATA
            || !this.hasReadyPresentationResources()
            || this.pendingSubmissionValidation
        ) {
            return;
        }

        this.cancelFrameCallback();
        try {
            const submission = this.submitFrame({ kind: 'external', source: video }, video.videoWidth, video.videoHeight, {
                durationMicroseconds: null,
                newFrame: false,
                timestampMicroseconds: this.lastNewFrame?.timestampMicroseconds ?? 0,
                videoEpoch: null
            });
            if (!submission) {
                this.scheduleFrameCallback(generation);
                return;
            }

            this.completeSubmission(submission, generation, () => {
                this.scheduleFrameCallback(generation);
            });
        } catch (error) {
            this.fallback(generation, 'frame-render-failed', `redraw: ${getErrorMessage(error)}`);
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
            console.warn(`frame-callback-cancel: ${getErrorMessage(error)}`);
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
            console.warn(`canvas-unconfigure: ${getErrorMessage(error)}`);
        }
        this.canvas?.remove();
        this.canvas = null;
        this.canvasContext = null;
        this.cachedPresentationLayout = null;
        this.invalidatePresentationLayout();
        this.configuredDevice = null;
        this.configuredOutput = null;
    }

    private async handleDeviceLoss(lostDevice: GPUDevice, deviceLostInfo: GPUDeviceLostInfo): Promise<void> {
        if (this.device !== lostDevice) {
            return;
        }

        console.warn(`device-lost: ${deviceLostInfo.reason}: ${deviceLostInfo.message}`);
        this.deviceResourceEpoch += 1;
        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.unbindLayoutHandling();
        this.removeCanvas();
        this.releaseExecutor();
        this.device = null;
        this.planRevision += 1;
        this.dynamicHDR10PlusSettingsActive = false;
        this.submissionValidated = false;

        const generation = this.activeGeneration;
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }
        this.telemetry.state = 'initializing';

        if (this.deviceRecoveryAttempts >= MAX_DEVICE_RECOVERY_ATTEMPTS) {
            this.fallback(generation, 'device-recovery-failed', `recovery: ${this.deviceRecoveryAttempts} of ${MAX_DEVICE_RECOVERY_ATTEMPTS} attempts used`);
            return;
        }

        this.deviceRecoveryAttempts += 1;
        this.telemetry.deviceRecoveryCount = this.deviceRecoveryAttempts;
        const recovered = await this.ensureDevice();
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }

        if (!recovered) {
            this.fallback(generation, 'device-recovery-failed', `device: ${this.initializationFailureReason}: ${this.initializationFailureDetail}`);
            return;
        }

        let reauthorizationFailure: string | null = null;
        switch (this.activeInputMode) {
            case 'external-texture':
                break;
            case 'external-hdr':
                reauthorizationFailure = await this.reauthorizeExternalHDRPresentation(generation);
                break;
            case 'external-dolby-vision':
            case 'raw-dolby-vision':
                reauthorizationFailure = await this.reauthorizeDolbyVisionPresentation(generation);
                break;
            case 'raw-yuv':
                reauthorizationFailure = await this.reauthorizeRawHDRPresentation(generation);
                break;
        }
        if (reauthorizationFailure !== null) {
            if (this.isCurrent(generation) && !this.fallbackLatched) {
                this.fallback(generation, 'device-recovery-failed', `reauthorization: ${reauthorizationFailure}`);
            }
            return;
        }

        if (this.pendingColorConfiguration?.generation === generation) {
            return;
        }

        if (!this.createAndConfigureCanvas()) {
            this.fallback(generation, 'device-recovery-failed', `${this.initializationFailureReason}: ${this.initializationFailureDetail}`);
            return;
        }

        if (this.decodedFramePushActive) {
            this.requestDecodedPresentationRefresh(generation);
        } else {
            this.scheduleFrameCallback(generation);
        }
    }

    /** Returns whether a reauthorization still answers the session: the same generation, without a fallback, on the same device. */
    private isReauthorizationCurrent(generation: number, device: GPUDevice): boolean {
        return this.isCurrent(generation) && !this.fallbackLatched && this.device === device;
    }

    /** Probes the active raw route on the replacement device; returns why it is not authorized, or null. */
    private async reauthorizeRawHDRPresentation(generation: number): Promise<string | null> {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        const metadata = this.activeInputColorMetadata;
        const rawFrameFormat = this.activeRawFrameFormat;
        if (!device || !targetFormat || !metadata || !rawFrameFormat) {
            return 'route: incomplete';
        }
        if (this.settings.mode !== 'hdr-to-sdr') {
            return `mode: ${this.settings.mode}, expected hdr-to-sdr`;
        }
        const routeKey = getRawHDRAuthorizationRouteKey(rawFrameFormat, metadata);
        if (routeKey) {
            await this.rawHDRAuthorization.authorize(device, targetFormat, routeKey);
        }
        return this.isReauthorizationCurrent(generation, device) ?
            this.rawHDRAuthorization.getAuthorizationFailure(device, targetFormat, metadata, rawFrameFormat) :
            'superseded';
    }

    /** Probes the active external HDR route on the replacement device; returns why it is not authorized, or null. */
    private async reauthorizeExternalHDRPresentation(generation: number): Promise<string | null> {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        const metadata = this.activeInputColorMetadata;
        if (!device || !targetFormat || !metadata) {
            return 'route: incomplete';
        }
        if (this.settings.mode !== 'hdr-to-sdr') {
            return `mode: ${this.settings.mode}, expected hdr-to-sdr`;
        }
        const routeKey = getExternalHDRAuthorizationRouteKey(metadata);
        if (routeKey) {
            await this.externalHDRAuthorization.authorize(device, targetFormat, routeKey);
        }
        return this.isReauthorizationCurrent(generation, device) ?
            this.externalHDRAuthorization.getAuthorizationFailure(device, targetFormat, metadata) :
            'superseded';
    }

    /** Probes the active Dolby Vision route, and its FEL route while FEL reconstructs, on the replacement device; returns why it is not authorized, or null. */
    private async reauthorizeDolbyVisionPresentation(generation: number): Promise<string | null> {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (!device || !targetFormat) {
            return 'device: unavailable';
        }
        if (this.settings.mode !== 'hdr-to-sdr') {
            return `mode: ${this.settings.mode}, expected hdr-to-sdr`;
        }
        if (this.activeInputMode === 'external-dolby-vision') {
            await this.externalDolbyVisionAuthorization.authorize(device, targetFormat);
            return this.isReauthorizationCurrent(generation, device) ?
                this.externalDolbyVisionAuthorization.getAuthorizationFailure(device, targetFormat) :
                'superseded';
        }
        const rawFrameFormat = this.activeRawFrameFormat;
        const activeProfile = this.activeDolbyVisionProfile;
        if (!rawFrameFormat || !isRawDolbyVisionVideoFrameFormat(rawFrameFormat) || activeProfile === null) {
            return 'route: incomplete';
        }
        const rawAuthorizations = this.getRawDolbyVisionAuthorizations(activeProfile, rawFrameFormat);
        await rawAuthorizations.base.authorize(device, targetFormat);
        if (!this.isReauthorizationCurrent(generation, device)) {
            return 'superseded';
        }
        const baseFailure = rawAuthorizations.base.getAuthorizationFailure(device, targetFormat, rawFrameFormat);
        const felAuthorization = this.activeDolbyVisionFELReconstruction ? rawAuthorizations.fel : null;
        if (baseFailure !== null || !felAuthorization) {
            return baseFailure;
        }
        await felAuthorization.authorize(device, targetFormat);
        return this.isReauthorizationCurrent(generation, device) ?
            felAuthorization.getAuthorizationFailure(device, targetFormat, rawFrameFormat) :
            'superseded';
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
        this.fallback(generation, 'frame-render-failed', `uncaptured: ${event.error.message}`);
    }

    private fallback(generation: number, reason: PresentationFallbackReason, detail: string): void {
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }

        this.fallbackLatched = true;
        this.colorConfigurationRevision += 1;
        this.pendingColorConfiguration = null;
        this.telemetry.fallbackDetail = detail;
        this.telemetry.fallbackReason = reason;
        this.telemetry.state = 'fallback';
        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.unbindLayoutHandling();
        this.removeCanvas();
        this.releaseRouteResources();
        this.decodedFramePushActive = false;
        this.activeInputColorMetadata = null;
        this.activeDolbyVisionProfile = null;
        this.activeDolbyVisionFELReconstruction = false;
        this.activeInputMode = 'external-texture';
        this.activeRawFrameFormat = null;
        this.surface = null;
        console.warn(`${reason}: ${detail}`);
        this.fallbackHandler(generation, reason, detail);
    }

    private isCurrent(generation: number): boolean {
        return this.sessionActive && this.activeGeneration === generation;
    }
}
