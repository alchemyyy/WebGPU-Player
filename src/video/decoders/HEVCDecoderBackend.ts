import type { Microseconds } from '../../MediaTime';
import { requireMicroseconds } from '../../TimeMath';
import WorkerWASMInstanceCache, { isWASMTrap } from './WorkerWASMInstanceCache';

// The bridge's bound on a decoder description
const MAXIMUM_DECODER_DESCRIPTION_BYTE_LENGTH = 1024 * 1024;
const AV_NOPTS_VALUE = BigInt('-9223372036854775808');
const LUMA_PLANE_INDEX = 0;
const CHROMA_BLUE_PLANE_INDEX = 1;
const CHROMA_RED_PLANE_INDEX = 2;
/** The most frames one call hands over; a flush outputs at most a full picture buffer, 16 pictures, so this only stops a runaway output loop. */
export const MAXIMUM_HEVC_DRAINED_FRAME_COUNT = 64;

/* eslint-disable @typescript-eslint/naming-convention -- Mirrors the external WASM ABI */
/** The exports of ffmpeg-hevc.wasm, FFmpeg's HEVC decoder behind the engine's bridge. */
export type HEVCDecoderWASMModule = {
    HEAPU8: Uint8Array
    _hevc_decoder_close: (decoder: number) => void
    _hevc_decoder_configure_packet: (decoder: number, packetByteLength: number) => number
    _hevc_decoder_create: (extradataByteLength: number) => number
    _hevc_decoder_error_again: () => number
    _hevc_decoder_error_eof: () => number
    _hevc_decoder_get_bit_depth: (decoder: number) => number
    _hevc_decoder_get_duration: (decoder: number) => bigint
    _hevc_decoder_get_extradata: (decoder: number) => number
    _hevc_decoder_get_height: (decoder: number) => number
    _hevc_decoder_get_plane: (decoder: number, plane: number) => number
    _hevc_decoder_get_stride: (decoder: number, plane: number) => number
    _hevc_decoder_get_timestamp: (decoder: number) => bigint
    _hevc_decoder_get_width: (decoder: number) => number
    _hevc_decoder_open: (decoder: number) => number
    _hevc_decoder_receive_frame: (decoder: number) => number
    _hevc_decoder_reset: (decoder: number) => void
    _hevc_decoder_send_packet: (decoder: number, presentationTimestamp: bigint, duration: bigint) => number
    _hevc_decoder_start_drain: (decoder: number) => number
};
/* eslint-enable @typescript-eslint/naming-convention */

type HEVCDecoderWASMModuleOptions = {
    locateFile?: (path: string) => string
    wasmBinary?: ArrayBuffer
};

type HEVCDecoderWASMModuleFactory = (options: HEVCDecoderWASMModuleOptions) => Promise<HEVCDecoderWASMModule>;

type HEVCDecoderGlobal = typeof globalThis & {
    HEVCDecoderModule?: unknown
};

/** The bit depths of Main and Main 10, the profiles the decoder serves. */
export type HEVCFrameBitDepth = 8 | 10;

/**
 * One plane of a decoded frame: its samples from the first to the end of the last row, whose rows start a stride apart.
 * The samples are bytes at 8 bits and 16-bit words at 10 bits, and the stride counts them.
 */
export type HEVCFramePlane = Readonly<{
    samples: Uint8Array | Uint16Array
    stride: number
}>;

/** The planes of a 4:2:0 frame. */
export type HEVCFramePlanes = Readonly<{
    chromaBlue: HEVCFramePlane
    chromaRed: HEVCFramePlane
    luma: HEVCFramePlane
}>;

/** A decoded 4:2:0 frame, cropped to its conformance window, whose planes view WASM memory only until the decoder's next call. */
export type HEVCDecodedFrame = Readonly<{
    bitDepth: HEVCFrameBitDepth
    chromaHeight: number
    chromaWidth: number
    /** The duration its packet was sent with */
    durationMicroseconds: Microseconds
    height: number
    planes: HEVCFramePlanes
    /** The timestamp its packet was sent with */
    timestampMicroseconds: Microseconds
    width: number
}>;

/** Consumes a frame synchronously before the decoder may reuse its WASM planes. */
export type HEVCDecodedFrameHandler = (frame: HEVCDecodedFrame) => void;

export type HEVCDecoderBackend = {
    /**
     * Decodes one access unit, which carries the timestamp and duration of the frame it codes, and hands over every frame it made displayable, in display order.
     * Returns how many it handed over.
     */
    decode: (
        data: Uint8Array,
        timestampMicroseconds: Microseconds,
        durationMicroseconds: Microseconds,
        frameHandler: HEVCDecodedFrameHandler
    ) => number
    destroy: () => void
    /** Hands over every frame the decoder holds, then readies it for the next random-access point; returns how many it handed over. */
    flush: (frameHandler: HEVCDecodedFrameHandler) => number
};

/** Locates ffmpeg-hevc.wasm by URL, or supplies its bytes so instantiation fetches nothing. */
export type HEVCDecoderModuleOptions = Readonly<{
    wasmBinary?: ArrayBuffer
    wasmURL?: string
}>;

/** What a playback decoder opens with: the binary's URL, and its stream's HEVCDecoderConfigurationRecord, or null for Annex B packets. */
export type HEVCDecoderBackendOptions = Readonly<{
    description: Uint8Array | null
    wasmURL: string
}>;

/** One instantiated ffmpeg-hevc.wasm module, which hosts successive decoders. */
export type HEVCDecoderModule = Readonly<{
    /** Opens a decoder for length-prefixed packets an HEVCDecoderConfigurationRecord describes, or for Annex B packets with null */
    createDecoder: (description: Uint8Array | null) => HEVCDecoderBackend
}>;

function isPositiveSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

/** Reads a returned pointer as a heap address; past 2 GiB the WASM i32 result arrives negative. */
function toHeapAddress(pointer: number): number {
    return pointer >>> 0;
}

/** Views one plane of the received frame in WASM memory, after checking that the plane lies inside it. */
function viewPlane(
    module: HEVCDecoderWASMModule,
    decoder: number,
    planeIndex: number,
    width: number,
    height: number,
    bytesPerSample: 1 | 2
): HEVCFramePlane {
    const pointer = toHeapAddress(module._hevc_decoder_get_plane(decoder, planeIndex));
    const strideByteLength = module._hevc_decoder_get_stride(decoder, planeIndex);
    const rowByteLength = width * bytesPerSample;
    const byteLength = ((height - 1) * strideByteLength) + rowByteLength;
    if (
        pointer === 0
        || pointer % bytesPerSample !== 0
        || !Number.isSafeInteger(strideByteLength)
        || strideByteLength < rowByteLength
        || strideByteLength % bytesPerSample !== 0
        || !Number.isSafeInteger(byteLength)
        || pointer + byteLength > module.HEAPU8.byteLength
    ) {
        throw new TypeError('The HEVC WASM decoder returned a plane outside its memory');
    }
    if (bytesPerSample === 1) {
        return {
            samples: module.HEAPU8.subarray(pointer, pointer + byteLength),
            stride: strideByteLength
        };
    }
    return {
        samples: new Uint16Array(module.HEAPU8.buffer, pointer, byteLength / Uint16Array.BYTES_PER_ELEMENT),
        stride: strideByteLength / Uint16Array.BYTES_PER_ELEMENT
    };
}

/** Reads a timing value the decoder carried from a packet to its frame. */
function readFrameTime(value: bigint, label: string): Microseconds {
    if (value === AV_NOPTS_VALUE) {
        throw new TypeError(`The HEVC WASM decoder output a frame without a ${label}`);
    }
    return requireMicroseconds(Number(value), `HEVC decoded frame ${label}`);
}

/** Describes the frame the decoder just returned, viewing its planes where they lie in WASM memory. */
function readDecodedFrame(module: HEVCDecoderWASMModule, decoder: number): HEVCDecodedFrame {
    const bitDepth = module._hevc_decoder_get_bit_depth(decoder);
    if (bitDepth !== 8 && bitDepth !== 10) {
        throw new TypeError('The HEVC WASM decoder output is not 8-bit or 10-bit 4:2:0');
    }
    const width = module._hevc_decoder_get_width(decoder);
    const height = module._hevc_decoder_get_height(decoder);
    if (!isPositiveSafeInteger(width) || !isPositiveSafeInteger(height)) {
        throw new TypeError('The HEVC WASM decoder returned invalid frame dimensions');
    }
    const chromaWidth = Math.ceil(width / 2);
    const chromaHeight = Math.ceil(height / 2);
    const bytesPerSample = bitDepth === 8 ? 1 : 2;
    const durationMicroseconds = readFrameTime(module._hevc_decoder_get_duration(decoder), 'duration');
    if (durationMicroseconds < 0) {
        throw new RangeError('The HEVC WASM decoder output a frame with a negative duration');
    }
    return {
        bitDepth,
        chromaHeight,
        chromaWidth,
        durationMicroseconds,
        height,
        planes: {
            chromaBlue: viewPlane(module, decoder, CHROMA_BLUE_PLANE_INDEX, chromaWidth, chromaHeight, bytesPerSample),
            chromaRed: viewPlane(module, decoder, CHROMA_RED_PLANE_INDEX, chromaWidth, chromaHeight, bytesPerSample),
            luma: viewPlane(module, decoder, LUMA_PLANE_INDEX, width, height, bytesPerSample)
        },
        timestampMicroseconds: readFrameTime(module._hevc_decoder_get_timestamp(decoder), 'timestamp'),
        width
    };
}

/** Creates and opens a native decoder, writing its description where the bridge reserved it. */
function openNativeDecoder(module: HEVCDecoderWASMModule, description: Uint8Array | null): number {
    const descriptionByteLength = description?.byteLength ?? 0;
    if (descriptionByteLength > MAXIMUM_DECODER_DESCRIPTION_BYTE_LENGTH) {
        throw new TypeError('The HEVC decoder description is too large');
    }
    const decoder = toHeapAddress(module._hevc_decoder_create(descriptionByteLength));
    if (decoder === 0) {
        throw new Error('The HEVC WASM decoder could not create a decoder');
    }
    try {
        if (description && descriptionByteLength > 0) {
            const descriptionPointer = toHeapAddress(module._hevc_decoder_get_extradata(decoder));
            if (descriptionPointer === 0 || descriptionPointer + descriptionByteLength > module.HEAPU8.byteLength) {
                throw new Error('The HEVC WASM decoder description allocation is invalid');
            }
            module.HEAPU8.set(description, descriptionPointer);
        }
        const openResult = module._hevc_decoder_open(decoder);
        if (openResult < 0) {
            throw new Error(`The HEVC WASM decoder could not open, code ${openResult}`);
        }
    } catch (error) {
        module._hevc_decoder_close(decoder);
        throw error;
    }
    return decoder;
}

class HEVCWASMDecoderBackend implements HEVCDecoderBackend {
    private decoder: number;

    public constructor(
        private readonly module: HEVCDecoderWASMModule,
        description: Uint8Array | null,
        private readonly onTrap: () => void
    ) {
        this.decoder = this.callNative((): number => openNativeDecoder(module, description));
    }

    public decode(
        data: Uint8Array,
        timestampMicroseconds: Microseconds,
        durationMicroseconds: Microseconds,
        frameHandler: HEVCDecodedFrameHandler
    ): number {
        const decoder = this.requireOpen();
        if (data.byteLength === 0) {
            throw new TypeError('The HEVC packet is empty');
        }
        return this.callNative((): number => {
            const packetPointer = toHeapAddress(this.module._hevc_decoder_configure_packet(decoder, data.byteLength));
            if (packetPointer === 0 || packetPointer + data.byteLength > this.module.HEAPU8.byteLength) {
                throw new Error('The HEVC WASM decoder could not allocate a packet');
            }
            this.module.HEAPU8.set(data, packetPointer);
            const sendResult = this.module._hevc_decoder_send_packet(
                decoder,
                BigInt(timestampMicroseconds),
                BigInt(durationMicroseconds)
            );
            if (sendResult < 0) {
                throw new Error(`The HEVC WASM decoder rejected a packet, code ${sendResult}`);
            }
            return this.receiveFrames(decoder, frameHandler, false);
        });
    }

    public flush(frameHandler: HEVCDecodedFrameHandler): number {
        const decoder = this.requireOpen();
        return this.callNative((): number => {
            const drainResult = this.module._hevc_decoder_start_drain(decoder);
            if (drainResult < 0 && drainResult !== this.module._hevc_decoder_error_eof()) {
                throw new Error(`The HEVC WASM decoder could not drain, code ${drainResult}`);
            }
            const frameCount = this.receiveFrames(decoder, frameHandler, true);
            this.module._hevc_decoder_reset(decoder);
            return frameCount;
        });
    }

    public destroy(): void {
        if (this.decoder === 0) {
            return;
        }
        const decoder = this.decoder;
        this.decoder = 0;
        this.module._hevc_decoder_close(decoder);
    }

    /** Hands over each frame the decoder returns until it needs another packet, or, draining, until it has none left. */
    private receiveFrames(decoder: number, frameHandler: HEVCDecodedFrameHandler, draining: boolean): number {
        const againResult = this.module._hevc_decoder_error_again();
        const endResult = this.module._hevc_decoder_error_eof();
        let frameCount = 0;
        while (true) {
            const receiveResult = this.module._hevc_decoder_receive_frame(decoder);
            if (receiveResult === againResult) {
                if (draining) {
                    throw new Error('The HEVC WASM decoder drain ended before its last frame');
                }
                return frameCount;
            }
            if (receiveResult === endResult) {
                return frameCount;
            }
            if (receiveResult < 0) {
                throw new Error(`The HEVC WASM decoder failed, code ${receiveResult}`);
            }
            if (frameCount >= MAXIMUM_HEVC_DRAINED_FRAME_COUNT) {
                throw new Error('The HEVC WASM decoder output exceeded its frame bound');
            }
            frameCount += 1;
            // The planes view WASM memory, so the handler consumes this frame before the next receive releases it
            frameHandler(readDecodedFrame(this.module, decoder));
        }
    }

    /** Runs native calls, reporting a trap before rethrowing it, so a shared module whose code trapped is not reused. */
    private callNative<Result>(call: () => Result): Result {
        try {
            return call();
        } catch (error) {
            if (isWASMTrap(error)) {
                this.onTrap();
            }
            throw error;
        }
    }

    private requireOpen(): number {
        if (this.decoder === 0) {
            throw new Error('The HEVC WASM decoder is destroyed');
        }
        return this.decoder;
    }
}

// The playback worker's decoders share one instance of the glue module
const sharedDecoderModule = new WorkerWASMInstanceCache<HEVCDecoderModule>();

function requireModuleFactory(): HEVCDecoderWASMModuleFactory {
    const decoderGlobal = globalThis as HEVCDecoderGlobal;
    if (typeof decoderGlobal.HEVCDecoderModule !== 'function') {
        throw new Error('The HEVC WASM decoder module factory is unavailable');
    }
    return decoderGlobal.HEVCDecoderModule as HEVCDecoderWASMModuleFactory;
}

async function instantiateDecoderModule(
    moduleFactory: HEVCDecoderWASMModuleFactory,
    options: HEVCDecoderModuleOptions,
    onTrap: (decoderModule: HEVCDecoderModule) => void
): Promise<HEVCDecoderModule> {
    // NOTE: The glue adopts this object as its Module, so every instantiation needs a fresh one
    const moduleOptions: HEVCDecoderWASMModuleOptions = {};
    const wasmURL = options.wasmURL;
    if (wasmURL) {
        moduleOptions.locateFile = (): string => wasmURL;
    }
    if (options.wasmBinary) {
        // The glue compiles these bytes instead of fetching the located file
        moduleOptions.wasmBinary = options.wasmBinary;
    }
    const module = await moduleFactory(moduleOptions);
    // Each decoder owns only its native context, so destroying one leaves the module reusable
    const decoderModule: HEVCDecoderModule = Object.freeze({
        createDecoder: (description: Uint8Array | null): HEVCDecoderBackend => new HEVCWASMDecoderBackend(
            module,
            description,
            (): void => {
                onTrap(decoderModule);
            }
        )
    });
    return decoderModule;
}

/** Instantiates the ffmpeg-hevc glue module loaded in this worker, as an instance of the caller's own, apart from the one its playback decoders share. */
export async function createHEVCDecoderModule(options: HEVCDecoderModuleOptions): Promise<HEVCDecoderModule> {
    return instantiateDecoderModule(requireModuleFactory(), options, (): void => undefined);
}

/**
 * Opens a decoder on the one instance of the ffmpeg-hevc glue module that this worker's decoders share.
 * The first decoder instantiates it, and a decoder whose native code traps makes the next one instantiate it again.
 */
export async function createHEVCDecoderBackend(options: HEVCDecoderBackendOptions): Promise<HEVCDecoderBackend> {
    const moduleFactory = requireModuleFactory();
    const decoderModule = await sharedDecoderModule.load(moduleFactory, (): Promise<HEVCDecoderModule> => (
        instantiateDecoderModule(
            moduleFactory,
            { wasmURL: options.wasmURL },
            (trappedModule: HEVCDecoderModule): void => {
                sharedDecoderModule.discard(trappedModule);
            }
        )
    ));
    return decoderModule.createDecoder(options.description);
}
