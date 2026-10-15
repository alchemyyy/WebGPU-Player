import { describe, expect, it } from 'vitest';

import { parseHEVCDecoderConfiguration } from 'webgpu-player/demux/hevc/HEVCDecoderConfiguration';

import { createBytesFromHex } from '../../helpers/byteArrays';
import { createNALUnit } from '../../helpers/hevcNALUnits';

// NAL unit types of H.265 Table 7-1
const VPS_NAL_UNIT_TYPE = 32;
const SPS_NAL_UNIT_TYPE = 33;
const PPS_NAL_UNIT_TYPE = 34;
// nuh_layer_id 1 and nuh_temporal_id_plus1 1, in the second byte of a NAL unit header
const SECOND_LAYER_HEADER_BYTE = (1 << 3) | 1;

const MAIN10_PROFILE_IDC = 2;
const MAIN_BIT_DEPTH = 8;
const MAIN10_BIT_DEPTH = 10;
const CHROMA_FORMAT_420 = 1;
const DEFAULT_LENGTH_SIZE = 4;
const SHORT_LENGTH_SIZE = 2;

// The HEVCDecoderConfigurationRecord's fixed header, and the offsets these tests write
const HVCC_HEADER_BYTE_LENGTH = 23;
const CONFIGURATION_VERSION_OFFSET = 0;
const PROFILE_OFFSET = 1;
const CHROMA_FORMAT_OFFSET = 16;
const LUMA_BIT_DEPTH_OFFSET = 17;
const CHROMA_BIT_DEPTH_OFFSET = 18;
const LENGTH_SIZE_OFFSET = 21;
const NAL_ARRAY_COUNT_OFFSET = 22;
const CONFIGURATION_VERSION = 1;
// array_completeness set, then the NAL unit type
const COMPLETE_NAL_ARRAY_FLAG = 0x80;

const MAIN10_SPS = createBytesFromHex(
    '4201010220000003009000000300000300ffa005020169365959a4932bc05a848804820000030002000003000210'
);
const SECOND_LAYER_SPS = new Uint8Array([ SPS_NAL_UNIT_TYPE << 1, SECOND_LAYER_HEADER_BYTE, 0xFF, 0xFF ]);
const VPS_NAL_UNIT = createNALUnit(VPS_NAL_UNIT_TYPE, [ 1 ]);
const PPS_NAL_UNIT = createNALUnit(PPS_NAL_UNIT_TYPE, [ 3 ]);
const TRUNCATED_DESCRIPTION_ERROR = 'invalid NAL unit';
const MISMATCHED_PLANE_DEPTHS_ERROR = 'mismatched plane bit depths';

/** Builds an HVCC record whose NAL arrays each hold one of the NAL units. */
function createHVCCDescription(
    lengthSize: 1 | 2 | 3 | 4 = DEFAULT_LENGTH_SIZE,
    nalUnits: readonly Uint8Array[] = [ VPS_NAL_UNIT, MAIN10_SPS, PPS_NAL_UNIT ]
): Uint8Array {
    const descriptionBytes: number[] = new Array<number>(HVCC_HEADER_BYTE_LENGTH).fill(0);
    descriptionBytes[CONFIGURATION_VERSION_OFFSET] = CONFIGURATION_VERSION;
    descriptionBytes[PROFILE_OFFSET] = MAIN10_PROFILE_IDC;
    descriptionBytes[CHROMA_FORMAT_OFFSET] = CHROMA_FORMAT_420;
    descriptionBytes[LUMA_BIT_DEPTH_OFFSET] = MAIN10_BIT_DEPTH - MAIN_BIT_DEPTH;
    descriptionBytes[CHROMA_BIT_DEPTH_OFFSET] = MAIN10_BIT_DEPTH - MAIN_BIT_DEPTH;
    descriptionBytes[LENGTH_SIZE_OFFSET] = lengthSize - 1;
    descriptionBytes[NAL_ARRAY_COUNT_OFFSET] = nalUnits.length;
    for (const nalUnit of nalUnits) {
        const nalUnitType = (nalUnit[0] >> 1) & 0x3F;
        descriptionBytes.push(COMPLETE_NAL_ARRAY_FLAG | nalUnitType, 0, 1);
        descriptionBytes.push((nalUnit.byteLength >> 8) & 0xFF, nalUnit.byteLength & 0xFF);
        descriptionBytes.push(...nalUnit);
    }
    return new Uint8Array(descriptionBytes);
}

describe('parseHEVCDecoderConfiguration', () => {
    it('parses an HVCC record and its parameter sets', () => {
        const configuration = parseHEVCDecoderConfiguration(createHVCCDescription(SHORT_LENGTH_SIZE));

        expect(configuration).toMatchObject({
            bitDepth: MAIN10_BIT_DEPTH,
            chromaFormat: CHROMA_FORMAT_420,
            lengthSize: SHORT_LENGTH_SIZE,
            profileIDC: MAIN10_PROFILE_IDC
        });
        expect(configuration.sequenceParameterSets).toEqual([ MAIN10_SPS ]);
    });

    it('reads only base-layer parameter sets', () => {
        const configuration = parseHEVCDecoderConfiguration(createHVCCDescription(DEFAULT_LENGTH_SIZE, [
            VPS_NAL_UNIT,
            SECOND_LAYER_SPS,
            MAIN10_SPS,
            PPS_NAL_UNIT
        ]));

        expect(configuration.sequenceParameterSets).toEqual([ MAIN10_SPS ]);
    });

    it('rejects a truncated record and mismatched plane depths', () => {
        const description = createHVCCDescription();
        expect(() => parseHEVCDecoderConfiguration(description.subarray(0, -1))).toThrow(TRUNCATED_DESCRIPTION_ERROR);

        const mismatchedPlaneDepths = createHVCCDescription();
        mismatchedPlaneDepths[CHROMA_BIT_DEPTH_OFFSET] = 0;
        expect(() => parseHEVCDecoderConfiguration(mismatchedPlaneDepths)).toThrow(MISMATCHED_PLANE_DEPTHS_ERROR);
    });
});
