// @vitest-environment node

import { QUALIFICATION_VECTORS_DIRECTORY } from '../../helpers/enginePaths';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHEVCExactCapabilityWorkerQualificationRequests } from 'webgpu-player/capability/vectors/HEVCExactCapabilityVectors';
import {
    getHEVCExactCapabilityDecodedFrameByteLength,
    HEVC_EXACT_CAPABILITY_REQUEST_ID,
    HEVC_EXACT_CAPABILITY_VECTORS,
    HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS,
    isHEVCExactCapabilityWorkerRequest,
    isHEVCExactCapabilityWorkerResponse,
    type HEVCExactCapabilityVector,
    type HEVCExactCapabilityWorkerQualificationResult,
    type HEVCExactCapabilityWorkerRequest,
    type HEVCExactCapabilityWorkerResponse
} from 'webgpu-player/capability/exact/HEVCExactCapabilityProtocol';

const MAIN10_4K_QUALIFICATION_PATH = resolve(QUALIFICATION_VECTORS_DIRECTORY, 'hevc', 'main10-4k-complex.hevc');
const DECODER_GLUE_URL = 'https://example.test/ffmpeg-hevc.js';
const DECODER_WASM_URL = 'https://example.test/ffmpeg-hevc.wasm';
const FILE_DECODER_WASM_URL = 'file:///ffmpeg-hevc.wasm';
const PRELOADED_DECODER_WASM_BYTE_LENGTH = 8;
const TRUNCATED_ACCESS_UNIT_BYTE_LENGTH = 1;
const MISMATCHED_CODED_WIDTH = 1_280;
// Compact 4:2:0 planes hold a byte per sample at 8 bits and two at 10
const MAIN_1080P_DECODED_FRAME_BYTE_LENGTH = 3_110_400;
const MAIN10_1080P_DECODED_FRAME_BYTE_LENGTH = 6_220_800;
const MAIN10_4K_DECODED_FRAME_BYTE_LENGTH = 24_883_200;

function loadMain10UltraHDQualificationBitstream(): ArrayBuffer {
    return Uint8Array.from(readFileSync(MAIN10_4K_QUALIFICATION_PATH)).buffer;
}

function createRequest(): HEVCExactCapabilityWorkerRequest {
    return {
        decoderGlueURL: DECODER_GLUE_URL,
        decoderWASM: { kind: 'url', url: DECODER_WASM_URL },
        requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
        qualifications: createHEVCExactCapabilityWorkerQualificationRequests(loadMain10UltraHDQualificationBitstream()),
        type: 'probe'
    };
}

/** Returns the summary of a vector whose every frame matched, with the byte length of one frame in compact planes. */
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

/** Returns the summary of a vector whose decoder failed before it output a frame. */
function createDecodeErrorResult(vector: HEVCExactCapabilityVector): HEVCExactCapabilityWorkerQualificationResult {
    return {
        bitDepth: null,
        chromaHeight: null,
        chromaWidth: null,
        codedHeight: null,
        codedWidth: null,
        decodedFrameFingerprints: null,
        decodedFrameCount: null,
        decodedByteLength: null,
        levelIDC: null,
        profileIDC: null,
        reason: 'decode-error',
        supported: false,
        vector,
        totalDecodedByteLength: null
    };
}

describe('exact HEVC capability vectors and protocol', () => {
    it('recreates all exact Main and Main10 access units as fresh buffers', () => {
        const firstRequests = createHEVCExactCapabilityWorkerQualificationRequests(loadMain10UltraHDQualificationBitstream());
        const secondRequests = createHEVCExactCapabilityWorkerQualificationRequests(loadMain10UltraHDQualificationBitstream());

        expect(firstRequests).toHaveLength(HEVC_EXACT_CAPABILITY_VECTORS.length);
        for (let requestIndex = 0; requestIndex < firstRequests.length; requestIndex += 1) {
            const request = firstRequests[requestIndex];
            const definition = HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS[request.vector];
            expect(request).toMatchObject({
                bitDepth: definition.bitDepth,
                codedHeight: definition.codedHeight,
                codedWidth: definition.codedWidth,
                levelIDC: definition.levelIDC,
                profileIDC: definition.profileIDC
            });
            expect(request.qualificationAccessUnits).toHaveLength(definition.qualificationFrameCount);
            expect(request.accessUnit).not.toBe(secondRequests[requestIndex].accessUnit);
            expect(request.qualificationAccessUnits[0]).not.toBe(secondRequests[requestIndex].qualificationAccessUnits[0]);
        }
    });

    it('counts a byte per sample at 8 bits and two at 10 in a decoded frame', () => {
        expect(HEVC_EXACT_CAPABILITY_VECTORS.map((vector: HEVCExactCapabilityVector): number => (
            getHEVCExactCapabilityDecodedFrameByteLength(HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS[vector])
        ))).toEqual([
            MAIN_1080P_DECODED_FRAME_BYTE_LENGTH,
            MAIN10_1080P_DECODED_FRAME_BYTE_LENGTH,
            MAIN10_4K_DECODED_FRAME_BYTE_LENGTH
        ]);
    });

    it('accepts only the complete exact bounded worker request', () => {
        const request = createRequest();
        expect(isHEVCExactCapabilityWorkerRequest(request)).toBe(true);
        expect(isHEVCExactCapabilityWorkerRequest({
            ...request,
            qualifications: [
                request.qualifications[0],
                request.qualifications[0],
                request.qualifications[2]
            ]
        })).toBe(false);
        expect(isHEVCExactCapabilityWorkerRequest({
            ...request,
            qualifications: [
                { ...request.qualifications[0], codedWidth: MISMATCHED_CODED_WIDTH },
                request.qualifications[1],
                request.qualifications[2]
            ]
        })).toBe(false);
        expect(isHEVCExactCapabilityWorkerRequest({
            ...request,
            qualifications: [
                {
                    ...request.qualifications[0],
                    qualificationAccessUnits: [
                        new ArrayBuffer(TRUNCATED_ACCESS_UNIT_BYTE_LENGTH),
                        ...request.qualifications[0].qualificationAccessUnits.slice(1)
                    ]
                },
                request.qualifications[1],
                request.qualifications[2]
            ]
        })).toBe(false);
        expect(isHEVCExactCapabilityWorkerRequest({
            ...request,
            qualifications: [
                { ...request.qualifications[0], accessUnit: new ArrayBuffer(0) },
                request.qualifications[1],
                request.qualifications[2]
            ]
        })).toBe(false);
    });

    it('accepts the decoder binary as preloaded bytes or an HTTP(S) URL only', () => {
        const request = createRequest();
        expect(isHEVCExactCapabilityWorkerRequest({
            ...request,
            decoderWASM: { bytes: new ArrayBuffer(PRELOADED_DECODER_WASM_BYTE_LENGTH), kind: 'bytes' }
        })).toBe(true);
        expect(isHEVCExactCapabilityWorkerRequest({
            ...request,
            decoderWASM: { bytes: new ArrayBuffer(0), kind: 'bytes' }
        })).toBe(false);
        expect(isHEVCExactCapabilityWorkerRequest({
            ...request,
            decoderWASM: { bytes: new Uint8Array(PRELOADED_DECODER_WASM_BYTE_LENGTH), kind: 'bytes' }
        })).toBe(false);
        expect(isHEVCExactCapabilityWorkerRequest({
            ...request,
            decoderWASM: { kind: 'url', url: FILE_DECODER_WASM_URL }
        })).toBe(false);
        expect(isHEVCExactCapabilityWorkerRequest({
            ...request,
            decoderWASM: undefined
        })).toBe(false);
    });

    it('rejects inconsistent or incomplete worker summaries', () => {
        const validResponse: HEVCExactCapabilityWorkerResponse = {
            requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
            results: [
                createVerifiedResult('main-1080p', MAIN_1080P_DECODED_FRAME_BYTE_LENGTH),
                createDecodeErrorResult('main10-1080p'),
                createDecodeErrorResult('main10-4k')
            ],
            type: 'result'
        };
        expect(isHEVCExactCapabilityWorkerResponse(validResponse)).toBe(true);
        expect(isHEVCExactCapabilityWorkerResponse({
            ...validResponse,
            results: [
                validResponse.results[0],
                validResponse.results[0],
                validResponse.results[2]
            ]
        })).toBe(false);
        expect(isHEVCExactCapabilityWorkerResponse({
            ...validResponse,
            results: [
                { ...validResponse.results[0], supported: false },
                validResponse.results[1],
                validResponse.results[2]
            ]
        })).toBe(false);
        expect(isHEVCExactCapabilityWorkerResponse({
            ...validResponse,
            results: [
                { ...validResponse.results[0], decodedByteLength: null },
                validResponse.results[1],
                validResponse.results[2]
            ]
        })).toBe(false);
    });
});
