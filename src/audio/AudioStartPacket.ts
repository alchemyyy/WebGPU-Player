import type { EncodedPacket, EncodedPacketSink } from 'mediabunny';

import { microsecondsToSeconds, type Microseconds } from '../MediaTime';

// The lead a bundled decoder needs before a seek target: DTS to synchronize its XLL, TrueHD to reach a major sync
export const DTS_SEEK_PREROLL_MICROSECONDS = 1_000_000;
export const TRUEHD_MAJOR_SYNC_PREROLL_MICROSECONDS = 1_000_000;

export type AudioStartPacketSink = Pick<EncodedPacketSink, 'getFirstPacket' | 'getPacket'>;

/** Returns the time an attempt demuxes from: its start less a decoder's lead, and never before zero. */
export function getAudioPrerollTimeMicroseconds(
    startTimeMicroseconds: Microseconds,
    prerollMicroseconds: number
): Microseconds {
    return Math.max(0, startTimeMicroseconds - prerollMicroseconds) as Microseconds;
}

/**
 * Returns the packet an audio attempt starts from.
 * When the track starts after the lookup time, Mediabunny returns no packet, but only after proof scans.
 * A lookup at or before zero therefore goes straight to the first packet, and a later lookup falls back to it only when nothing precedes the lookup time.
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
