import { describe, expect, it } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';
import GPUVideoDecodeFeed, {
    getGPUVideoDecodeStreamChange,
    type GPUVideoDecodeFeedCallbacks,
    type GPUVideoDecodeFeedPacket,
    type GPUVideoDecodeHandle,
    type GPUVideoDecodeSessionRequest
} from 'webgpu-player/decode/video/gpu/GPUVideoDecodeFeed';
import type { DecodedFramePoolPresentationFrame } from 'webgpu-player/presentation/WebGPUPresenter';
import { requireMicroseconds } from 'webgpu-player/TimeMath';
import { GPUVideoDecodeError, type GPUDecoderPictureSize, type GPUVideoDecodeFailure } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';
import { selectGPUDecodeSessionStream } from 'webgpu-player/decode/video/gpu/GPUDecoderStreamFit';
import { createGPUFramePoolLayout, getGPUFramePoolSlotCount } from 'webgpu-player/decode/video/gpu/GPUFramePool';
import type { GPUVideoDecoderSelection } from 'webgpu-player/decode/video/gpu/GPUVideoDecoderCatalog';
import type { HDR10PlusFrameMetadata } from 'webgpu-player/demux/hdr/HDR10PlusMetadata';

import { createVideoDecoderPackageForTest, createVideoDecoderSource, TEST_DECODER_CODEC } from '../../../helpers/decoderPackages';
import {
    createFakeGPUVideoDecodeSessionFactory,
    FAKE_GPU_DECODER_NAME,
    FAKE_GPU_SLOT_COUNT,
    type FakeGPUVideoDecodeSessionFactory
} from '../../../helpers/fakeGPUVideoDecode';

const FRAME_DURATION_MICROSECONDS = requireMicroseconds(40_000);
const FIRST_TIMESTAMP_MICROSECONDS = requireMicroseconds(1_000_000);
const CODED_WIDTH = 1_920;
const CODED_HEIGHT = 1_088;
const CODED_POOL: GPUDecoderPictureSize = { height: CODED_HEIGHT, width: CODED_WIDTH };
const VISIBLE_HEIGHT = 1_080;
const DISPLAY_WIDTH = 2_560;
const INITIAL_VIDEO_EPOCH = 0;
const RESYNCED_VIDEO_EPOCH = 1;
// The HEVC decoder's sliceData error, code 11, with the failing value 7
const DECODER_ERROR_WORD = 0x0B00_0007;
const DESCRIBED_DECODER_ERROR = 'sliceData: 7';
const COMPILE_FAILURE: GPUVideoDecodeFailure = { code: 'compile-error', detail: 'line 3:1 expected expression' };
const PACKET_SIZE_FAILURE: GPUVideoDecodeFailure = { code: 'packet-size', detail: '33554433 > 33554432' };
const FIRST_CODEC_PRIVATE = new Uint8Array([ 1, 2, 3 ]);
const OTHER_CODEC_PRIVATE = new Uint8Array([ 1, 2, 4 ]);
// A packet's HDR10+ state, which its frame carries unchanged whatever the status
const MALFORMED_HDR10_PLUS_METADATA: HDR10PlusFrameMetadata = { metadata: null, status: 'malformed' };
// The output events a parser decided in a video's last packets, which had no picture to carry them: an earlier picture presented, another dropped
const TRAILING_OUTPUT_EVENTS = Uint32Array.of(3, 0x8000_0004);
// A decoder whose WGSL reads the container's packets, so its packets carry no output events
const PACKET_READING_PACKAGE = createVideoDecoderPackageForTest(createVideoDecoderSource({ name: 'Packet reader', outputFormats: [ 'I420' ] }));
const GPU_VIDEO_DECODER: GPUVideoDecoderSelection = { codec: TEST_DECODER_CODEC, decoderId: PACKET_READING_PACKAGE.id, package: PACKET_READING_PACKAGE };
// The content hash of a rebuilt file of the same package
const REBUILT_CONTENT_HASH = 'e7'.repeat(32);
// A decoder that bounds its pictures as a codec's level does, by their own size before the pool's rounding
const PICTURE_AREA_BOUND = 4_194_304;
const BOUNDED_PACKAGE = createVideoDecoderPackageForTest(createVideoDecoderSource({
    acceptsConditions: [ `picture.width * picture.height <= ${PICTURE_AREA_BOUND}` ],
    id: 'bounded-decoder',
    name: 'Bounded decoder',
    outputFormats: [ 'I420' ]
}));
// A later sequence wide and short, whose box with the container's height beside it crosses the bound; the pool it falls back to, and its own pool
const WIDE_SEQUENCE_SIZE: GPUDecoderPictureSize = { height: 192, width: 5_504 };
const WIDE_FALLBACK_PICTURE_SIZE: GPUDecoderPictureSize = { height: 1_088, width: 5_504 };
const WIDE_SEQUENCE_POOL: GPUDecoderPictureSize = { height: 192, width: 5_504 };
// A picture beyond the pool that the bounded decoder takes, and its pool; a picture past the bound
const GROWN_PICTURE_SIZE: GPUDecoderPictureSize = { height: 1_440, width: 2_560 };
const GROWN_PICTURE_POOL: GPUDecoderPictureSize = { height: 1_472, width: 2_560 };
const UNBOUNDED_PICTURE_SIZE: GPUDecoderPictureSize = { height: 2_160, width: 4_096 };
const UNBOUNDED_PICTURE_FAILURE = 'accepts: picture 4096x2160 in pool 4096x2176 at 8 bits';
// A device buffer limit that holds every pool of these tests
const LARGE_BUFFER_LIMIT = 2 ** 31;
// A picture of its own size within the pool, as an AV1 frame after a size change, and the repeat counts its parser reported
const PICTURE_SIZE: GPUDecoderPictureSize = { height: 720, width: 1_280 };
const REPEAT_COUNTS = [ 12 ];
// The largest picture a parser read in the codec private data, and another
const MAXIMUM_PICTURE_SIZE: GPUDecoderPictureSize = { height: 2_160, width: 3_840 };
const OTHER_MAXIMUM_PICTURE_SIZE: GPUDecoderPictureSize = { height: 1_088, width: 1_920 };
// A later sequence's smaller maximum, a picture larger than the pool, and a declared maximum no device holds, which the session fell back from
const SMALLER_MAXIMUM_PICTURE_SIZE: GPUDecoderPictureSize = { height: 720, width: 1_280 };
const LARGER_PICTURE_SIZE: GPUDecoderPictureSize = { height: 2_160, width: 3_840 };
const REFUSED_MAXIMUM_PICTURE_SIZE: GPUDecoderPictureSize = { height: 8_704, width: 16_384 };
// A device whose buffers hold the container's pool and one grown to a larger picture, but not the pool of the largest picture declared
const DECLARED_POOL: GPUDecoderPictureSize = { height: 2_176, width: 3_840 };
const SMALL_DEVICE_BUFFER_LIMIT = createGPUFramePoolLayout(
    'I420',
    DECLARED_POOL.width,
    DECLARED_POOL.height,
    getGPUFramePoolSlotCount(PACKET_READING_PACKAGE.manifest.references, PACKET_READING_PACKAGE.manifest.reorder)
).byteLength - 1;
// A stream that changes its output format at its third picture, whose events present the second picture and itself
const CHANGED_FORMAT = 'I444P12';
const CHANGED_BIT_DEPTH = 12;
const CHANGE_PICTURE_INDEX = 2;
const EARLIER_PICTURE_EVENT = 1;
const OWN_PICTURE_EVENT = CHANGE_PICTURE_INDEX;
const CHANGE_PICTURE_EVENTS = Uint32Array.of(EARLIER_PICTURE_EVENT, OWN_PICTURE_EVENT);
const FORMAT_FAILURE: GPUVideoDecodeFailure = { code: 'format-unsupported', detail: 'I444P12 not in I420' };
// Submission completions that settle every packet of the stream-change tests
const SETTLE_ROUND_COUNT = 8;

type FeedHarness = FakeGPUVideoDecodeSessionFactory & {
    callbacks: GPUVideoDecodeFeedCallbacks & {
        creditsReleased: number
        drainedCount: number
        failures: string[]
        frames: DecodedFramePoolPresentationFrame[]
    }
    feed: GPUVideoDecodeFeed
};

function createCallbacks(): FeedHarness['callbacks'] {
    const callbacks: FeedHarness['callbacks'] = {
        creditsReleased: 0,
        drainedCount: 0,
        failures: [],
        frames: [],
        onCreditsReleased: (credits: number): void => {
            callbacks.creditsReleased += credits;
        },
        onFailure: (detail: string): void => {
            callbacks.failures.push(detail);
        },
        onFrame: (frame: DecodedFramePoolPresentationFrame): void => {
            callbacks.frames.push(frame);
        },
        onVideoDrained: (): void => {
            callbacks.drainedCount += 1;
        }
    };
    return callbacks;
}

function createHarness(maximumBufferByteLength?: number): FeedHarness {
    const sessionFactory = createFakeGPUVideoDecodeSessionFactory(
        (errorWord: number): string => (errorWord === DECODER_ERROR_WORD ? DESCRIBED_DECODER_ERROR : String(errorWord)),
        maximumBufferByteLength
    );
    return { ...sessionFactory, callbacks: createCallbacks(), feed: new GPUVideoDecodeFeed(sessionFactory.factory) };
}

function createRequest(
    codecPrivate: Uint8Array | null = FIRST_CODEC_PRIVATE,
    maximumPictureSize: GPUDecoderPictureSize | null = null
): GPUVideoDecodeSessionRequest {
    return {
        codecPrivate,
        decoder: GPU_VIDEO_DECODER,
        format: 'I420',
        maximumPictureSize,
        stream: {
            bitDepth: 8,
            codedHeight: CODED_HEIGHT,
            codedWidth: CODED_WIDTH,
            visibleRectangle: { height: VISIBLE_HEIGHT, width: CODED_WIDTH, x: 0, y: 0 }
        }
    };
}

function getTimestamp(index: number): Microseconds {
    return requireMicroseconds(FIRST_TIMESTAMP_MICROSECONDS + index * FRAME_DURATION_MICROSECONDS);
}

function createPacket(index: number, HDR10PlusMetadata: HDR10PlusFrameMetadata | null = null): GPUVideoDecodeFeedPacket {
    const timestampMicroseconds: Microseconds = getTimestamp(index);
    return {
        data: new ArrayBuffer(16),
        durationMicroseconds: FRAME_DURATION_MICROSECONDS,
        format: null,
        HDR10PlusMetadata,
        keyframe: index === 0,
        maximumPictureSize: null,
        outputEvents: null,
        repeatCounts: null,
        timestampMicroseconds,
        visibleSize: null
    };
}

/** Returns the default request with the decoder that bounds its pictures. */
function createBoundedRequest(): GPUVideoDecodeSessionRequest {
    return { ...createRequest(), decoder: { ...GPU_VIDEO_DECODER, decoderId: BOUNDED_PACKAGE.id, package: BOUNDED_PACKAGE } };
}

function startConfigured(harness: FeedHarness, request: GPUVideoDecodeSessionRequest = createRequest()): void {
    harness.feed.start(harness.callbacks, INITIAL_VIDEO_EPOCH);
    harness.feed.configure(request, { displayHeight: VISIBLE_HEIGHT, displayWidth: DISPLAY_WIDTH });
}

/** Lets the session's creation and the submissions' completions settle. */
async function settle(): Promise<void> {
    await new Promise<void>(resolve => {
        setTimeout(resolve, 0);
    });
}

describe('GPUVideoDecodeFeed', () => {
    it('creates the session once the track is described, then decodes the packets that waited, one submission at a time', async () => {
        const harness = createHarness();
        harness.feed.start(harness.callbacks, INITIAL_VIDEO_EPOCH);
        harness.feed.queuePacket(createPacket(0));
        harness.feed.queuePacket(createPacket(1));

        harness.feed.configure(createRequest(), { displayHeight: VISIBLE_HEIGHT, displayWidth: DISPLAY_WIDTH });
        await settle();

        expect(harness.factory).toHaveBeenCalledOnce();
        const session = harness.sessions[0];
        expect(session.queuedPackets.map(packet => packet.reset)).toEqual([ true, false ]);
        // The second packet waits for the first one's decode work
        expect(session.submittedPackets).toHaveLength(1);
        expect(harness.callbacks.creditsReleased).toBe(1);
        expect(harness.callbacks.frames).toHaveLength(1);
        expect(harness.callbacks.frames[0]).toMatchObject({
            displayHeight: VISIBLE_HEIGHT,
            displayWidth: DISPLAY_WIDTH,
            durationMicroseconds: FRAME_DURATION_MICROSECONDS,
            mediaTimeMicroseconds: FIRST_TIMESTAMP_MICROSECONDS,
            outputMode: 'frame-pool',
            videoEpoch: INITIAL_VIDEO_EPOCH
        });

        harness.queue.completeAll();
        await settle();

        expect(session.submittedPackets).toHaveLength(2);
        expect(harness.callbacks.creditsReleased).toBe(2);
        expect(harness.feed.getTelemetry()).toMatchObject({
            decoderName: FAKE_GPU_DECODER_NAME,
            slotCount: FAKE_GPU_SLOT_COUNT,
            state: 'ready',
            submittedPacketCount: 2
        });
    });

    it('hands each picture its own visible size and repeat counts, and presents a picture of its own size in the stream\'s display area', async () => {
        const harness = createHarness();
        startConfigured(harness);
        await settle();

        harness.feed.queuePacket({ ...createPacket(0), repeatCounts: REPEAT_COUNTS, visibleSize: PICTURE_SIZE });

        expect(harness.sessions[0].queuedPackets[0]).toMatchObject({ repeatCounts: REPEAT_COUNTS, visibleSize: PICTURE_SIZE });
        expect(harness.callbacks.frames[0]).toMatchObject({ displayHeight: VISIBLE_HEIGHT, displayWidth: DISPLAY_WIDTH });
        expect(harness.callbacks.frames[0].frame.visibleRectangle).toEqual({ ...PICTURE_SIZE, x: 0, y: 0 });
    });

    it('spends and returns a credit for each picture of a packet, which all take its timing', async () => {
        const harness = createHarness();
        startConfigured(harness);
        await settle();
        const hiddenPicture = createPacket(0);
        const shownPicture = { ...createPacket(0), keyframe: false };

        harness.feed.queuePacket(hiddenPicture);
        harness.feed.queuePacket(shownPicture);
        harness.queue.completeAll();
        await settle();

        expect(harness.callbacks.creditsReleased).toBe(2);
        expect(harness.sessions[0].submittedPackets.map(packet => packet.timestampMicroseconds)).toEqual([ FIRST_TIMESTAMP_MICROSECONDS, FIRST_TIMESTAMP_MICROSECONDS ]);
    });

    it('keeps the session for the same declared largest picture and replaces it for another', async () => {
        const harness = createHarness();
        startConfigured(harness, createRequest(FIRST_CODEC_PRIVATE, MAXIMUM_PICTURE_SIZE));
        await settle();

        startConfigured(harness, createRequest(FIRST_CODEC_PRIVATE, MAXIMUM_PICTURE_SIZE));
        await settle();
        expect(harness.factory).toHaveBeenCalledOnce();
        expect(harness.requests[0].maximumPictureSize).toEqual(MAXIMUM_PICTURE_SIZE);

        startConfigured(harness, createRequest(FIRST_CODEC_PRIVATE, OTHER_MAXIMUM_PICTURE_SIZE));
        await settle();
        expect(harness.factory).toHaveBeenCalledTimes(2);
        startConfigured(harness, createRequest(FIRST_CODEC_PRIVATE, null));
        await settle();
        expect(harness.factory).toHaveBeenCalledTimes(3);
    });

    it('gives each frame the HDR10+ state of the packet it decodes', async () => {
        const harness = createHarness();
        startConfigured(harness);
        await settle();

        harness.feed.queuePacket(createPacket(0, MALFORMED_HDR10_PLUS_METADATA));

        expect(harness.callbacks.frames[0].HDR10PlusMetadata).toBe(MALFORMED_HDR10_PLUS_METADATA);
    });

    it('returns a released frame\'s slot to its session, which then decodes the packet that waited for it', async () => {
        const harness = createHarness();
        startConfigured(harness);
        await settle();
        const session = harness.sessions[0];
        session.freeSlotCount = 1;
        harness.feed.queuePacket(createPacket(0));
        harness.feed.queuePacket(createPacket(1));
        harness.queue.completeAll();
        await settle();
        expect(session.submittedPackets).toHaveLength(1);

        expect(harness.feed.releaseFrame(harness.callbacks.frames[0])).toBe(true);

        expect(session.releasedFrames).toHaveLength(1);
        expect(session.submittedPackets).toHaveLength(2);
        expect(harness.feed.releaseFrame(harness.callbacks.frames[0])).toBe(false);
    });

    it('keeps the session for a generation of the same stream and replaces it for another', async () => {
        const harness = createHarness();
        startConfigured(harness);
        await settle();
        const firstSession = harness.sessions[0];

        startConfigured(harness);
        await settle();

        expect(harness.factory).toHaveBeenCalledOnce();
        expect(firstSession.resetCount).toBe(1);
        expect(harness.feed.getTelemetry().reuseCount).toBe(1);

        startConfigured(harness, createRequest(OTHER_CODEC_PRIVATE));
        await settle();

        expect(harness.factory).toHaveBeenCalledTimes(2);
        expect(firstSession.destroyed).toBe(true);
    });

    it('replaces the session for a rebuilt version of its package, which keeps the package id', async () => {
        const harness = createHarness();
        startConfigured(harness);
        await settle();
        const firstSession = harness.sessions[0];
        const rebuiltPackage = { ...PACKET_READING_PACKAGE, contentHash: REBUILT_CONTENT_HASH };

        startConfigured(harness, { ...createRequest(), decoder: { ...GPU_VIDEO_DECODER, package: rebuiltPackage } });
        await settle();

        expect(rebuiltPackage.id).toBe(PACKET_READING_PACKAGE.id);
        expect(harness.factory).toHaveBeenCalledTimes(2);
        expect(firstSession.destroyed).toBe(true);
    });

    it('drops a replaced epoch\'s packets with their credits, and resets the decoder for the next epoch', async () => {
        const harness = createHarness();
        startConfigured(harness);
        await settle();
        const session = harness.sessions[0];
        session.freeSlotCount = 0;
        harness.feed.queuePacket(createPacket(0));
        harness.feed.queuePacket(createPacket(1));

        harness.feed.beginVideoEpoch(RESYNCED_VIDEO_EPOCH);

        expect(harness.callbacks.creditsReleased).toBe(2);
        expect(session.resetCount).toBe(1);
        session.freeSlotCount = FAKE_GPU_SLOT_COUNT;
        harness.feed.queuePacket(createPacket(4));
        expect(session.queuedPackets.at(-1)?.reset).toBe(true);
        expect(harness.callbacks.frames.at(-1)?.videoEpoch).toBe(RESYNCED_VIDEO_EPOCH);
    });

    it('reports the video drained once its end arrived and its last frame left the decoder', async () => {
        const harness = createHarness();
        startConfigured(harness);
        await settle();
        harness.feed.queuePacket(createPacket(0));

        // A decoder without a parser ends without output events
        harness.feed.endVideo(null);
        expect(harness.sessions[0].endOfStreamEvents).toEqual([ null ]);
        expect(harness.callbacks.drainedCount).toBe(0);

        harness.queue.completeAll();
        await settle();

        expect(harness.callbacks.frames).toHaveLength(1);
        expect(harness.callbacks.drainedCount).toBe(1);
    });

    it('hands the decoder the output events of the video\'s last packets with its end, once, even when the session comes later', async () => {
        const configured = createHarness();
        startConfigured(configured);
        await settle();
        const unconfigured = createHarness();
        unconfigured.feed.start(unconfigured.callbacks, INITIAL_VIDEO_EPOCH);
        unconfigured.feed.queuePacket(createPacket(0));

        configured.feed.endVideo(TRAILING_OUTPUT_EVENTS);
        configured.feed.endVideo(null);
        unconfigured.feed.endVideo(TRAILING_OUTPUT_EVENTS);
        unconfigured.feed.configure(createRequest(), { displayHeight: VISIBLE_HEIGHT, displayWidth: DISPLAY_WIDTH });
        await settle();

        expect(configured.sessions[0].endOfStreamEvents).toEqual([ TRAILING_OUTPUT_EVENTS ]);
        expect(unconfigured.sessions[0].endOfStreamEvents).toEqual([ TRAILING_OUTPUT_EVENTS ]);
        expect(unconfigured.sessions[0].queuedPackets).toHaveLength(1);
    });

    it('fails the generation with the session\'s failure, naming a decoder error as its decoder does', async () => {
        const harness = createHarness();
        startConfigured(harness);
        await settle();
        harness.sessions[0].failure = { code: 'decoder-error', detail: String(DECODER_ERROR_WORD) };

        harness.feed.queuePacket(createPacket(0));

        expect(harness.callbacks.failures).toEqual([ `decoder-error: ${DESCRIBED_DECODER_ERROR}` ]);
        expect(harness.feed.getTelemetry()).toMatchObject({ failure: `decoder-error: ${DESCRIBED_DECODER_ERROR}`, state: 'failed' });
        // A failed generation takes no more packets
        harness.feed.queuePacket(createPacket(1));
        expect(harness.callbacks.failures).toHaveLength(1);
    });

    it('fails the generation once with the check a submission reports', async () => {
        const harness = createHarness();
        startConfigured(harness);
        await settle();
        harness.feed.queuePacket(createPacket(0));
        harness.sessions[0].failure = PACKET_SIZE_FAILURE;

        harness.queue.completeAll();
        await settle();

        expect(harness.callbacks.failures).toEqual([ `${PACKET_SIZE_FAILURE.code}: ${PACKET_SIZE_FAILURE.detail}` ]);
    });

    it('fails the generation with the check that kept its session from being created', async () => {
        const harness = createHarness();
        harness.factory.mockImplementationOnce((): Promise<GPUVideoDecodeHandle> => Promise.reject(new GPUVideoDecodeError(COMPILE_FAILURE)));

        startConfigured(harness);
        await settle();

        expect(harness.callbacks.failures).toEqual([ `${COMPILE_FAILURE.code}: ${COMPILE_FAILURE.detail}` ]);
    });

    it('destroys a session created after its generation ended for one of another stream', async () => {
        const harness = createHarness();
        startConfigured(harness);
        startConfigured(harness, createRequest(OTHER_CODEC_PRIVATE));
        await settle();

        expect(harness.sessions).toHaveLength(2);
        expect(harness.sessions[0].destroyed).toBe(true);
        expect(harness.sessions[1].destroyed).toBe(false);
        expect(harness.feed.getTelemetry().state).toBe('ready');
    });
});

describe('GPUVideoDecodeFeed stream changes', () => {
    /** Queues the stream's pictures: two of the session's own, then one that changes the stream, with events for the second picture and for itself, and one after it. */
    function queueChangingStream(harness: FeedHarness, change: Partial<GPUVideoDecodeFeedPacket>): void {
        harness.feed.queuePacket(createPacket(0));
        harness.feed.queuePacket(createPacket(1));
        harness.feed.queuePacket({ ...createPacket(CHANGE_PICTURE_INDEX), outputEvents: CHANGE_PICTURE_EVENTS, ...change });
        harness.feed.queuePacket(createPacket(CHANGE_PICTURE_INDEX + 1));
    }

    /** Completes every submission until no decode work remains in flight. */
    async function completeSubmissions(harness: FeedHarness): Promise<void> {
        for (let round = 0; round < SETTLE_ROUND_COUNT; round += 1) {
            harness.queue.completeAll();
            await settle();
        }
    }

    it('decodes the pictures before a format change on their session, then the rest on a session of the new format, numbering on', async () => {
        const harness = createHarness();
        startConfigured(harness);
        await settle();

        queueChangingStream(harness, { format: CHANGED_FORMAT });
        await completeSubmissions(harness);

        expect(harness.requests.map(request => [ request.format, request.stream.bitDepth ])).toEqual([ [ 'I420', 8 ], [ CHANGED_FORMAT, CHANGED_BIT_DEPTH ] ]);
        const [ previousSession, changedSession ] = harness.sessions;
        expect(previousSession.submittedPackets.map(packet => packet.timestampMicroseconds)).toEqual([ getTimestamp(0), getTimestamp(1) ]);
        // The change's events naming earlier pictures apply on the session before it, the rest on its own
        expect(previousSession.endOfStreamEvents).toEqual([ Uint32Array.of(EARLIER_PICTURE_EVENT) ]);
        expect(changedSession.continuedPictureIndex).toBe(CHANGE_PICTURE_INDEX);
        expect(changedSession.submittedPackets.map(packet => [ packet.timestampMicroseconds, packet.reset ])).toEqual([
            [ getTimestamp(CHANGE_PICTURE_INDEX), false ],
            [ getTimestamp(CHANGE_PICTURE_INDEX + 1), false ]
        ]);
        expect(changedSession.submittedPackets[0].outputEvents).toEqual(Uint32Array.of(OWN_PICTURE_EVENT));
        expect(harness.callbacks.frames.map(frame => frame.mediaTimeMicroseconds)).toEqual([ 0, 1, CHANGE_PICTURE_INDEX, CHANGE_PICTURE_INDEX + 1 ].map(getTimestamp));
        expect(harness.callbacks.creditsReleased).toBe(4);
        expect(harness.feed.getTelemetry()).toMatchObject({ streamChangeCount: 1, submittedPacketCount: 4 });
    });

    it('keeps the session before a change until presentation releases its last frame', async () => {
        const harness = createHarness();
        startConfigured(harness);
        await settle();
        queueChangingStream(harness, { format: CHANGED_FORMAT });
        await completeSubmissions(harness);
        const [ previousSession ] = harness.sessions;
        const [ firstFrame, secondFrame ] = harness.callbacks.frames;

        harness.feed.releaseFrame(firstFrame);
        expect(previousSession.destroyed).toBe(false);
        harness.feed.releaseFrame(secondFrame);

        expect(previousSession.releasedFrames).toHaveLength(2);
        expect(previousSession.destroyed).toBe(true);
        expect(harness.sessions[1].destroyed).toBe(false);
    });

    it('makes a session for a sequence larger than the pool, and none for the maximum a session already asked for or a smaller one', async () => {
        const harness = createHarness();
        startConfigured(harness, createRequest(FIRST_CODEC_PRIVATE, OTHER_MAXIMUM_PICTURE_SIZE));
        await settle();

        harness.feed.queuePacket({ ...createPacket(0), maximumPictureSize: OTHER_MAXIMUM_PICTURE_SIZE });
        harness.feed.queuePacket({ ...createPacket(1), maximumPictureSize: SMALLER_MAXIMUM_PICTURE_SIZE });
        harness.feed.queuePacket({ ...createPacket(2), maximumPictureSize: MAXIMUM_PICTURE_SIZE });
        await completeSubmissions(harness);

        expect(harness.requests.map(request => request.maximumPictureSize)).toEqual([ OTHER_MAXIMUM_PICTURE_SIZE, MAXIMUM_PICTURE_SIZE ]);
        expect(harness.requests[1]).toMatchObject({ codecPrivate: FIRST_CODEC_PRIVATE, format: 'I420' });
        expect(harness.sessions[0].submittedPackets).toHaveLength(2);
        expect(harness.sessions[1].submittedPackets).toHaveLength(1);
    });

    it('takes each of two changes in turn, the second session following the first', async () => {
        const harness = createHarness();
        startConfigured(harness);
        await settle();

        harness.feed.queuePacket(createPacket(0));
        harness.feed.queuePacket({ ...createPacket(1), format: CHANGED_FORMAT });
        harness.feed.queuePacket({ ...createPacket(2), format: 'I420' });
        await completeSubmissions(harness);

        expect(harness.requests.map(request => request.format)).toEqual([ 'I420', CHANGED_FORMAT, 'I420' ]);
        expect(harness.sessions.map(session => session.submittedPackets.length)).toEqual([ 1, 1, 1 ]);
        expect(harness.sessions.map(session => session.continuedPictureIndex)).toEqual([ null, 1, 2 ]);
        expect(harness.callbacks.frames.map(frame => frame.mediaTimeMicroseconds)).toEqual([ 0, 1, 2 ].map(getTimestamp));
        expect(harness.feed.getTelemetry().streamChangeCount).toBe(2);
    });

    it('ends the video on the session a pending change makes, not the one before it', async () => {
        const harness = createHarness();
        startConfigured(harness);
        await settle();

        queueChangingStream(harness, { format: CHANGED_FORMAT });
        harness.feed.endVideo(TRAILING_OUTPUT_EVENTS);
        await completeSubmissions(harness);

        const [ previousSession, changedSession ] = harness.sessions;
        expect(previousSession.endOfStreamEvents).toEqual([ Uint32Array.of(EARLIER_PICTURE_EVENT) ]);
        expect(changedSession.endOfStreamEvents).toEqual([ TRAILING_OUTPUT_EVENTS ]);
        expect(harness.callbacks.drainedCount).toBe(1);
    });

    it('drops a pending change and returns its packets\' credits when a new video epoch begins', async () => {
        const harness = createHarness();
        startConfigured(harness);
        await settle();
        const previousSession = harness.sessions[0];
        previousSession.freeSlotCount = 0;

        queueChangingStream(harness, { format: CHANGED_FORMAT });
        await settle();
        harness.feed.beginVideoEpoch(RESYNCED_VIDEO_EPOCH);

        expect(harness.sessions[1].destroyed).toBe(true);
        // Two packets waited in the session before the change, and two for the change
        expect(harness.callbacks.creditsReleased).toBe(4);
        expect(harness.feed.getTelemetry()).toMatchObject({ queuedPacketCount: 0, streamChangeCount: 0 });
    });

    it('fails the generation with the check that kept a change\'s session from being created', async () => {
        const harness = createHarness();
        startConfigured(harness);
        await settle();
        harness.factory.mockImplementationOnce((): Promise<GPUVideoDecodeHandle> => Promise.reject(new GPUVideoDecodeError(FORMAT_FAILURE)));

        queueChangingStream(harness, { format: CHANGED_FORMAT });
        await completeSubmissions(harness);

        expect(harness.callbacks.failures).toEqual([ `${FORMAT_FAILURE.code}: ${FORMAT_FAILURE.detail}` ]);
    });

    it('decodes on through a sequence whose declared maximum the decoder refuses while its pictures fit, making no session for it', async () => {
        const harness = createHarness();
        startConfigured(harness, createBoundedRequest());
        await settle();

        queueChangingStream(harness, { maximumPictureSize: REFUSED_MAXIMUM_PICTURE_SIZE, visibleSize: PICTURE_SIZE });
        await completeSubmissions(harness);

        expect(harness.requests).toHaveLength(1);
        expect(harness.callbacks.failures).toEqual([]);
        expect(harness.sessions[0].submittedPackets).toHaveLength(CHANGE_PICTURE_INDEX + 2);
    });

    it('judges pictures queued while a session is created against the pool the device gave it, and makes a session for one beyond it', async () => {
        const harness = createHarness(SMALL_DEVICE_BUFFER_LIMIT);
        startConfigured(harness, createRequest(FIRST_CODEC_PRIVATE, MAXIMUM_PICTURE_SIZE));
        harness.feed.queuePacket({ ...createPacket(0), maximumPictureSize: MAXIMUM_PICTURE_SIZE, visibleSize: PICTURE_SIZE });
        harness.feed.queuePacket({ ...createPacket(1), maximumPictureSize: MAXIMUM_PICTURE_SIZE, visibleSize: GROWN_PICTURE_SIZE });
        await completeSubmissions(harness);

        // The device refused the declared maximum's pool, so the first session kept the container's, and the larger picture took the pool grown to it
        expect(harness.sessions.map(session => ({ height: session.pool.layout.codedHeight, width: session.pool.layout.codedWidth }))).toEqual([ CODED_POOL, GROWN_PICTURE_POOL ]);
        expect(harness.sessions.map(session => session.submittedPackets.length)).toEqual([ 1, 1 ]);
        expect(harness.sessions[1].continuedPictureIndex).toBe(1);
        expect(harness.callbacks.failures).toEqual([]);
    });

    it('judges pictures queued while a change\'s session is created against its pool once it exists', async () => {
        const harness = createHarness();
        startConfigured(harness);
        await settle();

        harness.feed.queuePacket(createPacket(0));
        harness.feed.queuePacket({ ...createPacket(1), format: CHANGED_FORMAT });
        harness.feed.queuePacket({ ...createPacket(2), format: CHANGED_FORMAT, visibleSize: LARGER_PICTURE_SIZE });
        expect(harness.feed.getTelemetry().queuedPacketCount).toBe(2);
        await completeSubmissions(harness);

        // The third picture waited for the second session, whose pool cannot hold it, so it took a third
        expect(harness.requests.map(request => request.format)).toEqual([ 'I420', CHANGED_FORMAT, CHANGED_FORMAT ]);
        expect(harness.sessions.map(session => session.submittedPackets.length)).toEqual([ 1, 1, 1 ]);
        expect(harness.callbacks.failures).toEqual([]);
    });

    it('fails a change whose every pool the decoder refuses, as accepts', async () => {
        const harness = createHarness();
        startConfigured(harness, createBoundedRequest());
        await settle();

        queueChangingStream(harness, { maximumPictureSize: UNBOUNDED_PICTURE_SIZE, visibleSize: UNBOUNDED_PICTURE_SIZE });
        await completeSubmissions(harness);

        expect(harness.callbacks.failures).toEqual([ UNBOUNDED_PICTURE_FAILURE ]);
        expect(harness.requests).toHaveLength(1);
    });

    describe('getGPUVideoDecodeStreamChange', () => {
        it('asks for nothing while the format holds and the pictures fit', () => {
            expect(getGPUVideoDecodeStreamChange(createRequest(), CODED_POOL, { format: null, maximumPictureSize: null, visibleSize: PICTURE_SIZE })).toBeNull();
            expect(getGPUVideoDecodeStreamChange(createRequest(), CODED_POOL, { format: 'I420', maximumPictureSize: OTHER_MAXIMUM_PICTURE_SIZE, visibleSize: null })).toBeNull();
        });

        it('asks for the new format at its bit depth, keeping the decoder, the codec private data, and the pool to fall back to', () => {
            expect(getGPUVideoDecodeStreamChange(createRequest(), CODED_POOL, { format: CHANGED_FORMAT, maximumPictureSize: null, visibleSize: null })).toEqual({
                ...createRequest(),
                fallbackPictureSize: CODED_POOL,
                format: CHANGED_FORMAT,
                maximumPictureSize: null,
                stream: { ...createRequest().stream, bitDepth: CHANGED_BIT_DEPTH }
            });
        });

        it('asks for a picture\'s own size beyond the pool when its parser reports no maximum', () => {
            expect(getGPUVideoDecodeStreamChange(createRequest(), CODED_POOL, { format: null, maximumPictureSize: null, visibleSize: LARGER_PICTURE_SIZE }))
                .toMatchObject({ fallbackPictureSize: LARGER_PICTURE_SIZE, maximumPictureSize: LARGER_PICTURE_SIZE });
        });

        it('asks for the new sequence alone, falling back to the pool grown to the picture, which the pool before it held as a floor no more', () => {
            const change = getGPUVideoDecodeStreamChange(createBoundedRequest(), CODED_POOL, { format: null, maximumPictureSize: WIDE_SEQUENCE_SIZE, visibleSize: WIDE_SEQUENCE_SIZE });

            expect(change).toMatchObject({ fallbackPictureSize: WIDE_FALLBACK_PICTURE_SIZE, maximumPictureSize: WIDE_SEQUENCE_SIZE });
            // The new sequence alone fits the decoder's picture bound, which the container's height beside it would cross
            expect(change && selectGPUDecodeSessionStream(BOUNDED_PACKAGE.manifest, change.format, change.stream, change.maximumPictureSize, LARGE_BUFFER_LIMIT, change.fallbackPictureSize ?? null))
                .toEqual({ ...change?.stream, codedHeight: WIDE_SEQUENCE_POOL.height, codedWidth: WIDE_SEQUENCE_POOL.width, visibleRectangle: { height: WIDE_SEQUENCE_POOL.height, width: CODED_WIDTH, x: 0, y: 0 } });
        });

        it('asks nothing more for a maximum the session asked for already, which a device or accepts may have refused', () => {
            const request = createRequest(FIRST_CODEC_PRIVATE, REFUSED_MAXIMUM_PICTURE_SIZE);

            expect(getGPUVideoDecodeStreamChange(request, CODED_POOL, { format: null, maximumPictureSize: REFUSED_MAXIMUM_PICTURE_SIZE, visibleSize: PICTURE_SIZE })).toBeNull();
        });

        it('keeps the pool for a declared maximum the decoder refuses while the pictures fit, and asks for one it takes', () => {
            const packet = { format: null, maximumPictureSize: REFUSED_MAXIMUM_PICTURE_SIZE, visibleSize: PICTURE_SIZE };

            expect(getGPUVideoDecodeStreamChange(createBoundedRequest(), CODED_POOL, packet)).toBeNull();
            expect(getGPUVideoDecodeStreamChange(createRequest(), CODED_POOL, packet)).toMatchObject({ maximumPictureSize: REFUSED_MAXIMUM_PICTURE_SIZE });
        });

        it('asks for the pool grown to a picture beyond it when the decoder refuses its declared maximum', () => {
            const change = getGPUVideoDecodeStreamChange(createBoundedRequest(), CODED_POOL, { format: null, maximumPictureSize: REFUSED_MAXIMUM_PICTURE_SIZE, visibleSize: GROWN_PICTURE_SIZE });

            expect(change).toMatchObject({ fallbackPictureSize: GROWN_PICTURE_SIZE, maximumPictureSize: REFUSED_MAXIMUM_PICTURE_SIZE });
            expect(change && selectGPUDecodeSessionStream(BOUNDED_PACKAGE.manifest, change.format, change.stream, change.maximumPictureSize, LARGE_BUFFER_LIMIT, change.fallbackPictureSize ?? null))
                .toMatchObject({ codedHeight: GROWN_PICTURE_POOL.height, codedWidth: GROWN_PICTURE_POOL.width });
        });
    });
});
