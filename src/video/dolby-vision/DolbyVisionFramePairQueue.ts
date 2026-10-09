import type { Microseconds } from '../../MediaTime';

export const MAXIMUM_DOLBY_VISION_FRAME_PAIR_QUEUE_LENGTH = 16;
export const DOLBY_VISION_FRAME_PAIR_TOLERANCE_MICROSECONDS = 1;

export type DolbyVisionTimedFrame<Frame> = {
    frame: Frame
    mediaTimeMicroseconds: Microseconds
};

export type DolbyVisionFramePair<BaseFrame, EnhancementFrame> = {
    baseFrame: BaseFrame
    enhancementFrame: EnhancementFrame | null
};

type FrameCloser<Frame> = (frame: Frame) => void;

function requireTimestamp(timestampMicroseconds: Microseconds): void {
    if (!Number.isSafeInteger(timestampMicroseconds)) {
        throw new TypeError('Dolby Vision frame timestamps must be signed integer microseconds');
    }
}

/**
 * Pairs decoded Dolby Vision BL and EL outputs without allowing either decoder to create an unbounded ownership queue.
 */
export default class DolbyVisionFramePairQueue<BaseFrame, EnhancementFrame> {
    private readonly baseFrames: Array<DolbyVisionTimedFrame<BaseFrame>> = [];
    private readonly enhancementFrames: Array<DolbyVisionTimedFrame<EnhancementFrame>> = [];
    private enhancementEnded = false;
    private finalDrain = false;
    private readonly readyPairs: Array<DolbyVisionFramePair<BaseFrame, EnhancementFrame>> = [];

    public constructor(
        private readonly closeBaseFrame: FrameCloser<BaseFrame>,
        private readonly closeEnhancementFrame: FrameCloser<EnhancementFrame>
    ) {}

    /**
     * Adds one owned BL output and resolves every pair now proven ready.
     * Every check runs before the queue takes ownership, because the caller closes a rejected frame.
     */
    public enqueueBaseFrame(frame: DolbyVisionTimedFrame<BaseFrame>): void {
        requireTimestamp(frame.mediaTimeMicroseconds);
        this.requireMonotonicTimestamp(this.baseFrames, frame.mediaTimeMicroseconds, 'base');
        this.requireReadyPairCapacity();
        this.baseFrames.push(frame);
        this.resolvePairs();
    }

    /** Adds one owned EL output and resolves every pair now proven ready. */
    public enqueueEnhancementFrame(frame: DolbyVisionTimedFrame<EnhancementFrame>): void {
        requireTimestamp(frame.mediaTimeMicroseconds);
        if (this.enhancementEnded) {
            this.closeEnhancementFrame(frame.frame);
            return;
        }
        this.requireMonotonicTimestamp(
            this.enhancementFrames,
            frame.mediaTimeMicroseconds,
            'enhancement'
        );
        if (this.enhancementFrames.length >= MAXIMUM_DOLBY_VISION_FRAME_PAIR_QUEUE_LENGTH) {
            const discardedFrame = this.enhancementFrames.shift();
            if (discardedFrame) {
                this.closeEnhancementFrame(discardedFrame.frame);
            }
        }
        this.enhancementFrames.push(frame);
        this.resolvePairs();
    }

    /**
     * Marks the EL decoder exhausted or degraded and releases waiting BL frames.
     * Queued EL frames stay until a BL frame pairs with them or passes them, so a full ready queue cannot strip the layer from matching frames.
     */
    public finishEnhancement(): void {
        if (this.enhancementEnded) {
            return;
        }
        this.enhancementEnded = true;
        this.resolvePairs();
    }

    /**
     * Lets the ready queue exceed its bound while the decoders flush their last frames.
     * No further packet is submitted, so the frames the decoders still hold are the whole remainder and must not fail the stream.
     */
    public beginFinalDrain(): void {
        this.finalDrain = true;
        this.resolvePairs();
    }

    /** Takes the oldest resolved compound ownership unit. */
    public takeReadyPair(): DolbyVisionFramePair<BaseFrame, EnhancementFrame> | null {
        const framePair = this.readyPairs.shift() ?? null;
        // A full ready queue can leave resolvable frames waiting
        this.resolvePairs();
        return framePair;
    }

    public hasReadyPair(): boolean {
        return this.readyPairs.length > 0;
    }

    /** Closes every queued frame exactly once and resets the pairer. */
    public close(): void {
        for (const frame of this.baseFrames) {
            this.closeBaseFrame(frame.frame);
        }
        for (const frame of this.enhancementFrames) {
            this.closeEnhancementFrame(frame.frame);
        }
        for (const pair of this.readyPairs) {
            this.closeBaseFrame(pair.baseFrame);
            if (pair.enhancementFrame !== null) {
                this.closeEnhancementFrame(pair.enhancementFrame);
            }
        }
        this.baseFrames.length = 0;
        this.enhancementFrames.length = 0;
        this.readyPairs.length = 0;
    }

    private requireMonotonicTimestamp<Frame>(
        frames: Array<DolbyVisionTimedFrame<Frame>>,
        timestampMicroseconds: Microseconds,
        layer: 'base' | 'enhancement'
    ): void {
        const previousFrame = frames.at(-1);
        if (previousFrame && timestampMicroseconds < previousFrame.mediaTimeMicroseconds) {
            throw new RangeError(`Decoded Dolby Vision ${layer} frames are not in presentation order`);
        }
    }

    /** Moves resolvable frames into ready pairs, stopping (never throwing) when the ready queue is full. */
    private resolvePairs(): void {
        while (this.baseFrames.length > 0 && this.hasReadyPairCapacity()) {
            const baseFrame = this.baseFrames[0];
            this.discardOlderEnhancementFrames(baseFrame.mediaTimeMicroseconds);
            const enhancementFrame = this.enhancementFrames[0];
            if (enhancementFrame) {
                const timestampDelta = enhancementFrame.mediaTimeMicroseconds - baseFrame.mediaTimeMicroseconds;
                if (Math.abs(timestampDelta) <= DOLBY_VISION_FRAME_PAIR_TOLERANCE_MICROSECONDS) {
                    this.baseFrames.shift();
                    this.enhancementFrames.shift();
                    this.readyPairs.push({
                        baseFrame: baseFrame.frame,
                        enhancementFrame: enhancementFrame.frame
                    });
                    continue;
                }
                if (timestampDelta > DOLBY_VISION_FRAME_PAIR_TOLERANCE_MICROSECONDS) {
                    this.queueBaseOnlyPair();
                    continue;
                }
            }
            if (
                this.enhancementEnded
                || this.baseFrames.length >= MAXIMUM_DOLBY_VISION_FRAME_PAIR_QUEUE_LENGTH
            ) {
                this.queueBaseOnlyPair();
                continue;
            }
            break;
        }
    }

    private discardOlderEnhancementFrames(baseTimestampMicroseconds: Microseconds): void {
        while (this.enhancementFrames.length > 0) {
            const enhancementFrame = this.enhancementFrames[0];
            if (
                enhancementFrame.mediaTimeMicroseconds
                >= baseTimestampMicroseconds
                    - DOLBY_VISION_FRAME_PAIR_TOLERANCE_MICROSECONDS
            ) {
                return;
            }
            this.enhancementFrames.shift();
            this.closeEnhancementFrame(enhancementFrame.frame);
        }
    }

    private queueBaseOnlyPair(): void {
        const baseFrame = this.baseFrames.shift();
        if (!baseFrame) {
            return;
        }
        this.readyPairs.push({
            baseFrame: baseFrame.frame,
            enhancementFrame: null
        });
    }

    private hasReadyPairCapacity(): boolean {
        return this.finalDrain || this.readyPairs.length < MAXIMUM_DOLBY_VISION_FRAME_PAIR_QUEUE_LENGTH;
    }

    private requireReadyPairCapacity(): void {
        if (!this.hasReadyPairCapacity()) {
            throw new RangeError('Decoded Dolby Vision frame pair queue exceeded its bound');
        }
    }
}
