import {
    getCustomAudioChannelLayout,
    requiresCustomAudioFoldDown,
    type CustomAudioChannelLayout,
    type CustomAudioOutputChannelCount
} from './CustomAudioChannelLayout';
import StreamingAudioOutputPipeline, {
    type StreamingAudioOutputPipelineTelemetry,
    type StreamingAudioResamplerOutput
} from './StreamingAudioOutputPipeline';
import type StreamingAudioDownmixSettings from './StreamingAudioDownmixSettings';
import type { StreamingAudioTimelineCorrectionListener } from './StreamingAudioResampler';
import type AudioOutputStageModule from './AudioOutputStageModule';
import type PCMChannelPool from './PCMChannelPool';
import {
    CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE,
    isSupportedCustomAudioInputLayout
} from '../CustomAudioOutputPolicy';
import { isSupportedCustomAudioSampleRate } from '../CustomAudioSampleRate';

/** The format one decoded output reports */
export type DecodedAudioFormat = Readonly<{
    channelCount: number
    /** The decoder's speaker layout, or null to derive it from the channel count */
    layout: CustomAudioChannelLayout | null
    sampleRate: number
}>;

/** The decoded channel count and rate an output stage is bound to */
export type DecodedAudioSourceFormat = Readonly<{
    channelCount: number
    sampleRate: number
}>;

export type DecodedAudioOutputStageOptions = Readonly<{
    /** Lends the WebAssembly stage's output channels their buffers, which the worklet returns once it played them */
    channelPool?: PCMChannelPool | null
    maximumOutputFrameCount: number
    minimumOutputFrameCount: number
    /** Observes the first binding and every later change of the bound format */
    onSourceFormat?: (sourceFormat: DecodedAudioSourceFormat) => void
    onTimelineCorrection?: StreamingAudioTimelineCorrectionListener
    outputChannelCount: CustomAudioOutputChannelCount
    /** Renders the resampler and limiter in WebAssembly; without it, the JavaScript references render the same bytes */
    outputStageModule?: AudioOutputStageModule | null
    /** The codec name the decoded PCM route tables qualify */
    routeCodec: string
    timestampToleranceMicroseconds: number
}>;

export type BoundDecodedAudioInput = Readonly<{
    layout: CustomAudioChannelLayout
    /** The tail a source rate change flushed, which precedes the new input's output */
    outputs: StreamingAudioResamplerOutput[]
    pipeline: StreamingAudioOutputPipeline
}>;

/** Rejects a decoded format outside the qualified decoded PCM routes. */
export class UnsupportedDecodedAudioFormatError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'UnsupportedDecodedAudioFormatError';
    }
}

/**
 * Binds one audio attempt's output stage to the format its decoder produces, which is authoritative over the declared one: HE-AAC declares its core rate, and Mediabunny can under-declare E-AC-3 7.1.
 * The pipeline is created at the first decoded rate, and a later rate change rebinds the resampler while the output format and timeline stay fixed.
 * A layout that folds down to the output turns the peak limiter on.
 */
export default class DecodedAudioOutputStage {
    private boundSourceFormat: DecodedAudioSourceFormat | null = null;
    private readonly options: DecodedAudioOutputStageOptions;
    private pipeline: StreamingAudioOutputPipeline | null = null;

    public constructor(options: DecodedAudioOutputStageOptions) {
        this.options = options;
    }

    /** The decoded format the stage is bound to, or null before the first output */
    public get sourceFormat(): DecodedAudioSourceFormat | null {
        return this.boundSourceFormat;
    }

    /** Validates one decoded output's format and returns the stage that consumes it. */
    public bind(
        decodedAudioFormat: DecodedAudioFormat,
        streamingDownmixSettings: StreamingAudioDownmixSettings | null
    ): BoundDecodedAudioInput {
        const { channelCount, sampleRate } = decodedAudioFormat;
        if (!isSupportedCustomAudioSampleRate(sampleRate)) {
            throw new UnsupportedDecodedAudioFormatError(`The decoded audio sample rate ${sampleRate} Hz is invalid`);
        }
        const layout = decodedAudioFormat.layout ?? getCustomAudioChannelLayout(channelCount);
        if (!layout || layout.channels.length !== channelCount) {
            throw new UnsupportedDecodedAudioFormatError(`The decoded ${channelCount}-channel audio layout is unsupported`);
        }
        const routeCodec = this.options.routeCodec;
        if (!isSupportedCustomAudioInputLayout(routeCodec, channelCount, sampleRate)) {
            throw new UnsupportedDecodedAudioFormatError(
                `Decoded ${routeCodec} audio at ${channelCount} channels and ${sampleRate} Hz `
                + 'does not match a qualified decoded PCM route'
            );
        }

        let outputs: StreamingAudioResamplerOutput[] = [];
        let pipeline = this.pipeline;
        if (!pipeline) {
            pipeline = this.createPipeline(sampleRate);
            this.pipeline = pipeline;
        } else if (sampleRate !== this.boundSourceFormat?.sampleRate) {
            outputs = pipeline.changeSourceSampleRate(sampleRate);
        }
        // A fold-down can exceed full scale; the limiter also guards a later live gain boost
        if (requiresCustomAudioFoldDown(layout, this.options.outputChannelCount)) {
            pipeline.enablePeakLimiter();
        }
        streamingDownmixSettings?.setSampleRate(sampleRate);
        if (this.boundSourceFormat?.channelCount !== channelCount || this.boundSourceFormat.sampleRate !== sampleRate) {
            const sourceFormat: DecodedAudioSourceFormat = { channelCount, sampleRate };
            this.boundSourceFormat = sourceFormat;
            this.options.onSourceFormat?.(sourceFormat);
        }
        return { layout, outputs, pipeline };
    }

    /** Drains the pipeline tails, or nothing when no decoded output was ever bound. */
    public finalize(): StreamingAudioResamplerOutput[] {
        return this.pipeline?.finalize() ?? [];
    }

    /**
     * Ends the stage without draining its tails and frees its WebAssembly kernels' memory.
     * An attempt calls it however it ends; after finalize it does nothing.
     */
    public close(): void {
        this.pipeline?.close();
    }

    /** Returns the bound pipeline's accounting, or null before the first output. */
    public getTelemetry(): StreamingAudioOutputPipelineTelemetry | null {
        return this.pipeline?.getTelemetry() ?? null;
    }

    private createPipeline(sourceSampleRate: number): StreamingAudioOutputPipeline {
        return new StreamingAudioOutputPipeline({
            channelCount: this.options.outputChannelCount,
            channelPool: this.options.channelPool,
            maximumOutputFrameCount: this.options.maximumOutputFrameCount,
            maximumTimestampQuantizationMicroseconds: this.options.timestampToleranceMicroseconds,
            minimumOutputFrameCount: this.options.minimumOutputFrameCount,
            onTimelineCorrection: this.options.onTimelineCorrection,
            outputStageModule: this.options.outputStageModule,
            // Off until a decoded layout folds down
            peakLimiterEnabled: false,
            sourceSampleRate,
            targetSampleRate: CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE
        });
    }
}
