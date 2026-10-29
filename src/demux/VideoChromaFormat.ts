// Reads a video track's chroma from its decoder configuration: the record in its description (avcC, hvcC, av1C), the SPS in its first key packet
// where it has no record or its record carries no SPS, or its codecs string (AV1, VP9, VP8, MPEG-1).
// Its subsampling sizes the chroma that presentation derives where the browser converts frames to RGB itself, and its location is where every route reads 4:2:0 chroma.
import { getHEVCNALUnitLayerID, HEVC_BASE_LAYER_ID } from './dolby-vision/DolbyVisionHEVCSplitter';
import { type HEVCDecoderConfiguration, parseHEVCDecoderConfiguration } from './hevc/HEVCDecoderConfiguration';
import { type HEVCSPSChroma, readHEVCSPSChroma } from './hevc/HEVCSPSParser';
import { type NALUnitLengthSize, splitAnnexBNALUnits, splitLengthPrefixedNALUnits } from './NALUnitFraming';

/** A stream's chroma subsampling; 4:0:0 and anything unknown read as none, since such a stream has no chroma plane to derive. */
export type ChromaSubsampling = '4:2:0' | '4:2:2' | '4:4:4';

/**
 * Where a 4:2:0 stream's chroma samples lie among its luma samples, H.273's chroma sample location types 0 to 5 in order:
 * on the left luma column between two rows, the default of H.264 and HEVC; between two columns and two rows; on the top-left luma sample, as BT.2020 sites it;
 * between two columns on the top row; on the left column of the bottom row; and between two columns on the bottom row.
 */
export type ChromaLocation = 'left' | 'center' | 'top-left' | 'top' | 'bottom-left' | 'bottom';

/** The chroma a video track's decoder configuration declares; a null member is one it does not declare. */
export type VideoChromaFormat = {
    /** Declared for 4:2:0 only, the subsampling the location types describe */
    location: ChromaLocation | null
    subsampling: ChromaSubsampling | null
};

export const CHROMA_SUBSAMPLINGS: readonly ChromaSubsampling[] = Object.freeze([ '4:2:0', '4:2:2', '4:4:4' ]);
// In chroma_sample_loc_type order
export const CHROMA_LOCATIONS: readonly ChromaLocation[] = Object.freeze([ 'left', 'center', 'top-left', 'top', 'bottom-left', 'bottom' ]);

const UNDECLARED_CHROMA_FORMAT: VideoChromaFormat = Object.freeze({ location: null, subsampling: null });

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
// The engine's name of MPEG-1 video, which the mpeg2 decoder package decodes
const MPEG1_CODEC_NAME = 'mpeg1video';
const CODEC_FIELD_SEPARATOR = '.';

// What failures of a key packet's framing name it
const KEY_PACKET_SUBJECT = 'key packet';
// NAL unit headers: H.264's nal_unit_type of an SPS in its one-byte header, and HEVC's in its two-byte header
const AVC_NAL_UNIT_TYPE_MASK = 0x1F;
const AVC_SPS_NAL_UNIT_TYPE = 7;
const HEVC_NAL_HEADER_BYTE_LENGTH = 2;
const HEVC_NAL_UNIT_TYPE_MASK = 0x3F;
const HEVC_SPS_NAL_UNIT_TYPE = 33;
// avcC: the profile, lengthSizeMinusOne, the SPS count's byte, and the High profiles whose record may close with chroma_format
const AVC_PROFILE_OFFSET = 1;
const AVC_LENGTH_SIZE_OFFSET = 4;
const NAL_UNIT_LENGTH_SIZE_MINUS_ONE_MASK = 0x03;
const AVC_SPS_COUNT_OFFSET = 5;
const AVC_SPS_COUNT_MASK = 0x1F;
const AVC_LENGTH_FIELD_BYTE_LENGTH = 2;
// avcC's High profile extension: chroma_format, bit_depth_luma_minus8, and bit_depth_chroma_minus8 behind their reserved bits, then numOfSequenceParameterSetExt
const AVC_RECORD_EXTENSION_BYTE_LENGTH = 4;
const AVC_CHROMA_FORMAT_RESERVED_BITS = 0xFC;
const AVC_BIT_DEPTH_RESERVED_BITS = 0xF8;
// The profiles below High code no chroma_format_idc, which then is 4:2:0, as High's own default is
const AVC_HIGH_PROFILE = 100;
const AVC_CHROMA_FORMAT_PROFILES: ReadonlySet<number> = new Set<number>([ 100, 110, 122, 144, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135 ]);
// The SPS's NAL header byte, then its constraint and level bytes after its profile, before seq_parameter_set_id
const AVC_NAL_HEADER_BYTE_LENGTH = 1;
const AVC_CONSTRAINT_AND_LEVEL_BIT_LENGTH = 16;
const EMULATION_PREVENTION_BYTE = 0x03;
const BITS_PER_BYTE = 8;
const MAXIMUM_EXP_GOLOMB_LEADING_ZEROS = 31;
// The SPS fields before its VUI: 4:4:4's separate plane flag and extra scaling lists, the sizes of the 4x4 and 8x8 lists, and the
// pic_order_cnt_type values that code more fields
const AVC_CHROMA_FORMAT_444 = 3;
const AVC_SCALING_LIST_COUNT = 8;
const AVC_444_SCALING_LIST_COUNT = 12;
const AVC_4X4_SCALING_LIST_COUNT = 6;
const AVC_4X4_SCALING_LIST_SIZE = 16;
const AVC_8X8_SCALING_LIST_SIZE = 64;
const AVC_DEFAULT_SCALE = 8;
const AVC_SCALE_MODULUS = 256;
const AVC_PICTURE_ORDER_COUNT_LSB_TYPE = 0;
const AVC_PICTURE_ORDER_COUNT_CYCLE_TYPE = 1;
const AVC_FRAME_CROPPING_OFFSET_COUNT = 4;
// The VUI fields before chroma_loc_info: an extended aspect ratio's SAR, video_format with the full range flag, and the colour description
const AVC_EXTENDED_SAR_ASPECT_RATIO = 255;
const AVC_SAR_BIT_LENGTH = 32;
const AVC_VIDEO_FORMAT_AND_RANGE_BIT_LENGTH = 4;
const AVC_COLOUR_DESCRIPTION_BIT_LENGTH = 24;

// av1C byte 2: seq_tier_0, high_bitdepth, twelve_bit, monochrome, chroma_subsampling_x, chroma_subsampling_y, chroma_sample_position
const AV1C_COLOR_BYTE_OFFSET = 2;
const AV1C_MONOCHROME_SHIFT = 4;
const AV1C_SUBSAMPLING_X_SHIFT = 3;
const AV1C_SUBSAMPLING_Y_SHIFT = 2;
const AV1C_CHROMA_SAMPLE_POSITION_MASK = 0x03;
// av01.P.LLT.DD.M.CCC: the monochrome flag and the chroma field, whose digits are subsampling x and y, then chroma_sample_position
const AV1_MONOCHROME_FIELD_INDEX = 4;
const AV1_CHROMA_FIELD_INDEX = 5;
const AV1_CHROMA_SAMPLE_POSITION_DIGIT_INDEX = 2;
// chroma_sample_position 1 is CSP_VERTICAL, on the left column between rows, and 2 is CSP_COLOCATED; 0 is unknown and 3 reserved
const AV1_CHROMA_SAMPLE_POSITION_LOCATIONS: ReadonlyMap<number, ChromaLocation> = new Map<number, ChromaLocation>([
    [ 1, 'left' ],
    [ 2, 'top-left' ]
]);
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

export function isChromaLocation(value: unknown): value is ChromaLocation {
    return typeof value === 'string' && (CHROMA_LOCATIONS as readonly string[]).includes(value);
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

/** Returns the location of a chroma_sample_loc_type, or null for a value past the six types. */
function getChromaLocationOfType(locationType: number | null): ChromaLocation | null {
    return locationType === null ? null : CHROMA_LOCATIONS[locationType] ?? null;
}

/** Reads bits and Exp-Golomb codes from an H.264 NAL unit's RBSP, its payload after the NAL header without emulation prevention bytes; a read past its end throws. */
class RBSPReader {
    private bitOffset = 0;
    private readonly bytes: number[] = [];

    constructor(nalUnit: Uint8Array) {
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
    }

    readBits(bitCount: number): number {
        let value = 0;
        for (let bitIndex = 0; bitIndex < bitCount; bitIndex += 1) {
            const byte = this.bytes.at(this.bitOffset >> 3);
            if (byte === undefined) {
                throw new RangeError('rbsp: read past its end');
            }
            value = (value * 2) + ((byte >> (7 - (this.bitOffset & 7))) & 1);
            this.bitOffset += 1;
        }
        return value;
    }

    readFlag(): boolean {
        return this.readBits(1) === 1;
    }

    skipBits(bitCount: number): void {
        this.readBits(bitCount);
    }

    readUnsigned(): number {
        let leadingZeros = 0;
        while (!this.readFlag()) {
            leadingZeros += 1;
            if (leadingZeros > MAXIMUM_EXP_GOLOMB_LEADING_ZEROS) {
                throw new RangeError('rbsp: exp-golomb code too long');
            }
        }
        return (2 ** leadingZeros) - 1 + this.readBits(leadingZeros);
    }

    readSigned(): number {
        const code = this.readUnsigned();
        return code % 2 === 1 ? (code + 1) / 2 : -(code / 2);
    }
}

/** Skips one scaling_list() of an H.264 SPS: its delta_scale codes, which continue while the next scale is not zero. */
function skipAVCScalingList(reader: RBSPReader, size: number): void {
    let lastScale = AVC_DEFAULT_SCALE;
    let nextScale = AVC_DEFAULT_SCALE;
    for (let index = 0; index < size; index += 1) {
        if (nextScale !== 0) {
            nextScale = (lastScale + reader.readSigned() + AVC_SCALE_MODULUS) % AVC_SCALE_MODULUS;
        }
        lastScale = nextScale === 0 ? lastScale : nextScale;
    }
}

/** Skips an H.264 SPS's picture order count fields, which pic_order_cnt_type selects. */
function skipAVCPictureOrderCount(reader: RBSPReader): void {
    const pictureOrderCountType = reader.readUnsigned();
    switch (pictureOrderCountType) {
        case AVC_PICTURE_ORDER_COUNT_LSB_TYPE:
            // log2_max_pic_order_cnt_lsb_minus4
            reader.readUnsigned();
            return;
        case AVC_PICTURE_ORDER_COUNT_CYCLE_TYPE: {
            // delta_pic_order_always_zero_flag, offset_for_non_ref_pic, offset_for_top_to_bottom_field, then the cycle's offsets
            reader.skipBits(1);
            reader.readSigned();
            reader.readSigned();
            const cycleLength = reader.readUnsigned();
            for (let frameIndex = 0; frameIndex < cycleLength; frameIndex += 1) {
                reader.readSigned();
            }
            return;
        }
        default:
            return;
    }
}

/** Skips an H.264 SPS's chroma_format_idc, its bit depths, and its scaling matrix, which only the High profiles code. */
function skipAVCChromaFormatFields(reader: RBSPReader): void {
    const chromaFormat = reader.readUnsigned();
    if (chromaFormat === AVC_CHROMA_FORMAT_444) {
        // separate_colour_plane_flag
        reader.skipBits(1);
    }
    // bit_depth_luma_minus8, bit_depth_chroma_minus8, and qpprime_y_zero_transform_bypass_flag
    reader.readUnsigned();
    reader.readUnsigned();
    reader.skipBits(1);
    if (!reader.readFlag()) {
        return;
    }
    const listCount = chromaFormat === AVC_CHROMA_FORMAT_444 ? AVC_444_SCALING_LIST_COUNT : AVC_SCALING_LIST_COUNT;
    for (let listIndex = 0; listIndex < listCount; listIndex += 1) {
        if (reader.readFlag()) {
            skipAVCScalingList(reader, listIndex < AVC_4X4_SCALING_LIST_COUNT ? AVC_4X4_SCALING_LIST_SIZE : AVC_8X8_SCALING_LIST_SIZE);
        }
    }
}

/**
 * Reads an H.264 SPS as far as its VUI's chroma_loc_info and returns the top field's chroma_sample_loc_type, which a frame's chroma takes,
 * or null when the SPS declares none. Throws when the SPS ends first.
 */
function readAVCSPSChromaLocationType(sequenceParameterSet: Uint8Array): number | null {
    const reader = new RBSPReader(sequenceParameterSet);
    const profile = reader.readBits(BITS_PER_BYTE);
    reader.skipBits(AVC_CONSTRAINT_AND_LEVEL_BIT_LENGTH);
    // seq_parameter_set_id
    reader.readUnsigned();
    if (AVC_CHROMA_FORMAT_PROFILES.has(profile)) {
        skipAVCChromaFormatFields(reader);
    }
    // log2_max_frame_num_minus4
    reader.readUnsigned();
    skipAVCPictureOrderCount(reader);
    // max_num_ref_frames, gaps_in_frame_num_value_allowed_flag, pic_width_in_mbs_minus1, and pic_height_in_map_units_minus1
    reader.readUnsigned();
    reader.skipBits(1);
    reader.readUnsigned();
    reader.readUnsigned();
    // frame_mbs_only_flag, which a field-coded stream follows with mb_adaptive_frame_field_flag, then direct_8x8_inference_flag
    if (!reader.readFlag()) {
        reader.skipBits(1);
    }
    reader.skipBits(1);
    if (reader.readFlag()) {
        for (let offsetIndex = 0; offsetIndex < AVC_FRAME_CROPPING_OFFSET_COUNT; offsetIndex += 1) {
            reader.readUnsigned();
        }
    }
    if (!reader.readFlag()) {
        return null;
    }
    // aspect_ratio_info, overscan_info, and video_signal_type, each behind its present flag
    if (reader.readFlag() && reader.readBits(BITS_PER_BYTE) === AVC_EXTENDED_SAR_ASPECT_RATIO) {
        reader.skipBits(AVC_SAR_BIT_LENGTH);
    }
    if (reader.readFlag()) {
        reader.skipBits(1);
    }
    if (reader.readFlag()) {
        reader.skipBits(AVC_VIDEO_FORMAT_AND_RANGE_BIT_LENGTH);
        if (reader.readFlag()) {
            reader.skipBits(AVC_COLOUR_DESCRIPTION_BIT_LENGTH);
        }
    }
    return reader.readFlag() ? reader.readUnsigned() : null;
}

/** Returns the chroma location an H.264 SPS declares, or null when it declares none or ends first. */
function readAVCSPSChromaLocation(sequenceParameterSet: Uint8Array): ChromaLocation | null {
    try {
        return getChromaLocationOfType(readAVCSPSChromaLocationType(sequenceParameterSet));
    } catch {
        return null;
    }
}

/** Returns an H.264 SPS's chroma_format_idc, the code after seq_parameter_set_id of a High profile's SPS, or null when the SPS ends first. */
function readAVCSPSChromaFormat(sequenceParameterSet: Uint8Array): number | null {
    try {
        const reader = new RBSPReader(sequenceParameterSet);
        reader.skipBits(BITS_PER_BYTE + AVC_CONSTRAINT_AND_LEVEL_BIT_LENGTH);
        reader.readUnsigned();
        return reader.readUnsigned();
    } catch {
        return null;
    }
}

/** Reads an avcC's subsampling: its closing chroma_format for the High profiles that carry one, else its first SPS's, and 4:2:0 for the profiles below High. */
function readAVCChromaSubsampling(profile: number, recordChromaFormat: number | undefined, firstSequenceParameterSet: Uint8Array | null): ChromaSubsampling | null {
    if (!AVC_CHROMA_FORMAT_PROFILES.has(profile)) {
        return '4:2:0';
    }
    if (recordChromaFormat !== undefined) {
        return CHROMA_FORMAT_SUBSAMPLINGS.get(recordChromaFormat & CHROMA_FORMAT_MASK) ?? null;
    }
    const spsChromaFormat = firstSequenceParameterSet === null ? null : readAVCSPSChromaFormat(firstSequenceParameterSet);
    if (spsChromaFormat !== null) {
        return CHROMA_FORMAT_SUBSAMPLINGS.get(spsChromaFormat) ?? null;
    }
    return profile === AVC_HIGH_PROFILE ? '4:2:0' : null;
}

/** What an avcC holds for chroma: its profile, its NAL unit length size, its first SPS, and the chroma_format a High profile's record may close with. */
type AVCRecord = {
    chromaFormat: number | undefined
    firstSequenceParameterSet: Uint8Array | null
    lengthSize: NALUnitLengthSize
    profile: number
};

/** Reads an avcC, or returns null for one too short to name its SPS count. */
function parseAVCRecord(record: Uint8Array): AVCRecord | null {
    if (record.byteLength <= AVC_SPS_COUNT_OFFSET) {
        return null;
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
    return {
        chromaFormat: readAVCRecordExtensionChromaFormat(record, offset),
        firstSequenceParameterSet,
        lengthSize: (record[AVC_LENGTH_SIZE_OFFSET] & NAL_UNIT_LENGTH_SIZE_MINUS_ONE_MASK) + 1 as NALUnitLengthSize,
        profile: record[AVC_PROFILE_OFFSET]
    };
}

/**
 * Returns the chroma_format of a High profile avcC's extension at an offset, or undefined where the record carries none.
 * The four bytes up to numOfSequenceParameterSetExt count as the extension only when they all exist and their reserved bits are set,
 * since some muxers end a record with other bytes, whose low bits would otherwise read as a chroma format; the SPS then declares it.
 */
function readAVCRecordExtensionChromaFormat(record: Uint8Array, offset: number): number | undefined {
    if (
        offset + AVC_RECORD_EXTENSION_BYTE_LENGTH > record.byteLength
        || (record[offset] & AVC_CHROMA_FORMAT_RESERVED_BITS) !== AVC_CHROMA_FORMAT_RESERVED_BITS
        || (record[offset + 1] & AVC_BIT_DEPTH_RESERVED_BITS) !== AVC_BIT_DEPTH_RESERVED_BITS
        || (record[offset + 2] & AVC_BIT_DEPTH_RESERVED_BITS) !== AVC_BIT_DEPTH_RESERVED_BITS
    ) {
        return undefined;
    }
    return record[offset] & CHROMA_FORMAT_MASK;
}

/**
 * Returns the first NAL unit of a key packet that is an SPS, or null without one or when the packet's framing is broken.
 * The packet is length-prefixed where its track has a decoder record, and Annex B where it has none.
 */
function findInBandSequenceParameterSet(
    keyPacket: Uint8Array | null,
    lengthSize: NALUnitLengthSize | null,
    isSequenceParameterSet: (nalUnit: Uint8Array) => boolean
): Uint8Array | null {
    if (keyPacket === null) {
        return null;
    }
    try {
        const nalUnits = lengthSize === null ?
            splitAnnexBNALUnits(keyPacket, KEY_PACKET_SUBJECT) :
            splitLengthPrefixedNALUnits(keyPacket, lengthSize, KEY_PACKET_SUBJECT);
        return nalUnits.find(isSequenceParameterSet) ?? null;
    } catch {
        return null;
    }
}

/** Reads H.264's chroma: its subsampling from its avcC or its SPS, and the location the SPS declares for 4:2:0, from the record's first SPS, else the key packet's. */
function readAVCChromaFormat(record: Uint8Array | null, keyPacket: Uint8Array | null): VideoChromaFormat {
    const parsedRecord = record === null ? null : parseAVCRecord(record);
    if (record !== null && parsedRecord === null) {
        return UNDECLARED_CHROMA_FORMAT;
    }
    const sequenceParameterSet = parsedRecord?.firstSequenceParameterSet ?? findInBandSequenceParameterSet(
        keyPacket,
        parsedRecord?.lengthSize ?? null,
        (nalUnit: Uint8Array): boolean => (nalUnit[0] & AVC_NAL_UNIT_TYPE_MASK) === AVC_SPS_NAL_UNIT_TYPE
    );
    const profile = parsedRecord?.profile ?? sequenceParameterSet?.at(AVC_NAL_HEADER_BYTE_LENGTH);
    if (profile === undefined) {
        return UNDECLARED_CHROMA_FORMAT;
    }
    const subsampling = readAVCChromaSubsampling(profile, parsedRecord?.chromaFormat, sequenceParameterSet);
    const location = subsampling === '4:2:0' && sequenceParameterSet !== null ? readAVCSPSChromaLocation(sequenceParameterSet) : null;
    return { location, subsampling };
}

/** Returns the chroma an HEVC SPS of any profile declares, or null when its syntax is broken. */
function readHEVCSequenceParameterSetChroma(sequenceParameterSet: Uint8Array): HEVCSPSChroma | null {
    try {
        return readHEVCSPSChroma(sequenceParameterSet);
    } catch {
        return null;
    }
}

/** Reads HEVC's chroma: its format from its hvcC or its SPS, and the location the SPS declares for 4:2:0, from the record's first SPS, else the key packet's. */
function readHEVCChromaFormat(description: Uint8Array | null, keyPacket: Uint8Array | null): VideoChromaFormat {
    let configuration: HEVCDecoderConfiguration | null = null;
    if (description !== null) {
        try {
            configuration = parseHEVCDecoderConfiguration(description);
        } catch {
            return UNDECLARED_CHROMA_FORMAT;
        }
    }
    const sequenceParameterSet = configuration?.sequenceParameterSets.at(0) ?? findInBandSequenceParameterSet(
        keyPacket,
        configuration?.lengthSize ?? null,
        (nalUnit: Uint8Array): boolean => nalUnit.byteLength >= HEVC_NAL_HEADER_BYTE_LENGTH
            && ((nalUnit[0] >> 1) & HEVC_NAL_UNIT_TYPE_MASK) === HEVC_SPS_NAL_UNIT_TYPE
            && getHEVCNALUnitLayerID(nalUnit) === HEVC_BASE_LAYER_ID
    );
    const spsChroma = sequenceParameterSet === null ? null : readHEVCSequenceParameterSetChroma(sequenceParameterSet);
    const chromaFormat = configuration?.chromaFormat ?? spsChroma?.chromaFormat;
    const subsampling = chromaFormat === undefined ? null : CHROMA_FORMAT_SUBSAMPLINGS.get(chromaFormat) ?? null;
    const location = subsampling === '4:2:0' ? getChromaLocationOfType(spsChroma?.chromaSampleLocationType ?? null) : null;
    return { location, subsampling };
}

/** Returns the location of an AV1 chroma_sample_position, which only 4:2:0 codes. */
function getAV1ChromaLocation(subsampling: ChromaSubsampling | null, chromaSamplePosition: number): ChromaLocation | null {
    return subsampling === '4:2:0' ? AV1_CHROMA_SAMPLE_POSITION_LOCATIONS.get(chromaSamplePosition) ?? null : null;
}

function readAV1RecordChromaFormat(record: Uint8Array): VideoChromaFormat {
    const colorByte = record.at(AV1C_COLOR_BYTE_OFFSET);
    if (colorByte === undefined || ((colorByte >> AV1C_MONOCHROME_SHIFT) & 1) === 1) {
        return UNDECLARED_CHROMA_FORMAT;
    }
    const subsampling = getSubsamplingOfDivisions((colorByte >> AV1C_SUBSAMPLING_X_SHIFT) & 1, (colorByte >> AV1C_SUBSAMPLING_Y_SHIFT) & 1);
    return { location: getAV1ChromaLocation(subsampling, colorByte & AV1C_CHROMA_SAMPLE_POSITION_MASK), subsampling };
}

function readAV1CodecStringChromaFormat(fields: readonly string[]): VideoChromaFormat {
    const chromaField = fields.at(AV1_CHROMA_FIELD_INDEX);
    if (chromaField === undefined) {
        // The short form's chroma_sample_position is CSP_UNKNOWN
        return { location: null, subsampling: SHORT_CODEC_STRING_SUBSAMPLING };
    }
    if (fields[AV1_MONOCHROME_FIELD_INDEX] === '1') {
        return UNDECLARED_CHROMA_FORMAT;
    }
    const subsampling = getSubsamplingOfDivisions(Number(chromaField[0]), Number(chromaField[1]));
    return { location: getAV1ChromaLocation(subsampling, Number(chromaField[AV1_CHROMA_SAMPLE_POSITION_DIGIT_INDEX])), subsampling };
}

/**
 * Reads VP9's subsampling from its codecs string, without a location: muxers write the colocated 4:2:0 value for chroma of unknown siting,
 * as FFmpeg does unless its source is known left, and Mediabunny names WebM's that way, so the field does not declare where chroma lies.
 */
function readVP9CodecStringChromaFormat(fields: readonly string[]): VideoChromaFormat {
    const chromaField = fields.at(VP9_CHROMA_FIELD_INDEX);
    const subsampling = chromaField === undefined ? SHORT_CODEC_STRING_SUBSAMPLING : VP9_CHROMA_SUBSAMPLINGS.get(Number(chromaField)) ?? null;
    return { location: null, subsampling };
}

/**
 * Returns whether an H.264 or HEVC configuration leaves its SPS to the stream, so its chroma is read from the first key packet's in-band SPS:
 * a track without a decoder record, as MPEG-TS, M2TS, and Annex B AVI tracks are, or with a record that carries no SPS, as an avc3 or hev1 track's may.
 */
export function readsChromaInBand(configuration: VideoDecoderConfig): boolean {
    const codecName = configuration.codec.split(CODEC_FIELD_SEPARATOR)[0];
    const description = configuration.description === undefined ? null : toBytes(configuration.description);
    if (AVC_CODEC_PREFIXES.includes(codecName)) {
        return description === null || parseAVCRecord(description)?.firstSequenceParameterSet === null;
    }
    if (!HEVC_CODEC_PREFIXES.includes(codecName)) {
        return false;
    }
    if (description === null) {
        return true;
    }
    try {
        return parseHEVCDecoderConfiguration(description).sequenceParameterSets.length === 0;
    } catch {
        return false;
    }
}

/**
 * Returns the chroma a video decoder configuration declares: its subsampling, null when it declares none or the stream is monochrome,
 * and for 4:2:0 its chroma location, null when it declares none.
 * H.264 reads its avcC and its first SPS's VUI, HEVC its hvcC and its first SPS's VUI, the SPS being the record's first,
 * else the first in the stream's first key packet, which a caller passes where `readsChromaInBand` holds.
 * AV1 reads its av1C or its codecs string, VP9 its codecs string, VP8 is always 4:2:0, and MPEG-1 always center-sited 4:2:0, as FFmpeg's mpeg12dec.c sets it.
 */
export function readVideoChromaFormat(configuration: VideoDecoderConfig, keyPacket: Uint8Array | null = null): VideoChromaFormat {
    const fields = configuration.codec.split(CODEC_FIELD_SEPARATOR);
    const codecName = fields[0];
    const description = configuration.description === undefined ? null : toBytes(configuration.description);
    if (AVC_CODEC_PREFIXES.includes(codecName)) {
        return readAVCChromaFormat(description, keyPacket);
    }
    if (HEVC_CODEC_PREFIXES.includes(codecName)) {
        return readHEVCChromaFormat(description, keyPacket);
    }
    switch (codecName) {
        case AV1_CODEC_PREFIX:
            return description === null ? readAV1CodecStringChromaFormat(fields) : readAV1RecordChromaFormat(description);
        case VP9_CODEC_PREFIX:
            return readVP9CodecStringChromaFormat(fields);
        case VP8_CODEC_NAME:
            return { location: null, subsampling: '4:2:0' };
        case MPEG1_CODEC_NAME:
            return { location: 'center', subsampling: '4:2:0' };
        default:
            return UNDECLARED_CHROMA_FORMAT;
    }
}
