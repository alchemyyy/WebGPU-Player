import {
    MatroskaInputFormat,
    type EncodedPacket,
    type InputFormat,
    type InputVideoTrack
} from 'mediabunny';

// BlockAddID 1 is the codec's own addition, the VP8 and VP9 alpha channel, which Mediabunny already exposes as packet side data
const CODEC_BLOCK_ADDITION_ID = 1;
const UNAVAILABLE_WARNING = 'Matroska BlockAdditional side data, HDR10+ included, is unavailable: Mediabunny\'s Matroska demuxer differs from 1.52.2';

/** One BlockAdditional of a Matroska or WebM block, with its BlockAddID. */
export type MatroskaBlockAddition = Readonly<{
    addID: number
    data: Uint8Array
}>;

/** Reads the BlockAdditionals of a packet that the track's packet sink returned. */
export type MatroskaBlockAdditionReader = (packet: EncodedPacket) => readonly MatroskaBlockAddition[];

type DemuxerFactory = (input: unknown) => unknown;

const NO_BLOCK_ADDITIONS: readonly MatroskaBlockAddition[] = Object.freeze([]);
// The demuxers that record the additions of the blocks they parse
const recordingDemuxers = new WeakSet<object>();
// Keyed by Mediabunny's block record, which lives as long as its parsed cluster
const blockAdditions = new WeakMap<object, MatroskaBlockAddition[]>();
let unavailableWarningLogged = false;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function warnUnavailable(): void {
    if (unavailableWarningLogged) {
        return;
    }
    unavailableWarningLogged = true;
    console.warn(UNAVAILABLE_WARNING);
}

function readNoBlockAdditions(): readonly MatroskaBlockAddition[] {
    return NO_BLOCK_ADDITIONS;
}

/** Records one finished BlockMore against the block of its BlockGroup. */
function recordBlockAddition(block: unknown, blockMore: unknown): void {
    if (!isRecord(block) || !isRecord(blockMore)) {
        return;
    }
    const addID = blockMore.addId;
    const data = blockMore.data;
    if (typeof addID !== 'number' || !Number.isSafeInteger(addID) || addID === CODEC_BLOCK_ADDITION_ID || !(data instanceof Uint8Array)) {
        return;
    }
    let additions = blockAdditions.get(block);
    if (!additions) {
        additions = [];
        blockAdditions.set(block, additions);
    }
    additions.push({ addID, data });
}

/**
 * Makes one Mediabunny 1.52.2 MatroskaDemuxer record every BlockMore of the blocks it parses.
 * Its traverseElement() parses each BlockMore into the currentBlockAdditional field, copies BlockAddID 1 to the block in currentBlock, and resets the field to null, so the reset is where the finished addition is taken.
 * Returns false, leaving the demuxer untouched, when it has no traverseElement() or either field is not the null data field a new demuxer has.
 */
function recordBlockAdditions(demuxer: Record<string, unknown>): boolean {
    const blockAdditionalField = Object.getOwnPropertyDescriptor(demuxer, 'currentBlockAdditional');
    const blockField = Object.getOwnPropertyDescriptor(demuxer, 'currentBlock');
    if (
        !blockAdditionalField
        || !blockField
        || blockAdditionalField.value !== null
        || blockAdditionalField.writable !== true
        || blockAdditionalField.configurable !== true
        || blockField.value !== null
        || typeof demuxer.traverseElement !== 'function'
    ) {
        return false;
    }

    let currentBlockAdditional: unknown = null;
    Object.defineProperty(demuxer, 'currentBlockAdditional', {
        configurable: true,
        enumerable: blockAdditionalField.enumerable,
        get: (): unknown => currentBlockAdditional,
        set: (value: unknown): void => {
            const finishedBlockMore = currentBlockAdditional;
            currentBlockAdditional = value;
            if (value === null) {
                recordBlockAddition(demuxer.currentBlock, finishedBlockMore);
            }
        }
    });
    recordingDemuxers.add(demuxer);
    return true;
}

/** Wraps Mediabunny's Matroska or WebM format so each demuxer it creates records its blocks' additions before reading any cluster. */
function createRecordingInputFormat(format: MatroskaInputFormat): InputFormat {
    const createDemuxer = (format as unknown as { _createDemuxer?: unknown })._createDemuxer;
    if (typeof createDemuxer !== 'function') {
        warnUnavailable();
        return format;
    }
    // Format detection, naming, and every other member still come from Mediabunny's own format
    return Object.create(format, {
        _createDemuxer: {
            value: (input: unknown): unknown => {
                const demuxer = (createDemuxer as DemuxerFactory).call(format, input);
                if (!isRecord(demuxer) || !recordBlockAdditions(demuxer)) {
                    warnUnavailable();
                }
                return demuxer;
            }
        }
    }) as InputFormat;
}

/**
 * Returns the input formats with Matroska and WebM, in their places, replaced by formats whose demuxers keep every BlockAdditional.
 * Mediabunny 1.52.2 parses each BlockMore but keeps only BlockAddID 1, the alpha channel, so other side data such as VP9 HDR10+ is lost.
 * The fix is contained here, as ISOBaseMediaDolbyVisionSampleEntry.ts and AV1DecoderConfiguration.ts contain theirs, so Mediabunny stays unmodified.
 * Detection order and every other format are unchanged, and alpha still reaches Mediabunny's packet side data.
 * When Mediabunny's internals differ, its demuxers stay untouched and read no additions, with one console warning.
 */
export function withMatroskaBlockAdditions(formats: readonly InputFormat[]): InputFormat[] {
    const recordingFormats: InputFormat[] = [];
    for (const format of formats) {
        recordingFormats.push(format instanceof MatroskaInputFormat ? createRecordingInputFormat(format) : format);
    }
    return recordingFormats;
}

/** Finds the block a packet came from: Mediabunny records each packet's cluster and its index among the track's blocks there. */
function findPacketBlock(packetLocations: WeakMap<object, unknown>, trackNumber: number, packet: EncodedPacket): object | null {
    const location = packetLocations.get(packet);
    if (
        !isRecord(location)
        || !isRecord(location.cluster)
        || !(location.cluster.trackData instanceof Map)
        || typeof location.blockIndex !== 'number'
    ) {
        return null;
    }
    const trackData: unknown = location.cluster.trackData.get(trackNumber);
    if (!isRecord(trackData) || !Array.isArray(trackData.blocks)) {
        return null;
    }
    const block: unknown = trackData.blocks[location.blockIndex];
    return isRecord(block) ? block : null;
}

/**
 * Returns the reader of a track's BlockAdditionals other than BlockAddID 1, in the order of each block's BlockMore elements.
 * Only a track whose demuxer came from withMatroskaBlockAdditions() has any; every other track, MP4 included, reads none.
 * A laced block reads none, because Mediabunny replaces it with one new block per frame before any packet exists.
 * When Mediabunny's internals differ, the reader reads none, with one console warning.
 */
export function createMatroskaBlockAdditionReader(track: InputVideoTrack): MatroskaBlockAdditionReader {
    const backing = (track as unknown as { _backing?: unknown })._backing;
    if (
        !isRecord(backing)
        || !isRecord(backing.internalTrack)
        || !isRecord(backing.internalTrack.demuxer)
        || !recordingDemuxers.has(backing.internalTrack.demuxer)
    ) {
        return readNoBlockAdditions;
    }
    const packetLocations = backing.packetToClusterLocation;
    const trackNumber = backing.internalTrack.id;
    if (!(packetLocations instanceof WeakMap) || typeof trackNumber !== 'number') {
        warnUnavailable();
        return readNoBlockAdditions;
    }

    return (packet: EncodedPacket): readonly MatroskaBlockAddition[] => {
        const block = findPacketBlock(packetLocations, trackNumber, packet);
        if (!block) {
            warnUnavailable();
            return NO_BLOCK_ADDITIONS;
        }
        return blockAdditions.get(block) ?? NO_BLOCK_ADDITIONS;
    };
}
