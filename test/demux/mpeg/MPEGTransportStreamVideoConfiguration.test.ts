// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ALL_FORMATS, BufferSource, Input, PacketCursor } from 'mediabunny';
import { describe, expect, it } from 'vitest';

import {
    findTransportStreamExtradataByteLength,
    getTransportStreamVideoCodec,
    readTransportStreamVideoDecoderDescription,
    type TransportStreamVideoCodec
} from 'webgpu-player/demux/mpeg/MPEGTransportStreamVideoConfiguration';

import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../../helpers/enginePaths';

// The FFmpeg-made vectors of scripts/codec_vector_assets/generate_transport_stream_demux_vectors.py
const TRANSPORT_STREAM_VECTOR_DIRECTORY = join(CODEC_VECTOR_ASSETS_DIRECTORY, 'mpeg-ts');
const START_CODE_PREFIX = [ 0x00, 0x00, 0x01 ] as const;
const MPEG_SEQUENCE_HEADER_CODE = 0xB3;
const MPEG_EXTENSION_CODE = 0xB5;
const MPEG_GROUP_OF_PICTURES_CODE = 0xB8;
const MPEG_PICTURE_CODE = 0x00;
const VC1_SEQUENCE_HEADER_CODE = 0x0F;
const VC1_ENTRY_POINT_CODE = 0x0E;
const VC1_FRAME_CODE = 0x0D;
// Payload bytes after each synthesized start code, none of which form a start code prefix
const MPEG_SEQUENCE_HEADER_PAYLOAD = [ 0x0C, 0x00, 0xC0, 0x13, 0xFF, 0xFF, 0xE0, 0x18 ] as const;
const MPEG_SEQUENCE_EXTENSION_PAYLOAD = [ 0x14, 0x8A, 0x00, 0x01, 0x00, 0x00 ] as const;
const MPEG_GROUP_OF_PICTURES_PAYLOAD = [ 0x00, 0x08, 0x00, 0x00 ] as const;
const MPEG_PICTURE_PAYLOAD = [ 0x00, 0x0F, 0xFF, 0xF8 ] as const;
const VC1_SEQUENCE_HEADER_PAYLOAD = [ 0xC2, 0x86, 0x13, 0xF0, 0xEF, 0x88, 0x80 ] as const;
const VC1_ENTRY_POINT_PAYLOAD = [ 0x48, 0x84, 0x4F, 0xC3, 0xBC, 0x80 ] as const;
const VC1_FRAME_PAYLOAD = [ 0xC2, 0x0F, 0xE0, 0x0D ] as const;

type TransportStreamVectorExpectation = Readonly<{
    codec: TransportStreamVideoCodec
    descriptionByteLength: number
    fileName: string
    firstStartCode: number
    mediabunnyCodec: string
}>;

// The extradata FFmpeg writes into a Matroska remux of each stream has the same length
const TRANSPORT_STREAM_VECTORS: readonly TransportStreamVectorExpectation[] = [
    { codec: 'mpeg1video', descriptionByteLength: 12, fileName: 'mpeg1video-mp3.ts', firstStartCode: MPEG_SEQUENCE_HEADER_CODE, mediabunnyCodec: 'mpeg1' },
    { codec: 'mpeg2video', descriptionByteLength: 22, fileName: 'mpeg2video-bframes-ac3.ts', firstStartCode: MPEG_SEQUENCE_HEADER_CODE, mediabunnyCodec: 'mpeg2' },
    { codec: 'mpeg2video', descriptionByteLength: 22, fileName: 'mpeg2video-bframes-ac3.m2ts', firstStartCode: MPEG_SEQUENCE_HEADER_CODE, mediabunnyCodec: 'mpeg2' },
    { codec: 'vc1', descriptionByteLength: 30, fileName: 'vc1-advanced.ts', firstStartCode: VC1_SEQUENCE_HEADER_CODE, mediabunnyCodec: 'vc1' },
    { codec: 'vc1', descriptionByteLength: 30, fileName: 'vc1-advanced.m2ts', firstStartCode: VC1_SEQUENCE_HEADER_CODE, mediabunnyCodec: 'vc1' },
    // The same stream with its PMT stripped of the VC-1 registration descriptor, which FFmpeg's demuxer does not need either
    { codec: 'vc1', descriptionByteLength: 30, fileName: 'vc1-advanced-unregistered.ts', firstStartCode: VC1_SEQUENCE_HEADER_CODE, mediabunnyCodec: 'vc1' }
];

function createUnit(startCode: number, payload: readonly number[]): number[] {
    return [ ...START_CODE_PREFIX, startCode, ...payload ];
}

const MPEG_SEQUENCE_HEADER_UNIT = createUnit(MPEG_SEQUENCE_HEADER_CODE, MPEG_SEQUENCE_HEADER_PAYLOAD);
const MPEG_SEQUENCE_EXTENSION_UNIT = createUnit(MPEG_EXTENSION_CODE, MPEG_SEQUENCE_EXTENSION_PAYLOAD);
const MPEG_GROUP_OF_PICTURES_UNIT = createUnit(MPEG_GROUP_OF_PICTURES_CODE, MPEG_GROUP_OF_PICTURES_PAYLOAD);
const MPEG_PICTURE_UNIT = createUnit(MPEG_PICTURE_CODE, MPEG_PICTURE_PAYLOAD);
const VC1_SEQUENCE_HEADER_UNIT = createUnit(VC1_SEQUENCE_HEADER_CODE, VC1_SEQUENCE_HEADER_PAYLOAD);
const VC1_ENTRY_POINT_UNIT = createUnit(VC1_ENTRY_POINT_CODE, VC1_ENTRY_POINT_PAYLOAD);
const VC1_FRAME_UNIT = createUnit(VC1_FRAME_CODE, VC1_FRAME_PAYLOAD);

describe('the video configuration of MPEG-TS and M2TS tracks', () => {
    it.each([
        [ 'mpeg1', 'mpeg1video' ],
        [ 'mpeg2', 'mpeg2video' ],
        [ 'vc1', 'vc1' ],
        [ 'avc', null ],
        [ null, null ]
    ] as const)('names Mediabunny\'s %s codec %s', (mediabunnyCodec, expectedCodec) => {
        expect(getTransportStreamVideoCodec(mediabunnyCodec)).toBe(expectedCodec);
    });

    it('takes an MPEG-2 packet\'s sequence header and extension, up to the group of pictures', () => {
        const packet = new Uint8Array([ ...MPEG_SEQUENCE_HEADER_UNIT, ...MPEG_SEQUENCE_EXTENSION_UNIT, ...MPEG_GROUP_OF_PICTURES_UNIT, ...MPEG_PICTURE_UNIT ]);

        expect(findTransportStreamExtradataByteLength('mpeg2video', packet)).toBe(MPEG_SEQUENCE_HEADER_UNIT.length + MPEG_SEQUENCE_EXTENSION_UNIT.length);
    });

    it('takes an MPEG-1 packet\'s sequence header alone when a picture follows it', () => {
        const packet = new Uint8Array([ ...MPEG_SEQUENCE_HEADER_UNIT, ...MPEG_PICTURE_UNIT ]);

        expect(findTransportStreamExtradataByteLength('mpeg1video', packet)).toBe(MPEG_SEQUENCE_HEADER_UNIT.length);
    });

    it('ignores an extension that no sequence header precedes', () => {
        const packet = new Uint8Array([ ...MPEG_SEQUENCE_EXTENSION_UNIT, ...MPEG_PICTURE_UNIT ]);

        expect(findTransportStreamExtradataByteLength('mpeg2video', packet)).toBe(0);
    });

    it('takes a VC-1 packet\'s sequence header and entry point, up to the frame', () => {
        const packet = new Uint8Array([ ...VC1_SEQUENCE_HEADER_UNIT, ...VC1_ENTRY_POINT_UNIT, ...VC1_FRAME_UNIT ]);

        expect(findTransportStreamExtradataByteLength('vc1', packet)).toBe(VC1_SEQUENCE_HEADER_UNIT.length + VC1_ENTRY_POINT_UNIT.length);
    });

    it('finds no extradata in a packet of pictures alone', () => {
        expect(findTransportStreamExtradataByteLength('vc1', new Uint8Array(VC1_FRAME_UNIT))).toBe(0);
        expect(findTransportStreamExtradataByteLength('mpeg2video', new Uint8Array(MPEG_PICTURE_UNIT))).toBe(0);
    });

    it.each(TRANSPORT_STREAM_VECTORS)('reads the decoder description of $fileName from its first sequence header', async (vector: TransportStreamVectorExpectation) => {
        const input = new Input({
            formats: ALL_FORMATS,
            source: new BufferSource(readFileSync(join(TRANSPORT_STREAM_VECTOR_DIRECTORY, vector.fileName)))
        });
        const track = await input.getPrimaryVideoTrack();
        if (!track) {
            throw new Error(`video-track-missing: ${vector.fileName}`);
        }

        const codec = await track.getCodec();
        const result = await readTransportStreamVideoDecoderDescription(vector.codec, track);

        expect(codec).toBe(vector.mediabunnyCodec);
        expect(getTransportStreamVideoCodec(codec)).toBe(vector.codec);
        if (result.status !== 'read') {
            throw new Error(result.failure);
        }
        expect(result.description.byteLength).toBe(vector.descriptionByteLength);
        expect([ ...result.description.subarray(0, START_CODE_PREFIX.length + 1) ]).toEqual([ ...START_CODE_PREFIX, vector.firstStartCode ]);
        input.dispose();
    });

    it('reads a VC-1 stream whose PMT lacks the VC-1 registration descriptor exactly like the registered stream', async () => {
        const readVector = async (fileName: string) => {
            const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(readFileSync(join(TRANSPORT_STREAM_VECTOR_DIRECTORY, fileName))) });
            const track = await input.getPrimaryVideoTrack();
            if (!track) {
                throw new Error(`video-track-missing: ${fileName}`);
            }
            const description = await readTransportStreamVideoDecoderDescription('vc1', track);
            const packets: number[][] = [];
            for await (const packet of new PacketCursor(track)) {
                packets.push([ packet.timestamp, packet.type === 'key' ? 1 : 0, ...packet.data ]);
            }
            const result = {
                codec: await track.getCodec(),
                description: description.status === 'read' ? [ ...description.description ] : description.failure,
                height: await track.getCodedHeight(),
                packets,
                width: await track.getCodedWidth()
            };
            input.dispose();
            return result;
        };

        const registered = await readVector('vc1-advanced.ts');
        const unregistered = await readVector('vc1-advanced-unregistered.ts');

        expect(unregistered.codec).toBe('vc1');
        expect(unregistered.packets).toHaveLength(12);
        expect(unregistered).toEqual(registered);
    });
});
