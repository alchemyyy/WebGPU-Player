import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import CustomDecodeCapabilityProbe, {
    createNativeAudioOutputProbe,
    createNativeDolbyVisionVideoOutputProbe,
    createNativeHDRVideoOutputProbe,
    createNativeVideoOutputProbe,
    createRawHDRVideoOutputProbe,
    CUSTOM_DECODE_AUDIO_PROBES,
    CUSTOM_DECODE_VIDEO_PROBES,
    CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS,
    CUSTOM_NATIVE_SURROUND_AUDIO_CODECS,
    CUSTOM_PACKAGE_AUDIO_CODECS,
    CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS,
    CUSTOM_RAW_HDR_VIDEO_CODECS,
    CUSTOM_VIDEO_CODECS,
    CUSTOM_WEB_CODECS_AUDIO_CODECS,
    hasProbedCustomDecodeSelection,
    isCustomPackageVideoCodec,
    selectCustomDecodeProbes,
    type CustomDecodeCapabilities,
    type NativeDolbyVisionVideoOutputProbeRequest,
    type NativeDolbyVisionVideoOutputProbeResult,
    type RawHDRVideoOutputProbeResult,
    type WebCodecsCapabilityEnvironment
} from 'webgpu-player/capability/CustomDecodeCapabilities';

type CapabilityEnvironmentHarness = {
    audioProbe: Mock
    environment: WebCodecsCapabilityEnvironment
    nativeAudioOutputProbe: Mock
    nativeDolbyVisionVideoOutputProbe: Mock
    nativeHDRVideoOutputProbe: Mock
    nativeVideoOutputProbe: Mock
    rawHDRVideoOutputProbe: Mock
    videoProbe: Mock
};

type NativeSurroundAudioSupport = Readonly<{
    configuration: ReadonlySet<string>
    output?: ReadonlySet<string>
}>;

const CAPABILITY_PROBE_TIMEOUT_MILLISECONDS = 2_000;
// The fingerprint of a zero-filled 4K I420P10 copy in its tight plane layout
const ZERO_UHD_I420P10_FRAME_FINGERPRINT = 667_501_752;
const UHD_I420P10_ALLOCATION_SIZE = 24_883_200;
const UHD_I420P10_PLANE_LAYOUTS: readonly PlaneLayout[] = [
    { offset: 0, stride: 7_680 },
    { offset: 16_588_800, stride: 3_840 },
    { offset: 20_736_000, stride: 3_840 }
];
// The spec rejects any non-RGB format in copy options, even the frame's own
const EXPLICIT_PLANAR_FORMAT_REJECTION_MESSAGE = 'I420P10 is unsupported in ParseVideoFrameCopyToOptions';
// The video codecs WebCodecs probes settle, and those only a GPU decoder package decodes
const WEB_CODECS_VIDEO_CODECS = [ 'h264', 'hevc', 'vp8', 'vp9', 'av1' ] as const;
const PACKAGE_VIDEO_CODECS = [ 'jpeg2000', 'mpeg1video', 'mpeg2video', 'vc1', 'wmv3' ] as const;
const JPEG2000_CODEC_STRING = 'mjp2';
// The raw HEVC probe, which an SDR HEVC item does not select
const RAW_HEVC_PROBE = 'raw:hevc';

function createEnvironment(
    videoSupport: ReadonlySet<string>,
    audioSupport: ReadonlySet<string>,
    rawHDRVideoOutputSupport: ReadonlySet<string> = new Set<string>(),
    nativeDolbyVisionVideoOutputSupported = false,
    nativeVideoOutputSupport: ReadonlySet<string> = videoSupport,
    nativeAudioOutputSupport: ReadonlySet<string> = audioSupport,
    nativeSurroundAudioSupport: NativeSurroundAudioSupport = {
        configuration: new Set<string>()
    }
): CapabilityEnvironmentHarness {
    const nativeSurroundAudioOutputSupport = nativeSurroundAudioSupport.output ?? nativeSurroundAudioSupport.configuration;
    const videoProbe = vi.fn(async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({
        config,
        supported: videoSupport.has(config.codec)
    }));
    const audioProbe = vi.fn(async (config: AudioDecoderConfig): Promise<AudioDecoderSupport> => ({
        config,
        supported: config.numberOfChannels === 6 ?
            nativeSurroundAudioSupport.configuration.has(config.codec) :
            audioSupport.has(config.codec)
    }));
    const rawHDRVideoOutputProbe = vi.fn(async (probeRequest: {
        codec: string
    }): Promise<RawHDRVideoOutputProbeResult> => {
        const outputCopySupported = rawHDRVideoOutputSupport.has(probeRequest.codec);
        return { outputCopySupported };
    });
    const nativeDolbyVisionVideoOutputProbe = vi.fn(async (): Promise<NativeDolbyVisionVideoOutputProbeResult> => ({
        outputSupported: nativeDolbyVisionVideoOutputSupported
    }));
    const nativeHDRVideoOutputProbe = vi.fn(async (): Promise<NativeDolbyVisionVideoOutputProbeResult> => ({
        outputSupported: false
    }));
    const nativeVideoOutputProbe = vi.fn(async (probeRequest: {
        configuration: VideoDecoderConfig
    }): Promise<boolean> => nativeVideoOutputSupport.has(probeRequest.configuration.codec));
    const nativeAudioOutputProbe = vi.fn(async (probeRequest: {
        configuration: AudioDecoderConfig
    }): Promise<boolean> => (
        probeRequest.configuration.numberOfChannels === 6 ?
            nativeSurroundAudioOutputSupport :
            nativeAudioOutputSupport
    ).has(probeRequest.configuration.codec));
    return {
        audioProbe,
        environment: {
            audioDecoder: { isConfigSupported: audioProbe },
            nativeAudioOutputProbe,
            nativeDolbyVisionVideoOutputProbe,
            nativeHDRVideoOutputProbe,
            nativeVideoOutputProbe,
            rawHDRVideoOutputProbe,
            videoDecoder: { isConfigSupported: videoProbe }
        },
        nativeAudioOutputProbe,
        nativeDolbyVisionVideoOutputProbe,
        nativeHDRVideoOutputProbe,
        nativeVideoOutputProbe,
        rawHDRVideoOutputProbe,
        videoProbe
    };
}

describe('CustomDecodeCapabilityProbe', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('serializes decoder-backed output probes', async () => {
        const harness = createEnvironment(new Set<string>(), new Set<string>());
        let activeHeavyProbeCount = 0;
        let heavyProbeInvocationCount = 0;
        let maximumActiveHeavyProbeCount = 0;
        const observeHeavyProbe = async <Value>(value: Value): Promise<Value> => {
            activeHeavyProbeCount += 1;
            heavyProbeInvocationCount += 1;
            maximumActiveHeavyProbeCount = Math.max(maximumActiveHeavyProbeCount, activeHeavyProbeCount);
            try {
                await Promise.resolve();
                return value;
            } finally {
                activeHeavyProbeCount -= 1;
            }
        };
        harness.environment.audioDecoder = {
            isConfigSupported: vi.fn(async (config: AudioDecoderConfig) => ({
                config,
                supported: true
            }))
        };
        harness.environment.videoDecoder = {
            isConfigSupported: vi.fn(async (config: VideoDecoderConfig) => ({
                config,
                supported: true
            }))
        };
        harness.environment.nativeAudioOutputProbe = vi.fn(() => observeHeavyProbe(true));
        harness.environment.nativeDolbyVisionVideoOutputProbe = vi.fn(
            () => observeHeavyProbe({
                outputSupported: true
            })
        );
        harness.environment.nativeHDRVideoOutputProbe = vi.fn(
            () => observeHeavyProbe({
                outputSupported: true
            })
        );
        harness.environment.nativeVideoOutputProbe = vi.fn(() => observeHeavyProbe(true));
        harness.environment.rawHDRVideoOutputProbe = vi.fn(
            () => observeHeavyProbe({
                outputCopySupported: true
            })
        );

        await new CustomDecodeCapabilityProbe(harness.environment).probe();

        expect(heavyProbeInvocationCount).toBeGreaterThan(20);
        expect(maximumActiveHeavyProbeCount).toBe(1);
    });

    it('does not start queued heavy probes after the active probe times out', async () => {
        vi.useFakeTimers();
        const supportedAudioCodecs = new Set([
            'mp4a.40.2',
            'opus',
            'flac',
            'mp3',
            'vorbis'
        ]);
        const harness = createEnvironment(new Set<string>(), supportedAudioCodecs);
        const nativeAudioOutputProbe = vi.fn((probeRequest: {
            configuration: AudioDecoderConfig
        }): Promise<boolean> => {
            if (probeRequest.configuration.codec === 'mp4a.40.2') {
                return new Promise<boolean>(() => undefined);
            }
            return Promise.resolve(true);
        });
        harness.environment.h264ProfileProbe = null;
        harness.environment.nativeAudioOutputProbe = nativeAudioOutputProbe;
        const probePromise = new CustomDecodeCapabilityProbe(harness.environment).probe();

        await vi.advanceTimersByTimeAsync(0);
        expect(nativeAudioOutputProbe).toHaveBeenCalledOnce();
        expect(nativeAudioOutputProbe.mock.calls[0][0].configuration.codec).toBe('mp4a.40.2');

        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);
        const capabilities = await probePromise;

        expect(nativeAudioOutputProbe).toHaveBeenCalledOnce();
        expect(capabilities.audio.aac).toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
        expect(capabilities.audio.opus).toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
        expect(capabilities.audio.flac.reason).toBe('probe-timeout');
    });

    it('does not create a native audio output probe without both WebCodecs APIs', () => {
        vi.stubGlobal('AudioDecoder', undefined);
        vi.stubGlobal('EncodedAudioChunk', class FakeEncodedAudioChunk {});
        expect(createNativeAudioOutputProbe()).toBeNull();

        vi.stubGlobal('AudioDecoder', class FakeAudioDecoder {});
        vi.stubGlobal('EncodedAudioChunk', undefined);
        expect(createNativeAudioOutputProbe()).toBeNull();
    });

    it('does not create a native HDR output probe without both WebCodecs APIs', () => {
        vi.stubGlobal('VideoDecoder', undefined);
        vi.stubGlobal('EncodedVideoChunk', class FakeEncodedVideoChunk {});
        expect(createNativeHDRVideoOutputProbe()).toBeNull();

        vi.stubGlobal('VideoDecoder', class FakeVideoDecoder {});
        vi.stubGlobal('EncodedVideoChunk', undefined);
        expect(createNativeHDRVideoOutputProbe()).toBeNull();
    });

    it('probes every representative WebCodecs configuration and records support', async () => {
        const harness = createEnvironment(
            new Set([
                'avc1.640028',
                'vp09.00.51.08',
                'vp09.02.10.10'
            ]),
            new Set([ 'mp4a.40.2', 'flac' ]),
            new Set([ 'vp9' ])
        );
        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        expect(harness.videoProbe.mock.calls.map(call => call[0].codec)).toEqual([
            'avc1.640028',
            'hvc1.1.6.L120.B0',
            'vp8',
            'vp09.00.10.08',
            'av01.0.08M.08',
            'hvc1.1.6.L153.B0',
            'vp09.00.51.08',
            'av01.0.12M.08',
            'hvc1.2.4.L153.B0',
            'vp09.02.10.10',
            'av01.0.08M.10',
            'hev1.2.4.H150.B0',
            'av01.0.08M.10',
            'hvc1.2.4.L153.B0'
        ]);
        expect(harness.audioProbe.mock.calls.map(call => call[0].codec)).toEqual([
            'mp4a.40.2',
            'opus',
            'flac',
            'mp3',
            'vorbis',
            'mp4a.40.2',
            'opus',
            'flac',
            'vorbis'
        ]);
        expect(harness.videoProbe.mock.calls[0][0]).toMatchObject({
            codedHeight: 1_080,
            codedWidth: 1_920,
            hardwareAcceleration: 'no-preference',
            optimizeForLatency: true
        });
        expect(harness.audioProbe.mock.calls[0][0]).toMatchObject({
            numberOfChannels: 2,
            sampleRate: 48_000
        });
        expect(harness.audioProbe.mock.calls[2][0].description).toBeInstanceOf(Uint8Array);
        expect(harness.audioProbe.mock.calls[4][0].description).toBeInstanceOf(Uint8Array);
        expect(capabilities.video.h264).toMatchObject({
            reason: 'config-supported',
            status: 'supported'
        });
        expect(capabilities.video.hevc).toMatchObject({
            reason: 'config-unsupported',
            status: 'unsupported'
        });
        expect(capabilities.video.vp9).toMatchObject({
            reason: 'config-unsupported',
            status: 'unsupported'
        });
        expect(capabilities.nativeDolbyVisionHEVC).toMatchObject({
            bitDepth: 10,
            profile: 5,
            reason: 'config-unsupported',
            status: 'unsupported'
        });
        expect(capabilities.nativeHDRHEVC).toMatchObject({
            bitDepth: 10,
            codecString: 'hvc1.2.4.L153.B0',
            reason: 'config-unsupported',
            status: 'unsupported'
        });
        expect(capabilities.nativeHDRAV1).toMatchObject({
            bitDepth: 10,
            codec: 'av1',
            codecString: 'av01.0.08M.10',
            reason: 'config-unsupported',
            status: 'unsupported'
        });
        expect(capabilities.h264Profiles).toBeDefined();
        expect(Object.values(capabilities.h264Profiles ?? {})).toHaveLength(4);
        for (const profileCapability of Object.values(capabilities.h264Profiles ?? {})) {
            expect(profileCapability).toMatchObject({
                reason: 'api-unavailable',
                status: 'unknown'
            });
        }
        expect(capabilities.audio.flac.status).toBe('supported');
        expect(capabilities.audio.ac3).toMatchObject({
            codecString: 'ac-3',
            reason: 'no-engine-decoder',
            status: 'unsupported'
        });
        expect(capabilities.audio.eac3).toMatchObject({
            codecString: 'ec-3',
            reason: 'no-engine-decoder',
            status: 'unsupported'
        });
        expect(capabilities.rawHDRVideo).toMatchObject({
            av1: { reason: 'config-unsupported', status: 'unsupported' },
            hevc: { reason: 'config-unsupported', status: 'unsupported' },
            vp9: {
                reason: 'output-copy-supported',
                status: 'supported'
            }
        });
        expect(harness.rawHDRVideoOutputProbe).toHaveBeenCalledOnce();
        expect(harness.rawHDRVideoOutputProbe.mock.calls[0][0]).toMatchObject({
            codec: 'vp9',
            configuration: {
                hardwareAcceleration: 'prefer-software'
            },
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840,
            expectedFormat: 'I420P10'
        });
        expect(harness.rawHDRVideoOutputProbe.mock.calls[0][0].encodedChunks[0].data).toHaveLength(2_957);
        expect(capabilities.telemetry).toEqual({
            audioProbeCount: 5,
            mediabunnyAudioCodecCount: CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS.length,
            nativeHDRVideoProbeCount: 2,
            nativeSurroundAudioProbeCount: 4,
            nativeUltraHDVideoProbeCount: 3,
            rawHDRVideoProbeCount: 3,
            reason: 'complete',
            supportedAudioCodecCount: CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS.length + 2,
            supportedNativeHDRVideoCodecCount: 0,
            supportedNativeSurroundAudioCodecCount: 0,
            supportedNativeUltraHDVideoCodecCount: 1,
            supportedRawHDRVideoCodecCount: 1,
            supportedVideoCodecCount: 1,
            unknownAudioCodecCount: 0,
            unknownNativeHDRVideoCodecCount: 0,
            unknownNativeSurroundAudioCodecCount: 0,
            unknownNativeUltraHDVideoCodecCount: 0,
            unknownVideoCodecCount: 0,
            videoProbeCount: 11
        });
        expect(capabilities.nativeUltraHDVideo).toMatchObject({
            av1: {
                reason: 'config-unsupported',
                status: 'unsupported'
            },
            hevc: {
                reason: 'config-unsupported',
                status: 'unsupported'
            },
            vp9: {
                bitDepth: 8,
                codecString: 'vp09.00.51.08',
                reason: 'decode-output-verified',
                status: 'supported'
            }
        });
    });

    it('names exactly the video codecs only a decoder package decodes', () => {
        const packageCodecs: readonly string[] = PACKAGE_VIDEO_CODECS;
        for (const codec of CUSTOM_VIDEO_CODECS) {
            expect(isCustomPackageVideoCodec(codec)).toBe(packageCodecs.includes(codec));
        }
    });

    it('caches concurrent and subsequent probe requests', async () => {
        const harness = createEnvironment(new Set(), new Set());
        const probe = new CustomDecodeCapabilityProbe(harness.environment);

        const [ first, second ] = await Promise.all([ probe.probe(), probe.probe() ]);
        const third = await probe.probe();

        expect(first).toBe(second);
        expect(second).toBe(third);
        expect(harness.videoProbe).toHaveBeenCalledTimes(
            CUSTOM_VIDEO_CODECS.length - PACKAGE_VIDEO_CODECS.length
                + CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS.length
                + CUSTOM_RAW_HDR_VIDEO_CODECS.length
                // The native Profile 5 HEVC and the native HDR HEVC and AV1 probes
                + 3
        );
        expect(harness.audioProbe).toHaveBeenCalledTimes(
            CUSTOM_WEB_CODECS_AUDIO_CODECS.length
                + CUSTOM_NATIVE_SURROUND_AUDIO_CODECS.length
        );
    });

    it.each([
        {
            chunkByteLengths: [ 23 ],
            codec: 'aac',
            codecString: 'mp4a.40.2',
            descriptionByteLength: 5,
            expectedNumberOfFrames: 1_024
        },
        {
            chunkByteLengths: [ 240 ],
            codec: 'opus',
            codecString: 'opus',
            descriptionByteLength: 19,
            expectedNumberOfFrames: 648
        },
        {
            chunkByteLengths: [ 14 ],
            codec: 'flac',
            codecString: 'flac',
            descriptionByteLength: 42,
            expectedNumberOfFrames: 4_608
        },
        {
            chunkByteLengths: [ 384 ],
            codec: 'mp3',
            codecString: 'mp3',
            descriptionByteLength: null,
            expectedNumberOfFrames: 1_152
        },
        {
            chunkByteLengths: [ 1, 1 ],
            codec: 'vorbis',
            codecString: 'vorbis',
            descriptionByteLength: 3_929,
            expectedNumberOfFrames: 576
        }
    ] as const)(
        'requires exact decoded native $codec audio output',
        async ({
            chunkByteLengths,
            codec,
            codecString,
            descriptionByteLength,
            expectedNumberOfFrames
        }) => {
            const harness = createEnvironment(new Set(), new Set([ codecString ]));

            const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

            expect(capabilities.audio[codec]).toMatchObject({
                reason: 'decode-output-verified',
                status: 'supported'
            });
            expect(harness.nativeAudioOutputProbe).toHaveBeenCalledOnce();
            const request = harness.nativeAudioOutputProbe.mock.calls[0][0];
            expect(request).toMatchObject({
                codec,
                configuration: {
                    codec: codecString,
                    numberOfChannels: 2,
                    sampleRate: 48_000
                },
                expectedNumberOfChannels: 2,
                expectedNumberOfFrames,
                expectedSampleRate: 48_000,
                expectedTimestamp: 0
            });
            if (descriptionByteLength === null) {
                expect(request.configuration.description).toBeUndefined();
            } else {
                expect(request.configuration.description).toHaveLength(descriptionByteLength);
            }
            expect(request.encodedChunks.map((chunk: { data: Uint8Array }) => (
                chunk.data.byteLength
            ))).toEqual(chunkByteLengths);
        }
    );

    it.each([
        {
            chunkByteLengths: [ 36 ],
            codec: 'aac',
            codecString: 'mp4a.40.2',
            descriptionByteLength: 5,
            expectedNumberOfFrames: 1_024
        },
        {
            chunkByteLengths: [ 640 ],
            codec: 'opus',
            codecString: 'opus',
            descriptionByteLength: 27,
            expectedNumberOfFrames: 648
        },
        {
            chunkByteLengths: [ 26 ],
            codec: 'flac',
            codecString: 'flac',
            descriptionByteLength: 42,
            expectedNumberOfFrames: 4_608
        },
        {
            chunkByteLengths: [ 1, 2 ],
            codec: 'vorbis',
            codecString: 'vorbis',
            descriptionByteLength: 6_513,
            expectedNumberOfFrames: 576
        }
    ] as const)(
        'requires exact decoded native 5.1 $codec audio output',
        async ({
            chunkByteLengths,
            codec,
            codecString,
            descriptionByteLength,
            expectedNumberOfFrames
        }) => {
            const codecSupport = new Set([ codecString ]);
            const harness = createEnvironment(
                new Set(),
                codecSupport,
                new Set(),
                false,
                new Set(),
                codecSupport,
                { configuration: codecSupport, output: codecSupport }
            );

            const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

            expect(capabilities.nativeSurroundAudio?.[codec]).toMatchObject({
                inputChannelCount: 6,
                reason: 'decode-output-verified',
                sampleRate: 48_000,
                status: 'supported'
            });
            const surroundRequests = harness.nativeAudioOutputProbe.mock.calls.filter(
                call => call[0].configuration.numberOfChannels === 6
            );
            expect(surroundRequests).toHaveLength(1);
            const request = surroundRequests[0][0];
            expect(request).toMatchObject({
                codec,
                configuration: {
                    codec: codecString,
                    numberOfChannels: 6,
                    sampleRate: 48_000
                },
                expectedNumberOfChannels: 6,
                expectedNumberOfFrames,
                expectedSampleRate: 48_000,
                expectedTimestamp: 0
            });
            expect(request.configuration.description).toHaveLength(descriptionByteLength);
            expect(request.encodedChunks.map((chunk: { data: Uint8Array }) => (
                chunk.data.byteLength
            ))).toEqual(chunkByteLengths);
        }
    );

    it('rejects audio config support without matching decoded output', async () => {
        const harness = createEnvironment(new Set(), new Set([ 'opus' ]), new Set(), false, new Set(), new Set());

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        expect(capabilities.audio.opus).toMatchObject({
            reason: 'decode-output-missing',
            status: 'unsupported'
        });
    });

    it('does not claim native audio when the decoded-output probe is unavailable', async () => {
        const harness = createEnvironment(new Set(), new Set([ 'opus' ]));
        harness.environment.nativeAudioOutputProbe = null;

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        expect(capabilities.audio.opus).toMatchObject({
            reason: 'api-unavailable',
            status: 'unknown'
        });
    });

    it.each([
        {
            codec: 'hevc',
            codecString: 'hvc1.1.6.L120.B0',
            expectedCodedHeight: 1_080,
            expectedCodedWidth: 1_920
        },
        {
            codec: 'vp8',
            codecString: 'vp8',
            expectedCodedHeight: 64,
            expectedCodedWidth: 64
        },
        {
            codec: 'vp9',
            codecString: 'vp09.00.10.08',
            expectedCodedHeight: 64,
            expectedCodedWidth: 64
        },
        {
            codec: 'av1',
            codecString: 'av01.0.08M.08',
            expectedCodedHeight: 64,
            expectedCodedWidth: 64
        }
    ] as const)(
        'requires exact decoded native $codec output',
        async ({ codec, codecString, expectedCodedHeight, expectedCodedWidth }) => {
            const harness = createEnvironment(new Set([ codecString ]), new Set());

            const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

            expect(capabilities.video[codec]).toMatchObject({
                reason: 'decode-output-verified',
                status: 'supported'
            });
            expect(harness.nativeVideoOutputProbe).toHaveBeenCalledOnce();
            const request = harness.nativeVideoOutputProbe.mock.calls[0][0];
            expect(request).toMatchObject({
                codec,
                configuration: {
                    codec: codecString,
                    codedHeight: expectedCodedHeight,
                    codedWidth: expectedCodedWidth
                },
                expectedCodedHeight,
                expectedCodedWidth,
                expectedDisplayHeight: expectedCodedHeight,
                expectedDisplayWidth: expectedCodedWidth,
                expectedTimestamp: 0
            });
            expect(request.encodedKeyFrame).toBeInstanceOf(Uint8Array);
            expect(request.encodedKeyFrame.byteLength).toBeGreaterThan(0);
        }
    );

    it.each([
        {
            codec: 'hevc',
            codecString: 'hvc1.1.6.L153.B0',
            encodedByteLength: 2_086
        },
        {
            codec: 'vp9',
            codecString: 'vp09.00.51.08',
            encodedByteLength: 731
        },
        {
            codec: 'av1',
            codecString: 'av01.0.12M.08',
            encodedByteLength: 49
        }
    ] as const)(
        'requires exact decoded native Ultra HD $codec output',
        async ({ codec, codecString, encodedByteLength }) => {
            const harness = createEnvironment(new Set([ codecString ]), new Set());

            const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

            expect(capabilities.nativeUltraHDVideo?.[codec]).toMatchObject({
                bitDepth: 8,
                codec,
                codecString,
                reason: 'decode-output-verified',
                status: 'supported'
            });
            expect(harness.nativeVideoOutputProbe).toHaveBeenCalledOnce();
            const request = harness.nativeVideoOutputProbe.mock.calls[0][0];
            expect(request).toMatchObject({
                codec,
                configuration: {
                    codec: codecString,
                    codedHeight: 2_160,
                    codedWidth: 3_840,
                    hardwareAcceleration: 'no-preference'
                },
                expectedCodedHeight: 2_160,
                expectedCodedWidth: 3_840,
                expectedDisplayHeight: 2_160,
                expectedDisplayWidth: 3_840,
                expectedTimestamp: 0
            });
            expect(request.encodedKeyFrame).toHaveLength(encodedByteLength);
        }
    );

    it('rejects config support without matching decoded native output', async () => {
        const harness = createEnvironment(new Set([ 'vp8' ]), new Set(), new Set(), false, new Set());

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        expect(capabilities.video.vp8).toMatchObject({
            reason: 'decode-output-missing',
            status: 'unsupported'
        });
    });

    it('does not claim native output when the decoded-frame probe is unavailable', async () => {
        const harness = createEnvironment(new Set([ 'vp8' ]), new Set());
        harness.environment.nativeVideoOutputProbe = null;

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        expect(capabilities.video.vp8).toMatchObject({
            reason: 'api-unavailable',
            status: 'unknown'
        });
    });

    it('bounds an ordinary native decoded-output probe that never settles', async () => {
        vi.useFakeTimers();
        const harness = createEnvironment(new Set([ 'vp8' ]), new Set());
        harness.environment.nativeVideoOutputProbe = vi.fn(() => new Promise<boolean>(() => undefined));
        const probePromise = new CustomDecodeCapabilityProbe(harness.environment).probe();

        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);
        const capabilities = await probePromise;

        expect(capabilities.video.vp8).toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
    });

    it('records probe exceptions as unknown rather than unsupported', async () => {
        const videoProbe = vi.fn(async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => {
            if (config.codec.startsWith('hvc1')) {
                throw new DOMException('Driver rejected the probe', 'OperationError');
            }
            return { config, supported: false };
        });
        const audioProbe = vi.fn(async (config: AudioDecoderConfig): Promise<AudioDecoderSupport> => {
            if (config.codec === 'opus') {
                throw new TypeError('Audio decoder crashed');
            }
            return { config, supported: false };
        });
        const capabilities = await new CustomDecodeCapabilityProbe({
            audioDecoder: { isConfigSupported: audioProbe },
            videoDecoder: { isConfigSupported: videoProbe }
        }).probe();

        expect(capabilities.video.hevc).toMatchObject({
            reason: 'probe-exception',
            status: 'unknown'
        });
        expect(capabilities.audio.opus).toMatchObject({
            reason: 'probe-exception',
            status: 'unknown'
        });
        expect(capabilities.video.h264.status).toBe('unsupported');
        expect(capabilities.telemetry.reason).toBe('probe-exceptions');
        expect(capabilities.telemetry.unknownAudioCodecCount).toBe(1);
        expect(capabilities.telemetry.unknownVideoCodecCount).toBe(1);
    });

    it('bounds decoder capability APIs that never settle', async () => {
        vi.useFakeTimers();
        const videoProbe = vi.fn(() => new Promise<VideoDecoderSupport>(() => undefined));
        const audioProbe = vi.fn(() => new Promise<AudioDecoderSupport>(() => undefined));
        const rawHDRVideoOutputProbe = vi.fn(() => (
            new Promise<RawHDRVideoOutputProbeResult>(() => undefined)
        ));
        const probePromise = new CustomDecodeCapabilityProbe({
            audioDecoder: { isConfigSupported: audioProbe },
            rawHDRVideoOutputProbe,
            videoDecoder: { isConfigSupported: videoProbe }
        }).probe();

        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);
        const capabilities = await probePromise;

        expect(capabilities.video.h264).toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
        expect(capabilities.audio.aac).toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
        expect(capabilities.rawHDRVideo.vp9).toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
        expect(capabilities.rawHDRVideo.hevc).toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
        expect(capabilities.telemetry.reason).toBe('probe-exceptions');
        expect(rawHDRVideoOutputProbe).not.toHaveBeenCalled();
    });

    it('uses unknown API-unavailable results without making support claims', async () => {
        const capabilities = await new CustomDecodeCapabilityProbe({
            audioDecoder: null,
            videoDecoder: null
        }).probe();

        for (const codec of WEB_CODECS_VIDEO_CODECS) {
            expect(capabilities.video[codec]).toMatchObject({
                reason: 'api-unavailable',
                status: 'unknown'
            });
        }
        for (const codec of PACKAGE_VIDEO_CODECS) {
            expect(capabilities.video[codec]).toMatchObject({
                reason: 'no-engine-decoder',
                status: 'unsupported'
            });
        }
        for (const codec of CUSTOM_WEB_CODECS_AUDIO_CODECS) {
            expect(capabilities.audio[codec]).toMatchObject({
                reason: 'api-unavailable',
                status: 'unknown'
            });
        }
        for (const codec of CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS) {
            expect(capabilities.audio[codec]).toMatchObject({
                reason: 'mediabunny-decoder',
                status: 'supported'
            });
        }
        for (const codec of CUSTOM_PACKAGE_AUDIO_CODECS) {
            expect(capabilities.audio[codec]).toMatchObject({
                reason: 'no-engine-decoder',
                status: 'unsupported'
            });
        }
        expect(capabilities.telemetry).toMatchObject({
            audioProbeCount: 0,
            mediabunnyAudioCodecCount: CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS.length,
            rawHDRVideoProbeCount: 0,
            reason: 'api-unavailable',
            supportedAudioCodecCount: CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS.length,
            supportedRawHDRVideoCodecCount: 0,
            videoProbeCount: 0
        });
    });

    it('reports a partial runtime when only one decoder API exists', async () => {
        const harness = createEnvironment(new Set([ 'vp8' ]), new Set());
        const capabilities = await new CustomDecodeCapabilityProbe({
            audioDecoder: null,
            nativeVideoOutputProbe: harness.nativeVideoOutputProbe,
            videoDecoder: harness.environment.videoDecoder
        }).probe();

        expect(capabilities.telemetry.reason).toBe('partial-api');
        expect(capabilities.telemetry.unknownAudioCodecCount).toBe(CUSTOM_WEB_CODECS_AUDIO_CODECS.length);
        expect(capabilities.video.vp8.status).toBe('supported');
    });

    it('never claims a codec only a decoder package decodes, whatever WebCodecs accepts', async () => {
        const harness = createEnvironment(new Set<string>(), new Set<string>());
        harness.environment.audioDecoder = {
            isConfigSupported: vi.fn(async (config: AudioDecoderConfig) => ({ config, supported: true }))
        };
        harness.environment.videoDecoder = {
            isConfigSupported: vi.fn(async (config: VideoDecoderConfig) => ({ config, supported: true }))
        };

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        for (const codec of PACKAGE_VIDEO_CODECS) {
            expect(capabilities.video[codec]).toMatchObject({
                reason: 'no-engine-decoder',
                status: 'unsupported'
            });
        }
        for (const codec of CUSTOM_PACKAGE_AUDIO_CODECS) {
            expect(capabilities.audio[codec]).toMatchObject({
                reason: 'no-engine-decoder',
                status: 'unsupported'
            });
        }
        expect(capabilities.video.jpeg2000.codecString).toBe(JPEG2000_CODEC_STRING);
    });

    it('measures raw AV1 and VP9 planes on the software decoders and raw HEVC with no preference', async () => {
        const rawCodecStrings = {
            av1: 'av01.0.08M.10',
            hevc: 'hvc1.2.4.L153.B0',
            vp9: 'vp09.02.10.10'
        } as const;
        const harness = createEnvironment(new Set(Object.values(rawCodecStrings)), new Set(), new Set(CUSTOM_RAW_HDR_VIDEO_CODECS));

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        const expectedHints = {
            av1: 'prefer-software',
            hevc: 'no-preference',
            vp9: 'prefer-software'
        } as const;
        for (const codec of CUSTOM_RAW_HDR_VIDEO_CODECS) {
            expect(capabilities.rawHDRVideo[codec]).toMatchObject({
                reason: 'output-copy-supported',
                status: 'supported'
            });
            const outputProbeRequest = harness.rawHDRVideoOutputProbe.mock.calls.find(call => call[0].codec === codec)?.[0];
            expect(outputProbeRequest?.configuration).toMatchObject({
                codec: rawCodecStrings[codec],
                hardwareAcceleration: expectedHints[codec]
            });
        }
        // The configuration check measures the same hint as the decoded output
        expect(harness.videoProbe.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([
            expect.objectContaining({ codec: rawCodecStrings.av1, hardwareAcceleration: 'prefer-software' }),
            expect.objectContaining({ codec: rawCodecStrings.vp9, hardwareAcceleration: 'prefer-software' })
        ]));
    });

    it('qualifies native HEVC raw output at Ultra HD', async () => {
        const harness = createEnvironment(new Set([ 'hvc1.2.4.L153.B0' ]), new Set(), new Set([ 'hevc' ]));

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        expect(capabilities.rawHDRVideo.hevc).toMatchObject({
            codecString: 'hvc1.2.4.L153.B0',
            reason: 'output-copy-supported',
            status: 'supported'
        });
        expect(harness.rawHDRVideoOutputProbe).toHaveBeenCalledOnce();
        expect(harness.rawHDRVideoOutputProbe.mock.calls[0][0]).toMatchObject({
            codec: 'hevc',
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840,
            expectedFormat: 'I420P10'
        });
    });

    it.each([
        {
            outputSupported: true,
            reason: 'decode-output-verified',
            status: 'supported'
        },
        {
            outputSupported: false,
            reason: 'decode-output-missing',
            status: 'unsupported'
        }
    ] as const)(
        'requires decoded native Profile 5 output: $status',
        async ({
            outputSupported,
            reason,
            status
        }) => {
            const harness = createEnvironment(new Set([ 'hev1.2.4.H150.B0' ]), new Set(), new Set(), outputSupported);

            const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

            expect(capabilities.nativeDolbyVisionHEVC).toMatchObject({
                reason,
                status
            });
            expect(harness.nativeDolbyVisionVideoOutputProbe).toHaveBeenCalledOnce();
            const request = harness.nativeDolbyVisionVideoOutputProbe.mock.calls[0][0];
            expect(request).toMatchObject({
                configuration: {
                    codec: 'hev1.2.4.H150.B0',
                    codedHeight: 2_160,
                    codedWidth: 3_840,
                    hardwareAcceleration: 'prefer-hardware',
                    optimizeForLatency: true
                },
                expectedCodedHeight: 2_160,
                expectedCodedWidth: 3_840
            });
            expect(request.encodedKeyFrame).toBeInstanceOf(Uint8Array);
            expect(request.encodedKeyFrame.byteLength).toBeGreaterThan(0);
        }
    );

    it('requires exact decoded native Main10 HDR output', async () => {
        const harness = createEnvironment(new Set([ 'hvc1.2.4.L153.B0' ]), new Set());
        const nativeHDRVideoOutputProbe = vi.fn(async (probeRequest: NativeDolbyVisionVideoOutputProbeRequest) => ({
            outputSupported: probeRequest.expectedCodedWidth === 3_840
        }));
        harness.environment.nativeHDRVideoOutputProbe = nativeHDRVideoOutputProbe;

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        expect(capabilities.nativeHDRHEVC).toMatchObject({
            bitDepth: 10,
            codecString: 'hvc1.2.4.L153.B0',
            reason: 'decode-output-verified',
            status: 'supported'
        });
        expect(nativeHDRVideoOutputProbe).toHaveBeenCalledOnce();
        expect(nativeHDRVideoOutputProbe.mock.calls[0][0]).toMatchObject({
            configuration: {
                codec: 'hvc1.2.4.L153.B0',
                codedHeight: 2_160,
                codedWidth: 3_840,
                hardwareAcceleration: 'prefer-hardware',
                optimizeForLatency: true
            },
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840
        });
        expect(nativeHDRVideoOutputProbe.mock.calls[0][0].encodedKeyFrame).toBeInstanceOf(Uint8Array);
    });

    it.each([
        {
            outputs: [ {
                duration: 21_333,
                numberOfChannels: 2,
                numberOfFrames: 1_024,
                sampleRate: 48_000,
                sampleValue: 0,
                timestamp: 0
            } ],
            supported: true
        },
        // Firefox emits an empty AudioData for the Vorbis priming packet before the expected output
        {
            outputs: [
                {
                    duration: 0,
                    numberOfChannels: 2,
                    numberOfFrames: 0,
                    sampleRate: 48_000,
                    sampleValue: 0,
                    timestamp: 0
                },
                {
                    duration: 21_333,
                    numberOfChannels: 2,
                    numberOfFrames: 1_024,
                    sampleRate: 48_000,
                    sampleValue: 0,
                    timestamp: 0
                }
            ],
            supported: true
        },
        {
            outputs: [ {
                duration: 0,
                numberOfChannels: 2,
                numberOfFrames: 0,
                sampleRate: 48_000,
                sampleValue: 0,
                timestamp: 0
            } ],
            supported: false
        },
        {
            outputs: [ {
                duration: 21_333,
                numberOfChannels: 1,
                numberOfFrames: 1_024,
                sampleRate: 48_000,
                sampleValue: 0,
                timestamp: 0
            } ],
            supported: false
        },
        {
            outputs: [ {
                duration: 21_333,
                numberOfChannels: 2,
                numberOfFrames: 1_023,
                sampleRate: 48_000,
                sampleValue: 0,
                timestamp: 0
            } ],
            supported: false
        },
        {
            outputs: [ {
                duration: 20_000,
                numberOfChannels: 2,
                numberOfFrames: 1_024,
                sampleRate: 48_000,
                sampleValue: 0,
                timestamp: 0
            } ],
            supported: false
        },
        {
            outputs: [ {
                duration: 21_333,
                numberOfChannels: 2,
                numberOfFrames: 1_024,
                sampleRate: 48_000,
                sampleValue: 0.001,
                timestamp: 0
            } ],
            supported: false
        },
        {
            outputs: [
                {
                    duration: 21_333,
                    numberOfChannels: 2,
                    numberOfFrames: 1_024,
                    sampleRate: 48_000,
                    sampleValue: 0,
                    timestamp: 0
                },
                {
                    duration: 21_333,
                    numberOfChannels: 2,
                    numberOfFrames: 1_024,
                    sampleRate: 48_000,
                    sampleValue: 0,
                    timestamp: 0
                }
            ],
            supported: false
        }
    ] as const)(
        'requires one exact silent native audio output: $supported',
        async ({ outputs, supported }) => {
            const closeAudioData = vi.fn();
            const closeDecoder = vi.fn();
            const encodedChunkInitializations: EncodedAudioChunkInit[] = [];
            class FakeAudioDecoder {
                public state: CodecState = 'unconfigured';

                public constructor(private readonly callbacks: AudioDecoderInit) {}

                public close(): void {
                    this.state = 'closed';
                    closeDecoder();
                }

                public configure(): void {
                    this.state = 'configured';
                }

                public decode(): void {
                    for (const output of outputs) {
                        const audioData = {
                            close: closeAudioData,
                            copyTo: (destination: AllowSharedBufferSource): void => {
                                (destination as Float32Array).fill(output.sampleValue);
                            },
                            duration: output.duration,
                            numberOfChannels: output.numberOfChannels,
                            numberOfFrames: output.numberOfFrames,
                            sampleRate: output.sampleRate,
                            timestamp: output.timestamp
                        } as unknown as AudioData;
                        this.callbacks.output(audioData);
                    }
                }

                public flush(): Promise<void> {
                    return Promise.resolve();
                }
            }
            class FakeEncodedAudioChunk {
                public constructor(initialization: EncodedAudioChunkInit) {
                    encodedChunkInitializations.push(initialization);
                }
            }
            vi.stubGlobal('AudioDecoder', FakeAudioDecoder);
            vi.stubGlobal('EncodedAudioChunk', FakeEncodedAudioChunk);
            const outputProbe = createNativeAudioOutputProbe();

            await expect(outputProbe?.({
                codec: 'aac',
                configuration: {
                    codec: 'mp4a.40.2',
                    numberOfChannels: 2,
                    sampleRate: 48_000
                },
                encodedChunks: [ {
                    data: new Uint8Array([ 1, 2, 3 ]),
                    duration: 21_333,
                    timestamp: 0
                } ],
                expectedNumberOfChannels: 2,
                expectedNumberOfFrames: 1_024,
                expectedSampleRate: 48_000,
                expectedTimestamp: 0
            })).resolves.toBe(supported);
            expect(encodedChunkInitializations).toEqual([ {
                data: new Uint8Array([ 1, 2, 3 ]),
                duration: 21_333,
                timestamp: 0,
                type: 'key'
            } ]);
            expect(closeAudioData).toHaveBeenCalledTimes(outputs.length);
            expect(closeDecoder).toHaveBeenCalledOnce();
        }
    );

    it('rejects and closes native audio whose planar copy fails', async () => {
        const closeAudioData = vi.fn();
        class FakeAudioDecoder {
            public state: CodecState = 'unconfigured';

            public constructor(private readonly callbacks: AudioDecoderInit) {}

            public close(): void {
                this.state = 'closed';
            }

            public configure(): void {
                this.state = 'configured';
            }

            public decode(): void {
                this.callbacks.output({
                    close: closeAudioData,
                    copyTo: (): void => {
                        throw new DOMException('Copy failed', 'OperationError');
                    },
                    duration: 21_333,
                    numberOfChannels: 2,
                    numberOfFrames: 1_024,
                    sampleRate: 48_000,
                    timestamp: 0
                } as unknown as AudioData);
            }

            public flush(): Promise<void> {
                return Promise.resolve();
            }
        }
        class FakeEncodedAudioChunk {}
        vi.stubGlobal('AudioDecoder', FakeAudioDecoder);
        vi.stubGlobal('EncodedAudioChunk', FakeEncodedAudioChunk);
        const outputProbe = createNativeAudioOutputProbe();

        await expect(outputProbe?.({
            codec: 'aac',
            configuration: {
                codec: 'mp4a.40.2',
                numberOfChannels: 2,
                sampleRate: 48_000
            },
            encodedChunks: [ {
                data: new Uint8Array([ 1 ]),
                duration: 21_333,
                timestamp: 0
            } ],
            expectedNumberOfChannels: 2,
            expectedNumberOfFrames: 1_024,
            expectedSampleRate: 48_000,
            expectedTimestamp: 0
        })).resolves.toBe(false);
        expect(closeAudioData).toHaveBeenCalledOnce();
    });

    it('closes a native audio decoder whose flush never settles', async () => {
        vi.useFakeTimers();
        const closeDecoder = vi.fn();
        class FakeAudioDecoder {
            public state: CodecState = 'unconfigured';

            public close(): void {
                this.state = 'closed';
                closeDecoder();
            }

            public configure(): void {
                this.state = 'configured';
            }

            public decode(): void {
                return;
            }

            public flush(): Promise<void> {
                return new Promise<void>(() => undefined);
            }
        }
        class FakeEncodedAudioChunk {}
        vi.stubGlobal('AudioDecoder', FakeAudioDecoder);
        vi.stubGlobal('EncodedAudioChunk', FakeEncodedAudioChunk);
        const outputProbe = createNativeAudioOutputProbe();
        const probePromise = outputProbe?.({
            codec: 'aac',
            configuration: {
                codec: 'mp4a.40.2',
                numberOfChannels: 2,
                sampleRate: 48_000
            },
            encodedChunks: [ {
                data: new Uint8Array([ 1 ]),
                duration: 21_333,
                timestamp: 0
            } ],
            expectedNumberOfChannels: 2,
            expectedNumberOfFrames: 1_024,
            expectedSampleRate: 48_000,
            expectedTimestamp: 0
        });

        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);

        await expect(probePromise).resolves.toBe(false);
        expect(closeDecoder).toHaveBeenCalledOnce();
    });

    it.each([
        {
            codedHeight: 2_160,
            codedWidth: 3_840,
            outputSupported: true
        },
        {
            codedHeight: 1_080,
            codedWidth: 1_920,
            outputSupported: false
        },
        {
            codedHeight: 2_160,
            codedWidth: 3_840,
            outputSupported: false,
            timestampOffset: 1
        }
    ])(
        'qualifies native Profile 5 exact output: $outputSupported',
        async ({
            codedHeight,
            codedWidth,
            outputSupported,
            timestampOffset = 0
        }) => {
            const closeFrame = vi.fn();
            class FakeVideoFrame {
                public readonly codedHeight = codedHeight;
                public readonly codedWidth = codedWidth;
                public readonly displayHeight = codedHeight;
                public readonly displayWidth = codedWidth;

                public constructor(public readonly timestamp: number) {}

                public close(): void {
                    closeFrame();
                }
            }
            class FakeVideoDecoder {
                public constructor(private readonly callbacks: VideoDecoderInit) {}

                public close(): void {
                    return;
                }

                public configure(): void {
                    return;
                }

                public decode(chunk: { timestamp: number }): void {
                    this.callbacks.output(new FakeVideoFrame(chunk.timestamp + timestampOffset) as unknown as VideoFrame);
                }

                public flush(): Promise<void> {
                    return Promise.resolve();
                }
            }
            class FakeEncodedVideoChunk {
                public readonly timestamp: number;

                public constructor(init: { timestamp: number }) {
                    this.timestamp = Number(init.timestamp);
                }
            }
            vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
            vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
            const outputProbe = createNativeDolbyVisionVideoOutputProbe();

            const result = await outputProbe?.({
                configuration: {
                    codec: 'hev1.2.4.H150.B0',
                    codedHeight: 2_160,
                    codedWidth: 3_840
                },
                encodedKeyFrame: new Uint8Array([ 1, 2, 3 ]),
                expectedCodedHeight: 2_160,
                expectedCodedWidth: 3_840
            });
            expect(result).toEqual({ outputSupported });
            expect(closeFrame).toHaveBeenCalledOnce();
        }
    );

    it('decodes one native Main10 frame and flushes once', async () => {
        const closeFrame = vi.fn();
        let flushCount = 0;
        let maximumQueuedFrameCount = 0;
        let queuedFrameCount = 0;
        class FakeVideoFrame {
            public readonly codedHeight = 2_160;
            public readonly codedWidth = 3_840;
            public readonly displayHeight = 2_160;
            public readonly displayWidth = 3_840;

            public constructor(public readonly timestamp: number) {}

            public close(): void {
                closeFrame();
            }
        }
        class FakeVideoDecoder {
            public constructor(private readonly callbacks: VideoDecoderInit) {}

            public close(): void {
                return;
            }

            public configure(): void {
                return;
            }

            public decode(chunk: { timestamp: number }): void {
                queuedFrameCount += 1;
                maximumQueuedFrameCount = Math.max(maximumQueuedFrameCount, queuedFrameCount);
                void Promise.resolve().then((): void => {
                    queuedFrameCount -= 1;
                    this.callbacks.output(new FakeVideoFrame(chunk.timestamp) as unknown as VideoFrame);
                });
            }

            public flush(): Promise<void> {
                flushCount += 1;
                return Promise.resolve();
            }
        }
        class FakeEncodedVideoChunk {
            public readonly timestamp: number;

            public constructor(init: { timestamp: number }) {
                this.timestamp = init.timestamp;
            }
        }
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        const outputProbe = createNativeDolbyVisionVideoOutputProbe();

        await expect(outputProbe?.({
            configuration: {
                codec: 'hvc1.2.4.L153.B0',
                codedHeight: 2_160,
                codedWidth: 3_840
            },
            encodedKeyFrame: new Uint8Array([ 1, 2, 3 ]),
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840
        })).resolves.toEqual({ outputSupported: true });
        expect(flushCount).toBe(1);
        expect(maximumQueuedFrameCount).toBe(1);
        expect(closeFrame).toHaveBeenCalledOnce();
    });

    it('fails native output qualification when the decoder flush stalls', async () => {
        vi.useFakeTimers();
        const closeDecoder = vi.fn();
        const closeFrame = vi.fn();
        let flushCount = 0;
        class FakeVideoFrame {
            public readonly codedHeight = 2_160;
            public readonly codedWidth = 3_840;
            public readonly displayHeight = 2_160;
            public readonly displayWidth = 3_840;

            public constructor(public readonly timestamp: number) {}

            public close(): void {
                closeFrame();
            }
        }
        class FakeVideoDecoder {
            public constructor(private readonly callbacks: VideoDecoderInit) {}

            public close(): void {
                closeDecoder();
            }

            public configure(): void {
                return;
            }

            public decode(chunk: { timestamp: number }): void {
                this.callbacks.output(new FakeVideoFrame(chunk.timestamp) as unknown as VideoFrame);
            }

            public flush(): Promise<void> {
                flushCount += 1;
                return new Promise<void>(() => undefined);
            }
        }
        class FakeEncodedVideoChunk {
            public readonly timestamp: number;

            public constructor(init: { timestamp: number }) {
                this.timestamp = init.timestamp;
            }
        }
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        const outputProbe = createNativeDolbyVisionVideoOutputProbe();
        const probePromise = outputProbe?.({
            configuration: {
                codec: 'hvc1.2.4.L153.B0',
                codedHeight: 2_160,
                codedWidth: 3_840
            },
            encodedKeyFrame: new Uint8Array([ 1, 2, 3 ]),
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(flushCount).toBe(1);
        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);

        await expect(probePromise).resolves.toEqual({ outputSupported: false });
        expect(closeFrame).toHaveBeenCalledOnce();
        expect(closeDecoder).toHaveBeenCalledOnce();
    });

    it('fails cleanly when native decode throws synchronously', async () => {
        const closeDecoder = vi.fn();
        class FakeVideoDecoder {
            public close(): void {
                closeDecoder();
            }

            public configure(): void {
                return;
            }

            public decode(): void {
                throw new DOMException('Decoder queue rejected input', 'OperationError');
            }

            public flush(): Promise<void> {
                return Promise.resolve();
            }
        }
        class FakeEncodedVideoChunk {
            public readonly timestamp: number;

            public constructor(init: { timestamp: number }) {
                this.timestamp = init.timestamp;
            }
        }
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        const outputProbe = createNativeDolbyVisionVideoOutputProbe();

        await expect(outputProbe?.({
            configuration: {
                codec: 'hvc1.2.4.L153.B0',
                codedHeight: 2_160,
                codedWidth: 3_840
            },
            encodedKeyFrame: new Uint8Array([ 1, 2, 3 ]),
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840
        })).resolves.toEqual({ outputSupported: false });
        expect(closeDecoder).toHaveBeenCalledOnce();
    });

    it('rejects and closes duplicate native Profile 5 output', async () => {
        const closeFrame = vi.fn();
        class FakeVideoFrame {
            public readonly codedHeight = 2_160;
            public readonly codedWidth = 3_840;
            public readonly displayHeight = 2_160;
            public readonly displayWidth = 3_840;

            public constructor(public readonly timestamp: number) {}

            public close(): void {
                closeFrame();
            }
        }
        class FakeVideoDecoder {
            public constructor(private readonly callbacks: VideoDecoderInit) {}

            public close(): void {
                return;
            }

            public configure(): void {
                return;
            }

            public decode(chunk: { timestamp: number }): void {
                this.callbacks.output(new FakeVideoFrame(chunk.timestamp) as unknown as VideoFrame);
                this.callbacks.output(new FakeVideoFrame(chunk.timestamp) as unknown as VideoFrame);
            }

            public flush(): Promise<void> {
                return Promise.resolve();
            }
        }
        class FakeEncodedVideoChunk {
            public readonly timestamp: number;

            public constructor(init: { timestamp: number }) {
                this.timestamp = init.timestamp;
            }
        }
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        const outputProbe = createNativeDolbyVisionVideoOutputProbe();

        await expect(outputProbe?.({
            configuration: {
                codec: 'hev1.2.4.H150.B0',
                codedHeight: 2_160,
                codedWidth: 3_840
            },
            encodedKeyFrame: new Uint8Array([ 1, 2, 3 ]),
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840
        })).resolves.toEqual({ outputSupported: false });
        expect(closeFrame).toHaveBeenCalledTimes(2);
    });

    it.each([
        {
            frames: [ {
                codedHeight: 64,
                codedWidth: 64,
                displayHeight: 64,
                displayWidth: 64,
                timestamp: 0,
                visibleHeight: 64,
                visibleWidth: 64
            } ],
            supported: true
        },
        {
            frames: [ {
                codedHeight: 64,
                codedWidth: 128,
                displayHeight: 64,
                displayWidth: 64,
                timestamp: 0,
                visibleHeight: 64,
                visibleWidth: 64
            } ],
            supported: true
        },
        {
            frames: [ {
                codedHeight: 64,
                codedWidth: 512,
                displayHeight: 64,
                displayWidth: 64,
                timestamp: 0,
                visibleHeight: 64,
                visibleWidth: 64
            } ],
            supported: false
        },
        {
            frames: [ {
                codedHeight: 64,
                codedWidth: 64,
                displayHeight: 32,
                displayWidth: 64,
                timestamp: 0,
                visibleHeight: 32,
                visibleWidth: 64
            } ],
            supported: false
        },
        {
            frames: [
                {
                    codedHeight: 64,
                    codedWidth: 64,
                    displayHeight: 64,
                    displayWidth: 64,
                    timestamp: 0,
                    visibleHeight: 64,
                    visibleWidth: 64
                },
                {
                    codedHeight: 64,
                    codedWidth: 64,
                    displayHeight: 64,
                    displayWidth: 64,
                    timestamp: 0,
                    visibleHeight: 64,
                    visibleWidth: 64
                }
            ],
            supported: false
        }
    ] as const)(
        'requires one exact ordinary native output: $supported',
        async ({ frames, supported }) => {
            const closeDecoder = vi.fn();
            const closeFrame = vi.fn();
            class FakeVideoDecoder {
                public state: CodecState = 'unconfigured';

                public constructor(private readonly callbacks: VideoDecoderInit) {}

                public close(): void {
                    this.state = 'closed';
                    closeDecoder();
                }

                public configure(): void {
                    this.state = 'configured';
                }

                public decode(): void {
                    for (const frameDefinition of frames) {
                        const frame = {
                            close: closeFrame,
                            codedHeight: frameDefinition.codedHeight,
                            codedWidth: frameDefinition.codedWidth,
                            displayHeight: frameDefinition.displayHeight,
                            displayWidth: frameDefinition.displayWidth,
                            timestamp: frameDefinition.timestamp,
                            visibleRect: {
                                height: frameDefinition.visibleHeight,
                                width: frameDefinition.visibleWidth,
                                x: 0,
                                y: 0
                            }
                        } as unknown as VideoFrame;
                        this.callbacks.output(frame);
                    }
                }

                public flush(): Promise<void> {
                    return Promise.resolve();
                }
            }
            class FakeEncodedVideoChunk {}
            vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
            vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
            const outputProbe = createNativeVideoOutputProbe();

            await expect(outputProbe?.({
                codec: 'vp8',
                configuration: {
                    codec: 'vp8',
                    codedHeight: 64,
                    codedWidth: 64
                },
                encodedKeyFrame: new Uint8Array([ 1, 2, 3 ]),
                expectedCodedHeight: 64,
                expectedCodedWidth: 64,
                expectedDisplayHeight: 64,
                expectedDisplayWidth: 64,
                expectedTimestamp: 0
            })).resolves.toBe(supported);
            expect(closeFrame).toHaveBeenCalledTimes(frames.length);
            expect(closeDecoder).toHaveBeenCalledOnce();
        }
    );

    it('closes an ordinary native decoder whose flush never settles', async () => {
        vi.useFakeTimers();
        const closeDecoder = vi.fn();
        class FakeVideoDecoder {
            public state: CodecState = 'unconfigured';

            public close(): void {
                this.state = 'closed';
                closeDecoder();
            }

            public configure(): void {
                this.state = 'configured';
            }

            public decode(): void {
                return;
            }

            public flush(): Promise<void> {
                return new Promise<void>(() => undefined);
            }
        }
        class FakeEncodedVideoChunk {}
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        const outputProbe = createNativeVideoOutputProbe();
        const probePromise = outputProbe?.({
            codec: 'vp8',
            configuration: {
                codec: 'vp8',
                codedHeight: 64,
                codedWidth: 64
            },
            encodedKeyFrame: new Uint8Array([ 1, 2, 3 ]),
            expectedCodedHeight: 64,
            expectedCodedWidth: 64,
            expectedDisplayHeight: 64,
            expectedDisplayWidth: 64,
            expectedTimestamp: 0
        });

        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);

        await expect(probePromise).resolves.toBe(false);
        expect(closeDecoder).toHaveBeenCalledOnce();
    });

    it.each([
        {
            expectedDecodedFrameFingerprint: 667_501_752,
            outputCopySupported: true
        },
        {
            expectedDecodedFrameFingerprint: 667_501_753,
            outputCopySupported: false
        }
    ])(
        'requires exact raw HDR decode and copy output: $outputCopySupported',
        async ({
            expectedDecodedFrameFingerprint,
            outputCopySupported
        }) => {
            let flushCount = 0;
            let openFrameCount = 0;
            let maximumOpenFrameCount = 0;
            const closeFrame = vi.fn();
            const copyFrame = vi.fn(async (): Promise<readonly PlaneLayout[]> => {
                return [
                    { offset: 0, stride: 7_680 },
                    { offset: 16_588_800, stride: 3_840 },
                    { offset: 20_736_000, stride: 3_840 }
                ];
            });
            class FakeVideoFrame {
                public readonly codedHeight = 2_160;
                public readonly codedWidth = 3_840;
                // Hardware-backed frames may expose no native CPU-readable format
                public readonly format = null;

                public constructor(public readonly timestamp: number) {
                    openFrameCount += 1;
                    maximumOpenFrameCount = Math.max(maximumOpenFrameCount, openFrameCount);
                }

                public allocationSize(): number {
                    return 24_883_200;
                }

                public close(): void {
                    openFrameCount -= 1;
                    closeFrame();
                }

                public copyTo(): Promise<readonly PlaneLayout[]> {
                    return copyFrame();
                }
            }
            class FakeVideoDecoder {
                public constructor(private readonly callbacks: VideoDecoderInit) {}

                public close(): void {
                    return;
                }

                public configure(): void {
                    return;
                }

                public decode(chunk: { timestamp: number }): void {
                    const frame = new FakeVideoFrame(chunk.timestamp);
                    this.callbacks.output(frame as unknown as VideoFrame);
                }

                public flush(): Promise<void> {
                    flushCount += 1;
                    return Promise.resolve(undefined);
                }
            }
            class FakeEncodedVideoChunk {
                public readonly timestamp: number;

                public constructor(init: { timestamp: number }) {
                    this.timestamp = init.timestamp;
                }
            }
            vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
            vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
            const outputProbe = createRawHDRVideoOutputProbe();

            const result = await outputProbe?.({
                codec: 'vp9',
                configuration: {
                    codec: 'vp09.02.10.10',
                    codedHeight: 2_160,
                    codedWidth: 3_840
                },
                encodedChunks: [ {
                    data: new Uint8Array([ 1, 2, 3 ]),
                    timestamp: 0,
                    type: 'key'
                } ],
                expectedCodedHeight: 2_160,
                expectedCodedWidth: 3_840,
                expectedDecodedFrames: [ {
                    fingerprint: expectedDecodedFrameFingerprint,
                    timestamp: 0
                } ],
                expectedFormat: 'I420P10'
            });
            expect(result).toEqual({ outputCopySupported });
            expect(copyFrame).toHaveBeenCalledOnce();
            expect(closeFrame).toHaveBeenCalledOnce();
            expect(flushCount).toBe(1);
            expect(maximumOpenFrameCount).toBe(1);
            expect(openFrameCount).toBe(0);
        }
    );

    it.each([
        {
            expectedSecondTimestamp: 1_000_000,
            outputCopySupported: true
        },
        {
            expectedSecondTimestamp: 999_999,
            outputCopySupported: false
        }
    ])(
        'requires ordered key and delta raw outputs: $outputCopySupported',
        async ({ expectedSecondTimestamp, outputCopySupported }) => {
            const frameFingerprint = 667_501_752;
            const encodedChunkInitializations: EncodedVideoChunkInit[] = [];
            const decodedChunkTimestamps: number[] = [];
            class FakeVideoFrame {
                public readonly codedHeight = 2_160;
                public readonly codedWidth = 3_840;
                public readonly format = 'I420P10';

                public constructor(public readonly timestamp: number) {}

                public allocationSize(): number {
                    return 24_883_200;
                }

                public close(): void {
                    return;
                }

                public async copyTo(): Promise<readonly PlaneLayout[]> {
                    return [
                        { offset: 0, stride: 7_680 },
                        { offset: 16_588_800, stride: 3_840 },
                        { offset: 20_736_000, stride: 3_840 }
                    ];
                }
            }
            class FakeVideoDecoder {
                public constructor(private readonly callbacks: VideoDecoderInit) {}

                public close(): void {
                    return;
                }

                public configure(): void {
                    return;
                }

                public decode(chunk: { timestamp: number }): void {
                    decodedChunkTimestamps.push(chunk.timestamp);
                    this.callbacks.output(new FakeVideoFrame(chunk.timestamp) as unknown as VideoFrame);
                }

                public flush(): Promise<void> {
                    return Promise.resolve();
                }
            }
            class FakeEncodedVideoChunk {
                public readonly timestamp: number;

                public constructor(init: EncodedVideoChunkInit) {
                    encodedChunkInitializations.push(init);
                    this.timestamp = init.timestamp;
                }
            }
            vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
            vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
            const outputProbe = createRawHDRVideoOutputProbe();

            await expect(outputProbe?.({
                codec: 'hevc',
                configuration: {
                    codec: 'hvc1.4.10.L93.9D.08',
                    codedHeight: 2_160,
                    codedWidth: 3_840
                },
                encodedChunks: [
                    {
                        data: new Uint8Array([ 1 ]),
                        timestamp: 0,
                        type: 'key'
                    },
                    {
                        data: new Uint8Array([ 2 ]),
                        timestamp: 1_000_000,
                        type: 'delta'
                    }
                ],
                expectedCodedHeight: 2_160,
                expectedCodedWidth: 3_840,
                expectedDecodedFrames: [
                    { fingerprint: frameFingerprint, timestamp: 0 },
                    { fingerprint: frameFingerprint, timestamp: expectedSecondTimestamp }
                ],
                expectedFormat: 'I420P10'
            })).resolves.toEqual({ outputCopySupported });
            expect(encodedChunkInitializations).toEqual([
                {
                    data: new Uint8Array([ 1 ]),
                    timestamp: 0,
                    type: 'key'
                },
                {
                    data: new Uint8Array([ 2 ]),
                    timestamp: 1_000_000,
                    type: 'delta'
                }
            ]);
            expect(decodedChunkTimestamps).toEqual([ 0, 1_000_000 ]);
        }
    );

    it.each([
        // libvpx pads a 3840-wide picture's coded width to 3904 and copies its visible 3840 columns
        { codedWidth: 3_904, outputCopySupported: true, visibleWidth: 3_840 },
        { codedWidth: 3_904, outputCopySupported: false, visibleWidth: 3_904 }
    ])('qualifies raw output by its visible size, coded $codedWidth and visible $visibleWidth wide: $outputCopySupported', async ({
        codedWidth,
        outputCopySupported,
        visibleWidth
    }) => {
        // The fingerprint of the zeroed planes of a 3840x2160 I420P10 copy
        const frameFingerprint = 667_501_752;
        class FakeVideoFrame {
            public readonly codedHeight = 2_160;
            public readonly codedWidth = codedWidth;
            public readonly format = 'I420P10';
            public readonly visibleRect = { height: 2_160, width: visibleWidth, x: 0, y: 0 };

            public constructor(public readonly timestamp: number) {}

            public allocationSize(): number {
                return 24_883_200;
            }

            public close(): void {
                return;
            }

            // The copy is the visible rectangle's, at the visible width's stride
            public copyTo(): Promise<readonly PlaneLayout[]> {
                return Promise.resolve([
                    { offset: 0, stride: visibleWidth * 2 },
                    { offset: visibleWidth * 2 * 2_160, stride: visibleWidth },
                    { offset: visibleWidth * 2 * 2_160 * 5 / 4, stride: visibleWidth }
                ]);
            }
        }
        class FakeVideoDecoder {
            public constructor(private readonly callbacks: VideoDecoderInit) {}

            public close(): void {
                return;
            }

            public configure(): void {
                return;
            }

            public decode(chunk: { timestamp: number }): void {
                this.callbacks.output(new FakeVideoFrame(chunk.timestamp) as unknown as VideoFrame);
            }

            public flush(): Promise<void> {
                return Promise.resolve();
            }
        }
        class FakeEncodedVideoChunk {
            public readonly timestamp: number;

            public constructor(init: { timestamp: number }) {
                this.timestamp = init.timestamp;
            }
        }
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);

        const result = await createRawHDRVideoOutputProbe()?.({
            codec: 'vp9',
            configuration: { codec: 'vp09.02.10.10', codedHeight: 2_160, codedWidth: 3_840 },
            encodedChunks: [ { data: new Uint8Array([ 1 ]), timestamp: 0, type: 'key' } ],
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840,
            expectedDecodedFrames: [ { fingerprint: frameFingerprint, timestamp: 0 } ],
            expectedFormat: 'I420P10'
        });

        expect(result).toEqual({ outputCopySupported });
    });

    it('qualifies raw output where the browser rejects a non-RGB copy format, as the spec requires', async () => {
        const allocationSizeOptions: Array<VideoFrameCopyToOptions | undefined> = [];
        const copyOptions: Array<VideoFrameCopyToOptions | undefined> = [];
        const rejectExplicitPlanarFormat = (options?: VideoFrameCopyToOptions): void => {
            if (options?.format) {
                throw new DOMException(EXPLICIT_PLANAR_FORMAT_REJECTION_MESSAGE, 'NotSupportedError');
            }
        };
        class FakeVideoFrame {
            public readonly codedHeight = 2_160;
            public readonly codedWidth = 3_840;
            public readonly format = 'I420P10';
            public readonly timestamp = 0;

            public allocationSize(options?: VideoFrameCopyToOptions): number {
                allocationSizeOptions.push(options);
                rejectExplicitPlanarFormat(options);
                return UHD_I420P10_ALLOCATION_SIZE;
            }

            public close(): void {
                return;
            }

            public async copyTo(
                _destination: AllowSharedBufferSource,
                options?: VideoFrameCopyToOptions
            ): Promise<readonly PlaneLayout[]> {
                copyOptions.push(options);
                rejectExplicitPlanarFormat(options);
                return UHD_I420P10_PLANE_LAYOUTS;
            }
        }
        class FakeVideoDecoder {
            public constructor(private readonly callbacks: VideoDecoderInit) {}

            public close(): void {
                return;
            }

            public configure(): void {
                return;
            }

            public decode(): void {
                this.callbacks.output(new FakeVideoFrame() as unknown as VideoFrame);
            }

            public flush(): Promise<void> {
                return Promise.resolve();
            }
        }
        class FakeEncodedVideoChunk {}
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        const outputProbe = createRawHDRVideoOutputProbe();

        await expect(outputProbe?.({
            codec: 'hevc',
            configuration: {
                codec: 'hvc1.2.4.L153.B0',
                codedHeight: 2_160,
                codedWidth: 3_840
            },
            encodedChunks: [ {
                data: new Uint8Array([ 1 ]),
                timestamp: 0,
                type: 'key'
            } ],
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840,
            expectedDecodedFrames: [ {
                fingerprint: ZERO_UHD_I420P10_FRAME_FINGERPRINT,
                timestamp: 0
            } ],
            expectedFormat: 'I420P10'
        })).resolves.toEqual({ outputCopySupported: true });
        expect(allocationSizeOptions).toEqual([ undefined ]);
        expect(copyOptions).toEqual([ undefined ]);
    });

    it('closes an owned raw frame when copyTo never settles', async () => {
        vi.useFakeTimers();
        const closeDecoder = vi.fn();
        const closeFrame = vi.fn();
        const copyFrame = vi.fn(() => new Promise<readonly PlaneLayout[]>(() => undefined));
        class FakeVideoFrame {
            public readonly codedHeight = 2_160;
            public readonly codedWidth = 3_840;
            public readonly format = 'I420P10';
            public readonly timestamp = 0;

            public allocationSize(): number {
                return 24_883_200;
            }

            public close(): void {
                closeFrame();
            }

            public copyTo(): Promise<readonly PlaneLayout[]> {
                return copyFrame();
            }
        }
        class FakeVideoDecoder {
            public constructor(private readonly callbacks: VideoDecoderInit) {}

            public close(): void {
                closeDecoder();
            }

            public configure(): void {
                return;
            }

            public decode(): void {
                this.callbacks.output(new FakeVideoFrame() as unknown as VideoFrame);
            }

            public flush(): Promise<void> {
                return Promise.resolve();
            }
        }
        class FakeEncodedVideoChunk {}
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        const outputProbe = createRawHDRVideoOutputProbe();
        const probePromise = outputProbe?.({
            codec: 'vp9',
            configuration: {
                codec: 'vp09.02.10.10',
                codedHeight: 2_160,
                codedWidth: 3_840
            },
            encodedChunks: [ {
                data: new Uint8Array([ 1, 2, 3 ]),
                timestamp: 0,
                type: 'key'
            } ],
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840,
            expectedDecodedFrames: [ {
                fingerprint: 667_501_752,
                timestamp: 0
            } ],
            expectedFormat: 'I420P10'
        });

        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);

        await expect(probePromise).resolves.toEqual({ outputCopySupported: false });
        expect(copyFrame).toHaveBeenCalledOnce();
        expect(closeFrame).toHaveBeenCalledOnce();
        expect(closeDecoder).toHaveBeenCalledOnce();
    });

    it('fails raw output qualification when the decoder flush stalls', async () => {
        vi.useFakeTimers();
        const closeDecoder = vi.fn();
        const closeFrame = vi.fn();
        const copyFrame = vi.fn();
        let flushCount = 0;
        class FakeVideoFrame {
            public readonly codedHeight = 2_160;
            public readonly codedWidth = 3_840;
            public readonly format = 'I420P10';

            public constructor(public readonly timestamp: number) {}

            public allocationSize(): number {
                return 24_883_200;
            }

            public close(): void {
                closeFrame();
            }

            public async copyTo(): Promise<readonly PlaneLayout[]> {
                copyFrame();
                return [
                    { offset: 0, stride: 7_680 },
                    { offset: 16_588_800, stride: 3_840 },
                    { offset: 20_736_000, stride: 3_840 }
                ];
            }
        }
        class FakeVideoDecoder {
            public constructor(private readonly callbacks: VideoDecoderInit) {}

            public close(): void {
                closeDecoder();
            }

            public configure(): void {
                return;
            }

            public decode(chunk: { timestamp: number }): void {
                const frame = new FakeVideoFrame(chunk.timestamp) as unknown as VideoFrame;
                this.callbacks.output(frame);
            }

            public flush(): Promise<void> {
                flushCount += 1;
                return new Promise<void>(() => undefined);
            }
        }
        class FakeEncodedVideoChunk {
            public readonly timestamp: number;

            public constructor(init: { timestamp: number }) {
                this.timestamp = init.timestamp;
            }
        }
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        const outputProbe = createRawHDRVideoOutputProbe();
        const probePromise = outputProbe?.({
            codec: 'vp9',
            configuration: {
                codec: 'vp09.02.10.10',
                codedHeight: 2_160,
                codedWidth: 3_840
            },
            encodedChunks: [ {
                data: new Uint8Array([ 1, 2, 3 ]),
                timestamp: 0,
                type: 'key'
            } ],
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840,
            expectedDecodedFrames: [ {
                fingerprint: 667_501_752,
                timestamp: 0
            } ],
            expectedFormat: 'I420P10'
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(flushCount).toBe(1);
        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);

        await expect(probePromise).resolves.toEqual({ outputCopySupported: false });
        expect(closeFrame).toHaveBeenCalledOnce();
        expect(copyFrame).toHaveBeenCalledOnce();
        expect(closeDecoder).toHaveBeenCalledOnce();
    });
});

const SDR_HEVC_STREAM = Object.freeze({
    BitDepth: 8,
    Codec: 'hevc',
    PixelFormat: 'yuv420p',
    Profile: 'Main',
    Type: 'Video',
    VideoRange: 'SDR',
    VideoRangeType: 'SDR'
});
const HDR10_PLUS_HEVC_STREAM = Object.freeze({
    BitDepth: 10,
    Codec: 'hevc',
    ColorPrimaries: 'bt2020',
    ColorSpace: 'bt2020nc',
    ColorTransfer: 'smpte2084',
    Hdr10PlusPresentFlag: true,
    PixelFormat: 'yuv420p10le',
    Profile: 'Main 10',
    Type: 'Video',
    VideoRange: 'HDR',
    VideoRangeType: 'HDR10Plus'
});
const MAIN_422_10_HEVC_STREAM = Object.freeze({
    BitDepth: 10,
    Codec: 'hevc',
    PixelFormat: 'yuv422p10le',
    Profile: 'Main 4:2:2 10',
    Type: 'Video',
    VideoRange: 'SDR',
    VideoRangeType: 'SDR'
});
const SDR_H264_STREAM = Object.freeze({
    BitDepth: 8,
    Codec: 'h264',
    Type: 'Video',
    VideoRange: 'SDR',
    VideoRangeType: 'SDR'
});
const SDR_MPEG2_STREAM = Object.freeze({
    BitDepth: 8,
    Codec: 'mpeg2video',
    Type: 'Video',
    VideoRange: 'SDR',
    VideoRangeType: 'SDR'
});
const FLAC_STREAM = Object.freeze({ Codec: 'flac', Type: 'Audio' });

function createItem(...mediaStreamLists: ReadonlyArray<readonly object[]>): object {
    return {
        MediaSources: mediaStreamLists.map((mediaStreams: readonly object[]): object => ({ MediaStreams: mediaStreams }))
    };
}

function getSelectedVideoProbes(item: unknown): ReadonlySet<string> {
    const audioProbes: ReadonlySet<string> = new Set<string>(CUSTOM_DECODE_AUDIO_PROBES);
    return new Set<string>(selectCustomDecodeProbes(item).filter((probe: string): boolean => !audioProbes.has(probe)));
}

describe('item-scoped capability probe selection', () => {
    it('starts every audio probe first for every item', () => {
        for (const item of [ createItem([ SDR_HEVC_STREAM ]), createItem([ FLAC_STREAM ]), {} ]) {
            expect(selectCustomDecodeProbes(item).slice(0, CUSTOM_DECODE_AUDIO_PROBES.length)).toEqual([ ...CUSTOM_DECODE_AUDIO_PROBES ]);
        }
    });

    it('selects only the video probes an SDR HEVC item needs', () => {
        expect(getSelectedVideoProbes(createItem([ SDR_HEVC_STREAM, FLAC_STREAM ]))).toEqual(new Set([
            'native-sdr:hevc',
            'native-ultra-hd:hevc'
        ]));
    });

    it('adds the HDR routes and the HDR transcode targets for an HDR HEVC item', () => {
        const videoProbes = getSelectedVideoProbes(createItem([ HDR10_PLUS_HEVC_STREAM ]));

        for (const probe of [
            'native-hdr-hevc',
            'native-sdr:av1',
            'native-sdr:hevc',
            'native-ultra-hd:av1',
            'native-ultra-hd:hevc',
            'raw:av1',
            'raw:hevc'
        ]) {
            expect(videoProbes).toContain(probe);
        }
        for (const probe of [
            'h264-profiles',
            'hevc-range-extension:main422-10'
        ]) {
            expect(videoProbes).not.toContain(probe);
        }
    });

    it('adds the native HDR AV1 probe for an HDR AV1 item only', () => {
        const hdrAV1Stream = { ...HDR10_PLUS_HEVC_STREAM, Codec: 'av1', Profile: 'Main' };
        const sdrAV1Stream = { ...SDR_HEVC_STREAM, Codec: 'av1', Profile: 'Main' };

        expect(getSelectedVideoProbes(createItem([ hdrAV1Stream ]))).toContain('native-hdr-av1');
        expect(getSelectedVideoProbes(createItem([ sdrAV1Stream ]))).not.toContain('native-hdr-av1');
        // An HEVC item transcodes to AV1 through the raw ranges, which the native AV1 route leaves as they are
        expect(getSelectedVideoProbes(createItem([ HDR10_PLUS_HEVC_STREAM ]))).not.toContain('native-hdr-av1');
    });

    it('selects a named range extension through its own variant only', () => {
        const videoProbes = getSelectedVideoProbes(createItem([ MAIN_422_10_HEVC_STREAM ]));
        const rangeExtensionProbes = [ ...videoProbes ].filter((probe: string): boolean => (
            probe.startsWith('hevc-range-extension:')
        ));

        expect(rangeExtensionProbes).toEqual([ 'hevc-range-extension:main422-10' ]);
        expect(videoProbes).not.toContain('native-hdr-hevc');
        expect(videoProbes).not.toContain('raw:hevc');
    });

    it.each([
        { probe: 'av1-raw-format:high444-8', stream: { BitDepth: 8, Codec: 'av1', PixelFormat: 'yuv444p', Profile: 'High', Type: 'Video', VideoRange: 'SDR', VideoRangeType: 'SDR' } },
        {
            probe: 'av1-raw-format:professional422-10',
            stream: { BitDepth: 10, Codec: 'av1', PixelFormat: 'yuv422p10le', Profile: 'Professional', Type: 'Video', VideoRange: 'SDR', VideoRangeType: 'SDR' }
        },
        // 8-bit Main presents natively, so only Dolby Vision, whose range is not SDR, needs its I420 planes
        {
            probe: 'av1-raw-format:main420-8',
            stream: { BitDepth: 8, Codec: 'av1', DvProfile: 10, PixelFormat: 'yuv420p', Profile: 'Main', Type: 'Video', VideoRangeType: 'DOVI' }
        }
    ])('selects the AV1 raw format probe $probe for its stream alone', ({ probe, stream }) => {
        const rawFormatProbes = [ ...getSelectedVideoProbes(createItem([ stream ])) ].filter((selected: string): boolean => (
            selected.startsWith('av1-raw-format:')
        ));

        expect(rawFormatProbes).toEqual([ probe ]);
    });

    it('selects no AV1 raw format probe for 8-bit SDR Main or Main at 10 bits', () => {
        for (const stream of [
            { BitDepth: 8, Codec: 'av1', PixelFormat: 'yuv420p', Profile: 'Main', Type: 'Video', VideoRange: 'SDR', VideoRangeType: 'SDR' },
            { BitDepth: 10, Codec: 'av1', PixelFormat: 'yuv420p10le', Profile: 'Main', Type: 'Video', VideoRange: 'SDR', VideoRangeType: 'SDR' }
        ]) {
            expect([ ...getSelectedVideoProbes(createItem([ stream ])) ].some((selected: string): boolean => (
                selected.startsWith('av1-raw-format:')
            ))).toBe(false);
        }
    });

    it('unions the video streams of every source of an item', () => {
        const videoProbes = getSelectedVideoProbes(createItem([ SDR_H264_STREAM ], [ SDR_HEVC_STREAM ]));

        expect(videoProbes).toEqual(new Set([ 'h264-profiles', 'native-sdr:hevc', 'native-ultra-hd:hevc' ]));
    });

    it('selects no video probe for a codec only a decoder package decodes', () => {
        expect(getSelectedVideoProbes(createItem([ SDR_MPEG2_STREAM ]))).toEqual(new Set());
    });

    it('selects no video probe for an item without video streams', () => {
        expect(getSelectedVideoProbes(createItem([ FLAC_STREAM ]))).toEqual(new Set());
    });

    it.each([
        { item: undefined, name: 'no item' },
        { item: {}, name: 'an item without sources' },
        { item: { MediaSources: [ { MediaStreams: [ SDR_HEVC_STREAM ] }, {} ] }, name: 'a source without streams' },
        { item: createItem([ { Type: 'Video' } ]), name: 'a video stream without a codec' }
    ])('runs every video probe for $name', ({ item }) => {
        expect(getSelectedVideoProbes(item)).toEqual(new Set(CUSTOM_DECODE_VIDEO_PROBES));
    });

    it('runs only the selected probes and reports the rest as not probed', async () => {
        const harness = createEnvironment(new Set(), new Set());
        const environment = harness.environment;

        const capabilities = await new CustomDecodeCapabilityProbe(environment).probe(createItem([ SDR_HEVC_STREAM, FLAC_STREAM ]));

        expect(harness.rawHDRVideoOutputProbe).not.toHaveBeenCalled();
        expect(capabilities.video.h264).toMatchObject({ reason: 'not-probed', status: 'not-probed' });
        for (const codec of PACKAGE_VIDEO_CODECS) {
            expect(capabilities.video[codec]).toMatchObject({ reason: 'no-engine-decoder', status: 'unsupported' });
        }
        expect(capabilities.video.hevc.status).not.toBe('not-probed');
        expect(capabilities.h264Profiles).toBeUndefined();
        expect(Object.values(capabilities.hevcRangeExtensions ?? {}).map(
            (capability: { status: string }): string => capability.status
        )).toEqual(new Array(9).fill('not-probed'));
        expect(capabilities.probeStates).toMatchObject({
            'h264-profiles': 'not-probed',
            'native-audio': 'probed',
            'native-sdr:hevc': 'probed'
        });
        expect(capabilities.probeStates?.[RAW_HEVC_PROBE]).toBe('not-probed');
    });

    it('starts each probe once per page across items', async () => {
        const harness = createEnvironment(new Set(), new Set());
        const probe = new CustomDecodeCapabilityProbe(harness.environment);

        const hevcCapabilities = await probe.probe(createItem([ SDR_HEVC_STREAM ]));
        const mpeg2Capabilities = await probe.probe(createItem([ SDR_MPEG2_STREAM ]));
        const repeatedCapabilities = await probe.probe(createItem([ SDR_HEVC_STREAM ]));

        expect(repeatedCapabilities).toBe(hevcCapabilities);
        expect(harness.audioProbe).toHaveBeenCalledTimes(
            CUSTOM_WEB_CODECS_AUDIO_CODECS.length
                + CUSTOM_NATIVE_SURROUND_AUDIO_CODECS.length
        );
        // The SDR and Ultra HD configurations of the HEVC item
        expect(harness.videoProbe).toHaveBeenCalledTimes(2);
        expect(mpeg2Capabilities.audio.aac).toBe(hevcCapabilities.audio.aac);
        expect(mpeg2Capabilities.video.hevc.status).toBe('not-probed');
    });

    it('reports whether a result covers an item or media source', async () => {
        const harness = createEnvironment(new Set(), new Set());
        const hevcItem = createItem([ SDR_HEVC_STREAM ]);
        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe(hevcItem);
        const unscopedCapabilities: CustomDecodeCapabilities = { ...capabilities, probeStates: undefined };

        expect(hasProbedCustomDecodeSelection(capabilities, hevcItem)).toBe(true);
        expect(hasProbedCustomDecodeSelection(capabilities, { MediaStreams: [ SDR_HEVC_STREAM ] })).toBe(true);
        expect(hasProbedCustomDecodeSelection(capabilities, createItem([ SDR_H264_STREAM ]))).toBe(false);
        // An MPEG-2 item selects only the audio probes, which every result runs
        expect(hasProbedCustomDecodeSelection(capabilities, createItem([ SDR_MPEG2_STREAM ]))).toBe(true);
        expect(hasProbedCustomDecodeSelection(capabilities, {})).toBe(false);
        expect(hasProbedCustomDecodeSelection(unscopedCapabilities, createItem([ SDR_H264_STREAM ]))).toBe(true);
    });
});
