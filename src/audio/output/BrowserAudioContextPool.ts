import {
    type AudioOutputDevicePresence,
    probeDefaultAudioOutputDevicePresence
} from './AudioOutputDevicePresence';
import {
    SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS,
    waitForBrowserAudioOperation
} from './BrowserAudioOperation';

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

type AudioContextRuntime = typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor
};

type AudioContextWithSinkSelection = AudioContext & {
    setSinkId?: unknown
};

type SharedBrowserAudioContextState = {
    audioContext: AudioContext
    closePromise: Promise<void> | null
    createdWithoutOutputDevice: boolean
    invalidated: boolean
    outputDeviceDetection: Promise<boolean>
    referenceCount: number
    requestedSampleRate: number
};

export type SharedBrowserAudioContextReference = {
    readonly audioContext: AudioContext
    // Resolves true when the context was created without any audio output device
    readonly createdWithoutOutputDevice: Promise<boolean>
    readonly resumePromise: Promise<void>
    invalidate: () => Promise<void>
    isValid: () => boolean
    release: () => Promise<void>
};

const sharedStatesBySampleRate = new Map<number, SharedBrowserAudioContextState>();

function getAudioContextConstructor(): AudioContextConstructor {
    const runtime = globalThis as AudioContextRuntime;
    const constructor = runtime.AudioContext ?? runtime.webkitAudioContext;
    if (!constructor) {
        throw new Error('AudioContext is unavailable');
    }
    return constructor;
}

function validateSampleRate(sampleRate: number): void {
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
        throw new RangeError('AudioContext sample rate must be a positive safe integer');
    }
}

function removeSharedState(state: SharedBrowserAudioContextState): void {
    if (sharedStatesBySampleRate.get(state.requestedSampleRate) === state) {
        sharedStatesBySampleRate.delete(state.requestedSampleRate);
    }
}

function closeSharedState(state: SharedBrowserAudioContextState): Promise<void> {
    if (state.closePromise) {
        return state.closePromise;
    }

    removeSharedState(state);
    state.invalidated = true;
    if (state.audioContext.state === 'closed') {
        state.closePromise = Promise.resolve();
        return state.closePromise;
    }

    // eslint-disable-next-line sonarjs/no-try-promise -- AudioContext close may throw synchronously
    try {
        state.closePromise = waitForBrowserAudioOperation(
            state.audioContext.close(),
            'Shared AudioContext close',
            SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS
        );
    } catch (error) {
        state.closePromise = Promise.reject(error);
    }
    return state.closePromise;
}

function closeInvalidatedStateWhenIdle(
    state: SharedBrowserAudioContextState
): Promise<void> {
    if (!state.invalidated || state.referenceCount > 0) {
        return Promise.resolve();
    }
    return closeSharedState(state);
}

function suspendSharedStateWhenIdle(
    state: SharedBrowserAudioContextState
): Promise<void> {
    if (state.createdWithoutOutputDevice && state.referenceCount === 0) {
        // A context created without an output device is closed instead of pooled
        state.invalidated = true;
        removeSharedState(state);
    }
    if (state.invalidated) {
        return closeInvalidatedStateWhenIdle(state);
    }
    if (state.referenceCount > 0
        || state.audioContext.state === 'closed') {
        return Promise.resolve();
    }

    let suspendPromise: Promise<void>;
    // eslint-disable-next-line sonarjs/no-try-promise -- AudioContext suspend may throw synchronously
    try {
        // Suspend even while the public state is still "suspended": a resume
        // control message may already be pending behind that stale state
        suspendPromise = waitForBrowserAudioOperation(
            state.audioContext.suspend(),
            'Idle shared AudioContext suspend',
            SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS
        );
    } catch (error) {
        suspendPromise = Promise.reject(error);
    }
    return suspendPromise.catch((error: unknown): never => {
        if (state.referenceCount === 0) {
            state.invalidated = true;
            removeSharedState(state);
            void closeSharedState(state).catch((): void => undefined);
        }
        throw error;
    });
}

function invalidateIdleStatesExcept(sampleRate: number): void {
    for (const state of sharedStatesBySampleRate.values()) {
        if (state.requestedSampleRate === sampleRate) {
            continue;
        }
        state.invalidated = true;
        removeSharedState(state);
        void closeInvalidatedStateWhenIdle(state).catch((): void => undefined);
    }
}

function getDestinationMaximumChannelCount(audioContext: AudioContext): number | null {
    try {
        const maximumChannelCount = audioContext.destination.maxChannelCount;
        return Number.isSafeInteger(maximumChannelCount) ? maximumChannelCount : null;
    } catch {
        return null;
    }
}

/**
 * Resolves true when a new context can reach no output device for its
 * lifetime. Chromium bakes fake-output parameters into a context created
 * without an output device, and Firefox gives it zero output channels.
 */
function detectCreationWithoutOutputDevice(
    audioContext: AudioContext,
    outputDevicePresence: Promise<AudioOutputDevicePresence>
): Promise<boolean> {
    if (getDestinationMaximumChannelCount(audioContext) === 0) {
        return Promise.resolve(true);
    }
    // NOTE: Only engines with AudioContext.setSinkId list outputs without permission
    if (typeof (audioContext as AudioContextWithSinkSelection).setSinkId !== 'function') {
        return Promise.resolve(false);
    }
    return outputDevicePresence.then(
        (presence: AudioOutputDevicePresence): boolean => presence === 'absent'
    );
}

function markCreatedWithoutOutputDevice(state: SharedBrowserAudioContextState): void {
    state.createdWithoutOutputDevice = true;
    if (state.referenceCount > 0) {
        return;
    }
    // Detection can finish after the last release, so the idle context closes now
    state.invalidated = true;
    removeSharedState(state);
    void closeInvalidatedStateWhenIdle(state).catch((): void => undefined);
}

function createSharedState(sampleRate: number): SharedBrowserAudioContextState {
    const AudioContextClass = getAudioContextConstructor();
    // Enumerating before construction turns a racing device change into a
    // spare sink rebuild instead of a missed context that renders nowhere
    const outputDevicePresence = probeDefaultAudioOutputDevicePresence();
    const audioContext = new AudioContextClass({
        latencyHint: 'playback',
        sampleRate
    });
    if (audioContext.sampleRate !== sampleRate) {
        // eslint-disable-next-line sonarjs/no-try-promise -- AudioContext close may throw synchronously
        try {
            void waitForBrowserAudioOperation(
                audioContext.close(),
                'Mismatched AudioContext close',
                SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS
            ).catch((): void => undefined);
        } catch {
            // Preserve the requested-rate error below
        }
        throw new RangeError('The browser did not create the requested audio sample rate');
    }

    const state: SharedBrowserAudioContextState = {
        audioContext,
        closePromise: null,
        createdWithoutOutputDevice: false,
        invalidated: false,
        outputDeviceDetection: Promise.resolve(false),
        referenceCount: 0,
        requestedSampleRate: sampleRate
    };
    state.outputDeviceDetection = detectCreationWithoutOutputDevice(
        audioContext,
        outputDevicePresence
    ).then((createdWithoutOutputDevice: boolean): boolean => {
        if (createdWithoutOutputDevice) {
            markCreatedWithoutOutputDevice(state);
        }
        return createdWithoutOutputDevice;
    });
    sharedStatesBySampleRate.set(sampleRate, state);
    invalidateIdleStatesExcept(sampleRate);
    return state;
}

function getSharedState(sampleRate: number): SharedBrowserAudioContextState {
    const existingState = sharedStatesBySampleRate.get(sampleRate);
    // A context created without an output device stays with its current
    // references, and the next acquisition gets a fresh context
    if (existingState
        && !existingState.invalidated
        && !existingState.createdWithoutOutputDevice
        && existingState.audioContext.state !== 'closed') {
        return existingState;
    }
    if (existingState) {
        existingState.invalidated = true;
        removeSharedState(existingState);
        void closeInvalidatedStateWhenIdle(existingState).catch((): void => undefined);
    }
    return createSharedState(sampleRate);
}

/**
 * Acquires the shared exact-rate context used by custom audio outputs. Session
 * teardown suspends its destination but keeps the context and worklet module
 * warm, avoiding Chromium retention of one closed wrapper per item. A context
 * created without an output device is closed instead, because it never reaches
 * a device that appears later.
 */
export function acquireSharedBrowserAudioContext(
    sampleRate: number
): SharedBrowserAudioContextReference {
    validateSampleRate(sampleRate);
    const state = getSharedState(sampleRate);
    state.referenceCount += 1;

    let resumePromise: Promise<void>;
    // eslint-disable-next-line sonarjs/no-try-promise -- Resume must run in this activation task
    try {
        // Calling resume while Chromium has an asynchronous suspend pending
        // cancels that transition before the destination stops rendering
        resumePromise = state.audioContext.resume();
    } catch (error) {
        state.referenceCount -= 1;
        state.invalidated = true;
        removeSharedState(state);
        void closeInvalidatedStateWhenIdle(state).catch((): void => undefined);
        throw error;
    }
    // Preserve the rejection for the consumer without reporting it before consumption
    resumePromise.catch((): void => undefined);

    let releasePromise: Promise<void> | null = null;
    const release = (invalidate: boolean): Promise<void> => {
        if (releasePromise) {
            return releasePromise;
        }
        if (invalidate) {
            state.invalidated = true;
            removeSharedState(state);
        }
        state.referenceCount -= 1;
        releasePromise = suspendSharedStateWhenIdle(state);
        return releasePromise;
    };

    return {
        audioContext: state.audioContext,
        createdWithoutOutputDevice: state.outputDeviceDetection,
        invalidate: (): Promise<void> => release(true),
        isValid: (): boolean => !state.invalidated
            && state.audioContext.state !== 'closed'
            && sharedStatesBySampleRate.get(state.requestedSampleRate) === state,
        release: (): Promise<void> => release(false),
        resumePromise
    };
}

/** Closes every idle shared context, primarily for deterministic runtime teardown. */
export function closeIdleSharedBrowserAudioContexts(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const state of sharedStatesBySampleRate.values()) {
        state.invalidated = true;
        removeSharedState(state);
        if (state.referenceCount === 0) {
            closePromises.push(closeSharedState(state));
        }
    }
    return Promise.all(closePromises).then((): void => undefined);
}
