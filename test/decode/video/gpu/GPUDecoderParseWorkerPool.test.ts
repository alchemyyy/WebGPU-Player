// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GPUDecoderParserError, type GPUDecoderParserModule } from 'webgpu-player/decode/video/gpu/GPUDecoderParser';
import type {
    GPUDecoderParseJobRequest,
    GPUDecoderParseRequest,
    GPUDecoderParseResponse
} from 'webgpu-player/decode/video/gpu/GPUDecoderParseProtocol';
import GPUDecoderParseWorkerPool, {
    getGPUDecoderParseWorkerCount,
    GPU_DECODER_PARSER_WATCHDOG_MILLISECONDS
} from 'webgpu-player/decode/video/gpu/GPUDecoderParseWorkerPool';

import { encodeWebAssemblyModule } from '../../../helpers/webAssemblyModuleEncoder';

const SLICE_DATA_ERROR_CODE = 11;
const SLICE_DATA_ERROR_VALUE = 7;
const PARSER_MODULE: GPUDecoderParserModule = {
    errorNames: new Map([ [ SLICE_DATA_ERROR_CODE, 'sliceData' ] ]),
    memory: { initialPages: 1, maximumPages: 16 },
    module: new WebAssembly.Module(encodeWebAssemblyModule({})),
    repeatDirectiveCount: 0
};
const WORKER_COUNT = 3;
const WATCHDOG_MILLISECONDS = 1_000;
const PLAN_BYTE_LENGTH = 64;
const JOB_BYTE_LENGTH = 96;
const FIRST_UNIT = 4;
const UNIT_COUNT = 2;
const PARSE_FAILURE_MESSAGE = 'RangeError: memory access out of bounds';
const WORKER_ERROR_MESSAGE = 'Script failed to load';
const UNKNOWN_JOB_ID = 99;
// A job's watchdog span many times over, which an idle pool waits out without failing
const IDLE_SPAN_COUNT = 10;
// Core counts and the parse workers each allows: two cores stay reserved, at most six workers start, and at least one
const WORKER_COUNTS_BY_CORES = [
    { cores: undefined, workerCount: 2 },
    { cores: 0, workerCount: 2 },
    { cores: 1, workerCount: 1 },
    { cores: 3, workerCount: 1 },
    { cores: 4, workerCount: 2 },
    { cores: 8, workerCount: 6 },
    { cores: 24, workerCount: 6 }
] as const;

/** A parse worker as the pool sees it: the requests it received, and the answers and errors the test makes it send. */
class FakeParseWorker {
    public onerror: ((event: ErrorEvent) => void) | null = null;
    public onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    public readonly requests: GPUDecoderParseRequest[] = [];
    public terminated = false;

    public get parseRequests(): GPUDecoderParseJobRequest[] {
        return this.requests.filter((request: GPUDecoderParseRequest): request is GPUDecoderParseJobRequest => request.type === 'parse');
    }

    public postMessage(request: GPUDecoderParseRequest): void {
        this.requests.push(request);
    }

    public terminate(): void {
        this.terminated = true;
    }

    public respond(response: GPUDecoderParseResponse | Record<string, unknown>): void {
        this.onmessage?.({ data: response } as MessageEvent<unknown>);
    }

    public fail(message: string): void {
        this.onerror?.({ message } as ErrorEvent);
    }
}

type PoolHarness = {
    pool: GPUDecoderParseWorkerPool
    workers: FakeParseWorker[]
};

/** Starts a pool of fake workers; a null watchdog span leaves the engine's own. */
function createPool(watchdogMilliseconds: number | null = WATCHDOG_MILLISECONDS): PoolHarness {
    const workers: FakeParseWorker[] = [];
    const pool = new GPUDecoderParseWorkerPool({
        createWorker: (): Worker => {
            const worker = new FakeParseWorker();
            workers.push(worker);
            return worker as unknown as Worker;
        },
        parser: PARSER_MODULE,
        ...(watchdogMilliseconds === null ? {} : { watchdogMilliseconds }),
        workerCount: WORKER_COUNT
    });
    return { pool, workers };
}

function parse(pool: GPUDecoderParseWorkerPool): Promise<ArrayBuffer> {
    return pool.parse(new ArrayBuffer(PLAN_BYTE_LENGTH), FIRST_UNIT, UNIT_COUNT);
}

/** Settles a job to its job or its failure, so a rejection the test awaits later is never unhandled. */
function capture(job: Promise<ArrayBuffer>): Promise<ArrayBuffer | unknown> {
    return job.catch((error: unknown): unknown => error);
}

/** Returns the index of the worker that received each job, by job id. */
function getWorkerIndicesByJob(workers: readonly FakeParseWorker[]): number[] {
    const workerIndices: number[] = [];
    for (const [ workerIndex, worker ] of workers.entries()) {
        for (const request of worker.parseRequests) {
            workerIndices[request.id] = workerIndex;
        }
    }
    return workerIndices;
}

function respondParsed(worker: FakeParseWorker, id: number, job: ArrayBuffer = new ArrayBuffer(JOB_BYTE_LENGTH)): void {
    worker.respond({ id, job, type: 'parsed' });
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('GPUDecoderParseWorkerPool', () => {
    it('starts every worker on the parser module', () => {
        const { pool, workers } = createPool();

        expect(pool.workerCount).toBe(WORKER_COUNT);
        expect(pool.failed).toBe(false);
        expect(workers.map(worker => worker.requests)).toEqual(new Array(WORKER_COUNT).fill([ { parser: PARSER_MODULE, type: 'start' } ]));
    });

    it('sends each job to the worker with the fewest jobs outstanding, the first of equals', () => {
        const { pool, workers } = createPool();
        for (let jobIndex = 0; jobIndex <= WORKER_COUNT; jobIndex += 1) {
            void capture(parse(pool));
        }

        respondParsed(workers[1], 1);
        void capture(parse(pool));

        expect(getWorkerIndicesByJob(workers)).toEqual([ 0, 1, 2, 0, 1 ]);
        expect(workers[0].parseRequests[0]).toMatchObject({ firstUnit: FIRST_UNIT, id: 0, type: 'parse', unitCount: UNIT_COUNT });
    });

    it('resolves a parsed job, and rejects a failed one with its check named by the parser\'s error names', async () => {
        const { pool, workers } = createPool();
        const job = new ArrayBuffer(JOB_BYTE_LENGTH);
        const parsed = parse(pool);
        const failedCheck = capture(parse(pool));
        const trapped = capture(parse(pool));

        respondParsed(workers[0], 0, job);
        workers[1].respond({ code: SLICE_DATA_ERROR_CODE, id: 1, message: '', type: 'failed', value: SLICE_DATA_ERROR_VALUE });
        workers[2].respond({ code: 0, id: 2, message: PARSE_FAILURE_MESSAGE, type: 'failed', value: 0 });

        await expect(parsed).resolves.toBe(job);
        const checkFailure = await failedCheck;
        expect(checkFailure).toBeInstanceOf(GPUDecoderParserError);
        expect(checkFailure).toMatchObject({ code: SLICE_DATA_ERROR_CODE, message: `parser sliceData: ${SLICE_DATA_ERROR_VALUE}`, value: SLICE_DATA_ERROR_VALUE });
        expect(await trapped).toEqual(new Error(`parser parse: ${PARSE_FAILURE_MESSAGE}`));
        expect(pool.failed).toBe(false);
    });

    it('ignores a malformed response and one for no outstanding job', async () => {
        const { pool, workers } = createPool();
        let settled = false;
        const job = parse(pool).finally((): void => {
            settled = true;
        });

        workers[0].respond({ id: 0, job: new Uint8Array(JOB_BYTE_LENGTH), type: 'parsed' });
        respondParsed(workers[0], UNKNOWN_JOB_ID);
        await vi.advanceTimersByTimeAsync(0);

        expect(settled).toBe(false);
        respondParsed(workers[0], 0);
        await expect(job).resolves.toBeInstanceOf(ArrayBuffer);
    });

    it('stops once its jobs made no progress for the watchdog span, failing every outstanding and later job', async () => {
        const { pool, workers } = createPool();
        const outstanding = [ capture(parse(pool)), capture(parse(pool)) ];
        const timeout = new Error(`parser-timeout: ${outstanding.length} parse jobs made no progress in ${WATCHDOG_MILLISECONDS} ms`);

        await vi.advanceTimersByTimeAsync(WATCHDOG_MILLISECONDS - 1);
        expect(pool.failed).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        expect(pool.failed).toBe(true);
        expect(await Promise.all(outstanding)).toEqual([ timeout, timeout ]);
        await expect(parse(pool)).rejects.toThrow(timeout.message);
        expect(workers.every(worker => worker.terminated)).toBe(true);
    });

    it('restarts the watchdog on every answer, and keeps none while no job is outstanding', async () => {
        const { pool, workers } = createPool();
        void capture(parse(pool));
        const second = capture(parse(pool));

        await vi.advanceTimersByTimeAsync(WATCHDOG_MILLISECONDS - 1);
        respondParsed(workers[0], 0);
        await vi.advanceTimersByTimeAsync(WATCHDOG_MILLISECONDS - 1);
        expect(pool.failed).toBe(false);
        respondParsed(workers[1], 1);
        await vi.advanceTimersByTimeAsync(WATCHDOG_MILLISECONDS * IDLE_SPAN_COUNT);

        expect(pool.failed).toBe(false);
        expect(await second).toBeInstanceOf(ArrayBuffer);
    });

    it('waits the engine\'s watchdog span unless its options set one', async () => {
        const { pool } = createPool(null);
        const job = capture(parse(pool));

        await vi.advanceTimersByTimeAsync(GPU_DECODER_PARSER_WATCHDOG_MILLISECONDS - 1);
        expect(pool.failed).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        expect(pool.failed).toBe(true);
        expect(await job).toEqual(new Error(`parser-timeout: 1 parse jobs made no progress in ${GPU_DECODER_PARSER_WATCHDOG_MILLISECONDS} ms`));
    });

    it('stops on a worker error, which leaves that worker\'s state unknown', async () => {
        const { pool, workers } = createPool();
        const job = capture(parse(pool));

        workers[1].fail(WORKER_ERROR_MESSAGE);

        expect(pool.failed).toBe(true);
        expect(await job).toEqual(new Error(`parser parse worker error: ${WORKER_ERROR_MESSAGE}`));
        expect(workers.every(worker => worker.terminated)).toBe(true);
    });

    it('rejects outstanding and later jobs once destroyed, and keeps its first failure', async () => {
        const { pool, workers } = createPool();
        const job = capture(parse(pool));

        pool.destroy();
        workers[0].fail(WORKER_ERROR_MESSAGE);

        const destroyed = new Error('parser parse workers destroyed');
        expect(await job).toEqual(destroyed);
        await expect(parse(pool)).rejects.toThrow(destroyed.message);
        expect(workers.every(worker => worker.terminated)).toBe(true);
    });
});

describe('getGPUDecoderParseWorkerCount', () => {
    it.each(WORKER_COUNTS_BY_CORES)('starts $workerCount parse workers on $cores cores', ({ cores, workerCount }) => {
        expect(getGPUDecoderParseWorkerCount(cores)).toBe(workerCount);
    });
});
