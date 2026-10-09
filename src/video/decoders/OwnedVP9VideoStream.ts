import type { EncodedPacket } from 'mediabunny';

import type { Microseconds } from '../../MediaTime';
import HDR10PlusFrameMetadataQueue from '../hdr/HDR10PlusFrameMetadataQueue';
import { parseHDR10PlusITUTT35Messages } from '../hdr/HDR10PlusMetadata';
import { hasVP9ShownFrame } from '../vp9/VP9FrameParser';
import {
    createOwnedVideoFrameMetadataSource,
    runOwnedSingleLayerVideoStream,
    type OwnedVideoDecoderCallbacks,
    type OwnedVideoDecoderPort,
    type OwnedVideoPacketIterator,
    type OwnedVideoStreamRun,
    type ProcessedOwnedVideoPacket
} from './OwnedVideoDecodeStream';

/** Reads the side data a container carries beside one packet, each entry a candidate ITU-T T.35 message. */
export type VP9PacketSideDataReader = (packet: EncodedPacket) => readonly Uint8Array[];

/**
 * Runs one attempt of the engine's own VP9 decode path, from the key packet the iterator starts at.
 * VP9 frames carry no metadata, so a frame's HDR10+ is the ITU-T T.35 message its container carries beside the packet, read in decode order.
 * Packets decode unchanged.
 * The caller owns the packet iterator.
 */
export async function runOwnedVP9VideoStream(
    stream: OwnedVideoStreamRun,
    packetIterator: OwnedVideoPacketIterator,
    readPacketSideData: VP9PacketSideDataReader,
    createDecoder: (callbacks: OwnedVideoDecoderCallbacks) => OwnedVideoDecoderPort,
    startTimeMicroseconds: Microseconds,
    keyPacketMediaTimeMicroseconds: Microseconds
): Promise<void> {
    const dynamicHDRMetadataQueue = new HDR10PlusFrameMetadataQueue('VP9');
    const processPacket = async (packet: EncodedPacket): Promise<ProcessedOwnedVideoPacket> => {
        // A packet of hidden frames alone outputs no frame to take an entry
        const hasFrame = hasVP9ShownFrame(packet.data);
        if (hasFrame) {
            dynamicHDRMetadataQueue.enqueue(packet.microsecondTimestamp, parseHDR10PlusITUTT35Messages(readPacketSideData(packet)));
        }
        return { decoderPacket: packet, hasFrame };
    };
    await runOwnedSingleLayerVideoStream(
        stream,
        packetIterator,
        createOwnedVideoFrameMetadataSource(null, dynamicHDRMetadataQueue),
        processPacket,
        createDecoder,
        startTimeMicroseconds,
        keyPacketMediaTimeMicroseconds
    );
}
