// @vitest-environment node

import {
    BufferSource,
    EncodedPacketSink,
    Input,
    type EncodedPacket
} from 'mediabunny';
import { describe, expect, it } from 'vitest';

import { microsecondsToSeconds, type Microseconds } from 'webgpu-player/MediaTime';
import { CUSTOM_DECODE_INPUT_FORMATS } from 'webgpu-player/pipeline/CustomDecodeInputFormats';
import { runOwnedVP9VideoStream } from 'webgpu-player/video/decoders/OwnedVP9VideoStream';
import type {
    OwnedVideoDecoderCallbacks,
    OwnedVideoDecoderPort
} from 'webgpu-player/video/decoders/OwnedVideoDecodeStream';
import {
    createMatroskaBlockAdditionReader,
    withMatroskaBlockAdditions,
    type MatroskaBlockAddition
} from 'webgpu-player/video/MatroskaBlockAdditions';
import { hasVP9ShownFrame } from 'webgpu-player/video/vp9/VP9FrameParser';

import { requirePostedHDR10PlusResult, type HDR10PlusVectorFrame } from '../../helpers/hdr10PlusVectors';
import {
    AMPLE_FRAME_CREDITS,
    FakeOwnedVideoDecoder,
    FakePacketIterator,
    FakeStreamRun,
    type PostedFrame
} from '../../helpers/ownedVideoStreamFakes';
import {
    readVP9HDR10PlusVector,
    VP9_HDR10_PLUS_EXPECTATIONS,
    type VP9HDR10PlusVector
} from '../../helpers/vp9HDR10PlusVectors';

type PlayedVector = {
    packets: EncodedPacket[]
    postedFrames: PostedFrame[]
};

// The worker's owned VP9 path reads packets with the same options
const OWNED_VP9_PACKET_OPTIONS = {
    metadataOnly: false,
    verifyKeyPackets: true
} as const;
const FRAMES = VP9_HDR10_PLUS_EXPECTATIONS.frames;
const SECOND_KEY_FRAME_INDEX = FRAMES.findIndex(
    (frame: HDR10PlusVectorFrame, frameIndex: number): boolean => frameIndex > 0 && frame.keyFrame
);
const VP9_PROFILE_2_CODEC_PREFIX = 'vp09.02.';
const BT2020_PQ_COLOR_SPACE = {
    fullRange: false,
    matrix: 'bt2020-ncl',
    primaries: 'bt2020',
    transfer: 'pq'
};

/** Plays a vector as the worker's owned VP9 path does, from the key packet at or before the start time, through a decoder that outputs every packet's frame. */
async function playVector(vector: VP9HDR10PlusVector, startTimeMicroseconds: Microseconds): Promise<PlayedVector> {
    const input = new Input({
        formats: withMatroskaBlockAdditions(CUSTOM_DECODE_INPUT_FORMATS),
        source: new BufferSource(readVP9HDR10PlusVector(vector.fileName))
    });
    try {
        const [ track ] = await input.getVideoTracks();
        const packetSink = new EncodedPacketSink(track);
        const keyPacket = await packetSink.getKeyPacket(microsecondsToSeconds(startTimeMicroseconds), OWNED_VP9_PACKET_OPTIONS)
            ?? await packetSink.getFirstKeyPacket(OWNED_VP9_PACKET_OPTIONS);
        if (!keyPacket) {
            throw new Error(`${vector.fileName} has no key packet`);
        }
        const packets: EncodedPacket[] = [];
        for await (const packet of packetSink.packets(keyPacket, undefined, OWNED_VP9_PACKET_OPTIONS)) {
            packets.push(packet);
        }

        const readBlockAdditions = createMatroskaBlockAdditionReader(track);
        const run = new FakeStreamRun(AMPLE_FRAME_CREDITS);
        await runOwnedVP9VideoStream(
            run,
            new FakePacketIterator(packets),
            (packet: EncodedPacket): Uint8Array[] => readBlockAdditions(packet).map(
                (addition: MatroskaBlockAddition): Uint8Array => addition.data
            ),
            (callbacks: OwnedVideoDecoderCallbacks): OwnedVideoDecoderPort => new FakeOwnedVideoDecoder(callbacks),
            startTimeMicroseconds,
            keyPacket.microsecondTimestamp as Microseconds
        );
        return { packets, postedFrames: run.postedFrames };
    } finally {
        input.dispose();
    }
}

describe('HDR10+ VP9 demux integration', () => {
    it('covers WebM without a BlockAdditionMapping and Matroska with one', () => {
        expect(VP9_HDR10_PLUS_EXPECTATIONS.vectors.map(vector => [ vector.container, vector.blockAdditionMapping ])).toEqual([
            [ 'webm', false ],
            [ 'matroska', true ]
        ]);
        expect(FRAMES.some(frame => frame.HDR10Plus === null)).toBe(true);
        expect(FRAMES.some(frame => frame.HDR10Plus?.bezierCurve === null && frame.HDR10Plus.targetedSystemDisplayMaximumLuminance === 0)).toBe(true);
    });

    describe.each(VP9_HDR10_PLUS_EXPECTATIONS.vectors.map(vector => [ vector.fileName, vector ] as const))(
        '%s',
        (_fileName: string, vector: VP9HDR10PlusVector) => {
            it('reads a VP9 Profile 2 BT.2020 PQ track', async () => {
                const input = new Input({
                    formats: withMatroskaBlockAdditions(CUSTOM_DECODE_INPUT_FORMATS),
                    source: new BufferSource(readVP9HDR10PlusVector(vector.fileName))
                });
                try {
                    const [ track ] = await input.getVideoTracks();

                    expect(await track.getCodec()).toBe('vp9');
                    expect((await track.getDecoderConfig())?.codec.startsWith(VP9_PROFILE_2_CODEC_PREFIX)).toBe(true);
                    expect(await track.getColorSpace()).toEqual(BT2020_PQ_COLOR_SPACE);
                    expect([ await track.getCodedWidth(), await track.getCodedHeight() ]).toEqual([
                        VP9_HDR10_PLUS_EXPECTATIONS.width,
                        VP9_HDR10_PLUS_EXPECTATIONS.height
                    ]);
                } finally {
                    input.dispose();
                }
            });

            it('gives every frame the HDR10+ the generator wrote beside it', async () => {
                const { packets, postedFrames } = await playVector(vector, 0 as Microseconds);

                expect(packets.map(packet => packet.type === 'key')).toEqual(FRAMES.map(frame => frame.keyFrame));
                // libvpx wrote every packet as one shown frame
                expect(packets.every(packet => hasVP9ShownFrame(packet.data))).toBe(true);
                expect(postedFrames.map(postedFrame => postedFrame.mediaTimeMicroseconds)).toEqual(
                    packets.map(packet => packet.microsecondTimestamp)
                );
                for (const [ frameIndex, postedFrame ] of postedFrames.entries()) {
                    requirePostedHDR10PlusResult(postedFrame.HDR10PlusMetadata, FRAMES[frameIndex]);
                }
            });

            it('starts a seek at the second key frame without metadata from before it', async () => {
                const { packets } = await playVector(vector, 0 as Microseconds);
                const secondKeyPacketTimestamp = packets[SECOND_KEY_FRAME_INDEX].microsecondTimestamp as Microseconds;

                const { postedFrames } = await playVector(vector, secondKeyPacketTimestamp);

                expect(postedFrames.map(postedFrame => postedFrame.mediaTimeMicroseconds)).toEqual(
                    packets.slice(SECOND_KEY_FRAME_INDEX).map(packet => packet.microsecondTimestamp)
                );
                for (const [ frameOffset, postedFrame ] of postedFrames.entries()) {
                    requirePostedHDR10PlusResult(postedFrame.HDR10PlusMetadata, FRAMES[SECOND_KEY_FRAME_INDEX + frameOffset]);
                }
                // A new attempt has no earlier metadata to carry, whether or not a frame without any takes the last
                expect(FRAMES[SECOND_KEY_FRAME_INDEX].HDR10Plus).toBeNull();
                expect(postedFrames[0].HDR10PlusMetadata).toEqual({ metadata: null, status: 'absent' });
            });
        }
    );
});
