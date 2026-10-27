import { describe, expect, it } from 'vitest';

import FrameInterval from 'webgpu-player/presentation/FrameInterval';

const FIRST_TIMESTAMP_MICROSECONDS = 3_000_000;
const FILM_FRAME_MICROSECONDS = 1_000_000 / 24;
// Half the 0.2% at which smooth motion tells a whole number of refreshes per frame, a third of a second in, and a fifth of that a second in
const EARLY_RELATIVE_TOLERANCE = 0.001;
const SETTLED_RELATIVE_TOLERANCE = 0.0002;
const EARLY_FRAME_COUNT = 8;
const SETTLED_FRAME_COUNT = 24;
const PAL_FRAME_MICROSECONDS = 40_000;
const FIELD_RATE_PAL_FRAME_MICROSECONDS = 20_000;
const NTSC_FIELD_RATE_FRAME_MICROSECONDS = 1_000_000 / 60;

/** A frame as the presenter records it: its timestamp, and its own duration or none. */
type RecordedFrame = Readonly<{
    durationMicroseconds: number | null
    timestampMicroseconds: number
}>;

/**
 * Creates frames that follow each other at a frame duration from a first timestamp, each lasting up to the next one, or declaring no duration.
 */
function createFrames(frameCount: number, frameMicroseconds: number, firstMicroseconds: number, declaresDurations: boolean): RecordedFrame[] {
    return Array.from({ length: frameCount }, (_value: unknown, index: number): RecordedFrame => ({
        durationMicroseconds: declaresDurations ? frameMicroseconds : null,
        timestampMicroseconds: firstMicroseconds + (index * frameMicroseconds)
    }));
}

/** Records the frames in order. */
function recordFrames(frameInterval: FrameInterval, frames: readonly RecordedFrame[]): void {
    for (const frame of frames) {
        frameInterval.record(frame.timestampMicroseconds, frame.durationMicroseconds);
    }
}

describe('FrameInterval', () => {
    it('evens out timestamps a container rounded to the millisecond', () => {
        const frameInterval = new FrameInterval();
        // 24 fps in Matroska: timestamps on the millisecond, so frames last 42, 41, and 42 ms
        const timestampsMicroseconds = Array.from(
            { length: 49 },
            (_value: unknown, index: number): number => Math.round((FIRST_TIMESTAMP_MICROSECONDS + (index * FILM_FRAME_MICROSECONDS)) / 1000) * 1000
        );
        const relativeErrors: number[] = [];

        for (let index = 0; index < timestampsMicroseconds.length - 1; index += 1) {
            frameInterval.record(timestampsMicroseconds[index], timestampsMicroseconds[index + 1] - timestampsMicroseconds[index]);
            relativeErrors.push(Math.abs((frameInterval.getIntervalMicroseconds() / FILM_FRAME_MICROSECONDS) - 1));
        }

        expect(Math.max(...relativeErrors.slice(EARLY_FRAME_COUNT - 1))).toBeLessThan(EARLY_RELATIVE_TOLERANCE);
        expect(Math.max(...relativeErrors.slice(SETTLED_FRAME_COUNT - 1))).toBeLessThan(SETTLED_RELATIVE_TOLERANCE);
    });

    it('counts the frames the frame loop skipped between two it drew', () => {
        const frameInterval = new FrameInterval();
        const frames = createFrames(SETTLED_FRAME_COUNT, PAL_FRAME_MICROSECONDS, FIRST_TIMESTAMP_MICROSECONDS, false);

        recordFrames(frameInterval, frames.filter((_frame: RecordedFrame, index: number): boolean => index !== 5 && index !== 6 && index !== 15));

        expect(frameInterval.getIntervalMicroseconds()).toBeCloseTo(PAL_FRAME_MICROSECONDS, 6);
    });

    it('starts over within two frames when the frame rate changes', () => {
        const fieldRate = createFrames(SETTLED_FRAME_COUNT, NTSC_FIELD_RATE_FRAME_MICROSECONDS, FIRST_TIMESTAMP_MICROSECONDS, false);
        const film = createFrames(2, FILM_FRAME_MICROSECONDS, FIRST_TIMESTAMP_MICROSECONDS + (SETTLED_FRAME_COUNT * NTSC_FIELD_RATE_FRAME_MICROSECONDS), false);
        const toFilm = new FrameInterval();
        recordFrames(toFilm, [ ...fieldRate, ...film ]);

        // A stream that halves its rate, which frames that time themselves tell from a loop that skips every other frame
        const halfRate = createFrames(2, PAL_FRAME_MICROSECONDS, FIRST_TIMESTAMP_MICROSECONDS + (SETTLED_FRAME_COUNT * FIELD_RATE_PAL_FRAME_MICROSECONDS), true);
        const toHalfRate = new FrameInterval();
        recordFrames(toHalfRate, [ ...createFrames(SETTLED_FRAME_COUNT, FIELD_RATE_PAL_FRAME_MICROSECONDS, FIRST_TIMESTAMP_MICROSECONDS, true), ...halfRate ]);

        expect(toFilm.getIntervalMicroseconds()).toBeCloseTo(FILM_FRAME_MICROSECONDS, 6);
        expect(toHalfRate.getIntervalMicroseconds()).toBe(PAL_FRAME_MICROSECONDS);
    });

    it('times a window\'s first frame by its own duration, else knows no interval until the next frame', () => {
        const frameInterval = new FrameInterval();

        frameInterval.record(FIRST_TIMESTAMP_MICROSECONDS, null);
        expect(frameInterval.getIntervalMicroseconds()).toBe(0);
        frameInterval.record(FIRST_TIMESTAMP_MICROSECONDS + PAL_FRAME_MICROSECONDS, null);
        expect(frameInterval.getIntervalMicroseconds()).toBe(PAL_FRAME_MICROSECONDS);

        // A frame that does not follow the last starts the window over
        frameInterval.record(FIRST_TIMESTAMP_MICROSECONDS, null);
        expect(frameInterval.getIntervalMicroseconds()).toBe(0);

        frameInterval.reset();
        expect(frameInterval.getIntervalMicroseconds()).toBe(0);
        frameInterval.record(FIRST_TIMESTAMP_MICROSECONDS + (10 * PAL_FRAME_MICROSECONDS), FILM_FRAME_MICROSECONDS);
        expect(frameInterval.getIntervalMicroseconds()).toBe(FILM_FRAME_MICROSECONDS);
    });
});
