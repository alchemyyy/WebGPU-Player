import {
    AV1_OBU_TYPE_SEQUENCE_HEADER,
    AV1OBUParseError,
    parseAV1OBUs
} from './AV1OBUParser';

// Sequence header syntax from the AV1 specification, section 5.5, and its semantics, section 6.4
const MAIN_PROFILE = 0;
const HIGH_PROFILE = 1;
const PROFESSIONAL_PROFILE = 2;
// seq_tier is coded only for levels above 3.3
const MAXIMUM_SEQUENCE_LEVEL_INDEX_WITHOUT_TIER = 7;
const MAXIMUM_UVLC_LEADING_ZERO_COUNT = 32;
const MAXIMUM_UVLC_VALUE = 0xFFFF_FFFF;
const BITS_PER_BYTE = 8;
const COLOR_PRIMARIES_BT709 = 1;
const COLOR_PRIMARIES_UNSPECIFIED = 2;
const TRANSFER_CHARACTERISTICS_UNSPECIFIED = 2;
const TRANSFER_CHARACTERISTICS_SRGB = 13;
const MATRIX_COEFFICIENTS_IDENTITY = 0;
const MATRIX_COEFFICIENTS_UNSPECIFIED = 2;
const CHROMA_SAMPLE_POSITION_UNKNOWN = 0;

export type AV1BitDepth = 8 | 10 | 12;
export type AV1ChromaSubsampling = 0 | 1;

export type AV1TimingInfo = {
    numberOfUnitsInDisplayTick: number
    timeScale: number
    /** num_ticks_per_picture_minus_1, coded only when equal_picture_interval is set */
    ticksPerPictureMinus1: number | null
};

export type AV1DecoderModelInfo = {
    bufferDelayLengthMinus1: number
    bufferRemovalTimeLengthMinus1: number
    framePresentationTimeLengthMinus1: number
    numberOfUnitsInDecodingTick: number
};

export type AV1OperatingParameters = {
    decoderBufferDelay: number
    encoderBufferDelay: number
    lowDelayMode: boolean
};

export type AV1OperatingPoint = {
    /** initial_display_delay_minus_1, coded only when the sequence and the point signal it */
    initialDisplayDelayMinus1: number | null
    /** seq_level_idx */
    levelIndex: number
    /** operating_point_params, coded only when the decoder model is present for the point */
    operatingParameters: AV1OperatingParameters | null
    /** operating_point_idc: the temporal and spatial layers the point decodes */
    operatingPointIDC: number
    /** seq_tier: 1 for the high tier */
    tier: 0 | 1
};

export type AV1ColorConfig = {
    bitDepth: AV1BitDepth
    /** chroma_sample_position, coded only for 4:2:0; 0 (unknown) otherwise */
    chromaSamplePosition: number
    /** Without a color description, the three code points are 2 (unspecified) */
    colorDescriptionPresent: boolean
    colorPrimaries: number
    /** color_range */
    fullRange: boolean
    matrixCoefficients: number
    monochrome: boolean
    separateUVDeltaQ: boolean
    subsamplingX: AV1ChromaSubsampling
    subsamplingY: AV1ChromaSubsampling
    transferCharacteristics: number
};

export type AV1SequenceHeader = {
    colorConfig: AV1ColorConfig
    decoderModelInfo: AV1DecoderModelInfo | null
    filmGrainParametersPresent: boolean
    maximumFrameHeight: number
    maximumFrameWidth: number
    /** The first point is the one a decoder chooses by default and the one codec strings describe */
    operatingPoints: readonly AV1OperatingPoint[]
    profile: number
    reducedStillPictureHeader: boolean
    stillPicture: boolean
    timingInfo: AV1TimingInfo | null
};

type ChromaFormat = {
    subsamplingX: AV1ChromaSubsampling
    subsamplingY: AV1ChromaSubsampling
};

/** Reads the most significant bit first, failing with a typed error at the end of the payload. */
class AV1BitReader {
    private bitOffset = 0;

    public constructor(private readonly data: Uint8Array) {}

    /** Reads an f(n) field of up to 32 bits. */
    public readBits(bitCount: number, fieldName: string): number {
        if (this.bitOffset + bitCount > this.data.byteLength * BITS_PER_BYTE) {
            throw new AV1OBUParseError(`The AV1 sequence header ends inside ${fieldName}`);
        }
        let value = 0;
        for (let bitIndex = 0; bitIndex < bitCount; bitIndex += 1) {
            const byteValue = this.data[Math.floor(this.bitOffset / BITS_PER_BYTE)];
            const bitValue = (byteValue >> (BITS_PER_BYTE - 1 - (this.bitOffset % BITS_PER_BYTE))) & 1;
            // Multiplication, because shifts wrap at 32 bits
            value = (value * 2) + bitValue;
            this.bitOffset += 1;
        }
        return value;
    }

    public readFlag(fieldName: string): boolean {
        return this.readBits(1, fieldName) === 1;
    }

    /** Skips fields whose values the parse does not keep. */
    public skipBits(bitCount: number, fieldNames: string): void {
        this.readBits(bitCount, fieldNames);
    }

    /** Reads a uvlc() field, whose leading zero bits give the length of its value. */
    public readUVLC(fieldName: string): number {
        let leadingZeroCount = 0;
        while (!this.readFlag(fieldName)) {
            leadingZeroCount += 1;
        }
        if (leadingZeroCount >= MAXIMUM_UVLC_LEADING_ZERO_COUNT) {
            return MAXIMUM_UVLC_VALUE;
        }
        return this.readBits(leadingZeroCount, fieldName) + (2 ** leadingZeroCount) - 1;
    }

    /** Requires trailing_bits(): one set bit, then only zero bits to the end of the payload. */
    public requireTrailingBits(): void {
        if (!this.readFlag('trailing_one_bit')) {
            throw new AV1OBUParseError('The AV1 sequence header does not end with its trailing bits');
        }
        while (this.bitOffset < this.data.byteLength * BITS_PER_BYTE) {
            if (this.readFlag('trailing_zero_bit')) {
                throw new AV1OBUParseError('The AV1 sequence header has data after its trailing bits');
            }
        }
    }
}

function readTimingInfo(reader: AV1BitReader): AV1TimingInfo {
    const numberOfUnitsInDisplayTick = reader.readBits(32, 'num_units_in_display_tick');
    const timeScale = reader.readBits(32, 'time_scale');
    const equalPictureInterval = reader.readFlag('equal_picture_interval');
    return {
        numberOfUnitsInDisplayTick,
        ticksPerPictureMinus1: equalPictureInterval ? reader.readUVLC('num_ticks_per_picture_minus_1') : null,
        timeScale
    };
}

function readDecoderModelInfo(reader: AV1BitReader): AV1DecoderModelInfo {
    const bufferDelayLengthMinus1 = reader.readBits(5, 'buffer_delay_length_minus_1');
    const numberOfUnitsInDecodingTick = reader.readBits(32, 'num_units_in_decoding_tick');
    const bufferRemovalTimeLengthMinus1 = reader.readBits(5, 'buffer_removal_time_length_minus_1');
    const framePresentationTimeLengthMinus1 = reader.readBits(5, 'frame_presentation_time_length_minus_1');
    return {
        bufferDelayLengthMinus1,
        bufferRemovalTimeLengthMinus1,
        framePresentationTimeLengthMinus1,
        numberOfUnitsInDecodingTick
    };
}

function readOperatingParameters(reader: AV1BitReader, decoderModelInfo: AV1DecoderModelInfo): AV1OperatingParameters {
    const bufferDelayBitCount = decoderModelInfo.bufferDelayLengthMinus1 + 1;
    const decoderBufferDelay = reader.readBits(bufferDelayBitCount, 'decoder_buffer_delay');
    const encoderBufferDelay = reader.readBits(bufferDelayBitCount, 'encoder_buffer_delay');
    return {
        decoderBufferDelay,
        encoderBufferDelay,
        lowDelayMode: reader.readFlag('low_delay_mode_flag')
    };
}

function readOperatingPoint(
    reader: AV1BitReader,
    decoderModelInfo: AV1DecoderModelInfo | null,
    initialDisplayDelayPresent: boolean
): AV1OperatingPoint {
    const operatingPointIDC = reader.readBits(12, 'operating_point_idc');
    const levelIndex = reader.readBits(5, 'seq_level_idx');
    const tier = levelIndex > MAXIMUM_SEQUENCE_LEVEL_INDEX_WITHOUT_TIER ? reader.readBits(1, 'seq_tier') as 0 | 1 : 0;
    const operatingParameters = decoderModelInfo && reader.readFlag('decoder_model_present_for_this_op') ?
        readOperatingParameters(reader, decoderModelInfo) :
        null;
    const initialDisplayDelayMinus1 = initialDisplayDelayPresent
        && reader.readFlag('initial_display_delay_present_for_this_op') ?
        reader.readBits(4, 'initial_display_delay_minus_1') :
        null;
    return {
        initialDisplayDelayMinus1,
        levelIndex,
        operatingParameters,
        operatingPointIDC,
        tier
    };
}

/** Reads every operating point; a reduced still picture header codes only the first point's level. */
function readOperatingPoints(reader: AV1BitReader, decoderModelInfo: AV1DecoderModelInfo | null): AV1OperatingPoint[] {
    const initialDisplayDelayPresent = reader.readFlag('initial_display_delay_present_flag');
    const operatingPointCount = reader.readBits(5, 'operating_points_cnt_minus_1') + 1;
    const operatingPoints: AV1OperatingPoint[] = [];
    for (let operatingPointIndex = 0; operatingPointIndex < operatingPointCount; operatingPointIndex += 1) {
        operatingPoints.push(readOperatingPoint(reader, decoderModelInfo, initialDisplayDelayPresent));
    }
    return operatingPoints;
}

/** Skips the inter-prediction and screen content tool flags, which a reduced still picture header omits. */
function skipInterToolFlags(reader: AV1BitReader): void {
    reader.skipBits(4, 'enable_interintra_compound, enable_masked_compound, enable_warped_motion, enable_dual_filter');
    const enableOrderHint = reader.readFlag('enable_order_hint');
    if (enableOrderHint) {
        reader.skipBits(2, 'enable_jnt_comp, enable_ref_frame_mvs');
    }
    // Choosing screen content tools per frame (SELECT_SCREEN_CONTENT_TOOLS) counts as using them
    let screenContentToolsUsed = true;
    if (!reader.readFlag('seq_choose_screen_content_tools')) {
        screenContentToolsUsed = reader.readFlag('seq_force_screen_content_tools');
    }
    if (screenContentToolsUsed && !reader.readFlag('seq_choose_integer_mv')) {
        reader.skipBits(1, 'seq_force_integer_mv');
    }
    if (enableOrderHint) {
        reader.skipBits(3, 'order_hint_bits_minus_1');
    }
}

function readChromaFormat(
    reader: AV1BitReader,
    profile: number,
    bitDepth: AV1BitDepth
): ChromaFormat {
    switch (profile) {
        case MAIN_PROFILE:
            return { subsamplingX: 1, subsamplingY: 1 };
        case HIGH_PROFILE:
            return { subsamplingX: 0, subsamplingY: 0 };
        default:
            break;
    }
    // The Professional profile codes its chroma format only at 12 bits, and is 4:2:2 otherwise
    if (bitDepth !== 12) {
        return { subsamplingX: 1, subsamplingY: 0 };
    }
    const subsamplingX = reader.readBits(1, 'subsampling_x') as AV1ChromaSubsampling;
    return {
        subsamplingX,
        subsamplingY: subsamplingX === 1 ? reader.readBits(1, 'subsampling_y') as AV1ChromaSubsampling : 0
    };
}

function readBitDepth(reader: AV1BitReader, profile: number): AV1BitDepth {
    const highBitDepth = reader.readFlag('high_bitdepth');
    if (profile === PROFESSIONAL_PROFILE && highBitDepth) {
        return reader.readFlag('twelve_bit') ? 12 : 10;
    }
    return highBitDepth ? 10 : 8;
}

function readColorConfig(reader: AV1BitReader, profile: number): AV1ColorConfig {
    const bitDepth = readBitDepth(reader, profile);
    // The High profile is always 4:4:4 color
    const monochrome = profile !== HIGH_PROFILE && reader.readFlag('mono_chrome');
    const colorDescriptionPresent = reader.readFlag('color_description_present_flag');
    const colorPrimaries = colorDescriptionPresent ?
        reader.readBits(8, 'color_primaries') :
        COLOR_PRIMARIES_UNSPECIFIED;
    const transferCharacteristics = colorDescriptionPresent ?
        reader.readBits(8, 'transfer_characteristics') :
        TRANSFER_CHARACTERISTICS_UNSPECIFIED;
    const matrixCoefficients = colorDescriptionPresent ?
        reader.readBits(8, 'matrix_coefficients') :
        MATRIX_COEFFICIENTS_UNSPECIFIED;
    const colorCodePoints = { colorDescriptionPresent, colorPrimaries, matrixCoefficients, transferCharacteristics };
    if (monochrome) {
        return {
            ...colorCodePoints,
            bitDepth,
            chromaSamplePosition: CHROMA_SAMPLE_POSITION_UNKNOWN,
            fullRange: reader.readFlag('color_range'),
            monochrome,
            separateUVDeltaQ: false,
            subsamplingX: 1,
            subsamplingY: 1
        };
    }
    // sRGB with the identity matrix is full-range 4:4:4 without coding either
    if (
        colorPrimaries === COLOR_PRIMARIES_BT709
        && transferCharacteristics === TRANSFER_CHARACTERISTICS_SRGB
        && matrixCoefficients === MATRIX_COEFFICIENTS_IDENTITY
    ) {
        return {
            ...colorCodePoints,
            bitDepth,
            chromaSamplePosition: CHROMA_SAMPLE_POSITION_UNKNOWN,
            fullRange: true,
            monochrome,
            separateUVDeltaQ: reader.readFlag('separate_uv_delta_q'),
            subsamplingX: 0,
            subsamplingY: 0
        };
    }
    const fullRange = reader.readFlag('color_range');
    const chromaFormat = readChromaFormat(reader, profile, bitDepth);
    const chromaSamplePosition = chromaFormat.subsamplingX === 1 && chromaFormat.subsamplingY === 1 ?
        reader.readBits(2, 'chroma_sample_position') :
        CHROMA_SAMPLE_POSITION_UNKNOWN;
    return {
        ...colorCodePoints,
        bitDepth,
        chromaSamplePosition,
        fullRange,
        monochrome,
        separateUVDeltaQ: reader.readFlag('separate_uv_delta_q'),
        subsamplingX: chromaFormat.subsamplingX,
        subsamplingY: chromaFormat.subsamplingY
    };
}

/**
 * Parses the payload of one sequence header OBU bit-exactly, through its trailing bits.
 * A reserved profile, a truncated field, or data after the trailing bits fails with AV1OBUParseError.
 */
export function parseAV1SequenceHeader(payload: Uint8Array): AV1SequenceHeader {
    const reader = new AV1BitReader(payload);
    const profile = reader.readBits(3, 'seq_profile');
    if (profile > PROFESSIONAL_PROFILE) {
        throw new AV1OBUParseError(`The AV1 seq_profile ${profile} is reserved`);
    }
    const stillPicture = reader.readFlag('still_picture');
    const reducedStillPictureHeader = reader.readFlag('reduced_still_picture_header');
    let timingInfo: AV1TimingInfo | null = null;
    let decoderModelInfo: AV1DecoderModelInfo | null = null;
    let operatingPoints: AV1OperatingPoint[];
    if (reducedStillPictureHeader) {
        operatingPoints = [ {
            initialDisplayDelayMinus1: null,
            levelIndex: reader.readBits(5, 'seq_level_idx'),
            operatingParameters: null,
            operatingPointIDC: 0,
            tier: 0
        } ];
    } else {
        if (reader.readFlag('timing_info_present_flag')) {
            timingInfo = readTimingInfo(reader);
            // The decoder model needs timing, so its flag is coded only after timing info
            decoderModelInfo = reader.readFlag('decoder_model_info_present_flag') ? readDecoderModelInfo(reader) : null;
        }
        operatingPoints = readOperatingPoints(reader, decoderModelInfo);
    }

    const frameWidthBitCount = reader.readBits(4, 'frame_width_bits_minus_1') + 1;
    const frameHeightBitCount = reader.readBits(4, 'frame_height_bits_minus_1') + 1;
    const maximumFrameWidth = reader.readBits(frameWidthBitCount, 'max_frame_width_minus_1') + 1;
    const maximumFrameHeight = reader.readBits(frameHeightBitCount, 'max_frame_height_minus_1') + 1;
    if (!reducedStillPictureHeader && reader.readFlag('frame_id_numbers_present_flag')) {
        reader.skipBits(7, 'delta_frame_id_length_minus_2, additional_frame_id_length_minus_1');
    }
    reader.skipBits(3, 'use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter');
    if (!reducedStillPictureHeader) {
        skipInterToolFlags(reader);
    }
    reader.skipBits(3, 'enable_superres, enable_cdef, enable_restoration');
    const colorConfig = readColorConfig(reader, profile);
    const filmGrainParametersPresent = reader.readFlag('film_grain_params_present');
    reader.requireTrailingBits();

    return {
        colorConfig,
        decoderModelInfo,
        filmGrainParametersPresent,
        maximumFrameHeight,
        maximumFrameWidth,
        operatingPoints,
        profile,
        reducedStillPictureHeader,
        stillPicture,
        timingInfo
    };
}

/** Parses the first sequence header OBU of a temporal unit, or returns null when the unit has none. */
export function findAV1SequenceHeader(temporalUnit: Uint8Array): AV1SequenceHeader | null {
    const sequenceHeaderOBU = parseAV1OBUs(temporalUnit).find(obu => obu.type === AV1_OBU_TYPE_SEQUENCE_HEADER);
    return sequenceHeaderOBU ? parseAV1SequenceHeader(sequenceHeaderOBU.payload) : null;
}
