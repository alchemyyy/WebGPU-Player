// The decode worker's side of its parser coordinator worker: it starts the worker on first use, opens one pipeline per attempt, and moves packets and outputs.
// A package's module may loop forever, so a worker that leaves requests unanswered for the watchdog's span is ended, failing what it owed.
import type { DecoderPackageVersion } from '../../packages/DecoderPackageIdentity';
import type { GPUDecoderParserModule, GPUDecoderParserOutput } from './GPUDecoderParser';
import {
    isGPUDecoderCoordinatorResponse,
    type GPUDecoderCoordinatorRequest,
    type GPUDecoderCoordinatorResponse
} from './GPUDecoderCoordinatorProtocol';
import { GPU_DECODER_PARSER_WATCHDOG_MILLISECONDS } from './GPUDecoderParseWorkerPool';
import type { GPUDecoderPictureSize } from './GPUDecodeTypes';

type PendingRequest = {
    reject: (error: Error) => void
    resolve: (output: GPUDecoderParserOutput) => void
};

type OpenPipeline = {
    opened: { reject: (error: Error) => void; resolve: (maximumPictureSize: GPUDecoderPictureSize | null) => void } | null
    pending: Map<number, PendingRequest>
};

/** One attempt's parser pipeline in the coordinator worker. */
export type GPUDecoderParserRemotePipeline = Readonly<{
    /** Ends the pipeline; packets it still owed reject */
    close: () => void
    /** The largest picture the track's codec private data declares, which the parser read when it configured, or null */
    maximumPictureSize: GPUDecoderPictureSize | null
    /** Hands over the next packet in decode order, transferring its bytes; outputs, each the packet's pictures, resolve in submission order */
    submit: (packet: ArrayBuffer) => Promise<GPUDecoderParserOutput>
}>;

/** Opens parser pipelines on one coordinator worker, which it starts on first use and starts again after a failure. */
export default class GPUDecoderCoordinatorHost {
    private readonly createWorker: () => Worker;
    private nextPipelineId = 0;
    private readonly pipelines = new Map<number, OpenPipeline>();
    private watchdog: ReturnType<typeof setTimeout> | null = null;
    private readonly watchdogMilliseconds: number;
    private worker: Worker | null = null;

    constructor(createWorker: () => Worker, watchdogMilliseconds: number = GPU_DECODER_PARSER_WATCHDOG_MILLISECONDS) {
        this.createWorker = createWorker;
        this.watchdogMilliseconds = watchdogMilliseconds;
    }

    /**
     * Opens a pipeline on a package's parser with the track's codec private data, replacing any open one; the package's id and content hash name the parser's version.
     * Rejects with the parser's failure, such as a codec private data its configure refused.
     */
    open(parser: GPUDecoderParserModule, packageVersion: DecoderPackageVersion, codecPrivate: Uint8Array | null): Promise<GPUDecoderParserRemotePipeline> {
        for (const pipelineId of [ ...this.pipelines.keys() ]) {
            this.closePipeline(pipelineId, new Error('parser pipeline replaced'));
        }
        const worker = this.requireWorker();
        const pipelineId = this.nextPipelineId;
        this.nextPipelineId += 1;
        const pipeline: OpenPipeline = { opened: null, pending: new Map<number, PendingRequest>() };
        this.pipelines.set(pipelineId, pipeline);
        const opened = new Promise<GPUDecoderPictureSize | null>((resolve, reject): void => {
            pipeline.opened = { reject, resolve };
        });
        const codecPrivateBuffer = codecPrivate ? codecPrivate.slice().buffer : null;
        // A caller may pass a whole package, so only its id and content hash are posted
        const version: DecoderPackageVersion = { contentHash: packageVersion.contentHash, id: packageVersion.id };
        this.post(worker, { codecPrivate: codecPrivateBuffer, packageVersion: version, parser, pipelineId, type: 'open' }, codecPrivateBuffer ? [ codecPrivateBuffer ] : []);
        let nextSequence = 0;
        return opened.then((maximumPictureSize: GPUDecoderPictureSize | null): GPUDecoderParserRemotePipeline => ({
            close: (): void => {
                this.closePipeline(pipelineId, new Error('parser pipeline closed'));
            },
            maximumPictureSize,
            submit: (packet: ArrayBuffer): Promise<GPUDecoderParserOutput> => {
                const current = this.pipelines.get(pipelineId);
                if (!current || this.worker === null) {
                    return Promise.reject(new Error('parser pipeline closed'));
                }
                const sequence = nextSequence;
                nextSequence += 1;
                return new Promise<GPUDecoderParserOutput>((resolve, reject): void => {
                    current.pending.set(sequence, { reject, resolve });
                    this.post(this.requireWorker(), { packet, pipelineId, sequence, type: 'submit' }, [ packet ]);
                });
            }
        }));
    }

    /** Ends the coordinator worker and its parse workers; every pipeline's outstanding packets reject. */
    destroy(): void {
        this.failWorker(new Error('parser coordinator worker destroyed'));
    }

    private requireWorker(): Worker {
        if (this.worker) {
            return this.worker;
        }
        const worker = this.createWorker();
        worker.onmessage = (event: MessageEvent<unknown>): void => {
            this.receive(event.data);
        };
        worker.onerror = (event: ErrorEvent): void => {
            this.failWorker(new Error(`parser coordinator worker error: ${event.message}`));
        };
        this.worker = worker;
        return worker;
    }

    private post(worker: Worker, request: GPUDecoderCoordinatorRequest, transfer: Transferable[]): void {
        worker.postMessage(request, transfer);
        this.armWatchdog();
    }

    private receive(message: unknown): void {
        if (!isGPUDecoderCoordinatorResponse(message)) {
            return;
        }
        this.clearWatchdog();
        this.settle(message);
        if (this.hasOutstandingRequests()) {
            this.armWatchdog();
        }
    }

    private settle(message: GPUDecoderCoordinatorResponse): void {
        const pipeline = this.pipelines.get(message.pipelineId);
        if (!pipeline) {
            return;
        }
        switch (message.type) {
            case 'opened':
                pipeline.opened?.resolve(message.maximumPictureSize);
                pipeline.opened = null;
                return;
            case 'result': {
                const request = pipeline.pending.get(message.sequence);
                pipeline.pending.delete(message.sequence);
                request?.resolve({ pictures: [ ...message.pictures ], trailingEvents: message.trailingEvents });
                return;
            }
            case 'failed': {
                const failure = new Error(message.message);
                if (message.sequence === null) {
                    this.closePipeline(message.pipelineId, failure);
                    return;
                }
                const request = pipeline.pending.get(message.sequence);
                pipeline.pending.delete(message.sequence);
                request?.reject(failure);
                return;
            }
        }
    }

    private hasOutstandingRequests(): boolean {
        for (const pipeline of this.pipelines.values()) {
            if (pipeline.opened !== null || pipeline.pending.size > 0) {
                return true;
            }
        }
        return false;
    }

    private closePipeline(pipelineId: number, failure: Error): void {
        const pipeline = this.pipelines.get(pipelineId);
        if (!pipeline) {
            return;
        }
        this.pipelines.delete(pipelineId);
        pipeline.opened?.reject(failure);
        for (const request of pipeline.pending.values()) {
            request.reject(failure);
        }
        if (this.worker) {
            this.worker.postMessage({ pipelineId, type: 'close' } satisfies GPUDecoderCoordinatorRequest);
        }
        if (!this.hasOutstandingRequests()) {
            this.clearWatchdog();
        }
    }

    /** Starts the watchdog unless it runs; any answer restarts it. */
    private armWatchdog(): void {
        if (this.watchdog !== null) {
            return;
        }
        this.watchdog = setTimeout((): void => {
            this.watchdog = null;
            if (this.hasOutstandingRequests()) {
                this.failWorker(new Error(`parser-timeout: the coordinator worker made no progress in ${this.watchdogMilliseconds} ms`));
            }
        }, this.watchdogMilliseconds);
    }

    private clearWatchdog(): void {
        if (this.watchdog !== null) {
            clearTimeout(this.watchdog);
            this.watchdog = null;
        }
    }

    /** Ends the worker and fails every pipeline with the failure; the next open starts a new worker. */
    private failWorker(failure: Error): void {
        this.clearWatchdog();
        this.worker?.terminate();
        this.worker = null;
        for (const [ pipelineId, pipeline ] of [ ...this.pipelines ]) {
            this.pipelines.delete(pipelineId);
            pipeline.opened?.reject(failure);
            for (const request of pipeline.pending.values()) {
                request.reject(failure);
            }
        }
    }
}
