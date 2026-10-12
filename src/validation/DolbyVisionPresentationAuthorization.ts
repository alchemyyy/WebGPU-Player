import {
    createDefaultRenderSettings,
    createHDRToSDRRenderSettings,
    createRenderSettingsUniformData,
    RENDER_SETTINGS_VERSION,
    type HDRToSDRRenderSettings
} from '../presentation/RenderSettings';
import { createPQColorMetadata, createSDRColorMetadata } from '../color/ColorMetadata';
import {
    processEncodedYUV,
    processEncodedRGB,
    type ColorTriplet
} from '../color/ColorPipeline';
import {
    reconstructDolbyVisionBT2020PQ,
    reconstructDolbyVisionBT2020PQWithEnhancement
} from '../color/DolbyVisionColorTransform';
import { DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH } from '../video/dolby-vision/DolbyVisionRPUParser';
import {
    RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT,
    RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT,
    type RawVideoPlaneDescriptor,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from '../video/RawVideoFrameCopy';
import { createBuiltinChain } from '../presentation/passes/builtin/BuiltinChains';
import type {
    BuiltinChain,
    BuiltinChainConfiguration,
    RawDolbyVisionFrameFormat
} from '../presentation/passes/PassTypes';
import type { PresentationExecutor } from '../presentation/passes/PresentationExecutor';
import { VALIDATION_ERROR_FILTER } from '../presentation/WebGPUConstants';
import type { DolbyVisionReconstructionProfile } from '../presentation/PresentationInput';
import { createDolbyVisionAuthorizationRPUVector } from '../capability/vectors/DolbyVisionAuthorizationVector';
import GPUAuthorizationDeadline from './GPUAuthorizationDeadline';
import { GPUCanvasPixelReader } from './GPUCanvasReadback';
import { discardErrorScope } from './GPUErrorScope';
import {
    calculateRawHDRAuthorizationOutputDither,
    createAuthorizationExecutor,
    createAuthorizationReferencePlan,
    createRawHDRAuthorizationVector,
    describeAuthorizationDecision,
    describeAuthorizationError,
    describeReadbackFailure,
    encodeAuthorizationFrame,
    evaluateRawHDRVectorObservations,
    getAuthorizationTargetUsage,
    isAuthorizationTargetFormat,
    RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
    RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES,
    RAW_HDR_AUTHORIZATION_VECTOR_WIDTH,
    sampleRawI420P10Frame,
    type AuthorizationReferencePlan,
    type AuthorizationStep,
    type RawHDRAuthorizationRouteKey,
    type RawHDRVectorObservation
} from './RawHDRPresentationAuthorization';

export const DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION = 4;
export const DOLBY_VISION_AUTHORIZATION_ROUTE_KEY = 'I420P10:dovi-rpu-v1';
export const DOLBY_VISION_PROFILE4_AUTHORIZATION_ROUTE_KEY = 'I420P10:dovi-profile4-base-v1';
export const DOLBY_VISION_PROFILE4_FEL_AUTHORIZATION_ROUTE_KEY = 'I420P10:dovi-profile4-fel-v1';
export const DOLBY_VISION_PROFILE7_AUTHORIZATION_ROUTE_KEY = 'I420P10:dovi-profile7-base-v1';
export const DOLBY_VISION_PROFILE7_FEL_AUTHORIZATION_ROUTE_KEY = 'I420P10:dovi-profile7-fel-v1';

export type DolbyVisionAuthorizationRoute =
    | 'profile4-base'
    | 'profile4-fel'
    | 'profile7-base'
    | 'profile7-fel'
    | 'single-layer';
// One key per route and raw BL format; the dual-layer EL is I420P10 under every key
export type DolbyVisionAuthorizationRouteKey =
    | `${RawDolbyVisionFrameFormat}:dovi-profile4-base-v1`
    | `${RawDolbyVisionFrameFormat}:dovi-profile4-fel-v1`
    | `${RawDolbyVisionFrameFormat}:dovi-profile7-base-v1`
    | `${RawDolbyVisionFrameFormat}:dovi-profile7-fel-v1`
    | `${RawDolbyVisionFrameFormat}:dovi-rpu-v1`;

export type DolbyVisionAuthorizationFailureReason =
    | 'device-lost'
    | 'gpu-api-unavailable'
    | 'gpu-validation-failed'
    | 'pixel-mismatch'
    | 'readback-failed'
    | 'route-unsupported'
    | 'target-format-unsupported'
    | 'timeout'
    | 'unexpected-error';

export type DolbyVisionAuthorizationDecision = {
    device: GPUDevice
    /** The failing value of a rejection, such as `scenario 2: 14/255 > 3/255 at (3, 7)`; null when authorized */
    failureDetail: string | null
    failureReason: DolbyVisionAuthorizationFailureReason | null
    vectorVersion: typeof DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION
    maximumChannelError: number | null
    renderSettingsVersion: typeof RENDER_SETTINGS_VERSION
    routeKey: DolbyVisionAuthorizationRouteKey
    sampleCount: number
    shaderSignature: string
    status: 'authorized' | 'rejected'
    targetFormat: GPUTextureFormat
};

export type DolbyVisionAuthorizationTelemetry = {
    failureDetail: string | null
    failureReason: DolbyVisionAuthorizationFailureReason | null
    vectorVersion: typeof DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION
    maximumChannelError: number | null
    renderSettingsVersion: typeof RENDER_SETTINGS_VERSION
    routeKey: DolbyVisionAuthorizationRouteKey
    sampleCount: number
    status: 'authorized' | 'pending' | 'rejected' | 'unavailable'
    targetFormat: GPUTextureFormat | null
};

type CachedProbe = {
    decision: DolbyVisionAuthorizationDecision | null
    promise: Promise<DolbyVisionAuthorizationDecision>
};

type DeviceProbeCache = {
    probes: Map<GPUTextureFormat, CachedProbe>
    /** The reference chain's shader signature per target format, which planning makes stable per device */
    referenceSignatures: Map<GPUTextureFormat, string>
};

type DolbyVisionAuthorizationScenario = {
    enhancementFrame: TransferableRawVideoFrame | null
    expectedObservations: readonly RawHDRVectorObservation[]
    frame: TransferableRawVideoFrame
    packedRPUData: ArrayBuffer
};

export type DolbyVisionAuthorizationObservationMode =
    | 'fel-hdr10-base'
    | 'fel-residual'
    | 'fel-sdr-base'
    | 'reconstruct';

// The profile each route's reference chain reconstructs; the single-layer chain covers Profiles 5 and 8 alike
const SINGLE_LAYER_REFERENCE_PROFILE: DolbyVisionReconstructionProfile = 8;

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function createSettings(): HDRToSDRRenderSettings {
    return createHDRToSDRRenderSettings({
        toneMapping: { inputPeakNits: 4_000 }
    });
}

function alignPlaneBytesPerRow(rowByteLength: number): number {
    return Math.ceil(rowByteLength / RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT) * RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT;
}

function createFELPlaneDescriptor(
    kind: 'u' | 'v' | 'y',
    width: number,
    height: number,
    byteOffset: number
): RawVideoPlaneDescriptor {
    const rowByteLength = width * Uint16Array.BYTES_PER_ELEMENT;
    const bytesPerRow = alignPlaneBytesPerRow(rowByteLength);
    return {
        byteLength: bytesPerRow * height,
        byteOffset,
        bytesPerComponent: 2,
        bytesPerRow,
        componentsPerTexel: 1,
        height,
        kind,
        rowByteLength,
        width
    };
}

function setFELPlaneCode(
    data: ArrayBuffer,
    plane: RawVideoPlaneDescriptor,
    x: number,
    y: number,
    code: number
): void {
    new DataView(data).setUint16(
        plane.byteOffset + (y * plane.bytesPerRow) + (x * Uint16Array.BYTES_PER_ELEMENT),
        code,
        true
    );
}

/** Builds the BL vector in format and a half-resolution I420P10 EL behind it in one compound buffer. */
function createFELAuthorizationFrames(format: RawDolbyVisionFrameFormat): {
    baseFrame: TransferableRawVideoFrame
    enhancementFrame: TransferableRawVideoFrame
} {
    const baseFrame = createRawHDRAuthorizationVector(getAuthorizationVectorKey(format));
    const codedWidth = baseFrame.codedWidth / 2;
    const codedHeight = baseFrame.codedHeight / 2;
    const chromaWidth = Math.ceil(codedWidth / 2);
    const chromaHeight = Math.ceil(codedHeight / 2);
    const lumaPlane = createFELPlaneDescriptor('y', codedWidth, codedHeight, 0);
    const chromaUPlane = createFELPlaneDescriptor('u', chromaWidth, chromaHeight, lumaPlane.byteLength);
    const chromaVPlane = createFELPlaneDescriptor('v', chromaWidth, chromaHeight, lumaPlane.byteLength + chromaUPlane.byteLength);
    const enhancementData = new ArrayBuffer(lumaPlane.byteLength + chromaUPlane.byteLength + chromaVPlane.byteLength);
    for (let y = 0; y < lumaPlane.height; y += 1) {
        for (let x = 0; x < lumaPlane.width; x += 1) {
            setFELPlaneCode(enhancementData, lumaPlane, x, y, 96 + ((x * 113 + y * 67) % 800));
        }
    }
    for (let y = 0; y < chromaUPlane.height; y += 1) {
        for (let x = 0; x < chromaUPlane.width; x += 1) {
            setFELPlaneCode(enhancementData, chromaUPlane, x, y, 160 + ((x * 173 + y * 89) % 700));
            setFELPlaneCode(enhancementData, chromaVPlane, x, y, 224 + ((x * 71 + y * 191) % 650));
        }
    }

    const enhancementByteOffset = alignPlaneBytesPerRow(baseFrame.data.byteLength);
    const compoundData = new ArrayBuffer(enhancementByteOffset + enhancementData.byteLength);
    new Uint8Array(compoundData).set(new Uint8Array(baseFrame.data));
    new Uint8Array(compoundData).set(new Uint8Array(enhancementData), enhancementByteOffset);
    baseFrame.data = compoundData;
    const enhancementFrame: TransferableRawVideoFrame = {
        bitDepth: 10,
        codedHeight,
        codedWidth,
        colorSpace: {
            fullRange: false,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            transfer: 'smpte2084'
        },
        data: compoundData,
        displayHeight: codedHeight,
        displayWidth: codedWidth,
        durationMicroseconds: baseFrame.durationMicroseconds,
        format: RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT,
        planes: [ lumaPlane, chromaUPlane, chromaVPlane ].map(
            (plane: RawVideoPlaneDescriptor): RawVideoPlaneDescriptor => ({
                ...plane,
                byteOffset: plane.byteOffset + enhancementByteOffset
            })
        ),
        timestampMicroseconds: baseFrame.timestampMicroseconds,
        visibleRectangle: {
            height: codedHeight,
            width: codedWidth,
            x: 0,
            y: 0
        }
    };
    return { baseFrame, enhancementFrame };
}

function getRawPlane(frame: TransferableRawVideoFrame, kind: 'u' | 'v' | 'y'): RawVideoPlaneDescriptor {
    const plane = frame.planes.find((candidate: RawVideoPlaneDescriptor): boolean => candidate.kind === kind);
    if (!plane) {
        throw new TypeError(`The FEL authorization frame has no ${kind} plane`);
    }
    return plane;
}

function readFELPlaneCode(
    frame: TransferableRawVideoFrame,
    plane: RawVideoPlaneDescriptor,
    x: number,
    y: number
): number {
    const clampedX = Math.min(Math.max(x, 0), plane.width - 1);
    const clampedY = Math.min(Math.max(y, 0), plane.height - 1);
    return new DataView(frame.data).getUint16(
        plane.byteOffset + (clampedY * plane.bytesPerRow) + (clampedX * Uint16Array.BYTES_PER_ELEMENT),
        true
    );
}

function sampleFELPlane(
    frame: TransferableRawVideoFrame,
    plane: RawVideoPlaneDescriptor,
    textureCoordinateX: number,
    textureCoordinateY: number,
    horizontalOffset: number
): number {
    const sampleX = (textureCoordinateX + horizontalOffset) * plane.width - 0.5;
    const sampleY = textureCoordinateY * plane.height - 0.5;
    const baseX = Math.floor(sampleX);
    const baseY = Math.floor(sampleY);
    const fractionX = sampleX - baseX;
    const fractionY = sampleY - baseY;
    const top = readFELPlaneCode(frame, plane, baseX, baseY) * (1 - fractionX)
        + readFELPlaneCode(frame, plane, baseX + 1, baseY) * fractionX;
    const bottom = readFELPlaneCode(frame, plane, baseX, baseY + 1) * (1 - fractionX)
        + readFELPlaneCode(frame, plane, baseX + 1, baseY + 1) * fractionX;
    return top * (1 - fractionY) + bottom * fractionY;
}

function sampleFELAuthorizationFrame(
    frame: TransferableRawVideoFrame,
    sampleX: number,
    sampleY: number,
    targetWidth: number,
    targetHeight: number
): ColorTriplet {
    const textureCoordinateX = (sampleX + 0.5) / targetWidth;
    const textureCoordinateY = (sampleY + 0.5) / targetHeight;
    const lumaHorizontalOffset = -0.5 / frame.codedWidth;
    const chromaHorizontalOffset = -1 / frame.codedWidth;
    return [
        sampleFELPlane(frame, getRawPlane(frame, 'y'), textureCoordinateX, textureCoordinateY, lumaHorizontalOffset),
        sampleFELPlane(frame, getRawPlane(frame, 'u'), textureCoordinateX, textureCoordinateY, chromaHorizontalOffset),
        sampleFELPlane(frame, getRawPlane(frame, 'v'), textureCoordinateX, textureCoordinateY, chromaHorizontalOffset)
    ];
}

/** Creates a stable identity for the Dolby Vision vector, shader, and target. */
export function createDolbyVisionShaderSignature(targetFormat: GPUTextureFormat, shaderCode: string): string {
    const signatureInput = [
        `vector=${DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION}`,
        `uniform=${RENDER_SETTINGS_VERSION}`,
        `schema=${DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH}`,
        `target=${targetFormat}`,
        shaderCode
    ].join('\u0000');
    let hash = 0x811C_9DC5;
    for (let characterIndex = 0; characterIndex < signatureInput.length; characterIndex += 1) {
        hash ^= signatureInput.charCodeAt(characterIndex);
        hash = Math.imul(hash, 0x0100_0193) >>> 0;
    }
    return `fnv1a32-${hash.toString(16).padStart(8, '0')}`;
}

/** Computes CPU-reference samples for the synthetic authorization vector. */
export function createExpectedDolbyVisionAuthorizationObservations(
    packedRPUData: ArrayBuffer,
    settings: HDRToSDRRenderSettings,
    mode: DolbyVisionAuthorizationObservationMode = 'reconstruct',
    frameValue?: TransferableRawVideoFrame,
    enhancementFrame: TransferableRawVideoFrame | null = null
): readonly RawHDRVectorObservation[] {
    const frame = frameValue ?? createRawHDRAuthorizationVector('I420P10:bt2020-ncl:bt2020:limited:pq');
    const outputMetadata = createPQColorMetadata({ range: 'full' });
    const maximumBaseLayerCode = (2 ** frame.bitDepth) - 1;
    return RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES.map(sample => {
        const rawSignal = sampleRawI420P10Frame(frame, sample.sampleX, sample.sampleY);
        const normalizedSignal: ColorTriplet = [
            rawSignal[0] / maximumBaseLayerCode,
            rawSignal[1] / maximumBaseLayerCode,
            rawSignal[2] / maximumBaseLayerCode
        ];
        let reconstructedSignal: ColorTriplet;
        switch (mode) {
            case 'fel-hdr10-base':
                reconstructedSignal = processEncodedYUV(
                    normalizedSignal,
                    createPQColorMetadata({ bitDepth: frame.bitDepth }),
                    settings
                );
                break;
            case 'fel-sdr-base': {
                // Profile 4 declares an SDR base, which bypasses tone mapping and output dither like identity SDR
                const encodedRGB = processEncodedYUV(
                    normalizedSignal,
                    createSDRColorMetadata({ bitDepth: frame.bitDepth }),
                    createDefaultRenderSettings()
                );
                return {
                    linearRGB: [
                        clamp(encodedRGB[0], 0, 1),
                        clamp(encodedRGB[1], 0, 1),
                        clamp(encodedRGB[2], 0, 1)
                    ],
                    sampleX: sample.sampleX,
                    sampleY: sample.sampleY
                };
            }
            case 'fel-residual': {
                if (!enhancementFrame) {
                    throw new TypeError('FEL authorization requires an enhancement frame');
                }
                const rawEnhancementSignal = sampleFELAuthorizationFrame(
                    enhancementFrame,
                    sample.sampleX,
                    sample.sampleY,
                    frame.displayWidth,
                    frame.displayHeight
                );
                const maximumEnhancementLayerCode = (2 ** enhancementFrame.bitDepth) - 1;
                const normalizedEnhancementSignal: ColorTriplet = [
                    rawEnhancementSignal[0] / maximumEnhancementLayerCode,
                    rawEnhancementSignal[1] / maximumEnhancementLayerCode,
                    rawEnhancementSignal[2] / maximumEnhancementLayerCode
                ];
                reconstructedSignal = processEncodedRGB(
                    reconstructDolbyVisionBT2020PQWithEnhancement(
                        normalizedSignal,
                        normalizedEnhancementSignal,
                        packedRPUData
                    ),
                    outputMetadata,
                    settings
                );
                break;
            }
            case 'reconstruct':
                reconstructedSignal = processEncodedRGB(
                    reconstructDolbyVisionBT2020PQ(normalizedSignal, packedRPUData),
                    outputMetadata,
                    settings
                );
                break;
        }
        const dither = calculateRawHDRAuthorizationOutputDither(sample.sampleX, sample.sampleY);
        return {
            linearRGB: [
                clamp(reconstructedSignal[0] + dither, 0, 1),
                clamp(reconstructedSignal[1] + dither, 0, 1),
                clamp(reconstructedSignal[2] + dither, 0, 1)
            ],
            sampleX: sample.sampleX,
            sampleY: sample.sampleY
        };
    });
}

/** Returns the CPU reference for the reduced-resolution FEL probe of one dual-layer profile and BL format. */
export function createExpectedDolbyVisionFELAuthorizationObservations(
    settings: HDRToSDRRenderSettings,
    profile: 4 | 7 = 7,
    format: RawDolbyVisionFrameFormat = 'I420P10'
): readonly RawHDRVectorObservation[] {
    const { baseFrame, enhancementFrame } = createFELAuthorizationFrames(format);
    const packedRPUData = createDolbyVisionAuthorizationRPUVector(profile, 'fel', baseFrame.bitDepth);
    return createExpectedDolbyVisionAuthorizationObservations(
        packedRPUData,
        settings,
        'fel-residual',
        baseFrame,
        enhancementFrame
    );
}

function getAuthorizationRouteKey(
    route: DolbyVisionAuthorizationRoute,
    format: RawDolbyVisionFrameFormat
): DolbyVisionAuthorizationRouteKey {
    switch (route) {
        case 'profile4-base':
            return `${format}:dovi-profile4-base-v1`;
        case 'profile4-fel':
            return `${format}:dovi-profile4-fel-v1`;
        case 'profile7-base':
            return `${format}:dovi-profile7-base-v1`;
        case 'profile7-fel':
            return `${format}:dovi-profile7-fel-v1`;
        case 'single-layer':
            return `${format}:dovi-rpu-v1`;
    }
}

/** Returns the built-in chain configuration a route's reference chain is built from. */
function createDolbyVisionAuthorizationChainConfiguration(
    route: DolbyVisionAuthorizationRoute,
    format: RawDolbyVisionFrameFormat
): BuiltinChainConfiguration {
    let profile: DolbyVisionReconstructionProfile;
    let felReconstruction = false;
    switch (route) {
        case 'profile4-fel':
            felReconstruction = true;
            profile = 4;
            break;
        case 'profile4-base':
            profile = 4;
            break;
        case 'profile7-fel':
            felReconstruction = true;
            profile = 7;
            break;
        case 'profile7-base':
            profile = 7;
            break;
        case 'single-layer':
            profile = SINGLE_LAYER_REFERENCE_PROFILE;
            break;
    }
    return {
        felReconstruction,
        format,
        hdrOutput: false,
        profile,
        route: 'raw-dolby-vision',
        settings: createSettings()
    };
}

function createDolbyVisionReferencePlan(
    device: GPUDevice,
    targetFormat: GPUTextureFormat,
    route: DolbyVisionAuthorizationRoute,
    format: RawDolbyVisionFrameFormat
): AuthorizationReferencePlan {
    const configuration = createDolbyVisionAuthorizationChainConfiguration(route, format);
    return createAuthorizationReferencePlan(device, (): BuiltinChain => createBuiltinChain(configuration), {
        format: targetFormat,
        hdrSource: true,
        height: RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
        width: RAW_HDR_AUTHORIZATION_VECTOR_WIDTH
    });
}

/** Returns the raw HDR vector key whose luma ramp and chroma blocks cover one raw frame format. */
function getAuthorizationVectorKey(format: RawDolbyVisionFrameFormat): RawHDRAuthorizationRouteKey {
    // 8-bit formats have no PQ vector; the reconstruction ignores the vector's color tags either way
    switch (format) {
        case 'I420':
        case 'I422':
        case 'I444':
            return `${format}:bt709:bt709:limited:sdr`;
        default:
            return `${format}:bt2020-ncl:bt2020:limited:pq`;
    }
}

/**
 * Returns the dual-layer scenarios over a BL vector in the given format, with RPU vectors that declare the format's bit depth.
 * The FEL route composes a half-resolution I420P10 EL; the base route checks MEL reconstruction and the FEL compatible-base fallback.
 */
function createDualLayerAuthorizationScenarios(
    profile: 4 | 7,
    reconstructsFEL: boolean,
    format: RawDolbyVisionFrameFormat,
    settings: HDRToSDRRenderSettings
): DolbyVisionAuthorizationScenario[] {
    const scenarios: DolbyVisionAuthorizationScenario[] = [];
    if (reconstructsFEL) {
        const { baseFrame, enhancementFrame } = createFELAuthorizationFrames(format);
        const packedRPUData = createDolbyVisionAuthorizationRPUVector(profile, 'fel', baseFrame.bitDepth);
        scenarios.push({
            enhancementFrame,
            expectedObservations: createExpectedDolbyVisionAuthorizationObservations(
                packedRPUData,
                settings,
                'fel-residual',
                baseFrame,
                enhancementFrame
            ),
            frame: baseFrame,
            packedRPUData
        });
        return scenarios;
    }

    const frame = createRawHDRAuthorizationVector(getAuthorizationVectorKey(format));
    const melRPUData = createDolbyVisionAuthorizationRPUVector(profile, 'mel', frame.bitDepth);
    scenarios.push({
        enhancementFrame: null,
        expectedObservations: createExpectedDolbyVisionAuthorizationObservations(
            melRPUData,
            settings,
            'reconstruct',
            frame
        ),
        frame,
        packedRPUData: melRPUData
    });
    const felRPUData = createDolbyVisionAuthorizationRPUVector(profile, 'fel', frame.bitDepth);
    scenarios.push({
        enhancementFrame: null,
        expectedObservations: createExpectedDolbyVisionAuthorizationObservations(
            felRPUData,
            settings,
            profile === 4 ? 'fel-sdr-base' : 'fel-hdr10-base',
            frame
        ),
        frame,
        packedRPUData: felRPUData
    });
    return scenarios;
}

function createAuthorizationScenarios(
    route: DolbyVisionAuthorizationRoute,
    format: RawDolbyVisionFrameFormat,
    settings: HDRToSDRRenderSettings
): DolbyVisionAuthorizationScenario[] {
    switch (route) {
        case 'profile4-base':
            return createDualLayerAuthorizationScenarios(4, false, format, settings);
        case 'profile4-fel':
            return createDualLayerAuthorizationScenarios(4, true, format, settings);
        case 'profile7-base':
            return createDualLayerAuthorizationScenarios(7, false, format, settings);
        case 'profile7-fel':
            return createDualLayerAuthorizationScenarios(7, true, format, settings);
        case 'single-layer': {
            const frame = createRawHDRAuthorizationVector(getAuthorizationVectorKey(format));
            const packedRPUData = createDolbyVisionAuthorizationRPUVector(8, 'single-layer', frame.bitDepth);
            return [ {
                enhancementFrame: null,
                expectedObservations: createExpectedDolbyVisionAuthorizationObservations(
                    packedRPUData,
                    settings,
                    'reconstruct',
                    frame
                ),
                frame,
                packedRPUData
            } ];
        }
    }
}

function classifyFailure(error: unknown): DolbyVisionAuthorizationFailureReason {
    switch (getErrorMessage(error)) {
        case 'device-lost':
            return 'device-lost';
        case 'timeout':
            return 'timeout';
        default:
            return 'unexpected-error';
    }
}

/** The device, target, route, and reference shader one probe renders, which every decision of the probe carries. */
type RouteProbeIdentity = {
    device: GPUDevice
    routeKey: DolbyVisionAuthorizationRouteKey
    shaderSignature: string
    targetFormat: GPUTextureFormat
};

function createRejectedDecision(
    probe: RouteProbeIdentity,
    failureReason: DolbyVisionAuthorizationFailureReason,
    failureDetail: string,
    sampleCount = 0,
    maximumChannelError: number | null = null
): DolbyVisionAuthorizationDecision {
    return {
        device: probe.device,
        failureDetail,
        failureReason,
        vectorVersion: DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION,
        maximumChannelError,
        renderSettingsVersion: RENDER_SETTINGS_VERSION,
        routeKey: probe.routeKey,
        sampleCount,
        shaderSignature: probe.shaderSignature,
        status: 'rejected',
        targetFormat: probe.targetFormat
    };
}

/** Prefixes a scenario's detail with its number when a route renders more than one scenario. */
function describeScenarioFailure(detail: string, scenarioIndex: number, scenarioCount: number): string {
    return scenarioCount > 1 ? `scenario ${scenarioIndex + 1}: ${detail}` : detail;
}

/** Renders a route's vectors through its built-in default chain, reads them back, and compares them with the CPU reference. */
export class DolbyVisionPresentationAuthorizationRunner {
    public readonly routeKey: DolbyVisionAuthorizationRouteKey;

    public constructor(
        public readonly route: DolbyVisionAuthorizationRoute = 'single-layer',
        public readonly format: RawDolbyVisionFrameFormat = 'I420P10'
    ) {
        this.routeKey = getAuthorizationRouteKey(route, format);
    }

    public async validate(device: GPUDevice, targetFormat: GPUTextureFormat): Promise<DolbyVisionAuthorizationDecision> {
        const settings = createSettings();
        const reference = createDolbyVisionReferencePlan(device, targetFormat, this.route, this.format);
        const probe: RouteProbeIdentity = {
            device,
            routeKey: this.routeKey,
            shaderSignature: createDolbyVisionShaderSignature(targetFormat, reference.shaderCode),
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
            return createRejectedDecision(probe, 'unexpected-error', reference.failure ?? this.routeKey);
        }

        let targetTexture: GPUTexture | null = null;
        let executor: PresentationExecutor | null = null;
        let pixelReader: GPUCanvasPixelReader | null = null;
        let errorScopePushed = false;
        let step: AuthorizationStep = 'executor';
        const deadline = new GPUAuthorizationDeadline(device);
        try {
            const scenarios = createAuthorizationScenarios(this.route, this.format, settings);
            executor = await createAuthorizationExecutor(device, plan, deadline);
            if (plan.usesRenderSettings) {
                executor.writeRenderSettings(createRenderSettingsUniformData(settings).buffer);
            }
            const frame = scenarios[0].frame;
            targetTexture = device.createTexture({
                dimension: '2d',
                format: targetFormat,
                label: 'WebGPU Dolby Vision authorization target',
                size: {
                    depthOrArrayLayers: 1,
                    height: frame.displayHeight,
                    width: frame.displayWidth
                },
                usage: targetUsage.usage
            });
            pixelReader = new GPUCanvasPixelReader({
                device,
                format: targetFormat,
                maximumReadbacks: RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES.length * scenarios.length
            });
            let maximumChannelError = 0;
            let sampleCount = 0;
            for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
                const scenario = scenarios[scenarioIndex];
                step = 'render';
                executor.writeDolbyVisionRPU(scenario.packedRPUData);
                device.pushErrorScope(VALIDATION_ERROR_FILTER);
                errorScopePushed = true;
                device.queue.submit([ encodeAuthorizationFrame(
                    device,
                    executor,
                    { enhancementFrame: scenario.enhancementFrame, frame: scenario.frame, kind: 'planes' },
                    targetTexture,
                    'WebGPU Dolby Vision authorization commands'
                ) ]);
                await deadline.wait(device.queue.onSubmittedWorkDone());
                const validationPromise = device.popErrorScope();
                errorScopePushed = false;
                const validationError = await deadline.wait(validationPromise);
                if (validationError) {
                    return createRejectedDecision(
                        probe,
                        'gpu-validation-failed',
                        describeScenarioFailure(validationError.message, scenarioIndex, scenarios.length)
                    );
                }

                step = 'readback';
                const readback = await deadline.wait(
                    pixelReader.readPixels(RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES, targetTexture),
                    (): void => pixelReader?.destroy()
                );
                const actualObservations: RawHDRVectorObservation[] = [];
                if (readback.failure || !readback.linearRGB) {
                    return createRejectedDecision(
                        probe,
                        'readback-failed',
                        describeScenarioFailure(describeReadbackFailure(readback.failure), scenarioIndex, scenarios.length)
                    );
                }
                for (let sampleIndex = 0; sampleIndex < RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES.length; sampleIndex += 1) {
                    const sample = RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES[sampleIndex];
                    actualObservations.push({
                        linearRGB: readback.linearRGB[sampleIndex],
                        sampleX: sample.sampleX,
                        sampleY: sample.sampleY
                    });
                }
                const comparison = evaluateRawHDRVectorObservations(scenario.expectedObservations, actualObservations);
                sampleCount += actualObservations.length;
                maximumChannelError = Math.max(maximumChannelError, comparison.maximumChannelError);
                if (comparison.failureDetail !== null) {
                    return createRejectedDecision(
                        probe,
                        'pixel-mismatch',
                        describeScenarioFailure(comparison.failureDetail, scenarioIndex, scenarios.length),
                        sampleCount,
                        maximumChannelError
                    );
                }
            }
            return {
                device,
                failureDetail: null,
                failureReason: null,
                vectorVersion: DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION,
                maximumChannelError,
                renderSettingsVersion: RENDER_SETTINGS_VERSION,
                routeKey: this.routeKey,
                sampleCount,
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

/** Caches the Dolby Vision authorization decision per device, keyed by target format; a decision holds only for the current reference shader. */
export class DolbyVisionPresentationAuthorizationRegistry {
    private readonly devices = new WeakMap<GPUDevice, DeviceProbeCache>();
    private readonly runner: DolbyVisionPresentationAuthorizationRunner;

    public constructor(
        runnerOrRoute: DolbyVisionPresentationAuthorizationRunner | DolbyVisionAuthorizationRoute = 'single-layer',
        format: RawDolbyVisionFrameFormat = 'I420P10'
    ) {
        this.runner = typeof runnerOrRoute === 'string' ?
            new DolbyVisionPresentationAuthorizationRunner(runnerOrRoute, format) :
            runnerOrRoute;
    }

    /** Starts the probe for this device and target format without waiting for it. */
    public prewarm(device: GPUDevice, targetFormat: GPUTextureFormat): void {
        void this.authorize(device, targetFormat);
    }

    /** Waits for a probe that is already running, without starting one. */
    public async waitForPending(device: GPUDevice, targetFormat: GPUTextureFormat): Promise<void> {
        const probe = this.getCachedProbe(device, targetFormat);
        if (probe && !probe.decision) {
            await probe.promise;
        }
    }

    /** Returns the decision for one device and target format, starting a probe only when none is cached. */
    public authorize(device: GPUDevice, targetFormat: GPUTextureFormat): Promise<DolbyVisionAuthorizationDecision> {
        const deviceCache = this.getDeviceCache(device);
        const cachedProbe = deviceCache.probes.get(targetFormat);
        if (cachedProbe) {
            return cachedProbe.promise;
        }

        const probe = { decision: null } as CachedProbe;
        probe.promise = Promise.resolve().then(() => (
            this.runner.validate(device, targetFormat)
        )).then(
            (decision: DolbyVisionAuthorizationDecision): DolbyVisionAuthorizationDecision => {
                probe.decision = decision;
                return decision;
            },
            (error: unknown): DolbyVisionAuthorizationDecision => {
                const decision = createRejectedDecision(
                    {
                        device,
                        routeKey: this.runner.routeKey,
                        shaderSignature: this.getReferenceSignature(device, targetFormat),
                        targetFormat
                    },
                    'unexpected-error',
                    getErrorMessage(error)
                );
                probe.decision = decision;
                return decision;
            }
        );
        deviceCache.probes.set(targetFormat, probe);
        return probe.promise;
    }

    /**
     * Returns true only when a settled probe authorized this device and target format through the current reference shader, for the runner's BL format.
     * A pending probe counts as unauthorized.
     */
    public isAuthorized(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        format: SupportedRawVideoFrameFormat
    ): boolean {
        return this.getAuthorizationFailure(device, targetFormat, format) === null;
    }

    /**
     * Returns why this device and target format are not authorized for a BL format, as `<state>: <route key>` with the failing value, or null when they are.
     * A format other than the runner's reports `format-unauthorized` with both formats.
     */
    public getAuthorizationFailure(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        format: SupportedRawVideoFrameFormat
    ): string | null {
        if (format !== this.runner.format) {
            return `format-unauthorized: ${format}, ${this.runner.routeKey} covers ${this.runner.format}`;
        }
        const probe = this.getCachedProbe(device, targetFormat);
        const decision = probe?.decision ?? null;
        if (decision?.status === 'authorized' && (decision.device !== device || decision.targetFormat !== targetFormat)) {
            return `decision-mismatch: ${this.runner.routeKey}`;
        }
        return describeAuthorizationDecision(
            this.runner.routeKey,
            probe !== undefined,
            decision,
            (): string => this.getReferenceSignature(device, targetFormat)
        );
    }

    /** Returns bounded diagnostics without exposing retained GPU objects. */
    public getTelemetry(device: GPUDevice | null, targetFormat: GPUTextureFormat | null): DolbyVisionAuthorizationTelemetry {
        const unavailable: DolbyVisionAuthorizationTelemetry = {
            failureDetail: null,
            failureReason: null,
            vectorVersion: DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION,
            maximumChannelError: null,
            renderSettingsVersion: RENDER_SETTINGS_VERSION,
            routeKey: this.runner.routeKey,
            sampleCount: 0,
            status: 'unavailable',
            targetFormat
        };
        if (!device || !targetFormat) {
            return unavailable;
        }
        const probe = this.getCachedProbe(device, targetFormat);
        if (!probe) {
            return unavailable;
        }
        if (!probe.decision) {
            return { ...unavailable, status: 'pending' };
        }
        return {
            failureDetail: probe.decision.failureDetail,
            failureReason: probe.decision.failureReason,
            vectorVersion: probe.decision.vectorVersion,
            maximumChannelError: probe.decision.maximumChannelError,
            renderSettingsVersion: probe.decision.renderSettingsVersion,
            routeKey: probe.decision.routeKey,
            sampleCount: probe.decision.sampleCount,
            status: probe.decision.status,
            targetFormat: probe.decision.targetFormat
        };
    }

    private getReferenceSignature(device: GPUDevice, targetFormat: GPUTextureFormat): string {
        const referenceSignatures = this.getDeviceCache(device).referenceSignatures;
        const cachedSignature = referenceSignatures.get(targetFormat);
        if (cachedSignature !== undefined) {
            return cachedSignature;
        }
        const signature = createDolbyVisionShaderSignature(
            targetFormat,
            createDolbyVisionReferencePlan(device, targetFormat, this.runner.route, this.runner.format).shaderCode
        );
        referenceSignatures.set(targetFormat, signature);
        return signature;
    }

    private getCachedProbe(device: GPUDevice, targetFormat: GPUTextureFormat): CachedProbe | undefined {
        return this.devices.get(device)?.probes.get(targetFormat);
    }

    private getDeviceCache(device: GPUDevice): DeviceProbeCache {
        const cached = this.devices.get(device);
        if (cached) {
            return cached;
        }
        const created: DeviceProbeCache = {
            probes: new Map<GPUTextureFormat, CachedProbe>(),
            referenceSignatures: new Map<GPUTextureFormat, string>()
        };
        this.devices.set(device, created);
        void device.lost.then((): void => {
            created.probes.clear();
        });
        return created;
    }
}
