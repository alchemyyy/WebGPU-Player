// Recognizes HEVC pictures no later picture references, which a decoder may leave undecoded when they never present.
// A sub-layer non-reference picture is never referenced by later pictures of its own sub-layer, only by those of higher ones (H.265 3.132),
// so one in the highest sub-layer the SPS allows is never referenced at all.
import { HEVC_BASE_LAYER_ID, type HEVCNALUnit } from '../dolby-vision/DolbyVisionHEVCSplitter';
import { parseHEVCDecoderConfiguration } from './HEVCDecoderConfiguration';
import { readHEVCSPSTemporalSubLayers } from './HEVCSPSParser';

const HEVC_LAST_VCL_NAL_UNIT_TYPE = 31;
const HEVC_SPS_NAL_UNIT_TYPE = 33;
// TRAIL_N, TSA_N, STSA_N, RADL_N, RASL_N, RSV_VCL_N10, RSV_VCL_N12, and RSV_VCL_N14 (H.265 Table 7-1) are the even types through 14
const HEVC_LAST_SUB_LAYER_NON_REFERENCE_NAL_UNIT_TYPE = 14;

/**
 * Returns whether an access unit's picture is one no later picture references: every base-layer VCL NAL unit is a sub-layer non-reference
 * picture's, with the highest TemporalId.
 * An unknown highest TemporalId, or an access unit without a base-layer VCL NAL unit, never qualifies.
 */
export function isHEVCUnreferencedPicture(nalUnits: readonly HEVCNALUnit[], highestTemporalID: number | null): boolean {
    if (highestTemporalID === null) {
        return false;
    }
    let hasBaseLayerVCL = false;
    for (const nalUnit of nalUnits) {
        if (nalUnit.layerID !== HEVC_BASE_LAYER_ID || nalUnit.type > HEVC_LAST_VCL_NAL_UNIT_TYPE) {
            continue;
        }
        // An odd type, an IRAP type, or a reserved type above 14 may be referenced
        if (nalUnit.type > HEVC_LAST_SUB_LAYER_NON_REFERENCE_NAL_UNIT_TYPE || nalUnit.type % 2 !== 0 || nalUnit.temporalID !== highestTemporalID) {
            return false;
        }
        hasBaseLayerVCL = true;
    }
    return hasBaseLayerVCL;
}

/**
 * The highest temporal sub-layer of an HEVC stream's base-layer SPSs, by SPS ID: the decoder configuration's, then each in-band SPS's, which replaces
 * the one of its ID.
 * It is known only while every SPS read declares the same one; an SPS or a configuration that does not parse leaves it unknown for good.
 */
export class HEVCTemporalSubLayers {
    private readonly maximumSubLayerIndices = new Map<number, number>();
    private unreadable = false;

    /** Reads the SPSs of an hvcC decoder description; a stream without one carries its SPSs in band. */
    public constructor(decoderDescription: AllowSharedBufferSource | undefined) {
        if (decoderDescription === undefined) {
            return;
        }
        try {
            for (const sequenceParameterSet of parseHEVCDecoderConfiguration(decoderDescription).sequenceParameterSets) {
                this.readSequenceParameterSet(sequenceParameterSet);
            }
        } catch {
            this.unreadable = true;
        }
    }

    /** Reads the base-layer SPSs among an access unit's NAL units. */
    public readAccessUnit(nalUnits: readonly HEVCNALUnit[]): void {
        for (const nalUnit of nalUnits) {
            if (nalUnit.type === HEVC_SPS_NAL_UNIT_TYPE && nalUnit.layerID === HEVC_BASE_LAYER_ID) {
                this.readSequenceParameterSet(nalUnit.data);
            }
        }
    }

    /** Returns the highest TemporalId every SPS read declares, or null while it is unknown. */
    public getHighestTemporalID(): number | null {
        if (this.unreadable) {
            return null;
        }
        let highestTemporalID: number | null = null;
        for (const maximumSubLayerIndex of this.maximumSubLayerIndices.values()) {
            if (highestTemporalID !== null && highestTemporalID !== maximumSubLayerIndex) {
                return null;
            }
            highestTemporalID = maximumSubLayerIndex;
        }
        return highestTemporalID;
    }

    /** Returns whether an access unit's picture is one no later picture references, by the highest TemporalId known so far. */
    public isUnreferencedPicture(nalUnits: readonly HEVCNALUnit[]): boolean {
        return isHEVCUnreferencedPicture(nalUnits, this.getHighestTemporalID());
    }

    private readSequenceParameterSet(nalUnit: Uint8Array): void {
        try {
            const { maximumSubLayerIndex, sequenceParameterSetID } = readHEVCSPSTemporalSubLayers(nalUnit);
            this.maximumSubLayerIndices.set(sequenceParameterSetID, maximumSubLayerIndex);
        } catch {
            this.unreadable = true;
        }
    }
}
