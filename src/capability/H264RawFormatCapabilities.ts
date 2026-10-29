import type { EngineLibraryPath } from '../EngineAssets';
import { getCustomDecodeHardwareAcceleration } from '../pipeline/DecodeWorkerProtocol';
import type {
    HEVCRangeExtensionCapabilityReason,
    HEVCRangeExtensionChromaFormat,
    HEVCRangeExtensionProbeAccessUnit,
    HEVCRangeExtensionRawFormat
} from './HEVCRangeExtensionCapabilities';

// 8-bit 4:2:0 is not a variant: High and the profiles below it take the native VideoFrame route
export const H264_RAW_FORMAT_VARIANTS = [
    'high420-10',
    'high422-8',
    'high422-10',
    'high444-8',
    'high444-10'
] as const;

export type H264RawFormatVariant = typeof H264_RAW_FORMAT_VARIANTS[number];
export type H264RawFormatBitDepth = 8 | 10;
export type H264RawFormatPixelFormat = 'yuv420p10le' | 'yuv422p' | 'yuv422p10le' | 'yuv444p' | 'yuv444p10le';

export type H264RawFormatCapability = Readonly<{
    bitDepth: H264RawFormatBitDepth
    chromaFormat: HEVCRangeExtensionChromaFormat
    codec: 'h264'
    codecString: string
    format: HEVCRangeExtensionRawFormat
    jellyfinProfile: string
    pixelFormat: H264RawFormatPixelFormat
    reason: HEVCRangeExtensionCapabilityReason
    // A variant outside the negotiated item's selection is not probed, which is never a verdict
    status: 'not-probed' | 'supported' | 'unsupported' | 'unknown'
    variant: H264RawFormatVariant
}>;

/** Each access unit is one Annex B access unit, in decode order, stamped with its presentation time. */
export type H264RawFormatProbeDefinition = Readonly<{
    accessUnits: readonly HEVCRangeExtensionProbeAccessUnit[]
    assetPath: EngineLibraryPath
    bitDepth: H264RawFormatBitDepth
    chromaFormat: HEVCRangeExtensionChromaFormat
    config: VideoDecoderConfig
    format: HEVCRangeExtensionRawFormat
    /** The FFmpeg name of the vector's own profile */
    jellyfinProfile: string
    pixelFormat: H264RawFormatPixelFormat
    variant: H264RawFormatVariant
}>;

/** An H.264 profile beyond High, by the name FFmpeg gives it and Jellyfin reports in MediaStream.Profile, and the chroma formats it codes. */
export type H264RawFormatProfile = Readonly<{
    chromaFormats: readonly HEVCRangeExtensionChromaFormat[]
    name: string
}>;

const VECTOR_CODED_HEIGHT = 192;
const VECTOR_CODED_WIDTH = 192;
const CHROMA_FORMATS_TO_420: readonly HEVCRangeExtensionChromaFormat[] = Object.freeze([ '420' ]);
const CHROMA_FORMATS_TO_422: readonly HEVCRangeExtensionChromaFormat[] = Object.freeze([ '420', '422' ]);
const CHROMA_FORMATS_TO_444: readonly HEVCRangeExtensionChromaFormat[] = Object.freeze([ '420', '422', '444' ]);

/**
 * The profiles one decoder decodes beyond High, as `libavcodec/profiles.c` names them; the intra profiles and the removed High 4:4:4 code the formats of their family.
 * 4:0:0, which each also codes, and depths past 10 bits are no variant.
 */
export const H264_RAW_FORMAT_PROFILES: readonly H264RawFormatProfile[] = Object.freeze([
    Object.freeze({ chromaFormats: CHROMA_FORMATS_TO_420, name: 'High 10' }),
    Object.freeze({ chromaFormats: CHROMA_FORMATS_TO_420, name: 'High 10 Intra' }),
    Object.freeze({ chromaFormats: CHROMA_FORMATS_TO_422, name: 'High 4:2:2' }),
    Object.freeze({ chromaFormats: CHROMA_FORMATS_TO_422, name: 'High 4:2:2 Intra' }),
    Object.freeze({ chromaFormats: CHROMA_FORMATS_TO_444, name: 'High 4:4:4' }),
    Object.freeze({ chromaFormats: CHROMA_FORMATS_TO_444, name: 'High 4:4:4 Predictive' }),
    Object.freeze({ chromaFormats: CHROMA_FORMATS_TO_444, name: 'High 4:4:4 Intra' }),
    Object.freeze({ chromaFormats: CHROMA_FORMATS_TO_444, name: 'CAVLC 4:4:4' })
]);

// FFmpeg's H.264 decoder names a full-range 8-bit picture with the yuvj format of its chroma, whose planes are the yuv format's
const PIXEL_FORMAT_ALIASES: Readonly<Record<string, H264RawFormatPixelFormat>> = Object.freeze({
    yuvj422p: 'yuv422p',
    yuvj444p: 'yuv444p'
});

type H264RawFormatVectorEvidence = Readonly<{
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

// Profile aliases differ only in case, spacing, and punctuation
function normalizeProfileToken(profile: unknown): string {
    return String(profile ?? '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

function createDefinition(
    variant: H264RawFormatVariant,
    jellyfinProfile: string,
    bitDepth: H264RawFormatBitDepth,
    chromaFormat: HEVCRangeExtensionChromaFormat,
    pixelFormat: H264RawFormatPixelFormat,
    format: HEVCRangeExtensionRawFormat,
    evidence: H264RawFormatVectorEvidence
): H264RawFormatProbeDefinition {
    return Object.freeze({
        accessUnits: Object.freeze(evidence.accessUnits.map(accessUnit => Object.freeze({ ...accessUnit }))),
        assetPath: `webgpu-player/h264-raw/${variant}.bin`,
        bitDepth,
        chromaFormat,
        config: {
            codec: evidence.codecString,
            codedHeight: VECTOR_CODED_HEIGHT,
            codedWidth: VECTOR_CODED_WIDTH,
            hardwareAcceleration: getCustomDecodeHardwareAcceleration('raw-planes', false, 'avc'),
            optimizeForLatency: true
        },
        format,
        jellyfinProfile,
        pixelFormat,
        variant
    });
}

/**
 * Per-variant H.264 raw-format probe definitions: decoder config, chroma format, bit depth, and the expected decoded-frame fingerprints.
 * Each vector codes an I, a P, then a B access unit, which presents between the other two.
 */
export const H264_RAW_FORMAT_PROBE_DEFINITIONS: Readonly<Record<
    H264RawFormatVariant,
    H264RawFormatProbeDefinition
>> = Object.freeze({
    'high420-10': createDefinition(
        'high420-10',
        'High 10',
        10,
        '420',
        'yuv420p10le',
        'I420P10',
        {
            accessUnits: [
                { byteLength: 3_644, expectedDecodedFrameFingerprint: 3_372_277_727, timestamp: 0, type: 'key' },
                { byteLength: 2_367, expectedDecodedFrameFingerprint: 2_206_859_063, timestamp: 2_000_000, type: 'delta' },
                { byteLength: 2_424, expectedDecodedFrameFingerprint: 4_248_514_697, timestamp: 1_000_000, type: 'delta' }
            ],
            codecString: 'avc1.6E000B'
        }
    ),
    'high422-8': createDefinition(
        'high422-8',
        'High 4:2:2',
        8,
        '422',
        'yuv422p',
        'I422',
        {
            accessUnits: [
                { byteLength: 4_286, expectedDecodedFrameFingerprint: 1_199_520_366, timestamp: 0, type: 'key' },
                { byteLength: 2_853, expectedDecodedFrameFingerprint: 4_007_075_873, timestamp: 2_000_000, type: 'delta' },
                { byteLength: 2_580, expectedDecodedFrameFingerprint: 4_116_879_377, timestamp: 1_000_000, type: 'delta' }
            ],
            codecString: 'avc1.7A000B'
        }
    ),
    'high422-10': createDefinition(
        'high422-10',
        'High 4:2:2',
        10,
        '422',
        'yuv422p10le',
        'I422P10',
        {
            accessUnits: [
                { byteLength: 4_335, expectedDecodedFrameFingerprint: 1_854_869_281, timestamp: 0, type: 'key' },
                { byteLength: 2_821, expectedDecodedFrameFingerprint: 84_893_698, timestamp: 2_000_000, type: 'delta' },
                { byteLength: 2_583, expectedDecodedFrameFingerprint: 2_866_151_398, timestamp: 1_000_000, type: 'delta' }
            ],
            codecString: 'avc1.7A000B'
        }
    ),
    'high444-8': createDefinition(
        'high444-8',
        'High 4:4:4 Predictive',
        8,
        '444',
        'yuv444p',
        'I444',
        {
            accessUnits: [
                { byteLength: 3_581, expectedDecodedFrameFingerprint: 1_794_184_940, timestamp: 0, type: 'key' },
                { byteLength: 2_595, expectedDecodedFrameFingerprint: 2_303_389_642, timestamp: 2_000_000, type: 'delta' },
                { byteLength: 2_153, expectedDecodedFrameFingerprint: 738_321_613, timestamp: 1_000_000, type: 'delta' }
            ],
            codecString: 'avc1.F4000B'
        }
    ),
    'high444-10': createDefinition(
        'high444-10',
        'High 4:4:4 Predictive',
        10,
        '444',
        'yuv444p10le',
        'I444P10',
        {
            accessUnits: [
                { byteLength: 3_686, expectedDecodedFrameFingerprint: 3_943_187_793, timestamp: 0, type: 'key' },
                { byteLength: 2_570, expectedDecodedFrameFingerprint: 281_888_925, timestamp: 2_000_000, type: 'delta' },
                { byteLength: 2_088, expectedDecodedFrameFingerprint: 1_482_372_203, timestamp: 1_000_000, type: 'delta' }
            ],
            codecString: 'avc1.F4000B'
        }
    )
});

/** Finds a profile beyond High by its Jellyfin name, whatever its case, spacing, and punctuation. */
export function getH264RawFormatProfile(profile: unknown): H264RawFormatProfile | null {
    const normalizedProfile = normalizeProfileToken(profile);
    return H264_RAW_FORMAT_PROFILES.find(
        (candidate: H264RawFormatProfile): boolean => normalizeProfileToken(candidate.name) === normalizedProfile
    ) ?? null;
}

/** Returns the variants a profile codes at a bit depth, in variant order; a profile codes 8-bit 4:2:0 too, which no variant takes. */
export function getH264RawFormatProfileVariants(profile: H264RawFormatProfile, bitDepth: number): H264RawFormatVariant[] {
    return H264_RAW_FORMAT_VARIANTS.filter((variant: H264RawFormatVariant): boolean => {
        const definition = H264_RAW_FORMAT_PROBE_DEFINITIONS[variant];
        return definition.bitDepth === bitDepth && profile.chromaFormats.includes(definition.chromaFormat);
    });
}

/**
 * Finds the H.264 raw-format variant of a stream: a profile beyond High, and the variant of its pixel format, which the profile must code.
 * The profile names the decoder's tools, which one decoder decodes, while the pixel format alone names the planes.
 */
export function getH264RawFormatStreamDefinition(
    profile: string | null | undefined,
    pixelFormat: string | null | undefined,
    bitDepth: number | null | undefined
): H264RawFormatProbeDefinition | null {
    const rawFormatProfile = getH264RawFormatProfile(profile);
    if (!rawFormatProfile) {
        return null;
    }
    const trimmedPixelFormat = String(pixelFormat ?? '').trim().toLowerCase();
    const normalizedPixelFormat = PIXEL_FORMAT_ALIASES[trimmedPixelFormat] ?? trimmedPixelFormat;
    const normalizedBitDepth = typeof bitDepth === 'number' && Number.isFinite(bitDepth) ? bitDepth : null;
    for (const variant of H264_RAW_FORMAT_VARIANTS) {
        const definition = H264_RAW_FORMAT_PROBE_DEFINITIONS[variant];
        if (normalizedPixelFormat === definition.pixelFormat
            && rawFormatProfile.chromaFormats.includes(definition.chromaFormat)
            // Jellyfin can omit BitDepth when FFprobe exposes only PixelFormat
            && (normalizedBitDepth === null || normalizedBitDepth === definition.bitDepth)) {
            return definition;
        }
    }
    return null;
}

/** Finds the H.264 raw-format variant for a Jellyfin media stream; a missing BitDepth is taken from the pixel format. */
export function getH264RawFormatStreamDefinitionFromMetadata(stream: unknown): H264RawFormatProbeDefinition | null {
    if (!stream || typeof stream !== 'object') {
        return null;
    }
    const metadata = stream as {
        BitDepth?: unknown
        PixelFormat?: unknown
        Profile?: unknown
    };
    return getH264RawFormatStreamDefinition(
        typeof metadata.Profile === 'string' ? metadata.Profile : null,
        typeof metadata.PixelFormat === 'string' ? metadata.PixelFormat : null,
        parseOptionalBitDepth(metadata.BitDepth)
    );
}

/**
 * Returns the variants whose capabilities decide an H.264 raw-format stream's negotiation, or none for another stream.
 * A profile name hides the chroma format from Jellyfin, so the host advertises the profile at a depth only when every variant it codes there qualifies,
 * and each of them is probed.
 */
export function getH264RawFormatNegotiationVariants(stream: unknown): readonly H264RawFormatVariant[] {
    const definition = getH264RawFormatStreamDefinitionFromMetadata(stream);
    if (!definition || !stream || typeof stream !== 'object' || !('Profile' in stream)) {
        return [];
    }
    const profile = getH264RawFormatProfile(stream.Profile);
    return profile ? getH264RawFormatProfileVariants(profile, definition.bitDepth) : [];
}
