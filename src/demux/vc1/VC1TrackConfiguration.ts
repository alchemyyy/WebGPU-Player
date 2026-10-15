import type { InputVideoTrack } from 'mediabunny';

import { ISO_BASE_MEDIA_VC1_SAMPLE_ENTRY, readISOBaseMediaVC1DecoderDescription } from './ISOBaseMediaVC1Configuration';
import {
    BITMAP_INFO_HEADER_BYTE_LENGTH,
    MATROSKA_VFW_CODEC_ID,
    readMatroskaVC1DecoderDescription,
    readMatroskaWMV3DecoderDescription,
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

/** The container codec IDs whose tracks each codec's route reads: Matroska VfW tracks, and for VC-1 also ISO base media vc-1 sample entries. */
export const VC1_TRACK_INTERNAL_CODEC_IDS: Readonly<Record<VC1TrackCodec, readonly string[]>> = Object.freeze({
    vc1: Object.freeze([ MATROSKA_VFW_CODEC_ID, ISO_BASE_MEDIA_VC1_SAMPLE_ENTRY ]),
    wmv3: Object.freeze([ MATROSKA_VFW_CODEC_ID ])
});

function readDecoderDescription(
    codec: VC1TrackCodec,
    track: InputVideoTrack,
    internalCodecID: string,
    codedWidth: number,
    codedHeight: number
): VC1DecoderDescriptionResult {
    if (codec === 'wmv3') {
        return readMatroskaWMV3DecoderDescription(track, codedWidth, codedHeight);
    }
    return internalCodecID === ISO_BASE_MEDIA_VC1_SAMPLE_ENTRY ?
        readISOBaseMediaVC1DecoderDescription(track) :
        readMatroskaVC1DecoderDescription(track);
}

/** Reads what places each picture's type from a description: the STRUCT_C after a WMV3 description's header, or a VC-1 extradata's sequence header. */
function readPictureTypeSyntax(codec: VC1TrackCodec, description: Uint8Array): VC1PictureTypeSyntax | null {
    return codec === 'wmv3' ?
        readWMV3PictureTypeSyntax(description.subarray(BITMAP_INFO_HEADER_BYTE_LENGTH)) :
        readVC1AdvancedPictureTypeSyntax(description);
}

/**
 * Returns the codec private data a VC-1 or WMV3 track gives its GPU decoder, and the track to read its packets from.
 * A Matroska VfW track stamps its packets in decode order, so its packets come through a track that restamps them in presentation order, as FFmpeg's decoder outputs them;
 * an ISO base media track stamps them in presentation order already.
 */
export function readVC1TrackConfiguration(
    codec: VC1TrackCodec,
    track: InputVideoTrack,
    internalCodecID: string,
    codedWidth: number,
    codedHeight: number
): VC1TrackConfiguration {
    if (!VC1_TRACK_INTERNAL_CODEC_IDS[codec].includes(internalCodecID)) {
        return { failure: `codec-id: ${internalCodecID}`, status: 'failed' };
    }
    const description = readDecoderDescription(codec, track, internalCodecID, codedWidth, codedHeight);
    if (description.status === 'failed') {
        return description;
    }
    if (internalCodecID !== MATROSKA_VFW_CODEC_ID) {
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
