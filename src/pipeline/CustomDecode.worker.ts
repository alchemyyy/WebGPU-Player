/* eslint-disable no-restricted-globals */
import {
    ALL_FORMATS,
    BlobSource,
    Input,
    MpegTsInputFormat,
    PacketReader,
    UrlSource,
    type AudioSample,
    type AudioCodec,
    type EncodedPacket,
    type InputAudioTrack,
    type InputVideoTrack,
    type Source,
    type VideoCodec,
    type VideoSample
} from 'mediabunny';

import { microsecondsToSeconds, secondsToMicroseconds, type Microseconds } from '../MediaTime';
import { hasIncompleteAVIIndex } from '../demux/AVIIndexCoverage';
import { iterateAudioSamples, iterateTrackPackets, iterateVideoSamples } from '../demux/TrackIteration';
import { findUnsupportedTrackFeature } from '../demux/UnsupportedTrackFeatures';
import { getTransportStreamVideoCodec, readTransportStreamVideoDecoderDescription } from '../demux/mpeg/MPEGTransportStreamVideoConfiguration';
import { isDolbyVisionDualLayerProfile } from '../demux/dolby-vision/DolbyVisionProfiles';
import { getAudioSampleWindow } from '../audio/AudioSampleWindow';
import { settleConcurrentDecodeStreams } from './ConcurrentDecodeStreams';
import {
    recordTimingEvent,
    recordTimingWait,
    startTimingWait,
    startWorkerTimingTrace,
    stopWorkerTimingTrace
} from '../TimingTrace';
import {
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
    type CustomAudioDownmixAlgorithm
} from '../audio/processing/CustomAudioDownmixAlgorithm';
import {
    getCustomAudioChannelLayout,
    type CustomAudioChannelLayout,
    type CustomAudioOutputChannelCount
} from '../audio/processing/CustomAudioChannelLayout';
import { getQualifiedCustomWaveChannelLayout } from '../audio/processing/CustomWaveChannelLayout';
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
} from '../demux/AudioStartPacket';
import {
    getContainerAudioCodec,
    getDeclaredAudioSampleRate,
    isDTSExpressTrack
} from '../demux/CustomAudioTrackMetadata';
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
    getVideoCreditLimit,
    isDecodeWorkerRequest,
    MAX_DECODED_AUDIO_CHANNELS,
    MAX_DECODED_AUDIO_SAMPLE_CREDITS,
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
import { getTrackByOrdinal } from '../demux/CustomDecodeTrackSelection';
import type { CustomDecodeMediaSource } from '../demux/CustomDecodeMediaSource';
import { URLSourceRetention } from '../demux/URLSourceRetention';
import {
    DecodedVideoGeometryError,
    exceedsNegotiatedCodedSize,
    requireConsistentDecodedVideoGeometry
} from '../decode/video/DecodedVideoGeometry';
import DolbyVisionEncodedMetadataQueue, {
    DolbyVisionAV1EncodedMetadataQueue,
    getHEVCNALFormat,
    type ProcessedDolbyVisionHEVCPacket
} from '../demux/dolby-vision/DolbyVisionEncodedMetadata';
import DolbyVisionEncodedPacketPairer from '../demux/dolby-vision/DolbyVisionEncodedPacketPairer';
import {
    parseHEVCNALUnits,
    splitDolbyVisionHEVCAccessUnit,
    type HEVCNALFormat,
    type HEVCNALUnit
} from '../demux/dolby-vision/DolbyVisionHEVCSplitter';
import {
    getDolbyVisionEncodedMetadataTransferList,
    takeTransferableDolbyVisionEncodedFrameMetadata,
    type DolbyVisionEncodedFrameMetadata
} from '../demux/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import { DolbyVisionRPUParseError } from '../demux/dolby-vision/DolbyVisionRPUParser';
import DolbyVisionRPUParserSession from '../demux/dolby-vision/DolbyVisionRPUParserSession';
import { parseHEVCDecoderConfiguration } from '../demux/hevc/HEVCDecoderConfiguration';
import { scanHEVCStaticHDRMetadata } from '../demux/hdr/HEVCStaticHDRMetadata';
import {
    hasAV1PQSequenceHeader,
    scanAV1StaticHDRMetadata
} from '../demux/hdr/AV1StaticHDRMetadata';
import HEVCDynamicHDRMetadataQueue from '../decode/video/HEVCDynamicHDRMetadataQueue';
import type { HDR10PlusFrameMetadata } from '../demux/hdr/HDR10PlusMetadata';
import {
    requireValidByteRangeResponse,
    UnsupportedRangeResponseError
} from '../demux/HTTPRangeResponse';
import {
    isRetryableMediaFetchError,
    MediaNetworkError,
    requireSuccessfulMediaHTTPResponse
} from '../demux/MediaFetchPolicy';
import RawFrameBufferPool, { MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH } from '../decode/video/RawFrameBufferPool';
import {
    copyVideoFramePairToRawPlanes,
    copyVideoFrameToRawPlanes,
    getRawVideoFramePairTransferList,
    getRawVideoFrameTransferList,
    type RawVideoFrameGeometry,
    type RawVideoFrameSource
} from '../decode/video/RawVideoFrameCopy';
import { requireMicroseconds } from '../TimeMath';
import { GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH, MAXIMUM_GPU_DECODE_OUTPUT_EVENTS } from '../decode/video/gpu/GPUDecodeLimits';
import {
    getGPUDecoderParserFailureRecovery,
    type GPUDecoderParserOutput,
    type GPUDecoderParserPicture
} from '../decode/video/gpu/GPUDecoderParser';
import type { GPUDecoderParserRemotePipeline } from '../decode/video/gpu/GPUDecoderCoordinatorHost';
import type { GPUDecoderOutputFormat } from '../decode/video/gpu/GPUDecodeFormats';
import type { GPUDecoderPictureSize, GPUVideoDecodeRecovery } from '../decode/video/gpu/GPUDecodeTypes';
import { openGPUDecoderParser } from '../decode/video/gpu/GPUDecoderWorkerCoordinator';
import NativeMediaAudioFMP4Remuxer, {
    type NativeMediaAudioFMP4Codec,
    type NativeMediaAudioFMP4RemuxOutput
} from '../audio/native/NativeMediaAudioFMP4Remuxer';
import OwnedNativeHEVCVideoDecoder from '../decode/video/native/OwnedNativeHEVCVideoDecoder';
import OwnedNativeVideoDecoder from '../decode/video/native/OwnedNativeVideoDecoder';
import {
    NativeHDRAV1TemporalUnitNeutralizer,
    neutralizeNativeHDRAV1DecoderConfig,
    type AV1HDRTransfer,
    type NeutralizedNativeHDRAV1DecoderConfig
} from '../decode/video/native/NativeHDRAV1ColorNeutralizer';
import { runOwnedAV1VideoStream } from '../decode/video/native/OwnedAV1VideoStream';
import { runOwnedVP9VideoStream } from '../decode/video/native/OwnedVP9VideoStream';
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
} from '../decode/video/native/OwnedVideoDecodeStream';
import { readISOBaseMediaDolbyVisionTrackConfiguration } from '../demux/dolby-vision/ISOBaseMediaDolbyVisionConfiguration';
import {
    readMatroskaDolbyVisionTrackConfiguration
} from '../demux/dolby-vision/MatroskaDolbyVisionHVCE';
import {
    readMPEGTransportStreamDolbyVisionTrackConfiguration
} from '../demux/dolby-vision/MPEGTransportStreamDolbyVisionConfiguration';
import type { AudioDecoderPackageSelection } from '../decode/audio/AudioDecoderPackageInstance';
import { readVC1TrackConfiguration, VC1_TRACK_INTERNAL_CODEC_IDS, type VC1TrackCodec } from '../demux/vc1/VC1TrackConfiguration';
import {
    MATROSKA_MPEG1_CODEC_ID,
    MATROSKA_MPEG2_CODEC_ID,
    readMatroskaMPEGVideoDecoderDescription
} from '../demux/mpeg/MatroskaMPEGVideoConfiguration';
import { readMatroskaBlockAdditions, type MatroskaBlockAddition } from '../demux/MatroskaBlockAdditions';
import { readContainerVideoScan } from '../demux/ContainerVideoScan';
import { getScanFrameFields, type VideoFrameFields } from '../decode/video/VideoFields';
import { readsChromaInBand, readVideoChromaFormat, type VideoChromaFormat } from '../demux/VideoChromaFormat';
import {
    MAXIMUM_STATIC_HDR_METADATA_SCAN_ACCESS_UNIT_COUNT,
    type StaticHDRMetadataScanResult
} from '../demux/hdr/StaticHDRMetadata';

// A run's read cache, a file's, or a URL's until the first preparation over it sizes it by the media's bitrate
const MEDIA_SOURCE_CACHE_BYTES = 32 * 1024 * 1024;
const URL_SOURCE_PARALLELISM = 2;
const MAX_NETWORK_RETRY_ATTEMPTS = 2;
const NETWORK_RETRY_BASE_SECONDS = 0.25;
const OWNED_HEVC_PACKET_OPTIONS = {
    metadataOnly: false,
    verifyKeyPackets: true
} as const;
const OWNED_NATIVE_PACKET_OPTIONS = {
    metadataOnly: false,
    verifyKeyPackets: true
} as const;
const STATIC_HDR_METADATA_PACKET_OPTIONS = { metadataOnly: false } as const;
const GPU_DECODE_PACKET_OPTIONS = {
    metadataOnly: false,
    verifyKeyPackets: true
} as const;
// The packets a parser's restart holds, whose timing alone reaches the page
const GPU_DECODE_HOLD_PACKET_OPTIONS = { metadataOnly: true } as const;
// Pictures a GPU decoder's CPU parser makes ahead of the credits, so its parse workers keep working while the page decodes; a packet still parsing counts as one
const GPU_DECODE_PARSER_READ_AHEAD = 8;
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
    /** The parser pipeline the run opened before its readiness, which its first frame-pool attempt takes */
    preparedGPUDecodeParser: GPUDecoderParserRemotePipeline | null
    rawFrameBufferPool: RawFrameBufferPool | null
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    /** Ends the current video attempt without stopping audio or the run */
    videoAttemptCancelled: boolean
    videoAttemptConsumedCreditCount: number
    videoAttemptPostedFrameCount: number
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
    /** Tags posted frames so the session can drop frames from replaced attempts */
    videoEpoch: number
    /** The fields of the video track's container scan, which every posted frame and picture without its own carries; null while the container names none */
    videoFrameFields: VideoFrameFields | null
    videoOutputMode: CustomDecodeVideoOutputMode
    videoIterator: MediaSampleIterator<EncodedPacket> | MediaSampleIterator<VideoSample> | null
    /** Set once the video stream unwinds so finished audio stops waiting for a resync */
    videoStreamFinished: boolean
    /** The latest video attempt reached the end of its track; a suspended or interrupted one did not */
    videoTrackEnded: boolean
    /** The retained URL source the run's input reads, whose waiting reads the run's stop cancels; null for a file */
    urlSource: UrlSource | null
    /** The output events a frame-pool attempt's last packets decided without a picture to carry them, which its end carries */
    videoTrailingOutputEvents: Uint32Array | null
    wakeAudioControlWaiters: Array<() => void>
    wakeAudioCreditWaiters: Array<() => void>
    wakeFrameCreditWaiters: Array<() => void>
    wakeVideoControlWaiters: Array<() => void>
    wakeVideoDecodeWaiters: Array<() => void>
};

type PreparedVideoTrack = {
    availableVideoTracks: readonly InputVideoTrack[]
    codec: VideoCodec | FocusedVideoRoute['codec']
    containerTrackNumber: number
    decoderConfig: VideoDecoderConfig
    geometry: RawVideoFrameGeometry
    staticHDRMetadataScan?: StaticHDRMetadataScanResult
    /** The native decoder hint the route's capability probes measured for this codec */
    videoHardwareAcceleration: HardwareAcceleration
    videoTrack: InputVideoTrack
};

/** A dual-layer EL in its own track, which carries the RPUs of its BL's frames; no decoder decodes the EL itself. */
type SeparateDolbyVisionEnhancementTrack = {
    packetFormat: HEVCNALFormat
    videoTrack: InputVideoTrack
};

type SeparateDolbyVisionEnhancementPacketStream = {
    inputFormat: HEVCNALFormat
    pairer: DolbyVisionEncodedPacketPairer
};

/** Where the container says a dual-layer EL track is; the description frames its packets when the track itself has none. */
type SeparateDolbyVisionEnhancementTrackReference = {
    decoderDescription: Uint8Array | null
    trackNumber: number
};

type PreparedAudioTrack = {
    audioConfiguration: DecodeWorkerReadyAudioConfiguration
    audioTrack: InputAudioTrack
    // Mediabunny decodes samples here, or the audio decode worker runs a host's decoder package
    decoderBackend: 'mediabunny' | 'package'
    /** The WAVE channel mask the container declares, which lays out the samples Mediabunny decodes, or null to lay them out by count */
    declaredChannelMask: number | null
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
    /** The WAVE channel mask the container declares, which `inputChannelLayout` follows, or null */
    declaredChannelMask: number | null
    inputChannelLayout: CustomAudioChannelLayout
    sampleRate: number
    timeResolution: number
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
// The run that control requests address; a run replaced here unwinds beside it until it posts `stopped`
let currentRun: DecodeRun | null = null;
// The run whose timing trace buffers this worker's events, which only that run's end stops
let timingTraceRun: DecodeRun | null = null;
// The audio decode worker this worker spawns for its first decoded PCM run and keeps for every later one; a lost one is spawned again for the next run
let audioDecodeWorkerClient: AudioDecodeWorkerClient | null = null;
// The last run's URL source, which the next run over the same media reads on
const urlSourceRetention = new URLSourceRetention();

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
        case 'frame-pool':
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

/**
 * Returns a fetch for a URL source's ranged requests: it reports transport failures without the URL's query, and requires a successful response
 * that describes the requested range, a cross-origin 206 that hides Content-Range passing only from the paths the source's pattern names.
 */
function createValidatedRangeFetch(hiddenContentRangePathPattern: RegExp | null): typeof fetch {
    return async (input: RequestInfo | URL, requestInit?: RequestInit): Promise<Response> => {
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
        requireValidByteRangeResponse(requestHeaders.get('Range'), response, hiddenContentRangePathPattern);
        return response;
    };
}

/**
 * Opens a run's media: a URL through ranged requests under the fetch policy, on the last run's source when it reads the same URL,
 * or a file through reads of its own bytes.
 */
function openMediaSource(run: DecodeRun, source: CustomDecodeMediaSource): Source {
    switch (source.kind) {
        case 'file':
            urlSourceRetention.release();
            return new BlobSource(source.file, { maxCacheSize: MEDIA_SOURCE_CACHE_BYTES });
        case 'url': {
            const hiddenContentRangePathPattern = source.hiddenContentRangePathPattern ?? null;
            // The pattern is part of what the source's validated fetch reads
            const key = JSON.stringify([ source.url, hiddenContentRangePathPattern?.source ?? null, hiddenContentRangePathPattern?.flags ?? null ]);
            run.urlSource = urlSourceRetention.acquire(key, (): UrlSource => new UrlSource(source.url, {
                fetchFn: createValidatedRangeFetch(hiddenContentRangePathPattern),
                getRetryDelay,
                maxCacheSize: MEDIA_SOURCE_CACHE_BYTES,
                parallelism: URL_SOURCE_PARALLELISM
            }), run);
            return run.urlSource;
        }
    }
}

function wakeWaiters(waiters: Array<() => void>): void {
    const activeWaiters = waiters.splice(0);
    for (const waiter of activeWaiters) {
        waiter();
    }
}

function addFrameCredits(run: DecodeRun, frameCredits: number): void {
    run.frameCredits = Math.min(getVideoCreditLimit(run.videoOutputMode), run.frameCredits + frameCredits);
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
    // The retained source outlives the input, so the reads the input still waits for are canceled, and the next run's reads take the network at once
    run.urlSource?.cancelReads();
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

/** How a GPU decoder reads a track of a codec Mediabunny does not decode: by the container codec IDs of the tracks it takes. */
type FocusedVideoRoute = Readonly<{
    codec: 'jpeg2000' | 'mpeg1video' | 'mpeg2video' | VC1TrackCodec
    decoderCodec: string
    errorName: string
    includeColorSpace: boolean
    internalCodecIDs: readonly string[]
}>;

type FocusedVideoTrackInput = Readonly<{
    availableVideoTracks: readonly InputVideoTrack[]
    codedHeight: number
    codedWidth: number
    containerCodec: VideoCodec | null
    displayHeight: number
    displayWidth: number
    internalCodecID: unknown
    request: Extract<DecodeWorkerRequest, { type: 'start' }>
    /** Whether the track is an MPEG-TS or M2TS track, whose codec Mediabunny names and which carries no codec private data */
    transportStream: boolean
    videoTrack: InputVideoTrack
}>;

const JPEG2000_FOCUSED_ROUTE: FocusedVideoRoute = {
    codec: 'jpeg2000',
    decoderCodec: 'mjp2',
    errorName: 'MJ2',
    includeColorSpace: false,
    internalCodecIDs: [ 'mjp2' ]
};
// VC-1 Advanced profile in Matroska VfW tracks and ISO base media vc-1 sample entries
const VC1_FOCUSED_ROUTE: FocusedVideoRoute = {
    codec: 'vc1',
    decoderCodec: 'vc1',
    errorName: 'VC-1',
    includeColorSpace: true,
    internalCodecIDs: VC1_TRACK_INTERNAL_CODEC_IDS.vc1
};
// WMV3, the VC-1 Simple and Main profiles, in Matroska VfW tracks
const WMV3_FOCUSED_ROUTE: FocusedVideoRoute = {
    codec: 'wmv3',
    decoderCodec: 'wmv3',
    errorName: 'WMV3',
    includeColorSpace: true,
    internalCodecIDs: VC1_TRACK_INTERNAL_CODEC_IDS.wmv3
};
const MPEG1_FOCUSED_ROUTE: FocusedVideoRoute = {
    codec: 'mpeg1video',
    decoderCodec: 'mpeg1video',
    errorName: 'MPEG-1',
    includeColorSpace: true,
    internalCodecIDs: [ MATROSKA_MPEG1_CODEC_ID ]
};
const MPEG2_FOCUSED_ROUTE: FocusedVideoRoute = {
    codec: 'mpeg2video',
    decoderCodec: 'mpeg2video',
    errorName: 'MPEG-2',
    includeColorSpace: true,
    internalCodecIDs: [ MATROSKA_MPEG2_CODEC_ID ]
};

/** Returns how a GPU decoder reads a track of a codec Mediabunny does not decode, or null for any other route. */
function getFocusedVideoRoute(request: Extract<DecodeWorkerRequest, { type: 'start' }>): FocusedVideoRoute | null {
    if (request.videoDecoderBackend !== 'gpu') {
        return null;
    }
    switch (request.gpuVideoCodec) {
        case JPEG2000_FOCUSED_ROUTE.codec:
            return JPEG2000_FOCUSED_ROUTE;
        case VC1_FOCUSED_ROUTE.codec:
            return VC1_FOCUSED_ROUTE;
        case WMV3_FOCUSED_ROUTE.codec:
            return WMV3_FOCUSED_ROUTE;
        case MPEG1_FOCUSED_ROUTE.codec:
            return MPEG1_FOCUSED_ROUTE;
        case MPEG2_FOCUSED_ROUTE.codec:
            return MPEG2_FOCUSED_ROUTE;
        default:
            return null;
    }
}

/**
 * Returns the codec private data a focused route's decoder receives, null for a route without any, and the track its packets come from.
 * MPEG-1 and MPEG-2 take their track's CodecPrivate when it has one; VC-1 and WMV3 always take codec private data, and a VfW track of either restamps its packets in presentation order.
 * An MPEG-TS or M2TS track has no codec private data, so it takes its first sequence header's extradata, and stamps its packets in presentation order already.
 */
async function readFocusedVideoTrackConfiguration(
    route: FocusedVideoRoute,
    internalCodecID: string,
    input: FocusedVideoTrackInput
): Promise<Readonly<{ description: Uint8Array | null, videoTrack: InputVideoTrack }>> {
    const transportStreamCodec = input.transportStream ? getTransportStreamVideoCodec(input.containerCodec) : null;
    if (transportStreamCodec !== null) {
        const configuration = await readTransportStreamVideoDecoderDescription(transportStreamCodec, input.videoTrack);
        if (configuration.status === 'failed') {
            throw new UnsupportedCustomDecodeSourceError(
                `The selected ${route.errorName} track has no decoder configuration: ${configuration.failure}`
            );
        }
        return { description: configuration.description, videoTrack: input.videoTrack };
    }
    switch (route.codec) {
        case 'jpeg2000':
            return { description: null, videoTrack: input.videoTrack };
        case 'mpeg1video':
        case 'mpeg2video':
            return { description: readMatroskaMPEGVideoDecoderDescription(input.videoTrack), videoTrack: input.videoTrack };
        case 'vc1':
        case 'wmv3': {
            const configuration = await readVC1TrackConfiguration(route.codec, input.videoTrack, internalCodecID, input.codedWidth, input.codedHeight);
            if (configuration.status === 'failed') {
                throw new UnsupportedCustomDecodeSourceError(
                    `The selected ${route.errorName} track has no decoder configuration: ${configuration.failure}`
                );
            }
            return configuration;
        }
    }
}

/** Returns the check a track or its request fails for a focused route, as `code: detail`, or null when both match it. */
function findFocusedVideoRouteMismatch(route: FocusedVideoRoute, input: FocusedVideoTrackInput): string | null {
    // A transport stream track matches by the codec Mediabunny names, the other containers' tracks by their codec IDs
    if (input.transportStream) {
        if (getTransportStreamVideoCodec(input.containerCodec) !== route.codec) {
            return `container-codec: ${input.containerCodec}`;
        }
    } else if (typeof input.internalCodecID !== 'string' || !route.internalCodecIDs.includes(input.internalCodecID)) {
        return `codec-id: ${String(input.internalCodecID)}`;
    }
    if (input.request.videoOutputMode !== 'frame-pool') {
        return `output-mode: ${input.request.videoOutputMode}`;
    }
    if (input.request.dolbyVisionProfile !== null) {
        return `dolby-vision-profile: ${input.request.dolbyVisionProfile}`;
    }
    if (input.request.neutralizeHDRColorMetadata) {
        return 'hdr-neutralization: requested';
    }
    return input.request.nativeHDRTransfer === null ? null : `native-hdr-transfer: ${input.request.nativeHDRTransfer}`;
}

async function prepareFocusedVideoTrack(input: FocusedVideoTrackInput): Promise<PreparedVideoTrack | null> {
    const route = getFocusedVideoRoute(input.request);
    if (!route) {
        return null;
    }
    const mismatch = findFocusedVideoRouteMismatch(route, input);
    if (mismatch !== null) {
        throw new UnsupportedCustomDecodeSourceError(`The selected video track does not match the negotiated ${route.errorName} route: ${mismatch}`);
    }
    // A matching track's codec ID is one of the route's, or its transport stream's stream type
    const internalCodecID = String(input.internalCodecID);

    const colorSpace = route.includeColorSpace ? await input.videoTrack.getColorSpace() : null;
    const { description, videoTrack } = await readFocusedVideoTrackConfiguration(route, internalCodecID, input);
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
        videoTrack
    };
}

/** Reads the packets of a static HDR scan from the first one, within the scan's unit and byte bounds. */
async function readStaticHDRMetadataScanUnits(
    packetReader: PacketReader,
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
        packet = await packetReader.getNext(packet, STATIC_HDR_METADATA_PACKET_OPTIONS);
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

    const packetReader = new PacketReader(videoTrack);
    const accessUnits = await readStaticHDRMetadataScanUnits(
        packetReader,
        await packetReader.getFirst(STATIC_HDR_METADATA_PACKET_OPTIONS),
        run
    );
    return scanHEVCStaticHDRMetadata(accessUnits, getHEVCNALFormat(decoderConfig));
}

/**
 * Scans the MDCV and CLL metadata OBUs of an AV1 track that presents PQ without an RPU.
 * The raw route's request names no transfer, so the first temporal unit's sequence header decides instead, on the native external route too.
 */
async function readAV1StaticHDRMetadata(
    videoTrack: InputVideoTrack,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    run: DecodeRun
): Promise<StaticHDRMetadataScanResult | null> {
    if (request.dolbyVisionProfile !== null) {
        return null;
    }

    const packetReader = new PacketReader(videoTrack);
    const firstPacket = await packetReader.getFirst(STATIC_HDR_METADATA_PACKET_OPTIONS);
    if (!firstPacket || !hasAV1PQSequenceHeader(firstPacket.data)) {
        return null;
    }
    return scanAV1StaticHDRMetadata(await readStaticHDRMetadataScanUnits(packetReader, firstPacket, run));
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

/**
 * Returns an AV1 track's decoder configuration for the browser's decoder, without the AV1CodecConfigurationRecord Mediabunny hands on as its description.
 * The WebCodecs AV1 registration uses no description, so only the frame-pool route's GPU decoder takes the record, as its codec private data.
 */
function omitAV1ConfigurationRecord(decoderConfig: VideoDecoderConfig): VideoDecoderConfig {
    const browserDecoderConfig = { ...decoderConfig };
    delete browserDecoderConfig.description;
    return browserDecoderConfig;
}

/** Requires the codec its route's decoder takes: the GPU decoder's codec family, and HEVC or AV1 for color neutralization. */
function requireRouteVideoCodec(codec: VideoCodec, request: Extract<DecodeWorkerRequest, { type: 'start' }>): void {
    if (request.videoOutputMode === 'frame-pool' && codec !== request.gpuVideoCodec) {
        throw new UnsupportedCustomDecodeSourceError(
            `The selected ${codec} video track does not match the negotiated ${request.gpuVideoCodec ?? 'GPU'} decoder`
        );
    }
    if (request.neutralizeHDRColorMetadata && codec !== 'hevc' && codec !== 'av1') {
        throw new UnsupportedCustomDecodeSourceError('HDR color neutralization requires an HEVC or AV1 video track');
    }
}

/** Refuses a video track Mediabunny identifies but no route can play as it demuxes it. */
async function requireDemuxableVideoTrack(input: Input, videoTrack: InputVideoTrack, codec: VideoCodec | null): Promise<void> {
    // Mediabunny identifies MPEG-4 Part 2, which neither WebCodecs nor a decoder package decodes, and the engine keeps no CPU video decoder
    if (codec === 'mpeg4') {
        throw new UnsupportedCustomDecodeSourceError('The selected video codec has no decode route: mpeg4');
    }
    const unsupportedVideoFeature = await findUnsupportedTrackFeature(videoTrack);
    if (unsupportedVideoFeature !== null) {
        throw new UnsupportedCustomDecodeSourceError(`The selected video track has an edit list Mediabunny cannot honor: ${unsupportedVideoFeature}`);
    }
    if (await hasIncompleteAVIIndex(input, videoTrack)) {
        throw new UnsupportedCustomDecodeSourceError('The selected AVI video track outruns its idx1 index: opendml-index-unread');
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
    await requireDemuxableVideoTrack(input, videoTrack, codec);
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

    const focusedTrack = await prepareFocusedVideoTrack({
        availableVideoTracks: videoTracks,
        codedHeight,
        codedWidth,
        containerCodec: codec,
        displayHeight,
        displayWidth,
        internalCodecID,
        request,
        transportStream: await input.getFormat() instanceof MpegTsInputFormat,
        videoTrack
    });
    if (focusedTrack) {
        return focusedTrack;
    }

    // The frame-pool route decodes on the page's GPU, so the browser's own decoders need not take the track
    const framePool = request.videoOutputMode === 'frame-pool';
    const [ containerDecoderConfig, canDecode ] = await Promise.all([
        videoTrack.getDecoderConfig(),
        framePool ? Promise.resolve(true) : videoTrack.canDecode()
    ]);
    if (!codec || !containerDecoderConfig) {
        throw new UnsupportedCustomDecodeSourceError('The selected video codec configuration is unavailable');
    }
    requireRouteVideoCodec(codec, request);
    const decoderConfig = !framePool && codec === 'av1' ?
        omitAV1ConfigurationRecord(containerDecoderConfig) :
        containerDecoderConfig;
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

/**
 * Finds a dual-layer EL track and how its packets are framed: by the container's description of it, else by its own decoder configuration.
 * Returns null for a missing track, a track that is not HEVC, or one whose framing neither names.
 */
async function findSeparateDolbyVisionEnhancementTrack(
    preparedVideoTrack: PreparedVideoTrack,
    reference: SeparateDolbyVisionEnhancementTrackReference
): Promise<SeparateDolbyVisionEnhancementTrack | null> {
    const videoTrack = preparedVideoTrack.availableVideoTracks.find(
        (candidate: InputVideoTrack): boolean => candidate.id === reference.trackNumber
    );
    if (!videoTrack || videoTrack === preparedVideoTrack.videoTrack) {
        return null;
    }
    const [ codec, decoderConfig ] = await Promise.all([ videoTrack.getCodec(), videoTrack.getDecoderConfig() ]);
    if (codec !== null && codec !== 'hevc') {
        return null;
    }
    try {
        if (reference.decoderDescription) {
            const lengthSize = parseHEVCDecoderConfiguration(reference.decoderDescription).lengthSize;
            return { packetFormat: { kind: 'length-prefixed', lengthSize }, videoTrack };
        }
        return codec === 'hevc' && decoderConfig ? { packetFormat: getHEVCNALFormat(decoderConfig), videoTrack } : null;
    } catch {
        return null;
    }
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
    // Matroska and ISO BMFF TrueHD tracks, and QuickTime DTS core tracks, have no Mediabunny codec, which only a package decodes
    const sampleRate = getDeclaredAudioSampleRate(internalCodecID, declaredSampleRate);
    if ((!codec || !decoderConfig) && getContainerAudioCodec(codec, internalCodecID) === null) {
        throw new UnsupportedCustomDecodeSourceError('The selected audio codec configuration is unavailable');
    }
    if (isDTSExpressTrack(codec, decoderConfig)) {
        throw new UnsupportedCustomDecodeSourceError('The selected audio codec has no decode route: dtse');
    }
    const unsupportedAudioFeature = await findUnsupportedTrackFeature(audioTrack);
    if (unsupportedAudioFeature !== null) {
        throw new UnsupportedCustomDecodeSourceError(`The selected audio track has an edit list Mediabunny cannot honor: ${unsupportedAudioFeature}`);
    }
    if (!Number.isSafeInteger(channelCount) || channelCount <= 0 || channelCount > MAX_DECODED_AUDIO_CHANNELS) {
        throw new UnsupportedCustomDecodeSourceError('The selected audio channel count is unsupported');
    }
    if (!isSupportedCustomAudioSampleRate(sampleRate)) {
        throw new UnsupportedCustomDecodeSourceError('The selected audio sample rate is invalid');
    }
    const { declaredChannelMask, inputChannelLayout } = await getDeclaredInputChannelLayout(audioTrack, channelCount);

    return {
        audioTrack,
        channelCount,
        codec,
        declaredChannelMask,
        decoderConfig,
        inputChannelLayout,
        sampleRate,
        timeResolution
    };
}

/**
 * Lays the track's channels out by the WAVE channel mask its container declares, as WAVE_FORMAT_EXTENSIBLE does, or by their count without one.
 * A mask the output stage does not qualify, or one that names more or fewer speakers than the track has channels, is refused rather than played in the wrong speakers.
 */
async function getDeclaredInputChannelLayout(
    audioTrack: InputAudioTrack,
    channelCount: number
): Promise<{ declaredChannelMask: number | null, inputChannelLayout: CustomAudioChannelLayout }> {
    const channelMask = await audioTrack.getChannelMask();
    // A zero mask declares no speaker positions
    if (channelMask === null || channelMask === 0) {
        const inputChannelLayout = getCustomAudioChannelLayout(channelCount);
        if (!inputChannelLayout) {
            throw new UnsupportedCustomDecodeSourceError('The selected audio channel layout is unavailable');
        }
        return { declaredChannelMask: null, inputChannelLayout };
    }
    const qualifiedLayout = getQualifiedCustomWaveChannelLayout(channelMask);
    if (!qualifiedLayout || qualifiedLayout.channelCount !== channelCount) {
        throw new UnsupportedCustomDecodeSourceError(`The selected audio channel mask is unqualified: 0x${channelMask.toString(16)}`);
    }
    return { declaredChannelMask: channelMask, inputChannelLayout: qualifiedLayout.layout };
}

function prepareNativeMediaAudioTrack(metadata: SelectedAudioTrackMetadata): PreparedAudioTrack {
    const {
        audioTrack,
        channelCount,
        codec,
        decoderConfig,
        declaredChannelMask,
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
        declaredChannelMask,
        inputChannelLayout,
        outputMode: 'native-media',
        outputChannelCount: channelCount as 2 | 6,
        routeCodec: codec,
        sourceSampleRate: sampleRate,
        timeResolution
    };
}

/** Accepts a declared layout the decoded PCM route qualifies, including the 7.1 E-AC-3 tracks Mediabunny under-declares. */
function isDeclaredPackageInputLayout(codec: string, channelCount: number, sampleRate: number): boolean {
    return isSupportedCustomAudioInputLayout(codec, channelCount, sampleRate)
        || (codec === 'eac3'
            && channelCount === EAC3_UNDER_DECLARED_SEVEN_POINT_ONE_CHANNEL_COUNT
            && isSupportedCustomAudioSampleRate(sampleRate));
}

/**
 * Prepares a track a host's audio decoder package decodes; the decoded PCM route qualifies its declared layout under the codec the package decodes it as.
 * The declared layout only screens the track early; the decoded one is bound at the first output.
 */
function preparePackageAudioTrack(
    metadata: SelectedAudioTrackMetadata,
    packageDecoder: AudioDecoderPackageSelection,
    outputChannelCount: CustomAudioOutputChannelCount
): PreparedAudioTrack {
    const {
        audioTrack,
        channelCount,
        declaredChannelMask,
        inputChannelLayout,
        sampleRate,
        timeResolution
    } = metadata;
    const routeCodec = packageDecoder.codec;
    if (!isDeclaredPackageInputLayout(routeCodec, channelCount, sampleRate)) {
        throw new UnsupportedCustomDecodeSourceError(
            `The selected audio track does not match a qualified decoded PCM route of ${packageDecoder.source.manifest.name}`
        );
    }

    return {
        audioConfiguration: {
            channelCount: outputChannelCount,
            codec: routeCodec,
            sampleRate: CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE,
            sourceChannelCount: channelCount,
            sourceSampleRate: sampleRate
        },
        audioTrack,
        decoderBackend: 'package',
        decoderConfig: null,
        inputChannelCount: channelCount,
        declaredChannelMask,
        inputChannelLayout,
        outputMode: 'decoded-pcm',
        outputChannelCount,
        routeCodec,
        sourceSampleRate: sampleRate,
        timeResolution
    };
}

async function prepareMediabunnyDecodedAudioTrack(
    metadata: SelectedAudioTrackMetadata,
    outputChannelCount: CustomAudioOutputChannelCount
): Promise<PreparedAudioTrack> {
    const {
        audioTrack,
        channelCount,
        codec,
        decoderConfig,
        declaredChannelMask,
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
        declaredChannelMask,
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
    decodedAudioOutputChannelCount: CustomAudioOutputChannelCount,
    packageDecoder: AudioDecoderPackageSelection | null
): Promise<PreparedAudioTrack> {
    const metadata = await getSelectedAudioTrackMetadata(input, run, audioTrackOrdinal);
    switch (outputMode) {
        case 'native-media':
            return prepareNativeMediaAudioTrack(metadata);
        case 'decoded-pcm':
            return packageDecoder ?
                preparePackageAudioTrack(metadata, packageDecoder, decodedAudioOutputChannelCount) :
                prepareMediabunnyDecodedAudioTrack(metadata, decodedAudioOutputChannelCount);
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

/**
 * Returns the track's decoder configuration record that the frame-pool route's GPU decoder reads, as its own buffer, or null for a route that decodes here or a track without one.
 * A record past the GPU decode bound is not a source the route can play.
 */
function getGPUDecodeCodecPrivate(run: DecodeRun, preparedVideoTrack: PreparedVideoTrack): ArrayBuffer | null {
    if (run.videoOutputMode !== 'frame-pool') {
        return null;
    }
    const description = copyDecoderDescription(preparedVideoTrack.decoderConfig.description);
    if (!description || description.byteLength === 0) {
        return null;
    }
    if (description.byteLength > GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH) {
        throw new UnsupportedCustomDecodeSourceError(
            `The selected video track's codec private data is ${description.byteLength} bytes, over ${GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH}`
        );
    }
    return description.slice().buffer;
}

/** Reads the chroma the video track declares, from its first key packet's in-band SPS where its decoder configuration leaves the SPS to the stream. */
async function readVideoTrackChromaFormat(preparedVideoTrack: PreparedVideoTrack): Promise<VideoChromaFormat> {
    const { decoderConfig, videoTrack } = preparedVideoTrack;
    const keyPacket = readsChromaInBand(decoderConfig) ? await new PacketReader(videoTrack).getFirstKey() : null;
    return readVideoChromaFormat(decoderConfig, keyPacket?.data ?? null);
}

function postReadyResponse(
    run: DecodeRun,
    preparedVideoTrack: PreparedVideoTrack,
    preparedAudioTrack: PreparedAudioTrack | null,
    containerDurationMicroseconds: Microseconds | null,
    maximumPictureSize: GPUDecoderPictureSize | null,
    chromaFormat: VideoChromaFormat
): void {
    const geometry = preparedVideoTrack.geometry;
    const codecPrivate = getGPUDecodeCodecPrivate(run, preparedVideoTrack);
    postResponse({
        audio: preparedAudioTrack?.audioConfiguration ?? null,
        ...(chromaFormat.location !== null || chromaFormat.subsampling !== null ? { chromaFormat } : {}),
        codec: preparedVideoTrack.decoderConfig.codec,
        ...(codecPrivate ? { codecPrivate } : {}),
        codedHeight: geometry.codedHeight,
        codedWidth: geometry.codedWidth,
        ...(containerDurationMicroseconds !== null ? { containerDurationMicroseconds } : {}),
        displayHeight: geometry.displayHeight,
        displayWidth: geometry.displayWidth,
        generation: run.generation,
        ...(maximumPictureSize ? { maximumPictureSize } : {}),
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
        case 'video-sample':
            return takeVideoFrame(output.source.sample);
    }
}

/** Takes a decoded output for a raw copy, which reads its VideoFrame. */
function takeOwnedRawVideoFrameSource(output: OwnedDecodedVideoOutput): TakenDecodedFrame<RawVideoFrameSource> {
    return takeOwnedVideoFrame(output);
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

/** Attaches the container's fields, which a frame of a native decoder carries since it reports none of its own. */
function attachVideoFrameFields(response: MutableDecodeWorkerFrameResponse, fields: VideoFrameFields | null): void {
    if (fields) {
        response.fields = fields;
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
    const rawFrame = await copyVideoFrameToRawPlanes(frame, {
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
    attachVideoFrameFields(response, run.videoFrameFields);
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
    attachVideoFrameFields(response, run.videoFrameFields);
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
    attachVideoFrameFields(response, run.videoFrameFields);
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

function createOwnedHEVCVideoDecoderPort(
    run: DecodeRun,
    preparedVideoTrack: PreparedVideoTrack,
    inputFormat: ReturnType<typeof getHEVCNALFormat>,
    callbacks: OwnedVideoDecoderCallbacks
): OwnedVideoDecoderPort {
    if (run.videoDecoderBackend !== 'native') {
        throw new Error('The frame-pool route decodes on the page, not with an HEVC decoder port');
    }
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

/** The decoder, queues, and state that each packet of one owned HEVC attempt passes through. */
type OwnedHEVCStream = {
    decoder: OwnedVideoDecoderPort
    dynamicHDRMetadataQueue: HEVCDynamicHDRMetadataQueue
    inputFormat: HEVCNALFormat
    metadataQueue: DolbyVisionEncodedMetadataQueue
    separateEnhancementStream: SeparateDolbyVisionEnhancementPacketStream | null
    state: OwnedVideoStreamState
};

async function createSeparateDolbyVisionEnhancementPacketStream(
    run: DecodeRun,
    enhancementTrack: SeparateDolbyVisionEnhancementTrack,
    startTimeMicroseconds: Microseconds
): Promise<SeparateDolbyVisionEnhancementPacketStream | null> {
    if (isVideoAttemptStopped(run)) {
        return null;
    }
    try {
        const packetReader = new PacketReader(enhancementTrack.videoTrack);
        const startTimeSeconds = microsecondsToSeconds(startTimeMicroseconds);
        const keyPacket = await packetReader.getKeyAt(
            startTimeSeconds,
            OWNED_HEVC_PACKET_OPTIONS
        ) ?? await packetReader.getFirstKey(OWNED_HEVC_PACKET_OPTIONS);
        if (!keyPacket || isVideoAttemptStopped(run)) {
            return null;
        }
        const iterator = iterateTrackPackets(packetReader, keyPacket, null, OWNED_HEVC_PACKET_OPTIONS);
        const pairer = new DolbyVisionEncodedPacketPairer(iterator);
        run.enhancementPacketPairer = pairer;
        return {
            inputFormat: enhancementTrack.packetFormat,
            pairer
        };
    } catch {
        return null;
    }
}

/**
 * Splits one HEVC packet, with the RPUs of its separate-track EL packet when there is one.
 * An EL packet that does not split retires the EL track, which leaves the stream to its BL.
 */
async function processOwnedHEVCPacket(
    hevcStream: Pick<OwnedHEVCStream, 'metadataQueue' | 'separateEnhancementStream'>,
    packet: EncodedPacket,
    nalUnits: readonly HEVCNALUnit[],
    separateEnhancementPacket: EncodedPacket | null
): Promise<ProcessedDolbyVisionHEVCPacket> {
    const separateEnhancementStream = hevcStream.separateEnhancementStream;
    if (separateEnhancementPacket && separateEnhancementStream) {
        try {
            return await hevcStream.metadataQueue.processSeparatePackets(
                packet,
                separateEnhancementPacket,
                separateEnhancementStream.inputFormat,
                nalUnits
            );
        } catch {
            await separateEnhancementStream.pairer.retire();
        }
    }
    return hevcStream.metadataQueue.processPacket(packet, nalUnits);
}

/** Takes the separate-track EL packet that pairs with a BL packet; a missing or unreadable one retires the EL track. */
async function takeSeparateEnhancementPacket(
    separateEnhancementStream: SeparateDolbyVisionEnhancementPacketStream | null,
    packetMediaTimeMicroseconds: Microseconds
): Promise<EncodedPacket | null> {
    if (!separateEnhancementStream || separateEnhancementStream.pairer.retired) {
        return null;
    }
    try {
        const separateEnhancementPacket = await separateEnhancementStream.pairer.takeMatchingPacket(
            packetMediaTimeMicroseconds
        );
        if (!separateEnhancementPacket) {
            await separateEnhancementStream.pairer.retire();
        }
        return separateEnhancementPacket;
    } catch {
        await separateEnhancementStream.pairer.retire();
        return null;
    }
}

/** Decodes one BL packet; no decoder decodes a Dolby Vision EL, so its pictures are dropped and only its RPUs are kept. */
async function decodeOwnedHEVCPacket(
    run: DecodeRun,
    hevcStream: OwnedHEVCStream,
    packet: EncodedPacket,
    packetMediaTimeMicroseconds: Microseconds
): Promise<boolean> {
    const separateEnhancementPacket = await takeSeparateEnhancementPacket(
        hevcStream.separateEnhancementStream,
        packetMediaTimeMicroseconds
    );
    if (isVideoAttemptStopped(run)) {
        return false;
    }
    // One walk of the packet's NAL units serves its HDR10+ parse and its Dolby Vision split
    const nalUnits = parseHEVCNALUnits(packet.data, hevcStream.inputFormat);
    hevcStream.dynamicHDRMetadataQueue.processPacket(packet, nalUnits);
    const processedPacket = await processOwnedHEVCPacket(hevcStream, packet, nalUnits, separateEnhancementPacket);
    hevcStream.state.decodeBasePacket(
        packet,
        processedPacket.baseLayerPacket,
        processedPacket.hasBaseLayerVCL,
        hevcStream.decoder
    );
    hevcStream.state.throwDecoderFailure();
    return true;
}

/** Reads the inclusive byte range of a run's media: a ranged request for a URL, a slice for a file. */
async function readMediaByteRange(
    source: CustomDecodeMediaSource,
    abortController: AbortController,
    offset: number,
    lastByte: number
): Promise<Uint8Array> {
    switch (source.kind) {
        case 'file':
            return new Uint8Array(await source.file.slice(offset, lastByte + 1).arrayBuffer());
        case 'url': {
            const response = await createValidatedRangeFetch(source.hiddenContentRangePathPattern ?? null)(source.url, {
                headers: {
                    Range: `bytes=${offset}-${lastByte}`
                },
                signal: abortController.signal
            });
            return new Uint8Array(await response.arrayBuffer());
        }
    }
}

async function readDolbyVisionMetadataByteRange(
    run: DecodeRun,
    source: CustomDecodeMediaSource,
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
    const data = await readMediaByteRange(source, abortController, offset, lastByte);
    // A file read cannot be aborted, so a run stopped meanwhile drops its result
    if (isVideoAttemptStopped(run) || data.byteLength === 0 || data.byteLength > byteLength) {
        return null;
    }
    return data;
}

/** Reads where the container puts the selected track's dual-layer EL, or null when the EL interleaves with its BL or there is none. */
async function readSeparateDolbyVisionEnhancementTrackReference(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    containerTrackNumber: number
): Promise<SeparateDolbyVisionEnhancementTrackReference | null> {
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
            request.source,
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
            return matroskaConfiguration.separateEnhancementTrackNumber === null ?
                null :
                { decoderDescription: null, trackNumber: matroskaConfiguration.separateEnhancementTrackNumber };
        }
        const isoBaseMediaConfiguration = await readISOBaseMediaDolbyVisionTrackConfiguration(
            reader,
            containerTrackNumber
        );
        if (isoBaseMediaConfiguration) {
            // A null track number means the selected track interleaves the EL under its hvcE configuration
            return isoBaseMediaConfiguration.separateEnhancementTrackNumber === null ? null : {
                decoderDescription: isoBaseMediaConfiguration.enhancementConfiguration,
                trackNumber: isoBaseMediaConfiguration.separateEnhancementTrackNumber
            };
        }
        const transportStreamConfiguration =
            await readMPEGTransportStreamDolbyVisionTrackConfiguration(reader, containerTrackNumber);
        return transportStreamConfiguration ?
            { decoderDescription: null, trackNumber: transportStreamConfiguration.separateEnhancementTrackNumber } :
            null;
    } finally {
        if (run.metadataAbortController === abortController) {
            run.metadataAbortController = null;
        }
    }
}

/**
 * Resolves the separate EL track of a dual-layer route, whose packets carry the RPUs of their BL frames.
 * An EL interleaved with its BL carries its RPUs in the BL's own access units, so its container is never read.
 */
async function resolveSeparateDolbyVisionEnhancementTrack(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack,
    keyPacketSplit: ReturnType<typeof splitDolbyVisionHEVCAccessUnit>
): Promise<SeparateDolbyVisionEnhancementTrack | null> {
    if (
        !isDolbyVisionDualLayerProfile(request.dolbyVisionProfile)
        || keyPacketSplit.hasEnhancementLayerVCL
        || keyPacketSplit.hasRequiredEnhancementLayerParameterSets
    ) {
        return null;
    }
    const reference = await readSeparateDolbyVisionEnhancementTrackReference(
        run,
        request,
        preparedVideoTrack.containerTrackNumber
    );
    if (!reference || isVideoAttemptStopped(run)) {
        return null;
    }
    return findSeparateDolbyVisionEnhancementTrack(preparedVideoTrack, reference);
}

async function streamOwnedHEVCFrames(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack
): Promise<void> {
    if (preparedVideoTrack.codec !== 'hevc') {
        throw new UnsupportedCustomDecodeSourceError('The owned HEVC decoder requires an HEVC track');
    }

    const packetReader = new PacketReader(preparedVideoTrack.videoTrack);
    const startTimeSeconds = microsecondsToSeconds(request.startTimeMicroseconds);
    const keyPacket = await packetReader.getKeyAt(
        startTimeSeconds,
        OWNED_HEVC_PACKET_OPTIONS
    ) ?? await packetReader.getFirstKey(OWNED_HEVC_PACKET_OPTIONS);
    if (!keyPacket || isVideoAttemptStopped(run)) {
        return;
    }
    const keyPacketMediaTimeMicroseconds = requireMicroseconds(
        keyPacket.microsecondTimestamp,
        'Owned HEVC key packet timestamp'
    );
    postVideoStartupProgress(run, 'video-key-packet-ready', 0, keyPacketMediaTimeMicroseconds);

    const packetIterator = iterateTrackPackets(packetReader, keyPacket, null, OWNED_HEVC_PACKET_OPTIONS);
    run.videoIterator = packetIterator;
    const inputFormat = getHEVCNALFormat(preparedVideoTrack.decoderConfig);
    const keyPacketSplit = splitDolbyVisionHEVCAccessUnit(keyPacket.data, inputFormat, inputFormat);
    const separateEnhancementTrack = await resolveSeparateDolbyVisionEnhancementTrack(
        run,
        request,
        preparedVideoTrack,
        keyPacketSplit
    );
    const separateEnhancementStream = separateEnhancementTrack ?
        await createSeparateDolbyVisionEnhancementPacketStream(
            run,
            separateEnhancementTrack,
            keyPacketMediaTimeMicroseconds
        ) :
        null;
    if (isVideoAttemptStopped(run)) {
        await retireIterator(packetIterator);
        await separateEnhancementStream?.pairer.retire();
        return;
    }
    // Only a Dolby Vision route parses RPUs, so any other route never loads the parser
    const rpuParser = request.dolbyVisionProfile === null ?
        null :
        DolbyVisionRPUParserSession.create(request.dolbyVisionRPUParserWASMURL, request.dolbyVisionProfile);
    const metadataQueue = new DolbyVisionEncodedMetadataQueue(inputFormat, rpuParser);
    const dynamicHDRMetadataQueue = new HEVCDynamicHDRMetadataQueue(inputFormat);
    // No decoder decodes a Dolby Vision EL, so the stream posts BL frames alone
    const streamRun = createOwnedVideoStreamRun(run, preparedVideoTrack.geometry, null);
    const state = new OwnedVideoStreamState(
        streamRun,
        createOwnedVideoFrameMetadataSource(metadataQueue, dynamicHDRMetadataQueue),
        request.startTimeMicroseconds,
        null
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
    try {
        await decoder.init();
        postVideoStartupProgress(run, 'video-decoder-ready', 0, keyPacketMediaTimeMicroseconds);
        const hevcStream: OwnedHEVCStream = {
            decoder,
            dynamicHDRMetadataQueue,
            inputFormat,
            metadataQueue,
            separateEnhancementStream,
            state
        };
        await pumpOwnedVideoFrames(
            streamRun,
            packetIterator,
            decoder,
            null,
            state,
            (packet: EncodedPacket, packetMediaTimeMicroseconds: Microseconds): Promise<boolean> => (
                decodeOwnedHEVCPacket(run, hevcStream, packet, packetMediaTimeMicroseconds)
            )
        );
    } finally {
        // Close the decoder first: an output arriving during the awaits below would otherwise land in the cleared queue and leak its frame
        decoder.close();
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
    const packetReader = new PacketReader(preparedVideoTrack.videoTrack);
    const startTimeSeconds = microsecondsToSeconds(request.startTimeMicroseconds);
    const keyPacket = await packetReader.getKeyAt(
        startTimeSeconds,
        OWNED_NATIVE_PACKET_OPTIONS
    ) ?? await packetReader.getFirstKey(OWNED_NATIVE_PACKET_OPTIONS);
    if (!keyPacket || isVideoAttemptStopped(run)) {
        return;
    }
    const keyPacketMediaTimeMicroseconds = requireMicroseconds(
        keyPacket.microsecondTimestamp,
        `Owned ${codecName} key packet timestamp`
    );
    postVideoStartupProgress(run, 'video-key-packet-ready', 0, keyPacketMediaTimeMicroseconds);

    const packetIterator = iterateTrackPackets(packetReader, keyPacket, null, OWNED_NATIVE_PACKET_OPTIONS);
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

/** An AV1 track's configuration on the native external HDR route: neutralized, with the transfer its sequence headers must prove. */
type NeutralizedOwnedAV1Configuration = NeutralizedNativeHDRAV1DecoderConfig & {
    transfer: AV1HDRTransfer
};

/** Neutralizes an AV1 track's decoder configuration when the route asks, or returns null on any other route. */
function neutralizeOwnedAV1DecoderConfig(run: DecodeRun, decoderConfig: VideoDecoderConfig): NeutralizedOwnedAV1Configuration | null {
    if (!run.neutralizeHDRColorMetadata) {
        return null;
    }
    const transfer = run.nativeHDRTransfer;
    if (transfer !== 'hlg' && transfer !== 'pq') {
        throw new UnsupportedCustomDecodeSourceError('Native HDR color neutralization requires an exact HDR transfer');
    }
    return { ...neutralizeNativeHDRAV1DecoderConfig(decoderConfig, transfer), transfer };
}

/**
 * Decodes an AV1 track in the engine's own decoder, because Mediabunny's sample sink hides the metadata OBUs that carry Dolby Vision RPUs and HDR10+ metadata.
 * Only a Dolby Vision route loads the RPU parser; any other route strips the RPUs unparsed.
 * The native external HDR route neutralizes the decoder configuration and every sequence header to limited BT.709.
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

    const neutralization = neutralizeOwnedAV1DecoderConfig(run, preparedVideoTrack.decoderConfig);
    const decodedVideoTrack = neutralization ? { ...preparedVideoTrack, decoderConfig: neutralization.configuration } : preparedVideoTrack;
    await streamOwnedNativeFrames(run, request, decodedVideoTrack, 'AV1', async (
        stream: OwnedVideoStreamRun,
        packetIterator: OwnedVideoPacketIterator,
        createDecoder: (callbacks: OwnedVideoDecoderCallbacks) => OwnedVideoDecoderPort,
        keyPacketMediaTimeMicroseconds: Microseconds
    ): Promise<void> => {
        const rpuParser = request.dolbyVisionProfile === null ?
            null :
            DolbyVisionRPUParserSession.create(request.dolbyVisionRPUParserWASMURL, request.dolbyVisionProfile);
        try {
            await runOwnedAV1VideoStream(
                stream,
                packetIterator,
                rpuParser,
                createDecoder,
                request.startTimeMicroseconds,
                keyPacketMediaTimeMicroseconds,
                // Each attempt starts at a key packet, whose sequence header proves the route again
                neutralization ?
                    new NativeHDRAV1TemporalUnitNeutralizer(neutralization.transfer, neutralization.decoderDescriptionValidated) :
                    null
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
        return runOwnedVP9VideoStream(
            stream,
            packetIterator,
            (packet: EncodedPacket): Uint8Array[] => readMatroskaBlockAdditions(packet).map(
                (addition: MatroskaBlockAddition): Uint8Array => addition.data
            ),
            createDecoder,
            request.startTimeMicroseconds,
            keyPacketMediaTimeMicroseconds
        );
    });
}

/** One picture the page's decoder reads: the packet's bytes, or a GPU record its parser made, with the parser's output events, repeat counts, and visible size. */
type GPUDecodeOutgoingPicture = {
    data: ArrayBuffer
    /** The fields the picture's parser reported, or null */
    fields: VideoFrameFields | null
    format: GPUDecoderOutputFormat | null
    maximumPictureSize: GPUDecoderPictureSize | null
    outputEvents: Uint32Array | null
    repeatCounts: readonly number[] | null
    visibleSize: GPUDecoderPictureSize | null
};

/** What the page's decoder reads of one packet: its pictures in decode order, and the events of a parser call that planned no picture, which wait for the next picture. */
type GPUDecodeOutgoingData = {
    pictures: GPUDecodeOutgoingPicture[]
    trailingEvents: Uint32Array | null
};

/** A packet of the frame-pool route on its way to the page: its timing, its HDR10+ state, its Dolby Vision RPUs, and its pictures, which a parser may still be producing. */
type GPUDecodeOutgoingPacket = {
    data: Promise<GPUDecodeOutgoingData>
    durationMicroseconds: Microseconds
    /** On a Dolby Vision route, the packet's parsed RPUs, null for a packet without any */
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null
    HDR10PlusMetadata: HDR10PlusFrameMetadata | null
    keyframe: boolean
    /** The demuxed packet, from which a parser's restart after a failure on it finds the next key packet */
    packet: EncodedPacket
    /** The pictures the parser made of the packet, once it did; a packet still parsing counts as one picture toward the read-ahead */
    pictureCount: number | null
    timestampMicroseconds: Microseconds
};

/**
 * A frame-pool attempt's Dolby Vision RPU reader: the RPU parser and the codec's metadata queue, with a separate EL track's packets for a dual-layer HEVC route.
 * The packets still reach the decoder's parser whole, which skips their RPU and EL NAL units or metadata OBUs.
 */
type GPUDecodeDolbyVisionReader = {
    av1MetadataQueue: DolbyVisionAV1EncodedMetadataQueue | null
    hevc: (Pick<OwnedHEVCStream, 'inputFormat' | 'metadataQueue' | 'separateEnhancementStream'>) | null
    rpuParser: DolbyVisionRPUParserSession
};

/** One attempt's packets of the frame-pool route, read until their pictures reach readAheadDepth ahead of the credits. */
type GPUDecodePacketQueue = {
    /** On a Dolby Vision route, what reads each packet's RPUs; null on any other route */
    dolbyVisionReader: GPUDecodeDolbyVisionReader | null
    dynamicHDRMetadataQueue: HEVCDynamicHDRMetadataQueue | null
    ended: boolean
    iterator: OwnedVideoPacketIterator
    outgoing: GPUDecodeOutgoingPacket[]
    /** Opens the RPU reader again at the key packet a parser's restart reads from */
    openDolbyVisionReader: (keyPacket: EncodedPacket) => Promise<GPUDecodeDolbyVisionReader | null>
    /** The track's packets, which a parser's restart reads again from the next key packet */
    packetReader: PacketReader
    // The decoder package's parser, which turns each packet into what the decoder reads
    pipeline: GPUDecoderParserRemotePipeline | null
    readAheadDepth: number
    /** Set by a parser's restart: the next posted picture, its new parser's first, resets the page's decoder */
    resetPending: boolean
};

/** Returns the pictures a parser made of a packet as the page's decoder reads them. */
function getOutgoingParserData(output: GPUDecoderParserOutput): GPUDecodeOutgoingData {
    return {
        pictures: output.pictures.map((picture: GPUDecoderParserPicture): GPUDecodeOutgoingPicture => ({
            data: picture.record,
            fields: picture.fields,
            format: picture.format,
            maximumPictureSize: picture.maximumPictureSize,
            outputEvents: picture.events,
            repeatCounts: picture.repeatCounts,
            visibleSize: picture.visibleSize
        })),
        trailingEvents: output.trailingEvents.length > 0 ? output.trailingEvents : null
    };
}

/** Hands a packet to the parser, or keeps its bytes as the one picture of a decoder that reads packets; the bytes may share Mediabunny's read buffer, so either way they are copied. */
function submitGPUDecodePacket(pipeline: GPUDecoderParserRemotePipeline | null, packet: EncodedPacket): Promise<GPUDecodeOutgoingData> {
    const bytes = packet.data.slice().buffer;
    if (!pipeline) {
        return Promise.resolve({
            pictures: [ { data: bytes, fields: null, format: null, maximumPictureSize: null, outputEvents: null, repeatCounts: null, visibleSize: null } ],
            trailingEvents: null
        });
    }
    return pipeline.submit(bytes).then(getOutgoingParserData);
}

/** Returns the pictures the queue holds toward its read-ahead: each parsed packet's own, and one for each packet still parsing. */
function countQueuedPictures(queue: GPUDecodePacketQueue): number {
    let pictureCount = 0;
    for (const packet of queue.outgoing) {
        pictureCount += packet.pictureCount ?? 1;
    }
    return pictureCount;
}

/**
 * Takes the parser pipeline the run opened before its readiness, for its first attempt; later attempts open their own.
 * The run opens it early because the parser's configure declares the stream's largest picture, which the page sizes its decoder by.
 */
function takePreparedGPUDecodeParser(run: DecodeRun): GPUDecoderParserRemotePipeline | null {
    const pipeline = run.preparedGPUDecodeParser;
    run.preparedGPUDecodeParser = null;
    return pipeline;
}

/**
 * Opens the run's parser pipeline before its readiness, on the frame-pool route of a decoder package with a parser, and returns the largest picture the track's codec private data declares.
 * Returns null for any other route, and when the parser declares none.
 */
async function prepareGPUDecodeParser(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack
): Promise<GPUDecoderPictureSize | null> {
    const parser = request.gpuVideoParser;
    if (run.videoOutputMode !== 'frame-pool' || !parser) {
        return null;
    }
    const pipeline = await openGPUDecoderParser(parser.parser, parser.packageVersion, copyDecoderDescription(preparedVideoTrack.decoderConfig.description));
    if (run.cancelled) {
        pipeline.close();
        return null;
    }
    run.preparedGPUDecodeParser = pipeline;
    return pipeline.maximumPictureSize;
}

/**
 * Opens the RPU reader of a frame-pool attempt on a Dolby Vision route, from the key packet it reads from, or returns null on any other route.
 * A dual-layer HEVC stream whose key packet carries no EL takes its RPUs from its separate EL track, as the raw route does.
 */
async function openGPUDecodeDolbyVisionReader(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack,
    keyPacket: EncodedPacket
): Promise<GPUDecodeDolbyVisionReader | null> {
    if (request.dolbyVisionProfile === null) {
        return null;
    }
    const rpuParser = DolbyVisionRPUParserSession.create(request.dolbyVisionRPUParserWASMURL, request.dolbyVisionProfile);
    if (preparedVideoTrack.codec === 'av1') {
        return { av1MetadataQueue: new DolbyVisionAV1EncodedMetadataQueue(rpuParser), hevc: null, rpuParser };
    }
    const inputFormat = getHEVCNALFormat(preparedVideoTrack.decoderConfig);
    const reader: GPUDecodeDolbyVisionReader = {
        av1MetadataQueue: null,
        hevc: { inputFormat, metadataQueue: new DolbyVisionEncodedMetadataQueue(inputFormat, rpuParser), separateEnhancementStream: null },
        rpuParser
    };
    try {
        const separateEnhancementTrack = await resolveSeparateDolbyVisionEnhancementTrack(
            run,
            request,
            preparedVideoTrack,
            splitDolbyVisionHEVCAccessUnit(keyPacket.data, inputFormat, inputFormat)
        );
        if (separateEnhancementTrack && reader.hevc) {
            reader.hevc.separateEnhancementStream = await createSeparateDolbyVisionEnhancementPacketStream(
                run,
                separateEnhancementTrack,
                requireMicroseconds(keyPacket.microsecondTimestamp, 'GPU decode key packet timestamp')
            );
        }
    } catch (error) {
        rpuParser.close();
        throw error;
    }
    return reader;
}

/** Closes a frame-pool attempt's RPU reader: its parser, and its separate EL track. */
async function closeGPUDecodeDolbyVisionReader(reader: GPUDecodeDolbyVisionReader | null): Promise<void> {
    reader?.rpuParser.close();
    await reader?.hevc?.separateEnhancementStream?.pairer.retire();
}

/** A frame-pool packet's metadata: its HDR10+ state, and on a Dolby Vision route its parsed RPUs. */
type GPUDecodePacketMetadata = Pick<GPUDecodeOutgoingPacket, 'encodedDolbyVisionMetadata' | 'HDR10PlusMetadata'>;

/**
 * Reads a frame-pool packet's metadata in decode order, as the raw route does: an HEVC packet's NAL units are walked once for its HDR10+ parse and its Dolby Vision split,
 * and a packet with a picture takes the entry its split recorded, since its frame carries it to the page.
 */
async function readGPUDecodePacketMetadata(
    queue: GPUDecodePacketQueue,
    packet: EncodedPacket,
    timestampMicroseconds: Microseconds
): Promise<GPUDecodePacketMetadata> {
    const av1MetadataQueue = queue.dolbyVisionReader?.av1MetadataQueue ?? null;
    if (av1MetadataQueue) {
        const temporalUnit = await av1MetadataQueue.processTemporalUnit(packet);
        return {
            encodedDolbyVisionMetadata: temporalUnit.hasFrame ? av1MetadataQueue.takeFrameMetadata(timestampMicroseconds) : null,
            HDR10PlusMetadata: null
        };
    }
    const hevc = queue.dolbyVisionReader?.hevc ?? null;
    const nalUnits = hevc ? parseHEVCNALUnits(packet.data, hevc.inputFormat) : undefined;
    const HDR10PlusMetadata = queue.dynamicHDRMetadataQueue?.processPacket(packet, nalUnits) ?
        queue.dynamicHDRMetadataQueue.takeFrameMetadata(timestampMicroseconds) :
        null;
    if (!hevc || !nalUnits) {
        return { encodedDolbyVisionMetadata: null, HDR10PlusMetadata };
    }
    const separateEnhancementPacket = await takeSeparateEnhancementPacket(hevc.separateEnhancementStream, timestampMicroseconds);
    const processedPacket = await processOwnedHEVCPacket(hevc, packet, nalUnits, separateEnhancementPacket);
    return {
        encodedDolbyVisionMetadata: processedPacket.hasBaseLayerVCL ? hevc.metadataQueue.takeFrameMetadata(timestampMicroseconds) : null,
        HDR10PlusMetadata
    };
}

/** Opens the attempt's packets at the key packet preceding the start time; returns null when the track has none or the attempt stopped. */
async function openGPUDecodePacketQueue(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack
): Promise<GPUDecodePacketQueue | null> {
    const packetReader = new PacketReader(preparedVideoTrack.videoTrack);
    const startTimeSeconds = microsecondsToSeconds(request.startTimeMicroseconds);
    const keyPacket = await packetReader.getKeyAt(startTimeSeconds, GPU_DECODE_PACKET_OPTIONS)
        ?? await packetReader.getFirstKey(GPU_DECODE_PACKET_OPTIONS);
    if (!keyPacket || isVideoAttemptStopped(run)) {
        return null;
    }
    const keyPacketMediaTimeMicroseconds = requireMicroseconds(keyPacket.microsecondTimestamp, 'GPU decode key packet timestamp');
    postVideoStartupProgress(run, 'video-key-packet-ready', 0, keyPacketMediaTimeMicroseconds);

    const iterator = iterateTrackPackets(packetReader, keyPacket, null, GPU_DECODE_PACKET_OPTIONS);
    run.videoIterator = iterator;
    const parser = request.gpuVideoParser;
    const pipeline = parser ?
        takePreparedGPUDecodeParser(run)
            ?? await openGPUDecoderParser(parser.parser, parser.packageVersion, copyDecoderDescription(preparedVideoTrack.decoderConfig.description)) :
        null;
    const openDolbyVisionReader = (readerKeyPacket: EncodedPacket): Promise<GPUDecodeDolbyVisionReader | null> => (
        openGPUDecodeDolbyVisionReader(run, request, preparedVideoTrack, readerKeyPacket)
    );
    const dolbyVisionReader = await openDolbyVisionReader(keyPacket);
    return {
        dolbyVisionReader,
        // Only HEVC carries HDR10+ in its packets' SEI; the queue carries the last metadata to packets without their own
        dynamicHDRMetadataQueue: preparedVideoTrack.codec === 'hevc' ?
            new HEVCDynamicHDRMetadataQueue(getHEVCNALFormat(preparedVideoTrack.decoderConfig)) :
            null,
        ended: false,
        iterator,
        outgoing: [],
        openDolbyVisionReader,
        packetReader,
        pipeline,
        // A parser parses ahead of the credits, so its workers stay busy while the page decodes
        readAheadDepth: pipeline ? GPU_DECODE_PARSER_READ_AHEAD : 1,
        resetPending: false
    };
}

/**
 * Posts one picture of a packet of the frame-pool route with the output events it carries; its data and events transfer to the page.
 * Every picture takes its packet's timing and keyframe flag, and the packet's first picture carries its HDR10+ state.
 * The first picture after a parser's restart resets the page's decoder.
 */
function postGPUDecodePicture(
    run: DecodeRun,
    packet: GPUDecodeOutgoingPacket,
    picture: GPUDecodeOutgoingPicture,
    events: Uint32Array | null,
    firstPicture: boolean,
    reset: boolean
): void {
    // A packet's first picture carries its RPUs, whose parsed buffers move to the page
    const encodedDolbyVisionMetadata = firstPicture ? takeTransferableDolbyVisionEncodedFrameMetadata(packet.encodedDolbyVisionMetadata) : null;
    const transfer: Transferable[] = [ picture.data, ...getDolbyVisionEncodedMetadataTransferList(encodedDolbyVisionMetadata) ];
    if (events && events.byteLength > 0) {
        transfer.push(events.buffer);
    }
    // A parser's own report outranks the container's, and a decoder's status report outranks both on the page
    const fields = picture.fields ?? run.videoFrameFields;
    postResponse({
        data: picture.data,
        durationMicroseconds: packet.durationMicroseconds,
        ...(fields ? { fields } : {}),
        generation: run.generation,
        ...(picture.format ? { format: picture.format } : {}),
        ...(encodedDolbyVisionMetadata ? { encodedDolbyVisionMetadata } : {}),
        ...(firstPicture && packet.HDR10PlusMetadata ? { HDR10PlusMetadata: packet.HDR10PlusMetadata } : {}),
        keyframe: packet.keyframe,
        ...(picture.maximumPictureSize ? { maximumPictureSize: picture.maximumPictureSize } : {}),
        ...(events ? { outputEvents: events } : {}),
        ...(picture.repeatCounts ? { repeatCounts: picture.repeatCounts } : {}),
        ...(reset ? { reset: true } : {}),
        timestampMicroseconds: packet.timestampMicroseconds,
        type: 'packet',
        videoEpoch: run.videoEpoch,
        ...(picture.visibleSize ? { visibleSize: picture.visibleSize } : {})
    }, transfer);
}

/**
 * Posts a held packet: one whose picture a parser's failure lost, which decodes nothing and whose frame repeats the last good frame at its time.
 * The first held packet of a restart carries the failure as its recovery.
 */
function postGPUDecodeHold(run: DecodeRun, packet: EncodedPacket, recovery: GPUVideoDecodeRecovery | null): Microseconds {
    const timestampMicroseconds = requireMicroseconds(packet.microsecondTimestamp, 'GPU decode held packet timestamp');
    postResponse({
        data: new ArrayBuffer(0),
        durationMicroseconds: requireMicroseconds(Math.max(0, packet.microsecondDuration), 'GPU decode held packet duration'),
        generation: run.generation,
        hold: true,
        keyframe: packet.type === 'key',
        ...(recovery ? { recovery } : {}),
        timestampMicroseconds,
        type: 'packet',
        videoEpoch: run.videoEpoch
    });
    return timestampMicroseconds;
}

/**
 * Restarts the parser after a recoverable failure on a packet: the failed parser closes, the failed packet and every packet up to the next key packet
 * post as held packets, each spending its credit, and a new parser parses from the key packet, whose first picture resets the page's decoder.
 * Without a later key packet the packets up to the track's end hold, and the track ends.
 * Returns false once the attempt stopped.
 */
async function restartGPUDecodeParser(
    run: DecodeRun,
    parser: NonNullable<Extract<DecodeWorkerRequest, { type: 'start' }>['gpuVideoParser']>,
    preparedVideoTrack: PreparedVideoTrack,
    queue: GPUDecodePacketQueue,
    failedPacket: EncodedPacket,
    recovery: GPUVideoDecodeRecovery
): Promise<boolean> {
    queue.pipeline?.close();
    // The RPUs read ahead were parsed past the key packet the new parser starts at, so a new reader parses them again in decode order
    await closeGPUDecodeDolbyVisionReader(queue.dolbyVisionReader);
    queue.dolbyVisionReader = null;
    queue.pipeline = null;
    // The packets read ahead went to the failed parser, which made nothing of them
    queue.outgoing.length = 0;
    const previousIterator = run.videoIterator;
    run.videoIterator = null;
    await retireIterator(previousIterator);
    const keyPacket = await queue.packetReader.getNextKey(failedPacket, GPU_DECODE_PACKET_OPTIONS);
    let carriedRecovery: GPUVideoDecodeRecovery | null = recovery;
    for await (const heldPacket of iterateTrackPackets(queue.packetReader, failedPacket, keyPacket, GPU_DECODE_HOLD_PACKET_OPTIONS)) {
        if (!(await waitForFrameCredit(run))) {
            return false;
        }
        const timestampMicroseconds = postGPUDecodeHold(run, heldPacket, carriedRecovery);
        carriedRecovery = null;
        recordVideoAttemptFramePosted(run, timestampMicroseconds);
    }
    if (isVideoAttemptStopped(run)) {
        return false;
    }
    if (!keyPacket) {
        queue.ended = true;
        return true;
    }
    const iterator = iterateTrackPackets(queue.packetReader, keyPacket, null, GPU_DECODE_PACKET_OPTIONS);
    queue.iterator = iterator;
    // The read ahead may have reached the track's end before the failure surfaced; the new parser reads it again
    queue.ended = false;
    run.videoIterator = iterator;
    queue.pipeline = await openGPUDecoderParser(parser.parser, parser.packageVersion, copyDecoderDescription(preparedVideoTrack.decoderConfig.description));
    if (isVideoAttemptStopped(run)) {
        return false;
    }
    queue.dolbyVisionReader = await queue.openDolbyVisionReader(keyPacket);
    if (isVideoAttemptStopped(run)) {
        return false;
    }
    queue.resetPending = true;
    return true;
}

/** Reads packets into the queue until its pictures reach its read-ahead depth or the track ends; returns false once the attempt stopped. */
async function fillGPUDecodePacketQueue(run: DecodeRun, queue: GPUDecodePacketQueue): Promise<boolean> {
    while (!queue.ended && countQueuedPictures(queue) < queue.readAheadDepth) {
        const packetResult = await readNextVideoPacket(queue.iterator);
        if (isVideoAttemptStopped(run)) {
            return false;
        }
        if (packetResult.done) {
            queue.ended = true;
            return true;
        }
        const packet = packetResult.value;
        const timestampMicroseconds = requireMicroseconds(packet.microsecondTimestamp, 'GPU decode packet timestamp');
        const { encodedDolbyVisionMetadata, HDR10PlusMetadata } = await readGPUDecodePacketMetadata(queue, packet, timestampMicroseconds);
        if (isVideoAttemptStopped(run)) {
            return false;
        }
        const outgoingPacket: GPUDecodeOutgoingPacket = {
            data: submitGPUDecodePacket(queue.pipeline, packet),
            durationMicroseconds: requireMicroseconds(Math.max(0, packet.microsecondDuration), 'GPU decode packet duration'),
            encodedDolbyVisionMetadata,
            HDR10PlusMetadata,
            keyframe: packet.type === 'key',
            packet,
            pictureCount: null,
            timestampMicroseconds
        };
        // A failure surfaces when the packet's turn comes; until then only the read-ahead count follows it
        outgoingPacket.data.then(
            (data: GPUDecodeOutgoingData): void => {
                outgoingPacket.pictureCount = data.pictures.length;
            },
            (): void => undefined
        );
        queue.outgoing.push(outgoingPacket);
    }
    return true;
}

/** Fails a parser whose output events for one posted picture, with the ones carried to it, exceed what the page takes. */
function requireOutputEventCount(eventCount: number): void {
    if (eventCount > MAXIMUM_GPU_DECODE_OUTPUT_EVENTS) {
        throw new RangeError(`parser events ${eventCount} > ${MAXIMUM_GPU_DECODE_OUTPUT_EVENTS} for one picture`);
    }
}

/** Returns a picture's output events after the ones a call without a picture left, which wait for the next posted picture, or null when there are none. */
function joinOutputEvents(carriedEvents: readonly number[], outputEvents: Uint32Array | null): Uint32Array | null {
    requireOutputEventCount(carriedEvents.length + (outputEvents?.length ?? 0));
    if (carriedEvents.length === 0) {
        return outputEvents;
    }
    return Uint32Array.from([ ...carriedEvents, ...(outputEvents ?? []) ]);
}

/**
 * Streams one attempt of the frame-pool route: the selected track's compressed packets, in decode order, from the key packet preceding the start time.
 * A decoder package with a parser receives what the parser makes of each packet instead, such as the HEVC decoder's GPU records, one per picture, with the parser's output events;
 * the parser works ahead of the credits on packets it may parse in parallel, and a parser call without a picture posts nothing, its events going with the next picture.
 * A parser failure whose code the header declares recoverable restarts the parser at the next key packet, the packets before it holding the last good frame.
 * Each posted picture spends a video credit, which the page returns once its GPU decode work is submitted; a packet's first picture carries its HDR10+ state.
 */
async function streamGPUDecodePackets(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack
): Promise<void> {
    const queue = await openGPUDecodePacketQueue(run, request, preparedVideoTrack);
    if (!queue) {
        return;
    }
    const parser = request.gpuVideoParser;
    let postedPictureCount = 0;
    let carriedEvents: number[] = [];
    try {
        while (await fillGPUDecodePacketQueue(run, queue)) {
            const next = queue.outgoing.shift();
            if (!next) {
                // The track ended; events no picture carried go with its end
                run.videoTrailingOutputEvents = joinOutputEvents(carriedEvents, null);
                return;
            }
            const data = await readGPUDecodeOutgoingData(run, parser, preparedVideoTrack, queue, next);
            if (data === GPU_DECODE_PARSER_RESTARTED) {
                // The failed parser's events decide nothing any more: the page presents its undecided frames when the holds begin
                carriedEvents = [];
                continue;
            }
            if (data === GPU_DECODE_ATTEMPT_STOPPED || isVideoAttemptStopped(run)) {
                return;
            }
            const postedCount = await postGPUDecodePictures(run, queue, next, data.pictures, carriedEvents, postedPictureCount);
            if (postedCount === null) {
                return;
            }
            if (data.pictures.length > 0) {
                carriedEvents = [];
            }
            postedPictureCount = postedCount;
            // A parser call without a picture, such as one for a skipped leading picture, posts nothing and spends no credit
            carriedEvents.push(...(data.trailingEvents ?? []));
            requireOutputEventCount(carriedEvents.length);
        }
    } finally {
        queue.pipeline?.close();
        await closeGPUDecodeDolbyVisionReader(queue.dolbyVisionReader);
    }
}

// What reading a packet's parsed data comes to instead of the data: its parser failed and restarted at the next key packet, or the attempt stopped
const GPU_DECODE_PARSER_RESTARTED = 'parser-restarted';
const GPU_DECODE_ATTEMPT_STOPPED = 'attempt-stopped';

/**
 * Reads what the parser made of a packet. A parser failure whose code the header declares recoverable restarts the parser at the next key packet;
 * any other failure rejects, which ends the attempt.
 */
async function readGPUDecodeOutgoingData(
    run: DecodeRun,
    parser: Extract<DecodeWorkerRequest, { type: 'start' }>['gpuVideoParser'],
    preparedVideoTrack: PreparedVideoTrack,
    queue: GPUDecodePacketQueue,
    packet: GPUDecodeOutgoingPacket
): Promise<GPUDecodeOutgoingData | typeof GPU_DECODE_PARSER_RESTARTED | typeof GPU_DECODE_ATTEMPT_STOPPED> {
    try {
        return await packet.data;
    } catch (error) {
        const recovery = parser ? getGPUDecoderParserFailureRecovery(parser.parser, error) : null;
        if (!parser || recovery === null) {
            throw error;
        }
        const restarted = await restartGPUDecodeParser(run, parser, preparedVideoTrack, queue, packet.packet, recovery);
        return restarted ? GPU_DECODE_PARSER_RESTARTED : GPU_DECODE_ATTEMPT_STOPPED;
    }
}

/**
 * Posts a packet's pictures, each once a video credit is free; the first carries the events earlier calls without a picture left, and the first after a
 * parser's restart resets the page's decoder. Returns the pictures posted since the attempt began, or null once the attempt stopped.
 */
async function postGPUDecodePictures(
    run: DecodeRun,
    queue: GPUDecodePacketQueue,
    packet: GPUDecodeOutgoingPacket,
    pictures: readonly GPUDecodeOutgoingPicture[],
    carriedEvents: readonly number[],
    postedPictureCount: number
): Promise<number | null> {
    let postedCount = postedPictureCount;
    for (const [ pictureIndex, picture ] of pictures.entries()) {
        if (!(await waitForFrameCredit(run))) {
            return null;
        }
        const firstPicture = pictureIndex === 0;
        postGPUDecodePicture(run, packet, picture, joinOutputEvents(firstPicture ? carriedEvents : [], picture.outputEvents), firstPicture, queue.resetPending);
        queue.resetPending = false;
        recordVideoAttemptFramePosted(run, packet.timestampMicroseconds);
        postedCount += 1;
        postVideoStartupProgress(run, 'video-packet-started', postedCount, packet.timestampMicroseconds);
    }
    return postedCount;
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
    if (run.videoOutputMode === 'frame-pool') {
        return streamGPUDecodePackets(run, request, preparedVideoTrack);
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

    const iterator = iterateVideoSamples(preparedVideoTrack.videoTrack, microsecondsToSeconds(request.startTimeMicroseconds), {
        hardwareAcceleration: preparedVideoTrack.videoHardwareAcceleration,
        optimizeForLatency: true
    });
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

/** Takes the output events the attempt's last packets left without a picture, which its end carries. */
function takeTrailingOutputEvents(run: DecodeRun): Uint32Array | null {
    const outputEvents = run.videoTrailingOutputEvents;
    run.videoTrailingOutputEvents = null;
    return outputEvents;
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
    run.videoTrailingOutputEvents = null;
    try {
        await streamVideoFrames(run, { ...request, startTimeMicroseconds }, preparedVideoTrack);
        if (!isVideoAttemptStopped(run)) {
            run.videoTrackEnded = true;
            const outputEvents = takeTrailingOutputEvents(run);
            // Audio can outlast the video track, so its end is reported separately
            postResponse({
                generation: run.generation,
                ...(outputEvents ? { outputEvents } : {}),
                type: 'video-ended',
                videoEpoch: run.videoEpoch
            }, outputEvents ? [ outputEvents.buffer ] : []);
        }
    } catch (error) {
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

/** Returns the decoder the audio decode worker runs for a track: a host's package, or none for samples Mediabunny decodes here. */
function getAudioDecodeWorkerDecoderBackend(preparedAudioTrack: PreparedAudioTrack): AudioDecodeWorkerDecoderBackend {
    const decoderBackend = preparedAudioTrack.decoderBackend;
    return decoderBackend === 'mediabunny' ? 'pcm' : decoderBackend;
}

/**
 * Returns where a decoder's packets start for the codec it decodes: a lead before the start for DTS and TrueHD to synchronize, or the start.
 * A package decoder takes the lead of its codec.
 */
function getAudioPacketLookupTimeMicroseconds(codec: string, startTimeMicroseconds: Microseconds): Microseconds {
    switch (codec) {
        case 'dts':
            return getAudioPrerollTimeMicroseconds(startTimeMicroseconds, DTS_SEEK_PREROLL_MICROSECONDS);
        case 'mlp':
        case 'truehd':
            return getAudioPrerollTimeMicroseconds(startTimeMicroseconds, TRUEHD_MAJOR_SYNC_PREROLL_MICROSECONDS);
        default:
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
        channelMask: preparedAudioTrack.declaredChannelMask,
        decoderBackend: getAudioDecodeWorkerDecoderBackend(preparedAudioTrack),
        generation: run.generation,
        outputChannelCount: preparedAudioTrack.outputChannelCount,
        packageDecoder: preparedAudioTrack.decoderBackend === 'package' ? request.audioPackageDecoder ?? null : null,
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
 * Sends a package decoder's packets from the one at the lookup time, in batches, each on an input credit.
 * Returns true at the end of the track, and false once the attempt stops.
 */
async function forwardAudioPackets(
    run: DecodeRun,
    attempt: AudioDecodeWorkerAttempt,
    preparedAudioTrack: PreparedAudioTrack,
    lookupTimeMicroseconds: Microseconds
): Promise<boolean> {
    const packetReader = new PacketReader(preparedAudioTrack.audioTrack);
    const startPacket = await getAudioStartPacket(packetReader, lookupTimeMicroseconds);
    const iterator = iterateTrackPackets(packetReader, startPacket, null, {});
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
    const iterator = iterateAudioSamples(preparedAudioTrack.audioTrack, microsecondsToSeconds(startTimeMicroseconds));
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
 * This worker only demuxes for it, so a package decoder or the output stage never holds up video.
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
            getAudioPacketLookupTimeMicroseconds(preparedAudioTrack.routeCodec, request.startTimeMicroseconds)
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
    const packetReader = new PacketReader(preparedAudioTrack.audioTrack);
    const startPacket = await getAudioStartPacket(packetReader, request.startTimeMicroseconds);
    const iterator = iterateTrackPackets(packetReader, startPacket, null, {});
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

/** A run's prepared tracks, which its streams decode, and the media's duration: the server's, else the container's, when it has one. */
type PreparedRunTracks = Readonly<{
    audioTrack: PreparedAudioTrack | null
    durationMicroseconds: Microseconds | null
    videoTrack: PreparedVideoTrack
}>;

/**
 * Prepares a run's tracks, its container duration when the server reported none, and its first attempt's parser, then posts the run's readiness.
 * Returns null, having posted nothing, once the run stopped meanwhile.
 */
async function prepareRunTracks(
    input: Input,
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>
): Promise<PreparedRunTracks | null> {
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
                    ?? CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT,
                request.audioPackageDecoder ?? null
            )
    ];
    const [ preparedVideoTrack, preparedAudioTrack ] = await Promise.all(preparedTrackPromises);
    if (run.cancelled) {
        return null;
    }
    // The container's field order, which Mediabunny's parse of the track already read, goes with every frame that reports none of its own
    run.videoFrameFields = getScanFrameFields(await readContainerVideoScan(preparedVideoTrack.videoTrack));
    const containerDurationMicroseconds = request.durationMicroseconds === undefined ?
        await readContainerDurationMicroseconds(input, preparedVideoTrack.videoTrack) :
        null;
    if (run.cancelled) {
        return null;
    }
    const maximumPictureSize = await prepareGPUDecodeParser(run, request, preparedVideoTrack);
    if (run.cancelled) {
        return null;
    }
    const chromaFormat = await readVideoTrackChromaFormat(preparedVideoTrack);
    if (run.cancelled) {
        return null;
    }
    postReadyResponse(run, preparedVideoTrack, preparedAudioTrack, containerDurationMicroseconds, maximumPictureSize, chromaFormat);
    return {
        audioTrack: preparedAudioTrack,
        durationMicroseconds: request.durationMicroseconds ?? containerDurationMicroseconds,
        videoTrack: preparedVideoTrack
    };
}

/**
 * Runs one generation from its start to its `stopped`, which always comes last.
 * The worker outlives the run: everything the run opened is released before `stopped`, and the next run may start before it, beside the unwinding run.
 */
async function decodeMedia(run: DecodeRun, request: Extract<DecodeWorkerRequest, { type: 'start' }>): Promise<void> {
    let reportDecodeStreamFailure = false;
    let failed = false;
    if (request.timingTrace === true && !run.cancelled) {
        timingTraceRun = run;
        startWorkerTimingTrace((events): void => {
            postResponse({ events, generation: run.generation, type: 'timing-trace' });
        });
    }
    try {
        // A run stopped before it began never opens its input
        if (run.cancelled) {
            return;
        }
        const input = new Input({
            formats: ALL_FORMATS,
            source: openMediaSource(run, request.source)
        });
        run.input = input;
        const prepared = await prepareRunTracks(input, run, request);
        if (!prepared) {
            return;
        }
        if (run.urlSource) {
            await urlSourceRetention.settle(run.urlSource, prepared.durationMicroseconds);
        }
        run.audioStreamFinished = prepared.audioTrack === null;
        const streamPromises: Array<Promise<void>> = [];
        streamPromises.push(
            streamVideoAttempts(run, request, prepared.videoTrack).then((): void => {
                // Finished audio stops waiting for a resync once video is done too
                run.videoStreamFinished = true;
                wakeWaiters(run.wakeAudioControlWaiters);
            })
        );
        if (prepared.audioTrack) {
            streamPromises.push(streamAudioAttempts(run, request, prepared.audioTrack));
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
        if (!run.cancelled || reportDecodeStreamFailure) {
            failed = true;
            postResponse({
                failureKind: classifyFailure(error),
                generation: run.generation,
                message: getSafeErrorMessage(error),
                type: 'error'
            });
        }
    } finally {
        stopRun(run);
        // A failed run's source may hold the failure, so no later run reads on it; a run that acquired it since keeps it either way
        urlSourceRetention.releaseAfterRun(run, failed);
        // A parser pipeline no attempt took ends with the run
        takePreparedGPUDecodeParser(run)?.close();
        if (run.iteratorRetirementPromise) {
            await run.iteratorRetirementPromise;
        }
        // The audio decode worker released each attempt's decoder, output stage, and worklet channel
        await Promise.all(run.audioDecodeAttemptClosures);
        if (currentRun === run) {
            currentRun = null;
        }
        // The page drops a retired run's messages once it stops, so its last timing events go first; a later run's trace is that run's to stop
        if (timingTraceRun === run) {
            timingTraceRun = null;
            stopWorkerTimingTrace();
        }
        postResponse({ generation: run.generation, type: 'stopped' });
    }
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
        preparedGPUDecodeParser: null,
        rawFrameBufferPool: createRawFrameBufferPool(request.videoOutputMode),
        rawVideoFrameFormat: request.rawVideoFrameFormat,
        videoAttemptCancelled: false,
        videoAttemptConsumedCreditCount: 0,
        videoAttemptPostedFrameCount: 0,
        videoDecoderBackend: request.videoDecoderBackend,
        videoEpoch: 0,
        videoFrameFields: null,
        videoOutputMode: request.videoOutputMode,
        videoIterator: null,
        videoStreamFinished: false,
        videoTrackEnded: false,
        videoTrailingOutputEvents: null,
        urlSource: null,
        wakeAudioControlWaiters: [],
        wakeAudioCreditWaiters: [],
        wakeFrameCreditWaiters: [],
        wakeVideoControlWaiters: [],
        wakeVideoDecodeWaiters: []
    };
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

/**
 * Replaces the current run with a new generation's, which starts at once while the replaced run unwinds beside it.
 * Stopping a run closes its decoders and its audio attempt and cancels its reads, so nothing the new run needs waits for the replaced run's `stopped`.
 */
function startDecodeRun(request: Extract<DecodeWorkerRequest, { type: 'start' }>): void {
    if (currentRun) {
        stopRun(currentRun);
    }
    // A lost audio decode worker failed the attempts it served, and the new run spawns another, since the page sends it without waiting for any `stopped`
    if (audioDecodeWorkerClient !== null && audioDecodeWorkerClient.failure !== null) {
        audioDecodeWorkerClient = null;
    }
    if (request.audioTrackIndex !== null && (request.audioOutputMode ?? 'decoded-pcm') === 'decoded-pcm') {
        // Its script loads while the run opens its input
        getAudioDecodeWorkerClient();
    }

    const run = createDecodeRun(request);
    currentRun = run;
    // The run begins once this request's handling returns, so a request handled in the same task, such as another start, cancels it before it opens its input
    void Promise.resolve().then((): Promise<void> => decodeMedia(run, request));
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
            // Raw-plane credits return with their recycled buffers
            if (
                currentRun?.generation === requestValue.generation
                && currentRun.videoOutputMode !== 'raw-planes'
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

/* eslint-enable no-restricted-globals */
