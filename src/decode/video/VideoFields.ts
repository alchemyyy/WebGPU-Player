// The field facts of interlaced video: a stream's scan, a frame's own fields, and the word GPU decoders and decoder parsers report them in.
// The deinterlacing presentation pass reads each frame's fields; the engine book's presentation pages describe where they come from.

/**
 * How a stream or a frame is scanned: progressive, interlaced with its first field in time, interlaced with an unknown field order, or unknown.
 * 'interlaced' presents as 'top-first', yadif's default for a frame that names no order.
 */
export type VideoScan = 'bottom-first' | 'interlaced' | 'progressive' | 'top-first' | 'unknown';

/** What a stream declares of its fields before its frames arrive: its scan, and its frames' visible size in samples, null where unknown. */
export type VideoStreamFields = Readonly<{
    frameHeight: number | null
    frameWidth: number | null
    scan: VideoScan
}>;

/** The fields of a stream that declares nothing. */
export const UNKNOWN_VIDEO_STREAM_FIELDS: VideoStreamFields = Object.freeze({ frameHeight: null, frameWidth: null, scan: 'unknown' });

/** A frame's field facts; a frame whose fields nobody reported carries none, so its scan is never 'unknown'. */
export type VideoFrameFields = Readonly<{
    /** The frame repeats its first field, as soft telecine marks it; only a progressive frame does */
    repeatFirstField: boolean
    scan: Exclude<VideoScan, 'unknown'>
}>;

/**
 * The picture fields word a GPU decoder's `reportPictureFields` and a parser's `parser_picture_fields` report, the same bits in both.
 * 0 reports nothing, so the frame keeps its container's or stream's scan; the reported bit makes a progressive report differ from none.
 */
export const PICTURE_FIELDS_WORD = Object.freeze({
    interlacedBit: 0x2,
    none: 0,
    repeatFirstFieldBit: 0x8,
    reportedBit: 0x1,
    topFieldFirstBit: 0x4
});

/** The VideoScan values, which messages crossing a worker boundary are checked against. */
export const VIDEO_SCANS: readonly VideoScan[] = Object.freeze([ 'bottom-first', 'interlaced', 'progressive', 'top-first', 'unknown' ]);

// Every bit a picture fields word defines
const PICTURE_FIELDS_DEFINED_BITS = PICTURE_FIELDS_WORD.reportedBit
    | PICTURE_FIELDS_WORD.interlacedBit
    | PICTURE_FIELDS_WORD.topFieldFirstBit
    | PICTURE_FIELDS_WORD.repeatFirstFieldBit;

/** Returns whether a word is a picture fields word: none, or a report that sets no bit beyond those defined. */
export function isPictureFieldsWord(word: number): boolean {
    return Number.isInteger(word)
        && (word === PICTURE_FIELDS_WORD.none || ((word & PICTURE_FIELDS_WORD.reportedBit) !== 0 && (word & ~PICTURE_FIELDS_DEFINED_BITS) === 0));
}

/** Returns a reported picture fields word, as a GPU decoder's `reportPictureFields(interlaced, topFieldFirst, repeatFirstField)` stores it. */
export function createPictureFieldsWord(interlaced: boolean, topFieldFirst: boolean, repeatFirstField: boolean): number {
    let word = PICTURE_FIELDS_WORD.reportedBit;
    if (interlaced) {
        word |= PICTURE_FIELDS_WORD.interlacedBit;
    }
    if (topFieldFirst) {
        word |= PICTURE_FIELDS_WORD.topFieldFirstBit;
    }
    if (repeatFirstField) {
        word |= PICTURE_FIELDS_WORD.repeatFirstFieldBit;
    }
    return word;
}

/**
 * Returns the fields a picture fields word reports, or null for a word without the reported bit.
 * An interlaced picture names its first field; a progressive one may repeat its first field, which an interlaced one never does.
 */
export function decodePictureFieldsWord(word: number): VideoFrameFields | null {
    if ((word & PICTURE_FIELDS_WORD.reportedBit) === 0) {
        return null;
    }
    const topFieldFirst = (word & PICTURE_FIELDS_WORD.topFieldFirstBit) !== 0;
    if ((word & PICTURE_FIELDS_WORD.interlacedBit) !== 0) {
        return { repeatFirstField: false, scan: topFieldFirst ? 'top-first' : 'bottom-first' };
    }
    return { repeatFirstField: (word & PICTURE_FIELDS_WORD.repeatFirstFieldBit) !== 0, scan: 'progressive' };
}

/** Returns whether a value crossing a worker boundary is a VideoScan. */
export function isVideoScan(value: unknown): value is VideoScan {
    return typeof value === 'string' && (VIDEO_SCANS as readonly string[]).includes(value);
}

/** Returns whether a value crossing a worker boundary is a frame's fields. */
export function isVideoFrameFields(value: unknown): value is VideoFrameFields {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const fields = value as Record<string, unknown>;
    return typeof fields.repeatFirstField === 'boolean' && isVideoScan(fields.scan) && fields.scan !== 'unknown';
}

/** Returns a scan's fields for a frame that reports none of its own, or null for an unknown scan. */
export function getScanFrameFields(scan: VideoScan): VideoFrameFields | null {
    return scan === 'unknown' ? null : { repeatFirstField: false, scan };
}
