import { getRawFormatBitDepth } from '../decode/video/RawVideoFrameCopy';
import type { CustomDecodeRawVideoFrameFormat } from '../pipeline/DecodeWorkerProtocol';

// 2x2 is the smallest coded size every chroma subsampling allows: 4:2:0 halves both axes
const PROBE_FRAME_SIZE = 2;
const LUMA_PLANE_COUNT = 1;
const CHROMA_PLANE_COUNT = 2;
const BITS_PER_BYTE = 8;

const supportByFormat = new Map<CustomDecodeRawVideoFrameFormat, boolean>();

/** Returns the horizontal and vertical chroma divisors of a planar YUV format. */
function getChromaDivisors(format: CustomDecodeRawVideoFrameFormat): readonly [number, number] {
    if (format.startsWith('I420')) {
        return [2, 2];
    }
    return format.startsWith('I422') ? [2, 1] : [1, 1];
}

/** Returns the bytes a tightly packed frame of `format` needs at `width` x `height`. */
export function getVideoFrameFormatByteLength(format: CustomDecodeRawVideoFrameFormat, width: number, height: number): number {
    // Samples above 8 bits are stored in 16-bit words
    const bytesPerComponent = getRawFormatBitDepth(format) > BITS_PER_BYTE ? 2 : 1;
    const [horizontalDivisor, verticalDivisor] = getChromaDivisors(format);
    const lumaSamples = width * height;
    const chromaSamples = Math.ceil(width / horizontalDivisor) * Math.ceil(height / verticalDivisor);
    return (LUMA_PLANE_COUNT * lumaSamples + CHROMA_PLANE_COUNT * chromaSamples) * bytesPerComponent;
}

function probeVideoFrameFormat(format: CustomDecodeRawVideoFrameFormat): boolean {
    if (typeof globalThis.VideoFrame !== 'function') {
        return false;
    }
    const data = new Uint8Array(getVideoFrameFormatByteLength(format, PROBE_FRAME_SIZE, PROBE_FRAME_SIZE));
    try {
        // eslint-disable-next-line compat/compat -- guarded above
        const frame = new VideoFrame(data, {
            codedHeight: PROBE_FRAME_SIZE,
            codedWidth: PROBE_FRAME_SIZE,
            format: format as VideoPixelFormat,
            timestamp: 0
        });
        frame.close();
        return true;
    } catch (error) {
        // A TypeError means the VideoPixelFormat enum lacks the value, as every shipping Safari lacks 10/12-bit
        // formats; anything else is inconclusive, so the real probe still decides
        return !(error instanceof TypeError);
    }
}

/** Returns whether this browser can hold `format` in a VideoFrame at all; cached per format for the page. */
export function canHoldVideoFrameFormat(format: CustomDecodeRawVideoFrameFormat): boolean {
    let supported = supportByFormat.get(format);
    if (supported === undefined) {
        supported = probeVideoFrameFormat(format);
        supportByFormat.set(format, supported);
    }
    return supported;
}
