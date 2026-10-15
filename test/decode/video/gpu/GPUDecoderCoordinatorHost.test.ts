// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    GPUDecoderParserError,
    type GPUDecoderParserModule,
    type GPUDecoderParserOutput,
    type GPUDecoderParserPicture
} from 'webgpu-player/decode/video/gpu/GPUDecoderParser';
import GPUDecoderCoordinatorHost, { type GPUDecoderParserRemotePipeline } from 'webgpu-player/decode/video/gpu/GPUDecoderCoordinatorHost';
import type { GPUDecoderCoordinatorRequest, GPUDecoderCoordinatorResponse } from 'webgpu-player/decode/video/gpu/GPUDecoderCoordinatorProtocol';
import { GPU_DECODER_PARSER_WATCHDOG_MILLISECONDS } from 'webgpu-player/decode/video/gpu/GPUDecoderParseWorkerPool';
import type { GPUDecoderPictureSize } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';

import { encodeWebAssemblyModule } from '../../../helpers/webAssemblyModuleEncoder';

// The parser's checks: a configuration it refuses, and slice data it cannot parse, which its header lets the engine recover from
const CONFIGURATION_ERROR_CODE = 1;
const CONFIGURATION_ERROR_VALUE = 4;
const SLICE_DATA_ERROR_CODE = 11;
const SLICE_DATA_ERROR_VALUE = 7;
const PARSER_MODULE: GPUDecoderParserModule = {
    errorNames: new Map([ [ CONFIGURATION_ERROR_CODE, 'configuration' ], [ SLICE_DATA_ERROR_CODE, 'sliceData' ] ]),
    errorRecoveries: new Map([ [ SLICE_DATA_ERROR_CODE, 'resync' ] ]),
    memory: { initialPages: 1, maximumPages: 16 },
    module: new WebAssembly.Module(encodeWebAssemblyModule({})),
    repeatDirectiveCount: 0
};
// The parser's package, by its id and the SHA-256 of its file
const PACKAGE_VERSION = { contentHash: 'cd'.repeat(32), id: 'hevc' };
const CODEC_PRIVATE = Uint8Array.of(1, 2, 3, 4);
const PACKET_BYTE_LENGTH = 32;
const RECORD_BYTE_LENGTH = 128;
const WATCHDOG_MILLISECONDS = 2_000;
// The watchdog span many times over, which a host that owes nothing waits out
const IDLE_SPAN_COUNT = 10;
const FIRST_EVENTS = Uint32Array.of(0);
const SECOND_EVENTS = Uint32Array.of(1, 0x8000_0002);
const CONFIGURE_FAILURE_MESSAGE = `parser configuration: ${CONFIGURATION_ERROR_VALUE}`;
const PACKET_FAILURE_MESSAGE = `parser sliceData: ${SLICE_DATA_ERROR_VALUE}`;
// A failure that is no check of the parser, as the coordinator reports without a code
const UNCODED_FAILURE_MESSAGE = 'parser plan: RuntimeError: unreachable';
const WORKER_ERROR_MESSAGE = 'Script failed to load';
const UNKNOWN_PIPELINE_ID = 41;
// The largest picture an opened pipeline's codec private data declares, and one no picture can have
const MAXIMUM_PICTURE_SIZE: GPUDecoderPictureSize = { height: 720, width: 1280 };
const EMPTY_PICTURE_SIZE = { height: 0, width: 1280 };
const PICTURE_SIZE: GPUDecoderPictureSize = { height: 288, width: 352 };
const REPEAT_COUNTS = [ 3 ];
// The output format a picture reported, as a stream that changes format mid-stream does
const PICTURE_FORMAT = 'I444P12';
// The fields a picture reported, which cross the worker boundary with it
const PICTURE_FIELDS = { repeatFirstField: false, scan: 'bottom-first' } as const;

/** A packet's result of one picture with its events, or of no picture, its events trailing. */
function createResult(sequence: number, events: Uint32Array, record: ArrayBuffer | null): GPUDecoderCoordinatorResponse {
    const pictures: GPUDecoderParserPicture[] = record ? [ { events, fields: null, format: null, maximumPictureSize: null, record, repeatCounts: [], visibleSize: null } ] : [];
    return { pictures, pipelineId: 0, sequence, trailingEvents: record ? new Uint32Array(0) : events, type: 'result' };
}

type PostedRequest = Readonly<{
    request: GPUDecoderCoordinatorRequest
    transfer: readonly Transferable[]
}>;

/** A coordinator worker as the host sees it: the requests it received with their transfers, and the answers and errors the test makes it send. */
class FakeCoordinatorWorker {
    public onerror: ((event: ErrorEvent) => void) | null = null;
    public onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    public readonly posted: PostedRequest[] = [];
    public terminated = false;

    public get requests(): GPUDecoderCoordinatorRequest[] {
        return this.posted.map((posted: PostedRequest): GPUDecoderCoordinatorRequest => posted.request);
    }

    public postMessage(request: GPUDecoderCoordinatorRequest, transfer: Transferable[] = []): void {
        this.posted.push({ request, transfer: [ ...transfer ] });
    }

    public terminate(): void {
        this.terminated = true;
    }

    public respond(response: GPUDecoderCoordinatorResponse | Record<string, unknown>): void {
        this.onmessage?.({ data: response } as MessageEvent<unknown>);
    }

    public fail(message: string): void {
        this.onerror?.({ message } as ErrorEvent);
    }
}

type HostHarness = {
    host: GPUDecoderCoordinatorHost
    workers: FakeCoordinatorWorker[]
};

function createHost(): HostHarness {
    const workers: FakeCoordinatorWorker[] = [];
    const host = new GPUDecoderCoordinatorHost((): Worker => {
        const worker = new FakeCoordinatorWorker();
        workers.push(worker);
        return worker as unknown as Worker;
    }, WATCHDOG_MILLISECONDS);
    return { host, workers };
}

/** Opens a pipeline and answers its open, as a worker whose configure succeeded does, with the largest picture the codec private data declared. */
async function openPipeline(harness: HostHarness, maximumPictureSize: GPUDecoderPictureSize | null = null): Promise<GPUDecoderParserRemotePipeline> {
    const opening = harness.host.open(PARSER_MODULE, PACKAGE_VERSION, CODEC_PRIVATE);
    const worker = harness.workers.at(-1) as FakeCoordinatorWorker;
    const openRequest = worker.requests.at(-1) as GPUDecoderCoordinatorRequest;
    worker.respond({ maximumPictureSize, pipelineId: openRequest.pipelineId, type: 'opened' });
    return opening;
}

/** Settles a promise to its value or its failure, so a rejection the test awaits later is never unhandled. */
function capture<Value>(promise: Promise<Value>): Promise<Value | unknown> {
    return promise.catch((error: unknown): unknown => error);
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('GPUDecoderCoordinatorHost', () => {
    it('starts its worker on the first open and opens a pipeline with a copy of the codec private data', async () => {
        const harness = createHost();
        expect(harness.workers).toHaveLength(0);

        await openPipeline(harness);

        expect(harness.workers).toHaveLength(1);
        const [ { request, transfer } ] = harness.workers[0].posted;
        expect(request).toEqual({ codecPrivate: CODEC_PRIVATE.buffer, packageVersion: PACKAGE_VERSION, parser: PARSER_MODULE, pipelineId: 0, type: 'open' });
        expect(transfer).toEqual([ (request as Extract<GPUDecoderCoordinatorRequest, { type: 'open' }>).codecPrivate ]);
        expect(transfer[0]).not.toBe(CODEC_PRIVATE.buffer);
    });

    it('opens a pipeline without codec private data, transferring nothing', async () => {
        const harness = createHost();

        const opening = harness.host.open(PARSER_MODULE, PACKAGE_VERSION, null);
        harness.workers[0].respond({ maximumPictureSize: null, pipelineId: 0, type: 'opened' });
        const pipeline = await opening;

        expect(harness.workers[0].posted[0]).toEqual({ request: { codecPrivate: null, packageVersion: PACKAGE_VERSION, parser: PARSER_MODULE, pipelineId: 0, type: 'open' }, transfer: [] });
        expect(pipeline.maximumPictureSize).toBeNull();
    });

    it('posts only the id and content hash of a whole package it opens with', () => {
        const harness = createHost();
        const wholePackage = { ...PACKAGE_VERSION, module: PARSER_MODULE.module, name: 'HEVC' };

        void capture(harness.host.open(PARSER_MODULE, wholePackage, null));

        const request = harness.workers[0].requests[0] as Extract<GPUDecoderCoordinatorRequest, { type: 'open' }>;
        expect(request.packageVersion).toEqual(PACKAGE_VERSION);
    });

    it('gives an opened pipeline the largest picture its codec private data declares, and ignores an open answer with an empty one', async () => {
        const harness = createHost();
        const opening = harness.host.open(PARSER_MODULE, PACKAGE_VERSION, CODEC_PRIVATE);
        let opened = false;
        void opening.then((): void => {
            opened = true;
        });

        harness.workers[0].respond({ maximumPictureSize: EMPTY_PICTURE_SIZE, pipelineId: 0, type: 'opened' });
        await vi.advanceTimersByTimeAsync(0);
        expect(opened).toBe(false);
        harness.workers[0].respond({ maximumPictureSize: MAXIMUM_PICTURE_SIZE, pipelineId: 0, type: 'opened' });

        await expect(opening).resolves.toMatchObject({ maximumPictureSize: MAXIMUM_PICTURE_SIZE });
    });

    it('submits packets in sequence, transferring each, and resolves each with its own result', async () => {
        const harness = createHost();
        const pipeline = await openPipeline(harness);
        const firstPacket = new ArrayBuffer(PACKET_BYTE_LENGTH);
        const secondPacket = new ArrayBuffer(PACKET_BYTE_LENGTH);
        const record = new ArrayBuffer(RECORD_BYTE_LENGTH);

        const first = pipeline.submit(firstPacket);
        const second = pipeline.submit(secondPacket);
        const worker = harness.workers[0];
        worker.respond(createResult(1, SECOND_EVENTS, null));
        worker.respond(createResult(0, FIRST_EVENTS, record));

        expect(worker.posted.slice(1)).toEqual([
            { request: { packet: firstPacket, pipelineId: 0, sequence: 0, type: 'submit' }, transfer: [ firstPacket ] },
            { request: { packet: secondPacket, pipelineId: 0, sequence: 1, type: 'submit' }, transfer: [ secondPacket ] }
        ]);
        await expect(first).resolves.toEqual({
            pictures: [ { events: FIRST_EVENTS, fields: null, format: null, maximumPictureSize: null, record, repeatCounts: [], visibleSize: null } ],
            trailingEvents: new Uint32Array(0)
        } satisfies GPUDecoderParserOutput);
        await expect(second).resolves.toEqual({ pictures: [], trailingEvents: SECOND_EVENTS } satisfies GPUDecoderParserOutput);
    });

    it('resolves a packet with each of its pictures, in decode order, with their sizes, formats, and repeat counts', async () => {
        const harness = createHost();
        const pipeline = await openPipeline(harness);
        const hidden: GPUDecoderParserPicture = {
            events: FIRST_EVENTS,
            fields: null,
            format: null,
            maximumPictureSize: null,
            record: new ArrayBuffer(RECORD_BYTE_LENGTH),
            repeatCounts: REPEAT_COUNTS,
            visibleSize: null
        };
        const shown: GPUDecoderParserPicture = {
            events: SECOND_EVENTS,
            fields: PICTURE_FIELDS,
            format: PICTURE_FORMAT,
            maximumPictureSize: MAXIMUM_PICTURE_SIZE,
            record: new ArrayBuffer(RECORD_BYTE_LENGTH),
            repeatCounts: REPEAT_COUNTS,
            visibleSize: PICTURE_SIZE
        };

        const packet = pipeline.submit(new ArrayBuffer(PACKET_BYTE_LENGTH));
        harness.workers[0].respond({ pictures: [ hidden, shown ], pipelineId: 0, sequence: 0, trailingEvents: new Uint32Array(0), type: 'result' });

        await expect(packet).resolves.toEqual({ pictures: [ hidden, shown ], trailingEvents: new Uint32Array(0) });
    });

    it('rejects a packet the worker failed, and an open whose configure failed, with the parser\'s check, code, and value', async () => {
        const harness = createHost();
        const pipeline = await openPipeline(harness);
        const packet = capture(pipeline.submit(new ArrayBuffer(PACKET_BYTE_LENGTH)));
        harness.workers[0].respond({
            code: SLICE_DATA_ERROR_CODE,
            message: PACKET_FAILURE_MESSAGE,
            pipelineId: 0,
            sequence: 0,
            type: 'failed',
            value: SLICE_DATA_ERROR_VALUE
        });

        const opening = capture(harness.host.open(PARSER_MODULE, PACKAGE_VERSION, CODEC_PRIVATE));
        harness.workers[0].respond({
            code: CONFIGURATION_ERROR_CODE,
            message: CONFIGURE_FAILURE_MESSAGE,
            pipelineId: 1,
            sequence: null,
            type: 'failed',
            value: CONFIGURATION_ERROR_VALUE
        });

        const packetFailure = await packet;
        expect(packetFailure).toBeInstanceOf(GPUDecoderParserError);
        expect(packetFailure).toMatchObject({ code: SLICE_DATA_ERROR_CODE, message: PACKET_FAILURE_MESSAGE, value: SLICE_DATA_ERROR_VALUE });
        expect(await opening).toMatchObject({ code: CONFIGURATION_ERROR_CODE, message: CONFIGURE_FAILURE_MESSAGE, value: CONFIGURATION_ERROR_VALUE });
        expect(harness.workers[0].requests.at(-1)).toEqual({ pipelineId: 1, type: 'close' });
        expect(harness.workers).toHaveLength(1);
    });

    it('rejects a packet with the worker\'s message alone when its failure is no check of the parser', async () => {
        const harness = createHost();
        const pipeline = await openPipeline(harness);
        const packet = capture(pipeline.submit(new ArrayBuffer(PACKET_BYTE_LENGTH)));

        harness.workers[0].respond({ code: 0, message: UNCODED_FAILURE_MESSAGE, pipelineId: 0, sequence: 0, type: 'failed', value: 0 });

        const failure = await packet;
        expect(failure).not.toBeInstanceOf(GPUDecoderParserError);
        expect(failure).toEqual(new Error(UNCODED_FAILURE_MESSAGE));
    });

    it('replaces an open pipeline: the packets it owed reject, and the worker closes it', async () => {
        const harness = createHost();
        const pipeline = await openPipeline(harness);
        const owed = capture(pipeline.submit(new ArrayBuffer(PACKET_BYTE_LENGTH)));

        const replacement = harness.host.open(PARSER_MODULE, PACKAGE_VERSION, null);

        expect(await owed).toEqual(new Error('parser pipeline replaced'));
        expect(harness.workers[0].requests.slice(-2)).toEqual([
            { pipelineId: 0, type: 'close' },
            { codecPrivate: null, packageVersion: PACKAGE_VERSION, parser: PARSER_MODULE, pipelineId: 1, type: 'open' }
        ]);
        await expect(pipeline.submit(new ArrayBuffer(PACKET_BYTE_LENGTH))).rejects.toThrow('parser pipeline closed');
        harness.workers[0].respond({ maximumPictureSize: null, pipelineId: 1, type: 'opened' });
        await expect(replacement).resolves.toBeDefined();
    });

    it('closes a pipeline, rejecting the packets it still owed and every later one', async () => {
        const harness = createHost();
        const pipeline = await openPipeline(harness);
        const owed = capture(pipeline.submit(new ArrayBuffer(PACKET_BYTE_LENGTH)));

        pipeline.close();

        expect(await owed).toEqual(new Error('parser pipeline closed'));
        expect(harness.workers[0].requests.at(-1)).toEqual({ pipelineId: 0, type: 'close' });
        await expect(pipeline.submit(new ArrayBuffer(PACKET_BYTE_LENGTH))).rejects.toThrow('parser pipeline closed');
    });

    it('ignores a malformed response and one for a pipeline it has no longer', async () => {
        const harness = createHost();
        const pipeline = await openPipeline(harness);
        let settled = false;
        const packet = pipeline.submit(new ArrayBuffer(PACKET_BYTE_LENGTH)).finally((): void => {
            settled = true;
        });

        harness.workers[0].respond({ pictures: [], pipelineId: 0, sequence: 0, trailingEvents: [ 0 ], type: 'result' });
        harness.workers[0].respond({
            pictures: [ { events: FIRST_EVENTS, record: new ArrayBuffer(RECORD_BYTE_LENGTH), repeatCounts: [ -1 ], visibleSize: null } ],
            pipelineId: 0,
            sequence: 0,
            trailingEvents: new Uint32Array(0),
            type: 'result'
        });
        harness.workers[0].respond({ ...createResult(0, FIRST_EVENTS, null), pipelineId: UNKNOWN_PIPELINE_ID });
        await vi.advanceTimersByTimeAsync(0);

        expect(settled).toBe(false);
        harness.workers[0].respond(createResult(0, FIRST_EVENTS, null));
        await expect(packet).resolves.toEqual({ pictures: [], trailingEvents: FIRST_EVENTS });
    });

    it('ends a worker that leaves a packet unanswered for the watchdog span, failing every pipeline, and starts another for the next open', async () => {
        const harness = createHost();
        const pipeline = await openPipeline(harness);
        const owed = capture(pipeline.submit(new ArrayBuffer(PACKET_BYTE_LENGTH)));

        await vi.advanceTimersByTimeAsync(WATCHDOG_MILLISECONDS - 1);
        expect(harness.workers[0].terminated).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        expect(harness.workers[0].terminated).toBe(true);
        expect(await owed).toEqual(new Error(`parser-timeout: the coordinator worker made no progress in ${WATCHDOG_MILLISECONDS} ms`));
        await expect(pipeline.submit(new ArrayBuffer(PACKET_BYTE_LENGTH))).rejects.toThrow('parser pipeline closed');
        await openPipeline(harness);
        expect(harness.workers).toHaveLength(2);
    });

    it('fails an open the worker never answers once the watchdog span passes', async () => {
        const harness = createHost();
        const opening = capture(harness.host.open(PARSER_MODULE, PACKAGE_VERSION, CODEC_PRIVATE));

        await vi.advanceTimersByTimeAsync(WATCHDOG_MILLISECONDS);

        expect(await opening).toEqual(new Error(`parser-timeout: the coordinator worker made no progress in ${WATCHDOG_MILLISECONDS} ms`));
        expect(harness.workers[0].terminated).toBe(true);
    });

    it('restarts the watchdog on every answer, and stops it once nothing is owed', async () => {
        const harness = createHost();
        const pipeline = await openPipeline(harness);
        const first = pipeline.submit(new ArrayBuffer(PACKET_BYTE_LENGTH));
        const second = pipeline.submit(new ArrayBuffer(PACKET_BYTE_LENGTH));

        await vi.advanceTimersByTimeAsync(WATCHDOG_MILLISECONDS - 1);
        harness.workers[0].respond(createResult(0, FIRST_EVENTS, null));
        await vi.advanceTimersByTimeAsync(WATCHDOG_MILLISECONDS - 1);
        harness.workers[0].respond(createResult(1, FIRST_EVENTS, null));
        await vi.advanceTimersByTimeAsync(WATCHDOG_MILLISECONDS * IDLE_SPAN_COUNT);

        expect(harness.workers[0].terminated).toBe(false);
        await expect(Promise.all([ first, second ])).resolves.toHaveLength(2);
    });

    it('waits the engine\'s watchdog span unless it is given one', async () => {
        const workers: FakeCoordinatorWorker[] = [];
        const host = new GPUDecoderCoordinatorHost((): Worker => {
            const worker = new FakeCoordinatorWorker();
            workers.push(worker);
            return worker as unknown as Worker;
        });
        const opening = capture(host.open(PARSER_MODULE, PACKAGE_VERSION, null));

        await vi.advanceTimersByTimeAsync(GPU_DECODER_PARSER_WATCHDOG_MILLISECONDS - 1);
        expect(workers[0].terminated).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        expect(workers[0].terminated).toBe(true);
        expect(await opening).toBeInstanceOf(Error);
    });

    it('fails every pipeline on a worker error and starts a new worker for the next open', async () => {
        const harness = createHost();
        const pipeline = await openPipeline(harness);
        const owed = capture(pipeline.submit(new ArrayBuffer(PACKET_BYTE_LENGTH)));

        harness.workers[0].fail(WORKER_ERROR_MESSAGE);

        expect(await owed).toEqual(new Error(`parser coordinator worker error: ${WORKER_ERROR_MESSAGE}`));
        expect(harness.workers[0].terminated).toBe(true);
        await openPipeline(harness);
        expect(harness.workers).toHaveLength(2);
    });

    it('ends its worker once destroyed, rejecting every packet it owed', async () => {
        const harness = createHost();
        const pipeline = await openPipeline(harness);
        const owed = capture(pipeline.submit(new ArrayBuffer(PACKET_BYTE_LENGTH)));

        harness.host.destroy();

        expect(await owed).toEqual(new Error('parser coordinator worker destroyed'));
        expect(harness.workers[0].terminated).toBe(true);
    });
});
