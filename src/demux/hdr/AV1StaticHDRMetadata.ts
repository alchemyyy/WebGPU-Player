import {
    AV1_METADATA_TYPE_HDR_CLL,
    AV1_METADATA_TYPE_HDR_MDCV,
    AV1OBUParseError,
    getAV1Metadata,
    parseAV1OBUs,
    stripAV1TrailingBits,
    type AV1Metadata
} from '../av1/AV1OBUParser';
import { findAV1SequenceHeader } from '../av1/AV1SequenceHeaderParser';
import {
    completeStaticHDRMetadata,
    createEmptyStaticHDRMetadata,
    mergeContentLightLevels,
    mergeMasteringDisplayLuminance,
    scanStaticHDRMetadata,
    type StaticHDRMetadata,
    type StaticHDRMetadataScanResult
} from './StaticHDRMetadata';

// metadata_hdr_cll() and metadata_hdr_mdcv() from the AV1 specification, sections 5.8.3 and 5.8.4, and their semantics, section 6.7
const CONTENT_LIGHT_LEVEL_BYTE_LENGTH = 4;
const MAXIMUM_FRAME_AVERAGE_LIGHT_LEVEL_OFFSET = 2;
const MASTERING_DISPLAY_BYTE_LENGTH = 24;
const MAXIMUM_LUMINANCE_OFFSET = 16;
const MINIMUM_LUMINANCE_OFFSET = 20;
// luminance_max is 24.8 and luminance_min 18.14 fixed point, in candelas per square meter
const MAXIMUM_LUMINANCE_SCALE = 2 ** 8;
const MINIMUM_LUMINANCE_SCALE = 2 ** 14;
// transfer_characteristics 16, SMPTE ST 2084
const PQ_TRANSFER_CHARACTERISTICS = 16;

/** Walks the metadata OBUs of a temporal unit; a unit that cannot be walked is malformed. */
function readMetadataOBUs(temporalUnit: Uint8Array): AV1Metadata[] {
    const metadataOBUs: AV1Metadata[] = [];
    try {
        for (const obu of parseAV1OBUs(temporalUnit)) {
            const metadata = getAV1Metadata(obu);
            if (metadata) {
                metadataOBUs.push(metadata);
            }
        }
    } catch (error) {
        if (error instanceof AV1OBUParseError) {
            throw new TypeError(error.message);
        }
        throw error;
    }
    return metadataOBUs;
}

/** Reads the fields of a metadata body, which without its trailing bits must be exactly the size its syntax codes. */
function readMetadataFields(metadata: AV1Metadata, byteLength: number, metadataName: string): DataView {
    const fields = stripAV1TrailingBits(metadata.body);
    if (!fields || fields.byteLength !== byteLength) {
        throw new TypeError(`The AV1 ${metadataName} metadata is malformed`);
    }
    return new DataView(fields.buffer, fields.byteOffset, fields.byteLength);
}

/** Extracts the HDR10 static luminance metadata of one AV1 temporal unit from its MDCV and CLL metadata OBUs. */
export function parseAV1StaticHDRMetadata(temporalUnit: Uint8Array): StaticHDRMetadata | null {
    const staticHDRMetadata = createEmptyStaticHDRMetadata();
    for (const metadata of readMetadataOBUs(temporalUnit)) {
        switch (metadata.metadataType) {
            case AV1_METADATA_TYPE_HDR_CLL: {
                const fields = readMetadataFields(metadata, CONTENT_LIGHT_LEVEL_BYTE_LENGTH, 'content light level');
                mergeContentLightLevels(staticHDRMetadata, fields.getUint16(0), fields.getUint16(MAXIMUM_FRAME_AVERAGE_LIGHT_LEVEL_OFFSET));
                break;
            }
            case AV1_METADATA_TYPE_HDR_MDCV: {
                const fields = readMetadataFields(metadata, MASTERING_DISPLAY_BYTE_LENGTH, 'mastering display');
                mergeMasteringDisplayLuminance(
                    staticHDRMetadata,
                    fields.getUint32(MAXIMUM_LUMINANCE_OFFSET) / MAXIMUM_LUMINANCE_SCALE,
                    fields.getUint32(MINIMUM_LUMINANCE_OFFSET) / MINIMUM_LUMINANCE_SCALE
                );
                break;
            }
        }
    }
    return completeStaticHDRMetadata(staticHDRMetadata);
}

/** Scans a bounded startup prefix of AV1 temporal units and rejects malformed or conflicting metadata. */
export function scanAV1StaticHDRMetadata(temporalUnits: readonly Uint8Array[]): StaticHDRMetadataScanResult {
    return scanStaticHDRMetadata(temporalUnits, parseAV1StaticHDRMetadata);
}

/**
 * Returns whether the sequence header of a temporal unit signals PQ, the one transfer whose presentation applies static HDR metadata.
 * A unit without a sequence header, or one that cannot be walked, signals none.
 */
export function hasAV1PQSequenceHeader(temporalUnit: Uint8Array): boolean {
    try {
        return findAV1SequenceHeader(temporalUnit)?.colorConfig.transferCharacteristics === PQ_TRANSFER_CHARACTERISTICS;
    } catch (error) {
        if (error instanceof AV1OBUParseError) {
            return false;
        }
        throw error;
    }
}
