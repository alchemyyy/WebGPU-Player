import { describe, expect, it, vi, type Mock } from 'vitest';

import CustomDecodeCapabilityProbe, {
    type RawHDRVideoOutputProbeRequest,
    type WebCodecsCapabilityEnvironment
} from 'webgpu-player/capability/CustomDecodeCapabilities';
import {
    H264_RAW_FORMAT_PROBE_DEFINITIONS,
    H264_RAW_FORMAT_VARIANTS
} from 'webgpu-player/capability/H264RawFormatCapabilities';

type CapabilityHarness = {
    environment: WebCodecsCapabilityEnvironment
    outputProbe: Mock
    vectorLoader: Mock
};

function getVectorByteLength(assetPath: string): number | null {
    for (const variant of H264_RAW_FORMAT_VARIANTS) {
        const definition = H264_RAW_FORMAT_PROBE_DEFINITIONS[variant];
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
            h264ProfileProbe: null,
            h264RawFormatVectorLoader: vectorLoader,
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

function findProbeRequest(harness: CapabilityHarness, variant: typeof H264_RAW_FORMAT_VARIANTS[number]): RawHDRVideoOutputProbeRequest | undefined {
    const definition = H264_RAW_FORMAT_PROBE_DEFINITIONS[variant];
    return harness.outputProbe.mock.calls
        .map(call => call[0] as RawHDRVideoOutputProbeRequest)
        .find(outputRequest => outputRequest.codec === 'h264' && outputRequest.expectedFormat === definition.format);
}

describe('H.264 raw format capability probe', () => {
    it('qualifies each variant on the software decoder from its vector, exact copy format, and fingerprints in presentation order', async () => {
        const harness = createEnvironment();

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        for (const variant of H264_RAW_FORMAT_VARIANTS) {
            const definition = H264_RAW_FORMAT_PROBE_DEFINITIONS[variant];
            expect(capabilities.h264RawFormats?.[variant]).toEqual({
                bitDepth: definition.bitDepth,
                chromaFormat: definition.chromaFormat,
                codec: 'h264',
                codecString: definition.config.codec,
                format: definition.format,
                jellyfinProfile: definition.jellyfinProfile,
                pixelFormat: definition.pixelFormat,
                reason: 'output-copy-supported',
                status: 'supported',
                variant
            });
            expect(harness.vectorLoader).toHaveBeenCalledWith(definition.assetPath, 'auto');
            const probeRequest = findProbeRequest(harness, variant);
            // The access units decode in their order, I, P, B, while the decoder outputs the B frame before the P frame
            const [ key, predicted, bidirectional ] = definition.accessUnits;
            expect(probeRequest).toMatchObject({
                configuration: { codec: definition.config.codec, hardwareAcceleration: 'prefer-software' },
                expectedCodedHeight: 192,
                expectedCodedWidth: 192,
                expectedDecodedFrames: [ key, bidirectional, predicted ].map(accessUnit => ({
                    fingerprint: accessUnit.expectedDecodedFrameFingerprint,
                    timestamp: accessUnit.timestamp
                }))
            });
            expect(probeRequest?.encodedChunks.map(chunk => [ chunk.data.byteLength, chunk.timestamp, chunk.type ])).toEqual(
                definition.accessUnits.map(accessUnit => [ accessUnit.byteLength, accessUnit.timestamp, accessUnit.type ])
            );
        }
    });

    it('keeps a variant whose configuration or decoded copy fails unsupported, apart from the others', async () => {
        const harness = createEnvironment(
            (outputRequest: RawHDRVideoOutputProbeRequest): boolean => outputRequest.expectedFormat !== 'I422',
            (configuration: VideoDecoderConfig): boolean => !configuration.codec.startsWith('avc1.F4')
        );

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        expect(capabilities.h264RawFormats?.['high422-8']).toMatchObject({ reason: 'output-copy-unsupported', status: 'unsupported' });
        for (const variant of [ 'high444-8', 'high444-10' ] as const) {
            expect(capabilities.h264RawFormats?.[variant]).toMatchObject({ reason: 'config-unsupported', status: 'unsupported' });
        }
        expect(capabilities.h264RawFormats?.['high420-10'].status).toBe('supported');
        expect(capabilities.h264RawFormats?.['high422-10'].status).toBe('supported');
    });

    it('reports an unavailable vector or loader as unknown, never as support', async () => {
        const harness = createEnvironment();
        harness.environment.h264RawFormatVectorLoader = async (): Promise<ArrayBuffer> => {
            throw new Error('vector unavailable');
        };
        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();
        const withoutLoader = await new CustomDecodeCapabilityProbe({ ...harness.environment, h264RawFormatVectorLoader: null }).probe();

        for (const variant of H264_RAW_FORMAT_VARIANTS) {
            expect(capabilities.h264RawFormats?.[variant]).toMatchObject({ reason: 'asset-unavailable', status: 'unknown' });
            expect(withoutLoader.h264RawFormats?.[variant]).toMatchObject({ reason: 'api-unavailable', status: 'unknown' });
        }
    });

    it('refuses a vector whose length disagrees with its access units', async () => {
        const harness = createEnvironment();
        harness.environment.h264RawFormatVectorLoader = async (assetPath: string): Promise<ArrayBuffer> => (
            new ArrayBuffer((getVectorByteLength(assetPath) ?? 0) + 1)
        );

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        for (const variant of H264_RAW_FORMAT_VARIANTS) {
            expect(findProbeRequest(harness, variant)).toBeUndefined();
            expect(capabilities.h264RawFormats?.[variant]).toMatchObject({ reason: 'output-copy-unsupported', status: 'unsupported' });
        }
    });
});
