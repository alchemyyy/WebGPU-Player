import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MPEG4TrackCodec } from 'webgpu-player/demux/mpeg4/MPEG4TrackConfiguration';
import type { DecodeWorkerResponse } from 'webgpu-player/pipeline/DecodeWorkerProtocol';

import type { FakeWorkerScope } from './decodeWorkerHarness';
import { CODEC_VECTOR_ASSETS_DIRECTORY, DECODERS_DIRECTORY } from './enginePaths';

// The media wgpud/mpeg4's generator writes, and the DivX packed AVI vector of scripts/codec_vector_assets/generate_AVI_demux_vectors.py
const MPEG4_VECTOR_DIRECTORY = join(DECODERS_DIRECTORY, 'mpeg4', 'vectors');
const AVI_VECTOR_DIRECTORY = join(CODEC_VECTOR_ASSETS_DIRECTORY, 'avi');
const PACKED_AVI_FILE_NAME = 'mpeg4-packed-bframes-mp3.avi';
const VOP_START_CODE = Object.freeze([ 0x00, 0x00, 0x01, 0xB6 ]);
const VOP_CODING_TYPE_SHIFT = 6;
const VOP_CODING_TYPES = 'IPBS';
const RETURNED_CREDITS = 1;
const MICROSECONDS_PER_SECOND = 1_000_000;
// The generator's frame rate, and the AVI vectors'
const FRAME_RATE = 25;
const AVI_VECTOR_FRAME_RATE = 24;

/** A test stream: its codec, the FourCC its codec private data carries, its coded size and extradata, and its frames as FFmpeg outputs them. */
export type MPEG4Vector = Readonly<{
    codec: MPEG4TrackCodec
    codedHeight: number
    codedWidth: number
    /** The extradata after the BITMAPINFOHEADER: the container's VOS, VO, and VOL headers; FFmpeg's AVI muxer writes them in band only */
    extradataByteLength: number
    fileName: string
    fourCC: string
    /** The frame duration in microseconds */
    frameMicroseconds: number
    /**
     * The VOP types of the frames FFmpeg outputs, in its output order, with the frame slot of the first; null for H.263 and MS-MPEG4, whose packets
     * carry no VOP start codes and present in decode order from slot 0
     */
    presentation: Readonly<{ firstFrameSlot: number, types: string }> | null
}>;

const B_VOP_STREAM_TYPES = 'IBBPBBPBBIBBPBBI';

/** Every vector, by the FFprobe facts of each: FFmpeg's codec, its codec_tag (or the default FourCC of a track without one), size, and frame order. */
export const MPEG4_VECTORS: readonly MPEG4Vector[] = Object.freeze([
    // Xvid with global motion compensation, quarter-pel, and B-VOPs, in Matroska's own MPEG-4 track, stamped in presentation order
    {
        codec: 'mpeg4',
        codedHeight: 120,
        codedWidth: 200,
        extradataByteLength: 62,
        fileName: 'mpeg4-gmc-qpel-b.mkv',
        fourCC: 'mp4v',
        frameMicroseconds: MICROSECONDS_PER_SECOND / FRAME_RATE,
        presentation: { firstFrameSlot: 0, types: 'IBBSBBSBBSBBPBBSBBP' }
    },
    {
        codec: 'mpeg4',
        codedHeight: 144,
        codedWidth: 176,
        extradataByteLength: 31,
        fileName: 'mpeg4-b.mp4',
        fourCC: 'mp4v',
        frameMicroseconds: MICROSECONDS_PER_SECOND / FRAME_RATE,
        presentation: { firstFrameSlot: 0, types: B_VOP_STREAM_TYPES }
    },
    // AVI and Matroska VfW stamp decode order, so the first anchor presents one slot late, when the next anchor outputs it
    {
        codec: 'mpeg4',
        codedHeight: 144,
        codedWidth: 176,
        extradataByteLength: 0,
        fileName: 'mpeg4-b-xvid.avi',
        fourCC: 'XVID',
        frameMicroseconds: MICROSECONDS_PER_SECOND / FRAME_RATE,
        presentation: { firstFrameSlot: 1, types: B_VOP_STREAM_TYPES }
    },
    {
        codec: 'mpeg4',
        codedHeight: 144,
        codedWidth: 176,
        extradataByteLength: 31,
        fileName: 'mpeg4-b-vfw.mkv',
        fourCC: 'XVID',
        frameMicroseconds: MICROSECONDS_PER_SECOND / FRAME_RATE,
        presentation: { firstFrameSlot: 1, types: B_VOP_STREAM_TYPES }
    },
    // DivX 5's packed bitstream, which the fork's AVI demuxer unpacks to one VOP per packet
    {
        codec: 'mpeg4',
        codedHeight: 192,
        codedWidth: 192,
        extradataByteLength: 0,
        fileName: PACKED_AVI_FILE_NAME,
        fourCC: 'DX50',
        frameMicroseconds: MICROSECONDS_PER_SECOND / AVI_VECTOR_FRAME_RATE,
        presentation: { firstFrameSlot: 1, types: 'IBPBPBIBPBPI' }
    },
    { codec: 'msmpeg4v3', codedHeight: 144, codedWidth: 176, extradataByteLength: 0, fileName: 'msmpeg4v3.avi', fourCC: 'DIV3', frameMicroseconds: MICROSECONDS_PER_SECOND / FRAME_RATE, presentation: null },
    { codec: 'msmpeg4v3', codedHeight: 144, codedWidth: 176, extradataByteLength: 0, fileName: 'msmpeg4v3.mkv', fourCC: 'MP43', frameMicroseconds: MICROSECONDS_PER_SECOND / FRAME_RATE, presentation: null },
    { codec: 'msmpeg4v2', codedHeight: 144, codedWidth: 176, extradataByteLength: 0, fileName: 'msmpeg4v2-vfw.mkv', fourCC: 'MP42', frameMicroseconds: MICROSECONDS_PER_SECOND / FRAME_RATE, presentation: null },
    { codec: 'msmpeg4v2', codedHeight: 144, codedWidth: 176, extradataByteLength: 0, fileName: 'msmpeg4v2.avi', fourCC: 'MP42', frameMicroseconds: MICROSECONDS_PER_SECOND / FRAME_RATE, presentation: null },
    { codec: 'h263', codedHeight: 96, codedWidth: 128, extradataByteLength: 0, fileName: 'h263.3gp', fourCC: 's263', frameMicroseconds: MICROSECONDS_PER_SECOND / FRAME_RATE, presentation: null },
    { codec: 'h263', codedHeight: 96, codedWidth: 128, extradataByteLength: 0, fileName: 'h263.avi', fourCC: 'H263', frameMicroseconds: MICROSECONDS_PER_SECOND / FRAME_RATE, presentation: null },
    // FFmpeg writes H.263 to Matroska as a VfW track, here of a size H.263's source formats lack
    { codec: 'h263', codedHeight: 120, codedWidth: 200, extradataByteLength: 0, fileName: 'h263p-vfw.mkv', fourCC: 'H263', frameMicroseconds: MICROSECONDS_PER_SECOND / FRAME_RATE, presentation: null }
]);

/** Reads every vector into the files the worker harness serves. */
export function readMPEG4VectorFiles(): Map<string, Uint8Array> {
    return new Map(MPEG4_VECTORS.map((vector: MPEG4Vector): [string, Uint8Array] => {
        const directory = vector.fileName === PACKED_AVI_FILE_NAME ? AVI_VECTOR_DIRECTORY : MPEG4_VECTOR_DIRECTORY;
        return [ vector.fileName, new Uint8Array(readFileSync(join(directory, vector.fileName))) ];
    }));
}

/** Returns the coding type of a packet's first VOP, I, P, B, or S, or null without a VOP start code. */
export function readVOPType(packet: Uint8Array): string | null {
    for (let offset = 0; offset + VOP_START_CODE.length < packet.byteLength; offset += 1) {
        if (VOP_START_CODE.every((value: number, index: number): boolean => packet[offset + index] === value)) {
            return VOP_CODING_TYPES[packet[offset + VOP_START_CODE.length] >> VOP_CODING_TYPE_SHIFT];
        }
    }
    return null;
}

/** Returns each packet's credit as soon as the worker posts it, as a page that decodes at once would. */
export function returnPacketCredits(workerScope: FakeWorkerScope): void {
    const postMessage = workerScope.postMessage.bind(workerScope);
    workerScope.postMessage = (message: DecodeWorkerResponse): void => {
        postMessage(message);
        if (message.type === 'packet') {
            void Promise.resolve().then((): void => {
                workerScope.dispatchRequest({ frameCredits: RETURNED_CREDITS, generation: message.generation, type: 'pull' });
            });
        }
    };
}
