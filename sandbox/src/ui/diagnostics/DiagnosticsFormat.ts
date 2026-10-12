// Formatting the diagnostics panels share: engine values to short display text, with time from integer microseconds.
import {
    MICROSECONDS_PER_MILLISECOND,
    MICROSECONDS_PER_SECOND,
    microsecondsToMilliseconds,
    type Microseconds
} from 'webgpu-player/MediaTime';
import type { PassRejection } from 'webgpu-player/presentation/passes/PassTypes';
import { audioFramesToMicroseconds } from 'webgpu-player/TimeMath';

import { formatMediaTime } from '../TimeFormat';

/** How a value reads, which the panels color it by: plain, de-emphasized, healthy, suspicious, or failed. */
export type DiagnosticTone = 'failure' | 'muted' | 'normal' | 'success' | 'warning';

/** Stands in for a value the engine has not reported. */
export const MISSING_VALUE_TEXT = '-';

/** Joins the parts of a compact value. */
export const VALUE_SEPARATOR = ', ';

// Joins the dimensions of a size or a dispatch, such as 1920x1080
const EXTENT_SEPARATOR = 'x';
const MILLISECOND_FIELD_WIDTH = 3;
const MILLISECOND_DECIMALS = 1;
const MILLISECONDS_PER_SECOND = MICROSECONDS_PER_SECOND / MICROSECONDS_PER_MILLISECOND;
const SECOND_DECIMALS = 1;
const BYTES_PER_KIBIBYTE = 1_024;
const BYTE_UNITS: readonly string[] = [ 'B', 'KiB', 'MiB', 'GiB', 'TiB' ];
const SCALED_BYTE_DECIMALS = 2;
const BITS_PER_BYTE = 8;
const BITS_PER_KILOBIT = 1_000;
const BITS_PER_MEGABIT = 1_000_000;
const MEGABIT_DECIMALS = 2;
const HERTZ_PER_KILOHERTZ = 1_000;
const RATE_DECIMALS = 3;
// Amplitude to decibels relative to full scale: 20 log10(amplitude)
const DECIBELS_PER_AMPLITUDE_DECADE = 20;
const DECIBEL_DECIMALS = 1;
const SILENT_DECIBELS_TEXT = '-inf dBFS';
const PERCENT = 100;
const NORMALIZED_ERROR_DECIMALS = 4;
const UNBOUNDED_ERROR_TEXT = 'inf';

/** Formats the dimensions of a size or a workgroup dispatch, such as 240x135x1. */
export function formatExtent(dimensions: readonly number[]): string {
    return dimensions.join(EXTENT_SEPARATOR);
}

/** Formats a size in pixels, such as 1920x1080. */
export function formatDimensions(width: number, height: number): string {
    return formatExtent([ width, height ]);
}

/** Formats a pass the plan left out as its check and detail, as the presenter reports them. */
export function formatPassRejection(rejection: PassRejection): string {
    return `${rejection.reason}: ${rejection.detail}`;
}

/** Every reason but 'condition-false' is a failure; a false condition only switches the pass off. */
export function getPassRejectionTone(rejection: PassRejection): DiagnosticTone {
    return rejection.reason === 'condition-false' ? 'muted' : 'failure';
}

/** Joins the parts that are present, or returns MISSING_VALUE_TEXT when none is. */
export function joinPresentValues(parts: readonly (string | null)[]): string {
    const presentParts: string[] = [];
    for (const part of parts) {
        if (part !== null) {
            presentParts.push(part);
        }
    }
    return presentParts.length > 0 ? presentParts.join(VALUE_SEPARATOR) : MISSING_VALUE_TEXT;
}

/** Formats a media time like formatMediaTime, with milliseconds, such as 1:02:03.456; truncated, as formatMediaTime truncates. */
export function formatPreciseMediaTime(timeMicroseconds: Microseconds | null, durationMicroseconds: Microseconds | null = null): string {
    if (timeMicroseconds === null) {
        return formatMediaTime(null);
    }
    const milliseconds = Math.floor((Math.abs(timeMicroseconds) % MICROSECONDS_PER_SECOND) / MICROSECONDS_PER_MILLISECOND);
    return `${formatMediaTime(timeMicroseconds, durationMicroseconds)}.${String(milliseconds).padStart(MILLISECOND_FIELD_WIDTH, '0')}`;
}

/** Formats a duration or an offset in milliseconds, such as 41.7 ms. */
export function formatMilliseconds(durationMicroseconds: Microseconds): string {
    return `${microsecondsToMilliseconds(durationMicroseconds).toFixed(MILLISECOND_DECIMALS)} ms`;
}

/** Formats a performance.now() time in seconds, such as 12.3 s. */
export function formatPageTime(timeMilliseconds: number): string {
    return `${(timeMilliseconds / MILLISECONDS_PER_SECOND).toFixed(SECOND_DECIMALS)} s`;
}

/** Formats a count of audio frames as its duration at the rate, or as frames while the rate is unknown. */
export function formatAudioFrames(frameCount: number, sampleRate: number | null): string {
    return sampleRate === null ? `${frameCount} frames` : formatMilliseconds(audioFramesToMicroseconds(frameCount, sampleRate));
}

/** Formats a byte count in binary units, such as 1.50 GiB. */
export function formatBytes(byteCount: number): string {
    let value = byteCount;
    let unitIndex = 0;
    while (value >= BYTES_PER_KIBIBYTE && unitIndex < BYTE_UNITS.length - 1) {
        value /= BYTES_PER_KIBIBYTE;
        unitIndex += 1;
    }
    return unitIndex === 0 ? `${byteCount} ${BYTE_UNITS[0]}` : `${value.toFixed(SCALED_BYTE_DECIMALS)} ${BYTE_UNITS[unitIndex]}`;
}

/** Formats the average bitrate of a file over its duration, such as 18.52 Mbit/s. */
export function formatBitrate(byteCount: number, durationMicroseconds: Microseconds): string {
    if (durationMicroseconds <= 0) {
        return MISSING_VALUE_TEXT;
    }
    const bitsPerSecond = (byteCount * BITS_PER_BYTE * MICROSECONDS_PER_SECOND) / durationMicroseconds;
    return bitsPerSecond >= BITS_PER_MEGABIT ?
        `${(bitsPerSecond / BITS_PER_MEGABIT).toFixed(MEGABIT_DECIMALS)} Mbit/s` :
        `${Math.round(bitsPerSecond / BITS_PER_KILOBIT)} kbit/s`;
}

/** Formats a frame rate without trailing zeros, such as 23.976 fps. */
export function formatFrameRate(frameRate: number): string {
    return `${Number(frameRate.toFixed(RATE_DECIMALS))} fps`;
}

/** Formats a sample rate in kilohertz, such as 44.1 kHz. */
export function formatSampleRate(sampleRate: number): string {
    return `${Number((sampleRate / HERTZ_PER_KILOHERTZ).toFixed(RATE_DECIMALS))} kHz`;
}

/** Formats an amplitude relative to full scale, such as -3.0 dBFS. */
export function formatDecibels(amplitude: number): string {
    return amplitude > 0 ? `${(DECIBELS_PER_AMPLITUDE_DECADE * Math.log10(amplitude)).toFixed(DECIBEL_DECIMALS)} dBFS` : SILENT_DECIBELS_TEXT;
}

/** Formats a fraction as a whole percentage, such as 80%. */
export function formatPercent(fraction: number): string {
    return `${Math.round(fraction * PERCENT)}%`;
}

/** Formats an error as a fraction of full scale, such as 0.0118, or inf for a failed measurement. */
export function formatNormalizedError(error: number): string {
    return Number.isFinite(error) ? error.toFixed(NORMALIZED_ERROR_DECIMALS) : UNBOUNDED_ERROR_TEXT;
}

/** Formats a codec with its parameter string when it says more, such as hevc (hvc1.2.4.L153.B0). */
export function formatCodec(codec: string, codecString: string | null): string {
    return codecString === null || codecString === codec ? codec : `${codec} (${codecString})`;
}
