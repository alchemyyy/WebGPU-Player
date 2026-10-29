import type { EncodedPacket } from 'mediabunny';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { getAudioPrerollTimeMicroseconds, getAudioStartPacket, type AudioStartPacketReader } from 'webgpu-player/demux/AudioStartPacket';
import { requireMicroseconds } from 'webgpu-player/TimeMath';

const FIRST_PACKET = { timestamp: 6.006 } as unknown as EncodedPacket;
const LOOKUP_PACKET = { timestamp: 9.5 } as unknown as EncodedPacket;
const ZERO_ORIGIN = requireMicroseconds(0);
// A transport stream's first timestamp, where a run's playback timeline starts in container time
const PROGRAM_CLOCK_ORIGIN = requireMicroseconds(600_000_000);
const PREROLL_MICROSECONDS = 1_000_000;

type FakePacketReader = AudioStartPacketReader & {
    getAt: Mock
    getFirst: Mock
};

function createPacketReader(lookupPacket: EncodedPacket | null): FakePacketReader {
    return {
        getAt: vi.fn(async (): Promise<EncodedPacket | null> => lookupPacket),
        getFirst: vi.fn(async (): Promise<EncodedPacket | null> => FIRST_PACKET)
    };
}

describe('getAudioStartPacket', () => {
    it.each([
        [ 0, ZERO_ORIGIN ],
        [ -40_000, ZERO_ORIGIN ],
        // A run at playback 0 of a program clock container looks up at its origin
        [ 600_000_000, PROGRAM_CLOCK_ORIGIN ],
        [ 599_000_000, PROGRAM_CLOCK_ORIGIN ]
    ])('starts at the first packet without a lookup at %i microseconds, with the timeline at %i', async (lookupTime, origin) => {
        const packetReader = createPacketReader(LOOKUP_PACKET);

        await expect(getAudioStartPacket(packetReader, requireMicroseconds(lookupTime), origin))
            .resolves.toBe(FIRST_PACKET);
        expect(packetReader.getAt).not.toHaveBeenCalled();
        expect(packetReader.getFirst).toHaveBeenCalledOnce();
    });

    it.each([
        [ 10_000_000, ZERO_ORIGIN, 10 ],
        [ 600_000_001, PROGRAM_CLOCK_ORIGIN, 600.000_001 ]
    ])('uses the packet at or before a lookup time of %i microseconds past the timeline origin', async (lookupTime, origin, lookupSeconds) => {
        const packetReader = createPacketReader(LOOKUP_PACKET);

        await expect(getAudioStartPacket(packetReader, requireMicroseconds(lookupTime), origin))
            .resolves.toBe(LOOKUP_PACKET);
        expect(packetReader.getAt).toHaveBeenCalledWith(lookupSeconds);
        expect(packetReader.getFirst).not.toHaveBeenCalled();
    });

    it('falls back to the first packet only when the track starts after the lookup', async () => {
        const packetReader = createPacketReader(null);

        await expect(getAudioStartPacket(packetReader, requireMicroseconds(2_000_000), ZERO_ORIGIN))
            .resolves.toBe(FIRST_PACKET);
        expect(packetReader.getAt).toHaveBeenCalledWith(2);
        expect(packetReader.getFirst).toHaveBeenCalledOnce();
    });
});

describe('getAudioPrerollTimeMicroseconds', () => {
    it.each([
        [ 'within a second of zero', 400_000, ZERO_ORIGIN, 0 ],
        [ 'within a second of a program clock\'s origin', 600_400_000, PROGRAM_CLOCK_ORIGIN, 600_000_000 ],
        [ 'past a second after the origin', 602_500_000, PROGRAM_CLOCK_ORIGIN, 601_500_000 ]
    ])('leads a start %s by its preroll, never before the timeline origin', (_description, startTime, origin, expected) => {
        expect(getAudioPrerollTimeMicroseconds(requireMicroseconds(startTime), PREROLL_MICROSECONDS, origin)).toBe(expected);
    });
});
