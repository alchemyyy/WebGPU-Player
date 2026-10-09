// Integer argument validation shared by the audio decoders, processing stages, and worklet output

/** Returns the value, or throws a RangeError that names it when it is not a positive safe integer. */
export function requirePositiveSafeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`);
    }
    return value;
}
