import { describe, expect, it } from 'vitest';

import {
    hasAV1PQSequenceHeader,
    parseAV1StaticHDRMetadata,
    scanAV1StaticHDRMetadata
} from 'webgpu-player/video/hdr/AV1StaticHDRMetadata';
import {
    MAXIMUM_STATIC_HDR_METADATA_SCAN_ACCESS_UNIT_COUNT,
    type StaticHDRMetadata
} from 'webgpu-player/video/hdr/StaticHDRMetadata';
import { createNativeVideoCapabilityVector } from 'webgpu-player/capability/vectors/NativeVideoCapabilityVectors';

import {
    AV1_TRAILING_BITS_BYTE,
    createAV1MetadataOBU,
    createAV1OBU
} from '../../helpers/av1MetadataOBUs';
import { concatenate, createBytesFromHex } from '../../helpers/byteArrays';
import { getHDR10PlusITUTT35Messages } from '../../helpers/hdr10PlusVectors';

const OBU_TYPE_TEMPORAL_DELIMITER = 2;
const OBU_TYPE_FRAME = 6;
const METADATA_TYPE_HDR_CLL = 1;
const METADATA_TYPE_HDR_MDCV = 2;
const METADATA_TYPE_ITUT_T35 = 4;
// luminance_max is 24.8 and luminance_min 18.14 fixed point
const MAXIMUM_LUMINANCE_SCALE = 2 ** 8;
const MINIMUM_LUMINANCE_SCALE = 2 ** 14;
// BT.2020 primaries and a D65 white point in 0.16 fixed point
const BT2020_CHROMATICITIES: readonly number[] = [ 46_399, 19_137, 11_141, 52_232, 8_585, 3_015, 20_493, 21_561 ];
const MASTERING_MAXIMUM_LUMINANCE = 1_000.5 * MAXIMUM_LUMINANCE_SCALE;
const MASTERING_MINIMUM_LUMINANCE = 82;
const OTHER_MASTERING_MAXIMUM_LUMINANCE = 4_000 * MAXIMUM_LUMINANCE_SCALE;
const MAXIMUM_CONTENT_LIGHT_LEVEL = 940;
const MAXIMUM_FRAME_AVERAGE_LIGHT_LEVEL = 410;
const OTHER_MAXIMUM_CONTENT_LIGHT_LEVEL = 1_200;
// The sequence header libaom writes for the HDR10+ AV1 vector: Main, 10-bit, BT.2020 primaries and matrix, PQ transfer
const PQ_SEQUENCE_HEADER_OBU = createBytesFromHex('0a0e00000003bdfdf9b5f2a122012080');
const TEMPORAL_DELIMITER_OBU = createAV1OBU(OBU_TYPE_TEMPORAL_DELIMITER, []);
const FRAME_OBU = createAV1OBU(OBU_TYPE_FRAME, [ 0x10, 0x5A ]);
const EXPECTED_METADATA: StaticHDRMetadata = {
    masteringDisplayMaximumLuminanceNits: MASTERING_MAXIMUM_LUMINANCE / MAXIMUM_LUMINANCE_SCALE,
    masteringDisplayMinimumLuminanceNits: MASTERING_MINIMUM_LUMINANCE / MINIMUM_LUMINANCE_SCALE,
    maximumContentLightLevelNits: MAXIMUM_CONTENT_LIGHT_LEVEL,
    maximumFrameAverageLightLevelNits: MAXIMUM_FRAME_AVERAGE_LIGHT_LEVEL
};
const CONFLICTING_METADATA_ERROR = 'conflicting static HDR metadata';
const MALFORMED_MASTERING_DISPLAY_ERROR = 'mastering display metadata is malformed';
const MALFORMED_CONTENT_LIGHT_LEVEL_ERROR = 'content light level metadata is malformed';
const INVALID_METADATA_ERROR = 'invalid static HDR metadata';
const SCAN_BOUND_ERROR = 'exceeds its access-unit bound';

function writeUnsigned(value: number, byteLength: number): number[] {
    const bytes: number[] = [];
    for (let byteIndex = byteLength - 1; byteIndex >= 0; byteIndex -= 1) {
        bytes.push(Math.floor(value / (256 ** byteIndex)) % 256);
    }
    return bytes;
}

function createMasteringDisplayOBU(
    maximumLuminance = MASTERING_MAXIMUM_LUMINANCE,
    minimumLuminance = MASTERING_MINIMUM_LUMINANCE,
    trailingBits?: readonly number[]
): Uint8Array {
    return createAV1MetadataOBU(METADATA_TYPE_HDR_MDCV, [
        ...BT2020_CHROMATICITIES.flatMap((chromaticity: number): number[] => writeUnsigned(chromaticity, 2)),
        ...writeUnsigned(maximumLuminance, 4),
        ...writeUnsigned(minimumLuminance, 4)
    ], trailingBits);
}

function createContentLightLevelOBU(
    maximumContentLightLevel = MAXIMUM_CONTENT_LIGHT_LEVEL,
    maximumFrameAverageLightLevel = MAXIMUM_FRAME_AVERAGE_LIGHT_LEVEL
): Uint8Array {
    return createAV1MetadataOBU(METADATA_TYPE_HDR_CLL, [
        ...writeUnsigned(maximumContentLightLevel, 2),
        ...writeUnsigned(maximumFrameAverageLightLevel, 2)
    ]);
}

function createTemporalUnit(metadataOBUs: readonly Uint8Array[]): Uint8Array {
    return concatenate([ TEMPORAL_DELIMITER_OBU, PQ_SEQUENCE_HEADER_OBU, ...metadataOBUs, FRAME_OBU ]);
}

describe('parseAV1StaticHDRMetadata', () => {
    it('reads the mastering display luminance in 24.8 and 18.14 fixed point, and the content light levels', () => {
        const temporalUnit = createTemporalUnit([
            createMasteringDisplayOBU(),
            createContentLightLevelOBU(),
            createAV1MetadataOBU(METADATA_TYPE_ITUT_T35, getHDR10PlusITUTT35Messages('valid')[0])
        ]);

        expect(parseAV1StaticHDRMetadata(temporalUnit)).toEqual(EXPECTED_METADATA);
    });

    it('returns null for a unit without static HDR metadata', () => {
        expect(parseAV1StaticHDRMetadata(concatenate([ TEMPORAL_DELIMITER_OBU, FRAME_OBU ]))).toBeNull();
        expect(parseAV1StaticHDRMetadata(createTemporalUnit([
            createAV1MetadataOBU(METADATA_TYPE_ITUT_T35, getHDR10PlusITUTT35Messages('valid')[0])
        ]))).toBeNull();
    });

    it('reads zero content light levels as unknown', () => {
        expect(parseAV1StaticHDRMetadata(createTemporalUnit([ createContentLightLevelOBU(0, 0) ]))).toBeNull();
        expect(parseAV1StaticHDRMetadata(createTemporalUnit([
            createMasteringDisplayOBU(),
            createContentLightLevelOBU(MAXIMUM_CONTENT_LIGHT_LEVEL, 0)
        ]))).toEqual({ ...EXPECTED_METADATA, maximumFrameAverageLightLevelNits: null });
    });

    it('reads metadata whose trailing bits are padded with zero bytes', () => {
        expect(parseAV1StaticHDRMetadata(createTemporalUnit([
            createMasteringDisplayOBU(MASTERING_MAXIMUM_LUMINANCE, MASTERING_MINIMUM_LUMINANCE, [ AV1_TRAILING_BITS_BYTE, 0x00 ])
        ]))).toEqual({ ...EXPECTED_METADATA, maximumContentLightLevelNits: null, maximumFrameAverageLightLevelNits: null });
    });

    it.each([
        {
            description: 'a truncated mastering display',
            message: MALFORMED_MASTERING_DISPLAY_ERROR,
            obu: createAV1MetadataOBU(METADATA_TYPE_HDR_MDCV, new Array<number>(23).fill(1))
        },
        {
            description: 'a mastering display without trailing bits',
            message: MALFORMED_MASTERING_DISPLAY_ERROR,
            obu: createMasteringDisplayOBU(MASTERING_MAXIMUM_LUMINANCE, MASTERING_MINIMUM_LUMINANCE, [])
        },
        {
            description: 'content light levels with extra data',
            message: MALFORMED_CONTENT_LIGHT_LEVEL_ERROR,
            obu: createAV1MetadataOBU(METADATA_TYPE_HDR_CLL, [ 0x03, 0xAC, 0x01, 0x9A, 0x01 ])
        },
        {
            description: 'a mastering display without a maximum luminance',
            message: INVALID_METADATA_ERROR,
            obu: createMasteringDisplayOBU(0, 0)
        },
        {
            description: 'a minimum luminance above the maximum',
            message: INVALID_METADATA_ERROR,
            obu: createMasteringDisplayOBU(MAXIMUM_LUMINANCE_SCALE, 2 * MINIMUM_LUMINANCE_SCALE)
        }
    ])('rejects $description as a TypeError', ({ message, obu }) => {
        expect(() => parseAV1StaticHDRMetadata(createTemporalUnit([ obu ]))).toThrow(TypeError);
        expect(() => parseAV1StaticHDRMetadata(createTemporalUnit([ obu ]))).toThrow(message);
    });

    it('rejects conflicting values within one unit and a unit whose OBUs cannot be walked', () => {
        expect(() => parseAV1StaticHDRMetadata(createTemporalUnit([
            createMasteringDisplayOBU(),
            createMasteringDisplayOBU(OTHER_MASTERING_MAXIMUM_LUMINANCE)
        ]))).toThrow(CONFLICTING_METADATA_ERROR);
        // An obu_size that runs past the unit
        expect(() => parseAV1StaticHDRMetadata(new Uint8Array([ 0x2A, 0x09, METADATA_TYPE_HDR_CLL ]))).toThrow(TypeError);
    });
});

describe('scanAV1StaticHDRMetadata', () => {
    const plainUnit = createTemporalUnit([]);

    it('accepts consistent metadata that first appears after the first unit', () => {
        const metadataUnit = createTemporalUnit([ createMasteringDisplayOBU(), createContentLightLevelOBU() ]);

        expect(scanAV1StaticHDRMetadata([ plainUnit, metadataUnit, metadataUnit ])).toEqual({
            accessUnitCount: 3,
            firstMetadataAccessUnitIndex: 1,
            metadata: EXPECTED_METADATA,
            status: 'valid'
        });
    });

    it('merges a mastering display and content light levels from different units', () => {
        expect(scanAV1StaticHDRMetadata([
            createTemporalUnit([ createMasteringDisplayOBU() ]),
            createTemporalUnit([ createContentLightLevelOBU() ])
        ])).toMatchObject({ firstMetadataAccessUnitIndex: 0, metadata: EXPECTED_METADATA, status: 'valid' });
    });

    it('discards every value when units conflict or a later unit is malformed', () => {
        const metadataUnit = createTemporalUnit([ createMasteringDisplayOBU(), createContentLightLevelOBU() ]);

        expect(scanAV1StaticHDRMetadata([
            metadataUnit,
            createTemporalUnit([ createContentLightLevelOBU(OTHER_MAXIMUM_CONTENT_LIGHT_LEVEL) ])
        ])).toEqual({ accessUnitCount: 2, firstMetadataAccessUnitIndex: null, metadata: null, status: 'conflicting' });
        expect(scanAV1StaticHDRMetadata([
            metadataUnit,
            createTemporalUnit([ createMasteringDisplayOBU(MASTERING_MAXIMUM_LUMINANCE, MASTERING_MINIMUM_LUMINANCE, []) ])
        ])).toEqual({ accessUnitCount: 2, firstMetadataAccessUnitIndex: null, metadata: null, status: 'malformed' });
        expect(scanAV1StaticHDRMetadata([ metadataUnit, new Uint8Array([ 0x2A, 0x09 ]) ])).toMatchObject({
            status: 'malformed'
        });
    });

    it('reports a bounded absent result and rejects prefixes above the shared bound', () => {
        expect(scanAV1StaticHDRMetadata([ plainUnit ])).toEqual({
            accessUnitCount: 1,
            firstMetadataAccessUnitIndex: null,
            metadata: null,
            status: 'absent'
        });
        expect(() => scanAV1StaticHDRMetadata(
            new Array<Uint8Array>(MAXIMUM_STATIC_HDR_METADATA_SCAN_ACCESS_UNIT_COUNT + 1).fill(plainUnit)
        )).toThrow(SCAN_BOUND_ERROR);
    });
});

describe('hasAV1PQSequenceHeader', () => {
    it('reads the transfer of a unit\'s sequence header', () => {
        expect(hasAV1PQSequenceHeader(createTemporalUnit([]))).toBe(true);
        // The capability keyframe's sequence header has no color description
        expect(hasAV1PQSequenceHeader(createNativeVideoCapabilityVector('av1').encodedKeyFrame)).toBe(false);
    });

    it('finds no PQ in a unit without a sequence header or one that cannot be walked', () => {
        expect(hasAV1PQSequenceHeader(concatenate([ TEMPORAL_DELIMITER_OBU, FRAME_OBU ]))).toBe(false);
        expect(hasAV1PQSequenceHeader(new Uint8Array([ 0x0A, 0x09 ]))).toBe(false);
    });
});
