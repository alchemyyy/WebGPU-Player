import {
    createHDRToSDRRenderSettings,
    createRenderSettingsUniformData,
    RENDER_SETTINGS_VERSION,
    type HDRToSDRRenderSettings
} from '../presentation/RenderSettings';
import {
    createHLGColorMetadata,
    createPQColorMetadata,
    type InputColorMetadata
} from '../color/ColorMetadata';
import {
    processEncodedYUV,
    type ColorTriplet
} from '../color/ColorPipeline';
import {
    applyExternalFrameCalibration,
    fitExternalFrameCalibration,
    isUnclippedExternalFrameRGB,
    recoverLimitedRangeBT709Codes,
    type ExternalFrameCalibration,
    type ExternalFrameCalibrationSample
} from '../color/ExternalFrameCalibration';
import { rewriteHEVCAccessUnitColorDescriptionToBT709 } from '../demux/dolby-vision/DolbyVisionHEVCSplitter';
import { rewriteAV1TemporalUnitColorToBT709 } from '../decode/video/native/NativeHDRAV1ColorNeutralizer';
import { waitForGPUCompletion } from '../GPUCompletion';
import { createBuiltinChain } from '../presentation/passes/builtin/BuiltinChains';
import { createExternalIdentitySignal } from '../presentation/passes/builtin/BuiltinSignals';
import type { BuiltinChain, BuiltinChainConfiguration } from '../presentation/passes/PassTypes';
import type { PresentationExecutor } from '../presentation/passes/PresentationExecutor';
import { INTERMEDIATE_TEXTURE_FORMAT } from '../presentation/WebGPUConstants';
import {
    createExternalAV1HDRAuthorizationTemporalUnit,
    EXTERNAL_AV1_HDR_AUTHORIZATION_CODEC,
    EXTERNAL_AV1_HDR_AUTHORIZATION_CODED_HEIGHT,
    EXTERNAL_AV1_HDR_AUTHORIZATION_CODED_WIDTH,
    EXTERNAL_AV1_HDR_AUTHORIZATION_DISPLAY_HEIGHT,
    EXTERNAL_AV1_HDR_AUTHORIZATION_DISPLAY_WIDTH,
    EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_SAMPLES,
    EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_SHA256,
    EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_VERSION
} from '../capability/vectors/ExternalAV1HDRAuthorizationVector';
import {
    createExternalHDRAuthorizationAccessUnit,
    EXTERNAL_HDR_AUTHORIZATION_CODED_HEIGHT,
    EXTERNAL_HDR_AUTHORIZATION_CODED_WIDTH,
    EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT,
    EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH,
    EXTERNAL_HDR_AUTHORIZATION_VECTOR_SAMPLES,
    EXTERNAL_HDR_AUTHORIZATION_VECTOR_SHA256,
    EXTERNAL_HDR_AUTHORIZATION_VECTOR_VERSION,
    type ExternalHDRAuthorizationVectorSample
} from '../capability/vectors/ExternalHDRAuthorizationVector';
import { CAPABILITY_PROBE_TIMEOUT } from '../capability/CapabilityProbeManager';
import { CapabilityProbeBlock, type default as CapabilityProbeSession } from '../capability/CapabilityProbeSession';
import { describeVideoConfigCheck, describeVideoDecode, type VideoCapabilityProbeStep } from '../capability/CapabilityProbeSteps';
import { getDefaultCapabilityProbeSession } from '../capability/CustomDecodeCapabilities';
import { millisecondsToMicroseconds } from '../MediaTime';
import GPUAuthorizationDeadline from './GPUAuthorizationDeadline';
import { GPUCanvasPixelReader } from './GPUCanvasReadback';
import {
    calculateRawHDRAuthorizationOutputDither,
    createAuthorizationExecutor,
    createAuthorizationReferencePlan,
    describeAuthorizationDecision,
    describeAuthorizationError,
    describeReadbackFailure,
    evaluateRawHDRVectorObservations,
    getAuthorizationTargetUsage,
    isAuthorizationTargetFormat,
    isRetriedAuthorizationDecision,
    READBACK_CODE_SCALE,
    submitAuthorizationFrames,
    type AuthorizationReferencePlan,
    type AuthorizationStep,
    type RawHDRVectorObservation
} from './RawHDRPresentationAuthorization';

const MAXIMUM_10_BIT_CODE = 1_023;
// The output compares with a CPU reference from the codes the route recovered, so it differs only by shader arithmetic and the target's quantization
const EXTERNAL_HDR_AUTHORIZATION_TOLERANCE = 3 / READBACK_CODE_SCALE;
// The recovered codes, levels applied, compare with the vector's own in 10-bit code steps, which the browser's 8-bit texture moves by up to 2
const EXTERNAL_HDR_INPUT_TOLERANCE = 4 / MAXIMUM_10_BIT_CODE;
// A float target keeps the browser's 8-bit RGB exact through the readback
const CALIBRATION_PROBE_TARGET_FORMAT: GPUTextureFormat = INTERMEDIATE_TEXTURE_FORMAT;
// The calibration probe reads the browser's RGB of the decoded vector through the identity route's signal, planned like a route's chain
const CALIBRATION_PROBE_CHAIN: BuiltinChain = {
    colorFunctions: [],
    linearLight: null,
    signal: createExternalIdentitySignal(null),
    sourceIsDisplay: true
};
const PROBE_KEY_SEPARATOR = '\u0000';
// The probe each codec's steps are journaled under, so a page that stops in one names this authorization; the plugin's crash report takes names of up to 64 characters
const EXTERNAL_HDR_AUTHORIZATION_PROBE_NAMES: Readonly<Record<ExternalHDRVideoCodec, string>> = {
    av1: 'external-hdr-authorization:av1',
    hevc: 'external-hdr-authorization:hevc'
};
// Both vectors decode to 10-bit 4:2:0 frames, which the route imports without a copy
const DECODED_FRAME_FORMAT = 'I420P10';

/** The codecs whose hardware frames the external HDR route presents, each with its own color neutralization and vector. */
export type ExternalHDRVideoCodec = 'av1' | 'hevc';

export type ExternalHDRAuthorizationRouteKey =
    | 'external-av1-main10-bt709-limited:hlg-v1'
    | 'external-av1-main10-bt709-limited:pq-v1'
    | 'external-hevc-main10-bt709-limited:hlg-v1'
    | 'external-hevc-main10-bt709-limited:pq-v1';

export const EXTERNAL_HDR_AUTHORIZATION_ROUTE_KEYS:
readonly ExternalHDRAuthorizationRouteKey[] = [
    'external-hevc-main10-bt709-limited:pq-v1',
    'external-hevc-main10-bt709-limited:hlg-v1',
    'external-av1-main10-bt709-limited:pq-v1',
    'external-av1-main10-bt709-limited:hlg-v1'
];

// The HEVC keys shape a host's HEVC transcode ranges, so an HDR negotiation or playback starts both together, on first use, and they share one
// decode; the AV1 keys authorize when their own route is first used
const PREWARMED_ROUTE_KEYS: readonly ExternalHDRAuthorizationRouteKey[] = [
    'external-hevc-main10-bt709-limited:pq-v1',
    'external-hevc-main10-bt709-limited:hlg-v1'
];

/** One codec's authorization vector: the decoder configuration, the frame it must output, and the samples its render is checked at. */
type ExternalHDRAuthorizationVector = Readonly<{
    codedHeight: number
    codedWidth: number
    /** Returns the vector's access unit with its color neutralized to limited BT.709, or null when it carries nothing to rewrite */
    createNeutralizedAccessUnit: () => Uint8Array | null
    decoderCodec: string
    displayHeight: number
    displayWidth: number
    samples: readonly ExternalHDRAuthorizationVectorSample[]
    sha256: string
    version: number
}>;

const EXTERNAL_HDR_AUTHORIZATION_VECTORS: Readonly<Record<ExternalHDRVideoCodec, ExternalHDRAuthorizationVector>> = {
    av1: {
        codedHeight: EXTERNAL_AV1_HDR_AUTHORIZATION_CODED_HEIGHT,
        codedWidth: EXTERNAL_AV1_HDR_AUTHORIZATION_CODED_WIDTH,
        createNeutralizedAccessUnit: (): Uint8Array | null => rewriteAV1TemporalUnitColorToBT709(createExternalAV1HDRAuthorizationTemporalUnit()),
        decoderCodec: EXTERNAL_AV1_HDR_AUTHORIZATION_CODEC,
        displayHeight: EXTERNAL_AV1_HDR_AUTHORIZATION_DISPLAY_HEIGHT,
        displayWidth: EXTERNAL_AV1_HDR_AUTHORIZATION_DISPLAY_WIDTH,
        samples: EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_SAMPLES,
        sha256: EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_SHA256,
        version: EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_VERSION
    },
    hevc: {
        codedHeight: EXTERNAL_HDR_AUTHORIZATION_CODED_HEIGHT,
        codedWidth: EXTERNAL_HDR_AUTHORIZATION_CODED_WIDTH,
        createNeutralizedAccessUnit: (): Uint8Array | null => rewriteHEVCAccessUnitColorDescriptionToBT709(
            createExternalHDRAuthorizationAccessUnit(),
            { kind: 'annex-b' }
        ),
        decoderCodec: 'hvc1.2.4.L120.B0',
        displayHeight: EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT,
        displayWidth: EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH,
        samples: EXTERNAL_HDR_AUTHORIZATION_VECTOR_SAMPLES,
        sha256: EXTERNAL_HDR_AUTHORIZATION_VECTOR_SHA256,
        version: EXTERNAL_HDR_AUTHORIZATION_VECTOR_VERSION
    }
};

export type ExternalHDRAuthorizationFailureReason =
    | 'browser-defect'
    | 'calibration-failed'
    | 'decode-failed'
    | 'decoder-api-unavailable'
    | 'decoder-config-unsupported'
    | 'decoder-output-mismatch'
    | 'device-lost'
    | 'frame-import-failed'
    | 'gpu-api-unavailable'
    | 'gpu-validation-failed'
    | 'input-mismatch'
    | 'pixel-mismatch'
    | 'readback-failed'
    | 'route-unsupported'
    | 'stopped-page'
    | 'target-format-unsupported'
    | 'timeout'
    | 'unexpected-error';

export type ExternalHDRRouteAuthorizationDecision = {
    authorizedRouteKeys: readonly ExternalHDRAuthorizationRouteKey[]
    /** The levels fitted to the decoded vector, which the route applies to every frame of its codec on the device; null when rejected */
    calibration: ExternalFrameCalibration | null
    /** The tested frame's transfer tag; a rejection carries no permission to accept that tag. */
    decodedFrameTransfer: VideoColorSpace['transfer']
    device: GPUDevice
    /** The failing value of a rejection, such as `14/255 > 3/255 at (3, 7)`; null when authorized */
    failureDetail: string | null
    failureReason: ExternalHDRAuthorizationFailureReason | null
    /** The version of the route's codec vector */
    vectorVersion: number
    maximumChannelError: number | null
    /** The largest error of the recovered codes, levels applied, against the vector's, normalized by 1023; null before levels were fitted */
    maximumInputChannelError: number | null
    renderSettingsVersion: typeof RENDER_SETTINGS_VERSION
    routeKey: ExternalHDRAuthorizationRouteKey
    sampleCount: number
    shaderSignature: string
    status: 'authorized' | 'rejected'
    targetFormat: GPUTextureFormat
};

export type ExternalHDRAuthorizationTelemetry = {
    authorizedRouteKeys: readonly ExternalHDRAuthorizationRouteKey[]
    calibrations: Readonly<Partial<Record<ExternalHDRAuthorizationRouteKey, ExternalFrameCalibration>>>
    failureDetails: Readonly<Partial<Record<ExternalHDRAuthorizationRouteKey, string>>>
    failureReasons: Readonly<Partial<Record<
        ExternalHDRAuthorizationRouteKey,
        ExternalHDRAuthorizationFailureReason
    >>>
    maximumChannelErrors: Readonly<Partial<Record<
        ExternalHDRAuthorizationRouteKey,
        number
    >>>
    maximumInputChannelErrors: Readonly<Partial<Record<
        ExternalHDRAuthorizationRouteKey,
        number
    >>>
    pendingRouteKeys: readonly ExternalHDRAuthorizationRouteKey[]
    rejectedRouteKeys: readonly ExternalHDRAuthorizationRouteKey[]
    renderSettingsVersion: typeof RENDER_SETTINGS_VERSION
    sampleCounts: Readonly<Partial<Record<ExternalHDRAuthorizationRouteKey, number>>>
    status: 'authorized' | 'pending' | 'rejected' | 'unavailable'
    targetFormat: GPUTextureFormat | null
};

/** Decodes the codec's neutralized vector and returns its one frame. */
export type ExternalHDRAuthorizationFrameFactory = (codec: ExternalHDRVideoCodec, signal: AbortSignal) => Promise<VideoFrame>;

type CachedRouteProbe = {
    decision: ExternalHDRRouteAuthorizationDecision | null
    promise: Promise<ExternalHDRRouteAuthorizationDecision>
};

/** The routes of one target format and codec that share one check and one decode of the codec's vector. */
type CodecBatch = {
    decisions: Promise<readonly ExternalHDRRouteAuthorizationDecision[]>
    routeKeys: ExternalHDRAuthorizationRouteKey[]
};

type DeviceProbeCache = {
    /** Settles once the device's latest batch of each codec settles, which the codec's next batch waits for, so the device never holds two of the codec's hardware decoders */
    codecTails: Map<ExternalHDRVideoCodec, Promise<void>>
    /** The batch of each target format and codec that has not started yet, which a route asked for meanwhile joins */
    openBatches: Map<string, CodecBatch>
    /** The reference chain's shader signature per target format and route, which planning makes stable per device */
    referenceSignatures: Map<string, string>
    routes: Map<string, CachedRouteProbe>
};

/** A route a batch renders once its executor exists, with its slot among the batch's decisions. */
type BatchRoute = {
    index: number
    plan: NonNullable<AuthorizationReferencePlan['plan']>
    probe: RouteProbeIdentity
    settings: HDRToSDRRenderSettings
    targetUsage: GPUTextureUsageFlags
};

type RenderableRoute = BatchRoute & { executor: PresentationExecutor };

/** The levels fitted to a decoded vector frame, with each sample's codes as a route recovers them, levels applied. */
type FrameCalibration = {
    calibration: ExternalFrameCalibration
    maximumInputChannelError: number
    recoveredCodes: readonly ColorTriplet[]
};

/** Why a decoded vector frame gave no levels, which rejects every route of its batch. */
type FrameCalibrationRejection = {
    failureDetail: string
    failureReason: ExternalHDRAuthorizationFailureReason
    maximumInputChannelError: number | null
    sampleCount: number
};

/** The device, target, route, and reference shader one probe renders, which every decision of the probe carries. */
type RouteProbeIdentity = {
    device: GPUDevice
    routeKey: ExternalHDRAuthorizationRouteKey
    shaderSignature: string
    targetFormat: GPUTextureFormat
};

type TelemetryAccumulator = {
    authorizedRouteKeys: ExternalHDRAuthorizationRouteKey[]
    calibrations: Partial<Record<ExternalHDRAuthorizationRouteKey, ExternalFrameCalibration>>
    failureDetails: Partial<Record<ExternalHDRAuthorizationRouteKey, string>>
    failureReasons: Partial<Record<
        ExternalHDRAuthorizationRouteKey,
        ExternalHDRAuthorizationFailureReason
    >>
    maximumChannelErrors: Partial<Record<ExternalHDRAuthorizationRouteKey, number>>
    maximumInputChannelErrors: Partial<Record<ExternalHDRAuthorizationRouteKey, number>>
    pendingRouteKeys: ExternalHDRAuthorizationRouteKey[]
    rejectedRouteKeys: ExternalHDRAuthorizationRouteKey[]
    sampleCounts: Partial<Record<ExternalHDRAuthorizationRouteKey, number>>
};

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function getRouteVideoCodec(routeKey: ExternalHDRAuthorizationRouteKey): ExternalHDRVideoCodec {
    switch (routeKey) {
        case 'external-av1-main10-bt709-limited:hlg-v1':
        case 'external-av1-main10-bt709-limited:pq-v1':
            return 'av1';
        case 'external-hevc-main10-bt709-limited:hlg-v1':
        case 'external-hevc-main10-bt709-limited:pq-v1':
            return 'hevc';
    }
}

function getRouteVector(routeKey: ExternalHDRAuthorizationRouteKey): ExternalHDRAuthorizationVector {
    return EXTERNAL_HDR_AUTHORIZATION_VECTORS[getRouteVideoCodec(routeKey)];
}

function createMetadata(routeKey: ExternalHDRAuthorizationRouteKey): InputColorMetadata {
    switch (routeKey) {
        case 'external-av1-main10-bt709-limited:hlg-v1':
        case 'external-hevc-main10-bt709-limited:hlg-v1':
            return createHLGColorMetadata();
        case 'external-av1-main10-bt709-limited:pq-v1':
        case 'external-hevc-main10-bt709-limited:pq-v1':
            return createPQColorMetadata();
    }
}

function createSettings(metadata: InputColorMetadata): HDRToSDRRenderSettings {
    return createHDRToSDRRenderSettings({
        toneMapping: { inputPeakNits: metadata.nominalPeakNits }
    });
}

/** Returns the exact 10-bit HDR metadata route of a codec's native frames, covered by that codec's native-frame probe. */
export function getExternalHDRAuthorizationRouteKey(
    codec: ExternalHDRVideoCodec,
    metadata: InputColorMetadata
): ExternalHDRAuthorizationRouteKey | null {
    if (
        metadata.bitDepth !== 10
        || metadata.matrix !== 'bt2020-ncl'
        || metadata.primaries !== 'bt2020'
        || metadata.range !== 'limited'
    ) {
        return null;
    }
    switch (metadata.transfer) {
        case 'hlg':
            return codec === 'av1' ? 'external-av1-main10-bt709-limited:hlg-v1' : 'external-hevc-main10-bt709-limited:hlg-v1';
        case 'pq':
            return codec === 'av1' ? 'external-av1-main10-bt709-limited:pq-v1' : 'external-hevc-main10-bt709-limited:pq-v1';
        case 'sdr':
            return null;
    }
}

function createExternalHDRReferencePlan(
    device: GPUDevice,
    targetFormat: GPUTextureFormat,
    routeKey: ExternalHDRAuthorizationRouteKey
): AuthorizationReferencePlan {
    const metadata = createMetadata(routeKey);
    const vector = getRouteVector(routeKey);
    const configuration: BuiltinChainConfiguration = {
        hdrOutput: false,
        metadata,
        route: 'external-hdr',
        settings: createSettings(metadata)
    };
    return createAuthorizationReferencePlan(device, (): BuiltinChain => createBuiltinChain(configuration), {
        format: targetFormat,
        hdrSource: true,
        height: vector.displayHeight,
        width: vector.displayWidth
    });
}

/** Plans the probe that reads the browser's RGB of a codec's decoded vector into a float target, from which the route's levels are fitted. */
function createCalibrationProbePlan(device: GPUDevice, codec: ExternalHDRVideoCodec): AuthorizationReferencePlan {
    const vector = EXTERNAL_HDR_AUTHORIZATION_VECTORS[codec];
    return createAuthorizationReferencePlan(device, (): BuiltinChain => CALIBRATION_PROBE_CHAIN, {
        format: CALIBRATION_PROBE_TARGET_FORMAT,
        hdrSource: false,
        height: vector.displayHeight,
        width: vector.displayWidth
    });
}

function createProbeKey(targetFormat: GPUTextureFormat, routeKey: ExternalHDRAuthorizationRouteKey): string {
    return `${targetFormat}${PROBE_KEY_SEPARATOR}${routeKey}`;
}

/** Creates a stable identity for the exact native frame, the route's reference chain, and the calibration probe its levels are fitted from. */
export function createExternalHDRShaderSignature(
    targetFormat: GPUTextureFormat,
    routeKey: ExternalHDRAuthorizationRouteKey,
    shaderCode: string,
    calibrationProbeShaderCode: string
): string {
    const vector = getRouteVector(routeKey);
    const signatureInput = [
        `vector=${vector.version}`,
        `vector-sha256=${vector.sha256}`,
        `uniform=${RENDER_SETTINGS_VERSION}`,
        `route=${routeKey}`,
        `codec=${vector.decoderCodec}`,
        'frame=opaque:bt709:bt709:iec61966-2-1:limited',
        `input-format=${CALIBRATION_PROBE_TARGET_FORMAT}`,
        `input-tolerance=${EXTERNAL_HDR_INPUT_TOLERANCE}`,
        `tolerance=${EXTERNAL_HDR_AUTHORIZATION_TOLERANCE}`,
        `target=${targetFormat}`,
        shaderCode,
        calibrationProbeShaderCode
    ].join('\u0000');
    let hash = 0x811C_9DC5;
    for (let characterIndex = 0; characterIndex < signatureInput.length; characterIndex += 1) {
        hash ^= signatureInput.charCodeAt(characterIndex);
        hash = Math.imul(hash, 0x0100_0193) >>> 0;
    }
    return `fnv1a32-${hash.toString(16).padStart(8, '0')}`;
}

function frameMatchesAuthorizationContract(frame: VideoFrame, vector: ExternalHDRAuthorizationVector): boolean {
    const visibleRectangle = frame.visibleRect;
    // VideoToolbox reports the coded size unpadded
    // HEVC's BT.709 tag is provisional until its rendered pixels pass validation.
    return frame.format === null
        && frame.codedWidth >= vector.displayWidth
        && frame.codedWidth <= vector.codedWidth
        && frame.codedHeight >= vector.displayHeight
        && frame.codedHeight <= vector.codedHeight
        && frame.displayWidth === vector.displayWidth
        && frame.displayHeight === vector.displayHeight
        && frame.timestamp === 0
        && visibleRectangle !== null
        && visibleRectangle.x === 0
        && visibleRectangle.y === 0
        && visibleRectangle.width === vector.displayWidth
        && visibleRectangle.height === vector.displayHeight
        && frame.colorSpace.fullRange === false
        && frame.colorSpace.matrix === 'bt709'
        && frame.colorSpace.primaries === 'bt709'
        && (frame.colorSpace.transfer === 'iec61966-2-1'
            || (vector === EXTERNAL_HDR_AUTHORIZATION_VECTORS.hevc && frame.colorSpace.transfer === 'bt709'));
}

async function flushVideoDecoderUntilAbort(decoder: VideoDecoder, signal?: AbortSignal): Promise<void> {
    if (!signal) {
        await decoder.flush();
        return;
    }
    if (signal.aborted) {
        throw new DOMException('External HDR authorization decode was aborted', 'AbortError');
    }

    let rejectAbort: ((reason: DOMException) => void) | null = null;
    const abortPromise = new Promise<never>((_resolve, reject): void => {
        rejectAbort = reject;
    });
    const handleAbort = (): void => {
        rejectAbort?.(new DOMException('External HDR authorization decode was aborted', 'AbortError'));
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    try {
        await Promise.race([ decoder.flush(), abortPromise ]);
    } finally {
        signal.removeEventListener('abort', handleAbort);
        rejectAbort = null;
    }
}

function createDecoderConfiguration(vector: ExternalHDRAuthorizationVector): VideoDecoderConfig {
    return {
        codec: vector.decoderCodec,
        // Edge uses these hints as its visible rectangle, so provide the
        // picture size. The bitstream still defines the padded coded raster.
        codedHeight: vector.displayHeight,
        codedWidth: vector.displayWidth,
        colorSpace: {
            fullRange: false,
            matrix: 'bt709',
            primaries: 'bt709',
            transfer: 'iec61966-2-1'
        },
        hardwareAcceleration: 'prefer-hardware',
        optimizeForLatency: true
    };
}

function isDecoderAPIAvailable(): boolean {
    if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') {
        return false;
    }
    // eslint-disable-next-line compat/compat -- Feature detection
    return typeof VideoDecoder.isConfigSupported === 'function';
}

/**
 * Decodes one codec's neutralized 10-bit vector and requires Chromium's opaque hardware output.
 * The caller checks the configuration first; an aborted signal opens no decoder.
 */
export async function createExternalHDRAuthorizationFrame(codec: ExternalHDRVideoCodec, signal?: AbortSignal): Promise<VideoFrame> {
    if (!isDecoderAPIAvailable()) {
        throw new Error('decoder-api-unavailable');
    }
    if (signal?.aborted) {
        throw new DOMException('External HDR authorization decode was aborted', 'AbortError');
    }

    const vector = EXTERNAL_HDR_AUTHORIZATION_VECTORS[codec];
    const neutralizedAccessUnit = vector.createNeutralizedAccessUnit();
    if (!neutralizedAccessUnit) {
        throw new Error('decoder-output-mismatch');
    }
    const configuration = createDecoderConfiguration(vector);

    const decodeState: {
        decoderError: DOMException | null
        decodedFrame: VideoFrame | null
        outputCount: number
    } = {
        decoderError: null,
        decodedFrame: null,
        outputCount: 0
    };
    // eslint-disable-next-line compat/compat -- Authorization is capability-gated
    const decoder = new VideoDecoder({
        error: (error: DOMException): void => {
            decodeState.decoderError = error;
        },
        output: (frame: VideoFrame): void => {
            decodeState.outputCount += 1;
            if (decodeState.decodedFrame) {
                frame.close();
                return;
            }
            decodeState.decodedFrame = frame;
        }
    });
    try {
        decoder.configure(configuration);
        // eslint-disable-next-line compat/compat -- Authorization is capability-gated
        decoder.decode(new EncodedVideoChunk({
            data: neutralizedAccessUnit,
            timestamp: 0,
            type: 'key'
        }));
        await flushVideoDecoderUntilAbort(decoder, signal);
        if (signal?.aborted) {
            throw new DOMException('External HDR authorization decode was aborted', 'AbortError');
        }
        if (decodeState.decoderError) {
            throw decodeState.decoderError;
        }
        const decodedFrame = decodeState.decodedFrame;
        if (!decodedFrame || decodeState.outputCount !== 1) {
            throw new Error('decode-failed');
        }
        if (!frameMatchesAuthorizationContract(decodedFrame, vector)) {
            throw new Error('decoder-output-mismatch');
        }
        const authorizedFrame = decodedFrame;
        decodeState.decodedFrame = null;
        return authorizedFrame;
    } finally {
        // NOTE: close() throws on a codec its own error already closed, which would hide that error
        if (decoder.state !== 'closed') {
            decoder.close();
        }
        decodeState.decodedFrame?.close();
    }
}

/** Computes CPU-reference samples from YUV codes at the vector's samples: its exact decoded codes, or the codes a route recovered from the browser. */
export function createExpectedExternalHDRAuthorizationObservations(
    routeKey: ExternalHDRAuthorizationRouteKey,
    settings: HDRToSDRRenderSettings,
    sampleCodes: readonly ColorTriplet[] = getRouteVector(routeKey).samples.map(
        (sample: ExternalHDRAuthorizationVectorSample): ColorTriplet => sample.rawYUVCode
    )
): readonly RawHDRVectorObservation[] {
    const metadata = createMetadata(routeKey);
    return getRouteVector(routeKey).samples.map((sample: ExternalHDRAuthorizationVectorSample, sampleIndex: number): RawHDRVectorObservation => {
        const codes = sampleCodes[sampleIndex];
        const encodedYUV: ColorTriplet = [
            codes[0] / MAXIMUM_10_BIT_CODE,
            codes[1] / MAXIMUM_10_BIT_CODE,
            codes[2] / MAXIMUM_10_BIT_CODE
        ];
        const referenceRGB = processEncodedYUV(encodedYUV, metadata, settings);
        const dither = calculateRawHDRAuthorizationOutputDither(sample.sampleX, sample.sampleY);
        return {
            linearRGB: [
                clamp(referenceRGB[0] + dither, 0, 1),
                clamp(referenceRGB[1] + dither, 0, 1),
                clamp(referenceRGB[2] + dither, 0, 1)
            ],
            sampleX: sample.sampleX,
            sampleY: sample.sampleY
        };
    });
}

function classifyFailure(error: unknown, step: AuthorizationStep): ExternalHDRAuthorizationFailureReason {
    switch (getErrorMessage(error)) {
        case 'decode-failed':
            return 'decode-failed';
        case 'decoder-api-unavailable':
            return 'decoder-api-unavailable';
        case 'decoder-output-mismatch':
            return 'decoder-output-mismatch';
        case 'device-lost':
            return 'device-lost';
        case 'timeout':
            return 'timeout';
        default:
            break;
    }
    switch (step) {
        case 'frame':
            return 'decode-failed';
        case 'import':
            return 'frame-import-failed';
        case 'executor':
        case 'readback':
        case 'render':
            return 'unexpected-error';
    }
}

function createRejectedDecision(
    probe: RouteProbeIdentity,
    failureReason: ExternalHDRAuthorizationFailureReason,
    failureDetail: string,
    sampleCount = 0,
    maximumChannelError: number | null = null,
    maximumInputChannelError: number | null = null
): ExternalHDRRouteAuthorizationDecision {
    return {
        authorizedRouteKeys: [],
        calibration: null,
        decodedFrameTransfer: null,
        device: probe.device,
        failureDetail,
        failureReason,
        vectorVersion: getRouteVector(probe.routeKey).version,
        maximumChannelError,
        maximumInputChannelError,
        renderSettingsVersion: RENDER_SETTINGS_VERSION,
        routeKey: probe.routeKey,
        sampleCount,
        shaderSignature: probe.shaderSignature,
        status: 'rejected',
        targetFormat: probe.targetFormat
    };
}

function createCalibrationRejectedDecision(probe: RouteProbeIdentity, rejection: FrameCalibrationRejection): ExternalHDRRouteAuthorizationDecision {
    return createRejectedDecision(
        probe,
        rejection.failureReason,
        rejection.failureDetail,
        rejection.sampleCount,
        null,
        rejection.maximumInputChannelError
    );
}

function isFrameCalibration(result: FrameCalibration | FrameCalibrationRejection): result is FrameCalibration {
    return 'calibration' in result;
}

// A sample's 10-bit codes as an observation, normalized as a float readback holds them, so codes compare in 10-bit code steps
function createCodeObservation(codes: ColorTriplet, sample: ExternalHDRAuthorizationVectorSample): RawHDRVectorObservation {
    return {
        linearRGB: [ codes[0] / MAXIMUM_10_BIT_CODE, codes[1] / MAXIMUM_10_BIT_CODE, codes[2] / MAXIMUM_10_BIT_CODE ],
        sampleX: sample.sampleX,
        sampleY: sample.sampleY
    };
}

/**
 * Fits the levels that recover the vector's codes from the browser's RGB at its samples, then checks the recovered codes of every sample the
 * browser did not clip against the vector's; a clipped channel says nothing of the levels, and the output check covers its sample as recovered.
 */
function evaluateFrameCalibration(
    samples: readonly ExternalHDRAuthorizationVectorSample[],
    encodedRGB: readonly ColorTriplet[]
): FrameCalibration | FrameCalibrationRejection {
    const calibrationSamples = samples.map((sample: ExternalHDRAuthorizationVectorSample, sampleIndex: number): ExternalFrameCalibrationSample => ({
        encodedRGB: encodedRGB[sampleIndex],
        rawYUVCode: sample.rawYUVCode
    }));
    const fit = fitExternalFrameCalibration(calibrationSamples);
    if (fit.calibration === null) {
        return { failureDetail: fit.failure, failureReason: 'calibration-failed', maximumInputChannelError: null, sampleCount: samples.length };
    }
    const calibration = fit.calibration;
    const recoveredCodes = calibrationSamples.map((sample: ExternalFrameCalibrationSample): ColorTriplet => applyExternalFrameCalibration(
        recoverLimitedRangeBT709Codes(sample.encodedRGB),
        calibration
    ));
    const unclippedIndices = calibrationSamples.flatMap((sample: ExternalFrameCalibrationSample, sampleIndex: number): number[] => (
        isUnclippedExternalFrameRGB(sample.encodedRGB) ? [ sampleIndex ] : []
    ));
    const comparison = evaluateRawHDRVectorObservations(
        unclippedIndices.map((sampleIndex: number): RawHDRVectorObservation => createCodeObservation(samples[sampleIndex].rawYUVCode, samples[sampleIndex])),
        unclippedIndices.map((sampleIndex: number): RawHDRVectorObservation => createCodeObservation(recoveredCodes[sampleIndex], samples[sampleIndex])),
        EXTERNAL_HDR_INPUT_TOLERANCE,
        MAXIMUM_10_BIT_CODE
    );
    if (comparison.failureDetail !== null) {
        return {
            failureDetail: comparison.failureDetail,
            failureReason: 'input-mismatch',
            maximumInputChannelError: comparison.maximumChannelError,
            sampleCount: samples.length
        };
    }
    return { calibration, maximumInputChannelError: comparison.maximumChannelError, recoveredCodes };
}

/** What a step answers instead of its call's value: the timeout result, or the block that kept it from running. */
type StepRefusal = CapabilityProbeBlock | typeof CAPABILITY_PROBE_TIMEOUT;

function isStepRefusal(outcome: unknown): outcome is StepRefusal {
    return outcome === CAPABILITY_PROBE_TIMEOUT || outcome instanceof CapabilityProbeBlock;
}

/**
 * Renders the browser's RGB of the decoded vector into a float target of its own, and fits the levels the codec's routes recover its codes with,
 * within the decode step's deadline.
 */
async function calibrateFrame(
    device: GPUDevice,
    executor: PresentationExecutor,
    codec: ExternalHDRVideoCodec,
    frame: VideoFrame,
    targetUsage: GPUTextureUsageFlags,
    deadline: GPUAuthorizationDeadline
): Promise<FrameCalibration | FrameCalibrationRejection> {
    const samples = EXTERNAL_HDR_AUTHORIZATION_VECTORS[codec].samples;
    const reject = (failureReason: ExternalHDRAuthorizationFailureReason, failureDetail: string): FrameCalibrationRejection => ({
        failureDetail: `calibration probe ${failureDetail}`,
        failureReason,
        maximumInputChannelError: null,
        sampleCount: 0
    });
    let targetTexture: GPUTexture | null = null;
    let pixelReader: GPUCanvasPixelReader | null = null;
    let step: AuthorizationStep = 'render';
    try {
        targetTexture = device.createTexture({
            dimension: '2d',
            format: CALIBRATION_PROBE_TARGET_FORMAT,
            label: 'WebGPU external HDR authorization calibration probe',
            size: {
                depthOrArrayLayers: 1,
                height: frame.displayHeight,
                width: frame.displayWidth
            },
            usage: targetUsage
        });
        // The probe imports the frame while it encodes, as a route's executor does
        step = 'import';
        const validationResult = submitAuthorizationFrames(device, [ {
            executor,
            label: 'WebGPU external HDR authorization calibration probe commands',
            source: { kind: 'external', source: frame },
            targetTexture
        } ]);
        step = 'render';
        await deadline.wait(waitForGPUCompletion(device, device.queue.onSubmittedWorkDone()));
        const validationError = await deadline.wait(validationResult);
        if (validationError) {
            return reject('gpu-validation-failed', validationError.message);
        }

        step = 'readback';
        const activePixelReader = new GPUCanvasPixelReader({
            device,
            format: CALIBRATION_PROBE_TARGET_FORMAT,
            maximumReadbacks: samples.length
        });
        pixelReader = activePixelReader;
        const readback = await deadline.wait(
            activePixelReader.readPixels(samples, targetTexture),
            (): void => activePixelReader.destroy()
        );
        if (readback.failure || !readback.linearRGB) {
            return reject('readback-failed', describeReadbackFailure(readback.failure));
        }
        return evaluateFrameCalibration(samples, readback.linearRGB);
    } catch (error) {
        return reject(classifyFailure(error, step), describeAuthorizationError(step, error));
    } finally {
        pixelReader?.destroy();
        targetTexture?.destroy();
    }
}

/**
 * Renders one route from the decoded frame, through the levels fitted to it, into a target of its own, and compares its readback with the CPU
 * reference from the codes the route recovered, within the decode step's deadline.
 */
async function renderRoute(
    device: GPUDevice,
    route: RenderableRoute,
    frame: VideoFrame,
    frameCalibration: FrameCalibration,
    deadline: GPUAuthorizationDeadline
): Promise<ExternalHDRRouteAuthorizationDecision> {
    const { probe } = route;
    let targetTexture: GPUTexture | null = null;
    let pixelReader: GPUCanvasPixelReader | null = null;
    let step: AuthorizationStep = 'render';
    try {
        targetTexture = device.createTexture({
            dimension: '2d',
            format: probe.targetFormat,
            label: 'WebGPU external HDR authorization target',
            size: {
                depthOrArrayLayers: 1,
                height: frame.displayHeight,
                width: frame.displayWidth
            },
            usage: route.targetUsage
        });
        route.executor.writeExternalFrameCalibration(frameCalibration.calibration);

        // The executor imports the frame while it encodes, so an encode failure is an import failure; the scope is popped before
        // this returns, so no other authorization's pop takes it, and a pop whose result never comes is never popped again
        step = 'import';
        const validationResult = submitAuthorizationFrames(device, [ {
            executor: route.executor,
            label: 'WebGPU external HDR authorization commands',
            source: { kind: 'external', source: frame },
            targetTexture
        } ]);
        step = 'render';
        await deadline.wait(waitForGPUCompletion(device, device.queue.onSubmittedWorkDone()));
        const validationError = await deadline.wait(validationResult);
        if (validationError) {
            return createRejectedDecision(probe, 'gpu-validation-failed', validationError.message);
        }

        step = 'readback';
        const samples = getRouteVector(probe.routeKey).samples;
        const activePixelReader = new GPUCanvasPixelReader({
            device,
            format: probe.targetFormat,
            maximumReadbacks: samples.length
        });
        pixelReader = activePixelReader;
        const readback = await deadline.wait(
            activePixelReader.readPixels(samples, targetTexture),
            (): void => activePixelReader.destroy()
        );
        if (readback.failure || !readback.linearRGB) {
            return createRejectedDecision(probe, 'readback-failed', describeReadbackFailure(readback.failure));
        }
        const linearRGB = readback.linearRGB;
        const actualObservations: RawHDRVectorObservation[] = samples.map((sample, sampleIndex): RawHDRVectorObservation => ({
            linearRGB: linearRGB[sampleIndex],
            sampleX: sample.sampleX,
            sampleY: sample.sampleY
        }));
        const expectedObservations = createExpectedExternalHDRAuthorizationObservations(
            probe.routeKey,
            route.settings,
            frameCalibration.recoveredCodes
        );
        const comparison = evaluateRawHDRVectorObservations(
            expectedObservations,
            actualObservations,
            EXTERNAL_HDR_AUTHORIZATION_TOLERANCE
        );
        if (comparison.failureDetail !== null) {
            return createRejectedDecision(
                probe,
                'pixel-mismatch',
                comparison.failureDetail,
                actualObservations.length,
                comparison.maximumChannelError,
                frameCalibration.maximumInputChannelError
            );
        }
        return {
            authorizedRouteKeys: [ probe.routeKey ],
            calibration: frameCalibration.calibration,
            decodedFrameTransfer: frame.colorSpace?.transfer ?? null,
            device,
            failureDetail: null,
            failureReason: null,
            vectorVersion: getRouteVector(probe.routeKey).version,
            maximumChannelError: comparison.maximumChannelError,
            maximumInputChannelError: frameCalibration.maximumInputChannelError,
            renderSettingsVersion: RENDER_SETTINGS_VERSION,
            routeKey: probe.routeKey,
            sampleCount: actualObservations.length,
            shaderSignature: probe.shaderSignature,
            status: 'authorized',
            targetFormat: probe.targetFormat
        };
    } catch (error) {
        return createRejectedDecision(probe, classifyFailure(error, step), describeAuthorizationError(step, error));
    } finally {
        pixelReader?.destroy();
        targetTexture?.destroy();
    }
}

/**
 * Runs native decode, external import, each route's built-in default chain, and readback, for routes of one codec.
 * The configuration check and the decode are steps of the page's capability probe session, so a page that stops in either names it there,
 * and the decode step's call renders every route from its one frame, so the routes share one hardware decoder.
 */
export class ExternalHDRPresentationAuthorizationRunner {
    public constructor(
        private readonly createFrame: ExternalHDRAuthorizationFrameFactory = createExternalHDRAuthorizationFrame,
        private readonly getSession: () => CapabilityProbeSession = getDefaultCapabilityProbeSession
    ) {}

    /** Authorizes routes of one codec on a device and target format, and returns their decisions in the routes' order. */
    public async validate(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        codec: ExternalHDRVideoCodec,
        routeKeys: readonly ExternalHDRAuthorizationRouteKey[]
    ): Promise<ExternalHDRRouteAuthorizationDecision[]> {
        const decisions: ExternalHDRRouteAuthorizationDecision[] = [];
        const routes: BatchRoute[] = [];
        const calibrationProbe = createCalibrationProbePlan(device, codec);
        for (const [ index, routeKey ] of routeKeys.entries()) {
            const route = this.prepareRoute(device, targetFormat, codec, routeKey, index, calibrationProbe);
            if ('status' in route) {
                decisions[index] = route;
            } else {
                routes.push(route);
            }
        }
        // Every route renders only once the probe is planned, so its plan exists here
        if (routes.length > 0 && calibrationProbe.plan) {
            await this.renderRoutes(device, codec, routes, calibrationProbe.plan, decisions);
        }
        return decisions;
    }

    // Returns what the route renders through, or its rejection when deciding it needs no decoder
    private prepareRoute(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        codec: ExternalHDRVideoCodec,
        routeKey: ExternalHDRAuthorizationRouteKey,
        index: number,
        calibrationProbe: AuthorizationReferencePlan
    ): BatchRoute | ExternalHDRRouteAuthorizationDecision {
        const settings = createSettings(createMetadata(routeKey));
        const reference = createExternalHDRReferencePlan(device, targetFormat, routeKey);
        const probe: RouteProbeIdentity = {
            device,
            routeKey,
            shaderSignature: createExternalHDRShaderSignature(targetFormat, routeKey, reference.shaderCode, calibrationProbe.shaderCode),
            targetFormat
        };
        if (!EXTERNAL_HDR_AUTHORIZATION_ROUTE_KEYS.includes(routeKey) || getRouteVideoCodec(routeKey) !== codec) {
            return createRejectedDecision(probe, 'route-unsupported', routeKey);
        }
        if (!isAuthorizationTargetFormat(targetFormat)) {
            return createRejectedDecision(probe, 'target-format-unsupported', targetFormat);
        }
        const targetUsage = getAuthorizationTargetUsage();
        if (targetUsage.usage === null) {
            return createRejectedDecision(probe, 'gpu-api-unavailable', targetUsage.failure);
        }
        if (!reference.plan || !calibrationProbe.plan) {
            return createRejectedDecision(probe, 'unexpected-error', reference.failure ?? calibrationProbe.failure ?? routeKey);
        }
        return { index, plan: reference.plan, probe, settings, targetUsage: targetUsage.usage };
    }

    // Checks the codec's configuration, builds the routes' executors and the calibration probe's, and decodes the vector once for all of them,
    // filling in their decisions
    private async renderRoutes(
        device: GPUDevice,
        codec: ExternalHDRVideoCodec,
        routes: readonly BatchRoute[],
        calibrationProbePlan: NonNullable<AuthorizationReferencePlan['plan']>,
        decisions: ExternalHDRRouteAuthorizationDecision[]
    ): Promise<void> {
        const rejectRoutes = (rejected: readonly BatchRoute[], reason: ExternalHDRAuthorizationFailureReason, detail: string): void => {
            for (const route of rejected) {
                decisions[route.index] = createRejectedDecision(route.probe, reason, detail);
            }
        };
        if (!isDecoderAPIAvailable()) {
            rejectRoutes(routes, 'decoder-api-unavailable', 'VideoDecoder undefined');
            return;
        }
        const vector = EXTERNAL_HDR_AUTHORIZATION_VECTORS[codec];
        const configuration = createDecoderConfiguration(vector);
        const checkStep: VideoCapabilityProbeStep = describeVideoConfigCheck(configuration);
        const decodeStep: VideoCapabilityProbeStep = {
            ...describeVideoDecode(configuration, DECODED_FRAME_FORMAT),
            // Budget the allocated raster, independently of the visible-size hints.
            cost: describeVideoDecode({
                ...configuration,
                codedHeight: vector.codedHeight,
                codedWidth: vector.codedWidth
            }, DECODED_FRAME_FORMAT).cost
        };
        const deadline = new GPUAuthorizationDeadline(device);
        const executors: PresentationExecutor[] = [];
        // The decode step's answer, and its call once the manager starts it, which renders with the executors until it settles
        const decode: { call: Promise<unknown> | null, callSettled: boolean, outcome: Promise<unknown> | null } = {
            call: null,
            callSettled: false,
            outcome: null
        };
        let step: AuthorizationStep = 'frame';
        try {
            const session = this.getSession();
            // The store records no step before the page's quarantine is read, and the quarantine names the steps that never run
            await deadline.wait(session.readQuarantine());
            const queue = session.record(session.manager.queue, EXTERNAL_HDR_AUTHORIZATION_PROBE_NAMES[codec]);
            // A deadline that passes during the check rejects here, so no executor is built and no decoder opens for routes already rejected
            // eslint-disable-next-line compat/compat -- Authorization is capability-gated
            const support = await deadline.wait(queue.check(() => VideoDecoder.isConfigSupported(configuration), checkStep));
            if (isStepRefusal(support)) {
                rejectRoutes(routes, support === CAPABILITY_PROBE_TIMEOUT ? 'timeout' : support.reason, checkStep.label);
                return;
            }
            if (support.supported !== true) {
                rejectRoutes(routes, 'decoder-config-unsupported', checkStep.label);
                return;
            }

            step = 'executor';
            const renderable = await this.createExecutors(device, routes, deadline, executors, decisions);
            if (renderable.length === 0) {
                return;
            }
            const calibrationProbeExecutor = await createAuthorizationExecutor(device, calibrationProbePlan, deadline);
            executors.push(calibrationProbeExecutor);

            step = 'frame';
            // eslint-disable-next-line compat/compat -- WebGPU custom decode targets modern Chromium
            const decodeAbortController = new AbortController();
            const outcome = queue.runTimed(() => {
                const call = this.decodeAndRender(
                    device,
                    codec,
                    renderable,
                    calibrationProbeExecutor,
                    decodeAbortController.signal,
                    session.manager.timeoutMilliseconds
                );
                decode.call = call;
                void call.finally((): void => {
                    decode.callSettled = true;
                });
                return call;
            }, decodeStep);
            decode.outcome = outcome;
            const rendered = await deadline.wait(outcome, (): void => decodeAbortController.abort());
            if (isStepRefusal(rendered)) {
                rejectRoutes(renderable, rendered === CAPABILITY_PROBE_TIMEOUT ? 'timeout' : rendered.reason, decodeStep.label);
                return;
            }
            for (const [ renderIndex, route ] of renderable.entries()) {
                decisions[route.index] = rendered[renderIndex];
            }
        } catch (error) {
            for (const route of routes) {
                decisions[route.index] ??= createRejectedDecision(route.probe, classifyFailure(error, step), describeAuthorizationError(step, error));
            }
        } finally {
            deadline.destroy();
            const releaseExecutors = (): void => {
                for (const executor of executors) {
                    executor.destroy();
                }
            };
            // A decode step this gave up on may still render with the executors; its own deadline ends it soon after
            const outcome = decode.outcome;
            if (outcome === null || decode.callSettled) {
                releaseExecutors();
            } else {
                void outcome.then(() => decode.call, () => decode.call).then(releaseExecutors, releaseExecutors);
            }
        }
    }

    // Builds each route's executor within the deadline; a route whose executor fails is rejected alone
    private async createExecutors(
        device: GPUDevice,
        routes: readonly BatchRoute[],
        deadline: GPUAuthorizationDeadline,
        executors: PresentationExecutor[],
        decisions: ExternalHDRRouteAuthorizationDecision[]
    ): Promise<RenderableRoute[]> {
        const created = await Promise.all(routes.map(async (route: BatchRoute): Promise<RenderableRoute | null> => {
            try {
                const executor = await createAuthorizationExecutor(device, route.plan, deadline);
                executors.push(executor);
                if (route.plan.usesRenderSettings) {
                    executor.writeRenderSettings(createRenderSettingsUniformData(route.settings).buffer);
                }
                return { ...route, executor };
            } catch (error) {
                decisions[route.index] = createRejectedDecision(route.probe, classifyFailure(error, 'executor'), describeAuthorizationError('executor', error));
                return null;
            }
        }));
        return created.filter((route: RenderableRoute | null): route is RenderableRoute => route !== null);
    }

    // The decode step's call: decodes the vector once, fits its levels from the calibration probe, and renders every route from the frame within
    // the step's own timeout. It returns plain decisions, never the frame, since the manager drops a value that comes after the step timed out, and
    // with it the duty to close the frame, and it stops all probing once a call outlives that timeout by as long again
    private async decodeAndRender(
        device: GPUDevice,
        codec: ExternalHDRVideoCodec,
        routes: readonly RenderableRoute[],
        calibrationProbeExecutor: PresentationExecutor,
        signal: AbortSignal,
        stepTimeoutMilliseconds: number
    ): Promise<ExternalHDRRouteAuthorizationDecision[]> {
        const deadline = new GPUAuthorizationDeadline(device, millisecondsToMicroseconds(stepTimeoutMilliseconds));
        // eslint-disable-next-line compat/compat -- WebGPU custom decode targets modern Chromium
        const frameAbortController = new AbortController();
        const abortFrame = (): void => frameAbortController.abort();
        signal.addEventListener('abort', abortFrame, { once: true });
        if (signal.aborted) {
            abortFrame();
        }
        let frame: VideoFrame | null = null;
        try {
            const framePromise = this.createFrame(codec, frameAbortController.signal);
            // A frame that arrives after the wait gave up is closed on arrival
            void framePromise.then((lateFrame: VideoFrame): void => {
                if (frameAbortController.signal.aborted) {
                    lateFrame.close();
                }
            }, (): void => undefined);
            frame = await deadline.wait(framePromise, abortFrame);
            const requireActiveDecode = (): void => {
                if (signal.aborted) {
                    throw new DOMException('External HDR authorization decode was aborted', 'AbortError');
                }
            };
            requireActiveDecode();
            // Every route of the codec recovers the frame's codes through the same levels
            const frameCalibration = await calibrateFrame(device, calibrationProbeExecutor, codec, frame, routes[0].targetUsage, deadline);
            if (!isFrameCalibration(frameCalibration)) {
                return routes.map((route: RenderableRoute): ExternalHDRRouteAuthorizationDecision => createCalibrationRejectedDecision(
                    route.probe,
                    frameCalibration
                ));
            }
            const decisions: ExternalHDRRouteAuthorizationDecision[] = [];
            for (const route of routes) {
                requireActiveDecode();
                decisions.push(await renderRoute(device, route, frame, frameCalibration, deadline));
            }
            return decisions;
        } catch (error) {
            return routes.map((route: RenderableRoute): ExternalHDRRouteAuthorizationDecision => createRejectedDecision(
                route.probe,
                classifyFailure(error, 'frame'),
                describeAuthorizationError('frame', error)
            ));
        } finally {
            deadline.destroy();
            signal.removeEventListener('abort', abortFrame);
            frame?.close();
        }
    }
}

function recordDecisionTelemetry(
    accumulator: TelemetryAccumulator,
    routeKey: ExternalHDRAuthorizationRouteKey,
    decision: ExternalHDRRouteAuthorizationDecision
): void {
    if (decision.maximumChannelError !== null) {
        accumulator.maximumChannelErrors[routeKey] = decision.maximumChannelError;
    }
    if (decision.maximumInputChannelError !== null) {
        accumulator.maximumInputChannelErrors[routeKey] = decision.maximumInputChannelError;
    }
    accumulator.sampleCounts[routeKey] = decision.sampleCount;
    if (decision.status === 'authorized') {
        accumulator.authorizedRouteKeys.push(routeKey);
        if (decision.calibration) {
            accumulator.calibrations[routeKey] = decision.calibration;
        }
        return;
    }
    accumulator.rejectedRouteKeys.push(routeKey);
    if (decision.failureReason) {
        accumulator.failureReasons[routeKey] = decision.failureReason;
    }
    if (decision.failureDetail) {
        accumulator.failureDetails[routeKey] = decision.failureDetail;
    }
}

function getAuthorizationTelemetryStatus(accumulator: TelemetryAccumulator): ExternalHDRAuthorizationTelemetry['status'] {
    if (accumulator.pendingRouteKeys.length > 0) {
        return 'pending';
    }
    if (accumulator.authorizedRouteKeys.length > 0) {
        return 'authorized';
    }
    return accumulator.rejectedRouteKeys.length > 0 ? 'rejected' : 'unavailable';
}

/** Device-scoped cache for exact opaque native Main10 presentation evidence. */
export class ExternalHDRPresentationAuthorizationRegistry {
    private readonly devices = new WeakMap<GPUDevice, DeviceProbeCache>();

    public constructor(private readonly runner = new ExternalHDRPresentationAuthorizationRunner()) {}

    /** Starts the HEVC shader probes without delaying ordinary playback; the AV1 probes start on first use. */
    public prewarm(device: GPUDevice, targetFormat: GPUTextureFormat): void {
        for (const routeKey of PREWARMED_ROUTE_KEYS) {
            void this.authorize(device, targetFormat, routeKey);
        }
    }

    /** Waits only route probes already started for this device and target. */
    public async waitForPending(device: GPUDevice, targetFormat: GPUTextureFormat): Promise<void> {
        const pendingPromises: Promise<ExternalHDRRouteAuthorizationDecision>[] = [];
        for (const routeKey of EXTERNAL_HDR_AUTHORIZATION_ROUTE_KEYS) {
            const probe = this.getCachedProbe(device, targetFormat, routeKey);
            if (probe && !probe.decision) {
                pendingPromises.push(probe.promise);
            }
        }
        if (pendingPromises.length > 0) {
            await Promise.all(pendingPromises);
        }
    }

    /**
     * Returns one deduplicated exact-device, target, decoder, and shader decision. Routes of a codec asked for together share one check
     * and one decode, and a codec's next batch waits for its last. A timeout or a lost device says nothing about the route, so it is not kept:
     * the next call probes the route again.
     */
    public authorize(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        routeKey: ExternalHDRAuthorizationRouteKey
    ): Promise<ExternalHDRRouteAuthorizationDecision> {
        const cacheKey = createProbeKey(targetFormat, routeKey);
        const deviceCache = this.getDeviceCache(device);
        const cachedProbe = deviceCache.routes.get(cacheKey);
        if (cachedProbe && !isRetriedAuthorizationDecision(cachedProbe.decision)) {
            return cachedProbe.promise;
        }

        const batch = this.joinBatch(device, deviceCache, targetFormat, getRouteVideoCodec(routeKey));
        const routeIndex = batch.routeKeys.push(routeKey) - 1;
        const probe = { decision: null } as CachedRouteProbe;
        probe.promise = batch.decisions.then(
            (decisions: readonly ExternalHDRRouteAuthorizationDecision[]):
            ExternalHDRRouteAuthorizationDecision => {
                const decision = decisions[routeIndex];
                probe.decision = decision;
                return decision;
            },
            (error: unknown): ExternalHDRRouteAuthorizationDecision => {
                const decision = createRejectedDecision(
                    {
                        device,
                        routeKey,
                        shaderSignature: this.getReferenceSignature(device, targetFormat, routeKey),
                        targetFormat
                    },
                    'unexpected-error',
                    getErrorMessage(error)
                );
                probe.decision = decision;
                return decision;
            }
        );
        deviceCache.routes.set(cacheKey, probe);
        return probe.promise;
    }

    // Returns the open batch of the target format and codec, or opens one that starts once the codec's last batch on the device settles,
    // and no sooner than the next microtask, so the routes asked for in one task, as prewarm's are, share its decode
    private joinBatch(
        device: GPUDevice,
        deviceCache: DeviceProbeCache,
        targetFormat: GPUTextureFormat,
        codec: ExternalHDRVideoCodec
    ): CodecBatch {
        const batchKey = `${targetFormat}${PROBE_KEY_SEPARATOR}${codec}`;
        const openBatch = deviceCache.openBatches.get(batchKey);
        if (openBatch) {
            return openBatch;
        }
        const routeKeys: ExternalHDRAuthorizationRouteKey[] = [];
        const previousBatch = deviceCache.codecTails.get(codec) ?? Promise.resolve();
        const decisions = previousBatch.then((): Promise<ExternalHDRRouteAuthorizationDecision[]> => {
            deviceCache.openBatches.delete(batchKey);
            return this.runner.validate(device, targetFormat, codec, routeKeys);
        });
        const batch: CodecBatch = { decisions, routeKeys };
        deviceCache.openBatches.set(batchKey, batch);
        deviceCache.codecTails.set(codec, decisions.then((): void => undefined, (): void => undefined));
        return batch;
    }

    /** Checks only settled evidence for the route's current reference shader and never waits optimistically. */
    public isAuthorized(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        codec: ExternalHDRVideoCodec,
        metadata: InputColorMetadata
    ): boolean {
        return this.getAuthorizationFailure(device, targetFormat, codec, metadata) === null;
    }

    /**
     * Returns why this device, target format, and codec's route for the metadata are not authorized, as `<state>: <route key>` with the failing value, or null when they are.
     * Metadata no probe covers reports `route-unsupported` with its bit depth and color description.
     */
    public getAuthorizationFailure(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        codec: ExternalHDRVideoCodec,
        metadata: InputColorMetadata,
        decodedFrameTransfer?: VideoColorSpace['transfer']
    ): string | null {
        const routeKey = getExternalHDRAuthorizationRouteKey(codec, metadata);
        if (!routeKey) {
            return `route-unsupported: ${metadata.bitDepth}-bit ${metadata.matrix}:${metadata.primaries}:${metadata.range}:${metadata.transfer}`;
        }
        const probe = this.getCachedProbe(device, targetFormat, routeKey);
        const decision = probe?.decision ?? null;
        if (
            decision?.status === 'authorized'
            && (decision.device !== device || decision.targetFormat !== targetFormat || !decision.authorizedRouteKeys.includes(routeKey))
        ) {
            return `decision-mismatch: ${routeKey}`;
        }
        const failure = describeAuthorizationDecision(
            routeKey,
            probe !== undefined,
            decision,
            (): string => this.getReferenceSignature(device, targetFormat, routeKey)
        );
        if (failure === null && decodedFrameTransfer === 'bt709' && decision?.decodedFrameTransfer !== 'bt709') {
            return `untested-frame-transfer: bt709, tested ${decision?.decodedFrameTransfer ?? 'unknown'}: ${routeKey}`;
        }
        return failure;
    }

    /**
     * Returns the levels this device, target format, and codec's authorized route for the metadata recovers the codec's frames with, or null
     * while that route is not authorized.
     */
    public getFrameCalibration(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        codec: ExternalHDRVideoCodec,
        metadata: InputColorMetadata
    ): ExternalFrameCalibration | null {
        const routeKey = getExternalHDRAuthorizationRouteKey(codec, metadata);
        if (!routeKey || this.getAuthorizationFailure(device, targetFormat, codec, metadata) !== null) {
            return null;
        }
        return this.getCachedProbe(device, targetFormat, routeKey)?.decision?.calibration ?? null;
    }

    /** Returns bounded diagnostics without exposing retained decoder or GPU objects. */
    public getTelemetry(
        device: GPUDevice | null,
        targetFormat: GPUTextureFormat | null
    ): ExternalHDRAuthorizationTelemetry {
        const accumulator: TelemetryAccumulator = {
            authorizedRouteKeys: [],
            calibrations: {},
            failureDetails: {},
            failureReasons: {},
            maximumChannelErrors: {},
            maximumInputChannelErrors: {},
            pendingRouteKeys: [],
            rejectedRouteKeys: [],
            sampleCounts: {}
        };
        if (!device || !targetFormat) {
            return {
                ...accumulator,
                renderSettingsVersion: RENDER_SETTINGS_VERSION,
                status: 'unavailable',
                targetFormat
            };
        }

        for (const routeKey of EXTERNAL_HDR_AUTHORIZATION_ROUTE_KEYS) {
            const probe = this.getCachedProbe(device, targetFormat, routeKey);
            if (!probe) {
                continue;
            }
            if (!probe.decision) {
                accumulator.pendingRouteKeys.push(routeKey);
                continue;
            }
            recordDecisionTelemetry(accumulator, routeKey, probe.decision);
        }
        return {
            ...accumulator,
            renderSettingsVersion: RENDER_SETTINGS_VERSION,
            status: getAuthorizationTelemetryStatus(accumulator),
            targetFormat
        };
    }

    private getReferenceSignature(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        routeKey: ExternalHDRAuthorizationRouteKey
    ): string {
        const referenceSignatures = this.getDeviceCache(device).referenceSignatures;
        const signatureKey = createProbeKey(targetFormat, routeKey);
        const cachedSignature = referenceSignatures.get(signatureKey);
        if (cachedSignature !== undefined) {
            return cachedSignature;
        }
        const signature = createExternalHDRShaderSignature(
            targetFormat,
            routeKey,
            createExternalHDRReferencePlan(device, targetFormat, routeKey).shaderCode,
            createCalibrationProbePlan(device, getRouteVideoCodec(routeKey)).shaderCode
        );
        referenceSignatures.set(signatureKey, signature);
        return signature;
    }

    private getCachedProbe(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        routeKey: ExternalHDRAuthorizationRouteKey
    ): CachedRouteProbe | undefined {
        return this.devices.get(device)?.routes.get(createProbeKey(targetFormat, routeKey));
    }

    private getDeviceCache(device: GPUDevice): DeviceProbeCache {
        const cached = this.devices.get(device);
        if (cached) {
            return cached;
        }
        const created: DeviceProbeCache = { codecTails: new Map(), openBatches: new Map(), referenceSignatures: new Map(), routes: new Map() };
        this.devices.set(device, created);
        void device.lost.then((): void => {
            this.devices.delete(device);
        });
        return created;
    }
}
