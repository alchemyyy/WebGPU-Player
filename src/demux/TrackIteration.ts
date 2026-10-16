import {
    AudioSampleCursor,
    InputDisposedError,
    VideoSampleCursor,
    type AudioSample,
    type EncodedPacket,
    type InputAudioTrack,
    type InputTrack,
    type InputVideoTrack,
    type MaybePromise,
    type PacketReader,
    type VideoSample,
    type VideoSampleCursorOptions
} from 'mediabunny';

// Mediabunny takes these options in its public methods without exporting their type
type PacketRetrievalOptions = NonNullable<Parameters<PacketReader['getFirst']>[0]>;

/** A track's media as the decode worker reads it, one item per next(); return() ends the reading. */
export type MediaIterator<Item> = AsyncIterable<Item> & {
    next: () => Promise<IteratorResult<Item>>
    return: () => Promise<IteratorResult<Item>>
};

type SampleCursor<Sample> = {
    close: () => Promise<void>
    next: () => MaybePromise<Sample | null>
    seekTo: (timestamp: number) => MaybePromise<Sample | null>
};

type Signal = {
    promise: Promise<void>
    resolve: () => void
};

// Packets queued ahead of the consumer: about a second's worth at its pace, and at least this many
const MINIMUM_QUEUED_PACKET_COUNT = 2;
const CONSUMPTION_WINDOW_MILLISECONDS = 1000;
const ITERATION_DONE: IteratorReturnResult<undefined> = { done: true, value: undefined };

function createSignal(): Signal {
    let resolve: () => void = (): void => undefined;
    const promise = new Promise<void>((resolvePromise: () => void): void => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

/**
 * Reads a track's packets in decode order from startPacket, or the first packet, up to endPacket, exclusive, as Mediabunny 1's EncodedPacketSink.packets() did:
 * a pump keeps about a second of packets queued at the consumer's pace, and return() ends the reading at once, while a read may still run.
 * The reader must be the one that read startPacket and endPacket.
 */
export function iterateTrackPackets(
    reader: PacketReader,
    startPacket: EncodedPacket | null,
    endPacket: EncodedPacket | null,
    options: PacketRetrievalOptions
): MediaIterator<EncodedPacket> {
    const track: InputTrack = reader.track;
    const queuedPackets: EncodedPacket[] = [];
    // When the consumer took each packet within the last window, which sizes the queue
    const consumptionTimes: number[] = [];
    let queueFilled = createSignal();
    let queueDrained = createSignal();
    let ended = false;
    let terminated = false;
    let pumpFailure: { error: unknown } | null = null;

    const pump = async (): Promise<void> => {
        let packet = startPacket ?? await reader.getFirst(options);
        while (packet && !terminated && !track.input.disposed) {
            if (endPacket && packet.sequenceNumber >= endPacket.sequenceNumber) {
                break;
            }
            if (queuedPackets.length > Math.max(MINIMUM_QUEUED_PACKET_COUNT, consumptionTimes.length)) {
                queueDrained = createSignal();
                await queueDrained.promise;
                continue;
            }
            queuedPackets.push(packet);
            queueFilled.resolve();
            queueFilled = createSignal();
            packet = await reader.getNext(packet, options);
        }
        ended = true;
        queueFilled.resolve();
    };
    pump().catch((error: unknown): void => {
        pumpFailure ??= { error };
        queueFilled.resolve();
    });

    const iterator: MediaIterator<EncodedPacket> = {
        async next(): Promise<IteratorResult<EncodedPacket>> {
            while (true) {
                if (track.input.disposed) {
                    throw new InputDisposedError();
                }
                if (terminated) {
                    return ITERATION_DONE;
                }
                if (pumpFailure) {
                    throw pumpFailure.error;
                }
                const packet = queuedPackets.shift();
                if (packet) {
                    const now = performance.now();
                    consumptionTimes.push(now);
                    while (consumptionTimes.length > 0 && now - (consumptionTimes[0] ?? now) >= CONSUMPTION_WINDOW_MILLISECONDS) {
                        consumptionTimes.shift();
                    }
                    queueDrained.resolve();
                    return { done: false, value: packet };
                }
                if (ended) {
                    return ITERATION_DONE;
                }
                await queueFilled.promise;
            }
        },
        async return(): Promise<IteratorResult<EncodedPacket>> {
            terminated = true;
            queueDrained.resolve();
            queueFilled.resolve();
            return ITERATION_DONE;
        },
        [Symbol.asyncIterator](): MediaIterator<EncodedPacket> {
            return iterator;
        }
    };
    return iterator;
}

/** Iterates a sample cursor from the sample presented at startSeconds, or from the first sample when the track starts later; return() closes the cursor. */
function iterateSampleCursor<Sample>(cursor: SampleCursor<Sample>, startSeconds: number): MediaIterator<Sample> {
    let started = false;
    const iterator: MediaIterator<Sample> = {
        async next(): Promise<IteratorResult<Sample>> {
            let sample: Sample | null;
            if (started) {
                sample = await cursor.next();
            } else {
                started = true;
                sample = await cursor.seekTo(startSeconds) ?? await cursor.next();
            }
            return sample ? { done: false, value: sample } : ITERATION_DONE;
        },
        async return(): Promise<IteratorResult<Sample>> {
            await cursor.close();
            return ITERATION_DONE;
        },
        [Symbol.asyncIterator](): MediaIterator<Sample> {
            return iterator;
        }
    };
    return iterator;
}

/**
 * Decodes a video track's samples from the one presented at startSeconds, as Mediabunny 1's VideoSampleSink.samples() did.
 * Every sample is the caller's to close; return() closes the cursor and its decoder.
 */
export function iterateVideoSamples(
    track: InputVideoTrack,
    startSeconds: number,
    options: VideoSampleCursorOptions
): MediaIterator<VideoSample> {
    return iterateSampleCursor(new VideoSampleCursor(track, { ...options, closeSamples: false }), startSeconds);
}

/**
 * Decodes an audio track's samples from the one presented at startSeconds, as Mediabunny 1's AudioSampleSink.samples() did.
 * Every sample is the caller's to close; return() closes the cursor and its decoder.
 */
export function iterateAudioSamples(track: InputAudioTrack, startSeconds: number): MediaIterator<AudioSample> {
    return iterateSampleCursor(new AudioSampleCursor(track, { closeSamples: false }), startSeconds);
}
