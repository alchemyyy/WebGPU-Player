// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ALL_FORMATS, BufferSource, Input, MATROSKA, MPEG_TS, type InputFormat, type InputTrack } from 'mediabunny';
import { describe, expect, it } from 'vitest';

import { hasProgramClockTimestamps, readPlaybackTimelineOriginMicroseconds } from 'webgpu-player/demux/PlaybackTimelineOrigin';

import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../helpers/enginePaths';

// The FFmpeg-made vectors of scripts/codec_vector_assets/generate_transport_stream_demux_vectors.py, and the start_time FFprobe reads of each, in
// whole microseconds as Mediabunny truncates them: the AC-3 track starts first, 1.4 s in by the muxer's delay, and 600 s on in the offset vectors
const TRANSPORT_STREAM_VECTOR_DIRECTORY = join(CODEC_VECTOR_ASSETS_DIRECTORY, 'mpeg-ts');
const TRANSPORT_STREAM_STARTS: readonly (readonly [ string, number ])[] = [
    [ 'mpeg2video-bframes-ac3.ts', 1_436_333 ],
    [ 'mpeg2video-ac3-start600.ts', 601_394_666 ],
    [ 'mpeg2video-ac3-start600.m2ts', 601_394_666 ]
];
// The offset vector's video track alone starts with its first frame
const START600_VIDEO_START_MICROSECONDS = 601_400_000;
const LATE_FIRST_TIMESTAMP_SECONDS = 5;
const NEGATIVE_FIRST_TIMESTAMP_SECONDS = -0.5;

/** An input of a format whose tracks start at a timestamp, for the origin's rules without a file. */
function createStartingInput(format: InputFormat, firstTimestampSeconds: number): Input {
    return {
        getFirstTimestamp: async (): Promise<number> => firstTimestampSeconds,
        getFormat: async (): Promise<InputFormat> => format
    } as unknown as Input;
}

async function readOrigin(fileName: string, selectTracks: (tracks: InputTrack[]) => InputTrack[]): Promise<number> {
    const input = new Input({
        formats: ALL_FORMATS,
        source: new BufferSource(readFileSync(join(TRANSPORT_STREAM_VECTOR_DIRECTORY, fileName)))
    });
    try {
        return await readPlaybackTimelineOriginMicroseconds(input, selectTracks(await input.getTracks()));
    } finally {
        input.dispose();
    }
}

describe('the playback timeline origin', () => {
    it('gives a program clock only to MPEG-TS and M2TS among Mediabunny\'s formats', () => {
        expect(ALL_FORMATS.filter(hasProgramClockTimestamps)).toEqual([ MPEG_TS ]);
    });

    it.each(TRANSPORT_STREAM_STARTS)('starts %s\'s timeline at FFprobe\'s start_time, the first timestamp of its tracks', async (fileName, startMicroseconds) => {
        await expect(readOrigin(fileName, tracks => tracks)).resolves.toBe(startMicroseconds);
    });

    it('starts the timeline at the first timestamp of the tracks a run plays', async () => {
        await expect(readOrigin('mpeg2video-ac3-start600.ts', tracks => tracks.filter(track => track.isVideoTrack())))
            .resolves.toBe(START600_VIDEO_START_MICROSECONDS);
    });

    it('keeps the container\'s times for any other format, wherever its tracks start', async () => {
        await expect(readPlaybackTimelineOriginMicroseconds(createStartingInput(MATROSKA, LATE_FIRST_TIMESTAMP_SECONDS), [])).resolves.toBe(0);
    });

    it('keeps a program clock that starts before zero at zero', async () => {
        await expect(readPlaybackTimelineOriginMicroseconds(createStartingInput(MPEG_TS, NEGATIVE_FIRST_TIMESTAMP_SECONDS), [])).resolves.toBe(0);
    });
});
