import { describe, expect, it } from 'vitest';

import { readVideoChromaSubsampling } from 'webgpu-player/demux/VideoChromaSubsampling';

// An H.264 SPS of High 4:4:4 Predictive (244): NAL header, profile, constraints, level, then ue(0) seq_parameter_set_id and ue(3) chroma_format_idc
const HIGH_444_SPS = [ 0x67, 0xF4, 0x00, 0x28, 0x90 ];
// A High SPS whose zero constraint and level bytes take emulation prevention, which the reader skips: ue(0) id, then ue(1) chroma_format_idc
const HIGH_420_SPS_WITH_EMULATION_PREVENTION = [ 0x67, 0x64, 0x00, 0x00, 0x03, 0xA0 ];
const AVC_HIGH_PROFILE = 0x64;
const AVC_HIGH_444_PROFILE = 0xF4;
const AVC_MAIN_PROFILE = 0x4D;
// avcC's closing chroma_format byte for 4:2:2, its reserved bits set
const AVC_RECORD_CHROMA_FORMAT_422 = 0xFE;
// hvcC's chromaFormat codes
const HEVC_CHROMA_FORMAT_444 = 3;
const HEVC_CHROMA_FORMAT_MONOCHROME = 0;
const HVCC_HEADER_BYTE_LENGTH = 23;
const HVCC_CHROMA_FORMAT_OFFSET = 16;
const HVCC_RESERVED_BITS = 0xFC;
const HVCC_EIGHT_BIT_DEPTH_BYTE = 0xF8;
const HVCC_FOUR_BYTE_LENGTHS = 0x0F;
// av1C byte 2: subsampling x and y set is 4:2:0, x alone 4:2:2, and the monochrome bit
const AV1C_420 = 0x0C;
const AV1C_422 = 0x08;
const AV1C_MONOCHROME_420 = 0x1C;

/** Returns an avcC of one SPS and no PPS, with an optional closing chroma_format byte. */
function createAVCRecord(profile: number, sequenceParameterSet: readonly number[], chromaFormatByte: number | null = null): Uint8Array {
    const record = [ 1, profile, 0, 0x28, 0xFF, 0xE1, 0, sequenceParameterSet.length, ...sequenceParameterSet, 0 ];
    if (chromaFormatByte !== null) {
        record.push(chromaFormatByte, 0xF8, 0xF8, 0);
    }
    return Uint8Array.from(record);
}

/** Returns an hvcC header without NAL arrays, at 8 bits, of a chroma format. */
function createHEVCRecord(chromaFormat: number): Uint8Array {
    const record = new Uint8Array(HVCC_HEADER_BYTE_LENGTH);
    record[0] = 1;
    record[HVCC_CHROMA_FORMAT_OFFSET] = HVCC_RESERVED_BITS | chromaFormat;
    record[HVCC_CHROMA_FORMAT_OFFSET + 1] = HVCC_EIGHT_BIT_DEPTH_BYTE;
    record[HVCC_CHROMA_FORMAT_OFFSET + 2] = HVCC_EIGHT_BIT_DEPTH_BYTE;
    record[HVCC_HEADER_BYTE_LENGTH - 2] = HVCC_FOUR_BYTE_LENGTHS;
    return record;
}

function createAV1Record(colorByte: number): Uint8Array {
    return Uint8Array.from([ 0x81, 0x08, colorByte, 0 ]);
}

describe('readVideoChromaSubsampling', () => {
    it('reads H.264 below High as 4:2:0, and High\'s record or SPS otherwise', () => {
        expect(readVideoChromaSubsampling({ codec: 'avc1.4d401f', description: createAVCRecord(AVC_MAIN_PROFILE, HIGH_444_SPS) })).toBe('4:2:0');
        expect(readVideoChromaSubsampling({
            codec: 'avc1.640028',
            description: createAVCRecord(AVC_HIGH_PROFILE, HIGH_420_SPS_WITH_EMULATION_PREVENTION, AVC_RECORD_CHROMA_FORMAT_422)
        })).toBe('4:2:2');
        expect(readVideoChromaSubsampling({ codec: 'avc1.f40028', description: createAVCRecord(AVC_HIGH_444_PROFILE, HIGH_444_SPS) })).toBe('4:4:4');
        expect(readVideoChromaSubsampling({
            codec: 'avc1.640028',
            description: createAVCRecord(AVC_HIGH_PROFILE, HIGH_420_SPS_WITH_EMULATION_PREVENTION)
        })).toBe('4:2:0');
        expect(readVideoChromaSubsampling({ codec: 'avc1.640028' })).toBeNull();
    });

    it('reads HEVC\'s hvcC chroma format, and a monochrome stream as none', () => {
        expect(readVideoChromaSubsampling({ codec: 'hvc1.4.10.L120.90', description: createHEVCRecord(HEVC_CHROMA_FORMAT_444) })).toBe('4:4:4');
        expect(readVideoChromaSubsampling({ codec: 'hev1.4.10.L120.90', description: createHEVCRecord(HEVC_CHROMA_FORMAT_MONOCHROME) })).toBeNull();
    });

    it('reads AV1\'s av1C, else its codecs string, whose short form is 4:2:0', () => {
        expect(readVideoChromaSubsampling({ codec: 'av01.0.08M.08', description: createAV1Record(AV1C_420) })).toBe('4:2:0');
        expect(readVideoChromaSubsampling({ codec: 'av01.2.08M.10', description: createAV1Record(AV1C_422) })).toBe('4:2:2');
        expect(readVideoChromaSubsampling({ codec: 'av01.0.08M.08', description: createAV1Record(AV1C_MONOCHROME_420) })).toBeNull();
        expect(readVideoChromaSubsampling({ codec: 'av01.1.08M.10.0.000.01.01.01.0' })).toBe('4:4:4');
        expect(readVideoChromaSubsampling({ codec: 'av01.0.08M.08' })).toBe('4:2:0');
    });

    it('reads VP9\'s codecs string, and VP8 as 4:2:0', () => {
        expect(readVideoChromaSubsampling({ codec: 'vp09.01.10.08.02' })).toBe('4:2:2');
        expect(readVideoChromaSubsampling({ codec: 'vp09.01.10.08.03' })).toBe('4:4:4');
        expect(readVideoChromaSubsampling({ codec: 'vp09.00.10.08.01' })).toBe('4:2:0');
        expect(readVideoChromaSubsampling({ codec: 'vp09.00.10.08' })).toBe('4:2:0');
        expect(readVideoChromaSubsampling({ codec: 'vp8' })).toBe('4:2:0');
        expect(readVideoChromaSubsampling({ codec: 'mp4v.20.9' })).toBeNull();
    });
});
