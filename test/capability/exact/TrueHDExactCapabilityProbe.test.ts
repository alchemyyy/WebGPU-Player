import { describe, expect, it, vi } from 'vitest';

import { TRUEHD_DECODER_WASM_ASSET } from 'webgpu-player/EngineAssets';
import TrueHDExactCapabilityProbe, {
    type TrueHDExactCapabilityProbeEnvironment,
    type TrueHDExactCapabilityProbeWorker
} from 'webgpu-player/capability/exact/TrueHDExactCapabilityProbe';
import {
    TRUEHD_EXACT_CAPABILITY_REQUEST_ID,
    TRUEHD_QUALIFICATION_CHANNEL_COUNT_MASK,
    TRUEHD_QUALIFICATION_CODEC_MASK,
    TRUEHD_QUALIFICATION_VECTOR_COUNT,
    TRUEHD_QUALIFICATION_SAMPLE_RATE_MASK,
    isTrueHDExactCapabilityWorkerRequest,
    isTrueHDExactCapabilityWorkerResponse,
    type TrueHDExactCapabilityWorkerResponse
} from 'webgpu-player/capability/exact/TrueHDExactCapabilityProtocol';

const ASSET_BASE_URL = 'https://example.test/web/libraries/';
// The URL the playback worker resolves for the same binary
const DECODER_WASM_URL = `${ASSET_BASE_URL}${TRUEHD_DECODER_WASM_ASSET}`;
const DECODER_WASM_BYTE_LENGTH = 8;
const WRONG_REQUEST_ID = 'wrong';

type WorkerEventType = 'error' | 'message' | 'messageerror';
type WorkerListener = (event: Event) => void;

class FakeTrueHDProbeWorker implements TrueHDExactCapabilityProbeWorker {
    public readonly postedMessages: unknown[] = [];
    public readonly postedTransfers: Transferable[][] = [];
    public terminateCallCount = 0;

    private readonly listeners = new Map<WorkerEventType, Set<WorkerListener>>();

    public addEventListener(type: WorkerEventType, listener: WorkerListener): void {
        let typeListeners = this.listeners.get(type);
        if (!typeListeners) {
            typeListeners = new Set<WorkerListener>();
            this.listeners.set(type, typeListeners);
        }
        typeListeners.add(listener);
    }

    public postMessage(message: unknown, transfer: Transferable[]): void {
        this.postedMessages.push(message);
        this.postedTransfers.push(transfer);
    }

    public removeEventListener(type: WorkerEventType, listener: WorkerListener): void {
        this.listeners.get(type)?.delete(listener);
    }

    public terminate(): void {
        this.terminateCallCount += 1;
    }

    public emitMessage(data: unknown): void {
        this.emit('message', new MessageEvent('message', { data }));
    }

    private emit(type: WorkerEventType, event: Event): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}

function createSupportedResponse(): TrueHDExactCapabilityWorkerResponse {
    return {
        decodeMilliseconds: 8,
        libraryVersion: 4_064_612,
        majorSyncRecoveryVerified: true,
        measuredRealTimeFactor: 32,
        reason: 'decode-output-verified',
        requestID: TRUEHD_EXACT_CAPABILITY_REQUEST_ID,
        supported: true,
        type: 'result',
        verifiedChannelCountMask: TRUEHD_QUALIFICATION_CHANNEL_COUNT_MASK,
        verifiedCodecMask: TRUEHD_QUALIFICATION_CODEC_MASK,
        verifiedVectorCount: TRUEHD_QUALIFICATION_VECTOR_COUNT,
        verifiedSampleRateMask: TRUEHD_QUALIFICATION_SAMPLE_RATE_MASK
    };
}

function createEnvironment(
    worker: FakeTrueHDProbeWorker,
    timeoutCallback: { value: (() => void) | null }
): TrueHDExactCapabilityProbeEnvironment {
    return {
        clearTimeout: vi.fn(),
        createWorker: () => worker,
        resolveAssetURL: path => `${ASSET_BASE_URL}${path}`,
        runtimeAvailable: true,
        setTimeout: callback => {
            timeoutCallback.value = callback;
            return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
        }
    };
}

describe('TrueHD exact capability protocol', () => {
    it('accepts only the bounded request shape', () => {
        const request = {
            decoderWASM: { kind: 'url', url: DECODER_WASM_URL },
            requestID: TRUEHD_EXACT_CAPABILITY_REQUEST_ID,
            type: 'probe'
        };
        expect(isTrueHDExactCapabilityWorkerRequest(request)).toBe(true);
        expect(isTrueHDExactCapabilityWorkerRequest({
            ...request,
            requestID: WRONG_REQUEST_ID
        })).toBe(false);
    });

    it('accepts the decoder binary as a URL or as bytes the page fetched', () => {
        const request = {
            requestID: TRUEHD_EXACT_CAPABILITY_REQUEST_ID,
            type: 'probe'
        };
        expect(isTrueHDExactCapabilityWorkerRequest({
            ...request,
            decoderWASM: { bytes: new ArrayBuffer(DECODER_WASM_BYTE_LENGTH), kind: 'bytes' }
        })).toBe(true);
        expect(isTrueHDExactCapabilityWorkerRequest(request)).toBe(false);
        expect(isTrueHDExactCapabilityWorkerRequest({
            ...request,
            decoderWASM: { kind: 'url', url: TRUEHD_DECODER_WASM_ASSET }
        })).toBe(false);
    });

    it('rejects malformed measurements, masks, and recovery evidence', () => {
        const response = createSupportedResponse();
        expect(isTrueHDExactCapabilityWorkerResponse(response)).toBe(true);
        expect(isTrueHDExactCapabilityWorkerResponse({
            ...response,
            measuredRealTimeFactor: Number.POSITIVE_INFINITY
        })).toBe(false);
        expect(isTrueHDExactCapabilityWorkerResponse({
            ...response,
            verifiedChannelCountMask: 1 << 8
        })).toBe(false);
        expect(isTrueHDExactCapabilityWorkerResponse({
            ...response,
            majorSyncRecoveryVerified: 'yes'
        })).toBe(false);
    });
});

describe('TrueHDExactCapabilityProbe', () => {
    it('caches a fully verified channel-bed capability', async () => {
        const worker = new FakeTrueHDProbeWorker();
        const timeoutCallback = { value: null as (() => void) | null };
        const probe = new TrueHDExactCapabilityProbe(createEnvironment(worker, timeoutCallback));

        const firstProbe = probe.probe();
        expect(probe.probe()).toBe(firstProbe);
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        expect(worker.postedMessages).toEqual([ {
            decoderWASM: { kind: 'url', url: DECODER_WASM_URL },
            requestID: TRUEHD_EXACT_CAPABILITY_REQUEST_ID,
            type: 'probe'
        } ]);
        expect(worker.postedTransfers).toEqual([ [] ]);
        worker.emitMessage(createSupportedResponse());

        await expect(firstProbe).resolves.toMatchObject({
            channelBedOnly: true,
            channelCounts: [ 2, 6 ],
            codecs: [ 'truehd', 'mlp' ],
            majorSyncRecoveryVerified: true,
            objectAudioRendered: false,
            passthrough: false,
            reason: 'decode-output-verified',
            sampleRates: [ 48_000, 96_000, 192_000 ],
            status: 'supported'
        });
        expect(worker.terminateCallCount).toBe(1);
    });

    it('fails closed when nominal success omits exact recovery evidence', async () => {
        const worker = new FakeTrueHDProbeWorker();
        const timeoutCallback = { value: null as (() => void) | null };
        const probe = new TrueHDExactCapabilityProbe(createEnvironment(worker, timeoutCallback));

        const resultPromise = probe.probe();
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        worker.emitMessage({
            ...createSupportedResponse(),
            majorSyncRecoveryVerified: false
        });

        await expect(resultPromise).resolves.toMatchObject({
            reason: 'output-mismatch',
            status: 'unsupported'
        });
    });

    it('reports an unavailable runtime without constructing a worker', async () => {
        const createWorker = vi.fn();
        const environment: TrueHDExactCapabilityProbeEnvironment = {
            clearTimeout: vi.fn(),
            createWorker,
            resolveAssetURL: vi.fn(),
            runtimeAvailable: false,
            setTimeout: vi.fn()
        };

        const capability = await new TrueHDExactCapabilityProbe(environment).probe();

        expect(capability).toMatchObject({
            reason: 'api-unavailable',
            status: 'unknown'
        });
        expect(createWorker).not.toHaveBeenCalled();
    });

    it('terminates a timed-out worker and ignores later output', async () => {
        const worker = new FakeTrueHDProbeWorker();
        const timeoutCallback = { value: null as (() => void) | null };
        const probe = new TrueHDExactCapabilityProbe(createEnvironment(worker, timeoutCallback));

        const resultPromise = probe.probe();
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        timeoutCallback.value?.();
        worker.emitMessage(createSupportedResponse());

        await expect(resultPromise).resolves.toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
        expect(worker.terminateCallCount).toBe(1);
    });

    it('rejects malformed worker messages', async () => {
        const worker = new FakeTrueHDProbeWorker();
        const timeoutCallback = { value: null as (() => void) | null };
        const probe = new TrueHDExactCapabilityProbe(createEnvironment(worker, timeoutCallback));

        const resultPromise = probe.probe();
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        worker.emitMessage({ supported: true });

        await expect(resultPromise).resolves.toMatchObject({
            reason: 'worker-message-invalid',
            status: 'unsupported'
        });
        expect(worker.terminateCallCount).toBe(1);
    });
});
