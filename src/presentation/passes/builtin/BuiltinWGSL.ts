/** The digits after the decimal point of every generated WGSL constant, as the legacy shaders print them. */
const WGSL_FLOAT_FRACTION_DIGITS = 9;

/** Formats a finite number as a WGSL f32 literal. */
export function toWGSLFloat(value: number): string {
    if (!Number.isFinite(value)) {
        throw new RangeError('WGSL constants must be finite');
    }

    return value.toFixed(WGSL_FLOAT_FRACTION_DIGITS);
}

/** Joins WGSL declarations into one block, one blank line apart, without leading or trailing blank lines. */
export function joinWGSL(declarations: readonly string[]): string {
    return declarations
        .map((declaration: string): string => declaration.trim())
        .join('\n\n');
}
