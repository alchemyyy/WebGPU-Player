/** The BITMAPINFOHEADER's length, which a Video for Windows codec's extradata follows in Matroska VfW CodecPrivate, an AVI strf chunk, and the codec private data the engine builds. */
export const BITMAP_INFO_HEADER_BYTE_LENGTH = 40;
// The BITMAPINFOHEADER fields the engine reads and writes, little-endian
const HEADER_SIZE_OFFSET = 0;
const WIDTH_OFFSET = 4;
const HEIGHT_OFFSET = 8;
const PLANES_OFFSET = 12;
const BIT_COUNT_OFFSET = 14;
const COMPRESSION_OFFSET = 16;
const FOURCC_BYTE_LENGTH = 4;
// A header the engine builds declares one plane of 24 bits, as Video for Windows codecs do
const HEADER_PLANE_COUNT = 1;
const HEADER_BIT_COUNT = 24;
const PRINTABLE_ASCII_FIRST = 0x20;
const PRINTABLE_ASCII_LAST = 0x7E;
const HEXADECIMAL_RADIX = 16;
const HEXADECIMAL_BYTE_DIGITS = 2;

/** Returns a FourCC, one character per byte, as its four characters when they are printable, else as hexadecimal bytes. */
export function formatFourCC(fourCC: string): string {
    const codes = Array.from(fourCC, (character: string): number => character.charCodeAt(0));
    if (codes.every((code: number): boolean => code >= PRINTABLE_ASCII_FIRST && code <= PRINTABLE_ASCII_LAST)) {
        return fourCC;
    }
    return `0x${codes.map((code: number): string => code.toString(HEXADECIMAL_RADIX).padStart(HEXADECIMAL_BYTE_DIGITS, '0')).join('')}`;
}

/** Returns a BITMAPINFOHEADER's biCompression FourCC, as formatFourCC gives it. */
export function readBitmapInfoHeaderFourCC(header: Uint8Array): string {
    return formatFourCC(String.fromCharCode(...header.subarray(COMPRESSION_OFFSET, COMPRESSION_OFFSET + FOURCC_BYTE_LENGTH)));
}

/**
 * Builds codec private data a GPU decoder reads as Video for Windows does: a BITMAPINFOHEADER of a coded size, one plane of 24 bits, and a printable
 * FourCC, whose biSize declares a byte length, then the extradata.
 */
export function createBitmapInfoHeaderCodecPrivate(
    fourCC: string,
    codedWidth: number,
    codedHeight: number,
    extradata: Uint8Array,
    headerSize: number
): Uint8Array {
    const codecPrivate = new Uint8Array(BITMAP_INFO_HEADER_BYTE_LENGTH + extradata.byteLength);
    const header = new DataView(codecPrivate.buffer, 0, BITMAP_INFO_HEADER_BYTE_LENGTH);
    header.setUint32(HEADER_SIZE_OFFSET, headerSize, true);
    header.setInt32(WIDTH_OFFSET, codedWidth, true);
    header.setInt32(HEIGHT_OFFSET, codedHeight, true);
    header.setUint16(PLANES_OFFSET, HEADER_PLANE_COUNT, true);
    header.setUint16(BIT_COUNT_OFFSET, HEADER_BIT_COUNT, true);
    for (let characterIndex = 0; characterIndex < FOURCC_BYTE_LENGTH; characterIndex += 1) {
        codecPrivate[COMPRESSION_OFFSET + characterIndex] = fourCC.charCodeAt(characterIndex);
    }
    codecPrivate.set(extradata, BITMAP_INFO_HEADER_BYTE_LENGTH);
    return codecPrivate;
}
