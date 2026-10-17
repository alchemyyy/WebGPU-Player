export const COLOR_METADATA_VERSION = 1;

/** BT.2408's HDR reference white, the nits of graphics white in a PQ or HLG signal. */
export const HDR_REFERENCE_WHITE_NITS = 203;

const MAXIMUM_LUMINANCE_NITS = 10_000;
const MINIMUM_LUMINANCE_NITS = 1;
const MINIMUM_BIT_DEPTH = 8;
const MAXIMUM_BIT_DEPTH = 16;

// The BT.601 members use the WebCodecs names (SMPTE 170M for 525-line, BT.470 BG for 625-line), so they compare directly with VideoFrame.colorSpace
export type ColorPrimaries = 'bt2020' | 'bt470bg' | 'bt709' | 'smpte170m';
export type ColorRange = 'full' | 'limited';
export type ColorTransfer = 'hlg' | 'pq' | 'sdr';
export type YUVMatrix = 'bt2020-ncl' | 'bt470bg' | 'bt709' | 'smpte170m';

export type InputColorMetadata = {
    bitDepth: number
    matrix: YUVMatrix
    nominalPeakNits: number
    primaries: ColorPrimaries
    range: ColorRange
    sdrReferenceWhiteNits: number
    transfer: ColorTransfer
    version: typeof COLOR_METADATA_VERSION
};

export type InputColorMetadataOverrides = Partial<Omit<InputColorMetadata, 'version'>>;

/** Throws `<name>: <value> outside [<minimum>, <maximum>]` unless value is a finite number in the range. */
export function requireSettingRange(name: string, value: number, minimum: number, maximum: number): void {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
        throw new RangeError(`${name}: ${value} outside [${minimum}, ${maximum}]`);
    }
}

/** Throws `<field>: <value> <problem>` when input metadata cannot drive the reference color pipeline. */
export function assertValidInputColorMetadata(metadata: InputColorMetadata): void {
    if (metadata.version !== COLOR_METADATA_VERSION) {
        throw new RangeError(`metadata version: ${metadata.version}, expected ${COLOR_METADATA_VERSION}`);
    }
    switch (metadata.matrix) {
        case 'bt2020-ncl':
        case 'bt470bg':
        case 'bt709':
        case 'smpte170m':
            break;
        default:
            throw new RangeError(`matrix: unsupported '${String(metadata.matrix)}'`);
    }
    switch (metadata.primaries) {
        case 'bt2020':
        case 'bt470bg':
        case 'bt709':
        case 'smpte170m':
            break;
        default:
            throw new RangeError(`primaries: unsupported '${String(metadata.primaries)}'`);
    }
    switch (metadata.range) {
        case 'full':
        case 'limited':
            break;
        default:
            throw new RangeError(`range: unsupported '${String(metadata.range)}'`);
    }
    switch (metadata.transfer) {
        case 'hlg':
        case 'pq':
        case 'sdr':
            break;
        default:
            throw new RangeError(`transfer: unsupported '${String(metadata.transfer)}'`);
    }
    if (!Number.isInteger(metadata.bitDepth) || metadata.bitDepth < MINIMUM_BIT_DEPTH || metadata.bitDepth > MAXIMUM_BIT_DEPTH) {
        throw new RangeError(`bitDepth: ${metadata.bitDepth} outside integers [${MINIMUM_BIT_DEPTH}, ${MAXIMUM_BIT_DEPTH}]`);
    }
    requireSettingRange('nominalPeakNits', metadata.nominalPeakNits, MINIMUM_LUMINANCE_NITS, MAXIMUM_LUMINANCE_NITS);
    requireSettingRange('sdrReferenceWhiteNits', metadata.sdrReferenceWhiteNits, MINIMUM_LUMINANCE_NITS, MAXIMUM_LUMINANCE_NITS);
}

/** Creates BT.709 SDR metadata for reference processing and tests. */
export function createSDRColorMetadata(overrides: InputColorMetadataOverrides = {}): InputColorMetadata {
    const metadata: InputColorMetadata = {
        bitDepth: 8,
        matrix: 'bt709',
        nominalPeakNits: 100,
        primaries: 'bt709',
        range: 'limited',
        sdrReferenceWhiteNits: 100,
        transfer: 'sdr',
        version: COLOR_METADATA_VERSION,
        ...overrides
    };
    assertValidInputColorMetadata(metadata);
    return metadata;
}

/** Creates BT.2020 PQ metadata for reference processing and tests. */
export function createPQColorMetadata(overrides: InputColorMetadataOverrides = {}): InputColorMetadata {
    const metadata: InputColorMetadata = {
        bitDepth: 10,
        matrix: 'bt2020-ncl',
        nominalPeakNits: 1_000,
        primaries: 'bt2020',
        range: 'limited',
        sdrReferenceWhiteNits: 100,
        transfer: 'pq',
        version: COLOR_METADATA_VERSION,
        ...overrides
    };
    assertValidInputColorMetadata(metadata);
    return metadata;
}

/** Creates BT.2020 HLG metadata for reference processing and tests. */
export function createHLGColorMetadata(overrides: InputColorMetadataOverrides = {}): InputColorMetadata {
    const metadata: InputColorMetadata = {
        bitDepth: 10,
        matrix: 'bt2020-ncl',
        nominalPeakNits: 1_000,
        primaries: 'bt2020',
        range: 'limited',
        sdrReferenceWhiteNits: 100,
        transfer: 'hlg',
        version: COLOR_METADATA_VERSION,
        ...overrides
    };
    assertValidInputColorMetadata(metadata);
    return metadata;
}
