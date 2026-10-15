// The engine's built decoder packages, which the sandbox's dev server lists, so the decoder package panel adds them all in one step.
// The dev server serves the engine's output folder as its public folder, so each package is fetched from there
import { DECODER_PACKAGE_FILE_EXTENSION } from 'webgpu-player/decode/packages/DecoderPackage';

import { BUILT_DECODER_PACKAGES_ROUTE, type BuiltDecoderPackageEntry } from './BuiltDecoderPackageRoute';

function isBuiltDecoderPackageEntry(value: unknown): value is BuiltDecoderPackageEntry {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    return typeof entry.fileName === 'string' && typeof entry.url === 'string';
}

/**
 * Fetches every built package the dev server lists, as files to add.
 * Rejects with a code and a detail when the dev server lists nothing, as a static build of the sandbox does, or a package fails to fetch.
 */
export async function fetchBuiltDecoderPackages(): Promise<File[]> {
    const listResponse = await fetch(BUILT_DECODER_PACKAGES_ROUTE);
    if (!listResponse.ok) {
        throw new Error(`built-packages-unavailable: ${BUILT_DECODER_PACKAGES_ROUTE} HTTP ${listResponse.status}`);
    }
    const listed: unknown = await listResponse.json();
    if (!Array.isArray(listed) || !listed.every(isBuiltDecoderPackageEntry)) {
        throw new Error(`built-packages-unavailable: ${BUILT_DECODER_PACKAGES_ROUTE} lists no package entries`);
    }
    const entries = listed.filter((entry: BuiltDecoderPackageEntry): boolean => entry.fileName.toLowerCase().endsWith(DECODER_PACKAGE_FILE_EXTENSION));
    if (entries.length === 0) {
        throw new Error('built-packages-missing: the decoder package output folder is empty; build the packages with npm run decoders');
    }
    const files: File[] = [];
    for (const entry of entries) {
        const response = await fetch(entry.url);
        if (!response.ok) {
            throw new Error(`built-package-fetch: ${entry.fileName} HTTP ${response.status}`);
        }
        files.push(new File([ await response.arrayBuffer() ], entry.fileName));
    }
    return files;
}
