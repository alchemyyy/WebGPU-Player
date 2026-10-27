import { describe, expect, it } from 'vitest';

import { splitAnnexBNALUnits, splitLengthPrefixedNALUnits } from 'webgpu-player/demux/NALUnitFraming';

const SUBJECT = 'test access unit';
const FIRST_NAL_UNIT: readonly number[] = [ 0x09, 0xF0 ];
const SECOND_NAL_UNIT: readonly number[] = [ 0x67, 0x64, 0x00, 0x0D ];
const THREE_BYTE_START_CODE: readonly number[] = [ 0, 0, 1 ];
const FOUR_BYTE_START_CODE: readonly number[] = [ 0, 0, 0, 1 ];
const LEADING_ZERO_BYTE = 0;
const STRAY_BYTE = 0x42;
const TWO_BYTE_LENGTH_SIZE = 2;
const FOUR_BYTE_LENGTH_SIZE = 4;

describe('splitAnnexBNALUnits', () => {
    it('splits at three and four-byte start codes, keeping each header and viewing the input', () => {
        const data = new Uint8Array([
            LEADING_ZERO_BYTE,
            ...FOUR_BYTE_START_CODE,
            ...FIRST_NAL_UNIT,
            ...THREE_BYTE_START_CODE,
            ...SECOND_NAL_UNIT
        ]);

        const nalUnits = splitAnnexBNALUnits(data, SUBJECT);

        expect(nalUnits.map(nalUnit => [ ...nalUnit ])).toEqual([ FIRST_NAL_UNIT, SECOND_NAL_UNIT ]);
        expect(nalUnits.every(nalUnit => nalUnit.buffer === data.buffer)).toBe(true);
    });

    it('rejects data before the first start code and data without one', () => {
        expect(() => splitAnnexBNALUnits(new Uint8Array([ STRAY_BYTE, ...THREE_BYTE_START_CODE, ...FIRST_NAL_UNIT ]), SUBJECT))
            .toThrow(`The ${SUBJECT} has data before its first start code`);
        expect(() => splitAnnexBNALUnits(new Uint8Array(FIRST_NAL_UNIT), SUBJECT)).toThrow(`The ${SUBJECT} has no Annex B start code`);
    });
});

describe('splitLengthPrefixedNALUnits', () => {
    it('splits at each unit\'s length prefix, keeping each header and viewing the input', () => {
        const data = new Uint8Array([ 0, FIRST_NAL_UNIT.length, ...FIRST_NAL_UNIT, 0, SECOND_NAL_UNIT.length, ...SECOND_NAL_UNIT ]);

        const nalUnits = splitLengthPrefixedNALUnits(data, TWO_BYTE_LENGTH_SIZE, SUBJECT);

        expect(nalUnits.map(nalUnit => [ ...nalUnit ])).toEqual([ FIRST_NAL_UNIT, SECOND_NAL_UNIT ]);
        expect(nalUnits.every(nalUnit => nalUnit.buffer === data.buffer)).toBe(true);
    });

    it('rejects a length past the data, an empty unit, and data that ends inside a length', () => {
        expect(() => splitLengthPrefixedNALUnits(new Uint8Array([ 0, 0, 0, 5, ...FIRST_NAL_UNIT ]), FOUR_BYTE_LENGTH_SIZE, SUBJECT))
            .toThrow(`The ${SUBJECT} contains an invalid NAL unit length`);
        expect(() => splitLengthPrefixedNALUnits(new Uint8Array([ 0, 0 ]), TWO_BYTE_LENGTH_SIZE, SUBJECT))
            .toThrow(`The ${SUBJECT} contains an invalid NAL unit length`);
        expect(() => splitLengthPrefixedNALUnits(new Uint8Array([ 0, FIRST_NAL_UNIT.length, ...FIRST_NAL_UNIT, 0 ]), TWO_BYTE_LENGTH_SIZE, SUBJECT))
            .toThrow(`The ${SUBJECT} ends inside a NAL unit length`);
    });
});
