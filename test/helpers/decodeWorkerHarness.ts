// The browser around the playback worker: its global scope, which plays the session's part, range requests for the media it plays, and a WebCodecs video decoder

import { expect, vi } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';
import {
    isDecodeWorkerRequest,
    isDecodeWorkerResponse,
    MAX_DECODED_FRAME_CREDITS,
    type DecodeWorkerResponse,
    type DecodeWorkerStartRequest
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';

export type DecodeWorkerFrameResponse = Extract<DecodeWorkerResponse, { type: 'frame' }>;
export type DecodeWorkerReadyResponse = Extract<DecodeWorkerResponse, { type: 'ready' }>;

const WORKER_URL = 'https://example.test/web/libraries/webgpu-player/CustomDecode.worker.js';
const MEDIA_URL_PREFIX = 'https://example.test/media/';
export const DOLBY_VISION_RPU_PARSER_WASM_URL = 'https://example.test/web/libraries/webgpu-player/dovi-rpu-parser.wasm';
const GENERATION = 7;
const MAXIMUM_CODED_DIMENSION = 3_840;
// The session returns one credit for each VideoFrame it receives
const RETURNED_FRAME_CREDITS = 1;
const OPEN_ENDED_RANGE_PATTERN = /^bytes=(\d+)-$/;
// A raw-plane copy reads a decoded frame as 10-bit 4:2:0 in BT.2020 PQ
const DECODED_FRAME_FORMAT = 'I420P10';
const DECODED_FRAME_COLOR_SPACE = {
    fullRange: false,
    matrix: 'bt2020-ncl',
    primaries: 'bt2020',
    transfer: 'pq'
};
// The responses that end a run whose video reached its end
const COMPLETED_RUN_RESPONSE_TYPES: readonly DecodeWorkerResponse['type'][] = [ 'video-ended', 'ended', 'stopped' ];

export class FakeEncodedVideoChunk {
    public readonly data: Uint8Array;
    public readonly duration: number | null;
    public readonly timestamp: number;
    public readonly type: EncodedVideoChunkType;

    public constructor(init: EncodedVideoChunkInit) {
        this.data = new Uint8Array(init.data as Uint8Array);
        this.duration = init.duration ?? null;
        this.timestamp = init.timestamp;
        this.type = init.type;
    }
}

/** A decoded frame of its decoder's coded size, which a raw-plane copy reads as I420P10. */
export class FakeDecodedVideoFrame {
    public readonly close = vi.fn();
    public readonly colorSpace = DECODED_FRAME_COLOR_SPACE;
    public readonly displayHeight: number;
    public readonly displayWidth: number;
    public readonly format = DECODED_FRAME_FORMAT;
    public readonly visibleRect: DOMRectInit;

    public constructor(
        public readonly codedWidth: number,
        public readonly codedHeight: number,
        public readonly timestamp: number,
        public readonly duration: number | null
    ) {
        this.displayHeight = codedHeight;
        this.displayWidth = codedWidth;
        this.visibleRect = { height: codedHeight, width: codedWidth, x: 0, y: 0 };
    }

    // A real copy returns the layout it was asked for
    public copyTo(_destination: AllowSharedBufferSource, options?: VideoFrameCopyToOptions): Promise<PlaneLayout[]> {
        return Promise.resolve(options?.layout ?? []);
    }
}

/** A WebCodecs VideoDecoder that outputs one frame of its configured size per chunk, asynchronously as WebCodecs does. */
export class FakeVideoDecoder {
    public static readonly instances: FakeVideoDecoder[] = [];
    public readonly chunks: FakeEncodedVideoChunk[] = [];
    public configuration: VideoDecoderConfig | null = null;
    public readonly decodeQueueSize = 0;
    public ondequeue: ((event: Event) => unknown) | null = null;
    public state: CodecState = 'unconfigured';

    public constructor(private readonly init: VideoDecoderInit) {
        FakeVideoDecoder.instances.push(this);
    }

    public static isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
        return Promise.resolve({ config, supported: true });
    }

    public configure(config: VideoDecoderConfig): void {
        this.configuration = config;
        this.state = 'configured';
    }

    public decode(chunk: FakeEncodedVideoChunk): void {
        this.chunks.push(chunk);
        const frame = this.createFrame(chunk);
        void Promise.resolve().then((): void => {
            this.init.output(frame as unknown as VideoFrame);
        });
    }

    // Outputs queued before the flush run first
    public async flush(): Promise<void> {
        await Promise.resolve();
    }

    public close(): void {
        this.state = 'closed';
    }

    private createFrame(chunk: FakeEncodedVideoChunk): FakeDecodedVideoFrame {
        const codedWidth = this.configuration?.codedWidth;
        const codedHeight = this.configuration?.codedHeight;
        if (codedWidth === undefined || codedHeight === undefined) {
            throw new Error('The decoder was configured without the coded size its frames take');
        }
        return new FakeDecodedVideoFrame(codedWidth, codedHeight, chunk.timestamp, chunk.duration);
    }
}

/** The worker's global scope, which plays the session's part: it returns each frame's credit and resolves once the run stops. */
export class FakeWorkerScope extends EventTarget {
    public readonly responses: DecodeWorkerResponse[] = [];
    private resolveStopped: (() => void) | null = null;
    public readonly stopped = new Promise<void>(resolve => {
        this.resolveStopped = resolve;
    });

    public postMessage(message: DecodeWorkerResponse): void {
        this.responses.push(message);
        switch (message.type) {
            case 'frame':
                this.returnFrameCredit(message);
                break;
            case 'stopped':
                this.resolveStopped?.();
                break;
            default:
                break;
        }
    }

    public dispatchRequest(request: unknown): void {
        this.dispatchEvent(new MessageEvent('message', { data: request }));
    }

    // The session recycles a raw frame's buffer once uploaded, and returns a VideoFrame's credit once presented
    private returnFrameCredit(message: DecodeWorkerFrameResponse): void {
        if (message.outputMode === 'raw-planes') {
            const buffer = message.frame.data;
            void Promise.resolve().then((): void => {
                this.dispatchRequest({ buffer, generation: message.generation, type: 'recycle-frame' });
            });
            return;
        }
        (message.frame as unknown as FakeDecodedVideoFrame).close();
        void Promise.resolve().then((): void => {
            this.dispatchRequest({ frameCredits: RETURNED_FRAME_CREDITS, generation: message.generation, type: 'pull' });
        });
    }
}

function getMediaURL(fileName: string): string {
    return `${MEDIA_URL_PREFIX}${fileName}`;
}

/** Returns a request's Range header from the plain header object Mediabunny's UrlSource passes. */
function getRangeHeader(requestInit: RequestInit | undefined): string {
    const headers = (requestInit?.headers ?? {}) as Record<string, string>;
    const rangeKey = Object.keys(headers).find(key => key.toLowerCase() === 'range');
    return rangeKey ? headers[rangeKey] : '';
}

/** Serves files as a range-capable media endpoint: Mediabunny asks for open-ended ranges. */
function createMediaFetch(files: ReadonlyMap<string, Uint8Array>): typeof fetch {
    return async (input: RequestInfo | URL, requestInit?: RequestInit): Promise<Response> => {
        const data = files.get(String(input));
        if (!data) {
            return new Response(null, { status: 404 });
        }
        const rangeMatch = OPEN_ENDED_RANGE_PATTERN.exec(getRangeHeader(requestInit));
        const firstByte = rangeMatch ? Number(rangeMatch[1]) : 0;
        const body = new Uint8Array(data.byteLength - firstByte);
        body.set(data.subarray(firstByte));
        if (!rangeMatch) {
            return new Response(body, { status: 200 });
        }
        return new Response(body, {
            headers: {
                'Content-Length': String(body.byteLength),
                'Content-Range': `bytes ${firstByte}-${data.byteLength - 1}/${data.byteLength}`
            },
            status: 206
        });
    };
}

/**
 * Loads a fresh playback worker in a scope that serves each media file by name, and returns the scope.
 * Call vi.resetModules() before it, and vi.unstubAllGlobals() once the test ends.
 */
export async function startDecodeWorker(mediaFiles: ReadonlyMap<string, Uint8Array>): Promise<FakeWorkerScope> {
    FakeVideoDecoder.instances.length = 0;
    const files = new Map<string, Uint8Array>();
    for (const [ fileName, data ] of mediaFiles) {
        files.set(getMediaURL(fileName), data);
    }
    const workerScope = new FakeWorkerScope();
    // The playback worker's scope, which resolves assets from its own URL; a worker's global scope is an event target
    vi.stubGlobal('self', workerScope);
    vi.stubGlobal('addEventListener', vi.fn());
    vi.stubGlobal('location', { href: WORKER_URL });
    vi.stubGlobal('importScripts', () => undefined);
    vi.stubGlobal('fetch', createMediaFetch(files));
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
    await import('webgpu-player/pipeline/CustomDecode.worker');
    return workerScope;
}

/** Returns a start request for a served file on a native VideoFrame route without audio; overrides select another route. */
export function createWorkerStartRequest(
    fileName: string,
    overrides: Partial<DecodeWorkerStartRequest> = {}
): DecodeWorkerStartRequest {
    return {
        audioSampleCredits: 0,
        audioTrackIndex: null,
        dolbyVisionProfile: null,
        dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
        frameCredits: MAX_DECODED_FRAME_CREDITS,
        generation: GENERATION,
        maximumCodedHeight: MAXIMUM_CODED_DIMENSION,
        maximumCodedWidth: MAXIMUM_CODED_DIMENSION,
        nativeHDRTransfer: null,
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat: null,
        startTimeMicroseconds: 0 as Microseconds,
        type: 'start',
        url: getMediaURL(fileName),
        videoDecoderBackend: 'native',
        videoOutputMode: 'video-frame',
        videoTrackIndex: 0,
        ...overrides
    };
}

/** Starts a decode, waits until its run stops, and requires the run to reach the end of its video with only responses the session accepts. */
export async function decodeToEnd(workerScope: FakeWorkerScope, request: DecodeWorkerStartRequest): Promise<DecodeWorkerResponse[]> {
    expect(isDecodeWorkerRequest(request)).toBe(true);
    workerScope.dispatchRequest(request);
    await workerScope.stopped;

    const responseTypes = workerScope.responses.map(response => response.type);
    expect(responseTypes).not.toContain('error');
    expect(responseTypes.slice(-COMPLETED_RUN_RESPONSE_TYPES.length)).toEqual(COMPLETED_RUN_RESPONSE_TYPES);
    // The session drops any response its validator rejects
    expect(workerScope.responses.filter(response => !isDecodeWorkerResponse(response))).toEqual([]);
    return workerScope.responses;
}

export function getFrameResponses(responses: readonly DecodeWorkerResponse[]): DecodeWorkerFrameResponse[] {
    return responses.filter((response: DecodeWorkerResponse): response is DecodeWorkerFrameResponse => response.type === 'frame');
}

export function getReadyResponse(responses: readonly DecodeWorkerResponse[]): DecodeWorkerReadyResponse {
    const readyResponse = responses.find(response => response.type === 'ready');
    if (readyResponse?.type !== 'ready') {
        throw new Error('The worker posted no ready response');
    }
    return readyResponse;
}
