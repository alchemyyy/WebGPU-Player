import type { HDR10PlusFrameMetadata, HDR10PlusMetadata } from './HDR10PlusMetadata';
import { requireMicroseconds } from '../../TimeMath';

export const MAXIMUM_PENDING_DYNAMIC_HDR_FRAME_COUNT = 64;

export type HDR10PlusCodecName = 'AV1' | 'HEVC' | 'VP9';

/**
 * Holds the HDR10+ state of each packet, recorded in decode order, until the decoder outputs the packet's frame.
 * Frames leave the decoder reordered, so the frame's timestamp keys its entry.
 * A packet without metadata of its own takes the last metadata of the queue's run, in decode order, as FFmpeg keeps it until new metadata replaces it or the decoder flushes.
 */
export default class HDR10PlusFrameMetadataQueue {
    private lastMetadata: HDR10PlusMetadata | null = null;
    private pendingFrameCount = 0;
    private readonly pendingFrames = new Map<number, HDR10PlusFrameMetadata[]>();

    public constructor(private readonly codecName: HDR10PlusCodecName) {}

    /** Records the HDR10+ state of one packet whose frame the decoder outputs, called in decode order. */
    public enqueue(timestampMicrosecondsValue: number, frameMetadata: HDR10PlusFrameMetadata): void {
        const timestampMicroseconds = requireMicroseconds(
            timestampMicrosecondsValue,
            `Encoded ${this.codecName} dynamic HDR packet timestamp`
        );
        if (this.pendingFrameCount >= MAXIMUM_PENDING_DYNAMIC_HDR_FRAME_COUNT) {
            throw new Error('The dynamic HDR metadata frame window exceeded its bound');
        }
        const frames = this.pendingFrames.get(timestampMicroseconds) ?? [];
        if (!this.pendingFrames.has(timestampMicroseconds)) {
            this.pendingFrames.set(timestampMicroseconds, frames);
        }
        frames.push(this.carryMetadata(frameMetadata));
        this.pendingFrameCount += 1;
    }

    /** Takes the oldest pending dynamic metadata for one decoded frame timestamp. */
    public takeFrameMetadata(timestampMicrosecondsValue: number): HDR10PlusFrameMetadata {
        const timestampMicroseconds = requireMicroseconds(
            timestampMicrosecondsValue,
            `Decoded ${this.codecName} dynamic HDR frame timestamp`
        );
        const frames = this.pendingFrames.get(timestampMicroseconds);
        if (!frames || frames.length === 0) {
            throw new Error(`A decoded ${this.codecName} frame has no matching dynamic HDR metadata state`);
        }
        const metadata = frames.shift() as HDR10PlusFrameMetadata;
        if (frames.length === 0) {
            this.pendingFrames.delete(timestampMicroseconds);
        }
        this.pendingFrameCount -= 1;
        return metadata;
    }

    /** Rejects decoder packet loss instead of attaching stale frame metadata. */
    public requireDrained(): void {
        if (this.pendingFrameCount !== 0) {
            throw new Error(`The ${this.codecName} decoder ended before dynamic HDR metadata was matched`);
        }
    }

    /** Discards all generation-owned metadata, the carried metadata included, on stop, source change, or seek. */
    public clear(): void {
        this.pendingFrames.clear();
        this.pendingFrameCount = 0;
        this.lastMetadata = null;
    }

    /**
     * Keeps the packet's status and gives it the metadata that applies to its frame.
     * A malformed payload keeps the last metadata, as a failed parse does in FFmpeg.
     * Conflicting or unsupported metadata ends it until the next valid payload.
     */
    private carryMetadata(frameMetadata: HDR10PlusFrameMetadata): HDR10PlusFrameMetadata {
        switch (frameMetadata.status) {
            case 'valid':
                this.lastMetadata = frameMetadata.metadata;
                return frameMetadata;
            case 'absent':
            case 'malformed':
                return { metadata: this.lastMetadata, status: frameMetadata.status };
            case 'conflicting':
            case 'unsupported':
                this.lastMetadata = null;
                return { metadata: null, status: frameMetadata.status };
        }
    }
}
