// The audio decode worker's runtime: each decoded PCM attempt's decoder, output stage, and worklet producer, fed by the decode worker's batches
// It runs on the worker's global scope, or on one end of a channel in tests, and keeps one attempt open at a time

import { MICROSECONDS_PER_SECOND, type Microseconds } from '../MediaTime';
import { getAudioSampleWindow } from '../audio/AudioSampleWindow';
import {
    CUSTOM_AUDIO_OUTPUT_BUFFERED_SECONDS,
    CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE
} from '../audio/CustomAudioOutputPolicy';
import { getAudioTimestampToleranceMicroseconds } from '../audio/CustomAudioTrackMetadata';
import DTSSeekRecovery from '../audio/decoders/DTSSeekRecovery';
import DTSSoftwareAudioDecoder, { type DTSDecodedAudioOutput } from '../audio/decoders/DTSSoftwareAudioDecoder';
import EAC3SoftwareAudioDecoder from '../audio/decoders/EAC3SoftwareAudioDecoder';
import TrueHDSoftwareAudioDecoder from '../audio/decoders/TrueHDSoftwareAudioDecoder';
import WorkletPCMProducer, { WorkletPCMProducerError } from '../audio/output/WorkletPCMProducer';
import {
    loadPlaybackAudioOutputStageModule,
    type default as AudioOutputStageModule
} from '../audio/processing/AudioOutputStageModule';
import {
    CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT,
    prepareCustomAudioOutputChannelData,
    type CustomAudioChannelLayout
} from '../audio/processing/CustomAudioChannelLayout';
import DecodedAudioOutputStage, {
    UnsupportedDecodedAudioFormatError,
    type BoundDecodedAudioInput
} from '../audio/processing/DecodedAudioOutputStage';
import PCMChannelPool from '../audio/processing/PCMChannelPool';
import StreamingAudioDownmixSettings from '../audio/processing/StreamingAudioDownmixSettings';
import type { StreamingAudioResamplerOutput } from '../audio/processing/StreamingAudioOutputPipeline';
import type { StreamingAudioTimelineCorrection } from '../audio/processing/StreamingAudioResampler';
import {
    AUDIO_DECODE_WORKER_INPUT_CREDITS,
    isAudioDecodeWorkerRequest,
    MAXIMUM_AUDIO_DECODE_WORKER_FAILURE_MESSAGE_LENGTH,
    type AudioDecodeWorkerAttachOutputRequest,
    type AudioDecodeWorkerAttemptKey,
    type AudioDecodeWorkerCloseAttemptRequest,
    type AudioDecodeWorkerFinishAttemptRequest,
    type AudioDecodeWorkerInputBatch,
    type AudioDecodeWorkerInputRequest,
    type AudioDecodeWorkerOpenAttemptRequest,
    type AudioDecodeWorkerPacketBatch,
    type AudioDecodeWorkerPCMBatch,
    type AudioDecodeWorkerPCMSample,
    type AudioDecodeWorkerResponse,
    type AudioDecodeWorkerUpdateDownmixSettingsRequest
} from './AudioDecodeWorkerProtocol';
import {
    MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE,
    MAX_DECODED_AUDIO_SAMPLE_CREDITS,
    type CustomDecodeFailureKind,
    type DecodeWorkerAudioOutputAttachment
} from './DecodeWorkerProtocol';

// Codec floors of the decoded audio timestamp tolerance; DTS lace phases wander further
const DEFAULT_AUDIO_TIMESTAMP_QUANTIZATION_MICROSECONDS = 1_000;
const DTS_AUDIO_TIMESTAMP_QUANTIZATION_MICROSECONDS = 3_000;
const TRUEHD_ACCESS_UNITS_PER_SECOND = 1_200;
// One TrueHD or MLP access unit can decode to no PCM
const TRUEHD_ACCESS_UNIT_ALLOWANCE_MICROSECONDS = Math.ceil(MICROSECONDS_PER_SECOND / TRUEHD_ACCESS_UNITS_PER_SECOND);
const NO_ACCESS_UNIT_ALLOWANCE_MICROSECONDS = 0;
const MINIMUM_AUDIO_OUTPUT_CHUNK_DURATION_MICROSECONDS = 40_000;
const MINIMUM_AUDIO_OUTPUT_CHUNK_FRAME_COUNT = Math.ceil(
    CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE
        * MINIMUM_AUDIO_OUTPUT_CHUNK_DURATION_MICROSECONDS
        / MICROSECONDS_PER_SECOND
);
// Every credit holding a largest chunk at most fills the worklet ring, so filled silence never overflows it
const MAXIMUM_AUDIO_OUTPUT_CHUNK_FRAME_COUNT = requireAudioOutputChunkFrameBound(Math.floor(
    CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE
        * CUSTOM_AUDIO_OUTPUT_BUFFERED_SECONDS
        / MAX_DECODED_AUDIO_SAMPLE_CREDITS
));
// Every chunk in flight to the worklet, at the widest output layout, returns its channel buffers
const MAXIMUM_SPARE_AUDIO_OUTPUT_CHANNEL_BUFFERS = MAX_DECODED_AUDIO_SAMPLE_CREDITS * CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT;
const STEREO_OUTPUT_CHANNEL_COUNT = 2;
const MISSING_AUDIO_OUTPUT_MESSAGE = 'Decoded audio has no channel to the worklet';
const INVALID_AUDIO_OUTPUT_MESSAGE = 'The channel to the worklet is invalid';
const INPUT_CREDIT_MESSAGE = 'Decoded audio input exceeded its credits';
const INPUT_AFTER_FINISH_MESSAGE = 'Decoded audio input arrived after its last batch';
const INPUT_KIND_MESSAGE = 'Decoded audio input does not match the attempt decoder';
const INVALID_REQUEST_MESSAGE = 'The audio decode worker received an invalid request';
const DEFAULT_FAILURE_MESSAGE = 'Decoded audio failed';
// Smaller fills and trims are routine container jitter and stay out of the console
const LOGGED_AUDIO_TIMELINE_CORRECTION_MICROSECONDS = 100_000;

/** Where the runtime listens and answers: the worker's global scope, or a channel's end */
export type AudioDecodeWorkerScope = {
    addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
    postMessage(message: AudioDecodeWorkerResponse, transfer: Transferable[]): void
};

/** The fields the output stage reads from any bundled decoder's output */
type BundledDecodedAudioOutput = Pick<
    DTSDecodedAudioOutput,
    'channelData' | 'channelLayout' | 'frameCount' | 'mediaTimeMicroseconds' | 'sampleRate'
>;

type BundledAudioDecoder =
    | {
        backend: 'dts'
        decoder: DTSSoftwareAudioDecoder
        seekRecovery: DTSSeekRecovery
    }
    | {
        backend: 'eac3'
        decoder: EAC3SoftwareAudioDecoder
    }
    | {
        backend: 'truehd'
        decoder: TrueHDSoftwareAudioDecoder
    };

type AudioDecodeAttempt = {
    readonly audioEpoch: number
    /** Set once the attempt closed; its run unwinds at its next wait */
    cancelled: boolean
    /** Settles once the attempt's run released its decoder and output stage; it never rejects */
    completion: Promise<void>
    /** Set once the decode worker sent the attempt's last batch */
    finishRequested: boolean
    readonly generation: number
    readonly inputBatches: AudioDecodeWorkerInputBatch[]
    /** Batches received and not yet credited back */
    outstandingInputCount: number
    readonly options: AudioDecodeWorkerOpenAttemptRequest
    /** The producer's credit window: the chunks it may still post to the worklet */
    outputCredits: number
    /** The worklet channel the next output credit wait opens the producer on */
    pendingAudioOutput: DecodeWorkerAudioOutputAttachment | null
    producer: WorkletPCMProducer | null
    /** A broken input contract, which the attempt's next wait throws */
    protocolFailure: string | null
    streamingDownmixSettings: StreamingAudioDownmixSettings | null
    readonly wakeWaiters: Array<() => void>
};

/** Checks the largest decoded audio chunk against the minimum chunk and the protocol frame limit. */
function requireAudioOutputChunkFrameBound(frameCount: number): number {
    if (!Number.isSafeInteger(frameCount)
        || frameCount < MINIMUM_AUDIO_OUTPUT_CHUNK_FRAME_COUNT
        || frameCount > MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE) {
        throw new RangeError(
            'The largest decoded audio chunk must hold at least the minimum chunk '
            + 'and at most the protocol frame limit'
        );
    }
    return frameCount;
}

/** Logs a large timeline correction or a rejection so field logs show where audio moved. */
function logAudioTimelineCorrection(correction: StreamingAudioTimelineCorrection): void {
    if (correction.kind !== 'reject'
        && Math.abs(correction.correctionMicroseconds) <= LOGGED_AUDIO_TIMELINE_CORRECTION_MICROSECONDS) {
        return;
    }
    let description: string;
    switch (correction.kind) {
        case 'drop':
            description = 'Decoded audio input dropped as an overlap';
            break;
        case 'fill':
            description = 'Decoded audio timeline gap filled with silence';
            break;
        case 'reject':
            description = 'Decoded audio timeline discontinuity exceeded the correction bound';
            break;
        case 'trim':
            description = 'Decoded audio timeline overlap trimmed';
            break;
    }
    console.warn(
        `${description}: input ${correction.inputMediaTimeMicroseconds} microseconds, `
        + `expected ${correction.expectedMediaTimeMicroseconds} microseconds, `
        + `correction ${correction.correctionMicroseconds} microseconds`
    );
}

/** Maps a failure to the kind the page acts on: an unqualified decoded format, a broken worklet channel, or a decode failure. */
function classifyAudioDecodeFailure(error: unknown): CustomDecodeFailureKind {
    if (error instanceof UnsupportedDecodedAudioFormatError) {
        return 'source-unsupported';
    }
    if (error instanceof WorkletPCMProducerError) {
        return 'audio-output-failed';
    }
    return 'decode-failed';
}

/** Returns a failure's message; the decode worker redacts it before the page sees it. */
function getFailureMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : DEFAULT_FAILURE_MESSAGE;
    return message.slice(0, MAXIMUM_AUDIO_DECODE_WORKER_FAILURE_MESSAGE_LENGTH);
}

/** Returns the timestamp tolerance an attempt's codec and container timestamps need. */
function getTimestampToleranceMicroseconds(options: AudioDecodeWorkerOpenAttemptRequest): number {
    switch (options.decoderBackend) {
        case 'dts':
            return getAudioTimestampToleranceMicroseconds(
                options.timeResolution,
                DTS_AUDIO_TIMESTAMP_QUANTIZATION_MICROSECONDS,
                NO_ACCESS_UNIT_ALLOWANCE_MICROSECONDS
            );
        case 'mlp':
        case 'truehd':
            return getAudioTimestampToleranceMicroseconds(
                options.timeResolution,
                DEFAULT_AUDIO_TIMESTAMP_QUANTIZATION_MICROSECONDS,
                TRUEHD_ACCESS_UNIT_ALLOWANCE_MICROSECONDS
            );
        case 'eac3':
        case 'pcm':
            return getAudioTimestampToleranceMicroseconds(
                options.timeResolution,
                DEFAULT_AUDIO_TIMESTAMP_QUANTIZATION_MICROSECONDS,
                NO_ACCESS_UNIT_ALLOWANCE_MICROSECONDS
            );
    }
}

/** Creates the attempt's bundled decoder, loading its kit on first use, or returns null for samples Mediabunny decoded. */
async function createBundledAudioDecoder(options: AudioDecodeWorkerOpenAttemptRequest): Promise<BundledAudioDecoder | null> {
    switch (options.decoderBackend) {
        case 'dts': {
            // The recovery checks the start first, so an invalid start fails before the kit loads
            const seekRecovery = new DTSSeekRecovery(options.startTimeMicroseconds);
            return { backend: 'dts', decoder: await DTSSoftwareAudioDecoder.create(), seekRecovery };
        }
        case 'eac3':
            return { backend: 'eac3', decoder: await EAC3SoftwareAudioDecoder.create() };
        case 'mlp':
        case 'truehd':
            return { backend: 'truehd', decoder: await TrueHDSoftwareAudioDecoder.create(options.decoderBackend) };
        case 'pcm':
            return null;
    }
}

/** Downmixes or maps one input to the attempt's output layout, with the live gains of a stereo attempt. */
function prepareOutputChannelData(
    attempt: AudioDecodeAttempt,
    inputChannelData: readonly Float32Array[],
    inputChannelLayout: CustomAudioChannelLayout
): readonly Float32Array[] {
    const options = attempt.options;
    const streamingDownmixSettings = attempt.streamingDownmixSettings;
    if (!streamingDownmixSettings) {
        return prepareCustomAudioOutputChannelData(
            inputChannelData,
            inputChannelLayout,
            options.outputChannelCount,
            options.audioDownmixAlgorithm,
            options.audioDownmixSettings
        );
    }

    const settingsBlock = streamingDownmixSettings.takeBlock(inputChannelData[0]?.length ?? 0);
    return prepareCustomAudioOutputChannelData(
        inputChannelData,
        inputChannelLayout,
        options.outputChannelCount,
        options.audioDownmixAlgorithm,
        settingsBlock.settings,
        settingsBlock.ramp
    );
}

function wakeWaiters(waiters: Array<() => void>): void {
    for (const waiter of waiters.splice(0)) {
        waiter();
    }
}

function waitForChange(attempt: AudioDecodeAttempt): Promise<void> {
    return new Promise<void>(resolve => {
        attempt.wakeWaiters.push(resolve);
    });
}

function matchesAttempt(attempt: AudioDecodeAttempt | null, key: AudioDecodeWorkerAttemptKey): attempt is AudioDecodeAttempt {
    return attempt !== null && attempt.generation === key.generation && attempt.audioEpoch === key.audioEpoch;
}

function getAttemptKey(attempt: AudioDecodeAttempt): AudioDecodeWorkerAttemptKey {
    return { audioEpoch: attempt.audioEpoch, generation: attempt.generation };
}

/** Throws a broken input contract, or a failure the worklet channel revealed, at the attempt's next wait. */
function requireHealthyAttempt(attempt: AudioDecodeAttempt): void {
    if (attempt.protocolFailure !== null) {
        throw new Error(attempt.protocolFailure);
    }
    const producerFailure = attempt.producer?.failure ?? null;
    if (producerFailure !== null) {
        throw new WorkletPCMProducerError(producerFailure);
    }
}

function addOutputCredits(attempt: AudioDecodeAttempt, outputCredits: number): void {
    attempt.outputCredits = Math.min(MAX_DECODED_AUDIO_SAMPLE_CREDITS, attempt.outputCredits + outputCredits);
    wakeWaiters(attempt.wakeWaiters);
}

/**
 * Renders the decoded PCM attempts the decode worker opens, one at a time.
 * Each batch is rendered under the producer's credit window and then credited back, so the decode worker demuxes at most a few batches ahead.
 */
class AudioDecodeWorkerRuntime {
    // The worklet returns each played chunk's channel buffers, and the WebAssembly output stage writes later chunks into them
    private readonly channelPool = new PCMChannelPool(
        MAXIMUM_AUDIO_OUTPUT_CHUNK_FRAME_COUNT,
        MAXIMUM_SPARE_AUDIO_OUTPUT_CHANNEL_BUFFERS
    );
    // The decode worker closes an attempt before it opens the next; a closed attempt unwinds on its own
    private currentAttempt: AudioDecodeAttempt | null = null;
    private readonly scope: AudioDecodeWorkerScope;

    public constructor(scope: AudioDecodeWorkerScope) {
        this.scope = scope;
    }

    public handleRequest(value: unknown): void {
        if (!isAudioDecodeWorkerRequest(value)) {
            // Both ends are one build, so an invalid request is a defect; the throw reaches the decode worker as this worker's error
            throw new TypeError(INVALID_REQUEST_MESSAGE);
        }
        switch (value.type) {
            case 'open-attempt':
                this.openAttempt(value);
                return;
            case 'attach-output':
                this.attachOutput(value);
                return;
            case 'input':
                this.receiveInput(value);
                return;
            case 'finish-attempt':
                this.finishAttempt(value);
                return;
            case 'close-attempt':
                this.closeRequestedAttempt(value);
                return;
            case 'update-downmix-settings':
                this.updateDownmixSettings(value);
                return;
        }
    }

    private post(response: AudioDecodeWorkerResponse): void {
        this.scope.postMessage(response, []);
    }

    private openAttempt(request: AudioDecodeWorkerOpenAttemptRequest): void {
        if (this.currentAttempt) {
            this.closeAttempt(this.currentAttempt);
        }
        const attempt: AudioDecodeAttempt = {
            audioEpoch: request.audioEpoch,
            cancelled: false,
            completion: Promise.resolve(),
            finishRequested: false,
            generation: request.generation,
            inputBatches: [],
            options: request,
            outputCredits: 0,
            outstandingInputCount: 0,
            pendingAudioOutput: request.audioOutput,
            producer: null,
            protocolFailure: null,
            streamingDownmixSettings: null,
            wakeWaiters: []
        };
        this.currentAttempt = attempt;
        attempt.completion = this.runAttempt(attempt);
    }

    /** Takes the initial attempt's worklet channel; a channel no attempt will open is closed. */
    private attachOutput(request: AudioDecodeWorkerAttachOutputRequest): void {
        const attempt = this.currentAttempt;
        if (!matchesAttempt(attempt, request) || attempt.pendingAudioOutput || attempt.producer) {
            request.audioOutput.port.close();
            return;
        }
        attempt.pendingAudioOutput = request.audioOutput;
        wakeWaiters(attempt.wakeWaiters);
    }

    /** Queues a batch of the open attempt; a closed attempt's batches are dropped with their buffers. */
    private receiveInput(request: AudioDecodeWorkerInputRequest): void {
        const attempt = this.currentAttempt;
        if (!matchesAttempt(attempt, request)) {
            return;
        }
        attempt.outstandingInputCount += 1;
        if (attempt.finishRequested) {
            attempt.protocolFailure ??= INPUT_AFTER_FINISH_MESSAGE;
        } else if (attempt.outstandingInputCount > AUDIO_DECODE_WORKER_INPUT_CREDITS) {
            attempt.protocolFailure ??= INPUT_CREDIT_MESSAGE;
        } else {
            attempt.inputBatches.push(request.batch);
        }
        wakeWaiters(attempt.wakeWaiters);
    }

    private finishAttempt(request: AudioDecodeWorkerFinishAttemptRequest): void {
        const attempt = this.currentAttempt;
        if (!matchesAttempt(attempt, request)) {
            return;
        }
        attempt.finishRequested = true;
        wakeWaiters(attempt.wakeWaiters);
    }

    private closeRequestedAttempt(request: AudioDecodeWorkerCloseAttemptRequest): void {
        const attempt = this.currentAttempt;
        if (matchesAttempt(attempt, request)) {
            this.closeAttempt(attempt);
        }
    }

    /** Closes the worklet channel at once; `attempt-closed` follows once the attempt's run released the rest. */
    private closeAttempt(attempt: AudioDecodeAttempt): void {
        if (this.currentAttempt === attempt) {
            this.currentAttempt = null;
        }
        attempt.cancelled = true;
        attempt.producer?.close();
        attempt.producer = null;
        attempt.pendingAudioOutput?.port.close();
        attempt.pendingAudioOutput = null;
        attempt.inputBatches.length = 0;
        wakeWaiters(attempt.wakeWaiters);
        void attempt.completion.then((): void => {
            this.post({ ...getAttemptKey(attempt), type: 'attempt-closed' });
        });
    }

    private updateDownmixSettings(request: AudioDecodeWorkerUpdateDownmixSettingsRequest): void {
        const attempt = this.currentAttempt;
        if (attempt?.generation === request.generation) {
            attempt.streamingDownmixSettings?.update(request.generation, request.audioDownmixSettings);
        }
    }

    /**
     * Runs one attempt from its open to its finish, its failure, or its close; it never rejects.
     * The decoder and output stage go with the run, and the producer stays open until the attempt closes, so the worklet plays out what it holds.
     */
    private async runAttempt(attempt: AudioDecodeAttempt): Promise<void> {
        let decoder: BundledAudioDecoder | null = null;
        let outputStage: DecodedAudioOutputStage | null = null;
        try {
            const options = attempt.options;
            // Every stereo output takes live gains, since any decoded layout can fold down to it
            attempt.streamingDownmixSettings = options.outputChannelCount === STEREO_OUTPUT_CHANNEL_COUNT ?
                new StreamingAudioDownmixSettings(options.generation, options.sourceSampleRate, options.audioDownmixSettings) :
                null;
            // Loads beside the decoder; a failed load resolves null and the JavaScript output stage renders
            const outputStageModulePromise = loadPlaybackAudioOutputStageModule();
            decoder = await createBundledAudioDecoder(options);
            const outputStageModule = await outputStageModulePromise;
            if (attempt.cancelled) {
                return;
            }
            outputStage = this.createOutputStage(attempt, outputStageModule);

            for (let batch = await this.takeInputBatch(attempt); batch; batch = await this.takeInputBatch(attempt)) {
                if (!await this.renderInputBatch(attempt, batch, decoder, outputStage)) {
                    return;
                }
                attempt.outstandingInputCount -= 1;
                this.post({ ...getAttemptKey(attempt), inputCredits: 1, type: 'input-credit' });
            }
            if (attempt.cancelled) {
                return;
            }
            if (decoder?.backend === 'dts') {
                decoder.seekRecovery.requireSynchronizationRecovered();
            }
            if (!await this.submitOutputs(attempt, outputStage.finalize(), false)) {
                return;
            }
            this.post({ ...getAttemptKey(attempt), type: 'attempt-finished' });
        } catch (error) {
            // Failures while a closed attempt unwinds are expected and discarded
            if (!attempt.cancelled) {
                this.post({
                    ...getAttemptKey(attempt),
                    failureKind: classifyAudioDecodeFailure(error),
                    message: getFailureMessage(error),
                    type: 'attempt-failed'
                });
            }
        } finally {
            decoder?.decoder.close();
            // The worker outlives the attempt, so its output stage's WebAssembly memory is freed now
            outputStage?.close();
        }
    }

    /**
     * Creates an attempt's output stage with the tolerance its codec and container timestamps need.
     * The stage binds to the first decoded format, and renders in the WebAssembly output stage when the worker loaded it.
     */
    private createOutputStage(
        attempt: AudioDecodeAttempt,
        outputStageModule: AudioOutputStageModule | null
    ): DecodedAudioOutputStage {
        return new DecodedAudioOutputStage({
            channelPool: this.channelPool,
            maximumOutputFrameCount: MAXIMUM_AUDIO_OUTPUT_CHUNK_FRAME_COUNT,
            minimumOutputFrameCount: MINIMUM_AUDIO_OUTPUT_CHUNK_FRAME_COUNT,
            onSourceFormat: (sourceFormat): void => {
                if (!attempt.cancelled) {
                    this.post({
                        ...getAttemptKey(attempt),
                        channelCount: sourceFormat.channelCount,
                        sampleRate: sourceFormat.sampleRate,
                        type: 'source-format'
                    });
                }
            },
            onTimelineCorrection: logAudioTimelineCorrection,
            outputChannelCount: attempt.options.outputChannelCount,
            outputStageModule,
            routeCodec: attempt.options.routeCodec,
            timestampToleranceMicroseconds: getTimestampToleranceMicroseconds(attempt.options)
        });
    }

    /** Returns the next batch, or null once the last one was rendered or the attempt closed. */
    private async takeInputBatch(attempt: AudioDecodeAttempt): Promise<AudioDecodeWorkerInputBatch | null> {
        while (!attempt.cancelled) {
            requireHealthyAttempt(attempt);
            const batch = attempt.inputBatches.shift();
            if (batch) {
                return batch;
            }
            if (attempt.finishRequested) {
                return null;
            }
            await waitForChange(attempt);
        }
        return null;
    }

    private renderInputBatch(
        attempt: AudioDecodeAttempt,
        batch: AudioDecodeWorkerInputBatch,
        decoder: BundledAudioDecoder | null,
        outputStage: DecodedAudioOutputStage
    ): Promise<boolean> {
        switch (batch.kind) {
            case 'packets':
                if (!decoder) {
                    throw new TypeError(INPUT_KIND_MESSAGE);
                }
                return this.renderPackets(attempt, batch, decoder, outputStage);
            case 'pcm':
                if (decoder) {
                    throw new TypeError(INPUT_KIND_MESSAGE);
                }
                return this.renderPCMSamples(attempt, batch, outputStage);
        }
    }

    /** Decodes a batch's packets in order, each under one output credit; returns false once the attempt closed. */
    private async renderPackets(
        attempt: AudioDecodeAttempt,
        batch: AudioDecodeWorkerPacketBatch,
        decoder: BundledAudioDecoder,
        outputStage: DecodedAudioOutputStage
    ): Promise<boolean> {
        let byteOffset = 0;
        for (let packetIndex = 0; packetIndex < batch.packetByteLengths.length; packetIndex += 1) {
            const packetByteLength = batch.packetByteLengths[packetIndex];
            const packetData = new Uint8Array(batch.data, byteOffset, packetByteLength);
            byteOffset += packetByteLength;
            if (!await this.reserveOutputCredit(attempt)) {
                return false;
            }
            const outputs = this.decodePacket(
                attempt,
                decoder,
                outputStage,
                packetData,
                batch.packetTimestampsMicroseconds[packetIndex]
            );
            if (!await this.submitOutputs(attempt, outputs, true)) {
                return false;
            }
        }
        return true;
    }

    private decodePacket(
        attempt: AudioDecodeAttempt,
        decoder: BundledAudioDecoder,
        outputStage: DecodedAudioOutputStage,
        packetData: Uint8Array,
        packetTimeMicroseconds: Microseconds
    ): StreamingAudioResamplerOutput[] {
        switch (decoder.backend) {
            case 'dts': {
                const seekRecovery = decoder.seekRecovery;
                seekRecovery.requireSynchronizationRecoveredBefore(packetTimeMicroseconds);
                let output: DTSDecodedAudioOutput;
                try {
                    output = decoder.decoder.decode(packetData, packetTimeMicroseconds);
                } catch (error) {
                    if (!seekRecovery.shouldIgnore(error, packetTimeMicroseconds)) {
                        throw error;
                    }
                    return [];
                }
                seekRecovery.markDecodeSucceeded();
                return this.normalizeDecodedOutput(attempt, outputStage, output);
            }
            case 'eac3':
            case 'truehd': {
                const normalizedOutputs: StreamingAudioResamplerOutput[] = [];
                for (const output of decoder.decoder.decode(packetData, packetTimeMicroseconds)) {
                    normalizedOutputs.push(...this.normalizeDecodedOutput(attempt, outputStage, output));
                }
                return normalizedOutputs;
            }
        }
    }

    /** Renders a batch's samples in order, each under one output credit; returns false once the attempt closed. */
    private async renderPCMSamples(
        attempt: AudioDecodeAttempt,
        batch: AudioDecodeWorkerPCMBatch,
        outputStage: DecodedAudioOutputStage
    ): Promise<boolean> {
        for (const sample of batch.samples) {
            if (!await this.reserveOutputCredit(attempt)) {
                return false;
            }
            if (!await this.submitOutputs(attempt, this.normalizePCMSample(attempt, outputStage, sample), true)) {
                return false;
            }
        }
        return true;
    }

    /** Normalizes one DTS, E-AC-3, or TrueHD output, whose decoder reports its speaker layout. */
    private normalizeDecodedOutput(
        attempt: AudioDecodeAttempt,
        outputStage: DecodedAudioOutputStage,
        output: BundledDecodedAudioOutput
    ): StreamingAudioResamplerOutput[] {
        const boundInput = outputStage.bind({
            channelCount: output.channelData.length,
            layout: output.channelLayout,
            sampleRate: output.sampleRate
        }, attempt.streamingDownmixSettings);
        const sampleWindow = getAudioSampleWindow(
            output.mediaTimeMicroseconds,
            output.frameCount,
            output.sampleRate,
            attempt.options.startTimeMicroseconds
        );
        if (!sampleWindow) {
            return boundInput.outputs;
        }

        // The decoders return freshly owned planes, which the output stage only reads into its history, so a view suffices
        const inputChannelData: Float32Array[] = [];
        const endFrame = sampleWindow.frameOffset + sampleWindow.frameCount;
        for (const channel of output.channelData) {
            inputChannelData.push(channel.subarray(sampleWindow.frameOffset, endFrame));
        }
        return this.pushToPipeline(attempt, boundInput, inputChannelData, sampleWindow.mediaTimeMicroseconds);
    }

    /** Normalizes one sample Mediabunny decoded, which the decode worker already cut to the start. */
    private normalizePCMSample(
        attempt: AudioDecodeAttempt,
        outputStage: DecodedAudioOutputStage,
        sample: AudioDecodeWorkerPCMSample
    ): StreamingAudioResamplerOutput[] {
        const boundInput = outputStage.bind({
            channelCount: sample.channelCount,
            layout: null,
            sampleRate: sample.sampleRate
        }, attempt.streamingDownmixSettings);
        if (sample.frameCount === 0) {
            return boundInput.outputs;
        }
        return this.pushToPipeline(attempt, boundInput, sample.channelData, sample.mediaTimeMicroseconds);
    }

    private pushToPipeline(
        attempt: AudioDecodeAttempt,
        boundInput: BoundDecodedAudioInput,
        inputChannelData: readonly Float32Array[],
        mediaTimeMicroseconds: Microseconds
    ): StreamingAudioResamplerOutput[] {
        const channelData = prepareOutputChannelData(attempt, inputChannelData, boundInput.layout);
        return [
            ...boundInput.outputs,
            ...boundInput.pipeline.push({ channelData, mediaTimeMicroseconds })
        ];
    }

    /**
     * Takes one output credit, waiting until the worklet plays a chunk.
     * The producer opens on the attempt's channel at the first wait after it arrives, and a failed producer fails the attempt here.
     */
    private async reserveOutputCredit(attempt: AudioDecodeAttempt): Promise<boolean> {
        while (!attempt.cancelled) {
            const pendingAudioOutput = attempt.pendingAudioOutput;
            if (pendingAudioOutput) {
                attempt.pendingAudioOutput = null;
                this.openProducer(attempt, pendingAudioOutput);
            }
            requireHealthyAttempt(attempt);
            if (attempt.outputCredits > 0) {
                attempt.outputCredits -= 1;
                return true;
            }
            await waitForChange(attempt);
        }
        return false;
    }

    /** Opens the attempt's producer on its worklet channel; the channel's credit window becomes the attempt's. */
    private openProducer(attempt: AudioDecodeAttempt, audioOutput: DecodeWorkerAudioOutputAttachment): void {
        let producer: WorkletPCMProducer;
        try {
            producer = new WorkletPCMProducer({
                audioSampleCredits: audioOutput.audioSampleCredits,
                channelCount: audioOutput.channelCount,
                channelPool: this.channelPool,
                maximumBufferedFrameCount: audioOutput.maximumBufferedFrameCount,
                onCreditsReleased: (outputCredits): void => {
                    if (attempt.producer === producer) {
                        addOutputCredits(attempt, outputCredits);
                    }
                },
                onFailure: (): void => {
                    // The attempt's credit wait or its next submission throws the failure
                    if (attempt.producer === producer) {
                        wakeWaiters(attempt.wakeWaiters);
                    }
                },
                port: audioOutput.port,
                sampleRate: audioOutput.sampleRate,
                workletGeneration: audioOutput.workletGeneration
            });
        } catch {
            audioOutput.port.close();
            throw new WorkletPCMProducerError(INVALID_AUDIO_OUTPUT_MESSAGE);
        }
        attempt.producer = producer;
        attempt.outputCredits = audioOutput.audioSampleCredits;
        wakeWaiters(attempt.wakeWaiters);
    }

    /** Posts each output on a credit, the first on the reserved one, and returns a reserved credit no output took. */
    private async submitOutputs(
        attempt: AudioDecodeAttempt,
        outputs: readonly StreamingAudioResamplerOutput[],
        reservedCredit: boolean
    ): Promise<boolean> {
        let creditAvailable = reservedCredit;
        for (const output of outputs) {
            if (!creditAvailable && !await this.reserveOutputCredit(attempt)) {
                return false;
            }
            creditAvailable = false;
            if (attempt.cancelled) {
                return false;
            }
            this.submitOutput(attempt, output);
        }
        if (creditAvailable && !attempt.cancelled) {
            addOutputCredits(attempt, 1);
        }
        return !attempt.cancelled;
    }

    /** Posts one chunk straight to the worklet, and its progress without the PCM to the decode worker. */
    private submitOutput(attempt: AudioDecodeAttempt, output: StreamingAudioResamplerOutput): void {
        const producer = attempt.producer;
        if (!producer) {
            throw new WorkletPCMProducerError(MISSING_AUDIO_OUTPUT_MESSAGE);
        }
        producer.submit(output);
        this.post({
            ...getAttemptKey(attempt),
            durationMicroseconds: output.durationMicroseconds,
            frameCount: output.frameCount,
            mediaTimeMicroseconds: output.mediaTimeMicroseconds,
            sampleRate: output.sampleRate,
            type: 'progress'
        });
    }
}

/** Starts the runtime on a scope; requests arrive as its messages. */
export function startAudioDecodeWorkerRuntime(scope: AudioDecodeWorkerScope): void {
    const runtime = new AudioDecodeWorkerRuntime(scope);
    scope.addEventListener('message', (event: MessageEvent<unknown>): void => {
        runtime.handleRequest(event.data);
    });
}
