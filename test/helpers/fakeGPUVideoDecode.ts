// Test doubles for the frame-pool route's GPU decoder: a decode session without a device, and a queue whose submitted work completes on request.
import { type Mock, vi } from 'vitest';

import type {
    GPUVideoDecodeHandle,
    GPUVideoDecodeSessionFactory,
    GPUVideoDecodeSessionRequest
} from 'webgpu-player/decode/video/gpu/GPUVideoDecodeFeed';
import type {
    GPUDecodePacket,
    GPUDecodeStreamFacts,
    GPUVideoDecodeFailure,
    GPUVideoDecodeRecovery
} from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';
import { selectGPUDecodeSessionStream } from 'webgpu-player/decode/video/gpu/GPUDecoderStreamFit';
import type GPUVideoDecodeSession from 'webgpu-player/decode/video/gpu/GPUVideoDecodeSession';
import type { GPUDecodedFrame } from 'webgpu-player/decode/video/gpu/GPUVideoDecodeSession';

export const FAKE_GPU_DECODER_NAME = 'Fake I420';
export const FAKE_GPU_SLOT_COUNT = 4;
// A device buffer limit that holds every test stream's pool and buffers
const FAKE_BUFFER_BYTE_LIMIT = 2 ** 31;

/**
 * A decode session that decodes each submitted packet into one presentable frame at once, with no reorder, at its picture's own visible size when it has one.
 * Each submitted packet stays in flight, as its status readback would, until its queue completes the work submitted so far.
 */
export class FakeGPUVideoDecodeSession {
    /** The picture index a stream change continued the session's numbering from, or null when it numbers from 0 */
    continuedPictureIndex: number | null = null;
    destroyed = false;
    endOfStreamCount = 0;
    /** The parser's output events each end of stream carried, null for an end without any */
    readonly endOfStreamEvents: Array<Uint32Array | null> = [];
    failure: GPUVideoDecodeFailure | null = null;
    freeSlotCount = FAKE_GPU_SLOT_COUNT;
    readonly manifest = { name: FAKE_GPU_DECODER_NAME };
    pendingPackets: GPUDecodePacket[] = [];
    /** The pool's coded size, the stream's, and its slots */
    readonly pool: Readonly<{ layout: Readonly<{ codedHeight: number; codedWidth: number; slotCount: number }> }>;
    presentableFrames: GPUDecodedFrame[] = [];
    readonly queuedPackets: GPUDecodePacket[] = [];
    /** Recoveries a test reports, which takeRecoveries() hands over as a session's are */
    readonly recoveries: GPUVideoDecodeRecovery[] = [];
    readonly releasedFrames: GPUDecodedFrame[] = [];
    resetCount = 0;
    readonly submittedPackets: GPUDecodePacket[] = [];
    // The completion of each submitted packet whose work the queue has not completed yet
    private readonly inFlightCompletions = new Set<Promise<void>>();

    constructor(private readonly stream: GPUDecodeStreamFacts, private readonly queue: ControlledQueue) {
        this.pool = { layout: { codedHeight: stream.codedHeight, codedWidth: stream.codedWidth, slotCount: FAKE_GPU_SLOT_COUNT } };
    }

    continuePictureNumbering(nextPictureIndex: number): void {
        this.continuedPictureIndex = nextPictureIndex;
    }

    destroy(): void {
        this.destroyed = true;
    }

    endOfStream(outputEvents: Uint32Array | null = null): void {
        this.endOfStreamCount += 1;
        this.endOfStreamEvents.push(outputEvents);
    }

    getFailure(): GPUVideoDecodeFailure | null {
        return this.failure;
    }

    getFreeSlotCount(): number {
        return this.freeSlotCount;
    }

    getInFlightPacketCount(): number {
        return this.inFlightCompletions.size;
    }

    getPendingPacketCount(): number {
        return this.pendingPackets.length;
    }

    getQueuedFrameCount(): number {
        return this.presentableFrames.length;
    }

    queuePacket(packet: GPUDecodePacket): void {
        this.queuedPackets.push(packet);
        this.pendingPackets.push(packet);
    }

    releaseFrame(frame: GPUDecodedFrame): boolean {
        this.releasedFrames.push(frame);
        this.freeSlotCount += 1;
        return true;
    }

    reset(): void {
        this.resetCount += 1;
        this.pendingPackets = [];
        this.presentableFrames = [];
    }

    submitPendingDecodeWork(): boolean {
        const packet = this.pendingPackets.at(0);
        if (this.failure || !packet || this.freeSlotCount === 0) {
            return false;
        }
        this.pendingPackets.shift();
        this.submittedPackets.push(packet);
        this.freeSlotCount -= 1;
        const visibleSize = packet.visibleSize;
        this.presentableFrames.push({
            droppedFrameCount: 0,
            durationMicroseconds: packet.durationMicroseconds,
            fields: packet.fields,
            frame: {
                codedHeight: this.stream.codedHeight,
                codedWidth: this.stream.codedWidth,
                layout: {} as GPUBuffer,
                pool: {} as GPUBuffer,
                visibleRectangle: visibleSize ? { height: visibleSize.height, width: visibleSize.width, x: 0, y: 0 } : { ...this.stream.visibleRectangle }
            },
            slot: this.submittedPackets.length - 1,
            timestampMicroseconds: packet.timestampMicroseconds,
            visibleSize
        });
        const completion = this.queue.onSubmittedWorkDone().then((): void => {
            this.inFlightCompletions.delete(completion);
        });
        this.inFlightCompletions.add(completion);
        return true;
    }

    takeNextFrame(): GPUDecodedFrame | null {
        return this.presentableFrames.shift() ?? null;
    }

    takeRecoveries(): GPUVideoDecodeRecovery[] {
        return this.recoveries.splice(0);
    }

    /** Resolves once the next in-flight packet's work completed, at once when none is in flight. */
    async waitForNextStatusReadback(): Promise<void> {
        if (this.inFlightCompletions.size > 0) {
            await Promise.race(this.inFlightCompletions);
        }
    }
}

/** A queue whose submitted work completes only when the test says so. */
export class ControlledQueue {
    private readonly completions: Array<() => void> = [];

    onSubmittedWorkDone(): Promise<undefined> {
        return new Promise<undefined>(resolve => {
            this.completions.push((): void => resolve(undefined));
        });
    }

    completeAll(): void {
        for (const complete of this.completions.splice(0)) {
            complete();
        }
    }
}

export type FakeGPUVideoDecodeSessionFactory = {
    factory: Mock<GPUVideoDecodeSessionFactory>
    queue: ControlledQueue
    requests: GPUVideoDecodeSessionRequest[]
    sessions: FakeGPUVideoDecodeSession[]
};

/**
 * Returns a session factory that keeps every request and session, on one device whose queue the test completes,
 * and whose buffer limit holds every test stream's pool unless the test gives a smaller one.
 */
export function createFakeGPUVideoDecodeSessionFactory(
    describeDecoderError: (errorWord: number) => string = String,
    maximumBufferByteLength: number = FAKE_BUFFER_BYTE_LIMIT
): FakeGPUVideoDecodeSessionFactory {
    const queue = new ControlledQueue();
    const requests: GPUVideoDecodeSessionRequest[] = [];
    const sessions: FakeGPUVideoDecodeSession[] = [];
    const factory = vi.fn<GPUVideoDecodeSessionFactory>((sessionRequest: GPUVideoDecodeSessionRequest): Promise<GPUVideoDecodeHandle> => {
        // The pool the presenter's factory chooses for the request on the device; a refused stream change rejects
        const stream = selectGPUDecodeSessionStream(
            sessionRequest.decoder.package.manifest,
            sessionRequest.format,
            sessionRequest.stream,
            sessionRequest.maximumPictureSize,
            maximumBufferByteLength,
            sessionRequest.fallbackPictureSize ?? null
        );
        const session = new FakeGPUVideoDecodeSession(stream, queue);
        requests.push(sessionRequest);
        sessions.push(session);
        return Promise.resolve({
            describeDecoderError,
            device: { queue } as unknown as GPUDevice,
            session: session as unknown as GPUVideoDecodeSession
        });
    });
    return { factory, queue, requests, sessions };
}
