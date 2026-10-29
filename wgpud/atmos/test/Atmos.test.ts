// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import LAYOUT from '../../../tools/constants.json';
import { ENGINE_ROOT } from '../../../test/helpers/enginePaths';

// The test module `make -C wgpud/atmos module` builds from the shared object audio sources and test/atmos_test_exports.c
const MODULE_PATH = join(ENGINE_ROOT, LAYOUT.decoderBuildDirectory, 'atmos', 'module.wasm');
const HRIR_SOURCE_PATH = join(ENGINE_ROOT, LAYOUT.decodersDirectory, 'atmos', 'atmos_hrir.c');
const INITIAL_MEMORY_PAGES = 256;
const MAXIMUM_MEMORY_PAGES = 4096;
const FLOAT_BYTES = 4;
const POINTER_BYTES = 4;

// atmos.h's status codes and bounds
const ATMOS_OK = 0;
const ATMOS_ERROR_TRUNCATED = -1;
const ATMOS_ERROR_VERSION = -2;
const ATMOS_ERROR_OBJECT_COUNT = -3;
const ATMOS_ERROR_RESERVED = -4;
const ATMOS_ERROR_ELEMENT = -5;
const ATMOS_ERROR_LAYOUT = -7;
const ATMOS_ERROR_SAMPLE_RATE = -8;
const ATMOS_ERROR_QUEUE = -10;
const ATMOS_MAX_OBJECTS = 32;
const ATMOS_MAX_PENDING_UPDATES = 32;
const ATMOS_BINAURAL_LATENCY = 128;
const OBJECT_KIND_BED = 0;
const OBJECT_KIND_DYNAMIC = 2;

const SAMPLE_RATE = 48_000;
const OTHER_SAMPLE_RATE = 44_100;

// FFmpeg's channel bits
const FL = 0x1;
const FR = 0x2;
const FC = 0x4;
const LFE = 0x8;
const BL = 0x10;
const BR = 0x20;
const SL = 0x200;
const SR = 0x400;
const TFL = 0x1000;
const TFR = 0x4000;
const TBL = 0x8000;
const TBR = 0x2_0000;
const TSL = 0x10_0000_0000;
const TSR = 0x20_0000_0000;
const LW = 0x8000_0000;
const RW = 0x1_0000_0000;
const LFE2 = 0x8_0000_0000;

const STEREO = 0x3;
const FIVE_POINT_ONE_BACK = 0x3F;
const FIVE_POINT_ONE_SIDE = 0x60F;
const SEVEN_POINT_ONE = 0x63F;
const FIVE_POINT_ONE_POINT_TWO = 0x503F;
const FIVE_POINT_ONE_POINT_FOUR = 0x2_D03F;
const SEVEN_POINT_ONE_POINT_TWO = 0x563F;
const SEVEN_POINT_ONE_POINT_FOUR = 0x2_D63F;
const LAYOUTS = [
    STEREO, FIVE_POINT_ONE_BACK, FIVE_POINT_ONE_SIDE, SEVEN_POINT_ONE,
    FIVE_POINT_ONE_POINT_TWO, FIVE_POINT_ONE_POINT_FOUR, SEVEN_POINT_ONE_POINT_TWO, SEVEN_POINT_ONE_POINT_FOUR
] as const;

// Where each layout's speakers stand in room coordinates (x from the left wall, y from the front wall, z up), per TS 103 420 Table B.10;
// a 5.1 layout's surround pair stands in the back corners
const SPEAKER_POSITIONS: Readonly<Record<number, readonly [number, number, number]>> = {
    [FL]: [ 0, 0, 0 ], [FR]: [ 1, 0, 0 ], [FC]: [ 0.5, 0, 0 ], [BL]: [ 0, 1, 0 ], [BR]: [ 1, 1, 0 ],
    [TFL]: [ 0, 0, 1 ], [TFR]: [ 1, 0, 1 ], [TBL]: [ 0, 1, 1 ], [TBR]: [ 1, 1, 1 ]
};
const SIDE_POSITIONS_WITH_BACKS: Readonly<Record<number, readonly [number, number, number]>> = { [SL]: [ 0, 0.5, 0 ], [SR]: [ 1, 0.5, 0 ] };
const SIDE_POSITIONS_WITHOUT_BACKS: Readonly<Record<number, readonly [number, number, number]>> = { [SL]: [ 0, 1, 0 ], [SR]: [ 1, 1, 0 ] };

// Test module property and field numbers, as atmos_test_exports.c numbers them
const PROPERTY = { x: 0, y: 1, z: 2, gain: 3, width: 4, depth: 5, height: 6, priority: 7, divergence: 8, screenFactor: 9, depthFactor: 10,
    zones: 11, elevation: 12, snap: 13, active: 14 } as const;
const FIELD = { version: 0, objectCount: 1, bedCount: 2, isfCount: 3, dynamicCount: 4, isfIndex: 5, bedDistribute: 6, updateCount: 7 } as const;
type PropertyName = keyof typeof PROPERTY;

const SQRT_HALF = Math.SQRT1_2;
const GAIN_TOLERANCE_DIGITS = 5;
const LOOSE_TOLERANCE_DIGITS = 3;
const RENDER_FRAMES = 64;

// Real payloads. TrueHD: the first object audio metadata of presentation 3 of fba_atmos_obj.mlp and fba_atmos_dimtrim.mlp, test assets of
// truehdd (Apache-2.0, https://github.com/truehdd/truehdd, truehd/tests/assets), which truehdd decodes to every dynamic object at the front left
// at 0 dB with 1536-sample ramps, behind an LFE bed. E-AC-3: the first EMDF OAMD payload of sample_eac3joc.ec3, a Dolby-encoded
// JOC test asset of androidx/media (Apache-2.0, https://github.com/androidx/media, libraries/test_data/src/test/assets/media/mp4).
const TRUEHD_OBJECT_PAYLOAD = '1f844b8000a270008040e0010081c0020103800402070008040e0010081c0020103800402070008040e0010081c0020103800402070008040e0010081c00201000';
const TRUEHD_TRIM_PAYLOAD = '178847a000a270008040e0010081c0020103800402070008040e0010081c0020103800402070008040e0010081c0020100020000';
const EAC3_JOC_PAYLOAD = '1e5103d2212980039c4e739ce7f99804f87f80804f87f9ff84f87f8cf84f87f8c984f87f99e84f8703e804f87fbe804f8700a804f87f8a804f8009c0a195432ac32af800';

/* eslint-disable @typescript-eslint/naming-convention -- the test module's C export and import names */
type AtmosExports = Readonly<{
    malloc: (byteLength: number) => number
    free: (pointer: number) => void
    atmos_parse_oamd: (payload: number, byteLength: number, metadata: number) => number
    atmos_layout_supported: (mask: number) => number
    atmos_renderer_create: (sampleRate: number) => number
    atmos_renderer_destroy: (renderer: number) => void
    atmos_renderer_set_target: (renderer: number, mask: number, binaural: number) => number
    atmos_renderer_channel_mask: (renderer: number) => number
    atmos_renderer_channel_count: (renderer: number) => number
    atmos_renderer_latency: (renderer: number) => number
    atmos_renderer_add_metadata: (renderer: number, metadata: number, sampleOffset: number) => number
    atmos_renderer_render: (renderer: number, objects: number, frameCount: number, output: number) => number
    atmos_renderer_reset: (renderer: number) => void
    atmos_test_metadata_create: () => number
    atmos_test_metadata_destroy: (metadata: number) => void
    atmos_test_metadata_field: (metadata: number, field: number) => number
    atmos_test_metadata_kind: (metadata: number, object: number) => number
    atmos_test_metadata_bed_channel: (metadata: number, object: number) => number
    atmos_test_metadata_start: (metadata: number, update: number) => number
    atmos_test_metadata_ramp: (metadata: number, update: number) => number
    atmos_test_metadata_property: (metadata: number, update: number, object: number, property: number) => number
    atmos_test_metadata_add_object: (metadata: number, bedChannel: number) => number
    atmos_test_metadata_set_update: (metadata: number, update: number, startSample: number, rampDuration: number) => number
    atmos_test_metadata_set_property: (metadata: number, update: number, object: number, property: number, value: number) => number
    atmos_test_renderer_set_scene: (renderer: number, metadata: number) => number
}>;

let atmos: AtmosExports;
let memory: WebAssembly.Memory;

beforeAll(async () => {
    if (!existsSync(MODULE_PATH)) {
        throw new Error(`Missing ${MODULE_PATH}; build it with make -C wgpud/atmos module`);
    }
    const module = await WebAssembly.compile(readFileSync(MODULE_PATH));
    memory = new WebAssembly.Memory({ initial: INITIAL_MEMORY_PAGES, maximum: MAXIMUM_MEMORY_PAGES });
    const instance = await WebAssembly.instantiate(module, {
        env: { memory, emscripten_notify_memory_growth: () => undefined }
    });
    /* eslint-enable @typescript-eslint/naming-convention */
    const exports = instance.exports as Record<string, unknown>;
    (exports._initialize as () => void)();
    atmos = exports as unknown as AtmosExports;
});

/** Writes bit fields most significant bit first, as the payload carries them. */
class BitWriter {
    private readonly bits: number[] = [];

    public write(value: number, count: number): this {
        for (let bit = count - 1; bit >= 0; bit--) {
            this.bits.push(Math.floor(value / 2 ** bit) % 2);
        }
        return this;
    }

    public writeSigned(value: number, count: number): this {
        return this.write(value < 0 ? value + 2 ** count : value, count);
    }

    public append(other: BitWriter): this {
        this.bits.push(...other.bits);
        return this;
    }

    public get length(): number {
        return this.bits.length;
    }

    /** Pads with zero bits to a whole byte. */
    public pad(): this {
        while (this.bits.length % 8 !== 0) {
            this.bits.push(0);
        }
        return this;
    }

    public toBytes(): Uint8Array {
        this.pad();
        const bytes = new Uint8Array(this.bits.length / 8);
        for (const [ index, bit ] of this.bits.entries()) {
            bytes[index >> 3] |= bit << (7 - (index & 7));
        }
        return bytes;
    }
}

/** An oa_element_md (clause 5.5.4) around element bits: its id, its byte size as variable_bits_max(4, 4) codes it, and b_discard_unknown_element. */
function writeElement(writer: BitWriter, id: number, element: BitWriter, declaredBytes?: number): void {
    const content = new BitWriter().write(0, 1).append(element).pad();
    const sizeBits = (declaredBytes ?? content.length / 8) - 1;
    writer.write(id, 4);
    if (sizeBits < 16) {
        writer.write(sizeBits, 4).write(0, 1);
    } else {
        writer.write(Math.floor(sizeBits / 16) - 1, 4).write(1, 1).write(sizeBits % 16, 4).write(0, 1);
    }
    writer.append(content);
}

type ParsedMetadata = Readonly<{
    result: number
    field: (name: keyof typeof FIELD) => number
    kind: (object: number) => number
    bedChannel: (object: number) => number
    start: (update: number) => number
    ramp: (update: number) => number
    property: (update: number, object: number, name: PropertyName) => number
}>;

/** Parses a payload in the module and reads everything back before freeing it. */
function parse(payload: Uint8Array, check: (metadata: ParsedMetadata) => void): number {
    const bytes = atmos.malloc(Math.max(payload.byteLength, 1));
    new Uint8Array(memory.buffer, bytes, payload.byteLength).set(payload);
    const metadata = atmos.atmos_test_metadata_create();
    try {
        const result = atmos.atmos_parse_oamd(bytes, payload.byteLength, metadata);
        check({
            result,
            field: name => atmos.atmos_test_metadata_field(metadata, FIELD[name]),
            kind: object => atmos.atmos_test_metadata_kind(metadata, object),
            bedChannel: object => atmos.atmos_test_metadata_bed_channel(metadata, object),
            start: update => atmos.atmos_test_metadata_start(metadata, update),
            ramp: update => atmos.atmos_test_metadata_ramp(metadata, update),
            property: (update, object, name) => atmos.atmos_test_metadata_property(metadata, update, object, PROPERTY[name])
        });
        return result;
    } finally {
        atmos.atmos_test_metadata_destroy(metadata);
        atmos.free(bytes);
    }
}

function parseResult(payload: Uint8Array): number {
    return parse(payload, () => undefined);
}

/** The payload header: version 0 and object_count. */
function writeHeader(writer: BitWriter, objectCount: number): BitWriter {
    writer.write(0, 2);
    if (objectCount - 1 >= 31) {
        writer.write(31, 5).write(objectCount - 1 - 31, 7);
    } else {
        writer.write(objectCount - 1, 5);
    }
    return writer;
}

/** A dynamic-object program, with the LFE first when asked */
function writeDynamicProgram(writer: BitWriter, lfe: boolean): BitWriter {
    return writer.write(1, 1).write(lfe ? 1 : 0, 1);
}

/** An object_info_block of an active dynamic object's first update: a full update of every property. */
function writeFullObjectBlock(writer: BitWriter, block: Readonly<{ position: readonly [number, number, number], gainBits?: number,
    zones?: number, elevation?: number, sizeBits?: number, snap?: number, distanceIndex?: number }>): void {
    // b_object_not_active, then object_basic_info: object_gain_idx, and b_default_object_priority
    writer.write(0, 1);
    if (block.gainBits === undefined) {
        writer.write(0, 2);
    } else {
        writer.write(2, 2).write(block.gainBits, 6);
    }
    writer.write(1, 1);
    // object_render_info: position, distance, zones, size, screen reference, snap
    const [ x, y, z ] = block.position;
    writer.write(x, 6).write(y, 6).write(z >= 0 ? 1 : 0, 1).write(Math.abs(z), 4);
    if (block.distanceIndex === undefined) {
        writer.write(0, 1);
    } else {
        writer.write(1, 1).write(0, 1).write(block.distanceIndex, 4);
    }
    writer.write(block.zones ?? 0, 3).write(block.elevation ?? 1, 1);
    if (block.sizeBits === undefined) {
        writer.write(0, 2);
    } else {
        writer.write(1, 2).write(block.sizeBits, 5);
    }
    writer.write(0, 1).write(block.snap ?? 0, 1);
    // b_additional_table_data_exists
    writer.write(0, 1);
}

/** An object_info_block of an object that reuses its basic info and changes only its position by steps */
function writeDifferentialBlock(writer: BitWriter, steps: readonly [number, number, number]): void {
    writer.write(0, 1).write(2, 2).write(3, 2).write(0b0001, 4).write(1, 1);
    writer.writeSigned(steps[0], 3).writeSigned(steps[1], 3).writeSigned(steps[2], 3);
    writer.write(0, 1).write(0, 1).write(0, 1);
}

/** md_update_info with no sample offset and one update without a ramp */
function writeSingleUpdateInfo(writer: BitWriter): BitWriter {
    return writer.write(0, 2).write(0, 3).write(0, 6).write(0, 2).write(1, 1);
}

/** A payload of one dynamic object behind an LFE: the LFE active at 0 dB, the object with the given first update */
function createSingleObjectPayload(block: Parameters<typeof writeFullObjectBlock>[1]): Uint8Array {
    const writer = writeDynamicProgram(writeHeader(new BitWriter(), 2), true);
    writer.write(0, 1).write(1, 4);
    const element = writeSingleUpdateInfo(new BitWriter());
    // The LFE: active, 0 dB, default priority, no render info as a bed object, no table data
    element.write(0, 1).write(0, 2).write(1, 1).write(0, 1);
    writeFullObjectBlock(element, block);
    writeElement(writer, 1, element);
    return writer.toBytes();
}

describe('the OAMD parser', () => {
    it('decodes a dynamic program\'s timing, positions, gains, sizes, zones, and differential updates', () => {
        const writer = writeDynamicProgram(writeHeader(new BitWriter(), 2), true);
        // b_alternate_object_data_present, oa_element_count
        writer.write(0, 1).write(1, 4);
        const element = new BitWriter();
        // sample_offset_code 1 with sample_offset_idx 3 (24 samples), two updates
        element.write(1, 2).write(3, 2).write(1, 3);
        // The first update at block offset 0 with a 512-sample ramp, the second at block offset 10 with ramp_duration_idx 5 (480 samples)
        element.write(0, 6).write(1, 2).write(10, 6).write(3, 2).write(1, 1).write(5, 4);
        element.write(1, 1);
        // The LFE: active at 0 dB in both updates, reusing its basic info in the second
        element.write(0, 1).write(0, 2).write(1, 1).write(0, 1);
        element.write(0, 1).write(2, 2).write(0, 1);
        // The object: at the center of the front wall's top edge, -6 dB, back zone excluded, full size, locked; then 3 steps right, 2 back, 1 down
        writeFullObjectBlock(element, { position: [ 31, 0, 15 ], gainBits: 20, zones: 1, sizeBits: 31, snap: 1 });
        writeDifferentialBlock(element, [ 3, 2, -1 ]);
        writeElement(writer, 1, element);

        parse(writer.toBytes(), metadata => {
            expect(metadata.result).toBe(ATMOS_OK);
            expect(metadata.field('objectCount')).toBe(2);
            expect(metadata.field('bedCount')).toBe(1);
            expect(metadata.field('dynamicCount')).toBe(1);
            expect(metadata.kind(0)).toBe(OBJECT_KIND_BED);
            expect(metadata.bedChannel(0)).toBe(LFE);
            expect(metadata.kind(1)).toBe(OBJECT_KIND_DYNAMIC);
            expect(metadata.field('updateCount')).toBe(2);
            expect(metadata.start(0)).toBe(24);
            expect(metadata.ramp(0)).toBe(512);
            expect(metadata.start(1)).toBe(24 + 32 * 10);
            expect(metadata.ramp(1)).toBe(480);
            expect(metadata.property(0, 0, 'gain')).toBe(1);
            expect(metadata.property(1, 0, 'gain')).toBe(1);
            expect(metadata.property(0, 1, 'x')).toBeCloseTo(31 / 62, GAIN_TOLERANCE_DIGITS);
            expect(metadata.property(0, 1, 'y')).toBe(0);
            expect(metadata.property(0, 1, 'z')).toBe(1);
            expect(metadata.property(0, 1, 'gain')).toBeCloseTo(10 ** (-6 / 20), GAIN_TOLERANCE_DIGITS);
            expect(metadata.property(0, 1, 'priority')).toBe(1);
            expect(metadata.property(0, 1, 'zones')).toBe(1);
            expect(metadata.property(0, 1, 'width')).toBe(1);
            expect(metadata.property(0, 1, 'height')).toBe(1);
            expect(metadata.property(0, 1, 'snap')).toBe(1);
            expect(metadata.property(1, 1, 'x')).toBeCloseTo(34 / 62, GAIN_TOLERANCE_DIGITS);
            expect(metadata.property(1, 1, 'y')).toBeCloseTo(2 / 62, GAIN_TOLERANCE_DIGITS);
            expect(metadata.property(1, 1, 'z')).toBeCloseTo(14 / 15, GAIN_TOLERANCE_DIGITS);
            // The second update reuses the first one's gain, size, and zones
            expect(metadata.property(1, 1, 'gain')).toBeCloseTo(10 ** (-6 / 20), GAIN_TOLERANCE_DIGITS);
            expect(metadata.property(1, 1, 'width')).toBe(1);
            expect(metadata.property(1, 1, 'zones')).toBe(1);
        });
    });

    it('orders standard and non-standard bed channels by speaker label, then ISF and dynamic objects', () => {
        // Two bed instances: L/R, C, and LFE by bed_channel_assignment[9], [8], [7]; then Ls/Rs, Tsl/Tsr by their non-standard flags;
        // then three dynamic objects
        const writer = writeHeader(new BitWriter(), 11);
        writer.write(0, 1).write(0b0101, 4).write(0, 1).write(1, 1).write(0, 3);
        writer.write(0, 1).write(1, 1).write(0b0000000111, 10);
        // nonstd_bed_channel_assignment[] elements 5, 6, 11, and 12: Tsr, Tsl, Rs, and Ls (Table 13)
        writer.write(0, 1).write(0, 1).write(0b00000110000110000, 17);
        writer.write(2, 5);
        writer.write(0, 1).write(0, 4);
        parse(writer.toBytes(), metadata => {
            expect(metadata.result).toBe(ATMOS_OK);
            expect(metadata.field('bedCount')).toBe(8);
            expect(metadata.field('dynamicCount')).toBe(3);
            expect(Array.from({ length: 8 }, (_, object) => metadata.bedChannel(object))).toEqual([ FL, FR, FC, LFE, SL, SR, TSL, TSR ]);
            expect(metadata.kind(8)).toBe(OBJECT_KIND_DYNAMIC);
            expect(metadata.field('updateCount')).toBe(0);
        });
    });

    it('projects an object beyond the walls onto them, and adds extended precision', () => {
        // An object coded halfway between the center and the left wall, at distance factor index 3, lies on the left wall
        const payload = createSingleObjectPayload({ position: [ 15, 31, 0 ], distanceIndex: 3 });
        parse(payload, metadata => {
            expect(metadata.result).toBe(ATMOS_OK);
            expect(metadata.property(0, 1, 'x')).toBe(0);
            expect(metadata.property(0, 1, 'y')).toBeCloseTo(0.5, LOOSE_TOLERANCE_DIGITS);
        });

        const writer = writeDynamicProgram(writeHeader(new BitWriter(), 2), true);
        writer.write(0, 1).write(2, 4);
        const objectElement = writeSingleUpdateInfo(new BitWriter());
        objectElement.write(0, 1).write(0, 2).write(1, 1).write(0, 1);
        writeFullObjectBlock(objectElement, { position: [ 31, 31, 0 ] });
        writeElement(writer, 1, objectElement);
        // extended_object_element: no divergence, then the object's extended precision: X +2 steps, Z -1 step (ext_prec_pos_presence[2] and [0])
        const extended = new BitWriter().write(0, 1).write(1, 1).write(1, 1).write(0b101, 3).write(1, 2).write(2, 2);
        writeElement(writer, 5, extended);
        parse(writer.toBytes(), metadata => {
            expect(metadata.result).toBe(ATMOS_OK);
            expect(metadata.property(0, 1, 'x')).toBeCloseTo(31 / 62 + 2 / 310, GAIN_TOLERANCE_DIGITS);
            expect(metadata.property(0, 1, 'y')).toBeCloseTo(31 / 62, GAIN_TOLERANCE_DIGITS);
            expect(metadata.property(0, 1, 'z')).toBeCloseTo(-1 / 75, GAIN_TOLERANCE_DIGITS);
        });
    });

    it('skips elements it does not render by their size, and inactive objects keep their defaults', () => {
        const writer = writeDynamicProgram(writeHeader(new BitWriter(), 2), false);
        writer.write(0, 1).write(2, 4);
        // A trim element of 40 arbitrary bytes, longer than one size group codes, before the object element
        const trim = new BitWriter();
        for (let index = 0; index < 40; index++) {
            trim.write(0xA5, 8);
        }
        writeElement(writer, 2, trim);
        const element = writeSingleUpdateInfo(new BitWriter());
        // An inactive object, with table data it skips, and an active one
        element.write(1, 1).write(1, 1).write(0, 4).write(0xFF, 8);
        writeFullObjectBlock(element, { position: [ 62, 62, -15 ] });
        writeElement(writer, 1, element);
        parse(writer.toBytes(), metadata => {
            expect(metadata.result).toBe(ATMOS_OK);
            expect(metadata.field('bedCount')).toBe(0);
            expect(metadata.property(0, 0, 'active')).toBe(0);
            expect(metadata.property(0, 0, 'gain')).toBe(0);
            expect(metadata.property(0, 0, 'x')).toBe(0.5);
            expect(metadata.property(0, 1, 'active')).toBe(1);
            expect(metadata.property(0, 1, 'x')).toBe(1);
            expect(metadata.property(0, 1, 'y')).toBe(1);
            expect(metadata.property(0, 1, 'z')).toBe(-1);
        });
    });

    it('reports malformed payloads instead of reading past them', () => {
        const valid = createSingleObjectPayload({ position: [ 0, 0, 0 ] });
        expect(parseResult(valid)).toBe(ATMOS_OK);
        for (let length = 0; length < 3; length++) {
            expect(parseResult(valid.subarray(0, length))).toBe(ATMOS_ERROR_TRUNCATED);
        }
        // A payload cut inside its object element, whose size then claims more than the payload holds
        expect(parseResult(valid.subarray(0, valid.byteLength - 2))).toBe(ATMOS_ERROR_ELEMENT);
        // A payload that ends right after its program assignment: an LFE-only bed for its one object, then no element count
        expect(parseResult(Uint8Array.of(0x00, 0x12))).toBe(ATMOS_ERROR_TRUNCATED);
        expect(parseResult(Uint8Array.of(0x40, 0))).toBe(ATMOS_ERROR_VERSION);
        expect(parseResult(writeDynamicProgram(writeHeader(new BitWriter(), ATMOS_MAX_OBJECTS + 1), false).write(0, 5).toBytes()))
            .toBe(ATMOS_ERROR_OBJECT_COUNT);
        // Dynamic objects that do not add up to object_count
        expect(parseResult(writeHeader(new BitWriter(), 4).write(0, 1).write(0b0100, 4).write(0, 5).write(0, 5).toBytes()))
            .toBe(ATMOS_ERROR_OBJECT_COUNT);
        // A reserved ISF index
        expect(parseResult(writeHeader(new BitWriter(), 4).write(0, 1).write(0b0010, 4).write(6, 3).write(0, 5).toBytes()))
            .toBe(ATMOS_ERROR_RESERVED);
        // An object element whose declared size ends before its objects do
        const writer = writeDynamicProgram(writeHeader(new BitWriter(), 2), true).write(0, 1).write(1, 4);
        const element = writeSingleUpdateInfo(new BitWriter()).write(0, 1).write(0, 2).write(1, 1).write(0, 1);
        writeFullObjectBlock(element, { position: [ 0, 0, 0 ] });
        writeElement(writer, 1, element, 2);
        writer.write(0, 64);
        expect(parseResult(writer.toBytes())).toBe(ATMOS_ERROR_ELEMENT);
    });

    it('decodes real TrueHD payloads as truehdd does', () => {
        for (const [ hex, objectCount ] of [ [ TRUEHD_OBJECT_PAYLOAD, 16 ], [ TRUEHD_TRIM_PAYLOAD, 12 ] ] as const) {
            parse(Buffer.from(hex, 'hex'), metadata => {
                expect(metadata.result).toBe(ATMOS_OK);
                expect(metadata.field('objectCount')).toBe(objectCount);
                expect(metadata.field('bedCount')).toBe(1);
                expect(metadata.bedChannel(0)).toBe(LFE);
                expect(metadata.field('updateCount')).toBe(1);
                expect(metadata.start(0)).toBe(0);
                expect(metadata.ramp(0)).toBe(1536);
                for (let object = 0; object < objectCount; object++) {
                    expect(metadata.property(0, object, 'active')).toBe(1);
                    expect(metadata.property(0, object, 'gain')).toBe(1);
                }
                for (let object = 1; object < objectCount; object++) {
                    expect(metadata.kind(object)).toBe(OBJECT_KIND_DYNAMIC);
                    expect([ metadata.property(0, object, 'x'), metadata.property(0, object, 'y'), metadata.property(0, object, 'z') ]).toEqual([ 0, 0, 0 ]);
                }
            });
        }
    });

    it('decodes a real E-AC-3 JOC payload: a 5.1 bed and ten objects where its JOC upmix puts them', () => {
        parse(Buffer.from(EAC3_JOC_PAYLOAD, 'hex'), metadata => {
            expect(metadata.result).toBe(ATMOS_OK);
            expect(metadata.field('objectCount')).toBe(16);
            expect(Array.from({ length: 6 }, (_, object) => metadata.bedChannel(object))).toEqual([ FL, FR, FC, LFE, SL, SR ]);
            expect(metadata.field('dynamicCount')).toBe(10);
            expect(metadata.ramp(0)).toBe(256);
            // TS 103 420 Table B.10 puts the left wide speaker at ADM (-1, 0.677419, 0): x 0 and y 10/62
            expect(metadata.property(0, 14, 'x')).toBe(0);
            expect(metadata.property(0, 14, 'y')).toBeCloseTo(10 / 62, GAIN_TOLERANCE_DIGITS);
            expect(metadata.property(0, 14, 'z')).toBe(0);
            expect(metadata.property(0, 12, 'y')).toBe(1);
            // Objects 6 to 11 are on the right wall, at room depths 25/62, 0, 31/62, 12/62, 12/62, and 25/62, four of them raised:
            // the stream's JOC upmix rebuilds each of them from the core's R and Rs alone, so the content is on the right, not the parser
            const rightWall = [ [ 25, 0 ], [ 0, 0 ], [ 31, 15 ], [ 12, 15 ], [ 12, 3 ], [ 25, 13 ] ] as const;
            for (const [ index, [ y, z ] ] of rightWall.entries()) {
                expect(metadata.property(0, 6 + index, 'x')).toBe(1);
                expect(metadata.property(0, 6 + index, 'y')).toBeCloseTo(y / 62, GAIN_TOLERANCE_DIGITS);
                expect(metadata.property(0, 6 + index, 'z')).toBeCloseTo(z / 15, GAIN_TOLERANCE_DIGITS);
            }
            expect(metadata.property(0, 13, 'x')).toBe(1);
            expect(metadata.property(0, 15, 'x')).toBe(1);
            expect(metadata.property(0, 15, 'y')).toBeCloseTo(10 / 62, GAIN_TOLERANCE_DIGITS);
        });
    });
});

/** A renderer at a sample rate with a target, destroyed after the callback. */
function withRenderer(sampleRate: number, callback: (renderer: number) => void): void {
    const renderer = atmos.atmos_renderer_create(sampleRate);
    expect(renderer).not.toBe(0);
    try {
        callback(renderer);
    } finally {
        atmos.atmos_renderer_destroy(renderer);
    }
}

type MetadataBuilder = Readonly<{
    pointer: number
    addObject: (bedChannel?: number) => number
    setUpdate: (update: number, startSample: number, rampDuration: number) => void
    set: (update: number, object: number, properties: Partial<Record<PropertyName, number>>) => void
}>;

function withMetadata(callback: (metadata: MetadataBuilder) => void): void {
    const pointer = atmos.atmos_test_metadata_create();
    try {
        callback({
            pointer,
            addObject: (bedChannel = 0) => atmos.atmos_test_metadata_add_object(pointer, bedChannel),
            setUpdate: (update, startSample, rampDuration) => {
                expect(atmos.atmos_test_metadata_set_update(pointer, update, startSample, rampDuration)).toBe(ATMOS_OK);
            },
            set: (update, object, properties) => {
                for (const [ name, value ] of Object.entries(properties)) {
                    expect(atmos.atmos_test_metadata_set_property(pointer, update, object, PROPERTY[name as PropertyName], value)).toBe(ATMOS_OK);
                }
            }
        });
    } finally {
        atmos.atmos_test_metadata_destroy(pointer);
    }
}

/** Renders the objects' planes, NULL for an absent one, and returns the output planes. */
function render(renderer: number, inputs: readonly (Float32Array | null)[], frameCount: number): Float32Array[] {
    const channelCount = atmos.atmos_renderer_channel_count(renderer);
    const pointers: number[] = [];
    const allocate = (byteLength: number): number => {
        const pointer = atmos.malloc(byteLength);
        pointers.push(pointer);
        return pointer;
    };
    try {
        const objectTable = allocate(Math.max(inputs.length, 1) * POINTER_BYTES);
        const objectPlanes = inputs.map(input => {
            if (input === null) {
                return 0;
            }
            const plane = allocate(frameCount * FLOAT_BYTES);
            new Float32Array(memory.buffer, plane, frameCount).set(input);
            return plane;
        });
        new Uint32Array(memory.buffer, objectTable, inputs.length).set(objectPlanes);
        const outputTable = allocate(channelCount * POINTER_BYTES);
        const outputPlanes = Array.from({ length: channelCount }, () => allocate(Math.max(frameCount, 1) * FLOAT_BYTES));
        new Uint32Array(memory.buffer, outputTable, channelCount).set(outputPlanes);
        expect(atmos.atmos_renderer_render(renderer, objectTable, frameCount, outputTable)).toBe(ATMOS_OK);
        return outputPlanes.map(plane => Float32Array.from(new Float32Array(memory.buffer, plane, frameCount)));
    } finally {
        for (const pointer of pointers) {
            atmos.free(pointer);
        }
    }
}

function constant(frameCount: number, value = 1): Float32Array {
    return new Float32Array(frameCount).fill(value);
}

/** The gain on each output channel of one object at a position, with any further properties, rendered from a constant plane */
function panGains(mask: number, properties: Partial<Record<PropertyName, number>>): number[] {
    let gains: number[] = [];
    withRenderer(SAMPLE_RATE, renderer => {
        expect(atmos.atmos_renderer_set_target(renderer, mask, 0)).toBe(ATMOS_OK);
        withMetadata(metadata => {
            metadata.addObject();
            metadata.setUpdate(0, 0, 0);
            metadata.set(0, 0, properties);
            expect(atmos.atmos_renderer_add_metadata(renderer, metadata.pointer, 0)).toBe(ATMOS_OK);
        });
        gains = render(renderer, [ constant(RENDER_FRAMES) ], RENDER_FRAMES).map(plane => plane[RENDER_FRAMES - 1]);
    });
    return gains;
}

/** The channel bits of a mask in plane order */
function channelsOf(mask: number): number[] {
    const channels: number[] = [];
    for (let bit = 0; bit < 32; bit++) {
        if ((mask >>> bit) & 1) {
            channels.push(2 ** bit);
        }
    }
    return channels;
}

function speakerPosition(mask: number, channel: number): readonly [number, number, number] | undefined {
    if (channel === SL || channel === SR) {
        return ((mask & BL) !== 0 ? SIDE_POSITIONS_WITH_BACKS : SIDE_POSITIONS_WITHOUT_BACKS)[channel];
    }
    return SPEAKER_POSITIONS[channel];
}

function sumOfSquares(values: readonly number[]): number {
    return values.reduce((sum, value) => sum + value * value, 0);
}

/** A bed scene's gains on each output channel per bed channel, each rendered alone */
function bedGains(mask: number, beds: readonly number[], channel: number): number[] {
    let gains: number[] = [];
    withRenderer(SAMPLE_RATE, renderer => {
        expect(atmos.atmos_renderer_set_target(renderer, mask, 0)).toBe(ATMOS_OK);
        withMetadata(metadata => {
            for (const bed of beds) {
                metadata.addObject(bed);
            }
            expect(atmos.atmos_test_renderer_set_scene(renderer, metadata.pointer)).toBe(ATMOS_OK);
        });
        const inputs = beds.map(bed => (bed === channel ? constant(RENDER_FRAMES) : null));
        gains = render(renderer, inputs, RENDER_FRAMES).map(plane => plane[0]);
    });
    return gains;
}

describe('the object renderer', () => {
    it('renders to exactly the engine-qualified layouts, in their channel order', () => {
        withRenderer(SAMPLE_RATE, renderer => {
            for (const mask of LAYOUTS) {
                expect(atmos.atmos_layout_supported(mask)).toBe(1);
                expect(atmos.atmos_renderer_set_target(renderer, mask, 0)).toBe(ATMOS_OK);
                expect(atmos.atmos_renderer_channel_mask(renderer)).toBe(mask);
                expect(atmos.atmos_renderer_channel_count(renderer)).toBe(channelsOf(mask).length);
                expect(atmos.atmos_renderer_latency(renderer)).toBe(0);
            }
            expect(atmos.atmos_renderer_set_target(renderer, 0x7, 0)).toBe(ATMOS_ERROR_LAYOUT);
            expect(atmos.atmos_renderer_set_target(renderer, 0x2_D60F, 0)).toBe(ATMOS_ERROR_LAYOUT);
        });
    });

    it('puts an object at a speaker\'s position on that speaker alone', () => {
        for (const mask of LAYOUTS) {
            const channels = channelsOf(mask);
            for (const [ index, channel ] of channels.entries()) {
                const position = speakerPosition(mask, channel);
                if (position === undefined) {
                    continue;
                }
                const gains = panGains(mask, { x: position[0], y: position[1], z: position[2] });
                const expected = channels.map((_, other) => (other === index ? 1 : 0));
                for (const [ other, gain ] of gains.entries()) {
                    expect(gain, `layout 0x${mask.toString(16)} speaker 0x${channel.toString(16)} on channel ${other}`)
                        .toBeCloseTo(expected[other], GAIN_TOLERANCE_DIGITS);
                }
            }
        }
    });

    it('keeps an object\'s power wherever it is and however large, and the LFE silent', () => {
        const positions = [ [ 0.25, 0.1, 0 ], [ 0.7, 0.45, 0.3 ], [ 0.5, 0.5, 1 ], [ 0.1, 0.9, 0.6 ], [ 0.95, 0.75, -0.5 ] ] as const;
        for (const mask of LAYOUTS) {
            const lfeIndex = channelsOf(mask).indexOf(LFE);
            for (const [ x, y, z ] of positions) {
                for (const size of [ 0, 0.3, 1 ]) {
                    const gains = panGains(mask, { x, y, z, width: size, depth: size, height: size, gain: 0.5 });
                    expect(sumOfSquares(gains)).toBeCloseTo(0.25, GAIN_TOLERANCE_DIGITS);
                    if (lfeIndex >= 0) {
                        expect(gains[lfeIndex]).toBe(0);
                    }
                }
            }
        }
    });

    it('pans between speakers with the sine law, and folds heights into the floor without heights', () => {
        // Halfway between the front pair, the center of a stereo layout's front gets each at sqrt(1/2)
        expect(panGains(STEREO, { x: 0.5, y: 0, z: 0 })).toEqual([ expect.closeTo(SQRT_HALF, GAIN_TOLERANCE_DIGITS), expect.closeTo(SQRT_HALF, GAIN_TOLERANCE_DIGITS) ]);
        // A 5.1 layout has no side speakers: an object at the left wall's middle is between the front left and the left surround
        const fiveOne = panGains(FIVE_POINT_ONE_BACK, { x: 0, y: 0.5, z: 0 });
        expect(fiveOne[0]).toBeCloseTo(SQRT_HALF, GAIN_TOLERANCE_DIGITS);
        expect(fiveOne[4]).toBeCloseTo(SQRT_HALF, GAIN_TOLERANCE_DIGITS);
        // Overhead at the back left: on the top back left speaker of 7.1.4, the back left of 7.1, and the top front left of 7.1.2's single top row
        expect(panGains(SEVEN_POINT_ONE_POINT_FOUR, { x: 0, y: 1, z: 1 })[10]).toBeCloseTo(1, GAIN_TOLERANCE_DIGITS);
        expect(panGains(SEVEN_POINT_ONE, { x: 0, y: 1, z: 1 })[4]).toBeCloseTo(1, GAIN_TOLERANCE_DIGITS);
        expect(panGains(SEVEN_POINT_ONE_POINT_TWO, { x: 0, y: 1, z: 1 })[8]).toBeCloseTo(1, GAIN_TOLERANCE_DIGITS);
        // Half way up, between the floor and the heights at equal power
        const halfway = panGains(FIVE_POINT_ONE_POINT_FOUR, { x: 0, y: 0, z: 0.5 });
        expect(halfway[0]).toBeCloseTo(SQRT_HALF, GAIN_TOLERANCE_DIGITS);
        expect(halfway[6]).toBeCloseTo(SQRT_HALF, GAIN_TOLERANCE_DIGITS);
    });

    it('honors zone constraints, elevation, and channel lock', () => {
        // Back zone excluded: a 7.1 object in the back left corner moves to the side; with only the screen zone, to the front left
        expect(panGains(SEVEN_POINT_ONE, { x: 0, y: 1, z: 0, zones: 1 })[6]).toBeCloseTo(1, GAIN_TOLERANCE_DIGITS);
        expect(panGains(SEVEN_POINT_ONE, { x: 0, y: 1, z: 0, zones: 4 })[0]).toBeCloseTo(1, GAIN_TOLERANCE_DIGITS);
        // Elevation excluded: an overhead object stays on the floor
        const floor = panGains(SEVEN_POINT_ONE_POINT_FOUR, { x: 0, y: 0, z: 1, elevation: 0 });
        expect(floor[0]).toBeCloseTo(1, GAIN_TOLERANCE_DIGITS);
        expect(floor.slice(8).every(gain => gain === 0)).toBe(true);
        // Locked near the center speaker, it plays from that speaker alone; locked too far from any, it pans
        expect(panGains(SEVEN_POINT_ONE, { x: 0.45, y: 0.05, z: 0, snap: 1 })[2]).toBe(1);
        expect(sumOfSquares(panGains(SEVEN_POINT_ONE, { x: 0.25, y: 0.25, z: 0, snap: 1 }))).toBeCloseTo(1, GAIN_TOLERANCE_DIGITS);
        expect(panGains(SEVEN_POINT_ONE, { x: 0.25, y: 0.25, z: 0, snap: 1 }).filter(gain => gain > 0).length).toBeGreaterThan(1);
    });

    it('plays bed channels on their speakers and folds those the layout lacks as the engine folds layouts', () => {
        // A 7.1.2 bed with top side heights: L R C LFE Ls Rs Lb Rb Tsl Tsr
        const beds = [ FL, FR, FC, LFE, SL, SR, BL, BR, TSL, TSR ] as const;
        const gainsOf = (mask: number, channel: number, bed: readonly number[] = beds): number[] =>
            bedGains(mask, bed, channel).map(gain => Number(gain.toFixed(GAIN_TOLERANCE_DIGITS)));
        const half = Number(SQRT_HALF.toFixed(GAIN_TOLERANCE_DIGITS));
        const third = Number(Math.sqrt(1 / 3).toFixed(GAIN_TOLERANCE_DIGITS));
        // Every channel a speaker sums takes 1/sqrt(n) of n: in 7.1 the top side height shares the side speaker with Ls
        expect(gainsOf(SEVEN_POINT_ONE, TSL)).toEqual([ 0, 0, 0, 0, 0, 0, half, 0 ]);
        expect(gainsOf(SEVEN_POINT_ONE, SL)).toEqual([ 0, 0, 0, 0, 0, 0, half, 0 ]);
        expect(gainsOf(SEVEN_POINT_ONE, BL)).toEqual([ 0, 0, 0, 0, 1, 0, 0, 0 ]);
        // 5.1: side, back, and top side all into the surround at sqrt(1/3), the LFE on the LFE
        expect(gainsOf(FIVE_POINT_ONE_BACK, SL)).toEqual([ 0, 0, 0, 0, third, 0 ]);
        expect(gainsOf(FIVE_POINT_ONE_BACK, BL)).toEqual([ 0, 0, 0, 0, third, 0 ]);
        expect(gainsOf(FIVE_POINT_ONE_BACK, TSL)).toEqual([ 0, 0, 0, 0, third, 0 ]);
        expect(gainsOf(FIVE_POINT_ONE_SIDE, BR)).toEqual([ 0, 0, 0, 0, 0, third ]);
        expect(gainsOf(FIVE_POINT_ONE_BACK, LFE)).toEqual([ 0, 0, 0, 1, 0, 0 ]);
        // Stereo mixes that 7.1 fold with Lo/Ro: the center and the surrounds at sqrt(1/2), the LFE dropped
        expect(gainsOf(STEREO, FL)).toEqual([ 1, 0 ]);
        expect(gainsOf(STEREO, FC)).toEqual([ half, half ]);
        expect(gainsOf(STEREO, LFE)).toEqual([ 0, 0 ]);
        expect(gainsOf(STEREO, BR)).toEqual([ 0, half ]);
        expect(gainsOf(STEREO, SL)).toEqual([ 0.5, 0 ]);
        expect(gainsOf(STEREO, TSL)).toEqual([ 0.5, 0 ]);
        // 7.1.4: the top side height split between the top front and top back on its side; 7.1.2: alone on its side's top
        expect(gainsOf(SEVEN_POINT_ONE_POINT_FOUR, TSR)).toEqual([ 0, 0, 0, 0, 0, 0, 0, 0, 0, half, 0, half ]);
        expect(gainsOf(SEVEN_POINT_ONE_POINT_TWO, TSL)).toEqual([ 0, 0, 0, 0, 0, 0, 0, 0, 1, 0 ]);
        // A 5.1 bed's surround alone keeps unit gain in the 5.1 layouts, and bed heights play on their own speakers
        expect(gainsOf(FIVE_POINT_ONE_BACK, SL, [ FL, FR, FC, LFE, SL, SR ])[4]).toBe(1);
        expect(gainsOf(SEVEN_POINT_ONE_POINT_FOUR, TBL, [ TFL, TFR, TBL, TBR ])[10]).toBe(1);
        // Shared speakers elsewhere: a top front height with the front at 7.1, a top back one with the back at 7.1.2, a wide channel with
        // the front, and a second LFE with the LFE each take sqrt(1/2)
        const heightBed = [ FL, FR, TFL, TFR, TBL, TBR, BL, BR ];
        expect(gainsOf(SEVEN_POINT_ONE, TFL, heightBed)).toEqual([ half, 0, 0, 0, 0, 0, 0, 0 ]);
        expect(gainsOf(SEVEN_POINT_ONE, FL, heightBed)).toEqual([ half, 0, 0, 0, 0, 0, 0, 0 ]);
        expect(gainsOf(SEVEN_POINT_ONE_POINT_TWO, TBR, heightBed)).toEqual([ 0, 0, 0, 0, 0, half, 0, 0, 0, 0 ]);
        expect(gainsOf(SEVEN_POINT_ONE_POINT_TWO, TFR, heightBed)).toEqual([ 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 ]);
        expect(gainsOf(FIVE_POINT_ONE_BACK, LW, [ FL, FR, LW, RW ])).toEqual([ half, 0, 0, 0, 0, 0 ]);
        expect(gainsOf(FIVE_POINT_ONE_BACK, LFE2, [ FL, FR, LFE, LFE2 ])).toEqual([ 0, 0, 0, half, 0, 0 ]);
        expect(gainsOf(STEREO, LFE2, [ FL, FR, LFE, LFE2 ])).toEqual([ 0, 0 ]);
    });

    it('ramps to an update\'s gains, reaching them at its start plus its ramp duration', () => {
        const rampStart = 100;
        const rampDuration = 512;
        withRenderer(SAMPLE_RATE, renderer => {
            expect(atmos.atmos_renderer_set_target(renderer, STEREO, 0)).toBe(ATMOS_OK);
            withMetadata(metadata => {
                metadata.addObject();
                metadata.setUpdate(0, 0, 0);
                metadata.set(0, 0, { x: 0, y: 0, z: 0 });
                metadata.setUpdate(1, rampStart, rampDuration);
                metadata.set(1, 0, { x: 1 });
                expect(atmos.atmos_renderer_add_metadata(renderer, metadata.pointer, 0)).toBe(ATMOS_OK);
            });
            // Rendered in blocks of 40 samples, as TrueHD's access units come
            const frameCount = 1_024;
            const blockLength = 40;
            const left: number[] = [];
            const right: number[] = [];
            for (let start = 0; start < frameCount; start += blockLength) {
                const [ blockLeft, blockRight ] = render(renderer, [ constant(Math.min(blockLength, frameCount - start)) ], Math.min(blockLength, frameCount - start));
                left.push(...blockLeft);
                right.push(...blockRight);
            }
            expect(left[rampStart - 1]).toBe(1);
            expect(right[rampStart - 1]).toBe(0);
            expect(right[rampStart]).toBeGreaterThan(0);
            expect(right[rampStart + rampDuration - 2]).toBeLessThan(1);
            expect(right[rampStart + rampDuration - 1]).toBeCloseTo(1, GAIN_TOLERANCE_DIGITS);
            expect(left[rampStart + rampDuration - 1]).toBeCloseTo(0, GAIN_TOLERANCE_DIGITS);
            expect(right[frameCount - 1]).toBe(1);
            // Halfway through the ramp, the object is in the middle
            expect(left[rampStart + rampDuration / 2 - 1]).toBeCloseTo(SQRT_HALF, LOOSE_TOLERANCE_DIGITS);
            expect(right[rampStart + rampDuration / 2 - 1]).toBeCloseTo(SQRT_HALF, LOOSE_TOLERANCE_DIGITS);
            // The gains move smoothly: no step between neighboring samples is large
            for (let sample = 1; sample < frameCount; sample++) {
                expect(Math.abs(right[sample] - right[sample - 1])).toBeLessThan(0.01);
            }
        });
    });

    it('starts updates that began before the next render call at once, with what is left of their ramps', () => {
        withRenderer(SAMPLE_RATE, renderer => {
            expect(atmos.atmos_renderer_set_target(renderer, STEREO, 0)).toBe(ATMOS_OK);
            withMetadata(metadata => {
                metadata.addObject();
                metadata.setUpdate(0, 0, 0);
                metadata.set(0, 0, { x: 0, y: 0, z: 0 });
                expect(atmos.atmos_renderer_add_metadata(renderer, metadata.pointer, 0)).toBe(ATMOS_OK);
            });
            render(renderer, [ constant(RENDER_FRAMES) ], RENDER_FRAMES);
            withMetadata(metadata => {
                metadata.addObject();
                metadata.setUpdate(0, 0, 96);
                metadata.set(0, 0, { x: 1, y: 0, z: 0 });
                // The payload's timing counts from 64 samples ago, so 32 samples of its ramp remain
                expect(atmos.atmos_renderer_add_metadata(renderer, metadata.pointer, -RENDER_FRAMES)).toBe(ATMOS_OK);
            });
            const [ left, right ] = render(renderer, [ constant(RENDER_FRAMES) ], RENDER_FRAMES);
            expect(left[0]).toBeGreaterThan(0.9);
            expect(right[31]).toBeCloseTo(1, GAIN_TOLERANCE_DIGITS);
            expect(left[31]).toBeCloseTo(0, GAIN_TOLERANCE_DIGITS);
        });
    });

    it('moves its objects to a new layout between blocks, mid-ramp, and adopts a new scene', () => {
        withRenderer(SAMPLE_RATE, renderer => {
            expect(atmos.atmos_renderer_set_target(renderer, FIVE_POINT_ONE_BACK, 0)).toBe(ATMOS_OK);
            withMetadata(metadata => {
                metadata.addObject(LFE);
                metadata.addObject();
                metadata.setUpdate(0, 0, 0);
                metadata.set(0, 1, { x: 0, y: 0, z: 1 });
                metadata.setUpdate(1, 64, 128);
                metadata.set(1, 1, { x: 1, y: 0, z: 1 });
                expect(atmos.atmos_renderer_add_metadata(renderer, metadata.pointer, 0)).toBe(ATMOS_OK);
            });
            // On 5.1, an overhead object plays from the floor
            const before = render(renderer, [ constant(RENDER_FRAMES), constant(RENDER_FRAMES) ], RENDER_FRAMES);
            expect(before).toHaveLength(6);
            expect(before[0][RENDER_FRAMES - 1]).toBe(1);
            expect(before[3][RENDER_FRAMES - 1]).toBe(1);
            expect(atmos.atmos_renderer_set_target(renderer, SEVEN_POINT_ONE_POINT_FOUR, 0)).toBe(ATMOS_OK);
            // On 7.1.4 it plays from the heights at once, and its ramp toward the right goes on to end at sample 192
            const after = render(renderer, [ constant(2 * RENDER_FRAMES), constant(2 * RENDER_FRAMES) ], 2 * RENDER_FRAMES);
            expect(after).toHaveLength(12);
            expect(after[0][0]).toBe(0);
            expect(after[8][0]).toBeGreaterThan(0.9);
            expect(after[3][0]).toBe(1);
            expect(after[9][RENDER_FRAMES + 63]).toBeCloseTo(1, GAIN_TOLERANCE_DIGITS);
            // A payload of another scene replaces the objects; its new dynamic object starts at its first update
            withMetadata(metadata => {
                metadata.addObject();
                metadata.setUpdate(0, 0, 0);
                metadata.set(0, 0, { x: 0.5, y: 0, z: 0 });
                expect(atmos.atmos_renderer_add_metadata(renderer, metadata.pointer, 0)).toBe(ATMOS_OK);
            });
            const replaced = render(renderer, [ constant(RENDER_FRAMES) ], RENDER_FRAMES);
            expect(replaced[2][0]).toBe(1);
            expect(replaced[3][0]).toBe(0);
        });
    });

    it('keeps dynamic objects silent until their first update, and bounds its queue', () => {
        withRenderer(SAMPLE_RATE, renderer => {
            expect(atmos.atmos_renderer_set_target(renderer, STEREO, 0)).toBe(ATMOS_OK);
            withMetadata(metadata => {
                metadata.addObject();
                expect(atmos.atmos_test_renderer_set_scene(renderer, metadata.pointer)).toBe(ATMOS_OK);
                const silent = render(renderer, [ constant(RENDER_FRAMES) ], RENDER_FRAMES);
                expect(silent.every(plane => plane.every(sample => sample === 0))).toBe(true);
                for (let update = 0; update < 8; update++) {
                    metadata.setUpdate(update, 1_000 + update, 0);
                }
                for (let payload = 0; payload < ATMOS_MAX_PENDING_UPDATES / 8; payload++) {
                    expect(atmos.atmos_renderer_add_metadata(renderer, metadata.pointer, 0)).toBe(ATMOS_OK);
                }
                expect(atmos.atmos_renderer_add_metadata(renderer, metadata.pointer, 0)).toBe(ATMOS_ERROR_QUEUE);
                atmos.atmos_renderer_reset(renderer);
                expect(atmos.atmos_renderer_add_metadata(renderer, metadata.pointer, 0)).toBe(ATMOS_OK);
            });
        });
    });
});

/** The HRIR table atmos_hrir.c holds, per virtual speaker in 7.1.4 plane order without the LFE, left then right ear */
function readHRIRTable(): number[][][] {
    const source = readFileSync(HRIR_SOURCE_PATH, 'utf8');
    const body = source.slice(source.indexOf('= {') + 3);
    // The taps are the float literals, each ending in f; the comments between speakers hold none
    const values = body.split(/[\s,{};]+/u).filter(token => token.endsWith('f')).map(token => Number.parseFloat(token));
    const speakers = 11;
    const length = values.length / speakers / 2;
    return Array.from({ length: speakers }, (_, speaker) => [ 0, 1 ].map(ear => values.slice((speaker * 2 + ear) * length, (speaker * 2 + ear + 1) * length)));
}

function onset(plane: Float32Array): number {
    const peak = plane.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
    return plane.findIndex(sample => Math.abs(sample) > 0.1 * peak);
}

function energy(plane: ArrayLike<number>): number {
    return Array.from(plane).reduce((sum, sample) => sum + sample * sample, 0);
}

/** Renders a bed channel's plane binaurally, alone in its scene */
function renderBinauralBed(channel: number, input: Float32Array): Float32Array[] {
    let output: Float32Array[] = [];
    withRenderer(SAMPLE_RATE, renderer => {
        expect(atmos.atmos_renderer_set_target(renderer, SEVEN_POINT_ONE_POINT_FOUR, 1)).toBe(ATMOS_OK);
        expect(atmos.atmos_renderer_channel_mask(renderer)).toBe(STEREO);
        expect(atmos.atmos_renderer_channel_count(renderer)).toBe(2);
        expect(atmos.atmos_renderer_latency(renderer)).toBe(ATMOS_BINAURAL_LATENCY);
        withMetadata(metadata => {
            metadata.addObject(channel);
            expect(atmos.atmos_test_renderer_set_scene(renderer, metadata.pointer)).toBe(ATMOS_OK);
        });
        output = render(renderer, [ input ], input.length);
    });
    return output;
}

describe('the binaural renderer', () => {
    const frameCount = 2_048;

    it('renders binaurally only at 48 kHz', () => {
        withRenderer(OTHER_SAMPLE_RATE, renderer => {
            expect(atmos.atmos_renderer_set_target(renderer, STEREO, 1)).toBe(ATMOS_ERROR_SAMPLE_RATE);
            expect(atmos.atmos_renderer_set_target(renderer, STEREO, 0)).toBe(ATMOS_OK);
        });
    });

    it('puts a source at the left speaker louder and earlier in the left ear', () => {
        const impulse = new Float32Array(frameCount);
        impulse[0] = 1;
        const [ left, right ] = renderBinauralBed(FL, impulse);
        // KEMAR at 30 degrees: about 9 dB louder in the near ear, which hears it about a quarter millisecond earlier
        expect(energy(left) / energy(right)).toBeGreaterThan(4);
        const delay = onset(right) - onset(left);
        expect(delay).toBeGreaterThanOrEqual(8);
        expect(delay).toBeLessThanOrEqual(16);
        expect(onset(left)).toBeGreaterThanOrEqual(ATMOS_BINAURAL_LATENCY);
        const [ mirroredLeft, mirroredRight ] = renderBinauralBed(FR, impulse);
        expect(energy(mirroredRight)).toBeCloseTo(energy(left), GAIN_TOLERANCE_DIGITS);
        expect(energy(mirroredLeft)).toBeCloseTo(energy(right), GAIN_TOLERANCE_DIGITS);
    });

    it('convolves each virtual speaker with its HRIR pair, one block late', () => {
        const table = readHRIRTable();
        // Noise from a fixed linear congruential generator, on the top back right speaker, the last in the table
        let seed = 12_345;
        const noise = Float32Array.from({ length: frameCount }, () => {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
            return seed / 1_073_741_824 - 1;
        });
        const output = renderBinauralBed(TBR, noise);
        for (const ear of [ 0, 1 ]) {
            const taps = table[10][ear];
            let worst = 0;
            for (let sample = ATMOS_BINAURAL_LATENCY; sample < frameCount; sample++) {
                let expected = 0;
                for (let tap = 0; tap < taps.length && tap <= sample - ATMOS_BINAURAL_LATENCY; tap++) {
                    expected += taps[tap] * noise[sample - ATMOS_BINAURAL_LATENCY - tap];
                }
                worst = Math.max(worst, Math.abs(output[ear][sample] - expected));
            }
            expect(worst).toBeLessThan(1e-5);
            expect(output[ear].subarray(0, ATMOS_BINAURAL_LATENCY).every(sample => sample === 0)).toBe(true);
        }
    });

    it('adds the LFE to both ears equally, without HRIRs, delayed as the rest', () => {
        const input = constant(frameCount, 0.8);
        const [ left, right ] = renderBinauralBed(LFE, input);
        expect(Array.from(left)).toEqual(Array.from(right));
        expect(left[ATMOS_BINAURAL_LATENCY - 1]).toBe(0);
        expect(left[ATMOS_BINAURAL_LATENCY]).toBeCloseTo(0.4, GAIN_TOLERANCE_DIGITS);
    });

    it('switches between binaural and speaker targets between blocks', () => {
        withRenderer(SAMPLE_RATE, renderer => {
            withMetadata(metadata => {
                metadata.addObject(FL);
                expect(atmos.atmos_test_renderer_set_scene(renderer, metadata.pointer)).toBe(ATMOS_OK);
            });
            expect(atmos.atmos_renderer_set_target(renderer, STEREO, 1)).toBe(ATMOS_OK);
            const binaural = render(renderer, [ constant(frameCount) ], frameCount);
            expect(energy(binaural[0])).toBeGreaterThan(energy(binaural[1]));
            expect(atmos.atmos_renderer_set_target(renderer, SEVEN_POINT_ONE, 0)).toBe(ATMOS_OK);
            expect(atmos.atmos_renderer_latency(renderer)).toBe(0);
            const speakers = render(renderer, [ constant(RENDER_FRAMES) ], RENDER_FRAMES);
            expect(speakers).toHaveLength(8);
            expect(speakers[0][0]).toBe(1);
            // Back to binaural, the convolution starts again from silence
            expect(atmos.atmos_renderer_set_target(renderer, STEREO, 1)).toBe(ATMOS_OK);
            const again = render(renderer, [ constant(RENDER_FRAMES) ], RENDER_FRAMES);
            expect(again[0].every(sample => sample === 0)).toBe(true);
        });
    });
});
