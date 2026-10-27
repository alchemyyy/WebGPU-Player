// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VideoDecoderPackage } from 'webgpu-player/decode/packages/DecoderPackage';
import { getGPUDecoderParserModule } from 'webgpu-player/decode/video/gpu/GPUDecoderParser';
import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import {
    MAX_GPU_DECODE_PACKET_CREDITS,
    type DecodeWorkerResponse,
    type DecodeWorkerStartRequest
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';

import { createWorkerStartRequest, decodeToEnd, getReadyResponse, startDecodeWorker } from '../../../test/helpers/decodeWorkerHarness';
import { loadDecoderProjectVideoPackage } from '../../../test/helpers/decoderPackages';
import { createInProcessGPUDecoderWorkerConstructor, terminateInProcessGPUDecoderWorkers } from '../../../test/helpers/inProcessGPUDecoderWorkers';
import { createVideoTrackMatroska } from '../../../test/helpers/matroskaElements';
import { createMPEGIntraPacket, createMPEGSequenceHeaders, type MPEGSequence } from '../../../test/helpers/mpegVideoHeaders';

const PROJECT = 'mpeg2';
const MATROSKA_FILE_NAME = 'resolution-switch.mkv';
const FRAME_DURATION_MILLISECONDS = 40;
const MICROSECONDS_PER_MILLISECOND = 1_000;
const PARSE_WORKER_COUNT = 2;
// A broadcast stream that switches from standard to high definition and back, and an MPEG-1 stream that grows from CIF to VGA and back
const STANDARD_SEQUENCE: MPEGSequence = { chromaFormat: 1, height: 576, width: 720 };
const HIGH_SEQUENCE: MPEGSequence = { chromaFormat: 2, height: 1080, width: 1920 };
const CIF_SEQUENCE: MPEGSequence = { chromaFormat: null, height: 288, width: 352 };
const VGA_SEQUENCE: MPEGSequence = { chromaFormat: null, height: 480, width: 640 };
const OUTPUT_FORMATS: readonly GPUDecoderOutputFormat[] = [ 'I420', 'I422', 'I444' ];

type PacketResponse = Extract<DecodeWorkerResponse, { type: 'packet' }>;

type SwitchCase = Readonly<{
    codec: 'mpeg1video' | 'mpeg2video'
    codecID: string
    sequences: readonly MPEGSequence[]
}>;

const SWITCH_CASES: readonly SwitchCase[] = [
    { codec: 'mpeg2video', codecID: 'V_MPEG2', sequences: [ STANDARD_SEQUENCE, HIGH_SEQUENCE, STANDARD_SEQUENCE ] },
    { codec: 'mpeg1video', codecID: 'V_MPEG1', sequences: [ CIF_SEQUENCE, VGA_SEQUENCE, CIF_SEQUENCE ] }
];

/** Two packets per sequence: an I picture after the sequence's headers, then one without them. */
function createPackets(sequences: readonly MPEGSequence[]): Uint8Array[] {
    return sequences.flatMap((sequence: MPEGSequence): Uint8Array[] => [ createMPEGIntraPacket(sequence), createMPEGIntraPacket(null) ]);
}

function createMatroska(switchCase: SwitchCase, packets: readonly Uint8Array[]): Uint8Array {
    const [ first ] = switchCase.sequences;
    return createVideoTrackMatroska({
        blocks: packets.map((data: Uint8Array, packetIndex: number) => ({
            data,
            keyframe: packetIndex % 2 === 0,
            timestampMilliseconds: packetIndex * FRAME_DURATION_MILLISECONDS
        })),
        codecID: switchCase.codecID,
        codecPrivate: createMPEGSequenceHeaders(first),
        defaultDurationMilliseconds: FRAME_DURATION_MILLISECONDS,
        pixelHeight: first.height,
        pixelWidth: first.width
    });
}

function createFramePoolRoute(codec: SwitchCase['codec'], decoderPackage: VideoDecoderPackage): Partial<DecodeWorkerStartRequest> {
    return {
        frameCredits: MAX_GPU_DECODE_PACKET_CREDITS,
        gpuVideoCodec: codec,
        gpuVideoParser: {
            packageVersion: { contentHash: decoderPackage.contentHash, id: decoderPackage.id },
            parser: getGPUDecoderParserModule(decoderPackage)
        },
        rawVideoFrameFormat: 'I420',
        videoDecoderBackend: 'gpu',
        videoOutputMode: 'frame-pool'
    };
}

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    terminateInProcessGPUDecoderWorkers();
    vi.unstubAllGlobals();
});

describe('the MPEG-2 package on the decode worker\'s frame-pool route', () => {
    it.each(SWITCH_CASES)('posts each $codec packet as its picture\'s record with the size and format of its sequence, which switches up and back', async (switchCase: SwitchCase) => {
        const decoderPackage = await loadDecoderProjectVideoPackage(PROJECT);
        const packets = createPackets(switchCase.sequences);
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, createMatroska(switchCase, packets) ] ]));
        vi.stubGlobal('Worker', createInProcessGPUDecoderWorkerConstructor(PARSE_WORKER_COUNT));

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MATROSKA_FILE_NAME, createFramePoolRoute(switchCase.codec, decoderPackage)));

        const [ first ] = switchCase.sequences;
        expect(getReadyResponse(responses).maximumPictureSize).toEqual({ height: first.height, width: first.width });
        const posted = responses.filter((response: DecodeWorkerResponse): response is PacketResponse => response.type === 'packet');
        expect(posted).toHaveLength(packets.length);
        for (const [ packetIndex, packet ] of posted.entries()) {
            const sequence = switchCase.sequences[Math.floor(packetIndex / 2)];
            const size = { height: sequence.height, width: sequence.width };
            expect(new Uint8Array(packet.data)).toEqual(packets[packetIndex]);
            expect(packet).toMatchObject({
                format: OUTPUT_FORMATS[(sequence.chromaFormat ?? 1) - 1],
                maximumPictureSize: size,
                outputEvents: new Uint32Array(0),
                timestampMicroseconds: packetIndex * FRAME_DURATION_MILLISECONDS * MICROSECONDS_PER_MILLISECOND,
                visibleSize: size
            });
        }
    });
});
