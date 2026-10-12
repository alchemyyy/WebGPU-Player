// The contracts between the sandbox's layers: the state the session and library publish, and the commands the panels send.
// Panels read state and send commands only; they never call the engine themselves.
import type { Microseconds } from 'webgpu-player/MediaTime';
import type { CustomPlaybackTelemetry } from 'webgpu-player/pipeline/CustomPlaybackControllerTypes';
import type {
    CustomDecodeAudioOutputMode,
    CustomDecodeDolbyVisionProfile,
    CustomDecodeNativeHDRTransfer,
    CustomDecodeRawVideoFrameFormat,
    CustomDecodeVideoDecoderBackend,
    CustomDecodeVideoOutputMode
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import type { PassManifest, PlanReport, PresentationPlan } from 'webgpu-player/presentation/passes/PassTypes';
import type { HDRToSDRRenderSettings, RenderSettings } from 'webgpu-player/presentation/RenderSettings';
import type { PresentationTelemetry } from 'webgpu-player/presentation/WebGPUPresenter';
import type { DolbyVisionAuthorizationTelemetry } from 'webgpu-player/validation/DolbyVisionPresentationAuthorization';
import type { ExternalDolbyVisionAuthorizationTelemetry } from 'webgpu-player/validation/ExternalDolbyVisionPresentationAuthorization';
import type { ExternalHDRAuthorizationTelemetry } from 'webgpu-player/validation/ExternalHDRPresentationAuthorization';
import type { RawHDRAuthorizationTelemetry } from 'webgpu-player/validation/RawHDRPresentationAuthorization';

// Library

export type LibraryFile = Readonly<{
    kind: 'file'
    name: string
    /** The file's path below the picked folder, with '/' separators, which identifies it */
    path: string
    sizeBytes: number
    /** Subtitle files beside it whose names start with its base name, such as movie.en.srt for movie.mkv */
    subtitlePaths: readonly string[]
}>;

export type LibraryDirectory = Readonly<{
    children: readonly LibraryEntry[]
    kind: 'directory'
    name: string
    path: string
}>;

export type LibraryEntry = LibraryDirectory | LibraryFile;

/**
 * - 'empty': no folder picked yet.
 * - 'permission-needed': a remembered folder needs a user gesture to grant read access again.
 * - 'scanning': the folder is being read.
 * - 'ready': root holds the folder's playable files.
 */
export type LibraryStatus = 'empty' | 'permission-needed' | 'ready' | 'scanning';

export type LibraryState = Readonly<{
    root: LibraryDirectory | null
    /** The path of the file the session opened last */
    selectedPath: string | null
    status: LibraryStatus
}>;

/** A library file resolved for playback: its contents and its subtitle files. */
export type SandboxMediaFile = Readonly<{
    file: File
    path: string
    subtitleFiles: readonly Readonly<{ file: File; path: string }>[]
}>;

// Media

export type ColorDescription = Readonly<{
    matrix: string | null
    primaries: string | null
    range: 'full' | 'limited' | null
    transfer: string | null
}>;

export type DolbyVisionDescription = Readonly<{
    blCompatibilityId: number
    hasEnhancementLayer: boolean
    level: number
    profile: number
}>;

/** How the stream presents: its transfer and dynamic metadata, as far as the probe can tell. */
export type DynamicRange = 'dolby-vision' | 'hdr10' | 'hdr10-plus' | 'hlg' | 'sdr' | 'unknown';

export type VideoTrackDescription = Readonly<{
    bitDepth: number | null
    codec: string
    /** The codec parameter string, such as hvc1.2.4.L153.B0 */
    codecString: string | null
    codedHeight: number
    codedWidth: number
    color: ColorDescription | null
    displayHeight: number
    displayWidth: number
    dolbyVision: DolbyVisionDescription | null
    dynamicRange: DynamicRange
    frameRate: number | null
    index: number
    language: string | null
    name: string | null
}>;

export type AudioTrackDescription = Readonly<{
    channelCount: number
    codec: string
    codecString: string | null
    default: boolean
    index: number
    language: string | null
    name: string | null
    sampleRate: number
}>;

export type SubtitleTrackDescription = Readonly<{
    codec: string
    default: boolean
    /** Shown even without a subtitle selection, such as signs and foreign dialogue */
    forced: boolean
    index: number
    language: string | null
    name: string | null
    /** Whether the sandbox can show it: plain-text cues from SRT, WebVTT, and ASS dialogue */
    textBased: boolean
}>;

export type MediaDescription = Readonly<{
    audioTracks: readonly AudioTrackDescription[]
    container: string
    durationMicroseconds: Microseconds | null
    /** The library path, SandboxMediaFile.path, by which the track selector finds the subtitle files beside the media */
    path: string
    sizeBytes: number
    subtitleTracks: readonly SubtitleTrackDescription[]
    videoTracks: readonly VideoTrackDescription[]
}>;

// Route

/** The video decoder a route uses: the engine's choice, the browser's WebCodecs decoder, or the engine's bundled software decoder for the codec. */
export type DecoderOverride = 'auto' | 'native' | 'software';

/** How decoded frames reach the GPU: the engine's choice, raw planes uploaded as textures, or a VideoFrame imported as an external texture. */
export type FrameTransportOverride = 'auto' | 'raw-planes' | 'video-frame';

export type RouteOverride = Readonly<{
    decoder: DecoderOverride
    transport: FrameTransportOverride
}>;

/** The route the session plays: the engine's play options, and why they were chosen. */
export type ActiveRoute = Readonly<{
    audioOutputMode: CustomDecodeAudioOutputMode | null
    dolbyVisionProfile: CustomDecodeDolbyVisionProfile
    nativeHDRTransfer: CustomDecodeNativeHDRTransfer
    neutralizeHDRColorMetadata: boolean
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    /** The engine's reason for its choice, or the override that forced it, as a terse detail */
    selection: string
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
    videoOutputMode: CustomDecodeVideoOutputMode
}>;

// Playback

export type PlaybackStatus = 'ended' | 'failed' | 'idle' | 'loading' | 'paused' | 'playing' | 'seeking';

export type PlaybackState = Readonly<{
    durationMicroseconds: Microseconds | null
    muted: boolean
    status: PlaybackStatus
    /** From 0 to 1 */
    volume: number
}>;

/** A subtitle track's source: a track in the media file, or a subtitle file beside it. */
export type SubtitleSelection =
    | Readonly<{ kind: 'embedded'; trackIndex: number }>
    | Readonly<{ kind: 'file'; path: string }>;

export type TrackState = Readonly<{
    audioTrackIndex: number | null
    subtitle: SubtitleSelection | null
    videoTrackIndex: number | null
}>;

export type SubtitleCue = Readonly<{
    endMicroseconds: Microseconds
    startMicroseconds: Microseconds
    /** Plain text, lines separated by newlines, with styling removed */
    text: string
}>;

// Presentation

export type SandboxShaderPass = Readonly<{
    /** The header error, as `line N: message`, or null when the header parses */
    headerFailure: string | null
    /** Stable for the pass's lifetime in the preset */
    id: string
    manifest: PassManifest | null
    /** The file it was dropped from, or the example it came from */
    origin: string
    parameters: Readonly<Record<string, number>>
    source: string
}>;

export type AuthorizationTelemetry = Readonly<{
    dolbyVision: DolbyVisionAuthorizationTelemetry | null
    externalDolbyVision: ExternalDolbyVisionAuthorizationTelemetry | null
    externalHDR: ExternalHDRAuthorizationTelemetry | null
    rawHDR: RawHDRAuthorizationTelemetry | null
}>;

export type PresentationState = Readonly<{
    hdrOutput: boolean
    passes: readonly SandboxShaderPass[]
    /** The installed plan, which the pipeline graph draws; null before the first frame */
    plan: PresentationPlan | null
    renderSettings: RenderSettings | null
    report: PlanReport
}>;

/** The engine's own telemetry objects, refreshed a few times a second while media is open. */
export type TelemetryState = Readonly<{
    authorization: AuthorizationTelemetry
    controller: CustomPlaybackTelemetry | null
    presenter: PresentationTelemetry | null
}>;

// Failures

/** A failure the sandbox shows: which layer failed, its code, and a terse detail with the failing value. */
export type SandboxFailure = Readonly<{
    code: string
    detail: string
    layer: 'library' | 'presenter' | 'probe' | 'session' | 'shader' | 'subtitle'
    /** performance.now() when it happened */
    timeMilliseconds: number
}>;

// State

export type SandboxState = Readonly<{
    /** Newest last, bounded */
    failures: readonly SandboxFailure[]
    library: LibraryState
    media: MediaDescription | null
    playback: PlaybackState
    presentation: PresentationState
    route: Readonly<{
        active: ActiveRoute | null
        override: RouteOverride
    }>
    subtitleCues: readonly SubtitleCue[]
    telemetry: TelemetryState
    tracks: TrackState
}>;

/** The failures the state keeps; older ones drop first. */
export const MAXIMUM_SANDBOX_FAILURE_COUNT = 50;

/** Returns an error's terse failure detail: a DOMException's name, such as NotFoundError, or else its message. */
export function describeError(error: unknown): string {
    if (error instanceof DOMException) {
        return error.name;
    }
    if (error instanceof Error) {
        return error.message === '' ? error.name : error.message;
    }
    return String(error);
}

/** Returns the failures with one appended, dropping the oldest beyond MAXIMUM_SANDBOX_FAILURE_COUNT. */
export function appendSandboxFailure(failures: readonly SandboxFailure[], failure: SandboxFailure): readonly SandboxFailure[] {
    const appended: SandboxFailure[] = [ ...failures, failure ];
    return appended.slice(Math.max(0, appended.length - MAXIMUM_SANDBOX_FAILURE_COUNT));
}

export function createInitialSandboxState(): SandboxState {
    return {
        failures: [],
        library: { root: null, selectedPath: null, status: 'empty' },
        media: null,
        playback: { durationMicroseconds: null, muted: false, status: 'idle', volume: 1 },
        presentation: {
            hdrOutput: false,
            passes: [],
            plan: null,
            renderSettings: null,
            report: { activePasses: [], inactivePasses: [] }
        },
        route: { active: null, override: { decoder: 'auto', transport: 'auto' } },
        subtitleCues: [],
        telemetry: {
            authorization: { dolbyVision: null, externalDolbyVision: null, externalHDR: null, rawHDR: null },
            controller: null,
            presenter: null
        },
        tracks: { audioTrackIndex: null, subtitle: null, videoTrackIndex: null }
    };
}

// Commands

/** What the panels ask of the library; it publishes LibraryState. */
export type SandboxLibraryCommands = {
    /** Opens the directory picker and scans the chosen folder; a cancelled picker changes nothing */
    pickDirectory: () => Promise<void>
    /** Resolves a file of the tree, with its subtitle files */
    resolveMedia: (path: string) => Promise<SandboxMediaFile>
    /** Restores the remembered folder; with requestPermission, asks for read access, which needs a user gesture */
    restore: (requestPermission: boolean) => Promise<void>
};

/** An example pass the shader panel offers. */
export type ExampleShaderPass = Readonly<{
    id: string
    name: string
    source: string
}>;

/** What the panels ask of the session; it publishes every state but library. */
export type SandboxSessionCommands = {
    addExampleShaderPass: (exampleId: string) => Promise<void>
    addShaderPasses: (files: readonly File[]) => Promise<void>
    /** The examples addExampleShaderPass takes */
    getExampleShaderPasses: () => readonly ExampleShaderPass[]
    /** The playback clock, cheap enough for every animation frame, which subtitles and the timeline read */
    getCurrentTimeMicroseconds: () => Microseconds
    moveShaderPass: (passId: string, offset: -1 | 1) => Promise<void>
    /** Probes and plays a file from the start, replacing any open media */
    openMedia: (media: SandboxMediaFile) => Promise<void>
    pause: () => void
    play: () => Promise<void>
    removeShaderPass: (passId: string) => Promise<void>
    seek: (timeMicroseconds: Microseconds) => void
    /** Restarts the media on the track, at the current time */
    selectAudioTrack: (trackIndex: number | null) => Promise<void>
    selectSubtitle: (selection: SubtitleSelection | null) => Promise<void>
    setHDROutputEnabled: (enabled: boolean) => Promise<void>
    setMuted: (muted: boolean) => void
    setRenderSettings: (settings: HDRToSDRRenderSettings) => void
    /** Restarts the media on the route the override selects, at the current time */
    setRouteOverride: (override: RouteOverride) => Promise<void>
    setShaderParameter: (passId: string, parameterName: string, value: number) => void
    setVolume: (volume: number) => void
};
