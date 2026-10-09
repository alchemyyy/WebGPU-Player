// @vitest-environment node

import {
    ALL_FORMATS,
    BufferSource,
    EncodedPacketSink,
    Input,
    type InputFormat
} from 'mediabunny';
import { describe, expect, it } from 'vitest';

import { CUSTOM_DECODE_INPUT_FORMATS } from 'webgpu-player/pipeline/CustomDecodeInputFormats';

import { concatenate } from '../helpers/byteArrays';
import {
    createASCIIElement,
    createElement,
    createFloatElement,
    createUnsignedIntegerElement
} from '../helpers/matroskaElements';

// Element IDs from the Matroska specification
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
const TRACK_TYPE_ID = 0x83;
const CODEC_ID = 0x86;
const AUDIO_ID = 0xE1;
const SAMPLING_FREQUENCY_ID = 0xB5;
const CHANNELS_ID = 0x9F;
const CONTENT_ENCODINGS_ID = 0x6D80;
const CONTENT_ENCODING_ID = 0x6240;
const CONTENT_ENCODING_ORDER_ID = 0x5031;
const CONTENT_ENCODING_SCOPE_ID = 0x5032;
const CONTENT_ENCODING_TYPE_ID = 0x5033;
const CONTENT_COMPRESSION_ID = 0x5034;
const CONTENT_COMPRESSION_ALGORITHM_ID = 0x4254;
const CONTENT_COMPRESSION_SETTINGS_ID = 0x4255;
const CLUSTER_ID = 0x1F43_B675;
const CLUSTER_TIMESTAMP_ID = 0xE7;
const SIMPLE_BLOCK_ID = 0xA3;

const MATROSKA_DOC_TYPE = 'matroska';
const MATROSKA_DOC_TYPE_VERSION = 4;
const MATROSKA_DOC_TYPE_READ_VERSION = 2;
const MILLISECOND_TIMESTAMP_SCALE = 1_000_000;
const AUDIO_TRACK_TYPE = 2;
const MATROSKA_AC3_CODEC_ID = 'A_AC3';
const AC3_SAMPLE_RATE = 48_000;
const AC3_CHANNEL_COUNT = 2;
// One ContentEncoding of type compression with header stripping, scoped to the frames
const BLOCK_CONTENT_ENCODING_SCOPE = 1;
const COMPRESSION_CONTENT_ENCODING_TYPE = 0;
const HEADER_STRIPPING_ALGORITHM = 3;
// The bytes older mkvmerge releases removed from every AC-3 frame
const AC3_SYNC_WORD = Object.freeze([ 0x0B, 0x77 ]);

const STRIPPED_TRACK_NUMBER = 1;
const UNENCODED_TRACK_NUMBER = 2;
const KEY_FRAME_FLAG = 0x80;
const LACING_FLAG_SHIFT = 1;
const XIPH_LACING = 1;
const FIXED_SIZE_LACING = 2;
const EBML_LACING = 3;
const XIPH_LACE_SIZE_CONTINUATION = 255;
const MAXIMUM_VARIABLE_LENGTH_INTEGER_BYTE_LENGTH = 8;
// Block timestamps in milliseconds; each lace holds three 32 ms frames
const XIPH_BLOCK_TIMESTAMP = 0;
const FIXED_SIZE_BLOCK_TIMESTAMP = 96;
const EBML_BLOCK_TIMESTAMP = 192;
const UNLACED_BLOCK_TIMESTAMP = 288;
// The Xiph sizes cross a 255-byte continuation, and the EBML sizes need both a negative and a positive difference
const XIPH_FRAME_BYTE_LENGTHS = Object.freeze([ 300, 5, 260 ]);
const FIXED_FRAME_BYTE_LENGTH = 64;
const FIXED_FRAME_COUNT = 3;
const EBML_FRAME_BYTE_LENGTHS = Object.freeze([ 300, 5, 260 ]);
const UNLACED_FRAME_BYTE_LENGTH = 128;

type SyntheticBlock = {
    frames: readonly Uint8Array[]
    lacing: number | null
    timestamp: number
    trackNumber: number
};

function createFrame(byteLength: number, seed: number): Uint8Array {
    const frame = new Uint8Array(byteLength);
    for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
        frame[byteIndex] = (seed + (byteIndex * 7)) & 0xFF;
    }
    return frame;
}

/** Encodes a variable-length integer in exactly the given byte length, as EBML lace sizes are stored. */
function encodeVariableLengthInteger(value: number, byteLength: number): Uint8Array {
    const output = new Uint8Array(byteLength);
    let remainingValue = value + (2 ** (7 * byteLength));
    for (let byteIndex = byteLength - 1; byteIndex >= 0; byteIndex -= 1) {
        output[byteIndex] = remainingValue % 256;
        remainingValue = Math.floor(remainingValue / 256);
    }
    return output;
}

/** Encodes an EBML lace size difference in the shortest signed variable-length integer. */
function encodeSignedLaceSizeDifference(difference: number): Uint8Array {
    for (let byteLength = 1; byteLength <= MAXIMUM_VARIABLE_LENGTH_INTEGER_BYTE_LENGTH; byteLength += 1) {
        const bias = (2 ** ((7 * byteLength) - 1)) - 1;
        if (Math.abs(difference) <= bias) {
            return encodeVariableLengthInteger(difference + bias, byteLength);
        }
    }
    throw new RangeError('The synthetic lace size difference is too large');
}

function encodeUnsignedLaceSize(byteLength: number): Uint8Array {
    for (let encodedByteLength = 1; encodedByteLength <= MAXIMUM_VARIABLE_LENGTH_INTEGER_BYTE_LENGTH; encodedByteLength += 1) {
        if (byteLength <= (2 ** (7 * encodedByteLength)) - 2) {
            return encodeVariableLengthInteger(byteLength, encodedByteLength);
        }
    }
    throw new RangeError('The synthetic lace size is too large');
}

function createLaceHeader(lacing: number, frames: readonly Uint8Array[]): Uint8Array {
    const parts: Uint8Array[] = [];
    parts.push(new Uint8Array([ frames.length - 1 ]));
    switch (lacing) {
        case XIPH_LACING:
            for (const frame of frames.slice(0, -1)) {
                const sizeBytes: number[] = [];
                let remainingByteLength = frame.byteLength;
                while (remainingByteLength >= XIPH_LACE_SIZE_CONTINUATION) {
                    sizeBytes.push(XIPH_LACE_SIZE_CONTINUATION);
                    remainingByteLength -= XIPH_LACE_SIZE_CONTINUATION;
                }
                sizeBytes.push(remainingByteLength);
                parts.push(new Uint8Array(sizeBytes));
            }
            break;
        case EBML_LACING:
            parts.push(encodeUnsignedLaceSize(frames[0].byteLength));
            for (let frameIndex = 1; frameIndex < frames.length - 1; frameIndex += 1) {
                parts.push(encodeSignedLaceSizeDifference(frames[frameIndex].byteLength - frames[frameIndex - 1].byteLength));
            }
            break;
        default:
            break;
    }
    return concatenate(parts);
}

function createSimpleBlock(block: SyntheticBlock): Uint8Array {
    const lacing = block.lacing;
    const flags = KEY_FRAME_FLAG | (lacing === null ? 0 : lacing << LACING_FLAG_SHIFT);
    return createElement(SIMPLE_BLOCK_ID, concatenate([
        // Track numbers below 127 take one length-marked byte
        new Uint8Array([ 0x80 | block.trackNumber ]),
        new Uint8Array([ (block.timestamp >> 8) & 0xFF, block.timestamp & 0xFF, flags ]),
        lacing === null ? new Uint8Array(0) : createLaceHeader(lacing, block.frames),
        ...block.frames
    ]));
}

function createAudioTrack(trackNumber: number, strippedHeader: readonly number[] | null): Uint8Array {
    const contentEncodings = strippedHeader === null ?
        [] :
        [
            createElement(CONTENT_ENCODINGS_ID, createElement(CONTENT_ENCODING_ID, concatenate([
                createUnsignedIntegerElement(CONTENT_ENCODING_ORDER_ID, 0),
                createUnsignedIntegerElement(CONTENT_ENCODING_SCOPE_ID, BLOCK_CONTENT_ENCODING_SCOPE),
                createUnsignedIntegerElement(CONTENT_ENCODING_TYPE_ID, COMPRESSION_CONTENT_ENCODING_TYPE),
                createElement(CONTENT_COMPRESSION_ID, concatenate([
                    createUnsignedIntegerElement(CONTENT_COMPRESSION_ALGORITHM_ID, HEADER_STRIPPING_ALGORITHM),
                    createElement(CONTENT_COMPRESSION_SETTINGS_ID, new Uint8Array(strippedHeader))
                ]))
            ])))
        ];
    return createElement(TRACK_ENTRY_ID, concatenate([
        createUnsignedIntegerElement(TRACK_NUMBER_ID, trackNumber),
        createUnsignedIntegerElement(TRACK_TYPE_ID, AUDIO_TRACK_TYPE),
        createASCIIElement(CODEC_ID, MATROSKA_AC3_CODEC_ID),
        createElement(AUDIO_ID, concatenate([
            createFloatElement(SAMPLING_FREQUENCY_ID, AC3_SAMPLE_RATE),
            createUnsignedIntegerElement(CHANNELS_ID, AC3_CHANNEL_COUNT)
        ])),
        ...contentEncodings
    ]));
}

function createMatroska(tracks: readonly Uint8Array[], blocks: readonly SyntheticBlock[]): Uint8Array {
    return concatenate([
        createElement(EBML_ID, concatenate([
            createUnsignedIntegerElement(EBML_VERSION_ID, 1),
            createUnsignedIntegerElement(EBML_READ_VERSION_ID, 1),
            createASCIIElement(DOC_TYPE_ID, MATROSKA_DOC_TYPE),
            createUnsignedIntegerElement(DOC_TYPE_VERSION_ID, MATROSKA_DOC_TYPE_VERSION),
            createUnsignedIntegerElement(DOC_TYPE_READ_VERSION_ID, MATROSKA_DOC_TYPE_READ_VERSION)
        ])),
        createElement(SEGMENT_ID, concatenate([
            createElement(INFO_ID, createUnsignedIntegerElement(TIMESTAMP_SCALE_ID, MILLISECOND_TIMESTAMP_SCALE)),
            createElement(TRACKS_ID, concatenate(tracks)),
            createElement(CLUSTER_ID, concatenate([
                createUnsignedIntegerElement(CLUSTER_TIMESTAMP_ID, 0),
                ...blocks.map(createSimpleBlock)
            ]))
        ]))
    ]);
}

function prependStrippedHeader(frame: Uint8Array): Uint8Array {
    return concatenate([ new Uint8Array(AC3_SYNC_WORD), frame ]);
}

/** Reads every packet of the file's only audio track. */
async function readPacketData(formats: InputFormat[], matroska: Uint8Array): Promise<Uint8Array[]> {
    const input = new Input({ formats, source: new BufferSource(matroska) });
    try {
        const tracks = await input.getAudioTracks();
        expect(tracks).toHaveLength(1);
        const packetData: Uint8Array[] = [];
        for await (const packet of new EncodedPacketSink(tracks[0]).packets()) {
            packetData.push(packet.data);
        }
        return packetData;
    } finally {
        await input.dispose();
    }
}

const XIPH_FRAMES = XIPH_FRAME_BYTE_LENGTHS.map((byteLength: number, frameIndex: number): Uint8Array => createFrame(byteLength, frameIndex));
const FIXED_FRAMES = Array.from({ length: FIXED_FRAME_COUNT }, (_: unknown, frameIndex: number): Uint8Array => createFrame(FIXED_FRAME_BYTE_LENGTH, 16 + frameIndex));
const EBML_FRAMES = EBML_FRAME_BYTE_LENGTHS.map((byteLength: number, frameIndex: number): Uint8Array => createFrame(byteLength, 32 + frameIndex));
const UNLACED_FRAME = createFrame(UNLACED_FRAME_BYTE_LENGTH, 48);

describe('CUSTOM_DECODE_INPUT_FORMATS', () => {
    it('restores the stripped header of every frame in a laced Matroska block', async () => {
        const matroska = createMatroska([ createAudioTrack(STRIPPED_TRACK_NUMBER, AC3_SYNC_WORD) ], [
            { frames: XIPH_FRAMES, lacing: XIPH_LACING, timestamp: XIPH_BLOCK_TIMESTAMP, trackNumber: STRIPPED_TRACK_NUMBER },
            { frames: FIXED_FRAMES, lacing: FIXED_SIZE_LACING, timestamp: FIXED_SIZE_BLOCK_TIMESTAMP, trackNumber: STRIPPED_TRACK_NUMBER },
            { frames: EBML_FRAMES, lacing: EBML_LACING, timestamp: EBML_BLOCK_TIMESTAMP, trackNumber: STRIPPED_TRACK_NUMBER },
            { frames: [ UNLACED_FRAME ], lacing: null, timestamp: UNLACED_BLOCK_TIMESTAMP, trackNumber: STRIPPED_TRACK_NUMBER }
        ]);

        const packetData = await readPacketData(CUSTOM_DECODE_INPUT_FORMATS, matroska);

        expect(packetData).toEqual([ ...XIPH_FRAMES, ...FIXED_FRAMES, ...EBML_FRAMES, UNLACED_FRAME ].map(prependStrippedHeader));
    });

    it('leaves laced frames without content encoding as stored', async () => {
        const matroska = createMatroska([ createAudioTrack(UNENCODED_TRACK_NUMBER, null) ], [
            { frames: FIXED_FRAMES, lacing: FIXED_SIZE_LACING, timestamp: FIXED_SIZE_BLOCK_TIMESTAMP, trackNumber: UNENCODED_TRACK_NUMBER },
            { frames: EBML_FRAMES, lacing: EBML_LACING, timestamp: EBML_BLOCK_TIMESTAMP, trackNumber: UNENCODED_TRACK_NUMBER }
        ]);

        const packetData = await readPacketData(CUSTOM_DECODE_INPUT_FORMATS, matroska);

        expect(packetData).toEqual([ ...FIXED_FRAMES, ...EBML_FRAMES ]);
    });

    it('replaces only the Matroska format', () => {
        expect(CUSTOM_DECODE_INPUT_FORMATS).toHaveLength(ALL_FORMATS.length);
        const replacedFormats = CUSTOM_DECODE_INPUT_FORMATS.filter((format: InputFormat): boolean => !ALL_FORMATS.includes(format));
        expect(replacedFormats.map((format: InputFormat): string => format.name)).toEqual([ 'Matroska' ]);
    });

    // When this fails, Mediabunny decodes laced frames correctly and the replacement format can be removed
    it('corrects a Mediabunny 1.52.2 defect that the stock formats still have', async () => {
        const matroska = createMatroska([ createAudioTrack(STRIPPED_TRACK_NUMBER, AC3_SYNC_WORD) ], [
            { frames: FIXED_FRAMES, lacing: FIXED_SIZE_LACING, timestamp: FIXED_SIZE_BLOCK_TIMESTAMP, trackNumber: STRIPPED_TRACK_NUMBER }
        ]);

        const packetData = await readPacketData(ALL_FORMATS, matroska);

        expect(packetData).not.toEqual(FIXED_FRAMES.map(prependStrippedHeader));
    });
});
