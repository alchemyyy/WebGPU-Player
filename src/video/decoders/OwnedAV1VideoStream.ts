import type { EncodedPacket } from 'mediabunny';

import type { Microseconds } from '../../MediaTime';
import { parseAV1OBUs } from '../av1/AV1OBUParser';
import {
    DolbyVisionAV1EncodedMetadataQueue,
    type DolbyVisionAV1RPUDataParser
} from '../dolby-vision/DolbyVisionEncodedMetadata';
import { parseAV1HDR10PlusMetadata } from '../hdr/AV1HDR10PlusMetadata';
import HDR10PlusFrameMetadataQueue from '../hdr/HDR10PlusFrameMetadataQueue';
import {
    createOwnedVideoFrameMetadataSource,
    runOwnedSingleLayerVideoStream,
    type OwnedVideoDecoderCallbacks,
    type OwnedVideoDecoderPort,
    type OwnedVideoPacketIterator,
    type OwnedVideoStreamRun,
    type ProcessedOwnedVideoPacket
} from './OwnedVideoDecodeStream';

/**
 * Runs one attempt of the engine's own AV1 decode path, from the key packet the iterator starts at.
 * Each temporal unit's OBUs are walked once, in decode order.
 * Its Dolby Vision RPU is stripped before decode and parsed when an RPU parser is given, and its HDR10+ metadata is parsed in place.
 * Both travel with the unit's one shown frame.
 * The caller owns the packet iterator and the RPU parser.
 */
export async function runOwnedAV1VideoStream(
    stream: OwnedVideoStreamRun,
    packetIterator: OwnedVideoPacketIterator,
    rpuParser: DolbyVisionAV1RPUDataParser | null,
    createDecoder: (callbacks: OwnedVideoDecoderCallbacks) => OwnedVideoDecoderPort,
    startTimeMicroseconds: Microseconds,
    keyPacketMediaTimeMicroseconds: Microseconds
): Promise<void> {
    const dolbyVisionMetadataQueue = new DolbyVisionAV1EncodedMetadataQueue(rpuParser);
    const dynamicHDRMetadataQueue = new HDR10PlusFrameMetadataQueue('AV1');
    const processTemporalUnit = async (packet: EncodedPacket): Promise<ProcessedOwnedVideoPacket> => {
        const obus = parseAV1OBUs(packet.data);
        const processedUnit = await dolbyVisionMetadataQueue.processTemporalUnit(packet, obus);
        if (processedUnit.hasFrame) {
            dynamicHDRMetadataQueue.enqueue(packet.microsecondTimestamp, parseAV1HDR10PlusMetadata(obus));
        }
        return processedUnit;
    };
    await runOwnedSingleLayerVideoStream(
        stream,
        packetIterator,
        createOwnedVideoFrameMetadataSource(dolbyVisionMetadataQueue, dynamicHDRMetadataQueue),
        processTemporalUnit,
        createDecoder,
        startTimeMicroseconds,
        keyPacketMediaTimeMicroseconds
    );
}
