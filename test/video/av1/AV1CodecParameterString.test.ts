import { describe, expect, it } from 'vitest';

import { createAV1CodecParameterString } from 'webgpu-player/video/av1/AV1CodecParameterString';
import type {
    AV1ColorConfig,
    AV1OperatingPoint,
    AV1SequenceHeader
} from 'webgpu-player/video/av1/AV1SequenceHeaderParser';

const DEFAULT_COLOR_CONFIG: AV1ColorConfig = {
    bitDepth: 10,
    chromaSamplePosition: 0,
    colorDescriptionPresent: true,
    colorPrimaries: 9,
    fullRange: false,
    matrixCoefficients: 9,
    monochrome: false,
    separateUVDeltaQ: false,
    subsamplingX: 1,
    subsamplingY: 1,
    transferCharacteristics: 16
};

// Code points past the two digits a codec string color field carries
const THREE_DIGIT_COLOR_PRIMARIES = 100;
const THREE_DIGIT_TRANSFER_CHARACTERISTICS = 255;
const THREE_DIGIT_MATRIX_COEFFICIENTS = 128;
// DEFAULT_COLOR_CONFIG's codec string without its optional fields
const MANDATORY_FIELDS_CODEC_STRING = 'av01.0.08M.10';

function createSequenceHeader(
    colorConfig: Partial<AV1ColorConfig>,
    operatingPoint: Partial<AV1OperatingPoint> = {},
    profile = 0
): AV1SequenceHeader {
    return {
        colorConfig: { ...DEFAULT_COLOR_CONFIG, ...colorConfig },
        decoderModelInfo: null,
        filmGrainParametersPresent: false,
        maximumFrameHeight: 2_160,
        maximumFrameWidth: 3_840,
        operatingPoints: [
            {
                initialDisplayDelayMinus1: null,
                levelIndex: 8,
                operatingParameters: null,
                operatingPointIDC: 0,
                tier: 0,
                ...operatingPoint
            },
            // Only the first operating point describes the stream
            {
                initialDisplayDelayMinus1: null,
                levelIndex: 31,
                operatingParameters: null,
                operatingPointIDC: 0x101,
                tier: 1
            }
        ],
        profile,
        reducedStillPictureHeader: false,
        stillPicture: false,
        timingInfo: null
    };
}

describe('createAV1CodecParameterString', () => {
    it.each([
        {
            description: 'only the mandatory fields without a color description, whatever the range or format',
            expected: 'av01.0.00M.10',
            sequenceHeader: createSequenceHeader(
                {
                    colorDescriptionPresent: false,
                    colorPrimaries: 2,
                    fullRange: true,
                    matrixCoefficients: 2,
                    transferCharacteristics: 2
                },
                { levelIndex: 0 }
            )
        },
        {
            description: 'every field from a color description',
            expected: 'av01.0.08M.10.0.110.09.16.09.0',
            sequenceHeader: createSequenceHeader({})
        },
        {
            description: 'the first point\'s high tier',
            expected: 'av01.0.13H.10.0.110.09.18.09.0',
            sequenceHeader: createSequenceHeader({ transferCharacteristics: 18 }, { levelIndex: 13, tier: 1 })
        },
        {
            description: 'the short form when every optional field has its default',
            expected: 'av01.0.04M.08',
            sequenceHeader: createSequenceHeader(
                { bitDepth: 8, colorPrimaries: 1, matrixCoefficients: 1, transferCharacteristics: 1 },
                { levelIndex: 4 }
            )
        },
        {
            description: 'a 4:2:0 sample position, which keeps the optional fields',
            expected: 'av01.0.08M.08.0.111.01.01.01.0',
            sequenceHeader: createSequenceHeader({
                bitDepth: 8,
                chromaSamplePosition: 1,
                colorPrimaries: 1,
                matrixCoefficients: 1,
                transferCharacteristics: 1
            })
        },
        {
            description: 'monochrome with its full range',
            expected: 'av01.0.08M.10.1.110.09.16.09.1',
            sequenceHeader: createSequenceHeader({ fullRange: true, monochrome: true })
        },
        {
            description: 'High profile 4:4:4 sRGB',
            expected: 'av01.1.08M.10.0.000.01.13.00.1',
            sequenceHeader: createSequenceHeader(
                {
                    colorPrimaries: 1,
                    fullRange: true,
                    matrixCoefficients: 0,
                    subsamplingX: 0,
                    subsamplingY: 0,
                    transferCharacteristics: 13
                },
                {},
                1
            )
        },
        {
            description: 'Professional profile 12-bit 4:2:2, whose sample position digit is zero',
            expected: 'av01.2.08M.12.0.100.09.16.09.0',
            sequenceHeader: createSequenceHeader(
                { bitDepth: 12, chromaSamplePosition: 2, subsamplingX: 1, subsamplingY: 0 },
                {},
                2
            )
        },
        ...[
            { colorPrimaries: THREE_DIGIT_COLOR_PRIMARIES },
            { transferCharacteristics: THREE_DIGIT_TRANSFER_CHARACTERISTICS },
            { matrixCoefficients: THREE_DIGIT_MATRIX_COEFFICIENTS }
        ].map((colorConfig: Partial<AV1ColorConfig>) => ({
            description: `only the mandatory fields for a code point beyond two digits: ${JSON.stringify(colorConfig)}`,
            expected: MANDATORY_FIELDS_CODEC_STRING,
            sequenceHeader: createSequenceHeader(colorConfig)
        }))
    ])('writes $description', ({ expected, sequenceHeader }) => {
        expect(createAV1CodecParameterString(sequenceHeader)).toBe(expected);
    });
});
