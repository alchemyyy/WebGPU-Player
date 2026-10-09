import type { EncodedPacket } from 'mediabunny';

import type { Microseconds } from '../../MediaTime';
import {
    DolbyVisionAV1EncodedMetadataQueue,
    type DolbyVisionAV1RPUDataParser
} from '../dolby-vision/DolbyVisionEncodedMetadata';
import {
    OwnedVideoStreamState,
    pumpOwnedVideoFrames,
    type OwnedDecodedVideoSource,
    type OwnedVideoDecoderCallbacks,
    type OwnedVideoDecoderPort,
    type OwnedVideoFrameMetadata,
    type OwnedVideoFrameMetadataSource,
    type OwnedVideoPacketIterator,
    type OwnedVideoStreamRun
} from './OwnedVideoDecodeStream';

function createAV1FrameMetadataSource(metadataQueue: DolbyVisionAV1EncodedMetadataQueue): OwnedVideoFrameMetadataSource {
    return {
        clear: (): void => {
            metadataQueue.clear();
        },
        requireDrained: (): void => {
            metadataQueue.requireDrained();
        },
        takeFrameMetadata: (timestampMicroseconds: number): OwnedVideoFrameMetadata => ({
            encodedDolbyVisionMetadata: metadataQueue.takeFrameMetadata(timestampMicroseconds)
        })
    };
}

/**
 * Runs one attempt of the engine's own AV1 decode path, from the key packet the iterator starts at.
 * Each temporal unit's Dolby Vision RPU is parsed in decode order and stripped before decode.
 * The RPU travels with the unit's one shown frame.
 * The caller owns the packet iterator and the RPU parser.
 */
export async function runOwnedAV1VideoStream(
    stream: OwnedVideoStreamRun,
    packetIterator: OwnedVideoPacketIterator,
    rpuParser: DolbyVisionAV1RPUDataParser,
    createDecoder: (callbacks: OwnedVideoDecoderCallbacks) => OwnedVideoDecoderPort,
    startTimeMicroseconds: Microseconds,
    keyPacketMediaTimeMicroseconds: Microseconds
): Promise<void> {
    const metadataQueue = new DolbyVisionAV1EncodedMetadataQueue(rpuParser);
    const state = new OwnedVideoStreamState(stream, createAV1FrameMetadataSource(metadataQueue), startTimeMicroseconds, null);
    const decoder = createDecoder({
        onError: (error: unknown): void => {
            state.recordDecoderFailure(error);
            stream.notifyDecoderProgress();
        },
        onOutput: (output: OwnedDecodedVideoSource): void => {
            state.enqueueDecodedOutput(output);
        },
        onProgress: (): void => {
            stream.notifyDecoderProgress();
        }
    });
    const decodeTemporalUnit = async (packet: EncodedPacket): Promise<boolean> => {
        const processedUnit = await metadataQueue.processTemporalUnit(packet);
        state.decodeBasePacket(packet, processedUnit.decoderPacket, processedUnit.hasFrame, decoder);
        state.throwDecoderFailure();
        return true;
    };
    try {
        await decoder.init();
        stream.postStartupProgress('video-decoder-ready', 0, keyPacketMediaTimeMicroseconds);
        await pumpOwnedVideoFrames(stream, packetIterator, decoder, null, state, decodeTemporalUnit);
    } finally {
        // Close the decoder first: an output arriving later would otherwise land in the cleared queue and leak
        decoder.close();
        state.close();
    }
}
