import {
    createHDRToSDRRenderSettings,
    createRenderSettingsUniformData,
    RENDER_SETTINGS_VERSION,
    type HDRToSDRRenderSettings
} from '../presentation/RenderSettings';
import { createPQColorMetadata } from '../color/ColorMetadata';
import {
    processEncodedRGB,
    type ColorTriplet
} from '../color/ColorPipeline';
import { reconstructDolbyVisionBT2020PQ } from '../color/DolbyVisionColorTransform';
import { DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH } from '../demux/dolby-vision/DolbyVisionRPUParser';
import { waitForGPUCompletion } from '../GPUCompletion';
import type {
    RawVideoPlaneDescriptor,
    TransferableRawVideoFrame
} from '../decode/video/RawVideoFrameCopy';
import { createBuiltinChain } from '../presentation/passes/builtin/BuiltinChains';
import type {
    BuiltinChain,
    BuiltinChainConfiguration,
    PresentationFrameSource
} from '../presentation/passes/PassTypes';
import type { PresentationExecutor } from '../presentation/passes/PresentationExecutor';
import { INTERMEDIATE_TEXTURE_FORMAT, VALIDATION_ERROR_FILTER } from '../presentation/WebGPUConstants';
import { createDolbyVisionAuthorizationRPUVector } from '../capability/vectors/DolbyVisionAuthorizationVector';
import GPUAuthorizationDeadline from './GPUAuthorizationDeadline';
import {
    GPUCanvasPixelReader,
    type GPUCanvasPixelsReadbackResult
} from './GPUCanvasReadback';
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
    READBACK_CODE_SCALE,
    type AuthorizationReferencePlan,
    type AuthorizationStep,
    type RawHDRVectorObservation
} from './RawHDRPresentationAuthorization';

export const EXTERNAL_DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION = 2;
export const EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY = 'external-I420P10-bt709-limited:dovi-p5-rpu-v1';

const MAXIMUM_10_BIT_CODE = 1_023;
const EXTERNAL_AUTHORIZATION_TOLERANCE = 8 / READBACK_CODE_SCALE;
// A float target keeps the recovered 10-bit codes exact through the readback
const EXTERNAL_INPUT_PROBE_TARGET_FORMAT: GPUTextureFormat = INTERMEDIATE_TEXTURE_FORMAT;
const EXTERNAL_INPUT_SIGNAL_TOLERANCE = 8 / MAXIMUM_10_BIT_CODE;

/**
 * The input probe's signal step: the browser's BT.709 limited-range texture back to the vector's 10-bit codes, normalized.
 * It reads the external texture and sampler through their PassResources names.
 */
const EXTERNAL_INPUT_PROBE_SIGNAL_CODE = /* wgsl */ `
fn recoverExternalDolbyVisionBaseSignal(coordinate: vec2f) -> vec4f {
    let encodedBT709RGB = textureSampleBaseClampToEdge(videoTexture, videoSampler, coordinate).rgb;
    let normalizedLuma = dot(encodedBT709RGB, vec3f(0.2126, 0.7152, 0.0722));
    let normalizedChromaBlue = (encodedBT709RGB.b - normalizedLuma) / 1.8556;
    let normalizedChromaRed = (encodedBT709RGB.r - normalizedLuma) / 1.5748;
    let recoveredBaseSignal = vec3f(
        (normalizedLuma * 876.0) + 64.0,
        (normalizedChromaBlue * 896.0) + 512.0,
        (normalizedChromaRed * 896.0) + 512.0
    );
    return vec4f(recoveredBaseSignal / 1023.0, 1.0);
}`;

// Planned like a route's chain, so the probe renders through the same planner and executor as the output it checks
const EXTERNAL_INPUT_PROBE_CHAIN: BuiltinChain = {
    colorFunctions: [],
    linearLight: null,
    signal: {
        bypassCondition: null,
        code: EXTERNAL_INPUT_PROBE_SIGNAL_CODE,
        entryPoint: 'recoverExternalDolbyVisionBaseSignal',
        name: 'external-dolby-vision-input-probe',
        planes: null,
        resources: [ 'external-texture', 'sampler-linear' ],
        sourceKind: 'external'
    },
    sourceIsDisplay: true
};

type ExtendedVideoFrameBufferInit = Omit<VideoFrameBufferInit, 'format'> & {
    format: 'I420P10'
};

type CachedProbe = {
    decision: ExternalDolbyVisionAuthorizationDecision | null
    promise: Promise<ExternalDolbyVisionAuthorizationDecision>
};

type DeviceProbeCache = {
    probes: Map<GPUTextureFormat, CachedProbe>
    /** The reference chains' shader signature per target format, which planning makes stable per device */
    referenceSignatures: Map<GPUTextureFormat, string>
};

/** The two plans one probe renders: the input probe that measures the browser bridge, and the route's output. */
type ExternalDolbyVisionReferencePlans = {
    inputProbe: AuthorizationReferencePlan
    output: AuthorizationReferencePlan
};

/** The device, target, and reference shaders one probe renders, which every decision of the probe carries. */
type ProbeIdentity = {
    device: GPUDevice
    shaderSignature: string
    targetFormat: GPUTextureFormat
};

export type ExternalDolbyVisionAuthorizationFailureReason =
    | 'device-lost'
    | 'frame-import-failed'
    | 'gpu-api-unavailable'
    | 'gpu-validation-failed'
    | 'input-mismatch'
    | 'pixel-mismatch'
    | 'readback-failed'
    | 'target-format-unsupported'
    | 'timeout'
    | 'unexpected-error'
    | 'video-frame-creation-failed';

export type ExternalDolbyVisionAuthorizationDecision = {
    device: GPUDevice
    /** The failing value of a rejection, such as `9.4/1023 > 8/1023 at (3, 7)`; null when authorized */
    failureDetail: string | null
    failureReason: ExternalDolbyVisionAuthorizationFailureReason | null
    vectorVersion: typeof EXTERNAL_DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION
    maximumChannelError: number | null
    maximumInputChannelError: number | null
    renderSettingsVersion: typeof RENDER_SETTINGS_VERSION
    routeKey: typeof EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY
    sampleCount: number
    shaderSignature: string
    status: 'authorized' | 'rejected'
    targetFormat: GPUTextureFormat
};

export type ExternalDolbyVisionAuthorizationTelemetry = {
    failureDetail: string | null
    failureReason: ExternalDolbyVisionAuthorizationFailureReason | null
    vectorVersion: typeof EXTERNAL_DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION
    maximumChannelError: number | null
    maximumInputChannelError: number | null
    renderSettingsVersion: typeof RENDER_SETTINGS_VERSION
    routeKey: typeof EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY
    sampleCount: number
    status: 'authorized' | 'pending' | 'rejected' | 'unavailable'
    targetFormat: GPUTextureFormat | null
};

export type ExternalDolbyVisionAuthorizationFrameFactory = () => VideoFrame;

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function createSettings(): HDRToSDRRenderSettings {
    return createHDRToSDRRenderSettings({
        toneMapping: { inputPeakNits: 4_000 }
    });
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}

function getPlane(
    frame: TransferableRawVideoFrame,
    kind: RawVideoPlaneDescriptor['kind']
): RawVideoPlaneDescriptor {
    const plane = frame.planes.find(candidate => candidate.kind === kind);
    if (!plane) {
        throw new Error(`External authorization vector has no ${kind} plane`);
    }
    return plane;
}

function readPlaneCode(
    frame: TransferableRawVideoFrame,
    plane: RawVideoPlaneDescriptor,
    x: number,
    y: number
): number {
    return new DataView(frame.data).getUint16(
        plane.byteOffset
            + (y * plane.bytesPerRow)
            + (x * Uint16Array.BYTES_PER_ELEMENT),
        true
    );
}

function sampleExternalI420P10Vector(
    frame: TransferableRawVideoFrame,
    sampleX: number,
    sampleY: number
): ColorTriplet {
    const chromaX = Math.floor(sampleX / 2);
    const chromaY = Math.floor(sampleY / 2);
    return [
        readPlaneCode(frame, getPlane(frame, 'y'), sampleX, sampleY),
        readPlaneCode(frame, getPlane(frame, 'u'), chromaX, chromaY),
        readPlaneCode(frame, getPlane(frame, 'v'), chromaX, chromaY)
    ];
}

/** Returns the ideal normalized base signal at each bounded vector coordinate. */
export function createExpectedExternalDolbyVisionInputObservations(): readonly RawHDRVectorObservation[] {
    const frame = createRawHDRAuthorizationVector('I420P10:bt2020-ncl:bt2020:limited:pq');
    return RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES.map(sample => {
        const rawSignal = sampleExternalI420P10Vector(frame, sample.sampleX, sample.sampleY);
        const normalizedSignal: ColorTriplet = [
            rawSignal[0] / MAXIMUM_10_BIT_CODE,
            rawSignal[1] / MAXIMUM_10_BIT_CODE,
            rawSignal[2] / MAXIMUM_10_BIT_CODE
        ];
        return {
            linearRGB: normalizedSignal,
            sampleX: sample.sampleX,
            sampleY: sample.sampleY
        };
    });
}

/** Computes output references from the base signal recovered by the browser bridge. */
export function createExpectedExternalDolbyVisionAuthorizationObservationsFromInput(
    recoveredInput: readonly ColorTriplet[],
    packedRPUData: ArrayBuffer,
    settings: HDRToSDRRenderSettings
): readonly RawHDRVectorObservation[] {
    if (recoveredInput.length !== RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES.length) {
        throw new RangeError('Recovered external Dolby Vision input sample count is invalid');
    }
    const outputMetadata = createPQColorMetadata({ range: 'full' });
    return RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES.map((sample, sampleIndex) => {
        const encodedBT2020PQ = reconstructDolbyVisionBT2020PQ(recoveredInput[sampleIndex], packedRPUData);
        const referenceRGB = processEncodedRGB(encodedBT2020PQ, outputMetadata, settings);
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

/** Computes the ideal CPU reference before browser external-texture quantization. */
export function createExpectedExternalDolbyVisionAuthorizationObservations(
    packedRPUData: ArrayBuffer,
    settings: HDRToSDRRenderSettings
): readonly RawHDRVectorObservation[] {
    const idealInput = createExpectedExternalDolbyVisionInputObservations().map(
        (observation: RawHDRVectorObservation): ColorTriplet => observation.linearRGB
    );
    return createExpectedExternalDolbyVisionAuthorizationObservationsFromInput(
        idealInput,
        packedRPUData,
        settings
    );
}

/** Creates a stable identity for the exact external-texture route's reference chain and its input probe. */
export function createExternalDolbyVisionShaderSignature(
    targetFormat: GPUTextureFormat,
    shaderCode: string,
    inputProbeShaderCode: string
): string {
    const signatureInput = [
        `vector=${EXTERNAL_DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION}`,
        `uniform=${RENDER_SETTINGS_VERSION}`,
        `schema=${DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH}`,
        'frame=I420P10:bt709:bt709:bt709:limited',
        `input-format=${EXTERNAL_INPUT_PROBE_TARGET_FORMAT}`,
        `input-tolerance=${EXTERNAL_INPUT_SIGNAL_TOLERANCE}`,
        `tolerance=${EXTERNAL_AUTHORIZATION_TOLERANCE}`,
        `target=${targetFormat}`,
        shaderCode,
        inputProbeShaderCode
    ].join('\u0000');
    let hash = 0x811C_9DC5;
    for (let characterIndex = 0; characterIndex < signatureInput.length; characterIndex += 1) {
        hash ^= signatureInput.charCodeAt(characterIndex);
        hash = Math.imul(hash, 0x0100_0193) >>> 0;
    }
    return `fnv1a32-${hash.toString(16).padStart(8, '0')}`;
}

/** Builds the exact software-backed 10-bit BT.709 frame imported by the probe. */
export function createExternalDolbyVisionAuthorizationFrame(): VideoFrame {
    if (typeof VideoFrame === 'undefined') {
        throw new Error('video-frame-api-unavailable');
    }
    const sourceFrame = createRawHDRAuthorizationVector('I420P10:bt2020-ncl:bt2020:limited:pq');
    const frameInit: ExtendedVideoFrameBufferInit = {
        codedHeight: sourceFrame.codedHeight,
        codedWidth: sourceFrame.codedWidth,
        colorSpace: {
            fullRange: false,
            matrix: 'bt709',
            primaries: 'bt709',
            transfer: 'bt709'
        },
        displayHeight: sourceFrame.displayHeight,
        displayWidth: sourceFrame.displayWidth,
        format: 'I420P10',
        layout: sourceFrame.planes.map(plane => ({
            offset: plane.byteOffset,
            stride: plane.bytesPerRow
        })),
        timestamp: 0,
        visibleRect: { ...sourceFrame.visibleRectangle }
    };
    // eslint-disable-next-line compat/compat -- Authorization is capability-gated
    return new VideoFrame(sourceFrame.data, frameInit as unknown as VideoFrameBufferInit);
}

function classifyFailure(
    error: unknown,
    step: AuthorizationStep
): ExternalDolbyVisionAuthorizationFailureReason {
    switch (getErrorMessage(error)) {
        case 'device-lost':
            return 'device-lost';
        case 'timeout':
            return 'timeout';
        case 'video-frame-api-unavailable':
            return 'gpu-api-unavailable';
        default:
            break;
    }
    switch (step) {
        case 'frame':
            return 'video-frame-creation-failed';
        case 'import':
            return 'frame-import-failed';
        case 'executor':
        case 'readback':
        case 'render':
            return 'unexpected-error';
    }
}

function createRejectedDecision(
    probe: ProbeIdentity,
    failureReason: ExternalDolbyVisionAuthorizationFailureReason,
    failureDetail: string,
    sampleCount = 0,
    maximumChannelError: number | null = null,
    maximumInputChannelError: number | null = null
): ExternalDolbyVisionAuthorizationDecision {
    return {
        device: probe.device,
        failureDetail,
        failureReason,
        vectorVersion: EXTERNAL_DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION,
        maximumChannelError,
        maximumInputChannelError,
        renderSettingsVersion: RENDER_SETTINGS_VERSION,
        routeKey: EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
        sampleCount,
        shaderSignature: probe.shaderSignature,
        status: 'rejected',
        targetFormat: probe.targetFormat
    };
}

function createExternalDolbyVisionReferencePlans(
    device: GPUDevice,
    targetFormat: GPUTextureFormat
): ExternalDolbyVisionReferencePlans {
    const configuration: BuiltinChainConfiguration = {
        hdrOutput: false,
        route: 'external-dolby-vision',
        settings: createSettings()
    };
    return {
        inputProbe: createAuthorizationReferencePlan(device, (): BuiltinChain => EXTERNAL_INPUT_PROBE_CHAIN, {
            format: EXTERNAL_INPUT_PROBE_TARGET_FORMAT,
            hdrSource: false,
            height: RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
            width: RAW_HDR_AUTHORIZATION_VECTOR_WIDTH
        }),
        output: createAuthorizationReferencePlan(device, (): BuiltinChain => createBuiltinChain(configuration), {
            format: targetFormat,
            hdrSource: true,
            height: RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
            width: RAW_HDR_AUTHORIZATION_VECTOR_WIDTH
        })
    };
}

function createReferenceShaderSignature(targetFormat: GPUTextureFormat, plans: ExternalDolbyVisionReferencePlans): string {
    return createExternalDolbyVisionShaderSignature(targetFormat, plans.output.shaderCode, plans.inputProbe.shaderCode);
}

/** Runs the exact external texture through the Profile 5 default chain and the input probe, then reads both back. */
export class ExternalDolbyVisionPresentationAuthorizationRunner {
    private readonly createFrame: ExternalDolbyVisionAuthorizationFrameFactory;

    public constructor(
        createFrame: ExternalDolbyVisionAuthorizationFrameFactory =
        createExternalDolbyVisionAuthorizationFrame
    ) {
        this.createFrame = createFrame;
    }

    public async validate(
        device: GPUDevice,
        targetFormat: GPUTextureFormat
    ): Promise<ExternalDolbyVisionAuthorizationDecision> {
        const settings = createSettings();
        const plans = createExternalDolbyVisionReferencePlans(device, targetFormat);
        const probe: ProbeIdentity = {
            device,
            shaderSignature: createReferenceShaderSignature(targetFormat, plans),
            targetFormat
        };
        if (!isAuthorizationTargetFormat(targetFormat)) {
            return createRejectedDecision(probe, 'target-format-unsupported', targetFormat);
        }
        const targetUsage = getAuthorizationTargetUsage();
        if (targetUsage.usage === null) {
            return createRejectedDecision(probe, 'gpu-api-unavailable', targetUsage.failure);
        }
        const outputPlan = plans.output.plan;
        const inputProbePlan = plans.inputProbe.plan;
        if (!outputPlan || !inputProbePlan) {
            return createRejectedDecision(
                probe,
                'unexpected-error',
                plans.output.failure ?? plans.inputProbe.failure ?? EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY
            );
        }

        let targetTexture: GPUTexture | null = null;
        let inputProbeTexture: GPUTexture | null = null;
        let executor: PresentationExecutor | null = null;
        let inputProbeExecutor: PresentationExecutor | null = null;
        let pixelReader: GPUCanvasPixelReader | null = null;
        let inputPixelReader: GPUCanvasPixelReader | null = null;
        let frame: VideoFrame | null = null;
        let errorScopePushed = false;
        let step: AuthorizationStep = 'executor';
        const deadline = new GPUAuthorizationDeadline(device);
        try {
            executor = await createAuthorizationExecutor(device, outputPlan, deadline);
            inputProbeExecutor = await createAuthorizationExecutor(device, inputProbePlan, deadline);
            if (outputPlan.usesRenderSettings) {
                executor.writeRenderSettings(createRenderSettingsUniformData(settings).buffer);
            }
            const packedRPUData = createDolbyVisionAuthorizationRPUVector(5);
            executor.writeDolbyVisionRPU(packedRPUData);

            step = 'frame';
            frame = this.createFrame();
            targetTexture = device.createTexture({
                dimension: '2d',
                format: targetFormat,
                label: 'WebGPU external Dolby Vision authorization target',
                size: {
                    depthOrArrayLayers: 1,
                    height: frame.displayHeight,
                    width: frame.displayWidth
                },
                usage: targetUsage.usage
            });
            inputProbeTexture = device.createTexture({
                dimension: '2d',
                format: EXTERNAL_INPUT_PROBE_TARGET_FORMAT,
                label: 'WebGPU external Dolby Vision authorization input probe',
                size: {
                    depthOrArrayLayers: 1,
                    height: frame.displayHeight,
                    width: frame.displayWidth
                },
                usage: targetUsage.usage
            });

            device.pushErrorScope(VALIDATION_ERROR_FILTER);
            errorScopePushed = true;
            // Each executor imports the frame while it encodes, so an encode failure is an import failure
            step = 'import';
            const source: PresentationFrameSource = { kind: 'external', source: frame };
            const inputProbeCommandBuffer = encodeAuthorizationFrame(
                device,
                inputProbeExecutor,
                source,
                inputProbeTexture,
                'WebGPU external Dolby Vision authorization input probe commands'
            );
            const commandBuffer = encodeAuthorizationFrame(
                device,
                executor,
                source,
                targetTexture,
                'WebGPU external Dolby Vision authorization commands'
            );
            step = 'render';
            device.queue.submit([ inputProbeCommandBuffer, commandBuffer ]);
            await deadline.wait(waitForGPUCompletion(device, device.queue.onSubmittedWorkDone()));
            const validationPromise = device.popErrorScope();
            errorScopePushed = false;
            const validationError = await deadline.wait(validationPromise);
            if (validationError) {
                return createRejectedDecision(probe, 'gpu-validation-failed', validationError.message);
            }

            step = 'readback';
            inputPixelReader = new GPUCanvasPixelReader({
                device,
                format: EXTERNAL_INPUT_PROBE_TARGET_FORMAT,
                maximumReadbacks: RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES.length
            });
            const inputReadback: GPUCanvasPixelsReadbackResult = await deadline.wait(
                inputPixelReader.readPixels(RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES, inputProbeTexture),
                (): void => inputPixelReader?.destroy()
            );
            if (inputReadback.failure || !inputReadback.linearRGB) {
                return createRejectedDecision(probe, 'readback-failed', `input probe ${describeReadbackFailure(inputReadback.failure)}`);
            }
            const recoveredInputObservations: RawHDRVectorObservation[] = [];
            for (let sampleIndex = 0;
                sampleIndex < RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES.length;
                sampleIndex += 1) {
                const sample = RAW_HDR_AUTHORIZATION_VECTOR_SAMPLES[sampleIndex];
                recoveredInputObservations.push({
                    linearRGB: inputReadback.linearRGB[sampleIndex],
                    sampleX: sample.sampleX,
                    sampleY: sample.sampleY
                });
            }
            const expectedInputObservations = createExpectedExternalDolbyVisionInputObservations();
            // The recovered input is compared in 10-bit code steps
            const inputComparison = evaluateRawHDRVectorObservations(
                expectedInputObservations,
                recoveredInputObservations,
                EXTERNAL_INPUT_SIGNAL_TOLERANCE,
                MAXIMUM_10_BIT_CODE
            );
            if (inputComparison.failureDetail !== null) {
                return createRejectedDecision(
                    probe,
                    'input-mismatch',
                    inputComparison.failureDetail,
                    recoveredInputObservations.length,
                    null,
                    inputComparison.maximumChannelError
                );
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
            if (readback.failure || !readback.linearRGB) {
                return createRejectedDecision(probe, 'readback-failed', describeReadbackFailure(readback.failure));
            }
            const actualObservations: RawHDRVectorObservation[] = [];
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
            const expectedObservations =
                createExpectedExternalDolbyVisionAuthorizationObservationsFromInput(
                    inputReadback.linearRGB,
                    packedRPUData,
                    settings
                );
            const comparison = evaluateRawHDRVectorObservations(
                expectedObservations,
                actualObservations,
                EXTERNAL_AUTHORIZATION_TOLERANCE
            );
            if (comparison.failureDetail !== null) {
                return createRejectedDecision(
                    probe,
                    'pixel-mismatch',
                    comparison.failureDetail,
                    actualObservations.length,
                    comparison.maximumChannelError,
                    inputComparison.maximumChannelError
                );
            }
            return {
                device,
                failureDetail: null,
                failureReason: null,
                vectorVersion: EXTERNAL_DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION,
                maximumChannelError: comparison.maximumChannelError,
                maximumInputChannelError: inputComparison.maximumChannelError,
                renderSettingsVersion: RENDER_SETTINGS_VERSION,
                routeKey: EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
                sampleCount: actualObservations.length,
                shaderSignature: probe.shaderSignature,
                status: 'authorized',
                targetFormat
            };
        } catch (error) {
            return createRejectedDecision(probe, classifyFailure(error, step), describeAuthorizationError(step, error));
        } finally {
            deadline.destroy();
            if (errorScopePushed) {
                discardErrorScope(device);
            }
            frame?.close();
            inputPixelReader?.destroy();
            pixelReader?.destroy();
            inputProbeExecutor?.destroy();
            executor?.destroy();
            inputProbeTexture?.destroy();
            targetTexture?.destroy();
        }
    }
}

/** Device-scoped cache for exact external Profile 5 presentation evidence. */
export class ExternalDolbyVisionPresentationAuthorizationRegistry {
    private readonly devices = new WeakMap<GPUDevice, DeviceProbeCache>();
    private readonly runner: ExternalDolbyVisionPresentationAuthorizationRunner;

    public constructor(runner = new ExternalDolbyVisionPresentationAuthorizationRunner()) {
        this.runner = runner;
    }

    /** Starts the exact-device probe without delaying ordinary playback. */
    public prewarm(device: GPUDevice, targetFormat: GPUTextureFormat): void {
        void this.authorize(device, targetFormat);
    }

    /** Waits only a probe that has already been started. */
    public async waitForPending(device: GPUDevice, targetFormat: GPUTextureFormat): Promise<void> {
        const probe = this.getCachedProbe(device, targetFormat);
        if (probe && !probe.decision) {
            await probe.promise;
        }
    }

    /** Returns a deduplicated decision for one exact device and target. */
    public authorize(
        device: GPUDevice,
        targetFormat: GPUTextureFormat
    ): Promise<ExternalDolbyVisionAuthorizationDecision> {
        const deviceCache = this.getDeviceCache(device);
        const cachedProbe = deviceCache.probes.get(targetFormat);
        if (cachedProbe) {
            return cachedProbe.promise;
        }

        const probe = { decision: null } as CachedProbe;
        probe.promise = Promise.resolve().then(() => (
            this.runner.validate(device, targetFormat)
        )).then(
            (decision: ExternalDolbyVisionAuthorizationDecision): ExternalDolbyVisionAuthorizationDecision => {
                probe.decision = decision;
                return decision;
            },
            (error: unknown): ExternalDolbyVisionAuthorizationDecision => {
                const decision = createRejectedDecision(
                    { device, shaderSignature: this.getReferenceSignature(device, targetFormat), targetFormat },
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

    /** Checks only settled authorization of the current reference shaders and never waits optimistically. */
    public isAuthorized(device: GPUDevice, targetFormat: GPUTextureFormat): boolean {
        return this.getAuthorizationFailure(device, targetFormat) === null;
    }

    /** Returns why this device and target format are not authorized, as `<state>: <route key>` with the failing value, or null when they are. */
    public getAuthorizationFailure(device: GPUDevice, targetFormat: GPUTextureFormat): string | null {
        const probe = this.getCachedProbe(device, targetFormat);
        const decision = probe?.decision ?? null;
        if (decision?.status === 'authorized' && (decision.device !== device || decision.targetFormat !== targetFormat)) {
            return `decision-mismatch: ${EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY}`;
        }
        return describeAuthorizationDecision(
            EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
            probe !== undefined,
            decision,
            (): string => this.getReferenceSignature(device, targetFormat)
        );
    }

    /** Returns bounded diagnostics without exposing retained GPU objects. */
    public getTelemetry(
        device: GPUDevice | null,
        targetFormat: GPUTextureFormat | null
    ): ExternalDolbyVisionAuthorizationTelemetry {
        const unavailable: ExternalDolbyVisionAuthorizationTelemetry = {
            failureDetail: null,
            failureReason: null,
            vectorVersion: EXTERNAL_DOLBY_VISION_AUTHORIZATION_VECTOR_VERSION,
            maximumChannelError: null,
            maximumInputChannelError: null,
            renderSettingsVersion: RENDER_SETTINGS_VERSION,
            routeKey: EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
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
            maximumInputChannelError: probe.decision.maximumInputChannelError,
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
        const signature = createReferenceShaderSignature(
            targetFormat,
            createExternalDolbyVisionReferencePlans(device, targetFormat)
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
        const created: DeviceProbeCache = { probes: new Map(), referenceSignatures: new Map() };
        this.devices.set(device, created);
        return created;
    }
}
