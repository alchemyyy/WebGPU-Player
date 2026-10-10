import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { secondsToMicroseconds, type Microseconds } from 'webgpu-player/MediaTime';
import CustomDecodeSession, { type CustomDecodeSessionEvent } from 'webgpu-player/pipeline/CustomDecodeSession';
import { MAX_DECODED_FRAME_CREDITS } from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import type { DecodedPresentationFrame } from 'webgpu-player/presentation/WebGPUPresenter';
import type {
    WorkerPresentationAttachment,
    WorkerPresentationRendererProvider
} from 'webgpu-player/presentation/WorkerPresentationProtocol';

type MessageHandler = (event: MessageEvent<unknown>) => void;
type ErrorHandler = (event: ErrorEvent) => void;

const FIRST_GENERATION = 301;
const SECOND_GENERATION = 302;
// The session's bounds on a renderer's status and on a stopping run's acknowledgement
const RENDERER_STATUS_TIMEOUT_MILLISECONDS = 2_000;
const WORKER_STOP_TIMEOUT_MILLISECONDS = 1_000;
const TIMER_RESOLUTION_MILLISECONDS = 1;
const FRAME_DURATION_MICROSECONDS = 100_000;
const DISPLAY_WIDTH = 1_920;
const DISPLAY_HEIGHT = 1_080;
const FIRST_FRAME_SECONDS = 1;
const SECOND_FRAME_SECONDS = 1.1;
const THIRD_FRAME_SECONDS = 1.2;
const DOLBY_VISION_RPU_COUNT = 2;
const RENDERER_UNAVAILABLE_REASON = 'WebGPU is unavailable in workers';
// The reasons the session records when a worker it offered a renderer presents on the page
const RENDERER_ATTACHMENT_UNAVAILABLE_REASON = 'The presenter offered no renderer attachment';
const RENDERER_STATUS_TIMEOUT_REASON = 'The worker renderer did not report its status in time';
const FRAME_QUEUE_BOUND_FAILURE = 'The custom decode frame queue exceeded its bound';
const UNEXPECTED_FRAME_OUTPUT_MODE_FAILURE = 'The custom decode worker returned an unexpected video output mode';
const REUSED_FRAME_ID_FAILURE = 'The custom decode worker reused the ID of a held frame';
const WORKER_CRASH_FAILURE = 'The custom decode worker crashed';
const INVALID_WORKER_MESSAGE_FAILURE = 'The custom decode worker sent an invalid message';
const RENDERER_STATUS_TIMEOUT_WARNING = 'did not report its status';

class MockWorker {
    readonly postedMessages: unknown[] = [];
    readonly postedTransfers: Transferable[][] = [];
    readonly terminate = vi.fn();

    private readonly errorHandlers = new Set<ErrorHandler>();
    private readonly messageHandlers = new Set<MessageHandler>();

    postMessage(message: unknown, transfer: Transferable[] = []): void {
        this.postedMessages.push(message);
        this.postedTransfers.push(transfer);
    }

    addEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
        switch (type) {
            case 'message':
                this.messageHandlers.add(handler as MessageHandler);
                break;
            case 'error':
                this.errorHandlers.add(handler as ErrorHandler);
                break;
            default:
                break;
        }
    }

    removeEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
        switch (type) {
            case 'message':
                this.messageHandlers.delete(handler as MessageHandler);
                break;
            case 'error':
                this.errorHandlers.delete(handler as ErrorHandler);
                break;
            default:
                break;
        }
    }

    emitMessage(data: unknown): void {
        for (const handler of this.messageHandlers) {
            handler({ data } as MessageEvent<unknown>);
        }
    }

    emitError(): void {
        const event = { preventDefault: vi.fn() } as unknown as ErrorEvent;
        for (const handler of this.errorHandlers) {
            handler(event);
        }
    }

    /** Returns the requests of one type, in the order the session posted them. */
    getPostedRequests(type: string): Array<Record<string, unknown>> {
        const requests: Array<Record<string, unknown>> = [];
        for (const message of this.postedMessages) {
            const request = message as Record<string, unknown>;
            if (request.type === type) {
                requests.push(request);
            }
        }
        return requests;
    }
}

type SessionHarness = {
    attachments: WorkerPresentationAttachment[]
    events: CustomDecodeSessionEvent[]
    provider: Mock<WorkerPresentationRendererProvider>
    session: CustomDecodeSession
    workers: MockWorker[]
};

function createAttachment(): WorkerPresentationAttachment {
    return {
        canvas: {} as OffscreenCanvas,
        port: { close: vi.fn(), postMessage: vi.fn() } as unknown as MessagePort
    };
}

/** Creates a session whose provider hands out a new attachment per worker, unless a test passes its own provider. */
function createSessionHarness(providerImplementation?: WorkerPresentationRendererProvider | null): SessionHarness {
    const attachments: WorkerPresentationAttachment[] = [];
    const events: CustomDecodeSessionEvent[] = [];
    const workers: MockWorker[] = [];
    const provider = vi.fn<WorkerPresentationRendererProvider>(providerImplementation ?? ((): WorkerPresentationAttachment => {
        const attachment = createAttachment();
        attachments.push(attachment);
        return attachment;
    }));
    const session = new CustomDecodeSession(
        (event: CustomDecodeSessionEvent): void => {
            events.push(event);
        },
        (): Worker => {
            const worker = new MockWorker();
            workers.push(worker);
            return worker as unknown as Worker;
        },
        null,
        null,
        null,
        providerImplementation === null ? null : provider
    );
    return { attachments, events, provider, session, workers };
}

function startSession(session: CustomDecodeSession, generation: number): void {
    session.start({
        dolbyVisionProfile: null,
        generation,
        maximumCodedHeight: DISPLAY_HEIGHT,
        maximumCodedWidth: DISPLAY_WIDTH,
        nativeHDRTransfer: null,
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat: null,
        startTimeMicroseconds: secondsToMicroseconds(FIRST_FRAME_SECONDS),
        url: 'http://localhost/video.mp4',
        videoDecoderBackend: 'native',
        videoOutputMode: 'video-frame',
        videoTrackIndex: 0
    });
}

function emitRendererStatus(worker: MockWorker, generation: number, available: boolean): void {
    worker.emitMessage({
        available,
        generation,
        reason: available ? null : RENDERER_UNAVAILABLE_REASON,
        type: 'renderer-status'
    });
}

function emitReady(worker: MockWorker, generation: number): void {
    worker.emitMessage({
        audio: null,
        codec: 'avc1.640028',
        codedHeight: DISPLAY_HEIGHT,
        codedWidth: DISPLAY_WIDTH,
        displayHeight: DISPLAY_HEIGHT,
        displayWidth: DISPLAY_WIDTH,
        generation,
        type: 'ready'
    });
}

function emitDescriptor(
    worker: MockWorker,
    generation: number,
    frameId: number,
    mediaTimeSeconds: number,
    extraFields: Record<string, unknown> = {}
): void {
    worker.emitMessage({
        displayHeight: DISPLAY_HEIGHT,
        displayWidth: DISPLAY_WIDTH,
        durationMicroseconds: FRAME_DURATION_MICROSECONDS,
        frameId,
        generation,
        mediaTimeMicroseconds: secondsToMicroseconds(mediaTimeSeconds),
        outputMode: 'worker-frame',
        type: 'frame',
        ...extraFields
    });
}

/** Starts a generation whose new worker's renderer reported ready, so its frames stay in the worker. */
function startWorkerPresentedGeneration(harness: SessionHarness, generation: number): MockWorker {
    startSession(harness.session, generation);
    const worker = harness.workers.at(-1);
    if (!worker) {
        throw new Error('The session created no worker');
    }
    emitRendererStatus(worker, generation, true);
    emitReady(worker, generation);
    return worker;
}

function takeFrameAt(session: CustomDecodeSession, targetSeconds: number): DecodedPresentationFrame {
    const presentationFrame = session.takeFrame(secondsToMicroseconds(targetSeconds) as Microseconds);
    if (!presentationFrame) {
        throw new Error('The session had no frame for the target');
    }
    return presentationFrame;
}

function getErrorMessages(events: readonly CustomDecodeSessionEvent[]): string[] {
    const messages: string[] = [];
    for (const event of events) {
        if (event.type === 'error') {
            messages.push(event.message);
        }
    }
    return messages;
}

describe('CustomDecodeSession worker presentation', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('offers a new worker a renderer and holds its first start until the renderer reports', () => {
        const harness = createSessionHarness();
        startSession(harness.session, FIRST_GENERATION);
        const [ worker ] = harness.workers;
        const [ attachment ] = harness.attachments;

        expect(harness.provider).toHaveBeenCalledOnce();
        expect(worker.postedMessages).toEqual([ {
            canvas: attachment.canvas,
            generation: FIRST_GENERATION,
            port: attachment.port,
            type: 'attach-renderer'
        } ]);
        expect(worker.postedTransfers[0]).toEqual([ attachment.canvas, attachment.port ]);
        expect(harness.session.getTelemetry()).toMatchObject({ presentationMode: null, state: 'starting' });

        emitRendererStatus(worker, FIRST_GENERATION, true);
        expect(worker.getPostedRequests('start')).toEqual([
            expect.objectContaining({ generation: FIRST_GENERATION, presentationMode: 'worker' })
        ]);
        expect(harness.session.getTelemetry()).toMatchObject({
            presentationMode: 'worker',
            rendererUnavailableReason: null,
            workerReused: false
        });

        // Later generations of the worker present there too, without another attachment
        const stopPromise = harness.session.stop();
        worker.emitMessage({ generation: FIRST_GENERATION, type: 'stopped' });
        startSession(harness.session, SECOND_GENERATION);
        expect(worker.getPostedRequests('start').at(-1)).toMatchObject({
            generation: SECOND_GENERATION,
            presentationMode: 'worker'
        });
        expect(harness.provider).toHaveBeenCalledOnce();
        expect(harness.session.getTelemetry()).toMatchObject({ presentationMode: 'worker', workerReused: true });
        return stopPromise;
    });

    it('presents on the page for the worker\'s life once its renderer is unavailable', () => {
        const harness = createSessionHarness();
        startSession(harness.session, FIRST_GENERATION);
        const [ worker ] = harness.workers;
        emitRendererStatus(worker, FIRST_GENERATION, false);

        const [ startRequest ] = worker.getPostedRequests('start');
        expect(startRequest).not.toHaveProperty('presentationMode');
        expect(harness.session.getTelemetry()).toMatchObject({
            presentationMode: 'main',
            rendererUnavailableReason: RENDERER_UNAVAILABLE_REASON
        });

        // A second answer never changes the worker's mode
        emitRendererStatus(worker, FIRST_GENERATION, true);
        expect(worker.getPostedRequests('start')).toHaveLength(1);
        expect(harness.session.getTelemetry().presentationMode).toBe('main');
    });

    it('bounds the renderer\'s status and presents on the page once the bound expires', async () => {
        vi.useFakeTimers();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const harness = createSessionHarness();
        startSession(harness.session, FIRST_GENERATION);
        const [ worker ] = harness.workers;

        await vi.advanceTimersByTimeAsync(RENDERER_STATUS_TIMEOUT_MILLISECONDS - TIMER_RESOLUTION_MILLISECONDS);
        expect(worker.getPostedRequests('start')).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(TIMER_RESOLUTION_MILLISECONDS);

        expect(worker.getPostedRequests('start')).toEqual([ expect.not.objectContaining({ presentationMode: 'worker' }) ]);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining(RENDERER_STATUS_TIMEOUT_WARNING));
        expect(harness.session.getTelemetry()).toMatchObject({
            presentationMode: 'main',
            rendererUnavailableReason: RENDERER_STATUS_TIMEOUT_REASON
        });

        // A renderer that answers after the bound changes nothing
        emitRendererStatus(worker, FIRST_GENERATION, true);
        expect(worker.getPostedRequests('start')).toHaveLength(1);
        expect(harness.session.getTelemetry().presentationMode).toBe('main');
    });

    it('starts at once on the page without a provider or an attachment', () => {
        const withoutProvider = createSessionHarness(null);
        startSession(withoutProvider.session, FIRST_GENERATION);
        expect(withoutProvider.workers[0].postedMessages).toEqual([
            expect.objectContaining({ generation: FIRST_GENERATION, type: 'start' })
        ]);
        expect(withoutProvider.session.getTelemetry()).toMatchObject({
            presentationMode: 'main',
            rendererUnavailableReason: null
        });

        const withoutAttachment = createSessionHarness((): WorkerPresentationAttachment | null => null);
        startSession(withoutAttachment.session, FIRST_GENERATION);
        expect(withoutAttachment.provider).toHaveBeenCalledOnce();
        expect(withoutAttachment.workers[0].postedMessages).toEqual([
            expect.objectContaining({ generation: FIRST_GENERATION, type: 'start' })
        ]);
        expect(withoutAttachment.session.getTelemetry()).toMatchObject({
            presentationMode: 'main',
            rendererUnavailableReason: RENDERER_ATTACHMENT_UNAVAILABLE_REASON
        });
    });

    it('selects worker frames like any other and releases dropped and presented ones with their credits', () => {
        const harness = createSessionHarness();
        const worker = startWorkerPresentedGeneration(harness, FIRST_GENERATION);
        emitDescriptor(worker, FIRST_GENERATION, 0, FIRST_FRAME_SECONDS);
        emitDescriptor(worker, FIRST_GENERATION, 1, SECOND_FRAME_SECONDS);
        emitDescriptor(worker, FIRST_GENERATION, 2, THIRD_FRAME_SECONDS);
        expect(harness.events.at(-1)).toMatchObject({ generation: FIRST_GENERATION, type: 'ready' });

        const presentationFrame = takeFrameAt(harness.session, SECOND_FRAME_SECONDS);
        expect(presentationFrame).toEqual({
            decodeGeneration: FIRST_GENERATION,
            displayHeight: DISPLAY_HEIGHT,
            displayWidth: DISPLAY_WIDTH,
            durationMicroseconds: FRAME_DURATION_MICROSECONDS,
            frameId: 1,
            mediaTimeMicroseconds: secondsToMicroseconds(SECOND_FRAME_SECONDS),
            outputMode: 'worker-frame'
        });
        // The dropped frame's credit returns with its release, not with a pull
        expect(worker.getPostedRequests('release-frames')).toEqual([
            { frameIds: [ 0 ], generation: FIRST_GENERATION, type: 'release-frames' }
        ]);
        expect(harness.session.acknowledgeFrame(presentationFrame)).toBe(true);
        expect(worker.getPostedRequests('release-frames').at(-1)).toEqual({
            frameIds: [ 1 ],
            generation: FIRST_GENERATION,
            type: 'release-frames'
        });
        expect(harness.session.discardFrame(takeFrameAt(harness.session, THIRD_FRAME_SECONDS))).toBe(true);
        expect(worker.getPostedRequests('release-frames').at(-1)).toMatchObject({ frameIds: [ 2 ] });
        expect(worker.getPostedRequests('pull')).toEqual([]);
        expect(harness.session.getTelemetry()).toMatchObject({
            droppedFrameCount: 1,
            pendingFrameCount: 0,
            queuedFrameCount: 0,
            receivedFrameCount: 3,
            takenFrameCount: 2
        });
    });

    it('bounds the worker frames the page holds, selected ones included, by the run\'s credits', () => {
        const harness = createSessionHarness();
        const worker = startWorkerPresentedGeneration(harness, FIRST_GENERATION);
        for (let frameId = 0; frameId < MAX_DECODED_FRAME_CREDITS; frameId += 1) {
            emitDescriptor(worker, FIRST_GENERATION, frameId, FIRST_FRAME_SECONDS + frameId);
        }
        takeFrameAt(harness.session, FIRST_FRAME_SECONDS);
        expect(harness.session.getTelemetry()).toMatchObject({ pendingFrameCount: 1, queuedFrameCount: MAX_DECODED_FRAME_CREDITS - 1 });

        emitDescriptor(worker, FIRST_GENERATION, MAX_DECODED_FRAME_CREDITS, FIRST_FRAME_SECONDS + MAX_DECODED_FRAME_CREDITS);
        expect(getErrorMessages(harness.events)).toEqual([ FRAME_QUEUE_BOUND_FAILURE ]);
    });

    it('rejects payloads from a worker-presented run, descriptors from a page-presented one, and reused frame IDs', () => {
        const workerPresented = createSessionHarness();
        const worker = startWorkerPresentedGeneration(workerPresented, FIRST_GENERATION);
        const payloadFrame = { close: vi.fn() };
        worker.emitMessage({
            durationMicroseconds: FRAME_DURATION_MICROSECONDS,
            frame: payloadFrame,
            generation: FIRST_GENERATION,
            mediaTimeMicroseconds: secondsToMicroseconds(FIRST_FRAME_SECONDS),
            outputMode: 'video-frame',
            type: 'frame'
        });
        expect(payloadFrame.close).toHaveBeenCalledOnce();
        expect(getErrorMessages(workerPresented.events)).toEqual([ UNEXPECTED_FRAME_OUTPUT_MODE_FAILURE ]);

        const pagePresented = createSessionHarness(null);
        startSession(pagePresented.session, FIRST_GENERATION);
        const [ pageWorker ] = pagePresented.workers;
        emitReady(pageWorker, FIRST_GENERATION);
        emitDescriptor(pageWorker, FIRST_GENERATION, 0, FIRST_FRAME_SECONDS);
        expect(getErrorMessages(pagePresented.events)).toEqual([ UNEXPECTED_FRAME_OUTPUT_MODE_FAILURE ]);

        const reusedIdentifier = createSessionHarness();
        const reusingWorker = startWorkerPresentedGeneration(reusedIdentifier, FIRST_GENERATION);
        emitDescriptor(reusingWorker, FIRST_GENERATION, 0, FIRST_FRAME_SECONDS);
        emitDescriptor(reusingWorker, FIRST_GENERATION, 0, SECOND_FRAME_SECONDS);
        expect(getErrorMessages(reusedIdentifier.events)).toEqual([ REUSED_FRAME_ID_FAILURE ]);
    });

    it('releases the worker frames of a replaced video epoch, queued and in flight', () => {
        const harness = createSessionHarness();
        const worker = startWorkerPresentedGeneration(harness, FIRST_GENERATION);
        emitDescriptor(worker, FIRST_GENERATION, 0, FIRST_FRAME_SECONDS);
        emitDescriptor(worker, FIRST_GENERATION, 1, SECOND_FRAME_SECONDS);

        expect(harness.session.resyncVideo(secondsToMicroseconds(THIRD_FRAME_SECONDS))).toBe(true);
        expect(worker.postedMessages.slice(-2)).toEqual([
            expect.objectContaining({ type: 'resync-video', videoEpoch: 1 }),
            { frameIds: [ 0, 1 ], generation: FIRST_GENERATION, type: 'release-frames' }
        ]);

        emitDescriptor(worker, FIRST_GENERATION, 2, SECOND_FRAME_SECONDS, { videoEpoch: 0 });
        expect(worker.getPostedRequests('release-frames').at(-1)).toMatchObject({ frameIds: [ 2 ] });
        emitDescriptor(worker, FIRST_GENERATION, 3, THIRD_FRAME_SECONDS, { videoEpoch: 1 });
        expect(harness.session.getTelemetry()).toMatchObject({ queuedFrameCount: 1, staleFrameCount: 3 });
        expect(getErrorMessages(harness.events)).toEqual([]);
    });

    it('releases the worker frames a stopped generation leaves before its run stops', async () => {
        const harness = createSessionHarness();
        const worker = startWorkerPresentedGeneration(harness, FIRST_GENERATION);
        emitDescriptor(worker, FIRST_GENERATION, 0, FIRST_FRAME_SECONDS);
        emitDescriptor(worker, FIRST_GENERATION, 1, SECOND_FRAME_SECONDS);
        const selectedFrame = takeFrameAt(harness.session, FIRST_FRAME_SECONDS);
        const postedBeforeStop = worker.postedMessages.length;

        const stopPromise = harness.session.stop();
        expect(worker.postedMessages.slice(postedBeforeStop)).toEqual([
            { frameIds: [ 1 ], generation: FIRST_GENERATION, type: 'release-frames' },
            { frameIds: [ 0 ], generation: FIRST_GENERATION, type: 'release-frames' },
            { generation: FIRST_GENERATION, type: 'stop' }
        ]);
        // The presenter's late answer for the selected frame no longer holds a credit
        expect(harness.session.acknowledgeFrame(selectedFrame)).toBe(false);
        worker.emitMessage({ generation: FIRST_GENERATION, type: 'stopped' });
        await stopPromise;
    });

    it('keeps a worker that asked for replacement until the generation presenting its frames retires', async () => {
        const harness = createSessionHarness();
        const worker = startWorkerPresentedGeneration(harness, FIRST_GENERATION);
        emitDescriptor(worker, FIRST_GENERATION, 0, FIRST_FRAME_SECONDS);
        worker.emitMessage({ generation: FIRST_GENERATION, type: 'ended' });
        worker.emitMessage({ generation: FIRST_GENERATION, replaceWorker: true, type: 'stopped' });

        // The ended run's last frame still presents from the worker
        expect(worker.terminate).not.toHaveBeenCalled();
        expect(harness.session.acknowledgeFrame(takeFrameAt(harness.session, FIRST_FRAME_SECONDS))).toBe(true);
        expect(worker.getPostedRequests('release-frames').at(-1)).toMatchObject({ frameIds: [ 0 ] });

        await harness.session.stop();
        expect(worker.terminate).toHaveBeenCalledOnce();
        startSession(harness.session, SECOND_GENERATION);
        expect(harness.workers).toHaveLength(2);
        expect(harness.provider).toHaveBeenCalledTimes(2);
        expect(harness.workers[1].postedMessages).toEqual([
            expect.objectContaining({ generation: SECOND_GENERATION, type: 'attach-renderer' })
        ]);
    });

    it('offers the replacement of an unresponsive worker a new attachment', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const harness = createSessionHarness();
        const firstWorker = startWorkerPresentedGeneration(harness, FIRST_GENERATION);

        startSession(harness.session, SECOND_GENERATION);
        await vi.advanceTimersByTimeAsync(WORKER_STOP_TIMEOUT_MILLISECONDS);
        expect(firstWorker.terminate).toHaveBeenCalledOnce();
        const [ , secondWorker ] = harness.workers;
        const [ , secondAttachment ] = harness.attachments;
        expect(secondWorker.postedMessages).toEqual([ {
            canvas: secondAttachment.canvas,
            generation: SECOND_GENERATION,
            port: secondAttachment.port,
            type: 'attach-renderer'
        } ]);

        emitRendererStatus(secondWorker, SECOND_GENERATION, true);
        expect(secondWorker.getPostedRequests('start')).toEqual([
            expect.objectContaining({ generation: SECOND_GENERATION, presentationMode: 'worker' })
        ]);
        expect(harness.session.getTelemetry().workerReused).toBe(false);
    });

    it('fails a start whose new worker crashes or misbehaves before its renderer reports, without another worker', () => {
        const crashed = createSessionHarness();
        startSession(crashed.session, FIRST_GENERATION);
        crashed.workers[0].emitError();
        expect(getErrorMessages(crashed.events)).toEqual([ WORKER_CRASH_FAILURE ]);
        expect(crashed.workers).toHaveLength(1);

        const misbehaving = createSessionHarness();
        startSession(misbehaving.session, FIRST_GENERATION);
        misbehaving.workers[0].emitMessage({ type: 'renderer-status' });
        expect(getErrorMessages(misbehaving.events)).toEqual([ INVALID_WORKER_MESSAGE_FAILURE ]);
        expect(misbehaving.workers[0].terminate).toHaveBeenCalledOnce();
        expect(misbehaving.workers).toHaveLength(1);
    });

    it('fails a generation whose worker crashes while it still holds the ended run\'s frames', () => {
        const harness = createSessionHarness();
        const worker = startWorkerPresentedGeneration(harness, FIRST_GENERATION);
        emitDescriptor(worker, FIRST_GENERATION, 0, FIRST_FRAME_SECONDS);
        worker.emitMessage({ generation: FIRST_GENERATION, type: 'ended' });
        worker.emitMessage({ generation: FIRST_GENERATION, type: 'stopped' });
        expect(harness.events.at(-1)).toMatchObject({ type: 'ended' });

        worker.emitError();
        expect(getErrorMessages(harness.events)).toEqual([ WORKER_CRASH_FAILURE ]);

        // Once every frame presented, the crash only costs the next start a new worker
        const drained = createSessionHarness();
        const drainedWorker = startWorkerPresentedGeneration(drained, FIRST_GENERATION);
        emitDescriptor(drainedWorker, FIRST_GENERATION, 0, FIRST_FRAME_SECONDS);
        drainedWorker.emitMessage({ generation: FIRST_GENERATION, type: 'ended' });
        drainedWorker.emitMessage({ generation: FIRST_GENERATION, type: 'stopped' });
        expect(drained.session.acknowledgeFrame(takeFrameAt(drained.session, FIRST_FRAME_SECONDS))).toBe(true);
        drainedWorker.emitError();
        expect(getErrorMessages(drained.events)).toEqual([]);
        startSession(drained.session, SECOND_GENERATION);
        expect(drained.workers).toHaveLength(2);
    });

    it('counts Dolby Vision and HDR10+ metadata from worker frame summaries', () => {
        const harness = createSessionHarness();
        const worker = startWorkerPresentedGeneration(harness, FIRST_GENERATION);
        emitDescriptor(worker, FIRST_GENERATION, 0, FIRST_FRAME_SECONDS, {
            metadataSummary: {
                dolbyVision: { enhancementLayerVCL: true, rpuCount: DOLBY_VISION_RPU_COUNT },
                HDR10PlusStatus: 'valid'
            }
        });
        emitDescriptor(worker, FIRST_GENERATION, 1, SECOND_FRAME_SECONDS, {
            metadataSummary: { HDR10PlusStatus: 'malformed' }
        });

        expect(harness.session.getTelemetry()).toMatchObject({
            receivedDolbyVisionEnhancementFrameCount: 1,
            receivedDolbyVisionFrameCount: 1,
            receivedDolbyVisionRPUCount: DOLBY_VISION_RPU_COUNT,
            receivedHDR10PlusMalformedFrameCount: 1,
            receivedHDR10PlusValidFrameCount: 1
        });
    });
});
