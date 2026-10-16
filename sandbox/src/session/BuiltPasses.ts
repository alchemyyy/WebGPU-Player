// The pass files of the engine's pass projects, which the asset build copies into the pass output folder and the sandbox's dev server lists, so the shader panel offers them.
// The dev server serves the engine's output folder as its public folder, so each pass file is fetched from there
import { PASS_FILE_EXTENSION } from 'webgpu-player/presentation/passes/PassLanguage';

import { BUILT_PASSES_ROUTE, fetchBuiltOutputEntries, type BuiltOutputEntry } from './BuiltOutputRoutes';

/**
 * Lists the pass files the dev server lists.
 * Rejects with a code and a detail when the dev server lists nothing, as a static build of the sandbox does.
 */
export async function listBuiltPasses(): Promise<BuiltOutputEntry[]> {
    const listed = await fetchBuiltOutputEntries(BUILT_PASSES_ROUTE, 'built-passes-unavailable');
    return listed.filter((entry: BuiltOutputEntry): boolean => entry.fileName.toLowerCase().endsWith(PASS_FILE_EXTENSION));
}

/** Fetches a listed pass file's source; a failed fetch rejects with the file and its HTTP status, which the session records under its code. */
export async function fetchBuiltPassSource(entry: BuiltOutputEntry): Promise<string> {
    const response = await fetch(entry.url);
    if (!response.ok) {
        throw new Error(`${entry.fileName} HTTP ${response.status}`);
    }
    return response.text();
}
