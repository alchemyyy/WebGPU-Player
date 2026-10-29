// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
    createNativeSevenPointOneAudioCapabilityVector,
    NATIVE_SEVEN_POINT_ONE_AUDIO_CAPABILITY_VECTOR_CHANNEL_TONES,
    NATIVE_SEVEN_POINT_ONE_AUDIO_CAPABILITY_VECTOR_CODECS
} from 'webgpu-player/capability/vectors/NativeSevenPointOneAudioCapabilityVectors';

const LFE_CHANNEL_INDEX = 3;
const VORBIS_IDENTIFICATION_HEADER = [ 0x01, 0x76, 0x6F, 0x72, 0x62, 0x69, 0x73 ];
// After the packet type and "vorbis", the 32-bit version precedes the channel count
const VORBIS_CHANNEL_COUNT_OFFSET = 11;

function findSequence(bytes: Uint8Array, sequence: readonly number[]): number {
    for (let start = 0; start + sequence.length <= bytes.length; start += 1) {
        if (sequence.every((byte: number, index: number): boolean => bytes[start + index] === byte)) {
            return start;
        }
    }
    return -1;
}

/** Reads the channel count each codec's decoder description declares. */
function readDeclaredChannelCount(codec: string, description: Uint8Array): number {
    switch (codec) {
        case 'aac':
            // AudioSpecificConfig: 5-bit object type, 4-bit sampling frequency index, 4-bit channel configuration
            return (description[1] >> 3) & 0x0F;
        case 'opus':
            return description[9];
        case 'flac':
            // fLaC, the STREAMINFO block header, then 10 bytes of block and frame sizes and a 20-bit sample rate before channels minus one
            return ((description[20] >> 1) & 0x07) + 1;
        case 'vorbis': {
            const header = findSequence(description, VORBIS_IDENTIFICATION_HEADER);
            return header < 0 ? -1 : description[header + VORBIS_CHANNEL_COUNT_OFFSET];
        }
        default:
            return -1;
    }
}

describe('native 7.1 audio capability vectors', () => {
    it.each(NATIVE_SEVEN_POINT_ONE_AUDIO_CAPABILITY_VECTOR_CODECS)(
        'declares eight channels at 48 kHz in the %s decoder description',
        codec => {
            const vector = createNativeSevenPointOneAudioCapabilityVector(codec);

            expect(vector).toMatchObject({ codec, numberOfChannels: 8, sampleRate: 48_000 });
            // FFmpeg writes 7.1 AAC as channelConfiguration 7, and Opus at eight channels needs mapping family 1
            expect(readDeclaredChannelCount(codec, vector.description)).toBe(codec === 'aac' ? 7 : 8);
            if (codec === 'opus') {
                expect(vector.description[18]).toBe(1);
            }
            expect(vector.encodedChunks.length).toBeGreaterThan(0);
        }
    );

    it('gives every source channel its own tone, the LFE the only low one', () => {
        const frequencies = NATIVE_SEVEN_POINT_ONE_AUDIO_CAPABILITY_VECTOR_CHANNEL_TONES.map(tone => tone.frequency);

        expect(frequencies).toHaveLength(8);
        expect(new Set(frequencies).size).toBe(8);
        expect(frequencies[LFE_CHANNEL_INDEX]).toBeLessThan(120);
        expect(frequencies.filter((frequency: number): boolean => frequency < 120)).toHaveLength(1);
    });

    it('returns independent mutable descriptions and packet arrays', () => {
        const firstVector = createNativeSevenPointOneAudioCapabilityVector('opus');
        const secondVector = createNativeSevenPointOneAudioCapabilityVector('opus');
        const descriptionFirstByte = secondVector.description[0];
        const packetFirstByte = secondVector.encodedChunks[0].data[0];

        firstVector.description[0] ^= 0xFF;
        firstVector.encodedChunks[0].data[0] ^= 0xFF;

        expect(secondVector.description[0]).toBe(descriptionFirstByte);
        expect(secondVector.encodedChunks[0].data[0]).toBe(packetFirstByte);
    });
});
