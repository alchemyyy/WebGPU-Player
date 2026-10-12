import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getGPUDecoderFormatFacts, GPU_DECODER_OUTPUT_PLANE_COUNT } from 'webgpu-player/video/gpu-decode/GPUDecodeFormats';
import { parseGPUDecoderManifest } from 'webgpu-player/video/gpu-decode/GPUDecoderManifest';
import {
    createGPUDecoderModule,
    GPU_DECODER_BINDINGS,
    GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH,
    GPU_DECODER_STREAM_UNIFORM_BYTE_LENGTH
} from 'webgpu-player/video/gpu-decode/GPUDecoderPrelude';
import {
    checkGPUDecoderVector,
    GPUDecoderVectorCheckCache,
    type GPUDecoderVectorInput,
    hashGPUDecoderSource
} from 'webgpu-player/video/gpu-decode/GPUDecoderVectorCheck';
import type { GPUDecodePacket, GPUDecoderManifest, GPUDecodeStreamFacts } from 'webgpu-player/video/gpu-decode/GPUDecodeTypes';
import { getGPUFramePoolSlotCount } from 'webgpu-player/video/gpu-decode/GPUFramePool';
import { BYTES_PER_WORD } from 'webgpu-player/presentation/WebGPUConstants';

import { getBoundBuffer, MockGPUDevice, type MockDispatch } from './mockGPUDevice';
import { installWebGPUGlobals } from './webGPUGlobals';

const OUTPUT_FORMAT = 'I420';
const CODED_WIDTH = 64;
const CODED_HEIGHT = 36;
const EIGHT_BIT_DEPTH = 8;
const STREAM: GPUDecodeStreamFacts = {
    bitDepth: EIGHT_BIT_DEPTH,
    codedHeight: CODED_HEIGHT,
    codedWidth: CODED_WIDTH,
    visibleRectangle: { height: CODED_HEIGHT, width: CODED_WIDTH, x: 0, y: 0 }
};
// A visible rectangle inside the coded frame, at chroma-aligned offsets, whose planes the hash reads
const CROPPED_VISIBLE_RECTANGLE = { height: 30, width: 58, x: 4, y: 2 };
const FRAME_DURATION_MICROSECONDS = 40_000;
const ENTRY_POINT = 'copyPlanes';
const VECTOR_FILE = 'vector.mkv';
const PACKET_COUNT = 4;
const FIRST_FRAME = 0;
const LAST_FRAME = 2;
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
const REFUSED_BUFFER_LABEL = 'status readback';
const COMPILE_ERROR_MESSAGE = "unresolved identifier 'sampel'";
const COMPILE_ERROR_COLUMN = 3;
// A hash of other planes than the vector's
const WRONG_HASH = 'ab'.repeat(32);
// Bytes per frame count up from each frame's own start, so frames differ
const FRAME_BYTE_STRIDE = 7;
const BYTE_INDEX_STRIDE = 13;
const BYTE_MASK = 0xFF;

// Word offsets of the per-packet and stream uniforms, in GPUDecodePacket and GPUDecodeStream order
const PACKET_BYTE_OFFSET_WORD = 0;
const PACKET_INDEX_WORD = 2;
const PACKET_OUTPUT_SLOT_WORD = 5;
const PLANE_WORD_COUNT = 4;
const STREAM_BYTES_PER_SAMPLE_WORD = 15;
const STREAM_SLOT_BYTE_LENGTH_WORD = 17;
const STATUS_ERROR_CODE_BYTE_OFFSET = 0;

type VectorDecoderOptions = {
    firstFrame?: number
    lastFrame?: number
    references?: number
    reorder?: number
    sha256?: string | null
};

/** Returns a decoder header like the uncompressed proof decoder's, with a small packet ring and an optional vector. */
function createDecoderSource(options: VectorDecoderOptions, sha256: string | null): string {
    const header = [
        '//! name: Vector test',
        '//! decoder: video',
        '//! accepts: codec in [V_UNCOMPRESSED]',
        `//! output: ${OUTPUT_FORMAT}`,
        `//! references: ${options.references ?? 0}`,
        `//! reorder: ${options.reorder ?? 0}`,
        '//! packet: 4 KiB',
        `//! dispatch: ${ENTRY_POINT}, 1`
    ];
    if (sha256 !== null) {
        header.push(`//! vector: ${VECTOR_FILE}, frames ${options.firstFrame ?? FIRST_FRAME}-${options.lastFrame ?? LAST_FRAME}, sha256 ${sha256}`);
    }
    return `${header.join('\n')}\n\n@compute @workgroup_size(1)\nfn ${ENTRY_POINT}() {\n}\n`;
}

function getFrameByteLength(): number {
    const formatFacts = getGPUDecoderFormatFacts(OUTPUT_FORMAT);
    const chromaSampleCount = Math.ceil(CODED_WIDTH / formatFacts.chromaWidthDivisor) * Math.ceil(CODED_HEIGHT / formatFacts.chromaHeightDivisor);
    return (CODED_WIDTH * CODED_HEIGHT + 2 * chromaSampleCount) * formatFacts.bytesPerSample;
}

/** Returns the packed planes of one frame, which the uncompressed decoder takes as its packet. */
function createFrameBytes(frameIndex: number): Uint8Array {
    const bytes = new Uint8Array(getFrameByteLength());
    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
        bytes[byteIndex] = (frameIndex * FRAME_BYTE_STRIDE + byteIndex * BYTE_INDEX_STRIDE) & BYTE_MASK;
    }
    return bytes;
}

/** Returns packets of frames in decode order, each frame's timestamp at its index in timestampIndices. */
function createPackets(timestampIndices: readonly number[]): GPUDecodePacket[] {
    return timestampIndices.map((timestampIndex: number, decodeIndex: number): GPUDecodePacket => ({
        data: createFrameBytes(decodeIndex).slice().buffer,
        durationMicroseconds: FRAME_DURATION_MICROSECONDS,
        keyframe: decodeIndex === 0,
        reset: decodeIndex === 0,
        timestampMicroseconds: timestampIndex * FRAME_DURATION_MICROSECONDS
    }));
}

function createSequentialPackets(packetCount: number): GPUDecodePacket[] {
    return createPackets(Array.from({ length: packetCount }, (_value: unknown, index: number) => index));
}

/** Returns the SHA-256 of frames, by an implementation independent of the engine's. */
function hashFrames(frameIndices: readonly number[]): string {
    const hash = createHash('sha256');
    for (const frameIndex of frameIndices) {
        hash.update(createFrameBytes(frameIndex));
    }
    return hash.digest('hex');
}

/** Returns one frame's packed planes cropped to a visible rectangle, rows tightly packed, by an implementation independent of the engine's. */
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

function createManifest(options: VectorDecoderOptions = {}): GPUDecoderManifest {
    const sha256 = options.sha256 === undefined ? hashFrames([ 0, 1, 2 ]) : options.sha256;
    return parseGPUDecoderManifest(createDecoderSource(options, sha256));
}

function createInput(packets: readonly GPUDecodePacket[]): GPUDecoderVectorInput {
    return { codecPrivate: null, packets, stream: STREAM };
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
        const expectedHash = hashFrames([ 0, 1, 2 ]);

        const result = await checkGPUDecoderVector(device.asDevice(), createManifest(), createInput(createSequentialPackets(PACKET_COUNT)));

        expect(result).toEqual({ code: 'passed', detail: expectedHash });
        expect(device.buffers.every(buffer => buffer.destroyed)).toBe(true);
    });

    it('hashes the checked frames cropped to the stream\'s visible rectangle, as FFmpeg writes rawvideo', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);
        const expectedHash = hashCroppedFrames([ 0, 1, 2 ], CROPPED_VISIBLE_RECTANGLE);
        const input: GPUDecoderVectorInput = {
            codecPrivate: null,
            packets: createSequentialPackets(PACKET_COUNT),
            stream: { ...STREAM, visibleRectangle: CROPPED_VISIBLE_RECTANGLE }
        };

        const result = await checkGPUDecoderVector(device.asDevice(), createManifest({ sha256: expectedHash }), input);

        expect(expectedHash).not.toBe(hashFrames([ 0, 1, 2 ]));
        expect(result).toEqual({ code: 'passed', detail: expectedHash });
    });

    it('checks the frames from the first checked frame on, in presentation order', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);
        // Presentation order is decode order 0, 2, 1, 3, so presented frames 1 and 2 are decoded frames 2 and 1
        const expectedHash = hashFrames([ 2, 1 ]);
        const manifest = createManifest({ firstFrame: LATER_FIRST_FRAME, lastFrame: LAST_FRAME, reorder: REORDER_DEPTH, sha256: expectedHash });

        const result = await checkGPUDecoderVector(device.asDevice(), manifest, createInput(createPackets(REORDERED_TIMESTAMP_INDICES)));

        expect(result).toEqual({ code: 'passed', detail: expectedHash });
    });

    it('reports a hash mismatch with the decoded and the declared hash', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);

        const result = await checkGPUDecoderVector(device.asDevice(), createManifest({ sha256: WRONG_HASH }), createInput(createSequentialPackets(PACKET_COUNT)));

        expect(result).toEqual({ code: 'hash-mismatch', detail: `${hashFrames([ 0, 1, 2 ])} != ${WRONG_HASH}` });
    });

    it('reports a decoder without a vector as unverified without creating a session', async () => {
        const device = new MockGPUDevice();

        const result = await checkGPUDecoderVector(device.asDevice(), createManifest({ sha256: null }), createInput(createSequentialPackets(PACKET_COUNT)));

        expect(result).toEqual({ code: 'unverified', detail: '' });
        expect(device.buffers).toEqual([]);
    });

    it('reports fewer frames than the vector checks', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);
        const packetCount = 3;

        const result = await checkGPUDecoderVector(device.asDevice(), createManifest({ lastFrame: MISSING_LAST_FRAME }), createInput(createSequentialPackets(packetCount)));

        expect(result).toEqual({ code: 'frames-missing', detail: `${packetCount} < ${MISSING_LAST_FRAME + 1}` });
    });

    it('reports frames dropped by reordering deeper than the decoder declares', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);

        const result = await checkGPUDecoderVector(device.asDevice(), createManifest(), createInput(createPackets(OUT_OF_ORDER_TIMESTAMP_INDICES)));

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

        const result = await checkGPUDecoderVector(device.asDevice(), createManifest(), createInput(createSequentialPackets(PACKET_COUNT)));

        expect(result).toEqual({ code: 'decoder-error', detail: String(DECODER_ERROR_CODE) });
    });

    it('reports a decoder that does not compile with the session failure', async () => {
        const device = new MockGPUDevice();
        const manifest = createManifest();
        const firstBodyLine = createGPUDecoderModule(manifest).firstBodyLine;
        device.compilationMessages = [ { lineNum: firstBodyLine, linePos: COMPILE_ERROR_COLUMN, message: COMPILE_ERROR_MESSAGE, type: 'error' } ];

        const result = await checkGPUDecoderVector(device.asDevice(), manifest, createInput(createSequentialPackets(PACKET_COUNT)));

        expect(result).toEqual({ code: 'compile-error', detail: `line ${manifest.bodyFirstLine}:${COMPILE_ERROR_COLUMN} ${COMPILE_ERROR_MESSAGE}` });
    });

    it('reports exhausted slots when a decoder never frees its references', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);
        const slotCount = getGPUFramePoolSlotCount(REFERENCES, 0);
        const packetCount = slotCount + 2;
        const manifest = createManifest({ lastFrame: packetCount - 1, references: REFERENCES });

        const result = await checkGPUDecoderVector(device.asDevice(), manifest, createInput(createSequentialPackets(packetCount)));

        expect(result).toEqual({ code: 'slots-exhausted', detail: `${packetCount - slotCount} packets, 0 free slots` });
    });

    it('reports a readback the device cannot map with the browser error', async () => {
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);
        device.mapFailure = createBrowserError();

        const result = await checkGPUDecoderVector(device.asDevice(), createManifest(), createInput(createSequentialPackets(PACKET_COUNT)));

        expect(result).toEqual({ code: 'readback-failed', detail: `${BROWSER_ERROR_NAME}: ${BROWSER_ERROR_MESSAGE}` });
    });
});

describe('GPUDecoderVectorCheckCache', () => {
    let restoreGlobals: () => void = (): void => undefined;

    beforeEach(() => {
        restoreGlobals = installWebGPUGlobals();
    });

    afterEach(() => {
        restoreGlobals();
    });

    it('checks a decoder once per device and decoder hash, and again on another device', async () => {
        const cache = new GPUDecoderVectorCheckCache();
        const firstDevice = new MockGPUDevice();
        const secondDevice = new MockGPUDevice();
        playUncompressedDecoder(firstDevice);
        playUncompressedDecoder(secondDevice);
        const source = createDecoderSource({}, hashFrames([ 0, 1, 2 ]));
        const decoderHash = await hashGPUDecoderSource(source);
        const manifest = parseGPUDecoderManifest(source);
        const input = createInput(createSequentialPackets(PACKET_COUNT));

        const firstResult = await cache.check(firstDevice.asDevice(), decoderHash, manifest, input);
        const repeatedResult = await cache.check(firstDevice.asDevice(), decoderHash, manifest, input);
        const otherDeviceResult = await cache.check(secondDevice.asDevice(), decoderHash, manifest, input);

        expect(firstResult.code).toBe('passed');
        expect(repeatedResult).toBe(firstResult);
        expect(firstDevice.shaderModuleCodes).toHaveLength(1);
        expect(otherDeviceResult).toEqual(firstResult);
        expect(secondDevice.shaderModuleCodes).toHaveLength(1);
    });

    it('does not cache an unexpected error, so a later call checks again', async () => {
        const cache = new GPUDecoderVectorCheckCache();
        const device = new MockGPUDevice();
        playUncompressedDecoder(device);
        device.failingBufferLabel = REFUSED_BUFFER_LABEL;
        const source = createDecoderSource({}, hashFrames([ 0, 1, 2 ]));
        const decoderHash = await hashGPUDecoderSource(source);
        const manifest = parseGPUDecoderManifest(source);
        const input = createInput(createSequentialPackets(PACKET_COUNT));

        await expect(cache.check(device.asDevice(), decoderHash, manifest, input)).rejects.toThrow(RangeError);
        device.failingBufferLabel = null;
        const result = await cache.check(device.asDevice(), decoderHash, manifest, input);

        expect(result.code).toBe('passed');
    });
});

describe('hashGPUDecoderSource', () => {
    it('returns the lowercase hexadecimal SHA-256 of the UTF-8 source', async () => {
        const source = createDecoderSource({}, null);

        expect(await hashGPUDecoderSource(source)).toBe(createHash('sha256').update(source, 'utf8').digest('hex'));
    });
});
