import type { AV1SequenceHeader } from './AV1SequenceHeaderParser';

// The codecs parameter string of the AV1 ISOBMFF binding, section 5: av01.P.LLT.DD[.M.CCC.cp.tc.mc.F]
const AV1_SAMPLE_ENTRY_TYPE = 'av01';
const HIGH_TIER = 1;
// What a short codec string implies: not monochrome, 4:2:0 with an unknown sample position, BT.709, limited range
const DEFAULT_OPTIONAL_FIELDS = '.0.110.01.01.01.0';
// The color fields are two decimal digits, although the sequence header codes each in 8 bits
const MAXIMUM_TWO_DIGIT_CODE_POINT = 99;

function formatTwoDigits(value: number): string {
    return value.toString().padStart(2, '0');
}

/**
 * Returns the codecs parameter string of an AV1 stream from its sequence header and first operating point.
 * The optional fields are written only from a color description whose code points fit their two digits, the one case that fills every field exactly.
 * Optional fields equal to their defaults are left out, as the short form implies them.
 */
export function createAV1CodecParameterString(sequenceHeader: AV1SequenceHeader): string {
    const firstOperatingPoint = sequenceHeader.operatingPoints[0];
    const colorConfig = sequenceHeader.colorConfig;
    const mandatoryFields = `${AV1_SAMPLE_ENTRY_TYPE}.${sequenceHeader.profile}`
        + `.${formatTwoDigits(firstOperatingPoint.levelIndex)}${firstOperatingPoint.tier === HIGH_TIER ? 'H' : 'M'}`
        + `.${formatTwoDigits(colorConfig.bitDepth)}`;
    if (
        !colorConfig.colorDescriptionPresent
        || colorConfig.colorPrimaries > MAXIMUM_TWO_DIGIT_CODE_POINT
        || colorConfig.transferCharacteristics > MAXIMUM_TWO_DIGIT_CODE_POINT
        || colorConfig.matrixCoefficients > MAXIMUM_TWO_DIGIT_CODE_POINT
    ) {
        return mandatoryFields;
    }

    // The third chroma digit is the sample position for 4:2:0 only
    const chromaSamplePosition = colorConfig.subsamplingX === 1 && colorConfig.subsamplingY === 1 ?
        colorConfig.chromaSamplePosition :
        0;
    const optionalFields = `.${colorConfig.monochrome ? 1 : 0}`
        + `.${colorConfig.subsamplingX}${colorConfig.subsamplingY}${chromaSamplePosition}`
        + `.${formatTwoDigits(colorConfig.colorPrimaries)}`
        + `.${formatTwoDigits(colorConfig.transferCharacteristics)}`
        + `.${formatTwoDigits(colorConfig.matrixCoefficients)}`
        + `.${colorConfig.fullRange ? 1 : 0}`;
    return optionalFields === DEFAULT_OPTIONAL_FIELDS ?
        mandatoryFields :
        `${mandatoryFields}${optionalFields}`;
}
