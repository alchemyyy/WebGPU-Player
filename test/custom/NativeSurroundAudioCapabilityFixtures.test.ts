// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
    createNativeSurroundAudioCapabilityFixture,
    NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_CHANNEL_COUNT,
    NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_SAMPLE_RATE,
    type NativeSurroundAudioCapabilityFixtureCodec
} from 'webgpu-player/custom/NativeSurroundAudioCapabilityFixtures';

type ExpectedFixture = Readonly<{
    chunkByteLengths: readonly number[]
    codecString: string
    descriptionByteLength: number
    expectedOutputFrameCount: number
}>;

const EXPECTED_FIXTURES: Readonly<Record<
    NativeSurroundAudioCapabilityFixtureCodec,
    ExpectedFixture
>> = Object.freeze({
    aac: Object.freeze({
        chunkByteLengths: [ 36 ],
        codecString: 'mp4a.40.2',
        descriptionByteLength: 5,
        expectedOutputFrameCount: 1_024
    }),
    flac: Object.freeze({
        chunkByteLengths: [ 26 ],
        codecString: 'flac',
        descriptionByteLength: 42,
        expectedOutputFrameCount: 4_608
    }),
    opus: Object.freeze({
        chunkByteLengths: [ 640 ],
        codecString: 'opus',
        descriptionByteLength: 27,
        expectedOutputFrameCount: 648
    }),
    vorbis: Object.freeze({
        chunkByteLengths: [ 1, 2 ],
        codecString: 'vorbis',
        descriptionByteLength: 6_513,
        expectedOutputFrameCount: 576
    })
});

describe('native surround audio capability fixtures', () => {
    it.each(Object.entries(EXPECTED_FIXTURES))(
        'creates the exact %s 5.1 decoder fixture',
        (codecValue, expectedFixture) => {
            const codec = codecValue as NativeSurroundAudioCapabilityFixtureCodec;
            const fixture = createNativeSurroundAudioCapabilityFixture(codec);

            expect(fixture).toMatchObject({
                codec,
                codecString: expectedFixture.codecString,
                expectedOutputFrameCount: expectedFixture.expectedOutputFrameCount,
                expectedOutputTimestamp: 0,
                numberOfChannels: NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_CHANNEL_COUNT,
                sampleRate: NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_SAMPLE_RATE
            });
            expect(fixture.description).toHaveLength(expectedFixture.descriptionByteLength);
            expect(fixture.encodedChunks.map(chunk => chunk.data.byteLength)).toEqual(
                expectedFixture.chunkByteLengths
            );
        }
    );

    it('returns independent mutable descriptions and packet arrays', () => {
        const firstFixture = createNativeSurroundAudioCapabilityFixture('vorbis');
        const secondFixture = createNativeSurroundAudioCapabilityFixture('vorbis');
        const descriptionFirstByte = secondFixture.description[0];
        const packetFirstByte = secondFixture.encodedChunks[0].data[0];

        firstFixture.description[0] ^= 0xFF;
        firstFixture.encodedChunks[0].data[0] ^= 0xFF;

        expect(secondFixture.description[0]).toBe(descriptionFirstByte);
        expect(secondFixture.encodedChunks[0].data[0]).toBe(packetFirstByte);
    });
});
