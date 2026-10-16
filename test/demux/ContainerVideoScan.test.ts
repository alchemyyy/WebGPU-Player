// @vitest-environment node

import { ALL_FORMATS, BufferSource, Input, type InputFormat } from 'mediabunny';
import { describe, expect, it } from 'vitest';

import type { VideoScan } from 'webgpu-player/decode/video/VideoFields';
import { MATROSKA_AV1_CODEC_ID } from 'webgpu-player/demux/av1/AV1CodecConfigurationRecord';
import { hasSwappedMatroskaFieldOrders, readContainerVideoScan, withMatroskaVideoFieldOrder } from 'webgpu-player/demux/ContainerVideoScan';

import { createBox, createVideoTrackISOBaseMedia, createVisualSampleEntry } from '../helpers/isoBaseMediaBoxes';
import { createASCIIElement, createElement, createUnsignedIntegerElement, createVideoTrackMatroska } from '../helpers/matroskaElements';

// Matroska's Video elements FlagInterlaced and FieldOrder
const FLAG_INTERLACED_ID = 0x9A;
const FIELD_ORDER_ID = 0x9D;
const FLAG_INTERLACED_UNDETERMINED = 0;
const FLAG_INTERLACED_INTERLACED = 1;
const FLAG_INTERLACED_PROGRESSIVE = 2;
// The field order codes Matroska's FieldOrder and the fiel box's detail share
const FIELD_ORDER_PROGRESSIVE = 0;
const FIELD_ORDER_TOP_FIRST = 1;
const FIELD_ORDER_UNDETERMINED = 2;
const FIELD_ORDER_BOTTOM_FIRST = 6;
const FIELD_ORDER_TOP_CODED_BOTTOM_SHOWN_FIRST = 9;
const FIELD_ORDER_BOTTOM_CODED_TOP_SHOWN_FIRST = 14;
// The fiel box's field count
const PROGRESSIVE_FIELD_COUNT = 1;
const INTERLACED_FIELD_COUNT = 2;
const INVALID_FIELD_COUNT = 3;
// An av1C of Main profile, level 4.0, 10-bit 4:2:0, and a 192x192 sequence header OBU, which Mediabunny takes for a video track
const SYNTHETIC_CONFIGURATION_RECORD = Uint8Array.of(0x81, 0x00, 0x4C, 0x00, 0x0A, 0x0B, 0x00, 0x00, 0x00, 0x03, 0xBD, 0xFD, 0xF9, 0xB5, 0xF2, 0x90, 0x80);
const SYNTHETIC_WIDTH = 192;
const SYNTHETIC_HEIGHT = 192;
const TEMPORAL_DELIMITER_OBU = Uint8Array.of(0x12, 0x00);
const FRAME_DURATION_MILLISECONDS = 40;
const SYNTHETIC_SAMPLES = [
    { data: TEMPORAL_DELIMITER_OBU, keyframe: true, timestampMilliseconds: 0 },
    { data: TEMPORAL_DELIMITER_OBU, keyframe: false, timestampMilliseconds: FRAME_DURATION_MILLISECONDS }
];
const AV1_SAMPLE_ENTRY = 'av01';
const AV1_CONFIGURATION_BOX = 'av1C';
const FIELD_BOX = 'fiel';
const ISO_BASE_MEDIA_MAJOR_BRAND = 'isom';
// FieldOrder 6 padded to two bytes, as an unsigned integer element may be
const PADDED_BOTTOM_FIRST_PAYLOAD = Uint8Array.of(0x00, FIELD_ORDER_BOTTOM_FIRST);
// The Info element's MuxingApp: libavformat 57.36.100 to 57.51.100 wrote FieldOrder 9 and 14 swapped, and FFmpeg's demuxer swaps them back
const MUXING_APPLICATION_ID = 0x4D80;
const SWAPPED_FIELD_ORDER_MUXER = 'Lavf57.41.100';
const FIRST_SWAPPED_FIELD_ORDER_MUXER = 'Lavf57.36.100';
const LAST_SWAPPED_FIELD_ORDER_MUXER = 'Lavf57.51.100';
const LATER_MICRO_SWAPPED_FIELD_ORDER_MUXER = 'Lavf57.41.101';
// sscanf's %d skips whitespace and takes a sign, and the text after the micro version is not read
const SPACED_SWAPPED_FIELD_ORDER_MUXER = 'Lavf57. +40. 100 (patched)';
const BEFORE_SWAPPED_FIELD_ORDER_MUXER = 'Lavf57.35.100';
const FIXED_SWAPPED_FIELD_ORDER_MUXER = 'Lavf57.52.100';
const EARLY_MICRO_FIELD_ORDER_MUXER = 'Lavf57.41.99';
const LATER_MAJOR_FIELD_ORDER_MUXER = 'Lavf58.41.100';
const MINOR_ONLY_FIELD_ORDER_MUXER = 'Lavf57.41';
const OTHER_MUXER = 'libebml v1.4.5 + libmatroska v1.7.1';
// A string element may end in terminators, which end the string as FFmpeg reads it
const TERMINATED_SWAPPED_FIELD_ORDER_MUXER_PAYLOAD = Uint8Array.from([ ...Array.from(SWAPPED_FIELD_ORDER_MUXER, (character: string): number => character.charCodeAt(0)), 0x00, 0x00 ]);

type ContainerCase = Readonly<{ expected: VideoScan; name: string; values: readonly number[] }>;

const MATROSKA_CASES: readonly ContainerCase[] = [
    { expected: 'top-first', name: 'interlaced, top field first', values: [ FLAG_INTERLACED_INTERLACED, FIELD_ORDER_TOP_FIRST ] },
    { expected: 'bottom-first', name: 'interlaced, bottom field first', values: [ FLAG_INTERLACED_INTERLACED, FIELD_ORDER_BOTTOM_FIRST ] },
    { expected: 'bottom-first', name: 'interlaced, top coded and bottom shown first', values: [ FLAG_INTERLACED_INTERLACED, FIELD_ORDER_TOP_CODED_BOTTOM_SHOWN_FIRST ] },
    { expected: 'top-first', name: 'interlaced, bottom coded and top shown first', values: [ FLAG_INTERLACED_INTERLACED, FIELD_ORDER_BOTTOM_CODED_TOP_SHOWN_FIRST ] },
    { expected: 'interlaced', name: 'interlaced, an undetermined field order', values: [ FLAG_INTERLACED_INTERLACED, FIELD_ORDER_UNDETERMINED ] },
    { expected: 'interlaced', name: 'interlaced without a field order', values: [ FLAG_INTERLACED_INTERLACED ] },
    { expected: 'progressive', name: 'interlaced with a progressive field order', values: [ FLAG_INTERLACED_INTERLACED, FIELD_ORDER_PROGRESSIVE ] },
    { expected: 'progressive', name: 'progressive, whatever its field order', values: [ FLAG_INTERLACED_PROGRESSIVE, FIELD_ORDER_TOP_FIRST ] },
    { expected: 'unknown', name: 'undetermined, whatever its field order', values: [ FLAG_INTERLACED_UNDETERMINED, FIELD_ORDER_TOP_FIRST ] },
    { expected: 'unknown', name: 'neither element', values: [] }
];

const FIELD_BOX_CASES: readonly ContainerCase[] = [
    { expected: 'progressive', name: 'one field', values: [ PROGRESSIVE_FIELD_COUNT, FIELD_ORDER_PROGRESSIVE ] },
    { expected: 'top-first', name: 'two fields, top first', values: [ INTERLACED_FIELD_COUNT, FIELD_ORDER_TOP_FIRST ] },
    { expected: 'bottom-first', name: 'two fields, bottom first', values: [ INTERLACED_FIELD_COUNT, FIELD_ORDER_BOTTOM_FIRST ] },
    { expected: 'bottom-first', name: 'two fields, top coded and bottom shown first', values: [ INTERLACED_FIELD_COUNT, FIELD_ORDER_TOP_CODED_BOTTOM_SHOWN_FIRST ] },
    { expected: 'top-first', name: 'two fields, bottom coded and top shown first', values: [ INTERLACED_FIELD_COUNT, FIELD_ORDER_BOTTOM_CODED_TOP_SHOWN_FIRST ] },
    { expected: 'interlaced', name: 'two fields of an unnamed order', values: [ INTERLACED_FIELD_COUNT, FIELD_ORDER_PROGRESSIVE ] },
    { expected: 'unknown', name: 'an invalid field count', values: [ INVALID_FIELD_COUNT, FIELD_ORDER_TOP_FIRST ] },
    { expected: 'unknown', name: 'a truncated box', values: [ INTERLACED_FIELD_COUNT ] }
];

function createMatroska(videoElements: readonly Uint8Array[], infoElements: readonly Uint8Array[] = []): Uint8Array {
    return createVideoTrackMatroska({
        blocks: SYNTHETIC_SAMPLES,
        codecID: MATROSKA_AV1_CODEC_ID,
        codecPrivate: SYNTHETIC_CONFIGURATION_RECORD,
        defaultDurationMilliseconds: FRAME_DURATION_MILLISECONDS,
        infoElements,
        pixelHeight: SYNTHETIC_HEIGHT,
        pixelWidth: SYNTHETIC_WIDTH,
        videoElements
    });
}

/** The FlagInterlaced element, then the FieldOrder element, of the values given. */
function createFieldElements(values: readonly number[]): Uint8Array[] {
    const ids = [ FLAG_INTERLACED_ID, FIELD_ORDER_ID ];
    return values.map((value: number, index: number): Uint8Array => createUnsignedIntegerElement(ids[index], value));
}

function createISOBaseMedia(fieldBoxPayload: Uint8Array | null): Uint8Array {
    return createVideoTrackISOBaseMedia({
        frameDurationMilliseconds: FRAME_DURATION_MILLISECONDS,
        height: SYNTHETIC_HEIGHT,
        majorBrand: ISO_BASE_MEDIA_MAJOR_BRAND,
        sampleEntry: createVisualSampleEntry(AV1_SAMPLE_ENTRY, SYNTHETIC_WIDTH, SYNTHETIC_HEIGHT, [
            createBox(AV1_CONFIGURATION_BOX, SYNTHETIC_CONFIGURATION_RECORD),
            ...(fieldBoxPayload ? [ createBox(FIELD_BOX, fieldBoxPayload) ] : [])
        ]),
        samples: SYNTHETIC_SAMPLES,
        width: SYNTHETIC_WIDTH
    });
}

async function readScan(file: Uint8Array, formats: InputFormat[]): Promise<VideoScan> {
    const input = new Input({ formats, source: new BufferSource(file) });
    try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) {
            throw new Error('The file has no video track');
        }
        return await readContainerVideoScan(track);
    } finally {
        input.dispose();
    }
}

describe('readContainerVideoScan', () => {
    it.each(MATROSKA_CASES)('reads a Matroska track that is $name', async (containerCase: ContainerCase) => {
        expect(await readScan(createMatroska(createFieldElements(containerCase.values)), withMatroskaVideoFieldOrder(ALL_FORMATS))).toBe(containerCase.expected);
    });

    it('reads an unsigned integer element of more bytes than its value needs', async () => {
        const elements = [ createUnsignedIntegerElement(FLAG_INTERLACED_ID, FLAG_INTERLACED_INTERLACED), createElement(FIELD_ORDER_ID, PADDED_BOTTOM_FIRST_PAYLOAD) ];

        expect(await readScan(createMatroska(elements), withMatroskaVideoFieldOrder(ALL_FORMATS))).toBe('bottom-first');
    });

    it.each([
        { expected: 'top-first', fieldOrder: FIELD_ORDER_TOP_CODED_BOTTOM_SHOWN_FIRST },
        { expected: 'bottom-first', fieldOrder: FIELD_ORDER_BOTTOM_CODED_TOP_SHOWN_FIRST },
        { expected: 'top-first', fieldOrder: FIELD_ORDER_TOP_FIRST },
        { expected: 'bottom-first', fieldOrder: FIELD_ORDER_BOTTOM_FIRST }
    ] as const)('swaps FieldOrder 9 and 14 back, and keeps $fieldOrder otherwise, for a muxer that wrote them swapped', async ({ expected, fieldOrder }) => {
        const file = createMatroska(
            createFieldElements([ FLAG_INTERLACED_INTERLACED, fieldOrder ]),
            [ createASCIIElement(MUXING_APPLICATION_ID, SWAPPED_FIELD_ORDER_MUXER) ]
        );

        expect(await readScan(file, withMatroskaVideoFieldOrder(ALL_FORMATS))).toBe(expected);
    });

    it('reads a MuxingApp up to its terminator', async () => {
        const file = createMatroska(
            createFieldElements([ FLAG_INTERLACED_INTERLACED, FIELD_ORDER_TOP_CODED_BOTTOM_SHOWN_FIRST ]),
            [ createElement(MUXING_APPLICATION_ID, TERMINATED_SWAPPED_FIELD_ORDER_MUXER_PAYLOAD) ]
        );

        expect(await readScan(file, withMatroskaVideoFieldOrder(ALL_FORMATS))).toBe('top-first');
    });

    it('keeps FieldOrder 9 and 14 for another muxer', async () => {
        const file = createMatroska(
            createFieldElements([ FLAG_INTERLACED_INTERLACED, FIELD_ORDER_TOP_CODED_BOTTOM_SHOWN_FIRST ]),
            [ createASCIIElement(MUXING_APPLICATION_ID, OTHER_MUXER) ]
        );

        expect(await readScan(file, withMatroskaVideoFieldOrder(ALL_FORMATS))).toBe('bottom-first');
    });

    it.each([
        { muxingApplication: SWAPPED_FIELD_ORDER_MUXER, swapped: true },
        { muxingApplication: FIRST_SWAPPED_FIELD_ORDER_MUXER, swapped: true },
        { muxingApplication: LAST_SWAPPED_FIELD_ORDER_MUXER, swapped: true },
        { muxingApplication: LATER_MICRO_SWAPPED_FIELD_ORDER_MUXER, swapped: true },
        { muxingApplication: SPACED_SWAPPED_FIELD_ORDER_MUXER, swapped: true },
        { muxingApplication: BEFORE_SWAPPED_FIELD_ORDER_MUXER, swapped: false },
        { muxingApplication: FIXED_SWAPPED_FIELD_ORDER_MUXER, swapped: false },
        { muxingApplication: EARLY_MICRO_FIELD_ORDER_MUXER, swapped: false },
        { muxingApplication: LATER_MAJOR_FIELD_ORDER_MUXER, swapped: false },
        { muxingApplication: MINOR_ONLY_FIELD_ORDER_MUXER, swapped: false },
        { muxingApplication: OTHER_MUXER, swapped: false },
        { muxingApplication: null, swapped: false }
    ])('decides that $muxingApplication swapped FieldOrder 9 and 14: $swapped', ({ muxingApplication, swapped }) => {
        expect(hasSwappedMatroskaFieldOrders(muxingApplication)).toBe(swapped);
    });

    it('knows no Matroska scan from formats that do not record it', async () => {
        const file = createMatroska(createFieldElements([ FLAG_INTERLACED_INTERLACED, FIELD_ORDER_TOP_FIRST ]));

        expect(await readScan(file, ALL_FORMATS)).toBe('unknown');
    });

    it('leaves the other formats in their places', () => {
        const formats = withMatroskaVideoFieldOrder(ALL_FORMATS);

        expect(formats).toHaveLength(ALL_FORMATS.length);
        ALL_FORMATS.forEach((format: InputFormat, index: number): void => {
            expect(Object.getPrototypeOf(formats[index]) === format || formats[index] === format).toBe(true);
        });
    });

    it.each(FIELD_BOX_CASES)('reads an ISO base media sample entry\'s fiel box of $name', async (containerCase: ContainerCase) => {
        expect(await readScan(createISOBaseMedia(Uint8Array.from(containerCase.values)), ALL_FORMATS)).toBe(containerCase.expected);
    });

    it('knows no scan of an ISO base media sample entry without a fiel box', async () => {
        expect(await readScan(createISOBaseMedia(null), ALL_FORMATS)).toBe('unknown');
    });
});
