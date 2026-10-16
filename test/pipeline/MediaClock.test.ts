import { describe, expect, it } from 'vitest';

import { millisecondsToMicroseconds, secondsToMicroseconds, type Microseconds } from 'webgpu-player/MediaTime';
import MediaClock from 'webgpu-player/pipeline/MediaClock';

// A clock resumed at 10 s with a 70 ms start hold stays at 5 s until 10.07 s
const START_HOLD = millisecondsToMicroseconds(70);
const START_HOLD_MEDIA_TIME = secondsToMicroseconds(5);
const START_HOLD_RESUME_TIME = millisecondsToMicroseconds(10_000);
const START_HOLD_INSIDE_TIME = millisecondsToMicroseconds(10_050);
const START_HOLD_END_TIME = millisecondsToMicroseconds(10_070);
const START_HOLD_AFTER_TIME = millisecondsToMicroseconds(10_100);
const START_HOLD_AFTER_MEDIA_TIME = millisecondsToMicroseconds(5_030);
const START_HOLD_DOUBLE_RATE_AFTER_MEDIA_TIME = millisecondsToMicroseconds(5_060);
const START_HOLD_SYNCHRONIZED_MEDIA_TIME = millisecondsToMicroseconds(4_990);
const START_HOLD_SYNCHRONIZED_AFTER_MEDIA_TIME = millisecondsToMicroseconds(5_040);
const START_HOLD_BACKWARDS_TIME = millisecondsToMicroseconds(9_990);
const NEGATIVE_START_HOLD = -1 as Microseconds;

function createHeldClock(readMonotonicTime: () => Microseconds): MediaClock {
    const clock = new MediaClock(readMonotonicTime);
    clock.seek(START_HOLD_MEDIA_TIME);
    clock.resume(START_HOLD);
    return clock;
}

describe('MediaClock', () => {
    it('keeps its media time through a start hold, then advances from it', () => {
        let monotonicTime = START_HOLD_RESUME_TIME;
        const clock = createHeldClock(() => monotonicTime);

        monotonicTime = START_HOLD_INSIDE_TIME;
        expect(clock.mediaTimeMicroseconds).toBe(START_HOLD_MEDIA_TIME);
        monotonicTime = START_HOLD_END_TIME;
        expect(clock.mediaTimeMicroseconds).toBe(START_HOLD_MEDIA_TIME);
        monotonicTime = START_HOLD_AFTER_TIME;
        expect(clock.mediaTimeMicroseconds).toBe(START_HOLD_AFTER_MEDIA_TIME);
    });

    it('keeps a start hold through invalidation and rate changes, and pauses at its start', () => {
        let monotonicTime = START_HOLD_RESUME_TIME;
        const clock = createHeldClock(() => monotonicTime);

        monotonicTime = START_HOLD_INSIDE_TIME;
        clock.invalidate();
        clock.setPlaybackRate(2);
        expect(clock.mediaTimeMicroseconds).toBe(START_HOLD_MEDIA_TIME);
        monotonicTime = START_HOLD_AFTER_TIME;
        expect(clock.mediaTimeMicroseconds).toBe(START_HOLD_DOUBLE_RATE_AFTER_MEDIA_TIME);

        monotonicTime = START_HOLD_RESUME_TIME;
        const pausedClock = createHeldClock(() => monotonicTime);
        monotonicTime = START_HOLD_INSIDE_TIME;
        pausedClock.pause();
        monotonicTime = START_HOLD_AFTER_TIME;
        expect(pausedClock.mediaTimeMicroseconds).toBe(START_HOLD_MEDIA_TIME);
    });

    it('ends a start hold when it synchronizes to an audio master', () => {
        let monotonicTime = START_HOLD_RESUME_TIME;
        const clock = createHeldClock(() => monotonicTime);

        monotonicTime = START_HOLD_INSIDE_TIME;
        clock.synchronize(START_HOLD_SYNCHRONIZED_MEDIA_TIME);
        expect(clock.mediaTimeMicroseconds).toBe(START_HOLD_SYNCHRONIZED_MEDIA_TIME);
        monotonicTime = START_HOLD_AFTER_TIME;
        expect(clock.mediaTimeMicroseconds).toBe(START_HOLD_SYNCHRONIZED_AFTER_MEDIA_TIME);
    });

    it('rejects a negative start hold and notices time moving backwards inside one', () => {
        let monotonicTime = START_HOLD_RESUME_TIME;
        const clock = new MediaClock(() => monotonicTime);
        expect(() => clock.resume(NEGATIVE_START_HOLD)).toThrow(RangeError);

        const heldClock = createHeldClock(() => monotonicTime);
        monotonicTime = START_HOLD_BACKWARDS_TIME;
        expect(() => heldClock.mediaTimeMicroseconds).toThrow('Monotonic time moved backwards');
    });

    it('advances signed integer media time only while running', () => {
        let monotonicTime = secondsToMicroseconds(10);
        const clock = new MediaClock(() => monotonicTime);

        clock.seek(secondsToMicroseconds(-2));
        expect(clock.mediaTimeMicroseconds).toBe(-2_000_000);

        clock.resume();
        monotonicTime = secondsToMicroseconds(10.25);
        expect(clock.mediaTimeMicroseconds).toBe(-1_750_000);

        clock.pause();
        monotonicTime = secondsToMicroseconds(15);
        expect(clock.mediaTimeMicroseconds).toBe(-1_750_000);
    });

    it('changes rate without introducing a media-time discontinuity', () => {
        let monotonicTime = secondsToMicroseconds(0);
        const clock = new MediaClock(() => monotonicTime);
        clock.resume();
        monotonicTime = secondsToMicroseconds(1);

        const generation = clock.setPlaybackRate(2);
        expect(clock.mediaTimeMicroseconds).toBe(1_000_000);
        expect(clock.rate).toBe(2);
        expect(clock.generation).toBe(generation);

        monotonicTime = secondsToMicroseconds(1.25);
        expect(clock.snapshot()).toEqual({
            generation,
            mediaTimeMicroseconds: 1_500_000,
            paused: false,
            playbackRate: 2
        });
    });

    it('synchronizes to an external audio master without changing generation', () => {
        let monotonicTime = secondsToMicroseconds(10);
        const clock = new MediaClock(() => monotonicTime);
        clock.resume();
        const generation = clock.generation;

        monotonicTime = secondsToMicroseconds(10.5);
        clock.synchronize(secondsToMicroseconds(5));
        expect(clock.generation).toBe(generation);
        expect(clock.mediaTimeMicroseconds).toBe(5_000_000);

        monotonicTime = secondsToMicroseconds(10.75);
        expect(clock.mediaTimeMicroseconds).toBe(5_250_000);
    });

    it('invalidates captured generations on every state operation', () => {
        const clock = new MediaClock(() => secondsToMicroseconds(0));
        const initialGeneration = clock.generation;
        const seekGeneration = clock.seek(secondsToMicroseconds(5));
        const pauseGeneration = clock.pause();
        const resumeGeneration = clock.resume();
        const rateGeneration = clock.setPlaybackRate(1);
        const invalidatedGeneration = clock.invalidate();
        const resetGeneration = clock.reset(secondsToMicroseconds(-1));

        expect([
            initialGeneration,
            seekGeneration,
            pauseGeneration,
            resumeGeneration,
            rateGeneration,
            invalidatedGeneration,
            resetGeneration
        ]).toEqual([ 1, 2, 3, 4, 5, 6, 7 ]);
        expect(clock.generation).toBe(resetGeneration);
        expect(clock.isPaused).toBe(true);
        expect(clock.rate).toBe(1);
        expect(clock.mediaTimeMicroseconds).toBe(-1_000_000);
    });

    it('rejects invalid rates, timestamps, and non-monotonic time', () => {
        let monotonicTime: Microseconds = secondsToMicroseconds(1);
        const clock = new MediaClock(() => monotonicTime);

        expect(() => clock.setPlaybackRate(0)).toThrow(RangeError);
        expect(() => clock.setPlaybackRate(Number.NaN)).toThrow(RangeError);
        expect(() => clock.seek(1.5 as Microseconds)).toThrow(RangeError);

        clock.resume();
        monotonicTime = secondsToMicroseconds(0.5);
        expect(() => clock.mediaTimeMicroseconds).toThrow('Monotonic time moved backwards');
    });
});
