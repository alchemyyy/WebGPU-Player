// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
    createNativeSurroundAudioCapabilityVector,
    NATIVE_SURROUND_AUDIO_CAPABILITY_VECTOR_CHANNEL_COUNT,
    NATIVE_SURROUND_AUDIO_CAPABILITY_VECTOR_SAMPLE_RATE,
    type NativeSurroundAudioCapabilityVectorCodec
} from 'webgpu-player/capability/vectors/NativeSurroundAudioCapabilityVectors';

type ExpectedVector = Readonly<{
    chunkByteLengths: readonly number[]
    codecString: string
    descriptionByteLength: number
    expectedOutputFrameCount: number
}>;

const EXPECTED_VECTORS: Readonly<Record<NativeSurroundAudioCapabilityVectorCodec, ExpectedVector>> = Object.freeze({
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

describe('native surround audio capability vectors', () => {
    it.each(Object.entries(EXPECTED_VECTORS))(
        'creates the exact %s 5.1 decoder vector',
        (codecValue, expectedVector) => {
            const codec = codecValue as NativeSurroundAudioCapabilityVectorCodec;
            const vector = createNativeSurroundAudioCapabilityVector(codec);

            expect(vector).toMatchObject({
                codec,
                codecString: expectedVector.codecString,
                expectedOutputFrameCount: expectedVector.expectedOutputFrameCount,
                expectedOutputTimestamp: 0,
                numberOfChannels: NATIVE_SURROUND_AUDIO_CAPABILITY_VECTOR_CHANNEL_COUNT,
                sampleRate: NATIVE_SURROUND_AUDIO_CAPABILITY_VECTOR_SAMPLE_RATE
            });
            expect(vector.description).toHaveLength(expectedVector.descriptionByteLength);
            expect(vector.encodedChunks.map(chunk => chunk.data.byteLength)).toEqual(expectedVector.chunkByteLengths);
        }
    );

    it('returns independent mutable descriptions and packet arrays', () => {
        const firstVector = createNativeSurroundAudioCapabilityVector('vorbis');
        const secondVector = createNativeSurroundAudioCapabilityVector('vorbis');
        const descriptionFirstByte = secondVector.description[0];
        const packetFirstByte = secondVector.encodedChunks[0].data[0];

        firstVector.description[0] ^= 0xFF;
        firstVector.encodedChunks[0].data[0] ^= 0xFF;

        expect(secondVector.description[0]).toBe(descriptionFirstByte);
        expect(secondVector.encodedChunks[0].data[0]).toBe(packetFirstByte);
    });
});
