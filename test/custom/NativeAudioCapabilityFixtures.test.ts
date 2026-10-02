// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
    createNativeAudioCapabilityFixture,
    NATIVE_AUDIO_CAPABILITY_FIXTURE_CHANNEL_COUNT,
    NATIVE_AUDIO_CAPABILITY_FIXTURE_SAMPLE_RATE,
    type NativeAudioCapabilityFixtureCodec
} from 'webgpu-player/custom/NativeAudioCapabilityFixtures';

type ExpectedFixture = Readonly<{
    chunkByteLengths: readonly number[]
    codecString: string
    descriptionByteLength: number | null
    expectedOutputFrameCount: number
}>;

const EXPECTED_FIXTURES: Readonly<Record<
    NativeAudioCapabilityFixtureCodec,
    ExpectedFixture
>> = Object.freeze({
    aac: Object.freeze({
        chunkByteLengths: [ 23 ],
        codecString: 'mp4a.40.2',
        descriptionByteLength: 5,
        expectedOutputFrameCount: 1_024
    }),
    flac: Object.freeze({
        chunkByteLengths: [ 14 ],
        codecString: 'flac',
        descriptionByteLength: 42,
        expectedOutputFrameCount: 4_608
    }),
    mp3: Object.freeze({
        chunkByteLengths: [ 384 ],
        codecString: 'mp3',
        descriptionByteLength: null,
        expectedOutputFrameCount: 1_152
    }),
    opus: Object.freeze({
        chunkByteLengths: [ 240 ],
        codecString: 'opus',
        descriptionByteLength: 19,
        expectedOutputFrameCount: 648
    }),
    vorbis: Object.freeze({
        chunkByteLengths: [ 1, 1 ],
        codecString: 'vorbis',
        descriptionByteLength: 3_929,
        expectedOutputFrameCount: 576
    })
});

describe('native audio capability fixtures', () => {
    it.each(Object.entries(EXPECTED_FIXTURES))(
        'creates the exact %s decoder fixture',
        (codecValue, expectedFixture) => {
            const codec = codecValue as NativeAudioCapabilityFixtureCodec;
            const fixture = createNativeAudioCapabilityFixture(codec);

            expect(fixture).toMatchObject({
                codec,
                codecString: expectedFixture.codecString,
                expectedOutputFrameCount: expectedFixture.expectedOutputFrameCount,
                expectedOutputTimestamp: 0,
                numberOfChannels: NATIVE_AUDIO_CAPABILITY_FIXTURE_CHANNEL_COUNT,
                sampleRate: NATIVE_AUDIO_CAPABILITY_FIXTURE_SAMPLE_RATE
            });
            if (expectedFixture.descriptionByteLength === null) {
                expect(fixture.description).toBeNull();
            } else {
                expect(fixture.description).toHaveLength(expectedFixture.descriptionByteLength);
            }
            expect(fixture.encodedChunks.map(chunk => chunk.data.byteLength)).toEqual(
                expectedFixture.chunkByteLengths
            );
        }
    );

    it('returns independent mutable descriptions and packet arrays', () => {
        const firstFixture = createNativeAudioCapabilityFixture('vorbis');
        const secondFixture = createNativeAudioCapabilityFixture('vorbis');
        const descriptionFirstByte = secondFixture.description?.[0];
        const packetFirstByte = secondFixture.encodedChunks[0].data[0];

        if (firstFixture.description) {
            firstFixture.description[0] ^= 0xFF;
        }
        firstFixture.encodedChunks[0].data[0] ^= 0xFF;

        expect(secondFixture.description?.[0]).toBe(descriptionFirstByte);
        expect(secondFixture.encodedChunks[0].data[0]).toBe(packetFirstByte);
    });
});
