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
            sourceKind: 'external'
        },
        sourceIsDisplay: false
    }))
}));

vi.mock('webgpu-player/presentation/passes/PresentationPlanner', () => ({
    // One fused pass whose code names its signal and target, as a default chain plans
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
        usesRenderSettings: !planRequest.chain.sourceIsDisplay
    }))
}));

vi.mock('webgpu-player/presentation/passes/PresentationExecutor', () => ({
    PresentationExecutor: {
        create: vi.fn((_device: GPUDevice, plan: PresentationPlan) => Promise.resolve(passMocks.createExecutor(plan)))
    }
}));

import { createHDRToSDRRenderSettings } from 'webgpu-player/presentation/RenderSettings';
import type { ColorTriplet } from 'webgpu-player/color/ColorPipeline';
import { createDolbyVisionAuthorizationRPUVector } from 'webgpu-player/capability/vectors/DolbyVisionAuthorizationVector';
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
import {
    createExpectedExternalDolbyVisionAuthorizationObservations,
    createExpectedExternalDolbyVisionAuthorizationObservationsFromInput,
    createExpectedExternalDolbyVisionInputObservations,
    createExternalDolbyVisionShaderSignature,
    EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
    ExternalDolbyVisionPresentationAuthorizationRegistry,
    ExternalDolbyVisionPresentationAuthorizationRunner,
    type ExternalDolbyVisionAuthorizationDecision
} from 'webgpu-player/validation/ExternalDolbyVisionPresentationAuthorization';
import {
    RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
    RAW_HDR_AUTHORIZATION_VECTOR_WIDTH,
    type RawHDRVectorObservation
} from 'webgpu-player/validation/RawHDRPresentationAuthorization';

type MockBuffer = GPUBuffer & {
    bytes: Uint8Array
};

type Float16DataView = DataView & {
    setFloat16: (byteOffset: number, value: number, littleEndian?: boolean) => void
};

type MockTexture = GPUTexture & {
    label: string
};

type DeviceHarness = {
    device: GPUDevice
    queueSubmit: MockFunction
    textureDestroy: MockFunction
};

const TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const INPUT_PROBE_FORMAT: GPUTextureFormat = 'rgba16float';
const INPUT_PROBE_SIGNAL_NAME = 'external-dolby-vision-input-probe';
const VECTOR_SAMPLE_COUNT = 9;
// Within the probe's 8/1023 input bound, and far outside it
const PRESERVED_INPUT_OFFSET = 4 / 1_023;
const CORRUPTED_SIGNAL_OFFSET = 0.1;

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
    return createExpectedExternalDolbyVisionAuthorizationObservations(createDolbyVisionAuthorizationRPUVector(5), createSettings());
}

function createExpectedObservationsFromInput(
    inputObservations: readonly RawHDRVectorObservation[]
): readonly RawHDRVectorObservation[] {
    return createExpectedExternalDolbyVisionAuthorizationObservationsFromInput(
        inputObservations.map((observation: RawHDRVectorObservation): ColorTriplet => observation.linearRGB),
        createDolbyVisionAuthorizationRPUVector(5),
        createSettings()
    );
}

function createFrame(close: MockFunction): VideoFrame {
    return {
        close,
        displayHeight: RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT,
        displayWidth: RAW_HDR_AUTHORIZATION_VECTOR_WIDTH
    } as unknown as VideoFrame;
}

function createObservationMap(observations: readonly RawHDRVectorObservation[]): Map<string, ColorTriplet> {
    const observationMap = new Map<string, ColorTriplet>();
    for (const observation of observations) {
        observationMap.set(`${observation.sampleX}:${observation.sampleY}`, observation.linearRGB);
    }
    return observationMap;
}

function createDeviceHarness(
    observations: readonly RawHDRVectorObservation[],
    inputObservations: readonly RawHDRVectorObservation[] = createExpectedExternalDolbyVisionInputObservations()
): DeviceHarness {
    const observationMap = createObservationMap(observations);
    const inputObservationMap = createObservationMap(inputObservations);
    const textureDestroy = vi.fn();
    const queueSubmit = vi.fn();
    const device = {
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const bytes = new Uint8Array(Number(descriptor.size));
            return {
                bytes,
                destroy: vi.fn(),
                getMappedRange: vi.fn((offset = 0, size = bytes.byteLength) => bytes.buffer.slice(offset, offset + size)),
                mapAsync: vi.fn(() => Promise.resolve()),
                unmap: vi.fn()
            } as unknown as MockBuffer;
        }),
        createCommandEncoder: vi.fn(() => ({
            copyTextureToBuffer: vi.fn((source: GPUTexelCopyTextureInfo, destination: GPUTexelCopyBufferInfo) => {
                const origin = source.origin as GPUOrigin3DDict;
                const sampleX = Number(origin.x ?? 0);
                const sampleY = Number(origin.y ?? 0);
                const sourceTexture = source.texture as MockTexture;
                const sourceMap = sourceTexture.format === INPUT_PROBE_FORMAT ? inputObservationMap : observationMap;
                const linearRGB = sourceMap.get(`${sampleX}:${sampleY}`);
                if (!linearRGB) {
                    throw new Error('Unexpected readback coordinate');
                }
                const destinationBuffer = destination.buffer as MockBuffer;
                const byteOffset = Number(destination.offset ?? 0);
                if (sourceTexture.format === INPUT_PROBE_FORMAT) {
                    const view = new DataView(
                        destinationBuffer.bytes.buffer,
                        destinationBuffer.bytes.byteOffset,
                        destinationBuffer.bytes.byteLength
                    ) as Float16DataView;
                    view.setFloat16(byteOffset, linearRGB[0], true);
                    view.setFloat16(byteOffset + 2, linearRGB[1], true);
                    view.setFloat16(byteOffset + 4, linearRGB[2], true);
                    view.setFloat16(byteOffset + 6, 1, true);
                } else {
                    destinationBuffer.bytes[byteOffset] = Math.round(linearRGB[2] * 255);
                    destinationBuffer.bytes[byteOffset + 1] = Math.round(linearRGB[1] * 255);
                    destinationBuffer.bytes[byteOffset + 2] = Math.round(linearRGB[0] * 255);
                    destinationBuffer.bytes[byteOffset + 3] = 255;
                }
            }),
            finish: vi.fn(() => ({}))
        })),
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => ({
            createView: vi.fn(() => ({})),
            depthOrArrayLayers: 1,
            destroy: textureDestroy,
            format: descriptor.format,
            height: Number((descriptor.size as GPUExtent3DDict).height ?? 1),
            label: descriptor.label ?? '',
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
            submit: queueSubmit,
            writeBuffer: vi.fn()
        }
    } as unknown as GPUDevice;
    return {
        device,
        queueSubmit,
        textureDestroy
    };
}

function offsetFirstObservation(
    observations: readonly RawHDRVectorObservation[],
    offset: number
): readonly RawHDRVectorObservation[] {
    return observations.map((observation, observationIndex) => observationIndex === 0 ? {
        ...observation,
        linearRGB: [
            Math.min(observation.linearRGB[0] + offset, 1),
            observation.linearRGB[1],
            observation.linearRGB[2]
        ]
    } : observation);
}

describe('External Dolby Vision presentation authorization', () => {
    beforeEach(() => {
        passMocks.executors.length = 0;
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
            value: { COPY_SRC: 1, RENDER_ATTACHMENT: 2 }
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
        restoreProperty(globalThis, 'GPUBufferUsage', originalGPUBufferUsage);
        restoreProperty(globalThis, 'GPUMapMode', originalGPUMapMode);
        restoreProperty(globalThis, 'GPUTextureUsage', originalGPUTextureUsage);
        vi.restoreAllMocks();
    });

    it('authorizes the default chain and the input probe from one import of the frame', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        const close = vi.fn();
        const frame = createFrame(close);
        const runner = new ExternalDolbyVisionPresentationAuthorizationRunner((): VideoFrame => frame);

        const decision = await runner.validate(harness.device, TARGET_FORMAT);

        expect(decision).toMatchObject({
            failureReason: null,
            maximumInputChannelError: expect.any(Number),
            routeKey: EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
            sampleCount: VECTOR_SAMPLE_COUNT,
            shaderSignature: createExternalDolbyVisionShaderSignature(
                TARGET_FORMAT,
                `external-dolby-vision:${TARGET_FORMAT}`,
                `${INPUT_PROBE_SIGNAL_NAME}:${INPUT_PROBE_FORMAT}`
            ),
            status: 'authorized'
        });
        expect(createBuiltinChain).toHaveBeenCalledWith({
            hdrOutput: false,
            route: 'external-dolby-vision',
            settings: createSettings()
        });
        const planRequests = vi.mocked(planPresentation).mock.calls.map((call: [PlanRequest]): PlanRequest => call[0]);
        expect(planRequests.map((planRequest: PlanRequest): GPUTextureFormat => planRequest.output.format))
            .toEqual([ INPUT_PROBE_FORMAT, TARGET_FORMAT ]);
        expect(planRequests[0]).toMatchObject({
            chain: {
                colorFunctions: [],
                signal: {
                    entryPoint: 'recoverExternalDolbyVisionBaseSignal',
                    name: INPUT_PROBE_SIGNAL_NAME,
                    resources: [ 'external-texture', 'sampler-linear' ],
                    sourceKind: 'external'
                },
                sourceIsDisplay: true
            },
            facts: { hdrSource: false, outputHeight: RAW_HDR_AUTHORIZATION_VECTOR_HEIGHT },
            passes: []
        });
        expect(planRequests[1]).toMatchObject({
            facts: { hdrOutput: false, hdrSource: true, outputWidth: RAW_HDR_AUTHORIZATION_VECTOR_WIDTH },
            passes: []
        });

        expect(passMocks.executors).toHaveLength(2);
        const [ outputExecutor, inputProbeExecutor ] = passMocks.executors;
        expect(outputExecutor.writeRenderSettings).toHaveBeenCalledOnce();
        expect(inputProbeExecutor.writeRenderSettings).not.toHaveBeenCalled();
        expect(new Uint8Array(outputExecutor.writeDolbyVisionRPU.mock.calls[0][0] as ArrayBuffer))
            .toEqual(new Uint8Array(createDolbyVisionAuthorizationRPUVector(5)));
        for (const executor of passMocks.executors) {
            expect(executor.encode).toHaveBeenCalledOnce();
            expect((executor.encode.mock.calls[0][1] as PresentationFrameInput).source)
                .toEqual({ kind: 'external', source: frame });
            expect(executor.destroy).toHaveBeenCalledOnce();
        }
        // The probe and the output render in one submission before the two readbacks
        expect(harness.queueSubmit.mock.calls[0][0]).toHaveLength(2);
        expect(close).toHaveBeenCalledOnce();
        expect(harness.textureDestroy).toHaveBeenCalledTimes(2);
    });

    it('drives the output reference from bounded browser-recovered input', async () => {
        const recoveredInput = offsetFirstObservation(createExpectedExternalDolbyVisionInputObservations(), PRESERVED_INPUT_OFFSET);
        const harness = createDeviceHarness(createExpectedObservationsFromInput(recoveredInput), recoveredInput);
        const runner = new ExternalDolbyVisionPresentationAuthorizationRunner((): VideoFrame => createFrame(vi.fn()));

        await expect(runner.validate(harness.device, TARGET_FORMAT)).resolves.toMatchObject({
            failureReason: null,
            maximumInputChannelError: expect.any(Number),
            status: 'authorized'
        });
    });

    it('rejects browser-recovered input outside the 10-bit preservation bound', async () => {
        const inputObservations = offsetFirstObservation(createExpectedExternalDolbyVisionInputObservations(), CORRUPTED_SIGNAL_OFFSET);
        const harness = createDeviceHarness(createExpectedObservations(), inputObservations);
        const runner = new ExternalDolbyVisionPresentationAuthorizationRunner((): VideoFrame => createFrame(vi.fn()));

        await expect(runner.validate(harness.device, TARGET_FORMAT)).resolves.toMatchObject({
            failureReason: 'input-mismatch',
            maximumChannelError: null,
            maximumInputChannelError: expect.any(Number),
            status: 'rejected'
        });
    });

    it('rejects a bounded pixel mismatch and still closes the frame', async () => {
        const harness = createDeviceHarness(offsetFirstObservation(createExpectedObservations(), CORRUPTED_SIGNAL_OFFSET));
        const close = vi.fn();
        const runner = new ExternalDolbyVisionPresentationAuthorizationRunner((): VideoFrame => createFrame(close));

        await expect(runner.validate(harness.device, TARGET_FORMAT)).resolves.toMatchObject({
            failureReason: 'pixel-mismatch',
            status: 'rejected'
        });
        expect(close).toHaveBeenCalledOnce();
    });

    it('classifies a frame the output executor cannot import and closes the frame', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        // The output executor is created first, and encodes after the input probe
        vi.mocked(PresentationExecutor.create).mockImplementationOnce((_device: GPUDevice, plan: PresentationPlan) => {
            const executor = passMocks.createExecutor(plan);
            executor.encode.mockImplementation(() => {
                throw new Error('simulated import failure');
            });
            return Promise.resolve(executor as unknown as PresentationExecutor);
        });
        const close = vi.fn();
        const runner = new ExternalDolbyVisionPresentationAuthorizationRunner((): VideoFrame => createFrame(close));

        await expect(runner.validate(harness.device, TARGET_FORMAT)).resolves.toMatchObject({
            failureReason: 'frame-import-failed',
            status: 'rejected'
        });
        expect(close).toHaveBeenCalledOnce();
        for (const executor of passMocks.executors) {
            expect(executor.destroy).toHaveBeenCalledOnce();
        }
    });

    it('deduplicates exact-device authorization and exposes settled state', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        const runner = new ExternalDolbyVisionPresentationAuthorizationRunner((): VideoFrame => createFrame(vi.fn()));
        const validate = vi.spyOn(runner, 'validate');
        const registry = new ExternalDolbyVisionPresentationAuthorizationRegistry(runner);

        const firstDecision = registry.authorize(harness.device, TARGET_FORMAT);
        const secondDecision = registry.authorize(harness.device, TARGET_FORMAT);
        expect(secondDecision).toBe(firstDecision);
        expect(registry.getTelemetry(harness.device, TARGET_FORMAT).status).toBe('pending');

        const decision: ExternalDolbyVisionAuthorizationDecision = await firstDecision;
        expect(decision.status).toBe('authorized');
        expect(validate).toHaveBeenCalledOnce();
        expect(registry.isAuthorized(harness.device, TARGET_FORMAT)).toBe(true);
        expect(registry.isAuthorized(createDeviceHarness(createExpectedObservations()).device, TARGET_FORMAT)).toBe(false);
        expect(registry.getTelemetry(harness.device, TARGET_FORMAT)).toMatchObject({
            status: 'authorized',
            targetFormat: TARGET_FORMAT
        });
    });

    it('rejects unsupported targets before constructing a frame', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        const createFrameFactory = vi.fn(() => createFrame(vi.fn()));
        const runner = new ExternalDolbyVisionPresentationAuthorizationRunner(createFrameFactory);

        await expect(runner.validate(harness.device, INPUT_PROBE_FORMAT)).resolves.toMatchObject({
            failureReason: 'target-format-unsupported',
            status: 'rejected'
        });
        expect(createFrameFactory).not.toHaveBeenCalled();
        expect(PresentationExecutor.create).not.toHaveBeenCalled();
    });

    it('includes both reference shaders and the target in the stable signature', () => {
        expect(createExternalDolbyVisionShaderSignature('bgra8unorm', 'shader', 'input')).toBe(
            createExternalDolbyVisionShaderSignature('bgra8unorm', 'shader', 'input')
        );
        expect(createExternalDolbyVisionShaderSignature('bgra8unorm', 'shader', 'input')).not.toBe(
            createExternalDolbyVisionShaderSignature('rgba8unorm', 'shader', 'input')
        );
        expect(createExternalDolbyVisionShaderSignature('bgra8unorm', 'shader', 'input-a')).not.toBe(
            createExternalDolbyVisionShaderSignature('bgra8unorm', 'shader', 'input-b')
        );
        expect(createExternalDolbyVisionShaderSignature('bgra8unorm', 'shader-a', 'input')).not.toBe(
            createExternalDolbyVisionShaderSignature('bgra8unorm', 'shader-b', 'input')
        );
    });
});
