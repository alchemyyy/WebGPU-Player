import { describe, expect, it } from 'vitest';

import {
    jellyfinTicksToMicroseconds,
    microsecondsToJellyfinTicks,
    microsecondsToMilliseconds,
    microsecondsToSeconds,
    millisecondsToMicroseconds,
    secondsToMicroseconds
} from 'webgpu-player/MediaTime';

describe('MediaTime', () => {
    it('rounds HTML seconds to signed integer microseconds', () => {
        expect(secondsToMicroseconds(1.2345674)).toBe(1_234_567);
        expect(secondsToMicroseconds(1.2345676)).toBe(1_234_568);
        expect(secondsToMicroseconds(-1.25)).toBe(-1_250_000);
        expect(Number.isInteger(secondsToMicroseconds(0.0000006))).toBe(true);
    });

    it('rounds Jellyfin milliseconds to signed integer microseconds', () => {
        expect(millisecondsToMicroseconds(12.345)).toBe(12_345);
        expect(millisecondsToMicroseconds(-12.345)).toBe(-12_345);
        expect(Number.isInteger(millisecondsToMicroseconds(0.0006))).toBe(true);
    });

    it('converts microseconds only at API boundaries', () => {
        const microseconds = millisecondsToMicroseconds(12.345);
        expect(microsecondsToMilliseconds(microseconds)).toBe(12.345);
        expect(microsecondsToSeconds(microseconds)).toBe(0.012345);
        expect(microsecondsToJellyfinTicks(microseconds)).toBe(123_450);
        expect(jellyfinTicksToMicroseconds(123_450)).toBe(microseconds);
    });

    it('rejects invalid and unsafe timestamps', () => {
        expect(() => secondsToMicroseconds(Number.NaN)).toThrow(RangeError);
        expect(() => secondsToMicroseconds(Number.POSITIVE_INFINITY)).toThrow(RangeError);
        expect(() => millisecondsToMicroseconds(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
        expect(() => jellyfinTicksToMicroseconds(Number.POSITIVE_INFINITY)).toThrow(RangeError);
        expect(() => microsecondsToJellyfinTicks(
            millisecondsToMicroseconds(Number.MAX_SAFE_INTEGER / 2_000)
        )).toThrow(RangeError);
    });
});
