import {
    ALL_FORMATS,
    MATROSKA,
    MatroskaInputFormat,
    Mp4InputFormat,
    type Input,
    type InputFormat
} from 'mediabunny';

// Mediabunny's BlockLacing.None, the lacing of a block that holds one frame
const UNLACED_BLOCK_LACING = 0;
const UNAVAILABLE_WARNING = 'Header-stripped laced Matroska frames stay corrupt: Mediabunny\'s Matroska demuxer differs from 1.52.2';
const MOTION_JPEG_2000_UNAVAILABLE_WARNING = 'Motion JPEG 2000 files do not open: Mediabunny\'s input reader differs from 1.52.2';

// ISO/IEC 15444-3 opens a Motion JPEG 2000 file with the 12-byte JP2 signature box, then ftyp of major brand mjp2
const MOTION_JPEG_2000_SIGNATURE_BOX = Object.freeze([ 0x00, 0x00, 0x00, 0x0C, 0x6A, 0x50, 0x20, 0x20, 0x0D, 0x0A, 0x87, 0x0A ]);
const FILE_TYPE_BOX_TYPE = 'ftyp';
const MOTION_JPEG_2000_MAJOR_BRAND = 'mjp2';
const FILE_TYPE_BOX_TYPE_OFFSET = 16;
const MAJOR_BRAND_OFFSET = 20;
const FOURCC_BYTE_LENGTH = 4;
const MOTION_JPEG_2000_HEADER_BYTE_LENGTH = MAJOR_BRAND_OFFSET + FOURCC_BYTE_LENGTH;
const MOTION_JPEG_2000_FORMAT_NAME = 'Motion JPEG 2000';
const MOTION_JPEG_2000_MIME_TYPE = 'video/mj2';

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

type InputReaderSlice = {
    bufferPos: number
    bytes: Uint8Array
};

type InputReader = {
    requestSlice: (start: number, length: number) => InputReaderSlice | null | Promise<InputReaderSlice | null>
};

// Mediabunny strips its internal members from the published types, so contain the access here
const createMatroskaDemuxer: unknown = (MatroskaInputFormat.prototype as unknown as { _createDemuxer?: unknown })._createDemuxer;
let unavailableWarningLogged = false;
let motionJPEG2000UnavailableWarningLogged = false;

function warnUnavailable(): void {
    if (unavailableWarningLogged) {
        return;
    }
    unavailableWarningLogged = true;
    console.warn(UNAVAILABLE_WARNING);
}

function warnMotionJPEG2000Unavailable(): void {
    if (motionJPEG2000UnavailableWarningLogged) {
        return;
    }
    motionJPEG2000UnavailableWarningLogged = true;
    console.warn(MOTION_JPEG_2000_UNAVAILABLE_WARNING);
}

function isInputReaderSlice(value: unknown): value is InputReaderSlice {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const slice = value as Record<string, unknown>;
    return slice.bytes instanceof Uint8Array && Number.isSafeInteger(slice.bufferPos);
}

function readFourCC(bytes: Uint8Array, offset: number): string {
    return String.fromCharCode(...bytes.subarray(offset, offset + FOURCC_BYTE_LENGTH));
}

/** Returns whether a file's first bytes are a Motion JPEG 2000 file's signature box and its ftyp of major brand mjp2. */
function isMotionJPEG2000Header(header: Uint8Array): boolean {
    return header.byteLength === MOTION_JPEG_2000_HEADER_BYTE_LENGTH
        && MOTION_JPEG_2000_SIGNATURE_BOX.every((value: number, byteIndex: number): boolean => header[byteIndex] === value)
        && readFourCC(header, FILE_TYPE_BOX_TYPE_OFFSET) === FILE_TYPE_BOX_TYPE
        && readFourCC(header, MAJOR_BRAND_OFFSET) === MOTION_JPEG_2000_MAJOR_BRAND;
}

/**
 * A Motion JPEG 2000 file, which Mediabunny's MP4 demuxer reads once past the signature box ahead of its ftyp.
 * Mediabunny recognizes an ISO base media file only by an ftyp first, so its own MP4 format never takes one.
 */
class MotionJPEG2000InputFormat extends Mp4InputFormat {
    public async _canReadInput(input: Input): Promise<boolean> {
        const reader = (input as unknown as { _reader?: Partial<InputReader> })._reader;
        if (typeof reader?.requestSlice !== 'function') {
            warnMotionJPEG2000Unavailable();
            return false;
        }
        const slice: unknown = await reader.requestSlice(0, MOTION_JPEG_2000_HEADER_BYTE_LENGTH);
        if (slice === null) {
            return false;
        }
        if (!isInputReaderSlice(slice)) {
            warnMotionJPEG2000Unavailable();
            return false;
        }
        return isMotionJPEG2000Header(slice.bytes.subarray(slice.bufferPos, slice.bufferPos + MOTION_JPEG_2000_HEADER_BYTE_LENGTH));
    }

    public get name(): string {
        return MOTION_JPEG_2000_FORMAT_NAME;
    }

    public get mimeType(): string {
        return MOTION_JPEG_2000_MIME_TYPE;
    }
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

/**
 * Adds Motion JPEG 2000 ahead of Mediabunny's own formats, and replaces Matroska in its place,
 * or keeps Matroska as Mediabunny's own when its internals differ.
 */
function createCustomDecodeInputFormats(): InputFormat[] {
    const motionJPEG2000 = new MotionJPEG2000InputFormat();
    if (typeof createMatroskaDemuxer !== 'function') {
        warnUnavailable();
        return [ motionJPEG2000, ...ALL_FORMATS ];
    }
    return [
        motionJPEG2000,
        ...ALL_FORMATS.map(
            (format: InputFormat): InputFormat => format === MATROSKA ? new FrameContentDecodingMatroskaInputFormat() : format
        )
    ];
}

/**
 * Mediabunny's input formats for custom decode, with Matroska's content decoding scoped to frames and Motion JPEG 2000 added.
 * Older mkvmerge releases stripped the sync word of AC-3, DTS, and MP3 frames and laced audio by default.
 * Both fixes are contained here, as MatroskaBlockAdditions.ts contains its own, so Mediabunny stays unmodified.
 */
export const CUSTOM_DECODE_INPUT_FORMATS: InputFormat[] = createCustomDecodeInputFormats();
