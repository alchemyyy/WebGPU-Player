import type { EncodedPacket, EncodedPacketSink } from 'mediabunny';

import { microsecondsToSeconds, type Microseconds } from '../MediaTime';

export type AudioStartPacketSink = Pick<EncodedPacketSink, 'getFirstPacket' | 'getPacket'>;

/**
 * Returns the packet an audio attempt starts from. When the track starts after
 * the lookup time, Mediabunny returns no packet only after proof scans, so a
 * lookup at or before zero goes straight to the first packet, and a later
 * lookup falls back to it only when nothing precedes the lookup time.
 */
export async function getAudioStartPacket(
    packetSink: AudioStartPacketSink,
    lookupTimeMicroseconds: Microseconds
): Promise<EncodedPacket | null> {
    if (lookupTimeMicroseconds <= 0) {
        return packetSink.getFirstPacket();
    }
    const lookupPacket = await packetSink.getPacket(microsecondsToSeconds(lookupTimeMicroseconds));
    return lookupPacket ?? packetSink.getFirstPacket();
}
