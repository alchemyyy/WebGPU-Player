import type {
    DecoderOptions,
    HEVCFrame,
    HEVCStreamInfo
} from '@hevcjs/core';

import WorkerWASMInstanceCache, { isWASMTrap } from './WorkerWASMInstanceCache';

const DRAINED_FRAME_STRUCTURE_BYTE_LENGTH = 48;
const STREAM_INFO_STRUCTURE_BYTE_LENGTH = 24;
export const MAXIMUM_HEVC_DRAINED_FRAME_COUNT = 64;

type EmscriptenReturnType = 'number' | null;

type EmscriptenHEVCModule = {
    readonly HEAPU16: Uint16Array
    _free: (pointer: number) => void
    _malloc: (byteLength: number) => number
    cwrap: (
        name: string,
        returnType: EmscriptenReturnType,
        argumentTypes: readonly string[]
    ) => (...nativeArguments: number[]) => number
    getValue: (pointer: number, type: '*' | 'i32') => number
};

type EmscriptenHEVCModuleOptions = {
    locateFile?: (path: string, scriptDirectory: string) => string
    wasmBinary?: ArrayBuffer
};

type EmscriptenHEVCModuleFactory = (options: EmscriptenHEVCModuleOptions) => Promise<EmscriptenHEVCModule>;

type HEVCDecoderGlobal = typeof globalThis & {
    HEVCDecoderModule?: unknown
};

type HEVCNativeAPI = {
    create: () => number
    destroy: (decoderPointer: number) => number
    drain: (decoderPointer: number, countPointer: number) => number
    feed: (decoderPointer: number, dataPointer: number, byteLength: number) => number
    flush: (decoderPointer: number) => number
    getDrainedFrame: (decoderPointer: number, frameIndex: number, framePointer: number) => number
    getInfo: (decoderPointer: number, infoPointer: number) => number
};

type HEVCPlaneLayout = {
    height: number
    pointer: number
    stride: number
    width: number
};

type HEVCFrameLayout = {
    bitDepth: 8 | 10
    chromaBlue: HEVCPlaneLayout
    chromaHeight: number
    chromaRed: HEVCPlaneLayout
    chromaWidth: number
    height: number
    luma: HEVCPlaneLayout
    poc: number
    width: number
};

/** One plane of a drained frame: 16-bit samples whose rows start a stride apart, from the first sample to the end of the last row. */
export type HEVCFramePlane = Readonly<{
    samples: Uint16Array
    stride: number
}>;

/** The planes of a 4:2:0 frame. */
export type HEVCFramePlanes = Readonly<{
    chromaBlue: HEVCFramePlane
    chromaRed: HEVCFramePlane
    luma: HEVCFramePlane
}>;

/**
 * A drained frame, whose planes view WASM memory only until the decoder's next call.
 * The WASM backend's frames also carry their strided planes, and make the compact y, cb, and cr only when they are read.
 */
export type HEVCDecodedFrame = HEVCFrame & Readonly<{
    planes?: HEVCFramePlanes
}>;

/** Consumes a frame synchronously before the decoder may reuse its WASM planes. */
export type HEVCDecodedFrameHandler = (frame: HEVCDecodedFrame) => void;

export type HEVCDecoderBackend = {
    readonly info: HEVCStreamInfo | null
    destroy: () => void
    drain: (frameHandler: HEVCDecodedFrameHandler) => number
    feed: (data: Uint8Array) => void
    flush: (frameHandler: HEVCDecodedFrameHandler) => number
};

/** Locates hevc-decode.wasm by URL, or supplies its bytes so instantiation fetches nothing. */
export type HEVCDecoderModuleOptions = Readonly<{
    wasmBinary?: ArrayBuffer
    wasmURL?: string
}>;

/** One instantiated hevc-decode.wasm module, which hosts successive decoders. */
export type HEVCDecoderModule = Readonly<{
    createDecoder: () => HEVCDecoderBackend
}>;

function requireAllocation(module: EmscriptenHEVCModule, byteLength: number): number {
    const pointer = module._malloc(byteLength);
    if (!Number.isSafeInteger(pointer) || pointer <= 0) {
        throw new Error('The HEVC WASM decoder could not allocate memory');
    }
    return pointer;
}

function isPositiveSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

function validatePlaneLayout(
    module: EmscriptenHEVCModule,
    pointer: number,
    width: number,
    height: number,
    stride: number
): HEVCPlaneLayout {
    const sampleCount = width * height;
    if (
        !isPositiveSafeInteger(pointer)
        || pointer % Uint16Array.BYTES_PER_ELEMENT !== 0
        || !isPositiveSafeInteger(width)
        || !isPositiveSafeInteger(height)
        || !Number.isSafeInteger(stride)
        || stride < width
        || !Number.isSafeInteger(sampleCount)
    ) {
        throw new TypeError('The HEVC WASM decoder returned an invalid plane');
    }

    const baseSampleOffset = pointer / Uint16Array.BYTES_PER_ELEMENT;
    const finalSourceEnd = baseSampleOffset + ((height - 1) * stride) + width;
    if (!Number.isSafeInteger(finalSourceEnd) || finalSourceEnd > module.HEAPU16.length) {
        throw new TypeError('The HEVC WASM decoder plane exceeds its memory');
    }
    return { height, pointer, stride, width };
}

function validateFrameLayout(
    module: EmscriptenHEVCModule,
    frameValues: {
        bitDepth: number
        chromaBluePointer: number
        chromaHeight: number
        chromaRedPointer: number
        chromaStride: number
        chromaWidth: number
        height: number
        lumaPointer: number
        lumaStride: number
        poc: number
        width: number
    }
): HEVCFrameLayout {
    if (frameValues.bitDepth !== 8 && frameValues.bitDepth !== 10) {
        throw new TypeError('The HEVC WASM decoder returned an unsupported bit depth');
    }
    if (
        !isPositiveSafeInteger(frameValues.width)
        || !isPositiveSafeInteger(frameValues.height)
        || frameValues.chromaWidth !== Math.ceil(frameValues.width / 2)
        || frameValues.chromaHeight !== Math.ceil(frameValues.height / 2)
    ) {
        throw new TypeError('The HEVC WASM decoder returned invalid 4:2:0 dimensions');
    }

    // Any frame size is accepted; each plane must lie within the WASM memory, which bounds the copy
    const lumaSampleCount = frameValues.width * frameValues.height;
    const chromaSampleCount = frameValues.chromaWidth * frameValues.chromaHeight;
    const totalSampleCount = lumaSampleCount + (2 * chromaSampleCount);
    const copiedByteLength = totalSampleCount * Uint16Array.BYTES_PER_ELEMENT;
    if (
        !Number.isSafeInteger(lumaSampleCount)
        || !Number.isSafeInteger(chromaSampleCount)
        || !Number.isSafeInteger(totalSampleCount)
        || !Number.isSafeInteger(copiedByteLength)
        || copiedByteLength <= 0
    ) {
        throw new TypeError('The HEVC WASM decoder frame size is invalid');
    }

    const luma = validatePlaneLayout(
        module,
        frameValues.lumaPointer,
        frameValues.width,
        frameValues.height,
        frameValues.lumaStride
    );
    const chromaBlue = validatePlaneLayout(
        module,
        frameValues.chromaBluePointer,
        frameValues.chromaWidth,
        frameValues.chromaHeight,
        frameValues.chromaStride
    );
    const chromaRed = validatePlaneLayout(
        module,
        frameValues.chromaRedPointer,
        frameValues.chromaWidth,
        frameValues.chromaHeight,
        frameValues.chromaStride
    );
    return {
        bitDepth: frameValues.bitDepth,
        chromaBlue,
        chromaHeight: frameValues.chromaHeight,
        chromaRed,
        chromaWidth: frameValues.chromaWidth,
        height: frameValues.height,
        luma,
        poc: frameValues.poc,
        width: frameValues.width
    };
}

/** Views a plane from its first sample to the end of its last row, without copying it out of WASM memory. */
function getPlaneView(module: EmscriptenHEVCModule, layout: HEVCPlaneLayout): HEVCFramePlane {
    const baseSampleOffset = layout.pointer / Uint16Array.BYTES_PER_ELEMENT;
    const finalSampleEnd = baseSampleOffset + ((layout.height - 1) * layout.stride) + layout.width;
    return {
        samples: module.HEAPU16.subarray(baseSampleOffset, finalSampleEnd),
        stride: layout.stride
    };
}

/** Returns a plane as compact rows: the plane itself when its stride is its width, or a copy of its rows. */
function getCompactPlane(plane: HEVCFramePlane, width: number, height: number): Uint16Array {
    if (plane.stride === width) {
        return plane.samples;
    }

    const output = new Uint16Array(width * height);
    for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
        const sourceOffset = rowIndex * plane.stride;
        output.set(plane.samples.subarray(sourceOffset, sourceOffset + width), rowIndex * width);
    }
    return output;
}

/** A drained frame that views its strided planes in WASM memory and makes its compact planes only when they are read. */
class HEVCWASMDecodedFrame {
    public readonly bitDepth: number;
    public readonly chromaHeight: number;
    public readonly chromaWidth: number;
    public readonly height: number;
    public readonly planes: HEVCFramePlanes;
    public readonly poc: number;
    public readonly width: number;
    private compactChromaBlue: Uint16Array | null = null;
    private compactChromaRed: Uint16Array | null = null;
    private compactLuma: Uint16Array | null = null;

    public constructor(layout: HEVCFrameLayout, planes: HEVCFramePlanes) {
        this.bitDepth = layout.bitDepth;
        this.chromaHeight = layout.chromaHeight;
        this.chromaWidth = layout.chromaWidth;
        this.height = layout.height;
        this.planes = planes;
        this.poc = layout.poc;
        this.width = layout.width;
    }

    public get cb(): Uint16Array {
        this.compactChromaBlue ??= getCompactPlane(this.planes.chromaBlue, this.chromaWidth, this.chromaHeight);
        return this.compactChromaBlue;
    }

    public get cr(): Uint16Array {
        this.compactChromaRed ??= getCompactPlane(this.planes.chromaRed, this.chromaWidth, this.chromaHeight);
        return this.compactChromaRed;
    }

    public get y(): Uint16Array {
        this.compactLuma ??= getCompactPlane(this.planes.luma, this.width, this.height);
        return this.compactLuma;
    }
}

/** Returns a frame's planes with their strides: the WASM views a backend frame carries, or its compact planes, whose stride is their width. */
export function getHEVCFramePlanes(frame: HEVCDecodedFrame): HEVCFramePlanes {
    return frame.planes ?? {
        chromaBlue: { samples: frame.cb, stride: frame.chromaWidth },
        chromaRed: { samples: frame.cr, stride: frame.chromaWidth },
        luma: { samples: frame.y, stride: frame.width }
    };
}

/** Reports a trap in a native call before rethrowing it, so a shared module whose code trapped is not reused. */
function guardNativeFunction(
    nativeFunction: (...nativeArguments: number[]) => number,
    onTrap: () => void
): (...nativeArguments: number[]) => number {
    return (...nativeArguments: number[]): number => {
        try {
            return nativeFunction(...nativeArguments);
        } catch (error) {
            if (isWASMTrap(error)) {
                onTrap();
            }
            throw error;
        }
    };
}

class HEVCWASMDecoderBackend implements HEVCDecoderBackend {
    private decoderPointer: number;
    private readonly nativeAPI: HEVCNativeAPI;

    public constructor(private readonly module: EmscriptenHEVCModule, onTrap: () => void) {
        const cwrap = (
            name: string,
            returnType: EmscriptenReturnType,
            argumentTypes: readonly string[]
        ): (...nativeArguments: number[]) => number => guardNativeFunction(
            module.cwrap(name, returnType, argumentTypes),
            onTrap
        );
        this.nativeAPI = {
            create: cwrap('hevc_decoder_create', 'number', []) as () => number,
            destroy: cwrap('hevc_decoder_destroy', null, [ 'number' ]) as (decoderPointer: number) => number,
            drain: cwrap(
                'hevc_decoder_drain',
                'number',
                [ 'number', 'number' ]
            ) as (decoderPointer: number, countPointer: number) => number,
            feed: cwrap(
                'hevc_decoder_feed',
                'number',
                [ 'number', 'number', 'number' ]
            ) as (decoderPointer: number, dataPointer: number, byteLength: number) => number,
            flush: cwrap('hevc_decoder_flush', 'number', [ 'number' ]) as (decoderPointer: number) => number,
            getDrainedFrame: cwrap(
                'hevc_decoder_get_drained_frame',
                'number',
                [ 'number', 'number', 'number' ]
            ) as (decoderPointer: number, frameIndex: number, framePointer: number) => number,
            getInfo: cwrap(
                'hevc_decoder_get_info',
                'number',
                [ 'number', 'number' ]
            ) as (decoderPointer: number, infoPointer: number) => number
        };
        this.decoderPointer = this.nativeAPI.create();
        if (!isPositiveSafeInteger(this.decoderPointer)) {
            throw new Error('The HEVC WASM decoder could not create a decoder');
        }
    }

    public get info(): HEVCStreamInfo | null {
        this.requireOpen();
        const infoPointer = requireAllocation(this.module, STREAM_INFO_STRUCTURE_BYTE_LENGTH);
        try {
            if (this.nativeAPI.getInfo(this.decoderPointer, infoPointer) !== 0) {
                return null;
            }
            return {
                bitDepth: this.module.getValue(infoPointer + 8, 'i32'),
                chromaFormat: this.module.getValue(infoPointer + 12, 'i32'),
                height: this.module.getValue(infoPointer + 4, 'i32'),
                level: this.module.getValue(infoPointer + 20, 'i32'),
                profile: this.module.getValue(infoPointer + 16, 'i32'),
                width: this.module.getValue(infoPointer, 'i32')
            };
        } finally {
            this.module._free(infoPointer);
        }
    }

    public feed(data: Uint8Array): void {
        this.requireOpen();
        const dataPointer = requireAllocation(this.module, data.byteLength);
        try {
            new Uint8Array(this.module.HEAPU16.buffer).set(data, dataPointer);
            const result = this.nativeAPI.feed(this.decoderPointer, dataPointer, data.byteLength);
            if (result !== 0) {
                throw new Error(`The HEVC WASM decoder feed failed with code ${result}`);
            }
        } finally {
            this.module._free(dataPointer);
        }
    }

    public drain(frameHandler: HEVCDecodedFrameHandler): number {
        this.requireOpen();
        const countPointer = requireAllocation(this.module, 4);
        try {
            const result = this.nativeAPI.drain(this.decoderPointer, countPointer);
            if (result !== 0) {
                throw new Error(`The HEVC WASM decoder drain failed with code ${result}`);
            }
            const frameCount = this.module.getValue(countPointer, 'i32');
            if (!Number.isSafeInteger(frameCount) || frameCount < 0 || frameCount > MAXIMUM_HEVC_DRAINED_FRAME_COUNT) {
                throw new TypeError('The HEVC WASM decoder returned an invalid frame count');
            }

            for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
                const frame = this.extractDrainedFrame(frameIndex);
                if (!frame) {
                    throw new Error('The HEVC WASM decoder omitted a reported frame');
                }
                // The planes may view WASM memory, so the handler consumes this frame before the next extraction
                frameHandler(frame);
            }
            return frameCount;
        } finally {
            this.module._free(countPointer);
        }
    }

    public flush(frameHandler: HEVCDecodedFrameHandler): number {
        this.requireOpen();
        const result = this.nativeAPI.flush(this.decoderPointer);
        if (result !== 0) {
            throw new Error(`The HEVC WASM decoder flush failed with code ${result}`);
        }

        for (let frameIndex = 0; frameIndex <= MAXIMUM_HEVC_DRAINED_FRAME_COUNT; frameIndex += 1) {
            const frame = this.extractDrainedFrame(frameIndex);
            if (!frame) {
                return frameIndex;
            }
            if (frameIndex === MAXIMUM_HEVC_DRAINED_FRAME_COUNT) {
                throw new Error('The HEVC WASM decoder flush exceeded its frame bound');
            }
            // Flush preserves display order without retaining a decoded frame batch
            frameHandler(frame);
        }
        throw new Error('The HEVC WASM decoder flush exceeded its frame bound');
    }

    public destroy(): void {
        if (this.decoderPointer === 0) {
            return;
        }
        const decoderPointer = this.decoderPointer;
        this.decoderPointer = 0;
        this.nativeAPI.destroy(decoderPointer);
    }

    private extractDrainedFrame(frameIndex: number): HEVCDecodedFrame | null {
        const framePointer = requireAllocation(this.module, DRAINED_FRAME_STRUCTURE_BYTE_LENGTH);
        try {
            if (this.nativeAPI.getDrainedFrame(this.decoderPointer, frameIndex, framePointer) !== 0) {
                return null;
            }

            const lumaPointer = this.module.getValue(framePointer, '*');
            const chromaBluePointer = this.module.getValue(framePointer + 4, '*');
            const chromaRedPointer = this.module.getValue(framePointer + 8, '*');
            const width = this.module.getValue(framePointer + 12, 'i32');
            const height = this.module.getValue(framePointer + 16, 'i32');
            const lumaStride = this.module.getValue(framePointer + 20, 'i32');
            const chromaStride = this.module.getValue(framePointer + 24, 'i32');
            const chromaWidth = this.module.getValue(framePointer + 28, 'i32');
            const chromaHeight = this.module.getValue(framePointer + 32, 'i32');
            const bitDepth = this.module.getValue(framePointer + 36, 'i32');
            const poc = this.module.getValue(framePointer + 40, 'i32');
            const frameLayout = validateFrameLayout(this.module, {
                bitDepth,
                chromaBluePointer,
                chromaHeight,
                chromaRedPointer,
                chromaStride,
                chromaWidth,
                height,
                lumaPointer,
                lumaStride,
                poc,
                width
            });
            return new HEVCWASMDecodedFrame(frameLayout, {
                chromaBlue: getPlaneView(this.module, frameLayout.chromaBlue),
                chromaRed: getPlaneView(this.module, frameLayout.chromaRed),
                luma: getPlaneView(this.module, frameLayout.luma)
            });
        } finally {
            this.module._free(framePointer);
        }
    }

    private requireOpen(): void {
        if (this.decoderPointer === 0) {
            throw new Error('The HEVC WASM decoder is destroyed');
        }
    }
}

// The playback worker's decoders share one instance of the glue module
const sharedDecoderModule = new WorkerWASMInstanceCache<HEVCDecoderModule>();

function requireModuleFactory(): EmscriptenHEVCModuleFactory {
    const decoderGlobal = globalThis as HEVCDecoderGlobal;
    if (typeof decoderGlobal.HEVCDecoderModule !== 'function') {
        throw new Error('The HEVC WASM decoder module factory is unavailable');
    }
    return decoderGlobal.HEVCDecoderModule as EmscriptenHEVCModuleFactory;
}

async function instantiateDecoderModule(
    moduleFactory: EmscriptenHEVCModuleFactory,
    options: HEVCDecoderModuleOptions,
    onTrap: (decoderModule: HEVCDecoderModule) => void
): Promise<HEVCDecoderModule> {
    // NOTE: The glue adopts this object as its Module and installs aborting getters on it, so every instantiation needs a fresh one
    const moduleOptions: EmscriptenHEVCModuleOptions = {};
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
        createDecoder: (): HEVCDecoderBackend => new HEVCWASMDecoderBackend(module, (): void => {
            onTrap(decoderModule);
        })
    });
    return decoderModule;
}

/** Instantiates the @hevcjs/core glue module loaded in this worker, as an instance of the caller's own, apart from the one its playback decoders share. */
export async function createHEVCDecoderModule(options: HEVCDecoderModuleOptions): Promise<HEVCDecoderModule> {
    return instantiateDecoderModule(requireModuleFactory(), options, (): void => undefined);
}

/**
 * Creates a decoder on the one instance of the @hevcjs/core glue module that this worker's decoders share.
 * The first decoder instantiates it, and a decoder whose native code traps makes the next one instantiate it again.
 */
export async function createHEVCDecoderBackend(options: DecoderOptions): Promise<HEVCDecoderBackend> {
    const moduleFactory = requireModuleFactory();
    const decoderModule = await sharedDecoderModule.load(moduleFactory, (): Promise<HEVCDecoderModule> => (
        instantiateDecoderModule(
            moduleFactory,
            { wasmURL: options.wasmBinaryUrl },
            (trappedModule: HEVCDecoderModule): void => {
                sharedDecoderModule.discard(trappedModule);
            }
        )
    ));
    return decoderModule.createDecoder();
}
