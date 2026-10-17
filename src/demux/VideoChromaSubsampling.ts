// Reads a video track's chroma subsampling from its decoder configuration: the record in its description (avcC, hvcC, av1C) or its codecs string (AV1, VP9, VP8).
// Presentation needs it where the browser converts frames to RGB itself, to derive chroma at the stream's own size.
import { parseHEVCDecoderConfiguration } from './hevc/HEVCDecoderConfiguration';

/** A stream's chroma subsampling; 4:0:0 and anything unknown read as none, since such a stream has no chroma plane to derive. */
export type ChromaSubsampling = '4:2:0' | '4:2:2' | '4:4:4';

export const CHROMA_SUBSAMPLINGS: readonly ChromaSubsampling[] = Object.freeze([ '4:2:0', '4:2:2', '4:4:4' ]);

// The chroma format codes of chroma_format_idc, which avcC and hvcC carry; 0 is monochrome
const CHROMA_FORMAT_SUBSAMPLINGS: ReadonlyMap<number, ChromaSubsampling> = new Map<number, ChromaSubsampling>([
    [ 1, '4:2:0' ],
    [ 2, '4:2:2' ],
    [ 3, '4:4:4' ]
]);
const CHROMA_FORMAT_MASK = 0x03;

const AVC_CODEC_PREFIXES: readonly string[] = [ 'avc1', 'avc3' ];
const HEVC_CODEC_PREFIXES: readonly string[] = [ 'hvc1', 'hev1' ];
const AV1_CODEC_PREFIX = 'av01';
const VP9_CODEC_PREFIX = 'vp09';
const VP8_CODEC_NAME = 'vp8';
const CODEC_FIELD_SEPARATOR = '.';

// avcC: the profile, the SPS count's byte, and the High profiles whose record may close with chroma_format
const AVC_PROFILE_OFFSET = 1;
const AVC_SPS_COUNT_OFFSET = 5;
const AVC_SPS_COUNT_MASK = 0x1F;
const AVC_LENGTH_FIELD_BYTE_LENGTH = 2;
// The profiles below High code no chroma_format_idc, which then is 4:2:0, as High's own default is
const AVC_HIGH_PROFILE = 100;
const AVC_CHROMA_FORMAT_PROFILES: ReadonlySet<number> = new Set<number>([ 100, 110, 122, 144, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135 ]);
// The SPS's NAL header byte, then its profile, constraint, and level bytes before seq_parameter_set_id
const AVC_NAL_HEADER_BYTE_LENGTH = 1;
const AVC_SPS_FIXED_RBSP_BYTE_LENGTH = 3;
const EMULATION_PREVENTION_BYTE = 0x03;
const BITS_PER_BYTE = 8;

// av1C byte 2: seq_tier_0, high_bitdepth, twelve_bit, monochrome, chroma_subsampling_x, chroma_subsampling_y, chroma_sample_position
const AV1C_COLOR_BYTE_OFFSET = 2;
const AV1C_MONOCHROME_SHIFT = 4;
const AV1C_SUBSAMPLING_X_SHIFT = 3;
const AV1C_SUBSAMPLING_Y_SHIFT = 2;
// av01.P.LLT.DD.M.CCC: the monochrome flag and the chroma field, whose first two digits are subsampling x and y
const AV1_MONOCHROME_FIELD_INDEX = 4;
const AV1_CHROMA_FIELD_INDEX = 5;
// vp09.PP.LL.DD.CC: 0 and 1 are 4:2:0 at two sitings, 2 is 4:2:2, and 3 is 4:4:4
const VP9_CHROMA_FIELD_INDEX = 4;
const VP9_CHROMA_SUBSAMPLINGS: ReadonlyMap<number, ChromaSubsampling> = new Map<number, ChromaSubsampling>([
    [ 0, '4:2:0' ],
    [ 1, '4:2:0' ],
    [ 2, '4:2:2' ],
    [ 3, '4:4:4' ]
]);
// What a short AV1 or VP9 codecs string implies
const SHORT_CODEC_STRING_SUBSAMPLING: ChromaSubsampling = '4:2:0';

export function isChromaSubsampling(value: unknown): value is ChromaSubsampling {
    return typeof value === 'string' && (CHROMA_SUBSAMPLINGS as readonly string[]).includes(value);
}

function toBytes(description: AllowSharedBufferSource): Uint8Array {
    if (ArrayBuffer.isView(description)) {
        return new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
    }
    return new Uint8Array(description);
}

function getSubsamplingOfDivisions(horizontal: number, vertical: number): ChromaSubsampling | null {
    if (horizontal === 1 && vertical === 1) {
        return '4:2:0';
    }
    if (horizontal === 1 && vertical === 0) {
        return '4:2:2';
    }
    return horizontal === 0 && vertical === 0 ? '4:4:4' : null;
}

/** Reads unsigned Exp-Golomb codes from a NAL unit's RBSP, its payload without emulation prevention bytes, from a byte of the RBSP on. */
class ExpGolombReader {
    private bitOffset: number;
    private readonly bytes: number[] = [];

    constructor(nalUnit: Uint8Array, rbspStartOffset: number) {
        let zeroCount = 0;
        for (let offset = AVC_NAL_HEADER_BYTE_LENGTH; offset < nalUnit.byteLength; offset += 1) {
            const value = nalUnit[offset];
            if (zeroCount >= 2 && value === EMULATION_PREVENTION_BYTE) {
                zeroCount = 0;
                continue;
            }
            zeroCount = value === 0 ? zeroCount + 1 : 0;
            this.bytes.push(value);
        }
        this.bitOffset = rbspStartOffset * BITS_PER_BYTE;
    }

    readUnsigned(): number | null {
        let leadingZeros = 0;
        for (;;) {
            const bit = this.readBit();
            if (bit === null) {
                return null;
            }
            if (bit === 1) {
                break;
            }
            leadingZeros += 1;
        }
        let value = 0;
        for (let bitIndex = 0; bitIndex < leadingZeros; bitIndex += 1) {
            const bit = this.readBit();
            if (bit === null) {
                return null;
            }
            value = (value * 2) + bit;
        }
        return (2 ** leadingZeros) - 1 + value;
    }

    private readBit(): number | null {
        const byte = this.bytes.at(this.bitOffset >> 3);
        if (byte === undefined) {
            return null;
        }
        const bit = (byte >> (7 - (this.bitOffset & 7))) & 1;
        this.bitOffset += 1;
        return bit;
    }
}

/** Reads chroma_format_idc from an H.264 SPS of a High profile: the code after seq_parameter_set_id. */
function readAVCSPSChromaFormat(sequenceParameterSet: Uint8Array): number | null {
    const reader = new ExpGolombReader(sequenceParameterSet, AVC_SPS_FIXED_RBSP_BYTE_LENGTH);
    return reader.readUnsigned() === null ? null : reader.readUnsigned();
}

/** Reads an avcC: its closing chroma_format for the High profiles that carry one, else its first SPS, and 4:2:0 for the profiles below High. */
function readAVCChromaSubsampling(record: Uint8Array): ChromaSubsampling | null {
    if (record.byteLength <= AVC_SPS_COUNT_OFFSET) {
        return null;
    }
    const profile = record[AVC_PROFILE_OFFSET];
    if (!AVC_CHROMA_FORMAT_PROFILES.has(profile)) {
        return '4:2:0';
    }
    let offset = AVC_SPS_COUNT_OFFSET + 1;
    let firstSequenceParameterSet: Uint8Array | null = null;
    const sequenceParameterSetCount = record[AVC_SPS_COUNT_OFFSET] & AVC_SPS_COUNT_MASK;
    for (let index = 0; index < sequenceParameterSetCount && offset + AVC_LENGTH_FIELD_BYTE_LENGTH <= record.byteLength; index += 1) {
        const length = (record[offset] << 8) | record[offset + 1];
        offset += AVC_LENGTH_FIELD_BYTE_LENGTH;
        firstSequenceParameterSet ??= record.subarray(offset, offset + length);
        offset += length;
    }
    const pictureParameterSetCount = record.at(offset);
    offset += 1;
    for (let index = 0; pictureParameterSetCount !== undefined && index < pictureParameterSetCount && offset + AVC_LENGTH_FIELD_BYTE_LENGTH <= record.byteLength; index += 1) {
        offset += AVC_LENGTH_FIELD_BYTE_LENGTH + ((record[offset] << 8) | record[offset + 1]);
    }
    const recordChromaFormat = record.at(offset);
    if (recordChromaFormat !== undefined) {
        return CHROMA_FORMAT_SUBSAMPLINGS.get(recordChromaFormat & CHROMA_FORMAT_MASK) ?? null;
    }
    const spsChromaFormat = firstSequenceParameterSet === null ? null : readAVCSPSChromaFormat(firstSequenceParameterSet);
    if (spsChromaFormat !== null) {
        return CHROMA_FORMAT_SUBSAMPLINGS.get(spsChromaFormat) ?? null;
    }
    return profile === AVC_HIGH_PROFILE ? '4:2:0' : null;
}

function readHEVCChromaSubsampling(description: AllowSharedBufferSource): ChromaSubsampling | null {
    try {
        return CHROMA_FORMAT_SUBSAMPLINGS.get(parseHEVCDecoderConfiguration(description).chromaFormat) ?? null;
    } catch {
        return null;
    }
}

function readAV1RecordChromaSubsampling(record: Uint8Array): ChromaSubsampling | null {
    const colorByte = record.at(AV1C_COLOR_BYTE_OFFSET);
    if (colorByte === undefined || ((colorByte >> AV1C_MONOCHROME_SHIFT) & 1) === 1) {
        return null;
    }
    return getSubsamplingOfDivisions((colorByte >> AV1C_SUBSAMPLING_X_SHIFT) & 1, (colorByte >> AV1C_SUBSAMPLING_Y_SHIFT) & 1);
}

function readAV1CodecStringChromaSubsampling(fields: readonly string[]): ChromaSubsampling | null {
    const chromaField = fields.at(AV1_CHROMA_FIELD_INDEX);
    if (chromaField === undefined) {
        return SHORT_CODEC_STRING_SUBSAMPLING;
    }
    if (fields[AV1_MONOCHROME_FIELD_INDEX] === '1') {
        return null;
    }
    return getSubsamplingOfDivisions(Number(chromaField[0]), Number(chromaField[1]));
}

function readVP9CodecStringChromaSubsampling(fields: readonly string[]): ChromaSubsampling | null {
    const chromaField = fields.at(VP9_CHROMA_FIELD_INDEX);
    return chromaField === undefined ? SHORT_CODEC_STRING_SUBSAMPLING : VP9_CHROMA_SUBSAMPLINGS.get(Number(chromaField)) ?? null;
}

/**
 * Returns the chroma subsampling a video decoder configuration declares, or null when it declares none or the stream is monochrome.
 * H.264 reads its avcC, HEVC its hvcC, AV1 its av1C or its codecs string, VP9 its codecs string, and VP8 is always 4:2:0.
 */
export function readVideoChromaSubsampling(configuration: VideoDecoderConfig): ChromaSubsampling | null {
    const fields = configuration.codec.split(CODEC_FIELD_SEPARATOR);
    const codecName = fields[0];
    const description = configuration.description === undefined ? null : toBytes(configuration.description);
    if (AVC_CODEC_PREFIXES.includes(codecName)) {
        return description === null ? null : readAVCChromaSubsampling(description);
    }
    if (HEVC_CODEC_PREFIXES.includes(codecName)) {
        return description === null ? null : readHEVCChromaSubsampling(description);
    }
    switch (codecName) {
        case AV1_CODEC_PREFIX:
            return description === null ? readAV1CodecStringChromaSubsampling(fields) : readAV1RecordChromaSubsampling(description);
        case VP9_CODEC_PREFIX:
            return readVP9CodecStringChromaSubsampling(fields);
        case VP8_CODEC_NAME:
            return '4:2:0';
        default:
            return null;
    }
}
