// @vitest-environment node

import { QUALIFICATION_VECTORS_DIRECTORY } from '../../helpers/enginePaths';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { createHEVCExactCapabilityWorkerQualificationRequests } from 'webgpu-player/capability/vectors/HEVCExactCapabilityVectors';
import {
    HEVC_EXACT_CAPABILITY_QUALIFICATION_FRAME_COUNT,
    HEVC_EXACT_CAPABILITY_VECTORS,
    HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS,
    HEVC_EXACT_CAPABILITY_REQUEST_ID,
    type HEVCExactCapabilityVector,
    type HEVCExactCapabilityWorkerQualificationResult,
    type HEVCExactCapabilityWorkerRequest
} from 'webgpu-player/capability/exact/HEVCExactCapabilityProtocol';
import type { Microseconds } from 'webgpu-player/MediaTime';
import type {
    HEVCDecodedFrame,
    HEVCDecodedFrameHandler,
    HEVCDecoderBackend,
    HEVCDecoderModule,
    HEVCDecoderModuleOptions,
    HEVCFrameBitDepth,
    HEVCFramePlane
} from 'webgpu-player/video/decoders/HEVCDecoderBackend';

type CreateDecoderModule = (options: HEVCDecoderModuleOptions) => Promise<HEVCDecoderModule>;

const decoderModuleMockState = vi.hoisted(() => ({
    createHEVCDecoderModule: vi.fn<CreateDecoderModule>()
}));

// The runtime's default dependencies open the playback decoder's module, which the stride test replaces with fake decoders
vi.mock('webgpu-player/video/decoders/HEVCDecoderBackend', async importOriginal => ({
    ...await importOriginal<typeof import('webgpu-player/video/decoders/HEVCDecoderBackend')>(),
    createHEVCDecoderModule: decoderModuleMockState.createHEVCDecoderModule
}));

import { runHEVCExactCapabilityWorkerRequest } from 'webgpu-player/capability/exact/HEVCExactCapabilityWorkerRuntime';

const MAIN10_4K_QUALIFICATION_BITSTREAM = Uint8Array.from(readFileSync(resolve(
    QUALIFICATION_VECTORS_DIRECTORY,
    'hevc', 'main10-4k-complex.hevc'
))).buffer;
const DECODER_GLUE_URL = 'https://example.test/ffmpeg-hevc.js';
const DECODER_WASM_URL = 'https://example.test/ffmpeg-hevc.wasm';
const PRELOADED_DECODER_WASM_BYTE_LENGTH = 8;
// Compact 4:2:0 planes hold a byte per sample at 8 bits and two at 10
const MAIN_1080P_DECODED_FRAME_BYTE_LENGTH = 3_110_400;
const MAIN10_1080P_DECODED_FRAME_BYTE_LENGTH = 6_220_800;
const MAIN10_4K_DECODED_FRAME_BYTE_LENGTH = 24_883_200;
// The access units carry no timing, so the runtime sends each at its index without a duration
const QUALIFICATION_FRAME_DURATION_MICROSECONDS = 0;
// The fake decoders hold a frame back until the next access unit or the flush, as a decoder with output delay does
const HELD_FRAME_COUNT = 1;
// The 1080p vectors code 1088 rows, which their conformance window crops to 1080
const UNCROPPED_FULL_HD_CODED_HEIGHT = 1_088;
const MISMATCHED_CODED_WIDTH = 1_280;
// Samples past the end of each row, as a decoder that aligns its rows leaves them
const ROW_PADDING_SAMPLE_COUNT = 24;
// Steps of the sample pattern along columns and rows, so neighboring samples and rows differ, and its offset per plane
const PATTERN_COLUMN_STEP = 3;
const PATTERN_ROW_STEP = 7;
const LUMA_PLANE_INDEX = 0;
const CHROMA_BLUE_PLANE_INDEX = 1;
const CHROMA_RED_PLANE_INDEX = 2;
const DECODE_ERROR_MESSAGE = 'The fake decoder failed';
const MODULE_ERROR_MESSAGE = 'The fake module failed to compile';
const INVALID_REQUEST_MESSAGE = 'request is invalid';

/** What a fake decoder's frames report besides their planes and timing. */
type FakeFrameGeometry = Pick<HEVCDecodedFrame, 'bitDepth' | 'chromaHeight' | 'chromaWidth' | 'height' | 'width'>;

type FakeBackendOptions = Readonly<{
    // Thrown by each decode, as a decoder that fails on the stream
    decodeError?: Error
    // Replaces what each frame reports, as a decoder whose output departs from the vector
    frameGeometry?: Partial<FakeFrameGeometry>
    // What the flush does with the held frame: hands it over as a decoder does, loses it, or hands it over twice
    heldFrameFlush?: 'hand-over' | 'lose' | 'repeat'
    rowPaddingSampleCount?: number
}>;

type FakeBackend = Readonly<{
    backend: HEVCDecoderBackend
    decode: Mock<HEVCDecoderBackend['decode']>
    destroy: Mock<HEVCDecoderBackend['destroy']>
    flush: Mock<HEVCDecoderBackend['flush']>
}>;

type ModuleHarness = Readonly<{
    createDecoder: Mock<HEVCDecoderModule['createDecoder']>
    createDecoderModule: Mock<CreateDecoderModule>
}>;

function createRequest(): HEVCExactCapabilityWorkerRequest {
    return {
        decoderGlueURL: DECODER_GLUE_URL,
        decoderWASM: { kind: 'url', url: DECODER_WASM_URL },
        requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
        qualifications: createHEVCExactCapabilityWorkerQualificationRequests(MAIN10_4K_QUALIFICATION_BITSTREAM),
        type: 'probe'
    };
}

/** Creates a plane whose samples hold a pattern of their position, with the maximum sample in the padding after each row. */
function createPatternedPlane(
    width: number,
    height: number,
    bitDepth: HEVCFrameBitDepth,
    planeIndex: number,
    rowPaddingSampleCount: number
): HEVCFramePlane {
    const stride = width + rowPaddingSampleCount;
    const sampleCount = ((height - 1) * stride) + width;
    const samples = bitDepth === 8 ? new Uint8Array(sampleCount) : new Uint16Array(sampleCount);
    const maximumSample = (2 ** bitDepth) - 1;
    // A fingerprint that strays past the end of a row reads this instead of the pattern
    samples.fill(maximumSample);
    for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
        const rowOffset = rowIndex * stride;
        for (let columnIndex = 0; columnIndex < width; columnIndex += 1) {
            samples[rowOffset + columnIndex] = (
                (rowIndex * PATTERN_ROW_STEP) + (columnIndex * PATTERN_COLUMN_STEP) + planeIndex
            ) % maximumSample;
        }
    }
    return { samples, stride };
}

/**
 * Creates a decoder that outputs one frame of the vector's geometry per access unit, a frame behind, at the access unit's timestamp.
 * Every frame views the same planes, as frames that view the decoder's memory do.
 */
function createFakeBackend(vector: HEVCExactCapabilityVector, options: FakeBackendOptions = {}): FakeBackend {
    const definition = HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS[vector];
    const geometry: FakeFrameGeometry = {
        bitDepth: definition.bitDepth,
        chromaHeight: Math.ceil(definition.codedHeight / 2),
        chromaWidth: Math.ceil(definition.codedWidth / 2),
        height: definition.codedHeight,
        width: definition.codedWidth,
        ...options.frameGeometry
    };
    const rowPaddingSampleCount = options.rowPaddingSampleCount ?? 0;
    const planes = {
        chromaBlue: createPatternedPlane(
            geometry.chromaWidth,
            geometry.chromaHeight,
            geometry.bitDepth,
            CHROMA_BLUE_PLANE_INDEX,
            rowPaddingSampleCount
        ),
        chromaRed: createPatternedPlane(
            geometry.chromaWidth,
            geometry.chromaHeight,
            geometry.bitDepth,
            CHROMA_RED_PLANE_INDEX,
            rowPaddingSampleCount
        ),
        luma: createPatternedPlane(geometry.width, geometry.height, geometry.bitDepth, LUMA_PLANE_INDEX, rowPaddingSampleCount)
    };
    const heldFrames: HEVCDecodedFrame[] = [];
    const decode = vi.fn<HEVCDecoderBackend['decode']>((
        _data: Uint8Array,
        timestampMicroseconds: Microseconds,
        durationMicroseconds: Microseconds,
        frameHandler: HEVCDecodedFrameHandler
    ): number => {
        if (options.decodeError) {
            throw options.decodeError;
        }
        heldFrames.push({ ...geometry, durationMicroseconds, planes, timestampMicroseconds });
        let frameCount = 0;
        while (heldFrames.length > HELD_FRAME_COUNT) {
            frameHandler(heldFrames.shift() as HEVCDecodedFrame);
            frameCount += 1;
        }
        return frameCount;
    });
    const flush = vi.fn<HEVCDecoderBackend['flush']>((frameHandler: HEVCDecodedFrameHandler): number => {
        const flushedFrames = heldFrames.splice(0);
        switch (options.heldFrameFlush ?? 'hand-over') {
            case 'hand-over':
                break;
            case 'lose':
                return 0;
            case 'repeat':
                flushedFrames.push(...flushedFrames);
                break;
        }
        for (const frame of flushedFrames) {
            frameHandler(frame);
        }
        return flushedFrames.length;
    });
    const destroy = vi.fn<HEVCDecoderBackend['destroy']>();
    return {
        backend: { decode, destroy, flush },
        decode,
        destroy,
        flush
    };
}

/** Creates one well-behaved fake decoder per vector, in vector order. */
function createVectorBackends(options: FakeBackendOptions = {}): FakeBackend[] {
    return HEVC_EXACT_CAPABILITY_VECTORS.map((vector: HEVCExactCapabilityVector): FakeBackend => createFakeBackend(vector, options));
}

/** Hands out the backends in vector order, from however many modules the runtime instantiates. */
function createModuleHarness(backends: readonly FakeBackend[]): ModuleHarness {
    let decoderIndex = 0;
    const createDecoder = vi.fn<HEVCDecoderModule['createDecoder']>((): HEVCDecoderBackend => {
        const { backend } = backends[decoderIndex];
        decoderIndex += 1;
        return backend;
    });
    const createDecoderModule = vi.fn<CreateDecoderModule>(async (): Promise<HEVCDecoderModule> => ({ createDecoder }));
    return { createDecoder, createDecoderModule };
}

function getFrameVector(frame: HEVCDecodedFrame): HEVCExactCapabilityVector {
    if (frame.width === HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS['main10-4k'].codedWidth) {
        return 'main10-4k';
    }
    return frame.bitDepth === 10 ? 'main10-1080p' : 'main-1080p';
}

/** Returns a frame's pinned fingerprint, found by its vector and by its timestamp, which is its access unit's index. */
function fingerprintFrame(frame: HEVCDecodedFrame): number {
    return HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS[getFrameVector(frame)].decodedFrameFingerprints[frame.timestampMicroseconds];
}

/** Returns the result of a vector whose every frame matched, with the byte length of one frame in compact planes. */
function createVerifiedResult(
    vector: HEVCExactCapabilityVector,
    decodedByteLength: number
): HEVCExactCapabilityWorkerQualificationResult {
    const definition = HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS[vector];
    return {
        bitDepth: definition.bitDepth,
        chromaHeight: Math.ceil(definition.codedHeight / 2),
        chromaWidth: Math.ceil(definition.codedWidth / 2),
        codedHeight: definition.codedHeight,
        codedWidth: definition.codedWidth,
        decodedFrameFingerprints: definition.decodedFrameFingerprints,
        decodedFrameCount: definition.qualificationFrameCount,
        decodedByteLength,
        levelIDC: definition.levelIDC,
        profileIDC: definition.profileIDC,
        reason: 'decode-output-verified',
        supported: true,
        vector,
        totalDecodedByteLength: decodedByteLength * definition.qualificationFrameCount
    };
}

describe('runHEVCExactCapabilityWorkerRequest', () => {
    it('verifies exact dimensions, bit depth, 4:2:0 geometry, compact byte lengths, profile, and level', async () => {
        const backends = createVectorBackends();
        const harness = createModuleHarness(backends);

        const response = await runHEVCExactCapabilityWorkerRequest(createRequest(), {
            createDecoderModule: harness.createDecoderModule,
            fingerprintFrame
        });

        expect(response.results).toEqual([
            createVerifiedResult('main-1080p', MAIN_1080P_DECODED_FRAME_BYTE_LENGTH),
            createVerifiedResult('main10-1080p', MAIN10_1080P_DECODED_FRAME_BYTE_LENGTH),
            createVerifiedResult('main10-4k', MAIN10_4K_DECODED_FRAME_BYTE_LENGTH)
        ]);
        expect(harness.createDecoderModule).toHaveBeenCalledExactlyOnceWith({ wasmURL: DECODER_WASM_URL });
        // The access units carry their parameter sets in band, so no decoder gets a description
        expect(harness.createDecoder.mock.calls).toEqual(HEVC_EXACT_CAPABILITY_VECTORS.map(() => [ null ]));
        backends.forEach(({ decode, destroy, flush }: FakeBackend, vectorIndex: number): void => {
            const definition = HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS[HEVC_EXACT_CAPABILITY_VECTORS[vectorIndex]];
            // Each access unit goes in whole, in order, at its index
            expect(decode.mock.calls.map(([ data, timestampMicroseconds, durationMicroseconds ]) => (
                { byteLength: data.byteLength, durationMicroseconds, timestampMicroseconds }
            ))).toEqual(definition.qualificationAccessUnitByteLengths.map((byteLength: number, accessUnitIndex: number) => (
                { byteLength, durationMicroseconds: QUALIFICATION_FRAME_DURATION_MICROSECONDS, timestampMicroseconds: accessUnitIndex }
            )));
            // The flush hands over the frame the decoder still held after its last access unit
            expect(flush).toHaveBeenCalledOnce();
            expect(flush.mock.invocationCallOrder[0]).toBeGreaterThan(decode.mock.invocationCallOrder[decode.mock.invocationCallOrder.length - 1]);
            expect(destroy).toHaveBeenCalledOnce();
        });
        // The shared module holds one decoder at a time
        expect(backends[0].destroy.mock.invocationCallOrder[0]).toBeLessThan(harness.createDecoder.mock.invocationCallOrder[1]);
        expect(backends[1].destroy.mock.invocationCallOrder[0]).toBeLessThan(harness.createDecoder.mock.invocationCallOrder[2]);
    });

    it('instantiates the module from preloaded WASM bytes', async () => {
        const decoderWASMBinary = new ArrayBuffer(PRELOADED_DECODER_WASM_BYTE_LENGTH);
        const harness = createModuleHarness(createVectorBackends());

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

    it('fails qualifications independently on output mismatch and decode failure', async () => {
        const backends = [
            // A decoder that ignores the conformance window outputs every coded row
            createFakeBackend('main-1080p', {
                frameGeometry: {
                    chromaHeight: UNCROPPED_FULL_HD_CODED_HEIGHT / 2,
                    height: UNCROPPED_FULL_HD_CODED_HEIGHT
                }
            }),
            createFakeBackend('main10-1080p', { decodeError: new Error(DECODE_ERROR_MESSAGE) }),
            createFakeBackend('main10-4k')
        ];
        const harness = createModuleHarness(backends);

        const response = await runHEVCExactCapabilityWorkerRequest(createRequest(), {
            createDecoderModule: harness.createDecoderModule,
            fingerprintFrame
        });

        expect(response.results[0]).toMatchObject({
            codedHeight: UNCROPPED_FULL_HD_CODED_HEIGHT,
            reason: 'output-mismatch',
            supported: false,
            vector: 'main-1080p'
        });
        expect(response.results[1]).toMatchObject({
            reason: 'decode-error',
            supported: false,
            vector: 'main10-1080p'
        });
        expect(response.results[2]).toEqual(createVerifiedResult('main10-4k', MAIN10_4K_DECODED_FRAME_BYTE_LENGTH));
        for (const { destroy } of backends) {
            expect(destroy).toHaveBeenCalledOnce();
        }
        // Each failure discards the shared module, so every vector after it starts from a fresh heap
        expect(harness.createDecoderModule).toHaveBeenCalledTimes(HEVC_EXACT_CAPABILITY_VECTORS.length);
    });

    it('fails a vector whose decoder outputs fewer or more frames than it was given', async () => {
        const harness = createModuleHarness([
            createFakeBackend('main-1080p', { heldFrameFlush: 'lose' }),
            createFakeBackend('main10-1080p', { heldFrameFlush: 'repeat' }),
            createFakeBackend('main10-4k')
        ]);

        const response = await runHEVCExactCapabilityWorkerRequest(createRequest(), {
            createDecoderModule: harness.createDecoderModule,
            fingerprintFrame
        });

        expect(response.results[0]).toMatchObject({
            decodedFrameCount: HEVC_EXACT_CAPABILITY_QUALIFICATION_FRAME_COUNT - HELD_FRAME_COUNT,
            reason: 'output-mismatch',
            supported: false,
            vector: 'main-1080p'
        });
        // A frame past the vector's last is a decoder fault, not a mismatch
        expect(response.results[1]).toMatchObject({
            decodedFrameCount: null,
            reason: 'decode-error',
            supported: false,
            vector: 'main10-1080p'
        });
        expect(response.results[2]).toEqual(createVerifiedResult('main10-4k', MAIN10_4K_DECODED_FRAME_BYTE_LENGTH));
    });

    it('fingerprints the samples of each row wherever the plane starts its next row', async () => {
        // The runtime's own fingerprint reads the same samples from compact planes and from planes whose rows are padded
        decoderModuleMockState.createHEVCDecoderModule.mockImplementation(
            createModuleHarness(createVectorBackends()).createDecoderModule
        );
        const compactResponse = await runHEVCExactCapabilityWorkerRequest(createRequest());
        decoderModuleMockState.createHEVCDecoderModule.mockImplementation(
            createModuleHarness(createVectorBackends({ rowPaddingSampleCount: ROW_PADDING_SAMPLE_COUNT })).createDecoderModule
        );
        const paddedResponse = await runHEVCExactCapabilityWorkerRequest(createRequest());

        // The patterned samples are no vector's pictures, so every vector mismatches but reports what it fingerprinted
        const compactFingerprints = compactResponse.results.map(result => result.decodedFrameFingerprints);
        expect(compactResponse.results.map(result => result.reason)).toEqual(HEVC_EXACT_CAPABILITY_VECTORS.map(() => 'output-mismatch'));
        expect(compactFingerprints.map(fingerprints => fingerprints?.length)).toEqual(
            HEVC_EXACT_CAPABILITY_VECTORS.map(() => HEVC_EXACT_CAPABILITY_QUALIFICATION_FRAME_COUNT)
        );
        expect(paddedResponse.results.map(result => result.decodedFrameFingerprints)).toEqual(compactFingerprints);
    });

    it('fails every vector closed when the module cannot be instantiated', async () => {
        const createDecoderModule = vi.fn<CreateDecoderModule>(async (): Promise<HEVCDecoderModule> => {
            throw new Error(MODULE_ERROR_MESSAGE);
        });

        const response = await runHEVCExactCapabilityWorkerRequest(createRequest(), {
            createDecoderModule,
            fingerprintFrame
        });

        expect(response.results.map(result => result.reason)).toEqual(HEVC_EXACT_CAPABILITY_VECTORS.map(() => 'decode-error'));
        // A failed instantiation leaves no module behind, so each vector retries it
        expect(createDecoderModule).toHaveBeenCalledTimes(HEVC_EXACT_CAPABILITY_VECTORS.length);
    });

    it('rejects malformed requests before creating decoder memory', async () => {
        const createDecoderModule = vi.fn<CreateDecoderModule>();
        const request = createRequest();
        const malformedRequest = {
            ...request,
            qualifications: [
                { ...request.qualifications[0], codedWidth: MISMATCHED_CODED_WIDTH },
                request.qualifications[1]
            ]
        } as unknown as HEVCExactCapabilityWorkerRequest;

        await expect(runHEVCExactCapabilityWorkerRequest(malformedRequest, {
            createDecoderModule,
            fingerprintFrame
        })).rejects.toThrow(INVALID_REQUEST_MESSAGE);
        expect(createDecoderModule).not.toHaveBeenCalled();
    });
});
