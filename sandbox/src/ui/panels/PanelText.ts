// Terse panel text built from optional parts.

const PART_SEPARATOR = ' ';

/** Joins the parts that are present with spaces, skipping null and empty ones. */
export function joinTextParts(parts: readonly (number | string | null)[]): string {
    const presentParts: string[] = [];
    for (const part of parts) {
        if (part !== null && part !== '') {
            presentParts.push(String(part));
        }
    }
    return presentParts.join(PART_SEPARATOR);
}
