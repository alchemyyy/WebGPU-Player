/** Accepts every positive integer source rate; the resampler converts any rate to the output rate. */
export function isSupportedCustomAudioSampleRate(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value > 0;
}

/** Returns a source rate or rejects malformed decoder/container metadata. */
export function requireSupportedCustomAudioSampleRate(
    value: unknown,
    label: string
): number {
    if (!isSupportedCustomAudioSampleRate(value)) {
        throw new RangeError(`${label} must be a positive integer number of Hz`);
    }
    return value;
}
