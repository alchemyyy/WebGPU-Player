// @vitest-environment node

import {
    AiffInputFormat,
    AiffOutputFormat,
    AudioSample,
    AudioSampleSink,
    AudioSampleSource,
    BufferSource,
    BufferTarget,
    Input,
    Output
} from 'mediabunny';
import { describe, expect, it } from 'vitest';

import { isCustomPlaybackContainer } from 'webgpu-player/capability/CustomContainerCodecSupport';
import { CUSTOM_DECODE_INPUT_FORMATS } from 'webgpu-player/demux/CustomDecodeInputFormats';

const SAMPLE_RATE = 48_000;
const CHANNEL_COUNT = 1;
const SAMPLES = new Float32Array([ 0, 0.25, -0.25, 0.5, -0.5 ]);
// 16-bit PCM keeps each sample within one quantization step
const SAMPLE_TOLERANCE = 1 / 32_768;
const AIFF_CODEC = 'pcm-s16be';
const AIFF_CONTAINER = 'aiff';

/** A big-endian 16-bit AIFF file of the samples, written by the fork's AIFF muxer. */
async function createAIFF(): Promise<ArrayBuffer> {
    const target = new BufferTarget();
    const output = new Output({ format: new AiffOutputFormat(), target });
    const source = new AudioSampleSource({ codec: AIFF_CODEC });
    output.addAudioTrack(source);
    await output.start();
    const sample = new AudioSample({
        data: SAMPLES,
        format: 'f32-planar',
        numberOfChannels: CHANNEL_COUNT,
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
        throw new Error('The AIFF muxer wrote nothing');
    }
    return target.buffer;
}

describe('AIFF through the fork', () => {
    it('opens with the decode worker\'s input formats and decodes its PCM with Mediabunny', async () => {
        const input = new Input({ formats: CUSTOM_DECODE_INPUT_FORMATS, source: new BufferSource(await createAIFF()) });
        try {
            expect(await input.getFormat()).toBeInstanceOf(AiffInputFormat);
            const track = await input.getPrimaryAudioTrack();
            if (!track) {
                throw new Error('The AIFF file has no audio track');
            }
            expect(await track.getCodec()).toBe(AIFF_CODEC);
            expect(await track.canDecode()).toBe(true);

            const decodedSamples: number[] = [];
            for await (const decodedSample of new AudioSampleSink(track).samples()) {
                const channel = new Float32Array(decodedSample.numberOfFrames);
                decodedSample.copyTo(channel, { format: 'f32-planar', planeIndex: 0 });
                decodedSamples.push(...channel);
                decodedSample.close();
            }
            expect(decodedSamples).toHaveLength(SAMPLES.length);
            decodedSamples.forEach((decodedSample: number, sampleIndex: number): void => {
                expect(Math.abs(decodedSample - SAMPLES[sampleIndex])).toBeLessThanOrEqual(SAMPLE_TOLERANCE);
            });
        } finally {
            input.dispose();
        }
    });

    it('leaves AIFF items to the host, as the custom path plays only items with video', () => {
        expect(isCustomPlaybackContainer(AIFF_CONTAINER)).toBe(false);
    });
});
