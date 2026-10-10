import { describe, expect, it } from 'vitest';

import PCMChannelPool from 'webgpu-player/audio/processing/PCMChannelPool';

// The largest chunk the pool's buffers hold
const CHANNEL_FRAME_CAPACITY = 12_000;
const CHANNEL_BYTE_CAPACITY = CHANNEL_FRAME_CAPACITY * Float32Array.BYTES_PER_ELEMENT;
const SMALL_CHUNK_FRAME_COUNT = 1_920;
const OVERSIZED_CHUNK_FRAME_COUNT = CHANNEL_FRAME_CAPACITY + 1;
const MAXIMUM_SPARE_BUFFER_COUNT = 2;
const SPARE_SAMPLE_VALUE = 0.5;

describe('PCMChannelPool', () => {
    it('returns a view of exactly the requested frames over a buffer that holds the largest chunk', () => {
        const pool = new PCMChannelPool(CHANNEL_FRAME_CAPACITY, MAXIMUM_SPARE_BUFFER_COUNT);

        const channel = pool.take(SMALL_CHUNK_FRAME_COUNT);

        expect(channel).toHaveLength(SMALL_CHUNK_FRAME_COUNT);
        expect(channel.byteOffset).toBe(0);
        expect(channel.buffer.byteLength).toBe(CHANNEL_BYTE_CAPACITY);
    });

    it('reuses a returned buffer for the next channel of any length that fits', () => {
        const pool = new PCMChannelPool(CHANNEL_FRAME_CAPACITY, MAXIMUM_SPARE_BUFFER_COUNT);
        const firstChannel = pool.take(CHANNEL_FRAME_CAPACITY);
        firstChannel.fill(SPARE_SAMPLE_VALUE);

        pool.give(firstChannel.buffer as ArrayBuffer);
        expect(pool.spareBufferCount).toBe(1);
        const reusedChannel = pool.take(SMALL_CHUNK_FRAME_COUNT);

        expect(reusedChannel.buffer).toBe(firstChannel.buffer);
        expect(reusedChannel).toHaveLength(SMALL_CHUNK_FRAME_COUNT);
        expect(pool.spareBufferCount).toBe(0);
    });

    it('allocates a chunk larger than its capacity without spending a spare', () => {
        const pool = new PCMChannelPool(CHANNEL_FRAME_CAPACITY, MAXIMUM_SPARE_BUFFER_COUNT);
        pool.give(new ArrayBuffer(CHANNEL_BYTE_CAPACITY));

        const oversizedChannel = pool.take(OVERSIZED_CHUNK_FRAME_COUNT);

        expect(oversizedChannel).toHaveLength(OVERSIZED_CHUNK_FRAME_COUNT);
        expect(pool.spareBufferCount).toBe(1);
    });

    it('drops buffers too small for the largest chunk, detached ones, duplicates, and spares past its bound', () => {
        const pool = new PCMChannelPool(CHANNEL_FRAME_CAPACITY, MAXIMUM_SPARE_BUFFER_COUNT);
        const keptBuffer = new ArrayBuffer(CHANNEL_BYTE_CAPACITY);
        const detachedBuffer = new ArrayBuffer(CHANNEL_BYTE_CAPACITY);
        // A transfer detaches the buffer, which the worklet's release would otherwise have returned
        // eslint-disable-next-line compat/compat -- The test runs in Node
        structuredClone(detachedBuffer, { transfer: [ detachedBuffer ] });

        pool.give(new ArrayBuffer(CHANNEL_BYTE_CAPACITY - Float32Array.BYTES_PER_ELEMENT));
        pool.give(detachedBuffer);
        pool.give(keptBuffer);
        pool.give(keptBuffer);
        expect(pool.spareBufferCount).toBe(1);

        pool.give(new ArrayBuffer(CHANNEL_BYTE_CAPACITY));
        pool.give(new ArrayBuffer(CHANNEL_BYTE_CAPACITY));
        expect(pool.spareBufferCount).toBe(MAXIMUM_SPARE_BUFFER_COUNT);
    });

    it('gives back every distinct buffer of a chunk whose PCM was copied elsewhere', () => {
        const pool = new PCMChannelPool(CHANNEL_FRAME_CAPACITY, MAXIMUM_SPARE_BUFFER_COUNT);
        const channelData = [ pool.take(SMALL_CHUNK_FRAME_COUNT), pool.take(SMALL_CHUNK_FRAME_COUNT) ];

        pool.giveChannels(channelData);

        expect(pool.spareBufferCount).toBe(channelData.length);
    });

    it('rejects a capacity, a bound, or a frame count that is not a positive safe integer', () => {
        expect(() => new PCMChannelPool(0, MAXIMUM_SPARE_BUFFER_COUNT)).toThrow(RangeError);
        expect(() => new PCMChannelPool(CHANNEL_FRAME_CAPACITY, 0)).toThrow(RangeError);
        expect(() => new PCMChannelPool(CHANNEL_FRAME_CAPACITY, MAXIMUM_SPARE_BUFFER_COUNT).take(0)).toThrow(RangeError);
    });
});
