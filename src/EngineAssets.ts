// Every file the engine fetches at runtime, named by its path under the engine asset base.
// Hosts serve the engine's bin/libraries directory at that base, which defaults to libraries/ beside the page.

/** Prebuilt engine workers. They live one directory below the asset base. */
export const ENGINE_WORKER_PATHS = Object.freeze([
    'webgpu-player/CustomAudioDecode.worker.js',
    'webgpu-player/CustomDecode.worker.js',
    'webgpu-player/DTSExactCapabilityProbe.worker.js',
    'webgpu-player/HEVCExactCapabilityProbe.worker.js',
    'webgpu-player/JPEG2000ExactCapabilityProbe.worker.js',
    'webgpu-player/MPEG2VC1ExactCapabilityProbe.worker.js',
    'webgpu-player/TrueHDExactCapabilityProbe.worker.js'
] as const);

/** Decoders, the audio output stage, and qualification streams, relative to the asset base. */
export const ENGINE_LIBRARY_PATHS = Object.freeze([
    'audio-output-stage/audio-output-stage.wasm',
    'ffmpeg-eac3/ffmpeg-eac3.wasm',
    'ffmpeg-hevc/ffmpeg-hevc.js',
    'ffmpeg-hevc/ffmpeg-hevc.wasm',
    'ffmpeg-hevc/main10-4k-qualification.bin',
    'ffmpeg-mpeg2-vc1/ffmpeg-mpeg2-vc1.js',
    'ffmpeg-mpeg2-vc1/ffmpeg-mpeg2-vc1.wasm',
    'ffmpeg-mpeg2-vc1/mpeg2-progressive-1920x1080-qualification.bin',
    'ffmpeg-mpeg2-vc1/vc1-advanced-progressive-1920x1080-qualification.bin',
    'ffmpeg-truehd/ffmpeg-truehd.wasm',
    'libdcadec-dts/libdcadec-dts.wasm',
    'libdovi/dovi-rpu-parser.wasm',
    'openjpeg/jpeg2000-960x540-qualification.bin',
    'openjpeg/openjpeg-decode.js',
    'openjpeg/openjpeg-decode.wasm',
    'webgpu-player/hevc-rext/main12-420.bin',
    'webgpu-player/hevc-rext/main422-10.bin',
    'webgpu-player/hevc-rext/main422-12.bin',
    'webgpu-player/hevc-rext/main422-8.bin',
    'webgpu-player/hevc-rext/main444-10.bin',
    'webgpu-player/hevc-rext/main444-12.bin',
    'webgpu-player/hevc-rext/main444-8.bin',
    'webgpu-player/hevc-rext/rext420-10.bin',
    'webgpu-player/hevc-rext/rext420-8.bin'
] as const);

export type EngineWorkerPath = typeof ENGINE_WORKER_PATHS[number];
export type EngineLibraryPath = typeof ENGINE_LIBRARY_PATHS[number];
export type EngineAssetPath = EngineWorkerPath | EngineLibraryPath;

// The bundled audio decoders' binaries; a probe worker and the playback worker resolve one URL, so the browser caches each once
export const DTS_DECODER_WASM_ASSET = 'libdcadec-dts/libdcadec-dts.wasm' satisfies EngineLibraryPath;
export const EAC3_DECODER_WASM_ASSET = 'ffmpeg-eac3/ffmpeg-eac3.wasm' satisfies EngineLibraryPath;
export const TRUEHD_DECODER_WASM_ASSET = 'ffmpeg-truehd/ffmpeg-truehd.wasm' satisfies EngineLibraryPath;
// The decoded audio output stage's resampler and limiter kernels, which the playback worker loads on its first decoded audio attempt
export const AUDIO_OUTPUT_STAGE_WASM_ASSET = 'audio-output-stage/audio-output-stage.wasm' satisfies EngineLibraryPath;

export type EngineAssetConfiguration = Readonly<{
    // Absolute or page-relative URL of the served bin/libraries directory
    baseURL?: string
    // Appended as a query parameter so a new build never reuses stale cached workers or decoders
    cacheKey?: string
}>;

type AssetResolutionScope = {
    importScripts?: unknown
    location?: { href?: unknown }
};

const DEFAULT_ASSET_BASE = 'libraries/';
// Workers sit in <asset base>/webgpu-player/
const WORKER_TO_ASSET_BASE = '../';
const CACHE_KEY_PARAMETER = 'v';

let assetConfiguration: EngineAssetConfiguration = {};

/** Sets where the host serves the engine assets. Call it before the engine starts any worker. */
export function configureEngineAssets(configuration: EngineAssetConfiguration): void {
    assetConfiguration = configuration;
}

function addCacheKey(url: URL, cacheKey: string | null | undefined): string {
    if (cacheKey) {
        url.searchParams.set(CACHE_KEY_PARAMETER, cacheKey);
    }
    return url.href;
}

/**
 * Resolves an engine asset to an absolute URL.
 * Inside a worker, the asset base and cache key come from the worker's own URL.
 * Without any location, as in Node tests, the path is returned unchanged.
 */
export function resolveEngineAssetURL(path: EngineAssetPath): string {
    const scope = globalThis as AssetResolutionScope;
    const locationHref = scope.location?.href;
    if (typeof locationHref !== 'string' || locationHref.length === 0) {
        return path;
    }
    if (typeof scope.importScripts === 'function') {
        const workerURL = new URL(locationHref);
        const assetBaseURL = new URL(WORKER_TO_ASSET_BASE, workerURL);
        return addCacheKey(new URL(path, assetBaseURL), workerURL.searchParams.get(CACHE_KEY_PARAMETER));
    }
    const configuredBase = assetConfiguration.baseURL ?? DEFAULT_ASSET_BASE;
    const assetBaseURL = new URL(configuredBase.endsWith('/') ? configuredBase : `${configuredBase}/`, locationHref);
    return addCacheKey(new URL(path, assetBaseURL), assetConfiguration.cacheKey);
}

export function createEngineWorker(path: EngineWorkerPath): Worker {
    return new Worker(resolveEngineAssetURL(path));
}
