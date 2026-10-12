/* eslint-disable @typescript-eslint/naming-convention -- ffprobe's JSON keys are snake_case */
import { describe, expect, it, vi } from 'vitest';

import type { FFmpegTool } from '../../../sandbox/src/session/FFmpegTool';
import { FFPROBE_SIDE_DATA_TYPES } from '../../../sandbox/src/session/FFprobeOutput';
import { probeMedia } from '../../../sandbox/src/session/MediaProbe';
import {
    AUDIO_CHANNEL_COUNT,
    AUDIO_NAME,
    AUDIO_PROFILE,
    AUDIO_SAMPLE_RATE,
    AUDIO_STREAM_INDEX,
    CODED_VIDEO_HEIGHT,
    COVER_PICTURE_STREAM_INDEX,
    createAudioStreamJSON,
    createFramesJSON,
    createProbeJSON,
    createSubtitleStreamJSON,
    createVideoStreamJSON,
    DOLBY_VISION_LEVEL,
    DOLBY_VISION_PROFILE,
    DURATION_MICROSECONDS,
    FRAME_RATE,
    HDR10_COMPATIBILITY_ID,
    IMAGE_SUBTITLE_STREAM_INDEX,
    SUBTITLE_LANGUAGE,
    SUBTITLE_STREAM_INDEX,
    VIDEO_HEIGHT,
    VIDEO_LANGUAGE,
    VIDEO_LEVEL,
    VIDEO_PROFILE,
    VIDEO_STREAM_INDEX,
    VIDEO_WIDTH
} from './ffprobeTestOutput';

const MEDIA_PATH = 'movies/feature.mkv';
const MEDIA_BYTES = 'not media';
const FRAME_PROBE_FAILURE = 'ffprobe exit 1: Decoder not found';
const STREAM_PROBE_FAILURE = 'ffprobe exit 1: Invalid data found when processing input';
// The ffprobe option that marks the first-frame probe
const SHOW_FRAMES_OPTION = '-show_frames';

type ProbeAnswer = string | Error;

/** A tool whose stream probe and first-frame probe answer with the given output, or fail with the given error. */
function createTool(streamProbe: ProbeAnswer, frameProbe: ProbeAnswer): FFmpegTool & { probe: ReturnType<typeof vi.fn> } {
    const answer = (response: ProbeAnswer): Promise<string> => (
        response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
    );
    return {
        convertSubtitleToWebVTT: vi.fn(),
        probe: vi.fn((_file: File, options: readonly string[]): Promise<string> => (
            answer(options.includes(SHOW_FRAMES_OPTION) ? frameProbe : streamProbe)
        ))
    };
}

function createMediaFile(): File {
    return new File([ MEDIA_BYTES ], MEDIA_PATH);
}

describe('MediaProbe', () => {
    it('describes every track for the panels, leaving out cover pictures', async () => {
        const tool = createTool(createProbeJSON([
            createVideoStreamJSON(),
            createAudioStreamJSON(),
            createSubtitleStreamJSON(),
            createSubtitleStreamJSON({ codec_name: 'hdmv_pgs_subtitle', index: IMAGE_SUBTITLE_STREAM_INDEX }),
            createVideoStreamJSON({ codec_name: 'mjpeg', disposition: { attached_pic: 1 }, index: COVER_PICTURE_STREAM_INDEX })
        ]), createFramesJSON([]));
        const file = createMediaFile();

        const probed = await probeMedia(tool, file, MEDIA_PATH);

        expect(probed.warnings).toEqual([]);
        expect(probed.description).toMatchObject({
            container: 'matroska,webm',
            durationMicroseconds: DURATION_MICROSECONDS,
            path: MEDIA_PATH,
            sizeBytes: file.size
        });
        expect(probed.description.videoTracks).toEqual([ {
            bitDepth: 10,
            codec: 'hevc',
            codedHeight: CODED_VIDEO_HEIGHT,
            codedWidth: VIDEO_WIDTH,
            color: { matrix: 'bt2020nc', primaries: 'bt2020', range: 'limited', transfer: 'smpte2084' },
            displayHeight: VIDEO_HEIGHT,
            displayWidth: VIDEO_WIDTH,
            dolbyVision: { blCompatibilityId: HDR10_COMPATIBILITY_ID, hasEnhancementLayer: false, level: DOLBY_VISION_LEVEL, profile: DOLBY_VISION_PROFILE },
            dynamicRange: 'dolby-vision',
            frameRate: FRAME_RATE,
            index: VIDEO_STREAM_INDEX,
            language: VIDEO_LANGUAGE,
            level: VIDEO_LEVEL,
            name: null,
            profile: VIDEO_PROFILE
        } ]);
        expect(probed.description.audioTracks).toEqual([ {
            channelCount: AUDIO_CHANNEL_COUNT,
            codec: 'dts',
            default: true,
            index: AUDIO_STREAM_INDEX,
            language: VIDEO_LANGUAGE,
            name: AUDIO_NAME,
            profile: AUDIO_PROFILE,
            sampleRate: AUDIO_SAMPLE_RATE
        } ]);
        expect(probed.description.subtitleTracks).toEqual([
            { codec: 'subrip', default: false, forced: true, index: SUBTITLE_STREAM_INDEX, language: SUBTITLE_LANGUAGE, name: null, textBased: true },
            {
                codec: 'hdmv_pgs_subtitle',
                default: false,
                forced: true,
                index: IMAGE_SUBTITLE_STREAM_INDEX,
                language: SUBTITLE_LANGUAGE,
                name: null,
                textBased: false
            }
        ]);
    });

    it('tells HDR10+ apart by the first frame\'s side data', async () => {
        const hdr10Stream = createVideoStreamJSON({ side_data_list: [] });
        const tool = createTool(createProbeJSON([ hdr10Stream ]), createFramesJSON([ FFPROBE_SIDE_DATA_TYPES.hdr10Plus ]));

        const probed = await probeMedia(tool, createMediaFile(), MEDIA_PATH);

        expect(probed.description.videoTracks[0].dynamicRange).toBe('hdr10-plus');
        expect(probed.frames).toEqual([ { sideDataTypes: [ FFPROBE_SIDE_DATA_TYPES.hdr10Plus ], streamIndex: VIDEO_STREAM_INDEX } ]);
    });

    it('reports a first frame it cannot read as a warning and goes on without HDR10+', async () => {
        const tool = createTool(createProbeJSON([ createVideoStreamJSON({ side_data_list: [] }) ]), new Error(FRAME_PROBE_FAILURE));

        const probed = await probeMedia(tool, createMediaFile(), MEDIA_PATH);

        expect(probed.warnings).toEqual([ `first-frame-unreadable: ${FRAME_PROBE_FAILURE}` ]);
        expect(probed.description.videoTracks[0].dynamicRange).toBe('hdr10');
    });

    it('skips the first-frame probe without a video track', async () => {
        const tool = createTool(createProbeJSON([ createAudioStreamJSON() ]), new Error(FRAME_PROBE_FAILURE));

        const probed = await probeMedia(tool, createMediaFile(), MEDIA_PATH);

        expect(tool.probe).toHaveBeenCalledTimes(1);
        expect(probed.warnings).toEqual([]);
    });

    it('rejects when the stream probe fails', async () => {
        const tool = createTool(new Error(STREAM_PROBE_FAILURE), createFramesJSON([]));

        await expect(probeMedia(tool, createMediaFile(), MEDIA_PATH)).rejects.toThrow(STREAM_PROBE_FAILURE);
    });
});
/* eslint-enable @typescript-eslint/naming-convention */
