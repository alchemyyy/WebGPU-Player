import { describe, expect, it } from 'vitest';

import {
    findHEVCPreferredTransferCharacteristics,
    parseHEVCSEIMessages
} from 'webgpu-player/video/hevc/HEVCSEI';

import { addEmulationPreventionBytes, appendExtendedValue } from '../../helpers/hevcNALUnits';

const ANNEX_B_START_CODE = [ 0, 0, 0, 1 ];

function createSEIAccessUnit(
    nalUnitType: 39 | 40,
    payloadType: number,
    payload: readonly number[],
    layerID = 0
): Uint8Array {
    const RBSP: number[] = [];
    appendExtendedValue(RBSP, payloadType);
    appendExtendedValue(RBSP, payload.length);
    RBSP.push(...payload, 0x80);
    return Uint8Array.from([
        ...ANNEX_B_START_CODE,
        // nuh_layer_id spans the last bit of the first header byte and the top five bits of the second
        (nalUnitType << 1) | (layerID >> 5),
        ((layerID & 0x1F) << 3) | 1,
        ...addEmulationPreventionBytes(RBSP)
    ]);
}

describe('parseHEVCSEIMessages', () => {
    it.each([ 39, 40 ] as const)(
        'extracts extended payload type and owned RBSP bytes from NAL type %i',
        nalUnitType => {
            const messages = parseHEVCSEIMessages(
                createSEIAccessUnit(nalUnitType, 300, [ 0, 0, 1, 3 ]),
                { kind: 'annex-b' }
            );

            expect(messages).toHaveLength(1);
            expect(messages[0].payloadType).toBe(300);
            expect(messages[0].prefix).toBe(nalUnitType === 39);
            expect(Array.from(messages[0].payload)).toEqual([ 0, 0, 1, 3 ]);
        }
    );

    it('reads only base-layer SEI, ignoring another layer even when it is malformed', () => {
        const malformedLayerSEI = Uint8Array.from([
            ...ANNEX_B_START_CODE,
            39 << 1,
            (1 << 3) | 1,
            5,
            1,
            0x7F
        ]);
        const accessUnit = Uint8Array.from([
            ...createSEIAccessUnit(39, 137, [ 1, 2 ], 1),
            ...createSEIAccessUnit(40, 144, [ 3, 4 ]),
            ...createSEIAccessUnit(39, 4, [ 5 ], 32),
            ...malformedLayerSEI
        ]);

        const messages = parseHEVCSEIMessages(accessUnit, { kind: 'annex-b' });

        expect(messages).toHaveLength(1);
        expect(messages[0].payloadType).toBe(144);
        expect(Array.from(messages[0].payload)).toEqual([ 3, 4 ]);
    });

    it('rejects access units with an unbounded number of messages', () => {
        const RBSP: number[] = [];
        for (let messageIndex = 0; messageIndex < 257; messageIndex += 1) {
            RBSP.push(5, 0);
        }
        RBSP.push(0x80);
        const accessUnit = Uint8Array.from([
            ...ANNEX_B_START_CODE,
            39 << 1,
            1,
            ...addEmulationPreventionBytes(RBSP)
        ]);

        expect(() => parseHEVCSEIMessages(
            accessUnit,
            { kind: 'annex-b' }
        )).toThrow('message count exceeds');
    });

    it('rejects an invalid emulation-prevention sequence', () => {
        const accessUnit = Uint8Array.from([
            ...ANNEX_B_START_CODE,
            39 << 1,
            1,
            5,
            4,
            0,
            0,
            3,
            4,
            0x80
        ]);

        expect(() => parseHEVCSEIMessages(
            accessUnit,
            { kind: 'annex-b' }
        )).toThrow('invalid emulation-prevention');
    });

    it('rejects an SEI NAL unit without RBSP trailing bits', () => {
        const accessUnit = Uint8Array.from([
            ...ANNEX_B_START_CODE,
            39 << 1,
            1,
            5,
            1,
            0x7F
        ]);

        expect(() => parseHEVCSEIMessages(
            accessUnit,
            { kind: 'annex-b' }
        )).toThrow('no RBSP trailing bits');
    });
});

describe('findHEVCPreferredTransferCharacteristics', () => {
    const ALTERNATIVE_TRANSFER_CHARACTERISTICS_PAYLOAD_TYPE = 147;
    const HLG_TRANSFER_CHARACTERISTICS = 18;
    const PQ_TRANSFER_CHARACTERISTICS = 16;
    const UNSPECIFIED_TRANSFER_CHARACTERISTICS = 2;

    it('reads preferred_transfer_characteristics from a prefix SEI', () => {
        expect(findHEVCPreferredTransferCharacteristics(
            createSEIAccessUnit(39, ALTERNATIVE_TRANSFER_CHARACTERISTICS_PAYLOAD_TYPE, [
                HLG_TRANSFER_CHARACTERISTICS
            ]),
            { kind: 'annex-b' }
        )).toBe(HLG_TRANSFER_CHARACTERISTICS);
    });

    it('returns null without the SEI, for the unspecified value, in suffix SEI, and on other layers', () => {
        const accessUnits = [
            createSEIAccessUnit(39, 137, [ 1, 2 ]),
            createSEIAccessUnit(39, ALTERNATIVE_TRANSFER_CHARACTERISTICS_PAYLOAD_TYPE, [
                UNSPECIFIED_TRANSFER_CHARACTERISTICS
            ]),
            // Payload type 147 is reserved in suffix SEI
            createSEIAccessUnit(40, ALTERNATIVE_TRANSFER_CHARACTERISTICS_PAYLOAD_TYPE, [
                HLG_TRANSFER_CHARACTERISTICS
            ]),
            createSEIAccessUnit(39, ALTERNATIVE_TRANSFER_CHARACTERISTICS_PAYLOAD_TYPE, [
                HLG_TRANSFER_CHARACTERISTICS
            ], 1)
        ];
        for (const accessUnit of accessUnits) {
            expect(findHEVCPreferredTransferCharacteristics(accessUnit, { kind: 'annex-b' }))
                .toBeNull();
        }
    });

    it('ignores reserved and unnamed preferred transfer values, as FFmpeg does', () => {
        for (const unnamedValue of [ 0, 3, 19, 255 ]) {
            expect(findHEVCPreferredTransferCharacteristics(
                createSEIAccessUnit(39, ALTERNATIVE_TRANSFER_CHARACTERISTICS_PAYLOAD_TYPE, [ unnamedValue ]),
                { kind: 'annex-b' }
            )).toBeNull();
        }
        expect(findHEVCPreferredTransferCharacteristics(
            createSEIAccessUnit(39, ALTERNATIVE_TRANSFER_CHARACTERISTICS_PAYLOAD_TYPE, [ 1 ]),
            { kind: 'annex-b' }
        )).toBe(1);
    });

    it('accepts repeated equal values and ignores an unspecified one beside a named transfer', () => {
        const accessUnit = Uint8Array.from([
            ...createSEIAccessUnit(39, ALTERNATIVE_TRANSFER_CHARACTERISTICS_PAYLOAD_TYPE, [
                UNSPECIFIED_TRANSFER_CHARACTERISTICS
            ]),
            ...createSEIAccessUnit(39, ALTERNATIVE_TRANSFER_CHARACTERISTICS_PAYLOAD_TYPE, [
                PQ_TRANSFER_CHARACTERISTICS
            ]),
            ...createSEIAccessUnit(39, ALTERNATIVE_TRANSFER_CHARACTERISTICS_PAYLOAD_TYPE, [
                PQ_TRANSFER_CHARACTERISTICS
            ])
        ]);

        expect(findHEVCPreferredTransferCharacteristics(accessUnit, { kind: 'annex-b' }))
            .toBe(PQ_TRANSFER_CHARACTERISTICS);
    });

    it('rejects an empty payload and conflicting values', () => {
        expect(() => findHEVCPreferredTransferCharacteristics(
            createSEIAccessUnit(39, ALTERNATIVE_TRANSFER_CHARACTERISTICS_PAYLOAD_TYPE, []),
            { kind: 'annex-b' }
        )).toThrow('payload is empty');
        expect(() => findHEVCPreferredTransferCharacteristics(
            Uint8Array.from([
                ...createSEIAccessUnit(39, ALTERNATIVE_TRANSFER_CHARACTERISTICS_PAYLOAD_TYPE, [
                    HLG_TRANSFER_CHARACTERISTICS
                ]),
                ...createSEIAccessUnit(39, ALTERNATIVE_TRANSFER_CHARACTERISTICS_PAYLOAD_TYPE, [
                    PQ_TRANSFER_CHARACTERISTICS
                ])
            ]),
            { kind: 'annex-b' }
        )).toThrow('conflicting alternative transfer characteristics');
    });
});
