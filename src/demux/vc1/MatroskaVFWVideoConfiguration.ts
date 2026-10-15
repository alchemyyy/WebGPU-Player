import type { InputVideoTrack } from 'mediabunny';

/** Matroska's codec ID of a Video for Windows track, whose CodecPrivate is a BITMAPINFOHEADER and then the codec's extradata. */
export const MATROSKA_VFW_CODEC_ID = 'V_MS/VFW/FOURCC';
/** The BITMAPINFOHEADER's length, which a WMV3 description's sequence header follows. */
export const BITMAP_INFO_HEADER_BYTE_LENGTH = 40;
const MAXIMUM_EXTRADATA_BYTE_LENGTH = 1024 * 1024;
// The BITMAPINFOHEADER fields the descriptions read and write, little-endian
const HEADER_SIZE_OFFSET = 0;
const WIDTH_OFFSET = 4;
const HEIGHT_OFFSET = 8;
const PLANES_OFFSET = 12;
const BIT_COUNT_OFFSET = 14;
const COMPRESSION_OFFSET = 16;
const FOURCC_BYTE_LENGTH = 4;
// The header a WMV3 description carries declares one plane of 24 bits, as Video for Windows codecs do
const WMV3_HEADER_PLANE_COUNT = 1;
const WMV3_HEADER_BIT_COUNT = 24;
const PRINTABLE_ASCII_FIRST = 0x20;
const PRINTABLE_ASCII_LAST = 0x7E;
const HEXADECIMAL_RADIX = 16;
const HEXADECIMAL_BYTE_DIGITS = 2;

// FFmpeg's vc1 decoder takes WVC1 and WMVA, the pre-standard Advanced profile, whose extradata carries the sequence header and entry point
const VC1_FOURCCS: readonly string[] = Object.freeze([ 'WVC1', 'WMVA' ]);
// FFmpeg's wmv3 decoder takes WMV3, the Simple and Main profiles, whose extradata is the STRUCT_C sequence header
const WMV3_FOURCCS: readonly string[] = Object.freeze([ 'WMV3' ]);

/** The codec private data a VC-1 GPU decoder receives for a track, or the check the track's codec private data failed, as `code: detail`. */
export type VC1DecoderDescriptionResult =
    | Readonly<{ description: Uint8Array, status: 'read' }>
    | Readonly<{ failure: string, status: 'failed' }>;

type MatroskaVFWInternalTrack = {
    codecPrivate?: unknown
};

type MatroskaVFWTrackBacking = {
    internalTrack?: MatroskaVFWInternalTrack
};

type VFWExtradataResult =
    | Readonly<{ extradata: Uint8Array, fourCC: string, status: 'read' }>
    | Readonly<{ failure: string, status: 'failed' }>;

function fail(failure: string): Readonly<{ failure: string, status: 'failed' }> {
    return { failure, status: 'failed' };
}

/** Returns a FourCC as its four characters when they are printable, else as hexadecimal bytes. */
function readFourCC(codecPrivate: Uint8Array): string {
    const bytes = codecPrivate.subarray(COMPRESSION_OFFSET, COMPRESSION_OFFSET + FOURCC_BYTE_LENGTH);
    if (bytes.every((value: number): boolean => value >= PRINTABLE_ASCII_FIRST && value <= PRINTABLE_ASCII_LAST)) {
        return String.fromCharCode(...bytes);
    }
    return `0x${Array.from(bytes, (value: number): string => value.toString(HEXADECIMAL_RADIX).padStart(HEXADECIMAL_BYTE_DIGITS, '0')).join('')}`;
}

/**
 * Reads the extradata after a Matroska VFW CodecPrivate's BITMAPINFOHEADER when its FourCC is one of the codec's.
 * As FFmpeg's Matroska demuxer reads it, the extradata is everything after the 40-byte header, and neither the header's biSize nor its frame size is read.
 */
function readMatroskaVFWExtradata(track: InputVideoTrack, fourCCs: readonly string[]): VFWExtradataResult {
    // Mediabunny preserves unsupported Matroska codecs but does not expose CodecPrivate through getDecoderConfig(), so contain the backing access here
    const backing = (track as unknown as { _backing?: MatroskaVFWTrackBacking })._backing;
    const codecPrivate = backing?.internalTrack?.codecPrivate;
    if (!(codecPrivate instanceof Uint8Array)) {
        return fail(`codec-private-missing: ${codecPrivate === null ? 'null' : typeof codecPrivate}`);
    }
    const extradataByteLength = codecPrivate.byteLength - BITMAP_INFO_HEADER_BYTE_LENGTH;
    if (extradataByteLength <= 0 || extradataByteLength > MAXIMUM_EXTRADATA_BYTE_LENGTH) {
        return fail(`codec-private-size: ${codecPrivate.byteLength}`);
    }
    const fourCC = readFourCC(codecPrivate);
    if (!fourCCs.includes(fourCC)) {
        return fail(`fourcc: ${fourCC}`);
    }
    return { extradata: codecPrivate.slice(BITMAP_INFO_HEADER_BYTE_LENGTH), fourCC, status: 'read' };
}

/**
 * Reads the extradata FFmpeg's vc1 decoder gets from a Matroska VFW track of VC-1 Advanced profile, its WVC1 or WMVA FourCC:
 * the sequence header and entry point after their start codes, which may follow a size byte.
 */
export function readMatroskaVC1DecoderDescription(track: InputVideoTrack): VC1DecoderDescriptionResult {
    const extradata = readMatroskaVFWExtradata(track, VC1_FOURCCS);
    if (extradata.status === 'failed') {
        return extradata;
    }
    return { description: extradata.extradata, status: 'read' };
}

/**
 * Builds the codec private data of a Matroska VFW track of WMV3, the VC-1 Simple and Main profiles: a 40-byte BITMAPINFOHEADER, then the STRUCT_C sequence header FFmpeg's wmv3 decoder gets as its extradata.
 * The sequence header holds no frame size, which FFmpeg takes from the container, and a GPU decoder sees only the frame pool's size, which is padded.
 * So the header carries the container's coded size, as a Video for Windows header does, and the WMV3 FourCC that tells the decoder which sequence header follows.
 */
export function readMatroskaWMV3DecoderDescription(
    track: InputVideoTrack,
    codedWidth: number,
    codedHeight: number
): VC1DecoderDescriptionResult {
    const extradata = readMatroskaVFWExtradata(track, WMV3_FOURCCS);
    if (extradata.status === 'failed') {
        return extradata;
    }
    const description = new Uint8Array(BITMAP_INFO_HEADER_BYTE_LENGTH + extradata.extradata.byteLength);
    const header = new DataView(description.buffer, 0, BITMAP_INFO_HEADER_BYTE_LENGTH);
    header.setUint32(HEADER_SIZE_OFFSET, description.byteLength, true);
    header.setInt32(WIDTH_OFFSET, codedWidth, true);
    header.setInt32(HEIGHT_OFFSET, codedHeight, true);
    header.setUint16(PLANES_OFFSET, WMV3_HEADER_PLANE_COUNT, true);
    header.setUint16(BIT_COUNT_OFFSET, WMV3_HEADER_BIT_COUNT, true);
    for (let characterIndex = 0; characterIndex < FOURCC_BYTE_LENGTH; characterIndex += 1) {
        description[COMPRESSION_OFFSET + characterIndex] = extradata.fourCC.charCodeAt(characterIndex);
    }
    description.set(extradata.extradata, BITMAP_INFO_HEADER_BYTE_LENGTH);
    return { description, status: 'read' };
}
