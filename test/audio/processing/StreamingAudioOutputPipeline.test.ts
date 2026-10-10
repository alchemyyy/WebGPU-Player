import { describe, expect, it } from 'vitest';

import { downmixSevenPointOneToStereo } from 'webgpu-player/audio/processing/CustomAudioDownmix';
import { CUSTOM_AUDIO_LIMITER_CEILING_GAIN } from 'webgpu-player/audio/processing/StreamingAudioLookaheadLimiter';
import StreamingAudioOutputPipeline, {
    type StreamingAudioResamplerOutput
} from 'webgpu-player/audio/processing/StreamingAudioOutputPipeline';
import { requireMicroseconds } from 'webgpu-player/TimeMath';

const SAMPLE_RATE = 48_000;
// A malformed source rate; any positive integer rate is valid
const ZERO_SAMPLE_RATE = 0;
const MALFORMED_SOURCE_RATE_ERROR = 'Source sample rate must be a positive integer number of Hz';
const FINALIZED_PIPELINE_ERROR = 'Cannot add audio after output pipeline finalization';
const CLOSED_PIPELINE_SOURCE_SAMPLE_RATE = 44_100;
const CLOSED_PIPELINE_INPUT_FRAME_COUNT = 4_410;
const CLOSED_PIPELINE_INPUT_SAMPLE = 0.5;

function createPipeline(
    peakLimiterEnabled: boolean,
    sourceSampleRate = SAMPLE_RATE
): StreamingAudioOutputPipeline {
    return new StreamingAudioOutputPipeline({
        channelCount: 2,
        maximumOutputFrameCount: 1_920,
        maximumTimestampQuantizationMicroseconds: 1_000,
        minimumOutputFrameCount: 1,
        peakLimiterEnabled,
        sourceSampleRate,
        targetSampleRate: SAMPLE_RATE
    });
}

function getOutputFrameCount(outputs: readonly StreamingAudioResamplerOutput[]): number {
    return outputs.reduce((sum, output) => sum + output.frameCount, 0);
}

function getMaximumPeak(outputs: readonly StreamingAudioResamplerOutput[]): number {
    let maximumPeak = 0;
    for (const output of outputs) {
        for (const channel of output.channelData) {
            for (const sample of channel) {
                maximumPeak = Math.max(maximumPeak, Math.abs(sample));
            }
        }
    }
    return maximumPeak;
}

describe('StreamingAudioOutputPipeline', () => {
    it('leaves ordinary decoded stereo on the direct resampler path', () => {
        const pipeline = createPipeline(false);
        const inputChannel = new Float32Array([ 0.25, 1.5, -0.5 ]);
        const output = pipeline.push({
            channelData: [ inputChannel, inputChannel ],
            mediaTimeMicroseconds: requireMicroseconds(2_000_000)
        });

        expect(getOutputFrameCount(output)).toBe(inputChannel.length);
        expect(getMaximumPeak(output)).toBe(1.5);
        expect(pipeline.finalize()).toEqual([]);
        expect(pipeline.finalize()).toEqual([]);
        expect(pipeline.getTelemetry()).toMatchObject({
            peakLimiterEnabled: false,
            resampler: {
                finalized: true,
                outputFrameCount: inputChannel.length,
                sourceFrameCount: inputChannel.length
            }
        });
    });

    it('drains the resampler before the retained limiter tail at EOS', () => {
        const sourceSampleRate = 96_000;
        const pipeline = createPipeline(true, sourceSampleRate);
        const frameCount = 8_000;
        const left = new Float32Array(frameCount);
        const right = new Float32Array(frameCount);
        left.fill(0.25);
        right.fill(0.25);
        right[frameCount - 1] = 3;

        expect(pipeline.push({
            channelData: [ left, right ],
            mediaTimeMicroseconds: requireMicroseconds(3_000_000)
        })).toEqual([]);
        const terminalOutput = pipeline.finalize();

        expect(getOutputFrameCount(terminalOutput)).toBe(frameCount / 2);
        expect(getMaximumPeak(terminalOutput))
            .toBeLessThanOrEqual(CUSTOM_AUDIO_LIMITER_CEILING_GAIN + 1e-6);
        expect(terminalOutput[0].mediaTimeMicroseconds).toBe(3_000_000);
        expect(pipeline.finalize()).toEqual([]);
        expect(() => pipeline.push({
            channelData: [ new Float32Array([ 0 ]), new Float32Array([ 0 ]) ],
            mediaTimeMicroseconds: requireMicroseconds(4_000_000)
        })).toThrow('Cannot add audio after output pipeline finalization');
    });

    it('preserves normal 7.1 program gain and limits only an overloaded downmix', () => {
        const pipeline = createPipeline(true);
        const frameCount = 12_000;
        const peakFrame = 6_000;
        const inputChannels: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < 8; channelIndex += 1) {
            inputChannels.push(new Float32Array(frameCount));
        }
        inputChannels[0].fill(0.5);
        inputChannels[1].fill(0.5);
        for (let channelIndex = 0; channelIndex < inputChannels.length; channelIndex += 1) {
            if (channelIndex !== 3) {
                inputChannels[channelIndex][peakFrame] = 1;
            }
        }
        const downmixedChannels = downmixSevenPointOneToStereo(inputChannels);

        const outputs = pipeline.push({
            channelData: downmixedChannels,
            mediaTimeMicroseconds: requireMicroseconds(5_000_000)
        });
        outputs.push(...pipeline.finalize());
        const outputLeft = new Float32Array(frameCount);
        let outputFrameOffset = 0;
        for (const output of outputs) {
            outputLeft.set(output.channelData[0], outputFrameOffset);
            outputFrameOffset += output.frameCount;
        }

        expect(outputFrameOffset).toBe(frameCount);
        expect(downmixedChannels[0][0]).toBe(0.5);
        expect(outputLeft[0]).toBe(0.5);
        expect(outputLeft[peakFrame - 1_000]).toBe(0.5);
        expect(Math.abs(outputLeft[peakFrame]))
            .toBeLessThanOrEqual(CUSTOM_AUDIO_LIMITER_CEILING_GAIN + 1e-6);
        expect(getMaximumPeak(outputs))
            .toBeLessThanOrEqual(CUSTOM_AUDIO_LIMITER_CEILING_GAIN + 1e-6);
    });

    it('does not carry limiter gain into a replacement playback generation', () => {
        const retiredPipeline = createPipeline(true);
        const overloaded = new Float32Array(6_000);
        overloaded.fill(2);
        retiredPipeline.push({
            channelData: [ overloaded, overloaded ],
            mediaTimeMicroseconds: requireMicroseconds(0)
        });

        const replacementPipeline = createPipeline(true);
        const safe = new Float32Array(6_000);
        safe.fill(0.5);
        const replacementOutput = replacementPipeline.push({
            channelData: [ safe, safe ],
            mediaTimeMicroseconds: requireMicroseconds(10_000_000)
        });

        expect(replacementOutput[0].channelData[0][0]).toBe(0.5);
    });

    it.each([ false, true ])(
        'keeps output contiguous across a 24 kHz to 48 kHz source change with limiter %s',
        peakLimiterEnabled => {
            const pipeline = createPipeline(peakLimiterEnabled, 24_000);
            const halfRateInput = new Float32Array(2_400).fill(0.25);
            const fullRateInput = new Float32Array(4_800).fill(0.25);
            const outputs = pipeline.push({
                channelData: [ halfRateInput, halfRateInput ],
                mediaTimeMicroseconds: requireMicroseconds(1_000_000)
            });
            outputs.push(...pipeline.changeSourceSampleRate(48_000));
            outputs.push(...pipeline.push({
                channelData: [ fullRateInput, fullRateInput ],
                mediaTimeMicroseconds: requireMicroseconds(1_100_000)
            }));
            outputs.push(...pipeline.finalize());

            expect(getOutputFrameCount(outputs)).toBe(9_600);
            expect(outputs[0].mediaTimeMicroseconds).toBe(1_000_000);
            for (let outputIndex = 1; outputIndex < outputs.length; outputIndex += 1) {
                const previousOutput = outputs[outputIndex - 1];
                expect(Math.abs(
                    outputs[outputIndex].mediaTimeMicroseconds
                    - (previousOutput.mediaTimeMicroseconds + previousOutput.durationMicroseconds)
                )).toBeLessThanOrEqual(1);
            }
            expect(pipeline.getTelemetry()).toMatchObject({
                peakLimiterEnabled,
                resampler: {
                    absorbedInputCount: 0,
                    filledInputCount: 0,
                    finalized: true,
                    sourceFrameCount: 4_800
                },
                sourceSampleRateChangeCount: 1
            });
        }
    );

    it('ignores a source change to the bound rate', () => {
        const pipeline = createPipeline(false);
        pipeline.push({
            channelData: [ new Float32Array(480), new Float32Array(480) ],
            mediaTimeMicroseconds: requireMicroseconds(0)
        });

        expect(pipeline.changeSourceSampleRate(SAMPLE_RATE)).toEqual([]);
        expect(pipeline.getTelemetry().sourceSampleRateChangeCount).toBe(0);
        expect(() => pipeline.changeSourceSampleRate(ZERO_SAMPLE_RATE)).toThrow(
            MALFORMED_SOURCE_RATE_ERROR
        );
    });

    it('routes later output through a lazily enabled limiter anchored at its first input', () => {
        const pipeline = createPipeline(false);
        const safe = new Float32Array(4_800).fill(0.25);
        const outputs = pipeline.push({
            channelData: [ safe, safe ],
            mediaTimeMicroseconds: requireMicroseconds(0)
        });
        expect(pipeline.getTelemetry().peakLimiterEnabled).toBe(false);

        pipeline.enablePeakLimiter();
        pipeline.enablePeakLimiter();
        const overloaded = new Float32Array(9_600).fill(2);
        outputs.push(...pipeline.push({
            channelData: [ overloaded, overloaded ],
            mediaTimeMicroseconds: requireMicroseconds(100_000)
        }));
        outputs.push(...pipeline.finalize());

        expect(pipeline.getTelemetry().peakLimiterEnabled).toBe(true);
        expect(getOutputFrameCount(outputs)).toBe(14_400);
        expect(outputs[0].channelData[0][0]).toBe(0.25);
        expect(getMaximumPeak(outputs.slice(1)))
            .toBeLessThanOrEqual(CUSTOM_AUDIO_LIMITER_CEILING_GAIN + 1e-6);
        for (let outputIndex = 1; outputIndex < outputs.length; outputIndex += 1) {
            const previousOutput = outputs[outputIndex - 1];
            expect(Math.abs(
                outputs[outputIndex].mediaTimeMicroseconds
                - (previousOutput.mediaTimeMicroseconds + previousOutput.durationMicroseconds)
            )).toBeLessThanOrEqual(1);
        }
    });

    it('keeps the limiter active before a later live gain boost', () => {
        const pipeline = createPipeline(true);
        const safe = new Float32Array(6_000);
        safe.fill(0.25);
        const outputs = pipeline.push({
            channelData: [ safe, safe ],
            mediaTimeMicroseconds: requireMicroseconds(0)
        });

        expect(pipeline.getTelemetry().peakLimiterEnabled).toBe(true);
        const boosted = new Float32Array(6_000);
        boosted.fill(3);
        outputs.push(...pipeline.push({
            channelData: [ boosted, boosted ],
            mediaTimeMicroseconds: requireMicroseconds(125_000)
        }));
        outputs.push(...pipeline.finalize());

        expect(getOutputFrameCount(outputs)).toBe(12_000);
        expect(getMaximumPeak(outputs))
            .toBeLessThanOrEqual(CUSTOM_AUDIO_LIMITER_CEILING_GAIN + 1e-6);
    });

    it('ends without its tails when an attempt closes it early', () => {
        const pipeline = createPipeline(true, CLOSED_PIPELINE_SOURCE_SAMPLE_RATE);
        const inputChannel = new Float32Array(CLOSED_PIPELINE_INPUT_FRAME_COUNT).fill(CLOSED_PIPELINE_INPUT_SAMPLE);
        pipeline.push({ channelData: [ inputChannel, inputChannel ], mediaTimeMicroseconds: requireMicroseconds(0) });

        pipeline.close();
        pipeline.close();

        expect(pipeline.finalize()).toEqual([]);
        expect(() => pipeline.push({
            channelData: [ inputChannel, inputChannel ],
            mediaTimeMicroseconds: requireMicroseconds(0)
        })).toThrow(FINALIZED_PIPELINE_ERROR);
        expect(() => pipeline.changeSourceSampleRate(SAMPLE_RATE)).toThrow('after output pipeline finalization');
    });
});
