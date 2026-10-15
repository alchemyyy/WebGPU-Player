// A decoder package's identity: the id its header declares, which every version of the package keeps, and the content hash that tells its versions apart.
// A host stores packages by id, so a new version replaces the old one, and the engine keeps what it derives from a package, such as compiled pipelines, by id with the content hash as the version.
// The engine book's decoder packages chapter describes the rules.

/** The longest id a package may declare. */
export const DECODER_PACKAGE_ID_MAXIMUM_LENGTH = 64;

// Lowercase ASCII letters and digits, in runs joined by single hyphens
const DECODER_PACKAGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The header check an `id:` value failed, with a terse detail of the failing value. */
export type DecoderPackageIdFailure = Readonly<{
    code: 'id-length' | 'id-syntax'
    detail: string
}>;

/** One version of a package: its id, which every version keeps, and the lowercase hexadecimal SHA-256 of its file. */
export type DecoderPackageVersion = Readonly<{
    contentHash: string
    id: string
}>;

/** Returns why a header's `id:` value is no package id, or null when it is one. */
export function findDecoderPackageIdFailure(value: string): DecoderPackageIdFailure | null {
    if (value.length > DECODER_PACKAGE_ID_MAXIMUM_LENGTH) {
        return { code: 'id-length', detail: `${value.length} > ${DECODER_PACKAGE_ID_MAXIMUM_LENGTH}` };
    }
    if (!DECODER_PACKAGE_ID_PATTERN.test(value)) {
        return { code: 'id-syntax', detail: `'${value}'` };
    }
    return null;
}

export function isDecoderPackageVersion(value: unknown): value is DecoderPackageVersion {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const version = value as Record<string, unknown>;
    return typeof version.contentHash === 'string' && typeof version.id === 'string';
}

/** Returns whether two package versions are one version of one package. */
export function isSameDecoderPackageVersion(first: DecoderPackageVersion, second: DecoderPackageVersion): boolean {
    return first.id === second.id && first.contentHash === second.contentHash;
}
