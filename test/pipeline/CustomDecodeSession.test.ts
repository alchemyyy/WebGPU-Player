import { describe, expect, it, vi } from 'vitest';

import {
    millisecondsToMicroseconds,
    secondsToMicroseconds,
    type Microseconds
} from 'webgpu-player/MediaTime';
import { audioFramesToMicroseconds } from 'webgpu-player/TimeMath';
import type CustomDecodeAudioBridge from 'webgpu-player/audio/output/CustomDecodeAudioBridge';
import type { CustomAudioOutputChannelCount } from 'webgpu-player/audio/processing/CustomAudioChannelLayout';
import {
    CUSTOM_AUDIO_DOWNMIX_ALGORITHMS,
    type CustomAudioDownmixAlgorithm
} from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import type { AudioDownmixSettings } from 'webgpu-player/audio/processing/CustomAudioDownmix';
import CustomDecodeNativeAudioBridge, {
    type OwnedNativeMediaAudioBackendPort
} from 'webgpu-player/audio/native/CustomDecodeNativeAudioBridge';
import CustomDecodeSession, {
    type CustomDecodeAudioResyncOptions,
    type CustomDecodeSessionEvent
} from 'webgpu-player/pipeline/CustomDecodeSession';
import {
    isDecodeWorkerRequest,
    MAX_DECODED_FRAME_CREDITS,
    MAX_DECODED_RAW_FRAME_CREDITS,
    type CustomDecodeDolbyVisionProfile,
    type CustomDecodeRawVideoFrameFormat,
    type DecodeWorkerAudioResponse,
    type DecodeWorkerResyncAudioRequest
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import { DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION } from 'webgpu-player/video/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import { resolveDolbyVisionRPUParserWASMURL } from 'webgpu-player/video/dolby-vision/DolbyVisionRPUParser';
import type {
    OwnedNativeMediaAudioEventHandler,
    OwnedNativeMediaAudioTelemetry
} from 'webgpu-player/audio/native/OwnedNativeMediaAudioBackend';
import type {
    RawVideoFrameGeometry,
    TransferableRawVideoFrame
} from 'webgpu-player/video/RawVideoFrameCopy';
import { createDolbyVisionAuthorizationRPUVector } from 'webgpu-player/capability/vectors/DolbyVisionAuthorizationVector';
import { parseHEVCHDR10PlusMetadata } from 'webgpu-player/video/hdr/HDR10PlusMetadata';

import { createHDR10PlusHEVCVector } from '../../src/capability/vectors/HDR10PlusVectors';

type MessageHandler = (event: MessageEvent<unknown>) => void;
type ErrorHandler = (event: ErrorEvent) => void;

const ULTRA_HD_8K_CODED_WIDTH = 7_680;
const ULTRA_HD_8K_CODED_HEIGHT = 4_320;
const ULTRA_HD_16K_CODED_WIDTH = 15_360;
const ULTRA_HD_16K_CODED_HEIGHT = 8_640;
// A row this wide aligns past the safe integer range, so no copy layout can describe it
const UNREPRESENTABLE_CODED_WIDTH = Number.MAX_SAFE_INTEGER;
const UNREPRESENTABLE_CODED_HEIGHT = 2;
const UNREPRESENTABLE_RAW_ROUTE_ERROR = 'Custom decode raw-frame route has no representable copy layout';

class MockWorker {
    readonly postedMessages: unknown[] = [];
    readonly postedTransfers: Transferable[][] = [];
    readonly terminate = vi.fn();

    private readonly errorHandlers = new Set<ErrorHandler>();
    private readonly messageHandlers = new Set<MessageHandler>();

    postMessage(message: unknown, transfer: Transferable[] = []): void {
        this.postedMessages.push(message);
        this.postedTransfers.push(transfer);
    }

    addEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
        if (type === 'message') {
            this.messageHandlers.add(handler as MessageHandler);
        } else if (type === 'error') {
            this.errorHandlers.add(handler as ErrorHandler);
        }
    }

    removeEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
        if (type === 'message') {
            this.messageHandlers.delete(handler as MessageHandler);
        } else if (type === 'error') {
            this.errorHandlers.delete(handler as ErrorHandler);
        }
    }

    emitMessage(data: unknown): void {
        for (const handler of this.messageHandlers) {
            handler({ data } as MessageEvent<unknown>);
        }
    }

    emitError(): void {
        const event = { preventDefault: vi.fn() } as unknown as ErrorEvent;
        for (const handler of this.errorHandlers) {
            handler(event);
        }
    }
}

function createFrame(): VideoFrame & { close: ReturnType<typeof vi.fn> } {
    return { close: vi.fn() } as unknown as VideoFrame & { close: ReturnType<typeof vi.fn> };
}

function createRawFrame(
    mediaTimeMicroseconds: Microseconds,
    geometry: RawVideoFrameGeometry = {
        codedHeight: 2,
        codedWidth: 4,
        displayHeight: 2,
        displayWidth: 4
    }
): TransferableRawVideoFrame {
    const yPlaneHeight = geometry.codedHeight;
    const chromaPlaneHeight = Math.ceil(geometry.codedHeight / 2);
    const yPlaneWidth = geometry.codedWidth;
    const chromaPlaneWidth = Math.ceil(geometry.codedWidth / 2);
    const yPlaneByteLength = 256 * yPlaneHeight;
    const chromaPlaneByteLength = 256 * chromaPlaneHeight;
    return {
        bitDepth: 10,
        codedHeight: geometry.codedHeight,
        codedWidth: geometry.codedWidth,
        colorSpace: {
            fullRange: false,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            transfer: 'smpte2084'
        },
        data: new ArrayBuffer(yPlaneByteLength + (2 * chromaPlaneByteLength)),
        displayHeight: geometry.displayHeight,
        displayWidth: geometry.displayWidth,
        durationMicroseconds: millisecondsToMicroseconds(100),
        format: 'I420P10',
        planes: [
            {
                byteLength: yPlaneByteLength,
                byteOffset: 0,
                bytesPerComponent: 2,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: yPlaneHeight,
                kind: 'y',
                rowByteLength: yPlaneWidth * 2,
                width: yPlaneWidth
            },
            {
                byteLength: chromaPlaneByteLength,
                byteOffset: yPlaneByteLength,
                bytesPerComponent: 2,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: chromaPlaneHeight,
                kind: 'u',
                rowByteLength: chromaPlaneWidth * 2,
                width: chromaPlaneWidth
            },
            {
                byteLength: chromaPlaneByteLength,
                byteOffset: yPlaneByteLength + chromaPlaneByteLength,
                bytesPerComponent: 2,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: chromaPlaneHeight,
                kind: 'v',
                rowByteLength: chromaPlaneWidth * 2,
                width: chromaPlaneWidth
            }
        ],
        timestampMicroseconds: mediaTimeMicroseconds,
        visibleRectangle: {
            height: geometry.displayHeight,
            width: geometry.displayWidth,
            x: 0,
            y: 0
        }
    };
}

function createCompoundRawFrames(mediaTimeMicroseconds: Microseconds): {
    baseFrame: TransferableRawVideoFrame
    enhancementFrame: TransferableRawVideoFrame
} {
    const baseFrameTemplate = createRawFrame(mediaTimeMicroseconds);
    const enhancementFrameTemplate = createRawFrame(mediaTimeMicroseconds, {
        codedHeight: 1,
        codedWidth: 2,
        displayHeight: 1,
        displayWidth: 2
    });
    const enhancementByteOffset = baseFrameTemplate.data.byteLength;
    const data = new ArrayBuffer(enhancementByteOffset + enhancementFrameTemplate.data.byteLength);
    return {
        baseFrame: {
            ...baseFrameTemplate,
            data
        },
        enhancementFrame: {
            ...enhancementFrameTemplate,
            data,
            planes: enhancementFrameTemplate.planes.map(plane => ({
                ...plane,
                byteOffset: plane.byteOffset + enhancementByteOffset
            }))
        }
    };
}

function createDeferred<Value>(): {
    promise: Promise<Value>
    resolve: (value: Value) => void
} {
    let promiseResolver: ((value: Value) => void) | undefined;
    const promise = new Promise<Value>(resolve => {
        promiseResolver = resolve;
    });
    return {
        promise,
        resolve: (value: Value): void => {
            if (!promiseResolver) {
                throw new Error('Deferred promise was not initialized');
            }
            promiseResolver(value);
        }
    };
}

function startSession(
    session: CustomDecodeSession,
    generation: number,
    audioTrackIndex?: number,
    videoOutputMode: 'raw-planes' | 'video-frame' = 'video-frame',
    dolbyVisionProfile: CustomDecodeDolbyVisionProfile = null,
    neutralizeHDRColorMetadata = false
): void {
    session.start({
        audioTrackIndex,
        dolbyVisionProfile,
        generation,
        maximumCodedHeight: videoOutputMode === 'raw-planes' ? 2_160 : 1_080,
        maximumCodedWidth: videoOutputMode === 'raw-planes' ? 3_840 : 1_920,
        nativeHDRTransfer: neutralizeHDRColorMetadata ? 'pq' : null,
        neutralizeHDRColorMetadata,
        rawVideoFrameFormat: videoOutputMode === 'raw-planes' ? 'I420P10' : null,
        startTimeMicroseconds: secondsToMicroseconds(1),
        url: 'http://localhost/video.mp4?ApiKey=secret',
        videoDecoderBackend: videoOutputMode === 'raw-planes' ? 'bundled-hevc' : 'native',
        videoOutputMode,
        videoTrackIndex: 0
    });
}

function emitRawReady(
    worker: MockWorker,
    generation: number,
    geometry: RawVideoFrameGeometry = {
        codedHeight: 2,
        codedWidth: 4,
        displayHeight: 2,
        displayWidth: 4
    }
): void {
    worker.emitMessage({
        audio: null,
        codec: 'hvc1.2.4.L153.B0',
        codedHeight: geometry.codedHeight,
        codedWidth: geometry.codedWidth,
        displayHeight: geometry.displayHeight,
        displayWidth: geometry.displayWidth,
        generation,
        type: 'ready'
    });
}

function emitFrame(
    worker: MockWorker,
    generation: number,
    mediaTimeMicroseconds: number,
    videoEpoch?: number
): ReturnType<typeof createFrame> {
    const frame = createFrame();
    worker.emitMessage({
        durationMicroseconds: 100_000,
        frame,
        generation,
        mediaTimeMicroseconds,
        outputMode: 'video-frame',
        type: 'frame',
        ...(videoEpoch === undefined ? {} : { videoEpoch })
    });
    return frame;
}

function emitRawFrame(
    worker: MockWorker,
    generation: number,
    mediaTimeMicroseconds: Microseconds,
    videoEpoch?: number
): TransferableRawVideoFrame {
    const frame = createRawFrame(mediaTimeMicroseconds);
    worker.emitMessage({
        durationMicroseconds: 100_000,
        frame,
        generation,
        mediaTimeMicroseconds,
        outputMode: 'raw-planes',
        type: 'frame',
        ...(videoEpoch === undefined ? {} : { videoEpoch })
    });
    return frame;
}

const DECODED_AUDIO_SAMPLE_RATE = 48_000;
// 40 ms at 48 kHz, so three samples cover the 100 ms startup and resync minimum
const DECODED_AUDIO_SAMPLE_FRAME_COUNT = 1_920;
const DECODED_AUDIO_SAMPLE_DURATION_MICROSECONDS = 40_000;

type DecodedAudioSessionHarness = {
    audioBridge: CustomDecodeAudioBridge
    events: CustomDecodeSessionEvent[]
    session: CustomDecodeSession
    worker: MockWorker
};

/** Returns a decoded audio bridge double that submits every sample it receives. */
function createSubmittingAudioBridge(initialAudioSampleCredits: number): CustomDecodeAudioBridge {
    return {
        enqueue: vi.fn((message: DecodeWorkerAudioResponse): ReturnType<CustomDecodeAudioBridge['enqueue']> => ({
            frameCount: message.frameCount,
            status: 'submitted'
        })),
        initialAudioSampleCredits,
        start: vi.fn(),
        stop: vi.fn()
    } as unknown as CustomDecodeAudioBridge;
}

function emitAudioSample(
    worker: MockWorker,
    generation: number,
    channelCount: number,
    mediaTimeMicroseconds: number,
    audioEpoch?: number,
    frameCount = DECODED_AUDIO_SAMPLE_FRAME_COUNT
): void {
    worker.emitMessage({
        channelCount,
        channelData: Array.from({ length: channelCount }, (): Float32Array => new Float32Array(frameCount)),
        durationMicroseconds: audioFramesToMicroseconds(frameCount, DECODED_AUDIO_SAMPLE_RATE),
        frameCount,
        generation,
        mediaTimeMicroseconds,
        sampleRate: DECODED_AUDIO_SAMPLE_RATE,
        type: 'audio',
        ...(audioEpoch === undefined ? {} : { audioEpoch })
    });
}

function countPostedMessages(worker: MockWorker, type: string): number {
    return worker.postedMessages.filter((message: unknown): boolean => (
        (message as { type?: unknown }).type === type
    )).length;
}

/** Drives a decoded-PCM session to ready with a 7.1 source mixed down to stereo. */
function startReadyDecodedAudioSession(generation: number): DecodedAudioSessionHarness {
    const worker = new MockWorker();
    const events: CustomDecodeSessionEvent[] = [];
    const audioBridge = createSubmittingAudioBridge(3);
    const session = new CustomDecodeSession(
        (event: CustomDecodeSessionEvent): void => {
            events.push(event);
        },
        (): Worker => worker as unknown as Worker,
        audioBridge
    );
    startSession(session, generation, 0);
    worker.emitMessage({
        audio: {
            channelCount: 2,
            codec: 'opus',
            sampleRate: DECODED_AUDIO_SAMPLE_RATE,
            sourceChannelCount: 8,
            sourceSampleRate: DECODED_AUDIO_SAMPLE_RATE
        },
        codec: 'avc1.640028',
        codedHeight: 1_080,
        codedWidth: 1_920,
        displayHeight: 1_080,
        displayWidth: 1_920,
        generation,
        type: 'ready'
    });
    emitFrame(worker, generation, 1_000_000);
    for (let sampleIndex = 0; sampleIndex < 3; sampleIndex += 1) {
        emitAudioSample(worker, generation, 2, 1_000_000 + sampleIndex * DECODED_AUDIO_SAMPLE_DURATION_MICROSECONDS);
    }
    if (session.getTelemetry().state !== 'ready') {
        throw new Error('The decoded audio session did not become ready');
    }
    return { audioBridge, events, session, worker };
}

/** Issues an audio resync that must be declined without touching the session. */
async function expectAudioResyncDeclined(session: CustomDecodeSession, worker: MockWorker): Promise<void> {
    const postedMessageCount = worker.postedMessages.length;
    const createAudioBridge = vi.fn(async (): Promise<CustomDecodeAudioBridge> => createSubmittingAudioBridge(4));

    await expect(session.resyncAudio({
        createAudioBridge,
        decodedAudioOutputChannelCount: 6,
        targetTimeMicroseconds: secondsToMicroseconds(5)
    })).resolves.toBeNull();

    expect(createAudioBridge).not.toHaveBeenCalled();
    expect(worker.postedMessages).toHaveLength(postedMessageCount);
    expect(session.getTelemetry()).toMatchObject({
        audioEpoch: 0,
        audioResyncCount: 0,
        audioResyncPending: false
    });
}

type NativeAudioSessionHarness = {
    emitBackendEvent: OwnedNativeMediaAudioEventHandler
    endOfStream: ReturnType<typeof vi.fn>
    events: CustomDecodeSessionEvent[]
    session: CustomDecodeSession
    setAuthoritativeTimeMicroseconds: (timeMicroseconds: Microseconds | null) => void
    worker: MockWorker
};

/** Starts a native-media E-AC-3 session whose owned backend opens once the given promise settles. */
function startNativeAudioSession(generation: number, backendOpened: Promise<void> = Promise.resolve()): NativeAudioSessionHarness {
    const worker = new MockWorker();
    const events: CustomDecodeSessionEvent[] = [];
    let activeBackendGeneration: number | null = null;
    let authoritativeTimeMicroseconds: Microseconds | null = null;
    let backendEventHandler: OwnedNativeMediaAudioEventHandler | null = null;
    const endOfStream = vi.fn(async (): Promise<boolean> => true);
    const backend: OwnedNativeMediaAudioBackendPort = {
        appendInitializationSegment: vi.fn(async (): Promise<boolean> => true),
        appendMediaSegment: vi.fn(async (): Promise<boolean> => true),
        destroy: vi.fn(async (): Promise<void> => undefined),
        endOfStream,
        getAuthoritativeTimeMicroseconds: (): Microseconds | null => authoritativeTimeMicroseconds,
        getTelemetry: (): OwnedNativeMediaAudioTelemetry => ({
            activeGeneration: activeBackendGeneration,
            appendedByteLength: 0,
            appendedSegmentCount: 0,
            clockQualified: authoritativeTimeMicroseconds !== null,
            currentTimeMicroseconds: authoritativeTimeMicroseconds,
            pendingAppendByteLength: 0,
            pendingAppendCount: 0,
            removedRangeCount: 0,
            staleOperationCount: 0,
            state: activeBackendGeneration === null ? 'idle' : 'open'
        }),
        seek: (): boolean => true,
        setMuted: (): void => undefined,
        setPlaybackRate: (): void => undefined,
        setPlaying: async (): Promise<boolean> => true,
        setVolume: (): void => undefined,
        start: async (options): Promise<void> => {
            await backendOpened;
            activeBackendGeneration = options.generation;
        },
        stop: vi.fn(async (stoppedGeneration: number): Promise<boolean> => {
            if (activeBackendGeneration !== stoppedGeneration) {
                return false;
            }
            activeBackendGeneration = null;
            return true;
        })
    };
    const nativeAudioBridge = new CustomDecodeNativeAudioBridge(eventHandler => {
        backendEventHandler = eventHandler;
        return backend;
    });
    const session = new CustomDecodeSession(
        event => events.push(event),
        () => worker as unknown as Worker,
        null,
        null,
        () => nativeAudioBridge
    );
    session.start({
        audioOutputMode: 'native-media',
        audioTrackIndex: 0,
        dolbyVisionProfile: null,
        durationMicroseconds: secondsToMicroseconds(10),
        generation,
        maximumCodedHeight: 1_080,
        maximumCodedWidth: 1_920,
        nativeHDRTransfer: null,
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat: null,
        startTimeMicroseconds: secondsToMicroseconds(1),
        url: 'http://localhost/video.mp4?ApiKey=secret',
        videoDecoderBackend: 'native',
        videoOutputMode: 'video-frame',
        videoTrackIndex: 0
    });
    worker.emitMessage({
        audio: {
            channelCount: 6,
            codec: 'ec-3',
            mimeType: 'audio/mp4; codecs="ec-3"',
            outputMode: 'native-media',
            sampleRate: 48_000
        },
        codec: 'hev1.2.4.L153.B0',
        codedHeight: 1_080,
        codedWidth: 1_920,
        displayHeight: 1_080,
        displayWidth: 1_920,
        generation,
        type: 'ready'
    });
    return {
        emitBackendEvent: (event): void => {
            if (!backendEventHandler) {
                throw new Error('The native audio backend has no event handler');
            }
            backendEventHandler(event);
        },
        endOfStream,
        events,
        session,
        setAuthoritativeTimeMicroseconds: (timeMicroseconds: Microseconds | null): void => {
            authoritativeTimeMicroseconds = timeMicroseconds;
        },
        worker
    };
}

describe('CustomDecodeSession', () => {
    it('forwards the qualified FFmpeg MPEG-2/VC-1 backend to the worker', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );

        session.start({
            dolbyVisionProfile: null,
            generation: 5,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: secondsToMicroseconds(1),
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'ffmpeg-mpeg2-vc1',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        });

        expect(worker.postedMessages[0]).toMatchObject({
            generation: 5,
            videoDecoderBackend: 'ffmpeg-mpeg2-vc1',
            videoOutputMode: 'video-frame'
        });
    });

    it('forwards the selected Dolby Vision profile to the worker', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );

        startSession(session, 6, undefined, 'raw-planes', 7);

        expect(worker.postedMessages[0]).toMatchObject({
            dolbyVisionProfile: 7,
            generation: 6,
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'raw-planes'
        });
    });

    it.each([
        { height: ULTRA_HD_8K_CODED_HEIGHT, label: '8K', profile: null, width: ULTRA_HD_8K_CODED_WIDTH },
        { height: ULTRA_HD_16K_CODED_HEIGHT, label: '16K', profile: null, width: ULTRA_HD_16K_CODED_WIDTH },
        { height: ULTRA_HD_8K_CODED_HEIGHT, label: '8K Profile 7', profile: 7, width: ULTRA_HD_8K_CODED_WIDTH }
    ] as const)('starts a $label 10-bit raw transfer at any frame size', ({ height, profile, width }) => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );

        session.start({
            dolbyVisionProfile: profile,
            generation: 40,
            maximumCodedHeight: height,
            maximumCodedWidth: width,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: secondsToMicroseconds(0),
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        });

        expect(worker.postedMessages[0]).toMatchObject({
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            maximumCodedHeight: height,
            maximumCodedWidth: width,
            videoOutputMode: 'raw-planes'
        });
    });

    it('rejects raw geometry only when no copy layout can describe it', () => {
        const session = new CustomDecodeSession(
            () => undefined,
            () => new MockWorker() as unknown as Worker
        );

        expect(() => session.start({
            dolbyVisionProfile: null,
            generation: 41,
            maximumCodedHeight: UNREPRESENTABLE_CODED_HEIGHT,
            maximumCodedWidth: UNREPRESENTABLE_CODED_WIDTH,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: secondsToMicroseconds(0),
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        })).toThrow(UNREPRESENTABLE_RAW_ROUTE_ERROR);
    });

    it('accepts every raw plane format and rejects unknown or mismatched formats', () => {
        const rawVideoFrameFormats: readonly CustomDecodeRawVideoFrameFormat[] = [
            'I420',
            'I420P10',
            'I420P12',
            'I422',
            'I422P10',
            'I422P12',
            'I444',
            'I444P10',
            'I444P12'
        ];
        const startOptions = {
            dolbyVisionProfile: null,
            generation: 43,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            startTimeMicroseconds: secondsToMicroseconds(0),
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'native',
            videoTrackIndex: 0
        } as const;
        for (const rawVideoFrameFormat of rawVideoFrameFormats) {
            const worker = new MockWorker();
            const session = new CustomDecodeSession(
                () => undefined,
                () => worker as unknown as Worker
            );

            session.start({
                ...startOptions,
                rawVideoFrameFormat,
                videoOutputMode: 'raw-planes'
            });

            expect(worker.postedMessages[0]).toMatchObject({
                rawVideoFrameFormat,
                videoOutputMode: 'raw-planes'
            });
        }

        const rejectedWorker = new MockWorker();
        const rejectingSession = new CustomDecodeSession(
            () => undefined,
            () => rejectedWorker as unknown as Worker
        );
        expect(() => rejectingSession.start({
            ...startOptions,
            rawVideoFrameFormat: 'NV12' as unknown as CustomDecodeRawVideoFrameFormat,
            videoOutputMode: 'raw-planes'
        })).toThrow('Raw custom decode requires a requested raw frame format');
        expect(() => rejectingSession.start({
            ...startOptions,
            rawVideoFrameFormat: null,
            videoOutputMode: 'raw-planes'
        })).toThrow('Raw custom decode requires a requested raw frame format');
        expect(() => rejectingSession.start({
            ...startOptions,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'video-frame'
        })).toThrow('VideoFrame custom decode cannot request a raw frame format');
        expect(rejectedWorker.postedMessages).toHaveLength(0);
    });

    it('records bounded owned-video startup progress without emitting player events', () => {
        const worker = new MockWorker();
        const events: CustomDecodeSessionEvent[] = [];
        const session = new CustomDecodeSession(
            event => events.push(event),
            () => worker as unknown as Worker
        );
        startSession(session, 30, undefined, 'raw-planes');

        worker.emitMessage({
            generation: 30,
            mediaTimeMicroseconds: 1_000_000,
            packetCount: 17,
            phase: 'video-packet-started',
            type: 'progress'
        });

        expect(session.getTelemetry()).toMatchObject({
            state: 'starting',
            submittedVideoPacketCount: 17,
            videoProgressPhase: 'video-packet-started'
        });
        expect(events).toEqual([]);
    });

    it('forwards encoded Dolby Vision ownership and records extraction telemetry', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            (): void => undefined,
            () => worker as unknown as Worker
        );
        startSession(session, 31);
        emitRawReady(worker, 31);
        const frame = createFrame();
        const encodedDolbyVisionMetadata = {
            enhancementLayerDisposition: 'discarded-fel',
            hasEnhancementLayerVCL: true,
            parsedRPUData: [ createDolbyVisionAuthorizationRPUVector(7, 'fel') ],
            schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
        } as const;
        worker.emitMessage({
            durationMicroseconds: 100_000,
            encodedDolbyVisionMetadata,
            frame,
            generation: 31,
            mediaTimeMicroseconds: 1_100_000,
            outputMode: 'video-frame',
            type: 'frame'
        });

        const presentationFrame = session.takeFrame(secondsToMicroseconds(1.1));
        expect(presentationFrame?.encodedDolbyVisionMetadata).toBe(encodedDolbyVisionMetadata);
        expect(session.getTelemetry()).toMatchObject({
            receivedDolbyVisionEnhancementFrameCount: 1,
            receivedDolbyVisionFrameCount: 1,
            receivedDolbyVisionRPUCount: 1
        });
        if (!presentationFrame || presentationFrame.outputMode !== 'video-frame') {
            throw new Error('Expected a transferred decoded video frame');
        }
        expect(session.acknowledgeFrame(presentationFrame)).toBe(true);
        presentationFrame.frame.close();
    });

    it('forwards per-frame HDR10+ states and records fail-closed telemetry', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            (): void => undefined,
            () => worker as unknown as Worker
        );
        startSession(session, 32);
        emitRawReady(worker, 32);
        const validMetadata = parseHEVCHDR10PlusMetadata(createHDR10PlusHEVCVector('valid'), { kind: 'annex-b' });
        worker.emitMessage({
            durationMicroseconds: 100_000,
            frame: createFrame(),
            generation: 32,
            HDR10PlusMetadata: validMetadata,
            mediaTimeMicroseconds: 1_100_000,
            outputMode: 'video-frame',
            type: 'frame'
        });
        worker.emitMessage({
            durationMicroseconds: 100_000,
            frame: createFrame(),
            generation: 32,
            HDR10PlusMetadata: { metadata: null, status: 'malformed' },
            mediaTimeMicroseconds: 1_200_000,
            outputMode: 'video-frame',
            type: 'frame'
        });

        const validFrame = session.takeFrame(secondsToMicroseconds(1.1));
        const malformedFrame = session.takeFrame(secondsToMicroseconds(1.2));
        expect(validFrame?.HDR10PlusMetadata).toBe(validMetadata);
        expect(malformedFrame?.HDR10PlusMetadata).toEqual({
            metadata: null,
            status: 'malformed'
        });
        expect(session.getTelemetry()).toMatchObject({
            receivedHDR10PlusMalformedFrameCount: 1,
            receivedHDR10PlusValidFrameCount: 1
        });
        for (const presentationFrame of [ validFrame, malformedFrame ]) {
            if (!presentationFrame || presentationFrame.outputMode !== 'video-frame') {
                throw new Error('Expected a transferred decoded video frame');
            }
            expect(session.acknowledgeFrame(presentationFrame)).toBe(true);
            presentationFrame.frame.close();
        }
    });

    it('asks the worker to discard a dual-layer EL only when the route discards it', () => {
        const startOptions = {
            dolbyVisionProfile: 7,
            durationMicroseconds: secondsToMicroseconds(60),
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: secondsToMicroseconds(0),
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        } as const;
        const postedRequests = [ false, true ].map((discardDolbyVisionEnhancementLayer: boolean, index: number) => {
            const worker = new MockWorker();
            new CustomDecodeSession(() => undefined, () => worker as unknown as Worker).start({
                ...startOptions,
                discardDolbyVisionEnhancementLayer,
                generation: index + 1
            });
            return worker.postedMessages[0];
        });

        expect(postedRequests[0]).not.toHaveProperty('discardDolbyVisionEnhancementLayer');
        expect(postedRequests[1]).toMatchObject({
            discardDolbyVisionEnhancementLayer: true,
            dolbyVisionProfile: 7,
            type: 'start'
        });
    });

    it('asks for the container duration only without a server duration and forwards it on ready', () => {
        const knownDurationWorker = new MockWorker();
        const knownDurationSession = new CustomDecodeSession(
            () => undefined,
            () => knownDurationWorker as unknown as Worker
        );
        knownDurationSession.start({
            dolbyVisionProfile: null,
            durationMicroseconds: secondsToMicroseconds(60),
            generation: 3,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: secondsToMicroseconds(1),
            url: 'http://localhost/video.mp4?ApiKey=secret',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        });
        expect(knownDurationWorker.postedMessages[0]).not.toHaveProperty('reportContainerDuration');

        const worker = new MockWorker();
        const events: CustomDecodeSessionEvent[] = [];
        const session = new CustomDecodeSession(
            event => events.push(event),
            () => worker as unknown as Worker
        );
        startSession(session, 4);
        expect(worker.postedMessages[0]).toMatchObject({ reportContainerDuration: true });
        worker.emitMessage({
            audio: null,
            codec: 'avc1.640028',
            codedHeight: 1080,
            codedWidth: 1920,
            containerDurationMicroseconds: secondsToMicroseconds(5_400),
            displayHeight: 1080,
            displayWidth: 1920,
            generation: 4,
            type: 'ready'
        });
        emitFrame(worker, 4, 1_100_000);

        expect(events.at(-1)).toMatchObject({
            containerDurationMicroseconds: secondsToMicroseconds(5_400),
            type: 'ready'
        });
    });

    it('starts with four credits and replenishes only consumed queue entries', () => {
        const worker = new MockWorker();
        const events: CustomDecodeSessionEvent[] = [];
        const session = new CustomDecodeSession(
            event => events.push(event),
            () => worker as unknown as Worker
        );

        startSession(session, 7);
        expect(worker.postedMessages).toEqual([ {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: resolveDolbyVisionRPUParserWASMURL(),
            frameCredits: MAX_DECODED_FRAME_CREDITS,
            generation: 7,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            // This session starts without a server duration
            reportContainerDuration: true,
            startTimeMicroseconds: 1_000_000,
            type: 'start',
            url: 'http://localhost/video.mp4?ApiKey=secret',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        } ]);

        worker.emitMessage({
            audio: null,
            codec: 'avc1.640028',
            codedHeight: 1080,
            codedWidth: 1920,
            displayHeight: 1080,
            displayWidth: 1920,
            generation: 7,
            staticHDRMetadataScan: {
                accessUnitCount: 16,
                firstMetadataAccessUnitIndex: 1,
                metadata: {
                    masteringDisplayMaximumLuminanceNits: 4_000,
                    masteringDisplayMinimumLuminanceNits: 0.005,
                    maximumContentLightLevelNits: 500,
                    maximumFrameAverageLightLevelNits: 200
                },
                status: 'valid'
            },
            type: 'ready'
        });
        expect(session.getTelemetry().state).toBe('configured');
        expect(events).toEqual([ {
            audio: null,
            codec: 'avc1.640028',
            generation: 7,
            staticHDRMetadata: {
                masteringDisplayMaximumLuminanceNits: 4_000,
                masteringDisplayMinimumLuminanceNits: 0.005,
                maximumContentLightLevelNits: 500,
                maximumFrameAverageLightLevelNits: 200
            },
            type: 'configured'
        } ]);

        const firstFrame = emitFrame(worker, 7, 1_100_000);
        expect(session.getTelemetry().state).toBe('ready');
        expect(events.at(-1)).toEqual({
            audio: null,
            codec: 'avc1.640028',
            generation: 7,
            staticHDRMetadata: {
                masteringDisplayMaximumLuminanceNits: 4_000,
                masteringDisplayMinimumLuminanceNits: 0.005,
                maximumContentLightLevelNits: 500,
                maximumFrameAverageLightLevelNits: 200
            },
            type: 'ready'
        });
        const selectedFrame = emitFrame(worker, 7, 1_200_000);
        emitFrame(worker, 7, 1_300_000);
        emitFrame(worker, 7, 1_400_000);

        const presentationFrame = session.takeFrame(secondsToMicroseconds(1.25));
        expect(presentationFrame?.frame).toBe(selectedFrame);
        expect(firstFrame.close).toHaveBeenCalledOnce();
        expect(selectedFrame.close).not.toHaveBeenCalled();
        expect(worker.postedMessages.at(-1)).toEqual({
            frameCredits: 1,
            generation: 7,
            type: 'pull'
        });
        expect(session.getTelemetry()).toMatchObject({
            queuedFrameCount: 2,
            pendingFrameCount: 1,
            receivedFrameCount: 4,
            staticHDRMetadataFirstAccessUnitIndex: 1,
            staticHDRMetadataScanAccessUnitCount: 16,
            staticHDRMetadataStatus: 'valid',
            state: 'ready',
            takenFrameCount: 1
        });
        expect(events).toContainEqual({
            audio: null,
            codec: 'avc1.640028',
            generation: 7,
            staticHDRMetadata: {
                masteringDisplayMaximumLuminanceNits: 4_000,
                masteringDisplayMinimumLuminanceNits: 0.005,
                maximumContentLightLevelNits: 500,
                maximumFrameAverageLightLevelNits: 200
            },
            type: 'ready'
        });

        if (!presentationFrame || presentationFrame.outputMode !== 'video-frame') {
            throw new Error('Expected a decoded VideoFrame');
        }
        expect(session.acknowledgeFrame(presentationFrame)).toBe(true);
        expect(worker.postedMessages.at(-1)).toEqual({
            frameCredits: 1,
            generation: 7,
            type: 'pull'
        });
        expect(session.acknowledgeFrame(presentationFrame)).toBe(false);
        presentationFrame.frame.close();
    });

    it.each([ 'conflicting', 'malformed' ] as const)(
        'records %s static HDR metadata without propagating untrusted values',
        (status) => {
            const worker = new MockWorker();
            const events: CustomDecodeSessionEvent[] = [];
            const session = new CustomDecodeSession(
                event => events.push(event),
                () => worker as unknown as Worker
            );

            startSession(session, 8);
            worker.emitMessage({
                audio: null,
                codec: 'hvc1.2.4.L153.B0',
                codedHeight: 1_080,
                codedWidth: 1_920,
                displayHeight: 1_080,
                displayWidth: 1_920,
                generation: 8,
                staticHDRMetadataScan: {
                    accessUnitCount: 16,
                    firstMetadataAccessUnitIndex: null,
                    metadata: null,
                    status
                },
                type: 'ready'
            });

            expect(session.getTelemetry()).toMatchObject({
                staticHDRMetadataFirstAccessUnitIndex: null,
                staticHDRMetadataScanAccessUnitCount: 16,
                staticHDRMetadataStatus: status,
                state: 'configured'
            });
            expect(events).toEqual([ {
                audio: null,
                codec: 'hvc1.2.4.L153.B0',
                generation: 8,
                type: 'configured'
            } ]);
        }
    );

    it('forwards native HDR metadata neutralization to the worker start request', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            vi.fn(),
            () => worker as unknown as Worker
        );

        startSession(session, 8, undefined, 'video-frame', null, true);

        expect(worker.postedMessages[0]).toMatchObject({
            generation: 8,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
    });

    it('forwards an exact decoded multichannel output count to the worker', () => {
        const worker = new MockWorker();
        const audioBridge = {
            enqueue: vi.fn(),
            initialAudioSampleCredits: 2,
            start: vi.fn(),
            stop: vi.fn()
        } as unknown as CustomDecodeAudioBridge;
        const session = new CustomDecodeSession(
            vi.fn(),
            () => worker as unknown as Worker,
            audioBridge
        );

        const audioDownmixSettings: AudioDownmixSettings = {
            centerLevel: 0.4,
            outputGain: 0.6,
            surroundLevel: 0.5,
            version: 1
        };
        session.start({
            audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
            audioDownmixSettings,
            audioTrackIndex: 0,
            decodedAudioOutputChannelCount: 8,
            dolbyVisionProfile: null,
            generation: 9,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: secondsToMicroseconds(1),
            url: 'http://localhost/video.mkv?ApiKey=secret',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        });

        expect(worker.postedMessages[0]).toMatchObject({
            audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
            audioDownmixSettings,
            audioTrackIndex: 0,
            decodedAudioOutputChannelCount: 8,
            generation: 9,
            type: 'start'
        });
    });

    it('posts an isolated live downmix snapshot only after stereo downmix configuration', () => {
        const worker = new MockWorker();
        const audioBridge = {
            enqueue: vi.fn(),
            initialAudioSampleCredits: 2,
            start: vi.fn(),
            stop: vi.fn()
        } as unknown as CustomDecodeAudioBridge;
        const session = new CustomDecodeSession(
            vi.fn(),
            () => worker as unknown as Worker,
            audioBridge
        );
        startSession(session, 39, 0);
        const settings: {
            centerLevel: number
            outputGain: number
            surroundLevel: number
            version: 1
        } = {
            centerLevel: 0.75,
            outputGain: 1.5,
            surroundLevel: 0.5,
            version: 1
        };

        expect(session.updateAudioDownmixSettings(settings)).toBe(false);
        worker.emitMessage({
            audio: {
                channelCount: 2,
                codec: 'opus',
                sampleRate: 48_000,
                sourceChannelCount: 6,
                sourceSampleRate: 48_000
            },
            codec: 'avc1.640028',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 39,
            type: 'ready'
        });

        expect(session.updateAudioDownmixSettings(settings)).toBe(true);
        settings.outputGain = 9;
        expect(worker.postedMessages).toContainEqual({
            audioDownmixSettings: {
                centerLevel: 0.75,
                outputGain: 1.5,
                surroundLevel: 0.5,
                version: 1
            },
            generation: 39,
            type: 'update-audio-downmix-settings'
        });

        worker.postMessage = (): void => {
            throw new Error('Worker closed');
        };
        expect(session.updateAudioDownmixSettings({
            centerLevel: 1,
            outputGain: 2,
            surroundLevel: 1,
            version: 1
        })).toBe(false);
        expect(session.getTelemetry()).toMatchObject({
            failureKind: null,
            state: 'configured'
        });
        expect(() => session.updateAudioDownmixSettings({
            centerLevel: 1,
            outputGain: 11,
            surroundLevel: 1,
            version: 1
        })).toThrow(RangeError);
    });

    it('accepts live downmix changes for stereo output and declines multichannel output', () => {
        const settings: AudioDownmixSettings = {
            centerLevel: 1,
            outputGain: 2,
            surroundLevel: 1,
            version: 1
        };
        // A declared stereo source can still decode to a bed that folds down
        const configurations = [
            {
                accepted: true,
                channelCount: 2,
                decodedAudioOutputChannelCount: 2 as const,
                generation: 40,
                sourceChannelCount: 2
            },
            {
                accepted: false,
                channelCount: 8,
                decodedAudioOutputChannelCount: 8 as const,
                generation: 41,
                sourceChannelCount: 8
            }
        ];

        for (const configuration of configurations) {
            const worker = new MockWorker();
            const audioBridge = {
                enqueue: vi.fn(),
                initialAudioSampleCredits: 2,
                start: vi.fn(),
                stop: vi.fn()
            } as unknown as CustomDecodeAudioBridge;
            const session = new CustomDecodeSession(
                vi.fn(),
                () => worker as unknown as Worker,
                audioBridge
            );
            session.start({
                audioTrackIndex: 0,
                decodedAudioOutputChannelCount: configuration.decodedAudioOutputChannelCount,
                dolbyVisionProfile: null,
                generation: configuration.generation,
                maximumCodedHeight: 1_080,
                maximumCodedWidth: 1_920,
                nativeHDRTransfer: null,
                neutralizeHDRColorMetadata: false,
                rawVideoFrameFormat: null,
                startTimeMicroseconds: secondsToMicroseconds(1),
                url: 'http://localhost/video.mkv?ApiKey=secret',
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame',
                videoTrackIndex: 0
            });
            worker.emitMessage({
                audio: {
                    channelCount: configuration.channelCount,
                    codec: 'opus',
                    sampleRate: 48_000,
                    sourceChannelCount: configuration.sourceChannelCount,
                    sourceSampleRate: 48_000
                },
                codec: 'avc1.640028',
                codedHeight: 1_080,
                codedWidth: 1_920,
                displayHeight: 1_080,
                displayWidth: 1_920,
                generation: configuration.generation,
                type: 'ready'
            });

            expect(session.updateAudioDownmixSettings(settings)).toBe(configuration.accepted);
            expect(worker.postedMessages.some(message => (
                typeof message === 'object'
                && message !== null
                && 'type' in message
                && message.type === 'update-audio-downmix-settings'
            ))).toBe(configuration.accepted);
        }
    });

    it('declines live downmix changes for configured native media audio', () => {
        const worker = new MockWorker();
        const nativeAudioBridge = {
            initialAudioSegmentCredits: 2,
            start: vi.fn(async (): Promise<boolean> => true),
            stop: vi.fn(async (): Promise<void> => undefined)
        } as unknown as CustomDecodeNativeAudioBridge;
        const session = new CustomDecodeSession(
            vi.fn(),
            () => worker as unknown as Worker,
            null,
            null,
            () => nativeAudioBridge
        );
        session.start({
            audioOutputMode: 'native-media',
            audioTrackIndex: 0,
            dolbyVisionProfile: null,
            durationMicroseconds: secondsToMicroseconds(10),
            generation: 42,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: secondsToMicroseconds(1),
            url: 'http://localhost/video.mp4?ApiKey=secret',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        });
        worker.emitMessage({
            audio: {
                channelCount: 6,
                codec: 'ec-3',
                mimeType: 'audio/mp4; codecs="ec-3"',
                outputMode: 'native-media',
                sampleRate: 48_000,
                sourceChannelCount: 6,
                sourceSampleRate: 48_000
            },
            codec: 'hev1.2.4.L153.B0',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 42,
            type: 'ready'
        });

        expect(session.updateAudioDownmixSettings({
            centerLevel: 1,
            outputGain: 2,
            surroundLevel: 1,
            version: 1
        })).toBe(false);
        expect(session.getTelemetry()).toMatchObject({
            failureKind: null,
            state: 'configured'
        });
        expect(worker.postedMessages.some(message => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'update-audio-downmix-settings'
        ))).toBe(false);
    });

    it('rejects a decoded output count that does not match the request', () => {
        const worker = new MockWorker();
        const audioBridge = {
            enqueue: vi.fn(),
            initialAudioSampleCredits: 2,
            start: vi.fn(),
            stop: vi.fn()
        } as unknown as CustomDecodeAudioBridge;
        const session = new CustomDecodeSession(
            vi.fn(),
            () => worker as unknown as Worker,
            audioBridge
        );
        session.start({
            audioTrackIndex: 0,
            decodedAudioOutputChannelCount: 8,
            dolbyVisionProfile: null,
            generation: 10,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: secondsToMicroseconds(1),
            url: 'http://localhost/video.mkv?ApiKey=secret',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        });

        worker.emitMessage({
            audio: { channelCount: 2, codec: 'flac', sampleRate: 48_000 },
            codec: 'avc1.640028',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 10,
            type: 'ready'
        });

        expect(session.getTelemetry()).toMatchObject({
            failureKind: 'audio-output-failed',
            state: 'error'
        });
        expect(audioBridge.start).not.toHaveBeenCalled();
    });

    it('keeps two raw frames outstanding while acknowledgement is delayed', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );

        startSession(session, 12, undefined, 'raw-planes');
        emitRawReady(worker, 12);
        expect(worker.postedMessages[0]).toMatchObject({
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            generation: 12,
            rawVideoFrameFormat: 'I420P10',
            type: 'start',
            videoOutputMode: 'raw-planes'
        });

        const firstRawFrame = emitRawFrame(worker, 12, secondsToMicroseconds(1.1));
        const secondRawFrame = emitRawFrame(worker, 12, secondsToMicroseconds(1.2));
        expect(session.getTelemetry()).toMatchObject({
            peakFrameCount: 2,
            pendingFrameCount: 0,
            queuedFrameCount: 2,
            receivedFrameCount: 2
        });

        const firstPresentationFrame = session.takeFrame(secondsToMicroseconds(1.1));
        const secondPresentationFrame = session.takeFrame(secondsToMicroseconds(1.2));
        expect(worker.postedMessages).toHaveLength(1);
        expect(session.getTelemetry()).toMatchObject({
            pendingFrameCount: 2,
            queuedFrameCount: 0,
            takenFrameCount: 2
        });

        if (
            !firstPresentationFrame
            || firstPresentationFrame.outputMode !== 'raw-planes'
            || !secondPresentationFrame
            || secondPresentationFrame.outputMode !== 'raw-planes'
        ) {
            throw new Error('Expected two decoded raw frames');
        }
        expect(session.acknowledgeFrame(firstPresentationFrame)).toBe(true);
        expect(worker.postedMessages.at(-1)).toEqual({
            buffer: firstRawFrame.data,
            generation: 12,
            type: 'recycle-frame'
        });
        expect(worker.postedTransfers.at(-1)).toEqual([ firstRawFrame.data ]);
        expect(session.getTelemetry().recycledRawFrameCount).toBe(1);

        emitRawFrame(worker, 12, secondsToMicroseconds(1.3));
        expect(session.getTelemetry()).toMatchObject({
            pendingFrameCount: 1,
            queuedFrameCount: 1,
            receivedFrameCount: 3
        });
        expect(session.acknowledgeFrame(secondPresentationFrame)).toBe(true);
        expect(worker.postedMessages.at(-1)).toEqual({
            buffer: secondRawFrame.data,
            generation: 12,
            type: 'recycle-frame'
        });
    });

    it('recycles a compound Dolby Vision frame through one atomic buffer transfer', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );

        startSession(session, 32, undefined, 'raw-planes');
        emitRawReady(worker, 32);
        const mediaTimeMicroseconds = secondsToMicroseconds(1.1);
        const { baseFrame, enhancementFrame } = createCompoundRawFrames(mediaTimeMicroseconds);
        worker.emitMessage({
            durationMicroseconds: 100_000,
            encodedDolbyVisionMetadata: {
                enhancementLayerDisposition: 'decoded-fel',
                hasEnhancementLayerVCL: true,
                parsedRPUData: [
                    createDolbyVisionAuthorizationRPUVector(7, 'fel')
                ],
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            },
            enhancementFrame,
            frame: baseFrame,
            generation: 32,
            mediaTimeMicroseconds,
            outputMode: 'raw-planes',
            type: 'frame'
        });

        const presentationFrame = session.takeFrame(mediaTimeMicroseconds);
        if (!presentationFrame || presentationFrame.outputMode !== 'raw-planes') {
            throw new Error('Expected a compound decoded raw frame');
        }
        expect(presentationFrame.frame).toBe(baseFrame);
        expect(presentationFrame.enhancementFrame).toBe(enhancementFrame);
        expect(presentationFrame.enhancementFrame?.data).toBe(presentationFrame.frame.data);
        expect(session.acknowledgeFrame(presentationFrame)).toBe(true);
        expect(worker.postedMessages.at(-1)).toEqual({
            buffer: baseFrame.data,
            generation: 32,
            type: 'recycle-frame'
        });
        expect(worker.postedTransfers.at(-1)).toEqual([ baseFrame.data ]);
        expect(session.getTelemetry()).toMatchObject({
            pendingFrameCount: 0,
            receivedDolbyVisionEnhancementFrameCount: 1,
            receivedDolbyVisionFrameCount: 1,
            recycledRawFrameCount: 1
        });
    });

    it('recycles dropped raw buffers instead of issuing allocation credits', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );

        startSession(session, 13, undefined, 'raw-planes');
        emitRawReady(worker, 13);
        const droppedRawFrame = emitRawFrame(worker, 13, secondsToMicroseconds(1.1));
        const selectedRawFrame = emitRawFrame(worker, 13, secondsToMicroseconds(1.2));
        const presentationFrame = session.takeFrame(secondsToMicroseconds(1.2));

        expect(worker.postedMessages.at(-1)).toEqual({
            buffer: droppedRawFrame.data,
            generation: 13,
            type: 'recycle-frame'
        });
        expect(worker.postedTransfers.at(-1)).toEqual([ droppedRawFrame.data ]);
        expect(session.getTelemetry()).toMatchObject({
            droppedFrameCount: 1,
            pendingFrameCount: 1,
            queuedFrameCount: 0,
            recycledRawFrameCount: 1
        });

        if (!presentationFrame || presentationFrame.outputMode !== 'raw-planes') {
            throw new Error('Expected the selected decoded raw frame');
        }
        expect(session.discardFrame(presentationFrame)).toBe(true);
        expect(worker.postedMessages.at(-1)).toEqual({
            buffer: selectedRawFrame.data,
            generation: 13,
            type: 'recycle-frame'
        });
    });

    it('fails cleanly if recycling a skipped raw frame throws synchronously', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );

        startSession(session, 17, undefined, 'raw-planes');
        emitRawReady(worker, 17);
        emitRawFrame(worker, 17, secondsToMicroseconds(1.1));
        emitRawFrame(worker, 17, secondsToMicroseconds(1.2));
        vi.spyOn(worker, 'postMessage').mockImplementation(() => {
            throw new DOMException('Transfer failed', 'DataCloneError');
        });

        expect(session.takeFrame(secondsToMicroseconds(1.2))).toBeNull();
        expect(session.getTelemetry()).toMatchObject({
            abandonedRawFrameCount: 2,
            pendingFrameCount: 0,
            queuedFrameCount: 0,
            state: 'error'
        });
    });

    it('rejects a configured track above the negotiated route before accepting frames', () => {
        const worker = new MockWorker();
        const events: CustomDecodeSessionEvent[] = [];
        const session = new CustomDecodeSession(
            event => events.push(event),
            () => worker as unknown as Worker
        );
        session.start({
            dolbyVisionProfile: null,
            generation: 18,
            maximumCodedHeight: 720,
            maximumCodedWidth: 1_280,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: secondsToMicroseconds(1),
            url: 'http://localhost/video.mp4',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        });

        worker.emitMessage({
            audio: null,
            codec: 'avc1.640028',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 18,
            type: 'ready'
        });

        expect(session.getTelemetry().state).toBe('error');
        expect(events.at(-1)).toMatchObject({
            failureKind: 'decode-failed',
            generation: 18,
            type: 'error'
        });
        expect(worker.postedMessages.at(-1)).toEqual({ generation: 18, type: 'stop' });
    });

    it('accepts a configured track coded within block alignment of the negotiated route', () => {
        const worker = new MockWorker();
        const events: CustomDecodeSessionEvent[] = [];
        const session = new CustomDecodeSession(
            event => events.push(event),
            () => worker as unknown as Worker
        );
        session.start({
            dolbyVisionProfile: null,
            generation: 18,
            maximumCodedHeight: 2_076,
            maximumCodedWidth: 3_840,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: secondsToMicroseconds(1),
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        });

        // Matroska stores the 2080-line coded size of a 2076-line letterboxed HEVC picture
        worker.emitMessage({
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: 2_080,
            codedWidth: 3_840,
            displayHeight: 2_080,
            displayWidth: 3_840,
            generation: 18,
            type: 'ready'
        });

        expect(session.getTelemetry().state).toBe('configured');
        expect(events).toEqual([ {
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            generation: 18,
            type: 'configured'
        } ]);
    });

    it('accepts first-frame coded padding and locks the actual raw geometry', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );
        startSession(session, 19, undefined, 'raw-planes');
        emitRawReady(worker, 19, {
            codedHeight: 1,
            codedWidth: 4,
            displayHeight: 2,
            displayWidth: 4
        });

        emitRawFrame(worker, 19, secondsToMicroseconds(1.1));
        emitRawFrame(worker, 19, secondsToMicroseconds(1.2));

        expect(session.getTelemetry()).toMatchObject({
            abandonedRawFrameCount: 0,
            receivedFrameCount: 2,
            state: 'ready'
        });
    });

    it('rejects raw display geometry that differs from the selected track', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );
        startSession(session, 19, undefined, 'raw-planes');
        emitRawReady(worker, 19);
        const rawFrame = createRawFrame(secondsToMicroseconds(1.1));
        rawFrame.displayWidth = 80;

        worker.emitMessage({
            durationMicroseconds: 100_000,
            frame: rawFrame,
            generation: 19,
            mediaTimeMicroseconds: secondsToMicroseconds(1.1),
            outputMode: 'raw-planes',
            type: 'frame'
        });

        expect(session.getTelemetry()).toMatchObject({
            abandonedRawFrameCount: 1,
            receivedFrameCount: 0,
            state: 'error'
        });
        expect(worker.postedMessages.at(-1)).toEqual({ generation: 19, type: 'stop' });
    });

    it('rejects raw coded geometry changes after the first decoded frame', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );
        startSession(session, 20, undefined, 'raw-planes');
        emitRawReady(worker, 20);
        emitRawFrame(worker, 20, secondsToMicroseconds(1.1));
        const changedFrame = createRawFrame(secondsToMicroseconds(1.2), {
            codedHeight: 4,
            codedWidth: 4,
            displayHeight: 2,
            displayWidth: 4
        });

        worker.emitMessage({
            durationMicroseconds: 100_000,
            frame: changedFrame,
            generation: 20,
            mediaTimeMicroseconds: secondsToMicroseconds(1.2),
            outputMode: 'raw-planes',
            type: 'frame'
        });

        expect(session.getTelemetry()).toMatchObject({
            receivedFrameCount: 1,
            state: 'error'
        });
        expect(worker.postedMessages.at(-1)).toEqual({ generation: 20, type: 'stop' });
    });

    it('rejects first-frame coded padding above the negotiated maximum', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );
        session.start({
            dolbyVisionProfile: null,
            generation: 21,
            maximumCodedHeight: 2,
            maximumCodedWidth: 4,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: secondsToMicroseconds(1),
            url: 'http://localhost/video.mp4',
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        });
        emitRawReady(worker, 21);
        const oversizedFrame = createRawFrame(secondsToMicroseconds(1.1), {
            codedHeight: 68,
            codedWidth: 4,
            displayHeight: 2,
            displayWidth: 4
        });

        worker.emitMessage({
            durationMicroseconds: 100_000,
            frame: oversizedFrame,
            generation: 21,
            mediaTimeMicroseconds: secondsToMicroseconds(1.1),
            outputMode: 'raw-planes',
            type: 'frame'
        });

        expect(session.getTelemetry()).toMatchObject({
            abandonedRawFrameCount: 1,
            receivedFrameCount: 0,
            state: 'error'
        });
        expect(worker.postedMessages.at(-1)).toEqual({ generation: 21, type: 'stop' });
    });

    it('closes stale frames and retires superseded workers by generation', async () => {
        const workers = [ new MockWorker(), new MockWorker() ];
        let workerIndex = 0;
        const session = new CustomDecodeSession(
            () => undefined,
            () => workers[workerIndex++] as unknown as Worker
        );

        startSession(session, 1);
        const pendingOldFrame = emitFrame(workers[0], 1, 1_000_000);
        const queuedOldFrame = emitFrame(workers[0], 1, 1_100_000);
        expect(session.takeFrame(secondsToMicroseconds(1))?.frame).toBe(pendingOldFrame);
        startSession(session, 2);

        expect(pendingOldFrame.close).toHaveBeenCalledOnce();
        expect(queuedOldFrame.close).toHaveBeenCalledOnce();
        expect(workers[0].postedMessages.at(-1)).toEqual({ generation: 1, type: 'stop' });

        const staleFrame = emitFrame(workers[0], 1, 1_100_000);
        expect(staleFrame.close).toHaveBeenCalledOnce();
        expect(session.getTelemetry().staleFrameCount).toBe(1);

        workers[0].emitMessage({ generation: 1, type: 'stopped' });
        expect(workers[0].terminate).toHaveBeenCalledOnce();

        const currentFrame = emitFrame(workers[1], 2, 1_000_000);
        expect(session.takeFrame(secondsToMicroseconds(1))?.frame).toBe(currentFrame);
        const stopPromise = session.stop();
        expect(currentFrame.close).toHaveBeenCalledOnce();
        expect(workers[1].postedMessages.at(-1)).toEqual({ generation: 2, type: 'stop' });
        workers[1].emitMessage({ generation: 2, type: 'stopped' });
        await stopPromise;
        expect(workers[1].terminate).toHaveBeenCalledOnce();
    });

    it('does not recycle a pending raw buffer into a superseding generation', () => {
        const workers = [ new MockWorker(), new MockWorker() ];
        let workerIndex = 0;
        const session = new CustomDecodeSession(
            () => undefined,
            () => workers[workerIndex++] as unknown as Worker
        );

        startSession(session, 14, undefined, 'raw-planes');
        emitRawReady(workers[0], 14);
        emitRawFrame(workers[0], 14, secondsToMicroseconds(1.1));
        const stalePresentationFrame = session.takeFrame(secondsToMicroseconds(1.1));
        startSession(session, 15, undefined, 'raw-planes');
        emitRawReady(workers[1], 15);

        if (!stalePresentationFrame || stalePresentationFrame.outputMode !== 'raw-planes') {
            throw new Error('Expected a pending decoded raw frame');
        }
        const oldWorkerMessageCount = workers[0].postedMessages.length;
        expect(session.acknowledgeFrame(stalePresentationFrame)).toBe(false);
        expect(workers[0].postedMessages).toHaveLength(oldWorkerMessageCount);
        expect(workers[1].postedMessages).toHaveLength(1);
        expect(session.getTelemetry().staleFrameCount).toBe(0);
    });

    it('latches worker failures, closes queued frames, and reports an event', () => {
        const worker = new MockWorker();
        const events: CustomDecodeSessionEvent[] = [];
        const session = new CustomDecodeSession(
            event => events.push(event),
            () => worker as unknown as Worker
        );
        startSession(session, 3);
        const frame = emitFrame(worker, 3, 1_000_000);

        worker.emitMessage({
            failureKind: 'range-unsupported',
            generation: 3,
            message: 'Range requests are required',
            type: 'error'
        });

        expect(frame.close).toHaveBeenCalledOnce();
        expect(session.getTelemetry()).toMatchObject({
            failureKind: 'range-unsupported',
            queuedFrameCount: 0,
            state: 'error'
        });
        expect(events.at(-1)).toEqual({
            failureKind: 'range-unsupported',
            generation: 3,
            message: 'Range requests are required',
            type: 'error'
        });
    });

    it('fails closed if the worker exceeds the four-frame queue bound', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );
        startSession(session, 4);
        const acceptedFrames = Array.from(
            { length: MAX_DECODED_FRAME_CREDITS },
            (_value, frameIndex) => emitFrame(worker, 4, frameIndex * 100_000)
        );
        const overflowFrame = emitFrame(worker, 4, 500_000);

        for (const frame of acceptedFrames) {
            expect(frame.close).toHaveBeenCalledOnce();
        }
        expect(overflowFrame.close).toHaveBeenCalledOnce();
        expect(session.getTelemetry().state).toBe('error');
        expect(worker.postedMessages.at(-1)).toEqual({ generation: 4, type: 'stop' });
    });

    it('fails closed if queued and pending raw frames exceed the two-buffer pool', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );
        startSession(session, 16, undefined, 'raw-planes');
        emitRawReady(worker, 16);
        emitRawFrame(worker, 16, secondsToMicroseconds(1.1));
        emitRawFrame(worker, 16, secondsToMicroseconds(1.2));
        const pendingFrame = session.takeFrame(secondsToMicroseconds(1.1));

        expect(session.getTelemetry()).toMatchObject({
            pendingFrameCount: 1,
            queuedFrameCount: 1
        });
        emitRawFrame(worker, 16, secondsToMicroseconds(1.3));

        expect(session.getTelemetry()).toMatchObject({
            abandonedRawFrameCount: 3,
            peakFrameCount: 2,
            pendingFrameCount: 0,
            queuedFrameCount: 0,
            state: 'error'
        });
        expect(worker.postedMessages.at(-1)).toEqual({ generation: 16, type: 'stop' });
        expect(pendingFrame).not.toBeNull();
    });

    it('closes frames from invalid or crashed worker messages', () => {
        const worker = new MockWorker();
        const events: CustomDecodeSessionEvent[] = [];
        const session = new CustomDecodeSession(
            event => events.push(event),
            () => worker as unknown as Worker
        );
        startSession(session, 5);

        const invalidFrame = createFrame();
        worker.emitMessage({
            durationMicroseconds: 10_000,
            frame: invalidFrame,
            generation: 5,
            mediaTimeMicroseconds: 0.5,
            type: 'frame'
        });
        expect(invalidFrame.close).toHaveBeenCalledOnce();
        expect(session.getTelemetry().state).toBe('error');

        const crashingWorker = new MockWorker();
        const crashingSession = new CustomDecodeSession(
            event => events.push(event),
            () => crashingWorker as unknown as Worker
        );
        startSession(crashingSession, 6);
        const queuedFrame = emitFrame(crashingWorker, 6, 1_000_000);
        crashingWorker.emitError();
        expect(queuedFrame.close).toHaveBeenCalledOnce();
        expect(crashingWorker.terminate).toHaveBeenCalledOnce();
        expect(crashingSession.getTelemetry().state).toBe('error');
    });

    it('forcibly terminates a worker that does not acknowledge stop', async () => {
        vi.useFakeTimers();
        try {
            const worker = new MockWorker();
            const session = new CustomDecodeSession(
                () => undefined,
                () => worker as unknown as Worker
            );
            startSession(session, 8);

            const stopPromise = session.stop();
            expect(worker.terminate).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1_000);
            await stopPromise;

            expect(worker.terminate).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps fallback and destroy stops pending until a failed worker retires', async () => {
        const worker = new MockWorker();
        const fallbackStopPromises: Promise<void>[] = [];
        const session = new CustomDecodeSession(
            event => {
                if (event.type === 'error') {
                    fallbackStopPromises.push(session.stop());
                }
            },
            () => worker as unknown as Worker
        );
        startSession(session, 11);

        worker.emitMessage({
            failureKind: 'decode-failed',
            generation: 11,
            message: 'Decoder failed',
            type: 'error'
        });
        const fallbackStopPromise = fallbackStopPromises[0];
        if (!fallbackStopPromise) {
            throw new Error('The fallback stop was not requested');
        }
        const destroyStopPromise = session.stop();
        let fallbackStopSettled = false;
        let destroyStopSettled = false;
        const observedFallbackStopPromise = fallbackStopPromise.then((): void => {
            fallbackStopSettled = true;
        });
        const observedDestroyStopPromise = destroyStopPromise.then((): void => {
            destroyStopSettled = true;
        });
        await Promise.resolve();

        expect(fallbackStopPromises).toHaveLength(1);
        expect(destroyStopPromise).toBe(fallbackStopPromise);
        expect(fallbackStopSettled).toBe(false);
        expect(destroyStopSettled).toBe(false);
        expect(worker.postedMessages.filter(message => (message as { type?: string }).type === 'stop')).toHaveLength(1);
        expect(worker.terminate).not.toHaveBeenCalled();

        worker.emitMessage({ generation: 11, type: 'stopped' });
        await fallbackStopPromise;
        await destroyStopPromise;
        await observedFallbackStopPromise;
        await observedDestroyStopPromise;

        expect(worker.terminate).toHaveBeenCalledOnce();
    });

    it('waits for decoded video and a bounded PCM prebuffer before reporting ready', () => {
        const worker = new MockWorker();
        const audioBridge = {
            enqueue: vi.fn(() => ({ frameCount: 1_024, status: 'submitted' as const })),
            initialAudioSampleCredits: 3,
            start: vi.fn(),
            stop: vi.fn()
        } as unknown as CustomDecodeAudioBridge;
        const events: CustomDecodeSessionEvent[] = [];
        const session = new CustomDecodeSession(
            event => events.push(event),
            () => worker as unknown as Worker,
            audioBridge
        );

        startSession(session, 9, 1);
        expect(worker.postedMessages[0]).toMatchObject({
            audioSampleCredits: 0,
            audioTrackIndex: 1,
            generation: 9,
            type: 'start'
        });

        const audioConfiguration = {
            channelCount: 2,
            codec: 'pcm-s24',
            sampleRate: 48_000,
            sourceChannelCount: 1,
            sourceSampleRate: 12_345
        };
        worker.emitMessage({
            audio: audioConfiguration,
            codec: 'hev1.2.4.L153.B0',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 9,
            type: 'ready'
        });
        expect(audioBridge.start).toHaveBeenCalledOnce();
        expect(worker.postedMessages.at(-1)).toEqual({
            audioSampleCredits: 3,
            generation: 9,
            type: 'pull-audio'
        });
        expect(events).toEqual([ {
            audio: audioConfiguration,
            codec: 'hev1.2.4.L153.B0',
            generation: 9,
            type: 'configured'
        } ]);

        emitFrame(worker, 9, 1_000_000);
        expect(session.getTelemetry().state).toBe('configured');
        expect(events).toHaveLength(1);

        for (let sampleIndex = 0; sampleIndex < 5; sampleIndex += 1) {
            worker.emitMessage({
                channelCount: 2,
                channelData: [ new Float32Array(1_024), new Float32Array(1_024) ],
                durationMicroseconds: 21_333,
                frameCount: 1_024,
                generation: 9,
                mediaTimeMicroseconds: 1_000_000 + Math.round(sampleIndex * 1_024 * 1_000_000 / 48_000),
                sampleRate: 48_000,
                type: 'audio'
            });
            if (sampleIndex < 4) {
                expect(session.getTelemetry().state).toBe('configured');
            }
        }
        expect(audioBridge.enqueue).toHaveBeenCalledTimes(5);
        expect(events.at(-1)).toEqual({
            audio: audioConfiguration,
            codec: 'hev1.2.4.L153.B0',
            generation: 9,
            type: 'ready'
        });
        expect(session.getTelemetry()).toMatchObject({
            audioChannelCount: 2,
            audioCodec: 'pcm-s24',
            audioSampleRate: 48_000,
            audioSourceChannelCount: 1,
            audioSourceSampleRate: 12_345,
            receivedAudioFrameCount: 5_120,
            receivedAudioSampleCount: 5,
            submittedAudioFrameCount: 5_120,
            submittedAudioSampleCount: 5
        });

        const bridgeStartOptions = vi.mocked(audioBridge.start).mock.calls[0][0];
        bridgeStartOptions.callbacks.onCreditsReleased(2);
        expect(worker.postedMessages.at(-1)).toEqual({
            audioSampleCredits: 2,
            generation: 9,
            type: 'pull-audio'
        });

        bridgeStartOptions.callbacks.onFailure('The audio worklet overflowed');
        expect(session.getTelemetry()).toMatchObject({
            failureKind: 'audio-output-failed',
            state: 'error'
        });
        expect(worker.postedMessages.at(-1)).toEqual({ generation: 9, type: 'stop' });
        expect(audioBridge.stop).toHaveBeenCalledWith(9);
        worker.emitMessage({ generation: 9, type: 'stopped' });
    });

    it('requires a fresh PCM prebuffer after replacing the decode generation', async () => {
        const workers = [ new MockWorker(), new MockWorker() ];
        let workerIndex = 0;
        const audioBridge = {
            enqueue: vi.fn(() => ({ frameCount: 1_920, status: 'submitted' as const })),
            initialAudioSampleCredits: 3,
            start: vi.fn(),
            stop: vi.fn()
        } as unknown as CustomDecodeAudioBridge;
        const events: CustomDecodeSessionEvent[] = [];
        const session = new CustomDecodeSession(
            event => events.push(event),
            () => workers[workerIndex++] as unknown as Worker,
            audioBridge
        );
        const audioConfiguration = {
            channelCount: 2,
            codec: 'pcm-s24',
            sampleRate: 48_000,
            sourceChannelCount: 2,
            sourceSampleRate: 48_000
        };
        const emitAudioPrebuffer = (worker: MockWorker, generation: number): void => {
            for (let sampleIndex = 0; sampleIndex < 3; sampleIndex += 1) {
                worker.emitMessage({
                    channelCount: 2,
                    channelData: [ new Float32Array(1_920), new Float32Array(1_920) ],
                    durationMicroseconds: 40_000,
                    frameCount: 1_920,
                    generation,
                    mediaTimeMicroseconds: 1_000_000 + sampleIndex * 40_000,
                    sampleRate: 48_000,
                    type: 'audio'
                });
            }
        };

        startSession(session, 40, 1);
        workers[0].emitMessage({
            audio: audioConfiguration,
            codec: 'avc1.640029',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 40,
            type: 'ready'
        });
        emitFrame(workers[0], 40, 1_000_000);
        emitAudioPrebuffer(workers[0], 40);
        expect(events.filter(event => event.type === 'ready')).toHaveLength(1);

        startSession(session, 41, 1);
        workers[0].emitMessage({ generation: 40, type: 'stopped' });
        workers[1].emitMessage({
            audio: audioConfiguration,
            codec: 'avc1.640029',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 41,
            type: 'ready'
        });
        emitFrame(workers[1], 41, 1_000_000);
        for (let sampleIndex = 0; sampleIndex < 2; sampleIndex += 1) {
            workers[1].emitMessage({
                channelCount: 2,
                channelData: [ new Float32Array(1_920), new Float32Array(1_920) ],
                durationMicroseconds: 40_000,
                frameCount: 1_920,
                generation: 41,
                mediaTimeMicroseconds: 1_000_000 + sampleIndex * 40_000,
                sampleRate: 48_000,
                type: 'audio'
            });
        }
        expect(events.filter(event => event.type === 'ready')).toHaveLength(1);

        workers[1].emitMessage({
            channelCount: 2,
            channelData: [ new Float32Array(1_920), new Float32Array(1_920) ],
            durationMicroseconds: 40_000,
            frameCount: 1_920,
            generation: 41,
            mediaTimeMicroseconds: 1_080_000,
            sampleRate: 48_000,
            type: 'audio'
        });
        expect(events.filter(event => event.type === 'ready')).toHaveLength(2);
        expect(session.getTelemetry().submittedAudioFrameCount).toBe(5_760);

        const stopPromise = session.stop();
        workers[1].emitMessage({ generation: 41, type: 'stopped' });
        await stopPromise;
    });

    it('feeds native fMP4 audio through one owned backend before clock handoff', async () => {
        const worker = new MockWorker();
        const events: CustomDecodeSessionEvent[] = [];
        let activeBackendGeneration: number | null = null;
        let backendEventHandler: OwnedNativeMediaAudioEventHandler = event => {
            if (event.type === 'error') {
                throw new Error(event.message);
            }
        };
        const appendInitializationSegment = vi.fn(async (): Promise<boolean> => true);
        const appendMediaSegment = vi.fn(async (): Promise<boolean> => true);
        const endOfStream = vi.fn(async (): Promise<boolean> => true);
        const stopBackend = vi.fn(async (generation: number): Promise<boolean> => {
            if (activeBackendGeneration !== generation) {
                return false;
            }
            activeBackendGeneration = null;
            return true;
        });
        const backend: OwnedNativeMediaAudioBackendPort = {
            appendInitializationSegment,
            appendMediaSegment,
            destroy: vi.fn(async (): Promise<void> => undefined),
            endOfStream,
            getAuthoritativeTimeMicroseconds: (): Microseconds | null => null,
            getTelemetry: (): OwnedNativeMediaAudioTelemetry => ({
                activeGeneration: activeBackendGeneration,
                appendedByteLength: 0,
                appendedSegmentCount: 0,
                clockQualified: false,
                currentTimeMicroseconds: null,
                pendingAppendByteLength: 0,
                pendingAppendCount: 0,
                removedRangeCount: 0,
                staleOperationCount: 0,
                state: activeBackendGeneration === null ? 'idle' : 'open'
            }),
            seek: (): boolean => true,
            setMuted: (): void => undefined,
            setPlaybackRate: (): void => undefined,
            setPlaying: async (): Promise<boolean> => true,
            setVolume: (): void => undefined,
            start: async options => {
                activeBackendGeneration = options.generation;
            },
            stop: stopBackend
        };
        const nativeAudioBridge = new CustomDecodeNativeAudioBridge(eventHandler => {
            backendEventHandler = eventHandler;
            return backend;
        });
        const session = new CustomDecodeSession(
            event => events.push(event),
            () => worker as unknown as Worker,
            null,
            null,
            () => nativeAudioBridge
        );
        session.start({
            audioOutputMode: 'native-media',
            audioTrackIndex: 0,
            dolbyVisionProfile: null,
            durationMicroseconds: secondsToMicroseconds(10),
            generation: 30,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: secondsToMicroseconds(1),
            url: 'http://localhost/video.mp4?ApiKey=secret',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        });
        expect(worker.postedMessages[0]).toMatchObject({
            audioOutputMode: 'native-media',
            audioSampleCredits: 0,
            audioTrackIndex: 0,
            generation: 30,
            type: 'start'
        });

        const audioConfiguration = {
            channelCount: 6,
            codec: 'ec-3',
            mimeType: 'audio/mp4; codecs="ec-3"',
            outputMode: 'native-media' as const,
            sampleRate: 48_000
        };
        worker.emitMessage({
            audio: audioConfiguration,
            codec: 'hev1.2.4.L153.B0',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 30,
            type: 'ready'
        });
        await vi.waitFor(() => expect(worker.postedMessages.at(-1)).toEqual({
            audioSampleCredits: 2,
            generation: 30,
            type: 'pull-audio'
        }));
        emitFrame(worker, 30, 1_000_000);
        expect(session.getTelemetry().state).toBe('configured');

        worker.emitMessage({
            data: new Uint8Array([ 1, 2 ]).buffer,
            generation: 30,
            type: 'native-audio-init'
        });
        worker.emitMessage({
            data: new Uint8Array([ 3, 4 ]).buffer,
            endTimeMicroseconds: 1_500_000,
            generation: 30,
            startTimeMicroseconds: 1_000_000,
            type: 'native-audio-media'
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(appendInitializationSegment).toHaveBeenCalledOnce();
        expect(appendMediaSegment).toHaveBeenCalledOnce();
        expect(worker.postedMessages.at(-1)).toEqual({
            audioSampleCredits: 1,
            generation: 30,
            type: 'pull-audio'
        });
        expect(session.getTelemetry().state).toBe('ready');
        expect(events.at(-1)).toEqual({
            audio: audioConfiguration,
            codec: 'hev1.2.4.L153.B0',
            generation: 30,
            type: 'ready'
        });
        const readyEventCount = events.filter(event => event.type === 'ready').length;

        backendEventHandler({ generation: 30, type: 'clock-ready' });
        expect(session.getTelemetry()).toMatchObject({
            nativeAudioClockReady: true,
            state: 'ready'
        });
        expect(events.filter(event => event.type === 'ready')).toHaveLength(readyEventCount);

        worker.emitMessage({ generation: 30, type: 'ended' });
        await Promise.resolve();
        await Promise.resolve();
        expect(endOfStream).toHaveBeenCalledWith(30);
        expect(session.getTelemetry().state).toBe('ready');

        backendEventHandler({ generation: 30, type: 'ended' });
        expect(events.at(-1)).toEqual({ generation: 30, type: 'ended' });
        expect(session.getTelemetry().state).toBe('ended');

        const stopPromise = session.stop();
        worker.emitMessage({ generation: 30, type: 'stopped' });
        await stopPromise;
        expect(stopBackend).toHaveBeenCalledWith(30);
    });

    it('discards a bridge factory result after its decode generation stops', async () => {
        const worker = new MockWorker();
        const audioBridge = {
            enqueue: vi.fn(),
            initialAudioSampleCredits: 2,
            start: vi.fn(),
            stop: vi.fn()
        } as unknown as CustomDecodeAudioBridge;
        const deferredAudioBridge = createDeferred<CustomDecodeAudioBridge>();
        const audioBridgeFactory = vi.fn(() => deferredAudioBridge.promise);
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker,
            null,
            audioBridgeFactory
        );

        startSession(session, 10, 0);
        worker.emitMessage({
            audio: { channelCount: 2, codec: 'opus', sampleRate: 48_000 },
            codec: 'vp09.00.10.08',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 10,
            type: 'ready'
        });
        expect(audioBridgeFactory).toHaveBeenCalledOnce();

        const stopPromise = session.stop();
        worker.emitMessage({ generation: 10, type: 'stopped' });
        await stopPromise;
        deferredAudioBridge.resolve(audioBridge);
        await deferredAudioBridge.promise;
        await Promise.resolve();

        expect(audioBridge.start).not.toHaveBeenCalled();
        expect(session.getTelemetry().state).toBe('idle');
    });

    it('resyncs video in a new epoch and returns discarded VideoFrame credits in one pull', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );
        startSession(session, 60);
        emitRawReady(worker, 60);
        const pendingVideoFrame = emitFrame(worker, 60, 1_100_000);
        const discardedFrames = [
            emitFrame(worker, 60, 1_200_000),
            emitFrame(worker, 60, 1_300_000)
        ];
        const pendingPresentationFrame = session.takeFrame(secondsToMicroseconds(1.1));
        const postedMessageCount = worker.postedMessages.length;

        expect(session.resyncVideo(secondsToMicroseconds(5))).toBe(true);

        expect(worker.postedMessages.slice(postedMessageCount)).toEqual([
            {
                generation: 60,
                targetTimeMicroseconds: 5_000_000,
                type: 'resync-video',
                videoEpoch: 1
            },
            {
                frameCredits: discardedFrames.length,
                generation: 60,
                type: 'pull'
            }
        ]);
        for (const discardedFrame of discardedFrames) {
            expect(discardedFrame.close).toHaveBeenCalledOnce();
        }
        expect(pendingVideoFrame.close).not.toHaveBeenCalled();
        expect(session.getTelemetry()).toMatchObject({
            pendingFrameCount: 1,
            queuedFrameCount: 0,
            staleFrameCount: discardedFrames.length,
            videoEpoch: 1,
            videoResyncCount: 1,
            videoSuspensionCount: 0
        });
        expect(session.takeFrame(secondsToMicroseconds(1.3))).toBeNull();

        // The presenter still owns the earlier-epoch frame and returns its credit on release
        if (!pendingPresentationFrame || pendingPresentationFrame.outputMode !== 'video-frame') {
            throw new Error('Expected a pending decoded VideoFrame');
        }
        expect(pendingPresentationFrame.frame).toBe(pendingVideoFrame);
        expect(session.acknowledgeFrame(pendingPresentationFrame)).toBe(true);
        expect(worker.postedMessages.at(-1)).toEqual({
            frameCredits: 1,
            generation: 60,
            type: 'pull'
        });
    });

    it('advances one epoch sequence across suspension and resync without empty pulls', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );
        startSession(session, 61);
        emitRawReady(worker, 61);
        const postedMessageCount = worker.postedMessages.length;

        expect(session.suspendVideo()).toBe(true);
        expect(session.getTelemetry()).toMatchObject({
            videoEpoch: 1,
            videoResyncCount: 0,
            videoSuspensionCount: 1
        });
        expect(session.resyncVideo(secondsToMicroseconds(8))).toBe(true);

        expect(worker.postedMessages.slice(postedMessageCount)).toEqual([
            {
                generation: 61,
                type: 'suspend-video',
                videoEpoch: 1
            },
            {
                generation: 61,
                targetTimeMicroseconds: 8_000_000,
                type: 'resync-video',
                videoEpoch: 2
            }
        ]);
        expect(session.getTelemetry()).toMatchObject({
            staleFrameCount: 0,
            videoEpoch: 2,
            videoResyncCount: 1,
            videoSuspensionCount: 1
        });
    });

    it('recycles queued raw buffers instead of pulling when video is suspended', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );
        startSession(session, 62, undefined, 'raw-planes');
        emitRawReady(worker, 62);
        const firstRawFrame = emitRawFrame(worker, 62, secondsToMicroseconds(1.1));
        const secondRawFrame = emitRawFrame(worker, 62, secondsToMicroseconds(1.2));
        const postedMessageCount = worker.postedMessages.length;

        expect(session.suspendVideo()).toBe(true);

        expect(worker.postedMessages.slice(postedMessageCount)).toEqual([
            {
                generation: 62,
                type: 'suspend-video',
                videoEpoch: 1
            },
            {
                buffer: firstRawFrame.data,
                generation: 62,
                type: 'recycle-frame'
            },
            {
                buffer: secondRawFrame.data,
                generation: 62,
                type: 'recycle-frame'
            }
        ]);
        // Equal-length zeroed buffers compare equal, so transfer ownership is checked by identity
        expect(worker.postedTransfers[postedMessageCount]).toEqual([]);
        expect(worker.postedTransfers[postedMessageCount + 1][0]).toBe(firstRawFrame.data);
        expect(worker.postedTransfers[postedMessageCount + 2][0]).toBe(secondRawFrame.data);
        expect(session.getTelemetry()).toMatchObject({
            abandonedRawFrameCount: 0,
            queuedFrameCount: 0,
            recycledRawFrameCount: 2,
            staleFrameCount: 2,
            videoEpoch: 1,
            videoSuspensionCount: 1
        });
        expect(session.takeFrame(secondsToMicroseconds(1.2))).toBeNull();
    });

    it('closes an in-flight VideoFrame from a replaced epoch and returns its credit', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );
        startSession(session, 63);
        emitRawReady(worker, 63);
        expect(session.resyncVideo(secondsToMicroseconds(5))).toBe(true);
        const postedMessageCount = worker.postedMessages.length;

        // An omitted epoch denotes the initial attempt that the resync replaced
        const staleFrame = emitFrame(worker, 63, 1_100_000);

        expect(staleFrame.close).toHaveBeenCalledOnce();
        expect(worker.postedMessages.slice(postedMessageCount)).toEqual([ {
            frameCredits: 1,
            generation: 63,
            type: 'pull'
        } ]);
        expect(session.getTelemetry()).toMatchObject({
            queuedFrameCount: 0,
            receivedFrameCount: 0,
            staleFrameCount: 1,
            state: 'configured'
        });
        expect(session.takeFrame(secondsToMicroseconds(1.1))).toBeNull();

        const currentFrame = emitFrame(worker, 63, 5_000_000, 1);
        expect(currentFrame.close).not.toHaveBeenCalled();
        expect(session.takeFrame(secondsToMicroseconds(5))?.frame).toBe(currentFrame);
        expect(session.getTelemetry()).toMatchObject({
            receivedFrameCount: 1,
            staleFrameCount: 1,
            state: 'ready'
        });
    });

    it('recycles an in-flight raw buffer from a replaced epoch without queueing it', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );
        startSession(session, 64, undefined, 'raw-planes');
        emitRawReady(worker, 64);
        expect(session.resyncVideo(secondsToMicroseconds(5))).toBe(true);
        expect(session.resyncVideo(secondsToMicroseconds(9))).toBe(true);
        const postedMessageCount = worker.postedMessages.length;

        const staleRawFrame = emitRawFrame(worker, 64, secondsToMicroseconds(5), 1);

        expect(worker.postedMessages.slice(postedMessageCount)).toEqual([ {
            buffer: staleRawFrame.data,
            generation: 64,
            type: 'recycle-frame'
        } ]);
        expect(worker.postedTransfers[postedMessageCount][0]).toBe(staleRawFrame.data);
        expect(session.getTelemetry()).toMatchObject({
            abandonedRawFrameCount: 0,
            queuedFrameCount: 0,
            receivedFrameCount: 0,
            recycledRawFrameCount: 1,
            staleFrameCount: 1,
            videoEpoch: 2
        });
        expect(session.takeFrame(secondsToMicroseconds(5))).toBeNull();

        // The recycled buffer must not count against the two-buffer raw queue bound
        emitRawFrame(worker, 64, secondsToMicroseconds(9), 2);
        emitRawFrame(worker, 64, secondsToMicroseconds(9.1), 2);
        expect(session.getTelemetry()).toMatchObject({
            failureKind: null,
            queuedFrameCount: 2,
            receivedFrameCount: 2,
            state: 'ready'
        });
    });

    it('forwards video interruptions only for the current epoch', () => {
        const worker = new MockWorker();
        const events: CustomDecodeSessionEvent[] = [];
        const session = new CustomDecodeSession(
            event => events.push(event),
            () => worker as unknown as Worker
        );
        const interruptionEvent: CustomDecodeSessionEvent = {
            generation: 65,
            reason: 'decoder-reclaimed',
            type: 'video-interrupted'
        };
        const emitVideoInterruption = (videoEpoch: number): void => {
            worker.emitMessage({
                generation: 65,
                reason: 'decoder-reclaimed',
                type: 'video-interrupted',
                videoEpoch
            });
        };
        startSession(session, 65);
        emitRawReady(worker, 65);
        emitFrame(worker, 65, 1_100_000);
        const eventCount = events.length;

        emitVideoInterruption(0);

        expect(events.slice(eventCount)).toEqual([ interruptionEvent ]);
        expect(session.getTelemetry()).toMatchObject({
            failureKind: null,
            state: 'ready'
        });

        expect(session.resyncVideo(secondsToMicroseconds(2))).toBe(true);
        const postedMessageCount = worker.postedMessages.length;
        // An interruption from the replaced attempt is superseded by the resync
        emitVideoInterruption(0);
        expect(events.slice(eventCount)).toEqual([ interruptionEvent ]);

        emitVideoInterruption(1);
        expect(events.slice(eventCount)).toEqual([ interruptionEvent, interruptionEvent ]);
        expect(worker.postedMessages).toHaveLength(postedMessageCount);
    });

    it('reports the video track end only for the current epoch', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );
        const emitVideoEnded = (videoEpoch: number): void => {
            worker.emitMessage({
                generation: 67,
                type: 'video-ended',
                videoEpoch
            });
        };
        startSession(session, 67);
        emitRawReady(worker, 67);
        emitFrame(worker, 67, 1_100_000);
        expect(session.getTelemetry().videoEnded).toBe(false);

        emitVideoEnded(0);
        // The audio-only tail keeps the session ready rather than ended
        expect(session.getTelemetry()).toMatchObject({
            state: 'ready',
            videoEnded: true
        });

        // A resync restarts video, so the previous track end no longer applies
        expect(session.resyncVideo(secondsToMicroseconds(1))).toBe(true);
        expect(session.getTelemetry().videoEnded).toBe(false);
        emitVideoEnded(0);
        expect(session.getTelemetry().videoEnded).toBe(false);

        emitVideoEnded(1);
        expect(session.getTelemetry().videoEnded).toBe(true);
    });

    it('declines video control without a live worker or after decode ends', async () => {
        const unstartedSession = new CustomDecodeSession(
            () => undefined,
            () => new MockWorker() as unknown as Worker
        );
        expect(unstartedSession.resyncVideo(secondsToMicroseconds(1))).toBe(false);
        expect(unstartedSession.suspendVideo()).toBe(false);

        const endedWorker = new MockWorker();
        const endedSession = new CustomDecodeSession(
            () => undefined,
            () => endedWorker as unknown as Worker
        );
        startSession(endedSession, 66);
        emitRawReady(endedWorker, 66);
        endedWorker.emitMessage({ generation: 66, type: 'ended' });
        const endedWorkerMessageCount = endedWorker.postedMessages.length;
        expect(endedSession.getTelemetry().state).toBe('ended');
        expect(endedSession.resyncVideo(secondsToMicroseconds(1))).toBe(false);
        expect(endedSession.suspendVideo()).toBe(false);
        expect(endedWorker.postedMessages).toHaveLength(endedWorkerMessageCount);
        expect(endedSession.getTelemetry()).toMatchObject({
            videoEpoch: 0,
            videoResyncCount: 0,
            videoSuspensionCount: 0
        });

        const stoppedWorker = new MockWorker();
        const stoppedSession = new CustomDecodeSession(
            () => undefined,
            () => stoppedWorker as unknown as Worker
        );
        startSession(stoppedSession, 67);
        const stopPromise = stoppedSession.stop();
        const stoppedWorkerMessageCount = stoppedWorker.postedMessages.length;
        expect(stoppedSession.resyncVideo(secondsToMicroseconds(1))).toBe(false);
        expect(stoppedSession.suspendVideo()).toBe(false);
        expect(stoppedWorker.postedMessages).toHaveLength(stoppedWorkerMessageCount);
        stoppedWorker.emitMessage({ generation: 67, type: 'stopped' });
        await stopPromise;
    });

    it('starts each replacement generation at the initial video epoch', () => {
        const workers = [ new MockWorker(), new MockWorker() ];
        let workerIndex = 0;
        const session = new CustomDecodeSession(
            () => undefined,
            () => workers[workerIndex++] as unknown as Worker
        );
        startSession(session, 68);
        emitRawReady(workers[0], 68);
        expect(session.resyncVideo(secondsToMicroseconds(5))).toBe(true);
        expect(session.suspendVideo()).toBe(true);

        startSession(session, 69);
        workers[0].emitMessage({ generation: 68, type: 'stopped' });
        emitRawReady(workers[1], 69);
        const initialFrame = emitFrame(workers[1], 69, 1_100_000);

        expect(initialFrame.close).not.toHaveBeenCalled();
        expect(session.getTelemetry()).toMatchObject({
            queuedFrameCount: 1,
            staleFrameCount: 0,
            videoEpoch: 0,
            videoResyncCount: 0,
            videoSuspensionCount: 0
        });

        const replacementMessageCount = workers[1].postedMessages.length;
        expect(session.resyncVideo(secondsToMicroseconds(6))).toBe(true);
        expect(workers[1].postedMessages.slice(replacementMessageCount)).toEqual([
            {
                generation: 69,
                targetTimeMicroseconds: 6_000_000,
                type: 'resync-video',
                videoEpoch: 1
            },
            {
                frameCredits: 1,
                generation: 69,
                type: 'pull'
            }
        ]);
    });

    it('fails decode when a video control request cannot be posted', () => {
        const worker = new MockWorker();
        const events: CustomDecodeSessionEvent[] = [];
        const session = new CustomDecodeSession(
            event => events.push(event),
            () => worker as unknown as Worker
        );
        startSession(session, 70);
        emitRawReady(worker, 70);
        const queuedFrame = emitFrame(worker, 70, 1_100_000);
        const postMessageSpy = vi.spyOn(worker, 'postMessage').mockImplementation(() => {
            throw new Error('Worker closed');
        });

        expect(session.resyncVideo(secondsToMicroseconds(5))).toBe(false);

        expect(queuedFrame.close).toHaveBeenCalledOnce();
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(events.at(-1)).toEqual({
            failureKind: 'decode-failed',
            generation: 70,
            message: 'Unable to resynchronize custom video decode',
            type: 'error'
        });
        expect(session.getTelemetry()).toMatchObject({
            queuedFrameCount: 0,
            staleFrameCount: 0,
            state: 'error',
            videoResyncCount: 0
        });

        const failedPostCount = postMessageSpy.mock.calls.length;
        expect(session.suspendVideo()).toBe(false);
        expect(postMessageSpy).toHaveBeenCalledTimes(failedPostCount);
    });

    it('resyncs decoded audio to a new layout in a new epoch while video continues', async () => {
        const { audioBridge, events, session, worker } = startReadyDecodedAudioSession(80);
        const resyncedAudioBridge = createSubmittingAudioBridge(4);
        const createAudioBridge = vi.fn(async (): Promise<CustomDecodeAudioBridge> => resyncedAudioBridge);
        const audioDownmixSettings: AudioDownmixSettings = {
            centerLevel: 0.75,
            outputGain: 1.5,
            surroundLevel: 0.5,
            version: 1
        };
        const resyncedAudioConfiguration = {
            channelCount: 6,
            codec: 'opus',
            sampleRate: DECODED_AUDIO_SAMPLE_RATE,
            sourceChannelCount: 8,
            sourceSampleRate: DECODED_AUDIO_SAMPLE_RATE
        };
        const postedMessageCount = worker.postedMessages.length;
        const eventCount = events.length;

        const resyncPromise = session.resyncAudio({
            audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
            audioDownmixSettings,
            createAudioBridge,
            decodedAudioOutputChannelCount: 6,
            targetTimeMicroseconds: secondsToMicroseconds(5)
        });

        // The previous output stops before the new layout is built
        expect(audioBridge.stop).toHaveBeenCalledOnce();
        expect(audioBridge.stop).toHaveBeenCalledWith(80);
        expect(createAudioBridge).toHaveBeenCalledOnce();
        expect(createAudioBridge).toHaveBeenCalledWith(resyncedAudioConfiguration);
        expect(vi.mocked(audioBridge.stop).mock.invocationCallOrder[0]).toBeLessThan(createAudioBridge.mock.invocationCallOrder[0]);
        expect(session.getTelemetry()).toMatchObject({
            audioChannelCount: 2,
            audioEpoch: 1,
            audioResyncCount: 0,
            audioResyncPending: true,
            state: 'ready'
        });

        await expect(resyncPromise).resolves.toBe(1);

        expect(resyncedAudioBridge.start).toHaveBeenCalledOnce();
        expect(vi.mocked(resyncedAudioBridge.start).mock.calls[0][0]).toEqual({
            audioConfiguration: resyncedAudioConfiguration,
            callbacks: {
                onCreditsReleased: expect.any(Function),
                onFailure: expect.any(Function)
            },
            decodeGeneration: 80,
            startTimeMicroseconds: 5_000_000
        });
        // The request replaces the whole credit window, so no separate pull follows it
        const postedResyncMessages = worker.postedMessages.slice(postedMessageCount);
        expect(postedResyncMessages).toEqual([ {
            audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
            audioDownmixSettings: {
                centerLevel: 0.75,
                outputGain: 1.5,
                surroundLevel: 0.5,
                version: 1
            },
            audioEpoch: 1,
            audioSampleCredits: 4,
            decodedAudioOutputChannelCount: 6,
            generation: 80,
            targetTimeMicroseconds: 5_000_000,
            type: 'resync-audio'
        } ]);
        expect(isDecodeWorkerRequest(postedResyncMessages[0])).toBe(true);
        expect((postedResyncMessages[0] as DecodeWorkerResyncAudioRequest).audioDownmixSettings).not.toBe(audioDownmixSettings);
        expect(session.getTelemetry()).toMatchObject({
            audioChannelCount: 6,
            audioEpoch: 1,
            audioResyncCount: 1,
            audioResyncPending: true,
            failureKind: null,
            state: 'ready'
        });
        expect(events.slice(eventCount)).toEqual([]);

        // Video keeps its epoch and queue across the audio restart
        emitFrame(worker, 80, 1_100_000);
        expect(session.getTelemetry()).toMatchObject({
            queuedFrameCount: 2,
            staleFrameCount: 0,
            videoEpoch: 0,
            videoResyncCount: 0
        });
    });

    it('reports a resynced epoch once its own PCM reaches the startup minimum', async () => {
        const { audioBridge, events, session, worker } = startReadyDecodedAudioSession(81);
        const resyncedAudioBridge = createSubmittingAudioBridge(4);
        await expect(session.resyncAudio({
            createAudioBridge: async (): Promise<CustomDecodeAudioBridge> => resyncedAudioBridge,
            decodedAudioOutputChannelCount: 8,
            targetTimeMicroseconds: secondsToMicroseconds(5)
        })).resolves.toBe(1);
        const eventCount = events.length;

        // 100 ms at 48 kHz is 4800 frames; the 5760 startup frames of epoch zero do not count
        emitAudioSample(worker, 81, 8, 5_000_000, 1, 2_400);
        emitAudioSample(worker, 81, 8, 5_050_000, 1, 2_399);
        expect(resyncedAudioBridge.enqueue).toHaveBeenCalledTimes(2);
        expect(events.slice(eventCount)).toEqual([]);
        expect(session.getTelemetry().audioResyncPending).toBe(true);

        emitAudioSample(worker, 81, 8, 5_099_979, 1, 1);
        expect(events.slice(eventCount)).toEqual([ {
            audioEpoch: 1,
            generation: 81,
            type: 'audio-resynced'
        } ]);
        expect(session.getTelemetry()).toMatchObject({
            audioResyncPending: false,
            state: 'ready',
            submittedAudioSampleCount: 6
        });

        // Later samples neither repeat the event nor re-enter startup readiness
        emitAudioSample(worker, 81, 8, 5_100_000, 1);
        expect(events.slice(eventCount)).toHaveLength(1);
        expect(events.filter((event: CustomDecodeSessionEvent): boolean => (
            event.type === 'ready'
        ))).toHaveLength(1);
        expect(resyncedAudioBridge.enqueue).toHaveBeenCalledTimes(4);
        expect(resyncedAudioBridge.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ audioEpoch: 1, channelCount: 8 }), 81);
        expect(audioBridge.enqueue).toHaveBeenCalledTimes(3);
    });

    it('drops PCM from replaced audio epochs without reaching an output or failing', async () => {
        const { audioBridge, events, session, worker } = startReadyDecodedAudioSession(82);
        const resyncedAudioBridge = createSubmittingAudioBridge(4);
        const deferredAudioBridge = createDeferred<CustomDecodeAudioBridge>();
        const resyncPromise = session.resyncAudio({
            createAudioBridge: (): Promise<CustomDecodeAudioBridge> => deferredAudioBridge.promise,
            decodedAudioOutputChannelCount: 6,
            targetTimeMicroseconds: secondsToMicroseconds(5)
        });
        const eventCount = events.length;

        // PCM of the replaced attempt can still arrive while the new output is built
        emitAudioSample(worker, 82, 2, 1_120_000);
        expect(session.getTelemetry()).toMatchObject({
            failureKind: null,
            staleAudioSampleCount: 1,
            state: 'ready'
        });

        deferredAudioBridge.resolve(resyncedAudioBridge);
        await expect(resyncPromise).resolves.toBe(1);

        // An omitted epoch, an explicit initial epoch, and an unissued epoch are all stale
        emitAudioSample(worker, 82, 2, 1_160_000);
        emitAudioSample(worker, 82, 2, 1_200_000, 0);
        emitAudioSample(worker, 82, 6, 5_000_000, 2);

        expect(audioBridge.enqueue).toHaveBeenCalledTimes(3);
        expect(resyncedAudioBridge.enqueue).not.toHaveBeenCalled();
        expect(session.getTelemetry()).toMatchObject({
            audioEpoch: 1,
            audioResyncPending: true,
            failureKind: null,
            receivedAudioSampleCount: 3,
            staleAudioSampleCount: 4,
            state: 'ready',
            submittedAudioSampleCount: 3
        });
        expect(events.slice(eventCount)).toEqual([]);
        expect(countPostedMessages(worker, 'stop')).toBe(0);
    });

    it('tags audio pulls with the current epoch and ignores credits from replaced bridges', async () => {
        const { audioBridge, session, worker } = startReadyDecodedAudioSession(83);
        const initialBridgeCallbacks = vi.mocked(audioBridge.start).mock.calls[0][0].callbacks;
        // Pulls of the initial attempt omit the epoch
        initialBridgeCallbacks.onCreditsReleased(1);
        expect(worker.postedMessages.at(-1)).toStrictEqual({
            audioSampleCredits: 1,
            generation: 83,
            type: 'pull-audio'
        });

        const firstResyncedAudioBridge = createSubmittingAudioBridge(4);
        await expect(session.resyncAudio({
            createAudioBridge: async (): Promise<CustomDecodeAudioBridge> => firstResyncedAudioBridge,
            decodedAudioOutputChannelCount: 6,
            targetTimeMicroseconds: secondsToMicroseconds(5)
        })).resolves.toBe(1);
        const firstResyncedBridgeCallbacks = vi.mocked(firstResyncedAudioBridge.start).mock.calls[0][0].callbacks;
        const firstResyncMessageCount = worker.postedMessages.length;

        firstResyncedBridgeCallbacks.onCreditsReleased(2);
        // A late release from the replaced bridge belongs to a window the resync already reset
        initialBridgeCallbacks.onCreditsReleased(2);

        expect(worker.postedMessages.slice(firstResyncMessageCount)).toStrictEqual([ {
            audioEpoch: 1,
            audioSampleCredits: 2,
            generation: 83,
            type: 'pull-audio'
        } ]);
        expect(isDecodeWorkerRequest(worker.postedMessages.at(-1))).toBe(true);

        const secondResyncedAudioBridge = createSubmittingAudioBridge(4);
        await expect(session.resyncAudio({
            createAudioBridge: async (): Promise<CustomDecodeAudioBridge> => secondResyncedAudioBridge,
            decodedAudioOutputChannelCount: 8,
            targetTimeMicroseconds: secondsToMicroseconds(6)
        })).resolves.toBe(2);
        // A completed resync's bridge is the active output that the next resync stops
        expect(firstResyncedAudioBridge.stop).toHaveBeenCalledWith(83);
        const secondResyncMessageCount = worker.postedMessages.length;

        firstResyncedBridgeCallbacks.onCreditsReleased(1);
        initialBridgeCallbacks.onCreditsReleased(1);
        vi.mocked(secondResyncedAudioBridge.start).mock.calls[0][0].callbacks.onCreditsReleased(3);

        expect(worker.postedMessages.slice(secondResyncMessageCount)).toStrictEqual([ {
            audioEpoch: 2,
            audioSampleCredits: 3,
            generation: 83,
            type: 'pull-audio'
        } ]);
    });

    it.each([
        { resolutionOrder: 'issue order', secondResolvesFirst: false },
        { resolutionOrder: 'reverse order', secondResolvesFirst: true }
    ])(
        'supersedes an audio resync still building its bridge when bridges resolve in $resolutionOrder',
        async ({ secondResolvesFirst }: { secondResolvesFirst: boolean }): Promise<void> => {
            const { audioBridge, events, session, worker } = startReadyDecodedAudioSession(84);
            const firstDeferredAudioBridge = createDeferred<CustomDecodeAudioBridge>();
            const secondDeferredAudioBridge = createDeferred<CustomDecodeAudioBridge>();
            const firstAudioBridge = createSubmittingAudioBridge(4);
            const secondAudioBridge = createSubmittingAudioBridge(5);
            const secondCreateAudioBridge = vi.fn((): Promise<CustomDecodeAudioBridge> => secondDeferredAudioBridge.promise);
            const postedMessageCount = worker.postedMessages.length;
            const eventCount = events.length;

            const firstResyncPromise = session.resyncAudio({
                createAudioBridge: (): Promise<CustomDecodeAudioBridge> => firstDeferredAudioBridge.promise,
                decodedAudioOutputChannelCount: 6,
                targetTimeMicroseconds: secondsToMicroseconds(5)
            });
            // No bridge is active while the first output is built, yet the newer layout proceeds
            const secondResyncPromise = session.resyncAudio({
                createAudioBridge: secondCreateAudioBridge,
                decodedAudioOutputChannelCount: 8,
                targetTimeMicroseconds: secondsToMicroseconds(6)
            });

            expect(audioBridge.stop).toHaveBeenCalledOnce();
            expect(secondCreateAudioBridge).toHaveBeenCalledWith({
                channelCount: 8,
                codec: 'opus',
                sampleRate: DECODED_AUDIO_SAMPLE_RATE,
                sourceChannelCount: 8,
                sourceSampleRate: DECODED_AUDIO_SAMPLE_RATE
            });
            expect(session.getTelemetry()).toMatchObject({
                audioEpoch: 2,
                audioResyncCount: 0,
                audioResyncPending: true
            });

            if (secondResolvesFirst) {
                secondDeferredAudioBridge.resolve(secondAudioBridge);
                await expect(secondResyncPromise).resolves.toBe(2);
                firstDeferredAudioBridge.resolve(firstAudioBridge);
                await expect(firstResyncPromise).resolves.toBeNull();
            } else {
                firstDeferredAudioBridge.resolve(firstAudioBridge);
                await expect(firstResyncPromise).resolves.toBeNull();
                // The superseded resync posts nothing to the worker
                expect(worker.postedMessages).toHaveLength(postedMessageCount);
                secondDeferredAudioBridge.resolve(secondAudioBridge);
                await expect(secondResyncPromise).resolves.toBe(2);
            }

            expect(firstAudioBridge.start).not.toHaveBeenCalled();
            expect(secondAudioBridge.start).toHaveBeenCalledOnce();
            expect(secondAudioBridge.stop).not.toHaveBeenCalled();
            expect(vi.mocked(secondAudioBridge.start).mock.calls[0][0]).toMatchObject({
                audioConfiguration: { channelCount: 8 },
                decodeGeneration: 84,
                startTimeMicroseconds: 6_000_000
            });
            // Only the surviving epoch reaches the worker, without downmix fields it was not given
            expect(worker.postedMessages.slice(postedMessageCount)).toStrictEqual([ {
                audioEpoch: 2,
                audioSampleCredits: 5,
                decodedAudioOutputChannelCount: 8,
                generation: 84,
                targetTimeMicroseconds: 6_000_000,
                type: 'resync-audio'
            } ]);
            expect(session.getTelemetry()).toMatchObject({
                audioChannelCount: 8,
                audioEpoch: 2,
                audioResyncCount: 1,
                failureKind: null,
                state: 'ready'
            });

            emitAudioSample(worker, 84, 6, 5_000_000, 1);
            emitAudioSample(worker, 84, 8, 6_000_000, 2);
            expect(firstAudioBridge.enqueue).not.toHaveBeenCalled();
            expect(secondAudioBridge.enqueue).toHaveBeenCalledOnce();
            expect(session.getTelemetry().staleAudioSampleCount).toBe(1);
            expect(events.slice(eventCount)).toEqual([]);
        }
    );

    it('ignores a bridge creation failure from a superseded audio resync', async () => {
        const { events, session, worker } = startReadyDecodedAudioSession(85);
        const secondAudioBridge = createSubmittingAudioBridge(4);
        const eventCount = events.length;

        const firstResyncPromise = session.resyncAudio({
            createAudioBridge: (): Promise<CustomDecodeAudioBridge> => Promise.reject(new Error('The superseded output failed')),
            decodedAudioOutputChannelCount: 6,
            targetTimeMicroseconds: secondsToMicroseconds(5)
        });
        const secondResyncPromise = session.resyncAudio({
            createAudioBridge: async (): Promise<CustomDecodeAudioBridge> => secondAudioBridge,
            decodedAudioOutputChannelCount: 2,
            targetTimeMicroseconds: secondsToMicroseconds(5)
        });

        await expect(firstResyncPromise).resolves.toBeNull();
        await expect(secondResyncPromise).resolves.toBe(2);
        expect(events.slice(eventCount)).toEqual([]);
        expect(secondAudioBridge.start).toHaveBeenCalledOnce();
        expect(countPostedMessages(worker, 'resync-audio')).toBe(1);
        expect(session.getTelemetry()).toMatchObject({
            audioChannelCount: 2,
            audioEpoch: 2,
            audioResyncCount: 1,
            failureKind: null,
            state: 'ready'
        });
    });

    it('fails audio output when the resynchronized output cannot be built', async () => {
        const { audioBridge, events, session, worker } = startReadyDecodedAudioSession(86);
        const postedMessageCount = worker.postedMessages.length;

        await expect(session.resyncAudio({
            createAudioBridge: (): Promise<CustomDecodeAudioBridge> => Promise.reject(new Error('AudioWorklet creation failed')),
            decodedAudioOutputChannelCount: 6,
            targetTimeMicroseconds: secondsToMicroseconds(5)
        })).resolves.toBeNull();

        expect(events.at(-1)).toEqual({
            failureKind: 'audio-output-failed',
            generation: 86,
            message: 'Unable to create the resynchronized audio output',
            type: 'error'
        });
        expect(session.getTelemetry()).toMatchObject({
            audioResyncCount: 0,
            failureKind: 'audio-output-failed',
            state: 'error'
        });
        // The worker retires without ever receiving the resync request
        expect(worker.postedMessages.slice(postedMessageCount)).toEqual([ {
            generation: 86,
            type: 'stop'
        } ]);
        expect(audioBridge.stop).toHaveBeenCalledOnce();
        worker.emitMessage({ generation: 86, type: 'stopped' });
        expect(worker.terminate).toHaveBeenCalledOnce();
    });

    it('fails audio output when the resynchronized bridge cannot start', async () => {
        const { events, session, worker } = startReadyDecodedAudioSession(87);
        const resyncedAudioBridge = createSubmittingAudioBridge(4);
        vi.mocked(resyncedAudioBridge.start).mockImplementation((): void => {
            throw new RangeError('Decoded audio channel count does not match the AudioWorklet output');
        });

        await expect(session.resyncAudio({
            createAudioBridge: async (): Promise<CustomDecodeAudioBridge> => resyncedAudioBridge,
            decodedAudioOutputChannelCount: 6,
            targetTimeMicroseconds: secondsToMicroseconds(5)
        })).resolves.toBeNull();

        expect(events.at(-1)).toEqual({
            failureKind: 'audio-output-failed',
            generation: 87,
            message: 'Unable to resynchronize decoded audio',
            type: 'error'
        });
        // The failed output is released with the session before any request is posted
        expect(resyncedAudioBridge.stop).toHaveBeenCalledWith(87);
        expect(countPostedMessages(worker, 'resync-audio')).toBe(0);
        expect(session.getTelemetry()).toMatchObject({
            audioResyncCount: 0,
            state: 'error'
        });
        worker.emitMessage({ generation: 87, type: 'stopped' });
    });

    it('fails audio output when a resynced epoch delivers the replaced layout', async () => {
        const { events, session, worker } = startReadyDecodedAudioSession(88);
        const resyncedAudioBridge = createSubmittingAudioBridge(4);
        await expect(session.resyncAudio({
            createAudioBridge: async (): Promise<CustomDecodeAudioBridge> => resyncedAudioBridge,
            decodedAudioOutputChannelCount: 6,
            targetTimeMicroseconds: secondsToMicroseconds(5)
        })).resolves.toBe(1);

        emitAudioSample(worker, 88, 2, 5_000_000, 1);

        expect(resyncedAudioBridge.enqueue).not.toHaveBeenCalled();
        expect(events.at(-1)).toEqual({
            failureKind: 'audio-output-failed',
            generation: 88,
            message: 'Decoded audio did not match the configured output',
            type: 'error'
        });
        expect(resyncedAudioBridge.stop).toHaveBeenCalledWith(88);
        worker.emitMessage({ generation: 88, type: 'stopped' });
    });

    it('gates live downmix updates on the resynchronized output layout', async () => {
        const { session, worker } = startReadyDecodedAudioSession(89);
        const settings: AudioDownmixSettings = {
            centerLevel: 1,
            outputGain: 2,
            surroundLevel: 1,
            version: 1
        };
        expect(session.updateAudioDownmixSettings(settings)).toBe(true);

        await expect(session.resyncAudio({
            createAudioBridge: async (): Promise<CustomDecodeAudioBridge> => createSubmittingAudioBridge(4),
            decodedAudioOutputChannelCount: 6,
            targetTimeMicroseconds: secondsToMicroseconds(5)
        })).resolves.toBe(1);
        // A 5.1 output carries no stereo downmix to adjust
        expect(session.updateAudioDownmixSettings(settings)).toBe(false);

        await expect(session.resyncAudio({
            createAudioBridge: async (): Promise<CustomDecodeAudioBridge> => createSubmittingAudioBridge(4),
            decodedAudioOutputChannelCount: 2,
            targetTimeMicroseconds: secondsToMicroseconds(6)
        })).resolves.toBe(2);
        expect(session.updateAudioDownmixSettings(settings)).toBe(true);
        expect(countPostedMessages(worker, 'update-audio-downmix-settings')).toBe(2);
    });

    it('reports the audio track end only for the current audio epoch', async () => {
        const { session, worker } = startReadyDecodedAudioSession(90);
        const emitAudioEnded = (audioEpoch: number): void => {
            worker.emitMessage({ audioEpoch, generation: 90, type: 'audio-ended' });
        };
        expect(session.getTelemetry().audioEnded).toBe(false);

        emitAudioEnded(0);
        // Video plays on, so the session stays ready rather than ended
        expect(session.getTelemetry()).toMatchObject({
            audioEnded: true,
            state: 'ready'
        });

        // A resync restarts audio, so the previous track end no longer applies
        await expect(session.resyncAudio({
            createAudioBridge: async (): Promise<CustomDecodeAudioBridge> => createSubmittingAudioBridge(4),
            decodedAudioOutputChannelCount: 2,
            targetTimeMicroseconds: secondsToMicroseconds(5)
        })).resolves.toBe(1);
        expect(session.getTelemetry().audioEnded).toBe(false);
        emitAudioEnded(0);
        expect(session.getTelemetry().audioEnded).toBe(false);

        emitAudioEnded(1);
        expect(session.getTelemetry().audioEnded).toBe(true);
    });

    it('completes startup when the audio track ends before its first PCM', () => {
        const worker = new MockWorker();
        const events: CustomDecodeSessionEvent[] = [];
        const session = new CustomDecodeSession(
            (event: CustomDecodeSessionEvent): void => {
                events.push(event);
            },
            (): Worker => worker as unknown as Worker,
            createSubmittingAudioBridge(3)
        );
        startSession(session, 99, 0);
        worker.emitMessage({
            audio: { channelCount: 2, codec: 'opus', sampleRate: DECODED_AUDIO_SAMPLE_RATE },
            codec: 'avc1.640028',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 99,
            type: 'ready'
        });
        emitFrame(worker, 99, 1_000_000);
        expect(session.getTelemetry().state).toBe('configured');

        // A start past the end of the track has no PCM to wait for
        worker.emitMessage({ audioEpoch: 0, generation: 99, type: 'audio-ended' });

        expect(session.getTelemetry()).toMatchObject({ audioEnded: true, state: 'ready' });
        expect(events.slice(-2)).toEqual([
            expect.objectContaining({ generation: 99, type: 'ready' }),
            { generation: 99, type: 'audio-ended' }
        ]);
    });

    it('completes a pending audio resync whose epoch ends before its first PCM', async () => {
        const { events, session, worker } = startReadyDecodedAudioSession(100);
        await expect(session.resyncAudio({
            createAudioBridge: async (): Promise<CustomDecodeAudioBridge> => createSubmittingAudioBridge(4),
            decodedAudioOutputChannelCount: 6,
            targetTimeMicroseconds: secondsToMicroseconds(9)
        })).resolves.toBe(1);
        expect(session.getTelemetry().audioResyncPending).toBe(true);

        worker.emitMessage({ audioEpoch: 1, generation: 100, type: 'audio-ended' });

        expect(session.getTelemetry()).toMatchObject({
            audioEnded: true,
            audioResyncPending: false,
            state: 'ready'
        });
        expect(events.slice(-2)).toEqual([
            { audioEpoch: 1, generation: 100, type: 'audio-resynced' },
            { generation: 100, type: 'audio-ended' }
        ]);
    });

    it('records the decoded audio source format of the current epoch over the declared one', async () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            (): Worker => worker as unknown as Worker,
            createSubmittingAudioBridge(3)
        );
        startSession(session, 104, 0);
        worker.emitMessage({
            audio: {
                channelCount: 2,
                codec: 'opus',
                sampleRate: DECODED_AUDIO_SAMPLE_RATE,
                sourceChannelCount: 6,
                sourceSampleRate: DECODED_AUDIO_SAMPLE_RATE
            },
            codec: 'avc1.640028',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 104,
            type: 'ready'
        });
        // The decoder reports the layout it produces before its first PCM
        worker.emitMessage({
            audioEpoch: 0,
            channelCount: 8,
            generation: 104,
            sampleRate: DECODED_AUDIO_SAMPLE_RATE,
            type: 'audio-source-format'
        });
        emitFrame(worker, 104, 1_000_000);
        for (let sampleIndex = 0; sampleIndex < 3; sampleIndex += 1) {
            emitAudioSample(worker, 104, 2, 1_000_000 + sampleIndex * DECODED_AUDIO_SAMPLE_DURATION_MICROSECONDS);
        }
        expect(session.getTelemetry()).toMatchObject({
            audioSourceChannelCount: 8,
            audioSourceSampleRate: DECODED_AUDIO_SAMPLE_RATE,
            decodedAudioSourceChannelCount: 8,
            state: 'ready'
        });

        await expect(session.resyncAudio({
            createAudioBridge: async (): Promise<CustomDecodeAudioBridge> => createSubmittingAudioBridge(4),
            decodedAudioOutputChannelCount: 6,
            targetTimeMicroseconds: secondsToMicroseconds(5)
        })).resolves.toBe(1);
        // A replaced epoch's report no longer applies
        worker.emitMessage({
            audioEpoch: 0,
            channelCount: 6,
            generation: 104,
            sampleRate: 44_100,
            type: 'audio-source-format'
        });
        expect(session.getTelemetry().decodedAudioSourceChannelCount).toBe(8);
        worker.emitMessage({
            audioEpoch: 1,
            channelCount: 6,
            generation: 104,
            sampleRate: 44_100,
            type: 'audio-source-format'
        });
        expect(session.getTelemetry()).toMatchObject({
            audioSourceChannelCount: 6,
            audioSourceSampleRate: 44_100,
            decodedAudioSourceChannelCount: 6
        });
    });

    it('ends the native stream when audio ends before video and ends the session after decode', async () => {
        const harness = startNativeAudioSession(101);
        await vi.waitFor((): void => {
            expect(countPostedMessages(harness.worker, 'pull-audio')).toBe(1);
        });
        emitFrame(harness.worker, 101, 1_000_000);
        harness.worker.emitMessage({
            data: new Uint8Array([ 1, 2 ]).buffer,
            generation: 101,
            type: 'native-audio-init'
        });
        harness.worker.emitMessage({
            data: new Uint8Array([ 3, 4 ]).buffer,
            endTimeMicroseconds: 1_500_000,
            generation: 101,
            startTimeMicroseconds: 1_000_000,
            type: 'native-audio-media'
        });
        await vi.waitFor((): void => {
            expect(harness.session.getTelemetry().state).toBe('ready');
        });
        harness.setAuthoritativeTimeMicroseconds(secondsToMicroseconds(1.2));
        expect(harness.session.getNativeAudioTimeMicroseconds()).toBe(secondsToMicroseconds(1.2));

        harness.worker.emitMessage({ audioEpoch: 0, generation: 101, type: 'audio-ended' });

        // Without end of stream the element would stall at its last fragment
        await vi.waitFor((): void => {
            expect(harness.endOfStream).toHaveBeenCalledWith(101);
        });
        expect(harness.events.at(-1)).toEqual({ generation: 101, type: 'audio-ended' });
        harness.emitBackendEvent({ generation: 101, type: 'ended' });
        expect(harness.session.getTelemetry()).toMatchObject({
            audioEnded: true,
            nativeAudioEnded: true,
            state: 'ready'
        });
        // The played-out element no longer clocks the video that plays on
        expect(harness.session.getNativeAudioTimeMicroseconds()).toBeNull();
        expect(harness.events.filter(event => event.type === 'ended')).toHaveLength(0);

        harness.worker.emitMessage({ generation: 101, type: 'ended' });

        await vi.waitFor((): void => {
            expect(harness.session.getTelemetry().state).toBe('ended');
        });
        expect(harness.endOfStream).toHaveBeenCalledOnce();
        expect(harness.events.at(-1)).toEqual({ generation: 101, type: 'ended' });
    });

    it('defers the native end of stream until the native output opens', async () => {
        const backendOpened = createDeferred<undefined>();
        const harness = startNativeAudioSession(102, backendOpened.promise);
        emitFrame(harness.worker, 102, 1_000_000);

        // The worker can finish a track with nothing left before the output opens
        harness.worker.emitMessage({ audioEpoch: 0, generation: 102, type: 'audio-ended' });
        await Promise.resolve();
        expect(harness.endOfStream).not.toHaveBeenCalled();
        expect(harness.session.getTelemetry().state).toBe('configured');

        backendOpened.resolve(undefined);
        await vi.waitFor((): void => {
            expect(harness.endOfStream).toHaveBeenCalledWith(102);
        });
        // The ended track stands in for the media the start waits for
        expect(harness.session.getTelemetry().state).toBe('ready');
        expect(harness.events.filter(event => event.type === 'ready')).toHaveLength(1);
    });

    it('declines an audio resync without a ready decoded PCM output', async () => {
        const unstartedWorker = new MockWorker();
        const unstartedSession = new CustomDecodeSession(
            () => undefined,
            () => unstartedWorker as unknown as Worker,
            createSubmittingAudioBridge(3)
        );
        await expectAudioResyncDeclined(unstartedSession, unstartedWorker);
        expect(unstartedSession.getTelemetry().state).toBe('idle');

        // A configured session with an active bridge still waits for its PCM prebuffer
        const configuredWorker = new MockWorker();
        const configuredAudioBridge = createSubmittingAudioBridge(3);
        const configuredSession = new CustomDecodeSession(
            () => undefined,
            () => configuredWorker as unknown as Worker,
            configuredAudioBridge
        );
        startSession(configuredSession, 90, 0);
        configuredWorker.emitMessage({
            audio: {
                channelCount: 2,
                codec: 'opus',
                sampleRate: DECODED_AUDIO_SAMPLE_RATE
            },
            codec: 'avc1.640028',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 90,
            type: 'ready'
        });
        emitFrame(configuredWorker, 90, 1_000_000);
        expect(configuredSession.getTelemetry().state).toBe('configured');
        await expectAudioResyncDeclined(configuredSession, configuredWorker);
        expect(configuredAudioBridge.stop).not.toHaveBeenCalled();

        // A ready video-only session has no decoded audio configuration
        const videoOnlyWorker = new MockWorker();
        const videoOnlySession = new CustomDecodeSession(
            () => undefined,
            () => videoOnlyWorker as unknown as Worker
        );
        startSession(videoOnlySession, 91);
        emitRawReady(videoOnlyWorker, 91);
        emitFrame(videoOnlyWorker, 91, 1_000_000);
        expect(videoOnlySession.getTelemetry().state).toBe('ready');
        await expectAudioResyncDeclined(videoOnlySession, videoOnlyWorker);

        const endedHarness = startReadyDecodedAudioSession(92);
        endedHarness.worker.emitMessage({ generation: 92, type: 'ended' });
        expect(endedHarness.session.getTelemetry().state).toBe('ended');
        await expectAudioResyncDeclined(endedHarness.session, endedHarness.worker);
        expect(endedHarness.audioBridge.stop).not.toHaveBeenCalled();

        const failedHarness = startReadyDecodedAudioSession(93);
        failedHarness.worker.emitMessage({
            failureKind: 'decode-failed',
            generation: 93,
            message: 'Decoder failed',
            type: 'error'
        });
        await expectAudioResyncDeclined(failedHarness.session, failedHarness.worker);
        // Only the decode failure stopped the output
        expect(failedHarness.audioBridge.stop).toHaveBeenCalledOnce();
        failedHarness.worker.emitMessage({ generation: 93, type: 'stopped' });

        const stoppedHarness = startReadyDecodedAudioSession(94);
        const stopPromise = stoppedHarness.session.stop();
        await expectAudioResyncDeclined(stoppedHarness.session, stoppedHarness.worker);
        stoppedHarness.worker.emitMessage({ generation: 94, type: 'stopped' });
        await stopPromise;
    });

    it('declines an audio resync for ready native media audio', async () => {
        const worker = new MockWorker();
        const nativeAudioBridge = {
            enqueueMedia: vi.fn(async (): Promise<boolean> => true),
            initialAudioSegmentCredits: 2,
            start: vi.fn(async (): Promise<boolean> => true),
            stop: vi.fn(async (): Promise<boolean> => true)
        } as unknown as CustomDecodeNativeAudioBridge;
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker,
            null,
            null,
            () => nativeAudioBridge
        );
        session.start({
            audioOutputMode: 'native-media',
            audioTrackIndex: 0,
            dolbyVisionProfile: null,
            durationMicroseconds: secondsToMicroseconds(10),
            generation: 95,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: secondsToMicroseconds(1),
            url: 'http://localhost/video.mp4?ApiKey=secret',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        });
        worker.emitMessage({
            audio: {
                channelCount: 6,
                codec: 'ec-3',
                mimeType: 'audio/mp4; codecs="ec-3"',
                outputMode: 'native-media',
                sampleRate: 48_000
            },
            codec: 'hev1.2.4.L153.B0',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 95,
            type: 'ready'
        });
        await vi.waitFor((): void => {
            expect(worker.postedMessages.at(-1)).toEqual({
                audioSampleCredits: 2,
                generation: 95,
                type: 'pull-audio'
            });
        });
        emitFrame(worker, 95, 1_000_000);
        worker.emitMessage({
            data: new Uint8Array([ 3, 4 ]).buffer,
            endTimeMicroseconds: 1_500_000,
            generation: 95,
            startTimeMicroseconds: 1_000_000,
            type: 'native-audio-media'
        });
        await vi.waitFor((): void => {
            expect(session.getTelemetry().state).toBe('ready');
        });

        await expectAudioResyncDeclined(session, worker);
        expect(nativeAudioBridge.stop).not.toHaveBeenCalled();
    });

    it('abandons a resync stopped mid-build and drains an empty bridge when decode ends', async () => {
        const stoppedHarness = startReadyDecodedAudioSession(96);
        const stoppedDeferredAudioBridge = createDeferred<CustomDecodeAudioBridge>();
        const stoppedResyncedAudioBridge = createSubmittingAudioBridge(4);
        const stoppedResyncPromise = stoppedHarness.session.resyncAudio({
            createAudioBridge: (): Promise<CustomDecodeAudioBridge> => stoppedDeferredAudioBridge.promise,
            decodedAudioOutputChannelCount: 6,
            targetTimeMicroseconds: secondsToMicroseconds(5)
        });
        const stopPromise = stoppedHarness.session.stop();
        stoppedDeferredAudioBridge.resolve(stoppedResyncedAudioBridge);

        await expect(stoppedResyncPromise).resolves.toBeNull();
        expect(stoppedResyncedAudioBridge.start).not.toHaveBeenCalled();
        expect(countPostedMessages(stoppedHarness.worker, 'resync-audio')).toBe(0);
        expect(stoppedHarness.session.getTelemetry()).toMatchObject({
            audioResyncCount: 0,
            failureKind: null,
            state: 'idle'
        });
        stoppedHarness.worker.emitMessage({ generation: 96, type: 'stopped' });
        await stopPromise;

        // A finished run never sees the resync, so its bridge starts empty and lets playback drain
        const endedHarness = startReadyDecodedAudioSession(97);
        const endedDeferredAudioBridge = createDeferred<CustomDecodeAudioBridge>();
        const endedResyncedAudioBridge = createSubmittingAudioBridge(4);
        const endedResyncPromise = endedHarness.session.resyncAudio({
            createAudioBridge: (): Promise<CustomDecodeAudioBridge> => endedDeferredAudioBridge.promise,
            decodedAudioOutputChannelCount: 6,
            targetTimeMicroseconds: secondsToMicroseconds(5)
        });
        endedHarness.worker.emitMessage({ generation: 97, type: 'ended' });
        endedDeferredAudioBridge.resolve(endedResyncedAudioBridge);

        await expect(endedResyncPromise).resolves.toBe(1);
        expect(endedResyncedAudioBridge.start).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                decodeGeneration: 97,
                startTimeMicroseconds: secondsToMicroseconds(5)
            })
        );
        expect(countPostedMessages(endedHarness.worker, 'resync-audio')).toBe(0);
        expect(endedHarness.session.getTelemetry()).toMatchObject({
            audioEpoch: 1,
            audioResyncCount: 1,
            audioResyncPending: false,
            failureKind: null,
            state: 'ended'
        });
    });

    it('rejects invalid audio resync options before changing the session', async () => {
        const { audioBridge, session, worker } = startReadyDecodedAudioSession(98);
        const createAudioBridge = vi.fn(async (): Promise<CustomDecodeAudioBridge> => createSubmittingAudioBridge(4));
        const resyncOptions: CustomDecodeAudioResyncOptions = {
            createAudioBridge,
            decodedAudioOutputChannelCount: 6,
            targetTimeMicroseconds: secondsToMicroseconds(5)
        };
        const invalidChannelCounts: readonly number[] = [ 0, 1, 4, 7, 16 ];
        const postedMessageCount = worker.postedMessages.length;

        for (const invalidChannelCount of invalidChannelCounts) {
            await expect(session.resyncAudio({
                ...resyncOptions,
                decodedAudioOutputChannelCount: invalidChannelCount as CustomAudioOutputChannelCount
            })).rejects.toThrow(RangeError);
        }
        await expect(session.resyncAudio({
            ...resyncOptions,
            audioDownmixAlgorithm: 'unsupported' as unknown as CustomAudioDownmixAlgorithm
        })).rejects.toThrow(TypeError);
        await expect(session.resyncAudio({
            ...resyncOptions,
            audioDownmixSettings: {
                centerLevel: 1,
                outputGain: 11,
                surroundLevel: 1,
                version: 1
            }
        })).rejects.toThrow(RangeError);
        await expect(session.resyncAudio({
            ...resyncOptions,
            audioDownmixSettings: {
                centerLevel: 1,
                outputGain: 1,
                surroundLevel: 1,
                version: 2
            } as unknown as AudioDownmixSettings
        })).rejects.toThrow(RangeError);
        await expect(session.resyncAudio({
            ...resyncOptions,
            targetTimeMicroseconds: 0.5 as unknown as Microseconds
        })).rejects.toThrow(RangeError);

        expect(createAudioBridge).not.toHaveBeenCalled();
        expect(audioBridge.stop).not.toHaveBeenCalled();
        expect(worker.postedMessages).toHaveLength(postedMessageCount);
        expect(session.getTelemetry()).toMatchObject({
            audioEpoch: 0,
            audioResyncPending: false,
            failureKind: null,
            state: 'ready'
        });

        // Option validation precedes the readiness check
        const unstartedSession = new CustomDecodeSession(
            () => undefined,
            () => new MockWorker() as unknown as Worker,
            createSubmittingAudioBridge(3)
        );
        await expect(unstartedSession.resyncAudio({
            ...resyncOptions,
            decodedAudioOutputChannelCount: 7 as unknown as CustomAudioOutputChannelCount
        })).rejects.toThrow('Decoded audio output channel count must be 2, 6, or 8');
    });
});
