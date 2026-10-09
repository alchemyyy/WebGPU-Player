import {
    createDefaultRenderSettings,
    createHDRToSDRRenderSettings,
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
import { createRawYUVColorPipelineWGSL } from '../color/ColorPipelineShader';
import { millisecondsToMicroseconds } from '../MediaTime';
import {
    createRawYUVRenderPipeline,
    createRawYUVRenderResources,
    destroyRawPlaneTextureSet,
    renderRawYUVFrame,
    type RawPlaneTextureSet,
    type RawYUVTexturePresentation
} from '../presentation/RawYUVGPURenderer';
import {
    RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT,
    type RawVideoFrameColorSpace,
    type RawVideoPlaneDescriptor,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from '../video/RawVideoFrameCopy';
import {
    GPUCanvasPixelReader,
    getValidationTextureUsage
} from './GPUCanvasReadback';
import GPUAuthorizationDeadline, { GPU_AUTHORIZATION_TIMEOUT_MICROSECONDS } from './GPUAuthorizationDeadline';
import { discardErrorScope } from './GPUErrorScope';

export const RAW_HDR_AUTHORIZATION_VECTOR_VERSION = 2;
export const RAW_HDR_AUTHORIZATION_TIMEOUT_MICROSECONDS = GPU_AUTHORIZATION_TIMEOUT_MICROSECONDS;

const VECTOR_HEIGHT = 8;
const VECTOR_WIDTH = 16;
const AUTHORIZATION_TOLERANCE = 3 / 255;
const AUTHORIZED_TARGET_FORMATS = new Set<GPUTextureFormat>([
    'bgra8unorm',
    'rgba8unorm'
]);

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
    routes: Map<string, CachedRouteProbe>
};

type TelemetryAccumulator = {
    authorizedRouteKeys: RawHDRAuthorizationRouteKey[]
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

const FULL_FRAME_PRESENTATION: RawYUVTexturePresentation = {
    textureOffsetX: 0,
    textureOffsetY: 0,
    textureScaleX: 1,
    textureScaleY: 1,
    viewportHeight: VECTOR_HEIGHT,
    viewportWidth: VECTOR_WIDTH,
    viewportX: 0,
    viewportY: 0
};

function alignTo(value: number, alignment: number): number {
    return Math.ceil(value / alignment) * alignment;
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function getRawFormatBitDepth(format: AuthorizedRawSDRFormat): RawVideoBitDepth {
    switch (format) {
        case 'I420':
        case 'I422':
        case 'I444':
            return 8;
        case 'I420P10':
        case 'I422P10':
        case 'I444P10':
            return 10;
        case 'I420P12':
        case 'I422P12':
        case 'I444P12':
            return 12;
    }
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
    for (let y = 0; y < VECTOR_HEIGHT; y += 1) {
        for (let x = 0; x < VECTOR_WIDTH; x += 1) {
            const rampCode = (16 * codeScale) + Math.round((219 * codeScale * x) / (VECTOR_WIDTH - 1));
            const lumaCode = y < VECTOR_HEIGHT / 2 ?
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
    if (y < VECTOR_HEIGHT / 4) {
        return [ 128 * codeScale, 128 * codeScale ];
    }
    return x < VECTOR_WIDTH / 4 ?
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
    const chromaWidth = VECTOR_WIDTH / chromaWidthDivisor;
    const chromaHeight = VECTOR_HEIGHT / chromaHeightDivisor;
    const lumaPlane = createPlaneDescriptor(
        'y',
        VECTOR_WIDTH,
        VECTOR_HEIGHT,
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
        codedHeight: VECTOR_HEIGHT,
        codedWidth: VECTOR_WIDTH,
        colorSpace: {
            fullRange: metadata.range === 'full',
            matrix: metadata.matrix,
            primaries: metadata.primaries,
            transfer: getRawFrameTransfer(metadata)
        },
        data,
        displayHeight: VECTOR_HEIGHT,
        displayWidth: VECTOR_WIDTH,
        durationMicroseconds: null,
        format,
        planes: [ lumaPlane, chromaUPlane, chromaVPlane ],
        timestampMicroseconds: millisecondsToMicroseconds(0),
        visibleRectangle: {
            height: VECTOR_HEIGHT,
            width: VECTOR_WIDTH,
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

/** Compares bounded readbacks with quantization and shader arithmetic tolerance. */
export function evaluateRawHDRVectorObservations(
    expectedObservations: readonly RawHDRVectorObservation[],
    actualObservations: readonly RawHDRVectorObservation[],
    tolerance = AUTHORIZATION_TOLERANCE
): { accepted: boolean, maximumChannelError: number } {
    if (actualObservations.length !== expectedObservations.length) {
        return { accepted: false, maximumChannelError: Number.POSITIVE_INFINITY };
    }

    let maximumChannelError = 0;
    for (let sampleIndex = 0; sampleIndex < expectedObservations.length; sampleIndex += 1) {
        const expected = expectedObservations[sampleIndex];
        const actual = actualObservations[sampleIndex];
        if (actual.sampleX !== expected.sampleX || actual.sampleY !== expected.sampleY) {
            return { accepted: false, maximumChannelError: Number.POSITIVE_INFINITY };
        }
        for (let componentIndex = 0; componentIndex < 3; componentIndex += 1) {
            const channelError = Math.abs(actual.linearRGB[componentIndex] - expected.linearRGB[componentIndex]);
            if (!Number.isFinite(channelError)) {
                return { accepted: false, maximumChannelError: Number.POSITIVE_INFINITY };
            }
            maximumChannelError = Math.max(maximumChannelError, channelError);
        }
    }
    return {
        accepted: maximumChannelError <= tolerance,
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
    device: GPUDevice,
    targetFormat: GPUTextureFormat,
    routeKey: RawHDRAuthorizationRouteKey,
    shaderSignature: string,
    failureReason: RawHDRAuthorizationFailureReason,
    sampleCount = 0,
    maximumChannelError: number | null = null
): RawHDRRouteAuthorizationDecision {
    return {
        authorizedRouteKeys: [],
        device,
        failureReason,
        vectorVersion: RAW_HDR_AUTHORIZATION_VECTOR_VERSION,
        maximumChannelError,
        renderSettingsVersion: RENDER_SETTINGS_VERSION,
        routeKey,
        sampleCount,
        shaderSignature,
        status: 'rejected',
        targetFormat
    };
}

function getCachedRouteProbe(
    deviceCache: DeviceProbeCache | undefined,
    targetFormat: GPUTextureFormat,
    routeKey: RawHDRAuthorizationRouteKey
): CachedRouteProbe | undefined {
    const metadata = createMetadata(routeKey);
    const settings = createSettings(metadata);
    const shaderCode = createRawYUVColorPipelineWGSL(metadata, settings, getRouteFormat(routeKey));
    const signature = createRawHDRShaderSignature(targetFormat, shaderCode);
    return deviceCache?.routes.get(`${targetFormat}\u0000${signature}\u0000${routeKey}`);
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

/** Runs the production raw upload, binding, shader, viewport, and draw path. */
export class RawHDRPresentationAuthorizationRunner {
    public async validate(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        routeKey: RawHDRAuthorizationRouteKey
    ): Promise<RawHDRRouteAuthorizationDecision> {
        const metadata = createMetadata(routeKey);
        const settings = createSettings(metadata);
        const format = getRouteFormat(routeKey);
        const shaderCode = createRawYUVColorPipelineWGSL(metadata, settings, format);
        const shaderSignature = createRawHDRShaderSignature(targetFormat, shaderCode);
        if (!AUTHORIZED_TARGET_FORMATS.has(targetFormat)) {
            return createRejectedDecision(device, targetFormat, routeKey, shaderSignature, 'target-format-unsupported');
        }
        const targetUsage = getValidationTextureUsage();
        if (
            targetUsage === null
            || typeof GPUBufferUsage === 'undefined'
            || typeof GPUTextureUsage === 'undefined'
        ) {
            return createRejectedDecision(device, targetFormat, routeKey, shaderSignature, 'gpu-api-unavailable');
        }

        let targetTexture: GPUTexture | null = null;
        let textureSet: RawPlaneTextureSet | null = null;
        let presentationUniformBuffer: GPUBuffer | null = null;
        let renderSettingsUniformBuffer: GPUBuffer | null = null;
        let pixelReader: GPUCanvasPixelReader | null = null;
        let errorScopePushed = false;
        const deadline = new GPUAuthorizationDeadline(device, RAW_HDR_AUTHORIZATION_TIMEOUT_MICROSECONDS);
        try {
            const pipeline = await deadline.wait(createRawYUVRenderPipeline(device, targetFormat, shaderCode));
            const resources = createRawYUVRenderResources(device, pipeline, settings);
            presentationUniformBuffer = resources.presentationUniformBuffer;
            renderSettingsUniformBuffer = resources.renderSettingsUniformBuffer;
            const frame = createRawHDRAuthorizationVector(routeKey);
            targetTexture = device.createTexture({
                dimension: '2d',
                format: targetFormat,
                label: 'WebGPU raw HDR authorization target',
                size: {
                    depthOrArrayLayers: 1,
                    height: VECTOR_HEIGHT,
                    width: VECTOR_WIDTH
                },
                usage: targetUsage
            });
            device.pushErrorScope('validation');
            errorScopePushed = true;
            const renderResult = renderRawYUVFrame({
                ...resources,
                device,
                frame,
                presentation: FULL_FRAME_PRESENTATION,
                targetView: targetTexture.createView(),
                textureSet
            });
            textureSet = renderResult.textureSet;
            await deadline.wait(device.queue.onSubmittedWorkDone());
            const validationPromise = device.popErrorScope();
            errorScopePushed = false;
            const validationError = await deadline.wait(validationPromise);
            if (validationError) {
                return createRejectedDecision(device, targetFormat, routeKey, shaderSignature, 'gpu-validation-failed');
            }

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
                return createRejectedDecision(device, targetFormat, routeKey, shaderSignature, 'readback-failed');
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
            if (!comparison.accepted) {
                return createRejectedDecision(
                    device,
                    targetFormat,
                    routeKey,
                    shaderSignature,
                    'pixel-mismatch',
                    actualObservations.length,
                    comparison.maximumChannelError
                );
            }
            return {
                authorizedRouteKeys: [ routeKey ],
                device,
                failureReason: null,
                vectorVersion: RAW_HDR_AUTHORIZATION_VECTOR_VERSION,
                maximumChannelError: comparison.maximumChannelError,
                renderSettingsVersion: RENDER_SETTINGS_VERSION,
                routeKey,
                sampleCount: actualObservations.length,
                shaderSignature,
                status: 'authorized',
                targetFormat
            };
        } catch (error) {
            return createRejectedDecision(device, targetFormat, routeKey, shaderSignature, classifyFailure(error));
        } finally {
            deadline.destroy();
            if (errorScopePushed) {
                discardErrorScope(device);
            }
            pixelReader?.destroy();
            destroyRawPlaneTextureSet(textureSet);
            presentationUniformBuffer?.destroy();
            renderSettingsUniformBuffer?.destroy();
            targetTexture?.destroy();
        }
    }
}

/** Caches raw YUV authorization decisions per device, keyed by target format, shader signature, and route. */
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
        const metadata = createMetadata(routeKey);
        const settings = createSettings(metadata);
        const format = getRouteFormat(routeKey);
        const shaderCode = createRawYUVColorPipelineWGSL(metadata, settings, format);
        const shaderSignature = createRawHDRShaderSignature(targetFormat, shaderCode);
        const cacheKey = `${targetFormat}\u0000${shaderSignature}\u0000${routeKey}`;
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
            (): RawHDRRouteAuthorizationDecision => {
                const decision = createRejectedDecision(device, targetFormat, routeKey, shaderSignature, 'unexpected-error');
                probe.decision = decision;
                return decision;
            }
        );
        deviceCache.routes.set(cacheKey, probe);
        return probe.promise;
    }

    /** Returns true only when a settled probe authorized this device, target format, and shader; a pending probe counts as unauthorized. */
    public isAuthorized(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        metadata: InputColorMetadata,
        settings: RenderSettings,
        format: SupportedRawVideoFrameFormat
    ): boolean {
        const routeKey = getRawHDRAuthorizationRouteKey(format, metadata);
        if (!routeKey) {
            return false;
        }
        const shaderCode = createRawYUVColorPipelineWGSL(metadata, settings, format);
        const shaderSignature = createRawHDRShaderSignature(targetFormat, shaderCode);
        const cacheKey = `${targetFormat}\u0000${shaderSignature}\u0000${routeKey}`;
        const decision = this.devices.get(device)?.routes.get(cacheKey)?.decision;
        return decision?.status === 'authorized'
            && decision.device === device
            && decision.targetFormat === targetFormat
            && decision.shaderSignature === shaderSignature
            && decision.authorizedRouteKeys.includes(routeKey);
    }

    /** Returns bounded state for diagnostics without exposing GPU objects. */
    public getTelemetry(device: GPUDevice | null, targetFormat: GPUTextureFormat | null): RawHDRAuthorizationTelemetry {
        if (!device || !targetFormat) {
            return {
                authorizedRouteKeys: [],
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
            failureReasons: accumulator.failureReasons,
            vectorVersion: RAW_HDR_AUTHORIZATION_VECTOR_VERSION,
            pendingRouteKeys: accumulator.pendingRouteKeys,
            rejectedRouteKeys: accumulator.rejectedRouteKeys,
            renderSettingsVersion: RENDER_SETTINGS_VERSION,
            status: getAuthorizationTelemetryStatus(accumulator),
            targetFormat
        };
    }

    private getDeviceCache(device: GPUDevice): DeviceProbeCache {
        const existingCache = this.devices.get(device);
        if (existingCache) {
            return existingCache;
        }
        const deviceCache: DeviceProbeCache = {
            lossObserved: false,
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
