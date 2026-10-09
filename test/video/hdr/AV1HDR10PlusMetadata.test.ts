import { describe, expect, it } from 'vitest';

import { parseAV1OBUs } from 'webgpu-player/video/av1/AV1OBUParser';
import { parseAV1HDR10PlusMetadata } from 'webgpu-player/video/hdr/AV1HDR10PlusMetadata';
import {
    parseHDR10PlusITUTT35Messages,
    parseHEVCHDR10PlusMetadata,
    type HDR10PlusFrameMetadata
} from 'webgpu-player/video/hdr/HDR10PlusMetadata';
import {
    createHDR10PlusHEVCVector,
    type HDR10PlusVectorKind
} from 'webgpu-player/capability/vectors/HDR10PlusVectors';

import {
    AV1_TRAILING_BITS_BYTE,
    createAV1MetadataOBU,
    createAV1OBU
} from '../../helpers/av1MetadataOBUs';
import { concatenate } from '../../helpers/byteArrays';
import { DOLBY_VISION_ITUT_T35_PAYLOAD_PREFIX } from '../../helpers/dolbyVisionAV1ITUTT35Payload';
import { getHDR10PlusITUTT35Messages } from '../../helpers/hdr10PlusVectors';

const OBU_TYPE_SEQUENCE_HEADER = 1;
const OBU_TYPE_FRAME = 6;
const METADATA_TYPE_HDR_CLL = 1;
const METADATA_TYPE_ITUT_T35 = 4;
const FRAME_OBU = createAV1OBU(OBU_TYPE_FRAME, [ 0x10, 0x5A ]);
const SEQUENCE_HEADER_OBU = createAV1OBU(OBU_TYPE_SEQUENCE_HEADER, [ 0x00, 0x00, 0x00, 0x2A ]);
const CONTENT_LIGHT_LEVEL_OBU = createAV1MetadataOBU(METADATA_TYPE_HDR_CLL, [ 0x03, 0xAC, 0x01, 0x9A ]);
// Zero bytes may follow the byte that holds the trailing one bit
const PADDED_TRAILING_BITS: readonly number[] = [ AV1_TRAILING_BITS_BYTE, 0x00, 0x00 ];
const MISSING_TRAILING_BITS: readonly number[] = [];
// A last nonzero byte whose one bit is not its first bit, or a one bit followed by more data
const MISPLACED_TRAILING_ONE_BIT: readonly number[] = [ 0x81 ];
const DATA_AFTER_TRAILING_BITS: readonly number[] = [ AV1_TRAILING_BITS_BYTE, 0x01 ];
// itu_t_t35_country_code (United States) and the ATSC provider code, whose messages are not HDR10+
const ATSC_ITUT_T35_MESSAGE: readonly number[] = [ 0xB5, 0x00, 0x31, 0x47, 0x41, 0x39, 0x34 ];
// A 0xFF country code takes an extension byte, so its provider code starts a byte later
const EXTENDED_COUNTRY_CODE_MESSAGE: readonly number[] = [ 0xFF, 0xB5, 0x00, 0x3C, 0x00, 0x01, 0x04 ];
const MALFORMED_FRAME_METADATA: HDR10PlusFrameMetadata = { metadata: null, status: 'malformed' };
const ABSENT_FRAME_METADATA: HDR10PlusFrameMetadata = { metadata: null, status: 'absent' };
const VECTOR_KINDS: readonly HDR10PlusVectorKind[] = [
    'absent',
    'conflicting',
    'malformed',
    'profile-a',
    'unsupported',
    'valid'
];

function createHDR10PlusMetadataOBUs(kind: HDR10PlusVectorKind, trailingBits?: readonly number[]): Uint8Array[] {
    return getHDR10PlusITUTT35Messages(kind).map((message: Uint8Array): Uint8Array => (
        createAV1MetadataOBU(METADATA_TYPE_ITUT_T35, message, trailingBits)
    ));
}

function parseTemporalUnit(obus: readonly Uint8Array[]): HDR10PlusFrameMetadata {
    return parseAV1HDR10PlusMetadata(parseAV1OBUs(concatenate(obus)));
}

function parseHEVCVector(kind: HDR10PlusVectorKind): HDR10PlusFrameMetadata {
    return parseHEVCHDR10PlusMetadata(createHDR10PlusHEVCVector(kind), { kind: 'annex-b' });
}

describe('parseAV1HDR10PlusMetadata', () => {
    it.each(VECTOR_KINDS)('reads the %s vector as the HEVC parse of the same messages does', kind => {
        const result = parseTemporalUnit([
            SEQUENCE_HEADER_OBU,
            CONTENT_LIGHT_LEVEL_OBU,
            ...createHDR10PlusMetadataOBUs(kind),
            FRAME_OBU
        ]);

        expect(result).toEqual(parseHEVCVector(kind));
    });

    it('reads a valid message whose trailing bits are padded with zero bytes', () => {
        const result = parseTemporalUnit([ ...createHDR10PlusMetadataOBUs('valid', PADDED_TRAILING_BITS), FRAME_OBU ]);

        expect(result.status).toBe('valid');
        expect(result).toEqual(parseHEVCVector('valid'));
    });

    it('keeps the zero bytes of a message that come before its trailing one bit', () => {
        const [ message ] = getHDR10PlusITUTT35Messages('profile-a');
        // The flags after the window statistics end the profile A payload in a zero byte
        expect(message.at(-1)).toBe(0x00);

        expect(parseTemporalUnit([ ...createHDR10PlusMetadataOBUs('profile-a'), FRAME_OBU ])).toEqual(
            parseHDR10PlusITUTT35Messages([ message ])
        );
    });

    it.each([
        { description: 'missing trailing bits', trailingBits: MISSING_TRAILING_BITS },
        { description: 'a misplaced trailing one bit', trailingBits: MISPLACED_TRAILING_ONE_BIT },
        { description: 'data after the trailing bits', trailingBits: DATA_AFTER_TRAILING_BITS }
    ])('reads an HDR10+ message with $description as malformed', ({ trailingBits }) => {
        const [ message ] = getHDR10PlusITUTT35Messages('valid');
        expect(parseTemporalUnit([ createAV1MetadataOBU(METADATA_TYPE_ITUT_T35, message), FRAME_OBU ]).status).toBe('valid');

        const result = parseTemporalUnit([
            createAV1MetadataOBU(METADATA_TYPE_ITUT_T35, message, trailingBits),
            FRAME_OBU
        ]);

        expect(result).toEqual(MALFORMED_FRAME_METADATA);
    });

    it('reads a unit with a malformed message beside a valid one as malformed', () => {
        const result = parseTemporalUnit([
            ...createHDR10PlusMetadataOBUs('valid'),
            ...createHDR10PlusMetadataOBUs('valid', MISSING_TRAILING_BITS),
            FRAME_OBU
        ]);

        expect(result).toEqual(MALFORMED_FRAME_METADATA);
    });

    it('reads identical messages of one unit as one, and different ones as conflicting', () => {
        const validOBUs = createHDR10PlusMetadataOBUs('valid');
        const [ firstOBU, secondOBU ] = createHDR10PlusMetadataOBUs('conflicting');

        expect(parseTemporalUnit([ ...validOBUs, ...validOBUs, FRAME_OBU ])).toEqual(parseHEVCVector('valid'));
        expect(parseTemporalUnit([ firstOBU, FRAME_OBU ]).status).toBe('valid');
        expect(parseTemporalUnit([ secondOBU, FRAME_OBU ]).status).toBe('valid');
        expect(parseTemporalUnit([ firstOBU, secondOBU, FRAME_OBU ])).toEqual({ metadata: null, status: 'conflicting' });
    });

    it('ignores the messages of other providers, Dolby Vision RPUs included, whatever their trailing bits', () => {
        const otherOBUs = [
            createAV1MetadataOBU(METADATA_TYPE_ITUT_T35, [ ...DOLBY_VISION_ITUT_T35_PAYLOAD_PREFIX, 0x42 ]),
            createAV1MetadataOBU(METADATA_TYPE_ITUT_T35, ATSC_ITUT_T35_MESSAGE, MISSING_TRAILING_BITS),
            createAV1MetadataOBU(METADATA_TYPE_ITUT_T35, EXTENDED_COUNTRY_CODE_MESSAGE),
            // An HDR10+ message in an OBU that is not metadata
            createAV1OBU(OBU_TYPE_FRAME, [ METADATA_TYPE_ITUT_T35, ...getHDR10PlusITUTT35Messages('valid')[0], AV1_TRAILING_BITS_BYTE ])
        ];

        expect(parseTemporalUnit([ ...otherOBUs, FRAME_OBU ])).toEqual(ABSENT_FRAME_METADATA);
        expect(parseTemporalUnit([ ...otherOBUs, ...createHDR10PlusMetadataOBUs('valid'), FRAME_OBU ])).toEqual(
            parseHEVCVector('valid')
        );
    });
});
