// The audio decode worker a playback worker spawns, run in this process on one end of a channel, since Node has no browser Worker

import type { AudioDecodeWorkerScope } from 'webgpu-player/pipeline/AudioDecodeWorkerRuntime';

export type AudioDecodeWorkerRuntimeStarter = (scope: AudioDecodeWorkerScope) => void;

/** Stands in for the Worker the playback worker constructs: the audio decode worker's runtime answers on the channel's far end. */
export class InProcessAudioDecodeWorker {
    public static readonly instances: InProcessAudioDecodeWorker[] = [];
    public onerror: ((event: ErrorEvent) => void) | null = null;
    public onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    public onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
    public terminated = false;
    public readonly url: string;
    private readonly port: MessagePort;

    public constructor(url: string | URL, startRuntime: AudioDecodeWorkerRuntimeStarter) {
        this.url = String(url);
        InProcessAudioDecodeWorker.instances.push(this);
        const channel = new MessageChannel();
        this.port = channel.port1;
        this.port.onmessage = (event: MessageEvent<unknown>): void => {
            this.onmessage?.(event);
        };
        startRuntime(channel.port2);
        channel.port2.start();
    }

    public postMessage(message: unknown, transfer: Transferable[] = []): void {
        this.port.postMessage(message, transfer);
    }

    public terminate(): void {
        this.terminated = true;
        this.port.close();
    }
}

/**
 * Returns the Worker constructor the playback worker finds, bound to a runtime from the module registry the playback worker loads from.
 * After vi.resetModules() both then share one output stage module.
 */
export function createInProcessAudioDecodeWorkerConstructor(
    startRuntime: AudioDecodeWorkerRuntimeStarter
): new (url: string | URL) => InProcessAudioDecodeWorker {
    return class extends InProcessAudioDecodeWorker {
        public constructor(url: string | URL) {
            super(url, startRuntime);
        }
    };
}
