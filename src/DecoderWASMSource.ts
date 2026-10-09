import { resolveEngineAssetURL, type EngineAssetPath } from './EngineAssets';

// Bounds the bytes a worker accepts; every engine decoder binary is under 1 MiB
const MAXIMUM_DECODER_WASM_BYTE_LENGTH = 16 * 1024 * 1024;
const MAXIMUM_DECODER_WASM_URL_LENGTH = 2_048;

/**
 * Where a decoder's WebAssembly binary comes from.
 * A URL compiles while it downloads; bytes come from a caller that already fetched them, such as the main thread.
 */
export type DecoderWASMSource =
    | Readonly<{ kind: 'url', url: string }>
    | Readonly<{ bytes: ArrayBuffer, kind: 'bytes' }>;

/** The Emscripten module settings that place a decoder's binary. */
export type EmscriptenWASMOptions = {
    locateFile: (path: string) => string
    wasmBinary?: ArrayBuffer
};

/** The default export of a decoder kit's ES module glue. */
export type EmscriptenModuleFactory<ModuleType> = (options: EmscriptenWASMOptions) => Promise<ModuleType>;

/** Loads a decoder's module from the served binary, unless the caller passes another source. */
export type EmscriptenModuleLoader<ModuleType> = (source?: DecoderWASMSource) => Promise<ModuleType>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function isDecoderWASMURL(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAXIMUM_DECODER_WASM_URL_LENGTH) {
        return false;
    }
    try {
        const parsedURL = new URL(value);
        return (parsedURL.protocol === 'http:' || parsedURL.protocol === 'https:')
            && parsedURL.username.length === 0
            && parsedURL.password.length === 0;
    } catch {
        return false;
    }
}

/** Names a served decoder binary by its URL under the engine asset base, with the build's cache key. */
export function createDecoderWASMURLSource(path: EngineAssetPath): DecoderWASMSource {
    return { kind: 'url', url: resolveEngineAssetURL(path) };
}

/** Downloads a decoder binary as bytes when a loader is given, or names its URL for the worker to fetch. */
export async function loadDecoderWASMSource(
    url: string,
    loadBytes: ((url: string) => Promise<ArrayBuffer>) | null | undefined
): Promise<DecoderWASMSource> {
    if (!loadBytes) {
        return { kind: 'url', url };
    }
    return { bytes: await loadBytes(url), kind: 'bytes' };
}

/**
 * Builds the module settings for a source.
 * The glue always gets locateFile, because bundled into a worker it cannot resolve its own URL.
 */
export function getEmscriptenWASMOptions(source: DecoderWASMSource): EmscriptenWASMOptions {
    switch (source.kind) {
        case 'url':
            return { locateFile: (): string => source.url };
        case 'bytes':
            // The glue instantiates wasmBinary and never fetches the path it locates
            return {
                locateFile: (path: string): string => path,
                wasmBinary: source.bytes
            };
    }
}

/** The transfer list that moves a source's bytes to a worker instead of copying them. */
export function getDecoderWASMTransfer(source: DecoderWASMSource): Transferable[] {
    return source.kind === 'bytes' ? [ source.bytes ] : [];
}

/** Validates a source that crossed a worker boundary: an HTTP(S) URL without credentials, or bounded bytes. */
export function isDecoderWASMSource(value: unknown): value is DecoderWASMSource {
    if (!isRecord(value)) {
        return false;
    }
    switch (value.kind) {
        case 'url':
            return isDecoderWASMURL(value.url);
        case 'bytes':
            return value.bytes instanceof ArrayBuffer
                && value.bytes.byteLength > 0
                && value.bytes.byteLength <= MAXIMUM_DECODER_WASM_BYTE_LENGTH;
        default:
            return false;
    }
}

/**
 * Returns a loader that instantiates one module per worker, when a decoder first needs it.
 * The first call's source wins, and a failed load is forgotten so that a later call retries it.
 */
export function createEmscriptenModuleLoader<ModuleType>(
    importFactory: () => Promise<EmscriptenModuleFactory<ModuleType>>,
    wasmAssetPath: EngineAssetPath
): EmscriptenModuleLoader<ModuleType> {
    let modulePromise: Promise<ModuleType> | null = null;
    return (source?: DecoderWASMSource): Promise<ModuleType> => {
        modulePromise ??= importFactory()
            .then(async factory => factory(getEmscriptenWASMOptions(
                source ?? createDecoderWASMURLSource(wasmAssetPath)
            )))
            .catch((error: unknown) => {
                modulePromise = null;
                throw error;
            });
        return modulePromise;
    };
}
