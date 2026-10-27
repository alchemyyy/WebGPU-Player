// @vitest-environment node

import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../helpers/enginePaths';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    ALL_FORMATS,
    BufferSource,
    EncodedPacket,
    Input,
    MATROSKA,
    PacketCursor,
    PacketReader,
    WEBM,
    type InputFormat,
    type InputVideoTrack
} from 'mediabunny';
import { describe, expect, it } from 'vitest';

import { CUSTOM_DECODE_INPUT_FORMATS } from 'webgpu-player/demux/CustomDecodeInputFormats';
import { readMatroskaBlockAdditions, type MatroskaBlockAddition } from 'webgpu-player/demux/MatroskaBlockAdditions';

import { concatenate, createBytesFromHex } from '../helpers/byteArrays';
import {
    createASCIIElement,
    createElement,
    createUnsignedIntegerElement
} from '../helpers/matroskaElements';
import type { HDR10PlusVectorFrame } from '../helpers/hdr10PlusVectors';
import {
    readVP9HDR10PlusVector,
    VP9_HDR10_PLUS_EXPECTATIONS,
    type VP9HDR10PlusVector
} from '../helpers/vp9HDR10PlusVectors';

// The worker's owned VP9 path reads packets with the same options
const OWNED_VP9_PACKET_OPTIONS = {
    metadataOnly: false,
    verifyKeyPackets: true
} as const;
const PLAIN_PACKET_OPTIONS = { metadataOnly: false } as const;
const VECTORS = VP9_HDR10_PLUS_EXPECTATIONS.vectors;
const SECOND_KEY_FRAME_INDEX = VP9_HDR10_PLUS_EXPECTATIONS.frames.findIndex(
    (frame: HDR10PlusVectorFrame, frameIndex: number): boolean => frameIndex > 0 && frame.keyFrame
);
// Halfway into the frame after the second key frame, so the key packet lookup lands on the second key frame
const SECOND_GROUP_SEEK_SECONDS = (SECOND_KEY_FRAME_INDEX + 1.5) / VP9_HDR10_PLUS_EXPECTATIONS.frameRate;
const DOLBY_VISION_AV1_VECTOR_DIRECTORY = resolve(CODEC_VECTOR_ASSETS_DIRECTORY, 'dolby-vision-av1');
// Matroska with a BlockAdditionMapping but no block additions, and an MP4 of the same stream
const MATROSKA_WITHOUT_ADDITIONS_FILE_NAME = 'profile10.1.mkv';
const MP4_FILE_NAME = 'profile10.1.mp4';

// Matroska element IDs, with their length markers, from RFC 9559 and the WebM alpha extension
const EBML_ID = 0x1A45_DFA3;
const DOC_TYPE_ID = 0x4282;
const SEGMENT_ID = 0x1853_8067;
const TRACKS_ID = 0x1654_AE6B;
const TRACK_ENTRY_ID = 0xAE;
const TRACK_NUMBER_ID = 0xD7;
const TRACK_TYPE_ID = 0x83;
const CODEC_ID = 0x86;
const VIDEO_ID = 0xE0;
const PIXEL_WIDTH_ID = 0xB0;
const PIXEL_HEIGHT_ID = 0xBA;
const ALPHA_MODE_ID = 0x53C0;
const CLUSTER_ID = 0x1F43_B675;
const TIMESTAMP_ID = 0xE7;
const SIMPLE_BLOCK_ID = 0xA3;
const BLOCK_GROUP_ID = 0xA0;
const BLOCK_ID = 0xA1;
const BLOCK_ADDITIONS_ID = 0x75A1;
const BLOCK_MORE_ID = 0xA6;
const BLOCK_ADD_ID_ID = 0xEE;
const BLOCK_ADDITIONAL_ID = 0xA5;
const REFERENCE_BLOCK_ID = 0xFB;
const VIDEO_TRACK_TYPE = 1;
const SYNTHETIC_TRACK_NUMBER = 1;
const SYNTHETIC_FRAME_SIZE = 64;
// The alpha channel, then two other additions in the same BlockGroup
const ALPHA_BLOCK_ADDITION_ID = 1;
const ITU_T_T35_BLOCK_ADDITION_ID = 4;
const OTHER_BLOCK_ADDITION_ID = 5;
const ALPHA_DATA = new Uint8Array([ 0xA1, 0xA2, 0xA3 ]);
const HDR10_PLUS_MESSAGE = createBytesFromHex(VP9_HDR10_PLUS_EXPECTATIONS.frames[0].ITUTT35Message ?? '');
// An ITU-T T.35 header of another provider: United States, Dolby
const OTHER_PROVIDER_MESSAGE = new Uint8Array([ 0xB5, 0x00, 0x3B, 0x00, 0x00, 0x08, 0x00 ]);
const KEY_FRAME_DATA = new Uint8Array([ 0x82, 0x49, 0x83, 0x42 ]);
const INTER_FRAME_DATA = new Uint8Array([ 0x86, 0x00, 0x01 ]);
const FIRST_LACED_FRAME_DATA = new Uint8Array([ 0x86, 0x10 ]);
const SECOND_LACED_FRAME_DATA = new Uint8Array([ 0x86, 0x20, 0x21 ]);
// Block flags: Xiph lacing, and a lace header of the frame count minus one, then the first frame's size
const XIPH_LACING_FLAG = 0x02;
const INTER_FRAME_RELATIVE_TIMESTAMP = 40;
const LACED_BLOCK_RELATIVE_TIMESTAMP = 80;
const PREVIOUS_BLOCK_REFERENCE = 1;

function readDolbyVisionAV1Vector(fileName: string): Uint8Array {
    return new Uint8Array(readFileSync(resolve(DOLBY_VISION_AV1_VECTOR_DIRECTORY, fileName)));
}

async function withVideoTrack(
    data: Uint8Array,
    formats: InputFormat[],
    inspect: (track: InputVideoTrack, input: Input) => Promise<void>
): Promise<void> {
    const input = new Input({ formats, source: new BufferSource(data) });
    try {
        const videoTracks = await input.getVideoTracks();
        expect(videoTracks).toHaveLength(1);
        await inspect(videoTracks[0], input);
    } finally {
        input.dispose();
    }
}

async function readPackets(track: InputVideoTrack): Promise<EncodedPacket[]> {
    const packets: EncodedPacket[] = [];
    for await (const packet of new PacketCursor(track, { options: OWNED_VP9_PACKET_OPTIONS })) {
        packets.push(packet);
    }
    return packets;
}

function describeAdditions(additions: readonly MatroskaBlockAddition[]): Array<[ number, number[] ]> {
    return additions.map((addition: MatroskaBlockAddition): [ number, number[] ] => [ addition.addId, Array.from(addition.data) ]);
}

function describePacketAdditions(packet: EncodedPacket | null): Array<[ number, number[] ]> | null {
    return packet && describeAdditions(readMatroskaBlockAdditions(packet));
}

/** The one ITU-T T.35 BlockAdditional the generator wrote for a frame, or none. */
function getExpectedAdditions(frame: HDR10PlusVectorFrame): Array<[ number, number[] ]> {
    if (frame.ITUTT35Message === null) {
        return [];
    }
    return [ [ VP9_HDR10_PLUS_EXPECTATIONS.blockAdditionID, Array.from(createBytesFromHex(frame.ITUTT35Message)) ] ];
}

function createBlockHeader(relativeTimestamp: number, flags: number): Uint8Array {
    // The track number as a one-byte variable-size integer, a 16-bit relative timestamp, and the flags
    return new Uint8Array([ 0x80 | SYNTHETIC_TRACK_NUMBER, relativeTimestamp >> 8, relativeTimestamp & 0xFF, flags ]);
}

function createBlockMore(addID: number, data: Uint8Array): Uint8Array {
    return createElement(BLOCK_MORE_ID, concatenate([
        createUnsignedIntegerElement(BLOCK_ADD_ID_ID, addID),
        createElement(BLOCK_ADDITIONAL_ID, data)
    ]));
}

/**
 * Creates a WebM VP9 track with alpha: a key BlockGroup with alpha and two other additions, a SimpleBlock, and a laced BlockGroup with an addition.
 * Mediabunny parses frames without decoding them, so the frames are only their first header bytes.
 */
function createAlphaWebM(): Uint8Array {
    const track = createElement(TRACK_ENTRY_ID, concatenate([
        createUnsignedIntegerElement(TRACK_NUMBER_ID, SYNTHETIC_TRACK_NUMBER),
        createUnsignedIntegerElement(TRACK_TYPE_ID, VIDEO_TRACK_TYPE),
        createASCIIElement(CODEC_ID, 'V_VP9'),
        createElement(VIDEO_ID, concatenate([
            createUnsignedIntegerElement(PIXEL_WIDTH_ID, SYNTHETIC_FRAME_SIZE),
            createUnsignedIntegerElement(PIXEL_HEIGHT_ID, SYNTHETIC_FRAME_SIZE),
            createUnsignedIntegerElement(ALPHA_MODE_ID, 1)
        ]))
    ]));
    const keyBlockGroup = createElement(BLOCK_GROUP_ID, concatenate([
        createElement(BLOCK_ID, concatenate([ createBlockHeader(0, 0), KEY_FRAME_DATA ])),
        createElement(BLOCK_ADDITIONS_ID, concatenate([
            createBlockMore(ALPHA_BLOCK_ADDITION_ID, ALPHA_DATA),
            createBlockMore(ITU_T_T35_BLOCK_ADDITION_ID, HDR10_PLUS_MESSAGE),
            createBlockMore(OTHER_BLOCK_ADDITION_ID, OTHER_PROVIDER_MESSAGE)
        ]))
    ]));
    const simpleBlock = createElement(SIMPLE_BLOCK_ID, concatenate([ createBlockHeader(INTER_FRAME_RELATIVE_TIMESTAMP, 0), INTER_FRAME_DATA ]));
    const lacedBlockGroup = createElement(BLOCK_GROUP_ID, concatenate([
        createElement(BLOCK_ID, concatenate([
            createBlockHeader(LACED_BLOCK_RELATIVE_TIMESTAMP, XIPH_LACING_FLAG),
            new Uint8Array([ 1, FIRST_LACED_FRAME_DATA.byteLength ]),
            FIRST_LACED_FRAME_DATA,
            SECOND_LACED_FRAME_DATA
        ])),
        createElement(BLOCK_ADDITIONS_ID, createBlockMore(ITU_T_T35_BLOCK_ADDITION_ID, HDR10_PLUS_MESSAGE)),
        createUnsignedIntegerElement(REFERENCE_BLOCK_ID, PREVIOUS_BLOCK_REFERENCE)
    ]));
    const cluster = createElement(CLUSTER_ID, concatenate([
        createUnsignedIntegerElement(TIMESTAMP_ID, 0),
        keyBlockGroup,
        simpleBlock,
        lacedBlockGroup
    ]));
    return concatenate([
        createElement(EBML_ID, createASCIIElement(DOC_TYPE_ID, 'webm')),
        createElement(SEGMENT_ID, concatenate([ createElement(TRACKS_ID, track), cluster ]))
    ]);
}

describe('readMatroskaBlockAdditions', () => {
    describe.each(VECTORS.map((vector: VP9HDR10PlusVector) => [ vector.fileName, vector ] as const))(
        'over %s',
        (_fileName: string, vector: VP9HDR10PlusVector) => {
            it('reads each packet\'s ITU-T T.35 BlockAdditional, as the generator wrote it', async () => {
                await withVideoTrack(
                    readVP9HDR10PlusVector(vector.fileName),
                    ALL_FORMATS,
                    async (track: InputVideoTrack, input: Input): Promise<void> => {
                        expect((await input.getFormat()).name).toBe(vector.container === 'webm' ? WEBM.name : MATROSKA.name);
                        const packets = await readPackets(track);

                        expect(packets.map(packet => packet.type === 'key')).toEqual(
                            VP9_HDR10_PLUS_EXPECTATIONS.frames.map(frame => frame.keyFrame)
                        );
                        expect(packets.map(describePacketAdditions)).toEqual(VP9_HDR10_PLUS_EXPECTATIONS.frames.map(getExpectedAdditions));
                    }
                );
            });

            it('reads the packets a seek reaches, and a cluster parsed again', async () => {
                const frames = VP9_HDR10_PLUS_EXPECTATIONS.frames;
                await withVideoTrack(
                    readVP9HDR10PlusVector(vector.fileName),
                    ALL_FORMATS,
                    async (track: InputVideoTrack): Promise<void> => {
                        const packetReader = new PacketReader(track);
                        const keyPacket = await packetReader.getKeyAt(SECOND_GROUP_SEEK_SECONDS, OWNED_VP9_PACKET_OPTIONS);
                        if (!keyPacket) {
                            throw new Error('The vector has no key packet in its second group');
                        }
                        const nextPacket = await packetReader.getNext(keyPacket, OWNED_VP9_PACKET_OPTIONS);
                        // Mediabunny keeps one parsed cluster, so the first packet parses the first cluster again
                        const firstPacket = await packetReader.getFirst(OWNED_VP9_PACKET_OPTIONS);

                        expect(describePacketAdditions(keyPacket)).toEqual(getExpectedAdditions(frames[SECOND_KEY_FRAME_INDEX]));
                        expect(describePacketAdditions(nextPacket)).toEqual(getExpectedAdditions(frames[SECOND_KEY_FRAME_INDEX + 1]));
                        expect(describePacketAdditions(firstPacket)).toEqual(getExpectedAdditions(frames[0]));
                    }
                );
            });

            it('reads them through the worker\'s input formats', async () => {
                await withVideoTrack(
                    readVP9HDR10PlusVector(vector.fileName),
                    CUSTOM_DECODE_INPUT_FORMATS,
                    async (track: InputVideoTrack): Promise<void> => {
                        const packets = await readPackets(track);

                        expect(packets.map(describePacketAdditions)).toEqual(VP9_HDR10_PLUS_EXPECTATIONS.frames.map(getExpectedAdditions));
                    }
                );
            });
        }
    );

    it('leaves alpha to its own side data and reads the other additions of a block in order, for each frame of a laced block', async () => {
        await withVideoTrack(createAlphaWebM(), ALL_FORMATS, async (track: InputVideoTrack): Promise<void> => {
            const packets: EncodedPacket[] = [];
            for await (const packet of new PacketCursor(track, { options: PLAIN_PACKET_OPTIONS })) {
                packets.push(packet);
            }

            expect(packets.map(packet => Array.from(packet.data))).toEqual([
                Array.from(KEY_FRAME_DATA),
                Array.from(INTER_FRAME_DATA),
                Array.from(FIRST_LACED_FRAME_DATA),
                Array.from(SECOND_LACED_FRAME_DATA)
            ]);
            expect(packets[0].sideData.alpha).toEqual(ALPHA_DATA);
            expect(describePacketAdditions(packets[0])).toEqual([
                [ ITU_T_T35_BLOCK_ADDITION_ID, Array.from(HDR10_PLUS_MESSAGE) ],
                [ OTHER_BLOCK_ADDITION_ID, Array.from(OTHER_PROVIDER_MESSAGE) ]
            ]);
            expect(packets[1].sideData.alpha).toBeUndefined();
            expect(readMatroskaBlockAdditions(packets[1])).toEqual([]);
            for (const lacedPacket of packets.slice(2)) {
                expect(describePacketAdditions(lacedPacket)).toEqual([ [ ITU_T_T35_BLOCK_ADDITION_ID, Array.from(HDR10_PLUS_MESSAGE) ] ]);
            }
        });
    });

    it('reads none from Matroska without additions and from another demuxer', async () => {
        for (const fileName of [ MATROSKA_WITHOUT_ADDITIONS_FILE_NAME, MP4_FILE_NAME ]) {
            await withVideoTrack(
                readDolbyVisionAV1Vector(fileName),
                ALL_FORMATS,
                async (track: InputVideoTrack): Promise<void> => {
                    const packets = await readPackets(track);

                    expect(packets.length).toBeGreaterThan(0);
                    for (const packet of packets) {
                        expect(readMatroskaBlockAdditions(packet)).toEqual([]);
                    }
                }
            );
        }
    });
});
