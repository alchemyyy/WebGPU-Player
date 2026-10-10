// @vitest-environment node

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';
import { AUDIO_OUTPUT_STAGE_WASM_ASSET } from 'webgpu-player/EngineAssets';
import { MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE } from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import AudioOutputStageModule, {
    AudioOutputStageLimiterKernel,
    AudioOutputStageResamplerKernel
} from 'webgpu-player/audio/processing/AudioOutputStageModule';
import DecodedAudioOutputStage from 'webgpu-player/audio/processing/DecodedAudioOutputStage';
import { getCustomAudioChannelLayout } from 'webgpu-player/audio/processing/CustomAudioChannelLayout';
import PCMChannelPool from 'webgpu-player/audio/processing/PCMChannelPool';
import StreamingAudioLookaheadLimiter, {
    CUSTOM_AUDIO_LIMITER_CEILING_GAIN
} from 'webgpu-player/audio/processing/StreamingAudioLookaheadLimiter';
import StreamingAudioOutputPipeline from 'webgpu-player/audio/processing/StreamingAudioOutputPipeline';
import StreamingAudioResampler, {
    MAXIMUM_AUDIO_TIMELINE_CORRECTION_MICROSECONDS,
    type StreamingAudioResamplerOptions,
    type StreamingAudioResamplerOutput
} from 'webgpu-player/audio/processing/StreamingAudioResampler';
import {
    addMicroseconds,
    audioFramesToMicroseconds,
    requireMicroseconds
} from 'webgpu-player/TimeMath';

import { readDecoderWASMSource } from '../../helpers/libraryAssets';

// The output contract: 48 kHz, chunks of 40 ms up to the 12000 frames the 2 s worklet ring allows per credit
const TARGET_SAMPLE_RATE = 48_000;
const MINIMUM_OUTPUT_FRAME_COUNT = 1_920;
const MAXIMUM_OUTPUT_FRAME_COUNT = 12_000;
const DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS = 1_000;
const MICROSECONDS_PER_SECOND = 1_000_000;
const ANCHOR_MEDIA_TIME_MICROSECONDS = requireMicroseconds(2_500_000);

// Source rates: telephone to the qualified 192 kHz, rates that widen the kernel past it, and rates without a small ratio to 48 kHz
const SOURCE_SAMPLE_RATES: readonly number[] = [
    8_000, 11_025, 22_050, 32_000, 37_800, 44_100, 48_000, 88_200, 96_000, 176_400, 192_000,
    200_003, 352_800, 384_000, 768_000
];
const CD_SAMPLE_RATE = 44_100;
const HIGH_RESOLUTION_SAMPLE_RATE = 96_000;
const HIGHEST_QUALIFIED_SAMPLE_RATE = 192_000;
const STEREO_CHANNEL_COUNT = 2;
const THREE_CHANNEL_COUNT = 3;
const SEVEN_POINT_ONE_CHANNEL_COUNT = 8;
const CHANNEL_COUNTS: readonly number[] = [ 1, 2, 3, 4, 5, 6, 7, 8 ];
// Rates every channel count runs at: upsampling, passthrough, and downsampling
const ALL_CHANNEL_SAMPLE_RATES: readonly number[] = [ CD_SAMPLE_RATE, TARGET_SAMPLE_RATE, HIGH_RESOLUTION_SAMPLE_RATE ];

// A randomized scenario: tiny pushes first, then random sizes, with forced timeline events at fixed steps
const PUSHES_PER_SCENARIO = 28;
const SMALLEST_PUSH_FRAME_COUNTS: readonly number[] = [ 1, 2, 3, 5, 7 ];
const LARGEST_RANDOM_PUSH_FRAME_COUNT = 6_000;
// Forced events use pushes of this duration, so a half-push overlap exceeds every rate's jitter tolerance
const EVENT_PUSH_SECONDS = 0.02;
// The push before an overlap is longer than the overlap; an input at or before the previous timestamp is absorbed as non-advancing instead
const PRE_OVERLAP_PUSH_SECONDS = 0.1;
const FORCED_GAP_STEPS: readonly number[] = [ 8, 19 ];
const FORCED_TRIM_STEPS: readonly number[] = [ 10, 21 ];
const FORCED_DROP_STEPS: readonly number[] = [ 12, 23 ];
const FORCED_JITTER_STEPS: readonly number[] = [ 14, 25 ];
const FORCED_REPEATED_TIMESTAMP_STEPS: readonly number[] = [ 16 ];
const SHORTEST_GAP_MICROSECONDS = 5_000;
const LONGEST_GAP_MICROSECONDS = 1_500_000;
const LARGEST_JITTER_MICROSECONDS = 900;
// Past the drop point, so the remainder of a dropped push is always within tolerance
const DROP_EXTRA_OVERLAP_MICROSECONDS = 5_000;
// Beyond the correction bound, which both implementations reject
const REJECTED_DEVIATION_MICROSECONDS = MAXIMUM_AUDIO_TIMELINE_CORRECTION_MICROSECONDS + 10_000;
const REJECTION_PRECEDING_PUSH_SECONDS = 3;
const FORWARD_DEVIATION_SIGN = 1;
const BACKWARD_DEVIATION_SIGN = -1;
const LONG_STREAM_PUSH_COUNT = 120;
const SHORTEST_LONG_STREAM_PUSH_FRAME_COUNT = 100;
const LONGEST_LONG_STREAM_PUSH_FRAME_COUNT = 1_500;
// Enough single-frame pushes to fill a minimum output chunk and run past it
const SINGLE_FRAME_PUSH_COUNT = MINIMUM_OUTPUT_FRAME_COUNT + 77;
const EXTREME_SIGNAL_FRAME_COUNT = 3_000;

// Deterministic seeds, so every randomized case replays exactly
const RESAMPLER_SEED = 0x5EED_0001;
const LIMITER_SEED = 0x5EED_0002;
const PIPELINE_SEED = 0x5EED_0003;
// The mulberry32 generator's increment and output range
const MULBERRY32_INCREMENT = 0x6D2B_79F5;
const UINT32_RANGE = 2 ** 32;

// Noise mixes in exact zeros, negative zeros, and subnormals at these cumulative probabilities
const ZERO_SAMPLE_PROBABILITY = 0.01;
const NEGATIVE_ZERO_SAMPLE_PROBABILITY = 0.02;
const SUBNORMAL_SAMPLE_PROBABILITY = 0.025;
const LARGEST_SUBNORMAL_MULTIPLE = 4;
const HALF_PROBABILITY = 0.5;

// Sample magnitudes: program level, fold-down overshoot, and the float32 extremes
const QUIET_AMPLITUDE = 0.5;
const LOUD_AMPLITUDE = 1.6;
const VERY_LOUD_AMPLITUDE = 3;
const FLOAT32_SMALLEST_SUBNORMAL = 2 ** -149;
const FLOAT32_LARGEST_FINITE = 3.4028234663852886e38;
const TONE_FREQUENCY = 440;
const SPIKE_PEAKS: readonly number[] = [ 0.9, 1.01, 1.5, 4, 1e6, FLOAT32_LARGEST_FINITE ];
const SPIKES_PER_SCENARIO = 30;
// A NaN with a payload, and the default quiet NaN with its sign set
const PAYLOAD_NAN_BITS = 0x7FA0_0001;
const NEGATIVE_QUIET_NAN_BITS = 0xFFC0_1234;

// Limiter rates: production, a 44.1 kHz family rate, short attacks at 8 kHz, and long ones at 192 kHz
const LIMITER_SAMPLE_RATES: readonly number[] = [ 8_000, 44_100, 48_000, 96_000, 192_000 ];
const LIMITER_CHANNEL_COUNTS: readonly number[] = [ 1, 2, 6, 8 ];
const LIMITER_SIGNAL_FRAME_COUNT = 80_000;
const LARGEST_RANDOM_LIMITER_INPUT_FRAME_COUNT = 4_000;
const LARGEST_INPUTS_PER_PUSH = 3;
// Small chunks put many chunk boundaries inside every attack
const SMALL_CHUNK_MAXIMUM_FRAME_COUNT = 97;
const SMALL_CHUNK_MINIMUM_FRAME_COUNT = 1;
const SMALL_CHUNK_SIGNAL_FRAME_COUNT = 30_000;
const SMALL_CHUNK_LARGEST_INPUT_FRAME_COUNT = 700;
const CEILING_TEST_FRAME_COUNT = 20_000;
const CEILING_TEST_PEAK_SPACING = 97;
const CEILING_TEST_LARGEST_INPUT_FRAME_COUNT = 3_000;
const NON_FINITE_TEST_FRAME_COUNT = 6_000;
const NON_FINITE_SAMPLE_FRAME = 5_000;

// Pipeline scenarios
const PIPELINE_SOURCE_SAMPLE_RATES: readonly number[] = [ 44_100, 48_000, 96_000, 22_050, 48_000, 192_000 ];
const PIPELINE_LIMITER_RATE_INDEX = 2;
const PIPELINE_PUSHES_PER_RATE = 12;
const PIPELINE_LARGEST_PUSH_FRAME_COUNT = 5_000;
const STAGE_PUSH_COUNT = 30;
const STAGE_SMALLEST_PUSH_FRAME_COUNT = 256;
const STAGE_LARGEST_PUSH_FRAME_COUNT = 4_096;
// E-AC-3 admits 7.1, which folds down to stereo through the limiter
const SEVEN_POINT_ONE_ROUTE_CODEC = 'eac3';
const RELEASED_RESAMPLER_KERNEL_MESSAGE = 'The audio output stage resampler kernel is released';
const RELEASED_LIMITER_KERNEL_MESSAGE = 'The audio output stage limiter kernel is released';
// The spare channel buffers the worklet returns, each sized for the largest chunk
const POOL_MAXIMUM_SPARE_BUFFER_COUNT = 16;
const POOLED_CHANNEL_BYTE_LENGTH = MAXIMUM_OUTPUT_FRAME_COUNT * Float32Array.BYTES_PER_ELEMENT;

type RandomSource = () => number;

type ResamplerStep = Readonly<{
    channelData: Float32Array[]
    mediaTimeMicroseconds: Microseconds
}>;

/** Creates a scenario's next push, given the input time the reference expects next. */
type ResamplerStepSource = (stepIndex: number, expectedMediaTimeMicroseconds: number) => ResamplerStep;

type StepResult = Readonly<{
    errorMessage: string | null
    outputs: readonly StreamingAudioResamplerOutput[]
}>;

type LimiterPair = Readonly<{
    kernel: StreamingAudioLookaheadLimiter
    reference: StreamingAudioLookaheadLimiter
}>;

let outputStageModule: AudioOutputStageModule;

beforeAll(async () => {
    const source = await readDecoderWASMSource(AUDIO_OUTPUT_STAGE_WASM_ASSET);
    if (source.kind !== 'bytes') {
        throw new Error('The test reads the output stage binary as bytes');
    }
    outputStageModule = await AudioOutputStageModule.instantiate(source.bytes);
});

function float32FromBits(bits: number): number {
    return new Float32Array(new Uint32Array([ bits ]).buffer)[0];
}

function float32Bits(value: number): number {
    return new Uint32Array(new Float32Array([ value ]).buffer)[0];
}

// The float32 values beside the ceiling, where the peak test flips
const CEILING_FLOAT = Math.fround(CUSTOM_AUDIO_LIMITER_CEILING_GAIN);
const CEILING_NEIGHBORS: readonly number[] = [
    float32FromBits(float32Bits(CEILING_FLOAT) - 1),
    CEILING_FLOAT,
    float32FromBits(float32Bits(CEILING_FLOAT) + 1)
];

/** mulberry32: a small seeded generator of uniform values in [0, 1). */
function createRandomSource(seed: number): RandomSource {
    let state = seed >>> 0;
    return (): number => {
        state = (state + MULBERRY32_INCREMENT) >>> 0;
        let value = Math.imul(state ^ (state >>> 15), state | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE;
    };
}

function randomInteger(random: RandomSource, minimum: number, maximum: number): number {
    return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function randomSample(random: RandomSource, amplitude: number): number {
    const selector = random();
    if (selector < ZERO_SAMPLE_PROBABILITY) {
        return 0;
    }
    if (selector < NEGATIVE_ZERO_SAMPLE_PROBABILITY) {
        return -0;
    }
    if (selector < SUBNORMAL_SAMPLE_PROBABILITY) {
        return FLOAT32_SMALLEST_SUBNORMAL * randomInteger(random, -LARGEST_SUBNORMAL_MULTIPLE, LARGEST_SUBNORMAL_MULTIPLE);
    }
    return (random() * 2 - 1) * amplitude;
}

/** Noise with occasional exact zeros, negative zeros, and subnormals. */
function createRandomChannels(random: RandomSource, channelCount: number, frameCount: number, amplitude: number): Float32Array[] {
    const channels: Float32Array[] = [];
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        const channel = new Float32Array(frameCount);
        for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
            channel[frameIndex] = randomSample(random, amplitude);
        }
        channels.push(channel);
    }
    return channels;
}

function createSineChannels(channelCount: number, frameCount: number, amplitude: number, sampleRate: number): Float32Array[] {
    const channels: Float32Array[] = [];
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        const channel = new Float32Array(frameCount);
        const frequency = TONE_FREQUENCY * (channelIndex + 1);
        for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
            channel[frameIndex] = amplitude * Math.sin(2 * Math.PI * frequency * frameIndex / sampleRate);
        }
        channels.push(channel);
    }
    return channels;
}

function framesToMicroseconds(frameCount: number, sampleRate: number): number {
    return Math.round(frameCount * MICROSECONDS_PER_SECOND / sampleRate);
}

function randomAmplitude(random: RandomSource): number {
    return random() < HALF_PROBABILITY ? QUIET_AMPLITUDE : VERY_LOUD_AMPLITUDE;
}

/**
 * A randomized push sequence that exercises every reconciliation rule against the time the reference expects:
 * contiguous inputs, jitter, a repeated timestamp, gaps that fill, and overlaps that trim or drop.
 */
function createRandomStepSource(random: RandomSource, sourceSampleRate: number, channelCount: number): ResamplerStepSource {
    const eventFrameCount = Math.ceil(sourceSampleRate * EVENT_PUSH_SECONDS);
    const preOverlapFrameCount = Math.ceil(sourceSampleRate * PRE_OVERLAP_PUSH_SECONDS);
    let previousMediaTimeMicroseconds: number = ANCHOR_MEDIA_TIME_MICROSECONDS;
    return (stepIndex: number, expectedMediaTimeMicroseconds: number): ResamplerStep => {
        let frameCount = stepIndex < SMALLEST_PUSH_FRAME_COUNTS.length ?
            SMALLEST_PUSH_FRAME_COUNTS[stepIndex] :
            randomInteger(random, 1, LARGEST_RANDOM_PUSH_FRAME_COUNT);
        if (FORCED_TRIM_STEPS.includes(stepIndex + 1) || FORCED_DROP_STEPS.includes(stepIndex + 1)) {
            frameCount = preOverlapFrameCount;
        }
        let mediaTimeMicroseconds = expectedMediaTimeMicroseconds;
        if (FORCED_GAP_STEPS.includes(stepIndex)) {
            mediaTimeMicroseconds += randomInteger(random, SHORTEST_GAP_MICROSECONDS, LONGEST_GAP_MICROSECONDS);
        } else if (FORCED_TRIM_STEPS.includes(stepIndex)) {
            frameCount = eventFrameCount;
            mediaTimeMicroseconds -= framesToMicroseconds(eventFrameCount / 2, sourceSampleRate);
        } else if (FORCED_DROP_STEPS.includes(stepIndex)) {
            frameCount = eventFrameCount;
            mediaTimeMicroseconds -= framesToMicroseconds(eventFrameCount, sourceSampleRate) + DROP_EXTRA_OVERLAP_MICROSECONDS;
        } else if (FORCED_JITTER_STEPS.includes(stepIndex)) {
            mediaTimeMicroseconds += randomInteger(random, -LARGEST_JITTER_MICROSECONDS, LARGEST_JITTER_MICROSECONDS);
        } else if (FORCED_REPEATED_TIMESTAMP_STEPS.includes(stepIndex)) {
            mediaTimeMicroseconds = previousMediaTimeMicroseconds;
        }
        previousMediaTimeMicroseconds = mediaTimeMicroseconds;
        return {
            channelData: createRandomChannels(random, channelCount, frameCount, randomAmplitude(random)),
            mediaTimeMicroseconds: requireMicroseconds(mediaTimeMicroseconds)
        };
    };
}

/** Contiguous pushes of the given sizes. */
function createContiguousStepSource(random: RandomSource, channelCount: number, frameCounts: readonly number[]): ResamplerStepSource {
    return (stepIndex: number, expectedMediaTimeMicroseconds: number): ResamplerStep => ({
        channelData: createRandomChannels(random, channelCount, frameCounts[stepIndex], QUIET_AMPLITUDE),
        mediaTimeMicroseconds: requireMicroseconds(expectedMediaTimeMicroseconds)
    });
}

function runStep(operation: () => StreamingAudioResamplerOutput[]): StepResult {
    try {
        return { errorMessage: null, outputs: operation() };
    } catch (error) {
        return { errorMessage: error instanceof Error ? error.message : String(error), outputs: [] };
    }
}

/** Returns the first index where two channels' bit patterns differ, or -1 when every byte matches. */
function findFirstBitDifference(actual: Float32Array, expected: Float32Array): number {
    const actualBits = new Uint32Array(actual.buffer, actual.byteOffset, actual.length);
    const expectedBits = new Uint32Array(expected.buffer, expected.byteOffset, expected.length);
    const length = Math.min(actualBits.length, expectedBits.length);
    for (let index = 0; index < length; index += 1) {
        if (actualBits[index] !== expectedBits[index]) {
            return index;
        }
    }
    return actualBits.length === expectedBits.length ? -1 : length;
}

/** Returns the first index where two channels differ in a value or in where NaN appears; NaN payloads are implementation-defined. */
function findFirstValueDifference(actual: Float32Array, expected: Float32Array): number {
    for (let index = 0; index < expected.length; index += 1) {
        const expectedNaN = Number.isNaN(expected[index]);
        if (expectedNaN !== Number.isNaN(actual[index])) {
            return index;
        }
        if (!expectedNaN && float32Bits(actual[index]) !== float32Bits(expected[index])) {
            return index;
        }
    }
    return actual.length === expected.length ? -1 : expected.length;
}

function describeOutput(output: StreamingAudioResamplerOutput): Readonly<Record<string, number>> {
    return {
        channelCount: output.channelData.length,
        durationMicroseconds: output.durationMicroseconds,
        frameCount: output.frameCount,
        mediaTimeMicroseconds: output.mediaTimeMicroseconds,
        sampleRate: output.sampleRate
    };
}

function expectIdenticalResults(
    kernelResult: StepResult,
    referenceResult: StepResult,
    label: string,
    findDifference: (actual: Float32Array, expected: Float32Array) => number = findFirstBitDifference
): void {
    expect(kernelResult.errorMessage, `${label} error`).toBe(referenceResult.errorMessage);
    expect(kernelResult.outputs.map(describeOutput), `${label} chunks`).toEqual(referenceResult.outputs.map(describeOutput));
    for (let outputIndex = 0; outputIndex < referenceResult.outputs.length; outputIndex += 1) {
        const referenceOutput = referenceResult.outputs[outputIndex];
        for (let channelIndex = 0; channelIndex < referenceOutput.channelData.length; channelIndex += 1) {
            expect(
                findDifference(kernelResult.outputs[outputIndex].channelData[channelIndex], referenceOutput.channelData[channelIndex]),
                `${label} chunk ${outputIndex} channel ${channelIndex}`
            ).toBe(-1);
        }
    }
}

function createResamplerOptions(sourceSampleRate: number, channelCount: number): StreamingAudioResamplerOptions {
    return {
        channelCount,
        maximumOutputFrameCount: MAXIMUM_OUTPUT_FRAME_COUNT,
        maximumTimestampQuantizationMicroseconds: DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
        minimumOutputFrameCount: MINIMUM_OUTPUT_FRAME_COUNT,
        sourceSampleRate,
        targetSampleRate: TARGET_SAMPLE_RATE
    };
}

/**
 * Creates a resampler on the module and requires that it renders through a kernel rather than falling back to the reference.
 * A source at the target rate only passes through, so it keeps the JavaScript path and creates no kernel.
 */
function createKernelResampler(options: StreamingAudioResamplerOptions): StreamingAudioResampler {
    const createKernel = vi.spyOn(outputStageModule, 'createResamplerKernel');
    const resampler = new StreamingAudioResampler({ ...options, outputStageModule });
    if (options.sourceSampleRate === options.targetSampleRate) {
        expect(createKernel).not.toHaveBeenCalled();
    } else {
        expect(createKernel).toHaveLastReturnedWith(expect.any(AudioOutputStageResamplerKernel));
    }
    createKernel.mockRestore();
    return resampler;
}

/**
 * Pushes every step through both resamplers, then finalizes both.
 * Requires identical chunks, bytes, errors, telemetry, and continuations, and returns the reference's final telemetry.
 */
function expectIdenticalResampling(
    sourceSampleRate: number,
    channelCount: number,
    stepCount: number,
    stepSource: ResamplerStepSource,
    label: string
): ReturnType<StreamingAudioResampler['getTelemetry']> {
    const options = createResamplerOptions(sourceSampleRate, channelCount);
    const kernel = createKernelResampler(options);
    const reference = new StreamingAudioResampler(options);
    for (let stepIndex = 0; stepIndex < stepCount; stepIndex += 1) {
        const expectedMediaTimeMicroseconds = ANCHOR_MEDIA_TIME_MICROSECONDS
            + audioFramesToMicroseconds(reference.getTelemetry().sourceFrameCount, sourceSampleRate);
        const step = stepSource(stepIndex, expectedMediaTimeMicroseconds);
        const referenceResult = runStep(() => reference.push(step));
        const kernelResult = runStep(() => kernel.push(step));
        expectIdenticalResults(kernelResult, referenceResult, `${label} push ${stepIndex}`);
        expect(kernel.getTelemetry(), `${label} push ${stepIndex} telemetry`).toEqual(reference.getTelemetry());
        if (referenceResult.errorMessage !== null) {
            return reference.getTelemetry();
        }
    }
    expectIdenticalResults(runStep(() => kernel.finalize()), runStep(() => reference.finalize()), `${label} finalize`);
    expect(kernel.getTelemetry(), `${label} final telemetry`).toEqual(reference.getTelemetry());
    expect(kernel.getContinuation(), `${label} continuation`).toEqual(reference.getContinuation());
    return reference.getTelemetry();
}

/** Runs a randomized scenario and requires that it filled, trimmed, dropped, and absorbed at least once. */
function expectIdenticalRandomResampling(random: RandomSource, sourceSampleRate: number, channelCount: number): void {
    const telemetry = expectIdenticalResampling(
        sourceSampleRate,
        channelCount,
        PUSHES_PER_SCENARIO,
        createRandomStepSource(random, sourceSampleRate, channelCount),
        `${sourceSampleRate} Hz ${channelCount} channels`
    );
    expect(telemetry.filledInputCount, `${sourceSampleRate} Hz fills`).toBeGreaterThan(0);
    expect(telemetry.trimmedInputCount, `${sourceSampleRate} Hz trims`).toBeGreaterThan(0);
    expect(telemetry.droppedInputCount, `${sourceSampleRate} Hz drops`).toBeGreaterThan(0);
    expect(telemetry.absorbedInputCount, `${sourceSampleRate} Hz absorbed inputs`).toBeGreaterThan(0);
}

describe('WebAssembly audio output stage resampler, byte for byte against the JavaScript reference', () => {
    it.each(SOURCE_SAMPLE_RATES)('matches randomized timelines from %i Hz in stereo and 7.1', sourceSampleRate => {
        const random = createRandomSource(RESAMPLER_SEED + sourceSampleRate);
        for (const channelCount of [ STEREO_CHANNEL_COUNT, SEVEN_POINT_ONE_CHANNEL_COUNT ]) {
            expectIdenticalRandomResampling(random, sourceSampleRate, channelCount);
        }
    });

    it.each(ALL_CHANNEL_SAMPLE_RATES)('matches every channel count from 1 to 8 from %i Hz', sourceSampleRate => {
        const random = createRandomSource(RESAMPLER_SEED ^ sourceSampleRate);
        for (const channelCount of CHANNEL_COUNTS) {
            expectIdenticalRandomResampling(random, sourceSampleRate, channelCount);
        }
    });

    it.each([ CD_SAMPLE_RATE, TARGET_SAMPLE_RATE, HIGHEST_QUALIFIED_SAMPLE_RATE ])(
        'matches single-frame pushes and protocol-maximum pushes from %i Hz',
        sourceSampleRate => {
            const random = createRandomSource(RESAMPLER_SEED + 1);
            const singleFramePushes = new Array<number>(SINGLE_FRAME_PUSH_COUNT).fill(1);
            expectIdenticalResampling(
                sourceSampleRate,
                THREE_CHANNEL_COUNT,
                singleFramePushes.length,
                createContiguousStepSource(random, THREE_CHANNEL_COUNT, singleFramePushes),
                `${sourceSampleRate} Hz single frames`
            );
            const largestPushes = [ MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE, 1, MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE ];
            expectIdenticalResampling(
                sourceSampleRate,
                SEVEN_POINT_ONE_CHANNEL_COUNT,
                largestPushes.length,
                createContiguousStepSource(random, SEVEN_POINT_ONE_CHANNEL_COUNT, largestPushes),
                `${sourceSampleRate} Hz protocol maximum`
            );
        }
    );

    it('matches a stream far longer than the ring, so windows wrap it', () => {
        const random = createRandomSource(RESAMPLER_SEED + 2);
        const frameCounts: number[] = [];
        for (let pushIndex = 0; pushIndex < LONG_STREAM_PUSH_COUNT; pushIndex += 1) {
            frameCounts.push(randomInteger(random, SHORTEST_LONG_STREAM_PUSH_FRAME_COUNT, LONGEST_LONG_STREAM_PUSH_FRAME_COUNT));
        }
        for (const sourceSampleRate of [ CD_SAMPLE_RATE, HIGH_RESOLUTION_SAMPLE_RATE ]) {
            expectIdenticalResampling(
                sourceSampleRate,
                STEREO_CHANNEL_COUNT,
                frameCounts.length,
                createContiguousStepSource(random, STEREO_CHANNEL_COUNT, frameCounts),
                `${sourceSampleRate} Hz long stream`
            );
        }
    });

    it('matches the float32 extremes, and silence that edge-extends at both ends', () => {
        const extremes = [ FLOAT32_LARGEST_FINITE, -FLOAT32_LARGEST_FINITE, FLOAT32_SMALLEST_SUBNORMAL, -0, 0, 1, -1 ];
        const channel = new Float32Array(EXTREME_SIGNAL_FRAME_COUNT);
        for (let frameIndex = 0; frameIndex < channel.length; frameIndex += 1) {
            channel[frameIndex] = extremes[frameIndex % extremes.length];
        }
        const silence = new Float32Array(EXTREME_SIGNAL_FRAME_COUNT);
        for (const sourceSampleRate of [ CD_SAMPLE_RATE, HIGH_RESOLUTION_SAMPLE_RATE ]) {
            expectIdenticalResampling(sourceSampleRate, STEREO_CHANNEL_COUNT, 1, (): ResamplerStep => ({
                channelData: [ channel, channel.slice().reverse() ],
                mediaTimeMicroseconds: ANCHOR_MEDIA_TIME_MICROSECONDS
            }), `${sourceSampleRate} Hz extremes`);
            expectIdenticalResampling(sourceSampleRate, 1, 1, (): ResamplerStep => ({
                channelData: [ silence ],
                mediaTimeMicroseconds: ANCHOR_MEDIA_TIME_MICROSECONDS
            }), `${sourceSampleRate} Hz silence`);
        }
    });

    it('carries NaN to the same outputs, with every other value identical', () => {
        const random = createRandomSource(RESAMPLER_SEED + 3);
        for (const sourceSampleRate of [ CD_SAMPLE_RATE, TARGET_SAMPLE_RATE ]) {
            const options = createResamplerOptions(sourceSampleRate, STEREO_CHANNEL_COUNT);
            const kernel = createKernelResampler(options);
            const reference = new StreamingAudioResampler(options);
            const channelData = createRandomChannels(random, STEREO_CHANNEL_COUNT, EXTREME_SIGNAL_FRAME_COUNT, QUIET_AMPLITUDE);
            channelData[0][0] = float32FromBits(NEGATIVE_QUIET_NAN_BITS);
            channelData[0][EXTREME_SIGNAL_FRAME_COUNT / 2] = float32FromBits(PAYLOAD_NAN_BITS);
            channelData[1][EXTREME_SIGNAL_FRAME_COUNT - 1] = Number.POSITIVE_INFINITY;
            const input = { channelData, mediaTimeMicroseconds: ANCHOR_MEDIA_TIME_MICROSECONDS };
            expectIdenticalResults(
                runStep(() => [ ...kernel.push(input), ...kernel.finalize() ]),
                runStep(() => [ ...reference.push(input), ...reference.finalize() ]),
                `${sourceSampleRate} Hz NaN`,
                findFirstValueDifference
            );
        }
    });

    it.each([ FORWARD_DEVIATION_SIGN, BACKWARD_DEVIATION_SIGN ])(
        'rejects a discontinuity beyond the correction bound in direction %i with the reference error',
        deviationSign => {
            const random = createRandomSource(RESAMPLER_SEED + 4);
            // The pushes before the rejected one outlast the deviation, so a backward one lands after the previous timestamp instead of being absorbed
            const frameCounts = [ CD_SAMPLE_RATE * REJECTION_PRECEDING_PUSH_SECONDS, CD_SAMPLE_RATE * REJECTION_PRECEDING_PUSH_SECONDS, CD_SAMPLE_RATE ];
            const contiguousSteps = createContiguousStepSource(random, STEREO_CHANNEL_COUNT, frameCounts);
            const rejectedStepIndex = frameCounts.length - 1;
            const telemetry = expectIdenticalResampling(
                CD_SAMPLE_RATE,
                STEREO_CHANNEL_COUNT,
                frameCounts.length,
                (stepIndex: number, expectedMediaTimeMicroseconds: number): ResamplerStep => {
                    const step = contiguousSteps(stepIndex, expectedMediaTimeMicroseconds);
                    if (stepIndex !== rejectedStepIndex) {
                        return step;
                    }
                    return {
                        ...step,
                        mediaTimeMicroseconds: requireMicroseconds(expectedMediaTimeMicroseconds + deviationSign * REJECTED_DEVIATION_MICROSECONDS)
                    };
                },
                `rejected deviation ${deviationSign}`
            );
            expect(telemetry.finalized).toBe(false);
            expect(telemetry.sourceFrameCount).toBe(frameCounts[0] + frameCounts[1]);
        }
    );
});

function createLimiterPair(sampleRate: number, channelCount: number, maximumOutputFrameCount: number, minimumOutputFrameCount: number): LimiterPair {
    const options = { channelCount, maximumOutputFrameCount, minimumOutputFrameCount, sampleRate };
    const createKernel = vi.spyOn(outputStageModule, 'createLimiterKernel');
    const kernel = new StreamingAudioLookaheadLimiter({ ...options, outputStageModule });
    expect(createKernel).toHaveLastReturnedWith(expect.any(AudioOutputStageLimiterKernel));
    createKernel.mockRestore();
    return { kernel, reference: new StreamingAudioLookaheadLimiter(options) };
}

function createLimiterInput(channelData: Float32Array[], firstFrame: number, sampleRate: number): StreamingAudioResamplerOutput {
    const frameCount = channelData[0].length;
    return {
        channelData,
        durationMicroseconds: audioFramesToMicroseconds(frameCount, sampleRate),
        frameCount,
        mediaTimeMicroseconds: addMicroseconds(ANCHOR_MEDIA_TIME_MICROSECONDS, audioFramesToMicroseconds(firstFrame, sampleRate)),
        sampleRate
    };
}

/** Splits planar frames into contiguous limiter inputs, and groups them into pushes of one to three inputs. */
function createLimiterPushes(
    random: RandomSource,
    channelData: readonly Float32Array[],
    sampleRate: number,
    largestInputFrameCount: number
): StreamingAudioResamplerOutput[][] {
    const totalFrameCount = channelData[0].length;
    const pushes: StreamingAudioResamplerOutput[][] = [];
    let firstFrame = 0;
    while (firstFrame < totalFrameCount) {
        const inputs: StreamingAudioResamplerOutput[] = [];
        const inputCount = randomInteger(random, 1, LARGEST_INPUTS_PER_PUSH);
        for (let inputIndex = 0; inputIndex < inputCount && firstFrame < totalFrameCount; inputIndex += 1) {
            const frameCount = Math.min(totalFrameCount - firstFrame, randomInteger(random, 1, largestInputFrameCount));
            inputs.push(createLimiterInput(
                channelData.map(channel => channel.slice(firstFrame, firstFrame + frameCount)),
                firstFrame,
                sampleRate
            ));
            firstFrame += frameCount;
        }
        pushes.push(inputs);
    }
    return pushes;
}

/** Pushes every input group through both limiters, then finalizes both, and requires identical chunks, bytes, errors, and telemetry. */
function expectIdenticalLimiting(
    limiters: LimiterPair,
    pushes: readonly (readonly StreamingAudioResamplerOutput[])[],
    label: string
): void {
    const { kernel, reference } = limiters;
    for (let pushIndex = 0; pushIndex < pushes.length; pushIndex += 1) {
        const referenceResult = runStep(() => reference.push(pushes[pushIndex]));
        const kernelResult = runStep(() => kernel.push(pushes[pushIndex]));
        expectIdenticalResults(kernelResult, referenceResult, `${label} push ${pushIndex}`);
        if (referenceResult.errorMessage !== null) {
            return;
        }
        expect(kernel.getTelemetry(), `${label} push ${pushIndex} telemetry`).toEqual(reference.getTelemetry());
    }
    expectIdenticalResults(runStep(() => kernel.finalize()), runStep(() => reference.finalize()), `${label} finalize`);
    expect(kernel.getTelemetry(), `${label} final telemetry`).toEqual(reference.getTelemetry());
}

/** Places single-frame spikes: on the first and last frames, beside the ceiling, and at random heights and frames. */
function addSpikes(random: RandomSource, channelData: readonly Float32Array[]): void {
    const frameCount = channelData[0].length;
    const spikeFrames = [ 0, 1, frameCount - 2, frameCount - 1 ];
    for (let spikeIndex = 0; spikeIndex < SPIKES_PER_SCENARIO; spikeIndex += 1) {
        spikeFrames.push(randomInteger(random, 0, frameCount - 1));
    }
    const peaks = [ ...SPIKE_PEAKS, ...CEILING_NEIGHBORS ];
    for (const spikeFrame of spikeFrames) {
        const channel = channelData[randomInteger(random, 0, channelData.length - 1)];
        const peak = peaks[randomInteger(random, 0, peaks.length - 1)];
        channel[spikeFrame] = random() < HALF_PROBABILITY ? peak : -peak;
    }
}

describe('WebAssembly audio output stage limiter, byte for byte against the JavaScript reference', () => {
    it.each(LIMITER_SAMPLE_RATES)('matches quiet, loud, and spiked signals at %i Hz', sampleRate => {
        const random = createRandomSource(LIMITER_SEED + sampleRate);
        for (const channelCount of LIMITER_CHANNEL_COUNTS) {
            const spiked = createRandomChannels(random, channelCount, LIMITER_SIGNAL_FRAME_COUNT, QUIET_AMPLITUDE);
            addSpikes(random, spiked);
            const signals: ReadonlyArray<readonly [ string, Float32Array[] ]> = [
                [ 'quiet', createSineChannels(channelCount, LIMITER_SIGNAL_FRAME_COUNT, QUIET_AMPLITUDE, sampleRate) ],
                [ 'loud sine', createSineChannels(channelCount, LIMITER_SIGNAL_FRAME_COUNT, LOUD_AMPLITUDE, sampleRate) ],
                [ 'loud noise', createRandomChannels(random, channelCount, LIMITER_SIGNAL_FRAME_COUNT, VERY_LOUD_AMPLITUDE) ],
                [ 'spiked', spiked ]
            ];
            for (const [ signalName, channelData ] of signals) {
                expectIdenticalLimiting(
                    createLimiterPair(sampleRate, channelCount, MAXIMUM_OUTPUT_FRAME_COUNT, MINIMUM_OUTPUT_FRAME_COUNT),
                    createLimiterPushes(random, channelData, sampleRate, LARGEST_RANDOM_LIMITER_INPUT_FRAME_COUNT),
                    `${sampleRate} Hz ${channelCount} channels ${signalName}`
                );
            }
        }
    });

    it('matches every channel count with spikes across many small chunks', () => {
        const random = createRandomSource(LIMITER_SEED + 1);
        for (const channelCount of CHANNEL_COUNTS) {
            const channelData = createRandomChannels(random, channelCount, SMALL_CHUNK_SIGNAL_FRAME_COUNT, QUIET_AMPLITUDE);
            addSpikes(random, channelData);
            expectIdenticalLimiting(
                createLimiterPair(TARGET_SAMPLE_RATE, channelCount, SMALL_CHUNK_MAXIMUM_FRAME_COUNT, SMALL_CHUNK_MINIMUM_FRAME_COUNT),
                createLimiterPushes(random, channelData, TARGET_SAMPLE_RATE, SMALL_CHUNK_LARGEST_INPUT_FRAME_COUNT),
                `${channelCount} channels small chunks`
            );
        }
    });

    it.each(CEILING_NEIGHBORS)('matches repeated peaks of %f beside the ceiling', peak => {
        const random = createRandomSource(LIMITER_SEED + 2);
        const channel = new Float32Array(CEILING_TEST_FRAME_COUNT);
        for (let frameIndex = 0; frameIndex < channel.length; frameIndex += CEILING_TEST_PEAK_SPACING) {
            channel[frameIndex] = peak;
        }
        expectIdenticalLimiting(
            createLimiterPair(TARGET_SAMPLE_RATE, 1, MAXIMUM_OUTPUT_FRAME_COUNT, MINIMUM_OUTPUT_FRAME_COUNT),
            createLimiterPushes(random, [ channel ], TARGET_SAMPLE_RATE, CEILING_TEST_LARGEST_INPUT_FRAME_COUNT),
            `peak ${peak}`
        );
    });

    it('matches one push of many inputs, larger than the ring', () => {
        const random = createRandomSource(LIMITER_SEED + 3);
        const channelData = createRandomChannels(random, STEREO_CHANNEL_COUNT, MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE * 2, LOUD_AMPLITUDE);
        const inputs: StreamingAudioResamplerOutput[] = [];
        for (let firstFrame = 0; firstFrame < channelData[0].length; firstFrame += MAXIMUM_OUTPUT_FRAME_COUNT) {
            const frameCount = Math.min(MAXIMUM_OUTPUT_FRAME_COUNT, channelData[0].length - firstFrame);
            inputs.push(createLimiterInput(
                channelData.map(channel => channel.slice(firstFrame, firstFrame + frameCount)),
                firstFrame,
                TARGET_SAMPLE_RATE
            ));
        }
        expectIdenticalLimiting(
            createLimiterPair(TARGET_SAMPLE_RATE, STEREO_CHANNEL_COUNT, MAXIMUM_OUTPUT_FRAME_COUNT, MINIMUM_OUTPUT_FRAME_COUNT),
            [ inputs ],
            'one large push'
        );
    });

    it.each([ Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY ])('rejects a %d sample with the reference error', sample => {
        const random = createRandomSource(LIMITER_SEED + 4);
        const channelData = createRandomChannels(random, STEREO_CHANNEL_COUNT, NON_FINITE_TEST_FRAME_COUNT, QUIET_AMPLITUDE);
        channelData[1][NON_FINITE_SAMPLE_FRAME] = sample;
        expectIdenticalLimiting(
            createLimiterPair(TARGET_SAMPLE_RATE, STEREO_CHANNEL_COUNT, MAXIMUM_OUTPUT_FRAME_COUNT, MINIMUM_OUTPUT_FRAME_COUNT),
            [ [ createLimiterInput(channelData, 0, TARGET_SAMPLE_RATE) ] ],
            `non-finite ${sample}`
        );
    });
});

describe('WebAssembly audio output stage pipeline, byte for byte against the JavaScript reference', () => {
    it('matches source rate changes with continuation, a late limiter, and the drained tails', () => {
        const random = createRandomSource(PIPELINE_SEED);
        const options = {
            ...createResamplerOptions(PIPELINE_SOURCE_SAMPLE_RATES[0], STEREO_CHANNEL_COUNT),
            peakLimiterEnabled: false
        };
        const createResamplerKernel = vi.spyOn(outputStageModule, 'createResamplerKernel');
        const createLimiterKernel = vi.spyOn(outputStageModule, 'createLimiterKernel');
        const kernel = new StreamingAudioOutputPipeline({ ...options, outputStageModule });
        const reference = new StreamingAudioOutputPipeline(options);
        let mediaTimeMicroseconds: number = ANCHOR_MEDIA_TIME_MICROSECONDS;
        for (let rateIndex = 0; rateIndex < PIPELINE_SOURCE_SAMPLE_RATES.length; rateIndex += 1) {
            const sourceSampleRate = PIPELINE_SOURCE_SAMPLE_RATES[rateIndex];
            expectIdenticalResults(
                runStep(() => kernel.changeSourceSampleRate(sourceSampleRate)),
                runStep(() => reference.changeSourceSampleRate(sourceSampleRate)),
                `rate change ${rateIndex}`
            );
            if (rateIndex === PIPELINE_LIMITER_RATE_INDEX) {
                kernel.enablePeakLimiter();
                reference.enablePeakLimiter();
            }
            for (let pushIndex = 0; pushIndex < PIPELINE_PUSHES_PER_RATE; pushIndex += 1) {
                const frameCount = randomInteger(random, 1, PIPELINE_LARGEST_PUSH_FRAME_COUNT);
                const input = {
                    channelData: createRandomChannels(random, STEREO_CHANNEL_COUNT, frameCount, LOUD_AMPLITUDE),
                    mediaTimeMicroseconds: requireMicroseconds(mediaTimeMicroseconds)
                };
                expectIdenticalResults(
                    runStep(() => kernel.push(input)),
                    runStep(() => reference.push(input)),
                    `rate ${rateIndex} push ${pushIndex}`
                );
                mediaTimeMicroseconds += framesToMicroseconds(frameCount, sourceSampleRate);
            }
            expect(kernel.getTelemetry(), `rate ${rateIndex} telemetry`).toEqual(reference.getTelemetry());
        }
        expectIdenticalResults(runStep(() => kernel.finalize()), runStep(() => reference.finalize()), 'finalize');
        expect(createResamplerKernel.mock.results.map(result => result.value)).toEqual(
            createResamplerKernel.mock.results.map(() => expect.any(AudioOutputStageResamplerKernel))
        );
        expect(createLimiterKernel).toHaveLastReturnedWith(expect.any(AudioOutputStageLimiterKernel));
    });

    it('matches a decoded 7.1 stage that folds down to stereo through the limiter', () => {
        const random = createRandomSource(PIPELINE_SEED + 1);
        const layout = getCustomAudioChannelLayout(SEVEN_POINT_ONE_CHANNEL_COUNT);
        if (!layout) {
            throw new Error('The 7.1 layout is unavailable');
        }
        const stageOptions = {
            maximumOutputFrameCount: MAXIMUM_OUTPUT_FRAME_COUNT,
            minimumOutputFrameCount: MINIMUM_OUTPUT_FRAME_COUNT,
            outputChannelCount: STEREO_CHANNEL_COUNT,
            routeCodec: SEVEN_POINT_ONE_ROUTE_CODEC,
            timestampToleranceMicroseconds: DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS
        } as const;
        const createLimiterKernel = vi.spyOn(outputStageModule, 'createLimiterKernel');
        const kernelStage = new DecodedAudioOutputStage({ ...stageOptions, outputStageModule });
        const referenceStage = new DecodedAudioOutputStage(stageOptions);
        const decodedFormat = { channelCount: SEVEN_POINT_ONE_CHANNEL_COUNT, layout, sampleRate: CD_SAMPLE_RATE };
        let mediaTimeMicroseconds: number = ANCHOR_MEDIA_TIME_MICROSECONDS;
        for (let pushIndex = 0; pushIndex < STAGE_PUSH_COUNT; pushIndex += 1) {
            const kernelInput = kernelStage.bind(decodedFormat, null);
            const referenceInput = referenceStage.bind(decodedFormat, null);
            const frameCount = randomInteger(random, STAGE_SMALLEST_PUSH_FRAME_COUNT, STAGE_LARGEST_PUSH_FRAME_COUNT);
            // The downmixed stereo the stage's pipeline takes, loud enough to limit
            const input = {
                channelData: createRandomChannels(random, STEREO_CHANNEL_COUNT, frameCount, VERY_LOUD_AMPLITUDE),
                mediaTimeMicroseconds: requireMicroseconds(mediaTimeMicroseconds)
            };
            expectIdenticalResults(
                runStep(() => [ ...kernelInput.outputs, ...kernelInput.pipeline.push(input) ]),
                runStep(() => [ ...referenceInput.outputs, ...referenceInput.pipeline.push(input) ]),
                `stage push ${pushIndex}`
            );
            mediaTimeMicroseconds += framesToMicroseconds(frameCount, CD_SAMPLE_RATE);
        }
        expect(kernelStage.getTelemetry()).toEqual(referenceStage.getTelemetry());
        expectIdenticalResults(runStep(() => kernelStage.finalize()), runStep(() => referenceStage.finalize()), 'stage finalize');
        expect(createLimiterKernel).toHaveLastReturnedWith(expect.any(AudioOutputStageLimiterKernel));
    });

    it('writes its chunks into the buffers the worklet returns, with the same bytes as the JavaScript reference', () => {
        const random = createRandomSource(PIPELINE_SEED + 3);
        const layout = getCustomAudioChannelLayout(SEVEN_POINT_ONE_CHANNEL_COUNT);
        if (!layout) {
            throw new Error('The 7.1 layout is unavailable');
        }
        const stageOptions = {
            maximumOutputFrameCount: MAXIMUM_OUTPUT_FRAME_COUNT,
            minimumOutputFrameCount: MINIMUM_OUTPUT_FRAME_COUNT,
            outputChannelCount: STEREO_CHANNEL_COUNT,
            routeCodec: SEVEN_POINT_ONE_ROUTE_CODEC,
            timestampToleranceMicroseconds: DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS
        } as const;
        const channelPool = new PCMChannelPool(MAXIMUM_OUTPUT_FRAME_COUNT, POOL_MAXIMUM_SPARE_BUFFER_COUNT);
        const pooledStage = new DecodedAudioOutputStage({ ...stageOptions, channelPool, outputStageModule });
        const referenceStage = new DecodedAudioOutputStage(stageOptions);
        const decodedFormat = { channelCount: SEVEN_POINT_ONE_CHANNEL_COUNT, layout, sampleRate: CD_SAMPLE_RATE };
        const returnedBuffers = new Set<ArrayBufferLike>();
        let reusedChannelCount = 0;
        // The worklet plays each chunk and returns its buffers, which later chunks reuse
        const playAndReturn = (result: StepResult): void => {
            for (const output of result.outputs) {
                for (const channel of output.channelData) {
                    expect(channel.buffer.byteLength).toBe(POOLED_CHANNEL_BYTE_LENGTH);
                    if (returnedBuffers.has(channel.buffer)) {
                        reusedChannelCount += 1;
                    }
                    returnedBuffers.add(channel.buffer);
                }
                channelPool.giveChannels(output.channelData);
            }
        };
        let mediaTimeMicroseconds: number = ANCHOR_MEDIA_TIME_MICROSECONDS;
        for (let pushIndex = 0; pushIndex < STAGE_PUSH_COUNT; pushIndex += 1) {
            const pooledInput = pooledStage.bind(decodedFormat, null);
            const referenceInput = referenceStage.bind(decodedFormat, null);
            const frameCount = randomInteger(random, STAGE_SMALLEST_PUSH_FRAME_COUNT, STAGE_LARGEST_PUSH_FRAME_COUNT);
            const input = {
                channelData: createRandomChannels(random, STEREO_CHANNEL_COUNT, frameCount, VERY_LOUD_AMPLITUDE),
                mediaTimeMicroseconds: requireMicroseconds(mediaTimeMicroseconds)
            };
            const pooledResult = runStep(() => [ ...pooledInput.outputs, ...pooledInput.pipeline.push(input) ]);
            expectIdenticalResults(
                pooledResult,
                runStep(() => [ ...referenceInput.outputs, ...referenceInput.pipeline.push(input) ]),
                `pooled push ${pushIndex}`
            );
            playAndReturn(pooledResult);
            mediaTimeMicroseconds += framesToMicroseconds(frameCount, CD_SAMPLE_RATE);
        }
        const pooledTail = runStep(() => pooledStage.finalize());
        expectIdenticalResults(pooledTail, runStep(() => referenceStage.finalize()), 'pooled finalize');
        playAndReturn(pooledTail);

        expect(reusedChannelCount).toBeGreaterThan(0);
        expect(channelPool.spareBufferCount).toBeLessThanOrEqual(POOL_MAXIMUM_SPARE_BUFFER_COUNT);
    });

    it('frees every kernel when an attempt closes its stage early', () => {
        const random = createRandomSource(PIPELINE_SEED + 2);
        const layout = getCustomAudioChannelLayout(SEVEN_POINT_ONE_CHANNEL_COUNT);
        if (!layout) {
            throw new Error('The 7.1 layout is unavailable');
        }
        const createResamplerKernel = vi.spyOn(outputStageModule, 'createResamplerKernel');
        const createLimiterKernel = vi.spyOn(outputStageModule, 'createLimiterKernel');
        const stage = new DecodedAudioOutputStage({
            maximumOutputFrameCount: MAXIMUM_OUTPUT_FRAME_COUNT,
            minimumOutputFrameCount: MINIMUM_OUTPUT_FRAME_COUNT,
            outputChannelCount: STEREO_CHANNEL_COUNT,
            outputStageModule,
            routeCodec: SEVEN_POINT_ONE_ROUTE_CODEC,
            timestampToleranceMicroseconds: DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS
        });
        const boundInput = stage.bind({ channelCount: SEVEN_POINT_ONE_CHANNEL_COUNT, layout, sampleRate: CD_SAMPLE_RATE }, null);
        boundInput.pipeline.push({
            channelData: createRandomChannels(random, STEREO_CHANNEL_COUNT, STAGE_LARGEST_PUSH_FRAME_COUNT, LOUD_AMPLITUDE),
            mediaTimeMicroseconds: ANCHOR_MEDIA_TIME_MICROSECONDS
        });

        stage.close();
        stage.close();

        const [ resamplerKernel ] = createResamplerKernel.mock.results.map(result => result.value as AudioOutputStageResamplerKernel);
        const [ limiterKernel ] = createLimiterKernel.mock.results.map(result => result.value as AudioOutputStageLimiterKernel);
        expect(() => resamplerKernel.discardBefore(0)).toThrow(RELEASED_RESAMPLER_KERNEL_MESSAGE);
        expect(() => limiterKernel.render(1)).toThrow(RELEASED_LIMITER_KERNEL_MESSAGE);
        expect(stage.finalize()).toEqual([]);
    });
});
