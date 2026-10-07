import {
    createDefaultRenderSettings,
    createHDRToSDRRenderSettings,
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
    createRawDolbyVisionColorPipelineWGSL,
    createRawDolbyVisionProfile4ColorPipelineWGSL,
    createRawDolbyVisionProfile4FELColorPipelineWGSL,
    createRawDolbyVisionProfile7ColorPipelineWGSL,
    createRawDolbyVisionProfile7FELColorPipelineWGSL,
    getRawFormatBitDepth,
    type RawDolbyVisionVideoFrameFormat
} from '../color/ColorPipelineShader';
import {
    reconstructDolbyVisionBT2020PQ,
    reconstructDolbyVisionBT2020PQWithEnhancement
} from '../color/DolbyVisionColorTransform';
import { DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH } from '../video/dolby-vision/DolbyVisionRPUParser';
import {
    RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT,
    type RawVideoPlaneDescriptor,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from '../video/RawVideoFrameCopy';
import {
    createRawYUVEnhancementUniformBuffer,
    createRawYUVRenderPipeline,
    createRawYUVRenderResources,
    destroyRawPlaneTextureSet,
    renderRawYUVFrame,
    type RawPlaneTextureSet,
    type RawYUVTexturePresentation
} from '../presentation/RawYUVGPURenderer';
import { createDolbyVisionAuthorizationRPUVector } from '../capability/vectors/DolbyVisionAuthorizationVector';
import GPUAuthorizationDeadline from './GPUAuthorizationDeadline';
import {
    GPUCanvasPixelReader,
    getValidationTextureUsage
} from './GPUCanvasReadback';
import {
    calculateRawHDRAuthorizationOutputDither,
    createRawHDRAuthorizationVector,
    evaluateRawHDRVectorObservations,
    RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES,
    sampleRawI420P10Frame,
    type RawHDRAuthorizationRouteKey,
    type RawHDRVectorObservation
} from './RawHDRPresentationAuthorization';

export const DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION = 4;
export const DOLBY_VISION_AUTHORIZATION_ROUTE_KEY = 'I420P10:dovi-rpu-v1';
export const DOLBY_VISION_PROFILE4_AUTHORIZATION_ROUTE_KEY =
    'I420P10:dovi-profile4-base-v1';
export const DOLBY_VISION_PROFILE4_FEL_AUTHORIZATION_ROUTE_KEY =
    'I420P10:dovi-profile4-fel-v1';
export const DOLBY_VISION_PROFILE7_AUTHORIZATION_ROUTE_KEY =
    'I420P10:dovi-profile7-base-v1';
export const DOLBY_VISION_PROFILE7_FEL_AUTHORIZATION_ROUTE_KEY =
    'I420P10:dovi-profile7-fel-v1';

export type DolbyVisionAuthorizationRoute =
    | 'profile4-base'
    | 'profile4-fel'
    | 'profile7-base'
    | 'profile7-fel'
    | 'single-layer';
export type DolbyVisionAuthorizationRouteKey =
    | `${RawDolbyVisionVideoFrameFormat}:dovi-rpu-v1`
    | typeof DOLBY_VISION_PROFILE4_AUTHORIZATION_ROUTE_KEY
    | typeof DOLBY_VISION_PROFILE4_FEL_AUTHORIZATION_ROUTE_KEY
    | typeof DOLBY_VISION_PROFILE7_AUTHORIZATION_ROUTE_KEY
    | typeof DOLBY_VISION_PROFILE7_FEL_AUTHORIZATION_ROUTE_KEY;

// Profile 4 declares an SDR base, which an FEL frame without its EL presents unmodified
const DOLBY_VISION_PROFILE4_BASE_METADATA = createSDRColorMetadata({ bitDepth: 10 });
const AUTHORIZED_TARGET_FORMATS = new Set<GPUTextureFormat>([
    'bgra8unorm',
    'rgba8unorm'
]);

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
    probes: Map<string, CachedProbe>
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

const FULL_FRAME_PRESENTATION: RawYUVTexturePresentation = {
    textureOffsetX: 0,
    textureOffsetY: 0,
    textureScaleX: 1,
    textureScaleY: 1,
    viewportHeight: 8,
    viewportWidth: 16,
    viewportX: 0,
    viewportY: 0
};

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
    return Math.ceil(rowByteLength / RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT)
        * RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT;
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
        plane.byteOffset
            + (y * plane.bytesPerRow)
            + (x * Uint16Array.BYTES_PER_ELEMENT),
        code,
        true
    );
}

function createFELAuthorizationFrames(): {
    baseFrame: TransferableRawVideoFrame
    enhancementFrame: TransferableRawVideoFrame
} {
    const baseFrame = createRawHDRAuthorizationVector(
        'I420P10:bt2020-ncl:bt2020:limited:pq'
    );
    const codedWidth = baseFrame.codedWidth / 2;
    const codedHeight = baseFrame.codedHeight / 2;
    const chromaWidth = Math.ceil(codedWidth / 2);
    const chromaHeight = Math.ceil(codedHeight / 2);
    const lumaPlane = createFELPlaneDescriptor('y', codedWidth, codedHeight, 0);
    const chromaUPlane = createFELPlaneDescriptor(
        'u',
        chromaWidth,
        chromaHeight,
        lumaPlane.byteLength
    );
    const chromaVPlane = createFELPlaneDescriptor(
        'v',
        chromaWidth,
        chromaHeight,
        lumaPlane.byteLength + chromaUPlane.byteLength
    );
    const enhancementData = new ArrayBuffer(
        lumaPlane.byteLength + chromaUPlane.byteLength + chromaVPlane.byteLength
    );
    for (let y = 0; y < lumaPlane.height; y += 1) {
        for (let x = 0; x < lumaPlane.width; x += 1) {
            setFELPlaneCode(
                enhancementData,
                lumaPlane,
                x,
                y,
                96 + ((x * 113 + y * 67) % 800)
            );
        }
    }
    for (let y = 0; y < chromaUPlane.height; y += 1) {
        for (let x = 0; x < chromaUPlane.width; x += 1) {
            setFELPlaneCode(
                enhancementData,
                chromaUPlane,
                x,
                y,
                160 + ((x * 173 + y * 89) % 700)
            );
            setFELPlaneCode(
                enhancementData,
                chromaVPlane,
                x,
                y,
                224 + ((x * 71 + y * 191) % 650)
            );
        }
    }

    const enhancementByteOffset = alignPlaneBytesPerRow(baseFrame.data.byteLength);
    const compoundData = new ArrayBuffer(
        enhancementByteOffset + enhancementData.byteLength
    );
    new Uint8Array(compoundData).set(new Uint8Array(baseFrame.data));
    new Uint8Array(compoundData).set(
        new Uint8Array(enhancementData),
        enhancementByteOffset
    );
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
        format: 'I420P10',
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

function getRawPlane(
    frame: TransferableRawVideoFrame,
    kind: 'u' | 'v' | 'y'
): RawVideoPlaneDescriptor {
    const plane = frame.planes.find(
        (candidate: RawVideoPlaneDescriptor): boolean => candidate.kind === kind
    );
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
        plane.byteOffset
            + (clampedY * plane.bytesPerRow)
            + (clampedX * Uint16Array.BYTES_PER_ELEMENT),
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
    const top = readFELPlaneCode(frame, plane, baseX, baseY)
        * (1 - fractionX)
        + readFELPlaneCode(frame, plane, baseX + 1, baseY) * fractionX;
    const bottom = readFELPlaneCode(frame, plane, baseX, baseY + 1)
        * (1 - fractionX)
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
        sampleFELPlane(
            frame,
            getRawPlane(frame, 'y'),
            textureCoordinateX,
            textureCoordinateY,
            lumaHorizontalOffset
        ),
        sampleFELPlane(
            frame,
            getRawPlane(frame, 'u'),
            textureCoordinateX,
            textureCoordinateY,
            chromaHorizontalOffset
        ),
        sampleFELPlane(
            frame,
            getRawPlane(frame, 'v'),
            textureCoordinateX,
            textureCoordinateY,
            chromaHorizontalOffset
        )
    ];
}

/** Creates a stable identity for the exact DV vector, shader, and target. */
export function createDolbyVisionShaderSignature(
    targetFormat: GPUTextureFormat,
    shaderCode: string
): string {
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

/** Computes CPU-reference samples for the exact synthetic authorization vector. */
export function createExpectedDolbyVisionAuthorizationObservations(
    packedRPUData: ArrayBuffer,
    settings: HDRToSDRRenderSettings,
    mode: DolbyVisionAuthorizationObservationMode = 'reconstruct',
    frameValue?: TransferableRawVideoFrame,
    enhancementFrame: TransferableRawVideoFrame | null = null
): readonly RawHDRVectorObservation[] {
    const frame = frameValue ?? createRawHDRAuthorizationVector(
        'I420P10:bt2020-ncl:bt2020:limited:pq'
    );
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
                    createPQColorMetadata(),
                    settings
                );
                break;
            case 'fel-sdr-base': {
                // The SDR base bypasses tone mapping and output dither, exactly like identity SDR
                const encodedRGB = processEncodedYUV(
                    normalizedSignal,
                    DOLBY_VISION_PROFILE4_BASE_METADATA,
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
                    reconstructDolbyVisionBT2020PQ(
                        normalizedSignal,
                        packedRPUData
                    ),
                    outputMetadata,
                    settings
                );
                break;
        }
        const dither = calculateRawHDRAuthorizationOutputDither(
            sample.sampleX,
            sample.sampleY
        );
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

/** Returns the exact CPU reference for the reduced-resolution FEL probe of one dual-layer profile. */
export function createExpectedDolbyVisionFELAuthorizationObservations(
    settings: HDRToSDRRenderSettings,
    profile: 4 | 7 = 7
): readonly RawHDRVectorObservation[] {
    const packedRPUData = createDolbyVisionAuthorizationRPUVector(profile, 'fel');
    const { baseFrame, enhancementFrame } = createFELAuthorizationFrames();
    return createExpectedDolbyVisionAuthorizationObservations(
        packedRPUData,
        settings,
        'fel-residual',
        baseFrame,
        enhancementFrame
    );
}

function isDualLayerAuthorizationRoute(route: DolbyVisionAuthorizationRoute): boolean {
    return route !== 'single-layer';
}

function getAuthorizationRouteKey(
    route: DolbyVisionAuthorizationRoute,
    format: RawDolbyVisionVideoFrameFormat
): DolbyVisionAuthorizationRouteKey {
    switch (route) {
        case 'profile4-base':
            return DOLBY_VISION_PROFILE4_AUTHORIZATION_ROUTE_KEY;
        case 'profile4-fel':
            return DOLBY_VISION_PROFILE4_FEL_AUTHORIZATION_ROUTE_KEY;
        case 'profile7-base':
            return DOLBY_VISION_PROFILE7_AUTHORIZATION_ROUTE_KEY;
        case 'profile7-fel':
            return DOLBY_VISION_PROFILE7_FEL_AUTHORIZATION_ROUTE_KEY;
        case 'single-layer':
            return `${format}:dovi-rpu-v1`;
    }
}

function createAuthorizationShader(
    route: DolbyVisionAuthorizationRoute,
    format: RawDolbyVisionVideoFrameFormat,
    settings: HDRToSDRRenderSettings
): string {
    if (route === 'single-layer') {
        return createRawDolbyVisionColorPipelineWGSL(settings, format);
    }
    if (format !== 'I420P10') {
        throw new RangeError('Dual-layer Dolby Vision authorization requires I420P10 planes');
    }
    switch (route) {
        case 'profile4-base':
            return createRawDolbyVisionProfile4ColorPipelineWGSL(settings, format);
        case 'profile4-fel':
            return createRawDolbyVisionProfile4FELColorPipelineWGSL(settings, format);
        case 'profile7-base':
            return createRawDolbyVisionProfile7ColorPipelineWGSL(settings, format);
        case 'profile7-fel':
            return createRawDolbyVisionProfile7FELColorPipelineWGSL(settings, format);
    }
}

/** Returns the raw HDR vector key whose luma ramp and chroma blocks cover one raw frame format. */
function getAuthorizationVectorKey(
    format: RawDolbyVisionVideoFrameFormat
): RawHDRAuthorizationRouteKey {
    // 8-bit formats have no PQ vector; the reconstruction ignores the vector's color tags either way
    return getRawFormatBitDepth(format) === 8 ?
        `${format as 'I420' | 'I422' | 'I444'}:bt709:bt709:limited:sdr` :
        `${format as Exclude<RawDolbyVisionVideoFrameFormat, 'I420' | 'I422' | 'I444'>}:bt2020-ncl:bt2020:limited:pq`;
}

function createDualLayerAuthorizationScenarios(
    profile: 4 | 7,
    reconstructsFEL: boolean,
    settings: HDRToSDRRenderSettings
): DolbyVisionAuthorizationScenario[] {
    const scenarios: DolbyVisionAuthorizationScenario[] = [];
    if (reconstructsFEL) {
        const packedRPUData = createDolbyVisionAuthorizationRPUVector(profile, 'fel');
        const { baseFrame, enhancementFrame } = createFELAuthorizationFrames();
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

    const frame = createRawHDRAuthorizationVector(
        'I420P10:bt2020-ncl:bt2020:limited:pq'
    );
    const melRPUData = createDolbyVisionAuthorizationRPUVector(profile, 'mel');
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
    const felRPUData = createDolbyVisionAuthorizationRPUVector(profile, 'fel');
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
    format: RawDolbyVisionVideoFrameFormat,
    settings: HDRToSDRRenderSettings
): DolbyVisionAuthorizationScenario[] {
    switch (route) {
        case 'profile4-base':
            return createDualLayerAuthorizationScenarios(4, false, settings);
        case 'profile4-fel':
            return createDualLayerAuthorizationScenarios(4, true, settings);
        case 'profile7-base':
            return createDualLayerAuthorizationScenarios(7, false, settings);
        case 'profile7-fel':
            return createDualLayerAuthorizationScenarios(7, true, settings);
        case 'single-layer': {
            const frame = createRawHDRAuthorizationVector(getAuthorizationVectorKey(format));
            const packedRPUData = createDolbyVisionAuthorizationRPUVector(
                8,
                'single-layer',
                frame.bitDepth
            );
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

function createRejectedDecision(
    device: GPUDevice,
    targetFormat: GPUTextureFormat,
    shaderSignature: string,
    routeKey: DolbyVisionAuthorizationRouteKey,
    failureReason: DolbyVisionAuthorizationFailureReason,
    sampleCount = 0,
    maximumChannelError: number | null = null
): DolbyVisionAuthorizationDecision {
    return {
        device,
        failureReason,
        vectorVersion: DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION,
        maximumChannelError,
        renderSettingsVersion: RENDER_SETTINGS_VERSION,
        routeKey,
        sampleCount,
        shaderSignature,
        status: 'rejected',
        targetFormat
    };
}

function discardErrorScope(device: GPUDevice): void {
    // popErrorScope can throw synchronously after device loss
    // eslint-disable-next-line sonarjs/no-try-promise
    try {
        void device.popErrorScope().catch((): void => undefined);
    } catch {
        // Device loss can synchronously invalidate the scope stack
    }
}

/** Runs the exact production raw upload, RPU binding, shader, and draw path. */
export class DolbyVisionPresentationAuthorizationRunner {
    public readonly routeKey: DolbyVisionAuthorizationRouteKey;

    public constructor(
        public readonly route: DolbyVisionAuthorizationRoute = 'single-layer',
        public readonly format: RawDolbyVisionVideoFrameFormat = 'I420P10'
    ) {
        if (isDualLayerAuthorizationRoute(route) && format !== 'I420P10') {
            throw new RangeError('Dual-layer Dolby Vision authorization requires I420P10 planes');
        }
        this.routeKey = getAuthorizationRouteKey(route, format);
    }

    /** Returns the exact production shader covered by this runner. */
    public createShader(settings: HDRToSDRRenderSettings): string {
        return createAuthorizationShader(this.route, this.format, settings);
    }

    public async validate(
        device: GPUDevice,
        targetFormat: GPUTextureFormat
    ): Promise<DolbyVisionAuthorizationDecision> {
        const settings = createSettings();
        const shaderCode = this.createShader(settings);
        const shaderSignature = createDolbyVisionShaderSignature(
            targetFormat,
            shaderCode
        );
        if (!AUTHORIZED_TARGET_FORMATS.has(targetFormat)) {
            return createRejectedDecision(
                device,
                targetFormat,
                shaderSignature,
                this.routeKey,
                'target-format-unsupported'
            );
        }
        const targetUsage = getValidationTextureUsage();
        if (
            targetUsage === null
            || typeof GPUBufferUsage === 'undefined'
            || typeof GPUTextureUsage === 'undefined'
        ) {
            return createRejectedDecision(
                device,
                targetFormat,
                shaderSignature,
                this.routeKey,
                'gpu-api-unavailable'
            );
        }

        let targetTexture: GPUTexture | null = null;
        let textureSet: RawPlaneTextureSet | null = null;
        let enhancementTextureSet: RawPlaneTextureSet | null = null;
        let enhancementUniformBuffer: GPUBuffer | null = null;
        let presentationUniformBuffer: GPUBuffer | null = null;
        let renderSettingsUniformBuffer: GPUBuffer | null = null;
        let RPUStorageBuffer: GPUBuffer | null = null;
        let pixelReader: GPUCanvasPixelReader | null = null;
        let errorScopePushed = false;
        const deadline = new GPUAuthorizationDeadline(device);
        try {
            const scenarios = createAuthorizationScenarios(this.route, this.format, settings);
            const pipeline = await deadline.wait(
                createRawYUVRenderPipeline(device, targetFormat, shaderCode)
            );
            const resources = createRawYUVRenderResources(device, pipeline, settings);
            presentationUniformBuffer = resources.presentationUniformBuffer;
            renderSettingsUniformBuffer = resources.renderSettingsUniformBuffer;
            RPUStorageBuffer = device.createBuffer({
                label: 'WebGPU Dolby Vision authorization RPU',
                size: DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
            });
            if (this.route === 'profile4-fel' || this.route === 'profile7-fel') {
                enhancementUniformBuffer = createRawYUVEnhancementUniformBuffer(device);
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
                usage: targetUsage
            });
            pixelReader = new GPUCanvasPixelReader({
                device,
                format: targetFormat,
                maximumReadbacks: RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES.length
                    * scenarios.length
            });
            let maximumChannelError = 0;
            let sampleCount = 0;
            for (const scenario of scenarios) {
                device.queue.writeBuffer(RPUStorageBuffer, 0, scenario.packedRPUData);
                device.pushErrorScope('validation');
                errorScopePushed = true;
                const renderResult = renderRawYUVFrame({
                    ...resources,
                    device,
                    dolbyVisionEnhancementUniformBuffer:
                        enhancementUniformBuffer ?? undefined,
                    dolbyVisionRPUStorageBuffer: RPUStorageBuffer,
                    enhancementFrame: scenario.enhancementFrame,
                    enhancementTextureSet,
                    frame: scenario.frame,
                    presentation: FULL_FRAME_PRESENTATION,
                    targetView: targetTexture.createView(),
                    textureSet
                });
                enhancementTextureSet = renderResult.enhancementTextureSet;
                textureSet = renderResult.textureSet;
                await deadline.wait(device.queue.onSubmittedWorkDone());
                const validationPromise = device.popErrorScope();
                errorScopePushed = false;
                const validationError = await deadline.wait(validationPromise);
                if (validationError) {
                    return createRejectedDecision(
                        device,
                        targetFormat,
                        shaderSignature,
                        this.routeKey,
                        'gpu-validation-failed'
                    );
                }

                const readback = await deadline.wait(
                    pixelReader.readPixels(RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES, targetTexture),
                    (): void => pixelReader?.destroy()
                );
                const actualObservations: RawHDRVectorObservation[] = [];
                if (readback.failure || !readback.linearRGB) {
                    return createRejectedDecision(
                        device,
                        targetFormat,
                        shaderSignature,
                        this.routeKey,
                        'readback-failed'
                    );
                }
                for (let sampleIndex = 0;
                    sampleIndex < RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES.length;
                    sampleIndex += 1) {
                    const sample = RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES[sampleIndex];
                    actualObservations.push({
                        linearRGB: readback.linearRGB[sampleIndex],
                        sampleX: sample.sampleX,
                        sampleY: sample.sampleY
                    });
                }
                const comparison = evaluateRawHDRVectorObservations(
                    scenario.expectedObservations,
                    actualObservations
                );
                sampleCount += actualObservations.length;
                maximumChannelError = Math.max(
                    maximumChannelError,
                    comparison.maximumChannelError
                );
                if (!comparison.accepted) {
                    return createRejectedDecision(
                        device,
                        targetFormat,
                        shaderSignature,
                        this.routeKey,
                        'pixel-mismatch',
                        sampleCount,
                        maximumChannelError
                    );
                }
            }
            return {
                device,
                failureReason: null,
                vectorVersion: DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION,
                maximumChannelError,
                renderSettingsVersion: RENDER_SETTINGS_VERSION,
                routeKey: this.routeKey,
                sampleCount,
                shaderSignature,
                status: 'authorized',
                targetFormat
            };
        } catch (error) {
            return createRejectedDecision(
                device,
                targetFormat,
                shaderSignature,
                this.routeKey,
                classifyFailure(error)
            );
        } finally {
            deadline.destroy();
            if (errorScopePushed) {
                discardErrorScope(device);
            }
            pixelReader?.destroy();
            destroyRawPlaneTextureSet(textureSet);
            destroyRawPlaneTextureSet(enhancementTextureSet);
            enhancementUniformBuffer?.destroy();
            presentationUniformBuffer?.destroy();
            renderSettingsUniformBuffer?.destroy();
            RPUStorageBuffer?.destroy();
            targetTexture?.destroy();
        }
    }
}

/** Device-scoped cache for the exact Dolby Vision shader authorization. */
export class DolbyVisionPresentationAuthorizationRegistry {
    private readonly devices = new WeakMap<GPUDevice, DeviceProbeCache>();
    private readonly runner: DolbyVisionPresentationAuthorizationRunner;

    public constructor(
        runnerOrRoute: DolbyVisionPresentationAuthorizationRunner | DolbyVisionAuthorizationRoute =
        'single-layer',
        format: RawDolbyVisionVideoFrameFormat = 'I420P10'
    ) {
        this.runner = typeof runnerOrRoute === 'string' ?
            new DolbyVisionPresentationAuthorizationRunner(runnerOrRoute, format) :
            runnerOrRoute;
    }

    /** Starts the exact-device probe without delaying ordinary playback. */
    public prewarm(device: GPUDevice, targetFormat: GPUTextureFormat): void {
        void this.authorize(device, targetFormat);
    }

    /** Waits only a probe that has already been started. */
    public async waitForPending(
        device: GPUDevice,
        targetFormat: GPUTextureFormat
    ): Promise<void> {
        const probe = this.getCachedProbe(device, targetFormat);
        if (probe && !probe.decision) {
            await probe.promise;
        }
    }

    /** Returns a deduplicated decision for one exact device, target, and shader. */
    public authorize(
        device: GPUDevice,
        targetFormat: GPUTextureFormat
    ): Promise<DolbyVisionAuthorizationDecision> {
        const cacheKey = this.createCacheKey(targetFormat);
        const deviceCache = this.getDeviceCache(device);
        const cachedProbe = deviceCache.probes.get(cacheKey);
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
            (): DolbyVisionAuthorizationDecision => {
                const shaderCode = this.runner.createShader(createSettings());
                const decision = createRejectedDecision(
                    device,
                    targetFormat,
                    createDolbyVisionShaderSignature(targetFormat, shaderCode),
                    this.runner.routeKey,
                    'unexpected-error'
                );
                probe.decision = decision;
                return decision;
            }
        );
        deviceCache.probes.set(cacheKey, probe);
        return probe.promise;
    }

    /** Checks only settled authorization and never waits optimistically. */
    public isAuthorized(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        settings: HDRToSDRRenderSettings,
        format: SupportedRawVideoFrameFormat
    ): boolean {
        if (format !== this.runner.format) {
            return false;
        }
        const shaderCode = this.runner.createShader(settings);
        const shaderSignature = createDolbyVisionShaderSignature(targetFormat, shaderCode);
        const decision = this.getCachedProbe(device, targetFormat)?.decision;
        return decision?.status === 'authorized'
            && decision.device === device
            && decision.targetFormat === targetFormat
            && decision.shaderSignature === shaderSignature;
    }

    /** Returns bounded diagnostics without exposing retained GPU objects. */
    public getTelemetry(
        device: GPUDevice | null,
        targetFormat: GPUTextureFormat | null
    ): DolbyVisionAuthorizationTelemetry {
        const unavailable: DolbyVisionAuthorizationTelemetry = {
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

    private createCacheKey(targetFormat: GPUTextureFormat): string {
        const shaderCode = this.runner.createShader(createSettings());
        return `${targetFormat}\u0000${createDolbyVisionShaderSignature(
            targetFormat,
            shaderCode
        )}`;
    }

    private getCachedProbe(
        device: GPUDevice,
        targetFormat: GPUTextureFormat
    ): CachedProbe | undefined {
        return this.devices.get(device)?.probes.get(this.createCacheKey(targetFormat));
    }

    private getDeviceCache(device: GPUDevice): DeviceProbeCache {
        const cached = this.devices.get(device);
        if (cached) {
            return cached;
        }
        const created: DeviceProbeCache = { probes: new Map<string, CachedProbe>() };
        this.devices.set(device, created);
        void device.lost.then((): void => {
            created.probes.clear();
        });
        return created;
    }
}
