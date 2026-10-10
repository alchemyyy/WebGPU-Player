import { requirePositiveSafeInteger } from '../SafeIntegerValidation';

/**
 * Reuses the backing buffers of planar PCM channels: those the worklet returns once it played them, and the output stage's own intermediates.
 * Every buffer it keeps holds the largest chunk the output stage emits, so any chunk fits any buffer, and a taken channel is a view of exactly the requested length.
 */
export default class PCMChannelPool {
    private readonly buffers: ArrayBuffer[] = [];
    private readonly channelByteCapacity: number;
    private readonly maximumBufferCount: number;

    /**
     * @param channelFrameCapacity The frames of the largest chunk, which sizes every pooled buffer
     * @param maximumBufferCount The most spare buffers kept; more are left to the garbage collector
     */
    public constructor(channelFrameCapacity: number, maximumBufferCount: number) {
        this.channelByteCapacity = requirePositiveSafeInteger(channelFrameCapacity, 'Pooled channel frame capacity')
            * Float32Array.BYTES_PER_ELEMENT;
        this.maximumBufferCount = requirePositiveSafeInteger(maximumBufferCount, 'Maximum pooled buffer count');
    }

    /** The spare buffers held, for diagnostics and tests */
    public get spareBufferCount(): number {
        return this.buffers.length;
    }

    /** Returns a channel of exactly frameCount frames over a spare buffer, or over a new one sized to the pool's capacity. */
    public take(frameCount: number): Float32Array {
        requirePositiveSafeInteger(frameCount, 'Pooled channel frame count');
        const byteLength = frameCount * Float32Array.BYTES_PER_ELEMENT;
        if (byteLength <= this.channelByteCapacity) {
            const buffer = this.buffers.pop();
            if (buffer) {
                return new Float32Array(buffer, 0, frameCount);
            }
        }
        return new Float32Array(new ArrayBuffer(Math.max(byteLength, this.channelByteCapacity)), 0, frameCount);
    }

    /** Keeps a buffer that no channel uses anymore; a buffer too small to hold any chunk, a detached one, or one past the bound is dropped. */
    public give(buffer: ArrayBuffer): void {
        if (!(buffer instanceof ArrayBuffer)
            || buffer.byteLength < this.channelByteCapacity
            || this.buffers.length >= this.maximumBufferCount
            || this.buffers.includes(buffer)) {
            return;
        }
        this.buffers.push(buffer);
    }

    /** Gives back the buffers of channels that no longer hold live PCM, such as the resampler's output after the limiter copied it. */
    public giveChannels(channelData: readonly Float32Array[]): void {
        for (const channel of channelData) {
            if (channel.buffer instanceof ArrayBuffer) {
                this.give(channel.buffer);
            }
        }
    }
}
