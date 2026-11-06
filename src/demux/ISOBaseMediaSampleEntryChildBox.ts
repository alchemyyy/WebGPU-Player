import type { InputVideoTrack } from 'mediabunny';

// The box whose entries describe a track's samples
const SAMPLE_DESCRIPTION_BOX = 'stsd';
const BOX_HEADER_BYTE_LENGTH = 8;
const LARGE_BOX_HEADER_BYTE_LENGTH = 16;
const LARGE_BOX_SIZE_MARKER = 1;
const BOX_EXTENDS_TO_END_MARKER = 0;
const BOX_TYPE_OFFSET = 4;
const BOX_TYPE_BYTE_LENGTH = 4;
const LARGE_BOX_SIZE_OFFSET = 8;
const UNSIGNED_32_BIT_RANGE = 0x1_0000_0000;
// The sample description's version and flags, then its entry count
const FULL_BOX_HEADER_BYTE_LENGTH = 4;
const SAMPLE_DESCRIPTION_ENTRY_COUNT_BYTE_LENGTH = 4;
// A visual sample entry's fields between its box header and its child boxes
const VISUAL_SAMPLE_ENTRY_FIELD_BYTE_LENGTH = 78;

/** A child box of a track's first sample entry: its payload, its absence, or the check that failed, as `code: detail`. */
export type ISOBaseMediaSampleEntryChildBox =
    | Readonly<{ payload: Uint8Array, status: 'read' }>
    | Readonly<{ status: 'missing' }>
    | Readonly<{ failure: string, status: 'failed' }>;

type ISOBaseMediaBox = Readonly<{
    dataEnd: number
    dataStart: number
    end: number
    type: string
}>;

type BoxResult =
    | Readonly<{ box: ISOBaseMediaBox, status: 'read' }>
    | Readonly<{ failure: string, status: 'failed' }>;

type SampleDescriptionBytes =
    | Readonly<{ bytes: Uint8Array, status: 'read' }>
    | Readonly<{ failure: string, status: 'failed' }>;

function fail(failure: string): Readonly<{ failure: string, status: 'failed' }> {
    return { failure, status: 'failed' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function readUnsigned32(bytes: Uint8Array, offset: number): number {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readBoxType(bytes: Uint8Array, offset: number): string {
    return String.fromCharCode(...bytes.subarray(offset + BOX_TYPE_OFFSET, offset + BOX_TYPE_OFFSET + BOX_TYPE_BYTE_LENGTH));
}

/** Reads the box at an offset, which must end within its container's end. */
function readBox(bytes: Uint8Array, offset: number, containerEnd: number): BoxResult {
    if (offset + BOX_HEADER_BYTE_LENGTH > containerEnd) {
        return fail(`box-truncated: ${offset}`);
    }
    const compactSize = readUnsigned32(bytes, offset);
    let headerByteLength = BOX_HEADER_BYTE_LENGTH;
    let size = compactSize;
    if (compactSize === LARGE_BOX_SIZE_MARKER) {
        if (offset + LARGE_BOX_HEADER_BYTE_LENGTH > containerEnd) {
            return fail(`box-truncated: ${offset}`);
        }
        headerByteLength = LARGE_BOX_HEADER_BYTE_LENGTH;
        size = (readUnsigned32(bytes, offset + LARGE_BOX_SIZE_OFFSET) * UNSIGNED_32_BIT_RANGE)
            + readUnsigned32(bytes, offset + LARGE_BOX_SIZE_OFFSET + BOX_TYPE_BYTE_LENGTH);
    } else if (compactSize === BOX_EXTENDS_TO_END_MARKER) {
        size = containerEnd - offset;
    }
    const end = offset + size;
    if (size < headerByteLength || !Number.isSafeInteger(end) || end > containerEnd) {
        return fail(`box-size: ${size}`);
    }
    return { box: { dataEnd: end, dataStart: offset + headerByteLength, end, type: readBoxType(bytes, offset) }, status: 'read' };
}

/** Finds the first child box of a type in [start, end), or null when no child has the type. */
function findChildBox(bytes: Uint8Array, start: number, end: number, type: string): BoxResult | null {
    let offset = start;
    while (offset < end) {
        const child = readBox(bytes, offset, end);
        if (child.status === 'failed' || child.box.type === type) {
            return child;
        }
        offset = child.box.end;
    }
    return null;
}

/**
 * Returns the copy of the track's stsd box, header included, that Mediabunny's ISO base media demuxer keeps on each track.
 * Mediabunny reads a track's samples but skips the configuration boxes of codecs it does not decode, and the boxes it does not use, so contain the internal access here.
 */
function readSampleDescriptionBytes(track: InputVideoTrack): SampleDescriptionBytes {
    const backing = (track as unknown as { _backing?: unknown })._backing;
    const internalTrack = isRecord(backing) ? backing.internalTrack : null;
    if (!isRecord(internalTrack)) {
        return fail('sample-description-unavailable: no ISO base media track');
    }
    const bytes = internalTrack.sampleDescriptionBytes;
    if (!(bytes instanceof Uint8Array)) {
        return fail('sample-description-unavailable: no retained stsd');
    }
    return { bytes, status: 'read' };
}

/**
 * Reads a child box of an ISO base media track's first sample entry, a visual sample entry of one of the given types, from the stsd box Mediabunny keeps.
 * The payload is a view of those bytes, so a caller copies what it keeps.
 * Fails when the track's sample description is unavailable or malformed, or its first entry is of another type; a missing child box is no failure here.
 */
export function readISOBaseMediaSampleEntryChildBox(
    track: InputVideoTrack,
    sampleEntryTypes: readonly string[],
    childBoxType: string
): ISOBaseMediaSampleEntryChildBox {
    const sampleDescriptionBytes = readSampleDescriptionBytes(track);
    if (sampleDescriptionBytes.status === 'failed') {
        return sampleDescriptionBytes;
    }
    const bytes = sampleDescriptionBytes.bytes;
    const sampleDescription = readBox(bytes, 0, bytes.byteLength);
    if (sampleDescription.status === 'failed') {
        return sampleDescription;
    }
    if (sampleDescription.box.type !== SAMPLE_DESCRIPTION_BOX) {
        return fail(`sample-description-box: ${sampleDescription.box.type}`);
    }
    const firstEntryStart = sampleDescription.box.dataStart + FULL_BOX_HEADER_BYTE_LENGTH + SAMPLE_DESCRIPTION_ENTRY_COUNT_BYTE_LENGTH;
    const sampleEntry = readBox(bytes, firstEntryStart, sampleDescription.box.dataEnd);
    if (sampleEntry.status === 'failed') {
        return sampleEntry;
    }
    if (!sampleEntryTypes.includes(sampleEntry.box.type)) {
        return fail(`sample-entry: ${sampleEntry.box.type}`);
    }
    const childBox = findChildBox(bytes, sampleEntry.box.dataStart + VISUAL_SAMPLE_ENTRY_FIELD_BYTE_LENGTH, sampleEntry.box.dataEnd, childBoxType);
    if (childBox === null) {
        return { status: 'missing' };
    }
    if (childBox.status === 'failed') {
        return childBox;
    }
    return { payload: bytes.subarray(childBox.box.dataStart, childBox.box.dataEnd), status: 'read' };
}
