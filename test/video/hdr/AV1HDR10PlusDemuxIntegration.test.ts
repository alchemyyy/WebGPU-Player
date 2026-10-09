// @vitest-environment node

import {
    ALL_FORMATS,
    BufferSource,
    EncodedPacketSink,
    Input,
    type EncodedPacket
} from 'mediabunny';
import { describe, expect, it } from 'vitest';

import {
    getAV1ITUTT35Message,
    parseAV1OBUs,
    stripAV1TrailingBits
} from 'webgpu-player/video/av1/AV1OBUParser';
import { parseAV1HDR10PlusMetadata } from 'webgpu-player/video/hdr/AV1HDR10PlusMetadata';
import {
    hasAV1PQSequenceHeader,
    parseAV1StaticHDRMetadata,
    scanAV1StaticHDRMetadata
} from 'webgpu-player/video/hdr/AV1StaticHDRMetadata';
import { isHDR10PlusITUTT35Message } from 'webgpu-player/video/hdr/HDR10PlusMetadata';

import {
    AV1_HDR10_PLUS_EXPECTATIONS,
    AV1_HDR10_PLUS_STATIC_HDR_METADATA,
    readAV1HDR10PlusVector,
    type AV1HDR10PlusVector,
    type AV1HDR10PlusVectorFrame
} from '../../helpers/av1HDR10PlusVectors';
import { toHDR10PlusMetadata } from '../../helpers/hdr10PlusVectors';

// The worker's owned AV1 path reads packets with the same options
const OWNED_AV1_PACKET_OPTIONS = {
    metadataOnly: false,
    verifyKeyPackets: true
} as const;
const MATROSKA_AV1_CODEC_ID = 'V_AV1';
const VECTORS = AV1_HDR10_PLUS_EXPECTATIONS.vectors;
const FRAMES = AV1_HDR10_PLUS_EXPECTATIONS.frames;

async function readVectorPackets(vector: AV1HDR10PlusVector): Promise<EncodedPacket[]> {
    const input = new Input({
        formats: ALL_FORMATS,
        source: new BufferSource(readAV1HDR10PlusVector(vector.fileName))
    });
    try {
        const videoTracks = await input.getVideoTracks();
        expect(videoTracks).toHaveLength(1);
        const videoTrack = videoTracks[0];
        expect(await videoTrack.getCodec()).toBe('av1');
        expect(await videoTrack.getInternalCodecId()).toBe(vector.sampleEntry ?? MATROSKA_AV1_CODEC_ID);
        expect([ await videoTrack.getCodedWidth(), await videoTrack.getCodedHeight() ]).toEqual([
            AV1_HDR10_PLUS_EXPECTATIONS.width,
            AV1_HDR10_PLUS_EXPECTATIONS.height
        ]);

        const packets: EncodedPacket[] = [];
        for await (const packet of new EncodedPacketSink(videoTrack).packets(undefined, undefined, OWNED_AV1_PACKET_OPTIONS)) {
            packets.push(packet);
        }
        return packets;
    } finally {
        input.dispose();
    }
}

/** Returns each HDR10+ message of a unit as hex, without its trailing bits. */
function readHDR10PlusMessages(temporalUnit: Uint8Array): string[] {
    const messages: string[] = [];
    for (const obu of parseAV1OBUs(temporalUnit)) {
        const message = getAV1ITUTT35Message(obu);
        if (message && isHDR10PlusITUTT35Message(message)) {
            messages.push(Buffer.from(stripAV1TrailingBits(message) ?? []).toString('hex'));
        }
    }
    return messages;
}

function requireFrameMetadata(packet: EncodedPacket, frame: AV1HDR10PlusVectorFrame): void {
    expect(packet.type === 'key').toBe(frame.keyFrame);
    expect(readHDR10PlusMessages(packet.data)).toEqual(frame.ITUTT35Message === null ? [] : [ frame.ITUTT35Message ]);
    expect(parseAV1HDR10PlusMetadata(parseAV1OBUs(packet.data))).toEqual(frame.HDR10Plus === null ? {
        metadata: null,
        status: 'absent'
    } : {
        metadata: toHDR10PlusMetadata(frame.HDR10Plus),
        status: 'valid'
    });
    expect(parseAV1StaticHDRMetadata(packet.data)).toEqual(frame.staticHDRMetadata ? AV1_HDR10_PLUS_STATIC_HDR_METADATA : null);
}

describe('HDR10+ AV1 demux integration', () => {
    it('covers profile A and profile B frames, frames without HDR10+, and both containers', () => {
        expect(VECTORS.map(vector => [ vector.container, vector.sampleEntry ])).toEqual([
            [ 'mp4', 'av01' ],
            [ 'matroska', null ]
        ]);
        expect(FRAMES).toHaveLength(AV1_HDR10_PLUS_EXPECTATIONS.frameCount);
        expect(FRAMES.map(frame => frame.HDR10Plus?.bezierCurve === null)).toEqual([ false, false, false, true, false, false ]);
        expect(FRAMES.map(frame => frame.HDR10Plus === null)).toEqual([ false, false, true, false, true, false ]);
    });

    it.each(VECTORS.map(vector => [ vector.fileName, vector ] as const))(
        'reads the HDR10+ and static HDR metadata of every temporal unit of %s',
        async (_fileName: string, vector: AV1HDR10PlusVector) => {
            const packets = await readVectorPackets(vector);

            expect(packets).toHaveLength(FRAMES.length);
            for (let frameIndex = 0; frameIndex < packets.length; frameIndex += 1) {
                requireFrameMetadata(packets[frameIndex], FRAMES[frameIndex]);
            }
            expect(hasAV1PQSequenceHeader(packets[0].data)).toBe(true);
            expect(scanAV1StaticHDRMetadata(packets.map(packet => packet.data))).toEqual({
                accessUnitCount: FRAMES.length,
                firstMetadataAccessUnitIndex: 0,
                metadata: AV1_HDR10_PLUS_STATIC_HDR_METADATA,
                status: 'valid'
            });
        }
    );
});
