import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';
import {
    createHEVCDecoderBackend,
    createHEVCDecoderModule,
    MAXIMUM_HEVC_DRAINED_FRAME_COUNT,
    type HEVCDecodedFrame,
    type HEVCDecodedFrameHandler,
    type HEVCDecoderBackend,
    type HEVCDecoderWASMModule,
    type HEVCFrameBitDepth,
    type HEVCFramePlane
} from 'webgpu-player/video/decoders/HEVCDecoderBackend';

// Addresses in the fake WASM memory, all even so 10-bit planes start on 16-bit boundaries
const FAKE_HEAP_BYTE_LENGTH = 65_536;
const NULL_POINTER = 0;
// Each native decoder the fake creates is the next of these
const FIRST_DECODER_POINTER = 16;
const DECODER_POINTER_STRIDE = 16;
const EXTRADATA_POINTER = 256;
const PACKET_POINTER = 512;
const LUMA_PLANE_POINTER = 1_024;
const CHROMA_BLUE_PLANE_POINTER = 2_048;
const CHROMA_RED_PLANE_POINTER = 3_072;
// The bridge's plane indexes
const LUMA_PLANE_INDEX = 0;
const CHROMA_BLUE_PLANE_INDEX = 1;
const CHROMA_RED_PLANE_INDEX = 2;
const PLANE_POINTERS = [ LUMA_PLANE_POINTER, CHROMA_BLUE_PLANE_POINTER, CHROMA_RED_PLANE_POINTER ];

// WASM memory reaches 4 GiB, and an i32 return reports an address past 2 GiB as negative
const TWO_GIB_BYTE_LENGTH = 2 ** 31;
const UINT32_VALUE_COUNT = 2 ** 32;
const HIGH_DECODER_POINTER = TWO_GIB_BYTE_LENGTH + FIRST_DECODER_POINTER;
const HIGH_DECODER_POINTER_AS_I32 = HIGH_DECODER_POINTER - UINT32_VALUE_COUNT;
// Past the end of the fake memory once read as unsigned, but before its start if read as signed
const HIGH_HEAP_POINTER_AS_I32 = TWO_GIB_BYTE_LENGTH + LUMA_PLANE_POINTER - UINT32_VALUE_COUNT;

// FFmpeg's AVERROR(EAGAIN), AVERROR_EOF, AVERROR_INVALIDDATA, and AVERROR(EINVAL)
const AGAIN_ERROR = -11;
const EOF_ERROR = -541_478_725;
const INVALID_DATA_ERROR_CODE = -1_094_995_529;
const INVALID_ARGUMENT_ERROR_CODE = -22;
// FFmpeg's AV_NOPTS_VALUE, the timing of a frame that has none
const AV_NOPTS_VALUE = BigInt('-9223372036854775808');

const EIGHT_BIT_DEPTH = 8;
const TEN_BIT_DEPTH = 10;
// The bridge reports 0 for any format other than 8-bit or 10-bit 4:2:0
const UNSUPPORTED_FORMAT_BIT_DEPTH = 0;

// A 5x3 frame, whose chroma planes round up to 3x2, with rows padded to 8 luma and 4 chroma samples
const FRAME_WIDTH = 5;
const FRAME_HEIGHT = 3;
const FRAME_CHROMA_WIDTH = 3;
const FRAME_CHROMA_HEIGHT = 2;
const ZERO_FRAME_DIMENSION = 0;
const LUMA_STRIDE_SAMPLE_COUNT = 8;
const CHROMA_STRIDE_SAMPLE_COUNT = 4;
// A plane view runs from its first sample to the end of its last row
const LUMA_PLANE_SAMPLE_COUNT = ((FRAME_HEIGHT - 1) * LUMA_STRIDE_SAMPLE_COUNT) + FRAME_WIDTH;
const CHROMA_PLANE_SAMPLE_COUNT = ((FRAME_CHROMA_HEIGHT - 1) * CHROMA_STRIDE_SAMPLE_COUNT) + FRAME_CHROMA_WIDTH;
// Each plane's samples, padding included, count up from its first sample; 10-bit samples reach above a byte
const LUMA_FIRST_SAMPLE = 16;
const CHROMA_BLUE_FIRST_SAMPLE = 64;
const CHROMA_RED_FIRST_SAMPLE = 128;
const TEN_BIT_SAMPLE_OFFSET = 512;
// An 8-bit luma plane at this address ends exactly at the end of the fake memory
const LAST_FITTING_LUMA_PLANE_POINTER = FAKE_HEAP_BYTE_LENGTH - LUMA_PLANE_SAMPLE_COUNT;
const TEN_BIT_LUMA_STRIDE_BYTE_LENGTH = LUMA_STRIDE_SAMPLE_COUNT * Uint16Array.BYTES_PER_ELEMENT;
const ODD_TEN_BIT_LUMA_STRIDE_BYTE_LENGTH = TEN_BIT_LUMA_STRIDE_BYTE_LENGTH + 1;
const ODD_LUMA_PLANE_POINTER = LUMA_PLANE_POINTER + 1;
const EIGHT_BIT_STRIDE_BELOW_ROW_BYTE_LENGTH = FRAME_WIDTH - 1;
// A 10-bit stride counted in samples instead of bytes falls short of its row's bytes
const TEN_BIT_STRIDE_IN_SAMPLES_BYTE_LENGTH = LUMA_STRIDE_SAMPLE_COUNT;

// A length-prefixed IDR slice, which the fake bridge does not parse
const PACKET_DATA = new Uint8Array([ 0, 0, 0, 3, 38, 1, 175 ]);
const EMPTY_PACKET_DATA = new Uint8Array(0);
const PACKET_POINTER_PAST_MEMORY_END = FAKE_HEAP_BYTE_LENGTH - PACKET_DATA.byteLength + 1;
const PACKET_TIMESTAMP_MICROSECONDS = 1_291_708 as Microseconds;
const PACKET_DURATION_MICROSECONDS = 41_708 as Microseconds;
// A picture an earlier packet coded, which this packet made displayable, so it carries that packet's timing
const FRAME_TIMESTAMP_MICROSECONDS = 1_250_000;
const FRAME_DURATION_MICROSECONDS = 41_708;
const NEGATIVE_FRAME_DURATION = BigInt(-1);
// 2^53 microseconds, the first timestamp past the safe integer range
const UNSAFE_FRAME_TIMESTAMP = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1);
const DISPLAYABLE_FRAME_COUNT = 3;
const HELD_FRAME_COUNT = 2;

// The leading bytes of an HVCC record, which the backend hands to FFmpeg unread
const DESCRIPTION_DATA = new Uint8Array([ 1, 2, 32, 0, 0, 0, 144 ]);
const EMPTY_DESCRIPTION = new Uint8Array(0);
const NO_EXTRADATA_BYTE_LENGTH = 0;
const EXTRADATA_POINTER_PAST_MEMORY_END = FAKE_HEAP_BYTE_LENGTH - DESCRIPTION_DATA.byteLength + 1;
// One byte past the bridge's bound on a description
const OVERSIZED_DESCRIPTION_BYTE_LENGTH = (1024 * 1024) + 1;

const WASM_URL = 'https://example.test/web/libraries/ffmpeg-hevc/ffmpeg-hevc.wasm';
// The file the glue asks locateFile for
const GLUE_WASM_FILE_NAME = 'ffmpeg-hevc.wasm';
const PRELOADED_WASM_BYTE_LENGTH = 8;

const PLANE_OUTSIDE_MEMORY_ERROR = 'returned a plane outside its memory';
const PACKET_ALLOCATION_ERROR = 'could not allocate a packet';
const DESCRIPTION_ALLOCATION_ERROR = 'description allocation is invalid';
const DESCRIPTION_TOO_LARGE_ERROR = 'description is too large';
const CREATE_FAILURE_ERROR = 'could not create a decoder';
const EMPTY_PACKET_ERROR = 'The HEVC packet is empty';
const DESTROYED_ERROR = 'is destroyed';
const FRAME_BOUND_ERROR = 'exceeded its frame bound';
const DRAIN_INCOMPLETE_ERROR = 'drain ended before its last frame';
const UNSUPPORTED_FORMAT_ERROR = 'is not 8-bit or 10-bit 4:2:0';
const INVALID_DIMENSIONS_ERROR = 'invalid frame dimensions';
const MISSING_TIMESTAMP_ERROR = 'frame without a timestamp';
const MISSING_DURATION_ERROR = 'frame without a duration';
const NEGATIVE_DURATION_ERROR = 'frame with a negative duration';
const UNSAFE_TIMESTAMP_ERROR = 'timestamp must be a safe integer number of microseconds';
const FACTORY_UNAVAILABLE_ERROR = 'factory is unavailable';
const WASM_TRAP_MESSAGE = 'unreachable';
const CONSUMER_ERROR_MESSAGE = 'consumer failed';
const INSTANTIATION_ERROR_MESSAGE = 'instantiation failed';

/** Where a plane of a fake frame lies in WASM memory, as the bridge reports it. */
type FakeFramePlane = Readonly<{
    pointer: number
    strideByteLength: number
}>;

/** A frame the fake decoder outputs, as the bridge's getters report it. */
type FakeFrame = Readonly<{
    bitDepth: number
    duration: bigint
    height: number
    /** Luma, then blue and red chroma, in the bridge's plane order */
    planes: readonly FakeFramePlane[]
    timestamp: bigint
    width: number
}>;

/** The settings object the glue factory receives. */
type GlueModuleOptions = Readonly<{
    locateFile?: (path: string) => string
    wasmBinary?: ArrayBuffer
}>;

type GlueModuleFactory = Mock<(options: GlueModuleOptions) => Promise<HEVCDecoderWASMModule>>;

/** A plane as a consumer reads it while its handler runs. */
type PlaneSnapshot = Readonly<{
    byteOffset: number
    sampleArrayName: string
    samples: number[]
    stride: number
    viewsWASMMemory: boolean
}>;

type FrameSnapshot = Omit<HEVCDecodedFrame, 'planes'> & Readonly<{
    planes: Readonly<{
        chromaBlue: PlaneSnapshot
        chromaRed: PlaneSnapshot
        luma: PlaneSnapshot
    }>
}>;

type FrameObservation = Readonly<{
    receiveCallCount: number
    timestampMicroseconds: number
}>;

type PlaneRejectionCase = Readonly<{
    bitDepth: HEVCFrameBitDepth
    label: string
    plane: Partial<FakeFramePlane>
    planeIndex: number
}>;

type FrameRejectionCase = Readonly<{
    error: string
    frame: Partial<FakeFrame>
    label: string
}>;

type NativeFailureCase = Readonly<{
    call: (backend: HEVCDecoderBackend) => number
    error: string
    fail: (module: FakeHEVCDecoderWASMModule) => void
    label: string
}>;

type AllocationCase = Readonly<{
    label: string
    pointer: number
}>;

/* eslint-disable @typescript-eslint/naming-convention -- Mirrors the external WASM ABI */
/** The bridge's exports over FFmpeg, whose frames' planes lie where each test writes them. */
class FakeHEVCDecoderWASMModule implements HEVCDecoderWASMModule {
    public readonly HEAPU8 = new Uint8Array(FAKE_HEAP_BYTE_LENGTH);
    public readonly _hevc_decoder_close = vi.fn<(decoder: number) => void>();
    public readonly _hevc_decoder_configure_packet = vi.fn<(decoder: number, packetByteLength: number) => number>();
    public readonly _hevc_decoder_create = vi.fn<(extradataByteLength: number) => number>();
    public readonly _hevc_decoder_error_again = (): number => AGAIN_ERROR;
    public readonly _hevc_decoder_error_eof = (): number => EOF_ERROR;
    public readonly _hevc_decoder_get_bit_depth = vi.fn<(decoder: number) => number>();
    public readonly _hevc_decoder_get_duration = vi.fn<(decoder: number) => bigint>();
    public readonly _hevc_decoder_get_extradata = vi.fn<(decoder: number) => number>();
    public readonly _hevc_decoder_get_height = vi.fn<(decoder: number) => number>();
    public readonly _hevc_decoder_get_plane = vi.fn<(decoder: number, plane: number) => number>();
    public readonly _hevc_decoder_get_stride = vi.fn<(decoder: number, plane: number) => number>();
    public readonly _hevc_decoder_get_timestamp = vi.fn<(decoder: number) => bigint>();
    public readonly _hevc_decoder_get_width = vi.fn<(decoder: number) => number>();
    public readonly _hevc_decoder_open = vi.fn<(decoder: number) => number>();
    public readonly _hevc_decoder_receive_frame = vi.fn<(decoder: number) => number>();
    public readonly _hevc_decoder_reset = vi.fn<(decoder: number) => void>();
    public readonly _hevc_decoder_send_packet = vi.fn<
        (decoder: number, presentationTimestamp: bigint, duration: bigint) => number
    >();
    public readonly _hevc_decoder_start_drain = vi.fn<(decoder: number) => number>();

    /** What starting a drain returns: 0, or AVERROR_EOF for a decoder FFmpeg already drained */
    public drainStartResult = 0;
    /** The frames a drain outputs, in display order */
    public readonly drainFrames: FakeFrame[] = [];
    /** The bytes at the reserved description address as each decoder opened */
    public readonly openedDescriptions: Uint8Array[] = [];
    /** The frames each sent packet makes displayable, in display order */
    public readonly sendFrameBatches: FakeFrame[][] = [];
    /** Each packet as it lay in WASM memory when it was sent */
    public readonly sentPackets: Uint8Array[] = [];
    private currentFrame: FakeFrame | null = null;
    private draining = false;
    private extradataByteLength = NO_EXTRADATA_BYTE_LENGTH;
    private nextDecoderPointer = FIRST_DECODER_POINTER;
    private packetByteLength = 0;
    private readonly readyFrames: FakeFrame[] = [];

    public constructor() {
        this._hevc_decoder_create.mockImplementation((extradataByteLength: number): number => {
            this.extradataByteLength = extradataByteLength;
            const decoder = this.nextDecoderPointer;
            this.nextDecoderPointer += DECODER_POINTER_STRIDE;
            return decoder;
        });
        this._hevc_decoder_get_extradata.mockReturnValue(EXTRADATA_POINTER);
        this._hevc_decoder_open.mockImplementation((): number => {
            this.openedDescriptions.push(this.HEAPU8.slice(
                EXTRADATA_POINTER,
                EXTRADATA_POINTER + this.extradataByteLength
            ));
            return 0;
        });
        this._hevc_decoder_configure_packet.mockImplementation((
            ...parameters: [ decoder: number, packetByteLength: number ]
        ): number => {
            // FFmpeg takes no packet while it drains
            if (this.draining) {
                return NULL_POINTER;
            }
            this.packetByteLength = parameters[1];
            return PACKET_POINTER;
        });
        this._hevc_decoder_send_packet.mockImplementation((): number => {
            this.sentPackets.push(this.HEAPU8.slice(PACKET_POINTER, PACKET_POINTER + this.packetByteLength));
            this.readyFrames.push(...(this.sendFrameBatches.shift() ?? []));
            return 0;
        });
        this._hevc_decoder_start_drain.mockImplementation((): number => {
            this.draining = true;
            this.readyFrames.push(...this.drainFrames.splice(0));
            return this.drainStartResult;
        });
        this._hevc_decoder_receive_frame.mockImplementation((): number => {
            const frame = this.readyFrames.shift();
            if (!frame) {
                return this.draining ? EOF_ERROR : AGAIN_ERROR;
            }
            this.currentFrame = frame;
            return 0;
        });
        this._hevc_decoder_reset.mockImplementation((): void => {
            this.currentFrame = null;
            this.draining = false;
            this.readyFrames.length = 0;
        });
        this._hevc_decoder_get_bit_depth.mockImplementation((): number => this.requireCurrentFrame().bitDepth);
        this._hevc_decoder_get_duration.mockImplementation((): bigint => this.requireCurrentFrame().duration);
        this._hevc_decoder_get_height.mockImplementation((): number => this.requireCurrentFrame().height);
        this._hevc_decoder_get_plane.mockImplementation((...parameters: [ decoder: number, plane: number ]): number => (
            this.requireCurrentFrame().planes[parameters[1]].pointer
        ));
        this._hevc_decoder_get_stride.mockImplementation((...parameters: [ decoder: number, plane: number ]): number => (
            this.requireCurrentFrame().planes[parameters[1]].strideByteLength
        ));
        this._hevc_decoder_get_timestamp.mockImplementation((): bigint => this.requireCurrentFrame().timestamp);
        this._hevc_decoder_get_width.mockImplementation((): number => this.requireCurrentFrame().width);
    }

    private requireCurrentFrame(): FakeFrame {
        if (!this.currentFrame) {
            throw new Error('The fake HEVC decoder holds no frame');
        }
        return this.currentFrame;
    }
}
/* eslint-enable @typescript-eslint/naming-convention */

/** Returns the address of the native decoder the fake module creates at an index. */
function getDecoderPointer(decoderIndex: number): number {
    return FIRST_DECODER_POINTER + (decoderIndex * DECODER_POINTER_STRIDE);
}

/** Creates a frame whose padded planes lie at the fake memory's plane addresses, with strides in bytes. */
function createFakeFrame(bitDepth: number, overrides: Partial<FakeFrame> = {}): FakeFrame {
    const bytesPerSample = bitDepth === EIGHT_BIT_DEPTH ? Uint8Array.BYTES_PER_ELEMENT : Uint16Array.BYTES_PER_ELEMENT;
    const planes: FakeFramePlane[] = [];
    planes.push({ pointer: LUMA_PLANE_POINTER, strideByteLength: LUMA_STRIDE_SAMPLE_COUNT * bytesPerSample });
    planes.push({ pointer: CHROMA_BLUE_PLANE_POINTER, strideByteLength: CHROMA_STRIDE_SAMPLE_COUNT * bytesPerSample });
    planes.push({ pointer: CHROMA_RED_PLANE_POINTER, strideByteLength: CHROMA_STRIDE_SAMPLE_COUNT * bytesPerSample });
    return {
        bitDepth,
        duration: BigInt(FRAME_DURATION_MICROSECONDS),
        height: FRAME_HEIGHT,
        planes,
        timestamp: BigInt(FRAME_TIMESTAMP_MICROSECONDS),
        width: FRAME_WIDTH,
        ...overrides
    };
}

/** Returns a frame with one plane moved or restrided. */
function replacePlane(frame: FakeFrame, planeIndex: number, plane: Partial<FakeFramePlane>): FakeFrame {
    const planes = frame.planes.map((framePlane: FakeFramePlane, index: number): FakeFramePlane => (
        index === planeIndex ? { ...framePlane, ...plane } : framePlane
    ));
    return { ...frame, planes };
}

/** Returns the timestamps of successive frames one frame duration apart, in display order. */
function getSuccessiveFrameTimestamps(frameCount: number): number[] {
    const timestamps: number[] = [];
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        timestamps.push(FRAME_TIMESTAMP_MICROSECONDS + (frameIndex * FRAME_DURATION_MICROSECONDS));
    }
    return timestamps;
}

function createSuccessiveFakeFrames(frameCount: number): FakeFrame[] {
    return getSuccessiveFrameTimestamps(frameCount).map((timestamp: number): FakeFrame => (
        createFakeFrame(TEN_BIT_DEPTH, { timestamp: BigInt(timestamp) })
    ));
}

/** Returns a plane's samples from its first to the end of its last row, padding included, each one more than the last. */
function createPlaneSamples(firstSample: number, sampleCount: number): number[] {
    const samples: number[] = [];
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        samples.push(firstSample + sampleIndex);
    }
    return samples;
}

/** Writes a frame's planes where the fake frame puts them, as bytes or little-endian 16-bit words, and returns their samples in the bridge's plane order. */
function writeFramePlanes(heap: Uint8Array, bitDepth: HEVCFrameBitDepth): number[][] {
    const sampleOffset = bitDepth === EIGHT_BIT_DEPTH ? 0 : TEN_BIT_SAMPLE_OFFSET;
    const planeSamples: number[][] = [];
    planeSamples.push(createPlaneSamples(LUMA_FIRST_SAMPLE + sampleOffset, LUMA_PLANE_SAMPLE_COUNT));
    planeSamples.push(createPlaneSamples(CHROMA_BLUE_FIRST_SAMPLE + sampleOffset, CHROMA_PLANE_SAMPLE_COUNT));
    planeSamples.push(createPlaneSamples(CHROMA_RED_FIRST_SAMPLE + sampleOffset, CHROMA_PLANE_SAMPLE_COUNT));
    const memory = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
    for (let planeIndex = 0; planeIndex < planeSamples.length; planeIndex += 1) {
        const samples = planeSamples[planeIndex];
        for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
            if (bitDepth === EIGHT_BIT_DEPTH) {
                memory.setUint8(PLANE_POINTERS[planeIndex] + sampleIndex, samples[sampleIndex]);
            } else {
                memory.setUint16(
                    PLANE_POINTERS[planeIndex] + (sampleIndex * Uint16Array.BYTES_PER_ELEMENT),
                    samples[sampleIndex],
                    true
                );
            }
        }
    }
    return planeSamples;
}

function snapshotPlane(plane: HEVCFramePlane, heap: Uint8Array): PlaneSnapshot {
    return {
        byteOffset: plane.samples.byteOffset,
        sampleArrayName: plane.samples.constructor.name,
        samples: Array.from(plane.samples),
        stride: plane.stride,
        viewsWASMMemory: plane.samples.buffer === heap.buffer
    };
}

/** Reads a frame while its handler runs, as a consumer must before the decoder's next call reuses its planes. */
function snapshotFrame(frame: HEVCDecodedFrame, heap: Uint8Array): FrameSnapshot {
    return {
        bitDepth: frame.bitDepth,
        chromaHeight: frame.chromaHeight,
        chromaWidth: frame.chromaWidth,
        durationMicroseconds: frame.durationMicroseconds,
        height: frame.height,
        planes: {
            chromaBlue: snapshotPlane(frame.planes.chromaBlue, heap),
            chromaRed: snapshotPlane(frame.planes.chromaRed, heap),
            luma: snapshotPlane(frame.planes.luma, heap)
        },
        timestampMicroseconds: frame.timestampMicroseconds,
        width: frame.width
    };
}

function ignoreFrame(): void {
    // Discards the frame
}

function throwConsumerError(): never {
    throw new Error(CONSUMER_ERROR_MESSAGE);
}

function throwWASMTrap(): never {
    throw new WebAssembly.RuntimeError(WASM_TRAP_MESSAGE);
}

function decodePacket(backend: HEVCDecoderBackend, frameHandler: HEVCDecodedFrameHandler = ignoreFrame): number {
    return backend.decode(PACKET_DATA, PACKET_TIMESTAMP_MICROSECONDS, PACKET_DURATION_MICROSECONDS, frameHandler);
}

function flushBackend(backend: HEVCDecoderBackend): number {
    return backend.flush(ignoreFrame);
}

/** Defines the glue's module factory, which resolves the modules in turn and then the last one again. */
function stubModuleFactory(...modules: FakeHEVCDecoderWASMModule[]): GlueModuleFactory {
    let instantiationCount = 0;
    const factory: GlueModuleFactory = vi.fn<(options: GlueModuleOptions) => Promise<HEVCDecoderWASMModule>>(
        async (): Promise<HEVCDecoderWASMModule> => {
            const module = modules[Math.min(instantiationCount, modules.length - 1)];
            instantiationCount += 1;
            return module;
        }
    );
    vi.stubGlobal('HEVCDecoderModule', factory);
    return factory;
}

/** Opens a backend on a module of its own, through the shared instance a playback decoder uses. */
async function openBackend(
    module: FakeHEVCDecoderWASMModule,
    description: Uint8Array | null = null
): Promise<HEVCDecoderBackend> {
    stubModuleFactory(module);
    return createHEVCDecoderBackend({ description, wasmURL: WASM_URL });
}

const PLANE_REJECTION_CASES: readonly PlaneRejectionCase[] = [
    {
        bitDepth: EIGHT_BIT_DEPTH,
        label: 'a null luma plane',
        plane: { pointer: NULL_POINTER },
        planeIndex: LUMA_PLANE_INDEX
    },
    {
        bitDepth: EIGHT_BIT_DEPTH,
        label: 'a luma plane that ends one byte past memory',
        plane: { pointer: LAST_FITTING_LUMA_PLANE_POINTER + 1 },
        planeIndex: LUMA_PLANE_INDEX
    },
    {
        bitDepth: EIGHT_BIT_DEPTH,
        label: 'an 8-bit plane past 2 GiB, whose address arrives negative',
        plane: { pointer: HIGH_HEAP_POINTER_AS_I32 },
        planeIndex: CHROMA_BLUE_PLANE_INDEX
    },
    {
        bitDepth: TEN_BIT_DEPTH,
        label: 'a 10-bit plane past 2 GiB, whose address arrives negative',
        plane: { pointer: HIGH_HEAP_POINTER_AS_I32 },
        planeIndex: CHROMA_RED_PLANE_INDEX
    },
    {
        bitDepth: TEN_BIT_DEPTH,
        label: 'a 10-bit plane at an odd address',
        plane: { pointer: ODD_LUMA_PLANE_POINTER },
        planeIndex: LUMA_PLANE_INDEX
    },
    {
        bitDepth: TEN_BIT_DEPTH,
        label: 'a 10-bit plane with an odd stride',
        plane: { strideByteLength: ODD_TEN_BIT_LUMA_STRIDE_BYTE_LENGTH },
        planeIndex: LUMA_PLANE_INDEX
    },
    {
        bitDepth: EIGHT_BIT_DEPTH,
        label: 'a stride below its row',
        plane: { strideByteLength: EIGHT_BIT_STRIDE_BELOW_ROW_BYTE_LENGTH },
        planeIndex: LUMA_PLANE_INDEX
    },
    {
        bitDepth: TEN_BIT_DEPTH,
        label: 'a 10-bit stride in samples, short of its row\'s bytes',
        plane: { strideByteLength: TEN_BIT_STRIDE_IN_SAMPLES_BYTE_LENGTH },
        planeIndex: LUMA_PLANE_INDEX
    }
];

const FRAME_REJECTION_CASES: readonly FrameRejectionCase[] = [
    {
        error: UNSUPPORTED_FORMAT_ERROR,
        frame: { bitDepth: UNSUPPORTED_FORMAT_BIT_DEPTH },
        label: 'a format other than 8-bit or 10-bit 4:2:0'
    },
    { error: INVALID_DIMENSIONS_ERROR, frame: { width: ZERO_FRAME_DIMENSION }, label: 'a zero width' },
    { error: INVALID_DIMENSIONS_ERROR, frame: { height: ZERO_FRAME_DIMENSION }, label: 'a zero height' },
    { error: MISSING_TIMESTAMP_ERROR, frame: { timestamp: AV_NOPTS_VALUE }, label: 'no timestamp' },
    { error: MISSING_DURATION_ERROR, frame: { duration: AV_NOPTS_VALUE }, label: 'no duration' },
    { error: NEGATIVE_DURATION_ERROR, frame: { duration: NEGATIVE_FRAME_DURATION }, label: 'a negative duration' },
    {
        error: UNSAFE_TIMESTAMP_ERROR,
        frame: { timestamp: UNSAFE_FRAME_TIMESTAMP },
        label: 'a timestamp past the safe integer range'
    }
];

const NATIVE_FAILURE_CASES: readonly NativeFailureCase[] = [
    {
        call: decodePacket,
        error: `rejected a packet, code ${INVALID_DATA_ERROR_CODE}`,
        fail: (module: FakeHEVCDecoderWASMModule): void => {
            module._hevc_decoder_send_packet.mockReturnValue(INVALID_DATA_ERROR_CODE);
        },
        label: 'a packet FFmpeg rejects'
    },
    {
        call: decodePacket,
        error: `failed, code ${INVALID_DATA_ERROR_CODE}`,
        fail: (module: FakeHEVCDecoderWASMModule): void => {
            module._hevc_decoder_receive_frame.mockReturnValue(INVALID_DATA_ERROR_CODE);
        },
        label: 'a frame FFmpeg fails to decode'
    },
    {
        call: flushBackend,
        error: `could not drain, code ${INVALID_ARGUMENT_ERROR_CODE}`,
        fail: (module: FakeHEVCDecoderWASMModule): void => {
            module.drainStartResult = INVALID_ARGUMENT_ERROR_CODE;
        },
        label: 'a drain FFmpeg cannot start'
    },
    {
        call: flushBackend,
        error: DRAIN_INCOMPLETE_ERROR,
        fail: (module: FakeHEVCDecoderWASMModule): void => {
            module._hevc_decoder_receive_frame.mockReturnValue(AGAIN_ERROR);
        },
        label: 'a drain that asks for another packet'
    }
];

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('opening an HEVC decoder', () => {
    it('writes the description where the bridge reserved it before opening the decoder', async () => {
        const module = new FakeHEVCDecoderWASMModule();

        const backend = await openBackend(module, DESCRIPTION_DATA);

        expect(module._hevc_decoder_create).toHaveBeenCalledWith(DESCRIPTION_DATA.byteLength);
        expect(module._hevc_decoder_get_extradata).toHaveBeenCalledWith(FIRST_DECODER_POINTER);
        expect(module.openedDescriptions).toEqual([ DESCRIPTION_DATA ]);
        backend.destroy();
    });

    it.each([
        { description: null, label: 'no description' },
        { description: EMPTY_DESCRIPTION, label: 'an empty description' }
    ])('opens an Annex B decoder for $label without reserving one', async ({ description }) => {
        const module = new FakeHEVCDecoderWASMModule();

        const backend = await openBackend(module, description);

        expect(module._hevc_decoder_create).toHaveBeenCalledWith(NO_EXTRADATA_BYTE_LENGTH);
        expect(module._hevc_decoder_get_extradata).not.toHaveBeenCalled();
        expect(module._hevc_decoder_open).toHaveBeenCalledWith(FIRST_DECODER_POINTER);
        backend.destroy();
    });

    it('refuses a description above the bridge\'s bound before creating a decoder', async () => {
        const module = new FakeHEVCDecoderWASMModule();

        await expect(openBackend(module, new Uint8Array(OVERSIZED_DESCRIPTION_BYTE_LENGTH)))
            .rejects.toThrow(DESCRIPTION_TOO_LARGE_ERROR);
        expect(module._hevc_decoder_create).not.toHaveBeenCalled();
    });

    it('reports a decoder the bridge could not create', async () => {
        const module = new FakeHEVCDecoderWASMModule();
        module._hevc_decoder_create.mockReturnValue(NULL_POINTER);

        await expect(openBackend(module)).rejects.toThrow(CREATE_FAILURE_ERROR);
        expect(module._hevc_decoder_close).not.toHaveBeenCalled();
    });

    it('closes a decoder FFmpeg could not open', async () => {
        const module = new FakeHEVCDecoderWASMModule();
        module._hevc_decoder_open.mockReturnValue(INVALID_DATA_ERROR_CODE);

        await expect(openBackend(module, DESCRIPTION_DATA))
            .rejects.toThrow(`could not open, code ${INVALID_DATA_ERROR_CODE}`);
        expect(module._hevc_decoder_close).toHaveBeenCalledWith(FIRST_DECODER_POINTER);
    });

    it.each<AllocationCase>([
        { label: 'a null address', pointer: NULL_POINTER },
        { label: 'an address whose description ends one byte past memory', pointer: EXTRADATA_POINTER_PAST_MEMORY_END },
        { label: 'an address past 2 GiB, which arrives negative', pointer: HIGH_HEAP_POINTER_AS_I32 }
    ])('closes a decoder whose description the bridge reserved at $label', async ({ pointer }) => {
        const module = new FakeHEVCDecoderWASMModule();
        module._hevc_decoder_get_extradata.mockReturnValue(pointer);

        await expect(openBackend(module, DESCRIPTION_DATA)).rejects.toThrow(DESCRIPTION_ALLOCATION_ERROR);
        expect(module._hevc_decoder_open).not.toHaveBeenCalled();
        expect(module._hevc_decoder_close).toHaveBeenCalledWith(FIRST_DECODER_POINTER);
    });

    it('reads a decoder past 2 GiB, whose address arrives negative, as unsigned in every call', async () => {
        const module = new FakeHEVCDecoderWASMModule();
        module._hevc_decoder_create.mockReturnValue(HIGH_DECODER_POINTER_AS_I32);
        module.drainFrames.push(createFakeFrame(TEN_BIT_DEPTH));
        const backend = await openBackend(module);

        decodePacket(backend);
        flushBackend(backend);
        backend.destroy();

        expect(module._hevc_decoder_open).toHaveBeenCalledWith(HIGH_DECODER_POINTER);
        expect(module._hevc_decoder_send_packet).toHaveBeenCalledWith(
            HIGH_DECODER_POINTER,
            BigInt(PACKET_TIMESTAMP_MICROSECONDS),
            BigInt(PACKET_DURATION_MICROSECONDS)
        );
        expect(module._hevc_decoder_get_plane).toHaveBeenCalledWith(HIGH_DECODER_POINTER, LUMA_PLANE_INDEX);
        expect(module._hevc_decoder_reset).toHaveBeenCalledWith(HIGH_DECODER_POINTER);
        expect(module._hevc_decoder_close).toHaveBeenCalledWith(HIGH_DECODER_POINTER);
    });
});

describe('decoding HEVC packets', () => {
    it('writes each packet where the bridge allocated it and sends it with its timing', async () => {
        const module = new FakeHEVCDecoderWASMModule();
        const backend = await openBackend(module);
        const frameHandler = vi.fn<HEVCDecodedFrameHandler>();

        const frameCount = decodePacket(backend, frameHandler);

        expect(module._hevc_decoder_configure_packet).toHaveBeenCalledWith(FIRST_DECODER_POINTER, PACKET_DATA.byteLength);
        expect(module.sentPackets).toEqual([ PACKET_DATA ]);
        expect(module._hevc_decoder_send_packet).toHaveBeenCalledWith(
            FIRST_DECODER_POINTER,
            BigInt(PACKET_TIMESTAMP_MICROSECONDS),
            BigInt(PACKET_DURATION_MICROSECONDS)
        );
        // A packet that makes no frame displayable hands none over
        expect(frameCount).toBe(0);
        expect(frameHandler).not.toHaveBeenCalled();
        backend.destroy();
    });

    it('rejects an empty packet before allocating it', async () => {
        const module = new FakeHEVCDecoderWASMModule();
        const backend = await openBackend(module);

        expect(() => backend.decode(
            EMPTY_PACKET_DATA,
            PACKET_TIMESTAMP_MICROSECONDS,
            PACKET_DURATION_MICROSECONDS,
            ignoreFrame
        )).toThrow(EMPTY_PACKET_ERROR);
        expect(module._hevc_decoder_configure_packet).not.toHaveBeenCalled();
        backend.destroy();
    });

    it.each<AllocationCase>([
        { label: 'a null address', pointer: NULL_POINTER },
        { label: 'an address whose packet ends one byte past memory', pointer: PACKET_POINTER_PAST_MEMORY_END },
        { label: 'an address past 2 GiB, which arrives negative', pointer: HIGH_HEAP_POINTER_AS_I32 }
    ])('refuses a packet the bridge allocated at $label', async ({ pointer }) => {
        const module = new FakeHEVCDecoderWASMModule();
        module._hevc_decoder_configure_packet.mockReturnValue(pointer);
        const backend = await openBackend(module);

        expect(() => decodePacket(backend)).toThrow(PACKET_ALLOCATION_ERROR);
        expect(module._hevc_decoder_send_packet).not.toHaveBeenCalled();
        backend.destroy();
    });

    it.each([ EIGHT_BIT_DEPTH, TEN_BIT_DEPTH ] as const)(
        'views the padded planes of a %i-bit frame where they lie in WASM memory, with strides in samples',
        async (bitDepth: HEVCFrameBitDepth) => {
            const module = new FakeHEVCDecoderWASMModule();
            const planeSamples = writeFramePlanes(module.HEAPU8, bitDepth);
            module.sendFrameBatches.push([ createFakeFrame(bitDepth) ]);
            const backend = await openBackend(module);
            const snapshots: FrameSnapshot[] = [];

            const frameCount = decodePacket(backend, (frame: HEVCDecodedFrame): void => {
                snapshots.push(snapshotFrame(frame, module.HEAPU8));
            });

            const sampleArrayName = bitDepth === EIGHT_BIT_DEPTH ? Uint8Array.name : Uint16Array.name;
            expect(frameCount).toBe(1);
            expect(snapshots).toEqual([ {
                bitDepth,
                chromaHeight: FRAME_CHROMA_HEIGHT,
                chromaWidth: FRAME_CHROMA_WIDTH,
                durationMicroseconds: FRAME_DURATION_MICROSECONDS,
                height: FRAME_HEIGHT,
                planes: {
                    chromaBlue: {
                        byteOffset: CHROMA_BLUE_PLANE_POINTER,
                        sampleArrayName,
                        samples: planeSamples[CHROMA_BLUE_PLANE_INDEX],
                        stride: CHROMA_STRIDE_SAMPLE_COUNT,
                        viewsWASMMemory: true
                    },
                    chromaRed: {
                        byteOffset: CHROMA_RED_PLANE_POINTER,
                        sampleArrayName,
                        samples: planeSamples[CHROMA_RED_PLANE_INDEX],
                        stride: CHROMA_STRIDE_SAMPLE_COUNT,
                        viewsWASMMemory: true
                    },
                    luma: {
                        byteOffset: LUMA_PLANE_POINTER,
                        sampleArrayName,
                        samples: planeSamples[LUMA_PLANE_INDEX],
                        stride: LUMA_STRIDE_SAMPLE_COUNT,
                        viewsWASMMemory: true
                    }
                },
                timestampMicroseconds: FRAME_TIMESTAMP_MICROSECONDS,
                width: FRAME_WIDTH
            } ]);
            backend.destroy();
        }
    );

    it('views a plane that ends exactly at the end of WASM memory', async () => {
        const module = new FakeHEVCDecoderWASMModule();
        module.sendFrameBatches.push([ replacePlane(
            createFakeFrame(EIGHT_BIT_DEPTH),
            LUMA_PLANE_INDEX,
            { pointer: LAST_FITTING_LUMA_PLANE_POINTER }
        ) ]);
        const backend = await openBackend(module);
        const lumaPlaneEnds: number[] = [];

        const frameCount = decodePacket(backend, (frame: HEVCDecodedFrame): void => {
            lumaPlaneEnds.push(frame.planes.luma.samples.byteOffset + frame.planes.luma.samples.byteLength);
        });

        expect(frameCount).toBe(1);
        expect(lumaPlaneEnds).toEqual([ FAKE_HEAP_BYTE_LENGTH ]);
        backend.destroy();
    });

    it.each(PLANE_REJECTION_CASES)('rejects $label', async (rejectionCase: PlaneRejectionCase) => {
        const module = new FakeHEVCDecoderWASMModule();
        module.sendFrameBatches.push([ replacePlane(
            createFakeFrame(rejectionCase.bitDepth),
            rejectionCase.planeIndex,
            rejectionCase.plane
        ) ]);
        const backend = await openBackend(module);
        const frameHandler = vi.fn<HEVCDecodedFrameHandler>();

        expect(() => decodePacket(backend, frameHandler)).toThrow(PLANE_OUTSIDE_MEMORY_ERROR);
        expect(frameHandler).not.toHaveBeenCalled();
        backend.destroy();
    });

    it.each(FRAME_REJECTION_CASES)('rejects a frame with $label', async (rejectionCase: FrameRejectionCase) => {
        const module = new FakeHEVCDecoderWASMModule();
        module.sendFrameBatches.push([ createFakeFrame(TEN_BIT_DEPTH, rejectionCase.frame) ]);
        const backend = await openBackend(module);
        const frameHandler = vi.fn<HEVCDecodedFrameHandler>();

        expect(() => decodePacket(backend, frameHandler)).toThrow(rejectionCase.error);
        expect(frameHandler).not.toHaveBeenCalled();
        backend.destroy();
    });

    it('hands over each frame a packet made displayable, in display order, before receiving the next', async () => {
        const module = new FakeHEVCDecoderWASMModule();
        module.sendFrameBatches.push(createSuccessiveFakeFrames(DISPLAYABLE_FRAME_COUNT));
        const backend = await openBackend(module);
        const observations: FrameObservation[] = [];

        const frameCount = decodePacket(backend, (frame: HEVCDecodedFrame): void => {
            observations.push({
                receiveCallCount: module._hevc_decoder_receive_frame.mock.calls.length,
                timestampMicroseconds: frame.timestampMicroseconds
            });
        });

        expect(frameCount).toBe(DISPLAYABLE_FRAME_COUNT);
        expect(observations).toEqual(getSuccessiveFrameTimestamps(DISPLAYABLE_FRAME_COUNT).map(
            (timestampMicroseconds: number, frameIndex: number): FrameObservation => ({
                receiveCallCount: frameIndex + 1,
                timestampMicroseconds
            })
        ));
        // The last receive found that the decoder needs another packet
        expect(module._hevc_decoder_receive_frame).toHaveLastReturnedWith(AGAIN_ERROR);
        backend.destroy();
    });

    it('stops receiving frames once the frame handler throws', async () => {
        const module = new FakeHEVCDecoderWASMModule();
        module.sendFrameBatches.push(createSuccessiveFakeFrames(DISPLAYABLE_FRAME_COUNT));
        const backend = await openBackend(module);

        expect(() => decodePacket(backend, throwConsumerError)).toThrow(CONSUMER_ERROR_MESSAGE);
        expect(module._hevc_decoder_receive_frame).toHaveBeenCalledOnce();
        backend.destroy();
    });

    it('hands over no more than its frame bound from one call', async () => {
        const module = new FakeHEVCDecoderWASMModule();
        module.sendFrameBatches.push(createSuccessiveFakeFrames(MAXIMUM_HEVC_DRAINED_FRAME_COUNT));
        module.sendFrameBatches.push(createSuccessiveFakeFrames(MAXIMUM_HEVC_DRAINED_FRAME_COUNT + 1));
        const backend = await openBackend(module);
        const boundedFrameHandler = vi.fn<HEVCDecodedFrameHandler>();
        const runawayFrameHandler = vi.fn<HEVCDecodedFrameHandler>();

        expect(decodePacket(backend, boundedFrameHandler)).toBe(MAXIMUM_HEVC_DRAINED_FRAME_COUNT);
        expect(() => decodePacket(backend, runawayFrameHandler)).toThrow(FRAME_BOUND_ERROR);
        expect(boundedFrameHandler).toHaveBeenCalledTimes(MAXIMUM_HEVC_DRAINED_FRAME_COUNT);
        expect(runawayFrameHandler).toHaveBeenCalledTimes(MAXIMUM_HEVC_DRAINED_FRAME_COUNT);
        backend.destroy();
    });

    it.each(NATIVE_FAILURE_CASES)('reports $label', async (failureCase: NativeFailureCase) => {
        const module = new FakeHEVCDecoderWASMModule();
        failureCase.fail(module);
        const backend = await openBackend(module);

        expect(() => failureCase.call(backend)).toThrow(failureCase.error);
        backend.destroy();
    });

    it('closes its decoder once and refuses calls after destroy', async () => {
        const module = new FakeHEVCDecoderWASMModule();
        const backend = await openBackend(module);

        backend.destroy();
        backend.destroy();

        expect(module._hevc_decoder_close).toHaveBeenCalledOnce();
        expect(module._hevc_decoder_close).toHaveBeenCalledWith(FIRST_DECODER_POINTER);
        expect(() => decodePacket(backend)).toThrow(DESTROYED_ERROR);
        expect(() => flushBackend(backend)).toThrow(DESTROYED_ERROR);
    });
});

describe('flushing an HEVC decoder', () => {
    it('hands over every frame the decoder holds, in display order, then resets it for the next random-access point', async () => {
        const module = new FakeHEVCDecoderWASMModule();
        module.drainFrames.push(...createSuccessiveFakeFrames(HELD_FRAME_COUNT));
        const backend = await openBackend(module);
        const timestamps: number[] = [];

        const frameCount = backend.flush((frame: HEVCDecodedFrame): void => {
            timestamps.push(frame.timestampMicroseconds);
        });

        expect(frameCount).toBe(HELD_FRAME_COUNT);
        expect(timestamps).toEqual(getSuccessiveFrameTimestamps(HELD_FRAME_COUNT));
        // FFmpeg reported the end of its frames before the reset discarded its state
        expect(module._hevc_decoder_receive_frame).toHaveLastReturnedWith(EOF_ERROR);
        expect(module._hevc_decoder_reset).toHaveBeenCalledOnce();
        expect(module._hevc_decoder_reset.mock.invocationCallOrder[0])
            .toBeGreaterThan(Math.max(...module._hevc_decoder_receive_frame.mock.invocationCallOrder));
        // The reset ended the drain, so the decoder takes packets again
        expect(decodePacket(backend)).toBe(0);
        expect(module.sentPackets).toEqual([ PACKET_DATA ]);
        backend.destroy();
    });

    it('accepts a drain FFmpeg reports as already ended', async () => {
        const module = new FakeHEVCDecoderWASMModule();
        module.drainStartResult = EOF_ERROR;
        const backend = await openBackend(module);

        expect(flushBackend(backend)).toBe(0);
        expect(module._hevc_decoder_reset).toHaveBeenCalledOnce();
        backend.destroy();
    });
});

describe('createHEVCDecoderBackend', () => {
    it('opens every decoder of the worker on one module instance, which locates its binary by URL', async () => {
        const module = new FakeHEVCDecoderWASMModule();
        const factory = stubModuleFactory(module);

        const firstBackend = await createHEVCDecoderBackend({ description: DESCRIPTION_DATA, wasmURL: WASM_URL });
        firstBackend.destroy();
        const concurrentBackends = await Promise.all([
            createHEVCDecoderBackend({ description: null, wasmURL: WASM_URL }),
            createHEVCDecoderBackend({ description: null, wasmURL: WASM_URL })
        ]);
        for (const backend of concurrentBackends) {
            backend.destroy();
        }

        expect(factory).toHaveBeenCalledOnce();
        const [ moduleOptions ] = factory.mock.calls[0];
        expect(moduleOptions.locateFile?.(GLUE_WASM_FILE_NAME)).toBe(WASM_URL);
        expect(moduleOptions.wasmBinary).toBeUndefined();
        // Each decoder creates and closes its own native context
        expect(module._hevc_decoder_create.mock.calls).toEqual([
            [ DESCRIPTION_DATA.byteLength ],
            [ NO_EXTRADATA_BYTE_LENGTH ],
            [ NO_EXTRADATA_BYTE_LENGTH ]
        ]);
        expect(module._hevc_decoder_close.mock.calls).toEqual([
            [ getDecoderPointer(0) ],
            [ getDecoderPointer(1) ],
            [ getDecoderPointer(2) ]
        ]);
    });

    it('instantiates the module again for the next decoder after native code traps while decoding', async () => {
        const trappingModule = new FakeHEVCDecoderWASMModule();
        const nextModule = new FakeHEVCDecoderWASMModule();
        trappingModule._hevc_decoder_send_packet.mockImplementation(throwWASMTrap);
        const factory = stubModuleFactory(trappingModule, nextModule);
        const trappingBackend = await createHEVCDecoderBackend({ description: null, wasmURL: WASM_URL });

        expect(() => decodePacket(trappingBackend)).toThrow(WebAssembly.RuntimeError);
        const nextBackend = await createHEVCDecoderBackend({ description: null, wasmURL: WASM_URL });

        expect(factory).toHaveBeenCalledTimes(2);
        expect(nextModule._hevc_decoder_create).toHaveBeenCalledOnce();
        // The trapped decoder still closes its context in the module it holds
        trappingBackend.destroy();
        expect(trappingModule._hevc_decoder_close).toHaveBeenCalledOnce();
        nextBackend.destroy();
    });

    it('instantiates the module again after native code traps while opening a decoder', async () => {
        const trappingModule = new FakeHEVCDecoderWASMModule();
        const nextModule = new FakeHEVCDecoderWASMModule();
        trappingModule._hevc_decoder_open.mockImplementation(throwWASMTrap);
        const factory = stubModuleFactory(trappingModule, nextModule);

        await expect(createHEVCDecoderBackend({ description: null, wasmURL: WASM_URL }))
            .rejects.toThrow(WebAssembly.RuntimeError);
        const nextBackend = await createHEVCDecoderBackend({ description: null, wasmURL: WASM_URL });

        expect(factory).toHaveBeenCalledTimes(2);
        expect(trappingModule._hevc_decoder_close).toHaveBeenCalledWith(FIRST_DECODER_POINTER);
        expect(nextModule._hevc_decoder_open).toHaveBeenCalledOnce();
        nextBackend.destroy();
    });

    it('keeps the module after errors that are not traps', async () => {
        const module = new FakeHEVCDecoderWASMModule();
        module._hevc_decoder_send_packet.mockReturnValueOnce(INVALID_DATA_ERROR_CODE);
        module.sendFrameBatches.push([ createFakeFrame(TEN_BIT_DEPTH) ]);
        const factory = stubModuleFactory(module);
        const backend = await createHEVCDecoderBackend({ description: null, wasmURL: WASM_URL });

        expect(() => decodePacket(backend)).toThrow(`rejected a packet, code ${INVALID_DATA_ERROR_CODE}`);
        expect(() => decodePacket(backend, throwConsumerError)).toThrow(CONSUMER_ERROR_MESSAGE);
        const nextBackend = await createHEVCDecoderBackend({ description: null, wasmURL: WASM_URL });

        expect(factory).toHaveBeenCalledOnce();
        expect(module._hevc_decoder_create).toHaveBeenCalledTimes(2);
        backend.destroy();
        nextBackend.destroy();
    });

    it('instantiates again after an instantiation fails', async () => {
        const instantiationError = new Error(INSTANTIATION_ERROR_MESSAGE);
        const factory = stubModuleFactory(new FakeHEVCDecoderWASMModule());
        factory.mockRejectedValueOnce(instantiationError);

        await expect(createHEVCDecoderBackend({ description: null, wasmURL: WASM_URL })).rejects.toBe(instantiationError);
        const backend = await createHEVCDecoderBackend({ description: null, wasmURL: WASM_URL });

        expect(factory).toHaveBeenCalledTimes(2);
        backend.destroy();
    });

    it('requires the glue module factory', async () => {
        vi.stubGlobal('HEVCDecoderModule', undefined);

        await expect(createHEVCDecoderBackend({ description: null, wasmURL: WASM_URL }))
            .rejects.toThrow(FACTORY_UNAVAILABLE_ERROR);
    });
});

describe('createHEVCDecoderModule', () => {
    it('instantiates a module of its own, apart from the one the worker\'s decoders share', async () => {
        const sharedModule = new FakeHEVCDecoderWASMModule();
        const ownModule = new FakeHEVCDecoderWASMModule();
        ownModule._hevc_decoder_send_packet.mockImplementation(throwWASMTrap);
        const factory = stubModuleFactory(sharedModule, ownModule);
        const sharedBackend = await createHEVCDecoderBackend({ description: null, wasmURL: WASM_URL });
        const decoderModule = await createHEVCDecoderModule({ wasmURL: WASM_URL });
        const ownBackend = decoderModule.createDecoder(null);

        // A trap in its own module leaves the shared one in service
        expect(() => decodePacket(ownBackend)).toThrow(WebAssembly.RuntimeError);
        const laterSharedBackend = await createHEVCDecoderBackend({ description: null, wasmURL: WASM_URL });

        expect(factory).toHaveBeenCalledTimes(2);
        expect(sharedModule._hevc_decoder_create).toHaveBeenCalledTimes(2);
        expect(ownModule._hevc_decoder_create).toHaveBeenCalledOnce();
        sharedBackend.destroy();
        ownBackend.destroy();
        laterSharedBackend.destroy();
    });

    it('hosts successive decoders on one instantiated module', async () => {
        const module = new FakeHEVCDecoderWASMModule();
        const factory = stubModuleFactory(module);
        const decoderModule = await createHEVCDecoderModule({ wasmURL: WASM_URL });

        const firstBackend = decoderModule.createDecoder(null);
        firstBackend.destroy();
        const secondBackend = decoderModule.createDecoder(DESCRIPTION_DATA);
        decodePacket(secondBackend);
        secondBackend.destroy();

        expect(factory).toHaveBeenCalledOnce();
        expect(factory.mock.calls[0][0].locateFile?.(GLUE_WASM_FILE_NAME)).toBe(WASM_URL);
        expect(module.openedDescriptions).toEqual([ EMPTY_DESCRIPTION, DESCRIPTION_DATA ]);
        expect(module.sentPackets).toEqual([ PACKET_DATA ]);
        expect(module._hevc_decoder_close.mock.calls).toEqual([ [ getDecoderPointer(0) ], [ getDecoderPointer(1) ] ]);
        expect(() => decodePacket(firstBackend)).toThrow(DESTROYED_ERROR);
    });

    it('hands preloaded WASM bytes to the glue', async () => {
        const factory = stubModuleFactory(new FakeHEVCDecoderWASMModule());
        const wasmBinary = new ArrayBuffer(PRELOADED_WASM_BYTE_LENGTH);

        await createHEVCDecoderModule({ wasmBinary });

        const [ moduleOptions ] = factory.mock.calls[0];
        expect(moduleOptions.wasmBinary).toBe(wasmBinary);
        // Without a URL the glue locates its binary itself
        expect(moduleOptions.locateFile).toBeUndefined();
    });

    it('gives the glue a fresh settings object on every instantiation', async () => {
        const factory = stubModuleFactory(new FakeHEVCDecoderWASMModule(), new FakeHEVCDecoderWASMModule());
        const options = { wasmURL: WASM_URL };

        await createHEVCDecoderModule(options);
        await createHEVCDecoderModule(options);

        // NOTE: The glue adopts the object as its Module, and its assertion build installs aborting getters on it, so reusing one aborts the next instantiation
        expect(factory.mock.calls[0][0]).not.toBe(factory.mock.calls[1][0]);
    });

    it('requires the glue module factory', async () => {
        vi.stubGlobal('HEVCDecoderModule', undefined);

        await expect(createHEVCDecoderModule({ wasmURL: WASM_URL })).rejects.toThrow(FACTORY_UNAVAILABLE_ERROR);
    });
});
