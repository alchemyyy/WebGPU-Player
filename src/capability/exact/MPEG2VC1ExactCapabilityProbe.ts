import {
    getDecoderWASMTransfer,
    loadDecoderWASMSource,
    type DecoderWASMSource
} from '../../DecoderWASMSource';
import {
    createEngineWorker,
    resolveEngineAssetURL,
    type EngineAssetPath,
    type EngineWorkerPath
} from '../../EngineAssets';
import { fetchCapabilityAsset, warmCapabilityAsset } from '../CapabilityAssetLoading';
import {
    getMPEG2VC1Qualification,
    isMPEG2VC1ExactCapabilityWorkerResponse,
    MPEG2_EXACT_CAPABILITY_REQUEST_ID,
    VC1_EXACT_CAPABILITY_REQUEST_ID,
    type MPEG2VC1Codec,
    type MPEG2VC1ExactCapabilityWorkerRequest,
    type MPEG2VC1ExactCapabilityWorkerResponse,
    type MPEG2VC1Qualification
} from './MPEG2VC1ExactCapabilityProtocol';

export {
    isMPEG2VC1ExactCapabilityWorkerRequest,
    isMPEG2VC1ExactCapabilityWorkerResponse,
    getMPEG2VC1Qualification,
    MPEG2_EXACT_CAPABILITY_REQUEST_ID,
    MPEG2_VC1_QUALIFICATION_CODED_HEIGHT,
    MPEG2_VC1_QUALIFICATION_CODED_WIDTH,
    MPEG2_VC1_QUALIFICATION_FRAME_BYTE_LENGTH,
    MPEG2_VC1_QUALIFICATION_FRAME_COUNT,
    MPEG2_VC1_QUALIFICATION_TOTAL_BYTE_LENGTH,
    MPEG2_VIDEO_QUALIFICATION_FINGERPRINT,
    VC1_EXACT_CAPABILITY_REQUEST_ID,
    VC1_VIDEO_QUALIFICATION_FINGERPRINT,
    type MPEG2VC1Codec,
    type MPEG2VC1Qualification,
    type MPEG2VC1ExactCapabilityWorkerRequest,
    type MPEG2VC1ExactCapabilityWorkerResponse
} from './MPEG2VC1ExactCapabilityProtocol';

export const MPEG2_VC1_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS = 5_000;

const MPEG2_VC1_DECODER_GLUE_ASSET: EngineAssetPath = 'ffmpeg-mpeg2-vc1/ffmpeg-mpeg2-vc1.js';
const MPEG2_VC1_DECODER_WASM_ASSET: EngineAssetPath = 'ffmpeg-mpeg2-vc1/ffmpeg-mpeg2-vc1.wasm';
const MPEG2_VIDEO_QUALIFICATION_ASSET: EngineAssetPath =
    'ffmpeg-mpeg2-vc1/mpeg2-progressive-1920x1080-qualification.bin';
const VC1_VIDEO_QUALIFICATION_ASSET: EngineAssetPath =
    'ffmpeg-mpeg2-vc1/vc1-advanced-progressive-1920x1080-qualification.bin';
const MPEG2_VC1_EXACT_CAPABILITY_WORKER_ASSET: EngineWorkerPath = 'webgpu-player/MPEG2VC1ExactCapabilityProbe.worker.js';

export type MPEG2VC1ExactCapabilityReason =
    | 'api-unavailable'
    | 'asset-unavailable'
    | 'decode-error'
    | 'decode-output-verified'
    | 'output-mismatch'
    | 'probe-timeout'
    | 'worker-create-failed'
    | 'worker-error'
    | 'worker-message-invalid';

export type MPEG2VC1ExactCapability = Readonly<{
    codec: MPEG2VC1Codec
    decodedFrameByteLength: number | null
    decodedFrameCount: number | null
    decodedI420Fingerprint: number | null
    decodedTotalByteLength: number | null
    reason: MPEG2VC1ExactCapabilityReason
    status: 'supported' | 'unsupported' | 'unknown'
}>;

type MPEG2VC1ExactCapabilityProbeWorkerEventListener = (event: Event) => void;

export type MPEG2VC1ExactCapabilityProbeWorker = {
    addEventListener: (
        type: 'error' | 'message' | 'messageerror',
        listener: MPEG2VC1ExactCapabilityProbeWorkerEventListener
    ) => void
    postMessage: (message: unknown, transfer: Transferable[]) => void
    removeEventListener: (
        type: 'error' | 'message' | 'messageerror',
        listener: MPEG2VC1ExactCapabilityProbeWorkerEventListener
    ) => void
    terminate: () => void
};

export type MPEG2VC1ExactCapabilityProbeEnvironment = Readonly<{
    clearTimeout: (timeout: ReturnType<typeof globalThis.setTimeout>) => void
    createWorker: (() => MPEG2VC1ExactCapabilityProbeWorker) | null
    // Downloads the decoder binary as bytes for the worker; without it the worker fetches the binary itself
    loadDecoderWASM?: ((url: string) => Promise<ArrayBuffer>) | null
    loadVector: (url: string) => Promise<ArrayBuffer>
    resolveAssetURL: (path: EngineAssetPath) => string
    runtimeAvailable: boolean
    setTimeout: (
        callback: () => void,
        milliseconds: number
    ) => ReturnType<typeof globalThis.setTimeout>
    // Downloads the worker script and decoder glue into the HTTP cache before the timed probe loads them
    warmAsset?: ((url: string) => Promise<void>) | null
}>;

type MPEG2VC1ExactCapabilityProbeAssets = Readonly<{
    decoderWASM: DecoderWASMSource
    vector: ArrayBuffer
}>;

function createDefaultWorker(): MPEG2VC1ExactCapabilityProbeWorker {
    const worker = createEngineWorker(MPEG2_VC1_EXACT_CAPABILITY_WORKER_ASSET);
    return worker as unknown as MPEG2VC1ExactCapabilityProbeWorker;
}

function createDefaultEnvironment(): MPEG2VC1ExactCapabilityProbeEnvironment {
    const runtimeAvailable = typeof globalThis.Worker === 'function'
        && typeof globalThis.WebAssembly === 'object'
        && typeof globalThis.fetch === 'function';
    return {
        clearTimeout: (timeout): void => globalThis.clearTimeout(timeout),
        createWorker: runtimeAvailable ? createDefaultWorker : null,
        loadDecoderWASM: fetchCapabilityAsset,
        loadVector: fetchCapabilityAsset,
        resolveAssetURL: resolveEngineAssetURL,
        runtimeAvailable,
        setTimeout: (callback, milliseconds): ReturnType<typeof globalThis.setTimeout> => (
            globalThis.setTimeout(callback, milliseconds)
        ),
        warmAsset: warmCapabilityAsset
    };
}

function responseMatchesQualification(
    response: MPEG2VC1ExactCapabilityWorkerResponse,
    qualification: MPEG2VC1Qualification
): boolean {
    return response.supported
        && response.reason === 'decode-output-verified'
        && response.requestID === qualification.requestID
        && response.codedHeight === qualification.codedHeight
        && response.codedWidth === qualification.codedWidth
        && response.decodedFrameByteLength === qualification.frameByteLength
        && response.decodedFrameCount === qualification.frameCount
        && response.decodedI420Fingerprint === qualification.fingerprint
        && response.decodedTotalByteLength === qualification.totalByteLength;
}

function createCapability(
    reason: MPEG2VC1ExactCapabilityReason,
    qualification: MPEG2VC1Qualification,
    response: MPEG2VC1ExactCapabilityWorkerResponse | null = null
): MPEG2VC1ExactCapability {
    const supported = response !== null
        && responseMatchesQualification(response, qualification);
    let status: MPEG2VC1ExactCapability['status'];
    if (supported) {
        status = 'supported';
    } else if (reason === 'api-unavailable' || reason === 'asset-unavailable' || reason === 'probe-timeout') {
        status = 'unknown';
    } else {
        status = 'unsupported';
    }
    const resolvedReason = reason === 'decode-output-verified' && !supported ?
        'output-mismatch' :
        reason;
    return Object.freeze({
        codec: qualification.codec,
        decodedFrameByteLength: response?.decodedFrameByteLength ?? null,
        decodedFrameCount: response?.decodedFrameCount ?? null,
        decodedI420Fingerprint: response?.decodedI420Fingerprint ?? null,
        decodedTotalByteLength: response?.decodedTotalByteLength ?? null,
        reason: resolvedReason,
        status
    });
}

/** Owns one cached, fail-closed exact-output probe for the MPEG-2 or VC-1 codec it is constructed with. */
export default class MPEG2VC1ExactCapabilityProbe {
    private cachedProbe: Promise<MPEG2VC1ExactCapability> | null = null;
    private preparedAssets: Promise<MPEG2VC1ExactCapabilityProbeAssets | null> | null = null;
    private readonly qualification: MPEG2VC1Qualification;

    public constructor(
        private readonly environment: MPEG2VC1ExactCapabilityProbeEnvironment =
        createDefaultEnvironment(),
        private readonly timeoutMilliseconds =
        MPEG2_VC1_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS,
        codec: MPEG2VC1Codec = 'mpeg2video'
    ) {
        if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
            throw new TypeError('The exact MPEG-2/VC-1 capability timeout is invalid');
        }
        this.qualification = getMPEG2VC1Qualification(
            codec === 'vc1' ?
                VC1_EXACT_CAPABILITY_REQUEST_ID :
                MPEG2_EXACT_CAPABILITY_REQUEST_ID
        );
    }

    /** Starts this probe's downloads; a probe run prepares every probe it selected, so their downloads overlap. */
    public prepare(): void {
        if (!this.environment.runtimeAvailable || !this.environment.createWorker) {
            return;
        }
        this.preparedAssets ??= this.loadAssets();
    }

    /** Returns the same immutable capability result for every call. */
    public probe(): Promise<MPEG2VC1ExactCapability> {
        this.cachedProbe ??= this.runProbe();
        return this.cachedProbe;
    }

    private async loadAssets(): Promise<MPEG2VC1ExactCapabilityProbeAssets | null> {
        const environment = this.environment;
        const vectorAsset = this.qualification.codec === 'vc1' ?
            VC1_VIDEO_QUALIFICATION_ASSET :
            MPEG2_VIDEO_QUALIFICATION_ASSET;
        try {
            const [ vector, decoderWASM ] = await Promise.all([
                environment.loadVector(environment.resolveAssetURL(vectorAsset)),
                loadDecoderWASMSource(
                    environment.resolveAssetURL(MPEG2_VC1_DECODER_WASM_ASSET),
                    environment.loadDecoderWASM
                ),
                environment.warmAsset?.(environment.resolveAssetURL(MPEG2_VC1_EXACT_CAPABILITY_WORKER_ASSET)),
                environment.warmAsset?.(environment.resolveAssetURL(MPEG2_VC1_DECODER_GLUE_ASSET))
            ]);
            return { decoderWASM, vector };
        } catch {
            return null;
        }
    }

    private async runProbe(): Promise<MPEG2VC1ExactCapability> {
        const createWorker = this.environment.createWorker;
        if (!this.environment.runtimeAvailable || !createWorker) {
            return createCapability('api-unavailable', this.qualification);
        }
        this.prepare();
        // The downloads finish before the decode timeout starts
        const assets = await this.preparedAssets;
        if (!assets) {
            return createCapability('asset-unavailable', this.qualification);
        }
        return this.runWorker(createWorker, assets);
    }

    private runWorker(
        createWorker: () => MPEG2VC1ExactCapabilityProbeWorker,
        assets: MPEG2VC1ExactCapabilityProbeAssets
    ): Promise<MPEG2VC1ExactCapability> {
        let worker: MPEG2VC1ExactCapabilityProbeWorker;
        try {
            worker = createWorker();
        } catch {
            return Promise.resolve(createCapability(
                'worker-create-failed',
                this.qualification
            ));
        }

        return new Promise<MPEG2VC1ExactCapability>((resolve): void => {
            let settled = false;
            let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
            const cleanup = (): void => {
                if (timeout !== null) {
                    this.environment.clearTimeout(timeout);
                    timeout = null;
                }
                worker.removeEventListener('message', messageHandler);
                worker.removeEventListener('error', errorHandler);
                worker.removeEventListener('messageerror', messageErrorHandler);
                try {
                    worker.terminate();
                } catch {
                    // Ownership ends even if the platform throws during termination
                }
            };
            const settle = (capability: MPEG2VC1ExactCapability): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve(capability);
            };
            const messageHandler: MPEG2VC1ExactCapabilityProbeWorkerEventListener = (
                event: Event
            ): void => {
                const value = (event as MessageEvent<unknown>).data;
                if (
                    !isMPEG2VC1ExactCapabilityWorkerResponse(value)
                    || value.requestID !== this.qualification.requestID
                ) {
                    settle(createCapability(
                        'worker-message-invalid',
                        this.qualification
                    ));
                    return;
                }
                settle(createCapability(value.reason, this.qualification, value));
            };
            const errorHandler: MPEG2VC1ExactCapabilityProbeWorkerEventListener = (): void => {
                settle(createCapability('worker-error', this.qualification));
            };
            const messageErrorHandler: MPEG2VC1ExactCapabilityProbeWorkerEventListener =
                (): void => {
                    settle(createCapability(
                        'worker-message-invalid',
                        this.qualification
                    ));
                };
            worker.addEventListener('message', messageHandler);
            worker.addEventListener('error', errorHandler);
            worker.addEventListener('messageerror', messageErrorHandler);
            timeout = this.environment.setTimeout((): void => {
                settle(createCapability('probe-timeout', this.qualification));
            }, this.timeoutMilliseconds);

            try {
                const request: MPEG2VC1ExactCapabilityWorkerRequest = {
                    decoderGlueURL: this.environment.resolveAssetURL(MPEG2_VC1_DECODER_GLUE_ASSET),
                    decoderWASM: assets.decoderWASM,
                    vector: assets.vector,
                    requestID: this.qualification.requestID,
                    type: 'probe'
                };
                worker.postMessage(request, [ assets.vector, ...getDecoderWASMTransfer(assets.decoderWASM) ]);
            } catch {
                settle(createCapability('worker-error', this.qualification));
            }
        });
    }
}

let defaultProbe: MPEG2VC1ExactCapabilityProbe | null = null;
let defaultVC1Probe: MPEG2VC1ExactCapabilityProbe | null = null;

function getDefaultMPEG2Probe(): MPEG2VC1ExactCapabilityProbe {
    defaultProbe ??= new MPEG2VC1ExactCapabilityProbe();
    return defaultProbe;
}

function getDefaultVC1Probe(): MPEG2VC1ExactCapabilityProbe {
    defaultVC1Probe ??= new MPEG2VC1ExactCapabilityProbe(
        createDefaultEnvironment(),
        MPEG2_VC1_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS,
        'vc1'
    );
    return defaultVC1Probe;
}

/** Qualifies and caches the bundled progressive MPEG-2 software route. */
export function probeMPEG2ExactCapability(): Promise<MPEG2VC1ExactCapability> {
    return getDefaultMPEG2Probe().probe();
}

/** Starts the MPEG-2 probe's downloads ahead of its turn. */
export function prepareMPEG2ExactCapability(): void {
    getDefaultMPEG2Probe().prepare();
}

/** Qualifies and caches the bundled progressive Advanced VC-1 software route. */
export function probeVC1ExactCapability(): Promise<MPEG2VC1ExactCapability> {
    return getDefaultVC1Probe().probe();
}

/** Starts the VC-1 probe's downloads ahead of its turn. */
export function prepareVC1ExactCapability(): void {
    getDefaultVC1Probe().prepare();
}
