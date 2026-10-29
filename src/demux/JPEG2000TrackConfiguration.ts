import type { InputVideoTrack } from 'mediabunny';

import { MATROSKA_VFW_CODEC_ID, readMatroskaVFWCodecPrivate } from './vc1/MatroskaVFWVideoConfiguration';

/** Whether a track carries JPEG 2000 as the GPU decoder reads it, which takes no codec private data, or the check that failed, as `code: detail`. */
export type JPEG2000TrackConfiguration =
    | Readonly<{ status: 'read' }>
    | Readonly<{ failure: string, status: 'failed' }>;

// ISO/IEC 15444-3's sample entry, of MJ2 and QuickTime files
const ISO_BASE_MEDIA_JPEG2000_SAMPLE_ENTRY = 'mjp2';
// FFmpeg's FourCCs of JPEG 2000 in libavformat/riff.c, upper-cased as its tag lookups compare them; its Matroska muxer writes mjp2
const JPEG2000_FOURCCS: readonly string[] = Object.freeze([ 'MJP2', 'MJ2C', 'LJ2C', 'LJ2K', 'IPJ2', 'AVJ2' ]);

/** The codec IDs of the tracks the JPEG 2000 route reads: the MJ2 sample entry, and Matroska Video for Windows tracks, by their FourCC. */
export const JPEG2000_TRACK_INTERNAL_CODEC_IDS: readonly string[] = Object.freeze([ ISO_BASE_MEDIA_JPEG2000_SAMPLE_ENTRY, MATROSKA_VFW_CODEC_ID ]);

/**
 * Checks that a track carries JPEG 2000: an MJ2 sample entry, or a Matroska VfW track whose BITMAPINFOHEADER names a FourCC FFmpeg maps to JPEG 2000.
 * A VfW track's blocks hold the bare codestreams FFmpeg's demuxer hands its decoder, and FFmpeg's decoder reads no extradata, so the decoder takes none.
 */
export function readJPEG2000TrackConfiguration(track: InputVideoTrack, internalCodecID: string): JPEG2000TrackConfiguration {
    if (!JPEG2000_TRACK_INTERNAL_CODEC_IDS.includes(internalCodecID)) {
        return { failure: `codec-id: ${internalCodecID}`, status: 'failed' };
    }
    if (internalCodecID === ISO_BASE_MEDIA_JPEG2000_SAMPLE_ENTRY) {
        return { status: 'read' };
    }
    const codecPrivate = readMatroskaVFWCodecPrivate(track);
    if (codecPrivate.status === 'failed') {
        return codecPrivate;
    }
    return JPEG2000_FOURCCS.includes(codecPrivate.fourCC.toUpperCase()) ?
        { status: 'read' } :
        { failure: `fourcc: ${codecPrivate.fourCC}`, status: 'failed' };
}
