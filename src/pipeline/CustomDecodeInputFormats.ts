import {
    ALL_FORMATS,
    MATROSKA,
    MatroskaInputFormat,
    type Input,
    type InputFormat
} from 'mediabunny';

// Mediabunny's BlockLacing.None, the lacing of a block that holds one frame
const UNLACED_BLOCK_LACING = 0;
const UNAVAILABLE_WARNING = 'Header-stripped laced Matroska frames stay corrupt: Mediabunny\'s Matroska demuxer differs from 1.52.2';

type MatroskaClusterBlock = {
    data: Uint8Array
    decoded: boolean
    lacing: number
};

type MatroskaDemuxerInternals = {
    decodeBlockData: (track: unknown, rawData: Uint8Array) => Uint8Array
    expandLacedBlocks: (blocks: MatroskaClusterBlock[], track: unknown) => void
};

type DemuxerFactory = (input: Input) => unknown;

// Mediabunny strips its internal members from the published types, so contain the access here
const createMatroskaDemuxer: unknown = (MatroskaInputFormat.prototype as unknown as { _createDemuxer?: unknown })._createDemuxer;
let unavailableWarningLogged = false;

function warnUnavailable(): void {
    if (unavailableWarningLogged) {
        return;
    }
    unavailableWarningLogged = true;
    console.warn(UNAVAILABLE_WARNING);
}

function isMatroskaDemuxerInternals(value: unknown): value is MatroskaDemuxerInternals {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const demuxer = value as Record<string, unknown>;
    return typeof demuxer.expandLacedBlocks === 'function' && typeof demuxer.decodeBlockData === 'function';
}

/**
 * Splits each laced block from its stored bytes, then content-decodes every frame on its own.
 * The Matroska specification scopes a block's content encoding to its frames, excluding the lacing data.
 * Mediabunny 1.52.2 content-decodes a laced block whole, so header stripping prepends its bytes ahead of the lace header and corrupts every frame.
 */
function splitLacedBlocksBeforeContentDecoding(demuxer: MatroskaDemuxerInternals): void {
    const expandLacedBlocks = demuxer.expandLacedBlocks;
    demuxer.expandLacedBlocks = (blocks: MatroskaClusterBlock[], track: unknown): void => {
        for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
            const block = blocks[blockIndex];
            if (block.lacing === UNLACED_BLOCK_LACING || block.decoded) {
                continue;
            }

            // Marked decoded, the block is split as stored, and each frame is then decoded on its own
            block.decoded = true;
            const frames = [ block ];
            expandLacedBlocks.call(demuxer, frames, track);
            for (const frame of frames) {
                frame.data = demuxer.decodeBlockData(track, frame.data);
            }
            blocks.splice(blockIndex, 1, ...frames);
            blockIndex += frames.length - 1;
        }

        // Blocks without content encoding take Mediabunny's own path
        expandLacedBlocks.call(demuxer, blocks, track);
    };
}

/** Matroska whose laced blocks are split before their content is decoded. */
class FrameContentDecodingMatroskaInputFormat extends MatroskaInputFormat {
    public _createDemuxer(input: Input): unknown {
        const demuxer = (createMatroskaDemuxer as DemuxerFactory).call(this, input);
        if (isMatroskaDemuxerInternals(demuxer)) {
            splitLacedBlocksBeforeContentDecoding(demuxer);
        } else {
            warnUnavailable();
        }
        return demuxer;
    }
}

/** Replaces Matroska in its place, or keeps every format as Mediabunny's own when its internals differ. */
function createCustomDecodeInputFormats(): InputFormat[] {
    if (typeof createMatroskaDemuxer !== 'function') {
        warnUnavailable();
        return [ ...ALL_FORMATS ];
    }
    return ALL_FORMATS.map(
        (format: InputFormat): InputFormat => format === MATROSKA ? new FrameContentDecodingMatroskaInputFormat() : format
    );
}

/**
 * Mediabunny's input formats for custom decode, with Matroska's content decoding scoped to frames.
 * Older mkvmerge releases stripped the sync word of AC-3, DTS, and MP3 frames and laced audio by default.
 * The fix is contained here, as MatroskaBlockAdditions.ts contains its own, so Mediabunny stays unmodified.
 */
export const CUSTOM_DECODE_INPUT_FORMATS: InputFormat[] = createCustomDecodeInputFormats();
