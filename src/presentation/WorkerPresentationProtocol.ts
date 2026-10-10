// The channel between the main-thread presenter and the renderer in the decode worker
// The main thread selects each frame and lays out the canvas; the renderer, which holds the frames, draws them into the transferred canvas with its own GPU device

import { assertValidInputColorMetadata, type InputColorMetadata } from '../color/ColorMetadata';
import type { HDR10PlusFrameMetadataStatus } from '../video/hdr/HDR10PlusMetadata';
import type { SupportedRawVideoFrameFormat } from '../video/RawVideoFrameCopy';
import type { TexturePresentationGeometry } from './PresentationGeometry';
import type { DolbyVisionReconstructionProfile } from './PresentationInput';
import {
    assertValidRenderSettings,
    type HDRToSDRRenderSettings,
    type RenderSettings
} from './RenderSettings';

// Bounds a generated shader; the largest, Profile 7 FEL reconstruction, is far smaller
export const MAXIMUM_WORKER_PRESENTATION_SHADER_CODE_LENGTH = 4 * 1024 * 1024;

/** Why presentation leaves WebGPU for the HTML player, on the main thread or in the worker renderer. */
export const PRESENTATION_FALLBACK_REASONS = Object.freeze([
    'adapter-unavailable',
    'canvas-context-unavailable',
    'canvas-configuration-failed',
    'device-recovery-failed',
    'device-request-failed',
    'decoded-frame-color-mismatch',
    'dolby-vision-metadata-invalid',
    'frame-import-failed',
    'frame-render-failed',
    'gpu-unavailable',
    'hdr-authorization-unavailable',
    'hdr-color-configuration-invalid',
    'hdr-tone-mapping-disabled',
    'insecure-context',
    'pipeline-creation-failed',
    'request-video-frame-callback-unavailable'
] as const);

export type PresentationFallbackReason = typeof PRESENTATION_FALLBACK_REASONS[number];

/** How a configured pipeline takes its frames: as external textures, or as raw YUV planes in integer textures. */
export const WORKER_PRESENTATION_INPUT_MODES = Object.freeze([
    'external-dolby-vision',
    'external-hdr',
    'external-texture',
    'raw-dolby-vision',
    'raw-yuv'
] as const);

export type WorkerPresentationInputMode = typeof WORKER_PRESENTATION_INPUT_MODES[number];

/**
 * The canvas a presenter transferred and the renderer's end of the presenter's channel.
 * A decode worker takes one attachment for its life; a replaced worker gets a new one, because a canvas transfers only once.
 */
export type WorkerPresentationAttachment = {
    canvas: OffscreenCanvas
    port: MessagePort
};

/** Supplies a new attachment for each decode worker, or null when the page cannot present in a worker. */
export type WorkerPresentationRendererProvider = () => WorkerPresentationAttachment | null;

/**
 * Installs the pipeline the main thread prepared and authorized on its own device.
 * The renderer answers `configured` with the same revision; frames present only after an accepted configure.
 */
export type WorkerPresentationConfigureRequest = {
    automaticInputPeakNits: boolean
    /** Selects the FEL residual shader of a Profile 4 or 7 route, whose authorization the main thread checked */
    dolbyVisionFELReconstruction: boolean
    dolbyVisionProfile: DolbyVisionReconstructionProfile | null
    /** The color the frames must carry; null on an identity or Dolby Vision route, which checks none */
    inputColorMetadata: InputColorMetadata | null
    inputMode: WorkerPresentationInputMode
    rawFrameFormat: SupportedRawVideoFrameFormat | null
    /** Increases with every configure; settings and the answer carry it */
    revision: number
    settings: RenderSettings
    shaderCode: string
    type: 'configure'
};

/** Replaces the live HDR-to-SDR controls of the configure with the same revision, without rebuilding its shader. */
export type WorkerPresentationSettingsRequest = {
    automaticInputPeakNits: boolean
    revision: number
    settings: HDRToSDRRenderSettings
    type: 'settings'
};

/** Where frames draw: the canvas backing size in device pixels and the viewport and texture transform within it. */
export type WorkerPresentationLayout = {
    backingHeight: number
    backingWidth: number
    presentation: TexturePresentationGeometry
    /** Increases with every layout; each present names the layout it was selected for */
    revision: number
};

export type WorkerPresentationLayoutRequest = WorkerPresentationLayout & {
    type: 'layout'
};

/**
 * Draws one frame the decode worker holds, which the main thread selected.
 * The renderer answers `presented` once the frame's GPU work has completed or failed, so the frame's credit returns only then.
 */
export type WorkerPresentationPresentRequest = {
    frameId: number
    /** The decode generation whose run posted the frame's descriptor */
    generation: number
    layoutRevision: number
    type: 'present'
};

/** Ends the attachment: the renderer releases its device and canvas and answers nothing more. */
export type WorkerPresentationDetachRequest = {
    type: 'detach'
};

export type WorkerPresentationRequest =
    | WorkerPresentationConfigureRequest
    | WorkerPresentationDetachRequest
    | WorkerPresentationLayoutRequest
    | WorkerPresentationPresentRequest
    | WorkerPresentationSettingsRequest;

/** Reports once whether the renderer has its device and canvas context. */
export type WorkerPresentationStatusResponse = {
    /** Why the renderer is unavailable; null when it is ready */
    reason: PresentationFallbackReason | null
    state: 'ready' | 'unavailable'
    type: 'status'
};

/** Answers a configure; a refused one names the fallback the presenter takes. */
export type WorkerPresentationConfiguredResponse = {
    ok: boolean
    reason: PresentationFallbackReason | null
    revision: number
    type: 'configured'
};

/** Which layers a Profile 4 or 7 frame presented, as the presenter's dual-layer counters record it. */
export type WorkerPresentationDolbyVisionDualLayerMode = 'fel' | 'fel-base-fallback' | 'mel';

/** How a frame's HDR10+ metadata drove its tone mapping on an HDR-to-SDR route. */
export type WorkerPresentationHDR10PlusResult = {
    /** The dynamic input peak the frame applied, its own or carried; null when it tone-mapped statically */
    inputPeakNits: number | null
    metadataStatus: HDR10PlusFrameMetadataStatus
};

/**
 * Answers a present once its GPU work completed or failed.
 * A frame that did not present, such as one the run already released, answers `ok` false, and its selection is discarded.
 */
export type WorkerPresentationPresentedResponse = {
    dolbyVisionDualLayerMode: WorkerPresentationDolbyVisionDualLayerMode | null
    frameId: number
    generation: number
    gpuWorkCompleted: boolean
    /** Null outside an HDR-to-SDR route, where HDR10+ does not apply */
    HDR10PlusResult: WorkerPresentationHDR10PlusResult | null
    ok: boolean
    type: 'presented'
};

/** Reports a renderer failure, such as an unrecovered device loss; the presenter falls back as it does for its own. */
export type WorkerPresentationFailedResponse = {
    reason: PresentationFallbackReason
    type: 'failed'
};

export type WorkerPresentationResponse =
    | WorkerPresentationConfiguredResponse
    | WorkerPresentationFailedResponse
    | WorkerPresentationPresentedResponse
    | WorkerPresentationStatusResponse;

const PRESENTATION_FALLBACK_REASON_SET: ReadonlySet<unknown> = new Set<unknown>(PRESENTATION_FALLBACK_REASONS);
const WORKER_PRESENTATION_INPUT_MODE_SET: ReadonlySet<unknown> = new Set<unknown>(WORKER_PRESENTATION_INPUT_MODES);

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function isRevision(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) > 0;
}

function isFrameId(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveDimension(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) > 0;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** Validates a fallback reason that crossed a worker boundary. */
export function isPresentationFallbackReason(value: unknown): value is PresentationFallbackReason {
    return PRESENTATION_FALLBACK_REASON_SET.has(value);
}

function isWorkerPresentationInputMode(value: unknown): value is WorkerPresentationInputMode {
    return WORKER_PRESENTATION_INPUT_MODE_SET.has(value);
}

function isDolbyVisionReconstructionProfile(value: unknown): value is DolbyVisionReconstructionProfile {
    return value === 4 || value === 5 || value === 7 || value === 8;
}

function isSupportedRawVideoFrameFormat(value: unknown): value is SupportedRawVideoFrameFormat {
    switch (value) {
        case 'I420':
        case 'I420P10':
        case 'I420P12':
        case 'I422':
        case 'I422P10':
        case 'I422P12':
        case 'I444':
        case 'I444P10':
        case 'I444P12':
        case 'NV12':
            return true;
        default:
            return false;
    }
}

function isRenderSettings(value: unknown): value is RenderSettings {
    if (!isRecord(value)) {
        return false;
    }
    try {
        assertValidRenderSettings(value as RenderSettings);
        return true;
    } catch {
        return false;
    }
}

function isInputColorMetadata(value: unknown): value is InputColorMetadata {
    if (!isRecord(value)) {
        return false;
    }
    try {
        assertValidInputColorMetadata(value as InputColorMetadata);
        return true;
    } catch {
        return false;
    }
}

/** Validates an HDR10+ status that crossed a worker boundary without its metadata. */
export function isHDR10PlusFrameMetadataStatus(value: unknown): value is HDR10PlusFrameMetadataStatus {
    switch (value) {
        case 'absent':
        case 'conflicting':
        case 'malformed':
        case 'unsupported':
        case 'valid':
            return true;
        default:
            return false;
    }
}

function isTexturePresentationGeometry(value: unknown): value is TexturePresentationGeometry {
    return isRecord(value)
        && isFiniteNumber(value.textureOffsetX)
        && isFiniteNumber(value.textureOffsetY)
        && isFiniteNumber(value.textureScaleX)
        && isFiniteNumber(value.textureScaleY)
        && isFiniteNumber(value.viewportX)
        && isFiniteNumber(value.viewportY)
        && isFiniteNumber(value.viewportWidth)
        && isFiniteNumber(value.viewportHeight)
        && value.viewportWidth > 0
        && value.viewportHeight > 0;
}

/**
 * Accepts only the input mode and parameter combinations the presenter prepares.
 * Raw routes name their plane format, Dolby Vision routes their profile, and color-checked routes their metadata.
 */
function hasConsistentConfigureRoute(value: Record<string, unknown>, settings: RenderSettings): boolean {
    const rawFrameFormat = value.rawFrameFormat;
    const dolbyVisionProfile = value.dolbyVisionProfile;
    const reconstructsFEL = value.dolbyVisionFELReconstruction === true;
    switch (value.inputMode) {
        case 'external-texture':
            return rawFrameFormat === null && dolbyVisionProfile === null && !reconstructsFEL;
        case 'external-hdr':
            return value.inputColorMetadata !== null
                && rawFrameFormat === null
                && dolbyVisionProfile === null
                && !reconstructsFEL
                && settings.mode === 'hdr-to-sdr';
        case 'external-dolby-vision':
            return dolbyVisionProfile === 5
                && rawFrameFormat === null
                && !reconstructsFEL
                && settings.mode === 'hdr-to-sdr';
        case 'raw-yuv':
            return value.inputColorMetadata !== null
                && rawFrameFormat !== null
                && dolbyVisionProfile === null
                && !reconstructsFEL;
        case 'raw-dolby-vision':
            // Dolby Vision reconstructs any planar format, never the semi-planar NV12
            return dolbyVisionProfile !== null
                && rawFrameFormat !== null
                && rawFrameFormat !== 'NV12'
                && settings.mode === 'hdr-to-sdr'
                && (!reconstructsFEL || dolbyVisionProfile === 4 || dolbyVisionProfile === 7);
        default:
            return false;
    }
}

function isConfigureRequest(value: Record<string, unknown>): boolean {
    if (
        !isRevision(value.revision)
        || !isWorkerPresentationInputMode(value.inputMode)
        || typeof value.shaderCode !== 'string'
        || value.shaderCode.length === 0
        || value.shaderCode.length > MAXIMUM_WORKER_PRESENTATION_SHADER_CODE_LENGTH
        || typeof value.automaticInputPeakNits !== 'boolean'
        || typeof value.dolbyVisionFELReconstruction !== 'boolean'
        || (value.dolbyVisionProfile !== null && !isDolbyVisionReconstructionProfile(value.dolbyVisionProfile))
        || (value.rawFrameFormat !== null && !isSupportedRawVideoFrameFormat(value.rawFrameFormat))
        || (value.inputColorMetadata !== null && !isInputColorMetadata(value.inputColorMetadata))
        || !isRenderSettings(value.settings)
    ) {
        return false;
    }
    return hasConsistentConfigureRoute(value, value.settings);
}

function isSettingsRequest(value: Record<string, unknown>): boolean {
    return isRevision(value.revision)
        && typeof value.automaticInputPeakNits === 'boolean'
        && isRenderSettings(value.settings)
        && value.settings.mode === 'hdr-to-sdr';
}

function isLayoutRequest(value: Record<string, unknown>): boolean {
    return isRevision(value.revision)
        && isPositiveDimension(value.backingWidth)
        && isPositiveDimension(value.backingHeight)
        && isTexturePresentationGeometry(value.presentation);
}

function isPresentRequest(value: Record<string, unknown>): boolean {
    return isRevision(value.generation)
        && isFrameId(value.frameId)
        && isRevision(value.layoutRevision);
}

/** Validates a message before the renderer acts on it. */
export function isWorkerPresentationRequest(value: unknown): value is WorkerPresentationRequest {
    if (!isRecord(value)) {
        return false;
    }
    switch (value.type) {
        case 'configure':
            return isConfigureRequest(value);
        case 'settings':
            return isSettingsRequest(value);
        case 'layout':
            return isLayoutRequest(value);
        case 'present':
            return isPresentRequest(value);
        case 'detach':
            return true;
        default:
            return false;
    }
}

function isStatusResponse(value: Record<string, unknown>): boolean {
    switch (value.state) {
        case 'ready':
            return value.reason === null;
        case 'unavailable':
            return isPresentationFallbackReason(value.reason);
        default:
            return false;
    }
}

function isConfiguredResponse(value: Record<string, unknown>): boolean {
    if (!isRevision(value.revision) || typeof value.ok !== 'boolean') {
        return false;
    }
    return value.ok ? value.reason === null : isPresentationFallbackReason(value.reason);
}

function isHDR10PlusResult(value: unknown): value is WorkerPresentationHDR10PlusResult {
    return isRecord(value)
        && isHDR10PlusFrameMetadataStatus(value.metadataStatus)
        && (value.inputPeakNits === null || (isFiniteNumber(value.inputPeakNits) && value.inputPeakNits > 0));
}

function isDolbyVisionDualLayerMode(value: unknown): value is WorkerPresentationDolbyVisionDualLayerMode {
    return value === 'fel' || value === 'fel-base-fallback' || value === 'mel';
}

function isPresentedResponse(value: Record<string, unknown>): boolean {
    return isRevision(value.generation)
        && isFrameId(value.frameId)
        && typeof value.ok === 'boolean'
        && typeof value.gpuWorkCompleted === 'boolean'
        // A frame that did not present has no GPU work to complete
        && (value.ok || !value.gpuWorkCompleted)
        && (value.dolbyVisionDualLayerMode === null || isDolbyVisionDualLayerMode(value.dolbyVisionDualLayerMode))
        && (value.HDR10PlusResult === null || isHDR10PlusResult(value.HDR10PlusResult));
}

/** Validates a renderer message before it touches the presenter. */
export function isWorkerPresentationResponse(value: unknown): value is WorkerPresentationResponse {
    if (!isRecord(value)) {
        return false;
    }
    switch (value.type) {
        case 'status':
            return isStatusResponse(value);
        case 'configured':
            return isConfiguredResponse(value);
        case 'presented':
            return isPresentedResponse(value);
        case 'failed':
            return isPresentationFallbackReason(value.reason);
        default:
            return false;
    }
}
