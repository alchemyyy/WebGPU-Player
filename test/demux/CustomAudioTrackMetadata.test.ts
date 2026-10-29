import { describe, expect, it } from 'vitest';

import {
    getAudioTimestampToleranceMicroseconds,
    getContainerAudioCodec,
    getDeclaredAudioSampleRate,
    getNativeMediaAudioChannelCount,
    isDTSExpressTrack,
    resolveDeclaredAudioChannelLayout
} from 'webgpu-player/demux/CustomAudioTrackMetadata';

// ISO BMFF reads a 32-bit integer rate as 16.16 fixed point
const ISO_BASE_MEDIA_SAMPLE_RATE_SCALE = 0x1_0000;
// Mediabunny's decoder configuration codecs for DTS Express and the DTS core
const DTS_EXPRESS_CODEC_STRING = 'dtse';
const DTS_CORE_CODEC_STRING = 'dtsc';

describe('CustomAudioTrackMetadata', () => {
    it.each([
        // The QuickTime DTS core entry, whose fourcc ends in a space, which Mediabunny does not map
        [ 'DTS ', 'dts' ],
        [ 'A_MLP', 'mlp' ],
        [ 'A_TRUEHD', 'truehd' ],
        [ 'mlpa', 'truehd' ]
    ] as const)('identifies the codec-less %s track as %s', (internalCodecID, decoderCodec) => {
        expect(getContainerAudioCodec(null, internalCodecID)).toBe(decoderCodec);
    });

    it.each([
        // DTS LBR and DTS-UHD, which the engine does not identify
        [ null, 'dtse' ],
        [ null, 'dtsx' ],
        // Mediabunny maps these DTS tracks itself
        [ null, 'A_DTS' ],
        [ null, 'dtsc' ],
        [ null, 'dtsh' ],
        [ null, 'dtsl' ],
        // Only the exact fourcc maps
        [ null, 'DTS' ],
        [ null, 'A_AAC' ],
        [ null, null ],
        // A Mediabunny codec always wins over the internal ID
        [ 'eac3', 'A_DTS' ]
    ] as const)('leaves the %s track with internal ID %s to Mediabunny', (codec, internalCodecID) => {
        expect(getContainerAudioCodec(codec, internalCodecID)).toBeNull();
    });

    it('marks only Mediabunny\'s DTS Express configuration as DTS Express', () => {
        expect(isDTSExpressTrack('dts', { codec: DTS_EXPRESS_CODEC_STRING, numberOfChannels: 2, sampleRate: 48_000 })).toBe(true);
        expect(isDTSExpressTrack('dts', { codec: DTS_CORE_CODEC_STRING, numberOfChannels: 6, sampleRate: 48_000 })).toBe(false);
        expect(isDTSExpressTrack('dts', null)).toBe(false);
        expect(isDTSExpressTrack('eac3', { codec: DTS_EXPRESS_CODEC_STRING, numberOfChannels: 2, sampleRate: 48_000 })).toBe(false);
    });

    it('recovers the integer rate of a Dolby TrueHD ISO BMFF sample entry', () => {
        expect(getDeclaredAudioSampleRate('mlpa', 48_000 / ISO_BASE_MEDIA_SAMPLE_RATE_SCALE))
            .toBe(48_000);
        expect(getDeclaredAudioSampleRate('mlpa', 192_000 / ISO_BASE_MEDIA_SAMPLE_RATE_SCALE))
            .toBe(192_000);
        // A muxer that wrote 16.16 already reads back as the integer rate
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

    describe('the declared channel layout', () => {
        // FL, FR, and LFE, which a 2.1 FLAC's channels follow
        const TWO_POINT_ONE_MASK = 0x0B;
        const FIVE_POINT_ONE_SIDE_MASK = 0x060F;

        it.each([
            // A Matroska header that declares a DTS 5.1 track's four channels, or an AC-3 track's first 3/2 syncframes' five
            { containerCount: 4, expected: { channelCount: 6, channelMask: null, layoutID: '5.1-side' }, metadata: { channelCount: 6 } },
            { containerCount: 5, expected: { channelCount: 5, channelMask: null, layoutID: '5.0-side' }, metadata: { channelCount: 6 } },
            // The container's count wins whenever it has a layout
            { containerCount: 2, expected: { channelCount: 2, channelMask: null, layoutID: 'stereo' }, metadata: { channelCount: 6 } },
            { containerCount: 6, expected: { channelCount: 6, channelMask: null, layoutID: '5.1-side' }, metadata: null },
            // The metadata's mask lays out a count it names, and only that count
            { containerCount: 3, expected: { channelCount: 3, channelMask: TWO_POINT_ONE_MASK, layoutID: '2.1' }, metadata: { channelCount: 3, channelMask: TWO_POINT_ONE_MASK } },
            { containerCount: 3, expected: { channelCount: 3, channelMask: null, layoutID: '3.0' }, metadata: { channelCount: 6, channelMask: FIVE_POINT_ONE_SIDE_MASK } }
        ] as const)('screens $containerCount container channels with metadata $metadata as $expected.layoutID', ({ containerCount, expected, metadata }) => {
            const result = resolveDeclaredAudioChannelLayout(containerCount, null, metadata);

            expect(result.status === 'resolved' ?
                { channelCount: result.channelCount, channelMask: result.channelMask, layoutID: result.layout.id } :
                result).toEqual(expected);
        });

        it('lays the channels out by the container\'s mask over the metadata\'s, and refuses a container mask of another count', () => {
            const metadata = { channelCount: 3, channelMask: TWO_POINT_ONE_MASK };

            expect(resolveDeclaredAudioChannelLayout(6, FIVE_POINT_ONE_SIDE_MASK, metadata)).toMatchObject({ channelMask: FIVE_POINT_ONE_SIDE_MASK, status: 'resolved' });
            // A zero mask declares no speakers, so the metadata's applies
            expect(resolveDeclaredAudioChannelLayout(3, 0, metadata)).toMatchObject({ channelMask: TWO_POINT_ONE_MASK, status: 'resolved' });
            expect(resolveDeclaredAudioChannelLayout(3, FIVE_POINT_ONE_SIDE_MASK, metadata))
                .toEqual({ failure: 'The selected audio channel mask is unqualified: 0x60f', status: 'failed' });
        });

        it('refuses a count no layout has when the metadata gives none either', () => {
            const unavailable = { failure: 'The selected audio channel layout is unavailable', status: 'failed' };

            expect(resolveDeclaredAudioChannelLayout(4, null, null)).toEqual(unavailable);
            expect(resolveDeclaredAudioChannelLayout(4, null, { channelCount: 4 })).toEqual(unavailable);
            expect(resolveDeclaredAudioChannelLayout(9, null, { channelCount: 10 })).toEqual(unavailable);
        });
    });

    it.each([
        { declared: 2, expected: 2, metadata: null },
        { declared: 6, expected: 6, metadata: 2 },
        // A container that declares the 3/2 of an AC-3 track's first syncframes plays at the 5.1 the metadata declares
        { declared: 5, expected: 6, metadata: 6 },
        { declared: 5, expected: null, metadata: 5 },
        { declared: 5, expected: null, metadata: null }
    ])('plays a native media track declaring $declared channels, with metadata $metadata, at $expected', ({ declared, expected, metadata }) => {
        expect(getNativeMediaAudioChannelCount(declared, metadata)).toBe(expected);
    });
});
