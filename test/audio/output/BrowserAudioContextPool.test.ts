import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { microsecondsToMilliseconds } from 'webgpu-player/MediaTime';
import {
    acquireSharedBrowserAudioContext,
    closeIdleSharedBrowserAudioContexts
} from 'webgpu-player/audio/output/BrowserAudioContextPool';
import {
    DEFAULT_BROWSER_AUDIO_OPERATION_TIMEOUT_MICROSECONDS,
    SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS
} from 'webgpu-player/audio/output/BrowserAudioOperation';

type Deferred = {
    promise: Promise<void>
    resolve: () => void
};

type DeviceListDeferred = {
    promise: Promise<MediaDeviceInfo[]>
    resolve: (devices: MediaDeviceInfo[]) => void
};

function createDeferred(): Deferred {
    let resolvePromise: (() => void) | null = null;
    const promise = new Promise<void>((resolve): void => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: (): void => {
            if (!resolvePromise) {
                throw new Error('Deferred resolver is unavailable');
            }
            resolvePromise();
        }
    };
}

function createDeviceListDeferred(): DeviceListDeferred {
    let resolvePromise: ((devices: MediaDeviceInfo[]) => void) | null = null;
    const promise = new Promise<MediaDeviceInfo[]>((resolve): void => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: (devices: MediaDeviceInfo[]): void => {
            if (!resolvePromise) {
                throw new Error('Device list deferred resolver is unavailable');
            }
            resolvePromise(devices);
        }
    };
}

class FakeAudioContext {
    public static readonly instances: FakeAudioContext[] = [];
    public readonly close = vi.fn((): Promise<void> => {
        this.state = 'closed';
        return Promise.resolve();
    });
    public readonly resume = vi.fn((): Promise<void> => {
        this.state = 'running';
        return Promise.resolve();
    });
    public readonly sampleRate: number;
    public state: AudioContextState = 'suspended';
    public readonly suspend = vi.fn((): Promise<void> => {
        this.state = 'suspended';
        return Promise.resolve();
    });

    public constructor(public readonly options?: AudioContextOptions) {
        this.sampleRate = options?.sampleRate ?? 48_000;
        FakeAudioContext.instances.push(this);
    }
}

// AudioContext.setSinkId marks a Chromium-family engine, where an empty enumeration is conclusive
class SinkSelectingAudioContext extends FakeAudioContext {
    public readonly setSinkId = vi.fn((): Promise<void> => Promise.resolve());
}

// Firefox gives a context created without an output device zero output channels
class ZeroChannelAudioContext extends FakeAudioContext {
    public readonly destination = { maxChannelCount: 0 } as AudioDestinationNode;
}

class FakeMediaDevices {
    public devices: MediaDeviceInfo[] = [];
    public readonly enumerateDevices = vi.fn(
        (): Promise<MediaDeviceInfo[]> => Promise.resolve([ ...this.devices ])
    );
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

function stubMediaDevices(): FakeMediaDevices {
    const mediaDevices = new FakeMediaDevices();
    vi.stubGlobal('navigator', { mediaDevices });
    return mediaDevices;
}

describe('BrowserAudioContextPool', () => {
    beforeEach(() => {
        FakeAudioContext.instances.length = 0;
        vi.stubGlobal('AudioContext', FakeAudioContext);
    });

    afterEach(async () => {
        vi.useRealTimers();
        await closeIdleSharedBrowserAudioContexts().catch((): void => undefined);
        vi.unstubAllGlobals();
    });

    it('shares one context across simultaneous guarded references', async () => {
        const firstReference = acquireSharedBrowserAudioContext(48_000);
        const secondReference = acquireSharedBrowserAudioContext(48_000);

        expect(secondReference.audioContext).toBe(firstReference.audioContext);
        expect(firstReference.isValid()).toBe(true);
        expect(FakeAudioContext.instances).toHaveLength(1);

        await firstReference.release();
        await firstReference.release();
        await secondReference.release();

        expect(FakeAudioContext.instances[0].close).not.toHaveBeenCalled();
        expect(FakeAudioContext.instances[0].resume).toHaveBeenCalledTimes(2);
        expect(FakeAudioContext.instances[0].suspend).toHaveBeenCalledOnce();
    });

    it('resumes synchronously when reacquired during an asynchronous idle suspend', async () => {
        const deferredSuspend = createDeferred();
        const firstReference = acquireSharedBrowserAudioContext(48_000);
        const audioContext = FakeAudioContext.instances[0];
        await firstReference.resumePromise;
        audioContext.suspend.mockImplementationOnce((): Promise<void> => deferredSuspend.promise);

        const firstRelease = firstReference.release();
        const secondReference = acquireSharedBrowserAudioContext(48_000);

        expect(audioContext.suspend).toHaveBeenCalledOnce();
        expect(audioContext.resume).toHaveBeenCalledTimes(2);
        deferredSuspend.resolve();
        await firstRelease;
        await secondReference.resumePromise;
        await secondReference.release();

        expect(audioContext.suspend).toHaveBeenCalledTimes(2);
        expect(audioContext.state).toBe('suspended');
    });

    it('does not close an active reacquisition when the stale suspend rejects', async () => {
        const firstReference = acquireSharedBrowserAudioContext(48_000);
        const audioContext = FakeAudioContext.instances[0];
        await firstReference.resumePromise;
        audioContext.suspend.mockRejectedValueOnce(new Error('stale suspend failed'));

        const staleRelease = firstReference.release();
        const activeReference = acquireSharedBrowserAudioContext(48_000);

        await expect(staleRelease).rejects.toThrow('stale suspend failed');
        expect(audioContext.close).not.toHaveBeenCalled();
        expect(activeReference.audioContext).toBe(audioContext);
        await activeReference.resumePromise;
        await activeReference.release();

        expect(audioContext.suspend).toHaveBeenCalledTimes(2);
        expect(audioContext.state).toBe('suspended');
    });

    it('suspends after a pending resume even while the public state is suspended', async () => {
        const deferredResume = createDeferred();
        const reference = acquireSharedBrowserAudioContext(48_000);
        const audioContext = FakeAudioContext.instances[0];
        audioContext.state = 'suspended';
        audioContext.resume.mockReset();
        audioContext.resume.mockImplementationOnce(async (): Promise<void> => {
            await deferredResume.promise;
            audioContext.state = 'running';
        });

        // Reacquire with the delayed implementation installed to model an
        // asynchronous browser state transition
        await reference.release();
        const pendingReference = acquireSharedBrowserAudioContext(48_000);
        audioContext.suspend.mockImplementationOnce(async (): Promise<void> => {
            await deferredResume.promise;
            audioContext.state = 'suspended';
        });

        const releasePromise = pendingReference.release();
        expect(audioContext.state).toBe('suspended');
        expect(audioContext.suspend).toHaveBeenCalledTimes(2);
        deferredResume.resolve();
        await pendingReference.resumePromise;
        await releasePromise;

        expect(audioContext.state).toBe('suspended');
    });

    it('bounds a stalled final-reference idle suspend', async () => {
        vi.useFakeTimers();
        const reference = acquireSharedBrowserAudioContext(48_000);
        const audioContext = FakeAudioContext.instances[0];
        await reference.resumePromise;
        audioContext.suspend.mockReturnValueOnce(new Promise(() => undefined));

        const releaseResult = reference.release();
        const observedResult = releaseResult.catch((error: unknown): unknown => error);
        await vi.advanceTimersByTimeAsync(microsecondsToMilliseconds(
            SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS
        ));

        expect(await observedResult).toEqual(
            new Error('Idle shared AudioContext suspend exceeded its bounded timeout')
        );
        expect(audioContext.suspend).toHaveBeenCalledOnce();
        expect(audioContext.close).toHaveBeenCalledOnce();

        const replacementReference = acquireSharedBrowserAudioContext(48_000);
        expect(replacementReference.audioContext).not.toBe(audioContext);
        await replacementReference.release();
    });

    it('invalidates a context when resume throws synchronously', async () => {
        const poisonedReference = acquireSharedBrowserAudioContext(48_000);
        const poisonedContext = FakeAudioContext.instances[0];
        await poisonedReference.release();
        poisonedContext.resume.mockImplementationOnce((): Promise<void> => {
            throw new Error('resume failed');
        });

        expect(() => acquireSharedBrowserAudioContext(48_000)).toThrow('resume failed');
        await Promise.resolve();
        expect(poisonedContext.close).toHaveBeenCalledOnce();

        const replacementReference = acquireSharedBrowserAudioContext(48_000);
        expect(replacementReference.audioContext).not.toBe(poisonedContext);
        await replacementReference.release();
    });

    it('does not let stale invalidation evict its replacement context', async () => {
        const deferredClose = createDeferred();
        const staleReference = acquireSharedBrowserAudioContext(48_000);
        const staleContext = FakeAudioContext.instances[0];
        staleContext.close.mockImplementationOnce((): Promise<void> => deferredClose.promise);

        const staleInvalidation = staleReference.invalidate();
        expect(staleReference.isValid()).toBe(false);
        const replacementReference = acquireSharedBrowserAudioContext(48_000);
        const replacementContext = FakeAudioContext.instances[1];

        deferredClose.resolve();
        await staleInvalidation;
        await replacementReference.release();

        const nextReference = acquireSharedBrowserAudioContext(48_000);
        expect(nextReference.audioContext).toBe(replacementContext);
        expect(FakeAudioContext.instances).toHaveLength(2);
        await nextReference.release();
    });

    it('closes a context created without an output device instead of pooling it', async () => {
        vi.stubGlobal('AudioContext', SinkSelectingAudioContext);
        stubMediaDevices();
        const reference = acquireSharedBrowserAudioContext(48_000);
        const audioContext = FakeAudioContext.instances[0];

        await expect(reference.createdWithoutOutputDevice).resolves.toBe(true);
        await reference.release();

        expect(audioContext.close).toHaveBeenCalledOnce();
        expect(audioContext.suspend).not.toHaveBeenCalled();
        const nextReference = acquireSharedBrowserAudioContext(48_000);
        expect(nextReference.audioContext).not.toBe(audioContext);
        expect(FakeAudioContext.instances).toHaveLength(2);
        await nextReference.release();
    });

    it('pools a context created while an output device is listed', async () => {
        vi.stubGlobal('AudioContext', SinkSelectingAudioContext);
        const mediaDevices = stubMediaDevices();
        mediaDevices.devices = [ createBlankAudioOutputDevice() ];
        const reference = acquireSharedBrowserAudioContext(48_000);
        const audioContext = FakeAudioContext.instances[0];

        await expect(reference.createdWithoutOutputDevice).resolves.toBe(false);
        await reference.release();
        const nextReference = acquireSharedBrowserAudioContext(48_000);

        expect(audioContext.suspend).toHaveBeenCalledOnce();
        expect(audioContext.close).not.toHaveBeenCalled();
        expect(nextReference.audioContext).toBe(audioContext);
        // Only context creation probes the output devices
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledOnce();
        await nextReference.release();
    });

    it('replaces a still-referenced context created without an output device on the next acquisition', async () => {
        vi.stubGlobal('AudioContext', SinkSelectingAudioContext);
        const mediaDevices = stubMediaDevices();
        const staleReference = acquireSharedBrowserAudioContext(48_000);
        const staleContext = FakeAudioContext.instances[0];
        await expect(staleReference.createdWithoutOutputDevice).resolves.toBe(true);
        expect(staleReference.isValid()).toBe(true);

        mediaDevices.devices = [ createBlankAudioOutputDevice() ];
        const replacementReference = acquireSharedBrowserAudioContext(48_000);
        const replacementContext = FakeAudioContext.instances[1];

        expect(FakeAudioContext.instances).toHaveLength(2);
        expect(replacementReference.audioContext).toBe(replacementContext);
        expect(staleReference.isValid()).toBe(false);
        expect(staleContext.close).not.toHaveBeenCalled();
        await staleReference.release();
        expect(staleContext.close).toHaveBeenCalledOnce();
        expect(staleContext.suspend).not.toHaveBeenCalled();

        await expect(replacementReference.createdWithoutOutputDevice).resolves.toBe(false);
        await replacementReference.release();
        const pooledReference = acquireSharedBrowserAudioContext(48_000);
        expect(pooledReference.audioContext).toBe(replacementContext);
        expect(replacementContext.close).not.toHaveBeenCalled();
        await pooledReference.release();
    });

    it('closes an idle context once late detection finds no output device', async () => {
        vi.stubGlobal('AudioContext', SinkSelectingAudioContext);
        const mediaDevices = stubMediaDevices();
        const deviceList = createDeviceListDeferred();
        mediaDevices.enumerateDevices.mockReturnValueOnce(deviceList.promise);
        const reference = acquireSharedBrowserAudioContext(48_000);
        const audioContext = FakeAudioContext.instances[0];

        await reference.release();
        expect(audioContext.suspend).toHaveBeenCalledOnce();
        expect(audioContext.close).not.toHaveBeenCalled();

        deviceList.resolve([]);
        await expect(reference.createdWithoutOutputDevice).resolves.toBe(true);

        expect(audioContext.close).toHaveBeenCalledOnce();
        const nextReference = acquireSharedBrowserAudioContext(48_000);
        expect(nextReference.audioContext).not.toBe(audioContext);
        await nextReference.release();
    });

    it('treats an empty enumeration as inconclusive without sink selection', async () => {
        const mediaDevices = stubMediaDevices();
        const reference = acquireSharedBrowserAudioContext(48_000);
        const audioContext = FakeAudioContext.instances[0];

        await expect(reference.createdWithoutOutputDevice).resolves.toBe(false);
        await reference.release();
        const nextReference = acquireSharedBrowserAudioContext(48_000);

        // Engines without AudioContext.setSinkId hide outputs until permission is granted
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledOnce();
        expect(audioContext.close).not.toHaveBeenCalled();
        expect(nextReference.audioContext).toBe(audioContext);
        await nextReference.release();
    });

    it('closes a context whose destination has zero output channels', async () => {
        vi.stubGlobal('AudioContext', ZeroChannelAudioContext);
        const mediaDevices = stubMediaDevices();
        // Zero channels decide even when enumeration lists an output
        mediaDevices.devices = [ createBlankAudioOutputDevice() ];
        const reference = acquireSharedBrowserAudioContext(48_000);
        const audioContext = FakeAudioContext.instances[0];

        await expect(reference.createdWithoutOutputDevice).resolves.toBe(true);
        await reference.release();

        expect(audioContext.close).toHaveBeenCalledOnce();
        expect(audioContext.suspend).not.toHaveBeenCalled();
        const nextReference = acquireSharedBrowserAudioContext(48_000);
        expect(nextReference.audioContext).not.toBe(audioContext);
        await nextReference.release();
    });

    it.each([
        {
            condition: 'a rejected enumeration',
            mediaDevices: {
                enumerateDevices: (): Promise<MediaDeviceInfo[]> => Promise.reject(
                    new Error('Device enumeration failed')
                )
            }
        },
        { condition: 'missing media devices', mediaDevices: undefined }
    ])('treats $condition as an inconclusive output probe', async ({ mediaDevices }) => {
        vi.stubGlobal('AudioContext', SinkSelectingAudioContext);
        vi.stubGlobal('navigator', { mediaDevices });
        const reference = acquireSharedBrowserAudioContext(48_000);
        const audioContext = FakeAudioContext.instances[0];

        await expect(reference.createdWithoutOutputDevice).resolves.toBe(false);
        await reference.release();

        expect(audioContext.suspend).toHaveBeenCalledOnce();
        expect(audioContext.close).not.toHaveBeenCalled();
    });

    it('treats a stalled enumeration as an inconclusive output probe', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('AudioContext', SinkSelectingAudioContext);
        const mediaDevices = stubMediaDevices();
        mediaDevices.enumerateDevices.mockReturnValueOnce(new Promise(() => undefined));
        const reference = acquireSharedBrowserAudioContext(48_000);

        await vi.advanceTimersByTimeAsync(microsecondsToMilliseconds(
            DEFAULT_BROWSER_AUDIO_OPERATION_TIMEOUT_MICROSECONDS
        ));

        await expect(reference.createdWithoutOutputDevice).resolves.toBe(false);
        await reference.release();
        expect(FakeAudioContext.instances[0].close).not.toHaveBeenCalled();
    });

    it('requests output enumeration before constructing the context', async () => {
        const callOrder: string[] = [];
        class OrderRecordingAudioContext extends SinkSelectingAudioContext {
            public constructor(options?: AudioContextOptions) {
                super(options);
                callOrder.push('AudioContext');
            }
        }
        vi.stubGlobal('AudioContext', OrderRecordingAudioContext);
        const mediaDevices = stubMediaDevices();
        mediaDevices.enumerateDevices.mockImplementationOnce((): Promise<MediaDeviceInfo[]> => {
            callOrder.push('enumerateDevices');
            return Promise.resolve([]);
        });

        const reference = acquireSharedBrowserAudioContext(48_000);

        // A device that appears between the two calls costs only a spare sink rebuild
        expect(callOrder).toEqual([ 'enumerateDevices', 'AudioContext' ]);
        await expect(reference.createdWithoutOutputDevice).resolves.toBe(true);
        await reference.release();
    });
});
