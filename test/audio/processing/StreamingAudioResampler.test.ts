import { describe, expect, it } from 'vitest';

import { requireMicroseconds } from 'webgpu-player/TimeMath';
import StreamingAudioResampler, {
    MAXIMUM_AUDIO_TIMELINE_CORRECTION_MICROSECONDS,
    type StreamingAudioResamplerContinuation,
    type StreamingAudioResamplerOutput,
    type StreamingAudioTimelineCorrection
} from 'webgpu-player/audio/processing/StreamingAudioResampler';

const TARGET_SAMPLE_RATE = 48_000;
const DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS = 1_000;
const DTS_TIMESTAMP_QUANTIZATION_MICROSECONDS = 3_000;
// One 1/1200 s TrueHD access unit, rounded up
const TRUEHD_ACCESS_UNIT_ALLOWANCE_MICROSECONDS = 834;
// Chunk boundaries round independently to whole microseconds
const OUTPUT_TIMESTAMP_ROUNDING_MICROSECONDS = 1;

// The kernel radius qualified for sources up to 192 kHz, which widens in proportion past it
const QUALIFIED_FILTER_RADIUS = 32;
const QUALIFIED_FILTER_SOURCE_SAMPLE_RATE = 192_000;
const DXD_SAMPLE_RATE = 352_800;
const DXD_48_KHZ_FAMILY_SAMPLE_RATE = 384_000;
const CHROMIUM_DECODER_HIGHEST_SAMPLE_RATE = 768_000;
const PASSBAND_TONE_FREQUENCY = 10_000;
// Past the transition band of the 192 kHz kernel at a 48 kHz target
const STOPBAND_TONE_FREQUENCY = 40_000;
const MINIMUM_PASSBAND_ROOT_MEAN_SQUARE = 0.65;
const MAXIMUM_STOPBAND_ROOT_MEAN_SQUARE = 0.002;
// Skips the filter's edge-extended start
const SETTLED_OUTPUT_FRAME = 128;
const RESAMPLED_SECONDS_FRACTION = 4;
// Malformed rates; any positive integer rate is valid
const ZERO_SAMPLE_RATE = 0;
const FRACTIONAL_SAMPLE_RATE = 48_000.5;
const MALFORMED_SOURCE_RATE_ERROR = 'Source sample rate must be a positive integer number of Hz';

function createPassthroughResampler(
    maximumTimestampQuantizationMicroseconds: number
): StreamingAudioResampler {
    return new StreamingAudioResampler({
        channelCount: 2,
        maximumOutputFrameCount: 1_024,
        maximumTimestampQuantizationMicroseconds,
        minimumOutputFrameCount: 1,
        sourceSampleRate: TARGET_SAMPLE_RATE,
        targetSampleRate: TARGET_SAMPLE_RATE
    });
}

/** Creates a mono 48 kHz passthrough resampler that records its timeline corrections. */
function createRecordingResampler(
    corrections: StreamingAudioTimelineCorrection[]
): StreamingAudioResampler {
    return new StreamingAudioResampler({
        channelCount: 1,
        maximumOutputFrameCount: 1_024,
        maximumTimestampQuantizationMicroseconds: DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
        minimumOutputFrameCount: 1,
        onTimelineCorrection: correction => {
            corrections.push(correction);
        },
        sourceSampleRate: TARGET_SAMPLE_RATE,
        targetSampleRate: TARGET_SAMPLE_RATE
    });
}

function expectContiguousOutput(output: readonly StreamingAudioResamplerOutput[]): void {
    for (let outputIndex = 1; outputIndex < output.length; outputIndex += 1) {
        const previousOutput = output[outputIndex - 1];
        const expectedMediaTimeMicroseconds = previousOutput.mediaTimeMicroseconds
            + previousOutput.durationMicroseconds;
        expect(Math.abs(output[outputIndex].mediaTimeMicroseconds - expectedMediaTimeMicroseconds))
            .toBeLessThanOrEqual(OUTPUT_TIMESTAMP_ROUNDING_MICROSECONDS);
    }
}

function concatenateOutput(
    output: readonly StreamingAudioResamplerOutput[],
    channelIndex = 0
): Float32Array {
    const frameCount = output.reduce((sum, chunk) => sum + chunk.frameCount, 0);
    const combined = new Float32Array(frameCount);
    let frameOffset = 0;
    for (const chunk of output) {
        combined.set(chunk.channelData[channelIndex], frameOffset);
        frameOffset += chunk.frameCount;
    }
    return combined;
}

function createSine(sampleRate: number, frequency: number, frameCount: number): Float32Array {
    const output = new Float32Array(frameCount);
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        output[frameIndex] = Math.sin(
            2 * Math.PI * frequency * frameIndex / sampleRate
        );
    }
    return output;
}

function calculateRootMeanSquare(samples: Float32Array, startFrame: number): number {
    let squareSum = 0;
    for (let frameIndex = startFrame; frameIndex < samples.length; frameIndex += 1) {
        squareSum += samples[frameIndex] * samples[frameIndex];
    }
    return Math.sqrt(squareSum / (samples.length - startFrame));
}

/** Resamples a quarter second of one tone to the target rate and returns its settled RMS. */
function getResampledToneRootMeanSquare(sourceSampleRate: number, frequency: number): number {
    const resampler = new StreamingAudioResampler({
        channelCount: 1,
        maximumOutputFrameCount: 65_536,
        maximumTimestampQuantizationMicroseconds: DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
        minimumOutputFrameCount: 1,
        sourceSampleRate,
        targetSampleRate: TARGET_SAMPLE_RATE
    });
    const output = resampler.push({
        channelData: [ createSine(sourceSampleRate, frequency, sourceSampleRate / RESAMPLED_SECONDS_FRACTION) ],
        mediaTimeMicroseconds: requireMicroseconds(0)
    });
    output.push(...resampler.finalize());
    return calculateRootMeanSquare(concatenateOutput(output), SETTLED_OUTPUT_FRAME);
}

describe('StreamingAudioResampler', () => {
    it('passes 48 kHz PCM through exactly and splits bounded output chunks', () => {
        const resampler = new StreamingAudioResampler({
            channelCount: 2,
            maximumOutputFrameCount: 3,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate: TARGET_SAMPLE_RATE,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        const left = new Float32Array([ 1, 2, 3, 4, 5 ]);
        const right = new Float32Array([ -1, -2, -3, -4, -5 ]);
        const output = resampler.push({
            channelData: [ left, right ],
            mediaTimeMicroseconds: requireMicroseconds(2_000_000)
        });

        expect(output.map(chunk => chunk.frameCount)).toEqual([ 3, 2 ]);
        expect(concatenateOutput(output)).toEqual(left);
        expect(concatenateOutput(output, 1)).toEqual(right);
        expect(output[0].mediaTimeMicroseconds).toBe(2_000_000);
        expect(output[1].mediaTimeMicroseconds).toBe(2_000_063);
        expect(resampler.finalize()).toEqual([]);
        expect(resampler.getTelemetry()).toEqual({
            absorbedInputCount: 0,
            bufferedSourceFrameCount: 0,
            droppedInputCount: 0,
            filledInputCount: 0,
            filterLatencySourceFrames: 0,
            finalized: true,
            maximumInputTimestampDeviationMicroseconds: 0,
            outputFrameCount: 5,
            sourceFrameCount: 5,
            trimmedInputCount: 0
        });
    });

    it('batches tiny passthrough packets into scheduler-safe output chunks', () => {
        const minimumOutputFrameCount = 1_920;
        const packetFrameCount = 240;
        const resampler = new StreamingAudioResampler({
            channelCount: 2,
            maximumOutputFrameCount: 65_536,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount,
            sourceSampleRate: TARGET_SAMPLE_RATE,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        const output: StreamingAudioResamplerOutput[] = [];

        for (let packetIndex = 0; packetIndex < 10; packetIndex += 1) {
            const packetOutput = resampler.push({
                channelData: [
                    new Float32Array(packetFrameCount).fill(packetIndex),
                    new Float32Array(packetFrameCount).fill(-packetIndex)
                ],
                mediaTimeMicroseconds: requireMicroseconds(packetIndex * 5_000)
            });
            if (packetIndex < 7) {
                expect(packetOutput).toEqual([]);
            }
            output.push(...packetOutput);
        }

        expect(output).toHaveLength(1);
        expect(output[0]).toMatchObject({
            durationMicroseconds: 40_000,
            frameCount: minimumOutputFrameCount,
            mediaTimeMicroseconds: 0
        });
        const terminalOutput = resampler.finalize();
        expect(terminalOutput).toHaveLength(1);
        expect(terminalOutput[0]).toMatchObject({
            durationMicroseconds: 10_000,
            frameCount: 480,
            mediaTimeMicroseconds: 40_000
        });
        expect(resampler.getTelemetry()).toMatchObject({
            bufferedSourceFrameCount: 0,
            outputFrameCount: 2_400,
            sourceFrameCount: 2_400
        });
    });

    it('produces identical 44.1 kHz output across arbitrary input boundaries', () => {
        const sourceSampleRate = 44_100;
        const source = createSine(sourceSampleRate, 1_000, sourceSampleRate / 5);
        const createResampler = (): StreamingAudioResampler => new StreamingAudioResampler({
            channelCount: 1,
            maximumOutputFrameCount: 65_536,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate,
            targetSampleRate: TARGET_SAMPLE_RATE
        });

        const contiguousResampler = createResampler();
        const contiguousOutput = contiguousResampler.push({
            channelData: [ source ],
            mediaTimeMicroseconds: requireMicroseconds(1_000_000)
        });
        contiguousOutput.push(...contiguousResampler.finalize());

        const splitResampler = createResampler();
        const splitOutput: StreamingAudioResamplerOutput[] = [];
        const splitFrames = [ 137, 2_048, 17, 4_096, source.length - 6_298 ];
        let sourceOffset = 0;
        for (const frameCount of splitFrames) {
            splitOutput.push(...splitResampler.push({
                channelData: [ source.slice(sourceOffset, sourceOffset + frameCount) ],
                mediaTimeMicroseconds: requireMicroseconds(
                    1_000_000 + Math.round(sourceOffset * 1_000_000 / sourceSampleRate)
                )
            }));
            sourceOffset += frameCount;
        }
        splitOutput.push(...splitResampler.finalize());

        const contiguousSamples = concatenateOutput(contiguousOutput);
        const splitSamples = concatenateOutput(splitOutput);
        expect(splitSamples.length).toBe(9_600);
        expect(splitSamples).toEqual(contiguousSamples);
        expect(splitOutput[0].mediaTimeMicroseconds).toBe(1_000_000);
        expect(splitOutput.at(-1)?.sampleRate).toBe(TARGET_SAMPLE_RATE);
        expect(calculateRootMeanSquare(splitSamples, 128)).toBeCloseTo(Math.SQRT1_2, 3);
        expect(splitResampler.getTelemetry().bufferedSourceFrameCount).toBe(0);
    });

    it('suppresses frequencies above the target Nyquist limit while downsampling', () => {
        const sourceSampleRate = 96_000;
        const frameCount = sourceSampleRate / 4;
        const passbandResampler = new StreamingAudioResampler({
            channelCount: 1,
            maximumOutputFrameCount: 65_536,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        const stopbandResampler = new StreamingAudioResampler({
            channelCount: 1,
            maximumOutputFrameCount: 65_536,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate,
            targetSampleRate: TARGET_SAMPLE_RATE
        });

        const passbandOutput = passbandResampler.push({
            channelData: [ createSine(sourceSampleRate, 10_000, frameCount) ],
            mediaTimeMicroseconds: requireMicroseconds(0)
        });
        passbandOutput.push(...passbandResampler.finalize());
        const stopbandOutput = stopbandResampler.push({
            channelData: [ createSine(sourceSampleRate, 30_000, frameCount) ],
            mediaTimeMicroseconds: requireMicroseconds(0)
        });
        stopbandOutput.push(...stopbandResampler.finalize());

        const passbandRootMeanSquare = calculateRootMeanSquare(
            concatenateOutput(passbandOutput),
            128
        );
        const stopbandRootMeanSquare = calculateRootMeanSquare(
            concatenateOutput(stopbandOutput),
            128
        );
        expect(passbandRootMeanSquare).toBeGreaterThan(0.65);
        expect(stopbandRootMeanSquare).toBeLessThan(0.002);
    });

    it('resamples an integer source rate not represented by a vector', () => {
        const sourceSampleRate = 12_345;
        const source = createSine(sourceSampleRate, 1_000, sourceSampleRate / 5);
        const resampler = new StreamingAudioResampler({
            channelCount: 1,
            maximumOutputFrameCount: 65_536,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate,
            targetSampleRate: TARGET_SAMPLE_RATE
        });

        const output = resampler.push({
            channelData: [ source ],
            mediaTimeMicroseconds: requireMicroseconds(0)
        });
        output.push(...resampler.finalize());

        const samples = concatenateOutput(output);
        expect(samples).toHaveLength(9_600);
        expect(calculateRootMeanSquare(samples, 128)).toBeCloseTo(Math.SQRT1_2, 2);
    });

    it.each([ ZERO_SAMPLE_RATE, FRACTIONAL_SAMPLE_RATE ])('rejects malformed source rate %d', sampleRate => {
        expect(() => new StreamingAudioResampler({
            channelCount: 1,
            maximumOutputFrameCount: 1_024,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate: sampleRate,
            targetSampleRate: TARGET_SAMPLE_RATE
        })).toThrow(MALFORMED_SOURCE_RATE_ERROR);
    });

    it.each([
        QUALIFIED_FILTER_SOURCE_SAMPLE_RATE,
        DXD_SAMPLE_RATE,
        DXD_48_KHZ_FAMILY_SAMPLE_RATE,
        CHROMIUM_DECODER_HIGHEST_SAMPLE_RATE
    ])('keeps the 192 kHz band edge for a %d Hz source with a proportionally wider kernel', sourceSampleRate => {
        const resampler = new StreamingAudioResampler({
            channelCount: 1,
            maximumOutputFrameCount: 1_024,
            maximumTimestampQuantizationMicroseconds: DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate,
            targetSampleRate: TARGET_SAMPLE_RATE
        });

        expect(resampler.getTelemetry().filterLatencySourceFrames).toBe(Math.ceil(
            QUALIFIED_FILTER_RADIUS * sourceSampleRate / QUALIFIED_FILTER_SOURCE_SAMPLE_RATE
        ));
        expect(getResampledToneRootMeanSquare(sourceSampleRate, PASSBAND_TONE_FREQUENCY))
            .toBeGreaterThan(MINIMUM_PASSBAND_ROOT_MEAN_SQUARE);
        expect(getResampledToneRootMeanSquare(sourceSampleRate, STOPBAND_TONE_FREQUENCY))
            .toBeLessThan(MAXIMUM_STOPBAND_ROOT_MEAN_SQUARE);
    });

    it('canonicalizes bounded Matroska DTS timestamp quantization', () => {
        const resampler = new StreamingAudioResampler({
            channelCount: 2,
            maximumOutputFrameCount: 1_024,
            maximumTimestampQuantizationMicroseconds:
                DTS_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate: TARGET_SAMPLE_RATE,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        const DTSFrame = new Float32Array(512);
        const packetTimestamps = [ 0, 10_000, 21_000, 31_000, 42_000, 53_000 ];
        const output: StreamingAudioResamplerOutput[] = [];
        for (const packetTimestamp of packetTimestamps) {
            output.push(...resampler.push({
                channelData: [ DTSFrame, DTSFrame ],
                mediaTimeMicroseconds: requireMicroseconds(packetTimestamp)
            }));
        }

        expect(output.map(chunk => chunk.mediaTimeMicroseconds)).toEqual([
            0,
            10_667,
            21_333,
            32_000,
            42_667,
            53_333
        ]);
        expect(resampler.getTelemetry()).toMatchObject({
            absorbedInputCount: 5,
            maximumInputTimestampDeviationMicroseconds: 1_000
        });
    });

    it('accounts for independent Matroska anchor and packet quantization', () => {
        const resampler = new StreamingAudioResampler({
            channelCount: 2,
            maximumOutputFrameCount: 1_024,
            maximumTimestampQuantizationMicroseconds:
                DTS_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate: TARGET_SAMPLE_RATE,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        const DTSFrame = new Float32Array(512);
        const packetTimestamps = [
            0, 10_000, 21_000, 31_000, 42_000, 53_000, 63_000, 74_000,
            86_000, 96_000, 107_000, 117_000, 128_000, 139_000, 149_000,
            160_000, 171_000, 181_000, 192_000, 202_000, 213_000, 224_000,
            234_000, 245_000, 256_000, 266_000, 277_000, 287_000, 298_000,
            308_000
        ];
        const output: StreamingAudioResamplerOutput[] = [];
        for (const packetTimestamp of packetTimestamps) {
            output.push(...resampler.push({
                channelData: [ DTSFrame, DTSFrame ],
                mediaTimeMicroseconds: requireMicroseconds(packetTimestamp)
            }));
        }

        expect(output).toHaveLength(packetTimestamps.length);
        expect(output.at(-1)?.mediaTimeMicroseconds).toBe(309_333);
        expect(resampler.getTelemetry()).toMatchObject({
            absorbedInputCount: 23,
            maximumInputTimestampDeviationMicroseconds: 1_333
        });
    });

    it('canonicalizes the observed Matroska DTS lace phase excursion', () => {
        const resampler = new StreamingAudioResampler({
            channelCount: 2,
            maximumOutputFrameCount: 1_024,
            maximumTimestampQuantizationMicroseconds:
                DTS_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate: TARGET_SAMPLE_RATE,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        const DTSFrame = new Float32Array(512);
        // One 13 ms block boundary is followed by eight 10.375 ms lace intervals
        const packetTimestamps = [
            0, 13_000, 23_375, 33_750, 44_125, 54_500, 64_875, 75_250,
            85_625, 96_000
        ];
        const output: StreamingAudioResamplerOutput[] = [];
        for (const packetTimestamp of packetTimestamps) {
            output.push(...resampler.push({
                channelData: [ DTSFrame, DTSFrame ],
                mediaTimeMicroseconds: requireMicroseconds(packetTimestamp)
            }));
        }

        expect(output.map(chunk => chunk.mediaTimeMicroseconds)).toEqual([
            0, 10_667, 21_333, 32_000, 42_667, 53_333, 64_000, 74_667,
            85_333, 96_000
        ]);
        expect(resampler.getTelemetry()).toMatchObject({
            absorbedInputCount: 8,
            maximumInputTimestampDeviationMicroseconds: 2_333
        });
    });

    it('fills sustained DTS timestamp drift beyond the lacing bound with silence', () => {
        const resampler = createPassthroughResampler(DTS_TIMESTAMP_QUANTIZATION_MICROSECONDS);
        const DTSFrame = new Float32Array(512).fill(0.5);
        const output: StreamingAudioResamplerOutput[] = [];
        for (let packetIndex = 0; packetIndex < 10; packetIndex += 1) {
            output.push(...resampler.push({
                channelData: [ DTSFrame, DTSFrame ],
                mediaTimeMicroseconds: requireMicroseconds(packetIndex * 11_000)
            }));
        }

        // Expected 106667 microseconds; 3333 exceeds the 3021 microsecond tolerance
        const driftOutput = resampler.push({
            channelData: [ DTSFrame, DTSFrame ],
            mediaTimeMicroseconds: requireMicroseconds(110_000)
        });
        output.push(...driftOutput);

        expect(driftOutput.map(chunk => chunk.frameCount)).toEqual([ 160, 512 ]);
        expect(driftOutput[0].mediaTimeMicroseconds).toBe(106_667);
        expect(Array.from(driftOutput[0].channelData[0]).every(sample => sample === 0)).toBe(true);
        expect(driftOutput[1].mediaTimeMicroseconds).toBe(110_000);
        expectContiguousOutput(output);
        expect(resampler.getTelemetry()).toMatchObject({
            absorbedInputCount: 9,
            filledInputCount: 1,
            sourceFrameCount: 11 * 512 + 160
        });
    });

    it('fills an ordinary route gap that the wider DTS tolerance absorbs', () => {
        const frame = new Float32Array(512);
        const timestamps = [ 0, 12_000 ];
        const ordinaryResampler = createPassthroughResampler(
            DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS
        );
        const DTSResampler = createPassthroughResampler(DTS_TIMESTAMP_QUANTIZATION_MICROSECONDS);
        for (const timestamp of timestamps) {
            for (const resampler of [ ordinaryResampler, DTSResampler ]) {
                resampler.push({
                    channelData: [ frame, frame ],
                    mediaTimeMicroseconds: requireMicroseconds(timestamp)
                });
            }
        }

        expect(ordinaryResampler.getTelemetry()).toMatchObject({
            absorbedInputCount: 0,
            filledInputCount: 1,
            sourceFrameCount: 512 + 64 + 512
        });
        expect(DTSResampler.getTelemetry()).toMatchObject({
            absorbedInputCount: 1,
            filledInputCount: 0,
            sourceFrameCount: 1_024
        });
    });

    it.each([
        [ 48_000, 512 ],
        [ 96_000, 1_024 ],
        [ 192_000, 2_048 ]
    ] as const)(
        'fills a missing %d Hz DTS packet with silence',
        (sourceSampleRate, DTSFrameCount) => {
            const resampler = new StreamingAudioResampler({
                channelCount: 2,
                maximumOutputFrameCount: 1_024,
                maximumTimestampQuantizationMicroseconds:
                    DTS_TIMESTAMP_QUANTIZATION_MICROSECONDS,
                minimumOutputFrameCount: 1,
                sourceSampleRate,
                targetSampleRate: TARGET_SAMPLE_RATE
            });
            const DTSFrame = new Float32Array(DTSFrameCount);
            const output: StreamingAudioResamplerOutput[] = [];
            for (const packetTimestamp of [ 0, 10_000, 32_000 ]) {
                output.push(...resampler.push({
                    channelData: [ DTSFrame, DTSFrame ],
                    mediaTimeMicroseconds: requireMicroseconds(packetTimestamp)
                }));
            }
            output.push(...resampler.finalize());

            expectContiguousOutput(output);
            expect(resampler.getTelemetry()).toMatchObject({
                filledInputCount: 1,
                sourceFrameCount: 4 * DTSFrameCount
            });
        }
    );

    it('bounds retained history while filling a long timeline gap', () => {
        const resampler = new StreamingAudioResampler({
            channelCount: 1,
            maximumOutputFrameCount: 4_096,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate: 192_000,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        const input = new Float32Array(2_048);
        const output: StreamingAudioResamplerOutput[] = [];
        let sourceFrameOffset = 0;
        for (let chunkIndex = 0; chunkIndex < 40; chunkIndex += 1) {
            output.push(...resampler.push({
                channelData: [ input ],
                mediaTimeMicroseconds: requireMicroseconds(
                    Math.round(sourceFrameOffset * 1_000_000 / 192_000)
                )
            }));
            sourceFrameOffset += input.length;
            expect(resampler.getTelemetry().bufferedSourceFrameCount).toBeLessThanOrEqual(160);
        }

        // 572333 microseconds after the expected 426667 inserts 109888 silent source frames
        output.push(...resampler.push({
            channelData: [ input ],
            mediaTimeMicroseconds: requireMicroseconds(999_000)
        }));

        expect(resampler.getTelemetry()).toMatchObject({
            filledInputCount: 1,
            sourceFrameCount: 41 * 2_048 + 109_888
        });
        expect(resampler.getTelemetry().bufferedSourceFrameCount).toBeLessThanOrEqual(160);
        expect(output.every(chunk => chunk.frameCount <= 4_096)).toBe(true);
        expectContiguousOutput(output);
    });

    it('absorbs a TrueHD access unit that decoded to no PCM within its allowance', () => {
        const accessUnit = new Float32Array(40).fill(0.25);
        const timestamps = [ 0, 1_000, 2_000, 3_000, 3_000, 4_000, 5_000, 7_000 ];
        const trueHDResampler = createPassthroughResampler(
            DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS
                + TRUEHD_ACCESS_UNIT_ALLOWANCE_MICROSECONDS
        );
        const ordinaryResampler = createPassthroughResampler(
            DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS
        );
        const output: StreamingAudioResamplerOutput[] = [];
        for (const timestamp of timestamps) {
            output.push(...trueHDResampler.push({
                channelData: [ accessUnit, accessUnit ],
                mediaTimeMicroseconds: requireMicroseconds(timestamp)
            }));
            ordinaryResampler.push({
                channelData: [ accessUnit, accessUnit ],
                mediaTimeMicroseconds: requireMicroseconds(timestamp)
            });
        }

        expect(output.map(chunk => chunk.mediaTimeMicroseconds)).toEqual([
            0, 833, 1_667, 2_500, 3_333, 4_167, 5_000, 5_833
        ]);
        expect(trueHDResampler.getTelemetry()).toMatchObject({
            absorbedInputCount: 6,
            filledInputCount: 0,
            maximumInputTimestampDeviationMicroseconds: 1_167,
            sourceFrameCount: 320
        });
        // The field failure: 1167 microseconds exceeded the former 1021 microsecond tolerance
        expect(ordinaryResampler.getTelemetry().filledInputCount).toBe(1);
    });

    it('absorbs a zero-duration Matroska lace whose frames share one timestamp', () => {
        const resampler = createPassthroughResampler(DTS_TIMESTAMP_QUANTIZATION_MICROSECONDS);
        const DTSFrame = new Float32Array(512).fill(0.5);
        const output: StreamingAudioResamplerOutput[] = [];
        for (const timestamp of [ 0, 11_000, 11_000, 11_000, 11_000, 53_000 ]) {
            output.push(...resampler.push({
                channelData: [ DTSFrame, DTSFrame ],
                mediaTimeMicroseconds: requireMicroseconds(timestamp)
            }));
        }

        expect(output.map(chunk => chunk.mediaTimeMicroseconds)).toEqual([
            0, 10_667, 21_333, 32_000, 42_667, 53_333
        ]);
        expectContiguousOutput(output);
        expect(resampler.getTelemetry()).toMatchObject({
            absorbedInputCount: 5,
            droppedInputCount: 0,
            filledInputCount: 0,
            maximumInputTimestampDeviationMicroseconds: 333,
            sourceFrameCount: 6 * 512,
            trimmedInputCount: 0
        });
    });

    it('trims the head of an input that overlaps accepted audio', () => {
        const resampler = createPassthroughResampler(DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS);
        const firstInput = new Float32Array(480).fill(0.125);
        const overlappingInput = Float32Array.from(
            { length: 480 },
            (_value, frameIndex): number => frameIndex
        );
        const output = resampler.push({
            channelData: [ firstInput, firstInput ],
            mediaTimeMicroseconds: requireMicroseconds(0)
        });
        // Starts 5000 microseconds, 240 frames, before the expected 10000
        output.push(...resampler.push({
            channelData: [ overlappingInput, overlappingInput ],
            mediaTimeMicroseconds: requireMicroseconds(5_000)
        }));

        expect(output.map(chunk => chunk.frameCount)).toEqual([ 480, 240 ]);
        expect(output[1].mediaTimeMicroseconds).toBe(10_000);
        expect(output[1].channelData[0][0]).toBe(240);
        expect(output[1].channelData[0][239]).toBe(479);
        expect(resampler.getTelemetry()).toMatchObject({
            sourceFrameCount: 720,
            trimmedInputCount: 1
        });
    });

    it('drops an overlapping input whose remainder is within tolerance', () => {
        const resampler = createPassthroughResampler(DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS);
        const input = new Float32Array(480).fill(0.125);
        const output = resampler.push({
            channelData: [ input, input ],
            mediaTimeMicroseconds: requireMicroseconds(0)
        });
        // Trimming 432 of 480 frames would leave 1000 microseconds, inside the 1021 tolerance
        expect(resampler.push({
            channelData: [ input, input ],
            mediaTimeMicroseconds: requireMicroseconds(1_000)
        })).toEqual([]);
        output.push(...resampler.push({
            channelData: [ input, input ],
            mediaTimeMicroseconds: requireMicroseconds(10_000)
        }));

        expect(output.map(chunk => chunk.mediaTimeMicroseconds)).toEqual([ 0, 10_000 ]);
        expect(resampler.getTelemetry()).toMatchObject({
            droppedInputCount: 1,
            sourceFrameCount: 960,
            trimmedInputCount: 0
        });
    });

    it('bounds silence fills and overlap trims at two seconds', () => {
        expect(MAXIMUM_AUDIO_TIMELINE_CORRECTION_MICROSECONDS).toBe(2_000_000);
        const resampler = createPassthroughResampler(DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS);
        const input = new Float32Array(480);
        resampler.push({
            channelData: [ input, input ],
            mediaTimeMicroseconds: requireMicroseconds(0)
        });
        // A gap exactly at the bound is still filled
        resampler.push({
            channelData: [ input, input ],
            mediaTimeMicroseconds: requireMicroseconds(2_010_000)
        });

        expect(resampler.getTelemetry()).toMatchObject({
            filledInputCount: 1,
            sourceFrameCount: 960 + 96_000
        });
    });

    it('fails a forward jump beyond the correction bound instead of moving the timeline', () => {
        const corrections: StreamingAudioTimelineCorrection[] = [];
        const resampler = createRecordingResampler(corrections);
        const input = new Float32Array(480);
        for (const timestamp of [ 5_000_000, 5_010_000 ]) {
            resampler.push({
                channelData: [ input ],
                mediaTimeMicroseconds: requireMicroseconds(timestamp)
            });
        }

        // A real gap in both tracks would leave audio permanently ahead of video
        expect(() => resampler.push({
            channelData: [ input ],
            mediaTimeMicroseconds: requireMicroseconds(7_020_001)
        })).toThrow(
            'Resampler input timestamps contain a gap or overlap beyond the correction bound: '
            + 'expected 5020000 microseconds, received 7020001 microseconds, '
            + 'deviation 2000001 microseconds, bound 2000000 microseconds, '
            + 'after 960 source frames'
        );
        expect(corrections).toEqual([ {
            correctionMicroseconds: 2_000_001,
            expectedMediaTimeMicroseconds: 5_020_000,
            inputMediaTimeMicroseconds: 7_020_001,
            kind: 'reject'
        } ]);
    });

    it('fails a backward timestamp reset once the next input reveals it', () => {
        const corrections: StreamingAudioTimelineCorrection[] = [];
        const resampler = createRecordingResampler(corrections);
        const input = new Float32Array(480);
        // The first reset input is non-advancing, which a Matroska lace frame can also be
        for (const timestamp of [ 5_000_000, 5_010_000, 0 ]) {
            resampler.push({
                channelData: [ input ],
                mediaTimeMicroseconds: requireMicroseconds(timestamp)
            });
        }

        // Moving the timeline back would make every later frame late
        expect(() => resampler.push({
            channelData: [ input ],
            mediaTimeMicroseconds: requireMicroseconds(10_000)
        })).toThrow('expected 5030000 microseconds, received 10000 microseconds');
        expect(corrections).toEqual([ {
            correctionMicroseconds: -5_020_000,
            expectedMediaTimeMicroseconds: 5_030_000,
            inputMediaTimeMicroseconds: 10_000,
            kind: 'reject'
        } ]);
    });

    it('fails a gap beyond a configured correction bound', () => {
        const resampler = new StreamingAudioResampler({
            channelCount: 1,
            maximumOutputFrameCount: 1_024,
            maximumTimelineCorrectionMicroseconds: 50_000,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate: TARGET_SAMPLE_RATE,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        const input = new Float32Array(480);
        resampler.push({
            channelData: [ input ],
            mediaTimeMicroseconds: requireMicroseconds(0)
        });

        expect(() => resampler.push({
            channelData: [ input ],
            mediaTimeMicroseconds: requireMicroseconds(70_000)
        })).toThrow('deviation 60000 microseconds, bound 50000 microseconds');
        expect(resampler.getTelemetry()).toMatchObject({
            filledInputCount: 0,
            sourceFrameCount: 480
        });
    });

    it('fills after a single forward outlier and trims the overlap that follows it', () => {
        const resampler = createPassthroughResampler(DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS);
        const packet = new Float32Array(480).fill(0.5);
        const output: StreamingAudioResamplerOutput[] = [];
        // The 35 ms packet should be at 30 ms; its neighbors keep the 10 ms cadence
        for (const timestamp of [ 0, 10_000, 20_000, 35_000, 40_000, 50_000 ]) {
            output.push(...resampler.push({
                channelData: [ packet, packet ],
                mediaTimeMicroseconds: requireMicroseconds(timestamp)
            }));
        }

        expectContiguousOutput(output);
        expect(output.map(chunk => [ chunk.mediaTimeMicroseconds, chunk.frameCount ])).toEqual([
            [ 0, 480 ],
            [ 10_000, 480 ],
            [ 20_000, 480 ],
            [ 30_000, 240 ],
            [ 35_000, 480 ],
            [ 45_000, 240 ],
            [ 50_000, 480 ]
        ]);
        expect(output[3].channelData[0].every(sample => sample === 0)).toBe(true);
        // The 5 ms of silence and the 5 ms trim cancel, so the timeline is back on cadence
        expect(resampler.getTelemetry()).toMatchObject({
            filledInputCount: 1,
            sourceFrameCount: 6 * 480,
            trimmedInputCount: 1
        });
    });

    it('plays a duplicated packet once more and drops the packet it displaced', () => {
        const resampler = createPassthroughResampler(DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS);
        const output: StreamingAudioResamplerOutput[] = [];
        const timestamps = [ 0, 10_000, 20_000, 20_000, 30_000, 40_000 ];
        for (let packetIndex = 0; packetIndex < timestamps.length; packetIndex += 1) {
            const packet = new Float32Array(480).fill(packetIndex + 1);
            output.push(...resampler.push({
                channelData: [ packet, packet ],
                mediaTimeMicroseconds: requireMicroseconds(timestamps[packetIndex])
            }));
        }

        expectContiguousOutput(output);
        // A duplicate cannot be told from a lace frame by its timestamp, so it plays as non-advancing
        expect(output.map(chunk => [ chunk.mediaTimeMicroseconds, chunk.channelData[0][0] ])).toEqual([
            [ 0, 1 ],
            [ 10_000, 2 ],
            [ 20_000, 3 ],
            [ 30_000, 4 ],
            [ 40_000, 6 ]
        ]);
        expect(resampler.getTelemetry()).toMatchObject({
            absorbedInputCount: 1,
            droppedInputCount: 1,
            sourceFrameCount: 5 * 480
        });
    });

    it('reports every applied correction to its listener', () => {
        const corrections: StreamingAudioTimelineCorrection[] = [];
        const resampler = createRecordingResampler(corrections);
        const packet = new Float32Array(480);
        // Absorbed jitter is not a correction; the gap, trim, and drop are
        for (const timestamp of [ 0, 10_500, 125_000, 130_000, 130_000 ]) {
            resampler.push({
                channelData: [ packet ],
                mediaTimeMicroseconds: requireMicroseconds(timestamp)
            });
        }
        resampler.push({
            channelData: [ packet ],
            mediaTimeMicroseconds: requireMicroseconds(140_000)
        });

        expect(corrections).toEqual([
            {
                correctionMicroseconds: 105_000,
                expectedMediaTimeMicroseconds: 20_000,
                inputMediaTimeMicroseconds: 125_000,
                kind: 'fill'
            },
            {
                correctionMicroseconds: -5_000,
                expectedMediaTimeMicroseconds: 135_000,
                inputMediaTimeMicroseconds: 130_000,
                kind: 'trim'
            },
            {
                correctionMicroseconds: -10_000,
                expectedMediaTimeMicroseconds: 150_000,
                inputMediaTimeMicroseconds: 140_000,
                kind: 'drop'
            }
        ]);
    });

    it('fills a long gap in silent slices bounded by the maximum output chunk', () => {
        const resampler = new StreamingAudioResampler({
            channelCount: 2,
            maximumOutputFrameCount: 1_000,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate: TARGET_SAMPLE_RATE,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        const input = new Float32Array(480).fill(0.75);
        const output = resampler.push({
            channelData: [ input, input ],
            mediaTimeMicroseconds: requireMicroseconds(0)
        });
        // 50000 microseconds after the expected 10000 is 2400 silent frames
        output.push(...resampler.push({
            channelData: [ input, input ],
            mediaTimeMicroseconds: requireMicroseconds(60_000)
        }));

        expect(output.map(chunk => chunk.frameCount)).toEqual([ 480, 1_000, 1_000, 400, 480 ]);
        for (const silentChunk of output.slice(1, 4)) {
            for (const channel of silentChunk.channelData) {
                expect(channel.every(sample => sample === 0)).toBe(true);
            }
        }
        expect(output[4].mediaTimeMicroseconds).toBe(60_000);
        expectContiguousOutput(output);
    });

    it('continues a predecessor timeline across a source rate change', () => {
        const createResampler = (
            sourceSampleRate: number,
            continuation: StreamingAudioResamplerContinuation | null
        ): StreamingAudioResampler => new StreamingAudioResampler({
            channelCount: 1,
            continuation,
            maximumOutputFrameCount: 65_536,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        const predecessor = createResampler(24_000, null);
        const predecessorOutput = predecessor.push({
            channelData: [ createSine(24_000, 1_000, 2_400) ],
            mediaTimeMicroseconds: requireMicroseconds(1_000_000)
        });
        expect(() => predecessor.getContinuation()).toThrow(
            'Resampler continuation requires finalization'
        );
        predecessorOutput.push(...predecessor.finalize());
        const continuation = predecessor.getContinuation();

        expect(predecessorOutput.reduce((sum, chunk) => sum + chunk.frameCount, 0))
            .toBe(4_800);
        expect(continuation).toEqual({
            expectedInputMediaTimeMicroseconds: 1_100_000,
            outputMediaTimeMicroseconds: 1_100_000,
            previousInputMediaTimeMicroseconds: 1_000_000
        });

        const successor = createResampler(TARGET_SAMPLE_RATE, continuation);
        const successorOutput = successor.push({
            channelData: [ new Float32Array(480).fill(0.5) ],
            mediaTimeMicroseconds: requireMicroseconds(1_100_400)
        });
        expect(successorOutput[0].mediaTimeMicroseconds).toBe(1_100_000);
        expect(successor.getTelemetry().absorbedInputCount).toBe(1);

        const gapSuccessor = createResampler(TARGET_SAMPLE_RATE, continuation);
        const gapOutput = gapSuccessor.push({
            channelData: [ new Float32Array(480).fill(0.5) ],
            mediaTimeMicroseconds: requireMicroseconds(1_110_000)
        });
        expect(gapOutput.map(chunk => [ chunk.mediaTimeMicroseconds, chunk.frameCount ]))
            .toEqual([ [ 1_100_000, 480 ], [ 1_110_000, 480 ] ]);
        expect(gapSuccessor.getTelemetry().filledInputCount).toBe(1);
    });

    it('reports no continuation for a finalized resampler without a timeline', () => {
        const resampler = createPassthroughResampler(DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS);

        expect(resampler.finalize()).toEqual([]);
        expect(resampler.getContinuation()).toBeNull();
    });
});
