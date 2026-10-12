import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    BYTES_PER_WORD,
    INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH,
    MAXIMUM_WORKGROUP_COUNT,
    SHADER_F16_FEATURE,
    UNIFORM_BUFFER_OFFSET_ALIGNMENT,
    WORKGROUP_AXIS_NAMES
} from 'webgpu-player/presentation/WebGPUConstants';
import { GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH, GPU_DECODE_PACKET_RING_PACKET_COUNT } from 'webgpu-player/video/gpu-decode/GPUDecodeLimits';
import { parseGPUDecoderManifest } from 'webgpu-player/video/gpu-decode/GPUDecoderManifest';
import {
    createGPUDecoderBindGroupLayoutEntries,
    createGPUDecoderModule,
    GPU_DECODER_BINDINGS,
    GPU_DECODER_FIRST_BUFFER_BINDING,
    GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH
} from 'webgpu-player/video/gpu-decode/GPUDecoderPrelude';
import {
    type GPUDecodePacket,
    type GPUDecoderManifest,
    type GPUDecodeStreamFacts,
    GPUVideoDecodeError,
    type GPUVideoDecodeFailure
} from 'webgpu-player/video/gpu-decode/GPUDecodeTypes';
import { createGPUFramePoolLayout, getGPUFramePoolSlotCount } from 'webgpu-player/video/gpu-decode/GPUFramePool';
import GPUVideoDecodeSession, { type GPUDecodedFrame } from 'webgpu-player/video/gpu-decode/GPUVideoDecodeSession';

import { getBoundBuffer, MockGPUDevice, type MockCompilationMessage, type MockDispatch, type MockGPULimits } from './mockGPUDevice';
import { installWebGPUGlobals } from './webGPUGlobals';

const DECODER_NAME = 'Session test';
const BUFFER_LABEL_PREFIX = `GPU decoder ${DECODER_NAME}`;
const CODEC_IDENTIFIER = 'V_TEST';

// A small coded frame, so pools stay small
const CODED_WIDTH = 64;
const CODED_HEIGHT = 36;
const EIGHT_BIT_DEPTH = 8;
const STREAM: GPUDecodeStreamFacts = {
    bitDepth: EIGHT_BIT_DEPTH,
    codedHeight: CODED_HEIGHT,
    codedWidth: CODED_WIDTH,
    visibleRectangle: { height: CODED_HEIGHT, width: CODED_WIDTH, x: 0, y: 0 }
};

// The declared packet size; the ring holds two packets
const PACKET_BYTE_LENGTH = 64;
const RING_BYTE_LENGTH = GPU_DECODE_PACKET_RING_PACKET_COUNT * PACKET_BYTE_LENGTH;
// Packets whose word-aligned sizes are 32, 64, and 52 bytes, so the third wraps to the ring's start
const FIRST_PACKET_BYTE_LENGTH = 30;
const SECOND_PACKET_BYTE_LENGTH = 61;
const THIRD_PACKET_BYTE_LENGTH = 50;
const SECOND_PACKET_RING_OFFSET = 32;
const OVERSIZED_PACKET_BYTE_LENGTH = PACKET_BYTE_LENGTH + 1;
const SMALL_PACKET_BYTE_LENGTH = 8;

const PACKET_UNIFORM_STRIDE = UNIFORM_BUFFER_OFFSET_ALIGNMENT;
const PACKET_UNIFORM_SLOT_COUNT = 8;
const FRAME_DURATION_MICROSECONDS = 40_000;

// The default decoder copies one row per workgroup row in 64-wide workgroups
const COPY_ENTRY_POINT = 'copyPlanes';
const COPY_DISPATCH = `${COPY_ENTRY_POINT}, ceil(stream.width / 64), stream.height, 3`;
const COPY_WORKGROUP_COUNTS = [ 1, CODED_HEIGHT, 3 ];
const PARSE_ENTRY_POINT = 'parseHeader';
const FILL_ENTRY_POINT = 'fillPlanes';
const INDIRECT_BUFFER_NAME = 'fillDispatch';
const SCRATCH_BUFFER_NAME = 'coefficients';
const SCRATCH_BUFFER_BYTE_LENGTH = 30;
const INDIRECT_WORKGROUP_COUNTS = [ 5, 6, 1 ];
const STATE_BYTE_LENGTH = 16;
const STATE_SENTINEL = 0xA5A5A5A5;
const REFERENCES = 1;
const REORDER = 2;
const DECODER_ERROR_CODE = 5;
const HEADER_CODED_HEIGHT = 40;
const HEADER_BIT_DEPTH = 10;

// Word offsets of the status buffer, in GPUDecodeStatus order
const STATUS_ERROR_CODE_WORD = 0;
const STATUS_FREED_SLOT_MASK_WORD = 1;
const STATUS_HEADER_VALID_WORD = 2;
const STATUS_WORD_COUNT = 12;
// Word offsets of the packet uniform, in GPUDecodePacket order
const PACKET_UNIFORM_WORD_COUNT = GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH / BYTES_PER_WORD;

const FEATURE_NAME = SHADER_F16_FEATURE;
const COMPILE_ERROR_BODY_LINE_OFFSET = 2;
const COMPILE_ERROR_PRELUDE_LINE = 3;
const COMPILE_ERROR_COLUMN = 7;
const COMPILE_ERROR_MESSAGE = "unresolved identifier 'sampel'";
const COMPILE_WARNING_MESSAGE = 'unused variable';
// A width divisor whose quotient is fractional, so the workgroup count is not an integer
const FRACTIONAL_DIVISOR = 3;
const FRACTIONAL_DISPATCH = `${COPY_ENTRY_POINT}, stream.width / ${FRACTIONAL_DIVISOR}`;
const SMALL_WORKGROUP_LIMIT = 8;
const SMALL_STORAGE_BUFFER_LIMIT = 6;
const TWO_SCRATCH_BUFFERS = [ 'first, 4', 'second, 4' ];
// A visible rectangle shifted right by an even offset, so it runs past the coded frame
const SHIFTED_VISIBLE_X = 2;
const LOST_DEVICE_REASON = 'unknown';
const LOST_DEVICE_MESSAGE = 'GPU process crashed';
const BROWSER_ERROR_NAME = 'OperationError';
const BROWSER_ERROR_MESSAGE = 'The operation failed';
const REFUSED_BUFFER_LABEL = 'status readback';

/** A session creation the session refuses: a description, the decoder, the stream, the device limits, and the failure. */
type CreationRejectionCase = readonly [string, GPUDecoderManifest, GPUDecodeStreamFacts, Partial<MockGPULimits>, GPUVideoDecodeFailure];

type DecoderOptions = {
    buffers?: readonly string[]
    dispatches?: readonly string[]
    references?: number
    reorder?: number
    requires?: string
    stateByteLength?: number
};

type PacketUniform = {
    byteLength: number
    byteOffset: number
    index: number
    keyframe: number
    outputSlot: number
    reset: number
};

/** Builds a decoder whose entry points are empty, so a test plays the decoder's part through the dispatch handler. */
function createManifest(options: DecoderOptions = {}): GPUDecoderManifest {
    const dispatches = options.dispatches ?? [ COPY_DISPATCH ];
    const header = [
        `//! name: ${DECODER_NAME}`,
        '//! decoder: video',
        `//! accepts: codec in [${CODEC_IDENTIFIER}]`,
        '//! output: I420',
        `//! references: ${options.references ?? 0}`,
        `//! reorder: ${options.reorder ?? 0}`,
        `//! packet: ${PACKET_BYTE_LENGTH}`,
        `//! state: ${options.stateByteLength ?? 0}`,
        ...(options.requires ? [ `//! requires: ${options.requires}` ] : []),
        ...(options.buffers ?? []).map(buffer => `//! buffer: ${buffer}`),
        ...dispatches.map(dispatch => `//! dispatch: ${dispatch}`)
    ];
    const entryPoints = [ ...new Set(dispatches.map(dispatch => dispatch.split(',')[0].trim())) ];
    const body = entryPoints.map(entryPoint => `\n@compute @workgroup_size(64)\nfn ${entryPoint}() {\n}`).join('\n');
    return parseGPUDecoderManifest(`${header.join('\n')}\n${body}`);
}

function createSession(
    device: MockGPUDevice,
    manifest: GPUDecoderManifest = createManifest(),
    stream: GPUDecodeStreamFacts = STREAM,
    codecPrivate: Uint8Array | null = null
): Promise<GPUVideoDecodeSession> {
    return GPUVideoDecodeSession.create({ codecPrivate, device: device.asDevice(), manifest, stream });
}

/** Returns a packet whose bytes count up from 1, so its position in the ring is visible. */
function createPacket(byteLength: number, timestampMicroseconds: number, reset = false): GPUDecodePacket {
    const bytes = new Uint8Array(byteLength);
    for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
        bytes[byteIndex] = (byteIndex + 1) & 0xFF;
    }
    return { data: bytes.buffer, durationMicroseconds: FRAME_DURATION_MICROSECONDS, keyframe: reset, reset, timestampMicroseconds };
}

function readPacketUniform(dispatch: MockDispatch): PacketUniform {
    const words = getBoundBuffer(dispatch, GPU_DECODER_BINDINGS.packet).readWords(dispatch.dynamicOffsets[0], PACKET_UNIFORM_WORD_COUNT);
    return { byteLength: words[1], byteOffset: words[0], index: words[2], keyframe: words[3], outputSlot: words[5], reset: words[4] };
}

/** Plays a decoder that reports through its status: atomicOr on the freed-slot mask, atomicMax on the error code. */
function reportStatus(dispatch: MockDispatch, freedSlotMask: number, errorCode = 0): void {
    const status = getBoundBuffer(dispatch, GPU_DECODER_BINDINGS.status);
    const words = status.readWords(0, STATUS_WORD_COUNT);
    status.writeWords(STATUS_ERROR_CODE_WORD * BYTES_PER_WORD, [ Math.max(words[STATUS_ERROR_CODE_WORD], errorCode) ]);
    status.writeWords(STATUS_FREED_SLOT_MASK_WORD * BYTES_PER_WORD, [ words[STATUS_FREED_SLOT_MASK_WORD] | freedSlotMask ]);
}

/** Plays a decoder with one reference: each packet frees the slot of the packet before it. */
function releasePreviousOutputSlot(device: MockGPUDevice): void {
    let previousSlot: number | null = null;
    device.dispatchHandler = (dispatch: MockDispatch): void => {
        const packet = readPacketUniform(dispatch);
        if (previousSlot !== null && packet.reset === 0) {
            reportStatus(dispatch, 1 << previousSlot);
        }
        previousSlot = packet.outputSlot;
    };
}

/** Takes every presentable frame in order, releasing each. */
function drainFrames(session: GPUVideoDecodeSession): number[] {
    const timestamps: number[] = [];
    for (let frame = session.takeNextFrame(); frame; frame = session.takeNextFrame()) {
        timestamps.push(frame.timestampMicroseconds);
        session.releaseFrame(frame);
    }
    return timestamps;
}

function requireFrame(frame: GPUDecodedFrame | null): GPUDecodedFrame {
    if (!frame) {
        throw new Error('No frame was presentable');
    }
    return frame;
}

async function getCreateError(promise: Promise<GPUVideoDecodeSession>): Promise<GPUVideoDecodeError> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof GPUVideoDecodeError) {
            return error;
        }
        throw error;
    }
    throw new Error('The session was created');
}

/** Returns an error as the browser raises one, with a DOMException-style name. */
function createBrowserError(): Error {
    const error = new Error(BROWSER_ERROR_MESSAGE);
    error.name = BROWSER_ERROR_NAME;
    return error;
}

/** Returns the storage buffers a decoder with bufferCount scratch buffers binds, counted from its bind group layout. */
function countStorageBuffers(bufferCount: number): number {
    return createGPUDecoderBindGroupLayoutEntries(bufferCount).filter(entry => entry.buffer?.type !== 'uniform').length;
}

/** Returns the bytes of the default test stream's pool. */
function getDefaultPoolByteLength(): number {
    return createGPUFramePoolLayout('I420', CODED_WIDTH, CODED_HEIGHT, getGPUFramePoolSlotCount(0, 0)).byteLength;
}

describe('GPUVideoDecodeSession', () => {
    let restoreGlobals: () => void = (): void => undefined;

    beforeEach(() => {
        restoreGlobals = installWebGPUGlobals();
    });

    afterEach(() => {
        restoreGlobals();
    });

    describe('creation', () => {
        it('compiles the prelude and body once, builds one pipeline per entry point, and binds the engine buffers in order', async () => {
            const device = new MockGPUDevice();
            const manifest = createManifest({
                buffers: [ `${INDIRECT_BUFFER_NAME}, indirect, ${INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH}`, `${SCRATCH_BUFFER_NAME}, ${SCRATCH_BUFFER_BYTE_LENGTH}` ],
                dispatches: [ `${PARSE_ENTRY_POINT}, 1`, `${FILL_ENTRY_POINT}, indirect ${INDIRECT_BUFFER_NAME}`, `${PARSE_ENTRY_POINT}, 1` ],
                references: REFERENCES,
                reorder: REORDER
            });

            const session = await createSession(device, manifest);

            expect(device.shaderModuleCodes).toEqual([ createGPUDecoderModule(manifest).code ]);
            expect(device.pipelines.map(pipeline => pipeline.entryPoint)).toEqual([ PARSE_ENTRY_POINT, FILL_ENTRY_POINT ]);
            expect(session.pool.layout.slotCount).toBe(getGPUFramePoolSlotCount(REFERENCES, REORDER));
            const decoderBindGroup = device.bindGroups.at(-1);
            expect(decoderBindGroup?.entries.map(entry => [ entry.binding, entry.resource.buffer.label ])).toEqual([
                [ GPU_DECODER_BINDINGS.packetBytes, `${BUFFER_LABEL_PREFIX} packet ring` ],
                [ GPU_DECODER_BINDINGS.packet, `${BUFFER_LABEL_PREFIX} packet uniforms` ],
                [ GPU_DECODER_BINDINGS.config, `${BUFFER_LABEL_PREFIX} config` ],
                [ GPU_DECODER_BINDINGS.stream, `${BUFFER_LABEL_PREFIX} stream` ],
                [ GPU_DECODER_BINDINGS.state, `${BUFFER_LABEL_PREFIX} state` ],
                [ GPU_DECODER_BINDINGS.framePool, 'GPU decode frame pool' ],
                [ GPU_DECODER_BINDINGS.status, `${BUFFER_LABEL_PREFIX} status` ],
                [ GPU_DECODER_FIRST_BUFFER_BINDING, `${BUFFER_LABEL_PREFIX} buffer ${INDIRECT_BUFFER_NAME}` ],
                [ GPU_DECODER_FIRST_BUFFER_BINDING + 1, `${BUFFER_LABEL_PREFIX} buffer ${SCRATCH_BUFFER_NAME}` ]
            ]);
            expect(decoderBindGroup?.entries[GPU_DECODER_BINDINGS.packet].resource.size).toBe(GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH);
            expect(device.findBuffer(`${BUFFER_LABEL_PREFIX} packet ring`).size).toBe(RING_BYTE_LENGTH);
            expect(device.findBuffer(`${BUFFER_LABEL_PREFIX} buffer ${SCRATCH_BUFFER_NAME}`).size % BYTES_PER_WORD).toBe(0);
        });

        it('writes the codec private data zero-padded to whole words and the stream uniform from the pool layout', async () => {
            const device = new MockGPUDevice();
            const codecPrivate = new Uint8Array([ 1, 2, 3, 4, 5 ]);

            const session = await createSession(device, createManifest(), STREAM, codecPrivate);

            expect([ ...device.findBuffer(`${BUFFER_LABEL_PREFIX} config`).data ]).toEqual([ 1, 2, 3, 4, 5, 0, 0, 0 ]);
            const streamWords = device.findBuffer(`${BUFFER_LABEL_PREFIX} stream`).readWords(0, 20);
            const lumaPlane = session.pool.layout.planes[0];
            expect([ ...streamWords.slice(0, 4) ]).toEqual([ lumaPlane.byteOffset, lumaPlane.bytesPerRow, lumaPlane.width, lumaPlane.height ]);
            expect([ ...streamWords.slice(12) ]).toEqual([
                CODED_WIDTH,
                CODED_HEIGHT,
                EIGHT_BIT_DEPTH,
                1,
                3,
                session.pool.layout.slotByteLength,
                session.pool.layout.slotCount,
                codecPrivate.byteLength
            ]);
        });

        it('maps compile errors to decoder source lines and to prelude lines, ignoring warnings', async () => {
            const device = new MockGPUDevice();
            const manifest = createManifest();
            const firstBodyLine = createGPUDecoderModule(manifest).firstBodyLine;
            const messages: MockCompilationMessage[] = [
                { lineNum: firstBodyLine + COMPILE_ERROR_BODY_LINE_OFFSET, linePos: COMPILE_ERROR_COLUMN, message: COMPILE_ERROR_MESSAGE, type: 'error' },
                { lineNum: COMPILE_ERROR_PRELUDE_LINE, linePos: 1, message: COMPILE_ERROR_MESSAGE, type: 'error' },
                { lineNum: firstBodyLine, linePos: 1, message: COMPILE_WARNING_MESSAGE, type: 'warning' }
            ];
            device.compilationMessages = messages;

            const error = await getCreateError(createSession(device, manifest));

            const sourceLine = manifest.bodyFirstLine + COMPILE_ERROR_BODY_LINE_OFFSET;
            expect(error.compileMessages).toEqual([
                { column: COMPILE_ERROR_COLUMN, line: sourceLine, message: COMPILE_ERROR_MESSAGE, source: 'decoder' },
                { column: 1, line: COMPILE_ERROR_PRELUDE_LINE, message: COMPILE_ERROR_MESSAGE, source: 'prelude' }
            ]);
            expect(error.failure).toEqual({ code: 'compile-error', detail: `line ${sourceLine}:${COMPILE_ERROR_COLUMN} ${COMPILE_ERROR_MESSAGE}` });
            expect(error.message).toBe(`compile-error: line ${sourceLine}:${COMPILE_ERROR_COLUMN} ${COMPILE_ERROR_MESSAGE}`);
            expect(device.pipelines).toEqual([]);
        });

        it('names a compile error in the prelude as a prelude line', async () => {
            const device = new MockGPUDevice();
            device.compilationMessages = [ { lineNum: COMPILE_ERROR_PRELUDE_LINE, linePos: 1, message: COMPILE_ERROR_MESSAGE, type: 'error' } ];

            const error = await getCreateError(createSession(device));

            expect(error.failure).toEqual({ code: 'compile-error', detail: `prelude line ${COMPILE_ERROR_PRELUDE_LINE}:1 ${COMPILE_ERROR_MESSAGE}` });
        });

        it.each<CreationRejectionCase>([
            [ 'a device without a required feature', createManifest({ requires: FEATURE_NAME }), STREAM, {}, { code: 'feature-missing', detail: FEATURE_NAME } ],
            [
                'a workgroup count that is not an integer',
                createManifest({ dispatches: [ FRACTIONAL_DISPATCH ] }),
                STREAM,
                {},
                {
                    code: 'dispatch-count',
                    detail: `${COPY_ENTRY_POINT} ${WORKGROUP_AXIS_NAMES[0]} ${CODED_WIDTH / FRACTIONAL_DIVISOR} outside integers [0, ${MAXIMUM_WORKGROUP_COUNT}]`
                }
            ],
            [
                'a workgroup count beyond the device limit',
                createManifest(),
                STREAM,
                { maxComputeWorkgroupsPerDimension: SMALL_WORKGROUP_LIMIT },
                { code: 'dispatch-count', detail: `${COPY_ENTRY_POINT} ${WORKGROUP_AXIS_NAMES[1]} ${CODED_HEIGHT} outside integers [0, ${SMALL_WORKGROUP_LIMIT}]` }
            ],
            [
                'an empty coded size',
                createManifest(),
                { ...STREAM, codedWidth: 0 },
                {},
                { code: 'coded-size', detail: `0x${CODED_HEIGHT}` }
            ],
            [
                'a visible rectangle without area',
                createManifest(),
                { ...STREAM, visibleRectangle: { height: CODED_HEIGHT, width: 0, x: 0, y: 0 } },
                {},
                { code: 'visible-rectangle', detail: `0,0 0x${CODED_HEIGHT} is not a nonempty integer rectangle` }
            ],
            [
                'a visible rectangle outside the coded frame',
                createManifest(),
                { ...STREAM, visibleRectangle: { height: CODED_HEIGHT, width: CODED_WIDTH, x: SHIFTED_VISIBLE_X, y: 0 } },
                {},
                { code: 'visible-rectangle', detail: `${SHIFTED_VISIBLE_X},0 ${CODED_WIDTH}x${CODED_HEIGHT} exceeds ${CODED_WIDTH}x${CODED_HEIGHT}` }
            ],
            [
                'a pool beyond the device limits',
                createManifest(),
                STREAM,
                { maxStorageBufferBindingSize: SMALL_PACKET_BYTE_LENGTH },
                { code: 'pool-size', detail: `${getDefaultPoolByteLength()} > ${SMALL_PACKET_BYTE_LENGTH}` }
            ]
        ])('rejects %s with its failure', async (
            _description: string,
            manifest: GPUDecoderManifest,
            stream: GPUDecodeStreamFacts,
            limits: Partial<MockGPULimits>,
            failure: GPUVideoDecodeFailure
        ) => {
            const device = new MockGPUDevice([], limits);

            const error = await getCreateError(createSession(device, manifest, stream));

            expect(error.failure).toEqual(failure);
            expect(error.message).toBe(`${failure.code}: ${failure.detail}`);
            expect(error.compileMessages).toEqual([]);
        });

        it('rejects more storage buffers than the device allows, counted from the bind group layout', async () => {
            const device = new MockGPUDevice([], { maxStorageBuffersPerShaderStage: SMALL_STORAGE_BUFFER_LIMIT });

            const error = await getCreateError(createSession(device, createManifest({ buffers: TWO_SCRATCH_BUFFERS })));

            expect(error.failure).toEqual({
                code: 'storage-buffer-count',
                detail: `${countStorageBuffers(TWO_SCRATCH_BUFFERS.length)} > ${SMALL_STORAGE_BUFFER_LIMIT}`
            });
        });

        it('rejects codec private data beyond the limit', async () => {
            const codecPrivate = new Uint8Array(GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH + 1);

            const error = await getCreateError(createSession(new MockGPUDevice(), createManifest(), STREAM, codecPrivate));

            expect(error.failure).toEqual({
                code: 'codec-private-size',
                detail: `${GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH + 1} > ${GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH}`
            });
        });

        it('reports a pipeline the device cannot build with its entry point and the browser error', async () => {
            const device = new MockGPUDevice();
            device.pipelineFailure = createBrowserError();

            const error = await getCreateError(createSession(device));

            expect(error.failure).toEqual({ code: 'pipeline-error', detail: `${COPY_ENTRY_POINT} ${BROWSER_ERROR_NAME}: ${BROWSER_ERROR_MESSAGE}` });
        });

        it('destroys what it allocated when an allocation after the pool fails, and rethrows', async () => {
            const device = new MockGPUDevice();
            device.failingBufferLabel = REFUSED_BUFFER_LABEL;

            const creation = createSession(device);

            await expect(creation).rejects.toThrow(RangeError);
            expect(device.buffers.length).toBeGreaterThan(0);
            expect(device.buffers.every(buffer => buffer.destroyed)).toBe(true);
        });
    });

    describe('packets', () => {
        it('writes each packet word-aligned into the ring, zero-pads its tail, and wraps when the next packet does not fit', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device);
            const ring = device.findBuffer(`${BUFFER_LABEL_PREFIX} packet ring`);
            const packetLengths = [ FIRST_PACKET_BYTE_LENGTH, SECOND_PACKET_BYTE_LENGTH, THIRD_PACKET_BYTE_LENGTH ];
            const ringSnapshots: Uint8Array[] = [];
            const uniforms: PacketUniform[] = [];
            device.dispatchHandler = (dispatch: MockDispatch): void => {
                ringSnapshots.push(ring.data.slice());
                uniforms.push(readPacketUniform(dispatch));
            };

            for (let packetIndex = 0; packetIndex < packetLengths.length; packetIndex += 1) {
                session.queuePacket(createPacket(packetLengths[packetIndex], packetIndex * FRAME_DURATION_MICROSECONDS));
                session.submitPendingDecodeWork();
                drainFrames(session);
            }

            expect(uniforms.map(uniform => [ uniform.byteOffset, uniform.byteLength ])).toEqual([
                [ 0, FIRST_PACKET_BYTE_LENGTH ],
                [ SECOND_PACKET_RING_OFFSET, SECOND_PACKET_BYTE_LENGTH ],
                [ 0, THIRD_PACKET_BYTE_LENGTH ]
            ]);
            const secondPacket = ringSnapshots[1].slice(SECOND_PACKET_RING_OFFSET, SECOND_PACKET_RING_OFFSET + PACKET_BYTE_LENGTH);
            expect([ ...secondPacket ]).toEqual([ ...new Uint8Array(createPacket(SECOND_PACKET_BYTE_LENGTH, 0).data), 0, 0, 0 ]);
            expect([ ...ringSnapshots[0].slice(FIRST_PACKET_BYTE_LENGTH, SECOND_PACKET_RING_OFFSET) ]).toEqual([ 0, 0 ]);
        });

        it('takes the next packet uniform slot at a dynamic offset for each packet and counts packets in decode order', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device);
            const packetCount = PACKET_UNIFORM_SLOT_COUNT + 1;
            // A later packet reuses a slot, so each uniform is read while its dispatch runs
            const uniforms: PacketUniform[] = [];
            device.dispatchHandler = (dispatch: MockDispatch): void => {
                uniforms.push(readPacketUniform(dispatch));
            };

            for (let packetIndex = 0; packetIndex < packetCount; packetIndex += 1) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, packetIndex * FRAME_DURATION_MICROSECONDS, packetIndex === 0));
                session.submitPendingDecodeWork();
                drainFrames(session);
            }

            expect(device.dispatches.map(dispatch => dispatch.dynamicOffsets[0])).toEqual(
                [ ...Array.from({ length: PACKET_UNIFORM_SLOT_COUNT }, (_value: unknown, slot: number) => slot * PACKET_UNIFORM_STRIDE), 0 ]
            );
            expect(uniforms.map(uniform => uniform.index)).toEqual(Array.from({ length: packetCount }, (_value: unknown, index: number) => index));
            expect(uniforms.map(uniform => uniform.keyframe)).toEqual([ 1, ...new Array<number>(packetCount - 1).fill(0) ]);
            expect(device.dispatches.every(dispatch => dispatch.entryPoint === COPY_ENTRY_POINT)).toBe(true);
            expect(device.dispatches[0].workgroupCounts).toEqual(COPY_WORKGROUP_COUNTS);
        });

        it('fails the session on a packet larger than the declared packet size', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device);

            session.queuePacket(createPacket(OVERSIZED_PACKET_BYTE_LENGTH, 0));
            session.submitPendingDecodeWork();

            expect(session.getFailure()).toEqual({ code: 'packet-size', detail: `${OVERSIZED_PACKET_BYTE_LENGTH} > ${PACKET_BYTE_LENGTH}` });
            expect(device.submitCount).toBe(0);
        });
    });

    describe('dispatch', () => {
        it('runs an indirect dispatch from a copy of the counts an earlier entry point wrote', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({
                buffers: [ `${INDIRECT_BUFFER_NAME}, indirect, ${INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH}` ],
                dispatches: [ `${PARSE_ENTRY_POINT}, 1`, `${FILL_ENTRY_POINT}, indirect ${INDIRECT_BUFFER_NAME}` ]
            }));
            device.dispatchHandler = (dispatch: MockDispatch): void => {
                if (dispatch.entryPoint === PARSE_ENTRY_POINT) {
                    getBoundBuffer(dispatch, GPU_DECODER_FIRST_BUFFER_BINDING).writeWords(0, INDIRECT_WORKGROUP_COUNTS);
                }
            };

            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true));
            session.submitPendingDecodeWork();

            const [ parseDispatch, fillDispatch ] = device.dispatches;
            expect(parseDispatch.workgroupCounts).toEqual([ 1, 1, 1 ]);
            expect(fillDispatch.entryPoint).toBe(FILL_ENTRY_POINT);
            expect(fillDispatch.workgroupCounts).toEqual(INDIRECT_WORKGROUP_COUNTS);
            expect(fillDispatch.indirectBuffer).toBe(device.findBuffer(`${BUFFER_LABEL_PREFIX} indirect arguments 1`));
            expect(fillDispatch.indirectBuffer).not.toBe(getBoundBuffer(fillDispatch, GPU_DECODER_FIRST_BUFFER_BINDING));
            expect(fillDispatch.dynamicOffsets).toEqual(parseDispatch.dynamicOffsets);
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount - 1);
        });

        it('clears the state and status before the first packet and after a reset, and keeps the state between', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({ stateByteLength: STATE_BYTE_LENGTH }));
            const state = device.findBuffer(`${BUFFER_LABEL_PREFIX} state`);
            state.writeWords(0, [ STATE_SENTINEL ]);
            const stateAtDispatch: number[] = [];
            device.dispatchHandler = (dispatch: MockDispatch): void => {
                const stateBuffer = getBoundBuffer(dispatch, GPU_DECODER_BINDINGS.state);
                stateAtDispatch.push(stateBuffer.readWords(0, 1)[0]);
                stateBuffer.writeWords(0, [ stateAtDispatch.length ]);
            };

            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0));
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, FRAME_DURATION_MICROSECONDS));
            session.submitPendingDecodeWork();
            session.submitPendingDecodeWork();
            session.reset();
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0));
            session.submitPendingDecodeWork();

            expect(stateAtDispatch).toEqual([ 0, 1, 0 ]);
            expect(device.dispatches.map(dispatch => readPacketUniform(dispatch).reset)).toEqual([ 1, 0, 1 ]);
        });

        it('treats a packet with the reset flag as a reset of the decoder and its references', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({ references: REFERENCES, stateByteLength: STATE_BYTE_LENGTH }));

            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true));
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, FRAME_DURATION_MICROSECONDS, true));
            session.submitPendingDecodeWork();
            drainFrames(session);
            session.submitPendingDecodeWork();
            drainFrames(session);

            // The second packet's reset dropped the first packet's reference before it took a slot, so it took that slot again
            expect(device.dispatches.map(dispatch => readPacketUniform(dispatch))).toMatchObject([
                { outputSlot: 0, reset: 1 },
                { outputSlot: 0, reset: 1 }
            ]);
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount - 1);
        });
    });

    describe('status', () => {
        it('frees a reference slot once a readback reports it, and reports each freed slot once', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({ references: REFERENCES }));
            releasePreviousOutputSlot(device);

            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true));
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, FRAME_DURATION_MICROSECONDS));
            session.submitPendingDecodeWork();
            session.submitPendingDecodeWork();
            drainFrames(session);
            const freeBeforeReadback = session.getFreeSlotCount();
            await session.waitForStatusReadbacks();

            expect(freeBeforeReadback).toBe(session.pool.layout.slotCount - 2);
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount - 1);
            expect(session.pool.isReferenceHeld(1)).toBe(true);
            expect(device.findBuffer(`${BUFFER_LABEL_PREFIX} status`).readWords(0, STATUS_WORD_COUNT)[STATUS_FREED_SLOT_MASK_WORD]).toBe(0);
        });

        it('fails the session when the decoder reports an error, and submits nothing after', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device);
            device.dispatchHandler = (dispatch: MockDispatch): void => {
                reportStatus(dispatch, 0, DECODER_ERROR_CODE);
            };

            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true));
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, FRAME_DURATION_MICROSECONDS));
            session.submitPendingDecodeWork();
            await session.waitForStatusReadbacks();
            session.submitPendingDecodeWork();

            expect(session.getFailure()).toEqual({ code: 'decoder-error', detail: String(DECODER_ERROR_CODE) });
            expect(device.submitCount).toBe(1);
            expect(session.takeNextFrame()).toBeNull();
            expect(session.getPendingPacketCount()).toBe(0);
        });

        it('fails on an error that a readback taken before a reset reports, though it frees no slots', async () => {
            const device = new MockGPUDevice();
            device.manualMaps = true;
            const session = await createSession(device, createManifest({ references: REFERENCES }));
            device.dispatchHandler = (dispatch: MockDispatch): void => {
                reportStatus(dispatch, 0, DECODER_ERROR_CODE);
            };

            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true));
            session.submitPendingDecodeWork();
            session.reset();
            device.settlePendingMaps();
            await session.waitForStatusReadbacks();

            expect(session.getFailure()).toEqual({ code: 'decoder-error', detail: String(DECODER_ERROR_CODE) });
        });

        it('reads back the error of a packet that skipped its readback when the status is flushed', async () => {
            const device = new MockGPUDevice();
            device.manualMaps = true;
            const session = await createSession(device);
            // Three packets take every readback, so the fourth, which reports the error, skips its own
            const packetCount = 4;
            device.dispatchHandler = (dispatch: MockDispatch): void => {
                if (readPacketUniform(dispatch).index === packetCount - 1) {
                    reportStatus(dispatch, 0, DECODER_ERROR_CODE);
                }
            };
            for (let packetIndex = 0; packetIndex < packetCount; packetIndex += 1) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, packetIndex * FRAME_DURATION_MICROSECONDS, packetIndex === 0));
                session.submitPendingDecodeWork();
                drainFrames(session);
            }

            device.settlePendingMaps();
            await session.waitForStatusReadbacks();
            const failureBeforeFlush = session.getFailure();
            device.manualMaps = false;
            await session.flushStatusReadbacks();

            expect(failureBeforeFlush).toBeNull();
            expect(session.getFailure()).toEqual({ code: 'decoder-error', detail: String(DECODER_ERROR_CODE) });
        });

        it('fails when a status readback cannot map, with the browser error', async () => {
            const device = new MockGPUDevice();
            device.mapFailure = createBrowserError();
            const session = await createSession(device);

            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true));
            session.submitPendingDecodeWork();
            await session.waitForStatusReadbacks();

            expect(session.getFailure()).toEqual({ code: 'readback-failed', detail: `${BROWSER_ERROR_NAME}: ${BROWSER_ERROR_MESSAGE}` });
        });

        it('keeps the header facts the first reporting readback carries', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device);
            device.dispatchHandler = (dispatch: MockDispatch): void => {
                const packet = readPacketUniform(dispatch);
                getBoundBuffer(dispatch, GPU_DECODER_BINDINGS.status).writeWords(STATUS_HEADER_VALID_WORD * BYTES_PER_WORD, [
                    1,
                    CODED_WIDTH,
                    HEADER_CODED_HEIGHT + packet.index,
                    HEADER_BIT_DEPTH,
                    0,
                    0,
                    CODED_WIDTH,
                    CODED_HEIGHT
                ]);
            };

            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true));
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, FRAME_DURATION_MICROSECONDS));
            session.submitPendingDecodeWork();
            session.submitPendingDecodeWork();
            await session.waitForStatusReadbacks();

            expect(session.getHeaderFacts()).toEqual({
                bitDepth: HEADER_BIT_DEPTH,
                codedHeight: HEADER_CODED_HEIGHT,
                codedWidth: CODED_WIDTH,
                visibleRectangle: { height: CODED_HEIGHT, width: CODED_WIDTH, x: 0, y: 0 }
            });
        });

        it('ignores a readback taken before a reset, whose freed slots may be references of the new epoch', async () => {
            const device = new MockGPUDevice();
            device.manualMaps = true;
            const session = await createSession(device, createManifest({ references: REFERENCES }));
            releasePreviousOutputSlot(device);

            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true));
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, FRAME_DURATION_MICROSECONDS));
            session.submitPendingDecodeWork();
            session.submitPendingDecodeWork();
            session.reset();
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true));
            session.submitPendingDecodeWork();
            const resetOutputSlot = readPacketUniform(device.dispatches[2]).outputSlot;
            device.settlePendingMaps();
            await session.waitForStatusReadbacks();

            // The readback of the second packet reports slot 0 freed, which the packet after the reset took again
            expect(resetOutputSlot).toBe(0);
            expect(session.pool.isReferenceHeld(resetOutputSlot)).toBe(true);
        });

        it('reads back the status a skipped readback left uncaptured once a readback is free', async () => {
            const device = new MockGPUDevice();
            device.manualMaps = true;
            const session = await createSession(device, createManifest({ references: REFERENCES }));
            releasePreviousOutputSlot(device);
            const packetCount = 4;

            for (let packetIndex = 0; packetIndex < packetCount; packetIndex += 1) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, packetIndex * FRAME_DURATION_MICROSECONDS, packetIndex === 0));
                session.submitPendingDecodeWork();
                drainFrames(session);
            }
            const mapsWhileSkipped = device.getPendingMapCount();
            device.settlePendingMaps();
            await session.waitForStatusReadbacks();
            const heldBeforeCapture = session.pool.isReferenceHeld(2);
            const submitsBeforeCapture = device.submitCount;
            session.submitPendingDecodeWork();
            device.settlePendingMaps();
            await session.waitForStatusReadbacks();

            // The fourth packet freed slot 2 while three readbacks were mapping
            expect(mapsWhileSkipped).toBe(3);
            expect(heldBeforeCapture).toBe(true);
            expect(device.submitCount).toBe(submitsBeforeCapture + 1);
            expect(device.dispatches).toHaveLength(packetCount);
            expect(session.pool.isReferenceHeld(2)).toBe(false);
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount - 1);
        });
    });

    describe('presentation', () => {
        it('presents frames in timestamp order once the reorder depth fills, and flushes them at the end of the stream', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({ reorder: REORDER }));
            const decodeOrderTimestamps = [ 0, 3, 1, 2, 4 ].map(frameIndex => frameIndex * FRAME_DURATION_MICROSECONDS);
            const presentedTimestamps: number[] = [];
            const queuedCounts: number[] = [];

            for (const timestamp of decodeOrderTimestamps) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, timestamp, timestamp === 0));
                session.submitPendingDecodeWork();
                queuedCounts.push(session.getQueuedFrameCount());
                presentedTimestamps.push(...drainFrames(session));
            }
            const presentedBeforeEnd = presentedTimestamps.length;
            session.endOfStream();
            presentedTimestamps.push(...drainFrames(session));

            expect(queuedCounts).toEqual([ 1, 2, 3, 3, 3 ]);
            expect(presentedBeforeEnd).toBe(decodeOrderTimestamps.length - REORDER);
            expect(presentedTimestamps).toEqual([ ...decodeOrderTimestamps ].sort((first: number, second: number) => first - second));
            expect(session.getDroppedFrameCount()).toBe(0);
        });

        it('drops a frame that reorders deeper than declared and frees its slot', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device);

            for (const frameIndex of [ 0, 2, 1 ]) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, frameIndex * FRAME_DURATION_MICROSECONDS, frameIndex === 0));
                session.submitPendingDecodeWork();
            }

            expect(session.getDroppedFrameCount()).toBe(1);
            expect(session.getQueuedFrameCount()).toBe(2);
            expect(session.getFreeSlotCount()).toBe(1);
        });

        it('takes the newest due frame and releases the older due frames as dropped', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device);
            for (let frameIndex = 0; frameIndex < 3; frameIndex += 1) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, frameIndex * FRAME_DURATION_MICROSECONDS, frameIndex === 0));
                session.submitPendingDecodeWork();
            }

            const early = session.takeFrame(-1);
            const due = requireFrame(session.takeFrame(2 * FRAME_DURATION_MICROSECONDS + 1));

            expect(early).toBeNull();
            expect(due.timestampMicroseconds).toBe(2 * FRAME_DURATION_MICROSECONDS);
            expect(due.droppedFrameCount).toBe(2);
            expect(due.frame).toBe(session.pool.getFrame(due.slot));
            expect(session.getDroppedFrameCount()).toBe(2);
            expect(session.getFreeSlotCount()).toBe(2);
            expect(session.releaseFrame(due)).toBe(true);
            expect(session.releaseFrame(due)).toBe(false);
            expect(session.getFreeSlotCount()).toBe(3);
        });

        it('submits at most one packet per call and none while every slot is held', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device);
            const packetCount = 5;
            for (let packetIndex = 0; packetIndex < packetCount; packetIndex += 1) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, packetIndex * FRAME_DURATION_MICROSECONDS, packetIndex === 0));
            }

            for (let callIndex = 0; callIndex < packetCount; callIndex += 1) {
                session.submitPendingDecodeWork();
            }
            const submitsWhileFull = device.submitCount;
            const frame = requireFrame(session.takeNextFrame());
            session.releaseFrame(frame);
            session.submitPendingDecodeWork();

            expect(submitsWhileFull).toBe(session.pool.layout.slotCount);
            expect(device.submitCount).toBe(session.pool.layout.slotCount + 1);
            expect(session.getPendingPacketCount()).toBe(packetCount - session.pool.layout.slotCount - 1);
        });

        it('drops queued packets and frames on a reset but leaves taken frames to presentation', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device);
            for (let packetIndex = 0; packetIndex < 4; packetIndex += 1) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, packetIndex * FRAME_DURATION_MICROSECONDS, packetIndex === 0));
            }
            session.submitPendingDecodeWork();
            session.submitPendingDecodeWork();
            const taken = requireFrame(session.takeNextFrame());

            session.reset();

            expect(session.getPendingPacketCount()).toBe(0);
            expect(session.getQueuedFrameCount()).toBe(0);
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount - 1);
            expect(session.releaseFrame(taken)).toBe(true);
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount);
        });
    });

    describe('lifetime', () => {
        it('fails when the device is lost', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device);
            device.loseDevice(LOST_DEVICE_MESSAGE);
            await device.lost;

            expect(session.getFailure()).toEqual({ code: 'device-lost', detail: `${LOST_DEVICE_REASON}: ${LOST_DEVICE_MESSAGE}` });
        });

        it('destroys every buffer, including the pool, and ignores calls after', async () => {
            const device = new MockGPUDevice();
            device.manualMaps = true;
            const session = await createSession(device);
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true));
            session.submitPendingDecodeWork();
            const frame = requireFrame(session.takeNextFrame());

            session.destroy();
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, FRAME_DURATION_MICROSECONDS));
            session.submitPendingDecodeWork();
            await session.waitForStatusReadbacks();

            expect(device.buffers.every(buffer => buffer.destroyed)).toBe(true);
            expect(device.submitCount).toBe(1);
            expect(session.getFailure()).toBeNull();
            expect(session.releaseFrame(frame)).toBe(false);
        });
    });
});
