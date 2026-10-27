import { splitAnnexBNALUnits, splitLengthPrefixedNALUnits } from '../NALUnitFraming';
import {
    rewriteHEVCSPSColorDescriptionToBT709,
    type HEVCHDRTransfer
} from '../hevc/HEVCSPSParser';

const ANNEX_B_START_CODE = new Uint8Array([ 0, 0, 0, 1 ]);
const DOLBY_VISION_RPU_NAL_UNIT_TYPE = 62;
const DOLBY_VISION_ENHANCEMENT_WRAPPER_NAL_UNIT_TYPE = 63;
const HEVC_VPS_NAL_UNIT_TYPE = 32;
const HEVC_SPS_NAL_UNIT_TYPE = 33;
const HEVC_PPS_NAL_UNIT_TYPE = 34;
const HEVC_ACCESS_UNIT_SUBJECT = 'HEVC access unit';
const MINIMUM_NAL_UNIT_BYTE_LENGTH = 2;

/** The nuh_layer_id of the base layer, the only layer a single-layer HEVC decoder consumes. */
export const HEVC_BASE_LAYER_ID = 0;

export type HEVCLengthSize = 1 | 2 | 3 | 4;
export type HEVCNALFormat =
    | { kind: 'annex-b' }
    | { kind: 'length-prefixed', lengthSize: HEVCLengthSize };

export type DolbyVisionHEVCSplitResult = {
    /**
     * The BL the decoder takes: the input itself when nothing was removed, a view of its leading bytes when only trailing NAL units were, and a new access unit otherwise.
     * Null when the input has no BL NAL unit.
     */
    baseLayerData: Uint8Array | null
    enhancementLayerData: Uint8Array | null
    hasBaseLayerVCL: boolean
    hasEnhancementLayerVCL: boolean
    hasRequiredEnhancementLayerParameterSets: boolean
    rpuNALUnits: readonly Uint8Array[]
};

export type HEVCNALUnit = {
    data: Uint8Array
    layerID: number
    type: number
};

const HEVC_RASL_N_NAL_UNIT_TYPE = 8;
const HEVC_RASL_R_NAL_UNIT_TYPE = 9;

enum ChromiumHEVCNALOrderState {
    AUDAllowed,
    BeforeFirstVCL,
    AfterFirstVCL,
    EndOfBitstreamAllowed,
    NoMoreDataAllowed
}

function requireAccessUnit(data: Uint8Array): void {
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        throw new TypeError('The HEVC access unit is empty');
    }
}

function getNALUnitType(data: Uint8Array): number {
    if (data.byteLength < MINIMUM_NAL_UNIT_BYTE_LENGTH) {
        throw new TypeError('An HEVC NAL unit is missing its two-byte header');
    }
    return (data[0] >> 1) & 0x3F;
}

/** Reads the six-bit nuh_layer_id that spans the two bytes of an HEVC NAL unit header. */
export function getHEVCNALUnitLayerID(data: Uint8Array): number {
    if (data.byteLength < MINIMUM_NAL_UNIT_BYTE_LENGTH) {
        throw new TypeError('An HEVC NAL unit is missing its two-byte header');
    }
    return ((data[0] & 0x01) << 5) | (data[1] >> 3);
}

function parseNALUnit(data: Uint8Array): HEVCNALUnit {
    return {
        data,
        layerID: getHEVCNALUnitLayerID(data),
        type: getNALUnitType(data)
    };
}

/** Parses one bounded HEVC access unit without copying its NAL payloads. */
export function parseHEVCNALUnits(data: Uint8Array, format: HEVCNALFormat): HEVCNALUnit[] {
    const nalUnits = format.kind === 'annex-b' ?
        splitAnnexBNALUnits(data, HEVC_ACCESS_UNIT_SUBJECT) :
        splitLengthPrefixedNALUnits(data, format.lengthSize, HEVC_ACCESS_UNIT_SUBJECT);
    return nalUnits.map(parseNALUnit);
}

function getPrefixByteLength(format: HEVCNALFormat): number {
    return format.kind === 'annex-b' ? ANNEX_B_START_CODE.byteLength : format.lengthSize;
}

function getMaximumNALUnitByteLength(lengthSize: HEVCLengthSize): number {
    return (256 ** lengthSize) - 1;
}

function writeNALUnitLength(
    output: Uint8Array,
    offset: number,
    lengthSize: HEVCLengthSize,
    nalUnitByteLength: number
): void {
    let remainingLength = nalUnitByteLength;
    for (let byteIndex = lengthSize - 1; byteIndex >= 0; byteIndex -= 1) {
        output[offset + byteIndex] = remainingLength % 256;
        remainingLength = Math.floor(remainingLength / 256);
    }
}

function encodeNALUnits(nalUnits: readonly Uint8Array[], format: HEVCNALFormat): Uint8Array | null {
    if (nalUnits.length === 0) {
        return null;
    }
    const prefixByteLength = getPrefixByteLength(format);
    let outputByteLength = 0;
    for (const nalUnit of nalUnits) {
        if (nalUnit.byteLength < MINIMUM_NAL_UNIT_BYTE_LENGTH) {
            throw new TypeError('An output HEVC NAL unit is missing its two-byte header');
        }
        if (format.kind === 'length-prefixed' && nalUnit.byteLength > getMaximumNALUnitByteLength(format.lengthSize)) {
            throw new TypeError('An HEVC NAL unit does not fit the output length field');
        }
        outputByteLength += prefixByteLength + nalUnit.byteLength;
        if (!Number.isSafeInteger(outputByteLength)) {
            throw new TypeError('The split HEVC access unit size is not representable');
        }
    }

    const output = new Uint8Array(outputByteLength);
    let outputOffset = 0;
    for (const nalUnit of nalUnits) {
        if (format.kind === 'annex-b') {
            output.set(ANNEX_B_START_CODE, outputOffset);
        } else {
            writeNALUnitLength(output, outputOffset, format.lengthSize, nalUnit.byteLength);
        }
        outputOffset += prefixByteLength;
        output.set(nalUnit, outputOffset);
        outputOffset += nalUnit.byteLength;
    }
    return output;
}

/**
 * Returns the BL of a split access unit without copying it when the removed NAL units allow.
 * Dolby Vision muxers put the RPU, and an interleaved EL, after the BL's NAL units, so the BL is usually the input's leading bytes.
 */
function getBaseLayerData(
    data: Uint8Array,
    inputFormat: HEVCNALFormat,
    baseLayerNALUnits: readonly Uint8Array[],
    removedNALUnitCount: number,
    leadingBaseLayerByteLength: number | null
): Uint8Array | null {
    if (baseLayerNALUnits.length === 0) {
        return null;
    }
    if (removedNALUnitCount === 0) {
        return data;
    }
    return leadingBaseLayerByteLength === null ?
        encodeNALUnits(baseLayerNALUnits, inputFormat) :
        data.subarray(0, leadingBaseLayerByteLength);
}

/**
 * Separates BL, RPU, and wrapped EL NAL units.
 * A BL that is the input itself or a view of it shares the input's bytes; RPUs are owned copies, and the EL is a new access unit.
 * NAL units with nuh_layer_id above zero, such as an MV-HEVC second view or an SHVC layer, are dropped: single-layer decoders ignore them and the base layer decodes without them.
 * A caller that already walked the access unit's NAL units passes them, so the unit is walked once.
 */
export function splitDolbyVisionHEVCAccessUnit(
    data: Uint8Array,
    inputFormat: HEVCNALFormat,
    enhancementOutputFormat: HEVCNALFormat = inputFormat,
    walkedNALUnits?: readonly HEVCNALUnit[]
): DolbyVisionHEVCSplitResult {
    requireAccessUnit(data);
    const nalUnits = walkedNALUnits ?? parseHEVCNALUnits(data, inputFormat);
    const baseLayerNALUnits: Uint8Array[] = [];
    const enhancementLayerNALUnits: Uint8Array[] = [];
    const enhancementLayerParameterSetTypes = new Set<number>();
    const rpuNALUnits: Uint8Array[] = [];
    let hasBaseLayerVCL = false;
    let hasEnhancementLayerVCL = false;
    let removedNALUnitCount = 0;
    // The input's bytes through its last BL NAL unit, or null once a removed NAL unit precedes a BL one
    let leadingBaseLayerByteLength: number | null = null;

    for (const nalUnit of nalUnits) {
        // RPU (62) and EL wrapper (63) NAL units always carry layer 0, and the wrapped EL is its own bitstream
        if (nalUnit.layerID !== HEVC_BASE_LAYER_ID) {
            removedNALUnitCount += 1;
            continue;
        }
        switch (nalUnit.type) {
            case DOLBY_VISION_RPU_NAL_UNIT_TYPE:
                removedNALUnitCount += 1;
                rpuNALUnits.push(nalUnit.data.slice());
                break;
            case DOLBY_VISION_ENHANCEMENT_WRAPPER_NAL_UNIT_TYPE: {
                removedNALUnitCount += 1;
                const enhancementLayerNALUnit = nalUnit.data.subarray(2);
                const enhancementLayerType = getNALUnitType(enhancementLayerNALUnit);
                hasEnhancementLayerVCL ||= enhancementLayerType <= 31;
                if (
                    enhancementLayerType === HEVC_VPS_NAL_UNIT_TYPE
                    || enhancementLayerType === HEVC_SPS_NAL_UNIT_TYPE
                    || enhancementLayerType === HEVC_PPS_NAL_UNIT_TYPE
                ) {
                    enhancementLayerParameterSetTypes.add(enhancementLayerType);
                }
                enhancementLayerNALUnits.push(enhancementLayerNALUnit);
                break;
            }
            default:
                hasBaseLayerVCL ||= nalUnit.type <= 31;
                baseLayerNALUnits.push(nalUnit.data);
                leadingBaseLayerByteLength = removedNALUnitCount === 0 ?
                    nalUnit.data.byteOffset + nalUnit.data.byteLength - data.byteOffset :
                    null;
                break;
        }
    }

    return {
        baseLayerData: getBaseLayerData(
            data,
            inputFormat,
            baseLayerNALUnits,
            removedNALUnitCount,
            leadingBaseLayerByteLength
        ),
        enhancementLayerData: encodeNALUnits(enhancementLayerNALUnits, enhancementOutputFormat),
        hasBaseLayerVCL,
        hasEnhancementLayerVCL,
        hasRequiredEnhancementLayerParameterSets:
            enhancementLayerParameterSetTypes.has(HEVC_VPS_NAL_UNIT_TYPE)
            && enhancementLayerParameterSetTypes.has(HEVC_SPS_NAL_UNIT_TYPE)
            && enhancementLayerParameterSetTypes.has(HEVC_PPS_NAL_UNIT_TYPE),
        rpuNALUnits
    };
}

/** Returns whether an access unit contains a random-access skipped picture. */
export function hasHEVCRASLPicture(data: Uint8Array, format: HEVCNALFormat): boolean {
    requireAccessUnit(data);
    return parseHEVCNALUnits(data, format).some((nalUnit: HEVCNALUnit): boolean => (
        nalUnit.type === HEVC_RASL_N_NAL_UNIT_TYPE || nalUnit.type === HEVC_RASL_R_NAL_UNIT_TYPE
    ));
}

function getNextChromiumNALOrderState(orderState: ChromiumHEVCNALOrderState, nalUnitType: number): ChromiumHEVCNALOrderState | null {
    switch (orderState) {
        case ChromiumHEVCNALOrderState.NoMoreDataAllowed:
            return null;
        case ChromiumHEVCNALOrderState.EndOfBitstreamAllowed:
            return nalUnitType === 37 ? ChromiumHEVCNALOrderState.NoMoreDataAllowed : null;
        default:
            return getActiveChromiumNALOrderState(orderState, nalUnitType);
    }
}

type ExactChromiumNALTransition = {
    handled: boolean
    nextState: ChromiumHEVCNALOrderState | null
};

function getExactChromiumNALTransition(orderState: ChromiumHEVCNALOrderState, nalUnitType: number): ExactChromiumNALTransition {
    switch (nalUnitType) {
        case 35:
            return {
                handled: true,
                nextState: orderState > ChromiumHEVCNALOrderState.AUDAllowed ?
                    null :
                    ChromiumHEVCNALOrderState.BeforeFirstVCL
            };
        case 36:
            return {
                handled: true,
                nextState: orderState === ChromiumHEVCNALOrderState.AfterFirstVCL ?
                    ChromiumHEVCNALOrderState.EndOfBitstreamAllowed :
                    null
            };
        case 37:
            return {
                handled: true,
                nextState: orderState >= ChromiumHEVCNALOrderState.AfterFirstVCL ?
                    ChromiumHEVCNALOrderState.NoMoreDataAllowed :
                    null
            };
        default:
            return { handled: false, nextState: orderState };
    }
}

function getActiveChromiumNALOrderState(orderState: ChromiumHEVCNALOrderState, nalUnitType: number): ChromiumHEVCNALOrderState | null {
    const exactTransition = getExactChromiumNALTransition(orderState, nalUnitType);
    if (exactTransition.handled) {
        return exactTransition.nextState;
    }

    if (nalUnitType <= 31) {
        return orderState > ChromiumHEVCNALOrderState.AfterFirstVCL ?
            null :
            ChromiumHEVCNALOrderState.AfterFirstVCL;
    }
    if (isChromiumHEVCPrefixNALUnit(nalUnitType)) {
        return orderState > ChromiumHEVCNALOrderState.BeforeFirstVCL ?
            null :
            ChromiumHEVCNALOrderState.BeforeFirstVCL;
    }
    if (isChromiumHEVCSuffixNALUnit(nalUnitType)) {
        return orderState < ChromiumHEVCNALOrderState.AfterFirstVCL ?
            null :
            orderState;
    }
    return orderState;
}

function isChromiumHEVCPrefixNALUnit(nalUnitType: number): boolean {
    switch (nalUnitType) {
        case 32:
        case 33:
        case 34:
        case 39:
            return true;
        default:
            return (nalUnitType >= 41 && nalUnitType <= 44) || (nalUnitType >= 48 && nalUnitType <= 55);
    }
}

function isChromiumHEVCSuffixNALUnit(nalUnitType: number): boolean {
    switch (nalUnitType) {
        case 38:
        case 40:
            return true;
        default:
            return (nalUnitType >= 45 && nalUnitType <= 47) || (nalUnitType >= 56 && nalUnitType <= 63);
    }
}

/** Removes only HEVC NAL ordering violations rejected by Chromium. */
export function sanitizeHEVCAccessUnitForChromium(data: Uint8Array, format: HEVCNALFormat): Uint8Array | null {
    requireAccessUnit(data);
    const nalUnits = parseHEVCNALUnits(data, format);
    const retainedNALUnits: Uint8Array[] = [];
    let orderState = ChromiumHEVCNALOrderState.AUDAllowed;
    let removedNALUnit = false;
    for (const nalUnit of nalUnits) {
        const nextOrderState = getNextChromiumNALOrderState(orderState, nalUnit.type);
        if (nextOrderState === null) {
            removedNALUnit = true;
            continue;
        }
        retainedNALUnits.push(nalUnit.data);
        orderState = nextOrderState;
    }

    if (!removedNALUnit) {
        return null;
    }
    return encodeNALUnits(retainedNALUnits, format) ?? new Uint8Array();
}

/**
 * Rewrites every in-band SPS to the neutral color descriptor used by external HDR.
 * The access unit's alternative transfer characteristics SEI value, when known, overrides each VUI transfer in the route check.
 */
export function rewriteHEVCAccessUnitColorDescriptionToBT709(
    data: Uint8Array,
    format: HEVCNALFormat,
    expectedHDRTransfer?: HEVCHDRTransfer,
    preferredTransferCharacteristics: number | null = null
): Uint8Array | null {
    requireAccessUnit(data);
    const nalUnits = parseHEVCNALUnits(data, format);
    const rewrittenNALUnits: Uint8Array[] = [];
    let rewritten = false;
    for (const nalUnit of nalUnits) {
        if (nalUnit.type !== HEVC_SPS_NAL_UNIT_TYPE) {
            rewrittenNALUnits.push(nalUnit.data);
            continue;
        }
        rewrittenNALUnits.push(rewriteHEVCSPSColorDescriptionToBT709(nalUnit.data, expectedHDRTransfer, preferredTransferCharacteristics));
        rewritten = true;
    }
    return rewritten ? encodeNALUnits(rewrittenNALUnits, format) : null;
}
