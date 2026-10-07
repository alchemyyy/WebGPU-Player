import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    microsecondsToMilliseconds,
    secondsToMicroseconds
} from 'webgpu-player/MediaTime';
import { WebGPUAudioOutputManager } from 'webgpu-player/audio/output/WebGPUAudioOutputManager';
import type { AudioWorkletOutputController } from 'webgpu-player/audio/output/AudioWorkletController';
import type { AudioWorkletTelemetry } from 'webgpu-player/audio/output/AudioWorkletProtocol';
import type { CustomAudioOutput } from 'webgpu-player/pipeline/CustomPlaybackControllerTypes';
import type { DecodeWorkerAudioConfiguration } from 'webgpu-player/pipeline/DecodeWorkerProtocol';

const audioWorkletMockState = vi.hoisted(() => ({
    create: vi.fn()
}));

vi.mock('webgpu-player/audio/output/AudioWorkletController', async importOriginal => {
    const originalModule = await importOriginal<typeof import('webgpu-player/audio/output/AudioWorkletController')>();
    return {
        ...originalModule,
        default: class MockAudioWorkletController {
            static readonly create = audioWorkletMockState.create;
        }
    };
});

vi.mock('webgpu-player/audio/output/CustomDecodeAudioBridge', () => ({
    default: class MockCustomDecodeAudioBridge {
        public constructor(public readonly controller: object) {}
    }
}));

import { createBrowserCustomAudioOutputFactory } from 'webgpu-player/audio/output/BrowserCustomAudioOutput';
import CustomDecodeAudioBridge from 'webgpu-player/audio/output/CustomDecodeAudioBridge';
import { prewarmBrowserAudioContext } from 'webgpu-player/audio/output/BrowserAudioContextPrewarm';
import {
    acquireSharedBrowserAudioContext,
    closeIdleSharedBrowserAudioContexts
} from 'webgpu-player/audio/output/BrowserAudioContextPool';
import {
    AUDIO_WORKLET_RETIREMENT_TIMEOUT_MICROSECONDS,
    DEFAULT_BROWSER_AUDIO_OPERATION_TIMEOUT_MICROSECONDS,
    SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS,
    waitForBrowserAudioOperation
} from 'webgpu-player/audio/output/BrowserAudioOperation';

// Keeps the output manager's recovery poll from firing during a test
const OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS = 3_600_000;

let fakeMaximumChannelCount = 2;

type AudioSinkId = string | Readonly<{ type: 'none' }>;

// AudioContext.setSinkId settles a request for the current sink without touching the output
function isSameAudioSink(currentSinkId: AudioSinkId, requestedSinkId: AudioSinkId): boolean {
    if (typeof currentSinkId === 'string' || typeof requestedSinkId === 'string') {
        return currentSinkId === requestedSinkId;
    }
    return currentSinkId.type === requestedSinkId.type;
}

class FakeAudioContext extends EventTarget {
    public static readonly instances: FakeAudioContext[] = [];
    public baseLatency = 0.01;
    public readonly close = vi.fn((): Promise<void> => Promise.resolve());
    public readonly destination = {
        channelCount: 2,
        maxChannelCount: fakeMaximumChannelCount
    } as AudioDestinationNode;
    public readonly getOutputTimestamp = vi.fn((): AudioTimestamp => ({
        contextTime: 9.95,
        performanceTime: 1_000
    }));
    public readonly resume = vi.fn((): Promise<void> => {
        this.state = 'running';
        return Promise.resolve();
    });
    public readonly sampleRate: number;
    public readonly setSinkId = vi.fn((sinkId: AudioSinkId): Promise<void> => {
        if (isSameAudioSink(this.sinkId, sinkId)) {
            return Promise.resolve();
        }
        this.sinkId = typeof sinkId === 'string' ? sinkId : { type: sinkId.type };
        return Promise.resolve();
    });
    public sinkId: AudioSinkId = '';
    public currentTime = 10;
    public outputLatency = 0.04;
    public state: AudioContextState = 'suspended';
    public readonly suspend = vi.fn((): Promise<void> => {
        this.state = 'suspended';
        return Promise.resolve();
    });

    public constructor(public readonly options?: AudioContextOptions) {
        super();
        this.sampleRate = options?.sampleRate ?? 48_000;
        FakeAudioContext.instances.push(this);
    }
}

class FakeMediaDevices extends EventTarget {
    public devices: MediaDeviceInfo[] = [];
    public readonly enumerateDevices = vi.fn(
        (): Promise<MediaDeviceInfo[]> => Promise.resolve([ ...this.devices ])
    );
}

type WorkletControllerHarness = {
    configuration: {
        channelCount: number
        maxBufferedFrames: number
        maxChunks: number
        sampleRate: number
        telemetryIntervalFrames: number
    }
    deactivate: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    emitTelemetry: (telemetry: AudioWorkletTelemetry) => void
    enqueue: ReturnType<typeof vi.fn>
    flush: ReturnType<typeof vi.fn>
    generation: number
    getTelemetry: ReturnType<typeof vi.fn>
    onTelemetry: ReturnType<typeof vi.fn>
    seek: ReturnType<typeof vi.fn>
    setMuted: ReturnType<typeof vi.fn>
    setPlaying: ReturnType<typeof vi.fn>
    setVolume: ReturnType<typeof vi.fn>
};

type Deferred = {
    promise: Promise<void>
    resolve: () => void
};

type WorkletControllerDeferred = {
    promise: Promise<WorkletControllerHarness>
    resolve: (controller: WorkletControllerHarness) => void
};

function createDeferred(): Deferred {
    let resolver: (() => void) | null = null;
    const promise = new Promise<void>((resolve): void => {
        resolver = resolve;
    });
    return {
        promise,
        resolve: (): void => {
            if (!resolver) {
                throw new Error('Deferred resolver is unavailable');
            }
            resolver();
        }
    };
}

function createWorkletControllerDeferred(): WorkletControllerDeferred {
    let resolver: ((controller: WorkletControllerHarness) => void) | null = null;
    const promise = new Promise<WorkletControllerHarness>((resolve): void => {
        resolver = resolve;
    });
    return {
        promise,
        resolve: (controller: WorkletControllerHarness): void => {
            if (!resolver) {
                throw new Error('Worklet controller deferred resolver is unavailable');
            }
            resolver(controller);
        }
    };
}

function createWorkletController(channelCount = 2): WorkletControllerHarness {
    const telemetryListeners = new Set<(telemetry: AudioWorkletTelemetry) => void>();
    return {
        configuration: {
            channelCount,
            maxBufferedFrames: 96_000,
            maxChunks: 1_024,
            sampleRate: 48_000,
            telemetryIntervalFrames: 4_096
        },
        deactivate: vi.fn((): Promise<void> => Promise.resolve()),
        destroy: vi.fn((): Promise<void> => Promise.resolve()),
        emitTelemetry: (telemetry: AudioWorkletTelemetry): void => {
            for (const listener of telemetryListeners) {
                listener(telemetry);
            }
        },
        generation: 1,
        getTelemetry: vi.fn((): AudioWorkletTelemetry | null => null),
        enqueue: vi.fn(),
        flush: vi.fn((): number => 2),
        onTelemetry: vi.fn((listener: (telemetry: AudioWorkletTelemetry) => void): (() => void) => {
            telemetryListeners.add(listener);
            return (): void => {
                telemetryListeners.delete(listener);
            };
        }),
        seek: vi.fn((): number => 2),
        setMuted: vi.fn(),
        setPlaying: vi.fn(),
        setVolume: vi.fn()
    };
}

function createTelemetry(
    overrides: Partial<AudioWorkletTelemetry> = {}
): AudioWorkletTelemetry {
    return {
        consumedFrames: 4_096,
        droppedFrames: 0,
        generation: 1,
        hasPhysicalOutputTimeCorrelation: false,
        mediaTimeContextTimeMicroseconds: secondsToMicroseconds(10),
        mediaTimeMicroseconds: secondsToMicroseconds(5),
        muted: false,
        outputFrames: 4_096,
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
        ...overrides
    };
}

// Chromium lists one blank entry while any output device exists, even without permission
function createBlankAudioOutputDevice(): MediaDeviceInfo {
    return {
        deviceId: '',
        groupId: '',
        kind: 'audiooutput',
        label: '',
        toJSON: (): object => ({})
    } as MediaDeviceInfo;
}

// The context pool probes the page's media devices whenever it creates a context
function stubPageMediaDevices(): FakeMediaDevices {
    const mediaDevices = new FakeMediaDevices();
    vi.stubGlobal('navigator', { mediaDevices });
    return mediaDevices;
}

function createAudioOutputManager(mediaDevices: FakeMediaDevices): WebGPUAudioOutputManager {
    return new WebGPUAudioOutputManager({
        getMediaDevices: (): MediaDevices => mediaDevices as unknown as MediaDevices,
        outputRecoveryPollIntervalMilliseconds: OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS
    });
}

// The mocked bridge keeps the worklet output it was created for
type MockAudioBridge = {
    readonly controller: AudioWorkletOutputController
};

function createAudioConfiguration(channelCount: number): DecodeWorkerAudioConfiguration {
    return {
        channelCount,
        codec: 'eac3',
        sampleRate: 48_000
    };
}

function getBridgeOutput(bridge: unknown): AudioWorkletOutputController {
    return (bridge as MockAudioBridge).controller;
}

function reconfigureOutput(
    output: CustomAudioOutput,
    configuration: DecodeWorkerAudioConfiguration
): Promise<CustomDecodeAudioBridge> {
    if (!output.reconfigure) {
        throw new Error('Browser audio output cannot change its layout');
    }
    return output.reconfigure(configuration);
}

function subscribeOutputDeviceChange(
    output: CustomAudioOutput,
    listener: () => void
): () => void {
    if (!output.onOutputDeviceChange) {
        throw new Error('Browser audio output does not report device changes');
    }
    return output.onOutputDeviceChange(listener);
}

describe('BrowserCustomAudioOutput', () => {
    beforeEach(() => {
        FakeAudioContext.instances.length = 0;
        fakeMaximumChannelCount = 2;
        audioWorkletMockState.create.mockReset();
        vi.stubGlobal('AudioContext', FakeAudioContext);
    });

    afterEach(async () => {
        await closeIdleSharedBrowserAudioContexts().catch((): void => undefined);
        vi.unstubAllGlobals();
    });

    it('creates an exact-rate bounded worklet output on the shared context', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const factory = createBrowserCustomAudioOutputFactory();

        const binding = await factory({
            channelCount: 2,
            codec: 'flac',
            sampleRate: 48_000
        });

        const audioContext = FakeAudioContext.instances[0];
        expect(audioContext.options).toEqual({
            latencyHint: 'playback',
            sampleRate: 48_000
        });
        expect(audioWorkletMockState.create).toHaveBeenCalledWith(audioContext, {
            channelCount: 2,
            maxBufferedFrames: 96_000,
            maxChunks: 1_024,
            telemetryIntervalFrames: 4_096
        });
        expect(audioContext.resume).toHaveBeenCalledOnce();
        expect(audioContext.setSinkId).toHaveBeenCalledWith('');
        expect(audioContext.setSinkId.mock.invocationCallOrder[0]).toBeLessThan(
            audioWorkletMockState.create.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
        );
        expect(binding.configuration).toEqual({
            channelCount: 2,
            codec: 'flac',
            sampleRate: 48_000
        });
        expect(binding.output.getEstimatedOutputLatencyMicroseconds?.()).toBe(50_000);

        binding.output.setVolume(0.5);
        binding.output.setMuted(true);
        await binding.output.setPlaying(true);
        await binding.output.destroy();
        await binding.output.destroy();

        expect(workletController.setVolume).toHaveBeenCalledWith(0.5);
        expect(workletController.setMuted).toHaveBeenCalledWith(true);
        expect(workletController.setPlaying).toHaveBeenCalledWith(true);
        expect(workletController.deactivate).toHaveBeenCalledOnce();
        expect(workletController.destroy).not.toHaveBeenCalled();
        expect(audioContext.close).not.toHaveBeenCalled();
        expect(audioContext.suspend).toHaveBeenCalledOnce();
    });

    it('keeps repeated output creation and destruction bounded to one context', async () => {
        const workletControllers: WorkletControllerHarness[] = [];
        audioWorkletMockState.create.mockImplementation((): WorkletControllerHarness => {
            const workletController = createWorkletController();
            workletControllers.push(workletController);
            return workletController;
        });

        for (let sessionIndex = 0; sessionIndex < 10; sessionIndex += 1) {
            const prewarm = prewarmBrowserAudioContext(48_000);
            const binding = await createBrowserCustomAudioOutputFactory(prewarm)({
                channelCount: 2,
                codec: 'aac',
                sampleRate: 48_000
            });
            await binding.output.destroy();
        }

        expect(FakeAudioContext.instances).toHaveLength(1);
        expect(FakeAudioContext.instances[0].resume).toHaveBeenCalledTimes(10);
        expect(FakeAudioContext.instances[0].suspend).toHaveBeenCalledTimes(10);
        expect(FakeAudioContext.instances[0].close).not.toHaveBeenCalled();
        expect(workletControllers).toHaveLength(1);
        expect(workletControllers[0].deactivate).toHaveBeenCalledTimes(10);
        expect(workletControllers[0].destroy).not.toHaveBeenCalled();
    });

    it('reapplies default routing before reusing a warm pooled context', async () => {
        audioWorkletMockState.create.mockImplementation((): WorkletControllerHarness => (
            createWorkletController()
        ));
        const mediaDevices = new EventTarget() as EventTarget & {
            enumerateDevices: () => Promise<MediaDeviceInfo[]>
        };
        mediaDevices.enumerateDevices = (): Promise<MediaDeviceInfo[]> => Promise.resolve([ {
            deviceId: 'speaker-a',
            groupId: '',
            kind: 'audiooutput',
            label: 'Speakers',
            toJSON: (): object => ({})
        } as MediaDeviceInfo ]);
        const audioOutputManager = new WebGPUAudioOutputManager({
            getMediaDevices: () => mediaDevices as unknown as MediaDevices,
            initialSelectedDeviceId: 'speaker-a'
        });
        const configuration = {
            channelCount: 2,
            codec: 'aac',
            sampleRate: 48_000
        } as const;
        const firstBinding = await createBrowserCustomAudioOutputFactory(
            null,
            audioOutputManager
        )(configuration);
        const audioContext = FakeAudioContext.instances[0];
        await firstBinding.output.destroy();
        expect(audioContext.setSinkId).toHaveBeenLastCalledWith('speaker-a');

        await audioOutputManager.setSelectedDeviceId(null);
        const secondBinding = await createBrowserCustomAudioOutputFactory(
            null,
            audioOutputManager
        )(configuration);

        expect(FakeAudioContext.instances).toHaveLength(1);
        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            'speaker-a',
            ''
        ]);
        await secondBinding.output.destroy();
        await audioOutputManager.destroy();
    });

    it('rebuilds the sink of a context created without an output device once one appears', async () => {
        audioWorkletMockState.create.mockImplementation((): WorkletControllerHarness => (
            createWorkletController()
        ));
        const mediaDevices = stubPageMediaDevices();
        const audioOutputManager = createAudioOutputManager(mediaDevices);
        const configuration = {
            channelCount: 2,
            codec: 'aac',
            sampleRate: 48_000
        } as const;
        try {
            const binding = await createBrowserCustomAudioOutputFactory(
                null,
                audioOutputManager
            )(configuration);
            const audioContext = FakeAudioContext.instances[0];
            expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([ '' ]);

            mediaDevices.devices = [ createBlankAudioOutputDevice() ];
            await audioOutputManager.refresh();
            expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
                '',
                { type: 'none' },
                ''
            ]);

            // The pool retires the context even though its sink was rebuilt
            await binding.output.destroy();
            expect(audioContext.close).toHaveBeenCalledOnce();
            expect(audioContext.suspend).not.toHaveBeenCalled();

            const nextBinding = await createBrowserCustomAudioOutputFactory(
                null,
                audioOutputManager
            )(configuration);
            expect(FakeAudioContext.instances).toHaveLength(2);
            const nextAudioContext = FakeAudioContext.instances[1];
            expect(nextAudioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([ '' ]);
            await nextBinding.output.destroy();
            expect(nextAudioContext.suspend).toHaveBeenCalledOnce();
            expect(nextAudioContext.close).not.toHaveBeenCalled();
        } finally {
            await audioOutputManager.destroy();
        }
    });

    it('registers a prewarmed context created without an output device for a sink rebuild', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const audioOutputManager = createAudioOutputManager(stubPageMediaDevices());
        const registerAudioContext = vi.spyOn(audioOutputManager, 'registerAudioContext');
        try {
            const prewarm = prewarmBrowserAudioContext(48_000);
            const binding = await createBrowserCustomAudioOutputFactory(
                prewarm,
                audioOutputManager
            )({
                channelCount: 2,
                codec: 'opus',
                sampleRate: 48_000
            });
            const audioContext = FakeAudioContext.instances[0];

            expect(FakeAudioContext.instances).toHaveLength(1);
            expect(registerAudioContext).toHaveBeenCalledExactlyOnceWith(
                audioContext,
                { createdWithoutOutputDevice: true }
            );
            await binding.output.destroy();
            expect(audioContext.close).toHaveBeenCalledOnce();
            expect(audioContext.suspend).not.toHaveBeenCalled();
        } finally {
            await audioOutputManager.destroy();
        }
    });

    it.each([
        { channelCount: 7, sampleRate: 48_000 },
        { channelCount: 2, sampleRate: 44_100 }
    ])('rejects an unmeasured output layout %#', async configuration => {
        const factory = createBrowserCustomAudioOutputFactory();

        await expect(factory({
            ...configuration,
            codec: 'flac'
        })).rejects.toThrow('Custom audio output requires 2, 6, or 8 channels at 48000 Hz');
        expect(FakeAudioContext.instances).toHaveLength(0);
        expect(audioWorkletMockState.create).not.toHaveBeenCalled();
    });

    it('closes an unused prewarm when rejecting an unmeasured layout', async () => {
        const prewarm = prewarmBrowserAudioContext(48_000);
        const factory = createBrowserCustomAudioOutputFactory(prewarm);

        await expect(factory({
            channelCount: 7,
            codec: 'ac3',
            sampleRate: 48_000
        })).rejects.toThrow('Custom audio output requires 2, 6, or 8 channels at 48000 Hz');

        // Releasing the last pooled reference suspends rather than closes the shared context
        expect(FakeAudioContext.instances[0].suspend).toHaveBeenCalledOnce();
        expect(FakeAudioContext.instances[0].close).not.toHaveBeenCalled();
        expect(audioWorkletMockState.create).not.toHaveBeenCalled();
    });

    it.each([ 6, 8 ] as const)(
        'creates a native $channelCount-channel output only on a matching destination',
        async channelCount => {
            fakeMaximumChannelCount = channelCount;
            const workletController = createWorkletController(channelCount);
            audioWorkletMockState.create.mockResolvedValue(workletController);
            const binding = await createBrowserCustomAudioOutputFactory()({
                channelCount,
                codec: 'flac',
                sampleRate: 48_000
            });

            expect(FakeAudioContext.instances[0].destination.channelCount).toBe(channelCount);
            expect(audioWorkletMockState.create).toHaveBeenCalledWith(
                FakeAudioContext.instances[0],
                expect.objectContaining({ channelCount })
            );

            await binding.output.destroy();
        }
    );

    it('rejects multichannel output when the current destination is stereo', async () => {
        const factory = createBrowserCustomAudioOutputFactory();

        await expect(factory({
            channelCount: 6,
            codec: 'flac',
            sampleRate: 48_000
        })).rejects.toThrow('Audio destination exposes 2 channels, not 6');

        expect(audioWorkletMockState.create).not.toHaveBeenCalled();
    });

    it('maps raw worklet time to the sample currently reaching physical output', async () => {
        const workletController = createWorkletController();
        const rawTelemetry = createTelemetry();
        workletController.getTelemetry.mockReturnValue(rawTelemetry);
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const mappedListener = vi.fn();
        const rawListener = vi.fn();
        binding.output.onTelemetry(mappedListener);
        workletController.onTelemetry(rawListener);

        expect(binding.output.getTelemetry()).toEqual({
            ...rawTelemetry,
            hasPhysicalOutputTimeCorrelation: true,
            mediaTimeMicroseconds: secondsToMicroseconds(4.95)
        });

        workletController.emitTelemetry(rawTelemetry);
        expect(mappedListener).toHaveBeenCalledWith({
            ...rawTelemetry,
            hasPhysicalOutputTimeCorrelation: true,
            mediaTimeMicroseconds: secondsToMicroseconds(4.95)
        });
        expect(rawListener).toHaveBeenCalledWith(rawTelemetry);

        await binding.output.destroy();
    });

    it('holds a signed flush anchor until physical output correlation is available', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];
        const mappedListener = vi.fn();
        binding.output.onTelemetry(mappedListener);
        const mediaFloorMicroseconds = secondsToMicroseconds(-0.5);
        const flushTelemetry = createTelemetry({
            mediaTimeContextTimeMicroseconds: null,
            mediaTimeMicroseconds: mediaFloorMicroseconds,
            reason: 'flush'
        });
        const uncorrelatedTelemetry = createTelemetry({
            mediaTimeMicroseconds: secondsToMicroseconds(-0.4)
        });

        workletController.emitTelemetry(flushTelemetry);
        audioContext.getOutputTimestamp.mockReturnValue({ contextTime: 0, performanceTime: 0 });
        workletController.getTelemetry.mockReturnValue(uncorrelatedTelemetry);
        workletController.emitTelemetry(uncorrelatedTelemetry);

        expect(binding.output.getTelemetry()).toEqual({
            ...uncorrelatedTelemetry,
            mediaTimeMicroseconds: mediaFloorMicroseconds
        });
        expect(mappedListener).toHaveBeenLastCalledWith({
            ...uncorrelatedTelemetry,
            mediaTimeMicroseconds: mediaFloorMicroseconds
        });

        await binding.output.destroy();
    });

    it('clamps a valid physical-output mapping to the flush media floor', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];
        const mediaFloorMicroseconds = secondsToMicroseconds(5);
        workletController.emitTelemetry(createTelemetry({
            mediaTimeContextTimeMicroseconds: null,
            mediaTimeMicroseconds: mediaFloorMicroseconds,
            reason: 'flush'
        }));
        const startupTelemetry = createTelemetry({
            mediaTimeContextTimeMicroseconds: secondsToMicroseconds(10.02),
            mediaTimeMicroseconds: secondsToMicroseconds(5.02)
        });
        workletController.getTelemetry.mockReturnValue(startupTelemetry);

        expect(binding.output.getTelemetry()).toEqual({
            ...startupTelemetry,
            hasPhysicalOutputTimeCorrelation: true,
            mediaTimeMicroseconds: mediaFloorMicroseconds
        });

        audioContext.currentTime = 10.25;
        audioContext.getOutputTimestamp.mockReturnValue({
            contextTime: 10.05,
            performanceTime: 1_000
        });
        const progressingTelemetry = createTelemetry({
            mediaTimeContextTimeMicroseconds: secondsToMicroseconds(10.2),
            mediaTimeMicroseconds: secondsToMicroseconds(5.2)
        });
        workletController.getTelemetry.mockReturnValue(progressingTelemetry);
        expect(binding.output.getTelemetry()).toEqual({
            ...progressingTelemetry,
            hasPhysicalOutputTimeCorrelation: true,
            mediaTimeMicroseconds: secondsToMicroseconds(5.05)
        });

        await binding.output.destroy();
    });

    it('resets the startup anchor on every flush and worklet generation', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];
        audioContext.getOutputTimestamp.mockReturnValue({ contextTime: 0, performanceTime: 0 });

        workletController.emitTelemetry(createTelemetry({
            mediaTimeContextTimeMicroseconds: null,
            mediaTimeMicroseconds: secondsToMicroseconds(5),
            reason: 'flush'
        }));
        workletController.emitTelemetry(createTelemetry({
            mediaTimeContextTimeMicroseconds: null,
            mediaTimeMicroseconds: secondsToMicroseconds(6),
            reason: 'flush'
        }));
        const sameGenerationTelemetry = createTelemetry({
            mediaTimeMicroseconds: secondsToMicroseconds(6.1)
        });
        workletController.getTelemetry.mockReturnValue(sameGenerationTelemetry);
        expect(binding.output.getTelemetry()?.mediaTimeMicroseconds).toBe(6_000_000);

        const unanchoredNextGenerationTelemetry = createTelemetry({
            generation: 2,
            mediaTimeMicroseconds: secondsToMicroseconds(42)
        });
        workletController.emitTelemetry(unanchoredNextGenerationTelemetry);
        workletController.getTelemetry.mockReturnValue(unanchoredNextGenerationTelemetry);
        expect(binding.output.getTelemetry()?.mediaTimeMicroseconds).toBe(42_000_000);

        workletController.emitTelemetry(createTelemetry({
            generation: 2,
            mediaTimeContextTimeMicroseconds: null,
            mediaTimeMicroseconds: secondsToMicroseconds(41),
            reason: 'flush'
        }));
        workletController.getTelemetry.mockReturnValue(unanchoredNextGenerationTelemetry);
        expect(binding.output.getTelemetry()?.mediaTimeMicroseconds).toBe(41_000_000);

        await binding.output.destroy();
    });

    it('never extrapolates beyond the latest rendered media sample', async () => {
        const workletController = createWorkletController();
        const rawTelemetry = createTelemetry({ reason: 'underflow' });
        workletController.getTelemetry.mockReturnValue(rawTelemetry);
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];
        audioContext.currentTime = 10.1;
        audioContext.getOutputTimestamp.mockReturnValue({
            contextTime: 10.05,
            performanceTime: 1_000
        });

        expect(binding.output.getTelemetry()).toEqual({
            ...rawTelemetry,
            hasPhysicalOutputTimeCorrelation: true
        });

        await binding.output.destroy();
    });

    it('falls back to raw time for unavailable, zero, invalid, or unbounded timestamps', async () => {
        const workletController = createWorkletController();
        const rawTelemetry = createTelemetry();
        workletController.getTelemetry.mockReturnValue(rawTelemetry);
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];

        audioContext.getOutputTimestamp.mockReturnValue({ contextTime: 0, performanceTime: 0 });
        expect(binding.output.getTelemetry()).toEqual(rawTelemetry);

        audioContext.getOutputTimestamp.mockReturnValue({
            contextTime: 7,
            performanceTime: 1_000
        });
        expect(binding.output.getTelemetry()).toEqual(rawTelemetry);

        audioContext.currentTime = 9;
        audioContext.getOutputTimestamp.mockReturnValue({
            contextTime: 9.5,
            performanceTime: 1_000
        });
        expect(binding.output.getTelemetry()).toEqual(rawTelemetry);

        audioContext.currentTime = 10;
        audioContext.getOutputTimestamp.mockImplementation((): AudioTimestamp => {
            throw new Error('Timestamp unavailable');
        });
        expect(binding.output.getTelemetry()).toEqual(rawTelemetry);

        await binding.output.destroy();
    });

    it('consumes a matching prewarmed context without a second resume', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const prewarm = prewarmBrowserAudioContext(48_000);
        const binding = await createBrowserCustomAudioOutputFactory(prewarm)({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];

        expect(FakeAudioContext.instances).toHaveLength(1);
        expect(audioContext.resume).toHaveBeenCalledOnce();
        await prewarm.close();
        expect(audioContext.close).not.toHaveBeenCalled();

        await binding.output.destroy();
        expect(audioContext.close).not.toHaveBeenCalled();
    });

    it('rejects a prewarmed context invalidated while its resume is pending', async () => {
        const resume = createDeferred();
        class PendingResumeAudioContext extends FakeAudioContext {
            public override readonly resume = vi.fn((): Promise<void> => resume.promise);
        }
        vi.stubGlobal('AudioContext', PendingResumeAudioContext);
        const prewarm = prewarmBrowserAudioContext(48_000);
        const factoryResult = createBrowserCustomAudioOutputFactory(prewarm)({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const invalidatingReference = acquireSharedBrowserAudioContext(48_000);

        await invalidatingReference.invalidate();
        resume.resolve();

        await expect(factoryResult).rejects.toThrow(
            'AudioContext was invalidated while preparing custom audio output'
        );
        expect(audioWorkletMockState.create).not.toHaveBeenCalled();
        expect(FakeAudioContext.instances[0].close).toHaveBeenCalledOnce();
    });

    it('closes a mismatched prewarm before creating the decoded exact rate', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const prewarm = prewarmBrowserAudioContext(44_100);
        const binding = await createBrowserCustomAudioOutputFactory(prewarm)({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });

        expect(FakeAudioContext.instances).toHaveLength(2);
        expect(FakeAudioContext.instances[0].close).toHaveBeenCalledOnce();
        expect(FakeAudioContext.instances[1].sampleRate).toBe(48_000);

        await binding.output.destroy();
        expect(FakeAudioContext.instances[1].close).not.toHaveBeenCalled();
    });

    it('reports a suspended context resume failure to the playback owner', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];
        audioContext.state = 'suspended';
        audioContext.resume.mockRejectedValueOnce(new Error('User activation required'));

        await expect(binding.output.setPlaying(true)).rejects.toThrow('User activation required');

        expect(workletController.setPlaying).toHaveBeenLastCalledWith(true);
        expect(audioContext.resume).toHaveBeenCalledTimes(2);
        await binding.output.destroy();
    });

    it('makes output destruction idempotent while leaving the shared context warm', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];
        const asynchronousOutput = binding.output as unknown as {
            destroy: () => Promise<void>
        };

        const firstDestroyPromise = asynchronousOutput.destroy();
        const secondDestroyPromise = asynchronousOutput.destroy();

        expect(secondDestroyPromise).toBe(firstDestroyPromise);
        await firstDestroyPromise;
        expect(workletController.deactivate).toHaveBeenCalledOnce();
        expect(workletController.destroy).not.toHaveBeenCalled();
        expect(audioContext.close).not.toHaveBeenCalled();
    });

    it('reports an explicit shared context teardown failure', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];
        audioContext.close.mockRejectedValueOnce(new Error('Context close failed'));

        await binding.output.destroy();
        await expect(closeIdleSharedBrowserAudioContexts()).rejects.toThrow(
            'Context close failed'
        );

        expect(workletController.deactivate).toHaveBeenCalledOnce();
        expect(workletController.destroy).not.toHaveBeenCalled();
        expect(audioContext.close).toHaveBeenCalledOnce();
    });

    it('invalidates the shared context when processor deactivation fails', async () => {
        const workletController = createWorkletController();
        workletController.deactivate.mockRejectedValueOnce(
            new Error('Processor deactivation failed')
        );
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];

        await expect(binding.output.destroy()).rejects.toThrow(
            'Processor deactivation failed'
        );

        expect(workletController.destroy).toHaveBeenCalledOnce();
        expect(audioContext.close).toHaveBeenCalledOnce();
    });

    it('overlaps failed processor retirement with bounded context close', async () => {
        vi.useFakeTimers();
        try {
            const workletController = createWorkletController();
            workletController.deactivate.mockImplementationOnce((): Promise<void> => (
                waitForBrowserAudioOperation(
                    new Promise<void>(() => undefined),
                    'AudioWorklet lease deactivation',
                    AUDIO_WORKLET_RETIREMENT_TIMEOUT_MICROSECONDS
                )
            ));
            workletController.destroy.mockImplementationOnce((): Promise<void> => (
                waitForBrowserAudioOperation(
                    new Promise<void>(() => undefined),
                    'AudioWorklet processor retirement',
                    AUDIO_WORKLET_RETIREMENT_TIMEOUT_MICROSECONDS
                )
            ));
            audioWorkletMockState.create.mockResolvedValue(workletController);
            const binding = await createBrowserCustomAudioOutputFactory()({
                channelCount: 2,
                codec: 'opus',
                sampleRate: 48_000
            });
            const audioContext = FakeAudioContext.instances[0];
            audioContext.close.mockReturnValueOnce(new Promise(() => undefined));

            const destroyResult = Promise.resolve(binding.output.destroy());
            const observedResult = destroyResult.catch((error: unknown): unknown => error);
            let destroySettled = false;
            const settleObservationPromise = observedResult.then((): void => {
                destroySettled = true;
            });
            const sequentialTimeoutMilliseconds = microsecondsToMilliseconds(
                AUDIO_WORKLET_RETIREMENT_TIMEOUT_MICROSECONDS
            ) + microsecondsToMilliseconds(
                SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS
            );
            expect(sequentialTimeoutMilliseconds).toBeLessThan(900);

            await vi.advanceTimersByTimeAsync(
                sequentialTimeoutMilliseconds - 1
            );
            expect(destroySettled).toBe(false);
            expect(audioContext.close).toHaveBeenCalledOnce();
            expect(workletController.destroy).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(1);

            expect(await observedResult).toEqual(
                new Error('AudioWorklet lease deactivation exceeded its bounded timeout')
            );
            await settleObservationPromise;
            expect(destroySettled).toBe(true);
            await vi.advanceTimersByTimeAsync(
                microsecondsToMilliseconds(AUDIO_WORKLET_RETIREMENT_TIMEOUT_MICROSECONDS)
                    - microsecondsToMilliseconds(SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS)
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects a browser context that cannot honor the decoded sample rate', async () => {
        class WrongRateAudioContext extends FakeAudioContext {
            public constructor(options?: AudioContextOptions) {
                super({ ...options, sampleRate: 44_100 });
            }
        }
        vi.stubGlobal('AudioContext', WrongRateAudioContext);
        const factory = createBrowserCustomAudioOutputFactory();

        await expect(factory({
            channelCount: 2,
            codec: 'aac',
            sampleRate: 48_000
        })).rejects.toThrow('requested audio sample rate');

        expect(FakeAudioContext.instances[0].close).toHaveBeenCalledOnce();
        expect(audioWorkletMockState.create).not.toHaveBeenCalled();
    });

    it('invalidates a worklet lease that resolves after creation times out', async () => {
        vi.useFakeTimers();
        try {
            const deferredCreation = createWorkletControllerDeferred();
            audioWorkletMockState.create.mockReturnValueOnce(deferredCreation.promise);
            const factoryResult = Promise.resolve(createBrowserCustomAudioOutputFactory()({
                channelCount: 2,
                codec: 'aac',
                sampleRate: 48_000
            }));
            const observedResult = factoryResult.catch((error: unknown): unknown => error);

            await vi.advanceTimersByTimeAsync(microsecondsToMilliseconds(
                DEFAULT_BROWSER_AUDIO_OPERATION_TIMEOUT_MICROSECONDS
            ));

            expect(await observedResult).toEqual(
                new Error('AudioWorklet output creation exceeded its bounded timeout')
            );
            const timedOutContext = FakeAudioContext.instances[0];
            expect(timedOutContext.close).toHaveBeenCalledOnce();

            const lateWorkletController = createWorkletController();
            deferredCreation.resolve(lateWorkletController);
            await vi.advanceTimersByTimeAsync(0);

            expect(lateWorkletController.destroy).toHaveBeenCalledOnce();
            expect(lateWorkletController.deactivate).not.toHaveBeenCalled();

            const replacementWorkletController = createWorkletController();
            audioWorkletMockState.create.mockResolvedValueOnce(replacementWorkletController);
            const replacementBinding = await createBrowserCustomAudioOutputFactory()({
                channelCount: 2,
                codec: 'aac',
                sampleRate: 48_000
            });
            expect(FakeAudioContext.instances[1]).not.toBe(timedOutContext);
            await replacementBinding.output.destroy();
            expect(replacementWorkletController.deactivate).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('invalidates a context whose initial resume times out', async () => {
        vi.useFakeTimers();
        try {
            class StalledResumeAudioContext extends FakeAudioContext {
                public override readonly resume = vi.fn(
                    (): Promise<void> => new Promise(() => undefined)
                );
            }
            vi.stubGlobal('AudioContext', StalledResumeAudioContext);
            const factoryResult = Promise.resolve(createBrowserCustomAudioOutputFactory()({
                channelCount: 2,
                codec: 'aac',
                sampleRate: 48_000
            }));
            const observedResult = factoryResult.catch((error: unknown): unknown => error);

            await vi.advanceTimersByTimeAsync(microsecondsToMilliseconds(
                DEFAULT_BROWSER_AUDIO_OPERATION_TIMEOUT_MICROSECONDS
            ));

            expect(await observedResult).toEqual(
                new Error('AudioContext resume exceeded its bounded timeout')
            );
            const poisonedContext = FakeAudioContext.instances[0];
            expect(poisonedContext.close).toHaveBeenCalledOnce();
            expect(audioWorkletMockState.create).not.toHaveBeenCalled();

            vi.stubGlobal('AudioContext', FakeAudioContext);
            const workletController = createWorkletController();
            audioWorkletMockState.create.mockResolvedValue(workletController);
            const replacementBinding = await createBrowserCustomAudioOutputFactory()({
                channelCount: 2,
                codec: 'aac',
                sampleRate: 48_000
            });
            expect(FakeAudioContext.instances[1]).not.toBe(poisonedContext);
            await replacementBinding.output.destroy();
        } finally {
            vi.useRealTimers();
        }
    });

    it('bounds a stalled context resume during playback', async () => {
        vi.useFakeTimers();
        try {
            const workletController = createWorkletController();
            audioWorkletMockState.create.mockResolvedValue(workletController);
            const binding = await createBrowserCustomAudioOutputFactory()({
                channelCount: 2,
                codec: 'opus',
                sampleRate: 48_000
            });
            const audioContext = FakeAudioContext.instances[0];
            audioContext.state = 'suspended';
            audioContext.resume.mockReturnValueOnce(new Promise(() => undefined));
            const resumeResult = Promise.resolve(binding.output.setPlaying(true));
            const observedResult = resumeResult.catch((error: unknown): unknown => error);

            await vi.advanceTimersByTimeAsync(microsecondsToMilliseconds(
                DEFAULT_BROWSER_AUDIO_OPERATION_TIMEOUT_MICROSECONDS
            ));

            expect(await observedResult).toEqual(
                new Error('AudioContext resume exceeded its bounded timeout')
            );
            await binding.output.destroy();
        } finally {
            vi.useRealTimers();
        }
    });

    it('bounds a stalled explicit shared context close', async () => {
        vi.useFakeTimers();
        try {
            const workletController = createWorkletController();
            audioWorkletMockState.create.mockResolvedValue(workletController);
            const binding = await createBrowserCustomAudioOutputFactory()({
                channelCount: 2,
                codec: 'flac',
                sampleRate: 48_000
            });
            FakeAudioContext.instances[0].close.mockReturnValueOnce(
                new Promise(() => undefined)
            );
            await binding.output.destroy();
            const closeResult = closeIdleSharedBrowserAudioContexts();
            const observedResult = closeResult.catch((error: unknown): unknown => error);

            await vi.advanceTimersByTimeAsync(microsecondsToMilliseconds(
                SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS
            ));

            expect(await observedResult).toEqual(
                new Error('Shared AudioContext close exceeded its bounded timeout')
            );
            expect(workletController.deactivate).toHaveBeenCalledOnce();
            expect(workletController.destroy).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('reconfigures the worklet layout in place and restores the output state', async () => {
        fakeMaximumChannelCount = 6;
        const stereoController = createWorkletController(2);
        const surroundController = createWorkletController(6);
        surroundController.generation = 2;
        audioWorkletMockState.create
            .mockResolvedValueOnce(stereoController)
            .mockResolvedValueOnce(surroundController);
        const binding = await createBrowserCustomAudioOutputFactory()(
            createAudioConfiguration(2)
        );
        const audioContext = FakeAudioContext.instances[0];
        const mappedListener = vi.fn();
        binding.output.onTelemetry(mappedListener);
        binding.output.setVolume(0.5);
        binding.output.setMuted(true);
        // The playback controller stops the output before it switches the layout
        await binding.output.setPlaying(false);
        expect(binding.output.generation).toBe(1);

        const bridge = await reconfigureOutput(binding.output, createAudioConfiguration(6));

        // The old lease retires before the pool replaces its mismatched node
        expect(stereoController.deactivate).toHaveBeenCalledOnce();
        expect(stereoController.destroy).toHaveBeenCalledOnce();
        expect(stereoController.deactivate.mock.invocationCallOrder[0])
            .toBeLessThan(stereoController.destroy.mock.invocationCallOrder[0]);
        expect(stereoController.destroy.mock.invocationCallOrder[0])
            .toBeLessThan(audioWorkletMockState.create.mock.invocationCallOrder[1]);
        expect(audioWorkletMockState.create).toHaveBeenCalledTimes(2);
        expect(audioWorkletMockState.create).toHaveBeenLastCalledWith(audioContext, {
            channelCount: 6,
            maxBufferedFrames: 96_000,
            maxChunks: 1_024,
            telemetryIntervalFrames: 4_096
        });
        expect(audioContext.destination.channelCount).toBe(6);
        expect(surroundController.setVolume).toHaveBeenCalledExactlyOnceWith(0.5);
        expect(surroundController.setMuted).toHaveBeenCalledExactlyOnceWith(true);
        // The new worklet takes the recorded stopped state
        expect(surroundController.setPlaying).toHaveBeenCalledExactlyOnceWith(false);
        expect(bridge).toBeInstanceOf(CustomDecodeAudioBridge);
        expect(bridge).not.toBe(binding.bridge);
        expect(getBridgeOutput(bridge).configuration.channelCount).toBe(6);
        expect(binding.output.generation).toBe(2);
        expect(() => getBridgeOutput(binding.bridge).setVolume(1)).toThrow(
            'Audio worklet lease is no longer active'
        );

        // Mapped telemetry follows only the new worklet
        stereoController.emitTelemetry(createTelemetry());
        expect(mappedListener).not.toHaveBeenCalled();
        surroundController.emitTelemetry(createTelemetry({ generation: 2 }));
        expect(mappedListener).toHaveBeenCalledOnce();

        await binding.output.destroy();
        expect(surroundController.deactivate).toHaveBeenCalledOnce();
        expect(surroundController.destroy).not.toHaveBeenCalled();
    });

    it.each([
        { channelCount: 7, sampleRate: 48_000 },
        { channelCount: 2, sampleRate: 44_100 }
    ])('rejects an unmeasured reconfiguration layout %# without touching the worklet', async configuration => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()(
            createAudioConfiguration(2)
        );

        await expect(reconfigureOutput(binding.output, {
            ...configuration,
            codec: 'flac'
        })).rejects.toThrow('Custom audio output requires 2, 6, or 8 channels at 48000 Hz');

        expect(workletController.deactivate).not.toHaveBeenCalled();
        expect(audioWorkletMockState.create).toHaveBeenCalledOnce();
        // The current worklet keeps serving the output
        binding.output.setVolume(0.25);
        expect(workletController.setVolume).toHaveBeenLastCalledWith(0.25);
        await binding.output.destroy();
    });

    it('rejects a reconfiguration the shared context rate cannot honor', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()(
            createAudioConfiguration(2)
        );
        // NOTE: A browser context never changes its rate, so the guard needs a forced mismatch
        (FakeAudioContext.instances[0] as { sampleRate: number }).sampleRate = 44_100;

        await expect(reconfigureOutput(binding.output, createAudioConfiguration(2)))
            .rejects.toThrow('The browser did not create the requested audio sample rate');

        expect(workletController.deactivate).not.toHaveBeenCalled();
        expect(audioWorkletMockState.create).toHaveBeenCalledOnce();
        await binding.output.destroy();
    });

    it('rejects a reconfiguration after destroy', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()(
            createAudioConfiguration(2)
        );
        await binding.output.destroy();

        await expect(reconfigureOutput(binding.output, createAudioConfiguration(2)))
            .rejects.toThrow('Browser audio output is destroyed');

        expect(workletController.deactivate).toHaveBeenCalledOnce();
        expect(audioWorkletMockState.create).toHaveBeenCalledOnce();
    });

    it('releases a late reconfigured lease when destroyed during the switch', async () => {
        fakeMaximumChannelCount = 6;
        const stereoController = createWorkletController(2);
        const deferredCreation = createWorkletControllerDeferred();
        audioWorkletMockState.create
            .mockResolvedValueOnce(stereoController)
            .mockReturnValueOnce(deferredCreation.promise);
        const binding = await createBrowserCustomAudioOutputFactory()(
            createAudioConfiguration(2)
        );
        const reconfigurationResult = reconfigureOutput(
            binding.output,
            createAudioConfiguration(6)
        );
        const observedResult = reconfigurationResult.catch((error: unknown): unknown => error);
        await vi.waitFor(() => expect(audioWorkletMockState.create).toHaveBeenCalledTimes(2));

        await binding.output.destroy();
        const lateController = createWorkletController(6);
        deferredCreation.resolve(lateController);

        expect(await observedResult).toEqual(
            new Error('Browser audio output was destroyed during reconfiguration')
        );
        expect(lateController.deactivate).toHaveBeenCalledOnce();
        expect(lateController.setVolume).not.toHaveBeenCalled();
        expect(lateController.setPlaying).not.toHaveBeenCalled();
        expect(stereoController.deactivate).toHaveBeenCalledOnce();
    });

    it('serializes overlapping reconfigurations so only the last layout keeps a lease', async () => {
        fakeMaximumChannelCount = 6;
        const stereoController = createWorkletController(2);
        const surroundController = createWorkletController(6);
        const finalStereoController = createWorkletController(2);
        surroundController.generation = 2;
        finalStereoController.generation = 3;
        const surroundCreation = createWorkletControllerDeferred();
        audioWorkletMockState.create
            .mockResolvedValueOnce(stereoController)
            .mockReturnValueOnce(surroundCreation.promise)
            .mockResolvedValueOnce(finalStereoController);
        const binding = await createBrowserCustomAudioOutputFactory()(
            createAudioConfiguration(2)
        );
        const audioContext = FakeAudioContext.instances[0];
        binding.output.setVolume(0.75);

        const surroundReconfiguration = reconfigureOutput(
            binding.output,
            createAudioConfiguration(6)
        );
        const stereoReconfiguration = reconfigureOutput(
            binding.output,
            createAudioConfiguration(2)
        );
        await vi.waitFor(() => expect(audioWorkletMockState.create).toHaveBeenCalledTimes(2));
        // The second call waits while the first one holds the pooled node
        expect(audioContext.destination.channelCount).toBe(6);
        surroundCreation.resolve(surroundController);
        const [ surroundBridge, stereoBridge ] = await Promise.all([
            surroundReconfiguration,
            stereoReconfiguration
        ]);

        expect(getBridgeOutput(surroundBridge).configuration.channelCount).toBe(6);
        expect(getBridgeOutput(stereoBridge).configuration.channelCount).toBe(2);
        // The second call starts only after the first one finished, then retires its lease
        expect(surroundController.setPlaying.mock.invocationCallOrder[0])
            .toBeLessThan(surroundController.deactivate.mock.invocationCallOrder[0]);
        expect(audioWorkletMockState.create).toHaveBeenCalledTimes(3);
        expect(audioContext.destination.channelCount).toBe(2);
        expect(binding.output.generation).toBe(3);
        expect(finalStereoController.setVolume).toHaveBeenCalledWith(0.75);
        expect(finalStereoController.setPlaying).toHaveBeenCalledWith(false);
        for (const retiredController of [ stereoController, surroundController ]) {
            expect(retiredController.deactivate).toHaveBeenCalledOnce();
            expect(retiredController.destroy).toHaveBeenCalledOnce();
        }
        expect(finalStereoController.deactivate).not.toHaveBeenCalled();
        expect(finalStereoController.destroy).not.toHaveBeenCalled();
        expect(() => getBridgeOutput(surroundBridge).setVolume(1)).toThrow(
            'Audio worklet lease is no longer active'
        );

        await binding.output.destroy();
        expect(finalStereoController.deactivate).toHaveBeenCalledOnce();
    });

    it('runs a queued reconfiguration after the previous one fails validation', async () => {
        fakeMaximumChannelCount = 6;
        const stereoController = createWorkletController(2);
        const surroundController = createWorkletController(6);
        surroundController.generation = 2;
        audioWorkletMockState.create
            .mockResolvedValueOnce(stereoController)
            .mockResolvedValueOnce(surroundController);
        const binding = await createBrowserCustomAudioOutputFactory()(
            createAudioConfiguration(2)
        );
        binding.output.setMuted(true);

        const failedReconfiguration = reconfigureOutput(
            binding.output,
            createAudioConfiguration(7)
        );
        const observedFailure = failedReconfiguration.catch((error: unknown): unknown => error);
        const surroundBridge = await reconfigureOutput(
            binding.output,
            createAudioConfiguration(6)
        );

        expect(await observedFailure).toEqual(new RangeError(
            'Custom audio output requires 2, 6, or 8 channels at 48000 Hz'
        ));
        expect(getBridgeOutput(surroundBridge).configuration.channelCount).toBe(6);
        expect(binding.output.generation).toBe(2);
        expect(surroundController.setMuted).toHaveBeenCalledExactlyOnceWith(true);
        expect(stereoController.deactivate).toHaveBeenCalledOnce();
        expect(stereoController.destroy).toHaveBeenCalledOnce();

        await binding.output.destroy();
        expect(surroundController.deactivate).toHaveBeenCalledOnce();
    });

    it('leases a new worklet after a reconfiguration fails to create one', async () => {
        fakeMaximumChannelCount = 8;
        const stereoController = createWorkletController(2);
        const surroundController = createWorkletController(6);
        surroundController.generation = 2;
        audioWorkletMockState.create
            .mockResolvedValueOnce(stereoController)
            .mockRejectedValueOnce(new Error('AudioWorklet module failed'))
            .mockResolvedValueOnce(surroundController);
        const binding = await createBrowserCustomAudioOutputFactory()(
            createAudioConfiguration(2)
        );
        const audioContext = FakeAudioContext.instances[0];

        await expect(reconfigureOutput(binding.output, createAudioConfiguration(8)))
            .rejects.toThrow('AudioWorklet module failed');

        // The output stays inactive, so calls never reach the retired worklet
        expect(stereoController.deactivate).toHaveBeenCalledOnce();
        expect(stereoController.destroy).toHaveBeenCalledOnce();
        binding.output.setVolume(0.4);
        binding.output.setMuted(true);
        await binding.output.setPlaying(true);
        expect(() => binding.output.setVolume(Number.NaN)).toThrow(RangeError);
        expect(binding.output.getTelemetry()).toBeNull();
        expect(binding.output.generation).toBe(1);
        expect(stereoController.setVolume).not.toHaveBeenCalled();
        expect(stereoController.setMuted).not.toHaveBeenCalled();
        expect(stereoController.setPlaying).not.toHaveBeenCalled();

        const surroundBridge = await reconfigureOutput(
            binding.output,
            createAudioConfiguration(6)
        );

        // The retired lease is not released again before the new worklet is leased
        expect(stereoController.deactivate).toHaveBeenCalledOnce();
        expect(audioWorkletMockState.create).toHaveBeenCalledTimes(3);
        expect(audioContext.destination.channelCount).toBe(6);
        expect(getBridgeOutput(surroundBridge).configuration.channelCount).toBe(6);
        expect(binding.output.generation).toBe(2);
        expect(surroundController.setVolume).toHaveBeenCalledExactlyOnceWith(0.4);
        expect(surroundController.setMuted).toHaveBeenCalledExactlyOnceWith(true);
        expect(surroundController.setPlaying).toHaveBeenCalledExactlyOnceWith(true);

        await binding.output.destroy();
        expect(surroundController.deactivate).toHaveBeenCalledOnce();
        expect(stereoController.deactivate).toHaveBeenCalledOnce();
    });

    it('leases a new worklet after the old worklet fails to retire', async () => {
        fakeMaximumChannelCount = 6;
        const stereoController = createWorkletController(2);
        const surroundController = createWorkletController(6);
        surroundController.generation = 2;
        stereoController.deactivate.mockRejectedValueOnce(
            new Error('Processor deactivation failed')
        );
        audioWorkletMockState.create
            .mockResolvedValueOnce(stereoController)
            .mockResolvedValueOnce(surroundController);
        const binding = await createBrowserCustomAudioOutputFactory()(
            createAudioConfiguration(2)
        );
        const audioContext = FakeAudioContext.instances[0];
        binding.output.setVolume(0.6);

        const failedReconfiguration = reconfigureOutput(
            binding.output,
            createAudioConfiguration(6)
        );
        const observedFailure = failedReconfiguration.catch((error: unknown): unknown => error);
        const surroundBridge = await reconfigureOutput(
            binding.output,
            createAudioConfiguration(6)
        );

        expect(await observedFailure).toEqual(new Error('Processor deactivation failed'));
        // The pool destroys the worklet that failed to deactivate; the queued call skips its release
        expect(stereoController.deactivate).toHaveBeenCalledOnce();
        expect(stereoController.destroy).toHaveBeenCalledOnce();
        expect(audioWorkletMockState.create).toHaveBeenCalledTimes(2);
        expect(audioContext.destination.channelCount).toBe(6);
        expect(getBridgeOutput(surroundBridge).configuration.channelCount).toBe(6);
        expect(binding.output.generation).toBe(2);
        expect(surroundController.setVolume).toHaveBeenCalledExactlyOnceWith(0.6);
        expect(surroundController.setPlaying).toHaveBeenCalledExactlyOnceWith(false);

        // The recovered output releases its new lease and keeps the shared context warm
        await binding.output.destroy();
        expect(surroundController.deactivate).toHaveBeenCalledOnce();
        expect(audioContext.close).not.toHaveBeenCalled();
    });

    it('reports the destination channel maximum only while it is valid', async () => {
        fakeMaximumChannelCount = 8;
        audioWorkletMockState.create.mockResolvedValue(createWorkletController());
        const binding = await createBrowserCustomAudioOutputFactory()(
            createAudioConfiguration(2)
        );
        const destination = FakeAudioContext.instances[0].destination as unknown as {
            maxChannelCount: number
        };

        expect(binding.output.getMaximumChannelCount?.()).toBe(8);
        // Each call reads the sink again, because the device behind it can change
        destination.maxChannelCount = 6;
        expect(binding.output.getMaximumChannelCount?.()).toBe(6);
        for (const invalidMaximumChannelCount of [
            0,
            -2,
            5.5,
            Number.NaN,
            Number.POSITIVE_INFINITY
        ]) {
            destination.maxChannelCount = invalidMaximumChannelCount;
            expect(binding.output.getMaximumChannelCount?.()).toBeNull();
        }
        Object.defineProperty(destination, 'maxChannelCount', {
            get: (): number => {
                throw new Error('Destination is unavailable');
            }
        });
        expect(binding.output.getMaximumChannelCount?.()).toBeNull();

        await binding.output.destroy();
    });

    it('reports completed output device changes but not the silent rebuild sink', async () => {
        audioWorkletMockState.create.mockResolvedValue(createWorkletController());
        const binding = await createBrowserCustomAudioOutputFactory()(
            createAudioConfiguration(2)
        );
        const audioContext = FakeAudioContext.instances[0];
        const throwingListener = vi.fn((): void => {
            throw new Error('Device listener failed');
        });
        const deviceListener = vi.fn();
        const unsubscribedListener = vi.fn();
        subscribeOutputDeviceChange(binding.output, throwingListener);
        subscribeOutputDeviceChange(binding.output, deviceListener);
        const unsubscribe = subscribeOutputDeviceChange(binding.output, unsubscribedListener);
        unsubscribe();

        audioContext.sinkId = 'speaker-b';
        audioContext.dispatchEvent(new Event('sinkchange'));
        expect(throwingListener).toHaveBeenCalledOnce();
        expect(deviceListener).toHaveBeenCalledOnce();
        expect(unsubscribedListener).not.toHaveBeenCalled();

        // A sink rebuild passes through no device before it reaches the real one
        audioContext.sinkId = { type: 'none' };
        audioContext.dispatchEvent(new Event('sinkchange'));
        expect(deviceListener).toHaveBeenCalledOnce();
        audioContext.sinkId = '';
        audioContext.dispatchEvent(new Event('sinkchange'));
        expect(deviceListener).toHaveBeenCalledTimes(2);
        expect(unsubscribedListener).not.toHaveBeenCalled();

        await binding.output.destroy();
    });

    it('stops reporting output device changes after destroy', async () => {
        audioWorkletMockState.create.mockResolvedValue(createWorkletController());
        const binding = await createBrowserCustomAudioOutputFactory()(
            createAudioConfiguration(2)
        );
        const audioContext = FakeAudioContext.instances[0];
        const deviceListener = vi.fn();
        subscribeOutputDeviceChange(binding.output, deviceListener);
        const removeEventListener = vi.spyOn(audioContext, 'removeEventListener');

        await binding.output.destroy();
        audioContext.dispatchEvent(new Event('sinkchange'));

        expect(removeEventListener).toHaveBeenCalledWith('sinkchange', expect.any(Function));
        expect(deviceListener).not.toHaveBeenCalled();
        expect(() => subscribeOutputDeviceChange(binding.output, vi.fn())).toThrow(
            'Browser audio output is destroyed'
        );
    });

    it('records output changes made during a reconfiguration for the next worklet', async () => {
        fakeMaximumChannelCount = 6;
        const stereoController = createWorkletController(2);
        const surroundController = createWorkletController(6);
        surroundController.generation = 2;
        const surroundCreation = createWorkletControllerDeferred();
        audioWorkletMockState.create
            .mockResolvedValueOnce(stereoController)
            .mockReturnValueOnce(surroundCreation.promise);
        const binding = await createBrowserCustomAudioOutputFactory()(
            createAudioConfiguration(2)
        );
        const reconfiguration = reconfigureOutput(binding.output, createAudioConfiguration(6));
        await vi.waitFor(() => expect(audioWorkletMockState.create).toHaveBeenCalledTimes(2));

        // The old worklet is retired, so changes wait for its replacement
        binding.output.setVolume(0.3);
        binding.output.setMuted(true);
        await binding.output.setPlaying(true);
        expect(() => binding.output.setVolume(-1)).toThrow(RangeError);
        expect(() => binding.output.setVolume(Number.POSITIVE_INFINITY)).toThrow(RangeError);
        expect(binding.output.getTelemetry()).toBeNull();
        expect(binding.output.generation).toBe(1);
        expect(stereoController.setVolume).not.toHaveBeenCalled();
        expect(stereoController.setMuted).not.toHaveBeenCalled();
        expect(stereoController.setPlaying).not.toHaveBeenCalled();

        surroundCreation.resolve(surroundController);
        await reconfiguration;

        expect(surroundController.setVolume).toHaveBeenCalledExactlyOnceWith(0.3);
        expect(surroundController.setMuted).toHaveBeenCalledExactlyOnceWith(true);
        expect(surroundController.setPlaying).toHaveBeenCalledExactlyOnceWith(true);
        expect(binding.output.generation).toBe(2);
        await binding.output.destroy();
    });
});
