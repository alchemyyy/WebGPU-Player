import {
    createDefaultRenderSettings,
    createHDRToSDRRenderSettings,
    createRenderSettingsUniformData,
    RENDER_SETTINGS_VERSION,
    type RenderSettings
} from '../presentation/RenderSettings';
import {
    createHLGColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata,
    type InputColorMetadata
} from '../color/ColorMetadata';
import {
    processEncodedYUV,
    type ColorTriplet
} from '../color/ColorPipeline';
import { waitForGPUCompletion } from '../GPUCompletion';
import { millisecondsToMicroseconds } from '../MediaTime';
import { createBuiltinChain } from '../presentation/passes/builtin/BuiltinChains';
import { PRESENTATION_FIELD_STATE } from '../presentation/passes/PassResources';
import type {
    BuiltinChain,
    BuiltinChainConfiguration,
    PresentationFrameSource,
    PresentationPlan
} from '../presentation/passes/PassTypes';
import { createPlannedOutput, PresentationExecutor } from '../presentation/passes/PresentationExecutor';
import { planPresentation } from '../presentation/passes/PresentationPlanner';
import type { TexturePresentationGeometry } from '../presentation/PresentationGeometry';
import { READBACK_CANVAS_FORMATS, VALIDATION_ERROR_FILTER } from '../presentation/WebGPUConstants';
import {
    getRawFormatBitDepth,
    RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT,
    type RawVideoFrameColorSpace,
    type RawVideoPlaneDescriptor,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from '../decode/video/RawVideoFrameCopy';
import {
    GPUCanvasPixelReader,
    getValidationTextureUsage,
    type GPUCanvasReadbackFailure
} from './GPUCanvasReadback';
import GPUAuthorizationDeadline, { GPU_AUTHORIZATION_TIMEOUT_MICROSECONDS } from './GPUAuthorizationDeadline';
import { discardErrorScope } from './GPUErrorScope';

export const RAW_HDR_AUTHORIZATION_VECTOR_VERSION = 2;
export const RAW_HDR_AUTHORIZATION_TIMEOUT_MICROSECONDS = GPU_AUTHORIZATION_TIMEOUT_MICROSECONDS;

export const RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT = 8;
export const RAW_HDR_AUTHORIZATION_VECTOR_WIDTH = 16;

/** The denominator 8-bit readbacks are compared in, so a detail reads as code steps of the target. */
export const READBACK_CODE_SCALE = 255;
const AUTHORIZATION_TOLERANCE = 3 / READBACK_CODE_SCALE;
const PROBE_KEY_SEPARATOR = '\u0000';
// Joins a reference plan's pass modules into the code its shader signature covers
const PLAN_SHADER_CODE_SEPARATOR = '\u0000';
// The code a signature covers when a reference chain cannot be planned, so its decision never matches a planned one
const UNPLANNED_SHADER_CODE = 'unplanned';
// The globals a probe needs to create its target and readback
const REQUIRED_GPU_API_NAMES: readonly string[] = [ 'GPUTextureUsage', 'GPUBufferUsage' ];
// The failure messages the deadline cancels an operation with, which name the reason and need no detail beyond the step
const CANCELLATION_MESSAGES: ReadonlySet<string> = new Set<string>([ 'device-lost', 'timeout' ]);
const MEASURED_ERROR_DECIMALS = 1;

type AuthorizedRawSDRFormat =
    | 'I420'
    | 'I420P10'
    | 'I420P12'
    | 'I422'
    | 'I422P10'
    | 'I422P12'
    | 'I444'
    | 'I444P10'
    | 'I444P12';
type AuthorizedRawHDRFormat = Exclude<AuthorizedRawSDRFormat, 'I420' | 'I422' | 'I444'>;
type RawVideoBitDepth = 8 | 10 | 12;

export type RawHDRAuthorizationRouteKey =
    | `${AuthorizedRawHDRFormat}:bt2020-ncl:bt2020:limited:${'hlg' | 'pq'}`
    | `${AuthorizedRawSDRFormat}:bt709:bt709:${'full' | 'limited'}:sdr`;

const AUTHORIZED_RAW_SDR_FORMATS: readonly AuthorizedRawSDRFormat[] = [
    'I420',
    'I420P10',
    'I420P12',
    'I422',
    'I422P10',
    'I422P12',
    'I444',
    'I444P10',
    'I444P12'
];
const AUTHORIZED_RAW_HDR_FORMATS: readonly AuthorizedRawHDRFormat[] = [
    'I420P10',
    'I420P12',
    'I422P10',
    'I422P12',
    'I444P10',
    'I444P12'
];

function createRawAuthorizationRouteKeys(): readonly RawHDRAuthorizationRouteKey[] {
    const routeKeys: RawHDRAuthorizationRouteKey[] = [];
    for (const format of AUTHORIZED_RAW_SDR_FORMATS) {
        routeKeys.push(`${format}:bt709:bt709:limited:sdr`);
        routeKeys.push(`${format}:bt709:bt709:full:sdr`);
    }
    for (const format of AUTHORIZED_RAW_HDR_FORMATS) {
        routeKeys.push(`${format}:bt2020-ncl:bt2020:limited:pq`);
        routeKeys.push(`${format}:bt2020-ncl:bt2020:limited:hlg`);
    }
    return Object.freeze(routeKeys);
}

export const RAW_HDR_AUTHORIZATION_ROUTE_KEYS = createRawAuthorizationRouteKeys();
const RAW_AUTHORIZATION_ROUTE_KEY_SET = new Set<RawHDRAuthorizationRouteKey>(RAW_HDR_AUTHORIZATION_ROUTE_KEYS);

export type RawHDRAuthorizationFailureReason =
    | 'device-lost'
    | 'gpu-api-unavailable'
    | 'gpu-validation-failed'
    | 'pixel-mismatch'
    | 'readback-failed'
    | 'route-unsupported'
    | 'target-format-unsupported'
    | 'timeout'
    | 'unexpected-error';

export type RawHDRRouteAuthorizationDecision = {
    authorizedRouteKeys: readonly RawHDRAuthorizationRouteKey[]
    device: GPUDevice
    /** The failing value of a rejection, such as `14/255 > 3/255 at (3, 7)`; null when authorized */
    failureDetail: string | null
    failureReason: RawHDRAuthorizationFailureReason | null
    vectorVersion: typeof RAW_HDR_AUTHORIZATION_VECTOR_VERSION
    maximumChannelError: number | null
    renderSettingsVersion: typeof RENDER_SETTINGS_VERSION
    routeKey: RawHDRAuthorizationRouteKey
    sampleCount: number
    shaderSignature: string
    status: 'authorized' | 'rejected'
    targetFormat: GPUTextureFormat
};

export type RawHDRAuthorizationTelemetry = {
    authorizedRouteKeys: readonly RawHDRAuthorizationRouteKey[]
    failureDetails: Readonly<Partial<Record<RawHDRAuthorizationRouteKey, string>>>
    failureReasons: Readonly<Partial<Record<RawHDRAuthorizationRouteKey, RawHDRAuthorizationFailureReason>>>
    vectorVersion: typeof RAW_HDR_AUTHORIZATION_VECTOR_VERSION
    pendingRouteKeys: readonly RawHDRAuthorizationRouteKey[]
    rejectedRouteKeys: readonly RawHDRAuthorizationRouteKey[]
    renderSettingsVersion: typeof RENDER_SETTINGS_VERSION
    status: 'authorized' | 'pending' | 'rejected' | 'unavailable'
    targetFormat: GPUTextureFormat | null
};

export type RawHDRVectorObservation = {
    linearRGB: ColorTriplet
    sampleX: number
    sampleY: number
};

type VectorSample = {
    sampleX: number
    sampleY: number
};

type CachedRouteProbe = {
    decision: RawHDRRouteAuthorizationDecision | null
    promise: Promise<RawHDRRouteAuthorizationDecision>
};

type DeviceProbeCache = {
    lossObserved: boolean
    /** The reference chain's shader signature per target format and route, which planning makes stable per device */
    referenceSignatures: Map<string, string>
    routes: Map<string, CachedRouteProbe>
};

/** The vector frame an authorization renders, mapped 1:1 onto a target texture of the same size. */
export type AuthorizationRenderTarget = {
    format: GPUTextureFormat
    /** Whether the vector carries an HDR signal, the planner's `hdr.source` fact */
    hdrSource: boolean
    height: number
    width: number
};

/** A route's default chain planned for authorization; the plan is null when the chain cannot be built or planned. */
export type AuthorizationReferencePlan = {
    /** Why the chain could not be built or planned, as `reference-plan: <message>`; null with a plan */
    failure: string | null
    plan: PresentationPlan | null
    /** The plan's pass modules, which the route's shader signature covers */
    shaderCode: string
};

/** The probe operation a failure happened in, which a rejection's detail names. */
export type AuthorizationStep = 'executor' | 'frame' | 'import' | 'readback' | 'render';

/** How bounded readbacks compare with their CPU reference; failureDetail names the worst sample, null when accepted. */
export type VectorObservationComparison = {
    accepted: boolean
    failureDetail: string | null
    maximumChannelError: number
};

/** The parts of any authorization decision that say whether, and why not, it authorizes its route. */
export type AuthorizationDecisionState = {
    failureDetail: string | null
    failureReason: string | null
    shaderSignature: string
    status: 'authorized' | 'rejected'
};

/** The device, target, route, and reference shader one probe renders, which every decision of the probe carries. */
type RouteProbeIdentity = {
    device: GPUDevice
    routeKey: RawHDRAuthorizationRouteKey
    shaderSignature: string
    targetFormat: GPUTextureFormat
};

type TelemetryAccumulator = {
    authorizedRouteKeys: RawHDRAuthorizationRouteKey[]
    failureDetails: Partial<Record<RawHDRAuthorizationRouteKey, string>>
    failureReasons: Partial<Record<RawHDRAuthorizationRouteKey, RawHDRAuthorizationFailureReason>>
    pendingRouteKeys: RawHDRAuthorizationRouteKey[]
    rejectedRouteKeys: RawHDRAuthorizationRouteKey[]
};

export const RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES: readonly VectorSample[] = [
    { sampleX: 0, sampleY: 0 },
    { sampleX: 3, sampleY: 0 },
    { sampleX: 7, sampleY: 0 },
    { sampleX: 11, sampleY: 0 },
    { sampleX: 15, sampleY: 0 },
    { sampleX: 2, sampleY: 6 },
    { sampleX: 7, sampleY: 6 },
    { sampleX: 12, sampleY: 6 },
    { sampleX: 15, sampleY: 6 }
];

function alignTo(value: number, alignment: number): number {
    return Math.ceil(value / alignment) * alignment;
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Returns whether authorization can render into and read back a target format. */
export function isAuthorizationTargetFormat(targetFormat: GPUTextureFormat): boolean {
    return READBACK_CANVAS_FORMATS.includes(targetFormat);
}

/** Returns the texture usage of an authorization target, or the WebGPU global a probe needs that is missing, as `<name> undefined`. */
export function getAuthorizationTargetUsage(): { failure: null; usage: GPUTextureUsageFlags } | { failure: string; usage: null } {
    const missingName = REQUIRED_GPU_API_NAMES.find((name: string): boolean => Reflect.get(globalThis, name) === undefined);
    const usage = getValidationTextureUsage();
    if (missingName !== undefined || usage === null) {
        return { failure: `${missingName ?? REQUIRED_GPU_API_NAMES[0]} undefined`, usage: null };
    }
    return { failure: null, usage };
}

/** Returns a rejection's detail for an error thrown in a probe step: the step alone for a deadline cancellation, else the step and the message. */
export function describeAuthorizationError(step: AuthorizationStep, error: unknown): string {
    const message = getErrorMessage(error);
    return CANCELLATION_MESSAGES.has(message) ? step : `${step}: ${message}`;
}

/** Returns a failed readback's detail: the reader's failure code. */
export function describeReadbackFailure(failure: GPUCanvasReadbackFailure | null): string {
    return failure?.code ?? 'no-samples';
}

/** Formats an error or a bound in steps of a code scale, as `14/255`. */
function formatCodeSteps(value: number, codeScale: number): string {
    return `${Number((value * codeScale).toFixed(MEASURED_ERROR_DECIMALS))}/${codeScale}`;
}

/**
 * Returns why a cached decision does not authorize its route, as `<state>: <route key>` with the rejection's detail, or null when it does.
 * The states are unprobed, pending, the rejection's failure reason, and signature-stale for a decision rendered through an earlier reference shader.
 */
export function describeAuthorizationDecision(
    routeKey: string,
    probeStarted: boolean,
    decision: AuthorizationDecisionState | null,
    getReferenceSignature: () => string
): string | null {
    if (!probeStarted) {
        return `unprobed: ${routeKey}`;
    }
    if (!decision) {
        return `pending: ${routeKey}`;
    }
    if (decision.status !== 'authorized') {
        const parts: string[] = [ `${decision.failureReason}: ${routeKey}` ];
        if (decision.failureDetail) {
            parts.push(decision.failureDetail);
        }
        return parts.join(' ');
    }
    return decision.shaderSignature === getReferenceSignature() ? null : `signature-stale: ${routeKey}`;
}

function getRawFrameTransfer(metadata: InputColorMetadata): RawVideoFrameColorSpace['transfer'] {
    switch (metadata.transfer) {
        case 'pq':
            return 'smpte2084';
        case 'hlg':
            return 'arib-std-b67';
        case 'sdr':
            return 'bt709';
    }
}

function getRouteFormat(routeKey: RawHDRAuthorizationRouteKey): AuthorizedRawSDRFormat {
    return routeKey.slice(0, routeKey.indexOf(':')) as AuthorizedRawSDRFormat;
}

function createMetadata(routeKey: RawHDRAuthorizationRouteKey): InputColorMetadata {
    const format = getRouteFormat(routeKey);
    const bitDepth = getRawFormatBitDepth(format);
    if (routeKey.endsWith(':sdr')) {
        return createSDRColorMetadata({
            bitDepth,
            range: routeKey.includes(':full:') ? 'full' : 'limited'
        });
    }
    return routeKey.endsWith(':hlg') ?
        createHLGColorMetadata({ bitDepth }) :
        createPQColorMetadata({ bitDepth });
}

function createSettings(metadata: InputColorMetadata): RenderSettings {
    return metadata.transfer === 'sdr' ?
        createDefaultRenderSettings() :
        createHDRToSDRRenderSettings({
            toneMapping: { inputPeakNits: metadata.nominalPeakNits }
        });
}

/** Returns the probe route key for a raw YUV format and its color metadata, or null when no production probe covers them. */
export function getRawHDRAuthorizationRouteKey(
    format: SupportedRawVideoFrameFormat,
    metadata: InputColorMetadata
): RawHDRAuthorizationRouteKey | null {
    if (!AUTHORIZED_RAW_SDR_FORMATS.includes(format as AuthorizedRawSDRFormat)
        || metadata.bitDepth !== getRawFormatBitDepth(format as AuthorizedRawSDRFormat)) {
        return null;
    }
    let routeKey: string;
    switch (metadata.transfer) {
        case 'hlg':
        case 'pq':
            if (
                !AUTHORIZED_RAW_HDR_FORMATS.includes(format as AuthorizedRawHDRFormat)
                || metadata.matrix !== 'bt2020-ncl'
                || metadata.primaries !== 'bt2020'
                || metadata.range !== 'limited'
            ) {
                return null;
            }
            routeKey = `${format}:bt2020-ncl:bt2020:limited:${metadata.transfer}`;
            break;
        case 'sdr':
            if (metadata.matrix !== 'bt709' || metadata.primaries !== 'bt709') {
                return null;
            }
            routeKey = `${format}:bt709:bt709:${metadata.range}:sdr`;
            break;
    }
    return RAW_AUTHORIZATION_ROUTE_KEY_SET.has(routeKey as RawHDRAuthorizationRouteKey) ?
        routeKey as RawHDRAuthorizationRouteKey :
        null;
}

/** Creates a stable, non-cryptographic identity for a compiled route. */
export function createRawHDRShaderSignature(targetFormat: GPUTextureFormat, shaderCode: string): string {
    const signatureInput = [
        `vector=${RAW_HDR_AUTHORIZATION_VECTOR_VERSION}`,
        `uniform=${RENDER_SETTINGS_VERSION}`,
        `target=${targetFormat}`,
        shaderCode
    ].join('\u0000');
    let hash = 0x811c9dc5;
    for (let characterIndex = 0; characterIndex < signatureInput.length; characterIndex += 1) {
        hash ^= signatureInput.charCodeAt(characterIndex);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fnv1a32-${hash.toString(16).padStart(8, '0')}`;
}

function createIdentityGeometry(width: number, height: number): TexturePresentationGeometry {
    return {
        textureOffsetX: 0,
        textureOffsetY: 0,
        textureScaleX: 1,
        textureScaleY: 1,
        viewportHeight: height,
        viewportWidth: width,
        viewportX: 0,
        viewportY: 0
    };
}

/**
 * Plans a default chain for authorization: no user passes, SDR output in the target format, and facts sized to the vector frame.
 * A chain that cannot be built or planned yields a null plan and its failure, so its probe rejects instead of throwing.
 */
export function createAuthorizationReferencePlan(
    device: GPUDevice,
    createChain: () => BuiltinChain,
    target: AuthorizationRenderTarget
): AuthorizationReferencePlan {
    try {
        const plan = planPresentation({
            chain: createChain(),
            device: {
                features: device.features,
                maximumTextureDimension: device.limits.maxTextureDimension2D
            },
            facts: {
                frameRate: null,
                hdrOutput: false,
                hdrSource: target.hdrSource,
                outputHeight: target.height,
                outputWidth: target.width,
                sampleHeight: target.height,
                sampleWidth: target.width,
                sourceHeight: target.height,
                sourceWidth: target.width
            },
            output: createPlannedOutput(false, target.format),
            passes: []
        });
        return {
            failure: null,
            plan,
            shaderCode: plan.passes.map((pass: PresentationPlan['passes'][number]): string => pass.code).join(PLAN_SHADER_CODE_SEPARATOR)
        };
    } catch (error) {
        return { failure: `reference-plan: ${getErrorMessage(error)}`, plan: null, shaderCode: UNPLANNED_SHADER_CODE };
    }
}

/** Creates an authorization's executor within its deadline; an executor that arrives after the deadline is destroyed. */
export function createAuthorizationExecutor(
    device: GPUDevice,
    plan: PresentationPlan,
    deadline: GPUAuthorizationDeadline
): Promise<PresentationExecutor> {
    const executorPromise = PresentationExecutor.create(device, plan);
    return deadline.wait(executorPromise, (): void => {
        void executorPromise.then((lateExecutor: PresentationExecutor): void => {
            lateExecutor.destroy();
        }, (): void => undefined);
    });
}

/** Records one vector frame through an executor into a target texture, mapped 1:1, and returns the finished commands. */
export function encodeAuthorizationFrame(
    device: GPUDevice,
    executor: PresentationExecutor,
    source: PresentationFrameSource,
    targetTexture: GPUTexture,
    label: string
): GPUCommandBuffer {
    const commandEncoder = device.createCommandEncoder({ label });
    executor.encode(commandEncoder, {
        // Authorization renders the fixed chain, which no field state changes
        fieldState: PRESENTATION_FIELD_STATE.none,
        geometry: createIdentityGeometry(targetTexture.width, targetTexture.height),
        newFrame: true,
        skippedFrameCount: 0,
        source,
        target: targetTexture.createView(),
        timestampMicroseconds: 0
    });
    return commandEncoder.finish();
}

function createRawHDRReferencePlan(
    device: GPUDevice,
    targetFormat: GPUTextureFormat,
    routeKey: RawHDRAuthorizationRouteKey
): AuthorizationReferencePlan {
    const metadata = createMetadata(routeKey);
    const configuration: BuiltinChainConfiguration = {
        format: getRouteFormat(routeKey),
        hdrOutput: false,
        metadata,
        route: 'raw-yuv',
        settings: createSettings(metadata)
    };
    return createAuthorizationReferencePlan(device, (): BuiltinChain => createBuiltinChain(configuration), {
        format: targetFormat,
        hdrSource: metadata.transfer !== 'sdr',
        height: RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
        width: RAW_HDR_AUTHORIZATION_VECTOR_WIDTH
    });
}

function createProbeKey(targetFormat: GPUTextureFormat, routeKey: RawHDRAuthorizationRouteKey): string {
    return `${targetFormat}${PROBE_KEY_SEPARATOR}${routeKey}`;
}

function createPlaneDescriptor(
    kind: RawVideoPlaneDescriptor['kind'],
    width: number,
    height: number,
    byteOffset: number,
    bytesPerComponent: 1 | 2
): RawVideoPlaneDescriptor {
    const rowByteLength = width * bytesPerComponent;
    const bytesPerRow = alignTo(rowByteLength, RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT);
    return {
        byteLength: bytesPerRow * height,
        byteOffset,
        bytesPerComponent,
        bytesPerRow,
        componentsPerTexel: 1,
        height,
        kind,
        rowByteLength,
        width
    };
}

function setPlaneCode(
    data: ArrayBuffer,
    plane: RawVideoPlaneDescriptor,
    x: number,
    y: number,
    code: number
): void {
    const view = new DataView(data);
    const byteOffset = plane.byteOffset + (y * plane.bytesPerRow) + (x * plane.bytesPerComponent);
    if (plane.bytesPerComponent === 1) {
        view.setUint8(byteOffset, code);
        return;
    }
    view.setUint16(byteOffset, code, true);
}

function populateVectorLuma(
    data: ArrayBuffer,
    lumaPlane: RawVideoPlaneDescriptor,
    bitDepth: RawVideoBitDepth
): void {
    const codeScale = 2 ** (bitDepth - 8);
    for (let y = 0; y < RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT; y += 1) {
        for (let x = 0; x < RAW_HDR_AUTHORIZATION_VECTOR_WIDTH; x += 1) {
            const rampCode = (16 * codeScale) + Math.round((219 * codeScale * x) / (RAW_HDR_AUTHORIZATION_VECTOR_WIDTH - 1));
            const lumaCode = y < RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT / 2 ?
                rampCode :
                Math.round((120 + (x * 4.5)) * codeScale);
            setPlaneCode(data, lumaPlane, x, y, lumaCode);
        }
    }
}

function getVectorChromaCodes(
    x: number,
    y: number,
    bitDepth: RawVideoBitDepth
): readonly [number, number] {
    const codeScale = 2 ** (bitDepth - 8);
    if (y < RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT / 4) {
        return [ 128 * codeScale, 128 * codeScale ];
    }
    return x < RAW_HDR_AUTHORIZATION_VECTOR_WIDTH / 4 ?
        [ 153 * codeScale, 103 * codeScale ] :
        [ 103 * codeScale, 153 * codeScale ];
}

function populateVectorChroma(
    data: ArrayBuffer,
    chromaUPlane: RawVideoPlaneDescriptor,
    chromaVPlane: RawVideoPlaneDescriptor,
    bitDepth: RawVideoBitDepth
): void {
    for (let y = 0; y < chromaUPlane.height; y += 1) {
        for (let x = 0; x < chromaUPlane.width; x += 1) {
            const [ chromaUCode, chromaVCode ] = getVectorChromaCodes(x, y, bitDepth);
            setPlaneCode(data, chromaUPlane, x, y, chromaUCode);
            setPlaneCode(data, chromaVPlane, x, y, chromaVCode);
        }
    }
}

/** Builds one padded planar luma-ramp and chromatic-macroblock vector. */
export function createRawHDRAuthorizationVector(routeKey: RawHDRAuthorizationRouteKey): TransferableRawVideoFrame {
    const metadata = createMetadata(routeKey);
    const format = getRouteFormat(routeKey);
    const bytesPerComponent: 1 | 2 = metadata.bitDepth === 8 ? 1 : 2;
    const chromaWidthDivisor = format.startsWith('I444') ? 1 : 2;
    const chromaHeightDivisor = format.startsWith('I420') ? 2 : 1;
    const chromaWidth = RAW_HDR_AUTHORIZATION_VECTOR_WIDTH / chromaWidthDivisor;
    const chromaHeight = RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT / chromaHeightDivisor;
    const lumaPlane = createPlaneDescriptor(
        'y',
        RAW_HDR_AUTHORIZATION_VECTOR_WIDTH,
        RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
        0,
        bytesPerComponent
    );
    const chromaUPlane = createPlaneDescriptor(
        'u',
        chromaWidth,
        chromaHeight,
        lumaPlane.byteLength,
        bytesPerComponent
    );
    const chromaVPlane = createPlaneDescriptor(
        'v',
        chromaWidth,
        chromaHeight,
        lumaPlane.byteLength + chromaUPlane.byteLength,
        bytesPerComponent
    );
    const data = new ArrayBuffer(lumaPlane.byteLength + chromaUPlane.byteLength + chromaVPlane.byteLength);
    populateVectorLuma(data, lumaPlane, metadata.bitDepth as RawVideoBitDepth);
    populateVectorChroma(data, chromaUPlane, chromaVPlane, metadata.bitDepth as RawVideoBitDepth);

    return {
        bitDepth: metadata.bitDepth as RawVideoBitDepth,
        codedHeight: RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
        codedWidth: RAW_HDR_AUTHORIZATION_VECTOR_WIDTH,
        colorSpace: {
            fullRange: metadata.range === 'full',
            matrix: metadata.matrix,
            primaries: metadata.primaries,
            transfer: getRawFrameTransfer(metadata)
        },
        data,
        displayHeight: RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
        displayWidth: RAW_HDR_AUTHORIZATION_VECTOR_WIDTH,
        durationMicroseconds: null,
        format,
        planes: [ lumaPlane, chromaUPlane, chromaVPlane ],
        timestampMicroseconds: millisecondsToMicroseconds(0),
        visibleRectangle: {
            height: RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
            width: RAW_HDR_AUTHORIZATION_VECTOR_WIDTH,
            x: 0,
            y: 0
        }
    };
}

function readPlaneCode(
    frame: TransferableRawVideoFrame,
    plane: RawVideoPlaneDescriptor,
    x: number,
    y: number
): number {
    const clampedX = clamp(x, 0, plane.width - 1);
    const clampedY = clamp(y, 0, plane.height - 1);
    const byteOffset = plane.byteOffset + (clampedY * plane.bytesPerRow) + (clampedX * plane.bytesPerComponent);
    const view = new DataView(frame.data);
    return plane.bytesPerComponent === 1 ?
        view.getUint8(byteOffset) :
        view.getUint16(byteOffset, true);
}

function mix(firstValue: number, secondValue: number, amount: number): number {
    return firstValue + ((secondValue - firstValue) * amount);
}

function samplePlaneCode(
    frame: TransferableRawVideoFrame,
    plane: RawVideoPlaneDescriptor,
    textureCoordinateX: number,
    textureCoordinateY: number
): number {
    const samplePositionX = (textureCoordinateX * plane.width) - 0.5;
    const samplePositionY = (textureCoordinateY * plane.height) - 0.5;
    const baseX = Math.floor(samplePositionX);
    const baseY = Math.floor(samplePositionY);
    const fractionX = samplePositionX - baseX;
    const fractionY = samplePositionY - baseY;
    const top = mix(
        readPlaneCode(frame, plane, baseX, baseY),
        readPlaneCode(frame, plane, baseX + 1, baseY),
        fractionX
    );
    const bottom = mix(
        readPlaneCode(frame, plane, baseX, baseY + 1),
        readPlaneCode(frame, plane, baseX + 1, baseY + 1),
        fractionX
    );
    return mix(top, bottom, fractionY);
}

function getPlane(frame: TransferableRawVideoFrame, kind: RawVideoPlaneDescriptor['kind']): RawVideoPlaneDescriptor {
    const plane = frame.planes.find(candidate => candidate.kind === kind);
    if (!plane) {
        throw new Error(`Vector does not contain a ${kind} plane`);
    }
    return plane;
}

/** Reproduces the production shader's bounded output dither at one pixel. */
export function calculateRawHDRAuthorizationOutputDither(sampleX: number, sampleY: number): number {
    const pixelCoordinateX = sampleX + 0.5;
    const pixelCoordinateY = sampleY + 0.5;
    const innerValue = (pixelCoordinateX * 0.06711056) + (pixelCoordinateY * 0.00583715);
    const innerFraction = innerValue - Math.floor(innerValue);
    const noiseValue = 52.9829189 * innerFraction;
    return ((noiseValue - Math.floor(noiseValue)) - 0.5) / 255;
}

/** Samples one padded planar vector through the production bilinear filter. */
export function sampleRawI420P10Frame(
    frame: TransferableRawVideoFrame,
    sampleX: number,
    sampleY: number
): ColorTriplet {
    const textureCoordinateX = (sampleX + 0.5) / frame.displayWidth;
    const textureCoordinateY = (sampleY + 0.5) / frame.displayHeight;
    const chromaTextureCoordinateX = frame.format.startsWith('I444') ?
        textureCoordinateX :
        textureCoordinateX + (0.5 / frame.displayWidth);
    return [
        samplePlaneCode(frame, getPlane(frame, 'y'), textureCoordinateX, textureCoordinateY),
        samplePlaneCode(frame, getPlane(frame, 'u'), chromaTextureCoordinateX, textureCoordinateY),
        samplePlaneCode(frame, getPlane(frame, 'v'), chromaTextureCoordinateX, textureCoordinateY)
    ];
}

/** Computes CPU-reference observations independently from the GPU render. */
export function createExpectedRawHDRVectorObservations(
    frame: TransferableRawVideoFrame,
    metadata: InputColorMetadata,
    settings: RenderSettings
): readonly RawHDRVectorObservation[] {
    return RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES.map((sample: VectorSample): RawHDRVectorObservation => {
        const rawYUV = sampleRawI420P10Frame(frame, sample.sampleX, sample.sampleY);
        const maximumCode = (2 ** metadata.bitDepth) - 1;
        const encodedYUV: ColorTriplet = [
            rawYUV[0] / maximumCode,
            rawYUV[1] / maximumCode,
            rawYUV[2] / maximumCode
        ];
        const referenceRGB = processEncodedYUV(encodedYUV, metadata, settings);
        const dither = settings.mode === 'hdr-to-sdr' ?
            calculateRawHDRAuthorizationOutputDither(sample.sampleX, sample.sampleY) :
            0;
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

/**
 * Compares bounded readbacks with quantization and shader arithmetic tolerance.
 * A rejection's detail names the worst error and its bound in steps of codeScale, and where it is, as `14/255 > 3/255 at (3, 7)`.
 */
export function evaluateRawHDRVectorObservations(
    expectedObservations: readonly RawHDRVectorObservation[],
    actualObservations: readonly RawHDRVectorObservation[],
    tolerance = AUTHORIZATION_TOLERANCE,
    codeScale = READBACK_CODE_SCALE
): VectorObservationComparison {
    if (actualObservations.length !== expectedObservations.length) {
        return {
            accepted: false,
            failureDetail: `sample count ${actualObservations.length}, expected ${expectedObservations.length}`,
            maximumChannelError: Number.POSITIVE_INFINITY
        };
    }

    let maximumChannelError = 0;
    let worstObservation: RawHDRVectorObservation | null = null;
    for (let sampleIndex = 0; sampleIndex < expectedObservations.length; sampleIndex += 1) {
        const expected = expectedObservations[sampleIndex];
        const actual = actualObservations[sampleIndex];
        if (actual.sampleX !== expected.sampleX || actual.sampleY !== expected.sampleY) {
            return {
                accepted: false,
                failureDetail: `sample ${sampleIndex} at (${actual.sampleX}, ${actual.sampleY}), expected (${expected.sampleX}, ${expected.sampleY})`,
                maximumChannelError: Number.POSITIVE_INFINITY
            };
        }
        for (let componentIndex = 0; componentIndex < 3; componentIndex += 1) {
            const channelError = Math.abs(actual.linearRGB[componentIndex] - expected.linearRGB[componentIndex]);
            if (!Number.isFinite(channelError)) {
                return {
                    accepted: false,
                    failureDetail: `non-finite channel ${componentIndex} at (${actual.sampleX}, ${actual.sampleY})`,
                    maximumChannelError: Number.POSITIVE_INFINITY
                };
            }
            if (channelError > maximumChannelError) {
                maximumChannelError = channelError;
                worstObservation = actual;
            }
        }
    }
    if (maximumChannelError <= tolerance || !worstObservation) {
        return { accepted: true, failureDetail: null, maximumChannelError };
    }
    return {
        accepted: false,
        failureDetail: `${formatCodeSteps(maximumChannelError, codeScale)} > ${formatCodeSteps(tolerance, codeScale)} `
            + `at (${worstObservation.sampleX}, ${worstObservation.sampleY})`,
        maximumChannelError
    };
}

function classifyFailure(error: unknown): RawHDRAuthorizationFailureReason {
    const message = getErrorMessage(error);
    switch (message) {
        case 'device-lost':
            return 'device-lost';
        case 'timeout':
            return 'timeout';
        default:
            return 'unexpected-error';
    }
}

function createRejectedDecision(
    probe: RouteProbeIdentity,
    failureReason: RawHDRAuthorizationFailureReason,
    failureDetail: string,
    sampleCount = 0,
    maximumChannelError: number | null = null
): RawHDRRouteAuthorizationDecision {
    return {
        authorizedRouteKeys: [],
        device: probe.device,
        failureDetail,
        failureReason,
        vectorVersion: RAW_HDR_AUTHORIZATION_VECTOR_VERSION,
        maximumChannelError,
        renderSettingsVersion: RENDER_SETTINGS_VERSION,
        routeKey: probe.routeKey,
        sampleCount,
        shaderSignature: probe.shaderSignature,
        status: 'rejected',
        targetFormat: probe.targetFormat
    };
}

function getCachedRouteProbe(
    deviceCache: DeviceProbeCache | undefined,
    targetFormat: GPUTextureFormat,
    routeKey: RawHDRAuthorizationRouteKey
): CachedRouteProbe | undefined {
    return deviceCache?.routes.get(createProbeKey(targetFormat, routeKey));
}

function recordRouteTelemetry(
    accumulator: TelemetryAccumulator,
    routeKey: RawHDRAuthorizationRouteKey,
    probe: CachedRouteProbe | undefined
): void {
    if (!probe) {
        return;
    }
    const decision = probe.decision;
    if (!decision) {
        accumulator.pendingRouteKeys.push(routeKey);
        return;
    }
    if (decision.status === 'authorized') {
        accumulator.authorizedRouteKeys.push(routeKey);
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

function getAuthorizationTelemetryStatus(accumulator: TelemetryAccumulator): RawHDRAuthorizationTelemetry['status'] {
    if (accumulator.authorizedRouteKeys.length > 0) {
        return 'authorized';
    }
    if (accumulator.pendingRouteKeys.length > 0) {
        return 'pending';
    }
    return accumulator.rejectedRouteKeys.length > 0 ? 'rejected' : 'unavailable';
}

/** Renders a route's vector through its built-in default chain, reads it back, and compares it with the CPU reference. */
export class RawHDRPresentationAuthorizationRunner {
    public async validate(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        routeKey: RawHDRAuthorizationRouteKey
    ): Promise<RawHDRRouteAuthorizationDecision> {
        const metadata = createMetadata(routeKey);
        const settings = createSettings(metadata);
        const reference = createRawHDRReferencePlan(device, targetFormat, routeKey);
        const probe: RouteProbeIdentity = {
            device,
            routeKey,
            shaderSignature: createRawHDRShaderSignature(targetFormat, reference.shaderCode),
            targetFormat
        };
        if (!isAuthorizationTargetFormat(targetFormat)) {
            return createRejectedDecision(probe, 'target-format-unsupported', targetFormat);
        }
        const targetUsage = getAuthorizationTargetUsage();
        if (targetUsage.usage === null) {
            return createRejectedDecision(probe, 'gpu-api-unavailable', targetUsage.failure);
        }
        const plan = reference.plan;
        if (!plan) {
            return createRejectedDecision(probe, 'unexpected-error', reference.failure ?? UNPLANNED_SHADER_CODE);
        }

        let targetTexture: GPUTexture | null = null;
        let executor: PresentationExecutor | null = null;
        let pixelReader: GPUCanvasPixelReader | null = null;
        let errorScopePushed = false;
        let step: AuthorizationStep = 'executor';
        const deadline = new GPUAuthorizationDeadline(device, RAW_HDR_AUTHORIZATION_TIMEOUT_MICROSECONDS);
        try {
            executor = await createAuthorizationExecutor(device, plan, deadline);
            step = 'render';
            if (settings.mode === 'hdr-to-sdr' && plan.usesRenderSettings) {
                executor.writeRenderSettings(createRenderSettingsUniformData(settings).buffer);
            }
            const frame = createRawHDRAuthorizationVector(routeKey);
            targetTexture = device.createTexture({
                dimension: '2d',
                format: targetFormat,
                label: 'WebGPU raw HDR authorization target',
                size: {
                    depthOrArrayLayers: 1,
                    height: RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
                    width: RAW_HDR_AUTHORIZATION_VECTOR_WIDTH
                },
                usage: targetUsage.usage
            });
            device.pushErrorScope(VALIDATION_ERROR_FILTER);
            errorScopePushed = true;
            device.queue.submit([ encodeAuthorizationFrame(
                device,
                executor,
                { enhancementFrame: null, frame, kind: 'planes' },
                targetTexture,
                'WebGPU raw HDR authorization commands'
            ) ]);
            await deadline.wait(waitForGPUCompletion(device, device.queue.onSubmittedWorkDone()));
            const validationPromise = device.popErrorScope();
            errorScopePushed = false;
            const validationError = await deadline.wait(validationPromise);
            if (validationError) {
                return createRejectedDecision(probe, 'gpu-validation-failed', validationError.message);
            }

            step = 'readback';
            pixelReader = new GPUCanvasPixelReader({
                device,
                format: targetFormat,
                maximumReadbacks: RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES.length
            });
            const readback = await deadline.wait(
                pixelReader.readPixels(RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES, targetTexture),
                (): void => pixelReader?.destroy()
            );
            const actualObservations: RawHDRVectorObservation[] = [];
            if (readback.failure || !readback.linearRGB) {
                return createRejectedDecision(probe, 'readback-failed', describeReadbackFailure(readback.failure));
            }
            for (let sampleIndex = 0; sampleIndex < RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES.length; sampleIndex += 1) {
                const sample = RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES[sampleIndex];
                actualObservations.push({
                    linearRGB: readback.linearRGB[sampleIndex],
                    sampleX: sample.sampleX,
                    sampleY: sample.sampleY
                });
            }
            const expectedObservations = createExpectedRawHDRVectorObservations(frame, metadata, settings);
            const comparison = evaluateRawHDRVectorObservations(expectedObservations, actualObservations);
            if (comparison.failureDetail !== null) {
                return createRejectedDecision(
                    probe,
                    'pixel-mismatch',
                    comparison.failureDetail,
                    actualObservations.length,
                    comparison.maximumChannelError
                );
            }
            return {
                authorizedRouteKeys: [ routeKey ],
                device,
                failureDetail: null,
                failureReason: null,
                vectorVersion: RAW_HDR_AUTHORIZATION_VECTOR_VERSION,
                maximumChannelError: comparison.maximumChannelError,
                renderSettingsVersion: RENDER_SETTINGS_VERSION,
                routeKey,
                sampleCount: actualObservations.length,
                shaderSignature: probe.shaderSignature,
                status: 'authorized',
                targetFormat
            };
        } catch (error) {
            return createRejectedDecision(probe, classifyFailure(error), describeAuthorizationError(step, error));
        } finally {
            deadline.destroy();
            if (errorScopePushed) {
                discardErrorScope(device);
            }
            pixelReader?.destroy();
            executor?.destroy();
            targetTexture?.destroy();
        }
    }
}

/** Caches raw YUV authorization decisions per device, keyed by target format and route; a decision holds only for the current reference shader. */
export class RawHDRPresentationAuthorizationRegistry {
    private readonly devices = new WeakMap<GPUDevice, DeviceProbeCache>();
    private readonly runner: RawHDRPresentationAuthorizationRunner;

    public constructor(runner = new RawHDRPresentationAuthorizationRunner()) {
        this.runner = runner;
    }

    /** Starts the HDR route probes; concurrent requests share one probe per route. */
    public prewarm(device: GPUDevice, targetFormat: GPUTextureFormat): void {
        for (const routeKey of RAW_HDR_AUTHORIZATION_ROUTE_KEYS) {
            if (!routeKey.endsWith(':sdr')) {
                void this.authorize(device, targetFormat, routeKey);
            }
        }
    }

    /** Starts the SDR raw YUV route probes, independent of the HDR setting. */
    public prewarmSDR(device: GPUDevice, targetFormat: GPUTextureFormat): void {
        for (const routeKey of RAW_HDR_AUTHORIZATION_ROUTE_KEYS) {
            if (routeKey.endsWith(':sdr')) {
                void this.authorize(device, targetFormat, routeKey);
            }
        }
    }

    /** Waits for the probes already started for this device and format, without starting any. */
    public async waitForPending(device: GPUDevice, targetFormat: GPUTextureFormat): Promise<void> {
        const deviceCache = this.devices.get(device);
        if (!deviceCache) {
            return;
        }
        const pendingPromises: Promise<RawHDRRouteAuthorizationDecision>[] = [];
        for (const routeKey of RAW_HDR_AUTHORIZATION_ROUTE_KEYS) {
            const probe = getCachedRouteProbe(deviceCache, targetFormat, routeKey);
            if (probe && !probe.decision) {
                pendingPromises.push(probe.promise);
            }
        }
        if (pendingPromises.length > 0) {
            await Promise.all(pendingPromises);
        }
    }

    /** Returns the decision for one device, target format, and route, starting a probe only when none is cached. */
    public authorize(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        routeKey: RawHDRAuthorizationRouteKey
    ): Promise<RawHDRRouteAuthorizationDecision> {
        const cacheKey = createProbeKey(targetFormat, routeKey);
        const deviceCache = this.getDeviceCache(device);
        const cachedProbe = deviceCache.routes.get(cacheKey);
        if (cachedProbe) {
            return cachedProbe.promise;
        }

        const probe = { decision: null } as CachedRouteProbe;
        probe.promise = Promise.resolve().then(() => (
            this.runner.validate(device, targetFormat, routeKey)
        )).then(
            (decision: RawHDRRouteAuthorizationDecision): RawHDRRouteAuthorizationDecision => {
                probe.decision = decision;
                return decision;
            },
            (error: unknown): RawHDRRouteAuthorizationDecision => {
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

    /**
     * Returns true only when a settled probe authorized this device, target format, and route through the current reference shader.
     * A pending probe counts as unauthorized.
     */
    public isAuthorized(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        metadata: InputColorMetadata,
        format: SupportedRawVideoFrameFormat
    ): boolean {
        return this.getAuthorizationFailure(device, targetFormat, metadata, format) === null;
    }

    /**
     * Returns why this device, target format, and route are not authorized, as `<state>: <route key>` with the failing value, or null when they are.
     * A format and metadata no probe covers report `route-unsupported` with the format, bit depth, and color description.
     */
    public getAuthorizationFailure(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        metadata: InputColorMetadata,
        format: SupportedRawVideoFrameFormat
    ): string | null {
        const routeKey = getRawHDRAuthorizationRouteKey(format, metadata);
        if (!routeKey) {
            return `route-unsupported: ${format} ${metadata.bitDepth}-bit ${metadata.matrix}:${metadata.primaries}:${metadata.range}:${metadata.transfer}`;
        }
        const probe = this.devices.get(device)?.routes.get(createProbeKey(targetFormat, routeKey));
        const decision = probe?.decision ?? null;
        if (
            decision?.status === 'authorized'
            && (decision.device !== device || decision.targetFormat !== targetFormat || !decision.authorizedRouteKeys.includes(routeKey))
        ) {
            return `decision-mismatch: ${routeKey}`;
        }
        return describeAuthorizationDecision(
            routeKey,
            probe !== undefined,
            decision,
            (): string => this.getReferenceSignature(device, targetFormat, routeKey)
        );
    }

    /** Returns bounded state for diagnostics without exposing GPU objects. */
    public getTelemetry(device: GPUDevice | null, targetFormat: GPUTextureFormat | null): RawHDRAuthorizationTelemetry {
        if (!device || !targetFormat) {
            return {
                authorizedRouteKeys: [],
                failureDetails: {},
                failureReasons: {},
                vectorVersion: RAW_HDR_AUTHORIZATION_VECTOR_VERSION,
                pendingRouteKeys: [],
                rejectedRouteKeys: [],
                renderSettingsVersion: RENDER_SETTINGS_VERSION,
                status: 'unavailable',
                targetFormat
            };
        }

        const accumulator: TelemetryAccumulator = {
            authorizedRouteKeys: [],
            failureDetails: {},
            failureReasons: {},
            pendingRouteKeys: [],
            rejectedRouteKeys: []
        };
        const deviceCache = this.devices.get(device);
        for (const routeKey of RAW_HDR_AUTHORIZATION_ROUTE_KEYS) {
            recordRouteTelemetry(accumulator, routeKey, getCachedRouteProbe(deviceCache, targetFormat, routeKey));
        }

        return {
            authorizedRouteKeys: accumulator.authorizedRouteKeys,
            failureDetails: accumulator.failureDetails,
            failureReasons: accumulator.failureReasons,
            vectorVersion: RAW_HDR_AUTHORIZATION_VECTOR_VERSION,
            pendingRouteKeys: accumulator.pendingRouteKeys,
            rejectedRouteKeys: accumulator.rejectedRouteKeys,
            renderSettingsVersion: RENDER_SETTINGS_VERSION,
            status: getAuthorizationTelemetryStatus(accumulator),
            targetFormat
        };
    }

    private getReferenceSignature(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        routeKey: RawHDRAuthorizationRouteKey
    ): string {
        const referenceSignatures = this.getDeviceCache(device).referenceSignatures;
        const signatureKey = createProbeKey(targetFormat, routeKey);
        const cachedSignature = referenceSignatures.get(signatureKey);
        if (cachedSignature !== undefined) {
            return cachedSignature;
        }
        const signature = createRawHDRShaderSignature(
            targetFormat,
            createRawHDRReferencePlan(device, targetFormat, routeKey).shaderCode
        );
        referenceSignatures.set(signatureKey, signature);
        return signature;
    }

    private getDeviceCache(device: GPUDevice): DeviceProbeCache {
        const existingCache = this.devices.get(device);
        if (existingCache) {
            return existingCache;
        }
        const deviceCache: DeviceProbeCache = {
            lossObserved: false,
            referenceSignatures: new Map<string, string>(),
            routes: new Map<string, CachedRouteProbe>()
        };
        this.devices.set(device, deviceCache);
        if (!deviceCache.lossObserved) {
            deviceCache.lossObserved = true;
            void device.lost.then((): void => {
                this.devices.delete(device);
            });
        }
        return deviceCache;
    }
}
