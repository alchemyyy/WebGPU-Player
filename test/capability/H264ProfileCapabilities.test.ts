import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import H264ProfileCapabilityProbe, {
    createH264ProfileOutputProbe,
    getH264ProfileFromJellyfinValue,
    getSupportedH264JellyfinProfileNames,
    H264_JELLYFIN_PROFILE_NAMES,
    H264_PROFILE_OUTPUT_PROBE_TIMEOUT_MILLISECONDS,
    H264_PROFILE_PROBE_CODED_HEIGHT,
    H264_PROFILE_PROBE_CODED_WIDTH,
    H264_PROFILES,
    supportsH264JellyfinProfile,
    type H264ProbeDecodedFrame,
    type H264ProbeDecoder,
    type H264ProbeDecoderCallbacks,
    type H264ProfileCapabilityEnvironment,
    type H264ProfileOutputProbeRequest
} from 'webgpu-player/capability/H264ProfileCapabilities';
import type { RecordedCapabilityProbeQueue } from 'webgpu-player/capability/CapabilityProbeSession';

import {
    CAPABILITY_PROBE_TIMEOUT_MILLISECONDS,
    createCapabilityProbeSession,
    createRecordedQueue,
    createRecordingStore
} from '../helpers/capabilityProbeSession';

const H264_PROBE = 'h264-profiles';

type ProfileProbeHarness = {
    configurationProbe: Mock
    environment: H264ProfileCapabilityEnvironment
    outputProbe: Mock
};

const PROFILE_CODEC_STRINGS = [
    'avc1.42C028',
    'avc1.420028',
    'avc1.4D0028',
    'avc1.640028'
];

function createHarness(
    supportedCodecs: ReadonlySet<string>,
    matchingOutputs: ReadonlySet<string> = supportedCodecs
): ProfileProbeHarness {
    const configurationProbe = vi.fn(async (configuration: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({
        config: configuration,
        supported: supportedCodecs.has(configuration.codec)
    }));
    const outputProbe = vi.fn(async (
        probeRequest: H264ProfileOutputProbeRequest
    ): Promise<boolean> => matchingOutputs.has(probeRequest.configuration.codec));
    return {
        configurationProbe,
        environment: {
            outputProbe,
            videoDecoder: { isConfigSupported: configurationProbe }
        },
        outputProbe
    };
}

function createQueue(): Promise<RecordedCapabilityProbeQueue> {
    return createRecordedQueue(createCapabilityProbeSession(), H264_PROBE);
}

function createOutputProbeRequest(): H264ProfileOutputProbeRequest {
    return {
        configuration: {
            codec: 'avc1.640028',
            codedHeight: H264_PROFILE_PROBE_CODED_HEIGHT,
            codedWidth: H264_PROFILE_PROBE_CODED_WIDTH
        },
        encodedKeyFrame: new Uint8Array([ 0x00, 0x00, 0x00, 0x01 ]),
        expectedCodedHeight: 16,
        expectedCodedWidth: 16,
        expectedDisplayHeight: 16,
        expectedDisplayWidth: 16,
        expectedTimestamp: 0,
        profile: 'high'
    };
}

describe('H264ProfileCapabilityProbe', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('probes and decodes every exact 1080p profile independently', async () => {
        const harness = createHarness(new Set(PROFILE_CODEC_STRINGS));
        const capabilities = await new H264ProfileCapabilityProbe(harness.environment).probe(await createQueue());

        expect(harness.configurationProbe.mock.calls.map(call => call[0])).toEqual(
            PROFILE_CODEC_STRINGS.map(codec => ({
                codec,
                codedHeight: 1_080,
                codedWidth: 1_920,
                hardwareAcceleration: 'no-preference',
                optimizeForLatency: true
            }))
        );
        expect(harness.outputProbe.mock.calls.map(call => call[0].profile)).toEqual(H264_PROFILES);
        for (const call of harness.outputProbe.mock.calls) {
            expect(call[0]).toMatchObject({
                expectedCodedHeight: 64,
                expectedCodedWidth: 64,
                expectedDisplayHeight: 64,
                expectedDisplayWidth: 64,
                expectedTimestamp: 0
            });
        }
        expect(harness.outputProbe.mock.calls.map(call => call[0].encodedKeyFrame[5])).toEqual([
            0x42,
            0x42,
            0x4D,
            0x64
        ]);
        expect(harness.outputProbe.mock.calls.map(call => call[0].encodedKeyFrame[6])).toEqual([
            0xC0,
            0x00,
            0x00,
            0x00
        ]);

        for (const profile of H264_PROFILES) {
            expect(capabilities[profile]).toEqual({
                codecString: PROFILE_CODEC_STRINGS[H264_PROFILES.indexOf(profile)],
                codedHeight: 1_080,
                codedWidth: 1_920,
                evidence: 'decoded-output',
                jellyfinProfileName: H264_JELLYFIN_PROFILE_NAMES[profile],
                profile,
                reason: 'decode-output-verified',
                status: 'supported'
            });
            expect(Object.isFrozen(capabilities[profile])).toBe(true);
        }
        expect(Object.isFrozen(capabilities)).toBe(true);
        expect(Object.isFrozen(H264_JELLYFIN_PROFILE_NAMES)).toBe(true);
        expect(H264_JELLYFIN_PROFILE_NAMES).toEqual({
            'constrained-baseline': 'constrained baseline',
            baseline: 'baseline',
            high: 'high',
            main: 'main'
        });
    });

    it('maps Jellyfin profile spellings and rejects ambiguous values', () => {
        expect(getH264ProfileFromJellyfinValue('Constrained Baseline')).toBe('constrained-baseline');
        expect(getH264ProfileFromJellyfinValue('constrained-baseline')).toBe('constrained-baseline');
        expect(getH264ProfileFromJellyfinValue('Baseline')).toBe('baseline');
        expect(getH264ProfileFromJellyfinValue('main')).toBe('main');
        expect(getH264ProfileFromJellyfinValue('HIGH')).toBe('high');
        expect(getH264ProfileFromJellyfinValue('High 10')).toBeNull();
        expect(getH264ProfileFromJellyfinValue('')).toBeNull();
        expect(getH264ProfileFromJellyfinValue(null)).toBeNull();
    });

    it('selects and checks only profiles with decoded-output evidence', async () => {
        const harness = createHarness(new Set(PROFILE_CODEC_STRINGS), new Set([ 'avc1.42C028', 'avc1.4D0028' ]));
        const capabilities = await new H264ProfileCapabilityProbe(harness.environment).probe(await createQueue());

        expect(getSupportedH264JellyfinProfileNames(capabilities)).toEqual([
            'constrained baseline',
            'main'
        ]);
        expect(supportsH264JellyfinProfile(capabilities, 'ConstrainedBaseline')).toBe(true);
        expect(supportsH264JellyfinProfile(capabilities, 'main')).toBe(true);
        expect(supportsH264JellyfinProfile(capabilities, 'baseline')).toBe(false);
        expect(supportsH264JellyfinProfile(capabilities, 'high')).toBe(false);
        expect(supportsH264JellyfinProfile(capabilities, 'unknown')).toBe(false);
    });

    it('keeps partial configuration and output support fail-closed', async () => {
        const harness = createHarness(new Set([ 'avc1.42C028', 'avc1.640028' ]), new Set([ 'avc1.42C028' ]));
        const capabilities = await new H264ProfileCapabilityProbe(harness.environment).probe(await createQueue());

        expect(capabilities['constrained-baseline']).toMatchObject({
            evidence: 'decoded-output',
            status: 'supported'
        });
        expect(capabilities.baseline).toMatchObject({
            evidence: 'configuration',
            reason: 'config-unsupported',
            status: 'unsupported'
        });
        expect(capabilities.main).toMatchObject({
            reason: 'config-unsupported',
            status: 'unsupported'
        });
        expect(capabilities.high).toMatchObject({
            evidence: 'configuration',
            reason: 'output-mismatch',
            status: 'unknown'
        });
        // High's mismatch came from a decode beside the other profiles' calls, so it decoded once more alone before it counted;
        // the refused configurations were checked once, as a check is never confirmed
        expect(harness.outputProbe.mock.calls.map(([ probeRequest ]) => probeRequest.profile)).toEqual([ 'constrained-baseline', 'high', 'high' ]);
        expect(harness.configurationProbe).toHaveBeenCalledTimes(H264_PROFILES.length);
    });

    it('does not claim support from configuration evidence alone', async () => {
        const harness = createHarness(new Set(PROFILE_CODEC_STRINGS));
        const capabilities = await new H264ProfileCapabilityProbe({
            outputProbe: null,
            videoDecoder: harness.environment.videoDecoder
        }).probe(await createQueue());

        for (const profile of H264_PROFILES) {
            expect(capabilities[profile]).toMatchObject({
                evidence: 'configuration',
                reason: 'config-supported-only',
                status: 'unknown'
            });
        }
    });

    it('reports unavailable APIs as unknown without starting output probes', async () => {
        const outputProbe = vi.fn(async (): Promise<boolean> => true);
        const capabilities = await new H264ProfileCapabilityProbe({
            outputProbe,
            videoDecoder: null
        }).probe(await createQueue());

        for (const profile of H264_PROFILES) {
            expect(capabilities[profile]).toMatchObject({
                evidence: 'none',
                reason: 'api-unavailable',
                status: 'unknown'
            });
        }
        expect(outputProbe).not.toHaveBeenCalled();
    });

    it('reads a configuration check the manager times out as a timeout, without a decode', async () => {
        vi.useFakeTimers();
        const configurationProbe = vi.fn(() => new Promise<VideoDecoderSupport>(() => undefined));
        const outputProbe = vi.fn(async (): Promise<boolean> => true);
        const probePromise = new H264ProfileCapabilityProbe({
            outputProbe,
            videoDecoder: { isConfigSupported: configurationProbe }
        }).probe(await createQueue());

        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);
        const capabilities = await probePromise;

        for (const profile of H264_PROFILES) {
            expect(capabilities[profile]).toMatchObject({
                evidence: 'none',
                reason: 'probe-timeout',
                status: 'unknown'
            });
        }
        expect(configurationProbe).toHaveBeenCalledTimes(H264_PROFILES.length);
        expect(outputProbe).not.toHaveBeenCalled();
    });

    it('reads a decode the manager times out as a timeout with configuration evidence', async () => {
        vi.useFakeTimers();
        const configurationProbe = vi.fn(async (
            configuration: VideoDecoderConfig
        ): Promise<VideoDecoderSupport> => ({ config: configuration, supported: true }));
        const outputProbe = vi.fn((): Promise<boolean> => new Promise<boolean>(() => undefined));
        const probePromise = new H264ProfileCapabilityProbe({
            outputProbe,
            videoDecoder: { isConfigSupported: configurationProbe }
        }).probe(await createQueue());

        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);
        const capabilities = await probePromise;

        expect(outputProbe).toHaveBeenCalledTimes(H264_PROFILES.length);
        for (const profile of H264_PROFILES) {
            expect(capabilities[profile]).toMatchObject({
                evidence: 'configuration',
                reason: 'probe-timeout',
                status: 'unknown'
            });
        }
    });

    it('runs each profile\'s check and decode as steps of their own, admitted side by side', async () => {
        const recordingStore = createRecordingStore();
        const session = createCapabilityProbeSession({ store: recordingStore.store });
        const pendingChecks: Array<() => void> = [];
        const harness = createHarness(new Set(PROFILE_CODEC_STRINGS));
        harness.configurationProbe.mockImplementation((configuration: VideoDecoderConfig) => new Promise<VideoDecoderSupport>((resolve) => {
            pendingChecks.push(() => resolve({ config: configuration, supported: true }));
        }));
        const probePromise = new H264ProfileCapabilityProbe(harness.environment).probe(await createRecordedQueue(session, H264_PROBE));

        await vi.waitFor(() => {
            expect(pendingChecks).toHaveLength(H264_PROFILES.length);
        });
        // Every profile's check is in flight before any settles
        expect(recordingStore.inFlight()).toHaveLength(H264_PROFILES.length);
        expect(new Set(recordingStore.inFlight())).toEqual(new Set(PROFILE_CODEC_STRINGS.map(codec => `check ${codec} 1920x1080`)));
        for (const resolveCheck of pendingChecks) {
            resolveCheck();
        }
        await probePromise;

        expect(recordingStore.markRunning.mock.calls.map(([ probe ]) => probe)).toEqual(Array(2 * H264_PROFILES.length).fill(H264_PROBE));
        expect(new Set(recordingStore.markRunning.mock.calls.map(([ , step ]) => step))).toEqual(new Set(PROFILE_CODEC_STRINGS.flatMap(codec => [
            `check ${codec} 1920x1080`,
            `decode ${codec} 1920x1080`
        ])));
    });

    it('reads a profile step a crash blocked as unsupported, without calling the browser', async () => {
        const recordingStore = createRecordingStore({ blocked: new Set([ 'decode avc1.640028 1920x1080', 'check avc1.4D0028 1920x1080' ]) });
        const session = createCapabilityProbeSession({ store: recordingStore.store });
        const harness = createHarness(new Set(PROFILE_CODEC_STRINGS));

        const capabilities = await new H264ProfileCapabilityProbe(harness.environment).probe(await createRecordedQueue(session, H264_PROBE));

        expect(capabilities.high).toMatchObject({ evidence: 'configuration', reason: 'stopped-page', status: 'unsupported' });
        expect(capabilities.main).toMatchObject({ evidence: 'none', reason: 'stopped-page', status: 'unsupported' });
        expect(capabilities.baseline).toMatchObject({ reason: 'decode-output-verified', status: 'supported' });
        expect(harness.configurationProbe.mock.calls.map(([ configuration ]) => configuration.codec)).not.toContain('avc1.4D0028');
        expect(harness.outputProbe.mock.calls.map(([ probeRequest ]) => probeRequest.profile)).not.toContain('high');
        expect(recordingStore.markRunning.mock.calls.map(([ , step ]) => step)).not.toContain('decode avc1.640028 1920x1080');
    });

    it('contains probe exceptions without hiding unaffected profiles', async () => {
        const harness = createHarness(new Set(PROFILE_CODEC_STRINGS));
        harness.configurationProbe.mockImplementation(async (configuration: VideoDecoderConfig): Promise<VideoDecoderSupport> => {
            if (configuration.codec === 'avc1.420028') {
                throw new DOMException('Capability API failed', 'OperationError');
            }
            return { config: configuration, supported: true };
        });
        harness.outputProbe.mockImplementation(async (probeRequest: H264ProfileOutputProbeRequest): Promise<boolean> => {
            if (probeRequest.profile === 'main') {
                throw new TypeError('Decoder construction failed');
            }
            return true;
        });
        const capabilities = await new H264ProfileCapabilityProbe(harness.environment).probe(await createQueue());

        expect(capabilities.baseline).toMatchObject({
            evidence: 'none',
            reason: 'probe-exception',
            status: 'unknown'
        });
        expect(capabilities.main).toMatchObject({
            evidence: 'configuration',
            reason: 'probe-exception',
            status: 'unknown'
        });
        expect(capabilities.high.status).toBe('supported');
    });
});

describe('createH264ProfileOutputProbe', () => {
    it('accepts one decoded frame with the exact expected metadata', async () => {
        const frameClose = vi.fn();
        const decoderClose = vi.fn();
        const outputProbe = createH264ProfileOutputProbe({
            createDecoder: (callbacks: H264ProbeDecoderCallbacks): H264ProbeDecoder => ({
                close: decoderClose,
                configure: vi.fn(),
                decode: (): void => callbacks.output({
                    close: frameClose,
                    codedHeight: 16,
                    codedWidth: 16,
                    displayHeight: 16,
                    displayWidth: 16,
                    timestamp: 0
                }),
                flush: async (): Promise<void> => undefined
            }),
            createEncodedKeyFrame: (): unknown => ({})
        });

        const outputMatches = await outputProbe(createOutputProbeRequest());

        expect(outputMatches).toBe(true);
        expect(frameClose).toHaveBeenCalledOnce();
        expect(decoderClose).toHaveBeenCalledOnce();
    });

    it('verifies exact output metadata and closes mismatched frames and decoders', async () => {
        const frameClose = vi.fn();
        const decoderClose = vi.fn();
        let receivedChunk: unknown = null;
        const outputProbe = createH264ProfileOutputProbe({
            createDecoder: (callbacks: H264ProbeDecoderCallbacks) => ({
                close: decoderClose,
                configure: vi.fn(),
                decode: (chunk: unknown): void => {
                    receivedChunk = chunk;
                    const frame: H264ProbeDecodedFrame = {
                        close: frameClose,
                        codedHeight: 16,
                        codedWidth: 15,
                        displayHeight: 16,
                        displayWidth: 16,
                        timestamp: 0
                    };
                    callbacks.output(frame);
                },
                flush: async (): Promise<void> => undefined
            }),
            createEncodedKeyFrame: (data: Uint8Array): unknown => ({ data })
        });

        const outputMatches = await outputProbe(createOutputProbeRequest());

        expect(outputMatches).toBe(false);
        expect(receivedChunk).toEqual({ data: new Uint8Array([ 0x00, 0x00, 0x00, 0x01 ]) });
        expect(frameClose).toHaveBeenCalledOnce();
        expect(decoderClose).toHaveBeenCalledOnce();
    });

    it('closes every extra frame and rejects ambiguous multi-frame output', async () => {
        const frameClose = vi.fn();
        const decoderClose = vi.fn();
        const outputProbe = createH264ProfileOutputProbe({
            createDecoder: (callbacks: H264ProbeDecoderCallbacks) => ({
                close: decoderClose,
                configure: vi.fn(),
                decode: (): void => {
                    const createFrame = (): H264ProbeDecodedFrame => ({
                        close: frameClose,
                        codedHeight: 16,
                        codedWidth: 16,
                        displayHeight: 16,
                        displayWidth: 16,
                        timestamp: 0
                    });
                    callbacks.output(createFrame());
                    callbacks.output(createFrame());
                },
                flush: async (): Promise<void> => undefined
            }),
            createEncodedKeyFrame: (): unknown => ({})
        });

        const outputMatches = await outputProbe(createOutputProbeRequest());

        expect(outputMatches).toBe(false);
        expect(frameClose).toHaveBeenCalledTimes(2);
        expect(decoderClose).toHaveBeenCalledOnce();
    });

    it('closes the decoder of a stalled decode once its bound passes, so the call settles', async () => {
        vi.useFakeTimers();
        try {
            const decoderClose = vi.fn();
            const outputProbe = createH264ProfileOutputProbe({
                createDecoder: (): H264ProbeDecoder => ({
                    close: decoderClose,
                    configure: vi.fn(),
                    decode: vi.fn(),
                    flush: () => new Promise<void>(() => undefined)
                }),
                createEncodedKeyFrame: (): unknown => ({})
            });
            const outputPromise = outputProbe(createOutputProbeRequest());
            const settled = expect(outputPromise).rejects.toThrow('timed out');

            await vi.advanceTimersByTimeAsync(H264_PROFILE_OUTPUT_PROBE_TIMEOUT_MILLISECONDS);

            await settled;
            expect(decoderClose).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('closes the decoder when the runtime reports a decode error', async () => {
        const decoderClose = vi.fn();
        const outputProbe = createH264ProfileOutputProbe({
            createDecoder: (callbacks: H264ProbeDecoderCallbacks): H264ProbeDecoder => ({
                close: decoderClose,
                configure: vi.fn(),
                decode: (): void => callbacks.error(new DOMException('Invalid H264 sample', 'EncodingError')),
                flush: async (): Promise<void> => undefined
            }),
            createEncodedKeyFrame: (): unknown => ({})
        });

        await expect(outputProbe(createOutputProbeRequest())).rejects.toThrow('Invalid H264 sample');
        expect(decoderClose).toHaveBeenCalledOnce();
    });
});
