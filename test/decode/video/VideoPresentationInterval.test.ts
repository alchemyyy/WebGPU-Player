import { describe, expect, it } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';
import { isVideoFramePresentable } from 'webgpu-player/decode/video/VideoPresentationInterval';

const FRAME_DURATION_MICROSECONDS = 40_000 as Microseconds;
// Two and a half frame durations, as at 2.5x on a display refreshing every frame duration
const INTERVAL_MICROSECONDS = 100_000 as Microseconds;

function isFramePresentable(frameIndex: number): boolean {
    return isVideoFramePresentable(
        (frameIndex * FRAME_DURATION_MICROSECONDS) as Microseconds,
        FRAME_DURATION_MICROSECONDS,
        INTERVAL_MICROSECONDS
    );
}

describe('isVideoFramePresentable', () => {
    it('keeps the frames some multiple of the interval falls within, start inclusive and end exclusive', () => {
        const presentableFrames = Array.from({ length: 11 }, (_value: unknown, frameIndex: number): number => frameIndex)
            .filter(isFramePresentable);

        // Multiples at 0, 100, 200, 300, and 400 ms fall within frames 0, 2, 5, 7, and 10
        expect(presentableFrames).toEqual([ 0, 2, 5, 7, 10 ]);
    });

    it('takes the grid through negative media times', () => {
        expect(isVideoFramePresentable(-100_000 as Microseconds, FRAME_DURATION_MICROSECONDS, INTERVAL_MICROSECONDS)).toBe(true);
        expect(isVideoFramePresentable(-140_000 as Microseconds, FRAME_DURATION_MICROSECONDS, INTERVAL_MICROSECONDS)).toBe(false);
        expect(isVideoFramePresentable(-120_000 as Microseconds, FRAME_DURATION_MICROSECONDS, INTERVAL_MICROSECONDS)).toBe(true);
    });

    it('keeps every frame without an interval, and a frame without a positive duration', () => {
        expect(isVideoFramePresentable(40_000 as Microseconds, FRAME_DURATION_MICROSECONDS, null)).toBe(true);
        expect(isVideoFramePresentable(40_000 as Microseconds, 0 as Microseconds, INTERVAL_MICROSECONDS)).toBe(true);
    });
});
