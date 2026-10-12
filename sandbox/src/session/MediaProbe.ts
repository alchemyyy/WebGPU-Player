// Probes a local file with ffprobe, for the media description the panels show and the media source the session hands the engine.
import {
    describeError,
    type AudioTrackDescription,
    type ColorDescription,
    type DolbyVisionDescription,
    type DynamicRange,
    type MediaDescription,
    type SubtitleTrackDescription,
    type VideoTrackDescription
} from '../contracts/SandboxContracts';
import type { FFmpegTool } from './FFmpegTool';
import {
    findFFprobeSideData,
    FFPROBE_CODEC_TYPES,
    FFPROBE_DISPOSITIONS,
    FFPROBE_SIDE_DATA_TYPES,
    FFPROBE_TAGS,
    FFPROBE_TRANSFERS,
    hasFFprobeDisposition,
    isContainerVideoStream,
    parseFFprobeFrames,
    parseFFprobeOutput,
    parseFFprobePositiveInteger,
    parseFFprobeRate,
    parseFFprobeSeconds,
    type FFprobeFrame,
    type FFprobeOutput,
    type FFprobeStream
} from './FFprobeOutput';
import { getVideoBitDepth, hasHDR10PlusFrame } from './PlaybackMediaSource';

/** What one probe found: ffprobe's output, the first video frame's side data, and what the panels show. */
export type ProbedMedia = Readonly<{
    description: MediaDescription
    frames: readonly FFprobeFrame[]
    output: FFprobeOutput
    /** What a probe step could not read, as `code: detail`, which the session records as failures */
    warnings: readonly string[]
}>;

const STREAM_PROBE_OPTIONS = [ '-show_format', '-show_streams' ];
// Decodes only the first frame of the first video stream, whose side data carries HDR10+ metadata when the stream has it
const FIRST_FRAME_PROBE_OPTIONS = [ '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_frames' ];
const FIRST_FRAME_UNREADABLE = 'first-frame-unreadable';
// Image subtitle codecs, which ffmpeg cannot convert to text
const IMAGE_SUBTITLE_CODECS: readonly string[] = [ 'dvb_subtitle', 'dvb_teletext', 'dvd_subtitle', 'hdmv_pgs_subtitle', 'xsub' ];
const COLOR_RANGES: ReadonlyMap<string, ColorDescription['range']> = new Map<string, ColorDescription['range']>([
    [ 'pc', 'full' ],
    [ 'tv', 'limited' ]
]);
const ENHANCEMENT_LAYER_PRESENT = 1;
const UNKNOWN_CODEC = 'unknown';

function getTrackName(stream: FFprobeStream): string | null {
    return stream.tags[FFPROBE_TAGS.title] ?? null;
}

function getLanguage(stream: FFprobeStream): string | null {
    return stream.tags[FFPROBE_TAGS.language] ?? null;
}

function describeColor(stream: FFprobeStream): ColorDescription | null {
    const range = stream.colorRange === null ? null : COLOR_RANGES.get(stream.colorRange) ?? null;
    if (stream.colorSpace === null && stream.colorPrimaries === null && stream.colorTransfer === null && range === null) {
        return null;
    }
    return { matrix: stream.colorSpace, primaries: stream.colorPrimaries, range, transfer: stream.colorTransfer };
}

function describeDolbyVision(stream: FFprobeStream): DolbyVisionDescription | null {
    const record = findFFprobeSideData(stream, FFPROBE_SIDE_DATA_TYPES.dolbyVision);
    if (record === null || record.dvProfile === null || record.dvLevel === null || record.dvBlSignalCompatibilityId === null) {
        return null;
    }
    return {
        blCompatibilityId: record.dvBlSignalCompatibilityId,
        hasEnhancementLayer: record.elPresentFlag === ENHANCEMENT_LAYER_PRESENT,
        level: record.dvLevel,
        profile: record.dvProfile
    };
}

function describeDynamicRange(stream: FFprobeStream, dolbyVision: DolbyVisionDescription | null, frames: readonly FFprobeFrame[]): DynamicRange {
    if (dolbyVision !== null) {
        return 'dolby-vision';
    }
    switch (stream.colorTransfer) {
        case FFPROBE_TRANSFERS.pq:
            return hasHDR10PlusFrame(stream.index, frames) ? 'hdr10-plus' : 'hdr10';
        case FFPROBE_TRANSFERS.hlg:
            return 'hlg';
        default:
            return 'sdr';
    }
}

function describeVideoTrack(stream: FFprobeStream, frames: readonly FFprobeFrame[]): VideoTrackDescription {
    const dolbyVision = describeDolbyVision(stream);
    const width = stream.width ?? 0;
    const height = stream.height ?? 0;
    return {
        bitDepth: getVideoBitDepth(stream),
        codec: stream.codecName ?? UNKNOWN_CODEC,
        codedHeight: stream.codedHeight ?? height,
        codedWidth: stream.codedWidth ?? width,
        color: describeColor(stream),
        displayHeight: height,
        displayWidth: width,
        dolbyVision,
        dynamicRange: describeDynamicRange(stream, dolbyVision, frames),
        frameRate: parseFFprobeRate(stream.averageFrameRate),
        index: stream.index,
        language: getLanguage(stream),
        level: stream.level,
        name: getTrackName(stream),
        profile: stream.profile
    };
}

function describeAudioTrack(stream: FFprobeStream): AudioTrackDescription {
    return {
        channelCount: stream.channels ?? 0,
        codec: stream.codecName ?? UNKNOWN_CODEC,
        default: hasFFprobeDisposition(stream, FFPROBE_DISPOSITIONS.default),
        index: stream.index,
        language: getLanguage(stream),
        name: getTrackName(stream),
        profile: stream.profile,
        sampleRate: parseFFprobePositiveInteger(stream.sampleRate) ?? 0
    };
}

function describeSubtitleTrack(stream: FFprobeStream): SubtitleTrackDescription {
    const codec = stream.codecName ?? UNKNOWN_CODEC;
    return {
        codec,
        default: hasFFprobeDisposition(stream, FFPROBE_DISPOSITIONS.default),
        forced: hasFFprobeDisposition(stream, FFPROBE_DISPOSITIONS.forced),
        index: stream.index,
        language: getLanguage(stream),
        name: getTrackName(stream),
        textBased: !IMAGE_SUBTITLE_CODECS.includes(codec)
    };
}

/** Describes ffprobe's output for the panels: the container, the duration, and every video, audio, and subtitle track. */
export function describeProbedMedia(output: FFprobeOutput, frames: readonly FFprobeFrame[], file: File, path: string): MediaDescription {
    const videoTracks: VideoTrackDescription[] = [];
    const audioTracks: AudioTrackDescription[] = [];
    const subtitleTracks: SubtitleTrackDescription[] = [];
    for (const stream of output.streams) {
        if (isContainerVideoStream(stream)) {
            videoTracks.push(describeVideoTrack(stream, frames));
            continue;
        }
        switch (stream.codecType) {
            case FFPROBE_CODEC_TYPES.audio:
                audioTracks.push(describeAudioTrack(stream));
                break;
            case FFPROBE_CODEC_TYPES.subtitle:
                subtitleTracks.push(describeSubtitleTrack(stream));
                break;
            default:
                break;
        }
    }
    return {
        audioTracks,
        container: output.format.formatName ?? UNKNOWN_CODEC,
        durationMicroseconds: parseFFprobeSeconds(output.format.duration),
        path,
        sizeBytes: file.size,
        subtitleTracks,
        videoTracks
    };
}

/**
 * Probes a file: its format and streams, then the first video frame, whose side data tells HDR10+ apart.
 * A stream probe that fails rejects; a first frame that cannot be read leaves HDR10+ undetected and is reported as a warning.
 */
export async function probeMedia(tool: FFmpegTool, file: File, path: string): Promise<ProbedMedia> {
    const output = parseFFprobeOutput(await tool.probe(file, STREAM_PROBE_OPTIONS));
    const warnings: string[] = [];
    let frames: FFprobeFrame[] = [];
    if (output.streams.some(isContainerVideoStream)) {
        try {
            frames = parseFFprobeFrames(await tool.probe(file, FIRST_FRAME_PROBE_OPTIONS));
        } catch (error) {
            warnings.push(`${FIRST_FRAME_UNREADABLE}: ${describeError(error)}`);
        }
    }
    return { description: describeProbedMedia(output, frames, file, path), frames, output, warnings };
}
