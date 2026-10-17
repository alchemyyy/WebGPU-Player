// @vitest-environment node

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES } from 'webgpu-player/decode/packages/DecoderPackageImports';
import {
    MAX_GPU_DECODE_PACKET_CREDITS,
    type DecodeWorkerGPUVideoParser,
    type DecodeWorkerResponse,
    type DecodeWorkerStartRequest
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import { GPU_DECODER_PARSER_STATUS } from 'webgpu-player/decode/video/gpu/GPUDecoderParser';
import type { GPUDecoderErrorRecovery } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';
import { findAV1SequenceHeader } from 'webgpu-player/demux/av1/AV1SequenceHeaderParser';

import { AV1_HDR10_PLUS_EXPECTATIONS, readAV1HDR10PlusVector } from '../helpers/av1HDR10PlusVectors';
import {
    createWorkerStartRequest,
    decodeToEnd,
    FakeVideoDecoder,
    getReadyResponse,
    startDecodeWorker
} from '../helpers/decodeWorkerHarness';
import { createParserStubModuleBinary, type ParserStubOptions } from '../helpers/decoderPackages';
import { createHEVCMatroska, createHEVCMatroskaWithKeyframes } from '../helpers/hevcMatroskaVector';
import {
    createInProcessGPUDecoderWorkerConstructor,
    GPU_DECODER_COORDINATOR_WORKER_PATH,
    InProcessGPUDecoderWorker,
    terminateInProcessGPUDecoderWorkers
} from '../helpers/inProcessGPUDecoderWorkers';

const MATROSKA_FILE_NAME = 'hevc-main10.mkv';
// The frame-pool route for a GPU HEVC decoder writing I420P10
const FRAME_POOL_ROUTE: Partial<DecodeWorkerStartRequest> = {
    frameCredits: MAX_GPU_DECODE_PACKET_CREDITS,
    gpuVideoCodec: 'hevc',
    rawVideoFrameFormat: 'I420P10',
    videoDecoderBackend: 'gpu',
    videoOutputMode: 'frame-pool'
};
// A codec the vector's HEVC track does not have
const MISMATCHED_GPU_VIDEO_CODEC = 'av1';
const MISMATCHED_CODEC_FAILURE = 'The selected hevc video track does not match the negotiated av1 decoder';
// An hvcC opens with its configuration version, and the vector's holds one array each of VPS, SPS, and PPS
const HVCC_CONFIGURATION_VERSION = 1;
const HVCC_ARRAY_COUNT_BYTE_INDEX = 22;
const HVCC_ARRAY_COUNT = 3;
// The x265 HDR10+ sample's chroma: 4:2:0, whose SPS declares the top-left location HDR encodes take
const X265_SAMPLE_CHROMA_FORMAT = { location: 'top-left', subsampling: '4:2:0' } as const;
const ANNEX_B_START_CODE = [ 0, 0, 0, 1 ];
// The parse workers each in-process coordinator worker starts
const PARSE_WORKER_COUNT = 2;
// A parser whose configure refuses every codec private data with the decoder's first error code
const CONFIGURATION_ERROR_CODE = 1;
const CONFIGURATION_ERROR_NAME = 'configuration';
// The stub parser's package, by its id and the SHA-256 of its file
const STUB_PACKAGE_VERSION = { contentHash: 'ef'.repeat(32), id: 'stub-parser' };
const CONFIGURE_FAILURE_MESSAGE = `parser ${CONFIGURATION_ERROR_NAME}: 0`;
// Where a stub parser keeps the events its plans report, below the input it reserves for whole packets in its 1 MiB,
// and the events of a plan without a picture: two earlier pictures, one presented, one dropped
const STUB_EVENTS_POINTER = 2_048;
const STUB_INPUT_POINTER = 4_096;
const STUB_PARSER_MEMORY_PAGES = 16;
const TRAILING_OUTPUT_EVENTS = Uint32Array.of(5, 0x8000_0006);
// A parser that makes three pictures of the vector's one packet, each a record of its own, which it reports at a visible size of its own
const STUB_OUTPUT_POINTER = 3_072;
const STUB_RECORD = Uint8Array.of(0x52, 0x31, 0x56, 0x41, 1, 2, 3, 4);
const PACKET_PICTURE_COUNT = 3;
const PICTURE_SIZE = { height: 288, width: 352 };
// The largest picture the stub's configure declares in the track's hvcC
const MAXIMUM_PICTURE_SIZE = { height: 2_160, width: 3_840 };
// A header with one repeat, whose count each picture reports
const REPEAT_DIRECTIVE_COUNT = 1;
const PICTURE_REPEAT_COUNT = 7;
// The AV1 vectors of one stream, as Matroska and MP4, on the frame-pool route of a GPU AV1 decoder
const AV1_VECTOR_FILE_NAMES = [ 'hdr10plus.mkv', 'hdr10plus.mp4' ] as const;
const AV1_FRAME_POOL_ROUTE: Partial<DecodeWorkerStartRequest> = { ...FRAME_POOL_ROUTE, gpuVideoCodec: 'av1' };
// An av1C opens with its marker bit and version 1, and its configOBUs follow its 4-byte header
const AV1_CONFIGURATION_RECORD_MARKER_AND_VERSION = 0x81;
const AV1_CONFIGURATION_RECORD_HEADER_BYTE_LENGTH = 4;
// A track of six packets whose fourth is a key packet, and a parser whose second plan on each instance fails with slice data damage its header recovers from
const RESYNC_FILE_NAME = 'hevc-resync.mkv';
const RESYNC_KEYFRAMES = [ true, false, false, true, false, false ];
const FRAME_DURATION_MICROSECONDS = 40_000;
const SLICE_DATA_ERROR_CODE = 11;
const SLICE_DATA_ERROR_NAME = 'sliceData';
const SLICE_DATA_ERROR_VALUE = 7;
const SLICE_DATA_ERROR_NAMES = new Map([ [ SLICE_DATA_ERROR_CODE, SLICE_DATA_ERROR_NAME ] ]);
const SLICE_DATA_RECOVERY = { code: 'resynced', errorName: `parser ${SLICE_DATA_ERROR_NAME}`, value: SLICE_DATA_ERROR_VALUE };
// Two generations a seek separates
const FIRST_RUN_GENERATION = 11;
const SECOND_RUN_GENERATION = 12;
// Long enough for a run to reach the parser output it waits for, were it not waiting already
const SETTLE_MILLISECONDS = 50;

type PacketResponse = Extract<DecodeWorkerResponse, { type: 'packet' }>;

function getPacketResponses(responses: readonly DecodeWorkerResponse[]): PacketResponse[] {
    return responses.filter((response: DecodeWorkerResponse): response is PacketResponse => response.type === 'packet');
}

function getGenerationResponses(responses: readonly DecodeWorkerResponse[], generation: number): DecodeWorkerResponse[] {
    return responses.filter(response => response.generation === generation);
}

function waitForSettled(): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, SETTLE_MILLISECONDS);
    });
}

/** The error lines of a stub parser's header: each code's name, and the recovery of those that declare one. */
type StubParserErrors = Readonly<{
    errorNames: ReadonlyMap<number, string>
    errorRecoveries: ReadonlyMap<number, GPUDecoderErrorRecovery>
}>;

const CONFIGURATION_ERRORS: StubParserErrors = {
    errorNames: new Map([ [ CONFIGURATION_ERROR_CODE, CONFIGURATION_ERROR_NAME ] ]),
    errorRecoveries: new Map()
};

/** The start request's parser field for a stub parser, whose exports return the options' constants, with its input above its data. */
function createStubParserField(
    options: ParserStubOptions,
    repeatDirectiveCount: number = 0,
    errors: StubParserErrors = CONFIGURATION_ERRORS
): DecodeWorkerGPUVideoParser {
    return {
        packageVersion: STUB_PACKAGE_VERSION,
        parser: {
            errorNames: errors.errorNames,
            errorRecoveries: errors.errorRecoveries,
            // The engine may give a module more pages than it declares, as the package's memory limits do
            memory: { initialPages: STUB_PARSER_MEMORY_PAGES, maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES },
            module: new WebAssembly.Module(createParserStubModuleBinary({ ...options, results: { reserveInput: STUB_INPUT_POINTER, ...options.results } })),
            repeatDirectiveCount
        }
    };
}

/** A stub parser whose every picture finishes to the stub's record, with the options' other results. */
function createRecordingParserField(
    options: ParserStubOptions,
    repeatDirectiveCount: number = 0,
    errors: StubParserErrors = CONFIGURATION_ERRORS
): DecodeWorkerGPUVideoParser {
    return createStubParserField({
        ...options,
        dataSegments: [ { bytes: STUB_RECORD, offset: STUB_OUTPUT_POINTER } ],
        results: { outputByteLength: STUB_RECORD.byteLength, outputPointer: STUB_OUTPUT_POINTER, ...options.results }
    }, repeatDirectiveCount, errors);
}

/** A stub parser that plans three pictures of each packet, each finishing to the stub's record at its own visible size with its repeat count. */
function createMultiplePictureParserField(): DecodeWorkerGPUVideoParser {
    return createRecordingParserField({
        results: {
            pictureHeight: PICTURE_SIZE.height,
            pictureRepeatCount: PICTURE_REPEAT_COUNT,
            pictureWidth: PICTURE_SIZE.width,
            plan: GPU_DECODER_PARSER_STATUS.morePictures
        },
        resultSequences: { planNext: [ GPU_DECODER_PARSER_STATUS.morePictures, GPU_DECODER_PARSER_STATUS.success ] }
    }, REPEAT_DIRECTIVE_COUNT);
}

/** Starts the coordinator worker and its parse workers in this process whenever the playback worker starts one. */
function serveGPUDecoderWorkers(): void {
    vi.stubGlobal('Worker', createInProcessGPUDecoderWorkerConstructor(PARSE_WORKER_COUNT));
}

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    terminateInProcessGPUDecoderWorkers();
    vi.unstubAllGlobals();
});

describe('CustomDecode.worker frame-pool route', () => {
    it('posts an hvc1 track\'s compressed packets with its hvcC as codec private data, and opens no WebCodecs decoder', async () => {
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, await createHEVCMatroska('length-prefixed') ] ]));

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MATROSKA_FILE_NAME, FRAME_POOL_ROUTE));

        const packets = getPacketResponses(responses);
        expect(packets).toHaveLength(1);
        expect(packets[0]).toMatchObject({ keyframe: true, timestampMicroseconds: 0, videoEpoch: 0 });
        // A decoder without a parser orders its own output, so its packets carry no output events
        expect(packets[0].outputEvents).toBeUndefined();
        const codecPrivate = new Uint8Array(getReadyResponse(responses).codecPrivate ?? new ArrayBuffer(0));
        expect(codecPrivate[0]).toBe(HVCC_CONFIGURATION_VERSION);
        expect(codecPrivate[HVCC_ARRAY_COUNT_BYTE_INDEX]).toBe(HVCC_ARRAY_COUNT);
        // The chroma the hvcC and its SPS declare, which every frame of the run carries
        expect(getReadyResponse(responses).chromaFormat).toEqual(X265_SAMPLE_CHROMA_FORMAT);
        expect(responses.some(response => response.type === 'frame')).toBe(false);
        expect(FakeVideoDecoder.instances).toEqual([]);
    });

    it('posts an hev1 track\'s Annex B packets, which carry their parameter sets, without codec private data', async () => {
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, await createHEVCMatroska('annex-b') ] ]));

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MATROSKA_FILE_NAME, FRAME_POOL_ROUTE));

        const packets = getPacketResponses(responses);
        expect(packets).toHaveLength(1);
        expect([ ...new Uint8Array(packets[0].data, 0, ANNEX_B_START_CODE.length) ]).toEqual(ANNEX_B_START_CODE);
        expect(getReadyResponse(responses).codecPrivate).toBeUndefined();
    });

    it.each(AV1_VECTOR_FILE_NAMES)('posts the av1C of %s as codec private data, which Mediabunny hands on as no description', async (fileName: string) => {
        const workerScope = await startDecodeWorker(new Map([ [ fileName, readAV1HDR10PlusVector(fileName) ] ]));

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(fileName, AV1_FRAME_POOL_ROUTE));

        const codecPrivate = new Uint8Array(getReadyResponse(responses).codecPrivate ?? new ArrayBuffer(0));
        expect(codecPrivate[0]).toBe(AV1_CONFIGURATION_RECORD_MARKER_AND_VERSION);
        expect(findAV1SequenceHeader(codecPrivate.subarray(AV1_CONFIGURATION_RECORD_HEADER_BYTE_LENGTH))).toMatchObject({
            maximumFrameHeight: AV1_HDR10_PLUS_EXPECTATIONS.height,
            maximumFrameWidth: AV1_HDR10_PLUS_EXPECTATIONS.width
        });
        expect(getPacketResponses(responses)).toHaveLength(AV1_HDR10_PLUS_EXPECTATIONS.frameCount);
    });

    it('configures an AV1 track\'s parser with its av1C', async () => {
        const [ fileName ] = AV1_VECTOR_FILE_NAMES;
        const workerScope = await startDecodeWorker(new Map([ [ fileName, readAV1HDR10PlusVector(fileName) ] ]));
        serveGPUDecoderWorkers();
        // The engine configures a parser only with codec private data, so a refusal shows the record arrived
        const refusingParser = createStubParserField({
            results: { configure: GPU_DECODER_PARSER_STATUS.failed, errorCode: CONFIGURATION_ERROR_CODE }
        });
        const request = createWorkerStartRequest(fileName, { ...AV1_FRAME_POOL_ROUTE, gpuVideoParser: refusingParser });

        workerScope.dispatchRequest(request);
        await workerScope.waitForStopped(request.generation);

        expect(workerScope.responses).toContainEqual({
            failureKind: 'decode-failed',
            generation: request.generation,
            message: CONFIGURE_FAILURE_MESSAGE,
            type: 'error'
        });
    });

    it('refuses a track of another codec than its GPU decoder takes', async () => {
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, await createHEVCMatroska() ] ]));
        const request = createWorkerStartRequest(MATROSKA_FILE_NAME, { ...FRAME_POOL_ROUTE, gpuVideoCodec: MISMATCHED_GPU_VIDEO_CODEC });

        workerScope.dispatchRequest(request);
        await workerScope.waitForStopped(request.generation);

        expect(workerScope.responses).toContainEqual({
            failureKind: 'source-unsupported',
            generation: request.generation,
            message: MISMATCHED_CODEC_FAILURE,
            type: 'error'
        });
        expect(getPacketResponses(workerScope.responses)).toEqual([]);
    });

    it('sends the output events of the track\'s last packets, which had no picture to carry them, with the video end', async () => {
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, await createHEVCMatroska('length-prefixed') ] ]));
        serveGPUDecoderWorkers();
        const picturelessParser = createStubParserField({
            dataSegments: [ { bytes: new Uint8Array(TRAILING_OUTPUT_EVENTS.buffer), offset: STUB_EVENTS_POINTER } ],
            results: { eventCount: TRAILING_OUTPUT_EVENTS.length, eventPointer: STUB_EVENTS_POINTER, plan: GPU_DECODER_PARSER_STATUS.noPicture }
        });

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MATROSKA_FILE_NAME, { ...FRAME_POOL_ROUTE, gpuVideoParser: picturelessParser }));

        // A packet without a picture spends no credit and posts nothing
        expect(getPacketResponses(responses)).toEqual([]);
        expect(responses.find(response => response.type === 'video-ended')).toMatchObject({ outputEvents: TRAILING_OUTPUT_EVENTS });
    });

    it('posts each picture its parser made of a packet as a packet of its own, with the packet\'s timing and the picture\'s size and repeat counts', async () => {
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, await createHEVCMatroska('length-prefixed') ] ]));
        serveGPUDecoderWorkers();

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MATROSKA_FILE_NAME, { ...FRAME_POOL_ROUTE, gpuVideoParser: createMultiplePictureParserField() }));

        const packets = getPacketResponses(responses);
        expect(packets).toHaveLength(PACKET_PICTURE_COUNT);
        for (const packet of packets) {
            expect(packet).toMatchObject({
                keyframe: true,
                repeatCounts: [ PICTURE_REPEAT_COUNT ],
                timestampMicroseconds: 0,
                videoEpoch: 0,
                visibleSize: PICTURE_SIZE
            });
            expect([ ...new Uint8Array(packet.data) ]).toEqual([ ...STUB_RECORD ]);
            expect(packet.outputEvents).toEqual(new Uint32Array(0));
        }
    });

    it('opens its parser before the track is ready, so the ready response carries the largest picture the codec private data declares', async () => {
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, await createHEVCMatroska('length-prefixed') ] ]));
        serveGPUDecoderWorkers();
        const declaringParser = createRecordingParserField({
            results: { maximumPictureHeight: MAXIMUM_PICTURE_SIZE.height, maximumPictureWidth: MAXIMUM_PICTURE_SIZE.width }
        });

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MATROSKA_FILE_NAME, { ...FRAME_POOL_ROUTE, gpuVideoParser: declaringParser }));

        expect(getReadyResponse(responses).maximumPictureSize).toEqual(MAXIMUM_PICTURE_SIZE);
        // The first attempt decodes on the pipeline the run opened for its readiness
        expect(getPacketResponses(responses)).toHaveLength(1);
    });

    it('sends no declared picture in the ready response of a parser that declares none, and no size of a picture that reports none', async () => {
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, await createHEVCMatroska('length-prefixed') ] ]));
        serveGPUDecoderWorkers();

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MATROSKA_FILE_NAME, { ...FRAME_POOL_ROUTE, gpuVideoParser: createRecordingParserField({}) }));

        expect(getReadyResponse(responses)).not.toHaveProperty('maximumPictureSize');
        expect(getPacketResponses(responses)[0]).toMatchObject({ repeatCounts: [] });
        expect(getPacketResponses(responses)[0]).not.toHaveProperty('visibleSize');
    });

    it('sends neither a declared picture nor a picture\'s report for a decoder without a parser', async () => {
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, await createHEVCMatroska('length-prefixed') ] ]));

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MATROSKA_FILE_NAME, FRAME_POOL_ROUTE));

        expect(getReadyResponse(responses)).not.toHaveProperty('maximumPictureSize');
        expect(getPacketResponses(responses)[0]).not.toHaveProperty('repeatCounts');
        expect(getPacketResponses(responses)[0]).not.toHaveProperty('visibleSize');
    });

    it('restarts its parser at the next key packet after a recoverable failure, holding the packets before it, and holds to the end without one', async () => {
        const workerScope = await startDecodeWorker(new Map([ [ RESYNC_FILE_NAME, await createHEVCMatroskaWithKeyframes(RESYNC_KEYFRAMES) ] ]));
        serveGPUDecoderWorkers();
        const recoveringParser = createRecordingParserField({
            results: { errorCode: SLICE_DATA_ERROR_CODE, errorValue: SLICE_DATA_ERROR_VALUE },
            resultSequences: { plan: [ GPU_DECODER_PARSER_STATUS.success, GPU_DECODER_PARSER_STATUS.failed ] }
        }, 0, { errorNames: SLICE_DATA_ERROR_NAMES, errorRecoveries: new Map([ [ SLICE_DATA_ERROR_CODE, 'resync' ] ]) });

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(RESYNC_FILE_NAME, { ...FRAME_POOL_ROUTE, gpuVideoParser: recoveringParser }));

        const packets = getPacketResponses(responses);
        // Each parser instance plans its first packet and fails on its second: packet 1 holds up to the key packet 3, whose parser fails on packet 4,
        // which holds to the end, since no key packet follows
        expect(packets.map(packet => [ packet.timestampMicroseconds / FRAME_DURATION_MICROSECONDS, packet.hold ?? false, packet.reset ?? false ])).toEqual([
            [ 0, false, false ],
            [ 1, true, false ],
            [ 2, true, false ],
            [ 3, false, true ],
            [ 4, true, false ],
            [ 5, true, false ]
        ]);
        expect(packets.map(packet => packet.recovery ?? null)).toEqual([ null, SLICE_DATA_RECOVERY, null, null, SLICE_DATA_RECOVERY, null ]);
        expect(packets.filter(packet => packet.hold).every(packet => packet.data.byteLength === 0)).toBe(true);
        expect(responses.some(response => response.type === 'error')).toBe(false);
        expect(responses.some(response => response.type === 'video-ended')).toBe(true);
    });

    it('fails the run on a parser failure its header declares no recovery for', async () => {
        const workerScope = await startDecodeWorker(new Map([ [ RESYNC_FILE_NAME, await createHEVCMatroskaWithKeyframes(RESYNC_KEYFRAMES) ] ]));
        serveGPUDecoderWorkers();
        const failingParser = createRecordingParserField({
            results: { errorCode: SLICE_DATA_ERROR_CODE, errorValue: SLICE_DATA_ERROR_VALUE },
            resultSequences: { plan: [ GPU_DECODER_PARSER_STATUS.success, GPU_DECODER_PARSER_STATUS.failed ] }
        }, 0, { errorNames: SLICE_DATA_ERROR_NAMES, errorRecoveries: new Map() });
        const request = createWorkerStartRequest(RESYNC_FILE_NAME, { ...FRAME_POOL_ROUTE, gpuVideoParser: failingParser });

        workerScope.dispatchRequest(request);
        await workerScope.waitForStopped(request.generation);

        expect(workerScope.responses).toContainEqual({
            failureKind: 'decode-failed',
            generation: request.generation,
            message: `parser ${SLICE_DATA_ERROR_NAME}: ${SLICE_DATA_ERROR_VALUE}`,
            type: 'error'
        });
        expect(getPacketResponses(workerScope.responses).some(packet => packet.hold)).toBe(false);
    });

    it('runs a seek\'s generation beside the stopped one, whose parser pipeline the next run\'s replaces on the shared coordinator', async () => {
        const workerScope = await startDecodeWorker(new Map([ [ RESYNC_FILE_NAME, await createHEVCMatroskaWithKeyframes(RESYNC_KEYFRAMES) ] ]));
        serveGPUDecoderWorkers();
        workerScope.dispatchRequest(createWorkerStartRequest(RESYNC_FILE_NAME, {
            ...FRAME_POOL_ROUTE,
            generation: FIRST_RUN_GENERATION,
            gpuVideoParser: createRecordingParserField({})
        }));
        await workerScope.waitForResponse(response => response.type === 'ready' && response.generation === FIRST_RUN_GENERATION);
        // The coordinator's answers wait, so the first run stops inside the packets its parser owes
        const coordinator = InProcessGPUDecoderWorker.instances.find(worker => worker.runs(GPU_DECODER_COORDINATOR_WORKER_PATH));
        if (!coordinator) {
            throw new Error('The run started no parser coordinator worker');
        }
        const deliverResponse = coordinator.onmessage;
        const heldResponses: Array<MessageEvent<unknown>> = [];
        coordinator.onmessage = (event: MessageEvent<unknown>): void => {
            heldResponses.push(event);
        };
        await waitForSettled();

        workerScope.dispatchRequest({ generation: FIRST_RUN_GENERATION, type: 'stop' });
        workerScope.dispatchRequest(createWorkerStartRequest(RESYNC_FILE_NAME, {
            ...FRAME_POOL_ROUTE,
            generation: SECOND_RUN_GENERATION,
            gpuVideoParser: createRecordingParserField({})
        }));
        // Only the next run's pipeline, which replaces the first run's, ends the packets the first run waits for, so the next run began before the first one stopped
        await workerScope.waitForStopped(FIRST_RUN_GENERATION);

        coordinator.onmessage = deliverResponse;
        for (const heldResponse of heldResponses.splice(0)) {
            deliverResponse?.(heldResponse);
        }
        await workerScope.waitForStopped(SECOND_RUN_GENERATION);

        const responses = workerScope.responses;
        expect(responses.map(response => response.type)).not.toContain('error');
        expect(getPacketResponses(getGenerationResponses(responses, FIRST_RUN_GENERATION))).toEqual([]);
        const secondRunResponses = getGenerationResponses(responses, SECOND_RUN_GENERATION);
        expect(getPacketResponses(secondRunResponses)).toHaveLength(RESYNC_KEYFRAMES.length);
        expect(secondRunResponses.slice(-2).map(response => response.type)).toEqual([ 'ended', 'stopped' ]);
    });

    it('fails the run with the check its parser\'s configure failed', async () => {
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, await createHEVCMatroska('length-prefixed') ] ]));
        serveGPUDecoderWorkers();
        const refusingParser = createStubParserField({
            results: { configure: GPU_DECODER_PARSER_STATUS.failed, errorCode: CONFIGURATION_ERROR_CODE }
        });
        const request = createWorkerStartRequest(MATROSKA_FILE_NAME, { ...FRAME_POOL_ROUTE, gpuVideoParser: refusingParser });

        workerScope.dispatchRequest(request);
        await workerScope.waitForStopped(request.generation);

        expect(workerScope.responses).toContainEqual({
            failureKind: 'decode-failed',
            generation: request.generation,
            message: CONFIGURE_FAILURE_MESSAGE,
            type: 'error'
        });
        expect(getPacketResponses(workerScope.responses)).toEqual([]);
    });
});
