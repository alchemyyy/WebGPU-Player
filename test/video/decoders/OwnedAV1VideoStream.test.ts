import { EncodedPacket } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';
import { runOwnedAV1VideoStream } from 'webgpu-player/video/decoders/OwnedAV1VideoStream';
import type {
    OwnedDecodedVideoOutput,
    OwnedVideoDecoderCallbacks,
    OwnedVideoDecoderPort,
    OwnedVideoPacketIterator,
    OwnedVideoStreamProgressPhase,
    OwnedVideoStreamRun
} from 'webgpu-player/video/decoders/OwnedVideoDecodeStream';
import type { DolbyVisionEncodedFrameMetadata } from 'webgpu-player/video/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import { createDolbyVisionAuthorizationRPUVector } from 'webgpu-player/capability/vectors/DolbyVisionAuthorizationVector';

const OBU_HAS_SIZE_FIELD_FLAG = 0x02;
const OBU_TYPE_SEQUENCE_HEADER = 1;
const OBU_TYPE_METADATA = 5;
const OBU_TYPE_FRAME = 6;
const METADATA_TYPE_ITUT_T35 = 4;
// Country code, Dolby's provider code and oriented code, then the start of an EMDF container
const DOLBY_VISION_T35_HEADER = [ 0xB5, 0x00, 0x3B, 0x00, 0x00, 0x08, 0x00, 0x37, 0xCD, 0x08 ];
// A power-of-two frame rate keeps every timestamp exact in seconds and in microseconds
const FRAMES_PER_SECOND = 32;
const FRAME_DURATION_MICROSECONDS = 31_250 as Microseconds;
const KEY_PACKET_MEDIA_TIME_MICROSECONDS = 0 as Microseconds;
const AMPLE_FRAME_CREDITS = 64;
// Half the pair queue's bound of 16 frames
const DECODE_QUEUE_HIGH_WATER_MARK = 8;

type PostedFrame = {
    frame: FakeVideoFrame
    mediaTimeMicroseconds: number
    metadata: DolbyVisionEncodedFrameMetadata | null
};

type DecoderOutputMode = 'immediate' | 'held';

class FakeVideoFrame {
    public readonly close = vi.fn();
    public readonly codedHeight = 2_160;
    public readonly codedWidth = 3_840;
    public readonly displayHeight = 2_160;
    public readonly displayWidth = 3_840;

    public constructor(
        public readonly timestamp: number,
        public readonly duration: number
    ) {}
}

function wakeWaiters(waiters: Array<() => void>): void {
    for (const waiter of waiters.splice(0)) {
        waiter();
    }
}

class FakeStreamRun implements OwnedVideoStreamRun {
    public readonly postedFrames: PostedFrame[] = [];
    public readonly progress: Array<[OwnedVideoStreamProgressPhase, number, number]> = [];
    public stopped = false;
    private readonly creditWaiters: Array<() => void> = [];
    private readonly progressWaiters: Array<() => void> = [];

    public constructor(private credits: number) {}

    public readonly isStopped = (): boolean => this.stopped;

    public readonly notifyDecoderProgress = (): void => {
        wakeWaiters(this.progressWaiters);
    };

    // Like the worker, posting consumes the frame
    public readonly postFrame = async (
        output: OwnedDecodedVideoOutput,
        enhancementOutput: OwnedDecodedVideoOutput | null
    ): Promise<void> => {
        expect(enhancementOutput).toBeNull();
        if (output.source.kind !== 'native-frame') {
            throw new TypeError('The owned AV1 stream posts native frames');
        }
        const frame = output.source.frame as unknown as FakeVideoFrame;
        this.postedFrames.push({
            frame,
            mediaTimeMicroseconds: output.mediaTimeMicroseconds,
            metadata: output.encodedDolbyVisionMetadata
        });
        frame.close();
    };

    public readonly postStartupProgress = (
        phase: OwnedVideoStreamProgressPhase,
        packetCount: number,
        mediaTimeMicroseconds: number
    ): void => {
        this.progress.push([ phase, packetCount, mediaTimeMicroseconds ]);
    };

    public readonly waitForDecoderProgress = (): Promise<void> => new Promise<void>(resolve => {
        this.progressWaiters.push(resolve);
    });

    public readonly waitForFrameCredit = async (): Promise<boolean> => {
        while (!this.stopped && this.credits === 0) {
            await new Promise<void>(resolve => {
                this.creditWaiters.push(resolve);
            });
        }
        if (this.stopped) {
            return false;
        }
        this.credits -= 1;
        return true;
    };

    public grantCredits(creditCount: number): void {
        this.credits += creditCount;
        wakeWaiters(this.creditWaiters);
    }

    public stop(): void {
        this.stopped = true;
        wakeWaiters(this.creditWaiters);
        wakeWaiters(this.progressWaiters);
    }
}

class FakePacketIterator implements OwnedVideoPacketIterator {
    public nextCallCount = 0;

    public constructor(private readonly packets: readonly EncodedPacket[]) {}

    public readonly next = async (): Promise<IteratorResult<EncodedPacket>> => {
        const packet = this.packets[this.nextCallCount];
        this.nextCallCount += 1;
        return packet ? { done: false, value: packet } : { done: true, value: undefined };
    };
}

class FakeAV1Decoder implements OwnedVideoDecoderPort {
    public readonly close = vi.fn();
    public readonly decodedPackets: EncodedPacket[] = [];
    public readonly droppedTimestamps = new Set<number>();
    public readonly failures = new Map<number, DOMException>();
    public readonly frames: FakeVideoFrame[] = [];
    public readonly init = vi.fn(async (): Promise<void> => undefined);
    private readonly heldPackets: EncodedPacket[] = [];

    public constructor(
        private readonly callbacks: OwnedVideoDecoderCallbacks,
        private readonly outputMode: DecoderOutputMode
    ) {}

    // Like a native decoder, it never drops a picture on its own
    public readonly decode = (packet: EncodedPacket): boolean => {
        this.decodedPackets.push(packet);
        this.receivePacket(packet);
        return true;
    };

    public readonly flush = vi.fn(async (): Promise<void> => {
        this.releaseHeldFrames();
    });

    // Held packets are the chunks the codec has not consumed yet
    public readonly getDecodeQueueSize = (): number => this.heldPackets.length;

    public releaseHeldFrames(): void {
        for (const packet of this.heldPackets.splice(0)) {
            this.output(packet);
        }
    }

    private receivePacket(packet: EncodedPacket): void {
        const failure = this.failures.get(packet.microsecondTimestamp);
        if (failure) {
            this.callbacks.onError(failure);
            return;
        }
        if (this.outputMode === 'immediate') {
            this.output(packet);
            return;
        }
        this.heldPackets.push(packet);
    }

    private output(packet: EncodedPacket): void {
        if (this.droppedTimestamps.has(packet.microsecondTimestamp)) {
            return;
        }
        const frame = new FakeVideoFrame(packet.microsecondTimestamp, packet.microsecondDuration);
        this.frames.push(frame);
        this.callbacks.onOutput({
            frame: frame as unknown as VideoFrame,
            geometry: {
                codedHeight: frame.codedHeight,
                codedWidth: frame.codedWidth,
                displayHeight: frame.displayHeight,
                displayWidth: frame.displayWidth
            },
            kind: 'native-frame'
        });
        this.callbacks.onProgress();
    }
}

type StreamHarness = {
    decoder: FakeAV1Decoder | null
    packetIterator: FakePacketIterator
    parsedRPUData: Map<number, ArrayBuffer>
    rpuParser: { parseAV1ITUTT35: ReturnType<typeof vi.fn> }
    run: FakeStreamRun
    start: (startTimeMicroseconds?: Microseconds) => Promise<void>
};

function createOBU(type: number, payload: readonly number[]): number[] {
    return [ (type << 3) | OBU_HAS_SIZE_FIELD_FLAG, payload.length, ...payload ];
}

/** Creates a temporal unit with a frame, or a sequence header instead, after an optional RPU carrying a tag byte. */
function createTemporalUnit(frameIndex: number, rpuTag: number | null, hasFrame = true): EncodedPacket {
    const data = [
        ...(rpuTag === null ?
            [] :
            createOBU(OBU_TYPE_METADATA, [ METADATA_TYPE_ITUT_T35, ...DOLBY_VISION_T35_HEADER, rpuTag, 0x80 ])),
        ...(hasFrame ? createOBU(OBU_TYPE_FRAME, [ frameIndex ]) : createOBU(OBU_TYPE_SEQUENCE_HEADER, [ 1 ]))
    ];
    return new EncodedPacket(
        new Uint8Array(data),
        frameIndex === 0 ? 'key' : 'delta',
        frameIndex / FRAMES_PER_SECOND,
        1 / FRAMES_PER_SECOND,
        frameIndex
    );
}

function createHarness(
    packets: readonly EncodedPacket[],
    credits: number,
    outputMode: DecoderOutputMode = 'immediate',
    configureDecoder: (decoder: FakeAV1Decoder) => void = (): void => undefined
): StreamHarness {
    const parsedRPUData = new Map<number, ArrayBuffer>();
    const harness: StreamHarness = {
        decoder: null,
        packetIterator: new FakePacketIterator(packets),
        parsedRPUData,
        rpuParser: {
            // Each RPU parses to its own buffer, so a test can tell which frame received which RPU
            parseAV1ITUTT35: vi.fn(async (payload: Uint8Array): Promise<ArrayBuffer> => {
                const packedRPUData = createDolbyVisionAuthorizationRPUVector(8);
                parsedRPUData.set(payload[DOLBY_VISION_T35_HEADER.length], packedRPUData);
                return packedRPUData;
            })
        },
        run: new FakeStreamRun(credits),
        start: (startTimeMicroseconds = KEY_PACKET_MEDIA_TIME_MICROSECONDS): Promise<void> => runOwnedAV1VideoStream(
            harness.run,
            harness.packetIterator,
            harness.rpuParser,
            (callbacks: OwnedVideoDecoderCallbacks): OwnedVideoDecoderPort => {
                const decoder = new FakeAV1Decoder(callbacks, outputMode);
                configureDecoder(decoder);
                harness.decoder = decoder;
                return decoder;
            },
            startTimeMicroseconds,
            KEY_PACKET_MEDIA_TIME_MICROSECONDS
        )
    };
    return harness;
}

function requireDecoder(harness: StreamHarness): FakeAV1Decoder {
    if (!harness.decoder) {
        throw new Error('The stream has not created its decoder');
    }
    return harness.decoder;
}

/** Lets every pending promise continuation run. */
async function settle(): Promise<void> {
    await new Promise<void>(resolve => {
        setTimeout(resolve, 0);
    });
}

describe('runOwnedAV1VideoStream', () => {
    it('attaches each RPU to the frame of its temporal unit and decodes the stripped unit', async () => {
        const packets = [
            createTemporalUnit(0, 0x10),
            createTemporalUnit(1, 0x11),
            createTemporalUnit(2, null),
            createTemporalUnit(3, 0x13)
        ];
        const harness = createHarness(packets, AMPLE_FRAME_CREDITS);

        await harness.start();

        const decoder = requireDecoder(harness);
        expect(harness.run.postedFrames.map(postedFrame => postedFrame.mediaTimeMicroseconds)).toEqual([
            0,
            FRAME_DURATION_MICROSECONDS,
            2 * FRAME_DURATION_MICROSECONDS,
            3 * FRAME_DURATION_MICROSECONDS
        ]);
        const postedRPUData = harness.run.postedFrames.map(postedFrame => (
            postedFrame.metadata?.parsedRPUData[0] ?? null
        ));
        expect(postedRPUData[0]).toBe(harness.parsedRPUData.get(0x10));
        expect(postedRPUData[1]).toBe(harness.parsedRPUData.get(0x11));
        expect(postedRPUData[2]).toBeNull();
        expect(postedRPUData[3]).toBe(harness.parsedRPUData.get(0x13));
        expect(harness.rpuParser.parseAV1ITUTT35.mock.calls.map(call => (
            (call[0] as Uint8Array)[DOLBY_VISION_T35_HEADER.length]
        ))).toEqual([ 0x10, 0x11, 0x13 ]);
        expect(decoder.decodedPackets.map(packet => Array.from(packet.data))).toEqual([
            createOBU(OBU_TYPE_FRAME, [ 0 ]),
            createOBU(OBU_TYPE_FRAME, [ 1 ]),
            createOBU(OBU_TYPE_FRAME, [ 2 ]),
            createOBU(OBU_TYPE_FRAME, [ 3 ])
        ]);
        expect(decoder.decodedPackets[2]).toBe(packets[2]);
        expect(decoder.decodedPackets[0]).toMatchObject({ sequenceNumber: 0, type: 'key' });
        for (const frame of decoder.frames) {
            expect(frame.close).toHaveBeenCalledOnce();
        }
        expect(decoder.init).toHaveBeenCalledOnce();
        expect(decoder.flush).toHaveBeenCalledOnce();
        expect(decoder.close).toHaveBeenCalledOnce();
        expect(harness.run.progress.slice(0, 3)).toEqual([
            [ 'video-decoder-ready', 0, 0 ],
            [ 'video-packet-started', 1, 0 ],
            [ 'video-packet-decoded', 1, 0 ]
        ]);
    });

    it('reads a packet only while it holds a frame credit', async () => {
        const harness = createHarness([
            createTemporalUnit(0, 0x20),
            createTemporalUnit(1, 0x21),
            createTemporalUnit(2, 0x22)
        ], 0);
        const streamPromise = harness.start();

        await settle();
        expect(harness.packetIterator.nextCallCount).toBe(0);
        harness.run.grantCredits(1);
        await settle();
        expect(harness.packetIterator.nextCallCount).toBe(1);
        expect(harness.run.postedFrames).toHaveLength(1);
        harness.run.grantCredits(1);
        await settle();
        expect(harness.packetIterator.nextCallCount).toBe(2);
        expect(harness.run.postedFrames).toHaveLength(2);
        // One credit posts the last frame and one reads the end of the track
        harness.run.grantCredits(2);
        await streamPromise;

        expect(harness.packetIterator.nextCallCount).toBe(4);
        expect(harness.run.postedFrames.map(postedFrame => (
            postedFrame.metadata?.parsedRPUData[0]
        ))).toEqual([
            harness.parsedRPUData.get(0x20),
            harness.parsedRPUData.get(0x21),
            harness.parsedRPUData.get(0x22)
        ]);
    });

    it.each([
        {
            description: 'between two frames',
            expectedFrameIndices: [ 2, 3 ],
            startTimeMicroseconds: ((2 * FRAME_DURATION_MICROSECONDS) + 1) as Microseconds
        },
        {
            description: 'exactly on a frame',
            expectedFrameIndices: [ 1, 2, 3 ],
            startTimeMicroseconds: (2 * FRAME_DURATION_MICROSECONDS) as Microseconds
        }
    ])('drops frames before a start $description except the latest one', async ({
        expectedFrameIndices,
        startTimeMicroseconds
    }) => {
        const harness = createHarness([
            createTemporalUnit(0, 0x30),
            createTemporalUnit(1, 0x31),
            createTemporalUnit(2, 0x32),
            createTemporalUnit(3, 0x33)
        ], AMPLE_FRAME_CREDITS);

        await harness.start(startTimeMicroseconds);

        expect(harness.run.postedFrames.map(postedFrame => (
            postedFrame.mediaTimeMicroseconds / FRAME_DURATION_MICROSECONDS
        ))).toEqual(expectedFrameIndices);
        expect(harness.run.postedFrames.map(postedFrame => (
            postedFrame.metadata?.parsedRPUData[0]
        ))).toEqual(expectedFrameIndices.map(frameIndex => harness.parsedRPUData.get(0x30 + frameIndex)));
        for (const frame of requireDecoder(harness).frames) {
            expect(frame.close).toHaveBeenCalledOnce();
        }
    });

    it('posts the frames a decoder holds until the end-of-track flush', async () => {
        const harness = createHarness([
            createTemporalUnit(0, 0x40),
            createTemporalUnit(1, 0x41),
            createTemporalUnit(2, 0x42)
        ], AMPLE_FRAME_CREDITS, 'held');

        await harness.start();

        expect(requireDecoder(harness).flush).toHaveBeenCalledOnce();
        expect(harness.run.postedFrames.map(postedFrame => (
            postedFrame.metadata?.parsedRPUData[0]
        ))).toEqual([
            harness.parsedRPUData.get(0x40),
            harness.parsedRPUData.get(0x41),
            harness.parsedRPUData.get(0x42)
        ]);
    });

    it('waits for decoder progress while the decode queue is at its bound', async () => {
        const packets = Array.from(
            { length: DECODE_QUEUE_HIGH_WATER_MARK + 2 },
            (_value: unknown, frameIndex: number): EncodedPacket => createTemporalUnit(frameIndex, null)
        );
        const harness = createHarness(packets, AMPLE_FRAME_CREDITS, 'held');
        const streamPromise = harness.start();

        await settle();
        expect(harness.packetIterator.nextCallCount).toBe(DECODE_QUEUE_HIGH_WATER_MARK);
        requireDecoder(harness).releaseHeldFrames();
        await streamPromise;

        expect(harness.packetIterator.nextCallCount).toBe(packets.length + 1);
        expect(harness.run.postedFrames).toHaveLength(packets.length);
    });

    it.each([
        new DOMException('Decoding error.', 'EncodingError'),
        new DOMException('Codec reclaimed due to inactivity.', 'QuotaExceededError')
    ])('fails the attempt with decoder error $name and closes every frame', async codecError => {
        const harness = createHarness([
            createTemporalUnit(0, 0x50),
            createTemporalUnit(1, 0x51),
            createTemporalUnit(2, 0x52)
        ], AMPLE_FRAME_CREDITS, 'immediate', (decoder: FakeAV1Decoder): void => {
            decoder.failures.set(FRAME_DURATION_MICROSECONDS, codecError);
        });

        let streamError: unknown = null;
        try {
            await harness.start();
        } catch (error) {
            streamError = error;
        }

        // The worker resyncs a reclaimed decoder by the error's name, so the codec's own error must surface
        expect(streamError).toBe(codecError);
        const decoder = requireDecoder(harness);
        expect(decoder.close).toHaveBeenCalledOnce();
        expect(harness.run.postedFrames).toHaveLength(1);
        for (const frame of decoder.frames) {
            expect(frame.close).toHaveBeenCalledOnce();
        }
    });

    it('rejects a decoder that ends without the frame of one of its units', async () => {
        const harness = createHarness([
            createTemporalUnit(0, 0x60),
            createTemporalUnit(1, 0x61),
            createTemporalUnit(2, 0x62)
        ], AMPLE_FRAME_CREDITS, 'immediate', (decoder: FakeAV1Decoder): void => {
            decoder.droppedTimestamps.add(FRAME_DURATION_MICROSECONDS);
        });

        await expect(harness.start()).rejects.toThrow(
            'The AV1 decoder ended before every metadata entry was matched'
        );
        expect(harness.run.postedFrames.map(postedFrame => (
            postedFrame.metadata?.parsedRPUData[0]
        ))).toEqual([
            harness.parsedRPUData.get(0x60),
            harness.parsedRPUData.get(0x62)
        ]);
        expect(requireDecoder(harness).close).toHaveBeenCalledOnce();
    });

    it('rejects an RPU whose temporal unit has no frame', async () => {
        const harness = createHarness([
            createTemporalUnit(0, 0x70),
            createTemporalUnit(1, 0x71, false)
        ], AMPLE_FRAME_CREDITS);

        await expect(harness.start()).rejects.toThrow('not paired with an AV1 frame');
        expect(requireDecoder(harness).decodedPackets).toHaveLength(1);
        expect(requireDecoder(harness).close).toHaveBeenCalledOnce();
    });

    it('closes the frames it still holds when the attempt stops', async () => {
        const harness = createHarness([
            createTemporalUnit(0, 0x80),
            createTemporalUnit(1, 0x81),
            createTemporalUnit(2, 0x82)
        ], 1, 'held');
        const streamPromise = harness.start();

        await settle();
        expect(harness.run.postedFrames).toHaveLength(1);
        harness.run.stop();
        await streamPromise;

        const decoder = requireDecoder(harness);
        expect(decoder.frames).toHaveLength(3);
        for (const frame of decoder.frames) {
            expect(frame.close).toHaveBeenCalledOnce();
        }
        expect(decoder.close).toHaveBeenCalledOnce();
    });
});
