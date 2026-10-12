import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real built-in library and planner run behind spies, and the real executor runs on a mock device
vi.mock('webgpu-player/presentation/passes/builtin/BuiltinChains', async importOriginal => {
    const originalModule = await importOriginal<typeof import('webgpu-player/presentation/passes/builtin/BuiltinChains')>();
    return { ...originalModule, createBuiltinChain: vi.fn(originalModule.createBuiltinChain) };
});

vi.mock('webgpu-player/presentation/passes/PresentationPlanner', async importOriginal => {
    const originalModule = await importOriginal<typeof import('webgpu-player/presentation/passes/PresentationPlanner')>();
    return { ...originalModule, planPresentation: vi.fn(originalModule.planPresentation) };
});

import {
    createDefaultRenderSettings,
    createHDRToSDRRenderSettings,
    RENDER_SETTINGS_UNIFORM_BYTE_LENGTH
} from 'webgpu-player/presentation/RenderSettings';
import {
    createHLGColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata,
    type InputColorMetadata
} from 'webgpu-player/color/ColorMetadata';
import type { ColorTriplet } from 'webgpu-player/color/ColorPipeline';
import { createBuiltinChain } from 'webgpu-player/presentation/passes/builtin/BuiltinChains';
import type { PlannedPass, PresentationPlan } from 'webgpu-player/presentation/passes/PassTypes';
import { PresentationExecutor } from 'webgpu-player/presentation/passes/PresentationExecutor';
import { planPresentation } from 'webgpu-player/presentation/passes/PresentationPlanner';
import type { SupportedRawVideoFrameFormat, TransferableRawVideoFrame } from 'webgpu-player/video/RawVideoFrameCopy';
import {
    createExpectedRawHDRVectorObservations,
    createRawHDRAuthorizationVector,
    createRawHDRShaderSignature,
    evaluateRawHDRVectorObservations,
    getRawHDRAuthorizationRouteKey,
    RAW_HDR_AUTHORIZATION_ROUTE_KEYS,
    RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
    RAW_HDR_AUTHORIZATION_VECTOR_VERSION,
    RAW_HDR_AUTHORIZATION_VECTOR_WIDTH,
    RawHDRPresentationAuthorizationRegistry,
    RawHDRPresentationAuthorizationRunner,
    type RawHDRAuthorizationRouteKey,
    type RawHDRVectorObservation,
    type RawHDRRouteAuthorizationDecision
} from 'webgpu-player/validation/RawHDRPresentationAuthorization';

import {
    createWebGPUDeviceHarness,
    DEFAULT_MAXIMUM_TEXTURE_DIMENSION,
    getBufferWrites,
    getBuffers,
    getShaderCodes,
    installWebGPUGlobals,
    type MockGPUTexture,
    type ReadbackTexel,
    type WebGPUDeviceHarness
} from '../helpers/webGPUDeviceHarness';

const PQ_ROUTE_KEY: RawHDRAuthorizationRouteKey = 'I420P10:bt2020-ncl:bt2020:limited:pq';
const TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const UNREADABLE_TARGET_FORMAT: GPUTextureFormat = 'rgba16float';
const OTHER_TARGET_FORMAT: GPUTextureFormat = 'rgba8unorm';
// The authorization joins a reference plan's pass modules with this separator before signing them
const PLAN_SHADER_CODE_SEPARATOR = '\u0000';
const SUPERSEDED_REFERENCE_SHADER_CODE = 'superseded reference shader';
const AUTHORIZATION_TIMEOUT_MILLISECONDS = 5_000;
const VECTOR_SAMPLE_COUNT = 9;
const RENDER_VERTEX_COUNT = 6;
// One submission renders the vector, and one copies its samples back
const AUTHORIZATION_SUBMISSION_COUNT = 2;
const SIMULATED_PLANNING_FAILURE = 'simulated planning failure';
const SIMULATED_VALIDATION_ERROR = 'invalid bind group';
// A rejection names its worst error and the 3/255 bound in 8-bit steps, and the sample where it is
const PIXEL_MISMATCH_DETAIL_PATTERN = /^\d+(\.\d)?\/255 > 3\/255 at \(\d+, \d+\)$/;
const FIRST_SAMPLE_MISMATCH_DETAIL_PATTERN = /^\d+(\.\d)?\/255 > 3\/255 at \(0, 0\)$/;
// A sample moved to a coordinate the vector does not sample, and a channel the readback could not decode
const MISPLACED_SAMPLE_INDEX = 2;
const MISPLACED_SAMPLE_X = 99;
const NON_FINITE_CHANNEL_VALUE = Number.NaN;
const RAW_HDR_ROUTE_UNSUPPORTED_FAILURE = 'route-unsupported: I420P10 10-bit bt2020-ncl:bt2020:full:pq';
// The labels of the buffers the executor and the readback create
const RENDER_SETTINGS_LABEL = 'Presentation render settings';
const READBACK_BUFFER_LABEL = 'WebGPU color validation readback';
const TARGET_TEXTURE_LABEL = 'WebGPU raw HDR authorization target';

let restoreWebGPUGlobals: () => void = (): void => undefined;

function getRouteMetadata(routeKey: RawHDRAuthorizationRouteKey): InputColorMetadata {
    const format = routeKey.slice(0, routeKey.indexOf(':'));
    let bitDepth: 8 | 10 | 12 = 8;
    if (format.endsWith('P12')) {
        bitDepth = 12;
    } else if (format.endsWith('P10')) {
        bitDepth = 10;
    }
    if (routeKey.endsWith(':sdr')) {
        return createSDRColorMetadata({
            bitDepth,
            range: routeKey.includes(':full:') ? 'full' : 'limited'
        });
    }
    return routeKey.endsWith(':pq') ?
        createPQColorMetadata({ bitDepth }) :
        createHLGColorMetadata({ bitDepth });
}

function getRouteSettings(metadata: InputColorMetadata) {
    return metadata.transfer === 'sdr' ?
        createDefaultRenderSettings() :
        createHDRToSDRRenderSettings({
            toneMapping: { inputPeakNits: metadata.nominalPeakNits }
        });
}

function getPlanShaderCode(plan: PresentationPlan): string {
    return plan.passes.map((pass: PlannedPass): string => pass.code).join(PLAN_SHADER_CODE_SEPARATOR);
}

/** Plans a raw route's default chain as its authorization does, for the code its signature covers. */
function planRawReferenceShaderCode(routeKey: RawHDRAuthorizationRouteKey): string {
    const metadata = getRouteMetadata(routeKey);
    return getPlanShaderCode(planPresentation({
        chain: createBuiltinChain({
            format: routeKey.slice(0, routeKey.indexOf(':')) as SupportedRawVideoFrameFormat,
            hdrOutput: false,
            metadata,
            route: 'raw-yuv',
            settings: getRouteSettings(metadata)
        }),
        device: { features: new Set<string>(), maximumTextureDimension: DEFAULT_MAXIMUM_TEXTURE_DIMENSION },
        facts: {
            frameRate: null,
            hdrOutput: false,
            hdrSource: metadata.transfer !== 'sdr',
            outputHeight: RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
            outputWidth: RAW_HDR_AUTHORIZATION_VECTOR_WIDTH,
            sourceHeight: RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
            sourceWidth: RAW_HDR_AUTHORIZATION_VECTOR_WIDTH
        },
        output: { colorSpace: 'srgb', format: TARGET_FORMAT, toneMapping: 'standard' },
        passes: []
    }));
}

function createRouteObservations(
    routeKey: RawHDRAuthorizationRouteKey,
    metadata = getRouteMetadata(routeKey),
    frame = createRawHDRAuthorizationVector(routeKey)
): readonly RawHDRVectorObservation[] {
    return createExpectedRawHDRVectorObservations(frame, metadata, getRouteSettings(metadata));
}

/** Creates a device whose readbacks of the authorization target return the observations. */
function createDeviceHarness(
    observations: readonly RawHDRVectorObservation[],
    mapAsync?: () => Promise<void>
): WebGPUDeviceHarness {
    const observationMap = new Map<string, ColorTriplet>();
    for (const observation of observations) {
        observationMap.set(`${observation.sampleX}:${observation.sampleY}`, observation.linearRGB);
    }
    return createWebGPUDeviceHarness({
        mapAsync,
        readPixel: (texel: ReadbackTexel): ColorTriplet | undefined => observationMap.get(`${texel.sampleX}:${texel.sampleY}`)
    });
}

function swapVectorChroma(frame: TransferableRawVideoFrame): TransferableRawVideoFrame {
    const swappedData = frame.data.slice(0);
    const chromaUPlane = frame.planes[1];
    const chromaVPlane = frame.planes[2];
    const sourceData = new Uint8Array(frame.data);
    const destinationData = new Uint8Array(swappedData);
    destinationData.set(
        sourceData.slice(chromaVPlane.byteOffset, chromaVPlane.byteOffset + chromaVPlane.byteLength),
        chromaUPlane.byteOffset
    );
    destinationData.set(
        sourceData.slice(chromaUPlane.byteOffset, chromaUPlane.byteOffset + chromaUPlane.byteLength),
        chromaVPlane.byteOffset
    );
    return { ...frame, data: swappedData };
}

function mutateFirstPixel(observations: readonly RawHDRVectorObservation[]): readonly RawHDRVectorObservation[] {
    return observations.map((observation, observationIndex) => observationIndex === 0 ? {
        ...observation,
        linearRGB: [
            Math.min(observation.linearRGB[0] + 0.1, 1),
            observation.linearRGB[1],
            observation.linearRGB[2]
        ]
    } : observation);
}

function createAuthorizedDecision(
    device: GPUDevice,
    routeKey: RawHDRAuthorizationRouteKey,
    targetFormat: GPUTextureFormat,
    shaderCode: string
): RawHDRRouteAuthorizationDecision {
    return {
        authorizedRouteKeys: [ routeKey ],
        device,
        failureDetail: null,
        failureReason: null,
        vectorVersion: RAW_HDR_AUTHORIZATION_VECTOR_VERSION,
        maximumChannelError: 0,
        renderSettingsVersion: getRouteSettings(getRouteMetadata(routeKey)).version,
        routeKey,
        sampleCount: VECTOR_SAMPLE_COUNT,
        shaderSignature: createRawHDRShaderSignature(targetFormat, shaderCode),
        status: 'authorized',
        targetFormat
    };
}

/** Returns the plane uploads of a vector: each plane from the vector's own buffer, at its own offset and stride. */
function getExpectedPlaneUploads(frame: TransferableRawVideoFrame): GPUTexelCopyBufferLayout[] {
    return frame.planes.map(plane => ({ bytesPerRow: plane.bytesPerRow, offset: plane.byteOffset, rowsPerImage: plane.height }));
}

function expectEveryResourceDestroyed(harness: WebGPUDeviceHarness): void {
    for (const buffer of harness.buffers) {
        expect(buffer.destroy, buffer.label).toHaveBeenCalled();
    }
    for (const texture of harness.textures) {
        expect(texture.destroy, texture.label).toHaveBeenCalledOnce();
    }
}

const SDR_AUTHORIZATION_ROUTE_KEYS = RAW_HDR_AUTHORIZATION_ROUTE_KEYS.filter(
    (routeKey: RawHDRAuthorizationRouteKey): boolean => routeKey.endsWith(':sdr')
);
const HDR_AUTHORIZATION_ROUTE_KEYS = RAW_HDR_AUTHORIZATION_ROUTE_KEYS.filter(
    (routeKey: RawHDRAuthorizationRouteKey): boolean => !routeKey.endsWith(':sdr')
);

describe('RawHDRPresentationAuthorization', () => {
    beforeEach(() => {
        restoreWebGPUGlobals = installWebGPUGlobals();
        vi.spyOn(PresentationExecutor, 'create');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
        restoreWebGPUGlobals();
    });

    it('whitelists exact format, bit-depth, chromaticity, range, and transfer tuples', () => {
        expect(getRawHDRAuthorizationRouteKey('I420P10', createPQColorMetadata())).toBe(
            'I420P10:bt2020-ncl:bt2020:limited:pq'
        );
        expect(getRawHDRAuthorizationRouteKey('I420P10', createHLGColorMetadata())).toBe(
            'I420P10:bt2020-ncl:bt2020:limited:hlg'
        );
        expect(getRawHDRAuthorizationRouteKey(
            'I420P10',
            createPQColorMetadata({ range: 'full' })
        )).toBeNull();
        expect(getRawHDRAuthorizationRouteKey(
            'I420P12',
            createPQColorMetadata({ bitDepth: 12 })
        )).toBe('I420P12:bt2020-ncl:bt2020:limited:pq');
        expect(getRawHDRAuthorizationRouteKey('I444P10', createPQColorMetadata({ bitDepth: 12 }))).toBeNull();
    });

    it('enumerates both SDR ranges for all nine Rext raw formats', () => {
        const formats = [
            'I420',
            'I420P10',
            'I420P12',
            'I422',
            'I422P10',
            'I422P12',
            'I444',
            'I444P10',
            'I444P12'
        ] as const;

        expect(SDR_AUTHORIZATION_ROUTE_KEYS).toHaveLength(formats.length * 2);
        for (const format of formats) {
            expect(SDR_AUTHORIZATION_ROUTE_KEYS).toContain(`${format}:bt709:bt709:limited:sdr`);
            expect(SDR_AUTHORIZATION_ROUTE_KEYS).toContain(`${format}:bt709:bt709:full:sdr`);
        }
    });

    it.each(SDR_AUTHORIZATION_ROUTE_KEYS)(
        'authorizes exact SDR output route %s without render settings',
        async routeKey => {
            const harness = createDeviceHarness(createRouteObservations(routeKey));
            const runner = new RawHDRPresentationAuthorizationRunner();

            const decision = await runner.validate(harness.device, TARGET_FORMAT, routeKey);

            expect(decision).toMatchObject({
                failureReason: null,
                routeKey,
                sampleCount: VECTOR_SAMPLE_COUNT,
                status: 'authorized'
            });
            // The identity SDR chain binds no render settings
            expect(getBuffers(harness, RENDER_SETTINGS_LABEL)).toEqual([]);
            const vector = createRawHDRAuthorizationVector(routeKey);
            expect(harness.textureWrites.map(write => write.dataLayout)).toEqual(getExpectedPlaneUploads(vector));
            for (const write of harness.textureWrites) {
                expect(new Uint8Array(write.data as ArrayBuffer)).toEqual(new Uint8Array(vector.data));
            }
            expect(harness.importExternalTexture).not.toHaveBeenCalled();
        }
    );

    it.each(HDR_AUTHORIZATION_ROUTE_KEYS)(
        'authorizes %s through its built-in default chain',
        async routeKey => {
            const metadata = getRouteMetadata(routeKey);
            const harness = createDeviceHarness(createRouteObservations(routeKey));
            const runner = new RawHDRPresentationAuthorizationRunner();

            const decision = await runner.validate(harness.device, TARGET_FORMAT, routeKey);

            // The signature covers exactly the modules the executor compiled
            expect(decision).toMatchObject({
                authorizedRouteKeys: [ routeKey ],
                failureReason: null,
                routeKey,
                sampleCount: VECTOR_SAMPLE_COUNT,
                shaderSignature: createRawHDRShaderSignature(TARGET_FORMAT, getShaderCodes(harness).join(PLAN_SHADER_CODE_SEPARATOR)),
                status: 'authorized',
                targetFormat: TARGET_FORMAT
            });
            expect(createBuiltinChain).toHaveBeenCalledWith({
                format: routeKey.slice(0, routeKey.indexOf(':')),
                hdrOutput: false,
                metadata,
                route: 'raw-yuv',
                settings: getRouteSettings(metadata)
            });
            expect(planPresentation).toHaveBeenCalledOnce();
            const planRequest = vi.mocked(planPresentation).mock.calls[0][0];
            expect(planRequest).toMatchObject({
                device: { maximumTextureDimension: DEFAULT_MAXIMUM_TEXTURE_DIMENSION },
                facts: {
                    frameRate: null,
                    hdrOutput: false,
                    hdrSource: true,
                    outputHeight: RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
                    outputWidth: RAW_HDR_AUTHORIZATION_VECTOR_WIDTH,
                    sourceHeight: RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
                    sourceWidth: RAW_HDR_AUTHORIZATION_VECTOR_WIDTH
                },
                output: { colorSpace: 'srgb', format: TARGET_FORMAT, toneMapping: 'standard' },
                passes: []
            });
            const plan = vi.mocked(planPresentation).mock.results[0].value as PresentationPlan;
            expect(getShaderCodes(harness).join(PLAN_SHADER_CODE_SEPARATOR)).toBe(planRawReferenceShaderCode(routeKey));
            expect(PresentationExecutor.create).toHaveBeenCalledWith(harness.device, plan);
            const renderSettingsWrites = getBufferWrites(harness, RENDER_SETTINGS_LABEL);
            expect(renderSettingsWrites).toHaveLength(1);
            expect(renderSettingsWrites[0].bytes.byteLength).toBe(RENDER_SETTINGS_UNIFORM_BYTE_LENGTH);
            // One pass draws the vector 1:1 into the whole target
            expect(harness.renderPasses).toHaveLength(1);
            expect(harness.renderPasses[0]).toMatchObject({
                drawVertexCounts: [ RENDER_VERTEX_COUNT ],
                viewport: [ 0, 0, RAW_HDR_AUTHORIZATION_VECTOR_WIDTH, RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT, 0, 1 ]
            });
            expect(harness.textureWrites.map(write => write.dataLayout))
                .toEqual(getExpectedPlaneUploads(createRawHDRAuthorizationVector(routeKey)));
            expect(harness.queueSubmit).toHaveBeenCalledTimes(AUTHORIZATION_SUBMISSION_COUNT);
            expectEveryResourceDestroyed(harness);
        }
    );

    it.each([
        {
            label: 'U/V swap',
            observations: (): readonly RawHDRVectorObservation[] => createRouteObservations(
                PQ_ROUTE_KEY,
                createPQColorMetadata(),
                swapVectorChroma(createRawHDRAuthorizationVector(PQ_ROUTE_KEY))
            )
        },
        {
            label: 'full range',
            observations: (): readonly RawHDRVectorObservation[] => createRouteObservations(
                PQ_ROUTE_KEY,
                createPQColorMetadata({ range: 'full' })
            )
        },
        {
            label: 'BT.709 matrix',
            observations: (): readonly RawHDRVectorObservation[] => createRouteObservations(
                PQ_ROUTE_KEY,
                createPQColorMetadata({ matrix: 'bt709' })
            )
        },
        {
            label: 'HLG transfer',
            observations: (): readonly RawHDRVectorObservation[] => createRouteObservations(
                PQ_ROUTE_KEY,
                createHLGColorMetadata()
            )
        },
        {
            label: 'expected pixel',
            observations: (): readonly RawHDRVectorObservation[] => mutateFirstPixel(
                createRouteObservations(PQ_ROUTE_KEY)
            )
        }
    ])('rejects a corrupted $label result and cleans resources', async testCase => {
        const harness = createDeviceHarness(testCase.observations());
        const runner = new RawHDRPresentationAuthorizationRunner();

        const decision = await runner.validate(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);

        expect(decision).toMatchObject({
            authorizedRouteKeys: [],
            failureReason: 'pixel-mismatch',
            status: 'rejected'
        });
        expect(decision.failureDetail).toMatch(PIXEL_MISMATCH_DETAIL_PATTERN);
        expect(PresentationExecutor.create).toHaveBeenCalledOnce();
        expectEveryResourceDestroyed(harness);
    });

    it('names the corrupted sample in a pixel mismatch', async () => {
        const harness = createDeviceHarness(mutateFirstPixel(createRouteObservations(PQ_ROUTE_KEY)));
        const runner = new RawHDRPresentationAuthorizationRunner();

        const decision = await runner.validate(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);

        expect(decision.failureDetail).toMatch(FIRST_SAMPLE_MISMATCH_DETAIL_PATTERN);
    });

    it('rejects an unreadable production target format before creating resources', async () => {
        const harness = createDeviceHarness([]);
        const runner = new RawHDRPresentationAuthorizationRunner();

        await expect(runner.validate(harness.device, UNREADABLE_TARGET_FORMAT, PQ_ROUTE_KEY)).resolves.toMatchObject({
            failureDetail: UNREADABLE_TARGET_FORMAT,
            failureReason: 'target-format-unsupported',
            status: 'rejected'
        });
        expect(PresentationExecutor.create).not.toHaveBeenCalled();
        expect(harness.textures).toEqual([]);
    });

    it('names the WebGPU global a probe is missing', async () => {
        Reflect.deleteProperty(globalThis, 'GPUBufferUsage');
        const harness = createDeviceHarness([]);
        const runner = new RawHDRPresentationAuthorizationRunner();

        await expect(runner.validate(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY)).resolves.toMatchObject({
            failureDetail: 'GPUBufferUsage undefined',
            failureReason: 'gpu-api-unavailable',
            status: 'rejected'
        });
        expect(PresentationExecutor.create).not.toHaveBeenCalled();
    });

    it('rejects a reference chain that cannot be planned before creating resources', async () => {
        vi.mocked(planPresentation).mockImplementationOnce((): PresentationPlan => {
            throw new Error(SIMULATED_PLANNING_FAILURE);
        });
        const harness = createDeviceHarness([]);
        const runner = new RawHDRPresentationAuthorizationRunner();

        await expect(runner.validate(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY)).resolves.toMatchObject({
            failureDetail: `reference-plan: ${SIMULATED_PLANNING_FAILURE}`,
            failureReason: 'unexpected-error',
            status: 'rejected'
        });
        expect(PresentationExecutor.create).not.toHaveBeenCalled();
    });

    it('rejects a GPU validation error and releases every created resource', async () => {
        const harness = createDeviceHarness(createRouteObservations(PQ_ROUTE_KEY));
        harness.popErrorScope.mockResolvedValueOnce(new Error(SIMULATED_VALIDATION_ERROR));
        const runner = new RawHDRPresentationAuthorizationRunner();

        await expect(runner.validate(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY)).resolves.toMatchObject({
            failureDetail: SIMULATED_VALIDATION_ERROR,
            failureReason: 'gpu-validation-failed',
            status: 'rejected'
        });
        expect(getBuffers(harness, READBACK_BUFFER_LABEL)).toEqual([]);
        expect(harness.textures.filter((texture: MockGPUTexture): boolean => texture.label === TARGET_TEXTURE_LABEL)).toHaveLength(1);
        expectEveryResourceDestroyed(harness);
    });

    it('rejects a bounded executor creation timeout and destroys the late executor', async () => {
        vi.useFakeTimers();
        const deferredExecutor: {
            resolve: ((executor: PresentationExecutor) => void) | null
        } = { resolve: null };
        vi.mocked(PresentationExecutor.create).mockImplementationOnce(() => new Promise<PresentationExecutor>(resolve => {
            deferredExecutor.resolve = resolve;
        }));
        const harness = createDeviceHarness(createRouteObservations(PQ_ROUTE_KEY));
        const runner = new RawHDRPresentationAuthorizationRunner();
        const decisionPromise = runner.validate(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);

        await vi.advanceTimersByTimeAsync(AUTHORIZATION_TIMEOUT_MILLISECONDS);

        await expect(decisionPromise).resolves.toMatchObject({
            failureDetail: 'executor',
            failureReason: 'timeout',
            status: 'rejected'
        });
        const resolveExecutor = deferredExecutor.resolve;
        if (!resolveExecutor) {
            throw new Error('The late executor resolver was not initialized');
        }
        const lateExecutor = { destroy: vi.fn(), encode: vi.fn() };
        resolveExecutor(lateExecutor as unknown as PresentationExecutor);
        await vi.waitFor(() => expect(lateExecutor.destroy).toHaveBeenCalledOnce());
        expect(lateExecutor.encode).not.toHaveBeenCalled();
    });

    it('applies the whole-route deadline to a batched readback', async () => {
        vi.useFakeTimers();
        const harness = createDeviceHarness(
            createRouteObservations(PQ_ROUTE_KEY),
            () => new Promise<void>(() => undefined)
        );
        const runner = new RawHDRPresentationAuthorizationRunner();
        const decisionPromise = runner.validate(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);

        await vi.advanceTimersByTimeAsync(AUTHORIZATION_TIMEOUT_MILLISECONDS);

        await expect(decisionPromise).resolves.toMatchObject({
            failureDetail: 'readback',
            failureReason: 'timeout',
            status: 'rejected'
        });
        expect(getBuffers(harness, READBACK_BUFFER_LABEL)).toHaveLength(1);
        expectEveryResourceDestroyed(harness);
    });

    it('rejects device loss without waiting for the timeout', async () => {
        vi.mocked(PresentationExecutor.create).mockImplementationOnce(() => new Promise<PresentationExecutor>(() => undefined));
        const harness = createDeviceHarness(createRouteObservations(PQ_ROUTE_KEY));
        const runner = new RawHDRPresentationAuthorizationRunner();
        const decisionPromise = runner.validate(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);

        harness.lost.resolve({
            message: 'authorization device lost',
            reason: 'unknown'
        } as GPUDeviceLostInfo);

        await expect(decisionPromise).resolves.toMatchObject({
            failureDetail: 'executor',
            failureReason: 'device-lost',
            status: 'rejected'
        });
    });

    it('detects independently corrupted expected observations', () => {
        const expected = createRouteObservations(PQ_ROUTE_KEY);
        expect(evaluateRawHDRVectorObservations(expected, expected)).toMatchObject({
            accepted: true,
            failureDetail: null
        });
        expect(evaluateRawHDRVectorObservations(expected, mutateFirstPixel(expected))).toMatchObject({ accepted: false });
    });

    it('names what a rejected comparison found: the sample count, a misplaced sample, a non-finite channel, or the worst error', () => {
        const expected = createRouteObservations(PQ_ROUTE_KEY);
        const misplaced = expected.map((observation, observationIndex) => observationIndex === MISPLACED_SAMPLE_INDEX ?
            { ...observation, sampleX: MISPLACED_SAMPLE_X } :
            observation);
        const nonFinite = expected.map((observation, observationIndex) => observationIndex === 0 ?
            { ...observation, linearRGB: [ NON_FINITE_CHANNEL_VALUE, observation.linearRGB[1], observation.linearRGB[2] ] as ColorTriplet } :
            observation);
        const misplacedExpected = expected[MISPLACED_SAMPLE_INDEX];

        expect(evaluateRawHDRVectorObservations(expected, expected.slice(1)).failureDetail)
            .toBe(`sample count ${expected.length - 1}, expected ${expected.length}`);
        expect(evaluateRawHDRVectorObservations(expected, misplaced).failureDetail).toBe(
            `sample ${MISPLACED_SAMPLE_INDEX} at (${MISPLACED_SAMPLE_X}, ${misplacedExpected.sampleY}), `
            + `expected (${misplacedExpected.sampleX}, ${misplacedExpected.sampleY})`
        );
        expect(evaluateRawHDRVectorObservations(expected, nonFinite).failureDetail).toBe('non-finite channel 0 at (0, 0)');
        expect(evaluateRawHDRVectorObservations(expected, mutateFirstPixel(expected)).failureDetail)
            .toMatch(FIRST_SAMPLE_MISMATCH_DETAIL_PATTERN);
    });

    it('deduplicates probes and never authorizes a stale device identity', async () => {
        const firstHarness = createDeviceHarness([]);
        const secondHarness = createDeviceHarness([]);
        let resolveDecision: (decision: RawHDRRouteAuthorizationDecision) => void = (
            (decision: RawHDRRouteAuthorizationDecision): void => {
                throw new Error(`Decision resolver was not initialized: ${decision.status}`);
            }
        );
        const pendingDecision = new Promise<RawHDRRouteAuthorizationDecision>(resolve => {
            resolveDecision = resolve;
        });
        const runner = {
            validate: vi.fn(() => pendingDecision)
        } as RawHDRPresentationAuthorizationRunner;
        const registry = new RawHDRPresentationAuthorizationRegistry(runner);

        const metadata = createPQColorMetadata();
        expect(registry.getAuthorizationFailure(firstHarness.device, TARGET_FORMAT, metadata, 'I420P10')).toBe(`unprobed: ${PQ_ROUTE_KEY}`);
        const firstPromise = registry.authorize(firstHarness.device, TARGET_FORMAT, PQ_ROUTE_KEY);
        const secondPromise = registry.authorize(firstHarness.device, TARGET_FORMAT, PQ_ROUTE_KEY);
        expect(firstPromise).toBe(secondPromise);
        await Promise.resolve();
        expect(runner.validate).toHaveBeenCalledOnce();
        expect(registry.getTelemetry(firstHarness.device, TARGET_FORMAT)).toMatchObject({
            pendingRouteKeys: [ PQ_ROUTE_KEY ],
            status: 'pending'
        });
        expect(registry.getAuthorizationFailure(firstHarness.device, TARGET_FORMAT, metadata, 'I420P10')).toBe(`pending: ${PQ_ROUTE_KEY}`);

        const decision = createAuthorizedDecision(firstHarness.device, PQ_ROUTE_KEY, TARGET_FORMAT, planRawReferenceShaderCode(PQ_ROUTE_KEY));
        resolveDecision(decision);
        await expect(firstPromise).resolves.toBe(decision);

        expect(registry.isAuthorized(firstHarness.device, TARGET_FORMAT, metadata, 'I420P10')).toBe(true);
        expect(registry.getAuthorizationFailure(firstHarness.device, TARGET_FORMAT, metadata, 'I420P10')).toBeNull();
        expect(registry.isAuthorized(secondHarness.device, TARGET_FORMAT, metadata, 'I420P10')).toBe(false);
        expect(registry.isAuthorized(firstHarness.device, OTHER_TARGET_FORMAT, metadata, 'I420P10')).toBe(false);
        expect(registry.isAuthorized(
            firstHarness.device,
            TARGET_FORMAT,
            createPQColorMetadata({ range: 'full' }),
            'I420P10'
        )).toBe(false);
        expect(registry.getAuthorizationFailure(
            firstHarness.device,
            TARGET_FORMAT,
            createPQColorMetadata({ range: 'full' }),
            'I420P10'
        )).toBe(RAW_HDR_ROUTE_UNSUPPORTED_FAILURE);

        firstHarness.lost.resolve({
            message: 'test loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await Promise.resolve();
        expect(registry.getTelemetry(firstHarness.device, TARGET_FORMAT).status).toBe('unavailable');
    });

    it('authorizes only decisions rendered through the current reference shader, planned once per device', async () => {
        const harness = createDeviceHarness([]);
        const staleDecision = createAuthorizedDecision(harness.device, PQ_ROUTE_KEY, TARGET_FORMAT, SUPERSEDED_REFERENCE_SHADER_CODE);
        const runner = {
            validate: vi.fn(() => Promise.resolve(staleDecision))
        } as RawHDRPresentationAuthorizationRunner;
        const registry = new RawHDRPresentationAuthorizationRegistry(runner);

        await registry.authorize(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);

        expect(registry.isAuthorized(harness.device, TARGET_FORMAT, createPQColorMetadata(), 'I420P10')).toBe(false);
        expect(registry.getAuthorizationFailure(harness.device, TARGET_FORMAT, createPQColorMetadata(), 'I420P10'))
            .toBe(`signature-stale: ${PQ_ROUTE_KEY}`);
        expect(planPresentation).toHaveBeenCalledOnce();
    });

    it('reports a rejected route with its failure reason and detail', async () => {
        const harness = createDeviceHarness(mutateFirstPixel(createRouteObservations(PQ_ROUTE_KEY)));
        const registry = new RawHDRPresentationAuthorizationRegistry();

        const decision = await registry.authorize(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);

        expect(registry.getAuthorizationFailure(harness.device, TARGET_FORMAT, createPQColorMetadata(), 'I420P10'))
            .toBe(`pixel-mismatch: ${PQ_ROUTE_KEY} ${decision.failureDetail}`);
        expect(registry.getTelemetry(harness.device, TARGET_FORMAT)).toMatchObject({
            failureDetails: { [PQ_ROUTE_KEY]: decision.failureDetail },
            failureReasons: { [PQ_ROUTE_KEY]: 'pixel-mismatch' }
        });
    });
});
