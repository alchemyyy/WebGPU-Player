// The dev server's routes that list the engine's built decoder packages and pass files; vite.config.ts serves them and the sandbox fetches them.
// It imports nothing, because the dev server's config loads it without the sandbox's aliases

/** The dev server's route that lists the files in the decoder package output folder, as JSON entries of a file name and the URL it is served at. */
export const BUILT_DECODER_PACKAGES_ROUTE = '/__sandbox/built-decoder-packages';

/** The dev server's route that lists the files in the pass output folder, as the same entries. */
export const BUILT_PASSES_ROUTE = '/__sandbox/built-passes';

/** A file the dev server lists in an output folder. */
export type BuiltOutputEntry = Readonly<{ fileName: string, url: string }>;

function isBuiltOutputEntry(value: unknown): value is BuiltOutputEntry {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    return typeof entry.fileName === 'string' && typeof entry.url === 'string';
}

/**
 * Fetches the entries a listing route returns.
 * Rejects with the given code and a detail when the dev server lists nothing, as a static build of the sandbox does.
 */
export async function fetchBuiltOutputEntries(route: string, unavailableCode: string): Promise<BuiltOutputEntry[]> {
    const listResponse = await fetch(route);
    if (!listResponse.ok) {
        throw new Error(`${unavailableCode}: ${route} HTTP ${listResponse.status}`);
    }
    const listed: unknown = await listResponse.json();
    if (!Array.isArray(listed) || !listed.every(isBuiltOutputEntry)) {
        throw new Error(`${unavailableCode}: ${route} lists no file entries`);
    }
    return listed;
}
