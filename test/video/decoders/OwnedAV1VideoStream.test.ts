import type { EncodedPacket } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';
import { runOwnedAV1VideoStream } from 'webgpu-player/video/decoders/OwnedAV1VideoStream';
import type { DolbyVisionAV1RPUDataParser } from 'webgpu-player/video/dolby-vision/DolbyVisionEncodedMetadata';
import { parseHDR10PlusITUTT35Messages } from 'webgpu-player/video/hdr/HDR10PlusMetadata';
import { createDolbyVisionAuthorizationRPUVector } from 'webgpu-player/capability/vectors/DolbyVisionAuthorizationVector';

import { createAV1MetadataOBU, createAV1OBU } from '../../helpers/av1MetadataOBUs';
import { DOLBY_VISION_ITUT_T35_PAYLOAD_PREFIX } from '../../helpers/dolbyVisionAV1ITUTT35Payload';
import { getHDR10PlusITUTT35Messages } from '../../helpers/hdr10PlusVectors';
import {
    AMPLE_FRAME_CREDITS,
    FRAME_DURATION_MICROSECONDS,
    KEY_PACKET_MEDIA_TIME_MICROSECONDS,
    createFramePacket,
    createOwnedVideoStreamFakes,
    settle,
    type FakeDecoderOutputMode,
    type FakeOwnedVideoDecoder,
    type OwnedVideoStreamFakes
} from '../../helpers/ownedVideoStreamFakes';

const OBU_TYPE_SEQUENCE_HEADER = 1;
const OBU_TYPE_FRAME = 6;
const METADATA_TYPE_ITUT_T35 = 4;
// Two valid HDR10+ messages whose MaxSCL differs, from the deterministic HEVC vectors
const [ FIRST_HDR10_PLUS_MESSAGE, SECOND_HDR10_PLUS_MESSAGE ] = getHDR10PlusITUTT35Messages('conflicting');
const [ UNSUPPORTED_HDR10_PLUS_MESSAGE ] = getHDR10PlusITUTT35Messages('unsupported');
// Half the pair queue's bound of 16 frames
const DECODE_QUEUE_HIGH_WATER_MARK = 8;

type StreamHarness = OwnedVideoStreamFakes & {
    parsedRPUData: Map<number, ArrayBuffer>
    rpuParser: { parseAV1ITUTT35: ReturnType<typeof vi.fn> }
    start: (startTimeMicroseconds?: Microseconds, rpuParser?: DolbyVisionAV1RPUDataParser | null) => Promise<void>
};

// The decoded packets are compared as plain byte arrays
function createOBU(type: number, payload: readonly number[]): number[] {
    return Array.from(createAV1OBU(type, payload));
}

/**
 * Creates a temporal unit with a frame, or a sequence header instead, after an optional RPU carrying a tag byte and any HDR10+ messages.
 * The frame index sets the unit's timestamp, so units given out of index order arrive in decode order with reordered timestamps.
 */
function createTemporalUnit(
    frameIndex: number,
    rpuTag: number | null,
    hasFrame = true,
    HDR10PlusMessages: readonly Uint8Array[] = []
): EncodedPacket {
    const data = [
        ...(rpuTag === null ?
            [] :
            Array.from(createAV1MetadataOBU(METADATA_TYPE_ITUT_T35, [ ...DOLBY_VISION_ITUT_T35_PAYLOAD_PREFIX, rpuTag ]))),
        ...HDR10PlusMessages.flatMap((message: Uint8Array): number[] => Array.from(
            createAV1MetadataOBU(METADATA_TYPE_ITUT_T35, message)
        )),
        ...(hasFrame ? createOBU(OBU_TYPE_FRAME, [ frameIndex ]) : createOBU(OBU_TYPE_SEQUENCE_HEADER, [ 1 ]))
    ];
    return createFramePacket(frameIndex, data);
}

/** Runs the stream over the packets, with an RPU parser unless a start passes none. */
function createHarness(
    packets: readonly EncodedPacket[],
    credits: number,
    outputMode: FakeDecoderOutputMode = 'immediate',
    configureDecoder: (decoder: FakeOwnedVideoDecoder) => void = (): void => undefined
): StreamHarness {
    const fakes = createOwnedVideoStreamFakes(packets, credits, outputMode, configureDecoder);
    const parsedRPUData = new Map<number, ArrayBuffer>();
    const rpuParser = {
        // Each RPU parses to its own buffer, so a test can tell which frame received which RPU
        parseAV1ITUTT35: vi.fn(async (payload: Uint8Array): Promise<ArrayBuffer> => {
            const packedRPUData = createDolbyVisionAuthorizationRPUVector(8);
            parsedRPUData.set(payload[DOLBY_VISION_ITUT_T35_PAYLOAD_PREFIX.length], packedRPUData);
            return packedRPUData;
        })
    };
    return {
        ...fakes,
        parsedRPUData,
        rpuParser,
        start: (
            startTimeMicroseconds = KEY_PACKET_MEDIA_TIME_MICROSECONDS,
            startRPUParser: DolbyVisionAV1RPUDataParser | null = rpuParser
        ): Promise<void> => runOwnedAV1VideoStream(
            fakes.run,
            fakes.packetIterator,
            startRPUParser,
            fakes.createDecoder,
            startTimeMicroseconds,
            KEY_PACKET_MEDIA_TIME_MICROSECONDS
        )
    };
}

describe('runOwnedAV1VideoStream', () => {
    it('attaches each RPU to the frame of its temporal unit and decodes the stripped unit', async () => {
        const packets = [
            createTemporalUnit(0, 0x10),
            createTemporalUnit(1, 0x11),
            createTemporalUnit(2, null),
            createTemporalUnit(3, 0x13)
        ];
        const harness = createHarness(packets, AMPLE_FRAME_CREDITS);

        await harness.start();

        const decoder = harness.requireDecoder();
        expect(harness.run.postedFrames.map(postedFrame => postedFrame.mediaTimeMicroseconds)).toEqual([
            0,
            FRAME_DURATION_MICROSECONDS,
            2 * FRAME_DURATION_MICROSECONDS,
            3 * FRAME_DURATION_MICROSECONDS
        ]);
        const postedRPUData = harness.run.postedFrames.map(postedFrame => (
            postedFrame.encodedDolbyVisionMetadata?.parsedRPUData[0] ?? null
        ));
        expect(postedRPUData[0]).toBe(harness.parsedRPUData.get(0x10));
        expect(postedRPUData[1]).toBe(harness.parsedRPUData.get(0x11));
        expect(postedRPUData[2]).toBeNull();
        expect(postedRPUData[3]).toBe(harness.parsedRPUData.get(0x13));
        expect(harness.rpuParser.parseAV1ITUTT35.mock.calls.map(call => (
            (call[0] as Uint8Array)[DOLBY_VISION_ITUT_T35_PAYLOAD_PREFIX.length]
        ))).toEqual([ 0x10, 0x11, 0x13 ]);
        expect(decoder.decodedPackets.map(packet => Array.from(packet.data))).toEqual([
            createOBU(OBU_TYPE_FRAME, [ 0 ]),
            createOBU(OBU_TYPE_FRAME, [ 1 ]),
            createOBU(OBU_TYPE_FRAME, [ 2 ]),
            createOBU(OBU_TYPE_FRAME, [ 3 ])
        ]);
        expect(decoder.decodedPackets[2]).toBe(packets[2]);
        expect(decoder.decodedPackets[0]).toMatchObject({ sequenceNumber: 0, type: 'key' });
        for (const frame of decoder.frames) {
            expect(frame.close).toHaveBeenCalledOnce();
        }
        expect(decoder.init).toHaveBeenCalledOnce();
        expect(decoder.flush).toHaveBeenCalledOnce();
        expect(decoder.close).toHaveBeenCalledOnce();
        expect(harness.run.progress.slice(0, 3)).toEqual([
            [ 'video-decoder-ready', 0, 0 ],
            [ 'video-packet-started', 1, 0 ],
            [ 'video-packet-decoded', 1, 0 ]
        ]);
    });

    it('reads a packet only while it holds a frame credit', async () => {
        const harness = createHarness([
            createTemporalUnit(0, 0x20),
            createTemporalUnit(1, 0x21),
            createTemporalUnit(2, 0x22)
        ], 0);
        const streamPromise = harness.start();

        await settle();
        expect(harness.packetIterator.nextCallCount).toBe(0);
        harness.run.grantCredits(1);
        await settle();
        expect(harness.packetIterator.nextCallCount).toBe(1);
        expect(harness.run.postedFrames).toHaveLength(1);
        harness.run.grantCredits(1);
        await settle();
        expect(harness.packetIterator.nextCallCount).toBe(2);
        expect(harness.run.postedFrames).toHaveLength(2);
        // One credit posts the last frame and one reads the end of the track
        harness.run.grantCredits(2);
        await streamPromise;

        expect(harness.packetIterator.nextCallCount).toBe(4);
        expect(harness.run.postedFrames.map(postedFrame => (
            postedFrame.encodedDolbyVisionMetadata?.parsedRPUData[0]
        ))).toEqual([
            harness.parsedRPUData.get(0x20),
            harness.parsedRPUData.get(0x21),
            harness.parsedRPUData.get(0x22)
        ]);
    });

    it.each([
        {
            description: 'between two frames',
            expectedFrameIndices: [ 2, 3 ],
            startTimeMicroseconds: ((2 * FRAME_DURATION_MICROSECONDS) + 1) as Microseconds
        },
        {
            description: 'exactly on a frame',
            expectedFrameIndices: [ 1, 2, 3 ],
            startTimeMicroseconds: (2 * FRAME_DURATION_MICROSECONDS) as Microseconds
        }
    ])('drops frames before a start $description except the latest one', async ({
        expectedFrameIndices,
        startTimeMicroseconds
    }) => {
        const harness = createHarness([
            createTemporalUnit(0, 0x30),
            createTemporalUnit(1, 0x31),
            createTemporalUnit(2, 0x32),
            createTemporalUnit(3, 0x33)
        ], AMPLE_FRAME_CREDITS);

        await harness.start(startTimeMicroseconds);

        expect(harness.run.postedFrames.map(postedFrame => (
            postedFrame.mediaTimeMicroseconds / FRAME_DURATION_MICROSECONDS
        ))).toEqual(expectedFrameIndices);
        expect(harness.run.postedFrames.map(postedFrame => (
            postedFrame.encodedDolbyVisionMetadata?.parsedRPUData[0]
        ))).toEqual(expectedFrameIndices.map(frameIndex => harness.parsedRPUData.get(0x30 + frameIndex)));
        for (const frame of harness.requireDecoder().frames) {
            expect(frame.close).toHaveBeenCalledOnce();
        }
    });

    it('posts the frames a decoder holds until the end-of-track flush', async () => {
        const harness = createHarness([
            createTemporalUnit(0, 0x40),
            createTemporalUnit(1, 0x41),
            createTemporalUnit(2, 0x42)
        ], AMPLE_FRAME_CREDITS, 'held');

        await harness.start();

        expect(harness.requireDecoder().flush).toHaveBeenCalledOnce();
        expect(harness.run.postedFrames.map(postedFrame => (
            postedFrame.encodedDolbyVisionMetadata?.parsedRPUData[0]
        ))).toEqual([
            harness.parsedRPUData.get(0x40),
            harness.parsedRPUData.get(0x41),
            harness.parsedRPUData.get(0x42)
        ]);
    });

    it('waits for decoder progress while the decode queue is at its bound', async () => {
        const packets = Array.from(
            { length: DECODE_QUEUE_HIGH_WATER_MARK + 2 },
            (_value: unknown, frameIndex: number): EncodedPacket => createTemporalUnit(frameIndex, null)
        );
        const harness = createHarness(packets, AMPLE_FRAME_CREDITS, 'held');
        const streamPromise = harness.start();

        await settle();
        expect(harness.packetIterator.nextCallCount).toBe(DECODE_QUEUE_HIGH_WATER_MARK);
        harness.requireDecoder().releaseHeldFrames();
        await streamPromise;

        expect(harness.packetIterator.nextCallCount).toBe(packets.length + 1);
        expect(harness.run.postedFrames).toHaveLength(packets.length);
    });

    it.each([
        new DOMException('Decoding error.', 'EncodingError'),
        new DOMException('Codec reclaimed due to inactivity.', 'QuotaExceededError')
    ])('fails the attempt with decoder error $name and closes every frame', async codecError => {
        const harness = createHarness([
            createTemporalUnit(0, 0x50),
            createTemporalUnit(1, 0x51),
            createTemporalUnit(2, 0x52)
        ], AMPLE_FRAME_CREDITS, 'immediate', (decoder: FakeOwnedVideoDecoder): void => {
            decoder.failures.set(FRAME_DURATION_MICROSECONDS, codecError);
        });

        let streamError: unknown = null;
        try {
            await harness.start();
        } catch (error) {
            streamError = error;
        }

        // The worker resyncs a reclaimed decoder by the error's name, so the codec's own error must surface
        expect(streamError).toBe(codecError);
        const decoder = harness.requireDecoder();
        expect(decoder.close).toHaveBeenCalledOnce();
        expect(harness.run.postedFrames).toHaveLength(1);
        for (const frame of decoder.frames) {
            expect(frame.close).toHaveBeenCalledOnce();
        }
    });

    it('rejects a decoder that ends without the frame of one of its units', async () => {
        const harness = createHarness([
            createTemporalUnit(0, 0x60),
            createTemporalUnit(1, 0x61),
            createTemporalUnit(2, 0x62)
        ], AMPLE_FRAME_CREDITS, 'immediate', (decoder: FakeOwnedVideoDecoder): void => {
            decoder.droppedTimestamps.add(FRAME_DURATION_MICROSECONDS);
        });

        await expect(harness.start()).rejects.toThrow(
            'The AV1 decoder ended before every metadata entry was matched'
        );
        expect(harness.run.postedFrames.map(postedFrame => (
            postedFrame.encodedDolbyVisionMetadata?.parsedRPUData[0]
        ))).toEqual([
            harness.parsedRPUData.get(0x60),
            harness.parsedRPUData.get(0x62)
        ]);
        expect(harness.requireDecoder().close).toHaveBeenCalledOnce();
    });

    it('rejects an RPU whose temporal unit has no frame', async () => {
        const harness = createHarness([
            createTemporalUnit(0, 0x70),
            createTemporalUnit(1, 0x71, false)
        ], AMPLE_FRAME_CREDITS);

        await expect(harness.start()).rejects.toThrow('not paired with an AV1 frame');
        expect(harness.requireDecoder().decodedPackets).toHaveLength(1);
        expect(harness.requireDecoder().close).toHaveBeenCalledOnce();
    });

    it('attaches each unit\'s HDR10+ result to its own frame when the decoder reorders frames', async () => {
        // Decode order 0, 2, 1, 3: the unit of frame 2 precedes the unit of frame 1
        const harness = createHarness([
            createTemporalUnit(0, null, true, [ FIRST_HDR10_PLUS_MESSAGE ]),
            createTemporalUnit(2, null, true, [ SECOND_HDR10_PLUS_MESSAGE ]),
            createTemporalUnit(1, null),
            createTemporalUnit(3, null, true, [ UNSUPPORTED_HDR10_PLUS_MESSAGE ])
        ], AMPLE_FRAME_CREDITS, 'presentation-order');

        await harness.start();

        const postedFrames = harness.run.postedFrames;
        expect(postedFrames.map(postedFrame => postedFrame.mediaTimeMicroseconds / FRAME_DURATION_MICROSECONDS)).toEqual([
            0,
            1,
            2,
            3
        ]);
        expect(postedFrames.map(postedFrame => postedFrame.HDR10PlusMetadata?.status)).toEqual([
            'valid',
            'absent',
            'valid',
            'unsupported'
        ]);
        expect(postedFrames[0].HDR10PlusMetadata).toEqual(parseHDR10PlusITUTT35Messages([ FIRST_HDR10_PLUS_MESSAGE ]));
        expect(postedFrames[2].HDR10PlusMetadata).toEqual(parseHDR10PlusITUTT35Messages([ SECOND_HDR10_PLUS_MESSAGE ]));
        expect(postedFrames[3].HDR10PlusMetadata?.metadata).toBeNull();
        expect(postedFrames[0].HDR10PlusMetadata?.metadata).not.toEqual(postedFrames[2].HDR10PlusMetadata?.metadata);
        expect(postedFrames.map(postedFrame => postedFrame.encodedDolbyVisionMetadata)).toEqual([ null, null, null, null ]);
    });

    it('carries the Dolby Vision RPU and the HDR10+ metadata of one unit to its frame together', async () => {
        const packets = [
            createTemporalUnit(0, 0x90, true, [ FIRST_HDR10_PLUS_MESSAGE ]),
            createTemporalUnit(1, 0x91, true, [ SECOND_HDR10_PLUS_MESSAGE ])
        ];
        const harness = createHarness(packets, AMPLE_FRAME_CREDITS, 'held');

        await harness.start();

        const postedFrames = harness.run.postedFrames;
        expect(postedFrames.map(postedFrame => postedFrame.encodedDolbyVisionMetadata?.parsedRPUData[0])).toEqual([
            harness.parsedRPUData.get(0x90),
            harness.parsedRPUData.get(0x91)
        ]);
        expect(postedFrames.map(postedFrame => postedFrame.HDR10PlusMetadata)).toEqual([
            parseHDR10PlusITUTT35Messages([ FIRST_HDR10_PLUS_MESSAGE ]),
            parseHDR10PlusITUTT35Messages([ SECOND_HDR10_PLUS_MESSAGE ])
        ]);
        // Only the RPU leaves the unit; the HDR10+ OBU reaches the decoder untouched
        expect(harness.requireDecoder().decodedPackets.map(packet => Array.from(packet.data))).toEqual([
            [ ...createAV1MetadataOBU(METADATA_TYPE_ITUT_T35, FIRST_HDR10_PLUS_MESSAGE), ...createOBU(OBU_TYPE_FRAME, [ 0 ]) ],
            [ ...createAV1MetadataOBU(METADATA_TYPE_ITUT_T35, SECOND_HDR10_PLUS_MESSAGE), ...createOBU(OBU_TYPE_FRAME, [ 1 ]) ]
        ]);
    });

    it('strips RPUs without parsing them when no RPU parser is given, and still reads HDR10+', async () => {
        const harness = createHarness([
            createTemporalUnit(0, 0xA0, true, [ FIRST_HDR10_PLUS_MESSAGE ]),
            createTemporalUnit(1, 0xA1)
        ], AMPLE_FRAME_CREDITS);

        await harness.start(KEY_PACKET_MEDIA_TIME_MICROSECONDS, null);

        expect(harness.rpuParser.parseAV1ITUTT35).not.toHaveBeenCalled();
        expect(harness.run.postedFrames.map(postedFrame => postedFrame.encodedDolbyVisionMetadata)).toEqual([ null, null ]);
        expect(harness.run.postedFrames.map(postedFrame => postedFrame.HDR10PlusMetadata?.status)).toEqual([ 'valid', 'absent' ]);
        expect(harness.run.postedFrames[0].HDR10PlusMetadata).toEqual(parseHDR10PlusITUTT35Messages([ FIRST_HDR10_PLUS_MESSAGE ]));
        expect(harness.requireDecoder().decodedPackets.map(packet => Array.from(packet.data))).toEqual([
            [ ...createAV1MetadataOBU(METADATA_TYPE_ITUT_T35, FIRST_HDR10_PLUS_MESSAGE), ...createOBU(OBU_TYPE_FRAME, [ 0 ]) ],
            createOBU(OBU_TYPE_FRAME, [ 1 ])
        ]);
    });

    it('records no HDR10+ entry for a unit without a frame', async () => {
        const harness = createHarness([
            createTemporalUnit(0, null, true, [ FIRST_HDR10_PLUS_MESSAGE ]),
            createTemporalUnit(1, null, false, [ SECOND_HDR10_PLUS_MESSAGE ]),
            createTemporalUnit(2, null, true, [ SECOND_HDR10_PLUS_MESSAGE ])
        ], AMPLE_FRAME_CREDITS, 'immediate', (decoder: FakeOwnedVideoDecoder): void => {
            // The unit without a frame decodes to no frame
            decoder.droppedTimestamps.add(FRAME_DURATION_MICROSECONDS);
        });

        await harness.start();

        expect(harness.run.postedFrames.map(postedFrame => postedFrame.mediaTimeMicroseconds)).toEqual([
            0,
            2 * FRAME_DURATION_MICROSECONDS
        ]);
        expect(harness.run.postedFrames.map(postedFrame => postedFrame.HDR10PlusMetadata)).toEqual([
            parseHDR10PlusITUTT35Messages([ FIRST_HDR10_PLUS_MESSAGE ]),
            parseHDR10PlusITUTT35Messages([ SECOND_HDR10_PLUS_MESSAGE ])
        ]);
    });

    it('closes the frames it still holds when the attempt stops', async () => {
        const harness = createHarness([
            createTemporalUnit(0, 0x80),
            createTemporalUnit(1, 0x81),
            createTemporalUnit(2, 0x82)
        ], 1, 'held');
        const streamPromise = harness.start();

        await settle();
        expect(harness.run.postedFrames).toHaveLength(1);
        harness.run.stop();
        await streamPromise;

        const decoder = harness.requireDecoder();
        expect(decoder.frames).toHaveLength(3);
        for (const frame of decoder.frames) {
            expect(frame.close).toHaveBeenCalledOnce();
        }
        expect(decoder.close).toHaveBeenCalledOnce();
    });
});
