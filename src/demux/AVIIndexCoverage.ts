import { AviInputFormat, PacketReader, type Input, type InputTrack } from 'mediabunny';

import { secondsToMicroseconds, type Microseconds } from '../MediaTime';

// How much earlier than its declared length a track's indexed packets may end, for rounding and a trailing dropped frame
const MAXIMUM_INDEX_SHORTFALL_MICROSECONDS: Microseconds = secondsToMicroseconds(1);
const LAST_PACKET_OPTIONS = { metadataOnly: true } as const;

/**
 * Returns whether an AVI track's packets end well before the length its stream header declares.
 * Mediabunny's AVI demuxer reads a stream's OpenDML index (its indx super index and the ix## standard indexes it locates in every RIFF list) and
 * falls back to idx1, which covers only the first RIFF list, so a file past about 1 GiB whose OpenDML index cannot be read in full, or a truncated
 * file, loses the packets its index misses; its stream header still counts every chunk.
 * False for any other container, or a track that declares no length.
 */
export async function hasIncompleteAVIIndex(input: Input, track: InputTrack): Promise<boolean> {
    if (!(await input.getFormat() instanceof AviInputFormat)) {
        return false;
    }
    const declaredDurationSeconds = await track.getDurationFromMetadata();
    if (declaredDurationSeconds === null) {
        return false;
    }
    const lastPacket = await new PacketReader(track).getAt(Number.POSITIVE_INFINITY, LAST_PACKET_OPTIONS);
    const indexedEndMicroseconds = lastPacket ? secondsToMicroseconds(lastPacket.timestamp + lastPacket.duration) : 0;
    return secondsToMicroseconds(declaredDurationSeconds) - indexedEndMicroseconds > MAXIMUM_INDEX_SHORTFALL_MICROSECONDS;
}
