// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VideoDecoderPackage } from 'webgpu-player/decode/packages/DecoderPackage';
import { getGPUDecoderParserModule } from 'webgpu-player/decode/video/gpu/GPUDecoderParser';
import {
    MAX_GPU_DECODE_PACKET_CREDITS,
    type DecodeWorkerResponse,
    type DecodeWorkerStartRequest
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';

import { createWorkerStartRequest, getReadyResponse, startDecodeWorker } from '../../../test/helpers/decodeWorkerHarness';
import { loadDecoderProjectVideoPackage } from '../../../test/helpers/decoderPackages';
import { createInProcessGPUDecoderWorkerConstructor, terminateInProcessGPUDecoderWorkers } from '../../../test/helpers/inProcessGPUDecoderWorkers';
import { MPEG4_VECTORS, readMPEG4VectorFiles, returnPacketCredits, type MPEG4Vector } from '../../../test/helpers/mpeg4Vectors';

const PROJECT = 'mpeg4';
const PARSE_WORKER_COUNT = 2;
const MEDIA_FILES = readMPEG4VectorFiles();

type PacketResponse = Extract<DecodeWorkerResponse, { type: 'packet' }>;

function createFramePoolRoute(codec: MPEG4Vector['codec'], decoderPackage: VideoDecoderPackage): Partial<DecodeWorkerStartRequest> {
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
    // Mediabunny warns that it maps no codec to a VfW, s263, or V_MPEG4/MS/V3 track, which only this package decodes
    vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
});

afterEach(() => {
    terminateInProcessGPUDecoderWorkers();
    vi.unstubAllGlobals();
});

describe('the MPEG-4 package on the decode worker\'s frame-pool route', () => {
    it.each(MPEG4_VECTORS)('parses every $codec picture of $fileName from the codec private data the worker builds', async (vector: MPEG4Vector) => {
        const decoderPackage = await loadDecoderProjectVideoPackage(PROJECT);
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        returnPacketCredits(workerScope);
        vi.stubGlobal('Worker', createInProcessGPUDecoderWorkerConstructor(PARSE_WORKER_COUNT));
        const request = createWorkerStartRequest(vector.fileName, createFramePoolRoute(vector.codec, decoderPackage));

        workerScope.dispatchRequest(request);
        await workerScope.waitForStopped(request.generation);

        const responses = workerScope.responses;
        expect(responses.filter(response => response.type === 'error')).toEqual([]);
        const size = { height: vector.codedHeight, width: vector.codedWidth };
        expect(getReadyResponse(responses).maximumPictureSize).toEqual(size);
        const posted = responses.filter((response: DecodeWorkerResponse): response is PacketResponse => response.type === 'packet');
        expect(posted.length).toBeGreaterThan(0);
        for (const packet of posted) {
            // A parsed picture's record, which no failure held or restarted
            expect(packet.hold).toBeUndefined();
            expect(packet.recovery).toBeUndefined();
            expect(packet.data.byteLength).toBeGreaterThan(0);
            expect(packet).toMatchObject({ format: 'I420', maximumPictureSize: size });
        }
    });
});
