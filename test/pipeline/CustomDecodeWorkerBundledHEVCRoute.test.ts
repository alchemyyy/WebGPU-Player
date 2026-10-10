// @vitest-environment node

import { NODE_MODULES_ROOT, QUALIFICATION_VECTORS_DIRECTORY } from '../helpers/enginePaths';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInThisContext } from 'node:vm';

import {
    ALL_FORMATS,
    BufferSource,
    BufferTarget,
    EncodedPacket,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    MkvOutputFormat,
    Output,
    type VideoSample
} from 'mediabunny';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS,
    type HEVCExactCapabilityVector,
    type HEVCExactCapabilityWorkerQualificationRequest
} from 'webgpu-player/capability/exact/HEVCExactCapabilityProtocol';
import { createHEVCExactCapabilityWorkerQualificationRequests } from 'webgpu-player/capability/vectors/HEVCExactCapabilityVectors';
import {
    MAX_DECODED_RAW_FRAME_CREDITS,
    type DecodeWorkerResponse
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import type { TransferringVideoFrameBufferInit } from 'webgpu-player/video/decoders/HEVCFrameOutput';
import type { TransferableRawVideoFrame } from 'webgpu-player/video/RawVideoFrameCopy';

import {
    RAW_I420P10_ROUTE,
    createWorkerStartRequest,
    decodeToEnd,
    getFrameResponses,
    startDecodeWorker,
    type DecodeWorkerFrameResponse,
    type FakeWorkerScope
} from '../helpers/decodeWorkerHarness';

const HEVC_GLUE_PATH = resolve(NODE_MODULES_ROOT, '@hevcjs/core/dist/wasm/hevc-decode.js');
const HEVC_WASM_BYTES = Uint8Array.from(readFileSync(resolve(NODE_MODULES_ROOT, '@hevcjs/core/dist/wasm/hevc-decode.wasm'))).buffer;
const MAIN10_4K_QUALIFICATION_BITSTREAM = Uint8Array.from(readFileSync(resolve(
    QUALIFICATION_VECTORS_DIRECTORY,
    'hevc', 'main10-4k-complex.hevc'
))).buffer;
const MATROSKA_FILE_NAME = 'hevc-bundled.mkv';
// Matroska stores millisecond ticks, so 40 ms frames keep the times the expected chain decodes with
const FRAME_DURATION_SECONDS = 1 / 25;
const MICROSECONDS_PER_SECOND = 1_000_000;
const HEVC_IDR_N_LP_NAL_UNIT_TYPE = 20;

type EmscriptenModuleFactory = (options: Record<string, unknown>) => Promise<unknown>;

type GlueLoader = (
    requireFunction: ReturnType<typeof createRequire>,
    filename: string,
    directory: string
) => EmscriptenModuleFactory;

/** What a VideoFrame reports, and the digest of its planes as compact rows of bytes. */
type RecordedVideoFrame = {
    codedHeight: number
    codedWidth: number
    colorSpace: Record<string, unknown>
    displayHeight: number
    displayWidth: number
    duration: number | null
    format: string
    planeDigest: string
    timestamp: number
};

/** A planar 4:2:0 VideoFrame that records what the WebCodecs constructor would make of its init. */
class RecordingVideoFrame {
    public readonly close = vi.fn();
    public readonly codedHeight: number;
    public readonly codedWidth: number;
    public readonly displayHeight: number;
    public readonly displayWidth: number;
    public readonly duration: number | null;
    public readonly format: string;
    public readonly recorded: RecordedVideoFrame;
    public readonly timestamp: number;

    public constructor(data: AllowSharedBufferSource, init: TransferringVideoFrameBufferInit) {
        const bytes = ArrayBuffer.isView(data) ?
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength) :
            new Uint8Array(data);
        const bytesPerSample = init.format === 'I420' ? 1 : 2;
        const chromaWidth = Math.ceil(init.codedWidth / 2);
        const chromaHeight = Math.ceil(init.codedHeight / 2);
        const planeHash = createHash('sha256');
        [
            { height: init.codedHeight, width: init.codedWidth },
            { height: chromaHeight, width: chromaWidth },
            { height: chromaHeight, width: chromaWidth }
        ].forEach((dimensions: { height: number, width: number }, planeIndex: number): void => {
            const layout = init.layout?.[planeIndex] ?? { offset: 0, stride: 0 };
            for (let rowIndex = 0; rowIndex < dimensions.height; rowIndex += 1) {
                const rowOffset = layout.offset + (rowIndex * layout.stride);
                planeHash.update(bytes.subarray(rowOffset, rowOffset + (dimensions.width * bytesPerSample)));
            }
        });
        this.codedHeight = init.codedHeight;
        this.codedWidth = init.codedWidth;
        this.displayHeight = init.displayHeight ?? init.codedHeight;
        this.displayWidth = init.displayWidth ?? init.codedWidth;
        this.duration = init.duration ?? null;
        this.format = init.format;
        this.timestamp = init.timestamp;
        this.recorded = {
            codedHeight: this.codedHeight,
            codedWidth: this.codedWidth,
            colorSpace: { ...init.colorSpace },
            displayHeight: this.displayHeight,
            displayWidth: this.displayWidth,
            duration: this.duration,
            format: this.format,
            planeDigest: planeHash.digest('hex'),
            timestamp: this.timestamp
        };
    }
}

function loadActualModuleFactory(): EmscriptenModuleFactory {
    const glueSource = readFileSync(HEVC_GLUE_PATH, 'utf8');
    const wrappedSource = [
        '(function(require, __filename, __dirname) {',
        glueSource,
        'return HEVCDecoderModule;',
        '})'
    ].join('\n');
    // eslint-disable-next-line sonarjs/code-eval -- Executes pinned local package glue in this Node-only test
    const loadGlue = runInThisContext(wrappedSource, { filename: HEVC_GLUE_PATH }) as GlueLoader;
    return loadGlue(createRequire(import.meta.url), HEVC_GLUE_PATH, dirname(HEVC_GLUE_PATH));
}

/** Gives the worker the bundled decoder's glue, which compiles the package's binary instead of fetching the served one. */
function stubBundledDecoderGlue(): void {
    const moduleFactory = loadActualModuleFactory();
    vi.stubGlobal('HEVCDecoderModule', (options: Record<string, unknown>): Promise<unknown> => (
        moduleFactory({ ...options, wasmBinary: HEVC_WASM_BYTES })
    ));
}

function getQualificationAccessUnits(vector: HEVCExactCapabilityVector): Uint8Array[] {
    const request = createHEVCExactCapabilityWorkerQualificationRequests(MAIN10_4K_QUALIFICATION_BITSTREAM).find(
        (qualificationRequest: HEVCExactCapabilityWorkerQualificationRequest): boolean => qualificationRequest.vector === vector
    );
    if (!request) {
        throw new Error(`The ${vector} qualification vector is unavailable`);
    }
    return request.qualificationAccessUnits.map((accessUnit: ArrayBuffer): Uint8Array => new Uint8Array(accessUnit));
}

/** Muxes a qualification vector's access units as a Matroska HEVC track, its IDR access units as key packets. */
async function createQualificationMatroska(vector: HEVCExactCapabilityVector): Promise<Uint8Array> {
    const definition = HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS[vector];
    const target = new BufferTarget();
    const output = new Output({ format: new MkvOutputFormat(), target });
    const source = new EncodedVideoPacketSource('hevc');
    output.addVideoTrack(source);
    await output.start();
    const accessUnits = getQualificationAccessUnits(vector);
    for (let frameIndex = 0; frameIndex < accessUnits.length; frameIndex += 1) {
        const packetType = definition.qualificationVCLNALUnitTypes[frameIndex] === HEVC_IDR_N_LP_NAL_UNIT_TYPE ? 'key' : 'delta';
        await source.add(
            new EncodedPacket(accessUnits[frameIndex], packetType, frameIndex * FRAME_DURATION_SECONDS, FRAME_DURATION_SECONDS),
            frameIndex === 0 ?
                { decoderConfig: { codec: definition.codecString, codedHeight: definition.codedHeight, codedWidth: definition.codedWidth } } :
                undefined
        );
    }
    source.close();
    await output.finalize();
    if (!target.buffer) {
        throw new Error('Mediabunny did not finalize the Matroska vector');
    }
    return new Uint8Array(target.buffer);
}

/**
 * Decodes the demuxed packets of a Matroska vector through the Mediabunny path, whose packed VideoSamples the worker copied until 10-09.
 * Call it after startDecodeWorker, so it shares the worker's modules and stubbed glue.
 */
async function decodeMatroskaSamples(matroska: Uint8Array): Promise<VideoSample[]> {
    const { default: HEVCSoftwareVideoDecoder } = await import('webgpu-player/video/decoders/HEVCSoftwareVideoDecoder');
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(matroska) });
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
        throw new Error('The Matroska vector has no video track');
    }
    const samples: VideoSample[] = [];
    const decoder = new HEVCSoftwareVideoDecoder();
    Object.assign(decoder, {
        codec: 'hevc',
        config: await videoTrack.getDecoderConfig(),
        onError: (): undefined => undefined,
        onSample: (sample: VideoSample): void => {
            samples.push(sample);
        }
    });
    try {
        await decoder.init();
        for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
            decoder.decode(packet);
        }
        decoder.flush();
    } finally {
        decoder.close();
        input.dispose();
    }
    return samples;
}

function getByteDigest(data: ArrayBuffer): string {
    return createHash('sha256').update(new Uint8Array(data)).digest('hex');
}

/** Copies each posted raw frame's planes as they arrive, since the page returns the buffer for reuse at once. */
function recordPostedRawFrames(workerScope: FakeWorkerScope): {
    postedBuffers: Set<ArrayBuffer>
    postedFrames: TransferableRawVideoFrame[]
} {
    const postedBuffers = new Set<ArrayBuffer>();
    const postedFrames: TransferableRawVideoFrame[] = [];
    const postMessage = workerScope.postMessage.bind(workerScope);
    workerScope.postMessage = (message: DecodeWorkerResponse): void => {
        if (message.type === 'frame' && message.outputMode === 'raw-planes') {
            postedBuffers.add(message.frame.data);
            postedFrames.push({ ...message.frame, data: message.frame.data.slice(0) });
        }
        postMessage(message);
    };
    return { postedBuffers, postedFrames };
}

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('CustomDecode.worker bundled HEVC route', () => {
    it('transfers each frame the decoder wrote at drain time as it is, reusing recycled buffers', async () => {
        const matroska = await createQualificationMatroska('main10-1080p');
        const { copyVideoFrameToRawPlanes, createVideoSampleRawFrameSource, PreparedRawVideoFrameSource } = await import(
            'webgpu-player/video/RawVideoFrameCopy'
        );
        const preparedCopy = vi.spyOn(PreparedRawVideoFrameSource.prototype, 'copyTo');
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, matroska ] ]));
        stubBundledDecoderGlue();
        const { postedBuffers, postedFrames } = recordPostedRawFrames(workerScope);

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MATROSKA_FILE_NAME, {
            ...RAW_I420P10_ROUTE,
            videoDecoderBackend: 'bundled-hevc'
        }));

        expect(getFrameResponses(responses)).toHaveLength(HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS['main10-1080p'].qualificationFrameCount);
        expect(preparedCopy).not.toHaveBeenCalled();
        // The page holds at most two frames, so the run cycles a few buffers instead of allocating one per frame
        expect(postedBuffers.size).toBeLessThan(postedFrames.length);
        expect(postedBuffers.size).toBeLessThanOrEqual(2 * MAX_DECODED_RAW_FRAME_CREDITS);
        const samples = await decodeMatroskaSamples(matroska);
        expect(samples).toHaveLength(postedFrames.length);
        for (let frameIndex = 0; frameIndex < samples.length; frameIndex += 1) {
            const expectedFrame = await copyVideoFrameToRawPlanes(createVideoSampleRawFrameSource(samples[frameIndex]), {
                format: 'I420P10'
            });
            const { data: expectedData, ...expectedMetadata } = expectedFrame;
            const { data: postedData, ...postedMetadata } = postedFrames[frameIndex];
            expect(postedMetadata).toEqual(expectedMetadata);
            expect(postedData.byteLength).toBe(expectedData.byteLength);
            expect(getByteDigest(postedData)).toBe(getByteDigest(expectedData));
        }
    });

    it('posts each frame as the VideoFrame VideoSample.toVideoFrame made, built at drain time', async () => {
        const matroska = await createQualificationMatroska('main-1080p');
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, matroska ] ]));
        stubBundledDecoderGlue();
        vi.stubGlobal('VideoFrame', RecordingVideoFrame);

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MATROSKA_FILE_NAME, {
            videoDecoderBackend: 'bundled-hevc'
        }));

        const frameResponses = getFrameResponses(responses);
        expect(frameResponses).toHaveLength(HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS['main-1080p'].qualificationFrameCount);
        const samples = await decodeMatroskaSamples(matroska);
        expect(samples).toHaveLength(frameResponses.length);
        frameResponses.forEach((frameResponse: DecodeWorkerFrameResponse, frameIndex: number): void => {
            if (frameResponse.outputMode !== 'video-frame') {
                throw new Error(`Frame ${frameIndex} was posted as ${frameResponse.outputMode}, not as a VideoFrame`);
            }
            const expectedFrame = samples[frameIndex].toVideoFrame() as unknown as RecordingVideoFrame;
            expect((frameResponse.frame as unknown as RecordingVideoFrame).recorded).toEqual(expectedFrame.recorded);
            expect(frameResponse.mediaTimeMicroseconds).toBe(Math.round(frameIndex * FRAME_DURATION_SECONDS * MICROSECONDS_PER_SECOND));
        });
    });
});
