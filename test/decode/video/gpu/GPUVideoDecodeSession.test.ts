import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DecoderPackageVersion } from 'webgpu-player/decode/packages/DecoderPackageIdentity';
import {
    BYTES_PER_WORD,
    INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH,
    MAXIMUM_STORAGE_BUFFER_BINDING_SIZE,
    MAXIMUM_WORKGROUP_COUNT,
    OUT_OF_MEMORY_ERROR_FILTER,
    SHADER_F16_FEATURE,
    UNIFORM_BUFFER_OFFSET_ALIGNMENT,
    VALIDATION_ERROR_FILTER,
    WORKGROUP_AXIS_NAMES
} from 'webgpu-player/presentation/WebGPUConstants';
import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import {
    GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH,
    GPU_DECODE_PACKET_RING_PACKET_COUNT,
    GPU_DECODER_PARSER_ABI_VERSION
} from 'webgpu-player/decode/video/gpu/GPUDecodeLimits';
import { splitGPUDecoderModule } from 'webgpu-player/decode/video/gpu/GPUDecoderEntryPointModules';
import { parseGPUDecoderManifest } from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';
import {
    createGPUDecoderBindGroupLayoutEntries,
    createGPUDecoderModule,
    GPU_DECODER_BINDINGS,
    GPU_DECODER_FIRST_BUFFER_BINDING,
    GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH,
    GPU_DECODER_STATUS_BYTE_LENGTH,
    GPU_DECODER_STATUS_WORDS
} from 'webgpu-player/decode/video/gpu/GPUDecoderPrelude';
import {
    GPU_DECODER_OUTPUT_EVENT,
    type GPUDecodePacket,
    type GPUDecoderManifest,
    type GPUDecodeStreamFacts,
    GPUVideoDecodeError,
    type GPUVideoDecodeFailure,
    type GPUVideoDecodeRecovery
} from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';
import { createPictureFieldsWord, type VideoFrameFields } from 'webgpu-player/decode/video/VideoFields';
import { createGPUFramePoolLayout, getGPUFramePoolSlotCount } from 'webgpu-player/decode/video/gpu/GPUFramePool';
import GPUVideoDecodeSession, { type GPUDecodedFrame } from 'webgpu-player/decode/video/gpu/GPUVideoDecodeSession';

import { getBoundBuffer, MockGPUDevice, type MockCompilationMessage, type MockDispatch, type MockGPULimits } from './mockGPUDevice';
import { installWebGPUGlobals } from './webGPUGlobals';

const DECODER_NAME = 'Session test';
const BUFFER_LABEL_PREFIX = `GPU decoder ${DECODER_NAME}`;
// The package a session's compiled decoder is kept under, by its id and content hash, and a rebuilt version of it; each test's device is new, so nothing carries over between tests
const PACKAGE_VERSION: DecoderPackageVersion = { contentHash: 'c3'.repeat(32), id: 'session-test' };
const REBUILT_PACKAGE_VERSION: DecoderPackageVersion = { contentHash: 'c4'.repeat(32), id: 'session-test' };
const CODEC_FAMILY = 'test';
// The format a session decodes into unless a test names another
const OUTPUT_FORMAT: GPUDecoderOutputFormat = 'I420';
const TEN_BIT_OUTPUT_FORMAT: GPUDecoderOutputFormat = 'I420P10';
const UNLISTED_OUTPUT_FORMAT: GPUDecoderOutputFormat = 'I444';

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
const STATUS_ERROR_CODE_WORD = GPU_DECODER_STATUS_WORDS.errorCode;
const STATUS_FREED_SLOT_MASK_WORD = GPU_DECODER_STATUS_WORDS.freedSlotMask;
const STATUS_HEADER_VALID_WORD = GPU_DECODER_STATUS_WORDS.headerValid;
const STATUS_PICTURE_ERROR_WORD = GPU_DECODER_STATUS_WORDS.pictureError;
const STATUS_PICTURE_FIELDS_WORD = GPU_DECODER_STATUS_WORDS.pictureFields;
const STATUS_WORD_COUNT = GPU_DECODER_STATUS_BYTE_LENGTH / BYTES_PER_WORD;

// Error lines a recovering decoder's header declares, by recovery, and the error words its dispatches report
const CONCEALED_ERROR_CODE = 9;
const CONCEALED_ERROR_NAME = 'sliceHeader';
const DROPPED_ERROR_CODE = 4;
const DROPPED_ERROR_NAME = 'pictureHeader';
const RESYNCED_ERROR_CODE = 19;
const RESYNCED_ERROR_NAME = 'bitsExhausted';
const FATAL_ERROR_CODE = 2;
const FATAL_ERROR_NAME = 'pictureSize';
const RECOVERY_ERROR_LINES = [
    `//! error: ${FATAL_ERROR_CODE}, ${FATAL_ERROR_NAME}`,
    `//! error: ${DROPPED_ERROR_CODE}, ${DROPPED_ERROR_NAME}, drop`,
    `//! error: ${CONCEALED_ERROR_CODE}, ${CONCEALED_ERROR_NAME}, conceal`,
    `//! error: ${RESYNCED_ERROR_CODE}, ${RESYNCED_ERROR_NAME}, resync`
];
const ERROR_CODE_SHIFT = 24;
const FAILING_VALUE = 1004;
// A parser failure that lost a picture, as the decode worker reports it on its first held packet
const PARSER_RECOVERY: GPUVideoDecodeRecovery = { code: 'resynced', errorName: 'parser sliceData', value: 7 };
// Fields the container gave a packet, and the decoder's own report that replaces them
const CONTAINER_FIELDS: VideoFrameFields = { repeatFirstField: false, scan: 'interlaced' };
const DECODER_FIELDS_WORD = createPictureFieldsWord(true, false, false);
const DECODER_FIELDS: VideoFrameFields = { repeatFirstField: false, scan: 'bottom-first' };
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
// A conformance window that trims the coded frame's last 4 rows, as a 1080p stream's 1088 rows are trimmed
const HEADER_VISIBLE_RECTANGLE = { height: CODED_HEIGHT - 4, width: CODED_WIDTH, x: 0, y: 0 };
const LOST_DEVICE_REASON = 'unknown';
const LOST_DEVICE_MESSAGE = 'GPU process crashed';
const BROWSER_ERROR_NAME = 'OperationError';
const BROWSER_ERROR_MESSAGE = 'The operation failed';
const REFUSED_BUFFER_LABEL = 'status readback';
const SCOPE_ERROR_MESSAGE = 'Allocation of 4294967296 bytes failed';

// Sizes and counts over the stream and the output format, which differ between the 8-bit and the 10-bit session
const BOTH_OUTPUT_FORMATS = `${OUTPUT_FORMAT}, ${TEN_BIT_OUTPUT_FORMAT}`;
// One row of samples and a byte more, which the session rounds up to whole words
const ROW_STATE_SIZE = 'stream.width * output.bytesPerSample + 1';
const EIGHT_BIT_ROW_STATE_BUFFER_SIZE = 68;
const TEN_BIT_ROW_STATE_BUFFER_SIZE = 132;
// A fraction of a byte per row, which rounds up to whole bytes and then to whole words
const ROW_BUFFER_NAME = 'rows';
const ROW_BUFFER_SIZE = 'stream.height * output.bytesPerSample / 5';
const EIGHT_BIT_ROW_BUFFER_SIZE = 8;
const TEN_BIT_ROW_BUFFER_SIZE = 16;
// Each invocation copies one word, so two-byte samples take twice the workgroups across a row
const FORMAT_COPY_DISPATCH = `${COPY_ENTRY_POINT}, ceil(stream.width * output.bytesPerSample / 64), stream.height, 3`;
const EIGHT_BIT_COPY_WORKGROUP_COUNTS = [ 1, CODED_HEIGHT, 3 ];
const TEN_BIT_COPY_WORKGROUP_COUNTS = [ 2, CODED_HEIGHT, 3 ];
const TEN_BIT_BYTES_PER_SAMPLE = 2;
// Sizes the session refuses for the default stream: negative, past the binding limit, empty, short of indirect arguments, and not evaluable
const SHRINKING_SIZE_OFFSET = 100;
const NEGATIVE_STATE_SIZE = `stream.width - ${SHRINKING_SIZE_OFFSET}`;
const STATE_SIZE_MULTIPLIER = 65_536;
const OVERSIZED_STATE_SIZE = `stream.width * stream.height * ${STATE_SIZE_MULTIPLIER}`;
const EMPTY_BUFFER_SIZE = `stream.width - ${CODED_WIDTH}`;
const INDIRECT_COUNTS_BUFFER_NAME = 'counts';
const ROWS_PER_INDIRECT_BYTE = 4;
const SHORT_INDIRECT_BUFFER_SIZE = `stream.height / ${ROWS_PER_INDIRECT_BYTE}`;
const ZERO_DIVISOR_BUFFER_SIZE = `stream.width / (stream.bitDepth - ${EIGHT_BIT_DEPTH})`;
const DIVISION_BY_ZERO_MESSAGE = 'Division by zero';
// A state of 101 bytes, which the session rounds up to 104 before checking the device's binding limit
const UNALIGNED_STATE_SIZE = 'stream.width + 37';
const ALIGNED_STATE_BYTE_LENGTH = 104;
const LITERAL_BUFFER_BYTE_LENGTH = 100;
const SMALL_BINDING_LIMIT = 64;

// Parser output: the depths that bound undecided frames, and event words
const PARSER_REORDER = 2;
const SINGLE_FRAME_REORDER = 1;
// Room for every frame of the end of stream and reset tests to stay undecided
const END_OF_STREAM_REORDER = 3;
const DISCARD_BIT = GPU_DECODER_OUTPUT_EVENT.discardBit;
const RESERVED_BIT = GPU_DECODER_OUTPUT_EVENT.reservedBit;
const RESERVED_BIT_EVENT_TEXT = '0x40000000';
const FUTURE_PICTURE_INDEX = 1;
// The frame index, and so the picture index, of the last of three queued packets
const LAST_QUEUED_PICTURE_INDEX = 2;
// A picture two packets never reach, which an end of stream event may not name
const NEVER_DECODED_PICTURE_INDEX = 4;
// The frame index of a packet that resets the decoder later in the stream
const RESET_PACKET_FRAME_INDEX = 3;
// A picture not decoded yet with the reserved bit set, either of which fails a decoder with a parser; one without never reads it
const UNREAD_PICTURE_INDEX = 5;
const UNREAD_OUTPUT_EVENT = (RESERVED_BIT | UNREAD_PICTURE_INDEX) >>> 0;

// Word offsets of the stream uniform, in GPUDecodeStream order: three 4-word planes, then width, height, bit depth, and bytes per sample
const STREAM_UNIFORM_WORD_COUNT = 20;
const STREAM_BYTES_PER_SAMPLE_WORD = 15;

// A wavefront between two dispatches: one wave per 4 rows of the stream, 9 for its 36 rows, and the counts pictures report
const REPEAT_DIRECTIVE_PREFIX = 'repeat:';
const WAVE_ENTRY_POINT = 'predictWave';
const ROWS_PER_WAVE = 4;
const STREAM_WAVE_COUNT = CODED_HEIGHT / ROWS_PER_WAVE;
const PICTURE_WAVE_COUNT = 3;
const EXCESSIVE_WAVE_COUNT = 0xFFFF_FFFF;
const WAVE_DISPATCHES = [
    `${PARSE_ENTRY_POINT}, 1`,
    `${REPEAT_DIRECTIVE_PREFIX} stream.height / ${ROWS_PER_WAVE}, 1`,
    `${WAVE_ENTRY_POINT}, 1`,
    `${FILL_ENTRY_POINT}, 1`
];
// A picture larger than the pool, and one smaller, at an odd size, as an AV1 frame after a size change
const OVERSIZED_PICTURE_SIZE = { height: CODED_HEIGHT, width: CODED_WIDTH + 2 };
const SMALLER_PICTURE_SIZE = { height: 19, width: 33 };

/** A session creation the session refuses: a description, the decoder, the stream, the device limits, and the failure. */
type CreationRejectionCase = readonly [string, GPUDecoderManifest, GPUDecodeStreamFacts, Partial<MockGPULimits>, GPUVideoDecodeFailure];

/** A decoder's sizes the session refuses for the default stream: a description, the decoder, the device limits, and the failure. */
type SizeRejectionCase = readonly [string, GPUDecoderManifest, Partial<MockGPULimits>, GPUVideoDecodeFailure];

/** A session's output format and what it sizes by it: the state and row buffer bytes, the copy's workgroup counts, and the bytes per sample. */
type FormatSizingCase = readonly [GPUDecoderOutputFormat, number, number, readonly number[], number];

type DecoderOptions = {
    buffers?: readonly string[]
    dispatches?: readonly string[]
    /** Whole `//! error:` lines */
    errors?: readonly string[]
    output?: string
    parser?: boolean
    references?: number
    reorder?: number
    requires?: string
    state?: number | string
};

/** One packet a decoder with a parser receives: its frame's timestamp in frame durations and the output events it carries. */
type ParserPacket = readonly [number, readonly number[] | null];

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
    // A dispatch sequence item is a dispatch's value, or a whole repeat directive
    const sequence = options.dispatches ?? [ COPY_DISPATCH ];
    const dispatches = sequence.filter(item => !item.startsWith(REPEAT_DIRECTIVE_PREFIX));
    const header = [
        `//! id: ${PACKAGE_VERSION.id}`,
        `//! name: ${DECODER_NAME}`,
        '//! decoder: video',
        `//! accepts: codec in [${CODEC_FAMILY}]`,
        `//! output: ${options.output ?? OUTPUT_FORMAT}`,
        ...(options.parser ? [ `//! parser: ${GPU_DECODER_PARSER_ABI_VERSION}` ] : []),
        `//! references: ${options.references ?? 0}`,
        `//! reorder: ${options.reorder ?? 0}`,
        `//! packet: ${PACKET_BYTE_LENGTH}`,
        `//! state: ${options.state ?? 0}`,
        ...(options.requires ? [ `//! requires: ${options.requires}` ] : []),
        ...(options.errors ?? []),
        ...(options.buffers ?? []).map(buffer => `//! buffer: ${buffer}`),
        ...sequence.map(item => (item.startsWith(REPEAT_DIRECTIVE_PREFIX) ? `//! ${item}` : `//! dispatch: ${item}`))
    ];
    const entryPoints = [ ...new Set(dispatches.map(dispatch => dispatch.split(',')[0].trim())) ];
    const body = entryPoints.map(entryPoint => `\n@compute @workgroup_size(64)\nfn ${entryPoint}() {\n}`).join('\n');
    return parseGPUDecoderManifest(`${header.join('\n')}\n${body}`);
}

function createSession(
    device: MockGPUDevice,
    manifest: GPUDecoderManifest = createManifest(),
    stream: GPUDecodeStreamFacts = STREAM,
    codecPrivate: Uint8Array | null = null,
    format: GPUDecoderOutputFormat = OUTPUT_FORMAT
): Promise<GPUVideoDecodeSession> {
    return GPUVideoDecodeSession.create({ codecPrivate, device: device.asDevice(), format, manifest, stream });
}

/** Returns each entry point's module, as the session compiles them, in dispatch order. */
function getEntryPointModuleCodes(manifest: GPUDecoderManifest, format: GPUDecoderOutputFormat): ReadonlyMap<string, string> {
    const entryPoints = [ ...new Set(manifest.dispatches.map(dispatch => dispatch.entryPoint)) ];
    const modules = splitGPUDecoderModule(createGPUDecoderModule(manifest, format).code, entryPoints);
    if (!modules) {
        throw new Error('The test decoder\'s module does not split');
    }
    return modules;
}

/** Creates a session of the test package, whose compiled decoder the device keeps for later sessions of its version and output format. */
function createPackageSession(
    device: MockGPUDevice,
    manifest: GPUDecoderManifest,
    format: GPUDecoderOutputFormat,
    decoderPackage: DecoderPackageVersion = PACKAGE_VERSION
): Promise<GPUVideoDecodeSession> {
    return GPUVideoDecodeSession.create({ codecPrivate: null, decoderPackage, device: device.asDevice(), format, manifest, stream: STREAM });
}

/** What a parser reports of a picture beyond its record and events: its repeat counts and visible size. */
type PictureReport = Partial<Pick<GPUDecodePacket, 'repeatCounts' | 'visibleSize'>>;

/**
 * Returns a packet whose bytes count up from 1, so its position in the ring is visible, with the output events and the picture report a parser decided;
 * a resetting packet is a key packet, and overrides set any other member.
 */
function createPacket(
    byteLength: number,
    timestampMicroseconds: number,
    reset = false,
    outputEvents: readonly number[] | null = null,
    pictureReport: PictureReport = {},
    overrides: Partial<GPUDecodePacket> = {}
): GPUDecodePacket {
    const bytes = new Uint8Array(byteLength);
    for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
        bytes[byteIndex] = (byteIndex + 1) & 0xFF;
    }
    return {
        data: bytes.buffer,
        durationMicroseconds: FRAME_DURATION_MICROSECONDS,
        fields: null,
        hold: false,
        keyframe: reset,
        outputEvents: outputEvents ? Uint32Array.from(outputEvents) : null,
        recovery: null,
        repeatCounts: pictureReport.repeatCounts ?? null,
        reset,
        timestampMicroseconds,
        visibleSize: pictureReport.visibleSize ?? null,
        ...overrides
    };
}

/** Returns a held packet at a frame index: one whose picture its parser lost, carrying the recovery that began its hold or none. */
function createHeldPacket(frameIndex: number, recovery: GPUVideoDecodeRecovery | null = null): GPUDecodePacket {
    return createPacket(0, frameIndex * FRAME_DURATION_MICROSECONDS, false, null, {}, { hold: true, recovery });
}

/**
 * Submits the packets of a decoder with a parser one at a time, the first resetting, and returns the timestamps presented after each,
 * once each packet's status readback applied. Each packet's timestamp counts frame durations, and every presented frame is taken and released at once.
 */
async function decodeParserPackets(session: GPUVideoDecodeSession, packets: readonly ParserPacket[]): Promise<number[][]> {
    const presented: number[][] = [];
    for (const [ packetIndex, [ frameIndex, outputEvents ] ] of packets.entries()) {
        session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, frameIndex * FRAME_DURATION_MICROSECONDS, packetIndex === 0, outputEvents));
        session.submitPendingDecodeWork();
        await session.waitForStatusReadbacks();
        presented.push(drainFrames(session));
    }
    return presented;
}

/** Submits one packet's decode work and waits for its status readback to apply, as the feed paces a session. */
async function submitAndWait(session: GPUVideoDecodeSession): Promise<boolean> {
    const submitted = session.submitPendingDecodeWork();
    await session.waitForStatusReadbacks();
    return submitted;
}

/** Plays a decoder that reports an error word for the packets of the given indices in decode order. */
function reportErrorAtPackets(device: MockGPUDevice, errorWordsByPacketIndex: ReadonlyMap<number, number>): void {
    device.dispatchHandler = (dispatch: MockDispatch): void => {
        const errorWord = errorWordsByPacketIndex.get(readPacketUniform(dispatch).index);
        if (errorWord !== undefined) {
            reportDecoderError(dispatch, errorWord);
        }
    };
}

/** Returns an error word, `(code << 24) | value`. */
function createErrorWord(code: number, value: number = FAILING_VALUE): number {
    return ((code << ERROR_CODE_SHIFT) | value) >>> 0;
}

/** Plays a decoder's reportDecodeError: a code the test header declares recoverable keeps the picture's most severe word, any other is fatal. */
function reportDecoderError(dispatch: MockDispatch, errorWord: number): void {
    const code = errorWord >>> ERROR_CODE_SHIFT;
    if (code === FATAL_ERROR_CODE) {
        reportStatus(dispatch, 0, errorWord);
        return;
    }
    const status = getBoundBuffer(dispatch, GPU_DECODER_BINDINGS.status);
    status.writeWords(STATUS_PICTURE_ERROR_WORD * BYTES_PER_WORD, [ errorWord ]);
}

/** Returns timestamps of frame indices, in frame durations. */
function toTimestamps(frameIndices: readonly number[]): number[] {
    return frameIndices.map(frameIndex => frameIndex * FRAME_DURATION_MICROSECONDS);
}

/** Returns the output event that drops a picture instead of presenting it. */
function createDiscardEvent(pictureIndex: number): number {
    return (DISCARD_BIT | pictureIndex) >>> 0;
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

/** Plays a decoder whose header reports the stream's coded size with a visible rectangle, such as a conformance window. */
function reportHeaderVisibleRectangle(device: MockGPUDevice, visibleRectangle: GPUDecodeStreamFacts['visibleRectangle']): void {
    device.dispatchHandler = (dispatch: MockDispatch): void => {
        getBoundBuffer(dispatch, GPU_DECODER_BINDINGS.status).writeWords(STATUS_HEADER_VALID_WORD * BYTES_PER_WORD, [
            1,
            CODED_WIDTH,
            CODED_HEIGHT,
            EIGHT_BIT_DEPTH,
            visibleRectangle.x,
            visibleRectangle.y,
            visibleRectangle.width,
            visibleRectangle.height
        ]);
    };
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

/** Takes every presentable frame in order into frames, without releasing any, as a frame queue holds the frames it waits to show. */
function takeFrames(session: GPUVideoDecodeSession, frames: GPUDecodedFrame[]): void {
    for (let frame = session.takeNextFrame(); frame; frame = session.takeNextFrame()) {
        frames.push(frame);
    }
}

/** Releases frames presentation took. */
function releaseFrames(session: GPUVideoDecodeSession, frames: readonly GPUDecodedFrame[]): void {
    for (const frame of frames) {
        session.releaseFrame(frame);
    }
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
    return createGPUFramePoolLayout(OUTPUT_FORMAT, CODED_WIDTH, CODED_HEIGHT, getGPUFramePoolSlotCount(0, 0)).byteLength;
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
        it('compiles one module per entry point of the declarations it reaches, builds its pipeline from it, and binds the engine buffers in order', async () => {
            const device = new MockGPUDevice();
            const manifest = createManifest({
                buffers: [ `${INDIRECT_BUFFER_NAME}, indirect, ${INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH}`, `${SCRATCH_BUFFER_NAME}, ${SCRATCH_BUFFER_BYTE_LENGTH}` ],
                dispatches: [ `${PARSE_ENTRY_POINT}, 1`, `${FILL_ENTRY_POINT}, indirect ${INDIRECT_BUFFER_NAME}`, `${PARSE_ENTRY_POINT}, 1` ],
                references: REFERENCES,
                reorder: REORDER
            });

            const session = await createSession(device, manifest);

            const moduleCodes = getEntryPointModuleCodes(manifest, OUTPUT_FORMAT);
            expect(device.shaderModuleCodes).toEqual([ moduleCodes.get(PARSE_ENTRY_POINT), moduleCodes.get(FILL_ENTRY_POINT) ]);
            expect(device.pipelines.map(pipeline => [ pipeline.entryPoint, pipeline.moduleCode ])).toEqual([
                [ PARSE_ENTRY_POINT, moduleCodes.get(PARSE_ENTRY_POINT) ],
                [ FILL_ENTRY_POINT, moduleCodes.get(FILL_ENTRY_POINT) ]
            ]);
            // Each module holds its own entry point and not the other's
            expect(moduleCodes.get(PARSE_ENTRY_POINT)).not.toContain(`fn ${FILL_ENTRY_POINT}`);
            expect(moduleCodes.get(FILL_ENTRY_POINT)).not.toContain(`fn ${PARSE_ENTRY_POINT}`);
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
            expect(device.getErrorScopeDepth()).toBe(0);
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
            const firstBodyLine = createGPUDecoderModule(manifest, OUTPUT_FORMAT).firstBodyLine;
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
            // The entry point's own module failed, so the whole module compiled for the decoder's messages
            expect(device.shaderModuleCodes.at(-1)).toBe(createGPUDecoderModule(manifest, OUTPUT_FORMAT).code);
        });

        it('builds every pipeline from the whole module when an entry point\'s own module fails where the whole module compiles', async () => {
            const device = new MockGPUDevice();
            const manifest = createManifest({ dispatches: [ `${PARSE_ENTRY_POINT}, 1`, `${COPY_ENTRY_POINT}, 1` ] });
            const wholeCode = createGPUDecoderModule(manifest, OUTPUT_FORMAT).code;
            device.compilationMessagesForCode = (code: string): MockCompilationMessage[] => (code === wholeCode ?
                [] :
                [ { lineNum: COMPILE_ERROR_PRELUDE_LINE, linePos: 1, message: COMPILE_ERROR_MESSAGE, type: 'error' } ]);

            await createSession(device, manifest);

            expect(device.pipelines.map(pipeline => [ pipeline.entryPoint, pipeline.moduleCode ])).toEqual([
                [ PARSE_ENTRY_POINT, wholeCode ],
                [ COPY_ENTRY_POINT, wholeCode ]
            ]);
        });

        it('compiles the whole module for code the split does not understand', async () => {
            const device = new MockGPUDevice();
            const manifest = createManifest();
            // A body the split does not understand, a block comment left open, which the whole module's compile reports
            const unsplittableManifest: GPUDecoderManifest = { ...manifest, body: `${manifest.body}\n/* open` };

            await createSession(device, unsplittableManifest);

            expect(device.shaderModuleCodes).toEqual([ createGPUDecoderModule(unsplittableManifest, OUTPUT_FORMAT).code ]);
            expect(device.pipelines.map(pipeline => pipeline.moduleCode)).toEqual([ createGPUDecoderModule(unsplittableManifest, OUTPUT_FORMAT).code ]);
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
                // The packet ring fits, so the pool is the first buffer the device refuses
                { maxStorageBufferBindingSize: RING_BYTE_LENGTH },
                { code: 'pool-size', detail: `${getDefaultPoolByteLength()} > ${RING_BYTE_LENGTH}` }
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

        it('rejects an output format the decoder does not list, before compiling or allocating anything', async () => {
            const device = new MockGPUDevice();

            const error = await getCreateError(createSession(device, createManifest({ output: BOTH_OUTPUT_FORMATS }), STREAM, null, UNLISTED_OUTPUT_FORMAT));

            expect(error.failure).toEqual({ code: 'format-unsupported', detail: `${UNLISTED_OUTPUT_FORMAT} not in ${OUTPUT_FORMAT}, ${TEN_BIT_OUTPUT_FORMAT}` });
            expect(device.shaderModuleCodes).toEqual([]);
            expect(device.buffers).toEqual([]);
        });

        it.each<FormatSizingCase>([
            [ OUTPUT_FORMAT, EIGHT_BIT_ROW_STATE_BUFFER_SIZE, EIGHT_BIT_ROW_BUFFER_SIZE, EIGHT_BIT_COPY_WORKGROUP_COUNTS, 1 ],
            [ TEN_BIT_OUTPUT_FORMAT, TEN_BIT_ROW_STATE_BUFFER_SIZE, TEN_BIT_ROW_BUFFER_SIZE, TEN_BIT_COPY_WORKGROUP_COUNTS, TEN_BIT_BYTES_PER_SAMPLE ]
        ])('sizes the %s session\'s state, scratch buffers, workgroup counts, pool, and prelude by its output format', async (
            format: GPUDecoderOutputFormat,
            stateBufferSize: number,
            rowBufferSize: number,
            workgroupCounts: readonly number[],
            bytesPerSample: number
        ) => {
            const device = new MockGPUDevice();
            const manifest = createManifest({
                buffers: [ `${ROW_BUFFER_NAME}, ${ROW_BUFFER_SIZE}` ],
                dispatches: [ FORMAT_COPY_DISPATCH ],
                output: BOTH_OUTPUT_FORMATS,
                state: ROW_STATE_SIZE
            });

            const session = await createSession(device, manifest, STREAM, null, format);
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true));
            session.submitPendingDecodeWork();

            expect(session.format).toBe(format);
            expect(session.pool.layout.format).toBe(format);
            expect(device.shaderModuleCodes).toEqual([ ...getEntryPointModuleCodes(manifest, format).values() ]);
            expect(device.findBuffer(`${BUFFER_LABEL_PREFIX} state`).size).toBe(stateBufferSize);
            expect(device.findBuffer(`${BUFFER_LABEL_PREFIX} buffer ${ROW_BUFFER_NAME}`).size).toBe(rowBufferSize);
            expect(device.dispatches[0].workgroupCounts).toEqual(workgroupCounts);
            expect(device.findBuffer(`${BUFFER_LABEL_PREFIX} stream`).readWords(0, STREAM_UNIFORM_WORD_COUNT)[STREAM_BYTES_PER_SAMPLE_WORD]).toBe(bytesPerSample);
        });

        it.each<SizeRejectionCase>([
            [
                'a state size below zero',
                createManifest({ state: NEGATIVE_STATE_SIZE }),
                {},
                { code: 'state-size', detail: `${CODED_WIDTH - SHRINKING_SIZE_OFFSET} < 0` }
            ],
            [
                'a state size past the storage binding limit',
                createManifest({ state: OVERSIZED_STATE_SIZE }),
                {},
                { code: 'state-size', detail: `${CODED_WIDTH * CODED_HEIGHT * STATE_SIZE_MULTIPLIER} > ${MAXIMUM_STORAGE_BUFFER_BINDING_SIZE}` }
            ],
            [
                'an empty scratch buffer',
                createManifest({ buffers: [ `${ROW_BUFFER_NAME}, ${EMPTY_BUFFER_SIZE}` ] }),
                {},
                { code: 'buffer-size', detail: `${ROW_BUFFER_NAME} 0 < 1` }
            ],
            [
                'an indirect buffer short of its dispatch arguments',
                createManifest({ buffers: [ `${INDIRECT_COUNTS_BUFFER_NAME}, indirect, ${SHORT_INDIRECT_BUFFER_SIZE}` ] }),
                {},
                {
                    code: 'buffer-size',
                    detail: `${INDIRECT_COUNTS_BUFFER_NAME} ${CODED_HEIGHT / ROWS_PER_INDIRECT_BYTE} < ${INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH}`
                }
            ],
            [
                'a buffer size the stream cannot evaluate',
                createManifest({ buffers: [ `${ROW_BUFFER_NAME}, ${ZERO_DIVISOR_BUFFER_SIZE}` ] }),
                {},
                { code: 'buffer-size', detail: `${ROW_BUFFER_NAME} ${DIVISION_BY_ZERO_MESSAGE}` }
            ],
            [
                'a state the device cannot bind once rounded up to whole words',
                createManifest({ state: UNALIGNED_STATE_SIZE }),
                { maxStorageBufferBindingSize: SMALL_BINDING_LIMIT },
                { code: 'state-size', detail: `${ALIGNED_STATE_BYTE_LENGTH} > ${SMALL_BINDING_LIMIT}` }
            ],
            [
                'a scratch buffer the device cannot bind',
                createManifest({ buffers: [ `${ROW_BUFFER_NAME}, ${LITERAL_BUFFER_BYTE_LENGTH}` ] }),
                { maxStorageBufferBindingSize: SMALL_BINDING_LIMIT },
                { code: 'buffer-size', detail: `${ROW_BUFFER_NAME} ${LITERAL_BUFFER_BYTE_LENGTH} > ${SMALL_BINDING_LIMIT}` }
            ],
            [
                'a packet ring the device cannot bind',
                createManifest(),
                { maxStorageBufferBindingSize: RING_BYTE_LENGTH - BYTES_PER_WORD },
                { code: 'packet-size', detail: `ring ${RING_BYTE_LENGTH} > ${RING_BYTE_LENGTH - BYTES_PER_WORD}` }
            ]
        ])('rejects %s before compiling or allocating anything', async (
            _description: string,
            manifest: GPUDecoderManifest,
            limits: Partial<MockGPULimits>,
            failure: GPUVideoDecodeFailure
        ) => {
            const device = new MockGPUDevice([], limits);

            const error = await getCreateError(createSession(device, manifest));

            expect(error.failure).toEqual(failure);
            expect(device.shaderModuleCodes).toEqual([]);
            expect(device.buffers).toEqual([]);
        });

        it('reports a pipeline the device cannot build with its entry point and the browser error', async () => {
            const device = new MockGPUDevice();
            device.pipelineFailure = createBrowserError();

            const error = await getCreateError(createSession(device));

            expect(error.failure).toEqual({ code: 'pipeline-error', detail: `${COPY_ENTRY_POINT} ${BROWSER_ERROR_NAME}: ${BROWSER_ERROR_MESSAGE}` });
        });

        it('keeps a package\'s compiled decoder on the device, so a later session of its output format compiles nothing', async () => {
            const device = new MockGPUDevice();
            const manifest = createManifest({ output: BOTH_OUTPUT_FORMATS });

            const first = await createPackageSession(device, manifest, OUTPUT_FORMAT);
            first.destroy();
            const second = await createPackageSession(device, manifest, OUTPUT_FORMAT);
            await createPackageSession(device, manifest, TEN_BIT_OUTPUT_FORMAT);

            expect(device.shaderModuleCodes).toEqual([
                ...getEntryPointModuleCodes(manifest, OUTPUT_FORMAT).values(),
                ...getEntryPointModuleCodes(manifest, TEN_BIT_OUTPUT_FORMAT).values()
            ]);
            expect(device.pipelines.map(pipeline => pipeline.entryPoint)).toEqual([ COPY_ENTRY_POINT, COPY_ENTRY_POINT ]);
            expect(device.bindGroupLayouts).toHaveLength(2);
            // The later session binds buffers of its own and decodes with the kept pipeline
            second.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true));
            expect(second.submitPendingDecodeWork()).toBe(true);
            expect(device.dispatches.at(-1)?.bindGroup).toBe(device.bindGroups.at(-2));
            expect(device.dispatches.at(-1)?.entryPoint).toBe(COPY_ENTRY_POINT);
        });

        it('compiles a rebuilt version of a package again, under the same id', async () => {
            const device = new MockGPUDevice();
            const manifest = createManifest();

            await createPackageSession(device, manifest, OUTPUT_FORMAT);
            await createPackageSession(device, manifest, OUTPUT_FORMAT, REBUILT_PACKAGE_VERSION);
            await createPackageSession(device, manifest, OUTPUT_FORMAT, REBUILT_PACKAGE_VERSION);

            expect(device.shaderModuleCodes).toHaveLength(2);
        });

        it('compiles again after a failed compile, and for every session without a package', async () => {
            const device = new MockGPUDevice();
            const manifest = createManifest();
            device.pipelineFailure = createBrowserError();

            const error = await getCreateError(createPackageSession(device, manifest, OUTPUT_FORMAT));
            device.pipelineFailure = null;
            await createPackageSession(device, manifest, OUTPUT_FORMAT);
            await createSession(device, manifest);
            await createSession(device, manifest);

            expect(error.failure.code).toBe('pipeline-error');
            expect(device.shaderModuleCodes).toHaveLength(4);
        });

        it('reports invalid WGSL that the browser raises only as a validation error as a compile error, inside a closed scope', async () => {
            const device = new MockGPUDevice();
            device.errorScopeHandler = (filter: GPUErrorFilter): string | null => (filter === VALIDATION_ERROR_FILTER ? SCOPE_ERROR_MESSAGE : null);

            const error = await getCreateError(createSession(device));

            expect(error.failure).toEqual({ code: 'compile-error', detail: SCOPE_ERROR_MESSAGE });
            expect(device.getErrorScopeDepth()).toBe(0);
            expect(device.pipelines).toEqual([]);
        });

        it('fails with the out-of-memory error of an allocation the device refuses, and destroys its buffers', async () => {
            const device = new MockGPUDevice();
            device.errorScopeHandler = (filter: GPUErrorFilter): string | null => (filter === OUT_OF_MEMORY_ERROR_FILTER ? SCOPE_ERROR_MESSAGE : null);

            const error = await getCreateError(createSession(device));

            expect(error.failure).toEqual({ code: 'out-of-memory', detail: SCOPE_ERROR_MESSAGE });
            expect(device.buffers.every(buffer => buffer.destroyed)).toBe(true);
            expect(device.getErrorScopeDepth()).toBe(0);
        });

        it('fails with a validation error its own allocations raise, after the module compiled', async () => {
            const device = new MockGPUDevice();
            let validationScopeCount = 0;
            device.errorScopeHandler = (filter: GPUErrorFilter): string | null => {
                if (filter !== VALIDATION_ERROR_FILTER) {
                    return null;
                }
                validationScopeCount += 1;
                // The first validation scope wraps the shader module, the second the allocations
                return validationScopeCount === 2 ? SCOPE_ERROR_MESSAGE : null;
            };

            const error = await getCreateError(createSession(device));

            expect(error.failure).toEqual({ code: 'validation-error', detail: SCOPE_ERROR_MESSAGE });
            expect(device.buffers.every(buffer => buffer.destroyed)).toBe(true);
            expect(device.getErrorScopeDepth()).toBe(0);
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
                await submitAndWait(session);
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
                await submitAndWait(session);
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

        it('fails the session on a picture whose visible size leaves the pool\'s coded size', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({ parser: true }));

            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true, [ 0 ], { visibleSize: OVERSIZED_PICTURE_SIZE }));
            session.submitPendingDecodeWork();

            expect(session.getFailure()).toEqual({
                code: 'visible-rectangle',
                detail: `picture ${OVERSIZED_PICTURE_SIZE.width}x${OVERSIZED_PICTURE_SIZE.height} exceeds ${CODED_WIDTH}x${CODED_HEIGHT}`
            });
            expect(device.submitCount).toBe(0);
        });

        it('fails the session on a picture whose repeat counts do not match the header\'s repeats', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({ dispatches: WAVE_DISPATCHES, parser: true }));

            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true, [ 0 ], { repeatCounts: [ PICTURE_WAVE_COUNT, PICTURE_WAVE_COUNT ] }));

            expect(session.getFailure()).toEqual({ code: 'dispatch-count', detail: 'picture repeat counts 2, header repeats 1' });
        });
    });

    describe('dispatch', () => {
        it('runs a repeat the header\'s count for the stream, or a picture\'s own smaller count, which never passes the header\'s', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({ dispatches: WAVE_DISPATCHES, parser: true }));
            const repeatCounts = [ null, [ PICTURE_WAVE_COUNT ], [ 0 ], [ EXCESSIVE_WAVE_COUNT ] ];

            const waveDispatchCounts: number[] = [];
            for (const [ packetIndex, counts ] of repeatCounts.entries()) {
                const dispatchCountBefore = device.dispatches.length;
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, packetIndex * FRAME_DURATION_MICROSECONDS, packetIndex === 0, [ packetIndex ], {
                    repeatCounts: counts
                }));
                await submitAndWait(session);
                drainFrames(session);
                waveDispatchCounts.push(device.dispatches.slice(dispatchCountBefore).filter(dispatch => dispatch.entryPoint === WAVE_ENTRY_POINT).length);
            }

            expect(waveDispatchCounts).toEqual([ STREAM_WAVE_COUNT, PICTURE_WAVE_COUNT, 0, STREAM_WAVE_COUNT ]);
            // The dispatches around the repeat run once for every picture
            expect(device.dispatches.filter(dispatch => dispatch.entryPoint === PARSE_ENTRY_POINT)).toHaveLength(repeatCounts.length);
            expect(device.dispatches.filter(dispatch => dispatch.entryPoint === FILL_ENTRY_POINT)).toHaveLength(repeatCounts.length);
        });

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
            const session = await createSession(device, createManifest({ state: STATE_BYTE_LENGTH }));
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
            const session = await createSession(device, createManifest({ references: REFERENCES, state: STATE_BYTE_LENGTH }));

            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true));
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, FRAME_DURATION_MICROSECONDS, true));
            await submitAndWait(session);
            drainFrames(session);
            await submitAndWait(session);
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
            const freeBeforeReadback = session.getFreeSlotCount();
            await session.waitForStatusReadbacks();
            drainFrames(session);

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

        it('submits a packet only with a free readback, so each packet\'s status is read back on its own', async () => {
            const device = new MockGPUDevice();
            device.manualMaps = true;
            // A reorder depth gives the pool more slots than readbacks, so readbacks alone hold the fourth packet back
            const session = await createSession(device, createManifest({ reorder: REORDER }));
            // Three packets take every readback, so the fourth waits for one
            const packetCount = 4;
            for (let packetIndex = 0; packetIndex < packetCount; packetIndex += 1) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, packetIndex * FRAME_DURATION_MICROSECONDS, packetIndex === 0));
            }

            const submittedWhileMapping = [ 0, 1, 2, 3 ].map((): boolean => session.submitPendingDecodeWork());
            const mapsWhileMapping = device.getPendingMapCount();
            device.settlePendingMaps();
            await session.waitForStatusReadbacks();
            const submittedOnceFree = session.submitPendingDecodeWork();

            expect(submittedWhileMapping).toEqual([ true, true, true, false ]);
            expect(mapsWhileMapping).toBe(3);
            expect(submittedOnceFree).toBe(true);
            expect(device.dispatches).toHaveLength(packetCount);
        });

        it('presents a frame only once its packet\'s status readback applied', async () => {
            const device = new MockGPUDevice();
            device.manualMaps = true;
            const session = await createSession(device);
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true));

            session.submitPendingDecodeWork();
            const takenBeforeReadback = session.takeNextFrame();
            const queuedBeforeReadback = session.getQueuedFrameCount();
            device.settlePendingMaps();
            await session.waitForStatusReadbacks();

            expect(takenBeforeReadback).toBeNull();
            expect(queuedBeforeReadback).toBe(1);
            expect(requireFrame(session.takeNextFrame()).timestampMicroseconds).toBe(0);
        });

        it('clears the packet\'s block after each copy, so one packet\'s picture report never reaches the next packet\'s frame', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({ errors: RECOVERY_ERROR_LINES }));
            reportErrorAtPackets(device, new Map([ [ 0, createErrorWord(CONCEALED_ERROR_CODE) ] ]));

            for (const frameIndex of [ 0, 1 ]) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, frameIndex * FRAME_DURATION_MICROSECONDS, frameIndex === 0));
                await submitAndWait(session);
            }

            expect(session.takeRecoveries()).toEqual([ { code: 'concealed', errorName: CONCEALED_ERROR_NAME, value: FAILING_VALUE } ]);
            expect(device.findBuffer(`${BUFFER_LABEL_PREFIX} status`).readWords(0, STATUS_WORD_COUNT)[STATUS_PICTURE_ERROR_WORD]).toBe(0);
            expect(drainFrames(session)).toEqual(toTimestamps([ 0, 1 ]));
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

        it('crops every frame to the visible rectangle the first header reports', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device);
            reportHeaderVisibleRectangle(device, HEADER_VISIBLE_RECTANGLE);

            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true));
            session.submitPendingDecodeWork();
            await session.waitForStatusReadbacks();

            expect(session.getFailure()).toBeNull();
            expect(requireFrame(session.takeNextFrame()).frame.visibleRectangle).toEqual(HEADER_VISIBLE_RECTANGLE);
        });

        it('fails when the header\'s visible rectangle runs past the pool\'s coded frame', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device);
            reportHeaderVisibleRectangle(device, { ...STREAM.visibleRectangle, x: SHIFTED_VISIBLE_X });

            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true));
            session.submitPendingDecodeWork();
            await session.waitForStatusReadbacks();

            expect(session.getFailure()).toEqual({
                code: 'visible-rectangle',
                detail: `header ${SHIFTED_VISIBLE_X},0 ${CODED_WIDTH}x${CODED_HEIGHT} exceeds ${CODED_WIDTH}x${CODED_HEIGHT}`
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

        it('gives a frame its packet\'s fields, and the decoder\'s own reported fields over them', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device);
            device.dispatchHandler = (dispatch: MockDispatch): void => {
                if (readPacketUniform(dispatch).index === 1) {
                    getBoundBuffer(dispatch, GPU_DECODER_BINDINGS.status).writeWords(STATUS_PICTURE_FIELDS_WORD * BYTES_PER_WORD, [ DECODER_FIELDS_WORD ]);
                }
            };

            for (const frameIndex of [ 0, 1, 2 ]) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, frameIndex * FRAME_DURATION_MICROSECONDS, frameIndex === 0, null, {}, {
                    fields: frameIndex === 2 ? null : CONTAINER_FIELDS
                }));
                await submitAndWait(session);
            }

            const fields: Array<VideoFrameFields | null> = [];
            for (let frame = session.takeNextFrame(); frame; frame = session.takeNextFrame()) {
                fields.push(frame.fields);
                session.releaseFrame(frame);
            }
            expect(fields).toEqual([ CONTAINER_FIELDS, DECODER_FIELDS, null ]);
        });
    });

    describe('recovery', () => {
        it('presents a picture its decoder concealed and counts the recovery', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({ errors: RECOVERY_ERROR_LINES }));
            reportErrorAtPackets(device, new Map([ [ 1, createErrorWord(CONCEALED_ERROR_CODE) ] ]));

            for (const frameIndex of [ 0, 1, 2 ]) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, frameIndex * FRAME_DURATION_MICROSECONDS, frameIndex === 0));
                await submitAndWait(session);
            }

            expect(session.getFailure()).toBeNull();
            expect(drainFrames(session)).toEqual(toTimestamps([ 0, 1, 2 ]));
            expect(session.takeRecoveries()).toEqual([ { code: 'concealed', errorName: CONCEALED_ERROR_NAME, value: FAILING_VALUE } ]);
            expect(session.takeRecoveries()).toEqual([]);
        });

        it('drops a picture its decoder could not decode, frees its slot, and decodes on', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({ errors: RECOVERY_ERROR_LINES, reorder: REORDER }));
            reportErrorAtPackets(device, new Map([ [ 1, createErrorWord(DROPPED_ERROR_CODE) ] ]));

            for (const frameIndex of [ 0, 1, 2, 3 ]) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, frameIndex * FRAME_DURATION_MICROSECONDS, frameIndex === 0));
                await submitAndWait(session);
            }
            session.endOfStream();

            expect(session.getFailure()).toBeNull();
            expect(drainFrames(session)).toEqual(toTimestamps([ 0, 2, 3 ]));
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount);
            expect(session.getDroppedFrameCount()).toBe(0);
            expect(session.takeRecoveries()).toEqual([ { code: 'dropped', errorName: DROPPED_ERROR_NAME, value: FAILING_VALUE } ]);
        });

        it('fails the attempt on an error its header declares no recovery for, as before', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({ errors: RECOVERY_ERROR_LINES }));
            reportErrorAtPackets(device, new Map([ [ 0, createErrorWord(FATAL_ERROR_CODE) ] ]));

            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true));
            await submitAndWait(session);

            expect(session.getFailure()).toEqual({ code: 'decoder-error', detail: String(createErrorWord(FATAL_ERROR_CODE)) });
            expect(session.takeRecoveries()).toEqual([]);
        });

        it('resyncs at the next key packet: the damaged and skipped pictures repeat the last good frame, and the key packet decodes from a reset', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({ errors: RECOVERY_ERROR_LINES, references: REFERENCES, state: STATE_BYTE_LENGTH }));
            reportErrorAtPackets(device, new Map([ [ 1, createErrorWord(RESYNCED_ERROR_CODE) ] ]));
            const keyFrameIndex = 4;
            // Presentation holds the frames it took, as the frame queue holds the frames it waits to show
            const takenFrames: GPUDecodedFrame[] = [];

            for (const frameIndex of [ 0, 1, 2, 3, keyFrameIndex, keyFrameIndex + 1 ]) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, frameIndex * FRAME_DURATION_MICROSECONDS, frameIndex === 0, null, {}, {
                    keyframe: frameIndex === 0 || frameIndex === keyFrameIndex
                }));
                await submitAndWait(session);
                takeFrames(session, takenFrames);
            }
            const takenSlots = takenFrames.map(frame => frame.slot);
            releaseFrames(session, takenFrames);

            // Packets 2 and 3 decode nothing: two dispatches before the key packet, then the key packet, from a reset, and the one after it
            expect(device.dispatches.map(dispatch => readPacketUniform(dispatch).reset)).toEqual([ 1, 0, 1, 0 ]);
            expect(takenFrames.map(frame => frame.timestampMicroseconds)).toEqual(toTimestamps([ 0, 1, 2, 3, keyFrameIndex, keyFrameIndex + 1 ]));
            // Frames 1 to 3 repeat frame 0's slot, the last good frame
            expect(takenSlots.slice(1, 4)).toEqual([ takenSlots[0], takenSlots[0], takenSlots[0] ]);
            expect(session.getFailure()).toBeNull();
            expect(session.takeRecoveries()).toEqual([ { code: 'resynced', errorName: RESYNCED_ERROR_NAME, value: FAILING_VALUE } ]);
            // Every hold ended: only the key packet's picture and the one after it remain the decoder's references
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount - 2);
        });

        it('keeps a parser session\'s picture numbering through a resync, applying the passed-over pictures\' events', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({ errors: RECOVERY_ERROR_LINES, parser: true, reorder: PARSER_REORDER }));
            reportErrorAtPackets(device, new Map([ [ 1, createErrorWord(RESYNCED_ERROR_CODE) ] ]));
            const packets: Array<readonly [number, readonly number[], boolean]> = [
                [ 0, [ 0 ], true ],
                [ 1, [], false ],
                // A passed-over picture, whose event presents picture 1, the damaged one, which repeats the last good frame
                [ 2, [ 1 ], false ],
                // The key picture, numbered on: picture 3
                [ 3, [ 2, 3 ], true ]
            ];

            const takenFrames: GPUDecodedFrame[] = [];
            for (const [ frameIndex, events, keyframe ] of packets) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, frameIndex * FRAME_DURATION_MICROSECONDS, frameIndex === 0, events, {}, { keyframe }));
                await submitAndWait(session);
                takeFrames(session, takenFrames);
            }
            const takenSlots = takenFrames.map(frame => frame.slot);
            releaseFrames(session, takenFrames);

            expect(session.getFailure()).toBeNull();
            expect(takenFrames.map(frame => frame.timestampMicroseconds)).toEqual(toTimestamps([ 0, 1, 2, 3 ]));
            // The damaged picture 1 and the passed-over picture 2 repeat picture 0
            expect(takenSlots.slice(1, 3)).toEqual([ takenSlots[0], takenSlots[0] ]);
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount);
        });

        it('holds the last good frame for the packets a restarted parser lost, presenting its undecided frames first, then resets at its first picture', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({ parser: true, reorder: END_OF_STREAM_REORDER }));
            const decoded = await decodeParserPackets(session, [ [ 1, [] ], [ 0, [] ] ]);

            // The worker lost packets 2 and 3 to a parser failure, then restarted its parser at the key packet 4
            session.queuePacket(createHeldPacket(2, PARSER_RECOVERY));
            session.queuePacket(createHeldPacket(3));
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 4 * FRAME_DURATION_MICROSECONDS, true, [ 0 ]));
            const presented: number[] = [];
            const slots: number[] = [];
            for (let call = 0; call < 3; call += 1) {
                await submitAndWait(session);
                for (let frame = session.takeNextFrame(); frame; frame = session.takeNextFrame()) {
                    presented.push(frame.timestampMicroseconds);
                    slots.push(frame.slot);
                    session.releaseFrame(frame);
                }
            }

            expect(decoded).toEqual([ [], [] ]);
            // The undecided frames 0 and 1 present first, then frame 1, the latest, repeats for the held packets 2 and 3
            expect(presented).toEqual(toTimestamps([ 0, 1, 2, 3, 4 ]));
            expect(slots.slice(2, 4)).toEqual([ slots[1], slots[1] ]);
            expect(device.dispatches.map(dispatch => readPacketUniform(dispatch).reset)).toEqual([ 1, 0, 1 ]);
            expect(session.takeRecoveries()).toEqual([ PARSER_RECOVERY ]);
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount);
        });

        it('presents nothing for held packets when no good frame is left to hold', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({ parser: true }));

            session.queuePacket(createHeldPacket(0, PARSER_RECOVERY));
            session.queuePacket(createHeldPacket(1));
            const consumed = [ await submitAndWait(session), await submitAndWait(session) ];

            expect(consumed).toEqual([ true, true ]);
            expect(session.takeNextFrame()).toBeNull();
            expect(device.dispatches).toHaveLength(0);
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount);
        });

        it('drops a resync\'s holds with every other frame on a reset', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({ errors: RECOVERY_ERROR_LINES, reorder: REORDER }));
            reportErrorAtPackets(device, new Map([ [ 1, createErrorWord(RESYNCED_ERROR_CODE) ] ]));

            for (const frameIndex of [ 0, 1, 2 ]) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, frameIndex * FRAME_DURATION_MICROSECONDS, frameIndex === 0));
                await submitAndWait(session);
            }
            const queuedBeforeReset = session.getQueuedFrameCount();
            session.reset();

            expect(queuedBeforeReset).toBe(3);
            expect(session.getQueuedFrameCount()).toBe(0);
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount);
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
                await submitAndWait(session);
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
            await session.waitForStatusReadbacks();

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

        it('presents a picture that reports its own visible size at its top-left samples of that size, and the others at the stream\'s rectangle', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({ parser: true }));

            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true, [ 0 ], { visibleSize: SMALLER_PICTURE_SIZE }));
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, FRAME_DURATION_MICROSECONDS, false, [ 1 ]));
            session.submitPendingDecodeWork();
            session.submitPendingDecodeWork();
            await session.waitForStatusReadbacks();
            const smaller = requireFrame(session.takeNextFrame());
            const full = requireFrame(session.takeNextFrame());

            expect(smaller.visibleSize).toEqual(SMALLER_PICTURE_SIZE);
            expect(smaller.frame.visibleRectangle).toEqual({ ...SMALLER_PICTURE_SIZE, x: 0, y: 0 });
            // The frame still names its slot, as the pool's frame does
            expect(smaller.frame.layout).toBe(session.pool.getFrame(smaller.slot).layout);
            expect(session.pool.getFrame(smaller.slot).visibleRectangle).toEqual(STREAM.visibleRectangle);
            expect(full.visibleSize).toBeNull();
            expect(full.frame).toBe(session.pool.getFrame(full.slot));
        });

        it('submits at most one packet per call and none while every slot is held, and reports which calls submitted', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device);
            const packetCount = 5;
            const submittedCalls: boolean[] = [];
            for (let packetIndex = 0; packetIndex < packetCount; packetIndex += 1) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, packetIndex * FRAME_DURATION_MICROSECONDS, packetIndex === 0));
            }

            for (let callIndex = 0; callIndex < packetCount; callIndex += 1) {
                submittedCalls.push(await submitAndWait(session));
            }
            const submitsWhileFull = device.submitCount;
            const frame = requireFrame(session.takeNextFrame());
            session.releaseFrame(frame);
            const submittedAfterRelease = session.submitPendingDecodeWork();

            const slotCount = session.pool.layout.slotCount;
            expect(submittedCalls).toEqual(submittedCalls.map((_submitted: boolean, callIndex: number): boolean => callIndex < slotCount));
            expect(submittedAfterRelease).toBe(true);
            expect(submitsWhileFull).toBe(slotCount);
            expect(device.submitCount).toBe(slotCount + 1);
            expect(session.getPendingPacketCount()).toBe(packetCount - slotCount - 1);
        });

        it('reports a call without a packet as submitting none', async () => {
            const session = await createSession(new MockGPUDevice());

            expect(session.submitPendingDecodeWork()).toBe(false);
        });

        it('drops queued packets and frames on a reset but leaves taken frames to presentation', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device);
            for (let packetIndex = 0; packetIndex < 4; packetIndex += 1) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, packetIndex * FRAME_DURATION_MICROSECONDS, packetIndex === 0));
            }
            session.submitPendingDecodeWork();
            session.submitPendingDecodeWork();
            await session.waitForStatusReadbacks();
            const taken = requireFrame(session.takeNextFrame());

            session.reset();

            expect(session.getPendingPacketCount()).toBe(0);
            expect(session.getQueuedFrameCount()).toBe(0);
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount - 1);
            expect(session.releaseFrame(taken)).toBe(true);
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount);
        });

        it('ignores output events without a parser, presenting in timestamp order', async () => {
            const session = await createSession(new MockGPUDevice());

            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true, [ UNREAD_OUTPUT_EVENT ]));
            await submitAndWait(session);

            expect(session.getFailure()).toBeNull();
            expect(drainFrames(session)).toEqual(toTimestamps([ 0 ]));
        });

        it('ignores the end of stream\'s output events without a parser', async () => {
            const session = await createSession(new MockGPUDevice(), createManifest({ reorder: REORDER }));
            for (const frameIndex of [ 0, 1 ]) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, frameIndex * FRAME_DURATION_MICROSECONDS, frameIndex === 0));
                await submitAndWait(session);
            }
            const presentedBeforeEnd = drainFrames(session);

            session.endOfStream(Uint32Array.of(UNREAD_OUTPUT_EVENT));

            expect(presentedBeforeEnd).toEqual([]);
            expect(session.getFailure()).toBeNull();
            expect(drainFrames(session)).toEqual(toTimestamps([ 0, 1 ]));
        });
    });

    describe('parser output', () => {
        it('presents each frame once an output event names it, its own packet\'s event included', async () => {
            const session = await createSession(new MockGPUDevice(), createManifest({ parser: true, reorder: PARSER_REORDER }));

            // Decode order 0, 2, 1, 3 by timestamp; each packet's events present the pictures the parser found next
            const presented = await decodeParserPackets(session, [
                [ 0, [] ],
                [ 2, [ 0 ] ],
                [ 1, [ 2 ] ],
                [ 3, [ 1, 3 ] ]
            ]);

            expect(presented).toEqual([ [], toTimestamps([ 0 ]), toTimestamps([ 1 ]), toTimestamps([ 2, 3 ]) ]);
            expect(session.getQueuedFrameCount()).toBe(0);
            expect(session.getDroppedFrameCount()).toBe(0);
            expect(session.getFailure()).toBeNull();
        });

        it('drops a frame a discard event names, freeing its slot without counting it as dropped', async () => {
            const session = await createSession(new MockGPUDevice(), createManifest({ parser: true, reorder: PARSER_REORDER }));

            const presented = await decodeParserPackets(session, [
                [ 0, [] ],
                [ 1, [ createDiscardEvent(0), 1 ] ]
            ]);

            expect(presented).toEqual([ [], toTimestamps([ 1 ]) ]);
            expect(session.getQueuedFrameCount()).toBe(0);
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount);
            expect(session.getDroppedFrameCount()).toBe(0);
        });

        it('decodes each picture of a packet as a packet of its own, a hidden picture freeing its slot at once and the shown one presenting at the packet\'s time', async () => {
            const session = await createSession(new MockGPUDevice(), createManifest({ parser: true }));

            // Three temporal units at frames 0, 1, and 2, as an AV1 parser makes them: hidden pictures drop by their own events
            const presented = await decodeParserPackets(session, [
                [ 0, [ createDiscardEvent(0) ] ],
                [ 0, [ 1 ] ],
                [ 1, [ 2 ] ],
                [ 2, [ createDiscardEvent(3) ] ],
                [ 2, [ createDiscardEvent(4) ] ],
                [ 2, [ 5 ] ]
            ]);

            expect(presented).toEqual([ [], toTimestamps([ 0 ]), toTimestamps([ 1 ]), [], [], toTimestamps([ 2 ]) ]);
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount);
            expect(session.getDroppedFrameCount()).toBe(0);
            expect(session.getFailure()).toBeNull();
        });

        it('presents the earliest undecided frame by timestamp once more frames are undecided than the reorder depth', async () => {
            const session = await createSession(new MockGPUDevice(), createManifest({ parser: true, reorder: SINGLE_FRAME_REORDER }));

            const presented = await decodeParserPackets(session, [ [ 2, null ], [ 0, null ], [ 1, [] ] ]);
            session.endOfStream();

            expect(presented).toEqual([ [], toTimestamps([ 0 ]), toTimestamps([ 1 ]) ]);
            expect(drainFrames(session)).toEqual(toTimestamps([ 2 ]));
            expect(session.getDroppedFrameCount()).toBe(0);
        });

        it('ignores an output event for a picture that already left', async () => {
            // Without a reorder depth every frame leaves as soon as its packet's events are applied
            const session = await createSession(new MockGPUDevice(), createManifest({ parser: true }));

            const presented = await decodeParserPackets(session, [ [ 0, [] ], [ 1, [ 0 ] ] ]);

            expect(presented).toEqual([ toTimestamps([ 0 ]), toTimestamps([ 1 ]) ]);
            expect(session.getFailure()).toBeNull();
            expect(session.getDroppedFrameCount()).toBe(0);
        });

        it('presents undecided frames in timestamp order at the end of the stream, once every queued packet decoded', async () => {
            const session = await createSession(new MockGPUDevice(), createManifest({ parser: true, reorder: END_OF_STREAM_REORDER }));
            const frameIndices = [ 2, 0, 1 ];
            for (const [ packetIndex, frameIndex ] of frameIndices.entries()) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, frameIndex * FRAME_DURATION_MICROSECONDS, packetIndex === 0, []));
            }

            session.endOfStream();
            const presentedBeforeDecoding = drainFrames(session);
            // One decode step per queued packet
            const presentedWhileDecoding: number[][] = [];
            const stepCount = frameIndices.length;
            for (let step = 0; step < stepCount; step += 1) {
                await submitAndWait(session);
                presentedWhileDecoding.push(drainFrames(session));
            }

            expect(presentedBeforeDecoding).toEqual([]);
            expect(presentedWhileDecoding).toEqual([ [], [], toTimestamps([ 0, 1, 2 ]) ]);
            expect(session.getQueuedFrameCount()).toBe(0);
        });

        it('drops an undecided frame earlier than a presented one at the end of the stream, freeing its slot', async () => {
            const session = await createSession(new MockGPUDevice(), createManifest({ parser: true, reorder: END_OF_STREAM_REORDER }));

            const presented = await decodeParserPackets(session, [ [ 1, [ 0 ] ], [ 0, [] ] ]);
            session.endOfStream();

            expect(presented).toEqual([ toTimestamps([ 1 ]), [] ]);
            expect(drainFrames(session)).toEqual([]);
            expect(session.getDroppedFrameCount()).toBe(1);
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount);
        });

        it('fails with output-event when an event names a picture not decoded yet, and decodes nothing after', async () => {
            const device = new MockGPUDevice();
            const session = await createSession(device, createManifest({ parser: true, reorder: PARSER_REORDER }));

            const presented = await decodeParserPackets(session, [ [ 0, [ FUTURE_PICTURE_INDEX ] ], [ 1, [] ] ]);

            expect(session.getFailure()).toEqual({ code: 'output-event', detail: `picture ${FUTURE_PICTURE_INDEX} after 0` });
            expect(presented).toEqual([ [], [] ]);
            expect(device.submitCount).toBe(1);
            expect(session.getPendingPacketCount()).toBe(0);
            expect(session.submitPendingDecodeWork()).toBe(false);
        });

        it('fails with output-event on an event that sets the reserved bit', async () => {
            const session = await createSession(new MockGPUDevice(), createManifest({ parser: true, reorder: PARSER_REORDER }));

            const presented = await decodeParserPackets(session, [ [ 0, [ RESERVED_BIT ] ] ]);

            expect(session.getFailure()).toEqual({ code: 'output-event', detail: `${RESERVED_BIT_EVENT_TEXT} sets the reserved bit` });
            expect(presented).toEqual([ [] ]);
        });

        it('drops undecided frames on a reset and counts pictures from 0 again', async () => {
            const session = await createSession(new MockGPUDevice(), createManifest({ parser: true, reorder: END_OF_STREAM_REORDER }));
            await decodeParserPackets(session, [ [ 0, [] ], [ 1, [] ], [ 2, [] ] ]);
            const queuedBeforeReset = session.getQueuedFrameCount();

            session.reset();
            const freeSlotsAfterReset = session.getFreeSlotCount();
            // Picture 0 of the new epoch; counted on from before the reset it would be picture 3, and the event would name a picture already gone
            const presented = await decodeParserPackets(session, [ [ 0, [ 0 ] ] ]);

            expect(queuedBeforeReset).toBe(END_OF_STREAM_REORDER);
            expect(freeSlotsAfterReset).toBe(session.pool.layout.slotCount);
            expect(presented).toEqual([ toTimestamps([ 0 ]) ]);
            expect(session.getFailure()).toBeNull();
        });

        it('restarts picture numbering at a packet with the reset flag, dropping the undecided frames without presenting them', async () => {
            const session = await createSession(new MockGPUDevice(), createManifest({ parser: true, reorder: END_OF_STREAM_REORDER }));
            const presented = await decodeParserPackets(session, [ [ 0, [ 0 ] ], [ 1, [] ], [ 2, [] ] ]);
            const queuedBeforeResetPacket = session.getQueuedFrameCount();

            // A new sequence later in the stream, which its parser numbers from picture 0 again; no session reset precedes it
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, RESET_PACKET_FRAME_INDEX * FRAME_DURATION_MICROSECONDS, true, [ 0 ]));
            await submitAndWait(session);
            const presentedAfterResetPacket = drainFrames(session);

            expect(presented).toEqual([ toTimestamps([ 0 ]), [], [] ]);
            expect(queuedBeforeResetPacket).toBe(2);
            expect(presentedAfterResetPacket).toEqual(toTimestamps([ RESET_PACKET_FRAME_INDEX ]));
            expect(session.getQueuedFrameCount()).toBe(0);
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount);
            expect(session.getFailure()).toBeNull();
        });

        it('applies the end of stream\'s output events, then presents the frames still undecided in timestamp order', async () => {
            const session = await createSession(new MockGPUDevice(), createManifest({ parser: true, reorder: END_OF_STREAM_REORDER }));
            await decodeParserPackets(session, [ [ 0, [] ], [ 1, [] ], [ 2, [] ] ]);

            // The last packets had no picture to carry their events: picture 1 drops, and picture 0 presents
            session.endOfStream(Uint32Array.of(createDiscardEvent(1), 0));

            expect(drainFrames(session)).toEqual(toTimestamps([ 0, 2 ]));
            expect(session.getDroppedFrameCount()).toBe(0);
            expect(session.getFreeSlotCount()).toBe(session.pool.layout.slotCount);
        });

        it('applies the end of stream\'s output events before the undecided frames leave', async () => {
            const session = await createSession(new MockGPUDevice(), createManifest({ parser: true, reorder: END_OF_STREAM_REORDER }));
            await decodeParserPackets(session, [ [ 0, [] ], [ 1, [] ], [ 2, [] ] ]);

            // Presenting the latest picture first leaves the two earlier undecided frames behind presentation order
            session.endOfStream(Uint32Array.of(LAST_QUEUED_PICTURE_INDEX));

            expect(drainFrames(session)).toEqual(toTimestamps([ LAST_QUEUED_PICTURE_INDEX ]));
            expect(session.getDroppedFrameCount()).toBe(2);
        });

        it('waits for every queued packet before applying the end of stream\'s output events', async () => {
            const session = await createSession(new MockGPUDevice(), createManifest({ parser: true, reorder: END_OF_STREAM_REORDER }));
            const frameIndices = [ 0, 1, LAST_QUEUED_PICTURE_INDEX ];
            for (const [ packetIndex, frameIndex ] of frameIndices.entries()) {
                session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, frameIndex * FRAME_DURATION_MICROSECONDS, packetIndex === 0, []));
            }

            // The event names the last picture, which exists only once its packet decoded
            session.endOfStream(Uint32Array.of(createDiscardEvent(LAST_QUEUED_PICTURE_INDEX)));
            // One decode step per queued packet
            const presentedWhileDecoding: number[][] = [];
            const stepCount = frameIndices.length;
            for (let step = 0; step < stepCount; step += 1) {
                await submitAndWait(session);
                presentedWhileDecoding.push(drainFrames(session));
            }

            expect(presentedWhileDecoding).toEqual([ [], [], toTimestamps([ 0, 1 ]) ]);
            expect(session.getFailure()).toBeNull();
        });

        it('fails with output-event on an end of stream event that names a picture never decoded, presenting nothing more', async () => {
            const session = await createSession(new MockGPUDevice(), createManifest({ parser: true, reorder: END_OF_STREAM_REORDER }));
            await decodeParserPackets(session, [ [ 0, [] ], [ 1, [] ] ]);

            session.endOfStream(Uint32Array.of(NEVER_DECODED_PICTURE_INDEX));

            expect(session.getFailure()).toEqual({ code: 'output-event', detail: `picture ${NEVER_DECODED_PICTURE_INDEX} after 1` });
            expect(session.getQueuedFrameCount()).toBe(2);
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

        it('fails every live session of a lost device, those created after the first included, and none it destroyed', async () => {
            const device = new MockGPUDevice();
            const first = await createSession(device);
            const destroyed = await createSession(device);
            destroyed.destroy();
            const later = await createSession(device);
            device.loseDevice(LOST_DEVICE_MESSAGE);
            await device.lost;

            const failure: GPUVideoDecodeFailure = { code: 'device-lost', detail: `${LOST_DEVICE_REASON}: ${LOST_DEVICE_MESSAGE}` };
            expect(first.getFailure()).toEqual(failure);
            expect(later.getFailure()).toEqual(failure);
            expect(destroyed.getFailure()).toBeNull();
        });

        it('destroys every buffer, including the pool, and ignores calls after', async () => {
            const device = new MockGPUDevice();
            device.manualMaps = true;
            const session = await createSession(device);
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 0, true));
            session.submitPendingDecodeWork();
            device.settlePendingMaps();
            await session.waitForStatusReadbacks();
            const frame = requireFrame(session.takeNextFrame());
            // A second packet's readback still maps when the session is destroyed
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, FRAME_DURATION_MICROSECONDS));
            session.submitPendingDecodeWork();

            session.destroy();
            session.queuePacket(createPacket(SMALL_PACKET_BYTE_LENGTH, 2 * FRAME_DURATION_MICROSECONDS));
            session.submitPendingDecodeWork();
            await session.waitForStatusReadbacks();

            expect(device.buffers.every(buffer => buffer.destroyed)).toBe(true);
            expect(device.submitCount).toBe(2);
            expect(session.getFailure()).toBeNull();
            expect(session.releaseFrame(frame)).toBe(false);
        });
    });
});
