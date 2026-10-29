import {
    repairHEVCSPSDefaultDisplayWindow,
    rewriteHEVCSPSColorDescriptionToBT709,
    type HEVCHDRTransfer
} from '../../../demux/hevc/HEVCSPSParser';
import {
    getHEVCNALUnitLayerID,
    HEVC_BASE_LAYER_ID
} from '../../../demux/dolby-vision/DolbyVisionHEVCSplitter';

const HEVC_CONFIGURATION_ARRAY_HEADER_BYTE_LENGTH = 3;
const HEVC_CONFIGURATION_HEADER_BYTE_LENGTH = 23;
const HEVC_NAL_UNIT_HEADER_BYTE_LENGTH = 2;
const HEVC_NAL_UNIT_LENGTH_BYTE_LENGTH = 2;
const HEVC_SPS_NAL_UNIT_TYPE = 33;
const MAXIMUM_HEVC_CONFIGURATION_BYTE_LENGTH = 1024 * 1024;
const MAXIMUM_HEVC_NAL_UNIT_BYTE_LENGTH = 0xFFFF;

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

function appendBytes(destination: number[], source: Uint8Array): void {
    for (const byteValue of source) {
        destination.push(byteValue);
    }
}

function readUnsigned16(data: Uint8Array, offset: number): number {
    return (data[offset] * 256) + data[offset + 1];
}

function appendUnsigned16(destination: number[], value: number): void {
    destination.push(Math.floor(value / 256), value % 256);
}

/** Rewrites one SPS NAL unit, or returns null to keep it. */
type HEVCSPSTransform = (nalUnit: Uint8Array) => Uint8Array | null;

type RewrittenHEVCDecoderDescription = {
    /** How many base-layer SPSs the record holds, each of which went through the transform */
    baseLayerSPSCount: number
    description: Uint8Array
    /** How many of them the transform replaced */
    rewrittenSPSCount: number
};

export type NeutralizedNativeHDRHEVCDecoderConfig = {
    configuration: VideoDecoderConfig
    decoderDescriptionValidated: boolean
};

/** Copies one `hvcC` NAL unit array into the output, each base-layer SPS through the transform, and returns the offset after it. */
function rewriteHEVCConfigurationNALUnitArray(
    description: Uint8Array,
    arrayOffset: number,
    outputBytes: number[],
    transformSPS: HEVCSPSTransform
): number {
    if (arrayOffset + HEVC_CONFIGURATION_ARRAY_HEADER_BYTE_LENGTH > description.byteLength) {
        throw new TypeError('The HEVC decoder description ends inside a NAL array header');
    }
    const arrayHeader = description.subarray(arrayOffset, arrayOffset + HEVC_CONFIGURATION_ARRAY_HEADER_BYTE_LENGTH);
    const declaredNALUnitType = arrayHeader[0] & 0x3F;
    const nalUnitCount = readUnsigned16(arrayHeader, 1);
    appendBytes(outputBytes, arrayHeader);
    let offset = arrayOffset + HEVC_CONFIGURATION_ARRAY_HEADER_BYTE_LENGTH;

    for (let nalUnitIndex = 0; nalUnitIndex < nalUnitCount; nalUnitIndex += 1) {
        if (offset + HEVC_NAL_UNIT_LENGTH_BYTE_LENGTH > description.byteLength) {
            throw new TypeError('The HEVC decoder description ends before a NAL unit length');
        }
        const nalUnitByteLength = readUnsigned16(description, offset);
        offset += HEVC_NAL_UNIT_LENGTH_BYTE_LENGTH;
        if (nalUnitByteLength < HEVC_NAL_UNIT_HEADER_BYTE_LENGTH || offset + nalUnitByteLength > description.byteLength) {
            throw new TypeError('The HEVC decoder description contains an invalid NAL unit');
        }
        const nalUnit = description.subarray(offset, offset + nalUnitByteLength);
        const actualNALUnitType = (nalUnit[0] >> 1) & 0x3F;
        if (actualNALUnitType !== declaredNALUnitType) {
            throw new TypeError('The HEVC decoder description NAL unit type does not match its array');
        }
        // Decoders read only base-layer parameter sets, so an alpha or other layer's SPS passes through
        const isBaseLayerSPS = actualNALUnitType === HEVC_SPS_NAL_UNIT_TYPE && getHEVCNALUnitLayerID(nalUnit) === HEVC_BASE_LAYER_ID;
        const rewrittenNALUnit = isBaseLayerSPS ? transformSPS(nalUnit) ?? nalUnit : nalUnit;
        if (rewrittenNALUnit.byteLength > MAXIMUM_HEVC_NAL_UNIT_BYTE_LENGTH) {
            throw new TypeError('The rewritten HEVC NAL unit exceeds its HVCC length field');
        }
        appendUnsigned16(outputBytes, rewrittenNALUnit.byteLength);
        appendBytes(outputBytes, rewrittenNALUnit);
        offset += nalUnitByteLength;
    }
    return offset;
}

/** Passes every base-layer SPS of an `hvcC` through a transform, and returns the rebuilt record with every other byte as it was. */
function rewriteHEVCDecoderDescriptionSPS(
    descriptionSource: AllowSharedBufferSource,
    transformSPS: HEVCSPSTransform
): RewrittenHEVCDecoderDescription {
    const description = toUint8Array(descriptionSource);
    if (
        description.byteLength < HEVC_CONFIGURATION_HEADER_BYTE_LENGTH
        || description.byteLength > MAXIMUM_HEVC_CONFIGURATION_BYTE_LENGTH
        || description[0] !== 1
    ) {
        throw new TypeError('The HEVC decoder description is not a supported HVCC record');
    }

    const outputBytes: number[] = [];
    appendBytes(outputBytes, description.subarray(0, HEVC_CONFIGURATION_HEADER_BYTE_LENGTH));
    const arrayCount = description[22];
    let offset = HEVC_CONFIGURATION_HEADER_BYTE_LENGTH;
    let baseLayerSPSCount = 0;
    let rewrittenSPSCount = 0;
    const countedTransformSPS = (nalUnit: Uint8Array): Uint8Array | null => {
        const rewrittenNALUnit = transformSPS(nalUnit);
        baseLayerSPSCount += 1;
        rewrittenSPSCount += rewrittenNALUnit === null ? 0 : 1;
        return rewrittenNALUnit;
    };
    for (let arrayIndex = 0; arrayIndex < arrayCount; arrayIndex += 1) {
        offset = rewriteHEVCConfigurationNALUnitArray(description, offset, outputBytes, countedTransformSPS);
    }
    if (offset !== description.byteLength) {
        throw new TypeError('The HEVC decoder description has trailing data');
    }
    if (outputBytes.length > MAXIMUM_HEVC_CONFIGURATION_BYTE_LENGTH) {
        throw new TypeError('The rewritten HEVC decoder description exceeds its size bound');
    }
    return {
        baseLayerSPSCount,
        description: new Uint8Array(outputBytes),
        rewrittenSPSCount
    };
}

/**
 * Returns a decoder configuration whose `hvcC` SPSs lack default_display_window_flag with the flag restored (see `repairHEVCSPSDefaultDisplayWindow`),
 * or the configuration itself when no SPS needs it.
 */
export function repairHEVCDecoderConfigDefaultDisplayWindow(configuration: VideoDecoderConfig): VideoDecoderConfig {
    if (configuration.description === undefined) {
        return configuration;
    }
    const repairedDescription = rewriteHEVCDecoderDescriptionSPS(configuration.description, repairHEVCSPSDefaultDisplayWindow);
    return repairedDescription.rewrittenSPSCount === 0 ?
        configuration :
        { ...configuration, description: repairedDescription.description };
}

/**
 * Neutralizes decoder metadata while reporting whether HVCC proved and rewrote the source SPS.
 * An SPS-free HVCC remains usable when the first key packet carries the required in-band SPS.
 * A known alternative transfer characteristics SEI value overrides the VUI transfer in the SPS check.
 * An SPS without default_display_window_flag is repaired first.
 */
export function neutralizeNativeHDRHEVCDecoderConfigWithValidation(
    configuration: VideoDecoderConfig,
    expectedHDRTransfer: HEVCHDRTransfer,
    preferredTransferCharacteristics: number | null = null
): NeutralizedNativeHDRHEVCDecoderConfig {
    const rewrittenDescription = configuration.description === undefined ?
        null :
        rewriteHEVCDecoderDescriptionSPS(configuration.description, (nalUnit: Uint8Array): Uint8Array => rewriteHEVCSPSColorDescriptionToBT709(
            repairHEVCSPSDefaultDisplayWindow(nalUnit) ?? nalUnit,
            expectedHDRTransfer,
            preferredTransferCharacteristics
        ));
    return {
        configuration: {
            ...configuration,
            colorSpace: {
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            },
            ...(rewrittenDescription === null ? {} : { description: rewrittenDescription.description })
        },
        decoderDescriptionValidated: (rewrittenDescription?.baseLayerSPSCount ?? 0) > 0
    };
}
