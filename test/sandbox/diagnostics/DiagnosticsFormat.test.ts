import { describe, expect, it } from 'vitest';

import type { PassRejection } from 'webgpu-player/presentation/passes/PassTypes';

import {
    formatAudioFrames,
    formatBitrate,
    formatBytes,
    formatCodec,
    formatDecibels,
    formatDimensions,
    formatExtent,
    formatFrameRate,
    formatMilliseconds,
    formatNormalizedError,
    formatPageTime,
    formatPassRejection,
    formatPercent,
    formatPreciseMediaTime,
    formatSampleRate,
    getPassRejectionTone,
    joinPresentValues,
    MISSING_VALUE_TEXT
} from '../../../sandbox/src/ui/diagnostics/DiagnosticsFormat';
import { UNKNOWN_MEDIA_TIME_TEXT } from '../../../sandbox/src/ui/TimeFormat';
import { microseconds } from './telemetryTestState';

// 1 h 2 min 3.456789 s
const HOUR_TIME_MICROSECONDS = 3_723_456_789;
const HOUR_TIME_TEXT = '1:02:03.456';
// 1 min 30.25 s
const MINUTE_TIME_MICROSECONDS = 90_250_000;
const MINUTE_TIME_TEXT = '1:30.250';
const NEGATIVE_TIME_MICROSECONDS = -1_500_000;
const NEGATIVE_TIME_TEXT = '-0:01.500';
const SHORT_TIME_MICROSECONDS = 61_000_000;
const HOUR_DURATION_MICROSECONDS = 3_600_000_000;
const SHORT_TIME_IN_HOUR_TEXT = '0:01:01.000';

const FRAME_DURATION_MICROSECONDS = 41_708;
const FRAME_DURATION_TEXT = '41.7 ms';
const NEGATIVE_OFFSET_MICROSECONDS = -12_500;
const NEGATIVE_OFFSET_TEXT = '-12.5 ms';
const PAGE_TIME_MILLISECONDS = 12_345.6;
const PAGE_TIME_TEXT = '12.3 s';

const SAMPLE_RATE = 48_000;
const TENTH_SECOND_FRAMES = 4_800;
const TENTH_SECOND_TEXT = '100.0 ms';
const TENTH_SECOND_FRAMES_TEXT = '4800 frames';

const SMALL_BYTE_COUNT = 512;
const SMALL_BYTES_TEXT = '512 B';
const KIBIBYTES_BYTE_COUNT = 1_536;
const KIBIBYTES_TEXT = '1.50 KiB';
const GIBIBYTES_BYTE_COUNT = 1_610_612_736;
const GIBIBYTES_TEXT = '1.50 GiB';

// 1.5 GB over 10 minutes is 20 Mbit/s
const LARGE_FILE_BYTE_COUNT = 1_500_000_000;
const TEN_MINUTES_MICROSECONDS = 600_000_000;
const LARGE_FILE_BITRATE_TEXT = '20.00 Mbit/s';
// 1 MB over a minute is 133 kbit/s
const SMALL_FILE_BYTE_COUNT = 1_000_000;
const ONE_MINUTE_MICROSECONDS = 60_000_000;
const SMALL_FILE_BITRATE_TEXT = '133 kbit/s';

const NTSC_FILM_FRAME_RATE = 24_000 / 1_001;
const NTSC_FILM_FRAME_RATE_TEXT = '23.976 fps';
const PAL_FRAME_RATE = 25;
const PAL_FRAME_RATE_TEXT = '25 fps';
const CD_SAMPLE_RATE = 44_100;
const CD_SAMPLE_RATE_TEXT = '44.1 kHz';
const DVD_SAMPLE_RATE_TEXT = '48 kHz';

const FULL_SCALE = 1;
const FULL_SCALE_TEXT = '0.0 dBFS';
const HALF_SCALE = 0.5;
const HALF_SCALE_TEXT = '-6.0 dBFS';
const SILENCE_TEXT = '-inf dBFS';
const VOLUME_FRACTION = 0.8;
const VOLUME_TEXT = '80%';
const CHANNEL_ERROR = 0.011764;
const CHANNEL_ERROR_TEXT = '0.0118';
const UNBOUNDED_ERROR_TEXT = 'inf';

const VIDEO_CODEC = 'hevc';
const VIDEO_PROFILE = 'Main 10';

const WORKGROUP_COUNTS = [ 240, 135, 1 ];
const WORKGROUP_TEXT = '240x135x1';
const WIDTH = 1920;
const HEIGHT = 1080;
const DIMENSIONS_TEXT = '1920x1080';
const FIRST_PART = 'first';
const SECOND_PART = 'second';

const COMPILE_ERROR_REJECTION: PassRejection = { detail: 'line 4: unknown identifier', name: 'Broken', reason: 'compile-error' };
const CONDITION_FALSE_REJECTION: PassRejection = { detail: 'hdr.source', name: 'HDR only', reason: 'condition-false' };
const DETAILLESS_REJECTION: PassRejection = { detail: '', name: 'Twin', reason: 'duplicate-name' };

describe('formatPreciseMediaTime', () => {
    it('adds truncated milliseconds to the media time', () => {
        expect(formatPreciseMediaTime(microseconds(HOUR_TIME_MICROSECONDS))).toBe(HOUR_TIME_TEXT);
        expect(formatPreciseMediaTime(microseconds(MINUTE_TIME_MICROSECONDS))).toBe(MINUTE_TIME_TEXT);
        expect(formatPreciseMediaTime(microseconds(NEGATIVE_TIME_MICROSECONDS))).toBe(NEGATIVE_TIME_TEXT);
    });

    it('shows hours when the duration reaches an hour, and the unknown time for null', () => {
        expect(formatPreciseMediaTime(microseconds(SHORT_TIME_MICROSECONDS), microseconds(HOUR_DURATION_MICROSECONDS))).toBe(SHORT_TIME_IN_HOUR_TEXT);
        expect(formatPreciseMediaTime(null)).toBe(UNKNOWN_MEDIA_TIME_TEXT);
    });
});

describe('the duration formats', () => {
    it('formats durations and offsets in milliseconds, and page times in seconds', () => {
        expect(formatMilliseconds(microseconds(FRAME_DURATION_MICROSECONDS))).toBe(FRAME_DURATION_TEXT);
        expect(formatMilliseconds(microseconds(NEGATIVE_OFFSET_MICROSECONDS))).toBe(NEGATIVE_OFFSET_TEXT);
        expect(formatPageTime(PAGE_TIME_MILLISECONDS)).toBe(PAGE_TIME_TEXT);
    });

    it('formats audio frames as their duration at the rate, or as frames while the rate is unknown', () => {
        expect(formatAudioFrames(TENTH_SECOND_FRAMES, SAMPLE_RATE)).toBe(TENTH_SECOND_TEXT);
        expect(formatAudioFrames(TENTH_SECOND_FRAMES, null)).toBe(TENTH_SECOND_FRAMES_TEXT);
    });
});

describe('the size and rate formats', () => {
    it('formats byte counts in binary units', () => {
        expect(formatBytes(SMALL_BYTE_COUNT)).toBe(SMALL_BYTES_TEXT);
        expect(formatBytes(KIBIBYTES_BYTE_COUNT)).toBe(KIBIBYTES_TEXT);
        expect(formatBytes(GIBIBYTES_BYTE_COUNT)).toBe(GIBIBYTES_TEXT);
    });

    it('formats a file\'s average bitrate, and nothing without a duration', () => {
        expect(formatBitrate(LARGE_FILE_BYTE_COUNT, microseconds(TEN_MINUTES_MICROSECONDS))).toBe(LARGE_FILE_BITRATE_TEXT);
        expect(formatBitrate(SMALL_FILE_BYTE_COUNT, microseconds(ONE_MINUTE_MICROSECONDS))).toBe(SMALL_FILE_BITRATE_TEXT);
        expect(formatBitrate(SMALL_FILE_BYTE_COUNT, microseconds(0))).toBe(MISSING_VALUE_TEXT);
    });

    it('formats frame and sample rates without trailing zeros', () => {
        expect(formatFrameRate(NTSC_FILM_FRAME_RATE)).toBe(NTSC_FILM_FRAME_RATE_TEXT);
        expect(formatFrameRate(PAL_FRAME_RATE)).toBe(PAL_FRAME_RATE_TEXT);
        expect(formatSampleRate(CD_SAMPLE_RATE)).toBe(CD_SAMPLE_RATE_TEXT);
        expect(formatSampleRate(SAMPLE_RATE)).toBe(DVD_SAMPLE_RATE_TEXT);
    });

    it('formats levels, fractions, and errors', () => {
        expect(formatDecibels(FULL_SCALE)).toBe(FULL_SCALE_TEXT);
        expect(formatDecibels(HALF_SCALE)).toBe(HALF_SCALE_TEXT);
        expect(formatDecibels(0)).toBe(SILENCE_TEXT);
        expect(formatPercent(VOLUME_FRACTION)).toBe(VOLUME_TEXT);
        expect(formatNormalizedError(CHANNEL_ERROR)).toBe(CHANNEL_ERROR_TEXT);
        expect(formatNormalizedError(Number.POSITIVE_INFINITY)).toBe(UNBOUNDED_ERROR_TEXT);
    });

    it('formats extents and dimensions', () => {
        expect(formatExtent(WORKGROUP_COUNTS)).toBe(WORKGROUP_TEXT);
        expect(formatDimensions(WIDTH, HEIGHT)).toBe(DIMENSIONS_TEXT);
    });
});

describe('the text formats', () => {
    it('adds a codec\'s parameter string only when it says more', () => {
        expect(formatCodec(VIDEO_CODEC, VIDEO_PROFILE)).toBe(`${VIDEO_CODEC} (${VIDEO_PROFILE})`);
        expect(formatCodec(VIDEO_CODEC, null)).toBe(VIDEO_CODEC);
    });

    it('joins the parts that are present', () => {
        expect(joinPresentValues([ FIRST_PART, null, SECOND_PART ])).toBe(`${FIRST_PART}, ${SECOND_PART}`);
        expect(joinPresentValues([ null ])).toBe(MISSING_VALUE_TEXT);
        // An empty part is no value either, so it leaves no stray separator
        expect(joinPresentValues([ FIRST_PART, '', SECOND_PART ])).toBe(`${FIRST_PART}, ${SECOND_PART}`);
    });

    it('formats a left-out pass as its reason and detail, a failure unless its condition was false', () => {
        expect(formatPassRejection(COMPILE_ERROR_REJECTION)).toBe(`${COMPILE_ERROR_REJECTION.reason}: ${COMPILE_ERROR_REJECTION.detail}`);
        expect(formatPassRejection(DETAILLESS_REJECTION)).toBe(DETAILLESS_REJECTION.reason);
        expect(getPassRejectionTone(COMPILE_ERROR_REJECTION)).toBe('failure');
        expect(getPassRejectionTone(CONDITION_FALSE_REJECTION)).toBe('muted');
    });
});
