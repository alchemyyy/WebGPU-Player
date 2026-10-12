import { describe, expect, it } from 'vitest';

import { type Microseconds, MICROSECONDS_PER_SECOND } from 'webgpu-player/MediaTime';

import { getPointerFraction, getTimeAtFraction, getTimeFraction } from '../../../sandbox/src/ui/panels/TimelinePosition';

const TRACK_LEFT = 100;
const TRACK_WIDTH = 400;
const QUARTER_OF_TRACK_X = TRACK_LEFT + TRACK_WIDTH / 4;
const LEFT_OF_TRACK_X = TRACK_LEFT - 30;
const RIGHT_OF_TRACK_X = TRACK_LEFT + TRACK_WIDTH + 30;
const ZERO_WIDTH = 0;
const DURATION = asMicroseconds(90 * MICROSECONDS_PER_SECOND);
// A duration of three microseconds puts a third of it between two whole microseconds
const THREE_MICROSECOND_DURATION = asMicroseconds(3);
const ZERO_DURATION = asMicroseconds(0);
const QUARTER_OF_DURATION = asMicroseconds(DURATION / 4);
const PAST_THE_END = asMicroseconds(DURATION + MICROSECONDS_PER_SECOND);
const BEFORE_THE_START = asMicroseconds(-MICROSECONDS_PER_SECOND);

function asMicroseconds(value: number): Microseconds {
    return value as Microseconds;
}

describe('TimelinePosition', () => {
    it('reads the pointer fraction across the track, clamped to its ends', () => {
        expect(getPointerFraction(QUARTER_OF_TRACK_X, TRACK_LEFT, TRACK_WIDTH)).toBe(0.25);
        expect(getPointerFraction(TRACK_LEFT, TRACK_LEFT, TRACK_WIDTH)).toBe(0);
        expect(getPointerFraction(LEFT_OF_TRACK_X, TRACK_LEFT, TRACK_WIDTH)).toBe(0);
        expect(getPointerFraction(RIGHT_OF_TRACK_X, TRACK_LEFT, TRACK_WIDTH)).toBe(1);
    });

    it('reads 0 on a track without width', () => {
        expect(getPointerFraction(QUARTER_OF_TRACK_X, TRACK_LEFT, ZERO_WIDTH)).toBe(0);
    });

    it('maps a fraction to whole microseconds of the duration, clamped to it', () => {
        expect(getTimeAtFraction(0.25, DURATION)).toBe(QUARTER_OF_DURATION);
        expect(getTimeAtFraction(1, DURATION)).toBe(DURATION);
        expect(getTimeAtFraction(-0.5, DURATION)).toBe(0);
        expect(getTimeAtFraction(1.5, DURATION)).toBe(DURATION);
        const thirdOfShortDuration = getTimeAtFraction(1 / 3, THREE_MICROSECOND_DURATION);
        expect(Number.isInteger(thirdOfShortDuration)).toBe(true);
        expect(thirdOfShortDuration).toBe(1);
    });

    it('maps a time to its fraction of the duration, clamped, and to 0 without a positive duration', () => {
        expect(getTimeFraction(QUARTER_OF_DURATION, DURATION)).toBe(0.25);
        expect(getTimeFraction(PAST_THE_END, DURATION)).toBe(1);
        expect(getTimeFraction(BEFORE_THE_START, DURATION)).toBe(0);
        expect(getTimeFraction(QUARTER_OF_DURATION, null)).toBe(0);
        expect(getTimeFraction(QUARTER_OF_DURATION, ZERO_DURATION)).toBe(0);
    });
});
