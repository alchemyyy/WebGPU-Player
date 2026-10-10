// @vitest-environment node

import { QUALIFICATION_VECTORS_DIRECTORY, WASM_OUTPUT_DIRECTORY } from '../../helpers/enginePaths';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHEVCExactCapabilityWorkerQualificationRequests } from 'webgpu-player/capability/vectors/HEVCExactCapabilityVectors';
import {
    HEVC_EXACT_CAPABILITY_REQUEST_ID,
    HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS,
    type HEVCExactCapabilityVector,
    type HEVCExactCapabilityWorkerQualificationResult,
    type HEVCExactCapabilityWorkerRequest
} from 'webgpu-player/capability/exact/HEVCExactCapabilityProtocol';
import { runHEVCExactCapabilityWorkerRequest } from 'webgpu-player/capability/exact/HEVCExactCapabilityWorkerRuntime';

const HEVC_DECODER_DIRECTORY = resolve(WASM_OUTPUT_DIRECTORY, 'ffmpeg-hevc');
const HEVC_GLUE_PATH = resolve(HEVC_DECODER_DIRECTORY, 'ffmpeg-hevc.js');
const HEVC_WASM_PATH = resolve(HEVC_DECODER_DIRECTORY, 'ffmpeg-hevc.wasm');
const MAIN10_4K_QUALIFICATION_PATH = resolve(QUALIFICATION_VECTORS_DIRECTORY, 'hevc', 'main10-4k-complex.hevc');
// The known answers, which every conformant decoder reproduces because HEVC decoding is bit-exact
const MAIN_1080P_DECODED_FRAME_FINGERPRINTS = Object.freeze([
    1_409_144_559,
    2_325_269_144,
    1_479_088_652,
    3_424_562_773,
    1_522_044_181,
    3_126_439_635,
    2_013_041_680,
    1_744_647_904
]);
const MAIN10_1080P_DECODED_FRAME_FINGERPRINTS = Object.freeze([
    918_370,
    3_550_082_707,
    3_383_640_766,
    728_543_190,
    3_369_665_670,
    2_797_437_209,
    3_596_637_169,
    36_311_845
]);
const MAIN10_4K_DECODED_FRAME_FINGERPRINTS = Object.freeze([
    2_669_261_473,
    2_891_374_311,
    3_294_996_003,
    3_899_934_279,
    3_645_638_150,
    3_163_731_443,
    1_028_093_413,
    2_922_080_851
]);
// Compact 4:2:0 planes hold a byte per sample at 8 bits and two at 10
const MAIN_1080P_DECODED_FRAME_BYTE_LENGTH = 3_110_400;
const MAIN10_1080P_DECODED_FRAME_BYTE_LENGTH = 6_220_800;
const MAIN10_4K_DECODED_FRAME_BYTE_LENGTH = 24_883_200;
// The decode takes well under a second on a desktop, so this bound only spares a slow runner
const DECODE_TIMEOUT_MILLISECONDS = 15_000;

type EmscriptenModuleFactory = (options: Record<string, unknown>) => Promise<unknown>;

/** Loads the built kit's glue, which exports its module factory to CommonJS when it runs in Node. */
function loadActualModuleFactory(): EmscriptenModuleFactory {
    return createRequire(import.meta.url)(HEVC_GLUE_PATH) as EmscriptenModuleFactory;
}

function createQualificationRequests(): HEVCExactCapabilityWorkerRequest['qualifications'] {
    return createHEVCExactCapabilityWorkerQualificationRequests(Uint8Array.from(readFileSync(MAIN10_4K_QUALIFICATION_PATH)).buffer);
}

/** Returns the result of a vector whose every frame matched: its definition's geometry, the pinned fingerprints, and the compact byte length. */
function createVerifiedResult(
    vector: HEVCExactCapabilityVector,
    decodedFrameFingerprints: readonly number[],
    decodedByteLength: number
): HEVCExactCapabilityWorkerQualificationResult {
    const definition = HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS[vector];
    return {
        bitDepth: definition.bitDepth,
        chromaHeight: Math.ceil(definition.codedHeight / 2),
        chromaWidth: Math.ceil(definition.codedWidth / 2),
        codedHeight: definition.codedHeight,
        codedWidth: definition.codedWidth,
        decodedFrameFingerprints,
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

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('exact HEVC capability probe integration', () => {
    it('decodes all exact moving Main and Main10 vectors to their known answers through the FFmpeg kit', async () => {
        vi.stubGlobal('HEVCDecoderModule', loadActualModuleFactory());
        // The page hands the worker the binary's bytes, as the probe does after its parallel download
        const request: HEVCExactCapabilityWorkerRequest = {
            decoderGlueURL: HEVC_GLUE_PATH,
            decoderWASM: { bytes: Uint8Array.from(readFileSync(HEVC_WASM_PATH)).buffer, kind: 'bytes' },
            requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
            qualifications: createQualificationRequests(),
            type: 'probe'
        };

        const response = await runHEVCExactCapabilityWorkerRequest(request);

        expect(response.results).toEqual([
            createVerifiedResult('main-1080p', MAIN_1080P_DECODED_FRAME_FINGERPRINTS, MAIN_1080P_DECODED_FRAME_BYTE_LENGTH),
            createVerifiedResult('main10-1080p', MAIN10_1080P_DECODED_FRAME_FINGERPRINTS, MAIN10_1080P_DECODED_FRAME_BYTE_LENGTH),
            createVerifiedResult('main10-4k', MAIN10_4K_DECODED_FRAME_FINGERPRINTS, MAIN10_4K_DECODED_FRAME_BYTE_LENGTH)
        ]);
    }, DECODE_TIMEOUT_MILLISECONDS);

    it('rejects a decoder binary named by a URL outside HTTP(S)', async () => {
        vi.stubGlobal('HEVCDecoderModule', loadActualModuleFactory());
        const request: HEVCExactCapabilityWorkerRequest = {
            decoderGlueURL: HEVC_GLUE_PATH,
            decoderWASM: { kind: 'url', url: HEVC_WASM_PATH },
            requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
            qualifications: createQualificationRequests(),
            type: 'probe'
        };

        await expect(runHEVCExactCapabilityWorkerRequest(request)).rejects.toThrow(TypeError);
    });
});
