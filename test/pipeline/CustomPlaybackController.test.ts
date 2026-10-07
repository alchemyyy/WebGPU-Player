import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    microsecondsToMilliseconds,
    millisecondsToMicroseconds,
    secondsToMicroseconds,
    type Microseconds
} from 'webgpu-player/MediaTime';
import type {
    DecodedPresentationFrame,
    DecodedVideoPresentationFrame
} from 'webgpu-player/presentation/WebGPUPresenter';
import type { AudioWorkletTelemetry } from 'webgpu-player/audio/output/AudioWorkletProtocol';
import { CUSTOM_AUDIO_DOWNMIX_ALGORITHMS } from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import type { AudioDownmixSettings } from 'webgpu-player/audio/processing/CustomAudioDownmix';
import type CustomDecodeAudioBridge from 'webgpu-player/audio/output/CustomDecodeAudioBridge';
import type { CustomDecodeAudioBridgeTelemetry } from 'webgpu-player/audio/output/CustomDecodeAudioBridge';
import CustomDecodeSession, {
    CustomDecodeAudioBridgeFactory,
    CustomDecodeAudioResyncOptions,
    CustomDecodeNativeAudioBridgeFactory,
    CustomDecodeSessionEvent,
    CustomDecodeSessionStartOptions,
    CustomDecodeSessionTelemetry
} from 'webgpu-player/pipeline/CustomDecodeSession';
import type { DecodeWorkerAudioConfiguration } from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import { addMicroseconds, requireMicroseconds } from 'webgpu-player/TimeMath';
import CustomPlaybackController, {
    CUSTOM_PLAYBACK_AUDIO_OUTPUT_SWITCH_LEAD_MICROSECONDS,
    CUSTOM_PLAYBACK_AUDIO_OUTPUT_SWITCH_TIMEOUT_MICROSECONDS,
    CUSTOM_PLAYBACK_BACKGROUND_VIDEO_SUSPENSION_DELAY_MICROSECONDS,
    CUSTOM_PLAYBACK_VIDEO_CATCH_UP_TOLERANCE_MICROSECONDS
} from 'webgpu-player/pipeline/CustomPlaybackController';
import type {
    CustomAudioOutput,
    CustomAudioOutputBinding,
    CustomPlaybackAudioOutputOptions,
    CustomPlaybackControllerEvent,
    CustomPlaybackControllerOptions,
    CustomPlaybackFallbackRequest,
    CustomPlaybackPlayOptions,
    CustomPlaybackStartResult,
    CustomVideoDecodeSession
} from 'webgpu-player/pipeline/CustomPlaybackControllerTypes';

type ControllerDecodeWorkerMessageHandler = (event: MessageEvent<unknown>) => void;

class ControllerDecodeWorker {
    private readonly messageHandlers = new Set<ControllerDecodeWorkerMessageHandler>();
    public readonly postedMessages: unknown[] = [];
    public readonly terminate = vi.fn();

    public addEventListener(
        type: string,
        handler: EventListenerOrEventListenerObject
    ): void {
        if (type === 'message') {
            this.messageHandlers.add(handler as ControllerDecodeWorkerMessageHandler);
        }
    }

    public emitMessage(data: unknown): void {
        for (const handler of this.messageHandlers) {
            handler({ data } as MessageEvent<unknown>);
        }
    }

    public postMessage(message: unknown): void {
        this.postedMessages.push(message);
    }

    public removeEventListener(
        type: string,
        handler: EventListenerOrEventListenerObject
    ): void {
        if (type === 'message') {
            this.messageHandlers.delete(handler as ControllerDecodeWorkerMessageHandler);
        }
    }
}

function emitControllerDecodedFrame(
    worker: ControllerDecodeWorker,
    generation: number,
    mediaTimeMicroseconds: Microseconds
): VideoFrame & { close: ReturnType<typeof vi.fn> } {
    const frame = { close: vi.fn() } as unknown as VideoFrame & {
        close: ReturnType<typeof vi.fn>
    };
    worker.emitMessage({
        durationMicroseconds: millisecondsToMicroseconds(40),
        frame,
        generation,
        mediaTimeMicroseconds,
        outputMode: 'video-frame',
        type: 'frame'
    });
    return frame;
}

function createDecodeTelemetry(): CustomDecodeSessionTelemetry {
    return {
        activeGeneration: null,
        abandonedRawFrameCount: 0,
        audioChannelCount: null,
        audioCodec: null,
        audioEpoch: 0,
        audioResyncCount: 0,
        audioResyncPending: false,
        audioSampleRate: null,
        audioSourceChannelCount: null,
        audioSourceSampleRate: null,
        droppedFrameCount: 0,
        failureKind: null,
        firstFrameMediaTimeMicroseconds: null,
        lastAudioMediaTimeMicroseconds: null,
        lastFrameEndMediaTimeMicroseconds: null,
        lastFrameMediaTimeMicroseconds: null,
        nativeAudioClockReady: false,
        peakFrameCount: 0,
        pendingFrameCount: 0,
        queuedFrameCount: 0,
        receivedAudioFrameCount: 0,
        receivedAudioSampleCount: 0,
        receivedDolbyVisionEnhancementFrameCount: 0,
        receivedDolbyVisionFrameCount: 0,
        receivedDolbyVisionRPUCount: 0,
        receivedHDR10PlusAbsentFrameCount: 0,
        receivedHDR10PlusConflictingFrameCount: 0,
        receivedHDR10PlusMalformedFrameCount: 0,
        receivedHDR10PlusUnsupportedFrameCount: 0,
        receivedHDR10PlusValidFrameCount: 0,
        receivedFrameCount: 0,
        receivedNativeAudioSegmentCount: 0,
        recycledRawFrameCount: 0,
        staleAudioSampleCount: 0,
        staleFrameCount: 0,
        state: 'idle',
        staticHDRMetadataFirstAccessUnitIndex: null,
        staticHDRMetadataScanAccessUnitCount: 0,
        staticHDRMetadataStatus: null,
        submittedAudioFrameCount: 0,
        submittedAudioSampleCount: 0,
        submittedVideoPacketCount: 0,
        takenFrameCount: 0,
        videoEnded: false,
        videoEpoch: 0,
        videoProgressPhase: null,
        videoResyncCount: 0,
        videoSuspensionCount: 0
    };
}

class FakeVideoDecodeSession implements CustomVideoDecodeSession {
    private activeGeneration: number | null = null;
    private audioConfiguration: DecodeWorkerAudioConfiguration | null = null;
    private audioEpoch = 0;
    private audioResyncPending = false;
    private lastFrameEndMediaTimeMicroseconds: Microseconds | null = null;
    private lastFrameMediaTimeMicroseconds: Microseconds | null = null;
    private nativeAudioTimeMicroseconds: Microseconds | null = null;
    private pendingFrameCount = 0;
    private readonly queuedFrames: DecodedPresentationFrame[] = [];
    private videoEnded = false;
    public readonly starts: CustomDecodeSessionStartOptions[] = [];
    public readonly acknowledgeFrame = vi.fn((): boolean => true);
    public readonly discardFrame = vi.fn((): boolean => true);
    public readonly setNativeAudioMuted = vi.fn();
    public readonly setNativeAudioPlaying = vi.fn(async (): Promise<void> => undefined);
    public readonly setNativeAudioVolume = vi.fn();
    public readonly updateAudioDownmixSettings = vi.fn((): boolean => false);
    public readonly stop = vi.fn((): Promise<void> => {
        this.activeGeneration = null;
        this.closeQueuedFrames();
        return Promise.resolve();
    });
    public readonly resyncAudio = vi.fn(
        (options: CustomDecodeAudioResyncOptions): Promise<number | null> => (
            this.resyncDecodedAudio(options)
        )
    );
    // Like the real session, a new video epoch releases frames queued by the previous one
    public readonly resyncVideo = vi.fn((): boolean => {
        this.closeQueuedFrames();
        this.videoEnded = false;
        return true;
    });
    public readonly suspendVideo = vi.fn((): boolean => {
        this.closeQueuedFrames();
        this.videoEnded = false;
        return true;
    });
    public readonly takeFrame = vi.fn(
        (targetTimeMicroseconds: Microseconds): DecodedPresentationFrame | null => {
            let selectedFrameIndex = -1;
            for (let frameIndex = 0; frameIndex < this.queuedFrames.length; frameIndex += 1) {
                if (this.queuedFrames[frameIndex].mediaTimeMicroseconds
                    > targetTimeMicroseconds) {
                    break;
                }
                selectedFrameIndex = frameIndex;
            }
            if (selectedFrameIndex < 0) {
                return null;
            }

            for (let frameIndex = 0; frameIndex < selectedFrameIndex; frameIndex += 1) {
                const queuedFrame = this.queuedFrames[frameIndex];
                if (queuedFrame.outputMode === 'video-frame') {
                    queuedFrame.frame.close();
                }
            }
            const selectedFrame = this.queuedFrames[selectedFrameIndex];
            this.queuedFrames.splice(0, selectedFrameIndex + 1);
            return selectedFrame;
        }
    );

    public constructor(
        private readonly eventHandler: (event: CustomDecodeSessionEvent) => void,
        private readonly audioBridgeFactory: CustomDecodeAudioBridgeFactory | null
    ) {}

    public emit(event: CustomDecodeSessionEvent): void {
        this.eventHandler(event);
    }

    public getTelemetry(): CustomDecodeSessionTelemetry {
        return {
            ...createDecodeTelemetry(),
            activeGeneration: this.activeGeneration,
            audioEpoch: this.audioEpoch,
            audioResyncPending: this.audioResyncPending,
            lastFrameEndMediaTimeMicroseconds: this.lastFrameEndMediaTimeMicroseconds,
            lastFrameMediaTimeMicroseconds: this.lastFrameMediaTimeMicroseconds,
            pendingFrameCount: this.pendingFrameCount,
            queuedFrameCount: this.queuedFrames.length,
            videoEnded: this.videoEnded
        };
    }

    public getNativeAudioTimeMicroseconds(): Microseconds | null {
        return this.nativeAudioTimeMicroseconds;
    }

    public queueFrame(frame: DecodedPresentationFrame): void {
        this.queuedFrames.push(frame);
        // The real session records its newest decoded frame on receipt
        this.lastFrameMediaTimeMicroseconds = frame.mediaTimeMicroseconds;
        this.lastFrameEndMediaTimeMicroseconds = addMicroseconds(
            frame.mediaTimeMicroseconds,
            frame.durationMicroseconds
        );
    }

    public setPendingFrameCount(pendingFrameCount: number): void {
        this.pendingFrameCount = pendingFrameCount;
    }

    public setVideoEnded(videoEnded: boolean): void {
        this.videoEnded = videoEnded;
    }

    public setNativeAudioTimeMicroseconds(
        nativeAudioTimeMicroseconds: Microseconds | null
    ): void {
        this.nativeAudioTimeMicroseconds = nativeAudioTimeMicroseconds;
    }

    public async prepareAudio(
        configuration: DecodeWorkerAudioConfiguration
    ): Promise<CustomDecodeAudioBridge | null> {
        if (!this.audioBridgeFactory) {
            return null;
        }
        // The real session keeps the configured layout that an audio resync rebuilds from
        this.audioConfiguration = { ...configuration };
        return this.audioBridgeFactory(configuration);
    }

    /** Reports that the current audio epoch buffered its startup minimum */
    public completeAudioResync(): void {
        const generation = this.activeGeneration;
        if (generation === null) {
            throw new Error('Audio resync completion requires an active decode generation');
        }
        this.audioResyncPending = false;
        this.emit({ audioEpoch: this.audioEpoch, generation, type: 'audio-resynced' });
    }

    /**
     * Mirrors the real audio resync: the new layout's bridge is built first, a bridge
     * failure fails the current generation, and a replaced attempt issues no epoch.
     */
    public async resyncDecodedAudio(
        options: CustomDecodeAudioResyncOptions
    ): Promise<number | null> {
        const generation = this.activeGeneration;
        const audioConfiguration = this.audioConfiguration;
        if (generation === null || !audioConfiguration) {
            return null;
        }

        this.audioEpoch += 1;
        this.audioResyncPending = true;
        const audioEpoch = this.audioEpoch;
        const resyncedAudioConfiguration: DecodeWorkerAudioConfiguration = {
            ...audioConfiguration,
            channelCount: options.decodedAudioOutputChannelCount
        };
        try {
            await options.createAudioBridge(resyncedAudioConfiguration);
        } catch {
            if (this.isAudioEpochCurrent(generation, audioEpoch)) {
                this.emit({
                    failureKind: 'audio-output-failed',
                    generation,
                    message: 'Unable to create the resynchronized audio output',
                    type: 'error'
                });
            }
            return null;
        }
        if (!this.isAudioEpochCurrent(generation, audioEpoch)) {
            return null;
        }
        this.audioConfiguration = resyncedAudioConfiguration;
        return audioEpoch;
    }

    public start(options: CustomDecodeSessionStartOptions): void {
        this.activeGeneration = options.generation;
        this.starts.push({ ...options });
    }

    private isAudioEpochCurrent(generation: number, audioEpoch: number): boolean {
        return this.activeGeneration === generation && this.audioEpoch === audioEpoch;
    }

    private closeQueuedFrames(): void {
        for (const queuedFrame of this.queuedFrames) {
            if (queuedFrame.outputMode === 'video-frame') {
                queuedFrame.frame.close();
            }
        }
        this.queuedFrames.length = 0;
    }
}

class FakeAudioOutput implements CustomAudioOutput {
    private currentGeneration = 1;
    private estimatedOutputLatencyMicroseconds: Microseconds | null = null;
    private lastTelemetry: AudioWorkletTelemetry | null = null;
    private readonly outputDeviceListeners = new Set<() => void>();
    public readonly destroy = vi.fn();
    /** Absent until a test reports how many channels the current device accepts */
    public getMaximumChannelCount?: () => number | null;
    public readonly reconfiguredBridges: FakeAudioBridge[] = [];
    // Like the browser output, a rebuild keeps the device and returns the new stage's bridge
    public readonly reconfigure = vi.fn<NonNullable<CustomAudioOutput['reconfigure']>>(
        (): Promise<CustomDecodeAudioBridge> => {
            const audioBridge = new FakeAudioBridge(this.currentGeneration);
            this.reconfiguredBridges.push(audioBridge);
            return Promise.resolve(audioBridge as unknown as CustomDecodeAudioBridge);
        }
    );
    public readonly setMuted = vi.fn();
    public readonly setPlaying = vi.fn();
    public readonly setVolume = vi.fn();
    private readonly telemetryListeners = new Set<(telemetry: AudioWorkletTelemetry) => void>();

    public get generation(): number {
        return this.currentGeneration;
    }

    public get outputDeviceListenerCount(): number {
        return this.outputDeviceListeners.size;
    }

    public emitOutputDeviceChange(): void {
        for (const listener of [ ...this.outputDeviceListeners ]) {
            listener();
        }
    }

    public onOutputDeviceChange(listener: () => void): () => void {
        this.outputDeviceListeners.add(listener);
        return (): void => {
            this.outputDeviceListeners.delete(listener);
        };
    }

    public reportMaximumChannelCount(maximumChannelCount: number | null): void {
        this.getMaximumChannelCount = (): number | null => maximumChannelCount;
    }

    public getEstimatedOutputLatencyMicroseconds(): Microseconds | null {
        return this.estimatedOutputLatencyMicroseconds;
    }

    public getTelemetry(): AudioWorkletTelemetry | null {
        return this.lastTelemetry ? { ...this.lastTelemetry } : null;
    }

    public emitTelemetry(
        mediaTimeMicroseconds: Microseconds,
        generation = this.currentGeneration,
        overrides: Partial<AudioWorkletTelemetry> = {}
    ): void {
        const telemetry: AudioWorkletTelemetry = {
            consumedFrames: 1_024,
            droppedFrames: 0,
            hasPhysicalOutputTimeCorrelation: true,
            mediaTimeContextTimeMicroseconds: null,
            muted: false,
            outputFrames: 1_024,
            overflowEvents: 0,
            overflowFrames: 0,
            playing: true,
            queuedFrames: 2_048,
            reason: 'periodic',
            sequence: null,
            staleChunks: 0,
            type: 'telemetry',
            underflowEvents: 0,
            underflowFrames: 0,
            volume: 1,
            ...overrides,
            generation,
            mediaTimeMicroseconds
        };
        this.lastTelemetry = { ...telemetry };
        for (const listener of this.telemetryListeners) {
            listener(telemetry);
        }
    }

    public onTelemetry(listener: (telemetry: AudioWorkletTelemetry) => void): () => void {
        this.telemetryListeners.add(listener);
        return (): void => {
            this.telemetryListeners.delete(listener);
        };
    }

    public setGeneration(generation: number): void {
        this.currentGeneration = generation;
    }

    public setEstimatedOutputLatencyMicroseconds(
        estimatedOutputLatencyMicroseconds: Microseconds | null
    ): void {
        this.estimatedOutputLatencyMicroseconds = estimatedOutputLatencyMicroseconds;
    }
}

class FakeAudioBridge {
    private telemetry: CustomDecodeAudioBridgeTelemetry;

    public constructor(workletGeneration: number | null) {
        this.telemetry = {
            activeDecodeGeneration: null,
            failed: false,
            pendingFrameCount: 0,
            pendingSampleCount: 0,
            releasedSampleCredits: 0,
            staleSampleCount: 0,
            submittedEndMediaTimeMicroseconds: null,
            submittedFrameCount: 0,
            submittedSampleCount: 0,
            workletGeneration
        };
    }

    public activate(decodeGeneration: number, workletGeneration: number): void {
        this.telemetry = {
            ...this.telemetry,
            activeDecodeGeneration: decodeGeneration,
            workletGeneration
        };
    }

    public getTelemetry(): CustomDecodeAudioBridgeTelemetry {
        return { ...this.telemetry };
    }

    public setPendingFrameCount(pendingFrameCount: number): void {
        this.telemetry = {
            ...this.telemetry,
            pendingFrameCount,
            pendingSampleCount: pendingFrameCount === 0 ? 0 : 1
        };
    }

    public setSubmittedEndMediaTimeMicroseconds(
        submittedEndMediaTimeMicroseconds: Microseconds | null
    ): void {
        this.telemetry = {
            ...this.telemetry,
            submittedEndMediaTimeMicroseconds,
            submittedFrameCount: submittedEndMediaTimeMicroseconds === null ? 0 : 1,
            submittedSampleCount: submittedEndMediaTimeMicroseconds === null ? 0 : 1
        };
    }
}

type ControllerHarness = {
    audioBridge: FakeAudioBridge
    audioOutput: FakeAudioOutput | null
    controller: CustomPlaybackController
    events: CustomPlaybackControllerEvent[]
    fallbackRequests: CustomPlaybackFallbackRequest[]
    setMonotonicTime: (timeMicroseconds: Microseconds) => void
    videoDecodeSession: FakeVideoDecodeSession
};

function createPlayOptions(audioTrackIndex: number | null = null): CustomPlaybackPlayOptions {
    return {
        audioTrackIndex,
        dolbyVisionProfile: null,
        durationMicroseconds: secondsToMicroseconds(120),
        maximumCodedHeight: 1_080,
        maximumCodedWidth: 1_920,
        nativeHDRTransfer: null,
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat: null,
        startTimeMicroseconds: secondsToMicroseconds(5),
        url: 'http://localhost/video.mkv?ApiKey=secret',
        videoDecoderBackend: 'native',
        videoOutputMode: 'video-frame',
        videoTrackIndex: 0
    };
}

function createDecodedFrame(
    mediaTimeMicroseconds: Microseconds,
    durationMicroseconds: Microseconds = millisecondsToMicroseconds(40)
): DecodedVideoPresentationFrame {
    return {
        durationMicroseconds,
        frame: { close: vi.fn() } as unknown as VideoFrame,
        mediaTimeMicroseconds,
        outputMode: 'video-frame'
    };
}

function createControllerHarness(
    withAudio: boolean,
    controllerOptions: Partial<CustomPlaybackControllerOptions> = {}
): ControllerHarness {
    const events: CustomPlaybackControllerEvent[] = [];
    const fallbackRequests: CustomPlaybackFallbackRequest[] = [];
    let videoDecodeSession: FakeVideoDecodeSession | null = null;
    const audioOutput = withAudio ? new FakeAudioOutput() : null;
    const fakeAudioBridge = new FakeAudioBridge(audioOutput?.generation ?? null);
    let monotonicTime = secondsToMicroseconds(10);
    const controller = new CustomPlaybackController({
        audioOutputFactory: audioOutput ?
            (configuration: DecodeWorkerAudioConfiguration): CustomAudioOutputBinding => ({
                bridge: fakeAudioBridge as unknown as CustomDecodeAudioBridge,
                configuration: { ...configuration },
                output: audioOutput
            }) :
            undefined,
        eventHandler: (event: CustomPlaybackControllerEvent): void => {
            events.push(event);
        },
        fallbackHook: (request: CustomPlaybackFallbackRequest): void => {
            fallbackRequests.push(request);
        },
        monotonicTimeSource: (): Microseconds => monotonicTime,
        pipelineStopTimeoutMicroseconds: millisecondsToMicroseconds(100),
        startupTimeoutMicroseconds: millisecondsToMicroseconds(100),
        videoDecodeSessionFactory: (eventHandler, audioBridgeFactory) => {
            videoDecodeSession = new FakeVideoDecodeSession(eventHandler, audioBridgeFactory);
            return videoDecodeSession;
        },
        ...controllerOptions
    });
    if (!videoDecodeSession) {
        throw new Error('Video decode session factory was not called');
    }

    return {
        audioBridge: fakeAudioBridge,
        audioOutput,
        controller,
        events,
        fallbackRequests,
        setMonotonicTime: (timeMicroseconds: Microseconds): void => {
            monotonicTime = timeMicroseconds;
        },
        videoDecodeSession
    };
}

async function flushAsyncWork(): Promise<void> {
    for (let iteration = 0; iteration < 32; iteration += 1) {
        await Promise.resolve();
    }
}

type Deferred<Value> = {
    promise: Promise<Value>
    reject: (error: unknown) => void
    resolve: (value: Value) => void
};

function createDeferred<Value>(): Deferred<Value> {
    let rejectPromise: (error: unknown) => void = () => {
        throw new Error('Deferred promise was not initialized');
    };
    let resolvePromise: (value: Value) => void = () => {
        throw new Error('Deferred promise was not initialized');
    };
    const promise = new Promise<Value>((resolve, reject) => {
        rejectPromise = reject;
        resolvePromise = resolve;
    });
    return {
        promise,
        reject: rejectPromise,
        resolve: resolvePromise
    };
}

async function startReadyPlayback(
    harness: ControllerHarness,
    withAudio: boolean,
    playOptionOverrides: Partial<CustomPlaybackPlayOptions> = {},
    audioConfigurationOverrides: Partial<DecodeWorkerAudioConfiguration> = {}
): Promise<number> {
    const startPromise = harness.controller.play({
        ...createPlayOptions(withAudio ? 1 : null),
        ...playOptionOverrides
    });
    await flushAsyncWork();
    const generation = harness.videoDecodeSession.starts.at(-1)?.generation;
    if (!generation) {
        throw new Error('Video decode did not start');
    }
    const audioConfiguration: DecodeWorkerAudioConfiguration | null = withAudio ? {
        channelCount: 2,
        codec: 'opus',
        sampleRate: 48_000,
        ...audioConfigurationOverrides
    } : null;
    if (audioConfiguration) {
        await harness.videoDecodeSession.prepareAudio(audioConfiguration);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        harness.audioBridge.activate(generation, harness.audioOutput.generation);
    }
    harness.videoDecodeSession.emit({
        audio: audioConfiguration,
        codec: 'avc1.640028',
        generation,
        type: 'ready'
    });
    await expect(startPromise).resolves.toEqual({
        fallbackReason: null,
        generation,
        status: 'started'
    });
    return generation;
}

function requireAudioOutput(harness: ControllerHarness): FakeAudioOutput {
    if (!harness.audioOutput) {
        throw new Error('Expected an audio output');
    }
    return harness.audioOutput;
}

describe('CustomPlaybackController', () => {
    it.each([ 'ffmpeg-mpeg2-vc1', 'openjpeg' ] as const)(
        'starts the qualified %s SDR VideoFrame route',
        async videoDecoderBackend => {
            const harness = createControllerHarness(false);
            const startPromise = harness.controller.play({
                ...createPlayOptions(),
                videoDecoderBackend
            });
            await flushAsyncWork();
            const generation = harness.videoDecodeSession.starts[0]?.generation;
            if (!generation) {
                throw new Error('Software video decode did not start');
            }

            expect(harness.videoDecodeSession.starts[0]).toMatchObject({
                generation,
                videoDecoderBackend,
                videoOutputMode: 'video-frame'
            });
            harness.videoDecodeSession.emit({
                audio: null,
                codec: videoDecoderBackend === 'openjpeg' ? 'mjp2' : 'mpeg2video',
                generation,
                type: 'ready'
            });
            await expect(startPromise).resolves.toMatchObject({
                generation,
                status: 'started'
            });
            await harness.controller.destroy();
        }
    );

    it('forwards native HDR metadata neutralization to the decode session', async () => {
        const harness = createControllerHarness(false);
        const startPromise = harness.controller.play({
            ...createPlayOptions(),
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true
        });
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts[0]?.generation;
        if (!generation) {
            throw new Error('Native HDR decode did not start');
        }

        expect(harness.videoDecodeSession.starts[0]).toMatchObject({
            generation,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            generation,
            type: 'ready'
        });
        await expect(startPromise).resolves.toMatchObject({
            generation,
            status: 'started'
        });
        await harness.controller.destroy();
    });

    it('forwards the selected Dolby Vision profile to the decode session', async () => {
        const harness = createControllerHarness(false);
        const startPromise = harness.controller.play({
            ...createPlayOptions(),
            dolbyVisionProfile: 7,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            rawVideoFrameFormat: 'I420P10',
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'raw-planes'
        });
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts[0]?.generation;
        if (!generation) {
            throw new Error('Dolby Vision decode did not start');
        }

        expect(harness.videoDecodeSession.starts[0]).toMatchObject({
            dolbyVisionProfile: 7,
            generation,
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'raw-planes'
        });
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'hev1.2.4.L153.B0',
            generation,
            type: 'ready'
        });
        await expect(startPromise).resolves.toMatchObject({
            generation,
            status: 'started'
        });
        await harness.controller.destroy();
    });

    it('starts one 8K 10-bit raw transfer without imposing a 4K ceiling', async () => {
        const harness = createControllerHarness(false);
        const startPromise = harness.controller.play({
            ...createPlayOptions(),
            maximumCodedHeight: 4_320,
            maximumCodedWidth: 7_680,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        });
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts[0]?.generation;
        if (!generation) {
            throw new Error('8K raw decode did not start');
        }

        expect(harness.videoDecodeSession.starts[0]).toMatchObject({
            maximumCodedHeight: 4_320,
            maximumCodedWidth: 7_680,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        });
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'hvc1.2.6.L183.B0',
            generation,
            type: 'ready'
        });
        await expect(startPromise).resolves.toMatchObject({
            generation,
            status: 'started'
        });
        await harness.controller.destroy();
    });

    it('rejects raw playback only when the transfer byte budget is exceeded', async () => {
        const harness = createControllerHarness(false);
        const oversizedOptions: CustomPlaybackPlayOptions = {
            ...createPlayOptions(),
            maximumCodedHeight: 8_640,
            maximumCodedWidth: 15_360,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        };

        expect(() => harness.controller.play(oversizedOptions)).toThrow(
            'Raw custom playback exceeds its transfer memory budget'
        );
        expect(() => harness.controller.play({
            ...oversizedOptions,
            dolbyVisionProfile: 7,
            maximumCodedHeight: 4_320,
            maximumCodedWidth: 7_680
        })).toThrow('Raw custom playback exceeds its transfer memory budget');
        expect(harness.videoDecodeSession.starts).toEqual([]);
        await harness.controller.destroy();
    });

    it('forwards the selected decoded audio layout and downmix algorithm', async () => {
        const harness = createControllerHarness(true);
        const options = createPlayOptions(0);
        options.audioDownmixAlgorithm = CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845;
        const audioDownmixSettings: AudioDownmixSettings = {
            centerLevel: 0.4,
            outputGain: 0.6,
            surroundLevel: 0.5,
            version: 1
        };
        options.audioDownmixSettings = audioDownmixSettings;
        options.decodedAudioOutputChannelCount = 8;

        const startPromise = harness.controller.play(options);
        await flushAsyncWork();

        expect(harness.videoDecodeSession.starts[0]).toMatchObject({
            audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
            audioDownmixSettings,
            audioTrackIndex: 0,
            decodedAudioOutputChannelCount: 8
        });

        await harness.controller.destroy();
        await expect(startPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it('retains a pending-startup gain update for the new decode generation', async () => {
        const harness = createControllerHarness(true);
        const decoderStop = createDeferred<void>();
        harness.videoDecodeSession.stop.mockImplementationOnce(
            (): Promise<void> => decoderStop.promise
        );
        const startPromise = harness.controller.play(createPlayOptions(0));
        await flushAsyncWork();
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

        expect(harness.controller.updateAudioDownmixSettings(settings)).toBe(false);
        expect(harness.videoDecodeSession.updateAudioDownmixSettings)
            .not.toHaveBeenCalled();
        settings.outputGain = 9;
        decoderStop.resolve();
        await flushAsyncWork();

        expect(harness.videoDecodeSession.starts).toHaveLength(1);
        expect(harness.videoDecodeSession.starts[0].audioDownmixSettings).toEqual({
            centerLevel: 0.75,
            outputGain: 1.5,
            surroundLevel: 0.5,
            version: 1
        });

        await harness.controller.destroy();
        await expect(startPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it('delegates to the current configured worker while overall startup remains pending', async () => {
        const harness = createControllerHarness(true);
        const startPromise = harness.controller.play(createPlayOptions(0));
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts[0]?.generation;
        if (!generation) {
            throw new Error('Video decode did not start');
        }
        harness.videoDecodeSession.emit({
            audio: {
                channelCount: 2,
                codec: 'opus',
                sampleRate: 48_000,
                sourceChannelCount: 6,
                sourceSampleRate: 48_000
            },
            codec: 'avc1.640028',
            generation,
            type: 'configured'
        });
        harness.videoDecodeSession.updateAudioDownmixSettings.mockReturnValueOnce(true);
        const settings: AudioDownmixSettings = {
            centerLevel: 0.75,
            outputGain: 1.5,
            surroundLevel: 0.5,
            version: 1
        };

        expect(harness.controller.updateAudioDownmixSettings(settings)).toBe(true);
        expect(harness.videoDecodeSession.updateAudioDownmixSettings)
            .toHaveBeenCalledWith(settings);
        expect(harness.controller.playbackState).toBe('starting');

        await harness.controller.destroy();
        await expect(startPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it('persists a live gain snapshot across a client-side audio switch', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        harness.videoDecodeSession.updateAudioDownmixSettings.mockReturnValueOnce(true);
        const settings: {
            centerLevel: number
            outputGain: number
            surroundLevel: number
            version: 1
        } = {
            centerLevel: 0.5,
            outputGain: 1.25,
            surroundLevel: 0.75,
            version: 1
        };

        expect(harness.controller.updateAudioDownmixSettings(settings)).toBe(true);
        expect(harness.videoDecodeSession.updateAudioDownmixSettings)
            .toHaveBeenCalledWith(settings);
        settings.centerLevel = 2;
        const switchPromise = harness.controller.setAudioStreamIndex(2);
        await flushAsyncWork();

        expect(harness.videoDecodeSession.starts.at(-1)).toMatchObject({
            audioDownmixSettings: {
                centerLevel: 0.5,
                outputGain: 1.25,
                surroundLevel: 0.75,
                version: 1
            },
            audioTrackIndex: 2
        });
        await harness.controller.destroy();
        await expect(switchPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it('owns decode, PCM output, clock controls, events, and telemetry', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(harness, true);

        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.videoDecodeSession.starts[0]).toMatchObject({
            audioTrackIndex: 1,
            generation,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 5_000_000,
            videoDecoderBackend: 'native'
        });
        expect(harness.audioOutput?.setPlaying).toHaveBeenLastCalledWith(true);
        expect(harness.events.some(event => event.type === 'ready')).toBe(true);
        expect(harness.events.some(event => event.type === 'playing')).toBe(true);

        harness.setMonotonicTime(secondsToMicroseconds(10.25));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_250_000);
        const clockGeneration = harness.controller.getTelemetry().clock.generation;
        harness.audioOutput?.emitTelemetry(secondsToMicroseconds(7));
        expect(harness.controller.currentTimeMicroseconds).toBe(7_000_000);
        expect(harness.controller.getTelemetry().clock.generation).toBe(clockGeneration);
        harness.controller.pause();
        harness.setMonotonicTime(secondsToMicroseconds(11));
        expect(harness.controller.currentTimeMicroseconds).toBe(7_000_000);
        harness.controller.resume();
        harness.setMonotonicTime(secondsToMicroseconds(11.25));
        expect(harness.controller.currentTimeMicroseconds).toBe(7_250_000);

        harness.controller.setVolume(0.25);
        harness.controller.setNormalizationGain(2);
        harness.controller.setMuted(true);
        expect(harness.controller.setPlaybackRate(1)).toBe(true);
        expect(harness.audioOutput?.setVolume).toHaveBeenLastCalledWith(0.5);
        expect(harness.audioOutput?.setMuted).toHaveBeenLastCalledWith(true);
        expect(() => harness.controller.setNormalizationGain(-1)).toThrow(RangeError);
        expect(() => harness.controller.setNormalizationGain(Number.POSITIVE_INFINITY))
            .toThrow(RangeError);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        expect(harness.controller.getTelemetry()).toMatchObject({
            activeGeneration: generation,
            audioPath: 'ready',
            currentTimeMicroseconds: 7_250_000,
            durationMicroseconds: 120_000_000,
            muted: true,
            normalizationGain: 2,
            state: 'playing',
            volume: 0.25
        });

        await harness.controller.destroy();
        await harness.controller.destroy();
        expect(harness.audioOutput?.destroy).toHaveBeenCalledTimes(1);
    });

    it('owns native media audio controls and hands clock authority over once', async () => {
        const nativeAudioBridgeFactory = (
            vi.fn() as unknown as CustomDecodeNativeAudioBridgeFactory
        );
        const harness = createControllerHarness(false, { nativeAudioBridgeFactory });
        const playOptions: CustomPlaybackPlayOptions = {
            ...createPlayOptions(0),
            audioOutputMode: 'native-media'
        };
        const startPromise = harness.controller.play(playOptions);
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts.at(-1)?.generation;
        if (!generation) {
            throw new Error('Native media audio decode did not start');
        }

        expect(harness.videoDecodeSession.starts[0]).toMatchObject({
            audioOutputMode: 'native-media',
            audioTrackIndex: 0,
            durationMicroseconds: secondsToMicroseconds(120),
            generation
        });
        harness.videoDecodeSession.emit({
            audio: {
                channelCount: 6,
                codec: 'ec-3',
                mimeType: 'audio/mp4; codecs="ec-3"',
                outputMode: 'native-media',
                sampleRate: 48_000
            },
            codec: 'hvc1.2.4.L153.B0',
            generation,
            type: 'ready'
        });
        await expect(startPromise).resolves.toEqual({
            fallbackReason: null,
            generation,
            status: 'started'
        });
        expect(harness.videoDecodeSession.setNativeAudioVolume)
            .toHaveBeenLastCalledWith(1);
        expect(harness.videoDecodeSession.setNativeAudioMuted)
            .toHaveBeenLastCalledWith(false);
        expect(harness.videoDecodeSession.setNativeAudioPlaying)
            .toHaveBeenLastCalledWith(true);
        expect(harness.controller.canSetAudioStreamIndex()).toBe(true);

        harness.setMonotonicTime(secondsToMicroseconds(10.25));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_250_000);
        harness.videoDecodeSession.setNativeAudioTimeMicroseconds(secondsToMicroseconds(6));
        expect(harness.controller.currentTimeMicroseconds).toBe(6_000_000);
        expect(harness.controller.getTelemetry().clock.mediaTimeMicroseconds)
            .toBe(6_000_000);

        harness.videoDecodeSession.setNativeAudioTimeMicroseconds(null);
        harness.setMonotonicTime(secondsToMicroseconds(10.5));
        expect(harness.controller.currentTimeMicroseconds).toBe(6_000_000);

        harness.controller.setNormalizationGain(2);
        harness.controller.setVolume(0.4);
        harness.controller.setMuted(true);
        expect(harness.videoDecodeSession.setNativeAudioVolume)
            .toHaveBeenLastCalledWith(0.8);
        expect(harness.videoDecodeSession.setNativeAudioMuted)
            .toHaveBeenLastCalledWith(true);

        harness.controller.setNormalizationGain(4);
        expect(harness.videoDecodeSession.setNativeAudioVolume)
            .toHaveBeenLastCalledWith(1);

        harness.controller.pause();
        expect(harness.videoDecodeSession.setNativeAudioPlaying)
            .toHaveBeenLastCalledWith(false);
        harness.controller.resume();
        expect(harness.videoDecodeSession.setNativeAudioPlaying)
            .toHaveBeenLastCalledWith(true);

        harness.videoDecodeSession.setNativeAudioTimeMicroseconds(
            secondsToMicroseconds(120)
        );
        harness.videoDecodeSession.emit({ generation, type: 'ended' });
        expect(harness.controller.playbackState).toBe('ended');
        expect(harness.events.filter(event => event.type === 'ended')).toHaveLength(1);
        await harness.controller.destroy();
    });

    it('falls back in the same session when owned native audio play is rejected', async () => {
        const nativeAudioBridgeFactory = (
            vi.fn() as unknown as CustomDecodeNativeAudioBridgeFactory
        );
        const harness = createControllerHarness(false, { nativeAudioBridgeFactory });
        const startPromise = harness.controller.play({
            ...createPlayOptions(0),
            audioOutputMode: 'native-media'
        });
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts.at(-1)?.generation;
        if (!generation) {
            throw new Error('Native media audio decode did not start');
        }
        harness.videoDecodeSession.setNativeAudioPlaying.mockRejectedValueOnce(
            new Error('Native audio playback was blocked')
        );
        harness.videoDecodeSession.emit({
            audio: {
                channelCount: 2,
                codec: 'ac-3',
                mimeType: 'audio/mp4; codecs="ac-3"',
                outputMode: 'native-media',
                sampleRate: 48_000
            },
            codec: 'hvc1.2.4.L153.B0',
            generation,
            type: 'ready'
        });

        await expect(startPromise).resolves.toEqual({
            fallbackReason: 'audio-output-failed',
            generation,
            status: 'fallback'
        });
        expect(harness.fallbackRequests).toEqual([ expect.objectContaining({
            disposition: 'same-session-native',
            generation,
            reason: 'audio-output-failed'
        }) ]);
        expect(harness.controller.playbackState).toBe('fallback');
        await harness.controller.destroy();
    });

    it('does not pin the audio-master clock to repeated uncorrelated telemetry', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);

        harness.setMonotonicTime(secondsToMicroseconds(10.25));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_250_000);
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5),
            undefined,
            { hasPhysicalOutputTimeCorrelation: false }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(5_250_000);

        harness.setMonotonicTime(secondsToMicroseconds(10.5));
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5),
            undefined,
            { hasPhysicalOutputTimeCorrelation: false }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(5_500_000);
    });

    it('freezes the audio-master clock across underflow and reanchors on recovery', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);

        harness.setMonotonicTime(secondsToMicroseconds(10.1));
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.08),
            undefined,
            { reason: 'underflow' }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(5_080_000);
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'audio-buffer')).toHaveLength(1);

        harness.setMonotonicTime(secondsToMicroseconds(12));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_080_000);
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(9),
            undefined,
            { reason: 'periodic' }
        );
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(9),
            undefined,
            { reason: 'underflow' }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(5_080_000);
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'audio-buffer')).toHaveLength(1);

        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.12),
            undefined,
            { reason: 'underflow-recovered' }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(5_120_000);
        harness.setMonotonicTime(secondsToMicroseconds(12.25));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_370_000);
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(2);
    });

    it('preserves audio underflow suspension without an output-time correlation', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);

        harness.setMonotonicTime(secondsToMicroseconds(10.1));
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5),
            undefined,
            {
                hasPhysicalOutputTimeCorrelation: false,
                reason: 'underflow'
            }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(5_100_000);
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'audio-buffer')).toHaveLength(1);

        harness.setMonotonicTime(secondsToMicroseconds(12));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_100_000);
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5),
            undefined,
            {
                hasPhysicalOutputTimeCorrelation: false,
                reason: 'underflow-recovered'
            }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(5_100_000);

        harness.setMonotonicTime(secondsToMicroseconds(12.25));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_350_000);
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(2);
    });

    it('renegotiates after a sustained audio underflow', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        harness.setMonotonicTime(secondsToMicroseconds(10.1));
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.08),
            undefined,
            { reason: 'underflow' }
        );
        harness.setMonotonicTime(secondsToMicroseconds(20.1));

        expect(harness.controller.takeCurrentFrame()).toBeNull();

        expect(harness.controller.playbackState).toBe('fallback');
        expect(harness.fallbackRequests).toEqual([ expect.objectContaining({
            disposition: 'renegotiate-source',
            reason: 'playback-stalled'
        }) ]);
    });

    it('ignores old worklet telemetry during and after a seek generation change', async () => {
        const harness = createControllerHarness(true);
        const firstGeneration = await startReadyPlayback(harness, true);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }

        const seekPromise = harness.controller.seek(secondsToMicroseconds(42));
        await flushAsyncWork();
        const secondGeneration = harness.videoDecodeSession.starts.at(-1)?.generation;
        if (!secondGeneration) {
            throw new Error('Seek generation did not start');
        }
        harness.audioOutput.setGeneration(2);
        harness.audioOutput.emitTelemetry(
            secondsToMicroseconds(99),
            1,
            { hasPhysicalOutputTimeCorrelation: false }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(42_000_000);

        const audioConfiguration: DecodeWorkerAudioConfiguration = {
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        };
        await harness.videoDecodeSession.prepareAudio(audioConfiguration);
        harness.audioBridge.activate(secondGeneration, harness.audioOutput.generation);
        harness.videoDecodeSession.emit({
            audio: audioConfiguration,
            codec: 'avc1.640028',
            generation: secondGeneration,
            type: 'ready'
        });
        await seekPromise;

        harness.audioOutput.emitTelemetry(
            secondsToMicroseconds(100),
            1,
            { hasPhysicalOutputTimeCorrelation: false }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(42_000_000);
        harness.audioOutput.emitTelemetry(
            secondsToMicroseconds(100),
            2,
            { hasPhysicalOutputTimeCorrelation: false }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(42_000_000);
        harness.audioOutput.emitTelemetry(secondsToMicroseconds(43), 2);
        expect(harness.controller.currentTimeMicroseconds).toBe(43_000_000);
        expect(harness.controller.getTelemetry().staleEventCount).toBe(2);
        expect(secondGeneration).toBeGreaterThan(firstGeneration);
    });

    it('freezes a video-only clock while starved and resumes without a logical pause', async () => {
        const harness = createControllerHarness(false);
        await startReadyPlayback(harness, false);

        harness.setMonotonicTime(secondsToMicroseconds(10.25));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.currentTimeMicroseconds).toBe(5_250_000);
        harness.setMonotonicTime(millisecondsToMicroseconds(10_349));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(0);
        harness.setMonotonicTime(millisecondsToMicroseconds(10_350));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.currentTimeMicroseconds).toBe(5_350_000);
        harness.setMonotonicTime(secondsToMicroseconds(11));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_350_000);

        const recoveredFrame = createDecodedFrame(secondsToMicroseconds(5.5));
        harness.videoDecodeSession.queueFrame(recoveredFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(recoveredFrame);
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.controller.notifyFramePresented(recoveredFrame)).toBe(true);
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(1);
        expect(harness.events.filter(event => event.type === 'statechange'
            && event.state === 'paused')).toHaveLength(0);
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(2);

        harness.setMonotonicTime(secondsToMicroseconds(11.25));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_750_000);
    });

    it('intentionally defers the 10-second starvation bound until RAF polling resumes', async () => {
        const harness = createControllerHarness(false);
        await startReadyPlayback(harness, false);

        harness.setMonotonicTime(millisecondsToMicroseconds(10_100));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_200));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(20_199));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('playing');
        harness.setMonotonicTime(millisecondsToMicroseconds(20_200));

        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('fallback');
        expect(harness.fallbackRequests).toEqual([ expect.objectContaining({
            disposition: 'renegotiate-source',
            reason: 'playback-stalled'
        }) ]);
    });

    it('discards seek preroll and recovers on the first current frame', async () => {
        const harness = createControllerHarness(false);
        await startReadyPlayback(harness, false);
        const seekPromise = harness.controller.seek(secondsToMicroseconds(42));
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts.at(-1)?.generation;
        if (!generation) {
            throw new Error('Seek generation did not start');
        }
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            generation,
            type: 'ready'
        });
        await seekPromise;

        const prerollFrame = createDecodedFrame(secondsToMicroseconds(38));
        harness.videoDecodeSession.queueFrame(prerollFrame);
        expect(harness.controller.takeCurrentFrame()).toBeNull();

        expect(harness.videoDecodeSession.discardFrame).toHaveBeenCalledWith(prerollFrame);
        expect(prerollFrame.frame.close).toHaveBeenCalledOnce();
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.fallbackRequests).toHaveLength(0);
        expect(harness.controller.getTelemetry()).toMatchObject({
            discardedStaleVideoFrameCount: 1,
            lastVideoDecodeLag: {
                frameEndTimeMicroseconds: secondsToMicroseconds(38.04),
                gapMicroseconds: secondsToMicroseconds(3.96),
                generation,
                postSeek: true,
                targetTimeMicroseconds: secondsToMicroseconds(42)
            }
        });
        const telemetry = harness.controller.getTelemetry();
        if (!telemetry.lastVideoDecodeLag) {
            throw new Error('Expected video decode lag telemetry');
        }
        telemetry.lastVideoDecodeLag.targetTimeMicroseconds = secondsToMicroseconds(0);
        expect(harness.controller.getTelemetry().lastVideoDecodeLag?.targetTimeMicroseconds)
            .toBe(secondsToMicroseconds(42));

        const currentFrame = createDecodedFrame(secondsToMicroseconds(42));
        harness.videoDecodeSession.queueFrame(currentFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(currentFrame);
        expect(harness.controller.notifyFramePresented(currentFrame)).toBe(true);
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.fallbackRequests).toHaveLength(0);
    });

    it('recovers from a transient scheduler delay after releasing its stale frame', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        const staleFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(staleFrame);
        harness.setMonotonicTime(secondsToMicroseconds(13));

        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.videoDecodeSession.discardFrame).toHaveBeenCalledWith(staleFrame);
        expect(harness.controller.playbackState).toBe('playing');

        harness.setMonotonicTime(millisecondsToMicroseconds(13_040));
        const currentFrame = createDecodedFrame(millisecondsToMicroseconds(8_040));
        harness.videoDecodeSession.queueFrame(currentFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(currentFrame);
        expect(harness.controller.notifyFramePresented(currentFrame)).toBe(true);
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.fallbackRequests).toHaveLength(0);
        expect(harness.controller.getTelemetry().lastVideoDecodeLag).toMatchObject({
            postSeek: false,
            targetTimeMicroseconds: secondsToMicroseconds(8)
        });
    });

    it('replenishes real decode-session credit after stale VideoFrame discard', async () => {
        const worker = new ControllerDecodeWorker();
        const fallbackRequests: CustomPlaybackFallbackRequest[] = [];
        const decodeSessionHolder: { current: CustomDecodeSession | null } = {
            current: null
        };
        let monotonicTimeMicroseconds = secondsToMicroseconds(10);
        const controller = new CustomPlaybackController({
            fallbackHook: (request: CustomPlaybackFallbackRequest): void => {
                fallbackRequests.push(request);
            },
            monotonicTimeSource: (): Microseconds => monotonicTimeMicroseconds,
            pipelineStopTimeoutMicroseconds: millisecondsToMicroseconds(100),
            startupTimeoutMicroseconds: millisecondsToMicroseconds(100),
            videoDecodeSessionFactory: (
                eventHandler,
                audioBridgeFactory,
                nativeAudioBridgeFactory
            ): CustomDecodeSession => {
                const createdDecodeSession = new CustomDecodeSession(
                    eventHandler,
                    () => worker as unknown as Worker,
                    null,
                    audioBridgeFactory,
                    nativeAudioBridgeFactory
                );
                decodeSessionHolder.current = createdDecodeSession;
                return createdDecodeSession;
            }
        });
        const decodeSession = decodeSessionHolder.current;
        if (!decodeSession) {
            throw new Error('Real video decode session factory was not called');
        }

        const startPromise = controller.play(createPlayOptions());
        await flushAsyncWork();
        const generation = decodeSession.getTelemetry().activeGeneration;
        if (generation === null) {
            throw new Error('Real video decode generation did not start');
        }
        worker.emitMessage({
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation,
            type: 'ready'
        });
        const staleVideoFrame = emitControllerDecodedFrame(
            worker,
            generation,
            secondsToMicroseconds(5)
        );
        await expect(startPromise).resolves.toMatchObject({ generation, status: 'started' });

        monotonicTimeMicroseconds = secondsToMicroseconds(13);
        expect(controller.takeCurrentFrame()).toBeNull();
        expect(staleVideoFrame.close).toHaveBeenCalledOnce();
        expect(decodeSession.getTelemetry()).toMatchObject({
            pendingFrameCount: 0,
            queuedFrameCount: 0,
            takenFrameCount: 1
        });
        expect(worker.postedMessages.at(-1)).toEqual({
            frameCredits: 1,
            generation,
            type: 'pull'
        });
        expect(worker.postedMessages).toHaveLength(2);

        const currentVideoFrame = emitControllerDecodedFrame(
            worker,
            generation,
            secondsToMicroseconds(8)
        );
        const currentPresentationFrame = controller.takeCurrentFrame();
        expect(currentPresentationFrame?.frame).toBe(currentVideoFrame);
        expect(decodeSession.getTelemetry().pendingFrameCount).toBe(1);

        currentVideoFrame.close();
        if (!currentPresentationFrame) {
            throw new Error('Expected the replacement decoded VideoFrame');
        }
        expect(controller.notifyFramePresented(currentPresentationFrame)).toBe(true);
        expect(decodeSession.getTelemetry().pendingFrameCount).toBe(0);
        expect(worker.postedMessages.at(-1)).toEqual({
            frameCredits: 1,
            generation,
            type: 'pull'
        });
        expect(worker.postedMessages).toHaveLength(3);
        expect(staleVideoFrame.close).toHaveBeenCalledOnce();
        expect(currentVideoFrame.close).toHaveBeenCalledOnce();
        expect(fallbackRequests).toHaveLength(0);

        const destroyPromise = controller.destroy();
        expect(worker.postedMessages.at(-1)).toEqual({ generation, type: 'stop' });
        worker.emitMessage({ generation, type: 'stopped' });
        await destroyPromise;
        expect(staleVideoFrame.close).toHaveBeenCalledOnce();
        expect(currentVideoFrame.close).toHaveBeenCalledOnce();
    });

    it('renegotiates after sustained ordinary playback decode lag', async () => {
        const harness = createControllerHarness(false, {
            playbackStallTimeoutMicroseconds: millisecondsToMicroseconds(100)
        });
        await startReadyPlayback(harness, false);
        harness.setMonotonicTime(secondsToMicroseconds(13));
        const firstStaleFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(firstStaleFrame);
        expect(harness.controller.takeCurrentFrame()).toBeNull();

        harness.setMonotonicTime(millisecondsToMicroseconds(13_050));
        const secondStaleFrame = createDecodedFrame(millisecondsToMicroseconds(5_040));
        harness.videoDecodeSession.queueFrame(secondStaleFrame);
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.fallbackRequests).toHaveLength(0);

        harness.setMonotonicTime(millisecondsToMicroseconds(13_100));
        expect(harness.controller.takeCurrentFrame()).toBeNull();

        expect(harness.videoDecodeSession.discardFrame).toHaveBeenCalledTimes(2);
        expect(harness.controller.playbackState).toBe('fallback');
        expect(harness.fallbackRequests).toEqual([ expect.objectContaining({
            disposition: 'renegotiate-source',
            reason: 'playback-stalled'
        }) ]);
        expect(harness.controller.getTelemetry()).toMatchObject({
            discardedStaleVideoFrameCount: 2,
            lastErrorMessage: expect.stringContaining('post-seek false')
        });
    });

    it('does not count a user pause toward the sustained starvation bound', async () => {
        const harness = createControllerHarness(false);
        await startReadyPlayback(harness, false);

        harness.setMonotonicTime(millisecondsToMicroseconds(10_100));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_200));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.controller.pause();
        harness.setMonotonicTime(millisecondsToMicroseconds(30_000));
        harness.controller.resume();
        expect(harness.controller.takeCurrentFrame()).toBeNull();

        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.fallbackRequests).toHaveLength(0);
    });

    it('refreshes a paused seek after discarding stale preroll', async () => {
        const harness = createControllerHarness(false);
        await startReadyPlayback(harness, false);
        harness.controller.pause();
        const seekPromise = harness.controller.seek(secondsToMicroseconds(42));
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts.at(-1)?.generation;
        if (!generation) {
            throw new Error('Paused seek generation did not start');
        }
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            generation,
            type: 'ready'
        });
        await seekPromise;
        expect(harness.controller.playbackState).toBe('paused');

        const prerollFrame = createDecodedFrame(secondsToMicroseconds(38));
        harness.videoDecodeSession.queueFrame(prerollFrame);
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(secondsToMicroseconds(30));
        expect(harness.controller.playbackState).toBe('paused');
        expect(harness.fallbackRequests).toHaveLength(0);

        const currentFrame = createDecodedFrame(secondsToMicroseconds(42));
        harness.videoDecodeSession.queueFrame(currentFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(currentFrame);
        expect(harness.controller.notifyFramePresented(currentFrame)).toBe(true);
        expect(harness.controller.playbackState).toBe('paused');
        expect(harness.controller.getTelemetry().lastVideoDecodeLag).toMatchObject({
            generation,
            postSeek: true
        });

        harness.controller.resume();
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.fallbackRequests).toHaveLength(0);
    });

    it('starts paused when paused during startup and exposes frame-provider waiting recovery', async () => {
        const harness = createControllerHarness(false);
        const startPromise = harness.controller.play(createPlayOptions());
        harness.controller.pause();
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts[0].generation;
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'vp09.00.10.08',
            generation,
            type: 'ready'
        });
        await startPromise;

        expect(harness.controller.playbackState).toBe('paused');
        harness.controller.resume();
        const initialTimeUpdateCount = harness.events.filter(
            event => event.type === 'timeupdate'
        ).length;
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_099));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(0);
        harness.setMonotonicTime(millisecondsToMicroseconds(10_100));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(1);
        expect(harness.events.filter(event => event.type === 'timeupdate')).toHaveLength(
            initialTimeUpdateCount
        );
        harness.setMonotonicTime(secondsToMicroseconds(10.25));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.events.filter(event => event.type === 'timeupdate')).toHaveLength(
            initialTimeUpdateCount + 1
        );
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(1);

        const decodedFrame = {
            durationMicroseconds: millisecondsToMicroseconds(40),
            frame: { close: vi.fn() } as unknown as VideoFrame,
            mediaTimeMicroseconds: secondsToMicroseconds(5),
            outputMode: 'video-frame' as const
        };
        harness.videoDecodeSession.takeFrame.mockReturnValueOnce(decodedFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(decodedFrame);
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(2);

        await harness.controller.destroy();
        expect(harness.controller.playbackState).toBe('idle');
    });

    it('holds normal future-dated frames without video waiting and playing churn', async () => {
        const harness = createControllerHarness(false);
        await startReadyPlayback(harness, false);
        const firstFrame = createDecodedFrame(secondsToMicroseconds(5));
        const secondFrame = createDecodedFrame(millisecondsToMicroseconds(5_040));
        const thirdFrame = createDecodedFrame(millisecondsToMicroseconds(5_080));
        harness.videoDecodeSession.queueFrame(firstFrame);
        harness.videoDecodeSession.queueFrame(secondFrame);
        harness.videoDecodeSession.queueFrame(thirdFrame);

        expect(harness.controller.takeCurrentFrame()).toBe(firstFrame);
        expect(harness.controller.notifyFramePresented(firstFrame)).toBe(true);
        harness.setMonotonicTime(millisecondsToMicroseconds(10_016));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_032));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_040));
        expect(harness.controller.takeCurrentFrame()).toBe(secondFrame);
        expect(harness.controller.notifyFramePresented(secondFrame)).toBe(true);
        harness.setMonotonicTime(millisecondsToMicroseconds(10_056));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_080));
        expect(harness.controller.takeCurrentFrame()).toBe(thirdFrame);
        expect(harness.controller.notifyFramePresented(thirdFrame)).toBe(true);

        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(0);
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(1);
        await harness.controller.destroy();
    });

    it('debounces a short empty raw-frame handoff below the starvation grace', async () => {
        const harness = createControllerHarness(false);
        await startReadyPlayback(harness, false);
        const firstFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(firstFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(firstFrame);
        expect(harness.controller.notifyFramePresented(firstFrame)).toBe(true);

        for (const elapsedMilliseconds of [ 16, 32, 64, 96 ]) {
            harness.setMonotonicTime(millisecondsToMicroseconds(10_000 + elapsedMilliseconds));
            expect(harness.controller.takeCurrentFrame()).toBeNull();
        }
        const nextFrame = createDecodedFrame(millisecondsToMicroseconds(5_080));
        harness.videoDecodeSession.queueFrame(nextFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(nextFrame);
        expect(harness.controller.notifyFramePresented(nextFrame)).toBe(true);

        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(0);
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(1);
        await harness.controller.destroy();
    });

    it('does not report playback recovery until overlapping video and audio waits clear', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);

        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_100));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.audioOutput?.emitTelemetry(
            millisecondsToMicroseconds(5_100),
            undefined,
            { reason: 'underflow' }
        );
        expect(harness.events.filter(event => event.type === 'waiting')).toHaveLength(2);

        const recoveredVideoFrame = createDecodedFrame(millisecondsToMicroseconds(5_100));
        harness.videoDecodeSession.queueFrame(recoveredVideoFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(recoveredVideoFrame);
        expect(harness.controller.notifyFramePresented(recoveredVideoFrame)).toBe(true);
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(1);

        harness.audioOutput?.emitTelemetry(
            millisecondsToMicroseconds(5_120),
            undefined,
            { reason: 'underflow-recovered' }
        );
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(2);
        await harness.controller.destroy();
    });

    it('does not count user-paused time toward video starvation', async () => {
        const harness = createControllerHarness(false);
        await startReadyPlayback(harness, false);

        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_050));
        harness.controller.pause();
        harness.setMonotonicTime(secondsToMicroseconds(12));
        harness.controller.resume();
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(12_099));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(0);
        harness.setMonotonicTime(millisecondsToMicroseconds(12_100));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(1);
        await harness.controller.destroy();
    });

    it('holds the final frame without video starvation while audio drains', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(harness, true);
        harness.audioBridge.setPendingFrameCount(1_024);
        harness.videoDecodeSession.emit({ generation, type: 'ended' });

        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_500));
        expect(harness.controller.takeCurrentFrame()).toBeNull();

        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(0);
        await harness.controller.destroy();
    });

    it('waits for submitted video and consumed audio before emitting ended', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(harness, true);
        const firstFrame = createDecodedFrame(secondsToMicroseconds(5));
        const finalFrame = createDecodedFrame(secondsToMicroseconds(5.04));
        harness.videoDecodeSession.queueFrame(firstFrame);
        harness.videoDecodeSession.queueFrame(finalFrame);
        harness.audioBridge.setPendingFrameCount(2_048);
        harness.audioBridge.setSubmittedEndMediaTimeMicroseconds(
            secondsToMicroseconds(5.08)
        );

        harness.videoDecodeSession.emit({ generation, type: 'ended' });

        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.events.filter(event => event.type === 'ended')).toHaveLength(0);
        expect(harness.audioOutput?.setPlaying).toHaveBeenLastCalledWith(true);
        expect(harness.controller.takeCurrentFrame()).toBe(firstFrame);
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.controller.notifyFramePresented(firstFrame)).toBe(true);

        harness.audioOutput?.emitTelemetry(secondsToMicroseconds(5.04));
        expect(harness.controller.takeCurrentFrame()).toBe(finalFrame);
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.controller.notifyFramePresented(finalFrame)).toBe(true);
        expect(harness.controller.playbackState).toBe('playing');

        harness.audioBridge.setPendingFrameCount(0);
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.08),
            undefined,
            { queuedFrames: 0 }
        );
        expect(harness.controller.playbackState).toBe('ended');
        expect(harness.events.filter(event => event.type === 'ended')).toEqual([
            { generation, type: 'ended' }
        ]);
        expect(harness.audioOutput?.setPlaying).toHaveBeenLastCalledWith(false);
        expect(firstFrame.frame.close).not.toHaveBeenCalled();
        expect(finalFrame.frame.close).not.toHaveBeenCalled();
    });

    it('recovers a pre-EOF underflow and waits for correlated physical audio tail output', async () => {
        const harness = createControllerHarness(true, {
            playbackStallTimeoutMicroseconds: millisecondsToMicroseconds(100)
        });
        const generation = await startReadyPlayback(harness, true);
        const finalFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(finalFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(finalFrame);
        expect(harness.controller.notifyFramePresented(finalFrame)).toBe(true);
        harness.audioBridge.setSubmittedEndMediaTimeMicroseconds(
            secondsToMicroseconds(5.12)
        );

        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.04),
            undefined,
            { queuedFrames: 0, reason: 'underflow' }
        );
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'audio-buffer')).toHaveLength(1);

        harness.videoDecodeSession.emit({ generation, type: 'ended' });
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(2);

        harness.setMonotonicTime(secondsToMicroseconds(11));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.fallbackRequests).toHaveLength(0);

        harness.audioOutput?.emitTelemetry(
            requireMicroseconds(5_119_999),
            undefined,
            { queuedFrames: 0 }
        );
        expect(harness.controller.playbackState).toBe('playing');
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.12),
            undefined,
            { queuedFrames: 0 }
        );

        expect(harness.controller.playbackState).toBe('ended');
        expect(harness.events.filter(event => event.type === 'ended')).toEqual([ {
            generation,
            type: 'ended'
        } ]);
        expect(harness.fallbackRequests).toHaveLength(0);
    });

    it('continues the presentation clock through a video tail after physical audio drains', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(harness, true);
        const finalFrame = createDecodedFrame(
            secondsToMicroseconds(5.12),
            millisecondsToMicroseconds(40)
        );
        harness.videoDecodeSession.queueFrame(finalFrame);
        harness.audioBridge.setSubmittedEndMediaTimeMicroseconds(
            secondsToMicroseconds(5.08)
        );
        harness.videoDecodeSession.emit({ generation, type: 'ended' });

        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.04),
            undefined,
            { queuedFrames: 0, reason: 'underflow' }
        );
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.08),
            undefined,
            { queuedFrames: 0 }
        );
        expect(harness.controller.playbackState).toBe('playing');

        harness.setMonotonicTime(millisecondsToMicroseconds(10_030));
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.08),
            undefined,
            { queuedFrames: 0, reason: 'periodic' }
        );
        harness.setMonotonicTime(millisecondsToMicroseconds(10_040));
        expect(harness.controller.takeCurrentFrame()).toBe(finalFrame);
        expect(harness.controller.notifyFramePresented(finalFrame)).toBe(true);
        expect(harness.controller.playbackState).toBe('playing');

        harness.setMonotonicTime(millisecondsToMicroseconds(10_080));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('ended');
        expect(harness.fallbackRequests).toHaveLength(0);
    });

    it('uses a bounded latency-based grace when physical output correlation is unavailable', async () => {
        const harness = createControllerHarness(true, {
            playbackStallTimeoutMicroseconds: millisecondsToMicroseconds(100)
        });
        const generation = await startReadyPlayback(harness, true);
        const finalFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(finalFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(finalFrame);
        expect(harness.controller.notifyFramePresented(finalFrame)).toBe(true);
        harness.audioBridge.setSubmittedEndMediaTimeMicroseconds(
            secondsToMicroseconds(5.08)
        );
        harness.audioOutput?.setEstimatedOutputLatencyMicroseconds(
            millisecondsToMicroseconds(50)
        );
        harness.videoDecodeSession.emit({ generation, type: 'ended' });
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.08),
            undefined,
            {
                hasPhysicalOutputTimeCorrelation: false,
                queuedFrames: 0,
                reason: 'underflow'
            }
        );

        harness.setMonotonicTime(millisecondsToMicroseconds(10_149));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.fallbackRequests).toHaveLength(0);

        harness.setMonotonicTime(millisecondsToMicroseconds(10_150));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('ended');
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'audio-buffer')).toHaveLength(0);
        expect(harness.fallbackRequests).toHaveLength(0);
    });

    it('requires an exact presenter acknowledgment before video-only ended', async () => {
        const harness = createControllerHarness(false);
        const generation = await startReadyPlayback(harness, false);
        const finalFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(finalFrame);
        harness.videoDecodeSession.emit({ generation, type: 'ended' });

        expect(harness.controller.takeCurrentFrame()).toBe(finalFrame);
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.controller.notifyFramePresented(
            createDecodedFrame(secondsToMicroseconds(5))
        )).toBe(false);
        expect(harness.controller.playbackState).toBe('playing');

        expect(harness.controller.notifyFramePresented(finalFrame)).toBe(true);
        expect(harness.videoDecodeSession.acknowledgeFrame).toHaveBeenCalledWith(finalFrame);
        expect(harness.controller.playbackState).toBe('playing');
        harness.setMonotonicTime(millisecondsToMicroseconds(10_039));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('playing');
        harness.setMonotonicTime(millisecondsToMicroseconds(10_040));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('ended');
        expect(harness.events.filter(event => event.type === 'ended')).toEqual([
            { generation, type: 'ended' }
        ]);
    });

    it('holds a submitted final frame when the decoder ends after its acknowledgment', async () => {
        const harness = createControllerHarness(false);
        const generation = await startReadyPlayback(harness, false);
        const finalFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(finalFrame);

        expect(harness.controller.takeCurrentFrame()).toBe(finalFrame);
        expect(harness.controller.notifyFramePresented(finalFrame)).toBe(true);
        harness.videoDecodeSession.emit({ generation, type: 'ended' });
        expect(harness.controller.playbackState).toBe('playing');

        harness.setMonotonicTime(millisecondsToMicroseconds(10_040));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('ended');
        expect(harness.events.filter(event => event.type === 'ended')).toEqual([
            { generation, type: 'ended' }
        ]);
    });

    it.each([
        {
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            label: '24 fps'
        },
        {
            durationMicroseconds: secondsToMicroseconds(2),
            label: 'long VFR still'
        }
    ])('holds a $label final frame for its complete duration', async ({
        durationMicroseconds
    }) => {
        const harness = createControllerHarness(false);
        const generation = await startReadyPlayback(harness, false);
        const finalFrame = createDecodedFrame(
            secondsToMicroseconds(5),
            durationMicroseconds
        );
        harness.videoDecodeSession.queueFrame(finalFrame);
        harness.videoDecodeSession.emit({ generation, type: 'ended' });

        expect(harness.controller.takeCurrentFrame()).toBe(finalFrame);
        expect(harness.controller.notifyFramePresented(finalFrame)).toBe(true);
        harness.setMonotonicTime(
            addMicroseconds(
                secondsToMicroseconds(10),
                addMicroseconds(durationMicroseconds, millisecondsToMicroseconds(-0.001))
            )
        );
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('playing');

        harness.setMonotonicTime(addMicroseconds(
            secondsToMicroseconds(10),
            durationMicroseconds
        ));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('ended');
    });

    it('does not invent a hold duration for a zero-duration final frame', async () => {
        const harness = createControllerHarness(false);
        const generation = await startReadyPlayback(harness, false);
        const finalFrame = createDecodedFrame(
            secondsToMicroseconds(5),
            secondsToMicroseconds(0)
        );
        harness.videoDecodeSession.queueFrame(finalFrame);
        harness.videoDecodeSession.emit({ generation, type: 'ended' });

        expect(harness.controller.takeCurrentFrame()).toBe(finalFrame);
        expect(harness.controller.notifyFramePresented(finalFrame)).toBe(true);
        expect(harness.controller.playbackState).toBe('ended');
    });

    it('releases a discarded presentation frame and completes end drain', async () => {
        const harness = createControllerHarness(false);
        const generation = await startReadyPlayback(harness, false);
        const finalFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(finalFrame);
        harness.videoDecodeSession.emit({ generation, type: 'ended' });

        expect(harness.controller.takeCurrentFrame()).toBe(finalFrame);
        expect(harness.controller.notifyFrameDiscarded(finalFrame)).toBe(true);
        expect(harness.videoDecodeSession.discardFrame).toHaveBeenCalledWith(finalFrame);
        expect(harness.controller.playbackState).toBe('playing');
        harness.setMonotonicTime(millisecondsToMicroseconds(10_040));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('ended');
        expect(harness.controller.notifyFrameDiscarded(finalFrame)).toBe(false);
    });

    it('invalidates a pending end drain when seeking to a new generation', async () => {
        const harness = createControllerHarness(false);
        const firstGeneration = await startReadyPlayback(harness, false);
        const staleFinalFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(staleFinalFrame);
        harness.videoDecodeSession.emit({ generation: firstGeneration, type: 'ended' });
        expect(harness.controller.takeCurrentFrame()).toBe(staleFinalFrame);

        const seekPromise = harness.controller.seek(secondsToMicroseconds(42));
        await flushAsyncWork();
        const secondGeneration = harness.videoDecodeSession.starts.at(-1)?.generation;
        if (!secondGeneration) {
            throw new Error('Seek generation did not start');
        }
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'avc1.640028',
            generation: secondGeneration,
            type: 'ready'
        });
        await seekPromise;

        harness.videoDecodeSession.emit({ generation: firstGeneration, type: 'ended' });
        expect(harness.controller.notifyFramePresented(staleFinalFrame)).toBe(false);
        expect(staleFinalFrame.frame.close).not.toHaveBeenCalled();
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.events.filter(event => event.type === 'ended')).toHaveLength(0);
        expect(harness.controller.getTelemetry().staleEventCount).toBe(1);
    });

    it('invalidates a transferred final frame when playback stops', async () => {
        const harness = createControllerHarness(false);
        const generation = await startReadyPlayback(harness, false);
        const staleFinalFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(staleFinalFrame);
        harness.videoDecodeSession.emit({ generation, type: 'ended' });
        expect(harness.controller.takeCurrentFrame()).toBe(staleFinalFrame);

        await harness.controller.destroy();

        expect(harness.controller.notifyFramePresented(staleFinalFrame)).toBe(false);
        expect(harness.controller.playbackState).toBe('idle');
        expect(harness.events.filter(event => event.type === 'ended')).toHaveLength(0);
    });

    it('invalidates drain and audio starvation when fallback activates', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(harness, true);
        const staleFinalFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(staleFinalFrame);
        harness.videoDecodeSession.emit({ generation, type: 'ended' });
        expect(harness.controller.takeCurrentFrame()).toBe(staleFinalFrame);
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5),
            undefined,
            { reason: 'underflow' }
        );

        expect(harness.controller.setPlaybackRate(2)).toBe(false);
        expect(harness.controller.notifyFramePresented(staleFinalFrame)).toBe(false);
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(6),
            undefined,
            { reason: 'underflow-recovered' }
        );
        expect(harness.controller.playbackState).toBe('fallback');
        expect(harness.events.filter(event => event.type === 'ended')).toHaveLength(0);
        expect(harness.fallbackRequests).toHaveLength(1);
    });

    it('seeks by generation and ignores stale decoder events', async () => {
        const harness = createControllerHarness(false);
        const firstGeneration = await startReadyPlayback(harness, false);
        harness.controller.pause();

        const seekPromise = harness.controller.seek(secondsToMicroseconds(42));
        await flushAsyncWork();
        const secondGeneration = harness.videoDecodeSession.starts.at(-1)?.generation;
        expect(secondGeneration).toBeGreaterThan(firstGeneration);
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'avc1.640028',
            generation: firstGeneration,
            type: 'ready'
        });
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'avc1.640028',
            generation: secondGeneration as number,
            type: 'ready'
        });

        await expect(seekPromise).resolves.toMatchObject({
            generation: secondGeneration,
            status: 'started'
        });
        expect(harness.controller.playbackState).toBe('paused');
        expect(harness.controller.currentTimeMicroseconds).toBe(42_000_000);
        expect(harness.controller.getTelemetry().staleEventCount).toBe(1);
    });

    it('does not let delayed seek preparation stop the latest generation', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        const delayedAudioSuspension = createDeferred<void>();
        harness.audioOutput.setPlaying.mockImplementationOnce(
            (): Promise<void> => delayedAudioSuspension.promise
        );

        const firstSeek = harness.controller.seek(secondsToMicroseconds(10));
        const secondSeek = harness.controller.seek(secondsToMicroseconds(20));
        await flushAsyncWork();
        const latestGeneration = harness.videoDecodeSession.starts.at(-1)?.generation;
        if (!latestGeneration) {
            throw new Error('Latest seek generation did not start');
        }
        expect(harness.videoDecodeSession.starts.at(-1)?.startTimeMicroseconds)
            .toBe(secondsToMicroseconds(20));
        const stopCallCount = harness.videoDecodeSession.stop.mock.calls.length;

        delayedAudioSuspension.resolve(undefined);
        await flushAsyncWork();
        expect(harness.videoDecodeSession.stop).toHaveBeenCalledTimes(stopCallCount);

        const audioConfiguration: DecodeWorkerAudioConfiguration = {
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        };
        await harness.videoDecodeSession.prepareAudio(audioConfiguration);
        harness.audioBridge.activate(latestGeneration, harness.audioOutput.generation);
        harness.videoDecodeSession.emit({
            audio: audioConfiguration,
            codec: 'avc1.640028',
            generation: latestGeneration,
            type: 'ready'
        });

        await expect(firstSeek).resolves.toMatchObject({ status: 'superseded' });
        await expect(secondSeek).resolves.toMatchObject({
            generation: latestGeneration,
            status: 'started'
        });
        await harness.controller.destroy();
    });

    it('switches audio tracks by restarting generations at the audio-master time', async () => {
        const harness = createControllerHarness(true);
        const firstGeneration = await startReadyPlayback(harness, true);
        expect(harness.controller.canSetAudioStreamIndex()).toBe(true);
        harness.audioOutput?.emitTelemetry(secondsToMicroseconds(33));

        const switchPromise = harness.controller.setAudioStreamIndex(4);
        await flushAsyncWork();
        const secondGeneration = harness.videoDecodeSession.starts.at(-1)?.generation;
        expect(secondGeneration).toBeGreaterThan(firstGeneration);
        expect(harness.videoDecodeSession.starts.at(-1)).toMatchObject({
            audioTrackIndex: 4,
            generation: secondGeneration,
            startTimeMicroseconds: 33_000_000
        });
        const audioConfiguration: DecodeWorkerAudioConfiguration = {
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        };
        await harness.videoDecodeSession.prepareAudio(audioConfiguration);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        harness.audioBridge.activate(secondGeneration as number, harness.audioOutput.generation);
        harness.videoDecodeSession.emit({
            audio: audioConfiguration,
            codec: 'avc1.640028',
            generation: secondGeneration as number,
            type: 'ready'
        });
        await expect(switchPromise).resolves.toMatchObject({
            generation: secondGeneration,
            status: 'started'
        });
        expect(harness.controller.playbackState).toBe('playing');

        // A later restart keeps the switched track
        const seekPromise = harness.controller.seek(secondsToMicroseconds(40));
        await flushAsyncWork();
        expect(harness.videoDecodeSession.starts.at(-1)).toMatchObject({
            audioTrackIndex: 4,
            startTimeMicroseconds: 40_000_000
        });
        await harness.controller.destroy();
        await expect(seekPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it('switches between decoded PCM and owned native media audio routes', async () => {
        const nativeAudioBridgeFactory = (
            vi.fn() as unknown as CustomDecodeNativeAudioBridgeFactory
        );
        const harness = createControllerHarness(true, { nativeAudioBridgeFactory });
        const firstGeneration = await startReadyPlayback(harness, true);
        harness.audioOutput?.emitTelemetry(secondsToMicroseconds(33));

        const nativeSwitchPromise = harness.controller.setAudioStreamIndex(4, 'native-media');
        await flushAsyncWork();
        const nativeGeneration = harness.videoDecodeSession.starts.at(-1)?.generation;
        if (!nativeGeneration) {
            throw new Error('Native audio switch generation did not start');
        }
        expect(nativeGeneration).toBeGreaterThan(firstGeneration);
        expect(harness.videoDecodeSession.starts.at(-1)).toMatchObject({
            audioOutputMode: 'native-media',
            audioTrackIndex: 4,
            startTimeMicroseconds: secondsToMicroseconds(33)
        });
        harness.videoDecodeSession.emit({
            audio: {
                channelCount: 6,
                codec: 'ec-3',
                mimeType: 'audio/mp4; codecs="ec-3"',
                outputMode: 'native-media',
                sampleRate: 48_000
            },
            codec: 'hvc1.2.4.L153.B0',
            generation: nativeGeneration,
            type: 'ready'
        });
        await expect(nativeSwitchPromise).resolves.toMatchObject({
            generation: nativeGeneration,
            status: 'started'
        });

        harness.videoDecodeSession.setNativeAudioTimeMicroseconds(secondsToMicroseconds(44));
        const decodedSwitchPromise = harness.controller.setAudioStreamIndex(5, 'decoded-pcm');
        await flushAsyncWork();
        const decodedGeneration = harness.videoDecodeSession.starts.at(-1)?.generation;
        if (!decodedGeneration) {
            throw new Error('Decoded audio switch generation did not start');
        }
        expect(decodedGeneration).toBeGreaterThan(nativeGeneration);
        expect(harness.videoDecodeSession.starts.at(-1)).toMatchObject({
            audioOutputMode: 'decoded-pcm',
            audioTrackIndex: 5,
            startTimeMicroseconds: secondsToMicroseconds(44)
        });
        const audioConfiguration: DecodeWorkerAudioConfiguration = {
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        };
        await harness.videoDecodeSession.prepareAudio(audioConfiguration);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        harness.audioBridge.activate(decodedGeneration, harness.audioOutput.generation);
        harness.videoDecodeSession.emit({
            audio: audioConfiguration,
            codec: 'avc1.640028',
            generation: decodedGeneration,
            type: 'ready'
        });
        await expect(decodedSwitchPromise).resolves.toMatchObject({
            generation: decodedGeneration,
            status: 'started'
        });
    });

    it('requests same-session HTML fallback when custom audio is unavailable', async () => {
        const harness = createControllerHarness(false);
        const result = await harness.controller.play(createPlayOptions(0));

        expect(result).toMatchObject({
            fallbackReason: 'audio-output-unavailable',
            status: 'fallback'
        });
        expect(harness.fallbackRequests).toEqual([ {
            disposition: 'same-session-native',
            generation: result.generation,
            mediaTimeMicroseconds: 5_000_000,
            preserveHTMLSession: true,
            reason: 'audio-output-unavailable'
        } ]);
        expect(harness.videoDecodeSession.starts).toHaveLength(0);
        expect(harness.controller.playbackState).toBe('fallback');
    });

    it('forwards static HDR metadata before playback becomes ready', async () => {
        const harness = createControllerHarness(false);
        const startPromise = harness.controller.play(createPlayOptions());
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts[0]?.generation;
        if (!generation) {
            throw new Error('Video decode did not start');
        }
        const staticHDRMetadata = {
            masteringDisplayMaximumLuminanceNits: 4_000,
            masteringDisplayMinimumLuminanceNits: 0.005,
            maximumContentLightLevelNits: 500,
            maximumFrameAverageLightLevelNits: 200
        };
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            generation,
            staticHDRMetadata,
            type: 'configured'
        });
        expect(harness.events.filter(event => event.type === 'static-hdr-metadata'))
            .toEqual([ {
                generation,
                metadata: staticHDRMetadata,
                type: 'static-hdr-metadata'
            } ]);
        expect(harness.events.some(event => event.type === 'ready')).toBe(false);

        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            generation,
            staticHDRMetadata,
            type: 'ready'
        });
        await expect(startPromise).resolves.toMatchObject({
            generation,
            status: 'started'
        });
    });

    it('keeps configured-without-media startup bounded and latches one fallback request', async () => {
        vi.useFakeTimers();
        try {
            const harness = createControllerHarness(false);
            const startPromise = harness.controller.play(createPlayOptions());
            await flushAsyncWork();
            const generation = harness.videoDecodeSession.starts[0].generation;
            harness.videoDecodeSession.emit({
                audio: null,
                codec: 'avc1.640028',
                generation,
                type: 'configured'
            });
            expect(harness.controller.playbackState).toBe('starting');
            await vi.advanceTimersByTimeAsync(100);

            await expect(startPromise).resolves.toMatchObject({
                fallbackReason: 'startup-timeout',
                status: 'fallback'
            });
            expect(harness.fallbackRequests).toHaveLength(1);
            expect(harness.fallbackRequests[0]).toMatchObject({
                disposition: 'renegotiate-source',
                reason: 'startup-timeout'
            });

            harness.videoDecodeSession.emit({
                failureKind: 'decode-failed',
                generation,
                message: 'late failure',
                type: 'error'
            });
            expect(harness.fallbackRequests).toHaveLength(1);
            expect(harness.controller.getTelemetry().staleEventCount).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('falls back when rate-adjusted audio is not implemented', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);

        expect(harness.controller.setPlaybackRate(2)).toBe(false);
        expect(harness.fallbackRequests[0]).toMatchObject({
            disposition: 'same-session-native',
            preserveHTMLSession: true,
            reason: 'playback-rate-unsupported'
        });
        expect(harness.controller.playbackState).toBe('fallback');
    });

    it.each([
        [ 'decode-failed', 'renegotiate-source' ],
        [ 'network-failed', 'renegotiate-source' ],
        [ 'range-unsupported', 'renegotiate-source' ],
        [ 'source-unsupported', 'renegotiate-source' ],
        [ 'audio-output-failed', 'same-session-native' ]
    ] as const)(
        'preserves worker failure %s and assigns %s fallback',
        async (failureKind, disposition) => {
            const harness = createControllerHarness(false);
            const startPromise = harness.controller.play(createPlayOptions());
            await flushAsyncWork();
            const generation = harness.videoDecodeSession.starts[0].generation;

            harness.videoDecodeSession.emit({
                failureKind,
                generation,
                message: `simulated ${failureKind}`,
                type: 'error'
            });

            await expect(startPromise).resolves.toMatchObject({
                fallbackReason: failureKind,
                status: 'fallback'
            });
            expect(harness.fallbackRequests).toEqual([ expect.objectContaining({
                disposition,
                generation,
                reason: failureKind
            }) ]);
        }
    );

    it('latches a recoverable decode fallback and leaves owned audio stopped', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(harness, true);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        const decodeFailure: CustomDecodeSessionEvent = {
            failureKind: 'decode-failed',
            generation,
            message: 'simulated bounded decode failure',
            type: 'error'
        };

        harness.videoDecodeSession.emit(decodeFailure);
        await flushAsyncWork();
        harness.videoDecodeSession.emit(decodeFailure);
        await flushAsyncWork();

        expect(harness.fallbackRequests).toHaveLength(1);
        expect(harness.events.filter(event => event.type === 'error')).toEqual([{
            generation,
            message: 'simulated bounded decode failure',
            recoverable: true,
            type: 'error'
        }]);
        expect(harness.audioOutput.setPlaying).toHaveBeenLastCalledWith(false);

        await harness.controller.destroy();
        expect(harness.audioOutput.destroy).toHaveBeenCalledOnce();
        expect(harness.audioOutput.setPlaying).toHaveBeenLastCalledWith(false);
    });

    it('does not finish startup until asynchronous audio playback starts', async () => {
        const harness = createControllerHarness(true);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        const playbackStarted = createDeferred<void>();
        harness.audioOutput.setPlaying.mockImplementation((playing: boolean) => (
            playing ? playbackStarted.promise : undefined
        ));

        const startPromise = harness.controller.play(createPlayOptions(1));
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts[0].generation;
        const audioConfiguration: DecodeWorkerAudioConfiguration = {
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        };
        await harness.videoDecodeSession.prepareAudio(audioConfiguration);
        harness.audioBridge.activate(generation, harness.audioOutput.generation);
        harness.videoDecodeSession.emit({
            audio: audioConfiguration,
            codec: 'avc1.640028',
            generation,
            type: 'ready'
        });
        await flushAsyncWork();

        expect(harness.controller.playbackState).toBe('starting');
        expect(harness.events.filter(event => event.type === 'ready')).toHaveLength(0);
        playbackStarted.resolve(undefined);
        await expect(startPromise).resolves.toEqual({
            fallbackReason: null,
            generation,
            status: 'started'
        });
        expect(harness.controller.playbackState).toBe('playing');
    });

    it('rejects an unmeasured decoder layout before invoking the audio output factory', async () => {
        const harness = createControllerHarness(true);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        const startPromise = harness.controller.play(createPlayOptions(1));
        await flushAsyncWork();

        await expect(harness.videoDecodeSession.prepareAudio({
            channelCount: 7,
            codec: 'ac3',
            sampleRate: 48_000
        })).rejects.toThrow('Custom audio output requires 2, 6, or 8 channels at 48000 Hz');
        expect(harness.audioOutput.setVolume).not.toHaveBeenCalled();
        expect(harness.audioOutput.setMuted).not.toHaveBeenCalled();

        await harness.controller.destroy();
        await expect(startPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it('latches one fallback when asynchronous audio startup fails', async () => {
        const harness = createControllerHarness(true);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        harness.audioOutput.setPlaying.mockImplementation((playing: boolean) => (
            playing ? Promise.reject(new Error('AudioContext resume failed')) : undefined
        ));

        const startPromise = harness.controller.play(createPlayOptions(1));
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts[0].generation;
        const audioConfiguration: DecodeWorkerAudioConfiguration = {
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        };
        await harness.videoDecodeSession.prepareAudio(audioConfiguration);
        harness.audioBridge.activate(generation, harness.audioOutput.generation);
        harness.videoDecodeSession.emit({
            audio: audioConfiguration,
            codec: 'avc1.640028',
            generation,
            type: 'ready'
        });

        await expect(startPromise).resolves.toEqual({
            fallbackReason: 'audio-output-failed',
            generation,
            status: 'fallback'
        });
        expect(harness.fallbackRequests).toHaveLength(1);
        expect(harness.controller.playbackState).toBe('fallback');
    });

    it('requests one fallback when asynchronous audio resume fails', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }

        harness.controller.pause();
        await flushAsyncWork();
        harness.audioOutput.setPlaying.mockImplementationOnce(
            (): Promise<void> => Promise.reject(new Error('AudioContext resume failed'))
        );
        harness.controller.resume();
        await flushAsyncWork();

        expect(harness.fallbackRequests).toHaveLength(1);
        expect(harness.fallbackRequests[0].reason).toBe('audio-output-failed');
        expect(harness.controller.playbackState).toBe('fallback');
    });

    it('waits for asynchronous audio destruction and records close failure', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        const outputDestroyed = createDeferred<void>();
        harness.audioOutput.destroy.mockReturnValueOnce(outputDestroyed.promise);

        let destroySettled = false;
        const destroyPromise = harness.controller.destroy().then((): void => {
            destroySettled = true;
        });
        await flushAsyncWork();
        expect(harness.audioOutput.destroy).toHaveBeenCalledTimes(1);
        expect(destroySettled).toBe(false);
        outputDestroyed.reject(new Error('AudioContext close failed'));

        await expect(destroyPromise).resolves.toBeUndefined();
        expect(harness.controller.getTelemetry().lastErrorMessage).toContain(
            'AudioContext close failed'
        );
    });

    it('bounds stalled audio destruction', async () => {
        vi.useFakeTimers();
        try {
            const harness = createControllerHarness(true);
            await startReadyPlayback(harness, true);
            if (!harness.audioOutput) {
                throw new Error('Expected an audio output');
            }
            harness.audioOutput.destroy.mockReturnValueOnce(
                new Promise<void>(() => undefined)
            );
            const destroyPromise = harness.controller.destroy();

            await vi.advanceTimersByTimeAsync(100);

            await expect(destroyPromise).resolves.toBeUndefined();
            expect(harness.audioOutput.destroy).toHaveBeenCalledOnce();
            expect(harness.controller.getTelemetry().lastErrorMessage).toContain(
                'Custom audio output destruction exceeded its bound'
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('bounds stalled audio suspension while stopping the decode pipeline', async () => {
        vi.useFakeTimers();
        try {
            const harness = createControllerHarness(true);
            await startReadyPlayback(harness, true);
            if (!harness.audioOutput) {
                throw new Error('Expected an audio output');
            }
            harness.audioOutput.setPlaying.mockImplementation((playing: boolean) => (
                playing ? undefined : new Promise<void>(() => undefined)
            ));

            const destroyPromise = harness.controller.destroy();
            expect(harness.videoDecodeSession.stop).toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(100);

            await expect(destroyPromise).resolves.toBeUndefined();
            expect(harness.controller.getTelemetry().lastErrorMessage).toContain(
                'Custom playback shutdown exceeded its bound'
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('bounds an unresolved audio suspension before preparing a replacement generation', async () => {
        vi.useFakeTimers();
        try {
            const harness = createControllerHarness(true, {
                startupTimeoutMicroseconds: millisecondsToMicroseconds(200)
            });
            await startReadyPlayback(harness, true);
            if (!harness.audioOutput) {
                throw new Error('Expected an audio output');
            }
            harness.audioOutput.setPlaying.mockImplementation((playing: boolean) => (
                playing ? undefined : new Promise<void>(() => undefined)
            ));

            const seekPromise = harness.controller.seek(secondsToMicroseconds(42));
            await vi.advanceTimersByTimeAsync(100);

            await expect(seekPromise).resolves.toMatchObject({
                fallbackReason: 'audio-output-failed',
                status: 'fallback'
            });
            expect(harness.controller.getTelemetry().lastErrorMessage).toContain(
                'Custom audio suspension exceeded its bound'
            );
            expect(harness.fallbackRequests).toEqual([ expect.objectContaining({
                reason: 'audio-output-failed'
            }) ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('bounds an unresolved initial audio suspension and destroys the rejected binding', async () => {
        vi.useFakeTimers();
        try {
            const harness = createControllerHarness(true, {
                startupTimeoutMicroseconds: millisecondsToMicroseconds(200)
            });
            if (!harness.audioOutput) {
                throw new Error('Expected an audio output');
            }
            harness.audioOutput.setPlaying.mockImplementation((playing: boolean) => (
                playing ? undefined : new Promise<void>(() => undefined)
            ));
            const startPromise = harness.controller.play(createPlayOptions(1));
            await flushAsyncWork();
            const audioPreparation = harness.videoDecodeSession.prepareAudio({
                channelCount: 2,
                codec: 'opus',
                sampleRate: 48_000
            });
            const audioPreparationRejection = expect(audioPreparation).rejects.toThrow(
                'Custom audio initialization suspension exceeded its bound'
            );

            await vi.advanceTimersByTimeAsync(100);

            await audioPreparationRejection;
            expect(harness.audioOutput.destroy).toHaveBeenCalledOnce();
            const destroyPromise = harness.controller.destroy();
            await vi.advanceTimersByTimeAsync(100);
            await expect(destroyPromise).resolves.toBeUndefined();
            await expect(startPromise).resolves.toMatchObject({ status: 'stopped' });
        } finally {
            vi.useRealTimers();
        }
    });

    it('settles destruction and asynchronously releases an audio factory that outlives it', async () => {
        const audioOutput = new FakeAudioOutput();
        const audioBridge = new FakeAudioBridge(audioOutput.generation);
        const audioConfiguration: DecodeWorkerAudioConfiguration = {
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        };
        const factoryResult = createDeferred<CustomAudioOutputBinding>();
        let videoDecodeSession: FakeVideoDecodeSession | null = null;
        const controller = new CustomPlaybackController({
            audioOutputFactory: (): Promise<CustomAudioOutputBinding> => factoryResult.promise,
            monotonicTimeSource: (): Microseconds => secondsToMicroseconds(10),
            pipelineStopTimeoutMicroseconds: millisecondsToMicroseconds(100),
            startupTimeoutMicroseconds: millisecondsToMicroseconds(100),
            videoDecodeSessionFactory: (eventHandler, audioBridgeFactory) => {
                videoDecodeSession = new FakeVideoDecodeSession(eventHandler, audioBridgeFactory);
                return videoDecodeSession;
            }
        });
        const startPromise = controller.play(createPlayOptions(1));
        await flushAsyncWork();
        if (!videoDecodeSession) {
            throw new Error('Expected a video decode session');
        }
        const audioPreparation = (
            videoDecodeSession as FakeVideoDecodeSession
        ).prepareAudio(audioConfiguration).catch((): null => null);
        await flushAsyncWork();

        let destroySettled = false;
        const destroyPromise = controller.destroy().then((): void => {
            destroySettled = true;
        });
        await flushAsyncWork();
        expect(destroySettled).toBe(true);

        factoryResult.resolve({
            bridge: audioBridge as unknown as CustomDecodeAudioBridge,
            configuration: audioConfiguration,
            output: audioOutput
        });
        await expect(audioPreparation).resolves.toBeNull();
        await expect(destroyPromise).resolves.toBeUndefined();
        await expect(startPromise).resolves.toMatchObject({ status: 'stopped' });
        await flushAsyncWork();
        expect(audioOutput.destroy).toHaveBeenCalledOnce();
    });

    it('settles an in-flight start exactly once when stopped', async () => {
        const harness = createControllerHarness(false);
        const startPromise = harness.controller.play(createPlayOptions());
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts[0].generation;

        const destroyPromise = harness.controller.destroy();
        await expect(startPromise).resolves.toEqual({
            fallbackReason: null,
            generation,
            status: 'stopped'
        });
        await destroyPromise;

        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'vp8',
            generation,
            type: 'ready'
        });
        expect(harness.controller.playbackState).toBe('idle');
        expect(harness.controller.getTelemetry().staleEventCount).toBe(1);
    });

    it('drains due video frames unpresented only while the page is hidden', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        const dueFrame = createDecodedFrame(secondsToMicroseconds(5));
        const futureFrame = createDecodedFrame(secondsToMicroseconds(6));
        harness.videoDecodeSession.queueFrame(dueFrame);
        harness.videoDecodeSession.queueFrame(futureFrame);

        harness.controller.drainBackgroundVideo();
        expect(harness.videoDecodeSession.takeFrame).not.toHaveBeenCalled();

        expect(harness.controller.setPageVisibility(false)).toBe(false);
        harness.setMonotonicTime(millisecondsToMicroseconds(10_500));
        harness.controller.drainBackgroundVideo();

        expect(harness.videoDecodeSession.takeFrame).toHaveBeenCalledWith(
            millisecondsToMicroseconds(5_500)
        );
        expect(harness.videoDecodeSession.discardFrame).toHaveBeenCalledWith(dueFrame);
        expect(dueFrame.frame.close).toHaveBeenCalledOnce();
        expect(futureFrame.frame.close).not.toHaveBeenCalled();
        expect(harness.controller.notifyFramePresented(dueFrame)).toBe(false);
        expect(harness.controller.getTelemetry()).toMatchObject({
            pageHidden: true,
            videoSuspended: false
        });

        expect(harness.controller.setPageVisibility(true)).toBe(false);
        harness.controller.drainBackgroundVideo();
        expect(harness.videoDecodeSession.takeFrame).toHaveBeenCalledOnce();
        harness.setMonotonicTime(secondsToMicroseconds(11));
        expect(harness.controller.takeCurrentFrame()).toBe(futureFrame);
        expect(harness.fallbackRequests).toHaveLength(0);
    });

    it('suspends hidden native video with audio once the suspension delay elapses', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        const suspensionTimeMicroseconds = addMicroseconds(
            secondsToMicroseconds(10),
            CUSTOM_PLAYBACK_BACKGROUND_VIDEO_SUSPENSION_DELAY_MICROSECONDS
        );
        expect(harness.controller.setPageVisibility(false)).toBe(false);
        harness.setMonotonicTime(secondsToMicroseconds(15));
        // A repeated hidden notification keeps the original hide time
        expect(harness.controller.setPageVisibility(false)).toBe(false);

        harness.setMonotonicTime(requireMicroseconds(suspensionTimeMicroseconds - 1));
        harness.controller.drainBackgroundVideo();
        expect(harness.videoDecodeSession.suspendVideo).not.toHaveBeenCalled();
        expect(harness.videoDecodeSession.takeFrame).toHaveBeenCalledOnce();

        harness.setMonotonicTime(suspensionTimeMicroseconds);
        harness.controller.drainBackgroundVideo();
        harness.setMonotonicTime(secondsToMicroseconds(25));
        harness.controller.drainBackgroundVideo();

        expect(harness.videoDecodeSession.suspendVideo).toHaveBeenCalledOnce();
        expect(harness.videoDecodeSession.takeFrame).toHaveBeenCalledOnce();
        expect(harness.controller.getTelemetry()).toMatchObject({
            pageHidden: true,
            videoResyncPending: false,
            videoSuspended: true
        });
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.audioOutput?.setPlaying).toHaveBeenLastCalledWith(true);
    });

    it.each([
        { label: 'bundled software video', videoDecoderBackend: 'bundled-hevc', withAudio: true },
        { label: 'native video without audio', videoDecoderBackend: 'native', withAudio: false }
    ] as const)('keeps draining hidden $label instead of suspending it', async ({
        videoDecoderBackend,
        withAudio
    }) => {
        const harness = createControllerHarness(withAudio);
        await startReadyPlayback(harness, withAudio, { videoDecoderBackend });
        harness.controller.setPageVisibility(false);
        const dueFrame = createDecodedFrame(secondsToMicroseconds(25));
        harness.videoDecodeSession.queueFrame(dueFrame);
        harness.setMonotonicTime(secondsToMicroseconds(30));

        harness.controller.drainBackgroundVideo();

        expect(harness.videoDecodeSession.suspendVideo).not.toHaveBeenCalled();
        expect(harness.videoDecodeSession.discardFrame).toHaveBeenCalledWith(dueFrame);
        expect(dueFrame.frame.close).toHaveBeenCalledOnce();
        expect(harness.controller.getTelemetry().videoSuspended).toBe(false);
    });

    it('resyncs suspended video at the returning clock and skips its late preroll', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(harness, true);
        harness.controller.setPageVisibility(false);
        harness.setMonotonicTime(secondsToMicroseconds(20));
        harness.controller.drainBackgroundVideo();
        expect(harness.controller.getTelemetry().videoSuspended).toBe(true);
        const stopCallCount = harness.videoDecodeSession.stop.mock.calls.length;
        harness.setMonotonicTime(secondsToMicroseconds(70));

        expect(harness.controller.setPageVisibility(true)).toBe(true);
        expect(harness.controller.setPageVisibility(true)).toBe(false);

        expect(harness.videoDecodeSession.resyncVideo).toHaveBeenCalledOnce();
        expect(harness.videoDecodeSession.resyncVideo).toHaveBeenCalledWith(
            secondsToMicroseconds(65)
        );
        // Audio and the clock continue; only video restarts
        expect(harness.videoDecodeSession.stop).toHaveBeenCalledTimes(stopCallCount);
        expect(harness.videoDecodeSession.starts).toHaveLength(1);
        expect(harness.audioOutput?.setPlaying).toHaveBeenLastCalledWith(true);
        expect(harness.controller.getTelemetry()).toMatchObject({
            activeGeneration: generation,
            currentTimeMicroseconds: secondsToMicroseconds(65),
            pageHidden: false,
            videoResyncPending: true,
            videoSuspended: false
        });

        const prerollFrame = createDecodedFrame(secondsToMicroseconds(64));
        harness.videoDecodeSession.queueFrame(prerollFrame);
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(prerollFrame.frame.close).toHaveBeenCalledOnce();
        expect(harness.controller.getTelemetry()).toMatchObject({
            discardedStaleVideoFrameCount: 1,
            videoResyncPending: false
        });

        const resyncedFrame = createDecodedFrame(secondsToMicroseconds(65));
        harness.videoDecodeSession.queueFrame(resyncedFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(resyncedFrame);
        expect(harness.controller.notifyFramePresented(resyncedFrame)).toBe(true);
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.fallbackRequests).toHaveLength(0);
    });

    it('resyncs video that fell beyond the lag bound while hidden without a suspension', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        harness.controller.setPageVisibility(false);
        const lateFrame = createDecodedFrame(secondsToMicroseconds(6));
        harness.videoDecodeSession.queueFrame(lateFrame);
        harness.setMonotonicTime(secondsToMicroseconds(14));
        harness.controller.drainBackgroundVideo();
        expect(lateFrame.frame.close).toHaveBeenCalledOnce();

        expect(harness.controller.setPageVisibility(true)).toBe(true);

        expect(harness.videoDecodeSession.suspendVideo).not.toHaveBeenCalled();
        expect(harness.videoDecodeSession.resyncVideo).toHaveBeenCalledOnce();
        expect(harness.videoDecodeSession.resyncVideo).toHaveBeenCalledWith(
            secondsToMicroseconds(9)
        );
        expect(harness.controller.getTelemetry()).toMatchObject({
            pageHidden: false,
            videoResyncPending: true,
            videoSuspended: false
        });
    });

    it('returns without a resync or catch-up when hidden decode kept pace', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        harness.controller.setPageVisibility(false);
        harness.videoDecodeSession.queueFrame(
            createDecodedFrame(millisecondsToMicroseconds(8_960))
        );
        harness.setMonotonicTime(secondsToMicroseconds(14));
        harness.controller.drainBackgroundVideo();

        expect(harness.controller.setPageVisibility(true)).toBe(false);

        expect(harness.videoDecodeSession.resyncVideo).not.toHaveBeenCalled();
        expect(harness.controller.getTelemetry()).toMatchObject({
            pageHidden: false,
            videoResyncPending: false,
            videoSuspended: false
        });
        // A frame 160 ms late would be dropped if catch-up had been armed
        harness.setMonotonicTime(millisecondsToMicroseconds(14_200));
        const nextFrame = createDecodedFrame(secondsToMicroseconds(9));
        harness.videoDecodeSession.queueFrame(nextFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(nextFrame);
        expect(harness.controller.getTelemetry().discardedStaleVideoFrameCount).toBe(0);
    });

    it('measures hidden decode lag from the end of a long still frame', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        harness.controller.setPageVisibility(false);
        // A variable frame rate still starts 3.5 s before the clock but still covers it
        harness.videoDecodeSession.queueFrame(createDecodedFrame(
            millisecondsToMicroseconds(5_500),
            secondsToMicroseconds(4)
        ));
        harness.setMonotonicTime(secondsToMicroseconds(14));
        harness.controller.drainBackgroundVideo();

        expect(harness.controller.setPageVisibility(true)).toBe(false);

        expect(harness.videoDecodeSession.resyncVideo).not.toHaveBeenCalled();
        harness.setMonotonicTime(millisecondsToMicroseconds(14_200));
        const nextFrame = createDecodedFrame(secondsToMicroseconds(9));
        harness.videoDecodeSession.queueFrame(nextFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(nextFrame);
        expect(harness.controller.getTelemetry().discardedStaleVideoFrameCount).toBe(0);
    });

    it('drops late frames after a short hidden backlog until video reaches the clock', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        harness.controller.setPageVisibility(false);
        harness.videoDecodeSession.queueFrame(
            createDecodedFrame(millisecondsToMicroseconds(5_500))
        );
        harness.setMonotonicTime(millisecondsToMicroseconds(10_500));
        harness.controller.drainBackgroundVideo();
        harness.setMonotonicTime(secondsToMicroseconds(11));

        expect(harness.controller.setPageVisibility(true)).toBe(false);
        expect(harness.videoDecodeSession.resyncVideo).not.toHaveBeenCalled();

        const lateFrame = createDecodedFrame(millisecondsToMicroseconds(5_540));
        harness.videoDecodeSession.queueFrame(lateFrame);
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.videoDecodeSession.discardFrame).toHaveBeenLastCalledWith(lateFrame);
        expect(lateFrame.frame.close).toHaveBeenCalledOnce();
        expect(harness.controller.notifyFramePresented(lateFrame)).toBe(false);
        expect(harness.controller.getTelemetry().discardedStaleVideoFrameCount).toBe(1);
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(1);

        // Ends exactly the catch-up tolerance behind the clock
        const toleratedFrame = createDecodedFrame(requireMicroseconds(
            secondsToMicroseconds(6)
                - CUSTOM_PLAYBACK_VIDEO_CATCH_UP_TOLERANCE_MICROSECONDS
                - millisecondsToMicroseconds(40)
        ));
        harness.videoDecodeSession.queueFrame(toleratedFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(toleratedFrame);
        expect(harness.controller.notifyFramePresented(toleratedFrame)).toBe(true);
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(2);
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.fallbackRequests).toHaveLength(0);
    });

    it.each([
        { label: 'a visible page', visible: true, withAudio: true },
        { label: 'a hidden page that cannot suspend video', visible: false, withAudio: false }
    ])('resyncs a reclaimed video decoder immediately on $label', async ({
        visible,
        withAudio
    }) => {
        const harness = createControllerHarness(withAudio);
        const generation = await startReadyPlayback(harness, withAudio);
        harness.controller.setPageVisibility(visible);
        harness.setMonotonicTime(secondsToMicroseconds(12));

        harness.videoDecodeSession.emit({
            generation,
            reason: 'decoder-reclaimed',
            type: 'video-interrupted'
        });

        expect(harness.videoDecodeSession.resyncVideo).toHaveBeenCalledOnce();
        expect(harness.videoDecodeSession.resyncVideo).toHaveBeenCalledWith(
            secondsToMicroseconds(7)
        );
        expect(harness.controller.getTelemetry()).toMatchObject({
            pageHidden: !visible,
            videoResyncPending: true,
            videoSuspended: false
        });
    });

    it('defers a hidden reclaimed native decoder resync until the page returns', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(harness, true);
        harness.controller.setPageVisibility(false);
        harness.setMonotonicTime(secondsToMicroseconds(12));

        harness.videoDecodeSession.emit({
            generation,
            reason: 'decoder-reclaimed',
            type: 'video-interrupted'
        });
        harness.controller.drainBackgroundVideo();

        expect(harness.videoDecodeSession.resyncVideo).not.toHaveBeenCalled();
        expect(harness.videoDecodeSession.suspendVideo).not.toHaveBeenCalled();
        expect(harness.videoDecodeSession.takeFrame).not.toHaveBeenCalled();
        expect(harness.controller.getTelemetry()).toMatchObject({
            pageHidden: true,
            videoResyncPending: false,
            videoSuspended: true
        });

        harness.setMonotonicTime(secondsToMicroseconds(15));
        expect(harness.controller.setPageVisibility(true)).toBe(true);
        expect(harness.videoDecodeSession.resyncVideo).toHaveBeenCalledOnce();
        expect(harness.videoDecodeSession.resyncVideo).toHaveBeenCalledWith(
            secondsToMicroseconds(10)
        );
        expect(harness.controller.getTelemetry()).toMatchObject({
            pageHidden: false,
            videoResyncPending: true,
            videoSuspended: false
        });
    });

    it('does not repeat a pending video resync when the page returns', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(harness, true);
        harness.videoDecodeSession.queueFrame(createDecodedFrame(secondsToMicroseconds(5)));
        harness.setMonotonicTime(secondsToMicroseconds(12));
        harness.videoDecodeSession.emit({
            generation,
            reason: 'decoder-reclaimed',
            type: 'video-interrupted'
        });
        harness.controller.setPageVisibility(false);
        harness.setMonotonicTime(secondsToMicroseconds(13));

        // The newest decoded frame predates the pending resync
        expect(harness.controller.setPageVisibility(true)).toBe(false);

        expect(harness.videoDecodeSession.resyncVideo).toHaveBeenCalledOnce();
        expect(harness.controller.getTelemetry().videoResyncPending).toBe(true);
    });

    it('restarts a pre-hide video wait so the first frame take after return does not stall', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_100));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(1);
        harness.controller.setPageVisibility(false);
        harness.setMonotonicTime(secondsToMicroseconds(40));

        expect(harness.controller.setPageVisibility(true)).toBe(false);
        expect(harness.controller.takeCurrentFrame()).toBeNull();

        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.fallbackRequests).toHaveLength(0);
        // The bounded stall timeout now measures from the return
        harness.setMonotonicTime(millisecondsToMicroseconds(49_999));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('playing');
        harness.setMonotonicTime(secondsToMicroseconds(50));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('fallback');
        expect(harness.fallbackRequests).toEqual([ expect.objectContaining({
            disposition: 'renegotiate-source',
            reason: 'playback-stalled'
        }) ]);
    });

    it('holds the last frame without waiting while audio outlasts the video track', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        const lastFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(lastFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(lastFrame);
        harness.videoDecodeSession.setVideoEnded(true);

        // The audio tail runs past both the miss grace and the bounded stall timeout
        harness.setMonotonicTime(millisecondsToMicroseconds(10_200));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(secondsToMicroseconds(25));
        expect(harness.controller.takeCurrentFrame()).toBeNull();

        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(0);
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.fallbackRequests).toHaveLength(0);
    });

    it('ends an active video wait once the video track ends', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_100));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(1);

        harness.videoDecodeSession.setVideoEnded(true);
        const eventCount = harness.events.length;
        expect(harness.controller.takeCurrentFrame()).toBeNull();

        expect(harness.events.slice(eventCount)).toContainEqual(
            expect.objectContaining({ type: 'playing' })
        );
        harness.setMonotonicTime(secondsToMicroseconds(30));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.fallbackRequests).toHaveLength(0);
    });

    it('neither suspends nor resyncs hidden video after its track ended', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        harness.videoDecodeSession.queueFrame(createDecodedFrame(secondsToMicroseconds(5)));
        harness.videoDecodeSession.setVideoEnded(true);
        harness.controller.setPageVisibility(false);
        // Hidden past the suspension delay and far behind the clock
        harness.setMonotonicTime(secondsToMicroseconds(25));
        harness.controller.drainBackgroundVideo();

        expect(harness.videoDecodeSession.suspendVideo).not.toHaveBeenCalled();
        expect(harness.controller.setPageVisibility(true)).toBe(false);
        expect(harness.videoDecodeSession.resyncVideo).not.toHaveBeenCalled();
        expect(harness.controller.getTelemetry()).toMatchObject({
            videoResyncPending: false,
            videoSuspended: false
        });
    });
});

const AUDIO_OUTPUT_SWITCH_LEAD_MILLISECONDS = microsecondsToMilliseconds(
    CUSTOM_PLAYBACK_AUDIO_OUTPUT_SWITCH_LEAD_MICROSECONDS
);
const AUDIO_OUTPUT_SWITCH_TIMEOUT_MILLISECONDS = microsecondsToMilliseconds(
    CUSTOM_PLAYBACK_AUDIO_OUTPUT_SWITCH_TIMEOUT_MICROSECONDS
);
// Stereo output decoded from a 5.1 source
const FIVE_POINT_ONE_DOWNMIX_CONFIGURATION: Partial<DecodeWorkerAudioConfiguration> = {
    sourceChannelCount: 6,
    sourceSampleRate: 48_000
};
// Stereo output decoded from a 7.1 source
const SEVEN_POINT_ONE_DOWNMIX_CONFIGURATION: Partial<DecodeWorkerAudioConfiguration> = {
    sourceChannelCount: 8,
    sourceSampleRate: 48_000
};
const FIVE_POINT_ONE_OUTPUT_CONFIGURATION: DecodeWorkerAudioConfiguration = {
    channelCount: 6,
    codec: 'opus',
    sampleRate: 48_000,
    sourceChannelCount: 6,
    sourceSampleRate: 48_000
};
const FIVE_POINT_ONE_OUTPUT_OPTIONS: CustomPlaybackAudioOutputOptions = {
    decodedAudioOutputChannelCount: 6
};
const LIVE_DOWNMIX_SETTINGS: AudioDownmixSettings = {
    centerLevel: 0.5,
    outputGain: 1.25,
    surroundLevel: 0.75,
    version: 1
};

type OutputRebuildRace = {
    audioPreparation: Promise<CustomDecodeAudioBridge | null>
    rebuild: Deferred<CustomDecodeAudioBridge>
    seekPromise: Promise<CustomPlaybackStartResult>
    switchPromise: Promise<boolean>
};

/** Seeks while a live 5.1 switch still rebuilds its output, then requests the new generation's bridge */
async function seekDuringOutputRebuild(harness: ControllerHarness): Promise<OutputRebuildRace> {
    const audioOutput = requireAudioOutput(harness);
    const rebuild = createDeferred<CustomDecodeAudioBridge>();
    audioOutput.reconfigure.mockImplementationOnce(
        (): Promise<CustomDecodeAudioBridge> => rebuild.promise
    );
    const switchPromise = harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS);
    await flushAsyncWork();
    expect(audioOutput.reconfigure).toHaveBeenCalledOnce();

    const seekPromise = harness.controller.seek(secondsToMicroseconds(40));
    await flushAsyncWork();
    audioOutput.setVolume.mockClear();
    let audioBridgeSettled = false;
    const audioPreparation = harness.videoDecodeSession.prepareAudio(
        FIVE_POINT_ONE_OUTPUT_CONFIGURATION
    ).then((audioBridge: CustomDecodeAudioBridge | null): CustomDecodeAudioBridge | null => {
        audioBridgeSettled = true;
        return audioBridge;
    });
    await flushAsyncWork();
    // The new generation chooses no output before the rebuild settles
    expect(audioBridgeSettled).toBe(false);
    expect(audioOutput.setVolume).not.toHaveBeenCalled();
    return { audioPreparation, rebuild, seekPromise, switchPromise };
}

describe('CustomPlaybackController live audio output reconfiguration', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it.each([
        {
            errorType: RangeError,
            label: 'an unsupported output channel count',
            message: 'Decoded audio output channel count must be 2, 6, or 8',
            options: {
                decodedAudioOutputChannelCount: 4
            } as unknown as CustomPlaybackAudioOutputOptions
        },
        {
            errorType: TypeError,
            label: 'an unknown downmix algorithm',
            message: 'Custom playback audio downmix algorithm is invalid',
            options: {
                audioDownmixAlgorithm: 'matrix-surround',
                decodedAudioOutputChannelCount: 2
            } as unknown as CustomPlaybackAudioOutputOptions
        },
        {
            errorType: RangeError,
            label: 'out-of-range downmix gains',
            message: 'Audio downmix center level must be between zero and two',
            options: {
                audioDownmixSettings: { ...LIVE_DOWNMIX_SETTINGS, centerLevel: 3 },
                decodedAudioOutputChannelCount: 2
            } as CustomPlaybackAudioOutputOptions
        }
    ])('rejects $label without side effects', async ({ errorType, message, options }) => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true, {}, FIVE_POINT_ONE_DOWNMIX_CONFIGURATION);
        const audioOutput = requireAudioOutput(harness);
        audioOutput.setPlaying.mockClear();

        const reconfiguration = harness.controller.reconfigureAudioOutput(options);

        await expect(reconfiguration).rejects.toBeInstanceOf(errorType);
        await expect(reconfiguration).rejects.toThrow(message);
        expect(audioOutput.setPlaying).not.toHaveBeenCalled();
        expect(audioOutput.reconfigure).not.toHaveBeenCalled();
        expect(harness.videoDecodeSession.resyncAudio).not.toHaveBeenCalled();
        expect(harness.videoDecodeSession.updateAudioDownmixSettings).not.toHaveBeenCalled();
        expect(harness.controller.getTelemetry()).toMatchObject({
            audioOutputSwitchPending: false,
            state: 'playing'
        });
        await harness.controller.destroy();
    });

    it('declines a live switch before playback and while startup is pending', async () => {
        const harness = createControllerHarness(true);
        const audioOutput = requireAudioOutput(harness);

        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(false);

        const startPromise = harness.controller.play(createPlayOptions(1));
        await flushAsyncWork();
        await harness.videoDecodeSession.prepareAudio({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000,
            ...FIVE_POINT_ONE_DOWNMIX_CONFIGURATION
        });
        audioOutput.setPlaying.mockClear();
        expect(harness.controller.playbackState).toBe('starting');

        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(false);

        expect(audioOutput.setPlaying).not.toHaveBeenCalled();
        expect(audioOutput.reconfigure).not.toHaveBeenCalled();
        expect(harness.videoDecodeSession.resyncAudio).not.toHaveBeenCalled();
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(false);
        await harness.controller.destroy();
        await expect(startPromise).resolves.toMatchObject({ status: 'stopped' });
        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .rejects.toThrow('Custom playback controller is destroyed');
    });

    it('declines a live switch requested before startup settles', async () => {
        const declinedSwitches: Promise<boolean>[] = [];
        let playbackController: CustomPlaybackController | null = null;
        const harness = createControllerHarness(true, {
            eventHandler: (event: CustomPlaybackControllerEvent): void => {
                // Startup applies the playing state before it settles its result
                if (event.type === 'statechange'
                    && event.state === 'playing'
                    && playbackController) {
                    declinedSwitches.push(
                        playbackController.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS)
                    );
                }
            }
        });
        playbackController = harness.controller;

        await startReadyPlayback(harness, true, {}, FIVE_POINT_ONE_DOWNMIX_CONFIGURATION);

        expect(declinedSwitches).toHaveLength(1);
        await expect(declinedSwitches[0]).resolves.toBe(false);
        expect(requireAudioOutput(harness).reconfigure).not.toHaveBeenCalled();
        expect(harness.videoDecodeSession.resyncAudio).not.toHaveBeenCalled();
        expect(harness.controller.getTelemetry()).toMatchObject({
            audioOutputSwitchPending: false,
            state: 'playing'
        });
        await harness.controller.destroy();
    });

    it('declines a live switch once playback ended or fell back', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(
            harness,
            true,
            {},
            FIVE_POINT_ONE_DOWNMIX_CONFIGURATION
        );
        const audioOutput = requireAudioOutput(harness);
        // A drained output lets the end of the stream finish playback at once
        audioOutput.emitTelemetry(secondsToMicroseconds(5), undefined, { queuedFrames: 0 });
        harness.videoDecodeSession.emit({ generation, type: 'ended' });
        expect(harness.controller.playbackState).toBe('ended');

        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(false);
        expect(harness.controller.setPlaybackRate(2)).toBe(false);
        expect(harness.controller.playbackState).toBe('fallback');
        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(false);

        expect(audioOutput.reconfigure).not.toHaveBeenCalled();
        expect(harness.videoDecodeSession.resyncAudio).not.toHaveBeenCalled();
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(false);
        await harness.controller.destroy();
    });

    it('declines a live switch for native media audio or a source without audio', async () => {
        const nativeAudioBridgeFactory = (
            vi.fn() as unknown as CustomDecodeNativeAudioBridgeFactory
        );
        const harness = createControllerHarness(true, { nativeAudioBridgeFactory });
        await startReadyPlayback(harness, true, {}, FIVE_POINT_ONE_DOWNMIX_CONFIGURATION);
        const audioOutput = requireAudioOutput(harness);

        // The decoded output stays bound while native media audio plays
        const nativeSwitchPromise = harness.controller.setAudioStreamIndex(4, 'native-media');
        await flushAsyncWork();
        const nativeGeneration = harness.videoDecodeSession.starts.at(-1)?.generation;
        if (!nativeGeneration) {
            throw new Error('Native audio switch generation did not start');
        }
        harness.videoDecodeSession.emit({
            audio: {
                channelCount: 6,
                codec: 'ec-3',
                mimeType: 'audio/mp4; codecs="ec-3"',
                outputMode: 'native-media',
                sampleRate: 48_000
            },
            codec: 'hvc1.2.4.L153.B0',
            generation: nativeGeneration,
            type: 'ready'
        });
        await expect(nativeSwitchPromise).resolves.toMatchObject({ status: 'started' });
        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(false);

        const videoOnlyPromise = harness.controller.play(createPlayOptions());
        await flushAsyncWork();
        const videoOnlyGeneration = harness.videoDecodeSession.starts.at(-1)?.generation;
        if (!videoOnlyGeneration) {
            throw new Error('Video-only generation did not start');
        }
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'avc1.640028',
            generation: videoOnlyGeneration,
            type: 'ready'
        });
        await expect(videoOnlyPromise).resolves.toMatchObject({ status: 'started' });
        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(false);

        expect(audioOutput.reconfigure).not.toHaveBeenCalled();
        expect(harness.videoDecodeSession.resyncAudio).not.toHaveBeenCalled();
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(false);
        await harness.controller.destroy();
    });

    it.each([
        {
            capability: 'an output that rebuilds its layout in place',
            removeCapability: (harness: ControllerHarness): void => {
                Reflect.deleteProperty(requireAudioOutput(harness), 'reconfigure');
            }
        },
        {
            capability: 'a session that resyncs audio alone',
            removeCapability: (harness: ControllerHarness): void => {
                Reflect.deleteProperty(harness.videoDecodeSession, 'resyncAudio');
            }
        }
    ])('declines a live switch without $capability', async ({ removeCapability }) => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true, {}, FIVE_POINT_ONE_DOWNMIX_CONFIGURATION);
        const audioOutput = requireAudioOutput(harness);
        const reconfigure = audioOutput.reconfigure;
        const resyncAudio = harness.videoDecodeSession.resyncAudio;
        removeCapability(harness);
        audioOutput.setPlaying.mockClear();

        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(false);

        expect(audioOutput.setPlaying).not.toHaveBeenCalled();
        expect(reconfigure).not.toHaveBeenCalled();
        expect(resyncAudio).not.toHaveBeenCalled();
        expect(harness.controller.getTelemetry()).toMatchObject({
            audioOutputSwitchPending: false,
            state: 'playing'
        });
        await harness.controller.destroy();
    });

    it('keeps a matching layout and forwards only its downmix gains', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true, {}, FIVE_POINT_ONE_DOWNMIX_CONFIGURATION);
        const audioOutput = requireAudioOutput(harness);
        harness.videoDecodeSession.updateAudioDownmixSettings.mockReturnValueOnce(true);
        audioOutput.setPlaying.mockClear();

        await expect(harness.controller.reconfigureAudioOutput({
            audioDownmixSettings: LIVE_DOWNMIX_SETTINGS,
            decodedAudioOutputChannelCount: 2
        })).resolves.toBe(true);

        expect(harness.videoDecodeSession.updateAudioDownmixSettings).toHaveBeenCalledOnce();
        expect(harness.videoDecodeSession.updateAudioDownmixSettings)
            .toHaveBeenCalledWith(LIVE_DOWNMIX_SETTINGS);
        expect(harness.videoDecodeSession.resyncAudio).not.toHaveBeenCalled();
        expect(audioOutput.reconfigure).not.toHaveBeenCalled();
        expect(audioOutput.setPlaying).not.toHaveBeenCalled();
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(false);

        // A restart keeps the forwarded gains on the unchanged layout
        const seekPromise = harness.controller.seek(secondsToMicroseconds(40));
        await flushAsyncWork();
        const restartOptions = harness.videoDecodeSession.starts.at(-1);
        expect(restartOptions?.audioDownmixSettings).toEqual(LIVE_DOWNMIX_SETTINGS);
        expect(restartOptions?.decodedAudioOutputChannelCount).toBeUndefined();
        await harness.controller.destroy();
        await expect(seekPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it.each([
        { label: 'stereo source', outputChannelCount: 2, sourceChannelCount: 2 },
        { label: '5.1 source on 5.1 output', outputChannelCount: 6, sourceChannelCount: 6 },
        { label: '7.1 source on 7.1 output', outputChannelCount: 8, sourceChannelCount: 8 }
    ] as const)('ignores a downmix algorithm change for a $label', async ({
        outputChannelCount,
        sourceChannelCount
    }) => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(
            harness,
            true,
            {
                audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.StandardLORO,
                decodedAudioOutputChannelCount: outputChannelCount
            },
            {
                channelCount: outputChannelCount,
                sourceChannelCount,
                sourceSampleRate: 48_000
            }
        );
        const audioOutput = requireAudioOutput(harness);
        audioOutput.setPlaying.mockClear();

        await expect(harness.controller.reconfigureAudioOutput({
            audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue,
            decodedAudioOutputChannelCount: outputChannelCount
        })).resolves.toBe(true);

        expect(harness.videoDecodeSession.resyncAudio).not.toHaveBeenCalled();
        expect(audioOutput.reconfigure).not.toHaveBeenCalled();
        expect(audioOutput.setPlaying).not.toHaveBeenCalled();
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(false);
        await harness.controller.destroy();
    });

    it('rebuilds a 5.1 stereo downmix live when only its algorithm changes', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(
            harness,
            true,
            { audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845 },
            FIVE_POINT_ONE_DOWNMIX_CONFIGURATION
        );
        const audioOutput = requireAudioOutput(harness);

        // The current or an omitted algorithm leaves the downmix as it is
        await expect(harness.controller.reconfigureAudioOutput({
            audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
            decodedAudioOutputChannelCount: 2
        })).resolves.toBe(true);
        await expect(harness.controller.reconfigureAudioOutput({
            decodedAudioOutputChannelCount: 2
        })).resolves.toBe(true);
        expect(harness.videoDecodeSession.resyncAudio).not.toHaveBeenCalled();

        await expect(harness.controller.reconfigureAudioOutput({
            audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue,
            decodedAudioOutputChannelCount: 2
        })).resolves.toBe(true);

        expect(harness.videoDecodeSession.resyncAudio).toHaveBeenCalledOnce();
        expect(harness.videoDecodeSession.resyncAudio).toHaveBeenCalledWith(
            expect.objectContaining({
                audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue,
                decodedAudioOutputChannelCount: 2
            })
        );
        expect(audioOutput.reconfigure).toHaveBeenCalledWith({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000,
            ...FIVE_POINT_ONE_DOWNMIX_CONFIGURATION
        });
        harness.videoDecodeSession.completeAudioResync();
        await vi.advanceTimersByTimeAsync(AUDIO_OUTPUT_SWITCH_LEAD_MILLISECONDS);
        expect(audioOutput.setPlaying).toHaveBeenLastCalledWith(true);
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(false);

        const seekPromise = harness.controller.seek(secondsToMicroseconds(40));
        await flushAsyncWork();
        expect(harness.videoDecodeSession.starts.at(-1)?.audioDownmixAlgorithm)
            .toBe(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue);
        await harness.controller.destroy();
        await expect(seekPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it('switches a playing layout live and adopts the rebuilt binding', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(
            harness,
            true,
            {},
            FIVE_POINT_ONE_DOWNMIX_CONFIGURATION
        );
        const audioOutput = requireAudioOutput(harness);
        harness.setMonotonicTime(secondsToMicroseconds(12));
        audioOutput.setPlaying.mockClear();

        const switchPromise = harness.controller.reconfigureAudioOutput({
            audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
            audioDownmixSettings: LIVE_DOWNMIX_SETTINGS,
            decodedAudioOutputChannelCount: 6
        });

        // The previous layout rests as soon as the switch begins
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(true);
        expect(audioOutput.setPlaying.mock.calls).toEqual([ [ false ] ]);
        await expect(switchPromise).resolves.toBe(true);

        expect(harness.videoDecodeSession.resyncAudio).toHaveBeenCalledOnce();
        expect(harness.videoDecodeSession.resyncAudio).toHaveBeenCalledWith({
            audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
            audioDownmixSettings: LIVE_DOWNMIX_SETTINGS,
            createAudioBridge: expect.any(Function),
            decodedAudioOutputChannelCount: 6,
            targetTimeMicroseconds: addMicroseconds(
                secondsToMicroseconds(7),
                CUSTOM_PLAYBACK_AUDIO_OUTPUT_SWITCH_LEAD_MICROSECONDS
            )
        });
        expect(audioOutput.reconfigure).toHaveBeenCalledOnce();
        expect(audioOutput.reconfigure).toHaveBeenCalledWith(FIVE_POINT_ONE_OUTPUT_CONFIGURATION);
        const rebuiltBridge = audioOutput.reconfiguredBridges[0];
        rebuiltBridge.activate(generation, audioOutput.generation);
        expect(harness.controller.getTelemetry()).toMatchObject({
            audioBridge: rebuiltBridge.getTelemetry(),
            audioOutputSwitchPending: true,
            state: 'playing'
        });
        expect(audioOutput.setPlaying.mock.calls).toEqual([ [ false ] ]);
        // The rebuilt stage keeps its output's device subscription
        expect(audioOutput.outputDeviceListenerCount).toBe(1);

        // A restart keeps the switched layout and reuses the rebuilt binding
        const seekPromise = harness.controller.seek(secondsToMicroseconds(40));
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(false);
        await flushAsyncWork();
        expect(harness.videoDecodeSession.starts.at(-1)).toMatchObject({
            audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
            audioDownmixSettings: LIVE_DOWNMIX_SETTINGS,
            decodedAudioOutputChannelCount: 6,
            startTimeMicroseconds: secondsToMicroseconds(40)
        });
        audioOutput.setVolume.mockClear();
        await expect(harness.videoDecodeSession.prepareAudio(FIVE_POINT_ONE_OUTPUT_CONFIGURATION))
            .resolves.toBe(rebuiltBridge);
        expect(audioOutput.setVolume).not.toHaveBeenCalled();
        await harness.controller.destroy();
        await expect(seekPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it.each([
        {
            durationMicroseconds: secondsToMicroseconds(120),
            expectedTargetMicroseconds: secondsToMicroseconds(7.25),
            label: 'the switch lead ahead of a playing clock',
            mediaTimeMicroseconds: secondsToMicroseconds(7)
        },
        {
            durationMicroseconds: secondsToMicroseconds(120),
            expectedTargetMicroseconds: requireMicroseconds(119_999_999),
            label: 'a lead that ends just before the duration',
            mediaTimeMicroseconds: requireMicroseconds(119_749_999)
        },
        {
            durationMicroseconds: secondsToMicroseconds(120),
            expectedTargetMicroseconds: secondsToMicroseconds(119.75),
            label: 'the current time when the lead reaches the duration',
            mediaTimeMicroseconds: secondsToMicroseconds(119.75)
        },
        {
            durationMicroseconds: null,
            expectedTargetMicroseconds: secondsToMicroseconds(300.25),
            label: 'the switch lead without a known duration',
            mediaTimeMicroseconds: secondsToMicroseconds(300)
        }
    ])('targets $label', async ({
        durationMicroseconds,
        expectedTargetMicroseconds,
        mediaTimeMicroseconds
    }) => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(
            harness,
            true,
            { durationMicroseconds },
            FIVE_POINT_ONE_DOWNMIX_CONFIGURATION
        );
        // Playback started at 5 seconds of media and 10 seconds of monotonic time
        harness.setMonotonicTime(addMicroseconds(mediaTimeMicroseconds, secondsToMicroseconds(5)));

        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(true);

        expect(harness.videoDecodeSession.resyncAudio).toHaveBeenCalledWith(
            expect.objectContaining({ targetTimeMicroseconds: expectedTargetMicroseconds })
        );
        await harness.controller.destroy();
    });

    it('neither synchronizes nor starves the clock from audio while a switch is pending', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(
            harness,
            true,
            {},
            FIVE_POINT_ONE_DOWNMIX_CONFIGURATION
        );
        const audioOutput = requireAudioOutput(harness);
        harness.setMonotonicTime(secondsToMicroseconds(12));
        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(true);
        // The rebuilt stage reports the active generation exactly like an established output
        audioOutput.reconfiguredBridges[0].activate(generation, audioOutput.generation);
        const waitingEventCount = harness.events.filter(event => event.type === 'waiting').length;

        audioOutput.emitTelemetry(secondsToMicroseconds(9));
        audioOutput.emitTelemetry(secondsToMicroseconds(7), undefined, { reason: 'underflow' });
        harness.setMonotonicTime(millisecondsToMicroseconds(12_100));

        expect(harness.controller.currentTimeMicroseconds).toBe(millisecondsToMicroseconds(7_100));
        expect(harness.controller.getTelemetry().clock.paused).toBe(false);
        expect(harness.events.filter(event => event.type === 'waiting'))
            .toHaveLength(waitingEventCount);

        // The clock is 150 milliseconds short of the 7.25-second target
        harness.videoDecodeSession.completeAudioResync();
        await vi.advanceTimersByTimeAsync(150);
        expect(audioOutput.setPlaying).toHaveBeenLastCalledWith(true);
        // Once the new layout plays, its telemetry drives the clock again
        audioOutput.emitTelemetry(millisecondsToMicroseconds(7_180));
        expect(harness.controller.currentTimeMicroseconds).toBe(millisecondsToMicroseconds(7_180));
        await harness.controller.destroy();
    });

    it('lets pause stop but not resume start the output while a switch is pending', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true, {}, FIVE_POINT_ONE_DOWNMIX_CONFIGURATION);
        const audioOutput = requireAudioOutput(harness);
        harness.setMonotonicTime(secondsToMicroseconds(12));
        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(true);
        audioOutput.setPlaying.mockClear();

        harness.controller.pause();
        harness.controller.resume();

        expect(harness.controller.playbackState).toBe('playing');
        expect(audioOutput.setPlaying.mock.calls).toEqual([ [ false ] ]);
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(true);

        // The switch starts the output itself once its audio fills at the target
        harness.videoDecodeSession.completeAudioResync();
        await vi.advanceTimersByTimeAsync(AUDIO_OUTPUT_SWITCH_LEAD_MILLISECONDS);
        expect(audioOutput.setPlaying.mock.calls).toEqual([ [ false ], [ true ] ]);
        await harness.controller.destroy();
    });

    it('starts the switched output once the clock reaches the switch target', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(
            harness,
            true,
            {},
            FIVE_POINT_ONE_DOWNMIX_CONFIGURATION
        );
        const audioOutput = requireAudioOutput(harness);
        harness.setMonotonicTime(secondsToMicroseconds(12));
        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(true);
        audioOutput.setPlaying.mockClear();

        // A report for an earlier audio epoch does not complete this switch
        harness.videoDecodeSession.emit({
            audioEpoch: harness.videoDecodeSession.getTelemetry().audioEpoch - 1,
            generation,
            type: 'audio-resynced'
        });
        await vi.advanceTimersByTimeAsync(AUDIO_OUTPUT_SWITCH_LEAD_MILLISECONDS);
        expect(audioOutput.setPlaying).not.toHaveBeenCalled();

        // The clock is 150 milliseconds short of the 7.25-second target
        harness.setMonotonicTime(millisecondsToMicroseconds(12_100));
        harness.videoDecodeSession.completeAudioResync();
        await vi.advanceTimersByTimeAsync(149);
        expect(audioOutput.setPlaying).not.toHaveBeenCalled();
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(true);
        await vi.advanceTimersByTimeAsync(1);

        expect(audioOutput.setPlaying.mock.calls).toEqual([ [ true ] ]);
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(false);
        // Completion also cleared the bounded switch timeout
        await vi.advanceTimersByTimeAsync(AUDIO_OUTPUT_SWITCH_TIMEOUT_MILLISECONDS);
        expect(harness.fallbackRequests).toHaveLength(0);
        expect(harness.controller.playbackState).toBe('playing');
        await harness.controller.destroy();
    });

    it('starts the switched output at once when the clock already reached the target', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true, {}, FIVE_POINT_ONE_DOWNMIX_CONFIGURATION);
        const audioOutput = requireAudioOutput(harness);
        harness.setMonotonicTime(secondsToMicroseconds(12));
        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(true);
        audioOutput.setPlaying.mockClear();

        harness.setMonotonicTime(millisecondsToMicroseconds(12_250));
        harness.videoDecodeSession.completeAudioResync();

        expect(audioOutput.setPlaying.mock.calls).toEqual([ [ true ] ]);
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(false);
        await harness.controller.destroy();
    });

    it('completes a switch whose epoch filled before its resync resolved', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true, {}, FIVE_POINT_ONE_DOWNMIX_CONFIGURATION);
        const audioOutput = requireAudioOutput(harness);
        const videoDecodeSession = harness.videoDecodeSession;
        videoDecodeSession.resyncAudio.mockImplementationOnce(
            async (options: CustomDecodeAudioResyncOptions): Promise<number | null> => {
                const audioEpoch = await videoDecodeSession.resyncDecodedAudio(options);
                // The epoch reports its fill before the controller learns its number
                videoDecodeSession.completeAudioResync();
                return audioEpoch;
            }
        );
        harness.setMonotonicTime(secondsToMicroseconds(12));
        audioOutput.setPlaying.mockClear();

        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(true);

        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(true);
        await vi.advanceTimersByTimeAsync(AUDIO_OUTPUT_SWITCH_LEAD_MILLISECONDS);
        expect(audioOutput.setPlaying.mock.calls).toEqual([ [ false ], [ true ] ]);
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(false);
        await harness.controller.destroy();
    });

    it('fills a paused switch at the paused time and starts it on resume', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true, {}, SEVEN_POINT_ONE_DOWNMIX_CONFIGURATION);
        const audioOutput = requireAudioOutput(harness);
        harness.setMonotonicTime(secondsToMicroseconds(12));
        harness.controller.pause();
        harness.setMonotonicTime(secondsToMicroseconds(13));
        audioOutput.setPlaying.mockClear();

        await expect(harness.controller.reconfigureAudioOutput({
            decodedAudioOutputChannelCount: 8
        })).resolves.toBe(true);

        // A paused switch resumes audio exactly where the clock rests
        expect(harness.videoDecodeSession.resyncAudio).toHaveBeenCalledWith(
            expect.objectContaining({
                decodedAudioOutputChannelCount: 8,
                targetTimeMicroseconds: secondsToMicroseconds(7)
            })
        );
        harness.videoDecodeSession.completeAudioResync();
        // The filled switch waits for resume, past its fill timeout
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(true);
        await vi.advanceTimersByTimeAsync(AUDIO_OUTPUT_SWITCH_TIMEOUT_MILLISECONDS);
        expect(audioOutput.setPlaying.mock.calls).toEqual([ [ false ] ]);
        expect(harness.fallbackRequests).toHaveLength(0);

        harness.controller.resume();
        expect(audioOutput.setPlaying.mock.calls).toEqual([ [ false ], [ true ] ]);
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(false);

        // A client-side track switch keeps the 7.1 layout
        const trackSwitchPromise = harness.controller.setAudioStreamIndex(3);
        await flushAsyncWork();
        expect(harness.videoDecodeSession.starts.at(-1)).toMatchObject({
            audioTrackIndex: 3,
            decodedAudioOutputChannelCount: 8
        });
        await harness.controller.destroy();
        await expect(trackSwitchPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it('holds a filled switch across a pause and starts it on the clock after resume', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true, {}, FIVE_POINT_ONE_DOWNMIX_CONFIGURATION);
        const audioOutput = requireAudioOutput(harness);
        harness.setMonotonicTime(secondsToMicroseconds(12));
        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(true);
        // The audio fills 150 milliseconds short of the 7.25-second target
        harness.setMonotonicTime(millisecondsToMicroseconds(12_100));
        harness.videoDecodeSession.completeAudioResync();
        harness.setMonotonicTime(millisecondsToMicroseconds(12_150));
        await vi.advanceTimersByTimeAsync(50);
        audioOutput.setPlaying.mockClear();

        harness.controller.pause();
        await vi.advanceTimersByTimeAsync(AUDIO_OUTPUT_SWITCH_TIMEOUT_MILLISECONDS);
        expect(audioOutput.setPlaying.mock.calls).toEqual([ [ false ] ]);
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(true);
        expect(harness.fallbackRequests).toHaveLength(0);

        // A minute later the resumed clock still rests 100 milliseconds short of the target
        harness.setMonotonicTime(secondsToMicroseconds(72));
        harness.controller.resume();
        await vi.advanceTimersByTimeAsync(99);
        expect(audioOutput.setPlaying.mock.calls).toEqual([ [ false ] ]);
        await vi.advanceTimersByTimeAsync(1);

        expect(audioOutput.setPlaying.mock.calls).toEqual([ [ false ], [ true ] ]);
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(false);
        await harness.controller.destroy();
    });

    it('starts a switch that filled during a pause once the resumed clock reaches its target', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true, {}, FIVE_POINT_ONE_DOWNMIX_CONFIGURATION);
        const audioOutput = requireAudioOutput(harness);
        harness.setMonotonicTime(secondsToMicroseconds(12));
        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(true);
        // Paused 150 milliseconds short of the 7.25-second target
        harness.setMonotonicTime(millisecondsToMicroseconds(12_100));
        harness.controller.pause();
        harness.videoDecodeSession.completeAudioResync();
        await vi.advanceTimersByTimeAsync(AUDIO_OUTPUT_SWITCH_TIMEOUT_MILLISECONDS);
        expect(harness.fallbackRequests).toHaveLength(0);
        audioOutput.setPlaying.mockClear();

        harness.setMonotonicTime(secondsToMicroseconds(30));
        harness.controller.resume();
        await vi.advanceTimersByTimeAsync(149);
        expect(audioOutput.setPlaying).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(audioOutput.setPlaying.mock.calls).toEqual([ [ true ] ]);
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(false);
        await harness.controller.destroy();
    });

    it('resumes a clock starved by the retired output once the switched audio fills', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(
            harness,
            true,
            {},
            FIVE_POINT_ONE_DOWNMIX_CONFIGURATION
        );
        const audioOutput = requireAudioOutput(harness);
        harness.setMonotonicTime(secondsToMicroseconds(12));
        // The previous output runs dry at 7 seconds, so the clock waits for audio
        audioOutput.emitTelemetry(secondsToMicroseconds(7), undefined, { reason: 'underflow' });
        expect(harness.controller.getTelemetry().clock.paused).toBe(true);
        harness.setMonotonicTime(secondsToMicroseconds(13));
        audioOutput.setPlaying.mockClear();

        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(true);

        // The waiting clock takes no lead because it resumes with the new audio
        expect(harness.videoDecodeSession.resyncAudio).toHaveBeenCalledWith(
            expect.objectContaining({ targetTimeMicroseconds: secondsToMicroseconds(7) })
        );
        const playingEventCount = harness.events.filter(event => event.type === 'playing').length;
        harness.videoDecodeSession.completeAudioResync();

        expect(audioOutput.setPlaying.mock.calls).toEqual([ [ false ], [ true ] ]);
        expect(harness.events.filter(event => event.type === 'playing'))
            .toHaveLength(playingEventCount + 1);
        expect(harness.controller.getTelemetry()).toMatchObject({
            audioOutputSwitchPending: false,
            clock: { paused: false },
            state: 'playing'
        });
        harness.setMonotonicTime(millisecondsToMicroseconds(13_500));
        expect(harness.controller.currentTimeMicroseconds).toBe(millisecondsToMicroseconds(7_500));
        // The new output's reports drive the clock again
        audioOutput.reconfiguredBridges[0].activate(generation, audioOutput.generation);
        audioOutput.emitTelemetry(millisecondsToMicroseconds(7_480));
        expect(harness.controller.currentTimeMicroseconds).toBe(millisecondsToMicroseconds(7_480));
        await harness.controller.destroy();
    });

    it('lets a request made during a pending switch return to the previous layout', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true, {}, FIVE_POINT_ONE_DOWNMIX_CONFIGURATION);
        const audioOutput = requireAudioOutput(harness);
        harness.setMonotonicTime(secondsToMicroseconds(12));

        // The second request arrives before the first one rebuilds the output
        const surroundSwitch = harness.controller.reconfigureAudioOutput(
            FIVE_POINT_ONE_OUTPUT_OPTIONS
        );
        const stereoSwitch = harness.controller.reconfigureAudioOutput({
            decodedAudioOutputChannelCount: 2
        });

        await expect(surroundSwitch).resolves.toBe(false);
        await expect(stereoSwitch).resolves.toBe(true);
        expect(harness.videoDecodeSession.resyncAudio).toHaveBeenCalledOnce();
        expect(harness.videoDecodeSession.resyncAudio).toHaveBeenCalledWith(
            expect.objectContaining({ decodedAudioOutputChannelCount: 2 })
        );
        expect(audioOutput.reconfigure).toHaveBeenCalledOnce();
        expect(audioOutput.reconfigure).toHaveBeenCalledWith(
            expect.objectContaining({ channelCount: 2 })
        );
        harness.videoDecodeSession.completeAudioResync();
        await vi.advanceTimersByTimeAsync(AUDIO_OUTPUT_SWITCH_LEAD_MILLISECONDS);
        expect(audioOutput.setPlaying).toHaveBeenLastCalledWith(true);

        const seekPromise = harness.controller.seek(secondsToMicroseconds(40));
        await flushAsyncWork();
        expect(harness.videoDecodeSession.starts.at(-1)?.decodedAudioOutputChannelCount).toBe(2);
        await harness.controller.destroy();
        await expect(seekPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it('mixes a speaker layout the source cannot fill down to stereo', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(
            harness,
            true,
            { decodedAudioOutputChannelCount: 8 },
            { channelCount: 8, sourceChannelCount: 8, sourceSampleRate: 48_000 }
        );
        const audioOutput = requireAudioOutput(harness);

        // A 5.1 ceiling cannot carry the 7.1 bed, and only stereo converts layouts
        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(true);

        expect(harness.videoDecodeSession.resyncAudio).toHaveBeenCalledWith(
            expect.objectContaining({ decodedAudioOutputChannelCount: 2 })
        );
        expect(audioOutput.reconfigure).toHaveBeenCalledWith(
            expect.objectContaining({ channelCount: 2, sourceChannelCount: 8 })
        );
        await harness.controller.destroy();
    });

    it('keeps a stereo source on stereo under a surround request', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        const audioOutput = requireAudioOutput(harness);
        audioOutput.setPlaying.mockClear();

        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(true);

        expect(harness.videoDecodeSession.resyncAudio).not.toHaveBeenCalled();
        expect(audioOutput.reconfigure).not.toHaveBeenCalled();
        expect(audioOutput.setPlaying).not.toHaveBeenCalled();
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(false);
        await harness.controller.destroy();
    });

    it('keeps the source speaker layout under a larger channel ceiling', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true, {}, FIVE_POINT_ONE_DOWNMIX_CONFIGURATION);
        const audioOutput = requireAudioOutput(harness);

        await expect(harness.controller.reconfigureAudioOutput({
            decodedAudioOutputChannelCount: 8
        })).resolves.toBe(true);

        expect(harness.videoDecodeSession.resyncAudio).toHaveBeenCalledWith(
            expect.objectContaining({ decodedAudioOutputChannelCount: 6 })
        );
        expect(audioOutput.reconfigure).toHaveBeenCalledWith(FIVE_POINT_ONE_OUTPUT_CONFIGURATION);
        await harness.controller.destroy();
    });

    it('records a downmix request that keeps the layout for later restarts', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(
            harness,
            true,
            { decodedAudioOutputChannelCount: 6 },
            FIVE_POINT_ONE_OUTPUT_CONFIGURATION
        );

        // Native 5.1 output uses neither the algorithm nor the gains
        await expect(harness.controller.reconfigureAudioOutput({
            audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue,
            audioDownmixSettings: LIVE_DOWNMIX_SETTINGS,
            decodedAudioOutputChannelCount: 6
        })).resolves.toBe(true);
        expect(harness.videoDecodeSession.resyncAudio).not.toHaveBeenCalled();
        expect(harness.videoDecodeSession.updateAudioDownmixSettings).not.toHaveBeenCalled();

        // A track switch that mixes down starts with both
        const trackSwitchPromise = harness.controller.setAudioStreamIndex(3, 'decoded-pcm', 2);
        await flushAsyncWork();
        expect(harness.videoDecodeSession.starts.at(-1)).toMatchObject({
            audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue,
            audioDownmixSettings: LIVE_DOWNMIX_SETTINGS,
            audioTrackIndex: 3,
            decodedAudioOutputChannelCount: 2
        });
        await harness.controller.destroy();
        await expect(trackSwitchPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it('restores the previous layout and restarts audio when the session declines the resync', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true, {}, FIVE_POINT_ONE_DOWNMIX_CONFIGURATION);
        const audioOutput = requireAudioOutput(harness);
        harness.videoDecodeSession.resyncAudio.mockResolvedValueOnce(null);
        audioOutput.setPlaying.mockClear();

        await expect(harness.controller.reconfigureAudioOutput({
            audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
            decodedAudioOutputChannelCount: 6
        })).resolves.toBe(false);

        expect(audioOutput.setPlaying.mock.calls).toEqual([ [ false ], [ true ] ]);
        expect(audioOutput.reconfigure).not.toHaveBeenCalled();
        expect(harness.controller.getTelemetry()).toMatchObject({
            audioOutputSwitchPending: false,
            state: 'playing'
        });
        await vi.advanceTimersByTimeAsync(AUDIO_OUTPUT_SWITCH_TIMEOUT_MILLISECONDS);
        expect(harness.fallbackRequests).toHaveLength(0);

        // Nothing switched, so a restart keeps the original layout and downmix
        const seekPromise = harness.controller.seek(secondsToMicroseconds(40));
        await flushAsyncWork();
        const restartOptions = harness.videoDecodeSession.starts.at(-1);
        expect(restartOptions?.startTimeMicroseconds).toBe(secondsToMicroseconds(40));
        expect(restartOptions?.decodedAudioOutputChannelCount).toBeUndefined();
        expect(restartOptions?.audioDownmixAlgorithm).toBeUndefined();
        await harness.controller.destroy();
        await expect(seekPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it('keeps a paused output stopped when the session declines the resync', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true, {}, FIVE_POINT_ONE_DOWNMIX_CONFIGURATION);
        const audioOutput = requireAudioOutput(harness);
        harness.controller.pause();
        harness.videoDecodeSession.resyncAudio.mockResolvedValueOnce(null);
        audioOutput.setPlaying.mockClear();

        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(false);

        expect(audioOutput.setPlaying.mock.calls).toEqual([ [ false ] ]);
        expect(harness.controller.getTelemetry()).toMatchObject({
            audioOutputSwitchPending: false,
            state: 'paused'
        });
        harness.controller.resume();
        expect(audioOutput.setPlaying).toHaveBeenLastCalledWith(true);
        await harness.controller.destroy();
    });

    it('falls back in the same session when the audio resync rejects', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(
            harness,
            true,
            {},
            FIVE_POINT_ONE_DOWNMIX_CONFIGURATION
        );
        const audioOutput = requireAudioOutput(harness);
        harness.videoDecodeSession.resyncAudio.mockRejectedValueOnce(
            new Error('The decode worker rejected the audio resync')
        );
        audioOutput.setPlaying.mockClear();

        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(false);

        expect(harness.fallbackRequests).toEqual([ {
            disposition: 'same-session-native',
            generation,
            mediaTimeMicroseconds: secondsToMicroseconds(5),
            preserveHTMLSession: true,
            reason: 'audio-output-failed'
        } ]);
        expect(harness.controller.getTelemetry()).toMatchObject({
            audioOutputSwitchPending: false,
            fallbackReason: 'audio-output-failed',
            lastErrorMessage: 'The decode worker rejected the audio resync',
            state: 'fallback'
        });
        expect(audioOutput.setPlaying).not.toHaveBeenCalledWith(true);
        await harness.controller.destroy();
    });

    it('falls back in the same session when the output cannot rebuild its layout', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(
            harness,
            true,
            {},
            FIVE_POINT_ONE_DOWNMIX_CONFIGURATION
        );
        const audioOutput = requireAudioOutput(harness);
        audioOutput.reconfigure.mockRejectedValueOnce(
            new Error('AudioWorklet output reconfiguration failed')
        );
        audioOutput.setPlaying.mockClear();

        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(false);

        expect(audioOutput.reconfigure).toHaveBeenCalledOnce();
        expect(harness.fallbackRequests).toEqual([ expect.objectContaining({
            disposition: 'same-session-native',
            generation,
            reason: 'audio-output-failed'
        }) ]);
        expect(harness.controller.getTelemetry()).toMatchObject({
            audioOutputSwitchPending: false,
            state: 'fallback'
        });
        // The failed stage is not restarted when the session then declines the resync
        expect(audioOutput.setPlaying).not.toHaveBeenCalledWith(true);
        await harness.controller.destroy();
    });

    it('falls back in the same session when the switched audio never fills', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(
            harness,
            true,
            {},
            FIVE_POINT_ONE_DOWNMIX_CONFIGURATION
        );
        const audioOutput = requireAudioOutput(harness);
        audioOutput.setPlaying.mockClear();
        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(true);

        await vi.advanceTimersByTimeAsync(AUDIO_OUTPUT_SWITCH_TIMEOUT_MILLISECONDS - 1);
        expect(harness.fallbackRequests).toHaveLength(0);
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(true);
        await vi.advanceTimersByTimeAsync(1);

        expect(harness.fallbackRequests).toEqual([ expect.objectContaining({
            disposition: 'same-session-native',
            generation,
            reason: 'audio-output-failed'
        }) ]);
        expect(harness.controller.getTelemetry()).toMatchObject({
            audioOutputSwitchPending: false,
            lastErrorMessage: 'The decoded audio output switch exceeded its bounded timeout',
            state: 'fallback'
        });
        // A late fill belongs to the abandoned generation and never starts the output
        harness.videoDecodeSession.emit({
            audioEpoch: harness.videoDecodeSession.getTelemetry().audioEpoch,
            generation,
            type: 'audio-resynced'
        });
        expect(audioOutput.setPlaying).not.toHaveBeenCalledWith(true);
        await harness.controller.destroy();
    });

    it('abandons a pending switch when a seek restarts the generation', async () => {
        const harness = createControllerHarness(true, {
            startupTimeoutMicroseconds: secondsToMicroseconds(1)
        });
        await startReadyPlayback(harness, true, {}, FIVE_POINT_ONE_DOWNMIX_CONFIGURATION);
        const audioOutput = requireAudioOutput(harness);
        harness.setMonotonicTime(secondsToMicroseconds(12));
        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(true);
        // The new audio has filled and waits for its target
        harness.videoDecodeSession.completeAudioResync();
        audioOutput.setPlaying.mockClear();

        const seekPromise = harness.controller.seek(secondsToMicroseconds(40));
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(false);
        await vi.advanceTimersByTimeAsync(AUDIO_OUTPUT_SWITCH_LEAD_MILLISECONDS);

        expect(audioOutput.setPlaying).not.toHaveBeenCalledWith(true);
        expect(harness.controller.playbackState).toBe('seeking');
        expect(harness.fallbackRequests).toHaveLength(0);
        await harness.controller.destroy();
        await expect(seekPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it('resolves false without restarting audio when destroyed during the resync', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true, {}, FIVE_POINT_ONE_DOWNMIX_CONFIGURATION);
        const audioOutput = requireAudioOutput(harness);
        const resync = createDeferred<number | null>();
        harness.videoDecodeSession.resyncAudio.mockImplementationOnce(
            (): Promise<number | null> => resync.promise
        );
        audioOutput.setPlaying.mockClear();
        const switchPromise = harness.controller.reconfigureAudioOutput(
            FIVE_POINT_ONE_OUTPUT_OPTIONS
        );
        await flushAsyncWork();
        expect(harness.videoDecodeSession.resyncAudio).toHaveBeenCalledOnce();

        await harness.controller.destroy();
        resync.resolve(1);

        await expect(switchPromise).resolves.toBe(false);
        expect(harness.controller.getTelemetry().audioOutputSwitchPending).toBe(false);
        await vi.advanceTimersByTimeAsync(AUDIO_OUTPUT_SWITCH_TIMEOUT_MILLISECONDS);
        expect(audioOutput.setPlaying).not.toHaveBeenCalledWith(true);
        expect(audioOutput.destroy).toHaveBeenCalledOnce();
        expect(harness.fallbackRequests).toHaveLength(0);
    });

    it('drops a pending switch when another failure falls back first', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(
            harness,
            true,
            {},
            FIVE_POINT_ONE_DOWNMIX_CONFIGURATION
        );
        const audioOutput = requireAudioOutput(harness);
        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(true);
        audioOutput.setPlaying.mockClear();

        harness.videoDecodeSession.emit({
            failureKind: 'decode-failed',
            generation,
            message: 'simulated video decode failure',
            type: 'error'
        });
        await vi.advanceTimersByTimeAsync(AUDIO_OUTPUT_SWITCH_TIMEOUT_MILLISECONDS);

        expect(harness.fallbackRequests).toEqual([ expect.objectContaining({
            disposition: 'renegotiate-source',
            generation,
            reason: 'decode-failed'
        }) ]);
        expect(harness.controller.getTelemetry()).toMatchObject({
            audioOutputSwitchPending: false,
            fallbackReason: 'decode-failed',
            state: 'fallback'
        });
        expect(audioOutput.setPlaying).not.toHaveBeenCalledWith(true);
        await harness.controller.destroy();
    });

    it('starts the switched output at once when the stream ends during the switch', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(
            harness,
            true,
            {},
            FIVE_POINT_ONE_DOWNMIX_CONFIGURATION
        );
        const audioOutput = requireAudioOutput(harness);
        harness.setMonotonicTime(secondsToMicroseconds(12));
        await expect(harness.controller.reconfigureAudioOutput(FIVE_POINT_ONE_OUTPUT_OPTIONS))
            .resolves.toBe(true);
        audioOutput.setPlaying.mockClear();

        // A tail shorter than the resync fill minimum never reports audio-resynced
        harness.videoDecodeSession.emit({ generation, type: 'ended' });

        expect(audioOutput.setPlaying.mock.calls).toEqual([ [ true ] ]);
        expect(harness.controller.getTelemetry()).toMatchObject({
            audioOutputSwitchPending: false,
            state: 'playing'
        });
        await vi.advanceTimersByTimeAsync(AUDIO_OUTPUT_SWITCH_TIMEOUT_MILLISECONDS);
        expect(harness.fallbackRequests).toHaveLength(0);
        await harness.controller.destroy();
    });

    it('holds a new generation audio bridge until an in-flight rebuild settles', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true, {}, FIVE_POINT_ONE_DOWNMIX_CONFIGURATION);
        const audioOutput = requireAudioOutput(harness);
        const {
            audioPreparation,
            rebuild,
            seekPromise,
            switchPromise
        } = await seekDuringOutputRebuild(harness);
        const rebuiltBridge = new FakeAudioBridge(audioOutput.generation);

        rebuild.resolve(rebuiltBridge as unknown as CustomDecodeAudioBridge);

        // The new generation adopts the rebuilt 5.1 stage instead of opening another output
        await expect(audioPreparation).resolves.toBe(rebuiltBridge);
        expect(audioOutput.setVolume).not.toHaveBeenCalled();
        await expect(switchPromise).resolves.toBe(false);
        await harness.controller.destroy();
        await expect(seekPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it('releases a waiting audio bridge when an in-flight rebuild fails', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true, {}, FIVE_POINT_ONE_DOWNMIX_CONFIGURATION);
        const audioOutput = requireAudioOutput(harness);
        const {
            audioPreparation,
            rebuild,
            seekPromise,
            switchPromise
        } = await seekDuringOutputRebuild(harness);

        rebuild.reject(new Error('AudioWorklet output reconfiguration failed'));

        // The new generation opens its own output instead of inheriting the failure
        await expect(audioPreparation).resolves.toBe(harness.audioBridge);
        expect(audioOutput.setVolume).toHaveBeenCalledOnce();
        await expect(switchPromise).resolves.toBe(false);
        expect(harness.fallbackRequests).toHaveLength(0);
        await harness.controller.destroy();
        await expect(seekPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it('reports output device changes with the maximum channel count of the device', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(harness, true);
        const audioOutput = requireAudioOutput(harness);
        expect(audioOutput.outputDeviceListenerCount).toBe(1);

        // An output without a channel probe reports an unknown maximum
        expect(harness.controller.getAudioOutputMaximumChannelCount()).toBeNull();
        audioOutput.emitOutputDeviceChange();
        audioOutput.reportMaximumChannelCount(8);
        audioOutput.emitOutputDeviceChange();

        expect(harness.controller.getAudioOutputMaximumChannelCount()).toBe(8);
        expect(harness.events.filter(event => event.type === 'audio-output-changed')).toEqual([
            { generation, maximumChannelCount: null, type: 'audio-output-changed' },
            { generation, maximumChannelCount: 8, type: 'audio-output-changed' }
        ]);

        // Without an active generation there is no playback to report a change for
        expect(harness.controller.setPlaybackRate(2)).toBe(false);
        audioOutput.emitOutputDeviceChange();
        expect(harness.events.filter(event => event.type === 'audio-output-changed'))
            .toHaveLength(2);

        await harness.controller.destroy();
        expect(audioOutput.outputDeviceListenerCount).toBe(0);
    });

    it('moves device change reporting to a replacement output', async () => {
        const audioOutputs: FakeAudioOutput[] = [];
        const harness = createControllerHarness(true, {
            audioOutputFactory: (
                configuration: DecodeWorkerAudioConfiguration
            ): CustomAudioOutputBinding => {
                const audioOutput = new FakeAudioOutput();
                audioOutput.reportMaximumChannelCount(configuration.channelCount);
                audioOutputs.push(audioOutput);
                return {
                    bridge: new FakeAudioBridge(
                        audioOutput.generation
                    ) as unknown as CustomDecodeAudioBridge,
                    configuration: { ...configuration },
                    output: audioOutput
                };
            }
        });
        await startReadyPlayback(harness, true);
        const seekPromise = harness.controller.seek(secondsToMicroseconds(40));
        await flushAsyncWork();
        const seekGeneration = harness.videoDecodeSession.starts.at(-1)?.generation;

        // A new layout without a live rebuild replaces the output
        await harness.videoDecodeSession.prepareAudio(FIVE_POINT_ONE_OUTPUT_CONFIGURATION);
        expect(audioOutputs).toHaveLength(2);
        const [ firstOutput, replacementOutput ] = audioOutputs;
        expect(firstOutput.destroy).toHaveBeenCalledOnce();
        expect(firstOutput.outputDeviceListenerCount).toBe(0);
        expect(replacementOutput.outputDeviceListenerCount).toBe(1);

        firstOutput.emitOutputDeviceChange();
        replacementOutput.emitOutputDeviceChange();

        expect(harness.events.filter(event => event.type === 'audio-output-changed')).toEqual([
            { generation: seekGeneration, maximumChannelCount: 6, type: 'audio-output-changed' }
        ]);
        expect(harness.controller.getAudioOutputMaximumChannelCount()).toBe(6);
        await harness.controller.destroy();
        expect(replacementOutput.outputDeviceListenerCount).toBe(0);
        await expect(seekPromise).resolves.toMatchObject({ status: 'stopped' });
    });
});
