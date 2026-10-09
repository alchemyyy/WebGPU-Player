#!/usr/bin/env python3
"""Generate the deterministic progressive MPEG-2 qualification vector."""

from __future__ import annotations

import argparse
import pathlib
import shutil
import subprocess
import tempfile

from engine_layout import CODEC_VECTOR_ASSETS_DIRECTORY, ENGINE_ROOT
from generated_output import install_or_check_output


OUTPUT_PATH = CODEC_VECTOR_ASSETS_DIRECTORY / "mpeg2" / "mpeg2-progressive-1920x1080.mkv"


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ffmpeg",
        type=pathlib.Path,
        help="FFmpeg executable; defaults to ffmpeg on PATH. The committed vector was encoded by Jellyfin FFmpeg 8.1.2",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail if the committed vector is missing or differs from the regenerated vector",
    )
    return parser.parse_args()


def resolve_ffmpeg_path(explicit_path: pathlib.Path | None) -> pathlib.Path:
    """Resolves FFmpeg from the explicit flag, otherwise from PATH."""

    if explicit_path is not None:
        resolved_path = explicit_path.expanduser().resolve()
        if not resolved_path.is_file():
            raise FileNotFoundError(f"FFmpeg was not found: {resolved_path}")
        return resolved_path
    path_resolution = shutil.which("ffmpeg")
    if path_resolution is None:
        raise FileNotFoundError("FFmpeg was not found on PATH; pass --ffmpeg")
    return pathlib.Path(path_resolution).resolve()


def generate_vector(ffmpeg_path: pathlib.Path, *, check: bool) -> bool:
    """Encodes the MPEG-2 vector and compares it with the committed bytes.

    Output that differs from the committed vector is never installed, so another FFmpeg build cannot replace it.
    Returns whether a missing vector was written.
    """

    with tempfile.TemporaryDirectory(prefix="webgpu-mpeg2-vector-") as temporary_directory:
        # A failed encode never touches the committed vector
        generated_path = pathlib.Path(temporary_directory) / OUTPUT_PATH.name
        command = [
            str(ffmpeg_path),
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1920x1080:rate=24:duration=0.5",
            "-map_metadata",
            "-1",
            "-fflags",
            "+bitexact",
            "-flags:v",
            "+bitexact",
            "-an",
            "-c:v",
            "mpeg2video",
            "-g",
            "12",
            "-bf",
            "2",
            "-pix_fmt",
            "yuv420p",
            "-q:v",
            "2",
            "-f",
            "matroska",
            "-y",
            str(generated_path),
        ]
        subprocess.run(command, check=True, cwd=ENGINE_ROOT)
        return install_or_check_output(OUTPUT_PATH, generated_path.read_bytes(), check=check)


def main() -> None:
    arguments = parse_arguments()
    installed = generate_vector(resolve_ffmpeg_path(arguments.ffmpeg), check=arguments.check)
    action = "Generated" if installed else "Verified"
    print(f"{action} {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
