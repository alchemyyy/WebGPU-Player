import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockFunction = ReturnType<typeof vi.fn>;

type MockExecutor = {
    destroy: MockFunction
    encode: MockFunction
    plan: PresentationPlan
    writeDolbyVisionRPU: MockFunction
    writeRenderSettings: MockFunction
};

const passMocks = vi.hoisted(() => {
    const executors: MockExecutor[] = [];
    return {
        createExecutor(plan: PresentationPlan): MockExecutor {
            const executor: MockExecutor = {
                destroy: vi.fn(),
                encode: vi.fn(),
                plan,
                writeDolbyVisionRPU: vi.fn(),
                writeRenderSettings: vi.fn()
            };
            executors.push(executor);
            return executor;
        },
        executors
    };
});

vi.mock('webgpu-player/presentation/passes/builtin/BuiltinChains', () => ({
    createBuiltinChain: vi.fn((configuration: BuiltinChainConfiguration): BuiltinChain => ({
        colorFunctions: [],
        signal: {
            bypassCondition: null,
            code: '',
            entryPoint: 'readSignal',
            name: configuration.route,
            resources: [],
            sourceKind: 'planes'
        },
        sourceIsDisplay: false
    }))
}));

vi.mock('webgpu-player/presentation/passes/PresentationPlanner', () => ({
    // One fused pass whose code names its route and target, as the default chain plans
    planPresentation: vi.fn((planRequest: PlanRequest): PresentationPlan => ({
        buffers: [],
        output: planRequest.output,
        parameterSets: [],
        passes: [ {
            bindings: [],
            code: `${planRequest.chain.signal.name}:${planRequest.output.format}`,
            coordinateMapping: 'object-fit',
            indirectBufferId: null,
            inputTextureId: null,
            kind: 'render',
            label: planRequest.chain.signal.name,
            lineMap: [],
            target: { kind: 'output' },
            workgroupCounts: null
        } ],
        report: { activePasses: [], conflicts: [], inactivePasses: [] },
        sourceKind: planRequest.chain.signal.sourceKind,
        textures: [],
        usesRenderSettings: true
    }))
}));

vi.mock('webgpu-player/presentation/passes/PresentationExecutor', () => ({
    PresentationExecutor: {
        create: vi.fn((_device: GPUDevice, plan: PresentationPlan) => Promise.resolve(passMocks.createExecutor(plan)))
    }
}));

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
import type {
    BuiltinChain,
    BuiltinChainConfiguration,
    PlanRequest,
    PresentationFrameInput,
    PresentationPlan
} from 'webgpu-player/presentation/passes/PassTypes';
import { PresentationExecutor } from 'webgpu-player/presentation/passes/PresentationExecutor';
import { planPresentation } from 'webgpu-player/presentation/passes/PresentationPlanner';
import type { TransferableRawVideoFrame } from 'webgpu-player/video/RawVideoFrameCopy';
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

type MockBuffer = GPUBuffer & {
    bytes: Uint8Array
};

type DeviceHarness = {
    bufferDestroy: MockFunction
    device: GPUDevice
    lostResolve: (info: GPUDeviceLostInfo) => void
    popErrorScope: MockFunction
    queueSubmit: MockFunction
    textureDestroy: MockFunction
};

const PQ_ROUTE_KEY: RawHDRAuthorizationRouteKey = 'I420P10:bt2020-ncl:bt2020:limited:pq';
const TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const UNREADABLE_TARGET_FORMAT: GPUTextureFormat = 'rgba16float';
const OTHER_TARGET_FORMAT: GPUTextureFormat = 'rgba8unorm';
// The reference shader code the mocked planner gives every raw route at the target format
const RAW_REFERENCE_SHADER_CODE = `raw-yuv:${TARGET_FORMAT}`;
const AUTHORIZATION_TIMEOUT_MILLISECONDS = 5_000;

const originalGPUBufferUsage = Object.getOwnPropertyDescriptor(globalThis, 'GPUBufferUsage');
const originalGPUMapMode = Object.getOwnPropertyDescriptor(globalThis, 'GPUMapMode');
const originalGPUTextureUsage = Object.getOwnPropertyDescriptor(globalThis, 'GPUTextureUsage');

function restoreProperty(
    target: object,
    propertyName: PropertyKey,
    descriptor: PropertyDescriptor | undefined
): void {
    if (descriptor) {
        Object.defineProperty(target, propertyName, descriptor);
    } else {
        Reflect.deleteProperty(target, propertyName);
    }
}

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

function createRouteObservations(
    routeKey: RawHDRAuthorizationRouteKey,
    metadata = getRouteMetadata(routeKey),
    frame = createRawHDRAuthorizationVector(routeKey)
): readonly RawHDRVectorObservation[] {
    return createExpectedRawHDRVectorObservations(frame, metadata, getRouteSettings(metadata));
}

function createDeviceHarness(
    observations: readonly RawHDRVectorObservation[],
    mapAsyncFactory?: () => Promise<void>
): DeviceHarness {
    const observationMap = new Map<string, ColorTriplet>();
    for (const observation of observations) {
        observationMap.set(`${observation.sampleX}:${observation.sampleY}`, observation.linearRGB);
    }

    let lostResolve: (info: GPUDeviceLostInfo) => void = (): void => undefined;
    const lost = new Promise<GPUDeviceLostInfo>(resolve => {
        lostResolve = resolve;
    });
    const bufferDestroy = vi.fn();
    const textureDestroy = vi.fn();
    const popErrorScope = vi.fn(() => Promise.resolve(null));
    const queueSubmit = vi.fn();
    const device = {
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const bytes = new Uint8Array(Number(descriptor.size));
            return {
                bytes,
                destroy: bufferDestroy,
                getMappedRange: vi.fn((offset = 0, size = bytes.byteLength) => bytes.buffer.slice(offset, offset + size)),
                mapAsync: vi.fn(() => mapAsyncFactory?.() ?? Promise.resolve()),
                unmap: vi.fn()
            } as unknown as MockBuffer;
        }),
        createCommandEncoder: vi.fn(() => ({
            copyTextureToBuffer: vi.fn((source: GPUTexelCopyTextureInfo, destination: GPUTexelCopyBufferInfo) => {
                const origin = source.origin as GPUOrigin3DDict;
                const sampleX = Number(origin.x ?? 0);
                const sampleY = Number(origin.y ?? 0);
                const linearRGB = observationMap.get(`${sampleX}:${sampleY}`);
                if (!linearRGB) {
                    throw new Error('Unexpected readback coordinate');
                }
                const destinationBuffer = destination.buffer as MockBuffer;
                const byteOffset = Number(destination.offset ?? 0);
                destinationBuffer.bytes[byteOffset] = Math.round(linearRGB[2] * 255);
                destinationBuffer.bytes[byteOffset + 1] = Math.round(linearRGB[1] * 255);
                destinationBuffer.bytes[byteOffset + 2] = Math.round(linearRGB[0] * 255);
                destinationBuffer.bytes[byteOffset + 3] = 255;
            }),
            finish: vi.fn(() => ({}))
        })),
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => ({
            createView: vi.fn(() => ({})),
            depthOrArrayLayers: 1,
            destroy: textureDestroy,
            format: descriptor.format,
            height: Number((descriptor.size as GPUExtent3DDict).height ?? 1),
            usage: descriptor.usage,
            width: Number((descriptor.size as GPUExtent3DDict).width ?? 1)
        })),
        features: new Set<string>(),
        limits: { maxTextureDimension2D: 8_192 },
        lost,
        popErrorScope,
        pushErrorScope: vi.fn(),
        queue: {
            onSubmittedWorkDone: vi.fn(() => Promise.resolve()),
            submit: queueSubmit,
            writeBuffer: vi.fn()
        }
    } as unknown as GPUDevice;
    return {
        bufferDestroy,
        device,
        lostResolve,
        popErrorScope,
        queueSubmit,
        textureDestroy
    };
}

function getOnlyExecutor(): MockExecutor {
    expect(passMocks.executors).toHaveLength(1);
    return passMocks.executors[0];
}

function getEncodedFrame(executor: MockExecutor): PresentationFrameInput {
    expect(executor.encode).toHaveBeenCalledOnce();
    return executor.encode.mock.calls[0][1] as PresentationFrameInput;
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
        failureReason: null,
        vectorVersion: RAW_HDR_AUTHORIZATION_VECTOR_VERSION,
        maximumChannelError: 0,
        renderSettingsVersion: getRouteSettings(getRouteMetadata(routeKey)).version,
        routeKey,
        sampleCount: 9,
        shaderSignature: createRawHDRShaderSignature(targetFormat, shaderCode),
        status: 'authorized',
        targetFormat
    };
}

const SDR_AUTHORIZATION_ROUTE_KEYS = RAW_HDR_AUTHORIZATION_ROUTE_KEYS.filter(
    (routeKey: RawHDRAuthorizationRouteKey): boolean => routeKey.endsWith(':sdr')
);
const HDR_AUTHORIZATION_ROUTE_KEYS = RAW_HDR_AUTHORIZATION_ROUTE_KEYS.filter(
    (routeKey: RawHDRAuthorizationRouteKey): boolean => !routeKey.endsWith(':sdr')
);

describe('RawHDRPresentationAuthorization', () => {
    beforeEach(() => {
        passMocks.executors.length = 0;
        Object.defineProperty(globalThis, 'GPUBufferUsage', {
            configurable: true,
            // WebGPU defines these external names
            // eslint-disable-next-line @typescript-eslint/naming-convention
            value: { COPY_DST: 8, MAP_READ: 1, UNIFORM: 64 }
        });
        Object.defineProperty(globalThis, 'GPUMapMode', {
            configurable: true,
            value: { READ: 1 }
        });
        Object.defineProperty(globalThis, 'GPUTextureUsage', {
            configurable: true,
            // WebGPU defines these external names
            // eslint-disable-next-line @typescript-eslint/naming-convention
            value: { COPY_DST: 2, COPY_SRC: 1, RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 }
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
        restoreProperty(globalThis, 'GPUBufferUsage', originalGPUBufferUsage);
        restoreProperty(globalThis, 'GPUMapMode', originalGPUMapMode);
        restoreProperty(globalThis, 'GPUTextureUsage', originalGPUTextureUsage);
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
                sampleCount: 9,
                status: 'authorized'
            });
            const executor = getOnlyExecutor();
            expect(executor.writeRenderSettings).not.toHaveBeenCalled();
            expect(getEncodedFrame(executor).source).toStrictEqual({
                enhancementFrame: null,
                frame: createRawHDRAuthorizationVector(routeKey),
                kind: 'planes'
            });
        }
    );

    it.each(HDR_AUTHORIZATION_ROUTE_KEYS)(
        'authorizes %s through its built-in default chain',
        async routeKey => {
            const metadata = getRouteMetadata(routeKey);
            const harness = createDeviceHarness(createRouteObservations(routeKey));
            const runner = new RawHDRPresentationAuthorizationRunner();

            const decision = await runner.validate(harness.device, TARGET_FORMAT, routeKey);

            expect(decision).toMatchObject({
                authorizedRouteKeys: [ routeKey ],
                failureReason: null,
                routeKey,
                sampleCount: 9,
                shaderSignature: createRawHDRShaderSignature(TARGET_FORMAT, RAW_REFERENCE_SHADER_CODE),
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
                device: { maximumTextureDimension: 8_192 },
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
            const executor = getOnlyExecutor();
            expect(PresentationExecutor.create).toHaveBeenCalledWith(harness.device, executor.plan);
            expect(executor.writeRenderSettings).toHaveBeenCalledOnce();
            expect((executor.writeRenderSettings.mock.calls[0][0] as ArrayBuffer).byteLength)
                .toBe(RENDER_SETTINGS_UNIFORM_BYTE_LENGTH);
            expect(getEncodedFrame(executor)).toMatchObject({
                geometry: {
                    textureOffsetX: 0,
                    textureOffsetY: 0,
                    textureScaleX: 1,
                    textureScaleY: 1,
                    viewportHeight: RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
                    viewportWidth: RAW_HDR_AUTHORIZATION_VECTOR_WIDTH,
                    viewportX: 0,
                    viewportY: 0
                },
                newFrame: true,
                skippedFrameCount: 0,
                timestampMicroseconds: 0
            });
            expect(harness.queueSubmit).toHaveBeenCalledTimes(2);
            expect(executor.destroy).toHaveBeenCalledOnce();
            expect(harness.textureDestroy).toHaveBeenCalledOnce();
            expect(harness.bufferDestroy).toHaveBeenCalledOnce();
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
        expect(getOnlyExecutor().destroy).toHaveBeenCalledOnce();
        expect(harness.textureDestroy).toHaveBeenCalledOnce();
        expect(harness.bufferDestroy).toHaveBeenCalledOnce();
    });

    it('rejects an unreadable production target format before creating resources', async () => {
        const harness = createDeviceHarness([]);
        const runner = new RawHDRPresentationAuthorizationRunner();

        await expect(runner.validate(harness.device, UNREADABLE_TARGET_FORMAT, PQ_ROUTE_KEY)).resolves.toMatchObject({
            failureReason: 'target-format-unsupported',
            status: 'rejected'
        });
        expect(PresentationExecutor.create).not.toHaveBeenCalled();
        expect(harness.textureDestroy).not.toHaveBeenCalled();
    });

    it('rejects a reference chain that cannot be planned before creating resources', async () => {
        vi.mocked(planPresentation).mockImplementationOnce((): PresentationPlan => {
            throw new Error('simulated planning failure');
        });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const harness = createDeviceHarness([]);
        const runner = new RawHDRPresentationAuthorizationRunner();

        await expect(runner.validate(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY)).resolves.toMatchObject({
            failureReason: 'unexpected-error',
            status: 'rejected'
        });
        expect(PresentationExecutor.create).not.toHaveBeenCalled();
    });

    it('rejects a GPU validation error and releases every created resource', async () => {
        const harness = createDeviceHarness(createRouteObservations(PQ_ROUTE_KEY));
        harness.popErrorScope.mockResolvedValueOnce(new Error('invalid bind group'));
        const runner = new RawHDRPresentationAuthorizationRunner();

        await expect(runner.validate(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY)).resolves.toMatchObject({
            failureReason: 'gpu-validation-failed',
            status: 'rejected'
        });
        expect(getOnlyExecutor().destroy).toHaveBeenCalledOnce();
        expect(harness.textureDestroy).toHaveBeenCalledOnce();
        expect(harness.bufferDestroy).not.toHaveBeenCalled();
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
            failureReason: 'timeout',
            status: 'rejected'
        });
        const resolveExecutor = deferredExecutor.resolve;
        if (!resolveExecutor) {
            throw new Error('The late executor resolver was not initialized');
        }
        const lateExecutor = passMocks.createExecutor({} as PresentationPlan);
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
            failureReason: 'timeout',
            status: 'rejected'
        });
        expect(harness.textureDestroy).toHaveBeenCalledOnce();
        expect(harness.bufferDestroy).toHaveBeenCalled();
        expect(getOnlyExecutor().destroy).toHaveBeenCalledOnce();
    });

    it('rejects device loss without waiting for the timeout', async () => {
        vi.mocked(PresentationExecutor.create).mockImplementationOnce(() => new Promise<PresentationExecutor>(() => undefined));
        const harness = createDeviceHarness(createRouteObservations(PQ_ROUTE_KEY));
        const runner = new RawHDRPresentationAuthorizationRunner();
        const decisionPromise = runner.validate(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);

        harness.lostResolve({
            message: 'authorization device lost',
            reason: 'unknown'
        } as GPUDeviceLostInfo);

        await expect(decisionPromise).resolves.toMatchObject({
            failureReason: 'device-lost',
            status: 'rejected'
        });
    });

    it('detects independently corrupted expected observations', () => {
        const expected = createRouteObservations(PQ_ROUTE_KEY);
        expect(evaluateRawHDRVectorObservations(expected, expected)).toMatchObject({
            accepted: true
        });
        expect(evaluateRawHDRVectorObservations(expected, mutateFirstPixel(expected))).toMatchObject({ accepted: false });
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

        const firstPromise = registry.authorize(firstHarness.device, TARGET_FORMAT, PQ_ROUTE_KEY);
        const secondPromise = registry.authorize(firstHarness.device, TARGET_FORMAT, PQ_ROUTE_KEY);
        expect(firstPromise).toBe(secondPromise);
        await Promise.resolve();
        expect(runner.validate).toHaveBeenCalledOnce();
        expect(registry.getTelemetry(firstHarness.device, TARGET_FORMAT)).toMatchObject({
            pendingRouteKeys: [ PQ_ROUTE_KEY ],
            status: 'pending'
        });

        const decision = createAuthorizedDecision(firstHarness.device, PQ_ROUTE_KEY, TARGET_FORMAT, RAW_REFERENCE_SHADER_CODE);
        resolveDecision(decision);
        await expect(firstPromise).resolves.toBe(decision);

        const metadata = createPQColorMetadata();
        expect(registry.isAuthorized(firstHarness.device, TARGET_FORMAT, metadata, 'I420P10')).toBe(true);
        expect(registry.isAuthorized(secondHarness.device, TARGET_FORMAT, metadata, 'I420P10')).toBe(false);
        expect(registry.isAuthorized(firstHarness.device, OTHER_TARGET_FORMAT, metadata, 'I420P10')).toBe(false);
        expect(registry.isAuthorized(
            firstHarness.device,
            TARGET_FORMAT,
            createPQColorMetadata({ range: 'full' }),
            'I420P10'
        )).toBe(false);

        firstHarness.lostResolve({
            message: 'test loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await Promise.resolve();
        expect(registry.getTelemetry(firstHarness.device, TARGET_FORMAT).status).toBe('unavailable');
    });

    it('authorizes only decisions rendered through the current reference shader, planned once per device', async () => {
        const harness = createDeviceHarness([]);
        const staleDecision = createAuthorizedDecision(harness.device, PQ_ROUTE_KEY, TARGET_FORMAT, 'superseded reference shader');
        const runner = {
            validate: vi.fn(() => Promise.resolve(staleDecision))
        } as RawHDRPresentationAuthorizationRunner;
        const registry = new RawHDRPresentationAuthorizationRegistry(runner);

        await registry.authorize(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);

        expect(registry.isAuthorized(harness.device, TARGET_FORMAT, createPQColorMetadata(), 'I420P10')).toBe(false);
        expect(registry.isAuthorized(harness.device, TARGET_FORMAT, createPQColorMetadata(), 'I420P10')).toBe(false);
        expect(planPresentation).toHaveBeenCalledOnce();
    });
});
