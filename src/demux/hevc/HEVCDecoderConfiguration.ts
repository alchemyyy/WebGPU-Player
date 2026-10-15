// Reads an HEVC track's ISO/IEC 14496-15 HEVCDecoderConfigurationRecord (hvcC): its profile, chroma format, bit depth, NAL length size,
// and the sequence parameter sets of its base layer, which describe the stream before its first packet.
import { getHEVCNALUnitLayerID, HEVC_BASE_LAYER_ID } from '../dolby-vision/DolbyVisionHEVCSplitter';

const HEVC_SPS_NAL_UNIT_TYPE = 33;
const MAXIMUM_DECODER_DESCRIPTION_BYTE_LENGTH = 1024 * 1024;
// The fixed part of the record, before its NAL unit arrays
const HVCC_HEADER_BYTE_LENGTH = 23;
const HVCC_CONFIGURATION_VERSION = 1;
const HVCC_NAL_ARRAY_COUNT_OFFSET = 22;
const MINIMUM_BIT_DEPTH = 8;
const MAXIMUM_BIT_DEPTH = 15;

export type HEVCDecoderConfiguration = {
    bitDepth: 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15
    chromaFormat: number
    lengthSize: 1 | 2 | 3 | 4
    profileIDC: number
    sequenceParameterSets: readonly Uint8Array[]
};

function toUint8Array(data: AllowSharedBufferSource): Uint8Array {
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    if (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer) {
        return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }

    throw new TypeError('The HEVC decoder description is not a buffer source');
}

function getNALUnitType(data: Uint8Array, offset: number): number {
    if (offset < 0 || offset + 1 >= data.byteLength) {
        throw new TypeError('An HEVC NAL unit is missing its two-byte header');
    }

    return (data[offset] >> 1) & 0x3F;
}

function parseHVCCNALArrays(description: Uint8Array, arrayCount: number): Uint8Array[] {
    const parameterSets: Uint8Array[] = [];
    let offset = HVCC_HEADER_BYTE_LENGTH;
    for (let arrayIndex = 0; arrayIndex < arrayCount; arrayIndex += 1) {
        if (offset + 3 > description.byteLength) {
            throw new TypeError('The HEVC decoder description ends inside a NAL array header');
        }
        const declaredNALUnitType = description[offset] & 0x3F;
        const nalUnitCount = (description[offset + 1] * 256) + description[offset + 2];
        offset += 3;

        for (let nalUnitIndex = 0; nalUnitIndex < nalUnitCount; nalUnitIndex += 1) {
            if (offset + 2 > description.byteLength) {
                throw new TypeError('The HEVC decoder description ends before a NAL unit length');
            }
            const nalUnitByteLength = (description[offset] * 256) + description[offset + 1];
            offset += 2;
            if (nalUnitByteLength < 2 || offset + nalUnitByteLength > description.byteLength) {
                throw new TypeError('The HEVC decoder description contains an invalid NAL unit');
            }

            const nalUnit = description.subarray(offset, offset + nalUnitByteLength);
            if (getNALUnitType(nalUnit, 0) !== declaredNALUnitType) {
                throw new TypeError('The HEVC decoder description NAL unit type does not match its array');
            }
            parameterSets.push(nalUnit);
            offset += nalUnitByteLength;
        }
    }

    if (offset !== description.byteLength) {
        throw new TypeError('The HEVC decoder description contains trailing bytes');
    }
    return parameterSets;
}

/** Reads the header of an HVCC record and the parameter sets of its base layer. */
function parseHVCCRecord(descriptionSource: AllowSharedBufferSource): {
    description: Uint8Array
    parameterSets: Uint8Array[]
} {
    const description = toUint8Array(descriptionSource);
    if (
        description.byteLength < HVCC_HEADER_BYTE_LENGTH
        || description.byteLength > MAXIMUM_DECODER_DESCRIPTION_BYTE_LENGTH
        || description[0] !== HVCC_CONFIGURATION_VERSION
    ) {
        throw new TypeError('The HEVC decoder description is not a supported HVCC record');
    }
    // Another layer's parameter sets, such as an alpha layer's that FFmpeg keeps in HVCC, do not describe the base layer, which is the only layer decoded
    const parameterSets = parseHVCCNALArrays(description, description[HVCC_NAL_ARRAY_COUNT_OFFSET]).filter(
        (parameterSet: Uint8Array): boolean => (
            getHEVCNALUnitLayerID(parameterSet) === HEVC_BASE_LAYER_ID
        )
    );
    return { description, parameterSets };
}

/** Parses one ISO/IEC 14496-15 HEVCDecoderConfigurationRecord. */
export function parseHEVCDecoderConfiguration(descriptionSource: AllowSharedBufferSource): HEVCDecoderConfiguration {
    const { description, parameterSets } = parseHVCCRecord(descriptionSource);
    const profileIDC = description[1] & 0x1F;
    const chromaFormat = description[16] & 0x03;
    const bitDepthValue = MINIMUM_BIT_DEPTH + (description[17] & 0x07);
    const chromaBitDepthValue = MINIMUM_BIT_DEPTH + (description[18] & 0x07);
    if (bitDepthValue < MINIMUM_BIT_DEPTH || bitDepthValue > MAXIMUM_BIT_DEPTH) {
        throw new TypeError('The HEVC decoder description has an invalid bit depth');
    }
    if (chromaBitDepthValue !== bitDepthValue) {
        throw new TypeError('The HEVC decoder description uses mismatched plane bit depths');
    }
    const bitDepth = bitDepthValue as HEVCDecoderConfiguration['bitDepth'];
    const lengthSize = ((description[21] & 0x03) + 1) as 1 | 2 | 3 | 4;

    return {
        bitDepth,
        chromaFormat,
        lengthSize,
        profileIDC,
        sequenceParameterSets: parameterSets
            .filter((parameterSet: Uint8Array): boolean => (
                getNALUnitType(parameterSet, 0) === HEVC_SPS_NAL_UNIT_TYPE
            ))
            .map((parameterSet: Uint8Array): Uint8Array => parameterSet.slice())
    };
}
