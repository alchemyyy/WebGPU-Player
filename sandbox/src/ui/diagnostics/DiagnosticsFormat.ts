// Formatting the diagnostics panels share: engine values to short display text.
import type { PassRejection } from 'webgpu-player/presentation/passes/PassTypes';

/** How a value reads, which the panels color it by: plain, de-emphasized, healthy, suspicious, or failed. */
export type DiagnosticTone = 'failure' | 'muted' | 'normal' | 'success' | 'warning';

/** Stands in for a value the engine has not reported. */
export const MISSING_VALUE_TEXT = '-';

/** Joins the parts of a compact value. */
export const VALUE_SEPARATOR = ', ';

// Joins the dimensions of a size or a dispatch, such as 1920x1080
const EXTENT_SEPARATOR = 'x';

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
