/* eslint-disable @typescript-eslint/naming-convention -- ffprobe's JSON keys are snake_case */
import { describe, expect, it } from 'vitest';

import { FFPROBE_SIDE_DATA_TYPES, parseFFprobeFrames, parseFFprobeOutput } from '../../../sandbox/src/session/FFprobeOutput';
import { createPlaybackMediaSource, type PlaybackMediaStream } from '../../../sandbox/src/session/PlaybackMediaSource';
import {
    AUDIO_CHANNEL_COUNT,
    AUDIO_CHANNEL_LAYOUT,
    AUDIO_PROFILE,
    AUDIO_RAW_SAMPLE_DEPTH,
    AUDIO_SAMPLE_RATE,
    AUDIO_STREAM_INDEX,
    COVER_PICTURE_STREAM_INDEX,
    createAudioStreamJSON,
    createFramesJSON,
    createProbeJSON,
    createSubtitleStreamJSON,
    createVideoStreamJSON,
    DOLBY_VISION_LEVEL,
    DOLBY_VISION_PROFILE,
    FRAME_RATE,
    HDR10_COMPATIBILITY_ID,
    VIDEO_HEIGHT,
    VIDEO_LEVEL,
    VIDEO_PROFILE,
    VIDEO_STREAM_INDEX,
    VIDEO_WIDTH,
    type FFprobeJSON
} from './ffprobeTestOutput';

const SOURCE_ID = 'movies/feature.mkv';
// A Dolby Vision base layer with an SDR-compatible transfer
const SDR_COMPATIBILITY_ID = 2;
const ROTATION_DEGREES = -90;
const PCM_SAMPLE_DEPTH = 16;
// ffprobe's field order for top field first, and for a bottom field coded first and shown second
const TOP_FIELD_FIRST = 'tt';
const BOTTOM_CODED_TOP_SHOWN_FIRST = 'bt';

/** The eligibility's stream for one ffprobe stream, with the first frame carrying the given side data. */
function createStream(streamJSON: FFprobeJSON, frameSideDataTypes: readonly string[] = []): PlaybackMediaStream {
    const source = createPlaybackMediaSource(
        parseFFprobeOutput(createProbeJSON([ streamJSON ])),
        parseFFprobeFrames(createFramesJSON(frameSideDataTypes)),
        SOURCE_ID,
        true
    );
    return source.MediaStreams[0];
}

/** A plain HDR10 or HLG stream: the Dolby Vision stream without its configuration record. */
function createVideoWithoutDolbyVision(overrides: FFprobeJSON = {}): FFprobeJSON {
    return createVideoStreamJSON({ side_data_list: [], ...overrides });
}

describe('PlaybackMediaSource', () => {
    it('carries a video stream\'s codec, geometry, depth, scan, rates, color, and Dolby Vision configuration', () => {
        expect(createStream(createVideoStreamJSON())).toMatchObject({
            AverageFrameRate: FRAME_RATE,
            BitDepth: 10,
            BlPresentFlag: 1,
            Codec: 'hevc',
            ColorPrimaries: 'bt2020',
            ColorRange: 'tv',
            ColorSpace: 'bt2020nc',
            ColorTransfer: 'smpte2084',
            DvBlSignalCompatibilityId: HDR10_COMPATIBILITY_ID,
            DvLevel: DOLBY_VISION_LEVEL,
            DvProfile: DOLBY_VISION_PROFILE,
            ElPresentFlag: 0,
            Height: VIDEO_HEIGHT,
            Index: VIDEO_STREAM_INDEX,
            IsInterlaced: false,
            Level: VIDEO_LEVEL,
            Profile: VIDEO_PROFILE,
            RealFrameRate: FRAME_RATE,
            RpuPresentFlag: 1,
            Type: 'Video',
            VideoRange: 'HDR',
            VideoRangeType: 'DOVI',
            Width: VIDEO_WIDTH
        });
    });

    it('declares the dynamic range from the Dolby Vision configuration, else from the transfer and the first frame', () => {
        const sdrBaseDolbyVision = createVideoStreamJSON({
            side_data_list: [ { dv_bl_signal_compatibility_id: SDR_COMPATIBILITY_ID, dv_profile: DOLBY_VISION_PROFILE, side_data_type: 'DOVI configuration record' } ]
        });

        expect(createStream(sdrBaseDolbyVision)).toMatchObject({ VideoRange: 'SDR', VideoRangeType: 'DOVI' });
        expect(createStream(createVideoWithoutDolbyVision())).toMatchObject({
            Hdr10PlusPresentFlag: false,
            VideoRange: 'HDR',
            VideoRangeType: 'HDR10'
        });
        expect(createStream(createVideoWithoutDolbyVision(), [ FFPROBE_SIDE_DATA_TYPES.hdr10Plus ])).toMatchObject({
            Hdr10PlusPresentFlag: true,
            VideoRangeType: 'HDR10PLUS'
        });
        expect(createStream(createVideoWithoutDolbyVision({ color_transfer: 'arib-std-b67' }))).toMatchObject({ VideoRange: 'HDR', VideoRangeType: 'HLG' });
        // An untagged stream is SDR, not unknown
        expect(createStream(createVideoWithoutDolbyVision({ color_transfer: undefined }))).toMatchObject({ VideoRange: 'SDR', VideoRangeType: 'SDR' });
    });

    it('reads interlacing from a coded field order, and treats a missing one as progressive', () => {
        expect(createStream(createVideoStreamJSON({ field_order: TOP_FIELD_FIRST })).IsInterlaced).toBe(true);
        expect(createStream(createVideoStreamJSON({ field_order: undefined })).IsInterlaced).toBe(false);
    });

    it('carries ffprobe\'s field order, which names the first field presentation deinterlaces from', () => {
        expect(createStream(createVideoStreamJSON({ field_order: BOTTOM_CODED_TOP_SHOWN_FIRST })).FieldOrder).toBe(BOTTOM_CODED_TOP_SHOWN_FIRST);
        expect(createStream(createVideoStreamJSON({ field_order: undefined })).FieldOrder).toBeNull();
        expect(createStream(createAudioStreamJSON()).FieldOrder).toBeNull();
    });

    it('reads the depth from the pixel format when ffprobe reports no raw sample depth', () => {
        const withoutRawDepth = { bits_per_raw_sample: undefined };

        expect(createStream(createVideoStreamJSON({ ...withoutRawDepth, pix_fmt: 'yuv422p12le' })).BitDepth).toBe(12);
        expect(createStream(createVideoStreamJSON({ ...withoutRawDepth, pix_fmt: 'yuv420p' })).BitDepth).toBe(8);
        expect(createStream(createVideoStreamJSON({ ...withoutRawDepth, pix_fmt: 'nv12' })).BitDepth).toBe(8);
        // Packed RGB names its pixel size, which no component depth is
        expect(createStream(createVideoStreamJSON({ ...withoutRawDepth, pix_fmt: 'rgb48le' })).BitDepth).toBeNull();
    });

    it('reads the rotation from the display matrix', () => {
        const rotated = createVideoWithoutDolbyVision({ side_data_list: [ { rotation: ROTATION_DEGREES, side_data_type: 'Display Matrix' } ] });

        expect(createStream(rotated).Rotation).toBe(ROTATION_DEGREES);
    });

    it('carries an audio stream\'s codec, profile, channels, layout, rate, and depth', () => {
        expect(createStream(createAudioStreamJSON())).toMatchObject({
            BitDepth: AUDIO_RAW_SAMPLE_DEPTH,
            ChannelLayout: AUDIO_CHANNEL_LAYOUT,
            Channels: AUDIO_CHANNEL_COUNT,
            Codec: 'dts',
            Index: AUDIO_STREAM_INDEX,
            Profile: AUDIO_PROFILE,
            SampleRate: AUDIO_SAMPLE_RATE,
            Type: 'Audio'
        });
        // PCM reports its sample depth rather than a raw one
        expect(createStream(createAudioStreamJSON({ bits_per_raw_sample: undefined, bits_per_sample: PCM_SAMPLE_DEPTH })).BitDepth).toBe(PCM_SAMPLE_DEPTH);
    });

    it('lists the container video and audio streams only, and no audio when playing without it', () => {
        const output = parseFFprobeOutput(createProbeJSON([
            createVideoStreamJSON(),
            createAudioStreamJSON(),
            createSubtitleStreamJSON(),
            createVideoStreamJSON({ codec_name: 'mjpeg', disposition: { attached_pic: 1 }, index: COVER_PICTURE_STREAM_INDEX })
        ]));
        const withAudio = createPlaybackMediaSource(output, [], SOURCE_ID, true);
        const withoutAudio = createPlaybackMediaSource(output, [], SOURCE_ID, false);

        expect(withAudio.MediaStreams.map((stream: PlaybackMediaStream): number => stream.Index)).toEqual([ VIDEO_STREAM_INDEX, AUDIO_STREAM_INDEX ]);
        expect(withoutAudio.MediaStreams.map((stream: PlaybackMediaStream): string => stream.Type)).toEqual([ 'Video' ]);
        expect(withAudio.Id).toBe(SOURCE_ID);
    });

    it('names containers as the engine\'s container rules do', () => {
        const createSource = (formatName: string): string | null => createPlaybackMediaSource(
            parseFFprobeOutput(createProbeJSON([], { format_name: formatName })),
            [],
            SOURCE_ID,
            true
        ).Container;

        expect(createSource('matroska,webm')).toBe('matroska,webm');
        expect(createSource('mov,mp4,m4a,3gp,3g2,mj2')).toBe('mov,mp4,m4a,3gp,3g2,mj2');
        expect(createSource('mpegts')).toBe('ts');
    });
});
/* eslint-enable @typescript-eslint/naming-convention */
