// Stand-ins for the worker's side of an owned decode attempt: its run, its packet iterator, and a native decoder with its frames

import { EncodedPacket } from 'mediabunny';
import { expect, vi } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';
import type {
    OwnedDecodedVideoOutput,
    OwnedVideoDecoderCallbacks,
    OwnedVideoDecoderPort,
    OwnedVideoPacketIterator,
    OwnedVideoStreamProgressPhase,
    OwnedVideoStreamRun
} from 'webgpu-player/video/decoders/OwnedVideoDecodeStream';
import type { DolbyVisionEncodedFrameMetadata } from 'webgpu-player/video/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import type { HDR10PlusFrameMetadata } from 'webgpu-player/video/hdr/HDR10PlusMetadata';

// A power-of-two frame rate keeps every timestamp exact in seconds and in microseconds
const FRAMES_PER_SECOND = 32;
export const FRAME_DURATION_MICROSECONDS = 31_250 as Microseconds;
export const KEY_PACKET_MEDIA_TIME_MICROSECONDS = 0 as Microseconds;
// More frame credits than any test posts frames
export const AMPLE_FRAME_CREDITS = 64;

export type PostedFrame = {
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null
    frame: FakeVideoFrame
    HDR10PlusMetadata: HDR10PlusFrameMetadata | null | undefined
    mediaTimeMicroseconds: number
};

/**
 * Whether the decoder outputs each frame at once, or holds every frame until its flush or release.
 * A presentation-order decoder releases the frames it holds sorted by timestamp, as a decoder that reorders frames does.
 */
export type FakeDecoderOutputMode = 'immediate' | 'held' | 'presentation-order';

export class FakeVideoFrame {
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

/**
 * A run that posts single-layer native frames, recording each, and hands out frame credits.
 * Its sleeps end at once unless held, when they end only at their release.
 */
export class FakeStreamRun implements OwnedVideoStreamRun {
    public holdSleeps = false;
    public readonly postedFrames: PostedFrame[] = [];
    public readonly progress: Array<[OwnedVideoStreamProgressPhase, number, number]> = [];
    public readonly sleepDurations: number[] = [];
    public stopped = false;
    private readonly creditWaiters: Array<() => void> = [];
    private readonly progressWaiters: Array<() => void> = [];
    private readonly sleepWaiters: Array<() => void> = [];

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
            throw new TypeError('A native decoder posts native frames');
        }
        const frame = output.source.frame as unknown as FakeVideoFrame;
        this.postedFrames.push({
            encodedDolbyVisionMetadata: output.encodedDolbyVisionMetadata,
            frame,
            HDR10PlusMetadata: output.HDR10PlusMetadata,
            mediaTimeMicroseconds: output.mediaTimeMicroseconds
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

    public readonly sleep = (milliseconds: number): Promise<void> => {
        this.sleepDurations.push(milliseconds);
        if (!this.holdSleeps) {
            return Promise.resolve();
        }
        return new Promise<void>(resolve => {
            this.sleepWaiters.push(resolve);
        });
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

    /** Ends every held sleep, as the pacing bound passing does. */
    public releaseSleeps(): void {
        wakeWaiters(this.sleepWaiters);
    }

    public stop(): void {
        this.stopped = true;
        wakeWaiters(this.creditWaiters);
        wakeWaiters(this.progressWaiters);
        wakeWaiters(this.sleepWaiters);
    }
}

export class FakePacketIterator implements OwnedVideoPacketIterator {
    public nextCallCount = 0;

    public constructor(private readonly packets: readonly EncodedPacket[]) {}

    public readonly next = async (): Promise<IteratorResult<EncodedPacket>> => {
        const packet = this.packets[this.nextCallCount];
        this.nextCallCount += 1;
        return packet ? { done: false, value: packet } : { done: true, value: undefined };
    };
}

/** Outputs one frame per packet, except at the timestamps it drops or fails, as a native decoder that never refuses a packet. */
export class FakeOwnedVideoDecoder implements OwnedVideoDecoderPort {
    public readonly close = vi.fn();
    public readonly decodedPackets: EncodedPacket[] = [];
    public readonly droppedTimestamps = new Set<number>();
    public readonly failures = new Map<number, DOMException>();
    public readonly frames: FakeVideoFrame[] = [];
    public readonly init = vi.fn(async (): Promise<void> => undefined);
    private readonly heldPackets: EncodedPacket[] = [];

    public constructor(
        private readonly callbacks: OwnedVideoDecoderCallbacks,
        private readonly outputMode: FakeDecoderOutputMode = 'immediate'
    ) {}

    public readonly decode = (packet: EncodedPacket): boolean => {
        this.decodedPackets.push(packet);
        const failure = this.failures.get(packet.microsecondTimestamp);
        if (failure) {
            this.callbacks.onError(failure);
        } else if (this.outputMode === 'immediate') {
            this.output(packet);
        } else {
            this.heldPackets.push(packet);
        }
        return true;
    };

    public readonly flush = vi.fn(async (): Promise<void> => {
        this.releaseHeldFrames();
    });

    // Held packets are the chunks the codec has not consumed yet
    public readonly getDecodeQueueSize = (): number => this.heldPackets.length;

    public releaseHeldFrames(): void {
        const packets = this.heldPackets.splice(0);
        if (this.outputMode === 'presentation-order') {
            packets.sort((first: EncodedPacket, second: EncodedPacket): number => (
                first.microsecondTimestamp - second.microsecondTimestamp
            ));
        }
        for (const packet of packets) {
            this.output(packet);
        }
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

/** The fakes one attempt runs on, and the decoder it creates through them. */
export type OwnedVideoStreamFakes = {
    /** Creates the attempt's decoder, configures it before its first packet, and keeps it */
    createDecoder: (callbacks: OwnedVideoDecoderCallbacks) => OwnedVideoDecoderPort
    packetIterator: FakePacketIterator
    /** Returns the decoder the attempt created */
    requireDecoder: () => FakeOwnedVideoDecoder
    run: FakeStreamRun
};

export function createOwnedVideoStreamFakes(
    packets: readonly EncodedPacket[],
    credits: number,
    outputMode: FakeDecoderOutputMode = 'immediate',
    configureDecoder: (decoder: FakeOwnedVideoDecoder) => void = (): void => undefined
): OwnedVideoStreamFakes {
    let decoder: FakeOwnedVideoDecoder | null = null;
    return {
        createDecoder: (callbacks: OwnedVideoDecoderCallbacks): OwnedVideoDecoderPort => {
            const createdDecoder = new FakeOwnedVideoDecoder(callbacks, outputMode);
            configureDecoder(createdDecoder);
            decoder = createdDecoder;
            return createdDecoder;
        },
        packetIterator: new FakePacketIterator(packets),
        requireDecoder: (): FakeOwnedVideoDecoder => {
            if (!decoder) {
                throw new Error('The stream has not created its decoder');
            }
            return decoder;
        },
        run: new FakeStreamRun(credits)
    };
}

/** Creates the packet of one frame, timed by its index at the fake frame rate; the first frame's packet is the key packet. */
export function createFramePacket(frameIndex: number, data: readonly number[]): EncodedPacket {
    return new EncodedPacket(
        new Uint8Array(data),
        frameIndex === 0 ? 'key' : 'delta',
        frameIndex / FRAMES_PER_SECOND,
        1 / FRAMES_PER_SECOND,
        frameIndex
    );
}

/** Lets every pending promise continuation run. */
export async function settle(): Promise<void> {
    await new Promise<void>(resolve => {
        setTimeout(resolve, 0);
    });
}
