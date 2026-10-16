import {
    ALL_FORMATS,
    Mp4InputFormat,
    type Input,
    type InputFormat
} from 'mediabunny';

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

type InputReaderSlice = {
    bufferPos: number
    bytes: Uint8Array
};

type InputReader = {
    requestSlice: (start: number, length: number) => InputReaderSlice | null | Promise<InputReaderSlice | null>
};

let motionJPEG2000UnavailableWarningLogged = false;

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

/**
 * Mediabunny's input formats for custom decode, with Motion JPEG 2000 added ahead of them.
 * The addition is contained here, so Mediabunny stays unmodified.
 */
export const CUSTOM_DECODE_INPUT_FORMATS: InputFormat[] = [ new MotionJPEG2000InputFormat(), ...ALL_FORMATS ];
