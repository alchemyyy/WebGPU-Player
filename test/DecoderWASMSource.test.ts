// @vitest-environment node

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
    createEmscriptenModuleLoader,
    getDecoderWASMTransfer,
    getEmscriptenWASMOptions,
    isDecoderWASMSource,
    type DecoderWASMSource,
    type EmscriptenModuleFactory,
    type EmscriptenWASMOptions
} from 'webgpu-player/DecoderWASMSource';
import { DTS_DECODER_WASM_ASSET } from 'webgpu-player/EngineAssets';

// The binary name the libdcadec glue asks locateFile for
const GLUE_BINARY_NAME = 'libdcadec-dts.wasm';
// Inside a worker, assets resolve against the worker's own URL and its cache key
const PROBE_WORKER_URL = 'https://example.test/web/libraries/webgpu-player/DTSExactCapabilityProbe.worker.js?v=build-1';
const SERVED_BINARY_URL = 'https://example.test/web/libraries/libdcadec-dts/libdcadec-dts.wasm?v=build-1';
const BINARY_BYTE_LENGTH = 8;
const EMPTY_BINARY_BYTE_LENGTH = 0;
// One byte past the bound a worker accepts
const OVERSIZED_BINARY_BYTE_LENGTH = 16 * 1024 * 1024 + 1;
const CREDENTIAL_URL = 'https://user:secret@example.test/libraries/libdcadec-dts/libdcadec-dts.wasm';
const FILE_URL = 'file:///engine/bin/wasm/libdcadec-dts/libdcadec-dts.wasm';
const EMPTY_URL = '';
const UNKNOWN_SOURCE_KIND = 'module';
const LOAD_FAILURE_MESSAGE = 'The decoder binary request failed';

type FakeDecoderModule = Readonly<{ options: EmscriptenWASMOptions }>;
type BytesSource = Extract<DecoderWASMSource, { kind: 'bytes' }>;

type FakeGlue = Readonly<{
    factory: Mock<EmscriptenModuleFactory<FakeDecoderModule>>
    importFactory: Mock<() => Promise<EmscriptenModuleFactory<FakeDecoderModule>>>
}>;

function createBytesSource(byteLength = BINARY_BYTE_LENGTH): BytesSource {
    return { bytes: new ArrayBuffer(byteLength), kind: 'bytes' };
}

function createFakeGlue(): FakeGlue {
    const factory = vi.fn<EmscriptenModuleFactory<FakeDecoderModule>>(
        options => Promise.resolve({ options })
    );
    const importFactory = vi.fn<() => Promise<EmscriptenModuleFactory<FakeDecoderModule>>>(
        () => Promise.resolve(factory)
    );
    return { factory, importFactory };
}

function stubProbeWorkerLocation(): void {
    vi.stubGlobal('location', { href: PROBE_WORKER_URL });
    vi.stubGlobal('importScripts', () => undefined);
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('decoder WASM module options', () => {
    it('locates a URL source, which the glue compiles while it streams', () => {
        const options = getEmscriptenWASMOptions({ kind: 'url', url: SERVED_BINARY_URL });

        expect(options.locateFile(GLUE_BINARY_NAME)).toBe(SERVED_BINARY_URL);
        expect(options.wasmBinary).toBeUndefined();
    });

    it('hands bytes to the glue without naming a URL it could fetch', () => {
        const source = createBytesSource();
        const options = getEmscriptenWASMOptions(source);

        expect(options.wasmBinary).toBe(source.bytes);
        expect(options.locateFile(GLUE_BINARY_NAME)).toBe(GLUE_BINARY_NAME);
    });

    it('transfers bytes to a worker and nothing for a URL', () => {
        const source = createBytesSource();

        expect(getDecoderWASMTransfer(source)).toEqual([ source.bytes ]);
        expect(getDecoderWASMTransfer({ kind: 'url', url: SERVED_BINARY_URL })).toEqual([]);
    });
});

describe('decoder WASM source validation', () => {
    it('accepts an HTTP(S) URL and bounded bytes', () => {
        expect(isDecoderWASMSource({ kind: 'url', url: SERVED_BINARY_URL })).toBe(true);
        expect(isDecoderWASMSource(createBytesSource())).toBe(true);
    });

    it('rejects URLs a worker must not fetch', () => {
        expect(isDecoderWASMSource({ kind: 'url', url: CREDENTIAL_URL })).toBe(false);
        expect(isDecoderWASMSource({ kind: 'url', url: FILE_URL })).toBe(false);
        expect(isDecoderWASMSource({ kind: 'url', url: DTS_DECODER_WASM_ASSET })).toBe(false);
        expect(isDecoderWASMSource({ kind: 'url', url: EMPTY_URL })).toBe(false);
    });

    it('rejects empty, oversized, and viewed bytes', () => {
        expect(isDecoderWASMSource(createBytesSource(EMPTY_BINARY_BYTE_LENGTH))).toBe(false);
        expect(isDecoderWASMSource(createBytesSource(OVERSIZED_BINARY_BYTE_LENGTH))).toBe(false);
        expect(isDecoderWASMSource({ bytes: new Uint8Array(BINARY_BYTE_LENGTH), kind: 'bytes' })).toBe(false);
    });

    it('rejects a missing source and an unknown kind', () => {
        expect(isDecoderWASMSource(undefined)).toBe(false);
        expect(isDecoderWASMSource({ kind: UNKNOWN_SOURCE_KIND, url: SERVED_BINARY_URL })).toBe(false);
    });
});

describe('Emscripten module loader', () => {
    it('imports the glue only when a decoder first needs the module', async () => {
        const glue = createFakeGlue();
        const loadModule = createEmscriptenModuleLoader(glue.importFactory, DTS_DECODER_WASM_ASSET);

        expect(glue.importFactory).not.toHaveBeenCalled();
        await loadModule(createBytesSource());
        expect(glue.importFactory).toHaveBeenCalledTimes(1);
    });

    it('locates the served binary by default, with the worker cache key', async () => {
        stubProbeWorkerLocation();
        const glue = createFakeGlue();
        const loadModule = createEmscriptenModuleLoader(glue.importFactory, DTS_DECODER_WASM_ASSET);

        const decoderModule = await loadModule();

        expect(decoderModule.options.locateFile(GLUE_BINARY_NAME)).toBe(SERVED_BINARY_URL);
        expect(decoderModule.options.wasmBinary).toBeUndefined();
    });

    it('instantiates bytes the caller already fetched', async () => {
        const glue = createFakeGlue();
        const loadModule = createEmscriptenModuleLoader(glue.importFactory, DTS_DECODER_WASM_ASSET);
        const source = createBytesSource();

        const decoderModule = await loadModule(source);

        expect(decoderModule.options.wasmBinary).toBe(source.bytes);
    });

    it('instantiates one module for every decoder of a worker', async () => {
        const glue = createFakeGlue();
        const loadModule = createEmscriptenModuleLoader(glue.importFactory, DTS_DECODER_WASM_ASSET);

        const firstModule = await loadModule(createBytesSource());
        const secondModule = await loadModule(createBytesSource());

        expect(secondModule).toBe(firstModule);
        expect(glue.factory).toHaveBeenCalledTimes(1);
    });

    it('retries a load that failed', async () => {
        const glue = createFakeGlue();
        glue.factory.mockRejectedValueOnce(new Error(LOAD_FAILURE_MESSAGE));
        const loadModule = createEmscriptenModuleLoader(glue.importFactory, DTS_DECODER_WASM_ASSET);

        await expect(loadModule(createBytesSource())).rejects.toThrow(LOAD_FAILURE_MESSAGE);
        const decoderModule = await loadModule(createBytesSource());

        expect(decoderModule.options.wasmBinary).toBeInstanceOf(ArrayBuffer);
        expect(glue.factory).toHaveBeenCalledTimes(2);
    });
});
