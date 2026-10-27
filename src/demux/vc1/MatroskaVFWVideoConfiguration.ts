import type { InputVideoTrack } from 'mediabunny';

import { BITMAP_INFO_HEADER_BYTE_LENGTH, createBitmapInfoHeaderCodecPrivate, readBitmapInfoHeaderFourCC } from '../BitmapInfoHeader';

/** Matroska's codec ID of a Video for Windows track, whose CodecPrivate is a BITMAPINFOHEADER and then the codec's extradata. */
export const MATROSKA_VFW_CODEC_ID = 'V_MS/VFW/FOURCC';
const MAXIMUM_EXTRADATA_BYTE_LENGTH = 1024 * 1024;

// FFmpeg's vc1 decoder takes WVC1 and WMVA, the pre-standard Advanced profile, whose extradata carries the sequence header and entry point
const VC1_FOURCCS: readonly string[] = Object.freeze([ 'WVC1', 'WMVA' ]);
// FFmpeg's wmv3 decoder takes WMV3, the Simple and Main profiles, whose extradata is the STRUCT_C sequence header
const WMV3_FOURCCS: readonly string[] = Object.freeze([ 'WMV3' ]);

/** The codec private data a VC-1 GPU decoder receives for a track, or the check the track's codec private data failed, as `code: detail`. */
export type VC1DecoderDescriptionResult =
    | Readonly<{ description: Uint8Array, status: 'read' }>
    | Readonly<{ failure: string, status: 'failed' }>;

/** A Matroska VfW track's FourCC and the extradata after its BITMAPINFOHEADER, which may be empty, or the check its CodecPrivate failed, as `code: detail`. */
export type MatroskaVFWCodecPrivateResult =
    | Readonly<{ extradata: Uint8Array, fourCC: string, status: 'read' }>
    | Readonly<{ failure: string, status: 'failed' }>;

type MatroskaVFWInternalTrack = {
    codecPrivate?: unknown
};

type MatroskaVFWTrackBacking = {
    internalTrack?: MatroskaVFWInternalTrack
};

function fail(failure: string): Readonly<{ failure: string, status: 'failed' }> {
    return { failure, status: 'failed' };
}

/**
 * Reads a Matroska VFW track's FourCC, as `formatFourCC` gives it, and the extradata after its BITMAPINFOHEADER.
 * As FFmpeg's Matroska demuxer reads it, the extradata is everything after the 40-byte header, and neither the header's biSize nor its frame size is read.
 */
export function readMatroskaVFWCodecPrivate(track: InputVideoTrack): MatroskaVFWCodecPrivateResult {
    // Mediabunny preserves unsupported Matroska codecs but does not expose CodecPrivate through getDecoderConfig(), so contain the backing access here
    const backing = (track as unknown as { _backing?: MatroskaVFWTrackBacking })._backing;
    const codecPrivate = backing?.internalTrack?.codecPrivate;
    if (!(codecPrivate instanceof Uint8Array)) {
        return fail(`codec-private-missing: ${codecPrivate === null ? 'null' : typeof codecPrivate}`);
    }
    const extradataByteLength = codecPrivate.byteLength - BITMAP_INFO_HEADER_BYTE_LENGTH;
    if (extradataByteLength < 0 || extradataByteLength > MAXIMUM_EXTRADATA_BYTE_LENGTH) {
        return fail(`codec-private-size: ${codecPrivate.byteLength}`);
    }
    return { extradata: codecPrivate.slice(BITMAP_INFO_HEADER_BYTE_LENGTH), fourCC: readBitmapInfoHeaderFourCC(codecPrivate), status: 'read' };
}

/** Reads the extradata after a Matroska VFW CodecPrivate's BITMAPINFOHEADER when it has any and its FourCC is one of the codec's. */
function readMatroskaVFWExtradata(track: InputVideoTrack, fourCCs: readonly string[]): MatroskaVFWCodecPrivateResult {
    const codecPrivate = readMatroskaVFWCodecPrivate(track);
    if (codecPrivate.status === 'failed') {
        return codecPrivate;
    }
    if (codecPrivate.extradata.byteLength === 0) {
        return fail(`codec-private-size: ${BITMAP_INFO_HEADER_BYTE_LENGTH}`);
    }
    return fourCCs.includes(codecPrivate.fourCC) ? codecPrivate : fail(`fourcc: ${codecPrivate.fourCC}`);
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
    const headerSize = BITMAP_INFO_HEADER_BYTE_LENGTH + extradata.extradata.byteLength;
    return {
        description: createBitmapInfoHeaderCodecPrivate(extradata.fourCC, codedWidth, codedHeight, extradata.extradata, headerSize),
        status: 'read'
    };
}
