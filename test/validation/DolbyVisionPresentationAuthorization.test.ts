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
    const state = {
        encodeCount: 0,
        executors: [] as MockExecutor[]
    };
    return {
        createExecutor(plan: PresentationPlan): MockExecutor {
            const executor: MockExecutor = {
                destroy: vi.fn(),
                // Each encode renders one scenario, which the readback harness follows
                encode: vi.fn((): void => {
                    state.encodeCount += 1;
                }),
                plan,
                writeDolbyVisionRPU: vi.fn(),
                writeRenderSettings: vi.fn()
            };
            state.executors.push(executor);
            return executor;
        },
        state
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
    createHDRToSDRRenderSettings
} from 'webgpu-player/presentation/RenderSettings';
import { processEncodedYUV, type ColorTriplet } from 'webgpu-player/color/ColorPipeline';
import { decodeDolbyVisionRPUSnapshot } from 'webgpu-player/video/dolby-vision/DolbyVisionRPUParser';
import { createDolbyVisionAuthorizationRPUVector } from 'webgpu-player/capability/vectors/DolbyVisionAuthorizationVector';
import { createBuiltinChain } from 'webgpu-player/presentation/passes/builtin/BuiltinChains';
import type {
    BuiltinChain,
    BuiltinChainConfiguration,
    PlanRequest,
    PresentationFrameInput,
    PresentationFrameSource,
    PresentationPlan,
    RawDolbyVisionFrameFormat
} from 'webgpu-player/presentation/passes/PassTypes';
import { PresentationExecutor } from 'webgpu-player/presentation/passes/PresentationExecutor';
import type { TransferableRawVideoFrame } from 'webgpu-player/video/RawVideoFrameCopy';
import {
    createDolbyVisionShaderSignature,
    createExpectedDolbyVisionAuthorizationObservations,
    createExpectedDolbyVisionFELAuthorizationObservations,
    DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
    DOLBY_VISION_PROFILE4_AUTHORIZATION_ROUTE_KEY,
    DOLBY_VISION_PROFILE4_FEL_AUTHORIZATION_ROUTE_KEY,
    DOLBY_VISION_PROFILE7_AUTHORIZATION_ROUTE_KEY,
    DOLBY_VISION_PROFILE7_FEL_AUTHORIZATION_ROUTE_KEY,
    DolbyVisionPresentationAuthorizationRegistry,
    DolbyVisionPresentationAuthorizationRunner,
    type DolbyVisionAuthorizationDecision
} from 'webgpu-player/validation/DolbyVisionPresentationAuthorization';
import {
    createRawHDRAuthorizationVector,
    RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
    RAW_HDR_AUTHORIZATION_VECTOR_WIDTH,
    sampleRawI420P10Frame,
    type RawHDRAuthorizationRouteKey,
    type RawHDRVectorObservation
} from 'webgpu-player/validation/RawHDRPresentationAuthorization';
import { createSDRColorMetadata } from 'webgpu-player/color/ColorMetadata';

type MockBuffer = GPUBuffer & {
    bytes: Uint8Array
};

type DeviceHarness = {
    bufferDescriptors: GPUBufferDescriptor[]
    device: GPUDevice
    textureDestroy: MockFunction
};

type PlanesFrameSource = Extract<PresentationFrameSource, { kind: 'planes' }>;

const TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const SINGLE_SCENARIO_SAMPLE_COUNT = 9;
const DUAL_SCENARIO_SAMPLE_COUNT = 18;
// The size the reduced-resolution FEL probe composes beside the 16x8 BL vector
const ENHANCEMENT_LAYER_WIDTH = 8;
const ENHANCEMENT_LAYER_HEIGHT = 4;

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

function createSettings() {
    return createHDRToSDRRenderSettings({
        toneMapping: { inputPeakNits: 4_000 }
    });
}

function createExpectedObservations(): readonly RawHDRVectorObservation[] {
    return createExpectedDolbyVisionAuthorizationObservations(createDolbyVisionAuthorizationRPUVector(), createSettings());
}

function createDeviceHarness(...observationSets: Array<readonly RawHDRVectorObservation[]>): DeviceHarness {
    const observationMaps: Array<Map<string, ColorTriplet>> = [];
    for (const observations of observationSets) {
        const observationMap = new Map<string, ColorTriplet>();
        for (const observation of observations) {
            observationMap.set(
                `${observation.sampleX}:${observation.sampleY}`,
                observation.linearRGB
            );
        }
        observationMaps.push(observationMap);
    }
    const textureDestroy = vi.fn();
    const bufferDescriptors: GPUBufferDescriptor[] = [];
    const device = {
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            bufferDescriptors.push(descriptor);
            const bytes = new Uint8Array(Number(descriptor.size));
            return {
                bytes,
                destroy: vi.fn(),
                getMappedRange: vi.fn((offset = 0, size = bytes.byteLength) => (
                    bytes.buffer.slice(offset, offset + size)
                )),
                mapAsync: vi.fn(() => Promise.resolve()),
                unmap: vi.fn()
            } as unknown as MockBuffer;
        }),
        createCommandEncoder: vi.fn(() => ({
            copyTextureToBuffer: vi.fn((
                source: GPUTexelCopyTextureInfo,
                destination: GPUTexelCopyBufferInfo
            ) => {
                const origin = source.origin as GPUOrigin3DDict;
                const sampleX = Number(origin.x ?? 0);
                const sampleY = Number(origin.y ?? 0);
                const renderIndex = Math.max(passMocks.state.encodeCount - 1, 0);
                const observationMap = observationMaps[
                    Math.min(renderIndex, observationMaps.length - 1)
                ];
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
        lost: new Promise<GPUDeviceLostInfo>(() => undefined),
        popErrorScope: vi.fn(() => Promise.resolve(null)),
        pushErrorScope: vi.fn(),
        queue: {
            onSubmittedWorkDone: vi.fn(() => Promise.resolve()),
            submit: vi.fn(),
            writeBuffer: vi.fn()
        }
    } as unknown as GPUDevice;
    return {
        bufferDescriptors,
        device,
        textureDestroy
    };
}

function getOnlyExecutor(): MockExecutor {
    expect(passMocks.state.executors).toHaveLength(1);
    return passMocks.state.executors[0];
}

/** Returns the plane sources an authorization encoded, one per rendered scenario. */
function getEncodedSources(executor: MockExecutor): PlanesFrameSource[] {
    return executor.encode.mock.calls.map((call: unknown[]): PlanesFrameSource => (
        (call[1] as PresentationFrameInput).source as PlanesFrameSource
    ));
}

/** Returns the RPU vectors an authorization wrote, one per rendered scenario. */
function getWrittenRPUVectors(executor: MockExecutor): Uint8Array[] {
    return executor.writeDolbyVisionRPU.mock.calls.map((call: unknown[]): Uint8Array => new Uint8Array(call[0] as ArrayBuffer));
}

function getFrameGeometry(frame: TransferableRawVideoFrame): [string, number, number] {
    return [ frame.format, frame.codedWidth, frame.codedHeight ];
}

function mutateFirstObservation(observations: readonly RawHDRVectorObservation[]): readonly RawHDRVectorObservation[] {
    return observations.map((observation, observationIndex) => observationIndex === 0 ? {
        ...observation,
        linearRGB: [
            Math.min(observation.linearRGB[0] + 0.1, 1),
            observation.linearRGB[1],
            observation.linearRGB[2]
        ]
    } : observation);
}

describe('Dolby Vision presentation authorization', () => {
    beforeEach(() => {
        passMocks.state.encodeCount = 0;
        passMocks.state.executors.length = 0;
        Object.defineProperty(globalThis, 'GPUBufferUsage', {
            configurable: true,
            // WebGPU defines these external names
            // eslint-disable-next-line @typescript-eslint/naming-convention
            value: { COPY_DST: 1, MAP_READ: 2, STORAGE: 4, UNIFORM: 8 }
        });
        Object.defineProperty(globalThis, 'GPUMapMode', {
            configurable: true,
            value: { READ: 1 }
        });
        Object.defineProperty(globalThis, 'GPUTextureUsage', {
            configurable: true,
            // WebGPU defines these external names
            // eslint-disable-next-line @typescript-eslint/naming-convention
            value: { COPY_DST: 1, COPY_SRC: 2, RENDER_ATTACHMENT: 4, TEXTURE_BINDING: 8 }
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
        restoreProperty(globalThis, 'GPUBufferUsage', originalGPUBufferUsage);
        restoreProperty(globalThis, 'GPUMapMode', originalGPUMapMode);
        restoreProperty(globalThis, 'GPUTextureUsage', originalGPUTextureUsage);
        vi.restoreAllMocks();
    });

    it('builds a schema-valid vector covering polynomial and MMR mapping', () => {
        const firstVector = createDolbyVisionAuthorizationRPUVector();
        const secondVector = createDolbyVisionAuthorizationRPUVector();
        const snapshot = decodeDolbyVisionRPUSnapshot(firstVector);

        expect(snapshot).toMatchObject({
            baseLayerBitDepth: 10,
            layerMode: 'single-layer',
            profile: 8,
            vdrBitDepth: 12
        });
        expect(snapshot.components.map(component => component.mappingMethod)).toEqual([
            'polynomial',
            'mmr',
            'mmr'
        ]);
        expect(snapshot.components.map(component => component.mmrVectorCount)).toEqual([
            0,
            6,
            6
        ]);
        expect(secondVector).not.toBe(firstVector);
        expect(new Uint8Array(secondVector)).toEqual(new Uint8Array(firstVector));
    });

    it('builds distinct schema-valid Profile 7 MEL and FEL vectors', () => {
        const melSnapshot = decodeDolbyVisionRPUSnapshot(createDolbyVisionAuthorizationRPUVector(7, 'mel'));
        const felSnapshot = decodeDolbyVisionRPUSnapshot(createDolbyVisionAuthorizationRPUVector(7, 'fel'));

        expect(melSnapshot).toMatchObject({
            disableResidual: false,
            layerMode: 'mel',
            nlqActive: false,
            profile: 7
        });
        expect(felSnapshot).toMatchObject({
            disableResidual: false,
            layerMode: 'fel',
            nlqActive: true,
            profile: 7
        });
        expect(melSnapshot.nlq.every(component => component.deadzoneSlope === 0)).toBe(true);
        expect(felSnapshot.nlq.every(component => component.deadzoneSlope > 0)).toBe(true);
    });

    it('authorizes exact single-layer output and writes its RPU through the default chain', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        const runner = new DolbyVisionPresentationAuthorizationRunner();

        const decision = await runner.validate(harness.device, TARGET_FORMAT);

        expect(decision).toMatchObject({
            failureReason: null,
            routeKey: DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
            sampleCount: SINGLE_SCENARIO_SAMPLE_COUNT,
            shaderSignature: createDolbyVisionShaderSignature(TARGET_FORMAT, `raw-dolby-vision:${TARGET_FORMAT}`),
            status: 'authorized'
        });
        expect(createBuiltinChain).toHaveBeenCalledWith({
            felReconstruction: false,
            format: 'I420P10',
            hdrOutput: false,
            profile: 8,
            route: 'raw-dolby-vision',
            settings: createSettings()
        });
        const executor = getOnlyExecutor();
        expect(executor.plan.output).toEqual({ colorSpace: 'srgb', format: TARGET_FORMAT, toneMapping: 'standard' });
        expect(executor.writeRenderSettings).toHaveBeenCalledOnce();
        expect(getWrittenRPUVectors(executor)).toEqual([ new Uint8Array(createDolbyVisionAuthorizationRPUVector()) ]);
        expect(getEncodedSources(executor).map(source => source.enhancementFrame)).toEqual([ null ]);
        expect(executor.destroy).toHaveBeenCalledOnce();
        expect(harness.textureDestroy).toHaveBeenCalledOnce();
    });

    it('authorizes both Profile 7 MEL reconstruction and FEL HDR10-base fallback', async () => {
        const settings = createSettings();
        const melRPUData = createDolbyVisionAuthorizationRPUVector(7, 'mel');
        const felRPUData = createDolbyVisionAuthorizationRPUVector(7, 'fel');
        const harness = createDeviceHarness(
            createExpectedDolbyVisionAuthorizationObservations(melRPUData, settings),
            createExpectedDolbyVisionAuthorizationObservations(felRPUData, settings, 'fel-hdr10-base')
        );
        const runner = new DolbyVisionPresentationAuthorizationRunner('profile7-base');

        const decision = await runner.validate(harness.device, TARGET_FORMAT);

        expect(decision).toMatchObject({
            failureReason: null,
            routeKey: DOLBY_VISION_PROFILE7_AUTHORIZATION_ROUTE_KEY,
            sampleCount: DUAL_SCENARIO_SAMPLE_COUNT,
            status: 'authorized'
        });
        expect(getOnlyExecutor().encode).toHaveBeenCalledTimes(2);
    });

    it('separately authorizes reduced-resolution Profile 7 FEL composition', async () => {
        const harness = createDeviceHarness(createExpectedDolbyVisionFELAuthorizationObservations(createSettings()));
        const runner = new DolbyVisionPresentationAuthorizationRunner('profile7-fel');

        const decision = await runner.validate(harness.device, TARGET_FORMAT);

        expect(decision).toMatchObject({
            failureReason: null,
            routeKey: DOLBY_VISION_PROFILE7_FEL_AUTHORIZATION_ROUTE_KEY,
            sampleCount: SINGLE_SCENARIO_SAMPLE_COUNT,
            status: 'authorized'
        });
        expect(createBuiltinChain).toHaveBeenCalledWith(expect.objectContaining({ felReconstruction: true, profile: 7 }));
        const [ source ] = getEncodedSources(getOnlyExecutor());
        expect(source.enhancementFrame).not.toBeNull();
        expect(source.enhancementFrame?.data).toBe(source.frame.data);
    });

    it('rejects a bounded pixel mismatch', async () => {
        const harness = createDeviceHarness(mutateFirstObservation(createExpectedObservations()));
        const runner = new DolbyVisionPresentationAuthorizationRunner();

        await expect(runner.validate(harness.device, TARGET_FORMAT)).resolves.toMatchObject({
            failureReason: 'pixel-mismatch',
            status: 'rejected'
        });
        expect(getOnlyExecutor().destroy).toHaveBeenCalledOnce();
    });

    it('rejects unsupported targets before allocating resources', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        const runner = new DolbyVisionPresentationAuthorizationRunner();

        await expect(runner.validate(harness.device, 'rgba16float')).resolves.toMatchObject({
            failureReason: 'target-format-unsupported',
            status: 'rejected'
        });
        expect(harness.bufferDescriptors).toHaveLength(0);
        expect(PresentationExecutor.create).not.toHaveBeenCalled();
    });

    it('deduplicates exact-device authorization and exposes only settled state', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        const runner = new DolbyVisionPresentationAuthorizationRunner();
        const validate = vi.spyOn(runner, 'validate');
        const registry = new DolbyVisionPresentationAuthorizationRegistry(runner);

        const firstDecision = registry.authorize(harness.device, TARGET_FORMAT);
        const secondDecision = registry.authorize(harness.device, TARGET_FORMAT);
        expect(secondDecision).toBe(firstDecision);
        expect(registry.getTelemetry(harness.device, TARGET_FORMAT).status).toBe('pending');

        const decision: DolbyVisionAuthorizationDecision = await firstDecision;
        expect(decision.status).toBe('authorized');
        expect(validate).toHaveBeenCalledTimes(1);
        expect(registry.isAuthorized(harness.device, TARGET_FORMAT, 'I420P10')).toBe(true);
        expect(registry.isAuthorized(harness.device, TARGET_FORMAT, 'I420P12')).toBe(false);
        expect(registry.getTelemetry(harness.device, TARGET_FORMAT)).toMatchObject({
            status: 'authorized',
            targetFormat: TARGET_FORMAT
        });
    });

    it.each([ 8, 10, 12 ])('builds dual-layer Profile 4 MEL and FEL vectors at %i bits', bitDepth => {
        const melSnapshot = decodeDolbyVisionRPUSnapshot(createDolbyVisionAuthorizationRPUVector(4, 'mel', bitDepth));
        const felSnapshot = decodeDolbyVisionRPUSnapshot(createDolbyVisionAuthorizationRPUVector(4, 'fel', bitDepth));

        expect(melSnapshot).toMatchObject({ baseLayerBitDepth: bitDepth, layerMode: 'mel', profile: 4 });
        expect(felSnapshot).toMatchObject({ baseLayerBitDepth: bitDepth, layerMode: 'fel', profile: 4 });
        expect(() => createDolbyVisionAuthorizationRPUVector(4, 'single-layer')).toThrow(TypeError);
    });

    it('authorizes Profile 4 MEL reconstruction and its FEL SDR-base fallback', async () => {
        const settings = createSettings();
        const harness = createDeviceHarness(
            createExpectedDolbyVisionAuthorizationObservations(
                createDolbyVisionAuthorizationRPUVector(4, 'mel'),
                settings
            ),
            createExpectedDolbyVisionAuthorizationObservations(
                createDolbyVisionAuthorizationRPUVector(4, 'fel'),
                settings,
                'fel-sdr-base'
            )
        );
        const runner = new DolbyVisionPresentationAuthorizationRunner('profile4-base');

        await expect(runner.validate(harness.device, TARGET_FORMAT)).resolves.toMatchObject({
            failureReason: null,
            routeKey: DOLBY_VISION_PROFILE4_AUTHORIZATION_ROUTE_KEY,
            sampleCount: DUAL_SCENARIO_SAMPLE_COUNT,
            status: 'authorized'
        });
        expect(createBuiltinChain).toHaveBeenCalledWith(expect.objectContaining({ felReconstruction: false, profile: 4 }));
    });

    it('separately authorizes Profile 4 FEL composition', async () => {
        const harness = createDeviceHarness(createExpectedDolbyVisionFELAuthorizationObservations(createSettings(), 4));
        const runner = new DolbyVisionPresentationAuthorizationRunner('profile4-fel');

        await expect(runner.validate(harness.device, TARGET_FORMAT)).resolves.toMatchObject({
            failureReason: null,
            routeKey: DOLBY_VISION_PROFILE4_FEL_AUTHORIZATION_ROUTE_KEY,
            status: 'authorized'
        });
        expect(createBuiltinChain).toHaveBeenCalledWith(expect.objectContaining({ felReconstruction: true, profile: 4 }));
        expect(getEncodedSources(getOnlyExecutor())[0].enhancementFrame).not.toBeNull();
    });

    it('presents the Profile 4 SDR base exactly, without tone mapping or dither', () => {
        const frame = createRawHDRAuthorizationVector('I420P10:bt2020-ncl:bt2020:limited:pq');
        const observations = createExpectedDolbyVisionAuthorizationObservations(
            createDolbyVisionAuthorizationRPUVector(4, 'fel'),
            createHDRToSDRRenderSettings(),
            'fel-sdr-base',
            frame
        );

        for (const observation of observations) {
            const rawSignal = sampleRawI420P10Frame(frame, observation.sampleX, observation.sampleY);
            const encodedRGB = processEncodedYUV(
                [ rawSignal[0] / 1_023, rawSignal[1] / 1_023, rawSignal[2] / 1_023 ],
                createSDRColorMetadata({ bitDepth: 10 }),
                createDefaultRenderSettings()
            );
            for (let componentIndex = 0; componentIndex < 3; componentIndex += 1) {
                expect(observation.linearRGB[componentIndex]).toBeCloseTo(
                    Math.min(Math.max(encodedRGB[componentIndex], 0), 1),
                    12
                );
            }
        }
    });

    it.each([
        [ 'I420', 'I420:bt709:bt709:limited:sdr' ],
        [ 'I422', 'I422:bt709:bt709:limited:sdr' ],
        [ 'I420P12', 'I420P12:bt2020-ncl:bt2020:limited:pq' ],
        [ 'I422P10', 'I422P10:bt2020-ncl:bt2020:limited:pq' ],
        [ 'I444P12', 'I444P12:bt2020-ncl:bt2020:limited:pq' ]
    ] as const)('authorizes single-layer reconstruction over %s planes', async (format, vectorKey) => {
        const settings = createSettings();
        const frame = createRawHDRAuthorizationVector(vectorKey as RawHDRAuthorizationRouteKey);
        const harness = createDeviceHarness(createExpectedDolbyVisionAuthorizationObservations(
            createDolbyVisionAuthorizationRPUVector(8, 'single-layer', frame.bitDepth),
            settings,
            'reconstruct',
            frame
        ));
        const runner = new DolbyVisionPresentationAuthorizationRunner(
            'single-layer',
            format as RawDolbyVisionFrameFormat
        );
        const registry = new DolbyVisionPresentationAuthorizationRegistry(runner);

        await expect(registry.authorize(harness.device, TARGET_FORMAT)).resolves.toMatchObject({
            routeKey: `${format}:dovi-rpu-v1`,
            status: 'authorized'
        });
        expect(getEncodedSources(getOnlyExecutor()).map(source => getFrameGeometry(source.frame))).toEqual([
            [ format, RAW_HDR_AUTHORIZATION_VECTOR_WIDTH, RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT ]
        ]);
        expect(registry.isAuthorized(harness.device, TARGET_FORMAT, format)).toBe(true);
        expect(registry.isAuthorized(harness.device, TARGET_FORMAT, 'I420P10')).toBe(false);
    });

    it.each([
        [ 'profile4-base', DOLBY_VISION_PROFILE4_AUTHORIZATION_ROUTE_KEY, 'I420', 'I420:dovi-profile4-base-v1' ],
        [ 'profile4-fel', DOLBY_VISION_PROFILE4_FEL_AUTHORIZATION_ROUTE_KEY, 'I422P10', 'I422P10:dovi-profile4-fel-v1' ],
        [ 'profile7-base', DOLBY_VISION_PROFILE7_AUTHORIZATION_ROUTE_KEY, 'I444P12', 'I444P12:dovi-profile7-base-v1' ],
        [ 'profile7-fel', DOLBY_VISION_PROFILE7_FEL_AUTHORIZATION_ROUTE_KEY, 'I420P12', 'I420P12:dovi-profile7-fel-v1' ]
    ] as const)(
        'keys the dual-layer %s route by its BL format, I420P10 by default',
        (route, defaultRouteKey, format, routeKey) => {
            expect(defaultRouteKey.startsWith('I420P10:')).toBe(true);
            expect(new DolbyVisionPresentationAuthorizationRunner(route).routeKey).toBe(defaultRouteKey);
            expect(new DolbyVisionPresentationAuthorizationRunner(route, format).routeKey).toBe(routeKey);
        }
    );

    it('keeps the I420P10 dual-layer vectors at the default 10-bit RPU vectors', async () => {
        const settings = createSettings();
        const harness = createDeviceHarness(
            createExpectedDolbyVisionAuthorizationObservations(
                createDolbyVisionAuthorizationRPUVector(7, 'mel'),
                settings
            ),
            createExpectedDolbyVisionAuthorizationObservations(
                createDolbyVisionAuthorizationRPUVector(7, 'fel'),
                settings,
                'fel-hdr10-base'
            )
        );
        const runner = new DolbyVisionPresentationAuthorizationRunner('profile7-base');

        await expect(runner.validate(harness.device, TARGET_FORMAT)).resolves.toMatchObject({
            status: 'authorized'
        });

        expect(getWrittenRPUVectors(getOnlyExecutor())).toEqual([
            new Uint8Array(createDolbyVisionAuthorizationRPUVector(7, 'mel')),
            new Uint8Array(createDolbyVisionAuthorizationRPUVector(7, 'fel'))
        ]);
        expect(createExpectedDolbyVisionFELAuthorizationObservations(createHDRToSDRRenderSettings(), 4))
            .toEqual(createExpectedDolbyVisionFELAuthorizationObservations(
                createHDRToSDRRenderSettings(),
                4,
                'I420P10'
            ));
    });

    describe.each([
        [ 'I420', 'I420:bt709:bt709:limited:sdr', 8 ],
        [ 'I420P10', 'I420P10:bt2020-ncl:bt2020:limited:pq', 10 ],
        [ 'I422P10', 'I422P10:bt2020-ncl:bt2020:limited:pq', 10 ],
        [ 'I444P12', 'I444P12:bt2020-ncl:bt2020:limited:pq', 12 ]
    ] as const)('dual-layer authorization over %s BL planes', (
        format,
        vectorKey,
        bitDepth
    ) => {
        const settings = createSettings();
        const baseGeometry: [string, number, number] = [
            format,
            RAW_HDR_AUTHORIZATION_VECTOR_WIDTH,
            RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT
        ];

        it.each([
            [ 4, 'profile4-base', 'fel-sdr-base' ],
            [ 7, 'profile7-base', 'fel-hdr10-base' ]
        ] as const)(
            'authorizes Profile %i MEL reconstruction and the FEL base fallback through the default chain',
            async (profile, route, fallbackMode) => {
                const frame = createRawHDRAuthorizationVector(vectorKey);
                const melRPUData = createDolbyVisionAuthorizationRPUVector(profile, 'mel', bitDepth);
                const felRPUData = createDolbyVisionAuthorizationRPUVector(profile, 'fel', bitDepth);
                const harness = createDeviceHarness(
                    createExpectedDolbyVisionAuthorizationObservations(melRPUData, settings, 'reconstruct', frame),
                    createExpectedDolbyVisionAuthorizationObservations(felRPUData, settings, fallbackMode, frame)
                );
                const runner = new DolbyVisionPresentationAuthorizationRunner(route, format);
                const registry = new DolbyVisionPresentationAuthorizationRegistry(runner);

                await expect(registry.authorize(harness.device, TARGET_FORMAT)).resolves.toMatchObject({
                    failureReason: null,
                    routeKey: `${format}:dovi-profile${profile}-base-v1`,
                    sampleCount: DUAL_SCENARIO_SAMPLE_COUNT,
                    status: 'authorized'
                });
                expect(createBuiltinChain).toHaveBeenCalledWith({
                    felReconstruction: false,
                    format,
                    hdrOutput: false,
                    profile,
                    route: 'raw-dolby-vision',
                    settings
                });
                const executor = getOnlyExecutor();
                const sources = getEncodedSources(executor);
                expect(sources.map(source => getFrameGeometry(source.frame))).toEqual([ baseGeometry, baseGeometry ]);
                expect(sources.map(source => source.enhancementFrame)).toEqual([ null, null ]);
                // Both RPU vectors declare the BL format's own depth, as the per-frame checks require
                expect(getWrittenRPUVectors(executor)).toEqual([
                    new Uint8Array(melRPUData),
                    new Uint8Array(felRPUData)
                ]);
                expect(decodeDolbyVisionRPUSnapshot(felRPUData)).toMatchObject({
                    baseLayerBitDepth: bitDepth,
                    layerMode: 'fel',
                    profile
                });
                expect(registry.isAuthorized(harness.device, TARGET_FORMAT, format)).toBe(true);
                expect(registry.isAuthorized(
                    harness.device,
                    TARGET_FORMAT,
                    format === 'I420P10' ? 'I420P12' : 'I420P10'
                )).toBe(false);
            }
        );

        it.each([
            [ 4, 'profile4-fel' ],
            [ 7, 'profile7-fel' ]
        ] as const)(
            'authorizes Profile %i FEL composition with a half-resolution I420P10 EL',
            async (profile, route) => {
                const harness = createDeviceHarness(
                    createExpectedDolbyVisionFELAuthorizationObservations(settings, profile, format)
                );
                const runner = new DolbyVisionPresentationAuthorizationRunner(route, format);

                await expect(runner.validate(harness.device, TARGET_FORMAT)).resolves.toMatchObject({
                    failureReason: null,
                    routeKey: `${format}:dovi-profile${profile}-fel-v1`,
                    sampleCount: SINGLE_SCENARIO_SAMPLE_COUNT,
                    status: 'authorized'
                });
                expect(createBuiltinChain).toHaveBeenCalledWith(expect.objectContaining({
                    felReconstruction: true,
                    format,
                    profile
                }));
                const executor = getOnlyExecutor();
                const [ source ] = getEncodedSources(executor);
                expect(getFrameGeometry(source.frame)).toEqual(baseGeometry);
                expect(source.enhancementFrame && getFrameGeometry(source.enhancementFrame)).toEqual([
                    'I420P10',
                    ENHANCEMENT_LAYER_WIDTH,
                    ENHANCEMENT_LAYER_HEIGHT
                ]);
                const writtenRPUVectors = getWrittenRPUVectors(executor);
                expect(writtenRPUVectors).toHaveLength(1);
                expect(decodeDolbyVisionRPUSnapshot(writtenRPUVectors[0].buffer as ArrayBuffer)).toMatchObject({
                    baseLayerBitDepth: bitDepth,
                    enhancementLayerBitDepth: 10,
                    layerMode: 'fel',
                    profile
                });
            }
        );

        it('expects the Profile 4 SDR base exactly at the BL depth, from limited black to limited white', () => {
            const frame = createRawHDRAuthorizationVector(vectorKey);
            const observations = createExpectedDolbyVisionAuthorizationObservations(
                createDolbyVisionAuthorizationRPUVector(4, 'fel', bitDepth),
                settings,
                'fel-sdr-base',
                frame
            );
            // The first luma ramp row runs from code 16 to 235, scaled to the depth, over neutral chroma
            const blackObservation = observations.find(observation => observation.sampleX === 0 && observation.sampleY === 0);
            const whiteObservation = observations.find(observation => observation.sampleX === 15 && observation.sampleY === 0);

            for (let componentIndex = 0; componentIndex < 3; componentIndex += 1) {
                expect(blackObservation?.linearRGB[componentIndex]).toBeCloseTo(0, 9);
                expect(whiteObservation?.linearRGB[componentIndex]).toBeCloseTo(1, 9);
            }
        });
    });

    it('includes the vector and target in the stable signature', () => {
        expect(createDolbyVisionShaderSignature('bgra8unorm', 'shader')).toBe(
            createDolbyVisionShaderSignature('bgra8unorm', 'shader')
        );
        expect(createDolbyVisionShaderSignature('bgra8unorm', 'shader')).not.toBe(
            createDolbyVisionShaderSignature('rgba8unorm', 'shader')
        );
        expect(createDolbyVisionShaderSignature('bgra8unorm', 'shader')).not.toBe(
            createDolbyVisionShaderSignature('bgra8unorm', 'other shader')
        );
    });
});
