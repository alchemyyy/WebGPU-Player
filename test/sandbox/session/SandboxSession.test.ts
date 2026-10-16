import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { readPostprocessingPass } from '../../helpers/postprocessingPasses';
import { createInitialSandboxState, type RouteOverride, type SandboxFailure, type SandboxState } from '../../../sandbox/src/contracts/SandboxContracts';
import { BUILT_PASSES_ROUTE } from '../../../sandbox/src/session/BuiltOutputRoutes';
import { createSandboxSession } from '../../../sandbox/src/session/SandboxSession';
import { createStore } from '../../../sandbox/src/ui/Store';
import {
    AUDIO_STREAM_INDEX,
    createAudioStreamJSON,
    createFramesJSON,
    createProbeJSON,
    createSubtitleStreamJSON,
    createVideoStreamJSON,
    SUBTITLE_STREAM_INDEX
} from './ffprobeTestOutput';

const engineMocks = vi.hoisted(() => ({
    configured: true,
    controllers: [] as Array<Record<string, unknown>>,
    // How the session reports a decoder package failure, which it hands its decoder packages
    decoderPackageFailureRecorder: null as ((code: string, detail: string) => void) | null,
    eligibility: null as Record<string, unknown> | null,
    eligibilityCalls: [] as unknown[],
    frameLoops: [] as Array<Record<string, unknown>>,
    // The user's video decoder packages, which a playback may decode its video with
    videoDecoderPackages: [] as unknown[],
    // The presenter's device pool limit, null for a page without a device
    gpuFramePoolByteLimit: null as number | null,
    // What the probed HEVC Main 10 stream decodes as on a GPU decoder
    gpuVideoDecodeTarget: { codec: 'hevc', format: 'I420P10' },
    prewarmLeases: [] as Array<{ close: Mock }>,
    presenterHandlers: null as { fallback: (generation: number, reason: string, detail: string) => void } | null,
    presenters: [] as Array<Record<string, Mock>>,
    tool: null as { convertSubtitleToWebVTT: Mock, probe: Mock } | null
}));

vi.mock('webgpu-player/presentation/WebGPUPresenter', () => ({
    default: class {
        constructor(fallback: (generation: number, reason: string, detail: string) => void) {
            engineMocks.presenterHandlers = { fallback };
            engineMocks.presenters.push(this as unknown as Record<string, Mock>);
        }

        attach = vi.fn();
        endSession = vi.fn();
        getActivePresentationPlan = vi.fn(() => null);
        getDolbyVisionAuthorizationTelemetry = vi.fn(() => null);
        getExternalDolbyVisionAuthorizationTelemetry = vi.fn(() => null);
        getExternalHDRAuthorizationTelemetry = vi.fn(() => null);
        getGPUFramePoolByteLimit = vi.fn(() => Promise.resolve(engineMocks.gpuFramePoolByteLimit));
        getGPUVideoDecodeDevice = vi.fn(() => Promise.resolve(null));
        getPresentationPlanReport = vi.fn(() => ({ activePasses: [], inactivePasses: [] }));
        getRawHDRAuthorizationTelemetry = vi.fn(() => null);
        getRenderSettings = vi.fn(() => ({ mode: 'identity-sdr' }));
        getTelemetry = vi.fn(() => ({ state: 'presenting' }));
        seek = vi.fn();
        setDecodedFramePushMode = vi.fn();
        setDeinterlaceMode = vi.fn(() => Promise.resolve());
        setHDROutputEnabled = vi.fn(() => Promise.resolve());
        setPresentationParameter = vi.fn();
        setPresentationPreset = vi.fn(() => Promise.resolve({ activePasses: [ 'Saturation' ], inactivePasses: [] }));
        startSession = vi.fn();
        updateRenderSettings = vi.fn(() => true);
    }
}));

vi.mock('webgpu-player/pipeline/CustomPlaybackController', () => ({
    default: class {
        constructor(options: unknown) {
            this.options = options;
            engineMocks.controllers.push(this as unknown as Record<string, unknown>);
        }

        currentTimeMicroseconds = 0;
        durationMicroseconds = null;
        options: unknown;
        playbackState = 'starting';
        destroy = vi.fn(() => Promise.resolve());
        getTelemetry = vi.fn(() => null);
        pause = vi.fn();
        play = vi.fn(() => Promise.resolve({ fallbackReason: null, generation: 1, status: 'started' }));
        resume = vi.fn();
        seek = vi.fn(() => Promise.resolve({ fallbackReason: null, generation: 1, status: 'started' }));
        setMuted = vi.fn();
        setVolume = vi.fn();
    }
}));

vi.mock('webgpu-player/pipeline/CustomPlaybackFrameLoop', () => ({
    default: class {
        constructor() {
            engineMocks.frameLoops.push(this as unknown as Record<string, unknown>);
        }

        cancel = vi.fn();
        destroy = vi.fn();
        schedule = vi.fn();
        setPresentationGeneration = vi.fn();
        synchronizePageVisibility = vi.fn();
    }
}));

vi.mock('webgpu-player/capability/CustomDecodeCapabilities', () => ({
    probeCustomDecodeCapabilities: vi.fn(() => Promise.resolve({ rawHDRVideo: {}, video: {} }))
}));
vi.mock('webgpu-player/capability/NativeMediaAudioCapabilities', () => ({
    probeCachedNativeMediaAudioCapabilities: vi.fn(() => Promise.resolve({}))
}));
vi.mock('webgpu-player/capability/CustomPlaybackRuntime', () => ({
    getCustomPlaybackRuntimeAvailability: vi.fn(() => ({}))
}));
vi.mock('webgpu-player/capability/CustomPlaybackEligibility', () => ({
    getCustomPlaybackEligibility: vi.fn((options: { source: unknown }) => {
        engineMocks.eligibilityCalls.push(options);
        return engineMocks.eligibility === null ? null : { source: options.source, ...engineMocks.eligibility };
    }),
    getGPUVideoDecodeTarget: vi.fn(() => engineMocks.gpuVideoDecodeTarget)
}));
vi.mock('webgpu-player/presentation/PresentationSetup', async () => {
    const actual = await vi.importActual<typeof import('webgpu-player/presentation/PresentationSetup')>('webgpu-player/presentation/PresentationSetup');
    return {
        ...actual,
        configurePresentationColorPipeline: vi.fn(() => Promise.resolve(engineMocks.configured)),
        getCustomPresentationEligibilityOptions: vi.fn(() => Promise.resolve(actual.UNAUTHORIZED_PRESENTATION_ELIGIBILITY_OPTIONS))
    };
});
vi.mock('webgpu-player/audio/output/BrowserAudioContextPrewarm', () => ({
    prewarmBrowserAudioContext: vi.fn(() => {
        const lease = {
            audioContext: { destination: { maxChannelCount: 2 } },
            close: vi.fn(() => Promise.resolve()),
            resumePromise: Promise.resolve()
        };
        engineMocks.prewarmLeases.push(lease);
        return lease;
    })
}));
vi.mock('webgpu-player/audio/output/BrowserCustomAudioOutput', () => ({
    createBrowserCustomAudioOutputFactory: vi.fn(() => vi.fn())
}));
vi.mock('webgpu-player/audio/native/CustomDecodeNativeAudioBridge', () => ({ default: class {} }));
vi.mock('../../../sandbox/src/session/FFmpegTool', () => ({
    createFFmpegTool: vi.fn(() => engineMocks.tool)
}));
vi.mock('../../../sandbox/src/session/DecoderPackages', () => ({
    createSandboxDecoderPackages: vi.fn((options: { recordFailure: (code: string, detail: string) => void }) => {
        engineMocks.decoderPackageFailureRecorder = options.recordFailure;
        return {
            add: vi.fn(() => Promise.resolve()),
            getAudioDecoders: vi.fn(() => []),
            getVideoDecoders: vi.fn(() => engineMocks.videoDecoderPackages),
            remove: vi.fn(() => Promise.resolve()),
            restore: vi.fn(() => Promise.resolve()),
            verify: vi.fn(() => Promise.resolve())
        };
    })
}));

import { createBrowserCustomAudioOutputFactory } from 'webgpu-player/audio/output/BrowserCustomAudioOutput';
import { probeCustomDecodeCapabilities } from 'webgpu-player/capability/CustomDecodeCapabilities';
import { getCustomPlaybackEligibility, type CustomPlaybackEligibilityOptions } from 'webgpu-player/capability/CustomPlaybackEligibility';
import type { CustomPlaybackFallbackRequest } from 'webgpu-player/pipeline/CustomPlaybackControllerTypes';
import { configurePresentationColorPipeline } from 'webgpu-player/presentation/PresentationSetup';
import { requireMicroseconds } from 'webgpu-player/TimeMath';

import { createDecoderProjectVideoPackageForTest } from '../../helpers/decoderPackages';

const MEDIA_PATH = 'movies/feature.mkv';
const RESUME_TIME_MICROSECONDS = 5_000_000;
const FALLBACK_TIME_MICROSECONDS = requireMicroseconds(7_000_000);
const FALLBACK_REQUEST: CustomPlaybackFallbackRequest = {
    disposition: 'same-session-native',
    generation: 1,
    mediaTimeMicroseconds: FALLBACK_TIME_MICROSECONDS,
    preserveHTMLSession: true,
    reason: 'playback-stalled'
};
const CAPABILITY_PROBE_FAILURE = 'capability probe rejected';
const PROBE_FAILURE = 'ffprobe exit 1: Invalid data found when processing input';
const INELIGIBLE_REASON = 'codec-unsupported';
const PENDING_PARAMETER_ERROR = "pass-unknown: 'Saturation'";
const PRESENTER_FALLBACK_REASON = 'device-request-failed';
const PRESENTER_FALLBACK_DETAIL = 'adapter lost';
const SUBTITLE_TEXT = 'Bonjour.';
const SUBTITLE_WEBVTT = `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${SUBTITLE_TEXT}\n`;
const SATURATION_PARAMETER = 'saturation';
const CHANGED_SATURATION = 1.5;
const TEXT_FILE_NAME = 'notes.txt';
const PASS_FILE_NAME = 'saturation.wgsl';
// The saturation pass project in wgpup/, as a host offers it
const SATURATION_PASS_SOURCE = readPostprocessingPass('saturation', PASS_FILE_NAME);
const SATURATION_PASS_NAME = 'Saturation';
const BUILT_SATURATION_PASS = { fileName: PASS_FILE_NAME, url: `/wgpup/${PASS_FILE_NAME}` } as const;
// The dev server lists every file of the pass output folder; only the WGSL files are passes
const LISTED_OUTPUT_FILES = [ BUILT_SATURATION_PASS, { fileName: 'README.txt', url: '/wgpup/README.txt' } ];
const MISSING_FILE_STATUS = 404;
const GPU_RAW_OVERRIDE: RouteOverride = { decoder: 'gpu', transport: 'raw-planes' };
const GPU_OVERRIDE: RouteOverride = { decoder: 'gpu', transport: 'auto' };
// A device whose frame pool may take 2 GiB, as a desktop adapter allows
const GPU_FRAME_POOL_BYTE_LIMIT = 2 ** 31;
// The HEVC decoder project's package, which decodes the probed HEVC Main 10 stream
const HEVC_PACKAGE = createDecoderProjectVideoPackageForTest('hevc');
const GPU_VIDEO_DECODER = { codec: 'hevc', decoderId: HEVC_PACKAGE.id, package: HEVC_PACKAGE } as const;
// A package file the page could not load, as the decoder packages report it
const PACKAGE_FAILURE_CODE = 'package-invalid';
const PACKAGE_FAILURE_DETAIL = 'vc1.wasm WebAssembly.compile(): expected magic word';
// The presenter's refusal of a mode outside its modes
const DEINTERLACE_MODE_REJECTION = "deinterlace-mode: 'weave'";
const ELIGIBLE_ROUTE = {
    audioOutputMode: 'decoded-pcm',
    audioSourceChannelCount: 8,
    audioTrackIndex: 0,
    dolbyVisionProfile: null,
    durationMicroseconds: null,
    eligible: true,
    maximumCodedHeight: 2_160,
    maximumCodedWidth: 3_840,
    neutralizeHDRColorMetadata: false,
    rawVideoFrameFormat: null,
    startTimeMicroseconds: 0,
    videoDecoderBackend: 'native',
    videoOutputMode: 'video-frame',
    videoTrackIndex: 0
};

type SessionHarness = Readonly<{
    file: File
    session: ReturnType<typeof createSandboxSession>
    store: ReturnType<typeof createStore<SandboxState>>
}>;

function createHarness(): SessionHarness {
    const store = createStore<SandboxState>(createInitialSandboxState());
    const session = createSandboxSession({ store, surfaceContainer: document.createElement('div') });
    return { file: new File([ 'media' ], MEDIA_PATH), session, store };
}

async function openMedia(harness: SessionHarness): Promise<void> {
    await harness.session.openMedia({ file: harness.file, path: MEDIA_PATH, subtitleFiles: [] });
}

function getFailures(harness: SessionHarness): Array<Pick<SandboxFailure, 'code' | 'detail' | 'layer'>> {
    return harness.store.getState().failures.map(({ code, detail, layer }: SandboxFailure) => ({ code, detail, layer }));
}

function getLastController(): Record<string, Mock> {
    return engineMocks.controllers.at(-1) as unknown as Record<string, Mock>;
}

describe('SandboxSession', () => {
    beforeEach(() => {
        engineMocks.configured = true;
        engineMocks.decoderPackageFailureRecorder = null;
        engineMocks.videoDecoderPackages = [ HEVC_PACKAGE ];
        engineMocks.controllers.length = 0;
        engineMocks.eligibility = ELIGIBLE_ROUTE;
        engineMocks.eligibilityCalls.length = 0;
        engineMocks.frameLoops.length = 0;
        engineMocks.gpuFramePoolByteLimit = null;
        engineMocks.prewarmLeases.length = 0;
        engineMocks.presenters.length = 0;
        engineMocks.tool = {
            convertSubtitleToWebVTT: vi.fn(() => Promise.resolve(SUBTITLE_WEBVTT)),
            probe: vi.fn((_file: File, options: readonly string[]) => Promise.resolve(
                options.includes('-show_frames') ?
                    createFramesJSON([]) :
                    createProbeJSON([ createVideoStreamJSON(), createAudioStreamJSON(), createSubtitleStreamJSON() ])
            ))
        };
    });

    it('probes the file, chooses its route through the eligibility, and plays it from the start on the default audio track', async () => {
        const harness = createHarness();

        await openMedia(harness);

        const [ eligibilityOptions ] = engineMocks.eligibilityCalls as Array<{ mediaSource: { DefaultAudioStreamIndex: number, MediaStreams: Array<{ Type: string }> }, playMethod: string }>;
        expect(eligibilityOptions.playMethod).toBe('DirectPlay');
        expect(eligibilityOptions.mediaSource.DefaultAudioStreamIndex).toBe(AUDIO_STREAM_INDEX);
        expect(eligibilityOptions.mediaSource.MediaStreams.map(stream => stream.Type)).toEqual([ 'Video', 'Audio' ]);
        expect(configurePresentationColorPipeline).toHaveBeenCalled();
        expect(getLastController().play).toHaveBeenCalledWith(expect.objectContaining({
            source: { file: harness.file, kind: 'file' },
            startTimeMicroseconds: 0,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        }));
        const state = harness.store.getState();
        expect(state.media?.container).toBe('matroska,webm');
        expect(state.tracks.audioTrackIndex).toBe(AUDIO_STREAM_INDEX);
        expect(state.route.active?.selection).toBe('eligibility');
        expect(state.failures).toEqual([]);
    });

    it('hands the presenter the deinterlacing mode and publishes it, and records a mode the presenter refuses', async () => {
        const harness = createHarness();
        const presenter = engineMocks.presenters[0];

        await harness.session.setDeinterlaceMode('single-rate');

        expect(presenter.setDeinterlaceMode).toHaveBeenCalledWith('single-rate');
        expect(harness.store.getState().presentation.deinterlaceMode).toBe('single-rate');

        presenter.setDeinterlaceMode.mockRejectedValueOnce(new RangeError(DEINTERLACE_MODE_REJECTION));
        await expect(harness.session.setDeinterlaceMode('off')).rejects.toThrow('deinterlace-mode-failed');
        expect(getFailures(harness)).toEqual([ { code: 'deinterlace-mode-failed', detail: DEINTERLACE_MODE_REJECTION, layer: 'presenter' } ]);
        expect(harness.store.getState().presentation.deinterlaceMode).toBe('single-rate');
    });

    it('records a probe failure and rejects without starting a route', async () => {
        const harness = createHarness();
        engineMocks.tool?.probe.mockRejectedValue(new Error(PROBE_FAILURE));

        await expect(openMedia(harness)).rejects.toThrow('probe-failed');

        expect(getFailures(harness)).toEqual([ { code: 'probe-failed', detail: `${MEDIA_PATH} ${PROBE_FAILURE}`, layer: 'probe' } ]);
        expect(harness.store.getState().playback.status).toBe('failed');
        expect(engineMocks.controllers).toEqual([]);
    });

    it('records an ineligible file with the eligibility\'s reason', async () => {
        const harness = createHarness();
        engineMocks.eligibility = { eligible: false, reason: INELIGIBLE_REASON };

        await expect(openMedia(harness)).rejects.toThrow(`ineligible: ${INELIGIBLE_REASON}`);

        expect(getFailures(harness)).toEqual([ { code: 'ineligible', detail: INELIGIBLE_REASON, layer: 'session' } ]);
        expect(engineMocks.controllers).toEqual([]);
    });

    it('records a route the presenter cannot present, and stops it with its audio context', async () => {
        const harness = createHarness();
        engineMocks.configured = false;

        await expect(openMedia(harness)).rejects.toThrow('color-pipeline-unavailable');

        expect(getFailures(harness)).toEqual([ { code: 'color-pipeline-unavailable', detail: 'video-frame videoframe', layer: 'presenter' } ]);
        const presenter = engineMocks.presenters[0];
        const startedGeneration = (presenter.startSession.mock.calls.at(-1) as [ number ])[0];
        expect(presenter.endSession).toHaveBeenLastCalledWith(startedGeneration + 1);
        expect(engineMocks.prewarmLeases[0].close).toHaveBeenCalledOnce();
        expect(harness.store.getState().playback.status).toBe('failed');
    });

    it('records a start failure no step reported, and stops the route', async () => {
        const harness = createHarness();
        vi.mocked(probeCustomDecodeCapabilities).mockRejectedValueOnce(new Error(CAPABILITY_PROBE_FAILURE));

        await expect(openMedia(harness)).rejects.toThrow(CAPABILITY_PROBE_FAILURE);

        expect(getFailures(harness)).toEqual([ { code: 'route-start-failed', detail: CAPABILITY_PROBE_FAILURE, layer: 'session' } ]);
        expect(engineMocks.prewarmLeases[0].close).toHaveBeenCalledOnce();
        expect(harness.store.getState().playback.status).toBe('failed');
    });

    it('releases the audio context before playing a route whose audio the browser plays', async () => {
        const harness = createHarness();
        engineMocks.eligibility = { ...ELIGIBLE_ROUTE, audioOutputMode: 'native-media' };

        await openMedia(harness);

        expect(engineMocks.prewarmLeases[0].close).toHaveBeenCalledOnce();
        // The sandbox shows the output's signal statistics, so its outputs compute them
        expect(createBrowserCustomAudioOutputFactory).toHaveBeenLastCalledWith(null, expect.anything(), { analyzeSignal: true });
        expect(getLastController().play).toHaveBeenCalledWith(expect.objectContaining({ audioDownmixSettings: undefined, audioOutputMode: 'native-media' }));
    });

    it('keeps the clock where a route fell back, and restarts there', async () => {
        const harness = createHarness();
        await openMedia(harness);
        const firstController = getLastController();
        (firstController as unknown as { currentTimeMicroseconds: number }).currentTimeMicroseconds = FALLBACK_TIME_MICROSECONDS;

        (firstController.options as unknown as { fallbackHook: (request: CustomPlaybackFallbackRequest) => void }).fallbackHook(FALLBACK_REQUEST);

        expect(getFailures(harness)).toEqual([ {
            code: 'fallback',
            detail: `${FALLBACK_REQUEST.reason} at ${FALLBACK_TIME_MICROSECONDS} us`,
            layer: 'session'
        } ]);
        expect(firstController.destroy).toHaveBeenCalled();
        expect(harness.session.getCurrentTimeMicroseconds()).toBe(FALLBACK_TIME_MICROSECONDS);

        await harness.session.setRouteOverride(GPU_RAW_OVERRIDE);

        expect(getLastController()).not.toBe(firstController);
        expect(getLastController().play).toHaveBeenCalledWith(expect.objectContaining({ startTimeMicroseconds: FALLBACK_TIME_MICROSECONDS }));
    });

    it('reports an override the chosen route leaves unmet, and plays the route', async () => {
        const harness = createHarness();

        await harness.session.setRouteOverride(GPU_RAW_OVERRIDE);
        await openMedia(harness);

        expect(getFailures(harness)).toEqual([ {
            code: 'route-override-unmet',
            detail: 'route-override-unmet: transport raw-planes, chose video-frame; decoder gpu, chose native',
            layer: 'session'
        } ]);
        expect(harness.store.getState().route.active?.selection).toBe('override decoder gpu, transport raw-planes');
        expect(getLastController().play).toHaveBeenCalled();
    });

    it('offers the GPU decoder packages under Auto, and none without a device to hold a frame pool', async () => {
        const harness = createHarness();

        await openMedia(harness);
        const withoutDeviceOptions = vi.mocked(getCustomPlaybackEligibility).mock.calls.at(-1)?.[2] as CustomPlaybackEligibilityOptions;
        engineMocks.gpuFramePoolByteLimit = GPU_FRAME_POOL_BYTE_LIMIT;
        await openMedia(harness);
        const withDeviceOptions = vi.mocked(getCustomPlaybackEligibility).mock.calls.at(-1)?.[2] as CustomPlaybackEligibilityOptions;

        expect(withoutDeviceOptions.gpuVideoDecoders).toEqual([]);
        expect(withDeviceOptions.gpuVideoDecoders?.map(offer => offer.decoderId)).toEqual([ HEVC_PACKAGE.id ]);
    });

    it('offers no GPU decoder package under the native override', async () => {
        const harness = createHarness();
        engineMocks.gpuFramePoolByteLimit = GPU_FRAME_POOL_BYTE_LIMIT;

        await harness.session.setRouteOverride({ decoder: 'native', transport: 'auto' });
        await openMedia(harness);

        const eligibilityOptions = vi.mocked(getCustomPlaybackEligibility).mock.calls.at(-1)?.[2] as CustomPlaybackEligibilityOptions;
        expect(eligibilityOptions.gpuVideoDecoders).toEqual([]);
    });

    it('records a decoder package failure under the decoders layer', () => {
        const harness = createHarness();

        engineMocks.decoderPackageFailureRecorder?.(PACKAGE_FAILURE_CODE, PACKAGE_FAILURE_DETAIL);

        expect(getFailures(harness)).toEqual([ { code: PACKAGE_FAILURE_CODE, detail: PACKAGE_FAILURE_DETAIL, layer: 'decoders' } ]);
    });

    it('offers every GPU decoder under the GPU override and plays the frame-pool route it chooses', async () => {
        const harness = createHarness();
        engineMocks.gpuFramePoolByteLimit = GPU_FRAME_POOL_BYTE_LIMIT;
        engineMocks.eligibility = {
            ...ELIGIBLE_ROUTE,
            gpuVideoDecoder: GPU_VIDEO_DECODER,
            rawVideoFrameFormat: 'I420P10',
            videoDecoderBackend: 'gpu',
            videoOutputMode: 'frame-pool'
        };

        await harness.session.setRouteOverride(GPU_OVERRIDE);
        await openMedia(harness);

        const eligibilityOptions = vi.mocked(getCustomPlaybackEligibility).mock.calls.at(-1)?.[2] as CustomPlaybackEligibilityOptions;
        expect(eligibilityOptions.gpuVideoDecoders?.map(offer => offer.decoderId)).toEqual([ HEVC_PACKAGE.id ]);
        expect(eligibilityOptions.gpuVideoDecoders?.[0].maximumBufferByteLength).toBe(GPU_FRAME_POOL_BYTE_LIMIT);
        const controller = getLastController();
        expect((controller.options as unknown as { gpuVideoDecodeSessionFactory: unknown }).gpuVideoDecodeSessionFactory).toEqual(expect.any(Function));
        expect(controller.play).toHaveBeenCalledWith(expect.objectContaining({
            gpuVideoDecoder: GPU_VIDEO_DECODER,
            videoDecoderBackend: 'gpu',
            videoOutputMode: 'frame-pool'
        }));
        expect(harness.store.getState().route.active?.gpuVideoDecoder).toEqual(GPU_VIDEO_DECODER);
        expect(getFailures(harness)).toEqual([]);
    });

    it('restarts at the clock without audio when the audio track is turned off', async () => {
        const harness = createHarness();
        await openMedia(harness);
        const firstController = getLastController();
        (firstController as unknown as { currentTimeMicroseconds: number }).currentTimeMicroseconds = RESUME_TIME_MICROSECONDS;

        await harness.session.selectAudioTrack(null);

        expect(firstController.destroy).toHaveBeenCalled();
        const lastOptions = engineMocks.eligibilityCalls.at(-1) as { mediaSource: { MediaStreams: Array<{ Type: string }> } };
        expect(lastOptions.mediaSource.MediaStreams.map(stream => stream.Type)).toEqual([ 'Video' ]);
        expect(getLastController().play).toHaveBeenCalledWith(expect.objectContaining({ startTimeMicroseconds: RESUME_TIME_MICROSECONDS }));
    });

    it('reads an embedded subtitle track through ffmpeg as plain-text cues', async () => {
        const harness = createHarness();
        await openMedia(harness);

        await harness.session.selectSubtitle({ kind: 'embedded', trackIndex: SUBTITLE_STREAM_INDEX });

        expect(engineMocks.tool?.convertSubtitleToWebVTT).toHaveBeenCalledWith(harness.file, SUBTITLE_STREAM_INDEX);
        expect(harness.store.getState().subtitleCues).toEqual([ { endMicroseconds: 2_000_000, startMicroseconds: 1_000_000, text: SUBTITLE_TEXT } ]);
    });

    it('adds shader files from WGSL files, reports other files, and applies the preset', async () => {
        const harness = createHarness();

        await harness.session.addShaderFiles([
            new File([ SATURATION_PASS_SOURCE ], PASS_FILE_NAME),
            new File([ 'not a pass' ], TEXT_FILE_NAME)
        ]);

        expect(getFailures(harness)).toEqual([ { code: 'shader-file-unsupported', detail: TEXT_FILE_NAME, layer: 'shader' } ]);
        const presentation = harness.store.getState().presentation;
        expect(presentation.files).toHaveLength(1);
        expect(presentation.files[0]).toMatchObject({ origin: PASS_FILE_NAME });
        expect(presentation.files[0].passes).toEqual([ { headerFailure: null, manifest: expect.objectContaining({ name: SATURATION_PASS_NAME }) } ]);
        expect(presentation.report.activePasses).toEqual([ SATURATION_PASS_NAME ]);
        expect(engineMocks.presenters[0].setPresentationPreset).toHaveBeenCalledWith([ { parameters: {}, source: SATURATION_PASS_SOURCE } ]);
    });

    it('lists the built pass files and adds one by fetching it', async () => {
        const harness = createHarness();
        const fetchMock = vi.fn(async (url: string): Promise<Response> => (
            url === BUILT_PASSES_ROUTE ? Response.json(LISTED_OUTPUT_FILES) : new Response(SATURATION_PASS_SOURCE)
        ));
        vi.stubGlobal('fetch', fetchMock);
        try {
            const builtPasses = await harness.session.listBuiltShaderPasses();
            await harness.session.addBuiltShaderPass(builtPasses[0]);

            expect(builtPasses).toEqual([ BUILT_SATURATION_PASS ]);
            expect(fetchMock).toHaveBeenLastCalledWith(BUILT_SATURATION_PASS.url);
            expect(harness.store.getState().presentation.files[0]).toMatchObject({ origin: PASS_FILE_NAME });
            expect(engineMocks.presenters[0].setPresentationPreset).toHaveBeenCalledWith([ { parameters: {}, source: SATURATION_PASS_SOURCE } ]);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('reports a built pass file it cannot fetch and adds nothing', async () => {
        const harness = createHarness();
        vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response(null, { status: MISSING_FILE_STATUS })));
        try {
            await expect(harness.session.addBuiltShaderPass(BUILT_SATURATION_PASS)).rejects.toThrow('built-pass-unavailable');

            expect(getFailures(harness)).toEqual([
                { code: 'built-pass-unavailable', detail: `${PASS_FILE_NAME} HTTP ${MISSING_FILE_STATUS}`, layer: 'shader' }
            ]);
            expect(harness.store.getState().presentation.files).toEqual([]);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('applies a parameter live, and keeps it for a pass that is not running', async () => {
        const harness = createHarness();
        await harness.session.addShaderFiles([ new File([ SATURATION_PASS_SOURCE ], PASS_FILE_NAME) ]);
        const fileId = harness.store.getState().presentation.files[0].id;
        const presenter = engineMocks.presenters[0];

        harness.session.setShaderParameter(fileId, SATURATION_PARAMETER, CHANGED_SATURATION);
        presenter.setPresentationParameter.mockImplementation((): void => {
            throw new RangeError(PENDING_PARAMETER_ERROR);
        });
        harness.session.setShaderParameter(fileId, SATURATION_PARAMETER, CHANGED_SATURATION);

        expect(presenter.setPresentationParameter).toHaveBeenCalledWith(SATURATION_PASS_NAME, SATURATION_PARAMETER, CHANGED_SATURATION);
        expect(harness.store.getState().presentation.files[0].parameters).toEqual({ [SATURATION_PARAMETER]: CHANGED_SATURATION });
        expect(getFailures(harness)).toEqual([ { code: 'shader-parameter-pending', detail: PENDING_PARAMETER_ERROR, layer: 'shader' } ]);
    });

    it('reports a presenter fallback of the current generation only', async () => {
        const harness = createHarness();
        await openMedia(harness);
        const presenter = engineMocks.presenters[0];
        const generation = (presenter.startSession.mock.calls.at(-1) as [ number ])[0];

        engineMocks.presenterHandlers?.fallback(generation - 1, PRESENTER_FALLBACK_REASON, PRESENTER_FALLBACK_DETAIL);
        engineMocks.presenterHandlers?.fallback(generation, PRESENTER_FALLBACK_REASON, PRESENTER_FALLBACK_DETAIL);

        expect(getFailures(harness)).toEqual([ { code: PRESENTER_FALLBACK_REASON, detail: PRESENTER_FALLBACK_DETAIL, layer: 'presenter' } ]);
        expect(harness.store.getState().playback.status).toBe('failed');
    });
});
