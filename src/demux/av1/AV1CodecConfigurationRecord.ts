import type { InputVideoTrack } from 'mediabunny';

import { readISOBaseMediaSampleEntryChildBox } from '../ISOBaseMediaSampleEntryChildBox';

/** Matroska's and WebM's codec ID of an AV1 track, whose CodecPrivate is the track's AV1CodecConfigurationRecord. */
export const MATROSKA_AV1_CODEC_ID = 'V_AV1';
/** The ISO base media sample entries of an AV1 track, each holding an av1C box: AV1's own, and Dolby Vision's. */
export const ISO_BASE_MEDIA_AV1_SAMPLE_ENTRIES: readonly string[] = Object.freeze([ 'av01', 'dav1' ]);

const AV1_CONFIGURATION_BOX = 'av1C';

/** A track's AV1CodecConfigurationRecord, null when its container carries none, or the check that failed, as `code: detail`. */
export type AV1CodecConfigurationRecordResult =
    | Readonly<{ record: Uint8Array | null, status: 'read' }>
    | Readonly<{ failure: string, status: 'failed' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** Copies a record, an empty one counting as none. */
function readRecord(bytes: Uint8Array): AV1CodecConfigurationRecordResult {
    return { record: bytes.byteLength > 0 ? bytes.slice() : null, status: 'read' };
}

/** Reads a Matroska V_AV1 track's CodecPrivate, which Mediabunny 1.52.2 keeps on its internal track but hands on as no decoder description. */
function readMatroskaCodecPrivate(track: InputVideoTrack): AV1CodecConfigurationRecordResult {
    const backing = (track as unknown as { _backing?: unknown })._backing;
    const internalTrack = isRecord(backing) ? backing.internalTrack : null;
    if (!isRecord(internalTrack) || !Object.prototype.hasOwnProperty.call(internalTrack, 'codecPrivate')) {
        return { failure: 'codec-private-unavailable: no Matroska track', status: 'failed' };
    }
    const codecPrivate = internalTrack.codecPrivate;
    if (codecPrivate === null) {
        return { record: null, status: 'read' };
    }
    if (!(codecPrivate instanceof Uint8Array)) {
        return { failure: `codec-private-type: ${typeof codecPrivate}`, status: 'failed' };
    }
    return readRecord(codecPrivate);
}

/**
 * Reads the AV1CodecConfigurationRecord, the 4-byte av1C header and then its configOBUs, that FFmpeg's demuxers hand an AV1 decoder as extradata:
 * a Matroska or WebM V_AV1 track's CodecPrivate, or the av1C box of an ISO base media track's av01 or dav1 sample entry.
 * Mediabunny 1.52.2 hands neither on, so the internal access is contained here and in `readISOBaseMediaSampleEntryChildBox`; a change fails with a named check.
 * A track without one, or of another container, reads as null: its temporal units carry their sequence headers.
 * The record is copied as it is, unchecked, as FFmpeg's demuxers copy it.
 */
export function readAV1CodecConfigurationRecord(track: InputVideoTrack, internalCodecID: unknown): AV1CodecConfigurationRecordResult {
    if (internalCodecID === MATROSKA_AV1_CODEC_ID) {
        return readMatroskaCodecPrivate(track);
    }
    if (typeof internalCodecID !== 'string' || !ISO_BASE_MEDIA_AV1_SAMPLE_ENTRIES.includes(internalCodecID)) {
        return { record: null, status: 'read' };
    }
    const configuration = readISOBaseMediaSampleEntryChildBox(track, ISO_BASE_MEDIA_AV1_SAMPLE_ENTRIES, AV1_CONFIGURATION_BOX);
    switch (configuration.status) {
        case 'failed':
            return configuration;
        case 'missing':
            return { record: null, status: 'read' };
        case 'read':
            return readRecord(configuration.payload);
    }
}
