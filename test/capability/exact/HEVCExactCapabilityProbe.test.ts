import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    BundledHEVCExactCapabilityProbe,
    type HEVCExactCapabilityProbeEnvironment,
    type HEVCExactCapabilityProbeWorker
} from 'webgpu-player/capability/exact/HEVCExactCapabilityProbe';
import {
    HEVC_EXACT_CAPABILITY_QUALIFICATION_FRAME_COUNT,
    HEVC_EXACT_CAPABILITY_VECTORS,
    HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS,
    HEVC_EXACT_CAPABILITY_REQUEST_ID,
    type HEVCExactCapabilityVector,
    type HEVCExactCapabilityWorkerQualificationResult,
    type HEVCExactCapabilityWorkerResponse
} from 'webgpu-player/capability/exact/HEVCExactCapabilityProtocol';

const ASSET_BASE_URL = 'https://example.test/web/libraries/';
const DECODER_GLUE_URL = `${ASSET_BASE_URL}ffmpeg-hevc/ffmpeg-hevc.js`;
const DECODER_WASM_URL = `${ASSET_BASE_URL}ffmpeg-hevc/ffmpeg-hevc.wasm`;
const QUALIFICATION_BITSTREAM_URL = `${ASSET_BASE_URL}ffmpeg-hevc/main10-4k-qualification.bin`;
const PROBE_WORKER_URL = `${ASSET_BASE_URL}webgpu-player/HEVCExactCapabilityProbe.worker.js`;
const PRELOADED_DECODER_WASM_BYTE_LENGTH = 8;
// Each vector transfers its single-frame access unit and its qualification access units
const QUALIFICATION_TRANSFER_COUNT = HEVC_EXACT_CAPABILITY_VECTORS.length * (HEVC_EXACT_CAPABILITY_QUALIFICATION_FRAME_COUNT + 1);
// Preloaded decoder bytes travel to the worker as one more transfer
const DECODER_WASM_TRANSFER_COUNT = 1;
// Compact 4:2:0 planes hold a byte per sample at 8 bits and two at 10
const DECODED_FRAME_BYTE_LENGTHS: Readonly<Record<HEVCExactCapabilityVector, number>> = Object.freeze({
    'main-1080p': 3_110_400,
    'main10-1080p': 6_220_800,
    'main10-4k': 24_883_200
});
// What a decoder that widens 8-bit samples to 16-bit words reports for a frame of the 8-bit vector
const WIDENED_MAIN_1080P_DECODED_FRAME_BYTE_LENGTH = 6_220_800;

type WorkerEventType = 'error' | 'message' | 'messageerror';
type WorkerEventListener = (event: Event) => void;

class MockCapabilityWorker implements HEVCExactCapabilityProbeWorker {
    public readonly listeners = new Map<WorkerEventType, Set<WorkerEventListener>>();
    public readonly postedMessages: unknown[] = [];
    public readonly postedTransfers: Transferable[][] = [];
    public postMessageError: Error | null = null;
    public terminateCount = 0;

    public addEventListener(type: WorkerEventType, listener: WorkerEventListener): void {
        let listeners = this.listeners.get(type);
        if (!listeners) {
            listeners = new Set<WorkerEventListener>();
            this.listeners.set(type, listeners);
        }
        listeners.add(listener);
    }

    public postMessage(message: unknown, transfer: Transferable[]): void {
        if (this.postMessageError) {
            throw this.postMessageError;
        }
        this.postedMessages.push(message);
        this.postedTransfers.push(transfer);
    }

    public removeEventListener(type: WorkerEventType, listener: WorkerEventListener): void {
        this.listeners.get(type)?.delete(listener);
    }

    public terminate(): void {
        this.terminateCount += 1;
    }

    public emit(type: WorkerEventType, data?: unknown): void {
        const event = type === 'message' ? new MessageEvent<unknown>('message', { data }) : new Event(type);
        for (const listener of [ ...(this.listeners.get(type) ?? []) ]) {
            listener(event);
        }
    }

    public listenerCount(): number {
        let count = 0;
        for (const listeners of this.listeners.values()) {
            count += listeners.size;
        }
        return count;
    }
}

function createSuccessfulQualificationResult(
    vector: HEVCExactCapabilityVector,
    overrides: Partial<HEVCExactCapabilityWorkerQualificationResult> = {}
): HEVCExactCapabilityWorkerQualificationResult {
    const definition = HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS[vector];
    const decodedFrameFingerprints = overrides.decodedFrameFingerprints === undefined ?
        definition.decodedFrameFingerprints :
        overrides.decodedFrameFingerprints;
    return {
        bitDepth: definition.bitDepth,
        chromaHeight: Math.ceil(definition.codedHeight / 2),
        chromaWidth: Math.ceil(definition.codedWidth / 2),
        codedHeight: definition.codedHeight,
        codedWidth: definition.codedWidth,
        decodedFrameCount: definition.qualificationFrameCount,
        decodedByteLength: DECODED_FRAME_BYTE_LENGTHS[vector],
        vector,
        levelIDC: definition.levelIDC,
        profileIDC: definition.profileIDC,
        reason: 'decode-output-verified',
        supported: true,
        totalDecodedByteLength: DECODED_FRAME_BYTE_LENGTHS[vector] * definition.qualificationFrameCount,
        ...overrides,
        decodedFrameFingerprints
    };
}

function createSuccessfulResponse(): HEVCExactCapabilityWorkerResponse {
    return {
        requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
        results: [
            createSuccessfulQualificationResult('main-1080p'),
            createSuccessfulQualificationResult('main10-1080p'),
            createSuccessfulQualificationResult('main10-4k')
        ],
        type: 'result'
    };
}

function createEnvironment(
    worker: MockCapabilityWorker,
    overrides: Partial<HEVCExactCapabilityProbeEnvironment> = {}
): HEVCExactCapabilityProbeEnvironment {
    const qualificationByteLength = HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS['main10-4k'].qualificationAccessUnitByteLengths.reduce(
        (totalByteLength, byteLength) => totalByteLength + byteLength,
        0
    );
    return {
        clearTimeout: (timeout): void => globalThis.clearTimeout(timeout),
        createWorker: (): MockCapabilityWorker => worker,
        loadQualificationBitstream: async (): Promise<ArrayBuffer> => (
            new ArrayBuffer(qualificationByteLength)
        ),
        resolveAssetURL: (path: string): string => `${ASSET_BASE_URL}${path}`,
        runtimeAvailable: true,
        setTimeout: (callback, milliseconds): ReturnType<typeof globalThis.setTimeout> => (
            globalThis.setTimeout(callback, milliseconds)
        ),
        ...overrides
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('BundledHEVCExactCapabilityProbe', () => {
    it('qualifies exact output, transfers vectors, freezes, and caches the result', async () => {
        const worker = new MockCapabilityWorker();
        const probe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker));

        const firstPromise = probe.probe();
        const secondPromise = probe.probe();
        expect(secondPromise).toBe(firstPromise);
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        expect(worker.postedMessages).toHaveLength(1);
        expect(worker.postedTransfers[0]).toHaveLength(QUALIFICATION_TRANSFER_COUNT);
        expect(worker.postedMessages[0]).toMatchObject({
            decoderGlueURL: DECODER_GLUE_URL,
            decoderWASM: { kind: 'url', url: DECODER_WASM_URL },
            requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
            type: 'probe'
        });

        worker.emit('message', createSuccessfulResponse());
        const capabilities = await firstPromise;

        expect(capabilities).toMatchObject({
            qualifications: {
                'main-1080p': {
                    format: 'I420',
                    reason: 'decode-output-verified',
                    status: 'supported'
                },
                'main10-4k': {
                    format: 'I420P10',
                    reason: 'decode-output-verified',
                    status: 'supported'
                },
                'main10-1080p': {
                    format: 'I420P10',
                    reason: 'decode-output-verified',
                    status: 'supported'
                }
            },
            reason: 'complete'
        });
        expect(Object.isFrozen(capabilities)).toBe(true);
        expect(Object.isFrozen(capabilities.qualifications)).toBe(true);
        expect(Object.isFrozen(capabilities.qualifications['main10-4k'])).toBe(true);
        expect(worker.terminateCount).toBe(1);
        expect(worker.listenerCount()).toBe(0);
        expect(await probe.probe()).toBe(capabilities);
    });

    it('preserves an independently failed qualification as a partial result', async () => {
        const worker = new MockCapabilityWorker();
        const probe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker));
        const resultPromise = probe.probe();
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        const response = createSuccessfulResponse();
        worker.emit('message', {
            ...response,
            results: [
                response.results[0],
                response.results[1],
                {
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
                    reason: 'decode-error',
                    supported: false,
                    vector: 'main10-4k',
                    totalDecodedByteLength: null
                }
            ]
        });

        const capabilities = await resultPromise;
        expect(capabilities.reason).toBe('partial');
        expect(capabilities.qualifications['main-1080p'].status).toBe('supported');
        expect(capabilities.qualifications['main10-4k']).toMatchObject({
            reason: 'decode-error',
            status: 'unsupported'
        });
    });

    it('rejects a worker success summary that contradicts its vector', async () => {
        const worker = new MockCapabilityWorker();
        const probe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker));
        const resultPromise = probe.probe();
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        const response = createSuccessfulResponse();
        worker.emit('message', {
            ...response,
            results: [
                response.results[0],
                response.results[1],
                createSuccessfulQualificationResult('main10-4k', { codedWidth: 1_920 })
            ]
        });

        const capabilities = await resultPromise;
        expect(capabilities.reason).toBe('partial');
        expect(capabilities.qualifications['main10-4k']).toMatchObject({
            reason: 'output-mismatch',
            status: 'unsupported'
        });
    });

    it('rejects a worker success summary that counts two bytes per 8-bit sample', async () => {
        const worker = new MockCapabilityWorker();
        const probe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker));
        const resultPromise = probe.probe();
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        const response = createSuccessfulResponse();
        worker.emit('message', {
            ...response,
            results: [
                createSuccessfulQualificationResult('main-1080p', {
                    decodedByteLength: WIDENED_MAIN_1080P_DECODED_FRAME_BYTE_LENGTH,
                    totalDecodedByteLength: WIDENED_MAIN_1080P_DECODED_FRAME_BYTE_LENGTH * HEVC_EXACT_CAPABILITY_QUALIFICATION_FRAME_COUNT
                }),
                response.results[1],
                response.results[2]
            ]
        });

        const capabilities = await resultPromise;
        expect(capabilities.reason).toBe('partial');
        expect(capabilities.qualifications['main-1080p']).toMatchObject({
            reason: 'output-mismatch',
            status: 'unsupported'
        });
        expect(capabilities.qualifications['main10-1080p'].status).toBe('supported');
    });

    it.each([
        [ 'error', 'worker-error' ],
        [ 'messageerror', 'worker-message-invalid' ]
    ] as const)('fails closed on a worker %s event', async (eventType, reason) => {
        const worker = new MockCapabilityWorker();
        const probe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker));
        const resultPromise = probe.probe();
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        worker.emit(eventType);

        const capabilities = await resultPromise;
        expect(capabilities.reason).toBe('failed');
        expect(capabilities.qualifications['main-1080p'].reason).toBe(reason);
        expect(capabilities.qualifications['main10-4k'].reason).toBe(reason);
        expect(worker.terminateCount).toBe(1);
        expect(worker.listenerCount()).toBe(0);
    });

    it('fails closed and cleans up after the bounded timeout', async () => {
        vi.useFakeTimers();
        const worker = new MockCapabilityWorker();
        const probe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker), 50);
        const resultPromise = probe.probe();
        await vi.advanceTimersByTimeAsync(50);

        const capabilities = await resultPromise;
        expect(capabilities.qualifications['main-1080p'].reason).toBe('probe-timeout');
        expect(capabilities.qualifications['main10-4k'].reason).toBe('probe-timeout');
        expect(worker.terminateCount).toBe(1);
        expect(worker.listenerCount()).toBe(0);
    });

    it('fails closed without constructing a worker when runtime APIs are unavailable', async () => {
        const worker = new MockCapabilityWorker();
        const createWorker = vi.fn((): MockCapabilityWorker => worker);
        const probe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker, {
            createWorker,
            runtimeAvailable: false
        }));

        const capabilities = await probe.probe();
        expect(capabilities.reason).toBe('unavailable');
        expect(capabilities.qualifications['main-1080p'].reason).toBe('api-unavailable');
        expect(createWorker).not.toHaveBeenCalled();
    });

    it('caches worker creation and postMessage failures', async () => {
        const creationProbe = new BundledHEVCExactCapabilityProbe({
            ...createEnvironment(new MockCapabilityWorker()),
            createWorker: (): never => {
                throw new Error('create failed');
            }
        });
        const creationResult = await creationProbe.probe();
        expect(creationResult.qualifications['main10-4k'].reason).toBe('worker-create-failed');
        expect(await creationProbe.probe()).toBe(creationResult);

        const worker = new MockCapabilityWorker();
        worker.postMessageError = new Error('post failed');
        const postProbe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker));
        const postResult = await postProbe.probe();
        expect(postResult.qualifications['main10-4k'].reason).toBe('worker-error');
        expect(worker.terminateCount).toBe(1);
        expect(worker.listenerCount()).toBe(0);
    });

    it('fails closed when the external qualification vector cannot load', async () => {
        const worker = new MockCapabilityWorker();
        const loadQualificationBitstream = vi.fn(async (): Promise<ArrayBuffer> => {
            throw new Error('vector unavailable');
        });
        const probe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker, {
            loadQualificationBitstream
        }));

        const capabilities = await probe.probe();

        expect(loadQualificationBitstream).toHaveBeenCalledWith(QUALIFICATION_BITSTREAM_URL);
        expect(capabilities.reason).toBe('failed');
        expect(capabilities.qualifications['main10-4k'].reason).toBe('asset-unavailable');
        // A failed download never starts a worker
        expect(worker.postedMessages).toHaveLength(0);
        expect(worker.terminateCount).toBe(0);
    });

    it('downloads its assets on prepare and arms its timeout only once they arrive', async () => {
        const worker = new MockCapabilityWorker();
        const baseEnvironment = createEnvironment(worker);
        const qualificationBitstream = await baseEnvironment.loadQualificationBitstream('');
        const decoderWASMBytes = new ArrayBuffer(PRELOADED_DECODER_WASM_BYTE_LENGTH);
        const vectorDownload: { resolve: ((bitstream: ArrayBuffer) => void) | null } = { resolve: null };
        const loadQualificationBitstream = vi.fn((): Promise<ArrayBuffer> => new Promise<ArrayBuffer>(resolve => {
            vectorDownload.resolve = resolve;
        }));
        const loadDecoderWASM = vi.fn(async (): Promise<ArrayBuffer> => decoderWASMBytes);
        const warmAsset = vi.fn(async (): Promise<void> => undefined);
        const createWorker = vi.fn((): MockCapabilityWorker => worker);
        const setTimeout = vi.fn(baseEnvironment.setTimeout);
        const probe = new BundledHEVCExactCapabilityProbe({
            ...baseEnvironment,
            createWorker,
            loadDecoderWASM,
            loadQualificationBitstream,
            setTimeout,
            warmAsset
        });

        probe.prepare();
        const resultPromise = probe.probe();
        await Promise.resolve();

        expect(loadDecoderWASM).toHaveBeenCalledExactlyOnceWith(DECODER_WASM_URL);
        expect(warmAsset.mock.calls).toEqual([
            [ PROBE_WORKER_URL ],
            [ DECODER_GLUE_URL ]
        ]);
        expect(createWorker).not.toHaveBeenCalled();
        expect(setTimeout).not.toHaveBeenCalled();

        vectorDownload.resolve?.(qualificationBitstream);
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        expect(setTimeout).toHaveBeenCalledOnce();
        expect(worker.postedMessages[0]).toMatchObject({
            decoderWASM: { bytes: decoderWASMBytes, kind: 'bytes' }
        });
        expect(worker.postedTransfers[0]).toHaveLength(QUALIFICATION_TRANSFER_COUNT + DECODER_WASM_TRANSFER_COUNT);
        expect(worker.postedTransfers[0]).toContain(decoderWASMBytes);

        worker.emit('message', createSuccessfulResponse());
        await expect(resultPromise).resolves.toMatchObject({ reason: 'complete' });
        expect(loadQualificationBitstream).toHaveBeenCalledOnce();
    });

    it('rejects malformed worker messages and ignores later events', async () => {
        const worker = new MockCapabilityWorker();
        const probe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker));
        const resultPromise = probe.probe();
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        worker.emit('message', { type: 'result', results: [] });
        worker.emit('message', createSuccessfulResponse());

        const capabilities = await resultPromise;
        expect(capabilities.qualifications['main10-4k'].reason).toBe('worker-message-invalid');
        expect(worker.terminateCount).toBe(1);
    });
});
