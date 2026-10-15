// @vitest-environment node

import { ALL_FORMATS, BufferSource, Input, type InputVideoTrack } from 'mediabunny';
import { describe, expect, it } from 'vitest';

import {
    MATROSKA_VFW_CODEC_ID,
    readMatroskaVC1DecoderDescription,
    readMatroskaWMV3DecoderDescription,
    type VC1DecoderDescriptionResult
} from 'webgpu-player/demux/vc1/MatroskaVFWVideoConfiguration';

import { concatenate } from '../../helpers/byteArrays';
import {
    BITMAP_INFO_HEADER_BYTE_LENGTH,
    createVC1AdvancedExtradata,
    createVFWCodecPrivate,
    createVFWMatroska,
    createWMV3Picture,
    createWMV3SequenceHeader,
    type WMV3SequenceFields
} from '../../helpers/vc1Media';

const CODED_WIDTH = 320;
const CODED_HEIGHT = 240;
// A file whose BITMAPINFOHEADER disagrees with its track's pixel size, which FFmpeg ignores for the track's
const HEADER_WIDTH = 352;
const HEADER_HEIGHT = 288;
const MAIN_PROFILE = 1;
const WMV3_FIELDS: WMV3SequenceFields = { frameInterpolation: false, maximumBFrames: 1, profile: MAIN_PROFILE, rangeReduction: true };
// STRUCT_C as some AVI muxers store it, with two bytes after the sequence header that FFmpeg reads past
const TRAILING_EXTRADATA = Object.freeze([ 0x40, 0x1F ]);
// The leading size byte of WVC1 extradata in Matroska, as mkvmerge and FFmpeg write it
const WVC1_SIZE_BYTE = 0x27;
const UNPRINTABLE_FOURCC = '\u0001\u0002\u0003\u0004';
const UNPRINTABLE_FOURCC_DETAIL = 'fourcc: 0x01020304';
// The BITMAPINFOHEADER fields a WMV3 description carries, little-endian
const HEADER_SIZE_OFFSET = 0;
const WIDTH_OFFSET = 4;
const HEIGHT_OFFSET = 8;
const PLANES_OFFSET = 12;
const BIT_COUNT_OFFSET = 14;
const FOURCC_OFFSET = 16;
const FOURCC_BYTE_LENGTH = 4;
const PLANE_COUNT = 1;
const BIT_COUNT = 24;
const FRAME_TIMESTAMP_MILLISECONDS = 0;

function createTrack(codecPrivate: unknown): InputVideoTrack {
    return { _backing: { internalTrack: { codecPrivate } } } as unknown as InputVideoTrack;
}

function requireDescription(result: VC1DecoderDescriptionResult): Uint8Array {
    if (result.status !== 'read') {
        throw new Error(`Expected a description, got ${result.failure}`);
    }
    return result.description;
}

function readFourCC(description: Uint8Array): string {
    return String.fromCharCode(...description.subarray(FOURCC_OFFSET, FOURCC_OFFSET + FOURCC_BYTE_LENGTH));
}

/** Opens a Matroska file of one VfW track with one picture, as the playback worker reads it. */
async function openMatroskaTrack(codecPrivate: Uint8Array): Promise<{ input: Input, track: InputVideoTrack }> {
    const matroska = createVFWMatroska(codecPrivate, CODED_WIDTH, CODED_HEIGHT, [
        { data: createWMV3Picture('I', WMV3_FIELDS), keyframe: true, timestampMilliseconds: FRAME_TIMESTAMP_MILLISECONDS }
    ]);
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(matroska) });
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
        throw new Error('The synthetic Matroska file has no video track');
    }
    return { input, track };
}

describe('readMatroskaWMV3DecoderDescription', () => {
    it('frames the STRUCT_C FFmpeg\'s wmv3 decoder gets behind a BITMAPINFOHEADER of the container\'s coded size and the WMV3 FourCC', () => {
        const structC = createWMV3SequenceHeader(WMV3_FIELDS);
        const codecPrivate = createVFWCodecPrivate('WMV3', HEADER_WIDTH, -HEADER_HEIGHT, structC);

        const description = requireDescription(readMatroskaWMV3DecoderDescription(createTrack(codecPrivate), CODED_WIDTH, CODED_HEIGHT));

        const header = new DataView(description.buffer, description.byteOffset, BITMAP_INFO_HEADER_BYTE_LENGTH);
        expect(description.byteLength).toBe(BITMAP_INFO_HEADER_BYTE_LENGTH + structC.byteLength);
        expect(header.getUint32(HEADER_SIZE_OFFSET, true)).toBe(description.byteLength);
        expect(header.getInt32(WIDTH_OFFSET, true)).toBe(CODED_WIDTH);
        expect(header.getInt32(HEIGHT_OFFSET, true)).toBe(CODED_HEIGHT);
        expect(header.getUint16(PLANES_OFFSET, true)).toBe(PLANE_COUNT);
        expect(header.getUint16(BIT_COUNT_OFFSET, true)).toBe(BIT_COUNT);
        expect(readFourCC(description)).toBe('WMV3');
        expect(description.subarray(BITMAP_INFO_HEADER_BYTE_LENGTH)).toEqual(structC);
    });

    it('keeps every extradata byte after the header, whatever biSize declares, as FFmpeg\'s Matroska demuxer does', () => {
        const extradata = concatenate([ createWMV3SequenceHeader(WMV3_FIELDS), new Uint8Array(TRAILING_EXTRADATA) ]);
        const codecPrivate = createVFWCodecPrivate('WMV3', CODED_WIDTH, CODED_HEIGHT, extradata, BITMAP_INFO_HEADER_BYTE_LENGTH);

        const description = requireDescription(readMatroskaWMV3DecoderDescription(createTrack(codecPrivate), CODED_WIDTH, CODED_HEIGHT));

        expect(description.subarray(BITMAP_INFO_HEADER_BYTE_LENGTH)).toEqual(extradata);
    });

    it('returns its own copy of the extradata', () => {
        const codecPrivate = createVFWCodecPrivate('WMV3', CODED_WIDTH, CODED_HEIGHT, createWMV3SequenceHeader(WMV3_FIELDS));

        const description = requireDescription(readMatroskaWMV3DecoderDescription(createTrack(codecPrivate), CODED_WIDTH, CODED_HEIGHT));
        const extradataBefore = description.slice(BITMAP_INFO_HEADER_BYTE_LENGTH);
        codecPrivate.fill(0, BITMAP_INFO_HEADER_BYTE_LENGTH);

        expect(description.subarray(BITMAP_INFO_HEADER_BYTE_LENGTH)).toEqual(extradataBefore);
    });

    it.each([
        [ 'another codec\'s FourCC', createVFWCodecPrivate('WVC1', CODED_WIDTH, CODED_HEIGHT, createWMV3SequenceHeader(WMV3_FIELDS)), 'fourcc: WVC1' ],
        [ 'an unprintable FourCC', createVFWCodecPrivate(UNPRINTABLE_FOURCC, CODED_WIDTH, CODED_HEIGHT, createWMV3SequenceHeader(WMV3_FIELDS)), UNPRINTABLE_FOURCC_DETAIL ],
        [ 'a header without extradata', createVFWCodecPrivate('WMV3', CODED_WIDTH, CODED_HEIGHT, new Uint8Array()), `codec-private-size: ${BITMAP_INFO_HEADER_BYTE_LENGTH}` ],
        [ 'no CodecPrivate', undefined, 'codec-private-missing: undefined' ]
    ])('refuses %s with the failed check', (_label: string, codecPrivate: Uint8Array | undefined, failure: string) => {
        expect(readMatroskaWMV3DecoderDescription(createTrack(codecPrivate), CODED_WIDTH, CODED_HEIGHT)).toEqual({ failure, status: 'failed' });
    });

    it('reads the CodecPrivate of a VfW track Mediabunny 1.52.2 demuxes', async () => {
        const structC = createWMV3SequenceHeader(WMV3_FIELDS);
        const { input, track } = await openMatroskaTrack(createVFWCodecPrivate('WMV3', CODED_WIDTH, CODED_HEIGHT, structC));
        try {
            expect(await track.getCodec()).toBeNull();
            expect(await track.getInternalCodecId()).toBe(MATROSKA_VFW_CODEC_ID);

            const description = requireDescription(readMatroskaWMV3DecoderDescription(track, CODED_WIDTH, CODED_HEIGHT));

            expect(description.subarray(BITMAP_INFO_HEADER_BYTE_LENGTH)).toEqual(structC);
        } finally {
            input.dispose();
        }
    });
});

describe('readMatroskaVC1DecoderDescription', () => {
    it.each([ 'WVC1', 'WMVA' ])('reads the extradata after a %s header, its size byte and trailing zero included, as FFmpeg reads it', (fourCC: string) => {
        const extradata = concatenate([ createVC1AdvancedExtradata(CODED_WIDTH, CODED_HEIGHT, false, WVC1_SIZE_BYTE), new Uint8Array(1) ]);
        const codecPrivate = createVFWCodecPrivate(fourCC, CODED_WIDTH, CODED_HEIGHT, extradata, BITMAP_INFO_HEADER_BYTE_LENGTH + extradata.byteLength - 1);

        expect(requireDescription(readMatroskaVC1DecoderDescription(createTrack(codecPrivate)))).toEqual(extradata);
    });

    it('reads a header whose frame size differs from the track\'s, which FFmpeg never reads', () => {
        const extradata = createVC1AdvancedExtradata(CODED_WIDTH, CODED_HEIGHT, false);
        const codecPrivate = createVFWCodecPrivate('WVC1', HEADER_WIDTH, HEADER_HEIGHT, extradata);

        expect(requireDescription(readMatroskaVC1DecoderDescription(createTrack(codecPrivate)))).toEqual(extradata);
    });

    it('refuses a WMV3 track, whose extradata is no VC-1 extradata', () => {
        const codecPrivate = createVFWCodecPrivate('WMV3', CODED_WIDTH, CODED_HEIGHT, createWMV3SequenceHeader(WMV3_FIELDS));

        expect(readMatroskaVC1DecoderDescription(createTrack(codecPrivate))).toEqual({ failure: 'fourcc: WMV3', status: 'failed' });
    });

    it('refuses a header without extradata', () => {
        const codecPrivate = createVFWCodecPrivate('WVC1', CODED_WIDTH, CODED_HEIGHT, new Uint8Array());

        expect(readMatroskaVC1DecoderDescription(createTrack(codecPrivate)))
            .toEqual({ failure: `codec-private-size: ${BITMAP_INFO_HEADER_BYTE_LENGTH}`, status: 'failed' });
    });
});
