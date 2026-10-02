import type { EngineLibraryPath } from '../EngineAssets';
import {
    getCustomDecodeHardwareAcceleration,
    type CustomDecodeRawVideoFrameFormat
} from './DecodeWorkerProtocol';

export const HEVC_RANGE_EXTENSION_VARIANTS = [
    'rext420-8',
    'main422-8',
    'main444-8',
    'rext420-10',
    'main422-10',
    'main444-10',
    'main12-420',
    'main422-12',
    'main444-12'
] as const;

export type HEVCRangeExtensionVariant = typeof HEVC_RANGE_EXTENSION_VARIANTS[number];
export type HEVCRangeExtensionBitDepth = 8 | 10 | 12;
export type HEVCRangeExtensionChromaFormat = '420' | '422' | '444';
export type HEVCRangeExtensionPixelFormat =
    | 'yuv420p'
    | 'yuv420p10le'
    | 'yuv420p12le'
    | 'yuv422p'
    | 'yuv422p10le'
    | 'yuv422p12le'
    | 'yuv444p'
    | 'yuv444p10le'
    | 'yuv444p12le';
export type HEVCRangeExtensionRawFormat = Extract<
    CustomDecodeRawVideoFrameFormat,
    | 'I420'
    | 'I420P10'
    | 'I420P12'
    | 'I422'
    | 'I422P10'
    | 'I422P12'
    | 'I444'
    | 'I444P10'
    | 'I444P12'
>;

export type HEVCRangeExtensionCapabilityReason =
    | 'api-unavailable'
    | 'config-unsupported'
    | 'output-copy-supported'
    | 'output-copy-unsupported'
    | 'probe-exception'
    | 'probe-timeout';

export type HEVCRangeExtensionCapability = Readonly<{
    bitDepth: HEVCRangeExtensionBitDepth
    chromaFormat: HEVCRangeExtensionChromaFormat
    codec: 'hevc'
    codecString: string
    format: HEVCRangeExtensionRawFormat
    jellyfinProfile: string
    pixelFormat: HEVCRangeExtensionPixelFormat
    reason: HEVCRangeExtensionCapabilityReason
    status: 'supported' | 'unsupported' | 'unknown'
    variant: HEVCRangeExtensionVariant
}>;

export type HEVCRangeExtensionProbeAccessUnit = Readonly<{
    byteLength: number
    expectedDecodedFrameFingerprint: number
    timestamp: number
    type: 'delta' | 'key'
}>;

export type HEVCRangeExtensionProbeDefinition = Readonly<{
    accessUnits: readonly HEVCRangeExtensionProbeAccessUnit[]
    assetPath: EngineLibraryPath
    bitDepth: HEVCRangeExtensionBitDepth
    chromaFormat: HEVCRangeExtensionChromaFormat
    config: VideoDecoderConfig
    fixtureSHA256: string
    format: HEVCRangeExtensionRawFormat
    jellyfinProfile: string
    pixelFormat: HEVCRangeExtensionPixelFormat
    variant: HEVCRangeExtensionVariant
}>;

const FIXTURE_CODED_HEIGHT = 192;
const FIXTURE_CODED_WIDTH = 192;

type HEVCRangeExtensionFixtureEvidence = Readonly<{
    accessUnits: readonly HEVCRangeExtensionProbeAccessUnit[]
    codecString: string
    fixtureSHA256: string
}>;

function parseOptionalBitDepth(value: unknown): number | null {
    if (value == null || (typeof value === 'string' && value.trim().length === 0)) {
        return null;
    }
    const parsedValue = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : null;
}

function createDefinition(
    variant: HEVCRangeExtensionVariant,
    jellyfinProfile: string,
    bitDepth: HEVCRangeExtensionBitDepth,
    chromaFormat: HEVCRangeExtensionChromaFormat,
    pixelFormat: HEVCRangeExtensionPixelFormat,
    format: HEVCRangeExtensionRawFormat,
    evidence: HEVCRangeExtensionFixtureEvidence
): HEVCRangeExtensionProbeDefinition {
    return Object.freeze({
        accessUnits: Object.freeze(evidence.accessUnits.map(
            accessUnit => Object.freeze({ ...accessUnit })
        )),
        assetPath: `webgpu-player/hevc-rext/${variant}.bin`,
        bitDepth,
        chromaFormat,
        config: {
            codec: evidence.codecString,
            codedHeight: FIXTURE_CODED_HEIGHT,
            codedWidth: FIXTURE_CODED_WIDTH,
            hardwareAcceleration: getCustomDecodeHardwareAcceleration('raw-planes', 'native'),
            optimizeForLatency: true
        },
        fixtureSHA256: evidence.fixtureSHA256,
        format,
        jellyfinProfile,
        pixelFormat,
        variant
    });
}

/** Exact Rext config, decoded-output, chroma, and bit-depth probe definitions. */
export const HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS: Readonly<Record<
    HEVCRangeExtensionVariant,
    HEVCRangeExtensionProbeDefinition
>> = Object.freeze({
    'rext420-8': createDefinition(
        'rext420-8',
        'Rext',
        8,
        '420',
        'yuv420p',
        'I420',
        {
            accessUnits: [
                {
                    byteLength: 3_452,
                    expectedDecodedFrameFingerprint: 3_329_959_031,
                    timestamp: 0,
                    type: 'key'
                },
                {
                    byteLength: 2_905,
                    expectedDecodedFrameFingerprint: 201_088_281,
                    timestamp: 1_000_000,
                    type: 'delta'
                }
            ],
            codecString: 'hvc1.4.10.L93.9F.88',
            fixtureSHA256: '7cecbf5129d187d90a1434e3b80cea9c90bfb15a6156b6de5114353bf278ecc4'
        }
    ),
    'rext420-10': createDefinition(
        'rext420-10',
        'Rext',
        10,
        '420',
        'yuv420p10le',
        'I420P10',
        {
            accessUnits: [
                {
                    byteLength: 3_451,
                    expectedDecodedFrameFingerprint: 913_148_567,
                    timestamp: 0,
                    type: 'key'
                },
                {
                    byteLength: 3_011,
                    expectedDecodedFrameFingerprint: 991_175_167,
                    timestamp: 1_000_000,
                    type: 'delta'
                }
            ],
            codecString: 'hvc1.4.10.L93.9D.88',
            fixtureSHA256: '59fbe3b5832ca72f6df3f64220ac71637760afb5f5ac8d2c227def4c93e823e2'
        }
    ),
    'main12-420': createDefinition(
        'main12-420',
        'Main 12',
        12,
        '420',
        'yuv420p12le',
        'I420P12',
        {
            accessUnits: [
                {
                    byteLength: 3_442,
                    expectedDecodedFrameFingerprint: 1_429_287_902,
                    timestamp: 0,
                    type: 'key'
                },
                {
                    byteLength: 3_013,
                    expectedDecodedFrameFingerprint: 2_430_170_723,
                    timestamp: 1_000_000,
                    type: 'delta'
                }
            ],
            codecString: 'hvc1.4.10.L93.99.88',
            fixtureSHA256: '6e8c6e28a8380740cb21aef29a8864a81d56b7a686424a1944f0abe3c7b61279'
        }
    ),
    'main422-8': createDefinition(
        'main422-8',
        'Main 4:2:2 10',
        8,
        '422',
        'yuv422p',
        'I422',
        {
            accessUnits: [
                {
                    byteLength: 4_148,
                    expectedDecodedFrameFingerprint: 1_183_394_674,
                    timestamp: 0,
                    type: 'key'
                },
                {
                    byteLength: 3_582,
                    expectedDecodedFrameFingerprint: 2_295_522_323,
                    timestamp: 1_000_000,
                    type: 'delta'
                }
            ],
            codecString: 'hvc1.4.10.L93.9D.08',
            fixtureSHA256: '32a61c466d8b6daeff30637b9772d3cf93b1e9c24d01bfdee657f4a1158dc5a9'
        }
    ),
    'main422-10': createDefinition(
        'main422-10',
        'Main 4:2:2 10',
        10,
        '422',
        'yuv422p10le',
        'I422P10',
        {
            accessUnits: [
                {
                    byteLength: 4_181,
                    expectedDecodedFrameFingerprint: 164_386_383,
                    timestamp: 0,
                    type: 'key'
                },
                {
                    byteLength: 3_655,
                    expectedDecodedFrameFingerprint: 4_284_346_653,
                    timestamp: 1_000_000,
                    type: 'delta'
                }
            ],
            codecString: 'hvc1.4.10.L93.9D.08',
            fixtureSHA256: '248eb64dbb2bb30ecd689e453a38dcf34125af51c205f7c5da8577a0228639e5'
        }
    ),
    'main422-12': createDefinition(
        'main422-12',
        'Main 4:2:2 12',
        12,
        '422',
        'yuv422p12le',
        'I422P12',
        {
            accessUnits: [
                {
                    byteLength: 4_140,
                    expectedDecodedFrameFingerprint: 2_481_109_241,
                    timestamp: 0,
                    type: 'key'
                },
                {
                    byteLength: 3_642,
                    expectedDecodedFrameFingerprint: 654_435_566,
                    timestamp: 1_000_000,
                    type: 'delta'
                }
            ],
            codecString: 'hvc1.4.10.L93.99.08',
            fixtureSHA256: '8f2c49f6425f8c02baff21e4bed394b0d2e6a4cfb8e9944f09531e64d6b376ee'
        }
    ),
    'main444-8': createDefinition(
        'main444-8',
        'Main 4:4:4',
        8,
        '444',
        'yuv444p',
        'I444',
        {
            accessUnits: [
                {
                    byteLength: 3_515,
                    expectedDecodedFrameFingerprint: 1_821_287_005,
                    timestamp: 0,
                    type: 'key'
                },
                {
                    byteLength: 2_872,
                    expectedDecodedFrameFingerprint: 2_492_293_762,
                    timestamp: 1_000_000,
                    type: 'delta'
                }
            ],
            codecString: 'hvc1.4.10.L93.9E.08',
            fixtureSHA256: 'aec47464fedf08340786534406f45480cfd5ea833547cf6be6fb6360c3f82cb5'
        }
    ),
    'main444-10': createDefinition(
        'main444-10',
        'Main 4:4:4 10',
        10,
        '444',
        'yuv444p10le',
        'I444P10',
        {
            accessUnits: [
                {
                    byteLength: 3_519,
                    expectedDecodedFrameFingerprint: 3_798_930_489,
                    timestamp: 0,
                    type: 'key'
                },
                {
                    byteLength: 2_871,
                    expectedDecodedFrameFingerprint: 1_052_002_504,
                    timestamp: 1_000_000,
                    type: 'delta'
                }
            ],
            codecString: 'hvc1.4.10.L93.9C.08',
            fixtureSHA256: '0b7da32d89ed1e00101e515ca190b4927385421a694daab05cad073a29708c57'
        }
    ),
    'main444-12': createDefinition(
        'main444-12',
        'Main 4:4:4 12',
        12,
        '444',
        'yuv444p12le',
        'I444P12',
        {
            accessUnits: [
                {
                    byteLength: 3_514,
                    expectedDecodedFrameFingerprint: 3_231_491_211,
                    timestamp: 0,
                    type: 'key'
                },
                {
                    byteLength: 2_887,
                    expectedDecodedFrameFingerprint: 339_020_665,
                    timestamp: 1_000_000,
                    type: 'delta'
                }
            ],
            codecString: 'hvc1.4.10.L93.98.08',
            fixtureSHA256: '58d60de348dcf1be311912182920df269538d00e8a095d1733a9f683f561c442'
        }
    )
});

/** Jellyfin currently emits generic Rext; named profiles remain accepted aliases. */
export function definitionMatchesHEVCRangeExtensionStream(
    definition: HEVCRangeExtensionProbeDefinition,
    profile: string | null | undefined,
    pixelFormat: string | null | undefined,
    bitDepth: number | null | undefined
): boolean {
    const normalizedProfile = String(profile ?? '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const normalizedNamedProfile = definition.jellyfinProfile
        .replace(/[^A-Z0-9]/gi, '')
        .toUpperCase();
    const normalizedPixelFormat = String(pixelFormat ?? '').trim().toLowerCase();
    const normalizedBitDepth = typeof bitDepth === 'number' && Number.isFinite(bitDepth) ?
        bitDepth :
        null;
    return (normalizedProfile === 'REXT' || normalizedProfile === normalizedNamedProfile)
        && normalizedPixelFormat === definition.pixelFormat
        // Jellyfin can omit BitDepth when FFprobe exposes only PixelFormat
        && (normalizedBitDepth === null || normalizedBitDepth === definition.bitDepth);
}

/** Resolves one exact runtime Rext route without deriving chroma from profile alone. */
export function getHEVCRangeExtensionStreamDefinition(
    profile: string | null | undefined,
    pixelFormat: string | null | undefined,
    bitDepth: number | null | undefined
): HEVCRangeExtensionProbeDefinition | null {
    for (const variant of HEVC_RANGE_EXTENSION_VARIANTS) {
        const definition = HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant];
        if (definitionMatchesHEVCRangeExtensionStream(
            definition,
            profile,
            pixelFormat,
            bitDepth
        )) {
            return definition;
        }
    }
    return null;
}

/** Resolves Jellyfin stream metadata while treating omitted bit depth as inferable. */
export function getHEVCRangeExtensionStreamDefinitionFromMetadata(
    stream: unknown
): HEVCRangeExtensionProbeDefinition | null {
    if (!stream || typeof stream !== 'object') {
        return null;
    }
    const metadata = stream as {
        BitDepth?: unknown
        PixelFormat?: unknown
        Profile?: unknown
    };
    const bitDepth = parseOptionalBitDepth(metadata.BitDepth);
    return getHEVCRangeExtensionStreamDefinition(
        typeof metadata.Profile === 'string' ? metadata.Profile : null,
        typeof metadata.PixelFormat === 'string' ? metadata.PixelFormat : null,
        bitDepth
    );
}
