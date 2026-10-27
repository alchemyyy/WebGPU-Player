// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ALL_FORMATS, BufferSource, Input, PacketCursor, type InputVideoTrack } from 'mediabunny';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    readMPEG4TrackConfiguration,
    type MPEG4TrackCodec,
    type MPEG4TrackConfiguration
} from 'webgpu-player/demux/mpeg4/MPEG4TrackConfiguration';

import { concatenate } from '../../helpers/byteArrays';
import { DECODERS_DIRECTORY } from '../../helpers/enginePaths';
import { createVideoTrackMatroska, type SyntheticMatroskaBlock } from '../../helpers/matroskaElements';
import { createMPEG4Extradata, createMPEG4VOP, type MPEG4VideoObjectLayerFields } from '../../helpers/mpeg4Bitstream';
import { createVFWCodecPrivate } from '../../helpers/vc1Media';

const CODED_WIDTH = 176;
const CODED_HEIGHT = 144;
// The VfW header's own size, which the codec private data replaces with the track's
const HEADER_WIDTH = 352;
const HEADER_HEIGHT = 288;
const FRAME_MILLISECONDS = 40;
const MILLISECONDS_PER_SECOND = 1_000;
const TIME_INCREMENT_RESOLUTION = 25;
const TIME_INCREMENT_BIT_COUNT = 5;
const B_VOP_LAYER: MPEG4VideoObjectLayerFields = { lowDelay: false, timeIncrementResolution: TIME_INCREMENT_RESOLUTION };
const LOW_DELAY_LAYER: MPEG4VideoObjectLayerFields = { lowDelay: true, timeIncrementResolution: TIME_INCREMENT_RESOLUTION };
const BITMAP_INFO_HEADER_BYTE_LENGTH = 40;
const HEADER_SIZE_OFFSET = 0;
const WIDTH_OFFSET = 4;
const HEIGHT_OFFSET = 8;
const PLANES_OFFSET = 12;
const BIT_COUNT_OFFSET = 14;
const FOURCC_OFFSET = 16;
const FOURCC_BYTE_LENGTH = 4;
const VFW_CODEC_ID = 'V_MS/VFW/FOURCC';
const UNPRINTABLE_FOURCC = '\u0001\u0002\u0003\u0004';
// The vectors of the mpeg4 decoder project
const VECTOR_DIRECTORY = join(DECODERS_DIRECTORY, 'mpeg4', 'vectors');

type ReadConfiguration = Extract<MPEG4TrackConfiguration, { status: 'read' }>;

const openInputs: Input[] = [];

/** Decode order I0 P2 B1, each packet at its decode slot's time, the key packet after the headers an encoder repeats there when asked. */
function createBlocks(keyPacketHeaders: Uint8Array): SyntheticMatroskaBlock[] {
    return [
        { data: concatenate([ keyPacketHeaders, createMPEG4VOP('I', true, TIME_INCREMENT_BIT_COUNT) ]), keyframe: true, timestampMilliseconds: 0 },
        { data: createMPEG4VOP('P', true, TIME_INCREMENT_BIT_COUNT), keyframe: false, timestampMilliseconds: FRAME_MILLISECONDS },
        { data: createMPEG4VOP('B', true, TIME_INCREMENT_BIT_COUNT), keyframe: false, timestampMilliseconds: 2 * FRAME_MILLISECONDS }
    ];
}

async function openTrack(media: Uint8Array): Promise<InputVideoTrack> {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(media) });
    openInputs.push(input);
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
        throw new Error('The file has no video track');
    }
    return track;
}

function openMatroskaTrack(codecID: string, codecPrivate: Uint8Array | null, keyPacketHeaders: Uint8Array = new Uint8Array()): Promise<InputVideoTrack> {
    return openTrack(createVideoTrackMatroska({
        blocks: createBlocks(keyPacketHeaders),
        codecID,
        codecPrivate,
        defaultDurationMilliseconds: FRAME_MILLISECONDS,
        pixelHeight: CODED_HEIGHT,
        pixelWidth: CODED_WIDTH
    }));
}

async function readConfiguration(codec: MPEG4TrackCodec, track: InputVideoTrack, avi = false): Promise<MPEG4TrackConfiguration> {
    const [ containerCodec, internalCodecID ] = await Promise.all([ track.getCodec(), track.getInternalCodecId() ]);
    return readMPEG4TrackConfiguration(codec, track, {
        avi,
        codedHeight: CODED_HEIGHT,
        codedWidth: CODED_WIDTH,
        containerCodec,
        internalCodecID: String(internalCodecID)
    });
}

function requireRead(configuration: MPEG4TrackConfiguration): ReadConfiguration {
    if (configuration.status !== 'read') {
        throw new Error(`The configuration failed: ${configuration.failure}`);
    }
    return configuration;
}

/** Requires codec private data of a 40-byte BITMAPINFOHEADER of the track's coded size and a FourCC, and returns the extradata after it. */
function readExtradata(description: Uint8Array, fourCC: string): Uint8Array {
    const header = new DataView(description.buffer, description.byteOffset, BITMAP_INFO_HEADER_BYTE_LENGTH);
    expect(header.getUint32(HEADER_SIZE_OFFSET, true)).toBe(BITMAP_INFO_HEADER_BYTE_LENGTH);
    expect(header.getInt32(WIDTH_OFFSET, true)).toBe(CODED_WIDTH);
    expect(header.getInt32(HEIGHT_OFFSET, true)).toBe(CODED_HEIGHT);
    expect(header.getUint16(PLANES_OFFSET, true)).toBe(1);
    expect(header.getUint16(BIT_COUNT_OFFSET, true)).toBe(24);
    expect(String.fromCharCode(...description.subarray(FOURCC_OFFSET, FOURCC_OFFSET + FOURCC_BYTE_LENGTH))).toBe(fourCC);
    return description.subarray(BITMAP_INFO_HEADER_BYTE_LENGTH);
}

async function readFrames(track: InputVideoTrack): Promise<number[]> {
    const frames: number[] = [];
    for await (const packet of new PacketCursor(track)) {
        frames.push(Math.round(packet.timestamp * MILLISECONDS_PER_SECOND / FRAME_MILLISECONDS));
    }
    return frames;
}

beforeEach(() => {
    // Mediabunny warns that it maps no codec to a VfW or V_MPEG4/MS/V3 track
    vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
});

afterEach(() => {
    for (const input of openInputs.splice(0)) {
        input.dispose();
    }
});

describe('readMPEG4TrackConfiguration', () => {
    it('gives a Matroska VfW track its FourCC and extradata behind a header of the track\'s size, and restamps its B-VOPs', async () => {
        const extradata = createMPEG4Extradata(B_VOP_LAYER);
        const track = await openMatroskaTrack(VFW_CODEC_ID, createVFWCodecPrivate('XVID', HEADER_WIDTH, HEADER_HEIGHT, extradata));

        const configuration = requireRead(await readConfiguration('mpeg4', track));

        expect(readExtradata(configuration.description, 'XVID')).toEqual(extradata);
        expect(await readFrames(configuration.videoTrack)).toEqual([ 1, 3, 2 ]);
    });

    it('reads the video object layer from the first key packet of a VfW track whose extradata holds none', async () => {
        const track = await openMatroskaTrack(VFW_CODEC_ID, createVFWCodecPrivate('DX50', CODED_WIDTH, CODED_HEIGHT, new Uint8Array()), createMPEG4Extradata(B_VOP_LAYER));

        const configuration = requireRead(await readConfiguration('mpeg4', track));

        expect(readExtradata(configuration.description, 'DX50')).toEqual(new Uint8Array());
        expect(await readFrames(configuration.videoTrack)).toEqual([ 1, 3, 2 ]);
    });

    it.each([
        [ 'a low-delay layer', createMPEG4Extradata(LOW_DELAY_LAYER) ],
        [ 'no video object layer', new Uint8Array() ]
    ])('keeps the decode-order stamps of a VfW track of %s', async (_label: string, extradata: Uint8Array) => {
        const track = await openMatroskaTrack(VFW_CODEC_ID, createVFWCodecPrivate('XVID', CODED_WIDTH, CODED_HEIGHT, extradata));

        const configuration = requireRead(await readConfiguration('mpeg4', track));

        expect(configuration.videoTrack).toBe(track);
    });

    it('keeps a VfW track\'s FourCC as stored, which FFmpeg compares upper-cased', async () => {
        const track = await openMatroskaTrack(VFW_CODEC_ID, createVFWCodecPrivate('div3', CODED_WIDTH, CODED_HEIGHT, new Uint8Array()));

        const configuration = requireRead(await readConfiguration('msmpeg4v3', track));

        expect(readExtradata(configuration.description, 'div3')).toEqual(new Uint8Array());
        expect(configuration.videoTrack).toBe(track);
    });

    it('gives a Matroska MPEG-4 Part 2 track mp4v and its CodecPrivate, and keeps its presentation stamps', async () => {
        const extradata = createMPEG4Extradata(B_VOP_LAYER);
        const track = await openMatroskaTrack('V_MPEG4/ISO/ASP', extradata);

        const configuration = requireRead(await readConfiguration('mpeg4', track));

        expect(readExtradata(configuration.description, 'mp4v')).toEqual(extradata);
        expect(configuration.videoTrack).toBe(track);
    });

    it('gives a Matroska V_MPEG4/MS/V3 track MP43', async () => {
        const track = await openMatroskaTrack('V_MPEG4/MS/V3', null);

        const configuration = requireRead(await readConfiguration('msmpeg4v3', track));

        expect(readExtradata(configuration.description, 'MP43')).toEqual(new Uint8Array());
    });

    it.each([
        [ 'h263.3gp', 'h263', 's263' ],
        [ 'msmpeg4v3.avi', 'msmpeg4v3', 'DIV3' ]
    ] as const)('gives %s, which Mediabunny names no codec, the FourCC %s', async (fileName: string, codec: MPEG4TrackCodec, fourCC: string) => {
        const track = await openTrack(new Uint8Array(readFileSync(join(VECTOR_DIRECTORY, fileName))));

        const configuration = requireRead(await readConfiguration(codec, track, fileName.endsWith('.avi')));

        expect(await track.getCodec()).toBeNull();
        expect(String.fromCharCode(...configuration.description.subarray(FOURCC_OFFSET, FOURCC_OFFSET + FOURCC_BYTE_LENGTH))).toBe(fourCC);
        expect(configuration.description.byteLength).toBe(BITMAP_INFO_HEADER_BYTE_LENGTH);
    });

    it.each([
        [ 'an XVID VfW track as MS-MPEG4 v3', VFW_CODEC_ID, createVFWCodecPrivate('XVID', CODED_WIDTH, CODED_HEIGHT, new Uint8Array()), 'msmpeg4v3', 'fourcc: XVID' ],
        [ 'an MP42 VfW track as MPEG-4 Part 2', VFW_CODEC_ID, createVFWCodecPrivate('MP42', CODED_WIDTH, CODED_HEIGHT, new Uint8Array()), 'mpeg4', 'fourcc: MP42' ],
        [ 'a VfW track of an unknown FourCC', VFW_CODEC_ID, createVFWCodecPrivate('IV50', CODED_WIDTH, CODED_HEIGHT, new Uint8Array()), 'mpeg4', 'fourcc: IV50' ],
        [ 'an unprintable FourCC', VFW_CODEC_ID, createVFWCodecPrivate(UNPRINTABLE_FOURCC, CODED_WIDTH, CODED_HEIGHT, new Uint8Array()), 'mpeg4', 'fourcc: 0x01020304' ],
        [ 'a VfW track without CodecPrivate', VFW_CODEC_ID, null, 'h263', 'codec-private-missing: null' ],
        [ 'a Matroska MPEG-4 Part 2 track as H.263', 'V_MPEG4/ISO/ASP', createMPEG4Extradata(B_VOP_LAYER), 'h263', 'codec-id: V_MPEG4/ISO/ASP' ],
        [ 'an MPEG-2 track as MPEG-4 Part 2', 'V_MPEG2', null, 'mpeg4', 'codec-id: V_MPEG2' ]
    ] as const)('refuses %s with the failed check', async (_label: string, codecID: string, codecPrivate: Uint8Array | null, codec: MPEG4TrackCodec, failure: string) => {
        const track = await openMatroskaTrack(codecID, codecPrivate);

        expect(await readConfiguration(codec, track)).toEqual({ failure, status: 'failed' });
    });

    it('refuses an AVI track whose FourCC FFmpeg maps to another codec', async () => {
        const track = await openTrack(new Uint8Array(readFileSync(join(VECTOR_DIRECTORY, 'msmpeg4v3.avi'))));

        expect(await readConfiguration('mpeg4', track, true)).toEqual({ failure: 'fourcc: DIV3', status: 'failed' });
    });
});
