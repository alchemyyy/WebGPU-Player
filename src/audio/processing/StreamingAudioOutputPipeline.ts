import StreamingAudioLookaheadLimiter from './StreamingAudioLookaheadLimiter';
import StreamingAudioResampler, {
    type StreamingAudioResamplerInput,
    type StreamingAudioResamplerOptions,
    type StreamingAudioResamplerOutput,
    type StreamingAudioResamplerTelemetry
} from './StreamingAudioResampler';
import { requireSupportedCustomAudioSampleRate } from '../CustomAudioSampleRate';

export type StreamingAudioOutputPipelineOptions = StreamingAudioResamplerOptions & Readonly<{
    peakLimiterEnabled: boolean
}>;

export type StreamingAudioOutputPipelineTelemetry = Readonly<{
    peakLimiterEnabled: boolean
    resampler: StreamingAudioResamplerTelemetry
    sourceSampleRateChangeCount: number
}>;

/**
 * Runs resampling before the optional final-rate linked peak limiter.
 * The source rate can change mid-stream and the limiter can be enabled late, while the output format and the output timeline stay fixed.
 * Given an output stage module, both stages render in WebAssembly, with the same bytes as their JavaScript references.
 */
export default class StreamingAudioOutputPipeline {
    private finalized = false;
    private limiter: StreamingAudioLookaheadLimiter | null = null;
    private readonly options: StreamingAudioOutputPipelineOptions;
    private resampler: StreamingAudioResampler;
    private sourceSampleRateChangeCount = 0;

    public constructor(options: StreamingAudioOutputPipelineOptions) {
        this.options = { ...options, continuation: null };
        this.resampler = new StreamingAudioResampler(options);
        if (options.peakLimiterEnabled) {
            this.limiter = this.createLimiter();
        }
    }

    /** Resamples one decoded PCM input and passes the result through the limiter when one is enabled. */
    public push(input: StreamingAudioResamplerInput): StreamingAudioResamplerOutput[] {
        if (this.finalized) {
            throw new Error('Cannot add audio after output pipeline finalization');
        }
        const resampledOutputs = this.resampler.push(input);
        return this.limiter ? this.limit(this.limiter, resampledOutputs) : resampledOutputs;
    }

    /**
     * Rebinds to a new decoded source rate.
     * The old resampler's tail goes through the limiter, which keeps running, and the new resampler continues the old output timeline.
     * Returns the tail, which precedes any later output.
     */
    public changeSourceSampleRate(sourceSampleRate: number): StreamingAudioResamplerOutput[] {
        if (this.finalized) {
            throw new Error('Cannot change the source rate after output pipeline finalization');
        }
        requireSupportedCustomAudioSampleRate(sourceSampleRate, 'Source sample rate');
        if (sourceSampleRate === this.resampler.sourceSampleRate) {
            return [];
        }

        const resampledTail = this.resampler.finalize();
        const continuation = this.resampler.getContinuation();
        this.resampler = new StreamingAudioResampler({
            ...this.options,
            continuation,
            sourceSampleRate
        });
        this.sourceSampleRateChangeCount += 1;
        return this.limiter ? this.limit(this.limiter, resampledTail) : resampledTail;
    }

    /** Routes all later output through a limiter, which anchors at its first input. */
    public enablePeakLimiter(): void {
        if (this.finalized || this.limiter) {
            return;
        }
        this.limiter = this.createLimiter();
    }

    /** Drains the resampler and limiter tails in dependency order exactly once. */
    public finalize(): StreamingAudioResamplerOutput[] {
        if (this.finalized) {
            return [];
        }
        this.finalized = true;
        const resampledOutputs = this.resampler.finalize();
        if (!this.limiter) {
            return resampledOutputs;
        }
        const output = this.limit(this.limiter, resampledOutputs);
        output.push(...this.limiter.finalize());
        return output;
    }

    /** Ends the pipeline without draining its tails and frees any kernel memory, for an attempt that stops early. */
    public close(): void {
        this.finalized = true;
        this.resampler.close();
        this.limiter?.close();
    }

    /** Returns pipeline configuration and resampler accounting for diagnostics. */
    public getTelemetry(): StreamingAudioOutputPipelineTelemetry {
        return {
            peakLimiterEnabled: this.limiter !== null,
            resampler: this.resampler.getTelemetry(),
            sourceSampleRateChangeCount: this.sourceSampleRateChangeCount
        };
    }

    /** Passes resampled chunks through the limiter, which copies them, so their buffers go back to the pool. */
    private limit(limiter: StreamingAudioLookaheadLimiter, resampledOutputs: StreamingAudioResamplerOutput[]): StreamingAudioResamplerOutput[] {
        const limitedOutputs = limiter.push(resampledOutputs);
        const channelPool = this.options.channelPool;
        if (channelPool) {
            for (const resampledOutput of resampledOutputs) {
                channelPool.giveChannels(resampledOutput.channelData);
            }
        }
        return limitedOutputs;
    }

    private createLimiter(): StreamingAudioLookaheadLimiter {
        return new StreamingAudioLookaheadLimiter({
            channelCount: this.options.channelCount,
            channelPool: this.options.channelPool,
            maximumOutputFrameCount: this.options.maximumOutputFrameCount,
            minimumOutputFrameCount: this.options.minimumOutputFrameCount,
            outputStageModule: this.options.outputStageModule,
            sampleRate: this.options.targetSampleRate
        });
    }
}

export type {
    StreamingAudioResamplerInput,
    StreamingAudioResamplerOutput
};
