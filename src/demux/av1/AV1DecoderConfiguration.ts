import { PacketReader, type InputVideoTrack } from 'mediabunny';

import { createAV1CodecParameterString } from './AV1CodecParameterString';
import { AV1OBUParseError } from './AV1OBUParser';
import {
    findAV1SequenceHeader,
    type AV1SequenceHeader
} from './AV1SequenceHeaderParser';

type CachedDecoderConfigurationBacking = {
    decoderConfigPromise: Promise<VideoDecoderConfig | null> | null
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * Returns the track backing that caches the decoder configuration behind getDecoderConfig(), canDecode(), and the sample sinks, or null when its internal shape is not the vendored Mediabunny's.
 */
function getCachedDecoderConfigurationBacking(track: InputVideoTrack): CachedDecoderConfigurationBacking | null {
    const backing = (track as unknown as { _backing?: unknown })._backing;
    if (
        !isRecord(backing)
        || !Object.prototype.hasOwnProperty.call(backing, 'decoderConfigPromise')
        || typeof backing.getDecoderConfig !== 'function'
    ) {
        return null;
    }
    return backing as unknown as CachedDecoderConfigurationBacking;
}

/** Reads the sequence header of the track's first packet, or null when it has none or cannot be walked. */
async function readFirstPacketSequenceHeader(track: InputVideoTrack): Promise<AV1SequenceHeader | null> {
    const firstPacket = await new PacketReader(track).getFirst();
    if (!firstPacket) {
        return null;
    }
    try {
        return findAV1SequenceHeader(firstPacket.data);
    } catch (error) {
        if (error instanceof AV1OBUParseError) {
            return null;
        }
        throw error;
    }
}

/**
 * Replaces the codec string Mediabunny derives for an AV1 track with the one its bitstream declares, keeping every other decoder configuration field.
 * Mediabunny 1.61 reads bit depth, monochrome, and chroma format from the sequence header correctly, but when the header declares no color description it still writes the optional fields, with BT.709 code points that the stream never declared.
 * This string leaves them out instead, as the AV1 ISOBMFF binding's short form does (1.52.2 also misread the operating points and color_config).
 * Call it before the track's first getDecoderConfig() or canDecode().
 * A track whose first packet has no sequence header, or whose internal shape differs, is left untouched.
 * Returns whether the codec string was replaced.
 */
export async function assignAV1SequenceHeaderCodecString(track: InputVideoTrack): Promise<boolean> {
    if (await track.getCodec() !== 'av1') {
        return false;
    }
    const backing = getCachedDecoderConfigurationBacking(track);
    if (!backing) {
        return false;
    }
    const sequenceHeader = await readFirstPacketSequenceHeader(track);
    if (!sequenceHeader) {
        return false;
    }
    const decoderConfig = await track.getDecoderConfig();
    // The cache must now hold the configuration just returned, or the backing caches it elsewhere
    const cachedDecoderConfigPromise = backing.decoderConfigPromise;
    if (
        !decoderConfig
        || !(cachedDecoderConfigPromise instanceof Promise)
        || await cachedDecoderConfigPromise !== decoderConfig
    ) {
        return false;
    }

    const codecString = createAV1CodecParameterString(sequenceHeader);
    if (decoderConfig.codec === codecString) {
        return false;
    }
    backing.decoderConfigPromise = Promise.resolve({
        ...decoderConfig,
        codec: codecString
    });
    return true;
}
