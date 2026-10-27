import { describe, expect, it } from 'vitest';

import DisplayRefresh from 'webgpu-player/presentation/DisplayRefresh';

const SIXTY_HERTZ_MILLISECONDS = 1_000 / 60;
const HUNDRED_FORTY_FOUR_HERTZ_MILLISECONDS = 1_000 / 144;
const FIRST_FRAME_MILLISECONDS = 12_345.678;
// Half a second of 60 Hz frames is short of a measurement, and a second of them, through any timer, is not
const SHORT_FRAME_COUNT = 20;
const SECOND_FRAME_COUNT = 60;
const LONG_FRAME_COUNT = 240;
// Outside cross-origin isolation, Firefox coarsens page timers to whole milliseconds
const COARSE_TIMER_MILLISECONDS = 1;
// The measurement's tolerance, well inside the 0.1% that tells 23.976 from 24
const RELATIVE_TOLERANCE = 0.0003;
// A busy page skips refreshes: every fifth frame comes two refreshes after the last, and one comes four after
const SKIPPING_STEPS: readonly number[] = Array.from({ length: LONG_FRAME_COUNT }, (_value: unknown, index: number): number => {
    if (index === 100) {
        return 4;
    }
    return index % 5 === 4 ? 2 : 1;
});
// A paused loop leaves two seconds without frames
const PAUSE_MILLISECONDS = 2_000;

/** Records frames from a time, each the given refreshes after the last, through a timer coarsened to a step; returns the last frame's exact time. */
function recordFrames(
    displayRefresh: DisplayRefresh,
    firstMilliseconds: number,
    intervalMilliseconds: number,
    steps: readonly number[],
    timerStepMilliseconds = 0
): number {
    let timeMilliseconds = firstMilliseconds;
    for (const step of steps) {
        timeMilliseconds += step * intervalMilliseconds;
        displayRefresh.record(timerStepMilliseconds > 0 ? Math.floor(timeMilliseconds / timerStepMilliseconds) * timerStepMilliseconds : timeMilliseconds);
    }
    return timeMilliseconds;
}

function getRelativeError(displayRefresh: DisplayRefresh, intervalMilliseconds: number): number {
    const measured = displayRefresh.getIntervalMilliseconds();
    if (measured === null) {
        throw new Error('The display was not measured');
    }
    return Math.abs(measured - intervalMilliseconds) / intervalMilliseconds;
}

function createSteps(count: number): number[] {
    return Array.from({ length: count }, (): number => 1);
}

describe('DisplayRefresh', () => {
    it('measures nothing until its frames fit a precise line, then the refresh interval', () => {
        const displayRefresh = new DisplayRefresh();

        const lastMilliseconds = recordFrames(displayRefresh, FIRST_FRAME_MILLISECONDS, SIXTY_HERTZ_MILLISECONDS, createSteps(SHORT_FRAME_COUNT));
        expect(displayRefresh.getIntervalMilliseconds()).toBeNull();
        recordFrames(displayRefresh, lastMilliseconds, SIXTY_HERTZ_MILLISECONDS, createSteps(SHORT_FRAME_COUNT));

        expect(getRelativeError(displayRefresh, SIXTY_HERTZ_MILLISECONDS)).toBeLessThan(RELATIVE_TOLERANCE);
    });

    it('measures through a timer coarsened to whole milliseconds within a second', () => {
        const displayRefresh = new DisplayRefresh();

        recordFrames(displayRefresh, FIRST_FRAME_MILLISECONDS, SIXTY_HERTZ_MILLISECONDS, createSteps(SECOND_FRAME_COUNT), COARSE_TIMER_MILLISECONDS);

        expect(getRelativeError(displayRefresh, SIXTY_HERTZ_MILLISECONDS)).toBeLessThan(RELATIVE_TOLERANCE);
    });

    it('counts the refreshes a busy page skips, rather than lengthening the interval', () => {
        const displayRefresh = new DisplayRefresh();

        recordFrames(displayRefresh, FIRST_FRAME_MILLISECONDS, SIXTY_HERTZ_MILLISECONDS, SKIPPING_STEPS, COARSE_TIMER_MILLISECONDS);

        expect(getRelativeError(displayRefresh, SIXTY_HERTZ_MILLISECONDS)).toBeLessThan(RELATIVE_TOLERANCE);
    });

    it('measures again when the display changes, keeping the last measurement until the new one is precise', () => {
        const displayRefresh = new DisplayRefresh();
        const switchMilliseconds = recordFrames(displayRefresh, FIRST_FRAME_MILLISECONDS, SIXTY_HERTZ_MILLISECONDS, createSteps(LONG_FRAME_COUNT));

        const afterSwitchMilliseconds = recordFrames(displayRefresh, switchMilliseconds, HUNDRED_FORTY_FOUR_HERTZ_MILLISECONDS, createSteps(SHORT_FRAME_COUNT));
        expect(getRelativeError(displayRefresh, SIXTY_HERTZ_MILLISECONDS)).toBeLessThan(RELATIVE_TOLERANCE);
        recordFrames(displayRefresh, afterSwitchMilliseconds, HUNDRED_FORTY_FOUR_HERTZ_MILLISECONDS, createSteps(SECOND_FRAME_COUNT));

        expect(getRelativeError(displayRefresh, HUNDRED_FORTY_FOUR_HERTZ_MILLISECONDS)).toBeLessThan(RELATIVE_TOLERANCE);
    });

    it('keeps its measurement across a pause, and measures on after it', () => {
        const displayRefresh = new DisplayRefresh();
        const pauseMilliseconds = recordFrames(displayRefresh, FIRST_FRAME_MILLISECONDS, SIXTY_HERTZ_MILLISECONDS, createSteps(SECOND_FRAME_COUNT));

        recordFrames(displayRefresh, pauseMilliseconds + PAUSE_MILLISECONDS, SIXTY_HERTZ_MILLISECONDS, createSteps(SHORT_FRAME_COUNT));

        expect(getRelativeError(displayRefresh, SIXTY_HERTZ_MILLISECONDS)).toBeLessThan(RELATIVE_TOLERANCE);
    });

    it('ignores a frame time that does not follow the last, as a stub that repeats one time gives', () => {
        const displayRefresh = new DisplayRefresh();
        let timeMilliseconds = FIRST_FRAME_MILLISECONDS;

        for (let index = 0; index < SECOND_FRAME_COUNT; index += 1) {
            timeMilliseconds += SIXTY_HERTZ_MILLISECONDS;
            displayRefresh.record(timeMilliseconds);
            displayRefresh.record(timeMilliseconds);
            displayRefresh.record(Number.NaN);
        }

        expect(getRelativeError(displayRefresh, SIXTY_HERTZ_MILLISECONDS)).toBeLessThan(RELATIVE_TOLERANCE);
    });
});
