import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../helpers/enginePaths';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    H264_RAW_FORMAT_PROBE_DEFINITIONS,
    H264_RAW_FORMAT_PROFILES,
    H264_RAW_FORMAT_VARIANTS,
    getH264RawFormatProfile,
    getH264RawFormatProfileVariants,
    getH264RawFormatStreamDefinition,
    getH264RawFormatStreamDefinitionFromMetadata,
    type H264RawFormatVariant
} from 'webgpu-player/capability/H264RawFormatCapabilities';
import { splitAnnexBNALUnits } from 'webgpu-player/demux/NALUnitFraming';
import { readVideoChromaFormat } from 'webgpu-player/demux/VideoChromaFormat';

type ExpectedVariant = Readonly<{
    bitDepth: 8 | 10
    chromaFormat: '420' | '422' | '444'
    chromaFormatIDC: 1 | 2 | 3
    codecString: string
    format: string
    jellyfinProfile: string
    pixelFormat: string
    profileIDC: number
    subsampling: '4:2:0' | '4:2:2' | '4:4:4'
}>;

const EXPECTED_VARIANTS: Readonly<Record<H264RawFormatVariant, ExpectedVariant>> = {
    'high420-10': {
        bitDepth: 10,
        chromaFormat: '420',
        chromaFormatIDC: 1,
        codecString: 'avc1.6E000B',
        format: 'I420P10',
        jellyfinProfile: 'High 10',
        pixelFormat: 'yuv420p10le',
        profileIDC: 110,
        subsampling: '4:2:0'
    },
    'high422-8': {
        bitDepth: 8,
        chromaFormat: '422',
        chromaFormatIDC: 2,
        codecString: 'avc1.7A000B',
        format: 'I422',
        jellyfinProfile: 'High 4:2:2',
        pixelFormat: 'yuv422p',
        profileIDC: 122,
        subsampling: '4:2:2'
    },
    'high422-10': {
        bitDepth: 10,
        chromaFormat: '422',
        chromaFormatIDC: 2,
        codecString: 'avc1.7A000B',
        format: 'I422P10',
        jellyfinProfile: 'High 4:2:2',
        pixelFormat: 'yuv422p10le',
        profileIDC: 122,
        subsampling: '4:2:2'
    },
    'high444-8': {
        bitDepth: 8,
        chromaFormat: '444',
        chromaFormatIDC: 3,
        codecString: 'avc1.F4000B',
        format: 'I444',
        jellyfinProfile: 'High 4:4:4 Predictive',
        pixelFormat: 'yuv444p',
        profileIDC: 244,
        subsampling: '4:4:4'
    },
    'high444-10': {
        bitDepth: 10,
        chromaFormat: '444',
        chromaFormatIDC: 3,
        codecString: 'avc1.F4000B',
        format: 'I444P10',
        jellyfinProfile: 'High 4:4:4 Predictive',
        pixelFormat: 'yuv444p10le',
        profileIDC: 244,
        subsampling: '4:4:4'
    }
};

// H.264 NAL unit types: a non-IDR slice, an IDR slice, an SEI, an SPS, and a PPS
const CODED_SLICE_NAL_UNIT_TYPE = 1;
const IDR_SLICE_NAL_UNIT_TYPE = 5;
const SPS_NAL_UNIT_TYPE = 7;
const PPS_NAL_UNIT_TYPE = 8;
// slice_type modulo 5
const SLICE_TYPE_NAMES = [ 'P', 'B', 'I', 'SP', 'SI' ] as const;

/** Reads the fields of an RBSP, most significant bit first, past the NAL unit header. */
class RBSPBitReader {
    private bitIndex = 0;
    private readonly bytes: Uint8Array;

    public constructor(nalUnit: Uint8Array) {
        const bytes: number[] = [];
        let zeroCount = 0;
        for (const byte of nalUnit.subarray(1)) {
            // An emulation-prevention byte follows two zero bytes
            if (zeroCount >= 2 && byte === 3) {
                zeroCount = 0;
                continue;
            }
            bytes.push(byte);
            zeroCount = byte === 0 ? zeroCount + 1 : 0;
        }
        this.bytes = new Uint8Array(bytes);
    }

    public readBits(bitCount: number): number {
        let value = 0;
        for (let bit = 0; bit < bitCount; bit += 1) {
            const byteIndex = this.bitIndex >> 3;
            if (byteIndex >= this.bytes.byteLength) {
                throw new RangeError('The RBSP ended');
            }
            const byte = this.bytes[byteIndex];
            value = (value * 2) + ((byte >> (7 - (this.bitIndex & 7))) & 1);
            this.bitIndex += 1;
        }
        return value;
    }

    public readUnsignedExpGolomb(): number {
        let leadingZeroCount = 0;
        while (this.readBits(1) === 0) {
            leadingZeroCount += 1;
        }
        return this.readBits(leadingZeroCount) + (2 ** leadingZeroCount) - 1;
    }
}

function getNALUnitType(nalUnit: Uint8Array): number {
    return nalUnit[0] & 0x1F;
}

function readVector(variant: H264RawFormatVariant): Uint8Array {
    return new Uint8Array(readFileSync(resolve(CODEC_VECTOR_ASSETS_DIRECTORY, 'h264-raw-format', `${variant}.h264`)));
}

function splitAccessUnits(variant: H264RawFormatVariant): Uint8Array[] {
    const vectorBytes = readVector(variant);
    const accessUnits: Uint8Array[] = [];
    let byteOffset = 0;
    for (const accessUnit of H264_RAW_FORMAT_PROBE_DEFINITIONS[variant].accessUnits) {
        accessUnits.push(vectorBytes.subarray(byteOffset, byteOffset + accessUnit.byteLength));
        byteOffset += accessUnit.byteLength;
    }
    expect(byteOffset).toBe(vectorBytes.byteLength);
    return accessUnits;
}

describe('H264RawFormatCapabilities', () => {
    it('defines the five raw formats beyond 8-bit 4:2:0', () => {
        expect(H264_RAW_FORMAT_VARIANTS).toEqual([ 'high420-10', 'high422-8', 'high422-10', 'high444-8', 'high444-10' ]);
        expect(Object.isFrozen(H264_RAW_FORMAT_PROBE_DEFINITIONS)).toBe(true);

        for (const variant of H264_RAW_FORMAT_VARIANTS) {
            const definition = H264_RAW_FORMAT_PROBE_DEFINITIONS[variant];
            const expected = EXPECTED_VARIANTS[variant];
            expect(definition).toMatchObject({
                assetPath: `webgpu-player/h264-raw/${variant}.bin`,
                bitDepth: expected.bitDepth,
                chromaFormat: expected.chromaFormat,
                format: expected.format,
                jellyfinProfile: expected.jellyfinProfile,
                pixelFormat: expected.pixelFormat,
                variant
            });
            // Chromium reports these profiles unsupported with prefer-hardware
            expect(definition.config).toEqual({
                codec: expected.codecString,
                codedHeight: 192,
                codedWidth: 192,
                hardwareAcceleration: 'prefer-software',
                optimizeForLatency: true
            });
            expect(Object.isFrozen(definition)).toBe(true);
            expect(Object.isFrozen(definition.accessUnits)).toBe(true);
        }
    });

    it.each(H264_RAW_FORMAT_VARIANTS)('matches the committed %s vector: an I, a P, then a B access unit presented between them', variant => {
        const definition = H264_RAW_FORMAT_PROBE_DEFINITIONS[variant];
        const expected = EXPECTED_VARIANTS[variant];
        const accessUnits = splitAccessUnits(variant);

        expect(definition.accessUnits.map(accessUnit => accessUnit.type)).toEqual([ 'key', 'delta', 'delta' ]);
        // Decode order stamped with presentation times: the B access unit presents before the P it follows
        expect(definition.accessUnits.map(accessUnit => accessUnit.timestamp)).toEqual([ 0, 2_000_000, 1_000_000 ]);

        const nalUnitsByAccessUnit = accessUnits.map(accessUnit => splitAnnexBNALUnits(accessUnit, 'H.264 access unit'));
        expect(nalUnitsByAccessUnit.map(nalUnits => nalUnits.map(getNALUnitType))).toEqual([
            [ SPS_NAL_UNIT_TYPE, PPS_NAL_UNIT_TYPE, IDR_SLICE_NAL_UNIT_TYPE ],
            [ CODED_SLICE_NAL_UNIT_TYPE ],
            [ CODED_SLICE_NAL_UNIT_TYPE ]
        ]);
        const sliceTypes = nalUnitsByAccessUnit.map((nalUnits) => {
            const reader = new RBSPBitReader(nalUnits[nalUnits.length - 1]);
            // first_mb_in_slice, then slice_type
            reader.readUnsignedExpGolomb();
            return SLICE_TYPE_NAMES[reader.readUnsignedExpGolomb() % SLICE_TYPE_NAMES.length];
        });
        expect(sliceTypes).toEqual([ 'I', 'P', 'B' ]);

        // profile_idc, the constraint flags, and level_idc, then seq_parameter_set_id, chroma_format_idc, and both bit depths
        const reader = new RBSPBitReader(nalUnitsByAccessUnit[0][0]);
        const profileIDC = reader.readBits(8);
        const constraintFlags = reader.readBits(8);
        const levelIDC = reader.readBits(8);
        reader.readUnsignedExpGolomb();
        const chromaFormatIDC = reader.readUnsignedExpGolomb();
        if (chromaFormatIDC === 3) {
            // separate_colour_plane_flag
            reader.readBits(1);
        }
        const bitDepthLuma = 8 + reader.readUnsignedExpGolomb();
        const bitDepthChroma = 8 + reader.readUnsignedExpGolomb();
        expect({ bitDepthChroma, bitDepthLuma, chromaFormatIDC, profileIDC }).toEqual({
            bitDepthChroma: expected.bitDepth,
            bitDepthLuma: expected.bitDepth,
            chromaFormatIDC: expected.chromaFormatIDC,
            profileIDC: expected.profileIDC
        });
        // The codec string is the SPS's profile, constraint flags, and level
        const hex = (value: number): string => value.toString(16).toUpperCase().padStart(2, '0');
        expect(`avc1.${hex(profileIDC)}${hex(constraintFlags)}${hex(levelIDC)}`).toBe(expected.codecString);
        // The engine's own chroma reader agrees, from the key access unit alone
        expect(readVideoChromaFormat(definition.config, accessUnits[0]).subsampling).toBe(expected.subsampling);
    });

    it.each(H264_RAW_FORMAT_VARIANTS)('matches %s by its profile, pixel format, and depth', variant => {
        const definition = H264_RAW_FORMAT_PROBE_DEFINITIONS[variant];

        expect(getH264RawFormatStreamDefinition(definition.jellyfinProfile, definition.pixelFormat, definition.bitDepth))
            .toBe(definition);
        // Jellyfin can omit BitDepth when FFprobe exposes only PixelFormat
        expect(getH264RawFormatStreamDefinition(definition.jellyfinProfile, definition.pixelFormat, null))
            .toBe(definition);
        expect(getH264RawFormatStreamDefinitionFromMetadata({
            BitDepth: definition.bitDepth,
            PixelFormat: definition.pixelFormat,
            Profile: definition.jellyfinProfile
        })).toBe(definition);
    });

    it.each([
        // The intra profiles and the removed High 4:4:4 decode with the same decoder, as the variant of their format
        [ 'High 10', 'yuv420p10le', 'high420-10' ],
        [ 'High 10 Intra', 'yuv420p10le', 'high420-10' ],
        [ 'High 4:2:2', 'yuv420p10le', 'high420-10' ],
        [ 'High 4:2:2 Intra', 'yuv422p10le', 'high422-10' ],
        [ 'High 4:2:2 Intra', 'yuv422p', 'high422-8' ],
        [ 'High 4:4:4', 'yuv444p', 'high444-8' ],
        [ 'High 4:4:4 Predictive', 'yuv422p10le', 'high422-10' ],
        [ 'High 4:4:4 Predictive', 'yuv420p10le', 'high420-10' ],
        [ 'High 4:4:4 Intra', 'yuv444p10le', 'high444-10' ],
        [ 'CAVLC 4:4:4', 'yuv444p', 'high444-8' ],
        // Case, spacing, and punctuation do not matter
        [ 'high 4:2:2', 'yuv422p', 'high422-8' ],
        [ ' HIGH10 ', 'yuv420p10le', 'high420-10' ],
        [ 'high-4-4-4-predictive', 'YUV444P10LE', 'high444-10' ],
        // FFmpeg names a full-range 8-bit picture with its yuvj format
        [ 'High 4:2:2', 'yuvj422p', 'high422-8' ],
        [ 'High 4:4:4 Predictive', 'yuvj444p', 'high444-8' ]
    ])('accepts profile %j with %s as %s', (profile, pixelFormat, variant) => {
        expect(getH264RawFormatStreamDefinition(profile, pixelFormat, null)?.variant).toBe(variant);
    });

    it.each([
        // 8-bit 4:2:0 keeps the native route at High and below, and no variant takes it under a profile beyond High
        [ 'High', 'yuv420p' ],
        [ 'Main', 'yuv420p' ],
        [ 'High 10', 'yuv420p' ],
        [ 'High 4:4:4 Predictive', 'yuv420p' ],
        [ 'High 4:4:4 Predictive', 'yuvj420p' ],
        // High codes only 8-bit 4:2:0
        [ 'High', 'yuv420p10le' ],
        [ 'High', 'yuv422p' ],
        // Each profile codes only its own chroma formats
        [ 'High 10', 'yuv422p10le' ],
        [ 'High 10', 'yuv444p' ],
        [ 'High 4:2:2', 'yuv444p10le' ],
        // Depths past 10 bits, 4:0:0, RGB, and pixel formats outside the table
        [ 'High 4:4:4 Predictive', 'yuv444p12le' ],
        [ 'High 4:4:4 Predictive', 'yuv420p14le' ],
        [ 'High 10', 'gray10le' ],
        [ 'High 4:4:4 Predictive', 'gbrp' ],
        [ 'High 4:4:4 Predictive', 'gbrp10le' ],
        [ 'High 4:2:2', 'yuv422p10' ],
        [ 'High 4:2:2', '' ]
    ])('rejects profile %s with pixel format %j', (profile, pixelFormat) => {
        expect(getH264RawFormatStreamDefinition(profile, pixelFormat, null)).toBeNull();
    });

    it.each([ 'Baseline', 'Constrained Baseline', 'Extended', 'Multiview High', 'Stereo High', 'Rext', '', null, undefined ])(
        'rejects the profile %j',
        profile => {
            expect(getH264RawFormatStreamDefinition(profile, 'yuv422p', 8)).toBeNull();
        }
    );

    it('rejects a BitDepth that disagrees with PixelFormat', () => {
        expect(getH264RawFormatStreamDefinition('High 4:2:2', 'yuv422p10le', 8)).toBeNull();
        expect(getH264RawFormatStreamDefinitionFromMetadata({
            BitDepth: '8',
            PixelFormat: 'yuv444p10le',
            Profile: 'High 4:4:4 Predictive'
        })).toBeNull();
    });

    it.each([ null, undefined, Number.NaN, '', '10' ])('reads BitDepth %j as omitted or agreeing', bitDepth => {
        expect(getH264RawFormatStreamDefinitionFromMetadata({
            BitDepth: bitDepth,
            PixelFormat: 'yuv422p10le',
            Profile: 'High 4:2:2'
        })?.variant).toBe('high422-10');
    });

    it('returns null for malformed metadata', () => {
        expect(getH264RawFormatStreamDefinitionFromMetadata(null)).toBeNull();
        expect(getH264RawFormatStreamDefinitionFromMetadata('High 10')).toBeNull();
        expect(getH264RawFormatStreamDefinitionFromMetadata({ PixelFormat: 'yuv422p', Profile: 122 })).toBeNull();
    });

    it('names the profiles FFmpeg reports and the variants each codes at a depth', () => {
        expect(H264_RAW_FORMAT_PROFILES.map(profile => profile.name)).toEqual([
            'High 10',
            'High 10 Intra',
            'High 4:2:2',
            'High 4:2:2 Intra',
            'High 4:4:4',
            'High 4:4:4 Predictive',
            'High 4:4:4 Intra',
            'CAVLC 4:4:4'
        ]);
        const variantsOf = (name: string, bitDepth: number): readonly string[] => {
            const profile = getH264RawFormatProfile(name);
            return profile ? getH264RawFormatProfileVariants(profile, bitDepth) : [];
        };
        expect(variantsOf('High 10', 10)).toEqual([ 'high420-10' ]);
        // 8-bit 4:2:0, which High 10 also codes, is no variant
        expect(variantsOf('High 10', 8)).toEqual([]);
        expect(variantsOf('High 4:2:2 Intra', 10)).toEqual([ 'high420-10', 'high422-10' ]);
        expect(variantsOf('High 4:2:2', 8)).toEqual([ 'high422-8' ]);
        expect(variantsOf('high 4:4:4 predictive', 8)).toEqual([ 'high422-8', 'high444-8' ]);
        expect(variantsOf('CAVLC 4:4:4', 10)).toEqual([ 'high420-10', 'high422-10', 'high444-10' ]);
        expect(getH264RawFormatProfile('High')).toBeNull();
    });
});
