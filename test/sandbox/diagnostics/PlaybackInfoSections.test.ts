import { describe, expect, it } from 'vitest';

import {
    MAX_DECODED_AUDIO_SAMPLE_CREDITS,
    MAX_DECODED_FRAME_CREDITS,
    MAX_DECODED_RAW_FRAME_CREDITS
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import type { CustomPlaybackTelemetry } from 'webgpu-player/pipeline/CustomPlaybackControllerTypes';
import { createHDRToSDRRenderSettings } from 'webgpu-player/presentation/RenderSettings';
import { EXTERNAL_HDR_AUTHORIZATION_ROUTE_KEYS } from 'webgpu-player/validation/ExternalHDRPresentationAuthorization';
import { RAW_HDR_AUTHORIZATION_ROUTE_KEYS } from 'webgpu-player/validation/RawHDRPresentationAuthorization';

import {
    createInitialSandboxState,
    type ActiveRoute,
    type SandboxFailure,
    type SandboxState
} from '../../../sandbox/src/contracts/SandboxContracts';
import {
    describeClockSource,
    describePlaybackInfo,
    type InfoRow,
    type InfoSection
} from '../../../sandbox/src/ui/diagnostics/PlaybackInfoSections';
import { createActiveRoute, createPlannedPass, createPlannedTexture, createPresentationPlan } from './diagnosticsTestState';
import {
    createAudioTrack,
    createBridgeTelemetry,
    createControllerTelemetry,
    createDecodeSessionTelemetry,
    createDolbyVisionAuthorization,
    createExternalDolbyVisionAuthorization,
    createExternalHDRAuthorization,
    createMediaDescription,
    createPresenterTelemetry,
    createRawHDRAuthorization,
    createSubtitleTrack,
    createVideoTrack,
    createWorkletTelemetry,
    microseconds
} from './telemetryTestState';

const MEDIA_SECTION_ID = 'media';
const VIDEO_SECTION_ID = 'video-0';
const AUDIO_TRACKS_SECTION_ID = 'audio-tracks';
const SUBTITLES_SECTION_ID = 'subtitles';
const ROUTE_SECTION_ID = 'route';
const CLOCK_SECTION_ID = 'clock';
const VIDEO_DECODE_SECTION_ID = 'video-decode';
const AUDIO_SECTION_ID = 'audio';
const PRESENTATION_SECTION_ID = 'presentation';
const AUTHORIZATION_SECTION_ID = 'authorization';
const FAILURES_SECTION_ID = 'failures';

const MEDIA_PATH = 'films/Example (2024).mkv';
const MEDIA_SIZE_BYTES = 1_610_612_736;
const MEDIA_SIZE_TEXT = '1.50 GiB';
// 1 h 2 min 3.456 s
const MEDIA_DURATION_MICROSECONDS = 3_723_456_000;
const MEDIA_DURATION_TEXT = '1:02:03.456';
const VIDEO_CODEC = 'hevc';
const VIDEO_CODEC_STRING = 'hvc1.2.4.L153.B0';
const DISPLAY_WIDTH = 3840;
const DISPLAY_HEIGHT = 2160;
const CODED_HEIGHT = 2176;
const FRAME_RATE = 24_000 / 1_001;
const FRAME_RATE_TEXT = '23.976 fps';
const BIT_DEPTH = 10;
const VIDEO_LANGUAGE = 'eng';
const VIDEO_NAME = 'Main';
const DOLBY_VISION_PROFILE = 8;
const DOLBY_VISION_LEVEL = 6;
const DOLBY_VISION_COMPATIBILITY_ID = 1;
const SURROUND_CHANNEL_COUNT = 6;
const STEREO_CHANNEL_COUNT = 2;
const SAMPLE_RATE = 48_000;
const SURROUND_CODEC = 'eac3';
const SURROUND_CODEC_STRING = 'ec-3';
const COMMENTARY_NAME = 'Commentary';
const SUBTITLE_PATH = 'films/Example (2024).en.srt';
const SUBTITLE_LANGUAGE = 'eng';

const RAW_FORMAT = 'I420P10';
const ROUTE_SELECTION = 'override: software decoder';

const CURRENT_TIME_MICROSECONDS = 10_041_708;
const CURRENT_TIME_TEXT = '0:10.041';
const PRESENTED_TIME_MICROSECONDS = 10_000_000;
const PRESENTED_LAG_TEXT = 'presented frame 41.7 ms behind the clock';
const EARLY_PRESENTED_TIME_MICROSECONDS = 10_050_000;
const PRESENTED_LEAD_TEXT = 'presented frame 8.3 ms ahead of the clock';
const CLOCK_RESET_COUNT = 3;
const LARGEST_CLOCK_JUMP_MICROSECONDS = 23_500;
const DRIFT_TEXT = '3 re-anchors, largest 23.5 ms';
const ERROR_MESSAGE = 'Decoder error: unsupported profile';

const QUEUED_FRAME_COUNT = 1;
const PENDING_FRAME_COUNT = 1;
const SKIPPED_FRAME_COUNT = 3;
const STALE_FRAME_COUNT = 2;
const LATE_FRAME_COUNT = 2;
const WORST_FRAME_LAG_MICROSECONDS = 52_000;
const DECODE_LAG_MICROSECONDS = 45_000;
const DECODE_TARGET_MICROSECONDS = 10_000_000;
const DECODE_FRAME_END_MICROSECONDS = 9_955_000;
const HDR10_PLUS_VALID_COUNT = 120;
const HDR10_PLUS_ABSENT_COUNT = 4;

// A tenth of a second at 48 kHz, and multiples of it
const TENTH_SECOND_FRAMES = 4_800;
const UNDERFLOW_EVENT_COUNT = 2;
const QUEUED_AUDIO_FRAMES = 2 * TENTH_SECOND_FRAMES;
const PENDING_AUDIO_FRAMES = 3 * TENTH_SECOND_FRAMES;
const PENDING_CHUNK_COUNT = 3;
const SIGNAL_PEAK = 0.5;
const SIGNAL_SAMPLE_COUNT = 4;
// Four samples of 0.25 have an RMS of 0.25, -12.0 dBFS
const SIGNAL_SQUARE_SUM = SIGNAL_SAMPLE_COUNT * 0.25 * 0.25;

const PRESENTER_FALLBACK_DETAIL = 'GPUValidationError: texture usage';
const HDR10_PLUS_PEAK_NITS = 1_000.4;
const FEL_FAILURE = 'pixel-mismatch: scenario 2';
const CALLBACK_TIME_MICROSECONDS = 1_000_000;
const EXPECTED_DISPLAY_TIME_MICROSECONDS = 1_016_667;
const DISPLAY_LEAD_TEXT = 'display expected 16.7 ms after its callback';
const PLAN_TEXTURE_SIZE = 64;

const RAW_HDR_ROUTE_KEY = RAW_HDR_AUTHORIZATION_ROUTE_KEYS[0];
const EXTERNAL_HDR_ROUTE_KEY = EXTERNAL_HDR_AUTHORIZATION_ROUTE_KEYS[0];
const PIXEL_MISMATCH_DETAIL = '14/255 > 3/255 at (3, 7)';
const SAMPLE_COUNT = 64;
const CHANNEL_ERROR = 0.0039;
const CHANNEL_ERROR_TEXT = '0.0039';
const TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';

const FIRST_FAILURE: SandboxFailure = { code: 'scan-failed', detail: 'NotReadableError', layer: 'library', timeMilliseconds: 1_200 };
const SECOND_FAILURE: SandboxFailure = { code: 'frame-render-failed', detail: PRESENTER_FALLBACK_DETAIL, layer: 'presenter', timeMilliseconds: 15_300 };

type ClockSourceCase = Readonly<{
    controller: Partial<CustomPlaybackTelemetry>
    description: string
    expected: string
    route: ActiveRoute | null
}>;

const CLOCK_SOURCE_CASES: readonly ClockSourceCase[] = [
    { controller: {}, description: 'without a route', expected: '-', route: null },
    { controller: {}, description: 'without audio', expected: 'media clock, without audio', route: createActiveRoute({ audioOutputMode: null }) },
    {
        controller: { videoDecode: createDecodeSessionTelemetry({ nativeAudioClockReady: true }) },
        description: 'with a ready native audio element',
        expected: 'native audio element',
        route: createActiveRoute({ audioOutputMode: 'native-media' })
    },
    {
        controller: {},
        description: 'while the native audio is not ready',
        expected: 'media clock, until the native audio is ready',
        route: createActiveRoute({ audioOutputMode: 'native-media' })
    },
    {
        controller: { videoDecode: createDecodeSessionTelemetry({ nativeAudioClockReady: true, nativeAudioEnded: true }) },
        description: 'after the native audio ended',
        expected: 'media clock, since the native audio ended',
        route: createActiveRoute({ audioOutputMode: 'native-media' })
    },
    {
        controller: { audioPath: 'pending' },
        description: 'while decoded audio is pending',
        expected: 'media clock, while audio is pending',
        route: createActiveRoute({ audioOutputMode: 'decoded-pcm' })
    },
    {
        controller: { audioOutput: createWorkletTelemetry({ hasPhysicalOutputTimeCorrelation: true }), audioPath: 'ready' },
        description: 'with an audio output correlated to the device',
        expected: 'audio output, at the device\'s output time',
        route: createActiveRoute({ audioOutputMode: 'decoded-pcm' })
    },
    {
        controller: { audioOutput: createWorkletTelemetry(), audioPath: 'ready' },
        description: 'with an uncorrelated audio output',
        expected: 'media clock, while the audio output time is uncorrelated',
        route: createActiveRoute({ audioOutputMode: 'decoded-pcm' })
    },
    {
        controller: { audioPath: 'ready', videoDecode: createDecodeSessionTelemetry({ audioEnded: true }) },
        description: 'after the decoded audio track ended',
        expected: 'audio output until its tail plays out, then the media clock',
        route: createActiveRoute({ audioOutputMode: 'decoded-pcm' })
    }
];

function createState(overrides: Partial<SandboxState> = {}): SandboxState {
    return { ...createInitialSandboxState(), ...overrides };
}

/** A state with a session running on the route, with the controller and presenter telemetry. */
function createSessionState(
    controller: Partial<CustomPlaybackTelemetry> = {},
    route: ActiveRoute = createActiveRoute(),
    overrides: Partial<SandboxState> = {}
): SandboxState {
    const initialState = createInitialSandboxState();
    return createState({
        route: { ...initialState.route, active: route },
        telemetry: { ...initialState.telemetry, controller: createControllerTelemetry(controller) },
        ...overrides
    });
}

function requireSection(sections: readonly InfoSection[], sectionId: string): InfoSection {
    const section = sections.find((candidate: InfoSection): boolean => candidate.id === sectionId);
    if (!section) {
        throw new Error(`missing section ${sectionId}`);
    }
    return section;
}

function requireRow(section: InfoSection, label: string): InfoRow {
    const row = section.rows.find((candidate: InfoRow): boolean => candidate.label === label);
    if (!row) {
        throw new Error(`missing row ${label} in ${section.id}`);
    }
    return row;
}

function getRow(state: SandboxState, sectionId: string, label: string): InfoRow {
    return requireRow(requireSection(describePlaybackInfo(state), sectionId), label);
}

function getSectionIds(state: SandboxState): string[] {
    return describePlaybackInfo(state).map((section: InfoSection): string => section.id);
}

describe('describePlaybackInfo', () => {
    it('describes nothing while nothing is open and nothing failed, so the panel takes no room', () => {
        expect(describePlaybackInfo(createInitialSandboxState())).toEqual([]);
    });

    it('describes the media file, its size, duration, bitrate, and track counts', () => {
        const state = createState({
            media: createMediaDescription({
                audioTracks: [ createAudioTrack() ],
                durationMicroseconds: microseconds(MEDIA_DURATION_MICROSECONDS),
                path: MEDIA_PATH,
                sizeBytes: MEDIA_SIZE_BYTES,
                subtitleTracks: [ createSubtitleTrack() ],
                videoTracks: [ createVideoTrack() ]
            })
        });
        const section = requireSection(describePlaybackInfo(state), MEDIA_SECTION_ID);

        expect(requireRow(section, 'File').value).toBe(MEDIA_PATH);
        expect(requireRow(section, 'Size').value).toBe(MEDIA_SIZE_TEXT);
        expect(requireRow(section, 'Duration').value).toBe(MEDIA_DURATION_TEXT);
        expect(requireRow(section, 'Bitrate').value).toMatch(/ Mbit\/s$/);
        expect(requireRow(section, 'Tracks').value).toBe('1 video, 1 audio, 1 subtitle');
    });

    it('describes a video track\'s codec, sizes, rate, depth, color, dynamic range, and Dolby Vision', () => {
        const initialState = createInitialSandboxState();
        const state = createState({
            media: createMediaDescription({
                videoTracks: [ createVideoTrack({
                    bitDepth: BIT_DEPTH,
                    codec: VIDEO_CODEC,
                    codecString: VIDEO_CODEC_STRING,
                    codedHeight: CODED_HEIGHT,
                    codedWidth: DISPLAY_WIDTH,
                    color: { matrix: 'bt2020-ncl', primaries: 'bt2020', range: 'limited', transfer: 'pq' },
                    displayHeight: DISPLAY_HEIGHT,
                    displayWidth: DISPLAY_WIDTH,
                    dolbyVision: { blCompatibilityId: DOLBY_VISION_COMPATIBILITY_ID, hasEnhancementLayer: false, level: DOLBY_VISION_LEVEL, profile: DOLBY_VISION_PROFILE },
                    dynamicRange: 'dolby-vision',
                    frameRate: FRAME_RATE,
                    language: VIDEO_LANGUAGE,
                    name: VIDEO_NAME
                }) ]
            }),
            tracks: { ...initialState.tracks, videoTrackIndex: 0 }
        });
        const section = requireSection(describePlaybackInfo(state), VIDEO_SECTION_ID);

        expect(section.title).toBe('Video #0, selected');
        expect(requireRow(section, 'Codec').value).toBe(`${VIDEO_CODEC} (${VIDEO_CODEC_STRING})`);
        expect(requireRow(section, 'Size').value).toBe(`${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}, coded ${DISPLAY_WIDTH}x${CODED_HEIGHT}`);
        expect(requireRow(section, 'Frame rate').value).toBe(FRAME_RATE_TEXT);
        expect(requireRow(section, 'Bit depth').value).toBe(`${BIT_DEPTH}-bit`);
        expect(requireRow(section, 'Color').value).toBe('primaries bt2020, transfer pq, matrix bt2020-ncl, limited range');
        expect(requireRow(section, 'Dynamic range').value).toBe('dolby-vision');
        expect(requireRow(section, 'Dolby Vision').value).toBe(
            `profile ${DOLBY_VISION_PROFILE}, level ${DOLBY_VISION_LEVEL}, BL compatibility ${DOLBY_VISION_COMPATIBILITY_ID}, no EL`
        );
        expect(requireRow(section, 'Language').value).toBe(VIDEO_LANGUAGE);
    });

    it('describes each audio track on one row, marking the default and the selected one', () => {
        const initialState = createInitialSandboxState();
        const surroundTrack = createAudioTrack({
            channelCount: SURROUND_CHANNEL_COUNT,
            codec: SURROUND_CODEC,
            codecString: SURROUND_CODEC_STRING,
            default: true,
            index: 1,
            language: VIDEO_LANGUAGE
        });
        const commentaryTrack = createAudioTrack({ index: 2, name: COMMENTARY_NAME });
        const state = createState({
            media: createMediaDescription({ audioTracks: [ surroundTrack, commentaryTrack ] }),
            tracks: { ...initialState.tracks, audioTrackIndex: commentaryTrack.index }
        });
        const section = requireSection(describePlaybackInfo(state), AUDIO_TRACKS_SECTION_ID);

        expect(section.rows.map((row: InfoRow): string => row.value)).toEqual([
            `${SURROUND_CODEC} (${SURROUND_CODEC_STRING}), ${SURROUND_CHANNEL_COUNT} ch, 48 kHz, ${VIDEO_LANGUAGE}, default`,
            `${commentaryTrack.codec}, ${commentaryTrack.channelCount} ch, 48 kHz, '${COMMENTARY_NAME}', selected`
        ]);
    });

    it('describes subtitle tracks and a selected subtitle file', () => {
        const initialState = createInitialSandboxState();
        const state = createState({
            media: createMediaDescription({ subtitleTracks: [ createSubtitleTrack({ language: SUBTITLE_LANGUAGE }), createSubtitleTrack({ index: 3, textBased: false }) ] }),
            tracks: { ...initialState.tracks, subtitle: { kind: 'file', path: SUBTITLE_PATH } }
        });
        const section = requireSection(describePlaybackInfo(state), SUBTITLES_SECTION_ID);

        expect(section.rows.map((row: InfoRow): string => row.value)).toEqual([
            `subrip, ${SUBTITLE_LANGUAGE}, text`,
            'subrip, not shown',
            `${SUBTITLE_PATH}, selected`
        ]);
    });

    it('describes the active route, warning when an override forces it', () => {
        const initialState = createInitialSandboxState();
        const route = createActiveRoute({
            dolbyVisionProfile: DOLBY_VISION_PROFILE,
            rawVideoFrameFormat: RAW_FORMAT,
            selection: ROUTE_SELECTION,
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'raw-planes'
        });
        const forcedState = createState({ route: { active: route, override: { decoder: 'software', transport: 'auto' } } });
        const section = requireSection(describePlaybackInfo(forcedState), ROUTE_SECTION_ID);

        expect(requireRow(section, 'Decoder').value).toBe('bundled-hevc');
        expect(requireRow(section, 'Transport').value).toBe(`raw-planes, ${RAW_FORMAT}`);
        expect(requireRow(section, 'Dolby Vision').value).toBe(`profile ${DOLBY_VISION_PROFILE} reconstruction`);
        expect(requireRow(section, 'Selection').value).toBe(ROUTE_SELECTION);
        expect(requireRow(section, 'Override')).toEqual({ label: 'Override', tone: 'warning', value: 'decoder software, transport auto' });
        expect(getRow(createState({ route: { ...initialState.route, active: route } }), ROUTE_SECTION_ID, 'Override').tone).toBe('normal');
    });

    it('describes the clock\'s time, drift, and how far the presented frame trails it', () => {
        const initialState = createInitialSandboxState();
        const state = createSessionState({
            currentTimeMicroseconds: microseconds(CURRENT_TIME_MICROSECONDS),
            pageHidden: true,
            presentationTiming: {
                clockResetCount: CLOCK_RESET_COUNT,
                largestClockJumpMicroseconds: microseconds(LARGEST_CLOCK_JUMP_MICROSECONDS),
                lateFrameCount: 0,
                worstFrameLagMicroseconds: microseconds(0)
            },
            state: 'playing'
        });
        const presented = createPresenterTelemetry({ lastPresentedMediaTimeMicroseconds: microseconds(PRESENTED_TIME_MICROSECONDS) });
        const early = createPresenterTelemetry({ lastPresentedMediaTimeMicroseconds: microseconds(EARLY_PRESENTED_TIME_MICROSECONDS) });
        const section = requireSection(describePlaybackInfo({ ...state, telemetry: { ...state.telemetry, presenter: presented } }), CLOCK_SECTION_ID);

        expect(requireRow(section, 'Status').value).toBe(`${initialState.playback.status}, engine playing, page hidden`);
        expect(requireRow(section, 'Time').value).toBe(`${CURRENT_TIME_TEXT} of --:--`);
        expect(requireRow(section, 'Drift').value).toBe(DRIFT_TEXT);
        expect(requireRow(section, 'Lag').value).toBe(PRESENTED_LAG_TEXT);
        expect(getRow({ ...state, telemetry: { ...state.telemetry, presenter: early } }, CLOCK_SECTION_ID, 'Lag').value).toBe(PRESENTED_LEAD_TEXT);
    });

    it('shows the controller\'s fallback as its reason and the last error, as a failure', () => {
        const row = getRow(createSessionState({ fallbackReason: 'decode-failed', lastErrorMessage: ERROR_MESSAGE }), CLOCK_SECTION_ID, 'Fallback');

        expect(row).toEqual({ label: 'Fallback', tone: 'failure', value: `decode-failed: ${ERROR_MESSAGE}` });
    });

    it('counts the frame credits the page holds against the route\'s credit total', () => {
        const videoDecode = createDecodeSessionTelemetry({ pendingFrameCount: PENDING_FRAME_COUNT, queuedFrameCount: QUEUED_FRAME_COUNT });
        const heldCredits = QUEUED_FRAME_COUNT + PENDING_FRAME_COUNT;

        expect(getRow(createSessionState({ videoDecode }, createActiveRoute({ videoOutputMode: 'raw-planes' })), VIDEO_DECODE_SECTION_ID, 'Credits').value)
            .toBe(`${heldCredits} of ${MAX_DECODED_RAW_FRAME_CREDITS} held`);
        expect(getRow(createSessionState({ videoDecode }, createActiveRoute({ videoOutputMode: 'video-frame' })), VIDEO_DECODE_SECTION_ID, 'Credits').value)
            .toBe(`${heldCredits} of ${MAX_DECODED_FRAME_CREDITS} held`);
    });

    it('warns of dropped and late frames and of decode that fell behind outside a seek', () => {
        const state = createSessionState({
            discardedStaleVideoFrameCount: STALE_FRAME_COUNT,
            lastVideoDecodeLag: {
                frameEndTimeMicroseconds: microseconds(DECODE_FRAME_END_MICROSECONDS),
                gapMicroseconds: microseconds(DECODE_LAG_MICROSECONDS),
                generation: 1,
                postSeek: false,
                targetTimeMicroseconds: microseconds(DECODE_TARGET_MICROSECONDS)
            },
            presentationTiming: {
                clockResetCount: 0,
                largestClockJumpMicroseconds: microseconds(0),
                lateFrameCount: LATE_FRAME_COUNT,
                worstFrameLagMicroseconds: microseconds(WORST_FRAME_LAG_MICROSECONDS)
            },
            videoDecode: createDecodeSessionTelemetry({
                droppedFrameCount: SKIPPED_FRAME_COUNT,
                receivedHDR10PlusAbsentFrameCount: HDR10_PLUS_ABSENT_COUNT,
                receivedHDR10PlusValidFrameCount: HDR10_PLUS_VALID_COUNT
            })
        });
        const section = requireSection(describePlaybackInfo(state), VIDEO_DECODE_SECTION_ID);

        expect(requireRow(section, 'Dropped')).toEqual({
            label: 'Dropped',
            tone: 'warning',
            value: `${SKIPPED_FRAME_COUNT + STALE_FRAME_COUNT}: ${SKIPPED_FRAME_COUNT} skipped, ${STALE_FRAME_COUNT} stale`
        });
        expect(requireRow(section, 'Late')).toEqual({ label: 'Late', tone: 'warning', value: `${LATE_FRAME_COUNT}, worst lag 52.0 ms` });
        expect(requireRow(section, 'Decode lag')).toEqual({ label: 'Decode lag', tone: 'warning', value: '45.0 ms at 0:10.000, frame end 0:09.955, generation 1' });
        expect(requireRow(section, 'HDR10+').value).toBe(`${HDR10_PLUS_VALID_COUNT} valid, ${HDR10_PLUS_ABSENT_COUNT} absent, 0 malformed, 0 conflicting, 0 unsupported`);
        expect(getRow(createSessionState(), VIDEO_DECODE_SECTION_ID, 'Dropped').tone).toBe('normal');
    });

    it('describes the audio layout, underruns, latency, buffer, and signal from the bridge and worklet telemetry', () => {
        const state = createSessionState({
            audioBridge: createBridgeTelemetry({ pendingFrameCount: PENDING_AUDIO_FRAMES, pendingSampleCount: PENDING_CHUNK_COUNT }),
            audioOutput: createWorkletTelemetry({
                hasPhysicalOutputTimeCorrelation: true,
                overflowEvents: 1,
                queuedFrames: QUEUED_AUDIO_FRAMES,
                signal: {
                    analyzedFrameCount: SIGNAL_SAMPLE_COUNT,
                    analyzedSampleCount: SIGNAL_SAMPLE_COUNT,
                    clippedSampleCount: 0,
                    nonFiniteSampleCount: 0,
                    samplePeak: SIGNAL_PEAK,
                    sampleSquareSum: SIGNAL_SQUARE_SUM
                },
                underflowEvents: UNDERFLOW_EVENT_COUNT,
                underflowFrames: TENTH_SECOND_FRAMES
            }),
            audioPath: 'ready',
            videoDecode: createDecodeSessionTelemetry({
                audioChannelCount: STEREO_CHANNEL_COUNT,
                audioCodec: SURROUND_CODEC,
                audioSampleRate: SAMPLE_RATE,
                audioSourceChannelCount: SURROUND_CHANNEL_COUNT,
                audioSourceSampleRate: SAMPLE_RATE
            })
        });
        const section = requireSection(describePlaybackInfo(state), AUDIO_SECTION_ID);

        expect(requireRow(section, 'Layout').value).toBe(`${SURROUND_CODEC}: ${SURROUND_CHANNEL_COUNT} ch, 48 kHz -> ${STEREO_CHANNEL_COUNT} ch, 48 kHz`);
        expect(requireRow(section, 'Underruns')).toEqual({ label: 'Underruns', tone: 'warning', value: `${UNDERFLOW_EVENT_COUNT} events, 100.0 ms` });
        expect(requireRow(section, 'Overflows').tone).toBe('failure');
        expect(requireRow(section, 'Latency').value).toBe('200.0 ms queued in the worklet, output time corrected to the device');
        expect(requireRow(section, 'Buffered').value).toBe(`300.0 ms submitted and unplayed, ${PENDING_CHUNK_COUNT} of ${MAX_DECODED_AUDIO_SAMPLE_CREDITS} chunk credits`);
        expect(requireRow(section, 'Signal')).toEqual({ label: 'Signal', tone: 'normal', value: 'peak -6.0 dBFS, RMS -12.0 dBFS, 0 clipped, 0 non-finite' });
        expect(section.rows.some((row: InfoRow): boolean => row.label === 'Native audio')).toBe(false);
    });

    it('counts audio in frames while the output rate is unknown, and describes native audio on its route', () => {
        const state = createSessionState(
            { audioOutput: createWorkletTelemetry({ underflowFrames: TENTH_SECOND_FRAMES }) },
            createActiveRoute({ audioOutputMode: 'native-media' })
        );
        const section = requireSection(describePlaybackInfo(state), AUDIO_SECTION_ID);

        expect(requireRow(section, 'Underruns').value).toBe(`0 events, ${TENTH_SECOND_FRAMES} frames`);
        expect(requireRow(section, 'Native audio').value).toBe('clock not ready, 0 segments');
    });

    it('describes the presenter\'s state, fallback, metadata counters, frame timing, and the plan', () => {
        const renderSettings = createHDRToSDRRenderSettings();
        const initialState = createInitialSandboxState();
        const plan = createPresentationPlan({
            passes: [ createPlannedPass({ label: 'Presentation signal' }), createPlannedPass({ label: 'Presentation output' }) ],
            textures: [ createPlannedTexture({ height: PLAN_TEXTURE_SIZE, id: 'signal', width: PLAN_TEXTURE_SIZE }) ]
        });
        const state = createState({
            presentation: { ...initialState.presentation, plan, renderSettings },
            telemetry: {
                ...initialState.telemetry,
                presenter: createPresenterTelemetry({
                    dolbyVisionFELAuthorizationFailure: FEL_FAILURE,
                    fallbackDetail: PRESENTER_FALLBACK_DETAIL,
                    fallbackReason: 'frame-render-failed',
                    lastCallbackTimeMicroseconds: microseconds(CALLBACK_TIME_MICROSECONDS),
                    lastExpectedDisplayTimeMicroseconds: microseconds(EXPECTED_DISPLAY_TIME_MICROSECONDS),
                    lastHDR10PlusInputPeakNits: HDR10_PLUS_PEAK_NITS,
                    lastHDR10PlusMetadataStatus: 'valid',
                    lastPresentedMediaTimeMicroseconds: microseconds(PRESENTED_TIME_MICROSECONDS)
                })
            }
        });
        const section = requireSection(describePlaybackInfo(state), PRESENTATION_SECTION_ID);
        const toneMapping = renderSettings.toneMapping;

        expect(requireRow(section, 'Fallback')).toEqual({ label: 'Fallback', tone: 'failure', value: `frame-render-failed: ${PRESENTER_FALLBACK_DETAIL}` });
        expect(requireRow(section, 'Last frame').value).toBe(`0:10.000, ${DISPLAY_LEAD_TEXT}`);
        expect(requireRow(section, 'HDR10+').value).toBe('0 applied, 0 carried, 0 static fallback, last valid, peak 1000 nits');
        expect(requireRow(section, 'FEL authorization')).toEqual({ label: 'FEL authorization', tone: 'failure', value: FEL_FAILURE });
        expect(requireRow(section, 'Plan').value).toBe(`2 passes, 1 textures, ${plan.sourceKind} source`);
        expect(requireRow(section, 'Render settings').value).toBe(
            `hdr-to-sdr, ${toneMapping.operator}, ${toneMapping.inputPeakNits} nits in, ${toneMapping.outputPeakNits} nits out, paper white ${toneMapping.paperWhiteNits} nits`
        );
        expect(requireRow(section, 'Display').value).toContain(`exposure ${toneMapping.exposure}`);
    });

    it('describes each authorization with a row per failed route key and the failure as reason and detail', () => {
        const initialState = createInitialSandboxState();
        const state = createState({
            telemetry: {
                ...initialState.telemetry,
                authorization: {
                    dolbyVision: createDolbyVisionAuthorization({ failureDetail: null, failureReason: 'timeout', status: 'rejected' }),
                    externalDolbyVision: createExternalDolbyVisionAuthorization({ maximumInputChannelError: CHANNEL_ERROR, status: 'authorized' }),
                    externalHDR: createExternalHDRAuthorization({
                        authorizedRouteKeys: [ EXTERNAL_HDR_ROUTE_KEY ],
                        maximumChannelErrors: { [EXTERNAL_HDR_ROUTE_KEY]: CHANNEL_ERROR },
                        sampleCounts: { [EXTERNAL_HDR_ROUTE_KEY]: SAMPLE_COUNT },
                        status: 'authorized',
                        targetFormat: TARGET_FORMAT
                    }),
                    rawHDR: createRawHDRAuthorization({
                        failureDetails: { [RAW_HDR_ROUTE_KEY]: PIXEL_MISMATCH_DETAIL },
                        failureReasons: { [RAW_HDR_ROUTE_KEY]: 'pixel-mismatch' },
                        rejectedRouteKeys: [ RAW_HDR_ROUTE_KEY ],
                        status: 'rejected',
                        targetFormat: TARGET_FORMAT
                    })
                }
            }
        });
        const section = requireSection(describePlaybackInfo(state), AUTHORIZATION_SECTION_ID);

        expect(section.rows).toEqual([
            { label: 'Raw HDR', tone: 'failure', value: `rejected, 0 authorized, 0 pending, 1 rejected, ${TARGET_FORMAT}` },
            { label: '', tone: 'failure', value: `rejected ${RAW_HDR_ROUTE_KEY}: pixel-mismatch: ${PIXEL_MISMATCH_DETAIL}` },
            { label: 'External HDR', tone: 'success', value: `authorized, ${TARGET_FORMAT}` },
            { label: '', tone: 'success', value: `authorized ${EXTERNAL_HDR_ROUTE_KEY}, ${SAMPLE_COUNT} samples, max error ${CHANNEL_ERROR_TEXT}` },
            { label: 'Dolby Vision', tone: 'failure', value: `rejected, ${state.telemetry.authorization.dolbyVision?.routeKey}` },
            { label: '', tone: 'failure', value: 'timeout' },
            { label: 'External Dolby Vision', tone: 'success', value: `authorized, ${state.telemetry.authorization.externalDolbyVision?.routeKey}, max input error ${CHANNEL_ERROR_TEXT}` }
        ]);
    });

    it('lists failures newest first as layer, code, and detail beside their page time', () => {
        const section = requireSection(describePlaybackInfo(createState({ failures: [ FIRST_FAILURE, SECOND_FAILURE ] })), FAILURES_SECTION_ID);

        expect(section.title).toBe('Failures (2)');
        expect(section.rows).toEqual([
            { label: '15.3 s', tone: 'failure', value: `${SECOND_FAILURE.layer} ${SECOND_FAILURE.code}: ${SECOND_FAILURE.detail}` },
            { label: '1.2 s', tone: 'failure', value: `${FIRST_FAILURE.layer} ${FIRST_FAILURE.code}: ${FIRST_FAILURE.detail}` }
        ]);
    });

    it('orders its sections and leaves out the ones without telemetry', () => {
        const media = createMediaDescription({ videoTracks: [ createVideoTrack() ] });

        expect(getSectionIds(createSessionState({}, createActiveRoute(), { failures: [ FIRST_FAILURE ], media }))).toEqual([
            MEDIA_SECTION_ID,
            VIDEO_SECTION_ID,
            ROUTE_SECTION_ID,
            CLOCK_SECTION_ID,
            VIDEO_DECODE_SECTION_ID,
            AUDIO_SECTION_ID,
            FAILURES_SECTION_ID
        ]);
        expect(getSectionIds(createState({ media }))).toEqual([ MEDIA_SECTION_ID, VIDEO_SECTION_ID ]);
    });
});

describe('describeClockSource', () => {
    it.each(CLOCK_SOURCE_CASES)('names the clock $description', ({ controller, expected, route }) => {
        expect(describeClockSource(route, createControllerTelemetry(controller))).toBe(expected);
    });
});
