// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ALL_FORMATS,
    BufferSource,
    Input,
    PacketReader
} from 'mediabunny';
import type { VideoDecoderPackage } from 'webgpu-player/decode/packages/DecoderPackage';
import {
    MAX_GPU_DECODE_PACKET_CREDITS,
    type DecodeWorkerGPUVideoParser,
    type DecodeWorkerResponse,
    type DecodeWorkerStartRequest
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import GPUDecoderParserInstance, {
    getGPUDecoderParserModule,
    type GPUDecoderParserModule,
    type GPUDecoderParserOutput
} from 'webgpu-player/decode/video/gpu/GPUDecoderParser';

import {
    createWorkerStartRequest,
    decodeToEnd,
    getReadyResponse,
    startDecodeWorker
} from '../../../test/helpers/decodeWorkerHarness';
import { loadDecoderProjectVideoPackage } from '../../../test/helpers/decoderPackages';
import { createHEVCMatroska, type HEVCMatroskaPacketFormat } from '../../../test/helpers/hevcMatroskaVector';
import {
    createInProcessGPUDecoderWorkerConstructor,
    GPU_DECODER_COORDINATOR_WORKER_PATH,
    GPU_DECODER_PARSE_WORKER_PATH,
    InProcessGPUDecoderWorker,
    terminateInProcessGPUDecoderWorkers
} from '../../../test/helpers/inProcessGPUDecoderWorkers';

const PROJECT = 'hevc';
const MATROSKA_FILE_NAME = 'hevc-main10.mkv';
// The frame-pool route for the GPU HEVC decoder writing I420P10
const FRAME_POOL_ROUTE: Partial<DecodeWorkerStartRequest> = {
    frameCredits: MAX_GPU_DECODE_PACKET_CREDITS,
    gpuVideoCodec: 'hevc',
    rawVideoFrameFormat: 'I420P10',
    videoDecoderBackend: 'gpu',
    videoOutputMode: 'frame-pool'
};
const PACKET_FORMATS: readonly HEVCMatroskaPacketFormat[] = [ 'length-prefixed', 'annex-b' ];
// The parse workers each in-process coordinator worker starts, so a picture's units parse on more than one
const PARSE_WORKER_COUNT = 2;

type PacketResponse = Extract<DecodeWorkerResponse, { type: 'packet' }>;

function getPacketResponses(responses: readonly DecodeWorkerResponse[]): PacketResponse[] {
    return responses.filter((response: DecodeWorkerResponse): response is PacketResponse => response.type === 'packet');
}

/** The start request's parser field for a package, as the session sends it. */
function getParserField(decoderPackage: VideoDecoderPackage): DecodeWorkerGPUVideoParser {
    return {
        packageVersion: { contentHash: decoderPackage.contentHash, id: decoderPackage.id },
        parser: getGPUDecoderParserModule(decoderPackage)
    };
}

/** Decodes the vector's only packet on one parser instance, configured with the codec private data the worker reported. */
async function decodeOnlyPacket(matroska: Uint8Array, codecPrivate: ArrayBuffer | undefined, parser: GPUDecoderParserModule): Promise<GPUDecoderParserOutput> {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(matroska) });
    const track = await input.getPrimaryVideoTrack();
    const packet = track ? await new PacketReader(track).getFirst() : null;
    input.dispose();
    if (!packet) {
        throw new Error('The vector has no video packet');
    }
    const instance = await GPUDecoderParserInstance.create(parser);
    try {
        instance.configure(codecPrivate ? new Uint8Array(codecPrivate) : null);
        return instance.decode(packet.data);
    } finally {
        instance.destroy();
    }
}

function countWorkers(path: typeof GPU_DECODER_COORDINATOR_WORKER_PATH | typeof GPU_DECODER_PARSE_WORKER_PATH): number {
    return InProcessGPUDecoderWorker.instances.filter((worker: InProcessGPUDecoderWorker): boolean => worker.runs(path)).length;
}

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    terminateInProcessGPUDecoderWorkers();
    vi.unstubAllGlobals();
});

describe('the HEVC package on the decode worker\'s frame-pool route', () => {
    it.each(PACKET_FORMATS)(
        'posts the GPU record and output events of each %s picture in place of its packet, parsed on the coordinator worker\'s parse workers',
        async (packetFormat: HEVCMatroskaPacketFormat) => {
            const matroska = await createHEVCMatroska(packetFormat);
            const parserField = getParserField(await loadDecoderProjectVideoPackage(PROJECT));
            const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, matroska ] ]));
            vi.stubGlobal('Worker', createInProcessGPUDecoderWorkerConstructor(PARSE_WORKER_COUNT));

            const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MATROSKA_FILE_NAME, { ...FRAME_POOL_ROUTE, gpuVideoParser: parserField }));

            const packets = getPacketResponses(responses);
            expect(packets).toHaveLength(1);
            expect(packets[0]).toMatchObject({ keyframe: true, timestampMicroseconds: 0, videoEpoch: 0 });
            const expected = await decodeOnlyPacket(matroska, getReadyResponse(responses).codecPrivate, parserField.parser);
            expect(expected.pictures).toHaveLength(1);
            expect(new Uint8Array(packets[0].data)).toEqual(new Uint8Array(expected.pictures[0].record));
            expect(packets[0].outputEvents).toEqual(expected.pictures[0].events);
            expect(getReadyResponse(responses)).not.toHaveProperty('maximumPictureSize');
            expect(countWorkers(GPU_DECODER_COORDINATOR_WORKER_PATH)).toBe(1);
            expect(countWorkers(GPU_DECODER_PARSE_WORKER_PATH)).toBe(PARSE_WORKER_COUNT);
        }
    );
});
