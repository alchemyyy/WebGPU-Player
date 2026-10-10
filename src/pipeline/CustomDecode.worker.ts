/* eslint-disable no-restricted-globals */
import {
    AudioSampleSink,
    EncodedPacketSink,
    Input,
    UrlSource,
    VideoSampleSink,
    type AudioSample,
    type AudioCodec,
    type EncodedPacket,
    type InputAudioTrack,
    type InputVideoTrack,
    type VideoCodec,
    type VideoSample
} from 'mediabunny';

import { microsecondsToSeconds, secondsToMicroseconds, type Microseconds } from '../MediaTime';
import { getDolbyVisionEnhancementDimensions } from '../video/dolby-vision/DolbyVisionGeometry';
import { isDolbyVisionDualLayerProfile } from '../video/dolby-vision/DolbyVisionProfiles';
import { getAudioSampleWindow } from '../audio/AudioSampleWindow';
import { settleConcurrentDecodeStreams } from './ConcurrentDecodeStreams';
import { CUSTOM_DECODE_INPUT_FORMATS } from './CustomDecodeInputFormats';
import {
    recordTimingEvent,
    recordTimingWait,
    startTimingWait,
    startWorkerTimingTrace,
    stopWorkerTimingTrace
} from '../TimingTrace';
import { markHandledDecodeFailure, suppressHandledDecodeFailureRejections } from './HandledDecodeFailures';
import { registerRequiredCustomAudioDecoder } from '../audio/decoders/CustomAudioDecoderRegistration';
import {
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
    type CustomAudioDownmixAlgorithm
} from '../audio/processing/CustomAudioDownmixAlgorithm';
import {
    getCustomAudioChannelLayout,
    type CustomAudioChannelLayout,
    type CustomAudioOutputChannelCount
} from '../audio/processing/CustomAudioChannelLayout';
import {
    createDefaultAudioDownmixSettings,
    type AudioDownmixSettings
} from '../audio/processing/CustomAudioDownmix';
import {
    CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT,
    CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE,
    isSupportedCustomAudioInputLayout
} from '../audio/CustomAudioOutputPolicy';
import { isSupportedCustomAudioSampleRate } from '../audio/CustomAudioSampleRate';
import {
    DTS_SEEK_PREROLL_MICROSECONDS,
    getAudioPrerollTimeMicroseconds,
    getAudioStartPacket,
    TRUEHD_MAJOR_SYNC_PREROLL_MICROSECONDS
} from '../audio/AudioStartPacket';
import {
    getBundledAudioDecoderCodec,
    getDeclaredAudioSampleRate
} from '../audio/CustomAudioTrackMetadata';
import { createEngineWorker, type EngineWorkerPath } from '../EngineAssets';
import AudioDecodeWorkerClient, {
    AudioDecodeWorkerAttemptError,
    AudioDecodeWorkerPacketBatchBuilder,
    AudioDecodeWorkerPCMBatchBuilder,
    type AudioDecodeWorkerAttempt
} from './AudioDecodeWorkerClient';
import type {
    AudioDecodeWorkerDecoderBackend,
    AudioDecodeWorkerPCMSample,
    AudioDecodeWorkerProgressResponse,
    AudioDecodeWorkerSourceFormatResponse
} from './AudioDecodeWorkerProtocol';
import {
    getCustomDecodeRequestHardwareAcceleration,
    isDecodeWorkerRequest,
    MAX_DECODED_AUDIO_CHANNELS,
    MAX_DECODED_AUDIO_SAMPLE_CREDITS,
    MAX_DECODED_FRAME_CREDITS,
    MAX_DECODED_RAW_FRAME_CREDITS,
    MAXIMUM_VIDEO_STARTUP_PROGRESS_PACKET_COUNT,
    type CustomDecodeAudioOutputMode,
    type CustomDecodeDolbyVisionProfile,
    type CustomDecodeFailureKind,
    type CustomDecodeNativeHDRTransfer,
    type CustomDecodeRawVideoFrameFormat,
    type CustomDecodeVideoDecoderBackend,
    type CustomDecodeVideoOutputMode,
    type CustomDecodeWorkerProgressPhase,
    type DecodeWorkerAudioOutputAttachment,
    type DecodeWorkerNativeMediaAudioConfiguration,
    type DecodeWorkerReadyAudioConfiguration,
    type DecodeWorkerRequest,
    type DecodeWorkerResponse
} from './DecodeWorkerProtocol';
import { getTrackByOrdinal } from './CustomDecodeTrackSelection';
import {
    DecodedVideoGeometryError,
    exceedsNegotiatedCodedSize,
    requireConsistentDecodedVideoGeometry
} from '../video/DecodedVideoGeometry';
import DolbyVisionEncodedMetadataQueue, {
    getHEVCNALFormat,
    type ProcessedDolbyVisionHEVCPacket
} from '../video/dolby-vision/DolbyVisionEncodedMetadata';
import DolbyVisionEncodedPacketPairer from '../video/dolby-vision/DolbyVisionEncodedPacketPairer';
import {
    splitDolbyVisionHEVCAccessUnit,
    type HEVCNALFormat
} from '../video/dolby-vision/DolbyVisionHEVCSplitter';
import {
    getDolbyVisionEncodedMetadataTransferList,
    takeTransferableDolbyVisionEncodedFrameMetadata,
    type DolbyVisionEncodedFrameMetadata
} from '../video/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import { DolbyVisionRPUParseError } from '../video/dolby-vision/DolbyVisionRPUParser';
import DolbyVisionRPUParserSession from '../video/dolby-vision/DolbyVisionRPUParserSession';
import {
    createOwnedHEVCSoftwareVideoDecoder,
    hasRequiredHEVCParameterSets,
    parseHEVCDecoderConfiguration,
    registerHEVCSoftwareVideoDecoder,
    waitForHEVCSoftwareVideoDecoderShutdown,
    type HEVCSoftwareDecodedFrame
} from '../video/decoders/HEVCSoftwareVideoDecoder';
import {
    HEVCVideoFrameWriter,
    writeHEVCDecodedFrame,
    type HEVCFrameOutput
} from '../video/decoders/HEVCFrameOutput';
import { parseHEVCSPS } from '../video/hevc/HEVCSPSParser';
import { scanHEVCStaticHDRMetadata } from '../video/hdr/HEVCStaticHDRMetadata';
import {
    hasAV1PQSequenceHeader,
    scanAV1StaticHDRMetadata
} from '../video/hdr/AV1StaticHDRMetadata';
import HEVCDynamicHDRMetadataQueue from '../video/hdr/HEVCDynamicHDRMetadataQueue';
import type { HDR10PlusFrameMetadata } from '../video/hdr/HDR10PlusMetadata';
import {
    requireValidByteRangeResponse,
    UnsupportedRangeResponseError
} from './HTTPRangeResponse';
import {
    isRetryableMediaFetchError,
    MediaNetworkError,
    requireSuccessfulMediaHTTPResponse
} from './MediaFetchPolicy';
import RawFrameBufferPool, { MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH } from '../video/RawFrameBufferPool';
import {
    copyVideoFramePairToRawPlanes,
    copyVideoFrameToRawPlanes,
    createVideoSampleRawFrameSource,
    getRawVideoFramePairTransferList,
    getRawVideoFrameTransferList,
    PreparedRawVideoFrameSource,
    type RawVideoFrameGeometry,
    type RawVideoFrameSource
} from '../video/RawVideoFrameCopy';
import { requireMicroseconds } from '../TimeMath';
import NativeMediaAudioFMP4Remuxer, {
    type NativeMediaAudioFMP4Codec,
    type NativeMediaAudioFMP4RemuxOutput
} from '../audio/native/NativeMediaAudioFMP4Remuxer';
import OwnedNativeHEVCVideoDecoder from '../video/decoders/OwnedNativeHEVCVideoDecoder';
import OwnedNativeVideoDecoder from '../video/decoders/OwnedNativeVideoDecoder';
import { runOwnedAV1VideoStream } from '../video/decoders/OwnedAV1VideoStream';
import { runOwnedVP9VideoStream } from '../video/decoders/OwnedVP9VideoStream';
import {
    closeOwnedDecodedVideoOutput,
    createOwnedVideoFrameMetadataSource,
    getOwnedDecodedVideoTiming,
    OwnedVideoStreamState,
    pumpOwnedVideoFrames,
    readNextVideoPacket,
    type OwnedDecodedVideoOutput,
    type OwnedDecodedVideoSource,
    type OwnedVideoDecoderCallbacks,
    type OwnedVideoDecoderPort,
    type OwnedVideoPacketIterator,
    type OwnedVideoStreamRun
} from '../video/decoders/OwnedVideoDecodeStream';
import { assignAV1SequenceHeaderCodecString } from '../video/av1/AV1DecoderConfiguration';
import { readISOBaseMediaDolbyVisionTrackConfiguration } from '../video/dolby-vision/ISOBaseMediaDolbyVisionConfiguration';
import { assignISOBaseMediaDolbyVisionSampleEntryCodec } from '../video/dolby-vision/ISOBaseMediaDolbyVisionSampleEntry';
import {
    readMatroskaDolbyVisionTrackConfiguration
} from '../video/dolby-vision/MatroskaDolbyVisionHVCE';
import {
    readMPEGTransportStreamDolbyVisionTrackConfiguration
} from '../video/dolby-vision/MPEGTransportStreamDolbyVisionConfiguration';
import JPEG2000SoftwareVideoDecoder from '../video/decoders/JPEG2000SoftwareVideoDecoder';
import type { TrueHDDecoderCodec } from '../audio/decoders/TrueHDSoftwareAudioDecoder';
import MPEG2VC1SoftwareVideoDecoder, {
    type MPEG2VC1SoftwareVideoDecoderConfiguration
} from '../video/decoders/MPEG2VC1SoftwareVideoDecoder';
import { getMatroskaVC1DecoderDescription } from '../video/MatroskaVFWVideoConfiguration';
import {
    createMatroskaBlockAdditionReader,
    withMatroskaBlockAdditions,
    type MatroskaBlockAddition
} from '../video/MatroskaBlockAdditions';
import {
    MAXIMUM_STATIC_HDR_METADATA_SCAN_ACCESS_UNIT_COUNT,
    type StaticHDRMetadataScanResult
} from '../video/hdr/StaticHDRMetadata';

const URL_SOURCE_CACHE_BYTES = 32 * 1024 * 1024;
const URL_SOURCE_PARALLELISM = 2;
const MAX_NETWORK_RETRY_ATTEMPTS = 2;
const NETWORK_RETRY_BASE_SECONDS = 0.25;
const OWNED_VIDEO_DECODER_QUEUE_HIGH_WATER_MARK = 16;
const DOLBY_VISION_ENHANCEMENT_CODEC = 'hev1.2.4.L153.B0';
const ANNEX_B_HEVC_NAL_FORMAT: HEVCNALFormat = { kind: 'annex-b' };
const OWNED_HEVC_PACKET_OPTIONS = {
    metadataOnly: false,
    verifyKeyPackets: true
} as const;
const OWNED_NATIVE_PACKET_OPTIONS = {
    metadataOnly: false,
    verifyKeyPackets: true
} as const;
const STATIC_HDR_METADATA_PACKET_OPTIONS = { metadataOnly: false } as const;
const OPENJPEG_PACKET_OPTIONS = { metadataOnly: false } as const;
const MPEG2_VC1_PACKET_OPTIONS = {
    metadataOnly: false,
    verifyKeyPackets: true
} as const;
const STATIC_HDR_METADATA_SCAN_MAXIMUM_BYTE_LENGTH = 8 * 1024 * 1024;
// Mediabunny's dec3 parse can declare a 7.1 E-AC-3 track as 6 or 7 channels
const EAC3_UNDER_DECLARED_SEVEN_POINT_ONE_CHANNEL_COUNT = 7;
const AUDIO_DECODE_WORKER_ASSET: EngineWorkerPath = 'webgpu-player/CustomAudioDecode.worker.js';
const ENCODED_AUDIO_PACKET_TIMESTAMP = 'Encoded audio packet timestamp';

type MediaSampleIterator<Sample> = {
    next: () => Promise<IteratorResult<Sample>>
    return?: () => Promise<IteratorResult<Sample>>
};

type VideoAttemptControl =
    | {
        kind: 'resync'
        targetTimeMicroseconds: Microseconds
        videoEpoch: number
    }
    | {
        kind: 'suspend'
        videoEpoch: number
    };

/** Restarts decoded audio at a target with a new output stage while video continues */
type AudioAttemptControl = {
    audioDownmixAlgorithm: CustomAudioDownmixAlgorithm | undefined
    /** A later live update replaces it, since the attempt opens with the newest gains */
    audioDownmixSettings: AudioDownmixSettings | undefined
    audioEpoch: number
    /** The new worklet's channel, whose credit window replaces the old one */
    audioOutput: DecodeWorkerAudioOutputAttachment
    decodedAudioOutputChannelCount: CustomAudioOutputChannelCount
    targetTimeMicroseconds: Microseconds
};

type DecodeRun = {
    /** Ends the current audio attempt without stopping video or the run */
    audioAttemptCancelled: boolean
    /** The current decoded PCM attempt in the audio decode worker, which feeds the worklet over its own channel */
    audioDecodeAttempt: AudioDecodeWorkerAttempt | null
    /** Settle once the audio decode worker released each closed attempt's decoder, output stage, and worklet channel */
    audioDecodeAttemptClosures: Array<Promise<void>>
    /** Tags posted audio so the session can drop samples from replaced attempts */
    audioEpoch: number
    audioIterator: MediaSampleIterator<AudioSample> | MediaSampleIterator<EncodedPacket> | null
    /** Whether the current decoded PCM attempt has its worklet channel */
    audioOutputAttached: boolean
    /** Native media segment credits from the page; decoded PCM takes the audio decode worker's input credits */
    audioSampleCredits: number
    /** Set once the audio stream completes so a video stream that reached its end can end the run */
    audioStreamFinished: boolean
    cancelled: boolean
    decodedVideoGeometry: RawVideoFrameGeometry | null
    enhancementPacketPairer: DolbyVisionEncodedPacketPairer | null
    frameCredits: number
    generation: number
    input: Input | null
    iteratorRetirementPromise: Promise<void> | null
    /** The newest downmix gains: the start's, then each resync's or live update's; every attempt opens with them */
    latestAudioDownmixSettings: AudioDownmixSettings | undefined
    maximumCodedHeight: number
    maximumCodedWidth: number
    metadataAbortController: AbortController | null
    nativeHDRTransfer: CustomDecodeNativeHDRTransfer
    neutralizeHDRColorMetadata: boolean
    outstandingRawFrameBufferCount: number
    /** Latest unprocessed resync request for the decoded audio stream */
    pendingAudioControl: AudioAttemptControl | null
    /** A channel to the worklet that the next decoded PCM attempt opens with: a resync's, or the initial one before its attempt opened */
    pendingAudioOutput: DecodeWorkerAudioOutputAttachment | null
    /** Latest unprocessed resync or suspension request for the video stream */
    pendingVideoControl: VideoAttemptControl | null
    rawFrameBufferPool: RawFrameBufferPool | null
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    /** Ends the current video attempt without stopping audio or the run */
    videoAttemptCancelled: boolean
    videoAttemptConsumedCreditCount: number
    videoAttemptPostedFrameCount: number
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
    /** Tags posted frames so the session can drop frames from replaced attempts */
    videoEpoch: number
    videoOutputMode: CustomDecodeVideoOutputMode
    videoIterator: MediaSampleIterator<EncodedPacket> | MediaSampleIterator<VideoSample> | null
    /** Set once the video stream unwinds so finished audio stops waiting for a resync */
    videoStreamFinished: boolean
    /** The latest video attempt reached the end of its track; a suspended or interrupted one did not */
    videoTrackEnded: boolean
    wakeAudioControlWaiters: Array<() => void>
    wakeAudioCreditWaiters: Array<() => void>
    wakeFrameCreditWaiters: Array<() => void>
    wakeVideoControlWaiters: Array<() => void>
    wakeVideoDecodeWaiters: Array<() => void>
};

type PreparedVideoTrack = {
    availableVideoTracks: readonly InputVideoTrack[]
    codec: VideoCodec | 'jpeg2000' | 'mpeg2video' | 'vc1'
    containerTrackNumber: number
    decoderConfig: VideoDecoderConfig
    geometry: RawVideoFrameGeometry
    staticHDRMetadataScan?: StaticHDRMetadataScanResult
    /** The native decoder hint the route's capability probes measured for this codec */
    videoHardwareAcceleration: HardwareAcceleration
    videoTrack: InputVideoTrack
};

type DolbyVisionEnhancementDecoderConfiguration = {
    decoderConfig: VideoDecoderConfig
    geometry: RawVideoFrameGeometry
    packetFormat: HEVCNALFormat
    source: {
        kind: 'interleaved'
    } | {
        kind: 'separate-track'
        videoTrack: InputVideoTrack
    }
};

type SeparateDolbyVisionEnhancementPacketStream = {
    inputFormat: HEVCNALFormat
    pairer: DolbyVisionEncodedPacketPairer
};

type ContainerDolbyVisionTrackConfiguration = {
    enhancementConfiguration: Uint8Array | null
    separateEnhancement: {
        decoderDescription: Uint8Array | null
        trackNumber: number
    } | null
};

type PreparedAudioTrack = {
    audioConfiguration: DecodeWorkerReadyAudioConfiguration
    audioTrack: InputAudioTrack
    decoderBackend: 'dts' | 'eac3' | 'mediabunny' | TrueHDDecoderCodec
    decoderConfig: AudioDecoderConfig | null
    /** Declared by the container; the decoded layout is authoritative */
    inputChannelCount: number
    inputChannelLayout: CustomAudioChannelLayout
    outputMode: CustomDecodeAudioOutputMode
    outputChannelCount: CustomAudioOutputChannelCount
    /** The codec name the decoded PCM route tables qualify */
    routeCodec: string
    /** Declared by the container; the decoded rate is authoritative */
    sourceSampleRate: number
    /** All packet timestamps are integer multiples of its reciprocal */
    timeResolution: number
};

type SelectedAudioTrackMetadata = {
    audioTrack: InputAudioTrack
    channelCount: number
    codec: AudioCodec | null
    decoderConfig: AudioDecoderConfig | null
    inputChannelLayout: CustomAudioChannelLayout
    isDTS: boolean
    sampleRate: number
    timeResolution: number
    trueHDDecoderCodec: TrueHDDecoderCodec | null
};

type WorkerScope = {
    addEventListener: (type: 'message', listener: (event: MessageEvent<unknown>) => void) => void
    postMessage: (message: DecodeWorkerResponse, transfer?: Transferable[]) => void
};

class UnsupportedCustomDecodeSourceError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'UnsupportedCustomDecodeSourceError';
    }
}

const workerScope = self as unknown as WorkerScope;
// The run that control requests address; a run replaced here still unwinds before the next one starts
let currentRun: DecodeRun | null = null;
// Settles once the latest run has posted `stopped`, so runs never overlap in this worker
let previousRunCompletion: Promise<void> = Promise.resolve();
// Mediabunny never closes a custom decoder whose call failed, so a worker that suppressed such a failure asks to be replaced
let unclosedDecoderSuspected = false;
// The audio decode worker this worker spawns for its first decoded PCM run and keeps for every later one; a lost one asks for this worker's replacement
let audioDecodeWorkerClient: AudioDecodeWorkerClient | null = null;

function postResponse(response: DecodeWorkerResponse, transfer?: Transferable[]): void {
    workerScope.postMessage(response, transfer);
}

function postVideoStartupProgress(
    run: DecodeRun,
    phase: CustomDecodeWorkerProgressPhase,
    packetCount: number,
    mediaTimeMicroseconds: Microseconds | null
): void {
    // Startup progress describes only the initial attempt, not later video resyncs
    if (isVideoAttemptStopped(run) || run.videoEpoch !== 0 || packetCount > MAXIMUM_VIDEO_STARTUP_PROGRESS_PACKET_COUNT) {
        return;
    }
    postResponse({
        generation: run.generation,
        mediaTimeMicroseconds,
        packetCount,
        phase,
        type: 'progress'
    });
}

/** Creates a raw route's pool of spare buffers, which the decoders' drain-time frames and the raw copies take from, and recycled buffers return to. */
function createRawFrameBufferPool(videoOutputMode: CustomDecodeVideoOutputMode): RawFrameBufferPool | null {
    switch (videoOutputMode) {
        case 'raw-planes':
            return new RawFrameBufferPool(MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH);
        case 'video-frame':
            return null;
    }
}

function getRetryDelay(previousAttempts: number, error: unknown): number | null {
    if (error instanceof UnsupportedRangeResponseError || !isRetryableMediaFetchError(error)) {
        return null;
    }
    if (previousAttempts > MAX_NETWORK_RETRY_ATTEMPTS) {
        return null;
    }

    return NETWORK_RETRY_BASE_SECONDS * (2 ** (previousAttempts - 1));
}

const validatedRangeFetch: typeof fetch = async (input: RequestInfo | URL, requestInit?: RequestInit): Promise<Response> => {
    const requestHeaders = requestInit?.headers === undefined && input instanceof Request ?
        input.headers :
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        new Headers(requestInit?.headers);
    let response: Response;
    const fetchStartedAt = startTimingWait();
    try {
        response = await fetch(input, requestInit);
        if (fetchStartedAt !== null) {
            recordTimingWait('fetch', fetchStartedAt, {
                range: requestHeaders.get('Range'),
                status: response.status
            });
        }
    } catch (error) {
        const requestURL = input instanceof Request ? input.url : String(input);
        let requestPath = '[media path]';
        try {
            requestPath = new URL(requestURL).pathname;
        } catch {
            // Preserve a token-safe placeholder for malformed request URLs
        }
        const requestMethod = requestInit?.method ?? (input instanceof Request ? input.method : 'GET');
        const rangeHeader = requestHeaders.get('Range');
        const requestDescription = rangeHeader ? `${requestMethod} ${requestPath} (${rangeHeader})` : `${requestMethod} ${requestPath}`;
        throw new MediaNetworkError(`${requestDescription}: ${getSafeErrorMessage(error)}`);
    }
    requireSuccessfulMediaHTTPResponse(response);
    requireValidByteRangeResponse(requestHeaders.get('Range'), response);
    return response;
};

function wakeWaiters(waiters: Array<() => void>): void {
    const activeWaiters = waiters.splice(0);
    for (const waiter of activeWaiters) {
        waiter();
    }
}

function addFrameCredits(run: DecodeRun, frameCredits: number): void {
    const maximumFrameCredits = run.videoOutputMode === 'raw-planes' ? MAX_DECODED_RAW_FRAME_CREDITS : MAX_DECODED_FRAME_CREDITS;
    run.frameCredits = Math.min(maximumFrameCredits, run.frameCredits + frameCredits);
    wakeWaiters(run.wakeFrameCreditWaiters);
}

function addAudioSampleCredits(run: DecodeRun, audioSampleCredits: number): void {
    run.audioSampleCredits = Math.min(MAX_DECODED_AUDIO_SAMPLE_CREDITS, run.audioSampleCredits + audioSampleCredits);
    wakeWaiters(run.wakeAudioCreditWaiters);
}

/** Returns whether the run or only its current video attempt must unwind. */
function isVideoAttemptStopped(run: DecodeRun): boolean {
    return run.cancelled || run.videoAttemptCancelled;
}

async function waitForFrameCredit(run: DecodeRun): Promise<boolean> {
    // Only a decode loop held back by the page's frame credits records a wait
    const waitStartedAt = run.frameCredits === 0 ? startTimingWait() : null;
    while (!isVideoAttemptStopped(run) && run.frameCredits === 0) {
        await new Promise<void>(resolve => {
            run.wakeFrameCreditWaiters.push(resolve);
        });
    }
    recordTimingWait('video-credit-wait', waitStartedAt);

    if (isVideoAttemptStopped(run)) {
        return false;
    }

    run.frameCredits -= 1;
    run.videoAttemptConsumedCreditCount += 1;
    return true;
}

/** Counts a posted frame against the credits its video attempt consumed. */
function recordVideoAttemptFramePosted(run: DecodeRun, mediaTimeMicroseconds: Microseconds): void {
    run.videoAttemptPostedFrameCount += 1;
    recordTimingEvent('video-frame-output', { mediaTimeMicroseconds });
}

/** Restores credits an unwinding video attempt consumed without posting a frame. */
function refundVideoAttemptCredits(run: DecodeRun): void {
    const unpostedCreditCount = run.videoAttemptConsumedCreditCount - run.videoAttemptPostedFrameCount;
    run.videoAttemptConsumedCreditCount = 0;
    run.videoAttemptPostedFrameCount = 0;
    if (unpostedCreditCount > 0 && !run.cancelled) {
        addFrameCredits(run, unpostedCreditCount);
    }
}

/** Stores the newest video control request and unwinds the active video attempt. */
function requestVideoAttemptControl(run: DecodeRun, control: VideoAttemptControl): void {
    const latestVideoEpoch = run.pendingVideoControl?.videoEpoch ?? run.videoEpoch;
    if (run.cancelled || control.videoEpoch <= latestVideoEpoch) {
        return;
    }

    run.pendingVideoControl = control;
    run.videoAttemptCancelled = true;
    wakeWaiters(run.wakeFrameCreditWaiters);
    wakeWaiters(run.wakeVideoDecodeWaiters);
    wakeWaiters(run.wakeVideoControlWaiters);
}

/**
 * Waits for the resync that starts the next video attempt.
 * Returns null when the run stops, or when audio has finished after the video track ended.
 * A suspended or interrupted video still has frames left, so it waits for its resync even after audio finished.
 */
async function waitForVideoAttemptResync(run: DecodeRun): Promise<Extract<VideoAttemptControl, { kind: 'resync' }> | null> {
    while (!run.cancelled) {
        const control = run.pendingVideoControl;
        if (control) {
            run.pendingVideoControl = null;
            run.videoEpoch = control.videoEpoch;
            if (control.kind === 'resync') {
                return control;
            }
            continue;
        }
        if (run.audioStreamFinished && run.videoTrackEnded) {
            return null;
        }
        await new Promise<void>(resolve => {
            run.wakeVideoControlWaiters.push(resolve);
        });
    }
    return null;
}

/** Recognizes the WebCodecs error delivered when the browser reclaims an idle codec. */
function isCodecReclamationError(error: unknown): boolean {
    return error instanceof Error && error.name === 'QuotaExceededError';
}

async function retireVideoAttemptIterators(run: DecodeRun): Promise<void> {
    const videoIterator = run.videoIterator;
    const enhancementPacketPairer = run.enhancementPacketPairer;
    run.videoIterator = null;
    run.enhancementPacketPairer = null;
    await retireIterator(videoIterator);
    await enhancementPacketPairer?.retire();
}

/** Returns whether the run or only its current audio attempt must unwind. */
function isAudioAttemptStopped(run: DecodeRun): boolean {
    return run.cancelled || run.audioAttemptCancelled;
}

/** Takes one native media segment credit, waiting until the page returns one. */
async function waitForAudioSampleCredit(run: DecodeRun): Promise<boolean> {
    while (!isAudioAttemptStopped(run)) {
        if (run.audioSampleCredits > 0) {
            run.audioSampleCredits -= 1;
            return true;
        }
        await new Promise<void>(resolve => {
            run.wakeAudioCreditWaiters.push(resolve);
        });
    }
    return false;
}

/** Throws the failure the audio decode worker reported for an attempt, as the failure kind it chose. */
function requireHealthyAudioDecodeAttempt(attempt: AudioDecodeWorkerAttempt): void {
    const failure = attempt.failure;
    if (failure) {
        throw new AudioDecodeWorkerAttemptError(failure);
    }
}

/** Takes one input credit of a decoded PCM attempt, waiting until the audio decode worker rendered a batch; its failure fails the attempt here. */
async function waitForAudioDecodeInputCredit(run: DecodeRun, attempt: AudioDecodeWorkerAttempt): Promise<boolean> {
    while (!isAudioAttemptStopped(run)) {
        requireHealthyAudioDecodeAttempt(attempt);
        if (attempt.takeInputCredit()) {
            return true;
        }
        await new Promise<void>(resolve => {
            run.wakeAudioCreditWaiters.push(resolve);
        });
    }
    return false;
}

/** Waits until the audio decode worker rendered a finished attempt's tails, or the attempt stops. */
async function waitForAudioDecodeAttemptFinished(run: DecodeRun, attempt: AudioDecodeWorkerAttempt): Promise<void> {
    while (!isAudioAttemptStopped(run)) {
        requireHealthyAudioDecodeAttempt(attempt);
        if (attempt.finished) {
            return;
        }
        await new Promise<void>(resolve => {
            run.wakeAudioCreditWaiters.push(resolve);
        });
    }
}

/**
 * Closes the current decoded PCM attempt, whose worklet channel closes at once; the worklet drops whatever was still in flight on it.
 * The run's end waits until the audio decode worker released the attempt.
 */
function closeAudioDecodeAttempt(run: DecodeRun): void {
    const attempt = run.audioDecodeAttempt;
    run.audioDecodeAttempt = null;
    run.audioOutputAttached = false;
    if (attempt) {
        run.audioDecodeAttemptClosures.push(attempt.close());
    }
}

/**
 * Stores the newest audio resync request and unwinds the active audio attempt; a channel that no attempt will open is closed.
 * The replaced attempt stops feeding its worklet channel at once, since the page flushed that worklet.
 */
function requestAudioAttemptControl(run: DecodeRun, control: AudioAttemptControl): void {
    const latestAudioEpoch = run.pendingAudioControl?.audioEpoch ?? run.audioEpoch;
    if (run.cancelled || control.audioEpoch <= latestAudioEpoch) {
        control.audioOutput.port.close();
        return;
    }

    run.pendingAudioControl?.audioOutput.port.close();
    run.pendingAudioOutput?.port.close();
    run.pendingAudioOutput = null;
    run.pendingAudioControl = control;
    run.audioAttemptCancelled = true;
    closeAudioDecodeAttempt(run);
    wakeWaiters(run.wakeAudioCreditWaiters);
    wakeWaiters(run.wakeAudioControlWaiters);
}

/**
 * Waits after the audio track ends until a resync is pending.
 * Returns false when the run stops, or when audio and video have both finished.
 */
async function waitForAudioAttemptResync(run: DecodeRun): Promise<boolean> {
    while (!run.cancelled) {
        if (run.pendingAudioControl) {
            return true;
        }
        if (run.audioStreamFinished && run.videoStreamFinished) {
            return false;
        }
        await new Promise<void>(resolve => {
            run.wakeAudioControlWaiters.push(resolve);
        });
    }
    return false;
}

async function retireAudioAttemptIterator(run: DecodeRun): Promise<void> {
    const audioIterator = run.audioIterator;
    run.audioIterator = null;
    await retireIterator(audioIterator);
}

async function retireIterator(iterator: { return?: () => Promise<unknown> } | null): Promise<void> {
    try {
        await iterator?.return?.();
    } catch {
        return;
    }
}

function stopRun(run: DecodeRun): void {
    if (run.cancelled) {
        return;
    }

    run.cancelled = true;
    run.metadataAbortController?.abort();
    run.metadataAbortController = null;
    // The page flushed the worklet before it stopped the run, or the run finished and the worklet plays out its queue
    closeAudioDecodeAttempt(run);
    run.pendingAudioOutput?.port.close();
    run.pendingAudioOutput = null;
    run.pendingAudioControl?.audioOutput.port.close();
    run.pendingAudioControl = null;
    wakeWaiters(run.wakeAudioControlWaiters);
    wakeWaiters(run.wakeAudioCreditWaiters);
    wakeWaiters(run.wakeFrameCreditWaiters);
    wakeWaiters(run.wakeVideoControlWaiters);
    wakeWaiters(run.wakeVideoDecodeWaiters);
    run.input?.dispose();
    const iteratorRetirementPromises: Array<Promise<void>> = [];
    iteratorRetirementPromises.push(retireIterator(run.audioIterator));
    iteratorRetirementPromises.push(run.enhancementPacketPairer?.retire() ?? Promise.resolve());
    iteratorRetirementPromises.push(retireIterator(run.videoIterator));
    run.iteratorRetirementPromise = Promise.all(iteratorRetirementPromises).then((): void => undefined);
}

function getSafeErrorMessage(error: unknown): string {
    if (!(error instanceof Error)) {
        return 'Custom media decode failed';
    }

    return error.message
        .replace(/https?:\/\/[^\s]+/gi, '[media URL]')
        .replace(/([?&](?:api_?key|token)=)[^&\s]+/gi, '$1[redacted]')
        .slice(0, 512);
}

function classifyFailure(error: unknown): CustomDecodeFailureKind {
    if (error instanceof UnsupportedRangeResponseError) {
        return 'range-unsupported';
    }
    if (error instanceof UnsupportedCustomDecodeSourceError) {
        return 'source-unsupported';
    }
    if (error instanceof AudioDecodeWorkerAttemptError) {
        return error.failureKind;
    }
    if (error instanceof DolbyVisionRPUParseError) {
        return 'source-unsupported';
    }
    if (error instanceof MediaNetworkError) {
        return 'network-failed';
    }

    return 'decode-failed';
}

type FocusedSoftwareVideoRoute = Readonly<{
    codec: 'jpeg2000' | 'mpeg2video' | 'vc1'
    decoderCodec: string
    errorName: string
    expectedInternalCodecID: string
    includeColorSpace: boolean
}>;

type FocusedSoftwareVideoTrackInput = Readonly<{
    availableVideoTracks: readonly InputVideoTrack[]
    codedHeight: number
    codedWidth: number
    containerCodec: VideoCodec | null
    displayHeight: number
    displayWidth: number
    internalCodecID: unknown
    request: Extract<DecodeWorkerRequest, { type: 'start' }>
    videoTrack: InputVideoTrack
}>;

function getFocusedSoftwareVideoRoute(
    backend: CustomDecodeVideoDecoderBackend,
    internalCodecID: unknown
): FocusedSoftwareVideoRoute | null {
    switch (backend) {
        case 'openjpeg':
            return {
                codec: 'jpeg2000',
                decoderCodec: 'mjp2',
                errorName: 'OpenJPEG MJ2',
                expectedInternalCodecID: 'mjp2',
                includeColorSpace: false
            };
        case 'ffmpeg-mpeg2-vc1':
            if (internalCodecID === 'V_MS/VFW/FOURCC') {
                return {
                    codec: 'vc1',
                    decoderCodec: 'vc1',
                    errorName: 'Advanced VC-1 software',
                    expectedInternalCodecID: 'V_MS/VFW/FOURCC',
                    includeColorSpace: true
                };
            }
            return {
                codec: 'mpeg2video',
                decoderCodec: 'mpeg2video',
                errorName: 'MPEG-2 software',
                expectedInternalCodecID: 'V_MPEG2',
                includeColorSpace: true
            };
        case 'bundled-hevc':
        case 'native':
            return null;
    }
}

async function prepareFocusedSoftwareVideoTrack(input: FocusedSoftwareVideoTrackInput): Promise<PreparedVideoTrack | null> {
    const route = getFocusedSoftwareVideoRoute(input.request.videoDecoderBackend, input.internalCodecID);
    if (!route) {
        return null;
    }
    if (
        input.containerCodec !== null
        || input.internalCodecID !== route.expectedInternalCodecID
        || input.request.videoOutputMode !== 'video-frame'
        || input.request.dolbyVisionProfile !== null
        || input.request.neutralizeHDRColorMetadata
        || input.request.nativeHDRTransfer !== null
    ) {
        throw new UnsupportedCustomDecodeSourceError(
            `The selected video track does not match the negotiated ${route.errorName} route`
        );
    }

    const colorSpace = route.includeColorSpace ? await input.videoTrack.getColorSpace() : null;
    const description = route.codec === 'vc1' ?
        getMatroskaVC1DecoderDescription(input.videoTrack, input.codedWidth, input.codedHeight) :
        null;
    if (route.codec === 'vc1' && !description) {
        throw new UnsupportedCustomDecodeSourceError('The selected VC-1 track has no supported WVC1 decoder description');
    }
    // A bundled decoder is software whatever the codec
    const videoHardwareAcceleration = getCustomDecodeRequestHardwareAcceleration(input.request, null);
    return {
        availableVideoTracks: input.availableVideoTracks,
        codec: route.codec,
        containerTrackNumber: input.videoTrack.id,
        decoderConfig: {
            codec: route.decoderCodec,
            codedHeight: input.codedHeight,
            codedWidth: input.codedWidth,
            ...(description ? { description } : {}),
            ...(colorSpace ? { colorSpace } : {}),
            displayAspectHeight: input.displayHeight,
            displayAspectWidth: input.displayWidth,
            hardwareAcceleration: videoHardwareAcceleration,
            optimizeForLatency: true
        },
        geometry: {
            codedHeight: input.codedHeight,
            codedWidth: input.codedWidth,
            displayHeight: input.displayHeight,
            displayWidth: input.displayWidth
        },
        videoHardwareAcceleration,
        videoTrack: input.videoTrack
    };
}

/** Reads the packets of a static HDR scan from the first one, within the scan's unit and byte bounds. */
async function readStaticHDRMetadataScanUnits(
    packetSink: EncodedPacketSink,
    firstPacket: EncodedPacket | null,
    run: DecodeRun
): Promise<Uint8Array[]> {
    const units: Uint8Array[] = [];
    let scannedByteLength = 0;
    let packet = firstPacket;
    while (packet && !run.cancelled && units.length < MAXIMUM_STATIC_HDR_METADATA_SCAN_ACCESS_UNIT_COUNT) {
        const nextByteLength = scannedByteLength + packet.data.byteLength;
        if (units.length > 0 && nextByteLength > STATIC_HDR_METADATA_SCAN_MAXIMUM_BYTE_LENGTH) {
            break;
        }
        units.push(packet.data);
        scannedByteLength = nextByteLength;
        if (scannedByteLength >= STATIC_HDR_METADATA_SCAN_MAXIMUM_BYTE_LENGTH) {
            break;
        }
        packet = await packetSink.getNextPacket(packet, STATIC_HDR_METADATA_PACKET_OPTIONS);
    }
    return units;
}

async function readHEVCStaticHDRMetadata(
    videoTrack: InputVideoTrack,
    decoderConfig: VideoDecoderConfig,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    run: DecodeRun
): Promise<StaticHDRMetadataScanResult | null> {
    if (request.nativeHDRTransfer !== 'pq') {
        return null;
    }

    const packetSink = new EncodedPacketSink(videoTrack);
    const accessUnits = await readStaticHDRMetadataScanUnits(
        packetSink,
        await packetSink.getFirstPacket(STATIC_HDR_METADATA_PACKET_OPTIONS),
        run
    );
    return scanHEVCStaticHDRMetadata(accessUnits, getHEVCNALFormat(decoderConfig));
}

/**
 * Scans the MDCV and CLL metadata OBUs of an AV1 track that presents PQ without an RPU.
 * AV1 has no native PQ route, so the request names no transfer, and the first temporal unit's sequence header decides instead.
 */
async function readAV1StaticHDRMetadata(
    videoTrack: InputVideoTrack,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    run: DecodeRun
): Promise<StaticHDRMetadataScanResult | null> {
    if (request.dolbyVisionProfile !== null) {
        return null;
    }

    const packetSink = new EncodedPacketSink(videoTrack);
    const firstPacket = await packetSink.getFirstPacket(STATIC_HDR_METADATA_PACKET_OPTIONS);
    if (!firstPacket || !hasAV1PQSequenceHeader(firstPacket.data)) {
        return null;
    }
    return scanAV1StaticHDRMetadata(await readStaticHDRMetadataScanUnits(packetSink, firstPacket, run));
}

/** Scans the static HDR metadata a codec carries in band, on the routes whose presentation applies it. */
function readStaticHDRMetadata(
    codec: VideoCodec,
    videoTrack: InputVideoTrack,
    decoderConfig: VideoDecoderConfig,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    run: DecodeRun
): Promise<StaticHDRMetadataScanResult | null> {
    switch (codec) {
        case 'hevc':
            return readHEVCStaticHDRMetadata(videoTrack, decoderConfig, request, run);
        case 'av1':
            return readAV1StaticHDRMetadata(videoTrack, request, run);
        default:
            return Promise.resolve(null);
    }
}

/**
 * Rejects a Dolby Vision RPU route on a track whose RPUs the engine cannot read.
 * The engine reads RPUs from HEVC NAL units and AV1 metadata OBUs.
 * AV1 Dolby Vision (Profile 10) is single-layer, so no AV1 track has a dual-layer route.
 */
function requireDolbyVisionRPUTrack(codec: VideoCodec, dolbyVisionProfile: CustomDecodeDolbyVisionProfile): void {
    if (dolbyVisionProfile === null) {
        return;
    }
    switch (codec) {
        case 'hevc':
            return;
        case 'av1':
            if (isDolbyVisionDualLayerProfile(dolbyVisionProfile)) {
                throw new UnsupportedCustomDecodeSourceError(
                    `AV1 Dolby Vision has no Profile ${dolbyVisionProfile} enhancement layer route`
                );
            }
            return;
        default:
            throw new UnsupportedCustomDecodeSourceError(`Dolby Vision RPU data cannot be read from the selected ${codec} track`);
    }
}

async function prepareVideoTrack(
    input: Input,
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>
): Promise<PreparedVideoTrack> {
    const videoTracks = await input.getVideoTracks();
    if (run.cancelled) {
        throw new UnsupportedCustomDecodeSourceError('Custom decode was cancelled');
    }

    const videoTrack = getTrackByOrdinal(videoTracks, request.videoTrackIndex);
    if (!videoTrack) {
        throw new UnsupportedCustomDecodeSourceError('The selected video track ordinal is unavailable');
    }
    await assignISOBaseMediaDolbyVisionSampleEntryCodec(videoTrack);
    // canDecode() and the owned AV1 path use the corrected codec string
    await assignAV1SequenceHeaderCodecString(videoTrack);

    const [
        codec,
        internalCodecID,
        codedHeight,
        codedWidth,
        displayHeight,
        displayWidth
    ] = await Promise.all([
        videoTrack.getCodec(),
        videoTrack.getInternalCodecId(),
        videoTrack.getCodedHeight(),
        videoTrack.getCodedWidth(),
        videoTrack.getDisplayHeight(),
        videoTrack.getDisplayWidth()
    ]);
    const dimensions = [ codedHeight, codedWidth, displayHeight, displayWidth ];
    if (dimensions.some(dimension => !Number.isSafeInteger(dimension) || dimension <= 0)) {
        throw new UnsupportedCustomDecodeSourceError('The selected video dimensions are invalid');
    }
    if (exceedsNegotiatedCodedSize(codedWidth, codedHeight, request.maximumCodedWidth, request.maximumCodedHeight)) {
        throw new UnsupportedCustomDecodeSourceError('The selected video track exceeds its negotiated decode route');
    }
    if (!Number.isSafeInteger(videoTrack.id) || videoTrack.id <= 0) {
        throw new UnsupportedCustomDecodeSourceError('The selected video container track number is invalid');
    }

    const softwareTrack = await prepareFocusedSoftwareVideoTrack({
        availableVideoTracks: videoTracks,
        codedHeight,
        codedWidth,
        containerCodec: codec,
        displayHeight,
        displayWidth,
        internalCodecID,
        request,
        videoTrack
    });
    if (softwareTrack) {
        return softwareTrack;
    }

    const [ decoderConfig, canDecode ] = await Promise.all([
        videoTrack.getDecoderConfig(),
        videoTrack.canDecode()
    ]);
    if (!codec || !decoderConfig) {
        throw new UnsupportedCustomDecodeSourceError('The selected video codec configuration is unavailable');
    }
    if (request.videoDecoderBackend === 'bundled-hevc' && codec !== 'hevc') {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected video track does not match the negotiated bundled HEVC decoder'
        );
    }
    if (request.neutralizeHDRColorMetadata && codec !== 'hevc') {
        throw new UnsupportedCustomDecodeSourceError('HDR color neutralization requires an HEVC video track');
    }
    if (!canDecode) {
        throw new UnsupportedCustomDecodeSourceError(
            `The browser cannot decode the selected ${codec} video configuration`
        );
    }
    requireDolbyVisionRPUTrack(codec, request.dolbyVisionProfile);

    const staticHDRMetadataScan = await readStaticHDRMetadata(codec, videoTrack, decoderConfig, request, run);
    if (run.cancelled) {
        throw new UnsupportedCustomDecodeSourceError('Custom decode was cancelled');
    }

    return {
        availableVideoTracks: videoTracks,
        codec,
        containerTrackNumber: videoTrack.id,
        decoderConfig,
        geometry: { codedHeight, codedWidth, displayHeight, displayWidth },
        ...(staticHDRMetadataScan ? { staticHDRMetadataScan } : {}),
        videoHardwareAcceleration: getCustomDecodeRequestHardwareAcceleration(request, codec),
        videoTrack
    };
}

function getDefaultDolbyVisionEnhancementGeometry(preparedVideoTrack: PreparedVideoTrack): RawVideoFrameGeometry {
    const baseGeometry = preparedVideoTrack.geometry;
    const enhancementDimensions = getDolbyVisionEnhancementDimensions(
        baseGeometry.codedWidth,
        baseGeometry.codedHeight
    );
    const codedWidth = enhancementDimensions.width;
    const codedHeight = enhancementDimensions.height;
    return {
        codedHeight,
        codedWidth,
        displayHeight: codedHeight,
        displayWidth: codedWidth
    };
}

function getContainerDolbyVisionEnhancementConfiguration(
    preparedVideoTrack: PreparedVideoTrack,
    description: Uint8Array
): DolbyVisionEnhancementDecoderConfiguration | null {
    try {
        const decoderConfiguration = parseHEVCDecoderConfiguration(description);
        if (
            decoderConfiguration.profileIDC !== 2
            || decoderConfiguration.bitDepth !== 10
            || decoderConfiguration.chromaFormat !== 1
            || decoderConfiguration.sequenceParameterSets.length === 0
            || !hasRequiredHEVCParameterSets(description)
        ) {
            return null;
        }
        const spsConfiguration = parseHEVCSPS(decoderConfiguration.sequenceParameterSets[0]);
        const expectedGeometry = getDefaultDolbyVisionEnhancementGeometry(preparedVideoTrack);
        if (
            spsConfiguration.codedHeight !== expectedGeometry.codedHeight
            || spsConfiguration.codedWidth !== expectedGeometry.codedWidth
            || spsConfiguration.displayHeight > spsConfiguration.codedHeight
            || spsConfiguration.displayWidth > spsConfiguration.codedWidth
        ) {
            return null;
        }
        const geometry: RawVideoFrameGeometry = {
            codedHeight: spsConfiguration.codedHeight,
            codedWidth: spsConfiguration.codedWidth,
            displayHeight: spsConfiguration.displayHeight,
            displayWidth: spsConfiguration.displayWidth
        };
        return {
            decoderConfig: {
                codec: DOLBY_VISION_ENHANCEMENT_CODEC,
                codedHeight: geometry.codedHeight,
                codedWidth: geometry.codedWidth,
                description: description.slice(),
                displayAspectHeight: geometry.displayHeight,
                displayAspectWidth: geometry.displayWidth,
                hardwareAcceleration: 'prefer-software',
                optimizeForLatency: true
            },
            geometry,
            packetFormat: {
                kind: 'length-prefixed',
                lengthSize: decoderConfiguration.lengthSize
            },
            source: { kind: 'interleaved' }
        };
    } catch {
        return null;
    }
}

function createDolbyVisionEnhancementDecoderConfiguration(
    preparedVideoTrack: PreparedVideoTrack,
    description: Uint8Array | null = null
): DolbyVisionEnhancementDecoderConfiguration | null {
    if (description) {
        return getContainerDolbyVisionEnhancementConfiguration(preparedVideoTrack, description);
    }
    const geometry = getDefaultDolbyVisionEnhancementGeometry(preparedVideoTrack);
    return {
        decoderConfig: {
            codec: DOLBY_VISION_ENHANCEMENT_CODEC,
            codedHeight: geometry.codedHeight,
            codedWidth: geometry.codedWidth,
            displayAspectHeight: geometry.displayHeight,
            displayAspectWidth: geometry.displayWidth,
            hardwareAcceleration: 'prefer-software',
            optimizeForLatency: true
        },
        geometry,
        packetFormat: ANNEX_B_HEVC_NAL_FORMAT,
        source: { kind: 'interleaved' }
    };
}

function copyDecoderDescription(description: AllowSharedBufferSource | undefined): Uint8Array | null {
    if (description === undefined) {
        return null;
    }
    if (description instanceof ArrayBuffer) {
        return new Uint8Array(description.slice(0));
    }
    if (typeof SharedArrayBuffer !== 'undefined' && description instanceof SharedArrayBuffer) {
        return new Uint8Array(description).slice();
    }
    if (ArrayBuffer.isView(description)) {
        return new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice();
    }
    return null;
}

async function createSeparateDolbyVisionEnhancementDecoderConfiguration(
    preparedVideoTrack: PreparedVideoTrack,
    enhancementTrackNumber: number,
    containerDecoderDescription: Uint8Array | null
): Promise<DolbyVisionEnhancementDecoderConfiguration | null> {
    const videoTrack = preparedVideoTrack.availableVideoTracks.find(
        (candidate: InputVideoTrack): boolean => candidate.id === enhancementTrackNumber
    );
    if (!videoTrack || videoTrack === preparedVideoTrack.videoTrack) {
        return null;
    }
    const [
        codec,
        decoderConfig,
        codedHeight,
        codedWidth,
        displayHeight,
        displayWidth
    ] = await Promise.all([
        videoTrack.getCodec(),
        videoTrack.getDecoderConfig(),
        videoTrack.getCodedHeight(),
        videoTrack.getCodedWidth(),
        videoTrack.getDisplayHeight(),
        videoTrack.getDisplayWidth()
    ]);
    if (codec !== null && codec !== 'hevc') {
        return null;
    }
    let description: Uint8Array | null = containerDecoderDescription?.slice() ?? null;
    let decoderPacketFormat: HEVCNALFormat | null = null;
    try {
        if (!description && codec === 'hevc' && decoderConfig) {
            description = copyDecoderDescription(decoderConfig.description);
            decoderPacketFormat = getHEVCNALFormat(decoderConfig);
        }
    } catch {
        return null;
    }
    let configuration: DolbyVisionEnhancementDecoderConfiguration | null = null;
    if (description) {
        configuration = getContainerDolbyVisionEnhancementConfiguration(preparedVideoTrack, description);
    } else if (decoderPacketFormat?.kind === 'annex-b') {
        configuration = createDolbyVisionEnhancementDecoderConfiguration(preparedVideoTrack);
    }
    if (!configuration) {
        return null;
    }
    if (
        configuration.geometry.codedHeight !== codedHeight
        || configuration.geometry.codedWidth !== codedWidth
        || configuration.geometry.displayHeight !== displayHeight
        || configuration.geometry.displayWidth !== displayWidth
    ) {
        return null;
    }
    return {
        ...configuration,
        packetFormat: decoderPacketFormat ?? configuration.packetFormat,
        source: {
            kind: 'separate-track',
            videoTrack
        }
    };
}

async function getSelectedAudioTrackMetadata(
    input: Input,
    run: DecodeRun,
    audioTrackOrdinal: number
): Promise<SelectedAudioTrackMetadata> {
    const audioTracks = await input.getAudioTracks();
    if (run.cancelled) {
        throw new UnsupportedCustomDecodeSourceError('Custom decode was cancelled');
    }

    const audioTrack = getTrackByOrdinal(audioTracks, audioTrackOrdinal);
    if (!audioTrack) {
        throw new UnsupportedCustomDecodeSourceError('The selected audio track ordinal is unavailable');
    }

    const [
        codec,
        decoderConfig,
        internalCodecID,
        channelCount,
        declaredSampleRate,
        timeResolution
    ] = await Promise.all([
        audioTrack.getCodec(),
        audioTrack.getDecoderConfig(),
        audioTrack.getInternalCodecId(),
        audioTrack.getNumberOfChannels(),
        audioTrack.getSampleRate(),
        audioTrack.getTimeResolution()
    ]);
    // Matroska and ISO BMFF DTS and TrueHD tracks have no Mediabunny codec
    const bundledDecoderCodec = getBundledAudioDecoderCodec(codec, internalCodecID);
    const isDTS = bundledDecoderCodec === 'dts';
    const trueHDDecoderCodec = bundledDecoderCodec === 'dts' ? null : bundledDecoderCodec;
    const sampleRate = getDeclaredAudioSampleRate(internalCodecID, declaredSampleRate);
    if ((!codec || !decoderConfig) && bundledDecoderCodec === null) {
        throw new UnsupportedCustomDecodeSourceError('The selected audio codec configuration is unavailable');
    }
    if (!Number.isSafeInteger(channelCount) || channelCount <= 0 || channelCount > MAX_DECODED_AUDIO_CHANNELS) {
        throw new UnsupportedCustomDecodeSourceError('The selected audio channel count is unsupported');
    }
    if (!isSupportedCustomAudioSampleRate(sampleRate)) {
        throw new UnsupportedCustomDecodeSourceError('The selected audio sample rate is invalid');
    }
    const inputChannelLayout = getCustomAudioChannelLayout(channelCount);
    if (!inputChannelLayout) {
        throw new UnsupportedCustomDecodeSourceError('The selected audio channel layout is unavailable');
    }

    return {
        audioTrack,
        channelCount,
        codec,
        decoderConfig,
        inputChannelLayout,
        isDTS,
        sampleRate,
        timeResolution,
        trueHDDecoderCodec
    };
}

function prepareNativeMediaAudioTrack(metadata: SelectedAudioTrackMetadata): PreparedAudioTrack {
    const {
        audioTrack,
        channelCount,
        codec,
        decoderConfig,
        inputChannelLayout,
        sampleRate,
        timeResolution
    } = metadata;
    if (!codec || !decoderConfig) {
        throw new UnsupportedCustomDecodeSourceError('The selected native audio codec configuration is unavailable');
    }
    const codecMatchesDecoderConfiguration =
        (codec === 'ac3' && decoderConfig.codec === 'ac-3')
        || (codec === 'eac3' && decoderConfig.codec === 'ec-3');
    if (!codecMatchesDecoderConfiguration
        || (channelCount !== 2 && channelCount !== 6)
        || sampleRate !== 48_000) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected audio track does not match the qualified native media route'
        );
    }
    const audioConfiguration: DecodeWorkerNativeMediaAudioConfiguration = {
        channelCount,
        codec: decoderConfig.codec,
        mimeType: `audio/mp4; codecs="${decoderConfig.codec}"`,
        outputMode: 'native-media',
        sampleRate,
        sourceChannelCount: channelCount,
        sourceSampleRate: sampleRate
    };
    return {
        audioConfiguration,
        audioTrack,
        decoderBackend: 'mediabunny',
        decoderConfig,
        inputChannelCount: channelCount,
        inputChannelLayout,
        outputMode: 'native-media',
        outputChannelCount: channelCount as 2 | 6,
        routeCodec: codec,
        sourceSampleRate: sampleRate,
        timeResolution
    };
}

// The declared layout only screens the track early; the decoded one is bound at the first output
function prepareDTSAudioTrack(
    metadata: SelectedAudioTrackMetadata,
    outputChannelCount: CustomAudioOutputChannelCount
): PreparedAudioTrack {
    const {
        audioTrack,
        channelCount,
        inputChannelLayout,
        sampleRate,
        timeResolution
    } = metadata;
    if (!isSupportedCustomAudioInputLayout('dts', channelCount, sampleRate)) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected audio track does not match a qualified decoded PCM route'
        );
    }

    return {
        audioConfiguration: {
            channelCount: outputChannelCount,
            codec: 'dts',
            sampleRate: CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE,
            sourceChannelCount: channelCount,
            sourceSampleRate: sampleRate
        },
        audioTrack,
        decoderBackend: 'dts',
        decoderConfig: null,
        inputChannelCount: channelCount,
        inputChannelLayout,
        outputMode: 'decoded-pcm',
        outputChannelCount,
        routeCodec: 'dts',
        sourceSampleRate: sampleRate,
        timeResolution
    };
}

/** Accepts E-AC-3 declarations, including the 7.1 tracks Mediabunny under-declares. */
function isDeclaredEAC3InputLayout(channelCount: number, sampleRate: number): boolean {
    return isSupportedCustomAudioInputLayout('eac3', channelCount, sampleRate)
        || (channelCount === EAC3_UNDER_DECLARED_SEVEN_POINT_ONE_CHANNEL_COUNT
            && isSupportedCustomAudioSampleRate(sampleRate));
}

function prepareEAC3AudioTrack(
    metadata: SelectedAudioTrackMetadata,
    outputChannelCount: CustomAudioOutputChannelCount
): PreparedAudioTrack {
    const {
        audioTrack,
        channelCount,
        codec,
        decoderConfig,
        inputChannelLayout,
        sampleRate,
        timeResolution
    } = metadata;
    if (codec !== 'eac3'
        || decoderConfig?.codec !== 'ec-3'
        || !isDeclaredEAC3InputLayout(channelCount, sampleRate)) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected E-AC-3 track does not match a qualified decoded PCM route'
        );
    }

    return {
        audioConfiguration: {
            channelCount: outputChannelCount,
            codec: decoderConfig.codec,
            sampleRate: CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE,
            sourceChannelCount: channelCount,
            sourceSampleRate: sampleRate
        },
        audioTrack,
        decoderBackend: 'eac3',
        decoderConfig,
        inputChannelCount: channelCount,
        inputChannelLayout,
        outputMode: 'decoded-pcm',
        outputChannelCount,
        routeCodec: codec,
        sourceSampleRate: sampleRate,
        timeResolution
    };
}

function prepareTrueHDAudioTrack(
    metadata: SelectedAudioTrackMetadata,
    outputChannelCount: CustomAudioOutputChannelCount
): PreparedAudioTrack {
    const {
        audioTrack,
        channelCount,
        inputChannelLayout,
        sampleRate,
        timeResolution,
        trueHDDecoderCodec
    } = metadata;
    if (!trueHDDecoderCodec
        || !isSupportedCustomAudioInputLayout(trueHDDecoderCodec, channelCount, sampleRate)) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected TrueHD track does not match a qualified decoded PCM route'
        );
    }

    return {
        audioConfiguration: {
            channelCount: outputChannelCount,
            codec: trueHDDecoderCodec,
            sampleRate: CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE,
            sourceChannelCount: channelCount,
            sourceSampleRate: sampleRate
        },
        audioTrack,
        decoderBackend: trueHDDecoderCodec,
        decoderConfig: null,
        inputChannelCount: channelCount,
        inputChannelLayout,
        outputMode: 'decoded-pcm',
        outputChannelCount,
        routeCodec: trueHDDecoderCodec,
        sourceSampleRate: sampleRate,
        timeResolution
    };
}

async function prepareMediabunnyDecodedAudioTrack(
    metadata: SelectedAudioTrackMetadata,
    run: DecodeRun,
    outputChannelCount: CustomAudioOutputChannelCount
): Promise<PreparedAudioTrack> {
    const {
        audioTrack,
        channelCount,
        codec,
        decoderConfig,
        inputChannelLayout,
        sampleRate,
        timeResolution
    } = metadata;
    if (!codec || !decoderConfig) {
        throw new UnsupportedCustomDecodeSourceError('The decoded PCM audio configuration is unavailable');
    }
    // HE-AAC with Parametric Stereo declares its mono core; the decoder reports stereo
    if (!isSupportedCustomAudioInputLayout(codec, channelCount, sampleRate)) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected audio track does not match a qualified decoded PCM route'
        );
    }
    await registerRequiredCustomAudioDecoder(codec);
    if (run.cancelled) {
        throw new UnsupportedCustomDecodeSourceError('Custom decode was cancelled');
    }
    const canDecode = await audioTrack.canDecode();
    if (!canDecode) {
        throw new UnsupportedCustomDecodeSourceError(
            `The browser cannot decode the selected ${codec} audio configuration`
        );
    }

    return {
        audioConfiguration: {
            channelCount: outputChannelCount,
            codec: decoderConfig.codec,
            sampleRate: CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE,
            sourceChannelCount: channelCount,
            sourceSampleRate: sampleRate
        },
        audioTrack,
        decoderBackend: 'mediabunny',
        decoderConfig,
        inputChannelCount: channelCount,
        inputChannelLayout,
        outputMode: 'decoded-pcm',
        outputChannelCount,
        routeCodec: codec,
        sourceSampleRate: sampleRate,
        timeResolution
    };
}

async function prepareAudioTrack(
    input: Input,
    run: DecodeRun,
    audioTrackOrdinal: number,
    outputMode: CustomDecodeAudioOutputMode,
    decodedAudioOutputChannelCount: CustomAudioOutputChannelCount
): Promise<PreparedAudioTrack> {
    const metadata = await getSelectedAudioTrackMetadata(input, run, audioTrackOrdinal);
    switch (outputMode) {
        case 'native-media':
            return prepareNativeMediaAudioTrack(metadata);
        case 'decoded-pcm':
            if (metadata.isDTS) {
                return prepareDTSAudioTrack(metadata, decodedAudioOutputChannelCount);
            }
            if (metadata.codec === 'eac3') {
                return prepareEAC3AudioTrack(metadata, decodedAudioOutputChannelCount);
            }
            return metadata.trueHDDecoderCodec ?
                prepareTrueHDAudioTrack(metadata, decodedAudioOutputChannelCount) :
                prepareMediabunnyDecodedAudioTrack(metadata, run, decodedAudioOutputChannelCount);
    }
}

/**
 * Reads the duration from the container's metadata for a source the server never probed.
 * Only the presented video track is asked: a late-starting audio track would make Mediabunny scan for its first packet.
 */
async function readContainerDurationMicroseconds(input: Input, videoTrack: InputVideoTrack): Promise<Microseconds | null> {
    try {
        const durationSeconds = await input.getDurationFromMetadata([ videoTrack ]);
        if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
            return null;
        }
        return secondsToMicroseconds(durationSeconds);
    } catch {
        // A missing duration only disables seeking; it never fails startup
        return null;
    }
}

function postReadyResponse(
    run: DecodeRun,
    preparedVideoTrack: PreparedVideoTrack,
    preparedAudioTrack: PreparedAudioTrack | null,
    containerDurationMicroseconds: Microseconds | null
): void {
    const geometry = preparedVideoTrack.geometry;
    postResponse({
        audio: preparedAudioTrack?.audioConfiguration ?? null,
        codec: preparedVideoTrack.decoderConfig.codec,
        codedHeight: geometry.codedHeight,
        codedWidth: geometry.codedWidth,
        ...(containerDurationMicroseconds !== null ? { containerDurationMicroseconds } : {}),
        displayHeight: geometry.displayHeight,
        displayWidth: geometry.displayWidth,
        generation: run.generation,
        ...(preparedVideoTrack.staticHDRMetadataScan ? {
            staticHDRMetadataScan: preparedVideoTrack.staticHDRMetadataScan
        } : {}),
        type: 'ready'
    });
}

function lockDecodedFrameGeometry(
    run: DecodeRun,
    candidateGeometry: RawVideoFrameGeometry,
    selectedTrackGeometry: RawVideoFrameGeometry
): RawVideoFrameGeometry {
    try {
        const decodedVideoGeometry = requireConsistentDecodedVideoGeometry(
            candidateGeometry,
            selectedTrackGeometry,
            run.maximumCodedWidth,
            run.maximumCodedHeight,
            run.decodedVideoGeometry
        );
        run.decodedVideoGeometry = decodedVideoGeometry;
        return decodedVideoGeometry;
    } catch (error) {
        if (error instanceof DecodedVideoGeometryError) {
            throw new UnsupportedCustomDecodeSourceError(error.message);
        }
        throw error;
    }
}

type DecodedFrameTiming = {
    durationMicroseconds: Microseconds
    mediaTimeMicroseconds: Microseconds
};

type TakenDecodedFrame<Frame> = DecodedFrameTiming & {
    frame: Frame
};

function getVideoSampleTiming(sample: VideoSample): DecodedFrameTiming {
    const mediaTimeMicroseconds = requireMicroseconds(sample.microsecondTimestamp, 'Decoded frame timestamp');
    const durationMicroseconds = requireMicroseconds(sample.microsecondDuration, 'Decoded frame duration');
    if (durationMicroseconds < 0) {
        throw new RangeError('Decoded frame duration must not be negative');
    }
    return { durationMicroseconds, mediaTimeMicroseconds };
}

function takeVideoFrame(sample: VideoSample): TakenDecodedFrame<VideoFrame> {
    try {
        const timing = getVideoSampleTiming(sample);
        return {
            durationMicroseconds: timing.durationMicroseconds,
            frame: sample.toVideoFrame(),
            mediaTimeMicroseconds: timing.mediaTimeMicroseconds
        };
    } finally {
        // VideoFrame ownership is independent, so do not retain the sample across copies
        sample.close();
    }
}

function takeOwnedVideoFrame(output: OwnedDecodedVideoOutput): TakenDecodedFrame<VideoFrame> {
    switch (output.source.kind) {
        case 'native-frame':
            return {
                durationMicroseconds: output.durationMicroseconds,
                frame: output.source.frame,
                mediaTimeMicroseconds: output.mediaTimeMicroseconds
            };
        case 'planar-sample':
        case 'video-sample':
            return takeVideoFrame(output.source.sample);
        case 'prepared-raw-frame':
            // Only an EL is prepared on a VideoFrame route, and an EL travels only inside a raw frame pair
            output.source.frame.close();
            throw new UnsupportedCustomDecodeSourceError('A frame prepared as raw planes cannot be posted as a VideoFrame');
    }
}

/**
 * Takes a decoded output for a raw copy.
 * A sample's CPU planes are copied straight from it, because Firefox cannot construct a VideoFrame in a high-bit-depth format such as I420P10.
 * A frame its decoder already wrote into the raw layout, as the bundled HEVC decoder does, is taken as it is.
 */
function takeOwnedRawVideoFrameSource(output: OwnedDecodedVideoOutput): TakenDecodedFrame<RawVideoFrameSource> {
    switch (output.source.kind) {
        case 'prepared-raw-frame':
            return {
                durationMicroseconds: output.durationMicroseconds,
                frame: output.source.frame,
                mediaTimeMicroseconds: output.mediaTimeMicroseconds
            };
        case 'native-frame':
        case 'video-sample':
            return takeOwnedVideoFrame(output);
        case 'planar-sample':
            break;
    }
    const sample = output.source.sample;
    try {
        const timing = getVideoSampleTiming(sample);
        return {
            durationMicroseconds: timing.durationMicroseconds,
            frame: createVideoSampleRawFrameSource(sample),
            mediaTimeMicroseconds: timing.mediaTimeMicroseconds
        };
    } catch (error) {
        sample.close();
        throw error;
    }
}

type MutableDecodeWorkerFrameResponse = Extract<DecodeWorkerResponse, { type: 'frame' }>;

function attachDolbyVisionEncodedMetadata(
    response: MutableDecodeWorkerFrameResponse,
    metadata: DolbyVisionEncodedFrameMetadata | null
): Transferable[] {
    const transferableMetadata = takeTransferableDolbyVisionEncodedFrameMetadata(metadata);
    if (transferableMetadata) {
        response.encodedDolbyVisionMetadata = transferableMetadata;
    }
    return getDolbyVisionEncodedMetadataTransferList(transferableMetadata);
}

function attachHDR10PlusMetadata(
    response: MutableDecodeWorkerFrameResponse,
    metadata: HDR10PlusFrameMetadata | null | undefined
): void {
    if (metadata) {
        response.HDR10PlusMetadata = metadata;
    }
}

async function postRawVideoFrame(
    run: DecodeRun,
    frame: RawVideoFrameSource,
    decodedVideoGeometry: RawVideoFrameGeometry,
    durationMicroseconds: Microseconds,
    mediaTimeMicroseconds: Microseconds,
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null,
    HDR10PlusMetadata: HDR10PlusFrameMetadata | null | undefined
): Promise<void> {
    const rawVideoFrameFormat = run.rawVideoFrameFormat;
    if (rawVideoFrameFormat === null) {
        frame.close();
        throw new UnsupportedCustomDecodeSourceError('The raw video frame output format is unavailable');
    }
    // A frame its decoder already wrote in this format and geometry is transferred as it is
    const preparedRawFrame = frame instanceof PreparedRawVideoFrameSource ?
        frame.takeRawFrame(rawVideoFrameFormat, decodedVideoGeometry) :
        null;
    const rawFrame = preparedRawFrame ?? await copyVideoFrameToRawPlanes(frame, {
        bufferPool: run.rawFrameBufferPool,
        expectedGeometry: decodedVideoGeometry,
        format: rawVideoFrameFormat
    });
    if (run.cancelled || currentRun !== run) {
        return;
    }
    if (run.videoAttemptCancelled) {
        // A replaced attempt returns its buffer instead of posting a stale frame
        run.rawFrameBufferPool?.release(rawFrame.data);
        return;
    }
    if (rawFrame.timestampMicroseconds !== mediaTimeMicroseconds) {
        throw new UnsupportedCustomDecodeSourceError('The decoded raw frame timestamp did not match its media sample');
    }
    if (run.outstandingRawFrameBufferCount >= MAX_DECODED_RAW_FRAME_CREDITS) {
        throw new UnsupportedCustomDecodeSourceError('The raw video frame buffer window exceeded its bound');
    }

    run.outstandingRawFrameBufferCount += 1;
    const response: MutableDecodeWorkerFrameResponse = {
        durationMicroseconds: rawFrame.durationMicroseconds ?? durationMicroseconds,
        frame: rawFrame,
        generation: run.generation,
        mediaTimeMicroseconds,
        outputMode: 'raw-planes',
        type: 'frame',
        videoEpoch: run.videoEpoch
    };
    const transferables = getRawVideoFrameTransferList(rawFrame);
    attachHDR10PlusMetadata(response, HDR10PlusMetadata);
    transferables.push(...attachDolbyVisionEncodedMetadata(response, encodedDolbyVisionMetadata));
    recordVideoAttemptFramePosted(run, mediaTimeMicroseconds);
    postResponse(response, transferables);
}

type RawVideoFramePairPostRequest = {
    baseFrame: RawVideoFrameSource
    baseGeometry: RawVideoFrameGeometry
    durationMicroseconds: Microseconds
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null
    HDR10PlusMetadata: HDR10PlusFrameMetadata | null | undefined
    enhancementFrame: RawVideoFrameSource | null
    enhancementGeometry: RawVideoFrameGeometry
    mediaTimeMicroseconds: Microseconds
};

async function postRawVideoFramePair(run: DecodeRun, request: RawVideoFramePairPostRequest): Promise<void> {
    const {
        baseFrame,
        baseGeometry,
        durationMicroseconds,
        encodedDolbyVisionMetadata,
        HDR10PlusMetadata,
        enhancementFrame,
        enhancementGeometry,
        mediaTimeMicroseconds
    } = request;
    const rawVideoFrameFormat = run.rawVideoFrameFormat;
    if (rawVideoFrameFormat === null) {
        baseFrame.close();
        enhancementFrame?.close();
        throw new UnsupportedCustomDecodeSourceError('The compound raw video frame output format is unavailable');
    }
    // Each layer is copied once more into the compound buffer, even when its decoder already wrote it in the raw layout
    const rawFramePair = await copyVideoFramePairToRawPlanes(
        baseFrame,
        enhancementFrame,
        {
            baseExpectedGeometry: baseGeometry,
            bufferPool: run.rawFrameBufferPool,
            enhancementExpectedGeometry: enhancementGeometry,
            format: rawVideoFrameFormat
        }
    );
    if (run.cancelled || currentRun !== run) {
        return;
    }
    if (run.videoAttemptCancelled) {
        // Both layers share one compound buffer, which returns to the pool unposted
        run.rawFrameBufferPool?.release(rawFramePair.baseFrame.data);
        return;
    }
    if (rawFramePair.baseFrame.timestampMicroseconds !== mediaTimeMicroseconds) {
        throw new UnsupportedCustomDecodeSourceError(
            'The decoded compound raw frame timestamp did not match its media sample'
        );
    }
    if (rawFramePair.enhancementFrame && encodedDolbyVisionMetadata) {
        switch (encodedDolbyVisionMetadata.enhancementLayerDisposition) {
            case 'discarded-fel':
                encodedDolbyVisionMetadata.enhancementLayerDisposition = 'decoded-fel';
                break;
            case 'discarded-mel':
                encodedDolbyVisionMetadata.enhancementLayerDisposition = 'decoded-mel';
                break;
            case 'absent':
            case 'decoded-fel':
            case 'decoded-mel':
                break;
        }
    }
    if (run.outstandingRawFrameBufferCount >= MAX_DECODED_RAW_FRAME_CREDITS) {
        throw new UnsupportedCustomDecodeSourceError('The compound raw video frame buffer window exceeded its bound');
    }

    run.outstandingRawFrameBufferCount += 1;
    const response: MutableDecodeWorkerFrameResponse = {
        durationMicroseconds: rawFramePair.baseFrame.durationMicroseconds
            ?? durationMicroseconds,
        enhancementFrame: rawFramePair.enhancementFrame,
        frame: rawFramePair.baseFrame,
        generation: run.generation,
        mediaTimeMicroseconds,
        outputMode: 'raw-planes',
        type: 'frame',
        videoEpoch: run.videoEpoch
    };
    const transferables = getRawVideoFramePairTransferList(rawFramePair);
    attachHDR10PlusMetadata(response, HDR10PlusMetadata);
    transferables.push(...attachDolbyVisionEncodedMetadata(response, encodedDolbyVisionMetadata));
    recordVideoAttemptFramePosted(run, mediaTimeMicroseconds);
    postResponse(response, transferables);
}

function postTransferredVideoFrame(
    run: DecodeRun,
    frame: VideoFrame,
    durationMicroseconds: Microseconds,
    mediaTimeMicroseconds: Microseconds,
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null,
    HDR10PlusMetadata: HDR10PlusFrameMetadata | null | undefined
): void {
    const response: MutableDecodeWorkerFrameResponse = {
        durationMicroseconds,
        frame,
        generation: run.generation,
        mediaTimeMicroseconds,
        outputMode: 'video-frame',
        type: 'frame',
        videoEpoch: run.videoEpoch
    };
    attachHDR10PlusMetadata(response, HDR10PlusMetadata);
    const transferables: Transferable[] = [ frame as unknown as Transferable ];
    transferables.push(...attachDolbyVisionEncodedMetadata(response, encodedDolbyVisionMetadata));
    recordVideoAttemptFramePosted(run, mediaTimeMicroseconds);
    postResponse(response, transferables);
}

function lockTakenFrameGeometry(
    run: DecodeRun,
    output: OwnedDecodedVideoOutput,
    frame: RawVideoFrameSource,
    expectedGeometry: RawVideoFrameGeometry
): RawVideoFrameGeometry {
    const candidateGeometry = output.source.kind === 'native-frame' ?
        output.source.geometry :
        {
            codedHeight: frame.codedHeight,
            codedWidth: frame.codedWidth,
            displayHeight: frame.displayHeight,
            displayWidth: frame.displayWidth
        };
    return lockDecodedFrameGeometry(run, candidateGeometry, expectedGeometry);
}

/** Takes the enhancement layer, which only travels inside a raw frame pair, and checks its timestamp. */
function takeMatchingEnhancementFrame(
    enhancementOutput: OwnedDecodedVideoOutput,
    mediaTimeMicroseconds: Microseconds
): RawVideoFrameSource {
    const decodedEnhancementFrame = takeOwnedRawVideoFrameSource(enhancementOutput);
    if (Math.abs(decodedEnhancementFrame.mediaTimeMicroseconds - mediaTimeMicroseconds) > 1) {
        decodedEnhancementFrame.frame.close();
        throw new UnsupportedCustomDecodeSourceError('The decoded Dolby Vision layers have mismatched timestamps');
    }
    return decodedEnhancementFrame.frame;
}

async function postRawVideoOutput(
    run: DecodeRun,
    output: OwnedDecodedVideoOutput,
    expectedGeometry: RawVideoFrameGeometry,
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null,
    enhancementOutput: OwnedDecodedVideoOutput | null,
    enhancementExpectedGeometry: RawVideoFrameGeometry | null
): Promise<void> {
    let frame: RawVideoFrameSource | null = null;
    let enhancementFrame: RawVideoFrameSource | null = null;
    // Owned here until its frame is taken
    let untakenEnhancementOutput = enhancementOutput;
    try {
        const decodedFrame = takeOwnedRawVideoFrameSource(output);
        frame = decodedFrame.frame;
        const decodedVideoGeometry = lockTakenFrameGeometry(run, output, frame, expectedGeometry);
        // A replaced attempt closes its frames here; its credit is refunded when it unwinds
        if (isVideoAttemptStopped(run) || currentRun !== run) {
            return;
        }
        if (untakenEnhancementOutput) {
            const takenEnhancementOutput = untakenEnhancementOutput;
            untakenEnhancementOutput = null;
            enhancementFrame = takeMatchingEnhancementFrame(
                takenEnhancementOutput,
                decodedFrame.mediaTimeMicroseconds
            );
        }

        const ownedFrame = frame;
        frame = null;
        if (enhancementExpectedGeometry) {
            const ownedEnhancementFrame = enhancementFrame;
            enhancementFrame = null;
            await postRawVideoFramePair(run, {
                baseFrame: ownedFrame,
                baseGeometry: decodedVideoGeometry,
                durationMicroseconds: decodedFrame.durationMicroseconds,
                encodedDolbyVisionMetadata,
                HDR10PlusMetadata: output.HDR10PlusMetadata,
                enhancementFrame: ownedEnhancementFrame,
                enhancementGeometry: enhancementExpectedGeometry,
                mediaTimeMicroseconds: decodedFrame.mediaTimeMicroseconds
            });
            return;
        }
        await postRawVideoFrame(
            run,
            ownedFrame,
            decodedVideoGeometry,
            decodedFrame.durationMicroseconds,
            decodedFrame.mediaTimeMicroseconds,
            encodedDolbyVisionMetadata,
            output.HDR10PlusMetadata
        );
    } finally {
        frame?.close();
        enhancementFrame?.close();
        closeOwnedDecodedVideoOutput(untakenEnhancementOutput);
    }
}

function postTransferredVideoOutput(
    run: DecodeRun,
    output: OwnedDecodedVideoOutput,
    expectedGeometry: RawVideoFrameGeometry,
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null,
    enhancementOutput: OwnedDecodedVideoOutput | null
): void {
    let frame: VideoFrame | null = null;
    // Owned here until its frame is taken
    let untakenEnhancementOutput = enhancementOutput;
    try {
        const decodedFrame = takeOwnedVideoFrame(output);
        frame = decodedFrame.frame;
        lockTakenFrameGeometry(run, output, frame, expectedGeometry);
        // A replaced attempt closes its frames here; its credit is refunded when it unwinds
        if (isVideoAttemptStopped(run) || currentRun !== run) {
            return;
        }
        if (untakenEnhancementOutput) {
            const takenEnhancementOutput = untakenEnhancementOutput;
            untakenEnhancementOutput = null;
            takeMatchingEnhancementFrame(takenEnhancementOutput, decodedFrame.mediaTimeMicroseconds).close();
        }

        postTransferredVideoFrame(
            run,
            frame,
            decodedFrame.durationMicroseconds,
            decodedFrame.mediaTimeMicroseconds,
            encodedDolbyVisionMetadata,
            output.HDR10PlusMetadata
        );
        frame = null;
    } finally {
        frame?.close();
        closeOwnedDecodedVideoOutput(untakenEnhancementOutput);
    }
}

async function postVideoFrame(
    run: DecodeRun,
    output: OwnedDecodedVideoOutput,
    expectedGeometry: RawVideoFrameGeometry,
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null = null,
    enhancementOutput: OwnedDecodedVideoOutput | null = null,
    enhancementExpectedGeometry: RawVideoFrameGeometry | null = null
): Promise<void> {
    switch (run.videoOutputMode) {
        case 'raw-planes':
            await postRawVideoOutput(
                run,
                output,
                expectedGeometry,
                encodedDolbyVisionMetadata,
                enhancementOutput,
                enhancementExpectedGeometry
            );
            return;
        case 'video-frame':
            postTransferredVideoOutput(
                run,
                output,
                expectedGeometry,
                encodedDolbyVisionMetadata,
                enhancementOutput
            );
            return;
    }
}

/** Reports a chunk the audio decode worker posted to the worklet, while its attempt is the current one. */
function postAudioProgress(run: DecodeRun, response: AudioDecodeWorkerProgressResponse): void {
    if (isAudioAttemptStopped(run) || run.audioEpoch !== response.audioEpoch) {
        return;
    }
    postResponse({
        audioEpoch: response.audioEpoch,
        durationMicroseconds: response.durationMicroseconds,
        frameCount: response.frameCount,
        generation: run.generation,
        mediaTimeMicroseconds: response.mediaTimeMicroseconds,
        sampleRate: response.sampleRate,
        type: 'audio-progress'
    });
}

/** Reports the decoded format an audio attempt bound, which the session prefers over the declared one */
function postDecodedAudioSourceFormat(run: DecodeRun, response: AudioDecodeWorkerSourceFormatResponse): void {
    if (isAudioAttemptStopped(run) || run.audioEpoch !== response.audioEpoch) {
        return;
    }
    postResponse({
        audioEpoch: response.audioEpoch,
        channelCount: response.channelCount,
        generation: run.generation,
        sampleRate: response.sampleRate,
        type: 'audio-source-format'
    });
}

/**
 * Copies the part of a decoded sample at or after the start into planar channels the batch transfers, and closes the sample.
 * A sample wholly before the start still carries its format, which the audio decode worker binds as it would any other.
 */
function copyAudioSampleWindow(sample: AudioSample, startTimeMicroseconds: Microseconds): AudioDecodeWorkerPCMSample {
    try {
        const sampleTimeMicroseconds = requireMicroseconds(sample.microsecondTimestamp, 'Decoded audio timestamp');
        // A decoded sample of any length is taken; the resampler re-chunks it within the protocol frame limit
        if (!Number.isSafeInteger(sample.numberOfFrames) || sample.numberOfFrames <= 0) {
            throw new UnsupportedCustomDecodeSourceError('A decoded audio sample has an invalid frame count');
        }
        // The window needs a valid rate, and a channel count beyond any layout never reaches the copy
        if (!isSupportedCustomAudioSampleRate(sample.sampleRate)) {
            throw new UnsupportedCustomDecodeSourceError(`The decoded audio sample rate ${sample.sampleRate} Hz is invalid`);
        }
        if (!Number.isSafeInteger(sample.numberOfChannels)
            || sample.numberOfChannels <= 0
            || sample.numberOfChannels > MAX_DECODED_AUDIO_CHANNELS) {
            throw new UnsupportedCustomDecodeSourceError(`The decoded ${sample.numberOfChannels}-channel audio layout is unsupported`);
        }
        const sampleWindow = getAudioSampleWindow(
            sampleTimeMicroseconds,
            sample.numberOfFrames,
            sample.sampleRate,
            startTimeMicroseconds
        );
        const channelData: Float32Array[] = [];
        if (!sampleWindow) {
            return {
                channelCount: sample.numberOfChannels,
                channelData,
                frameCount: 0,
                mediaTimeMicroseconds: sampleTimeMicroseconds,
                sampleRate: sample.sampleRate
            };
        }
        for (let channelIndex = 0; channelIndex < sample.numberOfChannels; channelIndex += 1) {
            const channel = new Float32Array(sampleWindow.frameCount);
            sample.copyTo(channel, {
                frameCount: sampleWindow.frameCount,
                frameOffset: sampleWindow.frameOffset,
                format: 'f32-planar',
                planeIndex: channelIndex
            });
            channelData.push(channel);
        }
        return {
            channelCount: sample.numberOfChannels,
            channelData,
            frameCount: sampleWindow.frameCount,
            mediaTimeMicroseconds: sampleWindow.mediaTimeMicroseconds,
            sampleRate: sample.sampleRate
        };
    } finally {
        sample.close();
    }
}

/** Returns where the bundled HEVC decoder writes a run's BL frames: into the run's raw layout, or into VideoFrames. */
function getBundledHEVCFrameOutput(run: DecodeRun): HEVCFrameOutput {
    switch (run.videoOutputMode) {
        case 'raw-planes':
            return { bufferPool: run.rawFrameBufferPool, kind: 'raw-planes' };
        case 'video-frame':
            return { kind: 'video-frame', writer: new HEVCVideoFrameWriter() };
    }
}

/** Returns where the bundled HEVC decoder writes a run's EL frames, which travel only as raw planes inside a frame pair. */
function getBundledHEVCEnhancementFrameOutput(run: DecodeRun): HEVCFrameOutput {
    return { bufferPool: run.rawFrameBufferPool, kind: 'raw-planes' };
}

/**
 * Creates an owned port for the bundled HEVC decoder.
 * Each frame is written out while its planes are in WASM memory, so the decoder's planes are copied once on their way to the page.
 */
function createOwnedBundledHEVCVideoDecoderPort(
    config: VideoDecoderConfig,
    callbacks: OwnedVideoDecoderCallbacks,
    frameOutput: HEVCFrameOutput
): OwnedVideoDecoderPort {
    const decoder = createOwnedHEVCSoftwareVideoDecoder(config, {
        onError: callbacks.onError,
        onFrame: (frame: HEVCSoftwareDecodedFrame): void => {
            try {
                callbacks.onOutput(writeHEVCDecodedFrame(frame, frameOutput));
            } finally {
                callbacks.onProgress();
            }
        }
    });
    return {
        close: (): void => decoder.close(),
        decode: (packet: EncodedPacket): boolean => {
            decoder.decode(packet);
            return true;
        },
        flush: (): Promise<void> => {
            decoder.flush();
            return Promise.resolve();
        },
        getDecodeQueueSize: (): number => 0,
        init: (): Promise<void> => decoder.init()
    };
}

function createOwnedHEVCVideoDecoderPort(
    run: DecodeRun,
    preparedVideoTrack: PreparedVideoTrack,
    inputFormat: ReturnType<typeof getHEVCNALFormat>,
    callbacks: OwnedVideoDecoderCallbacks
): OwnedVideoDecoderPort {
    switch (run.videoDecoderBackend) {
        case 'bundled-hevc':
            return createOwnedBundledHEVCVideoDecoderPort(
                preparedVideoTrack.decoderConfig,
                callbacks,
                getBundledHEVCFrameOutput(run)
            );
        case 'native':
            return new OwnedNativeHEVCVideoDecoder(
                {
                    ...preparedVideoTrack.decoderConfig,
                    hardwareAcceleration: preparedVideoTrack.videoHardwareAcceleration,
                    optimizeForLatency: true
                },
                inputFormat,
                {
                    onError: callbacks.onError,
                    onFrame: (frame: VideoFrame): void => callbacks.onOutput({
                        frame,
                        geometry: {
                            codedHeight: frame.codedHeight,
                            codedWidth: frame.codedWidth,
                            displayHeight: frame.displayHeight,
                            displayWidth: frame.displayWidth
                        },
                        kind: 'native-frame'
                    }),
                    onProgress: callbacks.onProgress
                },
                undefined,
                {
                    nativeHDRTransfer: run.nativeHDRTransfer ?? undefined,
                    neutralizeHDRColorMetadata: run.neutralizeHDRColorMetadata
                }
            );
        case 'openjpeg':
            throw new Error('The OpenJPEG route does not use an HEVC decoder port');
        case 'ffmpeg-mpeg2-vc1':
            throw new Error('The FFmpeg MPEG-2/VC-1 route does not use an HEVC decoder port');
    }
}

/** Binds an owned stream to its decode run and to the geometry its BL and EL frames must keep. */
function createOwnedVideoStreamRun(
    run: DecodeRun,
    expectedGeometry: RawVideoFrameGeometry,
    enhancementExpectedGeometry: RawVideoFrameGeometry | null
): OwnedVideoStreamRun {
    return {
        isStopped: (): boolean => isVideoAttemptStopped(run),
        notifyDecoderProgress: (): void => {
            wakeWaiters(run.wakeVideoDecodeWaiters);
        },
        postFrame: (
            output: OwnedDecodedVideoOutput,
            enhancementOutput: OwnedDecodedVideoOutput | null
        ): Promise<void> => postVideoFrame(
            run,
            output,
            expectedGeometry,
            output.encodedDolbyVisionMetadata,
            enhancementOutput,
            enhancementExpectedGeometry
        ),
        postStartupProgress: (
            phase: CustomDecodeWorkerProgressPhase,
            packetCount: number,
            mediaTimeMicroseconds: Microseconds
        ): void => {
            postVideoStartupProgress(run, phase, packetCount, mediaTimeMicroseconds);
        },
        sleep: (milliseconds: number): Promise<void> => new Promise<void>(resolve => {
            setTimeout(resolve, milliseconds);
        }),
        waitForDecoderProgress: (): Promise<void> => new Promise<void>(resolve => {
            run.wakeVideoDecodeWaiters.push(resolve);
        }),
        waitForFrameCredit: (): Promise<boolean> => waitForFrameCredit(run)
    };
}

/** The decoders, queues, and state that each packet of one owned HEVC attempt passes through. */
type OwnedHEVCStream = {
    decoder: OwnedVideoDecoderPort
    dynamicHDRMetadataQueue: HEVCDynamicHDRMetadataQueue
    enhancementDecoder: OwnedVideoDecoderPort | null
    metadataQueue: DolbyVisionEncodedMetadataQueue
    separateEnhancementStream: SeparateDolbyVisionEnhancementPacketStream | null
    state: OwnedVideoStreamState
};

async function createSeparateDolbyVisionEnhancementPacketStream(
    run: DecodeRun,
    configuration: DolbyVisionEnhancementDecoderConfiguration,
    startTimeMicroseconds: Microseconds
): Promise<SeparateDolbyVisionEnhancementPacketStream | null> {
    if (configuration.source.kind !== 'separate-track' || isVideoAttemptStopped(run)) {
        return null;
    }
    try {
        const packetSink = new EncodedPacketSink(configuration.source.videoTrack);
        const startTimeSeconds = microsecondsToSeconds(startTimeMicroseconds);
        const keyPacket = await packetSink.getKeyPacket(
            startTimeSeconds,
            OWNED_HEVC_PACKET_OPTIONS
        ) ?? await packetSink.getFirstKeyPacket(OWNED_HEVC_PACKET_OPTIONS);
        if (!keyPacket || isVideoAttemptStopped(run)) {
            return null;
        }
        const iterator = packetSink.packets(keyPacket, undefined, OWNED_HEVC_PACKET_OPTIONS);
        const pairer = new DolbyVisionEncodedPacketPairer(iterator);
        run.enhancementPacketPairer = pairer;
        return {
            inputFormat: configuration.packetFormat,
            pairer
        };
    } catch {
        return null;
    }
}

/** Splits one HEVC packet; a separate-track EL packet that does not split leaves the stream to its BL. */
async function processOwnedHEVCPacket(
    hevcStream: OwnedHEVCStream,
    packet: EncodedPacket,
    separateEnhancementPacket: EncodedPacket | null
): Promise<ProcessedDolbyVisionHEVCPacket> {
    const separateEnhancementInputFormat = hevcStream.separateEnhancementStream?.inputFormat ?? null;
    if (separateEnhancementPacket && separateEnhancementInputFormat) {
        try {
            return await hevcStream.metadataQueue.processSeparatePackets(
                packet,
                separateEnhancementPacket,
                separateEnhancementInputFormat
            );
        } catch {
            hevcStream.state.recordEnhancementDecoderFailure();
        }
    }
    return hevcStream.metadataQueue.processPacket(packet);
}

async function decodeOwnedHEVCPacket(
    run: DecodeRun,
    hevcStream: OwnedHEVCStream,
    packet: EncodedPacket,
    packetMediaTimeMicroseconds: Microseconds
): Promise<boolean> {
    const { separateEnhancementStream, state } = hevcStream;
    let separateEnhancementPacket: EncodedPacket | null = null;
    if (separateEnhancementStream && state.canDecodeEnhancement()) {
        try {
            separateEnhancementPacket = await separateEnhancementStream.pairer.takeMatchingPacket(
                packetMediaTimeMicroseconds
            );
            if (!separateEnhancementPacket) {
                state.recordEnhancementDecoderFailure();
                await separateEnhancementStream.pairer.retire();
            }
        } catch {
            state.recordEnhancementDecoderFailure();
            await separateEnhancementStream.pairer.retire();
        }
    }
    if (isVideoAttemptStopped(run)) {
        return false;
    }
    hevcStream.dynamicHDRMetadataQueue.processPacket(packet);
    const processedPacket = await processOwnedHEVCPacket(hevcStream, packet, separateEnhancementPacket);
    state.decodeEnhancementPacket(
        processedPacket.enhancementLayerPacket,
        processedPacket.hasEnhancementLayerVCL,
        hevcStream.enhancementDecoder
    );
    state.decodeBasePacket(
        packet,
        processedPacket.baseLayerPacket,
        processedPacket.hasBaseLayerVCL,
        hevcStream.decoder
    );
    state.throwDecoderFailure();
    if (separateEnhancementStream && !separateEnhancementStream.pairer.retired && !state.canDecodeEnhancement()) {
        await separateEnhancementStream.pairer.retire();
    }
    return true;
}

async function readDolbyVisionMetadataByteRange(
    run: DecodeRun,
    url: string,
    abortController: AbortController,
    offset: number,
    byteLength: number
): Promise<Uint8Array | null> {
    if (
        isVideoAttemptStopped(run)
        || !Number.isSafeInteger(offset)
        || offset < 0
        || !Number.isSafeInteger(byteLength)
        || byteLength <= 0
    ) {
        return null;
    }
    const lastByte = offset + byteLength - 1;
    if (!Number.isSafeInteger(lastByte)) {
        return null;
    }
    const response = await validatedRangeFetch(url, {
        headers: {
            Range: `bytes=${offset}-${lastByte}`
        },
        signal: abortController.signal
    });
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > byteLength) {
        return null;
    }
    return data;
}

async function readContainerDolbyVisionTrackConfiguration(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    containerTrackNumber: number
): Promise<ContainerDolbyVisionTrackConfiguration | null> {
    if (isVideoAttemptStopped(run)) {
        return null;
    }
    // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
    const abortController = new AbortController();
    run.metadataAbortController = abortController;
    try {
        const reader = (
            offset: number,
            byteLength: number
        ): Promise<Uint8Array | null> => readDolbyVisionMetadataByteRange(
            run,
            request.url,
            abortController,
            offset,
            byteLength
        );
        const matroskaConfiguration = await readMatroskaDolbyVisionTrackConfiguration(
            reader,
            containerTrackNumber
        );
        if (matroskaConfiguration && (
            matroskaConfiguration.enhancementConfiguration
            || matroskaConfiguration.separateEnhancementTrackNumber !== null
        )) {
            return {
                enhancementConfiguration: matroskaConfiguration.enhancementConfiguration,
                separateEnhancement: matroskaConfiguration.separateEnhancementTrackNumber === null ?
                    null :
                    {
                        decoderDescription: null,
                        trackNumber: matroskaConfiguration.separateEnhancementTrackNumber
                    }
            };
        }
        const isoBaseMediaConfiguration = await readISOBaseMediaDolbyVisionTrackConfiguration(
            reader,
            containerTrackNumber
        );
        if (isoBaseMediaConfiguration) {
            // A null track number means the selected track interleaves the EL under its hvcE configuration
            return isoBaseMediaConfiguration.separateEnhancementTrackNumber === null ? {
                enhancementConfiguration: isoBaseMediaConfiguration.enhancementConfiguration,
                separateEnhancement: null
            } : {
                enhancementConfiguration: null,
                separateEnhancement: {
                    decoderDescription: isoBaseMediaConfiguration.enhancementConfiguration,
                    trackNumber: isoBaseMediaConfiguration.separateEnhancementTrackNumber
                }
            };
        }
        const transportStreamConfiguration =
            await readMPEGTransportStreamDolbyVisionTrackConfiguration(reader, containerTrackNumber);
        if (!transportStreamConfiguration) {
            return null;
        }
        return {
            enhancementConfiguration: null,
            separateEnhancement: {
                decoderDescription: null,
                trackNumber: transportStreamConfiguration.separateEnhancementTrackNumber
            }
        };
    } finally {
        if (run.metadataAbortController === abortController) {
            run.metadataAbortController = null;
        }
    }
}

async function resolveDolbyVisionEnhancementDecoderConfiguration(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack,
    keyPacketSplit: ReturnType<typeof splitDolbyVisionHEVCAccessUnit>
): Promise<DolbyVisionEnhancementDecoderConfiguration | null> {
    // A discarded EL reports its frames as discarded, so presentation reconstructs MEL exactly and FEL as its base
    if (
        !isDolbyVisionDualLayerProfile(request.dolbyVisionProfile)
        || request.discardDolbyVisionEnhancementLayer === true
    ) {
        return null;
    }
    if (keyPacketSplit.hasRequiredEnhancementLayerParameterSets) {
        return createDolbyVisionEnhancementDecoderConfiguration(preparedVideoTrack);
    }
    const containerConfiguration = await readContainerDolbyVisionTrackConfiguration(
        run,
        request,
        preparedVideoTrack.containerTrackNumber
    );
    if (!containerConfiguration || isVideoAttemptStopped(run)) {
        return null;
    }
    if (keyPacketSplit.hasEnhancementLayerVCL) {
        if (!containerConfiguration.enhancementConfiguration) {
            return null;
        }
        return createDolbyVisionEnhancementDecoderConfiguration(
            preparedVideoTrack,
            containerConfiguration.enhancementConfiguration
        );
    }
    if (!containerConfiguration.separateEnhancement) {
        return null;
    }
    return createSeparateDolbyVisionEnhancementDecoderConfiguration(
        preparedVideoTrack,
        containerConfiguration.separateEnhancement.trackNumber,
        containerConfiguration.separateEnhancement.decoderDescription
    );
}

async function streamOwnedHEVCFrames(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack
): Promise<void> {
    if (preparedVideoTrack.codec !== 'hevc') {
        throw new UnsupportedCustomDecodeSourceError('The owned HEVC decoder requires an HEVC track');
    }

    const packetSink = new EncodedPacketSink(preparedVideoTrack.videoTrack);
    const startTimeSeconds = microsecondsToSeconds(request.startTimeMicroseconds);
    const keyPacket = await packetSink.getKeyPacket(
        startTimeSeconds,
        OWNED_HEVC_PACKET_OPTIONS
    ) ?? await packetSink.getFirstKeyPacket(OWNED_HEVC_PACKET_OPTIONS);
    if (!keyPacket || isVideoAttemptStopped(run)) {
        return;
    }
    const keyPacketMediaTimeMicroseconds = requireMicroseconds(
        keyPacket.microsecondTimestamp,
        'Owned HEVC key packet timestamp'
    );
    postVideoStartupProgress(run, 'video-key-packet-ready', 0, keyPacketMediaTimeMicroseconds);

    const packetIterator = packetSink.packets(keyPacket, undefined, OWNED_HEVC_PACKET_OPTIONS);
    run.videoIterator = packetIterator;
    const inputFormat = getHEVCNALFormat(preparedVideoTrack.decoderConfig);
    const keyPacketSplit = splitDolbyVisionHEVCAccessUnit(keyPacket.data, inputFormat, ANNEX_B_HEVC_NAL_FORMAT);
    let enhancementConfiguration = await resolveDolbyVisionEnhancementDecoderConfiguration(
        run,
        request,
        preparedVideoTrack,
        keyPacketSplit
    );
    const separateEnhancementStream = enhancementConfiguration ?
        await createSeparateDolbyVisionEnhancementPacketStream(
            run,
            enhancementConfiguration,
            keyPacketMediaTimeMicroseconds
        ) :
        null;
    if (enhancementConfiguration?.source.kind === 'separate-track' && !separateEnhancementStream) {
        enhancementConfiguration = null;
    }
    if (isVideoAttemptStopped(run)) {
        await retireIterator(packetIterator);
        await separateEnhancementStream?.pairer.retire();
        return;
    }
    // Only a Dolby Vision route parses RPUs, so any other route never loads the parser
    const rpuParser = request.dolbyVisionProfile === null ?
        null :
        DolbyVisionRPUParserSession.create(request.dolbyVisionRPUParserWASMURL);
    const metadataQueue = new DolbyVisionEncodedMetadataQueue(
        inputFormat,
        rpuParser,
        enhancementConfiguration?.packetFormat ?? inputFormat
    );
    const dynamicHDRMetadataQueue = new HEVCDynamicHDRMetadataQueue(inputFormat);
    const streamRun = createOwnedVideoStreamRun(
        run,
        preparedVideoTrack.geometry,
        enhancementConfiguration?.geometry ?? null
    );
    const state = new OwnedVideoStreamState(
        streamRun,
        createOwnedVideoFrameMetadataSource(metadataQueue, dynamicHDRMetadataQueue),
        request.startTimeMicroseconds,
        enhancementConfiguration?.geometry ?? null
    );
    const notifyDecoderProgress = streamRun.notifyDecoderProgress;
    const decoder = createOwnedHEVCVideoDecoderPort(
        run,
        preparedVideoTrack,
        inputFormat,
        {
            onError: (error: unknown): void => {
                state.recordDecoderFailure(error);
                notifyDecoderProgress();
            },
            onOutput: (output: OwnedDecodedVideoSource): void => {
                state.enqueueDecodedOutput(output);
            },
            onProgress: notifyDecoderProgress
        }
    );
    const enhancementDecoder = enhancementConfiguration ?
        createOwnedBundledHEVCVideoDecoderPort(
            enhancementConfiguration.decoderConfig,
            {
                onError: (): void => {
                    state.recordEnhancementDecoderFailure();
                    notifyDecoderProgress();
                },
                onOutput: (output: OwnedDecodedVideoSource): void => {
                    state.enqueueEnhancementDecodedOutput(output);
                },
                onProgress: notifyDecoderProgress
            },
            getBundledHEVCEnhancementFrameOutput(run)
        ) :
        null;
    try {
        const decoderInitializationPromise = decoder.init();
        const enhancementInitializationPromise = enhancementDecoder ?
            enhancementDecoder.init() :
            Promise.resolve();
        const initializationResults = await Promise.allSettled([
            decoderInitializationPromise,
            enhancementInitializationPromise
        ]);
        const enhancementInitializationResult = initializationResults[1];
        if (enhancementInitializationResult.status === 'rejected') {
            state.recordEnhancementDecoderFailure();
        }
        const decoderInitializationResult = initializationResults[0];
        if (decoderInitializationResult.status === 'rejected') {
            throw decoderInitializationResult.reason;
        }
        postVideoStartupProgress(run, 'video-decoder-ready', 0, keyPacketMediaTimeMicroseconds);
        const hevcStream: OwnedHEVCStream = {
            decoder,
            dynamicHDRMetadataQueue,
            enhancementDecoder,
            metadataQueue,
            separateEnhancementStream,
            state
        };
        await pumpOwnedVideoFrames(
            streamRun,
            packetIterator,
            decoder,
            enhancementDecoder,
            state,
            (packet: EncodedPacket, packetMediaTimeMicroseconds: Microseconds): Promise<boolean> => (
                decodeOwnedHEVCPacket(run, hevcStream, packet, packetMediaTimeMicroseconds)
            )
        );
    } finally {
        // Close the decoders first: an output arriving during the awaits below would otherwise land in the cleared queue and leak its frame
        decoder.close();
        enhancementDecoder?.close();
        state.close();
        rpuParser?.close();
        try {
            await packetIterator.return?.();
        } catch {
            // Input disposal is the authoritative cancellation signal
        }
        await separateEnhancementStream?.pairer.retire();
    }
}

/** The codec's part of an owned native attempt, which reads each packet's metadata as the packets decode. */
type OwnedNativeVideoAttempt = (
    stream: OwnedVideoStreamRun,
    packetIterator: OwnedVideoPacketIterator,
    createDecoder: (callbacks: OwnedVideoDecoderCallbacks) => OwnedVideoDecoderPort,
    keyPacketMediaTimeMicroseconds: Microseconds
) => Promise<void>;

/**
 * Streams one attempt of an owned path whose packets decode unchanged in a native WebCodecs decoder.
 * Each attempt starts at the key packet preceding its start time.
 */
async function streamOwnedNativeFrames(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack,
    codecName: 'AV1' | 'VP9',
    runAttempt: OwnedNativeVideoAttempt
): Promise<void> {
    const packetSink = new EncodedPacketSink(preparedVideoTrack.videoTrack);
    const startTimeSeconds = microsecondsToSeconds(request.startTimeMicroseconds);
    const keyPacket = await packetSink.getKeyPacket(
        startTimeSeconds,
        OWNED_NATIVE_PACKET_OPTIONS
    ) ?? await packetSink.getFirstKeyPacket(OWNED_NATIVE_PACKET_OPTIONS);
    if (!keyPacket || isVideoAttemptStopped(run)) {
        return;
    }
    const keyPacketMediaTimeMicroseconds = requireMicroseconds(
        keyPacket.microsecondTimestamp,
        `Owned ${codecName} key packet timestamp`
    );
    postVideoStartupProgress(run, 'video-key-packet-ready', 0, keyPacketMediaTimeMicroseconds);

    const packetIterator = packetSink.packets(keyPacket, undefined, OWNED_NATIVE_PACKET_OPTIONS);
    run.videoIterator = packetIterator;
    const decoderConfig: VideoDecoderConfig = {
        ...preparedVideoTrack.decoderConfig,
        hardwareAcceleration: preparedVideoTrack.videoHardwareAcceleration,
        optimizeForLatency: true
    };
    try {
        await runAttempt(
            createOwnedVideoStreamRun(run, preparedVideoTrack.geometry, null),
            packetIterator,
            (callbacks: OwnedVideoDecoderCallbacks): OwnedVideoDecoderPort => (
                new OwnedNativeVideoDecoder(decoderConfig, callbacks)
            ),
            keyPacketMediaTimeMicroseconds
        );
    } finally {
        try {
            await packetIterator.return?.();
        } catch {
            // Input disposal is the authoritative cancellation signal
        }
    }
}

/**
 * Decodes an AV1 track in the engine's own decoder, because Mediabunny's sample sink hides the metadata OBUs that carry Dolby Vision RPUs and HDR10+ metadata.
 * Only a Dolby Vision route loads the RPU parser; any other route strips the RPUs unparsed.
 */
async function streamOwnedAV1Frames(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack
): Promise<void> {
    if (preparedVideoTrack.codec !== 'av1' || run.videoDecoderBackend !== 'native') {
        throw new UnsupportedCustomDecodeSourceError(
            'The owned AV1 decoder requires an AV1 track on the native decoder'
        );
    }

    await streamOwnedNativeFrames(run, request, preparedVideoTrack, 'AV1', async (
        stream: OwnedVideoStreamRun,
        packetIterator: OwnedVideoPacketIterator,
        createDecoder: (callbacks: OwnedVideoDecoderCallbacks) => OwnedVideoDecoderPort,
        keyPacketMediaTimeMicroseconds: Microseconds
    ): Promise<void> => {
        const rpuParser = request.dolbyVisionProfile === null ?
            null :
            DolbyVisionRPUParserSession.create(request.dolbyVisionRPUParserWASMURL);
        try {
            await runOwnedAV1VideoStream(
                stream,
                packetIterator,
                rpuParser,
                createDecoder,
                request.startTimeMicroseconds,
                keyPacketMediaTimeMicroseconds
            );
        } finally {
            rpuParser?.close();
        }
    });
}

/**
 * Decodes a VP9 track in the engine's own decoder, because only a demuxed packet's container side data carries VP9 HDR10+, and Mediabunny's sample sink never reads it.
 */
async function streamOwnedVP9Frames(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack
): Promise<void> {
    if (preparedVideoTrack.codec !== 'vp9' || run.videoDecoderBackend !== 'native') {
        throw new UnsupportedCustomDecodeSourceError(
            'The owned VP9 decoder requires a VP9 track on the native decoder'
        );
    }

    await streamOwnedNativeFrames(run, request, preparedVideoTrack, 'VP9', (
        stream: OwnedVideoStreamRun,
        packetIterator: OwnedVideoPacketIterator,
        createDecoder: (callbacks: OwnedVideoDecoderCallbacks) => OwnedVideoDecoderPort,
        keyPacketMediaTimeMicroseconds: Microseconds
    ): Promise<void> => {
        const readBlockAdditions = createMatroskaBlockAdditionReader(preparedVideoTrack.videoTrack);
        return runOwnedVP9VideoStream(
            stream,
            packetIterator,
            (packet: EncodedPacket): Uint8Array[] => readBlockAdditions(packet).map(
                (addition: MatroskaBlockAddition): Uint8Array => addition.data
            ),
            createDecoder,
            request.startTimeMicroseconds,
            keyPacketMediaTimeMicroseconds
        );
    });
}

async function streamJPEG2000Frames(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack
): Promise<void> {
    if (
        preparedVideoTrack.codec !== 'jpeg2000'
        || run.videoDecoderBackend !== 'openjpeg'
        || run.videoOutputMode !== 'video-frame'
    ) {
        throw new UnsupportedCustomDecodeSourceError(
            'The OpenJPEG decoder requires a negotiated JPEG 2000 VideoFrame route'
        );
    }

    const packetSink = new EncodedPacketSink(preparedVideoTrack.videoTrack);
    const startPacket = await packetSink.getPacket(
        microsecondsToSeconds(request.startTimeMicroseconds),
        OPENJPEG_PACKET_OPTIONS
    ) ?? await packetSink.getFirstPacket(OPENJPEG_PACKET_OPTIONS);
    if (!startPacket || isVideoAttemptStopped(run)) {
        return;
    }
    const firstPacketMediaTimeMicroseconds = requireMicroseconds(
        startPacket.microsecondTimestamp,
        'OpenJPEG first packet timestamp'
    );
    postVideoStartupProgress(run, 'video-key-packet-ready', 0, firstPacketMediaTimeMicroseconds);

    const decoder = new JPEG2000SoftwareVideoDecoder();
    try {
        await decoder.init();
        if (isVideoAttemptStopped(run)) {
            return;
        }
        postVideoStartupProgress(run, 'video-decoder-ready', 0, firstPacketMediaTimeMicroseconds);

        const packetIterator = packetSink.packets(startPacket, undefined, OPENJPEG_PACKET_OPTIONS);
        run.videoIterator = packetIterator;
        let packetCount = 0;
        while (await waitForFrameCredit(run)) {
            const packetResult = await readNextVideoPacket(packetIterator);
            if (isVideoAttemptStopped(run) || packetResult.done) {
                return;
            }

            packetCount += 1;
            const packet = packetResult.value;
            const packetMediaTimeMicroseconds = requireMicroseconds(
                packet.microsecondTimestamp,
                'OpenJPEG packet timestamp'
            );
            const packetDurationMicroseconds = requireMicroseconds(
                packet.microsecondDuration,
                'OpenJPEG packet duration'
            );
            if (packetDurationMicroseconds < 0) {
                throw new RangeError('OpenJPEG packet duration must not be negative');
            }
            postVideoStartupProgress(run, 'video-packet-started', packetCount, packetMediaTimeMicroseconds);
            let frame: VideoFrame | null = decoder.decode(packet, preparedVideoTrack.geometry);
            try {
                postVideoStartupProgress(run, 'video-packet-decoded', packetCount, packetMediaTimeMicroseconds);
                const ownedFrame = frame;
                frame = null;
                await postVideoFrame(
                    run,
                    {
                        durationMicroseconds: packetDurationMicroseconds,
                        encodedDolbyVisionMetadata: null,
                        mediaTimeMicroseconds: packetMediaTimeMicroseconds,
                        source: {
                            frame: ownedFrame,
                            geometry: preparedVideoTrack.geometry,
                            kind: 'native-frame'
                        }
                    },
                    preparedVideoTrack.geometry
                );
            } finally {
                frame?.close();
            }
        }
    } finally {
        decoder.close();
    }
}

function closeMPEG2VC1Samples(samples: VideoSample[]): void {
    for (const sample of samples.splice(0)) {
        sample.close();
    }
}

async function postMPEG2VC1Samples(
    run: DecodeRun,
    samples: VideoSample[],
    expectedGeometry: RawVideoFrameGeometry,
    startTimeMicroseconds: Microseconds
): Promise<boolean> {
    while (samples.length > 0) {
        const sample = samples.shift();
        if (!sample) {
            continue;
        }
        try {
            const timing = getOwnedDecodedVideoTiming({
                kind: 'planar-sample',
                sample
            });
            if (timing.mediaTimeMicroseconds + timing.durationMicroseconds <= startTimeMicroseconds) {
                continue;
            }
            if (!await waitForFrameCredit(run) || isVideoAttemptStopped(run)) {
                return false;
            }
            await postVideoFrame(
                run,
                {
                    durationMicroseconds: timing.durationMicroseconds,
                    encodedDolbyVisionMetadata: null,
                    mediaTimeMicroseconds: timing.mediaTimeMicroseconds,
                    source: {
                        kind: 'planar-sample',
                        sample
                    }
                },
                expectedGeometry
            );
        } finally {
            sample.close();
        }
    }
    return !isVideoAttemptStopped(run);
}

async function streamMPEG2VC1Frames(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack
): Promise<void> {
    const decoderConfiguration = createMPEG2VC1DecoderConfiguration(run, preparedVideoTrack);
    const packetSink = new EncodedPacketSink(preparedVideoTrack.videoTrack);
    const startTimeSeconds = microsecondsToSeconds(request.startTimeMicroseconds);
    const keyPacket = await packetSink.getKeyPacket(
        startTimeSeconds,
        MPEG2_VC1_PACKET_OPTIONS
    ) ?? await packetSink.getFirstKeyPacket(MPEG2_VC1_PACKET_OPTIONS);
    if (!keyPacket || isVideoAttemptStopped(run)) {
        return;
    }
    const keyPacketMediaTimeMicroseconds = requireMicroseconds(
        keyPacket.microsecondTimestamp,
        'MPEG-2/VC-1 key packet timestamp'
    );
    postVideoStartupProgress(run, 'video-key-packet-ready', 0, keyPacketMediaTimeMicroseconds);

    const pendingSamples: VideoSample[] = [];
    let decoderError: unknown = null;
    const decoder = new MPEG2VC1SoftwareVideoDecoder(decoderConfiguration, {
        onError: (error: unknown): void => {
            decoderError = error;
        },
        onSample: (sample: VideoSample): void => {
            if (pendingSamples.length >= OWNED_VIDEO_DECODER_QUEUE_HIGH_WATER_MARK) {
                throw new RangeError('The MPEG-2/VC-1 decoded frame queue exceeded its bound');
            }
            pendingSamples.push(sample);
        }
    });
    const packetIterator = packetSink.packets(keyPacket, undefined, MPEG2_VC1_PACKET_OPTIONS);
    run.videoIterator = packetIterator;
    try {
        await decoder.init();
        if (isVideoAttemptStopped(run)) {
            return;
        }
        postVideoStartupProgress(run, 'video-decoder-ready', 0, keyPacketMediaTimeMicroseconds);

        let packetCount = 0;
        while (!isVideoAttemptStopped(run)) {
            const packetResult = await readNextVideoPacket(packetIterator);
            if (isVideoAttemptStopped(run)) {
                return;
            }
            if (packetResult.done) {
                break;
            }
            packetCount += 1;
            const packet = packetResult.value;
            const packetMediaTimeMicroseconds = requireMicroseconds(
                packet.microsecondTimestamp,
                'MPEG-2/VC-1 packet timestamp'
            );
            postVideoStartupProgress(run, 'video-packet-started', packetCount, packetMediaTimeMicroseconds);
            decoder.decode(packet);
            if (decoderError !== null) {
                throw decoderError;
            }
            postVideoStartupProgress(run, 'video-packet-decoded', packetCount, packetMediaTimeMicroseconds);
            if (!await postMPEG2VC1Samples(
                run,
                pendingSamples,
                preparedVideoTrack.geometry,
                request.startTimeMicroseconds
            )) {
                return;
            }
        }
        if (isVideoAttemptStopped(run)) {
            return;
        }
        decoder.flush();
        if (decoderError !== null) {
            throw decoderError;
        }
        await postMPEG2VC1Samples(run, pendingSamples, preparedVideoTrack.geometry, request.startTimeMicroseconds);
    } finally {
        closeMPEG2VC1Samples(pendingSamples);
        try {
            await packetIterator.return?.();
        } catch {
            // Input disposal is the authoritative cancellation signal
        }
        decoder.close();
    }
}

function createMPEG2VC1DecoderConfiguration(
    run: DecodeRun,
    preparedVideoTrack: PreparedVideoTrack
): MPEG2VC1SoftwareVideoDecoderConfiguration {
    if (
        (preparedVideoTrack.codec !== 'mpeg2video'
            && preparedVideoTrack.codec !== 'vc1')
        || run.videoDecoderBackend !== 'ffmpeg-mpeg2-vc1'
        || run.videoOutputMode !== 'video-frame'
    ) {
        throw new UnsupportedCustomDecodeSourceError(
            'The MPEG-2/VC-1 software decoder requires a negotiated MPEG-2 or VC-1 VideoFrame route'
        );
    }
    const decoderDescription = preparedVideoTrack.decoderConfig.description;
    if (preparedVideoTrack.codec === 'vc1' && !(decoderDescription instanceof Uint8Array)) {
        throw new UnsupportedCustomDecodeSourceError('The negotiated VC-1 decoder description is unavailable');
    }
    return {
        codec: preparedVideoTrack.codec,
        codedHeight: preparedVideoTrack.geometry.codedHeight,
        codedWidth: preparedVideoTrack.geometry.codedWidth,
        colorSpace: preparedVideoTrack.decoderConfig.colorSpace,
        ...(decoderDescription instanceof Uint8Array ?
            { description: decoderDescription } :
            {}),
        displayHeight: preparedVideoTrack.geometry.displayHeight,
        displayWidth: preparedVideoTrack.geometry.displayWidth
    };
}

/** Reads the next decoded sample, recording the wait as a `video-read` when a timing trace runs. */
async function readNextVideoSample(iterator: MediaSampleIterator<VideoSample>): Promise<IteratorResult<VideoSample>> {
    const readStartedAt = startTimingWait();
    const iteratorResult = await iterator.next();
    if (readStartedAt !== null) {
        recordTimingWait('video-read', readStartedAt, {
            mediaTimeMicroseconds: iteratorResult.done ? null : secondsToMicroseconds(iteratorResult.value.timestamp),
            source: 'sample'
        });
    }
    return iteratorResult;
}

async function streamVideoFrames(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack
): Promise<void> {
    if (run.videoDecoderBackend === 'openjpeg') {
        return streamJPEG2000Frames(run, request, preparedVideoTrack);
    }
    if (run.videoDecoderBackend === 'ffmpeg-mpeg2-vc1') {
        return streamMPEG2VC1Frames(run, request, preparedVideoTrack);
    }
    if (preparedVideoTrack.codec === 'hevc') {
        return streamOwnedHEVCFrames(run, request, preparedVideoTrack);
    }
    // The sample sink hides the metadata OBUs, so only the owned path sees an AV1 RPU or HDR10+ metadata
    if (preparedVideoTrack.codec === 'av1') {
        return streamOwnedAV1Frames(run, request, preparedVideoTrack);
    }
    // The sample sink never reads a packet's BlockAdditionals, so only the owned path sees VP9 HDR10+
    if (preparedVideoTrack.codec === 'vp9' && run.videoDecoderBackend === 'native') {
        return streamOwnedVP9Frames(run, request, preparedVideoTrack);
    }

    const sampleSink = new VideoSampleSink(preparedVideoTrack.videoTrack, {
        hardwareAcceleration: preparedVideoTrack.videoHardwareAcceleration,
        optimizeForLatency: true
    });
    const iterator = sampleSink.samples(
        microsecondsToSeconds(request.startTimeMicroseconds)
    ) as unknown as MediaSampleIterator<VideoSample>;
    run.videoIterator = iterator;

    while (await waitForFrameCredit(run)) {
        const iteratorResult = await readNextVideoSample(iterator);
        if (isVideoAttemptStopped(run)) {
            iteratorResult.value?.close();
            return;
        }
        if (iteratorResult.done) {
            return;
        }

        const sample = iteratorResult.value;
        try {
            const timing = getOwnedDecodedVideoTiming({
                kind: 'video-sample',
                sample
            });
            await postVideoFrame(
                run,
                {
                    durationMicroseconds: timing.durationMicroseconds,
                    encodedDolbyVisionMetadata: null,
                    mediaTimeMicroseconds: timing.mediaTimeMicroseconds,
                    source: {
                        kind: 'video-sample',
                        sample
                    }
                },
                preparedVideoTrack.geometry
            );
        } finally {
            sample.close();
        }
    }
}

/** Runs one video attempt and reports how it ended unless a newer request replaced it. */
async function runVideoAttempt(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack,
    startTimeMicroseconds: Microseconds
): Promise<void> {
    run.videoAttemptCancelled = false;
    run.videoTrackEnded = false;
    try {
        await streamVideoFrames(run, { ...request, startTimeMicroseconds }, preparedVideoTrack);
        if (!isVideoAttemptStopped(run)) {
            run.videoTrackEnded = true;
            // Audio can outlast the video track, so its end is reported separately
            postResponse({
                generation: run.generation,
                type: 'video-ended',
                videoEpoch: run.videoEpoch
            });
        }
    } catch (error) {
        markHandledDecodeFailure(error);
        // Failures while a replaced attempt unwinds are expected and discarded
        if (run.cancelled || (!run.videoAttemptCancelled && !isCodecReclamationError(error))) {
            throw error;
        }
        if (!run.videoAttemptCancelled) {
            postResponse({
                generation: run.generation,
                reason: 'decoder-reclaimed',
                type: 'video-interrupted',
                videoEpoch: run.videoEpoch
            });
        }
    } finally {
        await retireVideoAttemptIterators(run);
        refundVideoAttemptCredits(run);
    }
}

/**
 * Streams video as restartable attempts so a suspension or resync never touches audio.
 * Each later attempt starts at the keyframe preceding its resync target.
 */
async function streamVideoAttempts(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack
): Promise<void> {
    let startTimeMicroseconds: Microseconds | null = request.startTimeMicroseconds;
    while (!run.cancelled) {
        if (startTimeMicroseconds === null || run.pendingVideoControl) {
            // An ended, interrupted, or replaced attempt restarts only on resync
            const control = await waitForVideoAttemptResync(run);
            if (!control) {
                return;
            }
            startTimeMicroseconds = control.targetTimeMicroseconds;
        }

        await runVideoAttempt(run, request, preparedVideoTrack, startTimeMicroseconds);
        startTimeMicroseconds = null;
    }
}

/** Returns the audio decode worker, spawning it on first use; a spawn that failed fails each attempt it would serve. */
function getAudioDecodeWorkerClient(): AudioDecodeWorkerClient {
    audioDecodeWorkerClient ??= new AudioDecodeWorkerClient((): Worker => createEngineWorker(AUDIO_DECODE_WORKER_ASSET));
    return audioDecodeWorkerClient;
}

/** Returns the decoder the audio decode worker runs for a track: a bundled one, or none for samples Mediabunny decodes here. */
function getAudioDecodeWorkerDecoderBackend(preparedAudioTrack: PreparedAudioTrack): AudioDecodeWorkerDecoderBackend {
    const decoderBackend = preparedAudioTrack.decoderBackend;
    return decoderBackend === 'mediabunny' ? 'pcm' : decoderBackend;
}

/** Returns where a bundled decoder's packets start: a lead before the start for DTS and TrueHD to synchronize, or the start. */
function getAudioPacketLookupTimeMicroseconds(
    decoderBackend: Exclude<AudioDecodeWorkerDecoderBackend, 'pcm'>,
    startTimeMicroseconds: Microseconds
): Microseconds {
    switch (decoderBackend) {
        case 'dts':
            return getAudioPrerollTimeMicroseconds(startTimeMicroseconds, DTS_SEEK_PREROLL_MICROSECONDS);
        case 'mlp':
        case 'truehd':
            return getAudioPrerollTimeMicroseconds(startTimeMicroseconds, TRUEHD_MAJOR_SYNC_PREROLL_MICROSECONDS);
        case 'eac3':
            return startTimeMicroseconds;
    }
}

/**
 * Opens a decoded PCM attempt in the audio decode worker with the run's newest gains.
 * The attempt takes the worklet channel waiting for it: a resync's, or an initial one the page attached before the attempt opened.
 */
function openAudioDecodeAttempt(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedAudioTrack: PreparedAudioTrack
): AudioDecodeWorkerAttempt {
    const audioOutput = run.pendingAudioOutput;
    run.pendingAudioOutput = null;
    const attempt = getAudioDecodeWorkerClient().openAttempt({
        audioDownmixAlgorithm: request.audioDownmixAlgorithm ?? DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
        audioDownmixSettings: run.latestAudioDownmixSettings ?? createDefaultAudioDownmixSettings(),
        audioEpoch: run.audioEpoch,
        audioOutput,
        decoderBackend: getAudioDecodeWorkerDecoderBackend(preparedAudioTrack),
        generation: run.generation,
        outputChannelCount: preparedAudioTrack.outputChannelCount,
        routeCodec: preparedAudioTrack.routeCodec,
        sourceSampleRate: preparedAudioTrack.sourceSampleRate,
        startTimeMicroseconds: request.startTimeMicroseconds,
        timeResolution: preparedAudioTrack.timeResolution
    }, {
        onChange: (): void => {
            wakeWaiters(run.wakeAudioCreditWaiters);
        },
        onProgress: (response: AudioDecodeWorkerProgressResponse): void => {
            postAudioProgress(run, response);
        },
        onSourceFormat: (response: AudioDecodeWorkerSourceFormatResponse): void => {
            postDecodedAudioSourceFormat(run, response);
        }
    });
    run.audioDecodeAttempt = attempt;
    run.audioOutputAttached = audioOutput !== null;
    return attempt;
}

/**
 * Sends a bundled decoder's packets from the one at the lookup time, in batches, each on an input credit.
 * Returns true at the end of the track, and false once the attempt stops.
 */
async function forwardAudioPackets(
    run: DecodeRun,
    attempt: AudioDecodeWorkerAttempt,
    preparedAudioTrack: PreparedAudioTrack,
    lookupTimeMicroseconds: Microseconds
): Promise<boolean> {
    const packetSink = new EncodedPacketSink(preparedAudioTrack.audioTrack);
    const startPacket = await getAudioStartPacket(packetSink, lookupTimeMicroseconds);
    const iterator = packetSink.packets(startPacket ?? undefined) as unknown as
        MediaSampleIterator<EncodedPacket>;
    run.audioIterator = iterator;
    const batchBuilder = new AudioDecodeWorkerPacketBatchBuilder();
    while (await waitForAudioDecodeInputCredit(run, attempt)) {
        while (!batchBuilder.isFull()) {
            const iteratorResult = await iterator.next();
            if (isAudioAttemptStopped(run)) {
                return false;
            }
            if (iteratorResult.done) {
                const lastBatch = batchBuilder.take();
                if (lastBatch) {
                    attempt.sendInput(lastBatch);
                }
                return true;
            }
            const packet = iteratorResult.value;
            batchBuilder.add(packet.data, requireMicroseconds(packet.microsecondTimestamp, ENCODED_AUDIO_PACKET_TIMESTAMP));
        }
        const batch = batchBuilder.take();
        if (batch) {
            attempt.sendInput(batch);
        }
    }
    return false;
}

/**
 * Sends the samples Mediabunny decodes from the start, cut to it, in batches, each on an input credit.
 * Returns true at the end of the track, and false once the attempt stops.
 */
async function forwardAudioSamples(
    run: DecodeRun,
    attempt: AudioDecodeWorkerAttempt,
    preparedAudioTrack: PreparedAudioTrack,
    startTimeMicroseconds: Microseconds
): Promise<boolean> {
    const sampleSink = new AudioSampleSink(preparedAudioTrack.audioTrack);
    const iterator = sampleSink.samples(
        microsecondsToSeconds(startTimeMicroseconds)
    ) as unknown as MediaSampleIterator<AudioSample>;
    run.audioIterator = iterator;
    const batchBuilder = new AudioDecodeWorkerPCMBatchBuilder();
    while (await waitForAudioDecodeInputCredit(run, attempt)) {
        while (!batchBuilder.isFull()) {
            const iteratorResult = await iterator.next();
            if (isAudioAttemptStopped(run)) {
                iteratorResult.value?.close();
                return false;
            }
            if (iteratorResult.done) {
                const lastBatch = batchBuilder.take();
                if (lastBatch) {
                    attempt.sendInput(lastBatch);
                }
                return true;
            }
            batchBuilder.add(copyAudioSampleWindow(iteratorResult.value, startTimeMicroseconds));
        }
        const batch = batchBuilder.take();
        if (batch) {
            attempt.sendInput(batch);
        }
    }
    return false;
}

/**
 * Streams one decoded PCM attempt through the audio decode worker, which decodes, renders, and feeds the worklet.
 * This worker only demuxes for it, so a bundled decoder or the output stage never holds up video.
 */
async function streamDecodedAudio(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedAudioTrack: PreparedAudioTrack
): Promise<void> {
    const attempt = openAudioDecodeAttempt(run, request, preparedAudioTrack);
    const decoderBackend = getAudioDecodeWorkerDecoderBackend(preparedAudioTrack);
    const trackEnded = decoderBackend === 'pcm' ?
        await forwardAudioSamples(run, attempt, preparedAudioTrack, request.startTimeMicroseconds) :
        await forwardAudioPackets(
            run,
            attempt,
            preparedAudioTrack,
            getAudioPacketLookupTimeMicroseconds(decoderBackend, request.startTimeMicroseconds)
        );
    if (!trackEnded) {
        return;
    }
    attempt.finish();
    await waitForAudioDecodeAttemptFinished(run, attempt);
}

function takeOwnedArrayBuffer(data: Uint8Array): ArrayBuffer {
    if (data.buffer instanceof ArrayBuffer
        && data.byteOffset === 0
        && data.byteLength === data.buffer.byteLength) {
        return data.buffer;
    }
    return data.slice().buffer;
}

async function postNativeAudioOutput(run: DecodeRun, output: NativeMediaAudioFMP4RemuxOutput): Promise<boolean> {
    let initializationSegment = output.initializationSegment;
    for (const segment of output.mediaSegments) {
        if (!await waitForAudioSampleCredit(run)) {
            return false;
        }
        if (initializationSegment) {
            const initializationData = takeOwnedArrayBuffer(initializationSegment);
            postResponse({
                data: initializationData,
                generation: run.generation,
                type: 'native-audio-init'
            }, [ initializationData ]);
            initializationSegment = null;
        }
        const data = takeOwnedArrayBuffer(segment.data);
        postResponse({
            data,
            endTimeMicroseconds: segment.endTimeMicroseconds,
            generation: run.generation,
            startTimeMicroseconds: segment.startTimeMicroseconds,
            type: 'native-audio-media'
        }, [ data ]);
    }
    if (initializationSegment) {
        throw new UnsupportedCustomDecodeSourceError(
            'Native audio initialization was emitted without a media fragment'
        );
    }
    return true;
}

async function streamNativeAudioPackets(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedAudioTrack: PreparedAudioTrack
): Promise<void> {
    const audioConfiguration = preparedAudioTrack.audioConfiguration;
    if (!('outputMode' in audioConfiguration)
        || audioConfiguration.outputMode !== 'native-media') {
        throw new UnsupportedCustomDecodeSourceError('Native audio configuration is unavailable');
    }
    const codec: NativeMediaAudioFMP4Codec = audioConfiguration.codec === 'ac-3' ?
        'ac3' :
        'eac3';
    const decoderConfig = preparedAudioTrack.decoderConfig;
    if (!decoderConfig) {
        throw new UnsupportedCustomDecodeSourceError('Native audio decoder configuration is unavailable');
    }
    const packetSink = new EncodedPacketSink(preparedAudioTrack.audioTrack);
    const startPacket = await getAudioStartPacket(packetSink, request.startTimeMicroseconds);
    const iterator = packetSink.packets(startPacket ?? undefined) as unknown as
        MediaSampleIterator<EncodedPacket>;
    run.audioIterator = iterator;
    const remuxer = new NativeMediaAudioFMP4Remuxer({
        channelCount: audioConfiguration.channelCount as 2 | 6,
        codec,
        decoderConfig,
        sampleRate: 48_000
    });

    try {
        await remuxer.start();
        while (!run.cancelled) {
            const iteratorResult = await iterator.next();
            if (run.cancelled) {
                return;
            }
            if (iteratorResult.done) {
                break;
            }
            const packet = iteratorResult.value;
            await remuxer.addPacket({
                data: packet.data,
                durationMicroseconds: requireMicroseconds(
                    packet.microsecondDuration,
                    'Encoded audio packet duration'
                ),
                sequenceNumber: packet.sequenceNumber,
                timestampMicroseconds: requireMicroseconds(
                    packet.microsecondTimestamp,
                    ENCODED_AUDIO_PACKET_TIMESTAMP
                ),
                type: packet.type
            });
            if (!await postNativeAudioOutput(run, remuxer.takeOutput())) {
                return;
            }
        }
        if (run.cancelled) {
            return;
        }
        await remuxer.finalize();
        await postNativeAudioOutput(run, remuxer.takeOutput());
    } finally {
        await remuxer.cancel();
    }
}

function streamPreparedAudio(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedAudioTrack: PreparedAudioTrack
): Promise<void> {
    switch (preparedAudioTrack.outputMode) {
        case 'decoded-pcm':
            return streamDecodedAudio(run, request, preparedAudioTrack);
        case 'native-media':
            return streamNativeAudioPackets(run, request, preparedAudioTrack);
    }
}

/** Rebuilds only the decoded output stage; the track and decoder backend stay */
function createAudioAttemptTrack(
    preparedAudioTrack: PreparedAudioTrack,
    outputChannelCount: CustomAudioOutputChannelCount
): PreparedAudioTrack {
    if (preparedAudioTrack.outputMode !== 'decoded-pcm') {
        throw new UnsupportedCustomDecodeSourceError('Only decoded PCM audio can change its output layout');
    }
    return {
        ...preparedAudioTrack,
        audioConfiguration: {
            ...preparedAudioTrack.audioConfiguration,
            channelCount: outputChannelCount
        },
        outputChannelCount
    };
}

/**
 * Takes a pending resync for the next audio attempt: its epoch, its channel, its gains, and its layout.
 * The replaced attempt closed as the resync arrived, so the next one opens with the resync's channel.
 */
function takeAudioAttemptControl(run: DecodeRun, control: AudioAttemptControl): void {
    run.pendingAudioControl = null;
    run.audioEpoch = control.audioEpoch;
    closeAudioDecodeAttempt(run);
    run.pendingAudioOutput = control.audioOutput;
    run.audioStreamFinished = false;
    run.latestAudioDownmixSettings = control.audioDownmixSettings ?? run.latestAudioDownmixSettings;
}

/**
 * Streams audio as restartable attempts so an output layout change never touches video.
 * A later attempt starts at its resync target with a rebuilt output stage, and a finished track still accepts a resync until video finishes too.
 */
async function streamAudioAttempts(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedAudioTrack: PreparedAudioTrack
): Promise<void> {
    let attemptRequest = request;
    let attemptTrack = preparedAudioTrack;
    while (!run.cancelled) {
        const control = run.pendingAudioControl;
        if (control) {
            takeAudioAttemptControl(run, control);
            attemptTrack = createAudioAttemptTrack(preparedAudioTrack, control.decodedAudioOutputChannelCount);
            attemptRequest = {
                ...request,
                audioDownmixAlgorithm: control.audioDownmixAlgorithm
                    ?? request.audioDownmixAlgorithm,
                decodedAudioOutputChannelCount: control.decodedAudioOutputChannelCount,
                startTimeMicroseconds: control.targetTimeMicroseconds
            };
        }

        run.audioAttemptCancelled = false;
        try {
            await streamPreparedAudio(run, attemptRequest, attemptTrack);
        } catch (error) {
            markHandledDecodeFailure(error);
            // Failures while a replaced attempt unwinds are expected and discarded
            if (run.cancelled || !run.audioAttemptCancelled) {
                throw error;
            }
        } finally {
            await retireAudioAttemptIterator(run);
        }
        if (run.cancelled) {
            return;
        }
        if (run.audioAttemptCancelled) {
            continue;
        }

        // A video stream that reached its end no longer waits for a resync
        run.audioStreamFinished = true;
        wakeWaiters(run.wakeVideoControlWaiters);
        // The final underflow is the end of the track, not starvation, while video plays on
        postResponse({
            audioEpoch: run.audioEpoch,
            generation: run.generation,
            type: 'audio-ended'
        });
        if (!await waitForAudioAttemptResync(run)) {
            return;
        }
    }
}

/**
 * Runs one generation from its start to its `stopped`, which always comes last.
 * The worker outlives the run: everything the run opened is released before `stopped`, and the next run starts only after it.
 */
async function decodeMedia(run: DecodeRun, request: Extract<DecodeWorkerRequest, { type: 'start' }>): Promise<void> {
    let reportDecodeStreamFailure = false;
    if (request.timingTrace === true && !run.cancelled) {
        startWorkerTimingTrace((events): void => {
            postResponse({ events, generation: run.generation, type: 'timing-trace' });
        });
    }
    try {
        // A run stopped while its predecessor unwound never opens its input
        if (run.cancelled) {
            return;
        }
        const input = new Input({
            formats: withMatroskaBlockAdditions(CUSTOM_DECODE_INPUT_FORMATS),
            source: new UrlSource(request.url, {
                fetchFn: validatedRangeFetch,
                getRetryDelay,
                maxCacheSize: URL_SOURCE_CACHE_BYTES,
                parallelism: URL_SOURCE_PARALLELISM
            })
        });
        run.input = input;
        const preparedTrackPromises: [
            Promise<PreparedVideoTrack>,
            Promise<PreparedAudioTrack | null>
        ] = [
            prepareVideoTrack(input, run, request),
            request.audioTrackIndex === null ?
                Promise.resolve(null) :
                prepareAudioTrack(
                    input,
                    run,
                    request.audioTrackIndex,
                    request.audioOutputMode ?? 'decoded-pcm',
                    request.decodedAudioOutputChannelCount
                        ?? CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT
                )
        ];
        const [ preparedVideoTrack, preparedAudioTrack ] = await Promise.all(preparedTrackPromises);
        if (run.cancelled) {
            return;
        }

        const containerDurationMicroseconds = request.reportContainerDuration === true ?
            await readContainerDurationMicroseconds(input, preparedVideoTrack.videoTrack) :
            null;
        if (run.cancelled) {
            return;
        }

        postReadyResponse(run, preparedVideoTrack, preparedAudioTrack, containerDurationMicroseconds);
        run.audioStreamFinished = preparedAudioTrack === null;
        const streamPromises: Array<Promise<void>> = [];
        streamPromises.push(
            streamVideoAttempts(run, request, preparedVideoTrack).then((): void => {
                // Finished audio stops waiting for a resync once video is done too
                run.videoStreamFinished = true;
                wakeWaiters(run.wakeAudioControlWaiters);
            })
        );
        if (preparedAudioTrack) {
            streamPromises.push(streamAudioAttempts(run, request, preparedAudioTrack));
        }
        await settleConcurrentDecodeStreams(streamPromises, (): void => {
            // Preserve the first active-stream failure after cancelling siblings
            reportDecodeStreamFailure = !run.cancelled;
            stopRun(run);
        });
        if (!run.cancelled) {
            postResponse({ generation: run.generation, type: 'ended' });
        }
    } catch (error) {
        markHandledDecodeFailure(error);
        if (!run.cancelled || reportDecodeStreamFailure) {
            postResponse({
                failureKind: classifyFailure(error),
                generation: run.generation,
                message: getSafeErrorMessage(error),
                type: 'error'
            });
        }
    } finally {
        stopRun(run);
        if (run.iteratorRetirementPromise) {
            await run.iteratorRetirementPromise;
        }
        // The audio decode worker released each attempt's decoder, output stage, and worklet channel
        await Promise.all(run.audioDecodeAttemptClosures);
        await waitForHEVCSoftwareVideoDecoderShutdown();
        if (currentRun === run) {
            currentRun = null;
        }
        // The page drops a retired run's messages once it stops, so its last timing events go first
        stopWorkerTimingTrace();
        postResponse({
            generation: run.generation,
            ...(isWorkerReplacementRequired() ? { replaceWorker: true } : {}),
            type: 'stopped'
        });
    }
}

/** Whether a decoder whose call failed may still be open, or the audio decode worker was lost; either way a fresh worker serves the next run. */
function isWorkerReplacementRequired(): boolean {
    return unclosedDecoderSuspected || (audioDecodeWorkerClient !== null && audioDecodeWorkerClient.failure !== null);
}

function createDecodeRun(request: Extract<DecodeWorkerRequest, { type: 'start' }>): DecodeRun {
    return {
        audioAttemptCancelled: false,
        audioDecodeAttempt: null,
        audioDecodeAttemptClosures: [],
        audioEpoch: 0,
        audioIterator: null,
        audioOutputAttached: false,
        audioSampleCredits: request.audioSampleCredits,
        audioStreamFinished: false,
        cancelled: false,
        decodedVideoGeometry: null,
        enhancementPacketPairer: null,
        frameCredits: request.frameCredits,
        generation: request.generation,
        input: null,
        iteratorRetirementPromise: null,
        latestAudioDownmixSettings: request.audioDownmixSettings,
        maximumCodedHeight: request.maximumCodedHeight,
        maximumCodedWidth: request.maximumCodedWidth,
        metadataAbortController: null,
        nativeHDRTransfer: request.nativeHDRTransfer,
        neutralizeHDRColorMetadata: request.neutralizeHDRColorMetadata,
        outstandingRawFrameBufferCount: 0,
        pendingAudioControl: null,
        pendingAudioOutput: null,
        pendingVideoControl: null,
        rawFrameBufferPool: createRawFrameBufferPool(request.videoOutputMode),
        rawVideoFrameFormat: request.rawVideoFrameFormat,
        videoAttemptCancelled: false,
        videoAttemptConsumedCreditCount: 0,
        videoAttemptPostedFrameCount: 0,
        videoDecoderBackend: request.videoDecoderBackend,
        videoEpoch: 0,
        videoOutputMode: request.videoOutputMode,
        videoIterator: null,
        videoStreamFinished: false,
        videoTrackEnded: false,
        wakeAudioControlWaiters: [],
        wakeAudioCreditWaiters: [],
        wakeFrameCreditWaiters: [],
        wakeVideoControlWaiters: [],
        wakeVideoDecodeWaiters: []
    };
}

function registerRequiredVideoDecoder(request: Extract<DecodeWorkerRequest, { type: 'start' }>): void {
    if (request.videoDecoderBackend === 'bundled-hevc') {
        registerHEVCSoftwareVideoDecoder();
    }
}

function handleVideoControlRequest(
    request: Extract<DecodeWorkerRequest, { type: 'resync-video' | 'suspend-video' }>
): void {
    if (currentRun?.generation !== request.generation) {
        return;
    }

    requestVideoAttemptControl(currentRun, request.type === 'resync-video' ?
        {
            kind: 'resync',
            targetTimeMicroseconds: request.targetTimeMicroseconds,
            videoEpoch: request.videoEpoch
        } :
        {
            kind: 'suspend',
            videoEpoch: request.videoEpoch
        });
}

function handleAudioControlRequest(request: Extract<DecodeWorkerRequest, { type: 'resync-audio' }>): void {
    if (currentRun?.generation !== request.generation) {
        request.audioOutput.port.close();
        return;
    }

    requestAudioAttemptControl(currentRun, {
        audioDownmixAlgorithm: request.audioDownmixAlgorithm,
        audioDownmixSettings: request.audioDownmixSettings,
        audioEpoch: request.audioEpoch,
        audioOutput: request.audioOutput,
        decodedAudioOutputChannelCount: request.decodedAudioOutputChannelCount,
        targetTimeMicroseconds: request.targetTimeMicroseconds
    });
}

/**
 * Hands the initial decoded attempt its channel to the worklet, or keeps the channel until the attempt opens.
 * A channel for a run or an attempt that will never open it is closed.
 */
function attachAudioOutput(request: Extract<DecodeWorkerRequest, { type: 'attach-audio-output' }>): void {
    const run = currentRun;
    if (run?.generation !== request.generation
        || run.cancelled
        || run.audioEpoch !== request.audioEpoch
        || run.pendingAudioControl
        || run.pendingAudioOutput
        || run.audioOutputAttached) {
        request.audioOutput.port.close();
        return;
    }
    const attempt = run.audioDecodeAttempt;
    if (!attempt) {
        run.pendingAudioOutput = request.audioOutput;
        return;
    }
    attempt.attachOutput(request.audioOutput);
    run.audioOutputAttached = true;
}

/** Applies live downmix gains to the run's open stereo attempt, and keeps them for the attempts it opens later. */
function updateAudioDownmixSettings(request: Extract<DecodeWorkerRequest, { type: 'update-audio-downmix-settings' }>): void {
    const run = currentRun;
    if (run?.generation !== request.generation || run.cancelled) {
        return;
    }
    run.latestAudioDownmixSettings = request.audioDownmixSettings;
    // A pending resync carries older gains than this update
    if (run.pendingAudioControl) {
        run.pendingAudioControl.audioDownmixSettings = request.audioDownmixSettings;
    }
    audioDecodeWorkerClient?.updateDownmixSettings(request.generation, request.audioDownmixSettings);
}

/** Replaces the current run with a new generation's, which starts once the previous run posted `stopped`. */
function startDecodeRun(request: Extract<DecodeWorkerRequest, { type: 'start' }>): void {
    if (currentRun) {
        stopRun(currentRun);
    }
    registerRequiredVideoDecoder(request);
    if (request.audioTrackIndex !== null && (request.audioOutputMode ?? 'decoded-pcm') === 'decoded-pcm') {
        // Its script loads while the run opens its input
        getAudioDecodeWorkerClient();
    }

    const run = createDecodeRun(request);
    currentRun = run;
    // A stopping run waits for every bundled HEVC decoder in the worker, so the next run starts only once it posted `stopped`
    const startRun = (): Promise<void> => decodeMedia(run, request);
    previousRunCompletion = previousRunCompletion.then(startRun, startRun);
}

function handleRequest(requestValue: unknown): void {
    if (!isDecodeWorkerRequest(requestValue)) {
        return;
    }

    switch (requestValue.type) {
        case 'attach-audio-output':
            attachAudioOutput(requestValue);
            break;
        case 'start':
            startDecodeRun(requestValue);
            break;
        case 'pull':
            if (
                currentRun?.generation === requestValue.generation
                && currentRun.videoOutputMode === 'video-frame'
            ) {
                addFrameCredits(currentRun, requestValue.frameCredits);
            }
            break;
        case 'pull-audio':
            // Native media segment credits; decoded PCM credits return from the audio decode worker
            if (
                currentRun?.generation === requestValue.generation
                && (requestValue.audioEpoch ?? 0) === currentRun.audioEpoch
            ) {
                addAudioSampleCredits(currentRun, requestValue.audioSampleCredits);
            }
            break;
        case 'recycle-frame':
            if (
                currentRun?.generation === requestValue.generation
                && currentRun.videoOutputMode === 'raw-planes'
                && !currentRun.cancelled
                && currentRun.outstandingRawFrameBufferCount > 0
            ) {
                currentRun.outstandingRawFrameBufferCount -= 1;
                // The returned buffer becomes a spare for the next drained frame or copy; the pool drops it past its bound
                currentRun.rawFrameBufferPool?.release(requestValue.buffer);
                addFrameCredits(currentRun, 1);
            }
            break;
        case 'resync-audio':
            handleAudioControlRequest(requestValue);
            break;
        case 'resync-video':
        case 'suspend-video':
            handleVideoControlRequest(requestValue);
            break;
        case 'stop':
            if (currentRun?.generation === requestValue.generation) {
                stopRun(currentRun);
            }
            break;
        case 'update-audio-downmix-settings':
            updateAudioDownmixSettings(requestValue);
            break;
    }
}

workerScope.addEventListener('message', event => {
    handleRequest(event.data);
});
suppressHandledDecodeFailureRejections(self, (): void => {
    unclosedDecoderSuspected = true;
});

/* eslint-enable no-restricted-globals */
