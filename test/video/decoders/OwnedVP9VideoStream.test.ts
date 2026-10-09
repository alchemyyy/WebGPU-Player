import type { EncodedPacket } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';
import { runOwnedVP9VideoStream } from 'webgpu-player/video/decoders/OwnedVP9VideoStream';

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

// The targeted display of the profile B vector, and profile A's
const PROFILE_B_TARGETED_DISPLAY_NITS = 1_000;
const PROFILE_A_TARGETED_DISPLAY_NITS = 0;
// An ITU-T T.35 message of another provider: United States, Dolby
const OTHER_PROVIDER_MESSAGE = new Uint8Array([ 0xB5, 0x00, 0x3B, 0x00, 0x00, 0x08, 0x00 ]);
// First uncompressed_header() bytes of Profile 0 frames
const SHOWN_KEY_FRAME_HEADER = 0x82;
const SHOWN_INTER_FRAME_HEADER = 0x86;
const HIDDEN_INTER_FRAME_HEADER = 0x84;
// A superframe index of two frames with one-byte sizes
const TWO_FRAME_SUPERFRAME_MARKER = 0xC1;

type TestPacket = {
    messages: readonly Uint8Array[]
    packet: EncodedPacket
};

type StreamHarness = OwnedVideoStreamFakes & {
    readPacketSideData: ReturnType<typeof vi.fn>
    start: (startTimeMicroseconds?: Microseconds) => Promise<void>
};

function createPacket(frameIndex: number, data: readonly number[], messages: readonly Uint8Array[] = []): TestPacket {
    return { messages, packet: createFramePacket(frameIndex, data) };
}

function createShownPacket(frameIndex: number, messages: readonly Uint8Array[] = []): TestPacket {
    return createPacket(frameIndex, [ frameIndex === 0 ? SHOWN_KEY_FRAME_HEADER : SHOWN_INTER_FRAME_HEADER, frameIndex ], messages);
}

/** Runs the stream over the packets, with a side data reader that returns each packet's messages. */
function createHarness(
    testPackets: readonly TestPacket[],
    credits: number,
    outputMode: FakeDecoderOutputMode = 'immediate',
    configureDecoder: (decoder: FakeOwnedVideoDecoder) => void = (): void => undefined
): StreamHarness {
    const messagesByPacket = new Map<EncodedPacket, readonly Uint8Array[]>();
    for (const testPacket of testPackets) {
        messagesByPacket.set(testPacket.packet, testPacket.messages);
    }
    const fakes = createOwnedVideoStreamFakes(
        testPackets.map(testPacket => testPacket.packet),
        credits,
        outputMode,
        configureDecoder
    );
    const readPacketSideData = vi.fn((packet: EncodedPacket): readonly Uint8Array[] => messagesByPacket.get(packet) ?? []);
    return {
        ...fakes,
        readPacketSideData,
        start: (startTimeMicroseconds = KEY_PACKET_MEDIA_TIME_MICROSECONDS): Promise<void> => runOwnedVP9VideoStream(
            fakes.run,
            fakes.packetIterator,
            readPacketSideData,
            fakes.createDecoder,
            startTimeMicroseconds,
            KEY_PACKET_MEDIA_TIME_MICROSECONDS
        )
    };
}

function getPostedFrameIndices(harness: StreamHarness): number[] {
    return harness.run.postedFrames.map(postedFrame => postedFrame.mediaTimeMicroseconds / FRAME_DURATION_MICROSECONDS);
}

function getPostedStatuses(harness: StreamHarness): Array<string | undefined> {
    return harness.run.postedFrames.map(postedFrame => postedFrame.HDR10PlusMetadata?.status);
}

function getPostedTargetedDisplayNits(harness: StreamHarness): Array<number | undefined> {
    return harness.run.postedFrames.map(postedFrame => (
        postedFrame.HDR10PlusMetadata?.metadata?.targetedSystemDisplayMaximumLuminanceNits
    ));
}

describe('runOwnedVP9VideoStream', () => {
    it('gives each frame the HDR10+ result of its packet\'s side data and decodes every packet unchanged', async () => {
        const testPackets = [
            createShownPacket(0, getHDR10PlusITUTT35Messages('valid')),
            createShownPacket(1),
            createShownPacket(2, getHDR10PlusITUTT35Messages('profile-a')),
            createShownPacket(3, getHDR10PlusITUTT35Messages('malformed')),
            createShownPacket(4, getHDR10PlusITUTT35Messages('unsupported')),
            createShownPacket(5, getHDR10PlusITUTT35Messages('conflicting')),
            createShownPacket(6, [ OTHER_PROVIDER_MESSAGE ])
        ];
        const harness = createHarness(testPackets, AMPLE_FRAME_CREDITS);

        await harness.start();

        const decoder = harness.requireDecoder();
        expect(getPostedFrameIndices(harness)).toEqual([ 0, 1, 2, 3, 4, 5, 6 ]);
        expect(getPostedStatuses(harness)).toEqual([
            'valid',
            'absent',
            'valid',
            'malformed',
            'unsupported',
            'conflicting',
            // Another provider's message is not HDR10+
            'absent'
        ]);
        const postedMetadata = harness.run.postedFrames.map(postedFrame => postedFrame.HDR10PlusMetadata?.metadata);
        expect(postedMetadata[0]?.targetedSystemDisplayMaximumLuminanceNits).toBe(PROFILE_B_TARGETED_DISPLAY_NITS);
        expect(postedMetadata[0]?.toneMapping).not.toBeNull();
        expect(postedMetadata[2]?.targetedSystemDisplayMaximumLuminanceNits).toBe(PROFILE_A_TARGETED_DISPLAY_NITS);
        expect(postedMetadata[2]?.toneMapping).toBeNull();
        expect(postedMetadata[4]).toBeNull();
        expect(postedMetadata[5]).toBeNull();
        expect(harness.run.postedFrames.map(postedFrame => postedFrame.encodedDolbyVisionMetadata)).toEqual(
            testPackets.map((): null => null)
        );
        for (const [ packetIndex, decodedPacket ] of decoder.decodedPackets.entries()) {
            expect(decodedPacket).toBe(testPackets[packetIndex].packet);
        }
        expect(decoder.decodedPackets).toHaveLength(testPackets.length);
        // Each packet's side data is read once, in decode order
        expect(harness.readPacketSideData.mock.calls.map(call => call[0])).toEqual(testPackets.map(testPacket => testPacket.packet));
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

    it('matches frames a decoder holds until the end-of-track flush', async () => {
        const harness = createHarness([
            createShownPacket(0, getHDR10PlusITUTT35Messages('valid')),
            createShownPacket(1, getHDR10PlusITUTT35Messages('profile-a')),
            createShownPacket(2)
        ], AMPLE_FRAME_CREDITS, 'held');

        await harness.start();

        expect(harness.requireDecoder().flush).toHaveBeenCalledOnce();
        expect(getPostedStatuses(harness)).toEqual([ 'valid', 'valid', 'absent' ]);
        expect(getPostedTargetedDisplayNits(harness).slice(0, 2)).toEqual([
            PROFILE_B_TARGETED_DISPLAY_NITS,
            PROFILE_A_TARGETED_DISPLAY_NITS
        ]);
    });

    it('records nothing for a packet of hidden frames alone, which outputs no frame', async () => {
        const hiddenPacket = createPacket(1, [ HIDDEN_INTER_FRAME_HEADER, 1 ], getHDR10PlusITUTT35Messages('valid'));
        const harness = createHarness([
            createShownPacket(0, getHDR10PlusITUTT35Messages('profile-a')),
            hiddenPacket,
            createShownPacket(2, getHDR10PlusITUTT35Messages('valid'))
        ], AMPLE_FRAME_CREDITS, 'immediate', (decoder: FakeOwnedVideoDecoder): void => {
            decoder.droppedTimestamps.add(hiddenPacket.packet.microsecondTimestamp);
        });

        await harness.start();

        expect(getPostedFrameIndices(harness)).toEqual([ 0, 2 ]);
        expect(getPostedTargetedDisplayNits(harness)).toEqual([ PROFILE_A_TARGETED_DISPLAY_NITS, PROFILE_B_TARGETED_DISPLAY_NITS ]);
        expect(harness.requireDecoder().decodedPackets).toContain(hiddenPacket.packet);
        expect(harness.readPacketSideData).not.toHaveBeenCalledWith(hiddenPacket.packet);
    });

    it('gives a superframe of a hidden frame and a shown frame one entry for its one frame', async () => {
        const hiddenFrame = [ HIDDEN_INTER_FRAME_HEADER, 0x11 ];
        const shownFrame = [ SHOWN_INTER_FRAME_HEADER, 0x22, 0x33 ];
        const superframe = createPacket(1, [
            ...hiddenFrame,
            ...shownFrame,
            TWO_FRAME_SUPERFRAME_MARKER,
            hiddenFrame.length,
            shownFrame.length,
            TWO_FRAME_SUPERFRAME_MARKER
        ], getHDR10PlusITUTT35Messages('profile-a'));
        const harness = createHarness([ createShownPacket(0, getHDR10PlusITUTT35Messages('valid')), superframe ], AMPLE_FRAME_CREDITS);

        await harness.start();

        expect(getPostedFrameIndices(harness)).toEqual([ 0, 1 ]);
        expect(getPostedTargetedDisplayNits(harness)).toEqual([ PROFILE_B_TARGETED_DISPLAY_NITS, PROFILE_A_TARGETED_DISPLAY_NITS ]);
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
            createShownPacket(0, getHDR10PlusITUTT35Messages('valid')),
            createShownPacket(1, getHDR10PlusITUTT35Messages('profile-a')),
            createShownPacket(2, getHDR10PlusITUTT35Messages('valid')),
            createShownPacket(3, getHDR10PlusITUTT35Messages('profile-a'))
        ], AMPLE_FRAME_CREDITS);

        await harness.start(startTimeMicroseconds);

        expect(getPostedFrameIndices(harness)).toEqual(expectedFrameIndices);
        expect(getPostedTargetedDisplayNits(harness)).toEqual(expectedFrameIndices.map(frameIndex => (
            frameIndex % 2 === 0 ? PROFILE_B_TARGETED_DISPLAY_NITS : PROFILE_A_TARGETED_DISPLAY_NITS
        )));
        for (const frame of harness.requireDecoder().frames) {
            expect(frame.close).toHaveBeenCalledOnce();
        }
    });

    it.each([
        new DOMException('Decoding error.', 'EncodingError'),
        new DOMException('Codec reclaimed due to inactivity.', 'QuotaExceededError')
    ])('fails the attempt with decoder error $name and closes every frame', async codecError => {
        const harness = createHarness([
            createShownPacket(0, getHDR10PlusITUTT35Messages('valid')),
            createShownPacket(1),
            createShownPacket(2)
        ], AMPLE_FRAME_CREDITS, 'immediate', (decoder: FakeOwnedVideoDecoder): void => {
            decoder.failures.set(FRAME_DURATION_MICROSECONDS, codecError);
        });

        // The worker resyncs a reclaimed decoder by the error's name, so the codec's own error must surface
        await expect(harness.start()).rejects.toBe(codecError);
        const decoder = harness.requireDecoder();
        expect(decoder.close).toHaveBeenCalledOnce();
        expect(harness.run.postedFrames).toHaveLength(1);
        for (const frame of decoder.frames) {
            expect(frame.close).toHaveBeenCalledOnce();
        }
    });

    it('rejects a decoder that ends without the frame of a shown packet', async () => {
        const harness = createHarness([
            createShownPacket(0, getHDR10PlusITUTT35Messages('valid')),
            createShownPacket(1),
            createShownPacket(2)
        ], AMPLE_FRAME_CREDITS, 'immediate', (decoder: FakeOwnedVideoDecoder): void => {
            decoder.droppedTimestamps.add(FRAME_DURATION_MICROSECONDS);
        });

        await expect(harness.start()).rejects.toThrow('The VP9 decoder ended before dynamic HDR metadata was matched');
        expect(getPostedFrameIndices(harness)).toEqual([ 0, 2 ]);
        expect(harness.requireDecoder().close).toHaveBeenCalledOnce();
    });

    it('closes the frames it still holds when the attempt stops', async () => {
        const harness = createHarness([
            createShownPacket(0, getHDR10PlusITUTT35Messages('valid')),
            createShownPacket(1),
            createShownPacket(2)
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
