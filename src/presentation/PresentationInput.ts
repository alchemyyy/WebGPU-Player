import {
    createHLGColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata,
    type ColorPrimaries,
    type ColorRange,
    type ColorTransfer,
    type InputColorMetadata,
    type YUVMatrix
} from '../color/ColorMetadata';
import { getDolbyVisionEnhancementDimensions } from '../video/dolby-vision/DolbyVisionGeometry';
import { isDolbyVisionDualLayerProfile } from '../video/dolby-vision/DolbyVisionProfiles';

type MediaStreamMetadata = {
    AverageFrameRate?: unknown
    BitDepth?: unknown
    BlPresentFlag?: unknown
    Codec?: unknown
    ColorPrimaries?: unknown
    ColorRange?: unknown
    ColorSpace?: unknown
    ColorTransfer?: unknown
    DvBlSignalCompatibilityId?: unknown
    DvLevel?: unknown
    DvProfile?: unknown
    DvVersionMajor?: unknown
    DvVersionMinor?: unknown
    ElPresentFlag?: unknown
    Hdr10PlusPresentFlag?: unknown
    IsInterlaced?: unknown
    RealFrameRate?: unknown
    RpuPresentFlag?: unknown
    Type?: unknown
    VideoDoViTitle?: unknown
    VideoRange?: unknown
    VideoRangeType?: unknown
    Height?: unknown
    Width?: unknown
};

type PlaybackOptions = {
    mediaSource?: {
        MediaStreams?: unknown
    }
};

/** An RPU reconstruction route: Profiles 4 and 7 are dual-layer, Profiles 5 and 8 single-layer. */
export type DolbyVisionReconstructionProfile = 4 | 5 | 7 | 8;

export type DolbyVisionPresentationDescriptor = {
    baseLayerBitDepth: number
    /** Any 4-bit dv_bl_signal_compatibility_id, or null when the stream reports none. */
    baseLayerSignalCompatibilityID: number | null
    /** The signaled EL flag. Single-layer routes ignore it, and dual-layer routes present a missing EL. */
    enhancementLayerPresent: boolean
    /** The signaled dv_profile. */
    profile: number
    /** The RPU route that reconstructs the stream, or null when only its declared base layer can be presented. */
    reconstructionProfile: DolbyVisionReconstructionProfile | null
};

export type DolbyVisionPresentationSelection = {
    /** Zero-based ordinal among video streams, not MediaStream.Index. */
    baseLayerVideoTrackOrdinal: number
    descriptor: DolbyVisionPresentationDescriptor
};

// dv_bl_signal_compatibility_id is a 4-bit field; IDs outside the standard set are reserved but still supported
const MAXIMUM_BL_SIGNAL_COMPATIBILITY_ID = 15;
// The compatibility IDs that declare a base layer displayable on its own: HDR10, SDR, HLG, and Ultra HD Blu-ray
const HDR10_BL_SIGNAL_COMPATIBILITY_ID = 1;
const SDR_BL_SIGNAL_COMPATIBILITY_ID = 2;
const HLG_BL_SIGNAL_COMPATIBILITY_ID = 4;
const ULTRA_HD_BLU_RAY_BL_SIGNAL_COMPATIBILITY_ID = 6;
const NO_BL_SIGNAL_COMPATIBILITY_ID = 0;
// Profile 5 carries an IPT base layer that is never displayable on its own
const NONCOMPATIBLE_BASE_LAYER_PROFILE = 5;
// Profile 20 is stereo MV-HEVC; its base view reconstructs like a single-layer profile
const MULTIVIEW_HEVC_PROFILE = 20;
// Profiles 0 through 3 and 9 are 8-bit by definition; every other profile is 10-bit
const EIGHT_BIT_BASE_LAYER_PROFILES = new Set([ 0, 1, 2, 3, 9 ]);

/**
 * Returns the RPU route for a signaled profile. Profile 20 reconstructs its base view like Profile 5 when no
 * compatible base is declared and like Profile 8 otherwise. AVC Profile 9, AV1 Profile 10, and the retired
 * profiles have no RPU route, so only a declared base layer can present them.
 */
function getDolbyVisionReconstructionProfile(
    profile: number,
    compatibilityID: number | null,
    rpuPresent: boolean
): DolbyVisionReconstructionProfile | null {
    if (!rpuPresent) {
        return null;
    }
    switch (profile) {
        case 4:
        case 5:
        case 7:
        case 8:
            return profile;
        case MULTIVIEW_HEVC_PROFILE:
            return compatibilityID === null || compatibilityID === NO_BL_SIGNAL_COMPATIBILITY_ID ? 5 : 8;
        default:
            return null;
    }
}

export { isDolbyVisionDualLayerProfile };

/**
 * Returns the transfer of the base layer that a compatibility ID declares displayable on its own. HDR10 and
 * Ultra HD Blu-ray declare PQ, HLG declares HLG, and SDR declares SDR. None and reserved IDs declare nothing, and
 * a Profile 5 style IPT base layer is never displayable whatever its ID, so those streams need RPU reconstruction.
 */
export function getDolbyVisionDeclaredBaseTransfer(
    descriptor: DolbyVisionPresentationDescriptor
): ColorTransfer | null {
    if (
        descriptor.profile === NONCOMPATIBLE_BASE_LAYER_PROFILE
        || descriptor.reconstructionProfile === NONCOMPATIBLE_BASE_LAYER_PROFILE
    ) {
        return null;
    }
    switch (descriptor.baseLayerSignalCompatibilityID) {
        case HDR10_BL_SIGNAL_COMPATIBILITY_ID:
        case ULTRA_HD_BLU_RAY_BL_SIGNAL_COMPATIBILITY_ID:
            return 'pq';
        case HLG_BL_SIGNAL_COMPATIBILITY_ID:
            return 'hlg';
        case SDR_BL_SIGNAL_COMPATIBILITY_ID:
            return 'sdr';
        default:
            return null;
    }
}

/** Returns whether Profile 7 declares an HDR10-compatible base layer, with or without its EL. */
export function isDolbyVisionProfile7HDR10BaseLayerDescriptor(
    descriptor: DolbyVisionPresentationDescriptor
): boolean {
    return descriptor.profile === 7
        && descriptor.baseLayerBitDepth === 10
        && getDolbyVisionDeclaredBaseTransfer(descriptor) === 'pq';
}

/** Returns whether Profile 8 declares an HDR10-compatible base layer; a signaled EL is ignored. */
export function isDolbyVisionProfile8HDR10BaseLayerDescriptor(
    descriptor: DolbyVisionPresentationDescriptor
): boolean {
    return descriptor.profile === 8
        && descriptor.baseLayerBitDepth === 10
        && getDolbyVisionDeclaredBaseTransfer(descriptor) === 'pq';
}

/** Returns whether Profile 8 declares an HLG-compatible base layer; a signaled EL is ignored. */
export function isDolbyVisionProfile8HLGBaseLayerDescriptor(
    descriptor: DolbyVisionPresentationDescriptor
): boolean {
    return descriptor.profile === 8
        && descriptor.baseLayerBitDepth === 10
        && getDolbyVisionDeclaredBaseTransfer(descriptor) === 'hlg';
}

const SDR_VIDEO_RANGE = 'SDR';
const HDR_VIDEO_RANGE = 'HDR';
const HDR_COLOR_TRANSFERS = new Set([
    'ARIB-STD-B67',
    'HLG',
    'PQ',
    'SMPTE ST 2084',
    'SMPTEST2084',
    'SMPTE2084'
]);
const PQ_VIDEO_RANGE_TYPES = new Set([ 'HDR10', 'HDR10PLUS' ]);
const HLG_VIDEO_RANGE_TYPES = new Set([ 'HLG' ]);
const SDR_VIDEO_RANGE_TYPES = new Set([ SDR_VIDEO_RANGE ]);
const DOLBY_VISION_PREFIX = 'DOVI';
// FFmpeg's names for an unspecified or reserved color value, which the color parsers treat as absent
const ABSENT_COLOR_METADATA_TOKENS: ReadonlySet<string> = new Set([
    'RESERVED',
    'UNKNOWN',
    'UNSPECIFIED'
]);
const DEFAULT_SDR_BIT_DEPTH = 8;
const DEFAULT_HDR_BIT_DEPTH = 10;
const HEVC_CODEC_NAMES = new Set([ 'H265', 'HEVC' ]);

type ParsedTransfer = ColorTransfer | 'dolby-vision' | 'unknown';

function normalizeMetadataValue(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalizedValue = value.trim().toUpperCase();
    return normalizedValue || null;
}

function normalizeMetadataToken(value: unknown): string | null {
    const normalizedValue = normalizeMetadataValue(value);
    return normalizedValue?.replace(/[^A-Z0-9]/g, '') ?? null;
}

/** Normalizes a color field token, mapping an unspecified or reserved value to absent so defaults apply. */
function normalizeColorMetadataToken(value: unknown): string | null {
    const normalizedValue = normalizeMetadataToken(value);
    if (normalizedValue === null || ABSENT_COLOR_METADATA_TOKENS.has(normalizedValue)) {
        return null;
    }
    return normalizedValue;
}

function parseRangeType(value: unknown): ParsedTransfer | null {
    const normalizedValue = normalizeMetadataToken(value);
    if (!normalizedValue) {
        return null;
    }
    if (normalizedValue.startsWith(DOLBY_VISION_PREFIX)) {
        return 'dolby-vision';
    }
    if (PQ_VIDEO_RANGE_TYPES.has(normalizedValue)) {
        return 'pq';
    }
    if (HLG_VIDEO_RANGE_TYPES.has(normalizedValue)) {
        return 'hlg';
    }
    if (SDR_VIDEO_RANGE_TYPES.has(normalizedValue)) {
        return 'sdr';
    }

    return 'unknown';
}

function parseTransfer(value: unknown): ParsedTransfer | null {
    const normalizedValue = normalizeColorMetadataToken(value);
    if (!normalizedValue) {
        return null;
    }

    switch (normalizedValue) {
        case 'ARIBSTDB67':
        case 'HLG':
            return 'hlg';
        case 'PQ':
        case 'SMPTE2084':
        case 'SMPTEST2084':
            return 'pq';
        // The BT.2020 10 and 12-bit transfers are the BT.709 OETF, as is SMPTE 170M
        case 'BT202010':
        case 'BT202012':
        case 'BT709':
        case 'IEC6196621':
        case 'SMPTE170M':
            return 'sdr';
        default:
            return 'unknown';
    }
}

function parseVideoRange(value: unknown): 'hdr' | 'sdr' | 'unknown' | null {
    const normalizedValue = normalizeMetadataToken(value);
    if (!normalizedValue) {
        return null;
    }

    switch (normalizedValue) {
        case HDR_VIDEO_RANGE:
            return 'hdr';
        case SDR_VIDEO_RANGE:
            return 'sdr';
        default:
            return 'unknown';
    }
}

function parseColorRange(value: unknown): ColorRange | 'unknown' | null {
    const normalizedValue = normalizeColorMetadataToken(value);
    if (!normalizedValue) {
        return null;
    }

    switch (normalizedValue) {
        case 'FULL':
        case 'JPEG':
        case 'PC':
            return 'full';
        case 'LIMITED':
        case 'MPEG':
        case 'TV':
            return 'limited';
        default:
            return 'unknown';
    }
}

function parseColorPrimaries(value: unknown): ColorPrimaries | 'unknown' | null {
    const normalizedValue = normalizeColorMetadataToken(value);
    if (!normalizedValue) {
        return null;
    }

    switch (normalizedValue) {
        case 'BT2020':
            return 'bt2020';
        case 'BT470BG':
            return 'bt470bg';
        case 'BT709':
            return 'bt709';
        // SMPTE 240M has the SMPTE 170M chromaticities
        case 'SMPTE170M':
        case 'SMPTE240M':
            return 'smpte170m';
        default:
            return 'unknown';
    }
}

function parseYUVMatrix(value: unknown): YUVMatrix | 'unknown' | null {
    const normalizedValue = normalizeColorMetadataToken(value);
    if (!normalizedValue) {
        return null;
    }

    switch (normalizedValue) {
        case 'BT2020NC':
        case 'BT2020NCL':
            return 'bt2020-ncl';
        case 'BT470BG':
            return 'bt470bg';
        case 'BT709':
            return 'bt709';
        case 'SMPTE170M':
            return 'smpte170m';
        default:
            return 'unknown';
    }
}

function parseBitDepth(value: unknown, defaultBitDepth: number): number | null {
    if (value == null) {
        return defaultBitDepth;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 8 || value > 16) {
        return null;
    }

    return value;
}

function resolveTransfer(videoStream: MediaStreamMetadata): ColorTransfer | null {
    const rangeTypeTransfer = parseRangeType(videoStream.VideoRangeType);
    const explicitTransfer = parseTransfer(videoStream.ColorTransfer);
    if (
        rangeTypeTransfer === 'dolby-vision'
        || rangeTypeTransfer === 'unknown'
        || explicitTransfer === 'dolby-vision'
        || explicitTransfer === 'unknown'
    ) {
        return null;
    }
    if (rangeTypeTransfer && explicitTransfer && rangeTypeTransfer !== explicitTransfer) {
        return null;
    }

    const videoRange = parseVideoRange(videoStream.VideoRange);
    if (videoRange === 'unknown') {
        return null;
    }
    const transfer = rangeTypeTransfer
        ?? explicitTransfer
        ?? (videoRange === 'sdr' ? 'sdr' : null);
    if (!transfer) {
        return null;
    }
    switch (transfer) {
        case 'sdr':
            return videoRange === 'hdr' ? null : transfer;
        case 'hlg':
        case 'pq':
            return videoRange === 'sdr' ? null : transfer;
    }
}

function hasEnabledMetadataFlag(value: unknown): boolean {
    switch (typeof value) {
        case 'boolean':
            return value;
        case 'number':
            return value !== 0;
        case 'string': {
            const normalizedValue = value.trim().toUpperCase();
            return normalizedValue !== ''
                && normalizedValue !== '0'
                && normalizedValue !== 'FALSE'
                && normalizedValue !== 'NO';
        }
        default:
            return false;
    }
}

function hasDolbyVisionProfile(value: unknown): boolean {
    return value != null && normalizeMetadataValue(String(value)) != null;
}

function hasDolbyVisionMetadata(videoStream: MediaStreamMetadata): boolean {
    return hasDolbyVisionProfile(videoStream.DvProfile)
        || hasDolbyVisionProfile(videoStream.DvVersionMajor)
        || hasDolbyVisionProfile(videoStream.DvVersionMinor)
        || hasDolbyVisionProfile(videoStream.DvLevel)
        || hasDolbyVisionProfile(videoStream.DvBlSignalCompatibilityId)
        || hasDolbyVisionProfile(videoStream.VideoDoViTitle)
        || hasEnabledMetadataFlag(videoStream.BlPresentFlag)
        || hasEnabledMetadataFlag(videoStream.ElPresentFlag)
        || hasEnabledMetadataFlag(videoStream.RpuPresentFlag);
}

function parseDolbyVisionInteger(value: unknown): number | null {
    const numericValue = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(numericValue) && numericValue >= 0 ? numericValue : null;
}

/** Returns whether a reported compatibility ID is absent or a valid 4-bit value. */
function isAbsentOrValidBLSignalCompatibilityID(value: unknown): boolean {
    if (value == null) {
        return true;
    }
    const compatibilityID = parseDolbyVisionInteger(value);
    return compatibilityID !== null && compatibilityID <= MAXIMUM_BL_SIGNAL_COMPATIBILITY_ID;
}

function parseExactMetadataFlag(value: unknown): boolean | null {
    switch (typeof value) {
        case 'boolean':
            return value;
        case 'number':
            if (value === 0 || value === 1) {
                return value === 1;
            }
            return null;
        case 'string': {
            const normalizedValue = value.trim().toUpperCase();
            switch (normalizedValue) {
                case '0':
                case 'FALSE':
                case 'NO':
                    return false;
                case '1':
                case 'TRUE':
                case 'YES':
                    return true;
                default:
                    return null;
            }
        }
        default:
            return null;
    }
}

function isHEVCStream(videoStream: MediaStreamMetadata): boolean {
    const codec = normalizeMetadataToken(videoStream.Codec);
    return codec !== null && HEVC_CODEC_NAMES.has(codec);
}

function getPositiveFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function getPositiveSafeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function hasMatchingSeparateTrackGeometry(
    baseLayerStream: MediaStreamMetadata,
    enhancementLayerStream: MediaStreamMetadata
): boolean {
    const baseLayerWidth = getPositiveSafeInteger(baseLayerStream.Width);
    const baseLayerHeight = getPositiveSafeInteger(baseLayerStream.Height);
    const enhancementLayerWidth = getPositiveSafeInteger(enhancementLayerStream.Width);
    const enhancementLayerHeight = getPositiveSafeInteger(enhancementLayerStream.Height);
    if (
        baseLayerWidth === null
        || baseLayerHeight === null
        || enhancementLayerWidth === null
        || enhancementLayerHeight === null
    ) {
        return false;
    }
    const expectedDimensions = getDolbyVisionEnhancementDimensions(
        baseLayerWidth,
        baseLayerHeight
    );
    return enhancementLayerWidth === expectedDimensions.width
        && enhancementLayerHeight === expectedDimensions.height;
}

function hasMatchingSeparateTrackFrameRate(
    baseLayerStream: MediaStreamMetadata,
    enhancementLayerStream: MediaStreamMetadata
): boolean {
    const frameRateFields: ReadonlyArray<'AverageFrameRate' | 'RealFrameRate'> = [
        'AverageFrameRate',
        'RealFrameRate'
    ];
    let matchedFrameRate = false;
    for (const frameRateField of frameRateFields) {
        const baseLayerFrameRate = getPositiveFiniteNumber(baseLayerStream[frameRateField]);
        const enhancementLayerFrameRate = getPositiveFiniteNumber(
            enhancementLayerStream[frameRateField]
        );
        if (baseLayerFrameRate === null && enhancementLayerFrameRate === null) {
            continue;
        }
        if (
            baseLayerFrameRate === null
            || enhancementLayerFrameRate === null
            || Math.abs(baseLayerFrameRate - enhancementLayerFrameRate) > 0.001
        ) {
            return false;
        }
        matchedFrameRate = true;
    }
    return matchedFrameRate;
}

function isSeparateProfile7EnhancementStream(videoStream: MediaStreamMetadata): boolean {
    const rangeType = normalizeMetadataToken(videoStream.VideoRangeType);
    // Jellyfin 10.11 reports BL=true for Matroska EL tracks and BL=false for
    // ISO BMFF EL tracks, so topology and all other exact P7 fields are required
    return isHEVCStream(videoStream)
        && videoStream.BitDepth === DEFAULT_HDR_BIT_DEPTH
        && videoStream.IsInterlaced === false
        && parseDolbyVisionInteger(videoStream.DvProfile) === 7
        && isAbsentOrValidBLSignalCompatibilityID(videoStream.DvBlSignalCompatibilityId)
        && parseExactMetadataFlag(videoStream.BlPresentFlag) !== null
        && parseExactMetadataFlag(videoStream.ElPresentFlag) === true
        && parseExactMetadataFlag(videoStream.RpuPresentFlag) === true
        && (
            rangeType?.startsWith(DOLBY_VISION_PREFIX) === true
            // Jellyfin classifies separate MPEG-TS EL streams as HDR10 even
            // when their exact FFmpeg side data identifies Profile 7
            || (
                parseRangeType(videoStream.VideoRangeType) === 'pq'
                && parseTransfer(videoStream.ColorTransfer) === 'pq'
            )
        );
}

function isSeparateProfile7BaseStream(videoStream: MediaStreamMetadata): boolean {
    return isHEVCStream(videoStream)
        && videoStream.BitDepth === DEFAULT_HDR_BIT_DEPTH
        && videoStream.IsInterlaced === false
        && !hasDolbyVisionMetadata(videoStream)
        && parseVideoStreamColorMetadata(videoStream)?.transfer === 'pq';
}

function parseSeparateProfile7Selection(
    videoStreams: readonly MediaStreamMetadata[]
): DolbyVisionPresentationSelection | null {
    if (videoStreams.length !== 2) {
        return null;
    }
    const baseLayerVideoTrackOrdinal = videoStreams.findIndex(
        isSeparateProfile7BaseStream
    );
    const enhancementLayerVideoTrackOrdinal = videoStreams.findIndex(
        isSeparateProfile7EnhancementStream
    );
    if (
        baseLayerVideoTrackOrdinal < 0
        || enhancementLayerVideoTrackOrdinal < 0
        || baseLayerVideoTrackOrdinal === enhancementLayerVideoTrackOrdinal
    ) {
        return null;
    }
    const baseLayerStream = videoStreams[baseLayerVideoTrackOrdinal];
    const enhancementLayerStream = videoStreams[enhancementLayerVideoTrackOrdinal];
    if (
        !hasMatchingSeparateTrackGeometry(baseLayerStream, enhancementLayerStream)
        || !hasMatchingSeparateTrackFrameRate(baseLayerStream, enhancementLayerStream)
    ) {
        return null;
    }
    return {
        baseLayerVideoTrackOrdinal,
        descriptor: {
            baseLayerBitDepth: 10,
            // The separate base track carries no Dolby Vision signaling and is proven PQ on its own, so it is an
            // HDR10-compatible base whatever compatibility ID the enhancement track reports
            baseLayerSignalCompatibilityID: ULTRA_HD_BLU_RAY_BL_SIGNAL_COMPATIBILITY_ID,
            enhancementLayerPresent: true,
            profile: 7,
            reconstructionProfile: 7
        }
    };
}

/**
 * Parses one stream's Dolby Vision configuration. Any profile with a present base layer, a valid or absent
 * compatibility ID, and a valid bit depth is accepted; route selection decides whether it can be presented.
 */
function parseDolbyVisionDescriptor(
    videoStream: MediaStreamMetadata
): DolbyVisionPresentationDescriptor | null {
    const profile = parseDolbyVisionInteger(videoStream.DvProfile);
    if (profile === null || !hasEnabledMetadataFlag(videoStream.BlPresentFlag)) {
        return null;
    }
    const bitDepth = parseBitDepth(
        videoStream.BitDepth,
        EIGHT_BIT_BASE_LAYER_PROFILES.has(profile) ? DEFAULT_SDR_BIT_DEPTH : DEFAULT_HDR_BIT_DEPTH
    );
    if (bitDepth === null) {
        return null;
    }
    // Every compatibility ID is supported: RPU reconstruction ignores it, and it only decides whether a base
    // route may present the base layer on its own
    if (!isAbsentOrValidBLSignalCompatibilityID(videoStream.DvBlSignalCompatibilityId)) {
        return null;
    }
    const compatibilityID = videoStream.DvBlSignalCompatibilityId == null ?
        null :
        parseDolbyVisionInteger(videoStream.DvBlSignalCompatibilityId);
    return {
        baseLayerBitDepth: bitDepth,
        baseLayerSignalCompatibilityID: compatibilityID,
        enhancementLayerPresent: hasEnabledMetadataFlag(videoStream.ElPresentFlag),
        profile,
        reconstructionProfile: getDolbyVisionReconstructionProfile(
            profile,
            compatibilityID,
            hasEnabledMetadataFlag(videoStream.RpuPresentFlag)
        )
    };
}

function getPlaybackVideoStreams(options: unknown): MediaStreamMetadata[] | null {
    if (!options || typeof options !== 'object') {
        return null;
    }
    const mediaStreams = (options as PlaybackOptions).mediaSource?.MediaStreams;
    if (!Array.isArray(mediaStreams)) {
        return null;
    }
    const videoStreams: MediaStreamMetadata[] = [];
    for (const stream of mediaStreams) {
        if (
            stream
            && typeof stream === 'object'
            && normalizeMetadataValue((stream as MediaStreamMetadata).Type) === 'VIDEO'
        ) {
            videoStreams.push(stream as MediaStreamMetadata);
        }
    }
    return videoStreams;
}

/** Returns one exact supported single-stream or separate-track Dolby Vision selection. */
export function getDolbyVisionPresentationSelection(
    options: unknown
): DolbyVisionPresentationSelection | null {
    const videoStreams = getPlaybackVideoStreams(options);
    if (!videoStreams) {
        return null;
    }
    if (videoStreams.length === 1) {
        const descriptor = parseDolbyVisionDescriptor(videoStreams[0]);
        return descriptor ? { baseLayerVideoTrackOrdinal: 0, descriptor } : null;
    }
    return parseSeparateProfile7Selection(videoStreams);
}

/** Returns the parsed Dolby Vision descriptor of the presented stream. */
export function getDolbyVisionPresentationDescriptor(
    options: unknown
): DolbyVisionPresentationDescriptor | null {
    return getDolbyVisionPresentationSelection(options)?.descriptor ?? null;
}

/**
 * Returns the video-track ordinal Jellyfin presents. Independent video tracks
 * follow Jellyfin's first-track selection; Dolby Vision remains fail-closed
 * unless its exact single-stream or separate-track topology is recognized.
 */
export function getPresentationVideoTrackOrdinal(options: unknown): number | null {
    const videoStreams = getPlaybackVideoStreams(options);
    if (!videoStreams || videoStreams.length === 0) {
        return null;
    }

    const dolbyVisionSelection = getDolbyVisionPresentationSelection(options);
    if (dolbyVisionSelection) {
        return dolbyVisionSelection.baseLayerVideoTrackOrdinal;
    }
    if (videoStreams.some(hasDolbyVisionMetadata)) {
        return null;
    }

    return 0;
}

function getDolbyVisionHDR10BaseColorMetadata(
    options: unknown,
    acceptsDescriptor: (descriptor: DolbyVisionPresentationDescriptor) => boolean
): InputColorMetadata | null {
    const selection = getDolbyVisionPresentationSelection(options);
    if (!selection || !acceptsDescriptor(selection.descriptor)) {
        return null;
    }
    const videoStream = getPlaybackVideoStreams(options)?.[
        selection.baseLayerVideoTrackOrdinal
    ];
    if (!videoStream
        || parseColorPrimaries(videoStream.ColorPrimaries) !== 'bt2020'
        || parseYUVMatrix(videoStream.ColorSpace) !== 'bt2020-ncl'
        || parseTransfer(videoStream.ColorTransfer) !== 'pq') {
        return null;
    }
    const colorRange = parseColorRange(videoStream.ColorRange);
    const videoRange = parseVideoRange(videoStream.VideoRange);
    if (colorRange === 'full'
        || colorRange === 'unknown'
        || videoRange === 'sdr'
        || videoRange === 'unknown') {
        return null;
    }
    return createPQColorMetadata({ range: colorRange ?? 'limited' });
}

/** Returns exact BT.2020 PQ metadata for a Profile 7 HDR10-compatible base. */
export function getDolbyVisionProfile7HDR10BaseColorMetadata(
    options: unknown
): InputColorMetadata | null {
    return getDolbyVisionHDR10BaseColorMetadata(
        options,
        isDolbyVisionProfile7HDR10BaseLayerDescriptor
    );
}

/** Returns exact BT.2020 PQ metadata for a Profile 8.1 HDR10-compatible base. */
export function getDolbyVisionProfile8HDR10BaseColorMetadata(
    options: unknown
): InputColorMetadata | null {
    return getDolbyVisionHDR10BaseColorMetadata(
        options,
        isDolbyVisionProfile8HDR10BaseLayerDescriptor
    );
}

/** Returns exact BT.2020 HLG metadata for a Profile 8.4 HLG-compatible base. */
export function getDolbyVisionProfile8HLGBaseColorMetadata(
    options: unknown
): InputColorMetadata | null {
    const selection = getDolbyVisionPresentationSelection(options);
    if (!selection || !isDolbyVisionProfile8HLGBaseLayerDescriptor(selection.descriptor)) {
        return null;
    }
    const videoStream = getPlaybackVideoStreams(options)?.[
        selection.baseLayerVideoTrackOrdinal
    ];
    if (!videoStream
        || videoStream.BitDepth !== DEFAULT_HDR_BIT_DEPTH
        || parseColorRange(videoStream.ColorRange) !== 'limited'
        || parseColorPrimaries(videoStream.ColorPrimaries) !== 'bt2020'
        || parseYUVMatrix(videoStream.ColorSpace) !== 'bt2020-ncl'
        || parseTransfer(videoStream.ColorTransfer) !== 'hlg') {
        return null;
    }
    const videoRange = parseVideoRange(videoStream.VideoRange);
    if (videoRange === 'sdr' || videoRange === 'unknown') {
        return null;
    }
    return createHLGColorMetadata({
        bitDepth: DEFAULT_HDR_BIT_DEPTH,
        matrix: 'bt2020-ncl',
        primaries: 'bt2020',
        range: 'limited'
    });
}

/**
 * Converts one Jellyfin video stream into renderer metadata.
 * Unsupported, contradictory, unrecognized, and Dolby Vision descriptions return null.
 * An unspecified or reserved color field is absent and takes its transfer's default.
 */
export function parseVideoStreamColorMetadata(stream: unknown): InputColorMetadata | null {
    if (!stream || typeof stream !== 'object') {
        return null;
    }

    const videoStream = stream as MediaStreamMetadata;
    const streamType = normalizeMetadataValue(videoStream.Type);
    if (streamType && streamType !== 'VIDEO') {
        return null;
    }
    if (hasDolbyVisionMetadata(videoStream)) {
        return null;
    }

    const transfer = resolveTransfer(videoStream);
    if (!transfer) {
        return null;
    }
    return createVideoStreamColorMetadata(videoStream, transfer);
}

/** Builds renderer metadata from one stream's explicit color fields under an already resolved transfer. */
function createVideoStreamColorMetadata(
    videoStream: MediaStreamMetadata,
    transfer: ColorTransfer
): InputColorMetadata | null {
    // HDR10+ retains a PQ-compatible static HDR10 base for per-frame metadata
    if (hasEnabledMetadataFlag(videoStream.Hdr10PlusPresentFlag) && transfer !== 'pq') {
        return null;
    }

    const defaultBitDepth = transfer === 'sdr' ? DEFAULT_SDR_BIT_DEPTH : DEFAULT_HDR_BIT_DEPTH;
    const bitDepth = parseBitDepth(videoStream.BitDepth, defaultBitDepth);
    if (!bitDepth || (transfer !== 'sdr' && bitDepth < DEFAULT_HDR_BIT_DEPTH)) {
        return null;
    }

    const parsedRange = parseColorRange(videoStream.ColorRange);
    const parsedPrimaries = parseColorPrimaries(videoStream.ColorPrimaries);
    const parsedMatrix = parseYUVMatrix(videoStream.ColorSpace);
    if (
        parsedRange === 'unknown'
        || parsedPrimaries === 'unknown'
        || parsedMatrix === 'unknown'
    ) {
        return null;
    }

    const range = parsedRange ?? 'limited';
    const primaries = parsedPrimaries ?? (transfer === 'sdr' ? 'bt709' : 'bt2020');
    const matrix = parsedMatrix ?? (transfer === 'sdr' ? 'bt709' : 'bt2020-ncl');
    switch (transfer) {
        case 'sdr':
            return createSDRColorMetadata({ bitDepth, matrix, primaries, range });
        case 'pq':
            return createPQColorMetadata({ bitDepth, matrix, primaries, range });
        case 'hlg':
            return createHLGColorMetadata({ bitDepth, matrix, primaries, range });
    }
}

/**
 * Returns renderer metadata for a Dolby Vision base layer presented on its own through an ordinary route. The
 * compatibility ID declares the transfer. Jellyfin derives VideoRange and VideoRangeType from the Dolby Vision
 * configuration and mislabels some profiles, so only an explicit ColorTransfer may contradict the declaration.
 */
export function getDolbyVisionBaseColorMetadata(options: unknown): InputColorMetadata | null {
    const selection = getDolbyVisionPresentationSelection(options);
    if (!selection) {
        return null;
    }
    const declaredTransfer = getDolbyVisionDeclaredBaseTransfer(selection.descriptor);
    const videoStream = getPlaybackVideoStreams(options)?.[
        selection.baseLayerVideoTrackOrdinal
    ];
    if (!declaredTransfer || !videoStream) {
        return null;
    }
    const explicitTransfer = parseTransfer(videoStream.ColorTransfer);
    if (explicitTransfer !== null && explicitTransfer !== declaredTransfer) {
        return null;
    }
    return createVideoStreamColorMetadata(videoStream, declaredTransfer);
}

/** Returns renderer metadata for Jellyfin's selected presentation video track. */
export function getPresentationInputColorMetadata(options: unknown): InputColorMetadata | null {
    const videoStreams = getPlaybackVideoStreams(options);
    const videoTrackOrdinal = getPresentationVideoTrackOrdinal(options);
    if (!videoStreams || videoTrackOrdinal === null) {
        return null;
    }

    return parseVideoStreamColorMetadata(videoStreams[videoTrackOrdinal]);
}

function isKnownSDRVideoStream(videoStream: MediaStreamMetadata): boolean {
    if (
        hasEnabledMetadataFlag(videoStream.Hdr10PlusPresentFlag)
        || hasDolbyVisionMetadata(videoStream)
    ) {
        return false;
    }

    const videoRangeType = normalizeMetadataValue(videoStream.VideoRangeType);
    const videoRange = normalizeMetadataValue(videoStream.VideoRange);
    const colorTransfer = normalizeMetadataValue(videoStream.ColorTransfer);
    if (colorTransfer && HDR_COLOR_TRANSFERS.has(colorTransfer)) {
        return false;
    }

    const videoRanges: string[] = [];
    if (videoRangeType) {
        videoRanges.push(videoRangeType);
    }
    if (videoRange) {
        videoRanges.push(videoRange);
    }

    return videoRanges.length > 0
        && videoRanges.every((range: string): boolean => range === SDR_VIDEO_RANGE);
}

/**
 * Returns whether a stream names an HDR transfer, BT.2020 primaries, and the BT.2020 non-constant-luminance
 * matrix. Absent, unknown, unspecified, and reserved values do not count, so a defaulted description never
 * selects a route that rewrites the bitstream as BT.2020.
 */
export function hasExplicitBT2020HDRColorDescription(stream: unknown): boolean {
    if (!stream || typeof stream !== 'object') {
        return false;
    }
    const colorDescription = stream as MediaStreamMetadata;
    const transfer = parseTransfer(colorDescription.ColorTransfer);
    return (transfer === 'pq' || transfer === 'hlg')
        && parseColorPrimaries(colorDescription.ColorPrimaries) === 'bt2020'
        && parseYUVMatrix(colorDescription.ColorSpace) === 'bt2020-ncl';
}

/**
 * Returns true only when Jellyfin metadata positively identifies an SDR frame
 * source. Unknown and HDR inputs remain on direct HTML presentation until the
 * external-texture color path has been validated for them.
 */
export function isKnownSDRPresentationInput(options: unknown): boolean {
    const videoStreams = getPlaybackVideoStreams(options);
    const videoTrackOrdinal = getPresentationVideoTrackOrdinal(options);
    return videoStreams !== null
        && videoTrackOrdinal !== null
        && isKnownSDRVideoStream(videoStreams[videoTrackOrdinal]);
}
