// Media time as text, from integer microseconds, with integer arithmetic only.
import { type Microseconds, MICROSECONDS_PER_SECOND } from 'webgpu-player/MediaTime';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;
const MICROSECONDS_PER_HOUR = SECONDS_PER_HOUR * MICROSECONDS_PER_SECOND;
const TWO_DIGIT_FIELD_WIDTH = 2;

/** The text for a time that is not known, such as the duration before the probe finishes. */
export const UNKNOWN_MEDIA_TIME_TEXT = '--:--';

/** Pads a minute or second field to two digits. */
function formatTwoDigitField(value: number): string {
    return String(value).padStart(TWO_DIGIT_FIELD_WIDTH, '0');
}

/**
 * Formats a time as M:SS, or as H:MM:SS when it or the duration reaches an hour, truncated to whole seconds.
 * Passing the duration keeps the current time as wide as the total time while it plays.
 */
export function formatMediaTime(timeMicroseconds: Microseconds | null, durationMicroseconds: Microseconds | null = null): string {
    if (timeMicroseconds === null) {
        return UNKNOWN_MEDIA_TIME_TEXT;
    }
    const sign = timeMicroseconds < 0 ? '-' : '';
    const magnitude = Math.abs(timeMicroseconds);
    // Subtracting the remainder first keeps the division exact
    const totalSeconds = (magnitude - (magnitude % MICROSECONDS_PER_SECOND)) / MICROSECONDS_PER_SECOND;
    const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
    const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    const secondsText = formatTwoDigitField(totalSeconds % SECONDS_PER_MINUTE);
    const showsHours = hours > 0 || (durationMicroseconds !== null && durationMicroseconds >= MICROSECONDS_PER_HOUR);
    if (!showsHours) {
        return `${sign}${minutes}:${secondsText}`;
    }
    return `${sign}${hours}:${formatTwoDigitField(minutes)}:${secondsText}`;
}
