// @vitest-environment node

import { beforeAll, describe, expect, it } from 'vitest';

import { createTrueHDExactCapabilityVectors, type TrueHDExactCapabilityVector } from '#codec_vector_assets/truehd/TrueHDExactCapabilityVectors';
import AudioDecoderPackageInstance, {
    findMissingAudioDecoderExports,
    isAudioDecoderModuleSource,
    type AudioDecoderModuleSource
} from 'webgpu-player/decode/audio/AudioDecoderPackageInstance';
import PackageSoftwareAudioDecoder from 'webgpu-player/decode/audio/PackageSoftwareAudioDecoder';

import { requireDecodedBlocks } from '../../../test/helpers/audioDecoderPackageResults';
import { loadDecoderProjectAudioSource } from '../../../test/helpers/decoderPackages';

const PROJECT = 'truehd';
// The codecs the package decodes, by the names its manifest gives them
const MLP_CODEC = 'mlp';
const TRUEHD_CODEC = 'truehd';
const DECODER_NAME = 'TrueHD';
const LIBRARY_VERSION_ATTRIBUTE = 'libraryVersion';
const BITS_PER_SAMPLE_ATTRIBUTE = 'bitsPerSample';
const PCM_FINGERPRINT_ATTRIBUTE = 'pcmFingerprint';
const PCM_FINGERPRINT_OPTION = 'pcmFingerprint';
const OPTION_ENABLED = 1;
const SAMPLE_RATE = 48_000;
const STEREO_CHANNEL_COUNT = 2;
const STEREO_LAYOUT_ID = 'stereo';
const TWENTY_FOUR_BITS_PER_SAMPLE = 24;
const CODEC_PRIVATE_BYTES = Uint8Array.of(1, 2, 3, 4);

let source: AudioDecoderModuleSource;
let vector: TrueHDExactCapabilityVector;

beforeAll(async () => {
    source = await loadDecoderProjectAudioSource(PROJECT);
    const stereoVector = createTrueHDExactCapabilityVectors().find(candidate => (
        candidate.codec === TRUEHD_CODEC && candidate.sampleRate === SAMPLE_RATE && candidate.channelCount === STEREO_CHANNEL_COUNT
    ));
    if (!stereoVector) {
        throw new Error('The TrueHD vectors have no 48 kHz stereo stream');
    }
    vector = stereoVector;
});

describe('the TrueHD package on AudioDecoderPackageInstance', () => {
    it('has every export of the interface, and a source the engine accepts', () => {
        expect(findMissingAudioDecoderExports(source.module)).toEqual([]);
        expect(isAudioDecoderModuleSource(source)).toBe(true);
    });

    it.each([ MLP_CODEC, TRUEHD_CODEC ])('creates a %s decoder that reports its library version', async (codec) => {
        const instance = await AudioDecoderPackageInstance.create(source, codec);

        expect(Number.isSafeInteger(instance.readAttribute(LIBRARY_VERSION_ATTRIBUTE))).toBe(true);
        expect(instance.readAttribute(LIBRARY_VERSION_ATTRIBUTE)).toBeGreaterThan(0);
        instance.close();
    });

    it('sets an option by its manifest name, and reports what it enables as an attribute of each block', async () => {
        const fingerprinting = await AudioDecoderPackageInstance.create(source, TRUEHD_CODEC);
        const playing = await AudioDecoderPackageInstance.create(source, TRUEHD_CODEC);
        fingerprinting.setOption(PCM_FINGERPRINT_OPTION, OPTION_ENABLED);

        for (const [ accessUnitIndex, accessUnit ] of vector.accessUnits.entries()) {
            const expected = vector.expectedOutputs[accessUnitIndex];
            const [ fingerprintedBlock ] = requireDecodedBlocks(fingerprinting.decode(accessUnit, expected.mediaTimeMicroseconds));
            const [ playedBlock ] = requireDecodedBlocks(playing.decode(accessUnit, expected.mediaTimeMicroseconds));

            expect(fingerprintedBlock.attributes.get(PCM_FINGERPRINT_ATTRIBUTE)).toBe(expected.pcmFingerprint);
            expect(fingerprintedBlock.attributes.get(BITS_PER_SAMPLE_ATTRIBUTE)).toBe(TWENTY_FOUR_BITS_PER_SAMPLE);
            expect(fingerprintedBlock).toMatchObject({ frameCount: expected.frameCount, timestampMicroseconds: expected.mediaTimeMicroseconds });
            expect(playedBlock.attributes.has(PCM_FINGERPRINT_ATTRIBUTE)).toBe(false);
            expect(playedBlock.channelData).toEqual(fingerprintedBlock.channelData);
        }
        // Outside a block, an attribute reads the decoder's latest value
        expect(fingerprinting.readAttribute(PCM_FINGERPRINT_ATTRIBUTE)).toBe(vector.expectedOutputs.at(-1)?.pcmFingerprint);
        expect(playing.readAttribute(PCM_FINGERPRINT_ATTRIBUTE)).toBeNull();
        fingerprinting.close();
        playing.close();
    });

    it('reports a dropped packet, and one a decoder accepts without output, as distinct outcomes', async () => {
        const mlp = await AudioDecoderPackageInstance.create(source, MLP_CODEC);
        const trueHD = await AudioDecoderPackageInstance.create(source, TRUEHD_CODEC);
        const dependentAccessUnit = vector.accessUnits[vector.majorSyncRecoveryStartIndex];

        // The MLP decoder refuses TrueHD's major sync
        expect(mlp.decode(vector.accessUnits[0], 0)).toEqual({ kind: 'dropped' });
        // A dependent access unit before any major sync decodes to nothing
        expect(trueHD.decode(dependentAccessUnit, 0)).toEqual({ blocks: [], kind: 'decoded' });
        mlp.close();
        trueHD.close();
    });

    it('decodes from a clean state after clear, and refuses every call once closed', async () => {
        const instance = await AudioDecoderPackageInstance.create(source, TRUEHD_CODEC);
        const [ firstAccessUnit ] = vector.accessUnits;
        const [ firstExpected ] = vector.expectedOutputs;
        instance.decode(firstAccessUnit, firstExpected.mediaTimeMicroseconds);

        instance.clear();
        expect(requireDecodedBlocks(instance.decode(firstAccessUnit, firstExpected.mediaTimeMicroseconds))).toHaveLength(1);
        instance.close();
        instance.close();

        const closedError = new Error(`audio decoder ${DECODER_NAME} is closed`);
        expect(() => instance.clear()).toThrow(closedError);
        expect(() => instance.configure(CODEC_PRIVATE_BYTES)).toThrow(closedError);
        expect(() => instance.decode(firstAccessUnit, firstExpected.mediaTimeMicroseconds)).toThrow(closedError);
        expect(() => instance.readAttribute(LIBRARY_VERSION_ATTRIBUTE)).toThrow(closedError);
        expect(() => instance.setOption(PCM_FINGERPRINT_OPTION, OPTION_ENABLED)).toThrow(closedError);
    });
});

describe('the TrueHD package on PackageSoftwareAudioDecoder', () => {
    it('decodes TrueHD access units at the timestamps native FFmpeg gives them', async () => {
        const decoder = await PackageSoftwareAudioDecoder.create(source, TRUEHD_CODEC);

        const outputs = vector.accessUnits.flatMap((data: Uint8Array, accessUnitIndex: number) => [
            ...decoder.decode(data, vector.expectedOutputs[accessUnitIndex].mediaTimeMicroseconds)
        ]);

        expect(outputs.map(({ frameCount, mediaTimeMicroseconds }) => ({ frameCount, mediaTimeMicroseconds })))
            .toEqual(vector.expectedOutputs.map(({ frameCount, mediaTimeMicroseconds }) => ({ frameCount, mediaTimeMicroseconds })));
        expect(outputs.every(output => output.channelLayout.id === STEREO_LAYOUT_ID && output.sampleRate === vector.sampleRate)).toBe(true);
        decoder.close();
    });
});
