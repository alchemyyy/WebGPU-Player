import { describe, expect, it } from 'vitest';

import { parseHEVCNALUnits, type HEVCNALUnit } from 'webgpu-player/demux/dolby-vision/DolbyVisionHEVCSplitter';
import { HEVCTemporalSubLayers, isHEVCUnreferencedPicture } from 'webgpu-player/demux/hevc/HEVCTemporalSubLayers';
import { readHEVCSPSTemporalSubLayers } from 'webgpu-player/demux/hevc/HEVCSPSParser';

import { concatenate } from '../../helpers/byteArrays';

const ANNEX_B_START_CODE = new Uint8Array([ 0, 0, 0, 1 ]);
const HEVC_SPS_NAL_UNIT_TYPE = 33;
const HEVC_PREFIX_SEI_NAL_UNIT_TYPE = 39;
const HEVC_AUD_NAL_UNIT_TYPE = 35;
// TRAIL_N, TSA_N, STSA_N, RADL_N, RASL_N, and the reserved RSV_VCL_N10, RSV_VCL_N12, and RSV_VCL_N14
const SUB_LAYER_NON_REFERENCE_NAL_UNIT_TYPES = [ 0, 2, 4, 6, 8, 10, 12, 14 ];
// TRAIL_R, TSA_R, STSA_R, RADL_R, RASL_R, RSV_VCL_R15, BLA_W_LP, IDR_W_RADL, CRA_NUT, and the reserved RSV_IRAP_VCL22 and RSV_VCL24
const REFERENCED_NAL_UNIT_TYPES = [ 1, 3, 5, 7, 9, 15, 16, 19, 21, 22, 24 ];
const HIGHEST_TEMPORAL_ID = 2;
const ENHANCEMENT_LAYER_ID = 1;
// A slice payload byte that keeps every NAL unit clear of start codes
const SLICE_PAYLOAD_BYTE = 0xAF;
const MAIN_PROFILE_IDC = 1;
const MAIN_PROFILE_COMPATIBILITY_FLAGS = 0x6000_0000;
const LEVEL_3_1_IDC = 93;
const HVCC_HEADER_BYTE_LENGTH = 23;
const HVCC_LENGTH_SIZE_MINUS_ONE = 3;
const HVCC_EIGHT_BIT_DEPTH_BYTE = 0xF8;
const HVCC_ARRAY_COMPLETENESS = 0x80;

/** Writes the leading fields of an SPS bit by bit, as far as its sps_seq_parameter_set_id, which is all the sub-layer read takes. */
class SPSWriter {
    private readonly bits: number[] = [];

    public write(value: number, bitCount: number): this {
        for (let bitIndex = bitCount - 1; bitIndex >= 0; bitIndex -= 1) {
            this.bits.push(Math.floor(value / (2 ** bitIndex)) % 2);
        }
        return this;
    }

    public writeUnsignedExpGolomb(value: number): this {
        const codeNumber = value + 1;
        const bitCount = Math.floor(Math.log2(codeNumber)) + 1;
        return this.write(0, bitCount - 1).write(codeNumber, bitCount);
    }

    /** Ends the RBSP with its stop bit and escapes it into a NAL unit after a base-layer SPS header. */
    public finish(): Uint8Array {
        this.write(1, 1);
        while (this.bits.length % 8 !== 0) {
            this.bits.push(0);
        }
        const nalUnit = [ HEVC_SPS_NAL_UNIT_TYPE << 1, 1 ];
        let zeroCount = 0;
        for (let byteOffset = 0; byteOffset < this.bits.length; byteOffset += 8) {
            const byteValue = this.bits.slice(byteOffset, byteOffset + 8).reduce((value: number, bit: number): number => (value * 2) + bit, 0);
            if (zeroCount >= 2 && byteValue <= 3) {
                nalUnit.push(3);
                zeroCount = 0;
            }
            nalUnit.push(byteValue);
            zeroCount = byteValue === 0 ? zeroCount + 1 : 0;
        }
        return new Uint8Array(nalUnit);
    }
}

function createSPS(maximumSubLayerIndex: number, sequenceParameterSetID = 0): Uint8Array {
    const writer = new SPSWriter()
        // sps_video_parameter_set_id, sps_max_sub_layers_minus1, and sps_temporal_id_nesting_flag
        .write(0, 4)
        .write(maximumSubLayerIndex, 3)
        .write(1, 1)
        // general_profile_space, general_tier_flag, general_profile_idc, and its compatibility flags
        .write(0, 2)
        .write(0, 1)
        .write(MAIN_PROFILE_IDC, 5)
        .write(MAIN_PROFILE_COMPATIBILITY_FLAGS, 32)
        // Progressive and not interlaced, then the 46 constraint bits after those flags, and general_level_idc
        .write(1, 1)
        .write(0, 1)
        .write(0, 46)
        .write(LEVEL_3_1_IDC, 8);
    for (let subLayerIndex = 0; subLayerIndex < maximumSubLayerIndex; subLayerIndex += 1) {
        // Neither a sub-layer profile nor a sub-layer level
        writer.write(0, 2);
    }
    if (maximumSubLayerIndex > 0) {
        writer.write(0, 2 * (8 - maximumSubLayerIndex));
    }
    return writer.writeUnsignedExpGolomb(sequenceParameterSetID).finish();
}

function createNALUnit(type: number, temporalID: number, layerID = 0): Uint8Array {
    // forbidden_zero_bit, nal_unit_type, nuh_layer_id, and nuh_temporal_id_plus1
    return new Uint8Array([ (type << 1) | (layerID >> 5), ((layerID & 0x1F) << 3) | (temporalID + 1), SLICE_PAYLOAD_BYTE ]);
}

function parseAccessUnit(nalUnits: readonly Uint8Array[]): HEVCNALUnit[] {
    return parseHEVCNALUnits(
        concatenate(nalUnits.flatMap((nalUnit: Uint8Array): Uint8Array[] => [ ANNEX_B_START_CODE, nalUnit ])),
        { kind: 'annex-b' }
    );
}

/** Builds an hvcC that carries the given SPSs in one array. */
function createDecoderDescription(sequenceParameterSets: readonly Uint8Array[]): Uint8Array {
    const header = new Uint8Array(HVCC_HEADER_BYTE_LENGTH);
    header[0] = 1;
    header[1] = MAIN_PROFILE_IDC;
    header[16] = 0xFC | 1;
    header[17] = HVCC_EIGHT_BIT_DEPTH_BYTE;
    header[18] = HVCC_EIGHT_BIT_DEPTH_BYTE;
    header[21] = HVCC_LENGTH_SIZE_MINUS_ONE;
    header[22] = 1;
    const arrayHeader = new Uint8Array([ HVCC_ARRAY_COMPLETENESS | HEVC_SPS_NAL_UNIT_TYPE, 0, sequenceParameterSets.length ]);
    return concatenate([
        header,
        arrayHeader,
        ...sequenceParameterSets.flatMap((sequenceParameterSet: Uint8Array): Uint8Array[] => [
            new Uint8Array([ sequenceParameterSet.byteLength >> 8, sequenceParameterSet.byteLength & 0xFF ]),
            sequenceParameterSet
        ])
    ]);
}

describe('isHEVCUnreferencedPicture', () => {
    it('reads each NAL unit\'s TemporalId from its header', () => {
        expect(parseAccessUnit([ createNALUnit(1, 0), createNALUnit(0, HIGHEST_TEMPORAL_ID) ]).map((nalUnit: HEVCNALUnit): number => nalUnit.temporalID))
            .toEqual([ 0, HIGHEST_TEMPORAL_ID ]);
    });

    it.each(SUB_LAYER_NON_REFERENCE_NAL_UNIT_TYPES)('takes a picture of sub-layer non-reference type %i in the highest sub-layer', (type: number) => {
        expect(isHEVCUnreferencedPicture(parseAccessUnit([ createNALUnit(type, HIGHEST_TEMPORAL_ID) ]), HIGHEST_TEMPORAL_ID)).toBe(true);
    });

    it.each(REFERENCED_NAL_UNIT_TYPES)('refuses a picture of type %i, which a later picture may reference', (type: number) => {
        expect(isHEVCUnreferencedPicture(parseAccessUnit([ createNALUnit(type, HIGHEST_TEMPORAL_ID) ]), HIGHEST_TEMPORAL_ID)).toBe(false);
    });

    it('refuses a non-reference picture below the highest sub-layer, which a higher sub-layer\'s pictures may reference', () => {
        expect(isHEVCUnreferencedPicture(parseAccessUnit([ createNALUnit(0, HIGHEST_TEMPORAL_ID - 1) ]), HIGHEST_TEMPORAL_ID)).toBe(false);
    });

    it('refuses every picture while the highest sub-layer is unknown', () => {
        expect(isHEVCUnreferencedPicture(parseAccessUnit([ createNALUnit(0, 0) ]), null)).toBe(false);
    });

    it('judges the base layer\'s slices alone, all of them, and refuses an access unit without one', () => {
        const unreferencedSlice = createNALUnit(0, HIGHEST_TEMPORAL_ID);
        const parameterAndSEINALUnits = [ createNALUnit(HEVC_AUD_NAL_UNIT_TYPE, 0), createNALUnit(HEVC_PREFIX_SEI_NAL_UNIT_TYPE, 0) ];

        expect(isHEVCUnreferencedPicture(parseAccessUnit([ ...parameterAndSEINALUnits, unreferencedSlice, unreferencedSlice ]), HIGHEST_TEMPORAL_ID))
            .toBe(true);
        // An enhancement layer's referenced slice leaves the base layer's picture unreferenced
        expect(isHEVCUnreferencedPicture(
            parseAccessUnit([ unreferencedSlice, createNALUnit(1, 0, ENHANCEMENT_LAYER_ID) ]),
            HIGHEST_TEMPORAL_ID
        )).toBe(true);
        expect(isHEVCUnreferencedPicture(parseAccessUnit([ unreferencedSlice, createNALUnit(1, HIGHEST_TEMPORAL_ID) ]), HIGHEST_TEMPORAL_ID))
            .toBe(false);
        expect(isHEVCUnreferencedPicture(parseAccessUnit(parameterAndSEINALUnits), HIGHEST_TEMPORAL_ID)).toBe(false);
    });
});

describe('HEVCTemporalSubLayers', () => {
    it('reads an SPS\'s ID and highest sub-layer', () => {
        expect(readHEVCSPSTemporalSubLayers(createSPS(HIGHEST_TEMPORAL_ID, 1))).toEqual({
            maximumSubLayerIndex: HIGHEST_TEMPORAL_ID,
            sequenceParameterSetID: 1
        });
    });

    it('knows the highest sub-layer from the decoder description\'s SPS', () => {
        const temporalSubLayers = new HEVCTemporalSubLayers(createDecoderDescription([ createSPS(HIGHEST_TEMPORAL_ID) ]));

        expect(temporalSubLayers.getHighestTemporalID()).toBe(HIGHEST_TEMPORAL_ID);
        expect(temporalSubLayers.isUnreferencedPicture(parseAccessUnit([ createNALUnit(0, HIGHEST_TEMPORAL_ID) ]))).toBe(true);
    });

    it('waits for an in-band SPS without a decoder description, and replaces an SPS by its ID', () => {
        const temporalSubLayers = new HEVCTemporalSubLayers(undefined);
        const unreferencedAccessUnit = parseAccessUnit([ createNALUnit(0, HIGHEST_TEMPORAL_ID) ]);
        expect(temporalSubLayers.getHighestTemporalID()).toBeNull();
        expect(temporalSubLayers.isUnreferencedPicture(unreferencedAccessUnit)).toBe(false);

        temporalSubLayers.readAccessUnit(parseAccessUnit([ createSPS(HIGHEST_TEMPORAL_ID), createNALUnit(19, 0) ]));
        expect(temporalSubLayers.isUnreferencedPicture(unreferencedAccessUnit)).toBe(true);

        temporalSubLayers.readAccessUnit(parseAccessUnit([ createSPS(HIGHEST_TEMPORAL_ID - 1), createNALUnit(19, 0) ]));
        expect(temporalSubLayers.getHighestTemporalID()).toBe(HIGHEST_TEMPORAL_ID - 1);
        expect(temporalSubLayers.isUnreferencedPicture(unreferencedAccessUnit)).toBe(false);
    });

    it('leaves the highest sub-layer unknown while two SPSs disagree on it', () => {
        const temporalSubLayers = new HEVCTemporalSubLayers(createDecoderDescription([ createSPS(HIGHEST_TEMPORAL_ID, 0), createSPS(1, 1) ]));
        expect(temporalSubLayers.getHighestTemporalID()).toBeNull();

        temporalSubLayers.readAccessUnit(parseAccessUnit([ createSPS(1, 0) ]));
        expect(temporalSubLayers.getHighestTemporalID()).toBe(1);
    });

    it('leaves the highest sub-layer unknown for good after an SPS or a description it cannot read', () => {
        const temporalSubLayers = new HEVCTemporalSubLayers(undefined);
        temporalSubLayers.readAccessUnit(parseAccessUnit([ new Uint8Array([ HEVC_SPS_NAL_UNIT_TYPE << 1, 1, 0x01 ]) ]));
        temporalSubLayers.readAccessUnit(parseAccessUnit([ createSPS(HIGHEST_TEMPORAL_ID) ]));
        expect(temporalSubLayers.getHighestTemporalID()).toBeNull();

        expect(new HEVCTemporalSubLayers(new Uint8Array([ 1, 2, 3 ])).getHighestTemporalID()).toBeNull();
    });
});
