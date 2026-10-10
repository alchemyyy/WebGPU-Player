import {
    createHEVCDecoderModule,
    type HEVCDecodedFrame,
    type HEVCDecoderBackend,
    type HEVCDecoderModule,
    type HEVCDecoderModuleOptions,
    type HEVCFramePlane
} from '../../video/decoders/HEVCDecoderBackend';
import { requireMicroseconds } from '../../TimeMath';
import {
    getHEVCExactCapabilityDecodedFrameByteLength,
    HEVC_EXACT_CAPABILITY_MAXIMUM_DECODED_BYTE_LENGTH,
    HEVC_EXACT_CAPABILITY_MAXIMUM_TOTAL_DECODED_BYTE_LENGTH,
    HEVC_EXACT_CAPABILITY_REQUEST_ID,
    HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS,
    isHEVCExactCapabilityWorkerRequest,
    type HEVCExactCapabilityWorkerQualificationRequest,
    type HEVCExactCapabilityWorkerQualificationResult,
    type HEVCExactCapabilityWorkerRequest,
    type HEVCExactCapabilityWorkerResponse
} from './HEVCExactCapabilityProtocol';

export type HEVCExactCapabilityWorkerRuntimeDependencies = Readonly<{
    createDecoderModule: (options: HEVCDecoderModuleOptions) => Promise<HEVCDecoderModule>
    fingerprintFrame: (frame: HEVCDecodedFrame) => number
}>;

const DEFAULT_DEPENDENCIES: HEVCExactCapabilityWorkerRuntimeDependencies = Object.freeze({
    createDecoderModule: createHEVCDecoderModule,
    fingerprintFrame: createFrameFingerprint
});

// The access units carry no timing, so each is sent at its index with no duration
const QUALIFICATION_FRAME_DURATION_MICROSECONDS = requireMicroseconds(0);

type AnnexBStartCode = Readonly<{
    byteLength: 3 | 4
    offset: number
}>;

type HEVCExactVectorMetadata = Readonly<{
    levelIDC: number
    mainTier: boolean
    progressive: boolean
    profileIDC: 1 | 2
}>;

function findAnnexBStartCode(bytes: Uint8Array, startOffset: number): AnnexBStartCode | null {
    for (let byteOffset = startOffset; byteOffset + 3 <= bytes.byteLength; byteOffset += 1) {
        if (bytes[byteOffset] !== 0 || bytes[byteOffset + 1] !== 0) {
            continue;
        }
        if (bytes[byteOffset + 2] === 1) {
            return { byteLength: 3, offset: byteOffset };
        }
        if (byteOffset + 4 <= bytes.byteLength && bytes[byteOffset + 2] === 0 && bytes[byteOffset + 3] === 1) {
            return { byteLength: 4, offset: byteOffset };
        }
    }
    return null;
}

function findFirstVCLNALUnitType(accessUnit: ArrayBuffer): number | null {
    const bytes = new Uint8Array(accessUnit);
    let startCode = findAnnexBStartCode(bytes, 0);
    while (startCode) {
        const nalUnitOffset = startCode.offset + startCode.byteLength;
        if (nalUnitOffset + 2 <= bytes.byteLength) {
            const nalUnitType = (bytes[nalUnitOffset] >> 1) & 0x3F;
            if (nalUnitType <= 31) {
                return nalUnitType;
            }
        }
        startCode = findAnnexBStartCode(bytes, nalUnitOffset + 2);
    }
    return null;
}

function createRBSP(nalUnit: Uint8Array): Uint8Array {
    const bytes: number[] = [];
    for (let byteIndex = 2; byteIndex < nalUnit.byteLength; byteIndex += 1) {
        if (nalUnit[byteIndex] === 3 && byteIndex >= 4 && nalUnit[byteIndex - 1] === 0 && nalUnit[byteIndex - 2] === 0) {
            continue;
        }
        bytes.push(nalUnit[byteIndex]);
    }
    return new Uint8Array(bytes);
}

function parseVectorMetadata(accessUnit: ArrayBuffer): HEVCExactVectorMetadata {
    const bytes = new Uint8Array(accessUnit);
    let startCode = findAnnexBStartCode(bytes, 0);
    while (startCode) {
        const nalUnitOffset = startCode.offset + startCode.byteLength;
        const nextStartCode = findAnnexBStartCode(bytes, nalUnitOffset);
        const nalUnitEnd = nextStartCode?.offset ?? bytes.byteLength;
        if (nalUnitOffset + 2 <= nalUnitEnd && ((bytes[nalUnitOffset] >> 1) & 0x3F) === 33) {
            const nalUnit = bytes.subarray(nalUnitOffset, nalUnitEnd);
            const rbsp = createRBSP(nalUnit);
            if (rbsp.byteLength < 13) {
                throw new TypeError('The exact HEVC probe SPS profile tier level is truncated');
            }
            const profileIDC = rbsp[1] & 0x1F;
            if (profileIDC !== 1 && profileIDC !== 2) {
                throw new TypeError('The exact HEVC probe SPS profile is unsupported');
            }
            return {
                levelIDC: rbsp[12],
                mainTier: (rbsp[1] & 0x20) === 0,
                progressive: (rbsp[6] & 0x80) !== 0 && (rbsp[6] & 0x40) === 0,
                profileIDC
            };
        }
        startCode = nextStartCode;
    }
    throw new TypeError('The exact HEVC probe access unit has no SPS');
}

function createFailureResult(
    qualificationRequest: HEVCExactCapabilityWorkerQualificationRequest,
    reason: Exclude<HEVCExactCapabilityWorkerQualificationResult['reason'], 'decode-output-verified'>
): HEVCExactCapabilityWorkerQualificationResult {
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
        reason,
        supported: false,
        vector: qualificationRequest.vector,
        totalDecodedByteLength: null
    };
}

/** Returns the byte length of a decoded frame as compact planes: bytes at 8 bits and 16-bit words at 10. */
function getDecodedByteLength(frame: HEVCDecodedFrame): number {
    const bytesPerSample = frame.bitDepth === 8 ? Uint8Array.BYTES_PER_ELEMENT : Uint16Array.BYTES_PER_ELEMENT;
    const decodedByteLength = ((frame.width * frame.height) + (2 * frame.chromaWidth * frame.chromaHeight)) * bytesPerSample;
    if (
        !Number.isSafeInteger(decodedByteLength)
        || decodedByteLength <= 0
        || decodedByteLength > HEVC_EXACT_CAPABILITY_MAXIMUM_DECODED_BYTE_LENGTH
    ) {
        throw new TypeError('The exact HEVC probe output exceeds its memory bound');
    }
    return decodedByteLength;
}

const FINGERPRINT_COLUMN_SAMPLE_COUNT = 64;
const FINGERPRINT_ROW_SAMPLE_COUNT = 36;
const FNV1A_OFFSET_BASIS = 2_166_136_261;
const FNV1A_PRIME = 16_777_619;

function mixFingerprintValue(fingerprint: number, value: number): number {
    let mixedFingerprint = Math.imul((fingerprint ^ (value & 0xFF)) >>> 0, FNV1A_PRIME) >>> 0;
    mixedFingerprint = Math.imul((mixedFingerprint ^ ((value >>> 8) & 0xFF)) >>> 0, FNV1A_PRIME) >>> 0;
    return mixedFingerprint;
}

/** Mixes a grid of a plane's samples, each as two bytes whatever the bit depth, so one fingerprint holds for any conformant decoder. */
function mixPlaneFingerprint(
    fingerprint: number,
    plane: HEVCFramePlane,
    width: number,
    height: number
): number {
    let mixedFingerprint = mixFingerprintValue(fingerprint, width);
    mixedFingerprint = mixFingerprintValue(mixedFingerprint, height);
    for (let rowSampleIndex = 0; rowSampleIndex < FINGERPRINT_ROW_SAMPLE_COUNT; rowSampleIndex += 1) {
        const rowIndex = Math.floor(rowSampleIndex * (height - 1) / (FINGERPRINT_ROW_SAMPLE_COUNT - 1));
        for (let columnSampleIndex = 0; columnSampleIndex < FINGERPRINT_COLUMN_SAMPLE_COUNT; columnSampleIndex += 1) {
            const columnIndex = Math.floor(columnSampleIndex * (width - 1) / (FINGERPRINT_COLUMN_SAMPLE_COUNT - 1));
            mixedFingerprint = mixFingerprintValue(mixedFingerprint, plane.samples[(rowIndex * plane.stride) + columnIndex]);
        }
    }
    return mixedFingerprint;
}

function createFrameFingerprint(frame: HEVCDecodedFrame): number {
    let fingerprint = mixPlaneFingerprint(FNV1A_OFFSET_BASIS, frame.planes.luma, frame.width, frame.height);
    fingerprint = mixPlaneFingerprint(fingerprint, frame.planes.chromaBlue, frame.chromaWidth, frame.chromaHeight);
    return mixPlaneFingerprint(fingerprint, frame.planes.chromaRed, frame.chromaWidth, frame.chromaHeight);
}

function frameMatchesRequest(
    frame: HEVCDecodedFrame,
    vectorMetadata: HEVCExactVectorMetadata,
    qualificationRequest: HEVCExactCapabilityWorkerQualificationRequest,
    decodedByteLength: number,
    decodedFrameFingerprint: number,
    outputFrameIndex: number
): boolean {
    const definition = HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS[qualificationRequest.vector];

    return frame.width === qualificationRequest.codedWidth
        && frame.height === qualificationRequest.codedHeight
        && frame.chromaWidth === Math.ceil(qualificationRequest.codedWidth / 2)
        && frame.chromaHeight === Math.ceil(qualificationRequest.codedHeight / 2)
        && frame.bitDepth === qualificationRequest.bitDepth
        && decodedByteLength === getHEVCExactCapabilityDecodedFrameByteLength(definition)
        && decodedFrameFingerprint === definition.decodedFrameFingerprints[outputFrameIndex]
        && vectorMetadata.levelIDC === qualificationRequest.levelIDC
        && vectorMetadata.mainTier
        && vectorMetadata.progressive
        && vectorMetadata.profileIDC === qualificationRequest.profileIDC;
}

type HEVCExactOutputGeometry = Readonly<{
    bitDepth: number
    chromaHeight: number
    chromaWidth: number
    codedHeight: number
    codedWidth: number
    decodedByteLength: number
}>;

type HEVCExactQualificationState = {
    decodedFrameFingerprints: number[]
    decodedFrameCount: number
    geometry: HEVCExactOutputGeometry | null
    outputMatches: boolean
    totalDecodedByteLength: number
};

type HEVCExactQualificationEvidence = Readonly<{
    decodedFrameFingerprints: readonly number[]
    decodedFrameCount: number
    geometry: HEVCExactOutputGeometry
    totalDecodedByteLength: number
}>;

function createQualificationResult(
    qualificationRequest: HEVCExactCapabilityWorkerQualificationRequest,
    evidence: HEVCExactQualificationEvidence,
    reason: HEVCExactCapabilityWorkerQualificationResult['reason']
): HEVCExactCapabilityWorkerQualificationResult {
    const supported = reason === 'decode-output-verified';
    return {
        bitDepth: evidence.geometry.bitDepth,
        chromaHeight: evidence.geometry.chromaHeight,
        chromaWidth: evidence.geometry.chromaWidth,
        codedHeight: evidence.geometry.codedHeight,
        codedWidth: evidence.geometry.codedWidth,
        decodedFrameFingerprints: evidence.decodedFrameFingerprints,
        decodedFrameCount: evidence.decodedFrameCount,
        decodedByteLength: evidence.geometry.decodedByteLength,
        levelIDC: qualificationRequest.levelIDC,
        profileIDC: qualificationRequest.profileIDC,
        reason,
        supported,
        vector: qualificationRequest.vector,
        totalDecodedByteLength: evidence.totalDecodedByteLength
    };
}

function consumeFrame(
    frame: HEVCDecodedFrame,
    vectorMetadata: HEVCExactVectorMetadata,
    qualificationRequest: HEVCExactCapabilityWorkerQualificationRequest,
    state: HEVCExactQualificationState,
    fingerprintFrame: (frame: HEVCDecodedFrame) => number
): void {
    const outputFrameIndex = state.decodedFrameCount;
    if (outputFrameIndex >= qualificationRequest.qualificationFrameCount) {
        throw new TypeError('The exact HEVC probe returned too many frames');
    }
    const decodedByteLength = getDecodedByteLength(frame);
    const decodedFrameFingerprint = fingerprintFrame(frame);
    state.decodedFrameCount += 1;
    state.decodedFrameFingerprints.push(decodedFrameFingerprint);
    state.totalDecodedByteLength += decodedByteLength;
    if (
        !Number.isSafeInteger(state.totalDecodedByteLength)
        || state.totalDecodedByteLength > HEVC_EXACT_CAPABILITY_MAXIMUM_TOTAL_DECODED_BYTE_LENGTH
    ) {
        throw new TypeError('The exact HEVC probe aggregate output exceeds its bound');
    }
    state.geometry ??= {
        bitDepth: frame.bitDepth,
        chromaHeight: frame.chromaHeight,
        chromaWidth: frame.chromaWidth,
        codedHeight: frame.height,
        codedWidth: frame.width,
        decodedByteLength
    };
    state.outputMatches &&= frameMatchesRequest(
        frame,
        vectorMetadata,
        qualificationRequest,
        decodedByteLength,
        decodedFrameFingerprint,
        outputFrameIndex
    );
}

function probeQualification(
    qualificationRequest: HEVCExactCapabilityWorkerQualificationRequest,
    decoderModule: HEVCDecoderModule,
    dependencies: HEVCExactCapabilityWorkerRuntimeDependencies
): HEVCExactCapabilityWorkerQualificationResult {
    let decoder: HEVCDecoderBackend | null = null;

    try {
        const vectorMetadata = parseVectorMetadata(qualificationRequest.qualificationAccessUnits[0]);
        // The access units are Annex B with their parameter sets in band, so the decoder has no description
        decoder = decoderModule.createDecoder(null);
        const state: HEVCExactQualificationState = {
            decodedFrameFingerprints: [],
            decodedFrameCount: 0,
            geometry: null,
            outputMatches: true,
            totalDecodedByteLength: 0
        };
        const handleFrame = (frame: HEVCDecodedFrame): void => {
            consumeFrame(frame, vectorMetadata, qualificationRequest, state, dependencies.fingerprintFrame);
        };
        for (let accessUnitIndex = 0; accessUnitIndex < qualificationRequest.qualificationAccessUnits.length; accessUnitIndex += 1) {
            const definition = HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS[qualificationRequest.vector];
            if (
                findFirstVCLNALUnitType(
                    qualificationRequest.qualificationAccessUnits[accessUnitIndex]
                ) !== definition.qualificationVCLNALUnitTypes[accessUnitIndex]
            ) {
                return createFailureResult(qualificationRequest, 'decode-error');
            }
            decoder.decode(
                new Uint8Array(qualificationRequest.qualificationAccessUnits[accessUnitIndex]),
                requireMicroseconds(accessUnitIndex),
                QUALIFICATION_FRAME_DURATION_MICROSECONDS,
                handleFrame
            );
        }
        decoder.flush(handleFrame);
        if (!state.geometry) {
            return createFailureResult(qualificationRequest, 'decode-error');
        }
        const evidence: HEVCExactQualificationEvidence = {
            decodedFrameFingerprints: Object.freeze([...state.decodedFrameFingerprints]),
            decodedFrameCount: state.decodedFrameCount,
            geometry: state.geometry,
            totalDecodedByteLength: state.totalDecodedByteLength
        };
        const expectedDecodedByteLength = state.geometry.decodedByteLength * qualificationRequest.qualificationFrameCount;
        if (
            state.decodedFrameCount !== qualificationRequest.qualificationFrameCount
            || state.totalDecodedByteLength !== expectedDecodedByteLength
            || !state.outputMatches
        ) {
            return createQualificationResult(qualificationRequest, evidence, 'output-mismatch');
        }
        return createQualificationResult(qualificationRequest, evidence, 'decode-output-verified');
    } catch {
        return createFailureResult(qualificationRequest, 'decode-error');
    } finally {
        decoder?.destroy();
    }
}

/** Runs every exact HEVC qualification vector through the bounded decoder. */
export async function runHEVCExactCapabilityWorkerRequest(
    request: HEVCExactCapabilityWorkerRequest,
    dependencies: HEVCExactCapabilityWorkerRuntimeDependencies = DEFAULT_DEPENDENCIES
): Promise<HEVCExactCapabilityWorkerResponse> {
    if (!isHEVCExactCapabilityWorkerRequest(request)) {
        throw new TypeError('The exact HEVC capability worker request is invalid');
    }

    const moduleOptions: HEVCDecoderModuleOptions = request.decoderWASM.kind === 'bytes' ?
        { wasmBinary: request.decoderWASM.bytes } :
        { wasmURL: request.decoderWASM.url };
    const results: HEVCExactCapabilityWorkerQualificationResult[] = [];
    // One instantiated module hosts each vector's decoder in turn, saving a fetch and compile per vector
    let decoderModule: HEVCDecoderModule | null = null;
    let totalDecodedByteLength = 0;
    for (const qualificationRequest of request.qualifications) {
        let result: HEVCExactCapabilityWorkerQualificationResult;
        try {
            decoderModule ??= await dependencies.createDecoderModule(moduleOptions);
            result = probeQualification(qualificationRequest, decoderModule, dependencies);
        } catch {
            result = createFailureResult(qualificationRequest, 'decode-error');
        }
        if (!result.supported) {
            // Any failure, a trap mid-call included, may leave the module heap inconsistent, so the next vector gets a fresh module
            decoderModule = null;
        }
        totalDecodedByteLength += result.totalDecodedByteLength ?? 0;
        if (
            !Number.isSafeInteger(totalDecodedByteLength)
            || totalDecodedByteLength > HEVC_EXACT_CAPABILITY_MAXIMUM_TOTAL_DECODED_BYTE_LENGTH
        ) {
            results.push(createFailureResult(qualificationRequest, 'decode-error'));
            continue;
        }
        results.push(result);
    }
    return {
        requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
        results,
        type: 'result'
    };
}
