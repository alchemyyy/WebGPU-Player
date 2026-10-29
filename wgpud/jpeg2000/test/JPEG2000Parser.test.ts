// @vitest-environment node

import { beforeAll, describe, expect, it } from 'vitest';

import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import GPUDecoderParserInstance, {
    getGPUDecoderParserModule,
    GPUDecoderParserError,
    type GPUDecoderParserModule,
    type GPUDecoderParserOutput,
    type GPUDecoderParserPicture
} from 'webgpu-player/decode/video/gpu/GPUDecoderParser';
import { splitUnits } from 'webgpu-player/decode/video/gpu/GPUDecoderParserPipeline';
import { createGPUDecoderModule } from 'webgpu-player/decode/video/gpu/GPUDecoderPrelude';
import type { GPUDecoderManifest } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';
import { parseGPUDecoderVectorSet, type GPUDecoderVector } from 'webgpu-player/decode/video/gpu/GPUDecoderVectorSet';

import { loadDecoderProjectVideoPackage, readDecoderProjectVectors, requireFixedPacketByteLength } from '../../../test/helpers/decoderPackages';

const PROJECT = 'jpeg2000';
// Parse workers the split decode spreads each picture's tiles over
const PARSE_JOB_COUNT = 2;
// The record fields the tests read, as the body names them after RECORD_
const RECORD_CONSTANT_PATTERN = /^const RECORD_([A-Z0-9_]+): u32 = (\d+)u;$/gm;
const PRELUDE_CHROMA_FORMAT_PATTERN = /^const OUTPUT_CHROMA_FORMAT: u32 = (\d+)u;$/m;
const PRELUDE_BIT_DEPTH_PATTERN = /^const OUTPUT_BIT_DEPTH: u32 = (\d+)u;$/m;
const BYTES_PER_WORD = 4;

// Error names and the failing values the parser reports with them
const CODESTREAM_MISSING_ERROR = 'codestreamMissing';
const MISSING_CODESTREAM_BOX = 1;
const MISSING_START_MARKER = 2;
const MARKER_SEGMENT_ERROR = 'markerSegment';
const TILE_MISSING_ERROR = 'tileMissing';
const PICTURE_SIZE_ERROR = 'pictureSize';
const PICTURE_AREA_ERROR = 'pictureArea';
const COLOUR_SPACE_ERROR = 'colourSpace';
// The colourSpace value of the RGB formats FFmpeg picks for a 4:4:4 codestream without colour
const RGB_FAMILY = 1;
const ERROR_CODE_SHIFT = 24;
// A codestream's Rsiz, its capabilities, after SOC, the SIZ marker, and Lsiz; the Digital Cinema 2K profile makes FFmpeg read XYZ
const RSIZ_OFFSET = 6;
const DIGITAL_CINEMA_2K_PROFILE = 3;
// The 4:4:4 12-bit format an XYZ picture's output stage writes
const CHROMA_FORMAT_444 = 3;
const TWELVE_BITS = 12;

// A JP2 signature box, which promises a codestream box after it
const JP2_SIGNATURE = [ 0x00, 0x00, 0x00, 0x0C, 0x6A, 0x50, 0x20, 0x20, 0x0D, 0x0A, 0x87, 0x0A ];
const BYTES_WITHOUT_CODESTREAM = [ 0x00, 0x01, 0x02, 0x03, 0xFF, 0x00, 0xFF, 0x4E ];
// Where a codestream starts in a JP2 sample: its SOC marker, then the SIZ marker
const CODESTREAM_START = [ 0xFF, 0x4F, 0xFF, 0x51 ];

// A synthetic codestream: 8-bit 4:2:0 tiles 8 samples wide over 16 rows, the 5/3 wavelet without decomposition, every packet empty
const START_OF_CODESTREAM = 0xFF4F;
const IMAGE_AND_TILE_SIZE = 0xFF51;
const CODING_STYLE_DEFAULT = 0xFF52;
const QUANTIZATION_DEFAULT = 0xFF5C;
const START_OF_TILE_PART = 0xFF90;
const START_OF_DATA = 0xFF93;
const END_OF_CODESTREAM = 0xFFD9;
const SYNTHETIC_HEIGHT = 16;
const SYNTHETIC_TILE_WIDTH = 8;
const SYNTHETIC_TILE_COLUMNS = 2;
const SYNTHETIC_WIDTH = SYNTHETIC_TILE_WIDTH * SYNTHETIC_TILE_COLUMNS;
// The luma component, then two chroma components halved on both axes
const COMPONENT_SUBSAMPLING = [ 1, 2, 2 ];
// Ssiz: unsigned, 8 bits
const EIGHT_BIT_UNSIGNED_PRECISION = 7;
// Lsiz: its own length, Rsiz, the eight geometry words, and Csiz, then three bytes per component; it follows SOC at this offset
const SIZ_FIXED_LENGTH = 38;
const SIZ_COMPONENT_LENGTH = 3;
const SIZ_LENGTH_OFFSET = 4;
const NO_CAPABILITIES = 0;
// The image and its tiles start at the reference grid's origin
const ORIGIN = 0;
// Lcod: no precinct sizes; Scod, SGcod's progression order, layer count, and component transform, then SPcod
const COD_LENGTH = 12;
const NO_CODING_OPTIONS = 0;
const LAYER_RESOLUTION_COMPONENT_POSITION = 0;
const LAYER_COUNT = 1;
const NO_COMPONENT_TRANSFORM = 0;
const DECOMPOSITION_LEVELS = 0;
// 64x64 code blocks, each side's exponent less two
const CODE_BLOCK_SIZE_EXPONENT = 4;
const DEFAULT_CODE_BLOCK_STYLE = 0;
const REVERSIBLE_WAVELET = 1;
// Lqcd: Sqcd with one guard bit and no quantization, then the one band's exponent in its high five bits
const QCD_LENGTH = 4;
const GUARD_BITS_SHIFT = 5;
const GUARD_BITS = 1;
const EXPONENT_SHIFT = 3;
const BAND_EXPONENT = 8;
// Lsot, and Psot: the SOT marker and segment, SOD, and one byte of packet data
const SOT_LENGTH = 10;
const TILE_PART_LENGTH = 15;
const FIRST_TILE_PART = 0;
const TILE_PART_COUNT = 1;
// A packet whose first header bit says it is empty
const EMPTY_PACKET = 0x00;
// A synthetic codestream that names more tiles than it codes, with a different width than the complete one
const PARTIAL_TILE_COLUMNS = 3;
const FIRST_MISSING_TILE = 1;
// Synthetic pictures past the largest the decoder accepts: one side too wide, then an area too large within both sides
const OVERSIZED_WIDTH = 8200;
const OVERSIZED_AREA_WIDTH = 8192;
const OVERSIZED_AREA_HEIGHT = 1352;
const SIZE_MASK = 0xFFFF;
const BYTE_MASK = 0xFF;
const BYTE_SHIFT = 8;
const HALF_WORD_SHIFT = 16;

// Deterministic damage to a vector's packet: cuts at even steps through it, and single bytes inverted at even steps
const TRUNCATION_COUNT = 64;
const INVERSION_COUNT = 256;
const INVERTED_BITS = 0xFF;

let jpeg2000Parser: GPUDecoderParserModule;
let manifest: GPUDecoderManifest;
let vectors: ReadonlyMap<GPUDecoderOutputFormat, GPUDecoderVector>;
let recordFields: ReadonlyMap<string, number>;

beforeAll(async () => {
    const decoderPackage = await loadDecoderProjectVideoPackage(PROJECT);
    manifest = decoderPackage.manifest;
    jpeg2000Parser = getGPUDecoderParserModule(decoderPackage);
    vectors = parseGPUDecoderVectorSet(readDecoderProjectVectors(PROJECT));
    recordFields = new Map([ ...manifest.body.matchAll(RECORD_CONSTANT_PATTERN) ].map(([ , name, value ]): [ string, number ] => [ name, Number(value) ]));
});

function requireRecordField(name: string): number {
    const value = recordFields.get(name);
    if (value === undefined) {
        throw new Error(`The body declares no RECORD_${name}`);
    }
    return value;
}

/** Reads a header field of a record by its layout name. */
function readHeaderField(record: ArrayBuffer, name: string): number {
    return new Uint32Array(record)[requireRecordField(`HEADER_${name}`)];
}

/** Returns the record of the one picture a codestream decodes to, the only picture a JPEG 2000 packet holds. */
function requireRecord(output: GPUDecoderParserOutput | GPUDecoderParserPicture): ArrayBuffer {
    if ('record' in output) {
        return output.record;
    }
    if (output.pictures.length !== 1) {
        throw new Error(`The parser made ${output.pictures.length} pictures`);
    }
    return output.pictures[0].record;
}

function requireMatch(pattern: RegExp, text: string): RegExpExecArray {
    const match = pattern.exec(text);
    if (!match) {
        throw new Error(`No match of ${pattern.source}`);
    }
    return match;
}

function requireErrorCode(name: string): number {
    const code = [ ...manifest.errors ].find(([ , errorName ]) => errorName === name)?.[0];
    if (code === undefined) {
        throw new Error(`The decoder names no ${name} error`);
    }
    return code;
}

function requireVector(format: GPUDecoderOutputFormat): GPUDecoderVector {
    const vector = vectors.get(format);
    if (!vector) {
        throw new Error(`No ${format} vector`);
    }
    return vector;
}

/** Runs a call that must fail a parser check, and returns the error name and value it reports. */
function captureFailure(call: () => unknown): string {
    try {
        call();
    } catch (error) {
        if (error instanceof GPUDecoderParserError) {
            return `${manifest.errors.get(error.code)}: ${error.value}`;
        }
        throw error;
    }
    throw new Error('The call did not fail');
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

/** Returns the index of the first occurrence of a byte sequence, or -1. */
function findBytes(bytes: Uint8Array, sequence: readonly number[]): number {
    for (let start = 0; start + sequence.length <= bytes.length; start += 1) {
        if (sequence.every((value: number, offset: number): boolean => bytes[start + offset] === value)) {
            return start;
        }
    }
    return -1;
}

/** Returns a JP2 sample's bare codestream: its bytes from SOC on. */
function extractCodestream(sample: Uint8Array): Uint8Array {
    const start = findBytes(sample, CODESTREAM_START);
    if (start < 0) {
        throw new Error('The sample holds no codestream');
    }
    return sample.slice(start);
}

/** Builds the synthetic codestream of the given size and tile width, coding tile-parts for its first presentTileCount tiles only. */
function createSyntheticCodestream(width: number, height: number, tileWidth: number, presentTileCount: number): Uint8Array {
    const bytes: number[] = [];
    const writeU16 = (value: number): void => {
        bytes.push((value >> BYTE_SHIFT) & BYTE_MASK, value & BYTE_MASK);
    };
    const writeU32 = (value: number): void => {
        writeU16(value >>> HALF_WORD_SHIFT);
        writeU16(value & SIZE_MASK);
    };
    writeU16(START_OF_CODESTREAM);
    writeU16(IMAGE_AND_TILE_SIZE);
    writeU16(SIZ_FIXED_LENGTH + SIZ_COMPONENT_LENGTH * COMPONENT_SUBSAMPLING.length);
    writeU16(NO_CAPABILITIES);
    // The image size and offset, then the tile size and offset
    for (const value of [ width, height, ORIGIN, ORIGIN, tileWidth, height, ORIGIN, ORIGIN ]) {
        writeU32(value);
    }
    writeU16(COMPONENT_SUBSAMPLING.length);
    for (const subsampling of COMPONENT_SUBSAMPLING) {
        bytes.push(EIGHT_BIT_UNSIGNED_PRECISION, subsampling, subsampling);
    }
    writeU16(CODING_STYLE_DEFAULT);
    writeU16(COD_LENGTH);
    bytes.push(NO_CODING_OPTIONS, LAYER_RESOLUTION_COMPONENT_POSITION);
    writeU16(LAYER_COUNT);
    bytes.push(NO_COMPONENT_TRANSFORM, DECOMPOSITION_LEVELS, CODE_BLOCK_SIZE_EXPONENT, CODE_BLOCK_SIZE_EXPONENT, DEFAULT_CODE_BLOCK_STYLE, REVERSIBLE_WAVELET);
    writeU16(QUANTIZATION_DEFAULT);
    writeU16(QCD_LENGTH);
    bytes.push(GUARD_BITS << GUARD_BITS_SHIFT, BAND_EXPONENT << EXPONENT_SHIFT);
    for (let tile = 0; tile < presentTileCount; tile += 1) {
        writeU16(START_OF_TILE_PART);
        writeU16(SOT_LENGTH);
        writeU16(tile);
        writeU32(TILE_PART_LENGTH);
        bytes.push(FIRST_TILE_PART, TILE_PART_COUNT);
        writeU16(START_OF_DATA);
        bytes.push(EMPTY_PACKET);
    }
    writeU16(END_OF_CODESTREAM);
    return new Uint8Array(bytes);
}

function createCompleteCodestream(): Uint8Array {
    return createSyntheticCodestream(SYNTHETIC_WIDTH, SYNTHETIC_HEIGHT, SYNTHETIC_TILE_WIDTH, SYNTHETIC_TILE_COLUMNS);
}

/** Builds a synthetic codestream of one tile over the whole picture. */
function createSingleTileCodestream(width: number, height: number): Uint8Array {
    return createSyntheticCodestream(width, height, width, 1);
}

async function createConfiguredInstance(vector: GPUDecoderVector): Promise<GPUDecoderParserInstance> {
    const instance = await GPUDecoderParserInstance.create(jpeg2000Parser);
    instance.configure(vector.codecPrivate);
    return instance;
}

describe('GPUDecoderParserInstance on the JPEG 2000 package\'s parser', () => {
    it('decodes every packet of each vector into a record of the vector\'s picture in the format the prelude declares, with no output events', async () => {
        expect(vectors.size).toBe(manifest.outputFormats.length);
        for (const [ format, vector ] of vectors) {
            const preludeCode = createGPUDecoderModule(manifest, format).code;
            const instance = await createConfiguredInstance(vector);
            for (const packet of vector.packets) {
                const output = instance.decode(new Uint8Array(packet.data));
                const record = requireRecord(output);

                expect(output.pictures[0].events, format).toHaveLength(0);
                expect(output.pictures[0].visibleSize, format).toBeNull();
                expect(output.trailingEvents, format).toHaveLength(0);
                expect(readHeaderField(record, 'MAGIC'), format).toBe(requireRecordField('MAGIC'));
                expect(readHeaderField(record, 'VERSION'), format).toBe(requireRecordField('VERSION'));
                expect(readHeaderField(record, 'BYTE_LENGTH'), format).toBe(record.byteLength);
                expect(record.byteLength, format).toBeLessThanOrEqual(requireFixedPacketByteLength(manifest));
                expect(readHeaderField(record, 'WIDTH'), format).toBe(vector.stream.visibleRectangle.width);
                expect(readHeaderField(record, 'HEIGHT'), format).toBe(vector.stream.visibleRectangle.height);
                expect(readHeaderField(record, 'FORMAT_ERROR'), format).toBe(0);
                expect(readHeaderField(record, 'CHROMA_FORMAT'), format).toBe(Number(requireMatch(PRELUDE_CHROMA_FORMAT_PATTERN, preludeCode)[1]));
                expect(readHeaderField(record, 'OUTPUT_BIT_DEPTH'), format).toBe(Number(requireMatch(PRELUDE_BIT_DEPTH_PATTERN, preludeCode)[1]));
            }
            instance.destroy();
        }
    });

    it('plans, parses its tiles on another instance, and finishes each picture into the record decode makes', async () => {
        let tiledPictureCount = 0;
        for (const [ format, vector ] of vectors) {
            const decoder = await createConfiguredInstance(vector);
            const coordinator = await createConfiguredInstance(vector);
            // A parse worker's instance is never configured: a plan carries what its tiles need
            const parser = await GPUDecoderParserInstance.create(jpeg2000Parser);
            for (const packet of vector.packets) {
                const decoded = requireRecord(decoder.decode(new Uint8Array(packet.data)));
                const planned = coordinator.plan(new Uint8Array(packet.data));
                if (planned.kind !== 'picture') {
                    throw new Error(`${format} packet planned as ${planned.kind}`);
                }
                const plan = new Uint8Array(planned.plan);
                const jobs = splitUnits(planned.unitCount, PARSE_JOB_COUNT)
                    .map(([ firstUnit, unitCount ]: [number, number]): ArrayBuffer => parser.parse(plan, firstUnit, unitCount));
                const finished = coordinator.finish(concatenate(jobs));

                expect(planned.unitCount, format).toBe(readHeaderField(decoded, 'TILE_COLUMNS') * readHeaderField(decoded, 'TILE_ROWS'));
                expect(planned.morePictures, format).toBe(false);
                expect(new Uint8Array(requireRecord(finished)), format).toEqual(new Uint8Array(decoded));
                expect([ ...planned.events, ...finished.events ], format).toEqual([]);
                expect(coordinator.planNext(), format).toEqual({ events: new Uint32Array(0), kind: 'no-picture' });
                tiledPictureCount += planned.unitCount > 1 ? 1 : 0;
            }
            for (const instance of [ decoder, coordinator, parser ]) {
                instance.destroy();
            }
        }

        expect(tiledPictureCount).toBeGreaterThan(0);
    });

    it('decodes a synthetic codestream of empty packets into a record of its tiles without code blocks', async () => {
        const instance = await GPUDecoderParserInstance.create(jpeg2000Parser);
        const record = requireRecord(instance.decode(createCompleteCodestream()));
        instance.destroy();
        const lumaSamples = SYNTHETIC_WIDTH * SYNTHETIC_HEIGHT;

        expect(readHeaderField(record, 'WIDTH')).toBe(SYNTHETIC_WIDTH);
        expect(readHeaderField(record, 'HEIGHT')).toBe(SYNTHETIC_HEIGHT);
        expect(readHeaderField(record, 'TILE_COLUMNS')).toBe(SYNTHETIC_TILE_COLUMNS);
        expect(readHeaderField(record, 'TILE_ROWS')).toBe(1);
        expect(readHeaderField(record, 'TILE_COMPONENT_COUNT')).toBe(SYNTHETIC_TILE_COLUMNS * COMPONENT_SUBSAMPLING.length);
        expect(readHeaderField(record, 'CODE_BLOCK_COUNT')).toBe(0);
        // A coefficient word per sample of the luma plane and the two quarter-size chroma planes
        expect(readHeaderField(record, 'COEFFICIENT_WORDS')).toBe(lumaSamples + 2 * lumaSamples / 4);
        expect(record.byteLength % BYTES_PER_WORD).toBe(0);
    });

    it('drops a picture whose tiles fail, so the next packet decodes as it does on a fresh instance', async () => {
        const fresh = await GPUDecoderParserInstance.create(jpeg2000Parser);
        const expected = new Uint8Array(requireRecord(fresh.decode(createCompleteCodestream())));
        fresh.destroy();
        const instance = await GPUDecoderParserInstance.create(jpeg2000Parser);
        const partial = createSyntheticCodestream(SYNTHETIC_TILE_WIDTH * PARTIAL_TILE_COLUMNS, SYNTHETIC_HEIGHT, SYNTHETIC_TILE_WIDTH, 1);

        expect(captureFailure(() => instance.decode(partial))).toBe(`${TILE_MISSING_ERROR}: ${FIRST_MISSING_TILE}`);
        expect(new Uint8Array(requireRecord(instance.decode(createCompleteCodestream())))).toEqual(expected);
        instance.destroy();
    });

    it('reads a bare 4:4:4 codestream as FFmpeg does: RGB without a format to keep, which the record carries for the GPU to report', async () => {
        const sample = new Uint8Array(requireVector('I444').packets[0].data);
        const codestream = extractCodestream(sample);
        const fresh = await GPUDecoderParserInstance.create(jpeg2000Parser);
        const unspecified = requireRecord(fresh.decode(codestream));
        fresh.destroy();
        // FFmpeg keeps the previous picture's format while it fits, so after the YUV sample the bare codestream stays YUV
        const continuing = await GPUDecoderParserInstance.create(jpeg2000Parser);
        continuing.decode(sample);
        const kept = requireRecord(continuing.decode(codestream));
        continuing.destroy();

        expect(readHeaderField(unspecified, 'FORMAT_ERROR')).toBe(((requireErrorCode(COLOUR_SPACE_ERROR) << ERROR_CODE_SHIFT) | RGB_FAMILY) >>> 0);
        expect(readHeaderField(kept, 'FORMAT_ERROR')).toBe(0);
    });

    it('reads a Digital Cinema codestream as FFmpeg does: XYZ, which the record marks for the output stage\'s conversion at 4:4:4 and 12 bits', async () => {
        const sample = new Uint8Array(requireVector('I444P12').packets[0].data);
        const cinema = extractCodestream(sample);
        new DataView(cinema.buffer, cinema.byteOffset).setUint16(RSIZ_OFFSET, DIGITAL_CINEMA_2K_PROFILE);
        const instance = await GPUDecoderParserInstance.create(jpeg2000Parser);
        const xyz = requireRecord(instance.decode(cinema));
        instance.destroy();
        const yuvInstance = await GPUDecoderParserInstance.create(jpeg2000Parser);
        const yuv = requireRecord(yuvInstance.decode(sample));
        yuvInstance.destroy();

        expect([ 'FORMAT_ERROR', 'OUTPUT_TRANSFORM', 'CHROMA_FORMAT', 'OUTPUT_BIT_DEPTH' ].map(name => readHeaderField(xyz, name)))
            .toEqual([ 0, requireRecordField('OUTPUT_TRANSFORM_XYZ'), CHROMA_FORMAT_444, TWELVE_BITS ]);
        expect(readHeaderField(yuv, 'OUTPUT_TRANSFORM')).toBe(requireRecordField('OUTPUT_TRANSFORM_NONE'));
    });

    it('starts over after a reset, forgetting the format a bare codestream would keep', async () => {
        const vector = requireVector('I444');
        const sample = new Uint8Array(vector.packets[0].data);
        const instance = await createConfiguredInstance(vector);
        const first = requireRecord(instance.decode(sample));

        instance.reset();
        instance.configure(vector.codecPrivate);
        const bareAfterReset = requireRecord(instance.decode(extractCodestream(sample)));
        instance.reset();
        instance.configure(vector.codecPrivate);
        const restarted = requireRecord(instance.decode(sample));
        instance.destroy();

        expect(readHeaderField(bareAfterReset, 'FORMAT_ERROR')).toBe(((requireErrorCode(COLOUR_SPACE_ERROR) << ERROR_CODE_SHIFT) | RGB_FAMILY) >>> 0);
        expect(new Uint8Array(restarted)).toEqual(new Uint8Array(first));
    });

    it('reports a packet without a codestream, and a JP2 file without a codestream box, as codestreamMissing', async () => {
        const instance = await GPUDecoderParserInstance.create(jpeg2000Parser);

        expect(captureFailure(() => instance.decode(new Uint8Array(BYTES_WITHOUT_CODESTREAM)))).toBe(`${CODESTREAM_MISSING_ERROR}: ${MISSING_START_MARKER}`);
        expect(captureFailure(() => instance.decode(new Uint8Array(JP2_SIGNATURE)))).toBe(`${CODESTREAM_MISSING_ERROR}: ${MISSING_CODESTREAM_BOX}`);
        instance.destroy();
    });

    it('reports a SIZ segment whose length disagrees with its components as markerSegment with the SIZ marker', async () => {
        const codestream = createCompleteCodestream();
        const view = new DataView(codestream.buffer);
        view.setUint16(SIZ_LENGTH_OFFSET, view.getUint16(SIZ_LENGTH_OFFSET) - 1);
        const instance = await GPUDecoderParserInstance.create(jpeg2000Parser);

        expect(captureFailure(() => instance.decode(codestream))).toBe(`${MARKER_SEGMENT_ERROR}: ${IMAGE_AND_TILE_SIZE}`);
        instance.destroy();
    });

    it('fails a picture past the largest stream the decoder accepts before any tier-2 work, by its side or its area', async () => {
        const instance = await GPUDecoderParserInstance.create(jpeg2000Parser);
        const tooWide = createSingleTileCodestream(OVERSIZED_WIDTH, SYNTHETIC_HEIGHT);
        const tooLarge = createSingleTileCodestream(OVERSIZED_AREA_WIDTH, OVERSIZED_AREA_HEIGHT);

        expect(captureFailure(() => instance.decode(tooWide))).toBe(`${PICTURE_SIZE_ERROR}: ${OVERSIZED_WIDTH}`);
        expect(captureFailure(() => instance.decode(tooLarge))).toBe(`${PICTURE_AREA_ERROR}: ${OVERSIZED_AREA_WIDTH * OVERSIZED_AREA_HEIGHT}`);
        instance.destroy();
    });

    it('turns every cut or damaged packet into a record or a named error, and decodes the intact packet unchanged afterwards', async () => {
        const vector = requireVector('I420');
        const packet = new Uint8Array(vector.packets[0].data);
        const instance = await createConfiguredInstance(vector);
        const expected = new Uint8Array(requireRecord(instance.decode(packet)));
        const damagedPackets: Uint8Array[] = [];
        for (let cut = 1; cut < TRUNCATION_COUNT; cut += 1) {
            damagedPackets.push(packet.slice(0, Math.floor(cut * packet.length / TRUNCATION_COUNT)));
        }
        for (let inversion = 0; inversion < INVERSION_COUNT; inversion += 1) {
            const damaged = packet.slice();
            damaged[Math.floor(inversion * packet.length / INVERSION_COUNT)] ^= INVERTED_BITS;
            damagedPackets.push(damaged);
        }
        const failures: string[] = [];
        for (const [ index, damaged ] of damagedPackets.entries()) {
            try {
                const output = instance.decode(damaged);
                for (const picture of output.pictures) {
                    if (picture.record.byteLength > requireFixedPacketByteLength(manifest)) {
                        failures.push(`${index}: ${picture.record.byteLength} bytes`);
                    }
                }
            } catch (error) {
                if (!(error instanceof GPUDecoderParserError) || !manifest.errors.has(error.code)) {
                    failures.push(`${index}: ${String(error)}`);
                }
            }
        }
        const intact = new Uint8Array(requireRecord(instance.decode(packet)));
        instance.destroy();

        expect(failures).toEqual([]);
        expect(intact).toEqual(expected);
    });
});
