// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { secondsToMicroseconds, type Microseconds } from 'webgpu-player/MediaTime';

import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../helpers/enginePaths';
import {
    createWorkerStartRequest,
    decodeToEnd,
    FakeDecodedVideoFrame,
    FakeVideoDecoder,
    getFrameResponses,
    getReadyResponse,
    startDecodeWorker,
    type FakeWorkerScope
} from '../helpers/decodeWorkerHarness';

// The FFmpeg-made vectors of scripts/codec_vector_assets/generate_AVI_demux_vectors.py
const AVI_VECTOR_DIRECTORY = join(CODEC_VECTOR_ASSETS_DIRECTORY, 'avi');
const VP9_FILE_NAME = 'vp9-aac.avi';
const H264_FILE_NAME = 'h264-bframes-mp3-vbr.avi';
const HEVC_FILE_NAME = 'hevc-ac3.avi';
const UNTAGGED_HEVC_FILE_NAME = 'hevc-untagged-ac3.avi';
const MPEG4_FILE_NAME = 'mpeg4-mp3.avi';
const OPENDML_FILE_NAME = 'opendml-like.avi';
const VIDEO_FRAME_COUNT = 12;
const VIDEO_FRAME_RATE = 24;
const DROPPED_FRAME_SLOT_COUNT = 1;
// Seconds round to whole microseconds once in the demuxer and once on the way out
const ROUNDING_TOLERANCE_MICROSECONDS = 1;
const VP9_CODEC_PREFIX = 'vp09.';
const HEVC_CODEC_PREFIX = 'hev1.';
// dwLength of the first stream header, after its fourcc and size, as AVIDemux.test.ts patches it
const STREAM_HEADER_FOURCC = 'strh';
const STREAM_HEADER_LENGTH_OFFSET = 8 + 32;
const OPENDML_DECLARED_FRAME_COUNT = 10_000;
const MPEG4_MESSAGE = 'The selected video codec has no decode route: mpeg4';
const OPENDML_MESSAGE = 'The selected AVI video track outruns its idx1 index: opendml-index-unread';
// Each packet's presentation time in frames, in decode order, as FFprobe's best-effort timestamps give the same pictures (AVIDemux.test.ts)
const H264_PRESENTATION_FRAMES = [ 2, 6, 4, 3, 5, 7, 8, 12, 10, 9, 11, 13 ];
const HEVC_PRESENTATION_FRAMES = [ 2, 5, 4, 3, 8, 7, 6, 11, 10, 9, 13, 12 ];
// The reorder depth both streams' sequence parameter sets declare
const REORDER_DEPTH = 2;
// Between the HEVC vector's leading pictures at 6 and 7 and their CRA picture at 8, whose group starts at packet 4
const HEVC_LEADING_PICTURE_FRAME = 7.5;
const SAFARI_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

/**
 * A decoder that outputs in presentation order, as WebCodecs requires: it holds the stream's reorder depth of decoded frames and outputs the earliest
 * when one more arrives, as a picture buffer bumps them, then the rest on flush.
 * The fake orders by the frames' timestamps, standing in for the order counts a real decoder reads.
 */
class PresentationOrderVideoDecoder extends FakeVideoDecoder {
    private readonly releaseHeldFrames: () => void;

    public constructor(init: VideoDecoderInit) {
        const heldFrames: VideoFrame[] = [];
        const releaseEarliest = (): void => {
            heldFrames.sort((left: VideoFrame, right: VideoFrame): number => left.timestamp - right.timestamp);
            const [ earliest ] = heldFrames.splice(0, 1);
            init.output(earliest);
        };
        super({
            ...init,
            output: (frame: VideoFrame): void => {
                heldFrames.push(frame);
                if (heldFrames.length > REORDER_DEPTH) {
                    releaseEarliest();
                }
            }
        });
        this.releaseHeldFrames = (): void => {
            while (heldFrames.length > 0) {
                releaseEarliest();
            }
        };
    }

    public override async flush(): Promise<void> {
        await super.flush();
        this.releaseHeldFrames();
    }
}

/** Returns presentation times in frames in presentation order. */
function sortFrames(frames: readonly number[]): number[] {
    return [ ...frames ].sort((left: number, right: number): number => left - right);
}

function toFrameMicroseconds(frames: number): Microseconds {
    return secondsToMicroseconds(frames / VIDEO_FRAME_RATE);
}

function expectFrameTimes(actualMicroseconds: readonly number[], expectedFrames: readonly number[]): void {
    expect(actualMicroseconds).toHaveLength(expectedFrames.length);
    actualMicroseconds.forEach((actual: number, index: number): void => {
        expect(Math.abs(actual - toFrameMicroseconds(expectedFrames[index]))).toBeLessThanOrEqual(ROUNDING_TOLERANCE_MICROSECONDS);
    });
}

/** Returns the timestamps of the chunks the run's decoder took, in decode order. */
function getDecodedChunkFrames(): number[] {
    return FakeVideoDecoder.instances.flatMap(decoder => decoder.chunks.map(chunk => Math.round(chunk.timestamp * VIDEO_FRAME_RATE / 1_000_000)));
}

/**
 * The VideoFrame global of the sample path, which wraps decoded frames in Mediabunny's samples: it recognizes the fake decoder's frames, and a frame made
 * from one with new timing copies it.
 */
class FakeVideoFrame {
    public static [Symbol.hasInstance](value: unknown): boolean {
        return value instanceof FakeDecodedVideoFrame;
    }

    public constructor(source: FakeDecodedVideoFrame, init?: VideoFrameInit) {
        return new FakeDecodedVideoFrame(source.codedWidth, source.codedHeight, init?.timestamp ?? source.timestamp, init?.duration ?? source.duration);
    }
}

/** Runs the worker as WebKit does, whose sample path orders decoded frames by their own packets' timestamps. */
async function startWebKitDecodeWorker(): Promise<FakeWorkerScope> {
    vi.stubGlobal('navigator', { userAgent: SAFARI_USER_AGENT });
    const workerScope = await startDecodeWorker(MEDIA_FILES);
    vi.stubGlobal('VideoFrame', FakeVideoFrame);
    return workerScope;
}

function readAVIVector(fileName: string): Uint8Array {
    return new Uint8Array(readFileSync(join(AVI_VECTOR_DIRECTORY, fileName)));
}

/** Declares far more frames in the first stream header than idx1 indexes, as the first RIFF list of an OpenDML file does. */
function createOpenDMLLikeAVI(): Uint8Array {
    const bytes = readAVIVector(VP9_FILE_NAME);
    const streamHeaderOffset = Buffer.from(bytes).indexOf(STREAM_HEADER_FOURCC);
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(streamHeaderOffset + STREAM_HEADER_LENGTH_OFFSET, OPENDML_DECLARED_FRAME_COUNT, true);
    return bytes;
}

const MEDIA_FILES = new Map<string, Uint8Array>([
    [ VP9_FILE_NAME, readAVIVector(VP9_FILE_NAME) ],
    [ H264_FILE_NAME, readAVIVector(H264_FILE_NAME) ],
    [ HEVC_FILE_NAME, readAVIVector(HEVC_FILE_NAME) ],
    [ UNTAGGED_HEVC_FILE_NAME, readAVIVector(UNTAGGED_HEVC_FILE_NAME) ],
    [ MPEG4_FILE_NAME, readAVIVector(MPEG4_FILE_NAME) ],
    [ OPENDML_FILE_NAME, createOpenDMLLikeAVI() ]
]);

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the playback worker on AVI', () => {
    it('decodes VP9 through the owned VP9 path, one packet per frame slot', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(VP9_FILE_NAME));

        expect(getReadyResponse(responses).codec.startsWith(VP9_CODEC_PREFIX)).toBe(true);
        const frameTimes = getFrameResponses(responses).map(response => response.mediaTimeMicroseconds);
        expect(frameTimes).toHaveLength(VIDEO_FRAME_COUNT);
        // FFmpeg's muxer drops the second slot into an empty chunk, so the frames after it run one slot late
        frameTimes.forEach((frameTime: number, frameIndex: number): void => {
            const frameSlot = frameIndex === 0 ? 0 : frameIndex + DROPPED_FRAME_SLOT_COUNT;
            expect(Math.abs(frameTime - secondsToMicroseconds(frameSlot / VIDEO_FRAME_RATE))).toBeLessThanOrEqual(ROUNDING_TOLERANCE_MICROSECONDS);
        });
    });

    it('plays H.264 with B-pyramids from AVI on WebKit in presentation order, by the timestamps the demuxer gives each picture', async () => {
        // The fake decoder outputs frames in decode order, each with its own packet's timestamp
        const workerScope = await startWebKitDecodeWorker();

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(H264_FILE_NAME));

        expect(getDecodedChunkFrames()).toEqual(H264_PRESENTATION_FRAMES);
        expectFrameTimes(getFrameResponses(responses).map(response => response.mediaTimeMicroseconds), sortFrames(H264_PRESENTATION_FRAMES));
    });

    it('starts H.264 from AVI on WebKit at the key frame of the group a seek lands in, then plays in presentation order', async () => {
        const workerScope = await startWebKitDecodeWorker();
        const secondGroupStart = H264_PRESENTATION_FRAMES.indexOf(8);

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(H264_FILE_NAME, { startTimeMicroseconds: toFrameMicroseconds(9.5) }));

        expect(getDecodedChunkFrames()).toEqual(H264_PRESENTATION_FRAMES.slice(secondGroupStart));
        const frameTimes = getFrameResponses(responses).map(response => response.mediaTimeMicroseconds);
        expectFrameTimes(frameTimes, [ 9, 10, 11, 12, 13 ].slice(-frameTimes.length));
        expect(frameTimes[0]).toBeLessThanOrEqual(toFrameMicroseconds(9.5));
    });

    it.each([ HEVC_FILE_NAME, UNTAGGED_HEVC_FILE_NAME ])('plays HEVC with B-pyramids and an open group from %s through the owned HEVC path in presentation order', async (
        fileName: string
    ) => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        vi.stubGlobal('VideoDecoder', PresentationOrderVideoDecoder);

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(fileName));

        expect(getReadyResponse(responses).codec.startsWith(HEVC_CODEC_PREFIX)).toBe(true);
        expect(getDecodedChunkFrames()).toEqual(HEVC_PRESENTATION_FRAMES);
        expectFrameTimes(getFrameResponses(responses).map(response => response.mediaTimeMicroseconds), sortFrames(HEVC_PRESENTATION_FRAMES));
    });

    it('starts HEVC from AVI among a CRA picture\'s leading pictures at the key frame before them, then plays in presentation order', async () => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        vi.stubGlobal('VideoDecoder', PresentationOrderVideoDecoder);

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(HEVC_FILE_NAME, {
            startTimeMicroseconds: toFrameMicroseconds(HEVC_LEADING_PICTURE_FRAME)
        }));

        expect(getDecodedChunkFrames()).toEqual(HEVC_PRESENTATION_FRAMES);
        const frameTimes = getFrameResponses(responses).map(response => response.mediaTimeMicroseconds);
        expectFrameTimes(frameTimes, [ 7, 8, 9, 10, 11, 12, 13 ].slice(-frameTimes.length));
        expect(frameTimes[0]).toBeLessThanOrEqual(toFrameMicroseconds(HEVC_LEADING_PICTURE_FRAME));
    });

    it.each([
        [ MPEG4_FILE_NAME, MPEG4_MESSAGE ],
        [ OPENDML_FILE_NAME, OPENDML_MESSAGE ]
    ])('refuses %s with the check that failed', async (fileName: string, message: string) => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const request = createWorkerStartRequest(fileName);

        workerScope.dispatchRequest(request);
        await workerScope.waitForStopped(request.generation);

        expect(workerScope.responses).toContainEqual({ failureKind: 'source-unsupported', generation: request.generation, message, type: 'error' });
        expect(getFrameResponses(workerScope.responses)).toEqual([]);
    });
});
