import { describe, expect, it, vi, type Mock } from 'vitest';

import type { CustomPlaybackEligibility, EligibleCustomPlayback } from 'webgpu-player/capability/CustomPlaybackEligibility';
import { GPU_DECODE_SLICE_DISPATCH_COUNT } from 'webgpu-player/decode/video/gpu/GPUDecodeLimits';
import type { GPUDecodePacket } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';
import {
    alignPresentationInputBitDepth,
    configurePresentationColorPipeline,
    createGPUVideoDecodeSessionFactory,
    EMPTY_PRESENTATION_INPUT,
    getCustomPresentationEligibilityOptions,
    getStaticHDRRenderSettings,
    isWebGPUPresentationInput,
    readPresentationInput,
    type ColorPipelineRequest,
    type HDRRenderConfiguration,
    type PresentationAuthorizationRequest
} from 'webgpu-player/presentation/PresentationSetup';
import { createDefaultRenderSettings, createHDRToSDRRenderSettings } from 'webgpu-player/presentation/RenderSettings';
import type WebGPUPresenter from 'webgpu-player/presentation/WebGPUPresenter';
import type { StaticHDRMetadata } from 'webgpu-player/demux/hdr/StaticHDRMetadata';

import { MockGPUDevice } from '../decode/video/gpu/mockGPUDevice';
import { installWebGPUGlobals } from '../decode/video/gpu/webGPUGlobals';
import {
    createVideoDecoderPackageForTest,
    createVideoDecoderSource,
    TEST_DECODER_CODEC,
    TEST_DECODER_ENTRY_POINT,
    TEST_DECODER_OUTPUT_FORMAT
} from '../helpers/decoderPackages';

const GENERATION = 7;
const DOLBY_VISION_INPUT_PEAK_NITS = 4_000;
const STATIC_PEAK_NITS = 1_600;
const CURRENT_PEAK_NITS = 1_000;
const RAW_SDR_ROUTE_KEY = 'I420:bt709:bt709:limited:sdr';
// The fields a progressive stream without a size declares, and an interlaced 576-line stream's size
const PROGRESSIVE_FIELDS = { frameHeight: null, frameWidth: null, scan: 'progressive' } as const;
const INTERLACED_WIDTH = 720;
const INTERLACED_HEIGHT = 576;
const RAW_PQ_ROUTE_KEY = 'I420P10:bt2020-ncl:bt2020:limited:pq';
const EXTERNAL_PQ_ROUTE_KEY = 'external-hevc-main10-bt709-limited:pq-v1';

const SDR_STREAM = {
    BitDepth: 8,
    Codec: 'h264',
    ColorPrimaries: 'bt709',
    ColorSpace: 'bt709',
    ColorTransfer: 'bt709',
    IsInterlaced: false,
    Type: 'Video',
    VideoRange: 'SDR',
    VideoRangeType: 'SDR'
};
const HDR10_STREAM = {
    BitDepth: 10,
    Codec: 'hevc',
    ColorPrimaries: 'bt2020',
    ColorRange: 'tv',
    ColorSpace: 'bt2020nc',
    ColorTransfer: 'smpte2084',
    IsInterlaced: false,
    Profile: 'Main 10',
    Type: 'Video',
    VideoRange: 'HDR',
    VideoRangeType: 'HDR10'
};
const AV1_HDR10_STREAM = { ...HDR10_STREAM, Codec: 'av1', Profile: 'Main' };
// Profile 8.1: an HDR10-compatible base with an RPU
const PROFILE_8_STREAM = {
    ...HDR10_STREAM,
    BlPresentFlag: 1,
    DvBlSignalCompatibilityId: 1,
    DvLevel: 6,
    DvProfile: 8,
    ElPresentFlag: 0,
    RpuPresentFlag: 1,
    VideoRangeType: 'DOVI'
};
const PROFILE_5_STREAM = {
    BitDepth: 10,
    BlPresentFlag: 1,
    Codec: 'hevc',
    DvBlSignalCompatibilityId: 0,
    DvProfile: 5,
    ElPresentFlag: 0,
    IsInterlaced: false,
    RpuPresentFlag: 1,
    Type: 'Video',
    VideoRange: 'HDR',
    VideoRangeType: 'DOVI'
};
const STATIC_HDR_METADATA: StaticHDRMetadata = {
    masteringDisplayMaximumLuminanceNits: STATIC_PEAK_NITS,
    masteringDisplayMinimumLuminanceNits: null,
    maximumContentLightLevelNits: null,
    maximumFrameAverageLightLevelNits: null
};
// A decoder whose picture runs its entry point once, then as many times more as a slice carries, so sliced it submits in two slices
const SLICING_DECODER_PACKAGE = createVideoDecoderPackageForTest(createVideoDecoderSource({
    extraDirectives: [ `//! repeat: ${GPU_DECODE_SLICE_DISPATCH_COUNT}, 1`, `//! dispatch: ${TEST_DECODER_ENTRY_POINT}, 1` ]
}));
const SLICED_SUBMIT_COUNT = 2;
const WHOLE_SUBMIT_COUNT = 1;
const SLICING_STREAM_SIZE = 64;
const SLICING_STREAM_BIT_DEPTH = 8;
const SLICING_PACKET_BYTE_LENGTH = 16;
const SLICING_FRAME_DURATION_MICROSECONDS = 40_000;

type FakePresenter = {
    configureColorPipeline: Mock
    getAuthorizedExternalHDRRouteKeys: Mock
    getAuthorizedRawHDRRouteKeys: Mock
    isExternalDolbyVisionPresentationAuthorized: Mock
    isRawDolbyVisionPresentationAuthorized: Mock
    isRawDolbyVisionProfile4PresentationAuthorized: Mock
    isRawDolbyVisionProfile7PresentationAuthorized: Mock
    prewarmDolbyVisionPresentationAuthorization: Mock
    prewarmExternalHDRPresentationAuthorization: Mock
    prewarmRawHDRPresentationAuthorization: Mock
    waitForDolbyVisionAuthorizationPrewarm: Mock
    waitForRawHDRAuthorizationPrewarm: Mock
    waitForRawSDRAuthorizationPrewarm: Mock
};

function createPresenter(): FakePresenter {
    return {
        configureColorPipeline: vi.fn(() => Promise.resolve(true)),
        getAuthorizedExternalHDRRouteKeys: vi.fn(() => [ EXTERNAL_PQ_ROUTE_KEY ]),
        getAuthorizedRawHDRRouteKeys: vi.fn(() => [ RAW_SDR_ROUTE_KEY, RAW_PQ_ROUTE_KEY ]),
        isExternalDolbyVisionPresentationAuthorized: vi.fn(() => false),
        isRawDolbyVisionPresentationAuthorized: vi.fn(() => true),
        isRawDolbyVisionProfile4PresentationAuthorized: vi.fn(() => false),
        isRawDolbyVisionProfile7PresentationAuthorized: vi.fn(() => false),
        prewarmDolbyVisionPresentationAuthorization: vi.fn(() => Promise.resolve()),
        prewarmExternalHDRPresentationAuthorization: vi.fn(() => Promise.resolve()),
        prewarmRawHDRPresentationAuthorization: vi.fn(() => Promise.resolve()),
        waitForDolbyVisionAuthorizationPrewarm: vi.fn(() => Promise.resolve()),
        waitForRawHDRAuthorizationPrewarm: vi.fn(() => Promise.resolve()),
        waitForRawSDRAuthorizationPrewarm: vi.fn(() => Promise.resolve())
    };
}

function asPresenter(presenter: FakePresenter): WebGPUPresenter {
    return presenter as unknown as WebGPUPresenter;
}

function createOptions(stream: Readonly<Record<string, unknown>>): unknown {
    return { mediaSource: { MediaStreams: [ stream ] } };
}

/** The host's render configuration: the detected peak as the input peak, which follows it automatically. */
function createHDRRenderConfiguration(detectedInputPeakNits: number): HDRRenderConfiguration {
    return {
        automaticInputPeakNits: true,
        settings: createHDRToSDRRenderSettings({ toneMapping: { inputPeakNits: detectedInputPeakNits } })
    };
}

function createColorPipelineRequest(stream: Readonly<Record<string, unknown>>, overrides: Partial<ColorPipelineRequest> = {}): ColorPipelineRequest {
    const options = createOptions(stream);
    return {
        clearDetectedInputPeak: vi.fn(),
        createHDRRenderConfiguration: vi.fn(createHDRRenderConfiguration),
        dolbyVisionProfile: null,
        eligibility: null,
        generation: GENERATION,
        input: readPresentationInput(options),
        options,
        rawVideoFrameFormat: null,
        videoOutputMode: 'video-frame',
        ...overrides
    };
}

function createAuthorizationRequest(
    stream: Readonly<Record<string, unknown>>,
    overrides: Partial<PresentationAuthorizationRequest> = {}
): PresentationAuthorizationRequest {
    const options = createOptions(stream);
    return {
        input: readPresentationInput(options),
        isCurrent: (): boolean => true,
        isHDRToneMappingEnabled: vi.fn(() => Promise.resolve(true)),
        options,
        ...overrides
    };
}

/** An eligibility that chose a route; only the route fields matter here. */
function createEligibility(route: Partial<EligibleCustomPlayback>): CustomPlaybackEligibility {
    return { dolbyVisionProfile: null, eligible: true, nativeHDRTransfer: undefined, neutralizeHDRColorMetadata: false, ...route } as unknown as CustomPlaybackEligibility;
}

describe('PresentationSetup', () => {
    it('presents known SDR always, and HDR and Dolby Vision only while custom decode is enabled', () => {
        for (const stream of [ SDR_STREAM, HDR10_STREAM, PROFILE_8_STREAM ]) {
            const options = createOptions(stream);
            const input = readPresentationInput(options);
            expect(isWebGPUPresentationInput(options, input, true)).toBe(true);
            expect(isWebGPUPresentationInput(options, input, false)).toBe(stream === SDR_STREAM);
        }
        expect(isWebGPUPresentationInput({}, EMPTY_PRESENTATION_INPUT, true)).toBe(false);
    });

    it('fixes the input depth to the raw plane format', () => {
        const input = readPresentationInput(createOptions(HDR10_STREAM));

        expect(alignPresentationInputBitDepth(input, 'I420P12').colorMetadata?.bitDepth).toBe(12);
        expect(alignPresentationInputBitDepth(input, null)).toBe(input);
    });

    describe('configurePresentationColorPipeline', () => {
        it('presents SDR VideoFrames through the default settings, without a detected peak', async () => {
            const presenter = createPresenter();
            const request = createColorPipelineRequest(SDR_STREAM);

            await expect(configurePresentationColorPipeline(asPresenter(presenter), request)).resolves.toBe(true);

            expect(presenter.configureColorPipeline).toHaveBeenCalledWith({ settings: createDefaultRenderSettings(), videoFields: PROGRESSIVE_FIELDS }, GENERATION);
            expect(request.clearDetectedInputPeak).toHaveBeenCalledTimes(1);
        });

        it('carries the stream\'s declared fields: its field order in ffprobe\'s names, or its interlaced flag, and its size', async () => {
            const presenter = createPresenter();
            const bottomFirstStream = { ...SDR_STREAM, FieldOrder: 'tb', Height: INTERLACED_HEIGHT, IsInterlaced: true, Width: INTERLACED_WIDTH };
            const orderlessStream = { ...SDR_STREAM, IsInterlaced: true };
            const undeclaredStream = { ...SDR_STREAM, IsInterlaced: undefined };

            await configurePresentationColorPipeline(asPresenter(presenter), createColorPipelineRequest(bottomFirstStream));
            await configurePresentationColorPipeline(asPresenter(presenter), createColorPipelineRequest(orderlessStream));
            await configurePresentationColorPipeline(asPresenter(presenter), createColorPipelineRequest(undeclaredStream));

            expect(presenter.configureColorPipeline).toHaveBeenNthCalledWith(1, expect.objectContaining({
                videoFields: { frameHeight: INTERLACED_HEIGHT, frameWidth: INTERLACED_WIDTH, scan: 'bottom-first' }
            }), GENERATION);
            expect(presenter.configureColorPipeline).toHaveBeenNthCalledWith(2, expect.objectContaining({
                videoFields: { frameHeight: null, frameWidth: null, scan: 'interlaced' }
            }), GENERATION);
            expect(presenter.configureColorPipeline).toHaveBeenNthCalledWith(3, expect.objectContaining({
                videoFields: { frameHeight: null, frameWidth: null, scan: 'unknown' }
            }), GENERATION);
        });

        it('presents HDR10 through raw YUV planes or as external HDR, from the stream\'s nominal peak', async () => {
            const presenter = createPresenter();
            const rawRequest = createColorPipelineRequest(HDR10_STREAM, { rawVideoFrameFormat: 'I420P10', videoOutputMode: 'raw-planes' });
            const metadata = rawRequest.input.colorMetadata;

            await configurePresentationColorPipeline(asPresenter(presenter), rawRequest);
            await configurePresentationColorPipeline(asPresenter(presenter), createColorPipelineRequest(HDR10_STREAM));

            expect(metadata).not.toBeNull();
            expect(presenter.configureColorPipeline).toHaveBeenNthCalledWith(1, {
                ...createHDRRenderConfiguration(metadata?.nominalPeakNits ?? 0),
                inputMode: 'raw-yuv',
                metadata,
                rawFrameFormat: 'I420P10',
                videoFields: PROGRESSIVE_FIELDS
            }, GENERATION);
            expect(presenter.configureColorPipeline).toHaveBeenNthCalledWith(2, {
                ...createHDRRenderConfiguration(metadata?.nominalPeakNits ?? 0),
                inputMode: 'external-hdr',
                metadata,
                videoFields: PROGRESSIVE_FIELDS
            }, GENERATION);
        });

        it('refuses raw planes whose depth differs from the stream\'s', async () => {
            const presenter = createPresenter();
            const request = createColorPipelineRequest(HDR10_STREAM, { rawVideoFrameFormat: 'I420', videoOutputMode: 'raw-planes' });

            await expect(configurePresentationColorPipeline(asPresenter(presenter), request)).resolves.toBe(false);

            expect(presenter.configureColorPipeline).not.toHaveBeenCalled();
        });

        it('reconstructs Dolby Vision through raw planes, or Profile 5 as external VideoFrames', async () => {
            const presenter = createPresenter();

            await configurePresentationColorPipeline(asPresenter(presenter), createColorPipelineRequest(PROFILE_8_STREAM, {
                dolbyVisionProfile: 8,
                rawVideoFrameFormat: 'I420P10',
                videoOutputMode: 'raw-planes'
            }));
            await configurePresentationColorPipeline(asPresenter(presenter), createColorPipelineRequest(PROFILE_5_STREAM, { dolbyVisionProfile: 5 }));

            expect(presenter.configureColorPipeline).toHaveBeenNthCalledWith(1, {
                ...createHDRRenderConfiguration(DOLBY_VISION_INPUT_PEAK_NITS),
                inputMode: 'raw-dolby-vision',
                profile: 8,
                rawFrameFormat: 'I420P10',
                videoFields: PROGRESSIVE_FIELDS
            }, GENERATION);
            expect(presenter.configureColorPipeline).toHaveBeenNthCalledWith(2, {
                ...createHDRRenderConfiguration(DOLBY_VISION_INPUT_PEAK_NITS),
                inputMode: 'external-dolby-vision',
                profile: 5,
                videoFields: PROGRESSIVE_FIELDS
            }, GENERATION);
        });

        it('refuses a reconstruction profile that is not the stream\'s', async () => {
            const presenter = createPresenter();
            const request = createColorPipelineRequest(PROFILE_8_STREAM, { dolbyVisionProfile: 5 });

            await expect(configurePresentationColorPipeline(asPresenter(presenter), request)).resolves.toBe(false);
        });

        it('presents a Dolby Vision base without its RPU: the exact native base as external HDR, any other through its declared color', async () => {
            const presenter = createPresenter();
            const nativeBaseEligibility = createEligibility({ nativeHDRTransfer: 'pq', neutralizeHDRColorMetadata: true });

            await configurePresentationColorPipeline(asPresenter(presenter), createColorPipelineRequest(PROFILE_8_STREAM, { eligibility: nativeBaseEligibility }));
            await configurePresentationColorPipeline(asPresenter(presenter), createColorPipelineRequest(PROFILE_8_STREAM, {
                rawVideoFrameFormat: 'I420P10',
                videoOutputMode: 'raw-planes'
            }));

            expect(presenter.configureColorPipeline).toHaveBeenNthCalledWith(1, expect.objectContaining({ inputMode: 'external-hdr' }), GENERATION);
            expect(presenter.configureColorPipeline).toHaveBeenNthCalledWith(2, expect.objectContaining({
                inputMode: 'raw-yuv',
                metadata: expect.objectContaining({ transfer: 'pq' }) as unknown
            }), GENERATION);
        });
    });

    describe('getCustomPresentationEligibilityOptions', () => {
        it('allows the raw SDR routes alone for SDR, without asking about HDR tone mapping', async () => {
            const presenter = createPresenter();
            const request = createAuthorizationRequest(SDR_STREAM);

            await expect(getCustomPresentationEligibilityOptions(asPresenter(presenter), request)).resolves.toEqual({
                allowDolbyVision: false,
                allowDolbyVisionProfile7: false,
                allowFramePoolHDR: false,
                allowNativeDolbyVision: false,
                allowNativeHDR: false,
                allowRawHDR: false,
                allowRawSDR: true,
                authorizedExternalHDRRouteKeys: [ EXTERNAL_PQ_ROUTE_KEY ],
                authorizedRawHDRRouteKeys: [ RAW_SDR_ROUTE_KEY ]
            });
            expect(request.isHDRToneMappingEnabled).not.toHaveBeenCalled();
        });

        it('allows no HDR route while the host does not tone-map HDR', async () => {
            const request = createAuthorizationRequest(HDR10_STREAM, { isHDRToneMappingEnabled: () => Promise.resolve(false) });

            await expect(getCustomPresentationEligibilityOptions(asPresenter(createPresenter()), request)).resolves.toMatchObject({
                allowFramePoolHDR: false,
                allowNativeHDR: false,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [],
                authorizedRawHDRRouteKeys: [ RAW_SDR_ROUTE_KEY ]
            });
        });

        it('allows the authorized HDR routes, and starts their probes', async () => {
            const presenter = createPresenter();

            await expect(getCustomPresentationEligibilityOptions(asPresenter(presenter), createAuthorizationRequest(HDR10_STREAM))).resolves.toMatchObject({
                // A GPU decoder's HDR needs only the host's tone mapping
                allowFramePoolHDR: true,
                allowNativeHDR: true,
                allowRawHDR: true,
                allowRawSDR: true,
                authorizedExternalHDRRouteKeys: [ EXTERNAL_PQ_ROUTE_KEY ],
                authorizedRawHDRRouteKeys: [ RAW_SDR_ROUTE_KEY, RAW_PQ_ROUTE_KEY ]
            });
            expect(presenter.prewarmExternalHDRPresentationAuthorization).toHaveBeenCalledTimes(1);
            expect(presenter.prewarmRawHDRPresentationAuthorization).toHaveBeenCalledTimes(1);
            // HEVC Main 10 has a native external route, so its raw probes need not settle first
            expect(presenter.waitForRawHDRAuthorizationPrewarm).not.toHaveBeenCalled();
        });

        it('waits for the raw HDR probes of a stream that presents HDR only through raw planes', async () => {
            const presenter = createPresenter();

            await getCustomPresentationEligibilityOptions(asPresenter(presenter), createAuthorizationRequest(AV1_HDR10_STREAM));

            expect(presenter.waitForRawHDRAuthorizationPrewarm).toHaveBeenCalledTimes(1);
        });

        it('waits for the stream\'s own RPU route and allows it once authorized', async () => {
            const presenter = createPresenter();

            await expect(getCustomPresentationEligibilityOptions(asPresenter(presenter), createAuthorizationRequest(PROFILE_8_STREAM))).resolves.toMatchObject({
                allowDolbyVision: true,
                allowDolbyVisionProfile4: false,
                allowDolbyVisionProfile7: false
            });
            expect(presenter.waitForDolbyVisionAuthorizationPrewarm).toHaveBeenCalledWith({ profile: 8, rawFrameFormat: 'I420P10' });
            expect(presenter.isRawDolbyVisionPresentationAuthorized).toHaveBeenCalledWith('I420P10');
        });

        it('resolves null once the playback is no longer current', async () => {
            const request = createAuthorizationRequest(HDR10_STREAM, { isCurrent: (): boolean => false });

            await expect(getCustomPresentationEligibilityOptions(asPresenter(createPresenter()), request)).resolves.toBeNull();
        });
    });

    describe('getStaticHDRRenderSettings', () => {
        const currentSettings = createHDRToSDRRenderSettings({ toneMapping: { inputPeakNits: CURRENT_PEAK_NITS } });

        it('tone-maps PQ input from its static peak while the input peak follows the detected one', () => {
            const options = createOptions(HDR10_STREAM);
            const settings = getStaticHDRRenderSettings({
                createHDRRenderConfiguration,
                currentSettings,
                eligibility: null,
                input: readPresentationInput(options),
                metadata: STATIC_HDR_METADATA,
                options
            });

            expect(settings?.toneMapping.inputPeakNits).toBe(STATIC_PEAK_NITS);
        });

        it('changes nothing for SDR, for a manual input peak, or for the peak already applied', () => {
            const hdrOptions = createOptions(HDR10_STREAM);
            const sdrOptions = createOptions(SDR_STREAM);
            const request = {
                createHDRRenderConfiguration,
                currentSettings,
                eligibility: null,
                input: readPresentationInput(hdrOptions),
                metadata: STATIC_HDR_METADATA,
                options: hdrOptions
            };

            expect(getStaticHDRRenderSettings({ ...request, input: readPresentationInput(sdrOptions), options: sdrOptions })).toBeNull();
            expect(getStaticHDRRenderSettings({
                ...request,
                createHDRRenderConfiguration: (peak: number): HDRRenderConfiguration => ({ ...createHDRRenderConfiguration(peak), automaticInputPeakNits: false })
            })).toBeNull();
            expect(getStaticHDRRenderSettings({
                ...request,
                currentSettings: createHDRToSDRRenderSettings({ toneMapping: { inputPeakNits: STATIC_PEAK_NITS } })
            })).toBeNull();
        });
    });

    describe('createGPUVideoDecodeSessionFactory', () => {
        it.each([
            [ false, WHOLE_SUBMIT_COUNT ],
            [ true, SLICED_SUBMIT_COUNT ]
        ])('creates sessions on the presenter\'s device that slice a large picture\'s decode work only when the host asks, slicing %s', async (slicing: boolean, submitCount: number) => {
            const restoreWebGPUGlobals = installWebGPUGlobals();
            const device = new MockGPUDevice();
            device.manualMaps = true;
            const presenter = { getGPUVideoDecodeDevice: vi.fn(() => Promise.resolve(device.asDevice())) } as unknown as WebGPUPresenter;
            const packet: GPUDecodePacket = {
                data: new ArrayBuffer(SLICING_PACKET_BYTE_LENGTH),
                durationMicroseconds: SLICING_FRAME_DURATION_MICROSECONDS,
                fields: null,
                hold: false,
                keyframe: true,
                outputEvents: null,
                recovery: null,
                repeatCounts: null,
                reset: true,
                timestampMicroseconds: 0,
                visibleSize: null
            };
            try {
                const handle = await createGPUVideoDecodeSessionFactory(presenter, { slicing })({
                    codecPrivate: null,
                    decoder: { codec: TEST_DECODER_CODEC, decoderId: SLICING_DECODER_PACKAGE.id, package: SLICING_DECODER_PACKAGE },
                    format: TEST_DECODER_OUTPUT_FORMAT,
                    maximumPictureSize: null,
                    stream: {
                        bitDepth: SLICING_STREAM_BIT_DEPTH,
                        codedHeight: SLICING_STREAM_SIZE,
                        codedWidth: SLICING_STREAM_SIZE,
                        visibleRectangle: { height: SLICING_STREAM_SIZE, width: SLICING_STREAM_SIZE, x: 0, y: 0 }
                    }
                });
                handle.session.queuePacket(packet);
                while (handle.session.submitPendingDecodeWork()) {
                    // Each call submits one slice
                }

                expect(handle.device).toBe(device.asDevice());
                expect(device.submitCount).toBe(submitCount);
                expect(device.dispatches).toHaveLength(GPU_DECODE_SLICE_DISPATCH_COUNT + 1);
                handle.session.destroy();
            } finally {
                restoreWebGPUGlobals();
            }
        });
    });
});
