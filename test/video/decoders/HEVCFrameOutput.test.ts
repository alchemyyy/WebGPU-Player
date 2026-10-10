import { VideoSampleColorSpace } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';
import type { HEVCFramePlane } from 'webgpu-player/video/decoders/HEVCDecoderBackend';
import {
    HEVCVideoFrameWriter,
    prepareHEVCRawVideoFrame,
    writeHEVCDecodedFrame,
    type TransferringVideoFrameBufferInit,
    type VideoFrameConstructor
} from 'webgpu-player/video/decoders/HEVCFrameOutput';
import type { HEVCSoftwareDecodedFrame } from 'webgpu-player/video/decoders/HEVCSoftwareVideoDecoder';
import RawFrameBufferPool, {
    MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH
} from 'webgpu-player/video/RawFrameBufferPool';
import { PreparedRawVideoFrameSource, type RawVideoPlaneDescriptor } from 'webgpu-player/video/RawVideoFrameCopy';

// A 4x2 frame whose rows a decoder padded to 6 luma and 3 chroma samples, bytes at 8 bits and 16-bit words at 10
const CODED_WIDTH = 4;
const CODED_HEIGHT = 2;
const CHROMA_WIDTH = 2;
const CHROMA_HEIGHT = 1;
const LUMA_STRIDE = 6;
const CHROMA_STRIDE = 3;
const MAIN_PADDING_SAMPLE = 0xFF;
const MAIN10_PADDING_SAMPLE = 0xFFFF;
const LUMA_ROWS = [ [ 16, 17, 18, 19 ], [ 20, 21, 22, 23 ] ];
const CHROMA_BLUE_ROW = [ 128, 129 ];
const CHROMA_RED_ROW = [ 130, 131 ];
// 10-bit samples reach above a byte
const TEN_BIT_SAMPLE_OFFSET = 512;
const DISPLAY_WIDTH = 8;
const DISPLAY_HEIGHT = 2;
const TIMESTAMP_MICROSECONDS = 1_500_000 as Microseconds;
const DURATION_MICROSECONDS = 41_708 as Microseconds;
const ZERO_DURATION_MICROSECONDS = 0 as Microseconds;
const SDR_COLOR_SPACE = new VideoSampleColorSpace({
    fullRange: false,
    matrix: 'bt709',
    primaries: 'bt709',
    transfer: 'bt709'
});
// The compact 8-bit frame: 8 luma bytes, then 2 bytes of each chroma plane
const COMPACT_I420_BYTE_LENGTH = 12;
const LARGER_CODED_WIDTH = 8;

type CreatedVideoFrame = {
    data: ArrayBuffer
    init: TransferringVideoFrameBufferInit
    planeBytes: number[]
};

/** Lays rows a stride apart in the samples a decoder returns for a format: bytes for I420 and 16-bit words for I420P10. */
function padRows(rows: readonly (readonly number[])[], stride: number, format: 'I420' | 'I420P10'): HEVCFramePlane {
    const rowLength = rows[0].length;
    const sampleCount = ((rows.length - 1) * stride) + rowLength;
    const samples = format === 'I420' ?
        new Uint8Array(sampleCount).fill(MAIN_PADDING_SAMPLE) :
        new Uint16Array(sampleCount).fill(MAIN10_PADDING_SAMPLE);
    const sampleOffset = format === 'I420' ? 0 : TEN_BIT_SAMPLE_OFFSET;
    rows.forEach((row: readonly number[], rowIndex: number): void => {
        samples.set(row.map((sample: number): number => sample + sampleOffset), rowIndex * stride);
    });
    return { samples, stride };
}

function createDecodedFrame(
    format: 'I420' | 'I420P10',
    durationMicroseconds: Microseconds = DURATION_MICROSECONDS,
    codedWidth: number = CODED_WIDTH
): HEVCSoftwareDecodedFrame {
    const widthPadding = codedWidth - CODED_WIDTH;
    const lumaRows = LUMA_ROWS.map((row: readonly number[]): number[] => [ ...row, ...new Array<number>(widthPadding).fill(0) ]);
    const chromaPadding = new Array<number>(widthPadding / 2).fill(0);
    return {
        chromaHeight: CHROMA_HEIGHT,
        chromaWidth: codedWidth / 2,
        codedHeight: CODED_HEIGHT,
        codedWidth,
        colorSpace: SDR_COLOR_SPACE,
        displayHeight: DISPLAY_HEIGHT,
        displayWidth: DISPLAY_WIDTH,
        durationMicroseconds,
        format,
        planes: {
            chromaBlue: padRows([ [ ...CHROMA_BLUE_ROW, ...chromaPadding ] ], CHROMA_STRIDE + chromaPadding.length, format),
            chromaRed: padRows([ [ ...CHROMA_RED_ROW, ...chromaPadding ] ], CHROMA_STRIDE + chromaPadding.length, format),
            luma: padRows(lumaRows, LUMA_STRIDE + widthPadding, format)
        },
        timestampMicroseconds: TIMESTAMP_MICROSECONDS
    };
}

/** Records each VideoFrame a writer creates, and takes over transferred buffers when it honors transfer. */
function createRecordingConstructor(honorsTransfer: boolean): {
    constructVideoFrame: VideoFrameConstructor
    createdFrames: CreatedVideoFrame[]
} {
    const createdFrames: CreatedVideoFrame[] = [];
    const constructVideoFrame = vi.fn((data: ArrayBuffer, init: TransferringVideoFrameBufferInit): VideoFrame => {
        const bytesPerSample = init.format === 'I420' ? 1 : 2;
        const bytes = new Uint8Array(data);
        const planeBytes: number[] = [];
        const planeLengths = [
            CODED_HEIGHT * init.codedWidth * bytesPerSample,
            CHROMA_HEIGHT * (init.codedWidth / 2) * bytesPerSample,
            CHROMA_HEIGHT * (init.codedWidth / 2) * bytesPerSample
        ];
        planeLengths.forEach((planeLength: number, planeIndex: number): void => {
            const offset = init.layout?.[planeIndex]?.offset ?? 0;
            planeBytes.push(...bytes.subarray(offset, offset + planeLength));
        });
        createdFrames.push({ data, init, planeBytes });
        if (honorsTransfer) {
            structuredClone(data, { transfer: init.transfer ?? [] });
        }
        return {
            close: vi.fn(),
            codedHeight: init.codedHeight,
            codedWidth: init.codedWidth,
            displayHeight: init.displayHeight,
            displayWidth: init.displayWidth,
            duration: init.duration ?? null,
            format: init.format,
            timestamp: init.timestamp
        } as unknown as VideoFrame;
    });
    return { constructVideoFrame, createdFrames };
}

/** Reads little-endian 16-bit samples from bytes. */
function readSixteenBitSamples(bytes: readonly number[]): number[] {
    const samples: number[] = [];
    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 2) {
        samples.push(bytes[byteIndex] + (bytes[byteIndex + 1] * 256));
    }
    return samples;
}

describe('HEVCVideoFrameWriter', () => {
    it('writes 8-bit frames as compact I420 with the init VideoSample.toVideoFrame gives', () => {
        const { constructVideoFrame, createdFrames } = createRecordingConstructor(true);
        const writer = new HEVCVideoFrameWriter(constructVideoFrame);

        writer.write(createDecodedFrame('I420'));

        expect(createdFrames).toHaveLength(1);
        const [ { data, init, planeBytes } ] = createdFrames;
        expect(init).toEqual({
            codedHeight: CODED_HEIGHT,
            codedWidth: CODED_WIDTH,
            colorSpace: SDR_COLOR_SPACE,
            displayHeight: DISPLAY_HEIGHT,
            displayWidth: DISPLAY_WIDTH,
            duration: DURATION_MICROSECONDS,
            format: 'I420',
            layout: [
                { offset: 0, stride: CODED_WIDTH },
                { offset: CODED_WIDTH * CODED_HEIGHT, stride: CHROMA_WIDTH },
                { offset: (CODED_WIDTH * CODED_HEIGHT) + (CHROMA_WIDTH * CHROMA_HEIGHT), stride: CHROMA_WIDTH }
            ],
            timestamp: TIMESTAMP_MICROSECONDS,
            transfer: [ data ],
            visibleRect: { height: CODED_HEIGHT, width: CODED_WIDTH, x: 0, y: 0 }
        });
        expect(planeBytes).toEqual([ ...LUMA_ROWS.flat(), ...CHROMA_BLUE_ROW, ...CHROMA_RED_ROW ]);
        // The frame took the buffer over
        expect(data.byteLength).toBe(0);
    });

    it('writes 10-bit frames as compact I420P10', () => {
        const { constructVideoFrame, createdFrames } = createRecordingConstructor(true);
        const writer = new HEVCVideoFrameWriter(constructVideoFrame);

        writer.write(createDecodedFrame('I420P10'));

        const [ { init, planeBytes } ] = createdFrames;
        expect(init.format).toBe('I420P10');
        expect(init.layout?.[0]).toEqual({ offset: 0, stride: CODED_WIDTH * Uint16Array.BYTES_PER_ELEMENT });
        expect(readSixteenBitSamples(planeBytes)).toEqual(
            [ ...LUMA_ROWS.flat(), ...CHROMA_BLUE_ROW, ...CHROMA_RED_ROW ].map(
                (sample: number): number => sample + TEN_BIT_SAMPLE_OFFSET
            )
        );
    });

    it('omits a zero duration, as VideoSample.toVideoFrame does', () => {
        const { constructVideoFrame, createdFrames } = createRecordingConstructor(true);
        const writer = new HEVCVideoFrameWriter(constructVideoFrame);

        writer.write(createDecodedFrame('I420', ZERO_DURATION_MICROSECONDS));

        expect(createdFrames[0].init).not.toHaveProperty('duration');
    });

    it('writes the next frame into a new buffer once a frame takes one over', () => {
        const { constructVideoFrame, createdFrames } = createRecordingConstructor(true);
        const writer = new HEVCVideoFrameWriter(constructVideoFrame);

        writer.write(createDecodedFrame('I420'));
        writer.write(createDecodedFrame('I420'));

        expect(createdFrames[1].data).not.toBe(createdFrames[0].data);
        expect(createdFrames[1].data.byteLength).toBe(0);
    });

    it('reuses the buffer of a browser that copies instead of taking it over', () => {
        const { constructVideoFrame, createdFrames } = createRecordingConstructor(false);
        const writer = new HEVCVideoFrameWriter(constructVideoFrame);

        writer.write(createDecodedFrame('I420'));
        writer.write(createDecodedFrame('I420'));
        writer.write(createDecodedFrame('I420', DURATION_MICROSECONDS, LARGER_CODED_WIDTH));

        expect(createdFrames[0].data.byteLength).toBe(COMPACT_I420_BYTE_LENGTH);
        expect(createdFrames[1].data).toBe(createdFrames[0].data);
        expect(createdFrames[1].planeBytes).toEqual(createdFrames[0].planeBytes);
        // A frame of another size needs a buffer of its own
        expect(createdFrames[2].data).not.toBe(createdFrames[0].data);
    });
});

describe('writeHEVCDecodedFrame', () => {
    it('prepares a raw frame in a buffer from the run\'s pool on the raw route', () => {
        const bufferPool = new RawFrameBufferPool(MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH);
        const spareFrame = prepareHEVCRawVideoFrame(createDecodedFrame('I420P10'), null);
        const spareBuffer = spareFrame.takeRawFrame('I420P10', {
            codedHeight: CODED_HEIGHT,
            codedWidth: CODED_WIDTH,
            displayHeight: DISPLAY_HEIGHT,
            displayWidth: DISPLAY_WIDTH
        })?.data;
        bufferPool.release(spareBuffer ?? new ArrayBuffer(0));

        const source = writeHEVCDecodedFrame(createDecodedFrame('I420P10'), { bufferPool, kind: 'raw-planes' });

        expect(source.kind).toBe('prepared-raw-frame');
        const preparedFrame = (source as { frame: PreparedRawVideoFrameSource }).frame;
        expect(preparedFrame).toBeInstanceOf(PreparedRawVideoFrameSource);
        expect(preparedFrame).toMatchObject({
            codedHeight: CODED_HEIGHT,
            codedWidth: CODED_WIDTH,
            colorSpace: { fullRange: false, matrix: 'bt709', primaries: 'bt709', transfer: 'bt709' },
            displayHeight: DISPLAY_HEIGHT,
            displayWidth: DISPLAY_WIDTH,
            duration: DURATION_MICROSECONDS,
            format: 'I420P10',
            timestamp: TIMESTAMP_MICROSECONDS
        });
        expect(preparedFrame.takeRawFrame('I420P10', {
            codedHeight: CODED_HEIGHT,
            codedWidth: CODED_WIDTH,
            displayHeight: DISPLAY_HEIGHT,
            displayWidth: DISPLAY_WIDTH
        })?.data).toBe(spareBuffer);
    });

    it('prepares an 8-bit frame from its byte planes, row by row into the aligned layout', () => {
        const preparedFrame = prepareHEVCRawVideoFrame(createDecodedFrame('I420'), null);

        const rawFrame = preparedFrame.takeRawFrame('I420', {
            codedHeight: CODED_HEIGHT,
            codedWidth: CODED_WIDTH,
            displayHeight: DISPLAY_HEIGHT,
            displayWidth: DISPLAY_WIDTH
        });

        expect(rawFrame).not.toBeNull();
        const bytes = new Uint8Array(rawFrame?.data ?? new ArrayBuffer(0));
        const planeRows = (rawFrame?.planes ?? []).map((plane: RawVideoPlaneDescriptor): number[][] => {
            const rows: number[][] = [];
            for (let rowIndex = 0; rowIndex < plane.height; rowIndex += 1) {
                const rowOffset = plane.byteOffset + (rowIndex * plane.bytesPerRow);
                rows.push(Array.from(bytes.subarray(rowOffset, rowOffset + plane.rowByteLength)));
            }
            return rows;
        });
        expect(planeRows).toEqual([ LUMA_ROWS, [ CHROMA_BLUE_ROW ], [ CHROMA_RED_ROW ] ]);
    });

    it('builds a VideoFrame with its own geometry on the VideoFrame route', () => {
        const { constructVideoFrame } = createRecordingConstructor(true);

        const source = writeHEVCDecodedFrame(createDecodedFrame('I420'), {
            kind: 'video-frame',
            writer: new HEVCVideoFrameWriter(constructVideoFrame)
        });

        expect(source).toMatchObject({
            frame: { format: 'I420', timestamp: TIMESTAMP_MICROSECONDS },
            geometry: {
                codedHeight: CODED_HEIGHT,
                codedWidth: CODED_WIDTH,
                displayHeight: DISPLAY_HEIGHT,
                displayWidth: DISPLAY_WIDTH
            },
            kind: 'native-frame'
        });
    });
});
