// @vitest-environment node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import { parseGPUDecoderManifest } from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';
import type { GPUDecodeStreamFacts } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';
import {
    encodeGPUDecoderVectorSet,
    GPU_DECODER_VECTOR_SET_MAGIC,
    GPU_DECODER_VECTOR_SET_VERSION,
    GPUDecoderVectorSetError,
    parseGPUDecoderVectorSet,
    type GPUDecoderVector,
    type GPUDecoderVectorPacket
} from 'webgpu-player/decode/video/gpu/GPUDecoderVectorSet';
import { createGPUDecodeStreamFacts } from 'webgpu-player/decode/video/gpu/GPUFramePool';

import {
    loadDecoderPackageFormatTool,
    readDecoderProjectSourceFiles,
    readDecoderProjectVectors,
    type DecoderPackageFormatTool
} from '../../../helpers/decoderPackages';
import { DECODERS_DIRECTORY } from '../../../helpers/enginePaths';

// A decoder project's descriptor, whose vectors name the formats its vectors file holds
const DECODER_PROJECT_FILE_NAME = 'decoder.json';
const VECTORS_FILE_EXTENSION = '.vectors';
// The bytes 'WPDV' as a little-endian word
const SET_MAGIC_BYTES = [ 0x57, 0x50, 0x44, 0x56 ];
const WORD_BYTE_LENGTH = 4;
const EIGHT_BIT_FORMAT: GPUDecoderOutputFormat = 'I420';
const TEN_BIT_FORMAT: GPUDecoderOutputFormat = 'I420P10';
const TWELVE_BIT_FORMAT: GPUDecoderOutputFormat = 'I422P12';
const TEN_BIT_DEPTH = 10;
const TWELVE_BIT_DEPTH = 12;
// A track size of whole samples but not whole 64-sample blocks
const VECTOR_WIDTH = 100;
const VECTOR_HEIGHT = 50;
// The pool's coded size: the track size padded to whole 64-sample blocks
const VECTOR_CODED_WIDTH = 128;
const VECTOR_CODED_HEIGHT = 64;
// A cropped stream that differs from what the set stores: an offset visible rectangle in a larger coded frame
const CROPPED_STREAM: GPUDecodeStreamFacts = {
    bitDepth: TWELVE_BIT_DEPTH,
    codedHeight: 256,
    codedWidth: 256,
    visibleRectangle: { height: VECTOR_HEIGHT, width: VECTOR_WIDTH, x: 8, y: 4 }
};
const FIRST_FRAME = 1;
const LAST_FRAME = 2;
const VECTOR_HASH = '0123456789abcdef'.repeat(4);
// Uppercase hexadecimal, which is no SHA-256 the set stores
const UPPERCASE_VECTOR_HASH = VECTOR_HASH.toUpperCase();
// Five bytes, so the codec private data pads to two words
const CODEC_PRIVATE_BYTES = [ 0x01, 0x64, 0x00, 0x1F, 0xFF ];
// Packet lengths that pad by 1, 0, and 3 bytes
const PACKET_BYTE_LENGTHS = [ 7, 8, 1 ];
const FRAME_DURATION_MICROSECONDS = 41_708;
// The latest timestamp a set word holds
const LATEST_TIMESTAMP_MICROSECONDS = 0xFFFF_FFFF;
const PACKET_BYTE_STRIDE = 17;
const BYTE_MASK = 0xFF;

// Byte offsets in a set of one I420 vector without codec private data: the header words, then the vector's length, format, size, frames, hash, and packets
const MAGIC_BYTE_OFFSET = 0;
const VERSION_BYTE_OFFSET = 4;
const VECTOR_COUNT_BYTE_OFFSET = 8;
const VECTOR_LENGTH_BYTE_OFFSET = 12;
const VECTOR_START_BYTE_OFFSET = 16;
const FORMAT_NAME_BYTE_OFFSET = 20;
const WIDTH_BYTE_OFFSET = 24;
const HEIGHT_BYTE_OFFSET = 28;
const LAST_FRAME_BYTE_OFFSET = 36;
const PACKET_COUNT_BYTE_OFFSET = 76;
const FIRST_PACKET_LENGTH_BYTE_OFFSET = 80;
// The last packet's entry: its four words, then its one byte padded to a word
const LAST_PACKET_ENTRY_BYTE_LENGTH = 20;
const FIRST_PACKET_DATA_BYTE_OFFSET = 96;
const SET_HEADER_BYTE_LENGTH = 12;
// A WebAssembly module's magic, '\0asm', as a little-endian word, which a set copied from the wrong place would start with
const FOREIGN_MAGIC = 0x6D73_6100;
const FOREIGN_MAGIC_TEXT = '0x6d736100';
const UNKNOWN_FORMAT_NAME = 'NV12';
// A vector length that ends inside its fields, after the format name
const SHORT_VECTOR_BYTE_LENGTH = 8;
const OVERSIZED_PACKET_BYTE_LENGTH = 1000;
const TRUNCATED_HEADER_BYTE_LENGTH = 6;
const TRAILING_BYTE_LENGTH = 4;
const LITTLE_ENDIAN = true;
// Packet times no set word holds: past the latest, below zero, and between whole microseconds
const PAST_LATEST_TIMESTAMP_MICROSECONDS = LATEST_TIMESTAMP_MICROSECONDS + 1;
const NEGATIVE_DURATION_MICROSECONDS = -1;
const FRACTIONAL_TIMESTAMP_MICROSECONDS = 0.5;

/** The vectors entries of a decoder project's descriptor, which name the format of each vector its vectors file holds. */
type DecoderProjectDescriptor = Readonly<{
    decoder: string
    vectors?: ReadonlyArray<Readonly<{ format: GPUDecoderOutputFormat }>>
}>;

/** A vector's contents with its byte buffers as arrays, which compare by value. */
type VectorContents = {
    codecPrivate: number[] | null
    firstFrame: number
    format: GPUDecoderOutputFormat
    lastFrame: number
    packets: Array<{ data: number[], durationMicroseconds: number, keyframe: boolean, timestampMicroseconds: number }>
    sha256: string
    stream: GPUDecodeStreamFacts
};

function createPacketData(packetIndex: number, byteLength: number): ArrayBuffer {
    const bytes = new Uint8Array(byteLength);
    for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
        bytes[byteIndex] = (packetIndex * PACKET_BYTE_STRIDE + byteIndex + 1) & BYTE_MASK;
    }
    return bytes.buffer;
}

/** Returns packets of the given lengths in decode order, the first a keyframe and the last at the latest timestamp a word holds. */
function createPackets(byteLengths: readonly number[]): GPUDecoderVectorPacket[] {
    return byteLengths.map((byteLength: number, packetIndex: number): GPUDecoderVectorPacket => ({
        data: createPacketData(packetIndex, byteLength),
        durationMicroseconds: FRAME_DURATION_MICROSECONDS,
        keyframe: packetIndex === 0,
        timestampMicroseconds: packetIndex === byteLengths.length - 1 ? LATEST_TIMESTAMP_MICROSECONDS : packetIndex * FRAME_DURATION_MICROSECONDS
    }));
}

function createVector(
    format: GPUDecoderOutputFormat,
    codecPrivate: Uint8Array | null,
    packets: readonly GPUDecoderVectorPacket[] = createPackets(PACKET_BYTE_LENGTHS)
): GPUDecoderVector {
    return {
        codecPrivate,
        firstFrame: FIRST_FRAME,
        format,
        lastFrame: LAST_FRAME,
        packets,
        sha256: VECTOR_HASH,
        stream: createGPUDecodeStreamFacts(VECTOR_WIDTH, VECTOR_HEIGHT, format)
    };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return Uint8Array.from(bytes).buffer;
}

function encodeSet(vectors: readonly GPUDecoderVector[]): ArrayBuffer {
    return toArrayBuffer(encodeGPUDecoderVectorSet(vectors));
}

/** Returns a set of one I420 vector without codec private data, whose bytes the malformed cases edit. */
function createEditableSet(): DataView<ArrayBuffer> {
    return new DataView(encodeSet([ createVector(EIGHT_BIT_FORMAT, null) ]));
}

function setWord(set: DataView<ArrayBuffer>, byteOffset: number, value: number): ArrayBuffer {
    set.setUint32(byteOffset, value, LITTLE_ENDIAN);
    return set.buffer;
}

function getVectorEnd(set: DataView): number {
    return VECTOR_START_BYTE_OFFSET + set.getUint32(VECTOR_LENGTH_BYTE_OFFSET, LITTLE_ENDIAN);
}

function describeVector(vector: GPUDecoderVector | undefined): VectorContents {
    if (!vector) {
        throw new Error('The set holds no such vector');
    }
    return {
        codecPrivate: vector.codecPrivate ? [ ...vector.codecPrivate ] : null,
        firstFrame: vector.firstFrame,
        format: vector.format,
        lastFrame: vector.lastFrame,
        packets: vector.packets.map(packet => ({
            data: [ ...new Uint8Array(packet.data) ],
            durationMicroseconds: packet.durationMicroseconds,
            keyframe: packet.keyframe,
            timestampMicroseconds: packet.timestampMicroseconds
        })),
        sha256: vector.sha256,
        stream: vector.stream
    };
}

/** Returns what a call throws as a vector set error, failing on any other outcome. */
function getSetError(call: () => unknown): GPUDecoderVectorSetError {
    try {
        call();
    } catch (error) {
        if (error instanceof GPUDecoderVectorSetError) {
            return error;
        }
        throw error;
    }
    throw new Error('The call did not fail');
}

/** Returns the decoder projects whose descriptors declare vectors, with those declarations. */
function getVectorProjects(): Array<[ string, DecoderProjectDescriptor ]> {
    const projects: Array<[ string, DecoderProjectDescriptor ]> = [];
    for (const project of readdirSync(DECODERS_DIRECTORY)) {
        const descriptorPath = join(DECODERS_DIRECTORY, project, DECODER_PROJECT_FILE_NAME);
        if (!existsSync(descriptorPath)) {
            continue;
        }
        const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as DecoderProjectDescriptor;
        if ((descriptor.vectors?.length ?? 0) > 0) {
            projects.push([ project, descriptor ]);
        }
    }
    return projects;
}

/** Returns the default vector with its first packet changed. */
function createVectorWithFirstPacket(changes: Partial<GPUDecoderVectorPacket>): GPUDecoderVector {
    const [ firstPacket, ...laterPackets ] = createPackets(PACKET_BYTE_LENGTHS);
    return createVector(EIGHT_BIT_FORMAT, null, [ { ...firstPacket, ...changes }, ...laterPackets ]);
}

/** A vector the encoder refuses: a description, the vector, and the error's message. */
type UnencodableVectorCase = readonly [string, GPUDecoderVector, string];

const UNENCODABLE_VECTOR_CASES: readonly UnencodableVectorCase[] = [
    [
        'a timestamp past the latest a word holds',
        createVectorWithFirstPacket({ timestampMicroseconds: PAST_LATEST_TIMESTAMP_MICROSECONDS }),
        `${PAST_LATEST_TIMESTAMP_MICROSECONDS} is no set word`
    ],
    [
        'a negative duration',
        createVectorWithFirstPacket({ durationMicroseconds: NEGATIVE_DURATION_MICROSECONDS }),
        `${NEGATIVE_DURATION_MICROSECONDS} is no set word`
    ],
    [
        'a timestamp between whole microseconds',
        createVectorWithFirstPacket({ timestampMicroseconds: FRACTIONAL_TIMESTAMP_MICROSECONDS }),
        `${FRACTIONAL_TIMESTAMP_MICROSECONDS} is no set word`
    ],
    [
        'a hash in uppercase hexadecimal',
        { ...createVector(EIGHT_BIT_FORMAT, null), sha256: UPPERCASE_VECTOR_HASH },
        `'${UPPERCASE_VECTOR_HASH}' is no SHA-256`
    ]
];

/** A set the parser refuses: a description, the set, and the error's message. */
type MalformedSetCase = readonly [string, () => ArrayBuffer, () => string];

const MALFORMED_SET_CASES: readonly MalformedSetCase[] = [
    [ 'an empty set', (): ArrayBuffer => new ArrayBuffer(0), (): string => 'magic at 0 runs past 0' ],
    [
        'a set that ends inside its header',
        (): ArrayBuffer => createEditableSet().buffer.slice(0, TRUNCATED_HEADER_BYTE_LENGTH),
        (): string => `version at ${VERSION_BYTE_OFFSET} runs past ${TRUNCATED_HEADER_BYTE_LENGTH}`
    ],
    [
        'another magic',
        (): ArrayBuffer => setWord(createEditableSet(), MAGIC_BYTE_OFFSET, FOREIGN_MAGIC),
        (): string => `magic ${FOREIGN_MAGIC_TEXT}`
    ],
    [
        'a layout version the engine does not read',
        (): ArrayBuffer => setWord(createEditableSet(), VERSION_BYTE_OFFSET, GPU_DECODER_VECTOR_SET_VERSION + 1),
        (): string => `version ${GPU_DECODER_VECTOR_SET_VERSION + 1}, expected ${GPU_DECODER_VECTOR_SET_VERSION}`
    ],
    [
        'a vector that runs past the set',
        (): ArrayBuffer => createEditableSet().buffer.slice(0, -WORD_BYTE_LENGTH),
        (): string => `vector 0 of ${createEditableSet().getUint32(VECTOR_LENGTH_BYTE_OFFSET, LITTLE_ENDIAN)} bytes runs past the set`
    ],
    [
        'a vector length that ends inside the vector\'s fields',
        (): ArrayBuffer => setWord(createEditableSet(), VECTOR_LENGTH_BYTE_OFFSET, SHORT_VECTOR_BYTE_LENGTH),
        (): string => `vector 0 width at ${WIDTH_BYTE_OFFSET} runs past ${VECTOR_START_BYTE_OFFSET + SHORT_VECTOR_BYTE_LENGTH}`
    ],
    [
        'a packet whose data runs past its vector',
        (): ArrayBuffer => setWord(createEditableSet(), FIRST_PACKET_LENGTH_BYTE_OFFSET, OVERSIZED_PACKET_BYTE_LENGTH),
        (): string => `vector 0 packet 0 data of ${OVERSIZED_PACKET_BYTE_LENGTH} bytes at ${FIRST_PACKET_DATA_BYTE_OFFSET} runs past ${getVectorEnd(createEditableSet())}`
    ],
    [
        'a vector count beyond the vectors',
        (): ArrayBuffer => setWord(createEditableSet(), VECTOR_COUNT_BYTE_OFFSET, 2),
        (): string => `vector 1 length at ${createEditableSet().byteLength} runs past ${createEditableSet().byteLength}`
    ],
    [
        'a packet count short of the vector\'s packets',
        (): ArrayBuffer => setWord(createEditableSet(), PACKET_COUNT_BYTE_OFFSET, PACKET_BYTE_LENGTHS.length - 1),
        (): string => `vector 0 has ${LAST_PACKET_ENTRY_BYTE_LENGTH} unread bytes`
    ],
    [
        'bytes inside a vector\'s length after its last packet',
        (): ArrayBuffer => {
            const set = createEditableSet();
            const grownSet = new DataView(new ArrayBuffer(set.byteLength + TRAILING_BYTE_LENGTH));
            new Uint8Array(grownSet.buffer).set(new Uint8Array(set.buffer));
            return setWord(grownSet, VECTOR_LENGTH_BYTE_OFFSET, set.getUint32(VECTOR_LENGTH_BYTE_OFFSET, LITTLE_ENDIAN) + TRAILING_BYTE_LENGTH);
        },
        (): string => `vector 0 has ${TRAILING_BYTE_LENGTH} unread bytes`
    ],
    [
        'bytes after the last vector',
        (): ArrayBuffer => {
            const set = new Uint8Array(createEditableSet().byteLength + TRAILING_BYTE_LENGTH);
            set.set(new Uint8Array(createEditableSet().buffer));
            return set.buffer;
        },
        (): string => `${TRAILING_BYTE_LENGTH} trailing bytes`
    ],
    [
        'a vector count short of the vectors',
        (): ArrayBuffer => setWord(createEditableSet(), VECTOR_COUNT_BYTE_OFFSET, 0),
        (): string => `${createEditableSet().byteLength - SET_HEADER_BYTE_LENGTH} trailing bytes`
    ],
    [
        'two vectors of one format',
        (): ArrayBuffer => encodeSet([ createVector(EIGHT_BIT_FORMAT, null), createVector(EIGHT_BIT_FORMAT, null) ]),
        (): string => `vector 1 repeats format ${EIGHT_BIT_FORMAT}`
    ],
    [
        'a format no GPU decoder writes',
        (): ArrayBuffer => {
            const set = createEditableSet();
            new Uint8Array(set.buffer).set(new TextEncoder().encode(UNKNOWN_FORMAT_NAME), FORMAT_NAME_BYTE_OFFSET);
            return set.buffer;
        },
        (): string => `vector 0 format '${UNKNOWN_FORMAT_NAME}'`
    ],
    [
        'a track without width',
        (): ArrayBuffer => setWord(createEditableSet(), WIDTH_BYTE_OFFSET, 0),
        (): string => `vector 0 size 0x${VECTOR_HEIGHT}`
    ],
    [
        'a track without height',
        (): ArrayBuffer => setWord(createEditableSet(), HEIGHT_BYTE_OFFSET, 0),
        (): string => `vector 0 size ${VECTOR_WIDTH}x0`
    ],
    [
        'checked frames that run backwards',
        (): ArrayBuffer => setWord(createEditableSet(), LAST_FRAME_BYTE_OFFSET, FIRST_FRAME - 1),
        (): string => `vector 0 frames ${FIRST_FRAME} to ${FIRST_FRAME - 1}`
    ],
    [
        'an empty packet',
        (): ArrayBuffer => encodeSet([ createVector(EIGHT_BIT_FORMAT, null, [ ...createPackets([ 1 ]), ...createPackets([ 0 ]) ]) ]),
        (): string => 'vector 0 packet 1 is empty'
    ]
];

describe('parseGPUDecoderVectorSet', () => {
    it('reads back what encodeGPUDecoderVectorSet writes, each vector by its format in set order', () => {
        const vectors = [
            createVector(EIGHT_BIT_FORMAT, Uint8Array.from(CODEC_PRIVATE_BYTES)),
            createVector(TWELVE_BIT_FORMAT, null)
        ];

        const parsedVectors = parseGPUDecoderVectorSet(encodeSet(vectors));

        expect([ ...parsedVectors.keys() ]).toEqual([ EIGHT_BIT_FORMAT, TWELVE_BIT_FORMAT ]);
        for (const vector of vectors) {
            expect(describeVector(parsedVectors.get(vector.format))).toEqual(describeVector(vector));
        }
    });

    it('gives each packet a buffer of its own bytes, without the padding the set stores', () => {
        const vectors = parseGPUDecoderVectorSet(encodeSet([ createVector(EIGHT_BIT_FORMAT, Uint8Array.from(CODEC_PRIVATE_BYTES)) ]));

        const vector = vectors.get(EIGHT_BIT_FORMAT);
        expect(vector?.packets.map(packet => packet.data.byteLength)).toEqual(PACKET_BYTE_LENGTHS);
        expect(vector?.codecPrivate?.byteLength).toBe(CODEC_PRIVATE_BYTES.length);
    });

    it('starts with the magic and version the package tools write', () => {
        const set = new Uint8Array(encodeSet([]));

        expect([ ...set.subarray(MAGIC_BYTE_OFFSET, VERSION_BYTE_OFFSET) ]).toEqual(SET_MAGIC_BYTES);
        expect(new DataView(set.buffer).getUint32(MAGIC_BYTE_OFFSET, LITTLE_ENDIAN)).toBe(GPU_DECODER_VECTOR_SET_MAGIC);
        expect(parseGPUDecoderVectorSet(set.buffer).size).toBe(0);
    });

    it('derives each vector\'s stream facts from its track size and format, as playback sizes the pool', () => {
        const vectors = parseGPUDecoderVectorSet(encodeSet([ createVector(TEN_BIT_FORMAT, null) ]));

        expect(vectors.get(TEN_BIT_FORMAT)?.stream).toEqual({
            bitDepth: TEN_BIT_DEPTH,
            codedHeight: VECTOR_CODED_HEIGHT,
            codedWidth: VECTOR_CODED_WIDTH,
            visibleRectangle: { height: VECTOR_HEIGHT, width: VECTOR_WIDTH, x: 0, y: 0 }
        });
    });

    it('stores only the visible size, so stream facts other than the derived ones do not survive', () => {
        const vector: GPUDecoderVector = { ...createVector(TEN_BIT_FORMAT, null), stream: CROPPED_STREAM };

        const vectors = parseGPUDecoderVectorSet(encodeSet([ vector ]));

        expect(vectors.get(TEN_BIT_FORMAT)?.stream).toEqual(createGPUDecodeStreamFacts(VECTOR_WIDTH, VECTOR_HEIGHT, TEN_BIT_FORMAT));
    });

    it.each(MALFORMED_SET_CASES)('refuses %s, naming where', (_description: string, createSet: () => ArrayBuffer, createMessage: () => string) => {
        const error = getSetError(() => parseGPUDecoderVectorSet(createSet()));

        expect(error.message).toBe(createMessage());
        expect(error.name).toBe('GPUDecoderVectorSetError');
    });
});

describe('encodeGPUDecoderVectorSet', () => {
    it.each(UNENCODABLE_VECTOR_CASES)('refuses %s', (_description: string, vector: GPUDecoderVector, message: string) => {
        expect(getSetError(() => encodeGPUDecoderVectorSet([ vector ])).message).toBe(message);
    });
});

describe('the decoder projects\' committed vectors', () => {
    it.each(getVectorProjects())('parses %s into the vectors its descriptor names, each a format its decoder writes with a packet for every frame it checks', async (
        project: string,
        descriptor: DecoderProjectDescriptor
    ) => {
        const tool: DecoderPackageFormatTool = await loadDecoderPackageFormatTool();
        const outputFormats = parseGPUDecoderManifest(tool.joinDecoderSources(readDecoderProjectSourceFiles(project))).outputFormats;

        const vectors = parseGPUDecoderVectorSet(readDecoderProjectVectors(project));

        expect([ ...vectors.keys() ]).toEqual((descriptor.vectors ?? []).map(vector => vector.format));
        for (const vector of vectors.values()) {
            expect(outputFormats).toContain(vector.format);
            expect(vector.packets.length).toBeGreaterThan(vector.lastFrame);
        }
        expect(existsSync(join(DECODERS_DIRECTORY, project, `${project}${VECTORS_FILE_EXTENSION}`))).toBe(true);
    });
});
