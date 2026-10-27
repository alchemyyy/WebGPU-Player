import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import CapabilityProbeStore, {
    type CapabilityProbeFingerprint,
    type CapabilityProbeStorage
} from 'webgpu-player/capability/CapabilityProbeStore';
import CustomDecodeCapabilityProbe, {
    BACKGROUND_PROBE_NEGOTIATION_HOLD_MILLISECONDS,
    BACKGROUND_PROBE_RECHECK_MILLISECONDS,
    CUSTOM_NATIVE_SURROUND_AUDIO_CODECS,
    CUSTOM_WEB_CODECS_AUDIO_CODECS,
    warmCustomDecodeCapabilities,
    type CustomDecodeCapabilityProbeOptions,
    type NativeAudioOutputProbeRequest,
    type NativeVideoOutputProbeRequest,
    type WebCodecsCapabilityEnvironment
} from 'webgpu-player/capability/CustomDecodeCapabilities';

type ProbeHarness = {
    audioProbe: Mock<(config: AudioDecoderConfig) => Promise<AudioDecoderSupport>>
    environment: WebCodecsCapabilityEnvironment
    nativeAudioOutputProbe: Mock<(request: NativeAudioOutputProbeRequest) => Promise<boolean>>
    nativeVideoOutputProbe: Mock<(request: NativeVideoOutputProbeRequest) => Promise<boolean>>
    vectorLoader: Mock<(assetPath: string, priority: RequestPriority) => Promise<ArrayBuffer>>
    videoProbe: Mock<(config: VideoDecoderConfig) => Promise<VideoDecoderSupport>>
};

type IdleGate = {
    /** Ends the oldest pending idle wait; returns whether one was pending */
    release: () => boolean
    waitForIdle: (cancel: Promise<void>) => Promise<void>
    waiterCount: () => number
};

const CAPABILITY_PROBE_TIMEOUT_MILLISECONDS = 2_000;
const AAC_CODEC_STRING = 'mp4a.40.2';
const SURROUND_CHANNEL_COUNT = 6;
const FINGERPRINT: CapabilityProbeFingerprint = Object.freeze({
    adapter: null,
    buildKey: 'build-1',
    userAgent: 'Mozilla/5.0 Chrome/150.0.0.0',
    userAgentData: null
});
// An MPEG-2 item selects only the audio probes, since only a decoder package decodes its video
const MPEG2_ITEM = Object.freeze({ MediaStreams: [ { BitDepth: 8, Codec: 'mpeg2video', Type: 'Video', VideoRange: 'SDR' } ] });
// An SDR HEVC item selects the audio probes and the HEVC SDR and Ultra HD probes
const HEVC_ITEM = Object.freeze({
    MediaStreams: [ { BitDepth: 8, Codec: 'hevc', PixelFormat: 'yuv420p', Profile: 'Main', Type: 'Video', VideoRange: 'SDR', VideoRangeType: 'SDR' } ]
});
const VP8_ITEM = Object.freeze({ MediaStreams: [ { BitDepth: 8, Codec: 'vp8', Type: 'Video', VideoRange: 'SDR', VideoRangeType: 'SDR' } ] });
const AUDIO_CONFIGURATION_COUNT = CUSTOM_WEB_CODECS_AUDIO_CODECS.length + CUSTOM_NATIVE_SURROUND_AUDIO_CODECS.length;

/** Creates an environment where every configuration is supported, and every video decode matches unless a driver now fails it. */
function createHarness(videoOutputSupported = true): ProbeHarness {
    const audioProbe = vi.fn(async (config: AudioDecoderConfig): Promise<AudioDecoderSupport> => ({ config, supported: true }));
    const videoProbe = vi.fn(async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({ config, supported: true }));
    const nativeAudioOutputProbe = vi.fn<(probeRequest: NativeAudioOutputProbeRequest) => Promise<boolean>>(async () => true);
    const nativeVideoOutputProbe = vi.fn<(probeRequest: NativeVideoOutputProbeRequest) => Promise<boolean>>(async () => videoOutputSupported);
    const vectorLoader = vi.fn<(assetPath: string, priority: RequestPriority) => Promise<ArrayBuffer>>(() => (
        Promise.reject(new Error('no vector in this test'))
    ));
    return {
        audioProbe,
        environment: {
            audioDecoder: { isConfigSupported: audioProbe },
            h264ProfileProbe: null,
            hevcRangeExtensionVectorLoader: vectorLoader,
            nativeAudioOutputProbe,
            nativeDolbyVisionVideoOutputProbe: null,
            nativeHDRVideoOutputProbe: null,
            nativeVideoOutputProbe,
            rawHDRVideoOutputProbe: vi.fn(async () => ({ outputCopySupported: true })),
            videoDecoder: { isConfigSupported: videoProbe }
        },
        nativeAudioOutputProbe,
        nativeVideoOutputProbe,
        vectorLoader,
        videoProbe
    };
}

function createIdleGate(): IdleGate {
    const waiters: Array<() => void> = [];
    return {
        release: (): boolean => {
            const waiter = waiters.shift();
            waiter?.();
            return waiter !== undefined;
        },
        waitForIdle: (cancel: Promise<void>): Promise<void> => new Promise<void>((resolve) => {
            waiters.push(resolve);
            void cancel.then(resolve);
        }),
        waiterCount: (): number => waiters.length
    };
}

function createMemoryStorage(): CapabilityProbeStorage & { entries: Map<string, string> } {
    const entries = new Map<string, string>();
    return {
        entries,
        getItem: (key: string): string | null => entries.get(key) ?? null,
        removeItem: (key: string): void => {
            entries.delete(key);
        },
        setItem: (key: string, value: string): void => {
            entries.set(key, value);
        }
    };
}

function createStore(storage: CapabilityProbeStorage): CapabilityProbeStore {
    return new CapabilityProbeStore({ now: Date.now, readFingerprint: () => Promise.resolve(FINGERPRINT), storage: () => storage });
}

function createProbe(harness: ProbeHarness, options: CustomDecodeCapabilityProbeOptions = {}): CustomDecodeCapabilityProbe {
    return new CustomDecodeCapabilityProbe(harness.environment, { now: Date.now, waitForIdle: () => Promise.resolve(), ...options });
}

function countSurroundConfigurations(harness: ProbeHarness): number {
    return harness.audioProbe.mock.calls.filter(([ config ]) => config.numberOfChannels === SURROUND_CHANNEL_COUNT).length;
}

/** Counts the stereo decodes of a codec, leaving out its 5.1 probe. */
function countOutputProbes(harness: ProbeHarness, codec: string): number {
    return harness.nativeAudioOutputProbe.mock.calls.filter(([ probeRequest ]) => (
        probeRequest.configuration.codec === codec && probeRequest.configuration.numberOfChannels !== SURROUND_CHANNEL_COUNT
    )).length;
}

describe('capability probe warm-up', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('waits for an idle period before starting a probe and before each heavy step', async () => {
        const harness = createHarness();
        const idleGate = createIdleGate();
        createProbe(harness, { waitForIdle: idleGate.waitForIdle }).warmUp();
        await vi.advanceTimersByTimeAsync(0);

        expect(harness.audioProbe).not.toHaveBeenCalled();

        // The first idle period starts the audio probe, whose configuration checks run while each decode waits for its own
        idleGate.release();
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.audioProbe).toHaveBeenCalled();
        expect(harness.nativeAudioOutputProbe).not.toHaveBeenCalled();

        idleGate.release();
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.nativeAudioOutputProbe).toHaveBeenCalledOnce();

        idleGate.release();
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.nativeAudioOutputProbe).toHaveBeenCalledTimes(2);
    });

    it('starts nothing while media plays, and continues once it stops', async () => {
        const harness = createHarness();
        let playing = true;
        createProbe(harness, { isPlaybackActive: () => playing }).warmUp();

        await vi.advanceTimersByTimeAsync(10 * BACKGROUND_PROBE_RECHECK_MILLISECONDS);
        expect(harness.audioProbe).not.toHaveBeenCalled();

        playing = false;
        await vi.advanceTimersByTimeAsync(BACKGROUND_PROBE_RECHECK_MILLISECONDS);
        expect(harness.audioProbe).toHaveBeenCalled();
    });

    it('downloads its vectors at low priority', async () => {
        const harness = createHarness();
        createProbe(harness).warmUp();

        await vi.runAllTimersAsync();

        expect(harness.vectorLoader).toHaveBeenCalled();
        expect(new Set(harness.vectorLoader.mock.calls.map(([ , priority ]) => priority))).toEqual(new Set([ 'low' ]));
    });

    it('is promoted when a negotiation needs a probe it started, and shares its run', async () => {
        const harness = createHarness();
        const idleGate = createIdleGate();
        const probe = createProbe(harness, { waitForIdle: idleGate.waitForIdle });
        probe.warmUp();
        await vi.advanceTimersByTimeAsync(0);
        idleGate.release();
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.nativeAudioOutputProbe).not.toHaveBeenCalled();

        // No idle period comes, so the negotiation resolves only if the promotion lifts the gate
        const capabilities = await probe.probe(MPEG2_ITEM);

        expect(capabilities.audio.aac).toMatchObject({ status: 'supported' });
        expect(capabilities.nativeSurroundAudio?.aac).toMatchObject({ status: 'supported' });
        expect(harness.audioProbe).toHaveBeenCalledTimes(AUDIO_CONFIGURATION_COUNT);
        expect(countOutputProbes(harness, AAC_CODEC_STRING)).toBe(1);
    });

    it('holds its later probes while a negotiation runs and after it settles', async () => {
        const harness = createHarness();
        const probe = createProbe(harness);
        await probe.probe(MPEG2_ITEM);
        harness.videoProbe.mockClear();
        probe.warmUp();

        await vi.advanceTimersByTimeAsync(BACKGROUND_PROBE_NEGOTIATION_HOLD_MILLISECONDS - BACKGROUND_PROBE_RECHECK_MILLISECONDS);
        expect(harness.videoProbe).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(2 * BACKGROUND_PROBE_RECHECK_MILLISECONDS);
        expect(harness.videoProbe).toHaveBeenCalled();
    });

    it('keeps a background timeout out of the scheduler and the page result, and a negotiation reruns it', async () => {
        const harness = createHarness();
        // The first AAC decode never finishes; every later decode does
        harness.nativeAudioOutputProbe.mockImplementationOnce(() => new Promise<boolean>(() => undefined));
        const probe = createProbe(harness);
        probe.warmUp();
        await vi.advanceTimersByTimeAsync(0);
        expect(countOutputProbes(harness, AAC_CODEC_STRING)).toBe(1);

        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);
        await vi.advanceTimersByTimeAsync(10 * BACKGROUND_PROBE_RECHECK_MILLISECONDS);

        // The timeout halts the background: no later decode starts, and no other probe begins
        expect(harness.nativeAudioOutputProbe).toHaveBeenCalledOnce();
        expect(countSurroundConfigurations(harness)).toBe(0);
        expect(harness.videoProbe).not.toHaveBeenCalled();

        const capabilities = await probe.probe(MPEG2_ITEM);

        // A poisoned scheduler would answer probe-timeout for every codec, and a kept background result would keep AAC's
        expect(capabilities.audio.aac).toMatchObject({ status: 'supported' });
        expect(capabilities.audio.opus).toMatchObject({ status: 'supported' });
        expect(capabilities.nativeSurroundAudio?.aac).toMatchObject({ status: 'supported' });
        expect(countOutputProbes(harness, AAC_CODEC_STRING)).toBe(2);
    });

    it('is skipped on a client that asks to save data or has few threads', () => {
        vi.stubGlobal('navigator', { connection: { saveData: true }, hardwareConcurrency: 16 });
        expect(warmCustomDecodeCapabilities()).toBe(false);

        vi.stubGlobal('navigator', { hardwareConcurrency: 2 });
        expect(warmCustomDecodeCapabilities()).toBe(false);
    });
});

describe('stored capability probe verdicts', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('answer a later page at once, without a decoder call', async () => {
        const storage = createMemoryStorage();
        await createProbe(createHarness(), { store: createStore(storage) }).probe(HEVC_ITEM);
        const laterHarness = createHarness();

        const capabilities = await createProbe(laterHarness, { store: createStore(storage), waitForIdle: createIdleGate().waitForIdle }).probe(HEVC_ITEM);

        expect(laterHarness.audioProbe).not.toHaveBeenCalled();
        expect(laterHarness.videoProbe).not.toHaveBeenCalled();
        expect(capabilities.video.hevc).toMatchObject({ status: 'supported' });
        expect(capabilities.audio.aac).toMatchObject({ status: 'supported' });
    });

    it('merge the probes of each item a page negotiates', async () => {
        const storage = createMemoryStorage();
        const store = createStore(storage);
        const probe = createProbe(createHarness(), { store });

        await probe.probe(HEVC_ITEM);
        await probe.probe(VP8_ITEM);

        expect(store.readState()?.probes).toEqual(expect.arrayContaining([
            'native-audio',
            'native-sdr:hevc',
            'native-sdr:vp8',
            'native-surround-audio',
            'native-ultra-hd:hevc'
        ]));
    });

    it('never keep an unknown result', async () => {
        const storage = createMemoryStorage();
        const store = createStore(storage);
        const harness = createHarness();
        harness.nativeVideoOutputProbe.mockRejectedValue(new Error('decoder crashed'));

        const capabilities = await createProbe(harness, { store }).probe(HEVC_ITEM);

        expect(capabilities.video.hevc).toMatchObject({ status: 'unknown' });
        expect(store.readState()?.probes).not.toContain('native-sdr:hevc');
        expect(store.readState()?.probes).toContain('native-audio');
    });

    it('rerun in the background after the negotiation and playback, and overwrite what they find', async () => {
        const storage = createMemoryStorage();
        await createProbe(createHarness(), { store: createStore(storage) }).probe(HEVC_ITEM);
        // A driver update now fails HEVC decode, which no fingerprint shows
        const laterHarness = createHarness(false);
        let playing = false;
        const store = createStore(storage);
        const probe = createProbe(laterHarness, { isPlaybackActive: () => playing, store });

        expect((await probe.probe(HEVC_ITEM)).video.hevc).toMatchObject({ status: 'supported' });
        playing = true;
        await vi.advanceTimersByTimeAsync(2 * BACKGROUND_PROBE_NEGOTIATION_HOLD_MILLISECONDS);
        expect(laterHarness.videoProbe).not.toHaveBeenCalled();

        playing = false;
        await vi.runAllTimersAsync();

        expect(laterHarness.videoProbe).toHaveBeenCalled();
        expect(await store.read('native-sdr:hevc')).toMatchObject({ status: 'unsupported' });
        expect((await probe.probe(HEVC_ITEM)).video.hevc).toMatchObject({ status: 'unsupported' });
    });

    it('are dropped after a start they admitted fails, so the next negotiation probes again', async () => {
        const storage = createMemoryStorage();
        await createProbe(createHarness(), { store: createStore(storage) }).probe(HEVC_ITEM);
        const laterHarness = createHarness(false);
        const store = createStore(storage);
        const probe = createProbe(laterHarness, { store, waitForIdle: createIdleGate().waitForIdle });
        expect((await probe.probe(HEVC_ITEM)).video.hevc).toMatchObject({ status: 'supported' });

        expect(store.clearAfterStartFailure()).toBe(true);
        const renegotiated = await probe.probe(HEVC_ITEM);

        expect(storage.entries.size).toBe(1);
        expect(laterHarness.videoProbe).toHaveBeenCalled();
        expect(renegotiated.video.hevc).toMatchObject({ status: 'unsupported' });
        expect(await store.read('native-sdr:hevc')).toMatchObject({ status: 'unsupported' });
    });
});
