import {
    microsecondsToMilliseconds,
    microsecondsToSeconds,
    millisecondsToMicroseconds,
    secondsToMicroseconds,
    type Microseconds
} from '../../MediaTime';
import {
    getWebGPUAudioOutputManager,
    type WebGPUAudioOutputManager,
    type WebGPUAudioOutputTargetLease
} from '../output/WebGPUAudioOutputManager';
import { requireMicroseconds } from '../../TimeMath';
import {
    MAXIMUM_NATIVE_AUDIO_PENDING_BYTE_LENGTH,
    MAXIMUM_NATIVE_AUDIO_PENDING_SEGMENT_COUNT,
    MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH,
    MAXIMUM_NATIVE_AUDIO_SEGMENT_DURATION_MICROSECONDS
} from './NativeMediaAudioLimits';

export {
    MAXIMUM_NATIVE_AUDIO_PENDING_BYTE_LENGTH,
    MAXIMUM_NATIVE_AUDIO_PENDING_SEGMENT_COUNT,
    MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH,
    MAXIMUM_NATIVE_AUDIO_SEGMENT_DURATION_MICROSECONDS
} from './NativeMediaAudioLimits';

export const DEFAULT_NATIVE_AUDIO_MAXIMUM_APPENDED_AHEAD_MICROSECONDS = millisecondsToMicroseconds(6_000);
export const DEFAULT_NATIVE_AUDIO_RETAINED_BEHIND_MICROSECONDS = millisecondsToMicroseconds(5_000);
export const DEFAULT_NATIVE_AUDIO_OPERATION_TIMEOUT_MICROSECONDS = millisecondsToMicroseconds(3_000);
/** A first fragment starting later than this after the requested start parks the element on it */
export const NATIVE_AUDIO_LATE_START_THRESHOLD_MICROSECONDS = millisecondsToMicroseconds(40);
/** A deferred play() timer that overshoots its gap by more than this advances the parked element */
export const NATIVE_AUDIO_LATE_START_OVERSHOOT_THRESHOLD_MICROSECONDS = millisecondsToMicroseconds(20);
export type OwnedNativeMediaAudioState =
    | 'destroyed'
    | 'idle'
    | 'open'
    | 'paused'
    | 'playing'
    | 'starting'
    | 'stopped';

export type OwnedNativeMediaAudioEvent =
    | { generation: number, type: 'clock-ready' }
    | { generation: number, type: 'ended' }
    | { generation: number, message: string, type: 'error' }
    | { generation: number, type: 'pause' }
    | { generation: number, type: 'playing' }
    | { generation: number, type: 'waiting' };

export type OwnedNativeMediaAudioEventHandler = (event: OwnedNativeMediaAudioEvent) => void;

export type OwnedNativeMediaAudioStartOptions = {
    durationMicroseconds: Microseconds
    generation: number
    mimeType: string
    startTimeMicroseconds: Microseconds
};

export type OwnedNativeMediaAudioSegment = {
    data: Uint8Array
    endTimeMicroseconds: Microseconds
    startTimeMicroseconds: Microseconds
};

export type OwnedNativeMediaAudioTelemetry = {
    activeGeneration: number | null
    appendedByteLength: number
    appendedSegmentCount: number
    clockQualified: boolean
    currentTimeMicroseconds: Microseconds | null
    pendingAppendByteLength: number
    pendingAppendCount: number
    removedRangeCount: number
    staleOperationCount: number
    state: OwnedNativeMediaAudioState
};

export type OwnedNativeMediaAudioBackendOptions = {
    audioOutputManager?: WebGPUAudioOutputManager
    appendElement?: (audioElement: HTMLAudioElement) => void
    createAudioElement?: () => HTMLAudioElement
    createMediaSource?: () => MediaSource
    createObjectURL?: (mediaSource: MediaSource) => string
    eventHandler?: OwnedNativeMediaAudioEventHandler
    maximumAppendedAheadMicroseconds?: Microseconds
    operationTimeoutMicroseconds?: Microseconds
    retainedBehindMicroseconds?: Microseconds
    revokeObjectURL?: (objectURL: string) => void
};

type SegmentTimeRange = {
    endTimeMicroseconds: Microseconds
    startTimeMicroseconds: Microseconds
};

type AppendRoomWaiter = {
    generation: number
    resolve: (available: boolean) => void
    timeRange: SegmentTimeRange
};

type LateStartTimer = {
    handle: ReturnType<typeof globalThis.setTimeout>
    playbackRate: number
    startedAtMicroseconds: Microseconds
};

const ZERO_MICROSECONDS = millisecondsToMicroseconds(0);
const PLAY_INTERRUPTED_ERROR_NAME = 'AbortError';
const DEFAULT_PLAY_FAILURE_MESSAGE = 'Native audio playback could not start';
// Timestamp quantization can start the parked fragment's buffered range just after the parked point
const PARKED_BUFFERED_RANGE_TOLERANCE_MICROSECONDS = millisecondsToMicroseconds(1);

function requireGeneration(generation: number): number {
    if (!Number.isSafeInteger(generation) || generation <= 0) {
        throw new RangeError('Native audio generation must be a positive safe integer');
    }
    return generation;
}

function requirePositiveMicroseconds(value: Microseconds, label: string): Microseconds {
    requireMicroseconds(value, label);
    if (value <= 0) {
        throw new RangeError(`${label} must be positive`);
    }
    return value;
}

function createDefaultAudioElement(): HTMLAudioElement {
    return globalThis.document.createElement('audio');
}

function appendDefaultAudioElement(audioElement: HTMLAudioElement): void {
    globalThis.document.body.appendChild(audioElement);
}

function createDefaultMediaSource(): MediaSource {
    // eslint-disable-next-line compat/compat -- Native MSE audio is capability-gated
    return new MediaSource();
}

function createDefaultObjectURL(mediaSource: MediaSource): string {
    return globalThis.URL.createObjectURL(mediaSource);
}

function revokeDefaultObjectURL(objectURL: string): void {
    globalThis.URL.revokeObjectURL(objectURL);
}

/** Reports whether a first fragment starts too far past the requested start to seek onto */
function isLateStart(requestedStartTimeMicroseconds: Microseconds, firstSegmentStartMicroseconds: Microseconds): boolean {
    return firstSegmentStartMicroseconds - requestedStartTimeMicroseconds > NATIVE_AUDIO_LATE_START_THRESHOLD_MICROSECONDS;
}

/**
 * Returns the end of the buffered range holding the parked point, or null when none holds it.
 * A range may start up to the quantization tolerance after the point.
 */
function findParkedBufferedRangeEndMicroseconds(bufferedRanges: TimeRanges, parkedMicroseconds: Microseconds): Microseconds | null {
    for (let rangeIndex = 0; rangeIndex < bufferedRanges.length; rangeIndex += 1) {
        const rangeStartMicroseconds = secondsToMicroseconds(bufferedRanges.start(rangeIndex));
        const rangeEndMicroseconds = secondsToMicroseconds(bufferedRanges.end(rangeIndex));
        if (parkedMicroseconds < rangeEndMicroseconds
            && rangeStartMicroseconds - parkedMicroseconds <= PARKED_BUFFERED_RANGE_TOLERANCE_MICROSECONDS) {
            return rangeEndMicroseconds;
        }
    }
    return null;
}

function readMonotonicTimeMicroseconds(): Microseconds {
    return millisecondsToMicroseconds(globalThis.performance.now());
}

/** Returns the media time a deferred play() timer has covered, advancing at its playback rate */
function measureLateStartCoverageMicroseconds(lateStartTimer: LateStartTimer): Microseconds {
    return Math.round((readMonotonicTimeMicroseconds() - lateStartTimer.startedAtMicroseconds) * lateStartTimer.playbackRate) as Microseconds;
}

function getErrorName(error: unknown): string {
    return error instanceof DOMException || error instanceof Error ? error.name : '';
}

function getPlayFailureMessage(error: unknown): string {
    const message = error instanceof DOMException || error instanceof Error ? error.message : '';
    return message || DEFAULT_PLAY_FAILURE_MESSAGE;
}

/** Owns one bounded audio-only MSE element without Jellyfin reporting behavior. */
export default class OwnedNativeMediaAudioBackend {
    private activeGeneration: number | null = null;
    private appendedByteLength = 0;
    private appendedSegmentCount = 0;
    private appendOperationTail: Promise<boolean> = Promise.resolve(true);
    private readonly appendRoomWaiters = new Set<AppendRoomWaiter>();
    private audioElement: HTMLAudioElement | null = null;
    private clockBaselineMicroseconds: Microseconds | null = null;
    private clockQualified = false;
    // Deferred play() requests issued so far, which also numbers the latest one
    private deferredPlayRequestCount = 0;
    private destroyed = false;
    private readonly appendElement: (audioElement: HTMLAudioElement) => void;
    private readonly audioOutputManager: WebGPUAudioOutputManager;
    private audioOutputTargetLease: WebGPUAudioOutputTargetLease | null = null;
    private readonly createAudioElement: () => HTMLAudioElement;
    private readonly createMediaSource: () => MediaSource;
    private readonly createObjectURL: (mediaSource: MediaSource) => string;
    private readonly eventHandler: OwnedNativeMediaAudioEventHandler;
    private initializationAppended = false;
    // Deferred play() requests numbered up to this were interrupted by the backend's own pause, seek, or teardown
    private interruptedDeferredPlayRequestCount = 0;
    // Media time the parked element still waits before play(), negative once overdue, null without a late start
    private lateStartGapMicroseconds: Microseconds | null = null;
    private lateStartTimer: LateStartTimer | null = null;
    private readonly maximumAppendedAheadMicroseconds: Microseconds;
    private mediaSource: MediaSource | null = null;
    private readonly operationTimeoutMicroseconds: Microseconds;
    private objectURL: string | null = null;
    private pendingAppendByteLength = 0;
    private pendingAppendCount = 0;
    private removedRangeCount = 0;
    private requestedStartTimeMicroseconds: Microseconds | null = null;
    private readonly retainedBehindMicroseconds: Microseconds;
    private readonly revokeObjectURL: (objectURL: string) => void;
    private sourceBuffer: SourceBuffer | null = null;
    private staleOperationCount = 0;
    private state: OwnedNativeMediaAudioState = 'idle';

    public constructor(options: OwnedNativeMediaAudioBackendOptions = {}) {
        this.appendElement = options.appendElement ?? appendDefaultAudioElement;
        this.audioOutputManager = options.audioOutputManager ?? getWebGPUAudioOutputManager();
        this.createAudioElement = options.createAudioElement ?? createDefaultAudioElement;
        this.createMediaSource = options.createMediaSource ?? createDefaultMediaSource;
        this.createObjectURL = options.createObjectURL ?? createDefaultObjectURL;
        this.eventHandler = options.eventHandler ?? ((): void => undefined);
        this.maximumAppendedAheadMicroseconds = requirePositiveMicroseconds(
            options.maximumAppendedAheadMicroseconds ?? DEFAULT_NATIVE_AUDIO_MAXIMUM_APPENDED_AHEAD_MICROSECONDS,
            'Maximum native audio appended-ahead duration'
        );
        this.operationTimeoutMicroseconds = requirePositiveMicroseconds(
            options.operationTimeoutMicroseconds ?? DEFAULT_NATIVE_AUDIO_OPERATION_TIMEOUT_MICROSECONDS,
            'Native audio operation timeout'
        );
        this.retainedBehindMicroseconds = requirePositiveMicroseconds(
            options.retainedBehindMicroseconds ?? DEFAULT_NATIVE_AUDIO_RETAINED_BEHIND_MICROSECONDS,
            'Native audio retained-behind duration'
        );
        this.revokeObjectURL = options.revokeObjectURL ?? revokeDefaultObjectURL;
    }

    /** Creates one source-less audio element and a SourceBuffer for the given MIME type. */
    public async start(options: OwnedNativeMediaAudioStartOptions): Promise<void> {
        this.requireUsable();
        requireGeneration(options.generation);
        requireMicroseconds(options.startTimeMicroseconds, 'Native audio start time');
        requirePositiveMicroseconds(options.durationMicroseconds, 'Native audio duration');
        if (!options.mimeType.trim()) {
            throw new TypeError('Native audio MIME type must be non-empty');
        }

        await this.teardownActiveSession();
        if (this.destroyed) {
            throw new Error('Native audio backend was destroyed during startup');
        }

        const generation = options.generation;
        const audioElement = this.createAudioElement();
        const mediaSource = this.createMediaSource();
        const objectURL = this.createObjectURL(mediaSource);
        this.activeGeneration = generation;
        this.audioElement = audioElement;
        this.mediaSource = mediaSource;
        this.objectURL = objectURL;
        this.sourceBuffer = null;
        this.initializationAppended = false;
        this.clockBaselineMicroseconds = options.startTimeMicroseconds;
        this.requestedStartTimeMicroseconds = options.startTimeMicroseconds;
        this.clockQualified = false;
        this.appendedByteLength = 0;
        this.appendedSegmentCount = 0;
        this.removedRangeCount = 0;
        this.state = 'starting';

        this.configureAudioElement(audioElement, mediaSource, generation);
        this.appendElement(audioElement);
        const audioOutputTargetLease = this.audioOutputManager.registerMediaElement(audioElement);
        this.audioOutputTargetLease = audioOutputTargetLease;
        await audioOutputTargetLease.ready;
        if (!this.isSessionCurrent(generation, audioElement, mediaSource)) {
            await audioOutputTargetLease.release();
            if (this.audioOutputTargetLease === audioOutputTargetLease) {
                this.audioOutputTargetLease = null;
            }
            throw new Error('Native audio output was superseded during startup');
        }
        audioElement.src = objectURL;

        const opened = await this.waitForMediaSourceOpen(mediaSource, generation);
        if (!opened || !this.isSessionCurrent(generation, audioElement, mediaSource)) {
            throw new Error('Native audio MediaSource did not open');
        }

        const sourceBuffer = mediaSource.addSourceBuffer(options.mimeType);
        sourceBuffer.mode = 'segments';
        this.sourceBuffer = sourceBuffer;
        mediaSource.duration = microsecondsToSeconds(options.durationMicroseconds);
        this.state = 'open';
    }

    /** Appends the CMAF initialization segment before any media fragments. */
    public appendInitializationSegment(generation: number, data: Uint8Array): Promise<boolean> {
        if (data.byteLength === 0) {
            return Promise.reject(new RangeError('Native audio initialization segment is empty'));
        }
        if (data.byteLength > MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH) {
            return Promise.reject(new RangeError('Native audio initialization segment byte length is outside bounds'));
        }
        return this.enqueueAppend(generation, data, null);
    }

    /** Appends one bounded CMAF fragment with producer backpressure. */
    public appendMediaSegment(generation: number, segment: OwnedNativeMediaAudioSegment): Promise<boolean> {
        requireMicroseconds(segment.startTimeMicroseconds, 'Native audio segment start');
        requireMicroseconds(segment.endTimeMicroseconds, 'Native audio segment end');
        const segmentDurationMicroseconds = segment.endTimeMicroseconds - segment.startTimeMicroseconds;
        if (segmentDurationMicroseconds <= 0 || segmentDurationMicroseconds > MAXIMUM_NATIVE_AUDIO_SEGMENT_DURATION_MICROSECONDS) {
            return Promise.reject(new RangeError('Native audio segment duration is outside bounds'));
        }
        if (segment.data.byteLength === 0 || segment.data.byteLength > MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH) {
            return Promise.reject(new RangeError('Native audio segment byte length is outside bounds'));
        }
        return this.enqueueAppend(generation, segment.data, {
            endTimeMicroseconds: segment.endTimeMicroseconds,
            startTimeMicroseconds: segment.startTimeMicroseconds
        });
    }

    /**
     * Starts or pauses native output.
     * Play failures remain visible to the caller.
     * A late start defers play() and reports its failure as an error event instead.
     */
    public async setPlaying(generation: number, playing: boolean): Promise<boolean> {
        const audioElement = this.getCurrentAudioElement(generation);
        if (!audioElement) {
            this.staleOperationCount += 1;
            return false;
        }
        if (!playing) {
            await this.audioOutputTargetLease?.setIntendedRunning(false);
            if (this.isSessionCurrent(generation, audioElement, this.mediaSource)) {
                this.suspendLateStartTimer();
                // The pause() below aborts a deferred play() still in flight
                this.markDeferredPlayInterrupted();
            }
            audioElement.pause();
            this.state = 'paused';
            return true;
        }
        await this.audioOutputTargetLease?.setIntendedRunning(true);
        if (this.lateStartGapMicroseconds !== null && this.isSessionCurrent(generation, audioElement, this.mediaSource)) {
            // The parked element stays silent until the clock reaches its first fragment
            this.startLateStartTimer(generation, audioElement);
            this.state = 'playing';
            return true;
        }
        try {
            await audioElement.play();
        } catch (error) {
            await this.audioOutputTargetLease?.setIntendedRunning(false);
            throw error;
        }
        if (!this.isSessionCurrent(generation, audioElement, this.mediaSource)) {
            this.staleOperationCount += 1;
            return false;
        }
        this.state = 'playing';
        return true;
    }

    /** Marks a fully appended VOD stream complete after queued writes drain. */
    public async endOfStream(generation: number): Promise<boolean> {
        requireGeneration(generation);
        await this.appendOperationTail;
        const mediaSource = this.mediaSource;
        if (!mediaSource || !this.isGenerationActive(generation)) {
            this.staleOperationCount += 1;
            return false;
        }
        if (mediaSource.readyState !== 'open') {
            return mediaSource.readyState === 'ended';
        }
        mediaSource.endOfStream();
        return true;
    }

    /**
     * Seeks the native clock within currently appended media.
     * A pending late start is dropped, and a play() it was deferring starts at once.
     */
    public seek(generation: number, mediaTimeMicroseconds: Microseconds): boolean {
        requireMicroseconds(mediaTimeMicroseconds, 'Native audio seek time');
        const audioElement = this.getCurrentAudioElement(generation);
        if (!audioElement) {
            this.staleOperationCount += 1;
            return false;
        }
        const deferredPlayPending = this.lateStartTimer !== null;
        this.clearLateStart();
        // A deferred play() still in flight is interrupted here, unlike the one this seek may start
        this.markDeferredPlayInterrupted();
        this.clockBaselineMicroseconds = mediaTimeMicroseconds;
        this.requestedStartTimeMicroseconds = mediaTimeMicroseconds;
        this.clockQualified = false;
        audioElement.currentTime = microsecondsToSeconds(mediaTimeMicroseconds);
        this.resolveAppendRoomWaiters();
        if (deferredPlayPending) {
            void this.playParkedElement(generation, audioElement);
        }
        return true;
    }

    public setVolume(volume: number): void {
        if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
            throw new RangeError('Native audio volume must be between zero and one');
        }
        if (this.audioElement) {
            this.audioElement.volume = volume;
        }
    }

    public setMuted(muted: boolean): void {
        if (this.audioElement) {
            this.audioElement.muted = muted;
        }
    }

    public setPlaybackRate(playbackRate: number): void {
        if (!Number.isFinite(playbackRate) || playbackRate <= 0) {
            throw new RangeError('Native audio playback rate must be finite and positive');
        }
        if (this.audioElement) {
            this.audioElement.playbackRate = playbackRate;
        }
        this.retimeLateStartTimer();
    }

    /** Returns native time only after decoded playback has physically advanced. */
    public getAuthoritativeTimeMicroseconds(): Microseconds | null {
        this.qualifyClockIfAdvanced();
        if (!this.clockQualified || !this.audioElement) {
            return null;
        }
        return secondsToMicroseconds(this.audioElement.currentTime);
    }

    public getTelemetry(): OwnedNativeMediaAudioTelemetry {
        return {
            activeGeneration: this.activeGeneration,
            appendedByteLength: this.appendedByteLength,
            appendedSegmentCount: this.appendedSegmentCount,
            clockQualified: this.clockQualified,
            currentTimeMicroseconds: this.audioElement ? secondsToMicroseconds(this.audioElement.currentTime) : null,
            pendingAppendByteLength: this.pendingAppendByteLength,
            pendingAppendCount: this.pendingAppendCount,
            removedRangeCount: this.removedRangeCount,
            staleOperationCount: this.staleOperationCount,
            state: this.state
        };
    }

    /** Ends the current generation and releases its element and MSE graph. */
    public async stop(generation: number): Promise<boolean> {
        if (this.activeGeneration !== generation) {
            this.staleOperationCount += 1;
            return false;
        }
        await this.teardownActiveSession();
        this.state = 'stopped';
        return true;
    }

    /** Permanently releases the backend. */
    public async destroy(): Promise<void> {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        await this.teardownActiveSession();
        this.state = 'destroyed';
    }

    private configureAudioElement(
        audioElement: HTMLAudioElement,
        mediaSource: MediaSource,
        generation: number
    ): void {
        audioElement.autoplay = false;
        audioElement.controls = false;
        audioElement.preload = 'auto';
        audioElement.setAttribute('aria-hidden', 'true');
        audioElement.classList.add('webgpuOwnedNativeAudio');
        audioElement.addEventListener('ended', (): void => {
            if (this.isSessionCurrent(generation, audioElement, mediaSource)) {
                this.emitEvent({ generation, type: 'ended' });
            }
        });
        audioElement.addEventListener('error', (): void => {
            if (this.isSessionCurrent(generation, audioElement, mediaSource)) {
                this.emitEvent({
                    generation,
                    message: audioElement.error?.message || 'Native audio media error',
                    type: 'error'
                });
            }
        });
        audioElement.addEventListener('pause', (): void => {
            if (this.isSessionCurrent(generation, audioElement, mediaSource)) {
                this.emitEvent({ generation, type: 'pause' });
            }
        });
        audioElement.addEventListener('playing', (): void => {
            if (this.isSessionCurrent(generation, audioElement, mediaSource)) {
                this.state = 'playing';
                this.emitEvent({ generation, type: 'playing' });
            }
        });
        audioElement.addEventListener('timeupdate', (): void => {
            if (!this.isSessionCurrent(generation, audioElement, mediaSource)) {
                return;
            }
            this.qualifyClockIfAdvanced();
            this.resolveAppendRoomWaiters();
        });
        audioElement.addEventListener('waiting', (): void => {
            if (this.isSessionCurrent(generation, audioElement, mediaSource)) {
                this.emitEvent({ generation, type: 'waiting' });
            }
        });
    }

    private enqueueAppend(
        generation: number,
        data: Uint8Array,
        timeRange: SegmentTimeRange | null
    ): Promise<boolean> {
        requireGeneration(generation);
        const dataCopy = data.slice();
        if (this.pendingAppendCount >= MAXIMUM_NATIVE_AUDIO_PENDING_SEGMENT_COUNT
            || this.pendingAppendByteLength + dataCopy.byteLength > MAXIMUM_NATIVE_AUDIO_PENDING_BYTE_LENGTH) {
            return Promise.reject(new RangeError('Native audio append queue is full'));
        }
        this.pendingAppendCount += 1;
        this.pendingAppendByteLength += dataCopy.byteLength;
        const appendOperation = this.appendOperationTail.then(async (): Promise<boolean> => {
            if (!this.isGenerationActive(generation)) {
                this.staleOperationCount += 1;
                return false;
            }
            if (timeRange !== null && !await this.waitForAppendRoom(generation, timeRange)) {
                return false;
            }
            const appended = await this.appendBuffer(generation, dataCopy);
            if (!appended) {
                return false;
            }
            this.appendedByteLength += dataCopy.byteLength;
            if (timeRange === null) {
                this.initializationAppended = true;
            } else {
                if (this.appendedSegmentCount === 0) {
                    this.applyRequestedStartTime(timeRange.startTimeMicroseconds);
                }
                this.appendedSegmentCount += 1;
                await this.trimBufferedHistory(generation);
            }
            return true;
        }).finally((): void => {
            this.pendingAppendCount -= 1;
            this.pendingAppendByteLength -= dataCopy.byteLength;
        });
        this.appendOperationTail = appendOperation.catch((): boolean => false);
        return appendOperation;
    }

    private waitForAppendRoom(generation: number, timeRange: SegmentTimeRange): Promise<boolean> {
        if (!this.initializationAppended) {
            return Promise.reject(new Error('Native audio initialization segment is required'));
        }
        if (this.hasAppendRoom(timeRange)) {
            return Promise.resolve(true);
        }
        return new Promise<boolean>(resolve => {
            this.appendRoomWaiters.add({
                generation,
                resolve,
                timeRange
            });
        });
    }

    private hasAppendRoom(timeRange: SegmentTimeRange): boolean {
        let currentTimeMicroseconds = ZERO_MICROSECONDS;
        const requestedStartTimeMicroseconds = this.requestedStartTimeMicroseconds;
        if (this.appendedSegmentCount === 0 && requestedStartTimeMicroseconds !== null) {
            // A late first fragment is measured from where the element will park on it
            const lateStart = isLateStart(requestedStartTimeMicroseconds, timeRange.startTimeMicroseconds);
            currentTimeMicroseconds = lateStart ? timeRange.startTimeMicroseconds : requestedStartTimeMicroseconds;
        } else if (this.audioElement) {
            currentTimeMicroseconds = secondsToMicroseconds(this.audioElement.currentTime);
        }
        return timeRange.endTimeMicroseconds - currentTimeMicroseconds <= this.maximumAppendedAheadMicroseconds;
    }

    private resolveAppendRoomWaiters(): void {
        for (const waiter of this.appendRoomWaiters) {
            if (!this.isGenerationActive(waiter.generation)) {
                this.appendRoomWaiters.delete(waiter);
                waiter.resolve(false);
                continue;
            }
            if (!this.hasAppendRoom(waiter.timeRange)) {
                continue;
            }
            this.appendRoomWaiters.delete(waiter);
            waiter.resolve(true);
        }
    }

    private cancelAppendRoomWaiters(): void {
        for (const waiter of this.appendRoomWaiters) {
            waiter.resolve(false);
        }
        this.appendRoomWaiters.clear();
    }

    private appendBuffer(generation: number, data: Uint8Array): Promise<boolean> {
        const sourceBuffer = this.sourceBuffer;
        if (!sourceBuffer || !this.isGenerationActive(generation)) {
            this.staleOperationCount += 1;
            return Promise.resolve(false);
        }
        return this.runSourceBufferOperation(generation, sourceBuffer, (): void => {
            const appendData = new Uint8Array(data.byteLength);
            appendData.set(data);
            sourceBuffer.appendBuffer(appendData.buffer);
        });
    }

    private async trimBufferedHistory(generation: number): Promise<void> {
        const sourceBuffer = this.sourceBuffer;
        const audioElement = this.audioElement;
        if (!sourceBuffer || !audioElement || !this.isGenerationActive(generation)) {
            return;
        }
        const removalEndMicroseconds = secondsToMicroseconds(audioElement.currentTime) - this.retainedBehindMicroseconds;
        if (removalEndMicroseconds <= ZERO_MICROSECONDS || sourceBuffer.buffered.length === 0) {
            return;
        }
        const firstRangeStartMicroseconds = secondsToMicroseconds(sourceBuffer.buffered.start(0));
        const firstRangeEndMicroseconds = secondsToMicroseconds(sourceBuffer.buffered.end(0));
        const boundedRemovalEndMicroseconds = Math.min(removalEndMicroseconds, firstRangeEndMicroseconds) as Microseconds;
        if (boundedRemovalEndMicroseconds <= firstRangeStartMicroseconds) {
            return;
        }
        const removed = await this.runSourceBufferOperation(
            generation,
            sourceBuffer,
            (): void => sourceBuffer.remove(
                microsecondsToSeconds(firstRangeStartMicroseconds),
                microsecondsToSeconds(boundedRemovalEndMicroseconds)
            )
        );
        if (removed) {
            this.removedRangeCount += 1;
        }
    }

    private runSourceBufferOperation(
        generation: number,
        sourceBuffer: SourceBuffer,
        operation: () => void
    ): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            const timeout = globalThis.setTimeout((): void => {
                cleanup();
                reject(new Error('Native audio SourceBuffer operation timed out'));
            }, microsecondsToMilliseconds(this.operationTimeoutMicroseconds));
            const onUpdateEnd = (): void => {
                cleanup();
                resolve(this.isGenerationActive(generation));
            };
            const onError = (): void => {
                cleanup();
                reject(new Error('Native audio SourceBuffer operation failed'));
            };
            const cleanup = (): void => {
                globalThis.clearTimeout(timeout);
                sourceBuffer.removeEventListener('updateend', onUpdateEnd);
                sourceBuffer.removeEventListener('error', onError);
                sourceBuffer.removeEventListener('abort', onError);
            };
            sourceBuffer.addEventListener('updateend', onUpdateEnd);
            sourceBuffer.addEventListener('error', onError);
            sourceBuffer.addEventListener('abort', onError);
            try {
                operation();
            } catch (error) {
                cleanup();
                reject(error);
            }
        });
    }

    private waitForMediaSourceOpen(mediaSource: MediaSource, generation: number): Promise<boolean> {
        if (mediaSource.readyState === 'open') {
            return Promise.resolve(this.isGenerationActive(generation));
        }
        return new Promise<boolean>((resolve, reject) => {
            const timeout = globalThis.setTimeout((): void => {
                cleanup();
                reject(new Error('Native audio MediaSource open timed out'));
            }, microsecondsToMilliseconds(this.operationTimeoutMicroseconds));
            const onSourceOpen = (): void => {
                cleanup();
                resolve(this.isGenerationActive(generation));
            };
            const onSourceClose = (): void => {
                cleanup();
                resolve(false);
            };
            const cleanup = (): void => {
                globalThis.clearTimeout(timeout);
                mediaSource.removeEventListener('sourceopen', onSourceOpen);
                mediaSource.removeEventListener('sourceclose', onSourceClose);
            };
            mediaSource.addEventListener('sourceopen', onSourceOpen);
            mediaSource.addEventListener('sourceclose', onSourceClose);
        });
    }

    private qualifyClockIfAdvanced(): void {
        const audioElement = this.audioElement;
        const baselineMicroseconds = this.clockBaselineMicroseconds;
        // A parked late start is no clock, whatever position it reports, until play() begins
        if (this.clockQualified
            || !audioElement
            || baselineMicroseconds === null
            || this.lateStartGapMicroseconds !== null) {
            return;
        }
        const currentTimeMicroseconds = secondsToMicroseconds(audioElement.currentTime);
        if (currentTimeMicroseconds <= baselineMicroseconds) {
            return;
        }
        this.clockQualified = true;
        const generation = this.activeGeneration;
        if (generation !== null) {
            this.emitEvent({ generation, type: 'clock-ready' });
        }
    }

    /** Seeks to the requested start, or parks on a first fragment that starts late */
    private applyRequestedStartTime(firstSegmentStartMicroseconds: Microseconds): void {
        const audioElement = this.audioElement;
        const requestedStartTimeMicroseconds = this.requestedStartTimeMicroseconds;
        if (!audioElement || requestedStartTimeMicroseconds === null) {
            return;
        }
        if (!isLateStart(requestedStartTimeMicroseconds, firstSegmentStartMicroseconds)) {
            audioElement.currentTime = microsecondsToSeconds(requestedStartTimeMicroseconds);
            return;
        }
        // Chromium only snaps a seek onto buffered media starting within one second, so park on it
        audioElement.currentTime = microsecondsToSeconds(firstSegmentStartMicroseconds);
        this.clockBaselineMicroseconds = firstSegmentStartMicroseconds;
        // A play() requested before any media arrived starts at the fragment at once
        if (!audioElement.paused) {
            return;
        }
        this.lateStartGapMicroseconds = (firstSegmentStartMicroseconds - requestedStartTimeMicroseconds) as Microseconds;
    }

    /** Defers play() until the media clock has covered the remaining late-start gap */
    private startLateStartTimer(generation: number, audioElement: HTMLAudioElement): void {
        const lateStartGapMicroseconds = this.lateStartGapMicroseconds;
        if (lateStartGapMicroseconds === null || this.lateStartTimer) {
            return;
        }
        const mediaSource = this.mediaSource;
        const playbackRate = audioElement.playbackRate;
        // An overdue gap left by a suspended timer plays at once
        const delayMilliseconds = Math.max(Math.ceil(microsecondsToMilliseconds(lateStartGapMicroseconds) / playbackRate), 0);
        const lateStartTimer: LateStartTimer = {
            handle: globalThis.setTimeout((): void => {
                // A stale timer must never play a replaced element
                if (this.lateStartTimer !== lateStartTimer || !this.isSessionCurrent(generation, audioElement, mediaSource)) {
                    return;
                }
                // Hidden tabs fire throttled timers late while the page clock keeps running
                const overshootMicroseconds = (
                    measureLateStartCoverageMicroseconds(lateStartTimer) - lateStartGapMicroseconds
                ) as Microseconds;
                this.clearLateStart();
                this.advanceParkedElement(audioElement, overshootMicroseconds);
                void this.playParkedElement(generation, audioElement);
            }, delayMilliseconds),
            playbackRate,
            startedAtMicroseconds: readMonotonicTimeMicroseconds()
        };
        this.lateStartTimer = lateStartTimer;
    }

    /** Stops the deferred play() timer and keeps the gap it has not covered, negative once overdue */
    private suspendLateStartTimer(): void {
        const lateStartTimer = this.lateStartTimer;
        const lateStartGapMicroseconds = this.lateStartGapMicroseconds;
        if (!lateStartTimer || lateStartGapMicroseconds === null) {
            return;
        }
        globalThis.clearTimeout(lateStartTimer.handle);
        this.lateStartTimer = null;
        // An overdue timer keeps its overshoot as a negative gap, so the resumed play() still catches up
        this.lateStartGapMicroseconds = (lateStartGapMicroseconds - measureLateStartCoverageMicroseconds(lateStartTimer)) as Microseconds;
    }

    /** Restarts a running deferred play() timer at the current element rate */
    private retimeLateStartTimer(): void {
        const generation = this.activeGeneration;
        const audioElement = this.audioElement;
        if (!this.lateStartTimer || generation === null || !audioElement) {
            return;
        }
        this.suspendLateStartTimer();
        this.startLateStartTimer(generation, audioElement);
    }

    /** Drops a pending late start together with its deferred play() timer */
    private clearLateStart(): void {
        if (this.lateStartTimer) {
            globalThis.clearTimeout(this.lateStartTimer.handle);
        }
        this.lateStartTimer = null;
        this.lateStartGapMicroseconds = null;
    }

    /**
     * Moves the parked element and its clock baseline on by a late timer's overshoot before play().
     * The move stops at the end of the buffered range holding the parked point and is skipped without one.
     */
    private advanceParkedElement(audioElement: HTMLAudioElement, overshootMicroseconds: Microseconds): void {
        const parkedMicroseconds = this.clockBaselineMicroseconds;
        if (overshootMicroseconds <= NATIVE_AUDIO_LATE_START_OVERSHOOT_THRESHOLD_MICROSECONDS || parkedMicroseconds === null) {
            return;
        }
        const bufferedEndMicroseconds = findParkedBufferedRangeEndMicroseconds(audioElement.buffered, parkedMicroseconds);
        if (bufferedEndMicroseconds === null) {
            return;
        }
        const advancedMicroseconds = Math.min(parkedMicroseconds + overshootMicroseconds, bufferedEndMicroseconds) as Microseconds;
        // The baseline moves first, so the moved position never counts as playback progress
        this.clockBaselineMicroseconds = advancedMicroseconds;
        audioElement.currentTime = microsecondsToSeconds(advancedMicroseconds);
        this.resolveAppendRoomWaiters();
    }

    /** Records every deferred play() issued so far as interrupted by the backend itself */
    private markDeferredPlayInterrupted(): void {
        this.interruptedDeferredPlayRequestCount = this.deferredPlayRequestCount;
    }

    /**
     * Plays the parked element and reports a rejected play() as an error event.
     * Only an abort the backend caused through a pause, seek, or teardown stays silent.
     */
    private async playParkedElement(generation: number, audioElement: HTMLAudioElement): Promise<void> {
        this.deferredPlayRequestCount += 1;
        const playRequestNumber = this.deferredPlayRequestCount;
        try {
            await audioElement.play();
        } catch (error) {
            const interruptedByBackend = getErrorName(error) === PLAY_INTERRUPTED_ERROR_NAME
                && playRequestNumber <= this.interruptedDeferredPlayRequestCount;
            // A replaced session or the backend's own interruption is not a playback failure
            if (interruptedByBackend || !this.isSessionCurrent(generation, audioElement, this.mediaSource)) {
                return;
            }
            this.state = 'paused';
            await this.audioOutputTargetLease?.setIntendedRunning(false);
            if (!this.isSessionCurrent(generation, audioElement, this.mediaSource)) {
                return;
            }
            this.emitEvent({ generation, message: getPlayFailureMessage(error), type: 'error' });
        }
    }

    private async teardownActiveSession(): Promise<void> {
        const audioElement = this.audioElement;
        const objectURL = this.objectURL;
        const audioOutputTargetLease = this.audioOutputTargetLease;
        this.activeGeneration = null;
        this.audioOutputTargetLease = null;
        this.clearLateStart();
        this.markDeferredPlayInterrupted();
        if (audioElement) {
            // Silence the retired sink before asynchronous SourceBuffer cleanup can block
            audioElement.muted = true;
            audioElement.pause();
        }
        this.cancelAppendRoomWaiters();
        await audioOutputTargetLease?.release();
        await this.appendOperationTail.catch((): void => undefined);
        this.appendOperationTail = Promise.resolve(true);
        this.pendingAppendCount = 0;
        this.pendingAppendByteLength = 0;
        this.audioElement = null;
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.objectURL = null;
        this.initializationAppended = false;
        this.clockBaselineMicroseconds = null;
        this.clockQualified = false;
        this.requestedStartTimeMicroseconds = null;
        if (audioElement) {
            audioElement.removeAttribute('src');
            audioElement.load();
            audioElement.remove();
        }
        if (objectURL) {
            this.revokeObjectURL(objectURL);
        }
    }

    private getCurrentAudioElement(generation: number): HTMLAudioElement | null {
        requireGeneration(generation);
        return this.activeGeneration === generation ? this.audioElement : null;
    }

    private isGenerationActive(generation: number): boolean {
        return !this.destroyed && this.activeGeneration === generation;
    }

    private isSessionCurrent(
        generation: number,
        audioElement: HTMLAudioElement,
        mediaSource: MediaSource | null
    ): boolean {
        return this.isGenerationActive(generation)
            && this.audioElement === audioElement
            && this.mediaSource === mediaSource;
    }

    private emitEvent(event: OwnedNativeMediaAudioEvent): void {
        try {
            this.eventHandler(event);
        } catch (error) {
            console.warn('Owned native audio event handler failed', error);
        }
    }

    private requireUsable(): void {
        if (this.destroyed) {
            throw new Error('Owned native audio backend is destroyed');
        }
    }
}
