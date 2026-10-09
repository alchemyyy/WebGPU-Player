"""The engine's repository layout as absolute paths.

constants.json is the only place that names these paths; the Python tools read them from here instead of spelling them out.
"""

import json
import os
from pathlib import Path
from typing import Final

TOOLS_DIRECTORY: Final = Path(__file__).resolve().parent
ENGINE_ROOT: Final = TOOLS_DIRECTORY.parent

# The layout from constants.json, as POSIX paths relative to the engine root
LAYOUT: Final[dict[str, str]] = json.loads((TOOLS_DIRECTORY / "constants.json").read_text(encoding="utf-8"))

SOURCE_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["sourceDirectory"]
VECTORS_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["vectorsDirectory"]
QUALIFICATION_VECTORS_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["qualificationVectorsDirectory"]
TEST_VECTORS_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["testVectorsDirectory"]
TEST_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["testDirectory"]
SCRIPTS_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["scriptsDirectory"]
CODEC_VECTOR_SCRIPTS_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["codecVectorScriptsDirectory"]
WASM_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["wasmDirectory"]
WASM_LICENSES_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["wasmLicensesDirectory"]
OUTPUT_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["outputDirectory"]
WASM_OUTPUT_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["wasmOutputDirectory"]
LIBRARY_OUTPUT_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["libraryOutputDirectory"]
CODEC_VECTOR_ASSETS_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["codecVectorAssetsDirectory"]
PLAYBACK_SMOKE_MEDIA_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["playbackSmokeMediaDirectory"]
BUILD_INFO_FILE: Final = ENGINE_ROOT / LAYOUT["buildInfoFile"]
DOCUMENTATION_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["documentationDirectory"]
DOCUMENTATION_OUTPUT_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["documentationOutputDirectory"]
VENDOR_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["vendorDirectory"]
FFMPEG_SOURCE_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["ffmpegSourceDirectory"]
DCADEC_SOURCE_DIRECTORY: Final = ENGINE_ROOT / LAYOUT["dcadecSourceDirectory"]


def typescript_import_path(module_from_source: str, importing_directory: Path) -> str:
    """Returns the specifier a TypeScript file in importing_directory uses for a src/ module, given without extension."""
    specifier = Path(os.path.relpath(SOURCE_DIRECTORY / module_from_source, importing_directory)).as_posix()
    return specifier if specifier.startswith(".") else f"./{specifier}"


def layout_path(key: str, *parts: str) -> str:
    """Returns a layout path relative to the engine root, as the POSIX text that generated files cite."""
    return "/".join([LAYOUT[key], *parts])
