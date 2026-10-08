import { describe, expect, it } from 'vitest';

import {
    getAudioTimestampToleranceMicroseconds,
    getBundledAudioDecoderCodec,
    getDeclaredAudioSampleRate
} from 'webgpu-player/audio/CustomAudioTrackMetadata';

// ISO BMFF reads a 32-bit integer rate as 16.16 fixed point
const ISO_BASE_MEDIA_SAMPLE_RATE_SCALE = 0x1_0000;

describe('CustomAudioTrackMetadata', () => {
    it.each([
        [ 'A_DTS', 'dts' ],
        // The QuickTime DTS core entry, whose fourcc ends in a space
        [ 'DTS ', 'dts' ],
        [ 'dtsc', 'dts' ],
        [ 'dtsh', 'dts' ],
        [ 'dtsl', 'dts' ],
        [ 'A_MLP', 'mlp' ],
        [ 'A_TRUEHD', 'truehd' ],
        [ 'mlpa', 'truehd' ]
    ] as const)('maps the codec-less %s track to the bundled %s decoder', (internalCodecID, decoderCodec) => {
        expect(getBundledAudioDecoderCodec(null, internalCodecID)).toBe(decoderCodec);
    });

    it.each([
        // DTS LBR and DTS-UHD, which libdcadec cannot decode
        [ null, 'dtse' ],
        [ null, 'dtsx' ],
        // Only the exact fourcc maps
        [ null, 'DTS' ],
        [ null, 'A_AAC' ],
        [ null, null ],
        // A Mediabunny codec always wins over the internal ID
        [ 'eac3', 'A_DTS' ]
    ] as const)('leaves the %s track with internal ID %s to Mediabunny', (codec, internalCodecID) => {
        expect(getBundledAudioDecoderCodec(codec, internalCodecID)).toBeNull();
    });

    it('recovers the integer rate of a Dolby TrueHD ISO BMFF sample entry', () => {
        expect(getDeclaredAudioSampleRate('mlpa', 48_000 / ISO_BASE_MEDIA_SAMPLE_RATE_SCALE))
            .toBe(48_000);
        expect(getDeclaredAudioSampleRate('mlpa', 192_000 / ISO_BASE_MEDIA_SAMPLE_RATE_SCALE))
            .toBe(192_000);
        // A muxer that wrote 16.16 already reads back correctly
        expect(getDeclaredAudioSampleRate('mlpa', 96_000)).toBe(96_000);
    });

    it('declares the 48 kHz DTS core when an ISO BMFF sample entry cannot hold the rate', () => {
        for (const sampleEntry of [ 'DTS ', 'dtsc', 'dtsh', 'dtsl' ]) {
            expect(getDeclaredAudioSampleRate(sampleEntry, 0)).toBe(48_000);
            expect(getDeclaredAudioSampleRate(sampleEntry, 44_100)).toBe(44_100);
        }
        expect(getDeclaredAudioSampleRate('A_DTS', 0)).toBe(0);
        expect(getDeclaredAudioSampleRate('A_AAC', 24_000)).toBe(24_000);
    });

    it.each([
        // Matroska millisecond ticks, the ordinary floor, and the TrueHD access-unit allowance
        [ 1_000, 1_000, 834, 1_834 ],
        [ 1_000, 1_000, 0, 1_000 ],
        // DTS keeps its 3 ms floor above the tick
        [ 1_000, 3_000, 0, 3_000 ],
        // ISO BMFF track timescales are finer than the floor
        [ 48_000, 1_000, 0, 1_000 ],
        [ 90_000, 3_000, 0, 3_000 ],
        // A coarse timescale widens the tolerance to one tick
        [ 100, 1_000, 0, 10_000 ],
        [ 3, 1_000, 0, 333_334 ],
        // An unusable resolution falls back to the floor
        [ 0, 1_000, 0, 1_000 ],
        [ Number.NaN, 3_000, 834, 3_834 ]
    ])(
        'derives a %s per-second resolution with a %i floor and %i allowance as %i',
        (timeResolution, codecFloorMicroseconds, accessUnitAllowanceMicroseconds, tolerance) => {
            expect(getAudioTimestampToleranceMicroseconds(
                timeResolution,
                codecFloorMicroseconds,
                accessUnitAllowanceMicroseconds
            )).toBe(tolerance);
        }
    );
});
