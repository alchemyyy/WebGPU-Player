import { MICROSECONDS_PER_SECOND, type Microseconds } from '../../MediaTime';
import {
    addMicroseconds,
    audioFramesToMicroseconds,
    requireMicroseconds
} from '../../TimeMath';
import { requireSupportedCustomAudioSampleRate } from '../CustomAudioSampleRate';
import { requirePositiveSafeInteger } from '../SafeIntegerValidation';

const FILTER_CUTOFF_HEADROOM = 0.94;
const FILTER_PHASE_COUNT = 2_048;
const FILTER_RADIUS = 32;
// The kernel was qualified for sources up to this rate.
// A faster source widens it in proportion, which keeps the band edge as sharp as it is for this rate
const FILTER_QUALIFIED_SOURCE_SAMPLE_RATE = 192_000;

/**
 * The largest gap filled with silence or overlap trimmed.
 * A larger discontinuity fails the input instead, because no correction keeps audio and video aligned.
 */
export const MAXIMUM_AUDIO_TIMELINE_CORRECTION_MICROSECONDS = 2_000_000;

/** The timeline state a resampler for a new source rate continues from */
export type StreamingAudioResamplerContinuation = Readonly<{
    expectedInputMediaTimeMicroseconds: Microseconds
    outputMediaTimeMicroseconds: Microseconds
    previousInputMediaTimeMicroseconds: Microseconds
}>;

/** One input timestamp the resampler corrected, or rejected beyond the correction bound */
export type StreamingAudioTimelineCorrection = Readonly<{
    /** Silence inserted when positive and source audio discarded when negative; the unapplied deviation for a rejection */
    correctionMicroseconds: number
    expectedMediaTimeMicroseconds: Microseconds
    inputMediaTimeMicroseconds: Microseconds
    kind: 'drop' | 'fill' | 'reject' | 'trim'
}>;

export type StreamingAudioTimelineCorrectionListener = (correction: StreamingAudioTimelineCorrection) => void;

export type StreamingAudioResamplerOptions = {
    channelCount: number
    /** Continues a predecessor's output timeline and input expectation */
    continuation?: StreamingAudioResamplerContinuation | null
    maximumOutputFrameCount: number
    /** Defaults to MAXIMUM_AUDIO_TIMELINE_CORRECTION_MICROSECONDS */
    maximumTimelineCorrectionMicroseconds?: number
    /**
     * The timestamp jitter absorbed without correction, before one source sample is added: container quantization plus any codec allowance.
     */
    maximumTimestampQuantizationMicroseconds: number
    minimumOutputFrameCount: number
    /** Observes every fill, trim, drop, and rejection, for diagnostics */
    onTimelineCorrection?: StreamingAudioTimelineCorrectionListener
    sourceSampleRate: number
    targetSampleRate: number
};

export type StreamingAudioResamplerInput = {
    channelData: readonly Float32Array[]
    mediaTimeMicroseconds: Microseconds
};

export type StreamingAudioResamplerOutput = {
    channelData: Float32Array[]
    durationMicroseconds: Microseconds
    frameCount: number
    mediaTimeMicroseconds: Microseconds
    sampleRate: number
};

export type StreamingAudioResamplerTelemetry = {
    /** Inputs accepted as contiguous despite jitter within tolerance or a non-advancing timestamp */
    absorbedInputCount: number
    bufferedSourceFrameCount: number
    /** Inputs discarded entirely because they overlapped audio already accepted */
    droppedInputCount: number
    /** Inputs preceded by inserted silence for a timeline gap */
    filledInputCount: number
    filterLatencySourceFrames: number
    finalized: boolean
    maximumInputTimestampDeviationMicroseconds: number
    outputFrameCount: number
    sourceFrameCount: number
    /** Inputs whose overlapping head was discarded */
    trimmedInputCount: number
};

type InputTimestampReconciliation = Readonly<{
    discardedFrameCount: number
    silenceFrameCount: number
}>;

const CONTIGUOUS_INPUT: InputTimestampReconciliation = Object.freeze({
    discardedFrameCount: 0,
    silenceFrameCount: 0
});

function requireNonNegativeSafeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`);
    }
    return value;
}

function sinc(value: number): number {
    if (Math.abs(value) < Number.EPSILON) {
        return 1;
    }
    const angle = Math.PI * value;
    return Math.sin(angle) / angle;
}

function blackmanWindow(normalizedDistance: number): number {
    if (Math.abs(normalizedDistance) >= 1) {
        return 0;
    }
    return 0.42
        + 0.5 * Math.cos(Math.PI * normalizedDistance)
        + 0.08 * Math.cos(2 * Math.PI * normalizedDistance);
}

/** Returns the kernel radius in source frames, widened for a source faster than the qualified rate. */
function getFilterRadius(sourceSampleRate: number): number {
    return Math.ceil(FILTER_RADIUS * Math.max(1, sourceSampleRate / FILTER_QUALIFIED_SOURCE_SAMPLE_RATE));
}

function createFilterTable(
    sourceSampleRate: number,
    targetSampleRate: number,
    filterRadius: number
): Float64Array {
    const cutoff = Math.min(1, targetSampleRate / sourceSampleRate) * FILTER_CUTOFF_HEADROOM;
    const filterTapCount = filterRadius * 2;
    const table = new Float64Array((FILTER_PHASE_COUNT + 1) * filterTapCount);
    for (let phaseIndex = 0; phaseIndex <= FILTER_PHASE_COUNT; phaseIndex += 1) {
        const fraction = phaseIndex / FILTER_PHASE_COUNT;
        const phaseOffset = phaseIndex * filterTapCount;
        let coefficientSum = 0;
        for (let tapIndex = 0; tapIndex < filterTapCount; tapIndex += 1) {
            const distance = tapIndex - filterRadius + 1 - fraction;
            const coefficient = cutoff * sinc(cutoff * distance) * blackmanWindow(distance / filterRadius);
            table[phaseOffset + tapIndex] = coefficient;
            coefficientSum += coefficient;
        }
        if (!Number.isFinite(coefficientSum) || Math.abs(coefficientSum) < Number.EPSILON) {
            throw new Error('Unable to construct the audio resampling filter');
        }
        for (let tapIndex = 0; tapIndex < filterTapCount; tapIndex += 1) {
            table[phaseOffset + tapIndex] /= coefficientSum;
        }
    }
    return table;
}

/**
 * Converts planar PCM with one bounded, windowed-sinc streaming stage.
 * Symmetric lookahead preserves media timestamps instead of adding A/V delay, while finalization edge-extends only the terminal filter tail.
 * Input timestamps are reconciled against the accepted timeline: jitter is absorbed, and gaps and overlaps up to the correction bound are filled with silence or trimmed, so the output timeline stays contiguous.
 * A larger discontinuity throws.
 */
export default class StreamingAudioResampler {
    public readonly channelCount: number;
    public readonly maximumOutputFrameCount: number;
    public readonly maximumTimelineCorrectionMicroseconds: number;
    public readonly maximumTimestampQuantizationMicroseconds: number;
    public readonly minimumOutputFrameCount: number;
    public readonly sourceSampleRate: number;
    public readonly targetSampleRate: number;

    private absorbedInputCount = 0;
    private bufferStartSourceFrame = 0;
    private readonly channelBuffers: Float32Array[] = [];
    private droppedInputCount = 0;
    private filledInputCount = 0;
    private readonly filterRadius: number;
    private readonly filterTable: Float64Array | null;
    private finalized = false;
    private readonly firstSourceValues: number[] = [];
    /** Anchors the input expectation in exact source frames, which a continuation carries over */
    private inputAnchorMediaTimeMicroseconds: Microseconds | null = null;
    private readonly lastSourceValues: number[] = [];
    private maximumInputTimestampDeviationMicroseconds = 0;
    private nextOutputFrame = 0;
    private readonly onTimelineCorrection: StreamingAudioTimelineCorrectionListener | null;
    /** Anchors output time in whole output frames, so output stays contiguous through every correction */
    private outputAnchorMediaTimeMicroseconds: Microseconds | null = null;
    private previousInputMediaTimeMicroseconds: Microseconds | null = null;
    private readonly timestampToleranceMicroseconds: number;
    private totalSourceFrames = 0;
    private trimmedInputCount = 0;

    public constructor(options: StreamingAudioResamplerOptions) {
        this.channelCount = requirePositiveSafeInteger(options.channelCount, 'Channel count');
        this.maximumOutputFrameCount = requirePositiveSafeInteger(
            options.maximumOutputFrameCount,
            'Maximum output frame count'
        );
        this.maximumTimelineCorrectionMicroseconds = requirePositiveSafeInteger(
            options.maximumTimelineCorrectionMicroseconds
                ?? MAXIMUM_AUDIO_TIMELINE_CORRECTION_MICROSECONDS,
            'Maximum timeline correction'
        );
        this.maximumTimestampQuantizationMicroseconds = requireNonNegativeSafeInteger(
            options.maximumTimestampQuantizationMicroseconds,
            'Maximum timestamp quantization'
        );
        this.minimumOutputFrameCount = requirePositiveSafeInteger(
            options.minimumOutputFrameCount,
            'Minimum output frame count'
        );
        if (this.minimumOutputFrameCount > this.maximumOutputFrameCount) {
            throw new RangeError('Minimum output frame count cannot exceed maximum output frame count');
        }
        this.sourceSampleRate = requireSupportedCustomAudioSampleRate(
            options.sourceSampleRate,
            'Source sample rate'
        );
        this.targetSampleRate = requireSupportedCustomAudioSampleRate(
            options.targetSampleRate,
            'Target sample rate'
        );
        this.timestampToleranceMicroseconds = this.maximumTimestampQuantizationMicroseconds
            + Math.ceil(MICROSECONDS_PER_SECOND / this.sourceSampleRate);
        this.onTimelineCorrection = options.onTimelineCorrection ?? null;

        const continuation = options.continuation ?? null;
        if (continuation) {
            this.inputAnchorMediaTimeMicroseconds = requireMicroseconds(
                continuation.expectedInputMediaTimeMicroseconds,
                'Resampler continuation input time'
            );
            this.outputAnchorMediaTimeMicroseconds = requireMicroseconds(
                continuation.outputMediaTimeMicroseconds,
                'Resampler continuation output time'
            );
            this.previousInputMediaTimeMicroseconds = requireMicroseconds(
                continuation.previousInputMediaTimeMicroseconds,
                'Resampler continuation previous input time'
            );
        }

        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
            this.channelBuffers.push(new Float32Array(0));
            this.firstSourceValues.push(0);
            this.lastSourceValues.push(0);
        }
        this.filterRadius = getFilterRadius(this.sourceSampleRate);
        this.filterTable = this.sourceSampleRate === this.targetSampleRate ?
            null :
            createFilterTable(this.sourceSampleRate, this.targetSampleRate, this.filterRadius);
    }

    /** Adds one source chunk and returns every newly available output chunk. */
    public push(input: StreamingAudioResamplerInput): StreamingAudioResamplerOutput[] {
        if (this.finalized) {
            throw new Error('Cannot add audio after resampler finalization');
        }
        const frameCount = this.validateInput(input);
        const reconciliation = this.reconcileInputTimestamp(input.mediaTimeMicroseconds, frameCount);

        const output: StreamingAudioResamplerOutput[] = [];
        if (reconciliation.silenceFrameCount > 0) {
            output.push(...this.appendSilence(reconciliation.silenceFrameCount));
        }
        const acceptedFrameCount = frameCount - reconciliation.discardedFrameCount;
        if (acceptedFrameCount <= 0) {
            return output;
        }
        const acceptedChannelData = reconciliation.discardedFrameCount === 0 ?
            input.channelData :
            input.channelData.map(channel => (
                channel.subarray(reconciliation.discardedFrameCount)
            ));
        output.push(...this.appendSource(acceptedChannelData, acceptedFrameCount));
        return output;
    }

    /** Flushes the symmetric filter tail exactly once. */
    public finalize(): StreamingAudioResamplerOutput[] {
        if (this.finalized) {
            return [];
        }
        this.finalized = true;
        if (this.totalSourceFrames === 0) {
            return [];
        }
        const output = this.filterTable === null ?
            this.renderPassthroughAvailable(true) :
            this.renderAvailable(true);
        for (let channelIndex = 0; channelIndex < this.channelBuffers.length; channelIndex += 1) {
            this.channelBuffers[channelIndex] = new Float32Array(0);
        }
        this.bufferStartSourceFrame = this.totalSourceFrames;
        return output;
    }

    /**
     * Returns where a successor resumes after finalization: the output end, the next expected input time, and the last raw input timestamp.
     * Null when no timeline was ever established.
     */
    public getContinuation(): StreamingAudioResamplerContinuation | null {
        if (!this.finalized) {
            throw new Error('Resampler continuation requires finalization');
        }
        const inputAnchorMediaTimeMicroseconds = this.inputAnchorMediaTimeMicroseconds;
        const outputAnchorMediaTimeMicroseconds = this.outputAnchorMediaTimeMicroseconds;
        const previousInputMediaTimeMicroseconds = this.previousInputMediaTimeMicroseconds;
        if (inputAnchorMediaTimeMicroseconds === null
            || outputAnchorMediaTimeMicroseconds === null
            || previousInputMediaTimeMicroseconds === null) {
            return null;
        }
        return {
            expectedInputMediaTimeMicroseconds: addMicroseconds(
                inputAnchorMediaTimeMicroseconds,
                audioFramesToMicroseconds(this.totalSourceFrames, this.sourceSampleRate)
            ),
            outputMediaTimeMicroseconds: addMicroseconds(
                outputAnchorMediaTimeMicroseconds,
                audioFramesToMicroseconds(this.nextOutputFrame, this.targetSampleRate)
            ),
            previousInputMediaTimeMicroseconds
        };
    }

    /** Returns bounded history and exact frame accounting for diagnostics. */
    public getTelemetry(): StreamingAudioResamplerTelemetry {
        return {
            absorbedInputCount: this.absorbedInputCount,
            bufferedSourceFrameCount: this.channelBuffers[0]?.length ?? 0,
            droppedInputCount: this.droppedInputCount,
            filledInputCount: this.filledInputCount,
            filterLatencySourceFrames: this.filterTable === null ? 0 : this.filterRadius,
            finalized: this.finalized,
            maximumInputTimestampDeviationMicroseconds: this.maximumInputTimestampDeviationMicroseconds,
            outputFrameCount: this.nextOutputFrame,
            sourceFrameCount: this.totalSourceFrames,
            trimmedInputCount: this.trimmedInputCount
        };
    }

    private validateInput(input: StreamingAudioResamplerInput): number {
        requireMicroseconds(input.mediaTimeMicroseconds, 'Resampler input media time');
        if (input.channelData.length !== this.channelCount) {
            throw new RangeError(`Expected ${this.channelCount} resampler input channels`);
        }
        const frameCount = input.channelData[0]?.length ?? 0;
        if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
            throw new RangeError('Resampler input must contain at least one frame');
        }
        for (const channel of input.channelData) {
            if (!(channel instanceof Float32Array) || channel.length !== frameCount) {
                throw new RangeError('Resampler input channels must be equal-length Float32Array values');
            }
        }
        return frameCount;
    }

    /**
     * Places one input on the accepted timeline by the first of these rules that applies:
     * - the first input anchors the timeline;
     * - jitter within tolerance is absorbed;
     * - a timestamp at or before the previous raw one is absorbed as non-advancing (Matroska lace frames without a block duration share one timestamp);
     * - a deviation beyond the correction bound throws;
     * - a gap is filled with silence;
     * - an overlap is trimmed, or dropped when the remainder is within tolerance.
     */
    private reconcileInputTimestamp(
        mediaTimeMicroseconds: Microseconds,
        frameCount: number
    ): InputTimestampReconciliation {
        const previousInputMediaTimeMicroseconds = this.previousInputMediaTimeMicroseconds;
        this.previousInputMediaTimeMicroseconds = mediaTimeMicroseconds;
        const inputAnchorMediaTimeMicroseconds = this.inputAnchorMediaTimeMicroseconds;
        if (inputAnchorMediaTimeMicroseconds === null) {
            this.inputAnchorMediaTimeMicroseconds = mediaTimeMicroseconds;
            this.outputAnchorMediaTimeMicroseconds ??= mediaTimeMicroseconds;
            return CONTIGUOUS_INPUT;
        }

        const expectedMediaTimeMicroseconds = addMicroseconds(
            inputAnchorMediaTimeMicroseconds,
            audioFramesToMicroseconds(this.totalSourceFrames, this.sourceSampleRate)
        );
        const timestampDeviationMicroseconds = mediaTimeMicroseconds - expectedMediaTimeMicroseconds;
        const absoluteDeviationMicroseconds = Math.abs(timestampDeviationMicroseconds);
        if (absoluteDeviationMicroseconds <= this.timestampToleranceMicroseconds) {
            if (absoluteDeviationMicroseconds > 0) {
                // The anchor and current container timestamps are independently quantized
                this.absorbedInputCount += 1;
                this.maximumInputTimestampDeviationMicroseconds = Math.max(
                    this.maximumInputTimestampDeviationMicroseconds,
                    absoluteDeviationMicroseconds
                );
            }
            return CONTIGUOUS_INPUT;
        }
        if (previousInputMediaTimeMicroseconds !== null
            && mediaTimeMicroseconds <= previousInputMediaTimeMicroseconds) {
            this.absorbedInputCount += 1;
            return CONTIGUOUS_INPUT;
        }
        if (absoluteDeviationMicroseconds > this.maximumTimelineCorrectionMicroseconds) {
            // Moving the timeline would leave audio permanently offset from video
            this.reportTimelineCorrection(
                'reject',
                mediaTimeMicroseconds,
                expectedMediaTimeMicroseconds,
                timestampDeviationMicroseconds
            );
            throw new RangeError(
                'Resampler input timestamps contain a gap or overlap beyond the correction bound: '
                + `expected ${expectedMediaTimeMicroseconds} microseconds, `
                + `received ${mediaTimeMicroseconds} microseconds, `
                + `deviation ${timestampDeviationMicroseconds} microseconds, `
                + `bound ${this.maximumTimelineCorrectionMicroseconds} microseconds, `
                + `after ${this.totalSourceFrames} source frames`
            );
        }

        const correctionFrameCount = Math.round(
            (absoluteDeviationMicroseconds * this.sourceSampleRate) / MICROSECONDS_PER_SECOND
        );
        if (timestampDeviationMicroseconds > 0) {
            this.filledInputCount += 1;
            this.reportTimelineCorrection(
                'fill',
                mediaTimeMicroseconds,
                expectedMediaTimeMicroseconds,
                audioFramesToMicroseconds(correctionFrameCount, this.sourceSampleRate)
            );
            return { discardedFrameCount: 0, silenceFrameCount: correctionFrameCount };
        }

        const remainingFrameCount = frameCount - correctionFrameCount;
        if (remainingFrameCount <= 0
            || audioFramesToMicroseconds(remainingFrameCount, this.sourceSampleRate)
                <= this.timestampToleranceMicroseconds) {
            this.droppedInputCount += 1;
            this.reportTimelineCorrection(
                'drop',
                mediaTimeMicroseconds,
                expectedMediaTimeMicroseconds,
                -audioFramesToMicroseconds(frameCount, this.sourceSampleRate)
            );
            return { discardedFrameCount: frameCount, silenceFrameCount: 0 };
        }
        this.trimmedInputCount += 1;
        this.reportTimelineCorrection(
            'trim',
            mediaTimeMicroseconds,
            expectedMediaTimeMicroseconds,
            -audioFramesToMicroseconds(correctionFrameCount, this.sourceSampleRate)
        );
        return { discardedFrameCount: correctionFrameCount, silenceFrameCount: 0 };
    }

    private reportTimelineCorrection(
        kind: StreamingAudioTimelineCorrection['kind'],
        inputMediaTimeMicroseconds: Microseconds,
        expectedMediaTimeMicroseconds: Microseconds,
        correctionMicroseconds: number
    ): void {
        this.onTimelineCorrection?.({
            correctionMicroseconds,
            expectedMediaTimeMicroseconds,
            inputMediaTimeMicroseconds,
            kind
        });
    }

    /** Inserts silence in bounded slices so buffered history never grows with the gap. */
    private appendSilence(frameCount: number): StreamingAudioResamplerOutput[] {
        const output: StreamingAudioResamplerOutput[] = [];
        let remainingFrameCount = frameCount;
        while (remainingFrameCount > 0) {
            const sliceFrameCount = Math.min(remainingFrameCount, this.maximumOutputFrameCount);
            const silence = new Float32Array(sliceFrameCount);
            const silentChannelData: Float32Array[] = [];
            for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
                silentChannelData.push(silence);
            }
            output.push(...this.appendSource(silentChannelData, sliceFrameCount));
            remainingFrameCount -= sliceFrameCount;
        }
        return output;
    }

    private appendSource(channelData: readonly Float32Array[], frameCount: number): StreamingAudioResamplerOutput[] {
        if (this.totalSourceFrames === 0) {
            for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
                this.firstSourceValues[channelIndex] = channelData[channelIndex][0];
            }
        }
        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
            this.lastSourceValues[channelIndex] = channelData[channelIndex][frameCount - 1];
        }

        this.appendInput(channelData, frameCount);
        this.totalSourceFrames += frameCount;
        if (this.filterTable === null) {
            return this.renderPassthroughAvailable(false);
        }
        return this.renderAvailable(false);
    }

    private appendInput(channelData: readonly Float32Array[], frameCount: number): void {
        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
            const previousBuffer = this.channelBuffers[channelIndex];
            const combinedBuffer = new Float32Array(previousBuffer.length + frameCount);
            combinedBuffer.set(previousBuffer);
            combinedBuffer.set(channelData[channelIndex], previousBuffer.length);
            this.channelBuffers[channelIndex] = combinedBuffer;
        }
    }

    private renderPassthroughAvailable(finalizing: boolean): StreamingAudioResamplerOutput[] {
        const availableFrameCount = this.totalSourceFrames - this.nextOutputFrame;
        const emittableFrameCount = this.getEmittableOutputFrameCount(
            availableFrameCount,
            finalizing
        );
        if (emittableFrameCount === 0) {
            return [];
        }

        const output: StreamingAudioResamplerOutput[] = [];
        let remainingFrameCount = emittableFrameCount;
        while (remainingFrameCount > 0) {
            const chunkFrameCount = Math.min(
                this.maximumOutputFrameCount,
                remainingFrameCount
            );
            const outputStartFrame = this.nextOutputFrame;
            const localFrameOffset = outputStartFrame - this.bufferStartSourceFrame;
            const chunkChannels: Float32Array[] = [];
            for (const channel of this.channelBuffers) {
                chunkChannels.push(channel.slice(
                    localFrameOffset,
                    localFrameOffset + chunkFrameCount
                ));
            }
            output.push(this.createOutput(
                chunkChannels,
                outputStartFrame,
                chunkFrameCount
            ));
            this.nextOutputFrame += chunkFrameCount;
            remainingFrameCount -= chunkFrameCount;
        }

        const consumedFrameCount = this.nextOutputFrame - this.bufferStartSourceFrame;
        if (consumedFrameCount > 0) {
            for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
                this.channelBuffers[channelIndex] = this.channelBuffers[channelIndex].slice(consumedFrameCount);
            }
            this.bufferStartSourceFrame = this.nextOutputFrame;
        }
        return output;
    }

    private renderAvailable(finalizing: boolean): StreamingAudioResamplerOutput[] {
        const availableOutputFrameCount = this.getAvailableOutputFrameCount(finalizing);
        const emittableOutputFrameCount = this.getEmittableOutputFrameCount(
            availableOutputFrameCount,
            finalizing
        );
        if (emittableOutputFrameCount === 0) {
            return [];
        }
        const output: StreamingAudioResamplerOutput[] = [];
        let remainingFrameCount = emittableOutputFrameCount;
        while (remainingFrameCount > 0) {
            const chunkFrameCount = Math.min(
                remainingFrameCount,
                this.maximumOutputFrameCount
            );
            const outputStartFrame = this.nextOutputFrame;
            const channelData: Float32Array[] = [];
            for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
                channelData.push(new Float32Array(chunkFrameCount));
            }
            for (let outputOffset = 0; outputOffset < chunkFrameCount; outputOffset += 1) {
                this.renderFrame(channelData, outputOffset, finalizing);
                this.nextOutputFrame += 1;
            }
            output.push(this.createOutput(channelData, outputStartFrame, chunkFrameCount));
            remainingFrameCount -= chunkFrameCount;
        }
        this.trimConsumedInput(finalizing);
        return output;
    }

    private getEmittableOutputFrameCount(availableFrameCount: number, finalizing: boolean): number {
        if (finalizing) {
            return availableFrameCount;
        }
        if (availableFrameCount < this.minimumOutputFrameCount) {
            return 0;
        }

        const trailingFrameCount = availableFrameCount % this.maximumOutputFrameCount;
        if (trailingFrameCount === 0
            || trailingFrameCount >= this.minimumOutputFrameCount
            || availableFrameCount <= this.maximumOutputFrameCount) {
            return availableFrameCount;
        }
        return availableFrameCount - trailingFrameCount;
    }

    private getAvailableOutputFrameCount(finalizing: boolean): number {
        const availableSourceFrameCount = finalizing ?
            this.totalSourceFrames :
            Math.max(0, this.totalSourceFrames - this.filterRadius);
        const exclusiveOutputFrame = Math.ceil((availableSourceFrameCount * this.targetSampleRate) / this.sourceSampleRate);
        return Math.max(0, exclusiveOutputFrame - this.nextOutputFrame);
    }

    private renderFrame(
        outputChannels: readonly Float32Array[],
        outputOffset: number,
        finalizing: boolean
    ): void {
        const filterTable = this.filterTable;
        if (!filterTable) {
            throw new Error('Resampling filter is unavailable');
        }
        const sourcePositionNumerator = this.nextOutputFrame * this.sourceSampleRate;
        const sourceFrame = Math.floor(sourcePositionNumerator / this.targetSampleRate);
        const fractionalNumerator = sourcePositionNumerator
            - sourceFrame * this.targetSampleRate;
        const phaseIndex = Math.round((fractionalNumerator * FILTER_PHASE_COUNT) / this.targetSampleRate);
        const filterTapCount = this.filterRadius * 2;
        const coefficientOffset = phaseIndex * filterTapCount;
        const firstFilterSourceFrame = sourceFrame - this.filterRadius + 1;

        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
            let value = 0;
            for (let tapIndex = 0; tapIndex < filterTapCount; tapIndex += 1) {
                const sourceFrameIndex = firstFilterSourceFrame + tapIndex;
                value += this.getSourceValue(channelIndex, sourceFrameIndex, finalizing)
                    * filterTable[coefficientOffset + tapIndex];
            }
            outputChannels[channelIndex][outputOffset] = value;
        }
    }

    private getSourceValue(
        channelIndex: number,
        sourceFrameIndex: number,
        finalizing: boolean
    ): number {
        if (sourceFrameIndex < 0) {
            return this.firstSourceValues[channelIndex];
        }
        if (sourceFrameIndex >= this.totalSourceFrames) {
            if (!finalizing) {
                throw new RangeError('Resampler attempted to read unavailable lookahead');
            }
            return this.lastSourceValues[channelIndex];
        }
        const localFrameIndex = sourceFrameIndex - this.bufferStartSourceFrame;
        const channelBuffer = this.channelBuffers[channelIndex];
        if (localFrameIndex < 0 || localFrameIndex >= channelBuffer.length) {
            throw new RangeError('Resampler history accounting is inconsistent');
        }
        return channelBuffer[localFrameIndex];
    }

    private createOutput(
        channelData: Float32Array[],
        outputStartFrame: number,
        frameCount: number
    ): StreamingAudioResamplerOutput {
        const outputAnchorMediaTimeMicroseconds = this.outputAnchorMediaTimeMicroseconds;
        if (outputAnchorMediaTimeMicroseconds === null) {
            throw new Error('Resampler output has no media-time anchor');
        }
        return {
            channelData,
            durationMicroseconds: audioFramesToMicroseconds(
                frameCount,
                this.targetSampleRate
            ),
            frameCount,
            mediaTimeMicroseconds: addMicroseconds(
                outputAnchorMediaTimeMicroseconds,
                audioFramesToMicroseconds(outputStartFrame, this.targetSampleRate)
            ),
            sampleRate: this.targetSampleRate
        };
    }

    private trimConsumedInput(finalizing: boolean): void {
        if (finalizing) {
            return;
        }
        const nextSourceFrame = Math.floor((this.nextOutputFrame * this.sourceSampleRate) / this.targetSampleRate);
        const firstRequiredSourceFrame = Math.max(
            0,
            nextSourceFrame - this.filterRadius + 1
        );
        const trimFrameCount = firstRequiredSourceFrame - this.bufferStartSourceFrame;
        if (trimFrameCount <= 0) {
            return;
        }
        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
            this.channelBuffers[channelIndex] = this.channelBuffers[channelIndex].slice(trimFrameCount);
        }
        this.bufferStartSourceFrame = firstRequiredSourceFrame;
    }
}
