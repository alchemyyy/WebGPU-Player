// @vitest-environment node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import { GPU_DECODER_OUTPUT_EVENT } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';
import GPUDecoderParserInstance, {
    getGPUDecoderParserModule,
    GPUDecoderParserError,
    type GPUDecoderParserModule,
    type GPUDecoderParserOutput,
    type GPUDecoderParserPicture
} from 'webgpu-player/decode/video/gpu/GPUDecoderParser';
import { splitUnits } from 'webgpu-player/decode/video/gpu/GPUDecoderParserPipeline';
import { parseGPUDecoderVectorSet, type GPUDecoderVector } from 'webgpu-player/decode/video/gpu/GPUDecoderVectorSet';

import { loadDecoderProjectVideoPackage, readDecoderProjectVectors } from '../../../test/helpers/decoderPackages';
import { DECODERS_DIRECTORY } from '../../../test/helpers/enginePaths';

const PROJECT = 'mpeg4';
const MEDIA_DIRECTORY = join(DECODERS_DIRECTORY, PROJECT, 'vectors');
const OUTPUT_FORMAT: GPUDecoderOutputFormat = 'I420';
// Parse workers the split decode spreads each picture's units over
const PARSE_JOB_COUNT = 2;
// The vector: Xvid's MPEG-4 Part 2 with GMC, quarter-sample motion, and B-VOPs, in Matroska at presentation timestamps
const VECTOR_SIZE = { height: 120, width: 200 };
const PROGRESSIVE_FIELDS = { repeatFirstField: false, scan: 'progressive' };
// Words of the record header the parser and mpeg4.wgsl share: its magic, 'M5PR' little-endian, its version, and the picture's type
const RECORD_MAGIC = 0x5250_354D;
const RECORD_VERSION = 1;
const RECORD_MAGIC_WORD = 0;
const RECORD_VERSION_WORD = 1;
const RECORD_PICTURE_TYPE_WORD = 2;
const RECORD_TYPE_B = 2;
const RECORD_TYPE_S = 3;
// The codec private data: a 40-byte BITMAPINFOHEADER, its width, height, and FourCC little-endian, then the extradata
const BITMAP_INFO_HEADER_BYTE_LENGTH = 40;
const WIDTH_OFFSET = 4;
const HEIGHT_OFFSET = 8;
const COMPRESSION_OFFSET = 16;
const CONFIGURATION_ERROR_NAME = 'configuration';
const CONFIGURATION_TOO_SHORT = 1;
const CONFIGURATION_SIZE = 2;
const LARGEST_SIDE = 4_096;
// An AVI's RIFF and LIST chunks, which hold chunks after their type, the stream format of its one video stream, and its frames
const CHUNK_HEADER_BYTE_LENGTH = 8;
const LIST_TYPE_BYTE_LENGTH = 4;
const CONTAINER_CHUNK_IDS = new Set([ 'RIFF', 'LIST' ]);
const STREAM_FORMAT_CHUNK_ID = 'strf';
const VIDEO_CHUNK_IDS = new Set([ '00dc', '00db' ]);
// Damage: every packet but the first cut to a fraction of its bytes, and the same packets with bytes flipped from their middle on
const TRUNCATED_FRACTION = 0.3;
const FLIPPED_BYTE_STRIDE = 97;
const FLIP_MASK = 0x5a;
const RESYNC_ERROR_NAMES = new Set([ 'sequenceHeader', 'pictureHeader', 'macroblockLayer', 'bitsExhausted' ]);
const RECORD_DIGEST = 'sha256';

type AVIVideo = Readonly<{ bitmapInfoHeader: Uint8Array, packets: readonly Uint8Array[] }>;

/** What a consumer sees of a decoded picture: its record's digest and picture type, and the pictures its events present. */
type DecodedPicture = Readonly<{ digest: string, presented: readonly number[], type: number }>;

/** A stream of codecs without B pictures, in AVI under its FourCC, its other FourCCs FFmpeg classes as the same codec, and one of another codec. */
type LowDelayMedium = Readonly<{ aliases: readonly string[], fileName: string, otherCodecFourCC: string, size: Readonly<{ height: number, width: number }> }>;

const LOW_DELAY_MEDIA: readonly LowDelayMedium[] = [
    { aliases: [ 'MP43', 'div3', 'MPG3', 'DIV4', 'AP41' ], fileName: 'msmpeg4v3.avi', otherCodecFourCC: 'MP42', size: { height: 144, width: 176 } },
    { aliases: [ 'DIV2', 'mp42' ], fileName: 'msmpeg4v2.avi', otherCodecFourCC: 'MP43', size: { height: 144, width: 176 } },
    { aliases: [ 'S263', 'u263', 'X263' ], fileName: 'h263.avi', otherCodecFourCC: 'MP43', size: { height: 96, width: 128 } }
];
// FFmpeg's mpeg4 encoder under XVID, its VOL in the first packet and B-VOPs in decode order
const B_VOP_AVI_FILE_NAME = 'mpeg4-b-xvid.avi';

let mpeg4Parser: GPUDecoderParserModule;
let mpeg4Vector: GPUDecoderVector;

beforeAll(async () => {
    const decoderPackage = await loadDecoderProjectVideoPackage(PROJECT);
    mpeg4Parser = getGPUDecoderParserModule(decoderPackage);
    const vector = parseGPUDecoderVectorSet(readDecoderProjectVectors(PROJECT)).get(OUTPUT_FORMAT);
    if (!vector) {
        throw new Error(`The ${PROJECT} package carries no ${OUTPUT_FORMAT} vector`);
    }
    mpeg4Vector = vector;
});

/** Reads an AVI's video stream format, a BITMAPINFOHEADER, and its frames in file order. */
function readAVIVideo(fileName: string): AVIVideo {
    const bytes = new Uint8Array(readFileSync(join(MEDIA_DIRECTORY, fileName)));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let bitmapInfoHeader: Uint8Array | null = null;
    const packets: Uint8Array[] = [];
    const readChunks = (start: number, end: number): void => {
        for (let offset = start; offset + CHUNK_HEADER_BYTE_LENGTH <= end;) {
            const chunkID = String.fromCharCode(...bytes.subarray(offset, offset + LIST_TYPE_BYTE_LENGTH));
            const chunkByteLength = view.getUint32(offset + LIST_TYPE_BYTE_LENGTH, true);
            const dataOffset = offset + CHUNK_HEADER_BYTE_LENGTH;
            const data = bytes.subarray(dataOffset, dataOffset + chunkByteLength);
            if (CONTAINER_CHUNK_IDS.has(chunkID)) {
                readChunks(dataOffset + LIST_TYPE_BYTE_LENGTH, dataOffset + chunkByteLength);
            } else if (chunkID === STREAM_FORMAT_CHUNK_ID) {
                bitmapInfoHeader ??= data;
            } else if (VIDEO_CHUNK_IDS.has(chunkID)) {
                packets.push(data);
            }
            // Chunks pad to whole words
            offset = dataOffset + chunkByteLength + (chunkByteLength & 1);
        }
    };
    readChunks(0, bytes.byteLength);
    if (!bitmapInfoHeader) {
        throw new Error(`${fileName} has no stream format`);
    }
    return { bitmapInfoHeader, packets };
}

/** Returns codec private data with another FourCC, as a container that tags the same stream differently passes it. */
function withFourCC(codecPrivate: Uint8Array, fourCC: string): Uint8Array {
    const bytes = codecPrivate.slice();
    bytes.set(Array.from(fourCC, (character: string): number => character.charCodeAt(0)), COMPRESSION_OFFSET);
    return bytes;
}

function createBitmapInfoHeader(width: number, height: number, fourCC: string): Uint8Array {
    const bytes = new Uint8Array(BITMAP_INFO_HEADER_BYTE_LENGTH);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, BITMAP_INFO_HEADER_BYTE_LENGTH, true);
    view.setInt32(WIDTH_OFFSET, width, true);
    view.setInt32(HEIGHT_OFFSET, height, true);
    return withFourCC(bytes, fourCC);
}

/** Returns the one picture a packet decodes to, which every packet of the media holds. */
function requireOnlyPicture(output: GPUDecoderParserOutput): GPUDecoderParserPicture {
    if (output.pictures.length !== 1) {
        throw new Error(`A packet decoded to ${output.pictures.length} pictures`);
    }
    return output.pictures[0];
}

/** A record's digest: records run to tens of kilobytes, which a deep equality walks byte by byte. */
function digestRecord(record: ArrayBuffer): string {
    return createHash(RECORD_DIGEST).update(new Uint8Array(record)).digest('hex');
}

function readPresented(events: Uint32Array): number[] {
    return Array.from(events, (event: number): number => {
        expect(event & GPU_DECODER_OUTPUT_EVENT.discardBit).toBe(0);
        expect(event & GPU_DECODER_OUTPUT_EVENT.reservedBit).toBe(0);
        return event & GPU_DECODER_OUTPUT_EVENT.pictureIndexMask;
    });
}

function concatenate(buffers: readonly ArrayBuffer[]): Uint8Array {
    const bytes = new Uint8Array(buffers.reduce((byteLength: number, buffer: ArrayBuffer): number => byteLength + buffer.byteLength, 0));
    let offset = 0;
    for (const buffer of buffers) {
        bytes.set(new Uint8Array(buffer), offset);
        offset += buffer.byteLength;
    }
    return bytes;
}

async function createConfiguredInstance(codecPrivate: Uint8Array | null): Promise<GPUDecoderParserInstance> {
    const instance = await GPUDecoderParserInstance.create(mpeg4Parser);
    instance.configure(codecPrivate);
    return instance;
}

/** Decodes a stream's packets on one instance, each into one picture at the stream's size and as a progressive I420 frame. */
async function decodeStream(codecPrivate: Uint8Array | null, packets: readonly Uint8Array[], size: Readonly<{ height: number, width: number }>): Promise<DecodedPicture[]> {
    const instance = await createConfiguredInstance(codecPrivate);
    try {
        return packets.map((packet: Uint8Array): DecodedPicture => {
            const picture = requireOnlyPicture(instance.decode(packet));
            const header = new Uint32Array(picture.record, 0, RECORD_PICTURE_TYPE_WORD + 1);
            expect(header[RECORD_MAGIC_WORD]).toBe(RECORD_MAGIC);
            expect(header[RECORD_VERSION_WORD]).toBe(RECORD_VERSION);
            expect(picture.visibleSize).toEqual(size);
            expect(picture.maximumPictureSize).toEqual(size);
            expect(picture.format).toBe(OUTPUT_FORMAT);
            expect(picture.fields).toEqual(PROGRESSIVE_FIELDS);
            expect(picture.repeatCounts).toEqual([]);
            return { digest: digestRecord(picture.record), presented: readPresented(picture.events), type: header[RECORD_PICTURE_TYPE_WORD] };
        });
    } finally {
        instance.destroy();
    }
}

/**
 * Requires a B picture to present itself at once and an anchor to present the anchor before it, which FFmpeg's decoder outputs then.
 * Returns the last anchor, which waits for the end of the track.
 */
function expectAnchorsOneLate(pictures: readonly DecodedPicture[]): number | null {
    let waitingAnchor: number | null = null;
    for (const [ pictureIndex, picture ] of pictures.entries()) {
        if (picture.type === RECORD_TYPE_B) {
            expect(picture.presented).toEqual([ pictureIndex ]);
        } else {
            expect(picture.presented).toEqual(waitingAnchor === null ? [] : [ waitingAnchor ]);
            waitingAnchor = pictureIndex;
        }
    }
    return waitingAnchor;
}

/** Damages a packet: cut short, or bytes flipped from its middle on. */
function damagePacket(data: ArrayBuffer, truncate: boolean): Uint8Array {
    const bytes = new Uint8Array(data).slice();
    if (truncate) {
        return bytes.subarray(0, Math.floor(bytes.byteLength * TRUNCATED_FRACTION));
    }
    for (let byteIndex = bytes.byteLength >> 1; byteIndex < bytes.byteLength; byteIndex += FLIPPED_BYTE_STRIDE) {
        bytes[byteIndex] ^= FLIP_MASK;
    }
    return bytes;
}

describe('GPUDecoderParserInstance on the MPEG-4 package\'s parser', () => {
    it('configures from the vector\'s BITMAPINFOHEADER, reporting its coded size as the largest picture', async () => {
        const instance = await GPUDecoderParserInstance.create(mpeg4Parser);

        expect(instance.configure(mpeg4Vector.codecPrivate)).toEqual(VECTOR_SIZE);
        instance.destroy();
    });

    it('decodes each GMC and B-VOP packet into one picture, presenting B pictures at once and anchors one late, in timestamp order', async () => {
        const packets = mpeg4Vector.packets.map(packet => new Uint8Array(packet.data));
        const pictures = await decodeStream(mpeg4Vector.codecPrivate, packets, VECTOR_SIZE);
        const presented = pictures.flatMap(picture => picture.presented);

        expect(pictures.some(picture => picture.type === RECORD_TYPE_S)).toBe(true);
        const lastAnchor = expectAnchorsOneLate(pictures);
        // Every picture but the last anchor presents in its timestamp's order
        expect(presented).toEqual(mpeg4Vector.packets
            .map((packet, packetIndex: number) => ({ packetIndex, timestamp: packet.timestampMicroseconds }))
            .sort((first, second) => first.timestamp - second.timestamp)
            .map(({ packetIndex }) => packetIndex)
            .filter((packetIndex: number): boolean => packetIndex !== lastAnchor));
    });

    it('reads an MPEG-4 Part 2 stream\'s VOL from its first packet when the extradata holds none, B pictures again at once and anchors one late', async () => {
        const video = readAVIVideo(B_VOP_AVI_FILE_NAME);
        const pictures = await decodeStream(video.bitmapInfoHeader, video.packets, { height: 144, width: 176 });

        expect(pictures.some(picture => picture.type === RECORD_TYPE_B)).toBe(true);
        expectAnchorsOneLate(pictures);
    });

    it.each(LOW_DELAY_MEDIA)('presents each picture of $fileName at once, as a stream without B pictures outputs', async (medium: LowDelayMedium) => {
        const video = readAVIVideo(medium.fileName);
        const pictures = await decodeStream(video.bitmapInfoHeader, video.packets, medium.size);

        for (const [ pictureIndex, picture ] of pictures.entries()) {
            expect(picture.presented).toEqual([ pictureIndex ]);
        }
    });

    it.each(LOW_DELAY_MEDIA)('classes $fileName\'s codec by the FourCC as FFmpeg does, whatever its case', async (medium: LowDelayMedium) => {
        const video = readAVIVideo(medium.fileName);
        const decoded = await decodeStream(video.bitmapInfoHeader, video.packets, medium.size);
        const otherCodec = await decodeStream(withFourCC(video.bitmapInfoHeader, medium.otherCodecFourCC), video.packets, medium.size)
            .catch((error: unknown): null => {
                expect(error).toBeInstanceOf(GPUDecoderParserError);
                return null;
            });

        for (const alias of medium.aliases) {
            expect(await decodeStream(withFourCC(video.bitmapInfoHeader, alias), video.packets, medium.size)).toEqual(decoded);
        }
        expect(otherCodec).not.toEqual(decoded);
    });

    it('plans, parses on other instances, and finishes each picture into the record and events that decode makes', async () => {
        const decoder = await createConfiguredInstance(mpeg4Vector.codecPrivate);
        const coordinator = await createConfiguredInstance(mpeg4Vector.codecPrivate);
        // A parse worker's instance is never configured: a plan carries what its units need
        const parsers = [ await GPUDecoderParserInstance.create(mpeg4Parser), await GPUDecoderParserInstance.create(mpeg4Parser) ];
        for (const packet of mpeg4Vector.packets) {
            const decoded = requireOnlyPicture(decoder.decode(new Uint8Array(packet.data)));
            // Every earlier picture finished, so even a B picture, which reads the next anchor's motion, plans at once
            const planned = coordinator.plan(new Uint8Array(packet.data));
            if (planned.kind !== 'picture') {
                throw new Error(`A packet planned as ${planned.kind}`);
            }
            expect(planned.morePictures).toBe(false);
            const plan = new Uint8Array(planned.plan);
            const jobs = splitUnits(planned.unitCount, PARSE_JOB_COUNT)
                .map(([ firstUnit, unitCount ]: [number, number], jobIndex: number): ArrayBuffer => parsers[jobIndex % parsers.length].parse(plan, firstUnit, unitCount));
            const finished = coordinator.finish(concatenate(jobs));

            expect(digestRecord(finished.record)).toBe(digestRecord(decoded.record));
            expect([ ...planned.events, ...finished.events ]).toEqual([ ...decoded.events ]);
            expect(finished.visibleSize).toEqual(decoded.visibleSize);
            expect(finished.fields).toEqual(decoded.fields);
        }
        for (const instance of [ decoder, coordinator, ...parsers ]) {
            instance.destroy();
        }
    });

    it('starts over after a reset, numbering pictures from zero again', async () => {
        const instance = await createConfiguredInstance(mpeg4Vector.codecPrivate);
        const firstPacket = new Uint8Array(mpeg4Vector.packets[0].data);
        const first = requireOnlyPicture(instance.decode(firstPacket));
        instance.decode(new Uint8Array(mpeg4Vector.packets[1].data));

        instance.reset();
        instance.configure(mpeg4Vector.codecPrivate);
        const restarted = requireOnlyPicture(instance.decode(firstPacket));
        instance.destroy();

        expect(digestRecord(restarted.record)).toBe(digestRecord(first.record));
        expect(restarted.events).toEqual(first.events);
    });

    it.each([
        [ 'shorter than a BITMAPINFOHEADER', createBitmapInfoHeader(VECTOR_SIZE.width, VECTOR_SIZE.height, 'XVID').subarray(0, BITMAP_INFO_HEADER_BYTE_LENGTH - 1), CONFIGURATION_TOO_SHORT ],
        [ 'of no width', createBitmapInfoHeader(0, VECTOR_SIZE.height, 'XVID'), CONFIGURATION_SIZE ],
        [ 'wider than the package\'s largest side', createBitmapInfoHeader(LARGEST_SIDE + 1, VECTOR_SIZE.height, 'DIV3'), CONFIGURATION_SIZE ]
    ])('refuses codec private data %s with a configuration failure', async (_description: string, codecPrivate: Uint8Array, value: number) => {
        const instance = await GPUDecoderParserInstance.create(mpeg4Parser);
        const configurationCode = [ ...mpeg4Parser.errorNames ].find(([ , name ]) => name === CONFIGURATION_ERROR_NAME)?.[0] ?? 0;

        expect(() => instance.configure(codecPrivate)).toThrow(new GPUDecoderParserError(configurationCode, value, mpeg4Parser.errorNames));
        instance.destroy();
    });

    it.each([ true, false ])('fails a damaged packet only with an error its header resyncs from, truncated: %s', async (truncate: boolean) => {
        for (const [ packetIndex, packet ] of mpeg4Vector.packets.entries()) {
            if (packetIndex === 0) {
                continue;
            }
            const instance = await createConfiguredInstance(mpeg4Vector.codecPrivate);
            instance.decode(new Uint8Array(mpeg4Vector.packets[0].data));
            try {
                instance.decode(damagePacket(packet.data, truncate));
            } catch (error: unknown) {
                // A trap or any other throw is no decoder error
                expect(error).toBeInstanceOf(GPUDecoderParserError);
                const name = mpeg4Parser.errorNames.get((error as GPUDecoderParserError).code) ?? '';
                expect(RESYNC_ERROR_NAMES.has(name), name).toBe(true);
            }
            instance.destroy();
        }
    });
});
