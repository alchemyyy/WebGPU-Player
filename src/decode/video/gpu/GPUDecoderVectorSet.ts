// A video decoder package's vector set, its optional vectors section: the package's own self-test vectors, one per output format at most.
// The engine runs them only when a host asks it to verify the package; playback never does.
// Each vector holds what a demuxer would hand over, the track size, codec private data, and packets, so a check needs no container the engine can demux,
// and the frames it checks with their hash; the engine derives the stream facts from the track size and format as playback does.
// Layout, little-endian u32 words: magic 'WPDV', version, vector count; then per vector its byte length, its format name, its width and height,
// its first and last checked frame, the SHA-256 of the checked frames, its codec private data, and its packets,
// each a byte length, flags, timestamp, and duration in microseconds before its data. Names and data pad to whole words.
import DecoderPackageFormat from '../../packages/DecoderPackageFormat.json';
import { isGPUDecoderOutputFormat, type GPUDecoderOutputFormat } from './GPUDecodeFormats';
import type { GPUDecodeStreamFacts } from './GPUDecodeTypes';
import { createGPUDecodeStreamFacts } from './GPUFramePool';

/** The set's first word, the bytes 'WPDV'; DecoderPackageFormat.json declares it for the generator too. */
export const GPU_DECODER_VECTOR_SET_MAGIC = DecoderPackageFormat.vectorsMagic;

/** The set layout this engine reads. */
export const GPU_DECODER_VECTOR_SET_VERSION = DecoderPackageFormat.vectorsVersion;

const WORD_BYTE_LENGTH = 4;
const LITTLE_ENDIAN = true;
const KEYFRAME_FLAG = 1;
const SHA256_BYTE_LENGTH = 32;
const HEXADECIMAL_RADIX = 16;
const BYTE_HEXADECIMAL_DIGIT_COUNT = 2;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** A packet of a vector, in decode order. */
export type GPUDecoderVectorPacket = Readonly<{
    data: ArrayBuffer
    durationMicroseconds: number
    keyframe: boolean
    timestampMicroseconds: number
}>;

/** One vector of a set: the packets a check decodes in decode order, the stream facts and format it decodes them into, and the frames it checks. */
export type GPUDecoderVector = Readonly<{
    codecPrivate: Uint8Array | null
    /** The first checked frame, counted in presentation order from the vector's first frame */
    firstFrame: number
    format: GPUDecoderOutputFormat
    lastFrame: number
    packets: readonly GPUDecoderVectorPacket[]
    /**
     * The lowercase hexadecimal SHA-256 of the checked frames' planes, frame after frame.
     * Each frame contributes its luma plane, then its two chroma planes, cropped to the stream's visible rectangle, rows tightly packed and 16-bit samples little-endian.
     * That is FFmpeg's rawvideo output of those frames in the vector's planar format, such as yuv422p10le.
     */
    sha256: string
    stream: GPUDecodeStreamFacts
}>;

/** A vector set the engine cannot read: the detail names where. */
export class GPUDecoderVectorSetError extends Error {
    constructor(detail: string) {
        super(detail);
        this.name = 'GPUDecoderVectorSetError';
    }
}

function alignToWord(byteLength: number): number {
    return Math.ceil(byteLength / WORD_BYTE_LENGTH) * WORD_BYTE_LENGTH;
}

function toHexadecimal(bytes: Uint8Array): string {
    let hexadecimal = '';
    for (const byte of bytes) {
        hexadecimal += byte.toString(HEXADECIMAL_RADIX).padStart(BYTE_HEXADECIMAL_DIGIT_COUNT, '0');
    }
    return hexadecimal;
}

function fromHexadecimal(hexadecimal: string): Uint8Array {
    const bytes = new Uint8Array(hexadecimal.length / BYTE_HEXADECIMAL_DIGIT_COUNT);
    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
        const digitIndex = byteIndex * BYTE_HEXADECIMAL_DIGIT_COUNT;
        bytes[byteIndex] = Number.parseInt(hexadecimal.slice(digitIndex, digitIndex + BYTE_HEXADECIMAL_DIGIT_COUNT), HEXADECIMAL_RADIX);
    }
    return bytes;
}

class SetReader {
    position: number;
    private readonly bytes: Uint8Array;
    private readonly end: number;
    private readonly view: DataView;

    constructor(set: ArrayBuffer, start: number, end: number) {
        this.bytes = new Uint8Array(set);
        this.view = new DataView(set);
        this.position = start;
        this.end = end;
    }

    readWord(subject: string): number {
        if (this.position + WORD_BYTE_LENGTH > this.end) {
            throw new GPUDecoderVectorSetError(`${subject} at ${this.position} runs past ${this.end}`);
        }
        const value = this.view.getUint32(this.position, LITTLE_ENDIAN);
        this.position += WORD_BYTE_LENGTH;
        return value;
    }

    /** Reads byteLength bytes into a buffer of their own and skips their padding. */
    readBytes(byteLength: number, subject: string): ArrayBuffer {
        const paddedByteLength = alignToWord(byteLength);
        if (this.position + paddedByteLength > this.end) {
            throw new GPUDecoderVectorSetError(`${subject} of ${byteLength} bytes at ${this.position} runs past ${this.end}`);
        }
        const bytes = this.bytes.slice(this.position, this.position + byteLength).buffer;
        this.position += paddedByteLength;
        return bytes;
    }
}

function readPackets(reader: SetReader, subject: string): GPUDecoderVectorPacket[] {
    const packetCount = reader.readWord(`${subject} packet count`);
    const packets: GPUDecoderVectorPacket[] = [];
    for (let packetIndex = 0; packetIndex < packetCount; packetIndex += 1) {
        const packetSubject = `${subject} packet ${packetIndex}`;
        const byteLength = reader.readWord(`${packetSubject} length`);
        const flags = reader.readWord(`${packetSubject} flags`);
        const timestampMicroseconds = reader.readWord(`${packetSubject} timestamp`);
        const durationMicroseconds = reader.readWord(`${packetSubject} duration`);
        if (byteLength === 0) {
            throw new GPUDecoderVectorSetError(`${packetSubject} is empty`);
        }
        packets.push({
            data: reader.readBytes(byteLength, `${packetSubject} data`),
            durationMicroseconds,
            keyframe: (flags & KEYFRAME_FLAG) !== 0,
            timestampMicroseconds
        });
    }
    return packets;
}

function readVector(reader: SetReader, vectorIndex: number): GPUDecoderVector {
    const subject = `vector ${vectorIndex}`;
    // eslint-disable-next-line compat/compat -- Vector checks run only in WebGPU browsers, which all have TextDecoder
    const formatName = new TextDecoder('ascii').decode(reader.readBytes(reader.readWord(`${subject} format length`), `${subject} format`));
    if (!isGPUDecoderOutputFormat(formatName)) {
        throw new GPUDecoderVectorSetError(`${subject} format '${formatName}'`);
    }
    const width = reader.readWord(`${subject} width`);
    const height = reader.readWord(`${subject} height`);
    if (width === 0 || height === 0) {
        throw new GPUDecoderVectorSetError(`${subject} size ${width}x${height}`);
    }
    const firstFrame = reader.readWord(`${subject} first frame`);
    const lastFrame = reader.readWord(`${subject} last frame`);
    if (lastFrame < firstFrame) {
        throw new GPUDecoderVectorSetError(`${subject} frames ${firstFrame} to ${lastFrame}`);
    }
    const sha256 = toHexadecimal(new Uint8Array(reader.readBytes(SHA256_BYTE_LENGTH, `${subject} hash`)));
    const codecPrivateByteLength = reader.readWord(`${subject} codec private length`);
    const codecPrivate = codecPrivateByteLength > 0 ? new Uint8Array(reader.readBytes(codecPrivateByteLength, `${subject} codec private data`)) : null;
    return {
        codecPrivate,
        firstFrame,
        format: formatName,
        lastFrame,
        packets: readPackets(reader, subject),
        sha256,
        stream: createGPUDecodeStreamFacts(width, height, formatName)
    };
}

/** Reads a vector set into its vectors, by the format each checks; throws a GPUDecoderVectorSetError naming what was malformed. */
export function parseGPUDecoderVectorSet(set: ArrayBuffer): ReadonlyMap<GPUDecoderOutputFormat, GPUDecoderVector> {
    const reader = new SetReader(set, 0, set.byteLength);
    const magic = reader.readWord('magic');
    if (magic !== GPU_DECODER_VECTOR_SET_MAGIC) {
        throw new GPUDecoderVectorSetError(`magic 0x${magic.toString(HEXADECIMAL_RADIX)}`);
    }
    const version = reader.readWord('version');
    if (version !== GPU_DECODER_VECTOR_SET_VERSION) {
        throw new GPUDecoderVectorSetError(`version ${version}, expected ${GPU_DECODER_VECTOR_SET_VERSION}`);
    }
    const vectorCount = reader.readWord('vector count');
    const vectors = new Map<GPUDecoderOutputFormat, GPUDecoderVector>();
    for (let vectorIndex = 0; vectorIndex < vectorCount; vectorIndex += 1) {
        const vectorByteLength = reader.readWord(`vector ${vectorIndex} length`);
        const vectorEnd = reader.position + vectorByteLength;
        if (vectorEnd > set.byteLength) {
            throw new GPUDecoderVectorSetError(`vector ${vectorIndex} of ${vectorByteLength} bytes runs past the set`);
        }
        const vectorReader = new SetReader(set, reader.position, vectorEnd);
        const vector = readVector(vectorReader, vectorIndex);
        if (vectorReader.position !== vectorEnd) {
            throw new GPUDecoderVectorSetError(`vector ${vectorIndex} has ${vectorEnd - vectorReader.position} unread bytes`);
        }
        if (vectors.has(vector.format)) {
            throw new GPUDecoderVectorSetError(`vector ${vectorIndex} repeats format ${vector.format}`);
        }
        vectors.set(vector.format, vector);
        reader.position = vectorEnd;
    }
    if (reader.position !== set.byteLength) {
        throw new GPUDecoderVectorSetError(`${set.byteLength - reader.position} trailing bytes`);
    }
    return vectors;
}

const MAXIMUM_WORD_VALUE = 0xFFFF_FFFF;

class SetWriter {
    private readonly chunks: Uint8Array[] = [];

    word(value: number): void {
        if (!Number.isSafeInteger(value) || value < 0 || value > MAXIMUM_WORD_VALUE) {
            throw new GPUDecoderVectorSetError(`${value} is no set word`);
        }
        const chunk = new Uint8Array(WORD_BYTE_LENGTH);
        new DataView(chunk.buffer).setUint32(0, value, LITTLE_ENDIAN);
        this.chunks.push(chunk);
    }

    bytes(data: Uint8Array): void {
        const chunk = new Uint8Array(alignToWord(data.byteLength));
        chunk.set(data);
        this.chunks.push(chunk);
    }

    finish(): Uint8Array {
        const byteLength = this.chunks.reduce((sum: number, chunk: Uint8Array): number => sum + chunk.byteLength, 0);
        const result = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of this.chunks) {
            result.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return result;
    }
}

function encodeVector(vector: GPUDecoderVector): Uint8Array {
    if (!SHA256_PATTERN.test(vector.sha256)) {
        throw new GPUDecoderVectorSetError(`'${vector.sha256}' is no SHA-256`);
    }
    const writer = new SetWriter();
    const formatBytes = new TextEncoder().encode(vector.format);
    writer.word(formatBytes.byteLength);
    writer.bytes(formatBytes);
    writer.word(vector.stream.visibleRectangle.width);
    writer.word(vector.stream.visibleRectangle.height);
    writer.word(vector.firstFrame);
    writer.word(vector.lastFrame);
    writer.bytes(fromHexadecimal(vector.sha256));
    writer.word(vector.codecPrivate?.byteLength ?? 0);
    if (vector.codecPrivate) {
        writer.bytes(vector.codecPrivate);
    }
    writer.word(vector.packets.length);
    for (const packet of vector.packets) {
        writer.word(packet.data.byteLength);
        writer.word(packet.keyframe ? KEYFRAME_FLAG : 0);
        writer.word(packet.timestampMicroseconds);
        writer.word(packet.durationMicroseconds);
        writer.bytes(new Uint8Array(packet.data));
    }
    return writer.finish();
}

/**
 * Writes a vector set, which parseGPUDecoderVectorSet reads back; tests write vectors this way.
 * Each vector stores its visible size as the track size, so its stream facts must be the ones createGPUDecodeStreamFacts derives.
 */
export function encodeGPUDecoderVectorSet(vectors: readonly GPUDecoderVector[]): Uint8Array {
    const writer = new SetWriter();
    writer.word(GPU_DECODER_VECTOR_SET_MAGIC);
    writer.word(GPU_DECODER_VECTOR_SET_VERSION);
    writer.word(vectors.length);
    for (const vector of vectors) {
        const encoded = encodeVector(vector);
        writer.word(encoded.byteLength);
        writer.bytes(encoded);
    }
    return writer.finish();
}
