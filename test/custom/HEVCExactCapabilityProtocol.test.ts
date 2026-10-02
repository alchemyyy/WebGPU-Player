// @vitest-environment node

import { ENGINE_ROOT } from '../helpers/enginePaths';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    createHEVCExactCapabilityWorkerQualificationRequests
} from 'webgpu-player/custom/HEVCExactCapabilityFixtures';
import {
    HEVC_EXACT_CAPABILITY_REQUEST_ID,
    HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS,
    isHEVCExactCapabilityWorkerRequest,
    isHEVCExactCapabilityWorkerResponse,
    type HEVCExactCapabilityWorkerRequest,
    type HEVCExactCapabilityWorkerResponse
} from 'webgpu-player/custom/HEVCExactCapabilityProtocol';

const MAIN10_4K_QUALIFICATION_PATH = resolve(
    ENGINE_ROOT,
    'fixtures/capability/hevc/main10-4k-complex.hevc'
);

function loadMain10UltraHDQualificationBitstream(): ArrayBuffer {
    return Uint8Array.from(readFileSync(MAIN10_4K_QUALIFICATION_PATH)).buffer;
}

function createRequest(): HEVCExactCapabilityWorkerRequest {
    return {
        decoderGlueURL: 'https://example.test/hevc-decode.js',
        decoderWASMURL: 'https://example.test/hevc-decode.wasm',
        requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
        qualifications: createHEVCExactCapabilityWorkerQualificationRequests(
            loadMain10UltraHDQualificationBitstream()
        ),
        type: 'probe'
    };
}

describe('exact HEVC capability fixtures and protocol', () => {
    it('recreates all exact Main and Main10 access units as fresh buffers', () => {
        const firstRequests = createHEVCExactCapabilityWorkerQualificationRequests(
            loadMain10UltraHDQualificationBitstream()
        );
        const secondRequests = createHEVCExactCapabilityWorkerQualificationRequests(
            loadMain10UltraHDQualificationBitstream()
        );

        expect(firstRequests).toHaveLength(3);
        for (let requestIndex = 0; requestIndex < firstRequests.length; requestIndex += 1) {
            const request = firstRequests[requestIndex];
            const definition = HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS[request.fixture];
            expect(request).toMatchObject({
                bitDepth: definition.bitDepth,
                codedHeight: definition.codedHeight,
                codedWidth: definition.codedWidth,
                levelIDC: definition.levelIDC,
                profileIDC: definition.profileIDC
            });
            expect(request.qualificationAccessUnits).toHaveLength(
                definition.qualificationFrameCount
            );
            expect(request.accessUnit).not.toBe(secondRequests[requestIndex].accessUnit);
            expect(request.qualificationAccessUnits[0]).not.toBe(
                secondRequests[requestIndex].qualificationAccessUnits[0]
            );
        }
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
                { ...request.qualifications[0], codedWidth: 1_280 },
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
                        new ArrayBuffer(1),
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

    it('rejects inconsistent or incomplete worker summaries', () => {
        const validResponse: HEVCExactCapabilityWorkerResponse = {
            requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
            results: [
                {
                    bitDepth: 8,
                    chromaHeight: 540,
                    chromaWidth: 960,
                    codedHeight: 1_080,
                    codedWidth: 1_920,
                    decodedFrameFingerprints:
                        HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS['main-1080p']
                            .decodedFrameFingerprints,
                    decodedFrameCount: 8,
                    decodedByteLength: 6_220_800,
                    levelIDC: 120,
                    profileIDC: 1,
                    reason: 'decode-output-verified',
                    supported: true,
                    fixture: 'main-1080p',
                    totalDecodedByteLength: 49_766_400
                },
                {
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
                    fixture: 'main10-1080p',
                    totalDecodedByteLength: null
                },
                {
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
                    fixture: 'main10-4k',
                    totalDecodedByteLength: null
                }
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
