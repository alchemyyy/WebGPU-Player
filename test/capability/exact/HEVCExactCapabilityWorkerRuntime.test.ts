// @vitest-environment node

import { QUALIFICATION_VECTORS_DIRECTORY } from '../../helpers/enginePaths';
import type { HEVCFrame, HEVCStreamInfo } from '@hevcjs/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { createHEVCExactCapabilityWorkerQualificationRequests } from 'webgpu-player/capability/vectors/HEVCExactCapabilityVectors';
import {
    HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS,
    HEVC_EXACT_CAPABILITY_REQUEST_ID,
    type HEVCExactCapabilityVector,
    type HEVCExactCapabilityWorkerRequest
} from 'webgpu-player/capability/exact/HEVCExactCapabilityProtocol';
import type {
    HEVCDecoderBackend,
    HEVCDecoderModule,
    HEVCDecoderModuleOptions
} from 'webgpu-player/video/decoders/HEVCDecoderBackend';
import { runHEVCExactCapabilityWorkerRequest } from 'webgpu-player/capability/exact/HEVCExactCapabilityWorkerRuntime';

const MAIN10_4K_QUALIFICATION_BITSTREAM = Uint8Array.from(readFileSync(resolve(
    QUALIFICATION_VECTORS_DIRECTORY,
    'hevc', 'main10-4k-complex.hevc'
))).buffer;

function createRequest(): HEVCExactCapabilityWorkerRequest {
    return {
        decoderGlueURL: 'https://example.test/hevc-decode.js',
        decoderWASM: { kind: 'url', url: 'https://example.test/hevc-decode.wasm' },
        requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
        qualifications: createHEVCExactCapabilityWorkerQualificationRequests(MAIN10_4K_QUALIFICATION_BITSTREAM),
        type: 'probe'
    };
}

function createFrame(vector: HEVCExactCapabilityVector, poc = 0): HEVCFrame {
    const definition = HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS[vector];
    const chromaWidth = Math.ceil(definition.codedWidth / 2);
    const chromaHeight = Math.ceil(definition.codedHeight / 2);
    return {
        bitDepth: definition.bitDepth,
        cb: new Uint16Array(chromaWidth * chromaHeight),
        chromaHeight,
        chromaWidth,
        cr: new Uint16Array(chromaWidth * chromaHeight),
        height: definition.codedHeight,
        poc,
        width: definition.codedWidth,
        y: new Uint16Array(definition.codedWidth * definition.codedHeight)
    };
}

function createStreamInfo(vector: HEVCExactCapabilityVector): HEVCStreamInfo {
    const definition = HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS[vector];
    return {
        bitDepth: definition.bitDepth,
        chromaFormat: 1,
        height: definition.codedHeight,
        level: definition.levelIDC,
        profile: definition.profileIDC,
        width: definition.codedWidth
    };
}

function createBackend(
    vector: HEVCExactCapabilityVector,
    destroy: () => void,
    options: {
        feedError?: Error
        info?: HEVCStreamInfo
    } = {}
): HEVCDecoderBackend {
    let pendingFrame = false;
    let nextPOC = 0;
    return {
        get info(): HEVCStreamInfo {
            return options.info ?? createStreamInfo(vector);
        },
        destroy,
        drain: (frameHandler): number => {
            if (!pendingFrame) {
                return 0;
            }
            pendingFrame = false;
            frameHandler(createFrame(vector, nextPOC));
            nextPOC += 1;
            return 1;
        },
        feed: (): void => {
            if (options.feedError) {
                throw options.feedError;
            }
            pendingFrame = true;
        },
        flush: (): number => 0
    };
}

type CreateDecoderModule = (options: HEVCDecoderModuleOptions) => Promise<HEVCDecoderModule>;

/** Hands out the backends in vector order, from however many modules the runtime instantiates. */
function createModuleHarness(backends: readonly HEVCDecoderBackend[]): {
    createDecoder: Mock<() => HEVCDecoderBackend>
    createDecoderModule: Mock<CreateDecoderModule>
} {
    let decoderIndex = 0;
    const createDecoder = vi.fn((): HEVCDecoderBackend => {
        const backend = backends[decoderIndex];
        decoderIndex += 1;
        return backend;
    });
    const createDecoderModule = vi.fn<CreateDecoderModule>(async (): Promise<HEVCDecoderModule> => ({ createDecoder }));
    return { createDecoder, createDecoderModule };
}

function fingerprintFrame(frame: HEVCFrame): number {
    if (frame.width === 3_840) {
        return HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS['main10-4k'].decodedFrameFingerprints[frame.poc];
    }
    const vector = frame.bitDepth === 10 ? 'main10-1080p' : 'main-1080p';
    return HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS[vector].decodedFrameFingerprints[frame.poc];
}

describe('runHEVCExactCapabilityWorkerRequest', () => {
    it('verifies exact dimensions, bit depth, 4:2:0 geometry, profile, and level', async () => {
        const mainDestroy = vi.fn();
        const main10FullHDDestroy = vi.fn();
        const main10Destroy = vi.fn();
        const harness = createModuleHarness([
            createBackend('main-1080p', mainDestroy),
            createBackend('main10-1080p', main10FullHDDestroy),
            createBackend('main10-4k', main10Destroy)
        ]);

        const response = await runHEVCExactCapabilityWorkerRequest(createRequest(), {
            createDecoderModule: harness.createDecoderModule,
            fingerprintFrame
        });

        expect(response.results).toMatchObject([
            {
                bitDepth: 8,
                chromaHeight: 540,
                chromaWidth: 960,
                codedHeight: 1_080,
                codedWidth: 1_920,
                decodedFrameFingerprints: HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS['main-1080p'].decodedFrameFingerprints,
                decodedFrameCount: 8,
                decodedByteLength: 6_220_800,
                levelIDC: 120,
                profileIDC: 1,
                reason: 'decode-output-verified',
                supported: true,
                vector: 'main-1080p',
                totalDecodedByteLength: 49_766_400
            },
            {
                bitDepth: 10,
                chromaHeight: 540,
                chromaWidth: 960,
                codedHeight: 1_080,
                codedWidth: 1_920,
                decodedFrameFingerprints: HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS['main10-1080p'].decodedFrameFingerprints,
                decodedFrameCount: 8,
                decodedByteLength: 6_220_800,
                levelIDC: 120,
                profileIDC: 2,
                reason: 'decode-output-verified',
                supported: true,
                vector: 'main10-1080p',
                totalDecodedByteLength: 49_766_400
            },
            {
                bitDepth: 10,
                chromaHeight: 1_080,
                chromaWidth: 1_920,
                codedHeight: 2_160,
                codedWidth: 3_840,
                decodedFrameFingerprints: HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS['main10-4k'].decodedFrameFingerprints,
                decodedFrameCount: 8,
                decodedByteLength: 24_883_200,
                levelIDC: 153,
                profileIDC: 2,
                reason: 'decode-output-verified',
                supported: true,
                vector: 'main10-4k',
                totalDecodedByteLength: 199_065_600
            }
        ]);
        expect(harness.createDecoderModule).toHaveBeenCalledOnce();
        expect(harness.createDecoderModule).toHaveBeenCalledWith({
            wasmURL: 'https://example.test/hevc-decode.wasm'
        });
        expect(harness.createDecoder).toHaveBeenCalledTimes(3);
        expect(mainDestroy).toHaveBeenCalledOnce();
        expect(main10FullHDDestroy).toHaveBeenCalledOnce();
        expect(main10Destroy).toHaveBeenCalledOnce();
        // The shared module holds one decoder at a time
        expect(mainDestroy.mock.invocationCallOrder[0]).toBeLessThan(harness.createDecoder.mock.invocationCallOrder[1]);
        expect(main10FullHDDestroy.mock.invocationCallOrder[0]).toBeLessThan(harness.createDecoder.mock.invocationCallOrder[2]);
    });

    it('instantiates the module from preloaded WASM bytes', async () => {
        const decoderWASMBinary = new ArrayBuffer(8);
        const harness = createModuleHarness([
            createBackend('main-1080p', () => undefined),
            createBackend('main10-1080p', () => undefined),
            createBackend('main10-4k', () => undefined)
        ]);

        const response = await runHEVCExactCapabilityWorkerRequest({
            ...createRequest(),
            decoderWASM: { bytes: decoderWASMBinary, kind: 'bytes' }
        }, {
            createDecoderModule: harness.createDecoderModule,
            fingerprintFrame
        });

        expect(response.results.every(result => result.supported)).toBe(true);
        expect(harness.createDecoderModule).toHaveBeenCalledOnce();
        expect(harness.createDecoderModule.mock.calls[0][0].wasmBinary).toBe(decoderWASMBinary);
    });

    it('fails qualifications independently on metadata mismatch and decode failure', async () => {
        const mainDestroy = vi.fn();
        const main10Destroy = vi.fn();
        const invalidMainInfo = {
            ...createStreamInfo('main-1080p'),
            level: 119
        };
        const harness = createModuleHarness([
            createBackend('main-1080p', mainDestroy, { info: invalidMainInfo }),
            createBackend('main10-1080p', () => undefined, {
                feedError: new Error('decode failed')
            }),
            createBackend('main10-4k', main10Destroy)
        ]);

        const response = await runHEVCExactCapabilityWorkerRequest(createRequest(), {
            createDecoderModule: harness.createDecoderModule,
            fingerprintFrame
        });

        expect(response.results[0]).toMatchObject({
            reason: 'output-mismatch',
            supported: false,
            vector: 'main-1080p'
        });
        expect(response.results[1]).toMatchObject({
            reason: 'decode-error',
            supported: false,
            vector: 'main10-1080p'
        });
        expect(response.results[2]).toMatchObject({
            reason: 'decode-output-verified',
            supported: true,
            vector: 'main10-4k'
        });
        expect(mainDestroy).toHaveBeenCalledOnce();
        expect(main10Destroy).toHaveBeenCalledOnce();
        // Each failure discards the shared module, so every vector after it starts from a fresh heap
        expect(harness.createDecoderModule).toHaveBeenCalledTimes(3);
    });

    it('fails every vector closed when the module cannot be instantiated', async () => {
        const createDecoderModule = vi.fn<CreateDecoderModule>(async (): Promise<HEVCDecoderModule> => {
            throw new Error('compile failed');
        });

        const response = await runHEVCExactCapabilityWorkerRequest(createRequest(), {
            createDecoderModule,
            fingerprintFrame
        });

        expect(response.results.map(result => result.reason)).toEqual([
            'decode-error',
            'decode-error',
            'decode-error'
        ]);
        // A failed instantiation leaves no module behind, so each vector retries it
        expect(createDecoderModule).toHaveBeenCalledTimes(3);
    });

    it('rejects malformed requests before creating decoder memory', async () => {
        const createDecoderModule = vi.fn();
        const request = createRequest();
        const malformedRequest = {
            ...request,
            qualifications: [
                { ...request.qualifications[0], codedWidth: 1_280 },
                request.qualifications[1]
            ]
        } as unknown as HEVCExactCapabilityWorkerRequest;

        await expect(runHEVCExactCapabilityWorkerRequest(malformedRequest, {
            createDecoderModule,
            fingerprintFrame
        })).rejects.toThrow('request is invalid');
        expect(createDecoderModule).not.toHaveBeenCalled();
    });
});
