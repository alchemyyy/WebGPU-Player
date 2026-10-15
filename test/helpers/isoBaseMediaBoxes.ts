// ISO base media box builders shared by the synthetic container tests, and a file of one video track

import { concatenate } from './byteArrays';

/** One sample of a synthetic video track. */
export type SyntheticISOBaseMediaSample = Readonly<{
    data: Uint8Array
    keyframe: boolean
    /** The sample's presentation time in milliseconds, the file's timescale */
    timestampMilliseconds: number
}>;

/** The one video track of a synthetic ISO base media file, and the boxes ahead of its ftyp. */
export type SyntheticISOBaseMediaVideoTrack = Readonly<{
    frameDurationMilliseconds: number
    height: number
    /** Boxes ahead of ftyp, such as Motion JPEG 2000's signature box */
    leadingBoxes?: readonly Uint8Array[]
    majorBrand: string
    sampleEntry: Uint8Array
    samples: readonly SyntheticISOBaseMediaSample[]
    width: number
}>;

const ISO_TIMESCALE = 1_000;
const ISO_TRACK_ID = 1;
const FIXED_POINT_ONE = 0x0001_0000;
const FIXED_POINT_SHIFT = 16;
const FIXED_POINT_VOLUME_ONE = 0x0100;
const IDENTITY_MATRIX = Object.freeze([ FIXED_POINT_ONE, 0, 0, 0, FIXED_POINT_ONE, 0, 0, 0, 0x4000_0000 ]);
const TRACK_HEADER_FLAGS = 0x000003;
const DATA_REFERENCE_SELF_CONTAINED_FLAG = 0x000001;
const VIDEO_MEDIA_HEADER_FLAGS = 0x000001;
const VIDEO_HANDLER_TYPE = 'vide';
const SEVENTY_TWO_DPI = 0x0048_0000;
const VISUAL_SAMPLE_ENTRY_DEPTH = 0x0018;
const PRE_DEFINED_MINUS_ONE = 0xFFFF;
const COMPRESSOR_NAME_BYTE_LENGTH = 32;
const UNDETERMINED_LANGUAGE = 0x55C4;
const FIRST_CHUNK = 1;
const FIRST_SAMPLE_DESCRIPTION = 1;
const BOX_HEADER_BYTE_LENGTH = 8;
const VERSION_SHIFT = 24;

export function encodeUnsigned32(value: number): Uint8Array {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0);
    return bytes;
}

export function encodeUnsigned16(value: number): Uint8Array {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value);
    return bytes;
}

function encodeFourCC(value: string): Uint8Array {
    return new Uint8Array(Array.from(value, (character: string): number => character.charCodeAt(0)));
}

export function createBox(type: string, ...payloads: readonly Uint8Array[]): Uint8Array {
    const payload = concatenate(payloads);
    return concatenate([
        encodeUnsigned32(payload.byteLength + BOX_HEADER_BYTE_LENGTH),
        encodeFourCC(type),
        payload
    ]);
}

export function createFullBox(type: string, version: number, flags: number, ...payloads: readonly Uint8Array[]): Uint8Array {
    return createBox(type, encodeUnsigned32(((version << VERSION_SHIFT) | flags) >>> 0), ...payloads);
}

function createMatrix(): Uint8Array {
    return concatenate(IDENTITY_MATRIX.map(encodeUnsigned32));
}

/** Returns a visual sample entry of a type, such as vc-1 or mjp2, holding the given boxes. */
export function createVisualSampleEntry(type: string, width: number, height: number, boxes: readonly Uint8Array[] = []): Uint8Array {
    return createBox(
        type,
        new Uint8Array(6),
        encodeUnsigned16(1),
        new Uint8Array(2 + 2 + 12),
        encodeUnsigned16(width),
        encodeUnsigned16(height),
        encodeUnsigned32(SEVENTY_TWO_DPI),
        encodeUnsigned32(SEVENTY_TWO_DPI),
        new Uint8Array(4),
        encodeUnsigned16(1),
        new Uint8Array(COMPRESSOR_NAME_BYTE_LENGTH),
        encodeUnsigned16(VISUAL_SAMPLE_ENTRY_DEPTH),
        encodeUnsigned16(PRE_DEFINED_MINUS_ONE),
        ...boxes
    );
}

/**
 * Returns an ISO base media file of one video track with the given sample entry, after any leading boxes and an ftyp of the major brand.
 * Samples are in decode order at frame-duration decode times; each sample's composition time is its timestamp.
 */
export function createVideoTrackISOBaseMedia(track: SyntheticISOBaseMediaVideoTrack): Uint8Array {
    const { frameDurationMilliseconds, height, samples, width } = track;
    const durationInTimescale = samples.length * frameDurationMilliseconds;
    const createMovie = (chunkOffset: number): Uint8Array => createBox(
        'moov',
        createFullBox('mvhd', 0, 0,
            new Uint8Array(8),
            encodeUnsigned32(ISO_TIMESCALE),
            encodeUnsigned32(durationInTimescale),
            encodeUnsigned32(FIXED_POINT_ONE),
            encodeUnsigned16(FIXED_POINT_VOLUME_ONE),
            new Uint8Array(10),
            createMatrix(),
            new Uint8Array(24),
            encodeUnsigned32(ISO_TRACK_ID + 1)),
        createBox('trak',
            createFullBox('tkhd', 0, TRACK_HEADER_FLAGS,
                new Uint8Array(8),
                encodeUnsigned32(ISO_TRACK_ID),
                new Uint8Array(4),
                encodeUnsigned32(durationInTimescale),
                new Uint8Array(8 + 2 + 2 + 2 + 2),
                createMatrix(),
                encodeUnsigned32(width << FIXED_POINT_SHIFT),
                encodeUnsigned32(height << FIXED_POINT_SHIFT)),
            createBox('mdia',
                createFullBox('mdhd', 0, 0,
                    new Uint8Array(8),
                    encodeUnsigned32(ISO_TIMESCALE),
                    encodeUnsigned32(durationInTimescale),
                    encodeUnsigned16(UNDETERMINED_LANGUAGE),
                    new Uint8Array(2)),
                createFullBox('hdlr', 0, 0, new Uint8Array(4), encodeFourCC(VIDEO_HANDLER_TYPE), new Uint8Array(12), new Uint8Array(1)),
                createBox('minf',
                    createFullBox('vmhd', 0, VIDEO_MEDIA_HEADER_FLAGS, new Uint8Array(8)),
                    createBox('dinf', createFullBox('dref', 0, 0, encodeUnsigned32(1), createFullBox('url ', 0, DATA_REFERENCE_SELF_CONTAINED_FLAG))),
                    createBox('stbl',
                        createFullBox('stsd', 0, 0, encodeUnsigned32(1), track.sampleEntry),
                        createFullBox('stts', 0, 0, encodeUnsigned32(1), encodeUnsigned32(samples.length), encodeUnsigned32(frameDurationMilliseconds)),
                        createFullBox('ctts', 0, 0,
                            encodeUnsigned32(samples.length),
                            ...samples.flatMap((sample: SyntheticISOBaseMediaSample, sampleIndex: number): Uint8Array[] => [
                                encodeUnsigned32(1),
                                encodeUnsigned32(sample.timestampMilliseconds - (sampleIndex * frameDurationMilliseconds))
                            ])),
                        createFullBox('stss', 0, 0,
                            encodeUnsigned32(samples.filter(sample => sample.keyframe).length),
                            ...samples.flatMap((sample: SyntheticISOBaseMediaSample, sampleIndex: number): Uint8Array[] => (
                                sample.keyframe ? [ encodeUnsigned32(sampleIndex + 1) ] : []
                            ))),
                        createFullBox('stsc', 0, 0, encodeUnsigned32(1), encodeUnsigned32(FIRST_CHUNK), encodeUnsigned32(samples.length), encodeUnsigned32(FIRST_SAMPLE_DESCRIPTION)),
                        createFullBox('stsz', 0, 0, encodeUnsigned32(0), encodeUnsigned32(samples.length), ...samples.map(sample => encodeUnsigned32(sample.data.byteLength))),
                        createFullBox('stco', 0, 0, encodeUnsigned32(1), encodeUnsigned32(chunkOffset)))))));
    const header = concatenate([
        ...(track.leadingBoxes ?? []),
        createBox('ftyp', encodeFourCC(track.majorBrand), encodeUnsigned32(0), encodeFourCC(track.majorBrand))
    ]);
    // The movie's size does not depend on the offset it records, so a first layout places the media data
    const mediaDataStart = header.byteLength + createMovie(0).byteLength + BOX_HEADER_BYTE_LENGTH;
    return concatenate([ header, createMovie(mediaDataStart), createBox('mdat', ...samples.map(sample => sample.data)) ]);
}
