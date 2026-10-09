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
    createHEVCExactCapabilityWorkerQualificationRequests
} from '../vectors/HEVCExactCapabilityVectors';
import {
    HEVC_EXACT_CAPABILITY_VECTORS,
    HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS,
    HEVC_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS,
    HEVC_EXACT_CAPABILITY_REQUEST_ID,
    isHEVCExactCapabilityWorkerResponse,
    type HEVCExactCapabilityVector,
    type HEVCExactCapabilityVectorDefinition,
    type HEVCExactCapabilityWorkerQualificationReason,
    type HEVCExactCapabilityWorkerQualificationResult,
    type HEVCExactCapabilityWorkerRequest,
    type HEVCExactCapabilityWorkerResponse
} from './HEVCExactCapabilityProtocol';

const HEVC_DECODER_GLUE_ASSET: EngineAssetPath = 'hevcjs/hevc-decode.js';
const HEVC_DECODER_WASM_ASSET: EngineAssetPath = 'hevcjs/hevc-decode.wasm';
const HEVC_MAIN10_4K_QUALIFICATION_ASSET: EngineAssetPath = 'hevcjs/main10-4k-qualification.bin';
const HEVC_EXACT_CAPABILITY_WORKER_ASSET: EngineWorkerPath = 'webgpu-player/HEVCExactCapabilityProbe.worker.js';

export type BundledHEVCExactCapabilityStatus = 'supported' | 'unsupported';
export type BundledHEVCExactCapabilityReason =
    | HEVCExactCapabilityWorkerQualificationReason
    | 'api-unavailable'
    | 'asset-unavailable'
    | 'probe-timeout'
    | 'worker-create-failed'
    | 'worker-error'
    | 'worker-message-invalid';

export type BundledHEVCExactQualification = Readonly<{
    bitDepth: 8 | 10
    codecString: HEVCExactCapabilityVectorDefinition['codecString']
    decodedFrameFingerprints?: readonly number[] | null
    decodedFrameCount?: number | null
    vector: HEVCExactCapabilityVector
    format: HEVCExactCapabilityVectorDefinition['format']
    profile: HEVCExactCapabilityVectorDefinition['profile']
    qualificationFrameCount?: number
    reason: BundledHEVCExactCapabilityReason
    status: BundledHEVCExactCapabilityStatus
    totalDecodedByteLength?: number | null
}>;

export type BundledHEVCExactCapabilities = Readonly<{
    qualifications: Readonly<Record<
        HEVCExactCapabilityVector,
        BundledHEVCExactQualification
    >>
    reason: 'complete' | 'failed' | 'partial' | 'unavailable'
}>;

type HEVCExactCapabilityProbeWorkerEventListener = (event: Event) => void;

export type HEVCExactCapabilityProbeWorker = {
    addEventListener: (
        type: 'error' | 'message' | 'messageerror',
        listener: HEVCExactCapabilityProbeWorkerEventListener
    ) => void
    postMessage: (message: unknown, transfer: Transferable[]) => void
    removeEventListener: (
        type: 'error' | 'message' | 'messageerror',
        listener: HEVCExactCapabilityProbeWorkerEventListener
    ) => void
    terminate: () => void
};

export type HEVCExactCapabilityProbeEnvironment = Readonly<{
    clearTimeout: (timeout: ReturnType<typeof globalThis.setTimeout>) => void
    createWorker: (() => HEVCExactCapabilityProbeWorker) | null
    // Downloads the decoder binary as bytes for the worker; without it the worker fetches the binary itself
    loadDecoderWASM?: ((url: string) => Promise<ArrayBuffer>) | null
    loadQualificationBitstream: (url: string) => Promise<ArrayBuffer>
    resolveAssetURL: (path: EngineAssetPath) => string
    runtimeAvailable: boolean
    setTimeout: (
        callback: () => void,
        milliseconds: number
    ) => ReturnType<typeof globalThis.setTimeout>
    // Downloads the worker script and decoder glue into the HTTP cache before the timed probe loads them
    warmAsset?: ((url: string) => Promise<void>) | null
}>;

type HEVCExactCapabilityProbeAssets = Readonly<{
    decoderWASM: DecoderWASMSource
    qualificationBitstream: ArrayBuffer
}>;

function createDefaultWorker(): HEVCExactCapabilityProbeWorker {
    const worker = createEngineWorker(HEVC_EXACT_CAPABILITY_WORKER_ASSET);
    return worker as unknown as HEVCExactCapabilityProbeWorker;
}

function createDefaultEnvironment(): HEVCExactCapabilityProbeEnvironment {
    const runtimeAvailable = typeof globalThis.Worker === 'function'
        && typeof globalThis.WebAssembly === 'object'
        && typeof globalThis.atob === 'function'
        && typeof globalThis.fetch === 'function';
    return {
        clearTimeout: (timeout): void => globalThis.clearTimeout(timeout),
        createWorker: runtimeAvailable ? createDefaultWorker : null,
        loadDecoderWASM: fetchCapabilityAsset,
        loadQualificationBitstream: fetchCapabilityAsset,
        resolveAssetURL: resolveEngineAssetURL,
        runtimeAvailable,
        setTimeout: (callback, milliseconds): ReturnType<typeof globalThis.setTimeout> => (
            globalThis.setTimeout(callback, milliseconds)
        ),
        warmAsset: warmCapabilityAsset
    };
}

function getExpectedDecodedByteLength(
    definition: HEVCExactCapabilityVectorDefinition
): number {
    const chromaWidth = Math.ceil(definition.codedWidth / 2);
    const chromaHeight = Math.ceil(definition.codedHeight / 2);
    return (
        (definition.codedWidth * definition.codedHeight)
        + (2 * chromaWidth * chromaHeight)
    ) * Uint16Array.BYTES_PER_ELEMENT;
}

function createQualification(
    definition: HEVCExactCapabilityVectorDefinition,
    reason: BundledHEVCExactCapabilityReason,
    result: HEVCExactCapabilityWorkerQualificationResult | null = null
): BundledHEVCExactQualification {
    return Object.freeze({
        bitDepth: definition.bitDepth,
        codecString: definition.codecString,
        decodedFrameFingerprints: result?.decodedFrameFingerprints ?? null,
        decodedFrameCount: result?.decodedFrameCount ?? null,
        vector: definition.vector,
        format: definition.format,
        profile: definition.profile,
        qualificationFrameCount: definition.qualificationFrameCount,
        reason,
        status: reason === 'decode-output-verified' ? 'supported' : 'unsupported',
        totalDecodedByteLength: result?.totalDecodedByteLength ?? null
    });
}

function createCapabilities(
    qualificationResults: readonly BundledHEVCExactQualification[],
    unavailable = false
): BundledHEVCExactCapabilities {
    const mainQualification = qualificationResults.find(
        qualification => qualification.vector === 'main-1080p'
    );
    const main10FullHDQualification = qualificationResults.find(
        qualification => qualification.vector === 'main10-1080p'
    );
    const main10UltraHDQualification = qualificationResults.find(
        qualification => qualification.vector === 'main10-4k'
    );
    if (
        !mainQualification
        || !main10FullHDQualification
        || !main10UltraHDQualification
    ) {
        throw new TypeError('An exact HEVC qualification result is missing');
    }
    const qualifications = Object.freeze({
        'main-1080p': mainQualification,
        'main10-1080p': main10FullHDQualification,
        'main10-4k': main10UltraHDQualification
    });
    const supportedCount = qualificationResults.filter(
        qualification => qualification.status === 'supported'
    ).length;
    let reason: BundledHEVCExactCapabilities['reason'];
    if (unavailable) {
        reason = 'unavailable';
    } else if (supportedCount === qualificationResults.length) {
        reason = 'complete';
    } else if (supportedCount > 0) {
        reason = 'partial';
    } else {
        reason = 'failed';
    }
    return Object.freeze({ qualifications, reason });
}

function createUniformFailureCapabilities(
    reason: Exclude<
        BundledHEVCExactCapabilityReason,
        HEVCExactCapabilityWorkerQualificationReason
    >
): BundledHEVCExactCapabilities {
    const qualifications: BundledHEVCExactQualification[] = [];
    for (const vector of HEVC_EXACT_CAPABILITY_VECTORS) {
        qualifications.push(createQualification(
            HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS[vector],
            reason
        ));
    }
    return createCapabilities(qualifications, reason === 'api-unavailable');
}

function workerResultMatchesDefinition(
    result: HEVCExactCapabilityWorkerQualificationResult,
    definition: HEVCExactCapabilityVectorDefinition
): boolean {
    return result.supported
        && result.reason === 'decode-output-verified'
        && result.bitDepth === definition.bitDepth
        && result.chromaHeight === Math.ceil(definition.codedHeight / 2)
        && result.chromaWidth === Math.ceil(definition.codedWidth / 2)
        && result.codedHeight === definition.codedHeight
        && result.codedWidth === definition.codedWidth
        && result.decodedFrameFingerprints !== null
        && result.decodedFrameFingerprints.length
            === definition.decodedFrameFingerprints.length
        && result.decodedFrameFingerprints.every((fingerprint, frameIndex) => (
            fingerprint === definition.decodedFrameFingerprints[frameIndex]
        ))
        && result.decodedFrameCount === definition.qualificationFrameCount
        && result.decodedByteLength === getExpectedDecodedByteLength(definition)
        && result.levelIDC === definition.levelIDC
        && result.profileIDC === definition.profileIDC
        && result.totalDecodedByteLength === getExpectedDecodedByteLength(definition)
            * definition.qualificationFrameCount;
}

function createCapabilitiesFromResponse(
    response: HEVCExactCapabilityWorkerResponse
): BundledHEVCExactCapabilities {
    const qualifications: BundledHEVCExactQualification[] = [];
    for (const vector of HEVC_EXACT_CAPABILITY_VECTORS) {
        const definition = HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS[vector];
        const result = response.results.find(candidate => candidate.vector === vector);
        if (!result) {
            return createUniformFailureCapabilities('worker-message-invalid');
        }
        if (result.supported && !workerResultMatchesDefinition(result, definition)) {
            qualifications.push(createQualification(
                definition,
                'output-mismatch',
                result
            ));
            continue;
        }
        qualifications.push(createQualification(
            definition,
            result.reason,
            result
        ));
    }
    return createCapabilities(qualifications);
}

/** Owns one cached, fail-closed exact bundled HEVC capability qualification. */
export class BundledHEVCExactCapabilityProbe {
    private cachedProbe: Promise<BundledHEVCExactCapabilities> | null = null;
    private preparedAssets: Promise<HEVCExactCapabilityProbeAssets | null> | null = null;

    public constructor(
        private readonly environment: HEVCExactCapabilityProbeEnvironment =
        createDefaultEnvironment(),
        private readonly timeoutMilliseconds =
        HEVC_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS
    ) {
        if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
            throw new TypeError('The exact HEVC capability timeout is invalid');
        }
    }

    /** Starts this probe's downloads; a probe run prepares every probe it selected, so their downloads overlap. */
    public prepare(): void {
        if (!this.environment.runtimeAvailable || !this.environment.createWorker) {
            return;
        }
        this.preparedAssets ??= this.loadAssets();
    }

    /** Returns the same immutable result promise for all calls in this runtime. */
    public probe(): Promise<BundledHEVCExactCapabilities> {
        this.cachedProbe ??= this.runProbe();
        return this.cachedProbe;
    }

    private async loadAssets(): Promise<HEVCExactCapabilityProbeAssets | null> {
        const environment = this.environment;
        try {
            const [ qualificationBitstream, decoderWASM ] = await Promise.all([
                environment.loadQualificationBitstream(
                    environment.resolveAssetURL(HEVC_MAIN10_4K_QUALIFICATION_ASSET)
                ),
                loadDecoderWASMSource(
                    environment.resolveAssetURL(HEVC_DECODER_WASM_ASSET),
                    environment.loadDecoderWASM
                ),
                environment.warmAsset?.(environment.resolveAssetURL(HEVC_EXACT_CAPABILITY_WORKER_ASSET)),
                environment.warmAsset?.(environment.resolveAssetURL(HEVC_DECODER_GLUE_ASSET))
            ]);
            return { decoderWASM, qualificationBitstream };
        } catch {
            return null;
        }
    }

    private async runProbe(): Promise<BundledHEVCExactCapabilities> {
        const createWorker = this.environment.createWorker;
        if (!this.environment.runtimeAvailable || !createWorker) {
            return createUniformFailureCapabilities('api-unavailable');
        }
        this.prepare();
        // The downloads finish before the decode timeout starts
        const assets = await this.preparedAssets;
        if (!assets) {
            return createUniformFailureCapabilities('asset-unavailable');
        }
        return this.runWorker(createWorker, assets);
    }

    private runWorker(
        createWorker: () => HEVCExactCapabilityProbeWorker,
        assets: HEVCExactCapabilityProbeAssets
    ): Promise<BundledHEVCExactCapabilities> {
        let worker: HEVCExactCapabilityProbeWorker;
        try {
            worker = createWorker();
        } catch {
            return Promise.resolve(createUniformFailureCapabilities('worker-create-failed'));
        }

        return new Promise<BundledHEVCExactCapabilities>((resolve): void => {
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
            const settle = (capabilities: BundledHEVCExactCapabilities): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve(capabilities);
            };
            const messageHandler: HEVCExactCapabilityProbeWorkerEventListener = (
                event: Event
            ): void => {
                const value = (event as MessageEvent<unknown>).data;
                if (!isHEVCExactCapabilityWorkerResponse(value)) {
                    settle(createUniformFailureCapabilities('worker-message-invalid'));
                    return;
                }
                settle(createCapabilitiesFromResponse(value));
            };
            const errorHandler: HEVCExactCapabilityProbeWorkerEventListener = (): void => {
                settle(createUniformFailureCapabilities('worker-error'));
            };
            const messageErrorHandler: HEVCExactCapabilityProbeWorkerEventListener = (): void => {
                settle(createUniformFailureCapabilities('worker-message-invalid'));
            };

            worker.addEventListener('message', messageHandler);
            worker.addEventListener('error', errorHandler);
            worker.addEventListener('messageerror', messageErrorHandler);
            timeout = this.environment.setTimeout((): void => {
                settle(createUniformFailureCapabilities('probe-timeout'));
            }, this.timeoutMilliseconds);

            try {
                const qualifications = createHEVCExactCapabilityWorkerQualificationRequests(
                    assets.qualificationBitstream
                );
                const request: HEVCExactCapabilityWorkerRequest = {
                    decoderGlueURL: this.environment.resolveAssetURL(HEVC_DECODER_GLUE_ASSET),
                    decoderWASM: assets.decoderWASM,
                    requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
                    qualifications,
                    type: 'probe'
                };
                const transfer: Transferable[] = getDecoderWASMTransfer(assets.decoderWASM);
                for (const qualification of qualifications) {
                    transfer.push(qualification.accessUnit);
                    transfer.push(...qualification.qualificationAccessUnits);
                }
                worker.postMessage(request, transfer);
            } catch {
                settle(createUniformFailureCapabilities('worker-error'));
            }
        });
    }
}

let defaultProbe: BundledHEVCExactCapabilityProbe | null = null;

/** Qualifies and caches exact bundled HEVC output vectors. */
export function probeBundledHEVCExactCapabilities(): Promise<BundledHEVCExactCapabilities> {
    defaultProbe ??= new BundledHEVCExactCapabilityProbe();
    return defaultProbe.probe();
}

/** Starts the exact bundled HEVC probe's downloads ahead of its turn. */
export function prepareBundledHEVCExactCapabilities(): void {
    defaultProbe ??= new BundledHEVCExactCapabilityProbe();
    defaultProbe.prepare();
}
