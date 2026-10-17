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
    EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT,
    EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH
} from 'webgpu-player/capability/vectors/ExternalHDRAuthorizationVector';
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
    type ExternalHDRAuthorizationRouteKey,
    type ExternalHDRRouteAuthorizationDecision
} from 'webgpu-player/validation/ExternalHDRPresentationAuthorization';
import type { RawHDRVectorObservation } from 'webgpu-player/validation/RawHDRPresentationAuthorization';

import {
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

function createFrame(close: MockFunction): VideoFrame {
    return {
        close,
        displayHeight: EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT,
        displayWidth: EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH
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
        restoreWebGPUGlobals = installWebGPUGlobals();
        vi.spyOn(PresentationExecutor, 'create');
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
            const runner = new ExternalHDRPresentationAuthorizationRunner(async (): Promise<VideoFrame> => frame);

            const decision = await runner.validate(harness.device, TARGET_FORMAT, routeKey);

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

    it('rejects a bounded pixel mismatch and still closes the frame', async () => {
        const harness = createDeviceHarness(mutateFirstObservation(createExpectedObservations(PQ_ROUTE_KEY)));
        const close = vi.fn();
        const runner = new ExternalHDRPresentationAuthorizationRunner(async (): Promise<VideoFrame> => createFrame(close));

        const decision = await runner.validate(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);

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
        const runner = new ExternalHDRPresentationAuthorizationRunner(async (): Promise<VideoFrame> => createFrame(close));

        await expect(runner.validate(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY)).resolves.toMatchObject({
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
        const runner = new ExternalHDRPresentationAuthorizationRunner(createFrameFactory);

        const decisionPromise = runner.validate(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);
        await vi.waitFor(() => expect(createFrameFactory).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(AUTHORIZATION_TIMEOUT_MILLISECONDS);

        await expect(decisionPromise).resolves.toMatchObject({
            failureDetail: 'frame',
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
        expect(registry.getAuthorizationFailure(harness.device, TARGET_FORMAT, createPQColorMetadata())).toBe(`pending: ${PQ_ROUTE_KEY}`);

        const decision: ExternalHDRRouteAuthorizationDecision = await firstDecision;
        expect(decision.status).toBe('authorized');
        expect(validate).toHaveBeenCalledOnce();
        expect(registry.isAuthorized(harness.device, TARGET_FORMAT, createPQColorMetadata())).toBe(true);
        expect(registry.isAuthorized(harness.device, TARGET_FORMAT, createHLGColorMetadata())).toBe(false);
        expect(registry.getAuthorizationFailure(harness.device, TARGET_FORMAT, createHLGColorMetadata())).toBe(`unprobed: ${HLG_ROUTE_KEY}`);
        expect(registry.getAuthorizationFailure(harness.device, TARGET_FORMAT, createSDRColorMetadata())).toBe(SDR_ROUTE_UNSUPPORTED_FAILURE);
        expect(registry.getTelemetry(harness.device, TARGET_FORMAT)).toMatchObject({
            authorizedRouteKeys: [ PQ_ROUTE_KEY ],
            failureDetails: {},
            status: 'authorized',
            targetFormat: TARGET_FORMAT
        });
    });

    it('reports a rejected route with its failure reason and detail', async () => {
        const harness = createDeviceHarness(mutateFirstObservation(createExpectedObservations(PQ_ROUTE_KEY)));
        const runner = new ExternalHDRPresentationAuthorizationRunner(async (): Promise<VideoFrame> => createFrame(vi.fn()));
        const registry = new ExternalHDRPresentationAuthorizationRegistry(runner);

        const decision = await registry.authorize(harness.device, TARGET_FORMAT, PQ_ROUTE_KEY);

        expect(registry.getAuthorizationFailure(harness.device, TARGET_FORMAT, createPQColorMetadata()))
            .toBe(`pixel-mismatch: ${PQ_ROUTE_KEY} ${decision.failureDetail}`);
        expect(registry.getTelemetry(harness.device, TARGET_FORMAT).failureDetails).toEqual({ [PQ_ROUTE_KEY]: decision.failureDetail });
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

        await expect(runner.validate(harness.device, UNREADABLE_TARGET_FORMAT, PQ_ROUTE_KEY)).resolves.toMatchObject({
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
