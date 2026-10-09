import { describe, expect, it, vi } from 'vitest';

import {
    CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_STEREO_CHANNEL_LAYOUT,
    CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT,
    CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT,
    type CustomAudioOutputChannelCount
} from 'webgpu-player/audio/processing/CustomAudioChannelLayout';
import DecodedAudioOutputStage, {
    UnsupportedDecodedAudioFormatError,
    type DecodedAudioSourceFormat
} from 'webgpu-player/audio/processing/DecodedAudioOutputStage';
import type StreamingAudioDownmixSettings from 'webgpu-player/audio/processing/StreamingAudioDownmixSettings';
import { CUSTOM_AUDIO_LIMITER_CEILING_GAIN } from 'webgpu-player/audio/processing/StreamingAudioLookaheadLimiter';
import type { StreamingAudioResamplerOutput } from 'webgpu-player/audio/processing/StreamingAudioOutputPipeline';
import { audioFramesToMicroseconds, requireMicroseconds } from 'webgpu-player/TimeMath';

const OUTPUT_SAMPLE_RATE = 48_000;
// The decoded audio bridge accepts a chunk within one output frame of the previous chunk's end
const BRIDGE_CONTINUITY_TOLERANCE_MICROSECONDS = Math.ceil(1_000_000 / OUTPUT_SAMPLE_RATE);
const LIMITER_CEILING_TOLERANCE = 1e-6;
// A malformed decoded rate; any positive integer rate binds
const ZERO_SAMPLE_RATE = 0;
const INVALID_SAMPLE_RATE_ERROR = `The decoded audio sample rate ${ZERO_SAMPLE_RATE} Hz is invalid`;

type RecordingStage = {
    sourceFormats: DecodedAudioSourceFormat[]
    stage: DecodedAudioOutputStage
};

function createRecordingStage(
    routeCodec: string,
    outputChannelCount: CustomAudioOutputChannelCount
): RecordingStage {
    const sourceFormats: DecodedAudioSourceFormat[] = [];
    const stage = new DecodedAudioOutputStage({
        maximumOutputFrameCount: 1_920,
        minimumOutputFrameCount: 1,
        onSourceFormat: (sourceFormat: DecodedAudioSourceFormat): void => {
            sourceFormats.push(sourceFormat);
        },
        outputChannelCount,
        routeCodec,
        timestampToleranceMicroseconds: 1_000
    });
    return { sourceFormats, stage };
}

function createStereoInput(frameCount: number, value: number): Float32Array[] {
    return [ new Float32Array(frameCount).fill(value), new Float32Array(frameCount).fill(value) ];
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

/** Applies the bridge's own continuity rule to every consecutive pair of chunks. */
function expectBridgeContinuity(outputs: readonly StreamingAudioResamplerOutput[]): void {
    for (let outputIndex = 1; outputIndex < outputs.length; outputIndex += 1) {
        const previousOutput = outputs[outputIndex - 1];
        const expectedMediaTimeMicroseconds = previousOutput.mediaTimeMicroseconds
            + audioFramesToMicroseconds(previousOutput.frameCount, OUTPUT_SAMPLE_RATE);
        expect(Math.abs(outputs[outputIndex].mediaTimeMicroseconds - expectedMediaTimeMicroseconds))
            .toBeLessThanOrEqual(BRIDGE_CONTINUITY_TOLERANCE_MICROSECONDS);
    }
}

describe('DecodedAudioOutputStage', () => {
    it('binds the first decoded format once and reports it', () => {
        const { sourceFormats, stage } = createRecordingStage('aac', 2);
        expect(stage.sourceFormat).toBeNull();
        expect(stage.getTelemetry()).toBeNull();

        const binding = stage.bind({ channelCount: 2, layout: null, sampleRate: 44_100 }, null);
        const repeatedBinding = stage.bind({ channelCount: 2, layout: null, sampleRate: 44_100 }, null);

        expect(binding.layout).toBe(CUSTOM_STEREO_CHANNEL_LAYOUT);
        expect(binding.outputs).toEqual([]);
        expect(repeatedBinding.pipeline).toBe(binding.pipeline);
        expect(stage.sourceFormat).toEqual({ channelCount: 2, sampleRate: 44_100 });
        expect(sourceFormats).toEqual([ { channelCount: 2, sampleRate: 44_100 } ]);
        expect(stage.getTelemetry()).toMatchObject({
            peakLimiterEnabled: false,
            sourceSampleRateChangeCount: 0
        });
    });

    it('binds a track declared stereo that decodes to 5.1 and limits its fold-down', () => {
        const { sourceFormats, stage } = createRecordingStage('aac', 2);

        const binding = stage.bind({ channelCount: 6, layout: null, sampleRate: 48_000 }, null);

        expect(binding.layout).toBe(CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT);
        expect(sourceFormats).toEqual([ { channelCount: 6, sampleRate: 48_000 } ]);
        expect(stage.getTelemetry()?.peakLimiterEnabled).toBe(true);

        // A 5.1 output carries the same bed without summing channels
        const surroundStage = createRecordingStage('aac', 6).stage;
        surroundStage.bind({ channelCount: 6, layout: null, sampleRate: 48_000 }, null);
        expect(surroundStage.getTelemetry()?.peakLimiterEnabled).toBe(false);
    });

    it('turns the limiter on mid-stream when the decoded layout starts to fold down', () => {
        const { sourceFormats, stage } = createRecordingStage('aac', 2);
        const stereoBinding = stage.bind({ channelCount: 2, layout: null, sampleRate: 48_000 }, null);
        const outputs = stereoBinding.pipeline.push({
            channelData: createStereoInput(4_800, 0.25),
            mediaTimeMicroseconds: requireMicroseconds(1_000_000)
        });
        expect(stage.getTelemetry()?.peakLimiterEnabled).toBe(false);

        const surroundBinding = stage.bind({ channelCount: 6, layout: null, sampleRate: 48_000 }, null);
        outputs.push(...surroundBinding.outputs);
        outputs.push(...surroundBinding.pipeline.push({
            channelData: createStereoInput(9_600, 2),
            mediaTimeMicroseconds: requireMicroseconds(1_100_000)
        }));
        outputs.push(...stage.finalize());

        expect(surroundBinding.pipeline).toBe(stereoBinding.pipeline);
        expect(sourceFormats).toEqual([
            { channelCount: 2, sampleRate: 48_000 },
            { channelCount: 6, sampleRate: 48_000 }
        ]);
        expect(stage.getTelemetry()?.peakLimiterEnabled).toBe(true);
        expect(getOutputFrameCount(outputs)).toBe(14_400);
        expect(outputs[0].channelData[0][0]).toBe(0.25);
        expect(getMaximumPeak(outputs.slice(1)))
            .toBeLessThanOrEqual(CUSTOM_AUDIO_LIMITER_CEILING_GAIN + LIMITER_CEILING_TOLERANCE);
        expectBridgeContinuity(outputs);
    });

    it('rebinds the resampler on a rate change with the limiter active within the bridge tolerance', () => {
        const { sourceFormats, stage } = createRecordingStage('aac', 2);
        const setSampleRate = vi.fn();
        const streamingDownmixSettings = {
            setSampleRate
        } as unknown as StreamingAudioDownmixSettings;
        // HE-AAC can decode at its core rate before the extension doubles it
        const coreBinding = stage.bind(
            { channelCount: 6, layout: null, sampleRate: 24_000 },
            streamingDownmixSettings
        );
        const outputs = coreBinding.pipeline.push({
            channelData: createStereoInput(2_400, 0.25),
            mediaTimeMicroseconds: requireMicroseconds(1_000_000)
        });

        const fullRateBinding = stage.bind(
            { channelCount: 6, layout: null, sampleRate: 48_000 },
            streamingDownmixSettings
        );
        outputs.push(...fullRateBinding.outputs);
        outputs.push(...fullRateBinding.pipeline.push({
            channelData: createStereoInput(4_800, 0.25),
            mediaTimeMicroseconds: requireMicroseconds(1_100_000)
        }));
        outputs.push(...stage.finalize());

        expect(setSampleRate.mock.calls).toEqual([ [ 24_000 ], [ 48_000 ] ]);
        expect(sourceFormats).toEqual([
            { channelCount: 6, sampleRate: 24_000 },
            { channelCount: 6, sampleRate: 48_000 }
        ]);
        expect(stage.getTelemetry()).toMatchObject({
            peakLimiterEnabled: true,
            sourceSampleRateChangeCount: 1
        });
        expect(getOutputFrameCount(outputs)).toBe(9_600);
        expect(outputs[0].mediaTimeMicroseconds).toBe(1_000_000);
        expectBridgeContinuity(outputs);
    });

    it('rejects decoded three-channel E-AC-3, which no qualified route covers', () => {
        const { sourceFormats, stage } = createRecordingStage('eac3', 2);

        const bindThreeChannels = (): unknown => stage.bind({
            channelCount: 3,
            layout: CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT,
            sampleRate: 48_000
        }, null);

        expect(bindThreeChannels).toThrow(UnsupportedDecodedAudioFormatError);
        expect(bindThreeChannels).toThrow(
            'Decoded eac3 audio at 3 channels and 48000 Hz does not match a qualified decoded PCM route'
        );
        expect(stage.sourceFormat).toBeNull();
        expect(sourceFormats).toEqual([]);
        expect(stage.getTelemetry()).toBeNull();
        expect(stage.finalize()).toEqual([]);
    });

    it('rejects an invalid rate and a layout that does not describe the decoded channels', () => {
        const { stage } = createRecordingStage('aac', 2);

        expect(() => stage.bind({ channelCount: 2, layout: null, sampleRate: ZERO_SAMPLE_RATE }, null))
            .toThrow(INVALID_SAMPLE_RATE_ERROR);
        expect(() => stage.bind({ channelCount: 4, layout: null, sampleRate: 48_000 }, null))
            .toThrow('The decoded 4-channel audio layout is unsupported');
        expect(() => stage.bind({
            channelCount: 3,
            layout: CUSTOM_STEREO_CHANNEL_LAYOUT,
            sampleRate: 48_000
        }, null)).toThrow('The decoded 3-channel audio layout is unsupported');
        expect(stage.sourceFormat).toBeNull();
    });

    it('keeps the 3.0(back) layout a DTS speaker mask reports', () => {
        const { stage } = createRecordingStage('dts', 6);

        const binding = stage.bind({
            channelCount: 3,
            layout: CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT,
            sampleRate: 48_000
        }, null);

        expect(binding.layout).toBe(CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT);
        expect(stage.getTelemetry()?.peakLimiterEnabled).toBe(false);
    });
});
