// Synthetic VC-1 and WMV3 media for the container tests: sequence and picture headers with the fields the engine reads, Matroska Video for
// Windows files, and ISO base media files with a vc-1 sample entry. Pictures carry only the header bits that place their type.

import { concatenate } from './byteArrays';
import { createBox, createVideoTrackISOBaseMedia, createVisualSampleEntry, encodeUnsigned32 } from './isoBaseMediaBoxes';
import { createVideoTrackMatroska } from './matroskaElements';

/** The STRUCT_C fields that place a WMV3 picture's type, and its profile: 0 Simple, 1 Main, 2 Complex. */
export type WMV3SequenceFields = Readonly<{
    frameInterpolation: boolean
    maximumBFrames: number
    profile: number
    rangeReduction: boolean
}>;

/** A picture type as VC-1 codes it; a skipped P picture is coded only in the Advanced profile. */
export type VC1PictureKind = 'B' | 'BI' | 'I' | 'P' | 'skipped-P';

/** How an Advanced profile picture is coded: progressive, as an interlaced frame, or as a field pair of an FPTYPE. */
export type VC1AdvancedPictureCoding =
    | Readonly<{ kind: VC1PictureKind, mode: 'frame-interlace' | 'progressive' }>
    | Readonly<{ fieldPictureType: number, mode: 'field-interlace' }>;

/** One Matroska block or ISO base media sample of a synthetic track. */
export type SyntheticVC1Packet = Readonly<{
    data: Uint8Array
    keyframe: boolean
    /** Milliseconds, as a Matroska block stores it, or the sample's presentation time in an ISO base media file */
    timestampMilliseconds: number
}>;

export const VC1_TEST_FRAME_DURATION_MILLISECONDS = 40;
export const BITMAP_INFO_HEADER_BYTE_LENGTH = 40;

// Start codes: a 0x000001 prefix and the type
const START_CODE_PREFIX = Object.freeze([ 0x00, 0x00, 0x01 ]);
const SEQUENCE_HEADER_START_CODE = 0x0F;
const ENTRY_POINT_START_CODE = 0x0E;
const FRAME_START_CODE = 0x0D;
const EMULATION_PREVENTION_BYTE = 0x03;
const MAXIMUM_ESCAPED_BYTE = 0x03;
const ADVANCED_PROFILE = 3;
const ADVANCED_LEVEL = 3;
const CHROMA_FORMAT_420 = 1;
// Every picture ends in payload bytes no start code can appear in
const PICTURE_PAYLOAD = Object.freeze([ 0x5A, 0xA5, 0x5A, 0xA5 ]);
// Video for Windows BITMAPINFOHEADER
const BITMAP_PLANE_COUNT = 1;
const BITMAP_BIT_COUNT = 24;

const MATROSKA_VFW_CODEC_ID = 'V_MS/VFW/FOURCC';

// ISO base media
const ISO_BASE_MEDIA_MAJOR_BRAND = 'isom';
const VC1_SAMPLE_ENTRY_TYPE = 'vc-1';
const DVC1_BOX_TYPE = 'dvc1';
// VC1DecSpecStruc of the Advanced profile: profile 12 and its level, the level again, flags, and an unknown frame rate
const DVC1_ADVANCED_PROFILE = 12;
const DVC1_PROFILE_SHIFT = 4;
const DVC1_LEVEL_SHIFT = 1;
const DVC1_ADVANCED_LEVEL_SHIFT = 5;
const DVC1_UNKNOWN_FRAME_RATE = 0xFFFF_FFFF;

/** Writes bits most significant first into bytes. */
class BitWriter {
    private readonly bits: number[] = [];

    public write(value: number, count: number): this {
        for (let bitIndex = count - 1; bitIndex >= 0; bitIndex -= 1) {
            this.bits.push((value >> bitIndex) & 1);
        }
        return this;
    }

    public writeFlag(value: boolean): this {
        return this.write(value ? 1 : 0, 1);
    }

    /** Returns the bits as bytes, the last one padded with zero bits. */
    public toBytes(): Uint8Array {
        const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
        this.bits.forEach((bit: number, bitIndex: number): void => {
            bytes[bitIndex >> 3] |= bit << (7 - (bitIndex & 7));
        });
        return bytes;
    }
}

/** Inserts an emulation prevention byte after two zero bytes wherever a byte of at most 3 follows, as a VC-1 encoder does. */
export function escapeVC1Payload(payload: Uint8Array): Uint8Array {
    const output: number[] = [];
    for (const value of payload) {
        if (output.length >= 2 && output[output.length - 1] === 0 && output[output.length - 2] === 0 && value <= MAXIMUM_ESCAPED_BYTE) {
            output.push(EMULATION_PREVENTION_BYTE);
        }
        output.push(value);
    }
    return Uint8Array.from(output);
}

function createStartCodeUnit(startCodeType: number, payload: Uint8Array): Uint8Array {
    return concatenate([ new Uint8Array([ ...START_CODE_PREFIX, startCodeType ]), escapeVC1Payload(payload) ]);
}

/** Returns a 4-byte STRUCT_C, the WMV3 extradata, as FFmpeg's ff_vc1_decode_sequence_header reads it. */
export function createWMV3SequenceHeader(fields: WMV3SequenceFields): Uint8Array {
    return new BitWriter()
        .write(fields.profile, 2)
        // RES_Y411, RES_SPRITE, FRMRTQ_POSTPROC, BITRTQ_POSTPROC, LOOPFILTER, RES_X8, MULTIRES
        .write(0, 1 + 1 + 3 + 5 + 1 + 1 + 1)
        // RES_FASTTX and FASTUVMC set, EXTENDED_MV, DQUANT, VSTRANSFORM, RES_TRANSTAB, OVERLAP, SYNCMARKER clear
        .write(1, 1)
        .write(1, 1)
        .write(0, 1 + 2 + 1 + 1 + 1 + 1)
        .writeFlag(fields.rangeReduction)
        .write(fields.maximumBFrames, 3)
        // QUANTIZER
        .write(0, 2)
        .writeFlag(fields.frameInterpolation)
        // RES_RTM_FLAG
        .write(1, 1)
        .toBytes();
}

/** Returns a WMV3 picture whose header codes a picture type: INTERPFRM, FRMCNT, and RANGEREDFRM as the sequence declares them, then PTYPE. */
export function createWMV3Picture(kind: 'B' | 'I' | 'P', fields: WMV3SequenceFields): Uint8Array {
    const writer = new BitWriter();
    if (fields.frameInterpolation) {
        writer.write(0, 1);
    }
    writer.write(0, 2);
    if (fields.rangeReduction) {
        writer.write(0, 1);
    }
    switch (kind) {
        case 'P':
            writer.write(1, 1);
            break;
        case 'I':
            writer.write(0, 1);
            if (fields.maximumBFrames > 0) {
                writer.write(1, 1);
            }
            break;
        case 'B':
            writer.write(0, 2);
            break;
    }
    return concatenate([ writer.toBytes(), new Uint8Array(PICTURE_PAYLOAD) ]);
}

/** Returns an Advanced profile sequence header unit, start code included and its payload escaped, of a maximum coded size and interlace flag. */
export function createVC1AdvancedSequenceHeaderUnit(maximumCodedWidth: number, maximumCodedHeight: number, interlace: boolean): Uint8Array {
    const payload = new BitWriter()
        .write(ADVANCED_PROFILE, 2)
        .write(ADVANCED_LEVEL, 3)
        .write(CHROMA_FORMAT_420, 2)
        // FRMRTQ_POSTPROC, BITRTQ_POSTPROC, POSTPROCFLAG
        .write(0, 3 + 5 + 1)
        .write((maximumCodedWidth >> 1) - 1, 12)
        .write((maximumCodedHeight >> 1) - 1, 12)
        // PULLDOWN
        .write(0, 1)
        .writeFlag(interlace)
        // TFCNTRFLAG, FINTERPFLAG, reserved 1, PSF, DISPLAY_EXT, HRD_PARAM_FLAG
        .write(0, 2)
        .write(1, 1)
        .write(0, 3)
        .toBytes();
    return createStartCodeUnit(SEQUENCE_HEADER_START_CODE, payload);
}

/** Returns an entry point unit: an open, unbroken entry point with no coding tools and the sequence's maximum coded size. */
export function createVC1AdvancedEntryPointUnit(): Uint8Array {
    const payload = new BitWriter()
        // BROKEN_LINK, CLOSED_ENTRY set, PANSCAN_FLAG, REFDIST_FLAG, LOOPFILTER, FASTUVMC, EXTENDED_MV, DQUANT, VSTRANSFORM, OVERLAP, QUANTIZER
        .write(0, 1)
        .write(1, 1)
        .write(0, 1 + 1 + 1 + 1 + 1 + 2 + 1 + 1 + 2)
        // CODED_SIZE_FLAG, RANGE_MAPY_FLAG, RANGE_MAPUV_FLAG
        .write(0, 3)
        .toBytes();
    return createStartCodeUnit(ENTRY_POINT_START_CODE, payload);
}

/** Returns VC-1 extradata as Matroska and FFmpeg carry it: a sequence header and an entry point, after a leading size byte when one is given. */
export function createVC1AdvancedExtradata(
    maximumCodedWidth: number,
    maximumCodedHeight: number,
    interlace: boolean,
    leadingByte: number | null = null
): Uint8Array {
    return concatenate([
        new Uint8Array(leadingByte === null ? [] : [ leadingByte ]),
        createVC1AdvancedSequenceHeaderUnit(maximumCodedWidth, maximumCodedHeight, interlace),
        createVC1AdvancedEntryPointUnit()
    ]);
}

function writeAdvancedPictureType(writer: BitWriter, kind: VC1PictureKind): void {
    // PTYPE: 0 P, 10 B, 110 I, 1110 BI, 1111 skipped P
    switch (kind) {
        case 'P':
            writer.write(0b0, 1);
            break;
        case 'B':
            writer.write(0b10, 2);
            break;
        case 'I':
            writer.write(0b110, 3);
            break;
        case 'BI':
            writer.write(0b1110, 4);
            break;
        case 'skipped-P':
            writer.write(0b1111, 4);
            break;
    }
}

/**
 * Returns an Advanced profile picture of a coding: FCM when the sequence is interlaced, then PTYPE or a field pair's FPTYPE.
 * A picture with a frame start code may carry units before it, such as a sequence header and an entry point.
 */
export function createVC1AdvancedPicture(
    coding: VC1AdvancedPictureCoding,
    interlace: boolean,
    precedingUnits: readonly Uint8Array[] | null
): Uint8Array {
    const writer = new BitWriter();
    if (interlace) {
        // FCM: 0 progressive, 10 frame interlace, 11 field interlace
        switch (coding.mode) {
            case 'progressive':
                writer.write(0b0, 1);
                break;
            case 'frame-interlace':
                writer.write(0b10, 2);
                break;
            case 'field-interlace':
                writer.write(0b11, 2);
                break;
        }
    }
    if (coding.mode === 'field-interlace') {
        writer.write(coding.fieldPictureType, 3);
    } else {
        writeAdvancedPictureType(writer, coding.kind);
    }
    const picture = concatenate([ writer.toBytes(), new Uint8Array(PICTURE_PAYLOAD) ]);
    if (precedingUnits === null) {
        return picture;
    }
    return concatenate([ ...precedingUnits, new Uint8Array([ ...START_CODE_PREFIX, FRAME_START_CODE ]), picture ]);
}

/** Returns a Matroska V_MS/VFW/FOURCC CodecPrivate: a BITMAPINFOHEADER of a FourCC and frame size, then the extradata. */
export function createVFWCodecPrivate(
    fourCC: string,
    width: number,
    height: number,
    extradata: Uint8Array,
    declaredHeaderByteLength: number = BITMAP_INFO_HEADER_BYTE_LENGTH + extradata.byteLength
): Uint8Array {
    const codecPrivate = new Uint8Array(BITMAP_INFO_HEADER_BYTE_LENGTH + extradata.byteLength);
    const header = new DataView(codecPrivate.buffer);
    header.setUint32(0, declaredHeaderByteLength, true);
    header.setInt32(4, width, true);
    header.setInt32(8, height, true);
    header.setUint16(12, BITMAP_PLANE_COUNT, true);
    header.setUint16(14, BITMAP_BIT_COUNT, true);
    for (let characterIndex = 0; characterIndex < fourCC.length; characterIndex += 1) {
        codecPrivate[16 + characterIndex] = fourCC.charCodeAt(characterIndex);
    }
    codecPrivate.set(extradata, BITMAP_INFO_HEADER_BYTE_LENGTH);
    return codecPrivate;
}

/** Returns a Matroska file of one V_MS/VFW/FOURCC video track, its packets in one cluster at millisecond timestamps. */
export function createVFWMatroska(codecPrivate: Uint8Array, pixelWidth: number, pixelHeight: number, packets: readonly SyntheticVC1Packet[]): Uint8Array {
    return createVideoTrackMatroska({
        blocks: packets,
        codecID: MATROSKA_VFW_CODEC_ID,
        codecPrivate,
        defaultDurationMilliseconds: VC1_TEST_FRAME_DURATION_MILLISECONDS,
        pixelHeight,
        pixelWidth
    });
}

/** Returns SMPTE RP 2025's dvc1 box payload: VC1DecSpecStruc of a profile, then the sequence header and entry point. */
export function createDVC1Payload(extradata: Uint8Array, profile: number = DVC1_ADVANCED_PROFILE): Uint8Array {
    return concatenate([
        new Uint8Array([
            (profile << DVC1_PROFILE_SHIFT) | (ADVANCED_LEVEL << DVC1_LEVEL_SHIFT),
            ADVANCED_LEVEL << DVC1_ADVANCED_LEVEL_SHIFT,
            0
        ]),
        encodeUnsigned32(DVC1_UNKNOWN_FRAME_RATE),
        extradata
    ]);
}

/**
 * Returns an ISO base media file of one video track whose sample entry is vc-1, with a dvc1 box of the payload when one is given.
 * Samples are in decode order at frame-duration decode times; each sample's composition time is its packet's timestamp.
 */
export function createVC1ISOBaseMedia(
    width: number,
    height: number,
    dvc1Payload: Uint8Array | null,
    samples: readonly SyntheticVC1Packet[]
): Uint8Array {
    return createVideoTrackISOBaseMedia({
        frameDurationMilliseconds: VC1_TEST_FRAME_DURATION_MILLISECONDS,
        height,
        majorBrand: ISO_BASE_MEDIA_MAJOR_BRAND,
        sampleEntry: createVisualSampleEntry(VC1_SAMPLE_ENTRY_TYPE, width, height, dvc1Payload ? [ createBox(DVC1_BOX_TYPE, dvc1Payload) ] : []),
        samples,
        width
    });
}
