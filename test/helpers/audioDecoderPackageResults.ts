// What audio decoder packages return, and the packets the decoder projects' tests feed them.
import { ALL_FORMATS, BufferSource, Input, PacketCursor } from 'mediabunny';

import type { AudioDecoderManifest } from 'webgpu-player/decode/audio/AudioDecoderManifest';
import type { AudioDecoderPackageBlock, AudioDecoderPackageResult } from 'webgpu-player/decode/audio/AudioDecoderPackageInstance';
import type { Microseconds } from 'webgpu-player/MediaTime';
import { requireMicroseconds } from 'webgpu-player/TimeMath';

/** A demuxed packet and its container timestamp. */
export type EncodedAudioPacket = Readonly<{ data: Uint8Array, timestampMicroseconds: Microseconds }>;

/** Demuxes every packet of a vector's first audio track. */
export async function readContainerAudioPackets(vector: Uint8Array): Promise<EncodedAudioPacket[]> {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(vector) });
    const packets: EncodedAudioPacket[] = [];
    try {
        const [ track ] = await input.getAudioTracks();
        for await (const packet of new PacketCursor(track)) {
            packets.push({ data: packet.data.slice(), timestampMicroseconds: requireMicroseconds(packet.microsecondTimestamp) });
        }
    } finally {
        input.dispose();
    }
    return packets;
}

/** Returns a decoded packet's blocks, failing on a dropped one. */
export function requireDecodedBlocks(result: AudioDecoderPackageResult): readonly AudioDecoderPackageBlock[] {
    if (result.kind !== 'decoded') {
        throw new Error(`The packet decoded as ${result.kind}`);
    }
    return result.blocks;
}

/** Returns the code a manifest gives an error name. */
export function getAudioDecoderErrorCode(manifest: AudioDecoderManifest, name: string): number {
    const code = [ ...manifest.errors ].find(([ , errorName ]) => errorName === name)?.[0];
    if (code === undefined) {
        throw new Error(`The manifest of ${manifest.name} names no error ${name}`);
    }
    return code;
}

/** Returns what a call throws, failing when it does not throw. */
export function catchFailure(call: () => unknown): unknown {
    try {
        call();
    } catch (error) {
        return error;
    }
    throw new Error('The call did not fail');
}
