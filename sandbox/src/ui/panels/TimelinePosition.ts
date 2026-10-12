// Converts between a pointer on the timeline, a fraction of the duration, and media time in integer microseconds.
import type { Microseconds } from 'webgpu-player/MediaTime';

function clampFraction(fraction: number): number {
    return Math.min(1, Math.max(0, fraction));
}

/** Returns the fraction of the track at a pointer's client x, clamped to the track; 0 on a track without width. */
export function getPointerFraction(pointerClientX: number, trackLeft: number, trackWidth: number): number {
    if (trackWidth <= 0) {
        return 0;
    }
    return clampFraction((pointerClientX - trackLeft) / trackWidth);
}

/** Returns the media time at a fraction of the duration, rounded to whole microseconds. */
export function getTimeAtFraction(fraction: number, durationMicroseconds: Microseconds): Microseconds {
    return Math.round(clampFraction(fraction) * durationMicroseconds) as Microseconds;
}

/** Returns the fraction of the duration a time has reached, clamped to the duration; 0 without a positive duration. */
export function getTimeFraction(timeMicroseconds: Microseconds, durationMicroseconds: Microseconds | null): number {
    if (durationMicroseconds === null || durationMicroseconds <= 0) {
        return 0;
    }
    return clampFraction(timeMicroseconds / durationMicroseconds);
}
