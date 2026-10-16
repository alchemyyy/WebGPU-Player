import type { EncodedPacket, MatroskaBlockAddition } from 'mediabunny';

export type { MatroskaBlockAddition };

const NO_BLOCK_ADDITIONS: readonly MatroskaBlockAddition[] = Object.freeze([]);

/**
 * Returns a packet's Matroska or WebM BlockAdditionals, other than BlockAddID 1, the alpha channel Mediabunny exposes as its own side data, in BlockMore order.
 * The Mediabunny fork's Matroska demuxer keeps them as packet side data, every frame of a laced block taking its block's; every other demuxer, MP4 included, gives none.
 */
export function readMatroskaBlockAdditions(packet: EncodedPacket): readonly MatroskaBlockAddition[] {
    return packet.sideData.matroskaBlockAdditions ?? NO_BLOCK_ADDITIONS;
}
