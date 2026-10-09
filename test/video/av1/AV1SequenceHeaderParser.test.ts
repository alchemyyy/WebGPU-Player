import { describe, expect, it } from 'vitest';

import { AV1OBUParseError } from 'webgpu-player/video/av1/AV1OBUParser';
import {
    findAV1SequenceHeader,
    parseAV1SequenceHeader
} from 'webgpu-player/video/av1/AV1SequenceHeaderParser';
import { createNativeVideoCapabilityVector } from 'webgpu-player/capability/vectors/NativeVideoCapabilityVectors';
import { createRawHDRCapabilityVector } from 'webgpu-player/capability/vectors/RawHDRCapabilityVectors';

const BITS_PER_BYTE = 8;
const OBU_HAS_SIZE_FIELD_FLAG = 0x02;
const OBU_TYPE_SEQUENCE_HEADER = 1;
const OBU_TYPE_TEMPORAL_DELIMITER = 2;
const OBU_TYPE_FRAME = 6;
const MAXIMUM_LEVEL_INDEX_WITHOUT_TIER = 7;
const FRAME_SIZE_BIT_COUNT = 16;
const COLOR_PRIMARIES_BT2020 = 9;
const COLOR_PRIMARIES_BT709 = 1;
const TRANSFER_CHARACTERISTICS_PQ = 16;
const TRANSFER_CHARACTERISTICS_SRGB = 13;
const MATRIX_COEFFICIENTS_BT2020_NCL = 9;
const MATRIX_COEFFICIENTS_IDENTITY = 0;

/** Writes bits most significant first, as the AV1 bitstream codes them. */
class BitWriter {
    private readonly bits: number[] = [];

    public writeBits(value: number, bitCount: number): this {
        for (let bitIndex = bitCount - 1; bitIndex >= 0; bitIndex -= 1) {
            this.bits.push(Math.floor(value / (2 ** bitIndex)) % 2);
        }
        return this;
    }

    public writeFlag(value: boolean): this {
        return this.writeBits(value ? 1 : 0, 1);
    }

    /** Writes uvlc(): the value plus one, after as many zero bits as that number has bits after its first. */
    public writeUVLC(value: number): this {
        const codeNumber = value + 1;
        const leadingZeroCount = Math.floor(Math.log2(codeNumber));
        return this.writeBits(0, leadingZeroCount)
            .writeBits(1, 1)
            .writeBits(codeNumber - (2 ** leadingZeroCount), leadingZeroCount);
    }

    /** Ends the payload with trailing_bits() and returns its bytes. */
    public finish(): Uint8Array {
        const bits = [ ...this.bits, 1 ];
        while (bits.length % BITS_PER_BYTE !== 0) {
            bits.push(0);
        }
        const bytes = new Uint8Array(bits.length / BITS_PER_BYTE);
        for (let bitIndex = 0; bitIndex < bits.length; bitIndex += 1) {
            const shift = BITS_PER_BYTE - 1 - (bitIndex % BITS_PER_BYTE);
            bytes[Math.floor(bitIndex / BITS_PER_BYTE)] |= bits[bitIndex] << shift;
        }
        return bytes;
    }
}

type ToolChoice = 'forced' | 'off' | 'per-frame';

// Each optional field is written when defined, in the order section 5.5 codes it
type SyntheticOperatingPoint = {
    initialDisplayDelayMinus1?: number
    levelIndex: number
    operatingParameters?: { decoderBufferDelay: number, encoderBufferDelay: number, lowDelayMode: boolean }
    operatingPointIDC: number
    tier?: 0 | 1
};

type SyntheticColorConfig = {
    chromaSamplePosition?: number
    colorDescription?: readonly [number, number, number]
    colorRange?: boolean
    highBitDepth: boolean
    monochrome?: boolean
    separateUVDeltaQ?: boolean
    subsampling?: readonly (0 | 1)[]
    twelveBit?: boolean
};

type SyntheticSequenceHeader = {
    colorConfig: SyntheticColorConfig
    decoderModelInfo?: {
        bufferDelayLengthMinus1: number
        bufferRemovalTimeLengthMinus1: number
        framePresentationTimeLengthMinus1: number
        numberOfUnitsInDecodingTick: number
    }
    enableOrderHint?: boolean
    filmGrainParametersPresent?: boolean
    frameIDNumbersPresent?: boolean
    initialDisplayDelayPresent?: boolean
    integerMotionVectors?: ToolChoice
    maximumFrameHeight: number
    maximumFrameWidth: number
    operatingPoints: readonly SyntheticOperatingPoint[]
    profile: number
    reducedStillPictureHeader?: boolean
    screenContentTools?: ToolChoice
    stillPicture?: boolean
    timingInfo?: { numberOfUnitsInDisplayTick: number, ticksPerPictureMinus1?: number, timeScale: number }
};

function writeToolChoice(writer: BitWriter, choice: ToolChoice): void {
    writer.writeFlag(choice === 'per-frame');
    if (choice !== 'per-frame') {
        writer.writeFlag(choice === 'forced');
    }
}

function writeOperatingPoints(writer: BitWriter, header: SyntheticSequenceHeader): void {
    writer.writeFlag(header.initialDisplayDelayPresent ?? false);
    writer.writeBits(header.operatingPoints.length - 1, 5);
    for (const operatingPoint of header.operatingPoints) {
        writer.writeBits(operatingPoint.operatingPointIDC, 12).writeBits(operatingPoint.levelIndex, 5);
        if (operatingPoint.levelIndex > MAXIMUM_LEVEL_INDEX_WITHOUT_TIER) {
            writer.writeBits(operatingPoint.tier ?? 0, 1);
        }
        if (header.decoderModelInfo) {
            const operatingParameters = operatingPoint.operatingParameters;
            writer.writeFlag(operatingParameters !== undefined);
            if (operatingParameters) {
                const bufferDelayBitCount = header.decoderModelInfo.bufferDelayLengthMinus1 + 1;
                writer.writeBits(operatingParameters.decoderBufferDelay, bufferDelayBitCount)
                    .writeBits(operatingParameters.encoderBufferDelay, bufferDelayBitCount)
                    .writeFlag(operatingParameters.lowDelayMode);
            }
        }
        if (header.initialDisplayDelayPresent) {
            writer.writeFlag(operatingPoint.initialDisplayDelayMinus1 !== undefined);
            if (operatingPoint.initialDisplayDelayMinus1 !== undefined) {
                writer.writeBits(operatingPoint.initialDisplayDelayMinus1, 4);
            }
        }
    }
}

function writeTimingAndOperatingPoints(writer: BitWriter, header: SyntheticSequenceHeader): void {
    if (header.reducedStillPictureHeader) {
        writer.writeBits(header.operatingPoints[0].levelIndex, 5);
        return;
    }
    const timingInfo = header.timingInfo;
    writer.writeFlag(timingInfo !== undefined);
    if (timingInfo) {
        writer.writeBits(timingInfo.numberOfUnitsInDisplayTick, 32)
            .writeBits(timingInfo.timeScale, 32)
            .writeFlag(timingInfo.ticksPerPictureMinus1 !== undefined);
        if (timingInfo.ticksPerPictureMinus1 !== undefined) {
            writer.writeUVLC(timingInfo.ticksPerPictureMinus1);
        }
        const decoderModelInfo = header.decoderModelInfo;
        writer.writeFlag(decoderModelInfo !== undefined);
        if (decoderModelInfo) {
            writer.writeBits(decoderModelInfo.bufferDelayLengthMinus1, 5)
                .writeBits(decoderModelInfo.numberOfUnitsInDecodingTick, 32)
                .writeBits(decoderModelInfo.bufferRemovalTimeLengthMinus1, 5)
                .writeBits(decoderModelInfo.framePresentationTimeLengthMinus1, 5);
        }
    }
    writeOperatingPoints(writer, header);
}

function writeToolFlags(writer: BitWriter, header: SyntheticSequenceHeader): void {
    if (!header.reducedStillPictureHeader) {
        writer.writeFlag(header.frameIDNumbersPresent ?? false);
        if (header.frameIDNumbersPresent) {
            // delta_frame_id_length_minus_2 and additional_frame_id_length_minus_1
            writer.writeBits(0b1011, 4).writeBits(0b010, 3);
        }
    }
    // use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter
    writer.writeBits(0b101, 3);
    if (!header.reducedStillPictureHeader) {
        // enable_interintra_compound, enable_masked_compound, enable_warped_motion, enable_dual_filter
        writer.writeBits(0b1010, 4);
        writer.writeFlag(header.enableOrderHint ?? false);
        if (header.enableOrderHint) {
            // enable_jnt_comp, enable_ref_frame_mvs
            writer.writeBits(0b11, 2);
        }
        const screenContentTools = header.screenContentTools ?? 'off';
        writeToolChoice(writer, screenContentTools);
        if (screenContentTools !== 'off') {
            writeToolChoice(writer, header.integerMotionVectors ?? 'per-frame');
        }
        if (header.enableOrderHint) {
            // order_hint_bits_minus_1
            writer.writeBits(0b110, 3);
        }
    }
    // enable_superres, enable_cdef, enable_restoration
    writer.writeBits(0b011, 3);
}

function writeColorConfig(writer: BitWriter, colorConfig: SyntheticColorConfig): void {
    writer.writeFlag(colorConfig.highBitDepth);
    if (colorConfig.twelveBit !== undefined) {
        writer.writeFlag(colorConfig.twelveBit);
    }
    if (colorConfig.monochrome !== undefined) {
        writer.writeFlag(colorConfig.monochrome);
    }
    writer.writeFlag(colorConfig.colorDescription !== undefined);
    for (const codePoint of colorConfig.colorDescription ?? []) {
        writer.writeBits(codePoint, 8);
    }
    if (colorConfig.colorRange !== undefined) {
        writer.writeFlag(colorConfig.colorRange);
    }
    for (const subsampling of colorConfig.subsampling ?? []) {
        writer.writeBits(subsampling, 1);
    }
    if (colorConfig.chromaSamplePosition !== undefined) {
        writer.writeBits(colorConfig.chromaSamplePosition, 2);
    }
    if (colorConfig.separateUVDeltaQ !== undefined) {
        writer.writeFlag(colorConfig.separateUVDeltaQ);
    }
}

/** Encodes a sequence header payload in the field order of section 5.5, through its trailing bits. */
function encodeSequenceHeader(header: SyntheticSequenceHeader): Uint8Array {
    const writer = new BitWriter()
        .writeBits(header.profile, 3)
        .writeFlag(header.stillPicture ?? false)
        .writeFlag(header.reducedStillPictureHeader ?? false);
    writeTimingAndOperatingPoints(writer, header);
    writer.writeBits(FRAME_SIZE_BIT_COUNT - 1, 4)
        .writeBits(FRAME_SIZE_BIT_COUNT - 1, 4)
        .writeBits(header.maximumFrameWidth - 1, FRAME_SIZE_BIT_COUNT)
        .writeBits(header.maximumFrameHeight - 1, FRAME_SIZE_BIT_COUNT);
    writeToolFlags(writer, header);
    writeColorConfig(writer, header.colorConfig);
    return writer.writeFlag(header.filmGrainParametersPresent ?? false).finish();
}

function createOBU(type: number, payload: Uint8Array): Uint8Array {
    if (payload.byteLength > 127) {
        throw new RangeError('The test OBU helper writes one-byte sizes');
    }
    return new Uint8Array([ (type << 3) | OBU_HAS_SIZE_FIELD_FLAG, payload.byteLength, ...payload ]);
}

const SINGLE_OPERATING_POINT: readonly SyntheticOperatingPoint[] = [ { levelIndex: 8, operatingPointIDC: 0 } ];

describe('AV1SequenceHeaderParser', () => {
    it('parses the reduced still picture header of a libaom keyframe', () => {
        expect(findAV1SequenceHeader(createNativeVideoCapabilityVector('av1').encodedKeyFrame)).toEqual({
            colorConfig: {
                bitDepth: 8,
                chromaSamplePosition: 0,
                colorDescriptionPresent: false,
                colorPrimaries: 2,
                fullRange: false,
                matrixCoefficients: 2,
                monochrome: false,
                separateUVDeltaQ: false,
                subsamplingX: 1,
                subsamplingY: 1,
                transferCharacteristics: 2
            },
            decoderModelInfo: null,
            filmGrainParametersPresent: false,
            maximumFrameHeight: 64,
            maximumFrameWidth: 64,
            operatingPoints: [ {
                initialDisplayDelayMinus1: null,
                levelIndex: 0,
                operatingParameters: null,
                operatingPointIDC: 0,
                tier: 0
            } ],
            profile: 0,
            reducedStillPictureHeader: true,
            stillPicture: true,
            timingInfo: null
        });
    });

    it('parses the 10-bit 4K libaom keyframe header', () => {
        const sequenceHeader = findAV1SequenceHeader(createRawHDRCapabilityVector('av1').encodedKeyFrame);

        expect(sequenceHeader).toMatchObject({
            colorConfig: {
                bitDepth: 10,
                monochrome: false,
                subsamplingX: 1,
                subsamplingY: 1
            },
            maximumFrameHeight: 2_160,
            maximumFrameWidth: 3_840,
            profile: 0
        });
    });

    it('reads timing info with a uvlc picture interval, the decoder model, and every operating point', () => {
        const payload = encodeSequenceHeader({
            colorConfig: {
                chromaSamplePosition: 1,
                colorDescription: [ COLOR_PRIMARIES_BT2020, TRANSFER_CHARACTERISTICS_PQ, MATRIX_COEFFICIENTS_BT2020_NCL ],
                colorRange: false,
                highBitDepth: true,
                monochrome: false,
                separateUVDeltaQ: true
            },
            decoderModelInfo: {
                bufferDelayLengthMinus1: 9,
                bufferRemovalTimeLengthMinus1: 13,
                framePresentationTimeLengthMinus1: 21,
                numberOfUnitsInDecodingTick: 0xFFFF_FFF0
            },
            enableOrderHint: true,
            filmGrainParametersPresent: true,
            frameIDNumbersPresent: true,
            initialDisplayDelayPresent: true,
            integerMotionVectors: 'forced',
            maximumFrameHeight: 2_160,
            maximumFrameWidth: 3_840,
            operatingPoints: [
                {
                    initialDisplayDelayMinus1: 9,
                    levelIndex: 13,
                    operatingParameters: { decoderBufferDelay: 700, encoderBufferDelay: 300, lowDelayMode: true },
                    operatingPointIDC: 0x301,
                    tier: 1
                },
                { levelIndex: 5, operatingPointIDC: 0x101 },
                {
                    levelIndex: 9,
                    operatingParameters: { decoderBufferDelay: 1_023, encoderBufferDelay: 0, lowDelayMode: false },
                    operatingPointIDC: 0x103,
                    tier: 0
                }
            ],
            profile: 0,
            screenContentTools: 'forced',
            timingInfo: { numberOfUnitsInDisplayTick: 1_001, ticksPerPictureMinus1: 1_000, timeScale: 60_000 }
        });

        expect(parseAV1SequenceHeader(payload)).toEqual({
            colorConfig: {
                bitDepth: 10,
                chromaSamplePosition: 1,
                colorDescriptionPresent: true,
                colorPrimaries: COLOR_PRIMARIES_BT2020,
                fullRange: false,
                matrixCoefficients: MATRIX_COEFFICIENTS_BT2020_NCL,
                monochrome: false,
                separateUVDeltaQ: true,
                subsamplingX: 1,
                subsamplingY: 1,
                transferCharacteristics: TRANSFER_CHARACTERISTICS_PQ
            },
            decoderModelInfo: {
                bufferDelayLengthMinus1: 9,
                bufferRemovalTimeLengthMinus1: 13,
                framePresentationTimeLengthMinus1: 21,
                numberOfUnitsInDecodingTick: 0xFFFF_FFF0
            },
            filmGrainParametersPresent: true,
            maximumFrameHeight: 2_160,
            maximumFrameWidth: 3_840,
            operatingPoints: [
                {
                    initialDisplayDelayMinus1: 9,
                    levelIndex: 13,
                    operatingParameters: { decoderBufferDelay: 700, encoderBufferDelay: 300, lowDelayMode: true },
                    operatingPointIDC: 0x301,
                    tier: 1
                },
                {
                    initialDisplayDelayMinus1: null,
                    levelIndex: 5,
                    operatingParameters: null,
                    operatingPointIDC: 0x101,
                    tier: 0
                },
                {
                    initialDisplayDelayMinus1: null,
                    levelIndex: 9,
                    operatingParameters: { decoderBufferDelay: 1_023, encoderBufferDelay: 0, lowDelayMode: false },
                    operatingPointIDC: 0x103,
                    tier: 0
                }
            ],
            profile: 0,
            reducedStillPictureHeader: false,
            stillPicture: false,
            timingInfo: { numberOfUnitsInDisplayTick: 1_001, ticksPerPictureMinus1: 1_000, timeScale: 60_000 }
        });
    });

    it('reads timing info without a picture interval or decoder model, and screen content tools chosen per frame', () => {
        const sequenceHeader = parseAV1SequenceHeader(encodeSequenceHeader({
            colorConfig: {
                chromaSamplePosition: 2,
                colorRange: true,
                highBitDepth: false,
                monochrome: false,
                separateUVDeltaQ: false
            },
            initialDisplayDelayPresent: true,
            integerMotionVectors: 'off',
            maximumFrameHeight: 1_080,
            maximumFrameWidth: 1_920,
            operatingPoints: [ { initialDisplayDelayMinus1: 3, levelIndex: 8, operatingPointIDC: 0 } ],
            profile: 0,
            screenContentTools: 'per-frame',
            timingInfo: { numberOfUnitsInDisplayTick: 1, timeScale: 24 }
        }));

        expect(sequenceHeader.timingInfo).toEqual({
            numberOfUnitsInDisplayTick: 1,
            ticksPerPictureMinus1: null,
            timeScale: 24
        });
        expect(sequenceHeader.decoderModelInfo).toBeNull();
        expect(sequenceHeader.operatingPoints).toEqual([ {
            initialDisplayDelayMinus1: 3,
            levelIndex: 8,
            operatingParameters: null,
            operatingPointIDC: 0,
            tier: 0
        } ]);
        expect(sequenceHeader.colorConfig).toMatchObject({
            bitDepth: 8,
            chromaSamplePosition: 2,
            colorDescriptionPresent: false,
            fullRange: true
        });
    });

    it('returns the largest uvlc value after 32 leading zero bits', () => {
        const writer = new BitWriter()
            .writeBits(0, 3)
            .writeFlag(false)
            .writeFlag(false)
            .writeFlag(true)
            .writeBits(1, 32)
            .writeBits(1, 32)
            .writeFlag(true)
            .writeBits(0, 32)
            .writeBits(1, 1)
            // decoder_model_info_present_flag, initial_display_delay_present_flag, one operating point at level 0
            .writeFlag(false)
            .writeFlag(false)
            .writeBits(0, 5)
            .writeBits(0, 12)
            .writeBits(0, 5)
            .writeBits(FRAME_SIZE_BIT_COUNT - 1, 4)
            .writeBits(FRAME_SIZE_BIT_COUNT - 1, 4)
            .writeBits(63, FRAME_SIZE_BIT_COUNT)
            .writeBits(63, FRAME_SIZE_BIT_COUNT);
        writeToolFlags(writer, {
            colorConfig: { highBitDepth: false },
            maximumFrameHeight: 64,
            maximumFrameWidth: 64,
            operatingPoints: SINGLE_OPERATING_POINT,
            profile: 0
        });
        writeColorConfig(writer, {
            chromaSamplePosition: 0,
            colorRange: false,
            highBitDepth: false,
            monochrome: false,
            separateUVDeltaQ: false
        });

        expect(parseAV1SequenceHeader(writer.writeFlag(false).finish()).timingInfo).toEqual({
            numberOfUnitsInDisplayTick: 1,
            ticksPerPictureMinus1: 0xFFFF_FFFF,
            timeScale: 1
        });
    });

    it.each([
        {
            colorConfig: { colorRange: true, highBitDepth: true, monochrome: true },
            description: 'a monochrome Main stream, which codes its range and nothing after it',
            expected: {
                bitDepth: 10,
                chromaSamplePosition: 0,
                fullRange: true,
                monochrome: true,
                separateUVDeltaQ: false,
                subsamplingX: 1,
                subsamplingY: 1
            },
            profile: 0
        },
        {
            colorConfig: {
                colorDescription: [ COLOR_PRIMARIES_BT709, 1, 1 ],
                colorRange: false,
                highBitDepth: false,
                separateUVDeltaQ: true
            },
            description: 'a 4:4:4 High stream, which codes no monochrome flag',
            expected: {
                bitDepth: 8,
                colorDescriptionPresent: true,
                fullRange: false,
                monochrome: false,
                separateUVDeltaQ: true,
                subsamplingX: 0,
                subsamplingY: 0
            },
            profile: 1
        },
        {
            colorConfig: {
                colorDescription: [ COLOR_PRIMARIES_BT709, TRANSFER_CHARACTERISTICS_SRGB, MATRIX_COEFFICIENTS_IDENTITY ],
                highBitDepth: true,
                separateUVDeltaQ: false
            },
            description: 'sRGB with the identity matrix, which is full-range 4:4:4 without coding either',
            expected: {
                bitDepth: 10,
                colorPrimaries: COLOR_PRIMARIES_BT709,
                fullRange: true,
                matrixCoefficients: MATRIX_COEFFICIENTS_IDENTITY,
                subsamplingX: 0,
                subsamplingY: 0,
                transferCharacteristics: TRANSFER_CHARACTERISTICS_SRGB
            },
            profile: 1
        },
        {
            colorConfig: {
                colorRange: false,
                highBitDepth: true,
                monochrome: false,
                separateUVDeltaQ: true,
                subsampling: [ 0 ],
                twelveBit: true
            },
            description: 'a 12-bit 4:4:4 Professional stream, which codes only subsampling_x',
            expected: { bitDepth: 12, chromaSamplePosition: 0, separateUVDeltaQ: true, subsamplingX: 0, subsamplingY: 0 },
            profile: 2
        },
        {
            colorConfig: {
                chromaSamplePosition: 2,
                colorRange: true,
                highBitDepth: true,
                monochrome: false,
                separateUVDeltaQ: false,
                subsampling: [ 1, 1 ],
                twelveBit: true
            },
            description: 'a 12-bit 4:2:0 Professional stream, which codes its sample position',
            expected: { bitDepth: 12, chromaSamplePosition: 2, fullRange: true, subsamplingX: 1, subsamplingY: 1 },
            profile: 2
        },
        {
            colorConfig: {
                colorRange: false,
                highBitDepth: true,
                monochrome: false,
                separateUVDeltaQ: true,
                subsampling: [ 1, 0 ],
                twelveBit: true
            },
            description: 'a 12-bit 4:2:2 Professional stream',
            expected: { bitDepth: 12, chromaSamplePosition: 0, separateUVDeltaQ: true, subsamplingX: 1, subsamplingY: 0 },
            profile: 2
        },
        {
            colorConfig: {
                colorRange: false,
                highBitDepth: true,
                monochrome: false,
                separateUVDeltaQ: true,
                twelveBit: false
            },
            description: 'a 10-bit Professional stream, which is 4:2:2 without coding it',
            expected: { bitDepth: 10, separateUVDeltaQ: true, subsamplingX: 1, subsamplingY: 0 },
            profile: 2
        },
        {
            colorConfig: {
                colorRange: true,
                highBitDepth: false,
                monochrome: false,
                separateUVDeltaQ: true
            },
            description: 'an 8-bit Professional stream, which codes no twelve_bit',
            expected: { bitDepth: 8, fullRange: true, separateUVDeltaQ: true, subsamplingX: 1, subsamplingY: 0 },
            profile: 2
        }
    ] as const)('reads the color config of $description', ({ colorConfig, expected, profile }) => {
        const sequenceHeader = parseAV1SequenceHeader(encodeSequenceHeader({
            colorConfig,
            enableOrderHint: true,
            filmGrainParametersPresent: true,
            frameIDNumbersPresent: true,
            maximumFrameHeight: 720,
            maximumFrameWidth: 1_280,
            operatingPoints: SINGLE_OPERATING_POINT,
            profile
        }));

        expect(sequenceHeader.colorConfig).toMatchObject(expected);
        expect(sequenceHeader.filmGrainParametersPresent).toBe(true);
        expect(sequenceHeader.maximumFrameWidth).toBe(1_280);
    });

    it.each([
        {
            description: 'a reserved profile',
            message: 'seq_profile 3 is reserved',
            payload: encodeSequenceHeader({
                colorConfig: { highBitDepth: false },
                maximumFrameHeight: 64,
                maximumFrameWidth: 64,
                operatingPoints: SINGLE_OPERATING_POINT,
                profile: 3
            })
        },
        {
            description: 'a truncated header',
            message: 'ends inside',
            payload: encodeSequenceHeader({
                colorConfig: { colorRange: false, highBitDepth: false, monochrome: false, separateUVDeltaQ: false },
                maximumFrameHeight: 64,
                maximumFrameWidth: 64,
                operatingPoints: SINGLE_OPERATING_POINT,
                profile: 1
            }).subarray(0, 6)
        },
        {
            description: 'a header without its trailing one bit',
            message: 'does not end with its trailing bits',
            payload: new Uint8Array([ ...encodeSequenceHeader({
                colorConfig: { colorRange: false, highBitDepth: false, separateUVDeltaQ: false },
                maximumFrameHeight: 64,
                maximumFrameWidth: 64,
                operatingPoints: SINGLE_OPERATING_POINT,
                profile: 1
            }) ].map((byteValue: number, byteIndex: number, bytes: number[]): number => (
                byteIndex === bytes.length - 1 ? 0 : byteValue
            )))
        },
        {
            description: 'data after the trailing bits',
            message: 'has data after its trailing bits',
            payload: new Uint8Array([ ...encodeSequenceHeader({
                colorConfig: { colorRange: false, highBitDepth: false, separateUVDeltaQ: false },
                maximumFrameHeight: 64,
                maximumFrameWidth: 64,
                operatingPoints: SINGLE_OPERATING_POINT,
                profile: 1
            }), 0x01 ])
        }
    ])('rejects $description with a typed error', ({ message, payload }) => {
        expect(() => parseAV1SequenceHeader(payload)).toThrow(AV1OBUParseError);
        expect(() => parseAV1SequenceHeader(payload)).toThrow(message);
    });

    it('finds the sequence header after a temporal delimiter and reports a unit without one', () => {
        const sequenceHeaderPayload = encodeSequenceHeader({
            colorConfig: { colorRange: false, highBitDepth: true, separateUVDeltaQ: false },
            maximumFrameHeight: 1_080,
            maximumFrameWidth: 1_920,
            operatingPoints: SINGLE_OPERATING_POINT,
            profile: 1
        });
        const temporalDelimiter = createOBU(OBU_TYPE_TEMPORAL_DELIMITER, new Uint8Array());
        const frame = createOBU(OBU_TYPE_FRAME, new Uint8Array([ 1, 2, 3 ]));

        expect(findAV1SequenceHeader(new Uint8Array([
            ...temporalDelimiter,
            ...createOBU(OBU_TYPE_SEQUENCE_HEADER, sequenceHeaderPayload),
            ...frame
        ]))).toEqual(parseAV1SequenceHeader(sequenceHeaderPayload));
        expect(findAV1SequenceHeader(new Uint8Array([ ...temporalDelimiter, ...frame ]))).toBeNull();
    });
});
