import { MpegPsInputFormat, MpegTsInputFormat, type Input, type InputFormat, type InputTrack } from 'mediabunny';

import { MICROSECONDS_PER_SECOND, type Microseconds } from '../MediaTime';
import { requireMicroseconds } from '../TimeMath';

const ZERO_ORIGIN = 0 as Microseconds;

/**
 * Whether a container stamps its packets on a program clock, which need not start at zero: MPEG-TS and M2TS carry a broadcaster's or a disc's
 * 90 kHz clock, which a Blu-ray title starts at 600 s, and an MPEG program stream, an MPG or a DVD-Video VOB, the clock of the source it was cut from.
 * Every other container Mediabunny reads starts its tracks where the host's positions start.
 */
export function hasProgramClockTimestamps(inputFormat: InputFormat): boolean {
    return inputFormat instanceof MpegTsInputFormat || inputFormat instanceof MpegPsInputFormat;
}

/**
 * Returns where the playback timeline starts in container time: on a program clock, the first timestamp of the tracks a run plays, as FFprobe's
 * `start_time` is the first timestamp of its streams, and zero for any other container or a clock that starts before zero.
 * The host's positions and durations count from that start.
 * The origin is truncated to whole microseconds, as Mediabunny truncates every packet's and sample's time, so the first packet starts at 0.
 */
export async function readPlaybackTimelineOriginMicroseconds(input: Input, tracks: readonly InputTrack[]): Promise<Microseconds> {
    if (!hasProgramClockTimestamps(await input.getFormat())) {
        return ZERO_ORIGIN;
    }
    const firstTimestampSeconds = await input.getFirstTimestamp([ ...tracks ]);
    return requireMicroseconds(Math.trunc(Math.max(0, firstTimestampSeconds) * MICROSECONDS_PER_SECOND));
}
