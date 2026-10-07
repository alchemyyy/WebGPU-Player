// Every file the engine serves under libraries/, mapped to its source.
// src/EngineAssets.ts names the runtime subset, and test/EngineAssets.test.ts keeps the two in agreement.

import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import {
    CODEC_VECTOR_ASSETS_DIRECTORY,
    ENGINE_ROOT,
    QUALIFICATION_VECTORS_DIRECTORY,
    SOURCE_DIRECTORY,
    WASM_DIRECTORY,
    WASM_LICENSES_DIRECTORY,
    WASM_OUTPUT_DIRECTORY
} from '../tools/constants.mjs';

const requireFromEngine = createRequire(join(ENGINE_ROOT, 'package.json'));
const EXACT_CAPABILITY_DIRECTORY = join(SOURCE_DIRECTORY, 'capability', 'exact');

/** Resolves a file inside an npm package, wherever the package manager installed it. */
function packageFile(packageName, relativePath) {
    // Package exports can hide package.json, so search the node_modules lookup path directly
    for (const nodeModulesDirectory of requireFromEngine.resolve.paths(packageName) ?? []) {
        const packageDirectory = join(nodeModulesDirectory, packageName);
        if (existsSync(join(packageDirectory, 'package.json'))) {
            return join(packageDirectory, relativePath);
        }
    }
    throw new Error(`Package ${packageName} is not installed for the engine`);
}

const WORKER_ENTRY_POINTS = Object.freeze([
    [ 'webgpu-player/CustomDecode.worker.js', join(SOURCE_DIRECTORY, 'pipeline', 'CustomDecode.worker.ts') ],
    [ 'webgpu-player/DTSExactCapabilityProbe.worker.js', join(EXACT_CAPABILITY_DIRECTORY, 'DTSExactCapabilityProbe.worker.ts') ],
    [ 'webgpu-player/HEVCExactCapabilityProbe.worker.js', join(EXACT_CAPABILITY_DIRECTORY, 'HEVCExactCapabilityProbe.worker.ts') ],
    [
        'webgpu-player/JPEG2000ExactCapabilityProbe.worker.js',
        join(EXACT_CAPABILITY_DIRECTORY, 'JPEG2000ExactCapabilityProbe.worker.ts')
    ],
    [
        'webgpu-player/MPEG2VC1ExactCapabilityProbe.worker.js',
        join(EXACT_CAPABILITY_DIRECTORY, 'MPEG2VC1ExactCapabilityProbe.worker.ts')
    ],
    [
        'webgpu-player/TrueHDExactCapabilityProbe.worker.js',
        join(EXACT_CAPABILITY_DIRECTORY, 'TrueHDExactCapabilityProbe.worker.ts')
    ]
]);

/** Worker bundles, as destination relative to libraries/ mapped to the esbuild entry point. */
export function getWorkerEntryPoints() {
    return WORKER_ENTRY_POINTS;
}

/** Copied files, as destination relative to libraries/ mapped to the source file. */
export function getLibraryAssets() {
    const licenseFFmpeg = join(WASM_LICENSES_DIRECTORY, 'FFmpeg-COPYING.LGPLv2.1');
    const licenseEngine = join(ENGINE_ROOT, 'LICENSE');
    const assets = [
        [ 'hevcjs/hevc-decode.js', packageFile('@hevcjs/core', 'dist/wasm/hevc-decode.js') ],
        [ 'hevcjs/hevc-decode.wasm', packageFile('@hevcjs/core', 'dist/wasm/hevc-decode.wasm') ],
        [ 'hevcjs/LICENSE.txt', packageFile('@hevcjs/core', 'LICENSE') ],
        [ 'hevcjs/main10-4k-qualification.bin', join(QUALIFICATION_VECTORS_DIRECTORY, 'hevc', 'main10-4k-complex.hevc') ],
        [ 'libdovi/dovi-rpu-parser.wasm', join(WASM_OUTPUT_DIRECTORY, 'libdovi', 'dovi-rpu-parser.wasm') ],
        [ 'libdovi/LICENSE.txt', join(WASM_DIRECTORY, 'libdovi', 'LICENSE.libdovi.txt') ],
        [ 'mediabunny-ac3/LICENSE.txt', packageFile('@mediabunny/ac3', 'LICENSE') ],
        [ 'ffmpeg-eac3/COPYING.LGPLv2.1', licenseFFmpeg ],
        [ 'ffmpeg-eac3/ffmpeg_eac3_bridge.c', join(WASM_DIRECTORY, 'ffmpeg-eac3', 'ffmpeg_eac3_bridge.c') ],
        [ 'ffmpeg-eac3/LICENSE.bridge.txt', licenseEngine ],
        [ 'ffmpeg-truehd/COPYING.LGPLv2.1', licenseFFmpeg ],
        [ 'ffmpeg-truehd/ffmpeg_truehd_bridge.c', join(WASM_DIRECTORY, 'ffmpeg-truehd', 'ffmpeg_truehd_bridge.c') ],
        [ 'ffmpeg-truehd/LICENSE.bridge.txt', licenseEngine ],
        [ 'libdcadec-dts/COPYING.LGPLv2.1', join(WASM_LICENSES_DIRECTORY, 'libdcadec-COPYING.LGPLv2.1') ],
        [ 'libdcadec-dts/libdcadec_dts_bridge.c', join(WASM_DIRECTORY, 'libdcadec-dts', 'libdcadec_dts_bridge.c') ],
        [ 'libdcadec-dts/LICENSE.bridge.txt', licenseEngine ],
        [ 'ffmpeg-mpeg2-vc1/ffmpeg-mpeg2-vc1.js', join(WASM_OUTPUT_DIRECTORY, 'ffmpeg-mpeg2-vc1', 'ffmpeg-mpeg2-vc1.js') ],
        [ 'ffmpeg-mpeg2-vc1/ffmpeg-mpeg2-vc1.wasm', join(WASM_OUTPUT_DIRECTORY, 'ffmpeg-mpeg2-vc1', 'ffmpeg-mpeg2-vc1.wasm') ],
        [ 'ffmpeg-mpeg2-vc1/LICENSE.ffmpeg.txt', licenseFFmpeg ],
        [
            'ffmpeg-mpeg2-vc1/ffmpeg_mpeg2_vc1_bridge.c',
            join(WASM_DIRECTORY, 'ffmpeg-mpeg2-vc1', 'ffmpeg_mpeg2_vc1_bridge.c')
        ],
        [ 'ffmpeg-mpeg2-vc1/LICENSE.bridge.txt', licenseEngine ],
        [
            'ffmpeg-mpeg2-vc1/mpeg2-progressive-1920x1080-qualification.bin',
            join(CODEC_VECTOR_ASSETS_DIRECTORY, 'mpeg2', 'mpeg2-progressive-1920x1080.mkv')
        ],
        [
            'ffmpeg-mpeg2-vc1/vc1-advanced-progressive-1920x1080-qualification.bin',
            join(QUALIFICATION_VECTORS_DIRECTORY, 'vc1', 'vc1-advanced-progressive-1920x1080.mkv')
        ],
        [ 'openjpeg/openjpeg-decode.js', packageFile('@cornerstonejs/codec-openjpeg', 'dist/openjpegwasm_decode.js') ],
        [
            'openjpeg/openjpeg-decode.wasm',
            packageFile('@cornerstonejs/codec-openjpeg', 'dist/openjpegwasm_decode.wasm')
        ],
        [ 'openjpeg/LICENSE.wrapper.txt', packageFile('@cornerstonejs/codec-openjpeg', 'LICENSE') ],
        [ 'openjpeg/LICENSE.openjpeg.txt', join(WASM_LICENSES_DIRECTORY, 'LICENSE.openjpeg.txt') ],
        [ 'openjpeg/jpeg2000-960x540-qualification.bin', join(CODEC_VECTOR_ASSETS_DIRECTORY, 'jpeg2000', 'srgb-960x540.jp2') ]
    ];

    const rangeExtensionDirectory = join(CODEC_VECTOR_ASSETS_DIRECTORY, 'hevc-range-extension');
    for (const fileName of readdirSync(rangeExtensionDirectory).filter(name => name.endsWith('.hevc'))) {
        assets.push([
            `webgpu-player/hevc-rext/${fileName.replace(/\.hevc$/u, '.bin')}`,
            join(rangeExtensionDirectory, fileName)
        ]);
    }
    return assets;
}
