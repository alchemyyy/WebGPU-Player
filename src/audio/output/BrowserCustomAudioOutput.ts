import {
    secondsToMicroseconds,
    type Microseconds
} from '../../MediaTime';
import {
    getWebGPUAudioOutputManager,
    type WebGPUAudioOutputManager,
    type WebGPUAudioOutputTargetLease
} from './WebGPUAudioOutputManager';
import type {
    AudioTelemetryListener,
    AudioWorkletOutputController
} from './AudioWorkletController';
import type { AudioWorkletTelemetry } from './AudioWorkletProtocol';
import {
    type BrowserAudioContextPrewarmLease,
    takePrewarmedBrowserAudioContext
} from './BrowserAudioContextPrewarm';
import {
    acquireSharedBrowserAudioContext,
    type SharedBrowserAudioContextReference
} from './BrowserAudioContextPool';
import {
    acquireSharedBrowserAudioWorklet,
    type SharedBrowserAudioWorkletLease
} from './BrowserAudioWorkletPool';
import { waitForBrowserAudioOperation } from './BrowserAudioOperation';
import {
    assertSupportedCustomAudioOutputLayout,
    CUSTOM_AUDIO_OUTPUT_BUFFERED_SECONDS
} from '../CustomAudioOutputPolicy';
import CustomDecodeAudioBridge from './CustomDecodeAudioBridge';
import type {
    CustomAudioOutput,
    CustomAudioOutputBinding,
    CustomAudioOutputFactory
} from '../../pipeline/CustomPlaybackControllerTypes';
import type { DecodeWorkerAudioConfiguration } from '../../pipeline/DecodeWorkerProtocol';
import { configureCustomAudioDestination } from '../NativeMultichannelAudioOutput';
import { requireMicroseconds } from '../../TimeMath';

const MAX_BUFFERED_AUDIO_SECONDS = CUSTOM_AUDIO_OUTPUT_BUFFERED_SECONDS;
const MAX_OUTPUT_TIMESTAMP_CORRECTION_MICROSECONDS = secondsToMicroseconds(
    MAX_BUFFERED_AUDIO_SECONDS
);

type AudioContextWithSinkInfo = AudioContext & {
    readonly sinkId?: string | Readonly<{ type: string }>
};

function acquireWorkletOutput(
    audioContext: AudioContext,
    channelCount: number,
    sampleRate: number,
    operationName: string
): Promise<SharedBrowserAudioWorkletLease> {
    const workletLeasePromise = acquireSharedBrowserAudioWorklet(audioContext, {
        channelCount,
        maxBufferedFrames: sampleRate * MAX_BUFFERED_AUDIO_SECONDS
    });
    return waitForBrowserAudioOperation(workletLeasePromise, operationName).catch(
        (error: unknown): never => {
            // A lease that resolves after the bound would otherwise hold the pooled node
            void workletLeasePromise.then(
                (lateWorkletLease): Promise<void> => lateWorkletLease.invalidate()
            ).catch((): void => undefined);
            throw error;
        }
    );
}

/** Couples one session worklet output with a reference to the shared exact-rate context. */
class BrowserCustomAudioOutput implements CustomAudioOutput {
    private readonly audioContext: AudioContext;
    private destroyed = false;
    private destroyPromise: Promise<void> | null = null;
    private mediaFloorGeneration: number | null = null;
    private mediaFloorMicroseconds: Microseconds | null = null;
    private muted = false;
    /** False while a reconfiguration has retired the worklet and not yet replaced it */
    private outputActive = true;
    private readonly outputDeviceListeners = new Set<() => void>();
    private outputGeneration = 0;
    private outputTelemetryUnsubscribe: () => void;
    private physicalCorrelationGeneration: number | null = null;
    private playing = false;
    private reconfigurationTail: Promise<void> = Promise.resolve();
    private resumePromise: Promise<void> | null = null;
    private readonly telemetryListeners = new Set<AudioTelemetryListener>();
    private volume = 1;

    public constructor(
        private readonly audioContextReference: SharedBrowserAudioContextReference,
        private workletLease: SharedBrowserAudioWorkletLease,
        private readonly audioOutputTargetLease: WebGPUAudioOutputTargetLease
    ) {
        this.audioContext = audioContextReference.audioContext;
        this.output = workletLease.output;
        this.outputTelemetryUnsubscribe = this.output.onTelemetry(this.handleOutputTelemetry);
        this.audioContext.addEventListener('sinkchange', this.handleSinkChange);
    }

    private output: AudioWorkletOutputController;

    public get generation(): number {
        return this.outputActive ? this.output.generation : this.outputGeneration;
    }

    /** Returns how many channels the current sink accepts, or null when unknown. */
    public getMaximumChannelCount(): number | null {
        try {
            const maximumChannelCount = this.audioContext.destination.maxChannelCount;
            return Number.isSafeInteger(maximumChannelCount) && maximumChannelCount > 0 ?
                maximumChannelCount :
                null;
        } catch {
            return null;
        }
    }

    /** Reports each completed change of the physical output device. */
    public onOutputDeviceChange(listener: () => void): () => void {
        if (this.destroyed) {
            throw new Error('Browser audio output is destroyed');
        }

        this.outputDeviceListeners.add(listener);
        return (): void => {
            this.outputDeviceListeners.delete(listener);
        };
    }

    /**
     * Replaces the worklet with one for a new channel count on the same context and
     * sink. Decode resumes into the returned bridge without reopening the device.
     * Overlapping calls run in order, so each one retires the previous worklet.
     */
    public reconfigure(
        configuration: DecodeWorkerAudioConfiguration
    ): Promise<CustomDecodeAudioBridge> {
        const reconfiguration = this.reconfigurationTail.then(
            (): Promise<CustomDecodeAudioBridge> => this.reconfigureWorklet(configuration)
        );
        this.reconfigurationTail = reconfiguration.then(
            (): void => undefined,
            (): void => undefined
        );
        return reconfiguration;
    }

    private async reconfigureWorklet(
        configuration: DecodeWorkerAudioConfiguration
    ): Promise<CustomDecodeAudioBridge> {
        if (this.destroyed) {
            throw new Error('Browser audio output is destroyed');
        }
        assertSupportedCustomAudioOutputLayout(
            configuration.channelCount,
            configuration.sampleRate
        );
        if (this.audioContext.sampleRate !== configuration.sampleRate) {
            throw new RangeError('The browser did not create the requested audio sample rate');
        }

        // A failed earlier call already retired the worklet, or failed retiring it
        if (this.outputActive) {
            this.outputTelemetryUnsubscribe();
            this.outputTelemetryUnsubscribe = (): void => undefined;
            this.mediaFloorGeneration = null;
            this.mediaFloorMicroseconds = null;
            this.physicalCorrelationGeneration = null;
            // Calls meanwhile only record the requested state for the next worklet
            this.outputGeneration = this.output.generation;
            this.outputActive = false;
            // The pooled node serves one lease at a time, so the old layout must retire first
            await this.workletLease.release();
        }
        configureCustomAudioDestination(
            this.audioContext,
            configuration.channelCount as 2 | 6 | 8
        );
        const workletLease = await acquireWorkletOutput(
            this.audioContext,
            configuration.channelCount,
            configuration.sampleRate,
            'AudioWorklet output reconfiguration'
        );
        if (this.destroyed) {
            await workletLease.release().catch((): void => undefined);
            throw new Error('Browser audio output was destroyed during reconfiguration');
        }

        this.workletLease = workletLease;
        this.output = workletLease.output;
        this.outputActive = true;
        this.output.setVolume(this.volume);
        this.output.setMuted(this.muted);
        this.output.setPlaying(this.playing);
        this.outputTelemetryUnsubscribe = this.output.onTelemetry(this.handleOutputTelemetry);
        return new CustomDecodeAudioBridge(this.output);
    }

    /** Returns the browser's current conservative physical-output latency estimate. */
    public getEstimatedOutputLatencyMicroseconds(): Microseconds | null {
        const latencySeconds = [
            this.audioContext.baseLatency,
            this.audioContext.outputLatency
        ];
        let estimatedLatencySeconds = 0;
        let hasLatencyEstimate = false;
        for (const candidateLatencySeconds of latencySeconds) {
            if (typeof candidateLatencySeconds !== 'number'
                || !Number.isFinite(candidateLatencySeconds)
                || candidateLatencySeconds < 0) {
                continue;
            }
            estimatedLatencySeconds += candidateLatencySeconds;
            hasLatencyEstimate = true;
        }
        if (!hasLatencyEstimate) {
            return null;
        }

        try {
            return secondsToMicroseconds(estimatedLatencySeconds);
        } catch {
            return null;
        }
    }

    public destroy(): Promise<void> {
        if (this.destroyPromise) {
            return this.destroyPromise;
        }

        this.destroyed = true;
        this.audioContext.removeEventListener('sinkchange', this.handleSinkChange);
        this.outputTelemetryUnsubscribe();
        this.outputDeviceListeners.clear();
        this.telemetryListeners.clear();
        this.destroyPromise = this.destroyResources();
        return this.destroyPromise;
    }

    public getTelemetry(): AudioWorkletTelemetry | null {
        if (!this.outputActive) {
            return null;
        }
        const telemetry = this.output.getTelemetry();
        return telemetry ? this.mapOutputTelemetry(telemetry) : null;
    }

    public onTelemetry(listener: AudioTelemetryListener): () => void {
        if (this.destroyed) {
            throw new Error('Browser audio output is destroyed');
        }

        this.telemetryListeners.add(listener);
        return (): void => {
            this.telemetryListeners.delete(listener);
        };
    }

    public setMuted(muted: boolean): void {
        this.muted = muted;
        if (this.outputActive) {
            this.output.setMuted(muted);
        }
    }

    public setPlaying(playing: boolean): Promise<void> {
        this.playing = playing;
        if (this.outputActive) {
            this.output.setPlaying(playing);
        }
        const routingPromise = this.audioOutputTargetLease.setIntendedRunning(playing);
        if (!playing) {
            return routingPromise;
        }

        if (this.resumePromise) {
            return this.resumePromise;
        }

        const resumePromise = routingPromise.then((): Promise<void> => {
            if (this.audioContext.state === 'running') {
                return Promise.resolve();
            }
            return waitForBrowserAudioOperation(
                this.audioContext.resume(),
                'AudioContext resume'
            );
        }).finally((): void => {
            if (this.resumePromise === resumePromise) {
                this.resumePromise = null;
            }
        });
        this.resumePromise = resumePromise;
        return resumePromise;
    }

    public setVolume(volume: number): void {
        if (this.outputActive) {
            this.output.setVolume(volume);
        } else if (!Number.isFinite(volume) || volume < 0) {
            throw new RangeError('Audio output gain must be finite and non-negative');
        }
        this.volume = volume;
    }

    private readonly handleSinkChange = (): void => {
        if (this.destroyed) {
            return;
        }
        // NOTE: A sink rebuild passes through no device first, which has no layout to adopt
        const sinkId = (this.audioContext as AudioContextWithSinkInfo).sinkId;
        if (typeof sinkId === 'object') {
            return;
        }
        for (const listener of [ ...this.outputDeviceListeners ]) {
            try {
                listener();
            } catch {
                // Device listeners must not interrupt audio output
            }
        }
    };

    private readonly handleOutputTelemetry = (telemetry: AudioWorkletTelemetry): void => {
        if (this.destroyed) {
            return;
        }

        this.observeTelemetryState(telemetry);
        const mappedTelemetry = this.mapOutputTelemetry(telemetry);
        for (const listener of this.telemetryListeners) {
            listener({ ...mappedTelemetry });
        }
    };

    private mapOutputTelemetry(telemetry: AudioWorkletTelemetry): AudioWorkletTelemetry {
        const fallbackTelemetry = this.createFallbackTelemetry(telemetry);
        const mediaContextTimeMicroseconds = telemetry.mediaTimeContextTimeMicroseconds;
        if (mediaContextTimeMicroseconds === null
            || !Number.isSafeInteger(mediaContextTimeMicroseconds)
            || mediaContextTimeMicroseconds < 0
            || !Number.isSafeInteger(telemetry.mediaTimeMicroseconds)) {
            return fallbackTelemetry;
        }

        const getOutputTimestamp = this.audioContext.getOutputTimestamp;
        if (typeof getOutputTimestamp !== 'function') {
            return fallbackTelemetry;
        }

        let outputTimestamp: AudioTimestamp;
        try {
            outputTimestamp = getOutputTimestamp.call(this.audioContext);
        } catch {
            return fallbackTelemetry;
        }
        const outputContextTimeSeconds = outputTimestamp.contextTime;
        const outputPerformanceTimeMilliseconds = outputTimestamp.performanceTime;
        if (typeof outputContextTimeSeconds !== 'number'
            || !Number.isFinite(outputContextTimeSeconds)
            || outputContextTimeSeconds <= 0
            || typeof outputPerformanceTimeMilliseconds !== 'number'
            || !Number.isFinite(outputPerformanceTimeMilliseconds)
            || outputPerformanceTimeMilliseconds <= 0
            || !Number.isFinite(this.audioContext.currentTime)
            || this.audioContext.currentTime <= 0) {
            return fallbackTelemetry;
        }

        let outputContextTimeMicroseconds: number;
        let currentContextTimeMicroseconds: number;
        try {
            outputContextTimeMicroseconds = secondsToMicroseconds(outputContextTimeSeconds);
            currentContextTimeMicroseconds = secondsToMicroseconds(this.audioContext.currentTime);
        } catch {
            return fallbackTelemetry;
        }
        if (outputContextTimeMicroseconds > currentContextTimeMicroseconds) {
            return fallbackTelemetry;
        }

        const correctionMicroseconds = mediaContextTimeMicroseconds
            - outputContextTimeMicroseconds;
        if (correctionMicroseconds <= 0) {
            // The latest rendered media point is the safe forward bound
            this.physicalCorrelationGeneration = telemetry.generation;
            return this.clampTelemetryToMediaFloor({
                ...telemetry,
                hasPhysicalOutputTimeCorrelation: true
            });
        }
        if (!Number.isSafeInteger(correctionMicroseconds)
            || correctionMicroseconds > MAX_OUTPUT_TIMESTAMP_CORRECTION_MICROSECONDS) {
            return fallbackTelemetry;
        }

        let physicalMediaTimeMicroseconds: Microseconds;
        try {
            physicalMediaTimeMicroseconds = requireMicroseconds(
                telemetry.mediaTimeMicroseconds - correctionMicroseconds,
                'Physical audio output media time'
            );
        } catch {
            return fallbackTelemetry;
        }
        this.physicalCorrelationGeneration = telemetry.generation;
        return this.clampTelemetryToMediaFloor({
            ...telemetry,
            hasPhysicalOutputTimeCorrelation: true,
            mediaTimeMicroseconds: physicalMediaTimeMicroseconds
        });
    }

    private clampTelemetryToMediaFloor(
        telemetry: AudioWorkletTelemetry
    ): AudioWorkletTelemetry {
        const mediaFloorMicroseconds = this.getMediaFloor(telemetry.generation);
        return {
            ...telemetry,
            mediaTimeMicroseconds: mediaFloorMicroseconds !== null
                && telemetry.mediaTimeMicroseconds < mediaFloorMicroseconds ?
                mediaFloorMicroseconds :
                telemetry.mediaTimeMicroseconds
        };
    }

    private createFallbackTelemetry(
        telemetry: AudioWorkletTelemetry
    ): AudioWorkletTelemetry {
        const uncorrelatedTelemetry: AudioWorkletTelemetry = {
            ...telemetry,
            hasPhysicalOutputTimeCorrelation: false
        };
        const mediaFloorMicroseconds = this.getMediaFloor(telemetry.generation);
        if (mediaFloorMicroseconds === null) {
            return uncorrelatedTelemetry;
        }
        if (this.physicalCorrelationGeneration !== telemetry.generation) {
            return {
                ...uncorrelatedTelemetry,
                mediaTimeMicroseconds: mediaFloorMicroseconds
            };
        }
        return this.clampTelemetryToMediaFloor(uncorrelatedTelemetry);
    }

    private getMediaFloor(generation: number): Microseconds | null {
        return this.mediaFloorGeneration === generation ? this.mediaFloorMicroseconds : null;
    }

    private observeTelemetryState(telemetry: AudioWorkletTelemetry): void {
        if (this.mediaFloorGeneration !== telemetry.generation) {
            this.mediaFloorGeneration = telemetry.generation;
            this.mediaFloorMicroseconds = null;
            this.physicalCorrelationGeneration = null;
        }
        if (telemetry.reason !== 'flush') {
            return;
        }

        this.mediaFloorMicroseconds = telemetry.mediaTimeMicroseconds;
        this.physicalCorrelationGeneration = null;
    }

    private async destroyResources(): Promise<void> {
        let outputReleaseError: unknown;
        let outputReleaseFailed = false;
        try {
            await this.workletLease.release();
        } catch (error) {
            outputReleaseError = error;
            outputReleaseFailed = true;
        }

        await this.audioOutputTargetLease.release();

        try {
            if (outputReleaseFailed) {
                await this.audioContextReference.invalidate();
            } else {
                await this.audioContextReference.release();
            }
        } catch (error) {
            if (!outputReleaseFailed) {
                throw error;
            }
        }

        if (outputReleaseFailed) {
            throw outputReleaseError;
        }
    }
}

async function createOutput(
    configuration: DecodeWorkerAudioConfiguration,
    prewarmedAudioContext: BrowserAudioContextPrewarmLease | null,
    audioOutputManager: WebGPUAudioOutputManager
): Promise<CustomAudioOutputBinding> {
    try {
        assertSupportedCustomAudioOutputLayout(
            configuration.channelCount,
            configuration.sampleRate
        );
    } catch (error) {
        await prewarmedAudioContext?.close().catch((): void => undefined);
        throw error;
    }
    const consumedPrewarm = prewarmedAudioContext ?
        takePrewarmedBrowserAudioContext(prewarmedAudioContext, configuration.sampleRate) :
        null;
    if (prewarmedAudioContext && !consumedPrewarm) {
        await prewarmedAudioContext.close();
    }
    const audioContextReference = consumedPrewarm
        ?? acquireSharedBrowserAudioContext(configuration.sampleRate);
    const audioContext = audioContextReference.audioContext;
    // The router rebuilds the sink of a context created without an output device once one appears
    const createdWithoutOutputDevice = await audioContextReference.createdWithoutOutputDevice
        .catch((): boolean => false);
    const audioOutputTargetLease = audioOutputManager.registerAudioContext(
        audioContext,
        { createdWithoutOutputDevice }
    );
    let workletLease: SharedBrowserAudioWorkletLease | null = null;
    let workletLeasePromise: Promise<SharedBrowserAudioWorkletLease> | null = null;
    try {
        if (audioContext.sampleRate !== configuration.sampleRate) {
            throw new RangeError('The browser did not create the requested audio sample rate');
        }
        configureCustomAudioDestination(
            audioContext,
            configuration.channelCount as 2 | 6 | 8
        );
        await waitForBrowserAudioOperation(
            audioContextReference.resumePromise,
            consumedPrewarm ? 'Prewarmed AudioContext resume' : 'AudioContext resume'
        );
        await audioOutputTargetLease.ready;
        if (!audioContextReference.isValid()) {
            throw new Error('AudioContext was invalidated while preparing custom audio output');
        }
        workletLeasePromise = acquireSharedBrowserAudioWorklet(audioContext, {
            channelCount: configuration.channelCount,
            maxBufferedFrames: configuration.sampleRate * MAX_BUFFERED_AUDIO_SECONDS
        });
        workletLease = await waitForBrowserAudioOperation(
            workletLeasePromise,
            'AudioWorklet output creation'
        );
        const managedOutput = new BrowserCustomAudioOutput(
            audioContextReference,
            workletLease,
            audioOutputTargetLease
        );
        return {
            bridge: new CustomDecodeAudioBridge(workletLease.output),
            configuration: { ...configuration },
            output: managedOutput
        };
    } catch (error) {
        if (!workletLease && workletLeasePromise) {
            void workletLeasePromise.then(
                (lateWorkletLease): Promise<void> => lateWorkletLease.invalidate()
            ).catch((): void => undefined);
        }
        await workletLease?.invalidate().catch((): void => undefined);
        await audioOutputTargetLease.release().catch((): void => undefined);
        await audioContextReference.invalidate().catch((): void => undefined);
        throw error;
    }
}

/** Creates exact-rate browser PCM outputs for a combined custom A/V session. */
export function createBrowserCustomAudioOutputFactory(
    prewarmedAudioContext: BrowserAudioContextPrewarmLease | null = null,
    audioOutputManager: WebGPUAudioOutputManager = getWebGPUAudioOutputManager()
): CustomAudioOutputFactory {
    let availablePrewarm = prewarmedAudioContext;
    return (configuration: DecodeWorkerAudioConfiguration): Promise<CustomAudioOutputBinding> => {
        const selectedPrewarm = availablePrewarm;
        availablePrewarm = null;
        return createOutput(configuration, selectedPrewarm, audioOutputManager);
    };
}
