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
    createHDRToSDRRenderSettings
} from 'webgpu-player/presentation/RenderSettings';
import { processEncodedYUV, type ColorTriplet } from 'webgpu-player/color/ColorPipeline';
import { decodeDolbyVisionRPUSnapshot } from 'webgpu-player/video/dolby-vision/DolbyVisionRPUParser';
import { createDolbyVisionAuthorizationRPUVector } from 'webgpu-player/capability/vectors/DolbyVisionAuthorizationVector';
import { createBuiltinChain } from 'webgpu-player/presentation/passes/builtin/BuiltinChains';
import type { RawDolbyVisionFrameFormat } from 'webgpu-player/presentation/passes/PassTypes';
import { PresentationExecutor } from 'webgpu-player/presentation/passes/PresentationExecutor';
import { planPresentation } from 'webgpu-player/presentation/passes/PresentationPlanner';
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
    sampleRawI420P10Frame,
    type RawHDRAuthorizationRouteKey,
    type RawHDRVectorObservation
} from 'webgpu-player/validation/RawHDRPresentationAuthorization';
import { createSDRColorMetadata } from 'webgpu-player/color/ColorMetadata';

import {
    createWebGPUDeviceHarness,
    getBufferWrites,
    getShaderCodes,
    getTextures,
    installWebGPUGlobals,
    type MockGPUTexture,
    type ReadbackTexel,
    type RecordedBufferWrite,
    type RecordedTextureWrite,
    type WebGPUDeviceHarness
} from '../helpers/webGPUDeviceHarness';

/** A plane texture's label and size, which show the layer and format an authorization uploaded. */
type PlaneGeometry = [string, number, number];

const TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const UNREADABLE_TARGET_FORMAT: GPUTextureFormat = 'rgba16float';
const SINGLE_SCENARIO_SAMPLE_COUNT = 9;
const DUAL_SCENARIO_SAMPLE_COUNT = 18;
// The size the reduced-resolution FEL probe composes beside the 16x8 BL vector
const ENHANCEMENT_LAYER_WIDTH = 8;
const ENHANCEMENT_LAYER_HEIGHT = 4;
// The EL is always I420P10, whose planes upload as 16-bit single-component textures
const ENHANCEMENT_PLANE_TEXTURE_FORMAT: GPUTextureFormat = 'r16uint';
// The authorization joins a reference plan's pass modules with this separator before signing them
const PLAN_SHADER_CODE_SEPARATOR = '\u0000';
// The labels of the resources the executor creates
const RENDER_SETTINGS_LABEL = 'Presentation render settings';
const DOLBY_VISION_RPU_LABEL = 'Presentation Dolby Vision RPU';
const BASE_PLANES_LABEL = 'Raw video';
const ENHANCEMENT_PLANES_LABEL = 'Raw Dolby Vision enhancement';

let restoreWebGPUGlobals: () => void = (): void => undefined;

function createSettings() {
    return createHDRToSDRRenderSettings({
        toneMapping: { inputPeakNits: 4_000 }
    });
}

function createExpectedObservations(): readonly RawHDRVectorObservation[] {
    return createExpectedDolbyVisionAuthorizationObservations(createDolbyVisionAuthorizationRPUVector(), createSettings());
}

/** Creates a device whose readbacks return one observation set per rendered scenario, in render order. */
function createDeviceHarness(...observationSets: Array<readonly RawHDRVectorObservation[]>): WebGPUDeviceHarness {
    const observationMaps: Array<Map<string, ColorTriplet>> = [];
    for (const observations of observationSets) {
        const observationMap = new Map<string, ColorTriplet>();
        for (const observation of observations) {
            observationMap.set(`${observation.sampleX}:${observation.sampleY}`, observation.linearRGB);
        }
        observationMaps.push(observationMap);
    }
    return createWebGPUDeviceHarness({
        readPixel: (texel: ReadbackTexel): ColorTriplet | undefined => {
            // Each scenario renders one pass, and its readback follows
            const renderIndex = Math.max(texel.renderPassCount - 1, 0);
            const observationMap = observationMaps[Math.min(renderIndex, observationMaps.length - 1)];
            return observationMap.get(`${texel.sampleX}:${texel.sampleY}`);
        }
    });
}

/** Returns the RPU vectors an authorization wrote, one per rendered scenario. */
function getWrittenRPUVectors(harness: WebGPUDeviceHarness): Uint8Array[] {
    return getBufferWrites(harness, DOLBY_VISION_RPU_LABEL).map((write: RecordedBufferWrite): Uint8Array => write.bytes);
}

/** Returns the label and size of each plane texture of one layer, in creation order. */
function getPlaneGeometries(harness: WebGPUDeviceHarness, labelPrefix: string): PlaneGeometry[] {
    return getTextures(harness, labelPrefix).map((texture: MockGPUTexture): PlaneGeometry => [ texture.label, texture.width, texture.height ]);
}

/** Returns the plane textures a frame uploads into: its layer's label per plane, at each plane's size. */
function getExpectedPlaneGeometries(frame: TransferableRawVideoFrame, labelPrefix: string): PlaneGeometry[] {
    return frame.planes.map((plane): PlaneGeometry => [ `${labelPrefix} ${plane.kind.toUpperCase()} plane`, plane.width, plane.height ]);
}

function getPlaneUploads(harness: WebGPUDeviceHarness, labelPrefix: string): RecordedTextureWrite[] {
    return harness.textureWrites.filter((write: RecordedTextureWrite): boolean => write.texture.label.startsWith(labelPrefix));
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

function expectEveryResourceDestroyed(harness: WebGPUDeviceHarness): void {
    for (const buffer of harness.buffers) {
        expect(buffer.destroy, buffer.label).toHaveBeenCalled();
    }
    for (const texture of harness.textures) {
        expect(texture.destroy, texture.label).toHaveBeenCalledOnce();
    }
}

describe('Dolby Vision presentation authorization', () => {
    beforeEach(() => {
        restoreWebGPUGlobals = installWebGPUGlobals();
        vi.spyOn(PresentationExecutor, 'create');
    });

    afterEach(() => {
        vi.clearAllMocks();
        restoreWebGPUGlobals();
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

        // The signature covers exactly the modules the executor compiled
        expect(decision).toMatchObject({
            failureReason: null,
            routeKey: DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
            sampleCount: SINGLE_SCENARIO_SAMPLE_COUNT,
            shaderSignature: createDolbyVisionShaderSignature(TARGET_FORMAT, getShaderCodes(harness).join(PLAN_SHADER_CODE_SEPARATOR)),
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
        expect(vi.mocked(planPresentation).mock.calls[0][0].output).toEqual({ colorSpace: 'srgb', format: TARGET_FORMAT, toneMapping: 'standard' });
        expect(getBufferWrites(harness, RENDER_SETTINGS_LABEL)).toHaveLength(1);
        expect(getWrittenRPUVectors(harness)).toEqual([ new Uint8Array(createDolbyVisionAuthorizationRPUVector()) ]);
        expect(getTextures(harness, ENHANCEMENT_PLANES_LABEL)).toEqual([]);
        expect(PresentationExecutor.create).toHaveBeenCalledOnce();
        expectEveryResourceDestroyed(harness);
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
        expect(harness.renderPasses).toHaveLength(2);
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
        // The EL uploads from the BL's compound buffer
        const baseUploads = getPlaneUploads(harness, BASE_PLANES_LABEL);
        const enhancementUploads = getPlaneUploads(harness, ENHANCEMENT_PLANES_LABEL);
        expect(enhancementUploads).toHaveLength(3);
        for (const upload of enhancementUploads) {
            expect(upload.data).toBe(baseUploads[0].data);
        }
    });

    it('rejects a bounded pixel mismatch', async () => {
        const harness = createDeviceHarness(mutateFirstObservation(createExpectedObservations()));
        const runner = new DolbyVisionPresentationAuthorizationRunner();

        await expect(runner.validate(harness.device, TARGET_FORMAT)).resolves.toMatchObject({
            failureReason: 'pixel-mismatch',
            status: 'rejected'
        });
        expectEveryResourceDestroyed(harness);
    });

    it('rejects unsupported targets before allocating resources', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        const runner = new DolbyVisionPresentationAuthorizationRunner();

        await expect(runner.validate(harness.device, UNREADABLE_TARGET_FORMAT)).resolves.toMatchObject({
            failureReason: 'target-format-unsupported',
            status: 'rejected'
        });
        expect(harness.buffers).toEqual([]);
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
        expect(getPlaneUploads(harness, ENHANCEMENT_PLANES_LABEL)).toHaveLength(3);
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
        expect(getPlaneGeometries(harness, BASE_PLANES_LABEL)).toEqual(getExpectedPlaneGeometries(frame, BASE_PLANES_LABEL));
        for (const upload of getPlaneUploads(harness, BASE_PLANES_LABEL)) {
            expect(new Uint8Array(upload.data as ArrayBuffer)).toEqual(new Uint8Array(frame.data));
        }
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

        expect(getWrittenRPUVectors(harness)).toEqual([
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
                // Both scenarios upload the BL vector into one set of plane textures, without an EL
                expect(getPlaneGeometries(harness, BASE_PLANES_LABEL)).toEqual(getExpectedPlaneGeometries(frame, BASE_PLANES_LABEL));
                expect(getPlaneUploads(harness, BASE_PLANES_LABEL)).toHaveLength(frame.planes.length * 2);
                expect(getTextures(harness, ENHANCEMENT_PLANES_LABEL)).toEqual([]);
                // Both RPU vectors declare the BL format's own depth, as the per-frame checks require
                expect(getWrittenRPUVectors(harness)).toEqual([
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
                expect(getPlaneGeometries(harness, BASE_PLANES_LABEL))
                    .toEqual(getExpectedPlaneGeometries(createRawHDRAuthorizationVector(vectorKey), BASE_PLANES_LABEL));
                // The EL is 10-bit 4:2:0 at half the BL's size, whatever the BL format
                const enhancementGeometries = getPlaneGeometries(harness, ENHANCEMENT_PLANES_LABEL);
                expect(enhancementGeometries).toEqual([
                    [ `${ENHANCEMENT_PLANES_LABEL} Y plane`, ENHANCEMENT_LAYER_WIDTH, ENHANCEMENT_LAYER_HEIGHT ],
                    [ `${ENHANCEMENT_PLANES_LABEL} U plane`, ENHANCEMENT_LAYER_WIDTH / 2, ENHANCEMENT_LAYER_HEIGHT / 2 ],
                    [ `${ENHANCEMENT_PLANES_LABEL} V plane`, ENHANCEMENT_LAYER_WIDTH / 2, ENHANCEMENT_LAYER_HEIGHT / 2 ]
                ]);
                for (const texture of getTextures(harness, ENHANCEMENT_PLANES_LABEL)) {
                    expect(texture.format).toBe(ENHANCEMENT_PLANE_TEXTURE_FORMAT);
                }
                const writtenRPUVectors = getWrittenRPUVectors(harness);
                expect(writtenRPUVectors).toHaveLength(1);
                expect(decodeDolbyVisionRPUSnapshot(writtenRPUVectors[0].slice().buffer)).toMatchObject({
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
