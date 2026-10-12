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
import { rewriteHEVCAccessUnitColorDescriptionToBT709 } from '../video/dolby-vision/DolbyVisionHEVCSplitter';
import { createBuiltinChain } from '../presentation/passes/builtin/BuiltinChains';
import type { BuiltinChain, BuiltinChainConfiguration } from '../presentation/passes/PassTypes';
import type { PresentationExecutor } from '../presentation/passes/PresentationExecutor';
import {
    createExternalHDRAuthorizationAccessUnit,
    EXTERNAL_HDR_AUTHORIZATION_CODED_HEIGHT,
    EXTERNAL_HDR_AUTHORIZATION_CODED_WIDTH,
    EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT,
    EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH,
    EXTERNAL_HDR_AUTHORIZATION_VECTOR_SAMPLES,
    EXTERNAL_HDR_AUTHORIZATION_VECTOR_SHA256,
    EXTERNAL_HDR_AUTHORIZATION_VECTOR_VERSION
} from '../capability/vectors/ExternalHDRAuthorizationVector';
import GPUAuthorizationDeadline from './GPUAuthorizationDeadline';
import { GPUCanvasPixelReader } from './GPUCanvasReadback';
import { discardErrorScope } from './GPUErrorScope';
import {
    calculateRawHDRAuthorizationOutputDither,
    createAuthorizationExecutor,
    createAuthorizationReferencePlan,
    describeAuthorizationDecision,
    describeAuthorizationError,
    describeReadbackFailure,
    encodeAuthorizationFrame,
    evaluateRawHDRVectorObservations,
    getAuthorizationTargetUsage,
    isAuthorizationTargetFormat,
    READBACK_CODE_SCALE,
    type AuthorizationReferencePlan,
    type AuthorizationStep,
    type RawHDRVectorObservation
} from './RawHDRPresentationAuthorization';

const EXTERNAL_HDR_CODEC = 'hvc1.2.4.L120.B0';
const EXTERNAL_HDR_AUTHORIZATION_TOLERANCE = 10 / READBACK_CODE_SCALE;
const MAXIMUM_10_BIT_CODE = 1_023;
const PROBE_KEY_SEPARATOR = '\u0000';

export type ExternalHDRAuthorizationRouteKey =
    | 'external-hevc-main10-bt709-limited:hlg-v1'
    | 'external-hevc-main10-bt709-limited:pq-v1';

export const EXTERNAL_HDR_AUTHORIZATION_ROUTE_KEYS:
readonly ExternalHDRAuthorizationRouteKey[] = [
    'external-hevc-main10-bt709-limited:pq-v1',
    'external-hevc-main10-bt709-limited:hlg-v1'
];

export type ExternalHDRAuthorizationFailureReason =
    | 'decode-failed'
    | 'decoder-api-unavailable'
    | 'decoder-config-unsupported'
    | 'decoder-output-mismatch'
    | 'device-lost'
    | 'frame-import-failed'
    | 'gpu-api-unavailable'
    | 'gpu-validation-failed'
    | 'pixel-mismatch'
    | 'readback-failed'
    | 'route-unsupported'
    | 'target-format-unsupported'
    | 'timeout'
    | 'unexpected-error';

export type ExternalHDRRouteAuthorizationDecision = {
    authorizedRouteKeys: readonly ExternalHDRAuthorizationRouteKey[]
    device: GPUDevice
    /** The failing value of a rejection, such as `14/255 > 10/255 at (3, 7)`; null when authorized */
    failureDetail: string | null
    failureReason: ExternalHDRAuthorizationFailureReason | null
    vectorVersion: typeof EXTERNAL_HDR_AUTHORIZATION_VECTOR_VERSION
    maximumChannelError: number | null
    renderSettingsVersion: typeof RENDER_SETTINGS_VERSION
    routeKey: ExternalHDRAuthorizationRouteKey
    sampleCount: number
    shaderSignature: string
    status: 'authorized' | 'rejected'
    targetFormat: GPUTextureFormat
};

export type ExternalHDRAuthorizationTelemetry = {
    authorizedRouteKeys: readonly ExternalHDRAuthorizationRouteKey[]
    failureDetails: Readonly<Partial<Record<ExternalHDRAuthorizationRouteKey, string>>>
    failureReasons: Readonly<Partial<Record<
        ExternalHDRAuthorizationRouteKey,
        ExternalHDRAuthorizationFailureReason
    >>>
    vectorVersion: typeof EXTERNAL_HDR_AUTHORIZATION_VECTOR_VERSION
    maximumChannelErrors: Readonly<Partial<Record<
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

export type ExternalHDRAuthorizationFrameFactory = (signal: AbortSignal) => Promise<VideoFrame>;

type CachedRouteProbe = {
    decision: ExternalHDRRouteAuthorizationDecision | null
    promise: Promise<ExternalHDRRouteAuthorizationDecision>
};

type DeviceProbeCache = {
    /** The reference chain's shader signature per target format and route, which planning makes stable per device */
    referenceSignatures: Map<string, string>
    routes: Map<string, CachedRouteProbe>
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
    failureDetails: Partial<Record<ExternalHDRAuthorizationRouteKey, string>>
    failureReasons: Partial<Record<
        ExternalHDRAuthorizationRouteKey,
        ExternalHDRAuthorizationFailureReason
    >>
    maximumChannelErrors: Partial<Record<ExternalHDRAuthorizationRouteKey, number>>
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

function createMetadata(routeKey: ExternalHDRAuthorizationRouteKey): InputColorMetadata {
    switch (routeKey) {
        case 'external-hevc-main10-bt709-limited:hlg-v1':
            return createHLGColorMetadata();
        case 'external-hevc-main10-bt709-limited:pq-v1':
            return createPQColorMetadata();
    }
}

function createSettings(metadata: InputColorMetadata): HDRToSDRRenderSettings {
    return createHDRToSDRRenderSettings({
        toneMapping: { inputPeakNits: metadata.nominalPeakNits }
    });
}

/** Returns the exact Main10 HDR metadata routes covered by the native-frame probe. */
export function getExternalHDRAuthorizationRouteKey(metadata: InputColorMetadata): ExternalHDRAuthorizationRouteKey | null {
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
            return 'external-hevc-main10-bt709-limited:hlg-v1';
        case 'pq':
            return 'external-hevc-main10-bt709-limited:pq-v1';
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
    const configuration: BuiltinChainConfiguration = {
        hdrOutput: false,
        metadata,
        route: 'external-hdr',
        settings: createSettings(metadata)
    };
    return createAuthorizationReferencePlan(device, (): BuiltinChain => createBuiltinChain(configuration), {
        format: targetFormat,
        hdrSource: true,
        height: EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT,
        width: EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH
    });
}

function createProbeKey(targetFormat: GPUTextureFormat, routeKey: ExternalHDRAuthorizationRouteKey): string {
    return `${targetFormat}${PROBE_KEY_SEPARATOR}${routeKey}`;
}

/** Creates a stable identity for the exact native frame and the route's reference chain. */
export function createExternalHDRShaderSignature(
    targetFormat: GPUTextureFormat,
    routeKey: ExternalHDRAuthorizationRouteKey,
    shaderCode: string
): string {
    const signatureInput = [
        `vector=${EXTERNAL_HDR_AUTHORIZATION_VECTOR_VERSION}`,
        `vector-sha256=${EXTERNAL_HDR_AUTHORIZATION_VECTOR_SHA256}`,
        `uniform=${RENDER_SETTINGS_VERSION}`,
        `route=${routeKey}`,
        `codec=${EXTERNAL_HDR_CODEC}`,
        'frame=opaque:bt709:bt709:bt709:limited',
        `tolerance=${EXTERNAL_HDR_AUTHORIZATION_TOLERANCE}`,
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

function frameMatchesAuthorizationContract(frame: VideoFrame): boolean {
    const visibleRectangle = frame.visibleRect;
    return frame.format === null
        && frame.codedWidth === EXTERNAL_HDR_AUTHORIZATION_CODED_WIDTH
        && frame.codedHeight === EXTERNAL_HDR_AUTHORIZATION_CODED_HEIGHT
        && frame.displayWidth === EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH
        && frame.displayHeight === EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT
        && frame.timestamp === 0
        && visibleRectangle !== null
        && visibleRectangle.x === 0
        && visibleRectangle.y === 0
        && visibleRectangle.width === EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH
        && visibleRectangle.height === EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT
        && frame.colorSpace.fullRange === false
        && frame.colorSpace.matrix === 'bt709'
        && frame.colorSpace.primaries === 'bt709'
        && frame.colorSpace.transfer === 'bt709';
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

/** Decodes one neutralized Main10 vector and requires Chromium's opaque hardware output. */
export async function createExternalHDRAuthorizationFrame(signal?: AbortSignal): Promise<VideoFrame> {
    if (
        typeof VideoDecoder === 'undefined'
        || typeof EncodedVideoChunk === 'undefined'
        || typeof VideoDecoder.isConfigSupported !== 'function'
    ) {
        throw new Error('decoder-api-unavailable');
    }
    if (signal?.aborted) {
        throw new DOMException('External HDR authorization decode was aborted', 'AbortError');
    }

    const sourceAccessUnit = createExternalHDRAuthorizationAccessUnit();
    const neutralizedAccessUnit = rewriteHEVCAccessUnitColorDescriptionToBT709(
        sourceAccessUnit,
        { kind: 'annex-b' }
    );
    if (!neutralizedAccessUnit) {
        throw new Error('decoder-output-mismatch');
    }
    const configuration: VideoDecoderConfig = {
        codec: EXTERNAL_HDR_CODEC,
        codedHeight: EXTERNAL_HDR_AUTHORIZATION_CODED_HEIGHT,
        codedWidth: EXTERNAL_HDR_AUTHORIZATION_CODED_WIDTH,
        colorSpace: {
            fullRange: false,
            matrix: 'bt709',
            primaries: 'bt709',
            transfer: 'bt709'
        },
        hardwareAcceleration: 'prefer-hardware',
        optimizeForLatency: true
    };
    // eslint-disable-next-line compat/compat -- Authorization is capability-gated
    const support = await VideoDecoder.isConfigSupported(configuration);
    if (!support.supported) {
        throw new Error('decoder-config-unsupported');
    }

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
        if (!frameMatchesAuthorizationContract(decodedFrame)) {
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

/** Computes CPU-reference samples from the vector's exact decoded YUV codes. */
export function createExpectedExternalHDRAuthorizationObservations(
    routeKey: ExternalHDRAuthorizationRouteKey,
    settings: HDRToSDRRenderSettings
): readonly RawHDRVectorObservation[] {
    const metadata = createMetadata(routeKey);
    return EXTERNAL_HDR_AUTHORIZATION_VECTOR_SAMPLES.map(sample => {
        const encodedYUV: ColorTriplet = [
            sample.rawYUVCode[0] / MAXIMUM_10_BIT_CODE,
            sample.rawYUVCode[1] / MAXIMUM_10_BIT_CODE,
            sample.rawYUVCode[2] / MAXIMUM_10_BIT_CODE
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
        case 'decoder-config-unsupported':
            return 'decoder-config-unsupported';
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
    maximumChannelError: number | null = null
): ExternalHDRRouteAuthorizationDecision {
    return {
        authorizedRouteKeys: [],
        device: probe.device,
        failureDetail,
        failureReason,
        vectorVersion: EXTERNAL_HDR_AUTHORIZATION_VECTOR_VERSION,
        maximumChannelError,
        renderSettingsVersion: RENDER_SETTINGS_VERSION,
        routeKey: probe.routeKey,
        sampleCount,
        shaderSignature: probe.shaderSignature,
        status: 'rejected',
        targetFormat: probe.targetFormat
    };
}

/** Runs native decode, external import, the route's built-in default chain, and readback. */
export class ExternalHDRPresentationAuthorizationRunner {
    public constructor(
        private readonly createFrame: ExternalHDRAuthorizationFrameFactory =
        createExternalHDRAuthorizationFrame
    ) {}

    public async validate(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        routeKey: ExternalHDRAuthorizationRouteKey
    ): Promise<ExternalHDRRouteAuthorizationDecision> {
        const metadata = createMetadata(routeKey);
        const settings = createSettings(metadata);
        const reference = createExternalHDRReferencePlan(device, targetFormat, routeKey);
        const probe: RouteProbeIdentity = {
            device,
            routeKey,
            shaderSignature: createExternalHDRShaderSignature(targetFormat, routeKey, reference.shaderCode),
            targetFormat
        };
        if (!EXTERNAL_HDR_AUTHORIZATION_ROUTE_KEYS.includes(routeKey)) {
            return createRejectedDecision(probe, 'route-unsupported', routeKey);
        }
        if (!isAuthorizationTargetFormat(targetFormat)) {
            return createRejectedDecision(probe, 'target-format-unsupported', targetFormat);
        }
        const targetUsage = getAuthorizationTargetUsage();
        if (targetUsage.usage === null) {
            return createRejectedDecision(probe, 'gpu-api-unavailable', targetUsage.failure);
        }
        const plan = reference.plan;
        if (!plan) {
            return createRejectedDecision(probe, 'unexpected-error', reference.failure ?? routeKey);
        }

        let targetTexture: GPUTexture | null = null;
        let executor: PresentationExecutor | null = null;
        let pixelReader: GPUCanvasPixelReader | null = null;
        let frame: VideoFrame | null = null;
        let frameAbortController: AbortController | null = null;
        let errorScopePushed = false;
        let step: AuthorizationStep = 'executor';
        const deadline = new GPUAuthorizationDeadline(device);
        try {
            executor = await createAuthorizationExecutor(device, plan, deadline);
            if (plan.usesRenderSettings) {
                executor.writeRenderSettings(createRenderSettingsUniformData(settings).buffer);
            }

            step = 'frame';
            // eslint-disable-next-line compat/compat -- WebGPU custom decode targets modern Chromium
            frameAbortController = new AbortController();
            const activeFrameAbortController = frameAbortController;
            const framePromise = this.createFrame(activeFrameAbortController.signal);
            void framePromise.then((resolvedFrame: VideoFrame): void => {
                if (activeFrameAbortController.signal.aborted) {
                    resolvedFrame.close();
                }
            }, (): void => undefined);
            frame = await deadline.wait(framePromise, (): void => activeFrameAbortController.abort());
            frameAbortController = null;
            targetTexture = device.createTexture({
                dimension: '2d',
                format: targetFormat,
                label: 'WebGPU external HDR authorization target',
                size: {
                    depthOrArrayLayers: 1,
                    height: frame.displayHeight,
                    width: frame.displayWidth
                },
                usage: targetUsage.usage
            });

            device.pushErrorScope('validation');
            errorScopePushed = true;
            // The executor imports the frame while it encodes, so an encode failure is an import failure
            step = 'import';
            const commandBuffer = encodeAuthorizationFrame(
                device,
                executor,
                { kind: 'external', source: frame },
                targetTexture,
                'WebGPU external HDR authorization commands'
            );
            step = 'render';
            device.queue.submit([ commandBuffer ]);
            await deadline.wait(device.queue.onSubmittedWorkDone());
            const validationError = await deadline.wait(device.popErrorScope());
            errorScopePushed = false;
            if (validationError) {
                return createRejectedDecision(probe, 'gpu-validation-failed', validationError.message);
            }

            step = 'readback';
            pixelReader = new GPUCanvasPixelReader({
                device,
                format: targetFormat,
                maximumReadbacks: EXTERNAL_HDR_AUTHORIZATION_VECTOR_SAMPLES.length
            });
            const readback = await deadline.wait(
                pixelReader.readPixels(EXTERNAL_HDR_AUTHORIZATION_VECTOR_SAMPLES, targetTexture),
                (): void => pixelReader?.destroy()
            );
            if (readback.failure || !readback.linearRGB) {
                return createRejectedDecision(probe, 'readback-failed', describeReadbackFailure(readback.failure));
            }
            const actualObservations: RawHDRVectorObservation[] = [];
            for (let sampleIndex = 0;
                sampleIndex < EXTERNAL_HDR_AUTHORIZATION_VECTOR_SAMPLES.length;
                sampleIndex += 1) {
                const sample = EXTERNAL_HDR_AUTHORIZATION_VECTOR_SAMPLES[sampleIndex];
                actualObservations.push({
                    linearRGB: readback.linearRGB[sampleIndex],
                    sampleX: sample.sampleX,
                    sampleY: sample.sampleY
                });
            }
            const expectedObservations = createExpectedExternalHDRAuthorizationObservations(routeKey, settings);
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
                    comparison.maximumChannelError
                );
            }
            return {
                authorizedRouteKeys: [ routeKey ],
                device,
                failureDetail: null,
                failureReason: null,
                vectorVersion: EXTERNAL_HDR_AUTHORIZATION_VECTOR_VERSION,
                maximumChannelError: comparison.maximumChannelError,
                renderSettingsVersion: RENDER_SETTINGS_VERSION,
                routeKey,
                sampleCount: actualObservations.length,
                shaderSignature: probe.shaderSignature,
                status: 'authorized',
                targetFormat
            };
        } catch (error) {
            return createRejectedDecision(probe, classifyFailure(error, step), describeAuthorizationError(step, error));
        } finally {
            deadline.destroy();
            frameAbortController?.abort();
            if (errorScopePushed) {
                discardErrorScope(device);
            }
            frame?.close();
            pixelReader?.destroy();
            executor?.destroy();
            targetTexture?.destroy();
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
    accumulator.sampleCounts[routeKey] = decision.sampleCount;
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

    /** Starts both exact shader probes without delaying ordinary playback. */
    public prewarm(device: GPUDevice, targetFormat: GPUTextureFormat): void {
        for (const routeKey of EXTERNAL_HDR_AUTHORIZATION_ROUTE_KEYS) {
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

    /** Returns one deduplicated exact-device, target, decoder, and shader decision. */
    public authorize(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        routeKey: ExternalHDRAuthorizationRouteKey
    ): Promise<ExternalHDRRouteAuthorizationDecision> {
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
            (decision: ExternalHDRRouteAuthorizationDecision):
            ExternalHDRRouteAuthorizationDecision => {
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

    /** Checks only settled evidence for the route's current reference shader and never waits optimistically. */
    public isAuthorized(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        metadata: InputColorMetadata
    ): boolean {
        return this.getAuthorizationFailure(device, targetFormat, metadata) === null;
    }

    /**
     * Returns why this device, target format, and metadata's route are not authorized, as `<state>: <route key>` with the failing value, or null when they are.
     * Metadata no probe covers reports `route-unsupported` with its bit depth and color description.
     */
    public getAuthorizationFailure(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        metadata: InputColorMetadata
    ): string | null {
        const routeKey = getExternalHDRAuthorizationRouteKey(metadata);
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
        return describeAuthorizationDecision(
            routeKey,
            probe !== undefined,
            decision,
            (): string => this.getReferenceSignature(device, targetFormat, routeKey)
        );
    }

    /** Returns bounded diagnostics without exposing retained decoder or GPU objects. */
    public getTelemetry(
        device: GPUDevice | null,
        targetFormat: GPUTextureFormat | null
    ): ExternalHDRAuthorizationTelemetry {
        const accumulator: TelemetryAccumulator = {
            authorizedRouteKeys: [],
            failureDetails: {},
            failureReasons: {},
            maximumChannelErrors: {},
            pendingRouteKeys: [],
            rejectedRouteKeys: [],
            sampleCounts: {}
        };
        if (!device || !targetFormat) {
            return {
                ...accumulator,
                vectorVersion: EXTERNAL_HDR_AUTHORIZATION_VECTOR_VERSION,
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
            vectorVersion: EXTERNAL_HDR_AUTHORIZATION_VECTOR_VERSION,
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
            createExternalHDRReferencePlan(device, targetFormat, routeKey).shaderCode
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
        const created: DeviceProbeCache = { referenceSignatures: new Map(), routes: new Map() };
        this.devices.set(device, created);
        void device.lost.then((): void => {
            this.devices.delete(device);
        });
        return created;
    }
}
