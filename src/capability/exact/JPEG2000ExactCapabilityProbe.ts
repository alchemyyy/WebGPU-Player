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
    isJPEG2000ExactCapabilityWorkerResponse,
    JPEG2000_EXACT_CAPABILITY_REQUEST_ID,
    JPEG2000_QUALIFICATION_CODED_HEIGHT,
    JPEG2000_QUALIFICATION_CODED_WIDTH,
    JPEG2000_QUALIFICATION_RGBA_BYTE_LENGTH,
    JPEG2000_QUALIFICATION_RGBA_FINGERPRINT,
    type JPEG2000ExactCapabilityWorkerRequest,
    type JPEG2000ExactCapabilityWorkerResponse
} from './JPEG2000ExactCapabilityProtocol';

export {
    isJPEG2000ExactCapabilityWorkerRequest,
    isJPEG2000ExactCapabilityWorkerResponse,
    JPEG2000_EXACT_CAPABILITY_REQUEST_ID,
    JPEG2000_QUALIFICATION_CODED_HEIGHT,
    JPEG2000_QUALIFICATION_CODED_WIDTH,
    JPEG2000_QUALIFICATION_RGBA_BYTE_LENGTH,
    JPEG2000_QUALIFICATION_RGBA_FINGERPRINT,
    type JPEG2000ExactCapabilityWorkerRequest,
    type JPEG2000ExactCapabilityWorkerResponse
} from './JPEG2000ExactCapabilityProtocol';
export const JPEG2000_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS = 2_000;

const JPEG2000_DECODER_GLUE_ASSET: EngineAssetPath = 'openjpeg/openjpeg-decode.js';
const JPEG2000_DECODER_WASM_ASSET: EngineAssetPath = 'openjpeg/openjpeg-decode.wasm';
const JPEG2000_QUALIFICATION_ASSET: EngineAssetPath = 'openjpeg/jpeg2000-960x540-qualification.bin';
const JPEG2000_EXACT_CAPABILITY_WORKER_ASSET: EngineWorkerPath = 'webgpu-player/JPEG2000ExactCapabilityProbe.worker.js';

export type JPEG2000ExactCapabilityReason =
    | 'api-unavailable'
    | 'asset-unavailable'
    | 'decode-error'
    | 'decode-output-verified'
    | 'output-mismatch'
    | 'probe-timeout'
    | 'worker-create-failed'
    | 'worker-error'
    | 'worker-message-invalid';

export type JPEG2000ExactCapability = Readonly<{
    bitDepth: 8
    codec: 'jpeg2000'
    codecString: 'mjp2'
    decodedRGBAByteLength: number | null
    decodedRGBAFingerprint: number | null
    reason: JPEG2000ExactCapabilityReason
    status: 'supported' | 'unsupported' | 'unknown'
}>;

type JPEG2000ExactCapabilityProbeWorkerEventListener = (event: Event) => void;

export type JPEG2000ExactCapabilityProbeWorker = {
    addEventListener: (type: 'error' | 'message' | 'messageerror', listener: JPEG2000ExactCapabilityProbeWorkerEventListener) => void
    postMessage: (message: unknown, transfer: Transferable[]) => void
    removeEventListener: (type: 'error' | 'message' | 'messageerror', listener: JPEG2000ExactCapabilityProbeWorkerEventListener) => void
    terminate: () => void
};

export type JPEG2000ExactCapabilityProbeEnvironment = Readonly<{
    clearTimeout: (timeout: ReturnType<typeof globalThis.setTimeout>) => void
    createWorker: (() => JPEG2000ExactCapabilityProbeWorker) | null
    // Downloads the decoder binary as bytes for the worker; without it the worker fetches the binary itself
    loadDecoderWASM?: ((url: string) => Promise<ArrayBuffer>) | null
    loadVector: (url: string) => Promise<ArrayBuffer>
    resolveAssetURL: (path: EngineAssetPath) => string
    runtimeAvailable: boolean
    setTimeout: (callback: () => void, milliseconds: number) => ReturnType<typeof globalThis.setTimeout>
    // Downloads the worker script and decoder glue into the HTTP cache before the timed probe loads them
    warmAsset?: ((url: string) => Promise<void>) | null
}>;

type JPEG2000ExactCapabilityProbeAssets = Readonly<{
    decoderWASM: DecoderWASMSource
    vector: ArrayBuffer
}>;

function createDefaultWorker(): JPEG2000ExactCapabilityProbeWorker {
    const worker = createEngineWorker(JPEG2000_EXACT_CAPABILITY_WORKER_ASSET);
    return worker as unknown as JPEG2000ExactCapabilityProbeWorker;
}

function createDefaultEnvironment(): JPEG2000ExactCapabilityProbeEnvironment {
    // eslint-disable-next-line compat/compat -- The exact capability probe gates this route
    const videoFrameAvailable = typeof globalThis.VideoFrame === 'function';
    const runtimeAvailable = typeof globalThis.Worker === 'function'
        && typeof globalThis.WebAssembly === 'object'
        && typeof globalThis.fetch === 'function'
        && videoFrameAvailable;
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

function createCapability(
    reason: JPEG2000ExactCapabilityReason,
    response: JPEG2000ExactCapabilityWorkerResponse | null = null
): JPEG2000ExactCapability {
    const exactOutputMatches = response !== null
        && response.codedHeight === JPEG2000_QUALIFICATION_CODED_HEIGHT
        && response.codedWidth === JPEG2000_QUALIFICATION_CODED_WIDTH
        && response.decodedRGBAByteLength === JPEG2000_QUALIFICATION_RGBA_BYTE_LENGTH
        && response.decodedRGBAFingerprint === JPEG2000_QUALIFICATION_RGBA_FINGERPRINT;
    const supported = reason === 'decode-output-verified' && response?.supported === true && exactOutputMatches;
    let status: JPEG2000ExactCapability['status'];
    if (supported) {
        status = 'supported';
    } else if (reason === 'api-unavailable' || reason === 'asset-unavailable' || reason === 'probe-timeout') {
        status = 'unknown';
    } else {
        status = 'unsupported';
    }
    let resolvedReason = reason;
    if (supported) {
        resolvedReason = 'decode-output-verified';
    } else if (reason === 'decode-output-verified') {
        resolvedReason = 'output-mismatch';
    }
    return Object.freeze({
        bitDepth: 8,
        codec: 'jpeg2000',
        codecString: 'mjp2',
        decodedRGBAByteLength: response?.decodedRGBAByteLength ?? null,
        decodedRGBAFingerprint: response?.decodedRGBAFingerprint ?? null,
        reason: resolvedReason,
        status
    });
}

/** Owns one cached, fail-closed OpenJPEG exact-output probe. */
export default class JPEG2000ExactCapabilityProbe {
    private cachedProbe: Promise<JPEG2000ExactCapability> | null = null;
    private preparedAssets: Promise<JPEG2000ExactCapabilityProbeAssets | null> | null = null;

    public constructor(
        private readonly environment: JPEG2000ExactCapabilityProbeEnvironment = createDefaultEnvironment(),
        private readonly timeoutMilliseconds = JPEG2000_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS
    ) {
        if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
            throw new TypeError('The exact JPEG 2000 capability timeout is invalid');
        }
    }

    /** Starts this probe's downloads; a probe run prepares every probe it selected, so their downloads overlap. */
    public prepare(): void {
        if (!this.environment.runtimeAvailable || !this.environment.createWorker) {
            return;
        }
        this.preparedAssets ??= this.loadAssets();
    }

    /** Returns the same immutable capability result for every call. */
    public probe(): Promise<JPEG2000ExactCapability> {
        this.cachedProbe ??= this.runProbe();
        return this.cachedProbe;
    }

    private async loadAssets(): Promise<JPEG2000ExactCapabilityProbeAssets | null> {
        const environment = this.environment;
        try {
            const [ vector, decoderWASM ] = await Promise.all([
                environment.loadVector(environment.resolveAssetURL(JPEG2000_QUALIFICATION_ASSET)),
                loadDecoderWASMSource(environment.resolveAssetURL(JPEG2000_DECODER_WASM_ASSET), environment.loadDecoderWASM),
                environment.warmAsset?.(environment.resolveAssetURL(JPEG2000_EXACT_CAPABILITY_WORKER_ASSET)),
                environment.warmAsset?.(environment.resolveAssetURL(JPEG2000_DECODER_GLUE_ASSET))
            ]);
            return { decoderWASM, vector };
        } catch {
            return null;
        }
    }

    private async runProbe(): Promise<JPEG2000ExactCapability> {
        const createWorker = this.environment.createWorker;
        if (!this.environment.runtimeAvailable || !createWorker) {
            return createCapability('api-unavailable');
        }
        this.prepare();
        // The downloads finish before the decode timeout starts
        const assets = await this.preparedAssets;
        if (!assets) {
            return createCapability('asset-unavailable');
        }
        return this.runWorker(createWorker, assets);
    }

    private runWorker(
        createWorker: () => JPEG2000ExactCapabilityProbeWorker,
        assets: JPEG2000ExactCapabilityProbeAssets
    ): Promise<JPEG2000ExactCapability> {
        let worker: JPEG2000ExactCapabilityProbeWorker;
        try {
            worker = createWorker();
        } catch {
            return Promise.resolve(createCapability('worker-create-failed'));
        }

        return new Promise<JPEG2000ExactCapability>((resolve): void => {
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
                    // Ownership ends even when a platform worker throws during termination
                }
            };
            const settle = (capability: JPEG2000ExactCapability): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve(capability);
            };
            const messageHandler: JPEG2000ExactCapabilityProbeWorkerEventListener = (event: Event): void => {
                const value = (event as MessageEvent<unknown>).data;
                if (!isJPEG2000ExactCapabilityWorkerResponse(value)) {
                    settle(createCapability('worker-message-invalid'));
                    return;
                }
                settle(createCapability(value.reason, value));
            };
            const errorHandler: JPEG2000ExactCapabilityProbeWorkerEventListener = (): void => {
                settle(createCapability('worker-error'));
            };
            const messageErrorHandler: JPEG2000ExactCapabilityProbeWorkerEventListener = (): void => {
                settle(createCapability('worker-message-invalid'));
            };
            worker.addEventListener('message', messageHandler);
            worker.addEventListener('error', errorHandler);
            worker.addEventListener('messageerror', messageErrorHandler);
            timeout = this.environment.setTimeout((): void => {
                settle(createCapability('probe-timeout'));
            }, this.timeoutMilliseconds);

            try {
                const request: JPEG2000ExactCapabilityWorkerRequest = {
                    decoderGlueURL: this.environment.resolveAssetURL(JPEG2000_DECODER_GLUE_ASSET),
                    decoderWASM: assets.decoderWASM,
                    vector: assets.vector,
                    requestID: JPEG2000_EXACT_CAPABILITY_REQUEST_ID,
                    type: 'probe'
                };
                worker.postMessage(request, [ assets.vector, ...getDecoderWASMTransfer(assets.decoderWASM) ]);
            } catch {
                settle(createCapability('worker-error'));
            }
        });
    }
}

let defaultProbe: JPEG2000ExactCapabilityProbe | null = null;

/** Qualifies and caches the pinned OpenJPEG software route. */
export function probeJPEG2000ExactCapability(): Promise<JPEG2000ExactCapability> {
    defaultProbe ??= new JPEG2000ExactCapabilityProbe();
    return defaultProbe.probe();
}

/** Starts the OpenJPEG probe's downloads ahead of its turn. */
export function prepareJPEG2000ExactCapability(): void {
    defaultProbe ??= new JPEG2000ExactCapabilityProbe();
    defaultProbe.prepare();
}
