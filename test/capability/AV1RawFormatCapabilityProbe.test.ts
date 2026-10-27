import { describe, expect, it, vi, type Mock } from 'vitest';

import CustomDecodeCapabilityProbe, {
    type RawHDRVideoOutputProbeRequest,
    type WebCodecsCapabilityEnvironment
} from 'webgpu-player/capability/CustomDecodeCapabilities';
import {
    AV1_RAW_FORMAT_PROBE_DEFINITIONS,
    AV1_RAW_FORMAT_VARIANTS
} from 'webgpu-player/capability/AV1RawFormatCapabilities';

type CapabilityHarness = {
    environment: WebCodecsCapabilityEnvironment
    outputProbe: Mock
    vectorLoader: Mock
};

function getVectorByteLength(assetPath: string): number | null {
    for (const variant of AV1_RAW_FORMAT_VARIANTS) {
        const definition = AV1_RAW_FORMAT_PROBE_DEFINITIONS[variant];
        if (definition.assetPath === assetPath) {
            return definition.accessUnits.reduce((totalByteLength: number, accessUnit): number => totalByteLength + accessUnit.byteLength, 0);
        }
    }
    return null;
}

function createEnvironment(
    outputSupported: (request: RawHDRVideoOutputProbeRequest) => boolean = (): boolean => true,
    configurationSupported: (configuration: VideoDecoderConfig) => boolean = (): boolean => true
): CapabilityHarness {
    const vectorLoader = vi.fn(async (assetPath: string): Promise<ArrayBuffer> => {
        const byteLength = getVectorByteLength(assetPath);
        if (byteLength === null) {
            throw new Error('Unexpected vector asset path');
        }
        return new ArrayBuffer(byteLength);
    });
    const outputProbe = vi.fn(async (request: RawHDRVideoOutputProbeRequest) => ({
        outputCopySupported: outputSupported(request)
    }));
    return {
        environment: {
            audioDecoder: null,
            av1RawFormatVectorLoader: vectorLoader,
            h264ProfileProbe: null,
            nativeAudioOutputProbe: null,
            nativeDolbyVisionVideoOutputProbe: null,
            nativeHDRVideoOutputProbe: null,
            nativeVideoOutputProbe: null,
            rawHDRVideoOutputProbe: outputProbe,
            videoDecoder: {
                isConfigSupported: vi.fn(async (configuration: VideoDecoderConfig) => ({
                    config: configuration,
                    supported: configurationSupported(configuration)
                }))
            }
        },
        outputProbe,
        vectorLoader
    };
}

describe('AV1 raw format capability probe', () => {
    it('qualifies each variant on the software decoder from its vector, exact copy format, and fingerprints', async () => {
        const harness = createEnvironment();

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        for (const variant of AV1_RAW_FORMAT_VARIANTS) {
            const definition = AV1_RAW_FORMAT_PROBE_DEFINITIONS[variant];
            expect(capabilities.av1RawFormats?.[variant]).toEqual({
                bitDepth: definition.bitDepth,
                chromaFormat: definition.chromaFormat,
                codec: 'av1',
                codecString: definition.config.codec,
                format: definition.format,
                jellyfinProfile: definition.jellyfinProfile,
                pixelFormat: definition.pixelFormat,
                reason: 'output-copy-supported',
                status: 'supported',
                variant
            });
            // A negotiation downloads at the default priority; only a background run asks for low
            expect(harness.vectorLoader).toHaveBeenCalledWith(definition.assetPath, 'auto');
            const probeRequest = harness.outputProbe.mock.calls
                .map(call => call[0] as RawHDRVideoOutputProbeRequest)
                .find(outputRequest => outputRequest.configuration.codec === definition.config.codec && outputRequest.expectedFormat === definition.format);
            expect(probeRequest).toMatchObject({
                codec: 'av1',
                configuration: { hardwareAcceleration: 'prefer-software' },
                expectedCodedHeight: 192,
                expectedCodedWidth: 192,
                expectedDecodedFrames: definition.accessUnits.map(accessUnit => ({
                    fingerprint: accessUnit.expectedDecodedFrameFingerprint,
                    timestamp: accessUnit.timestamp
                }))
            });
            expect(probeRequest?.encodedChunks.map(chunk => [ chunk.data.byteLength, chunk.type ])).toEqual(
                definition.accessUnits.map(accessUnit => [ accessUnit.byteLength, accessUnit.type ])
            );
        }
    });

    it('keeps a variant whose configuration or decoded copy fails unsupported, apart from the others', async () => {
        const harness = createEnvironment(
            (outputRequest: RawHDRVideoOutputProbeRequest): boolean => outputRequest.expectedFormat !== 'I444',
            (configuration: VideoDecoderConfig): boolean => !configuration.codec.startsWith('av01.2.00M.12')
        );

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        expect(capabilities.av1RawFormats?.['high444-8']).toMatchObject({ reason: 'output-copy-unsupported', status: 'unsupported' });
        for (const variant of [ 'professional420-12', 'professional422-12', 'professional444-12' ] as const) {
            expect(capabilities.av1RawFormats?.[variant]).toMatchObject({ reason: 'config-unsupported', status: 'unsupported' });
        }
        expect(capabilities.av1RawFormats?.['high444-10'].status).toBe('supported');
        expect(capabilities.av1RawFormats?.['main420-8'].status).toBe('supported');
    });

    it('reports an unavailable vector as unknown, never as support', async () => {
        const harness = createEnvironment();
        harness.environment.av1RawFormatVectorLoader = async (): Promise<ArrayBuffer> => {
            throw new Error('vector unavailable');
        };

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        for (const variant of AV1_RAW_FORMAT_VARIANTS) {
            expect(capabilities.av1RawFormats?.[variant]).toMatchObject({ reason: 'asset-unavailable', status: 'unknown' });
        }
    });

    it('refuses a vector whose length disagrees with its temporal units', async () => {
        const harness = createEnvironment();
        harness.environment.av1RawFormatVectorLoader = async (assetPath: string): Promise<ArrayBuffer> => new ArrayBuffer((getVectorByteLength(assetPath) ?? 0) + 1);

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();
        // Only the 4K Main 10 probe, which downloads nothing, reaches the decoder
        expect(harness.outputProbe.mock.calls.every(call => (call[0] as RawHDRVideoOutputProbeRequest).expectedCodedWidth !== 192)).toBe(true);
        expect(capabilities.av1RawFormats?.['high444-8']).toMatchObject({ reason: 'output-copy-unsupported', status: 'unsupported' });
    });
});
