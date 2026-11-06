import { EncodedPacket } from 'mediabunny';
import { describe, expect, it, vi, type Mock } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';
import { clearTimingTrace, exportTimingTrace, startTimingTrace } from 'webgpu-player/TimingTrace';
import type { RawVideoFrameGeometry } from 'webgpu-player/decode/video/RawVideoFrameCopy';
import HDR10PlusFrameMetadataQueue from 'webgpu-player/decode/video/HDR10PlusFrameMetadataQueue';
import {
    createOwnedVideoFrameMetadataSource,
    OWNED_VIDEO_DECODE_FENCE_TIMEOUT_MILLISECONDS,
    OWNED_VIDEO_PACKET_PACING_MILLISECONDS,
    OWNED_VIDEO_PREROLL_BATCH_FRAME_COUNT,
    OwnedVideoStreamState,
    runOwnedSingleLayerVideoStream,
    type OwnedDecodedVideoOutput,
    type OwnedDecodedVideoSource,
    type OwnedVideoDecoderPort,
    type OwnedVideoFrameMetadata,
    type OwnedVideoFrameMetadataSource,
    type OwnedVideoStreamRun,
    type ProcessedOwnedVideoPacket
} from 'webgpu-player/decode/video/native/OwnedVideoDecodeStream';
import type { VideoDecodeFence } from 'webgpu-player/decode/video/native/VideoDecodeFence';

import {
    AMPLE_FRAME_CREDITS,
    createFramePacket,
    createOwnedVideoStreamFakes,
    FakeStreamRun,
    FRAME_DURATION_MICROSECONDS as FAKE_FRAME_DURATION_MICROSECONDS,
    KEY_PACKET_MEDIA_TIME_MICROSECONDS,
    settle,
    type FakeVideoFrame as FakeStreamVideoFrame,
    type OwnedVideoStreamFakes
} from '../../../helpers/ownedVideoStreamFakes';

const FRAME_DURATION_MICROSECONDS = 31_250;
const FRAME_GEOMETRY: RawVideoFrameGeometry = {
    codedHeight: 1_080,
    codedWidth: 1_920,
    displayHeight: 1_080,
    displayWidth: 1_920
};
// EL dimensions that differ from the stream's first EL
const MISMATCHED_ENHANCEMENT_CODED_WIDTH = 960;
const MISMATCHED_ENHANCEMENT_DISPLAY_HEIGHT = 540;

class FakeVideoFrame {
    public readonly close = vi.fn();
    public readonly duration = FRAME_DURATION_MICROSECONDS;

    public constructor(
        public readonly timestamp: number,
        // The DOM VideoPixelFormat type has no high-bit-depth formats
        public readonly format: string | null
    ) {}
}

type StateHarness = {
    frameMetadata: OwnedVideoFrameMetadataSource & {
        requireDrained: Mock
        takeFrameMetadata: Mock
    }
    postedPairs: Array<[OwnedDecodedVideoOutput, OwnedDecodedVideoOutput | null]>
    state: OwnedVideoStreamState
};

function createHarness(
    hasEnhancementLayer: boolean,
    enhancementGeometry: RawVideoFrameGeometry = FRAME_GEOMETRY,
    startTimeMicroseconds = 0,
    presentationIntervalMicroseconds: Microseconds | null = null
): StateHarness {
    const postedPairs: Array<[OwnedDecodedVideoOutput, OwnedDecodedVideoOutput | null]> = [];
    const stream: OwnedVideoStreamRun = {
        getPresentationIntervalMicroseconds: (): Microseconds | null => presentationIntervalMicroseconds,
        isStopped: (): boolean => false,
        notifyDecoderProgress: vi.fn(),
        postFrame: async (
            output: OwnedDecodedVideoOutput,
            enhancementOutput: OwnedDecodedVideoOutput | null
        ): Promise<void> => {
            postedPairs.push([ output, enhancementOutput ]);
        },
        postStartupProgress: vi.fn(),
        sleep: async (): Promise<void> => undefined,
        waitForDecoderProgress: async (): Promise<void> => undefined,
        waitForFrameCredit: async (): Promise<boolean> => true
    };
    const frameMetadata = {
        clear: vi.fn(),
        requireDrained: vi.fn(),
        takeFrameMetadata: vi.fn((): { encodedDolbyVisionMetadata: null } => ({
            encodedDolbyVisionMetadata: null
        }))
    };
    return {
        frameMetadata,
        postedPairs,
        state: new OwnedVideoStreamState(
            stream,
            frameMetadata,
            startTimeMicroseconds as Microseconds,
            hasEnhancementLayer ? enhancementGeometry : null
        )
    };
}

function createFrameSource(
    timestampMicroseconds: number,
    format: string | null = 'I420P10',
    geometry: RawVideoFrameGeometry = FRAME_GEOMETRY
): OwnedDecodedVideoSource {
    return {
        frame: new FakeVideoFrame(timestampMicroseconds, format) as unknown as VideoFrame,
        geometry,
        kind: 'native-frame'
    };
}

function getFrame(output: OwnedDecodedVideoOutput | OwnedDecodedVideoSource | null): FakeVideoFrame | null {
    const source = output && 'source' in output ? output.source : output;
    return source?.kind === 'native-frame' ? source.frame as unknown as FakeVideoFrame : null;
}

function createDecoder(packetAccepted: boolean): OwnedVideoDecoderPort & { decode: Mock } {
    return {
        close: vi.fn(),
        decode: vi.fn((): boolean => packetAccepted),
        flush: vi.fn(async (): Promise<void> => undefined),
        getDecodeQueueSize: (): number => 0,
        init: vi.fn(async (): Promise<void> => undefined)
    };
}

function createPacket(timestampMicroseconds: number): EncodedPacket {
    return new EncodedPacket(new Uint8Array([ 1 ]), 'key', timestampMicroseconds / 1_000_000, 0);
}

function createTimedPacket(timestampMicroseconds: number, durationMicroseconds: number): EncodedPacket {
    return new EncodedPacket(new Uint8Array([ 1 ]), 'delta', timestampMicroseconds / 1_000_000, durationMicroseconds / 1_000_000);
}

// Two and a half frame durations, as at 2.5x on a display that refreshes once a frame duration
const DECIMATION_INTERVAL_MICROSECONDS = ((5 * FRAME_DURATION_MICROSECONDS) / 2) as Microseconds;

// A demuxed packet's bytes, of which a processed packet may keep the leading one
const SOURCE_PACKET_BYTES = [ 1, 2 ];
const LEADING_BYTE_LENGTH = 1;

describe('OwnedVideoStreamState', () => {
    it('gives back the metadata of a frame its decoder drops', () => {
        const harness = createHarness(false);
        const packet = createPacket(FRAME_DURATION_MICROSECONDS);

        harness.state.decodeBasePacket(packet, packet, true, createDecoder(true));
        harness.state.decodeBasePacket(packet, packet, false, createDecoder(false));
        expect(harness.frameMetadata.takeFrameMetadata).not.toHaveBeenCalled();
        harness.state.decodeBasePacket(packet, packet, true, createDecoder(false));
        expect(harness.frameMetadata.takeFrameMetadata).toHaveBeenCalledExactlyOnceWith(
            FRAME_DURATION_MICROSECONDS
        );

        const decoder = createDecoder(true);
        harness.state.decodeBasePacket(packet, null, true, decoder);
        expect(decoder.decode).not.toHaveBeenCalled();
    });

    it('lets the decoder transfer only a buffer the packet processing allocated', () => {
        const harness = createHarness(false);
        const sourcePacket = new EncodedPacket(new Uint8Array(SOURCE_PACKET_BYTES), 'key', 0, 0);
        const decoder = createDecoder(true);

        harness.state.decodeBasePacket(sourcePacket, sourcePacket, true, decoder);
        harness.state.decodeBasePacket(
            sourcePacket,
            sourcePacket.clone({ data: sourcePacket.data.subarray(0, LEADING_BYTE_LENGTH) }),
            true,
            decoder
        );
        harness.state.decodeBasePacket(
            sourcePacket,
            sourcePacket.clone({ data: sourcePacket.data.slice(0, LEADING_BYTE_LENGTH) }),
            true,
            decoder
        );

        expect(decoder.decode.mock.calls.map((call: unknown[]): unknown => call[1])).toEqual([ false, false, true ]);
    });

    it('skips an unreferenced picture that ends by the start time and gives back its metadata', () => {
        const harness = createHarness(false, FRAME_GEOMETRY, 2 * FRAME_DURATION_MICROSECONDS);
        const decoder = createDecoder(true);
        const decodeFrame = (frameIndex: number, unreferencedPicture: boolean, durationMicroseconds = FRAME_DURATION_MICROSECONDS): string => {
            const packet = createTimedPacket(frameIndex * FRAME_DURATION_MICROSECONDS, durationMicroseconds);
            return harness.state.decodeBasePacket(packet, packet, true, decoder, unreferencedPicture);
        };

        // The second frame ends at the start time itself
        expect([ decodeFrame(0, true), decodeFrame(1, true) ]).toEqual([ 'skipped', 'skipped' ]);
        expect(harness.frameMetadata.takeFrameMetadata.mock.calls).toEqual([ [ 0 ], [ FRAME_DURATION_MICROSECONDS ] ]);
        expect(decoder.decode).not.toHaveBeenCalled();

        // A referenced picture, one that covers the start, and one without a duration, which never provably ends before it, all decode
        expect([ decodeFrame(1, false), decodeFrame(2, true), decodeFrame(0, true, 0) ]).toEqual([ 'decoded', 'decoded', 'decoded' ]);
        expect(decoder.decode).toHaveBeenCalledTimes(3);
        expect(harness.frameMetadata.takeFrameMetadata).toHaveBeenCalledTimes(2);
    });

    it('skips an unreferenced picture after the first presented frame that no multiple of the presentation interval falls within', () => {
        const harness = createHarness(false, FRAME_GEOMETRY, 0, DECIMATION_INTERVAL_MICROSECONDS);
        const decoder = createDecoder(true);
        const decodeFrame = (frameIndex: number, unreferencedPicture = true): string => {
            const packet = createTimedPacket(frameIndex * FRAME_DURATION_MICROSECONDS, FRAME_DURATION_MICROSECONDS);
            return harness.state.decodeBasePacket(packet, packet, true, decoder, unreferencedPicture);
        };

        // Before the first presented frame is known, any picture may present first
        expect(decodeFrame(1)).toBe('decoded');
        harness.state.enqueueDecodedOutput(createFrameSource(0));
        expect([ decodeFrame(1), decodeFrame(2), decodeFrame(3), decodeFrame(4, false) ]).toEqual([ 'skipped', 'decoded', 'skipped', 'decoded' ]);
        expect(harness.frameMetadata.takeFrameMetadata.mock.calls.slice(1)).toEqual([
            [ FRAME_DURATION_MICROSECONDS ],
            [ 3 * FRAME_DURATION_MICROSECONDS ]
        ]);
    });

    it('skips nothing while it decodes an EL, whose frames pair with every BL frame', () => {
        const harness = createHarness(true, FRAME_GEOMETRY, 2 * FRAME_DURATION_MICROSECONDS, DECIMATION_INTERVAL_MICROSECONDS);
        const packet = createTimedPacket(0, FRAME_DURATION_MICROSECONDS);

        expect(harness.state.decodeBasePacket(packet, packet, true, createDecoder(true), true)).toBe('decoded');
        harness.state.recordEnhancementDecoderFailure();
        expect(harness.state.decodeBasePacket(packet, packet, true, createDecoder(true), true)).toBe('skipped');
    });

    it('drains its packets\' metadata when the track ends after a skipped picture', async () => {
        const dynamicHDRMetadataQueue = new HDR10PlusFrameMetadataQueue('HEVC');
        const state = new OwnedVideoStreamState(
            new FakeStreamRun(AMPLE_FRAME_CREDITS),
            createOwnedVideoFrameMetadataSource(null, dynamicHDRMetadataQueue),
            (2 * FRAME_DURATION_MICROSECONDS) as Microseconds,
            null
        );
        const decoder = createDecoder(true);
        const decodeResults = [ 0, 1, 2 ].map((frameIndex: number): string => {
            const packet = createTimedPacket(frameIndex * FRAME_DURATION_MICROSECONDS, FRAME_DURATION_MICROSECONDS);
            dynamicHDRMetadataQueue.enqueue(packet.microsecondTimestamp, { metadata: null, status: 'absent' });
            return state.decodeBasePacket(packet, packet, true, decoder, true);
        });
        state.enqueueDecodedOutput(createFrameSource(2 * FRAME_DURATION_MICROSECONDS));

        expect(decodeResults).toEqual([ 'skipped', 'skipped', 'decoded' ]);
        await expect(state.finishPackets(decoder, null)).resolves.toBeUndefined();
        state.close();
    });

    it('posts each BL frame with the EL frame of its timestamp', async () => {
        const harness = createHarness(true);
        const baseSource = createFrameSource(0);
        const enhancementSource = createFrameSource(0);

        harness.state.enqueueEnhancementDecodedOutput(enhancementSource);
        harness.state.enqueueDecodedOutput(baseSource);

        expect(await harness.state.postNextOutput()).toBe('posted');
        expect(harness.postedPairs).toHaveLength(1);
        expect(getFrame(harness.postedPairs[0][0])).toBe(getFrame(baseSource));
        expect(getFrame(harness.postedPairs[0][1])).toBe(getFrame(enhancementSource));
        expect(harness.frameMetadata.takeFrameMetadata).toHaveBeenCalledExactlyOnceWith(0);
    });

    it('releases a BL frame waiting for its EL when the track ends', async () => {
        const harness = createHarness(true);
        const baseSource = createFrameSource(0);
        harness.state.enqueueDecodedOutput(baseSource);

        expect(await harness.state.postNextOutput()).toBe('none');
        await harness.state.finishPackets(createDecoder(true), createDecoder(true));
        expect(await harness.state.postNextOutput()).toBe('posted');

        expect(harness.postedPairs[0][1]).toBeNull();
        expect(harness.frameMetadata.requireDrained).toHaveBeenCalledOnce();
        expect(harness.state.packetsEnded).toBe(true);
    });

    it('leaves the stream to its BL once the EL decoder refuses a picture', async () => {
        const harness = createHarness(true);
        const enhancementPacket = createPacket(0);

        harness.state.decodeEnhancementPacket(enhancementPacket, true, createDecoder(false));
        expect(harness.state.canDecodeEnhancement()).toBe(false);
        harness.state.enqueueDecodedOutput(createFrameSource(0));
        const lateEnhancementSource = createFrameSource(0);
        harness.state.enqueueEnhancementDecodedOutput(lateEnhancementSource);

        expect(await harness.state.postNextOutput()).toBe('posted');
        expect(harness.postedPairs[0][1]).toBeNull();
        expect(getFrame(lateEnhancementSource)?.close).toHaveBeenCalledOnce();
    });

    it.each([
        { format: 'I420', geometry: FRAME_GEOMETRY, label: 'an 8-bit format' },
        {
            format: null,
            geometry: { ...FRAME_GEOMETRY, codedWidth: MISMATCHED_ENHANCEMENT_CODED_WIDTH },
            label: 'another coded width'
        },
        {
            format: 'I420P10',
            geometry: { ...FRAME_GEOMETRY, displayHeight: MISMATCHED_ENHANCEMENT_DISPLAY_HEIGHT },
            label: 'another display height'
        }
    ] as const)('leaves the stream to its BL once an EL arrives in $label', async ({ format, geometry }) => {
        const harness = createHarness(true);
        const enhancementSource = createFrameSource(0, format, geometry);

        harness.state.enqueueEnhancementDecodedOutput(enhancementSource);
        harness.state.enqueueDecodedOutput(createFrameSource(0));

        // The compound copy would refuse such an EL, so it is closed here and every later frame posts without one
        expect(getFrame(enhancementSource)?.close).toHaveBeenCalledOnce();
        expect(harness.state.canDecodeEnhancement()).toBe(false);
        expect(await harness.state.postNextOutput()).toBe('posted');
        expect(harness.postedPairs[0][1]).toBeNull();
    });

    it('pairs an EL whose decoder reports no format', async () => {
        const harness = createHarness(true);
        const enhancementSource = createFrameSource(0, null);

        harness.state.enqueueEnhancementDecodedOutput(enhancementSource);
        harness.state.enqueueDecodedOutput(createFrameSource(0));

        // An opaque format leaves the requested copy format to decide, as it does for the BL
        expect(await harness.state.postNextOutput()).toBe('posted');
        expect(getFrame(harness.postedPairs[0][1])).toBe(getFrame(enhancementSource));
    });

    it('surfaces a recorded decoder failure before posting another frame', async () => {
        const harness = createHarness(false);
        const decoderFailure = new Error('decoder failed');
        harness.state.enqueueDecodedOutput(createFrameSource(0));

        harness.state.recordDecoderFailure(decoderFailure);
        harness.state.recordDecoderFailure(new Error('later failure'));

        await expect(harness.state.postNextOutput()).rejects.toBe(decoderFailure);
        expect(harness.postedPairs).toHaveLength(0);
        harness.state.close();
        expect(harness.frameMetadata.clear).toHaveBeenCalledOnce();
    });
});

const PACED_PACKET_COUNT = 4;
const START_TIME_MICROSECONDS = 0 as Microseconds;

const pacedFrameMetadata: OwnedVideoFrameMetadataSource = {
    clear: (): void => undefined,
    requireDrained: (): void => undefined,
    takeFrameMetadata: (): OwnedVideoFrameMetadata => ({ encodedDolbyVisionMetadata: null })
};

async function processPacketWithoutMetadata(packet: EncodedPacket): Promise<ProcessedOwnedVideoPacket> {
    return { decoderPacket: packet, hasFrame: true };
}

function createPacedStream(): { fakes: OwnedVideoStreamFakes, streamPromise: Promise<void> } {
    const packets = Array.from(
        { length: PACED_PACKET_COUNT },
        (_value: unknown, frameIndex: number): EncodedPacket => createFramePacket(frameIndex, [ frameIndex ])
    );
    // A held decoder returns its frames only when released, as a hardware decoder returns them some time after taking the packets
    const fakes = createOwnedVideoStreamFakes(packets, AMPLE_FRAME_CREDITS, 'held');
    fakes.run.holdSleeps = true;
    const streamPromise = runOwnedSingleLayerVideoStream(
        fakes.run,
        fakes.packetIterator,
        pacedFrameMetadata,
        processPacketWithoutMetadata,
        fakes.createDecoder,
        START_TIME_MICROSECONDS,
        KEY_PACKET_MEDIA_TIME_MICROSECONDS
    );
    return { fakes, streamPromise };
}

describe('pumpOwnedVideoFrames pacing', () => {
    it('waits for each packet\'s frame before it reads the next packet', async () => {
        const { fakes, streamPromise } = createPacedStream();

        await settle();
        expect(fakes.packetIterator.nextCallCount).toBe(1);
        fakes.requireDecoder().releaseHeldFrames();
        await settle();
        expect(fakes.run.postedFrames).toHaveLength(1);
        expect(fakes.packetIterator.nextCallCount).toBe(2);

        fakes.run.holdSleeps = false;
        fakes.run.releaseSleeps();
        await streamPromise;
        expect(fakes.run.postedFrames.map(postedFrame => postedFrame.mediaTimeMicroseconds)).toEqual(
            Array.from({ length: PACED_PACKET_COUNT }, (_value: unknown, frameIndex: number): number => (
                frameIndex * FAKE_FRAME_DURATION_MICROSECONDS
            ))
        );
        expect(new Set(fakes.run.sleepDurations)).toEqual(new Set([ OWNED_VIDEO_PACKET_PACING_MILLISECONDS ]));
    });

    it('gives a decoder that holds its frames the next packet once the pacing bound passes', async () => {
        const { fakes, streamPromise } = createPacedStream();

        await settle();
        expect(fakes.packetIterator.nextCallCount).toBe(1);
        fakes.run.releaseSleeps();
        await settle();
        expect(fakes.packetIterator.nextCallCount).toBe(2);
        expect(fakes.run.postedFrames).toHaveLength(0);

        fakes.run.stop();
        await streamPromise;
        expect(fakes.requireDecoder().close).toHaveBeenCalledOnce();
    });

    it('records each frame the decoder returns while a timing trace runs', async () => {
        startTimingTrace();
        try {
            const { fakes, streamPromise } = createPacedStream();
            fakes.run.holdSleeps = false;
            fakes.run.releaseSleeps();
            fakes.requireDecoder().releaseHeldFrames();
            await streamPromise;

            const decodedTimes = exportTimingTrace()?.events
                .filter(event => event.kind === 'video-decoded')
                .map(event => event.fields.mediaTimeMicroseconds);
            expect(decodedTimes).toEqual(fakes.run.postedFrames.map(postedFrame => postedFrame.mediaTimeMicroseconds));
        } finally {
            clearTimingTrace();
        }
    });
});

// A preroll of eleven frames before a start just after frame 10, then three frames from the start
const PREROLL_PACKET_COUNT = 14;
const PREROLL_LEADING_FRAME_INDEX = 10;
const PREROLL_START_TIME_MICROSECONDS = ((PREROLL_LEADING_FRAME_INDEX * FAKE_FRAME_DURATION_MICROSECONDS) + 1) as Microseconds;

/** A decode fence whose waits end only when the test completes them, oldest first, as the GPU finishes decode work in order. */
type HeldDecodeFence = {
    complete: () => void
    fence: VideoDecodeFence
    frames: FakeStreamVideoFrame[]
    prewarm: Mock
};

function createHeldDecodeFence(): HeldDecodeFence {
    const completions: Array<() => void> = [];
    const frames: FakeStreamVideoFrame[] = [];
    const prewarm = vi.fn();
    return {
        complete: (): void => {
            completions.shift()?.();
        },
        fence: {
            destroy: vi.fn(),
            prewarm,
            wait: (frame: VideoFrame): Promise<void> => {
                const fakeFrame = frame as unknown as FakeStreamVideoFrame;
                frames.push(fakeFrame);
                return new Promise<void>(resolve => {
                    completions.push((): void => {
                        fakeFrame.close();
                        resolve();
                    });
                });
            }
        },
        frames,
        prewarm
    };
}

function createPrerollStream(
    decodeFence: VideoDecodeFence,
    startTimeMicroseconds: Microseconds = PREROLL_START_TIME_MICROSECONDS
): { fakes: OwnedVideoStreamFakes, streamPromise: Promise<void> } {
    const packets = Array.from(
        { length: PREROLL_PACKET_COUNT },
        (_value: unknown, frameIndex: number): EncodedPacket => createFramePacket(frameIndex, [ frameIndex ])
    );
    const fakes = createOwnedVideoStreamFakes(packets, AMPLE_FRAME_CREDITS);
    fakes.run.decodeFence = decodeFence;
    const streamPromise = runOwnedSingleLayerVideoStream(
        fakes.run,
        fakes.packetIterator,
        pacedFrameMetadata,
        processPacketWithoutMetadata,
        fakes.createDecoder,
        startTimeMicroseconds,
        KEY_PACKET_MEDIA_TIME_MICROSECONDS
    );
    return { fakes, streamPromise };
}

function getFrameIndices(frames: readonly { timestamp: number }[]): number[] {
    return frames.map((frame: { timestamp: number }): number => frame.timestamp / FAKE_FRAME_DURATION_MICROSECONDS);
}

describe('pumpOwnedVideoFrames preroll batches', () => {
    it('keeps the decoder at most two batches ahead of the GPU, and posts the frame that ends the preroll once the GPU decoded it', async () => {
        const heldFence = createHeldDecodeFence();
        const { fakes, streamPromise } = createPrerollStream(heldFence.fence);
        // Held sleeps keep each fence's bound from passing
        fakes.run.holdSleeps = true;

        await settle();
        expect(heldFence.prewarm).toHaveBeenCalledOnce();
        // Two batches are out, so the packet after them waits for the first batch's decode
        expect(fakes.packetIterator.nextCallCount).toBe(2 * OWNED_VIDEO_PREROLL_BATCH_FRAME_COUNT);
        expect(getFrameIndices(heldFence.frames)).toEqual([ OWNED_VIDEO_PREROLL_BATCH_FRAME_COUNT - 1, (2 * OWNED_VIDEO_PREROLL_BATCH_FRAME_COUNT) - 1 ]);

        heldFence.complete();
        await settle();
        // The preroll ends at the first frame after the start, and its leading frame waits for the GPU before it posts
        expect(fakes.packetIterator.nextCallCount).toBe(PREROLL_LEADING_FRAME_INDEX + 2);
        expect(getFrameIndices(heldFence.frames).at(-1)).toBe(PREROLL_LEADING_FRAME_INDEX);
        expect(fakes.run.postedFrames).toHaveLength(0);

        heldFence.complete();
        await settle();
        expect(fakes.run.postedFrames).toHaveLength(0);
        heldFence.complete();
        fakes.run.holdSleeps = false;
        fakes.run.releaseSleeps();
        await streamPromise;

        expect(getFrameIndices(fakes.run.postedFrames.map(postedFrame => ({ timestamp: postedFrame.mediaTimeMicroseconds }))))
            .toEqual([ 10, 11, 12, 13 ]);
        // The fence closes the clones it took; the stream closes every decoded frame, posted or dropped
        for (const frame of [ ...heldFence.frames, ...fakes.requireDecoder().frames ]) {
            expect(frame.close).toHaveBeenCalledOnce();
        }
    });

    it('reads on once a fence\'s bound passes, so a GPU that never reports its work done only ends the batching', async () => {
        const heldFence = createHeldDecodeFence();
        const { fakes, streamPromise } = createPrerollStream(heldFence.fence);

        await streamPromise;

        expect(fakes.run.sleepDurations).toContain(OWNED_VIDEO_DECODE_FENCE_TIMEOUT_MILLISECONDS);
        expect(fakes.packetIterator.nextCallCount).toBe(PREROLL_PACKET_COUNT + 1);
        expect(fakes.run.postedFrames).toHaveLength(PREROLL_PACKET_COUNT - PREROLL_LEADING_FRAME_INDEX);
    });

    it('neither creates nor waits on a fence for an attempt that starts at its key packet', async () => {
        const heldFence = createHeldDecodeFence();
        const { fakes, streamPromise } = createPrerollStream(heldFence.fence, KEY_PACKET_MEDIA_TIME_MICROSECONDS);

        await streamPromise;

        expect(heldFence.prewarm).not.toHaveBeenCalled();
        expect(heldFence.frames).toHaveLength(0);
        expect(fakes.run.postedFrames).toHaveLength(PREROLL_PACKET_COUNT);
    });

    it('records each wait for the GPU\'s decode while a timing trace runs', async () => {
        startTimingTrace();
        try {
            const heldFence = createHeldDecodeFence();
            const { fakes, streamPromise } = createPrerollStream(heldFence.fence);
            fakes.run.holdSleeps = true;
            await settle();
            heldFence.complete();
            await settle();
            heldFence.complete();
            heldFence.complete();
            fakes.run.holdSleeps = false;
            fakes.run.releaseSleeps();
            await streamPromise;

            const fenceCounts = exportTimingTrace()?.events
                .filter(event => event.kind === 'video-decode-fence')
                .map(event => event.fields.fenceCount);
            // The batch wait takes the oldest fence; the first post takes the remaining one with the leading frame's
            expect(fenceCounts).toEqual([ 1, 2 ]);
        } finally {
            clearTimingTrace();
        }
    });
});

// Sixteen frames whose presentation samples the media every two and a half frame durations, as at 2.5x on a display that refreshes once a frame duration
const DECIMATION_PACKET_COUNT = 16;
const DECIMATION_GRID_FRAME_INDICES = [ 0, 2, 5, 7, 10, 12, 15 ];
const DECIMATED_FRAME_INDICES = [ 1, 3, 4, 6, 8, 9, 11, 13, 14 ];

function createDecimatedStream(
    presentationIntervalMicroseconds: Microseconds | null,
    startTimeMicroseconds: Microseconds = KEY_PACKET_MEDIA_TIME_MICROSECONDS
): { fakes: OwnedVideoStreamFakes, streamPromise: Promise<void> } {
    const packets = Array.from(
        { length: DECIMATION_PACKET_COUNT },
        (_value: unknown, frameIndex: number): EncodedPacket => createFramePacket(frameIndex, [ frameIndex ])
    );
    const fakes = createOwnedVideoStreamFakes(packets, AMPLE_FRAME_CREDITS);
    fakes.run.presentationIntervalMicroseconds = presentationIntervalMicroseconds;
    const streamPromise = runOwnedSingleLayerVideoStream(
        fakes.run,
        fakes.packetIterator,
        pacedFrameMetadata,
        processPacketWithoutMetadata,
        fakes.createDecoder,
        startTimeMicroseconds,
        KEY_PACKET_MEDIA_TIME_MICROSECONDS
    );
    return { fakes, streamPromise };
}

function getPostedFrameIndices(fakes: OwnedVideoStreamFakes): number[] {
    return getFrameIndices(fakes.run.postedFrames.map(postedFrame => ({ timestamp: postedFrame.mediaTimeMicroseconds })));
}

describe('pumpOwnedVideoFrames decimation', () => {
    it('posts only the frames a multiple of the presentation interval falls within, and closes the others without spending a credit', async () => {
        const { fakes, streamPromise } = createDecimatedStream(DECIMATION_INTERVAL_MICROSECONDS);

        await streamPromise;

        expect(getPostedFrameIndices(fakes)).toEqual(DECIMATION_GRID_FRAME_INDICES);
        for (const frame of fakes.requireDecoder().frames) {
            expect(frame.close).toHaveBeenCalledOnce();
        }
        // Besides each posted frame's credit, the attempt takes one to read the end of the track
        expect(AMPLE_FRAME_CREDITS - fakes.run.getRemainingCredits()).toBe(DECIMATION_GRID_FRAME_INDICES.length + 1);
    });

    it('keeps the attempt\'s first presented frame though no multiple of the interval falls within it', async () => {
        const { fakes, streamPromise } = createDecimatedStream(DECIMATION_INTERVAL_MICROSECONDS, FAKE_FRAME_DURATION_MICROSECONDS);

        await streamPromise;

        expect(getPostedFrameIndices(fakes)).toEqual([ 1, ...DECIMATION_GRID_FRAME_INDICES.slice(1) ]);
    });

    it('posts every frame without an interval', async () => {
        const { fakes, streamPromise } = createDecimatedStream(null);

        await streamPromise;

        expect(fakes.run.postedFrames).toHaveLength(DECIMATION_PACKET_COUNT);
        expect(AMPLE_FRAME_CREDITS - fakes.run.getRemainingCredits()).toBe(DECIMATION_PACKET_COUNT + 1);
    });

    it('fences every fourth decimated frame and keeps the decoder at most two such batches ahead of the GPU', async () => {
        const heldFence = createHeldDecodeFence();
        const { fakes, streamPromise } = createDecimatedStream(DECIMATION_INTERVAL_MICROSECONDS);
        fakes.run.decodeFence = heldFence.fence;
        // Held sleeps keep each fence's bound from passing
        fakes.run.holdSleeps = true;

        await settle();
        // The fourth and eighth decimated frames started fences, so the packet after the eighth waits for the first fence
        expect(getFrameIndices(heldFence.frames)).toEqual([ DECIMATED_FRAME_INDICES[3], DECIMATED_FRAME_INDICES[7] ]);
        expect(fakes.packetIterator.nextCallCount).toBe(DECIMATED_FRAME_INDICES[7] + 1);
        expect(heldFence.prewarm).not.toHaveBeenCalled();

        heldFence.complete();
        fakes.run.holdSleeps = false;
        fakes.run.releaseSleeps();
        await streamPromise;

        expect(fakes.packetIterator.nextCallCount).toBe(DECIMATION_PACKET_COUNT + 1);
        expect(getPostedFrameIndices(fakes)).toEqual(DECIMATION_GRID_FRAME_INDICES);
        heldFence.complete();
        for (const frame of [ ...heldFence.frames, ...fakes.requireDecoder().frames ]) {
            expect(frame.close).toHaveBeenCalledOnce();
        }
    });

    it('records each decimated frame while a timing trace runs', async () => {
        startTimingTrace();
        try {
            const { streamPromise } = createDecimatedStream(DECIMATION_INTERVAL_MICROSECONDS);
            await streamPromise;

            const decimatedTimes = exportTimingTrace()?.events
                .filter(event => event.kind === 'video-frame-decimated')
                .map(event => event.fields.mediaTimeMicroseconds);
            expect(decimatedTimes).toEqual(DECIMATED_FRAME_INDICES.map((frameIndex: number): number => frameIndex * FAKE_FRAME_DURATION_MICROSECONDS));
        } finally {
            clearTimingTrace();
        }
    });
});
