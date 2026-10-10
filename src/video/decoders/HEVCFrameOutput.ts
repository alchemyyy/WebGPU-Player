import type RawFrameBufferPool from '../RawFrameBufferPool';
import {
    copyRawVideoPlaneRows,
    PreparedRawVideoFrameSource
} from '../RawVideoFrameCopy';
import type { HEVCFramePlane } from './HEVCDecoderBackend';
import type { HEVCSoftwareDecodedFrame } from './HEVCSoftwareVideoDecoder';
import type { OwnedDecodedVideoSource } from './OwnedVideoDecodeStream';

/** A VideoFrame init whose buffer the frame may take over; the DOM typings predate transfer. */
export type TransferringVideoFrameBufferInit = VideoFrameBufferInit & {
    transfer?: ArrayBuffer[]
};

/** Constructs a VideoFrame from a buffer, as the VideoFrame constructor does. */
export type VideoFrameConstructor = (data: ArrayBuffer, init: TransferringVideoFrameBufferInit) => VideoFrame;

/** Where a bundled HEVC decoder's frames go: into the aligned raw layout, from a run's buffer pool, or into VideoFrames. */
export type HEVCFrameOutput =
    | Readonly<{
        bufferPool: RawFrameBufferPool | null
        kind: 'raw-planes'
    }>
    | Readonly<{
        kind: 'video-frame'
        writer: HEVCVideoFrameWriter
    }>;

type CompactFrameLayout = Readonly<{
    byteLength: number
    bytesPerSample: 1 | 2
    layout: readonly PlaneLayout[]
}>;

type CompactPlane = Readonly<{
    height: number
    plane: HEVCFramePlane
    width: number
}>;

function createBrowserVideoFrame(data: ArrayBuffer, init: TransferringVideoFrameBufferInit): VideoFrame {
    // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
    return new VideoFrame(data, init);
}

/** Returns the compact layout a VideoSample gives a decoded frame: luma, then blue and red chroma, each plane's rows abutting. */
function getCompactFrameLayout(frame: HEVCSoftwareDecodedFrame): CompactFrameLayout {
    const bytesPerSample = frame.format === 'I420' ? 1 : 2;
    const lumaByteLength = frame.codedWidth * frame.codedHeight * bytesPerSample;
    const chromaByteLength = frame.chromaWidth * frame.chromaHeight * bytesPerSample;
    const byteLength = lumaByteLength + (2 * chromaByteLength);
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
        throw new TypeError('The decoded HEVC frame size is invalid');
    }
    return {
        byteLength,
        bytesPerSample,
        layout: [
            { offset: 0, stride: frame.codedWidth * bytesPerSample },
            { offset: lumaByteLength, stride: frame.chromaWidth * bytesPerSample },
            { offset: lumaByteLength + chromaByteLength, stride: frame.chromaWidth * bytesPerSample }
        ]
    };
}

/** Writes a decoded frame's planes into compact planes, whose samples are bytes at 8 bits and 16-bit words at 10. */
function writeCompactPlanes(frame: HEVCSoftwareDecodedFrame, compactLayout: CompactFrameLayout, buffer: ArrayBuffer): void {
    const compactPlanes: CompactPlane[] = [];
    compactPlanes.push({ height: frame.codedHeight, plane: frame.planes.luma, width: frame.codedWidth });
    compactPlanes.push({ height: frame.chromaHeight, plane: frame.planes.chromaBlue, width: frame.chromaWidth });
    compactPlanes.push({ height: frame.chromaHeight, plane: frame.planes.chromaRed, width: frame.chromaWidth });
    for (let planeIndex = 0; planeIndex < compactPlanes.length; planeIndex += 1) {
        const { height, plane, width } = compactPlanes[planeIndex];
        const sampleCount = width * height;
        const offset = compactLayout.layout[planeIndex].offset;
        const destination = compactLayout.bytesPerSample === 1 ?
            new Uint8Array(buffer, offset, sampleCount) :
            new Uint16Array(buffer, offset, sampleCount);
        copyRawVideoPlaneRows(plane.samples, plane.stride, destination, width, width, height);
    }
}

/**
 * Builds a VideoFrame from each decoded frame, in compact planes, with the format, layout, timing, color, visible rectangle, and display size VideoSample.toVideoFrame gives it.
 * The frame takes the buffer over; a browser that copies it instead leaves it to the next frame.
 */
export class HEVCVideoFrameWriter {
    private scratchBuffer: ArrayBuffer | null = null;

    public constructor(private readonly constructVideoFrame: VideoFrameConstructor = createBrowserVideoFrame) {}

    /** Writes a frame while its planes are in WASM memory and returns the VideoFrame that holds them. */
    public write(frame: HEVCSoftwareDecodedFrame): VideoFrame {
        const compactLayout = getCompactFrameLayout(frame);
        const buffer = this.takeBuffer(compactLayout.byteLength);
        writeCompactPlanes(frame, compactLayout, buffer);
        const videoFrame = this.constructVideoFrame(buffer, {
            codedHeight: frame.codedHeight,
            codedWidth: frame.codedWidth,
            colorSpace: frame.colorSpace,
            displayHeight: frame.displayHeight,
            displayWidth: frame.displayWidth,
            // VideoSample.toVideoFrame omits a zero duration
            ...(frame.durationMicroseconds === 0 ? {} : { duration: frame.durationMicroseconds }),
            format: frame.format as VideoPixelFormat,
            layout: [ ...compactLayout.layout ],
            timestamp: frame.timestampMicroseconds,
            transfer: [ buffer ],
            visibleRect: {
                height: frame.codedHeight,
                width: frame.codedWidth,
                x: 0,
                y: 0
            }
        });
        // A browser that ignores transfer copied the planes, so the buffer stays attached for the next frame
        this.scratchBuffer = buffer.byteLength > 0 ? buffer : null;
        return videoFrame;
    }

    private takeBuffer(byteLength: number): ArrayBuffer {
        const scratchBuffer = this.scratchBuffer;
        this.scratchBuffer = null;
        return scratchBuffer?.byteLength === byteLength ? scratchBuffer : new ArrayBuffer(byteLength);
    }
}

/** Writes a decoded frame into the aligned raw layout of its own format, in a buffer from the pool. */
export function prepareHEVCRawVideoFrame(
    frame: HEVCSoftwareDecodedFrame,
    bufferPool: RawFrameBufferPool | null
): PreparedRawVideoFrameSource {
    return PreparedRawVideoFrameSource.prepare(
        {
            codedHeight: frame.codedHeight,
            codedWidth: frame.codedWidth,
            colorSpace: frame.colorSpace,
            displayHeight: frame.displayHeight,
            displayWidth: frame.displayWidth,
            durationMicroseconds: frame.durationMicroseconds,
            format: frame.format,
            timestampMicroseconds: frame.timestampMicroseconds
        },
        [ frame.planes.luma, frame.planes.chromaBlue, frame.planes.chromaRed ],
        bufferPool
    );
}

/** Writes a decoded frame out while its planes are in WASM memory, as the decoded source an owned stream takes. */
export function writeHEVCDecodedFrame(frame: HEVCSoftwareDecodedFrame, output: HEVCFrameOutput): OwnedDecodedVideoSource {
    switch (output.kind) {
        case 'raw-planes':
            return {
                frame: prepareHEVCRawVideoFrame(frame, output.bufferPool),
                kind: 'prepared-raw-frame'
            };
        case 'video-frame': {
            const videoFrame = output.writer.write(frame);
            return {
                frame: videoFrame,
                geometry: {
                    codedHeight: videoFrame.codedHeight,
                    codedWidth: videoFrame.codedWidth,
                    displayHeight: videoFrame.displayHeight,
                    displayWidth: videoFrame.displayWidth
                },
                kind: 'native-frame'
            };
        }
    }
}
