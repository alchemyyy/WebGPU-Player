/* eslint-disable @typescript-eslint/naming-convention -- ffprobe's JSON keys are snake_case */
// ffprobe JSON for the probe tests, shaped as ffprobe prints it: snake_case keys, and some numbers as strings.

export const VIDEO_STREAM_INDEX = 0;
export const AUDIO_STREAM_INDEX = 1;
export const SUBTITLE_STREAM_INDEX = 2;
export const IMAGE_SUBTITLE_STREAM_INDEX = 3;
export const COVER_PICTURE_STREAM_INDEX = 4;

export const VIDEO_WIDTH = 3840;
export const VIDEO_HEIGHT = 2160;
export const CODED_VIDEO_HEIGHT = 2176;
export const VIDEO_LEVEL = 153;
export const VIDEO_PROFILE = 'Main 10';
export const VIDEO_LANGUAGE = 'eng';
export const AUDIO_PROFILE = 'DTS-HD MA';
export const AUDIO_CHANNEL_COUNT = 8;
export const AUDIO_CHANNEL_LAYOUT = '7.1';
export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_RAW_SAMPLE_DEPTH = 24;
export const AUDIO_NAME = 'Surround 7.1';
export const SUBTITLE_LANGUAGE = 'fra';
export const DOLBY_VISION_PROFILE = 8;
export const DOLBY_VISION_LEVEL = 6;
export const HDR10_COMPATIBILITY_ID = 1;
// 1 h 23 min 45.678901 s, as ffprobe prints a duration
export const DURATION_TEXT = '5025.678901';
export const DURATION_MICROSECONDS = 5_025_678_901;
export const FRAME_RATE_TEXT = '24000/1001';
export const FRAME_RATE = 24_000 / 1_001;

export type FFprobeJSON = Record<string, unknown>;

/** A Dolby Vision Profile 8.1 HEVC stream with an HDR10 base, as ffprobe prints it. */
export function createVideoStreamJSON(overrides: FFprobeJSON = {}): FFprobeJSON {
    return {
        avg_frame_rate: FRAME_RATE_TEXT,
        bits_per_raw_sample: '10',
        codec_name: 'hevc',
        codec_tag_string: '[0][0][0][0]',
        codec_type: 'video',
        coded_height: CODED_VIDEO_HEIGHT,
        coded_width: VIDEO_WIDTH,
        color_primaries: 'bt2020',
        color_range: 'tv',
        color_space: 'bt2020nc',
        color_transfer: 'smpte2084',
        disposition: { attached_pic: 0, default: 1, forced: 0 },
        field_order: 'progressive',
        height: VIDEO_HEIGHT,
        index: VIDEO_STREAM_INDEX,
        level: VIDEO_LEVEL,
        pix_fmt: 'yuv420p10le',
        profile: VIDEO_PROFILE,
        r_frame_rate: FRAME_RATE_TEXT,
        side_data_list: [
            {
                bl_present_flag: 1,
                dv_bl_signal_compatibility_id: HDR10_COMPATIBILITY_ID,
                dv_level: DOLBY_VISION_LEVEL,
                dv_profile: DOLBY_VISION_PROFILE,
                dv_version_major: 1,
                dv_version_minor: 0,
                el_present_flag: 0,
                rpu_present_flag: 1,
                side_data_type: 'DOVI configuration record'
            }
        ],
        tags: { language: VIDEO_LANGUAGE },
        width: VIDEO_WIDTH,
        ...overrides
    };
}

/** A DTS-HD MA 7.1 stream, as ffprobe prints it. */
export function createAudioStreamJSON(overrides: FFprobeJSON = {}): FFprobeJSON {
    return {
        bits_per_raw_sample: String(AUDIO_RAW_SAMPLE_DEPTH),
        bits_per_sample: 0,
        channel_layout: AUDIO_CHANNEL_LAYOUT,
        channels: AUDIO_CHANNEL_COUNT,
        codec_name: 'dts',
        codec_type: 'audio',
        disposition: { default: 1, forced: 0 },
        index: AUDIO_STREAM_INDEX,
        profile: AUDIO_PROFILE,
        sample_rate: String(AUDIO_SAMPLE_RATE),
        tags: { language: VIDEO_LANGUAGE, title: AUDIO_NAME },
        ...overrides
    };
}

/** A text subtitle stream, as ffprobe prints it. */
export function createSubtitleStreamJSON(overrides: FFprobeJSON = {}): FFprobeJSON {
    return {
        codec_name: 'subrip',
        codec_type: 'subtitle',
        disposition: { default: 0, forced: 1 },
        index: SUBTITLE_STREAM_INDEX,
        tags: { language: SUBTITLE_LANGUAGE },
        ...overrides
    };
}

/** A Matroska file with the given streams, as `ffprobe -show_format -show_streams -of json` prints it. */
export function createProbeJSON(streams: readonly FFprobeJSON[], formatOverrides: FFprobeJSON = {}): string {
    return JSON.stringify({
        format: { duration: DURATION_TEXT, format_name: 'matroska,webm', ...formatOverrides },
        streams
    });
}

/** The first video frame, as `ffprobe -show_frames -of json` prints it, with the given side data types. */
export function createFramesJSON(sideDataTypes: readonly string[], streamIndex: number = VIDEO_STREAM_INDEX): string {
    return JSON.stringify({
        frames: [
            {
                media_type: 'video',
                side_data_list: sideDataTypes.map((sideDataType: string): FFprobeJSON => ({ side_data_type: sideDataType })),
                stream_index: streamIndex
            }
        ]
    });
}
/* eslint-enable @typescript-eslint/naming-convention */
