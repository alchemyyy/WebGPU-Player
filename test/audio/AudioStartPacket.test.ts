import type { EncodedPacket } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import { getAudioStartPacket, type AudioStartPacketSink } from 'webgpu-player/audio/AudioStartPacket';
import { requireMicroseconds } from 'webgpu-player/TimeMath';

const FIRST_PACKET = { timestamp: 6.006 } as unknown as EncodedPacket;
const LOOKUP_PACKET = { timestamp: 9.5 } as unknown as EncodedPacket;

type FakePacketSink = AudioStartPacketSink & {
    getFirstPacket: ReturnType<typeof vi.fn>
    getPacket: ReturnType<typeof vi.fn>
};

function createPacketSink(lookupPacket: EncodedPacket | null): FakePacketSink {
    return {
        getFirstPacket: vi.fn(async (): Promise<EncodedPacket | null> => FIRST_PACKET),
        getPacket: vi.fn(async (): Promise<EncodedPacket | null> => lookupPacket)
    };
}

describe('getAudioStartPacket', () => {
    it.each([ 0, -40_000 ])('starts at the first packet without a lookup at %i microseconds', async lookupTime => {
        const packetSink = createPacketSink(LOOKUP_PACKET);

        await expect(getAudioStartPacket(packetSink, requireMicroseconds(lookupTime)))
            .resolves.toBe(FIRST_PACKET);
        expect(packetSink.getPacket).not.toHaveBeenCalled();
        expect(packetSink.getFirstPacket).toHaveBeenCalledOnce();
    });

    it('uses the packet at or before a positive lookup time', async () => {
        const packetSink = createPacketSink(LOOKUP_PACKET);

        await expect(getAudioStartPacket(packetSink, requireMicroseconds(10_000_000)))
            .resolves.toBe(LOOKUP_PACKET);
        expect(packetSink.getPacket).toHaveBeenCalledWith(10);
        expect(packetSink.getFirstPacket).not.toHaveBeenCalled();
    });

    it('falls back to the first packet only when the track starts after the lookup', async () => {
        const packetSink = createPacketSink(null);

        await expect(getAudioStartPacket(packetSink, requireMicroseconds(2_000_000)))
            .resolves.toBe(FIRST_PACKET);
        expect(packetSink.getPacket).toHaveBeenCalledWith(2);
        expect(packetSink.getFirstPacket).toHaveBeenCalledOnce();
    });
});
