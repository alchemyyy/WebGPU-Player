// The parse workers of a parser, which its coordinator worker keeps across attempts.
// Each job goes to the worker with the fewest jobs outstanding; a worker parses its jobs one at a time, in arrival order.
// A package's module may loop forever, so a pool whose jobs make no progress for the watchdog's span stops, as does one whose worker fails.
import { GPUDecoderParserError, type GPUDecoderParserModule } from './GPUDecoderParser';
import { type GPUDecoderParseRequest, type GPUDecoderParseResponse, isGPUDecoderParseResponse } from './GPUDecoderParseProtocol';

/** How long jobs may wait without any worker answering before the pool counts its workers hung. */
export const GPU_DECODER_PARSER_WATCHDOG_MILLISECONDS = 30_000;

// Six workers parse a 2160p tiled HEVC stream at several times real time; more mostly add memory
const MAXIMUM_PARSE_WORKERS = 6;
// The page, the decode worker, the coordinator worker, and the browser's GPU process keep cores of their own
const RESERVED_CORES = 2;
const DEFAULT_HARDWARE_CONCURRENCY = 4;

/** Returns how many parse workers a device's cores allow, at least one; a device that reports no core count counts as four cores. */
export function getGPUDecoderParseWorkerCount(hardwareConcurrency: number | undefined): number {
    const cores = hardwareConcurrency !== undefined && hardwareConcurrency > 0 ? hardwareConcurrency : DEFAULT_HARDWARE_CONCURRENCY;
    return Math.max(1, Math.min(MAXIMUM_PARSE_WORKERS, cores - RESERVED_CORES));
}

type PendingJob = {
    reject: (error: Error) => void
    resolve: (job: ArrayBuffer) => void
    worker: PoolWorker
};

type PoolWorker = {
    outstanding: number
    worker: Worker
};

/** What a pool parses with: the parser module, how many workers, how they start, and its watchdog span. */
export type GPUDecoderParseWorkerPoolOptions = Readonly<{
    createWorker: () => Worker
    parser: GPUDecoderParserModule
    watchdogMilliseconds?: number
    workerCount: number
}>;

/** Parses planned pictures' units on parse workers. */
export default class GPUDecoderParseWorkerPool {
    private readonly errorNames: ReadonlyMap<number, string>;
    private failure: Error | null = null;
    private readonly jobs = new Map<number, PendingJob>();
    private nextJobId = 0;
    private watchdog: ReturnType<typeof setTimeout> | null = null;
    private readonly watchdogMilliseconds: number;
    private readonly workers: PoolWorker[] = [];

    /** Starts the workers, each on the parser module. */
    constructor(options: GPUDecoderParseWorkerPoolOptions) {
        this.errorNames = options.parser.errorNames;
        this.watchdogMilliseconds = options.watchdogMilliseconds ?? GPU_DECODER_PARSER_WATCHDOG_MILLISECONDS;
        for (let index = 0; index < options.workerCount; index += 1) {
            const worker = options.createWorker();
            const poolWorker: PoolWorker = { outstanding: 0, worker };
            worker.onmessage = (event: MessageEvent<unknown>): void => {
                this.receive(event.data);
            };
            // An uncaught worker error, such as a worker script that failed to load, leaves the worker's state unknown
            worker.onerror = (event: ErrorEvent): void => {
                this.fail(new Error(`parser parse worker error: ${event.message}`));
            };
            const start: GPUDecoderParseRequest = { parser: options.parser, type: 'start' };
            worker.postMessage(start);
            this.workers.push(poolWorker);
        }
    }

    /** Whether the pool stopped, from a worker error, its watchdog, or destroy(); a stopped pool rejects every job, so the next attempt needs a new pool. */
    get failed(): boolean {
        return this.failure !== null;
    }

    get workerCount(): number {
        return this.workers.length;
    }

    /** Parses units firstUnit to firstUnit + unitCount of a serialized plan; rejects with a GPUDecoderParserError for a failed check. */
    parse(plan: ArrayBuffer, firstUnit: number, unitCount: number): Promise<ArrayBuffer> {
        if (this.failure) {
            return Promise.reject(this.failure);
        }
        let target = this.workers[0];
        for (const candidate of this.workers) {
            if (candidate.outstanding < target.outstanding) {
                target = candidate;
            }
        }
        const id = this.nextJobId;
        this.nextJobId += 1;
        target.outstanding += 1;
        return new Promise<ArrayBuffer>((resolve, reject) => {
            this.jobs.set(id, { reject, resolve, worker: target });
            this.armWatchdog();
            // The plan may go to several workers, so each receives a copy
            const request: GPUDecoderParseRequest = { firstUnit, id, plan, type: 'parse', unitCount };
            target.worker.postMessage(request);
        });
    }

    destroy(): void {
        this.fail(new Error('parser parse workers destroyed'));
    }

    private receive(message: unknown): void {
        if (!isGPUDecoderParseResponse(message)) {
            return;
        }
        const job = this.jobs.get(message.id);
        if (!job) {
            return;
        }
        this.jobs.delete(message.id);
        job.worker.outstanding -= 1;
        this.clearWatchdog();
        if (this.jobs.size > 0) {
            this.armWatchdog();
        }
        settleJob(job, message, this.errorNames);
    }

    /** Starts the watchdog unless it runs; any answer restarts it. */
    private armWatchdog(): void {
        if (this.watchdog !== null || this.failure) {
            return;
        }
        this.watchdog = setTimeout((): void => {
            this.watchdog = null;
            if (this.jobs.size > 0) {
                this.fail(new Error(`parser-timeout: ${this.jobs.size} parse jobs made no progress in ${this.watchdogMilliseconds} ms`));
            }
        }, this.watchdogMilliseconds);
    }

    private clearWatchdog(): void {
        if (this.watchdog !== null) {
            clearTimeout(this.watchdog);
            this.watchdog = null;
        }
    }

    /** Stops every worker and rejects every outstanding and later job with the failure. */
    private fail(failure: Error): void {
        if (this.failure) {
            return;
        }
        this.failure = failure;
        this.clearWatchdog();
        for (const poolWorker of this.workers) {
            poolWorker.worker.terminate();
        }
        for (const job of this.jobs.values()) {
            job.reject(failure);
        }
        this.jobs.clear();
    }
}

function settleJob(job: PendingJob, message: GPUDecoderParseResponse, errorNames: ReadonlyMap<number, string>): void {
    if (message.type === 'parsed') {
        job.resolve(message.job);
        return;
    }
    job.reject(message.code === 0 ? new Error(`parser parse: ${message.message}`) : new GPUDecoderParserError(message.code, message.value, errorNames));
}
