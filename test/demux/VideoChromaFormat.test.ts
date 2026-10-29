import { describe, expect, it } from 'vitest';

import { readsChromaInBand, readVideoChromaFormat } from 'webgpu-player/demux/VideoChromaFormat';

import { createBytesFromHex } from '../helpers/byteArrays';

// An H.264 SPS of High 4:4:4 Predictive (244): NAL header, profile, constraints, level, then ue(0) seq_parameter_set_id and ue(3) chroma_format_idc
const HIGH_444_SPS = [ 0x67, 0xF4, 0x00, 0x28, 0x90 ];
// A High SPS whose zero constraint and level bytes take emulation prevention, which the reader skips: ue(0) id, then ue(1) chroma_format_idc
const HIGH_420_SPS_WITH_EMULATION_PREVENTION = [ 0x67, 0x64, 0x00, 0x00, 0x03, 0xA0 ];
// SPSs of 64x64 streams from the pinned FFmpeg's libx264, whose trace_headers names their fields
// High, pic_order_cnt_type 0, chroma_sample_loc_type 2
const X264_HIGH_TOP_LEFT_SPS = createBytesFromHex('6764000aacd94426c04b7000000300100000030320f1225960');
// High at 66x62 with a 7:5 extended SAR, a BT.709 colour description, cropping, and chroma_sample_loc_type 2
const X264_HIGH_CROPPED_TOP_LEFT_SPS = createBytesFromHex('6764000aacd9452788affc001c0015a808080db80000030008000003019078912cb0');
// High, field coded, chroma_sample_loc_type 5
const X264_HIGH_FIELD_BOTTOM_SPS = createBytesFromHex('67640015acd9444d80931a000003000200000300643e28532c');
// Baseline, pic_order_cnt_type 2, chroma_sample_loc_type 1
const X264_BASELINE_CENTER_SPS = createBytesFromHex('6742c00ad90426c04a5000000300100000030320f1226480');
// High without chroma_loc_info
const X264_HIGH_UNDECLARED_SPS = createBytesFromHex('6764000aacd94426c044000003000400000300c83c489658');
// High 4:2:2 without chroma_loc_info, whose chroma the location types do not describe
const X264_HIGH_422_SPS = createBytesFromHex('677a000abcd94426c044000003000400000300c83c489658');
// A High SPS built bit by bit, which trace_headers reads back: scaling lists 0, 1, and 6, the second ending at its first delta, pic_order_cnt_type 1 with a
// two-frame cycle, field coding with adaptive macroblocks, cropping, a 7:5 extended SAR, overscan, video format 5 with a colour description, and type 3
const SYNTHETIC_HIGH_TOP_SPS = createBytesFromHex(
    '6764001eada69a69a69a69c22174e9d3a74e9d3a74e9d3a74e9d3a74e9d3a74d46990e844f55ff80038002fa848804c84040'
);
// X264_HIGH_TOP_LEFT_SPS cut inside its VUI's aspect_ratio_idc, which ends in NAL byte 9 just before chroma_loc_info
const TRUNCATED_HIGH_SPS_BYTE_LENGTH = 9;
// SPSs of 64x64 streams from the pinned FFmpeg's libx265: Main with chroma_sample_loc_type 2, Main 10 with type 5, and Main without chroma_loc_info
const X265_MAIN_TOP_LEFT_SPS = createBytesFromHex(
    '42010101600000030090000003000003001ea020810596566924caf01696c20000030002000003003210'
);
const X265_MAIN10_BOTTOM_SPS = createBytesFromHex(
    '42010102200000030090000003000003001ea0208104d96566924caf016931820000030002000003003210'
);
const X265_MAIN_UNDECLARED_SPS = createBytesFromHex(
    '42010101600000030090000003000003001ea020810596566924caf0168080000003008000000c84'
);
const AVC_HIGH_PROFILE = 0x64;
const AVC_HIGH_422_PROFILE = 0x7A;
const AVC_HIGH_444_PROFILE = 0xF4;
const AVC_MAIN_PROFILE = 0x4D;
const AVC_BASELINE_PROFILE = 0x42;
// avcC's closing chroma_format byte for 4:2:2, its reserved bits set
const AVC_RECORD_CHROMA_FORMAT_422 = 0xFE;
// hvcC's chromaFormat codes
const HEVC_CHROMA_FORMAT_420 = 1;
const HEVC_CHROMA_FORMAT_444 = 3;
const HEVC_CHROMA_FORMAT_MONOCHROME = 0;
const HVCC_HEADER_BYTE_LENGTH = 23;
const HVCC_CHROMA_FORMAT_OFFSET = 16;
const HVCC_RESERVED_BITS = 0xFC;
const HVCC_EIGHT_BIT_DEPTH_BYTE = 0xF8;
const HVCC_FOUR_BYTE_LENGTHS = 0x0F;
const HVCC_ARRAY_COUNT_OFFSET = 22;
const HEVC_SPS_ARRAY_TYPE = 0xA1;
// av1C byte 2: subsampling x and y set is 4:2:0, x alone 4:2:2, the monochrome bit, and chroma_sample_position in the low bits
const AV1C_420 = 0x0C;
const AV1C_422 = 0x08;
const AV1C_MONOCHROME_420 = 0x1C;
const AV1C_VERTICAL_POSITION = 1;
const AV1C_COLOCATED_POSITION = 2;
const AV1C_RESERVED_POSITION = 3;
// SPSs of the pinned FFmpeg's encoders whose trace_headers names their fields: x264 High with chroma_sample_loc_type 4,
// and x265 SPSs outside the bounded parser's bounds, an interlaced field sequence at type 4, Main 12 at 3, and Main 4:2:2 10 at 2,
// which FFmpeg's hevc_metadata filter set, since libx265 declares a location for 4:2:0 only
const X264_HIGH_BOTTOM_LEFT_SPS = createBytesFromHex('6764000aacd94426c0494b000003000100000300300f122596');
const X265_INTERLACED_BOTTOM_LEFT_SPS = createBytesFromHex(
    '42010101600000030040000003000003001ea020810596566924caf0169295a000000300200000030301'
);
const X265_MAIN12_TOP_SPS = createBytesFromHex(
    '420101040800000300998800000300001ea02081045296566924caf01692102000000300200000030301'
);
const X265_MAIN422_10_TOP_LEFT_SPS = createBytesFromHex(
    '4201010408000003009d0800000300001eb0208104d96566924caf01696c2000000300200000030301'
);
const HEVC_CHROMA_FORMAT_422 = 2;
// The NAL units around a key packet's SPS: x264's PPS, access unit delimiters, and the first bytes of IDR slices
const X264_PPS = createBytesFromHex('68ebe3cb22c0');
const AVC_ACCESS_UNIT_DELIMITER = [ 0x09, 0xF0 ];
const AVC_IDR_SLICE = [ 0x65, 0x88, 0x84 ];
const HEVC_ACCESS_UNIT_DELIMITER = [ 0x46, 0x01, 0x50 ];
const HEVC_IDR_SLICE = [ 0x26, 0x01, 0xAF ];
// An avc3 track's avcC of High with four-byte lengths, no SPS or PPS, and its closing 4:2:0 chroma_format
const AVC3_RECORD_WITHOUT_SPS = Uint8Array.from([ 1, 0x64, 0, 0x0A, 0xFF, 0xE0, 0, 0xFD, 0xF8, 0xF8, 0 ]);

/** Returns an avcC of one SPS and no PPS, with an optional closing chroma_format byte. */
function createAVCRecord(profile: number, sequenceParameterSet: ArrayLike<number>, chromaFormatByte: number | null = null): Uint8Array {
    const record = [ 1, profile, 0, 0x28, 0xFF, 0xE1, 0, sequenceParameterSet.length, ...Array.from(sequenceParameterSet), 0 ];
    if (chromaFormatByte !== null) {
        record.push(chromaFormatByte, 0xF8, 0xF8, 0);
    }
    return Uint8Array.from(record);
}

/** Returns an hvcC at 8 bits of a chroma format, with an SPS array of one SPS when given one. */
function createHEVCRecord(chromaFormat: number, sequenceParameterSet: Uint8Array | null = null): Uint8Array {
    const header = new Uint8Array(HVCC_HEADER_BYTE_LENGTH);
    header[0] = 1;
    header[HVCC_CHROMA_FORMAT_OFFSET] = HVCC_RESERVED_BITS | chromaFormat;
    header[HVCC_CHROMA_FORMAT_OFFSET + 1] = HVCC_EIGHT_BIT_DEPTH_BYTE;
    header[HVCC_CHROMA_FORMAT_OFFSET + 2] = HVCC_EIGHT_BIT_DEPTH_BYTE;
    header[HVCC_HEADER_BYTE_LENGTH - 2] = HVCC_FOUR_BYTE_LENGTHS;
    if (sequenceParameterSet === null) {
        return header;
    }
    header[HVCC_ARRAY_COUNT_OFFSET] = 1;
    const length = sequenceParameterSet.byteLength;
    return Uint8Array.from([ ...header, HEVC_SPS_ARRAY_TYPE, 0, 1, length >> 8, length & 0xFF, ...sequenceParameterSet ]);
}

function createAV1Record(colorByte: number): Uint8Array {
    return Uint8Array.from([ 0x81, 0x08, colorByte, 0 ]);
}

function createAnnexBPacket(nalUnits: readonly ArrayLike<number>[]): Uint8Array {
    return Uint8Array.from(nalUnits.flatMap(nalUnit => [ 0, 0, 0, 1, ...Array.from(nalUnit) ]));
}

function createLengthPrefixedPacket(nalUnits: readonly ArrayLike<number>[]): Uint8Array {
    return Uint8Array.from(nalUnits.flatMap(nalUnit => [ 0, 0, nalUnit.length >> 8, nalUnit.length & 0xFF, ...Array.from(nalUnit) ]));
}

/** Returns a copy of an HEVC NAL unit whose header names another nuh_layer_id. */
function withHEVCLayerID(nalUnit: Uint8Array, layerID: number): Uint8Array {
    const copy = nalUnit.slice();
    copy[0] = (copy[0] & 0xFE) | (layerID >> 5);
    copy[1] = ((layerID & 0x1F) << 3) | (copy[1] & 0x07);
    return copy;
}

describe('readVideoChromaFormat', () => {
    it('reads H.264 below High as 4:2:0, and High\'s record or SPS otherwise', () => {
        expect(readVideoChromaFormat({ codec: 'avc1.4d401f', description: createAVCRecord(AVC_MAIN_PROFILE, HIGH_444_SPS) }).subsampling).toBe('4:2:0');
        expect(readVideoChromaFormat({
            codec: 'avc1.640028',
            description: createAVCRecord(AVC_HIGH_PROFILE, HIGH_420_SPS_WITH_EMULATION_PREVENTION, AVC_RECORD_CHROMA_FORMAT_422)
        }).subsampling).toBe('4:2:2');
        expect(readVideoChromaFormat({ codec: 'avc1.f40028', description: createAVCRecord(AVC_HIGH_444_PROFILE, HIGH_444_SPS) }).subsampling).toBe('4:4:4');
        expect(readVideoChromaFormat({
            codec: 'avc1.640028',
            description: createAVCRecord(AVC_HIGH_PROFILE, HIGH_420_SPS_WITH_EMULATION_PREVENTION)
        }).subsampling).toBe('4:2:0');
        expect(readVideoChromaFormat({ codec: 'avc1.640028' })).toEqual({ location: null, subsampling: null });
    });

    it('reads an avcC\'s closing bytes as chroma_format only with their reserved bits set and all four present, and the SPS otherwise', () => {
        const withTail = (sequenceParameterSet: ArrayLike<number>, tail: readonly number[]): Uint8Array => Uint8Array.from([
            ...createAVCRecord(AVC_HIGH_PROFILE, sequenceParameterSet),
            ...tail
        ]);
        // Bytes some muxers leave after the PPS: their low bits would read as 4:2:0 and 4:4:4
        for (const junkTail of [ [ 0x69, 0x73, 0x61, 0x74 ], [ 0x73, 0x74, 0x61, 0x67 ] ]) {
            expect(readVideoChromaFormat({ codec: 'avc1.6e0028', description: withTail(HIGH_420_SPS_WITH_EMULATION_PREVENTION, junkTail) }).subsampling)
                .toBe('4:2:0');
            expect(readVideoChromaFormat({ codec: 'avc1.6e0028', description: withTail(HIGH_444_SPS, junkTail) }).subsampling).toBe('4:4:4');
        }
        expect(readVideoChromaFormat({ codec: 'avc1.6e0028', description: withTail(HIGH_420_SPS_WITH_EMULATION_PREVENTION, [ 0xFD, 0xFA, 0xFA, 0 ]) }).subsampling)
            .toBe('4:2:0');
        expect(readVideoChromaFormat({ codec: 'avc1.6e0028', description: withTail(HIGH_420_SPS_WITH_EMULATION_PREVENTION, [ 0xFE, 0xFA, 0xFA, 0 ]) }).subsampling)
            .toBe('4:2:2');
        // Valid reserved bits, but the record ends before numOfSequenceParameterSetExt
        expect(readVideoChromaFormat({ codec: 'avc1.6e0028', description: withTail(HIGH_420_SPS_WITH_EMULATION_PREVENTION, [ 0xFE, 0xFA, 0xFA ]) }).subsampling)
            .toBe('4:2:0');
    });

    it('reads H.264 4:2:0 chroma\'s location from its first SPS\'s VUI, through every field before it', () => {
        expect(readVideoChromaFormat({ codec: 'avc1.64000a', description: createAVCRecord(AVC_HIGH_PROFILE, X264_HIGH_TOP_LEFT_SPS) }))
            .toEqual({ location: 'top-left', subsampling: '4:2:0' });
        expect(readVideoChromaFormat({ codec: 'avc1.64000a', description: createAVCRecord(AVC_HIGH_PROFILE, X264_HIGH_CROPPED_TOP_LEFT_SPS) }).location)
            .toBe('top-left');
        expect(readVideoChromaFormat({ codec: 'avc1.640015', description: createAVCRecord(AVC_HIGH_PROFILE, X264_HIGH_FIELD_BOTTOM_SPS) }).location)
            .toBe('bottom');
        expect(readVideoChromaFormat({ codec: 'avc1.42c00a', description: createAVCRecord(AVC_BASELINE_PROFILE, X264_BASELINE_CENTER_SPS) }))
            .toEqual({ location: 'center', subsampling: '4:2:0' });
        expect(readVideoChromaFormat({ codec: 'avc1.64001e', description: createAVCRecord(AVC_HIGH_PROFILE, SYNTHETIC_HIGH_TOP_SPS) }).location)
            .toBe('top');
    });

    it('declares no H.264 location without chroma_loc_info, for 4:2:2, or for an SPS that ends first', () => {
        expect(readVideoChromaFormat({ codec: 'avc1.64000a', description: createAVCRecord(AVC_HIGH_PROFILE, X264_HIGH_UNDECLARED_SPS) }))
            .toEqual({ location: null, subsampling: '4:2:0' });
        expect(readVideoChromaFormat({ codec: 'avc1.7a000a', description: createAVCRecord(AVC_HIGH_422_PROFILE, X264_HIGH_422_SPS) }))
            .toEqual({ location: null, subsampling: '4:2:2' });
        expect(readVideoChromaFormat({
            codec: 'avc1.64000a',
            description: createAVCRecord(AVC_HIGH_PROFILE, X264_HIGH_TOP_LEFT_SPS.subarray(0, TRUNCATED_HIGH_SPS_BYTE_LENGTH))
        })).toEqual({ location: null, subsampling: '4:2:0' });
    });

    it('reads HEVC\'s hvcC chroma format, and a monochrome stream as none', () => {
        expect(readVideoChromaFormat({ codec: 'hvc1.4.10.L120.90', description: createHEVCRecord(HEVC_CHROMA_FORMAT_444) }).subsampling).toBe('4:4:4');
        expect(readVideoChromaFormat({ codec: 'hev1.4.10.L120.90', description: createHEVCRecord(HEVC_CHROMA_FORMAT_MONOCHROME) }))
            .toEqual({ location: null, subsampling: null });
    });

    it('reads HEVC 4:2:0 chroma\'s location from its first SPS\'s VUI', () => {
        expect(readVideoChromaFormat({ codec: 'hvc1.1.6.L30.90', description: createHEVCRecord(HEVC_CHROMA_FORMAT_420, X265_MAIN_TOP_LEFT_SPS) }))
            .toEqual({ location: 'top-left', subsampling: '4:2:0' });
        expect(readVideoChromaFormat({ codec: 'hvc1.2.4.L30.90', description: createHEVCRecord(HEVC_CHROMA_FORMAT_420, X265_MAIN10_BOTTOM_SPS) }).location)
            .toBe('bottom');
        expect(readVideoChromaFormat({ codec: 'hvc1.1.6.L30.90', description: createHEVCRecord(HEVC_CHROMA_FORMAT_420, X265_MAIN_UNDECLARED_SPS) }).location)
            .toBeNull();
        expect(readVideoChromaFormat({ codec: 'hvc1.1.6.L30.90', description: createHEVCRecord(HEVC_CHROMA_FORMAT_420) }).location).toBeNull();
    });

    it('reads AV1\'s av1C, else its codecs string, whose short form is 4:2:0', () => {
        expect(readVideoChromaFormat({ codec: 'av01.0.08M.08', description: createAV1Record(AV1C_420) })).toEqual({ location: null, subsampling: '4:2:0' });
        expect(readVideoChromaFormat({ codec: 'av01.2.08M.10', description: createAV1Record(AV1C_422) }).subsampling).toBe('4:2:2');
        expect(readVideoChromaFormat({ codec: 'av01.0.08M.08', description: createAV1Record(AV1C_MONOCHROME_420) })).toEqual({ location: null, subsampling: null });
        expect(readVideoChromaFormat({ codec: 'av01.1.08M.10.0.000.01.01.01.0' }).subsampling).toBe('4:4:4');
        expect(readVideoChromaFormat({ codec: 'av01.0.08M.08' })).toEqual({ location: null, subsampling: '4:2:0' });
    });

    it('reads AV1 4:2:0 chroma_sample_position as left or top-left, and the unknown and reserved positions as undeclared', () => {
        expect(readVideoChromaFormat({ codec: 'av01.0.08M.08', description: createAV1Record(AV1C_420 | AV1C_VERTICAL_POSITION) }).location).toBe('left');
        expect(readVideoChromaFormat({ codec: 'av01.0.08M.08', description: createAV1Record(AV1C_420 | AV1C_COLOCATED_POSITION) }).location).toBe('top-left');
        expect(readVideoChromaFormat({ codec: 'av01.0.08M.08', description: createAV1Record(AV1C_420 | AV1C_RESERVED_POSITION) }).location).toBeNull();
        expect(readVideoChromaFormat({ codec: 'av01.2.08M.10', description: createAV1Record(AV1C_422 | AV1C_COLOCATED_POSITION) }).location).toBeNull();
        expect(readVideoChromaFormat({ codec: 'av01.0.04M.10.0.112.09.16.09.0' })).toEqual({ location: 'top-left', subsampling: '4:2:0' });
        expect(readVideoChromaFormat({ codec: 'av01.0.04M.10.0.111.09.16.09.0' }).location).toBe('left');
        expect(readVideoChromaFormat({ codec: 'av01.0.04M.10.0.110.09.16.09.0' }).location).toBeNull();
    });

    it('reads VP9\'s codecs string without a location, and VP8 as 4:2:0', () => {
        expect(readVideoChromaFormat({ codec: 'vp09.01.10.08.02' }).subsampling).toBe('4:2:2');
        expect(readVideoChromaFormat({ codec: 'vp09.01.10.08.03' }).subsampling).toBe('4:4:4');
        // Muxers write the colocated value for chroma of unknown siting, so neither 4:2:0 value declares a location
        expect(readVideoChromaFormat({ codec: 'vp09.00.10.08.00' })).toEqual({ location: null, subsampling: '4:2:0' });
        expect(readVideoChromaFormat({ codec: 'vp09.00.10.08.01' })).toEqual({ location: null, subsampling: '4:2:0' });
        expect(readVideoChromaFormat({ codec: 'vp09.00.10.08' }).subsampling).toBe('4:2:0');
        expect(readVideoChromaFormat({ codec: 'vp8' })).toEqual({ location: null, subsampling: '4:2:0' });
        expect(readVideoChromaFormat({ codec: 'mp4v.20.9' })).toEqual({ location: null, subsampling: null });
    });

    it('reads MPEG-1 as center-sited 4:2:0, as FFmpeg\'s MPEG-1 decoder sets it', () => {
        expect(readVideoChromaFormat({ codec: 'mpeg1video' })).toEqual({ location: 'center', subsampling: '4:2:0' });
    });

    it('reads an HEVC SPS outside the bounded parser\'s progressive Main and Main 10 bounds', () => {
        expect(readVideoChromaFormat({ codec: 'hvc1.1.6.L30.90', description: createHEVCRecord(HEVC_CHROMA_FORMAT_420, X265_INTERLACED_BOTTOM_LEFT_SPS) }))
            .toEqual({ location: 'bottom-left', subsampling: '4:2:0' });
        expect(readVideoChromaFormat({ codec: 'hvc1.4.10.L30.90', description: createHEVCRecord(HEVC_CHROMA_FORMAT_420, X265_MAIN12_TOP_SPS) }).location)
            .toBe('top');
        // 4:2:2 chroma stays on its left column whatever the VUI says
        expect(readVideoChromaFormat({ codec: 'hvc1.4.10.L30.90', description: createHEVCRecord(HEVC_CHROMA_FORMAT_422, X265_MAIN422_10_TOP_LEFT_SPS) }))
            .toEqual({ location: null, subsampling: '4:2:2' });
    });
});

describe('readVideoChromaFormat with a key packet', () => {
    it('reads H.264 without a record from the first SPS among its key packet\'s Annex B NAL units', () => {
        const configuration = { codec: 'avc1.64000a' };
        expect(readsChromaInBand(configuration)).toBe(true);
        expect(readVideoChromaFormat(configuration, createAnnexBPacket([ AVC_ACCESS_UNIT_DELIMITER, X264_HIGH_BOTTOM_LEFT_SPS, X264_PPS, AVC_IDR_SLICE ])))
            .toEqual({ location: 'bottom-left', subsampling: '4:2:0' });
        expect(readVideoChromaFormat(configuration, createAnnexBPacket([ X264_HIGH_422_SPS, X264_PPS, AVC_IDR_SLICE ])))
            .toEqual({ location: null, subsampling: '4:2:2' });
    });

    it('reads an avc3 record without an SPS from its key packet\'s length-prefixed SPS, and an avcC with one from the record', () => {
        const configuration = { codec: 'avc3.64000a', description: AVC3_RECORD_WITHOUT_SPS };
        expect(readsChromaInBand(configuration)).toBe(true);
        expect(readVideoChromaFormat(configuration, createLengthPrefixedPacket([ X264_HIGH_BOTTOM_LEFT_SPS, X264_PPS, AVC_IDR_SLICE ])))
            .toEqual({ location: 'bottom-left', subsampling: '4:2:0' });
        expect(readsChromaInBand({ codec: 'avc1.64000a', description: createAVCRecord(AVC_HIGH_PROFILE, X264_HIGH_TOP_LEFT_SPS) })).toBe(false);
    });

    it('reads HEVC without a record, or with an hvcC without an SPS, from the key packet\'s base-layer SPS of any profile', () => {
        const annexBConfiguration = { codec: 'hev1.1.6.L60.90' };
        expect(readsChromaInBand(annexBConfiguration)).toBe(true);
        expect(readVideoChromaFormat(annexBConfiguration, createAnnexBPacket([ HEVC_ACCESS_UNIT_DELIMITER, X265_INTERLACED_BOTTOM_LEFT_SPS, HEVC_IDR_SLICE ])))
            .toEqual({ location: 'bottom-left', subsampling: '4:2:0' });
        const recordConfiguration = { codec: 'hev1.4.10.L30.90', description: createHEVCRecord(HEVC_CHROMA_FORMAT_420) };
        expect(readsChromaInBand(recordConfiguration)).toBe(true);
        expect(readVideoChromaFormat(recordConfiguration, createLengthPrefixedPacket([ X265_MAIN12_TOP_SPS, HEVC_IDR_SLICE ])))
            .toEqual({ location: 'top', subsampling: '4:2:0' });
        // An SPS of another layer does not describe the base layer
        expect(readVideoChromaFormat(annexBConfiguration, createAnnexBPacket([ withHEVCLayerID(X265_MAIN12_TOP_SPS, 1), HEVC_IDR_SLICE ])))
            .toEqual({ location: null, subsampling: null });
        expect(readsChromaInBand({ codec: 'hvc1.1.6.L30.90', description: createHEVCRecord(HEVC_CHROMA_FORMAT_420, X265_MAIN_TOP_LEFT_SPS) })).toBe(false);
    });

    it('declares nothing it does not read: no key packet, a packet without an SPS, or a packet whose framing is broken', () => {
        expect(readVideoChromaFormat({ codec: 'avc1.64000a' })).toEqual({ location: null, subsampling: null });
        expect(readVideoChromaFormat({ codec: 'avc1.64000a' }, createAnnexBPacket([ AVC_ACCESS_UNIT_DELIMITER, AVC_IDR_SLICE ])))
            .toEqual({ location: null, subsampling: null });
        expect(readVideoChromaFormat({ codec: 'avc1.64000a' }, X264_HIGH_BOTTOM_LEFT_SPS)).toEqual({ location: null, subsampling: null });
        // The record's chroma_format still names the subsampling
        expect(readVideoChromaFormat({ codec: 'avc3.64000a', description: AVC3_RECORD_WITHOUT_SPS }, createAnnexBPacket([ X264_HIGH_BOTTOM_LEFT_SPS ])))
            .toEqual({ location: null, subsampling: '4:2:0' });
        expect(readsChromaInBand({ codec: 'vp09.00.10.08' })).toBe(false);
    });
});
