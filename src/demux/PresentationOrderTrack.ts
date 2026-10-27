import { EncodedPacket, InputVideoTrack, type Input } from 'mediabunny';

// A Video for Windows track, as Matroska's V_MS/VFW/FOURCC and AVI carry one, stamps each packet in decode order with the time of the picture a
// one-picture-delay decoder outputs at it, as FFmpeg reads such a track: an anchor (an I or P picture) outputs when the next anchor arrives, and a
// B picture outputs at once. Presentation orders pictures by timestamp, so each packet must carry its own picture's time instead.

/** How a packet's picture orders: an anchor outputs at a later packet, a B picture at once, and a packet may hold no picture. */
export type PictureOrder = 'anchor' | 'bidirectional' | 'none';

/** How a codec's packets order, as its FFmpeg decoder outputs them one picture late. */
export type PictureOrderReader = Readonly<{
    /** Returns how a packet's picture orders. */
    getPictureOrder: (packet: Uint8Array) => PictureOrder
    /** The most packets an anchor's output waits past, after which it takes the end of the last one. */
    maximumLookaheadPacketCount: number
    /**
     * Whether a packet without a picture outputs the waiting anchor, as FFmpeg's VC-1 decoder outputs it at such a packet, or is passed over like a B
     * picture, as FFmpeg's MPEG-4 decoder outputs nothing for a VOP that is not coded.
     */
    outputsAnchorWithoutPicture: boolean
}>;

type PacketRetrievalOptions = Readonly<Record<string, unknown>>;

/** A packet retrieval's result as Mediabunny's internal PacketRetrievalResult carries it: the packet, and whether a live source may still change it. */
type PacketRetrievalResult = Readonly<{ packet: EncodedPacket | null, provisional: boolean }>;

/** What a Mediabunny track backing writes a retrieval's result into, as its internal ResultValue, before the promise it returns settles. */
type PacketRetrievalResultValue = {
    set: (result: PacketRetrievalResult) => void
};

/** The packet retrieval of a Mediabunny track backing, which the presentation order replaces, and the timestamp resolution it steps back by. */
type PacketRetrievalBacking = {
    getFirstPacket: (result: PacketRetrievalResultValue, options: PacketRetrievalOptions) => Promise<unknown>
    getKeyPacket: (result: PacketRetrievalResultValue, timestamp: number, options: PacketRetrievalOptions) => Promise<unknown>
    getNextKeyPacket: (result: PacketRetrievalResultValue, packet: EncodedPacket, options: PacketRetrievalOptions) => Promise<unknown>
    getNextPacket: (result: PacketRetrievalResultValue, packet: EncodedPacket, options: PacketRetrievalOptions) => Promise<unknown>
    getPacket: (result: PacketRetrievalResultValue, timestamp: number, options: PacketRetrievalOptions) => Promise<unknown>
    getTimeResolution: () => number | Promise<number>
};

/** Mediabunny's internal packet clone, which keeps where the demuxer finds the packet again, so a presented packet's next-packet lookups need no mapping. */
type InternalPacketClone = (options: Readonly<{ timestamp: number }>) => EncodedPacket;

type InputVideoTrackConstructor = new (input: Input, backing: object) => InputVideoTrack;

const NO_PACKET: PacketRetrievalResult = Object.freeze({ packet: null, provisional: false });

/** Receives one backing retrieval's result. */
class BackingResult implements PacketRetrievalResultValue {
    public value: PacketRetrievalResult = NO_PACKET;

    public set(result: PacketRetrievalResult): void {
        this.value = result;
    }
}

/**
 * Hands out a decode-order track's packets with presentation timestamps: a B picture keeps its packet's time, and an anchor takes the time of the
 * packet at which FFmpeg outputs it, the next anchor (or packet without a picture, where that outputs it), or the end of its last packet.
 */
class PresentationOrder {
    public constructor(
        private readonly backing: PacketRetrievalBacking,
        private readonly reader: PictureOrderReader
    ) {}

    public readonly getFirstPacket = async (result: PacketRetrievalResultValue, options: PacketRetrievalOptions): Promise<void> => {
        result.set(await this.present(await this.retrieveFirstPacket(options), options));
    };

    public readonly getPacket = async (result: PacketRetrievalResultValue, timestamp: number, options: PacketRetrievalOptions): Promise<void> => {
        const backingResult = new BackingResult();
        await this.backing.getPacket(backingResult, timestamp, options);
        result.set(await this.present(backingResult.value, options));
    };

    public readonly getNextPacket = async (result: PacketRetrievalResultValue, packet: EncodedPacket, options: PacketRetrievalOptions): Promise<void> => {
        result.set(await this.present(await this.retrieveNextPacket(packet, options), options));
    };

    /**
     * Sets the key packet to present a time from: the latest whose picture presents by then.
     * The backing finds the latest by decode-order timestamps, under which an anchor presents later, and a VfW track's first two anchors may share one.
     */
    public readonly getKeyPacket = async (result: PacketRetrievalResultValue, timestamp: number, options: PacketRetrievalOptions): Promise<void> => {
        let keyPacket = await this.retrieveKeyPacket(timestamp, options);
        let presentedKeyPacket = await this.present(keyPacket, options);
        while (keyPacket.packet && presentedKeyPacket.packet && presentedKeyPacket.packet.timestamp > timestamp) {
            const earlierKeyPacket = await this.findEarlierKeyPacket(keyPacket.packet, options);
            if (!earlierKeyPacket.packet) {
                break;
            }
            keyPacket = earlierKeyPacket;
            presentedKeyPacket = await this.present(keyPacket, options);
        }
        result.set(presentedKeyPacket);
    };

    public readonly getNextKeyPacket = async (result: PacketRetrievalResultValue, packet: EncodedPacket, options: PacketRetrievalOptions): Promise<void> => {
        const backingResult = new BackingResult();
        await this.backing.getNextKeyPacket(backingResult, packet, options);
        result.set(await this.present(backingResult.value, options));
    };

    private async retrieveFirstPacket(options: PacketRetrievalOptions): Promise<PacketRetrievalResult> {
        const backingResult = new BackingResult();
        await this.backing.getFirstPacket(backingResult, options);
        return backingResult.value;
    }

    private async retrieveNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<PacketRetrievalResult> {
        const backingResult = new BackingResult();
        await this.backing.getNextPacket(backingResult, packet, options);
        return backingResult.value;
    }

    private async retrieveKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<PacketRetrievalResult> {
        const backingResult = new BackingResult();
        await this.backing.getKeyPacket(backingResult, timestamp, options);
        return backingResult.value;
    }

    /** Returns the key packet before one in decode order: the latest before its timestamp, else the track's first packet when that is a key packet before it. */
    private async findEarlierKeyPacket(keyPacket: EncodedPacket, options: PacketRetrievalOptions): Promise<PacketRetrievalResult> {
        const timeResolution = await this.backing.getTimeResolution();
        const earlier = await this.retrieveKeyPacket(keyPacket.timestamp - 1 / timeResolution, options);
        if (earlier.packet && earlier.packet.sequenceNumber < keyPacket.sequenceNumber) {
            return earlier;
        }
        const first = await this.retrieveFirstPacket(options);
        return first.packet?.type === 'key' && first.packet.sequenceNumber < keyPacket.sequenceNumber ? first : NO_PACKET;
    }

    /** Returns a result with its packet's picture presentation timestamp; a metadata-only packet has no picture to read, so it keeps its own. */
    private async present(retrieved: PacketRetrievalResult, options: PacketRetrievalOptions): Promise<PacketRetrievalResult> {
        const packet = retrieved.packet;
        if (!packet || packet.isMetadataOnly || this.reader.getPictureOrder(packet.data) !== 'anchor') {
            return retrieved;
        }
        const timestamp = await this.findAnchorOutputTimestamp(packet, options);
        if (timestamp === packet.timestamp) {
            return retrieved;
        }
        const cloneInternal = (packet as unknown as { _cloneInternal: InternalPacketClone })._cloneInternal;
        return { packet: cloneInternal.call(packet, { timestamp }), provisional: retrieved.provisional };
    }

    /** Returns whether FFmpeg outputs the waiting anchor at a packet: at an anchor, and at a packet without a picture when the codec's decoder does. */
    private outputsAnchor(packet: EncodedPacket): boolean {
        if (packet.isMetadataOnly) {
            return true;
        }
        switch (this.reader.getPictureOrder(packet.data)) {
            case 'anchor':
                return true;
            case 'bidirectional':
                return false;
            case 'none':
                return this.reader.outputsAnchorWithoutPicture;
        }
    }

    /** Returns the time of the packet that outputs an anchor: the first later packet that outputs it, or the end of the last packet. */
    private async findAnchorOutputTimestamp(anchor: EncodedPacket, options: PacketRetrievalOptions): Promise<number> {
        let previous = anchor;
        for (let lookaheadIndex = 0; lookaheadIndex < this.reader.maximumLookaheadPacketCount; lookaheadIndex += 1) {
            const next = (await this.retrieveNextPacket(previous, options)).packet;
            if (!next) {
                break;
            }
            if (this.outputsAnchor(next)) {
                return next.timestamp;
            }
            previous = next;
        }
        return previous.timestamp + previous.duration;
    }
}

function hasInternalPacketClone(): boolean {
    return typeof (EncodedPacket.prototype as unknown as { _cloneInternal?: unknown })._cloneInternal === 'function';
}

function isPacketRetrievalBacking(value: unknown): value is PacketRetrievalBacking {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const backing = value as Record<string, unknown>;
    return typeof backing.getFirstPacket === 'function'
        && typeof backing.getPacket === 'function'
        && typeof backing.getNextPacket === 'function'
        && typeof backing.getKeyPacket === 'function'
        && typeof backing.getNextKeyPacket === 'function'
        && typeof backing.getTimeResolution === 'function';
}

/**
 * Returns a track whose packets carry presentation timestamps for a track that stamps them in decode order, by how its codec's packets order.
 * Mediabunny's InputVideoTrack reads packets through its internal backing, so the replacement is contained here; null when that backing or its packet clone differs.
 */
export function createPresentationOrderTrack(track: InputVideoTrack, reader: PictureOrderReader): InputVideoTrack | null {
    const backing = (track as unknown as { _backing?: unknown })._backing;
    if (!isPacketRetrievalBacking(backing) || !hasInternalPacketClone()) {
        return null;
    }
    const order = new PresentationOrder(backing, reader);
    const presentationBacking = new Proxy(backing, {
        get(target: PacketRetrievalBacking, property: string | symbol): unknown {
            switch (property) {
                case 'getFirstPacket':
                    return order.getFirstPacket;
                case 'getPacket':
                    return order.getPacket;
                case 'getNextPacket':
                    return order.getNextPacket;
                case 'getKeyPacket':
                    return order.getKeyPacket;
                case 'getNextKeyPacket':
                    return order.getNextKeyPacket;
                default: {
                    const value: unknown = Reflect.get(target, property, target);
                    return typeof value === 'function' ? (value as (...values: unknown[]) => unknown).bind(target) : value;
                }
            }
        }
    });
    return new (InputVideoTrack as unknown as InputVideoTrackConstructor)(track.input, presentationBacking);
}
