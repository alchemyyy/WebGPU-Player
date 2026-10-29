import type { EncodedPacket, PacketReader } from 'mediabunny';

import { microsecondsToSeconds, type Microseconds } from '../MediaTime';

// The lead a decoder needs before a seek target: DTS to synchronize its XLL, TrueHD to reach a major sync
export const DTS_SEEK_PREROLL_MICROSECONDS = 1_000_000;
export const TRUEHD_MAJOR_SYNC_PREROLL_MICROSECONDS = 1_000_000;

export type AudioStartPacketReader = Pick<PacketReader, 'getFirst' | 'getAt'>;

/**
 * Returns the time an attempt demuxes from, in container time: its start less a decoder's lead, and never before the playback timeline's origin,
 * the container time where the host's positions start.
 */
export function getAudioPrerollTimeMicroseconds(
    startTimeMicroseconds: Microseconds,
    prerollMicroseconds: number,
    timelineOriginMicroseconds: Microseconds
): Microseconds {
    return Math.max(timelineOriginMicroseconds, startTimeMicroseconds - prerollMicroseconds) as Microseconds;
}

/**
 * Returns the packet an audio attempt starts from, for a lookup time in container time.
 * When the track starts after the lookup time, Mediabunny returns no packet, but only after proof scans.
 * A lookup at or before the playback timeline's origin therefore goes straight to the first packet, and a later lookup falls back to it only when
 * nothing precedes the lookup time.
 */
export async function getAudioStartPacket(
    packetReader: AudioStartPacketReader,
    lookupTimeMicroseconds: Microseconds,
    timelineOriginMicroseconds: Microseconds
): Promise<EncodedPacket | null> {
    if (lookupTimeMicroseconds <= timelineOriginMicroseconds) {
        return packetReader.getFirst();
    }
    const lookupPacket = await packetReader.getAt(microsecondsToSeconds(lookupTimeMicroseconds));
    return lookupPacket ?? packetReader.getFirst();
}
