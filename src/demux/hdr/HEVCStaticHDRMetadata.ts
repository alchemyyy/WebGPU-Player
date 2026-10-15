import type { HEVCNALFormat } from '../dolby-vision/DolbyVisionHEVCSplitter';
import { parseHEVCSEIMessages } from '../hevc/HEVCSEI';
import {
    completeStaticHDRMetadata,
    createEmptyStaticHDRMetadata,
    mergeContentLightLevels,
    mergeMasteringDisplayLuminance,
    scanStaticHDRMetadata,
    type StaticHDRMetadata,
    type StaticHDRMetadataScanResult
} from './StaticHDRMetadata';

const MASTERING_DISPLAY_COLOUR_VOLUME_PAYLOAD_TYPE = 137;
const CONTENT_LIGHT_LEVEL_INFORMATION_PAYLOAD_TYPE = 144;
const MASTERING_DISPLAY_PAYLOAD_BYTE_LENGTH = 24;
const CONTENT_LIGHT_PAYLOAD_BYTE_LENGTH = 4;
const MASTERING_LUMINANCE_SCALE = 10_000;

function readUnsigned16(data: Uint8Array, offset: number): number {
    return (data[offset] * 256) + data[offset + 1];
}

function readUnsigned32(data: Uint8Array, offset: number): number {
    return (
        (data[offset] * 0x1000000)
        + (data[offset + 1] * 0x10000)
        + (data[offset + 2] * 0x100)
        + data[offset + 3]
    );
}

function parseMasteringDisplayPayload(payload: Uint8Array, metadata: StaticHDRMetadata): void {
    if (payload.byteLength !== MASTERING_DISPLAY_PAYLOAD_BYTE_LENGTH) {
        throw new TypeError('The HEVC mastering-display SEI payload size is invalid');
    }
    mergeMasteringDisplayLuminance(
        metadata,
        readUnsigned32(payload, 16) / MASTERING_LUMINANCE_SCALE,
        readUnsigned32(payload, 20) / MASTERING_LUMINANCE_SCALE
    );
}

function parseContentLightPayload(payload: Uint8Array, metadata: StaticHDRMetadata): void {
    if (payload.byteLength !== CONTENT_LIGHT_PAYLOAD_BYTE_LENGTH) {
        throw new TypeError('The HEVC content-light SEI payload size is invalid');
    }
    mergeContentLightLevels(metadata, readUnsigned16(payload, 0), readUnsigned16(payload, 2));
}

/** Extracts bounded HDR10 static luminance metadata from one HEVC access unit. */
export function parseHEVCStaticHDRMetadata(accessUnit: Uint8Array, format: HEVCNALFormat): StaticHDRMetadata | null {
    const metadata = createEmptyStaticHDRMetadata();
    const messages = parseHEVCSEIMessages(accessUnit, format);
    for (const message of messages) {
        switch (message.payloadType) {
            case MASTERING_DISPLAY_COLOUR_VOLUME_PAYLOAD_TYPE:
                parseMasteringDisplayPayload(message.payload, metadata);
                break;
            case CONTENT_LIGHT_LEVEL_INFORMATION_PAYLOAD_TYPE:
                parseContentLightPayload(message.payload, metadata);
                break;
        }
    }
    return completeStaticHDRMetadata(metadata);
}

/** Scans a bounded startup prefix and rejects malformed or conflicting metadata. */
export function scanHEVCStaticHDRMetadata(accessUnits: readonly Uint8Array[], format: HEVCNALFormat): StaticHDRMetadataScanResult {
    return scanStaticHDRMetadata(
        accessUnits,
        (accessUnit: Uint8Array): StaticHDRMetadata | null => parseHEVCStaticHDRMetadata(accessUnit, format)
    );
}
