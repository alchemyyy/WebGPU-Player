import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BYTES_PER_WORD } from 'webgpu-player/presentation/WebGPUConstants';
import { getGPUDecoderFormatFacts, GPU_DECODER_OUTPUT_PLANE_COUNT, type GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import { GPU_DECODER_PARSER_ABI_VERSION } from 'webgpu-player/decode/video/gpu/GPUDecodeLimits';
import type { GPUDecoderParserOutput, GPUDecoderParserPicture } from 'webgpu-player/decode/video/gpu/GPUDecoderParser';
import { parseGPUDecoderManifest } from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';
import {
    createGPUDecoderModule,
    GPU_DECODER_BINDINGS,
    GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH,
    GPU_DECODER_STREAM_UNIFORM_BYTE_LENGTH
} from 'webgpu-player/decode/video/gpu/GPUDecoderPrelude';
import { checkGPUDecoderVector } from 'webgpu-player/decode/video/gpu/GPUDecoderVectorCheck';
import type { GPUDecoderVector, GPUDecoderVectorPacket } from 'webgpu-player/decode/video/gpu/GPUDecoderVectorSet';
import { GPU_DECODER_OUTPUT_EVENT, type GPUDecoderManifest, type GPUDecodeStreamFacts } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';
import { getGPUFramePoolSlotCount } from 'webgpu-player/decode/video/gpu/GPUFramePool';

import { getBoundBuffer, MockGPUDevice, type MockDispatch } from './mockGPUDevice';
import { installWebGPUGlobals } from './webGPUGlobals';

const OUTPUT_FORMAT: GPUDecoderOutputFormat = 'I420';
const TEN_BIT_OUTPUT_FORMAT: GPUDecoderOutputFormat = 'I420P10';
const CODEC_FAMILY = 'uncompressed';
const CODED_WIDTH = 64;
const CODED_HEIGHT = 36;
const EIGHT_BIT_DEPTH = 8;
const TEN_BIT_DEPTH = 10;
const STREAM: GPUDecodeStreamFacts = {
    bitDepth: EIGHT_BIT_DEPTH,
    codedHeight: CODED_HEIGHT,
    codedWidth: CODED_WIDTH,
    visibleRectangle: { height: CODED_HEIGHT, width: CODED_WIDTH, x: 0, y: 0 }
};
const TEN_BIT_STREAM: GPUDecodeStreamFacts = { ...STREAM, bitDepth: TEN_BIT_DEPTH };
// A visible rectangle inside the coded frame, at chroma-aligned offsets, whose planes the hash reads
const CROPPED_VISIBLE_RECTANGLE = { height: 30, width: 58, x: 4, y: 2 };
// A packet holds one packed 10-bit frame of the coded size
const PACKET_SIZE = '8 KiB';
const FRAME_DURATION_MICROSECONDS = 40_000;
const ENTRY_POINT = 'copyPlanes';
const PACKET_COUNT = 4;
const FIRST_FRAME = 0;
const LAST_FRAME = 2;
const CHECKED_FRAME_INDICES = [ 0, 1, 2 ];
// Checked frames that start after the first frame, so the check skips frame 0
const LATER_FIRST_FRAME = 1;
// Decode order 0, 2, 1, 3 by timestamp, as a stream with one B-frame
const REORDERED_TIMESTAMP_INDICES = [ 0, 2, 1, 3 ];
const REORDER_DEPTH = 1;
// A frame that arrives after a later one, which a decoder without reordering cannot present
const OUT_OF_ORDER_TIMESTAMP_INDICES = [ 0, 2, 1 ];
const MISSING_LAST_FRAME = 4;
const REFERENCES = 1;
const DECODER_ERROR_CODE = 9;
const BROWSER_ERROR_NAME = 'OperationError';
const BROWSER_ERROR_MESSAGE = 'The operation failed';
const COMPILE_ERROR_MESSAGE = "unresolved identifier 'sampel'";
const COMPILE_ERROR_COLUMN = 3;
// A hash of other planes than the vector's
const WRONG_HASH = 'ab'.repeat(32);
// Bytes per frame count up from each frame's own start, so frames differ
const FRAME_BYTE_STRIDE = 7;
const BYTE_INDEX_STRIDE = 13;
const BYTE_MASK = 0xFF;

// A parser's view of six container packets: the first holds no picture, as parameter sets alone, and the fourth only drops an earlier picture;
// its records are frames 0 to 3, which the session decodes as pictures 0 to 3, and picture 1 is dropped, so frames 0, 2, and 3 present
const PARSER_PACKET_COUNT = 6;
const PARSER_REORDER = 2;
const PARSER_PRESENTED_FRAME_INDICES = [ 0, 2, 3 ];
// Bytes of a compressed container packet, which no session sees once its parser turned it into a record
const COMPRESSED_PACKET_BYTE_LENGTH = 16;
// The frames that present when the stream's last packet, without a picture, drops picture 1
const TRAILING_DISCARD_PRESENTED_FRAME_INDICES = [ 0, 2 ];
// Temporal units of several pictures: a hidden picture, then its packet's shown one, so pictures 1, 2, and 4 present
const MULTIPLE_PICTURE_PRESENTED_FRAME_INDICES = [ 1, 2, 4 ];
const MULTIPLE_PICTURE_RECORD_COUNT = 5;
// A picture smaller than the stream, at odd sizes whose chroma rounds up, as an AV1 frame size change makes one
const PICTURE_VISIBLE_SIZE = { height: 19, width: 33 };

// Word offsets of the per-packet and stream uniforms, in GPUDecodePacket and GPUDecodeStream order
const PACKET_BYTE_OFFSET_WORD = 0;
const PACKET_BYTE_LENGTH_WORD = 1;
const PACKET_INDEX_WORD = 2;
const PACKET_RESET_WORD = 4;
const PACKET_OUTPUT_SLOT_WORD = 5;
const PLANE_WORD_COUNT = 4;
const STREAM_BYTES_PER_SAMPLE_WORD = 15;
const STREAM_SLOT_BYTE_LENGTH_WORD = 17;
const STATUS_ERROR_CODE_BYTE_OFFSET = 0;

type DecoderOptions = {
    output?: string
    parser?: boolean
    references?: number
    reorder?: number
};

/** What a vector checks: its format, the frames, and their hash, the default frames' unless set. */
type VectorOptions = {
    firstFrame?: number
    format?: GPUDecoderOutputFormat
    lastFrame?: number
    sha256?: string
    stream?: GPUDecodeStreamFacts
};

/** A packet as the session received it: its byte length and whether it reset the decoder. */
type ReceivedPacket = {
    byteLength: number
    reset: number
};

/** Returns a decoder header like the uncompressed proof decoder's, with a small packet ring. */
function createDecoderSource(options: DecoderOptions): string {
    const header = [
        '//! id: vector-test',
        '//! name: Vector test',
        '//! decoder: video',
        `//! accepts: codec in [${CODEC_FAMILY}]`,
        `//! output: ${options.output ?? OUTPUT_FORMAT}`,
        ...(options.parser ? [ `//! parser: ${GPU_DECODER_PARSER_ABI_VERSION}` ] : []),
        `//! references: ${options.references ?? 0}`,
        `//! reorder: ${options.reorder ?? 0}`,
        `//! packet: ${PACKET_SIZE}`,
        `//! dispatch: ${ENTRY_POINT}, 1`
    ];
    return `${header.join('\n')}\n\n@compute @workgroup_size(1)\nfn ${ENTRY_POINT}() {\n}\n`;
}

function getFrameByteLength(format: GPUDecoderOutputFormat): number {
    const formatFacts = getGPUDecoderFormatFacts(format);
    const chromaSampleCount = Math.ceil(CODED_WIDTH / formatFacts.chromaWidthDivisor) * Math.ceil(CODED_HEIGHT / formatFacts.chromaHeightDivisor);
    return (CODED_WIDTH * CODED_HEIGHT + 2 * chromaSampleCount) * formatFacts.bytesPerSample;
}

/** Returns the packed planes of one frame, which the uncompressed decoder takes as its packet. */
function createFrameBytes(frameIndex: number, format: GPUDecoderOutputFormat = OUTPUT_FORMAT): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(getFrameByteLength(format));
    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
        bytes[byteIndex] = (frameIndex * FRAME_BYTE_STRIDE + byteIndex * BYTE_INDEX_STRIDE) & BYTE_MASK;
    }
    return bytes;
}

/** Returns packets of frames in decode order, each frame's timestamp at its index in timestampIndices. */
function createPackets(timestampIndices: readonly number[], format: GPUDecoderOutputFormat = OUTPUT_FORMAT): GPUDecoderVectorPacket[] {
    return timestampIndices.map((timestampIndex: number, decodeIndex: number): GPUDecoderVectorPacket => ({
        data: createFrameBytes(decodeIndex, format).buffer,
        durationMicroseconds: FRAME_DURATION_MICROSECONDS,
        keyframe: decodeIndex === 0,
        timestampMicroseconds: timestampIndex * FRAME_DURATION_MICROSECONDS
    }));
}

function createSequentialPackets(packetCount: number, format: GPUDecoderOutputFormat = OUTPUT_FORMAT): GPUDecoderVectorPacket[] {
    return createPackets(Array.from({ length: packetCount }, (_value: unknown, index: number) => index), format);
}

/** Returns container packets whose bytes are no frame, as compressed packets a parser parses. */
function createCompressedPackets(packetCount: number): GPUDecoderVectorPacket[] {
    return Array.from({ length: packetCount }, (_value: unknown, packetIndex: number): GPUDecoderVectorPacket => ({
        data: new Uint8Array(COMPRESSED_PACKET_BYTE_LENGTH).fill(packetIndex).buffer,
        durationMicroseconds: FRAME_DURATION_MICROSECONDS,
        keyframe: packetIndex === 0,
        timestampMicroseconds: packetIndex * FRAME_DURATION_MICROSECONDS
    }));
}

/** Returns the SHA-256 of frames, by an implementation independent of the engine's. */
function hashFrames(frameIndices: readonly number[], format: GPUDecoderOutputFormat = OUTPUT_FORMAT): string {
    const hash = createHash('sha256');
    for (const frameIndex of frameIndices) {
        hash.update(createFrameBytes(frameIndex, format));
    }
    return hash.digest('hex');
}

/** Returns one 4:2:0 8-bit frame's packed planes cropped to a visible rectangle, rows tightly packed, by an implementation independent of the engine's. */
function cropFrameBytes(frameBytes: Uint8Array, rectangle: typeof CROPPED_VISIBLE_RECTANGLE): Uint8Array {
    const formatFacts = getGPUDecoderFormatFacts(OUTPUT_FORMAT);
    const chromaWidth = Math.ceil(CODED_WIDTH / formatFacts.chromaWidthDivisor);
    const chromaHeight = Math.ceil(CODED_HEIGHT / formatFacts.chromaHeightDivisor);
    const lumaByteLength = CODED_WIDTH * CODED_HEIGHT;
    const planes = [
        { byteOffset: 0, heightDivisor: 1, width: CODED_WIDTH, widthDivisor: 1 },
        { byteOffset: lumaByteLength, heightDivisor: formatFacts.chromaHeightDivisor, width: chromaWidth, widthDivisor: formatFacts.chromaWidthDivisor },
        {
            byteOffset: lumaByteLength + chromaWidth * chromaHeight,
            heightDivisor: formatFacts.chromaHeightDivisor,
            width: chromaWidth,
            widthDivisor: formatFacts.chromaWidthDivisor
        }
    ];
    const croppedBytes: number[] = [];
    for (const plane of planes) {
        const left = rectangle.x / plane.widthDivisor;
        const top = rectangle.y / plane.heightDivisor;
        const width = Math.ceil(rectangle.width / plane.widthDivisor);
        const height = Math.ceil(rectangle.height / plane.heightDivisor);
        for (let row = 0; row < height; row += 1) {
            const rowStart = plane.byteOffset + (top + row) * plane.width + left;
            croppedBytes.push(...frameBytes.subarray(rowStart, rowStart + width));
        }
    }
    return Uint8Array.from(croppedBytes);
}

function hashCroppedFrames(frameIndices: readonly number[], rectangle: typeof CROPPED_VISIBLE_RECTANGLE): string {
    const hash = createHash('sha256');
    for (const frameIndex of frameIndices) {
        hash.update(cropFrameBytes(createFrameBytes(frameIndex), rectangle));
    }
    return hash.digest('hex');
}

function createManifest(options: DecoderOptions = {}): GPUDecoderManifest {
    return parseGPUDecoderManifest(createDecoderSource(options));
}

function createVector(packets: readonly GPUDecoderVectorPacket[], options: VectorOptions = {}): GPUDecoderVector {
    return {
        codecPrivate: null,
        firstFrame: options.firstFrame ?? FIRST_FRAME,
        format: options.format ?? OUTPUT_FORMAT,
        lastFrame: options.lastFrame ?? LAST_FRAME,
        packets,
        sha256: options.sha256 ?? hashFrames(CHECKED_FRAME_INDICES),
        stream: options.stream ?? STREAM
    };
}

/** Returns one picture a parser made: its record, the output events it decided, and the visible size it reported, if any. */
function createParserPicture(
    record: Uint8Array<ArrayBuffer>,
    events: readonly number[],
    visibleSize: GPUDecoderParserPicture['visibleSize'] = null
): GPUDecoderParserPicture {
    return { events: Uint32Array.from(events), format: null, maximumPictureSize: null, record: record.buffer, repeatCounts: [], visibleSize };
}

/** Returns a parser's output for one packet: one picture's record with the output events it decided, or no picture, whose events trail. */
function createParserOutput(record: Uint8Array<ArrayBuffer> | null, events: readonly number[]): GPUDecoderParserOutput {
    if (!record) {
        return { pictures: [], trailingEvents: Uint32Array.from(events) };
    }
    return { pictures: [ createParserPicture(record, events) ], trailingEvents: new Uint32Array(0) };
}

/** Returns the output event that drops a picture instead of presenting it. */
function createDiscardEvent(pictureIndex: number): number {
    return (GPU_DECODER_OUTPUT_EVENT.discardBit | pictureIndex) >>> 0;
}

/** Plays the uncompressed decoder: copies the packet's packed planes into the output slot through the stream uniform's plane layout. */
function playUncompressedDecoder(device: MockGPUDevice): void {
    device.dispatchHandler = (dispatch: MockDispatch): void => {
        const packetWords = getBoundBuffer(dispatch, GPU_DECODER_BINDINGS.packet)
            .readWords(dispatch.dynamicOffsets[0], GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH / BYTES_PER_WORD);
        const streamWords = getBoundBuffer(dispatch, GPU_DECODER_BINDINGS.stream).readWords(0, GPU_DECODER_STREAM_UNIFORM_BYTE_LENGTH / BYTES_PER_WORD);
        const ring = getBoundBuffer(dispatch, GPU_DECODER_BINDINGS.packetBytes);
        const pool = getBoundBuffer(dispatch, GPU_DECODER_BINDINGS.framePool);
        const slotByteOffset = packetWords[PACKET_OUTPUT_SLOT_WORD] * streamWords[STREAM_SLOT_BYTE_LENGTH_WORD];
        const bytesPerSample = streamWords[STREAM_BYTES_PER_SAMPLE_WORD];
        let readOffset = packetWords[PACKET_BYTE_OFFSET_WORD];
        for (let planeIndex = 0; planeIndex < GPU_DECODER_OUTPUT_PLANE_COUNT; planeIndex += 1) {
            const [ planeByteOffset, bytesPerRow, width, height ] = streamWords.slice(planeIndex * PLANE_WORD_COUNT, (planeIndex + 1) * PLANE_WORD_COUNT);
            const rowByteLength = width * bytesPerSample;
            for (let row = 0; row < height; row += 1) {
                pool.data.set(ring.data.subarray(readOffset, readOffset + rowByteLength), slotByteOffset + planeByteOffset + row * bytesPerRow);
                readOffset += rowByteLength;
            }
        }
    };
}

/** Records each packet the session received, ahead of the decoder the device plays. */
function recordReceivedPackets(device: MockGPUDevice): ReceivedPacket[] {
    const receivedPackets: ReceivedPacket[] = [];
    const decoderHandler = device.dispatchHandler;
    device.dispatchHandler = (dispatch: MockDispatch, mockDevice: MockGPUDevice): void => {
        const packetWords = getBoundBuffer(dispatch, GPU_DECODER_BINDINGS.packet)
            .readWords(dispatch.dynamicOffsets[0], GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH / BYTES_PER_WORD);
        receivedPackets.push({ byteLength: packetWords[PACKET_BYTE_LENGTH_WORD], reset: packetWords[PACKET_RESET_WORD] });
        decoderHandler(dispatch, mockDevice);
    };
    return receivedPackets;
}

function createBrowserError(): Error {
    const error = new Error(BROWSER_ERROR_MESSAGE);
    error.name = BROWSER_ERROR_NAME;
    return error;
}

describe('checkGPUDecoderVector', () => {
    let restoreGlobals: () => void = (): void => undefined;

    beforeEach(() => {
        restoreGlobals = installWebGPUGlobals();
    });

    afterEach(() => {
        restoreGlobals();
    });

    it('passes when the checked frames hash to the declared value, and destroys everything it allocated', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);
        const receivedPackets = recordReceivedPackets(device);
        const expectedHash = hashFrames(CHECKED_FRAME_INDICES);

        const result = await checkGPUDecoderVector(device.asDevice(), createManifest(), createVector(createSequentialPackets(PACKET_COUNT)), null);

        expect(result).toEqual({ code: 'passed', detail: expectedHash });
        expect(device.buffers.every(buffer => buffer.destroyed)).toBe(true);
        // Only the first packet resets the decoder
        expect(receivedPackets[0].reset).toBe(1);
        expect(receivedPackets.slice(1).every(packet => packet.reset === 0)).toBe(true);
    });

    it('hashes the checked frames cropped to the stream\'s visible rectangle, as FFmpeg writes rawvideo', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);
        const expectedHash = hashCroppedFrames(CHECKED_FRAME_INDICES, CROPPED_VISIBLE_RECTANGLE);
        const vector = createVector(createSequentialPackets(PACKET_COUNT), {
            sha256: expectedHash,
            stream: { ...STREAM, visibleRectangle: CROPPED_VISIBLE_RECTANGLE }
        });

        const result = await checkGPUDecoderVector(device.asDevice(), createManifest(), vector, null);

        expect(expectedHash).not.toBe(hashFrames(CHECKED_FRAME_INDICES));
        expect(result).toEqual({ code: 'passed', detail: expectedHash });
    });

    it('checks the frames from the first checked frame on, in presentation order', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);
        // Presentation order is decode order 0, 2, 1, 3, so presented frames 1 and 2 are decoded frames 2 and 1
        const expectedHash = hashFrames([ 2, 1 ]);
        const vector = createVector(createPackets(REORDERED_TIMESTAMP_INDICES), { firstFrame: LATER_FIRST_FRAME, lastFrame: LAST_FRAME, sha256: expectedHash });

        const result = await checkGPUDecoderVector(device.asDevice(), createManifest({ reorder: REORDER_DEPTH }), vector, null);

        expect(result).toEqual({ code: 'passed', detail: expectedHash });
    });

    it('decodes the vector in the output format it checks', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);
        const expectedHash = hashFrames(CHECKED_FRAME_INDICES, TEN_BIT_OUTPUT_FORMAT);
        const manifest = createManifest({ output: `${OUTPUT_FORMAT}, ${TEN_BIT_OUTPUT_FORMAT}` });
        const vector = createVector(createSequentialPackets(PACKET_COUNT, TEN_BIT_OUTPUT_FORMAT), {
            format: TEN_BIT_OUTPUT_FORMAT,
            sha256: expectedHash,
            stream: TEN_BIT_STREAM
        });

        const result = await checkGPUDecoderVector(device.asDevice(), manifest, vector, null);

        expect(result).toEqual({ code: 'passed', detail: expectedHash });
    });

    it('reports a hash mismatch with the decoded and the declared hash', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);

        const result = await checkGPUDecoderVector(
            device.asDevice(),
            createManifest(),
            createVector(createSequentialPackets(PACKET_COUNT), { sha256: WRONG_HASH }),
            null
        );

        expect(result).toEqual({ code: 'hash-mismatch', detail: `${hashFrames(CHECKED_FRAME_INDICES)} != ${WRONG_HASH}` });
    });

    it('decodes a parser\'s records with their output events, carrying the events of a packet without a picture to the next picture\'s packet', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);
        const receivedPackets = recordReceivedPackets(device);
        const expectedHash = hashFrames(PARSER_PRESENTED_FRAME_INDICES);
        const manifest = createManifest({ parser: true, reorder: PARSER_REORDER });
        const parserOutputs = [
            createParserOutput(null, []),
            createParserOutput(createFrameBytes(0), []),
            createParserOutput(createFrameBytes(1), []),
            // Drops picture 1, which must reach the session with picture 2's packet
            createParserOutput(null, [ createDiscardEvent(1) ]),
            createParserOutput(createFrameBytes(2), [ 0 ]),
            createParserOutput(createFrameBytes(3), [ 2, 3 ])
        ];
        const vector = createVector(createCompressedPackets(PARSER_PACKET_COUNT), { sha256: expectedHash });

        const result = await checkGPUDecoderVector(device.asDevice(), manifest, vector, parserOutputs);

        expect(result).toEqual({ code: 'passed', detail: expectedHash });
        // Four records reached the session, the first of them resetting the decoder though the first container packet held no picture
        expect(receivedPackets).toEqual(Array.from({ length: PARSER_PRESENTED_FRAME_INDICES.length + 1 }, (_value: unknown, packetIndex: number): ReceivedPacket => ({
            byteLength: getFrameByteLength(OUTPUT_FORMAT),
            reset: packetIndex === 0 ? 1 : 0
        })));
    });

    it('decodes every picture of a packet in decode order with its packet\'s timing, dropping the hidden ones their events name', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);
        const receivedPackets = recordReceivedPackets(device);
        const expectedHash = hashFrames(MULTIPLE_PICTURE_PRESENTED_FRAME_INDICES);
        const manifest = createManifest({ parser: true });
        // Each temporal unit's pictures, as an AV1 parser makes them: hidden pictures drop by their own events, and the shown one presents
        const parserOutputs: GPUDecoderParserOutput[] = [
            { pictures: [ createParserPicture(createFrameBytes(0), [ createDiscardEvent(0) ]), createParserPicture(createFrameBytes(1), [ 1 ]) ], trailingEvents: new Uint32Array(0) },
            { pictures: [ createParserPicture(createFrameBytes(2), [ 2 ]) ], trailingEvents: new Uint32Array(0) },
            { pictures: [ createParserPicture(createFrameBytes(3), [ createDiscardEvent(3) ]), createParserPicture(createFrameBytes(4), [ 4 ]) ], trailingEvents: new Uint32Array(0) }
        ];
        const vector = createVector(createCompressedPackets(parserOutputs.length), {
            lastFrame: MULTIPLE_PICTURE_PRESENTED_FRAME_INDICES.length - 1,
            sha256: expectedHash
        });

        const result = await checkGPUDecoderVector(device.asDevice(), manifest, vector, parserOutputs);

        expect(result).toEqual({ code: 'passed', detail: expectedHash });
        // Every picture reached the session as a packet of its own, and only the first reset the decoder
        expect(receivedPackets.map(packet => packet.reset)).toEqual([ 1, ...Array.from({ length: MULTIPLE_PICTURE_RECORD_COUNT - 1 }, () => 0) ]);
    });

    it('hashes a picture that reports its own visible size at that size, and the others at the stream\'s visible rectangle', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);
        const pictureRectangle = { ...PICTURE_VISIBLE_SIZE, x: 0, y: 0 };
        const hash = createHash('sha256');
        hash.update(cropFrameBytes(createFrameBytes(0), pictureRectangle));
        hash.update(createFrameBytes(1));
        hash.update(cropFrameBytes(createFrameBytes(2), pictureRectangle));
        const expectedHash = hash.digest('hex');
        const parserOutputs: GPUDecoderParserOutput[] = [
            { pictures: [ createParserPicture(createFrameBytes(0), [ 0 ], PICTURE_VISIBLE_SIZE) ], trailingEvents: new Uint32Array(0) },
            createParserOutput(createFrameBytes(1), [ 1 ]),
            { pictures: [ createParserPicture(createFrameBytes(2), [ 2 ], PICTURE_VISIBLE_SIZE) ], trailingEvents: new Uint32Array(0) }
        ];
        const vector = createVector(createCompressedPackets(parserOutputs.length), { sha256: expectedHash });

        const result = await checkGPUDecoderVector(device.asDevice(), createManifest({ parser: true }), vector, parserOutputs);

        expect(result).toEqual({ code: 'passed', detail: expectedHash });
    });

    it('reports the frames a parser leaves undecided past presentation order as dropped', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);
        const manifest = createManifest({ parser: true, reorder: PARSER_REORDER });
        // As above, but the parser never decides picture 1, which the end of the stream releases behind later frames
        const parserOutputs = [
            createParserOutput(null, []),
            createParserOutput(createFrameBytes(0), []),
            createParserOutput(createFrameBytes(1), []),
            createParserOutput(null, []),
            createParserOutput(createFrameBytes(2), [ 0 ]),
            createParserOutput(createFrameBytes(3), [ 2, 3 ])
        ];
        const vector = createVector(createCompressedPackets(PARSER_PACKET_COUNT), { sha256: hashFrames(PARSER_PRESENTED_FRAME_INDICES) });

        const result = await checkGPUDecoderVector(device.asDevice(), manifest, vector, parserOutputs);

        expect(result).toEqual({ code: 'frames-dropped', detail: '1' });
    });

    it('hands the events of the last packets, which have no picture, to the end of the stream, so a trailing discard drops its frame', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);
        const receivedPackets = recordReceivedPackets(device);
        const expectedHash = hashFrames(TRAILING_DISCARD_PRESENTED_FRAME_INDICES);
        const manifest = createManifest({ parser: true, reorder: PARSER_REORDER });
        // Pictures 0 and 2 present with picture 2's packet; only the last packet, without a picture, decides picture 1, which would otherwise leave behind them
        const parserOutputs = [
            createParserOutput(createFrameBytes(0), []),
            createParserOutput(createFrameBytes(1), []),
            createParserOutput(createFrameBytes(2), [ 0, 2 ]),
            createParserOutput(null, [ createDiscardEvent(1) ])
        ];
        const vector = createVector(createCompressedPackets(parserOutputs.length), {
            lastFrame: TRAILING_DISCARD_PRESENTED_FRAME_INDICES.length - 1,
            sha256: expectedHash
        });

        const result = await checkGPUDecoderVector(device.asDevice(), manifest, vector, parserOutputs);

        expect(result).toEqual({ code: 'passed', detail: expectedHash });
        expect(receivedPackets).toHaveLength(parserOutputs.length - 1);
    });

    it('reports fewer frames than the vector checks', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);
        const packetCount = 3;

        const result = await checkGPUDecoderVector(
            device.asDevice(),
            createManifest(),
            createVector(createSequentialPackets(packetCount), { lastFrame: MISSING_LAST_FRAME }),
            null
        );

        expect(result).toEqual({ code: 'frames-missing', detail: `${packetCount} < ${MISSING_LAST_FRAME + 1}` });
    });

    it('reports frames dropped by reordering deeper than the decoder declares', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);

        const result = await checkGPUDecoderVector(device.asDevice(), createManifest(), createVector(createPackets(OUT_OF_ORDER_TIMESTAMP_INDICES)), null);

        expect(result).toEqual({ code: 'frames-dropped', detail: '1' });
    });

    it('reports an error the decoder reports for the last checked packet, after its frame came out', async () => {
        const device = new MockGPUDevice();
        device.dispatchHandler = (dispatch: MockDispatch): void => {
            const packetWords = getBoundBuffer(dispatch, GPU_DECODER_BINDINGS.packet)
                .readWords(dispatch.dynamicOffsets[0], GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH / BYTES_PER_WORD);
            if (packetWords[PACKET_INDEX_WORD] === LAST_FRAME) {
                getBoundBuffer(dispatch, GPU_DECODER_BINDINGS.status).writeWords(STATUS_ERROR_CODE_BYTE_OFFSET, [ DECODER_ERROR_CODE ]);
            }
        };

        const result = await checkGPUDecoderVector(device.asDevice(), createManifest(), createVector(createSequentialPackets(PACKET_COUNT)), null);

        expect(result).toEqual({ code: 'decoder-error', detail: String(DECODER_ERROR_CODE) });
    });

    it('reports a decoder that does not compile with the session failure', async () => {
        const device = new MockGPUDevice();
        const manifest = createManifest();
        const firstBodyLine = createGPUDecoderModule(manifest, OUTPUT_FORMAT).firstBodyLine;
        device.compilationMessages = [ { lineNum: firstBodyLine, linePos: COMPILE_ERROR_COLUMN, message: COMPILE_ERROR_MESSAGE, type: 'error' } ];

        const result = await checkGPUDecoderVector(device.asDevice(), manifest, createVector(createSequentialPackets(PACKET_COUNT)), null);

        expect(result).toEqual({ code: 'compile-error', detail: `line ${manifest.bodyFirstLine}:${COMPILE_ERROR_COLUMN} ${COMPILE_ERROR_MESSAGE}` });
    });

    it('reports exhausted slots when a decoder never frees its references', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);
        const slotCount = getGPUFramePoolSlotCount(REFERENCES, 0);
        const packetCount = slotCount + 2;
        const manifest = createManifest({ references: REFERENCES });

        const result = await checkGPUDecoderVector(
            device.asDevice(),
            manifest,
            createVector(createSequentialPackets(packetCount), { lastFrame: packetCount - 1 }),
            null
        );

        expect(result).toEqual({ code: 'slots-exhausted', detail: `${packetCount - slotCount} packets, 0 free slots` });
    });

    it('reports a readback the device cannot map with the browser error', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);
        device.mapFailure = createBrowserError();

        const result = await checkGPUDecoderVector(device.asDevice(), createManifest(), createVector(createSequentialPackets(PACKET_COUNT)), null);

        expect(result).toEqual({ code: 'readback-failed', detail: `${BROWSER_ERROR_NAME}: ${BROWSER_ERROR_MESSAGE}` });
    });
});
