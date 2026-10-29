import { PacketReader, type InputVideoTrack, type VideoCodec } from 'mediabunny';

/** The engine's codecs, FFmpeg's names, of the transport stream video tracks a GPU decoder reads. */
export type TransportStreamVideoCodec = 'mpeg1video' | 'mpeg2video' | 'vc1';

/** What a transport stream video track gives its GPU decoder: its codec private data, or the check that failed, as `code: detail`. */
export type TransportStreamVideoDescriptionResult =
    | Readonly<{ description: Uint8Array, status: 'read' }>
    | Readonly<{ failure: string, status: 'failed' }>;

// Mediabunny's codecs of MPEG-TS, M2TS, and MPEG program stream tracks, with the engine's name of each
const TRANSPORT_STREAM_VIDEO_CODECS: ReadonlyMap<VideoCodec, TransportStreamVideoCodec> = new Map<VideoCodec, TransportStreamVideoCodec>([
    [ 'mpeg1', 'mpeg1video' ],
    [ 'mpeg2', 'mpeg2video' ],
    [ 'vc1', 'vc1' ]
]);
// A 0x000001 start code prefix and its code, as the last four bytes of a search hold them
const START_CODE_MASK = 0xFFFF_FF00;
const START_CODE_PREFIX = 0x0000_0100;
const NO_START_CODE_STATE = 0xFFFF_FFFF;
const START_CODE_BYTE_LENGTH = 4;
const MPEG_SEQUENCE_HEADER_START_CODE = 0xB3;
const MPEG_EXTENSION_START_CODE = 0xB5;
const VC1_SEQUENCE_HEADER_START_CODE = 0x0F;
const VC1_ENTRY_POINT_START_CODE = 0x0E;
// A stream whose first packets hold no sequence header is cut or damaged; this bounds the search for one
const MAXIMUM_SEARCHED_PACKET_COUNT = 64;

/** Returns the engine's codec of a Mediabunny transport stream video codec, or null for any other. */
export function getTransportStreamVideoCodec(codec: VideoCodec | null): TransportStreamVideoCodec | null {
    return codec === null ? null : TRANSPORT_STREAM_VIDEO_CODECS.get(codec) ?? null;
}

/**
 * Returns how many leading bytes of a packet are its extradata, as FFmpeg's extract_extradata takes it, or 0 when it has none.
 * MPEG-1 and MPEG-2 run from the packet's start to the first start code after the sequence header that is not an extension;
 * VC-1 runs to the first start code after its sequence header and entry point that is neither of them.
 */
export function findTransportStreamExtradataByteLength(codec: TransportStreamVideoCodec, packet: Uint8Array): number {
    let state = NO_START_CODE_STATE;
    let extradataFound = false;
    for (let byteIndex = 0; byteIndex < packet.byteLength; byteIndex += 1) {
        state = ((state << 8) | packet[byteIndex]) >>> 0;
        if ((state & START_CODE_MASK) !== START_CODE_PREFIX) {
            continue;
        }
        const startCode = state & 0xFF;
        const isExtradataUnit = codec === 'vc1' ?
            startCode === VC1_SEQUENCE_HEADER_START_CODE || startCode === VC1_ENTRY_POINT_START_CODE :
            startCode === MPEG_SEQUENCE_HEADER_START_CODE || (extradataFound && startCode === MPEG_EXTENSION_START_CODE);
        if (isExtradataUnit) {
            extradataFound = true;
        } else if (extradataFound) {
            return byteIndex + 1 - START_CODE_BYTE_LENGTH;
        }
    }
    return 0;
}

/**
 * Returns the codec private data an MPEG-1, MPEG-2, or VC-1 GPU decoder receives for an MPEG-TS, M2TS, or MPEG program stream track, which has no codec
 * private data of its own:
 * the extradata of its first packet that carries a sequence header, as FFmpeg extracts it.
 * MPEG-1 and MPEG-2 take the sequence header and its extensions, and VC-1 the sequence header and entry point.
 */
export async function readTransportStreamVideoDecoderDescription(
    codec: TransportStreamVideoCodec,
    track: InputVideoTrack
): Promise<TransportStreamVideoDescriptionResult> {
    const packetReader = new PacketReader(track);
    let packet = await packetReader.getFirst();
    for (let packetIndex = 0; packet && packetIndex < MAXIMUM_SEARCHED_PACKET_COUNT; packetIndex += 1) {
        const extradataByteLength = findTransportStreamExtradataByteLength(codec, packet.data);
        if (extradataByteLength > 0) {
            return { description: packet.data.slice(0, extradataByteLength), status: 'read' };
        }
        packet = await packetReader.getNext(packet);
    }
    return { failure: `sequence-header-missing: ${codec}`, status: 'failed' };
}
