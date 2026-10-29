import { describe, expect, it } from 'vitest';

import {
    parseHEVCSPS,
    readHEVCSPSChroma,
    repairHEVCSPSDefaultDisplayWindow,
    rewriteHEVCSPSColorDescriptionToBT709
} from 'webgpu-player/demux/hevc/HEVCSPSParser';

import { createBytesFromHex } from '../../helpers/byteArrays';

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
// An old x265 build's Main 10 SPS whose VUI omits default_display_window_flag: 69 bits remain before the stop bit at the flag's RBSP bit 214,
// and its timing info follows; FFmpeg's hevc/ps.c detects it and decodes its frames as with the flag inserted as 0
const X265_MISSING_DEFAULT_DISPLAY_WINDOW_SPS = createBytesFromHex(
    '420101022000000300900000030000030096a001e0200649f4d96666924c2e02000007d20000bb8010'
);
const X265_REPAIRED_DEFAULT_DISPLAY_WINDOW_SPS = createBytesFromHex(
    '420101022000000300900000030000030096a001e0200649f4d96666924c2e0100000303e900005dc008'
);
// The same SPS cut to 68 and to 67 bits after the flag, each closed by a new stop bit, at and below FFmpeg's bound
const MISSING_DEFAULT_DISPLAY_WINDOW_68_BIT_SPS = createBytesFromHex(
    '420101022000000300900000030000030096a001e0200649f4d96666924c2e02000007d20000bb8020'
);
const REPAIRED_DEFAULT_DISPLAY_WINDOW_68_BIT_SPS = createBytesFromHex(
    '420101022000000300900000030000030096a001e0200649f4d96666924c2e0100000303e900005dc010'
);
const MISSING_DEFAULT_DISPLAY_WINDOW_67_BIT_SPS = createBytesFromHex(
    '420101022000000300900000030000030096a001e0200649f4d96666924c2e02000007d20000bb8040'
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
// SPSs of 64x64 streams from the pinned FFmpeg's libx265, whose trace_headers names their chroma_sample_loc_type: Main at 2 and Main 10 at 5
const X265_MAIN_TOP_LEFT_SPS = createBytesFromHex(
    '42010101600000030090000003000003001ea020810596566924caf01696c20000030002000003003210'
);
const X265_MAIN10_BOTTOM_SPS = createBytesFromHex(
    '42010102200000030090000003000003001ea0208104d96566924caf016931820000030002000003003210'
);
// SPSs of the pinned FFmpeg's libx265 outside the bounded parser's bounds, with the types trace_headers names: an interlaced field sequence at 4,
// Main 12 at 3, and Main 4:2:2 10 and Main 4:4:4 12 at 2, which libx265 declares for 4:2:0 only, so FFmpeg's hevc_metadata filter set it
const X265_INTERLACED_BOTTOM_LEFT_SPS = createBytesFromHex(
    '42010101600000030040000003000003001ea020810596566924caf0169295a000000300200000030301'
);
const X265_MAIN12_TOP_SPS = createBytesFromHex(
    '420101040800000300998800000300001ea02081045296566924caf01692102000000300200000030301'
);
const X265_MAIN422_10_TOP_LEFT_SPS = createBytesFromHex(
    '4201010408000003009d0800000300001eb0208104d96566924caf01696c2000000300200000030301'
);
const X265_MAIN444_12_TOP_LEFT_SPS = createBytesFromHex(
    '420101040800000300980800000300001e900410208a52cacd24995e02d2d840000003004000000602'
);
// X265_MAIN12_TOP_SPS cut long before its VUI
const TRUNCATED_SPS_BYTE_LENGTH = 20;
const TOP_LEFT_CHROMA_SAMPLE_LOCATION_TYPE = 2;
const TOP_CHROMA_SAMPLE_LOCATION_TYPE = 3;
const BOTTOM_LEFT_CHROMA_SAMPLE_LOCATION_TYPE = 4;
const BOTTOM_CHROMA_SAMPLE_LOCATION_TYPE = 5;
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

describe('repairHEVCSPSDefaultDisplayWindow', () => {
    it('inserts the missing flag as 0, moves the rest one bit, and closes the RBSP with a new stop bit', () => {
        expect(repairHEVCSPSDefaultDisplayWindow(X265_MISSING_DEFAULT_DISPLAY_WINDOW_SPS)).toEqual(X265_REPAIRED_DEFAULT_DISPLAY_WINDOW_SPS);
        expect(repairHEVCSPSDefaultDisplayWindow(X265_REPAIRED_DEFAULT_DISPLAY_WINDOW_SPS)).toBeNull();
        // The repair changes nothing the parser reads
        expect(parseHEVCSPS(X265_REPAIRED_DEFAULT_DISPLAY_WINDOW_SPS)).toEqual(parseHEVCSPS(X265_MISSING_DEFAULT_DISPLAY_WINDOW_SPS));
    });

    it('needs at least 68 bits from the flag to the stop bit, as FFmpeg does', () => {
        expect(repairHEVCSPSDefaultDisplayWindow(MISSING_DEFAULT_DISPLAY_WINDOW_68_BIT_SPS)).toEqual(REPAIRED_DEFAULT_DISPLAY_WINDOW_68_BIT_SPS);
        expect(repairHEVCSPSDefaultDisplayWindow(MISSING_DEFAULT_DISPLAY_WINDOW_67_BIT_SPS)).toBeNull();
    });

    it('leaves an SPS with the flag, without VUI, or that the parser refuses', () => {
        for (const sequenceParameterSet of [
            MAIN_SPS,
            MAIN10_PQ_SPS,
            MAIN10_HLG_SPS,
            X265_MAIN10_BOTTOM_SPS,
            X265_MAIN444_12_TOP_LEFT_SPS,
            MAIN10_SPS_WITHOUT_VUI,
            X265_MAIN12_TOP_SPS.subarray(0, TRUNCATED_SPS_BYTE_LENGTH)
        ]) {
            expect(repairHEVCSPSDefaultDisplayWindow(sequenceParameterSet)).toBeNull();
        }
    });
});

describe('readHEVCSPSChroma', () => {
    it('reads the VUI\'s top-field chroma sample location type, and null without chroma_loc_info or a VUI', () => {
        expect(readHEVCSPSChroma(X265_MAIN_TOP_LEFT_SPS)).toEqual({ chromaFormat: 1, chromaSampleLocationType: TOP_LEFT_CHROMA_SAMPLE_LOCATION_TYPE });
        expect(readHEVCSPSChroma(X265_MAIN10_BOTTOM_SPS).chromaSampleLocationType).toBe(BOTTOM_CHROMA_SAMPLE_LOCATION_TYPE);
        expect(readHEVCSPSChroma(MAIN10_HLG_SPS).chromaSampleLocationType).toBeNull();
        expect(readHEVCSPSChroma(MAIN10_SPS_WITHOUT_VUI).chromaSampleLocationType).toBeNull();
    });

    it('reads the chroma of SPSs outside the bounded parser\'s progressive Main and Main 10 bounds', () => {
        expect(() => parseHEVCSPS(X265_INTERLACED_BOTTOM_LEFT_SPS)).toThrow('not constrained to progressive pictures');
        expect(readHEVCSPSChroma(X265_INTERLACED_BOTTOM_LEFT_SPS)).toEqual({ chromaFormat: 1, chromaSampleLocationType: BOTTOM_LEFT_CHROMA_SAMPLE_LOCATION_TYPE });
        expect(() => parseHEVCSPS(X265_MAIN12_TOP_SPS)).toThrow('profile is unsupported');
        expect(readHEVCSPSChroma(X265_MAIN12_TOP_SPS)).toEqual({ chromaFormat: 1, chromaSampleLocationType: TOP_CHROMA_SAMPLE_LOCATION_TYPE });
        expect(readHEVCSPSChroma(X265_MAIN422_10_TOP_LEFT_SPS)).toEqual({ chromaFormat: 2, chromaSampleLocationType: TOP_LEFT_CHROMA_SAMPLE_LOCATION_TYPE });
        expect(readHEVCSPSChroma(X265_MAIN444_12_TOP_LEFT_SPS)).toEqual({ chromaFormat: 3, chromaSampleLocationType: TOP_LEFT_CHROMA_SAMPLE_LOCATION_TYPE });
    });

    it('rejects an SPS that ends before its VUI is read', () => {
        expect(() => readHEVCSPSChroma(X265_MAIN12_TOP_SPS.subarray(0, TRUNCATED_SPS_BYTE_LENGTH))).toThrow('The HEVC SPS ends inside');
    });
});
