// The runtime of the parser coordinator worker: one attempt's pipeline at a time, on the coordinator instance it creates, with parse workers it keeps while the package version stays.
// The decode worker only moves packets and records, so a package's module that loops never blocks demux or audio; the decode worker's watchdog ends this worker instead.
import { isSameDecoderPackageVersion, type DecoderPackageVersion } from '../../packages/DecoderPackageIdentity';
import GPUDecoderParserPipeline from './GPUDecoderParserPipeline';
import { isGPUDecoderCoordinatorRequest, type GPUDecoderCoordinatorOpenRequest, type GPUDecoderCoordinatorResponse } from './GPUDecoderCoordinatorProtocol';
import type { GPUDecoderParserOutput } from './GPUDecoderParser';
import GPUDecoderParseWorkerPool from './GPUDecoderParseWorkerPool';

/** The end of the channel the runtime answers on: the worker's global scope, or a message port in tests. */
export type GPUDecoderCoordinatorWorkerScope = {
    onmessage: ((event: MessageEvent<unknown>) => void) | null
    postMessage: (message: GPUDecoderCoordinatorResponse, transfer: Transferable[]) => void
};

/** What the runtime needs from its host: how many parse workers to start, and how to start one. */
export type GPUDecoderCoordinatorWorkerEnvironment = Readonly<{
    createParseWorker: () => Worker
    parseWorkerCount: number
}>;

type ActivePipeline = {
    pipeline: GPUDecoderParserPipeline | null
    pipelineId: number
};

type ActivePool = {
    packageVersion: DecoderPackageVersion
    pool: GPUDecoderParseWorkerPool
};

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Returns the buffers a packet's output transfers: each picture's record and events, and the trailing events.
 * A buffer two arrays share transfers once, and an empty one copies, since a transfer list may name a buffer only once.
 */
function getOutputTransfers(output: GPUDecoderParserOutput): Transferable[] {
    const buffers = new Set<ArrayBuffer>();
    const addBuffer = (buffer: ArrayBufferLike): void => {
        if (buffer instanceof ArrayBuffer && buffer.byteLength > 0) {
            buffers.add(buffer);
        }
    };
    for (const picture of output.pictures) {
        addBuffer(picture.record);
        addBuffer(picture.events.buffer);
    }
    addBuffer(output.trailingEvents.buffer);
    return [ ...buffers ];
}

/** Answers coordinator requests on the scope until the worker ends. */
export function startGPUDecoderCoordinatorWorkerRuntime(scope: GPUDecoderCoordinatorWorkerScope, environment: GPUDecoderCoordinatorWorkerEnvironment): void {
    let active: ActivePipeline | null = null;
    let activePool: ActivePool | null = null;

    const post = (response: GPUDecoderCoordinatorResponse, transfer: Transferable[] = []): void => {
        scope.postMessage(response, transfer);
    };

    /** Returns the parse workers of the request's package version, starting new ones when another package or version came, or the previous ones failed. */
    const getPool = (request: GPUDecoderCoordinatorOpenRequest): GPUDecoderParseWorkerPool => {
        if (activePool && isSameDecoderPackageVersion(activePool.packageVersion, request.packageVersion) && !activePool.pool.failed) {
            return activePool.pool;
        }
        activePool?.pool.destroy();
        const pool = new GPUDecoderParseWorkerPool({
            createWorker: environment.createParseWorker,
            parser: request.parser,
            workerCount: environment.parseWorkerCount
        });
        activePool = { packageVersion: request.packageVersion, pool };
        return pool;
    };

    const open = (request: GPUDecoderCoordinatorOpenRequest): void => {
        active?.pipeline?.destroy();
        const opening: ActivePipeline = { pipeline: null, pipelineId: request.pipelineId };
        active = opening;
        const pool = getPool(request);
        GPUDecoderParserPipeline.create(
            request.parser,
            request.codecPrivate ? new Uint8Array(request.codecPrivate) : null,
            (plan: ArrayBuffer, firstUnit: number, unitCount: number): Promise<ArrayBuffer> => pool.parse(plan, firstUnit, unitCount),
            pool.workerCount
        ).then(
            (pipeline: GPUDecoderParserPipeline): void => {
                if (active !== opening) {
                    pipeline.destroy();
                    return;
                }
                opening.pipeline = pipeline;
                post({ maximumPictureSize: pipeline.maximumPictureSize, pipelineId: request.pipelineId, type: 'opened' });
            },
            (error: unknown): void => {
                if (active === opening) {
                    post({ message: describeError(error), pipelineId: request.pipelineId, sequence: null, type: 'failed' });
                }
            }
        );
    };

    scope.onmessage = (event: MessageEvent<unknown>): void => {
        const request = event.data;
        if (!isGPUDecoderCoordinatorRequest(request)) {
            return;
        }
        switch (request.type) {
            case 'open':
                open(request);
                return;
            case 'close':
                if (active?.pipelineId === request.pipelineId) {
                    active.pipeline?.destroy();
                    active = null;
                }
                return;
            case 'submit': {
                const pipeline = active?.pipelineId === request.pipelineId ? active.pipeline : null;
                if (!pipeline) {
                    post({ message: 'parser pipeline not open', pipelineId: request.pipelineId, sequence: request.sequence, type: 'failed' });
                    return;
                }
                pipeline.submit(new Uint8Array(request.packet)).then(
                    (output: GPUDecoderParserOutput): void => {
                        post({
                            pictures: output.pictures,
                            pipelineId: request.pipelineId,
                            sequence: request.sequence,
                            trailingEvents: output.trailingEvents,
                            type: 'result'
                        }, getOutputTransfers(output));
                    },
                    (error: unknown): void => {
                        post({ message: describeError(error), pipelineId: request.pipelineId, sequence: request.sequence, type: 'failed' });
                    }
                );
                return;
            }
        }
    };
}
