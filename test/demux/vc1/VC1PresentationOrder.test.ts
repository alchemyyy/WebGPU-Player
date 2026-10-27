// @vitest-environment node

import { ALL_FORMATS, BufferSource, Input, PacketCursor, PacketReader, type EncodedPacket, type InputVideoTrack } from 'mediabunny';
import { describe, expect, it } from 'vitest';

import type { PictureOrder } from 'webgpu-player/demux/PresentationOrderTrack';
import {
    createVC1PresentationOrderTrack,
    getVC1PictureOrder,
    hasVC1OutputDelay,
    readVC1AdvancedPictureTypeSyntax,
    readWMV3PictureTypeSyntax,
    type VC1PictureTypeSyntax
} from 'webgpu-player/demux/vc1/VC1PresentationOrder';

import { concatenate } from '../../helpers/byteArrays';
import {
    createVC1AdvancedEntryPointUnit,
    createVC1AdvancedExtradata,
    createVC1AdvancedPicture,
    createVC1AdvancedSequenceHeaderUnit,
    createVFWCodecPrivate,
    createVFWMatroska,
    createWMV3Picture,
    createWMV3SequenceHeader,
    type SyntheticVC1Packet,
    type VC1PictureKind,
    type WMV3SequenceFields
} from '../../helpers/vc1Media';

const SIMPLE_PROFILE = 0;
const MAIN_PROFILE = 1;
const ADVANCED_PROFILE_BITS = 0xC0;
const CODED_WIDTH = 640;
const CODED_HEIGHT = 480;
// A maximum coded width whose field is zero, so the sequence header holds three zero bytes and an emulation prevention byte before INTERLACE
const ESCAPED_MAXIMUM_CODED_WIDTH = 2;
const WVC1_SIZE_BYTE = 0x27;
// The STRUCT_C of FATE's SMM0005.rcv, a Main profile stream with one B picture between anchors
const SMM0005_SEQUENCE_HEADER = Object.freeze([ 0x4D, 0xF1, 0x0A, 0x11 ]);
const SMM0005_SYNTAX: VC1PictureTypeSyntax = { frameInterpolation: false, kind: 'simple-main', maximumBFrames: 1, rangeReduction: false };
const SHORT_SEQUENCE_HEADER_BYTE_LENGTH = 3;
const B_PICTURE_FIELDS: WMV3SequenceFields = { frameInterpolation: true, maximumBFrames: 2, profile: MAIN_PROFILE, rangeReduction: true };
const LOW_DELAY_FIELDS: WMV3SequenceFields = { frameInterpolation: false, maximumBFrames: 0, profile: SIMPLE_PROFILE, rangeReduction: false };
const PROGRESSIVE_SYNTAX: VC1PictureTypeSyntax = { interlace: false, kind: 'advanced' };
const INTERLACED_SYNTAX: VC1PictureTypeSyntax = { interlace: true, kind: 'advanced' };
// FPTYPE 0 to 3 pair I and P fields, 4 to 7 B and BI fields
const FIELD_PICTURE_TYPES = [ 0, 1, 2, 3, 4, 5, 6, 7 ];
const FIRST_BIDIRECTIONAL_FIELD_PICTURE_TYPE = 4;
const B_B_FIELD_PICTURE_TYPE = 4;
const MILLISECONDS_PER_SECOND = 1_000;
const FRAME_MILLISECONDS = 40;

type DecodeOrderPicture = Readonly<{ keyframe: boolean, kind: 'B' | 'I' | 'P', timestampMilliseconds: number }>;

function toSyntax(fields: WMV3SequenceFields): VC1PictureTypeSyntax {
    return {
        frameInterpolation: fields.frameInterpolation,
        kind: 'simple-main',
        maximumBFrames: fields.maximumBFrames,
        rangeReduction: fields.rangeReduction
    };
}

function createPackets(pictures: readonly DecodeOrderPicture[], fields: WMV3SequenceFields): SyntheticVC1Packet[] {
    return pictures.map((picture: DecodeOrderPicture): SyntheticVC1Packet => ({
        data: createWMV3Picture(picture.kind, fields),
        keyframe: picture.keyframe,
        timestampMilliseconds: picture.timestampMilliseconds
    }));
}

/** Opens a Matroska VfW WMV3 track of the pictures in decode order, its packets stamped with the timestamps given. */
async function openWMV3Track(pictures: readonly DecodeOrderPicture[], fields: WMV3SequenceFields): Promise<{ input: Input, track: InputVideoTrack }> {
    const codecPrivate = createVFWCodecPrivate('WMV3', CODED_WIDTH, CODED_HEIGHT, createWMV3SequenceHeader(fields));
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(createVFWMatroska(codecPrivate, CODED_WIDTH, CODED_HEIGHT, createPackets(pictures, fields))) });
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
        throw new Error('The synthetic Matroska file has no video track');
    }
    return { input, track };
}

function requireTrack(track: InputVideoTrack | null): InputVideoTrack {
    if (!track) {
        throw new Error('The track backing was refused');
    }
    return track;
}

function toMilliseconds(packet: EncodedPacket): number {
    return Math.round(packet.timestamp * MILLISECONDS_PER_SECOND);
}

async function readTimestamps(track: InputVideoTrack): Promise<number[]> {
    const timestamps: number[] = [];
    for await (const packet of new PacketCursor(track)) {
        timestamps.push(toMilliseconds(packet));
    }
    return timestamps;
}

describe('readWMV3PictureTypeSyntax', () => {
    it.each([ B_PICTURE_FIELDS, LOW_DELAY_FIELDS ])('reads the fields that place the picture type from a STRUCT_C', (fields: WMV3SequenceFields) => {
        expect(readWMV3PictureTypeSyntax(createWMV3SequenceHeader(fields))).toEqual(toSyntax(fields));
    });

    it('reads a Main profile stream\'s STRUCT_C with B pictures', () => {
        expect(readWMV3PictureTypeSyntax(new Uint8Array(SMM0005_SEQUENCE_HEADER))).toEqual(SMM0005_SYNTAX);
    });

    it('reads no syntax from a short header or an Advanced profile one', () => {
        expect(readWMV3PictureTypeSyntax(new Uint8Array(SHORT_SEQUENCE_HEADER_BYTE_LENGTH))).toBeNull();
        expect(readWMV3PictureTypeSyntax(new Uint8Array([ ADVANCED_PROFILE_BITS, 0, 0, 0 ]))).toBeNull();
    });
});

describe('readVC1AdvancedPictureTypeSyntax', () => {
    it.each([ false, true ])('reads INTERLACE %s from the sequence header after a size byte', (interlace: boolean) => {
        expect(readVC1AdvancedPictureTypeSyntax(createVC1AdvancedExtradata(CODED_WIDTH, CODED_HEIGHT, interlace, WVC1_SIZE_BYTE))).toEqual({ interlace, kind: 'advanced' });
    });

    it.each([ false, true ])('reads INTERLACE %s past an emulation prevention byte', (interlace: boolean) => {
        const extradata = createVC1AdvancedExtradata(ESCAPED_MAXIMUM_CODED_WIDTH, CODED_HEIGHT, interlace);

        expect(extradata.byteLength).toBeGreaterThan(createVC1AdvancedExtradata(CODED_WIDTH, CODED_HEIGHT, interlace).byteLength);
        expect(readVC1AdvancedPictureTypeSyntax(extradata)).toEqual({ interlace, kind: 'advanced' });
    });

    it('reads no syntax from extradata without a sequence header, or from a STRUCT_C', () => {
        expect(readVC1AdvancedPictureTypeSyntax(createVC1AdvancedEntryPointUnit())).toBeNull();
        expect(readVC1AdvancedPictureTypeSyntax(createWMV3SequenceHeader(B_PICTURE_FIELDS))).toBeNull();
    });
});

describe('getVC1PictureOrder', () => {
    it.each([
        [ 'I', 'anchor' ],
        [ 'P', 'anchor' ],
        [ 'B', 'bidirectional' ]
    ] as const)('orders a WMV3 %s picture after INTERPFRM, FRMCNT, and RANGEREDFRM as an %s', (kind: 'B' | 'I' | 'P', order: PictureOrder) => {
        expect(getVC1PictureOrder(createWMV3Picture(kind, B_PICTURE_FIELDS), toSyntax(B_PICTURE_FIELDS))).toBe(order);
    });

    it('reads a WMV3 I picture of a sequence without B pictures, whose PTYPE is one bit, as an anchor', () => {
        expect(getVC1PictureOrder(createWMV3Picture('I', LOW_DELAY_FIELDS), toSyntax(LOW_DELAY_FIELDS))).toBe('anchor');
    });

    it.each([
        [ 'P', 'anchor' ],
        [ 'B', 'bidirectional' ],
        [ 'I', 'anchor' ],
        [ 'BI', 'bidirectional' ],
        [ 'skipped-P', 'anchor' ]
    ] as const)('orders a progressive Advanced profile %s picture as an %s', (kind: VC1PictureKind, order: PictureOrder) => {
        expect(getVC1PictureOrder(createVC1AdvancedPicture({ kind, mode: 'progressive' }, false, null), PROGRESSIVE_SYNTAX)).toBe(order);
        expect(getVC1PictureOrder(createVC1AdvancedPicture({ kind, mode: 'progressive' }, true, null), INTERLACED_SYNTAX)).toBe(order);
        expect(getVC1PictureOrder(createVC1AdvancedPicture({ kind, mode: 'frame-interlace' }, true, null), INTERLACED_SYNTAX)).toBe(order);
    });

    it.each(FIELD_PICTURE_TYPES)('orders a field pair of FPTYPE %i by its first field', (fieldPictureType: number) => {
        const picture = createVC1AdvancedPicture({ fieldPictureType, mode: 'field-interlace' }, true, null);

        expect(getVC1PictureOrder(picture, INTERLACED_SYNTAX)).toBe(fieldPictureType >= FIRST_BIDIRECTIONAL_FIELD_PICTURE_TYPE ? 'bidirectional' : 'anchor');
    });

    it('reads a picture after its frame start code, by the interlace flag of a sequence header the packet carries', () => {
        const picture = createVC1AdvancedPicture({ fieldPictureType: B_B_FIELD_PICTURE_TYPE, mode: 'field-interlace' }, true, [
            createVC1AdvancedSequenceHeaderUnit(CODED_WIDTH, CODED_HEIGHT, true),
            createVC1AdvancedEntryPointUnit()
        ]);

        expect(getVC1PictureOrder(picture, PROGRESSIVE_SYNTAX)).toBe('bidirectional');
    });

    it('finds no picture in an empty packet or in start codes without a frame', () => {
        const headersOnly = concatenate([ createVC1AdvancedSequenceHeaderUnit(CODED_WIDTH, CODED_HEIGHT, false), createVC1AdvancedEntryPointUnit() ]);

        expect(getVC1PictureOrder(new Uint8Array(), PROGRESSIVE_SYNTAX)).toBe('none');
        expect(getVC1PictureOrder(new Uint8Array(), toSyntax(B_PICTURE_FIELDS))).toBe('none');
        expect(getVC1PictureOrder(headersOnly, PROGRESSIVE_SYNTAX)).toBe('none');
    });
});

describe('createVC1PresentationOrderTrack', () => {
    it('returns the track itself for a sequence without output delay, and delay for B pictures and every Advanced profile sequence', async () => {
        const { input, track } = await openWMV3Track([ { keyframe: true, kind: 'I', timestampMilliseconds: 0 } ], LOW_DELAY_FIELDS);
        try {
            expect(createVC1PresentationOrderTrack(track, toSyntax(LOW_DELAY_FIELDS))).toBe(track);
            expect(hasVC1OutputDelay(toSyntax(LOW_DELAY_FIELDS))).toBe(false);
            expect(hasVC1OutputDelay(toSyntax(B_PICTURE_FIELDS))).toBe(true);
            expect(hasVC1OutputDelay(PROGRESSIVE_SYNTAX)).toBe(true);
        } finally {
            input.dispose();
        }
    });

    it('refuses a track whose backing reads no packets', () => {
        const track = { _backing: {} } as unknown as InputVideoTrack;

        expect(createVC1PresentationOrderTrack(track, PROGRESSIVE_SYNTAX)).toBeNull();
    });

    it('stamps decode-time packets, as FFmpeg muxes them, with the times FFmpeg outputs their pictures at', async () => {
        // Decode order I0 P3 B1 B2 P6 B4 B5 at decode times
        const pictures: DecodeOrderPicture[] = [
            { keyframe: true, kind: 'I', timestampMilliseconds: 0 },
            { keyframe: false, kind: 'P', timestampMilliseconds: FRAME_MILLISECONDS },
            { keyframe: false, kind: 'B', timestampMilliseconds: 2 * FRAME_MILLISECONDS },
            { keyframe: false, kind: 'B', timestampMilliseconds: 3 * FRAME_MILLISECONDS },
            { keyframe: false, kind: 'P', timestampMilliseconds: 4 * FRAME_MILLISECONDS },
            { keyframe: false, kind: 'B', timestampMilliseconds: 5 * FRAME_MILLISECONDS },
            { keyframe: false, kind: 'B', timestampMilliseconds: 6 * FRAME_MILLISECONDS }
        ];
        const { input, track } = await openWMV3Track(pictures, B_PICTURE_FIELDS);
        try {
            const timestamps = await readTimestamps(requireTrack(createVC1PresentationOrderTrack(track, toSyntax(B_PICTURE_FIELDS))));

            // An anchor takes the next anchor's time, the last one its own end; B pictures keep theirs
            expect(timestamps).toEqual([ 1, 4, 2, 3, 7, 5, 6 ].map(frame => frame * FRAME_MILLISECONDS));
        } finally {
            input.dispose();
        }
    });

    it('stamps packets as mkvmerge stamps a VfW track, two anchors at the first time, with their pictures\' exact times', async () => {
        // Decode order I0 I3 B1 B2 P6 B4 B5, each packet stamped with the time of the picture a decoder outputs at it
        const pictures: DecodeOrderPicture[] = [
            { keyframe: true, kind: 'I', timestampMilliseconds: 0 },
            { keyframe: true, kind: 'I', timestampMilliseconds: 0 },
            { keyframe: false, kind: 'B', timestampMilliseconds: FRAME_MILLISECONDS },
            { keyframe: false, kind: 'B', timestampMilliseconds: 2 * FRAME_MILLISECONDS },
            { keyframe: false, kind: 'P', timestampMilliseconds: 3 * FRAME_MILLISECONDS },
            { keyframe: false, kind: 'B', timestampMilliseconds: 4 * FRAME_MILLISECONDS },
            { keyframe: false, kind: 'B', timestampMilliseconds: 5 * FRAME_MILLISECONDS }
        ];
        const { input, track } = await openWMV3Track(pictures, B_PICTURE_FIELDS);
        try {
            const presentationTrack = requireTrack(createVC1PresentationOrderTrack(track, toSyntax(B_PICTURE_FIELDS)));
            const packetReader = new PacketReader(presentationTrack);

            expect(await readTimestamps(presentationTrack)).toEqual([ 0, 3, 1, 2, 6, 4, 5 ].map(frame => frame * FRAME_MILLISECONDS));
            // The first anchor starts presentation, though the backing finds the second at the same decode time
            const startPacket = await packetReader.getKeyAt(0);
            expect(startPacket && toMilliseconds(startPacket)).toBe(0);
            expect(startPacket && await packetReader.getNext(startPacket)).toMatchObject({ type: 'key' });
            // A time between an anchor's decode time and its presentation starts from the anchor before it
            const midPacket = await packetReader.getKeyAt(FRAME_MILLISECONDS / MILLISECONDS_PER_SECOND);
            expect(midPacket && toMilliseconds(midPacket)).toBe(0);
            const laterPacket = await packetReader.getKeyAt((3 * FRAME_MILLISECONDS) / MILLISECONDS_PER_SECOND);
            expect(laterPacket && toMilliseconds(laterPacket)).toBe(3 * FRAME_MILLISECONDS);
        } finally {
            input.dispose();
        }
    });

    it('leaves metadata-only packets, whose pictures it cannot read, at their own times', async () => {
        const pictures: DecodeOrderPicture[] = [
            { keyframe: true, kind: 'I', timestampMilliseconds: 0 },
            { keyframe: false, kind: 'P', timestampMilliseconds: FRAME_MILLISECONDS }
        ];
        const { input, track } = await openWMV3Track(pictures, B_PICTURE_FIELDS);
        try {
            const packetReader = new PacketReader(requireTrack(createVC1PresentationOrderTrack(track, toSyntax(B_PICTURE_FIELDS))));

            const metadataPacket = await packetReader.getFirst({ metadataOnly: true });
            const packet = await packetReader.getFirst();

            expect(metadataPacket && toMilliseconds(metadataPacket)).toBe(0);
            expect(packet && toMilliseconds(packet)).toBe(FRAME_MILLISECONDS);
        } finally {
            input.dispose();
        }
    });
});
