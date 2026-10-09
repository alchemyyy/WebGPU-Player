import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    microsecondsToMilliseconds,
    microsecondsToSeconds,
    millisecondsToMicroseconds
} from 'webgpu-player/MediaTime';
import OwnedNativeMediaAudioBackend, {
    MAXIMUM_NATIVE_AUDIO_PENDING_SEGMENT_COUNT,
    NATIVE_AUDIO_LATE_START_OVERSHOOT_THRESHOLD_MICROSECONDS,
    NATIVE_AUDIO_LATE_START_THRESHOLD_MICROSECONDS,
    type OwnedNativeMediaAudioEvent,
    type OwnedNativeMediaAudioSegment
} from 'webgpu-player/audio/native/OwnedNativeMediaAudioBackend';

// First E-AC-3 fragment of a field MKV whose video starts at zero
const LATE_FRAGMENT_START_MILLISECONDS = 6_006;
const LATE_FRAGMENT_END_MILLISECONDS = 6_518;
const LATE_FRAGMENT_START_SECONDS = 6.006;
// End of the media appended on from the late fragment
const BUFFERED_END_SECONDS = 12;
// Hidden tabs align throttled timers to one-second wake-ups
const THROTTLED_TIMER_LATENESS_MILLISECONDS = 1_000;
const PLAY_INTERRUPTED_MESSAGE = 'The play() request was interrupted';

class FakeTimeRanges {
    public ranges: Array<{ end: number, start: number }> = [];

    public get length(): number {
        return this.ranges.length;
    }

    public end(index: number): number {
        const range = this.ranges[index];
        if (!range) {
            throw new RangeError('Missing fake buffered range');
        }
        return range.end;
    }

    public start(index: number): number {
        const range = this.ranges[index];
        if (!range) {
            throw new RangeError('Missing fake buffered range');
        }
        return range.start;
    }
}

class FakeSourceBuffer extends EventTarget {
    public readonly appendCalls: Uint8Array[] = [];
    public readonly buffered = new FakeTimeRanges();
    public mode: AppendMode = 'segments';
    public readonly removeCalls: Array<{ end: number, start: number }> = [];
    public updating = false;

    public appendBuffer(data: ArrayBuffer): void {
        this.updating = true;
        this.appendCalls.push(new Uint8Array(data.slice(0)));
        void Promise.resolve().then((): void => {
            this.updating = false;
            this.dispatchEvent(new Event('updateend'));
        });
    }

    public remove(start: number, end: number): void {
        this.updating = true;
        this.removeCalls.push({ end, start });
        void Promise.resolve().then((): void => {
            this.updating = false;
            this.buffered.ranges = this.buffered.ranges
                .filter(range => range.end > end)
                .map(range => ({ end: range.end, start: Math.max(range.start, end) }));
            this.dispatchEvent(new Event('updateend'));
        });
    }
}

class FakeMediaSource extends EventTarget {
    public duration = Number.NaN;
    public endOfStreamCalls = 0;
    public readyState: ReadyState = 'open';
    public readonly requestedMimeTypes: string[] = [];
    public readonly sourceBuffer = new FakeSourceBuffer();

    public addSourceBuffer(mimeType: string): SourceBuffer {
        this.requestedMimeTypes.push(mimeType);
        return this.sourceBuffer as unknown as SourceBuffer;
    }

    public endOfStream(): void {
        this.endOfStreamCalls += 1;
        this.readyState = 'ended';
    }
}

class FakeAudioElement extends EventTarget {
    public autoplay = false;
    public readonly buffered = new FakeTimeRanges();
    public readonly classList = { add: vi.fn() };
    public controls = false;
    public currentTime = 0;
    public error: MediaError | null = null;
    public loadCalls = 0;
    public muted = false;
    public pauseCalls = 0;
    public paused = true;
    public playbackRate = 1;
    public playCalls = 0;
    // Element position at each play() call
    public readonly playPositions: number[] = [];
    public preload = '';
    public removeCalls = 0;
    public readonly removeAttribute = vi.fn();
    public readonly setAttribute = vi.fn();
    public readonly setSinkId = vi.fn((sinkId: string): Promise<void> => {
        this.sinkId = sinkId;
        return Promise.resolve();
    });
    public sinkId = '';
    public src = '';
    public volume = 1;

    public load(): void {
        this.loadCalls += 1;
    }

    public pause(): void {
        this.pauseCalls += 1;
        this.paused = true;
        this.dispatchEvent(new Event('pause'));
    }

    public play(): Promise<void> {
        this.playCalls += 1;
        this.playPositions.push(this.currentTime);
        this.paused = false;
        this.dispatchEvent(new Event('playing'));
        return Promise.resolve();
    }

    public remove(): void {
        this.removeCalls += 1;
    }

    public advanceTo(seconds: number): void {
        this.currentTime = seconds;
        this.dispatchEvent(new Event('timeupdate'));
    }
}

type BackendHarness = {
    audioElement: FakeAudioElement
    backend: OwnedNativeMediaAudioBackend
    events: OwnedNativeMediaAudioEvent[]
    mediaSource: FakeMediaSource
    revokeObjectURL: ReturnType<typeof vi.fn>
};

function createHarness(options: {
    maximumAppendedAheadMilliseconds?: number
    retainedBehindMilliseconds?: number
} = {}): BackendHarness {
    const audioElement = new FakeAudioElement();
    const mediaSource = new FakeMediaSource();
    const events: OwnedNativeMediaAudioEvent[] = [];
    const revokeObjectURL = vi.fn();
    const backend = new OwnedNativeMediaAudioBackend({
        appendElement: vi.fn(),
        createAudioElement: () => audioElement as unknown as HTMLAudioElement,
        createMediaSource: () => mediaSource as unknown as MediaSource,
        createObjectURL: () => 'blob:native-audio',
        eventHandler: event => events.push(event),
        maximumAppendedAheadMicroseconds: millisecondsToMicroseconds(
            options.maximumAppendedAheadMilliseconds ?? 6_000
        ),
        operationTimeoutMicroseconds: millisecondsToMicroseconds(1_000),
        retainedBehindMicroseconds: millisecondsToMicroseconds(
            options.retainedBehindMilliseconds ?? 5_000
        ),
        revokeObjectURL
    });
    return { audioElement, backend, events, mediaSource, revokeObjectURL };
}

function createSegment(
    startMilliseconds: number,
    endMilliseconds: number,
    byte = 2
): OwnedNativeMediaAudioSegment {
    return {
        data: new Uint8Array([ byte ]),
        endTimeMicroseconds: millisecondsToMicroseconds(endMilliseconds),
        startTimeMicroseconds: millisecondsToMicroseconds(startMilliseconds)
    };
}

async function startBackend(harness: BackendHarness, generation = 1): Promise<void> {
    await harness.backend.start({
        durationMicroseconds: millisecondsToMicroseconds(60_000),
        generation,
        mimeType: 'audio/mp4; codecs="ec-3"',
        startTimeMicroseconds: millisecondsToMicroseconds(0)
    });
}

async function appendLateFirstFragment(harness: BackendHarness): Promise<void> {
    expect(await harness.backend.appendInitializationSegment(
        1,
        new Uint8Array([ 1 ])
    )).toBe(true);
    expect(await harness.backend.appendMediaSegment(
        1,
        createSegment(LATE_FRAGMENT_START_MILLISECONDS, LATE_FRAGMENT_END_MILLISECONDS)
    )).toBe(true);
}

function flushMacrotask(): Promise<void> {
    return new Promise<void>(resolve => {
        globalThis.setTimeout(resolve, 0);
    });
}

function millisecondsToSeconds(milliseconds: number): number {
    return microsecondsToSeconds(millisecondsToMicroseconds(milliseconds));
}

/**
 * Lets a test move the faked monotonic clock on without running timers, as a throttled hidden tab does.
 * Install it once per test after vi.useFakeTimers(), which replaces globalThis.performance.
 */
function installMonotonicClockShift(): (milliseconds: number) => void {
    const fakePerformance = globalThis.performance;
    const readFakeMilliseconds = fakePerformance.now.bind(fakePerformance);
    let shiftMilliseconds = 0;
    vi.spyOn(fakePerformance, 'now').mockImplementation(
        (): number => readFakeMilliseconds() + shiftMilliseconds
    );
    return (milliseconds: number): void => {
        shiftMilliseconds += milliseconds;
    };
}

/** Starts a backend parked on the late first fragment whose element buffers one range. */
async function createParkedHarness(
    bufferedStartSeconds: number,
    bufferedEndSeconds: number
): Promise<BackendHarness> {
    const harness = createHarness();
    await startBackend(harness);
    await appendLateFirstFragment(harness);
    harness.audioElement.buffered.ranges = [{ end: bufferedEndSeconds, start: bufferedStartSeconds }];
    return harness;
}

/** Plays a parked late start whose deferred play() timer runs the given lateness after it was due. */
async function playWithLateTimer(
    harness: BackendHarness,
    shiftMonotonicClock: (milliseconds: number) => void,
    latenessMilliseconds: number
): Promise<void> {
    expect(await harness.backend.setPlaying(1, true)).toBe(true);
    await vi.advanceTimersByTimeAsync(LATE_FRAGMENT_START_MILLISECONDS - 1);
    // The timer runs at its due time on the fake timers while the monotonic clock reads the lateness past it
    shiftMonotonicClock(latenessMilliseconds);
    await vi.advanceTimersByTimeAsync(1);
}

/** Keeps every play() pending and returns a function that rejects the latest one. */
function holdPlayRequests(audioElement: FakeAudioElement): (error: DOMException) => void {
    const playRejections: Array<(error: DOMException) => void> = [];
    vi.spyOn(audioElement, 'play').mockImplementation(
        (): Promise<void> => new Promise<void>((_resolve, reject) => {
            playRejections.push(reject);
        })
    );
    return (error: DOMException): void => {
        const rejectLatestPlay = playRejections.at(-1);
        if (!rejectLatestPlay) {
            throw new Error(`Deferred play() was not started before ${error.name}`);
        }
        rejectLatestPlay(error);
    };
}

describe('OwnedNativeMediaAudioBackend', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('owns one MSE element and qualifies its clock only after playback advances', async () => {
        const harness = createHarness();
        await startBackend(harness);

        expect(harness.audioElement.src).toBe('blob:native-audio');
        expect(harness.audioElement.setSinkId).toHaveBeenCalledWith('');
        expect(harness.mediaSource.duration).toBe(60);
        expect(await harness.backend.appendInitializationSegment(
            1,
            new Uint8Array([ 0, 1 ])
        )).toBe(true);
        expect(await harness.backend.appendMediaSegment(1, createSegment(0, 1_000))).toBe(true);
        expect(harness.mediaSource.sourceBuffer.appendCalls).toEqual([
            new Uint8Array([ 0, 1 ]),
            new Uint8Array([ 2 ])
        ]);

        expect(await harness.backend.setPlaying(1, true)).toBe(true);
        expect(harness.backend.getAuthoritativeTimeMicroseconds()).toBeNull();
        harness.audioElement.advanceTo(0.125);
        expect(harness.backend.getAuthoritativeTimeMicroseconds())
            .toBe(millisecondsToMicroseconds(125));
        expect(harness.events.filter(event => event.type === 'clock-ready')).toHaveLength(1);

        harness.backend.setVolume(0.25);
        harness.backend.setMuted(true);
        harness.backend.setPlaybackRate(1.5);
        expect(harness.audioElement.volume).toBe(0.25);
        expect(harness.audioElement.muted).toBe(true);
        expect(harness.audioElement.playbackRate).toBe(1.5);
        expect(await harness.backend.endOfStream(1)).toBe(true);
        expect(harness.mediaSource.endOfStreamCalls).toBe(1);

        expect(await harness.backend.stop(1)).toBe(true);
        expect(harness.audioElement.pauseCalls).toBeGreaterThan(0);
        expect(harness.audioElement.loadCalls).toBe(1);
        expect(harness.audioElement.removeCalls).toBe(1);
        expect(harness.revokeObjectURL).toHaveBeenCalledWith('blob:native-audio');
    });

    it('backpressures fragments beyond the bounded appended-ahead window', async () => {
        const harness = createHarness({ maximumAppendedAheadMilliseconds: 2_000 });
        await startBackend(harness);
        await harness.backend.appendInitializationSegment(1, new Uint8Array([ 1 ]));
        await harness.backend.appendMediaSegment(1, createSegment(0, 1_000));

        let appendSettled = false;
        const blockedAppend = harness.backend
            .appendMediaSegment(1, createSegment(1_000, 2_900))
            .then(result => {
                appendSettled = true;
                return result;
            });
        await Promise.resolve();
        await Promise.resolve();
        expect(appendSettled).toBe(false);
        expect(harness.backend.getTelemetry().pendingAppendCount).toBe(1);

        harness.audioElement.advanceTo(2);
        expect(await blockedAppend).toBe(true);
        expect(harness.mediaSource.sourceBuffer.appendCalls).toHaveLength(3);
    });

    it('caps concurrent queued fragments and cancels blocked work on stop', async () => {
        const harness = createHarness({ maximumAppendedAheadMilliseconds: 500 });
        await startBackend(harness);
        await harness.backend.appendInitializationSegment(1, new Uint8Array([ 1 ]));
        // Hold the element at the requested start so the queued fragments exceed the window
        await harness.backend.appendMediaSegment(1, createSegment(0, 100));

        const queuedAppends: Promise<boolean>[] = [];
        for (
            let segmentIndex = 0;
            segmentIndex < MAXIMUM_NATIVE_AUDIO_PENDING_SEGMENT_COUNT;
            segmentIndex += 1
        ) {
            queuedAppends.push(harness.backend.appendMediaSegment(
                1,
                createSegment(1_000 + segmentIndex, 1_100 + segmentIndex)
            ));
        }
        await expect(harness.backend.appendMediaSegment(
            1,
            createSegment(2_000, 2_100)
        )).rejects.toThrow('append queue is full');

        expect(await harness.backend.setPlaying(1, true)).toBe(true);
        expect(harness.audioElement.paused).toBe(false);
        const stopPromise = harness.backend.stop(1);
        expect(harness.audioElement.paused).toBe(true);
        expect(harness.audioElement.muted).toBe(true);
        expect(await stopPromise).toBe(true);
        expect(await Promise.all(queuedAppends)).toEqual(
            new Array(MAXIMUM_NATIVE_AUDIO_PENDING_SEGMENT_COUNT).fill(false)
        );
        expect(harness.backend.getTelemetry().pendingAppendCount).toBe(0);
    });

    it('removes history beyond the retained-behind window', async () => {
        const harness = createHarness({ retainedBehindMilliseconds: 2_000 });
        await startBackend(harness);
        await harness.backend.appendInitializationSegment(1, new Uint8Array([ 1 ]));
        await harness.backend.appendMediaSegment(1, createSegment(0, 1_000));
        harness.mediaSource.sourceBuffer.buffered.ranges = [{ end: 10, start: 0 }];
        harness.audioElement.advanceTo(8);

        await harness.backend.appendMediaSegment(1, createSegment(8_000, 9_000));
        expect(harness.mediaSource.sourceBuffer.removeCalls).toEqual([
            { end: 6, start: 0 }
        ]);
        expect(harness.backend.getTelemetry().removedRangeCount).toBe(1);
    });

    it('rejects stale generations without affecting the active element', async () => {
        const harness = createHarness();
        await startBackend(harness, 2);

        expect(await harness.backend.appendInitializationSegment(
            1,
            new Uint8Array([ 1 ])
        )).toBe(false);
        expect(await harness.backend.setPlaying(1, true)).toBe(false);
        expect(await harness.backend.stop(1)).toBe(false);
        expect(harness.audioElement.pauseCalls).toBe(0);
        expect(harness.backend.getTelemetry().activeGeneration).toBe(2);
        expect(harness.backend.getTelemetry().staleOperationCount).toBe(3);
    });

    it('validates segment timing and refuses use after destroy', async () => {
        const harness = createHarness();
        await startBackend(harness);

        await expect(harness.backend.appendMediaSegment(1, createSegment(2_000, 1_000)))
            .rejects.toThrow('duration is outside bounds');
        expect(() => harness.backend.setVolume(2)).toThrow('between zero and one');
        expect(() => harness.backend.setPlaybackRate(0)).toThrow('finite and positive');

        await harness.backend.destroy();
        await expect(harness.backend.start({
            durationMicroseconds: millisecondsToMicroseconds(1_000),
            generation: 2,
            mimeType: 'audio/mp4; codecs="ec-3"',
            startTimeMicroseconds: millisecondsToMicroseconds(0)
        })).rejects.toThrow('destroyed');
    });

    it('parks a late first fragment and defers play() until the clock reaches it', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        await startBackend(harness);
        await appendLateFirstFragment(harness);
        expect(harness.audioElement.currentTime).toBe(LATE_FRAGMENT_START_SECONDS);

        expect(await harness.backend.setPlaying(1, true)).toBe(true);
        expect(harness.backend.getTelemetry().state).toBe('playing');
        expect(harness.audioElement.playCalls).toBe(0);

        await vi.advanceTimersByTimeAsync(LATE_FRAGMENT_START_MILLISECONDS - 1);
        expect(harness.audioElement.playCalls).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(harness.audioElement.playCalls).toBe(1);
        expect(harness.audioElement.currentTime).toBe(LATE_FRAGMENT_START_SECONDS);
    });

    it('appends a late first fragment past the window and bounds later ones from it', async () => {
        const harness = createHarness();
        await startBackend(harness);
        // The first fragment ends 6.518 s after the requested start, beyond the 6 s window
        await appendLateFirstFragment(harness);

        // Room is measured from the parked point, so 12.006 s is the furthest allowed end
        expect(await harness.backend.appendMediaSegment(1, createSegment(10_500, 12_006)))
            .toBe(true);
        const blockedAppend = harness.backend.appendMediaSegment(1, createSegment(12_006, 12_100));
        await flushMacrotask();
        expect(harness.backend.getTelemetry().pendingAppendCount).toBe(1);
        expect(harness.mediaSource.sourceBuffer.appendCalls).toHaveLength(3);

        harness.audioElement.advanceTo(6.1);
        expect(await blockedAppend).toBe(true);
        expect(harness.mediaSource.sourceBuffer.appendCalls).toHaveLength(4);
    });

    it('stops the deferred play() on pause and resumes with only the remaining gap', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        await startBackend(harness);
        await appendLateFirstFragment(harness);
        const elapsedBeforePauseMilliseconds = 2_000;

        await harness.backend.setPlaying(1, true);
        await vi.advanceTimersByTimeAsync(elapsedBeforePauseMilliseconds);
        expect(await harness.backend.setPlaying(1, false)).toBe(true);
        await vi.advanceTimersByTimeAsync(LATE_FRAGMENT_START_MILLISECONDS);
        expect(harness.audioElement.playCalls).toBe(0);

        expect(await harness.backend.setPlaying(1, true)).toBe(true);
        const remainingGapMilliseconds =
            LATE_FRAGMENT_START_MILLISECONDS - elapsedBeforePauseMilliseconds;
        await vi.advanceTimersByTimeAsync(remainingGapMilliseconds - 1);
        expect(harness.audioElement.playCalls).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(harness.audioElement.playCalls).toBe(1);
    });

    it('keeps the requested start when the first fragment is within the threshold', async () => {
        const harness = createHarness();
        await startBackend(harness);
        const thresholdMilliseconds = microsecondsToMilliseconds(
            NATIVE_AUDIO_LATE_START_THRESHOLD_MICROSECONDS
        );
        await harness.backend.appendInitializationSegment(1, new Uint8Array([ 1 ]));
        expect(await harness.backend.appendMediaSegment(
            1,
            createSegment(thresholdMilliseconds, thresholdMilliseconds + 500)
        )).toBe(true);
        expect(harness.audioElement.currentTime).toBe(0);

        expect(await harness.backend.setPlaying(1, true)).toBe(true);
        expect(harness.audioElement.playCalls).toBe(1);
    });

    it('drops a pending late start on seek and stop', async () => {
        vi.useFakeTimers();
        const seekHarness = createHarness();
        await startBackend(seekHarness);
        await appendLateFirstFragment(seekHarness);
        await seekHarness.backend.setPlaying(1, true);

        // The deferred play() starts at once at the new position and never again later
        expect(seekHarness.backend.seek(1, millisecondsToMicroseconds(6_200))).toBe(true);
        expect(seekHarness.audioElement.currentTime).toBe(6.2);
        expect(seekHarness.audioElement.playCalls).toBe(1);
        await vi.advanceTimersByTimeAsync(LATE_FRAGMENT_START_MILLISECONDS);
        expect(seekHarness.audioElement.playCalls).toBe(1);

        const stopHarness = createHarness();
        await startBackend(stopHarness);
        await appendLateFirstFragment(stopHarness);
        await stopHarness.backend.setPlaying(1, true);
        expect(await stopHarness.backend.stop(1)).toBe(true);
        await vi.advanceTimersByTimeAsync(LATE_FRAGMENT_START_MILLISECONDS);
        expect(stopHarness.audioElement.playCalls).toBe(0);
    });

    it('reports a rejected deferred play() as an error event', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        await startBackend(harness);
        await appendLateFirstFragment(harness);
        const playSpy = vi.spyOn(harness.audioElement, 'play')
            .mockRejectedValue(new DOMException('Playback was not allowed', 'NotAllowedError'));

        expect(await harness.backend.setPlaying(1, true)).toBe(true);
        await vi.advanceTimersByTimeAsync(LATE_FRAGMENT_START_MILLISECONDS);

        expect(playSpy).toHaveBeenCalledOnce();
        expect(harness.events.filter(event => event.type === 'error')).toEqual([
            { generation: 1, message: 'Playback was not allowed', type: 'error' }
        ]);
        expect(harness.backend.getTelemetry().state).toBe('paused');
    });

    it('ignores a deferred play() that a pause interrupted', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        await startBackend(harness);
        await appendLateFirstFragment(harness);
        let rejectPlay: (error: DOMException) => void = (error: DOMException): void => {
            throw new Error(`Deferred play() was not started before ${error.name}`);
        };
        vi.spyOn(harness.audioElement, 'play').mockImplementation(
            (): Promise<void> => new Promise<void>((_resolve, reject) => {
                rejectPlay = reject;
            })
        );

        await harness.backend.setPlaying(1, true);
        await vi.advanceTimersByTimeAsync(LATE_FRAGMENT_START_MILLISECONDS);
        expect(await harness.backend.setPlaying(1, false)).toBe(true);
        rejectPlay(new DOMException('The play() request was interrupted', 'AbortError'));
        await vi.advanceTimersByTimeAsync(0);

        expect(harness.events.filter(event => event.type === 'error')).toHaveLength(0);
        expect(harness.backend.getTelemetry().state).toBe('paused');
    });

    it('qualifies the native clock only after playback passes the parked fragment', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        await startBackend(harness);
        await appendLateFirstFragment(harness);
        await harness.backend.setPlaying(1, true);
        expect(harness.backend.getAuthoritativeTimeMicroseconds()).toBeNull();

        // Even a reported position past the parked fragment is no progress before play()
        harness.audioElement.advanceTo(6.05);
        expect(harness.backend.getAuthoritativeTimeMicroseconds()).toBeNull();
        harness.audioElement.advanceTo(LATE_FRAGMENT_START_SECONDS);

        await vi.advanceTimersByTimeAsync(LATE_FRAGMENT_START_MILLISECONDS);
        expect(harness.audioElement.playCalls).toBe(1);
        expect(harness.backend.getAuthoritativeTimeMicroseconds()).toBeNull();
        harness.audioElement.advanceTo(6.1);
        expect(harness.backend.getAuthoritativeTimeMicroseconds())
            .toBe(millisecondsToMicroseconds(6_100));
        expect(harness.events.filter(event => event.type === 'clock-ready')).toHaveLength(1);
    });

    it('scales the deferred play() by the playback rate and retimes it on a change', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        await startBackend(harness);
        await appendLateFirstFragment(harness);
        harness.backend.setPlaybackRate(2);
        await harness.backend.setPlaying(1, true);

        // One second at double rate covers two seconds of the gap
        await vi.advanceTimersByTimeAsync(1_000);
        harness.backend.setPlaybackRate(1);
        const remainingGapMilliseconds = LATE_FRAGMENT_START_MILLISECONDS - 2_000;
        await vi.advanceTimersByTimeAsync(remainingGapMilliseconds - 1);
        expect(harness.audioElement.playCalls).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(harness.audioElement.playCalls).toBe(1);
    });

    it('starts on a late first fragment at once when play() preceded any media', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        await startBackend(harness);
        await harness.backend.appendInitializationSegment(1, new Uint8Array([ 1 ]));
        expect(await harness.backend.setPlaying(1, true)).toBe(true);
        expect(await harness.backend.appendMediaSegment(
            1,
            createSegment(LATE_FRAGMENT_START_MILLISECONDS, LATE_FRAGMENT_END_MILLISECONDS)
        )).toBe(true);
        expect(harness.audioElement.currentTime).toBe(LATE_FRAGMENT_START_SECONDS);

        await vi.advanceTimersByTimeAsync(LATE_FRAGMENT_START_MILLISECONDS);
        expect(harness.audioElement.playCalls).toBe(1);
        harness.audioElement.advanceTo(6.1);
        expect(harness.backend.getAuthoritativeTimeMicroseconds())
            .toBe(millisecondsToMicroseconds(6_100));
    });

    it('advances a late-fired deferred play() and its clock baseline by the overshoot', async () => {
        vi.useFakeTimers();
        const shiftMonotonicClock = installMonotonicClockShift();
        const harness = await createParkedHarness(LATE_FRAGMENT_START_SECONDS, BUFFERED_END_SECONDS);
        await playWithLateTimer(harness, shiftMonotonicClock, THROTTLED_TIMER_LATENESS_MILLISECONDS);

        // play() starts where the page clock already is instead of stepping back to the parked fragment
        expect(harness.audioElement.playPositions).toEqual([
            millisecondsToSeconds(
                LATE_FRAGMENT_START_MILLISECONDS + THROTTLED_TIMER_LATENESS_MILLISECONDS
            )
        ]);
        expect(harness.backend.getAuthoritativeTimeMicroseconds()).toBeNull();
        harness.audioElement.advanceTo(7.1);
        expect(harness.backend.getAuthoritativeTimeMicroseconds())
            .toBe(millisecondsToMicroseconds(7_100));
        expect(harness.events.filter(event => event.type === 'clock-ready')).toHaveLength(1);
    });

    it('keeps the parked position when the deferred play() is late by at most the threshold', async () => {
        vi.useFakeTimers();
        const shiftMonotonicClock = installMonotonicClockShift();
        const thresholdMilliseconds = microsecondsToMilliseconds(
            NATIVE_AUDIO_LATE_START_OVERSHOOT_THRESHOLD_MICROSECONDS
        );
        for (const latenessMilliseconds of [ 0, thresholdMilliseconds ]) {
            const parkedHarness = await createParkedHarness(
                LATE_FRAGMENT_START_SECONDS,
                BUFFERED_END_SECONDS
            );
            await playWithLateTimer(parkedHarness, shiftMonotonicClock, latenessMilliseconds);
            expect(parkedHarness.audioElement.playPositions).toEqual([ LATE_FRAGMENT_START_SECONDS ]);
        }

        const lateHarness = await createParkedHarness(LATE_FRAGMENT_START_SECONDS, BUFFERED_END_SECONDS);
        await playWithLateTimer(lateHarness, shiftMonotonicClock, thresholdMilliseconds + 1);
        expect(lateHarness.audioElement.playPositions).toEqual([
            millisecondsToSeconds(LATE_FRAGMENT_START_MILLISECONDS + thresholdMilliseconds + 1)
        ]);
    });

    it('clamps the late-fire advance to the buffered range holding the parked point', async () => {
        vi.useFakeTimers();
        const shiftMonotonicClock = installMonotonicClockShift();
        const shortRangeEndSeconds = 6.5;
        const clampedHarness = await createParkedHarness(
            LATE_FRAGMENT_START_SECONDS,
            shortRangeEndSeconds
        );
        await playWithLateTimer(
            clampedHarness,
            shiftMonotonicClock,
            THROTTLED_TIMER_LATENESS_MILLISECONDS
        );
        expect(clampedHarness.audioElement.playPositions).toEqual([ shortRangeEndSeconds ]);
        // The clamped position is the new clock baseline as well
        expect(clampedHarness.backend.getAuthoritativeTimeMicroseconds()).toBeNull();
        clampedHarness.audioElement.advanceTo(6.6);
        expect(clampedHarness.backend.getAuthoritativeTimeMicroseconds())
            .toBe(millisecondsToMicroseconds(6_600));

        // Media buffered only beyond a gap is never a target
        const gapHarness = await createParkedHarness(7, BUFFERED_END_SECONDS);
        await playWithLateTimer(gapHarness, shiftMonotonicClock, THROTTLED_TIMER_LATENESS_MILLISECONDS);
        expect(gapHarness.audioElement.playPositions).toEqual([ LATE_FRAGMENT_START_SECONDS ]);

        // 44.1 kHz timestamp rounding starts the fragment's buffered range 9 microseconds late
        const quantizedHarness = await createParkedHarness(6.006009, BUFFERED_END_SECONDS);
        await playWithLateTimer(
            quantizedHarness,
            shiftMonotonicClock,
            THROTTLED_TIMER_LATENESS_MILLISECONDS
        );
        expect(quantizedHarness.audioElement.playPositions).toEqual([
            millisecondsToSeconds(
                LATE_FRAGMENT_START_MILLISECONDS + THROTTLED_TIMER_LATENESS_MILLISECONDS
            )
        ]);
    });

    it('carries the overshoot of an overdue deferred play() across a pause', async () => {
        vi.useFakeTimers();
        const shiftMonotonicClock = installMonotonicClockShift();
        const harness = await createParkedHarness(LATE_FRAGMENT_START_SECONDS, BUFFERED_END_SECONDS);
        const overdueMilliseconds = 500;

        expect(await harness.backend.setPlaying(1, true)).toBe(true);
        await vi.advanceTimersByTimeAsync(LATE_FRAGMENT_START_MILLISECONDS - 1);
        // The pause lands after the throttled timer was due but before it ran
        shiftMonotonicClock(1 + overdueMilliseconds);
        expect(await harness.backend.setPlaying(1, false)).toBe(true);
        expect(harness.audioElement.playCalls).toBe(0);
        expect(await harness.backend.setPlaying(1, true)).toBe(true);
        await vi.advanceTimersByTimeAsync(0);

        expect(harness.audioElement.playPositions).toEqual([
            millisecondsToSeconds(LATE_FRAGMENT_START_MILLISECONDS + overdueMilliseconds)
        ]);
    });

    it('ignores a deferred play() that a seek or stop interrupted', async () => {
        vi.useFakeTimers();
        const interruption = new DOMException(PLAY_INTERRUPTED_MESSAGE, 'AbortError');
        const seekHarness = createHarness();
        await startBackend(seekHarness);
        await appendLateFirstFragment(seekHarness);
        const rejectSeekPlay = holdPlayRequests(seekHarness.audioElement);
        await seekHarness.backend.setPlaying(1, true);
        await vi.advanceTimersByTimeAsync(LATE_FRAGMENT_START_MILLISECONDS);
        expect(seekHarness.backend.seek(1, millisecondsToMicroseconds(6_200))).toBe(true);
        rejectSeekPlay(interruption);
        await vi.advanceTimersByTimeAsync(0);
        expect(seekHarness.events.filter(event => event.type === 'error')).toHaveLength(0);

        const stopHarness = createHarness();
        await startBackend(stopHarness);
        await appendLateFirstFragment(stopHarness);
        const rejectStopPlay = holdPlayRequests(stopHarness.audioElement);
        await stopHarness.backend.setPlaying(1, true);
        await vi.advanceTimersByTimeAsync(LATE_FRAGMENT_START_MILLISECONDS);
        expect(await stopHarness.backend.stop(1)).toBe(true);
        rejectStopPlay(interruption);
        await vi.advanceTimersByTimeAsync(0);
        expect(stopHarness.events.filter(event => event.type === 'error')).toHaveLength(0);
    });

    it('reports an AbortError from a deferred play() that the backend did not interrupt', async () => {
        vi.useFakeTimers();
        const interruption = new DOMException(PLAY_INTERRUPTED_MESSAGE, 'AbortError');
        const expectedErrors: OwnedNativeMediaAudioEvent[] = [
            { generation: 1, message: PLAY_INTERRUPTED_MESSAGE, type: 'error' }
        ];

        // A pause before the deferred play() was issued does not excuse its abort
        const resumedHarness = createHarness();
        await startBackend(resumedHarness);
        await appendLateFirstFragment(resumedHarness);
        const resumedPlaySpy = vi.spyOn(resumedHarness.audioElement, 'play')
            .mockRejectedValue(interruption);
        await resumedHarness.backend.setPlaying(1, true);
        await vi.advanceTimersByTimeAsync(1_000);
        await resumedHarness.backend.setPlaying(1, false);
        await resumedHarness.backend.setPlaying(1, true);
        await vi.advanceTimersByTimeAsync(LATE_FRAGMENT_START_MILLISECONDS);
        expect(resumedPlaySpy).toHaveBeenCalledOnce();
        expect(resumedHarness.events.filter(event => event.type === 'error')).toEqual(expectedErrors);
        expect(resumedHarness.backend.getTelemetry().state).toBe('paused');

        // A seek interrupts only the deferred play() calls before it, not the one it starts
        const seekHarness = createHarness();
        await startBackend(seekHarness);
        await appendLateFirstFragment(seekHarness);
        const seekPlaySpy = vi.spyOn(seekHarness.audioElement, 'play')
            .mockRejectedValue(interruption);
        await seekHarness.backend.setPlaying(1, true);
        expect(seekHarness.backend.seek(1, millisecondsToMicroseconds(6_200))).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(seekPlaySpy).toHaveBeenCalledOnce();
        expect(seekHarness.events.filter(event => event.type === 'error')).toEqual(expectedErrors);
    });
});
