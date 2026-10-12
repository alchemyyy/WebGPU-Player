// The playback info: the sandbox state as grouped label and value rows, from the media, the route, and the engine's telemetry.
import type { AudioSignalTelemetry, AudioWorkletTelemetry } from 'webgpu-player/audio/output/AudioWorkletProtocol';
import type { CustomDecodeAudioBridgeTelemetry } from 'webgpu-player/audio/output/CustomDecodeAudioBridge';
import type { Microseconds } from 'webgpu-player/MediaTime';
import type { CustomDecodeSessionTelemetry } from 'webgpu-player/pipeline/CustomDecodeSession';
import type {
    CustomPlaybackTelemetry,
    CustomPlaybackVideoDecodeLagTelemetry
} from 'webgpu-player/pipeline/CustomPlaybackControllerTypes';
import {
    MAX_DECODED_AUDIO_SAMPLE_CREDITS,
    MAX_DECODED_FRAME_CREDITS,
    MAX_DECODED_RAW_FRAME_CREDITS,
    type CustomDecodeVideoOutputMode
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import type { MediaClockSnapshot } from 'webgpu-player/pipeline/MediaClock';
import type { HDRToSDRRenderSettings, RenderSettings } from 'webgpu-player/presentation/RenderSettings';
import type { PresentationTelemetry } from 'webgpu-player/presentation/WebGPUPresenter';
import { requireMicroseconds } from 'webgpu-player/TimeMath';
import type { DolbyVisionAuthorizationTelemetry } from 'webgpu-player/validation/DolbyVisionPresentationAuthorization';
import type { ExternalDolbyVisionAuthorizationTelemetry } from 'webgpu-player/validation/ExternalDolbyVisionPresentationAuthorization';
import type { ExternalHDRAuthorizationTelemetry } from 'webgpu-player/validation/ExternalHDRPresentationAuthorization';
import type { RawHDRAuthorizationTelemetry } from 'webgpu-player/validation/RawHDRPresentationAuthorization';

import type {
    ActiveRoute,
    AudioTrackDescription,
    AuthorizationTelemetry,
    ColorDescription,
    DolbyVisionDescription,
    MediaDescription,
    PresentationState,
    RouteOverride,
    SandboxFailure,
    SandboxState,
    SubtitleTrackDescription,
    TrackState,
    VideoTrackDescription
} from '../../contracts/SandboxContracts';
import {
    formatAudioFrames,
    formatBitrate,
    formatBytes,
    formatCodec,
    formatDecibels,
    formatDimensions,
    formatFrameRate,
    formatMilliseconds,
    formatNormalizedError,
    formatPageTime,
    formatPercent,
    formatPreciseMediaTime,
    formatSampleRate,
    joinPresentValues,
    MISSING_VALUE_TEXT,
    VALUE_SEPARATOR,
    type DiagnosticTone
} from './DiagnosticsFormat';

export type InfoRow = Readonly<{
    label: string
    tone: DiagnosticTone
    value: string
}>;

export type InfoSection = Readonly<{
    /** Stable across refreshes, so the panel keeps the section's element and whether it is open */
    id: string
    rows: readonly InfoRow[]
    title: string
}>;

/** The slices of the state the playback info reads. */
export type PlaybackInfoState = Pick<SandboxState, 'failures' | 'media' | 'playback' | 'presentation' | 'route' | 'telemetry' | 'tracks'>;

type AuthorizationStatus = DolbyVisionAuthorizationTelemetry['status'];

const NONE_TEXT = 'none';
const SELECTED_TEXT = 'selected';
const DEFAULT_TRACK_TEXT = 'default';
const FORCED_TRACK_TEXT = 'forced';
// Labels a row that continues the row above it, such as one route key of an authorization
const CONTINUATION_LABEL = '';
const GAIN_DECIMALS = 2;

/**
 * Describes the playback as sections in a fixed order: the media and its tracks, the route, the clock, video decode, audio, presentation, authorization, and the failure log.
 * A section with nothing to report is left out, such as the clock before a session starts, so with nothing open and no failures there are none.
 */
export function describePlaybackInfo(state: PlaybackInfoState): InfoSection[] {
    const sections: InfoSection[] = [];
    if (state.media !== null) {
        sections.push(describeMediaSection(state.media));
        for (const track of state.media.videoTracks) {
            sections.push(describeVideoTrackSection(track, state.tracks));
        }
        pushSection(sections, describeAudioTracksSection(state.media.audioTracks, state.tracks));
        pushSection(sections, describeSubtitlesSection(state.media.subtitleTracks, state.tracks));
    }
    if (state.route.active !== null) {
        sections.push(describeRouteSection(state.route.active, state.route.override));
    }
    const controller = state.telemetry.controller;
    if (controller !== null) {
        sections.push(describeClockSection(state, controller));
        sections.push(describeVideoDecodeSection(controller, state.route.active, state.telemetry.presenter));
        sections.push(describeAudioSection(controller, state.route.active));
    }
    if (state.telemetry.presenter !== null || state.presentation.plan !== null) {
        sections.push(describePresentationSection(state.presentation, state.telemetry.presenter));
    }
    pushSection(sections, describeAuthorizationSection(state.telemetry.authorization));
    pushSection(sections, describeFailuresSection(state.failures));
    return sections;
}

/**
 * Names what drives the playback clock, from the route's audio output and the audio telemetry.
 * Decoded PCM re-anchors the media clock only while the output time is correlated to the device; native audio is its element's time.
 */
export function describeClockSource(route: ActiveRoute | null, controller: CustomPlaybackTelemetry): string {
    if (route === null) {
        return MISSING_VALUE_TEXT;
    }
    const decode = controller.videoDecode;
    switch (route.audioOutputMode) {
        case 'native-media':
            if (decode.nativeAudioEnded) {
                return 'media clock, since the native audio ended';
            }
            return decode.nativeAudioClockReady ? 'native audio element' : 'media clock, until the native audio is ready';
        case 'decoded-pcm':
            if (controller.audioPath !== 'ready') {
                return `media clock, while audio is ${controller.audioPath}`;
            }
            if (decode.audioEnded) {
                return 'audio output until its tail plays out, then the media clock';
            }
            return controller.audioOutput?.hasPhysicalOutputTimeCorrelation ?
                'audio output, at the device\'s output time' :
                'media clock, while the audio output time is uncorrelated';
        case null:
            return 'media clock, without audio';
    }
}

function createRow(label: string, value: string, tone: DiagnosticTone = 'normal'): InfoRow {
    return { label, tone, value };
}

function pushSection(sections: InfoSection[], section: InfoSection | null): void {
    if (section !== null) {
        sections.push(section);
    }
}

function getCountTone(count: number, tone: DiagnosticTone): DiagnosticTone {
    return count > 0 ? tone : 'normal';
}

function formatTrackName(name: string | null): string | null {
    return name === null ? null : `'${name}'`;
}

/** A failure as `code: detail`, or the code alone without a detail. */
function formatFailure(code: string | undefined, detail: string | null | undefined): string {
    if (code === undefined) {
        return MISSING_VALUE_TEXT;
    }
    return detail === null || detail === undefined ? code : `${code}: ${detail}`;
}

// Media

function describeMediaSection(media: MediaDescription): InfoSection {
    const rows: InfoRow[] = [];
    rows.push(createRow('File', media.path));
    rows.push(createRow('Container', media.container));
    rows.push(createRow('Size', formatBytes(media.sizeBytes)));
    rows.push(createRow('Duration', formatPreciseMediaTime(media.durationMicroseconds)));
    rows.push(createRow('Bitrate', media.durationMicroseconds === null ? MISSING_VALUE_TEXT : formatBitrate(media.sizeBytes, media.durationMicroseconds)));
    rows.push(createRow('Tracks', `${media.videoTracks.length} video, ${media.audioTracks.length} audio, ${media.subtitleTracks.length} subtitle`));
    return { id: 'media', rows, title: 'Media' };
}

function describeVideoTrackSection(track: VideoTrackDescription, tracks: TrackState): InfoSection {
    const rows: InfoRow[] = [];
    rows.push(createRow('Codec', joinPresentValues([ formatCodec(track.codec, track.profile), track.level === null ? null : `level ${track.level}` ])));
    rows.push(createRow('Size', describeVideoSize(track)));
    rows.push(createRow('Frame rate', track.frameRate === null ? MISSING_VALUE_TEXT : formatFrameRate(track.frameRate)));
    rows.push(createRow('Bit depth', track.bitDepth === null ? MISSING_VALUE_TEXT : `${track.bitDepth}-bit`));
    rows.push(createRow('Color', describeColor(track.color)));
    rows.push(createRow('Dynamic range', track.dynamicRange));
    rows.push(createRow('Dolby Vision', describeDolbyVision(track.dolbyVision)));
    rows.push(createRow('Language', track.language ?? MISSING_VALUE_TEXT));
    rows.push(createRow('Name', track.name ?? MISSING_VALUE_TEXT));
    const title = `Video #${track.index}`;
    return { id: `video-${track.index}`, rows, title: tracks.videoTrackIndex === track.index ? `${title}${VALUE_SEPARATOR}${SELECTED_TEXT}` : title };
}

/** The display size, and the coded size when it differs. */
function describeVideoSize(track: VideoTrackDescription): string {
    const displaySize = formatDimensions(track.displayWidth, track.displayHeight);
    if (track.codedWidth === track.displayWidth && track.codedHeight === track.displayHeight) {
        return displaySize;
    }
    return `${displaySize}${VALUE_SEPARATOR}coded ${formatDimensions(track.codedWidth, track.codedHeight)}`;
}

function describeColor(color: ColorDescription | null): string {
    if (color === null) {
        return MISSING_VALUE_TEXT;
    }
    return joinPresentValues([
        color.primaries === null ? null : `primaries ${color.primaries}`,
        color.transfer === null ? null : `transfer ${color.transfer}`,
        color.matrix === null ? null : `matrix ${color.matrix}`,
        color.range === null ? null : `${color.range} range`
    ]);
}

function describeDolbyVision(dolbyVision: DolbyVisionDescription | null): string {
    if (dolbyVision === null) {
        return NONE_TEXT;
    }
    return joinPresentValues([
        `profile ${dolbyVision.profile}`,
        `level ${dolbyVision.level}`,
        `BL compatibility ${dolbyVision.blCompatibilityId}`,
        dolbyVision.hasEnhancementLayer ? 'with EL' : 'no EL'
    ]);
}

function describeAudioTracksSection(audioTracks: readonly AudioTrackDescription[], tracks: TrackState): InfoSection | null {
    if (audioTracks.length === 0) {
        return null;
    }
    const rows: InfoRow[] = [];
    for (const track of audioTracks) {
        rows.push(createRow(`#${track.index}`, joinPresentValues([
            formatCodec(track.codec, track.profile),
            `${track.channelCount} ch`,
            formatSampleRate(track.sampleRate),
            track.language,
            formatTrackName(track.name),
            track.default ? DEFAULT_TRACK_TEXT : null,
            tracks.audioTrackIndex === track.index ? SELECTED_TEXT : null
        ])));
    }
    return { id: 'audio-tracks', rows, title: 'Audio tracks' };
}

function describeSubtitlesSection(subtitleTracks: readonly SubtitleTrackDescription[], tracks: TrackState): InfoSection | null {
    const selection = tracks.subtitle;
    const rows: InfoRow[] = [];
    for (const track of subtitleTracks) {
        const selected = selection?.kind === 'embedded' && selection.trackIndex === track.index;
        rows.push(createRow(`#${track.index}`, joinPresentValues([
            track.codec,
            track.language,
            formatTrackName(track.name),
            track.default ? DEFAULT_TRACK_TEXT : null,
            track.forced ? FORCED_TRACK_TEXT : null,
            track.textBased ? 'text' : 'not shown',
            selected ? SELECTED_TEXT : null
        ])));
    }
    if (selection?.kind === 'file') {
        rows.push(createRow('File', `${selection.path}${VALUE_SEPARATOR}${SELECTED_TEXT}`));
    }
    return rows.length === 0 ? null : { id: 'subtitles', rows, title: 'Subtitles' };
}

// Route

function describeRouteSection(active: ActiveRoute, override: RouteOverride): InfoSection {
    const rows: InfoRow[] = [];
    rows.push(createRow('Decoder', active.videoDecoderBackend));
    rows.push(createRow('Transport', joinPresentValues([ active.videoOutputMode, active.rawVideoFrameFormat ])));
    rows.push(createRow('Dolby Vision', active.dolbyVisionProfile === null ? NONE_TEXT : `profile ${active.dolbyVisionProfile} reconstruction`));
    rows.push(createRow('Native HDR', active.nativeHDRTransfer ?? NONE_TEXT));
    rows.push(createRow('HDR metadata', active.neutralizeHDRColorMetadata ? 'neutralized' : 'kept'));
    rows.push(createRow('Audio output', active.audioOutputMode ?? NONE_TEXT));
    rows.push(createRow('Selection', active.selection));
    const forced = override.decoder !== 'auto' || override.transport !== 'auto';
    rows.push(createRow('Override', `decoder ${override.decoder}${VALUE_SEPARATOR}transport ${override.transport}`, forced ? 'warning' : 'normal'));
    return { id: 'route', rows, title: 'Route' };
}

// Clock

function describeClockSection(state: PlaybackInfoState, controller: CustomPlaybackTelemetry): InfoSection {
    const rows: InfoRow[] = [];
    const timing = controller.presentationTiming;
    rows.push(createRow('Status', joinPresentValues([ state.playback.status, `engine ${controller.state}`, controller.pageHidden ? 'page hidden' : null ])));
    rows.push(createRow('Source', describeClockSource(state.route.active, controller)));
    rows.push(createRow('Time', `${formatPreciseMediaTime(controller.currentTimeMicroseconds, controller.durationMicroseconds)} of ${formatPreciseMediaTime(controller.durationMicroseconds)}`));
    rows.push(createRow('Media clock', describeMediaClock(controller.clock)));
    rows.push(createRow('Drift', `${timing.clockResetCount} re-anchors${VALUE_SEPARATOR}largest ${formatMilliseconds(timing.largestClockJumpMicroseconds)}`));
    rows.push(createRow('Lag', describePresentedFrameLag(controller.currentTimeMicroseconds, state.telemetry.presenter)));
    rows.push(createRow('Startup', controller.startupDurationMicroseconds === null ? MISSING_VALUE_TEXT : formatMilliseconds(controller.startupDurationMicroseconds)));
    rows.push(createRow('Generations', joinPresentValues([
        `active ${controller.activeGeneration ?? MISSING_VALUE_TEXT}`,
        `${controller.playCount} plays`,
        `${controller.fallbackCount} fallbacks`,
        `${controller.staleEventCount} stale events`
    ])));
    rows.push(describeControllerFailure(controller));
    return { id: 'clock', rows, title: 'Clock' };
}

function describeMediaClock(clock: MediaClockSnapshot): string {
    return joinPresentValues([
        formatPreciseMediaTime(clock.mediaTimeMicroseconds),
        `${clock.paused ? 'paused' : 'running'} at ${clock.playbackRate}x`,
        `generation ${clock.generation}`
    ]);
}

/** How far the presented frame trails the clock; each tick presents the newest frame at or before it, so a frame duration is normal. */
function describePresentedFrameLag(currentTimeMicroseconds: Microseconds, presenter: PresentationTelemetry | null): string {
    const presentedTimeMicroseconds = presenter?.lastPresentedMediaTimeMicroseconds ?? null;
    if (presentedTimeMicroseconds === null) {
        return MISSING_VALUE_TEXT;
    }
    const lagMicroseconds = requireMicroseconds(currentTimeMicroseconds - presentedTimeMicroseconds, 'Presented frame lag');
    if (lagMicroseconds < 0) {
        return `presented frame ${formatMilliseconds(requireMicroseconds(-lagMicroseconds))} ahead of the clock`;
    }
    return `presented frame ${formatMilliseconds(lagMicroseconds)} behind the clock`;
}

function describeControllerFailure(controller: CustomPlaybackTelemetry): InfoRow {
    if (controller.fallbackReason !== null) {
        return createRow('Fallback', formatFailure(controller.fallbackReason, controller.lastErrorMessage), 'failure');
    }
    if (controller.lastErrorMessage !== null) {
        return createRow('Last error', controller.lastErrorMessage, 'failure');
    }
    return createRow('Fallback', NONE_TEXT, 'muted');
}

// Video decode

function describeVideoDecodeSection(
    controller: CustomPlaybackTelemetry,
    route: ActiveRoute | null,
    presenter: PresentationTelemetry | null
): InfoSection {
    const decode = controller.videoDecode;
    const timing = controller.presentationTiming;
    const droppedFrameCount = decode.droppedFrameCount + controller.discardedStaleVideoFrameCount;
    const rows: InfoRow[] = [];
    rows.push(createRow('State', joinPresentValues([
        decode.state,
        decode.failureKind,
        `epoch ${decode.videoEpoch}`,
        decode.videoProgressPhase,
        decode.videoEnded ? 'ended' : null
    ]), decode.failureKind === null ? 'normal' : 'failure'));
    rows.push(createRow('Queue', `${decode.queuedFrameCount} queued${VALUE_SEPARATOR}${decode.pendingFrameCount} pending${VALUE_SEPARATOR}peak ${decode.peakFrameCount}`));
    rows.push(createRow('Credits', describeFrameCredits(route?.videoOutputMode ?? null, decode)));
    rows.push(createRow('Frames', `${decode.receivedFrameCount} decoded${VALUE_SEPARATOR}${decode.takenFrameCount} taken${VALUE_SEPARATOR}${presenter?.presentedFrameCount ?? MISSING_VALUE_TEXT} presented`));
    rows.push(createRow(
        'Dropped',
        `${droppedFrameCount}: ${decode.droppedFrameCount} skipped${VALUE_SEPARATOR}${controller.discardedStaleVideoFrameCount} stale`,
        getCountTone(droppedFrameCount, 'warning')
    ));
    rows.push(createRow(
        'Late',
        `${timing.lateFrameCount}${VALUE_SEPARATOR}worst lag ${formatMilliseconds(timing.worstFrameLagMicroseconds)}`,
        getCountTone(timing.lateFrameCount, 'warning')
    ));
    rows.push(describeDecodeLag(controller.lastVideoDecodeLag));
    rows.push(createRow('Packets', `${decode.submittedVideoPacketCount} submitted${VALUE_SEPARATOR}${decode.staleFrameCount} stale frames`));
    rows.push(createRow('Resyncs', joinPresentValues([
        `${decode.videoResyncCount} resyncs`,
        `${decode.videoSuspensionCount} suspensions`,
        controller.videoResyncPending ? 'resync pending' : null,
        controller.videoSuspended ? 'suspended' : null
    ])));
    rows.push(createRow('Frame times', joinPresentValues([
        `first ${formatPreciseMediaTime(decode.firstFrameMediaTimeMicroseconds)}`,
        `last ${formatPreciseMediaTime(decode.lastFrameMediaTimeMicroseconds)} to ${formatPreciseMediaTime(decode.lastFrameEndMediaTimeMicroseconds)}`
    ])));
    rows.push(createRow(
        'Raw frames',
        `${decode.recycledRawFrameCount} recycled${VALUE_SEPARATOR}${decode.abandonedRawFrameCount} abandoned`,
        getCountTone(decode.abandonedRawFrameCount, 'warning')
    ));
    rows.push(createRow('Dolby Vision', joinPresentValues([
        `${decode.receivedDolbyVisionFrameCount} frames`,
        `${decode.receivedDolbyVisionRPUCount} RPUs`,
        `${decode.receivedDolbyVisionEnhancementFrameCount} EL frames`
    ])));
    rows.push(createRow('HDR10+', joinPresentValues([
        `${decode.receivedHDR10PlusValidFrameCount} valid`,
        `${decode.receivedHDR10PlusAbsentFrameCount} absent`,
        `${decode.receivedHDR10PlusMalformedFrameCount} malformed`,
        `${decode.receivedHDR10PlusConflictingFrameCount} conflicting`,
        `${decode.receivedHDR10PlusUnsupportedFrameCount} unsupported`
    ])));
    rows.push(createRow('Static HDR', describeStaticHDRScan(decode)));
    rows.push(createRow('Worker', decode.workerReused ? 'reused' : 'new'));
    return { id: 'video-decode', rows, title: 'Video decode' };
}

/** The decode credits the page holds: a frame keeps its credit from its arrival until the presenter releases it. */
function describeFrameCredits(outputMode: CustomDecodeVideoOutputMode | null, decode: CustomDecodeSessionTelemetry): string {
    const heldCredits = decode.queuedFrameCount + decode.pendingFrameCount;
    switch (outputMode) {
        case 'raw-planes':
            return `${heldCredits} of ${MAX_DECODED_RAW_FRAME_CREDITS} held`;
        case 'video-frame':
            return `${heldCredits} of ${MAX_DECODED_FRAME_CREDITS} held`;
        case null:
            return `${heldCredits} held`;
    }
}

/** The last time a frame arrived after its target; after a seek, that is the decoder catching up. */
function describeDecodeLag(lag: CustomPlaybackVideoDecodeLagTelemetry | null): InfoRow {
    if (lag === null) {
        return createRow('Decode lag', NONE_TEXT, 'muted');
    }
    return createRow('Decode lag', joinPresentValues([
        `${formatMilliseconds(lag.gapMicroseconds)} at ${formatPreciseMediaTime(lag.targetTimeMicroseconds)}`,
        `frame end ${formatPreciseMediaTime(lag.frameEndTimeMicroseconds)}`,
        lag.postSeek ? 'after a seek' : null,
        `generation ${lag.generation}`
    ]), lag.postSeek ? 'normal' : 'warning');
}

function describeStaticHDRScan(decode: CustomDecodeSessionTelemetry): string {
    if (decode.staticHDRMetadataStatus === null) {
        return 'not scanned';
    }
    return joinPresentValues([
        decode.staticHDRMetadataStatus,
        `${decode.staticHDRMetadataScanAccessUnitCount} access units scanned`,
        decode.staticHDRMetadataFirstAccessUnitIndex === null ? null : `first at access unit ${decode.staticHDRMetadataFirstAccessUnitIndex}`
    ]);
}

// Audio

function describeAudioSection(controller: CustomPlaybackTelemetry, route: ActiveRoute | null): InfoSection {
    const decode = controller.videoDecode;
    const sampleRate = decode.audioSampleRate;
    const rows: InfoRow[] = [];
    rows.push(createRow('Path', joinPresentValues([
        controller.audioPath,
        route?.audioOutputMode ?? null,
        controller.audioOutputSwitchPending ? 'layout switch pending' : null
    ]), controller.audioPath === 'unavailable' ? 'failure' : 'normal'));
    rows.push(createRow('Volume', joinPresentValues([
        formatPercent(controller.volume),
        controller.muted ? 'muted' : null,
        `normalization gain ${controller.normalizationGain.toFixed(GAIN_DECIMALS)}`
    ])));
    rows.push(createRow('Layout', describeAudioLayout(decode)));
    if (controller.audioOutput !== null) {
        rows.push(...describeAudioOutputRows(controller.audioOutput, sampleRate));
    }
    if (controller.audioBridge !== null) {
        rows.push(...describeAudioBridgeRows(controller.audioBridge, sampleRate));
    }
    rows.push(createRow('Decode', joinPresentValues([
        `epoch ${decode.audioEpoch}`,
        `${decode.audioResyncCount} resyncs`,
        decode.audioResyncPending ? 'resync pending' : null,
        `${decode.receivedAudioSampleCount} chunks received`,
        `${decode.submittedAudioSampleCount} submitted`,
        `${decode.staleAudioSampleCount} stale`,
        `last at ${formatPreciseMediaTime(decode.lastAudioMediaTimeMicroseconds)}`,
        decode.audioEnded ? 'ended' : null
    ])));
    if (route?.audioOutputMode === 'native-media') {
        rows.push(createRow('Native audio', joinPresentValues([
            decode.nativeAudioClockReady ? 'clock ready' : 'clock not ready',
            `${decode.receivedNativeAudioSegmentCount} segments`,
            decode.nativeAudioEnded ? 'ended' : null
        ])));
    }
    return { id: 'audio', rows, title: 'Audio' };
}

/** The source's channels and rate, then what the output plays. */
function describeAudioLayout(decode: CustomDecodeSessionTelemetry): string {
    if (decode.audioCodec === null) {
        return NONE_TEXT;
    }
    const sourceLayout = describeChannelsAndRate(decode.audioSourceChannelCount, decode.audioSourceSampleRate);
    const outputLayout = describeChannelsAndRate(decode.audioChannelCount, decode.audioSampleRate);
    return `${decode.audioCodec}: ${sourceLayout} -> ${outputLayout}`;
}

function describeChannelsAndRate(channelCount: number | null, sampleRate: number | null): string {
    return joinPresentValues([ channelCount === null ? null : `${channelCount} ch`, sampleRate === null ? null : formatSampleRate(sampleRate) ]);
}

function describeAudioOutputRows(output: AudioWorkletTelemetry, sampleRate: number | null): InfoRow[] {
    const rows: InfoRow[] = [];
    rows.push(createRow(
        'Underruns',
        `${output.underflowEvents} events${VALUE_SEPARATOR}${formatAudioFrames(output.underflowFrames, sampleRate)}`,
        getCountTone(output.underflowEvents, 'warning')
    ));
    rows.push(createRow('Overflows', joinPresentValues([
        `${output.overflowEvents} events`,
        formatAudioFrames(output.overflowFrames, sampleRate),
        `${output.droppedFrames} frames dropped`,
        `${output.staleChunks} stale chunks`
    ]), getCountTone(output.overflowEvents, 'failure')));
    rows.push(createRow('Latency', joinPresentValues([
        `${formatAudioFrames(output.queuedFrames, sampleRate)} queued in the worklet`,
        output.hasPhysicalOutputTimeCorrelation ? 'output time corrected to the device' : 'output time uncorrected'
    ])));
    rows.push(createRow('Output', joinPresentValues([
        formatPreciseMediaTime(output.mediaTimeMicroseconds),
        output.playing ? 'playing' : 'stopped',
        `generation ${output.generation}`,
        `last report ${output.reason}`
    ])));
    if (output.signal) {
        rows.push(describeSignal(output.signal));
    }
    return rows;
}

function describeSignal(signal: AudioSignalTelemetry): InfoRow {
    const rootMeanSquare = signal.analyzedSampleCount > 0 ? Math.sqrt(signal.sampleSquareSum / signal.analyzedSampleCount) : 0;
    return createRow('Signal', joinPresentValues([
        `peak ${formatDecibels(signal.samplePeak)}`,
        `RMS ${formatDecibels(rootMeanSquare)}`,
        `${signal.clippedSampleCount} clipped`,
        `${signal.nonFiniteSampleCount} non-finite`
    ]), getCountTone(signal.clippedSampleCount + signal.nonFiniteSampleCount, 'warning'));
}

function describeAudioBridgeRows(bridge: CustomDecodeAudioBridgeTelemetry, sampleRate: number | null): InfoRow[] {
    const rows: InfoRow[] = [];
    rows.push(createRow('Buffered', joinPresentValues([
        `${formatAudioFrames(bridge.pendingFrameCount, sampleRate)} submitted and unplayed`,
        `${bridge.pendingSampleCount} of ${MAX_DECODED_AUDIO_SAMPLE_CREDITS} chunk credits`
    ])));
    rows.push(createRow('Submitted', joinPresentValues([
        `${bridge.submittedSampleCount} chunks`,
        `to ${formatPreciseMediaTime(bridge.submittedEndMediaTimeMicroseconds)}`,
        `${bridge.releasedSampleCredits} credits released`,
        `${bridge.staleSampleCount} stale`,
        bridge.failed ? 'failed' : null
    ]), bridge.failed ? 'failure' : 'normal'));
    return rows;
}

// Presentation

function describePresentationSection(presentation: PresentationState, presenter: PresentationTelemetry | null): InfoSection {
    const rows: InfoRow[] = [];
    if (presenter !== null) {
        rows.push(...describePresenterRows(presenter));
    }
    const plan = presentation.plan;
    rows.push(createRow('Plan', plan === null ? NONE_TEXT : `${plan.passes.length} passes${VALUE_SEPARATOR}${plan.textures.length} textures${VALUE_SEPARATOR}${plan.sourceKind} source`));
    rows.push(createRow('User passes', `${presentation.report.activePasses.length} active${VALUE_SEPARATOR}${presentation.report.inactivePasses.length} left out`));
    rows.push(createRow('Output', joinPresentValues([
        plan === null ? null : `${plan.output.format}${VALUE_SEPARATOR}${plan.output.colorSpace}${VALUE_SEPARATOR}${plan.output.toneMapping} tone mapping`,
        `HDR output ${presentation.hdrOutput ? 'on' : 'off'}`
    ])));
    rows.push(createRow('Render settings', describeRenderSettings(presentation.renderSettings)));
    if (presentation.renderSettings?.mode === 'hdr-to-sdr') {
        rows.push(createRow('Display', describeDisplaySettings(presentation.renderSettings)));
    }
    return { id: 'presentation', rows, title: 'Presentation' };
}

function describePresenterRows(presenter: PresentationTelemetry): InfoRow[] {
    const rows: InfoRow[] = [];
    rows.push(createRow('State', joinPresentValues([
        presenter.state,
        presenter.mode,
        presenter.presentationSource === null ? null : `${presenter.presentationSource} source`
    ])));
    rows.push(createRow('Frames', `${presenter.presentedFrameCount} presented${VALUE_SEPARATOR}${presenter.decodedFrameCount} decoded${VALUE_SEPARATOR}${presenter.nativeFrameCount} native`));
    rows.push(presenter.presentationSkipReason === null ?
        createRow('Not drawn', NONE_TEXT, 'muted') :
        createRow('Not drawn', presenter.presentationSkipReason, 'failure'));
    rows.push(createRow('First frame', presenter.firstFrameLatencyMicroseconds === null ?
        MISSING_VALUE_TEXT :
        `${formatMilliseconds(presenter.firstFrameLatencyMicroseconds)} after start${VALUE_SEPARATOR}at ${formatPreciseMediaTime(presenter.firstPresentedMediaTimeMicroseconds)}`));
    rows.push(createRow('Last frame', describeLastPresentedFrame(presenter)));
    rows.push(presenter.fallbackReason === null ?
        createRow('Fallback', NONE_TEXT, 'muted') :
        createRow('Fallback', formatFailure(presenter.fallbackReason, presenter.fallbackDetail), 'failure'));
    rows.push(createRow('Device recoveries', String(presenter.deviceRecoveryCount), getCountTone(presenter.deviceRecoveryCount, 'warning')));
    rows.push(createRow('HDR10+', joinPresentValues([
        `${presenter.appliedHDR10PlusFrameCount} applied`,
        `${presenter.carriedHDR10PlusFrameCount} carried`,
        `${presenter.staticFallbackHDR10PlusFrameCount} static fallback`,
        presenter.lastHDR10PlusMetadataStatus === null ? null : `last ${presenter.lastHDR10PlusMetadataStatus}`,
        presenter.lastHDR10PlusInputPeakNits === null ? null : `peak ${Math.round(presenter.lastHDR10PlusInputPeakNits)} nits`
    ])));
    rows.push(createRow('Dolby Vision', joinPresentValues([
        `${presenter.dolbyVisionDualLayerFELPresentedFrameCount} FEL`,
        `${presenter.dolbyVisionDualLayerFELBaseFallbackPresentedFrameCount} FEL as base`,
        `${presenter.dolbyVisionDualLayerMELPresentedFrameCount} MEL`
    ])));
    if (presenter.dolbyVisionFELAuthorizationFailure !== null) {
        rows.push(createRow('FEL authorization', presenter.dolbyVisionFELAuthorizationFailure, 'failure'));
    }
    return rows;
}

/** The last presented frame, and how far ahead of its frame callback the browser expected to display it. */
function describeLastPresentedFrame(presenter: PresentationTelemetry): string {
    const callbackTimeMicroseconds = presenter.lastCallbackTimeMicroseconds;
    const expectedDisplayTimeMicroseconds = presenter.lastExpectedDisplayTimeMicroseconds;
    const displayLead = callbackTimeMicroseconds === null || expectedDisplayTimeMicroseconds === null ?
        null :
        `display expected ${formatMilliseconds(requireMicroseconds(expectedDisplayTimeMicroseconds - callbackTimeMicroseconds, 'Display lead'))} after its callback`;
    return joinPresentValues([ formatPreciseMediaTime(presenter.lastPresentedMediaTimeMicroseconds), displayLead ]);
}

function describeRenderSettings(settings: RenderSettings | null): string {
    if (settings === null) {
        return MISSING_VALUE_TEXT;
    }
    switch (settings.mode) {
        case 'identity-sdr':
            return settings.mode;
        case 'hdr-to-sdr': {
            const toneMapping = settings.toneMapping;
            return joinPresentValues([
                settings.mode,
                toneMapping.operator,
                `${toneMapping.inputPeakNits} nits in`,
                `${toneMapping.outputPeakNits} nits out`,
                `paper white ${toneMapping.paperWhiteNits} nits`
            ]);
        }
    }
}

function describeDisplaySettings(settings: HDRToSDRRenderSettings): string {
    return joinPresentValues([
        `exposure ${settings.toneMapping.exposure}`,
        `brightness ${settings.display.brightness}`,
        `contrast ${settings.display.contrast}`,
        `saturation ${settings.display.saturation}`,
        `desaturation ${settings.toneMapping.desaturationStrength}`
    ]);
}

// Authorization

/** Each probed authorization: a summary row under its name, then a row per route key that failed or waits, with no label of its own. */
function describeAuthorizationSection(authorization: AuthorizationTelemetry): InfoSection | null {
    const rows: InfoRow[] = [];
    if (authorization.rawHDR !== null) {
        rows.push(...describeRawHDRAuthorization(authorization.rawHDR));
    }
    if (authorization.externalHDR !== null) {
        rows.push(...describeExternalHDRAuthorization(authorization.externalHDR));
    }
    if (authorization.dolbyVision !== null) {
        rows.push(...describeSingleRouteAuthorization('Dolby Vision', authorization.dolbyVision, null));
    }
    if (authorization.externalDolbyVision !== null) {
        const telemetry = authorization.externalDolbyVision;
        rows.push(...describeSingleRouteAuthorization('External Dolby Vision', telemetry, telemetry.maximumInputChannelError));
    }
    return rows.length === 0 ? null : { id: 'authorization', rows, title: 'Authorization' };
}

function getAuthorizationTone(status: AuthorizationStatus): DiagnosticTone {
    switch (status) {
        case 'authorized':
            return 'success';
        case 'rejected':
            return 'failure';
        case 'pending':
        case 'unavailable':
            return 'muted';
    }
}

function describeRawHDRAuthorization(telemetry: RawHDRAuthorizationTelemetry): InfoRow[] {
    const rows: InfoRow[] = [];
    rows.push(createRow('Raw HDR', joinPresentValues([
        telemetry.status,
        `${telemetry.authorizedRouteKeys.length} authorized`,
        `${telemetry.pendingRouteKeys.length} pending`,
        `${telemetry.rejectedRouteKeys.length} rejected`,
        telemetry.targetFormat
    ]), getAuthorizationTone(telemetry.status)));
    for (const routeKey of telemetry.rejectedRouteKeys) {
        rows.push(createRow(CONTINUATION_LABEL, `rejected ${routeKey}: ${formatFailure(telemetry.failureReasons[routeKey], telemetry.failureDetails[routeKey])}`, 'failure'));
    }
    if (telemetry.pendingRouteKeys.length > 0) {
        rows.push(createRow(CONTINUATION_LABEL, `pending ${telemetry.pendingRouteKeys.join(VALUE_SEPARATOR)}`, 'muted'));
    }
    return rows;
}

function describeExternalHDRAuthorization(telemetry: ExternalHDRAuthorizationTelemetry): InfoRow[] {
    const rows: InfoRow[] = [];
    rows.push(createRow('External HDR', joinPresentValues([ telemetry.status, telemetry.targetFormat ]), getAuthorizationTone(telemetry.status)));
    for (const routeKey of telemetry.authorizedRouteKeys) {
        const sampleCount = telemetry.sampleCounts[routeKey];
        const maximumChannelError = telemetry.maximumChannelErrors[routeKey];
        rows.push(createRow(CONTINUATION_LABEL, joinPresentValues([
            `authorized ${routeKey}`,
            sampleCount === undefined ? null : `${sampleCount} samples`,
            maximumChannelError === undefined ? null : `max error ${formatNormalizedError(maximumChannelError)}`
        ]), 'success'));
    }
    for (const routeKey of telemetry.rejectedRouteKeys) {
        rows.push(createRow(CONTINUATION_LABEL, `rejected ${routeKey}: ${formatFailure(telemetry.failureReasons[routeKey], telemetry.failureDetails[routeKey])}`, 'failure'));
    }
    if (telemetry.pendingRouteKeys.length > 0) {
        rows.push(createRow(CONTINUATION_LABEL, `pending ${telemetry.pendingRouteKeys.join(VALUE_SEPARATOR)}`, 'muted'));
    }
    return rows;
}

/** A Dolby Vision authorization, which checks one route key: its result, and its failure as `reason: detail`. */
function describeSingleRouteAuthorization(
    label: string,
    telemetry: DolbyVisionAuthorizationTelemetry | ExternalDolbyVisionAuthorizationTelemetry,
    maximumInputChannelError: number | null
): InfoRow[] {
    const rows: InfoRow[] = [];
    rows.push(createRow(label, joinPresentValues([
        telemetry.status,
        telemetry.routeKey,
        telemetry.targetFormat,
        telemetry.sampleCount > 0 ? `${telemetry.sampleCount} samples` : null,
        telemetry.maximumChannelError === null ? null : `max error ${formatNormalizedError(telemetry.maximumChannelError)}`,
        maximumInputChannelError === null ? null : `max input error ${formatNormalizedError(maximumInputChannelError)}`
    ]), getAuthorizationTone(telemetry.status)));
    if (telemetry.failureReason !== null) {
        rows.push(createRow(CONTINUATION_LABEL, formatFailure(telemetry.failureReason, telemetry.failureDetail), 'failure'));
    }
    return rows;
}

// Failures

/** The failure log, newest first, as `layer code: detail` beside the page time it happened at. */
function describeFailuresSection(failures: readonly SandboxFailure[]): InfoSection | null {
    if (failures.length === 0) {
        return null;
    }
    const rows: InfoRow[] = [];
    for (let index = failures.length - 1; index >= 0; index -= 1) {
        const failure = failures[index];
        rows.push(createRow(formatPageTime(failure.timeMilliseconds), `${failure.layer} ${failure.code}: ${failure.detail}`, 'failure'));
    }
    return { id: 'failures', rows, title: `Failures (${failures.length})` };
}
