import type { InputVideoTrack } from 'mediabunny';

import { BITMAP_INFO_HEADER_BYTE_LENGTH } from '../BitmapInfoHeader';
import { readVFWStreamFormat } from '../VFWStreamFormat';
import { ISO_BASE_MEDIA_VC1_SAMPLE_ENTRY, readISOBaseMediaVC1DecoderDescription } from './ISOBaseMediaVC1Configuration';
import {
    MATROSKA_VFW_CODEC_ID,
    readMatroskaVFWCodecPrivate,
    readVFWVC1DecoderDescription,
    readVFWWMV3DecoderDescription,
    type VC1DecoderDescriptionResult
} from './MatroskaVFWVideoConfiguration';
import {
    createVC1PresentationOrderTrack,
    readVC1AdvancedPictureTypeSyntax,
    readWMV3PictureTypeSyntax,
    type VC1PictureTypeSyntax
} from './VC1PresentationOrder';

/** The engine's codecs of FFmpeg's VC-1 decoder: vc1 for the Advanced profile, wmv3 for the Simple and Main profiles. */
export type VC1TrackCodec = 'vc1' | 'wmv3';

/** What a VC-1 GPU decoder reads for a track: its codec private data and the track its packets come from, or the check that failed, as `code: detail`. */
export type VC1TrackConfiguration =
    | Readonly<{ description: Uint8Array, status: 'read', videoTrack: InputVideoTrack }>
    | Readonly<{ failure: string, status: 'failed' }>;

// The FourCCs that are the codec IDs of ASF streams, as the fork's ASF demuxer gives them: WVC1 and WMVA, which it names vc1, and WMV3, which it leaves
// codec-less
const VC1_STREAM_FOURCCS: readonly string[] = Object.freeze([ 'WVC1', 'WMVA' ]);
const WMV3_STREAM_FOURCC = 'WMV3';

/**
 * The container codec IDs whose tracks each codec's route reads: Matroska VfW tracks and ASF streams by their FourCC, and for VC-1 also ISO base media
 * vc-1 sample entries.
 */
export const VC1_TRACK_INTERNAL_CODEC_IDS: Readonly<Record<VC1TrackCodec, readonly string[]>> = Object.freeze({
    vc1: Object.freeze([ MATROSKA_VFW_CODEC_ID, ISO_BASE_MEDIA_VC1_SAMPLE_ENTRY, ...VC1_STREAM_FOURCCS ]),
    wmv3: Object.freeze([ MATROSKA_VFW_CODEC_ID, WMV3_STREAM_FOURCC ])
});

async function readDecoderDescription(
    codec: VC1TrackCodec,
    track: InputVideoTrack,
    internalCodecID: string,
    codedWidth: number,
    codedHeight: number
): Promise<VC1DecoderDescriptionResult> {
    if (internalCodecID === ISO_BASE_MEDIA_VC1_SAMPLE_ENTRY) {
        return readISOBaseMediaVC1DecoderDescription(track);
    }
    // A Matroska VfW track's CodecPrivate, or an ASF stream's BITMAPINFOHEADER: either holds the FourCC and the extradata FFmpeg's decoder gets
    const codecPrivate = internalCodecID === MATROSKA_VFW_CODEC_ID ? readMatroskaVFWCodecPrivate(track) : readVFWStreamFormat(track);
    return codec === 'wmv3' ?
        readVFWWMV3DecoderDescription(codecPrivate, codedWidth, codedHeight) :
        readVFWVC1DecoderDescription(codecPrivate);
}

/** Reads what places each picture's type from a description: the STRUCT_C after a WMV3 description's header, or a VC-1 extradata's sequence header. */
function readPictureTypeSyntax(codec: VC1TrackCodec, description: Uint8Array): VC1PictureTypeSyntax | null {
    return codec === 'wmv3' ?
        readWMV3PictureTypeSyntax(description.subarray(BITMAP_INFO_HEADER_BYTE_LENGTH)) :
        readVC1AdvancedPictureTypeSyntax(description);
}

/**
 * Returns the codec private data a VC-1 or WMV3 track gives its GPU decoder, and the track to read its packets from.
 * A Matroska VfW track and an ASF stream stamp their packets in decode order, as FFmpeg reads both, so their packets come through a track that restamps
 * them in presentation order, as FFmpeg's decoder outputs them; an ISO base media track stamps them in presentation order already.
 */
export async function readVC1TrackConfiguration(
    codec: VC1TrackCodec,
    track: InputVideoTrack,
    internalCodecID: string,
    codedWidth: number,
    codedHeight: number
): Promise<VC1TrackConfiguration> {
    if (!VC1_TRACK_INTERNAL_CODEC_IDS[codec].includes(internalCodecID)) {
        return { failure: `codec-id: ${internalCodecID}`, status: 'failed' };
    }
    const description = await readDecoderDescription(codec, track, internalCodecID, codedWidth, codedHeight);
    if (description.status === 'failed') {
        return description;
    }
    if (internalCodecID === ISO_BASE_MEDIA_VC1_SAMPLE_ENTRY) {
        return { description: description.description, status: 'read', videoTrack: track };
    }
    const syntax = readPictureTypeSyntax(codec, description.description);
    if (!syntax) {
        return { failure: `sequence-header: ${description.description.byteLength} bytes`, status: 'failed' };
    }
    const videoTrack = createVC1PresentationOrderTrack(track, syntax);
    if (!videoTrack) {
        return { failure: 'presentation-order: unexpected track backing', status: 'failed' };
    }
    return { description: description.description, status: 'read', videoTrack };
}
