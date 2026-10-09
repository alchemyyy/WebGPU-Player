import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseHEVCNALUnits, type HEVCNALUnit } from 'webgpu-player/video/dolby-vision/DolbyVisionHEVCSplitter';
import HDR10PlusFrameMetadataQueue from 'webgpu-player/video/hdr/HDR10PlusFrameMetadataQueue';
import {
    parseHEVCHDR10PlusMetadata,
    type HDR10PlusDistributionPercentile,
    type HDR10PlusMetadata
} from 'webgpu-player/video/hdr/HDR10PlusMetadata';

import { TEST_VECTORS_DIRECTORY } from '../../helpers/enginePaths';
import { encodeAnnexBNALUnits } from '../../helpers/hevcNALUnits';

// hdr10plus_tool's x265 --dhdr10-opt sample and the metadata its extract command writes for it, as PROVENANCE.txt pins them
const VECTOR_DIRECTORY = resolve(TEST_VECTORS_DIRECTORY, 'hdr10plus-tool');
const STREAM_FILE_NAME = 'dhdr10-opt.hevc';
const EXTRACTED_METADATA_FILE_NAME = 'metadata-dhdr10-opt.json';
const PINNED_FILE_SHA256 = new Map<string, string>([
    [ STREAM_FILE_NAME, '49ea7d65d3972f98be01b03616f38c7ba660151bd5147a0ed0e07b816daaeb45' ],
    [ EXTRACTED_METADATA_FILE_NAME, '264b837e42d0c3405d357166e3cca66a88b9b41767eab812bce8bd05ae027124' ],
    [ 'LICENSE', 'e9d76c149b1176de4aa0202cfb6a4a266a0c4cb71959f429d670c3a857f95e52' ]
]);
const ANNEX_B_FORMAT = { kind: 'annex-b' } as const;
const PICTURE_COUNT = 30;
// x265 writes the SEI on the IDR picture and on each picture whose metadata differs from the picture encoded before it
const ACCESS_UNITS_WITH_METADATA_COUNT = 12;
const PROFILE_A = 'A';
// The tool writes the 17-bit ST 2094-40 luminance codes, whose unit is 0.1 nit
const LUMINANCE_CODES_PER_NIT = 10;
// Any constant frame duration keys the reordered pictures; the stream carries no timestamps
const FRAME_DURATION_MICROSECONDS = 40_000;

const HEVC_MAXIMUM_VCL_NAL_UNIT_TYPE = 31;
const HEVC_FIRST_IRAP_NAL_UNIT_TYPE = 16;
const HEVC_LAST_IRAP_NAL_UNIT_TYPE = 23;
const HEVC_IDR_W_RADL_NAL_UNIT_TYPE = 19;
const HEVC_IDR_N_LP_NAL_UNIT_TYPE = 20;
const HEVC_SPS_NAL_UNIT_TYPE = 33;
const HEVC_PPS_NAL_UNIT_TYPE = 34;
const HEVC_AUD_NAL_UNIT_TYPE = 35;
// general_profile_space through general_level_idc, the whole profile_tier_level of a stream with one temporal sub-layer
const GENERAL_PROFILE_TIER_LEVEL_BIT_COUNT = 96;
const CHROMA_FORMAT_444 = 3;
const CONFORMANCE_WINDOW_OFFSET_COUNT = 4;
const PICTURE_ORDER_COUNT_LSB_BIT_COUNT_OFFSET = 4;

type ExtractedSceneInfo = Readonly<{
    BezierCurveData?: unknown
    LuminanceParameters: Readonly<{
        AverageRGB: number
        LuminanceDistributions: Readonly<{
            DistributionIndex: readonly number[]
            DistributionValues: readonly number[]
        }>
        MaxScl: readonly [number, number, number]
    }>
    NumberOfWindows: number
    SequenceFrameIndex: number
    TargetedSystemDisplayMaximumLuminance: number
}>;

type ExtractedMetadata = Readonly<{
    JSONInfo: Readonly<{ HDR10plusProfile: string }>
    SceneInfo: readonly ExtractedSceneInfo[]
}>;

type PictureParameterSet = Readonly<{
    extraSliceHeaderBitCount: number
    hasOutputFlag: boolean
}>;

type AccessUnit = Readonly<{
    data: Uint8Array
    pictureOrderCount: number
}>;

class RBSPBitReader {
    private bitOffset = 0;

    public constructor(private readonly bytes: Uint8Array) {}

    public readBits(bitCount: number): number {
        let value = 0;
        for (let bitIndex = 0; bitIndex < bitCount; bitIndex += 1) {
            if (this.bitOffset >= this.bytes.byteLength * 8) {
                throw new Error('The HEVC vector RBSP ended early');
            }
            const bitValue = (this.bytes[Math.floor(this.bitOffset / 8)] >> (7 - (this.bitOffset % 8))) & 1;
            value = (value * 2) + bitValue;
            this.bitOffset += 1;
        }
        return value;
    }

    public readUnsignedExpGolomb(): number {
        let leadingZeroCount = 0;
        while (this.readBits(1) === 0) {
            leadingZeroCount += 1;
        }
        return (2 ** leadingZeroCount) - 1 + this.readBits(leadingZeroCount);
    }
}

function readVectorFile(fileName: string): Uint8Array {
    return new Uint8Array(readFileSync(resolve(VECTOR_DIRECTORY, fileName)));
}

function getRBSP(nalUnit: HEVCNALUnit): Uint8Array {
    const bytes: number[] = [];
    let zeroCount = 0;
    for (const byteValue of nalUnit.data.subarray(2)) {
        if (zeroCount >= 2 && byteValue === 3) {
            zeroCount = 0;
            continue;
        }
        bytes.push(byteValue);
        zeroCount = byteValue === 0 ? zeroCount + 1 : 0;
    }
    return Uint8Array.from(bytes);
}

/** Reads the slice_pic_order_cnt_lsb width from an SPS (H.265 7.3.2.2.1). */
function readPictureOrderCountLSBBitCount(sequenceParameterSet: HEVCNALUnit): number {
    const reader = new RBSPBitReader(getRBSP(sequenceParameterSet));
    // sps_video_parameter_set_id, sps_max_sub_layers_minus1, sps_temporal_id_nesting_flag, and profile_tier_level
    reader.readBits(4);
    if (reader.readBits(3) !== 0) {
        throw new Error('The HEVC vector has more than one temporal sub-layer');
    }
    reader.readBits(1);
    reader.readBits(GENERAL_PROFILE_TIER_LEVEL_BIT_COUNT);
    // sps_seq_parameter_set_id, chroma_format_idc with separate_colour_plane_flag, the picture size, and the conformance window
    reader.readUnsignedExpGolomb();
    if (reader.readUnsignedExpGolomb() === CHROMA_FORMAT_444) {
        reader.readBits(1);
    }
    reader.readUnsignedExpGolomb();
    reader.readUnsignedExpGolomb();
    if (reader.readBits(1) === 1) {
        for (let offsetIndex = 0; offsetIndex < CONFORMANCE_WINDOW_OFFSET_COUNT; offsetIndex += 1) {
            reader.readUnsignedExpGolomb();
        }
    }
    // bit_depth_luma_minus8 and bit_depth_chroma_minus8, then log2_max_pic_order_cnt_lsb_minus4
    reader.readUnsignedExpGolomb();
    reader.readUnsignedExpGolomb();
    return reader.readUnsignedExpGolomb() + PICTURE_ORDER_COUNT_LSB_BIT_COUNT_OFFSET;
}

/** Reads the PPS fields that come before slice_pic_order_cnt_lsb in a first slice segment header (H.265 7.3.2.3.1). */
function readPictureParameterSet(pictureParameterSet: HEVCNALUnit): PictureParameterSet {
    const reader = new RBSPBitReader(getRBSP(pictureParameterSet));
    // pps_pic_parameter_set_id, pps_seq_parameter_set_id, and dependent_slice_segments_enabled_flag
    reader.readUnsignedExpGolomb();
    reader.readUnsignedExpGolomb();
    reader.readBits(1);
    const hasOutputFlag = reader.readBits(1) === 1;
    const extraSliceHeaderBitCount = reader.readBits(3);
    return { extraSliceHeaderBitCount, hasOutputFlag };
}

/**
 * Reads a picture's order count from its first slice segment header (H.265 7.3.6.1).
 * The vector's only IDR picture comes first and it has fewer pictures than slice_pic_order_cnt_lsb can count, so the order count is its LSB.
 */
function readPictureOrderCount(
    slice: HEVCNALUnit,
    pictureOrderCountLSBBitCount: number,
    pictureParameterSet: PictureParameterSet
): number {
    const reader = new RBSPBitReader(getRBSP(slice));
    if (reader.readBits(1) !== 1) {
        throw new Error('An HEVC vector picture starts without its first slice segment');
    }
    // no_output_of_prior_pics_flag, slice_pic_parameter_set_id, slice_reserved_flag, slice_type, and pic_output_flag
    if (slice.type >= HEVC_FIRST_IRAP_NAL_UNIT_TYPE && slice.type <= HEVC_LAST_IRAP_NAL_UNIT_TYPE) {
        reader.readBits(1);
    }
    reader.readUnsignedExpGolomb();
    reader.readBits(pictureParameterSet.extraSliceHeaderBitCount);
    reader.readUnsignedExpGolomb();
    if (pictureParameterSet.hasOutputFlag) {
        reader.readBits(1);
    }
    if (slice.type === HEVC_IDR_W_RADL_NAL_UNIT_TYPE || slice.type === HEVC_IDR_N_LP_NAL_UNIT_TYPE) {
        return 0;
    }
    return reader.readBits(pictureOrderCountLSBBitCount);
}

/** Splits the stream, in decode order, at the access unit delimiter that starts each of its access units. */
function readAccessUnits(): AccessUnit[] {
    const nalUnitGroups: HEVCNALUnit[][] = [];
    for (const nalUnit of parseHEVCNALUnits(readVectorFile(STREAM_FILE_NAME), ANNEX_B_FORMAT)) {
        if (nalUnit.type === HEVC_AUD_NAL_UNIT_TYPE) {
            nalUnitGroups.push([]);
        }
        const nalUnitGroup = nalUnitGroups.at(-1);
        if (!nalUnitGroup) {
            throw new Error('The HEVC vector does not start with an access unit delimiter');
        }
        nalUnitGroup.push(nalUnit);
    }

    const accessUnits: AccessUnit[] = [];
    let pictureOrderCountLSBBitCount: number | null = null;
    let pictureParameterSet: PictureParameterSet | null = null;
    for (const nalUnitGroup of nalUnitGroups) {
        let firstSlice: HEVCNALUnit | null = null;
        for (const nalUnit of nalUnitGroup) {
            if (nalUnit.type === HEVC_SPS_NAL_UNIT_TYPE) {
                pictureOrderCountLSBBitCount = readPictureOrderCountLSBBitCount(nalUnit);
            } else if (nalUnit.type === HEVC_PPS_NAL_UNIT_TYPE) {
                pictureParameterSet = readPictureParameterSet(nalUnit);
            } else if (nalUnit.type <= HEVC_MAXIMUM_VCL_NAL_UNIT_TYPE) {
                firstSlice ??= nalUnit;
            }
        }
        if (!firstSlice || pictureOrderCountLSBBitCount === null || pictureParameterSet === null) {
            throw new Error('An HEVC vector access unit has no slice or no parameter sets before it');
        }
        accessUnits.push({
            data: encodeAnnexBNALUnits(nalUnitGroup.map((nalUnit: HEVCNALUnit): Uint8Array => nalUnit.data)),
            pictureOrderCount: readPictureOrderCount(firstSlice, pictureOrderCountLSBBitCount, pictureParameterSet)
        });
    }
    return accessUnits;
}

function readExtractedMetadata(): ExtractedMetadata {
    return JSON.parse(readFileSync(resolve(VECTOR_DIRECTORY, EXTRACTED_METADATA_FILE_NAME), 'utf8')) as ExtractedMetadata;
}

/** Converts one picture of the tool's output to the fields of the engine's metadata. */
function getExpectedMetadata(sceneInfo: ExtractedSceneInfo): Partial<HDR10PlusMetadata> {
    const luminance = sceneInfo.LuminanceParameters;
    const distribution = luminance.LuminanceDistributions;
    const distributionMaxRGB: HDR10PlusDistributionPercentile[] = [];
    for (let percentileIndex = 0; percentileIndex < distribution.DistributionIndex.length; percentileIndex += 1) {
        distributionMaxRGB.push({
            percentage: distribution.DistributionIndex[percentileIndex],
            percentileNits: distribution.DistributionValues[percentileIndex] / LUMINANCE_CODES_PER_NIT
        });
    }
    return {
        averageMaxRGBNits: luminance.AverageRGB / LUMINANCE_CODES_PER_NIT,
        distributionMaxRGB,
        maximumSCLNits: [
            luminance.MaxScl[0] / LUMINANCE_CODES_PER_NIT,
            luminance.MaxScl[1] / LUMINANCE_CODES_PER_NIT,
            luminance.MaxScl[2] / LUMINANCE_CODES_PER_NIT
        ],
        targetedSystemDisplayMaximumLuminanceNits: sceneInfo.TargetedSystemDisplayMaximumLuminance,
        // The tool writes BezierCurveData only for a curve, which profile A never has
        toneMapping: null
    };
}

describe('hdr10plus_tool HDR10+ vector', () => {
    it('matches the files PROVENANCE.txt pins', () => {
        for (const [ fileName, sha256 ] of PINNED_FILE_SHA256) {
            const digest = createHash('sha256').update(readVectorFile(fileName)).digest('hex');
            expect(digest, fileName).toBe(sha256);
        }
    });

    it('holds one profile A picture per display position', () => {
        const extractedMetadata = readExtractedMetadata();
        const accessUnits = readAccessUnits();

        expect(extractedMetadata.JSONInfo.HDR10plusProfile).toBe(PROFILE_A);
        expect(extractedMetadata.SceneInfo.map((sceneInfo: ExtractedSceneInfo): number => sceneInfo.SequenceFrameIndex))
            .toEqual(Array.from({ length: PICTURE_COUNT }, (_value: unknown, frameIndex: number): number => frameIndex));
        expect(extractedMetadata.SceneInfo.every((sceneInfo: ExtractedSceneInfo): boolean => (
            sceneInfo.NumberOfWindows === 1 && sceneInfo.BezierCurveData === undefined
        ))).toBe(true);
        expect(accessUnits.map((accessUnit: AccessUnit): number => accessUnit.pictureOrderCount).sort((first: number, second: number): number => first - second))
            .toEqual(Array.from({ length: PICTURE_COUNT }, (_value: unknown, frameIndex: number): number => frameIndex));
    });

    it('parses each access unit as the tool reads it', () => {
        const sceneInfo = readExtractedMetadata().SceneInfo;
        let accessUnitsWithMetadataCount = 0;
        for (const accessUnit of readAccessUnits()) {
            const frameMetadata = parseHEVCHDR10PlusMetadata(accessUnit.data, ANNEX_B_FORMAT);
            if (frameMetadata.status === 'absent') {
                expect(frameMetadata.metadata).toBeNull();
                continue;
            }
            expect(frameMetadata.status).toBe('valid');
            expect(frameMetadata.metadata).toMatchObject(getExpectedMetadata(sceneInfo[accessUnit.pictureOrderCount]));
            accessUnitsWithMetadataCount += 1;
        }
        expect(accessUnitsWithMetadataCount).toBe(ACCESS_UNITS_WITH_METADATA_COUNT);
    });

    it('carries metadata in decode order to every picture the tool fills', () => {
        const queue = new HDR10PlusFrameMetadataQueue('HEVC');
        for (const accessUnit of readAccessUnits()) {
            queue.enqueue(
                accessUnit.pictureOrderCount * FRAME_DURATION_MICROSECONDS,
                parseHEVCHDR10PlusMetadata(accessUnit.data, ANNEX_B_FORMAT)
            );
        }

        for (const sceneInfo of readExtractedMetadata().SceneInfo) {
            const frameMetadata = queue.takeFrameMetadata(sceneInfo.SequenceFrameIndex * FRAME_DURATION_MICROSECONDS);
            expect(frameMetadata.metadata, `picture ${sceneInfo.SequenceFrameIndex}`).toMatchObject(getExpectedMetadata(sceneInfo));
        }
        queue.requireDrained();
    });
});
