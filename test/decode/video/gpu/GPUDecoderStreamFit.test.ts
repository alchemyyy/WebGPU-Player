import { describe, expect, it } from 'vitest';

import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import { GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH } from 'webgpu-player/decode/video/gpu/GPUDecodeLimits';
import { parseGPUDecoderManifest } from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';
import {
    chooseGPUDecodeSessionStream,
    evaluateGPUDecoderBufferSizes,
    findGPUDecoderBufferLimitFailure,
    findGPUDecoderStreamFitFailure,
    getGPUDecoderPacketRingByteLength,
    selectGPUDecodeSessionStream
} from 'webgpu-player/decode/video/gpu/GPUDecoderStreamFit';
import { GPUVideoDecodeError, type GPUDecoderManifest, type GPUDecoderPictureSize } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';
import { createGPUDecodeStreamFacts, createGPUFramePoolLayout, getGPUFramePoolSlotCount } from 'webgpu-player/decode/video/gpu/GPUFramePool';

const FORMAT: GPUDecoderOutputFormat = 'I420';
const CONTAINER_WIDTH = 640;
const CONTAINER_HEIGHT = 360;
// The container's size rounded up to whole coding blocks of 64
const CONTAINER_CODED_HEIGHT = 384;
// The largest picture a sequence header declares for that stream, and its size rounded up to 64
const DECLARED_PICTURE: GPUDecoderPictureSize = { height: 720, width: 1_280 };
const DECLARED_CODED_WIDTH = 1_280;
const DECLARED_CODED_HEIGHT = 768;
// A sequence header that declares far more than its frames, as one corpus stream does for 640x360 frames
const OVERSIZED_PICTURE: GPUDecoderPictureSize = { height: 8_704, width: 16_384 };
// A declared picture within the container's own size, and its size rounded up to 64
const SMALLER_PICTURE: GPUDecoderPictureSize = { height: 288, width: 352 };
const SMALLER_CODED_WIDTH = 384;
const SMALLER_CODED_HEIGHT = 320;
// The container's pool, which a stream change falls back to
const CONTAINER_POOL: GPUDecoderPictureSize = { height: CONTAINER_CODED_HEIGHT, width: CONTAINER_WIDTH };
// Header conditions the decoder takes pictures within, as AV1's level 5 bounds them before the pool's rounding
const MAXIMUM_PICTURE_WIDTH = 8_192;
const MAXIMUM_PICTURE_HEIGHT = 4_352;
const DEFAULT_ACCEPTS = `codec in [av1], picture.width <= ${MAXIMUM_PICTURE_WIDTH}, picture.height <= ${MAXIMUM_PICTURE_HEIGHT}`;
// A UHD picture, whose pool rounds its height up past a bound on 2160 rows, and that bound on the picture and on the pool
const UHD_PICTURE: GPUDecoderPictureSize = { height: 2_160, width: 3_840 };
const UHD_CODED_HEIGHT = 2_176;
const PICTURE_HEIGHT_ACCEPTS = `codec in [av1], picture.height <= ${UHD_PICTURE.height}`;
const POOL_HEIGHT_ACCEPTS = `codec in [av1], stream.height <= ${UHD_PICTURE.height}`;
// A device whose buffers hold anything the tests ask for, and one whose buffers are small
const LARGE_BUFFER_LIMIT = 2 ** 31;
const SMALL_BUFFER_LIMIT = 2 ** 20;
// The scratch buffer of the AV1 decoder's frame store, in bytes per luma sample at 4:2:0
const FRAMES_BUFFER_NAME = 'frames';
const FRAMES_BYTES_PER_LUMA_SAMPLE = 30;
const STATE_BYTE_LENGTH = 1_024;
const PACKET_BYTE_LENGTH = 65_536;
// A packet past the limit a small device's ring holds
const LARGE_PACKET_BYTE_LENGTH = SMALL_BUFFER_LIMIT;
const WORD_BYTE_LENGTH = 4;
// A packet size that grows with the stream, as AV1's records do, and its bytes per luma sample of the pool
const PACKET_BYTES_PER_LUMA_SAMPLE = 8;
const PACKET_EXPRESSION = `${PACKET_BYTES_PER_LUMA_SAMPLE} * stream.width * stream.height`;
// A packet size past the 512 MiB a header may declare once a stream is this large
const OVERSIZED_PACKET_BYTES_PER_LUMA_SAMPLE = 4_096;
const OVERSIZED_PACKET_EXPRESSION = `stream.width * stream.height * ${OVERSIZED_PACKET_BYTES_PER_LUMA_SAMPLE}`;

type DecoderOptions = {
    accepts?: string
    buffers?: readonly string[]
    packet?: number | string
    state?: string
};

/** Returns a decoder's manifest with the header lines the options set and one dispatch. */
function createManifest(options: DecoderOptions = {}): GPUDecoderManifest {
    const accepts = options.accepts ?? DEFAULT_ACCEPTS;
    const header = [
        '//! id: fit-test',
        '//! name: Fit test',
        '//! decoder: video',
        `//! accepts: ${accepts}`,
        `//! output: ${FORMAT}`,
        `//! packet: ${options.packet ?? PACKET_BYTE_LENGTH}`,
        `//! state: ${options.state ?? STATE_BYTE_LENGTH}`,
        ...(options.buffers ?? [ `${FRAMES_BUFFER_NAME}, ${FRAMES_BYTES_PER_LUMA_SAMPLE} * stream.width * stream.height` ]).map(buffer => `//! buffer: ${buffer}`),
        '//! dispatch: decodePicture, 1'
    ];
    return parseGPUDecoderManifest(`${header.join('\n')}\n\n@compute @workgroup_size(1)\nfn decodePicture() {\n}\n`);
}

const CONTAINER_STREAM = createGPUDecodeStreamFacts(CONTAINER_WIDTH, CONTAINER_HEIGHT, FORMAT);

describe('evaluateGPUDecoderBufferSizes', () => {
    it('evaluates the state, each scratch buffer, and the largest packet for the stream', () => {
        const sizes = evaluateGPUDecoderBufferSizes(createManifest(), CONTAINER_STREAM, FORMAT);

        expect(sizes).toEqual({
            bufferByteLengths: [ FRAMES_BYTES_PER_LUMA_SAMPLE * CONTAINER_WIDTH * CONTAINER_CODED_HEIGHT ],
            packetByteLength: PACKET_BYTE_LENGTH,
            stateByteLength: STATE_BYTE_LENGTH
        });
    });

    it('sizes a packet whose size is an expression for each stream, so a larger stream takes larger packets', () => {
        const manifest = createManifest({ packet: PACKET_EXPRESSION });
        const declaredStream = createGPUDecodeStreamFacts(DECLARED_PICTURE.width, DECLARED_PICTURE.height, FORMAT);

        expect(evaluateGPUDecoderBufferSizes(manifest, CONTAINER_STREAM, FORMAT).packetByteLength)
            .toBe(PACKET_BYTES_PER_LUMA_SAMPLE * CONTAINER_WIDTH * CONTAINER_CODED_HEIGHT);
        expect(evaluateGPUDecoderBufferSizes(manifest, declaredStream, FORMAT).packetByteLength)
            .toBe(PACKET_BYTES_PER_LUMA_SAMPLE * DECLARED_CODED_WIDTH * DECLARED_CODED_HEIGHT);
    });

    it('throws the buffer-size failure for a buffer whose size is no byte count for the stream', () => {
        const manifest = createManifest({ buffers: [ `${FRAMES_BUFFER_NAME}, stream.width - 1024` ] });

        expect(() => evaluateGPUDecoderBufferSizes(manifest, CONTAINER_STREAM, FORMAT)).toThrow(GPUVideoDecodeError);
        expect(() => evaluateGPUDecoderBufferSizes(manifest, CONTAINER_STREAM, FORMAT)).toThrow(`buffer-size: ${FRAMES_BUFFER_NAME}`);
    });

    it('throws the packet-size failure for a packet past the largest a header may declare for the stream', () => {
        const manifest = createManifest({ packet: OVERSIZED_PACKET_EXPRESSION });

        expect(() => evaluateGPUDecoderBufferSizes(manifest, CONTAINER_STREAM, FORMAT))
            .toThrow(`packet-size: ${CONTAINER_WIDTH * CONTAINER_CODED_HEIGHT * OVERSIZED_PACKET_BYTES_PER_LUMA_SAMPLE} > ${GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH}`);
    });
});

describe('findGPUDecoderBufferLimitFailure', () => {
    it('names the first buffer the device cannot hold whole: the state, a scratch buffer, then the packet ring', () => {
        const manifest = createManifest({ packet: LARGE_PACKET_BYTE_LENGTH });
        const ringByteLength = 2 * LARGE_PACKET_BYTE_LENGTH;
        const packetByteLength = LARGE_PACKET_BYTE_LENGTH;

        expect(findGPUDecoderBufferLimitFailure(manifest, { bufferByteLengths: [ 1 ], packetByteLength, stateByteLength: SMALL_BUFFER_LIMIT + 1 }, SMALL_BUFFER_LIMIT))
            .toEqual({ code: 'state-size', detail: `${SMALL_BUFFER_LIMIT + WORD_BYTE_LENGTH} > ${SMALL_BUFFER_LIMIT}` });
        expect(findGPUDecoderBufferLimitFailure(manifest, { bufferByteLengths: [ SMALL_BUFFER_LIMIT + 1 ], packetByteLength, stateByteLength: 0 }, SMALL_BUFFER_LIMIT))
            .toEqual({ code: 'buffer-size', detail: `${FRAMES_BUFFER_NAME} ${SMALL_BUFFER_LIMIT + WORD_BYTE_LENGTH} > ${SMALL_BUFFER_LIMIT}` });
        expect(findGPUDecoderBufferLimitFailure(manifest, { bufferByteLengths: [ 1 ], packetByteLength, stateByteLength: 0 }, SMALL_BUFFER_LIMIT))
            .toEqual({ code: 'packet-size', detail: `ring ${ringByteLength} > ${SMALL_BUFFER_LIMIT}` });
        expect(findGPUDecoderBufferLimitFailure(manifest, { bufferByteLengths: [ 1 ], packetByteLength, stateByteLength: 0 }, LARGE_BUFFER_LIMIT)).toBeNull();
    });

    it('rings two word-aligned packets of the stream\'s largest packet', () => {
        expect(getGPUDecoderPacketRingByteLength({ bufferByteLengths: [], packetByteLength: WORD_BYTE_LENGTH + 1, stateByteLength: 0 })).toBe(4 * WORD_BYTE_LENGTH);
    });
});

describe('findGPUDecoderStreamFitFailure', () => {
    it('fits a stream the decoder takes and the device holds', () => {
        expect(findGPUDecoderStreamFitFailure(createManifest(), CONTAINER_STREAM, FORMAT, LARGE_BUFFER_LIMIT)).toBeNull();
    });

    it('refuses a stream the header\'s conditions do not take, naming the picture and its pool', () => {
        const stream = createGPUDecodeStreamFacts(OVERSIZED_PICTURE.width, OVERSIZED_PICTURE.height, FORMAT);

        expect(findGPUDecoderStreamFitFailure(createManifest(), stream, FORMAT, LARGE_BUFFER_LIMIT))
            .toBe(`accepts: picture ${OVERSIZED_PICTURE.width}x${OVERSIZED_PICTURE.height} in pool ${stream.codedWidth}x${stream.codedHeight} at ${stream.bitDepth} bits`);
    });

    it('judges picture conditions on the picture before the pool\'s rounding, and stream conditions on the pool', () => {
        const stream = createGPUDecodeStreamFacts(UHD_PICTURE.width, UHD_PICTURE.height, FORMAT);

        expect(stream.codedHeight).toBe(UHD_CODED_HEIGHT);
        expect(findGPUDecoderStreamFitFailure(createManifest({ accepts: PICTURE_HEIGHT_ACCEPTS }), stream, FORMAT, LARGE_BUFFER_LIMIT)).toBeNull();
        expect(findGPUDecoderStreamFitFailure(createManifest({ accepts: POOL_HEIGHT_ACCEPTS }), stream, FORMAT, LARGE_BUFFER_LIMIT))
            .toBe(`accepts: picture ${UHD_PICTURE.width}x${UHD_PICTURE.height} in pool ${UHD_PICTURE.width}x${UHD_CODED_HEIGHT} at ${stream.bitDepth} bits`);
    });

    it('judges a picture size it is given in place of the stream\'s visible extent', () => {
        expect(findGPUDecoderStreamFitFailure(createManifest(), CONTAINER_STREAM, FORMAT, LARGE_BUFFER_LIMIT, OVERSIZED_PICTURE))
            .toBe(`accepts: picture ${OVERSIZED_PICTURE.width}x${OVERSIZED_PICTURE.height} in pool ${CONTAINER_WIDTH}x${CONTAINER_CODED_HEIGHT} at ${CONTAINER_STREAM.bitDepth} bits`);
    });

    it('refuses a pool the device cannot hold before any buffer', () => {
        const manifest = createManifest();
        const layout = createGPUFramePoolLayout(FORMAT, CONTAINER_STREAM.codedWidth, CONTAINER_STREAM.codedHeight, getGPUFramePoolSlotCount(0, 0));

        expect(findGPUDecoderStreamFitFailure(manifest, CONTAINER_STREAM, FORMAT, layout.byteLength - 1))
            .toBe(`pool-size: ${layout.byteLength} > ${layout.byteLength - 1}`);
    });

    it('refuses a scratch buffer the device cannot hold, as the session would', () => {
        const manifest = createManifest();
        const framesByteLength = FRAMES_BYTES_PER_LUMA_SAMPLE * CONTAINER_WIDTH * CONTAINER_CODED_HEIGHT;
        const layout = createGPUFramePoolLayout(FORMAT, CONTAINER_STREAM.codedWidth, CONTAINER_STREAM.codedHeight, getGPUFramePoolSlotCount(0, 0));
        // A limit that holds the pool but not the frame store
        const limit = Math.max(layout.byteLength, framesByteLength - 1);

        expect(findGPUDecoderStreamFitFailure(manifest, CONTAINER_STREAM, FORMAT, limit)).toBe(`buffer-size: ${FRAMES_BUFFER_NAME} ${framesByteLength} > ${limit}`);
    });

    it('refuses a decoder whose state or buffer sizes give no byte count for the stream', () => {
        const manifest = createManifest({ state: 'stream.width - 1024' });

        expect(findGPUDecoderStreamFitFailure(manifest, CONTAINER_STREAM, FORMAT, LARGE_BUFFER_LIMIT)).toMatch(/^state-size: /);
    });

    it('refuses a packet ring the device cannot hold for a stream whose packets grow with it, and fits it for a smaller stream', () => {
        // A decoder whose only large buffer is its ring, on a device whose limit holds the smaller stream's ring and not the larger one's
        const manifest = createManifest({ buffers: [ `${FRAMES_BUFFER_NAME}, 1` ], packet: PACKET_EXPRESSION });
        const declaredStream = createGPUDecodeStreamFacts(DECLARED_PICTURE.width, DECLARED_PICTURE.height, FORMAT);
        const declaredRing = 2 * PACKET_BYTES_PER_LUMA_SAMPLE * DECLARED_CODED_WIDTH * DECLARED_CODED_HEIGHT;
        const limit = declaredRing - 1;

        expect(findGPUDecoderStreamFitFailure(manifest, declaredStream, FORMAT, limit)).toBe(`packet-size: ring ${declaredRing} > ${limit}`);
        expect(findGPUDecoderStreamFitFailure(manifest, CONTAINER_STREAM, FORMAT, limit)).toBeNull();
    });
});

describe('selectGPUDecodeSessionStream', () => {
    it('keeps the container\'s stream without a declared picture, or with one within it', () => {
        const manifest = createManifest();

        expect(selectGPUDecodeSessionStream(manifest, FORMAT, CONTAINER_STREAM, null, LARGE_BUFFER_LIMIT)).toBe(CONTAINER_STREAM);
        expect(selectGPUDecodeSessionStream(manifest, FORMAT, CONTAINER_STREAM, SMALLER_PICTURE, LARGE_BUFFER_LIMIT)).toBe(CONTAINER_STREAM);
    });

    it('sizes the pool for a larger declared picture, rounded up to whole coding blocks, keeping the container\'s visible rectangle', () => {
        const stream = selectGPUDecodeSessionStream(createManifest(), FORMAT, CONTAINER_STREAM, DECLARED_PICTURE, LARGE_BUFFER_LIMIT);

        expect(stream).toEqual({ ...CONTAINER_STREAM, codedHeight: DECLARED_CODED_HEIGHT, codedWidth: DECLARED_CODED_WIDTH });
        expect(stream.visibleRectangle).toEqual(CONTAINER_STREAM.visibleRectangle);
    });

    it('keeps the container\'s stream for a declared picture the decoder does not take, or the device does not hold', () => {
        const manifest = createManifest();
        const declaredFramesByteLength = FRAMES_BYTES_PER_LUMA_SAMPLE * DECLARED_CODED_WIDTH * DECLARED_CODED_HEIGHT;

        expect(selectGPUDecodeSessionStream(manifest, FORMAT, CONTAINER_STREAM, OVERSIZED_PICTURE, LARGE_BUFFER_LIMIT)).toBe(CONTAINER_STREAM);
        expect(selectGPUDecodeSessionStream(manifest, FORMAT, CONTAINER_STREAM, DECLARED_PICTURE, declaredFramesByteLength - 1)).toBe(CONTAINER_STREAM);
    });

    it('sizes a stream change\'s pool for the new sequence alone, even below the pool before it, clipping the visible rectangle into it', () => {
        const stream = selectGPUDecodeSessionStream(createManifest(), FORMAT, CONTAINER_STREAM, SMALLER_PICTURE, LARGE_BUFFER_LIMIT, CONTAINER_POOL);

        expect(stream).toEqual({
            ...CONTAINER_STREAM,
            codedHeight: SMALLER_CODED_HEIGHT,
            codedWidth: SMALLER_CODED_WIDTH,
            visibleRectangle: { height: SMALLER_CODED_HEIGHT, width: SMALLER_CODED_WIDTH, x: 0, y: 0 }
        });
    });

    it('falls back to the pool before a change grown to the picture when the decoder or the device refuses the new sequence alone', () => {
        const manifest = createManifest();
        const declaredFramesByteLength = FRAMES_BYTES_PER_LUMA_SAMPLE * DECLARED_CODED_WIDTH * DECLARED_CODED_HEIGHT;

        expect(selectGPUDecodeSessionStream(manifest, FORMAT, CONTAINER_STREAM, OVERSIZED_PICTURE, LARGE_BUFFER_LIMIT, DECLARED_PICTURE))
            .toEqual({ ...CONTAINER_STREAM, codedHeight: DECLARED_CODED_HEIGHT, codedWidth: DECLARED_CODED_WIDTH });
        expect(selectGPUDecodeSessionStream(manifest, FORMAT, CONTAINER_STREAM, DECLARED_PICTURE, declaredFramesByteLength - 1, CONTAINER_POOL)).toEqual(CONTAINER_STREAM);
    });

    it('refuses a stream change whose fallback the decoder refuses too, with the fallback\'s failure', () => {
        const manifest = createManifest();
        const failure = `accepts: picture ${OVERSIZED_PICTURE.width}x${OVERSIZED_PICTURE.height} in pool ${OVERSIZED_PICTURE.width}x${OVERSIZED_PICTURE.height} at ${CONTAINER_STREAM.bitDepth} bits`;

        expect(() => selectGPUDecodeSessionStream(manifest, FORMAT, CONTAINER_STREAM, OVERSIZED_PICTURE, LARGE_BUFFER_LIMIT, OVERSIZED_PICTURE)).toThrow(GPUVideoDecodeError);
        expect(() => selectGPUDecodeSessionStream(manifest, FORMAT, CONTAINER_STREAM, OVERSIZED_PICTURE, LARGE_BUFFER_LIMIT, OVERSIZED_PICTURE)).toThrow(failure);
    });
});

describe('chooseGPUDecodeSessionStream', () => {
    it('judges the decoder\'s accepts alone without a buffer limit, as the feed foresees a change\'s pool', () => {
        const manifest = createManifest();

        expect(chooseGPUDecodeSessionStream(manifest, FORMAT, CONTAINER_STREAM, DECLARED_PICTURE, null, CONTAINER_POOL))
            .toEqual({ kind: 'stream', stream: { ...CONTAINER_STREAM, codedHeight: DECLARED_CODED_HEIGHT, codedWidth: DECLARED_CODED_WIDTH } });
        expect(chooseGPUDecodeSessionStream(manifest, FORMAT, CONTAINER_STREAM, OVERSIZED_PICTURE, null, OVERSIZED_PICTURE)).toEqual({
            failure: {
                code: 'accepts',
                detail: `picture ${OVERSIZED_PICTURE.width}x${OVERSIZED_PICTURE.height} in pool ${OVERSIZED_PICTURE.width}x${OVERSIZED_PICTURE.height} at ${CONTAINER_STREAM.bitDepth} bits`
            },
            kind: 'refused'
        });
    });
});
