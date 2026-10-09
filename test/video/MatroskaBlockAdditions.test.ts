// @vitest-environment node

import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../helpers/enginePaths';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    ALL_FORMATS,
    BufferSource,
    EncodedPacket,
    EncodedPacketSink,
    Input,
    MATROSKA,
    MatroskaInputFormat,
    WEBM,
    WebMInputFormat,
    type InputFormat,
    type InputVideoTrack
} from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import { CUSTOM_DECODE_INPUT_FORMATS } from 'webgpu-player/pipeline/CustomDecodeInputFormats';
import {
    createMatroskaBlockAdditionReader,
    withMatroskaBlockAdditions,
    type MatroskaBlockAddition
} from 'webgpu-player/video/MatroskaBlockAdditions';

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

type HookModule = typeof import('webgpu-player/video/MatroskaBlockAdditions');
type MediabunnyModule = typeof import('mediabunny');
type FreshModules = {
    hook: HookModule
    mediabunny: MediabunnyModule
};
type DemuxerFactory = (input: unknown) => Record<string, unknown>;

// The worker's owned VP9 path reads packets with the same options
const OWNED_VP9_PACKET_OPTIONS = {
    metadataOnly: false,
    verifyKeyPackets: true
} as const;
const PLAIN_PACKET_OPTIONS = { metadataOnly: false } as const;
const VECTORS = VP9_HDR10_PLUS_EXPECTATIONS.vectors;
const WEBM_VECTOR_FILE_NAME = 'hdr10plus.webm';
const SECOND_KEY_FRAME_INDEX = VP9_HDR10_PLUS_EXPECTATIONS.frames.findIndex(
    (frame: HDR10PlusVectorFrame, frameIndex: number): boolean => frameIndex > 0 && frame.keyFrame
);
// Halfway into the frame after the second key frame, so the key packet lookup lands on the second key frame
const SECOND_GROUP_SEEK_SECONDS = (SECOND_KEY_FRAME_INDEX + 1.5) / VP9_HDR10_PLUS_EXPECTATIONS.frameRate;
const DOLBY_VISION_AV1_VECTOR_DIRECTORY = resolve(CODEC_VECTOR_ASSETS_DIRECTORY, 'dolby-vision-av1');
// Matroska with a BlockAdditionMapping but no block additions, and an MP4 of the same stream
const MATROSKA_WITHOUT_ADDITIONS_FILE_NAME = 'profile10.1.mkv';
const MP4_FILE_NAME = 'profile10.1.mp4';
const UNAVAILABLE_WARNING_PATTERN = /BlockAdditional side data, HDR10\+ included, is unavailable/;

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
    for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, OWNED_VP9_PACKET_OPTIONS)) {
        packets.push(packet);
    }
    return packets;
}

function describeAdditions(additions: readonly MatroskaBlockAddition[]): Array<[ number, number[] ]> {
    return additions.map((addition: MatroskaBlockAddition): [ number, number[] ] => [ addition.addID, Array.from(addition.data) ]);
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

/** Imports the hook module afresh, so its one warning is still unspent, with the Mediabunny it binds to. */
async function importFreshModules(): Promise<FreshModules> {
    vi.resetModules();
    const mediabunny = await import('mediabunny');
    const hook = await import('webgpu-player/video/MatroskaBlockAdditions');
    return { hook, mediabunny };
}

function getDemuxerFactory(format: InputFormat): DemuxerFactory {
    return (format as unknown as { _createDemuxer: DemuxerFactory })._createDemuxer;
}

describe('withMatroskaBlockAdditions', () => {
    it('replaces Matroska and WebM in their places with formats that detect and name as Mediabunny\'s', () => {
        const formats = withMatroskaBlockAdditions(ALL_FORMATS);

        expect(formats).toHaveLength(ALL_FORMATS.length);
        for (const [ formatIndex, format ] of formats.entries()) {
            const mediabunnyFormat = ALL_FORMATS[formatIndex];
            if (mediabunnyFormat !== MATROSKA && mediabunnyFormat !== WEBM) {
                expect(format).toBe(mediabunnyFormat);
                continue;
            }
            expect(format).not.toBe(mediabunnyFormat);
            expect(Object.getPrototypeOf(format)).toBe(mediabunnyFormat);
            expect([ format.name, format.mimeType ]).toEqual([ mediabunnyFormat.name, mediabunnyFormat.mimeType ]);
        }
        expect(formats[ALL_FORMATS.indexOf(MATROSKA)]).toBeInstanceOf(MatroskaInputFormat);
        expect(formats[ALL_FORMATS.indexOf(WEBM)]).toBeInstanceOf(WebMInputFormat);
    });

    describe.each(VECTORS.map((vector: VP9HDR10PlusVector) => [ vector.fileName, vector ] as const))(
        'over %s',
        (_fileName: string, vector: VP9HDR10PlusVector) => {
            it('reads each packet\'s ITU-T T.35 BlockAdditional, as the generator wrote it', async () => {
                const warning = vi.spyOn(console, 'warn');
                await withVideoTrack(
                    readVP9HDR10PlusVector(vector.fileName),
                    withMatroskaBlockAdditions(ALL_FORMATS),
                    async (track: InputVideoTrack, input: Input): Promise<void> => {
                        expect((await input.getFormat()).name).toBe(vector.container === 'webm' ? WEBM.name : MATROSKA.name);
                        const readBlockAdditions = createMatroskaBlockAdditionReader(track);
                        const packets = await readPackets(track);

                        expect(packets.map(packet => packet.type === 'key')).toEqual(
                            VP9_HDR10_PLUS_EXPECTATIONS.frames.map(frame => frame.keyFrame)
                        );
                        expect(packets.map(packet => describeAdditions(readBlockAdditions(packet)))).toEqual(
                            VP9_HDR10_PLUS_EXPECTATIONS.frames.map(getExpectedAdditions)
                        );
                    }
                );
                expect(warning).not.toHaveBeenCalled();
            });

            it('reads the packets a seek reaches, and a cluster parsed again', async () => {
                const frames = VP9_HDR10_PLUS_EXPECTATIONS.frames;
                await withVideoTrack(
                    readVP9HDR10PlusVector(vector.fileName),
                    withMatroskaBlockAdditions(ALL_FORMATS),
                    async (track: InputVideoTrack): Promise<void> => {
                        const readBlockAdditions = createMatroskaBlockAdditionReader(track);
                        const packetSink = new EncodedPacketSink(track);
                        const keyPacket = await packetSink.getKeyPacket(SECOND_GROUP_SEEK_SECONDS, OWNED_VP9_PACKET_OPTIONS);
                        if (!keyPacket) {
                            throw new Error('The vector has no key packet in its second group');
                        }
                        const nextPacket = await packetSink.getNextPacket(keyPacket, OWNED_VP9_PACKET_OPTIONS);
                        // Mediabunny keeps one parsed cluster, so the first packet parses the first cluster again
                        const firstPacket = await packetSink.getFirstPacket(OWNED_VP9_PACKET_OPTIONS);

                        expect(describeAdditions(readBlockAdditions(keyPacket))).toEqual(getExpectedAdditions(frames[SECOND_KEY_FRAME_INDEX]));
                        expect(nextPacket && describeAdditions(readBlockAdditions(nextPacket))).toEqual(
                            getExpectedAdditions(frames[SECOND_KEY_FRAME_INDEX + 1])
                        );
                        expect(firstPacket && describeAdditions(readBlockAdditions(firstPacket))).toEqual(getExpectedAdditions(frames[0]));
                    }
                );
            });

            it('composes with the worker\'s laced-block content decoding', async () => {
                await withVideoTrack(
                    readVP9HDR10PlusVector(vector.fileName),
                    withMatroskaBlockAdditions(CUSTOM_DECODE_INPUT_FORMATS),
                    async (track: InputVideoTrack): Promise<void> => {
                        const readBlockAdditions = createMatroskaBlockAdditionReader(track);
                        const packets = await readPackets(track);

                        expect(packets.map(packet => describeAdditions(readBlockAdditions(packet)))).toEqual(
                            VP9_HDR10_PLUS_EXPECTATIONS.frames.map(getExpectedAdditions)
                        );
                    }
                );
            });
        }
    );

    it('leaves alpha to Mediabunny and reads the other additions of the same block in order', async () => {
        const warning = vi.spyOn(console, 'warn');
        await withVideoTrack(createAlphaWebM(), withMatroskaBlockAdditions(ALL_FORMATS), async (track: InputVideoTrack): Promise<void> => {
            const readBlockAdditions = createMatroskaBlockAdditionReader(track);
            const packets: EncodedPacket[] = [];
            for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, PLAIN_PACKET_OPTIONS)) {
                packets.push(packet);
            }

            expect(packets.map(packet => Array.from(packet.data))).toEqual([
                Array.from(KEY_FRAME_DATA),
                Array.from(INTER_FRAME_DATA),
                Array.from(FIRST_LACED_FRAME_DATA),
                Array.from(SECOND_LACED_FRAME_DATA)
            ]);
            expect(packets[0].sideData.alpha).toEqual(ALPHA_DATA);
            expect(describeAdditions(readBlockAdditions(packets[0]))).toEqual([
                [ ITU_T_T35_BLOCK_ADDITION_ID, Array.from(HDR10_PLUS_MESSAGE) ],
                [ OTHER_BLOCK_ADDITION_ID, Array.from(OTHER_PROVIDER_MESSAGE) ]
            ]);
            expect(packets[1].sideData.alpha).toBeUndefined();
            expect(readBlockAdditions(packets[1])).toEqual([]);
            // Mediabunny replaces a laced block with new blocks, one per frame, so its additions are not read
            expect(readBlockAdditions(packets[2])).toEqual([]);
            expect(readBlockAdditions(packets[3])).toEqual([]);
        });
        expect(warning).not.toHaveBeenCalled();
    });

    it('reads none, without a warning, from Matroska without additions and from another demuxer', async () => {
        const warning = vi.spyOn(console, 'warn');
        for (const fileName of [ MATROSKA_WITHOUT_ADDITIONS_FILE_NAME, MP4_FILE_NAME ]) {
            await withVideoTrack(
                readDolbyVisionAV1Vector(fileName),
                withMatroskaBlockAdditions(ALL_FORMATS),
                async (track: InputVideoTrack): Promise<void> => {
                    const readBlockAdditions = createMatroskaBlockAdditionReader(track);
                    const packets = await readPackets(track);

                    expect(packets.length).toBeGreaterThan(0);
                    for (const packet of packets) {
                        expect(readBlockAdditions(packet)).toEqual([]);
                    }
                }
            );
        }
        expect(warning).not.toHaveBeenCalled();
    });
});

describe('MatroskaBlockAdditions when Mediabunny\'s internals differ', () => {
    it('keeps a format without a demuxer factory, with one warning', async () => {
        const { hook, mediabunny } = await importFreshModules();
        const warning = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        const formatWithoutFactory = Object.create(mediabunny.MATROSKA, {
            _createDemuxer: { value: undefined }
        }) as InputFormat;

        expect(hook.withMatroskaBlockAdditions([ formatWithoutFactory ])).toEqual([ formatWithoutFactory ]);
        expect(hook.withMatroskaBlockAdditions([ formatWithoutFactory ])[0]).toBe(formatWithoutFactory);
        expect(warning).toHaveBeenCalledOnce();
        expect(warning).toHaveBeenCalledWith(expect.stringMatching(UNAVAILABLE_WARNING_PATTERN));
    });

    it('leaves a demuxer whose fields differ untouched and its packets unchanged, with one warning', async () => {
        const { hook, mediabunny } = await importFreshModules();
        const warning = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        const createWebMDemuxer = getDemuxerFactory(mediabunny.WEBM);
        // As if Mediabunny renamed the field
        const renamedFieldFormat = Object.create(mediabunny.WEBM, {
            _createDemuxer: {
                value: (input: unknown): unknown => {
                    const demuxer = createWebMDemuxer.call(mediabunny.WEBM, input);
                    delete demuxer.currentBlockAdditional;
                    return demuxer;
                }
            }
        }) as InputFormat;
        const input = new mediabunny.Input({
            formats: hook.withMatroskaBlockAdditions([ renamedFieldFormat ]),
            source: new mediabunny.BufferSource(readVP9HDR10PlusVector(WEBM_VECTOR_FILE_NAME))
        });
        try {
            const [ track ] = await input.getVideoTracks();
            const readBlockAdditions = hook.createMatroskaBlockAdditionReader(track);
            const packetData: number[][] = [];
            for await (const packet of new mediabunny.EncodedPacketSink(track).packets(undefined, undefined, PLAIN_PACKET_OPTIONS)) {
                expect(readBlockAdditions(packet)).toEqual([]);
                packetData.push(Array.from(packet.data));
            }

            expect(packetData).toHaveLength(VP9_HDR10_PLUS_EXPECTATIONS.frameCount);
        } finally {
            input.dispose();
        }
        expect(warning).toHaveBeenCalledOnce();
    });

    it('reads none for a packet the track did not return or a track backing that differs, with one warning in all', async () => {
        const { hook, mediabunny } = await importFreshModules();
        const warning = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        const input = new mediabunny.Input({
            formats: hook.withMatroskaBlockAdditions(mediabunny.ALL_FORMATS),
            source: new mediabunny.BufferSource(readVP9HDR10PlusVector(WEBM_VECTOR_FILE_NAME))
        });
        try {
            const [ track ] = await input.getVideoTracks();
            const readBlockAdditions = hook.createMatroskaBlockAdditionReader(track);
            const foreignPacket = new mediabunny.EncodedPacket(KEY_FRAME_DATA, 'key', 0, 1);
            const backing = (track as unknown as { _backing: { internalTrack: unknown } })._backing;
            const trackWithChangedBacking = {
                _backing: { internalTrack: backing.internalTrack, packetToClusterLocation: new Map() }
            } as unknown as InputVideoTrack;

            expect(readBlockAdditions(foreignPacket)).toEqual([]);
            expect(warning).toHaveBeenCalledOnce();
            expect(hook.createMatroskaBlockAdditionReader(trackWithChangedBacking)(foreignPacket)).toEqual([]);
        } finally {
            input.dispose();
        }
        expect(warning).toHaveBeenCalledOnce();
    });

    it('warns about a track backing that differs', async () => {
        const { hook, mediabunny } = await importFreshModules();
        const warning = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        const input = new mediabunny.Input({
            formats: hook.withMatroskaBlockAdditions(mediabunny.ALL_FORMATS),
            source: new mediabunny.BufferSource(readVP9HDR10PlusVector(WEBM_VECTOR_FILE_NAME))
        });
        try {
            const [ track ] = await input.getVideoTracks();
            const backing = (track as unknown as { _backing: { internalTrack: unknown } })._backing;
            const trackWithChangedBacking = {
                _backing: { internalTrack: backing.internalTrack, packetToClusterLocation: new Map() }
            } as unknown as InputVideoTrack;

            const readBlockAdditions = hook.createMatroskaBlockAdditionReader(trackWithChangedBacking);

            expect(warning).toHaveBeenCalledOnce();
            expect(readBlockAdditions(new mediabunny.EncodedPacket(KEY_FRAME_DATA, 'key', 0, 1))).toEqual([]);
        } finally {
            input.dispose();
        }
    });
});
