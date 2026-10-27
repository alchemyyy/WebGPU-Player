import type { EncodedPacket, VideoSample } from 'mediabunny';

import type { Microseconds } from '../../../MediaTime';
import { requireMicroseconds } from '../../../TimeMath';
import { recordTimingEvent, recordTimingWait, startTimingWait } from '../../../TimingTrace';
import DolbyVisionFramePairQueue, {
    MAXIMUM_DOLBY_VISION_FRAME_PAIR_QUEUE_LENGTH
} from './DolbyVisionFramePairQueue';
import type DolbyVisionEncodedMetadataQueue from '../../../demux/dolby-vision/DolbyVisionEncodedMetadata';
import type { DolbyVisionAV1EncodedMetadataQueue } from '../../../demux/dolby-vision/DolbyVisionEncodedMetadata';
import type { DolbyVisionEncodedFrameMetadata } from '../../../demux/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import type HDR10PlusFrameMetadataQueue from '../HDR10PlusFrameMetadataQueue';
import type { HDR10PlusFrameMetadata } from '../../../demux/hdr/HDR10PlusMetadata';
import {
    RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT,
    type RawVideoFrameGeometry
} from '../RawVideoFrameCopy';
import type { VideoDecodeFence } from './VideoDecodeFence';

// Every queued packet becomes a frame that may wait in the pair queue for a credit, so the decode queue plus the decodes in flight must fit under that queue's bound
const OWNED_VIDEO_DECODE_QUEUE_HIGH_WATER_MARK = MAXIMUM_DOLBY_VISION_FRAME_PAIR_QUEUE_LENGTH / 2;
// A hardware decoder returns a picture a few milliseconds after it takes the packet.
// Waiting up to this long for that picture before the next packet keeps decode at one packet per presented frame.
export const OWNED_VIDEO_PACKET_PACING_MILLISECONDS = 10;
// A preroll's frames, decoded but never shown, go to the decoder in batches of this many frames: before the packet after a batch is read,
// the GPU must have decoded the batch before it, so the decoder never runs more than two batches ahead of the GPU, and never idles between batches.
export const OWNED_VIDEO_PREROLL_BATCH_FRAME_COUNT = 4;
const OWNED_VIDEO_PREROLL_BATCHES_AHEAD = 2;
// Bounds one fence wait, so a GPU that never reports its work done only ends the batching, never the decode
export const OWNED_VIDEO_DECODE_FENCE_TIMEOUT_MILLISECONDS = 250;

export type OwnedDecodedVideoSource =
    | {
        frame: VideoFrame
        geometry: RawVideoFrameGeometry
        kind: 'native-frame'
    }
    // A Mediabunny sample that wraps a WebCodecs VideoFrame
    | {
        kind: 'video-sample'
        sample: VideoSample
    };

export type OwnedDecodedVideoOutput = {
    durationMicroseconds: Microseconds
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null
    HDR10PlusMetadata?: HDR10PlusFrameMetadata | null
    mediaTimeMicroseconds: Microseconds
    source: OwnedDecodedVideoSource
};

export type OwnedVideoDecoderCallbacks = {
    onError: (error: unknown) => void
    /** Owns the decoded source from the call on, even when it throws. */
    onOutput: (output: OwnedDecodedVideoSource) => void
    onProgress: () => void
};

export type OwnedVideoDecoderPort = {
    close: () => void
    /**
     * Returns false when the decoder drops the packet's picture.
     * Transferable data was allocated for this decode alone, so the decoder may detach its buffer instead of copying it.
     */
    decode: (packet: EncodedPacket, transferableData?: boolean) => boolean
    flush: () => Promise<void>
    getDecodeQueueSize: () => number
    init: () => Promise<void>
};

/** The packet metadata one decoded frame carries to presentation. */
export type OwnedVideoFrameMetadata = {
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null
    HDR10PlusMetadata?: HDR10PlusFrameMetadata | null
};

/** Owns the packet metadata of frames not yet decoded, keyed by presentation timestamp. */
export type OwnedVideoFrameMetadataSource = {
    clear: () => void
    /** Throws when a recorded frame never left the decoder. */
    requireDrained: () => void
    /** Takes the entry of one decoded frame, and throws when its packet recorded none. */
    takeFrameMetadata: (timestampMicroseconds: number) => OwnedVideoFrameMetadata
};

export type OwnedVideoPacketIterator = {
    next: () => Promise<IteratorResult<EncodedPacket>>
};

export type OwnedVideoStreamProgressPhase =
    | 'video-decoder-ready'
    | 'video-packet-decoded'
    | 'video-packet-started';

/** The decode run an owned stream belongs to: its frame credits, its stop state, and where its frames go. */
export type OwnedVideoStreamRun = {
    /** Waits for the GPU's decode of a frame; without it, a preroll reads on at the pace the decoder returns frames. */
    decodeFence?: VideoDecodeFence
    /** Returns whether the run or only its current video attempt must unwind. */
    isStopped: () => boolean
    notifyDecoderProgress: () => void
    /** Takes ownership of both outputs, which it posts or closes. */
    postFrame: (output: OwnedDecodedVideoOutput, enhancementOutput: OwnedDecodedVideoOutput | null) => Promise<void>
    postStartupProgress: (
        phase: OwnedVideoStreamProgressPhase,
        packetCount: number,
        mediaTimeMicroseconds: Microseconds
    ) => void
    /** Resolves after the given time; the packet pacing waits on it. */
    sleep: (milliseconds: number) => Promise<void>
    /** Resolves at the next decoder output, error, or dequeue, or when the run stops. */
    waitForDecoderProgress: () => Promise<void>
    /** Takes one frame credit; false when the run stopped first. */
    waitForFrameCredit: () => Promise<boolean>
};

export type OwnedVideoPacketDecoder = (packet: EncodedPacket, packetMediaTimeMicroseconds: Microseconds) => Promise<boolean>;

/** One packet after its metadata was recorded in decode order. */
export type ProcessedOwnedVideoPacket = {
    /**
     * The packet without the metadata the decoder must not see; the input packet when it carried none.
     * Its data is the input's, a view of it, or a buffer allocated for this decode alone.
     */
    decoderPacket: EncodedPacket
    /** Whether the decoder outputs a frame, which takes the packet's metadata entry */
    hasFrame: boolean
};

/** Records one packet's metadata for its frame and returns what the decoder takes. */
export type OwnedVideoPacketProcessor = (packet: EncodedPacket) => Promise<ProcessedOwnedVideoPacket>;

type OwnedOutputPostResult = 'none' | 'posted' | 'stopped';

/** Reads a decoded source's integer microsecond timestamp and duration. */
export function getOwnedDecodedVideoTiming(source: OwnedDecodedVideoSource): {
    durationMicroseconds: Microseconds
    mediaTimeMicroseconds: Microseconds
} {
    let durationMicrosecondsValue: number;
    let mediaTimeMicrosecondsValue: number;
    switch (source.kind) {
        case 'native-frame':
            durationMicrosecondsValue = source.frame.duration ?? 0;
            mediaTimeMicrosecondsValue = source.frame.timestamp;
            break;
        case 'video-sample':
            durationMicrosecondsValue = source.sample.microsecondDuration;
            mediaTimeMicrosecondsValue = source.sample.microsecondTimestamp;
            break;
    }
    const durationMicroseconds = requireMicroseconds(durationMicrosecondsValue, 'Owned decoded video frame duration');
    if (durationMicroseconds < 0) {
        throw new RangeError('Owned decoded video frame duration must not be negative');
    }
    return {
        durationMicroseconds,
        mediaTimeMicroseconds: requireMicroseconds(mediaTimeMicrosecondsValue, 'Owned decoded video frame timestamp')
    };
}

export function closeOwnedDecodedVideoSource(source: OwnedDecodedVideoSource | null): void {
    try {
        switch (source?.kind) {
            case 'native-frame':
                source.frame.close();
                break;
            case 'video-sample':
                source.sample.close();
                break;
        }
    } catch {
        // Ownership ends even when a decoder implementation throws while closing
    }
}

export function closeOwnedDecodedVideoOutput(output: OwnedDecodedVideoOutput | null): void {
    closeOwnedDecodedVideoSource(output?.source ?? null);
}

/**
 * Matches each decoded frame with its Dolby Vision entry, then with its HDR10+ entry.
 * A path without a Dolby Vision queue gives every frame none.
 */
export function createOwnedVideoFrameMetadataSource(
    dolbyVisionMetadataQueue: DolbyVisionEncodedMetadataQueue | DolbyVisionAV1EncodedMetadataQueue | null,
    dynamicHDRMetadataQueue: HDR10PlusFrameMetadataQueue
): OwnedVideoFrameMetadataSource {
    return {
        clear: (): void => {
            dolbyVisionMetadataQueue?.clear();
            dynamicHDRMetadataQueue.clear();
        },
        requireDrained: (): void => {
            dolbyVisionMetadataQueue?.requireDrained();
            dynamicHDRMetadataQueue.requireDrained();
        },
        takeFrameMetadata: (timestampMicroseconds: number): OwnedVideoFrameMetadata => ({
            encodedDolbyVisionMetadata: dolbyVisionMetadataQueue?.takeFrameMetadata(timestampMicroseconds) ?? null,
            HDR10PlusMetadata: dynamicHDRMetadataQueue.takeFrameMetadata(timestampMicroseconds)
        })
    };
}

/** Returns the format and geometry a decoded source's raw copy reads. */
function getDecodedSourceFormatAndGeometry(source: OwnedDecodedVideoSource): {
    format: string | null
    geometry: RawVideoFrameGeometry
} {
    switch (source.kind) {
        case 'native-frame':
            return { format: source.frame.format, geometry: source.geometry };
        case 'video-sample':
            // A sample reports the geometry its raw copy source takes, with square-pixel display dimensions
            return {
                format: source.sample.format,
                geometry: {
                    codedHeight: source.sample.codedHeight,
                    codedWidth: source.sample.codedWidth,
                    displayHeight: source.sample.squarePixelHeight,
                    displayWidth: source.sample.squarePixelWidth
                }
            };
    }
}

/** Returns whether a decoded EL has the format and geometry the compound raw copy requires of it. */
function isComposableEnhancementSource(source: OwnedDecodedVideoSource, expectedGeometry: RawVideoFrameGeometry): boolean {
    const { format, geometry } = getDecodedSourceFormatAndGeometry(source);
    // A null format is opaque, so the copy's requested format decides, as it does for the BL
    return (format === null || format === RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT)
        && geometry.codedWidth === expectedGeometry.codedWidth
        && geometry.codedHeight === expectedGeometry.codedHeight
        && geometry.displayWidth === expectedGeometry.displayWidth
        && geometry.displayHeight === expectedGeometry.displayHeight;
}

/**
 * The codec-neutral state of one owned decode attempt: decoded outputs matched with their packets' metadata, the pre-start rule, BL and EL pairing, the held frame credit, and decoder failures.
 */
export class OwnedVideoStreamState {
    private decoderFailure: unknown = null;
    private enhancementDecoderFailed = false;
    private readonly framePairs = new DolbyVisionFramePairQueue<
        OwnedDecodedVideoOutput,
        OwnedDecodedVideoOutput
    >(closeOwnedDecodedVideoOutput, closeOwnedDecodedVideoOutput);
    private decodedOutputCount = 0;
    private firstPresentationOutputQueued = false;
    private frameCreditHeld = false;
    private preStartOutput: OwnedDecodedVideoOutput | null = null;
    private preStartOutputCount = 0;
    private decodeFencePrepared = false;
    // The fences of the preroll's batches, oldest first, and the fence of the frame that ends the preroll
    private readonly prerollFences: Promise<void>[] = [];
    private firstPresentationFence: Promise<void> | null = null;
    public packetsEnded = false;

    /** The EL geometry is null for a stream without an EL. */
    public constructor(
        private readonly stream: OwnedVideoStreamRun,
        private readonly frameMetadata: OwnedVideoFrameMetadataSource,
        private readonly startTimeMicroseconds: Microseconds,
        private readonly enhancementLayerGeometry: RawVideoFrameGeometry | null
    ) {
        if (!enhancementLayerGeometry) {
            this.framePairs.finishEnhancement();
        }
    }

    public recordDecoderFailure(error: unknown): void {
        this.decoderFailure ??= error;
    }

    public recordEnhancementDecoderFailure(): void {
        if (this.enhancementDecoderFailed) {
            return;
        }
        this.enhancementDecoderFailed = true;
        this.framePairs.finishEnhancement();
    }

    public canDecodeEnhancement(): boolean {
        return this.enhancementLayerGeometry !== null && !this.enhancementDecoderFailed;
    }

    /**
     * Takes one decoded BL output with its packet's metadata.
     * Outputs before the start time are dropped except the latest one, which leads the first presented frame, so presentation does not start late;
     * a frame at the start time itself presents first, and then nothing before it does.
     */
    public enqueueDecodedOutput(source: OwnedDecodedVideoSource): void {
        // Counted before any check, so an output that fails or precedes the start still ends a pacing wait
        this.decodedOutputCount += 1;
        let decodedOutput: OwnedDecodedVideoOutput | null = null;
        let sourceOwned = true;
        try {
            const timing = getOwnedDecodedVideoTiming(source);
            recordTimingEvent('video-decoded', { mediaTimeMicroseconds: timing.mediaTimeMicroseconds });
            const frameMetadata = this.frameMetadata.takeFrameMetadata(timing.mediaTimeMicroseconds);
            decodedOutput = {
                durationMicroseconds: timing.durationMicroseconds,
                encodedDolbyVisionMetadata: frameMetadata.encodedDolbyVisionMetadata,
                HDR10PlusMetadata: frameMetadata.HDR10PlusMetadata,
                mediaTimeMicroseconds: timing.mediaTimeMicroseconds,
                source
            };
            sourceOwned = false;
            if (timing.mediaTimeMicroseconds < this.startTimeMicroseconds && !this.firstPresentationOutputQueued) {
                closeOwnedDecodedVideoOutput(this.preStartOutput);
                this.preStartOutput = decodedOutput;
                decodedOutput = null;
                this.preStartOutputCount += 1;
                if (this.preStartOutputCount % OWNED_VIDEO_PREROLL_BATCH_FRAME_COUNT === 0) {
                    this.prerollFences.push(this.startDecodeFence(source));
                }
                return;
            }

            this.queueFirstPresentationOutput(decodedOutput);
            this.queueBaseOutput(decodedOutput);
            decodedOutput = null;
        } finally {
            closeOwnedDecodedVideoOutput(decodedOutput);
            if (sourceOwned) {
                closeOwnedDecodedVideoSource(source);
            }
        }
    }

    /**
     * Takes one decoded EL output.
     * An EL in a format or geometry no compound copy takes leaves the stream to its BL, as a failed EL decoder does.
     */
    public enqueueEnhancementDecodedOutput(source: OwnedDecodedVideoSource): void {
        let decodedOutput: OwnedDecodedVideoOutput | null = null;
        let sourceOwned = true;
        try {
            const expectedGeometry = this.enhancementLayerGeometry;
            if (!expectedGeometry || !this.canDecodeEnhancement()) {
                return;
            }
            if (!isComposableEnhancementSource(source, expectedGeometry)) {
                this.recordEnhancementDecoderFailure();
                return;
            }
            const timing = getOwnedDecodedVideoTiming(source);
            decodedOutput = {
                durationMicroseconds: timing.durationMicroseconds,
                encodedDolbyVisionMetadata: null,
                mediaTimeMicroseconds: timing.mediaTimeMicroseconds,
                source
            };
            sourceOwned = false;
            this.framePairs.enqueueEnhancementFrame({
                frame: decodedOutput,
                mediaTimeMicroseconds: decodedOutput.mediaTimeMicroseconds
            });
            decodedOutput = null;
        } finally {
            closeOwnedDecodedVideoOutput(decodedOutput);
            if (sourceOwned) {
                closeOwnedDecodedVideoSource(source);
            }
        }
    }

    /** Queues one EL packet; an EL decoder that refuses a picture or throws leaves the stream to its BL. */
    public decodeEnhancementPacket(
        enhancementPacket: EncodedPacket | null,
        hasEnhancementPicture: boolean,
        enhancementDecoder: OwnedVideoDecoderPort | null
    ): void {
        if (!enhancementPacket || !enhancementDecoder || !this.canDecodeEnhancement()) {
            return;
        }
        try {
            const packetAccepted = enhancementDecoder.decode(enhancementPacket);
            if (!packetAccepted && hasEnhancementPicture) {
                this.recordEnhancementDecoderFailure();
            }
        } catch {
            this.recordEnhancementDecoderFailure();
        }
    }

    /**
     * Queues one cleaned BL packet.
     * A frame the decoder drops, such as a leading RASL picture, gives back its packet's metadata.
     */
    public decodeBasePacket(
        sourcePacket: EncodedPacket,
        decoderPacket: EncodedPacket | null,
        hasFrame: boolean,
        decoder: OwnedVideoDecoderPort
    ): void {
        if (!decoderPacket) {
            return;
        }
        // The demuxer may keep reading its own buffer, so only a buffer the packet's processing allocated transfers
        const packetAccepted = decoder.decode(decoderPacket, decoderPacket.data.buffer !== sourcePacket.data.buffer);
        if (!packetAccepted && hasFrame) {
            this.frameMetadata.takeFrameMetadata(sourcePacket.microsecondTimestamp);
        }
    }

    public async finishPackets(decoder: OwnedVideoDecoderPort, enhancementDecoder: OwnedVideoDecoderPort | null): Promise<void> {
        // The flush releases frames the decoders hold beyond the intake bound, such as reorder-held pictures
        this.framePairs.beginFinalDrain();
        await decoder.flush();
        this.throwDecoderFailure();
        if (enhancementDecoder && this.canDecodeEnhancement()) {
            try {
                await enhancementDecoder.flush();
            } catch {
                this.recordEnhancementDecoderFailure();
            }
        }
        if (this.enhancementLayerGeometry) {
            this.framePairs.finishEnhancement();
        }
        this.frameMetadata.requireDrained();
        this.queueFirstPresentationOutput(null);
        this.packetsEnded = true;
    }

    public async postNextOutput(): Promise<OwnedOutputPostResult> {
        // A recorded failure surfaces before any further frame is posted
        this.throwDecoderFailure();
        if (!this.framePairs.hasReadyPair()) {
            return 'none';
        }
        if (!await this.acquireFrameCredit()) {
            return 'stopped';
        }
        if (!await this.waitForPrerollEnd()) {
            return 'stopped';
        }

        const framePair = this.framePairs.takeReadyPair();
        if (!framePair) {
            throw new Error('A ready frame pair must stay queued while its frame credit is acquired');
        }
        await this.stream.postFrame(framePair.baseFrame, framePair.enhancementFrame);
        this.frameCreditHeld = false;
        return 'posted';
    }

    public async acquireFrameCredit(): Promise<boolean> {
        if (!this.frameCreditHeld) {
            this.frameCreditHeld = await this.stream.waitForFrameCredit();
        }
        return this.frameCreditHeld;
    }

    public async waitForDecoderProgress(): Promise<void> {
        this.throwDecoderFailure();
        if (this.framePairs.hasReadyPair() || this.stream.isStopped()) {
            return;
        }
        await this.stream.waitForDecoderProgress();
        this.throwDecoderFailure();
    }

    /** Returns how many BL outputs the decoder has returned, including those dropped before the start. */
    public getDecodedOutputCount(): number {
        return this.decodedOutputCount;
    }

    /**
     * Waits until the decoder returns an output after the given count, the run stops, a decoder fails, or the pacing bound passes.
     * Reading on at once would hand a hardware decoder a whole group of pictures, whose decode then delays presentation on the same GPU.
     * A decoder that needs further pictures to reorder before its next output gets the next packet once the bound passes.
     */
    public async waitForPacedOutput(decodedOutputCountBeforePacket: number): Promise<void> {
        let pacingElapsed = false;
        const pacing = this.stream.sleep(OWNED_VIDEO_PACKET_PACING_MILLISECONDS).then((): void => {
            pacingElapsed = true;
        });
        while (
            !pacingElapsed
            && this.decodedOutputCount === decodedOutputCountBeforePacket
            && this.decoderFailure === null
            && !this.stream.isStopped()
        ) {
            await Promise.race([ this.stream.waitForDecoderProgress(), pacing ]);
        }
    }

    /** Creates the decode fence ahead of a preroll, which an attempt whose first packet precedes its start time decodes; later packets change nothing. */
    public prepareDecodeFence(packetMediaTimeMicroseconds: Microseconds): void {
        if (this.decodeFencePrepared) {
            return;
        }
        this.decodeFencePrepared = true;
        if (packetMediaTimeMicroseconds < this.startTimeMicroseconds) {
            this.stream.decodeFence?.prewarm();
        }
    }

    /**
     * Waits, during a preroll, until the decoder is at most two batches ahead of the GPU: the oldest batch's frames must be decoded on the GPU
     * before the decoder takes a packet past the next batch.
     * Reading on at the pace the decoder returns frames would queue the whole preroll's decode work on the GPU, where the first presented frame waits behind it.
     */
    public async waitForPrerollBatches(): Promise<void> {
        while (this.prerollFences.length >= OWNED_VIDEO_PREROLL_BATCHES_AHEAD) {
            await this.waitForDecodeFences(this.prerollFences.splice(0, 1));
        }
    }

    public close(): void {
        closeOwnedDecodedVideoOutput(this.preStartOutput);
        this.preStartOutput = null;
        this.framePairs.close();
        this.frameMetadata.clear();
    }

    public throwDecoderFailure(): void {
        if (this.decoderFailure) {
            throw this.decoderFailure;
        }
    }

    private queueBaseOutput(decodedOutput: OwnedDecodedVideoOutput): void {
        this.framePairs.enqueueBaseFrame({
            frame: decodedOutput,
            mediaTimeMicroseconds: decodedOutput.mediaTimeMicroseconds
        });
    }

    /** Queues the frame that leads presentation, before the first output at or after the start, or null at the end of the track. */
    private queueFirstPresentationOutput(firstOutput: OwnedDecodedVideoOutput | null): void {
        if (this.firstPresentationOutputQueued) {
            return;
        }
        this.firstPresentationOutputQueued = true;
        let leadingOutput = this.preStartOutput;
        this.preStartOutput = null;
        if (leadingOutput && firstOutput && firstOutput.mediaTimeMicroseconds <= this.startTimeMicroseconds) {
            closeOwnedDecodedVideoOutput(leadingOutput);
            leadingOutput = null;
        }
        const firstPresentedOutput = leadingOutput ?? firstOutput;
        if (this.preStartOutputCount > 0 && firstPresentedOutput) {
            // The frame that ends a preroll posts once the GPU decoded it, so its presentation never waits behind the preroll's decode work
            this.firstPresentationFence = this.startDecodeFence(firstPresentedOutput.source);
        }
        if (leadingOutput) {
            this.queueBaseOutput(leadingOutput);
        }
    }

    /** Waits, before the first post, for the GPU to decode the preroll and the frame that ends it; false when the run stopped meanwhile. */
    private async waitForPrerollEnd(): Promise<boolean> {
        const fence = this.firstPresentationFence;
        if (fence === null) {
            return true;
        }
        this.firstPresentationFence = null;
        await this.waitForDecodeFences([ ...this.prerollFences.splice(0), fence ]);
        return !this.stream.isStopped();
    }

    /** Starts a fence on a decoded frame's decode, which ends when the GPU decoded it or when the fence bound passes. */
    private startDecodeFence(source: OwnedDecodedVideoSource): Promise<void> {
        const fence = this.stream.decodeFence;
        if (!fence || source.kind !== 'native-frame') {
            return Promise.resolve();
        }
        let frame: VideoFrame;
        try {
            frame = source.frame.clone();
        } catch {
            // A frame the decoder already closed has nothing left to wait for
            return Promise.resolve();
        }
        return Promise.race([ fence.wait(frame), this.stream.sleep(OWNED_VIDEO_DECODE_FENCE_TIMEOUT_MILLISECONDS) ]);
    }

    /** Waits for decode fences, recording the wait as a `video-decode-fence` when a timing trace runs. */
    private async waitForDecodeFences(fences: readonly Promise<void>[]): Promise<void> {
        const startedAt = startTimingWait();
        await Promise.all(fences);
        if (startedAt !== null) {
            recordTimingWait('video-decode-fence', startedAt, { fenceCount: fences.length });
        }
    }
}

function isOwnedVideoDecoderBackpressured(
    decoder: OwnedVideoDecoderPort,
    enhancementDecoder: OwnedVideoDecoderPort | null,
    state: OwnedVideoStreamState
): boolean {
    if (decoder.getDecodeQueueSize() >= OWNED_VIDEO_DECODE_QUEUE_HIGH_WATER_MARK) {
        return true;
    }
    return state.canDecodeEnhancement()
        && enhancementDecoder !== null
        && enhancementDecoder.getDecodeQueueSize() >= OWNED_VIDEO_DECODE_QUEUE_HIGH_WATER_MARK;
}

/** Reads the next packet, recording the wait as a `video-read` when a timing trace runs. */
export async function readNextVideoPacket(packetIterator: OwnedVideoPacketIterator): Promise<IteratorResult<EncodedPacket>> {
    const readStartedAt = startTimingWait();
    const packetResult = await packetIterator.next();
    if (readStartedAt !== null) {
        recordTimingWait('video-read', readStartedAt, {
            mediaTimeMicroseconds: packetResult.done ? null : packetResult.value.microsecondTimestamp,
            source: 'packet'
        });
    }
    return packetResult;
}

/**
 * Pumps one owned attempt until it stops or every frame is posted.
 * Ready frames are posted first.
 * A packet is read only while a frame credit is held and the decoders are under their queue bound.
 * Each packet then waits, up to the pacing bound, for the decoder to return a picture, so decode work follows presentation instead of arriving in bursts.
 * A preroll, whose frames precede the start and never present, reads at the pace the decoder returns frames, in batches the GPU must keep up with.
 * The end of the track flushes the decoders.
 */
export async function pumpOwnedVideoFrames(
    stream: OwnedVideoStreamRun,
    packetIterator: OwnedVideoPacketIterator,
    decoder: OwnedVideoDecoderPort,
    enhancementDecoder: OwnedVideoDecoderPort | null,
    state: OwnedVideoStreamState,
    decodePacket: OwnedVideoPacketDecoder
): Promise<void> {
    let packetCount = 0;
    while (!stream.isStopped()) {
        const postResult = await state.postNextOutput();
        switch (postResult) {
            case 'posted':
                continue;
            case 'stopped':
                return;
            case 'none':
                break;
        }

        if (state.packetsEnded) {
            return;
        }
        if (isOwnedVideoDecoderBackpressured(decoder, enhancementDecoder, state)) {
            await state.waitForDecoderProgress();
            continue;
        }
        if (!await state.acquireFrameCredit()) {
            return;
        }
        await state.waitForPrerollBatches();

        const packetResult = await readNextVideoPacket(packetIterator);
        if (stream.isStopped()) {
            return;
        }
        if (packetResult.done) {
            await state.finishPackets(decoder, enhancementDecoder);
            continue;
        }
        packetCount += 1;
        const packetMediaTimeMicroseconds = requireMicroseconds(
            packetResult.value.microsecondTimestamp,
            'Owned video packet timestamp'
        );
        state.prepareDecodeFence(packetMediaTimeMicroseconds);
        stream.postStartupProgress('video-packet-started', packetCount, packetMediaTimeMicroseconds);
        const decodedOutputCountBeforePacket = state.getDecodedOutputCount();
        if (!await decodePacket(packetResult.value, packetMediaTimeMicroseconds)) {
            return;
        }
        stream.postStartupProgress('video-packet-decoded', packetCount, packetMediaTimeMicroseconds);
        await state.waitForPacedOutput(decodedOutputCountBeforePacket);
    }
}

/**
 * Runs one attempt of a single-layer owned decode path, from the key packet the iterator starts at.
 * Each packet's metadata is recorded in decode order before decode and travels with the packet's frame.
 * The caller owns the packet iterator.
 */
export async function runOwnedSingleLayerVideoStream(
    stream: OwnedVideoStreamRun,
    packetIterator: OwnedVideoPacketIterator,
    frameMetadata: OwnedVideoFrameMetadataSource,
    processPacket: OwnedVideoPacketProcessor,
    createDecoder: (callbacks: OwnedVideoDecoderCallbacks) => OwnedVideoDecoderPort,
    startTimeMicroseconds: Microseconds,
    keyPacketMediaTimeMicroseconds: Microseconds
): Promise<void> {
    const state = new OwnedVideoStreamState(stream, frameMetadata, startTimeMicroseconds, null);
    const decoder = createDecoder({
        onError: (error: unknown): void => {
            state.recordDecoderFailure(error);
            stream.notifyDecoderProgress();
        },
        onOutput: (output: OwnedDecodedVideoSource): void => {
            state.enqueueDecodedOutput(output);
        },
        onProgress: (): void => {
            stream.notifyDecoderProgress();
        }
    });
    const decodePacket = async (packet: EncodedPacket): Promise<boolean> => {
        const processedPacket = await processPacket(packet);
        state.decodeBasePacket(packet, processedPacket.decoderPacket, processedPacket.hasFrame, decoder);
        state.throwDecoderFailure();
        return true;
    };
    try {
        await decoder.init();
        stream.postStartupProgress('video-decoder-ready', 0, keyPacketMediaTimeMicroseconds);
        await pumpOwnedVideoFrames(stream, packetIterator, decoder, null, state, decodePacket);
    } finally {
        // Close the decoder first: an output arriving later would otherwise land in the cleared queue and leak
        decoder.close();
        state.close();
    }
}
