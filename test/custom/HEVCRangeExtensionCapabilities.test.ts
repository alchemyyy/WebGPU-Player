import { ENGINE_ROOT } from '../helpers/enginePaths';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    definitionMatchesHEVCRangeExtensionStream,
    getHEVCRangeExtensionStreamDefinition,
    getHEVCRangeExtensionStreamDefinitionFromMetadata,
    HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS,
    HEVC_RANGE_EXTENSION_VARIANTS,
    type HEVCRangeExtensionVariant
} from 'webgpu-player/custom/HEVCRangeExtensionCapabilities';

type ExpectedVariant = Readonly<{
    bitDepth: 8 | 10 | 12
    chromaFormat: '420' | '422' | '444'
    codecConstraintSuffix: string
    format: string
    generalInter: boolean
    jellyfinProfile: string
    pixelFormat: string
}>;

const EXPECTED_VARIANTS: Readonly<Record<HEVCRangeExtensionVariant, ExpectedVariant>> = {
    'rext420-8': {
        bitDepth: 8,
        chromaFormat: '420',
        codecConstraintSuffix: '9F.88',
        format: 'I420',
        generalInter: true,
        jellyfinProfile: 'Rext',
        pixelFormat: 'yuv420p'
    },
    'main422-8': {
        bitDepth: 8,
        chromaFormat: '422',
        codecConstraintSuffix: '9D.08',
        format: 'I422',
        generalInter: true,
        jellyfinProfile: 'Main 4:2:2 10',
        pixelFormat: 'yuv422p'
    },
    'main444-8': {
        bitDepth: 8,
        chromaFormat: '444',
        codecConstraintSuffix: '9E.08',
        format: 'I444',
        generalInter: true,
        jellyfinProfile: 'Main 4:4:4',
        pixelFormat: 'yuv444p'
    },
    'rext420-10': {
        bitDepth: 10,
        chromaFormat: '420',
        codecConstraintSuffix: '9D.88',
        format: 'I420P10',
        generalInter: true,
        jellyfinProfile: 'Rext',
        pixelFormat: 'yuv420p10le'
    },
    'main422-10': {
        bitDepth: 10,
        chromaFormat: '422',
        codecConstraintSuffix: '9D.08',
        format: 'I422P10',
        generalInter: true,
        jellyfinProfile: 'Main 4:2:2 10',
        pixelFormat: 'yuv422p10le'
    },
    'main444-10': {
        bitDepth: 10,
        chromaFormat: '444',
        codecConstraintSuffix: '9C.08',
        format: 'I444P10',
        generalInter: true,
        jellyfinProfile: 'Main 4:4:4 10',
        pixelFormat: 'yuv444p10le'
    },
    'main12-420': {
        bitDepth: 12,
        chromaFormat: '420',
        codecConstraintSuffix: '99.88',
        format: 'I420P12',
        generalInter: true,
        jellyfinProfile: 'Main 12',
        pixelFormat: 'yuv420p12le'
    },
    'main422-12': {
        bitDepth: 12,
        chromaFormat: '422',
        codecConstraintSuffix: '99.08',
        format: 'I422P12',
        generalInter: true,
        jellyfinProfile: 'Main 4:2:2 12',
        pixelFormat: 'yuv422p12le'
    },
    'main444-12': {
        bitDepth: 12,
        chromaFormat: '444',
        codecConstraintSuffix: '98.08',
        format: 'I444P12',
        generalInter: true,
        jellyfinProfile: 'Main 4:4:4 12',
        pixelFormat: 'yuv444p12le'
    }
};

function getStartCodeLength(bytes: Uint8Array, byteIndex: number): 0 | 3 | 4 {
    if (bytes[byteIndex] !== 0 || bytes[byteIndex + 1] !== 0) {
        return 0;
    }
    if (bytes[byteIndex + 2] === 1) {
        return 3;
    }
    return bytes[byteIndex + 2] === 0 && bytes[byteIndex + 3] === 1 ? 4 : 0;
}

function findStartCode(bytes: Uint8Array, offset: number): number {
    for (let byteIndex = offset; byteIndex <= bytes.length - 3; byteIndex += 1) {
        if (getStartCodeLength(bytes, byteIndex) > 0) {
            return byteIndex;
        }
    }
    return -1;
}

function readVPSRawByteSequencePayload(bytes: Uint8Array): Uint8Array {
    const startCodeIndex = findStartCode(bytes, 0);
    if (startCodeIndex < 0) {
        throw new Error('Fixture does not start with an HEVC access unit');
    }
    const networkAbstractionLayerHeaderIndex = startCodeIndex
        + getStartCodeLength(bytes, startCodeIndex);
    const networkAbstractionLayerType = (
        bytes[networkAbstractionLayerHeaderIndex] >> 1
    ) & 0x3f;
    if (networkAbstractionLayerType !== 32) {
        throw new Error('Fixture does not start with an HEVC VPS');
    }
    const payloadStartIndex = networkAbstractionLayerHeaderIndex + 2;
    const nextStartCodeIndex = findStartCode(bytes, payloadStartIndex);
    const payloadEndIndex = nextStartCodeIndex < 0 ? bytes.length : nextStartCodeIndex;
    const rawByteSequencePayload: number[] = [];
    for (let byteIndex = payloadStartIndex; byteIndex < payloadEndIndex; byteIndex += 1) {
        if (bytes[byteIndex] === 3
            && rawByteSequencePayload.at(-1) === 0
            && rawByteSequencePayload.at(-2) === 0) {
            continue;
        }
        rawByteSequencePayload.push(bytes[byteIndex]);
    }
    return Uint8Array.from(rawByteSequencePayload);
}

function getEmbeddedCodecConstraintSuffix(bytes: Uint8Array): string {
    const VPSPayload = readVPSRawByteSequencePayload(bytes);
    if (VPSPayload.length < 16 || (VPSPayload[4] & 0x1f) !== 4 || VPSPayload[15] !== 93) {
        throw new Error('Fixture VPS does not contain the expected Rext profile and level');
    }
    return [ VPSPayload[9], VPSPayload[10] ]
        .map((value: number): string => value.toString(16).padStart(2, '0').toUpperCase())
        .join('.');
}

function readSPSRawByteSequencePayload(bytes: Uint8Array): Uint8Array {
    const nalUnits = getAnnexBNALUnits(bytes);
    const SPS = nalUnits.find((nalUnit: AnnexBNALUnit): boolean => (
        ((bytes[nalUnit.headerIndex] >> 1) & 0x3f) === 33
    ));
    if (!SPS) {
        throw new Error('Fixture does not contain an HEVC SPS');
    }
    const rawByteSequencePayload: number[] = [];
    for (let byteIndex = SPS.headerIndex + 2; byteIndex < SPS.endIndex; byteIndex += 1) {
        if (bytes[byteIndex] === 3
            && rawByteSequencePayload.at(-1) === 0
            && rawByteSequencePayload.at(-2) === 0) {
            continue;
        }
        rawByteSequencePayload.push(bytes[byteIndex]);
    }
    return Uint8Array.from(rawByteSequencePayload);
}

type AnnexBNALUnit = Readonly<{
    endIndex: number
    headerIndex: number
}>;

function getAnnexBNALUnits(bytes: Uint8Array): AnnexBNALUnit[] {
    const startCodeIndexes: number[] = [];
    let searchOffset = 0;
    while (searchOffset <= bytes.length - 4) {
        const startCodeIndex = findStartCode(bytes, searchOffset);
        if (startCodeIndex < 0) {
            break;
        }
        startCodeIndexes.push(startCodeIndex);
        searchOffset = startCodeIndex + getStartCodeLength(bytes, startCodeIndex);
    }

    const networkAbstractionLayerUnits: AnnexBNALUnit[] = [];
    for (let startCodeOffset = 0; startCodeOffset < startCodeIndexes.length; startCodeOffset += 1) {
        const startCodeIndex = startCodeIndexes[startCodeOffset];
        networkAbstractionLayerUnits.push({
            endIndex: startCodeIndexes[startCodeOffset + 1] ?? bytes.length,
            headerIndex: startCodeIndex + getStartCodeLength(bytes, startCodeIndex)
        });
    }
    return networkAbstractionLayerUnits;
}

class RawBitReader {
    public bitIndex = 0;

    public constructor(private readonly bytes: Uint8Array) {}

    public readBit(): number {
        if (this.bitIndex >= this.bytes.length * 8) {
            throw new Error('HEVC fixture bitstream ended unexpectedly');
        }
        const byteIndex = Math.floor(this.bitIndex / 8);
        const bitInByte = 7 - (this.bitIndex % 8);
        this.bitIndex += 1;
        return (this.bytes[byteIndex] >> bitInByte) & 1;
    }

    public readBits(bitCount: number): number {
        let value = 0;
        for (let bitOffset = 0; bitOffset < bitCount; bitOffset += 1) {
            value = (value << 1) | this.readBit();
        }
        return value;
    }

    public readUnsignedExpGolomb(): number {
        let leadingZeroCount = 0;
        while (this.readBit() === 0) {
            leadingZeroCount += 1;
            if (leadingZeroCount > 30) {
                throw new Error('HEVC fixture Exp-Golomb value is too large');
            }
        }
        const suffix = this.readBits(leadingZeroCount);
        return (2 ** leadingZeroCount) - 1 + suffix;
    }
}

function getNALRawByteSequencePayload(
    bytes: Uint8Array,
    networkAbstractionLayerUnit: AnnexBNALUnit
): Uint8Array {
    const rawByteSequencePayload: number[] = [];
    for (
        let byteIndex = networkAbstractionLayerUnit.headerIndex + 2;
        byteIndex < networkAbstractionLayerUnit.endIndex;
        byteIndex += 1
    ) {
        if (bytes[byteIndex] === 3
            && rawByteSequencePayload.at(-1) === 0
            && rawByteSequencePayload.at(-2) === 0) {
            continue;
        }
        rawByteSequencePayload.push(bytes[byteIndex]);
    }
    return Uint8Array.from(rawByteSequencePayload);
}

function getFixtureSliceTypes(bytes: Uint8Array): number[] {
    const networkAbstractionLayerUnits = getAnnexBNALUnits(bytes);
    const extraSliceHeaderBitsByPictureParameterSet = new Map<number, number>();
    for (const networkAbstractionLayerUnit of networkAbstractionLayerUnits) {
        const networkAbstractionLayerType = (
            bytes[networkAbstractionLayerUnit.headerIndex] >> 1
        ) & 0x3F;
        if (networkAbstractionLayerType !== 34) {
            continue;
        }
        const bitReader = new RawBitReader(getNALRawByteSequencePayload(
            bytes,
            networkAbstractionLayerUnit
        ));
        const pictureParameterSetID = bitReader.readUnsignedExpGolomb();
        bitReader.readUnsignedExpGolomb();
        bitReader.readBit();
        bitReader.readBit();
        extraSliceHeaderBitsByPictureParameterSet.set(
            pictureParameterSetID,
            bitReader.readBits(3)
        );
    }

    const sliceTypes: number[] = [];
    for (const networkAbstractionLayerUnit of networkAbstractionLayerUnits) {
        const networkAbstractionLayerType = (
            bytes[networkAbstractionLayerUnit.headerIndex] >> 1
        ) & 0x3F;
        if (networkAbstractionLayerType > 31) {
            continue;
        }
        const bitReader = new RawBitReader(getNALRawByteSequencePayload(
            bytes,
            networkAbstractionLayerUnit
        ));
        const firstSliceSegmentInPicture = bitReader.readBit() === 1;
        if (!firstSliceSegmentInPicture) {
            throw new Error('HEVC fixture must use one first slice per access unit');
        }
        if (networkAbstractionLayerType >= 16 && networkAbstractionLayerType <= 23) {
            bitReader.readBit();
        }
        const pictureParameterSetID = bitReader.readUnsignedExpGolomb();
        const extraSliceHeaderBitCount = extraSliceHeaderBitsByPictureParameterSet.get(
            pictureParameterSetID
        );
        if (extraSliceHeaderBitCount === undefined) {
            throw new Error('HEVC fixture slice references an unknown PPS');
        }
        bitReader.readBits(extraSliceHeaderBitCount);
        sliceTypes.push(bitReader.readUnsignedExpGolomb());
    }
    return sliceTypes;
}

describe('HEVCRangeExtensionCapabilities', () => {
    it('defines the exact nine-format generic Rext envelope', () => {
        expect(HEVC_RANGE_EXTENSION_VARIANTS).toEqual([
            'rext420-8',
            'main422-8',
            'main444-8',
            'rext420-10',
            'main422-10',
            'main444-10',
            'main12-420',
            'main422-12',
            'main444-12'
        ]);

        for (const variant of HEVC_RANGE_EXTENSION_VARIANTS) {
            const definition = HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant];
            const expected = EXPECTED_VARIANTS[variant];
            expect(definition).toMatchObject({
                bitDepth: expected.bitDepth,
                chromaFormat: expected.chromaFormat,
                format: expected.format,
                jellyfinProfile: expected.jellyfinProfile,
                pixelFormat: expected.pixelFormat,
                variant
            });
            expect(definition.config).toMatchObject({
                codec: `hvc1.4.10.L93.${expected.codecConstraintSuffix}`,
                codedHeight: 192,
                codedWidth: 192,
                hardwareAcceleration: 'no-preference'
            });
        }
    });

    it('pins every fixture hash and codec string to its embedded VPS constraints', () => {
        for (const variant of HEVC_RANGE_EXTENSION_VARIANTS) {
            const definition = HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant];
            const expected = EXPECTED_VARIANTS[variant];
            const fixturePath = resolve(
                ENGINE_ROOT,
                'fixtures/capability/hevc-range-extension',
                `${variant}.hevc`
            );
            const fixtureBytes = new Uint8Array(readFileSync(fixturePath));
            const fixtureSHA256 = createHash('sha256').update(fixtureBytes).digest('hex');

            expect(fixtureSHA256).toBe(definition.fixtureSHA256);
            expect(definition.config.codec).toBe(
                `hvc1.4.10.L93.${getEmbeddedCodecConstraintSuffix(fixtureBytes)}`
            );
            expect(definition.accessUnits.reduce(
                (totalByteLength: number, accessUnit): number => (
                    totalByteLength + accessUnit.byteLength
                ),
                0
            )).toBe(fixtureBytes.byteLength);
            expect(definition.accessUnits.map(accessUnit => accessUnit.type)).toEqual(
                expected.generalInter ? [ 'key', 'delta' ] : [ 'key' ]
            );
            expect(definition.accessUnits.map(accessUnit => accessUnit.timestamp)).toEqual(
                expected.generalInter ? [ 0, 1_000_000 ] : [ 0 ]
            );

            const VPSPayload = readVPSRawByteSequencePayload(fixtureBytes);
            const SPSPayload = readSPSRawByteSequencePayload(fixtureBytes);
            expect(Array.from(VPSPayload.slice(5, 9))).toEqual([ 8, 0, 0, 0 ]);
            expect(Array.from(SPSPayload.slice(2, 6))).toEqual([ 8, 0, 0, 0 ]);
            expect(SPSPayload[1] & 0x1f).toBe(4);
            expect([ SPSPayload[6], SPSPayload[7] ]).toEqual([
                VPSPayload[9],
                VPSPayload[10]
            ]);
            const intraConstraintFlag = (VPSPayload[10] & 0x20) !== 0;
            const onePictureOnlyConstraintFlag = (VPSPayload[10] & 0x10) !== 0;
            expect(intraConstraintFlag).toBe(!expected.generalInter);
            expect(onePictureOnlyConstraintFlag).toBe(false);
            const sliceTypes = getFixtureSliceTypes(fixtureBytes);
            expect(sliceTypes).toHaveLength(definition.accessUnits.length);
            if (expected.generalInter) {
                expect(sliceTypes).toEqual([ 2, 1 ]);
            } else {
                expect(sliceTypes).toEqual([ 2 ]);
            }
        }
    });

    it.each(HEVC_RANGE_EXTENSION_VARIANTS)(
        'matches generic Rext and its exact named alias for %s',
        variant => {
            const definition = HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant];

            expect(definitionMatchesHEVCRangeExtensionStream(
                definition,
                'Rext',
                definition.pixelFormat,
                definition.bitDepth
            )).toBe(true);
            expect(definitionMatchesHEVCRangeExtensionStream(
                definition,
                definition.jellyfinProfile,
                definition.pixelFormat,
                definition.bitDepth
            )).toBe(true);
            expect(definitionMatchesHEVCRangeExtensionStream(
                definition,
                'Rext',
                definition.pixelFormat,
                null
            )).toBe(true);
        }
    );

    it('infers omitted bit depth only from an exact Rext pixel format', () => {
        expect(getHEVCRangeExtensionStreamDefinition(
            'Rext',
            'yuv422p12le',
            null
        )?.variant).toBe('main422-12');
        expect(getHEVCRangeExtensionStreamDefinition(
            'Rext',
            'yuv422p12le',
            10
        )).toBeNull();
        expect(getHEVCRangeExtensionStreamDefinition(
            'Rext',
            'yuv422p14le',
            null
        )).toBeNull();
    });

    it.each([ null, undefined, Number.NaN, '' ])(
        'treats omitted or non-finite BitDepth %s as inferable',
        bitDepth => {
            expect(getHEVCRangeExtensionStreamDefinitionFromMetadata({
                BitDepth: bitDepth,
                PixelFormat: 'yuv422p12le',
                Profile: 'Rext'
            })?.variant).toBe('main422-12');
        }
    );

    it('rejects a finite numeric BitDepth that contradicts PixelFormat', () => {
        expect(getHEVCRangeExtensionStreamDefinitionFromMetadata({
            BitDepth: 10,
            PixelFormat: 'yuv422p12le',
            Profile: 'Rext'
        })).toBeNull();
    });

    it.each([
        'Main 4:2:2 10 Intra',
        'Main 4:4:4 Still Picture',
        'Screen-Extended Main 4:4:4',
        'High Throughput 4:4:4'
    ])('rejects unsupported extension profile family %s', profile => {
        expect(getHEVCRangeExtensionStreamDefinition(
            profile,
            'yuv444p10le',
            10
        )).toBeNull();
    });
});
