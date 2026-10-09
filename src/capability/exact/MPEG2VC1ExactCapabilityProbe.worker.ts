import {
    ALL_FORMATS,
    BufferSource,
    EncodedPacketSink,
    Input,
    type InputVideoTrack,
    type VideoSample
} from 'mediabunny';

import { getEmscriptenWASMOptions, type EmscriptenWASMOptions } from '../../DecoderWASMSource';
import MPEG2VC1SoftwareVideoDecoder, {
    type MPEG2VC1SoftwareVideoDecoderDependencies,
    type MPEG2VC1DecoderModule
} from '../../video/decoders/MPEG2VC1SoftwareVideoDecoder';
import { getMatroskaVC1DecoderDescription } from '../../video/MatroskaVFWVideoConfiguration';
import {
    getMPEG2VC1Qualification,
    isMPEG2VC1ExactCapabilityWorkerRequest,
    type MPEG2VC1ExactCapabilityRequestID,
    type MPEG2VC1ExactCapabilityWorkerRequest,
    type MPEG2VC1ExactCapabilityWorkerResponse,
    type MPEG2VC1Qualification
} from './MPEG2VC1ExactCapabilityProtocol';

type MPEG2VC1DecoderModuleFactory = (options: EmscriptenWASMOptions) => Promise<MPEG2VC1DecoderModule>;

type MPEG2VC1ProbeWorkerScope = typeof globalThis & {
    MPEG2VC1DecoderModule?: unknown
    importScripts?: (...urls: string[]) => void
};

const FNV_OFFSET_BASIS = 2_166_136_261;
const FNV_PRIME = 16_777_619;
const workerScope = globalThis as MPEG2VC1ProbeWorkerScope;
let probeStarted = false;

function createFailureResponse(
    requestID: MPEG2VC1ExactCapabilityRequestID,
    reason: MPEG2VC1ExactCapabilityWorkerResponse['reason'] = 'decode-error'
): MPEG2VC1ExactCapabilityWorkerResponse {
    return {
        codedHeight: null,
        codedWidth: null,
        decodedFrameByteLength: null,
        decodedFrameCount: null,
        decodedI420Fingerprint: null,
        decodedTotalByteLength: null,
        reason,
        requestID,
        supported: false,
        type: 'result'
    };
}

function createDependencies(
    request: MPEG2VC1ExactCapabilityWorkerRequest
): MPEG2VC1SoftwareVideoDecoderDependencies {
    return {
        // The binary comes from the request's source, not from the URL the decoder resolves
        createModule: async (): Promise<MPEG2VC1DecoderModule> => {
            const factory = workerScope.MPEG2VC1DecoderModule as
                MPEG2VC1DecoderModuleFactory | undefined;
            if (typeof factory !== 'function') {
                throw new Error('The MPEG-2/VC-1 probe module factory is unavailable');
            }
            return factory(getEmscriptenWASMOptions(request.decoderWASM));
        },
        loadDecoderGlue: (url: string): void => {
            if (typeof workerScope.MPEG2VC1DecoderModule === 'function') {
                return;
            }
            if (typeof workerScope.importScripts !== 'function') {
                throw new Error('The MPEG-2/VC-1 probe requires a classic Web Worker');
            }
            workerScope.importScripts(url);
        },
        resolveAssetURL: (): string => request.decoderGlueURL
    };
}

async function getQualifiedTrack(
    input: Input,
    qualification: MPEG2VC1Qualification
): Promise<{
        description?: Uint8Array
        track: InputVideoTrack
    }> {
    const tracks = await input.getVideoTracks();
    if (tracks.length !== 1) {
        throw new TypeError('The MPEG-2/VC-1 vector track count is invalid');
    }
    const track = tracks[0];
    const [ codec, internalCodecID, codedHeight, codedWidth ] = await Promise.all([
        track.getCodec(),
        track.getInternalCodecId(),
        track.getCodedHeight(),
        track.getCodedWidth()
    ]);
    if (
        codec !== null
        || internalCodecID !== qualification.internalCodecID
        || codedHeight !== qualification.codedHeight
        || codedWidth !== qualification.codedWidth
    ) {
        throw new TypeError('The MPEG-2/VC-1 vector route is invalid');
    }
    if (qualification.codec === 'vc1') {
        const description = getMatroskaVC1DecoderDescription(
            track,
            codedWidth,
            codedHeight
        );
        if (!description) {
            throw new TypeError('The VC-1 qualification description is invalid');
        }
        return { description, track };
    }
    return { track };
}

/** Mixes every byte into a 32-bit FNV-1a fingerprint. */
function mixFNV1aBytes(fingerprint: number, bytes: Uint8Array): number {
    // NOTE: Measured in V8, an iterator is about 13 times slower and this loop inlined in the async caller about 8 times
    const byteLength = bytes.byteLength;
    let mixedFingerprint = fingerprint;
    for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
        mixedFingerprint ^= bytes[byteIndex];
        mixedFingerprint = Math.imul(mixedFingerprint, FNV_PRIME) >>> 0;
    }
    return mixedFingerprint;
}

async function fingerprintSamples(samples: readonly VideoSample[]): Promise<{
    decodedFrameByteLength: number
    decodedI420Fingerprint: number
    decodedTotalByteLength: number
}> {
    let decodedFrameByteLength = 0;
    let decodedI420Fingerprint = FNV_OFFSET_BASIS;
    let decodedTotalByteLength = 0;
    // Qualification frames share one size, so one copy buffer serves them all
    let output = new Uint8Array(0);
    for (const sample of samples) {
        if (sample.format !== 'I420') {
            throw new TypeError('The MPEG-2/VC-1 qualification output is not I420');
        }
        const sampleByteLength = sample.allocationSize();
        if (decodedFrameByteLength === 0) {
            decodedFrameByteLength = sampleByteLength;
            output = new Uint8Array(sampleByteLength);
        } else if (sampleByteLength !== decodedFrameByteLength) {
            throw new TypeError('The MPEG-2/VC-1 qualification frame size changed');
        }
        // A tightly packed copy rewrites every byte, so no stale frame data survives
        await sample.copyTo(output);
        decodedTotalByteLength += output.byteLength;
        decodedI420Fingerprint = mixFNV1aBytes(decodedI420Fingerprint, output);
    }
    return {
        decodedFrameByteLength,
        decodedI420Fingerprint,
        decodedTotalByteLength
    };
}

async function runProbe(
    request: MPEG2VC1ExactCapabilityWorkerRequest
): Promise<MPEG2VC1ExactCapabilityWorkerResponse> {
    const qualification = getMPEG2VC1Qualification(request.requestID);
    const input = new Input({
        formats: ALL_FORMATS,
        source: new BufferSource(new Uint8Array(request.vector))
    });
    const samples: VideoSample[] = [];
    let decodeError: unknown = null;
    let decoder: MPEG2VC1SoftwareVideoDecoder | null = null;
    try {
        const qualifiedTrack = await getQualifiedTrack(input, qualification);
        decoder = new MPEG2VC1SoftwareVideoDecoder({
            codec: qualification.codec,
            codedHeight: qualification.codedHeight,
            codedWidth: qualification.codedWidth,
            description: qualifiedTrack.description,
            displayHeight: qualification.codedHeight,
            displayWidth: qualification.codedWidth
        }, {
            onError: (error: unknown): void => {
                decodeError = error;
            },
            onSample: (sample: VideoSample): void => {
                samples.push(sample);
            }
        }, createDependencies(request));
        await decoder.init();
        const packetSink = new EncodedPacketSink(qualifiedTrack.track);
        for await (const packet of packetSink.packets()) {
            decoder.decode(packet);
        }
        decoder.flush();
        if (decodeError !== null) {
            throw decodeError;
        }
        if (samples.length !== qualification.frameCount) {
            throw new TypeError('The MPEG-2/VC-1 qualification frame count is invalid');
        }
        const fingerprints = await fingerprintSamples(samples);
        const outputMatches = fingerprints.decodedFrameByteLength
                === qualification.frameByteLength
            && fingerprints.decodedTotalByteLength === qualification.totalByteLength
            && fingerprints.decodedI420Fingerprint === qualification.fingerprint;
        let reason: MPEG2VC1ExactCapabilityWorkerResponse['reason'];
        if (!outputMatches) {
            reason = 'output-mismatch';
        } else {
            reason = 'decode-output-verified';
        }
        return {
            codedHeight: qualification.codedHeight,
            codedWidth: qualification.codedWidth,
            decodedFrameByteLength: fingerprints.decodedFrameByteLength,
            decodedFrameCount: samples.length,
            decodedI420Fingerprint: fingerprints.decodedI420Fingerprint,
            decodedTotalByteLength: fingerprints.decodedTotalByteLength,
            reason,
            requestID: qualification.requestID,
            supported: reason === 'decode-output-verified',
            type: 'result'
        };
    } finally {
        for (const sample of samples) {
            sample.close();
        }
        decoder?.close();
        input.dispose();
    }
}

async function handleRequest(value: unknown): Promise<void> {
    if (probeStarted || !isMPEG2VC1ExactCapabilityWorkerRequest(value)) {
        return;
    }
    probeStarted = true;
    let response: MPEG2VC1ExactCapabilityWorkerResponse;
    try {
        response = await runProbe(value);
    } catch {
        response = createFailureResponse(value.requestID);
    }
    workerScope.postMessage(response);
}

// eslint-disable-next-line sonarjs/post-message -- Dedicated workers do not receive window origins
workerScope.addEventListener('message', (event: MessageEvent<unknown>): void => {
    void handleRequest(event.data);
});
