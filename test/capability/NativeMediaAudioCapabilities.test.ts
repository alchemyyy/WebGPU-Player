import { describe, expect, it, vi } from 'vitest';

import {
    default as NativeMediaAudioCapabilityProbe,
    getSupportedNativeMediaAudioRoute,
    NATIVE_MEDIA_AUDIO_PROBE,
    probeNativeMediaAudioCapabilities,
    type NativeMediaAudioExactProbeRequest,
    type NativeMediaAudioExactProbeResult
} from 'webgpu-player/capability/NativeMediaAudioCapabilities';
import { createNativeMediaAudioProbeVector } from 'webgpu-player/capability/vectors/NativeMediaAudioCapabilityVectors';

import { createCapabilityProbeSession, createRecordingStore } from '../helpers/capabilityProbeSession';

const PLAYBACK_STEPS = [ 'play ac-3 2ch 48000Hz', 'play ac-3 6ch 48000Hz', 'play ec-3 2ch 48000Hz', 'play ec-3 6ch 48000Hz' ];

function advancedPlayback(): Promise<NativeMediaAudioExactProbeResult> {
    return Promise.resolve({ reason: 'decoded-playback-advanced', supported: true });
}

describe('NativeMediaAudioCapabilities', () => {
    it('ships fresh exact fMP4 vectors for every qualified layout', () => {
        for (const codec of [ 'ac3', 'eac3' ] as const) {
            for (const channelCount of [ 2, 6 ] as const) {
                const firstVector = createNativeMediaAudioProbeVector(codec, channelCount);
                const secondVector = createNativeMediaAudioProbeVector(codec, channelCount);
                expect(firstVector).not.toBe(secondVector);
                expect(firstVector.byteLength).toBeGreaterThan(1_000);
                expect(Array.from(firstVector.slice(4, 8))).toEqual([
                    'f'.charCodeAt(0),
                    't'.charCodeAt(0),
                    'y'.charCodeAt(0),
                    'p'.charCodeAt(0)
                ]);
                firstVector[0] = 0xFF;
                expect(secondVector[0]).not.toBe(0xFF);
            }
        }
    });

    it('reports unknown routes when MSE capability discovery is unavailable', async () => {
        const exactPlaybackProbe = vi.fn();
        const capabilities = await probeNativeMediaAudioCapabilities({
            exactPlaybackProbe,
            isTypeSupported: null,
            session: createCapabilityProbeSession()
        });

        expect(exactPlaybackProbe).not.toHaveBeenCalled();
        expect(capabilities.audio.ac3.status).toBe('unknown');
        expect(capabilities.audio.eac3.layouts[6]).toMatchObject({
            reason: 'api-unavailable',
            status: 'unknown'
        });
        expect(capabilities.telemetry).toEqual({
            probeCount: 0,
            supportedLayoutCount: 0,
            unknownLayoutCount: 4
        });
    });

    it('does not run vectors for MIME types rejected by MediaSource', async () => {
        const exactPlaybackProbe = vi.fn();
        const capabilities = await probeNativeMediaAudioCapabilities({
            exactPlaybackProbe,
            isTypeSupported: () => false,
            session: createCapabilityProbeSession()
        });

        expect(exactPlaybackProbe).not.toHaveBeenCalled();
        expect(capabilities.audio.ac3.layouts[2]).toMatchObject({
            reason: 'mime-unsupported',
            status: 'unsupported'
        });
        expect(capabilities.audio.eac3.status).toBe('unsupported');
    });

    it('supports only exact layouts whose vector playback advances', async () => {
        const probeInputs: NativeMediaAudioExactProbeRequest[] = [];
        const capabilities = await probeNativeMediaAudioCapabilities({
            exactPlaybackProbe: async probeInput => {
                probeInputs.push(probeInput);
                const supported = probeInput.codec === 'eac3' && probeInput.channelCount === 6;
                return {
                    reason: supported ? 'decoded-playback-advanced' : 'playback-not-advanced',
                    supported
                };
            },
            isTypeSupported: () => true,
            session: createCapabilityProbeSession()
        });

        // Every playback started beside the others, so each failed one played once more alone before it counted
        const playedLayouts = probeInputs.map(probeInput => `${probeInput.codec}:${probeInput.channelCount}`);
        expect([ ...playedLayouts ].sort((first, second) => first.localeCompare(second)))
            .toEqual([ 'ac3:2', 'ac3:2', 'ac3:6', 'ac3:6', 'eac3:2', 'eac3:2', 'eac3:6' ]);
        expect(probeInputs.every(probeInput => probeInput.vector.byteLength > 1_000)).toBe(true);
        expect(capabilities.audio.ac3.status).toBe('unsupported');
        expect(capabilities.audio.eac3.status).toBe('supported');
        expect(capabilities.audio.eac3.layouts[6]).toMatchObject({
            codecString: 'ec-3',
            mimeType: 'audio/mp4; codecs="ec-3"',
            reason: 'decoded-playback-advanced',
            status: 'supported'
        });
        expect(capabilities.telemetry).toEqual({
            probeCount: 4,
            supportedLayoutCount: 1,
            unknownLayoutCount: 0
        });

        expect(getSupportedNativeMediaAudioRoute(capabilities, 'eac3', 6, 48_000)).toEqual({
            channelCount: 6,
            codec: 'eac3',
            codecString: 'ec-3',
            mimeType: 'audio/mp4; codecs="ec-3"',
            sampleRate: 48_000
        });
        expect(getSupportedNativeMediaAudioRoute(capabilities, 'eac3', 2, 48_000)).toBeNull();
        expect(getSupportedNativeMediaAudioRoute(capabilities, 'eac3', 6, 44_100)).toBeNull();
        expect(getSupportedNativeMediaAudioRoute(capabilities, 'eac3', 8, 48_000)).toBeNull();
    });

    it('starts exact layout probes concurrently and caches the aggregate result', async () => {
        const pendingResolvers: Array<(result: {
            reason: 'decoded-playback-advanced'
            supported: true
        }) => void> = [];
        const exactPlaybackProbe = vi.fn(() => new Promise<{
            reason: 'decoded-playback-advanced'
            supported: true
        }>(resolve => {
            pendingResolvers.push(resolve);
        }));
        const probe = new NativeMediaAudioCapabilityProbe({
            exactPlaybackProbe,
            isTypeSupported: () => true,
            session: createCapabilityProbeSession()
        });

        const firstResult = probe.probe();
        const secondResult = probe.probe();
        await vi.waitFor(() => expect(exactPlaybackProbe).toHaveBeenCalledTimes(4));
        expect(firstResult).toBe(secondResult);
        for (const resolve of pendingResolvers) {
            resolve({ reason: 'decoded-playback-advanced', supported: true });
        }

        await expect(firstResult).resolves.toMatchObject({
            telemetry: { probeCount: 4, supportedLayoutCount: 4 }
        });
        expect(probe.probe()).toBe(firstResult);
    });

    it('keeps probe exceptions unknown instead of advertising the route', async () => {
        const capabilities = await probeNativeMediaAudioCapabilities({
            exactPlaybackProbe: () => Promise.reject(new Error('probe failed')),
            isTypeSupported: () => true,
            session: createCapabilityProbeSession()
        });

        expect(capabilities.audio.ac3.status).toBe('unknown');
        expect(capabilities.audio.eac3.status).toBe('unknown');
        expect(capabilities.telemetry.unknownLayoutCount).toBe(4);
    });

    it('records each layout\'s playback as a step of its own, holding one decoder and the PCM it buffers', async () => {
        const recordingStore = createRecordingStore();

        await probeNativeMediaAudioCapabilities({
            exactPlaybackProbe: advancedPlayback,
            isTypeSupported: () => true,
            session: createCapabilityProbeSession({ store: recordingStore.store })
        });

        const calls = recordingStore.markRunning.mock.calls;
        expect(calls.map(([ probe ]) => probe)).toEqual(PLAYBACK_STEPS.map(() => NATIVE_MEDIA_AUDIO_PROBE));
        expect(new Set(calls.map(([ , step ]) => step))).toEqual(new Set(PLAYBACK_STEPS));
        for (const [ , step, cost ] of calls) {
            const channelCount = step.includes('6ch') ? 6 : 2;
            expect(cost.decoders).toBe(1);
            expect(cost.bytes).toBeGreaterThan(0);
            // f32 samples of every channel
            expect(cost.bytes % (channelCount * Float32Array.BYTES_PER_ELEMENT)).toBe(0);
        }
    });

    it('reads a playback a crash blocked as unsupported, without playing it', async () => {
        const exactPlaybackProbe = vi.fn<(probeInput: Readonly<NativeMediaAudioExactProbeRequest>) => Promise<NativeMediaAudioExactProbeResult>>(advancedPlayback);

        const capabilities = await probeNativeMediaAudioCapabilities({
            exactPlaybackProbe,
            isTypeSupported: () => true,
            session: createCapabilityProbeSession({ store: createRecordingStore({ blocked: new Set([ 'play ec-3 6ch 48000Hz' ]) }).store })
        });

        expect(capabilities.audio.eac3.layouts[6]).toMatchObject({ reason: 'stopped-page', status: 'unsupported' });
        expect(capabilities.audio.eac3.layouts[2]).toMatchObject({ status: 'supported' });
        expect(exactPlaybackProbe.mock.calls.map(([ probeInput ]) => `${probeInput.codec}:${probeInput.channelCount}`)).not.toContain('eac3:6');
        expect(exactPlaybackProbe).toHaveBeenCalledTimes(PLAYBACK_STEPS.length - 1);
    });

    it('plays within the session manager\'s limits', async () => {
        let playing = 0;
        let mostPlaying = 0;
        const exactPlaybackProbe = vi.fn(async (): Promise<NativeMediaAudioExactProbeResult> => {
            playing += 1;
            mostPlaying = Math.max(mostPlaying, playing);
            await Promise.resolve();
            playing -= 1;
            return advancedPlayback();
        });

        await probeNativeMediaAudioCapabilities({
            exactPlaybackProbe,
            isTypeSupported: () => true,
            session: createCapabilityProbeSession({ limits: { bytes: Number.MAX_SAFE_INTEGER, decoders: 1 } })
        });

        expect(exactPlaybackProbe).toHaveBeenCalledTimes(PLAYBACK_STEPS.length);
        expect(mostPlaying).toBe(1);
    });
});
