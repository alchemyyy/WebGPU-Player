// The parser coordinator worker and parse workers of a video decoder package, run in this process on message channels, since Node has no browser Worker.
// Each starts by its URL, as the engine starts them: the coordinator worker starts its parse workers through the same Worker global, as GPUDecoderCoordinator.worker.ts does.
import { createEngineWorker, type EngineWorkerPath } from 'webgpu-player/EngineAssets';
import { startGPUDecoderCoordinatorWorkerRuntime } from 'webgpu-player/decode/video/gpu/GPUDecoderCoordinatorWorkerRuntime';
import { startGPUDecoderParseWorkerRuntime } from 'webgpu-player/decode/video/gpu/GPUDecoderParseWorkerRuntime';

export const GPU_DECODER_COORDINATOR_WORKER_PATH = 'webgpu-player/GPUDecoderCoordinator.worker.js' satisfies EngineWorkerPath;
export const GPU_DECODER_PARSE_WORKER_PATH = 'webgpu-player/GPUDecoderParse.worker.js' satisfies EngineWorkerPath;

// Resolves the bare paths a scope without a location starts workers by
const RELATIVE_URL_BASE = 'https://in-process.test/';

/** Stands in for a Worker the engine constructs: the runtime its URL names answers on the far end of a message channel. */
export class InProcessGPUDecoderWorker {
    public static readonly instances: InProcessGPUDecoderWorker[] = [];
    public onerror: ((event: ErrorEvent) => void) | null = null;
    public onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    public onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
    public terminated = false;
    public readonly url: string;
    private readonly port: MessagePort;

    public constructor(url: string | URL, parseWorkerCount: number) {
        this.url = String(url);
        const path = new URL(this.url, RELATIVE_URL_BASE).pathname;
        const channel = new MessageChannel();
        this.port = channel.port1;
        this.port.onmessage = (event: MessageEvent<unknown>): void => {
            this.onmessage?.(event);
        };
        if (path.endsWith(GPU_DECODER_COORDINATOR_WORKER_PATH)) {
            startGPUDecoderCoordinatorWorkerRuntime(channel.port2, {
                createParseWorker: (): Worker => createEngineWorker(GPU_DECODER_PARSE_WORKER_PATH),
                parseWorkerCount
            });
        } else if (path.endsWith(GPU_DECODER_PARSE_WORKER_PATH)) {
            startGPUDecoderParseWorkerRuntime(channel.port2);
        } else {
            channel.port1.close();
            throw new Error(`No in-process GPU decoder worker serves ${this.url}`);
        }
        channel.port2.start();
        InProcessGPUDecoderWorker.instances.push(this);
    }

    /** Whether the worker runs the runtime of a worker path. */
    public runs(path: EngineWorkerPath): boolean {
        return new URL(this.url, RELATIVE_URL_BASE).pathname.endsWith(path);
    }

    public postMessage(message: unknown, transfer: Transferable[] = []): void {
        this.port.postMessage(message, transfer);
    }

    public terminate(): void {
        this.terminated = true;
        this.port.close();
    }
}

/** Returns the Worker constructor the engine finds, whose coordinator workers each start parseWorkerCount parse workers. */
export function createInProcessGPUDecoderWorkerConstructor(parseWorkerCount: number): new (url: string | URL) => InProcessGPUDecoderWorker {
    return class extends InProcessGPUDecoderWorker {
        public constructor(url: string | URL) {
            super(url, parseWorkerCount);
        }
    };
}

/** Ends every in-process GPU decoder worker the tests started, closing their channels. */
export function terminateInProcessGPUDecoderWorkers(): void {
    for (const worker of InProcessGPUDecoderWorker.instances.splice(0)) {
        worker.terminate();
    }
}
