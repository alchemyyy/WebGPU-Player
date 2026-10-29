import type { InputVideoTrack } from 'mediabunny';

import { formatFourCC } from './BitmapInfoHeader';
import type { VFWCodecPrivateResult } from './vc1/MatroskaVFWVideoConfiguration';

// The fields of the fork's AVI and ASF video stream formats that a BITMAPINFOHEADER holds; src/avi/avi-misc.ts in Mediabunny parses them from an AVI
// strf chunk and from an ASF Stream Properties Object's format data
type StreamFormatBacking = {
    streamInfo?: { format?: { compression?: unknown, extraData?: unknown } }
};

/**
 * Reads the BITMAPINFOHEADER of an AVI or ASF video stream, whose codec ID is its FourCC: the FourCC, as `formatFourCC` gives it, and the extradata
 * after the 40-byte header, as FFmpeg's AVI and ASF demuxers hand it to the decoder.
 * Mediabunny gives a stream it names no codec for no decoder configuration, so the backing's stream format is read, contained here.
 */
export function readVFWStreamFormat(track: InputVideoTrack): VFWCodecPrivateResult {
    const backing = (track as unknown as { _backing?: StreamFormatBacking })._backing;
    const format = backing?.streamInfo?.format;
    if (typeof format?.compression !== 'string') {
        return { failure: 'stream-format-missing: no BITMAPINFOHEADER', status: 'failed' };
    }
    const extradata = format.extraData instanceof Uint8Array ? format.extraData.slice() : new Uint8Array();
    return { extradata, fourCC: formatFourCC(format.compression), status: 'read' };
}
