import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real built-in library and planner run behind spies, and the real executors run on a mock device
vi.mock('webgpu-player/presentation/passes/builtin/BuiltinChains', async importOriginal => {
    const originalModule = await importOriginal<typeof import('webgpu-player/presentation/passes/builtin/BuiltinChains')>();
    return { ...originalModule, createBuiltinChain: vi.fn(originalModule.createBuiltinChain) };
});

vi.mock('webgpu-player/presentation/passes/PresentationPlanner', async importOriginal => {
    const originalModule = await importOriginal<typeof import('webgpu-player/presentation/passes/PresentationPlanner')>();
    return { ...originalModule, planPresentation: vi.fn(originalModule.planPresentation) };
});

import { createHDRToSDRRenderSettings } from 'webgpu-player/presentation/RenderSettings';
import type { ColorTriplet } from 'webgpu-player/color/ColorPipeline';
import { createDolbyVisionAuthorizationRPUVector } from 'webgpu-player/capability/vectors/DolbyVisionAuthorizationVector';
import { createBuiltinChain } from 'webgpu-player/presentation/passes/builtin/BuiltinChains';
import type { PlanRequest } from 'webgpu-player/presentation/passes/PassTypes';
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

import {
    createWebGPUDeviceHarness,
    getBufferWrites,
    getShaderCodes,
    installWebGPUGlobals,
    type ReadbackTexel,
    type RecordedBufferWrite,
    type WebGPUDeviceHarness
} from '../helpers/webGPUDeviceHarness';

type MockFunction = ReturnType<typeof vi.fn>;

const TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const INPUT_PROBE_FORMAT: GPUTextureFormat = 'rgba16float';
const INPUT_PROBE_SIGNAL_NAME = 'external-dolby-vision-input-probe';
const VECTOR_SAMPLE_COUNT = 9;
// Within the probe's 8/1023 input bound, and far outside it
const PRESERVED_INPUT_OFFSET = 4 / 1_023;
const CORRUPTED_SIGNAL_OFFSET = 0.1;
// The color space the executors import frames in
const EXTERNAL_TEXTURE_COLOR_SPACE: PredefinedColorSpace = 'srgb';
// The probe and the output each render one pass of the one submission
const RENDERED_PASS_COUNT = 2;
const RENDER_SETTINGS_LABEL = 'Presentation render settings';
const DOLBY_VISION_RPU_LABEL = 'Presentation Dolby Vision RPU';
const SIMULATED_IMPORT_FAILURE = 'simulated import failure';
// The output compares in 8-bit steps against 8/255, and the recovered input in 10-bit steps against 8/1023
const PIXEL_MISMATCH_DETAIL_PATTERN = /^\d+(\.\d)?\/255 > 8\/255 at \(\d+, \d+\)$/;
const INPUT_MISMATCH_DETAIL_PATTERN = /^\d+(\.\d)?\/1023 > 8\/1023 at \(0, 0\)$/;

let restoreWebGPUGlobals: () => void = (): void => undefined;

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

/** Creates a device whose readbacks return the input observations from the probe's target and the observations from the output's. */
function createDeviceHarness(
    observations: readonly RawHDRVectorObservation[],
    inputObservations: readonly RawHDRVectorObservation[] = createExpectedExternalDolbyVisionInputObservations()
): WebGPUDeviceHarness {
    const observationMap = createObservationMap(observations);
    const inputObservationMap = createObservationMap(inputObservations);
    return createWebGPUDeviceHarness({
        readPixel: (texel: ReadbackTexel): ColorTriplet | undefined => {
            const sourceMap = texel.texture.format === INPUT_PROBE_FORMAT ? inputObservationMap : observationMap;
            return sourceMap.get(`${texel.sampleX}:${texel.sampleY}`);
        }
    });
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

function expectEveryResourceDestroyed(harness: WebGPUDeviceHarness): void {
    for (const buffer of harness.buffers) {
        expect(buffer.destroy, buffer.label).toHaveBeenCalled();
    }
    for (const texture of harness.textures) {
        expect(texture.destroy, texture.label).toHaveBeenCalledOnce();
    }
}

describe('External Dolby Vision presentation authorization', () => {
    beforeEach(() => {
        restoreWebGPUGlobals = installWebGPUGlobals();
        vi.spyOn(PresentationExecutor, 'create');
    });

    afterEach(() => {
        vi.clearAllMocks();
        restoreWebGPUGlobals();
        vi.restoreAllMocks();
    });

    it('authorizes the default chain and the input probe from one import of the frame', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        const close = vi.fn();
        const frame = createFrame(close);
        const runner = new ExternalDolbyVisionPresentationAuthorizationRunner((): VideoFrame => frame);

        const decision = await runner.validate(harness.device, TARGET_FORMAT);

        // The output executor compiles first, then the input probe's, and the signature covers both modules
        const [ outputShaderCode, inputProbeShaderCode ] = getShaderCodes(harness);
        expect(decision).toMatchObject({
            failureReason: null,
            maximumInputChannelError: expect.any(Number),
            routeKey: EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
            sampleCount: VECTOR_SAMPLE_COUNT,
            shaderSignature: createExternalDolbyVisionShaderSignature(TARGET_FORMAT, outputShaderCode, inputProbeShaderCode),
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

        expect(PresentationExecutor.create).toHaveBeenCalledTimes(2);
        // Only the output binds render settings and the RPU
        expect(getBufferWrites(harness, RENDER_SETTINGS_LABEL)).toHaveLength(1);
        expect(getBufferWrites(harness, DOLBY_VISION_RPU_LABEL).map((write: RecordedBufferWrite): Uint8Array => write.bytes))
            .toEqual([ new Uint8Array(createDolbyVisionAuthorizationRPUVector(5)) ]);
        expect(harness.importExternalTexture.mock.calls).toEqual([
            [ { colorSpace: EXTERNAL_TEXTURE_COLOR_SPACE, source: frame } ],
            [ { colorSpace: EXTERNAL_TEXTURE_COLOR_SPACE, source: frame } ]
        ]);
        // The probe and the output render in one submission before the two readbacks
        expect(harness.renderPasses).toHaveLength(RENDERED_PASS_COUNT);
        expect(harness.queueSubmit.mock.calls[0][0]).toHaveLength(RENDERED_PASS_COUNT);
        expect(close).toHaveBeenCalledOnce();
        expectEveryResourceDestroyed(harness);
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

        const decision = await runner.validate(harness.device, TARGET_FORMAT);

        expect(decision).toMatchObject({
            failureReason: 'input-mismatch',
            maximumChannelError: null,
            maximumInputChannelError: expect.any(Number),
            status: 'rejected'
        });
        expect(decision.failureDetail).toMatch(INPUT_MISMATCH_DETAIL_PATTERN);
    });

    it('rejects a bounded pixel mismatch and still closes the frame', async () => {
        const harness = createDeviceHarness(offsetFirstObservation(createExpectedObservations(), CORRUPTED_SIGNAL_OFFSET));
        const close = vi.fn();
        const runner = new ExternalDolbyVisionPresentationAuthorizationRunner((): VideoFrame => createFrame(close));

        const decision = await runner.validate(harness.device, TARGET_FORMAT);

        expect(decision).toMatchObject({
            failureReason: 'pixel-mismatch',
            status: 'rejected'
        });
        expect(decision.failureDetail).toMatch(PIXEL_MISMATCH_DETAIL_PATTERN);
        expect(close).toHaveBeenCalledOnce();
    });

    it('classifies a frame the output executor cannot import and closes the frame', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        // The input probe imports the frame first, and the output's import fails
        harness.importExternalTexture
            .mockImplementationOnce((descriptor: GPUExternalTextureDescriptor) => ({ descriptor }))
            .mockImplementationOnce(() => {
                throw new Error(SIMULATED_IMPORT_FAILURE);
            });
        const close = vi.fn();
        const runner = new ExternalDolbyVisionPresentationAuthorizationRunner((): VideoFrame => createFrame(close));

        await expect(runner.validate(harness.device, TARGET_FORMAT)).resolves.toMatchObject({
            failureDetail: `import: ${SIMULATED_IMPORT_FAILURE}`,
            failureReason: 'frame-import-failed',
            status: 'rejected'
        });
        expect(close).toHaveBeenCalledOnce();
        expect(harness.queueSubmit).not.toHaveBeenCalled();
        expectEveryResourceDestroyed(harness);
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
        expect(registry.getAuthorizationFailure(harness.device, TARGET_FORMAT)).toBe(`pending: ${EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY}`);

        const decision: ExternalDolbyVisionAuthorizationDecision = await firstDecision;
        expect(decision.status).toBe('authorized');
        expect(validate).toHaveBeenCalledOnce();
        expect(registry.isAuthorized(harness.device, TARGET_FORMAT)).toBe(true);
        expect(registry.getAuthorizationFailure(harness.device, TARGET_FORMAT)).toBeNull();
        expect(registry.isAuthorized(createDeviceHarness(createExpectedObservations()).device, TARGET_FORMAT)).toBe(false);
        expect(registry.getAuthorizationFailure(createDeviceHarness(createExpectedObservations()).device, TARGET_FORMAT))
            .toBe(`unprobed: ${EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY}`);
        expect(registry.getTelemetry(harness.device, TARGET_FORMAT)).toMatchObject({
            failureDetail: null,
            status: 'authorized',
            targetFormat: TARGET_FORMAT
        });
    });

    it('reports a rejected route with its failure reason and detail', async () => {
        const harness = createDeviceHarness(offsetFirstObservation(createExpectedObservations(), CORRUPTED_SIGNAL_OFFSET));
        const runner = new ExternalDolbyVisionPresentationAuthorizationRunner((): VideoFrame => createFrame(vi.fn()));
        const registry = new ExternalDolbyVisionPresentationAuthorizationRegistry(runner);

        const decision = await registry.authorize(harness.device, TARGET_FORMAT);

        expect(registry.getAuthorizationFailure(harness.device, TARGET_FORMAT))
            .toBe(`pixel-mismatch: ${EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY} ${decision.failureDetail}`);
        expect(registry.getTelemetry(harness.device, TARGET_FORMAT)).toMatchObject({
            failureDetail: decision.failureDetail,
            failureReason: 'pixel-mismatch'
        });
    });

    it('rejects unsupported targets before constructing a frame', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        const createFrameFactory = vi.fn(() => createFrame(vi.fn()));
        const runner = new ExternalDolbyVisionPresentationAuthorizationRunner(createFrameFactory);

        await expect(runner.validate(harness.device, INPUT_PROBE_FORMAT)).resolves.toMatchObject({
            failureDetail: INPUT_PROBE_FORMAT,
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
