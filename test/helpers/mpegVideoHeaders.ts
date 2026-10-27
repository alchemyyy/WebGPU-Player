// MPEG-1 and MPEG-2 Video headers as ISO/IEC 11172-2 and 13818-2 code them, for tests that read a stream's sequences without decoding its pictures

import { concatenate } from './byteArrays';

/** chroma_format as a sequence extension codes it: 1 for 4:2:0, 2 for 4:2:2, 3 for 4:4:4. */
export type MPEGChromaFormat = 1 | 2 | 3;

/** A sequence: its size, and for MPEG-2 the chroma format its sequence extension codes; an MPEG-1 sequence has no extension. */
export type MPEGSequence = Readonly<{
    chromaFormat: MPEGChromaFormat | null
    height: number
    width: number
}>;

const START_CODE_PREFIX = [ 0x00, 0x00, 0x01 ];
const PICTURE_START_CODE = 0x00;
const SEQUENCE_HEADER_CODE = 0xB3;
const EXTENSION_START_CODE = 0xB5;
const GROUP_START_CODE = 0xB8;
const SEQUENCE_EXTENSION_ID = 1;
// horizontal_size and vertical_size code the low 12 bits of a side, and the sequence extension the 2 bits above them
const SIZE_BITS = 12;
const SIZE_MASK = 0xFFF;
const SIZE_EXTENSION_MASK = 0b11;
// Square pixels, 25 frames a second, and the largest bit rate
const ASPECT_RATIO_SQUARE = 1;
const FRAME_RATE_25 = 3;
const MAXIMUM_BIT_RATE = 0x3_FFFF;
const VBV_BUFFER_SIZE = 112;
// Main profile at Main level
const MAIN_PROFILE_MAIN_LEVEL = 0x48;
const INTRA_PICTURE = 1;
const MAXIMUM_VBV_DELAY = 0xFFFF;

/** Writes bits most significant first into bytes. */
class BitWriter {
    private readonly bits: number[] = [];

    public write(value: number, count: number): this {
        for (let bitIndex = count - 1; bitIndex >= 0; bitIndex -= 1) {
            this.bits.push((value >> bitIndex) & 1);
        }
        return this;
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

function createStartCode(code: number, payload: Uint8Array): Uint8Array {
    return concatenate([ Uint8Array.from([ ...START_CODE_PREFIX, code ]), payload ]);
}

/** Returns a sequence header without quantizer matrices, then for MPEG-2 its sequence extension: the sequence's codec private data. */
export function createMPEGSequenceHeaders(sequence: MPEGSequence): Uint8Array {
    const header = createStartCode(SEQUENCE_HEADER_CODE, new BitWriter()
        .write(sequence.width & SIZE_MASK, SIZE_BITS)
        .write(sequence.height & SIZE_MASK, SIZE_BITS)
        .write(ASPECT_RATIO_SQUARE, 4)
        .write(FRAME_RATE_25, 4)
        .write(MAXIMUM_BIT_RATE, 18)
        // marker_bit, vbv_buffer_size_value, constrained_parameters_flag, and no intra or non-intra matrix
        .write(1, 1)
        .write(VBV_BUFFER_SIZE, 10)
        .write(0, 3)
        .toBytes());
    if (sequence.chromaFormat === null) {
        return header;
    }
    const extension = createStartCode(EXTENSION_START_CODE, new BitWriter()
        .write(SEQUENCE_EXTENSION_ID, 4)
        .write(MAIN_PROFILE_MAIN_LEVEL, 8)
        // progressive_sequence
        .write(1, 1)
        .write(sequence.chromaFormat, 2)
        .write((sequence.width >> SIZE_BITS) & SIZE_EXTENSION_MASK, 2)
        .write((sequence.height >> SIZE_BITS) & SIZE_EXTENSION_MASK, 2)
        // bit_rate_extension, marker_bit, vbv_buffer_size_extension, low_delay, and the frame rate extensions
        .write(0, 12)
        .write(1, 1)
        .write(0, 8)
        .write(0, 1)
        .write(0, 7)
        .toBytes());
    return concatenate([ header, extension ]);
}

/** Returns the start of an I picture: its picture header, with no slices after it, which no test here decodes. */
export function createMPEGPictureHeader(): Uint8Array {
    return createStartCode(PICTURE_START_CODE, new BitWriter()
        // temporal_reference, picture_coding_type, and vbv_delay
        .write(0, 10)
        .write(INTRA_PICTURE, 3)
        .write(MAXIMUM_VBV_DELAY, 16)
        .toBytes());
}

/** Returns a packet of one I picture that opens a closed GOP, after its sequence's headers when one is given. */
export function createMPEGIntraPacket(sequence: MPEGSequence | null): Uint8Array {
    const group = createStartCode(GROUP_START_CODE, new BitWriter()
        // time_code, then closed_gop set and broken_link clear
        .write(0, 25)
        .write(1, 1)
        .write(0, 1)
        .toBytes());
    return concatenate([ ...(sequence ? [ createMPEGSequenceHeaders(sequence) ] : []), group, createMPEGPictureHeader() ]);
}
