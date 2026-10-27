import type { EngineLibraryPath } from '../EngineAssets';
import { getCustomDecodeHardwareAcceleration } from '../pipeline/DecodeWorkerProtocol';
import type {
    HEVCRangeExtensionCapabilityReason,
    HEVCRangeExtensionChromaFormat,
    HEVCRangeExtensionPixelFormat,
    HEVCRangeExtensionProbeAccessUnit,
    HEVCRangeExtensionRawFormat
} from './HEVCRangeExtensionCapabilities';

// AV1 Main 10 is not a variant: the raw AV1 HDR probe qualifies it
export const AV1_RAW_FORMAT_VARIANTS = [
    'main420-8',
    'high444-8',
    'high444-10',
    'professional422-8',
    'professional422-10',
    'professional420-12',
    'professional422-12',
    'professional444-12'
] as const;

export type AV1RawFormatVariant = typeof AV1_RAW_FORMAT_VARIANTS[number];
export type AV1RawFormatBitDepth = 8 | 10 | 12;
export type AV1RawFormatJellyfinProfile = 'Main' | 'High' | 'Professional';

export type AV1RawFormatCapability = Readonly<{
    bitDepth: AV1RawFormatBitDepth
    chromaFormat: HEVCRangeExtensionChromaFormat
    codec: 'av1'
    codecString: string
    format: HEVCRangeExtensionRawFormat
    jellyfinProfile: AV1RawFormatJellyfinProfile
    pixelFormat: HEVCRangeExtensionPixelFormat
    reason: HEVCRangeExtensionCapabilityReason
    // A variant outside the negotiated item's selection is not probed, which is never a verdict
    status: 'not-probed' | 'supported' | 'unsupported' | 'unknown'
    variant: AV1RawFormatVariant
}>;

/** Each access unit is one temporal unit of the low-overhead OBU stream. */
export type AV1RawFormatProbeDefinition = Readonly<{
    accessUnits: readonly HEVCRangeExtensionProbeAccessUnit[]
    assetPath: EngineLibraryPath
    bitDepth: AV1RawFormatBitDepth
    chromaFormat: HEVCRangeExtensionChromaFormat
    config: VideoDecoderConfig
    format: HEVCRangeExtensionRawFormat
    jellyfinProfile: AV1RawFormatJellyfinProfile
    pixelFormat: HEVCRangeExtensionPixelFormat
    variant: AV1RawFormatVariant
}>;

const VECTOR_CODED_HEIGHT = 192;
const VECTOR_CODED_WIDTH = 192;

type AV1RawFormatVectorEvidence = Readonly<{
    accessUnits: readonly HEVCRangeExtensionProbeAccessUnit[]
    codecString: string
}>;

function parseOptionalBitDepth(value: unknown): number | null {
    if (value == null || (typeof value === 'string' && value.trim().length === 0)) {
        return null;
    }
    const parsedValue = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : null;
}

function createDefinition(
    variant: AV1RawFormatVariant,
    jellyfinProfile: AV1RawFormatJellyfinProfile,
    bitDepth: AV1RawFormatBitDepth,
    chromaFormat: HEVCRangeExtensionChromaFormat,
    pixelFormat: HEVCRangeExtensionPixelFormat,
    format: HEVCRangeExtensionRawFormat,
    evidence: AV1RawFormatVectorEvidence
): AV1RawFormatProbeDefinition {
    return Object.freeze({
        accessUnits: Object.freeze(evidence.accessUnits.map(accessUnit => Object.freeze({ ...accessUnit }))),
        assetPath: `webgpu-player/av1-raw/${variant}.bin`,
        bitDepth,
        chromaFormat,
        config: {
            codec: evidence.codecString,
            codedHeight: VECTOR_CODED_HEIGHT,
            codedWidth: VECTOR_CODED_WIDTH,
            hardwareAcceleration: getCustomDecodeHardwareAcceleration('raw-planes', false, 'av1'),
            optimizeForLatency: true
        },
        format,
        jellyfinProfile,
        pixelFormat,
        variant
    });
}

/** Per-variant AV1 raw-format probe definitions: decoder config, chroma format, bit depth, and the expected decoded-frame fingerprints. */
export const AV1_RAW_FORMAT_PROBE_DEFINITIONS: Readonly<Record<
    AV1RawFormatVariant,
    AV1RawFormatProbeDefinition
>> = Object.freeze({
    'main420-8': createDefinition(
        'main420-8',
        'Main',
        8,
        '420',
        'yuv420p',
        'I420',
        {
            accessUnits: [
                {
                    byteLength: 2_412,
                    expectedDecodedFrameFingerprint: 1_750_878_287,
                    timestamp: 0,
                    type: 'key'
                },
                {
                    byteLength: 1_081,
                    expectedDecodedFrameFingerprint: 2_435_266_265,
                    timestamp: 1_000_000,
                    type: 'delta'
                }
            ],
            codecString: 'av01.0.00M.08.0.110'
        }
    ),
    'high444-8': createDefinition(
        'high444-8',
        'High',
        8,
        '444',
        'yuv444p',
        'I444',
        {
            accessUnits: [
                {
                    byteLength: 6_839,
                    expectedDecodedFrameFingerprint: 991_343_345,
                    timestamp: 0,
                    type: 'key'
                },
                {
                    byteLength: 1_468,
                    expectedDecodedFrameFingerprint: 2_442_111_325,
                    timestamp: 1_000_000,
                    type: 'delta'
                }
            ],
            codecString: 'av01.1.00M.08.0.000'
        }
    ),
    'high444-10': createDefinition(
        'high444-10',
        'High',
        10,
        '444',
        'yuv444p10le',
        'I444P10',
        {
            accessUnits: [
                {
                    byteLength: 7_420,
                    expectedDecodedFrameFingerprint: 1_637_697_560,
                    timestamp: 0,
                    type: 'key'
                },
                {
                    byteLength: 1_359,
                    expectedDecodedFrameFingerprint: 2_586_901_718,
                    timestamp: 1_000_000,
                    type: 'delta'
                }
            ],
            codecString: 'av01.1.00M.10.0.000'
        }
    ),
    'professional422-8': createDefinition(
        'professional422-8',
        'Professional',
        8,
        '422',
        'yuv422p',
        'I422',
        {
            accessUnits: [
                {
                    byteLength: 4_472,
                    expectedDecodedFrameFingerprint: 645_782_140,
                    timestamp: 0,
                    type: 'key'
                },
                {
                    byteLength: 1_325,
                    expectedDecodedFrameFingerprint: 2_755_507_149,
                    timestamp: 1_000_000,
                    type: 'delta'
                }
            ],
            codecString: 'av01.2.00M.08.0.100'
        }
    ),
    'professional422-10': createDefinition(
        'professional422-10',
        'Professional',
        10,
        '422',
        'yuv422p10le',
        'I422P10',
        {
            accessUnits: [
                {
                    byteLength: 4_936,
                    expectedDecodedFrameFingerprint: 2_462_944_461,
                    timestamp: 0,
                    type: 'key'
                },
                {
                    byteLength: 1_208,
                    expectedDecodedFrameFingerprint: 354_112_061,
                    timestamp: 1_000_000,
                    type: 'delta'
                }
            ],
            codecString: 'av01.2.00M.10.0.100'
        }
    ),
    'professional420-12': createDefinition(
        'professional420-12',
        'Professional',
        12,
        '420',
        'yuv420p12le',
        'I420P12',
        {
            accessUnits: [
                {
                    byteLength: 2_595,
                    expectedDecodedFrameFingerprint: 2_209_574_760,
                    timestamp: 0,
                    type: 'key'
                },
                {
                    byteLength: 893,
                    expectedDecodedFrameFingerprint: 315_170_145,
                    timestamp: 1_000_000,
                    type: 'delta'
                }
            ],
            codecString: 'av01.2.00M.12.0.110'
        }
    ),
    'professional422-12': createDefinition(
        'professional422-12',
        'Professional',
        12,
        '422',
        'yuv422p12le',
        'I422P12',
        {
            accessUnits: [
                {
                    byteLength: 4_942,
                    expectedDecodedFrameFingerprint: 3_557_842_973,
                    timestamp: 0,
                    type: 'key'
                },
                {
                    byteLength: 1_075,
                    expectedDecodedFrameFingerprint: 3_449_248_946,
                    timestamp: 1_000_000,
                    type: 'delta'
                }
            ],
            codecString: 'av01.2.00M.12.0.100'
        }
    ),
    'professional444-12': createDefinition(
        'professional444-12',
        'Professional',
        12,
        '444',
        'yuv444p12le',
        'I444P12',
        {
            accessUnits: [
                {
                    byteLength: 7_396,
                    expectedDecodedFrameFingerprint: 2_164_797_336,
                    timestamp: 0,
                    type: 'key'
                },
                {
                    byteLength: 1_309,
                    expectedDecodedFrameFingerprint: 3_228_784_269,
                    timestamp: 1_000_000,
                    type: 'delta'
                }
            ],
            codecString: 'av01.2.00M.12.0.000'
        }
    )
});

/** Finds the AV1 raw-format variant for a stream; chroma and depth come from the pixel format, which must match the profile's variant exactly. */
export function getAV1RawFormatStreamDefinition(
    profile: string | null | undefined,
    pixelFormat: string | null | undefined,
    bitDepth: number | null | undefined
): AV1RawFormatProbeDefinition | null {
    // Profile aliases differ only in case, spacing, and punctuation
    const normalizedProfile = String(profile ?? '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const normalizedPixelFormat = String(pixelFormat ?? '').trim().toLowerCase();
    const normalizedBitDepth = typeof bitDepth === 'number' && Number.isFinite(bitDepth) ? bitDepth : null;
    for (const variant of AV1_RAW_FORMAT_VARIANTS) {
        const definition = AV1_RAW_FORMAT_PROBE_DEFINITIONS[variant];
        if (normalizedProfile === definition.jellyfinProfile.toUpperCase()
            && normalizedPixelFormat === definition.pixelFormat
            // Jellyfin can omit BitDepth when FFprobe exposes only PixelFormat
            && (normalizedBitDepth === null || normalizedBitDepth === definition.bitDepth)) {
            return definition;
        }
    }
    return null;
}

/** Finds the AV1 raw-format variant for a Jellyfin media stream; a missing BitDepth is taken from the pixel format. */
export function getAV1RawFormatStreamDefinitionFromMetadata(stream: unknown): AV1RawFormatProbeDefinition | null {
    if (!stream || typeof stream !== 'object') {
        return null;
    }
    const metadata = stream as {
        BitDepth?: unknown
        PixelFormat?: unknown
        Profile?: unknown
    };
    return getAV1RawFormatStreamDefinition(
        typeof metadata.Profile === 'string' ? metadata.Profile : null,
        typeof metadata.PixelFormat === 'string' ? metadata.PixelFormat : null,
        parseOptionalBitDepth(metadata.BitDepth)
    );
}
