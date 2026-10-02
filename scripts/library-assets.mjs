// Every file the engine serves under libraries/, mapped to its source.
// src/EngineAssets.ts names the runtime subset, and test/EngineAssets.test.ts keeps the two in agreement.

import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromEngine = createRequire(join(ENGINE_ROOT, 'package.json'));

// Optional per-decoder source notices written by the codec build
const SOURCE_NOTICE_KITS = [ 'ffmpeg-eac3', 'ffmpeg-truehd', 'libdcadec', 'legacy-video' ];

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

function engineFile(relativePath) {
    return join(ENGINE_ROOT, relativePath);
}

/** Worker bundles, as destination relative to libraries/ mapped to the esbuild entry point. */
export const WORKER_ENTRY_POINTS = Object.freeze([
    [ 'webgpu-player/CustomDecode.worker.js', engineFile('src/custom/CustomDecode.worker.ts') ],
    [ 'webgpu-player/DTSExactCapabilityProbe.worker.js', engineFile('src/custom/DTSExactCapabilityProbe.worker.ts') ],
    [ 'webgpu-player/HEVCExactCapabilityProbe.worker.js', engineFile('src/custom/HEVCExactCapabilityProbe.worker.ts') ],
    [
        'webgpu-player/JPEG2000ExactCapabilityProbe.worker.js',
        engineFile('src/custom/JPEG2000ExactCapabilityProbe.worker.ts')
    ],
    [
        'webgpu-player/LegacyVideoExactCapabilityProbe.worker.js',
        engineFile('src/custom/LegacyVideoExactCapabilityProbe.worker.ts')
    ],
    [
        'webgpu-player/TrueHDExactCapabilityProbe.worker.js',
        engineFile('src/custom/TrueHDExactCapabilityProbe.worker.ts')
    ]
]);

/** Copied files, as destination relative to libraries/ mapped to the source file. */
export function getLibraryAssets() {
    const licenseFFmpeg = engineFile('codecs/licenses/FFmpeg-COPYING.LGPLv2.1');
    const licenseEngine = engineFile('LICENSE');
    const assets = [
        [ 'hevcjs/hevc-decode.js', packageFile('@hevcjs/core', 'dist/wasm/hevc-decode.js') ],
        [ 'hevcjs/hevc-decode.wasm', packageFile('@hevcjs/core', 'dist/wasm/hevc-decode.wasm') ],
        [ 'hevcjs/LICENSE.txt', packageFile('@hevcjs/core', 'LICENSE') ],
        [ 'hevcjs/main10-4k-qualification.bin', engineFile('fixtures/capability/hevc/main10-4k-complex.hevc') ],
        [ 'libdovi/dovi-rpu-parser.wasm', engineFile('codecs/dist/libdovi/dovi-rpu-parser.wasm') ],
        [ 'libdovi/LICENSE.txt', engineFile('codecs/libdovi/LICENSE.libdovi.txt') ],
        [ 'mediabunny-ac3/LICENSE.txt', packageFile('@mediabunny/ac3', 'LICENSE') ],
        [ 'ffmpeg-eac3/COPYING.LGPLv2.1', licenseFFmpeg ],
        [ 'ffmpeg-eac3/ffmpeg_eac3_bridge.c', engineFile('codecs/ffmpeg-eac3/ffmpeg_eac3_bridge.c') ],
        [ 'ffmpeg-eac3/LICENSE.bridge.txt', licenseEngine ],
        [ 'ffmpeg-truehd/COPYING.LGPLv2.1', licenseFFmpeg ],
        [ 'ffmpeg-truehd/ffmpeg_truehd_bridge.c', engineFile('codecs/ffmpeg-truehd/ffmpeg_truehd_bridge.c') ],
        [ 'ffmpeg-truehd/LICENSE.bridge.txt', licenseEngine ],
        [ 'libdcadec/COPYING.LGPLv2.1', engineFile('codecs/licenses/libdcadec-COPYING.LGPLv2.1') ],
        [ 'libdcadec/libdcadec_bridge.c', engineFile('codecs/libdcadec/libdcadec_bridge.c') ],
        [ 'libdcadec/LICENSE.bridge.txt', licenseEngine ],
        [ 'legacy-video/legacy-video-decode.js', engineFile('codecs/dist/legacy-video/legacy-video-decode.js') ],
        [ 'legacy-video/legacy-video-decode.wasm', engineFile('codecs/dist/legacy-video/legacy-video-decode.wasm') ],
        [ 'legacy-video/LICENSE.ffmpeg.txt', licenseFFmpeg ],
        [ 'legacy-video/bridge.c', engineFile('codecs/legacy-video/bridge.c') ],
        [ 'legacy-video/LICENSE.bridge.txt', licenseEngine ],
        [
            'legacy-video/mpeg2-progressive-1920x1080-qualification.bin',
            engineFile('fixtures/capability/legacy-video/mpeg2-progressive-1920x1080.mkv')
        ],
        [
            'legacy-video/vc1-advanced-progressive-1920x1080-qualification.bin',
            engineFile('fixtures/capability/legacy-video/vc1-advanced-progressive-1920x1080.mkv')
        ],
        [ 'openjpeg/openjpeg-decode.js', packageFile('@cornerstonejs/codec-openjpeg', 'dist/openjpegwasm_decode.js') ],
        [
            'openjpeg/openjpeg-decode.wasm',
            packageFile('@cornerstonejs/codec-openjpeg', 'dist/openjpegwasm_decode.wasm')
        ],
        [ 'openjpeg/LICENSE.wrapper.txt', packageFile('@cornerstonejs/codec-openjpeg', 'LICENSE') ],
        [ 'openjpeg/LICENSE.openjpeg.txt', engineFile('codecs/licenses/LICENSE.openjpeg.txt') ],
        [ 'openjpeg/jpeg2000-960x540-qualification.bin', engineFile('fixtures/capability/jpeg2000/srgb-960x540.jp2') ]
    ];

    const rangeExtensionDirectory = engineFile('fixtures/capability/hevc-range-extension');
    for (const fileName of readdirSync(rangeExtensionDirectory).filter(name => name.endsWith('.hevc'))) {
        assets.push([
            `webgpu-player/hevc-rext/${fileName.replace(/\.hevc$/u, '.bin')}`,
            join(rangeExtensionDirectory, fileName)
        ]);
    }

    for (const kit of SOURCE_NOTICE_KITS) {
        const notice = engineFile(`codecs/${kit}/SOURCE.txt`);
        if (existsSync(notice)) {
            assets.push([ `${kit}/SOURCE.txt`, notice ]);
        }
    }
    return assets;
}
