import type { EncodedPacket } from 'mediabunny';

import {
    HEVC_BASE_LAYER_ID,
    parseHEVCNALUnits,
    type HEVCNALFormat,
    type HEVCNALUnit
} from '../dolby-vision/DolbyVisionHEVCSplitter';
import HDR10PlusFrameMetadataQueue from './HDR10PlusFrameMetadataQueue';
import { parseHEVCHDR10PlusMetadata } from './HDR10PlusMetadata';

/** Associates per-access-unit HDR10+ SEI metadata with reordered decoded HEVC frames. */
export default class HEVCDynamicHDRMetadataQueue extends HDR10PlusFrameMetadataQueue {
    public constructor(private readonly inputFormat: HEVCNALFormat) {
        super('HEVC');
    }

    /** Parses and queues metadata when an encoded packet contains a base-layer picture. */
    public processPacket(packet: EncodedPacket): boolean {
        // Only base-layer pictures are decoded, as the Dolby Vision splitter drops other layers
        const hasBaseLayerVCL = parseHEVCNALUnits(packet.data, this.inputFormat).some(
            (nalUnit: HEVCNALUnit): boolean => nalUnit.layerID === HEVC_BASE_LAYER_ID && nalUnit.type <= 31
        );
        if (!hasBaseLayerVCL) {
            return false;
        }
        this.enqueue(packet.microsecondTimestamp, parseHEVCHDR10PlusMetadata(packet.data, this.inputFormat));
        return true;
    }
}
