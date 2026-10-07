import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    WebGPUAudioOutputManager,
    type WebGPUAudioOutputManagerOptions
} from 'webgpu-player/audio/output/WebGPUAudioOutputManager';

type Deferred = {
    promise: Promise<void>
    resolve: () => void
};

type SilentAudioSink = Readonly<{ type: 'none' }>;

type AudioSinkRequest = string | SilentAudioSink;

// Long enough that no recovery poll fires while a test runs on real timers
const IDLE_OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS = 3_600_000;
const OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS = 250;
const SILENT_AUDIO_SINK: SilentAudioSink = { type: 'none' };

/** Compares sinks the way browsers short-circuit a request for the current sink */
function isSameAudioSink(
    currentSink: AudioSinkRequest,
    requestedSink: AudioSinkRequest
): boolean {
    if (typeof currentSink === 'string' || typeof requestedSink === 'string') {
        return currentSink === requestedSink;
    }
    return currentSink.type === requestedSink.type;
}

class FakeMediaDevices extends EventTarget {
    public devices: MediaDeviceInfo[] = [];
    public readonly enumerateDevices = vi.fn(
        (): Promise<MediaDeviceInfo[]> => Promise.resolve(this.devices)
    );
    public selectAudioOutput?: (
        options?: Readonly<{ deviceId?: string }>
    ) => Promise<MediaDeviceInfo>;
}

class FakeAudioContext extends EventTarget {
    public readonly setSinkId = vi.fn(
        (sinkId: AudioSinkRequest): Promise<void> => this.changeSink(sinkId)
    );
    public readonly resume = vi.fn(async (): Promise<void> => {
        this.state = 'running';
    });
    public sinkId: AudioSinkRequest = '';
    public state: AudioContextState = 'suspended';
    // Chromium suspends a running context while it switches outputs
    public suspendDuringSinkChange = false;

    /** Applies a sink request like a browser, which resolves a same-sink request untouched */
    public async changeSink(sinkId: AudioSinkRequest): Promise<void> {
        if (isSameAudioSink(this.sinkId, sinkId)) {
            return;
        }
        this.sinkId = sinkId;
        if (this.suspendDuringSinkChange && this.state === 'running') {
            this.state = 'suspended';
        }
    }
}

class FakeMediaElement extends EventTarget {
    public readonly setSinkId = vi.fn(
        (sinkId: string): Promise<void> => this.changeSink(sinkId)
    );
    public sinkId = '';

    /** Applies a sink request like a browser, which resolves a same-ID request untouched */
    public async changeSink(sinkId: string): Promise<void> {
        if (sinkId === this.sinkId) {
            return;
        }
        this.sinkId = sinkId;
    }
}

function createDevice(
    deviceId: string,
    label = '',
    kind: MediaDeviceKind = 'audiooutput'
): MediaDeviceInfo {
    return {
        deviceId,
        groupId: '',
        kind,
        label,
        toJSON: (): object => ({ deviceId, kind, label })
    } as MediaDeviceInfo;
}

function createDeferred(): Deferred {
    let resolvePromise: (() => void) | null = null;
    const promise = new Promise<void>((resolve): void => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: (): void => {
            if (!resolvePromise) {
                throw new Error('Missing deferred resolver');
            }
            resolvePromise();
        }
    };
}

function createManager(
    mediaDevices: FakeMediaDevices,
    initialSelectedDeviceId: string | null = null,
    outputRecoveryPollIntervalMilliseconds: number = IDLE_OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS
): WebGPUAudioOutputManager {
    const options: WebGPUAudioOutputManagerOptions = {
        getMediaDevices: () => mediaDevices as unknown as MediaDevices,
        initialSelectedDeviceId,
        outputRecoveryPollIntervalMilliseconds
    };
    return new WebGPUAudioOutputManager(options);
}

describe('WebGPUAudioOutputManager', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('uses the canonical default sink and exposes only concrete audio outputs', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [
            createDevice('default', 'Default pseudo-device'),
            createDevice('speaker-a', 'Speakers'),
            createDevice('microphone-a', 'Microphone', 'audioinput'),
            createDevice('speaker-a', 'Duplicate')
        ];
        const manager = createManager(mediaDevices);
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);

        await lease.ready;

        expect(audioContext.setSinkId).toHaveBeenCalledWith('');
        expect(manager.getSnapshot()).toMatchObject({
            devices: [ { deviceId: 'speaker-a', label: 'Speakers' } ],
            selectedDeviceId: null,
            status: 'default'
        });
        mediaDevices.dispatchEvent(new Event('devicechange'));
        await manager.refresh();
        expect(audioContext.setSinkId).toHaveBeenCalledExactlyOnceWith('');
        await lease.release();
        await manager.destroy();
    });

    it('does not reroute active default targets for refresh, subscription, or same selection', async () => {
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(mediaDevices);
        const audioContext = new FakeAudioContext();
        const audioLease = manager.registerAudioContext(
            audioContext as unknown as AudioContext
        );
        const mediaElement = new FakeMediaElement();
        const mediaLease = manager.registerMediaElement(
            mediaElement as unknown as HTMLMediaElement
        );
        await Promise.all([ audioLease.ready, mediaLease.ready ]);
        expect(audioContext.setSinkId).toHaveBeenCalledTimes(1);
        expect(mediaElement.setSinkId).toHaveBeenCalledTimes(1);

        await audioLease.setIntendedRunning(true);
        audioContext.state = 'suspended';
        for (let subscriptionNumber: number = 0;
            subscriptionNumber < 3;
            subscriptionNumber += 1) {
            const unsubscribe = manager.subscribe((): void => undefined);
            await manager.refresh();
            unsubscribe();
        }
        await manager.setSelectedDeviceId(null);

        expect(audioContext.setSinkId).toHaveBeenCalledTimes(1);
        expect(mediaElement.setSinkId).toHaveBeenCalledTimes(1);
        expect(audioContext.resume).not.toHaveBeenCalled();
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            selectedDeviceId: null,
            status: 'default'
        });
        await mediaLease.release();
        await audioLease.release();
        await manager.destroy();
    });

    it('leaves healthy default targets untouched across a device change', async () => {
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(mediaDevices);
        const audioContext = new FakeAudioContext();
        audioContext.state = 'running';
        audioContext.suspendDuringSinkChange = true;
        const audioLease = manager.registerAudioContext(
            audioContext as unknown as AudioContext
        );
        const mediaElement = new FakeMediaElement();
        const mediaLease = manager.registerMediaElement(
            mediaElement as unknown as HTMLMediaElement
        );
        await Promise.all([ audioLease.ready, mediaLease.ready ]);
        await audioLease.setIntendedRunning(true);
        audioContext.setSinkId.mockClear();
        audioContext.resume.mockClear();
        mediaElement.setSinkId.mockClear();
        mediaDevices.enumerateDevices.mockClear();

        // Let the device-change pass route on its own instead of superseding it
        mediaDevices.dispatchEvent(new Event('devicechange'));
        await vi.waitFor(() => expect(mediaDevices.enumerateDevices).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(manager.getSnapshot().status).toBe('default'));

        expect(audioContext.setSinkId).not.toHaveBeenCalled();
        expect(mediaElement.setSinkId).not.toHaveBeenCalled();
        expect(audioContext.resume).not.toHaveBeenCalled();
        expect(audioContext.state).toBe('running');
        await mediaLease.release();
        await audioLease.release();
        await manager.destroy();
    });

    it('deduplicates a fulfilled output rebuild after refresh supersession', async () => {
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(mediaDevices);
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(
            audioContext as unknown as AudioContext,
            { createdWithoutOutputDevice: true }
        );
        await lease.ready;
        await lease.setIntendedRunning(true);
        audioContext.state = 'running';
        audioContext.suspendDuringSinkChange = true;
        audioContext.resume.mockClear();
        const rebuiltRoute = createDeferred();
        audioContext.setSinkId.mockImplementation(async (sinkId: AudioSinkRequest): Promise<void> => {
            if (sinkId === '') {
                await rebuiltRoute.promise;
            }
            await audioContext.changeSink(sinkId);
        });

        // Without microphone permission Chromium lists one blank entry while any output exists
        mediaDevices.devices = [ createDevice('') ];
        mediaDevices.dispatchEvent(new Event('devicechange'));
        await vi.waitFor(() => expect(audioContext.setSinkId).toHaveBeenCalledTimes(3));
        const supersedingRefresh = manager.refresh();
        rebuiltRoute.resolve();
        await supersedingRefresh;

        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            '',
            SILENT_AUDIO_SINK,
            ''
        ]);
        expect(audioContext.resume).toHaveBeenCalledOnce();
        expect(audioContext.state).toBe('running');
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            selectedDeviceId: null,
            status: 'default'
        });
        await lease.release();
        await manager.destroy();
    });

    it('does not retry a rejected rebuild candidate in its superseding refresh', async () => {
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(mediaDevices);
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(
            audioContext as unknown as AudioContext,
            { createdWithoutOutputDevice: true }
        );
        await lease.ready;
        let rejectRebuiltRoute = (error: unknown): void => {
            throw new Error(`Missing rebuilt route rejecter for ${String(error)}`);
        };
        const rebuiltRoute = new Promise<void>((_resolve, reject): void => {
            rejectRebuiltRoute = reject;
        });
        audioContext.setSinkId.mockImplementation((sinkId: AudioSinkRequest): Promise<void> => (
            sinkId === '' ? rebuiltRoute : audioContext.changeSink(sinkId)
        ));

        mediaDevices.devices = [ createDevice('speaker-b') ];
        mediaDevices.dispatchEvent(new Event('devicechange'));
        await vi.waitFor(() => expect(audioContext.setSinkId).toHaveBeenCalledTimes(3));
        const supersedingRefresh = manager.refresh();
        rejectRebuiltRoute(new DOMException('Default changed', 'AbortError'));
        await supersedingRefresh;

        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            '',
            SILENT_AUDIO_SINK,
            '',
            SILENT_AUDIO_SINK,
            'speaker-b'
        ]);
        expect(audioContext.sinkId).toBe('speaker-b');
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: 'speaker-b',
            selectedDeviceId: null,
            status: 'fallback'
        });
        await lease.release();
        await manager.destroy();
    });

    it('rebuilds a context created without an output once polling lists one', async () => {
        vi.useFakeTimers();
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(
            mediaDevices,
            null,
            OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS
        );
        const audioContext = new FakeAudioContext();
        audioContext.state = 'running';
        audioContext.suspendDuringSinkChange = true;
        const lease = manager.registerAudioContext(
            audioContext as unknown as AudioContext,
            { createdWithoutOutputDevice: true }
        );
        await lease.ready;
        await lease.setIntendedRunning(true);
        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([ '' ]);

        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS);
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2);
        expect(audioContext.setSinkId).toHaveBeenCalledOnce();

        // Without microphone permission Chromium lists one blank entry while any output exists
        mediaDevices.devices = [ createDevice('') ];
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS);

        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            '',
            SILENT_AUDIO_SINK,
            ''
        ]);
        expect(audioContext.resume).toHaveBeenCalledOnce();
        expect(audioContext.state).toBe('running');
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            devices: [],
            status: 'default'
        });
        const enumerationCount = mediaDevices.enumerateDevices.mock.calls.length;
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS * 3);
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(enumerationCount);
        expect(audioContext.setSinkId).toHaveBeenCalledTimes(3);
        await lease.release();
        await manager.destroy();
    });

    it('rebuilds at registration when an output is already listed', async () => {
        vi.useFakeTimers();
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a', 'Speakers') ];
        const manager = createManager(
            mediaDevices,
            null,
            OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS
        );
        await manager.refresh();
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(
            audioContext as unknown as AudioContext,
            { createdWithoutOutputDevice: true }
        );
        await lease.ready;

        // A pending rebuild refreshes output presence even with a known device list
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2);
        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            SILENT_AUDIO_SINK,
            ''
        ]);
        expect(audioContext.sinkId).toBe('');
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            status: 'default'
        });
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS * 3);
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2);
        expect(audioContext.setSinkId).toHaveBeenCalledTimes(2);
        await lease.release();
        await manager.destroy();
    });

    it.each([
        { requestedSinkId: '', selectedDeviceId: null, status: 'default' },
        { requestedSinkId: 'speaker-a', selectedDeviceId: 'speaker-a', status: 'selected' }
    ])('rebuilds every audio context sink for $status routing on redetection', async ({
        requestedSinkId,
        selectedDeviceId,
        status
    }) => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a', 'Speakers') ];
        const manager = createManager(mediaDevices, selectedDeviceId);
        const firstContext = new FakeAudioContext();
        const secondContext = new FakeAudioContext();
        const mediaElement = new FakeMediaElement();
        const firstLease = manager.registerAudioContext(firstContext as unknown as AudioContext);
        const secondLease = manager.registerAudioContext(
            secondContext as unknown as AudioContext
        );
        const mediaLease = manager.registerMediaElement(
            mediaElement as unknown as HTMLMediaElement
        );
        await Promise.all([ firstLease.ready, secondLease.ready, mediaLease.ready ]);
        const enumerationCount = mediaDevices.enumerateDevices.mock.calls.length;

        await manager.redetectAudioOutputs();

        // Detaching first turns the unchanged route into a real change that reopens the device
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(enumerationCount + 1);
        for (const audioContext of [ firstContext, secondContext ]) {
            expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
                requestedSinkId,
                SILENT_AUDIO_SINK,
                requestedSinkId
            ]);
            expect(audioContext.sinkId).toBe(requestedSinkId);
        }
        expect(mediaElement.setSinkId).toHaveBeenCalledExactlyOnceWith(requestedSinkId);
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: selectedDeviceId,
            selectedDeviceId,
            status
        });
        await mediaLease.release();
        await secondLease.release();
        await firstLease.release();
        await manager.destroy();
    });

    it('defers a redetected rebuild until an output is listed', async () => {
        vi.useFakeTimers();
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('') ];
        const manager = createManager(
            mediaDevices,
            null,
            OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS
        );
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;
        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([ '' ]);

        // The output disappears before the redetection, so nothing is rebuilt yet
        mediaDevices.devices = [];
        await manager.redetectAudioOutputs();
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2);
        expect(audioContext.setSinkId).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS);
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(3);
        expect(audioContext.setSinkId).toHaveBeenCalledOnce();

        mediaDevices.devices = [ createDevice('') ];
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS);
        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            '',
            SILENT_AUDIO_SINK,
            ''
        ]);
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            status: 'default'
        });
        const enumerationCount = mediaDevices.enumerateDevices.mock.calls.length;
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS * 3);
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(enumerationCount);
        expect(audioContext.setSinkId).toHaveBeenCalledTimes(3);
        await lease.release();
        await manager.destroy();
    });

    it('flags no rebuild on redetection for targets without context sink selection', async () => {
        vi.useFakeTimers();
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(
            mediaDevices,
            null,
            OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS
        );
        const contextWithoutSinkSelection = new EventTarget();
        const mediaElement = new FakeMediaElement();
        const contextLease = manager.registerAudioContext(
            contextWithoutSinkSelection as unknown as AudioContext
        );
        const mediaLease = manager.registerMediaElement(
            mediaElement as unknown as HTMLMediaElement
        );
        await Promise.all([ contextLease.ready, mediaLease.ready ]);
        const enumerationCount = mediaDevices.enumerateDevices.mock.calls.length;

        // With no output listed, a flagged target would arm the recovery poll
        await manager.redetectAudioOutputs();
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS * 3);

        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(enumerationCount + 1);
        expect(vi.getTimerCount()).toBe(0);
        expect(mediaElement.setSinkId).toHaveBeenCalledExactlyOnceWith('');
        await mediaLease.release();
        await contextLease.release();
        await manager.destroy();
        expect(() => manager.redetectAudioOutputs()).toThrow(
            'WebGPU audio output manager is destroyed'
        );
    });

    it('does not poll for a context without sink selection', async () => {
        vi.useFakeTimers();
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(
            mediaDevices,
            null,
            OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS
        );
        const contextWithoutSinkSelection = new EventTarget();
        const lease = manager.registerAudioContext(
            contextWithoutSinkSelection as unknown as AudioContext,
            { createdWithoutOutputDevice: true }
        );
        await lease.ready;

        mediaDevices.devices = [ createDevice('') ];
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS * 3);

        expect(mediaDevices.enumerateDevices).toHaveBeenCalledOnce();
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            status: 'default'
        });
        await lease.release();
        await manager.destroy();
    });

    it('retries a failed output rebuild on the next poll', async () => {
        vi.useFakeTimers();
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(
            mediaDevices,
            null,
            OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS
        );
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(
            audioContext as unknown as AudioContext,
            { createdWithoutOutputDevice: true }
        );
        await lease.ready;
        // The first rebuild detaches, then its route to the new output fails
        audioContext.setSinkId
            .mockImplementationOnce((sinkId: AudioSinkRequest): Promise<void> => (
                audioContext.changeSink(sinkId)
            ))
            .mockImplementationOnce((): Promise<void> => Promise.reject(
                new DOMException('Output is not ready', 'NotFoundError')
            ));

        mediaDevices.devices = [ createDevice('') ];
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS);
        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            '',
            SILENT_AUDIO_SINK,
            ''
        ]);
        expect(manager.getSnapshot()).toMatchObject({
            messageCode: 'route-failed',
            status: 'error'
        });

        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS);
        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            '',
            SILENT_AUDIO_SINK,
            '',
            SILENT_AUDIO_SINK,
            ''
        ]);
        expect(audioContext.sinkId).toBe('');
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            status: 'default'
        });
        const enumerationCount = mediaDevices.enumerateDevices.mock.calls.length;
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS * 3);
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(enumerationCount);
        await lease.release();
        await manager.destroy();
    });

    it('recovers an errored context when polling lists an output again', async () => {
        vi.useFakeTimers();
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('') ];
        const manager = createManager(
            mediaDevices,
            null,
            OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS
        );
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;
        await lease.setIntendedRunning(true);
        audioContext.state = 'running';
        audioContext.setSinkId.mockClear();
        mediaDevices.enumerateDevices.mockClear();

        // Chromium suspends a running context before it reports a lost output
        mediaDevices.devices = [];
        audioContext.state = 'suspended';
        audioContext.dispatchEvent(new Event('error'));
        // Settles the error pass without reaching the first poll
        await vi.advanceTimersByTimeAsync(0);
        expect(mediaDevices.enumerateDevices).not.toHaveBeenCalled();
        expect(manager.getSnapshot()).toMatchObject({
            messageCode: 'route-failed',
            status: 'error'
        });

        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS);
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledOnce();
        expect(audioContext.setSinkId).not.toHaveBeenCalled();
        expect(audioContext.resume).not.toHaveBeenCalled();
        expect(manager.getSnapshot().status).toBe('error');

        mediaDevices.devices = [ createDevice('') ];
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS);

        // The same-ID route changes nothing, so the resume is what restarts output
        expect(audioContext.setSinkId).toHaveBeenCalledExactlyOnceWith('');
        expect(audioContext.resume).toHaveBeenCalledOnce();
        expect(audioContext.state).toBe('running');
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            status: 'default'
        });
        const enumerationCount = mediaDevices.enumerateDevices.mock.calls.length;
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS * 3);
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(enumerationCount);
        await lease.release();
        await manager.destroy();
    });

    it('stops output recovery polling when the waiting target is released', async () => {
        vi.useFakeTimers();
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(
            mediaDevices,
            null,
            OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS
        );
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(
            audioContext as unknown as AudioContext,
            { createdWithoutOutputDevice: true }
        );
        await lease.ready;
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS);
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2);

        await lease.release();
        expect(vi.getTimerCount()).toBe(0);
        mediaDevices.devices = [ createDevice('') ];
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS * 3);

        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2);
        expect(audioContext.setSinkId).toHaveBeenCalledOnce();
        await manager.destroy();
    });

    it('cancels a pending output recovery poll on destroy', async () => {
        vi.useFakeTimers();
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(
            mediaDevices,
            null,
            OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS
        );
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(
            audioContext as unknown as AudioContext,
            { createdWithoutOutputDevice: true }
        );
        await lease.ready;
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS);
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);

        await manager.destroy();
        expect(vi.getTimerCount()).toBe(0);
        mediaDevices.devices = [ createDevice('') ];
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS * 3);

        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2);
        expect(audioContext.setSinkId).toHaveBeenCalledOnce();
        await lease.release();
    });

    it('completes a rebuild route when the browser cannot detach a sink', async () => {
        vi.useFakeTimers();
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(
            mediaDevices,
            null,
            OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS
        );
        const audioContext = new FakeAudioContext();
        audioContext.setSinkId.mockImplementation((sinkId: AudioSinkRequest): Promise<void> => (
            typeof sinkId === 'string' ?
                audioContext.changeSink(sinkId) :
                Promise.reject(new TypeError('Silent audio sinks are unsupported'))
        ));
        const lease = manager.registerAudioContext(
            audioContext as unknown as AudioContext,
            { createdWithoutOutputDevice: true }
        );
        await lease.ready;

        mediaDevices.devices = [ createDevice('') ];
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS);

        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            '',
            SILENT_AUDIO_SINK,
            ''
        ]);
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            status: 'default'
        });
        const enumerationCount = mediaDevices.enumerateDevices.mock.calls.length;
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS * 3);
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(enumerationCount);

        // The abandoned rebuild is not retried by a later device change
        mediaDevices.dispatchEvent(new Event('devicechange'));
        await manager.refresh();
        expect(audioContext.setSinkId).toHaveBeenCalledTimes(3);
        await lease.release();
        await manager.destroy();
    });

    it('pauses output recovery polling while the page is hidden and probes on return', async () => {
        vi.useFakeTimers();
        const visibilityState = vi.spyOn(document, 'visibilityState', 'get');
        const removeEventListener = vi.spyOn(document, 'removeEventListener');
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(
            mediaDevices,
            null,
            OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS
        );
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(
            audioContext as unknown as AudioContext,
            { createdWithoutOutputDevice: true }
        );
        await lease.ready;
        // Settles the registration pass, which arms the first poll
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(1);

        visibilityState.mockReturnValue('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        expect(vi.getTimerCount()).toBe(0);
        mediaDevices.devices = [ createDevice('') ];
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS * 3);
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledOnce();
        expect(audioContext.setSinkId).toHaveBeenCalledOnce();

        // Returning to the page probes at once rather than after a full interval
        visibilityState.mockReturnValue('visible');
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            '',
            SILENT_AUDIO_SINK,
            ''
        ]);
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            status: 'default'
        });
        expect(vi.getTimerCount()).toBe(0);
        expect(removeEventListener).toHaveBeenCalledWith(
            'visibilitychange',
            expect.any(Function)
        );
        await lease.release();
        await manager.destroy();
    });

    it('retries a failing recovery on every visible poll without a limit', async () => {
        vi.useFakeTimers();
        const visibilityState = vi.spyOn(document, 'visibilityState', 'get');
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(
            mediaDevices,
            null,
            OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS
        );
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(
            audioContext as unknown as AudioContext,
            { createdWithoutOutputDevice: true }
        );
        await lease.ready;
        // Every route away from the silent sink fails, so each rebuild stays pending
        audioContext.setSinkId.mockImplementation((sinkId: AudioSinkRequest): Promise<void> => (
            typeof sinkId === 'string' && audioContext.sinkId !== '' ?
                Promise.reject(new DOMException('Output is unavailable', 'NotFoundError')) :
                audioContext.changeSink(sinkId)
        ));
        mediaDevices.devices = [ createDevice('') ];

        const pollCount = 6;
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS * pollCount);
        const routeAttempts = audioContext.setSinkId.mock.calls
            .filter(call => call[0] === '')
            .length;
        // One registration route plus one failed rebuild route per poll
        expect(routeAttempts).toBe(pollCount + 1);
        expect(manager.getSnapshot().status).toBe('error');

        visibilityState.mockReturnValue('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        const callCount = audioContext.setSinkId.mock.calls.length;
        const enumerationCount = mediaDevices.enumerateDevices.mock.calls.length;
        await vi.advanceTimersByTimeAsync(OUTPUT_RECOVERY_POLL_INTERVAL_MILLISECONDS * pollCount);
        expect(audioContext.setSinkId).toHaveBeenCalledTimes(callCount);
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(enumerationCount);
        await lease.release();
        await manager.destroy();
    });

    it.each([
        0,
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY
    ])('rejects a %s millisecond output recovery poll interval', (
        outputRecoveryPollIntervalMilliseconds: number
    ) => {
        expect(() => new WebGPUAudioOutputManager({
            outputRecoveryPollIntervalMilliseconds
        })).toThrow(RangeError);
    });

    it('retries a failed current default on same selection and later refresh', async () => {
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(mediaDevices);
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;
        await lease.setIntendedRunning(true);
        audioContext.state = 'running';
        audioContext.setSinkId.mockClear();
        audioContext.resume.mockClear();

        // Chromium suspends a running context before it reports an output error
        audioContext.state = 'suspended';
        audioContext.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(manager.getSnapshot().status).toBe('error'));
        expect(audioContext.setSinkId).not.toHaveBeenCalled();
        await manager.setSelectedDeviceId(null);
        // The same-ID route changes nothing, so the resume is what restarts output
        expect(audioContext.setSinkId).toHaveBeenCalledExactlyOnceWith('');
        expect(audioContext.resume).toHaveBeenCalledOnce();
        expect(audioContext.state).toBe('running');
        expect(manager.getSnapshot().status).toBe('default');

        audioContext.setSinkId.mockClear();
        audioContext.resume.mockClear();
        audioContext.state = 'suspended';
        audioContext.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(manager.getSnapshot().status).toBe('error'));
        await manager.refresh();
        expect(audioContext.setSinkId).toHaveBeenCalledExactlyOnceWith('');
        expect(audioContext.resume).toHaveBeenCalledOnce();
        expect(audioContext.state).toBe('running');
        expect(manager.getSnapshot().status).toBe('default');

        await lease.release();
        await manager.destroy();
    });

    it('uses one permitted fallback when the canonical default route fails', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-b', 'Fallback') ];
        const manager = createManager(mediaDevices, 'missing-speaker');
        const audioContext = new FakeAudioContext();
        // Starting on another output makes the default request a real change that can fail
        audioContext.sinkId = 'missing-speaker';
        audioContext.setSinkId.mockImplementation((sinkId: AudioSinkRequest): Promise<void> => (
            sinkId === '' ?
                Promise.reject(new DOMException('Default failed', 'AbortError')) :
                audioContext.changeSink(sinkId)
        ));
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);

        await lease.ready;

        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            '',
            'speaker-b'
        ]);
        expect(audioContext.sinkId).toBe('speaker-b');
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: 'speaker-b',
            selectedDeviceId: 'missing-speaker',
            status: 'fallback'
        });
        await lease.release();
        await manager.destroy();
    });

    it('reports fallback when an available selected sink rejects routing', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a') ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const audioContext = new FakeAudioContext();
        audioContext.setSinkId.mockImplementation((sinkId: AudioSinkRequest): Promise<void> => (
            sinkId === 'speaker-a' ?
                Promise.reject(new DOMException('Blocked', 'NotAllowedError')) :
                audioContext.changeSink(sinkId)
        ));
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);

        await lease.ready;

        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            'speaker-a',
            ''
        ]);
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            selectedDeviceId: 'speaker-a',
            status: 'fallback'
        });
        await lease.release();
        await manager.destroy();
    });

    it('falls back on disconnect while retaining and restoring the selected ID', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a', 'Speakers') ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;
        expect(audioContext.setSinkId).toHaveBeenLastCalledWith('speaker-a');

        mediaDevices.devices = [ createDevice('speaker-b', 'Fallback') ];
        await manager.refresh();
        expect(audioContext.setSinkId).toHaveBeenLastCalledWith('');
        expect(manager.getSnapshot()).toMatchObject({
            selectedDeviceId: 'speaker-a',
            status: 'fallback'
        });

        mediaDevices.devices = [
            createDevice('speaker-a', 'Speakers'),
            createDevice('speaker-b', 'Fallback')
        ];
        await manager.refresh();
        expect(audioContext.setSinkId).toHaveBeenLastCalledWith('speaker-a');
        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            'speaker-a',
            '',
            'speaker-a'
        ]);
        expect(manager.getSnapshot().status).toBe('selected');

        await lease.release();
        await manager.destroy();
    });

    it('serializes sink changes so a stale completion cannot win', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [
            createDevice('speaker-a'),
            createDevice('speaker-b')
        ];
        const firstSetSink = createDeferred();
        const sinkCalls: AudioSinkRequest[] = [];
        const audioContext = new FakeAudioContext();
        audioContext.setSinkId.mockImplementation(async (sinkId: AudioSinkRequest): Promise<void> => {
            sinkCalls.push(sinkId);
            if (sinkCalls.length === 1) {
                await firstSetSink.promise;
            }
            await audioContext.changeSink(sinkId);
        });
        const manager = createManager(mediaDevices, 'speaker-a');
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await vi.waitFor(() => expect(sinkCalls).toEqual([ 'speaker-a' ]));

        const newestSelection = manager.setSelectedDeviceId('speaker-b');
        firstSetSink.resolve();
        await lease.ready;
        await newestSelection;

        expect(sinkCalls).toEqual([ 'speaker-a', 'speaker-b' ]);
        expect(audioContext.sinkId).toBe('speaker-b');
        await lease.release();
        await manager.destroy();
    });

    it('ignores stale enumeration results and publishes the newest device list', async () => {
        const mediaDevices = new FakeMediaDevices();
        let resolveFirstEnumeration: (devices: MediaDeviceInfo[]) => void = (
            devices: MediaDeviceInfo[]
        ): void => {
            throw new Error(`Missing first enumeration resolver for ${devices.length} devices`);
        };
        const firstEnumeration = new Promise<MediaDeviceInfo[]>((resolve): void => {
            resolveFirstEnumeration = resolve;
        });
        mediaDevices.enumerateDevices
            .mockImplementationOnce((): Promise<MediaDeviceInfo[]> => firstEnumeration)
            .mockImplementation((): Promise<MediaDeviceInfo[]> => Promise.resolve([
                createDevice('new-speaker')
            ]));
        const manager = createManager(mediaDevices);
        const staleRefresh = manager.refresh();
        await vi.waitFor(() => expect(mediaDevices.enumerateDevices).toHaveBeenCalledOnce());
        const newestRefresh = manager.refresh();
        resolveFirstEnumeration([ createDevice('stale-speaker') ]);

        await Promise.all([ staleRefresh, newestRefresh ]);

        expect(manager.getSnapshot().devices).toEqual([
            { deviceId: 'new-speaker', label: '' }
        ]);
        await manager.destroy();
    });

    it('carries pending enumeration into a target registration that supersedes selection', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('old-speaker') ];
        const manager = createManager(mediaDevices, 'old-speaker');
        await manager.refresh();
        expect(manager.getSnapshot().devices).toEqual([
            { deviceId: 'old-speaker', label: '' }
        ]);

        let resolveEnumeration: (devices: MediaDeviceInfo[]) => void = (
            devices: MediaDeviceInfo[]
        ): void => {
            throw new Error(`Missing enumeration resolver for ${devices.length} devices`);
        };
        const pendingEnumeration = new Promise<MediaDeviceInfo[]>((resolve): void => {
            resolveEnumeration = resolve;
        });
        mediaDevices.enumerateDevices.mockImplementation(
            (): Promise<MediaDeviceInfo[]> => pendingEnumeration
        );
        const selection = manager.setSelectedDeviceId('rotated-speaker');
        await vi.waitFor(() => expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2));

        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        let readyResolved = false;
        void lease.ready.then((): void => {
            readyResolved = true;
        });
        expect(readyResolved).toBe(false);

        resolveEnumeration([ createDevice('rotated-speaker') ]);
        await Promise.all([ selection, lease.ready ]);

        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(3);
        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            'rotated-speaker'
        ]);
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: 'rotated-speaker',
            devices: [ { deviceId: 'rotated-speaker', label: '' } ],
            selectedDeviceId: 'rotated-speaker',
            status: 'selected'
        });
        expect(readyResolved).toBe(true);
        await lease.release();
        await manager.destroy();
    });

    it('drains an in-flight route before releasing its final target lease', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a') ];
        const pendingRoute = createDeferred();
        const audioContext = new FakeAudioContext();
        audioContext.setSinkId.mockImplementation(async (sinkId: AudioSinkRequest): Promise<void> => {
            await pendingRoute.promise;
            await audioContext.changeSink(sinkId);
        });
        const manager = createManager(mediaDevices, 'speaker-a');
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await vi.waitFor(() => expect(audioContext.setSinkId).toHaveBeenCalledOnce());
        let released = false;
        const firstReleasePromise = lease.release();
        const secondReleasePromise = lease.release();
        expect(secondReleasePromise).toBe(firstReleasePromise);
        const releasePromise = firstReleasePromise.then((): void => {
            released = true;
        });
        await Promise.resolve();
        expect(released).toBe(false);

        pendingRoute.resolve();
        await releasePromise;
        expect(released).toBe(true);
        await manager.destroy();
    });

    it('keeps target readiness pending until the latest superseding route is applied', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a'), createDevice('speaker-b') ];
        const firstRoute = createDeferred();
        const latestRoute = createDeferred();
        const audioContext = new FakeAudioContext();
        audioContext.setSinkId.mockImplementation(async (sinkId: AudioSinkRequest): Promise<void> => {
            switch (sinkId) {
                case 'speaker-a':
                    await firstRoute.promise;
                    break;
                case 'speaker-b':
                    await latestRoute.promise;
                    break;
                default:
                    break;
            }
            await audioContext.changeSink(sinkId);
        });
        const manager = createManager(mediaDevices, 'speaker-a');
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await vi.waitFor(() => expect(audioContext.setSinkId).toHaveBeenCalledWith('speaker-a'));
        let readyResolved = false;
        void lease.ready.then((): void => {
            readyResolved = true;
        });

        const transientElement = new FakeMediaElement();
        const transientLease = manager.registerMediaElement(
            transientElement as unknown as HTMLMediaElement
        );
        const transientRelease = transientLease.release();
        const latestSelection = manager.setSelectedDeviceId('speaker-b');
        firstRoute.resolve();
        await vi.waitFor(() => expect(audioContext.setSinkId).toHaveBeenCalledWith('speaker-b'));
        expect(readyResolved).toBe(false);

        latestRoute.resolve();
        await Promise.all([ lease.ready, latestSelection, transientRelease ]);
        expect(readyResolved).toBe(true);
        expect(audioContext.setSinkId).toHaveBeenLastCalledWith('speaker-b');
        await lease.release();
        await manager.destroy();
    });

    it('isolates throwing subscribers so routing and target readiness still complete', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a') ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const throwingSubscriber = vi.fn((): void => {
            throw new Error('Subscriber failed');
        });
        const healthySubscriber = vi.fn();

        expect(() => manager.subscribe(throwingSubscriber)).not.toThrow();
        manager.subscribe(healthySubscriber);
        const mediaElement = new FakeMediaElement();
        const lease = manager.registerMediaElement(mediaElement as unknown as HTMLMediaElement);

        await expect(lease.ready).resolves.toBeUndefined();
        expect(mediaElement.setSinkId).toHaveBeenCalledWith('speaker-a');
        expect(throwingSubscriber).toHaveBeenCalled();
        expect(healthySubscriber).toHaveBeenCalled();
        await lease.release();
        await manager.destroy();
    });

    it('resumes only a context whose active lease intends to be running', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [
            createDevice('speaker-a'),
            createDevice('speaker-b')
        ];
        const audioContext = new FakeAudioContext();
        audioContext.state = 'running';
        audioContext.suspendDuringSinkChange = true;
        const manager = createManager(mediaDevices, 'speaker-a');
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;
        expect(audioContext.state).toBe('suspended');
        expect(audioContext.resume).not.toHaveBeenCalled();
        await lease.setIntendedRunning(true);
        audioContext.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(audioContext.resume).toHaveBeenCalledTimes(1));
        expect(audioContext.resume).toHaveBeenCalledTimes(1);

        await lease.setIntendedRunning(false);
        audioContext.state = 'suspended';
        await manager.setSelectedDeviceId('speaker-b');
        expect(audioContext.resume).toHaveBeenCalledTimes(1);

        await lease.release();
        await manager.destroy();
    });

    it('reports unsupported specific routing without failing playback setup', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a') ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const mediaElementWithoutSink = new EventTarget() as unknown as HTMLMediaElement;
        const lease = manager.registerMediaElement(mediaElementWithoutSink);

        await expect(lease.ready).resolves.toBeUndefined();
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            selectedDeviceId: 'speaker-a',
            status: 'error'
        });
        await lease.release();
        await manager.destroy();
    });

    it('applies live routing to an owned media element', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a') ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const mediaElement = new FakeMediaElement();
        const lease = manager.registerMediaElement(mediaElement as unknown as HTMLMediaElement);

        await lease.ready;
        await manager.setSelectedDeviceId(null);

        expect(mediaElement.setSinkId.mock.calls.map(call => call[0])).toEqual([ 'speaker-a', '' ]);
        expect(mediaElement.sinkId).toBe('');
        await lease.release();
        await manager.destroy();
    });

    it('preserves a working selected route and device list when enumeration fails', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [
            createDevice('speaker-a', 'Speakers'),
            createDevice('speaker-b', 'Headphones')
        ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;
        expect(audioContext.setSinkId).toHaveBeenCalledTimes(1);

        mediaDevices.enumerateDevices.mockRejectedValue(
            new DOMException('Permission changed', 'NotAllowedError')
        );
        await manager.refresh();

        expect(audioContext.setSinkId).toHaveBeenCalledTimes(1);
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: 'speaker-a',
            devices: [
                { deviceId: 'speaker-a', label: 'Speakers' },
                { deviceId: 'speaker-b', label: 'Headphones' }
            ],
            selectedDeviceId: 'speaker-a',
            status: 'selected'
        });

        const mediaElement = new FakeMediaElement();
        mediaElement.setSinkId.mockImplementation((sinkId: string): Promise<void> => (
            sinkId === 'speaker-a' ?
                Promise.reject(new DOMException('Device route failed', 'AbortError')) :
                mediaElement.changeSink(sinkId)
        ));
        const mediaLease = manager.registerMediaElement(
            mediaElement as unknown as HTMLMediaElement
        );
        await mediaLease.ready;
        expect(mediaElement.setSinkId.mock.calls.map(call => call[0])).toEqual([
            'speaker-a',
            ''
        ]);
        expect(manager.getSnapshot().selectedDeviceId).toBe('speaker-a');

        await mediaLease.release();
        await lease.release();
        await manager.destroy();
    });

    it('reports a selected route as active when its first device enumeration fails', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.enumerateDevices.mockRejectedValue(
            new DOMException('Enumeration denied', 'NotAllowedError')
        );
        const manager = createManager(mediaDevices, 'speaker-a');
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);

        await lease.ready;

        expect(audioContext.setSinkId).toHaveBeenCalledWith('speaker-a');
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: 'speaker-a',
            devices: [],
            messageCode: 'selected-enumeration-failed',
            selectedDeviceAvailability: 'active',
            selectedDeviceId: 'speaker-a',
            status: 'selected'
        });
        await lease.release();
        await manager.destroy();
    });

    it('advances only the errored context through selected, default, and permitted fallback', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [
            createDevice('speaker-a'),
            createDevice('speaker-b')
        ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const firstContext = new FakeAudioContext();
        const secondContext = new FakeAudioContext();
        const firstLease = manager.registerAudioContext(firstContext as unknown as AudioContext);
        const secondLease = manager.registerAudioContext(secondContext as unknown as AudioContext);
        await Promise.all([ firstLease.ready, secondLease.ready ]);
        firstContext.setSinkId.mockClear();
        secondContext.setSinkId.mockClear();

        firstContext.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(firstContext.setSinkId).toHaveBeenCalledWith(''));
        expect(firstContext.setSinkId).not.toHaveBeenCalledWith('speaker-a');
        expect(secondContext.setSinkId).not.toHaveBeenCalled();
        expect(manager.getSnapshot()).toMatchObject({
            selectedDeviceId: 'speaker-a',
            status: 'fallback'
        });

        firstContext.setSinkId.mockClear();
        firstContext.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(firstContext.setSinkId).toHaveBeenCalledWith('speaker-b'));
        expect(firstContext.setSinkId).not.toHaveBeenCalledWith('speaker-a');
        expect(firstContext.setSinkId).not.toHaveBeenCalledWith('');

        firstContext.setSinkId.mockClear();
        firstContext.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(manager.getSnapshot().status).toBe('error'));
        expect(firstContext.setSinkId).not.toHaveBeenCalled();
        expect(secondContext.setSinkId).not.toHaveBeenCalled();
        expect(manager.getSnapshot().status).toBe('error');

        mediaDevices.dispatchEvent(new Event('devicechange'));
        await vi.waitFor(() => expect(firstContext.setSinkId).toHaveBeenCalledWith('speaker-a'));

        await firstLease.release();
        await secondLease.release();
        await manager.destroy();
    });

    it('keeps a demoted safe fallback when device-change enumeration fails', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a'), createDevice('speaker-b') ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;

        audioContext.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(audioContext.setSinkId).toHaveBeenLastCalledWith(''));
        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            'speaker-a',
            ''
        ]);
        mediaDevices.enumerateDevices.mockRejectedValue(
            new DOMException('Enumeration failed', 'NotAllowedError')
        );

        mediaDevices.dispatchEvent(new Event('devicechange'));
        await manager.refresh();

        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            'speaker-a',
            ''
        ]);
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            messageCode: 'selected-fallback',
            selectedDeviceAvailability: 'unknown',
            selectedDeviceId: 'speaker-a',
            status: 'fallback'
        });
        await lease.release();
        await manager.destroy();
    });

    it('deduplicates same-ID selection but still recovers an errored intended context', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [
            createDevice('speaker-a'),
            createDevice('speaker-b')
        ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;
        await lease.setIntendedRunning(true);
        audioContext.state = 'suspended';
        audioContext.resume.mockImplementation((): Promise<void> => {
            if (audioContext.sinkId === 'speaker-a') {
                return Promise.reject(new DOMException('Selected output stopped', 'AbortError'));
            }
            audioContext.state = 'running';
            return Promise.resolve();
        });

        await manager.setSelectedDeviceId('speaker-a');

        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            'speaker-a'
        ]);
        expect(audioContext.resume).not.toHaveBeenCalled();
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: 'speaker-a',
            selectedDeviceId: 'speaker-a',
            status: 'selected'
        });

        audioContext.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(audioContext.setSinkId).toHaveBeenLastCalledWith(''));
        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            'speaker-a',
            ''
        ]);
        expect(audioContext.resume).toHaveBeenCalledOnce();
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            selectedDeviceId: 'speaker-a',
            status: 'fallback'
        });
        await lease.release();
        await manager.destroy();
    });

    it('does not resume an idle context while recovering from an output error', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a') ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;
        audioContext.state = 'suspended';

        audioContext.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(audioContext.setSinkId).toHaveBeenLastCalledWith(''));
        expect(audioContext.resume).not.toHaveBeenCalled();

        await lease.release();
        await manager.destroy();
    });

    it('clears the active route and reports a saved next route after the last release', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a') ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;
        expect(manager.getSnapshot().activeDeviceId).toBe('speaker-a');

        await lease.release();

        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            messageCode: 'selected-saved',
            selectedDeviceId: 'speaker-a',
            status: 'inactive'
        });
        await manager.destroy();
    });

    it('uses a rotated picker ID and keeps picker failures non-terminal', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('rotated-output', 'Headphones') ];
        const selectAudioOutput = vi.fn(async (): Promise<MediaDeviceInfo> => (
            createDevice('rotated-output', 'Headphones')
        ));
        mediaDevices.selectAudioOutput = selectAudioOutput;
        const manager = createManager(mediaDevices, 'old-output');

        expect(await manager.requestAudioOutputSelection()).toBe('rotated-output');
        expect(selectAudioOutput).toHaveBeenCalledWith({ deviceId: 'old-output' });
        expect(manager.getSnapshot().selectedDeviceId).toBe('old-output');
        await manager.setSelectedDeviceId('rotated-output');
        expect(manager.getSnapshot()).toMatchObject({
            selectedDeviceId: 'rotated-output',
            status: 'inactive'
        });

        mediaDevices.selectAudioOutput = vi.fn(() => Promise.reject(
            new DOMException('Blocked', 'NotAllowedError')
        ));
        expect(await manager.requestAudioOutputSelection()).toBeNull();
        expect(manager.getSnapshot()).toMatchObject({
            selectedDeviceId: 'rotated-output',
            status: 'error'
        });
        await manager.destroy();
    });

    it('does not publish an older picker rejection after a newer picker succeeds', async () => {
        const mediaDevices = new FakeMediaDevices();
        let rejectFirstPicker: (error: unknown) => void = (error: unknown): void => {
            throw new Error(`Missing first picker rejecter for ${String(error)}`);
        };
        let resolveSecondPicker: (device: MediaDeviceInfo) => void = (
            device: MediaDeviceInfo
        ): void => {
            throw new Error(`Missing second picker resolver for ${device.deviceId}`);
        };
        const firstPicker = new Promise<MediaDeviceInfo>((_resolve, reject): void => {
            rejectFirstPicker = reject;
        });
        const secondPicker = new Promise<MediaDeviceInfo>((resolve): void => {
            resolveSecondPicker = resolve;
        });
        mediaDevices.selectAudioOutput = vi.fn()
            .mockImplementationOnce((): Promise<MediaDeviceInfo> => firstPicker)
            .mockImplementationOnce((): Promise<MediaDeviceInfo> => secondPicker);
        const manager = createManager(mediaDevices);
        const olderRequest = manager.requestAudioOutputSelection();
        const newerRequest = manager.requestAudioOutputSelection();
        resolveSecondPicker(createDevice('speaker-b'));
        await expect(newerRequest).resolves.toBe('speaker-b');
        const snapshotAfterSuccess = manager.getSnapshot();

        rejectFirstPicker(new DOMException('Late denial', 'NotAllowedError'));
        await expect(olderRequest).resolves.toBeNull();
        expect(manager.getSnapshot()).toEqual(snapshotAfterSuccess);
        await manager.destroy();
    });

    it('ignores an old rejection after picker cancellation and a reopened request', async () => {
        const mediaDevices = new FakeMediaDevices();
        let rejectFirstPicker: (error: unknown) => void = (error: unknown): void => {
            throw new Error(`Missing first picker rejecter for ${String(error)}`);
        };
        mediaDevices.selectAudioOutput = vi.fn()
            .mockImplementationOnce((): Promise<MediaDeviceInfo> => (
                new Promise<MediaDeviceInfo>((_resolve, reject): void => {
                    rejectFirstPicker = reject;
                })
            ))
            .mockImplementationOnce((): Promise<MediaDeviceInfo> => Promise.resolve(
                createDevice('reopened-speaker')
            ));
        const manager = createManager(mediaDevices);
        const oldRequest = manager.requestAudioOutputSelection();
        manager.cancelAudioOutputSelectionRequest();
        const reopenedRequest = manager.requestAudioOutputSelection();
        await expect(reopenedRequest).resolves.toBe('reopened-speaker');
        const snapshotAfterReopen = manager.getSnapshot();

        rejectFirstPicker(new DOMException('Late denial', 'NotAllowedError'));
        await expect(oldRequest).resolves.toBeNull();
        expect(manager.getSnapshot()).toEqual(snapshotAfterReopen);
        await manager.destroy();
    });

    it('invalidates pending picker outcomes on explicit preference changes', async () => {
        const mediaDevices = new FakeMediaDevices();
        let resolveFirstPicker: (device: MediaDeviceInfo) => void = (
            device: MediaDeviceInfo
        ): void => {
            throw new Error(`Missing first picker resolver for ${device.deviceId}`);
        };
        let rejectSecondPicker: (error: unknown) => void = (error: unknown): void => {
            throw new Error(`Missing second picker rejecter for ${String(error)}`);
        };
        const firstPicker = new Promise<MediaDeviceInfo>((resolve): void => {
            resolveFirstPicker = resolve;
        });
        const secondPicker = new Promise<MediaDeviceInfo>((_resolve, reject): void => {
            rejectSecondPicker = reject;
        });
        mediaDevices.selectAudioOutput = vi.fn()
            .mockImplementationOnce((): Promise<MediaDeviceInfo> => firstPicker)
            .mockImplementationOnce((): Promise<MediaDeviceInfo> => secondPicker);
        const manager = createManager(mediaDevices, 'initial-speaker');

        const pickerBeforeDropdown = manager.requestAudioOutputSelection();
        await manager.setSelectedDeviceId('dropdown-speaker');
        const snapshotAfterDropdown = manager.getSnapshot();
        resolveFirstPicker(createDevice('late-picker-speaker'));
        await expect(pickerBeforeDropdown).resolves.toBeNull();
        expect(manager.getSnapshot()).toEqual(snapshotAfterDropdown);

        const pickerBeforeReset = manager.requestAudioOutputSelection();
        await manager.setSelectedDeviceId(null);
        const snapshotAfterReset = manager.getSnapshot();
        rejectSecondPicker(new DOMException('Late denial', 'NotAllowedError'));
        await expect(pickerBeforeReset).resolves.toBeNull();
        expect(manager.getSnapshot()).toEqual(snapshotAfterReset);
        await manager.destroy();
    });

    it('surfaces synchronous picker and enumeration failures while retaining preference', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.enumerateDevices.mockRejectedValue(
            new DOMException('Blocked', 'NotAllowedError')
        );
        mediaDevices.selectAudioOutput = vi.fn((): Promise<MediaDeviceInfo> => {
            throw new DOMException('No activation', 'InvalidStateError');
        });
        const manager = createManager(mediaDevices, 'speaker-a');

        await manager.refresh();
        expect(manager.getSnapshot()).toMatchObject({
            devices: [],
            selectedDeviceId: 'speaker-a',
            status: 'inactive'
        });
        expect(await manager.requestAudioOutputSelection()).toBeNull();
        expect(manager.getSnapshot()).toMatchObject({
            messageCode: 'picker-user-action-required',
            selectedDeviceId: 'speaker-a',
            status: 'error'
        });
        await manager.destroy();
    });

    it.each([
        [ 'AbortError', 'picker-cancelled' ],
        [ 'NotFoundError', 'picker-not-found' ]
    ])('surfaces %s picker rejection without clearing preference', async (
        errorName,
        expectedMessageCode
    ) => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.selectAudioOutput = vi.fn(() => Promise.reject(
            new DOMException('Picker failed', errorName)
        ));
        const manager = createManager(mediaDevices, 'speaker-a');

        expect(await manager.requestAudioOutputSelection()).toBeNull();
        expect(manager.getSnapshot()).toMatchObject({
            messageCode: expectedMessageCode,
            selectedDeviceId: 'speaker-a',
            status: 'error'
        });
        await manager.destroy();
    });

    it('reports when the browser picker API is unavailable', async () => {
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(mediaDevices);

        expect(await manager.requestAudioOutputSelection()).toBeNull();
        expect(manager.getSnapshot()).toMatchObject({
            messageCode: 'picker-unavailable',
            pickerAvailable: false,
            status: 'unsupported'
        });
        await manager.destroy();
    });

    it('deduplicates physical targets and removes device listeners on destroy', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a') ];
        const removeEventListener = vi.spyOn(mediaDevices, 'removeEventListener');
        const manager = createManager(mediaDevices, 'speaker-a');
        const audioContext = new FakeAudioContext();
        const firstLease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        const secondLease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await Promise.all([ firstLease.ready, secondLease.ready ]);

        expect(audioContext.setSinkId).toHaveBeenCalledTimes(1);
        await firstLease.release();
        await manager.setSelectedDeviceId(null);
        expect(audioContext.setSinkId).toHaveBeenLastCalledWith('');
        await secondLease.release();
        await manager.destroy();
        expect(removeEventListener).toHaveBeenCalledWith(
            'devicechange',
            expect.any(Function)
        );
    });
});
