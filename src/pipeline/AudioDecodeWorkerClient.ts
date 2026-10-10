// The decode worker's side of its audio decode worker: the worker's life, each attempt's input credits and outcome, and the batches it sends

import type { Microseconds } from '../MediaTime';
import type { AudioDownmixSettings } from '../audio/processing/CustomAudioDownmix';
import {
    AUDIO_DECODE_WORKER_BATCH_DURATION_MICROSECONDS,
    AUDIO_DECODE_WORKER_INPUT_CREDITS,
    getAudioDecodeWorkerInputTransferList,
    isAudioDecodeWorkerResponse,
    MAXIMUM_AUDIO_DECODE_WORKER_BATCH_INPUT_COUNT,
    MAXIMUM_AUDIO_DECODE_WORKER_PACKET_BATCH_BYTE_LENGTH,
    type AudioDecodeWorkerAttemptKey,
    type AudioDecodeWorkerInputBatch,
    type AudioDecodeWorkerOpenAttemptRequest,
    type AudioDecodeWorkerPacketBatch,
    type AudioDecodeWorkerPCMBatch,
    type AudioDecodeWorkerPCMSample,
    type AudioDecodeWorkerProgressResponse,
    type AudioDecodeWorkerRequest,
    type AudioDecodeWorkerResponse,
    type AudioDecodeWorkerSourceFormatResponse
} from './AudioDecodeWorkerProtocol';
import type { CustomDecodeFailureKind, DecodeWorkerAudioOutputAttachment } from './DecodeWorkerProtocol';

const INITIAL_PACKET_BATCH_BYTE_LENGTH = 64 * 1024;
const WORKER_UNAVAILABLE_MESSAGE = 'Unable to start the audio decode worker';
const WORKER_FAILED_MESSAGE = 'The audio decode worker failed';
const UNREADABLE_RESPONSE_MESSAGE = 'The audio decode worker sent a message that could not be read';
const INVALID_RESPONSE_MESSAGE = 'The audio decode worker sent an invalid response';
// The audio decode worker hosts the worklet producer, so losing it fails the audio output, which the page replaces with native playback
const WORKER_FAILURE_KIND: CustomDecodeFailureKind = 'audio-output-failed';

export type AudioDecodeWorkerAttemptFailure = Readonly<{
    failureKind: CustomDecodeFailureKind
    message: string
}>;

export type AudioDecodeWorkerAttemptListener = Readonly<{
    /** An input credit returned, or the attempt finished or failed */
    onChange: () => void
    onProgress: (response: AudioDecodeWorkerProgressResponse) => void
    onSourceFormat: (response: AudioDecodeWorkerSourceFormatResponse) => void
}>;

export type AudioDecodeWorkerAttemptOptions = Omit<AudioDecodeWorkerOpenAttemptRequest, 'type'>;

/** Posts a request and returns whether the worker took it; a request it could not take closes the ports it carried. */
type AudioDecodeWorkerRequestPoster = (request: AudioDecodeWorkerRequest, transfer: Transferable[]) => boolean;

/** An attempt's failure as the audio decode worker reported it, with the failure kind the page acts on */
export class AudioDecodeWorkerAttemptError extends Error {
    public readonly failureKind: CustomDecodeFailureKind;

    public constructor(failure: AudioDecodeWorkerAttemptFailure) {
        super(failure.message);
        this.failureKind = failure.failureKind;
        this.name = 'AudioDecodeWorkerAttemptError';
    }
}

function getErrorMessage(error: unknown, fallbackMessage: string): string {
    return error instanceof Error && error.message.length > 0 ? `${fallbackMessage}: ${error.message}` : fallbackMessage;
}

function closeTransferredPorts(transfer: readonly Transferable[]): void {
    if (typeof MessagePort !== 'function') {
        return;
    }
    for (const transferable of transfer) {
        if (transferable instanceof MessagePort) {
            transferable.close();
        }
    }
}

function spansBatchDuration(firstTimeMicroseconds: Microseconds, lastTimeMicroseconds: Microseconds): boolean {
    return Math.abs(lastTimeMicroseconds - firstTimeMicroseconds) >= AUDIO_DECODE_WORKER_BATCH_DURATION_MICROSECONDS;
}

/** One decoded audio attempt as the decode worker drives it: its input credits, its outcome, and its requests. */
export class AudioDecodeWorkerAttempt {
    public readonly audioEpoch: number;
    public readonly generation: number;
    private closed = false;
    private closure: Promise<void> | null = null;
    private failureValue: AudioDecodeWorkerAttemptFailure | null = null;
    private finishedValue = false;
    private inputCredits = AUDIO_DECODE_WORKER_INPUT_CREDITS;
    private readonly listener: AudioDecodeWorkerAttemptListener;
    private readonly post: AudioDecodeWorkerRequestPoster;
    private resolveClosure: (() => void) | null = null;
    private closureSettled = false;

    public constructor(
        key: AudioDecodeWorkerAttemptKey,
        listener: AudioDecodeWorkerAttemptListener,
        post: AudioDecodeWorkerRequestPoster
    ) {
        this.audioEpoch = key.audioEpoch;
        this.generation = key.generation;
        this.listener = listener;
        this.post = post;
    }

    /** The attempt's failure, or null while it is healthy */
    public get failure(): AudioDecodeWorkerAttemptFailure | null {
        return this.failureValue;
    }

    /** Whether the attempt rendered its last batch and its tails */
    public get finished(): boolean {
        return this.finishedValue;
    }

    /** Takes the credit for the next batch, or returns false while every batch is in flight. */
    public takeInputCredit(): boolean {
        if (this.inputCredits === 0) {
            return false;
        }
        this.inputCredits -= 1;
        return true;
    }

    /** Sends one batch on the credit taken for it, transferring its buffers. */
    public sendInput(batch: AudioDecodeWorkerInputBatch): void {
        if (this.closed) {
            return;
        }
        this.post({ ...this.getKey(), batch, type: 'input' }, getAudioDecodeWorkerInputTransferList(batch));
    }

    /** Hands the initial attempt its worklet channel. */
    public attachOutput(audioOutput: DecodeWorkerAudioOutputAttachment): void {
        if (this.closed) {
            audioOutput.port.close();
            return;
        }
        this.post({ ...this.getKey(), audioOutput, type: 'attach-output' }, [ audioOutput.port ]);
    }

    /** Ends the attempt's input at the end of its track; `finished` follows once its tails are rendered. */
    public finish(): void {
        if (!this.closed) {
            this.post({ ...this.getKey(), type: 'finish-attempt' }, []);
        }
    }

    /** Closes the attempt, and resolves once the audio decode worker released its decoder, output stage, and worklet channel. */
    public close(): Promise<void> {
        if (this.closure) {
            return this.closure;
        }
        this.closed = true;
        this.closure = new Promise<void>(resolve => {
            this.resolveClosure = resolve;
        });
        if (this.closureSettled || !this.post({ ...this.getKey(), type: 'close-attempt' }, [])) {
            this.settleClosure();
        }
        return this.closure;
    }

    /** Applies one of the attempt's responses; the client routes them here. */
    public receive(response: AudioDecodeWorkerResponse): void {
        switch (response.type) {
            case 'input-credit':
                this.inputCredits = Math.min(AUDIO_DECODE_WORKER_INPUT_CREDITS, this.inputCredits + response.inputCredits);
                this.listener.onChange();
                return;
            case 'progress':
                if (!this.closed) {
                    this.listener.onProgress(response);
                }
                return;
            case 'source-format':
                if (!this.closed) {
                    this.listener.onSourceFormat(response);
                }
                return;
            case 'attempt-finished':
                this.finishedValue = true;
                this.listener.onChange();
                return;
            case 'attempt-failed':
                this.fail({ failureKind: response.failureKind, message: response.message });
                return;
            case 'attempt-closed':
                this.settleClosure();
                return;
        }
    }

    /** Fails the attempt once; the client also fails it when the worker is lost. */
    public fail(failure: AudioDecodeWorkerAttemptFailure): void {
        if (this.failureValue) {
            return;
        }
        this.failureValue = failure;
        this.listener.onChange();
    }

    /** Settles the closure, now or as soon as the attempt closes; a lost worker released everything with itself. */
    public settleClosure(): void {
        this.closureSettled = true;
        this.resolveClosure?.();
        this.resolveClosure = null;
    }

    private getKey(): AudioDecodeWorkerAttemptKey {
        return { audioEpoch: this.audioEpoch, generation: this.generation };
    }
}

/**
 * Owns the audio decode worker a decode worker spawns, and routes each response to its attempt.
 * A worker that fails to start, throws, or answers out of contract fails every attempt as an audio output failure.
 */
export default class AudioDecodeWorkerClient {
    private readonly attempts: AudioDecodeWorkerAttempt[] = [];
    private failureMessage: string | null = null;
    private readonly worker: Worker | null;

    public constructor(createWorker: () => Worker) {
        let worker: Worker | null = null;
        try {
            worker = createWorker();
        } catch (error) {
            this.failureMessage = getErrorMessage(error, WORKER_UNAVAILABLE_MESSAGE);
        }
        this.worker = worker;
        if (!worker) {
            return;
        }
        worker.onmessage = (event: MessageEvent<unknown>): void => {
            this.receive(event.data);
        };
        worker.onerror = (event: ErrorEvent): void => {
            this.fail(event.message ? `${WORKER_FAILED_MESSAGE}: ${event.message}` : WORKER_FAILED_MESSAGE);
        };
        worker.onmessageerror = (): void => {
            this.fail(UNREADABLE_RESPONSE_MESSAGE);
        };
    }

    /** Why the worker is lost, or null while it works */
    public get failure(): string | null {
        return this.failureMessage;
    }

    /** Opens an attempt; a resync's worklet channel goes with the open request. */
    public openAttempt(
        options: AudioDecodeWorkerAttemptOptions,
        listener: AudioDecodeWorkerAttemptListener
    ): AudioDecodeWorkerAttempt {
        const attempt = new AudioDecodeWorkerAttempt(
            options,
            listener,
            (request: AudioDecodeWorkerRequest, transfer: Transferable[]): boolean => this.post(request, transfer)
        );
        this.attempts.push(attempt);
        this.post({ ...options, type: 'open-attempt' }, options.audioOutput ? [ options.audioOutput.port ] : []);
        if (this.failureMessage !== null) {
            this.attempts.splice(this.attempts.indexOf(attempt), 1);
            attempt.fail({ failureKind: WORKER_FAILURE_KIND, message: this.failureMessage });
            attempt.settleClosure();
        }
        return attempt;
    }

    /** Sends live downmix gains to the run's open stereo attempt. */
    public updateDownmixSettings(generation: number, audioDownmixSettings: AudioDownmixSettings): void {
        this.post({ audioDownmixSettings, generation, type: 'update-downmix-settings' }, []);
    }

    private post(request: AudioDecodeWorkerRequest, transfer: Transferable[]): boolean {
        const worker = this.worker;
        if (worker && this.failureMessage === null) {
            try {
                worker.postMessage(request, transfer);
                return true;
            } catch (error) {
                this.fail(getErrorMessage(error, WORKER_FAILED_MESSAGE));
            }
        }
        closeTransferredPorts(transfer);
        return false;
    }

    private receive(value: unknown): void {
        if (!isAudioDecodeWorkerResponse(value)) {
            this.fail(INVALID_RESPONSE_MESSAGE);
            return;
        }
        const attemptIndex = this.attempts.findIndex(attempt => (
            attempt.generation === value.generation && attempt.audioEpoch === value.audioEpoch
        ));
        if (attemptIndex < 0) {
            return;
        }
        const attempt = this.attempts[attemptIndex];
        if (value.type === 'attempt-closed') {
            this.attempts.splice(attemptIndex, 1);
        }
        attempt.receive(value);
    }

    /** Fails every attempt once the worker is lost, and stops the worker. */
    private fail(message: string): void {
        if (this.failureMessage !== null) {
            return;
        }
        this.failureMessage = message;
        this.worker?.terminate();
        for (const attempt of this.attempts.splice(0)) {
            attempt.fail({ failureKind: WORKER_FAILURE_KIND, message });
            attempt.settleClosure();
        }
    }
}

/** Gathers one batch of compressed packets, copied back to back into the buffer the batch transfers */
export class AudioDecodeWorkerPacketBatchBuilder {
    private byteLength = 0;
    private data: Uint8Array<ArrayBuffer> | null = null;
    private packetByteLengths: number[] = [];
    private packetTimestampsMicroseconds: Microseconds[] = [];

    /** Copies one packet in, since the demuxer may reuse the bytes it lent. */
    public add(packetData: Uint8Array, timestampMicroseconds: Microseconds): void {
        const byteLength = this.byteLength + packetData.byteLength;
        const data = this.reserve(byteLength);
        data.set(packetData, this.byteLength);
        this.data = data;
        this.byteLength = byteLength;
        this.packetByteLengths.push(packetData.byteLength);
        this.packetTimestampsMicroseconds.push(timestampMicroseconds);
    }

    /** Whether the batch reached its packet count, its byte length, or its media time span */
    public isFull(): boolean {
        const packetCount = this.packetByteLengths.length;
        return packetCount >= MAXIMUM_AUDIO_DECODE_WORKER_BATCH_INPUT_COUNT
            || this.byteLength >= MAXIMUM_AUDIO_DECODE_WORKER_PACKET_BATCH_BYTE_LENGTH
            || (packetCount > 0 && spansBatchDuration(
                this.packetTimestampsMicroseconds[0],
                this.packetTimestampsMicroseconds[packetCount - 1]
            ));
    }

    /** Returns the batch and starts the next one, or returns null when no packet was added. */
    public take(): AudioDecodeWorkerPacketBatch | null {
        const data = this.data;
        if (!data || this.packetByteLengths.length === 0) {
            return null;
        }
        const batch: AudioDecodeWorkerPacketBatch = {
            data: data.buffer,
            kind: 'packets',
            packetByteLengths: this.packetByteLengths,
            packetTimestampsMicroseconds: this.packetTimestampsMicroseconds
        };
        this.byteLength = 0;
        this.data = null;
        this.packetByteLengths = [];
        this.packetTimestampsMicroseconds = [];
        return batch;
    }

    /** Returns a buffer of at least the byte length that holds the packets so far, doubling the current one when it is too small. */
    private reserve(byteLength: number): Uint8Array<ArrayBuffer> {
        const data = this.data;
        if (data && data.byteLength >= byteLength) {
            return data;
        }
        const grownData = new Uint8Array(Math.max(INITIAL_PACKET_BATCH_BYTE_LENGTH, byteLength, (data?.byteLength ?? 0) * 2));
        if (data) {
            grownData.set(data.subarray(0, this.byteLength));
        }
        return grownData;
    }
}

/** Gathers one batch of decoded samples, whose planes the batch transfers */
export class AudioDecodeWorkerPCMBatchBuilder {
    private samples: AudioDecodeWorkerPCMSample[] = [];

    public add(sample: AudioDecodeWorkerPCMSample): void {
        this.samples.push(sample);
    }

    /** Whether the batch reached its sample count or its media time span */
    public isFull(): boolean {
        const sampleCount = this.samples.length;
        return sampleCount >= MAXIMUM_AUDIO_DECODE_WORKER_BATCH_INPUT_COUNT
            || (sampleCount > 0 && spansBatchDuration(
                this.samples[0].mediaTimeMicroseconds,
                this.samples[sampleCount - 1].mediaTimeMicroseconds
            ));
    }

    /** Returns the batch and starts the next one, or returns null when no sample was added. */
    public take(): AudioDecodeWorkerPCMBatch | null {
        if (this.samples.length === 0) {
            return null;
        }
        const batch: AudioDecodeWorkerPCMBatch = { kind: 'pcm', samples: this.samples };
        this.samples = [];
        return batch;
    }
}
