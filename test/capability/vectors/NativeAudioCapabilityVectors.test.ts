// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
    createNativeAudioCapabilityVector,
    NATIVE_AUDIO_CAPABILITY_VECTOR_CHANNEL_COUNT,
    NATIVE_AUDIO_CAPABILITY_VECTOR_SAMPLE_RATE,
    type NativeAudioCapabilityVectorCodec
} from 'webgpu-player/capability/vectors/NativeAudioCapabilityVectors';

type ExpectedVector = Readonly<{
    chunkByteLengths: readonly number[]
    codecString: string
    descriptionByteLength: number | null
    expectedOutputFrameCount: number
}>;

const EXPECTED_VECTORS: Readonly<Record<NativeAudioCapabilityVectorCodec, ExpectedVector>> = Object.freeze({
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

describe('native audio capability vectors', () => {
    it.each(Object.entries(EXPECTED_VECTORS))(
        'creates the exact %s decoder vector',
        (codecValue, expectedVector) => {
            const codec = codecValue as NativeAudioCapabilityVectorCodec;
            const vector = createNativeAudioCapabilityVector(codec);

            expect(vector).toMatchObject({
                codec,
                codecString: expectedVector.codecString,
                expectedOutputFrameCount: expectedVector.expectedOutputFrameCount,
                expectedOutputTimestamp: 0,
                numberOfChannels: NATIVE_AUDIO_CAPABILITY_VECTOR_CHANNEL_COUNT,
                sampleRate: NATIVE_AUDIO_CAPABILITY_VECTOR_SAMPLE_RATE
            });
            if (expectedVector.descriptionByteLength === null) {
                expect(vector.description).toBeNull();
            } else {
                expect(vector.description).toHaveLength(expectedVector.descriptionByteLength);
            }
            expect(vector.encodedChunks.map(chunk => chunk.data.byteLength)).toEqual(expectedVector.chunkByteLengths);
        }
    );

    it('returns independent mutable descriptions and packet arrays', () => {
        const firstVector = createNativeAudioCapabilityVector('vorbis');
        const secondVector = createNativeAudioCapabilityVector('vorbis');
        const descriptionFirstByte = secondVector.description?.[0];
        const packetFirstByte = secondVector.encodedChunks[0].data[0];

        if (firstVector.description) {
            firstVector.description[0] ^= 0xFF;
        }
        firstVector.encodedChunks[0].data[0] ^= 0xFF;

        expect(secondVector.description?.[0]).toBe(descriptionFirstByte);
        expect(secondVector.encodedChunks[0].data[0]).toBe(packetFirstByte);
    });
});
