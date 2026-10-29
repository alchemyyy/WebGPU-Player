import { isHDRToneMappingEnabled } from '../EngineConfiguration';
import { waitForGPUCompletion } from '../GPUCompletion';
import { requireMicroseconds } from '../TimeMath';
import { recordTimingWait, startTimingWait } from '../TimingTrace';

import {
    MICROSECONDS_PER_MILLISECOND,
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
import { readDolbyVisionRPUSnapshotHeader, type DolbyVisionRPUSnapshotHeader } from '../demux/dolby-vision/DolbyVisionRPUParser';
import {
    getRawFormatBitDepth,
    isRawDolbyVisionVideoFrameFormat,
    RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT,
    type RawDolbyVisionVideoFrameFormat,
    type RawVideoFrameColorSpace,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from '../decode/video/RawVideoFrameCopy';
import {
    getDolbyVisionEncodedFrameMetadataFailure,
    isTransferableDolbyVisionEncodedFrameMetadata,
    type TransferableDolbyVisionEncodedFrameMetadata
} from '../demux/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import {
    getHDR10PlusSceneLuminance,
    isHDR10PlusFrameMetadata,
    type HDR10PlusFrameMetadata
} from '../demux/hdr/HDR10PlusMetadata';
import { getGPUDecoderFormatFacts, isGPUDecoderOutputFormat, type GPUDecoderOutputFormat } from '../decode/video/gpu/GPUDecodeFormats';
import { getGPUFramePoolByteLimit } from '../decode/video/gpu/GPUFramePool';
import {
    getScanFrameFields,
    UNKNOWN_VIDEO_STREAM_FIELDS,
    type VideoFrameFields,
    type VideoScan,
    type VideoStreamFields
} from '../decode/video/VideoFields';
import type { ChromaLocation, ChromaSubsampling, VideoChromaFormat } from '../demux/VideoChromaFormat';
import { createBuiltinChain } from './passes/builtin/BuiltinChains';
import DeinterlaceTimeline, {
    DEFAULT_DEINTERLACE_MODE,
    DEINTERLACE_MODES,
    type DeinterlaceMode
} from './DeinterlaceTimeline';
import DisplayRefresh from './DisplayRefresh';
import FrameInterval from './FrameInterval';
import { getPresetPassPosition, GLOBAL_FACTS } from './passes/PassLanguage';
import { collectPassExpressionIdentifiers } from './passes/PassExpression';
import { parsePassFile, type PassFileEntry } from './passes/PassManifest';
import { collectPassTextures, PassTextureCache } from './passes/PassTextureCache';
import { PRESENTATION_FIELD_STATE } from './passes/PassResources';
import type {
    BuiltinChainConfiguration,
    DeinterlaceRequest,
    FramePoolFrame,
    PassManifest,
    PassParameter,
    PassRejection,
    PlanFacts,
    PlannedOutput,
    PlannedParameterSet,
    PlanReport,
    PlanRequest,
    PresentationCompileMessage,
    PresentationFrameInput,
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
    createExternalDolbyVisionAuthorizationFrame,
    ExternalDolbyVisionPresentationAuthorizationRegistry,
    ExternalDolbyVisionPresentationAuthorizationRunner,
    type ExternalDolbyVisionAuthorizationTelemetry,
    type ExternalDolbyVisionProfile
} from '../validation/ExternalDolbyVisionPresentationAuthorization';
import {
    ExternalHDRPresentationAuthorizationRegistry,
    getExternalHDRAuthorizationRouteKey,
    type ExternalHDRAuthorizationRouteKey,
    type ExternalHDRAuthorizationTelemetry,
    type ExternalHDRVideoCodec
} from '../validation/ExternalHDRPresentationAuthorization';
import {
    getRawHDRAuthorizationRouteKey,
    RawHDRPresentationAuthorizationRegistry,
    type RawHDRAuthorizationRouteKey,
    type RawHDRAuthorizationTelemetry
} from '../validation/RawHDRPresentationAuthorization';

const CANVAS_CLASS = 'webgpuPlayerCanvas';
const CANVAS_VISIBLE_CLASS = 'webgpuPlayerCanvas-visible';
// Why a frame goes undrawn: the surface's video element has no layout box, or the source reports no size
const SURFACE_EMPTY_SKIP_REASON = 'surface-empty';
const SOURCE_SIZE_EMPTY_SKIP_REASON = 'source-size-empty';
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
// External textures of the identity route are 8 bits per channel
const EXTERNAL_IDENTITY_BIT_DEPTH = 8;
// A new frame more than this many frame durations after the previous one is a discontinuity, which starts history over
const HISTORY_DISCONTINUITY_FRAME_DURATIONS = 2.5;
// How far the measured display rate moves, relative to the rate plans read, before they plan again; a measurement refines by less
const DISPLAY_RATE_REPLAN_TOLERANCE = 0.001;
const MILLISECONDS_PER_SECOND = 1_000;
// The size facts take before a frame or a canvas measures them; default plans never depend on sizes
const UNKNOWN_PLAN_DIMENSION = 1;
// The native and identity SDR route: the browser's own conversion, presented as it is, of a stream whose color is unknown until one is configured
const EXTERNAL_IDENTITY_CHAIN_CONFIGURATION: BuiltinChainConfiguration = { metadata: null, route: 'external-identity' };
const NEUTRAL_BT709_COLOR_DESCRIPTION = 'bt709:bt709:bt709:limited';
// Neutralized HEVC keeps its stream's range; the recovery then yields the codes' limited-range equivalents, which the limited metadata presents exactly
const NEUTRAL_BT709_FULL_RANGE_COLOR_DESCRIPTION = 'bt709:bt709:bt709:full';
// Names a preset pass whose header failed before it declared a name, followed by its preset position
const UNNAMED_PRESET_PASS_PREFIX = 'pass ';
// Marks a compile error in engine-generated code, whose line is in the generated module rather than in a pass source
const ENGINE_COMPILE_DETAIL_PREFIX = 'engine ';

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
    /** Why the last frame went undrawn, as `code: detail`, such as `surface-empty: video box 0x0`; null once a frame draws. */
    presentationSkipReason: string | null
    presentationSource: 'decoded' | 'native' | null
    presentedFrameCount: number
    staticFallbackHDR10PlusFrameCount: number
    sessionStartedMicroseconds: Microseconds
    state: 'fallback' | 'idle' | 'initializing' | 'presenting'
};

export type DecodedVideoPresentationFrame = {
    /** The chroma the stream's decoder configuration declares, which the browser upsampled before the frame arrives as RGB */
    chromaFormat?: VideoChromaFormat
    durationMicroseconds: Microseconds
    encodedDolbyVisionMetadata?: TransferableDolbyVisionEncodedFrameMetadata
    /** The frame's own fields, which its container reported; absent ones take the stream's scan */
    fields?: VideoFrameFields
    HDR10PlusMetadata?: HDR10PlusFrameMetadata
    frame: VideoFrame
    mediaTimeMicroseconds: Microseconds
    outputMode: 'video-frame'
    /** The decode session's video epoch; a change starts temporal history over. */
    videoEpoch?: number
};

export type DecodedRawPresentationFrame = {
    /** The chroma the stream's decoder configuration declares, whose location the signal reads the frame's chroma at */
    chromaFormat?: VideoChromaFormat
    durationMicroseconds: Microseconds
    encodedDolbyVisionMetadata?: TransferableDolbyVisionEncodedFrameMetadata
    /** The frame's own fields, which its container reported; absent ones take the stream's scan */
    fields?: VideoFrameFields
    HDR10PlusMetadata?: HDR10PlusFrameMetadata
    enhancementFrame?: TransferableRawVideoFrame | null
    frame: TransferableRawVideoFrame
    mediaTimeMicroseconds: Microseconds
    outputMode: 'raw-planes'
    /** The decode session's video epoch; a change starts temporal history over. */
    videoEpoch?: number
};

/** What a Dolby Vision route's frame pool slot carries besides its planes. */
export type FramePoolDolbyVisionFrame = {
    /** The RPUs of the frame's packet, absent when its packet carried none; a repeated frame carries those of the frame it repeats */
    encodedMetadata?: TransferableDolbyVisionEncodedFrameMetadata
    /** The output format of the frame's slot, whose bit depth the RPU's BL depth must match */
    format: GPUDecoderOutputFormat
};

/** A frame a GPU decoder wrote into a frame pool slot on the presenter's device. */
export type DecodedFramePoolPresentationFrame = {
    /** The chroma the stream's decoder configuration declares, whose location the signal reads the frame's chroma at */
    chromaFormat?: VideoChromaFormat
    /** The size presentation fits the frame by, which carries the pixel aspect ratio the visible rectangle lacks */
    displayHeight: number
    displayWidth: number
    durationMicroseconds: Microseconds
    /** Set on a Dolby Vision route: the frame's RPUs and its slot's format */
    dolbyVision?: FramePoolDolbyVisionFrame
    /** The picture's own fields, which its decoder, its parser, or its container reported; absent ones take the stream's scan */
    fields?: VideoFrameFields
    frame: FramePoolFrame
    HDR10PlusMetadata?: HDR10PlusFrameMetadata
    mediaTimeMicroseconds: Microseconds
    outputMode: 'frame-pool'
    /** The decode session's video epoch; a change starts temporal history over. */
    videoEpoch?: number
};

export type DecodedPresentationFrame =
    | DecodedFramePoolPresentationFrame
    | DecodedRawPresentationFrame
    | DecodedVideoPresentationFrame;

/**
 * What a decoded stream declares before its first frame, which the decode worker reads from the track: the chroma its decoder configuration declares,
 * and the visible size its frames are expected to have.
 */
export type DecodedVideoStreamFacts = Readonly<{
    chromaFormat: VideoChromaFormat | null
    frameHeight: number
    frameWidth: number
}>;

export type IdentityColorPipelineConfiguration = {
    /** The stream's color, whose matrix and range the browser converts its frames with, and which the planes of plane passes derive through */
    metadata: InputColorMetadata
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
    /** The single-layer reconstruction: Profile 5, or Profile 8 over a compatible base */
    profile: ExternalDolbyVisionProfile
    settings: HDRToSDRRenderSettings
};

export type ExternalHDRColorPipelineConfiguration = {
    /** The codec whose neutralized hardware frames the route presents, which names its authorization */
    codec: ExternalHDRVideoCodec
    inputMode: 'external-hdr'
    metadata: InputColorMetadata
    settings: HDRToSDRRenderSettings
};

/** The GPU decode route: planes a GPU decoder writes into its frame pool, whose conformance vector stands in for a presentation authorization. */
export type FramePoolColorPipelineConfiguration = {
    format: GPUDecoderOutputFormat
    inputMode: 'frame-pool'
    metadata: InputColorMetadata
    settings: RenderSettings
};

/**
 * The GPU decode route's Dolby Vision reconstruction: a GPU decoder's BL frame pool in format, through each frame's RPU.
 * It renders through the raw route's reconstruction over the frame pool's read, so the raw route's Dolby Vision key of the BL format authorizes it.
 */
export type FramePoolDolbyVisionColorPipelineConfiguration = {
    format: GPUDecoderOutputFormat
    inputMode: 'frame-pool-dolby-vision'
    profile: DolbyVisionReconstructionProfile
    settings: HDRToSDRRenderSettings
};

/**
 * One file of a presentation preset: its WGSL source, holding one or more passes that each start with a `//!` header, and the parameter values the host stored for it.
 * The file's passes run in file order, and each value applies to every pass of the file that declares its parameter.
 */
export type PresentationPresetFile = {
    parameters: Readonly<Record<string, number>>
    source: string
};

export type PresentationColorPipelineConfiguration = (
    | ExternalDolbyVisionColorPipelineConfiguration
    | ExternalHDRColorPipelineConfiguration
    | FramePoolColorPipelineConfiguration
    | FramePoolDolbyVisionColorPipelineConfiguration
    | IdentityColorPipelineConfiguration
    | RawDolbyVisionColorPipelineConfiguration
    | RawHDRColorPipelineConfiguration
) & {
    /** Defaults to true for callers without a persisted manual peak policy. */
    automaticInputPeakNits?: boolean
    /** The stream's declared frame rate, which plans read as frame.rate; unknown when absent. */
    frameRate?: number | null
    /**
     * What the stream declares of its fields, which decides whether the route's plan deinterlaces from its first frame; unknown when absent.
     * Frames that report their own fields override its scan, and a session that shows an interlaced frame deinterlaces from then on.
     */
    videoFields?: VideoStreamFields
};

type PresentationInputMode =
    | 'external-dolby-vision'
    | 'external-hdr'
    | 'external-texture'
    | 'frame-pool'
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
    /** The media time the submission shows: its frame's, a deinterlaced frame's field's, or in a display-rate plan the frame its clock time falls in */
    presentedTimeMicroseconds: Microseconds
    validationResult: Promise<GPUError | null> | null
};

/**
 * What one submission shows: the PRESENTATION_FIELD_STATE bits and the time of the field or frame it draws, and the media time telemetry reports.
 * A display-rate plan's draw also carries the clock time it presents at, since its passes blend by it; a draw from history redraws when any of them changes.
 */
type PresentationDraw = Readonly<{
    /** The clock time of a display-rate draw; null for a draw that shows the same at any clock time */
    clockMicroseconds: number | null
    fieldState: number
    presentedTimeMicroseconds: number
    timestampMicroseconds: number
}>;

/** The newest frame in a display-rate plan's history and the one before it, which its refreshes draw between. */
type DisplayRateFrames = Readonly<{
    newestMicroseconds: number
    previousMicroseconds: number | null
}>;

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
    /** The codec of an external HDR route's frames */
    externalHDRCodec?: ExternalHDRVideoCodec
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
    /** The frame's own fields, or null when they take the stream's scan */
    fields: VideoFrameFields | null
    newFrame: boolean
    /** The clock time the frame presents at, which picks the field a deinterlaced frame shows and a display-rate draw's blend; a frame without one shows at its own time */
    targetTimeMicroseconds: number | null
    timestampMicroseconds: number
    videoEpoch: number | null
};

/** The last new frame, which the next new frame's timestamp is checked against. */
type PresentedFrameTiming = {
    durationMicroseconds: number | null
    timestampMicroseconds: number
    videoEpoch: number | null
};

/**
 * An executor built for the current plan inputs, the active executor when it already renders their plan, or what failed.
 * A result names the preset it planned, which the plan report reads its planner results against.
 */
type ExecutorBuildResult =
    | { executor: PresentationExecutor; kind: 'built'; plan: PresentationPlan; planKey: string; presetPasses: readonly PresetPass[] }
    | { detail: string; kind: 'failed' }
    | { executor: PresentationExecutor; kind: 'current'; plan: PresentationPlan; presetPasses: readonly PresetPass[] };

type BuiltExecutor = Extract<ExecutorBuildResult, { kind: 'built' }>;
type CurrentExecutor = Extract<ExecutorBuildResult, { kind: 'current' }>;

type ExecutorBuild = {
    device: GPUDevice
    promise: Promise<string | null>
    revision: number
};

/** A preset pass as plans take it: its manifest and current parameter values, or the presenter's check that keeps it out of every plan. */
type PresetPass = {
    /** Why plans leave the pass out: its header, its name, its preset values, or its compile errors; null while plans include it. */
    exclusion: PassRejection | null
    /** Null when the header failed to parse. */
    manifest: PassManifest | null
    name: string
    /** The preset's values, then each live change; a parameter without one keeps its declared default. */
    parameterValues: Map<string, number>
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
        case 'frame-pool-dolby-vision':
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

/** Returns a route's chain configuration with HDR output selected while it is active; the identity route has no HDR output. */
function withHDROutput(configuration: BuiltinChainConfiguration, hdrOutput: boolean): BuiltinChainConfiguration {
    if (!hdrOutput || configuration.route === 'external-identity') {
        return configuration;
    }
    return { ...configuration, hdrOutput };
}

/**
 * Returns a route's chain configuration with field-aware chroma while plans deinterlace: the planar routes' signals then read an interlaced frame's 4:2:0 chroma
 * within each field. External sources arrive with the browser's chroma upsampling, and the Dolby Vision routes never deinterlace.
 */
function withInterlacedChroma(configuration: BuiltinChainConfiguration, interlacedChroma: boolean): BuiltinChainConfiguration {
    if (!interlacedChroma) {
        return configuration;
    }
    switch (configuration.route) {
        case 'frame-pool':
        case 'raw-yuv':
            return { ...configuration, interlacedChroma };
        case 'external-dolby-vision':
        case 'external-hdr':
        case 'external-identity':
        case 'frame-pool-dolby-vision':
        case 'raw-dolby-vision':
            return configuration;
    }
}

/**
 * Returns a route's chain configuration with the stream's chroma: the planar routes' signals read 4:2:0 chroma at its location, and the external routes
 * derive their planes' chroma at its subsampling and location. The browser converts an external Dolby Vision frame without planes.
 */
function withStreamChroma(
    configuration: BuiltinChainConfiguration,
    chromaSubsampling: ChromaSubsampling | null,
    chromaLocation: ChromaLocation | null
): BuiltinChainConfiguration {
    switch (configuration.route) {
        case 'external-hdr':
        case 'external-identity':
            return { ...configuration, chromaLocation, chromaSubsampling };
        case 'frame-pool':
        case 'frame-pool-dolby-vision':
        case 'raw-dolby-vision':
        case 'raw-yuv':
            return { ...configuration, chromaLocation };
        case 'external-dolby-vision':
            return configuration;
    }
}

/**
 * Returns the bit depth of a route's signal, whose code value sizes the deinterlacing pass's score bias; null for the Dolby Vision routes,
 * whose profiles are progressive, so they never deinterlace.
 */
function getChainBitDepth(configuration: BuiltinChainConfiguration): number | null {
    switch (configuration.route) {
        case 'external-identity':
            return EXTERNAL_IDENTITY_BIT_DEPTH;
        case 'external-hdr':
        case 'frame-pool':
        case 'raw-yuv':
            return configuration.metadata.bitDepth;
        case 'external-dolby-vision':
        case 'frame-pool-dolby-vision':
        case 'raw-dolby-vision':
            return null;
    }
}

function isInterlacedScan(scan: VideoScan): boolean {
    return scan === 'bottom-first' || scan === 'interlaced' || scan === 'top-first';
}

function areDeinterlaceRequestsEqual(first: DeinterlaceRequest | null, second: DeinterlaceRequest | null): boolean {
    if (first === null || second === null) {
        return first === second;
    }
    return first.bitDepth === second.bitDepth && first.frameHeight === second.frameHeight && first.frameWidth === second.frameWidth;
}

function areDrawsEqual(first: PresentationDraw, second: PresentationDraw | null): boolean {
    return second !== null
        && first.fieldState === second.fieldState
        && first.timestampMicroseconds === second.timestampMicroseconds
        && first.clockMicroseconds === second.clockMicroseconds;
}

/**
 * Returns a display-rate plan's draw at a clock time: its history's newest frame, which its passes blend with the frame before it by the clock.
 * Telemetry reports the frame the clock time falls in: the one before the newest until the clock reaches the newest.
 * A frame's own draw and its redraws are built here alike, so a redraw at the same clock time is recognized as the one drawn.
 */
function getDisplayRateDraw(frames: DisplayRateFrames, clockMicroseconds: number): PresentationDraw {
    const previousMicroseconds = frames.previousMicroseconds;
    return {
        clockMicroseconds,
        fieldState: PRESENTATION_FIELD_STATE.none,
        presentedTimeMicroseconds: previousMicroseconds !== null && clockMicroseconds < frames.newestMicroseconds ? previousMicroseconds : frames.newestMicroseconds,
        timestampMicroseconds: frames.newestMicroseconds
    };
}

type VisibleSize = Readonly<{ height: number; width: number }>;

/** Returns the size of a frame source's visible rectangle in samples, as the executor sizes the source: a VideoFrame's visible rectangle, or its display size. */
function getSourceVisibleSize(source: PresentationFrameSource): VisibleSize {
    switch (source.kind) {
        case 'external': {
            const externalSource = source.source;
            if ('videoWidth' in externalSource) {
                return { height: externalSource.videoHeight, width: externalSource.videoWidth };
            }
            const rectangle = externalSource.visibleRect;
            return rectangle ?
                { height: rectangle.height, width: rectangle.width } :
                { height: externalSource.displayHeight, width: externalSource.displayWidth };
        }
        case 'frame-pool':
        case 'planes':
            return { height: source.frame.visibleRectangle.height, width: source.frame.visibleRectangle.width };
    }
}

/** Returns the size of a decoded frame's visible rectangle in samples, which a deinterlacing plan runs at. */
function getDecodedFrameVisibleSize(decodedFrame: DecodedPresentationFrame): VisibleSize {
    switch (decodedFrame.outputMode) {
        case 'frame-pool':
            return getSourceVisibleSize({ frame: decodedFrame.frame, kind: 'frame-pool' });
        case 'raw-planes':
            return getSourceVisibleSize({ enhancementFrame: null, frame: decodedFrame.frame, kind: 'planes' });
        case 'video-frame':
            return getSourceVisibleSize({ kind: 'external', source: decodedFrame.frame });
    }
}

function createExcludedPresetPass(manifest: PassManifest | null, exclusion: PassRejection): PresetPass {
    return { exclusion, manifest, name: exclusion.name, parameterValues: new Map<string, number>() };
}

/** Returns whether a pass declares a parameter, as a uniform parameter or a constant. */
function declaresParameter(manifest: PassManifest, parameterName: string): boolean {
    return [ ...manifest.parameters, ...manifest.constants ].some((parameter: PassParameter): boolean => parameter.name === parameterName);
}

/** Returns whether a parameter's value shapes a pass's plan: a constant, which the plan compiles in, or a parameter its condition reads. */
function isPlanParameter(manifest: PassManifest, parameterName: string): boolean {
    return manifest.constants.some((constant: PassParameter): boolean => constant.name === parameterName)
        || (manifest.when !== null && collectPassExpressionIdentifiers(manifest.when).includes(parameterName));
}

/** Returns the check that a preset file's values fail for every pass of the file: a value no pass declares, or one that is not finite. */
function checkPresetValues(presetFile: PresentationPresetFile, entries: readonly PassFileEntry[]): Omit<PassRejection, 'name'> | null {
    for (const [ parameterName, value ] of Object.entries(presetFile.parameters)) {
        const declared = entries.some((entry: PassFileEntry): boolean => entry.manifest !== null && declaresParameter(entry.manifest, parameterName));
        if (!declared) {
            return { detail: `'${parameterName}'`, reason: 'parameter-unknown' };
        }
        if (!Number.isFinite(value)) {
            return { detail: `'${parameterName}' ${value}`, reason: 'parameter-invalid' };
        }
    }
    return null;
}

/**
 * Parses one preset file into its passes, in file order, and checks the file's preset values.
 * A header that fails to parse, a name an earlier pass holds, or a value no pass of the file declares or that is not finite keeps a pass out of every plan.
 */
function createPresetPasses(presetFile: PresentationPresetFile, fileIndex: number, claimedNames: Set<string>): PresetPass[] {
    const entries = parsePassFile(presetFile.source);
    const valueFailure = checkPresetValues(presetFile, entries);
    const presetPasses: PresetPass[] = [];
    for (const [ passIndex, entry ] of entries.entries()) {
        const position = getPresetPassPosition(fileIndex, passIndex, entries.length);
        if (entry.manifest === null) {
            presetPasses.push(createExcludedPresetPass(null, {
                detail: `line ${entry.error.line}: ${entry.error.message}`,
                name: entry.error.passName ?? `${UNNAMED_PRESET_PASS_PREFIX}${position}`,
                reason: 'header-invalid'
            }));
            continue;
        }
        const manifest = entry.manifest;
        const name = manifest.name;
        if (claimedNames.has(name)) {
            presetPasses.push(createExcludedPresetPass(manifest, { detail: `position ${position}`, name, reason: 'duplicate-name' }));
            continue;
        }
        claimedNames.add(name);
        if (valueFailure !== null) {
            presetPasses.push(createExcludedPresetPass(manifest, { ...valueFailure, name }));
            continue;
        }
        // Each pass takes the file's values of the parameters it declares
        const parameterValues = new Map<string, number>();
        for (const [ parameterName, value ] of Object.entries(presetFile.parameters)) {
            if (declaresParameter(manifest, parameterName)) {
                parameterValues.set(parameterName, value);
            }
        }
        presetPasses.push({ exclusion: null, manifest, name, parameterValues });
    }
    return presetPasses;
}

function isPlannedPresetPass(presetPass: PresetPass): presetPass is PresetPass & { manifest: PassManifest } {
    return presetPass.manifest !== null && presetPass.exclusion === null;
}

/** Returns the preset pass plans know by a name: the first one that parsed, since later passes of its name stay out of plans. */
function findPresetPass(presetPasses: readonly PresetPass[], passName: string): PresetPass | undefined {
    return presetPasses.find((presetPass: PresetPass): boolean => presetPass.manifest !== null && presetPass.name === passName);
}

/** Writes the preset's value of each parameter the plan declares; a parameter without one keeps its declared default. */
function applyParameterValues(executor: PresentationExecutor, plan: PresentationPlan, presetPasses: readonly PresetPass[]): void {
    for (const parameterSet of plan.parameterSets) {
        const parameterValues = findPresetPass(presetPasses, parameterSet.passName)?.parameterValues;
        for (const parameter of parameterSet.parameters) {
            const value = parameterValues?.get(parameter.name);
            if (value !== undefined) {
                executor.setParameter(parameterSet.passName, parameter.name, value);
            }
        }
    }
}

/** Returns the preset passes' current parameter values by pass name, which conditions read and constants compile in. */
function getPlannedParameterValues(presetPasses: readonly PresetPass[]): Map<string, ReadonlyMap<string, number>> {
    const values = new Map<string, ReadonlyMap<string, number>>();
    for (const presetPass of presetPasses) {
        if (isPlannedPresetPass(presetPass)) {
            values.set(presetPass.name, new Map<string, number>(presetPass.parameterValues));
        }
    }
    return values;
}

/** Returns the manifests of the preset passes plans include, in preset order. */
function getPlannedManifests(presetPasses: readonly PresetPass[]): PassManifest[] {
    const manifests: PassManifest[] = [];
    for (const presetPass of presetPasses) {
        if (isPlannedPresetPass(presetPass)) {
            manifests.push(presetPass.manifest);
        }
    }
    return manifests;
}

function formatCompileDetail(message: PresentationCompileMessage): string {
    return `line ${message.line}:${message.column}: ${message.message}`;
}

/**
 * Excludes each preset pass a plan's compile errors name, with its first message, and returns whether it excluded any.
 * Errors only in engine code exclude every user pass of the plan: such code calls into the user bodies fused beside it, and without them the plan is the default plan.
 */
function excludeCompileFailures(error: PresentationCompileError, plan: PresentationPlan, presetPasses: readonly PresetPass[]): boolean {
    const details = new Map<string, string>();
    for (const message of error.messages) {
        if (message.passName !== null && !details.has(message.passName)) {
            details.set(message.passName, formatCompileDetail(message));
        }
    }
    const engineMessage = error.messages.find((message: PresentationCompileMessage): boolean => message.passName === null);
    if (details.size === 0 && engineMessage !== undefined) {
        for (const passName of plan.report.activePasses) {
            details.set(passName, `${ENGINE_COMPILE_DETAIL_PREFIX}${formatCompileDetail(engineMessage)}`);
        }
    }
    let excluded = false;
    for (const presetPass of presetPasses) {
        const detail = details.get(presetPass.name);
        if (detail !== undefined && isPlannedPresetPass(presetPass)) {
            presetPass.exclusion = { detail, name: presetPass.name, reason: 'compile-error' };
            excluded = true;
        }
    }
    return excluded;
}

/** Returns whether two layouts give a plan the same output and source sizes. */
function layoutPlanSizesMatch(first: CachedPresentationLayout, second: CachedPresentationLayout): boolean {
    return first.presentation.viewportHeight === second.presentation.viewportHeight
        && first.presentation.viewportWidth === second.presentation.viewportWidth
        && first.videoHeight === second.videoHeight
        && first.videoWidth === second.videoWidth;
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
        presentationSkipReason: null,
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

/**
 * Returns how a decoded frame differs from the neutralized BT.709 limited-range description, or with `fullRangeAllowed` from either range's, or null when it matches.
 */
function getNeutralBT709FrameColorFailure(frame: VideoFrame, fullRangeAllowed = false): string | null {
    const actualColor = describeVideoFrameColor(frame);
    if (actualColor === NEUTRAL_BT709_COLOR_DESCRIPTION || (fullRangeAllowed && actualColor === NEUTRAL_BT709_FULL_RANGE_COLOR_DESCRIPTION)) {
        return null;
    }
    const expectedColor = fullRangeAllowed ?
        `${NEUTRAL_BT709_COLOR_DESCRIPTION} or ${NEUTRAL_BT709_FULL_RANGE_COLOR_DESCRIPTION}` :
        NEUTRAL_BT709_COLOR_DESCRIPTION;
    return `color: ${actualColor}, expected ${expectedColor}`;
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

/**
 * Returns why a planar route cannot present a stream, the raw route's or the GPU decode route's: invalid metadata or settings, a transfer the mode cannot render, or a depth the format cannot hold.
 */
function getPlanarColorConfigurationFailure(
    metadata: InputColorMetadata,
    format: SupportedRawVideoFrameFormat,
    settings: RenderSettings
): string | null {
    try {
        assertValidInputColorMetadata(metadata);
        assertValidRenderSettings(settings);
    } catch (error) {
        return getErrorMessage(error);
    }

    let validTransfer: boolean;
    switch (metadata.transfer) {
        case 'hlg':
        case 'pq':
            validTransfer = settings.mode === 'hdr-to-sdr';
            break;
        case 'sdr':
            validTransfer = settings.mode === 'identity-sdr';
            break;
    }
    if (!validTransfer) {
        return `mode: ${settings.mode} cannot present ${metadata.transfer}`;
    }

    const formatBitDepth = getRawFormatBitDepth(format);
    return metadata.bitDepth === formatBitDepth ?
        null :
        `bit-depth: ${metadata.bitDepth}, ${format} holds ${formatBitDepth}`;
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
    // The worker's parser validated the whole snapshot, so each frame reads only its header
    let snapshot: DolbyVisionRPUSnapshotHeader;
    try {
        snapshot = readDolbyVisionRPUSnapshotHeader(packedRPUData);
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
    // The worker's parser validated the whole snapshot, so each frame reads only its header
    let snapshot: DolbyVisionRPUSnapshotHeader;
    try {
        snapshot = readDolbyVisionRPUSnapshotHeader(packedRPUData);
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
 * Returns the packed RPU a reconstruction profile's frame writes, with its dual-layer facts for Profiles 4 and 7, or the check that refused it.
 * The BL bit depth is the frame's own, which the RPU must declare.
 */
function getDolbyVisionFrameRPUData(
    metadata: TransferableDolbyVisionEncodedFrameMetadata | undefined,
    profile: DolbyVisionReconstructionProfile,
    baseLayerBitDepth: number,
    hasDecodedEnhancementFrame: boolean
): DolbyVisionRPUResult<{ dualLayer: DualLayerDolbyVisionRPUData | null; packedRPUData: ArrayBuffer }> {
    switch (profile) {
        case 5:
        case 8: {
            const rpu = getSingleLayerDolbyVisionRPUData(metadata, baseLayerBitDepth);
            return rpu.failure === null ? { data: { dualLayer: null, packedRPUData: rpu.data }, failure: null } : createRPUFailure(rpu.failure);
        }
        case 4:
        case 7: {
            const rpu = getDualLayerDolbyVisionRPUData(metadata, profile, baseLayerBitDepth, hasDecodedEnhancementFrame);
            return rpu.failure === null ? { data: { dualLayer: rpu.data, packedRPUData: rpu.data.packedRPUData }, failure: null } : createRPUFailure(rpu.failure);
        }
    }
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

/** Presents frames from an owned HTML video without taking over playback. */
export default class WebGPUPresenter {
    private readonly fallbackHandler: PresentationFallbackHandler;
    private readonly decodedPresentationRefreshHandler: DecodedPresentationRefreshHandler;
    private readonly externalDolbyVisionAuthorization = new ExternalDolbyVisionPresentationAuthorizationRegistry();
    // External Profile 8 reconstruction, which only AV1 Profile 10 takes, authorizes on first use
    private readonly externalDolbyVisionProfile8Authorization = new ExternalDolbyVisionPresentationAuthorizationRegistry(
        new ExternalDolbyVisionPresentationAuthorizationRunner(createExternalDolbyVisionAuthorizationFrame, 8)
    );
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
    private activeExternalHDRCodec: ExternalHDRVideoCodec | null = null;
    private activeInputMode: PresentationInputMode = 'external-texture';
    private activeRawFrameFormat: SupportedRawVideoFrameFormat | null = null;
    private cachedPresentationLayout: CachedPresentationLayout | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private canvasContext: GPUCanvasContext | null = null;
    private canvasFormat: GPUTextureFormat | null = null;
    private colorConfigurationRevision = 0;
    // The rate the clock advanced at on the frame loop's last animation frame, 0 while it stood still, which scales the media time one refresh covers
    private clockRate = 1;
    private configuredDevice: GPUDevice | null = null;
    private configuredOutput: PlannedOutput | null = null;
    // The route's built-in chain, which every plan builds on
    private desiredChainConfiguration: BuiltinChainConfiguration = EXTERNAL_IDENTITY_CHAIN_CONFIGURATION;
    private device: GPUDevice | null = null;
    private deviceRecoveryAttempts = 0;
    private deviceResourceEpoch = 0;
    private decodedFramePushActive = false;
    // Measures the display's refresh from the frame loop's animation frames; it outlives sessions, as the display does
    private readonly displayRefresh = new DisplayRefresh();
    // Estimates the media time between the stream's frames from the new frames drawn, frame by frame; a seek starts it over
    private readonly frameInterval = new FrameInterval();
    // The newest frame in a display-rate plan's history and the one before it; null while the executor's history holds no frame
    private displayRateFrames: DisplayRateFrames | null = null;
    // The host's deinterlacing choice, which outlives sessions
    private deinterlaceMode: DeinterlaceMode = DEFAULT_DEINTERLACE_MODE;
    // Mirrors the deinterlacing pass's history, so each draw knows which held frame shows which field
    private readonly deinterlaceTimeline = new DeinterlaceTimeline();
    // The session saw an interlaced frame, so its plans deinterlace whatever its stream's scan said
    private interlacedFrameSeen = false;
    // The draw a submission last presented, so a redraw from history draws only when another field, frame, or clock time of a display-rate plan shows
    private lastHistoryDraw: PresentationDraw | null = null;
    // The session's stream fields, which deinterlacing plans follow
    private videoFieldFacts: VideoStreamFields = UNKNOWN_VIDEO_STREAM_FIELDS;
    // The chroma the stream's decoder configuration declares, which the newest frame carried
    private streamChromaLocation: ChromaLocation | null = null;
    private streamChromaSubsampling: ChromaSubsampling | null = null;
    private dynamicHDR10PlusSettingsActive = false;
    private executor: PresentationExecutor | null = null;
    private executorBuild: ExecutorBuild | null = null;
    private executorPlan: PresentationPlan | null = null;
    private executorPlanKey: string | null = null;
    // The preset the active executor's plan was built from, so the report never reads one preset's plan against another
    private executorPresetPasses: readonly PresetPass[] | null = null;
    // The uploads of the preset's texture blocks, on the device they were made on
    private passTextureCache: PassTextureCache | null = null;
    private passTextureCacheDevice: GPUDevice | null = null;
    // The plan revision the active executor answers
    private executorRevision = -1;
    private fallbackLatched = false;
    // The host's HDR output choice, which applies to HDR sources only and outlives sessions
    private hdrOutputEnabled = false;
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
    // The running rebuild for changed plan inputs, which builds for the newest revision before it ends
    private planInputsApplication: Promise<void> | null = null;
    // Advances whenever a plan input changes: the route, the device, the output, the preset, or a size or rate a preset pass reads
    private planRevision = 0;
    // The display rate plans read as display.rate, which follows the measurement once it moves past DISPLAY_RATE_REPLAN_TOLERANCE; null before one
    private plannedDisplayRate: number | null = null;
    private presentationLayoutDirty = true;
    // The host's preset, in preset order, which outlives sessions
    private presetPasses: readonly PresetPass[] = [];
    // The render settings uniform the active route last wrote, which a new executor takes over
    private renderSettingsData: ArrayBuffer | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private sessionActive = false;
    // The session's declared frame rate, which plans read as frame.rate
    private streamFrameRate: number | null = null;
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
        this.clockRate = 1;
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
        this.resetVideoFieldFacts();
        this.sessionActive = true;
        this.streamFrameRate = null;
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

    /**
     * Starts exact raw SDR GPU-output probes independently from HDR settings: the prewarmed BT.709 keys, and a stream's own raw key when given,
     * since every other SDR key authorizes on first use.
     */
    async prewarmRawSDRPresentationAuthorization(routeKey: RawHDRAuthorizationRouteKey | null = null): Promise<void> {
        if (!await this.ensureDevice()) {
            return;
        }
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (device && targetFormat) {
            this.rawHDRAuthorization.prewarmSDR(device, targetFormat);
            if (routeKey !== null) {
                void this.rawHDRAuthorization.authorize(device, targetFormat, routeKey);
            }
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

    /**
     * Starts the external HDR probe of a codec's route for the metadata on first use, and waits a tightly bounded run of it.
     * A settled probe resolves at once; metadata no route covers waits for nothing.
     */
    async waitForExternalHDRRouteAuthorization(codec: ExternalHDRVideoCodec, metadata: InputColorMetadata): Promise<void> {
        const routeKey = getExternalHDRAuthorizationRouteKey(codec, metadata);
        if (!routeKey) {
            return;
        }
        await waitForRawHDRNegotiationProbe((async (): Promise<void> => {
            if (!await isHDRToneMappingEnabled() || !await this.ensureDevice()) {
                return;
            }
            const device = this.device;
            const targetFormat = this.canvasFormat;
            if (device && targetFormat) {
                await this.externalHDRAuthorization.authorize(device, targetFormat, routeKey);
            }
        })());
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
            this.getExternalDolbyVisionAuthorizationFailure(5) === null :
            this.externalDolbyVisionAuthorization.getTelemetry(this.device, this.canvasFormat).status === 'authorized';
    }

    /** Returns only settled external-texture Profile 8 authorization. */
    isExternalDolbyVisionProfile8PresentationAuthorized(): boolean {
        return this.externalDolbyVisionProfile8Authorization.getTelemetry(this.device, this.canvasFormat).status === 'authorized';
    }

    /** Starts the external Profile 8 probe on first use and waits a tightly bounded run of it; a settled probe resolves at once. */
    async waitForExternalDolbyVisionProfile8Authorization(): Promise<void> {
        await waitForRawHDRNegotiationProbe((async (): Promise<void> => {
            if (!await isHDRToneMappingEnabled() || !await this.ensureDevice()) {
                return;
            }
            const device = this.device;
            const targetFormat = this.canvasFormat;
            if (device && targetFormat) {
                await this.externalDolbyVisionProfile8Authorization.authorize(device, targetFormat);
            }
        })());
    }

    /** Returns bounded external-texture Profile 8 authorization state. */
    getExternalDolbyVisionProfile8AuthorizationTelemetry(): ExternalDolbyVisionAuthorizationTelemetry {
        return this.externalDolbyVisionProfile8Authorization.getTelemetry(this.device, this.canvasFormat);
    }

    /**
     * Returns the device the GPU decode route decodes on, the presenter's own, creating it when needed; null when no device can be created.
     * A decoder's frames never leave this device, so its loss ends the route.
     */
    async getGPUVideoDecodeDevice(): Promise<GPUDevice | null> {
        return await this.ensureDevice() ? this.device : null;
    }

    /** Returns the largest frame pool the presenter's device allows, creating the device when needed; null when no device can be created. */
    async getGPUFramePoolByteLimit(): Promise<number | null> {
        const device = await this.getGPUVideoDecodeDevice();
        return device ? getGPUFramePoolByteLimit(device.limits) : null;
    }

    /** Selects clock-driven decoded-frame ticks before a surface is attached. */
    setDecodedFramePushMode(enabled: boolean, generation: number): void {
        if (!this.isCurrent(generation)) {
            return;
        }

        this.setDecodedFramePushActive(enabled);
        if (enabled) {
            this.cancelFrameCallback();
        } else {
            this.scheduleFrameCallback(generation);
        }
    }

    /**
     * Takes ownership of one clock-selected decoded frame and closes it on every path.
     * This path does not require a native video-frame callback.
     * targetTimeMicroseconds is the clock time the frame loop presents at, which picks the field a deinterlaced stream shows and the blend of a display-rate plan;
     * without it a frame shows at its own time.
     * A plan that deinterlaces takes frames one frame ahead of the clock (getFrameLookaheadMicroseconds) and shows the frame before the newest;
     * a display-rate plan takes them one refresh ahead, so a frame that starts within the refresh is drawn with the one before it.
     */
    presentDecodedFrame(
        decodedFrame: DecodedPresentationFrame,
        generation: number,
        videoFrameSubmissionCompleted?: (gpuWorkCompleted: boolean) => void,
        targetTimeMicroseconds?: Microseconds
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
            this.followFrameFields(decodedFrame);

            const targetTime = targetTimeMicroseconds ?? null;
            let frameWidth: number;
            let frameHeight: number;
            let submission: FrameSubmission | null;
            switch (decodedFrame.outputMode) {
                case 'frame-pool':
                    frameWidth = decodedFrame.displayWidth;
                    frameHeight = decodedFrame.displayHeight;
                    submission = this.renderDecodedFramePoolFrame(decodedFrame, generation, targetTime);
                    break;
                case 'raw-planes': {
                    frameWidth = decodedFrame.frame.displayWidth;
                    frameHeight = decodedFrame.frame.displayHeight;
                    submission = this.renderDecodedRawFrame(decodedFrame, generation, targetTime);
                    break;
                }
                case 'video-frame':
                    frameWidth = decodedFrame.frame.displayWidth
                        || decodedFrame.frame.codedWidth;
                    frameHeight = decodedFrame.frame.displayHeight
                        || decodedFrame.frame.codedHeight;
                    submission = this.renderDecodedVideoFrame(decodedFrame, generation, targetTime);
                    break;
            }
            if (frameWidth <= 0 || frameHeight <= 0) {
                this.fallback(generation, 'frame-render-failed', `frame-size: ${frameWidth}x${frameHeight}`);
                return false;
            }

            this.setDecodedFramePushActive(true);
            this.cancelFrameCallback();
            if (!submission) {
                return false;
            }

            const callbackTimeMicroseconds = getMonotonicMicroseconds();
            this.completeSubmission(submission, generation, () => {
                if (!this.isCurrent(generation) || this.fallbackLatched) {
                    return;
                }
                // A deinterlaced stream shows a held frame's field, at the time the timeline drew it
                this.recordPresentedFrame(
                    submission.presentedTimeMicroseconds,
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

        // The route's executor is built for the stream's fields, so an interlaced stream deinterlaces from its first frame
        this.changeDeinterlaceInputs((): void => {
            this.videoFieldFacts = configuration.videoFields ?? UNKNOWN_VIDEO_STREAM_FIELDS;
        });
        this.streamFrameRate = configuration.frameRate ?? null;
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
        this.activeExternalHDRCodec = preparedPipeline.externalHDRCodec ?? null;
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
            || this.activeInputMode === 'frame-pool'
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

    /**
     * Replaces the user passes every plan includes, in preset order, and resolves with the plan report once an executor for them is installed, or at once outside a session.
     * Each file contributes its passes in file order, so the passes of one file stay together and in order.
     * A pass that cannot run is left out and reported: 'header-invalid', named `pass <position>` when its header failed before declaring a name, where the position counts from 1 and is `<file>.<pass>` within a file of several passes; 'duplicate-name'; a preset value no pass of its file declares ('parameter-unknown') or that is not finite ('parameter-invalid'), which leaves out every pass of the file; or 'compile-error', after which the plan is rebuilt without it.
     * The preset outlives sessions, so the host sets it again only when it changes.
     */
    async setPresentationPreset(files: readonly PresentationPresetFile[]): Promise<PlanReport> {
        const claimedNames = new Set<string>();
        const presetPasses: PresetPass[] = [];
        for (const [ fileIndex, file ] of files.entries()) {
            presetPasses.push(...createPresetPasses(file, fileIndex, claimedNames));
        }
        this.presetPasses = presetPasses;
        this.planRevision += 1;
        await this.applyPlanInputs();
        return this.getPresentationPlanReport();
    }

    /**
     * Changes one parameter of a preset pass live: the active executor takes a uniform parameter from the next frame without replanning, a paused frame redraws,
     * and later executors keep it. A constant, or a parameter the pass's condition reads, builds a plan for the new value instead.
     * Integer parameters round and values outside the declared range clamp.
     * A pass outside the preset ('pass-unknown'), an undeclared parameter ('parameter-unknown'), or a value that is not finite ('parameter-invalid') throws a RangeError.
     */
    setPresentationParameter(passName: string, parameterName: string, value: number): void {
        const presetPass = findPresetPass(this.presetPasses, passName);
        if (!presetPass?.manifest) {
            throw new RangeError(`pass-unknown: '${passName}'`);
        }
        if (!declaresParameter(presetPass.manifest, parameterName)) {
            throw new RangeError(`parameter-unknown: '${passName}' '${parameterName}'`);
        }
        if (!Number.isFinite(value)) {
            throw new RangeError(`parameter-invalid: '${passName}' '${parameterName}' ${value}`);
        }
        presetPass.parameterValues.set(parameterName, value);
        if (isPlanParameter(presetPass.manifest, parameterName) && isPlannedPresetPass(presetPass)) {
            this.planRevision += 1;
            void this.applyPlanInputs();
        }
        const executor = this.executor;
        // An executor still running an earlier preset may hold a pass of this name without the parameter
        const parameterSet = this.executorPlan?.parameterSets.find(
            (candidate: PlannedParameterSet): boolean => candidate.passName === passName
        );
        if (!executor || !parameterSet?.parameters.some((parameter: PassParameter): boolean => parameter.name === parameterName)) {
            return;
        }
        executor.setParameter(passName, parameterName, value);
        this.redrawCurrentFrame(this.activeGeneration);
    }

    /** Returns the plan the active executor renders, or null before one is installed. */
    getActivePresentationPlan(): PresentationPlan | null {
        return this.executorPlan;
    }

    /**
     * Returns the active plan's report over every preset pass, in preset order: the passes it runs, and each pass it leaves out with the failed check and a terse detail.
     * Passes the presenter keeps out of every plan are reported as well, and only those while no active plan was built from the current preset.
     */
    getPresentationPlanReport(): PlanReport {
        const planReport = this.executorPresetPasses === this.presetPasses ? this.executorPlan?.report : undefined;
        const plannerRejections = new Map<string, PassRejection>();
        for (const rejection of planReport?.inactivePasses ?? []) {
            plannerRejections.set(rejection.name, rejection);
        }
        const inactivePasses: PassRejection[] = [];
        for (const presetPass of this.presetPasses) {
            const rejection = presetPass.exclusion ?? plannerRejections.get(presetPass.name);
            if (rejection) {
                inactivePasses.push({ ...rejection });
            }
        }
        return { activePasses: [ ...planReport?.activePasses ?? [] ], inactivePasses };
    }

    /**
     * Selects HDR output, off by default: an HDR source then presents on an rgba16float canvas with extended tone mapping, mapped to the render settings' outputPeakNits as the display peak and paperWhiteNits as SDR white.
     * SDR sources keep the SDR canvas. The choice outlives sessions and resolves once an executor for it is installed.
     */
    async setHDROutputEnabled(enabled: boolean): Promise<void> {
        if (enabled === this.hdrOutputEnabled) {
            return;
        }
        this.hdrOutputEnabled = enabled;
        this.planRevision += 1;
        await this.applyPlanInputs();
    }

    /**
     * Selects how interlaced frames present: 'double-rate', the default, shows each field as a frame of its own; 'single-rate' shows each frame's first field;
     * 'off' presents frames woven, as decoded. The choice outlives sessions and resolves once an executor for it is installed.
     * Throws 'deinterlace-mode' for a mode outside DEINTERLACE_MODES.
     */
    async setDeinterlaceMode(mode: DeinterlaceMode): Promise<void> {
        if (!DEINTERLACE_MODES.includes(mode)) {
            throw new RangeError(`deinterlace-mode: '${String(mode)}'`);
        }
        if (mode === this.deinterlaceMode) {
            return;
        }
        // Single and double rate plan alike, so only a change to or from 'off' builds an executor; the next draw shows the new rate
        if (this.changeDeinterlaceInputs((): void => {
            this.deinterlaceMode = mode;
        })) {
            await this.applyPlanInputs();
        }
    }

    getDeinterlaceMode(): DeinterlaceMode {
        return this.deinterlaceMode;
    }

    /**
     * Records an animation frame the frame loop presents in: its time, a DOMHighResTimeStamp in milliseconds, measures the display's refresh,
     * and the rate the clock advances at, 0 while it stands still, scales the media time one refresh covers.
     * Once the measured rate moves past DISPLAY_RATE_REPLAN_TOLERANCE from the rate plans read as display.rate, preset passes plan again with it
     * when a pass's condition reads display.rate; a draw reads the measured refresh itself, so a pass that times its draws plans once.
     */
    recordAnimationFrame(timeMilliseconds: number, clockRate: number): void {
        if (!Number.isFinite(clockRate) || clockRate < 0) {
            throw new RangeError(`clock-rate: ${clockRate}`);
        }
        this.clockRate = clockRate;
        this.displayRefresh.record(timeMilliseconds);
        const interval = this.displayRefresh.getIntervalMilliseconds();
        if (interval === null) {
            return;
        }
        const rate = MILLISECONDS_PER_SECOND / interval;
        const plannedRate = this.plannedDisplayRate;
        if (plannedRate !== null && Math.abs(rate - plannedRate) <= plannedRate * DISPLAY_RATE_REPLAN_TOLERANCE) {
            return;
        }
        this.plannedDisplayRate = rate;
        const conditionReadsRate = this.presetPasses.some((presetPass: PresetPass): boolean => isPlannedPresetPass(presetPass)
            && presetPass.manifest.when !== null
            && collectPassExpressionIdentifiers(presetPass.manifest.when).includes(GLOBAL_FACTS.displayRate));
        if (conditionReadsRate) {
            this.replanForPresetFacts();
        }
    }

    /**
     * Returns how far ahead of the clock the frame loop takes frames: while a plan deinterlaces, the newest held frame's duration, so the frame after it,
     * which deinterlacing reads as the next frame, arrives when the clock reaches the newest; while a plan draws at the display's rate, one refresh,
     * so a frame that starts within a refresh is in history when the refresh draws; 0 otherwise.
     * Presentation keeps the clock's time, so audio and video stay in step; decoding runs that much further ahead.
     */
    getFrameLookaheadMicroseconds(): number {
        if (this.executorPlan?.displayRate) {
            return Math.floor(this.getRefreshMicroseconds());
        }
        if (!this.executorPlan?.deinterlace || this.deinterlaceMode === 'off') {
            return 0;
        }
        return this.deinterlaceTimeline.getLookaheadMicroseconds();
    }

    /** Returns whether the frame shown waits for the frame after it, which deinterlacing reads, as a paused seek's first frame does. */
    awaitsLookaheadFrame(): boolean {
        return Boolean(this.executorPlan?.deinterlace) && this.deinterlaceMode !== 'off' && this.deinterlaceTimeline.awaitsNextFrame();
    }

    /**
     * Redraws from history alone when the clock reached another field, frame, or refresh than the one shown: a deinterlaced frame's second field,
     * the newest frame once the clock reaches it without a frame after it, or in a display-rate plan each refresh, whose passes blend by the clock;
     * returns whether it drew.
     * The frame loop calls it on every tick that takes no frame; a plan that neither deinterlaces nor draws at the display's rate draws nothing.
     * A redraw never carries a new executor's validation, which a frame's submission does, so redraws leave no validation pending for the next frame.
     */
    presentHeldFields(generation: number, targetTimeMicroseconds: Microseconds): boolean {
        if (
            !this.isCurrent(generation)
            || this.fallbackLatched
            || this.pendingColorConfiguration?.generation === generation
            || this.pendingSubmissionValidation
            || !this.submissionValidated
            || !this.hasReadyPresentationResources()
        ) {
            return false;
        }
        const draw = this.getHistoryDraw(targetTimeMicroseconds);
        if (draw === null || areDrawsEqual(draw, this.lastHistoryDraw)) {
            return false;
        }
        try {
            const submission = this.submitHistoryDraw(draw, targetTimeMicroseconds);
            if (!submission) {
                return false;
            }
            this.lastHistoryDraw = draw;
            const callbackTimeMicroseconds = getMonotonicMicroseconds();
            this.completeSubmission(submission, generation, (): void => {
                if (this.isCurrent(generation) && !this.fallbackLatched) {
                    this.recordPresentedFrame(submission.presentedTimeMicroseconds, callbackTimeMicroseconds, callbackTimeMicroseconds, 'decoded');
                }
            });
            return true;
        } catch (error) {
            this.fallback(generation, 'frame-render-failed', `history-draw: ${getErrorMessage(error)}`);
            return false;
        }
    }

    /** Returns what a draw from history shows at a clock time, or null when the plan draws nothing between frames or its history holds no frame. */
    private getHistoryDraw(clockMicroseconds: number): PresentationDraw | null {
        if (this.executorPlan?.displayRate) {
            const frames = this.displayRateFrames;
            return frames === null ? null : getDisplayRateDraw(frames, clockMicroseconds);
        }
        return this.executorPlan?.deinterlace ? this.getDeinterlaceDraw(clockMicroseconds) : null;
    }

    /** Returns the deinterlacing timeline's draw at a clock time, which shows the same until another field shows; null while the mode is off or history is empty. */
    private getDeinterlaceDraw(clockMicroseconds: number): PresentationDraw | null {
        if (this.deinterlaceMode === 'off') {
            return null;
        }
        const draw = this.deinterlaceTimeline.getDraw(clockMicroseconds, this.deinterlaceMode);
        return draw === null ? null : { ...draw, clockMicroseconds: null, presentedTimeMicroseconds: draw.timestampMicroseconds };
    }

    /** Returns the media time one display refresh covers: the measured refresh interval times the clock's rate, or 0 before a measurement or while the clock stands still. */
    private getRefreshMicroseconds(): number {
        const interval = this.displayRefresh.getIntervalMilliseconds();
        return interval === null ? 0 : interval * MICROSECONDS_PER_MILLISECOND * this.clockRate;
    }

    /** Follows whether frames come from the frame loop, which display-rate passes need; a change plans again while a preset pass draws at the display's rate. */
    private setDecodedFramePushActive(active: boolean): void {
        if (this.decodedFramePushActive === active) {
            return;
        }
        this.decodedFramePushActive = active;
        if (this.presetPasses.some((presetPass: PresetPass): boolean => isPlannedPresetPass(presetPass) && presetPass.manifest.rate === 'display')) {
            this.planRevision += 1;
            void this.applyPlanInputs();
        }
    }

    /**
     * Plans for what a decoded stream declares before its first frame, its chroma format and frame size, and builds that plan's executor, whose
     * pipelines compile with createRenderPipelineAsync; resolves once it is installed, or at once when the facts change no plan.
     * The first frame of those facts then presents without a replan, and a frame that differs replans as it would without them.
     * A stale generation, or one that fell back, changes nothing.
     */
    async prepareDecodedVideo(facts: DecodedVideoStreamFacts, generation: number): Promise<void> {
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }
        if (this.applyStreamFacts(null, { height: facts.frameHeight, width: facts.frameWidth }, facts.chromaFormat)) {
            await this.applyPlanInputs();
        }
    }

    /**
     * Follows what deinterlacing plans depend on in a frame: its visible size, which they run at, and whether it is interlaced, which makes the session's plans
     * deinterlace; a change starts building a plan for it, which later frames present with.
     */
    private followFrameFields(decodedFrame: DecodedPresentationFrame): void {
        const fields = this.getEffectiveFrameFields(decodedFrame.fields ?? null);
        if (this.applyStreamFacts(fields, getDecodedFrameVisibleSize(decodedFrame), decodedFrame.chromaFormat ?? null)) {
            void this.applyPlanInputs();
        }
    }

    /** Takes a frame's or a stream's fields, visible size, and chroma format into the plan facts; returns whether the plan revision advanced. */
    private applyStreamFacts(fields: VideoFrameFields | null, visibleSize: VisibleSize, chromaFormat: VideoChromaFormat | null): boolean {
        const previousFacts = this.videoFieldFacts;
        const previousChromaLocation = this.streamChromaLocation;
        const previousChromaSubsampling = this.streamChromaSubsampling;
        const changed = this.changeDeinterlaceInputs((): void => {
            if (fields !== null && fields.scan !== 'progressive') {
                this.interlacedFrameSeen = true;
            }
            this.videoFieldFacts = { ...this.videoFieldFacts, frameHeight: visibleSize.height, frameWidth: visibleSize.width };
        });
        this.streamChromaLocation = chromaFormat?.location ?? null;
        this.streamChromaSubsampling = chromaFormat?.subsampling ?? null;
        // Every route's signal or planes read chroma as the stream declares it, so a change replans whatever the preset; the planner returns the same plan,
        // which keeps its executor, where nothing reads it. Preset passes plan their planes at the frame's sample size.
        const chromaChanged = previousChromaLocation !== this.streamChromaLocation || previousChromaSubsampling !== this.streamChromaSubsampling;
        const sizeChanged = previousFacts.frameWidth !== visibleSize.width || previousFacts.frameHeight !== visibleSize.height;
        if (!changed && (chromaChanged || (sizeChanged && this.presetPasses.some(isPlannedPresetPass)))) {
            this.planRevision += 1;
            return true;
        }
        return changed;
    }

    /** Applies a change to what deinterlacing plans depend on; a change to the deinterlacing plans take advances the plan revision, and returns true. */
    private changeDeinterlaceInputs(change: () => void): boolean {
        const previousRequest = this.getDeinterlaceRequest();
        change();
        if (areDeinterlaceRequestsEqual(previousRequest, this.getDeinterlaceRequest())) {
            return false;
        }
        this.planRevision += 1;
        return true;
    }

    /** Starts a session's field facts over: an unknown scan and size, and no interlaced frame seen. */
    private resetVideoFieldFacts(): void {
        this.changeDeinterlaceInputs((): void => {
            this.interlacedFrameSeen = false;
            this.videoFieldFacts = UNKNOWN_VIDEO_STREAM_FIELDS;
        });
        this.streamChromaLocation = null;
        this.streamChromaSubsampling = null;
    }

    /**
     * Returns the deinterlacing pass plans take now, or null: none while the mode is off, before the frame size is known, on a Dolby Vision route,
     * which is progressive by its profiles, or while neither the stream's scan nor any frame was interlaced.
     */
    private getDeinterlaceRequest(): DeinterlaceRequest | null {
        const facts = this.videoFieldFacts;
        const bitDepth = getChainBitDepth(this.desiredChainConfiguration);
        if (this.deinterlaceMode === 'off' || bitDepth === null || facts.frameWidth === null || facts.frameHeight === null) {
            return null;
        }
        if (!this.interlacedFrameSeen && !isInterlacedScan(facts.scan)) {
            return null;
        }
        return { bitDepth, frameHeight: facts.frameHeight, frameWidth: facts.frameWidth };
    }

    /**
     * Builds the executor for changed plan inputs during a session and redraws with it; concurrent callers share one run, which builds for the newest revision before it ends.
     * Outside a session, or before the device exists, the next executor built takes the inputs, so nothing is built ahead of a play request; a failed build falls the session back.
     */
    private applyPlanInputs(): Promise<void> {
        if (!this.sessionActive) {
            return Promise.resolve();
        }
        this.planInputsApplication ??= this.runPlanInputsApplication();
        return this.planInputsApplication;
    }

    private async runPlanInputsApplication(): Promise<void> {
        const generation = this.activeGeneration;
        const previousExecutor = this.executor;
        const previousPresetPasses = this.executorPresetPasses;
        let failure: string | null = null;
        try {
            do {
                failure = await this.ensureDesiredExecutor();
            } while (failure === null && this.executorRevision !== this.planRevision);
        } finally {
            // Cleared in the same microtask as the last revision check, so a later change starts a run of its own
            this.planInputsApplication = null;
        }
        if (this.device === null || !this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }
        if (failure !== null) {
            this.fallback(generation, 'pipeline-creation-failed', failure);
            return;
        }
        // A kept executor redraws as well when it took a new preset's values
        if (this.executor !== previousExecutor || this.executorPresetPasses !== previousPresetPasses) {
            this.redrawCurrentFrame(generation);
        }
    }

    /** Redraws the presented frame after a change to its pixels: a pushed session asks the host to present again, and a paused element redraws its frame. */
    private redrawCurrentFrame(generation: number): void {
        if (this.decodedFramePushActive) {
            this.requestDecodedPresentationRefresh(generation);
            return;
        }
        if (this.surface?.video.paused) {
            this.renderCurrentFrameOrFallback(generation);
        }
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
                case 'frame-pool':
                    return this.prepareFramePoolColorPipeline(configuration, pendingConfiguration);
                case 'frame-pool-dolby-vision':
                    return this.prepareFramePoolDolbyVisionColorPipeline(configuration, pendingConfiguration);
                case 'raw-dolby-vision':
                    return this.prepareRawDolbyVisionColorPipeline(configuration, pendingConfiguration);
                case 'raw-yuv':
                    return this.prepareRawHDRColorPipeline(configuration, pendingConfiguration);
            }
        }

        try {
            assertValidInputColorMetadata(configuration.metadata);
            assertValidRenderSettings(configuration.settings);
        } catch (error) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid', getErrorMessage(error));
            return null;
        }
        return {
            chainConfiguration: { metadata: { ...configuration.metadata }, route: 'external-identity' },
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
        const authorizationFailure = this.getExternalDolbyVisionAuthorizationFailure(configuration.profile);
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
        if (configuration.codec !== 'av1' && configuration.codec !== 'hevc') {
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid', `codec: ${String(configuration.codec)}, expected av1 or hevc`);
            return null;
        }
        if (!getExternalHDRAuthorizationRouteKey(configuration.codec, configuration.metadata)) {
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
        const authorizationFailure = this.getExternalHDRAuthorizationFailure(configuration.codec, configuration.metadata);
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
            externalHDRCodec: configuration.codec,
            inputColorMetadata: { ...configuration.metadata },
            rawFrameFormat: null,
            settings: cloneRenderSettings(configuration.settings)
        };
    }

    /** Prepares the GPU decode route's chain: the frame pool signal and the raw route's color track, without a presentation authorization. */
    private async prepareFramePoolColorPipeline(
        configuration: FramePoolColorPipelineConfiguration,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<PreparedColorPipeline | null> {
        const configurationFailure = getPlanarColorConfigurationFailure(configuration.metadata, configuration.format, configuration.settings);
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

        const chainConfiguration: BuiltinChainConfiguration = {
            format: configuration.format,
            hdrOutput: false,
            metadata: { ...configuration.metadata },
            route: 'frame-pool',
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
            inputMode: 'frame-pool',
            inputColorMetadata: { ...configuration.metadata },
            rawFrameFormat: configuration.format,
            settings: cloneRenderSettings(configuration.settings)
        };
    }

    private async prepareRawHDRColorPipeline(
        configuration: RawHDRColorPipelineConfiguration,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<PreparedColorPipeline | null> {
        const configurationFailure = getPlanarColorConfigurationFailure(configuration.metadata, configuration.rawFrameFormat, configuration.settings);
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

    /**
     * Prepares the GPU decode route's Dolby Vision chain: the frame pool's reconstruction signal and the raw route's Dolby Vision color track.
     * The raw route's base key of the BL format authorizes it, since it is the raw route's reconstruction over the frame pool's read.
     * A frame pool holds no EL, so a dual-layer route never composes one and needs no FEL key.
     * Its input mode stays the frame pool's, with the profile active, so frames arrive as pool slots.
     */
    private async prepareFramePoolDolbyVisionColorPipeline(
        configuration: FramePoolDolbyVisionColorPipelineConfiguration,
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
        const format = configuration.format;
        if (!isGPUDecoderOutputFormat(format)) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-color-configuration-invalid', `format: ${String(format)} is not a GPU decoder output format`);
            return null;
        }

        if (!await this.awaitHDRConfigurationPrerequisites(pendingConfiguration)) {
            return null;
        }
        const baseAuthorizationFailure = this.getRawDolbyVisionAuthorizationFailure(
            this.getRawDolbyVisionAuthorizations(configuration.profile, format).base,
            format
        );
        if (baseAuthorizationFailure !== null) {
            this.failColorConfiguration(pendingConfiguration, 'hdr-authorization-unavailable', baseAuthorizationFailure);
            return null;
        }
        const chainConfiguration: BuiltinChainConfiguration = {
            format,
            hdrOutput: false,
            profile: configuration.profile,
            route: 'frame-pool-dolby-vision',
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
            inputMode: 'frame-pool',
            inputColorMetadata: null,
            rawFrameFormat: format,
            settings: cloneRenderSettings(configuration.settings)
        };
    }

    private getRawHDRAuthorizationFailure(metadata: InputColorMetadata, format: SupportedRawVideoFrameFormat): string | null {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (!device || !targetFormat) {
            return 'device: unavailable';
        }
        return this.rawHDRAuthorization.getAuthorizationFailure(device, targetFormat, metadata, format);
    }

    private getExternalHDRAuthorizationFailure(codec: ExternalHDRVideoCodec, metadata: InputColorMetadata): string | null {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (!device || !targetFormat) {
            return 'device: unavailable';
        }
        return this.externalHDRAuthorization.getAuthorizationFailure(device, targetFormat, codec, metadata);
    }

    /** Returns why the active external HDR route is not authorized for its codec and the metadata, including a mode that tone maps nothing. */
    private getActiveExternalHDRAuthorizationFailure(metadata: InputColorMetadata): string | null {
        if (this.settings.mode !== 'hdr-to-sdr') {
            return `mode: ${this.settings.mode}, expected hdr-to-sdr`;
        }
        return this.activeExternalHDRCodec === null ?
            'codec: none configured' :
            this.getExternalHDRAuthorizationFailure(this.activeExternalHDRCodec, metadata);
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

    private getExternalDolbyVisionAuthorizationRegistry(profile: ExternalDolbyVisionProfile): ExternalDolbyVisionPresentationAuthorizationRegistry {
        return profile === 5 ? this.externalDolbyVisionAuthorization : this.externalDolbyVisionProfile8Authorization;
    }

    private getExternalDolbyVisionAuthorizationFailure(profile: ExternalDolbyVisionProfile): string | null {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (!device || !targetFormat) {
            return 'device: unavailable';
        }
        return this.getExternalDolbyVisionAuthorizationRegistry(profile).getAuthorizationFailure(device, targetFormat);
    }

    /** Returns why the active external Dolby Vision route is not authorized for its profile, including a mode that tone maps nothing. */
    private getActiveExternalDolbyVisionAuthorizationFailure(): string | null {
        const profile = this.activeDolbyVisionProfile;
        if (profile !== 5 && profile !== 8) {
            return `profile: ${profile}, expected 5 or 8`;
        }
        return this.settings.mode === 'hdr-to-sdr' ?
            this.getExternalDolbyVisionAuthorizationFailure(profile) :
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
                // The executor may have been released or replaced since the plan matched it
                if (this.executor === result.executor) {
                    this.adoptPlan(result, revision);
                }
                return null;
            case 'failed':
                return result.detail;
            case 'built':
                if (this.deviceResourceEpoch !== resourceEpoch || this.device !== device || this.planRevision !== revision) {
                    result.executor.destroy();
                    return null;
                }
                this.installExecutor(result, revision);
                return null;
        }
    }

    /**
     * Plans the route's chain and the preset for the current facts and creates its executor, unless the active executor already renders that plan.
     * A preset pass that fails to compile is excluded with its error, and the plan is rebuilt without it.
     */
    private async buildExecutor(device: GPUDevice, canvasFormat: GPUTextureFormat): Promise<ExecutorBuildResult> {
        // A preset replaced during the build excludes nothing from its successor
        const presetPasses = this.presetPasses;
        for (;;) {
            let plan: PresentationPlan;
            try {
                plan = planPresentation(this.createPlanRequest(device, canvasFormat, presetPasses));
            } catch (error) {
                return { detail: `plan: ${getErrorMessage(error)}`, kind: 'failed' };
            }
            const planKey = getPlanKey(plan);
            if (this.executor && this.device === device && this.executorPlanKey === planKey) {
                return { executor: this.executor, kind: 'current', plan, presetPasses };
            }
            const executorPromise = this.createExecutor(device, plan, presetPasses);
            let executorResult: PresentationExecutor | typeof WEBGPU_RESOURCE_OPERATION_TIMEOUT;
            try {
                executorResult = await waitForWebGPUResourceOperation(executorPromise);
            } catch (error) {
                if (error instanceof PresentationCompileError && excludeCompileFailures(error, plan, presetPasses)) {
                    continue;
                }
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
            return { executor: executorResult, kind: 'built', plan, planKey, presetPasses };
        }
    }

    /**
     * Returns the plan request of the route's chain and the planned preset passes: the canvas output, HDR while HDR output is active, and the best-known facts.
     * Display-rate passes plan while frames come from the frame loop, which draws between them.
     */
    private createPlanRequest(device: GPUDevice, canvasFormat: GPUTextureFormat, presetPasses: readonly PresetPass[]): PlanRequest {
        const hdrOutput = this.isHDROutputActive();
        const deinterlace = this.getDeinterlaceRequest();
        const configuration = withStreamChroma(this.desiredChainConfiguration, this.streamChromaSubsampling, this.streamChromaLocation);
        return {
            chain: createBuiltinChain(withInterlacedChroma(withHDROutput(configuration, hdrOutput), deinterlace !== null)),
            deinterlace,
            displayRateAvailable: this.decodedFramePushActive,
            device: {
                features: device.features,
                maximumTextureDimension: device.limits.maxTextureDimension2D
            },
            facts: this.getPlanFacts(hdrOutput),
            output: createPlannedOutput(hdrOutput, canvasFormat),
            parameterValues: getPlannedParameterValues(presetPasses),
            passes: getPlannedManifests(presetPasses)
        };
    }

    /** Returns whether plans present on the HDR canvas: the host selected HDR output and the route reads an HDR signal. */
    private isHDROutputActive(): boolean {
        return this.hdrOutputEnabled && isHDRSourceConfiguration(this.desiredChainConfiguration);
    }

    /**
     * Returns the plan facts the presenter knows: the last measured source and output sizes, 1x1 until a frame measures them,
     * the stream's declared frame rate, and the display's measured rate.
     */
    private getPlanFacts(hdrOutput: boolean): PlanFacts {
        const layout = this.cachedPresentationLayout;
        const sourceHeight = layout ? Math.max(layout.videoHeight, UNKNOWN_PLAN_DIMENSION) : UNKNOWN_PLAN_DIMENSION;
        const sourceWidth = layout ? Math.max(layout.videoWidth, UNKNOWN_PLAN_DIMENSION) : UNKNOWN_PLAN_DIMENSION;
        return {
            displayRate: this.plannedDisplayRate,
            frameRate: this.streamFrameRate,
            hdrOutput,
            hdrSource: isHDRSourceConfiguration(this.desiredChainConfiguration),
            outputHeight: layout ? Math.max(layout.presentation.viewportHeight, UNKNOWN_PLAN_DIMENSION) : UNKNOWN_PLAN_DIMENSION,
            outputWidth: layout ? Math.max(layout.presentation.viewportWidth, UNKNOWN_PLAN_DIMENSION) : UNKNOWN_PLAN_DIMENSION,
            // Until a frame measures its samples, the planes take the source's size
            sampleHeight: Math.max(this.videoFieldFacts.frameHeight ?? sourceHeight, UNKNOWN_PLAN_DIMENSION),
            sampleWidth: Math.max(this.videoFieldFacts.frameWidth ?? sourceWidth, UNKNOWN_PLAN_DIMENSION),
            sourceHeight,
            sourceWidth
        };
    }

    /**
     * Swaps in a new executor: it takes over the render settings and its preset's parameter values, the old one is destroyed, and an attached canvas is configured for its output.
     * A canvas that cannot take the new output falls the session back.
     */
    private installExecutor(build: BuiltExecutor, revision: number): void {
        const previousExecutor = this.executor;
        const executor = build.executor;
        this.executor = executor;
        this.executorPlan = build.plan;
        this.executorPlanKey = build.planKey;
        this.executorPresetPasses = build.presetPasses;
        this.executorRevision = revision;
        this.submissionValidated = false;
        if (this.renderSettingsData) {
            executor.writeRenderSettings(this.renderSettingsData);
        }
        applyParameterValues(executor, build.plan, build.presetPasses);
        previousExecutor?.destroy();
        // The installed plan's texture blocks and the current preset's stay; a replaced preset's are released
        const retainedTextures = new Set<string>(collectPassTextures(getPlannedManifests(this.presetPasses)).keys());
        for (const texture of build.plan.passTextures) {
            retainedTextures.add(texture.id);
        }
        this.passTextureCache?.retain(retainedTextures);
        // A new executor's history starts empty
        this.resetHeldFrames();
        if (this.canvasContext && !this.createAndConfigureCanvas()) {
            this.fallback(this.activeGeneration, this.initializationFailureReason, this.initializationFailureDetail);
        }
    }

    /**
     * Hands the active executor a plan of its key, which differs from its own plan only in the report, as when a new preset adds no pass to the plan.
     * A new preset's values replace the executor's over the declared defaults, as a new executor would take them.
     */
    private adoptPlan(current: CurrentExecutor, revision: number): void {
        if (this.executorPresetPasses !== current.presetPasses) {
            current.executor.writeDefaultParameters();
            applyParameterValues(current.executor, current.plan, current.presetPasses);
        }
        this.executorPlan = current.plan;
        this.executorPresetPasses = current.presetPasses;
        this.executorRevision = revision;
    }

    private releaseExecutor(): void {
        const executor = this.executor;
        this.executor = null;
        this.executorPlan = null;
        this.executorPlanKey = null;
        this.executorPresetPasses = null;
        this.executorRevision = -1;
        executor?.destroy();
        // The texture blocks upload again when a later plan binds them
        this.passTextureCache?.destroy();
        this.passTextureCache = null;
        this.resetHeldFrames();
    }

    /** Creates a plan's executor over the uploads of its texture blocks, which the preset's passes hold and the device's cache keeps. */
    private async createExecutor(device: GPUDevice, plan: PresentationPlan, presetPasses: readonly PresetPass[]): Promise<PresentationExecutor> {
        const passTextureViews = this.getPassTextureCache(device).acquire(plan, collectPassTextures(getPlannedManifests(presetPasses)));
        return PresentationExecutor.create(device, plan, passTextureViews);
    }

    /** Returns the upload cache of texture blocks on the device, a new one for a new device. */
    private getPassTextureCache(device: GPUDevice): PassTextureCache {
        if (this.passTextureCache === null || this.passTextureCacheDevice !== device) {
            this.passTextureCache?.destroy();
            this.passTextureCache = new PassTextureCache(device);
            this.passTextureCacheDevice = device;
        }
        return this.passTextureCache;
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
            // A default device stops textures at 8192 texels and buffers at 256 MiB; the adapter's own maxima take any larger frame, and a GPU decoder's frame pool, which is one buffer
            const devicePromise = adapter.requestDevice({
                requiredLimits: {
                    maxBufferSize: adapter.limits.maxBufferSize,
                    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
                    maxTextureDimension2D: adapter.limits.maxTextureDimension2D
                }
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
        this.installExecutor(result, revision);
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
                fields: null,
                newFrame: true,
                targetTimeMicroseconds: null,
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
        generation: number,
        targetTimeMicroseconds: number | null
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
                const frameFailure = (profile === 5 || profile === 8 ? null : `profile: ${profile}, expected 5 or 8`)
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
                    getNeutralBT709FrameColorFailure(frame, true)
                        ?? prefixFailure('authorization', this.getActiveExternalHDRAuthorizationFailure(metadata)) :
                    'metadata: none configured';
                if (frameFailure !== null) {
                    this.fallback(generation, 'decoded-frame-color-mismatch', frameFailure);
                    return null;
                }
                break;
            }
            case 'frame-pool':
                this.fallback(generation, 'decoded-frame-color-mismatch', 'input-mode: frame-pool takes frame pool slots, not a VideoFrame');
                return null;
            case 'raw-dolby-vision':
            case 'raw-yuv':
                this.fallback(generation, 'decoded-frame-color-mismatch', `input-mode: ${this.activeInputMode} takes raw planes, not a VideoFrame`);
                return null;
        }

        const frameWidth = frame.displayWidth || frame.codedWidth;
        const frameHeight = frame.displayHeight || frame.codedHeight;
        return this.submitFrame(
            { kind: 'external', source: frame },
            frameWidth,
            frameHeight,
            this.getDecodedFrameTiming(decodedFrame, targetTimeMicroseconds)
        );
    }

    private renderDecodedRawFrame(
        decodedFrame: DecodedRawPresentationFrame,
        generation: number,
        targetTimeMicroseconds: number | null
    ): FrameSubmission | null {
        const format = this.activeRawFrameFormat;
        if (!format) {
            this.fallback(generation, 'decoded-frame-color-mismatch', 'raw-format: none configured');
            return null;
        }
        switch (this.activeInputMode) {
            case 'raw-yuv':
                return this.renderDecodedRawYUVFrame(decodedFrame, generation, format, targetTimeMicroseconds);
            case 'raw-dolby-vision':
                return this.renderDecodedRawDolbyVisionFrame(decodedFrame, generation, format, targetTimeMicroseconds);
            case 'external-dolby-vision':
            case 'external-hdr':
            case 'external-texture':
                this.fallback(generation, 'decoded-frame-color-mismatch', `input-mode: ${this.activeInputMode} takes a VideoFrame, not raw planes`);
                return null;
            case 'frame-pool':
                this.fallback(generation, 'decoded-frame-color-mismatch', 'input-mode: frame-pool takes frame pool slots, not raw planes');
                return null;
        }
    }

    /**
     * Presents a GPU decoder's pool slot in place; its slot stays the decoder's to reuse once this submit is queued, since later decode work runs after it.
     * A Dolby Vision route reconstructs the slot through its frame's RPU.
     */
    private renderDecodedFramePoolFrame(
        decodedFrame: DecodedFramePoolPresentationFrame,
        generation: number,
        targetTimeMicroseconds: number | null
    ): FrameSubmission | null {
        const frame = decodedFrame.frame;
        const rectangle = frame.visibleRectangle;
        const profile = this.activeDolbyVisionProfile;
        let frameFailure: string | null = null;
        if (this.activeInputMode !== 'frame-pool') {
            frameFailure = `input-mode: ${this.activeInputMode} takes no frame pool slots`;
        } else if (this.activeInputColorMetadata === null && profile === null) {
            frameFailure = 'metadata: none configured';
        } else if (
            rectangle.width <= 0
            || rectangle.height <= 0
            || rectangle.x + rectangle.width > frame.codedWidth
            || rectangle.y + rectangle.height > frame.codedHeight
        ) {
            frameFailure = `geometry: visible ${rectangle.x},${rectangle.y} ${rectangle.width}x${rectangle.height} exceeds coded ${frame.codedWidth}x${frame.codedHeight}`;
        }
        if (frameFailure !== null) {
            this.fallback(generation, 'decoded-frame-color-mismatch', frameFailure);
            return null;
        }
        if (profile !== null) {
            return this.renderDecodedFramePoolDolbyVisionFrame(decodedFrame, generation, profile, targetTimeMicroseconds);
        }
        return this.submitFrame(
            { frame, kind: 'frame-pool' },
            decodedFrame.displayWidth,
            decodedFrame.displayHeight,
            this.getDecodedFrameTiming(decodedFrame, targetTimeMicroseconds)
        );
    }

    /**
     * Presents a Dolby Vision BL slot through its frame's RPU, with the raw route's per-frame checks against the bit depth of the slot's format, which must be the route's.
     * A frame pool holds no EL, so a dual-layer FEL frame presents its compatible base.
     */
    private renderDecodedFramePoolDolbyVisionFrame(
        decodedFrame: DecodedFramePoolPresentationFrame,
        generation: number,
        profile: DolbyVisionReconstructionProfile,
        targetTimeMicroseconds: number | null
    ): FrameSubmission | null {
        const executor = this.executor;
        const format = this.activeRawFrameFormat;
        const dolbyVision = decodedFrame.dolbyVision;
        let frameFailure: string | null = null;
        if (format === null) {
            frameFailure = 'format: none configured';
        } else if (!dolbyVision) {
            frameFailure = 'dolby-vision: missing';
        } else if (dolbyVision.format !== format) {
            frameFailure = `format: ${dolbyVision.format}, expected ${format}`;
        } else {
            frameFailure = prefixFailure('authorization', this.getActiveRawDolbyVisionAuthorizationFailure(format, profile));
        }
        if (frameFailure !== null || !executor || !dolbyVision) {
            this.fallback(generation, 'decoded-frame-color-mismatch', frameFailure ?? 'executor: unavailable');
            return null;
        }
        const rpu = getDolbyVisionFrameRPUData(dolbyVision.encodedMetadata, profile, getGPUDecoderFormatFacts(dolbyVision.format).bitDepth, false);
        if (rpu.failure !== null) {
            this.fallback(generation, 'dolby-vision-metadata-invalid', rpu.failure);
            return null;
        }
        executor.writeDolbyVisionRPU(rpu.data.packedRPUData);
        const submission = this.submitFrame(
            { frame: decodedFrame.frame, kind: 'frame-pool' },
            decodedFrame.displayWidth,
            decodedFrame.displayHeight,
            this.getDecodedFrameTiming(decodedFrame, targetTimeMicroseconds)
        );
        const dualLayerRPUData = rpu.data.dualLayer;
        if (!submission || !dualLayerRPUData) {
            return submission;
        }
        return {
            ...submission,
            dolbyVisionDualLayerMode: getDualLayerPresentation(dualLayerRPUData, null)
        };
    }

    private renderDecodedRawYUVFrame(
        decodedFrame: DecodedRawPresentationFrame,
        generation: number,
        format: SupportedRawVideoFrameFormat,
        targetTimeMicroseconds: number | null
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
            this.getDecodedFrameTiming(decodedFrame, targetTimeMicroseconds)
        );
    }

    private renderDecodedRawDolbyVisionFrame(
        decodedFrame: DecodedRawPresentationFrame,
        generation: number,
        format: SupportedRawVideoFrameFormat,
        targetTimeMicroseconds: number | null
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

        const rpu = getDolbyVisionFrameRPUData(
            decodedFrame.encodedDolbyVisionMetadata,
            profile,
            decodedFrame.frame.bitDepth,
            Boolean(decodedFrame.enhancementFrame)
        );
        if (rpu.failure !== null) {
            this.fallback(generation, 'dolby-vision-metadata-invalid', rpu.failure);
            return null;
        }
        const dualLayerRPUData = rpu.data.dualLayer;
        executor.writeDolbyVisionRPU(rpu.data.packedRPUData);
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
            this.getDecodedFrameTiming(decodedFrame, targetTimeMicroseconds)
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
     * A plan that deinterlaces takes the frame into its history, and shows the field of the held frame the frame's target time reaches;
     * a display-rate plan takes it as its history's newest frame, and draws it at its target time.
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
            this.frameInterval.record(timing.timestampMicroseconds, timing.durationMicroseconds);
        }
        const draw = this.prepareFrameDraw(source, timing);
        return this.encodeSubmission(device, canvasContext, executor, layout, {
            fieldState: draw.fieldState,
            newFrame: timing.newFrame,
            presentedTimeMicroseconds: draw.presentedTimeMicroseconds,
            source,
            targetTimeMicroseconds: timing.targetTimeMicroseconds ?? timing.timestampMicroseconds,
            timestampMicroseconds: draw.timestampMicroseconds
        });
    }

    /**
     * Returns what a frame's submission shows: in a plan that deinterlaces, the frame enters the timeline as a new frame, and the draw is the field the
     * frame's target time reaches; in a display-rate plan, the frame becomes its history's newest, drawn at its target time; otherwise the frame itself.
     * A frame of another size than the plan's presents as it is, since its rows no longer match the plan's fields; a plan for its size follows.
     */
    private prepareFrameDraw(source: PresentationFrameSource, timing: FrameTiming): PresentationDraw {
        const clockMicroseconds = timing.targetTimeMicroseconds ?? timing.timestampMicroseconds;
        if (this.executorPlan?.displayRate) {
            // A redrawn frame leaves history as it is, unless it is the first frame a new executor's history holds
            const frames: DisplayRateFrames = timing.newFrame || this.displayRateFrames === null ?
                { newestMicroseconds: timing.timestampMicroseconds, previousMicroseconds: this.displayRateFrames?.newestMicroseconds ?? null } :
                this.displayRateFrames;
            this.displayRateFrames = frames;
            const draw = getDisplayRateDraw(frames, clockMicroseconds);
            this.lastHistoryDraw = draw;
            return draw;
        }
        const unchangedDraw: PresentationDraw = {
            clockMicroseconds: null,
            fieldState: PRESENTATION_FIELD_STATE.none,
            presentedTimeMicroseconds: timing.timestampMicroseconds,
            timestampMicroseconds: timing.timestampMicroseconds
        };
        const deinterlace = this.executorPlan?.deinterlace ?? null;
        if (deinterlace === null) {
            return unchangedDraw;
        }
        const visibleSize = getSourceVisibleSize(source);
        const fitsPlan = visibleSize.width === deinterlace.frameWidth && visibleSize.height === deinterlace.frameHeight;
        const fields = fitsPlan ? this.getEffectiveFrameFields(timing.fields) : null;
        // The plan's signal reads an interlaced frame's 4:2:0 chroma within each field, whichever field shows
        const signalState = fields !== null && fields.scan !== 'progressive' ? PRESENTATION_FIELD_STATE.interlacedSignal : PRESENTATION_FIELD_STATE.none;
        if (timing.newFrame) {
            this.deinterlaceTimeline.push({
                durationMicroseconds: timing.durationMicroseconds ?? 0,
                fields,
                timestampMicroseconds: timing.timestampMicroseconds
            });
        }
        const draw = this.getDeinterlaceDraw(clockMicroseconds);
        if (draw === null) {
            return { ...unchangedDraw, fieldState: signalState };
        }
        this.lastHistoryDraw = draw;
        return { ...draw, fieldState: draw.fieldState | signalState };
    }

    /** Returns a frame's fields: its own, or its stream's scan; null when both are unknown, so it presents as it is. */
    private getEffectiveFrameFields(fields: VideoFrameFields | null): VideoFrameFields | null {
        return fields ?? getScanFrameFields(this.videoFieldFacts.scan);
    }

    /** Records one frame input through the executor into the canvas and submits it, inside a validation scope until a submission validated. */
    private encodeSubmission(
        device: GPUDevice,
        canvasContext: GPUCanvasContext,
        executor: PresentationExecutor,
        layout: CachedPresentationLayout,
        frame: Pick<PresentationFrameInput, 'fieldState' | 'newFrame' | 'source' | 'targetTimeMicroseconds' | 'timestampMicroseconds'>
            & Pick<PresentationDraw, 'presentedTimeMicroseconds'>
    ): FrameSubmission {
        const validateSubmission = !this.submissionValidated;
        if (validateSubmission) {
            device.pushErrorScope(VALIDATION_ERROR_FILTER);
        }

        try {
            const commandEncoder = device.createCommandEncoder();
            executor.encode(commandEncoder, {
                fieldState: frame.fieldState,
                frameDurationMicroseconds: this.frameInterval.getIntervalMicroseconds(),
                geometry: layout.presentation,
                newFrame: frame.newFrame,
                refreshMicroseconds: this.getRefreshMicroseconds(),
                skippedFrameCount: 0,
                source: frame.source,
                target: canvasContext.getCurrentTexture().createView(),
                targetTimeMicroseconds: frame.targetTimeMicroseconds,
                timestampMicroseconds: frame.timestampMicroseconds
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
            presentedTimeMicroseconds: requireMicroseconds(frame.presentedTimeMicroseconds, 'Presented frame time'),
            validationResult: validateSubmission ? device.popErrorScope() : null
        };
    }

    /** Records a draw from history alone at a clock time, at the last frame's layout; returns null while the surface has no layout box. */
    private submitHistoryDraw(draw: PresentationDraw, clockMicroseconds: number): FrameSubmission | null {
        const surface = this.surface;
        const canvas = this.canvas;
        const canvasContext = this.canvasContext;
        const device = this.device;
        const executor = this.executor;
        const cachedLayout = this.cachedPresentationLayout;
        if (!surface || !canvas || !canvasContext || !device || !executor || !cachedLayout) {
            throw new Error('presentation-resources: incomplete');
        }
        const layout = this.getPresentationLayout(surface, canvas, device, cachedLayout.videoWidth, cachedLayout.videoHeight);
        if (!layout) {
            return null;
        }
        return this.encodeSubmission(device, canvasContext, executor, layout, {
            fieldState: draw.fieldState,
            newFrame: false,
            presentedTimeMicroseconds: draw.presentedTimeMicroseconds,
            source: null,
            targetTimeMicroseconds: clockMicroseconds,
            timestampMicroseconds: draw.timestampMicroseconds
        });
    }

    /** Starts history and the frame interval over before a new frame whose epoch changed, whose timestamp went back, or that jumped past 2.5 frame durations. */
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
            this.resetHeldFrames();
            this.frameInterval.reset();
        }
    }

    /**
     * Returns a pushed frame's timing.
     * The host re-pushes the frame it last presented for a layout refresh; that frame is a redraw, which never advances history.
     */
    private getDecodedFrameTiming(decodedFrame: DecodedPresentationFrame, targetTimeMicroseconds: number | null): FrameTiming {
        const videoEpoch = decodedFrame.videoEpoch ?? null;
        const lastNewFrame = this.lastNewFrame;
        const repeatsLastNewFrame = lastNewFrame !== null
            && lastNewFrame.timestampMicroseconds === decodedFrame.mediaTimeMicroseconds
            && lastNewFrame.videoEpoch === videoEpoch;
        return {
            durationMicroseconds: decodedFrame.durationMicroseconds,
            fields: decodedFrame.fields ?? null,
            newFrame: !repeatsLastNewFrame,
            targetTimeMicroseconds,
            timestampMicroseconds: decodedFrame.mediaTimeMicroseconds,
            videoEpoch
        };
    }

    /** Starts temporal history and the frame interval over for a seek or a new generation; the next frame follows nothing. */
    private resetPresentationHistory(): void {
        this.lastNewFrame = null;
        this.frameInterval.reset();
        this.executor?.resetHistory();
        this.resetHeldFrames();
    }

    /**
     * Forgets the frames the executor's history holds, which a new executor or a history reset empties: the deinterlacing timeline,
     * a display-rate plan's newest frames, and the last draw.
     */
    private resetHeldFrames(): void {
        this.deinterlaceTimeline.reset();
        this.displayRateFrames = null;
        this.lastHistoryDraw = null;
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
        void waitForGPUCompletion(device, device.queue.onSubmittedWorkDone()).then((): void => notify(true), (): void => notify(false));
    }

    /** Waits the bounded raw SDR prewarm used for negotiation, with a stream's own raw key when given, which authorizes on first use. */
    async waitForRawSDRAuthorizationPrewarm(routeKey: RawHDRAuthorizationRouteKey | null = null): Promise<void> {
        await waitForRawHDRNegotiationProbe(
            this.prewarmRawSDRPresentationAuthorization(routeKey).then((): Promise<void> => {
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
            // The canvas covers the video's box, which a video with display: none lacks
            this.telemetry.presentationSkipReason = `${SURFACE_EMPTY_SKIP_REASON}: video box ${videoRectangle.width}x${videoRectangle.height}`;
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
            this.telemetry.presentationSkipReason = `${SOURCE_SIZE_EMPTY_SKIP_REASON}: ${sourceWidth}x${sourceHeight}`;
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
        if (!cachedLayout || !layoutPlanSizesMatch(cachedLayout, layout)) {
            this.replanForPresetFacts();
        }
        return layout;
    }

    /**
     * Replans for new facts, output or source sizes or the display's rate, while preset passes take part in plans, whose sizes and conditions read them;
     * default plans never depend on them.
     */
    private replanForPresetFacts(): void {
        if (!this.presetPasses.some(isPlannedPresetPass)) {
            return;
        }
        this.planRevision += 1;
        void this.applyPlanInputs();
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
        this.telemetry.presentationSkipReason = null;
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
                fields: null,
                newFrame: false,
                targetTimeMicroseconds: null,
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
        // The GPU decoder's pool and pipelines died with the device, so its route ends rather than recovering
        if (this.activeInputMode === 'frame-pool') {
            this.fallback(generation, 'device-recovery-failed', 'gpu-decode: the decoder\'s device was lost');
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
        const codec = this.activeExternalHDRCodec;
        if (!device || !targetFormat || !metadata || !codec) {
            return 'route: incomplete';
        }
        if (this.settings.mode !== 'hdr-to-sdr') {
            return `mode: ${this.settings.mode}, expected hdr-to-sdr`;
        }
        const routeKey = getExternalHDRAuthorizationRouteKey(codec, metadata);
        if (routeKey) {
            await this.externalHDRAuthorization.authorize(device, targetFormat, routeKey);
        }
        return this.isReauthorizationCurrent(generation, device) ?
            this.externalHDRAuthorization.getAuthorizationFailure(device, targetFormat, codec, metadata) :
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
        const activeProfile = this.activeDolbyVisionProfile;
        if (this.activeInputMode === 'external-dolby-vision' && (activeProfile === 5 || activeProfile === 8)) {
            const registry = this.getExternalDolbyVisionAuthorizationRegistry(activeProfile);
            await registry.authorize(device, targetFormat);
            return this.isReauthorizationCurrent(generation, device) ?
                registry.getAuthorizationFailure(device, targetFormat) :
                'superseded';
        }
        const rawFrameFormat = this.activeRawFrameFormat;
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
