import { MAXIMUM_OUTSTANDING_RAW_FRAME_TRANSFER_COUNT } from './RawVideoFrameCopy';

// As many as the page can hold posted, so a steady stream reuses every spare it keeps; a 4K 10-bit spare is about 25 MB
export const MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH = MAXIMUM_OUTSTANDING_RAW_FRAME_TRANSFER_COUNT;

/**
 * Owns a run's spare raw frame buffers: buffers the page returned once uploaded, and buffers of frames closed without being posted.
 * A frame takes a spare of its exact byte length, or a new buffer when no spare fits.
 * Spares are kept up to a bound for each byte length, and a buffer past it is left to the garbage collector.
 */
export default class RawFrameBufferPool {
    private readonly spareBuffers: ArrayBuffer[] = [];

    public constructor(private readonly maximumSpareCountPerByteLength: number) {
        if (!Number.isSafeInteger(maximumSpareCountPerByteLength) || maximumSpareCountPerByteLength <= 0) {
            throw new RangeError('The raw frame buffer pool bound must be a positive safe integer');
        }
    }

    /** Takes the oldest spare of exactly this byte length, or allocates a buffer when no spare fits. */
    public take(byteLength: number): ArrayBuffer {
        const spareIndex = this.spareBuffers.findIndex((buffer: ArrayBuffer): boolean => buffer.byteLength === byteLength);
        if (spareIndex < 0) {
            return new ArrayBuffer(byteLength);
        }
        const [ spareBuffer ] = this.spareBuffers.splice(spareIndex, 1);
        return spareBuffer;
    }

    /**
     * Keeps a buffer the worker owns again as a spare, and returns whether it was kept.
     * A detached buffer, one already kept, or one past its byte length's bound is not.
     */
    public release(buffer: ArrayBuffer): boolean {
        if (buffer.byteLength === 0 || this.spareBuffers.includes(buffer)) {
            return false;
        }
        let sameLengthSpareCount = 0;
        for (const spareBuffer of this.spareBuffers) {
            if (spareBuffer.byteLength === buffer.byteLength) {
                sameLengthSpareCount += 1;
            }
        }
        if (sameLengthSpareCount >= this.maximumSpareCountPerByteLength) {
            return false;
        }

        this.spareBuffers.push(buffer);
        return true;
    }
}
