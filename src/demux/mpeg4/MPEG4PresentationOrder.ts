import { PacketReader, type InputVideoTrack } from 'mediabunny';

import { createPresentationOrderTrack, type PictureOrder, type PictureOrderReader } from '../PresentationOrderTrack';

// MPEG-4 Part 2 start codes: a 0x000001 prefix, then the code's type
const START_CODE_PREFIX_BYTE_LENGTH = 3;
const START_CODE_BYTE_LENGTH = 4;
const FIRST_VIDEO_OBJECT_LAYER_START_CODE = 0x20;
const LAST_VIDEO_OBJECT_LAYER_START_CODE = 0x2F;
const VOP_START_CODE = 0xB6;
// The video object layer header up to vop_time_increment_resolution, as FFmpeg's decode_vol_header reads it
const VIDEO_OBJECT_TYPE_BIT_COUNT = 8;
// The object types FFmpeg assumes low delay for when a layer has no vol_control_parameters
const SIMPLE_OBJECT_TYPE = 1;
const ADVANCED_SIMPLE_OBJECT_TYPE = 17;
const LAYER_VERIFICATION_ID_BIT_COUNT = 4;
const LAYER_PRIORITY_BIT_COUNT = 3;
const FIRST_LAYER_VERIFICATION_ID = 1;
const ASPECT_RATIO_INFO_BIT_COUNT = 4;
const EXTENDED_ASPECT_RATIO = 15;
const PIXEL_ASPECT_BIT_COUNT = 16;
const CHROMA_FORMAT_BIT_COUNT = 2;
// The VBV parameters: bit rate, buffer size, and occupancy halves of 15, 15, 15, 3, 11, and 15 bits with five marker bits among them
const VBV_PARAMETERS_BIT_COUNT = 79;
const SHAPE_BIT_COUNT = 2;
const GRAYSCALE_SHAPE = 3;
const SHAPE_EXTENSION_BIT_COUNT = 4;
const TIME_INCREMENT_RESOLUTION_BIT_COUNT = 16;
// vop_coding_type: 0 I, 1 P, 2 B, 3 S
const VOP_CODING_TYPE_BIT_COUNT = 2;
const B_VOP_CODING_TYPE = 2;
// FFmpeg's encoder writes at most 16 B-VOPs between anchors (MAX_B_FRAMES), so the next anchor is at most 17 packets on
const MAXIMUM_LOOKAHEAD_PACKET_COUNT = 17;
// FFmpeg's MPEG-4 decoder outputs nothing for a VOP that is not coded, so the waiting anchor outputs at the next coded anchor
const MPEG4_OUTPUTS_ANCHOR_WITHOUT_PICTURE = false;
// The most packets from the first key packet a layer without vol_control_parameters is searched for a B-VOP in, up to the next key packet
const MAXIMUM_B_VOP_SEARCH_PACKET_COUNT = 300;

/**
 * What the restamping reads of an MPEG-4 Part 2 video object layer: FFmpeg's low_delay as the layer sets it, whether it has vol_control_parameters,
 * without which FFmpeg clears low_delay at the first B-VOP, and the bit count of a VOP's time increment.
 */
export type MPEG4VideoObjectLayerSyntax = Readonly<{ lowDelay: boolean, timeIncrementBitCount: number, volControlParameters: boolean }>;

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

    /** Skips bits up to and including the next zero, which past the end is the first bit read. */
    public skipOnes(): void {
        let bit = this.readBit();
        while (bit === 1) {
            bit = this.readBit();
        }
    }
}

/** The offset after the first start code at or after an offset whose type a predicate takes, or -1. */
function findStartCodePayload(bytes: Uint8Array, offset: number, isType: (type: number) => boolean): number {
    for (let index = offset; index + START_CODE_BYTE_LENGTH <= bytes.byteLength; index += 1) {
        if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1 && isType(bytes[index + START_CODE_PREFIX_BYTE_LENGTH])) {
            return index + START_CODE_BYTE_LENGTH;
        }
    }
    return -1;
}

/** FFmpeg's av_log2: the index of a positive value's highest set bit, and 0 for 0. */
function log2(value: number): number {
    return value > 0 ? 31 - Math.clz32(value) : 0;
}

/**
 * Reads the first video object layer header in bytes, extradata or a key packet, as FFmpeg's decode_vol_header does; null without one, or for a zero
 * time increment resolution, which FFmpeg refuses.
 * low_delay is the layer's vol_control_parameters flag, or without them true for the Simple and Advanced Simple object types alone.
 */
export function readMPEG4VideoObjectLayerSyntax(bytes: Uint8Array): MPEG4VideoObjectLayerSyntax | null {
    const payloadOffset = findStartCodePayload(
        bytes,
        0,
        (type: number): boolean => type >= FIRST_VIDEO_OBJECT_LAYER_START_CODE && type <= LAST_VIDEO_OBJECT_LAYER_START_CODE
    );
    if (payloadOffset < 0) {
        return null;
    }
    const reader = new BitReader(bytes.subarray(payloadOffset));
    // random_accessible_vol, then video_object_type_indication
    reader.skipBits(1);
    const objectType = reader.readBits(VIDEO_OBJECT_TYPE_BIT_COUNT);
    let verificationID = FIRST_LAYER_VERIFICATION_ID;
    if (reader.readBit() === 1) {
        verificationID = reader.readBits(LAYER_VERIFICATION_ID_BIT_COUNT);
        reader.skipBits(LAYER_PRIORITY_BIT_COUNT);
    }
    if (reader.readBits(ASPECT_RATIO_INFO_BIT_COUNT) === EXTENDED_ASPECT_RATIO) {
        reader.skipBits(PIXEL_ASPECT_BIT_COUNT);
    }
    let lowDelay = objectType === SIMPLE_OBJECT_TYPE || objectType === ADVANCED_SIMPLE_OBJECT_TYPE;
    const volControlParameters = reader.readBit() === 1;
    if (volControlParameters) {
        reader.skipBits(CHROMA_FORMAT_BIT_COUNT);
        lowDelay = reader.readBit() === 1;
        if (reader.readBit() === 1) {
            reader.skipBits(VBV_PARAMETERS_BIT_COUNT);
        }
    }
    if (reader.readBits(SHAPE_BIT_COUNT) === GRAYSCALE_SHAPE && verificationID !== FIRST_LAYER_VERIFICATION_ID) {
        reader.skipBits(SHAPE_EXTENSION_BIT_COUNT);
    }
    // The marker bit before vop_time_increment_resolution
    reader.skipBits(1);
    const timeIncrementResolution = reader.readBits(TIME_INCREMENT_RESOLUTION_BIT_COUNT);
    if (timeIncrementResolution === 0) {
        return null;
    }
    return { lowDelay, timeIncrementBitCount: Math.max(1, log2(timeIncrementResolution - 1) + 1), volControlParameters };
}

function isVOPStartCode(type: number): boolean {
    return type === VOP_START_CODE;
}

/**
 * Returns how a packet's first VOP orders, as FFmpeg's decode_vop_header reads it: an I, P, or S-VOP is an anchor and a B-VOP bidirectional, and a
 * packet without a VOP start code, or whose VOP is not coded (an N-VOP), has no picture.
 */
export function getMPEG4PictureOrder(packet: Uint8Array, syntax: MPEG4VideoObjectLayerSyntax): PictureOrder {
    const payloadOffset = findStartCodePayload(packet, 0, isVOPStartCode);
    if (payloadOffset < 0) {
        return 'none';
    }
    const reader = new BitReader(packet.subarray(payloadOffset));
    const codingType = reader.readBits(VOP_CODING_TYPE_BIT_COUNT);
    // modulo_time_base, a one for each second the VOP's time steps by, ends with a zero
    reader.skipOnes();
    // The marker bit, vop_time_increment, and the marker bit before vop_coded
    reader.skipBits(1 + syntax.timeIncrementBitCount + 1);
    if (reader.readBit() === 0) {
        return 'none';
    }
    return codingType === B_VOP_CODING_TYPE ? 'bidirectional' : 'anchor';
}

/** Returns whether any VOP of a packet is a B-VOP, coded or not, as FFmpeg reads vop_coding_type before vop_coded. */
function hasBVOP(packet: Uint8Array): boolean {
    for (let offset = findStartCodePayload(packet, 0, isVOPStartCode); offset >= 0; offset = findStartCodePayload(packet, offset, isVOPStartCode)) {
        if (new BitReader(packet.subarray(offset)).readBits(VOP_CODING_TYPE_BIT_COUNT) === B_VOP_CODING_TYPE) {
            return true;
        }
    }
    return false;
}

/**
 * Returns whether a track's first group, from its first key packet up to the next, holds a B-VOP, at which FFmpeg clears low_delay of a layer without
 * vol_control_parameters ("low_delay flag set incorrectly"); the search stops after a bounded number of packets.
 */
async function hasBVOPInFirstGroup(track: InputVideoTrack): Promise<boolean> {
    const packetReader = new PacketReader(track);
    let packet = await packetReader.getFirstKey();
    for (let packetIndex = 0; packet && packetIndex < MAXIMUM_B_VOP_SEARCH_PACKET_COUNT; packetIndex += 1) {
        if (hasBVOP(packet.data)) {
            return true;
        }
        packet = await packetReader.getNext(packet);
        if (packet?.type === 'key') {
            break;
        }
    }
    return false;
}

/**
 * Returns whether FFmpeg outputs a layer's VOPs one late: when vol_control_parameters clear low_delay, or, without them, when the object type is
 * neither Simple nor Advanced Simple or the stream has B-VOPs.
 */
async function hasMPEG4OutputDelay(track: InputVideoTrack, syntax: MPEG4VideoObjectLayerSyntax): Promise<boolean> {
    if (!syntax.lowDelay) {
        return true;
    }
    return syntax.volControlParameters ? false : hasBVOPInFirstGroup(track);
}

/**
 * Returns a track whose packets carry presentation timestamps for an AVI or Matroska VfW track of MPEG-4 Part 2, which stamps them in decode order:
 * an I, P, or S-VOP takes the time of the next coded VOP that is no B-VOP, passing over B-VOPs and N-VOPs, and a B-VOP keeps its own.
 * A stream FFmpeg outputs without delay outputs each VOP at once, so its track is returned as it is; null when Mediabunny's track backing differs.
 */
export async function createMPEG4PresentationOrderTrack(track: InputVideoTrack, syntax: MPEG4VideoObjectLayerSyntax): Promise<InputVideoTrack | null> {
    if (!await hasMPEG4OutputDelay(track, syntax)) {
        return track;
    }
    const reader: PictureOrderReader = {
        getPictureOrder: (packet: Uint8Array): PictureOrder => getMPEG4PictureOrder(packet, syntax),
        maximumLookaheadPacketCount: MAXIMUM_LOOKAHEAD_PACKET_COUNT,
        outputsAnchorWithoutPicture: MPEG4_OUTPUTS_ANCHOR_WITHOUT_PICTURE
    };
    return createPresentationOrderTrack(track, reader);
}
