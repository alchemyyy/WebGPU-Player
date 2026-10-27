// A video track's scan as its container declares it: Matroska's FlagInterlaced and FieldOrder, or an ISO base media sample entry's fiel box.
// Mediabunny reads the Matroska elements itself and reports them as the track's field order, read back as FFmpeg's matroskadec.c does; the fiel box,
// which it does not read, is read from the moov bytes Mediabunny keeps, without reading the file again.
// Field orders follow FFmpeg's matroskadec.c and mov.c, so a stream presents in the order FFmpeg reports for it.
import type { InputVideoTrack, VideoFieldOrder } from 'mediabunny';

import type { VideoScan } from '../decode/video/VideoFields';
import { readISOBaseMediaSampleEntryChildBox } from './ISOBaseMediaSampleEntryChildBox';

// The fiel box: field count 1 for progressive frames and 2 for interlaced ones, then the field detail
const FIELD_BOX = 'fiel';
const FIELD_BOX_BYTE_LENGTH = 2;
const PROGRESSIVE_FIELD_COUNT = 1;
const INTERLACED_FIELD_COUNT = 2;

/**
 * The display order of the field order codes the fiel box's detail shares with Matroska's FieldOrder, after FFmpeg's mapping of them:
 * 1 top coded and shown first, 6 bottom coded and shown first, 9 top coded first and bottom shown first, 14 bottom coded first and top shown first.
 */
const FIELD_ORDER_SCANS: ReadonlyMap<number, VideoScan> = new Map<number, VideoScan>([
    [ 0, 'progressive' ],
    [ 1, 'top-first' ],
    [ 6, 'bottom-first' ],
    [ 9, 'bottom-first' ],
    [ 14, 'top-first' ]
]);

/** The scan of each field order Mediabunny reports, in the order the fields are shown. */
const MEDIABUNNY_FIELD_ORDER_SCANS: Readonly<Record<VideoFieldOrder, VideoScan>> = {
    'bottom-coded-top-first': 'top-first',
    'bottom-first': 'bottom-first',
    'interlaced': 'interlaced',
    'progressive': 'progressive',
    'top-coded-bottom-first': 'bottom-first',
    'top-first': 'top-first'
};

/** Returns an ISO base media track's scan from its first sample entry's fiel box; null without one. */
function readISOBaseMediaVideoScan(track: InputVideoTrack, sampleEntryType: string): VideoScan | null {
    const box = readISOBaseMediaSampleEntryChildBox(track, [ sampleEntryType ], FIELD_BOX);
    if (box.status !== 'read' || box.payload.byteLength < FIELD_BOX_BYTE_LENGTH) {
        return null;
    }
    switch (box.payload[0]) {
        case PROGRESSIVE_FIELD_COUNT:
            return 'progressive';
        case INTERLACED_FIELD_COUNT: {
            const scan = FIELD_ORDER_SCANS.get(box.payload[1]);
            return scan === undefined || scan === 'progressive' ? 'interlaced' : scan;
        }
        default:
            return null;
    }
}

/**
 * Returns the scan a video track's container declares: the field order Mediabunny reads, which Matroska's FlagInterlaced and FieldOrder give, or the fiel
 * box of an ISO base media sample entry, whose type is the track's internal codec ID; 'unknown' when it declares none.
 */
export async function readContainerVideoScan(track: InputVideoTrack): Promise<VideoScan> {
    const fieldOrder = await track.getFieldOrder();
    if (fieldOrder !== null) {
        return MEDIABUNNY_FIELD_ORDER_SCANS[fieldOrder];
    }
    const internalCodecID = await track.getInternalCodecId();
    if (typeof internalCodecID !== 'string') {
        return 'unknown';
    }
    return readISOBaseMediaVideoScan(track, internalCodecID) ?? 'unknown';
}
