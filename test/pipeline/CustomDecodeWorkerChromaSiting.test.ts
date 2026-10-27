// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VideoChromaFormat } from 'webgpu-player/demux/VideoChromaFormat';

import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../helpers/enginePaths';
import { createWorkerStartRequest, getReadyResponse, startDecodeWorker } from '../helpers/decodeWorkerHarness';

// The FFmpeg-made vectors of scripts/codec_vector_assets/generate_chroma_siting_vectors.py
const CHROMA_SITING_VECTOR_DIRECTORY = join(CODEC_VECTOR_ASSETS_DIRECTORY, 'chroma-siting');

type ChromaSitingExpectation = Readonly<{
    chromaFormat: VideoChromaFormat
    fileName: string
}>;

// Each H.264 and HEVC vector's SPS declares a location: in band only, where its container has no decoder record or its record no SPS,
// and in its hvcC for the HEVC streams outside the bounded SPS parser's progressive Main and Main 10 bounds
const CHROMA_SITING_EXPECTATIONS: readonly ChromaSitingExpectation[] = [
    { chromaFormat: { location: 'top-left', subsampling: '4:2:0' }, fileName: 'h264-top-left.ts' },
    { chromaFormat: { location: 'top', subsampling: '4:2:0' }, fileName: 'h264-top.m2ts' },
    { chromaFormat: { location: 'bottom-left', subsampling: '4:2:0' }, fileName: 'h264-bottom-left.avi' },
    { chromaFormat: { location: 'bottom', subsampling: '4:2:0' }, fileName: 'h264-bottom-avc3.mp4' },
    { chromaFormat: { location: 'center', subsampling: '4:2:0' }, fileName: 'h264-center-avc3.mkv' },
    { chromaFormat: { location: 'top-left', subsampling: '4:2:0' }, fileName: 'hevc-top-left.ts' },
    { chromaFormat: { location: 'top', subsampling: '4:2:0' }, fileName: 'hevc-top.m2ts' },
    { chromaFormat: { location: 'bottom', subsampling: '4:2:0' }, fileName: 'hevc-bottom-hev1.mp4' },
    { chromaFormat: { location: 'center', subsampling: '4:2:0' }, fileName: 'hevc-center-hev1.mkv' },
    { chromaFormat: { location: 'bottom-left', subsampling: '4:2:0' }, fileName: 'hevc-interlaced-bottom-left.mkv' },
    { chromaFormat: { location: 'top', subsampling: '4:2:0' }, fileName: 'hevc-main12-top.mp4' },
    // 4:2:2 chroma stays on its left luma column
    { chromaFormat: { location: null, subsampling: '4:2:2' }, fileName: 'hevc-422-10.mkv' }
];

const MEDIA_FILES = new Map<string, Uint8Array>(
    CHROMA_SITING_EXPECTATIONS.map(({ fileName }): [string, Uint8Array] => [
        fileName,
        new Uint8Array(readFileSync(join(CHROMA_SITING_VECTOR_DIRECTORY, fileName)))
    ])
);

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the playback worker\'s chroma siting', () => {
    // The ready response comes before the first packet is decoded, so each run stops there: the harness's decoder does not play
    // the decoder Mediabunny drives for H.264, and decoding is not what these runs check
    it.each(CHROMA_SITING_EXPECTATIONS)('names the chroma $fileName declares in its ready response', async (expectation: ChromaSitingExpectation) => {
        const workerScope = await startDecodeWorker(MEDIA_FILES);
        const request = createWorkerStartRequest(expectation.fileName);

        workerScope.dispatchRequest(request);
        const ready = await workerScope.waitForResponse(response => response.type === 'ready' || response.type === 'error');
        workerScope.dispatchRequest({ generation: request.generation, type: 'stop' });
        await workerScope.waitForStopped(request.generation);

        expect(getReadyResponse([ ready ]).chromaFormat).toEqual(expectation.chromaFormat);
    });
});
