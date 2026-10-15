// A video track's scan as its container declares it: Matroska's FlagInterlaced and FieldOrder, or an ISO base media sample entry's fiel box.
// Mediabunny 1.52.2 reads neither, so the Matroska elements are recorded while its demuxer parses the track entries, as MatroskaBlockAdditions.ts
// records block additions, and the fiel box is read from the moov bytes Mediabunny keeps; neither reads the file again.
// Field orders follow FFmpeg's matroskadec.c and mov.c, so a stream presents in the order FFmpeg reports for it.
import { MatroskaInputFormat, type InputFormat, type InputVideoTrack } from 'mediabunny';

import type { VideoScan } from '../decode/video/VideoFields';
import { readISOBaseMediaSampleEntryChildBox } from './ISOBaseMediaSampleEntryChildBox';

// Matroska's elements of a track's Video element; both IDs are one byte long
const FLAG_INTERLACED_ID = 0x9A;
const FIELD_ORDER_ID = 0x9D;
// Matroska's MuxingApp, of a segment's Info element; its ID is two bytes long
const MUXING_APPLICATION_ID_FIRST_BYTE = 0x4D;
const MUXING_APPLICATION_ID_SECOND_BYTE = 0x80;
const MUXING_APPLICATION_ID_BYTE_LENGTH = 2;
// Far longer than any muxer's name and version, so a longer string is left unread
const MAXIMUM_MUXING_APPLICATION_BYTE_LENGTH = 1_024;
const STRING_TERMINATOR = 0;
// FlagInterlaced: 0 undetermined, 1 interlaced, 2 progressive
const FLAG_INTERLACED_INTERLACED = 1;
const FLAG_INTERLACED_PROGRESSIVE = 2;
// The largest unsigned integer element the reader takes, as Matroska's unsigned integers are at most 8 bytes
const MAXIMUM_UNSIGNED_INTEGER_BYTE_LENGTH = 8;
const BYTE_SHIFT = 256;
const VARIABLE_INTEGER_MARKER = 0x80;
const ONE_BYTE_ELEMENT_ID_LENGTH = 1;
// FieldOrder 9 and 14 name the two orders whose coded and shown first fields differ
const FIELD_ORDER_TOP_CODED_BOTTOM_SHOWN_FIRST = 9;
const FIELD_ORDER_BOTTOM_CODED_TOP_SHOWN_FIRST = 14;
// FFmpeg's Matroska muxer wrote FieldOrder 9 and 14 swapped from libavformat 57.36.100 until 57.52; matroskadec.c reads a MuxingApp that sscanf matches
// with "Lavf57.%d.%d" for a minor version from 36 to 51 and a micro version from 100 as such a file, and swaps the two back
const SWAPPED_FIELD_ORDER_MUXING_APPLICATION_PREFIX = 'Lavf57.';
const SWAPPED_FIELD_ORDER_FIRST_MINOR_VERSION = 36;
const SWAPPED_FIELD_ORDER_LAST_MINOR_VERSION = 51;
const SWAPPED_FIELD_ORDER_MINIMUM_MICRO_VERSION = 100;
// The two %d conversions after the prefix: C whitespace, an optional sign, and digits each, joined by a dot
const MUXING_APPLICATION_VERSION_PATTERN = /^[ \t\n\v\f\r]*([+-]?\d+)\.[ \t\n\v\f\r]*([+-]?\d+)/;

// The fiel box: field count 1 for progressive frames and 2 for interlaced ones, then the field detail
const FIELD_BOX = 'fiel';
const FIELD_BOX_BYTE_LENGTH = 2;
const PROGRESSIVE_FIELD_COUNT = 1;
const INTERLACED_FIELD_COUNT = 2;

/**
 * The display order of the field order codes Matroska's FieldOrder and the fiel box's detail share, after FFmpeg's mapping of them:
 * 1 top coded and shown first, 6 bottom coded and shown first, 9 top coded first and bottom shown first, 14 bottom coded first and top shown first.
 * Matroska's FieldOrder 0 is progressive, and 2 leaves the order undetermined.
 */
const FIELD_ORDER_SCANS: ReadonlyMap<number, VideoScan> = new Map<number, VideoScan>([
    [ 0, 'progressive' ],
    [ 1, 'top-first' ],
    [ 6, 'bottom-first' ],
    [ 9, 'bottom-first' ],
    [ 14, 'top-first' ]
]);

/** What a Matroska demuxer recorded of a track's Video element. */
type MatroskaFieldElements = {
    fieldOrder: number | null
    flagInterlaced: number | null
};

type DemuxerFactory = (input: unknown) => unknown;
type ElementTraversal = (slice: unknown, stopIds: unknown) => unknown;

/** Where an element's data lies in the bytes a slice holds. */
type ElementDataSpan = {
    end: number
    start: number
};

// Keyed by Mediabunny's internal track, which the track entry's elements are parsed into
const matroskaFieldElements = new WeakMap<object, MatroskaFieldElements>();
// Keyed by Mediabunny's internal segment, whose Info element names the muxer that wrote the segment's track entries
const matroskaMuxingApplications = new WeakMap<object, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** Returns the byte length of a variable integer from its first byte, or null for an invalid one. */
function getVariableIntegerByteLength(firstByte: number): number | null {
    let marker = VARIABLE_INTEGER_MARKER;
    for (let byteLength = 1; byteLength <= MAXIMUM_UNSIGNED_INTEGER_BYTE_LENGTH; byteLength += 1) {
        if ((firstByte & marker) !== 0) {
            return byteLength;
        }
        marker >>= 1;
    }
    return null;
}

/** Returns the data span of the element whose size follows an ID at a position, or null when its size is invalid, beyond the bound, or its data leaves the bytes. */
function readElementDataSpan(bytes: Uint8Array, sizePosition: number, maximumSize: number): ElementDataSpan | null {
    const sizeByteLength = getVariableIntegerByteLength(bytes[sizePosition] ?? 0);
    if (sizeByteLength === null || sizePosition + sizeByteLength > bytes.byteLength) {
        return null;
    }
    let size = bytes[sizePosition] & ((VARIABLE_INTEGER_MARKER >> (sizeByteLength - 1)) - 1);
    for (let byteIndex = 1; byteIndex < sizeByteLength; byteIndex += 1) {
        size = size * BYTE_SHIFT + bytes[sizePosition + byteIndex];
    }
    const start = sizePosition + sizeByteLength;
    if (size < 1 || size > maximumSize || start + size > bytes.byteLength) {
        return null;
    }
    return { end: start + size, start };
}

/** Records a FlagInterlaced or FieldOrder element against the video track whose entry the demuxer parses. */
function recordTrackFieldElement(demuxer: Record<string, unknown>, bytes: Uint8Array, position: number, elementID: number): void {
    const span = readElementDataSpan(bytes, position + ONE_BYTE_ELEMENT_ID_LENGTH, MAXIMUM_UNSIGNED_INTEGER_BYTE_LENGTH);
    if (span === null) {
        return;
    }
    let value = 0;
    for (let byteIndex = span.start; byteIndex < span.end; byteIndex += 1) {
        value = value * BYTE_SHIFT + bytes[byteIndex];
    }
    const track = demuxer.currentTrack;
    if (!isRecord(track) || !isRecord(track.info) || track.info.type !== 'video') {
        return;
    }
    const elements = matroskaFieldElements.get(track) ?? { fieldOrder: null, flagInterlaced: null };
    if (elementID === FLAG_INTERLACED_ID) {
        elements.flagInterlaced = value;
    } else {
        elements.fieldOrder = value;
    }
    matroskaFieldElements.set(track, elements);
}

/** Records a MuxingApp element against the segment whose Info element the demuxer parses, up to its first terminator, as FFmpeg's string reads it. */
function recordMuxingApplication(demuxer: Record<string, unknown>, bytes: Uint8Array, position: number): void {
    const span = readElementDataSpan(bytes, position + MUXING_APPLICATION_ID_BYTE_LENGTH, MAXIMUM_MUXING_APPLICATION_BYTE_LENGTH);
    const segment = demuxer.currentSegment;
    if (span === null || !isRecord(segment)) {
        return;
    }
    const terminatorIndex = bytes.subarray(span.start, span.end).indexOf(STRING_TERMINATOR);
    const end = terminatorIndex === -1 ? span.end : span.start + terminatorIndex;
    matroskaMuxingApplications.set(segment, String.fromCharCode(...bytes.subarray(span.start, end)));
}

/**
 * Reads a FlagInterlaced, FieldOrder, or MuxingApp element at a slice's position without moving it, from the bytes Mediabunny's FileSlice holds, and records
 * it against the track or segment the demuxer parses; any other element, or one it cannot read whole, is left to Mediabunny.
 */
function recordFieldElement(demuxer: Record<string, unknown>, slice: unknown): void {
    if (!isRecord(slice) || !(slice.bytes instanceof Uint8Array) || typeof slice.filePos !== 'number' || typeof slice.offset !== 'number') {
        return;
    }
    const bytes = slice.bytes;
    const position = slice.filePos - slice.offset;
    const elementID = bytes[position];
    switch (elementID) {
        case FLAG_INTERLACED_ID:
        case FIELD_ORDER_ID:
            recordTrackFieldElement(demuxer, bytes, position, elementID);
            return;
        case MUXING_APPLICATION_ID_FIRST_BYTE:
            if (bytes[position + 1] === MUXING_APPLICATION_ID_SECOND_BYTE) {
                recordMuxingApplication(demuxer, bytes, position);
            }
            return;
        default:
            return;
    }
}

/**
 * Makes one Mediabunny 1.52.2 MatroskaDemuxer record its video tracks' FlagInterlaced and FieldOrder and its segments' MuxingApp: its traverseElement()
 * reads each element at a slice's position, a track entry's elements are traversed while currentTrack names its track, and an Info element's while
 * currentSegment names its segment.
 * Returns false, leaving the demuxer untouched, when it has no traverseElement().
 */
function recordVideoFieldElements(demuxer: Record<string, unknown>): boolean {
    const traverseElement = demuxer.traverseElement;
    if (typeof traverseElement !== 'function') {
        return false;
    }
    Object.defineProperty(demuxer, 'traverseElement', {
        configurable: true,
        value: (slice: unknown, stopIds: unknown): unknown => {
            recordFieldElement(demuxer, slice);
            return (traverseElement as ElementTraversal).call(demuxer, slice, stopIds);
        },
        writable: true
    });
    return true;
}

/** Wraps Mediabunny's Matroska or WebM format so each demuxer it creates records its video tracks' field elements. */
function createFieldRecordingInputFormat(format: InputFormat): InputFormat {
    const createDemuxer = (format as unknown as { _createDemuxer?: unknown })._createDemuxer;
    if (typeof createDemuxer !== 'function') {
        return format;
    }
    // Format detection, naming, and every other member still come from the wrapped format
    return Object.create(format, {
        _createDemuxer: {
            value: (input: unknown): unknown => {
                const demuxer = (createDemuxer as DemuxerFactory).call(format, input);
                if (isRecord(demuxer)) {
                    recordVideoFieldElements(demuxer);
                }
                return demuxer;
            }
        }
    }) as InputFormat;
}

/**
 * Returns the input formats with Matroska and WebM, in their places, replaced by formats whose demuxers record each video track's FlagInterlaced and FieldOrder.
 * It composes with withMatroskaBlockAdditions, whose formats it wraps in turn; every other format is unchanged.
 */
export function withMatroskaVideoFieldOrder(formats: readonly InputFormat[]): InputFormat[] {
    return formats.map((format: InputFormat): InputFormat => (format instanceof MatroskaInputFormat ? createFieldRecordingInputFormat(format) : format));
}

/** Returns whether a segment's MuxingApp names a libavformat whose Matroska muxer wrote FieldOrder 9 and 14 swapped, as FFmpeg's mkv_field_order() decides. */
export function hasSwappedMatroskaFieldOrders(muxingApplication: string | null): boolean {
    if (muxingApplication === null || !muxingApplication.startsWith(SWAPPED_FIELD_ORDER_MUXING_APPLICATION_PREFIX)) {
        return false;
    }
    const version = MUXING_APPLICATION_VERSION_PATTERN.exec(muxingApplication.slice(SWAPPED_FIELD_ORDER_MUXING_APPLICATION_PREFIX.length));
    if (version === null) {
        return false;
    }
    const minorVersion = Number(version[1]);
    const microVersion = Number(version[2]);
    return minorVersion >= SWAPPED_FIELD_ORDER_FIRST_MINOR_VERSION
        && minorVersion <= SWAPPED_FIELD_ORDER_LAST_MINOR_VERSION
        && microVersion >= SWAPPED_FIELD_ORDER_MINIMUM_MICRO_VERSION;
}

/** Returns the FieldOrder a muxer meant: 9 and 14 trade places for a muxer that wrote them swapped, and every other value stays. */
function correctMatroskaFieldOrder(fieldOrder: number | null, muxingApplication: string | null): number | null {
    if (!hasSwappedMatroskaFieldOrders(muxingApplication)) {
        return fieldOrder;
    }
    switch (fieldOrder) {
        case FIELD_ORDER_TOP_CODED_BOTTOM_SHOWN_FIRST:
            return FIELD_ORDER_BOTTOM_CODED_TOP_SHOWN_FIRST;
        case FIELD_ORDER_BOTTOM_CODED_TOP_SHOWN_FIRST:
            return FIELD_ORDER_TOP_CODED_BOTTOM_SHOWN_FIRST;
        default:
            return fieldOrder;
    }
}

/**
 * Returns a Matroska track's scan from its recorded elements, as FFmpeg reads them: FieldOrder counts only for an interlaced track, corrected for the muxer
 * its segment names; null for another container.
 */
function readMatroskaVideoScan(track: InputVideoTrack): VideoScan | null {
    const backing = (track as unknown as { _backing?: unknown })._backing;
    const internalTrack = isRecord(backing) ? backing.internalTrack : null;
    if (!isRecord(internalTrack)) {
        return null;
    }
    const elements = matroskaFieldElements.get(internalTrack);
    if (!elements) {
        return null;
    }
    switch (elements.flagInterlaced) {
        case FLAG_INTERLACED_PROGRESSIVE:
            return 'progressive';
        case FLAG_INTERLACED_INTERLACED: {
            const segment = internalTrack.segment;
            const muxingApplication = isRecord(segment) ? matroskaMuxingApplications.get(segment) ?? null : null;
            return FIELD_ORDER_SCANS.get(correctMatroskaFieldOrder(elements.fieldOrder, muxingApplication) ?? -1) ?? 'interlaced';
        }
        default:
            return 'unknown';
    }
}

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
 * Returns the scan a video track's container declares: Matroska's FlagInterlaced and FieldOrder, or the fiel box of an ISO base media sample entry,
 * whose type is the track's internal codec ID; 'unknown' when it declares none.
 */
export async function readContainerVideoScan(track: InputVideoTrack): Promise<VideoScan> {
    const matroskaScan = readMatroskaVideoScan(track);
    if (matroskaScan !== null) {
        return matroskaScan;
    }
    const internalCodecID = await track.getInternalCodecId();
    if (typeof internalCodecID !== 'string') {
        return 'unknown';
    }
    return readISOBaseMediaVideoScan(track, internalCodecID) ?? 'unknown';
}
