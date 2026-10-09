// @vitest-environment node

import {
    ALL_FORMATS,
    BufferSource,
    EncodedPacketSink,
    Input
} from 'mediabunny';
import { describe, expect, it } from 'vitest';

import EAC3SoftwareAudioDecoder, {
    loadEAC3DecoderModule,
    type EAC3DecodedAudioOutput
} from 'webgpu-player/audio/decoders/EAC3SoftwareAudioDecoder';
import { CUSTOM_WAVE_CHANNEL_MASK_STEREO } from 'webgpu-player/audio/processing/CustomWaveChannelLayout';
import { createNativeMediaAudioProbeVector } from 'webgpu-player/capability/vectors/NativeMediaAudioCapabilityVectors';
import { EAC3_DECODER_WASM_ASSET } from 'webgpu-player/EngineAssets';
import { requireMicroseconds } from 'webgpu-player/TimeMath';

import { readDecoderWASMSource } from '../../helpers/libraryAssets';

const VECTOR_CHANNEL_COUNT = 2;
const VECTOR_SAMPLE_RATE = 48_000;
// Every E-AC-3 audio block decodes to 256 frames
const EAC3_BLOCK_FRAME_COUNT = 256;

describe('EAC3SoftwareAudioDecoder WebAssembly integration', () => {
    it('decodes the stereo E-AC-3 vector with the served binary', async () => {
        await loadEAC3DecoderModule(await readDecoderWASMSource(EAC3_DECODER_WASM_ASSET));
        const input = new Input({
            formats: ALL_FORMATS,
            source: new BufferSource(createNativeMediaAudioProbeVector('eac3', VECTOR_CHANNEL_COUNT))
        });
        const decoder = await EAC3SoftwareAudioDecoder.create();

        try {
            const tracks = await input.getAudioTracks();
            expect(tracks).toHaveLength(1);
            const outputs: EAC3DecodedAudioOutput[] = [];
            for await (const packet of new EncodedPacketSink(tracks[0]).packets()) {
                outputs.push(...decoder.decode(packet.data, requireMicroseconds(packet.microsecondTimestamp)));
            }

            expect(decoder.libraryVersion).toBeGreaterThan(0);
            expect(outputs.length).toBeGreaterThan(0);
            for (const output of outputs) {
                expect(output).toMatchObject({
                    channelMask: CUSTOM_WAVE_CHANNEL_MASK_STEREO,
                    sampleRate: VECTOR_SAMPLE_RATE
                });
                expect(output.channelData).toHaveLength(VECTOR_CHANNEL_COUNT);
                expect(output.frameCount % EAC3_BLOCK_FRAME_COUNT).toBe(0);
            }
        } finally {
            decoder.close();
        }
    });
});
