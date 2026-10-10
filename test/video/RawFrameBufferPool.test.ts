import { describe, expect, it } from 'vitest';

import { MAX_DECODED_RAW_FRAME_CREDITS } from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import RawFrameBufferPool, {
    MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH
} from 'webgpu-player/video/RawFrameBufferPool';

const FRAME_BYTE_LENGTH = 1_024;
// A Dolby Vision run keeps its BL and compound buffers beside each other, at their own byte lengths
const OTHER_FRAME_BYTE_LENGTH = 2_048;
const SINGLE_SPARE_BOUND = 1;
const INVALID_SPARE_BOUNDS = [ 0, -1, 1.5, Number.NaN ];

describe('RawFrameBufferPool', () => {
    it('keeps as many spares of a byte length as the page can hold posted frames', () => {
        expect(MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH).toBe(MAX_DECODED_RAW_FRAME_CREDITS);
    });

    it('allocates a buffer of the requested byte length when no spare fits', () => {
        const pool = new RawFrameBufferPool(MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH);

        const buffer = pool.take(FRAME_BYTE_LENGTH);

        expect(buffer.byteLength).toBe(FRAME_BYTE_LENGTH);
        expect(pool.take(FRAME_BYTE_LENGTH)).not.toBe(buffer);
    });

    it('reuses released spares of the exact byte length in FIFO order', () => {
        const pool = new RawFrameBufferPool(MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH);
        const firstBuffer = new ArrayBuffer(FRAME_BYTE_LENGTH);
        const secondBuffer = new ArrayBuffer(FRAME_BYTE_LENGTH);
        const otherBuffer = new ArrayBuffer(OTHER_FRAME_BYTE_LENGTH);

        expect(pool.release(firstBuffer)).toBe(true);
        expect(pool.release(otherBuffer)).toBe(true);
        expect(pool.release(secondBuffer)).toBe(true);

        expect(pool.take(FRAME_BYTE_LENGTH)).toBe(firstBuffer);
        expect(pool.take(OTHER_FRAME_BYTE_LENGTH)).toBe(otherBuffer);
        expect(pool.take(FRAME_BYTE_LENGTH)).toBe(secondBuffer);
        const allocatedBuffer = pool.take(FRAME_BYTE_LENGTH);
        expect([ firstBuffer, secondBuffer, otherBuffer ]).not.toContain(allocatedBuffer);
    });

    it('bounds the spares of each byte length separately', () => {
        const pool = new RawFrameBufferPool(SINGLE_SPARE_BOUND);
        const keptBuffer = new ArrayBuffer(FRAME_BYTE_LENGTH);
        const otherBuffer = new ArrayBuffer(OTHER_FRAME_BYTE_LENGTH);

        expect(pool.release(keptBuffer)).toBe(true);
        expect(pool.release(new ArrayBuffer(FRAME_BYTE_LENGTH))).toBe(false);
        expect(pool.release(otherBuffer)).toBe(true);

        expect(pool.take(FRAME_BYTE_LENGTH)).toBe(keptBuffer);
        expect(pool.take(OTHER_FRAME_BYTE_LENGTH)).toBe(otherBuffer);
    });

    it('refuses a detached buffer and a buffer it already keeps', () => {
        const pool = new RawFrameBufferPool(MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH);
        const buffer = new ArrayBuffer(FRAME_BYTE_LENGTH);

        expect(pool.release(new ArrayBuffer(0))).toBe(false);
        expect(pool.release(buffer)).toBe(true);
        expect(pool.release(buffer)).toBe(false);

        expect(pool.take(FRAME_BYTE_LENGTH)).toBe(buffer);
        expect(pool.take(FRAME_BYTE_LENGTH)).not.toBe(buffer);
    });

    it.each(INVALID_SPARE_BOUNDS)('rejects a spare bound of %s', (spareBound: number) => {
        expect(() => new RawFrameBufferPool(spareBound)).toThrow(RangeError);
    });
});
