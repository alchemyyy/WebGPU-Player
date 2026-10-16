import type { EncodedPacket } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import { getAudioStartPacket, type AudioStartPacketReader } from 'webgpu-player/demux/AudioStartPacket';
import { requireMicroseconds } from 'webgpu-player/TimeMath';

const FIRST_PACKET = { timestamp: 6.006 } as unknown as EncodedPacket;
const LOOKUP_PACKET = { timestamp: 9.5 } as unknown as EncodedPacket;

type FakePacketReader = AudioStartPacketReader & {
    getAt: ReturnType<typeof vi.fn>
    getFirst: ReturnType<typeof vi.fn>
};

function createPacketReader(lookupPacket: EncodedPacket | null): FakePacketReader {
    return {
        getAt: vi.fn(async (): Promise<EncodedPacket | null> => lookupPacket),
        getFirst: vi.fn(async (): Promise<EncodedPacket | null> => FIRST_PACKET)
    };
}

describe('getAudioStartPacket', () => {
    it.each([ 0, -40_000 ])('starts at the first packet without a lookup at %i microseconds', async lookupTime => {
        const packetReader = createPacketReader(LOOKUP_PACKET);

        await expect(getAudioStartPacket(packetReader, requireMicroseconds(lookupTime)))
            .resolves.toBe(FIRST_PACKET);
        expect(packetReader.getAt).not.toHaveBeenCalled();
        expect(packetReader.getFirst).toHaveBeenCalledOnce();
    });

    it('uses the packet at or before a positive lookup time', async () => {
        const packetReader = createPacketReader(LOOKUP_PACKET);

        await expect(getAudioStartPacket(packetReader, requireMicroseconds(10_000_000)))
            .resolves.toBe(LOOKUP_PACKET);
        expect(packetReader.getAt).toHaveBeenCalledWith(10);
        expect(packetReader.getFirst).not.toHaveBeenCalled();
    });

    it('falls back to the first packet only when the track starts after the lookup', async () => {
        const packetReader = createPacketReader(null);

        await expect(getAudioStartPacket(packetReader, requireMicroseconds(2_000_000)))
            .resolves.toBe(FIRST_PACKET);
        expect(packetReader.getAt).toHaveBeenCalledWith(2);
        expect(packetReader.getFirst).toHaveBeenCalledOnce();
    });
});
