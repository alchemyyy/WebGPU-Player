const MAXIMUM_HDR_LUMINANCE_NITS = 10_000;
export const MAXIMUM_STATIC_HDR_METADATA_SCAN_ACCESS_UNIT_COUNT = 16;

export type StaticHDRMetadataScanStatus =
    | 'absent'
    | 'conflicting'
    | 'malformed'
    | 'valid';

export type StaticHDRMetadata = {
    masteringDisplayMaximumLuminanceNits: number | null
    masteringDisplayMinimumLuminanceNits: number | null
    maximumContentLightLevelNits: number | null
    maximumFrameAverageLightLevelNits: number | null
};

export type StaticHDRMetadataScanResult = {
    accessUnitCount: number
    firstMetadataAccessUnitIndex: number | null
    metadata: StaticHDRMetadata | null
    status: StaticHDRMetadataScanStatus
};

const STATIC_HDR_METADATA_PROPERTIES: readonly (keyof StaticHDRMetadata)[] = [
    'masteringDisplayMaximumLuminanceNits',
    'masteringDisplayMinimumLuminanceNits',
    'maximumContentLightLevelNits',
    'maximumFrameAverageLightLevelNits'
];

/** Reports a static HDR value that differs from one recorded before it, so a scan keeps none of them. */
class StaticHDRMetadataConflictError extends TypeError {
    public constructor() {
        super('The units contain conflicting static HDR metadata');
        this.name = 'StaticHDRMetadataConflictError';
    }
}

function isNullableLuminance(value: unknown, allowZero: boolean): value is number | null {
    return value === null || (
        typeof value === 'number'
        && Number.isFinite(value)
        && value >= (allowZero ? 0 : 1)
        && value <= MAXIMUM_HDR_LUMINANCE_NITS
    );
}

/** Validates bounded static HDR luminance metadata received across a worker boundary. */
export function isStaticHDRMetadata(value: unknown): value is StaticHDRMetadata {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const metadata = value as Partial<StaticHDRMetadata>;
    if (!isNullableLuminance(metadata.masteringDisplayMaximumLuminanceNits, false)
        || !isNullableLuminance(metadata.masteringDisplayMinimumLuminanceNits, true)
        || !isNullableLuminance(metadata.maximumContentLightLevelNits, false)
        || !isNullableLuminance(metadata.maximumFrameAverageLightLevelNits, false)) {
        return false;
    }
    return metadata.masteringDisplayMaximumLuminanceNits === null
        || metadata.masteringDisplayMinimumLuminanceNits === null
        || metadata.masteringDisplayMinimumLuminanceNits < metadata.masteringDisplayMaximumLuminanceNits;
}

/** Validates the bounded startup scan result received across a worker boundary. */
export function isStaticHDRMetadataScanResult(value: unknown): value is StaticHDRMetadataScanResult {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const result = value as Partial<StaticHDRMetadataScanResult>;
    if (!Number.isSafeInteger(result.accessUnitCount)
        || Number(result.accessUnitCount) < 0
        || Number(result.accessUnitCount) > MAXIMUM_STATIC_HDR_METADATA_SCAN_ACCESS_UNIT_COUNT) {
        return false;
    }
    switch (result.status) {
        case 'valid':
            return isStaticHDRMetadata(result.metadata)
                && Object.values(result.metadata).some((luminanceNits: number | null): boolean => luminanceNits !== null)
                && Number.isSafeInteger(result.firstMetadataAccessUnitIndex)
                && Number(result.firstMetadataAccessUnitIndex) >= 0
                && Number(result.firstMetadataAccessUnitIndex) < Number(result.accessUnitCount);
        case 'absent':
        case 'conflicting':
        case 'malformed':
            return result.metadata === null && result.firstMetadataAccessUnitIndex === null;
        default:
            return false;
    }
}

/** Creates the record that the MDCV and CLL values of a unit, or of a whole scan, merge into. */
export function createEmptyStaticHDRMetadata(): StaticHDRMetadata {
    return {
        masteringDisplayMaximumLuminanceNits: null,
        masteringDisplayMinimumLuminanceNits: null,
        maximumContentLightLevelNits: null,
        maximumFrameAverageLightLevelNits: null
    };
}

/** Records one value, which must agree with the value already recorded; null is unknown and records nothing. */
function mergeStaticHDRMetadataValue(
    metadata: StaticHDRMetadata,
    property: keyof StaticHDRMetadata,
    value: number | null
): void {
    if (value === null) {
        return;
    }
    const previousValue = metadata[property];
    if (previousValue !== null && previousValue !== value) {
        throw new StaticHDRMetadataConflictError();
    }
    metadata[property] = value;
}

function mergeStaticHDRMetadata(destination: StaticHDRMetadata, source: StaticHDRMetadata): void {
    for (const property of STATIC_HDR_METADATA_PROPERTIES) {
        mergeStaticHDRMetadataValue(destination, property, source[property]);
    }
}

/** Records the luminance range of a mastering display color volume, in nits. */
export function mergeMasteringDisplayLuminance(metadata: StaticHDRMetadata, maximumNits: number, minimumNits: number): void {
    mergeStaticHDRMetadataValue(metadata, 'masteringDisplayMaximumLuminanceNits', maximumNits);
    mergeStaticHDRMetadataValue(metadata, 'masteringDisplayMinimumLuminanceNits', minimumNits);
}

/** Records MaxCLL and MaxFALL, in nits, where zero means unknown. */
export function mergeContentLightLevels(
    metadata: StaticHDRMetadata,
    maximumContentLightLevelNits: number,
    maximumFrameAverageLightLevelNits: number
): void {
    mergeStaticHDRMetadataValue(
        metadata,
        'maximumContentLightLevelNits',
        maximumContentLightLevelNits > 0 ? maximumContentLightLevelNits : null
    );
    mergeStaticHDRMetadataValue(
        metadata,
        'maximumFrameAverageLightLevelNits',
        maximumFrameAverageLightLevelNits > 0 ? maximumFrameAverageLightLevelNits : null
    );
}

/** Returns the values merged from one unit, or null when it carried none, and throws a TypeError when they are invalid. */
export function completeStaticHDRMetadata(metadata: StaticHDRMetadata): StaticHDRMetadata | null {
    const hasMetadata = Object.values(metadata).some((value: number | null): boolean => value !== null);
    if (!hasMetadata) {
        return null;
    }
    if (!isStaticHDRMetadata(metadata)) {
        throw new TypeError('A unit contains invalid static HDR metadata');
    }
    return metadata;
}

function createDiscardedScanResult(
    accessUnitCount: number,
    status: Exclude<StaticHDRMetadataScanStatus, 'valid'>
): StaticHDRMetadataScanResult {
    return {
        accessUnitCount,
        firstMetadataAccessUnitIndex: null,
        metadata: null,
        status
    };
}

/**
 * Scans the static HDR metadata of a bounded startup prefix of a track's units, an HEVC access unit or an AV1 temporal unit each.
 * The parser returns null for a unit without static HDR metadata and throws a TypeError for a malformed one.
 * A malformed unit, or a value that differs from an earlier one, discards every value.
 */
export function scanStaticHDRMetadata(
    units: readonly Uint8Array[],
    parseUnit: (unit: Uint8Array) => StaticHDRMetadata | null
): StaticHDRMetadataScanResult {
    if (units.length > MAXIMUM_STATIC_HDR_METADATA_SCAN_ACCESS_UNIT_COUNT) {
        throw new RangeError('The static HDR metadata scan exceeds its access-unit bound');
    }

    const metadata = createEmptyStaticHDRMetadata();
    let firstMetadataAccessUnitIndex: number | null = null;
    for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
        try {
            const parsedMetadata = parseUnit(units[unitIndex]);
            if (!parsedMetadata) {
                continue;
            }
            mergeStaticHDRMetadata(metadata, parsedMetadata);
        } catch (error) {
            if (error instanceof StaticHDRMetadataConflictError) {
                return createDiscardedScanResult(units.length, 'conflicting');
            }
            if (error instanceof TypeError) {
                return createDiscardedScanResult(units.length, 'malformed');
            }
            throw error;
        }
        firstMetadataAccessUnitIndex ??= unitIndex;
    }

    if (firstMetadataAccessUnitIndex === null) {
        return createDiscardedScanResult(units.length, 'absent');
    }
    if (!isStaticHDRMetadata(metadata)) {
        return createDiscardedScanResult(units.length, 'malformed');
    }
    return {
        accessUnitCount: units.length,
        firstMetadataAccessUnitIndex,
        metadata,
        status: 'valid'
    };
}

/** Chooses the static source peak used by the bounded SDR tone-mapping curve. */
export function getStaticHDRToneMappingPeakNits(metadata: StaticHDRMetadata): number | null {
    if (!isStaticHDRMetadata(metadata)) {
        throw new TypeError('Static HDR metadata is invalid');
    }
    return metadata.masteringDisplayMaximumLuminanceNits ?? metadata.maximumContentLightLevelNits;
}
