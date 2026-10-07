import { describe, expect, it, vi } from 'vitest';

import CustomDecodeCapabilityProbe, {
    type RawHDRVideoOutputProbeRequest,
    type WebCodecsCapabilityEnvironment
} from 'webgpu-player/capability/CustomDecodeCapabilities';
import {
    HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS,
    HEVC_RANGE_EXTENSION_VARIANTS
} from 'webgpu-player/capability/HEVCRangeExtensionCapabilities';

type CapabilityHarness = {
    environment: WebCodecsCapabilityEnvironment
    vectorLoader: ReturnType<typeof vi.fn>
    outputProbe: ReturnType<typeof vi.fn>
    videoDecoder: Pick<typeof VideoDecoder, 'isConfigSupported'>
};

function createEnvironment(
    outputSupported: (request: RawHDRVideoOutputProbeRequest) => boolean = (): boolean => true
): CapabilityHarness {
    const vectorLoader = vi.fn(async (assetPath: string): Promise<ArrayBuffer> => {
        for (const variant of HEVC_RANGE_EXTENSION_VARIANTS) {
            const definition = HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant];
            if (definition.assetPath !== assetPath) {
                continue;
            }
            const byteLength = definition.accessUnits.reduce(
                (totalByteLength: number, accessUnit): number => (
                    totalByteLength + accessUnit.byteLength
                ),
                0
            );
            return new ArrayBuffer(byteLength);
        }
        throw new Error('Unexpected vector asset path');
    });
    const outputProbe = vi.fn(async (request: RawHDRVideoOutputProbeRequest) => ({
        outputCopySupported: outputSupported(request)
    }));
    const videoDecoder = {
        isConfigSupported: vi.fn(async (configuration: VideoDecoderConfig) => ({
            config: configuration,
            supported: true
        }))
    };
    return {
        environment: {
            audioDecoder: null,
            bundledDTSExactProbe: null,
            bundledHEVCExactProbe: null,
            bundledJPEG2000ExactProbe: null,
            bundledMPEG2ExactProbe: null,
            bundledTrueHDExactProbe: null,
            bundledVC1ExactProbe: null,
            h264ProfileProbe: null,
            hevcRangeExtensionVectorLoader: vectorLoader,
            nativeAudioOutputProbe: null,
            nativeDolbyVisionVideoOutputProbe: null,
            nativeHDRVideoOutputProbe: null,
            nativeVideoOutputProbe: null,
            rawHDRVideoOutputProbe: outputProbe,
            videoDecoder
        },
        vectorLoader,
        outputProbe,
        videoDecoder
    };
}

describe('HEVC range-extension capability probe', () => {
    it('requires independent config, vector, decoded format, and fingerprint evidence', async () => {
        const harness = createEnvironment();

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        for (const variant of HEVC_RANGE_EXTENSION_VARIANTS) {
            const definition = HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant];
            expect(capabilities.hevcRangeExtensions?.[variant]).toEqual({
                bitDepth: definition.bitDepth,
                chromaFormat: definition.chromaFormat,
                codec: 'hevc',
                codecString: definition.config.codec,
                format: definition.format,
                jellyfinProfile: definition.jellyfinProfile,
                pixelFormat: definition.pixelFormat,
                reason: 'output-copy-supported',
                status: 'supported',
                variant
            });
            expect(harness.vectorLoader).toHaveBeenCalledWith(definition.assetPath);
            expect(harness.outputProbe).toHaveBeenCalledWith(expect.objectContaining({
                configuration: definition.config,
                encodedChunks: definition.accessUnits.map(accessUnit => expect.objectContaining({
                    data: expect.any(Uint8Array),
                    timestamp: accessUnit.timestamp,
                    type: accessUnit.type
                })),
                expectedCodedHeight: 192,
                expectedCodedWidth: 192,
                expectedDecodedFrames: definition.accessUnits.map(accessUnit => ({
                    fingerprint: accessUnit.expectedDecodedFrameFingerprint,
                    timestamp: accessUnit.timestamp
                })),
                expectedFormat: definition.format
            }));
            const probeRequest = harness.outputProbe.mock.calls.find(call => {
                const request = call[0] as RawHDRVideoOutputProbeRequest;
                return request.configuration.codec === definition.config.codec
                    && request.expectedCodedHeight === 192
                    && request.expectedCodedWidth === 192
                    && request.expectedFormat === definition.format;
            })?.[0] as RawHDRVideoOutputProbeRequest;
            expect(probeRequest.encodedChunks.map(chunk => chunk.data.byteLength)).toEqual(
                definition.accessUnits.map(accessUnit => accessUnit.byteLength)
            );
        }
    });

    it('does not authorize a config-only format whose decoded copy is wrong', async () => {
        const harness = createEnvironment((request: RawHDRVideoOutputProbeRequest): boolean => (
            request.expectedFormat !== 'I422P12'
        ));

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        expect(capabilities.hevcRangeExtensions?.['main422-12']).toMatchObject({
            reason: 'output-copy-unsupported',
            status: 'unsupported'
        });
        expect(capabilities.hevcRangeExtensions?.['main12-420'].status).toBe('supported');
        expect(capabilities.hevcRangeExtensions?.['main444-12'].status).toBe('supported');
    });

    it('reports vector-loading failures as unknown instead of widening support', async () => {
        const harness = createEnvironment();
        harness.environment.hevcRangeExtensionVectorLoader = async (): Promise<ArrayBuffer> => {
            throw new Error('vector unavailable');
        };

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        for (const variant of HEVC_RANGE_EXTENSION_VARIANTS) {
            expect(capabilities.hevcRangeExtensions?.[variant]).toMatchObject({
                reason: 'probe-exception',
                status: 'unknown'
            });
        }
    });
});
