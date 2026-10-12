/* eslint-disable @typescript-eslint/naming-convention -- ffprobe's JSON keys are snake_case */
import { describe, expect, it } from 'vitest';

import {
    FFPROBE_SIDE_DATA_TYPES,
    findFFprobeSideData,
    isContainerVideoStream,
    parseFFprobeFrames,
    parseFFprobeOutput,
    parseFFprobePositiveInteger,
    parseFFprobeRate,
    parseFFprobeSeconds
} from '../../../sandbox/src/session/FFprobeOutput';
import {
    AUDIO_RAW_SAMPLE_DEPTH,
    COVER_PICTURE_STREAM_INDEX,
    createAudioStreamJSON,
    createErrorJSON,
    createFramesJSON,
    createProbeJSON,
    createVideoStreamJSON,
    DOLBY_VISION_PROFILE,
    DURATION_MICROSECONDS,
    DURATION_TEXT,
    FRAME_RATE,
    FRAME_RATE_TEXT,
    HDR10_COMPATIBILITY_ID,
    INVALID_DATA_ERROR_CODE,
    INVALID_DATA_ERROR_MESSAGE,
    VIDEO_STREAM_INDEX
} from './ffprobeTestOutput';

// Durations as ffprobe prints them, and the exact microseconds they hold
const WHOLE_SECONDS_TEXT = '42';
const WHOLE_SECONDS_MICROSECONDS = 42_000_000;
const SHORT_FRACTION_TEXT = '0.5';
const SHORT_FRACTION_MICROSECONDS = 500_000;
// Text that no duration or rate is
const NEGATIVE_SECONDS_TEXT = '-0.007000';
const NOT_A_NUMBER_TEXT = 'N/A';
const UNDEFINED_RATE_TEXT = '0/0';
const POSITIVE_INTEGER_TEXT = '44100';
const POSITIVE_INTEGER = 44_100;
const ZERO_TEXT = '0';

describe('FFprobeOutput', () => {
    it('reads streams with numbers printed as strings, and skips streams without an index', () => {
        const output = parseFFprobeOutput(createProbeJSON([
            createVideoStreamJSON(),
            createAudioStreamJSON(),
            createAudioStreamJSON({ index: undefined })
        ]));

        expect(output.format).toEqual({ duration: DURATION_TEXT, formatName: 'matroska,webm' });
        expect(output.streams).toHaveLength(2);
        expect(output.streams[0]).toMatchObject({ bitsPerRawSample: 10, codecName: 'hevc', index: VIDEO_STREAM_INDEX });
        expect(output.streams[1]).toMatchObject({ bitsPerRawSample: AUDIO_RAW_SAMPLE_DEPTH, bitsPerSample: 0, sampleRate: '48000' });
        const dolbyVision = findFFprobeSideData(output.streams[0], FFPROBE_SIDE_DATA_TYPES.dolbyVision);
        expect(dolbyVision).toMatchObject({ dvBlSignalCompatibilityId: HDR10_COMPATIBILITY_ID, dvProfile: DOLBY_VISION_PROFILE });
    });

    it('rejects output that is not an object', () => {
        expect(() => parseFFprobeOutput('[]')).toThrow('ffprobe-output-invalid');
        expect(() => parseFFprobeFrames('null')).toThrow('ffprobe-output-invalid');
    });

    it('throws the error section ffprobe prints for a file it cannot read', () => {
        const expectedMessage = `ffprobe-error: ${INVALID_DATA_ERROR_MESSAGE} (${INVALID_DATA_ERROR_CODE})`;

        expect(() => parseFFprobeOutput(createErrorJSON())).toThrow(expectedMessage);
        expect(() => parseFFprobeFrames(createErrorJSON())).toThrow(expectedMessage);
    });

    it('reads each frame\'s side data types', () => {
        expect(parseFFprobeFrames(createFramesJSON([ FFPROBE_SIDE_DATA_TYPES.hdr10Plus ]))).toEqual([
            { sideDataTypes: [ FFPROBE_SIDE_DATA_TYPES.hdr10Plus ], streamIndex: VIDEO_STREAM_INDEX }
        ]);
    });

    it('tells container video tracks from cover pictures', () => {
        const output = parseFFprobeOutput(createProbeJSON([
            createVideoStreamJSON(),
            createVideoStreamJSON({ codec_name: 'mjpeg', disposition: { attached_pic: 1 }, index: COVER_PICTURE_STREAM_INDEX }),
            createAudioStreamJSON()
        ]));

        expect(output.streams.map(isContainerVideoStream)).toEqual([ true, false, false ]);
    });

    it('parses durations exactly into integer microseconds', () => {
        expect(parseFFprobeSeconds(DURATION_TEXT)).toBe(DURATION_MICROSECONDS);
        expect(parseFFprobeSeconds(WHOLE_SECONDS_TEXT)).toBe(WHOLE_SECONDS_MICROSECONDS);
        expect(parseFFprobeSeconds(SHORT_FRACTION_TEXT)).toBe(SHORT_FRACTION_MICROSECONDS);
        expect(parseFFprobeSeconds(NEGATIVE_SECONDS_TEXT)).toBeNull();
        expect(parseFFprobeSeconds(NOT_A_NUMBER_TEXT)).toBeNull();
        expect(parseFFprobeSeconds(null)).toBeNull();
    });

    it('parses rates and positive integers, rejecting undefined ones', () => {
        expect(parseFFprobeRate(FRAME_RATE_TEXT)).toBe(FRAME_RATE);
        expect(parseFFprobeRate(UNDEFINED_RATE_TEXT)).toBeNull();
        expect(parseFFprobeRate(NOT_A_NUMBER_TEXT)).toBeNull();
        expect(parseFFprobePositiveInteger(POSITIVE_INTEGER_TEXT)).toBe(POSITIVE_INTEGER);
        expect(parseFFprobePositiveInteger(ZERO_TEXT)).toBeNull();
        expect(parseFFprobePositiveInteger(null)).toBeNull();
    });
});
/* eslint-enable @typescript-eslint/naming-convention */
