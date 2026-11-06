import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

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
    createHDRToSDRRenderSettings,
    RENDER_SETTINGS_UNIFORM_BYTE_LENGTH
} from 'webgpu-player/presentation/RenderSettings';
import { createHLGColorMetadata, createPQColorMetadata, createSDRColorMetadata } from 'webgpu-player/color/ColorMetadata';
import type { ColorTriplet } from 'webgpu-player/color/ColorPipeline';
import {
    EXTERNAL_AV1_HDR_AUTHORIZATION_DISPLAY_HEIGHT,
    EXTERNAL_AV1_HDR_AUTHORIZATION_DISPLAY_WIDTH,
    EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_SAMPLES,
    EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_VERSION
} from 'webgpu-player/capability/vectors/ExternalAV1HDRAuthorizationVector';
import {
    EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT,
    EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH
} from 'webgpu-player/capability/vectors/ExternalHDRAuthorizationVector';
import { findAV1SequenceHeader } from 'webgpu-player/demux/av1/AV1SequenceHeaderParser';
import { createBuiltinChain } from 'webgpu-player/presentation/passes/builtin/BuiltinChains';
import { PresentationExecutor } from 'webgpu-player/presentation/passes/PresentationExecutor';
import { planPresentation } from 'webgpu-player/presentation/passes/PresentationPlanner';
import { parseHEVCSPS } from 'webgpu-player/demux/hevc/HEVCSPSParser';
import {
    createExpectedExternalHDRAuthorizationObservations,
    createExternalHDRAuthorizationFrame,
    createExternalHDRShaderSignature,
    ExternalHDRPresentationAuthorizationRegistry,
    ExternalHDRPresentationAuthorizationRunner,
    type ExternalHDRAuthorizationFrameFactory,
    type ExternalHDRAuthorizationRouteKey,
    type ExternalHDRRouteAuthorizationDecision,
    type ExternalHDRVideoCodec
} from 'webgpu-player/validation/ExternalHDRPresentationAuthorization';
import type { RawHDRVectorObservation } from 'webgpu-player/validation/RawHDRPresentationAuthorization';
import type CapabilityProbeSession from 'webgpu-player/capability/CapabilityProbeSession';
import { AV1_MAXIMUM_REFERENCE_FRAMES, HEVC_MAXIMUM_REFERENCE_FRAMES } from 'webgpu-player/capability/CapabilityProbeSteps';

import {
    CAPABILITY_PROBE_TIMEOUT_MILLISECONDS,
    createCapabilityProbeSession,
    createRecordingStore
} from '../helpers/capabilityProbeSession';
import {
    createDeferred,
    createWebGPUDeviceHarness,
    getBufferWrites,
    getShaderCodes,
    installWebGPUGlobals,
    type ReadbackTexel,
    type WebGPUDeviceHarness
} from '../helpers/webGPUDeviceHarness';

type MockFunction = Mock;

const PQ_ROUTE_KEY: ExternalHDRAuthorizationRouteKey = 'external-hevc-main10-bt709-limited:pq-v1';
const HLG_ROUTE_KEY: ExternalHDRAuthorizationRouteKey = 'external-hevc-main10-bt709-limited:hlg-v1';
const AV1_PQ_ROUTE_KEY: ExternalHDRAuthorizationRouteKey = 'external-av1-main10-bt709-limited:pq-v1';
const AV1_HLG_ROUTE_KEY: ExternalHDRAuthorizationRouteKey = 'external-av1-main10-bt709-limited:hlg-v1';
const TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const UNREADABLE_TARGET_FORMAT: GPUTextureFormat = 'rgba16float';
const AUTHORIZATION_TIMEOUT_MILLISECONDS = 5_000;
const VECTOR_SAMPLE_COUNT = 8;
const RENDER_VERTEX_COUNT = 6;
// The authorization joins a reference plan's pass modules with this separator before signing them
const PLAN_SHADER_CODE_SEPARATOR = '\u0000';
// The color space the executor imports frames in
const EXTERNAL_TEXTURE_COLOR_SPACE: PredefinedColorSpace = 'srgb';
const RENDER_SETTINGS_LABEL = 'Presentation render settings';
const HEVC_PROBE = 'external-hdr-authorization:hevc';
const AV1_PROBE = 'external-hdr-authorization:av1';
const HEVC_CHECK_LABEL = 'check hvc1.2.4.L120.B0 1920x1088 prefer-hardware';
const HEVC_DECODE_LABEL = 'decode hvc1.2.4.L120.B0 1920x1088 prefer-hardware';
const AV1_CHECK_LABEL = 'check av01.0.08M.10 1920x1080 prefer-hardware';
const AV1_DECODE_LABEL = 'decode av01.0.08M.10 1920x1080 prefer-hardware';
// A 10-bit 4:2:0 frame holds 2-byte samples, 1.5 per pixel; a decode holds its codec's references and the frame it outputs
const I420P10_BYTES_PER_PIXEL = 3;
const HEVC_DECODE_COST = { bytes: 1_920 * 1_088 * I420P10_BYTES_PER_PIXEL * (HEVC_MAXIMUM_REFERENCE_FRAMES + 1), decoders: 1 };
const AV1_DECODE_COST = { bytes: 1_920 * 1_080 * I420P10_BYTES_PER_PIXEL * (AV1_MAXIMUM_REFERENCE_FRAMES + 1), decoders: 1 };
const SIMULATED_IMPORT_FAILURE = 'simulated import failure';
// A rejection names its worst error and the 10/255 bound in 8-bit steps, and the sample where it is
const PIXEL_MISMATCH_DETAIL_PATTERN = /^\d+(\.\d)?\/255 > 10\/255 at \(\d+, \d+\)$/;
const SDR_ROUTE_UNSUPPORTED_FAILURE = 'route-unsupported: 8-bit bt709:bt709:limited:sdr';

let restoreWebGPUGlobals: () => void = (): void => undefined;

function createSettings() {
    return createHDRToSDRRenderSettings({
        toneMapping: { inputPeakNits: 1_000 }
    });
}

function createExpectedObservations(routeKey: ExternalHDRAuthorizationRouteKey): readonly RawHDRVectorObservation[] {
    return createExpectedExternalHDRAuthorizationObservations(routeKey, createSettings());
}

function createFrame(close: MockFunction, displayWidth = EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH, displayHeight = EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT): VideoFrame {
    return {
        close,
        displayHeight,
        displayWidth
    } as unknown as VideoFrame;
}

/** Creates a device whose readbacks of the authorization target return the observations. */
function createDeviceHarness(observations: readonly RawHDRVectorObservation[]): WebGPUDeviceHarness {
    const observationMap = new Map<string, ColorTriplet>();
    for (const observation of observations) {
        observationMap.set(`${observation.sampleX}:${observation.sampleY}`, observation.linearRGB);
    }
    return createWebGPUDeviceHarness({
        readPixel: (texel: ReadbackTexel): ColorTriplet | undefined => observationMap.get(`${texel.sampleX}:${texel.sampleY}`)
    });
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

function createRunner(
    createFrameFactory: ExternalHDRAuthorizationFrameFactory,
    session: CapabilityProbeSession = createCapabilityProbeSession()
): ExternalHDRPresentationAuthorizationRunner {
    return new ExternalHDRPresentationAuthorizationRunner(createFrameFactory, (): CapabilityProbeSession => session);
}

async function validateRoute(
    runner: ExternalHDRPresentationAuthorizationRunner,
    device: GPUDevice,
    routeKey: ExternalHDRAuthorizationRouteKey,
    targetFormat: GPUTextureFormat = TARGET_FORMAT
): Promise<ExternalHDRRouteAuthorizationDecision> {
    const codec: ExternalHDRVideoCodec = routeKey === AV1_PQ_ROUTE_KEY || routeKey === AV1_HLG_ROUTE_KEY ? 'av1' : 'hevc';
    const [ decision ] = await runner.validate(device, targetFormat, codec, [ routeKey ]);
    return decision;
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
    // The runner checks the configuration itself, so every test has a decoder that supports it unless the test says otherwise
    let isConfigSupported: Mock<(config: VideoDecoderConfig) => Promise<VideoDecoderSupport>>;

    beforeEach(() => {
        restoreWebGPUGlobals = installWebGPUGlobals();
        vi.spyOn(PresentationExecutor, 'create');
        isConfigSupported = vi.fn(async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({ config, supported: true }));
        vi.stubGlobal('VideoDecoder', { isConfigSupported });
        vi.stubGlobal('EncodedVideoChunk', class {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
        restoreWebGPUGlobals();
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
            const runner = createRunner(async (): Promise<VideoFrame> => frame);

            const decision = await validateRoute(runner, harness.device, routeKey);

            // The signature covers exactly the modules the executor compiled
            expect(decision).toMatchObject({
                authorizedRouteKeys: [ routeKey ],
                failureReason: null,
                routeKey,
                sampleCount: VECTOR_SAMPLE_COUNT,
                shaderSignature: createExternalHDRShaderSignature(
                    TARGET_FORMAT,
                    routeKey,
                    getShaderCodes(harness).join(PLAN_SHADER_CODE_SEPARATOR)
                ),
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
            const renderSettingsWrites = getBufferWrites(harness, RENDER_SETTINGS_LABEL);
            expect(renderSettingsWrites).toHaveLength(1);
            expect(renderSettingsWrites[0].bytes.byteLength).toBe(RENDER_SETTINGS_UNIFORM_BYTE_LENGTH);
            expect(harness.importExternalTexture).toHaveBeenCalledExactlyOnceWith({ colorSpace: EXTERNAL_TEXTURE_COLOR_SPACE, source: frame });
            // One pass draws the frame 1:1 into the whole target
            expect(harness.renderPasses).toHaveLength(1);
            expect(harness.renderPasses[0]).toMatchObject({
                drawVertexCounts: [ RENDER_VERTEX_COUNT ],
                viewport: [ 0, 0, EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH, EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT, 0, 1 ]
            });
            expect(close).toHaveBeenCalledOnce();
            expectEveryResourceDestroyed(harness);
        }
    );

    it.each([
        [ AV1_PQ_ROUTE_KEY, createPQColorMetadata() ],
        [ AV1_HLG_ROUTE_KEY, createHLGColorMetadata() ]
    ])('authorizes %s from a decoded AV1 vector, read at the AV1 vector\'s own samples', async (routeKey, metadata) => {
        const expectedObservations = createExpectedObservations(routeKey);
        const harness = createDeviceHarness(expectedObservations);
        const close = vi.fn();
        const createFrameFactory = vi.fn(async (): Promise<VideoFrame> => createFrame(
            close,
            EXTERNAL_AV1_HDR_AUTHORIZATION_DISPLAY_WIDTH,
            EXTERNAL_AV1_HDR_AUTHORIZATION_DISPLAY_HEIGHT
        ));
        const runner = createRunner(createFrameFactory);

        const decision = await validateRoute(runner, harness.device, routeKey);

        expect(decision).toMatchObject({
            authorizedRouteKeys: [ routeKey ],
            routeKey,
            sampleCount: EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_SAMPLES.length,
            status: 'authorized',
            vectorVersion: EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_VERSION
        });
        expect(createFrameFactory).toHaveBeenCalledWith('av1', expect.any(AbortSignal));
        expect(createBuiltinChain).toHaveBeenCalledWith(expect.objectContaining({ metadata, route: 'external-hdr' }));
        expect(expectedObservations.map(({ sampleX, sampleY }) => [ sampleX, sampleY ])).toEqual(
            EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_SAMPLES.map(({ sampleX, sampleY }) => [ sampleX, sampleY ])
        );
        expect(close).toHaveBeenCalledOnce();
        expectEveryResourceDestroyed(harness);
    });

    it('keeps each codec\'s route keys apart and prewarms only HEVC\'s', async () => {
        const harness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const runner = createRunner(async (): Promise<VideoFrame> => createFrame(vi.fn()));
        const validate = vi.spyOn(runner, 'validate');
        const registry = new ExternalHDRPresentationAuthorizationRegistry(runner);

        registry.prewarm(harness.device, TARGET_FORMAT);
        await registry.waitForPending(harness.device, TARGET_FORMAT);

        expect(validate.mock.calls.map(call => [ call[2], call[3] ])).toEqual([ [ 'hevc', [ PQ_ROUTE_KEY, HLG_ROUTE_KEY ] ] ]);
        expect(registry.isAuthorized(harness.device, TARGET_FORMAT, 'hevc', createPQColorMetadata())).toBe(true);
        expect(registry.getAuthorizationFailure(harness.device, TARGET_FORMAT, 'av1', createPQColorMetadata())).toBe(`unprobed: ${AV1_PQ_ROUTE_KEY}`);
        expect(registry.getAuthorizationFailure(harness.device, TARGET_FORMAT, 'av1', createSDRColorMetadata())).toBe(SDR_ROUTE_UNSUPPORTED_FAILURE);
    });

    it('rejects a bounded pixel mismatch and still closes the frame', async () => {
        const harness = createDeviceHarness(mutateFirstObservation(createExpectedObservations(PQ_ROUTE_KEY)));
        const close = vi.fn();
        const runner = createRunner(async (): Promise<VideoFrame> => createFrame(close));

        const decision = await validateRoute(runner, harness.device, PQ_ROUTE_KEY);

        expect(decision).toMatchObject({
            failureReason: 'pixel-mismatch',
            status: 'rejected'
        });
        expect(decision.failureDetail).toMatch(PIXEL_MISMATCH_DETAIL_PATTERN);
        expect(close).toHaveBeenCalledOnce();
    });

    it('classifies a frame the executor cannot import and closes the frame', async () => {
        const harness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        harness.importExternalTexture.mockImplementationOnce(() => {
            throw new Error(SIMULATED_IMPORT_FAILURE);
        });
        const close = vi.fn();
        const runner = createRunner(async (): Promise<VideoFrame> => createFrame(close));

        await expect(validateRoute(runner, harness.device, PQ_ROUTE_KEY)).resolves.toMatchObject({
            failureDetail: `import: ${SIMULATED_IMPORT_FAILURE}`,
            failureReason: 'frame-import-failed',
            status: 'rejected'
        });
        expect(close).toHaveBeenCalledOnce();
        expect(harness.renderPasses).toEqual([]);
        expectEveryResourceDestroyed(harness);
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
        const runner = createRunner(createFrameFactory);

        const decisionPromise = validateRoute(runner, harness.device, PQ_ROUTE_KEY);
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
        const runner = createRunner(async (): Promise<VideoFrame> => createFrame(vi.fn()));
        const validate = vi.spyOn(runner, 'validate');
        const registry = new ExternalHDRPresentationAuthorizationRegistry(runner);

        const firstDecision = registry.authorize(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);
        const secondDecision = registry.authorize(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);
        expect(secondDecision).toBe(firstDecision);
        expect(registry.getTelemetry(harness.device, TARGET_FORMAT).status).toBe('pending');
        expect(registry.getAuthorizationFailure(harness.device, TARGET_FORMAT, 'hevc', createPQColorMetadata())).toBe(`pending: ${PQ_ROUTE_KEY}`);

        const decision: ExternalHDRRouteAuthorizationDecision = await firstDecision;
        expect(decision.status).toBe('authorized');
        expect(validate).toHaveBeenCalledOnce();
        expect(registry.isAuthorized(harness.device, TARGET_FORMAT, 'hevc', createPQColorMetadata())).toBe(true);
        expect(registry.isAuthorized(harness.device, TARGET_FORMAT, 'hevc', createHLGColorMetadata())).toBe(false);
        expect(registry.getAuthorizationFailure(harness.device, TARGET_FORMAT, 'hevc', createHLGColorMetadata())).toBe(`unprobed: ${HLG_ROUTE_KEY}`);
        expect(registry.getAuthorizationFailure(harness.device, TARGET_FORMAT, 'hevc', createSDRColorMetadata())).toBe(SDR_ROUTE_UNSUPPORTED_FAILURE);
        expect(registry.getTelemetry(harness.device, TARGET_FORMAT)).toMatchObject({
            authorizedRouteKeys: [ PQ_ROUTE_KEY ],
            failureDetails: {},
            status: 'authorized',
            targetFormat: TARGET_FORMAT
        });
    });

    it('reports a rejected route with its failure reason and detail', async () => {
        const harness = createDeviceHarness(mutateFirstObservation(createExpectedObservations(PQ_ROUTE_KEY)));
        const runner = createRunner(async (): Promise<VideoFrame> => createFrame(vi.fn()));
        const registry = new ExternalHDRPresentationAuthorizationRegistry(runner);

        const decision = await registry.authorize(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);

        expect(registry.getAuthorizationFailure(harness.device, TARGET_FORMAT, 'hevc', createPQColorMetadata()))
            .toBe(`pixel-mismatch: ${PQ_ROUTE_KEY} ${decision.failureDetail}`);
        expect(registry.getTelemetry(harness.device, TARGET_FORMAT).failureDetails).toEqual({ [PQ_ROUTE_KEY]: decision.failureDetail });
    });

    it('scopes authorization to exact GPUDevice identity', async () => {
        const firstHarness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const secondHarness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const runner = createRunner(async (): Promise<VideoFrame> => createFrame(vi.fn()));
        const validate = vi.spyOn(runner, 'validate');
        const registry = new ExternalHDRPresentationAuthorizationRegistry(runner);

        await registry.authorize(firstHarness.device, TARGET_FORMAT, PQ_ROUTE_KEY);
        expect(registry.isAuthorized(secondHarness.device, TARGET_FORMAT, 'hevc', createPQColorMetadata())).toBe(false);
        await registry.authorize(secondHarness.device, TARGET_FORMAT, PQ_ROUTE_KEY);

        expect(validate).toHaveBeenCalledTimes(2);
        expect(registry.isAuthorized(secondHarness.device, TARGET_FORMAT, 'hevc', createPQColorMetadata())).toBe(true);
    });

    it('rejects unsupported targets before constructing a frame', async () => {
        const harness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const createFrameFactory = vi.fn(async (): Promise<VideoFrame> => createFrame(vi.fn()));
        const runner = createRunner(createFrameFactory);

        await expect(validateRoute(runner, harness.device, PQ_ROUTE_KEY, UNREADABLE_TARGET_FORMAT)).resolves.toMatchObject({
            failureDetail: UNREADABLE_TARGET_FORMAT,
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

        const frame = await createExternalHDRAuthorizationFrame('hevc');

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

    it('decodes the AV1 vector with every sequence header neutralized, as AV1 Main 10 in hardware', async () => {
        const configured = vi.fn();
        let decodedTemporalUnit: Uint8Array | null = null;
        const outputFrame = {
            close: vi.fn(),
            codedHeight: 1_080,
            codedWidth: 1_920,
            colorSpace: { fullRange: false, matrix: 'bt709', primaries: 'bt709', transfer: 'bt709' },
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
                decodedTemporalUnit = ArrayBuffer.isView(source) ?
                    new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice() :
                    new Uint8Array(source).slice();
            }
        }
        class FakeVideoDecoder {
            public static readonly isConfigSupported = vi.fn(
                async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({ config, supported: true })
            );

            public constructor(init: VideoDecoderInit) {
                decoderInit = init;
            }

            public close(): void {
                return undefined;
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

        await expect(createExternalHDRAuthorizationFrame('av1')).resolves.toBe(outputFrame);

        expect(configured).toHaveBeenCalledWith(expect.objectContaining({
            codec: 'av01.0.08M.10',
            codedHeight: 1_080,
            codedWidth: 1_920,
            hardwareAcceleration: 'prefer-hardware'
        }));
        expect(findAV1SequenceHeader(decodedTemporalUnit as unknown as Uint8Array)?.colorConfig).toMatchObject({
            bitDepth: 10,
            colorDescriptionPresent: true,
            colorPrimaries: 1,
            fullRange: false,
            matrixCoefficients: 1,
            transferCharacteristics: 1
        });
    });

    it('rejects a decoded AV1 frame of the HEVC vector\'s coded size', async () => {
        let decoderInit: VideoDecoderInit | null = null;
        const close = vi.fn();
        class FakeEncodedVideoChunk {}
        class FakeVideoDecoder {
            public static readonly isConfigSupported = vi.fn(
                async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({ config, supported: true })
            );

            public constructor(init: VideoDecoderInit) {
                decoderInit = init;
            }

            public close(): void {
                return undefined;
            }

            public configure(): void {
                return undefined;
            }

            public decode(): void {
                decoderInit?.output({
                    close,
                    codedHeight: 1_088,
                    codedWidth: 1_920,
                    colorSpace: { fullRange: false, matrix: 'bt709', primaries: 'bt709', transfer: 'bt709' },
                    displayHeight: 1_080,
                    displayWidth: 1_920,
                    format: null,
                    timestamp: 0,
                    visibleRect: { height: 1_080, width: 1_920, x: 0, y: 0 }
                } as unknown as VideoFrame);
            }

            public async flush(): Promise<void> {
                return undefined;
            }
        }
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);

        await expect(createExternalHDRAuthorizationFrame('av1')).rejects.toThrow('decoder-output-mismatch');
        expect(close).toHaveBeenCalledOnce();
    });

    it('rejects an unsupported decoder configuration before building an executor or opening a decoder', async () => {
        isConfigSupported.mockImplementation(async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({ config, supported: false }));
        const harness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const createFrameFactory = vi.fn(async (): Promise<VideoFrame> => createFrame(vi.fn()));

        await expect(validateRoute(createRunner(createFrameFactory), harness.device, PQ_ROUTE_KEY)).resolves.toMatchObject({
            failureDetail: HEVC_CHECK_LABEL,
            failureReason: 'decoder-config-unsupported',
            status: 'rejected'
        });
        expect(isConfigSupported).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            codec: 'hvc1.2.4.L120.B0',
            codedHeight: 1_088,
            codedWidth: 1_920,
            hardwareAcceleration: 'prefer-hardware'
        }));
        expect(createFrameFactory).not.toHaveBeenCalled();
        expect(PresentationExecutor.create).not.toHaveBeenCalled();
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

        await expect(createExternalHDRAuthorizationFrame('hevc')).rejects.toThrow('vector decode failed');
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

        const framePromise = createExternalHDRAuthorizationFrame('hevc', abortController.signal);
        await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
        abortController.abort();

        await expect(framePromise).rejects.toMatchObject({ name: 'AbortError' });
        expect(closed).toHaveBeenCalledOnce();
    });

    it.each([
        [ PQ_ROUTE_KEY, HEVC_PROBE, HEVC_CHECK_LABEL, HEVC_DECODE_LABEL, HEVC_DECODE_COST ],
        [ AV1_PQ_ROUTE_KEY, AV1_PROBE, AV1_CHECK_LABEL, AV1_DECODE_LABEL, AV1_DECODE_COST ]
    ])('journals the check and the decode of %s as steps of its probe', async (routeKey, probe, checkLabel, decodeLabel, decodeCost) => {
        const harness = createDeviceHarness(createExpectedObservations(routeKey));
        const recording = createRecordingStore();
        const inFlightDuringCheck: string[][] = [];
        isConfigSupported.mockImplementation(async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => {
            inFlightDuringCheck.push(recording.inFlight());
            return { config, supported: true };
        });
        const inFlightDuringDecode: string[][] = [];
        const createFrameFactory = vi.fn(async (): Promise<VideoFrame> => {
            inFlightDuringDecode.push(recording.inFlight());
            return routeKey === AV1_PQ_ROUTE_KEY ?
                createFrame(vi.fn(), EXTERNAL_AV1_HDR_AUTHORIZATION_DISPLAY_WIDTH, EXTERNAL_AV1_HDR_AUTHORIZATION_DISPLAY_HEIGHT) :
                createFrame(vi.fn());
        });
        const inFlightDuringImport: string[][] = [];
        const importExternalTexture = harness.importExternalTexture.getMockImplementation();
        harness.importExternalTexture.mockImplementation((descriptor: GPUExternalTextureDescriptor): unknown => {
            inFlightDuringImport.push(recording.inFlight());
            return importExternalTexture?.(descriptor);
        });
        const runner = createRunner(createFrameFactory, createCapabilityProbeSession({ store: recording.store }));

        await expect(validateRoute(runner, harness.device, routeKey)).resolves.toMatchObject({ status: 'authorized' });

        expect(recording.markRunning.mock.calls).toEqual([
            [ probe, checkLabel, { bytes: 0, decoders: 1 } ],
            [ probe, decodeLabel, decodeCost ]
        ]);
        expect(inFlightDuringCheck).toEqual([ [ checkLabel ] ]);
        // The import and render of the frame run inside the decode step, so a page that stops in them names it
        expect(inFlightDuringDecode).toEqual([ [ decodeLabel ] ]);
        expect(inFlightDuringImport).toEqual([ [ decodeLabel ] ]);
        expect(recording.inFlight()).toEqual([]);
        // The check settles before any executor is built
        expect(isConfigSupported.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(PresentationExecutor.create).mock.invocationCallOrder[0]);
    });

    it('rejects the routes of a blocked check without a decoder call', async () => {
        const harness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const recording = createRecordingStore({ blocked: new Set([ HEVC_CHECK_LABEL ]) });
        const createFrameFactory = vi.fn(async (): Promise<VideoFrame> => createFrame(vi.fn()));
        const runner = createRunner(createFrameFactory, createCapabilityProbeSession({ store: recording.store }));

        await expect(validateRoute(runner, harness.device, PQ_ROUTE_KEY)).resolves.toMatchObject({
            failureDetail: HEVC_CHECK_LABEL,
            failureReason: 'stopped-page',
            status: 'rejected'
        });
        expect(isConfigSupported).not.toHaveBeenCalled();
        expect(createFrameFactory).not.toHaveBeenCalled();
        expect(PresentationExecutor.create).not.toHaveBeenCalled();
        expect(recording.markRunning).not.toHaveBeenCalled();
    });

    it('rejects the routes of a blocked decode without opening a decoder', async () => {
        const harness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const recording = createRecordingStore({ blocked: new Set([ HEVC_DECODE_LABEL ]) });
        const createFrameFactory = vi.fn(async (): Promise<VideoFrame> => createFrame(vi.fn()));
        const runner = createRunner(createFrameFactory, createCapabilityProbeSession({ store: recording.store }));

        await expect(validateRoute(runner, harness.device, PQ_ROUTE_KEY)).resolves.toMatchObject({
            failureDetail: HEVC_DECODE_LABEL,
            failureReason: 'stopped-page',
            status: 'rejected'
        });
        expect(isConfigSupported).toHaveBeenCalledOnce();
        expect(createFrameFactory).not.toHaveBeenCalled();
        expect(harness.importExternalTexture).not.toHaveBeenCalled();
        await vi.waitFor(() => expectEveryResourceDestroyed(harness));
    });

    it('decodes the HEVC vector once for prewarmed PQ and HLG, and closes the frame once', async () => {
        const pqObservations = createExpectedObservations(PQ_ROUTE_KEY);
        const hlgObservations = createExpectedObservations(HLG_ROUTE_KEY);
        // The routes render one after the other from the one frame, PQ first, each in one render pass
        const harness = createWebGPUDeviceHarness({
            readPixel: (texel: ReadbackTexel): ColorTriplet | undefined => (texel.renderPassCount === 1 ? pqObservations : hlgObservations)
                .find(observation => observation.sampleX === texel.sampleX && observation.sampleY === texel.sampleY)?.linearRGB
        });
        const close = vi.fn();
        const createFrameFactory = vi.fn(async (): Promise<VideoFrame> => createFrame(close));
        const registry = new ExternalHDRPresentationAuthorizationRegistry(createRunner(createFrameFactory));

        registry.prewarm(harness.device, TARGET_FORMAT);
        await registry.waitForPending(harness.device, TARGET_FORMAT);

        expect(isConfigSupported).toHaveBeenCalledOnce();
        expect(createFrameFactory).toHaveBeenCalledOnce();
        expect(harness.importExternalTexture).toHaveBeenCalledTimes(2);
        expect(close).toHaveBeenCalledOnce();
        expect(registry.getTelemetry(harness.device, TARGET_FORMAT).authorizedRouteKeys).toEqual([ PQ_ROUTE_KEY, HLG_ROUTE_KEY ]);
        await vi.waitFor(() => expectEveryResourceDestroyed(harness));
    });

    it('starts a codec\'s next decode on a device only once its last one settles', async () => {
        const harness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const firstFrame = createDeferred<VideoFrame>();
        const createFrameFactory = vi.fn<ExternalHDRAuthorizationFrameFactory>()
            .mockReturnValueOnce(firstFrame.promise)
            .mockImplementation(async (): Promise<VideoFrame> => createFrame(vi.fn()));
        const registry = new ExternalHDRPresentationAuthorizationRegistry(createRunner(createFrameFactory));

        const pqDecision = registry.authorize(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);
        await vi.waitFor(() => expect(createFrameFactory).toHaveBeenCalledOnce());
        const hlgDecision = registry.authorize(harness.device, TARGET_FORMAT, HLG_ROUTE_KEY);
        const firstClose = vi.fn();
        firstFrame.resolve(createFrame(firstClose));
        await expect(pqDecision).resolves.toMatchObject({ status: 'authorized' });
        await hlgDecision;

        expect(isConfigSupported).toHaveBeenCalledTimes(2);
        expect(createFrameFactory).toHaveBeenCalledTimes(2);
        // HLG, asked for while PQ's decode ran, began its check only once PQ's decode closed its frame
        expect(isConfigSupported.mock.invocationCallOrder[1]).toBeGreaterThan(firstClose.mock.invocationCallOrder[0]);
    });

    it('opens no decoder once the deadline passes during the check', async () => {
        vi.useFakeTimers();
        const harness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const support = createDeferred<VideoDecoderSupport>();
        isConfigSupported.mockReturnValueOnce(support.promise);
        const createFrameFactory = vi.fn(async (): Promise<VideoFrame> => createFrame(vi.fn()));
        // The session would wait for the check longer than the authorization does, so the authorization's deadline passes during it
        const session = createCapabilityProbeSession({ timeoutMilliseconds: AUTHORIZATION_TIMEOUT_MILLISECONDS * 2 });

        const decisionPromise = validateRoute(createRunner(createFrameFactory, session), harness.device, PQ_ROUTE_KEY);
        await vi.waitFor(() => expect(isConfigSupported).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(AUTHORIZATION_TIMEOUT_MILLISECONDS);
        await expect(decisionPromise).resolves.toMatchObject({ failureReason: 'timeout', status: 'rejected' });

        support.resolve({ supported: true });
        await vi.runAllTimersAsync();
        expect(PresentationExecutor.create).not.toHaveBeenCalled();
        expect(createFrameFactory).not.toHaveBeenCalled();
    });

    it('pops the validation scope right after the submit, and never twice when its result never comes', async () => {
        vi.useFakeTimers();
        const harness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        harness.popErrorScope.mockReturnValue(new Promise<GPUError | null>(() => undefined));
        const runner = createRunner(async (): Promise<VideoFrame> => createFrame(vi.fn()));

        const decisionPromise = validateRoute(runner, harness.device, PQ_ROUTE_KEY);
        await vi.waitFor(() => expect(harness.queueSubmit).toHaveBeenCalledOnce());
        const [ submitOrder ] = harness.queueSubmit.mock.invocationCallOrder;
        const popOrder = harness.popErrorScope.mock.invocationCallOrder.find(order => order > submitOrder);
        expect(popOrder).toBeDefined();
        expect(popOrder).toBeLessThan(harness.queueOnSubmittedWorkDone.mock.invocationCallOrder[0]);

        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);
        await expect(decisionPromise).resolves.toMatchObject({ failureReason: 'timeout', status: 'rejected' });
        await vi.runAllTimersAsync();
        expect(harness.popErrorScope).toHaveBeenCalledTimes(harness.pushErrorScope.mock.calls.length);
        expectEveryResourceDestroyed(harness);
    });

    it('probes a route again after a timeout, which it does not keep', async () => {
        vi.useFakeTimers();
        const harness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const createFrameFactory = vi.fn<ExternalHDRAuthorizationFrameFactory>()
            .mockReturnValueOnce(new Promise<VideoFrame>(() => undefined))
            .mockImplementation(async (): Promise<VideoFrame> => createFrame(vi.fn()));
        const registry = new ExternalHDRPresentationAuthorizationRegistry(createRunner(createFrameFactory));

        const firstDecision = registry.authorize(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);
        await vi.waitFor(() => expect(createFrameFactory).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);
        await expect(firstDecision).resolves.toMatchObject({ failureReason: 'timeout' });
        expect(registry.getAuthorizationFailure(harness.device, TARGET_FORMAT, 'hevc', createPQColorMetadata()))
            .toMatch(new RegExp(`^timeout: ${PQ_ROUTE_KEY} `, 'u'));
        await vi.runAllTimersAsync();
        vi.useRealTimers();

        const secondDecision = registry.authorize(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);
        expect(secondDecision).not.toBe(firstDecision);
        await expect(secondDecision).resolves.toMatchObject({ status: 'authorized' });
        expect(createFrameFactory).toHaveBeenCalledTimes(2);
        expect(registry.isAuthorized(harness.device, TARGET_FORMAT, 'hevc', createPQColorMetadata())).toBe(true);
    });
});
