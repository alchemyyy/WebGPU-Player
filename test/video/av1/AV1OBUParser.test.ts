import { describe, expect, it } from 'vitest';

import {
    AV1_OBU_TYPE_FRAME,
    AV1_OBU_TYPE_FRAME_HEADER,
    AV1_OBU_TYPE_METADATA,
    AV1_OBU_TYPE_REDUNDANT_FRAME_HEADER,
    AV1_OBU_TYPE_SEQUENCE_HEADER,
    AV1_OBU_TYPE_TEMPORAL_DELIMITER,
    AV1_OBU_TYPE_TILE_GROUP,
    AV1OBUParseError,
    getAV1ITUTT35Message,
    hasAV1FrameHeader,
    parseAV1OBUs
} from 'webgpu-player/video/av1/AV1OBUParser';
import { createNativeVideoCapabilityVector } from 'webgpu-player/capability/vectors/NativeVideoCapabilityVectors';

const OBU_EXTENSION_FLAG = 0x04;
const OBU_HAS_SIZE_FIELD_FLAG = 0x02;
const METADATA_TYPE_HDR_CLL = 1;
const METADATA_TYPE_ITUT_T35 = 4;

const EMPTY_TEMPORAL_UNIT_ERROR = 'temporal unit is empty';
const TRUNCATED_OBU_SIZE_ERROR = 'obu_size is truncated';
const OBU_SIZE_BEYOND_UNIT_ERROR = 'obu_size exceeds its temporal unit';
const FORBIDDEN_BIT_ERROR = 'forbidden bit';
const TRUNCATED_EXTENSION_HEADER_ERROR = 'extension header is truncated';
const OVERLONG_LEB128_ERROR = 'longer than eight bytes';
const LEB128_ABOVE_32_BITS_ERROR = 'exceeds 32 bits';
const TRUNCATED_METADATA_TYPE_ERROR = 'metadata_type is truncated';

function encodeLEB128(value: number): number[] {
    const bytes: number[] = [];
    let remainingValue = value;
    do {
        const valueBits = remainingValue % 128;
        remainingValue = Math.floor(remainingValue / 128);
        bytes.push(remainingValue > 0 ? valueBits | 0x80 : valueBits);
    } while (remainingValue > 0);
    return bytes;
}

function createOBU(
    type: number,
    payload: readonly number[],
    extension: number | null = null,
    hasSizeField = true
): Uint8Array {
    const header = (type << 3)
        | (extension === null ? 0 : OBU_EXTENSION_FLAG)
        | (hasSizeField ? OBU_HAS_SIZE_FIELD_FLAG : 0);
    return new Uint8Array([
        header,
        ...(extension === null ? [] : [ extension ]),
        ...(hasSizeField ? encodeLEB128(payload.length) : []),
        ...payload
    ]);
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
    const output = new Uint8Array(parts.reduce(
        (byteLength: number, part: Uint8Array): number => byteLength + part.byteLength,
        0
    ));
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
}

describe('AV1OBUParser', () => {
    it('walks the engine AV1 vector from its temporal delimiter without copying', () => {
        const temporalUnit = createNativeVideoCapabilityVector('av1').encodedKeyFrame;

        const obus = parseAV1OBUs(temporalUnit);

        expect(obus.map(obu => obu.type)).toEqual([
            AV1_OBU_TYPE_TEMPORAL_DELIMITER,
            AV1_OBU_TYPE_SEQUENCE_HEADER,
            AV1_OBU_TYPE_FRAME
        ]);
        expect(obus.map(obu => obu.data.byteLength)).toEqual([ 2, 8, 14 ]);
        expect(obus.map(obu => obu.payload.byteLength)).toEqual([ 0, 6, 12 ]);
        for (const obu of obus) {
            expect(obu.data.buffer).toBe(temporalUnit.buffer);
            expect(obu.payload.buffer).toBe(temporalUnit.buffer);
        }
    });

    it('reads extension headers and multi-byte or redundant leb128 sizes', () => {
        const largePayload = Array.from({ length: 200 }, (_value: unknown, index: number): number => index);
        const frame = createOBU(AV1_OBU_TYPE_FRAME, largePayload, 0x28);
        // leb128 allows padding bytes: 0x85 0x00 still encodes 5
        const paddedSizeTileGroup = new Uint8Array([
            (AV1_OBU_TYPE_TILE_GROUP << 3) | OBU_HAS_SIZE_FIELD_FLAG,
            0x85,
            0x00,
            1,
            2,
            3,
            4,
            5
        ]);

        const obus = parseAV1OBUs(concatenate([ frame, paddedSizeTileGroup ]));

        expect(obus).toHaveLength(2);
        expect(obus[0].type).toBe(AV1_OBU_TYPE_FRAME);
        expect(obus[0].data.byteLength).toBe(1 + 1 + 2 + largePayload.length);
        expect(Array.from(obus[0].payload)).toEqual(largePayload);
        expect(obus[1].type).toBe(AV1_OBU_TYPE_TILE_GROUP);
        expect(Array.from(obus[1].payload)).toEqual([ 1, 2, 3, 4, 5 ]);
    });

    it('gives an OBU without a size field the rest of its temporal unit', () => {
        const sequenceHeader = createOBU(AV1_OBU_TYPE_SEQUENCE_HEADER, [ 1, 2 ]);
        const frame = createOBU(AV1_OBU_TYPE_FRAME, [ 3, 4, 5 ], 0x08, false);

        const obus = parseAV1OBUs(concatenate([ sequenceHeader, frame ]));

        expect(obus).toHaveLength(2);
        expect(Array.from(obus[1].data)).toEqual(Array.from(frame));
        expect(Array.from(obus[1].payload)).toEqual([ 3, 4, 5 ]);
    });

    it.each([
        {
            data: new Uint8Array(),
            description: 'an empty temporal unit',
            message: EMPTY_TEMPORAL_UNIT_ERROR
        },
        {
            data: new Uint8Array([ (AV1_OBU_TYPE_FRAME << 3) | OBU_HAS_SIZE_FIELD_FLAG, 0x80 ]),
            description: 'a truncated obu_size',
            message: TRUNCATED_OBU_SIZE_ERROR
        },
        {
            data: new Uint8Array([ (AV1_OBU_TYPE_FRAME << 3) | OBU_HAS_SIZE_FIELD_FLAG, 4, 1, 2, 3 ]),
            description: 'an obu_size beyond the unit',
            message: OBU_SIZE_BEYOND_UNIT_ERROR
        },
        {
            data: new Uint8Array([ 0x80 | (AV1_OBU_TYPE_FRAME << 3) | OBU_HAS_SIZE_FIELD_FLAG, 0 ]),
            description: 'a set forbidden bit',
            message: FORBIDDEN_BIT_ERROR
        },
        {
            data: new Uint8Array([ (AV1_OBU_TYPE_FRAME << 3) | OBU_EXTENSION_FLAG ]),
            description: 'a truncated extension header',
            message: TRUNCATED_EXTENSION_HEADER_ERROR
        },
        {
            data: new Uint8Array([
                (AV1_OBU_TYPE_FRAME << 3) | OBU_HAS_SIZE_FIELD_FLAG,
                0x80,
                0x80,
                0x80,
                0x80,
                0x80,
                0x80,
                0x80,
                0x80,
                0x00
            ]),
            description: 'an obu_size longer than eight bytes',
            message: OVERLONG_LEB128_ERROR
        },
        {
            data: new Uint8Array([
                (AV1_OBU_TYPE_FRAME << 3) | OBU_HAS_SIZE_FIELD_FLAG,
                0x80,
                0x80,
                0x80,
                0x80,
                0x10
            ]),
            description: 'an obu_size of 2^32',
            message: LEB128_ABOVE_32_BITS_ERROR
        }
    ])('rejects $description with a typed error', ({ data, message }) => {
        expect(() => parseAV1OBUs(data)).toThrow(AV1OBUParseError);
        expect(() => parseAV1OBUs(data)).toThrow(message);
    });

    it('identifies frames, frame headers, and redundant frame headers', () => {
        const obus = parseAV1OBUs(concatenate([
            createOBU(AV1_OBU_TYPE_TEMPORAL_DELIMITER, []),
            createOBU(AV1_OBU_TYPE_SEQUENCE_HEADER, [ 1 ]),
            createOBU(AV1_OBU_TYPE_METADATA, [ METADATA_TYPE_HDR_CLL, 0, 1, 0, 1, 0x80 ]),
            createOBU(AV1_OBU_TYPE_FRAME_HEADER, [ 2 ]),
            createOBU(AV1_OBU_TYPE_TILE_GROUP, [ 3 ]),
            createOBU(AV1_OBU_TYPE_REDUNDANT_FRAME_HEADER, [ 4 ]),
            createOBU(AV1_OBU_TYPE_FRAME, [ 5 ])
        ]));

        expect(obus.map(hasAV1FrameHeader)).toEqual([
            false,
            false,
            false,
            true,
            false,
            true,
            true
        ]);
    });

    it('returns an ITU-T T.35 message from its country code and nothing for other OBUs', () => {
        const message = [ 0xB5, 0x00, 0x3C, 0x00, 0x01, 0x04, 0x01, 0x80 ];
        const obus = parseAV1OBUs(concatenate([
            createOBU(AV1_OBU_TYPE_METADATA, [ METADATA_TYPE_ITUT_T35, ...message ]),
            createOBU(AV1_OBU_TYPE_METADATA, [ METADATA_TYPE_HDR_CLL, 0, 1, 0, 1, 0x80 ]),
            // metadata_type 2^32 - 1 is in range and names no T.35 message
            createOBU(AV1_OBU_TYPE_METADATA, [ 0xFF, 0xFF, 0xFF, 0xFF, 0x0F ]),
            createOBU(AV1_OBU_TYPE_METADATA, [ METADATA_TYPE_ITUT_T35 ]),
            createOBU(AV1_OBU_TYPE_FRAME, [ METADATA_TYPE_ITUT_T35, ...message ])
        ]));

        expect(Array.from(getAV1ITUTT35Message(obus[0]) ?? [])).toEqual(message);
        expect(getAV1ITUTT35Message(obus[1])).toBeNull();
        expect(getAV1ITUTT35Message(obus[2])).toBeNull();
        expect(getAV1ITUTT35Message(obus[3])?.byteLength).toBe(0);
        expect(getAV1ITUTT35Message(obus[4])).toBeNull();
    });

    it('rejects a metadata OBU whose metadata_type cannot be read', () => {
        const obus = parseAV1OBUs(createOBU(AV1_OBU_TYPE_METADATA, []));

        expect(() => getAV1ITUTT35Message(obus[0])).toThrow(AV1OBUParseError);
        expect(() => getAV1ITUTT35Message(obus[0])).toThrow(TRUNCATED_METADATA_TYPE_ERROR);
    });
});
