import { MAXIMUM_AUDIBLE_CUSTOM_PLAYBACK_RATE } from '../../pipeline/CustomPlaybackRate';

// WSOLA time-stretching for the custom audio worklet, modeled on Chromium's AudioRendererAlgorithm.
// It is source text for the self-contained worklet module, which defines it ahead of the processor that drives it.
export const CUSTOM_AUDIO_WORKLET_TIME_STRETCH_SOURCE = `
const STRETCH_WINDOW_SECONDS = 0.02;
const STRETCH_SEARCH_SECONDS = 0.03;
// Candidates within this many frames of the last optimal block are skipped, which keeps a slowed signal from buzzing on one block; Chromium's
// interval is 160 frames wide
const STRETCH_EXCLUDED_FRAMES = 80;
const STRETCH_SEARCH_DECIMATION = 4;
const STRETCH_SIMILARITY_EPSILON = 1e-12;
// The input buffer spans one iteration's input at rates up to this one; a faster iteration lets the natural continuation go
const STRETCH_MAXIMUM_SPANNED_RATE = ${MAXIMUM_AUDIBLE_CUSTOM_PLAYBACK_RATE};

// Time-stretches planar PCM with WSOLA, keeping its pitch.
// Each iteration overlap-adds the input block most similar to the natural continuation of the output, from candidates around the nominal input position, so one hop of output covers the rate times a hop of input.
// The processor is its source: source.queuedFrames counts the ring's frames, and source.takeRingFrames(frameCount, copy) hands up to that many of them to appendInput, or skips them, and returns how many it took.
// Every buffer is allocated here, since a processor's channel count is fixed, so rendering allocates nothing.
// Input indices count from the oldest input frame held; nominalFrame is the input position of the next output frame at the rate its block was made at.
class WsolaTimeStretcher {
    constructor(channelCount, sampleRate, source) {
        this.channelCount = channelCount;
        this.source = source;
        const windowFrames = Math.round(sampleRate * STRETCH_WINDOW_SECONDS);
        // An even window splits into two equal hops
        this.windowFrames = windowFrames + (windowFrames & 1);
        this.hopFrames = this.windowFrames / 2;
        this.candidateCount = Math.round(sampleRate * STRETCH_SEARCH_SECONDS);
        this.halfCandidateCount = Math.floor(this.candidateCount / 2);
        this.coarseWindowFrames = Math.floor(this.windowFrames / STRETCH_SEARCH_DECIMATION);
        // One iteration spans the search block and, at rates away from 1, the hops between it and the natural continuation, give or take a frame of rounding
        this.inputCapacity = this.candidateCount + this.windowFrames - 1
            + Math.ceil((STRETCH_MAXIMUM_SPANNED_RATE - 1) * this.hopFrames) + 1;
        // The rising halves of periodic Hann windows: the overlap-add's over one hop, and the transition's over the whole block
        this.overlapWindow = new Float32Array(this.hopFrames);
        for (let frameIndex = 0; frameIndex < this.hopFrames; frameIndex += 1) {
            this.overlapWindow[frameIndex] = 0.5 * (1 - Math.cos((Math.PI * frameIndex) / this.hopFrames));
        }
        this.transitionWindow = new Float32Array(this.windowFrames);
        for (let frameIndex = 0; frameIndex < this.windowFrames; frameIndex += 1) {
            this.transitionWindow[frameIndex] = 0.5 * (1 - Math.cos((Math.PI * frameIndex) / this.windowFrames));
        }
        this.input = [];
        // The completed hop, then the pending second half of the last block, which the next overlap-add fades out
        this.output = [];
        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
            this.input.push(new Float32Array(this.inputCapacity));
            this.output.push(new Float32Array(this.windowFrames));
        }
        // The search measures similarity on the channels' sum, kept per input frame
        this.inputMono = new Float32Array(this.inputCapacity);
        this.coarseTarget = new Float32Array(this.coarseWindowFrames);
        this.coarseSearch = new Float32Array(
            Math.ceil(this.candidateCount / STRETCH_SEARCH_DECIMATION) + this.coarseWindowFrames - 1
        );
        this.reset();
    }

    reset() {
        this.inputFrames = 0;
        // The natural continuation: the input that follows the output already made
        this.targetIndex = 0;
        this.nominalFrame = 0;
        // What the next overlap-add fades out: nothing, the input from the target, or the stored half block
        this.overlap = 'none';
        this.outputReadIndex = 0;
        this.outputEndIndex = 0;
        // The rate the completed output was made at
        this.blockRate = 1;
        // The rate the latest rendered frame advanced media time at
        this.renderedRate = 1;
    }

    // Holds input or output that has not played
    get active() {
        return this.overlap !== 'none' || this.outputReadIndex < this.outputEndIndex || this.targetIndex < this.inputFrames;
    }

    // Input frames that have not played: those from the natural continuation on, and the completed output's share
    get queuedFrames() {
        return this.inputFrames - this.targetIndex + Math.ceil((this.outputEndIndex - this.outputReadIndex) * this.blockRate);
    }

    appendInput(channelData, frameOffset, frameCount) {
        const firstFrameIndex = this.inputFrames;
        const mono = this.inputMono;
        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
            const sourceChannel = channelData[channelIndex];
            const inputChannel = this.input[channelIndex];
            for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
                const sample = sourceChannel[frameOffset + frameIndex];
                inputChannel[firstFrameIndex + frameIndex] = sample;
                mono[firstFrameIndex + frameIndex] = channelIndex === 0 ? sample : mono[firstFrameIndex + frameIndex] + sample;
            }
        }
        this.inputFrames += frameCount;
    }

    // Renders into the output from outputOffset and returns where it stopped: the end, or where no input is left
    render(outputChannels, outputOffset, renderFrameCount, gain, rate) {
        let offset = outputOffset;
        // An iteration that lacks input is not retried within the quantum, so what is buffered plays raw
        let iterationFailed = false;
        while (offset < renderFrameCount) {
            if (this.outputReadIndex < this.outputEndIndex) {
                offset = this.renderOutput(outputChannels, offset, renderFrameCount, gain);
            } else if (this.overlap !== 'none') {
                if (rate !== 1 && !iterationFailed) {
                    if (this.runIteration(rate)) {
                        continue;
                    }
                    iterationFailed = true;
                }
                this.finishOverlap();
            } else if (rate !== 1 && !iterationFailed && this.source.queuedFrames > 0) {
                this.begin();
            } else if (this.targetIndex < this.inputFrames || (rate !== 1 && this.takeRemainingInput() > 0)) {
                offset = this.renderInput(outputChannels, offset, renderFrameCount, gain);
            } else {
                break;
            }
        }
        return offset;
    }

    renderOutput(outputChannels, outputOffset, renderFrameCount, gain) {
        const frameCount = Math.min(this.outputEndIndex - this.outputReadIndex, renderFrameCount - outputOffset);
        if (gain !== 0) {
            const outputChannelCount = Math.min(outputChannels.length, this.channelCount);
            for (let channelIndex = 0; channelIndex < outputChannelCount; channelIndex += 1) {
                const stretchedChannel = this.output[channelIndex];
                const outputChannel = outputChannels[channelIndex];
                for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
                    outputChannel[outputOffset + frameIndex] = stretchedChannel[this.outputReadIndex + frameIndex] * gain;
                }
            }
        }
        this.outputReadIndex += frameCount;
        this.nominalFrame += frameCount * this.blockRate;
        this.renderedRate = this.blockRate;
        return outputOffset + frameCount;
    }

    // Plays input raw from the natural continuation
    renderInput(outputChannels, outputOffset, renderFrameCount, gain) {
        const frameCount = Math.min(this.inputFrames - this.targetIndex, renderFrameCount - outputOffset);
        if (gain !== 0) {
            const outputChannelCount = Math.min(outputChannels.length, this.channelCount);
            for (let channelIndex = 0; channelIndex < outputChannelCount; channelIndex += 1) {
                const inputChannel = this.input[channelIndex];
                const outputChannel = outputChannels[channelIndex];
                for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
                    outputChannel[outputOffset + frameIndex] = inputChannel[this.targetIndex + frameIndex] * gain;
                }
            }
        }
        this.targetIndex += frameCount;
        this.nominalFrame += frameCount;
        this.renderedRate = 1;
        return outputOffset + frameCount;
    }

    // Starts a 1 to r transition at the natural continuation: the first overlap-add continues the input, so it reproduces it instead of fading in
    begin() {
        this.dropInput(this.targetIndex);
        this.overlap = 'input';
    }

    // Ends stretching at the natural continuation, which then plays raw.
    // The last overlap-add crossfades the stored half block into it, and media time moves to its input position
    finishOverlap() {
        if (this.overlap === 'block') {
            const hopFrames = this.hopFrames;
            const frameCount = Math.min(hopFrames, this.inputFrames - this.targetIndex);
            for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
                const inputChannel = this.input[channelIndex];
                const stretchedChannel = this.output[channelIndex];
                for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
                    const pendingSample = stretchedChannel[hopFrames + frameIndex];
                    stretchedChannel[frameIndex] = pendingSample
                        + (inputChannel[this.targetIndex + frameIndex] - pendingSample) * this.overlapWindow[frameIndex];
                }
            }
            this.outputReadIndex = 0;
            this.outputEndIndex = frameCount;
            this.nominalFrame = this.targetIndex;
            this.targetIndex += frameCount;
            this.blockRate = 1;
        }
        this.overlap = 'none';
    }

    // With no iteration to run, the ring's last input plays raw too
    takeRemainingInput() {
        this.dropInput(this.targetIndex);
        return this.source.takeRingFrames(this.inputCapacity, true);
    }

    // Reads ring input until the stretcher holds frameCount frames, and reports whether it does
    readInput(frameCount) {
        if (this.inputFrames < frameCount) {
            this.source.takeRingFrames(frameCount - this.inputFrames, true);
        }
        return this.inputFrames >= frameCount;
    }

    // Drops the input before an index; a drop past the input held skips the ring frames up to it
    dropInput(frameCount) {
        if (frameCount <= 0) {
            return;
        }
        const keptFrameCount = this.inputFrames - frameCount;
        if (keptFrameCount > 0) {
            for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
                this.input[channelIndex].copyWithin(0, frameCount, this.inputFrames);
            }
            this.inputMono.copyWithin(0, frameCount, this.inputFrames);
            this.inputFrames = keptFrameCount;
        } else {
            if (keptFrameCount < 0) {
                this.source.takeRingFrames(-keptFrameCount, false);
            }
            this.inputFrames = 0;
        }
        this.targetIndex -= frameCount;
        this.nominalFrame -= frameCount;
    }

    // Overlap-adds one block and completes one hop of output, or reports that the ring lacks the input it needs
    runIteration(rate) {
        const hopFrames = this.hopFrames;
        const windowFrames = this.windowFrames;
        if (this.overlap === 'input') {
            if (!this.readInput(this.targetIndex + hopFrames)) {
                return false;
            }
            for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
                const inputChannel = this.input[channelIndex];
                const stretchedChannel = this.output[channelIndex];
                for (let frameIndex = 0; frameIndex < hopFrames; frameIndex += 1) {
                    stretchedChannel[hopFrames + frameIndex] = inputChannel[this.targetIndex + frameIndex];
                }
            }
            this.overlap = 'block';
        }

        // The candidates' centres lie within half the search interval of the nominal input position of the output frame at a block's centre
        const firstCandidateIndex = Math.round(this.nominalFrame + (rate - 1) * hopFrames) - this.halfCandidateCount;
        let searchStart = Math.max(0, firstCandidateIndex);
        let searchEnd = firstCandidateIndex + this.candidateCount;
        let targetIndex = this.targetIndex;
        let lastOptimalIndex = targetIndex - hopFrames;
        if (searchEnd - 1 + windowFrames - Math.min(targetIndex, searchStart) > this.inputCapacity) {
            // Past the spanned rates the search outruns the natural continuation, so the first candidate continues the output instead
            targetIndex = searchStart;
        }
        const firstUsedIndex = Math.min(targetIndex, searchStart);
        const inputEnd = Math.max(targetIndex + windowFrames, searchEnd - 1 + windowFrames);
        if (inputEnd - this.inputFrames > this.source.queuedFrames) {
            return false;
        }

        this.dropInput(firstUsedIndex);
        targetIndex -= firstUsedIndex;
        lastOptimalIndex -= firstUsedIndex;
        searchStart -= firstUsedIndex;
        searchEnd -= firstUsedIndex;
        this.readInput(inputEnd - firstUsedIndex);

        // A target among the candidates is the optimal block; otherwise the transition blends from the target into the best candidate
        const optimalIndex = targetIndex >= searchStart && targetIndex < searchEnd ?
            targetIndex :
            this.findOptimalIndex(searchStart, searchEnd, targetIndex, lastOptimalIndex);
        const overlapWindow = this.overlapWindow;
        const transitionWindow = this.transitionWindow;
        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
            const inputChannel = this.input[channelIndex];
            const stretchedChannel = this.output[channelIndex];
            for (let frameIndex = 0; frameIndex < hopFrames; frameIndex += 1) {
                const targetSample = inputChannel[targetIndex + frameIndex];
                const blockSample = targetSample
                    + (inputChannel[optimalIndex + frameIndex] - targetSample) * transitionWindow[frameIndex];
                const pendingSample = stretchedChannel[hopFrames + frameIndex];
                stretchedChannel[frameIndex] = pendingSample + (blockSample - pendingSample) * overlapWindow[frameIndex];
            }
            for (let frameIndex = hopFrames; frameIndex < windowFrames; frameIndex += 1) {
                const targetSample = inputChannel[targetIndex + frameIndex];
                stretchedChannel[frameIndex] = targetSample
                    + (inputChannel[optimalIndex + frameIndex] - targetSample) * transitionWindow[frameIndex];
            }
        }
        this.targetIndex = optimalIndex + hopFrames;
        this.outputReadIndex = 0;
        this.outputEndIndex = hopFrames;
        this.blockRate = rate;
        return true;
    }

    // Returns the candidate in [searchStart, searchEnd) most similar to the target block by normalized cross-correlation of the mono sum.
    // A coarse pass compares every fourth candidate on the sum decimated by four, then a full-rate pass refines around the best one
    findOptimalIndex(searchStart, searchEnd, targetIndex, lastOptimalIndex) {
        const mono = this.inputMono;
        const coarseTarget = this.coarseTarget;
        const coarseSearch = this.coarseSearch;
        const coarseWindowFrames = this.coarseWindowFrames;
        const excludedStart = lastOptimalIndex - STRETCH_EXCLUDED_FRAMES;
        const excludedEnd = lastOptimalIndex + STRETCH_EXCLUDED_FRAMES;

        let targetEnergy = 0;
        for (let coarseIndex = 0; coarseIndex < coarseWindowFrames; coarseIndex += 1) {
            const frameIndex = targetIndex + coarseIndex * STRETCH_SEARCH_DECIMATION;
            let sample = 0;
            for (let offset = 0; offset < STRETCH_SEARCH_DECIMATION; offset += 1) {
                sample += mono[frameIndex + offset];
            }
            coarseTarget[coarseIndex] = sample;
            targetEnergy += sample * sample;
        }
        const coarseCandidateCount = Math.ceil((searchEnd - searchStart) / STRETCH_SEARCH_DECIMATION);
        const coarseSampleCount = coarseCandidateCount + coarseWindowFrames - 1;
        for (let coarseIndex = 0; coarseIndex < coarseSampleCount; coarseIndex += 1) {
            const frameIndex = searchStart + coarseIndex * STRETCH_SEARCH_DECIMATION;
            let sample = 0;
            for (let offset = 0; offset < STRETCH_SEARCH_DECIMATION; offset += 1) {
                sample += mono[frameIndex + offset];
            }
            coarseSearch[coarseIndex] = sample;
        }

        let candidateEnergy = 0;
        for (let coarseIndex = 0; coarseIndex < coarseWindowFrames; coarseIndex += 1) {
            candidateEnergy += coarseSearch[coarseIndex] * coarseSearch[coarseIndex];
        }
        let coarseOptimalIndex = searchStart;
        let bestSimilarity = -Infinity;
        for (let candidate = 0; candidate < coarseCandidateCount; candidate += 1) {
            if (candidate > 0) {
                const leavingSample = coarseSearch[candidate - 1];
                const enteringSample = coarseSearch[candidate + coarseWindowFrames - 1];
                candidateEnergy += enteringSample * enteringSample - leavingSample * leavingSample;
            }
            const candidateIndex = searchStart + candidate * STRETCH_SEARCH_DECIMATION;
            if (candidateIndex >= excludedStart && candidateIndex <= excludedEnd) {
                continue;
            }
            let product = 0;
            for (let coarseIndex = 0; coarseIndex < coarseWindowFrames; coarseIndex += 1) {
                product += coarseTarget[coarseIndex] * coarseSearch[candidate + coarseIndex];
            }
            const similarity = product / Math.sqrt(Math.max(0, targetEnergy * candidateEnergy) + STRETCH_SIMILARITY_EPSILON);
            if (similarity > bestSimilarity) {
                bestSimilarity = similarity;
                coarseOptimalIndex = candidateIndex;
            }
        }

        const windowFrames = this.windowFrames;
        const fineStart = Math.max(searchStart, coarseOptimalIndex - STRETCH_SEARCH_DECIMATION);
        const fineEnd = Math.min(searchEnd - 1, coarseOptimalIndex + STRETCH_SEARCH_DECIMATION);
        targetEnergy = 0;
        candidateEnergy = 0;
        for (let frameIndex = 0; frameIndex < windowFrames; frameIndex += 1) {
            targetEnergy += mono[targetIndex + frameIndex] * mono[targetIndex + frameIndex];
            candidateEnergy += mono[fineStart + frameIndex] * mono[fineStart + frameIndex];
        }
        let optimalIndex = coarseOptimalIndex;
        bestSimilarity = -Infinity;
        for (let candidateIndex = fineStart; candidateIndex <= fineEnd; candidateIndex += 1) {
            if (candidateIndex > fineStart) {
                const leavingSample = mono[candidateIndex - 1];
                const enteringSample = mono[candidateIndex + windowFrames - 1];
                candidateEnergy += enteringSample * enteringSample - leavingSample * leavingSample;
            }
            if (candidateIndex >= excludedStart && candidateIndex <= excludedEnd) {
                continue;
            }
            let product = 0;
            for (let frameIndex = 0; frameIndex < windowFrames; frameIndex += 1) {
                product += mono[targetIndex + frameIndex] * mono[candidateIndex + frameIndex];
            }
            const similarity = product / Math.sqrt(Math.max(0, targetEnergy * candidateEnergy) + STRETCH_SIMILARITY_EPSILON);
            if (similarity > bestSimilarity) {
                bestSimilarity = similarity;
                optimalIndex = candidateIndex;
            }
        }
        return optimalIndex;
    }
}
`;
