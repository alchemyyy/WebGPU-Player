import {
    getDecoderWASMTransfer,
    loadDecoderWASMSource,
    type DecoderWASMSource
} from '../../DecoderWASMSource';
import {
    createEngineWorker,
    DTS_DECODER_WASM_ASSET,
    resolveEngineAssetURL,
    type EngineAssetPath,
    type EngineWorkerPath
} from '../../EngineAssets';
import { fetchCapabilityAsset, warmCapabilityAsset } from '../CapabilityAssetLoading';
import {
    DTS_EXACT_CAPABILITY_REQUEST_ID,
    DTS_QUALIFICATION_VECTOR_COUNT,
    DTS_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR,
    DTS_QUALIFICATION_PROFILE_MASK,
    isDTSExactCapabilityWorkerResponse,
    type DTSExactCapabilityWorkerRequest,
    type DTSExactCapabilityWorkerResponse
} from './DTSExactCapabilityProtocol';

export const DTS_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS = 4_000;
const DTS_EXACT_CAPABILITY_WORKER_ASSET: EngineWorkerPath = 'webgpu-player/DTSExactCapabilityProbe.worker.js';
const DTS_QUALIFIED_PROFILES = Object.freeze([
    'core',
    'core-96-24',
    'es',
    'hd-hra',
    'hd-ma'
] as const);
const DTS_QUALIFIED_SAMPLE_RATES = Object.freeze([ 48_000, 96_000, 192_000 ] as const);

export type DTSExactCapabilityReason =
    | 'api-unavailable'
    | 'asset-unavailable'
    | DTSExactCapabilityWorkerResponse['reason']
    | 'probe-timeout'
    | 'worker-create-failed'
    | 'worker-error'
    | 'worker-message-invalid';

export type DTSExactCapability = Readonly<{
    channelBedOnly: true
    codec: 'dts'
    codecString: 'dts'
    decodeMilliseconds: number | null
    libraryVersion: number | null
    maximumChannelCount: 8
    measuredRealTimeFactor: number | null
    objectAudioRendered: false
    profiles: readonly [ 'core', 'core-96-24', 'es', 'hd-hra', 'hd-ma' ]
    reason: DTSExactCapabilityReason
    sampleRates: readonly [ 48_000, 96_000, 192_000 ]
    status: 'supported' | 'unsupported' | 'unknown'
    verifiedVectorCount: number
    verifiedProfileMask: number
}>;

type DTSExactCapabilityProbeWorkerEventListener = (event: Event) => void;

export type DTSExactCapabilityProbeWorker = {
    addEventListener: (
        type: 'error' | 'message' | 'messageerror',
        listener: DTSExactCapabilityProbeWorkerEventListener
    ) => void
    postMessage: (message: unknown, transfer: Transferable[]) => void
    removeEventListener: (
        type: 'error' | 'message' | 'messageerror',
        listener: DTSExactCapabilityProbeWorkerEventListener
    ) => void
    terminate: () => void
};

export type DTSExactCapabilityProbeEnvironment = Readonly<{
    clearTimeout: (timeout: ReturnType<typeof globalThis.setTimeout>) => void
    createWorker: (() => DTSExactCapabilityProbeWorker) | null
    // Downloads the decoder binary as bytes for the worker; without it the worker fetches the binary itself
    loadDecoderWASM?: ((url: string) => Promise<ArrayBuffer>) | null
    resolveAssetURL: (path: EngineAssetPath) => string
    runtimeAvailable: boolean
    setTimeout: (
        callback: () => void,
        milliseconds: number
    ) => ReturnType<typeof globalThis.setTimeout>
    // Downloads the worker script into the HTTP cache before the timed probe loads it
    warmAsset?: ((url: string) => Promise<void>) | null
}>;

function createDefaultWorker(): DTSExactCapabilityProbeWorker {
    const worker = createEngineWorker(DTS_EXACT_CAPABILITY_WORKER_ASSET);
    return worker as unknown as DTSExactCapabilityProbeWorker;
}

function createDefaultEnvironment(): DTSExactCapabilityProbeEnvironment {
    const runtimeAvailable = typeof globalThis.Worker === 'function'
        && typeof globalThis.WebAssembly === 'object'
        && typeof globalThis.atob === 'function';
    return {
        clearTimeout: timeout => globalThis.clearTimeout(timeout),
        createWorker: runtimeAvailable ? createDefaultWorker : null,
        loadDecoderWASM: typeof globalThis.fetch === 'function' ? fetchCapabilityAsset : null,
        resolveAssetURL: resolveEngineAssetURL,
        runtimeAvailable,
        setTimeout: (callback, milliseconds): ReturnType<typeof globalThis.setTimeout> => (
            globalThis.setTimeout(callback, milliseconds)
        ),
        warmAsset: typeof globalThis.fetch === 'function' ? warmCapabilityAsset : null
    };
}

function createCapability(
    reason: DTSExactCapabilityReason,
    response: DTSExactCapabilityWorkerResponse | null = null
): DTSExactCapability {
    const exactOutputMatches = response !== null
        && response.verifiedVectorCount === DTS_QUALIFICATION_VECTOR_COUNT
        && response.verifiedProfileMask === DTS_QUALIFICATION_PROFILE_MASK;
    const exactThroughputMatches = response?.measuredRealTimeFactor !== null
        && response?.measuredRealTimeFactor !== undefined
        && response.measuredRealTimeFactor >= DTS_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR;
    const supported = reason === 'decode-output-verified'
        && response?.supported === true
        && exactOutputMatches
        && exactThroughputMatches;
    let status: DTSExactCapability['status'];
    if (supported) {
        status = 'supported';
    } else if (reason === 'api-unavailable' || reason === 'asset-unavailable' || reason === 'probe-timeout') {
        status = 'unknown';
    } else {
        status = 'unsupported';
    }
    let resolvedReason: DTSExactCapabilityReason = reason;
    if (supported) {
        resolvedReason = 'decode-output-verified';
    } else if (reason === 'decode-output-verified') {
        resolvedReason = 'output-mismatch';
    }
    return Object.freeze({
        channelBedOnly: true,
        codec: 'dts',
        codecString: 'dts',
        decodeMilliseconds: response?.decodeMilliseconds ?? null,
        libraryVersion: response?.libraryVersion ?? null,
        maximumChannelCount: 8,
        measuredRealTimeFactor: response?.measuredRealTimeFactor ?? null,
        objectAudioRendered: false,
        profiles: DTS_QUALIFIED_PROFILES,
        reason: resolvedReason,
        sampleRates: DTS_QUALIFIED_SAMPLE_RATES,
        status,
        verifiedVectorCount: response?.verifiedVectorCount ?? 0,
        verifiedProfileMask: response?.verifiedProfileMask ?? 0
    });
}

/** Owns one cached, fail-closed libdcadec output and throughput probe. */
export default class DTSExactCapabilityProbe {
    private cachedProbe: Promise<DTSExactCapability> | null = null;
    private preparedDecoderWASM: Promise<DecoderWASMSource | null> | null = null;

    public constructor(
        private readonly environment: DTSExactCapabilityProbeEnvironment =
        createDefaultEnvironment(),
        private readonly timeoutMilliseconds =
        DTS_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS
    ) {
        if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
            throw new TypeError('The exact DTS capability timeout is invalid');
        }
    }

    /** Starts this probe's downloads; a probe run prepares every probe it selected, so their downloads overlap. */
    public prepare(): void {
        if (!this.environment.runtimeAvailable || !this.environment.createWorker) {
            return;
        }
        this.preparedDecoderWASM ??= this.loadAssets();
    }

    /** Returns the same immutable capability result for every call. */
    public probe(): Promise<DTSExactCapability> {
        this.cachedProbe ??= this.runProbe();
        return this.cachedProbe;
    }

    private async loadAssets(): Promise<DecoderWASMSource | null> {
        const environment = this.environment;
        try {
            const [ decoderWASM ] = await Promise.all([
                loadDecoderWASMSource(
                    environment.resolveAssetURL(DTS_DECODER_WASM_ASSET),
                    environment.loadDecoderWASM
                ),
                environment.warmAsset?.(environment.resolveAssetURL(DTS_EXACT_CAPABILITY_WORKER_ASSET))
            ]);
            return decoderWASM;
        } catch {
            return null;
        }
    }

    private async runProbe(): Promise<DTSExactCapability> {
        const createWorker = this.environment.createWorker;
        if (!this.environment.runtimeAvailable || !createWorker) {
            return createCapability('api-unavailable');
        }
        this.prepare();
        // The downloads finish before the decode timeout starts, which also keeps them out of the throughput measurement
        const decoderWASM = await this.preparedDecoderWASM;
        if (!decoderWASM) {
            return createCapability('asset-unavailable');
        }
        return this.runWorker(createWorker, decoderWASM);
    }

    private runWorker(
        createWorker: () => DTSExactCapabilityProbeWorker,
        decoderWASM: DecoderWASMSource
    ): Promise<DTSExactCapability> {
        let worker: DTSExactCapabilityProbeWorker;
        try {
            worker = createWorker();
        } catch {
            return Promise.resolve(createCapability('worker-create-failed'));
        }

        return new Promise<DTSExactCapability>((resolve): void => {
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
                    // Ownership ends even when termination fails
                }
            };
            const settle = (capability: DTSExactCapability): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve(capability);
            };
            const messageHandler: DTSExactCapabilityProbeWorkerEventListener = (
                event: Event
            ): void => {
                const value = (event as MessageEvent<unknown>).data;
                if (!isDTSExactCapabilityWorkerResponse(value)) {
                    settle(createCapability('worker-message-invalid'));
                    return;
                }
                settle(createCapability(value.reason, value));
            };
            const errorHandler: DTSExactCapabilityProbeWorkerEventListener = (): void => {
                settle(createCapability('worker-error'));
            };
            const messageErrorHandler: DTSExactCapabilityProbeWorkerEventListener = (): void => {
                settle(createCapability('worker-message-invalid'));
            };
            worker.addEventListener('message', messageHandler);
            worker.addEventListener('error', errorHandler);
            worker.addEventListener('messageerror', messageErrorHandler);
            timeout = this.environment.setTimeout((): void => {
                settle(createCapability('probe-timeout'));
            }, this.timeoutMilliseconds);

            const request: DTSExactCapabilityWorkerRequest = {
                decoderWASM,
                requestID: DTS_EXACT_CAPABILITY_REQUEST_ID,
                type: 'probe'
            };
            try {
                worker.postMessage(request, getDecoderWASMTransfer(decoderWASM));
            } catch {
                settle(createCapability('worker-error'));
            }
        });
    }
}

let defaultProbe: DTSExactCapabilityProbe | null = null;

/** Qualifies and caches the pinned libdcadec DTS-family route. */
export function probeDTSExactCapability(): Promise<DTSExactCapability> {
    defaultProbe ??= new DTSExactCapabilityProbe();
    return defaultProbe.probe();
}

/** Starts the libdcadec probe's downloads ahead of its turn. */
export function prepareDTSExactCapability(): void {
    defaultProbe ??= new DTSExactCapabilityProbe();
    defaultProbe.prepare();
}
