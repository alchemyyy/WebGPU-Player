// @vitest-environment node

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type Mock
} from 'vitest';

import { DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES } from 'webgpu-player/decode/packages/DecoderPackageImports';
import type { VideoDecodeFence } from 'webgpu-player/decode/video/native/VideoDecodeFence';
import {
    MAX_GPU_DECODE_PACKET_CREDITS,
    type DecodeWorkerGPUVideoParser,
    type DecodeWorkerStartRequest
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';

import {
    createWorkerStartRequest,
    decodeToEnd,
    startDecodeWorker,
    type FakeWorkerScope
} from '../helpers/decodeWorkerHarness';
import { createParserStubModuleBinary } from '../helpers/decoderPackages';
import { createHEVCMatroska } from '../helpers/hevcMatroskaVector';
import {
    createInProcessGPUDecoderWorkerConstructor,
    GPU_DECODER_COORDINATOR_WORKER_PATH,
    InProcessGPUDecoderWorker,
    terminateInProcessGPUDecoderWorkers
} from '../helpers/inProcessGPUDecoderWorkers';
import { readVP9HDR10PlusVector } from '../helpers/vp9HDR10PlusVectors';

// The decode fences the worker creates, each with its destroy observed
const fenceMocks = vi.hoisted(() => ({ destroys: [] as Mock[] }));

vi.mock('webgpu-player/decode/video/native/VideoDecodeFence', async (importOriginal) => {
    const originalModule = await importOriginal<typeof import('webgpu-player/decode/video/native/VideoDecodeFence')>();
    return {
        ...originalModule,
        createVideoDecodeFence: (gpu: GPU | undefined): VideoDecodeFence => {
            const fence = originalModule.createVideoDecodeFence(gpu);
            const destroy = vi.fn(fence.destroy);
            fenceMocks.destroys.push(destroy);
            return { ...fence, destroy };
        }
    };
});

// An HEVC track for the GPU decoder backend, and a VP9 track for the native one, which an owned decode stream with a fence decodes
const HEVC_FILE_NAME = 'hevc-main10.mkv';
const VP9_FILE_NAME = 'hdr10plus.webm';
const FRAME_POOL_ROUTE: Partial<DecodeWorkerStartRequest> = {
    frameCredits: MAX_GPU_DECODE_PACKET_CREDITS,
    gpuVideoCodec: 'hevc',
    rawVideoFrameFormat: 'I420P10',
    videoDecoderBackend: 'gpu',
    videoOutputMode: 'frame-pool'
};
const PARSE_WORKER_COUNT = 2;
const STUB_INPUT_POINTER = 4_096;
const STUB_PARSER_MEMORY_PAGES = 16;
const STUB_PACKAGE_VERSION = { contentHash: 'ef'.repeat(32), id: 'stub-parser' };
// Each picture the stub parser makes finishes to this record
const STUB_OUTPUT_POINTER = 3_072;
const STUB_RECORD = Uint8Array.of(0x52, 0x31, 0x56, 0x41, 1, 2, 3, 4);

/** A stub parser whose every picture finishes to the stub's record, which the GPU decoder's runs open on the worker's parser coordinator. */
function createStubParserField(): DecodeWorkerGPUVideoParser {
    return {
        packageVersion: STUB_PACKAGE_VERSION,
        parser: {
            errorNames: new Map(),
            errorRecoveries: new Map(),
            memory: { initialPages: STUB_PARSER_MEMORY_PAGES, maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES },
            module: new WebAssembly.Module(createParserStubModuleBinary({
                dataSegments: [ { bytes: STUB_RECORD, offset: STUB_OUTPUT_POINTER } ],
                results: { outputByteLength: STUB_RECORD.byteLength, outputPointer: STUB_OUTPUT_POINTER, reserveInput: STUB_INPUT_POINTER }
            })),
            repeatDirectiveCount: 0
        }
    };
}

function createGPURequest(generation: number): DecodeWorkerStartRequest {
    return createWorkerStartRequest(HEVC_FILE_NAME, { ...FRAME_POOL_ROUTE, generation, gpuVideoParser: createStubParserField() });
}

function createNativeRequest(generation: number): DecodeWorkerStartRequest {
    return createWorkerStartRequest(VP9_FILE_NAME, { generation });
}

function getCoordinators(): InProcessGPUDecoderWorker[] {
    return InProcessGPUDecoderWorker.instances.filter(worker => worker.runs(GPU_DECODER_COORDINATOR_WORKER_PATH));
}

async function startWorker(): Promise<FakeWorkerScope> {
    const workerScope = await startDecodeWorker(new Map([
        [ HEVC_FILE_NAME, await createHEVCMatroska('length-prefixed') ],
        [ VP9_FILE_NAME, readVP9HDR10PlusVector(VP9_FILE_NAME) ]
    ]));
    vi.stubGlobal('Worker', createInProcessGPUDecoderWorkerConstructor(PARSE_WORKER_COUNT));
    return workerScope;
}

beforeEach(() => {
    vi.resetModules();
    fenceMocks.destroys.length = 0;
});

afterEach(() => {
    terminateInProcessGPUDecoderWorkers();
    vi.unstubAllGlobals();
});

describe('CustomDecode.worker across video decoder backends', () => {
    it('ends the parser coordinator once a run on the native decoder follows, and starts another for a later GPU decoder run', async () => {
        const workerScope = await startWorker();
        await decodeToEnd(workerScope, createGPURequest(1));
        const [ coordinator ] = getCoordinators();
        expect(coordinator.terminated).toBe(false);

        // A later run on the same backend keeps it
        await decodeToEnd(workerScope, createGPURequest(2));
        expect(getCoordinators()).toEqual([ coordinator ]);
        expect(coordinator.terminated).toBe(false);

        await decodeToEnd(workerScope, createNativeRequest(3));
        expect(coordinator.terminated).toBe(true);

        await decodeToEnd(workerScope, createGPURequest(4));
        const coordinators = getCoordinators();
        expect(coordinators).toHaveLength(2);
        expect(coordinators[1].terminated).toBe(false);
        expect(workerScope.responses.map(response => response.type)).not.toContain('error');
    });

    it('destroys the native decoder\'s fence once a run on the GPU decoder follows, and creates another for a later native run', async () => {
        const workerScope = await startWorker();
        await decodeToEnd(workerScope, createNativeRequest(1));
        await decodeToEnd(workerScope, createNativeRequest(2));
        expect(fenceMocks.destroys).toHaveLength(1);
        expect(fenceMocks.destroys[0]).not.toHaveBeenCalled();

        await decodeToEnd(workerScope, createGPURequest(3));
        expect(fenceMocks.destroys[0]).toHaveBeenCalledOnce();

        await decodeToEnd(workerScope, createNativeRequest(4));
        expect(fenceMocks.destroys).toHaveLength(2);
        expect(fenceMocks.destroys[1]).not.toHaveBeenCalled();
        expect(workerScope.responses.map(response => response.type)).not.toContain('error');
    });
});
