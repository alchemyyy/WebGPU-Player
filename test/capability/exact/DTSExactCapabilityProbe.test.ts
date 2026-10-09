import { describe, expect, it, vi } from 'vitest';

import { DTS_DECODER_WASM_ASSET } from 'webgpu-player/EngineAssets';
import DTSExactCapabilityProbe, {
    type DTSExactCapabilityProbeEnvironment,
    type DTSExactCapabilityProbeWorker
} from 'webgpu-player/capability/exact/DTSExactCapabilityProbe';
import {
    DTS_EXACT_CAPABILITY_REQUEST_ID,
    DTS_QUALIFICATION_VECTOR_COUNT,
    DTS_QUALIFICATION_PROFILE_MASK,
    isDTSExactCapabilityWorkerRequest,
    isDTSExactCapabilityWorkerResponse,
    type DTSExactCapabilityWorkerResponse
} from 'webgpu-player/capability/exact/DTSExactCapabilityProtocol';

const ASSET_BASE_URL = 'https://example.test/web/libraries/';
// The URL the playback worker resolves for the same binary
const DECODER_WASM_URL = `${ASSET_BASE_URL}${DTS_DECODER_WASM_ASSET}`;
const DECODER_WASM_BYTE_LENGTH = 8;
const WRONG_REQUEST_ID = 'wrong';

type WorkerEventType = 'error' | 'message' | 'messageerror';
type WorkerListener = (event: Event) => void;

class FakeDTSProbeWorker implements DTSExactCapabilityProbeWorker {
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

    public emitError(): void {
        this.emit('error', new Event('error'));
    }

    private emit(type: WorkerEventType, event: Event): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}

function createSupportedResponse(): DTSExactCapabilityWorkerResponse {
    return {
        decodeMilliseconds: 8,
        libraryVersion: 131_073,
        measuredRealTimeFactor: 32,
        reason: 'decode-output-verified',
        requestID: DTS_EXACT_CAPABILITY_REQUEST_ID,
        supported: true,
        type: 'result',
        verifiedVectorCount: DTS_QUALIFICATION_VECTOR_COUNT,
        verifiedProfileMask: DTS_QUALIFICATION_PROFILE_MASK
    };
}

function createEnvironment(
    worker: FakeDTSProbeWorker,
    timeoutCallback: { value: (() => void) | null }
): DTSExactCapabilityProbeEnvironment {
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

describe('DTS exact capability protocol', () => {
    it('accepts only the bounded request shape', () => {
        const request = {
            decoderWASM: { kind: 'url', url: DECODER_WASM_URL },
            requestID: DTS_EXACT_CAPABILITY_REQUEST_ID,
            type: 'probe'
        };
        expect(isDTSExactCapabilityWorkerRequest(request)).toBe(true);
        expect(isDTSExactCapabilityWorkerRequest({
            ...request,
            requestID: WRONG_REQUEST_ID
        })).toBe(false);
    });

    it('accepts the decoder binary as a URL or as bytes the page fetched', () => {
        const request = {
            requestID: DTS_EXACT_CAPABILITY_REQUEST_ID,
            type: 'probe'
        };
        expect(isDTSExactCapabilityWorkerRequest({
            ...request,
            decoderWASM: { bytes: new ArrayBuffer(DECODER_WASM_BYTE_LENGTH), kind: 'bytes' }
        })).toBe(true);
        expect(isDTSExactCapabilityWorkerRequest(request)).toBe(false);
        expect(isDTSExactCapabilityWorkerRequest({
            ...request,
            decoderWASM: { kind: 'url', url: DTS_DECODER_WASM_ASSET }
        })).toBe(false);
    });

    it('rejects malformed response measurements and profile masks', () => {
        const response = createSupportedResponse();
        expect(isDTSExactCapabilityWorkerResponse(response)).toBe(true);
        expect(isDTSExactCapabilityWorkerResponse({
            ...response,
            measuredRealTimeFactor: Number.POSITIVE_INFINITY
        })).toBe(false);
        expect(isDTSExactCapabilityWorkerResponse({
            ...response,
            verifiedProfileMask: 0x20
        })).toBe(false);
    });
});

describe('DTSExactCapabilityProbe', () => {
    it('caches and returns a fully verified channel-bed capability', async () => {
        const worker = new FakeDTSProbeWorker();
        const timeoutCallback = { value: null as (() => void) | null };
        const probe = new DTSExactCapabilityProbe(
            createEnvironment(worker, timeoutCallback)
        );

        const firstProbe = probe.probe();
        const secondProbe = probe.probe();
        expect(secondProbe).toBe(firstProbe);
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        expect(worker.postedMessages).toEqual([ {
            decoderWASM: { kind: 'url', url: DECODER_WASM_URL },
            requestID: DTS_EXACT_CAPABILITY_REQUEST_ID,
            type: 'probe'
        } ]);
        expect(worker.postedTransfers).toEqual([ [] ]);

        worker.emitMessage(createSupportedResponse());
        const capability = await firstProbe;

        expect(capability).toMatchObject({
            channelBedOnly: true,
            maximumChannelCount: 8,
            objectAudioRendered: false,
            reason: 'decode-output-verified',
            sampleRates: [ 48_000, 96_000, 192_000 ],
            status: 'supported',
            verifiedVectorCount: DTS_QUALIFICATION_VECTOR_COUNT,
            verifiedProfileMask: DTS_QUALIFICATION_PROFILE_MASK
        });
        expect(worker.terminateCallCount).toBe(1);
    });

    it('fails closed when a nominal success omits exact family evidence', async () => {
        const worker = new FakeDTSProbeWorker();
        const timeoutCallback = { value: null as (() => void) | null };
        const probe = new DTSExactCapabilityProbe(
            createEnvironment(worker, timeoutCallback)
        );

        const resultPromise = probe.probe();
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        worker.emitMessage({
            ...createSupportedResponse(),
            verifiedVectorCount: DTS_QUALIFICATION_VECTOR_COUNT - 1
        });

        await expect(resultPromise).resolves.toMatchObject({
            reason: 'output-mismatch',
            status: 'unsupported'
        });
    });

    it('reports unavailable runtimes without constructing a worker', async () => {
        const createWorker = vi.fn();
        const environment: DTSExactCapabilityProbeEnvironment = {
            clearTimeout: vi.fn(),
            createWorker,
            resolveAssetURL: vi.fn(),
            runtimeAvailable: false,
            setTimeout: vi.fn()
        };

        const capability = await new DTSExactCapabilityProbe(environment).probe();

        expect(capability).toMatchObject({
            reason: 'api-unavailable',
            status: 'unknown'
        });
        expect(createWorker).not.toHaveBeenCalled();
    });

    it('terminates a timed-out worker and ignores later output', async () => {
        const worker = new FakeDTSProbeWorker();
        const timeoutCallback = { value: null as (() => void) | null };
        const probe = new DTSExactCapabilityProbe(
            createEnvironment(worker, timeoutCallback)
        );

        const resultPromise = probe.probe();
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        timeoutCallback.value?.();
        worker.emitMessage(createSupportedResponse());
        const capability = await resultPromise;

        expect(capability).toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
        expect(worker.terminateCallCount).toBe(1);
    });

    it('rejects malformed worker messages', async () => {
        const worker = new FakeDTSProbeWorker();
        const timeoutCallback = { value: null as (() => void) | null };
        const probe = new DTSExactCapabilityProbe(
            createEnvironment(worker, timeoutCallback)
        );

        const resultPromise = probe.probe();
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        worker.emitMessage({ supported: true });

        await expect(resultPromise).resolves.toMatchObject({
            reason: 'worker-message-invalid',
            status: 'unsupported'
        });
        expect(worker.terminateCallCount).toBe(1);
    });

    it('downloads its assets on prepare and hands the binary to the worker before arming its timeout', async () => {
        const worker = new FakeDTSProbeWorker();
        const timeoutCallback = { value: null as (() => void) | null };
        const decoderWASMBytes = new ArrayBuffer(DECODER_WASM_BYTE_LENGTH);
        const decoderWASMDownload: { resolve: ((bytes: ArrayBuffer) => void) | null } = { resolve: null };
        const loadDecoderWASM = vi.fn((): Promise<ArrayBuffer> => new Promise<ArrayBuffer>(resolve => {
            decoderWASMDownload.resolve = resolve;
        }));
        const warmAsset = vi.fn(async (): Promise<void> => undefined);
        const createWorker = vi.fn(() => worker);
        const environment = {
            ...createEnvironment(worker, timeoutCallback),
            createWorker,
            loadDecoderWASM,
            warmAsset
        };
        const setTimeoutSpy = vi.spyOn(environment, 'setTimeout');
        const probe = new DTSExactCapabilityProbe(environment);

        probe.prepare();
        const resultPromise = probe.probe();
        await Promise.resolve();

        expect(loadDecoderWASM).toHaveBeenCalledExactlyOnceWith(DECODER_WASM_URL);
        expect(warmAsset).toHaveBeenCalledExactlyOnceWith(
            `${ASSET_BASE_URL}webgpu-player/DTSExactCapabilityProbe.worker.js`
        );
        expect(createWorker).not.toHaveBeenCalled();
        expect(setTimeoutSpy).not.toHaveBeenCalled();

        decoderWASMDownload.resolve?.(decoderWASMBytes);
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        expect(setTimeoutSpy).toHaveBeenCalledOnce();
        expect(worker.postedMessages[0]).toMatchObject({
            decoderWASM: { bytes: decoderWASMBytes, kind: 'bytes' }
        });
        expect(worker.postedTransfers).toEqual([ [ decoderWASMBytes ] ]);

        worker.emitMessage(createSupportedResponse());
        await expect(resultPromise).resolves.toMatchObject({ status: 'supported' });
        expect(loadDecoderWASM).toHaveBeenCalledOnce();
    });

    it('reports a failed download as an unknown asset failure without creating a worker', async () => {
        const worker = new FakeDTSProbeWorker();
        const timeoutCallback = { value: null as (() => void) | null };
        const createWorker = vi.fn(() => worker);
        const probe = new DTSExactCapabilityProbe({
            ...createEnvironment(worker, timeoutCallback),
            createWorker,
            loadDecoderWASM: vi.fn(async (): Promise<ArrayBuffer> => {
                throw new Error('offline');
            })
        });

        await expect(probe.probe()).resolves.toMatchObject({
            reason: 'asset-unavailable',
            status: 'unknown'
        });
        expect(createWorker).not.toHaveBeenCalled();
    });
});
