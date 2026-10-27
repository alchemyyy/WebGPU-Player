// @vitest-environment node

import { ALL_FORMATS, BufferSource, Input, PacketCursor, PacketReader, type EncodedPacket, type InputVideoTrack } from 'mediabunny';
import { describe, expect, it } from 'vitest';

import {
    createMPEG4PresentationOrderTrack,
    getMPEG4PictureOrder,
    readMPEG4VideoObjectLayerSyntax,
    type MPEG4VideoObjectLayerSyntax
} from 'webgpu-player/demux/mpeg4/MPEG4PresentationOrder';

import { concatenate } from '../../helpers/byteArrays';
import { createVideoTrackMatroska, type SyntheticMatroskaBlock } from '../../helpers/matroskaElements';
import {
    createMPEG4Extradata,
    createMPEG4VideoObjectLayer,
    createMPEG4VOP,
    type MPEG4VideoObjectLayerFields,
    type MPEG4VOPType
} from '../../helpers/mpeg4Bitstream';
import { createVFWCodecPrivate } from '../../helpers/vc1Media';

const CODED_WIDTH = 176;
const CODED_HEIGHT = 144;
const FRAME_MILLISECONDS = 40;
const MILLISECONDS_PER_SECOND = 1_000;
// 25 ticks a second, whose time increments FFmpeg reads in av_log2(24) + 1 bits
const TIME_INCREMENT_RESOLUTION = 25;
const TIME_INCREMENT_BIT_COUNT = 5;
const B_VOP_LAYER: MPEG4VideoObjectLayerFields = { lowDelay: false, timeIncrementResolution: TIME_INCREMENT_RESOLUTION };
const B_VOP_SYNTAX: MPEG4VideoObjectLayerSyntax = { lowDelay: false, timeIncrementBitCount: TIME_INCREMENT_BIT_COUNT };
const LOW_DELAY_SYNTAX: MPEG4VideoObjectLayerSyntax = { lowDelay: true, timeIncrementBitCount: TIME_INCREMENT_BIT_COUNT };

/** A VOP of a packet in decode order: its type, whether it is coded, and its key flag. */
type DecodeOrderVOP = Readonly<{ coded?: boolean, keyframe?: boolean, type: MPEG4VOPType }>;

function createVOP(type: MPEG4VOPType, coded = true): Uint8Array {
    return createMPEG4VOP(type, coded, TIME_INCREMENT_BIT_COUNT);
}

/** Opens a Matroska VfW XVID track of the VOPs, each packet stamped with its decode slot's time, as AVI and VfW tracks stamp them. */
async function openDecodeOrderTrack(vops: readonly DecodeOrderVOP[]): Promise<{ input: Input, track: InputVideoTrack }> {
    const blocks = vops.map((vop: DecodeOrderVOP, index: number): SyntheticMatroskaBlock => ({
        data: createVOP(vop.type, vop.coded ?? true),
        keyframe: vop.keyframe ?? vop.type === 'I',
        timestampMilliseconds: index * FRAME_MILLISECONDS
    }));
    const matroska = createVideoTrackMatroska({
        blocks,
        codecID: 'V_MS/VFW/FOURCC',
        codecPrivate: createVFWCodecPrivate('XVID', CODED_WIDTH, CODED_HEIGHT, createMPEG4Extradata(B_VOP_LAYER)),
        defaultDurationMilliseconds: FRAME_MILLISECONDS,
        pixelHeight: CODED_HEIGHT,
        pixelWidth: CODED_WIDTH
    });
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(matroska) });
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

function toFrames(packet: EncodedPacket): number {
    return Math.round(packet.timestamp * MILLISECONDS_PER_SECOND / FRAME_MILLISECONDS);
}

async function readFrames(track: InputVideoTrack): Promise<number[]> {
    const frames: number[] = [];
    for await (const packet of new PacketCursor(track)) {
        frames.push(toFrames(packet));
    }
    return frames;
}

describe('readMPEG4VideoObjectLayerSyntax', () => {
    it.each([
        [ 'clears low_delay in its vol_control_parameters', B_VOP_LAYER, false ],
        [ 'sets low_delay after VBV parameters', { lowDelay: true, timeIncrementResolution: TIME_INCREMENT_RESOLUTION, vbvParameters: true }, true ],
        // FFmpeg assumes low delay for Simple and Advanced Simple layers without vol_control_parameters
        [ 'has no vol_control_parameters', { lowDelay: null, timeIncrementResolution: TIME_INCREMENT_RESOLUTION }, true ]
    ])('reads a layer that %s', (_label: string, fields: MPEG4VideoObjectLayerFields, lowDelay: boolean) => {
        expect(readMPEG4VideoObjectLayerSyntax(createMPEG4Extradata(fields))).toEqual({ lowDelay, timeIncrementBitCount: TIME_INCREMENT_BIT_COUNT });
    });

    it.each([
        [ 1, 1 ],
        [ 2, 1 ],
        [ TIME_INCREMENT_RESOLUTION, TIME_INCREMENT_BIT_COUNT ],
        [ 30_000, 15 ],
        [ 65_535, 16 ]
    ])('counts the time increment bits of a resolution of %i as FFmpeg does: %i', (timeIncrementResolution: number, timeIncrementBitCount: number) => {
        const fields: MPEG4VideoObjectLayerFields = { extendedAspectRatio: true, lowDelay: false, objectLayerIdentifier: true, timeIncrementResolution };

        expect(readMPEG4VideoObjectLayerSyntax(createMPEG4VideoObjectLayer(fields))).toEqual({ lowDelay: false, timeIncrementBitCount });
    });

    it('reads no layer from bytes without one, or of a zero time increment resolution, which FFmpeg refuses', () => {
        expect(readMPEG4VideoObjectLayerSyntax(createVOP('I'))).toBeNull();
        expect(readMPEG4VideoObjectLayerSyntax(new Uint8Array())).toBeNull();
        expect(readMPEG4VideoObjectLayerSyntax(createMPEG4Extradata({ lowDelay: false, timeIncrementResolution: 0 }))).toBeNull();
    });
});

describe('getMPEG4PictureOrder', () => {
    it.each([
        [ 'I', 'anchor' ],
        [ 'P', 'anchor' ],
        [ 'S', 'anchor' ],
        [ 'B', 'bidirectional' ]
    ] as const)('orders a coded %s-VOP as %s', (type: MPEG4VOPType, order: string) => {
        expect(getMPEG4PictureOrder(createVOP(type), B_VOP_SYNTAX)).toBe(order);
        // After seconds of modulo_time_base
        expect(getMPEG4PictureOrder(createMPEG4VOP(type, true, TIME_INCREMENT_BIT_COUNT, 2), B_VOP_SYNTAX)).toBe(order);
    });

    it.each([ 'I', 'P', 'B' ] as const)('finds no picture in a %s-VOP that is not coded, an N-VOP', (type: MPEG4VOPType) => {
        expect(getMPEG4PictureOrder(createVOP(type, false), B_VOP_SYNTAX)).toBe('none');
    });

    it('reads a key packet\'s VOP after its headers, and finds no picture in a packet without a VOP', () => {
        expect(getMPEG4PictureOrder(concatenate([ createMPEG4Extradata(B_VOP_LAYER), createVOP('B') ]), B_VOP_SYNTAX)).toBe('bidirectional');
        expect(getMPEG4PictureOrder(createMPEG4Extradata(B_VOP_LAYER), B_VOP_SYNTAX)).toBe('none');
        expect(getMPEG4PictureOrder(new Uint8Array(), B_VOP_SYNTAX)).toBe('none');
    });
});

describe('createMPEG4PresentationOrderTrack', () => {
    it('returns the track itself for a low-delay layer, which outputs each VOP at once', async () => {
        const { input, track } = await openDecodeOrderTrack([ { type: 'I' }, { type: 'P' } ]);
        try {
            expect(createMPEG4PresentationOrderTrack(track, LOW_DELAY_SYNTAX)).toBe(track);
        } finally {
            input.dispose();
        }
    });

    it('stamps decode-order packets with the times FFmpeg outputs their VOPs at', async () => {
        // Decode order I0 P3 B1 B2 S6 B4 B5
        const { input, track } = await openDecodeOrderTrack([
            { type: 'I' }, { type: 'P' }, { type: 'B' }, { type: 'B' }, { type: 'S' }, { type: 'B' }, { type: 'B' }
        ]);
        try {
            // An anchor takes the next anchor's time, the last one its own end; B-VOPs keep theirs
            expect(await readFrames(requireTrack(createMPEG4PresentationOrderTrack(track, B_VOP_SYNTAX)))).toEqual([ 1, 4, 2, 3, 7, 5, 6 ]);
        } finally {
            input.dispose();
        }
    });

    it('passes over N-VOPs, for which FFmpeg outputs nothing, as it passes over B-VOPs', async () => {
        const { input, track } = await openDecodeOrderTrack([
            { type: 'I' }, { type: 'P' }, { type: 'B' }, { coded: false, type: 'P' }, { type: 'P' }
        ]);
        try {
            // The second anchor outputs at the third, past the N-VOP, which keeps its own time
            expect(await readFrames(requireTrack(createMPEG4PresentationOrderTrack(track, B_VOP_SYNTAX)))).toEqual([ 1, 4, 2, 3, 5 ]);
        } finally {
            input.dispose();
        }
    });

    it('starts a time from the latest key packet that presents by then', async () => {
        // Decode order I0 P2 B1 I4 B3 P5, the second I-VOP a key packet at decode time 3
        const { input, track } = await openDecodeOrderTrack([
            { type: 'I' }, { type: 'P' }, { type: 'B' }, { type: 'I' }, { type: 'B' }, { type: 'P' }
        ]);
        try {
            const packetReader = new PacketReader(requireTrack(createMPEG4PresentationOrderTrack(track, B_VOP_SYNTAX)));
            const timeOf = (frames: number): number => frames * FRAME_MILLISECONDS / MILLISECONDS_PER_SECOND;

            // The first anchor presents at 1, after the start
            const startPacket = await packetReader.getKeyAt(0);
            expect(startPacket && toFrames(startPacket)).toBe(1);
            // The second key packet's decode time is 3, but it presents at 5, so 3 starts from the first
            const groupPacket = await packetReader.getKeyAt(timeOf(3));
            expect(groupPacket && toFrames(groupPacket)).toBe(1);
            const laterPacket = await packetReader.getKeyAt(timeOf(5));
            expect(laterPacket && toFrames(laterPacket)).toBe(5);
        } finally {
            input.dispose();
        }
    });

    it('refuses a track whose backing reads no packets', () => {
        expect(createMPEG4PresentationOrderTrack({ _backing: {} } as unknown as InputVideoTrack, B_VOP_SYNTAX)).toBeNull();
    });
});
