// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';
import type { AudioDecoderPackageSelection } from 'webgpu-player/decode/audio/AudioDecoderPackageInstance';
import { createDefaultAudioDownmixSettings } from 'webgpu-player/audio/processing/CustomAudioDownmix';
import { DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM } from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import {
    AUDIO_DECODE_WORKER_INPUT_CREDITS,
    getAudioDecodeWorkerInputTransferList,
    isAudioDecodeWorkerRequest,
    isAudioDecodeWorkerResponse,
    MAXIMUM_AUDIO_DECODE_WORKER_BATCH_INPUT_COUNT,
    MAXIMUM_AUDIO_DECODE_WORKER_FAILURE_MESSAGE_LENGTH,
    type AudioDecodeWorkerOpenAttemptRequest,
    type AudioDecodeWorkerPacketBatch,
    type AudioDecodeWorkerPCMBatch,
    type AudioDecodeWorkerPCMSample
} from 'webgpu-player/pipeline/AudioDecodeWorkerProtocol';
import type { DecodeWorkerAudioOutputAttachment } from 'webgpu-player/pipeline/DecodeWorkerProtocol';

import { createAudioDecoderPackageForTest } from '../helpers/audioDecoderPackageStubs';

const GENERATION = 4;
const AUDIO_EPOCH = 2;
const ATTEMPT_KEY = { audioEpoch: AUDIO_EPOCH, generation: GENERATION } as const;
const STEREO_CHANNEL_COUNT = 2;
const SAMPLE_RATE = 48_000;
const FRAME_COUNT = 480;
const PACKET_BYTE_LENGTHS = [ 12, 20 ] as const;
const PACKET_TIMESTAMPS_MICROSECONDS = [ 0, 10_667 ] as const;
const PACKET_BATCH_BYTE_LENGTH = 32;
const AUDIO_SAMPLE_CREDITS = 4;
// Two seconds at 48 kHz, as the worklet ring holds
const MAXIMUM_BUFFERED_FRAME_COUNT = 96_000;
const WORKLET_GENERATION = 3;
const PROGRESS_DURATION_MICROSECONDS = 10_000;
const FAILURE_MESSAGE = 'The audio worklet dropped a decoded sample';
const ROUTE_CODEC = 'pcm_s24le';
const MATROSKA_TIME_RESOLUTION = 1_000;
const START_TIME_MICROSECONDS = 0 as Microseconds;
const ONE_INPUT_CREDIT = 1;
// Malformed values: generations start at one, epochs at zero, Mediabunny's decoding stays in the decode worker, and a codec's own backend became a package
const INVALID_GENERATION = 0;
const INVALID_AUDIO_EPOCH = -1;
const INVALID_DECODER_BACKENDS = [ 'mediabunny', 'truehd', 'dts', 'eac3' ] as const;
const EMPTY_ROUTE_CODEC = '';
const QUAD_OUTPUT_CHANNEL_COUNT = 4;
const INVALID_TIME_RESOLUTION = 0;
const EMPTY_PACKET_BYTE_LENGTH = 0;
const OVERRUN_PACKET_BYTE_LENGTH = 1;
const EMPTY_FRAME_COUNT = 0;
const UNKNOWN_REQUEST_TYPE = 'unknown';
const UNKNOWN_FAILURE_KIND = 'worker-lost';
const OVERLONG_FAILURE_MESSAGE = 'x'.repeat(MAXIMUM_AUDIO_DECODE_WORKER_FAILURE_MESSAGE_LENGTH + 1);
// A package attempt decodes as a codec its package's manifest lists, which the decoded PCM route then qualifies
const PACKAGE_BACKEND = 'package';
const PACKAGE_CODEC = 'ac3';
const PACKAGE_UNLISTED_CODEC = 'dts';
// FFmpeg's 5.1 with back surrounds, which the output stage lays out, and quadraphonic, which it does not
const FIVE_POINT_ONE_BACK_CHANNEL_MASK = 0x3F;
const QUAD_CHANNEL_MASK = 0x33;

// A stub E-AC-3 package, as a host offers its audio decoder packages
const DECODER_PACKAGE = createAudioDecoderPackageForTest('E-AC-3', [ 'eac3', PACKAGE_CODEC ]);
const packageSelection: AudioDecoderPackageSelection = {
    codec: PACKAGE_CODEC,
    source: { manifest: DECODER_PACKAGE.manifest, memory: DECODER_PACKAGE.memory, module: DECODER_PACKAGE.module }
};

function createPacketBatch(overrides: Partial<AudioDecodeWorkerPacketBatch> = {}): AudioDecodeWorkerPacketBatch {
    return {
        data: new ArrayBuffer(PACKET_BATCH_BYTE_LENGTH),
        kind: 'packets',
        packetByteLengths: [ ...PACKET_BYTE_LENGTHS ],
        packetTimestampsMicroseconds: [ ...PACKET_TIMESTAMPS_MICROSECONDS ] as Microseconds[],
        ...overrides
    };
}

function createPCMSample(overrides: Partial<AudioDecodeWorkerPCMSample> = {}): AudioDecodeWorkerPCMSample {
    return {
        channelCount: STEREO_CHANNEL_COUNT,
        channelData: [ new Float32Array(FRAME_COUNT), new Float32Array(FRAME_COUNT) ],
        frameCount: FRAME_COUNT,
        mediaTimeMicroseconds: START_TIME_MICROSECONDS,
        sampleRate: SAMPLE_RATE,
        ...overrides
    };
}

function createInputRequest(batch: unknown): unknown {
    return { ...ATTEMPT_KEY, batch, type: 'input' };
}

function createPCMInputRequest(sample: AudioDecodeWorkerPCMSample): unknown {
    return createInputRequest({ kind: 'pcm', samples: [ sample ] });
}

function createAttachment(port: MessagePort): DecodeWorkerAudioOutputAttachment {
    return {
        audioSampleCredits: AUDIO_SAMPLE_CREDITS,
        channelCount: STEREO_CHANNEL_COUNT,
        maximumBufferedFrameCount: MAXIMUM_BUFFERED_FRAME_COUNT,
        port,
        sampleRate: SAMPLE_RATE,
        workletGeneration: WORKLET_GENERATION
    };
}

function createOpenRequest(overrides: Record<string, unknown> = {}): AudioDecodeWorkerOpenAttemptRequest {
    return {
        ...ATTEMPT_KEY,
        audioDownmixAlgorithm: DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
        audioDownmixSettings: createDefaultAudioDownmixSettings(),
        audioOutput: null,
        channelMask: null,
        decoderBackend: 'pcm',
        outputChannelCount: STEREO_CHANNEL_COUNT,
        packageDecoder: null,
        routeCodec: ROUTE_CODEC,
        sourceSampleRate: SAMPLE_RATE,
        startTimeMicroseconds: START_TIME_MICROSECONDS,
        timeResolution: MATROSKA_TIME_RESOLUTION,
        type: 'open-attempt',
        ...overrides
    } as AudioDecodeWorkerOpenAttemptRequest;
}

describe('audio decode worker requests', () => {
    it('accepts every request the decode worker sends', () => {
        const channel = new MessageChannel();
        try {
            expect(isAudioDecodeWorkerRequest(createOpenRequest())).toBe(true);
            expect(isAudioDecodeWorkerRequest(createOpenRequest({
                audioOutput: createAttachment(channel.port1),
                decoderBackend: 'pcm'
            }))).toBe(true);
            expect(isAudioDecodeWorkerRequest({
                ...ATTEMPT_KEY,
                audioOutput: createAttachment(channel.port2),
                type: 'attach-output'
            })).toBe(true);
            expect(isAudioDecodeWorkerRequest(createInputRequest(createPacketBatch()))).toBe(true);
            expect(isAudioDecodeWorkerRequest(createPCMInputRequest(createPCMSample()))).toBe(true);
            expect(isAudioDecodeWorkerRequest({ ...ATTEMPT_KEY, type: 'finish-attempt' })).toBe(true);
            expect(isAudioDecodeWorkerRequest({ ...ATTEMPT_KEY, type: 'close-attempt' })).toBe(true);
            expect(isAudioDecodeWorkerRequest({
                audioDownmixSettings: createDefaultAudioDownmixSettings(),
                generation: GENERATION,
                type: 'update-downmix-settings'
            })).toBe(true);
        } finally {
            channel.port1.close();
            channel.port2.close();
        }
    });

    it('rejects an attempt without a valid key, backend, codec, layout, or time resolution', () => {
        expect(isAudioDecodeWorkerRequest(createOpenRequest({ generation: INVALID_GENERATION }))).toBe(false);
        expect(isAudioDecodeWorkerRequest(createOpenRequest({ audioEpoch: INVALID_AUDIO_EPOCH }))).toBe(false);
        for (const decoderBackend of INVALID_DECODER_BACKENDS) {
            expect(isAudioDecodeWorkerRequest(createOpenRequest({ decoderBackend })), decoderBackend).toBe(false);
        }
        expect(isAudioDecodeWorkerRequest(createOpenRequest({ routeCodec: EMPTY_ROUTE_CODEC }))).toBe(false);
        expect(isAudioDecodeWorkerRequest(createOpenRequest({ outputChannelCount: QUAD_OUTPUT_CHANNEL_COUNT }))).toBe(false);
        expect(isAudioDecodeWorkerRequest(createOpenRequest({ timeResolution: INVALID_TIME_RESOLUTION }))).toBe(false);
        expect(isAudioDecodeWorkerRequest({ ...ATTEMPT_KEY, type: UNKNOWN_REQUEST_TYPE })).toBe(false);
    });

    it('accepts an attempt whose declared channel mask the output stage lays out, and no other mask', () => {
        const requestWithoutMask: Record<string, unknown> = { ...createOpenRequest() };
        delete requestWithoutMask.channelMask;

        expect(isAudioDecodeWorkerRequest(createOpenRequest({ channelMask: FIVE_POINT_ONE_BACK_CHANNEL_MASK }))).toBe(true);
        expect(isAudioDecodeWorkerRequest(createOpenRequest({ channelMask: QUAD_CHANNEL_MASK }))).toBe(false);
        expect(isAudioDecodeWorkerRequest(createOpenRequest({ channelMask: 0 }))).toBe(false);
        expect(isAudioDecodeWorkerRequest(requestWithoutMask)).toBe(false);
    });

    it('accepts a package attempt with the package that decodes it', () => {
        expect(isAudioDecodeWorkerRequest(createOpenRequest({
            decoderBackend: PACKAGE_BACKEND,
            packageDecoder: packageSelection,
            routeCodec: PACKAGE_CODEC
        }))).toBe(true);
    });

    it('rejects a package attempt without a valid package, and any other attempt that carries one', () => {
        const packageAttempt = { decoderBackend: PACKAGE_BACKEND, routeCodec: PACKAGE_CODEC };
        const requestWithoutPackageField: Record<string, unknown> = { ...createOpenRequest() };
        delete requestWithoutPackageField.packageDecoder;

        expect(isAudioDecodeWorkerRequest(createOpenRequest({ ...packageAttempt, packageDecoder: null }))).toBe(false);
        expect(isAudioDecodeWorkerRequest(createOpenRequest({
            ...packageAttempt,
            packageDecoder: { ...packageSelection, codec: PACKAGE_UNLISTED_CODEC }
        }))).toBe(false);
        expect(isAudioDecodeWorkerRequest(createOpenRequest({
            ...packageAttempt,
            packageDecoder: { ...packageSelection, source: { ...packageSelection.source, module: null } }
        }))).toBe(false);
        expect(isAudioDecodeWorkerRequest(createOpenRequest({ packageDecoder: packageSelection }))).toBe(false);
        expect(isAudioDecodeWorkerRequest(requestWithoutPackageField)).toBe(false);
    });

    it('accepts an empty packet, which its decoder rejects, but no packet layout outside the batch', () => {
        expect(isAudioDecodeWorkerRequest(createInputRequest(createPacketBatch({
            packetByteLengths: [ EMPTY_PACKET_BYTE_LENGTH, PACKET_BATCH_BYTE_LENGTH ]
        })))).toBe(true);
        expect(isAudioDecodeWorkerRequest(createInputRequest(createPacketBatch({
            packetByteLengths: [ PACKET_BATCH_BYTE_LENGTH, OVERRUN_PACKET_BYTE_LENGTH ]
        })))).toBe(false);
        expect(isAudioDecodeWorkerRequest(createInputRequest(createPacketBatch({
            packetTimestampsMicroseconds: [ START_TIME_MICROSECONDS ]
        })))).toBe(false);
        expect(isAudioDecodeWorkerRequest(createInputRequest(createPacketBatch({
            packetByteLengths: [],
            packetTimestampsMicroseconds: []
        })))).toBe(false);
        const oversizedPacketCount = MAXIMUM_AUDIO_DECODE_WORKER_BATCH_INPUT_COUNT + 1;
        expect(isAudioDecodeWorkerRequest(createInputRequest(createPacketBatch({
            packetByteLengths: new Array<number>(oversizedPacketCount).fill(EMPTY_PACKET_BYTE_LENGTH),
            packetTimestampsMicroseconds: new Array<Microseconds>(oversizedPacketCount).fill(START_TIME_MICROSECONDS)
        })))).toBe(false);
    });

    it('accepts a sample before the start with its format alone, and no plane that misfits its sample', () => {
        expect(isAudioDecodeWorkerRequest(createPCMInputRequest(createPCMSample({
            channelData: [],
            frameCount: EMPTY_FRAME_COUNT
        })))).toBe(true);
        expect(isAudioDecodeWorkerRequest(createPCMInputRequest(createPCMSample({
            channelData: [ new Float32Array(FRAME_COUNT), new Float32Array(FRAME_COUNT - 1) ]
        })))).toBe(false);
        expect(isAudioDecodeWorkerRequest(createPCMInputRequest(createPCMSample({
            channelData: [ new Float32Array(FRAME_COUNT) ]
        })))).toBe(false);
        // A shared buffer cannot be transferred, and the page is not cross-origin isolated anyway
        expect(isAudioDecodeWorkerRequest(createPCMInputRequest(createPCMSample({
            channelData: [
                new Float32Array(new SharedArrayBuffer(FRAME_COUNT * Float32Array.BYTES_PER_ELEMENT)),
                new Float32Array(FRAME_COUNT)
            ]
        })))).toBe(false);
        expect(isAudioDecodeWorkerRequest(createInputRequest({ kind: 'pcm', samples: [] }))).toBe(false);
    });
});

describe('audio decode worker responses', () => {
    it('accepts every response the audio decode worker sends', () => {
        expect(isAudioDecodeWorkerResponse({ ...ATTEMPT_KEY, inputCredits: ONE_INPUT_CREDIT, type: 'input-credit' })).toBe(true);
        expect(isAudioDecodeWorkerResponse({
            ...ATTEMPT_KEY,
            durationMicroseconds: PROGRESS_DURATION_MICROSECONDS,
            frameCount: FRAME_COUNT,
            mediaTimeMicroseconds: START_TIME_MICROSECONDS,
            sampleRate: SAMPLE_RATE,
            type: 'progress'
        })).toBe(true);
        expect(isAudioDecodeWorkerResponse({
            ...ATTEMPT_KEY,
            channelCount: STEREO_CHANNEL_COUNT,
            sampleRate: SAMPLE_RATE,
            type: 'source-format'
        })).toBe(true);
        expect(isAudioDecodeWorkerResponse({ ...ATTEMPT_KEY, type: 'attempt-finished' })).toBe(true);
        expect(isAudioDecodeWorkerResponse({
            ...ATTEMPT_KEY,
            failureKind: 'audio-output-failed',
            message: FAILURE_MESSAGE,
            type: 'attempt-failed'
        })).toBe(true);
        expect(isAudioDecodeWorkerResponse({ ...ATTEMPT_KEY, type: 'attempt-closed' })).toBe(true);
    });

    it('rejects credits beyond the window, empty progress, and unbounded or unknown failures', () => {
        expect(isAudioDecodeWorkerResponse({
            ...ATTEMPT_KEY,
            inputCredits: AUDIO_DECODE_WORKER_INPUT_CREDITS + 1,
            type: 'input-credit'
        })).toBe(false);
        expect(isAudioDecodeWorkerResponse({
            ...ATTEMPT_KEY,
            durationMicroseconds: PROGRESS_DURATION_MICROSECONDS,
            frameCount: EMPTY_FRAME_COUNT,
            mediaTimeMicroseconds: START_TIME_MICROSECONDS,
            sampleRate: SAMPLE_RATE,
            type: 'progress'
        })).toBe(false);
        expect(isAudioDecodeWorkerResponse({
            ...ATTEMPT_KEY,
            failureKind: 'decode-failed',
            message: OVERLONG_FAILURE_MESSAGE,
            type: 'attempt-failed'
        })).toBe(false);
        expect(isAudioDecodeWorkerResponse({
            ...ATTEMPT_KEY,
            failureKind: UNKNOWN_FAILURE_KIND,
            message: FAILURE_MESSAGE,
            type: 'attempt-failed'
        })).toBe(false);
        expect(isAudioDecodeWorkerResponse({ generation: GENERATION, type: 'attempt-closed' })).toBe(false);
    });
});

describe('audio decode worker input transfers', () => {
    it('transfers a packet batch\'s buffer, and each plane buffer of a sample batch once', () => {
        const packetBatch = createPacketBatch();
        expect(getAudioDecodeWorkerInputTransferList(packetBatch)).toEqual([ packetBatch.data ]);

        const twoPlaneBuffer = new ArrayBuffer(FRAME_COUNT * Float32Array.BYTES_PER_ELEMENT * STEREO_CHANNEL_COUNT);
        const leftPlane = new Float32Array(twoPlaneBuffer, 0, FRAME_COUNT);
        const rightPlane = new Float32Array(twoPlaneBuffer, FRAME_COUNT * Float32Array.BYTES_PER_ELEMENT, FRAME_COUNT);
        const ownPlaneSample = createPCMSample();
        const pcmBatch: AudioDecodeWorkerPCMBatch = {
            kind: 'pcm',
            samples: [ createPCMSample({ channelData: [ leftPlane, rightPlane ] }), ownPlaneSample ]
        };
        expect(getAudioDecodeWorkerInputTransferList(pcmBatch)).toEqual([
            twoPlaneBuffer,
            ownPlaneSample.channelData[0].buffer,
            ownPlaneSample.channelData[1].buffer
        ]);
    });
});
