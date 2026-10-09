import { isDecoderWASMSource, type DecoderWASMSource } from '../../DecoderWASMSource';

export const MPEG2_EXACT_CAPABILITY_REQUEST_ID = 'mpeg2-progressive-main-1920x1080-v1';
export const VC1_EXACT_CAPABILITY_REQUEST_ID = 'vc1-progressive-advanced-1920x1080-v1';
export const MPEG2_VC1_QUALIFICATION_CODED_HEIGHT = 1_080;
export const MPEG2_VC1_QUALIFICATION_CODED_WIDTH = 1_920;
export const MPEG2_VC1_QUALIFICATION_FRAME_COUNT = 12;
export const MPEG2_VC1_QUALIFICATION_FRAME_BYTE_LENGTH = 3_110_400;
export const MPEG2_VC1_QUALIFICATION_TOTAL_BYTE_LENGTH = 37_324_800;
export const MPEG2_VIDEO_QUALIFICATION_FINGERPRINT = 544_635_241;
export const VC1_VIDEO_QUALIFICATION_FINGERPRINT = 182_587_665;

export type MPEG2VC1Codec = 'mpeg2video' | 'vc1';
export type MPEG2VC1ExactCapabilityRequestID =
    | typeof MPEG2_EXACT_CAPABILITY_REQUEST_ID
    | typeof VC1_EXACT_CAPABILITY_REQUEST_ID;

export type MPEG2VC1Qualification = Readonly<{
    codec: MPEG2VC1Codec
    codedHeight: number
    codedWidth: number
    fingerprint: number
    frameByteLength: number
    frameCount: number
    internalCodecID: 'V_MPEG2' | 'V_MS/VFW/FOURCC'
    requestID: MPEG2VC1ExactCapabilityRequestID
    totalByteLength: number
}>;

const MPEG2_QUALIFICATION: MPEG2VC1Qualification = Object.freeze({
    codec: 'mpeg2video',
    codedHeight: MPEG2_VC1_QUALIFICATION_CODED_HEIGHT,
    codedWidth: MPEG2_VC1_QUALIFICATION_CODED_WIDTH,
    fingerprint: MPEG2_VIDEO_QUALIFICATION_FINGERPRINT,
    frameByteLength: MPEG2_VC1_QUALIFICATION_FRAME_BYTE_LENGTH,
    frameCount: MPEG2_VC1_QUALIFICATION_FRAME_COUNT,
    internalCodecID: 'V_MPEG2',
    requestID: MPEG2_EXACT_CAPABILITY_REQUEST_ID,
    totalByteLength: MPEG2_VC1_QUALIFICATION_TOTAL_BYTE_LENGTH
});

const VC1_QUALIFICATION: MPEG2VC1Qualification = Object.freeze({
    codec: 'vc1',
    codedHeight: MPEG2_VC1_QUALIFICATION_CODED_HEIGHT,
    codedWidth: MPEG2_VC1_QUALIFICATION_CODED_WIDTH,
    fingerprint: VC1_VIDEO_QUALIFICATION_FINGERPRINT,
    frameByteLength: MPEG2_VC1_QUALIFICATION_FRAME_BYTE_LENGTH,
    frameCount: MPEG2_VC1_QUALIFICATION_FRAME_COUNT,
    internalCodecID: 'V_MS/VFW/FOURCC',
    requestID: VC1_EXACT_CAPABILITY_REQUEST_ID,
    totalByteLength: MPEG2_VC1_QUALIFICATION_TOTAL_BYTE_LENGTH
});

export type MPEG2VC1ExactCapabilityWorkerRequest = {
    decoderGlueURL: string
    // ffmpeg-mpeg2-vc1.wasm: bytes the page already fetched, or the URL the worker fetches
    decoderWASM: DecoderWASMSource
    vector: ArrayBuffer
    requestID: MPEG2VC1ExactCapabilityRequestID
    type: 'probe'
};

export type MPEG2VC1ExactCapabilityWorkerResponse = {
    codedHeight: number | null
    codedWidth: number | null
    decodedFrameByteLength: number | null
    decodedFrameCount: number | null
    decodedI420Fingerprint: number | null
    decodedTotalByteLength: number | null
    reason: 'decode-error' | 'decode-output-verified' | 'output-mismatch'
    requestID: MPEG2VC1ExactCapabilityRequestID
    supported: boolean
    type: 'result'
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function isSafeNullableInteger(value: unknown): value is number | null {
    return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function isWorkerReason(value: unknown): value is MPEG2VC1ExactCapabilityWorkerResponse['reason'] {
    switch (value) {
        case 'decode-error':
        case 'decode-output-verified':
        case 'output-mismatch':
            return true;
        default:
            return false;
    }
}

function isCodecAssetURL(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
        return false;
    }
    try {
        const parsedURL = new URL(value);
        return (parsedURL.protocol === 'http:' || parsedURL.protocol === 'https:')
            && parsedURL.username.length === 0
            && parsedURL.password.length === 0;
    } catch {
        return false;
    }
}

function isRequestID(value: unknown): value is MPEG2VC1ExactCapabilityRequestID {
    return value === MPEG2_EXACT_CAPABILITY_REQUEST_ID || value === VC1_EXACT_CAPABILITY_REQUEST_ID;
}

/** Returns the immutable qualification specification for the codec a request ID names. */
export function getMPEG2VC1Qualification(requestID: MPEG2VC1ExactCapabilityRequestID): MPEG2VC1Qualification {
    return requestID === VC1_EXACT_CAPABILITY_REQUEST_ID ? VC1_QUALIFICATION : MPEG2_QUALIFICATION;
}

/** Rejects malformed requests before the worker loads the MPEG-2/VC-1 decoder. */
export function isMPEG2VC1ExactCapabilityWorkerRequest(value: unknown): value is MPEG2VC1ExactCapabilityWorkerRequest {
    return isRecord(value)
        && value.type === 'probe'
        && isRequestID(value.requestID)
        && value.vector instanceof ArrayBuffer
        && value.vector.byteLength > 0
        && value.vector.byteLength <= 16 * 1024 * 1024
        && isCodecAssetURL(value.decoderGlueURL)
        && isDecoderWASMSource(value.decoderWASM);
}

/** Checks the shape of the exact-output evidence the worker returns; the probe compares its values with the qualification. */
export function isMPEG2VC1ExactCapabilityWorkerResponse(value: unknown): value is MPEG2VC1ExactCapabilityWorkerResponse {
    return isRecord(value)
        && value.type === 'result'
        && isRequestID(value.requestID)
        && typeof value.supported === 'boolean'
        && isWorkerReason(value.reason)
        && isSafeNullableInteger(value.codedHeight)
        && isSafeNullableInteger(value.codedWidth)
        && isSafeNullableInteger(value.decodedFrameByteLength)
        && isSafeNullableInteger(value.decodedFrameCount)
        && isSafeNullableInteger(value.decodedI420Fingerprint)
        && isSafeNullableInteger(value.decodedTotalByteLength);
}
