export const CUSTOM_AUDIO_WORKLET_PROCESSOR_NAME = 'jellyfin-custom-audio-output-v1';

// This self-contained module is loaded through AudioWorklet.addModule().
// It receives PCM in transferable ArrayBuffers, so it needs no shared memory.
// PCM arrives from a producer's own channel, or from the page on the node's port; control and telemetry stay on the node's port
const CUSTOM_AUDIO_WORKLET_SOURCE = `'use strict';

const MICROSECONDS_PER_SECOND = 1000000;

class JellyfinCustomAudioOutputProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const processorOptions = options.processorOptions || {};
        this.channelCount = processorOptions.channelCount;
        this.maxBufferedFrames = processorOptions.maxBufferedFrames;
        this.maxChunks = processorOptions.maxChunks;
        this.telemetryIntervalFrames = processorOptions.telemetryIntervalFrames;
        this.chunks = new Array(this.maxChunks);
        this.headChunkIndex = 0;
        this.tailChunkIndex = 0;
        this.chunkCount = 0;
        this.queuedFrames = 0;
        this.generation = 1;
        this.playing = false;
        this.volume = 1;
        this.muted = false;
        this.destroyed = false;
        this.consumedFrames = 0;
        this.outputFrames = 0;
        this.droppedFrames = 0;
        this.overflowEvents = 0;
        this.overflowFrames = 0;
        this.staleChunks = 0;
        this.underflowEvents = 0;
        this.underflowFrames = 0;
        this.framesSinceTelemetry = 0;
        this.analyzedFrameCount = 0;
        this.analyzedSampleCount = 0;
        this.clippedSampleCount = 0;
        this.nonFiniteSampleCount = 0;
        this.samplePeak = 0;
        this.sampleSquareSum = 0;
        this.mediaTimeContextTimeMicroseconds = null;
        this.mediaTimeMicroseconds = 0;
        this.underflowActive = false;
        // Silence from a flush position to the first chunk keeps the clock on audio time
        this.leadingGapPending = false;
        this.leadingGapFrames = 0;
        this.leadingGapRenderedFrames = 0;
        this.leadingGapStartMicroseconds = 0;
        // The current producer's end of its channel; a flush detaches it
        this.producerPort = null;
        this.port.onmessage = messageEvent => this.handleMessage(messageEvent.data);
    }

    handleMessage(message) {
        if (!message || typeof message.type !== 'string') {
            return;
        }

        switch (message.type) {
            case 'attach-producer':
                this.attachProducer(message.port, message.generation);
                break;
            case 'deactivate':
                this.deactivate(message.leaseId, message.generation);
                break;
            case 'enqueue':
                this.enqueue(message, null);
                break;
            case 'flush':
                this.flush(message.generation, message.mediaTimeMicroseconds);
                break;
            case 'gain':
                this.setGain(message.volume, message.muted);
                break;
            case 'playback':
                this.playing = message.playing === true;
                break;
            case 'destroy':
                this.detachProducer();
                this.clearQueue();
                this.destroyed = true;
                break;
            default:
                break;
        }
    }

    // Adopts a producer's channel for the generation the preceding flush started.
    // An attachment that a later flush overtook is closed, so the producer it belongs to is stale
    attachProducer(port, generation) {
        this.detachProducer();
        if (!port || typeof port.postMessage !== 'function') {
            return;
        }
        if (this.destroyed || generation !== this.generation) {
            port.close();
            return;
        }
        this.producerPort = port;
        port.onmessage = messageEvent => this.handleProducerMessage(port, messageEvent.data);
    }

    // Closes the producer's channel; chunks still in flight on it are discarded with it
    detachProducer() {
        const producerPort = this.producerPort;
        if (!producerPort) {
            return;
        }
        this.producerPort = null;
        producerPort.onmessage = null;
        producerPort.close();
    }

    handleProducerMessage(port, message) {
        if (port !== this.producerPort || this.destroyed || !message || message.type !== 'enqueue') {
            return;
        }
        this.enqueue(message, port);
    }

    deactivate(leaseId, generation) {
        if (!Number.isSafeInteger(leaseId) || leaseId <= 0
            || !Number.isSafeInteger(generation) || generation <= this.generation) {
            return;
        }

        this.playing = false;
        this.detachProducer();
        this.clearQueue();
        this.generation = generation;
        this.volume = 1;
        this.muted = false;
        this.consumedFrames = 0;
        this.outputFrames = 0;
        this.droppedFrames = 0;
        this.overflowEvents = 0;
        this.overflowFrames = 0;
        this.staleChunks = 0;
        this.underflowEvents = 0;
        this.underflowFrames = 0;
        this.framesSinceTelemetry = 0;
        this.resetSignalTelemetry();
        this.mediaTimeContextTimeMicroseconds = null;
        this.mediaTimeMicroseconds = 0;
        this.underflowActive = false;
        this.leadingGapPending = false;
        this.leadingGapFrames = 0;
        this.leadingGapRenderedFrames = 0;
        this.leadingGapStartMicroseconds = 0;
        this.port.postMessage({leaseId, type: 'deactivated'});
    }

    // Queues one chunk from the page, or from the producer whose port is given, and releases a rejected one at once
    enqueue(message, producerPort) {
        if (message.generation !== this.generation) {
            const staleFrameCount = this.getFrameCount(message.channelData);
            this.staleChunks += 1;
            this.droppedFrames += staleFrameCount;
            this.releaseChannelData(message.channelData, producerPort, message.sequence, 'stale-generation');
            this.postTelemetry('stale-generation', message.sequence);
            return;
        }

        const frameCount = this.getFrameCount(message.channelData);
        if (frameCount <= 0 || message.channelData.length !== this.channelCount) {
            this.droppedFrames += Math.max(0, frameCount);
            this.releaseChannelData(message.channelData, producerPort, message.sequence, 'invalid');
            this.postTelemetry('overflow', message.sequence);
            return;
        }

        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
            const channel = message.channelData[channelIndex];
            if (!(channel instanceof Float32Array) || channel.length !== frameCount) {
                this.droppedFrames += frameCount;
                this.releaseChannelData(message.channelData, producerPort, message.sequence, 'invalid');
                this.postTelemetry('overflow', message.sequence);
                return;
            }
        }

        if (this.chunkCount === this.maxChunks || frameCount > this.maxBufferedFrames - this.queuedFrames) {
            this.droppedFrames += frameCount;
            this.overflowFrames += frameCount;
            this.overflowEvents += 1;
            this.releaseChannelData(message.channelData, producerPort, message.sequence, 'overflow');
            this.postTelemetry('overflow', message.sequence);
            return;
        }

        if (this.leadingGapPending) {
            // Only the first accepted chunk after a flush defines the gap, since later chunks continue it
            this.leadingGapPending = false;
            const leadingGapFrames = Math.round(
                ((message.timestampMicroseconds - this.leadingGapStartMicroseconds) * sampleRate)
                    / MICROSECONDS_PER_SECOND
            );
            // A chunk at or before the flush position plays at once
            this.leadingGapFrames = leadingGapFrames > 0 ? leadingGapFrames : 0;
        }

        this.chunks[this.tailChunkIndex] = {
            channelData: message.channelData,
            frameOffset: 0,
            producerPort,
            sequence: message.sequence,
            timestampMicroseconds: message.timestampMicroseconds
        };
        this.tailChunkIndex = (this.tailChunkIndex + 1) % this.maxChunks;
        this.chunkCount += 1;
        this.queuedFrames += frameCount;
        this.postTelemetry('enqueue', message.sequence);
    }

    getFrameCount(channelData) {
        if (!Array.isArray(channelData) || channelData.length === 0) {
            return 0;
        }
        const firstChannel = channelData[0];
        return firstChannel instanceof Float32Array ? firstChannel.length : 0;
    }

    setGain(volume, muted) {
        if (Number.isFinite(volume) && volume >= 0) {
            this.volume = volume;
        }
        this.muted = muted === true;
    }

    flush(generation, mediaTimeMicroseconds) {
        // The producer's chunks belong to the generation the flush ends
        this.detachProducer();
        this.clearQueue();
        this.generation = generation;
        this.resetSignalTelemetry();
        this.mediaTimeContextTimeMicroseconds = null;
        this.mediaTimeMicroseconds = mediaTimeMicroseconds;
        this.underflowActive = false;
        this.leadingGapPending = true;
        this.leadingGapFrames = 0;
        this.leadingGapRenderedFrames = 0;
        this.leadingGapStartMicroseconds = mediaTimeMicroseconds;
        this.postTelemetry('flush', null);
    }

    clearQueue() {
        while (this.chunkCount > 0) {
            const chunk = this.chunks[this.headChunkIndex];
            this.chunks[this.headChunkIndex] = undefined;
            this.headChunkIndex = (this.headChunkIndex + 1) % this.maxChunks;
            this.chunkCount -= 1;
            // Every queue clear follows a detach, so a producer's chunk is dropped and only a page chunk returns
            this.releaseChannelData(chunk.channelData, chunk.producerPort, chunk.sequence, 'consumed');
        }
        this.headChunkIndex = 0;
        this.tailChunkIndex = 0;
        this.queuedFrames = 0;
    }

    process(inputs, outputs) {
        if (this.destroyed) {
            // Match Chromium's processor-GC handshake ordering
            this.port.postMessage({type: 'retired'});
            this.port.close();
            return false;
        }

        const outputChannels = outputs[0];
        if (!outputChannels || outputChannels.length === 0) {
            return true;
        }

        const renderFrameCount = outputChannels[0].length;
        for (let channelIndex = 0; channelIndex < outputChannels.length; channelIndex += 1) {
            outputChannels[channelIndex].fill(0);
        }

        if (!this.playing) {
            return true;
        }

        const silentPrefixFrameCount = this.renderLeadingGap(renderFrameCount);
        let outputOffset = silentPrefixFrameCount;
        const gain = this.muted ? 0 : this.volume;
        while (outputOffset < renderFrameCount && this.chunkCount > 0) {
            const chunk = this.chunks[this.headChunkIndex];
            const chunkFrameCount = chunk.channelData[0].length;
            const availableFrames = chunkFrameCount - chunk.frameOffset;
            const copiedFrames = Math.min(availableFrames, renderFrameCount - outputOffset);
            const outputChannelCount = Math.min(outputChannels.length, this.channelCount);
            for (let channelIndex = 0; channelIndex < outputChannelCount; channelIndex += 1) {
                const sourceChannel = chunk.channelData[channelIndex];
                const outputChannel = outputChannels[channelIndex];
                if (gain === 1) {
                    outputChannel.set(
                        sourceChannel.subarray(chunk.frameOffset, chunk.frameOffset + copiedFrames),
                        outputOffset
                    );
                } else if (gain !== 0) {
                    for (let frameIndex = 0; frameIndex < copiedFrames; frameIndex += 1) {
                        outputChannel[outputOffset + frameIndex] = sourceChannel[chunk.frameOffset + frameIndex] * gain;
                    }
                }
            }

            chunk.frameOffset += copiedFrames;
            outputOffset += copiedFrames;
            this.queuedFrames -= copiedFrames;
            this.consumedFrames += copiedFrames;
            this.mediaTimeMicroseconds = chunk.timestampMicroseconds
                + Math.round((chunk.frameOffset * MICROSECONDS_PER_SECOND) / sampleRate);
            this.mediaTimeContextTimeMicroseconds = this.framesToMicroseconds(currentFrame + outputOffset);

            if (chunk.frameOffset === chunkFrameCount) {
                this.chunks[this.headChunkIndex] = undefined;
                this.headChunkIndex = (this.headChunkIndex + 1) % this.maxChunks;
                this.chunkCount -= 1;
                this.releaseChannelData(chunk.channelData, chunk.producerPort, chunk.sequence, 'consumed');
            }
        }

        const underflowFrameCount = renderFrameCount - outputOffset;
        this.analyzeOutput(outputChannels, silentPrefixFrameCount, outputOffset);
        if (underflowFrameCount > 0) {
            this.underflowFrames += underflowFrameCount;
            if (!this.underflowActive) {
                this.underflowActive = true;
                this.underflowEvents += 1;
                this.postTelemetry('underflow', null);
            }
        } else if (this.underflowActive) {
            this.underflowActive = false;
            this.postTelemetry('underflow-recovered', null);
        }

        this.outputFrames += renderFrameCount;
        this.framesSinceTelemetry += renderFrameCount;
        if (this.framesSinceTelemetry >= this.telemetryIntervalFrames) {
            this.framesSinceTelemetry %= this.telemetryIntervalFrames;
            this.postTelemetry('periodic', null);
        }
        return true;
    }

    // Advances the leading gap over the zero-filled output and returns its frame count.
    // Gap frames are rendered output, so they are neither underflow nor consumed PCM
    renderLeadingGap(renderFrameCount) {
        if (this.leadingGapFrames <= 0 || this.chunkCount === 0) {
            return 0;
        }

        const silentFrameCount = Math.min(this.leadingGapFrames, renderFrameCount);
        this.leadingGapFrames -= silentFrameCount;
        this.leadingGapRenderedFrames += silentFrameCount;
        this.mediaTimeMicroseconds = this.leadingGapStartMicroseconds + this.framesToMicroseconds(this.leadingGapRenderedFrames);
        this.mediaTimeContextTimeMicroseconds = this.framesToMicroseconds(currentFrame + silentFrameCount);
        return silentFrameCount;
    }

    analyzeOutput(outputChannels, startFrameIndex, endFrameIndex) {
        if (endFrameIndex <= startFrameIndex) {
            return;
        }
        this.analyzedFrameCount += endFrameIndex - startFrameIndex;
        for (const outputChannel of outputChannels) {
            for (let frameIndex = startFrameIndex; frameIndex < endFrameIndex; frameIndex += 1) {
                const sample = outputChannel[frameIndex];
                if (!Number.isFinite(sample)) {
                    this.nonFiniteSampleCount += 1;
                    continue;
                }
                const absoluteSample = Math.abs(sample);
                this.analyzedSampleCount += 1;
                this.samplePeak = Math.max(this.samplePeak, absoluteSample);
                this.sampleSquareSum += sample * sample;
                if (absoluteSample > 1) {
                    this.clippedSampleCount += 1;
                }
            }
        }
    }

    resetSignalTelemetry() {
        this.analyzedFrameCount = 0;
        this.analyzedSampleCount = 0;
        this.clippedSampleCount = 0;
        this.nonFiniteSampleCount = 0;
        this.samplePeak = 0;
        this.sampleSquareSum = 0;
    }

    framesToMicroseconds(frameCount) {
        const wholeSeconds = Math.floor(frameCount / sampleRate);
        const remainingFrames = frameCount - wholeSeconds * sampleRate;
        return wholeSeconds * MICROSECONDS_PER_SECOND
            + Math.round((remainingFrames * MICROSECONDS_PER_SECOND) / sampleRate);
    }

    // Returns a chunk's buffers to the realm that sent it, out of the persistent worklet realm.
    // A producer's chunk goes back to its producer, which reuses the buffers and takes back the chunk's credit; a page chunk goes to the page to be reclaimed
    releaseChannelData(channelData, producerPort, sequence, reason) {
        const channelBuffers = [];
        if (Array.isArray(channelData)) {
            for (const channel of channelData) {
                if (channel instanceof Float32Array
                    && channel.buffer instanceof ArrayBuffer
                    && !channelBuffers.includes(channel.buffer)) {
                    channelBuffers.push(channel.buffer);
                }
            }
        }
        if (producerPort) {
            // A detached producer's chunks are dropped with it
            if (producerPort !== this.producerPort) {
                return;
            }
            try {
                producerPort.postMessage({channelBuffers, reason, sequence, type: 'released'}, channelBuffers);
            } catch {
                // Audio output must continue if the producer's channel fails
            }
            return;
        }
        if (channelBuffers.length === 0) {
            return;
        }
        try {
            this.port.postMessage({channelBuffers, type: 'recycle'}, channelBuffers);
        } catch {
            // Audio output must continue if the diagnostic recycling path fails
        }
    }

    postTelemetry(reason, sequence) {
        this.port.postMessage({
            consumedFrames: this.consumedFrames,
            droppedFrames: this.droppedFrames,
            generation: this.generation,
            hasPhysicalOutputTimeCorrelation: false,
            mediaTimeContextTimeMicroseconds: this.mediaTimeContextTimeMicroseconds,
            mediaTimeMicroseconds: this.mediaTimeMicroseconds,
            muted: this.muted,
            outputFrames: this.outputFrames,
            overflowEvents: this.overflowEvents,
            overflowFrames: this.overflowFrames,
            playing: this.playing,
            queuedFrames: this.queuedFrames,
            reason,
            sequence,
            signal: {
                analyzedFrameCount: this.analyzedFrameCount,
                analyzedSampleCount: this.analyzedSampleCount,
                clippedSampleCount: this.clippedSampleCount,
                nonFiniteSampleCount: this.nonFiniteSampleCount,
                samplePeak: this.samplePeak,
                sampleSquareSum: this.sampleSquareSum
            },
            staleChunks: this.staleChunks,
            type: 'telemetry',
            underflowEvents: this.underflowEvents,
            underflowFrames: this.underflowFrames,
            volume: this.volume
        });
    }
}

registerProcessor('${CUSTOM_AUDIO_WORKLET_PROCESSOR_NAME}', JellyfinCustomAudioOutputProcessor);
`;

/** Creates an object URL for the self-contained transferable-PCM worklet. */
export function createCustomAudioWorkletModuleURL(): string {
    const sourceBlob = new Blob([ CUSTOM_AUDIO_WORKLET_SOURCE ], { type: 'text/javascript' });
    return URL.createObjectURL(sourceBlob);
}

/** Returns the processor source so tests can evaluate it outside an AudioWorklet. */
export function getCustomAudioWorkletSource(): string {
    return CUSTOM_AUDIO_WORKLET_SOURCE;
}
