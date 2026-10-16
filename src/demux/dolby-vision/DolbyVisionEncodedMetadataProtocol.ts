import {
    MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH,
    readDolbyVisionRPUSnapshotHeader
} from './DolbyVisionRPUParser';

export const DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION = 4;
export const MAXIMUM_DOLBY_VISION_FRAME_RPU_COUNT = 16;
export const MAXIMUM_DOLBY_VISION_RPU_BYTE_LENGTH = MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH;
export const MAXIMUM_DOLBY_VISION_RPU_FRAME_BYTE_LENGTH = MAXIMUM_DOLBY_VISION_FRAME_RPU_COUNT * MAXIMUM_DOLBY_VISION_RPU_BYTE_LENGTH;

export type DolbyVisionEnhancementLayerDisposition =
    | 'absent'
    | 'decoded-fel'
    | 'decoded-mel'
    | 'discarded-fel'
    | 'discarded-mel';

export type DolbyVisionEncodedFrameMetadata = {
    enhancementLayerDisposition: DolbyVisionEnhancementLayerDisposition
    hasEnhancementLayerVCL: boolean
    parsedRPUData: readonly ArrayBuffer[]
    /** The encoded RPUs, which stay in the worker: HEVC NAL units of type 62, or AV1 ITU-T T.35 messages */
    encodedRPUs: readonly Uint8Array[]
    schemaVersion: typeof DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
};

export type TransferableDolbyVisionEncodedFrameMetadata = {
    enhancementLayerDisposition: DolbyVisionEnhancementLayerDisposition
    hasEnhancementLayerVCL: boolean
    parsedRPUData: readonly ArrayBuffer[]
    schemaVersion: typeof DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
};

/** Takes the part of the metadata that crosses postMessage with a frame; the encoded RPUs stay in the worker. */
export function takeTransferableDolbyVisionEncodedFrameMetadata(
    metadata: DolbyVisionEncodedFrameMetadata | null
): TransferableDolbyVisionEncodedFrameMetadata | null {
    if (!metadata) {
        return null;
    }

    return {
        enhancementLayerDisposition: metadata.enhancementLayerDisposition,
        hasEnhancementLayerVCL: metadata.hasEnhancementLayerVCL,
        parsedRPUData: metadata.parsedRPUData,
        schemaVersion: metadata.schemaVersion
    };
}

/** Returns every encoded metadata buffer whose ownership moves with a frame. */
export function getDolbyVisionEncodedMetadataTransferList(
    metadata: TransferableDolbyVisionEncodedFrameMetadata | null
): Transferable[] {
    if (!metadata) {
        return [];
    }

    const transferables: Transferable[] = [];
    transferables.push(...metadata.parsedRPUData);
    return transferables;
}

function isEnhancementLayerDisposition(value: unknown): value is DolbyVisionEnhancementLayerDisposition {
    switch (value) {
        case 'absent':
        case 'decoded-fel':
        case 'decoded-mel':
        case 'discarded-fel':
        case 'discarded-mel':
            return true;
        default:
            return false;
    }
}

/** Returns the layer mode an EL disposition requires of the frame's one RPU, or null when it requires none. */
function getDispositionLayerMode(disposition: DolbyVisionEnhancementLayerDisposition): 'fel' | 'mel' | null {
    switch (disposition) {
        case 'absent':
            return null;
        case 'decoded-fel':
        case 'discarded-fel':
            return 'fel';
        case 'decoded-mel':
        case 'discarded-mel':
            return 'mel';
    }
}

/** Returns which field of the metadata's shape is invalid, before its RPUs are decoded, or null. */
function getMetadataShapeFailure(metadata: Partial<TransferableDolbyVisionEncodedFrameMetadata>): string | null {
    if (metadata.schemaVersion !== DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION) {
        return `metadata-schema: ${String(metadata.schemaVersion)}, expected ${DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION}`;
    }
    if (!isEnhancementLayerDisposition(metadata.enhancementLayerDisposition)) {
        return `enhancement-layer: unknown disposition ${String(metadata.enhancementLayerDisposition)}`;
    }
    if (typeof metadata.hasEnhancementLayerVCL !== 'boolean') {
        return `enhancement-layer: VCL flag ${String(metadata.hasEnhancementLayerVCL)} is not boolean`;
    }
    if (!Array.isArray(metadata.parsedRPUData)) {
        return 'rpu-count: no RPU list';
    }
    if (metadata.parsedRPUData.length === 0 || metadata.parsedRPUData.length > MAXIMUM_DOLBY_VISION_FRAME_RPU_COUNT) {
        return `rpu-count: ${metadata.parsedRPUData.length}, expected 1 to ${MAXIMUM_DOLBY_VISION_FRAME_RPU_COUNT}`;
    }
    return metadata.enhancementLayerDisposition === 'absent' && metadata.hasEnhancementLayerVCL ?
        'enhancement-layer: absent with EL VCL' :
        null;
}

/** Returns which check encoded Dolby Vision metadata from across the worker boundary fails, as `<check>: <detail>`, or null when it is valid. */
export function getDolbyVisionEncodedFrameMetadataFailure(value: unknown): string | null {
    if (!value || typeof value !== 'object') {
        return 'metadata: missing';
    }
    const metadata = value as TransferableDolbyVisionEncodedFrameMetadata;
    const shapeFailure = getMetadataShapeFailure(metadata);
    if (shapeFailure !== null) {
        return shapeFailure;
    }

    const layerModes: string[] = [];
    for (const packedRPUData of metadata.parsedRPUData) {
        try {
            // The producing worker's parser validated each whole snapshot, so the boundary checks its header
            layerModes.push(readDolbyVisionRPUSnapshotHeader(packedRPUData).layerMode);
        } catch (error) {
            return `rpu: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    const requiredLayerMode = getDispositionLayerMode(metadata.enhancementLayerDisposition);
    if (requiredLayerMode !== null && (layerModes.length !== 1 || layerModes[0] !== requiredLayerMode)) {
        return `enhancement-layer: ${metadata.enhancementLayerDisposition} with ${layerModes.join(', ')} RPU`;
    }
    return null;
}

/** Validates encoded Dolby Vision metadata received across the worker boundary. */
export function isTransferableDolbyVisionEncodedFrameMetadata(value: unknown): value is TransferableDolbyVisionEncodedFrameMetadata {
    return getDolbyVisionEncodedFrameMetadataFailure(value) === null;
}
