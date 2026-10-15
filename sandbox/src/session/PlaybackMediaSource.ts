// The media source the engine's eligibility reads, built from ffprobe's description of a local file.
// Field names and values follow the input that CustomPlaybackEligibility and PresentationInput read; only the fields they read are set.
import {
    findFFprobeSideData,
    FFPROBE_CODEC_TYPES,
    FFPROBE_SIDE_DATA_TYPES,
    FFPROBE_TRANSFERS,
    isContainerVideoStream,
    parseFFprobePositiveInteger,
    parseFFprobeRate,
    type FFprobeFrame,
    type FFprobeOutput,
    type FFprobeSideData,
    type FFprobeStream
} from './FFprobeOutput';

/** One video or audio stream of the eligibility's input. */
export type PlaybackMediaStream = Readonly<{
    AverageFrameRate: number | null
    BitDepth: number | null
    BlPresentFlag: number | null
    ChannelLayout: string | null
    Channels: number | null
    Codec: string | null
    ColorPrimaries: string | null
    ColorRange: string | null
    ColorSpace: string | null
    ColorTransfer: string | null
    DvBlSignalCompatibilityId: number | null
    DvLevel: number | null
    DvProfile: number | null
    DvVersionMajor: number | null
    DvVersionMinor: number | null
    ElPresentFlag: number | null
    /** ffprobe's field order, such as tt or progressive, which names an interlaced stream's first field; null when ffprobe reports none */
    FieldOrder: string | null
    Hdr10PlusPresentFlag: boolean
    Height: number | null
    Index: number
    IsInterlaced: boolean
    Level: number | null
    PixelFormat: string | null
    Profile: string | null
    RealFrameRate: number | null
    Rotation: number | null
    RpuPresentFlag: number | null
    SampleRate: number | null
    Type: string
    VideoRange: string | null
    VideoRangeType: string | null
    Width: number | null
}>;

/** The eligibility's media source: its container and its video and audio streams. */
export type PlaybackMediaSource = Readonly<{
    Container: string | null
    Id: string
    MediaStreams: readonly PlaybackMediaStream[]
}>;

// The stream types the eligibility reads
const VIDEO_STREAM_TYPE = 'Video';
const AUDIO_STREAM_TYPE = 'Audio';
// The dynamic range declarations the eligibility reads: a range, and a type that is a Dolby Vision prefix, a PQ type, HLG, or SDR
const HDR_RANGE = 'HDR';
const SDR_RANGE = 'SDR';
const DOLBY_VISION_RANGE_TYPE = 'DOVI';
const HDR10_RANGE_TYPE = 'HDR10';
const HDR10_PLUS_RANGE_TYPE = 'HDR10PLUS';
const HLG_RANGE_TYPE = 'HLG';
const SDR_RANGE_TYPE = 'SDR';

const PROGRESSIVE_FIELD_ORDER = 'progressive';
// A Dolby Vision base layer with this compatibility ID is SDR
const SDR_BASE_LAYER_COMPATIBILITY_ID = 2;
// ffprobe's demuxer names that the engine's container rules know by another name
const ENGINE_CONTAINER_NAMES: ReadonlyMap<string, string> = new Map<string, string>([ [ 'mpegts', 'ts' ] ]);
const CONTAINER_SEPARATOR = ',';
// A pixel format deeper than 8 bits ends with its component depth and byte order, such as yuv420p10le
const BYTE_ORDER_SUFFIXES: readonly string[] = [ 'le', 'be' ];
const DEFAULT_BIT_DEPTH = 8;
const MAXIMUM_COMPONENT_BIT_DEPTH = 16;
const FIRST_DIGIT = '0';
const LAST_DIGIT = '9';

type DynamicRangeDeclaration = Readonly<{
    range: string
    rangeType: string
}>;

/** Returns the component depth a pixel format names, such as 10 for yuv420p10le, or 8 for one that names none, such as yuv420p. */
function getPixelFormatDepth(pixelFormat: string): number {
    const suffix = BYTE_ORDER_SUFFIXES.find((candidate: string): boolean => pixelFormat.endsWith(candidate));
    if (suffix === undefined) {
        return DEFAULT_BIT_DEPTH;
    }
    const digitsEnd = pixelFormat.length - suffix.length;
    let digitsStart = digitsEnd;
    while (digitsStart > 0 && pixelFormat[digitsStart - 1] >= FIRST_DIGIT && pixelFormat[digitsStart - 1] <= LAST_DIGIT) {
        digitsStart -= 1;
    }
    return digitsStart === digitsEnd ? DEFAULT_BIT_DEPTH : Number(pixelFormat.slice(digitsStart, digitsEnd));
}

/** Returns a video stream's component depth: the raw sample depth ffprobe reports, else the depth its pixel format names. */
export function getVideoBitDepth(stream: FFprobeStream): number | null {
    if (stream.bitsPerRawSample !== null && stream.bitsPerRawSample > 0) {
        return stream.bitsPerRawSample;
    }
    if (stream.pixelFormat === null) {
        return null;
    }
    const depth = getPixelFormatDepth(stream.pixelFormat);
    return depth >= DEFAULT_BIT_DEPTH && depth <= MAXIMUM_COMPONENT_BIT_DEPTH ? depth : null;
}

/** Returns whether a video stream's first frame carries HDR10+ metadata. */
export function hasHDR10PlusFrame(streamIndex: number, frames: readonly FFprobeFrame[]): boolean {
    return frames.some((frame: FFprobeFrame): boolean => (
        frame.streamIndex === streamIndex && frame.sideDataTypes.includes(FFPROBE_SIDE_DATA_TYPES.hdr10Plus)
    ));
}

/** Declares a video stream's dynamic range: Dolby Vision whenever it carries a configuration record, else by its transfer. */
function declareDynamicRange(stream: FFprobeStream, dolbyVision: FFprobeSideData | null, hdr10Plus: boolean): DynamicRangeDeclaration {
    if (dolbyVision !== null) {
        const range = dolbyVision.dvBlSignalCompatibilityId === SDR_BASE_LAYER_COMPATIBILITY_ID ? SDR_RANGE : HDR_RANGE;
        return { range, rangeType: DOLBY_VISION_RANGE_TYPE };
    }
    switch (stream.colorTransfer) {
        case FFPROBE_TRANSFERS.pq:
            return { range: HDR_RANGE, rangeType: hdr10Plus ? HDR10_PLUS_RANGE_TYPE : HDR10_RANGE_TYPE };
        case FFPROBE_TRANSFERS.hlg:
            return { range: HDR_RANGE, rangeType: HLG_RANGE_TYPE };
        default:
            return { range: SDR_RANGE, rangeType: SDR_RANGE_TYPE };
    }
}

function createVideoStream(stream: FFprobeStream, frames: readonly FFprobeFrame[]): PlaybackMediaStream {
    const dolbyVision = findFFprobeSideData(stream, FFPROBE_SIDE_DATA_TYPES.dolbyVision);
    const hdr10Plus = hasHDR10PlusFrame(stream.index, frames);
    const dynamicRange = declareDynamicRange(stream, dolbyVision, hdr10Plus);
    return {
        AverageFrameRate: parseFFprobeRate(stream.averageFrameRate),
        BitDepth: getVideoBitDepth(stream),
        BlPresentFlag: dolbyVision?.blPresentFlag ?? null,
        ChannelLayout: null,
        Channels: null,
        Codec: stream.codecName,
        ColorPrimaries: stream.colorPrimaries,
        ColorRange: stream.colorRange,
        ColorSpace: stream.colorSpace,
        ColorTransfer: stream.colorTransfer,
        DvBlSignalCompatibilityId: dolbyVision?.dvBlSignalCompatibilityId ?? null,
        DvLevel: dolbyVision?.dvLevel ?? null,
        DvProfile: dolbyVision?.dvProfile ?? null,
        DvVersionMajor: dolbyVision?.dvVersionMajor ?? null,
        DvVersionMinor: dolbyVision?.dvVersionMinor ?? null,
        ElPresentFlag: dolbyVision?.elPresentFlag ?? null,
        FieldOrder: stream.fieldOrder,
        Hdr10PlusPresentFlag: hdr10Plus,
        Height: stream.height,
        Index: stream.index,
        // ffprobe reports a field order only for streams that code one; none means progressive
        IsInterlaced: stream.fieldOrder !== null && stream.fieldOrder !== PROGRESSIVE_FIELD_ORDER,
        Level: stream.level,
        PixelFormat: stream.pixelFormat,
        Profile: stream.profile,
        RealFrameRate: parseFFprobeRate(stream.realFrameRate),
        Rotation: findFFprobeSideData(stream, FFPROBE_SIDE_DATA_TYPES.displayMatrix)?.rotation ?? null,
        RpuPresentFlag: dolbyVision?.rpuPresentFlag ?? null,
        SampleRate: null,
        Type: VIDEO_STREAM_TYPE,
        VideoRange: dynamicRange.range,
        VideoRangeType: dynamicRange.rangeType,
        Width: stream.width
    };
}

function createAudioStream(stream: FFprobeStream): PlaybackMediaStream {
    // PCM reports its sample depth, and lossless codecs their raw sample depth
    const bitDepth = [ stream.bitsPerSample, stream.bitsPerRawSample ].find((depth: number | null): boolean => depth !== null && depth > 0) ?? null;
    return {
        AverageFrameRate: null,
        BitDepth: bitDepth,
        BlPresentFlag: null,
        ChannelLayout: stream.channelLayout,
        Channels: stream.channels,
        Codec: stream.codecName,
        ColorPrimaries: null,
        ColorRange: null,
        ColorSpace: null,
        ColorTransfer: null,
        DvBlSignalCompatibilityId: null,
        DvLevel: null,
        DvProfile: null,
        DvVersionMajor: null,
        DvVersionMinor: null,
        ElPresentFlag: null,
        FieldOrder: null,
        Hdr10PlusPresentFlag: false,
        Height: null,
        Index: stream.index,
        IsInterlaced: false,
        Level: null,
        PixelFormat: null,
        Profile: stream.profile,
        RealFrameRate: null,
        Rotation: null,
        RpuPresentFlag: null,
        SampleRate: parseFFprobePositiveInteger(stream.sampleRate),
        Type: AUDIO_STREAM_TYPE,
        VideoRange: null,
        VideoRangeType: null,
        Width: null
    };
}

/** Returns ffprobe's demuxer names as the engine's container rules name them, such as matroska,webm or ts. */
function getEngineContainer(formatName: string | null): string | null {
    if (formatName === null) {
        return null;
    }
    return formatName
        .split(CONTAINER_SEPARATOR)
        .map((name: string): string => ENGINE_CONTAINER_NAMES.get(name) ?? name)
        .join(CONTAINER_SEPARATOR);
}

/**
 * Builds the eligibility's media source from ffprobe's output and the first frames' side data, which tell HDR10+ apart.
 * Without audio, it lists no audio stream, which the eligibility reads as playback without audio.
 */
export function createPlaybackMediaSource(
    output: FFprobeOutput,
    frames: readonly FFprobeFrame[],
    id: string,
    includeAudio: boolean
): PlaybackMediaSource {
    const streams: PlaybackMediaStream[] = [];
    for (const stream of output.streams) {
        if (isContainerVideoStream(stream)) {
            streams.push(createVideoStream(stream, frames));
        } else if (includeAudio && stream.codecType === FFPROBE_CODEC_TYPES.audio) {
            streams.push(createAudioStream(stream));
        }
    }
    return { Container: getEngineContainer(output.format.formatName), Id: id, MediaStreams: streams };
}
