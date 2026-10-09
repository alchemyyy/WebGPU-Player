// The engine's repository layout as absolute paths.
// constants.json is the only place that names these paths; tools, build scripts, the ESLint config, and hosts read them from here instead of spelling them out

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIRECTORY = dirname(fileURLToPath(import.meta.url));

/** The layout from constants.json, as POSIX paths relative to the engine root. */
export const LAYOUT = Object.freeze(JSON.parse(readFileSync(join(TOOLS_DIRECTORY, 'constants.json'), 'utf8')));

export const ENGINE_ROOT = resolve(TOOLS_DIRECTORY, '..');
export const SOURCE_DIRECTORY = join(ENGINE_ROOT, LAYOUT.sourceDirectory);
export const VECTORS_DIRECTORY = join(ENGINE_ROOT, LAYOUT.vectorsDirectory);
export const QUALIFICATION_VECTORS_DIRECTORY = join(ENGINE_ROOT, LAYOUT.qualificationVectorsDirectory);
export const TEST_VECTORS_DIRECTORY = join(ENGINE_ROOT, LAYOUT.testVectorsDirectory);
export const TEST_DIRECTORY = join(ENGINE_ROOT, LAYOUT.testDirectory);
export const SCRIPTS_DIRECTORY = join(ENGINE_ROOT, LAYOUT.scriptsDirectory);
export const CODEC_VECTOR_SCRIPTS_DIRECTORY = join(ENGINE_ROOT, LAYOUT.codecVectorScriptsDirectory);
export const WASM_DIRECTORY = join(ENGINE_ROOT, LAYOUT.wasmDirectory);
export const WASM_LICENSES_DIRECTORY = join(ENGINE_ROOT, LAYOUT.wasmLicensesDirectory);
export const OUTPUT_DIRECTORY = join(ENGINE_ROOT, LAYOUT.outputDirectory);
export const WASM_OUTPUT_DIRECTORY = join(ENGINE_ROOT, LAYOUT.wasmOutputDirectory);
export const LIBRARY_OUTPUT_DIRECTORY = join(ENGINE_ROOT, LAYOUT.libraryOutputDirectory);
export const CODEC_VECTOR_ASSETS_DIRECTORY = join(ENGINE_ROOT, LAYOUT.codecVectorAssetsDirectory);
export const PLAYBACK_SMOKE_MEDIA_DIRECTORY = join(ENGINE_ROOT, LAYOUT.playbackSmokeMediaDirectory);
export const BUILD_INFO_FILE = join(ENGINE_ROOT, LAYOUT.buildInfoFile);
export const DOCUMENTATION_DIRECTORY = join(ENGINE_ROOT, LAYOUT.documentationDirectory);
export const DOCUMENTATION_OUTPUT_DIRECTORY = join(ENGINE_ROOT, LAYOUT.documentationOutputDirectory);
export const DOCUMENTATION_DIAGRAMS_DIRECTORY = join(ENGINE_ROOT, LAYOUT.documentationDiagramsDirectory);
export const DOCUMENTATION_DIAGRAM_OUTPUT_DIRECTORY = join(ENGINE_ROOT, LAYOUT.documentationDiagramOutputDirectory);
export const DOCUMENTATION_THEME_DIRECTORY = join(ENGINE_ROOT, LAYOUT.documentationThemeDirectory);
export const IMAGES_DIRECTORY = join(ENGINE_ROOT, LAYOUT.imagesDirectory);
export const PLANTUML_OUTPUT_DIRECTORY = join(ENGINE_ROOT, LAYOUT.plantUMLOutputDirectory);
export const VENDOR_DIRECTORY = join(ENGINE_ROOT, LAYOUT.vendorDirectory);
export const FFMPEG_SOURCE_DIRECTORY = join(ENGINE_ROOT, LAYOUT.ffmpegSourceDirectory);
export const DCADEC_SOURCE_DIRECTORY = join(ENGINE_ROOT, LAYOUT.dcadecSourceDirectory);
