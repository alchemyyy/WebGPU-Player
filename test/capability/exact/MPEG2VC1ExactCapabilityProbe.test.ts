import { afterEach, describe, expect, it, vi } from 'vitest';

import MPEG2VC1ExactCapabilityProbe, {
    type MPEG2VC1ExactCapabilityProbeEnvironment,
    type MPEG2VC1ExactCapabilityProbeWorker
} from 'webgpu-player/capability/exact/MPEG2VC1ExactCapabilityProbe';
import {
    isMPEG2VC1ExactCapabilityWorkerRequest,
    MPEG2_EXACT_CAPABILITY_REQUEST_ID,
    MPEG2_VC1_QUALIFICATION_CODED_HEIGHT,
    MPEG2_VC1_QUALIFICATION_CODED_WIDTH,
    MPEG2_VC1_QUALIFICATION_FRAME_BYTE_LENGTH,
    MPEG2_VC1_QUALIFICATION_FRAME_COUNT,
    MPEG2_VC1_QUALIFICATION_TOTAL_BYTE_LENGTH,
    MPEG2_VIDEO_QUALIFICATION_FINGERPRINT,
    VC1_EXACT_CAPABILITY_REQUEST_ID,
    VC1_VIDEO_QUALIFICATION_FINGERPRINT,
    type MPEG2VC1ExactCapabilityWorkerResponse
} from 'webgpu-player/capability/exact/MPEG2VC1ExactCapabilityProtocol';

type WorkerEventType = 'error' | 'message' | 'messageerror';
type WorkerEventListener = (event: Event) => void;

class MockMPEG2VC1CapabilityWorker implements MPEG2VC1ExactCapabilityProbeWorker {
    private readonly listeners = new Map<WorkerEventType, Set<WorkerEventListener>>();
    public readonly postedMessages: unknown[] = [];
    public readonly postedTransfers: Transferable[][] = [];
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
        const event = type === 'message' ?
            new MessageEvent<unknown>('message', { data }) :
            new Event(type);
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}

function createEnvironment(
    worker: MockMPEG2VC1CapabilityWorker,
    overrides: Partial<MPEG2VC1ExactCapabilityProbeEnvironment> = {}
): MPEG2VC1ExactCapabilityProbeEnvironment {
    return {
        clearTimeout: (timeout): void => globalThis.clearTimeout(timeout),
        createWorker: (): MockMPEG2VC1CapabilityWorker => worker,
        loadVector: async (): Promise<ArrayBuffer> => new ArrayBuffer(128),
        resolveAssetURL: (path: string): string => `https://example.test/web/libraries/${path}`,
        runtimeAvailable: true,
        setTimeout: (callback, milliseconds): ReturnType<typeof globalThis.setTimeout> => (
            globalThis.setTimeout(callback, milliseconds)
        ),
        ...overrides
    };
}

function createSuccessfulResponse(
    overrides: Partial<MPEG2VC1ExactCapabilityWorkerResponse> = {}
): MPEG2VC1ExactCapabilityWorkerResponse {
    return {
        codedHeight: MPEG2_VC1_QUALIFICATION_CODED_HEIGHT,
        codedWidth: MPEG2_VC1_QUALIFICATION_CODED_WIDTH,
        decodedFrameByteLength: MPEG2_VC1_QUALIFICATION_FRAME_BYTE_LENGTH,
        decodedFrameCount: MPEG2_VC1_QUALIFICATION_FRAME_COUNT,
        decodedI420Fingerprint: MPEG2_VIDEO_QUALIFICATION_FINGERPRINT,
        decodedTotalByteLength: MPEG2_VC1_QUALIFICATION_TOTAL_BYTE_LENGTH,
        reason: 'decode-output-verified',
        requestID: MPEG2_EXACT_CAPABILITY_REQUEST_ID,
        supported: true,
        type: 'result',
        ...overrides
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('MPEG2VC1ExactCapabilityProbe', () => {
    it('qualifies exact output, transfers the vector, freezes, and caches', async () => {
        const worker = new MockMPEG2VC1CapabilityWorker();
        const probe = new MPEG2VC1ExactCapabilityProbe(createEnvironment(worker));

        const firstPromise = probe.probe();
        expect(probe.probe()).toBe(firstPromise);
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        expect(isMPEG2VC1ExactCapabilityWorkerRequest(worker.postedMessages[0])).toBe(true);
        expect(worker.postedTransfers[0]).toHaveLength(1);

        worker.emit('message', createSuccessfulResponse());
        const capability = await firstPromise;

        expect(capability).toMatchObject({
            reason: 'decode-output-verified',
            status: 'supported'
        });
        expect(capability).not.toHaveProperty('maximumCodedHeight');
        expect(capability).not.toHaveProperty('maximumCodedWidth');
        expect(capability).not.toHaveProperty('maximumFramesPerSecond');
        expect(Object.isFrozen(capability)).toBe(true);
        expect(worker.terminateCount).toBe(1);
    });

    it('fails closed when the worker fingerprint differs', async () => {
        const worker = new MockMPEG2VC1CapabilityWorker();
        const probe = new MPEG2VC1ExactCapabilityProbe(createEnvironment(worker));
        const capabilityPromise = probe.probe();
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));

        worker.emit('message', createSuccessfulResponse({
            decodedI420Fingerprint: MPEG2_VIDEO_QUALIFICATION_FINGERPRINT + 1
        }));

        await expect(capabilityPromise).resolves.toMatchObject({
            reason: 'output-mismatch',
            status: 'unsupported'
        });
    });

    it('selects and independently qualifies the Advanced VC-1 vector', async () => {
        const worker = new MockMPEG2VC1CapabilityWorker();
        const loadVector = vi.fn<
            (url: string) => Promise<ArrayBuffer>
        >(async (): Promise<ArrayBuffer> => new ArrayBuffer(128));
        const probe = new MPEG2VC1ExactCapabilityProbe(
            createEnvironment(worker, { loadVector }),
            5_000,
            'vc1'
        );
        const capabilityPromise = probe.probe();
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));

        expect(loadVector).toHaveBeenCalledWith(
            'https://example.test/web/libraries/ffmpeg-mpeg2-vc1/'
                + 'vc1-advanced-progressive-1920x1080-qualification.bin'
        );
        expect(worker.postedMessages[0]).toMatchObject({
            requestID: VC1_EXACT_CAPABILITY_REQUEST_ID
        });
        worker.emit('message', createSuccessfulResponse({
            decodedI420Fingerprint: VC1_VIDEO_QUALIFICATION_FINGERPRINT,
            requestID: VC1_EXACT_CAPABILITY_REQUEST_ID
        }));

        await expect(capabilityPromise).resolves.toMatchObject({
            codec: 'vc1',
            reason: 'decode-output-verified',
            status: 'supported'
        });
    });

    it('returns unknown without creating a worker when the runtime is unavailable', async () => {
        const worker = new MockMPEG2VC1CapabilityWorker();
        const environment = createEnvironment(worker, {
            createWorker: null,
            runtimeAvailable: false
        });

        await expect(new MPEG2VC1ExactCapabilityProbe(environment).probe())
            .resolves.toMatchObject({
                reason: 'api-unavailable',
                status: 'unknown'
            });
        expect(worker.terminateCount).toBe(0);
    });

    it('bounds a worker that never responds', async () => {
        vi.useFakeTimers();
        const worker = new MockMPEG2VC1CapabilityWorker();
        const probe = new MPEG2VC1ExactCapabilityProbe(createEnvironment(worker), 20);
        const capabilityPromise = probe.probe();

        await vi.advanceTimersByTimeAsync(20);

        await expect(capabilityPromise).resolves.toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
        expect(worker.terminateCount).toBe(1);
    });
});
