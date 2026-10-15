// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ALL_FORMATS, BufferSource, Input, type InputVideoTrack } from 'mediabunny';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    ISO_BASE_MEDIA_AV1_SAMPLE_ENTRIES,
    MATROSKA_AV1_CODEC_ID,
    readAV1CodecConfigurationRecord
} from 'webgpu-player/demux/av1/AV1CodecConfigurationRecord';
import { findAV1SequenceHeader } from 'webgpu-player/demux/av1/AV1SequenceHeaderParser';

import { AV1_HDR10_PLUS_EXPECTATIONS, readAV1HDR10PlusVector } from '../../helpers/av1HDR10PlusVectors';
import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../../helpers/enginePaths';
import { createBox, createVideoTrackISOBaseMedia, createVisualSampleEntry } from '../../helpers/isoBaseMediaBoxes';
import { createVideoTrackMatroska } from '../../helpers/matroskaElements';

const MATROSKA_VECTOR_FILE_NAME = 'hdr10plus.mkv';
const ISO_BASE_MEDIA_VECTOR_FILE_NAME = 'hdr10plus.mp4';
// The Dolby Vision Profile 10.0 vector, whose MP4 track has a dav1 sample entry
const DOLBY_VISION_SAMPLE_ENTRY_VECTOR = resolve(CODEC_VECTOR_ASSETS_DIRECTORY, 'dolby-vision-av1', 'profile10.0.mp4');
const DOLBY_VISION_SAMPLE_ENTRY = 'dav1';
const AV1_SAMPLE_ENTRY = 'av01';
// An av1C opens with its marker bit and version 1, and its configOBUs follow its 4-byte header
const AV1_CONFIGURATION_RECORD_MARKER_AND_VERSION = 0x81;
const AV1_CONFIGURATION_RECORD_HEADER_BYTE_LENGTH = 4;
// A synthetic track's av1C: Main profile, level 4.0, 10-bit 4:2:0, and a 192x192 sequence header OBU
const SYNTHETIC_CONFIGURATION_RECORD = Uint8Array.of(0x81, 0x00, 0x4C, 0x00, 0x0A, 0x0B, 0x00, 0x00, 0x00, 0x03, 0xBD, 0xFD, 0xF9, 0xB5, 0xF2, 0x90, 0x80);
const SYNTHETIC_WIDTH = 192;
const SYNTHETIC_HEIGHT = 192;
// Each synthetic sample is a temporal delimiter OBU, which the record's reader never parses
const TEMPORAL_DELIMITER_OBU = Uint8Array.of(0x12, 0x00);
const FRAME_DURATION_MILLISECONDS = 40;
const SYNTHETIC_SAMPLES = [
    { data: TEMPORAL_DELIMITER_OBU, keyframe: true, timestampMilliseconds: 0 },
    { data: TEMPORAL_DELIMITER_OBU, keyframe: false, timestampMilliseconds: FRAME_DURATION_MILLISECONDS }
];
const ISO_BASE_MEDIA_MAJOR_BRAND = 'isom';
// A codec ID of another container, such as MPEG-TS, which carries no record
const OTHER_CONTAINER_CODEC_ID = 27;
const UNEXPECTED_CODEC_PRIVATE = 'not bytes';

async function withVideoTrack<Result>(file: Uint8Array, read: (track: InputVideoTrack, internalCodecID: unknown) => Result): Promise<Result> {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(file) });
    try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) {
            throw new Error('The file has no video track');
        }
        return read(track, await track.getInternalCodecId());
    } finally {
        input.dispose();
    }
}

function createSyntheticMatroska(codecPrivate: Uint8Array | null): Uint8Array {
    return createVideoTrackMatroska({
        blocks: SYNTHETIC_SAMPLES,
        codecID: MATROSKA_AV1_CODEC_ID,
        codecPrivate,
        defaultDurationMilliseconds: FRAME_DURATION_MILLISECONDS,
        pixelHeight: SYNTHETIC_HEIGHT,
        pixelWidth: SYNTHETIC_WIDTH
    });
}

function createSyntheticISOBaseMedia(configurationRecord: Uint8Array | null): Uint8Array {
    return createVideoTrackISOBaseMedia({
        frameDurationMilliseconds: FRAME_DURATION_MILLISECONDS,
        height: SYNTHETIC_HEIGHT,
        majorBrand: ISO_BASE_MEDIA_MAJOR_BRAND,
        sampleEntry: createVisualSampleEntry(
            AV1_SAMPLE_ENTRY,
            SYNTHETIC_WIDTH,
            SYNTHETIC_HEIGHT,
            configurationRecord ? [ createBox('av1C', configurationRecord) ] : []
        ),
        samples: SYNTHETIC_SAMPLES,
        width: SYNTHETIC_WIDTH
    });
}

/** Returns the record a read must produce, failing the test on anything else. */
function requireRecord(track: InputVideoTrack, internalCodecID: unknown): Uint8Array {
    const result = readAV1CodecConfigurationRecord(track, internalCodecID);
    if (result.status !== 'read' || result.record === null) {
        throw new Error(`No AV1 record: ${JSON.stringify(result)}`);
    }
    return result.record;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('readAV1CodecConfigurationRecord', () => {
    it('reads a Matroska V_AV1 track\'s CodecPrivate as its own copy', async () => {
        const file = createSyntheticMatroska(SYNTHETIC_CONFIGURATION_RECORD);

        await withVideoTrack(file, (track: InputVideoTrack, internalCodecID: unknown): void => {
            expect(internalCodecID).toBe(MATROSKA_AV1_CODEC_ID);
            const record = requireRecord(track, internalCodecID);
            expect(record).toEqual(SYNTHETIC_CONFIGURATION_RECORD);
            expect(record.buffer).not.toBe(file.buffer);
        });
    });

    it('reads an ISO base media av01 sample entry\'s av1C box', async () => {
        await withVideoTrack(createSyntheticISOBaseMedia(SYNTHETIC_CONFIGURATION_RECORD), (track: InputVideoTrack, internalCodecID: unknown): void => {
            expect(internalCodecID).toBe(AV1_SAMPLE_ENTRY);
            expect(requireRecord(track, internalCodecID)).toEqual(SYNTHETIC_CONFIGURATION_RECORD);
        });
    });

    it('reads no record of a track whose container carries none', async () => {
        await withVideoTrack(createSyntheticMatroska(null), (track: InputVideoTrack, internalCodecID: unknown): void => {
            expect(readAV1CodecConfigurationRecord(track, internalCodecID)).toEqual({ record: null, status: 'read' });
        });
        await withVideoTrack(createSyntheticISOBaseMedia(null), (track: InputVideoTrack, internalCodecID: unknown): void => {
            expect(readAV1CodecConfigurationRecord(track, internalCodecID)).toEqual({ record: null, status: 'read' });
        });
        const otherContainerTrack = {} as unknown as InputVideoTrack;
        expect(readAV1CodecConfigurationRecord(otherContainerTrack, OTHER_CONTAINER_CODEC_ID)).toEqual({ record: null, status: 'read' });
    });

    it('reads the same record from a stream\'s Matroska and MP4 files, whose configOBUs hold its sequence header', async () => {
        const matroskaRecord = await withVideoTrack(readAV1HDR10PlusVector(MATROSKA_VECTOR_FILE_NAME), requireRecord);
        const isoBaseMediaRecord = await withVideoTrack(readAV1HDR10PlusVector(ISO_BASE_MEDIA_VECTOR_FILE_NAME), requireRecord);

        expect(isoBaseMediaRecord).toEqual(matroskaRecord);
        expect(matroskaRecord[0]).toBe(AV1_CONFIGURATION_RECORD_MARKER_AND_VERSION);
        expect(findAV1SequenceHeader(matroskaRecord.subarray(AV1_CONFIGURATION_RECORD_HEADER_BYTE_LENGTH))).toMatchObject({
            maximumFrameHeight: AV1_HDR10_PLUS_EXPECTATIONS.height,
            maximumFrameWidth: AV1_HDR10_PLUS_EXPECTATIONS.width
        });
    });

    it('reads a Dolby Vision dav1 sample entry\'s av1C box', async () => {
        // Mediabunny warns that it maps no codec to a dav1 sample entry, which the engine maps to AV1 later
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);

        await withVideoTrack(new Uint8Array(readFileSync(DOLBY_VISION_SAMPLE_ENTRY_VECTOR)), (track: InputVideoTrack, internalCodecID: unknown): void => {
            expect(internalCodecID).toBe(DOLBY_VISION_SAMPLE_ENTRY);
            expect(ISO_BASE_MEDIA_AV1_SAMPLE_ENTRIES).toContain(DOLBY_VISION_SAMPLE_ENTRY);
            expect(requireRecord(track, internalCodecID)[0]).toBe(AV1_CONFIGURATION_RECORD_MARKER_AND_VERSION);
        });
    });

    it('fails with a named check when Mediabunny\'s internal track differs', () => {
        const trackWithoutBacking = {} as unknown as InputVideoTrack;
        const trackWithOtherCodecPrivate = { _backing: { internalTrack: { codecPrivate: UNEXPECTED_CODEC_PRIVATE } } } as unknown as InputVideoTrack;

        expect(readAV1CodecConfigurationRecord(trackWithoutBacking, MATROSKA_AV1_CODEC_ID))
            .toEqual({ failure: 'codec-private-unavailable: no Matroska track', status: 'failed' });
        expect(readAV1CodecConfigurationRecord(trackWithOtherCodecPrivate, MATROSKA_AV1_CODEC_ID))
            .toEqual({ failure: 'codec-private-type: string', status: 'failed' });
        expect(readAV1CodecConfigurationRecord(trackWithoutBacking, AV1_SAMPLE_ENTRY))
            .toEqual({ failure: 'sample-table-unavailable: no ISO base media track', status: 'failed' });
    });
});
