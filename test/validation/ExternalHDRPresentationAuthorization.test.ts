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
    createHDRToSDRRenderSettings,
    RENDER_SETTINGS_UNIFORM_BYTE_LENGTH
} from 'webgpu-player/presentation/RenderSettings';
import { createHLGColorMetadata, createPQColorMetadata } from 'webgpu-player/color/ColorMetadata';
import type { ColorTriplet } from 'webgpu-player/color/ColorPipeline';
import {
    EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT,
    EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH
} from 'webgpu-player/capability/vectors/ExternalHDRAuthorizationVector';
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
import { parseHEVCSPS } from 'webgpu-player/video/hevc/HEVCSPSParser';
import {
    createExpectedExternalHDRAuthorizationObservations,
    createExternalHDRAuthorizationFrame,
    createExternalHDRShaderSignature,
    ExternalHDRPresentationAuthorizationRegistry,
    ExternalHDRPresentationAuthorizationRunner,
    type ExternalHDRAuthorizationRouteKey,
    type ExternalHDRRouteAuthorizationDecision
} from 'webgpu-player/validation/ExternalHDRPresentationAuthorization';
import type { RawHDRVectorObservation } from 'webgpu-player/validation/RawHDRPresentationAuthorization';

type MockBuffer = GPUBuffer & {
    bytes: Uint8Array
};

type DeviceHarness = {
    device: GPUDevice
    textureDestroy: MockFunction
};

const PQ_ROUTE_KEY: ExternalHDRAuthorizationRouteKey = 'external-hevc-main10-bt709-limited:pq-v1';
const HLG_ROUTE_KEY: ExternalHDRAuthorizationRouteKey = 'external-hevc-main10-bt709-limited:hlg-v1';
const TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const AUTHORIZATION_TIMEOUT_MILLISECONDS = 5_000;
const VECTOR_SAMPLE_COUNT = 8;
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
        toneMapping: { inputPeakNits: 1_000 }
    });
}

function createExpectedObservations(routeKey: ExternalHDRAuthorizationRouteKey): readonly RawHDRVectorObservation[] {
    return createExpectedExternalHDRAuthorizationObservations(routeKey, createSettings());
}

function createFrame(close: MockFunction): VideoFrame {
    return {
        close,
        displayHeight: EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT,
        displayWidth: EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH
    } as unknown as VideoFrame;
}

function createDeviceHarness(observations: readonly RawHDRVectorObservation[]): DeviceHarness {
    const observationMap = new Map<string, ColorTriplet>();
    for (const observation of observations) {
        observationMap.set(`${observation.sampleX}:${observation.sampleY}`, observation.linearRGB);
    }
    const textureDestroy = vi.fn();
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
        device,
        textureDestroy
    };
}

function getOnlyExecutor(): MockExecutor {
    expect(passMocks.executors).toHaveLength(1);
    return passMocks.executors[0];
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

function findAnnexBNALUnit(data: Uint8Array, nalUnitType: number): Uint8Array {
    const startOffsets: number[] = [];
    for (let offset = 0; offset + 4 <= data.byteLength; offset += 1) {
        if (
            data[offset] === 0
            && data[offset + 1] === 0
            && data[offset + 2] === 0
            && data[offset + 3] === 1
        ) {
            startOffsets.push(offset);
        }
    }
    for (let startIndex = 0; startIndex < startOffsets.length; startIndex += 1) {
        const nalUnitStart = startOffsets[startIndex] + 4;
        const nalUnitEnd = startOffsets[startIndex + 1] ?? data.byteLength;
        const nalUnit = data.subarray(nalUnitStart, nalUnitEnd);
        if (((nalUnit[0] >> 1) & 0x3F) === nalUnitType) {
            return nalUnit;
        }
    }
    throw new TypeError(`Access unit has no HEVC NAL unit type ${nalUnitType}`);
}

describe('External HDR presentation authorization', () => {
    beforeEach(() => {
        passMocks.executors.length = 0;
        Object.defineProperty(globalThis, 'GPUBufferUsage', {
            configurable: true,
            // WebGPU defines these external names
            // eslint-disable-next-line @typescript-eslint/naming-convention
            value: { COPY_DST: 1, MAP_READ: 2, UNIFORM: 4 }
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
        vi.useRealTimers();
        vi.clearAllMocks();
        restoreProperty(globalThis, 'GPUBufferUsage', originalGPUBufferUsage);
        restoreProperty(globalThis, 'GPUMapMode', originalGPUMapMode);
        restoreProperty(globalThis, 'GPUTextureUsage', originalGPUTextureUsage);
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it.each([
        [ PQ_ROUTE_KEY, createPQColorMetadata() ],
        [ HLG_ROUTE_KEY, createHLGColorMetadata() ]
    ])(
        'authorizes exact output through the default chain and closes the frame for %s',
        async (routeKey, metadata) => {
            const harness = createDeviceHarness(createExpectedObservations(routeKey));
            const close = vi.fn();
            const frame = createFrame(close);
            const runner = new ExternalHDRPresentationAuthorizationRunner(async (): Promise<VideoFrame> => frame);

            const decision = await runner.validate(harness.device, TARGET_FORMAT, routeKey);

            expect(decision).toMatchObject({
                authorizedRouteKeys: [ routeKey ],
                failureReason: null,
                routeKey,
                sampleCount: VECTOR_SAMPLE_COUNT,
                shaderSignature: createExternalHDRShaderSignature(TARGET_FORMAT, routeKey, `external-hdr:${TARGET_FORMAT}`),
                status: 'authorized'
            });
            expect(createBuiltinChain).toHaveBeenCalledWith({
                hdrOutput: false,
                metadata,
                route: 'external-hdr',
                settings: createSettings()
            });
            expect(vi.mocked(planPresentation).mock.calls[0][0]).toMatchObject({
                facts: {
                    frameRate: null,
                    hdrOutput: false,
                    hdrSource: true,
                    outputHeight: EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT,
                    outputWidth: EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH,
                    sourceHeight: EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT,
                    sourceWidth: EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH
                },
                output: { colorSpace: 'srgb', format: TARGET_FORMAT, toneMapping: 'standard' },
                passes: []
            });
            const executor = getOnlyExecutor();
            expect((executor.writeRenderSettings.mock.calls[0][0] as ArrayBuffer).byteLength)
                .toBe(RENDER_SETTINGS_UNIFORM_BYTE_LENGTH);
            expect(executor.encode).toHaveBeenCalledOnce();
            expect(executor.encode.mock.calls[0][1] as PresentationFrameInput).toMatchObject({
                geometry: {
                    viewportHeight: EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT,
                    viewportWidth: EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH
                },
                newFrame: true,
                source: { kind: 'external', source: frame }
            });
            expect(close).toHaveBeenCalledOnce();
            expect(executor.destroy).toHaveBeenCalledOnce();
            expect(harness.textureDestroy).toHaveBeenCalledOnce();
        }
    );

    it('rejects a bounded pixel mismatch and still closes the frame', async () => {
        const harness = createDeviceHarness(mutateFirstObservation(createExpectedObservations(PQ_ROUTE_KEY)));
        const close = vi.fn();
        const runner = new ExternalHDRPresentationAuthorizationRunner(async (): Promise<VideoFrame> => createFrame(close));

        await expect(runner.validate(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY)).resolves.toMatchObject({
            failureReason: 'pixel-mismatch',
            status: 'rejected'
        });
        expect(close).toHaveBeenCalledOnce();
    });

    it('classifies a frame the executor cannot import and closes the frame', async () => {
        const harness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        vi.mocked(PresentationExecutor.create).mockImplementationOnce((_device: GPUDevice, plan: PresentationPlan) => {
            const executor = passMocks.createExecutor(plan);
            executor.encode.mockImplementation(() => {
                throw new Error('simulated import failure');
            });
            return Promise.resolve(executor as unknown as PresentationExecutor);
        });
        const close = vi.fn();
        const runner = new ExternalHDRPresentationAuthorizationRunner(async (): Promise<VideoFrame> => createFrame(close));

        await expect(runner.validate(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY)).resolves.toMatchObject({
            failureReason: 'frame-import-failed',
            status: 'rejected'
        });
        expect(close).toHaveBeenCalledOnce();
        expect(getOnlyExecutor().destroy).toHaveBeenCalledOnce();
    });

    it('bounds an authorization frame that never resolves', async () => {
        vi.useFakeTimers();
        const harness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const lateClose = vi.fn();
        const deferredFrame: {
            resolve: ((frame: VideoFrame) => void) | null
        } = { resolve: null };
        const createFrameFactory = vi.fn(() => new Promise<VideoFrame>(resolve => {
            deferredFrame.resolve = resolve;
        }));
        const runner = new ExternalHDRPresentationAuthorizationRunner(createFrameFactory);

        const decisionPromise = runner.validate(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);
        await vi.waitFor(() => expect(createFrameFactory).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(AUTHORIZATION_TIMEOUT_MILLISECONDS);

        await expect(decisionPromise).resolves.toMatchObject({
            failureReason: 'timeout',
            status: 'rejected'
        });
        const resolveFrame = deferredFrame.resolve;
        if (!resolveFrame) {
            throw new Error('The late frame resolver was not initialized');
        }
        resolveFrame(createFrame(lateClose));
        await Promise.resolve();
        await Promise.resolve();
        expect(lateClose).toHaveBeenCalledOnce();
    });

    it('deduplicates route authorization and exposes settled telemetry', async () => {
        const harness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const runner = new ExternalHDRPresentationAuthorizationRunner(async (): Promise<VideoFrame> => createFrame(vi.fn()));
        const validate = vi.spyOn(runner, 'validate');
        const registry = new ExternalHDRPresentationAuthorizationRegistry(runner);

        const firstDecision = registry.authorize(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);
        const secondDecision = registry.authorize(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);
        expect(secondDecision).toBe(firstDecision);
        expect(registry.getTelemetry(harness.device, TARGET_FORMAT).status).toBe('pending');

        const decision: ExternalHDRRouteAuthorizationDecision = await firstDecision;
        expect(decision.status).toBe('authorized');
        expect(validate).toHaveBeenCalledOnce();
        expect(registry.isAuthorized(harness.device, TARGET_FORMAT, createPQColorMetadata())).toBe(true);
        expect(registry.isAuthorized(harness.device, TARGET_FORMAT, createHLGColorMetadata())).toBe(false);
        expect(registry.getTelemetry(harness.device, TARGET_FORMAT)).toMatchObject({
            authorizedRouteKeys: [ PQ_ROUTE_KEY ],
            status: 'authorized',
            targetFormat: TARGET_FORMAT
        });
    });

    it('scopes authorization to exact GPUDevice identity', async () => {
        const firstHarness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const secondHarness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const runner = new ExternalHDRPresentationAuthorizationRunner(async (): Promise<VideoFrame> => createFrame(vi.fn()));
        const validate = vi.spyOn(runner, 'validate');
        const registry = new ExternalHDRPresentationAuthorizationRegistry(runner);

        await registry.authorize(firstHarness.device, TARGET_FORMAT, PQ_ROUTE_KEY);
        expect(registry.isAuthorized(secondHarness.device, TARGET_FORMAT, createPQColorMetadata())).toBe(false);
        await registry.authorize(secondHarness.device, TARGET_FORMAT, PQ_ROUTE_KEY);

        expect(validate).toHaveBeenCalledTimes(2);
        expect(registry.isAuthorized(secondHarness.device, TARGET_FORMAT, createPQColorMetadata())).toBe(true);
    });

    it('rejects unsupported targets before constructing a frame', async () => {
        const harness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const createFrameFactory = vi.fn(async (): Promise<VideoFrame> => createFrame(vi.fn()));
        const runner = new ExternalHDRPresentationAuthorizationRunner(createFrameFactory);

        await expect(runner.validate(harness.device, 'rgba16float', PQ_ROUTE_KEY)).resolves.toMatchObject({
            failureReason: 'target-format-unsupported',
            status: 'rejected'
        });
        expect(createFrameFactory).not.toHaveBeenCalled();
        expect(PresentationExecutor.create).not.toHaveBeenCalled();
    });

    it('includes route, shader, and target in the stable signature', () => {
        const signature = createExternalHDRShaderSignature('bgra8unorm', PQ_ROUTE_KEY, 'shader');
        expect(signature).toBe(createExternalHDRShaderSignature('bgra8unorm', PQ_ROUTE_KEY, 'shader'));
        expect(signature).not.toBe(createExternalHDRShaderSignature('rgba8unorm', PQ_ROUTE_KEY, 'shader'));
        expect(signature).not.toBe(createExternalHDRShaderSignature('bgra8unorm', HLG_ROUTE_KEY, 'shader'));
        expect(signature).not.toBe(createExternalHDRShaderSignature('bgra8unorm', PQ_ROUTE_KEY, 'other shader'));
    });

    it('creates only an opaque, neutralized hardware decoder frame', async () => {
        const close = vi.fn();
        const configured = vi.fn();
        const closed = vi.fn();
        let decodedAccessUnit: Uint8Array | null = null;
        const outputFrame = {
            close,
            codedHeight: 1_088,
            codedWidth: 1_920,
            colorSpace: {
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            },
            displayHeight: 1_080,
            displayWidth: 1_920,
            format: null,
            timestamp: 0,
            visibleRect: { height: 1_080, width: 1_920, x: 0, y: 0 }
        } as unknown as VideoFrame;
        let decoderInit: VideoDecoderInit | null = null;

        class FakeEncodedVideoChunk {
            public constructor(init: EncodedVideoChunkInit) {
                const source = init.data;
                decodedAccessUnit = ArrayBuffer.isView(source) ?
                    new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice() :
                    new Uint8Array(source).slice();
            }
        }
        class FakeVideoDecoder {
            public static readonly isConfigSupported = vi.fn(
                async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({
                    config,
                    supported: true
                })
            );

            public constructor(init: VideoDecoderInit) {
                decoderInit = init;
            }

            public close(): void {
                closed();
            }

            public configure(config: VideoDecoderConfig): void {
                configured(config);
            }

            public decode(): void {
                decoderInit?.output(outputFrame);
            }

            public async flush(): Promise<void> {
                return undefined;
            }
        }
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);

        const frame = await createExternalHDRAuthorizationFrame();

        expect(frame).toBe(outputFrame);
        expect(configured).toHaveBeenCalledWith(expect.objectContaining({
            codec: 'hvc1.2.4.L120.B0',
            codedHeight: 1_088,
            codedWidth: 1_920,
            colorSpace: {
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            },
            hardwareAcceleration: 'prefer-hardware'
        }));
        expect(decodedAccessUnit).not.toBeNull();
        expect(parseHEVCSPS(findAnnexBNALUnit(decodedAccessUnit as unknown as Uint8Array, 33)).colorSpace).toEqual({
            fullRange: false,
            matrix: 'bt709',
            primaries: 'bt709',
            transfer: 'bt709'
        });
        expect(closed).toHaveBeenCalledOnce();
        expect(close).not.toHaveBeenCalled();
        frame.close();
        expect(close).toHaveBeenCalledOnce();
    });

    it('rejects an unsupported decoder configuration before constructing a decoder', async () => {
        const constructed = vi.fn();
        class FakeEncodedVideoChunk {}
        class FakeVideoDecoder {
            public static readonly isConfigSupported = vi.fn(
                async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({
                    config,
                    supported: false
                })
            );

            public constructor() {
                constructed();
            }
        }
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);

        await expect(createExternalHDRAuthorizationFrame()).rejects.toThrow('decoder-config-unsupported');
        expect(constructed).not.toHaveBeenCalled();
    });

    it('closes the decoder after a decoder error', async () => {
        const closed = vi.fn();
        let decoderInit: VideoDecoderInit | null = null;
        class FakeEncodedVideoChunk {}
        class FakeVideoDecoder {
            public static readonly isConfigSupported = vi.fn(
                async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({
                    config,
                    supported: true
                })
            );

            public constructor(init: VideoDecoderInit) {
                decoderInit = init;
            }

            public close(): void {
                closed();
            }

            public configure(): void {
                return undefined;
            }

            public decode(): void {
                decoderInit?.error(new DOMException('vector decode failed'));
            }

            public async flush(): Promise<void> {
                return undefined;
            }
        }
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);

        await expect(createExternalHDRAuthorizationFrame()).rejects.toThrow('vector decode failed');
        expect(closed).toHaveBeenCalledOnce();
    });

    it('closes a decoder whose flush is cancelled', async () => {
        const closed = vi.fn();
        const flush = vi.fn(() => new Promise<void>(() => undefined));
        class FakeEncodedVideoChunk {}
        class FakeVideoDecoder {
            public static readonly isConfigSupported = vi.fn(
                async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({
                    config,
                    supported: true
                })
            );

            public close(): void {
                closed();
            }

            public configure(): void {
                return undefined;
            }

            public decode(): void {
                return undefined;
            }

            public flush(): Promise<void> {
                return flush();
            }
        }
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        // eslint-disable-next-line compat/compat -- WebGPU custom decode targets modern Chromium
        const abortController = new AbortController();

        const framePromise = createExternalHDRAuthorizationFrame(abortController.signal);
        await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
        abortController.abort();

        await expect(framePromise).rejects.toMatchObject({ name: 'AbortError' });
        expect(closed).toHaveBeenCalledOnce();
    });
});
