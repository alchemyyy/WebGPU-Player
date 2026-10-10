import type { HEVCFrame } from '@hevcjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createHEVCDecoderBackend,
    createHEVCDecoderModule,
    getHEVCFramePlanes,
    MAXIMUM_HEVC_DRAINED_FRAME_COUNT,
    type HEVCDecodedFrame,
    type HEVCDecodedFrameHandler
} from 'webgpu-player/video/decoders/HEVCDecoderBackend';

type NativeFunction = (...arguments_: number[]) => number;

type FakeModuleHarness = {
    drainedFrameIndexes: number[]
    destroyedDecoderPointers: number[]
    factory: ReturnType<typeof vi.fn>
    feedBytes: Uint8Array[]
    flushResult: { value: number }
    heap: Uint16Array
    locatedWASMURL: { value: string | null }
    /** Makes the next feed trap, as the WASM code of a corrupt stream can */
    trapNextFeed: { value: boolean }
    receivedWASMBinary: { value: ArrayBuffer | null }
};

type FakeFrameLayout = {
    bitDepth: number
    chromaHeight: number
    chromaStride?: number
    chromaWidth: number
    height: number
    lumaStride?: number
    width: number
};

/** A frame's fields and its compact planes, read while its handler runs. */
type DrainedFrameSnapshot = HEVCFrame;

// A 4x2 frame whose luma rows are two samples apart beyond their width, and whose chroma rows one
const PADDED_LUMA_STRIDE = 6;
const PADDED_CHROMA_STRIDE = 3;
const WASM_TRAP_MESSAGE = 'unreachable';

// The fake stores planes up to this size; a frame reporting larger planes lies outside its memory
const FAKE_MEMORY_MAXIMUM_STORED_LUMA_SAMPLE_COUNT = 65_536;
// Wider and taller than UHD, but small enough for the fake to store
const WIDER_THAN_UHD_FRAME_WIDTH = 4_096;
const TALLER_THAN_UHD_FRAME_HEIGHT = 4_320;
const MINIMUM_FRAME_DIMENSION = 2;
const ULTRA_HD_16K_FRAME_WIDTH = 15_360;
const ULTRA_HD_16K_FRAME_HEIGHT = 8_640;
const PLANE_OUTSIDE_MEMORY_ERROR = 'plane exceeds its memory';

function writeInt32(dataView: DataView, byteOffset: number, value: number): void {
    dataView.setInt32(byteOffset, value, true);
}

function writePointer(dataView: DataView, byteOffset: number, value: number): void {
    dataView.setUint32(byteOffset, value, true);
}

function createFakeModule(
    frameOverrides: Partial<FakeFrameLayout> = {},
    drainedFrameCount = 1
): FakeModuleHarness {
    const frameLayout: FakeFrameLayout = {
        bitDepth: 10,
        chromaHeight: 1,
        chromaWidth: 2,
        height: 2,
        width: 4,
        ...frameOverrides
    };
    const lumaStride = frameLayout.lumaStride ?? frameLayout.width;
    const chromaStride = frameLayout.chromaStride ?? frameLayout.chromaWidth;
    const storesPlanes = frameLayout.width * frameLayout.height <= FAKE_MEMORY_MAXIMUM_STORED_LUMA_SAMPLE_COUNT;
    const storedLumaSampleCount = storesPlanes ?
        ((frameLayout.height - 1) * lumaStride) + frameLayout.width :
        8;
    const storedChromaSampleCount = storesPlanes ?
        ((frameLayout.chromaHeight - 1) * chromaStride) + frameLayout.chromaWidth :
        2;
    const lumaPointer = 256;
    const chromaBluePointer = lumaPointer
        + (storedLumaSampleCount * Uint16Array.BYTES_PER_ELEMENT);
    const chromaRedPointer = chromaBluePointer
        + (storedChromaSampleCount * Uint16Array.BYTES_PER_ELEMENT);
    const firstAllocationPointer = chromaRedPointer
        + (storedChromaSampleCount * Uint16Array.BYTES_PER_ELEMENT)
        + 256;
    const memory = new ArrayBuffer(Math.max(1024 * 1024, firstAllocationPointer + 1024 * 1024));
    const dataView = new DataView(memory);
    const heapU16 = new Uint16Array(memory);
    const feedBytes: Uint8Array[] = [];
    const drainedFrameIndexes: number[] = [];
    const destroyedDecoderPointers: number[] = [];
    const flushResult = { value: 0 };
    const locatedWASMURL = { value: null as string | null };
    const receivedWASMBinary = { value: null as ArrayBuffer | null };
    const trapNextFeed = { value: false };
    let createdDecoderCount = 0;
    let nextAllocationPointer = firstAllocationPointer;
    // Every stored sample, padding included, counts up from 1 through luma, then blue and red chroma
    const storedSampleCount = storedLumaSampleCount + (2 * storedChromaSampleCount);
    for (let sampleIndex = 0; sampleIndex < storedSampleCount; sampleIndex += 1) {
        heapU16[(lumaPointer >> 1) + sampleIndex] = sampleIndex + 1;
    }

    function writeFrame(framePointer: number, frameIndex: number): void {
        writePointer(dataView, framePointer, lumaPointer);
        writePointer(dataView, framePointer + 4, chromaBluePointer);
        writePointer(dataView, framePointer + 8, chromaRedPointer);
        writeInt32(dataView, framePointer + 12, frameLayout.width);
        writeInt32(dataView, framePointer + 16, frameLayout.height);
        writeInt32(dataView, framePointer + 20, lumaStride);
        writeInt32(dataView, framePointer + 24, chromaStride);
        writeInt32(dataView, framePointer + 28, frameLayout.chromaWidth);
        writeInt32(dataView, framePointer + 32, frameLayout.chromaHeight);
        writeInt32(dataView, framePointer + 36, frameLayout.bitDepth);
        writeInt32(dataView, framePointer + 40, frameIndex);
    }

    const nativeFunctions: Record<string, NativeFunction> = {};
    // Each native decoder gets its own pointer: 1, 2, and so on
    nativeFunctions['hevc_decoder_create'] = (): number => {
        createdDecoderCount += 1;
        return createdDecoderCount;
    };
    nativeFunctions['hevc_decoder_destroy'] = (...nativeArguments: number[]): number => {
        destroyedDecoderPointers.push(nativeArguments[0]);
        return 0;
    };
    nativeFunctions['hevc_decoder_drain'] = (...nativeArguments: number[]): number => {
        writeInt32(dataView, nativeArguments[1], drainedFrameCount);
        return 0;
    };
    nativeFunctions['hevc_decoder_feed'] = (...nativeArguments: number[]): number => {
        if (trapNextFeed.value) {
            trapNextFeed.value = false;
            throw new WebAssembly.RuntimeError(WASM_TRAP_MESSAGE);
        }
        const dataPointer = nativeArguments[1];
        const byteLength = nativeArguments[2];
        feedBytes.push(new Uint8Array(memory.slice(dataPointer, dataPointer + byteLength)));
        return 0;
    };
    nativeFunctions['hevc_decoder_flush'] = (): number => flushResult.value;
    nativeFunctions['hevc_decoder_get_drained_frame'] = (...nativeArguments: number[]): number => {
        const frameIndex = nativeArguments[1];
        const framePointer = nativeArguments[2];
        if (frameIndex >= drainedFrameCount) {
            return 1;
        }
        drainedFrameIndexes.push(frameIndex);
        writeFrame(framePointer, frameIndex);
        return 0;
    };
    nativeFunctions['hevc_decoder_get_info'] = (): number => 1;
    const moduleValue = {
        HEAPU16: heapU16,
        _free: vi.fn((): void => undefined),
        _malloc: vi.fn((byteLength: number): number => {
            const pointer = nextAllocationPointer;
            nextAllocationPointer += Math.ceil(byteLength / 8) * 8;
            return pointer;
        }),
        cwrap: vi.fn((name: string): NativeFunction => nativeFunctions[name]),
        getValue: (pointer: number, type: '*' | 'i32'): number => (
            type === '*' ? dataView.getUint32(pointer, true) : dataView.getInt32(pointer, true)
        )
    };
    const factory = vi.fn(async (options: {
        locateFile?: (path: string, scriptDirectory: string) => string
        wasmBinary?: ArrayBuffer
    }): Promise<unknown> => {
        locatedWASMURL.value = options.locateFile?.('hevc-decode.wasm', '/ignored/') ?? null;
        receivedWASMBinary.value = options.wasmBinary ?? null;
        return moduleValue;
    });
    return {
        drainedFrameIndexes,
        destroyedDecoderPointers,
        factory,
        feedBytes,
        flushResult,
        heap: heapU16,
        locatedWASMURL,
        receivedWASMBinary,
        trapNextFeed
    };
}

/** Reads a frame's fields and compact planes while its handler runs, as a consumer must. */
function snapshotFrame(frame: HEVCDecodedFrame): DrainedFrameSnapshot {
    return {
        bitDepth: frame.bitDepth,
        cb: frame.cb.slice(),
        chromaHeight: frame.chromaHeight,
        chromaWidth: frame.chromaWidth,
        cr: frame.cr.slice(),
        height: frame.height,
        poc: frame.poc,
        width: frame.width,
        y: frame.y.slice()
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('createHEVCDecoderBackend', () => {
    it('uses the package module ABI for feed, display-order drain, flush, and destroy', async () => {
        const harness = createFakeModule();
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const backend = await createHEVCDecoderBackend({
            wasmBinaryUrl: 'https://example.test/hevc-decode.wasm'
        });
        expect(harness.locatedWASMURL.value).toBe('https://example.test/hevc-decode.wasm');

        backend.feed(new Uint8Array([ 0, 0, 0, 1, 38, 1 ]));
        const drainedFrames: DrainedFrameSnapshot[] = [];
        const flushedFrames: DrainedFrameSnapshot[] = [];
        const drainedFrameCount = backend.drain((frame: HEVCDecodedFrame): void => {
            drainedFrames.push(snapshotFrame(frame));
        });
        const flushedFrameCount = backend.flush((frame: HEVCDecodedFrame): void => {
            flushedFrames.push(snapshotFrame(frame));
        });

        expect(harness.feedBytes.map((data: Uint8Array): number[] => Array.from(data))).toEqual([
            [ 0, 0, 0, 1, 38, 1 ]
        ]);
        expect(drainedFrames).toEqual([ {
            bitDepth: 10,
            cb: new Uint16Array([ 9, 10 ]),
            chromaHeight: 1,
            chromaWidth: 2,
            cr: new Uint16Array([ 11, 12 ]),
            height: 2,
            poc: 0,
            width: 4,
            y: new Uint16Array([ 1, 2, 3, 4, 5, 6, 7, 8 ])
        } ]);
        expect(drainedFrameCount).toBe(1);
        expect(flushedFrames).toEqual(drainedFrames);
        expect(flushedFrameCount).toBe(1);
        expect(backend.info).toBeNull();
        backend.destroy();
        backend.destroy();
        expect(harness.destroyedDecoderPointers).toEqual([ 1 ]);
    });

    it('rejects a native flush failure and use after destroy', async () => {
        const harness = createFakeModule();
        harness.flushResult.value = 7;
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const backend = await createHEVCDecoderBackend({});

        expect(() => backend.flush((): void => undefined)).toThrow('code 7');
        backend.destroy();
        expect(() => backend.drain((): void => undefined)).toThrow('destroyed');
    });

    it('views padded planes in WASM memory and compacts their rows only when read', async () => {
        const harness = createFakeModule({
            chromaHeight: 2,
            chromaStride: PADDED_CHROMA_STRIDE,
            chromaWidth: 2,
            height: 4,
            lumaStride: PADDED_LUMA_STRIDE,
            width: 4
        });
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const backend = await createHEVCDecoderBackend({});
        const observations: Array<{
            lumaViewsHeap: boolean
            planes: ReturnType<typeof getHEVCFramePlanes>
            snapshot: DrainedFrameSnapshot
        }> = [];

        backend.drain((frame: HEVCDecodedFrame): void => {
            const planes = getHEVCFramePlanes(frame);
            observations.push({
                lumaViewsHeap: planes.luma.samples.buffer === harness.heap.buffer,
                planes: {
                    chromaBlue: { samples: planes.chromaBlue.samples.slice(), stride: planes.chromaBlue.stride },
                    chromaRed: { samples: planes.chromaRed.samples.slice(), stride: planes.chromaRed.stride },
                    luma: { samples: planes.luma.samples.slice(), stride: planes.luma.stride }
                },
                snapshot: snapshotFrame(frame)
            });
        });

        // Luma rows start six samples apart and chroma rows three, so samples 5, 6, 11, 12, 17, 18, 25, and 30 are padding
        expect(observations).toEqual([ {
            lumaViewsHeap: true,
            planes: {
                chromaBlue: { samples: new Uint16Array([ 23, 24, 25, 26, 27 ]), stride: PADDED_CHROMA_STRIDE },
                chromaRed: { samples: new Uint16Array([ 28, 29, 30, 31, 32 ]), stride: PADDED_CHROMA_STRIDE },
                luma: {
                    samples: new Uint16Array([
                        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22
                    ]),
                    stride: PADDED_LUMA_STRIDE
                }
            },
            snapshot: {
                bitDepth: 10,
                cb: new Uint16Array([ 23, 24, 26, 27 ]),
                chromaHeight: 2,
                chromaWidth: 2,
                cr: new Uint16Array([ 28, 29, 31, 32 ]),
                height: 4,
                poc: 0,
                width: 4,
                y: new Uint16Array([ 1, 2, 3, 4, 7, 8, 9, 10, 13, 14, 15, 16, 19, 20, 21, 22 ])
            }
        } ]);
        backend.destroy();
    });

    it('rejects invalid chroma geometry before exposing decoded planes', async () => {
        const harness = createFakeModule({ chromaWidth: 3 });
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const backend = await createHEVCDecoderBackend({});

        expect(() => backend.drain((): void => undefined)).toThrow('invalid 4:2:0 dimensions');
        backend.destroy();
    });

    it.each([
        { height: MINIMUM_FRAME_DIMENSION, label: 'wider', width: WIDER_THAN_UHD_FRAME_WIDTH },
        { height: TALLER_THAN_UHD_FRAME_HEIGHT, label: 'taller', width: MINIMUM_FRAME_DIMENSION }
    ])('exposes a frame $label than UHD whose planes lie in memory', async ({ height, width }) => {
        const harness = createFakeModule({
            chromaHeight: height / 2,
            chromaWidth: width / 2,
            height,
            width
        });
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const backend = await createHEVCDecoderBackend({});
        const drainedFrames: HEVCFrame[] = [];

        expect(backend.drain((frame: HEVCFrame): void => {
            drainedFrames.push(frame);
        })).toBe(1);
        expect(drainedFrames[0]).toMatchObject({ height, width });
        expect(drainedFrames[0]?.y.length).toBe(width * height);
        backend.destroy();
    });

    it('rejects a frame whose planes lie outside the WASM memory', async () => {
        const harness = createFakeModule({
            chromaHeight: ULTRA_HD_16K_FRAME_HEIGHT / 2,
            chromaWidth: ULTRA_HD_16K_FRAME_WIDTH / 2,
            height: ULTRA_HD_16K_FRAME_HEIGHT,
            width: ULTRA_HD_16K_FRAME_WIDTH
        });
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const backend = await createHEVCDecoderBackend({});

        expect(() => backend.drain((): void => undefined)).toThrow(PLANE_OUTSIDE_MEMORY_ERROR);
        backend.destroy();
    });

    it('rejects an oversized reported drain before exposing any frame', async () => {
        const harness = createFakeModule({}, MAXIMUM_HEVC_DRAINED_FRAME_COUNT + 1);
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const backend = await createHEVCDecoderBackend({});

        expect(() => backend.drain((): void => undefined)).toThrow('invalid frame count');
        expect(harness.drainedFrameIndexes).toEqual([]);
        backend.destroy();
    });

    it('streams each borrowed frame before extracting the next frame', async () => {
        const harness = createFakeModule({}, 3);
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const backend = await createHEVCDecoderBackend({});
        const observations: Array<{ extractedFrameCount: number; poc: number }> = [];

        const frameCount = backend.drain((frame: HEVCFrame): void => {
            observations.push({
                extractedFrameCount: harness.drainedFrameIndexes.length,
                poc: frame.poc
            });
        });

        expect(frameCount).toBe(3);
        expect(observations).toEqual([
            { extractedFrameCount: 1, poc: 0 },
            { extractedFrameCount: 2, poc: 1 },
            { extractedFrameCount: 3, poc: 2 }
        ]);
        backend.destroy();
    });

    it('streams flushed frames without retaining a borrowed batch', async () => {
        const harness = createFakeModule({}, 3);
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const backend = await createHEVCDecoderBackend({});
        const observations: Array<{ extractedFrameCount: number; poc: number }> = [];

        const frameCount = backend.flush((frame: HEVCFrame): void => {
            observations.push({
                extractedFrameCount: harness.drainedFrameIndexes.length,
                poc: frame.poc
            });
        });

        expect(frameCount).toBe(3);
        expect(observations).toEqual([
            { extractedFrameCount: 1, poc: 0 },
            { extractedFrameCount: 2, poc: 1 },
            { extractedFrameCount: 3, poc: 2 }
        ]);
        backend.destroy();
    });

    it('stops extraction immediately when the frame handler fails', async () => {
        const harness = createFakeModule({}, 3);
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const backend = await createHEVCDecoderBackend({});
        const frameHandler: HEVCDecodedFrameHandler = (): never => {
            throw new Error('consumer failed');
        };

        expect(() => backend.drain(frameHandler)).toThrow('consumer failed');
        expect(harness.drainedFrameIndexes).toEqual([ 0 ]);
        backend.destroy();
    });

    it('requires the glue module factory', async () => {
        vi.stubGlobal('HEVCDecoderModule', undefined);

        await expect(createHEVCDecoderBackend({})).rejects.toThrow('factory is unavailable');
    });

    it('creates every decoder of the worker on one module instance', async () => {
        const harness = createFakeModule();
        vi.stubGlobal('HEVCDecoderModule', harness.factory);

        const firstBackend = await createHEVCDecoderBackend({ wasmBinaryUrl: 'https://example.test/hevc-decode.wasm' });
        firstBackend.destroy();
        const secondBackend = await createHEVCDecoderBackend({ wasmBinaryUrl: 'https://example.test/hevc-decode.wasm' });
        const concurrentBackends = await Promise.all([
            createHEVCDecoderBackend({}),
            createHEVCDecoderBackend({})
        ]);

        expect(harness.factory).toHaveBeenCalledOnce();
        expect(harness.locatedWASMURL.value).toBe('https://example.test/hevc-decode.wasm');
        // Each decoder still creates and destroys its own native context
        secondBackend.destroy();
        for (const backend of concurrentBackends) {
            backend.destroy();
        }
        expect(harness.destroyedDecoderPointers).toEqual([ 1, 2, 3, 4 ]);
    });

    it('instantiates the module again for the next decoder after native code traps', async () => {
        const harness = createFakeModule();
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const trappingBackend = await createHEVCDecoderBackend({});
        harness.trapNextFeed.value = true;

        expect(() => trappingBackend.feed(new Uint8Array([ 0, 0, 0, 1, 38, 1 ]))).toThrow(WASM_TRAP_MESSAGE);
        const nextBackend = await createHEVCDecoderBackend({});

        expect(harness.factory).toHaveBeenCalledTimes(2);
        trappingBackend.destroy();
        nextBackend.destroy();
    });

    it('keeps the module after an error its native code returned', async () => {
        const harness = createFakeModule();
        harness.flushResult.value = 7;
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const failingBackend = await createHEVCDecoderBackend({});

        expect(() => failingBackend.flush((): void => undefined)).toThrow('code 7');
        const nextBackend = await createHEVCDecoderBackend({});

        expect(harness.factory).toHaveBeenCalledOnce();
        failingBackend.destroy();
        nextBackend.destroy();
    });

    it('retries the instantiation after a failed one', async () => {
        const harness = createFakeModule();
        const instantiationError = new Error('instantiation failed');
        harness.factory.mockRejectedValueOnce(instantiationError);
        vi.stubGlobal('HEVCDecoderModule', harness.factory);

        await expect(createHEVCDecoderBackend({})).rejects.toBe(instantiationError);
        const backend = await createHEVCDecoderBackend({});

        expect(harness.factory).toHaveBeenCalledTimes(2);
        backend.destroy();
    });
});

describe('createHEVCDecoderModule', () => {
    it('hosts successive decoders on one instantiated module', async () => {
        const harness = createFakeModule();
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const decoderModule = await createHEVCDecoderModule({
            wasmURL: 'https://example.test/hevc-decode.wasm'
        });

        const firstBackend = decoderModule.createDecoder();
        firstBackend.destroy();
        const secondBackend = decoderModule.createDecoder();
        secondBackend.feed(new Uint8Array([ 0, 0, 0, 1, 38, 1 ]));
        secondBackend.destroy();

        expect(harness.factory).toHaveBeenCalledOnce();
        expect(harness.locatedWASMURL.value).toBe('https://example.test/hevc-decode.wasm');
        expect(harness.receivedWASMBinary.value).toBeNull();
        expect(harness.destroyedDecoderPointers).toEqual([ 1, 2 ]);
        expect(harness.feedBytes).toHaveLength(1);
        expect(() => firstBackend.feed(new Uint8Array([ 0 ]))).toThrow('destroyed');
    });

    it('hands preloaded WASM bytes to the glue', async () => {
        const harness = createFakeModule();
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const wasmBinary = new ArrayBuffer(8);

        await createHEVCDecoderModule({
            wasmBinary,
            wasmURL: 'https://example.test/hevc-decode.wasm'
        });

        expect(harness.receivedWASMBinary.value).toBe(wasmBinary);
        expect(harness.locatedWASMURL.value).toBe('https://example.test/hevc-decode.wasm');
    });

    it('gives the glue a fresh settings object on every instantiation', async () => {
        const harness = createFakeModule();
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const options = { wasmURL: 'https://example.test/hevc-decode.wasm' };

        await createHEVCDecoderModule(options);
        await createHEVCDecoderModule(options);

        // NOTE: The glue's assertion build installs aborting getters on the object it receives, so reusing one aborts the next instantiation
        expect(harness.factory.mock.calls[0][0]).not.toBe(harness.factory.mock.calls[1][0]);
    });

    it('requires the glue module factory', async () => {
        vi.stubGlobal('HEVCDecoderModule', undefined);

        await expect(createHEVCDecoderModule({})).rejects.toThrow('factory is unavailable');
    });
});
