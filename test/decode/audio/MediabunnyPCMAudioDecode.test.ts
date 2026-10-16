import { describe, expect, it } from 'vitest';
import {
    ALL_FORMATS,
    AudioSample,
    AudioSampleCursor,
    AudioSampleSource,
    BufferSource,
    BufferTarget,
    Input,
    MovOutputFormat,
    Output,
    type AudioCodec
} from 'mediabunny';

import { MEDIABUNNY_PCM_DECODER_CODECS } from 'webgpu-player/audio/CustomAudioOutputPolicy';

const EXPECTED_SAMPLES = new Float32Array([ 0, 0.01, -0.02, 0.05, 0.1 ]);
const SAMPLE_RATE = 44_100;

function getCodecTolerance(codec: AudioCodec): number {
    switch (codec) {
        case 'pcm-u8':
            return 0.012;
        case 'pcm-s8':
            return 0.008;
        case 'ulaw':
        case 'alaw':
            return 0.002;
        case 'pcm-s16':
        case 'pcm-s16be':
            return 0.000_04;
        default:
            return 0.000_001;
    }
}

async function createPCMVector(codec: AudioCodec): Promise<ArrayBuffer> {
    const target = new BufferTarget();
    const output = new Output({
        format: new MovOutputFormat(),
        target
    });
    const source = new AudioSampleSource({ codec });
    output.addAudioTrack(source);
    await output.start();

    const sample = new AudioSample({
        data: EXPECTED_SAMPLES.buffer.slice(0),
        format: 'f32',
        numberOfChannels: 1,
        numberOfFrames: EXPECTED_SAMPLES.length,
        sampleRate: SAMPLE_RATE,
        timestamp: 0
    });
    try {
        await source.add(sample);
    } finally {
        sample.close();
        source.close();
    }
    await output.finalize();
    if (!target.buffer) {
        throw new Error('Mediabunny did not finalize the PCM vector');
    }
    return target.buffer;
}

describe('Mediabunny PCM audio decode integration', () => {
    it.each(MEDIABUNNY_PCM_DECODER_CODECS)(
        'round-trips %s through the public MOV demux and AudioSampleCursor path',
        async codec => {
            // Mediabunny 1.61 counts its own mu-law and A-law decoders in canDecode(), so nothing is registered first
            const vector = await createPCMVector(codec);
            const input = new Input({
                formats: ALL_FORMATS,
                source: new BufferSource(vector)
            });
            try {
                const track = await input.getPrimaryAudioTrack();
                expect(track).not.toBeNull();
                if (!track) {
                    return;
                }
                expect(await track.getCodec()).toBe(codec);
                expect(await track.getNumberOfChannels()).toBe(1);
                expect(await track.getSampleRate()).toBe(SAMPLE_RATE);
                expect(await track.canDecode()).toBe(true);

                await using cursor = new AudioSampleCursor(track);
                const outputSamples: number[] = [];
                for await (const decodedSample of cursor) {
                    const channel = new Float32Array(decodedSample.numberOfFrames);
                    decodedSample.copyTo(channel, {
                        format: 'f32-planar',
                        planeIndex: 0
                    });
                    outputSamples.push(...channel);
                }

                expect(outputSamples).toHaveLength(EXPECTED_SAMPLES.length);
                const tolerance = getCodecTolerance(codec);
                for (let sampleIndex = 0; sampleIndex < EXPECTED_SAMPLES.length; sampleIndex += 1) {
                    expect(Math.abs(
                        outputSamples[sampleIndex] - EXPECTED_SAMPLES[sampleIndex]
                    )).toBeLessThanOrEqual(tolerance);
                }
            } finally {
                await input.dispose();
            }
        }
    );
});
