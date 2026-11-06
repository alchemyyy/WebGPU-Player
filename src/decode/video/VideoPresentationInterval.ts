import type { Microseconds } from '../../MediaTime';

/**
 * Returns whether a decoded frame covering [t, t + d) of media time can present when presentation samples the media every interval:
 * some integer k has t ≤ k × interval < t + d.
 * Every frame can when the interval is null, and so can a frame without a positive duration.
 */
export function isVideoFramePresentable(
    mediaTimeMicroseconds: Microseconds,
    durationMicroseconds: Microseconds,
    intervalMicroseconds: Microseconds | null
): boolean {
    if (intervalMicroseconds === null || durationMicroseconds <= 0) {
        return true;
    }
    // The distance from the frame's start to the first multiple at or after it, in integers alone
    const remainder = ((mediaTimeMicroseconds % intervalMicroseconds) + intervalMicroseconds) % intervalMicroseconds;
    const distanceToMultiple = remainder === 0 ? 0 : intervalMicroseconds - remainder;
    return distanceToMultiple < durationMicroseconds;
}
