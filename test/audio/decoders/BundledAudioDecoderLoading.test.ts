// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    DTS_DECODER_WASM_ASSET,
    EAC3_DECODER_WASM_ASSET,
    TRUEHD_DECODER_WASM_ASSET
} from 'webgpu-player/EngineAssets';

const ASSET_BASE_URL = 'https://example.test/web/libraries/';
const CACHE_KEY = 'build-1';
const PLAYBACK_WORKER_URL = `${ASSET_BASE_URL}webgpu-player/CustomDecode.worker.js?v=${CACHE_KEY}`;

// Records every binary a decoder kit's glue locates, which is where it would fetch and instantiate one
const { createFakeGlue, locatedBinaries } = vi.hoisted(() => {
    const binaries: string[] = [];
    return {
        createFakeGlue: (binaryName: string) => ({
            default: (options: { locateFile: (path: string) => string }): Promise<object> => {
                binaries.push(options.locateFile(binaryName));
                return Promise.resolve({});
            }
        }),
        locatedBinaries: binaries
    };
});

vi.mock('#wasm/libdcadec-dts/libdcadec-dts.mjs', () => createFakeGlue('libdcadec-dts.wasm'));
vi.mock('#wasm/ffmpeg-eac3/ffmpeg-eac3.mjs', () => createFakeGlue('ffmpeg-eac3.wasm'));
vi.mock('#wasm/ffmpeg-truehd/ffmpeg-truehd.mjs', () => createFakeGlue('ffmpeg-truehd.wasm'));

function getServedURL(path: string): string {
    return `${ASSET_BASE_URL}${path}?v=${CACHE_KEY}`;
}

beforeEach(() => {
    vi.resetModules();
    locatedBinaries.length = 0;
    // The playback worker's scope, which resolves assets from its own URL
    vi.stubGlobal('self', new EventTarget());
    vi.stubGlobal('location', { href: PLAYBACK_WORKER_URL });
    vi.stubGlobal('importScripts', () => undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('bundled audio decoder loading in the playback worker', () => {
    it('starts without loading any audio decoder binary', async () => {
        await import('webgpu-player/pipeline/CustomDecode.worker');
        // An eager load would have imported its glue by now
        await vi.dynamicImportSettled();

        expect(locatedBinaries).toEqual([]);
    });

    it('loads only the binary of the codec a session decodes', async () => {
        const { loadDTSDecoderModule } = await import('webgpu-player/audio/decoders/DTSSoftwareAudioDecoder');
        await import('webgpu-player/audio/decoders/EAC3SoftwareAudioDecoder');
        await import('webgpu-player/audio/decoders/TrueHDSoftwareAudioDecoder');

        await loadDTSDecoderModule();

        expect(locatedBinaries).toEqual([ getServedURL(DTS_DECODER_WASM_ASSET) ]);
    });

    it('locates each served binary under the worker cache key', async () => {
        const { loadEAC3DecoderModule } = await import('webgpu-player/audio/decoders/EAC3SoftwareAudioDecoder');
        const { loadTrueHDDecoderModule } = await import('webgpu-player/audio/decoders/TrueHDSoftwareAudioDecoder');

        await loadEAC3DecoderModule();
        await loadTrueHDDecoderModule();

        expect(locatedBinaries).toEqual([
            getServedURL(EAC3_DECODER_WASM_ASSET),
            getServedURL(TRUEHD_DECODER_WASM_ASSET)
        ]);
    });
});
