import { describe, expect, it } from 'vitest';

import { type Microseconds, MICROSECONDS_PER_SECOND } from 'webgpu-player/MediaTime';

import { formatMediaTime, UNKNOWN_MEDIA_TIME_TEXT } from '../../../sandbox/src/ui/TimeFormat';

// Times built from whole seconds, so each expected text reads off its name
const ONE_MINUTE_MICROSECONDS = 60 * MICROSECONDS_PER_SECOND;
const ONE_HOUR_MICROSECONDS = 60 * ONE_MINUTE_MICROSECONDS;
const ZERO_TIME = asMicroseconds(0);
const FIVE_SECONDS = asMicroseconds(5 * MICROSECONDS_PER_SECOND);
const JUST_UNDER_ONE_MINUTE = asMicroseconds(ONE_MINUTE_MICROSECONDS - 1);
const ONE_MINUTE_ONE_SECOND = asMicroseconds(ONE_MINUTE_MICROSECONDS + MICROSECONDS_PER_SECOND);
const JUST_UNDER_ONE_HOUR = asMicroseconds(ONE_HOUR_MICROSECONDS - 1);
const ONE_HOUR = asMicroseconds(ONE_HOUR_MICROSECONDS);
const ONE_HOUR_TWO_MINUTES_THREE_SECONDS = asMicroseconds(
    ONE_HOUR_MICROSECONDS + 2 * ONE_MINUTE_MICROSECONDS + 3 * MICROSECONDS_PER_SECOND
);
const ELEVEN_HOURS = asMicroseconds(11 * ONE_HOUR_MICROSECONDS);
const MINUS_ONE_AND_A_HALF_SECONDS = asMicroseconds(-1.5 * MICROSECONDS_PER_SECOND);

function asMicroseconds(value: number): Microseconds {
    return value as Microseconds;
}

describe('formatMediaTime', () => {
    it('formats minutes and seconds, truncated to whole seconds', () => {
        expect(formatMediaTime(ZERO_TIME)).toBe('0:00');
        expect(formatMediaTime(JUST_UNDER_ONE_MINUTE)).toBe('0:59');
        expect(formatMediaTime(ONE_MINUTE_ONE_SECOND)).toBe('1:01');
        expect(formatMediaTime(JUST_UNDER_ONE_HOUR)).toBe('59:59');
    });

    it('adds hours from one hour on', () => {
        expect(formatMediaTime(ONE_HOUR)).toBe('1:00:00');
        expect(formatMediaTime(ONE_HOUR_TWO_MINUTES_THREE_SECONDS)).toBe('1:02:03');
        expect(formatMediaTime(ELEVEN_HOURS)).toBe('11:00:00');
    });

    it('widens a short time to hours when the duration reaches an hour', () => {
        expect(formatMediaTime(FIVE_SECONDS, ONE_HOUR)).toBe('0:00:05');
        expect(formatMediaTime(FIVE_SECONDS, JUST_UNDER_ONE_HOUR)).toBe('0:05');
    });

    it('signs a negative time and truncates its magnitude', () => {
        expect(formatMediaTime(MINUS_ONE_AND_A_HALF_SECONDS)).toBe('-0:01');
    });

    it('shows an unknown time as placeholder text', () => {
        expect(formatMediaTime(null)).toBe(UNKNOWN_MEDIA_TIME_TEXT);
        expect(formatMediaTime(null, ONE_HOUR)).toBe(UNKNOWN_MEDIA_TIME_TEXT);
    });
});
