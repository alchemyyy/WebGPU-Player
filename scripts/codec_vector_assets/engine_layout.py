"""The engine's layout for the codec vector asset scripts.

tools/constants.py reads tools/constants.json, the one place that names the
engine's folders. This module puts tools/ on the import path and re-exports the
names these scripts use, so each script imports its paths from here.
"""

import sys
from pathlib import Path
from typing import Final

TOOLS_DIRECTORY: Final = Path(__file__).resolve().parents[2] / "tools"
if str(TOOLS_DIRECTORY) not in sys.path:
    sys.path.append(str(TOOLS_DIRECTORY))

from constants import (  # noqa: E402
    CODEC_VECTOR_ASSETS_DIRECTORY,
    CODEC_VECTOR_SCRIPTS_DIRECTORY,
    ENGINE_ROOT,
    PLAYBACK_SMOKE_MEDIA_DIRECTORY,
    TEST_VECTORS_DIRECTORY,
    layout_path,
    typescript_import_path,
)

__all__ = [
    "CODEC_VECTOR_ASSETS_DIRECTORY",
    "CODEC_VECTOR_SCRIPTS_DIRECTORY",
    "ENGINE_ROOT",
    "PLAYBACK_SMOKE_MEDIA_DIRECTORY",
    "TEST_VECTORS_DIRECTORY",
    "layout_path",
    "typescript_import_path",
]
