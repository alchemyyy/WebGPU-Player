import type { InputVideoTrack } from 'mediabunny';

import { createPresentationOrderTrack, type PictureOrder, type PictureOrderReader } from '../PresentationOrderTrack';

// VC-1 start codes: a 0x000001 prefix, then the code's type
const START_CODE_PREFIX_BYTE_LENGTH = 3;
const START_CODE_BYTE_LENGTH = 4;
const SEQUENCE_HEADER_START_CODE = 0x0F;
const FRAME_START_CODE = 0x0D;
const EMULATION_PREVENTION_BYTE = 0x03;
const MAXIMUM_ESCAPED_BYTE = 0x03;
// The Simple and Main profile sequence header (STRUCT_C): the bit positions of its fields that place a picture's type
const STRUCT_C_BYTE_LENGTH = 4;
const PROFILE_BIT_COUNT = 2;
const ADVANCED_PROFILE = 3;
const RANGE_REDUCTION_BIT = 24;
const MAXIMUM_B_FRAMES_BIT = 25;
const MAXIMUM_B_FRAMES_BIT_COUNT = 3;
const FRAME_INTERPOLATION_BIT = 30;
// The Advanced profile sequence header: profile, level, chroma format, frame and bit rate quantizers, postprocessing, maximum coded size, and the broadcast flag before INTERLACE
const INTERLACE_BIT = 41;
// The bytes after a sequence header start code that hold every field up to INTERLACE, before emulation prevention bytes are removed
const SEQUENCE_HEADER_PREFIX_BYTE_LENGTH = 8;
// The Simple and Main profile picture header before PTYPE: FRMCNT, then RANGEREDFRM when range reduction is on
const FRAME_COUNT_BIT_COUNT = 2;
// FCM of an interlaced sequence, FFmpeg's decode012: 0 progressive, 10 frame interlace, 11 field interlace
const FIELD_INTERLACE_MODE = 2;
// FPTYPE of a field pair: I/I, I/P, P/I, and P/P are anchors; B/B, B/BI, BI/B, and BI/BI are not
const FIELD_PICTURE_TYPE_BIT_COUNT = 3;
const FIRST_BIDIRECTIONAL_FIELD_PICTURE_TYPE = 4;
// PTYPE, a unary code of at most 4 bits: 0 P, 10 B, 110 I, 1110 BI, 1111 skipped P
const PICTURE_TYPE_MAXIMUM_BIT_COUNT = 4;
const B_PICTURE_TYPE = 1;
const BI_PICTURE_TYPE = 3;
// At most 7 B pictures follow an anchor, so its next anchor is at most 8 packets on
const MAXIMUM_LOOKAHEAD_PACKET_COUNT = 8;
// FFmpeg's VC-1 decoder outputs a waiting anchor at a packet without a picture
const VC1_OUTPUTS_ANCHOR_WITHOUT_PICTURE = true;

/** What places a picture's type in a VC-1 packet: Advanced profile pictures by the sequence's interlace flag, Simple and Main ones by three STRUCT_C fields. */
export type VC1PictureTypeSyntax =
    | Readonly<{ interlace: boolean, kind: 'advanced' }>
    | Readonly<{ frameInterpolation: boolean, kind: 'simple-main', maximumBFrames: number, rangeReduction: boolean }>;

/** Reads bits most significant first; past the end it reads zeros, as FFmpeg's padded reader does. */
class BitReader {
    private bitPosition = 0;

    public constructor(private readonly bytes: Uint8Array) {}

    public readBit(): number {
        const byteIndex = this.bitPosition >> 3;
        const bit = byteIndex < this.bytes.byteLength ? (this.bytes[byteIndex] >> (7 - (this.bitPosition & 7))) & 1 : 0;
        this.bitPosition += 1;
        return bit;
    }

    public readBits(count: number): number {
        let value = 0;
        for (let bitIndex = 0; bitIndex < count; bitIndex += 1) {
            value = (value << 1) | this.readBit();
        }
        return value;
    }

    public skipBits(count: number): void {
        this.bitPosition += count;
    }
}

function isStartCode(bytes: Uint8Array, offset: number): boolean {
    return offset + START_CODE_BYTE_LENGTH <= bytes.byteLength
        && bytes[offset] === 0
        && bytes[offset + 1] === 0
        && bytes[offset + 2] === 1;
}

/** The offset of the first start code at or after an offset, or -1. */
function findStartCode(bytes: Uint8Array, offset: number): number {
    for (let position = offset; position + START_CODE_BYTE_LENGTH <= bytes.byteLength; position += 1) {
        if (isStartCode(bytes, position)) {
            return position;
        }
    }
    return -1;
}

/** Returns up to byteLength bytes from an offset with emulation prevention bytes removed, as FFmpeg's vc1_unescape_buffer does. */
function unescapePrefix(bytes: Uint8Array, offset: number, byteLength: number): Uint8Array {
    const output: number[] = [];
    for (let position = offset; position < bytes.byteLength && output.length < byteLength; position += 1) {
        const escaped = bytes[position] === EMULATION_PREVENTION_BYTE
            && output.length >= 2
            && output[output.length - 1] === 0
            && output[output.length - 2] === 0
            && position + 1 < bytes.byteLength
            && bytes[position + 1] <= MAXIMUM_ESCAPED_BYTE;
        if (!escaped) {
            output.push(bytes[position]);
        }
    }
    return Uint8Array.from(output);
}

/** Reads INTERLACE from an Advanced profile sequence header's bytes after its start code; null when its profile is another. */
function readAdvancedInterlace(bytes: Uint8Array, offset: number): boolean | null {
    const reader = new BitReader(unescapePrefix(bytes, offset, SEQUENCE_HEADER_PREFIX_BYTE_LENGTH));
    if (reader.readBits(PROFILE_BIT_COUNT) !== ADVANCED_PROFILE) {
        return null;
    }
    reader.skipBits(INTERLACE_BIT - PROFILE_BIT_COUNT);
    return reader.readBit() === 1;
}

/** Reads what places a picture's type from a STRUCT_C sequence header, the extradata FFmpeg's wmv3 decoder gets; null for a short or Advanced profile header. */
export function readWMV3PictureTypeSyntax(sequenceHeader: Uint8Array): VC1PictureTypeSyntax | null {
    if (sequenceHeader.byteLength < STRUCT_C_BYTE_LENGTH) {
        return null;
    }
    const reader = new BitReader(sequenceHeader);
    if (reader.readBits(PROFILE_BIT_COUNT) === ADVANCED_PROFILE) {
        return null;
    }
    reader.skipBits(RANGE_REDUCTION_BIT - PROFILE_BIT_COUNT);
    const rangeReduction = reader.readBit() === 1;
    reader.skipBits(MAXIMUM_B_FRAMES_BIT - RANGE_REDUCTION_BIT - 1);
    const maximumBFrames = reader.readBits(MAXIMUM_B_FRAMES_BIT_COUNT);
    reader.skipBits(FRAME_INTERPOLATION_BIT - MAXIMUM_B_FRAMES_BIT - MAXIMUM_B_FRAMES_BIT_COUNT);
    return { frameInterpolation: reader.readBit() === 1, kind: 'simple-main', maximumBFrames, rangeReduction };
}

/** Reads what places a picture's type from VC-1 extradata, the first sequence header after its start code; null without an Advanced profile one. */
export function readVC1AdvancedPictureTypeSyntax(extradata: Uint8Array): VC1PictureTypeSyntax | null {
    for (let offset = findStartCode(extradata, 0); offset >= 0; offset = findStartCode(extradata, offset + START_CODE_BYTE_LENGTH)) {
        if (extradata[offset + START_CODE_PREFIX_BYTE_LENGTH] === SEQUENCE_HEADER_START_CODE) {
            const interlace = readAdvancedInterlace(extradata, offset + START_CODE_BYTE_LENGTH);
            return interlace === null ? null : { interlace, kind: 'advanced' };
        }
    }
    return null;
}

function getSimpleMainPictureOrder(packet: Uint8Array, syntax: Extract<VC1PictureTypeSyntax, { kind: 'simple-main' }>): PictureOrder {
    const reader = new BitReader(packet);
    if (syntax.frameInterpolation) {
        reader.skipBits(1);
    }
    reader.skipBits(FRAME_COUNT_BIT_COUNT);
    if (syntax.rangeReduction) {
        reader.skipBits(1);
    }
    // FFmpeg's ff_vc1_parse_frame_header: 1 is P; then, with B pictures declared, 0 is B or BI and 1 is I
    if (reader.readBit() === 1) {
        return 'anchor';
    }
    return syntax.maximumBFrames > 0 && reader.readBit() === 0 ? 'bidirectional' : 'anchor';
}

/**
 * Finds an Advanced profile picture's header: the packet's start, or after its frame start code when it opens with a start code, with the interlace flag
 * of a sequence header the packet carries before its frame; null when its start codes hold no frame.
 */
function findAdvancedPictureHeader(packet: Uint8Array, interlace: boolean): Readonly<{ headerOffset: number, interlace: boolean }> | null {
    if (!isStartCode(packet, 0)) {
        return { headerOffset: 0, interlace };
    }
    let pictureInterlace = interlace;
    for (let offset = 0; offset >= 0; offset = findStartCode(packet, offset + START_CODE_BYTE_LENGTH)) {
        const startCodeType = packet[offset + START_CODE_PREFIX_BYTE_LENGTH];
        if (startCodeType === FRAME_START_CODE) {
            return { headerOffset: offset + START_CODE_BYTE_LENGTH, interlace: pictureInterlace };
        }
        if (startCodeType === SEQUENCE_HEADER_START_CODE) {
            pictureInterlace = readAdvancedInterlace(packet, offset + START_CODE_BYTE_LENGTH) ?? pictureInterlace;
        }
    }
    return null;
}

function getAdvancedPictureOrder(packet: Uint8Array, interlace: boolean): PictureOrder {
    const header = findAdvancedPictureHeader(packet, interlace);
    if (!header) {
        return 'none';
    }
    // FCM and PTYPE or FPTYPE fit the header's first byte, which no emulation prevention byte can precede
    const reader = new BitReader(packet.subarray(header.headerOffset));
    const frameCodingMode = header.interlace && reader.readBit() === 1 ? 1 + reader.readBit() : 0;
    if (frameCodingMode === FIELD_INTERLACE_MODE) {
        return reader.readBits(FIELD_PICTURE_TYPE_BIT_COUNT) >= FIRST_BIDIRECTIONAL_FIELD_PICTURE_TYPE ? 'bidirectional' : 'anchor';
    }
    let pictureType = 0;
    while (pictureType < PICTURE_TYPE_MAXIMUM_BIT_COUNT && reader.readBit() === 1) {
        pictureType += 1;
    }
    return pictureType === B_PICTURE_TYPE || pictureType === BI_PICTURE_TYPE ? 'bidirectional' : 'anchor';
}

/** Returns how a packet's picture orders; an empty packet, or one whose start codes hold no frame, has no picture. */
export function getVC1PictureOrder(packet: Uint8Array, syntax: VC1PictureTypeSyntax): PictureOrder {
    if (packet.byteLength === 0) {
        return 'none';
    }
    return syntax.kind === 'advanced' ?
        getAdvancedPictureOrder(packet, syntax.interlace) :
        getSimpleMainPictureOrder(packet, syntax);
}

/** Returns whether pictures output one picture late, as FFmpeg's decoder outputs them unless a Simple or Main profile sequence declares no B pictures. */
export function hasVC1OutputDelay(syntax: VC1PictureTypeSyntax): boolean {
    return syntax.kind === 'advanced' || syntax.maximumBFrames > 0;
}

/**
 * Returns a track whose packets carry presentation timestamps for a Matroska VfW track of VC-1 or WMV3, which stamps them in decode order:
 * an I or P picture takes the time of the next anchor or packet without a picture, and a B or BI picture keeps its own.
 * A sequence without output delay presents in decode order, so its track is returned as it is; null when Mediabunny's track backing differs.
 */
export function createVC1PresentationOrderTrack(track: InputVideoTrack, syntax: VC1PictureTypeSyntax): InputVideoTrack | null {
    if (!hasVC1OutputDelay(syntax)) {
        return track;
    }
    const reader: PictureOrderReader = {
        getPictureOrder: (packet: Uint8Array): PictureOrder => getVC1PictureOrder(packet, syntax),
        maximumLookaheadPacketCount: MAXIMUM_LOOKAHEAD_PACKET_COUNT,
        outputsAnchorWithoutPicture: VC1_OUTPUTS_ANCHOR_WITHOUT_PICTURE
    };
    return createPresentationOrderTrack(track, reader);
}
