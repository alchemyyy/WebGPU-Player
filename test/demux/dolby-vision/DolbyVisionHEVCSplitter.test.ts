import { describe, expect, it } from 'vitest';

import {
    getHEVCNALUnitLayerID,
    hasHEVCRASLPicture,
    hasHEVCSPS,
    parseHEVCNALUnits,
    sanitizeHEVCAccessUnitForChromium,
    type HEVCNALFormat,
    type HEVCNALUnit,
    splitDolbyVisionHEVCAccessUnit
} from 'webgpu-player/demux/dolby-vision/DolbyVisionHEVCSplitter';

import { createNALUnit, encodeAnnexBNALUnits } from '../../helpers/hevcNALUnits';

const EMPTY_ACCESS_UNIT_ERROR = 'access unit is empty';
const FOUR_BYTE_START_CODE = new Uint8Array([ 0, 0, 0, 1 ]);
const THREE_BYTE_START_CODE = new Uint8Array([ 0, 0, 1 ]);
// Bytes ahead of an access unit in its buffer, as when a demuxer's packet views a larger read
const PRECEDING_BUFFER_BYTES = [ 0xAA, 0xBB, 0xCC ];
const SECOND_VIEW_LAYER_ID = 1;

/** Joins NAL units into one Annex B stream, each after its own start code. */
function joinAnnexBNALUnits(entries: ReadonlyArray<readonly [Uint8Array, Uint8Array]>): Uint8Array {
    const byteLength = entries.reduce(
        (totalByteLength: number, [ startCode, nalUnit ]: readonly [Uint8Array, Uint8Array]): number => (
            totalByteLength + startCode.byteLength + nalUnit.byteLength
        ),
        0
    );
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const [ startCode, nalUnit ] of entries) {
        output.set(startCode, offset);
        offset += startCode.byteLength;
        output.set(nalUnit, offset);
        offset += nalUnit.byteLength;
    }
    return output;
}

/** Places an access unit after other bytes in one buffer, so its view starts past the buffer's start. */
function createOffsetView(accessUnit: Uint8Array): Uint8Array {
    const buffer = new Uint8Array(PRECEDING_BUFFER_BYTES.length + accessUnit.byteLength);
    buffer.set(PRECEDING_BUFFER_BYTES);
    buffer.set(accessUnit, PRECEDING_BUFFER_BYTES.length);
    return buffer.subarray(PRECEDING_BUFFER_BYTES.length);
}

function createLayerNALUnit(
    type: number,
    layerID: number,
    payload: readonly number[]
): Uint8Array {
    // nuh_layer_id spans the last bit of the first header byte and the top five bits of the second
    return new Uint8Array([
        ((type & 0x3F) << 1) | (layerID >> 5),
        ((layerID & 0x1F) << 3) | 1,
        ...payload
    ]);
}

function encodeLengthPrefixedNALUnits(
    nalUnits: readonly Uint8Array[],
    lengthSize: 1 | 2 | 3 | 4
): Uint8Array {
    const byteLength = nalUnits.reduce(
        (totalByteLength: number, nalUnit: Uint8Array): number => (
            totalByteLength + lengthSize + nalUnit.byteLength
        ),
        0
    );
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const nalUnit of nalUnits) {
        let remainingLength = nalUnit.byteLength;
        for (let byteIndex = lengthSize - 1; byteIndex >= 0; byteIndex -= 1) {
            output[offset + byteIndex] = remainingLength % 256;
            remainingLength = Math.floor(remainingLength / 256);
        }
        offset += lengthSize;
        output.set(nalUnit, offset);
        offset += nalUnit.byteLength;
    }
    return output;
}

function decodeNALUnitTypes(data: Uint8Array | null, format: HEVCNALFormat): number[] {
    if (!data) {
        return [];
    }
    const types: number[] = [];
    let offset = 0;
    while (offset < data.byteLength) {
        let nalUnitOffset: number;
        let nalUnitByteLength: number;
        if (format.kind === 'annex-b') {
            expect(Array.from(data.subarray(offset, offset + 4))).toEqual([ 0, 0, 0, 1 ]);
            nalUnitOffset = offset + 4;
            const nextStartCodeOffset = data.findIndex((value: number, index: number): boolean => (
                index >= nalUnitOffset
                && value === 0
                && data[index + 1] === 0
                && data[index + 2] === 0
                && data[index + 3] === 1
            ));
            const nalUnitEnd = nextStartCodeOffset < 0 ? data.byteLength : nextStartCodeOffset;
            nalUnitByteLength = nalUnitEnd - nalUnitOffset;
        } else {
            nalUnitByteLength = 0;
            for (let byteIndex = 0; byteIndex < format.lengthSize; byteIndex += 1) {
                nalUnitByteLength = (nalUnitByteLength * 256) + data[offset + byteIndex];
            }
            nalUnitOffset = offset + format.lengthSize;
        }
        types.push((data[nalUnitOffset] >> 1) & 0x3F);
        offset = nalUnitOffset + nalUnitByteLength;
    }
    return types;
}

describe.each<1 | 2 | 3 | 4>([ 1, 2, 3, 4 ])(
    'DolbyVisionHEVCSplitter length size %i',
    lengthSize => {
        it('separates base-layer, RPU, and enhancement-layer NAL units', () => {
            const baseParameterSet = createNALUnit(32, [ 10 ]);
            const basePicture = createNALUnit(19, [ 11, 12 ]);
            const rpu = createNALUnit(62, [ 25, 8, 9, 13 ]);
            const enhancementPicture = createNALUnit(1, [ 14, 15 ]);
            const enhancementWrapper = createNALUnit(63, Array.from(enhancementPicture));
            const inputFormat = { kind: 'length-prefixed', lengthSize } as const;
            const result = splitDolbyVisionHEVCAccessUnit(
                encodeLengthPrefixedNALUnits([
                    baseParameterSet,
                    rpu,
                    basePicture,
                    enhancementWrapper
                ], lengthSize),
                inputFormat
            );

            expect(decodeNALUnitTypes(result.baseLayerData, inputFormat)).toEqual([ 32, 19 ]);
            expect(decodeNALUnitTypes(result.enhancementLayerData, inputFormat)).toEqual([ 1 ]);
            expect(result.hasBaseLayerVCL).toBe(true);
            expect(result.hasEnhancementLayerVCL).toBe(true);
            expect(result.hasRequiredEnhancementLayerParameterSets).toBe(false);
            expect(result.rpuNALUnits).toHaveLength(1);
            expect(result.rpuNALUnits[0]).toEqual(rpu);
        });
    }
);

describe('DolbyVisionHEVCSplitter Annex B', () => {
    it('normalizes mixed start codes in a rebuilt BL and can change the EL output format', () => {
        const basePicture = createNALUnit(1, [ 1 ]);
        const rpu = createNALUnit(62, [ 25, 8, 9 ]);
        const enhancementPicture = createNALUnit(20, [ 2 ]);
        const enhancementWrapper = createNALUnit(63, Array.from(enhancementPicture));
        // The RPU ahead of the BL picture makes the BL a new access unit
        const packet = joinAnnexBNALUnits([
            [ FOUR_BYTE_START_CODE, rpu ],
            [ THREE_BYTE_START_CODE, basePicture ],
            [ FOUR_BYTE_START_CODE, enhancementWrapper ]
        ]);

        const result = splitDolbyVisionHEVCAccessUnit(
            packet,
            { kind: 'annex-b' },
            { kind: 'length-prefixed', lengthSize: 2 }
        );

        expect(result.baseLayerData).toEqual(encodeAnnexBNALUnits([ basePicture ]));
        expect(decodeNALUnitTypes(
            result.enhancementLayerData,
            { kind: 'length-prefixed', lengthSize: 2 }
        )).toEqual([ 20 ]);
        expect(result.rpuNALUnits).toEqual([ rpu ]);
    });

    it('returns null for absent BL and EL data while preserving an owned RPU', () => {
        const rpu = createNALUnit(62, [ 25, 8, 9 ]);
        const packet = encodeAnnexBNALUnits([ rpu ]);
        const result = splitDolbyVisionHEVCAccessUnit(packet, { kind: 'annex-b' });
        packet.fill(0);

        expect(result.baseLayerData).toBeNull();
        expect(result.enhancementLayerData).toBeNull();
        expect(result.hasBaseLayerVCL).toBe(false);
        expect(result.hasEnhancementLayerVCL).toBe(false);
        expect(result.hasRequiredEnhancementLayerParameterSets).toBe(false);
        expect(result.rpuNALUnits[0]).toEqual(rpu);
    });

    it('requires all three enhancement-layer random-access parameter sets', () => {
        const enhancementNALUnits = [
            createNALUnit(32, [ 1 ]),
            createNALUnit(33, [ 2 ]),
            createNALUnit(34, [ 3 ]),
            createNALUnit(19, [ 4 ])
        ];
        const wrappers = enhancementNALUnits.map((nalUnit: Uint8Array): Uint8Array => (
            createNALUnit(63, Array.from(nalUnit))
        ));
        const complete = splitDolbyVisionHEVCAccessUnit(
            encodeAnnexBNALUnits(wrappers),
            { kind: 'annex-b' }
        );
        const incomplete = splitDolbyVisionHEVCAccessUnit(
            encodeAnnexBNALUnits(wrappers.filter((_: Uint8Array, index: number): boolean => index !== 1)),
            { kind: 'annex-b' }
        );

        expect(complete.hasRequiredEnhancementLayerParameterSets).toBe(true);
        expect(incomplete.hasRequiredEnhancementLayerParameterSets).toBe(false);
    });
});

describe('DolbyVisionHEVCSplitter multi-layer streams', () => {
    it('exposes the six-bit nuh_layer_id of every parsed NAL unit', () => {
        const nalUnits = parseHEVCNALUnits(encodeAnnexBNALUnits([
            createLayerNALUnit(19, 0, [ 1 ]),
            createLayerNALUnit(19, 1, [ 2 ]),
            createLayerNALUnit(19, 32, [ 3 ]),
            createLayerNALUnit(19, 63, [ 4 ])
        ]), { kind: 'annex-b' });

        expect(nalUnits.map((nalUnit: HEVCNALUnit): number => nalUnit.layerID))
            .toEqual([ 0, 1, 32, 63 ]);
        expect(nalUnits.map((nalUnit: HEVCNALUnit): number => nalUnit.type))
            .toEqual([ 19, 19, 19, 19 ]);
        expect(getHEVCNALUnitLayerID(createLayerNALUnit(33, 5, []))).toBe(5);
        expect(() => getHEVCNALUnitLayerID(new Uint8Array([ 0x42 ]))).toThrow('two-byte header');
    });

    it('drops every NAL unit of a second MV-HEVC view while keeping the base view and DV data', () => {
        const format = { kind: 'length-prefixed', lengthSize: 4 } as const;
        const rpu = createNALUnit(62, [ 25, 8, 9 ]);
        const enhancementPicture = createNALUnit(1, [ 7 ]);
        const result = splitDolbyVisionHEVCAccessUnit(encodeLengthPrefixedNALUnits([
            createLayerNALUnit(32, 0, [ 1 ]),
            createLayerNALUnit(33, 0, [ 2 ]),
            createLayerNALUnit(33, 1, [ 3 ]),
            createLayerNALUnit(34, 0, [ 4 ]),
            createLayerNALUnit(34, 1, [ 5 ]),
            createLayerNALUnit(39, 1, [ 6 ]),
            rpu,
            createLayerNALUnit(19, 0, [ 8 ]),
            createLayerNALUnit(1, 1, [ 9 ]),
            createNALUnit(63, Array.from(enhancementPicture))
        ], format.lengthSize), format);

        expect(decodeNALUnitTypes(result.baseLayerData, format)).toEqual([ 32, 33, 34, 19 ]);
        expect(parseHEVCNALUnits(result.baseLayerData ?? new Uint8Array(), format).every(
            (nalUnit: HEVCNALUnit): boolean => nalUnit.layerID === 0
        )).toBe(true);
        expect(decodeNALUnitTypes(result.enhancementLayerData, format)).toEqual([ 1 ]);
        expect(result.hasBaseLayerVCL).toBe(true);
        expect(result.hasEnhancementLayerVCL).toBe(true);
        expect(result.rpuNALUnits).toEqual([ rpu ]);
    });

    it('reports no base-layer picture for an access unit that holds only other layers', () => {
        const result = splitDolbyVisionHEVCAccessUnit(encodeAnnexBNALUnits([
            createLayerNALUnit(39, 1, [ 1 ]),
            createLayerNALUnit(1, 1, [ 2 ]),
            createLayerNALUnit(62, 2, [ 3 ]),
            createLayerNALUnit(63, 2, Array.from(createNALUnit(1, [ 4 ])))
        ]), { kind: 'annex-b' });

        expect(result.baseLayerData).toBeNull();
        expect(result.enhancementLayerData).toBeNull();
        expect(result.hasBaseLayerVCL).toBe(false);
        expect(result.hasEnhancementLayerVCL).toBe(false);
        expect(result.rpuNALUnits).toEqual([]);
    });
});

describe('DolbyVisionHEVCSplitter BL reuse', () => {
    it('returns the input itself when it removes nothing', () => {
        const lengthPrefixedFormat = { kind: 'length-prefixed', lengthSize: 4 } as const;
        const annexBPacket = encodeAnnexBNALUnits([
            createNALUnit(32, [ 1 ]),
            createNALUnit(39, [ 2 ]),
            createNALUnit(19, [ 3 ])
        ]);
        const lengthPrefixedPacket = encodeLengthPrefixedNALUnits(
            [ createNALUnit(19, [ 4 ]) ],
            lengthPrefixedFormat.lengthSize
        );

        expect(splitDolbyVisionHEVCAccessUnit(annexBPacket, { kind: 'annex-b' }).baseLayerData)
            .toBe(annexBPacket);
        expect(splitDolbyVisionHEVCAccessUnit(lengthPrefixedPacket, lengthPrefixedFormat).baseLayerData)
            .toBe(lengthPrefixedPacket);
    });

    it('returns a view of the leading Annex B bytes when only trailing EL and RPU NAL units are removed', () => {
        const basePicture = createNALUnit(19, [ 1, 2 ]);
        const enhancementWrapper = createNALUnit(63, Array.from(createNALUnit(1, [ 3 ])));
        const rpu = createNALUnit(62, [ 25, 8, 9 ]);
        const packet = createOffsetView(joinAnnexBNALUnits([
            [ FOUR_BYTE_START_CODE, basePicture ],
            [ FOUR_BYTE_START_CODE, enhancementWrapper ],
            [ THREE_BYTE_START_CODE, rpu ]
        ]));

        const result = splitDolbyVisionHEVCAccessUnit(packet, { kind: 'annex-b' });

        expect(result.baseLayerData?.buffer).toBe(packet.buffer);
        expect(result.baseLayerData?.byteOffset).toBe(packet.byteOffset);
        expect(result.baseLayerData).toEqual(encodeAnnexBNALUnits([ basePicture ]));
        expect(result.hasEnhancementLayerVCL).toBe(true);
        expect(result.rpuNALUnits).toEqual([ rpu ]);
    });

    it('returns a view of the leading length-prefixed bytes when only trailing NAL units of other layers are removed', () => {
        const format = { kind: 'length-prefixed', lengthSize: 4 } as const;
        const parameterSet = createNALUnit(33, [ 1 ]);
        const basePicture = createNALUnit(19, [ 2 ]);
        const rpu = createNALUnit(62, [ 25, 8, 9 ]);
        const packet = createOffsetView(encodeLengthPrefixedNALUnits([
            parameterSet,
            basePicture,
            createLayerNALUnit(19, SECOND_VIEW_LAYER_ID, [ 3 ]),
            rpu
        ], format.lengthSize));

        const result = splitDolbyVisionHEVCAccessUnit(packet, format);

        expect(result.baseLayerData?.buffer).toBe(packet.buffer);
        expect(result.baseLayerData?.byteOffset).toBe(packet.byteOffset);
        expect(result.baseLayerData).toEqual(encodeLengthPrefixedNALUnits([ parameterSet, basePicture ], format.lengthSize));
        expect(result.rpuNALUnits).toEqual([ rpu ]);
    });

    it('rebuilds the BL when a removed NAL unit precedes a BL one', () => {
        const basePicture = createNALUnit(19, [ 1 ]);
        const rpu = createNALUnit(62, [ 2 ]);
        const suffixSEI = createNALUnit(40, [ 3 ]);
        const packet = encodeAnnexBNALUnits([ basePicture, rpu, suffixSEI ]);

        const result = splitDolbyVisionHEVCAccessUnit(packet, { kind: 'annex-b' });

        expect(result.baseLayerData?.buffer).not.toBe(packet.buffer);
        expect(result.baseLayerData).toEqual(encodeAnnexBNALUnits([ basePicture, suffixSEI ]));
    });

    it('splits the NAL units its caller walked instead of walking the unit again', () => {
        const format = { kind: 'annex-b' } as const;
        const basePicture = createNALUnit(19, [ 1 ]);
        const packet = encodeAnnexBNALUnits([ basePicture, createNALUnit(62, [ 2 ]) ]);
        const walkedNALUnits = parseHEVCNALUnits(packet, format);

        expect(splitDolbyVisionHEVCAccessUnit(packet, format, format, walkedNALUnits))
            .toEqual(splitDolbyVisionHEVCAccessUnit(packet, format));
        // A walk that saw only the picture removes nothing, so the input itself comes back
        const pictureOnlySplit = splitDolbyVisionHEVCAccessUnit(packet, format, format, walkedNALUnits.slice(0, 1));
        expect(pictureOnlySplit.baseLayerData).toBe(packet);
        expect(pictureOnlySplit.rpuNALUnits).toEqual([]);
    });
});

describe('DolbyVisionHEVCSplitter validation', () => {
    it('rejects empty, truncated, and malformed access units', () => {
        expect(() => splitDolbyVisionHEVCAccessUnit(
            new Uint8Array(),
            { kind: 'annex-b' }
        )).toThrow(EMPTY_ACCESS_UNIT_ERROR);
        expect(() => splitDolbyVisionHEVCAccessUnit(
            new Uint8Array([ 0, 0, 0, 5, 1, 2 ]),
            { kind: 'length-prefixed', lengthSize: 4 }
        )).toThrow('invalid NAL unit length');
        expect(() => splitDolbyVisionHEVCAccessUnit(
            encodeAnnexBNALUnits([ createNALUnit(63, [ 1 ]) ]),
            { kind: 'annex-b' }
        )).toThrow('two-byte header');
    });

    it('rejects NAL units that do not fit the requested output prefix', () => {
        const oversizedInnerNALUnit = createNALUnit(1, new Array<number>(254).fill(7));
        const wrapper = createNALUnit(63, Array.from(oversizedInnerNALUnit));

        expect(() => splitDolbyVisionHEVCAccessUnit(
            encodeLengthPrefixedNALUnits([ wrapper ], 2),
            { kind: 'length-prefixed', lengthSize: 2 },
            { kind: 'length-prefixed', lengthSize: 1 }
        )).toThrow('does not fit the output length field');
    });
});

describe('owned native HEVC packet workarounds', () => {
    it('detects only RASL picture NAL unit types', () => {
        expect(hasHEVCRASLPicture(
            encodeAnnexBNALUnits([ createNALUnit(8, [ 1 ]) ]),
            { kind: 'annex-b' }
        )).toBe(true);
        expect(hasHEVCRASLPicture(
            encodeAnnexBNALUnits([ createNALUnit(9, [ 1 ]) ]),
            { kind: 'annex-b' }
        )).toBe(true);
        expect(hasHEVCRASLPicture(
            encodeAnnexBNALUnits([ createNALUnit(1, [ 1 ]) ]),
            { kind: 'annex-b' }
        )).toBe(false);
    });

    it('finds a base-layer SPS behind either start code or a length prefix, wherever it sits in the access unit', () => {
        const sps = createNALUnit(33, [ 1, 2 ]);
        const picture = createNALUnit(1, [ 0x42, 1 ]);
        const annexB = { kind: 'annex-b' } as const;
        expect(hasHEVCSPS(joinAnnexBNALUnits([ [ THREE_BYTE_START_CODE, sps ], [ FOUR_BYTE_START_CODE, picture ] ]), annexB)).toBe(true);
        expect(hasHEVCSPS(createOffsetView(encodeAnnexBNALUnits([ createNALUnit(35, [ 1 ]), picture, sps ])), annexB)).toBe(true);
        for (const lengthSize of [ 1, 2, 4 ] as const) {
            const format = { kind: 'length-prefixed', lengthSize } as const;
            expect(hasHEVCSPS(encodeLengthPrefixedNALUnits([ createNALUnit(32, [ 1 ]), sps, picture ], lengthSize), format)).toBe(true);
            expect(hasHEVCSPS(encodeLengthPrefixedNALUnits([ picture ], lengthSize), format)).toBe(false);
        }
    });

    it('ignores SPS bytes inside a payload, another layer\'s SPS, and malformed length framing', () => {
        const annexB = { kind: 'annex-b' } as const;
        // An SPS header byte after a lone 00 01 in a payload is no NAL unit
        expect(hasHEVCSPS(encodeAnnexBNALUnits([ createNALUnit(1, [ 0, 1, 0x42, 1 ]) ]), annexB)).toBe(false);
        expect(hasHEVCSPS(encodeAnnexBNALUnits([ createLayerNALUnit(33, SECOND_VIEW_LAYER_ID, [ 1 ]), createNALUnit(1, [ 1 ]) ]), annexB))
            .toBe(false);
        // A start code that ends the data has no header to read
        expect(hasHEVCSPS(new Uint8Array([ 0, 0, 0, 1, 2, 1, 7, 0, 0, 1 ]), annexB)).toBe(false);
        const format = { kind: 'length-prefixed', lengthSize: 2 } as const;
        const truncated = encodeLengthPrefixedNALUnits([ createNALUnit(1, [ 1 ]), createNALUnit(33, [ 1 ]) ], 2);
        truncated[1] = 0xFF;
        expect(hasHEVCSPS(truncated, format)).toBe(false);
    });

    it('sanitizes Chromium ordering violations without rewriting valid packets', () => {
        const basePicture = createNALUnit(19, [ 1 ]);
        const lateParameterSet = createNALUnit(32, [ 2 ]);
        const suffixSEI = createNALUnit(40, [ 3 ]);
        const format = { kind: 'length-prefixed', lengthSize: 2 } as const;
        const invalidPacket = encodeLengthPrefixedNALUnits([
            suffixSEI,
            basePicture,
            lateParameterSet
        ], format.lengthSize);

        const sanitizedPacket = sanitizeHEVCAccessUnitForChromium(
            invalidPacket,
            format
        );
        expect(decodeNALUnitTypes(sanitizedPacket, format)).toEqual([ 19 ]);
        expect(sanitizeHEVCAccessUnitForChromium(
            encodeLengthPrefixedNALUnits([ lateParameterSet, basePicture ], 2),
            format
        )).toBeNull();
    });
});
