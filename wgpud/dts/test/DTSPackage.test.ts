// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import AudioDecoderPackageInstance, {
    AudioDecoderPackageError,
    findMissingAudioDecoderExports,
    isAudioDecoderModuleSource,
    type AudioDecoderModuleSource,
    type AudioDecoderPackageBlock
} from 'webgpu-player/decode/audio/AudioDecoderPackageInstance';
import PackageSoftwareAudioDecoder from 'webgpu-player/decode/audio/PackageSoftwareAudioDecoder';
import {
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE,
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ZERO_SIDE,
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
    CUSTOM_WAVE_CHANNEL_MASK_SIX_POINT_ONE,
    CUSTOM_WAVE_CHANNEL_MASK_STEREO,
    getQualifiedCustomWaveChannelLayout
} from 'webgpu-player/audio/processing/CustomWaveChannelLayout';
import { matchesNativeAudioChannelTones, type NativeAudioChannelTone } from 'webgpu-player/capability/NativeAudioChannelTones';
import { requireMicroseconds } from 'webgpu-player/TimeMath';

import {
    catchFailure,
    getAudioDecoderErrorCode,
    joinBlockPlanes,
    readContainerAudioPackets,
    requireDecodedBlocks
} from '../../../test/helpers/audioDecoderPackageResults';
import { loadDecoderProjectAudioSource } from '../../../test/helpers/decoderPackages';
import { TEST_VECTORS_DIRECTORY } from '../../../test/helpers/enginePaths';

type DTSVectorDefinition = Readonly<{
    expectedBitsPerSample: number
    expectedChannelMask: number
    expectedProfile: number
    expectedSampleRate: number
    packets: readonly (readonly [ number, number ])[]
}>;

const PROJECT = 'dts';
const DTS_CODEC = 'dts';
const DTS_VECTOR_DIRECTORY = 'dts';
const DTS_PACKETS_FILE_NAME = 'packets.json';
const LIBRARY_VERSION_ATTRIBUTE = 'libraryVersion';
const BITS_PER_SAMPLE_ATTRIBUTE = 'bitsPerSample';
const PROFILE_ATTRIBUTE = 'profile';
const CONVERT_ERROR = 'convert';
// libdcadec's DCADEC_EINVAL, which converting a one-byte packet fails with
const INVALID_ARGUMENT_STATUS = 1;
const SINGLE_BYTE_PACKET = Uint8Array.of(1);
const EMPTY_BYTES = new Uint8Array();
// The DTS-HD Master Audio 7.1 vector and the core 5.1 one, whose packets decode to 512-frame blocks
const MASTER_AUDIO_VECTOR_FILE_NAME = 'xll_71_24_48_768_0.dtshd';
const CORE_VECTOR_FILE_NAME = 'core_51_24_48_768_0.dtshd';
const DTS_BLOCK_FRAME_COUNT = 512;
const DTS_PACKET_TIME_MICROSECONDS = requireMicroseconds(250_000);
// The dcadec DTS-ES discrete 6.1 sample: a 5.1 core and its XCh back center
const DTS_ES_VECTOR_FILE_NAME = 'xch_61_24_48_768.dtshd';
// FFmpeg's DTS core encodes of one sine per channel (PROVENANCE.txt)
const CORE_STEREO_FILE_NAME = 'dts-core-stereo.mka';
const CORE_FIVE_POINT_ZERO_FILE_NAME = 'dts-core-5.0.mka';
const CORE_SAMPLE_RATE = 48_000;
// The vectors' tones in WAVE order, each kept near its 0.25 amplitude by the encoder
const CORE_TONES: readonly NativeAudioChannelTone[] = [ 400, 600, 800, 1_000, 1_200 ].map(frequency => ({ frequency, minimumAmplitude: 0.125 }));
// The 6.1 planes in WAVE order: FL, FR, FC, LFE, BC, SL, SR
const LFE_PLANE = 3;
const BACK_CENTER_PLANE = 4;
const SIDE_LEFT_PLANE = 5;
const SIDE_RIGHT_PLANE = 6;

let source: AudioDecoderModuleSource;

function readDTSVectorPackets(fileName: string): { definition: DTSVectorDefinition, packets: Uint8Array[] } {
    const definitions = JSON.parse(
        readFileSync(resolve(TEST_VECTORS_DIRECTORY, DTS_VECTOR_DIRECTORY, DTS_PACKETS_FILE_NAME), 'utf8')
    ) as Record<string, DTSVectorDefinition>;
    const definition = definitions[fileName];
    const vector = new Uint8Array(readFileSync(resolve(TEST_VECTORS_DIRECTORY, DTS_VECTOR_DIRECTORY, fileName)));
    return {
        definition,
        packets: definition.packets.map(([ byteOffset, byteLength ]) => vector.slice(byteOffset, byteOffset + byteLength))
    };
}

beforeAll(async () => {
    source = await loadDecoderProjectAudioSource(PROJECT);
});

describe('the DTS package on AudioDecoderPackageInstance', () => {
    it('has every export of the interface, and a source the engine accepts', () => {
        expect(findMissingAudioDecoderExports(source.module)).toEqual([]);
        expect(isAudioDecoderModuleSource(source)).toBe(true);
    });

    it('creates a decoder that reports its library version', async () => {
        const instance = await AudioDecoderPackageInstance.create(source, DTS_CODEC);

        expect(Number.isSafeInteger(instance.readAttribute(LIBRARY_VERSION_ATTRIBUTE))).toBe(true);
        expect(instance.readAttribute(LIBRARY_VERSION_ATTRIBUTE)).toBeGreaterThan(0);
        instance.close();
    });

    it('decodes each Master Audio packet into one block, which continues its packet\'s timestamp', async () => {
        const { definition, packets } = readDTSVectorPackets(MASTER_AUDIO_VECTOR_FILE_NAME);
        const instance = await AudioDecoderPackageInstance.create(source, DTS_CODEC);

        for (const packet of packets) {
            const blocks = requireDecodedBlocks(instance.decode(packet, 0));

            expect(blocks).toHaveLength(1);
            expect(blocks[0]).toMatchObject({
                channelMask: definition.expectedChannelMask,
                frameCount: DTS_BLOCK_FRAME_COUNT,
                sampleRate: definition.expectedSampleRate,
                timestampMicroseconds: null
            });
            expect(blocks[0].channelMask).toBe(CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE);
            expect(blocks[0].attributes.get(BITS_PER_SAMPLE_ATTRIBUTE)).toBe(definition.expectedBitsPerSample);
            expect(blocks[0].attributes.get(PROFILE_ATTRIBUTE)).toBe(definition.expectedProfile);
        }
        instance.close();
    });

    it('refuses packets outside its manifest\'s bounds before the module sees them', async () => {
        const instance = await AudioDecoderPackageInstance.create(source, DTS_CODEC);
        const { packetByteLength } = source.manifest;

        expect(() => instance.decode(EMPTY_BYTES, 0)).toThrow(new RangeError(`audio packet of 0 bytes outside [1, ${packetByteLength}]`));
        expect(() => instance.decode(new Uint8Array(packetByteLength + 1), 0))
            .toThrow(new RangeError(`audio packet of ${packetByteLength + 1} bytes outside [1, ${packetByteLength}]`));
        instance.close();
    });

    it('reports a packet the module fails by the manifest\'s name of its error', async () => {
        const instance = await AudioDecoderPackageInstance.create(source, DTS_CODEC);

        const failure = catchFailure(() => instance.decode(SINGLE_BYTE_PACKET, 0));

        expect(failure).toBeInstanceOf(AudioDecoderPackageError);
        expect(failure).toMatchObject({
            code: getAudioDecoderErrorCode(source.manifest, CONVERT_ERROR),
            message: `audio decoder ${CONVERT_ERROR}: ${INVALID_ARGUMENT_STATUS}`,
            value: INVALID_ARGUMENT_STATUS
        });
        instance.close();
    });
});

describe('the DTS package on PackageSoftwareAudioDecoder', () => {
    it('starts a block, which has no timestamp of its own, at its packet\'s time', async () => {
        const [ firstPacket ] = readDTSVectorPackets(CORE_VECTOR_FILE_NAME).packets;
        const decoder = await PackageSoftwareAudioDecoder.create(source, DTS_CODEC, null);

        const outputs = decoder.decode(firstPacket, DTS_PACKET_TIME_MICROSECONDS);

        expect(outputs).toHaveLength(1);
        expect(outputs[0]).toMatchObject({
            channelMask: CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE,
            frameCount: DTS_BLOCK_FRAME_COUNT,
            mediaTimeMicroseconds: DTS_PACKET_TIME_MICROSECONDS
        });
        decoder.close();
    });
});

describe('the speaker masks the DTS package reports', () => {
    async function decodeContainerVector(fileName: string): Promise<readonly AudioDecoderPackageBlock[]> {
        const packets = await readContainerAudioPackets(new Uint8Array(readFileSync(resolve(TEST_VECTORS_DIRECTORY, DTS_VECTOR_DIRECTORY, fileName))));
        const instance = await AudioDecoderPackageInstance.create(source, DTS_CODEC);
        const blocks = packets.flatMap(packet => requireDecodedBlocks(instance.decode(packet.data, 0)));
        instance.close();
        return blocks;
    }

    it.each([
        { fileName: CORE_STEREO_FILE_NAME, mask: CUSTOM_WAVE_CHANNEL_MASK_STEREO, tones: CORE_TONES.slice(0, 2) },
        { fileName: CORE_FIVE_POINT_ZERO_FILE_NAME, mask: CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ZERO_SIDE, tones: CORE_TONES }
    ])('decodes the $fileName core to its own mask, with every tone in its WAVE place', async ({ fileName, mask, tones }) => {
        const blocks = await decodeContainerVector(fileName);

        expect(new Set(blocks.map(block => block.channelMask))).toEqual(new Set([ mask ]));
        expect(blocks.every(block => block.sampleRate === CORE_SAMPLE_RATE)).toBe(true);
        expect(matchesNativeAudioChannelTones(joinBlockPlanes(blocks), CORE_SAMPLE_RATE, tones)).toBe(true);
    });

    it('decodes DTS-ES discrete 6.1 to the WAVE 6.1 mask, a back center between the side pair, which the output stage lays out', async () => {
        const { packets } = readDTSVectorPackets(DTS_ES_VECTOR_FILE_NAME);
        const instance = await AudioDecoderPackageInstance.create(source, DTS_CODEC);
        const blocks = packets.flatMap(packet => requireDecodedBlocks(instance.decode(packet, 0)));
        instance.close();
        const planes = joinBlockPlanes(blocks);

        expect(new Set(blocks.map(block => block.channelMask))).toEqual(new Set([ CUSTOM_WAVE_CHANNEL_MASK_SIX_POINT_ONE ]));
        expect(getQualifiedCustomWaveChannelLayout(CUSTOM_WAVE_CHANNEL_MASK_SIX_POINT_ONE)?.layout.id).toBe('6.1');
        // The sample's side pair carries one signal, its XCh back center an uncorrelated one, and only the LFE plane is band-limited
        const correlate = (left: Float32Array, right: Float32Array): number => {
            const dot = (first: Float32Array, second: Float32Array): number => first.reduce((sum, sample, index) => sum + (sample * second[index]), 0);
            return dot(left, right) / Math.sqrt(dot(left, left) * dot(right, right));
        };
        expect(correlate(planes[SIDE_LEFT_PLANE], planes[SIDE_RIGHT_PLANE])).toBeGreaterThan(0.99);
        expect(Math.abs(correlate(planes[BACK_CENTER_PLANE], planes[SIDE_LEFT_PLANE]))).toBeLessThan(0.1);
        const meanStep = (plane: Float32Array): number => plane.slice(1).reduce((sum, sample, index) => sum + Math.abs(sample - plane[index]), 0) / plane.length;
        expect(meanStep(planes[LFE_PLANE]) * 10).toBeLessThan(Math.min(meanStep(planes[BACK_CENTER_PLANE]), meanStep(planes[SIDE_LEFT_PLANE])));
    });
});
