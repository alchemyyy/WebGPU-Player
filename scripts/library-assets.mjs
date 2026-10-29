// Every file the engine serves under libraries/, mapped to its source.
// src/EngineAssets.ts names the runtime subset, and test/EngineAssets.test.ts keeps the two in agreement.
// Decoder packages are not among them: a host hands the engine the packages it loads.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
    CODEC_VECTOR_ASSETS_DIRECTORY,
    ENGINE_ROOT,
    SOURCE_DIRECTORY,
    WASM_DIRECTORY,
    WASM_OUTPUT_DIRECTORY
} from '../tools/constants.mjs';

const WORKER_ENTRY_POINTS = Object.freeze([
    [ 'webgpu-player/CustomAudioDecode.worker.js', join(SOURCE_DIRECTORY, 'pipeline', 'CustomAudioDecode.worker.ts') ],
    [ 'webgpu-player/CustomDecode.worker.js', join(SOURCE_DIRECTORY, 'pipeline', 'CustomDecode.worker.ts') ],
    [ 'webgpu-player/GPUDecoderCoordinator.worker.js', join(SOURCE_DIRECTORY, 'decode', 'video', 'gpu', 'GPUDecoderCoordinator.worker.ts') ],
    [ 'webgpu-player/GPUDecoderParse.worker.js', join(SOURCE_DIRECTORY, 'decode', 'video', 'gpu', 'GPUDecoderParse.worker.ts') ]
]);

/** Worker bundles, as destination relative to libraries/ mapped to the esbuild entry point. */
export function getWorkerEntryPoints() {
    return WORKER_ENTRY_POINTS;
}

/** Copied files, as destination relative to libraries/ mapped to the source file. */
export function getLibraryAssets() {
    const licenseEngine = join(ENGINE_ROOT, 'LICENSE');
    const assets = [
        [ 'libdovi/dovi-rpu-parser.wasm', join(WASM_OUTPUT_DIRECTORY, 'libdovi', 'dovi-rpu-parser.wasm') ],
        [ 'libdovi/LICENSE.txt', join(WASM_DIRECTORY, 'libdovi', 'LICENSE.libdovi.txt') ],
        // The decoded audio output stage is the engine's own code, served under the engine's license
        [ 'audio-output-stage/audio-output-stage.wasm', join(WASM_OUTPUT_DIRECTORY, 'audio-output-stage', 'audio-output-stage.wasm') ],
        [ 'audio-output-stage/LICENSE.txt', licenseEngine ]
    ];

    // The native decoders' range extension qualification streams
    const rangeExtensionDirectory = join(CODEC_VECTOR_ASSETS_DIRECTORY, 'hevc-range-extension');
    for (const fileName of readdirSync(rangeExtensionDirectory).filter(name => name.endsWith('.hevc'))) {
        assets.push([
            `webgpu-player/hevc-rext/${fileName.replace(/\.hevc$/u, '.bin')}`,
            join(rangeExtensionDirectory, fileName)
        ]);
    }

    // The raw AV1 qualification streams of the formats outside Main 10
    const av1RawFormatDirectory = join(CODEC_VECTOR_ASSETS_DIRECTORY, 'av1-raw-format');
    for (const fileName of readdirSync(av1RawFormatDirectory).filter(name => name.endsWith('.obu'))) {
        assets.push([
            `webgpu-player/av1-raw/${fileName.replace(/\.obu$/u, '.bin')}`,
            join(av1RawFormatDirectory, fileName)
        ]);
    }

    // The raw H.264 qualification streams of the formats outside 8-bit 4:2:0
    const h264RawFormatDirectory = join(CODEC_VECTOR_ASSETS_DIRECTORY, 'h264-raw-format');
    for (const fileName of readdirSync(h264RawFormatDirectory).filter(name => name.endsWith('.h264'))) {
        assets.push([
            `webgpu-player/h264-raw/${fileName.replace(/\.h264$/u, '.bin')}`,
            join(h264RawFormatDirectory, fileName)
        ]);
    }
    return assets;
}
