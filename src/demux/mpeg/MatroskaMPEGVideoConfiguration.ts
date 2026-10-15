import type { InputVideoTrack } from 'mediabunny';

/** Matroska's codec ID of an MPEG-1 video track. */
export const MATROSKA_MPEG1_CODEC_ID = 'V_MPEG1';
/** Matroska's codec ID of an MPEG-2 video track. */
export const MATROSKA_MPEG2_CODEC_ID = 'V_MPEG2';

type MatroskaMPEGInternalTrack = {
    codecPrivate?: unknown
};

type MatroskaMPEGTrackBacking = {
    internalTrack?: MatroskaMPEGInternalTrack
};

/**
 * Returns the codec private data an MPEG-1 or MPEG-2 GPU decoder receives for a Matroska V_MPEG1 or V_MPEG2 track: its CodecPrivate,
 * the sequence header and extensions FFmpeg's Matroska demuxer hands its decoder as extradata.
 * A track without one carries its sequence headers in its packets, so null is no failure.
 */
export function readMatroskaMPEGVideoDecoderDescription(track: InputVideoTrack): Uint8Array | null {
    // Mediabunny preserves unsupported Matroska codecs but does not expose CodecPrivate through getDecoderConfig(), so contain the backing access here
    const backing = (track as unknown as { _backing?: MatroskaMPEGTrackBacking })._backing;
    const codecPrivate = backing?.internalTrack?.codecPrivate;
    return codecPrivate instanceof Uint8Array && codecPrivate.byteLength > 0 ? codecPrivate.slice() : null;
}
