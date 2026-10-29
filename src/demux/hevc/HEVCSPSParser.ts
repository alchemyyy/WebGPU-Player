const HEVC_SPS_NAL_UNIT_TYPE = 33;
const MAXIMUM_HEVC_DPB_PICTURE_COUNT = 16;
const MAXIMUM_HEVC_REFERENCE_PICTURE_COUNT = MAXIMUM_HEVC_DPB_PICTURE_COUNT;
const MAXIMUM_HEVC_LONG_TERM_REFERENCE_PICTURE_COUNT = 32;
const MAXIMUM_HEVC_SHORT_TERM_REFERENCE_PICTURE_SET_COUNT = 64;
const MAXIMUM_SPS_NAL_UNIT_BYTE_LENGTH = 64 * 1024;
const MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE = 0x7FFF_FFFF;
// chroma_format_idc: 0 is monochrome, 1 4:2:0, 2 4:2:2, and 3 4:4:4
const CHROMA_FORMAT_420 = 1;
const CHROMA_FORMAT_422 = 2;
const CHROMA_FORMAT_444 = 3;
// bit_depth_luma_minus8 and bit_depth_chroma_minus8 reach 8 in the range extensions, 16-bit planes, as FFmpeg reads them; the bounded parser reads at most 6
const MAXIMUM_BIT_DEPTH_MINUS8 = 8;
const MAXIMUM_BOUNDED_BIT_DEPTH_MINUS8 = 6;
// FFmpeg's test for a VUI without default_display_window_flag: the bits left from the flag before rbsp_stop_one_bit, and the 21 bits that follow it
const MISSING_DEFAULT_DISPLAY_WINDOW_MINIMUM_BIT_COUNT = 68;
const MISSING_DEFAULT_DISPLAY_WINDOW_PATTERN_BIT_LENGTH = 21;
const MISSING_DEFAULT_DISPLAY_WINDOW_PATTERN = 0x10_0000;
const MAIN_PROFILE_BASE_DPB_PICTURE_COUNT = 6;
const HEVC_LEVEL_MAXIMUM_LUMA_PICTURE_SAMPLE_COUNTS: Readonly<Partial<Record<number, number>>> = Object.freeze({
    30: 36_864,
    60: 122_880,
    63: 245_760,
    90: 552_960,
    93: 983_040,
    120: 2_228_224,
    123: 2_228_224,
    150: 8_912_896,
    153: 8_912_896,
    156: 8_912_896,
    180: 35_651_584,
    183: 35_651_584,
    186: 35_651_584
});

// ITU-T H.273 colour_primaries code points
const BT709_COLOR_PRIMARIES = 1;
const BT470BG_COLOR_PRIMARIES = 5;
const SMPTE170M_COLOR_PRIMARIES = 6;
const SMPTE240M_COLOR_PRIMARIES = 7;
const BT2020_COLOR_PRIMARIES = 9;
const SMPTE432_COLOR_PRIMARIES = 12;
// ITU-T H.273 transfer_characteristics code points
const BT709_TRANSFER_CHARACTERISTICS = 1;
const SMPTE170M_TRANSFER_CHARACTERISTICS = 6;
const LINEAR_TRANSFER_CHARACTERISTICS = 8;
const IEC61966_2_1_TRANSFER_CHARACTERISTICS = 13;
const BT2020_10_BIT_TRANSFER_CHARACTERISTICS = 14;
const BT2020_12_BIT_TRANSFER_CHARACTERISTICS = 15;
const PQ_TRANSFER_CHARACTERISTICS = 16;
const HLG_TRANSFER_CHARACTERISTICS = 18;
// ITU-T H.273 matrix_coeffs code points
const BT709_MATRIX_COEFFICIENTS = 1;
const BT470BG_MATRIX_COEFFICIENTS = 5;
const SMPTE170M_MATRIX_COEFFICIENTS = 6;
const BT2020_NCL_MATRIX_COEFFICIENTS = 9;

/** The WebCodecs and Mediabunny names an SPS VUI colour_primaries value maps to. */
export type HEVCSPSColorPrimaries = 'bt2020' | 'bt470bg' | 'bt709' | 'smpte170m' | 'smpte432';
/** The WebCodecs and Mediabunny names an SPS VUI transfer_characteristics value maps to. */
export type HEVCSPSTransferCharacteristics =
    | 'bt709'
    | 'hlg'
    | 'iec61966-2-1'
    | 'linear'
    | 'pq'
    | 'smpte170m';
/** The WebCodecs and Mediabunny names an SPS VUI matrix_coeffs value maps to. */
export type HEVCSPSMatrixCoefficients = 'bt2020-ncl' | 'bt470bg' | 'bt709' | 'smpte170m';

/**
 * An SPS VUI color description in WebCodecs names.
 * A null member is unspecified, reserved, or without a WebCodecs name, like the BT.2020 transfers of HLG-compatible streams.
 */
export type HEVCSPSColorSpace = {
    fullRange: boolean
    matrix: HEVCSPSMatrixCoefficients | null
    primaries: HEVCSPSColorPrimaries | null
    transfer: HEVCSPSTransferCharacteristics | null
};

export type HEVCSPSConfiguration = {
    bitDepth: 8 | 10
    chromaFormat: 1
    codedHeight: number
    codedWidth: number
    colorSpace: HEVCSPSColorSpace | null
    displayHeight: number
    displayWidth: number
    levelIDC: number
    maximumDPBPictureCount: number
    profileIDC: 1 | 2
    progressive: true
};

/** The chroma an SPS declares, read from any profile's SPS. */
export type HEVCSPSChroma = {
    /** chroma_format_idc: 0 monochrome, 1 4:2:0, 2 4:2:2, 3 4:4:4 */
    chromaFormat: number
    /** The VUI's chroma_sample_loc_type_top_field, H.273's location of 4:2:0 chroma, which a frame's chroma takes; null when the VUI declares none */
    chromaSampleLocationType: number | null
};

export type HEVCHDRTransfer = 'hlg' | 'pq';

class BoundedBitReader {
    private bitOffset = 0;

    public constructor(private readonly bytes: Uint8Array) {}

    public readBits(bitCount: number, label: string): number {
        if (!Number.isSafeInteger(bitCount) || bitCount < 0 || bitCount > 32) {
            throw new TypeError(`The HEVC SPS ${label} bit count is invalid`);
        }
        if (this.bitOffset + bitCount > this.bytes.byteLength * 8) {
            throw new TypeError(`The HEVC SPS ends inside ${label}`);
        }

        let value = 0;
        for (let bitIndex = 0; bitIndex < bitCount; bitIndex += 1) {
            const byteOffset = Math.floor(this.bitOffset / 8);
            const shift = 7 - (this.bitOffset % 8);
            value = (value * 2) + ((this.bytes[byteOffset] >> shift) & 1);
            this.bitOffset += 1;
        }
        return value;
    }

    public readFlag(label: string): boolean {
        return this.readBits(1, label) === 1;
    }

    public getBitOffset(): number {
        return this.bitOffset;
    }

    public readUnsignedExpGolomb(label: string, maximumValue: number): number {
        let leadingZeroBitCount = 0;
        while (!this.readFlag(label)) {
            leadingZeroBitCount += 1;
            if (leadingZeroBitCount > 31) {
                throw new TypeError(`The HEVC SPS ${label} value is too large`);
            }
        }

        const suffix = this.readBits(leadingZeroBitCount, label);
        const value = ((2 ** leadingZeroBitCount) - 1) + suffix;
        if (!Number.isSafeInteger(value) || value > maximumValue) {
            throw new TypeError(`The HEVC SPS ${label} value is unsupported`);
        }
        return value;
    }

    public skipBits(bitCount: number, label: string): void {
        if (!Number.isSafeInteger(bitCount) || bitCount < 0) {
            throw new TypeError(`The HEVC SPS ${label} bit count is invalid`);
        }
        if (this.bitOffset + bitCount > this.bytes.byteLength * 8) {
            throw new TypeError(`The HEVC SPS ends inside ${label}`);
        }
        this.bitOffset += bitCount;
    }
}

type ProfileTierLevel = {
    interlacedSource: boolean
    levelIDC: number
    profileIDC: number
    progressiveSource: boolean
};

type ParsedVUI = {
    chromaSampleLocationType: number | null
    colorDescriptionCodes: VUIColorDescriptionCodes | null
    colorDescriptionOffsets: VUIColorDescriptionOffsets | null
    colorSpace: HEVCSPSColorSpace | null
    /** The RBSP bit offset of default_display_window_flag, where the parse stops; null without VUI */
    defaultDisplayWindowFlagOffset: number | null
    fieldSequence: boolean
};

/** The raw H.273 code points of a VUI color description. */
type VUIColorDescriptionCodes = {
    fullRange: boolean
    matrix: number
    primaries: number
    transfer: number
};

type VUIColorDescriptionOffsets = {
    fullRange: number
    matrix: number
    primaries: number
    transfer: number
};

function createRBSP(nalUnit: Uint8Array): Uint8Array {
    if (
        nalUnit.byteLength < 4
        || nalUnit.byteLength > MAXIMUM_SPS_NAL_UNIT_BYTE_LENGTH
        || ((nalUnit[0] >> 1) & 0x3F) !== HEVC_SPS_NAL_UNIT_TYPE
        || (nalUnit[0] & 0x80) !== 0
        || (nalUnit[1] & 0x07) === 0
    ) {
        throw new TypeError('The HEVC SPS NAL unit header is invalid');
    }

    const rbspBytes: number[] = [];
    for (let byteIndex = 2; byteIndex < nalUnit.byteLength; byteIndex += 1) {
        const byteValue = nalUnit[byteIndex];
        if (byteValue === 3 && byteIndex >= 4 && nalUnit[byteIndex - 1] === 0 && nalUnit[byteIndex - 2] === 0) {
            const nextByte = nalUnit[byteIndex + 1];
            if (byteIndex + 1 >= nalUnit.byteLength || nextByte > 3) {
                throw new TypeError('The HEVC SPS has an invalid emulation-prevention byte');
            }
            continue;
        }
        rbspBytes.push(byteValue);
    }
    if (rbspBytes.length === 0) {
        throw new TypeError('The HEVC SPS RBSP is empty');
    }
    return new Uint8Array(rbspBytes);
}

function parseProfileTierLevel(reader: BoundedBitReader, maximumSubLayerIndex: number): ProfileTierLevel {
    reader.skipBits(2, 'general_profile_space');
    reader.skipBits(1, 'general_tier_flag');
    const profileIDC = reader.readBits(5, 'general_profile_idc');
    reader.skipBits(32, 'general_profile_compatibility_flags');
    const progressiveSource = reader.readFlag('general_progressive_source_flag');
    const interlacedSource = reader.readFlag('general_interlaced_source_flag');
    reader.skipBits(46, 'general_constraint_indicator_flags');
    const levelIDC = reader.readBits(8, 'general_level_idc');

    const subLayerProfilePresent: boolean[] = [];
    const subLayerLevelPresent: boolean[] = [];
    for (let subLayerIndex = 0; subLayerIndex < maximumSubLayerIndex; subLayerIndex += 1) {
        subLayerProfilePresent.push(reader.readFlag('sub_layer_profile_present_flag'));
        subLayerLevelPresent.push(reader.readFlag('sub_layer_level_present_flag'));
    }
    if (maximumSubLayerIndex > 0) {
        reader.skipBits(2 * (8 - maximumSubLayerIndex), 'reserved_zero_2bits');
    }
    for (let subLayerIndex = 0; subLayerIndex < maximumSubLayerIndex; subLayerIndex += 1) {
        if (subLayerProfilePresent[subLayerIndex]) {
            reader.skipBits(88, 'sub_layer_profile_tier_level');
        }
        if (subLayerLevelPresent[subLayerIndex]) {
            reader.skipBits(8, 'sub_layer_level_idc');
        }
    }

    return { interlacedSource, levelIDC, profileIDC, progressiveSource };
}

function skipScalingListData(reader: BoundedBitReader): void {
    for (let sizeIndex = 0; sizeIndex < 4; sizeIndex += 1) {
        const matrixCount = sizeIndex === 3 ? 2 : 6;
        for (let matrixIndex = 0; matrixIndex < matrixCount; matrixIndex += 1) {
            if (!reader.readFlag('scaling_list_pred_mode_flag')) {
                reader.readUnsignedExpGolomb('scaling_list_pred_matrix_id_delta', MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE);
                continue;
            }

            const coefficientCount = Math.min(64, 1 << (4 + (2 * sizeIndex)));
            if (sizeIndex > 1) {
                reader.readUnsignedExpGolomb('scaling_list_dc_coef_minus8', MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE);
            }
            for (let coefficientIndex = 0; coefficientIndex < coefficientCount; coefficientIndex += 1) {
                reader.readUnsignedExpGolomb('scaling_list_delta_coef', MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE);
            }
        }
    }
}

function parseExplicitReferencePictureSet(reader: BoundedBitReader): number {
    const negativePictureCount = reader.readUnsignedExpGolomb('num_negative_pics', MAXIMUM_HEVC_REFERENCE_PICTURE_COUNT);
    const positivePictureCount = reader.readUnsignedExpGolomb('num_positive_pics', MAXIMUM_HEVC_REFERENCE_PICTURE_COUNT);
    const deltaPictureCount = negativePictureCount + positivePictureCount;
    if (deltaPictureCount > MAXIMUM_HEVC_REFERENCE_PICTURE_COUNT) {
        throw new TypeError('The HEVC SPS reference picture set is too large');
    }
    for (let pictureIndex = 0; pictureIndex < deltaPictureCount; pictureIndex += 1) {
        reader.readUnsignedExpGolomb('delta_poc_minus1', MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE);
        reader.skipBits(1, 'used_by_curr_pic_flag');
    }
    return deltaPictureCount;
}

function parsePredictedReferencePictureSet(reader: BoundedBitReader, referenceDeltaPictureCount: number): number {
    reader.skipBits(1, 'delta_rps_sign');
    reader.readUnsignedExpGolomb('abs_delta_rps_minus1', MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE);
    let deltaPictureCount = 0;
    for (let pictureIndex = 0; pictureIndex <= referenceDeltaPictureCount; pictureIndex += 1) {
        const usedByCurrentPicture = reader.readFlag('used_by_curr_pic_flag');
        if (usedByCurrentPicture || reader.readFlag('use_delta_flag')) {
            deltaPictureCount += 1;
        }
    }
    if (deltaPictureCount > MAXIMUM_HEVC_REFERENCE_PICTURE_COUNT) {
        throw new TypeError('The HEVC SPS predicted reference picture set is too large');
    }
    return deltaPictureCount;
}

function parseShortTermReferencePictureSets(reader: BoundedBitReader, setCount: number): void {
    const deltaPictureCounts: number[] = [];
    for (let setIndex = 0; setIndex < setCount; setIndex += 1) {
        const predicted = setIndex > 0 && reader.readFlag('inter_ref_pic_set_prediction_flag');
        const deltaPictureCount = predicted ?
            parsePredictedReferencePictureSet(reader, deltaPictureCounts[setIndex - 1]) :
            parseExplicitReferencePictureSet(reader);
        deltaPictureCounts.push(deltaPictureCount);
    }
}

function mapColorPrimaries(primariesValue: number): HEVCSPSColorPrimaries | null {
    switch (primariesValue) {
        case BT709_COLOR_PRIMARIES:
            return 'bt709';
        case BT470BG_COLOR_PRIMARIES:
            return 'bt470bg';
        // SMPTE 240M has the SMPTE 170M chromaticities
        case SMPTE170M_COLOR_PRIMARIES:
        case SMPTE240M_COLOR_PRIMARIES:
            return 'smpte170m';
        case BT2020_COLOR_PRIMARIES:
            return 'bt2020';
        case SMPTE432_COLOR_PRIMARIES:
            return 'smpte432';
        default:
            return null;
    }
}

function mapTransferCharacteristics(transferValue: number): HEVCSPSTransferCharacteristics | null {
    switch (transferValue) {
        case BT709_TRANSFER_CHARACTERISTICS:
            return 'bt709';
        case SMPTE170M_TRANSFER_CHARACTERISTICS:
            return 'smpte170m';
        case LINEAR_TRANSFER_CHARACTERISTICS:
            return 'linear';
        case IEC61966_2_1_TRANSFER_CHARACTERISTICS:
            return 'iec61966-2-1';
        case PQ_TRANSFER_CHARACTERISTICS:
            return 'pq';
        case HLG_TRANSFER_CHARACTERISTICS:
            return 'hlg';
        // NOTE: The BT.2020 10 and 12-bit transfers have no WebCodecs name, so they are unspecified here too
        default:
            return null;
    }
}

function mapMatrixCoefficients(matrixValue: number): HEVCSPSMatrixCoefficients | null {
    switch (matrixValue) {
        case BT709_MATRIX_COEFFICIENTS:
            return 'bt709';
        case BT470BG_MATRIX_COEFFICIENTS:
            return 'bt470bg';
        case SMPTE170M_MATRIX_COEFFICIENTS:
            return 'smpte170m';
        case BT2020_NCL_MATRIX_COEFFICIENTS:
            return 'bt2020-ncl';
        default:
            return null;
    }
}

/**
 * Maps a VUI color description to WebCodecs names without rejecting any value.
 * Unspecified, reserved, and unnamed values become null members, and a description with no named member is null.
 */
function mapColorSpace(codes: VUIColorDescriptionCodes): HEVCSPSColorSpace | null {
    const primaries = mapColorPrimaries(codes.primaries);
    const transfer = mapTransferCharacteristics(codes.transfer);
    const matrix = mapMatrixCoefficients(codes.matrix);
    if (primaries === null && transfer === null && matrix === null) {
        return null;
    }
    return {
        fullRange: codes.fullRange,
        matrix,
        primaries,
        transfer
    };
}

function parseVUI(reader: BoundedBitReader): ParsedVUI {
    if (reader.readFlag('aspect_ratio_info_present_flag')) {
        const aspectRatioIDC = reader.readBits(8, 'aspect_ratio_idc');
        if (aspectRatioIDC === 255) {
            reader.skipBits(32, 'sar_width_and_height');
        }
    }
    if (reader.readFlag('overscan_info_present_flag')) {
        reader.skipBits(1, 'overscan_appropriate_flag');
    }
    let colorDescriptionCodes: VUIColorDescriptionCodes | null = null;
    let colorDescriptionOffsets: VUIColorDescriptionOffsets | null = null;
    let signaledFullRange = false;
    if (reader.readFlag('video_signal_type_present_flag')) {
        reader.skipBits(3, 'video_format');
        const fullRangeOffset = reader.getBitOffset();
        const fullRange = reader.readFlag('video_full_range_flag');
        signaledFullRange = fullRange;
        if (reader.readFlag('colour_description_present_flag')) {
            const primariesOffset = reader.getBitOffset();
            const primariesValue = reader.readBits(8, 'colour_primaries');
            const transferOffset = reader.getBitOffset();
            const transferValue = reader.readBits(8, 'transfer_characteristics');
            const matrixOffset = reader.getBitOffset();
            const matrixValue = reader.readBits(8, 'matrix_coeffs');
            colorDescriptionCodes = {
                fullRange,
                matrix: matrixValue,
                primaries: primariesValue,
                transfer: transferValue
            };
            colorDescriptionOffsets = {
                fullRange: fullRangeOffset,
                matrix: matrixOffset,
                primaries: primariesOffset,
                transfer: transferOffset
            };
        }
    }

    let chromaSampleLocationType: number | null = null;
    if (reader.readFlag('chroma_loc_info_present_flag')) {
        chromaSampleLocationType = reader.readUnsignedExpGolomb('chroma_sample_loc_type_top_field', MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE);
        reader.readUnsignedExpGolomb('chroma_sample_loc_type_bottom_field', MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE);
    }
    reader.skipBits(1, 'neutral_chroma_indication_flag');
    const fieldSequence = reader.readFlag('field_seq_flag');
    reader.skipBits(1, 'frame_field_info_present_flag');

    const describedColorSpace = colorDescriptionCodes === null ? null : mapColorSpace(colorDescriptionCodes);
    return {
        chromaSampleLocationType,
        colorDescriptionCodes,
        colorDescriptionOffsets,
        // Full range survives an absent or wholly unspecified colour description; limited is the default anyway
        colorSpace: describedColorSpace ?? (signaledFullRange ? createFullRangeOnlyColorSpace() : null),
        defaultDisplayWindowFlagOffset: reader.getBitOffset(),
        fieldSequence
    };
}

function createFullRangeOnlyColorSpace(): HEVCSPSColorSpace {
    return {
        fullRange: true,
        matrix: null,
        primaries: null,
        transfer: null
    };
}

type SPSDimensions = {
    codedHeight: number
    codedWidth: number
    displayHeight: number
    displayWidth: number
};

/**
 * Returns the luma samples per chroma sample across and down, SubWidthC and SubHeightC, which scale the conformance window;
 * monochrome and separately coded 4:4:4 planes, ChromaArrayType 0, take 1 as 4:4:4 does.
 */
function getChromaSampleSpacing(chromaArrayType: number): { horizontal: number, vertical: number } {
    switch (chromaArrayType) {
        case CHROMA_FORMAT_420:
            return { horizontal: 2, vertical: 2 };
        case CHROMA_FORMAT_422:
            return { horizontal: 2, vertical: 1 };
        default:
            return { horizontal: 1, vertical: 1 };
    }
}

/** Reads the picture size and its conformance window in chroma units; only its declared level, checked later, bounds it. */
function parseSPSDimensions(reader: BoundedBitReader, chromaArrayType: number): SPSDimensions {
    const codedWidth = reader.readUnsignedExpGolomb('pic_width_in_luma_samples', MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE);
    const codedHeight = reader.readUnsignedExpGolomb('pic_height_in_luma_samples', MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE);
    if (codedWidth <= 0 || codedHeight <= 0) {
        throw new TypeError('The HEVC SPS coded dimensions are invalid');
    }
    if (!reader.readFlag('conformance_window_flag')) {
        return {
            codedHeight,
            codedWidth,
            displayHeight: codedHeight,
            displayWidth: codedWidth
        };
    }

    const leftOffset = reader.readUnsignedExpGolomb('conf_win_left_offset', MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE);
    const rightOffset = reader.readUnsignedExpGolomb('conf_win_right_offset', MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE);
    const topOffset = reader.readUnsignedExpGolomb('conf_win_top_offset', MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE);
    const bottomOffset = reader.readUnsignedExpGolomb('conf_win_bottom_offset', MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE);
    const spacing = getChromaSampleSpacing(chromaArrayType);
    const displayWidth = codedWidth - (spacing.horizontal * (leftOffset + rightOffset));
    const displayHeight = codedHeight - (spacing.vertical * (topOffset + bottomOffset));
    if (displayWidth <= 0 || displayHeight <= 0) {
        throw new TypeError('The HEVC SPS conformance window is invalid');
    }
    return { codedHeight, codedWidth, displayHeight, displayWidth };
}

/** Reads the plane depths: bounded, equal 8 or 10-bit planes only, and otherwise up to the range extensions' 16 bits. */
function parseSPSBitDepth(reader: BoundedBitReader, bounded: boolean): {
    bitDepth: number
    log2MaximumPictureOrderCountLSBMinus4: number
} {
    const maximumBitDepthMinus8 = bounded ? MAXIMUM_BOUNDED_BIT_DEPTH_MINUS8 : MAXIMUM_BIT_DEPTH_MINUS8;
    const lumaBitDepth = 8 + reader.readUnsignedExpGolomb('bit_depth_luma_minus8', maximumBitDepthMinus8);
    const chromaBitDepth = 8 + reader.readUnsignedExpGolomb('bit_depth_chroma_minus8', maximumBitDepthMinus8);
    if (bounded && (lumaBitDepth !== chromaBitDepth || (lumaBitDepth !== 8 && lumaBitDepth !== 10))) {
        throw new TypeError('The HEVC SPS bit depth is unsupported');
    }
    return {
        bitDepth: lumaBitDepth,
        log2MaximumPictureOrderCountLSBMinus4: reader.readUnsignedExpGolomb('log2_max_pic_order_cnt_lsb_minus4', 12)
    };
}

function getMaximumDPBPictureCount(
    levelIDC: number,
    codedWidth: number,
    codedHeight: number
): number {
    const pictureSampleCount = codedWidth * codedHeight;
    if (!Number.isSafeInteger(pictureSampleCount) || pictureSampleCount <= 0) {
        throw new TypeError('The HEVC SPS picture sample count is invalid');
    }
    // Only the specification bounds the DPB, at any picture size; an unknown level allows its largest
    const levelMaximumPictureSampleCount = HEVC_LEVEL_MAXIMUM_LUMA_PICTURE_SAMPLE_COUNTS[levelIDC];
    if (levelMaximumPictureSampleCount === undefined) {
        return MAXIMUM_HEVC_DPB_PICTURE_COUNT;
    }
    if (pictureSampleCount > levelMaximumPictureSampleCount) {
        throw new TypeError('The HEVC SPS dimensions exceed the declared level');
    }

    let levelMaximum: number;
    if (pictureSampleCount <= levelMaximumPictureSampleCount / 4) {
        levelMaximum = Math.min(4 * MAIN_PROFILE_BASE_DPB_PICTURE_COUNT, MAXIMUM_HEVC_DPB_PICTURE_COUNT);
    } else if (pictureSampleCount <= levelMaximumPictureSampleCount / 2) {
        levelMaximum = Math.min(2 * MAIN_PROFILE_BASE_DPB_PICTURE_COUNT, MAXIMUM_HEVC_DPB_PICTURE_COUNT);
    } else if (pictureSampleCount <= (3 * levelMaximumPictureSampleCount) / 4) {
        levelMaximum = Math.min(Math.floor((4 * MAIN_PROFILE_BASE_DPB_PICTURE_COUNT) / 3), MAXIMUM_HEVC_DPB_PICTURE_COUNT);
    } else {
        levelMaximum = MAIN_PROFILE_BASE_DPB_PICTURE_COUNT;
    }
    return levelMaximum;
}

/** Reads the sub-layer DPB sizes; bounded, each within the level's bound for the picture size, ordered, and with its reorder count inside its DPB. */
function parseSubLayerOrdering(
    reader: BoundedBitReader,
    maximumSubLayerIndex: number,
    maximumDPBPictureCount: number | null
): number {
    const subLayerOrderingInfoPresent = reader.readFlag('sps_sub_layer_ordering_info_present_flag');
    const firstOrderingLayer = subLayerOrderingInfoPresent ? 0 : maximumSubLayerIndex;
    let previousBufferingMinus1 = -1;
    let previousReorderPictureCount = -1;
    let declaredMaximumDPBPictureCount = 0;
    for (let subLayerIndex = firstOrderingLayer; subLayerIndex <= maximumSubLayerIndex; subLayerIndex += 1) {
        const bufferingMinus1 = reader.readUnsignedExpGolomb('sps_max_dec_pic_buffering_minus1', MAXIMUM_HEVC_DPB_PICTURE_COUNT - 1);
        const reorderPictureCount = reader.readUnsignedExpGolomb('sps_max_num_reorder_pics', MAXIMUM_HEVC_DPB_PICTURE_COUNT - 1);
        reader.readUnsignedExpGolomb('sps_max_latency_increase_plus1', MAXIMUM_UNSIGNED_EXP_GOLOMB_VALUE);
        const decodedPictureBufferSize = bufferingMinus1 + 1;
        declaredMaximumDPBPictureCount = Math.max(declaredMaximumDPBPictureCount, decodedPictureBufferSize);
        if (maximumDPBPictureCount === null) {
            continue;
        }
        if (decodedPictureBufferSize > maximumDPBPictureCount) {
            throw new TypeError('The HEVC SPS decoded picture buffer exceeds its level and picture-size bound');
        }
        if (reorderPictureCount > bufferingMinus1) {
            throw new TypeError('The HEVC SPS reorder count exceeds its decoded picture buffer');
        }
        if (previousBufferingMinus1 > bufferingMinus1 || previousReorderPictureCount > reorderPictureCount) {
            throw new TypeError('The HEVC SPS sub-layer ordering is not monotonic');
        }
        previousBufferingMinus1 = bufferingMinus1;
        previousReorderPictureCount = reorderPictureCount;
    }
    return declaredMaximumDPBPictureCount;
}

function skipCodingStructure(reader: BoundedBitReader): void {
    reader.readUnsignedExpGolomb('log2_min_luma_coding_block_size_minus3', 3);
    reader.readUnsignedExpGolomb('log2_diff_max_min_luma_coding_block_size', 6);
    reader.readUnsignedExpGolomb('log2_min_luma_transform_block_size_minus2', 3);
    reader.readUnsignedExpGolomb('log2_diff_max_min_luma_transform_block_size', 3);
    reader.readUnsignedExpGolomb('max_transform_hierarchy_depth_inter', 5);
    reader.readUnsignedExpGolomb('max_transform_hierarchy_depth_intra', 5);

    if (reader.readFlag('scaling_list_enabled_flag') && reader.readFlag('sps_scaling_list_data_present_flag')) {
        skipScalingListData(reader);
    }
    reader.skipBits(1, 'amp_enabled_flag');
    reader.skipBits(1, 'sample_adaptive_offset_enabled_flag');
    if (reader.readFlag('pcm_enabled_flag')) {
        reader.skipBits(8, 'pcm_sample_bit_depth');
        reader.readUnsignedExpGolomb('log2_min_pcm_luma_coding_block_size_minus3', 3);
        reader.readUnsignedExpGolomb('log2_diff_max_min_pcm_luma_coding_block_size', 6);
        reader.skipBits(1, 'pcm_loop_filter_disabled_flag');
    }
}

function skipReferencePictureSyntax(reader: BoundedBitReader, log2MaximumPictureOrderCountLSBMinus4: number): void {
    const shortTermReferencePictureSetCount = reader.readUnsignedExpGolomb(
        'num_short_term_ref_pic_sets',
        MAXIMUM_HEVC_SHORT_TERM_REFERENCE_PICTURE_SET_COUNT
    );
    parseShortTermReferencePictureSets(reader, shortTermReferencePictureSetCount);
    if (!reader.readFlag('long_term_ref_pics_present_flag')) {
        return;
    }

    const longTermReferencePictureCount = reader.readUnsignedExpGolomb(
        'num_long_term_ref_pics_sps',
        MAXIMUM_HEVC_LONG_TERM_REFERENCE_PICTURE_COUNT
    );
    const pictureOrderCountBitCount = log2MaximumPictureOrderCountLSBMinus4 + 4;
    for (let pictureIndex = 0; pictureIndex < longTermReferencePictureCount; pictureIndex += 1) {
        reader.skipBits(pictureOrderCountBitCount, 'lt_ref_pic_poc_lsb_sps');
        reader.skipBits(1, 'used_by_curr_pic_lt_sps_flag');
    }
}

type HEVCSPSSyntax = {
    bitDepth: number
    chromaFormat: number
    dimensions: SPSDimensions
    maximumDPBPictureCount: number
    profileTierLevel: ProfileTierLevel
    RBSP: Uint8Array
    VUI: ParsedVUI
};

type ParsedHEVCSPS = {
    configuration: HEVCSPSConfiguration
    RBSP: Uint8Array
    VUI: ParsedVUI
};

/**
 * Reads an SPS through its VUI, as far as FFmpeg's hevc/ps.c reads the SPS of any profile before its extensions.
 * Bounded, it fails where the progressive Main and Main 10 bounds fail: another profile, a scan that is not progressive, chroma other than 4:2:0,
 * unequal or other than 8 or 10-bit planes, a decoded picture buffer beyond its level, or a field sequence.
 * Unbounded, it fails only on syntax the specification does not allow.
 */
function readHEVCSPSSyntax(nalUnit: Uint8Array, bounded: boolean): HEVCSPSSyntax {
    const RBSP = createRBSP(nalUnit);
    const reader = new BoundedBitReader(RBSP);
    reader.skipBits(4, 'sps_video_parameter_set_id');
    const maximumSubLayerIndex = reader.readBits(3, 'sps_max_sub_layers_minus1');
    if (maximumSubLayerIndex > 6) {
        throw new TypeError('The HEVC SPS has too many temporal sub-layers');
    }
    reader.skipBits(1, 'sps_temporal_id_nesting_flag');
    const profileTierLevel = parseProfileTierLevel(reader, maximumSubLayerIndex);
    if (bounded && profileTierLevel.profileIDC !== 1 && profileTierLevel.profileIDC !== 2) {
        throw new TypeError('The HEVC SPS profile is unsupported');
    }
    if (bounded && (!profileTierLevel.progressiveSource || profileTierLevel.interlacedSource)) {
        throw new TypeError('The HEVC SPS is not constrained to progressive pictures');
    }

    reader.readUnsignedExpGolomb('sps_seq_parameter_set_id', 15);
    const chromaFormat = reader.readUnsignedExpGolomb('chroma_format_idc', CHROMA_FORMAT_444);
    if (bounded && chromaFormat !== CHROMA_FORMAT_420) {
        throw new TypeError('The HEVC SPS chroma format is not 4:2:0');
    }
    const separateColourPlanes = chromaFormat === CHROMA_FORMAT_444 && reader.readFlag('separate_colour_plane_flag');
    const dimensions = parseSPSDimensions(reader, separateColourPlanes ? 0 : chromaFormat);
    const bitDepthConfiguration = parseSPSBitDepth(reader, bounded);
    const maximumDPBPictureCount = parseSubLayerOrdering(
        reader,
        maximumSubLayerIndex,
        bounded ? getMaximumDPBPictureCount(profileTierLevel.levelIDC, dimensions.codedWidth, dimensions.codedHeight) : null
    );
    skipCodingStructure(reader);
    skipReferencePictureSyntax(reader, bitDepthConfiguration.log2MaximumPictureOrderCountLSBMinus4);
    reader.skipBits(1, 'sps_temporal_mvp_enabled_flag');
    reader.skipBits(1, 'strong_intra_smoothing_enabled_flag');
    // An SPS without VUI leaves its color and chroma location unspecified and field_seq_flag inferred as 0
    const vui: ParsedVUI = reader.readFlag('vui_parameters_present_flag') ?
        parseVUI(reader) :
        {
            chromaSampleLocationType: null,
            colorDescriptionCodes: null,
            colorDescriptionOffsets: null,
            colorSpace: null,
            defaultDisplayWindowFlagOffset: null,
            fieldSequence: false
        };
    if (bounded && vui.fieldSequence) {
        throw new TypeError('The HEVC SPS describes an interlaced field sequence');
    }
    return { bitDepth: bitDepthConfiguration.bitDepth, chromaFormat, dimensions, maximumDPBPictureCount, profileTierLevel, RBSP, VUI: vui };
}

function parseHEVCSPSSyntax(nalUnit: Uint8Array): ParsedHEVCSPS {
    const { bitDepth, dimensions, maximumDPBPictureCount, profileTierLevel, RBSP, VUI } = readHEVCSPSSyntax(nalUnit, true);
    return {
        configuration: {
            // The bounded read refused every depth but 8 and 10 and every profile but Main and Main 10
            bitDepth: bitDepth === 10 ? 10 : 8,
            chromaFormat: 1,
            codedHeight: dimensions.codedHeight,
            codedWidth: dimensions.codedWidth,
            colorSpace: VUI.colorSpace,
            displayHeight: dimensions.displayHeight,
            displayWidth: dimensions.displayWidth,
            levelIDC: profileTierLevel.levelIDC,
            maximumDPBPictureCount,
            profileIDC: profileTierLevel.profileIDC === 1 ? 1 : 2,
            progressive: true
        },
        RBSP,
        VUI
    };
}

/**
 * Reads the chroma of any profile's SPS: its chroma_format_idc and its VUI's chroma location, beyond the progressive Main and Main 10 bounds,
 * so range extensions, Main 12, and interlaced field sequences declare theirs too. Throws on syntax the specification does not allow.
 */
export function readHEVCSPSChroma(nalUnit: Uint8Array): HEVCSPSChroma {
    const { chromaFormat, VUI } = readHEVCSPSSyntax(nalUnit, false);
    return { chromaFormat, chromaSampleLocationType: VUI.chromaSampleLocationType };
}

function writeBits(
    bytes: Uint8Array,
    bitOffset: number,
    bitCount: number,
    value: number
): void {
    for (let bitIndex = 0; bitIndex < bitCount; bitIndex += 1) {
        const destinationBitOffset = bitOffset + bitIndex;
        const byteOffset = Math.floor(destinationBitOffset / 8);
        const shift = 7 - (destinationBitOffset % 8);
        const bitValue = (value >> (bitCount - bitIndex - 1)) & 1;
        bytes[byteOffset] = (bytes[byteOffset] & ~(1 << shift)) | (bitValue << shift);
    }
}

function createNALUnitFromRBSP(nalUnit: Uint8Array, RBSP: Uint8Array): Uint8Array {
    const escapedBytes: number[] = [ nalUnit[0], nalUnit[1] ];
    let consecutiveZeroCount = 0;
    for (const byteValue of RBSP) {
        if (consecutiveZeroCount >= 2 && byteValue <= 3) {
            escapedBytes.push(3);
            consecutiveZeroCount = 0;
        }
        escapedBytes.push(byteValue);
        consecutiveZeroCount = byteValue === 0 ? consecutiveZeroCount + 1 : 0;
    }
    return new Uint8Array(escapedBytes);
}

function readBit(bytes: Uint8Array, bitOffset: number): number {
    return (bytes[Math.floor(bitOffset / 8)] >> (7 - (bitOffset % 8))) & 1;
}

/** Returns the RBSP bit offset of rbsp_stop_one_bit, the last set bit, or null for an RBSP without one. */
function findRBSPStopBitOffset(RBSP: Uint8Array): number | null {
    for (let byteOffset = RBSP.byteLength - 1; byteOffset >= 0; byteOffset -= 1) {
        const byteValue = RBSP[byteOffset];
        if (byteValue !== 0) {
            // The lowest set bit of the last nonzero byte
            return (byteOffset * 8) + 7 - Math.log2(byteValue & -byteValue);
        }
    }
    return null;
}

/**
 * Returns an SPS whose VUI omits default_display_window_flag, as some old x265 builds wrote it, with the flag inserted as 0; null for any other SPS.
 * Chromium reads the next bits as the flag and a display window that fails its crop check, so the decoder rejects the stream.
 * The detection is FFmpeg's (hevc/ps.c): at the flag, at least 68 bits before rbsp_stop_one_bit, and the next 21 bits a set vui_timing_info_present_flag
 * then the zero top 20 bits of vui_num_units_in_tick, which a set flag would read as an implausible left offset.
 * Everything after the flag moves one bit, and a new stop bit and zero alignment close the RBSP.
 */
export function repairHEVCSPSDefaultDisplayWindow(nalUnit: Uint8Array): Uint8Array | null {
    let syntax: HEVCSPSSyntax;
    try {
        syntax = readHEVCSPSSyntax(nalUnit, false);
    } catch (error) {
        // An SPS the parser refuses is left as it is, for the decoder to judge
        if (error instanceof TypeError) {
            return null;
        }
        throw error;
    }
    const flagOffset = syntax.VUI.defaultDisplayWindowFlagOffset;
    const stopBitOffset = findRBSPStopBitOffset(syntax.RBSP);
    if (
        flagOffset === null
        || stopBitOffset === null
        || stopBitOffset - flagOffset < MISSING_DEFAULT_DISPLAY_WINDOW_MINIMUM_BIT_COUNT
    ) {
        return null;
    }
    let patternValue = 0;
    for (let bitIndex = 0; bitIndex < MISSING_DEFAULT_DISPLAY_WINDOW_PATTERN_BIT_LENGTH; bitIndex += 1) {
        patternValue = (patternValue * 2) + readBit(syntax.RBSP, flagOffset + bitIndex);
    }
    if (patternValue !== MISSING_DEFAULT_DISPLAY_WINDOW_PATTERN) {
        return null;
    }

    // The data bits, one more for the inserted flag, and the stop bit; zero-filled, so the flag and the alignment are already 0
    const repairedRBSP = new Uint8Array(Math.ceil((stopBitOffset + 2) / 8));
    for (let bitOffset = 0; bitOffset < stopBitOffset; bitOffset += 1) {
        if (readBit(syntax.RBSP, bitOffset) === 1) {
            writeBits(repairedRBSP, bitOffset < flagOffset ? bitOffset : bitOffset + 1, 1, 1);
        }
    }
    writeBits(repairedRBSP, stopBitOffset + 1, 1, 1);
    return createNALUnitFromRBSP(nalUnit, repairedRBSP);
}

/** Parses the bounded SPS fields of a Main or Main 10 stream: geometry, bit depth, profile, level, DPB size, and color description. */
export function parseHEVCSPS(nalUnit: Uint8Array): HEVCSPSConfiguration {
    return parseHEVCSPSSyntax(nalUnit).configuration;
}

/**
 * Returns whether a VUI transfer proves an HDR route.
 * An alternative transfer characteristics SEI value overrides the VUI.
 * Without one, an HLG route also accepts the BT.2020 10 and 12-bit transfers that HLG-compatible streams signal.
 */
function provesHDRTransfer(
    transferValue: number,
    expectedHDRTransfer: HEVCHDRTransfer,
    preferredTransferCharacteristics: number | null
): boolean {
    const effectiveTransferValue = preferredTransferCharacteristics ?? transferValue;
    switch (expectedHDRTransfer) {
        case 'pq':
            // A PQ VUI proves PQ whatever the SEI suggests; the SEI only matters for a compatible-signaled VUI
            return transferValue === PQ_TRANSFER_CHARACTERISTICS || effectiveTransferValue === PQ_TRANSFER_CHARACTERISTICS;
        case 'hlg':
            return effectiveTransferValue === HLG_TRANSFER_CHARACTERISTICS
                || (
                    preferredTransferCharacteristics === null
                    && (
                        transferValue === BT2020_10_BIT_TRANSFER_CHARACTERISTICS
                        || transferValue === BT2020_12_BIT_TRANSFER_CHARACTERISTICS
                    )
                );
    }
}

/**
 * Rewrites an existing VUI color description without changing coded video syntax.
 * An expected HDR route requires limited range, BT.2020 primaries, the BT.2020 non-constant-luminance matrix, and the route's transfer.
 * The access unit's preferred_transfer_characteristics, from an alternative transfer characteristics SEI, overrides the VUI transfer.
 */
export function rewriteHEVCSPSColorDescriptionToBT709(
    nalUnit: Uint8Array,
    expectedHDRTransfer?: HEVCHDRTransfer,
    preferredTransferCharacteristics: number | null = null
): Uint8Array {
    const parsedSPS = parseHEVCSPSSyntax(nalUnit);
    const offsets = parsedSPS.VUI.colorDescriptionOffsets;
    const codes = parsedSPS.VUI.colorDescriptionCodes;
    if (!offsets || !codes) {
        throw new TypeError('The HEVC SPS has no VUI color description to rewrite');
    }
    if (expectedHDRTransfer !== undefined && (
        codes.fullRange
        || codes.primaries !== BT2020_COLOR_PRIMARIES
        || codes.matrix !== BT2020_NCL_MATRIX_COEFFICIENTS
        || !provesHDRTransfer(codes.transfer, expectedHDRTransfer, preferredTransferCharacteristics)
    )) {
        throw new TypeError('The HEVC SPS does not match the expected limited-range BT.2020 HDR route');
    }
    if (
        !codes.fullRange
        && codes.matrix === BT709_MATRIX_COEFFICIENTS
        && codes.primaries === BT709_COLOR_PRIMARIES
        && codes.transfer === BT709_TRANSFER_CHARACTERISTICS
    ) {
        return nalUnit.slice();
    }

    const rewrittenRBSP = parsedSPS.RBSP.slice();
    writeBits(rewrittenRBSP, offsets.fullRange, 1, 0);
    writeBits(rewrittenRBSP, offsets.primaries, 8, BT709_COLOR_PRIMARIES);
    writeBits(rewrittenRBSP, offsets.transfer, 8, BT709_TRANSFER_CHARACTERISTICS);
    writeBits(rewrittenRBSP, offsets.matrix, 8, BT709_MATRIX_COEFFICIENTS);
    return createNALUnitFromRBSP(nalUnit, rewrittenRBSP);
}
