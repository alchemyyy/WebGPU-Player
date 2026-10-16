// The page's side of the frame-pool route: it feeds the worker's compressed packets to a GPU decode session on the presenter's device, paces the decode work, and hands decoded pool slots to the frame queue.
// A session outlives generations while its decoder and stream stay the same, so a seek or a track switch keeps its compiled pipelines and its pool.
// A picture its session cannot hold, of another output format or of a larger sequence, starts a stream change: a session made for it takes over from that picture,
// once the session before it decoded and presented its own pictures. The engine book's decoder packages chapter describes it.
import type { Microseconds } from '../../../MediaTime';
import { isSameDecoderPackageVersion } from '../../packages/DecoderPackageIdentity';
import type { DecodedFramePoolPresentationFrame } from '../../../presentation/WebGPUPresenter';
import { requireMicroseconds } from '../../../TimeMath';
import type { VideoFrameFields } from '../VideoFields';
import { getGPUDecoderFormatFacts, type GPUDecoderOutputFormat } from './GPUDecodeFormats';
import { chooseGPUDecodeSessionStream } from './GPUDecoderStreamFit';
import {
    describeGPUVideoDecodeRecovery,
    GPU_DECODER_OUTPUT_EVENT,
    GPUVideoDecodeError,
    type GPUDecodePacket,
    type GPUDecoderPictureSize,
    type GPUDecodeStreamFacts,
    type GPUVideoDecodeFailure,
    type GPUVideoDecodeRecovery,
    type GPUVideoDecodeRecoveryCount
} from './GPUDecodeTypes';
import type { GPUVideoDecoderSelection } from './GPUVideoDecoderCatalog';
import type GPUVideoDecodeSession from './GPUVideoDecodeSession';
import type { GPUDecodedFrame } from './GPUVideoDecodeSession';
import type { HDR10PlusFrameMetadata } from '../../../demux/hdr/HDR10PlusMetadata';

// A picture index at most half the index range behind a picture is an earlier one
const PICTURE_INDEX_HALF_RANGE = GPU_DECODER_OUTPUT_EVENT.pictureIndexModulus / 2;
// Packets whose decode work may be in flight at once: the second keeps the GPU busy while the page learns that the first completed,
// and a presentation submit queues behind no more than these
const MAXIMUM_IN_FLIGHT_PACKETS = 2;

/**
 * What a frame-pool generation's GPU decode session decodes: the decoder, its output format, the track's codec private data, and the pool's stream facts,
 * which the container's size gives, and the largest picture the decoder's parser read in the codec private data, which may size the pool instead.
 * A stream change's request names the picture's requirement as its largest picture, and the pool it falls back to.
 */
export type GPUVideoDecodeSessionRequest = Readonly<{
    codecPrivate: Uint8Array | null
    decoder: GPUVideoDecoderSelection
    /**
     * For a stream change, the picture size the session takes when the decoder or the device refuses maximumPictureSize alone: the pool before it, grown to the picture.
     * Absent or null for a first session, which takes the larger of the stream's size and maximumPictureSize, or the stream's.
     */
    fallbackPictureSize?: GPUDecoderPictureSize | null
    format: GPUDecoderOutputFormat
    maximumPictureSize: GPUDecoderPictureSize | null
    stream: GPUDecodeStreamFacts
}>;

/** A created GPU decode session, the device it runs on, and how its decoder's status errors read. */
export type GPUVideoDecodeHandle = Readonly<{
    describeDecoderError: (errorWord: number) => string
    device: GPUDevice
    session: GPUVideoDecodeSession
}>;

/** Creates a frame-pool generation's GPU decode session; rejects with a GPUVideoDecodeError that names the failed check. */
export type GPUVideoDecodeSessionFactory = (request: GPUVideoDecodeSessionRequest) => Promise<GPUVideoDecodeHandle>;

/**
 * A compressed packet the worker posted for the GPU decoder, or the GPU record of one picture the decoder's parser made of a packet, with its output events,
 * or a held packet, whose picture the parser lost and whose frame repeats the last good frame.
 */
export type GPUVideoDecodeFeedPacket = Readonly<{
    data: ArrayBuffer
    durationMicroseconds: Microseconds
    /** The picture's fields as the worker knew them, its parser's or its container's, or null; its decoder's own report replaces them */
    fields: VideoFrameFields | null
    /** The output format the picture decodes into, or null for its session's */
    format: GPUDecoderOutputFormat | null
    HDR10PlusMetadata: HDR10PlusFrameMetadata | null
    /** A packet whose picture its parser lost, which decodes nothing */
    hold: boolean
    keyframe: boolean
    /** The largest picture of the picture's sequence, or null for none reported */
    maximumPictureSize: GPUDecoderPictureSize | null
    /** The parser's output events since the previous picture, or null for a decoder without a parser */
    outputEvents: Uint32Array | null
    /** The recovery a held packet begins, such as the parser failure that lost its picture, or null */
    recovery: GPUVideoDecodeRecovery | null
    /** How many times the picture's record runs each repeat of the decoder's header, or null for the header's counts */
    repeatCounts: readonly number[] | null
    /** The first picture of a parser that restarted after a failure, which numbers its pictures from 0 and resets the decoder */
    reset: boolean
    timestampMicroseconds: Microseconds
    /** The picture's own visible size, or null for the stream's visible rectangle */
    visibleSize: GPUDecoderPictureSize | null
}>;

/** The size presentation fits a frame by: the container's display size, which carries the pixel aspect ratio. */
export type GPUVideoDecodeDisplaySize = Readonly<{
    displayHeight: number
    displayWidth: number
}>;

/** How a generation hears from the feed; each callback concerns only the generation that started the feed. */
export type GPUVideoDecodeFeedCallbacks = Readonly<{
    /** Returns the credits of packets whose decode work was submitted, or that a new video epoch dropped */
    onCreditsReleased: (credits: number) => void
    /** Ends the generation, with a terse `<code>: <detail>` of the failed check */
    onFailure: (detail: string) => void
    /** Hands a decoded frame to the frame queue; frames of one video epoch arrive in presentation order */
    onFrame: (frame: DecodedFramePoolPresentationFrame) => void
    /** Every frame of the ended video epoch has left the decoder */
    onVideoDrained: () => void
}>;

/** The feed's state for diagnostics. */
export type GPUVideoDecodeFeedTelemetry = Readonly<{
    /** The decoder's manifest name, such as `HEVC I420P10` */
    decoderName: string | null
    /** The failed check as `<code>: <detail>`, or null */
    failure: string | null
    freeSlotCount: number | null
    /** Decoded frames the decoder still holds back for reordering */
    heldBackFrameCount: number
    /** Packets on the page that wait for the decoder */
    queuedPacketCount: number
    /** Recoveries since the page loaded, counted per code and error name, each with its latest detail, in the order each kind first happened */
    recoveries: readonly GPUVideoDecodeRecoveryCount[]
    /** Session reuses since the page loaded, each one a seek or a restart that kept the compiled decoder */
    reuseCount: number
    slotCount: number | null
    state: 'creating' | 'failed' | 'idle' | 'ready'
    /** Stream changes since the page loaded, each one a session made mid-stream for a picture its predecessor could not hold */
    streamChangeCount: number
    submittedPacketCount: number
}>;

/** A queued picture's packet and the parser's index of the picture, which a stream change at it continues the numbering from. */
type QueuedPicture = Readonly<{
    packet: GPUVideoDecodeFeedPacket
    pictureIndex: number
}>;

/**
 * A stream change: the session a picture needs, created while the session before it decodes on, and the packets from that picture on,
 * which wait until the session before it decoded its own.
 */
type StreamChange = {
    /** The parser's index of the change's first picture, which the new session's picture numbering continues from */
    firstPictureIndex: number
    /** The created session, or null while it is created */
    handle: GPUVideoDecodeHandle | null
    /** The packets its session decodes, each judged against its pool */
    packets: GPUVideoDecodeFeedPacket[]
    /** The session before the change was told its packets are complete */
    previousSessionEnded: boolean
    /** The first picture's events that name earlier pictures, which the session before the change applies before its undecided frames present */
    previousSessionEvents: Uint32Array | null
    request: GPUVideoDecodeSessionRequest
    /** Pictures queued while its session is created, judged once its pool exists */
    unjudgedPictures: QueuedPicture[]
};

/** One generation's use of the feed. */
type FeedGeneration = {
    callbacks: GPUVideoDecodeFeedCallbacks
    displaySize: GPUVideoDecodeDisplaySize | null
    /** The epoch's last frame left the decoder after its end */
    drained: boolean
    failed: boolean
    /** Each packet's HDR10+ state, keyed by its timestamp, until its frame leaves the decoder */
    frameMetadata: Map<number, HDR10PlusFrameMetadata>
    /** The parser's index of the next queued picture, counted from the epoch's first, as the session numbers them */
    nextPictureIndex: number
    /** The next packet starts a new decoder epoch */
    resetPending: boolean
    /** Stream changes in picture order, each waiting for the session before it */
    streamChanges: StreamChange[]
    videoEnded: boolean
    /** The parser's output events that came with the epoch's end, for its last packets without a picture */
    videoEndEvents: Uint32Array | null
    videoEpoch: number
    /** Pictures that wait for the session to be created, judged once its pool exists */
    waitingPictures: QueuedPicture[]
};

/** A frame the frame queue holds, and the session whose slot it is. */
type HeldFrame = {
    decodedFrame: GPUDecodedFrame
    handle: GPUVideoDecodeHandle
};

/** A picture's output events split at its own index: those naming earlier pictures, and the rest. */
type SplitOutputEvents = Readonly<{
    earlier: Uint32Array | null
    own: Uint32Array | null
}>;

/** Describes a session failure as `<code>: <detail>`, a decoder's status error by its decoder's names. */
function describeSessionFailure(failure: GPUVideoDecodeFailure, handle: GPUVideoDecodeHandle): string {
    if (failure.code === 'decoder-error') {
        return `${failure.code}: ${handle.describeDecoderError(Number(failure.detail))}`;
    }
    return `${failure.code}: ${failure.detail}`;
}

/** Describes why a session could not be created as `<code>: <detail>`. */
function describeCreationFailure(error: unknown): string {
    if (error instanceof GPUVideoDecodeError) {
        return `${error.failure.code}: ${error.failure.detail}`;
    }
    return `session-creation-failed: ${error instanceof Error ? error.message : String(error)}`;
}

function haveSameBytes(first: Uint8Array | null, second: Uint8Array | null): boolean {
    if (first === null || second === null) {
        return first === second;
    }
    if (first.byteLength !== second.byteLength) {
        return false;
    }
    for (let index = 0; index < first.byteLength; index += 1) {
        if (first[index] !== second[index]) {
            return false;
        }
    }
    return true;
}

function haveSameSize(first: GPUDecoderPictureSize | null, second: GPUDecoderPictureSize | null): boolean {
    if (first === null || second === null) {
        return first === second;
    }
    return first.width === second.width && first.height === second.height;
}

/** Returns whether a session created for one request decodes another as well: the same version of the same decoder, format, codec private data, and pool. */
function canReuseSession(created: GPUVideoDecodeSessionRequest, requested: GPUVideoDecodeSessionRequest): boolean {
    const createdStream = created.stream;
    const requestedStream = requested.stream;
    return created.decoder.decoderId === requested.decoder.decoderId
        && isSameDecoderPackageVersion(created.decoder.package, requested.decoder.package)
        && created.decoder.codec === requested.decoder.codec
        && created.format === requested.format
        && createdStream.bitDepth === requestedStream.bitDepth
        && createdStream.codedHeight === requestedStream.codedHeight
        && createdStream.codedWidth === requestedStream.codedWidth
        && haveSameSize(created.maximumPictureSize, requested.maximumPictureSize)
        && haveSameSize(created.fallbackPictureSize ?? null, requested.fallbackPictureSize ?? null)
        && haveSameBytes(created.codecPrivate, requested.codecPrivate);
}

/** Returns the size a picture needs its pool to hold: the larger of its sequence's maximum and its own visible size on each axis, or null without either. */
function getRequiredPictureSize(packet: Pick<GPUVideoDecodeFeedPacket, 'maximumPictureSize' | 'visibleSize'>): GPUDecoderPictureSize | null {
    const maximum = packet.maximumPictureSize;
    const visible = packet.visibleSize;
    if (maximum === null || visible === null) {
        return maximum ?? visible;
    }
    return { height: Math.max(maximum.height, visible.height), width: Math.max(maximum.width, visible.width) };
}

/** Returns whether a size, null for none, fits a pool's coded size. */
function fitsPool(size: GPUDecoderPictureSize | null, pool: GPUDecoderPictureSize): boolean {
    return size === null || (size.width <= pool.width && size.height <= pool.height);
}

/** Returns a session's coded size, the pool its pictures decode into. */
function getSessionPool(handle: GPUVideoDecodeHandle): GPUDecoderPictureSize {
    const layout = handle.session.pool.layout;
    return { height: layout.codedHeight, width: layout.codedWidth };
}

/**
 * Returns the coded size the decoder's `accepts` lets a request's session take, as the factory chooses it when the device holds that pool,
 * or the failure of a stream change no pool of which the decoder takes.
 */
function foreseeSessionPool(request: GPUVideoDecodeSessionRequest): Readonly<{ failure: GPUVideoDecodeFailure } | { pool: GPUDecoderPictureSize }> {
    const choice = chooseGPUDecodeSessionStream(
        request.decoder.package.manifest,
        request.format,
        request.stream,
        request.maximumPictureSize,
        null,
        request.fallbackPictureSize ?? null
    );
    return choice.kind === 'refused' ? { failure: choice.failure } : { pool: { height: choice.stream.codedHeight, width: choice.stream.codedWidth } };
}

/**
 * Returns the session request a picture needs when `currentPool`, the coded size of the pool its pictures decode into, cannot hold it, or null when it can:
 * another output format, or a requirement beyond the pool, the larger of its sequence's largest picture and its own size.
 * The request keeps the decoder and the codec private data, and prefers the requirement alone, since the new session decodes only the new sequence's pictures;
 * it falls back to the current pool grown to the picture, as when the requirement is an absurd declared maximum the decoder refuses.
 * No request comes when nothing would change: the picture fits the pool and the requirement is one `current` asked for already, or the decoder refuses it.
 */
export function getGPUVideoDecodeStreamChange(
    current: GPUVideoDecodeSessionRequest,
    currentPool: GPUDecoderPictureSize,
    packet: Pick<GPUVideoDecodeFeedPacket, 'format' | 'maximumPictureSize' | 'visibleSize'>
): GPUVideoDecodeSessionRequest | null {
    const format = packet.format ?? current.format;
    const requiredSize = getRequiredPictureSize(packet);
    const formatChanged = format !== current.format;
    if (!formatChanged && fitsPool(requiredSize, currentPool)) {
        return null;
    }
    const visible = packet.visibleSize;
    const fallbackPictureSize = visible === null ?
        currentPool :
        { height: Math.max(visible.height, currentPool.height), width: Math.max(visible.width, currentPool.width) };
    const request: GPUVideoDecodeSessionRequest = {
        ...current,
        fallbackPictureSize,
        format,
        maximumPictureSize: requiredSize,
        stream: { ...current.stream, bitDepth: getGPUDecoderFormatFacts(format).bitDepth }
    };
    if (formatChanged || !fitsPool(visible, currentPool)) {
        return request;
    }
    // The picture itself fits, so only its requirement could change the pool: not when the session asked for it already, nor when the decoder refuses it
    if (haveSameSize(requiredSize, current.maximumPictureSize)) {
        return null;
    }
    const foreseen = foreseeSessionPool(request);
    return 'pool' in foreseen && !haveSameSize(foreseen.pool, currentPool) ? request : null;
}

/** Splits a picture's output events at its index: those naming earlier pictures, which the session before a stream change applies, and the rest. */
function splitOutputEvents(events: Uint32Array | null, pictureIndex: number): SplitOutputEvents {
    if (events === null) {
        return { earlier: null, own: null };
    }
    const earlier: number[] = [];
    const own: number[] = [];
    for (const event of events) {
        const eventPictureIndex = event & GPU_DECODER_OUTPUT_EVENT.pictureIndexMask;
        const distance = (pictureIndex - eventPictureIndex + GPU_DECODER_OUTPUT_EVENT.pictureIndexModulus) % GPU_DECODER_OUTPUT_EVENT.pictureIndexModulus;
        if (distance > 0 && distance < PICTURE_INDEX_HALF_RANGE) {
            earlier.push(event);
        } else {
            own.push(event);
        }
    }
    return { earlier: Uint32Array.from(earlier), own: Uint32Array.from(own) };
}

/** Returns how many packets the stream changes hold, judged or still waiting for their sessions. */
function countStreamChangePackets(changes: readonly StreamChange[]): number {
    return changes.reduce((count: number, change: StreamChange): number => count + change.packets.length + change.unjudgedPictures.length, 0);
}

/**
 * Drives the frame-pool route's GPU decode session for one generation at a time.
 * At most MAXIMUM_IN_FLIGHT_PACKETS packets' decode work is in flight on the presenter's queue, so a presented frame waits behind no more decode than that;
 * each status readback that applies lets the next packet go.
 */
export default class GPUVideoDecodeFeed {
    private creationRequest: GPUVideoDecodeSessionRequest | null = null;
    private destroyed = false;
    private failure: string | null = null;
    private readonly factory: GPUVideoDecodeSessionFactory;
    private generation: FeedGeneration | null = null;
    private handle: GPUVideoDecodeHandle | null = null;
    private readonly heldFrames = new Map<DecodedFramePoolPresentationFrame, HeldFrame>();
    // Recoveries since the page loaded, keyed by code and error name
    private readonly recoveryCounts = new Map<string, GPUVideoDecodeRecoveryCount>();
    // Sessions a stream change replaced, kept until presentation releases their last frame
    private readonly retiredHandles = new Set<GPUVideoDecodeHandle>();
    private reuseCount = 0;
    // The session whose next status readback the feed waits for, so a replaced session's readback never pumps its successor
    private readbackWaitHandle: GPUVideoDecodeHandle | null = null;
    private sessionRequest: GPUVideoDecodeSessionRequest | null = null;
    private streamChangeCount = 0;
    private submittedPacketCount = 0;

    constructor(factory: GPUVideoDecodeSessionFactory) {
        this.factory = factory;
    }

    /** Starts a generation's use of the feed in its first video epoch; the previous generation's packets and undelivered frames are dropped. */
    start(callbacks: GPUVideoDecodeFeedCallbacks, videoEpoch: number): void {
        this.cancelStreamChanges();
        this.generation = {
            callbacks,
            displaySize: null,
            drained: false,
            failed: false,
            frameMetadata: new Map<number, HDR10PlusFrameMetadata>(),
            nextPictureIndex: 0,
            resetPending: true,
            streamChanges: [],
            videoEnded: false,
            videoEndEvents: null,
            videoEpoch,
            waitingPictures: []
        };
        this.failure = null;
        this.handle?.session.reset();
    }

    /**
     * Prepares the generation's session once the worker described the track, reusing the current session when it decodes the same stream.
     * Packets that arrive before the session exists wait for it.
     */
    configure(request: GPUVideoDecodeSessionRequest, displaySize: GPUVideoDecodeDisplaySize): void {
        const generation = this.generation;
        if (!generation || this.destroyed) {
            return;
        }
        generation.displaySize = displaySize;
        const handle = this.handle;
        const sessionRequest = this.sessionRequest;
        if (handle && sessionRequest && handle.session.getFailure() === null && canReuseSession(sessionRequest, request)) {
            this.reuseCount += 1;
            this.flushWaitingPictures(handle, generation);
            return;
        }
        this.releaseSession();
        this.creationRequest = request;
        // A factory that throws at once fails the generation as one that rejects does
        Promise.resolve().then((): Promise<GPUVideoDecodeHandle> => this.factory(request)).then(
            (createdHandle: GPUVideoDecodeHandle): void => {
                this.adoptSession(generation, request, createdHandle);
            },
            (error: unknown): void => {
                if (this.creationRequest === request) {
                    this.creationRequest = null;
                }
                if (this.generation === generation) {
                    this.failGeneration(generation, describeCreationFailure(error));
                }
            }
        );
    }

    /**
     * Takes one of the current video epoch's packets, in decode order.
     * A picture its session cannot hold starts a stream change; it and the packets after it wait for the session made for it.
     * A packet that resets, the first of a parser that restarted, numbers the pictures from 0 again, as that parser does.
     */
    queuePacket(packet: GPUVideoDecodeFeedPacket): void {
        const generation = this.generation;
        if (!generation || generation.failed) {
            return;
        }
        if (packet.HDR10PlusMetadata) {
            generation.frameMetadata.set(packet.timestampMicroseconds, packet.HDR10PlusMetadata);
        }
        if (packet.reset) {
            generation.nextPictureIndex = 0;
        }
        const pictureIndex = generation.nextPictureIndex;
        generation.nextPictureIndex = (pictureIndex + 1) % GPU_DECODER_OUTPUT_EVENT.pictureIndexModulus;
        if (this.routePicture(generation, { packet, pictureIndex })) {
            this.pump();
        }
    }

    /**
     * Starts a new video epoch for a resync or a suspension: queued packets drop and return their credits, frames the decoder holds back drop, and the next packet resets the decoder.
     * Frames already in the frame queue stay with it, which releases them.
     */
    beginVideoEpoch(videoEpoch: number): void {
        const generation = this.generation;
        if (!generation) {
            return;
        }
        const handle = this.handle;
        const changedPacketCount = countStreamChangePackets(generation.streamChanges);
        const droppedPacketCount = generation.waitingPictures.length + changedPacketCount + (handle ? handle.session.getPendingPacketCount() : 0);
        this.cancelStreamChanges();
        generation.waitingPictures.length = 0;
        generation.frameMetadata.clear();
        generation.nextPictureIndex = 0;
        generation.resetPending = true;
        generation.videoEnded = false;
        generation.videoEndEvents = null;
        generation.drained = false;
        generation.videoEpoch = videoEpoch;
        handle?.session.reset();
        if (droppedPacketCount > 0 && !generation.failed) {
            generation.callbacks.onCreditsReleased(droppedPacketCount);
        }
    }

    /**
     * Marks the current video epoch's packets complete, so the decoder releases the frames it holds back once it decoded them.
     * outputEvents are the parser's events for the epoch's last packets without a picture, which apply before that release.
     */
    endVideo(outputEvents: Uint32Array | null): void {
        const generation = this.generation;
        if (!generation || generation.videoEnded) {
            return;
        }
        generation.videoEnded = true;
        generation.videoEndEvents = outputEvents;
        const handle = this.handle;
        // A pending stream change ends its own session once it takes over
        if (handle && this.creationRequest === null && generation.streamChanges.length === 0) {
            handle.session.endOfStream(outputEvents);
            this.pump();
        }
    }

    /** Ends the frame queue's hold on a frame's slot; returns false for a frame the feed did not deliver or already took back. */
    releaseFrame(presentationFrame: DecodedFramePoolPresentationFrame): boolean {
        const heldFrame = this.heldFrames.get(presentationFrame);
        if (!heldFrame) {
            return false;
        }
        this.heldFrames.delete(presentationFrame);
        heldFrame.handle.session.releaseFrame(heldFrame.decodedFrame);
        if (this.retiredHandles.has(heldFrame.handle)) {
            this.destroyRetiredHandleIfReleased(heldFrame.handle);
            return true;
        }
        // A freed slot can be what the next packet waits for
        if (heldFrame.handle === this.handle) {
            this.pump();
        }
        return true;
    }

    /** Ends the generation's use of the feed; its queued packets and the frames the decoder holds back drop, and the session stays for the next generation. */
    stop(): void {
        this.cancelStreamChanges();
        this.generation = null;
        this.handle?.session.reset();
    }

    /** Ends the feed: every session it created is destroyed, the one being created and those a stream change replaced included. */
    destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.cancelStreamChanges();
        this.generation = null;
        this.releaseSession();
        for (const retiredHandle of this.retiredHandles) {
            retiredHandle.session.destroy();
        }
        this.retiredHandles.clear();
        this.heldFrames.clear();
    }

    getTelemetry(): GPUVideoDecodeFeedTelemetry {
        const handle = this.handle;
        const session = handle?.session ?? null;
        if (handle) {
            this.collectRecoveries(handle);
        }
        const changedPacketCount = countStreamChangePackets(this.generation?.streamChanges ?? []);
        let state: GPUVideoDecodeFeedTelemetry['state'] = 'idle';
        if (this.failure !== null) {
            state = 'failed';
        } else if (this.creationRequest !== null) {
            state = 'creating';
        } else if (session) {
            state = 'ready';
        }
        return {
            decoderName: session?.manifest.name ?? null,
            failure: this.failure,
            freeSlotCount: session?.getFreeSlotCount() ?? null,
            heldBackFrameCount: session?.getQueuedFrameCount() ?? 0,
            queuedPacketCount: (this.generation?.waitingPictures.length ?? 0) + changedPacketCount + (session?.getPendingPacketCount() ?? 0),
            recoveries: [ ...this.recoveryCounts.values() ],
            reuseCount: this.reuseCount,
            slotCount: session?.pool.layout.slotCount ?? null,
            state,
            streamChangeCount: this.streamChangeCount,
            submittedPacketCount: this.submittedPacketCount
        };
    }

    /** Installs a created session unless its generation or the feed ended meanwhile, and starts it on the packets that waited. */
    private adoptSession(generation: FeedGeneration, request: GPUVideoDecodeSessionRequest, handle: GPUVideoDecodeHandle): void {
        if (this.creationRequest !== request || this.destroyed) {
            handle.session.destroy();
            return;
        }
        this.creationRequest = null;
        this.handle = handle;
        this.sessionRequest = request;
        // A generation that ended while the session compiled leaves it for the next one
        if (this.generation === generation) {
            this.flushWaitingPictures(handle, generation);
        }
    }

    /**
     * Judges the pictures that waited for the session against its pool, which hands it those it holds and starts a stream change at the first it cannot,
     * then hands it its end when video ended meanwhile, unless a stream change will end it.
     */
    private flushWaitingPictures(handle: GPUVideoDecodeHandle, generation: FeedGeneration): void {
        for (const picture of generation.waitingPictures.splice(0)) {
            this.routePicture(generation, picture);
        }
        if (generation.videoEnded && generation.streamChanges.length === 0 && !generation.failed) {
            handle.session.endOfStream(generation.videoEndEvents);
        }
        this.pump();
    }

    /**
     * Hands a picture to the session whose pool decodes it, judged against that pool: the current session, the latest stream change's session,
     * or a new stream change's when that pool cannot hold it.
     * A picture queued while a session is created waits unjudged, since the device may give that session a smaller pool than its request foresees.
     * Returns whether the current session took the picture, which the caller then pumps.
     */
    private routePicture(generation: FeedGeneration, picture: QueuedPicture): boolean {
        if (generation.failed) {
            return false;
        }
        const latestChange = generation.streamChanges.at(-1) ?? null;
        if (latestChange !== null && latestChange.handle === null) {
            latestChange.unjudgedPictures.push(picture);
            return false;
        }
        const handle = latestChange?.handle ?? (this.creationRequest === null ? this.handle : null);
        const request = latestChange?.request ?? this.sessionRequest;
        if (!handle || !request) {
            generation.waitingPictures.push(picture);
            return false;
        }
        const changeRequest = getGPUVideoDecodeStreamChange(request, getSessionPool(handle), picture.packet);
        if (changeRequest) {
            this.beginStreamChange(generation, changeRequest, picture);
            return false;
        }
        if (latestChange) {
            latestChange.packets.push(picture.packet);
            return false;
        }
        this.submitPacket(handle, generation, picture.packet);
        return true;
    }

    /**
     * Starts creating the session a picture needs; the picture and the packets after it wait for it, and those queued meanwhile are judged against its pool once it exists.
     * The picture's events that name earlier pictures stay with the session before it, which applies them before it ends.
     * A change whose every pool the decoder's `accepts` refuses fails the generation with the refused check.
     */
    private beginStreamChange(generation: FeedGeneration, request: GPUVideoDecodeSessionRequest, picture: QueuedPicture): void {
        const foreseen = foreseeSessionPool(request);
        if ('failure' in foreseen) {
            this.failGeneration(generation, `${foreseen.failure.code}: ${foreseen.failure.detail}`);
            return;
        }
        const { earlier, own } = splitOutputEvents(picture.packet.outputEvents, picture.pictureIndex);
        const change: StreamChange = {
            firstPictureIndex: picture.pictureIndex,
            handle: null,
            packets: [ { ...picture.packet, outputEvents: own } ],
            previousSessionEnded: false,
            previousSessionEvents: earlier,
            request,
            unjudgedPictures: []
        };
        generation.streamChanges.push(change);
        Promise.resolve().then((): Promise<GPUVideoDecodeHandle> => this.factory(request)).then(
            (createdHandle: GPUVideoDecodeHandle): void => {
                if (this.destroyed || this.generation !== generation || !generation.streamChanges.includes(change)) {
                    createdHandle.session.destroy();
                    return;
                }
                change.handle = createdHandle;
                for (const queuedPicture of change.unjudgedPictures.splice(0)) {
                    this.routePicture(generation, queuedPicture);
                }
                this.pump();
            },
            (error: unknown): void => {
                if (this.generation === generation && generation.streamChanges.includes(change)) {
                    this.failGeneration(generation, describeCreationFailure(error));
                }
            }
        );
        this.pump();
    }

    /**
     * Advances the stream changes: the session before the first change hears that its packets are complete, and once it decoded them and their
     * status readbacks applied, its last frames go to the frame queue and the change's session takes over, numbering its pictures on from the change.
     */
    private advanceStreamChanges(generation: FeedGeneration): void {
        for (let change = generation.streamChanges.at(0); change !== undefined; change = generation.streamChanges.at(0)) {
            const handle = this.handle;
            if (!handle) {
                return;
            }
            if (!change.previousSessionEnded) {
                change.previousSessionEnded = true;
                handle.session.endOfStream(change.previousSessionEvents);
            }
            if (
                handle.session.getPendingPacketCount() > 0
                || handle.session.getInFlightPacketCount() > 0
                || change.handle === null
                || this.reportSessionFailure(handle, generation)
            ) {
                return;
            }
            this.deliverFrames(handle, generation);
            this.collectRecoveries(handle);
            this.retireHandle(handle);
            generation.streamChanges.shift();
            const changeHandle = change.handle;
            this.handle = changeHandle;
            this.sessionRequest = change.request;
            this.streamChangeCount += 1;
            changeHandle.session.continuePictureNumbering(change.firstPictureIndex);
            for (const packet of change.packets) {
                this.submitPacket(changeHandle, generation, packet);
            }
            if (generation.videoEnded && generation.streamChanges.length === 0) {
                changeHandle.session.endOfStream(generation.videoEndEvents);
            }
        }
    }

    /** Destroys the sessions of pending stream changes, created or not; a creation that finishes later destroys its own. */
    private cancelStreamChanges(): void {
        for (const change of this.generation?.streamChanges.splice(0) ?? []) {
            change.handle?.session.destroy();
        }
    }

    /** Keeps a session a stream change replaced until presentation releases its last frame. */
    private retireHandle(handle: GPUVideoDecodeHandle): void {
        this.retiredHandles.add(handle);
        this.destroyRetiredHandleIfReleased(handle);
    }

    private destroyRetiredHandleIfReleased(handle: GPUVideoDecodeHandle): void {
        for (const heldFrame of this.heldFrames.values()) {
            if (heldFrame.handle === handle) {
                return;
            }
        }
        this.retiredHandles.delete(handle);
        handle.session.destroy();
    }

    private submitPacket(handle: GPUVideoDecodeHandle, generation: FeedGeneration, packet: GPUVideoDecodeFeedPacket): void {
        const decodePacket: GPUDecodePacket = {
            data: packet.data,
            durationMicroseconds: packet.durationMicroseconds,
            fields: packet.fields,
            hold: packet.hold,
            keyframe: packet.keyframe,
            outputEvents: packet.outputEvents,
            recovery: packet.recovery,
            repeatCounts: packet.repeatCounts,
            reset: generation.resetPending || packet.reset,
            timestampMicroseconds: packet.timestampMicroseconds,
            visibleSize: packet.visibleSize
        };
        generation.resetPending = false;
        handle.session.queuePacket(decodePacket);
    }

    /** Counts the recoveries a session made since the feed last asked, per code and error name, keeping each kind's latest detail. */
    private collectRecoveries(handle: GPUVideoDecodeHandle): void {
        for (const recovery of handle.session.takeRecoveries()) {
            const key = `${recovery.code} ${recovery.errorName}`;
            const count = this.recoveryCounts.get(key)?.count ?? 0;
            this.recoveryCounts.set(key, { code: recovery.code, count: count + 1, detail: describeGPUVideoDecodeRecovery(recovery) });
        }
    }

    /**
     * Submits queued packets' decode work while fewer than MAXIMUM_IN_FLIGHT_PACKETS are in flight, then delivers the frames the session made presentable.
     * While any is in flight, its status readback pumps again, since the readback and the slots it frees can be what the next packet waits for.
     */
    private pump(): void {
        const generation = this.generation;
        if (!generation || generation.failed || this.creationRequest !== null) {
            return;
        }
        this.advanceStreamChanges(generation);
        const handle = this.handle;
        if (!handle || generation.failed) {
            return;
        }
        const session = handle.session;
        let consumedPacketCount = 0;
        while (session.getInFlightPacketCount() < MAXIMUM_IN_FLIGHT_PACKETS && session.submitPendingDecodeWork()) {
            consumedPacketCount += 1;
        }
        this.collectRecoveries(handle);
        if (this.reportSessionFailure(handle, generation)) {
            return;
        }
        if (consumedPacketCount > 0) {
            this.submittedPacketCount += consumedPacketCount;
            generation.callbacks.onCreditsReleased(consumedPacketCount);
        }
        this.deliverFrames(handle, generation);
        // A delivered frame's release may pump meanwhile, and hand over to a stream change's session, which that pump then runs
        if (this.handle !== handle || generation.failed) {
            return;
        }
        if (session.getInFlightPacketCount() > 0) {
            this.waitForStatusReadback(handle);
            return;
        }
        // The session before a stream change may have just decoded its last packet
        if (generation.streamChanges.length > 0 && session.getPendingPacketCount() === 0) {
            this.advanceStreamChanges(generation);
            if (this.handle !== handle) {
                this.pump();
            }
            return;
        }
        this.completeDrainIfEnded(handle, generation);
    }

    /** Pumps once the session's next status readback applies; one wait at a time, and none that pumps a session the feed no longer runs. */
    private waitForStatusReadback(handle: GPUVideoDecodeHandle): void {
        if (this.readbackWaitHandle === handle) {
            return;
        }
        this.readbackWaitHandle = handle;
        const readbackApplied = (): void => {
            if (this.readbackWaitHandle !== handle) {
                return;
            }
            this.readbackWaitHandle = null;
            const generation = this.generation;
            if (this.handle !== handle || !generation) {
                return;
            }
            if (!this.reportSessionFailure(handle, generation)) {
                this.pump();
            }
        };
        handle.session.waitForNextStatusReadback().then(readbackApplied, readbackApplied);
    }

    /** Hands every frame the session made presentable to the frame queue, with its packet's HDR10+ state. */
    private deliverFrames(handle: GPUVideoDecodeHandle, generation: FeedGeneration): void {
        const displaySize = generation.displaySize;
        for (let decodedFrame = handle.session.takeNextFrame(); decodedFrame !== null; decodedFrame = handle.session.takeNextFrame()) {
            const metadata = generation.frameMetadata.get(decodedFrame.timestampMicroseconds);
            generation.frameMetadata.delete(decodedFrame.timestampMicroseconds);
            const visibleRectangle = decodedFrame.frame.visibleRectangle;
            const presentationFrame: DecodedFramePoolPresentationFrame = {
                displayHeight: displaySize?.displayHeight ?? visibleRectangle.height,
                displayWidth: displaySize?.displayWidth ?? visibleRectangle.width,
                durationMicroseconds: requireMicroseconds(decodedFrame.durationMicroseconds, 'GPU decoded frame duration'),
                ...(decodedFrame.fields ? { fields: decodedFrame.fields } : {}),
                frame: decodedFrame.frame,
                ...(metadata ? { HDR10PlusMetadata: metadata } : {}),
                mediaTimeMicroseconds: requireMicroseconds(decodedFrame.timestampMicroseconds, 'GPU decoded frame timestamp'),
                outputMode: 'frame-pool',
                videoEpoch: generation.videoEpoch
            };
            this.heldFrames.set(presentationFrame, { decodedFrame, handle });
            generation.callbacks.onFrame(presentationFrame);
        }
    }

    /** Reports the epoch drained once its end arrived and no packet, stream change, held-back frame, or decode work remains. */
    private completeDrainIfEnded(handle: GPUVideoDecodeHandle, generation: FeedGeneration): void {
        const session = handle.session;
        if (
            !generation.videoEnded
            || generation.drained
            || generation.waitingPictures.length > 0
            || generation.streamChanges.length > 0
            || session.getPendingPacketCount() > 0
            || session.getQueuedFrameCount() > 0
        ) {
            return;
        }
        generation.drained = true;
        generation.callbacks.onVideoDrained();
    }

    /** Fails the generation with the session's failure, once; returns whether the session failed. */
    private reportSessionFailure(handle: GPUVideoDecodeHandle, generation: FeedGeneration): boolean {
        const failure = handle.session.getFailure();
        if (!failure) {
            return false;
        }
        this.failGeneration(generation, describeSessionFailure(failure, handle));
        return true;
    }

    private failGeneration(generation: FeedGeneration, detail: string): void {
        if (generation.failed) {
            return;
        }
        generation.failed = true;
        this.failure = detail;
        generation.callbacks.onFailure(detail);
    }

    /** Destroys the current session and drops the one being created; frames still held keep naming the destroyed session, which ignores their release. */
    private releaseSession(): void {
        if (this.handle) {
            this.collectRecoveries(this.handle);
        }
        this.handle?.session.destroy();
        this.handle = null;
        this.sessionRequest = null;
        this.creationRequest = null;
        this.readbackWaitHandle = null;
    }
}
