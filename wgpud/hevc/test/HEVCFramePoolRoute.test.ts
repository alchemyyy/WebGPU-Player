// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
import DolbyVisionRPUParser, { type DolbyVisionRPUContainerProfile } from 'webgpu-player/demux/dolby-vision/DolbyVisionRPUParser';
import DolbyVisionRPUParserSession from 'webgpu-player/demux/dolby-vision/DolbyVisionRPUParserSession';

import {
    createWorkerStartRequest,
    decodeToEnd,
    getReadyResponse,
    spyOnRPUParserSessions,
    startDecodeWorker
} from '../../../test/helpers/decodeWorkerHarness';
import { loadDecoderProjectVideoPackage } from '../../../test/helpers/decoderPackages';
import { TEST_VECTORS_DIRECTORY, WASM_OUTPUT_DIRECTORY } from '../../../test/helpers/enginePaths';
import { createHEVCMatroska, createHEVCMatroskaWithKeyframes, type HEVCMatroskaPacketFormat } from '../../../test/helpers/hevcMatroskaVector';
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
// libdovi's RPU parser, and the RPU vectors: each file holds one RPU after a four-byte start code, without its NAL unit header
const RPU_PARSER_WASM_BYTES = new Uint8Array(readFileSync(resolve(WASM_OUTPUT_DIRECTORY, 'libdovi', 'dovi-rpu-parser.wasm')));
const RPU_VECTOR_DIRECTORY = resolve(TEST_VECTORS_DIRECTORY, 'dolby-vision-rpu');
const RPU_VECTOR_START_CODE_BYTE_LENGTH = 4;
const RPU_NAL_UNIT_HEADER = [ 0x7C, 0x01 ];
// Two RPUs of each profile, alternating packet by packet, so each frame's RPUs show which packet they came from
const DOLBY_VISION_STREAMS = [
    { profile: 5, rpuFiles: [ 'profile5.bin', 'profile5-02.bin' ] },
    { profile: 8, rpuFiles: [ 'profile8.bin', 'profile84.bin' ] }
] as const;
const DOLBY_VISION_PACKET_COUNT = 4;
const DOLBY_VISION_FILE_NAME = 'hevc-dolby-vision.mkv';

type PacketResponse = Extract<DecodeWorkerResponse, { type: 'packet' }>;

function getPacketResponses(responses: readonly DecodeWorkerResponse[]): PacketResponse[] {
    return responses.filter((response: DecodeWorkerResponse): response is PacketResponse => response.type === 'packet');
}

/** Returns an RPU vector as the NAL unit an access unit carries it in, of type 62. */
function readRPUNALUnit(fileName: string): Uint8Array {
    const vector = new Uint8Array(readFileSync(resolve(RPU_VECTOR_DIRECTORY, fileName)));
    return Uint8Array.from([ ...RPU_NAL_UNIT_HEADER, ...vector.subarray(RPU_VECTOR_START_CODE_BYTE_LENGTH) ]);
}

/** Returns an RPU parser session on libdovi's own WASM, as the worker's would load it, for a container profile. */
function createActualRPUParserSession(profile: DolbyVisionRPUContainerProfile): DolbyVisionRPUParserSession {
    return DolbyVisionRPUParserSession.create('local-parser.wasm', profile, {
        createParser: (): Promise<DolbyVisionRPUParser> => DolbyVisionRPUParser.create('local-parser.wasm', {
            loadInstance: async (): Promise<WebAssembly.Instance> => (await WebAssembly.instantiate(RPU_PARSER_WASM_BYTES, {})).instance
        })
    });
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

    it.each(DOLBY_VISION_STREAMS)(
        'carries each Profile $profile packet\'s RPU, as libdovi parses it, on the packet\'s picture',
        async ({ profile, rpuFiles }) => {
            const rpuNALUnits = Array.from({ length: DOLBY_VISION_PACKET_COUNT }, (_: unknown, packetIndex: number): Uint8Array => (
                readRPUNALUnit(rpuFiles[packetIndex % rpuFiles.length])
            ));
            const matroska = await createHEVCMatroskaWithKeyframes(
                rpuNALUnits.map((): boolean => true),
                rpuNALUnits.map((rpuNALUnit: Uint8Array): Uint8Array[] => [ rpuNALUnit ])
            );
            const createSession = await spyOnRPUParserSessions();
            createSession.mockImplementation((): DolbyVisionRPUParserSession => createActualRPUParserSession(profile));
            const parserField = getParserField(await loadDecoderProjectVideoPackage(PROJECT));
            const workerScope = await startDecodeWorker(new Map([ [ DOLBY_VISION_FILE_NAME, matroska ] ]));
            vi.stubGlobal('Worker', createInProcessGPUDecoderWorkerConstructor(PARSE_WORKER_COUNT));

            const responses = await decodeToEnd(workerScope, createWorkerStartRequest(DOLBY_VISION_FILE_NAME, {
                ...FRAME_POOL_ROUTE,
                dolbyVisionProfile: profile,
                gpuVideoParser: parserField
            }));

            const expectedSession = createActualRPUParserSession(profile);
            const expectedRPUs: ArrayBuffer[] = [];
            for (const rpuNALUnit of rpuNALUnits) {
                expectedRPUs.push(await expectedSession.parse(rpuNALUnit));
            }
            expectedSession.close();
            const packets = getPacketResponses(responses);
            expect(createSession).toHaveBeenCalledOnce();
            expect(packets).toHaveLength(DOLBY_VISION_PACKET_COUNT);
            for (const [ packetIndex, packet ] of packets.entries()) {
                expect(packet.encodedDolbyVisionMetadata).toMatchObject({ enhancementLayerDisposition: 'absent', hasEnhancementLayerVCL: false });
                expect(packet.encodedDolbyVisionMetadata?.parsedRPUData.map((rpu: ArrayBuffer) => new Uint8Array(rpu)))
                    .toEqual([ new Uint8Array(expectedRPUs[packetIndex]) ]);
            }
            // The two RPUs of the stream differ, so each packet's own RPU, not a neighbor's, rides with it
            expect(new Uint8Array(expectedRPUs[0])).not.toEqual(new Uint8Array(expectedRPUs[1]));
        }
    );
});
