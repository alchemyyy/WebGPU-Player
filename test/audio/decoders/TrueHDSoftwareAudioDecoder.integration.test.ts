import { beforeAll, describe, expect, it } from 'vitest';

import { createTrueHDExactCapabilityVectors } from '#codec_vector_assets/truehd/TrueHDExactCapabilityVectors';
import TrueHDSoftwareAudioDecoder, {
    loadTrueHDDecoderModule,
    type TrueHDDecodedAudioOutput
} from 'webgpu-player/audio/decoders/TrueHDSoftwareAudioDecoder';
import { TRUEHD_DECODER_WASM_ASSET } from 'webgpu-player/EngineAssets';

import { readDecoderWASMSource } from '../../helpers/libraryAssets';

beforeAll(async () => {
    // The served binary, which the decoders below reuse
    await loadTrueHDDecoderModule(await readDecoderWASMSource(TRUEHD_DECODER_WASM_ASSET));
});

describe('TrueHDSoftwareAudioDecoder WebAssembly integration', () => {
    it('matches native FFmpeg PCM for every synthetic qualification frame', async () => {
        const vectors = createTrueHDExactCapabilityVectors();

        for (const vector of vectors) {
            const decoder = await TrueHDSoftwareAudioDecoder.create(vector.codec);
            try {
                const outputs: TrueHDDecodedAudioOutput[] = [];
                for (let accessUnitIndex = 0;
                    accessUnitIndex < vector.accessUnits.length;
                    accessUnitIndex += 1) {
                    outputs.push(...decoder.decode(
                        vector.accessUnits[accessUnitIndex],
                        vector.expectedOutputs[accessUnitIndex].mediaTimeMicroseconds
                    ));
                }

                expect(outputs).toHaveLength(vector.expectedOutputs.length);
                for (let outputIndex = 0;
                    outputIndex < vector.expectedOutputs.length;
                    outputIndex += 1) {
                    const output = outputs[outputIndex];
                    const expected = vector.expectedOutputs[outputIndex];
                    expect(output).toMatchObject({
                        bitsPerSample: vector.bitsPerSample,
                        channelMask: vector.channelMask,
                        codec: vector.codec,
                        frameCount: expected.frameCount,
                        losslessChannelBed: true,
                        mediaTimeMicroseconds: expected.mediaTimeMicroseconds,
                        objectAudioRendered: false,
                        pcmFingerprint: expected.pcmFingerprint,
                        sampleRate: vector.sampleRate
                    });
                }
            } finally {
                decoder.close();
            }
        }
    }, 30_000);

    it('recovers at the next major sync after starting on a dependent frame', async () => {
        const vector = createTrueHDExactCapabilityVectors().find(
            candidate => candidate.codec === 'truehd' && candidate.sampleRate === 48_000
        );
        expect(vector).toBeDefined();
        if (!vector) {
            return;
        }
        const decoder = await TrueHDSoftwareAudioDecoder.create('truehd');
        try {
            const outputs: TrueHDDecodedAudioOutput[] = [];
            for (let accessUnitIndex = vector.majorSyncRecoveryStartIndex;
                accessUnitIndex < vector.accessUnits.length;
                accessUnitIndex += 1) {
                outputs.push(...decoder.decode(
                    vector.accessUnits[accessUnitIndex],
                    vector.expectedOutputs[accessUnitIndex].mediaTimeMicroseconds
                ));
            }

            expect(outputs.length).toBeGreaterThan(0);
            const firstExpectedOutput = vector.expectedOutputs.find(expected => (
                expected.mediaTimeMicroseconds === outputs[0].mediaTimeMicroseconds
            ));
            expect(firstExpectedOutput).toBeDefined();
            expect(outputs[0].pcmFingerprint).toBe(firstExpectedOutput?.pcmFingerprint);
        } finally {
            decoder.close();
        }
    }, 30_000);
});
