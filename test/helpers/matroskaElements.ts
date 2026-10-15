// EBML element builders shared by the synthetic Matroska tests, and a Matroska file of one video track

import { concatenate } from './byteArrays';

/** One block of a synthetic video track. */
export type SyntheticMatroskaBlock = Readonly<{
    data: Uint8Array
    keyframe: boolean
    /** Milliseconds, as the block stores it at the file's millisecond timestamp scale */
    timestampMilliseconds: number
}>;

/** The one video track of a synthetic Matroska file, its blocks in one cluster. */
export type SyntheticMatroskaVideoTrack = Readonly<{
    blocks: readonly SyntheticMatroskaBlock[]
    codecID: string
    /** The track's CodecPrivate, or null for a track without one */
    codecPrivate: Uint8Array | null
    defaultDurationMilliseconds: number
    pixelHeight: number
    pixelWidth: number
}>;

export const MATROSKA_MILLISECOND_TIMESTAMP_SCALE = 1_000_000;

const FLOAT_ELEMENT_BYTE_LENGTH = 8;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
// Matroska element IDs
const EBML_ID = 0x1A45_DFA3;
const EBML_VERSION_ID = 0x4286;
const EBML_READ_VERSION_ID = 0x42F7;
const DOC_TYPE_ID = 0x4282;
const DOC_TYPE_VERSION_ID = 0x4287;
const DOC_TYPE_READ_VERSION_ID = 0x4285;
const SEGMENT_ID = 0x1853_8067;
const INFO_ID = 0x1549_A966;
const TIMESTAMP_SCALE_ID = 0x2A_D7B1;
const TRACKS_ID = 0x1654_AE6B;
const TRACK_ENTRY_ID = 0xAE;
const TRACK_NUMBER_ID = 0xD7;
const TRACK_UID_ID = 0x73C5;
const TRACK_TYPE_ID = 0x83;
const CODEC_ID = 0x86;
const CODEC_PRIVATE_ID = 0x63A2;
const DEFAULT_DURATION_ID = 0x23_E383;
const VIDEO_ID = 0xE0;
const PIXEL_WIDTH_ID = 0xB0;
const PIXEL_HEIGHT_ID = 0xBA;
const CLUSTER_ID = 0x1F43_B675;
const CLUSTER_TIMESTAMP_ID = 0xE7;
const SIMPLE_BLOCK_ID = 0xA3;
const MATROSKA_DOC_TYPE = 'matroska';
const MATROSKA_DOC_TYPE_VERSION = 4;
const MATROSKA_DOC_TYPE_READ_VERSION = 2;
const VIDEO_TRACK_TYPE = 1;
const MATROSKA_TRACK_NUMBER = 1;
const MATROSKA_TRACK_UID = 1;
const KEY_FRAME_FLAG = 0x80;
// A SimpleBlock's track number is a one-byte variable-length integer
const TRACK_NUMBER_MARKER = 0x80;
const BYTE_MASK = 0xFF;
const BITS_PER_BYTE = 8;

/** Encodes an element ID with its length marker bits, as written in the Matroska specification. */
export function encodeElementID(id: number): Uint8Array {
    let byteLength = 1;
    while (id >= 256 ** byteLength) {
        byteLength += 1;
    }
    const output = new Uint8Array(byteLength);
    let remainingValue = id;
    for (let byteIndex = byteLength - 1; byteIndex >= 0; byteIndex -= 1) {
        output[byteIndex] = remainingValue % 256;
        remainingValue = Math.floor(remainingValue / 256);
    }
    return output;
}

/** Encodes a known element size in the shortest variable-length integer. */
export function encodeElementSize(byteLength: number): Uint8Array {
    for (let encodedByteLength = 1; encodedByteLength <= 8; encodedByteLength += 1) {
        const maximumValue = (2 ** (7 * encodedByteLength)) - 2;
        if (byteLength > maximumValue) {
            continue;
        }
        let encodedValue = byteLength + (2 ** (7 * encodedByteLength));
        const output = new Uint8Array(encodedByteLength);
        for (let byteIndex = encodedByteLength - 1; byteIndex >= 0; byteIndex -= 1) {
            output[byteIndex] = encodedValue % 256;
            encodedValue = Math.floor(encodedValue / 256);
        }
        return output;
    }
    throw new RangeError('The synthetic EBML element is too large');
}

export function createElement(id: number, payload: Uint8Array): Uint8Array {
    return concatenate([
        encodeElementID(id),
        encodeElementSize(payload.byteLength),
        payload
    ]);
}

export function createUnsignedIntegerElement(id: number, value: number): Uint8Array {
    const bytes: number[] = [];
    let remainingValue = value;
    do {
        bytes.unshift(remainingValue % 256);
        remainingValue = Math.floor(remainingValue / 256);
    } while (remainingValue > 0);
    return createElement(id, new Uint8Array(bytes));
}

export function createFloatElement(id: number, value: number): Uint8Array {
    const payload = new Uint8Array(FLOAT_ELEMENT_BYTE_LENGTH);
    new DataView(payload.buffer).setFloat64(0, value);
    return createElement(id, payload);
}

export function createASCIIElement(id: number, value: string): Uint8Array {
    return createElement(
        id,
        new Uint8Array(Array.from(value, (character: string): number => character.charCodeAt(0)))
    );
}

function createSimpleBlock(block: SyntheticMatroskaBlock): Uint8Array {
    return createElement(SIMPLE_BLOCK_ID, concatenate([
        new Uint8Array([ TRACK_NUMBER_MARKER | MATROSKA_TRACK_NUMBER ]),
        new Uint8Array([
            (block.timestampMilliseconds >> BITS_PER_BYTE) & BYTE_MASK,
            block.timestampMilliseconds & BYTE_MASK,
            block.keyframe ? KEY_FRAME_FLAG : 0
        ]),
        block.data
    ]));
}

/** Returns a Matroska file of one video track, its blocks in one cluster at millisecond timestamps. */
export function createVideoTrackMatroska(track: SyntheticMatroskaVideoTrack): Uint8Array {
    return concatenate([
        createElement(EBML_ID, concatenate([
            createUnsignedIntegerElement(EBML_VERSION_ID, 1),
            createUnsignedIntegerElement(EBML_READ_VERSION_ID, 1),
            createASCIIElement(DOC_TYPE_ID, MATROSKA_DOC_TYPE),
            createUnsignedIntegerElement(DOC_TYPE_VERSION_ID, MATROSKA_DOC_TYPE_VERSION),
            createUnsignedIntegerElement(DOC_TYPE_READ_VERSION_ID, MATROSKA_DOC_TYPE_READ_VERSION)
        ])),
        createElement(SEGMENT_ID, concatenate([
            createElement(INFO_ID, createUnsignedIntegerElement(TIMESTAMP_SCALE_ID, MATROSKA_MILLISECOND_TIMESTAMP_SCALE)),
            createElement(TRACKS_ID, createElement(TRACK_ENTRY_ID, concatenate([
                createUnsignedIntegerElement(TRACK_NUMBER_ID, MATROSKA_TRACK_NUMBER),
                createUnsignedIntegerElement(TRACK_UID_ID, MATROSKA_TRACK_UID),
                createUnsignedIntegerElement(TRACK_TYPE_ID, VIDEO_TRACK_TYPE),
                createASCIIElement(CODEC_ID, track.codecID),
                ...(track.codecPrivate ? [ createElement(CODEC_PRIVATE_ID, track.codecPrivate) ] : []),
                createUnsignedIntegerElement(DEFAULT_DURATION_ID, track.defaultDurationMilliseconds * NANOSECONDS_PER_MILLISECOND),
                createElement(VIDEO_ID, concatenate([
                    createUnsignedIntegerElement(PIXEL_WIDTH_ID, track.pixelWidth),
                    createUnsignedIntegerElement(PIXEL_HEIGHT_ID, track.pixelHeight)
                ]))
            ]))),
            createElement(CLUSTER_ID, concatenate([
                createUnsignedIntegerElement(CLUSTER_TIMESTAMP_ID, 0),
                ...track.blocks.map(createSimpleBlock)
            ]))
        ]))
    ]);
}
