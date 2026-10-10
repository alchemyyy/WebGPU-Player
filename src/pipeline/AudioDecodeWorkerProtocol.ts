// Messages between the decode worker and the audio decode worker it spawns
// The decode worker demuxes each decoded PCM attempt and sends its input in batches, on input credits
// The audio decode worker decodes, renders, and feeds the worklet, and reports what the page must learn back through the decode worker

import type { Microseconds } from '../MediaTime';
import type { TrueHDDecoderCodec } from '../audio/decoders/TrueHDSoftwareAudioDecoder';
import type { CustomAudioOutputChannelCount } from '../audio/processing/CustomAudioChannelLayout';
import type { AudioDownmixSettings } from '../audio/processing/CustomAudioDownmix';
import {
    isCustomAudioDownmixAlgorithm,
    type CustomAudioDownmixAlgorithm
} from '../audio/processing/CustomAudioDownmixAlgorithm';
import { isSupportedCustomAudioSampleRate } from '../audio/CustomAudioSampleRate';
import {
    isAudioDownmixSettings,
    isAudioOutputAttachment,
    isCustomDecodeFailureKind,
    isDecodedAudioOutputChannelCount,
    MAX_DECODED_AUDIO_CHANNELS,
    MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE,
    type CustomDecodeFailureKind,
    type DecodeWorkerAudioOutputAttachment
} from './DecodeWorkerProtocol';

/** The batches in flight to one attempt; each returns its credit once the audio decode worker has rendered it */
export const AUDIO_DECODE_WORKER_INPUT_CREDITS = 4;
/** A batch closes once its first and last inputs lie this far apart in media time */
export const AUDIO_DECODE_WORKER_BATCH_DURATION_MICROSECONDS = 40_000;
/** Bounds a batch's inputs; TrueHD's 1200 access units a second still close on duration */
export const MAXIMUM_AUDIO_DECODE_WORKER_BATCH_INPUT_COUNT = 64;
/** Closes a batch of large packets early */
export const MAXIMUM_AUDIO_DECODE_WORKER_PACKET_BATCH_BYTE_LENGTH = 1024 * 1024;
export const MAXIMUM_AUDIO_DECODE_WORKER_FAILURE_MESSAGE_LENGTH = 512;
const MAXIMUM_ROUTE_CODEC_LENGTH = 64;

/** The decoder an attempt's input feeds: a bundled decoder takes packets, and `pcm` takes samples Mediabunny already decoded */
export type AudioDecodeWorkerDecoderBackend = 'dts' | 'eac3' | 'pcm' | TrueHDDecoderCodec;

/** Names one decoded audio attempt: its run's generation and its audio epoch */
export type AudioDecodeWorkerAttemptKey = {
    audioEpoch: number
    generation: number
};

/** Opens an attempt; the audio decode worker loads its decoder and output stage while the first batches arrive. */
export type AudioDecodeWorkerOpenAttemptRequest = AudioDecodeWorkerAttemptKey & {
    audioDownmixAlgorithm: CustomAudioDownmixAlgorithm
    /** The newest gains; a stereo attempt takes later ones live */
    audioDownmixSettings: AudioDownmixSettings
    /** A resync's new worklet channel; the initial attempt's channel follows in `attach-output` */
    audioOutput: DecodeWorkerAudioOutputAttachment | null
    decoderBackend: AudioDecodeWorkerDecoderBackend
    outputChannelCount: CustomAudioOutputChannelCount
    /** The codec name the decoded PCM route tables qualify */
    routeCodec: string
    /** The declared rate, at which live gains ramp until the first decoded output binds its own */
    sourceSampleRate: number
    startTimeMicroseconds: Microseconds
    /** All packet timestamps are integer multiples of its reciprocal */
    timeResolution: number
    type: 'open-attempt'
};

/** Gives the initial attempt its worklet channel once the page's output exists. */
export type AudioDecodeWorkerAttachOutputRequest = AudioDecodeWorkerAttemptKey & {
    audioOutput: DecodeWorkerAudioOutputAttachment
    type: 'attach-output'
};

/** Compressed packets for a bundled decoder, back to back in one buffer */
export type AudioDecodeWorkerPacketBatch = {
    data: ArrayBuffer
    kind: 'packets'
    packetByteLengths: number[]
    packetTimestampsMicroseconds: Microseconds[]
};

/** One sample Mediabunny decoded, cut to the attempt's start; a sample wholly before the start carries only its format */
export type AudioDecodeWorkerPCMSample = {
    channelCount: number
    /** One plane per channel, or none when no frame of the sample is at or after the start */
    channelData: Float32Array[]
    frameCount: number
    mediaTimeMicroseconds: Microseconds
    sampleRate: number
};

export type AudioDecodeWorkerPCMBatch = {
    kind: 'pcm'
    samples: AudioDecodeWorkerPCMSample[]
};

export type AudioDecodeWorkerInputBatch = AudioDecodeWorkerPacketBatch | AudioDecodeWorkerPCMBatch;

/** Sends one batch on one input credit. */
export type AudioDecodeWorkerInputRequest = AudioDecodeWorkerAttemptKey & {
    batch: AudioDecodeWorkerInputBatch
    type: 'input'
};

/** Ends the attempt's input at the end of its track; the audio decode worker drains its tails and answers `attempt-finished`. */
export type AudioDecodeWorkerFinishAttemptRequest = AudioDecodeWorkerAttemptKey & {
    type: 'finish-attempt'
};

/**
 * Ends the attempt however far it got: its worklet channel closes at once.
 * The audio decode worker answers `attempt-closed` once the attempt released its decoder and output stage.
 */
export type AudioDecodeWorkerCloseAttemptRequest = AudioDecodeWorkerAttemptKey & {
    type: 'close-attempt'
};

/** Live downmix gains for the run's open stereo attempt */
export type AudioDecodeWorkerUpdateDownmixSettingsRequest = {
    audioDownmixSettings: AudioDownmixSettings
    generation: number
    type: 'update-downmix-settings'
};

export type AudioDecodeWorkerRequest =
    | AudioDecodeWorkerAttachOutputRequest
    | AudioDecodeWorkerCloseAttemptRequest
    | AudioDecodeWorkerFinishAttemptRequest
    | AudioDecodeWorkerInputRequest
    | AudioDecodeWorkerOpenAttemptRequest
    | AudioDecodeWorkerUpdateDownmixSettingsRequest;

/** Returns the credit of a batch the attempt rendered. */
export type AudioDecodeWorkerInputCreditResponse = AudioDecodeWorkerAttemptKey & {
    inputCredits: number
    type: 'input-credit'
};

/** Reports one chunk the attempt's producer posted to the worklet, which the decode worker reports to the page as `audio-progress` */
export type AudioDecodeWorkerProgressResponse = AudioDecodeWorkerAttemptKey & {
    durationMicroseconds: Microseconds
    frameCount: number
    mediaTimeMicroseconds: Microseconds
    sampleRate: number
    type: 'progress'
};

/** Reports the decoded format the attempt's output stage bound, which the decode worker reports as `audio-source-format` */
export type AudioDecodeWorkerSourceFormatResponse = AudioDecodeWorkerAttemptKey & {
    channelCount: number
    sampleRate: number
    type: 'source-format'
};

/** The attempt rendered its last batch and its tails; its worklet channel stays open until the attempt closes */
export type AudioDecodeWorkerAttemptFinishedResponse = AudioDecodeWorkerAttemptKey & {
    type: 'attempt-finished'
};

export type AudioDecodeWorkerAttemptFailedResponse = AudioDecodeWorkerAttemptKey & {
    failureKind: CustomDecodeFailureKind
    message: string
    type: 'attempt-failed'
};

/** The closed attempt released its decoder, its output stage, and its worklet channel */
export type AudioDecodeWorkerAttemptClosedResponse = AudioDecodeWorkerAttemptKey & {
    type: 'attempt-closed'
};

export type AudioDecodeWorkerResponse =
    | AudioDecodeWorkerAttemptClosedResponse
    | AudioDecodeWorkerAttemptFailedResponse
    | AudioDecodeWorkerAttemptFinishedResponse
    | AudioDecodeWorkerInputCreditResponse
    | AudioDecodeWorkerProgressResponse
    | AudioDecodeWorkerSourceFormatResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function isPositiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) > 0;
}

function isMicroseconds(value: unknown): value is Microseconds {
    return Number.isSafeInteger(value);
}

function hasAttemptKey(value: Record<string, unknown>): boolean {
    return isPositiveInteger(value.generation)
        && Number.isSafeInteger(value.audioEpoch)
        && Number(value.audioEpoch) >= 0;
}

function isDecoderBackend(value: unknown): value is AudioDecodeWorkerDecoderBackend {
    switch (value) {
        case 'dts':
        case 'eac3':
        case 'mlp':
        case 'pcm':
        case 'truehd':
            return true;
        default:
            return false;
    }
}

function isOpenAttemptRequest(value: Record<string, unknown>): boolean {
    return isCustomAudioDownmixAlgorithm(value.audioDownmixAlgorithm)
        && isAudioDownmixSettings(value.audioDownmixSettings)
        && (value.audioOutput === null || isAudioOutputAttachment(value.audioOutput))
        && isDecoderBackend(value.decoderBackend)
        && isDecodedAudioOutputChannelCount(value.outputChannelCount)
        && typeof value.routeCodec === 'string'
        && value.routeCodec.length > 0
        && value.routeCodec.length <= MAXIMUM_ROUTE_CODEC_LENGTH
        && isSupportedCustomAudioSampleRate(value.sourceSampleRate)
        && isMicroseconds(value.startTimeMicroseconds)
        && typeof value.timeResolution === 'number'
        && Number.isFinite(value.timeResolution)
        && value.timeResolution > 0;
}

/** Packets of any length pass, so the decoder rejects an empty one as it would unbatched. */
function isPacketBatch(value: Record<string, unknown>): boolean {
    const { data, packetByteLengths, packetTimestampsMicroseconds } = value;
    if (!(data instanceof ArrayBuffer)
        || !Array.isArray(packetByteLengths)
        || !Array.isArray(packetTimestampsMicroseconds)
        || packetByteLengths.length === 0
        || packetByteLengths.length > MAXIMUM_AUDIO_DECODE_WORKER_BATCH_INPUT_COUNT
        || packetTimestampsMicroseconds.length !== packetByteLengths.length
        || !packetTimestampsMicroseconds.every(isMicroseconds)) {
        return false;
    }
    let byteLength = 0;
    for (const packetByteLength of packetByteLengths) {
        if (!Number.isSafeInteger(packetByteLength) || Number(packetByteLength) < 0) {
            return false;
        }
        byteLength += Number(packetByteLength);
    }
    return byteLength <= data.byteLength;
}

function isPCMSample(value: unknown): value is AudioDecodeWorkerPCMSample {
    if (!isRecord(value)
        || !isPositiveInteger(value.channelCount)
        || Number(value.channelCount) > MAX_DECODED_AUDIO_CHANNELS
        || !Number.isSafeInteger(value.frameCount)
        || Number(value.frameCount) < 0
        || !isMicroseconds(value.mediaTimeMicroseconds)
        || !isSupportedCustomAudioSampleRate(value.sampleRate)
        || !Array.isArray(value.channelData)) {
        return false;
    }
    const frameCount = Number(value.frameCount);
    const expectedChannelCount = frameCount === 0 ? 0 : Number(value.channelCount);
    return value.channelData.length === expectedChannelCount
        && value.channelData.every((channel: unknown): boolean => (
            channel instanceof Float32Array
            && channel.buffer instanceof ArrayBuffer
            && channel.length === frameCount
        ));
}

function isPCMBatch(value: Record<string, unknown>): boolean {
    return Array.isArray(value.samples)
        && value.samples.length > 0
        && value.samples.length <= MAXIMUM_AUDIO_DECODE_WORKER_BATCH_INPUT_COUNT
        && value.samples.every(isPCMSample);
}

function isInputBatch(value: unknown): value is AudioDecodeWorkerInputBatch {
    if (!isRecord(value)) {
        return false;
    }
    switch (value.kind) {
        case 'packets':
            return isPacketBatch(value);
        case 'pcm':
            return isPCMBatch(value);
        default:
            return false;
    }
}

export function isAudioDecodeWorkerRequest(value: unknown): value is AudioDecodeWorkerRequest {
    if (!isRecord(value)) {
        return false;
    }
    switch (value.type) {
        case 'open-attempt':
            return hasAttemptKey(value) && isOpenAttemptRequest(value);
        case 'attach-output':
            return hasAttemptKey(value) && isAudioOutputAttachment(value.audioOutput);
        case 'input':
            return hasAttemptKey(value) && isInputBatch(value.batch);
        case 'finish-attempt':
        case 'close-attempt':
            return hasAttemptKey(value);
        case 'update-downmix-settings':
            return isPositiveInteger(value.generation) && isAudioDownmixSettings(value.audioDownmixSettings);
        default:
            return false;
    }
}

function isProgressResponse(value: Record<string, unknown>): boolean {
    return isMicroseconds(value.mediaTimeMicroseconds)
        && isMicroseconds(value.durationMicroseconds)
        && Number(value.durationMicroseconds) >= 0
        && isPositiveInteger(value.frameCount)
        && Number(value.frameCount) <= MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE
        && isSupportedCustomAudioSampleRate(value.sampleRate);
}

export function isAudioDecodeWorkerResponse(value: unknown): value is AudioDecodeWorkerResponse {
    if (!isRecord(value) || !hasAttemptKey(value)) {
        return false;
    }
    switch (value.type) {
        case 'input-credit':
            return isPositiveInteger(value.inputCredits) && Number(value.inputCredits) <= AUDIO_DECODE_WORKER_INPUT_CREDITS;
        case 'progress':
            return isProgressResponse(value);
        case 'source-format':
            return isPositiveInteger(value.channelCount)
                && Number(value.channelCount) <= MAX_DECODED_AUDIO_CHANNELS
                && isSupportedCustomAudioSampleRate(value.sampleRate);
        case 'attempt-failed':
            return isCustomDecodeFailureKind(value.failureKind)
                && typeof value.message === 'string'
                && value.message.length <= MAXIMUM_AUDIO_DECODE_WORKER_FAILURE_MESSAGE_LENGTH;
        case 'attempt-finished':
        case 'attempt-closed':
            return true;
        default:
            return false;
    }
}

/** Returns the buffers a batch transfers: the packet buffer, or each sample's planes. */
export function getAudioDecodeWorkerInputTransferList(batch: AudioDecodeWorkerInputBatch): ArrayBuffer[] {
    switch (batch.kind) {
        case 'packets':
            return [ batch.data ];
        case 'pcm': {
            const transfer: ArrayBuffer[] = [];
            for (const sample of batch.samples) {
                for (const channel of sample.channelData) {
                    const buffer = channel.buffer as ArrayBuffer;
                    if (!transfer.includes(buffer)) {
                        transfer.push(buffer);
                    }
                }
            }
            return transfer;
        }
    }
}
