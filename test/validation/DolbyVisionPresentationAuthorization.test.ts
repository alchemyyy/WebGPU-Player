import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createDefaultRenderSettings,
    createHDRToSDRRenderSettings
} from 'webgpu-player/presentation/RenderSettings';
import { processEncodedYUV, type ColorTriplet } from 'webgpu-player/color/ColorPipeline';
import { decodeDolbyVisionRPUSnapshot } from 'webgpu-player/video/dolby-vision/DolbyVisionRPUParser';
import { createDolbyVisionAuthorizationRPUVector } from 'webgpu-player/capability/vectors/DolbyVisionAuthorizationVector';
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
    sampleRawI420P10Frame,
    type RawHDRAuthorizationRouteKey,
    type RawHDRVectorObservation
} from 'webgpu-player/validation/RawHDRPresentationAuthorization';
import { createSDRColorMetadata } from 'webgpu-player/color/ColorMetadata';
import type { RawDolbyVisionVideoFrameFormat } from 'webgpu-player/color/ColorPipelineShader';

type MockFunction = ReturnType<typeof vi.fn>;

type MockBuffer = GPUBuffer & {
    bytes: Uint8Array
};

type DeviceHarness = {
    bindGroupEntries: GPUBindGroupEntry[]
    bufferDescriptors: GPUBufferDescriptor[]
    bufferDestroy: MockFunction
    device: GPUDevice
    draw: MockFunction
    textureDestroy: MockFunction
};

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

function createExpectedObservations(): readonly RawHDRVectorObservation[] {
    return createExpectedDolbyVisionAuthorizationObservations(
        createDolbyVisionAuthorizationRPUVector(),
        createHDRToSDRRenderSettings({
            toneMapping: { inputPeakNits: 4_000 }
        })
    );
}

function createDeviceHarness(
    ...observationSets: Array<readonly RawHDRVectorObservation[]>
): DeviceHarness {
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
    const lost = new Promise<GPUDeviceLostInfo>(() => undefined);
    const draw = vi.fn();
    const renderPass = {
        draw,
        end: vi.fn(),
        setBindGroup: vi.fn(),
        setPipeline: vi.fn(),
        setViewport: vi.fn()
    };
    const bufferDestroy = vi.fn();
    const textureDestroy = vi.fn();
    const bindGroupEntries: GPUBindGroupEntry[] = [];
    const bufferDescriptors: GPUBufferDescriptor[] = [];
    const pipeline = {
        getBindGroupLayout: vi.fn(() => ({}))
    } as unknown as GPURenderPipeline;
    const device = {
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => {
            bindGroupEntries.push(...descriptor.entries);
            return {};
        }),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            bufferDescriptors.push(descriptor);
            const bytes = new Uint8Array(Number(descriptor.size));
            return {
                bytes,
                destroy: bufferDestroy,
                getMappedRange: vi.fn((offset = 0, size = bytes.byteLength) => (
                    bytes.buffer.slice(offset, offset + size)
                )),
                mapAsync: vi.fn(() => Promise.resolve()),
                unmap: vi.fn()
            } as unknown as MockBuffer;
        }),
        createCommandEncoder: vi.fn(() => ({
            beginRenderPass: vi.fn(() => renderPass),
            copyTextureToBuffer: vi.fn((
                source: GPUTexelCopyTextureInfo,
                destination: GPUTexelCopyBufferInfo
            ) => {
                const origin = source.origin as GPUOrigin3DDict;
                const sampleX = Number(origin.x ?? 0);
                const sampleY = Number(origin.y ?? 0);
                const renderIndex = Math.max(draw.mock.calls.length - 1, 0);
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
        createRenderPipelineAsync: vi.fn(() => Promise.resolve(pipeline)),
        createShaderModule: vi.fn(() => ({})),
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => ({
            createView: vi.fn(() => ({})),
            depthOrArrayLayers: 1,
            destroy: textureDestroy,
            format: descriptor.format,
            height: Number((descriptor.size as GPUExtent3DDict).height ?? 1),
            usage: descriptor.usage,
            width: Number((descriptor.size as GPUExtent3DDict).width ?? 1)
        })),
        limits: { maxTextureDimension2D: 8_192 },
        lost,
        popErrorScope: vi.fn(() => Promise.resolve(null)),
        pushErrorScope: vi.fn(),
        queue: {
            onSubmittedWorkDone: vi.fn(() => Promise.resolve()),
            submit: vi.fn(),
            writeBuffer: vi.fn(),
            writeTexture: vi.fn()
        }
    } as unknown as GPUDevice;
    return {
        bindGroupEntries,
        bufferDescriptors,
        bufferDestroy,
        device,
        draw,
        textureDestroy
    };
}

function mutateFirstObservation(
    observations: readonly RawHDRVectorObservation[]
): readonly RawHDRVectorObservation[] {
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
        const melSnapshot = decodeDolbyVisionRPUSnapshot(
            createDolbyVisionAuthorizationRPUVector(7, 'mel')
        );
        const felSnapshot = decodeDolbyVisionRPUSnapshot(
            createDolbyVisionAuthorizationRPUVector(7, 'fel')
        );

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

    it('authorizes exact shader output and binds the RPU storage buffer', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        const runner = new DolbyVisionPresentationAuthorizationRunner();

        const decision = await runner.validate(harness.device, 'bgra8unorm');

        expect(decision).toMatchObject({
            failureReason: null,
            routeKey: DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
            sampleCount: 9,
            status: 'authorized'
        });
        expect(harness.draw).toHaveBeenCalledTimes(1);
        expect(harness.bindGroupEntries.some(entry => entry.binding === 5)).toBe(true);
        expect(harness.bufferDescriptors).toContainEqual(expect.objectContaining({
            size: 3_232,
            usage: 5
        }));
        expect(harness.bufferDestroy).toHaveBeenCalled();
        expect(harness.textureDestroy).toHaveBeenCalled();
    });

    it('authorizes both Profile 7 MEL reconstruction and FEL HDR10-base fallback', async () => {
        const settings = createHDRToSDRRenderSettings({
            toneMapping: { inputPeakNits: 4_000 }
        });
        const melRPUData = createDolbyVisionAuthorizationRPUVector(7, 'mel');
        const felRPUData = createDolbyVisionAuthorizationRPUVector(7, 'fel');
        const harness = createDeviceHarness(
            createExpectedDolbyVisionAuthorizationObservations(melRPUData, settings),
            createExpectedDolbyVisionAuthorizationObservations(
                felRPUData,
                settings,
                'fel-hdr10-base'
            )
        );
        const runner = new DolbyVisionPresentationAuthorizationRunner('profile7-base');

        const decision = await runner.validate(harness.device, 'bgra8unorm');

        expect(decision).toMatchObject({
            failureReason: null,
            routeKey: DOLBY_VISION_PROFILE7_AUTHORIZATION_ROUTE_KEY,
            sampleCount: 18,
            status: 'authorized'
        });
        expect(harness.draw).toHaveBeenCalledTimes(2);
    });

    it('separately authorizes reduced-resolution Profile 7 FEL composition', async () => {
        const settings = createHDRToSDRRenderSettings({
            toneMapping: { inputPeakNits: 4_000 }
        });
        const harness = createDeviceHarness(
            createExpectedDolbyVisionFELAuthorizationObservations(settings)
        );
        const runner = new DolbyVisionPresentationAuthorizationRunner('profile7-fel');

        const decision = await runner.validate(harness.device, 'bgra8unorm');

        expect(decision).toMatchObject({
            failureReason: null,
            routeKey: DOLBY_VISION_PROFILE7_FEL_AUTHORIZATION_ROUTE_KEY,
            sampleCount: 9,
            status: 'authorized'
        });
        expect(harness.draw).toHaveBeenCalledOnce();
        expect(harness.bindGroupEntries.map(entry => entry.binding)).toEqual(
            expect.arrayContaining([ 5, 6, 7, 8, 9 ])
        );
    });

    it('rejects a bounded pixel mismatch', async () => {
        const harness = createDeviceHarness(mutateFirstObservation(
            createExpectedObservations()
        ));
        const runner = new DolbyVisionPresentationAuthorizationRunner();

        await expect(runner.validate(harness.device, 'bgra8unorm')).resolves.toMatchObject({
            failureReason: 'pixel-mismatch',
            status: 'rejected'
        });
    });

    it('rejects unsupported targets before allocating resources', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        const runner = new DolbyVisionPresentationAuthorizationRunner();

        await expect(runner.validate(harness.device, 'rgba16float')).resolves.toMatchObject({
            failureReason: 'target-format-unsupported',
            status: 'rejected'
        });
        expect(harness.bufferDescriptors).toHaveLength(0);
    });

    it('deduplicates exact-device authorization and exposes only settled state', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        const runner = new DolbyVisionPresentationAuthorizationRunner();
        const validate = vi.spyOn(runner, 'validate');
        const registry = new DolbyVisionPresentationAuthorizationRegistry(runner);

        const firstDecision = registry.authorize(harness.device, 'bgra8unorm');
        const secondDecision = registry.authorize(harness.device, 'bgra8unorm');
        expect(secondDecision).toBe(firstDecision);
        expect(registry.getTelemetry(harness.device, 'bgra8unorm').status).toBe('pending');

        const decision: DolbyVisionAuthorizationDecision = await firstDecision;
        expect(decision.status).toBe('authorized');
        expect(validate).toHaveBeenCalledTimes(1);
        expect(registry.isAuthorized(
            harness.device,
            'bgra8unorm',
            createHDRToSDRRenderSettings(),
            'I420P10'
        )).toBe(true);
        expect(registry.isAuthorized(
            harness.device,
            'bgra8unorm',
            createHDRToSDRRenderSettings(),
            'I420P12'
        )).toBe(false);
        expect(registry.getTelemetry(harness.device, 'bgra8unorm')).toMatchObject({
            status: 'authorized',
            targetFormat: 'bgra8unorm'
        });
    });

    it.each([ 8, 10, 12 ])('builds dual-layer Profile 4 MEL and FEL vectors at %i bits', bitDepth => {
        const melSnapshot = decodeDolbyVisionRPUSnapshot(
            createDolbyVisionAuthorizationRPUVector(4, 'mel', bitDepth)
        );
        const felSnapshot = decodeDolbyVisionRPUSnapshot(
            createDolbyVisionAuthorizationRPUVector(4, 'fel', bitDepth)
        );

        expect(melSnapshot).toMatchObject({ baseLayerBitDepth: bitDepth, layerMode: 'mel', profile: 4 });
        expect(felSnapshot).toMatchObject({ baseLayerBitDepth: bitDepth, layerMode: 'fel', profile: 4 });
        expect(() => createDolbyVisionAuthorizationRPUVector(4, 'single-layer')).toThrow(TypeError);
    });

    it('authorizes Profile 4 MEL reconstruction and its FEL SDR-base fallback', async () => {
        const settings = createHDRToSDRRenderSettings({
            toneMapping: { inputPeakNits: 4_000 }
        });
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

        await expect(runner.validate(harness.device, 'bgra8unorm')).resolves.toMatchObject({
            failureReason: null,
            routeKey: DOLBY_VISION_PROFILE4_AUTHORIZATION_ROUTE_KEY,
            sampleCount: 18,
            status: 'authorized'
        });
        expect(runner.createShader(settings)).toContain('return presentSDRBaseLayer(rawBaseSignal);');
    });

    it('separately authorizes Profile 4 FEL composition', async () => {
        const settings = createHDRToSDRRenderSettings({
            toneMapping: { inputPeakNits: 4_000 }
        });
        const harness = createDeviceHarness(
            createExpectedDolbyVisionFELAuthorizationObservations(settings, 4)
        );
        const runner = new DolbyVisionPresentationAuthorizationRunner('profile4-fel');

        await expect(runner.validate(harness.device, 'bgra8unorm')).resolves.toMatchObject({
            failureReason: null,
            routeKey: DOLBY_VISION_PROFILE4_FEL_AUTHORIZATION_ROUTE_KEY,
            status: 'authorized'
        });
        expect(harness.bindGroupEntries.map(entry => entry.binding)).toEqual(
            expect.arrayContaining([ 5, 6, 7, 8, 9 ])
        );
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
        const settings = createHDRToSDRRenderSettings({
            toneMapping: { inputPeakNits: 4_000 }
        });
        const frame = createRawHDRAuthorizationVector(vectorKey as RawHDRAuthorizationRouteKey);
        const harness = createDeviceHarness(createExpectedDolbyVisionAuthorizationObservations(
            createDolbyVisionAuthorizationRPUVector(8, 'single-layer', frame.bitDepth),
            settings,
            'reconstruct',
            frame
        ));
        const runner = new DolbyVisionPresentationAuthorizationRunner(
            'single-layer',
            format as RawDolbyVisionVideoFrameFormat
        );
        const registry = new DolbyVisionPresentationAuthorizationRegistry(runner);

        await expect(registry.authorize(harness.device, 'bgra8unorm')).resolves.toMatchObject({
            routeKey: `${format}:dovi-rpu-v1`,
            status: 'authorized'
        });
        expect(registry.isAuthorized(harness.device, 'bgra8unorm', settings, format)).toBe(true);
        expect(registry.isAuthorized(harness.device, 'bgra8unorm', settings, 'I420P10')).toBe(false);
    });

    it.each([ 'profile4-base', 'profile4-fel', 'profile7-base', 'profile7-fel' ] as const)(
        'keeps the dual-layer %s route on I420P10 planes',
        route => {
            expect(() => new DolbyVisionPresentationAuthorizationRunner(route, 'I420P12'))
                .toThrow(RangeError);
        }
    );

    it('includes the vector and target in the stable signature', () => {
        expect(createDolbyVisionShaderSignature('bgra8unorm', 'shader')).toBe(
            createDolbyVisionShaderSignature('bgra8unorm', 'shader')
        );
        expect(createDolbyVisionShaderSignature('bgra8unorm', 'shader')).not.toBe(
            createDolbyVisionShaderSignature('rgba8unorm', 'shader')
        );
    });
});
