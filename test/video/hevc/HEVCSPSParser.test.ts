import { describe, expect, it } from 'vitest';

import {
    parseHEVCSPS,
    rewriteHEVCSPSColorDescriptionToBT709
} from 'webgpu-player/video/hevc/HEVCSPSParser';

function createBytesFromHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
        bytes[byteIndex] = Number.parseInt(hex.slice(byteIndex * 2, (byteIndex * 2) + 2), 16);
    }
    return bytes;
}

const MAIN_SPS = createBytesFromHex(
    '42010101600000030090000003000003001ea020810596566924caf016a020202080000003008000000c04'
);
const MAIN10_PQ_SPS = createBytesFromHex(
    '4201010220000003009000000300000300ffa005020169365959a4932bc05a848804820000030002000003000210'
);
const MAIN10_HLG_SPS = createBytesFromHex(
    '42010102200000030090000003000003003fa005020171f2b6595952930bc05a848904820000030002000003003010'
);
// MAIN10_HLG_SPS with NAL bytes 32 to 35 replaced by (1 << 31) | (primaries << 23) | (transfer << 15) | (matrix << 7) | 2
const MAIN10_BT2020_10_SPS = createBytesFromHex(
    '42010102200000030090000003000003003fa005020171f2b6595952930bc05a848704820000030002000003003010'
);
const MAIN10_BT2020_12_SPS = createBytesFromHex(
    '42010102200000030090000003000003003fa005020171f2b6595952930bc05a848784820000030002000003003010'
);
const MAIN10_UNSPECIFIED_COLOR_SPS = createBytesFromHex(
    '42010102200000030090000003000003003fa005020171f2b6595952930bc05a810101020000030002000003003010'
);
const MAIN10_BT470BG_SPS = createBytesFromHex(
    '42010102200000030090000003000003003fa005020171f2b6595952930bc05a828282820000030002000003003010'
);
const MAIN10_SMPTE170M_SPS = createBytesFromHex(
    '42010102200000030090000003000003003fa005020171f2b6595952930bc05a830303020000030002000003003010'
);
const MAIN10_SMPTE240M_PRIMARIES_SPS = createBytesFromHex(
    '42010102200000030090000003000003003fa005020171f2b6595952930bc05a838080820000030002000003003010'
);
const MAIN10_DISPLAY_P3_SRGB_IDENTITY_SPS = createBytesFromHex(
    '42010102200000030090000003000003003fa005020171f2b6595952930bc05a860680020000030002000003003010'
);
const MAIN10_BT2020_CONSTANT_LUMINANCE_HLG_SPS = createBytesFromHex(
    '42010102200000030090000003000003003fa005020171f2b6595952930bc05a848905020000030002000003003010'
);
// MAIN10_HLG_SPS cut after NAL byte 29
// Byte 30 clears vui_parameters_present_flag and sps_extension_present_flag, then holds the RBSP stop bit
const MAIN10_SPS_WITHOUT_VUI = createBytesFromHex(
    '42010102200000030090000003000003003fa005020171f2b6595952930b20'
);
const UHD_CODED_WIDTH = 3_840;
const UHD_CODED_HEIGHT = 2_160;
const LEVEL_5_1_IDC = 153;
const LEVEL_6_IDC = 180;
// Level 5.1 allows six pictures at UHD, and level 6 sixteen
const LEVEL_5_1_UHD_DPB_PICTURE_COUNT = 6;
const LEVEL_6_UHD_DECLARED_DPB_PICTURE_COUNT = 7;
const DPB_ABOVE_LEVEL_ERROR = 'decoded picture buffer exceeds its level and picture-size bound';
const LEVEL_5_1_4K_MAIN10_SPS = createBytesFromHex(
    '420101020000000080000000000099a001e020021c4d966ff089a848804800'
);
// UHD Main 10 SPSs declaring seven DPB pictures
const LEVEL_5_1_DPB_7_UHD_MAIN10_SPS = createBytesFromHex(
    '420101020000000080000000000099a001e020021c4d967ff089a848804800'
);
const LEVEL_6_DPB_7_UHD_MAIN10_SPS = createBytesFromHex(
    '4201010200000000800000000000b4a001e020021c4d967ff089a848804800'
);
const DOLBY_VISION_PROFILE_5_SPS_WITH_UNSPECIFIED_COLOR = createBytesFromHex(
    '420101222000000300b00000030000030096a001e02002087db6718b92448053888892cf24a69272c9124922dc91aa48fca223ff000100010100000303e900005dc06005ef7e000068e7700000d1cef080'
);

describe('parseHEVCSPS', () => {
    it('parses a progressive Main Rec.709 SPS', () => {
        expect(parseHEVCSPS(MAIN_SPS)).toEqual({
            bitDepth: 8,
            chromaFormat: 1,
            codedHeight: 64,
            codedWidth: 64,
            colorSpace: {
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            },
            displayHeight: 64,
            displayWidth: 64,
            levelIDC: 30,
            maximumDPBPictureCount: 5,
            profileIDC: 1,
            progressive: true
        });
    });

    it('parses a progressive Main10 BT.2020 PQ SPS', () => {
        expect(parseHEVCSPS(MAIN10_PQ_SPS)).toEqual({
            bitDepth: 10,
            chromaFormat: 1,
            codedHeight: 360,
            codedWidth: 640,
            colorSpace: {
                fullRange: false,
                matrix: 'bt2020-ncl',
                primaries: 'bt2020',
                transfer: 'pq'
            },
            displayHeight: 360,
            displayWidth: 640,
            levelIDC: 255,
            maximumDPBPictureCount: 5,
            profileIDC: 2,
            progressive: true
        });
    });

    it('maps a progressive Main10 BT.2020 HLG SPS without aliases', () => {
        expect(parseHEVCSPS(MAIN10_HLG_SPS).colorSpace).toEqual({
            fullRange: false,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            transfer: 'hlg'
        });
    });

    it('rewrites PQ and HLG VUI descriptions to limited-range BT.709', () => {
        for (const sourceSPS of [ MAIN10_PQ_SPS, MAIN10_HLG_SPS ]) {
            const originalSPS = sourceSPS.slice();
            const originalConfiguration = parseHEVCSPS(sourceSPS);
            const rewrittenSPS = rewriteHEVCSPSColorDescriptionToBT709(sourceSPS);

            expect(sourceSPS).toEqual(originalSPS);
            expect(parseHEVCSPS(rewrittenSPS)).toEqual({
                ...originalConfiguration,
                colorSpace: {
                    fullRange: false,
                    matrix: 'bt709',
                    primaries: 'bt709',
                    transfer: 'bt709'
                }
            });
            expect(parseHEVCSPS(rewriteHEVCSPSColorDescriptionToBT709(rewrittenSPS))).toEqual(parseHEVCSPS(rewrittenSPS));
        }
    });

    it('rejects color neutralization when the SPS has no color description', () => {
        expect(() => rewriteHEVCSPSColorDescriptionToBT709(
            DOLBY_VISION_PROFILE_5_SPS_WITH_UNSPECIFIED_COLOR
        )).toThrow('no VUI color description');
    });

    it('preserves unspecified SPS color for a Dolby Vision Profile 5 stream', () => {
        expect(parseHEVCSPS(DOLBY_VISION_PROFILE_5_SPS_WITH_UNSPECIFIED_COLOR)).toMatchObject({
            bitDepth: 10,
            codedHeight: 2_080,
            codedWidth: 3_840,
            colorSpace: null,
            displayHeight: 2_076,
            displayWidth: 3_840,
            levelIDC: 150,
            profileIDC: 2,
            progressive: true
        });
    });

    it('accepts a six-picture 4K DPB within the Main10 Level 5.1 bound', () => {
        expect(parseHEVCSPS(LEVEL_5_1_4K_MAIN10_SPS)).toMatchObject({
            codedHeight: UHD_CODED_HEIGHT,
            codedWidth: UHD_CODED_WIDTH,
            levelIDC: LEVEL_5_1_IDC,
            maximumDPBPictureCount: LEVEL_5_1_UHD_DPB_PICTURE_COUNT
        });
    });

    it('rejects a DPB declaration above its level at the picture size', () => {
        expect(() => parseHEVCSPS(LEVEL_5_1_DPB_7_UHD_MAIN10_SPS)).toThrow(DPB_ABOVE_LEVEL_ERROR);
    });

    it('accepts any DPB its level allows at the picture size, whatever memory it takes', () => {
        expect(parseHEVCSPS(LEVEL_6_DPB_7_UHD_MAIN10_SPS)).toMatchObject({
            codedHeight: UHD_CODED_HEIGHT,
            codedWidth: UHD_CODED_WIDTH,
            levelIDC: LEVEL_6_IDC,
            maximumDPBPictureCount: LEVEL_6_UHD_DECLARED_DPB_PICTURE_COUNT
        });
    });

    it('rejects interlaced constraints, truncated input, and oversized NAL units', () => {
        const interlacedSPS = MAIN10_PQ_SPS.slice();
        interlacedSPS[9] = 0x50;

        expect(() => parseHEVCSPS(interlacedSPS)).toThrow('not constrained to progressive');
        expect(() => parseHEVCSPS(MAIN10_PQ_SPS.subarray(0, 30))).toThrow('ends inside');
        expect(() => parseHEVCSPS(new Uint8Array((64 * 1024) + 1))).toThrow('NAL unit header is invalid');
    });

    it.each([
        {
            colorSpace: {
                fullRange: false,
                matrix: 'smpte170m',
                primaries: 'smpte170m',
                transfer: 'smpte170m'
            },
            name: 'SMPTE 170M',
            sequenceParameterSet: MAIN10_SMPTE170M_SPS
        },
        {
            // Transfer 5, the BT.470 BG gamma, has no WebCodecs name
            colorSpace: {
                fullRange: false,
                matrix: 'bt470bg',
                primaries: 'bt470bg',
                transfer: null
            },
            name: 'BT.470 BG',
            sequenceParameterSet: MAIN10_BT470BG_SPS
        },
        {
            colorSpace: {
                fullRange: false,
                matrix: 'bt2020-ncl',
                primaries: 'bt2020',
                transfer: null
            },
            name: 'BT.2020 10-bit',
            sequenceParameterSet: MAIN10_BT2020_10_SPS
        },
        {
            colorSpace: {
                fullRange: false,
                matrix: 'bt2020-ncl',
                primaries: 'bt2020',
                transfer: null
            },
            name: 'BT.2020 12-bit',
            sequenceParameterSet: MAIN10_BT2020_12_SPS
        },
        {
            // SMPTE 240M primaries share the SMPTE 170M chromaticities
            colorSpace: {
                fullRange: false,
                matrix: 'bt709',
                primaries: 'smpte170m',
                transfer: 'bt709'
            },
            name: 'SMPTE 240M primaries',
            sequenceParameterSet: MAIN10_SMPTE240M_PRIMARIES_SPS
        },
        {
            colorSpace: {
                fullRange: false,
                matrix: null,
                primaries: 'smpte432',
                transfer: 'iec61966-2-1'
            },
            name: 'Display P3 sRGB with the identity matrix',
            sequenceParameterSet: MAIN10_DISPLAY_P3_SRGB_IDENTITY_SPS
        },
        {
            colorSpace: {
                fullRange: false,
                matrix: null,
                primaries: 'bt2020',
                transfer: 'hlg'
            },
            name: 'BT.2020 constant luminance',
            sequenceParameterSet: MAIN10_BT2020_CONSTANT_LUMINANCE_HLG_SPS
        },
        {
            colorSpace: null,
            name: 'unspecified',
            sequenceParameterSet: MAIN10_UNSPECIFIED_COLOR_SPS
        },
        {
            // video_full_range_flag is the last bit before colour_description_present_flag
            colorSpace: {
                fullRange: true,
                matrix: null,
                primaries: null,
                transfer: null
            },
            name: 'full-range unspecified',
            sequenceParameterSet: createBytesFromHex(
                '42010102200000030090000003000003003fa005020171f2b6595952930bc05b810101020000030002000003003010'
            )
        },
        {
            colorSpace: null,
            name: 'absent VUI',
            sequenceParameterSet: MAIN10_SPS_WITHOUT_VUI
        }
    ])('maps $name VUI color to WebCodecs names or null without rejecting it', ({
        colorSpace,
        sequenceParameterSet
    }) => {
        expect(parseHEVCSPS(sequenceParameterSet)).toEqual({
            ...parseHEVCSPS(MAIN10_HLG_SPS),
            colorSpace
        });
    });
});

describe('rewriteHEVCSPSColorDescriptionToBT709', () => {
    const NEUTRAL_COLOR_SPACE = {
        fullRange: false,
        matrix: 'bt709',
        primaries: 'bt709',
        transfer: 'bt709'
    };

    it('accepts the BT.2020 transfers of HLG-compatible streams on an HLG route without an SEI', () => {
        for (const sequenceParameterSet of [ MAIN10_BT2020_10_SPS, MAIN10_BT2020_12_SPS ]) {
            expect(parseHEVCSPS(
                rewriteHEVCSPSColorDescriptionToBT709(sequenceParameterSet, 'hlg')
            ).colorSpace).toEqual(NEUTRAL_COLOR_SPACE);
        }
    });

    it('lets an alternative transfer characteristics SEI value override the VUI transfer', () => {
        const hlgPreferredTransfer = 18;
        const pqPreferredTransfer = 16;

        expect(parseHEVCSPS(rewriteHEVCSPSColorDescriptionToBT709(
            MAIN10_BT2020_10_SPS,
            'hlg',
            hlgPreferredTransfer
        )).colorSpace).toEqual(NEUTRAL_COLOR_SPACE);
        expect(parseHEVCSPS(rewriteHEVCSPSColorDescriptionToBT709(
            MAIN10_BT2020_10_SPS,
            'pq',
            pqPreferredTransfer
        )).colorSpace).toEqual(NEUTRAL_COLOR_SPACE);
        expect(() => rewriteHEVCSPSColorDescriptionToBT709(
            MAIN10_BT2020_10_SPS,
            'hlg',
            pqPreferredTransfer
        )).toThrow('expected limited-range BT.2020 HDR route');
        expect(() => rewriteHEVCSPSColorDescriptionToBT709(
            MAIN10_HLG_SPS,
            'hlg',
            pqPreferredTransfer
        )).toThrow('expected limited-range BT.2020 HDR route');
    });

    it('keeps a PQ VUI on the PQ route whatever the alternative transfer SEI says', () => {
        const BT709_TRANSFER_CHARACTERISTICS = 1;
        expect(parseHEVCSPS(
            rewriteHEVCSPSColorDescriptionToBT709(MAIN10_PQ_SPS, 'pq', BT709_TRANSFER_CHARACTERISTICS)
        ).colorSpace).toEqual(NEUTRAL_COLOR_SPACE);
    });

    it('requires an exact PQ transfer and strict BT.2020 limited-range color for HDR routes', () => {
        expect(() => rewriteHEVCSPSColorDescriptionToBT709(MAIN10_BT2020_10_SPS, 'pq'))
            .toThrow('expected limited-range BT.2020 HDR route');
        for (const sequenceParameterSet of [
            MAIN10_SMPTE170M_SPS,
            MAIN10_BT2020_CONSTANT_LUMINANCE_HLG_SPS,
            MAIN10_UNSPECIFIED_COLOR_SPS
        ]) {
            expect(() => rewriteHEVCSPSColorDescriptionToBT709(sequenceParameterSet, 'hlg'))
                .toThrow('expected limited-range BT.2020 HDR route');
        }
    });

    it('neutralizes any color description when no HDR route is expected', () => {
        expect(parseHEVCSPS(
            rewriteHEVCSPSColorDescriptionToBT709(MAIN10_SMPTE170M_SPS)
        ).colorSpace).toEqual(NEUTRAL_COLOR_SPACE);
    });

    it('rejects an SPS without VUI, which has no color description to rewrite', () => {
        expect(() => rewriteHEVCSPSColorDescriptionToBT709(MAIN10_SPS_WITHOUT_VUI, 'hlg'))
            .toThrow('no VUI color description');
    });
});
