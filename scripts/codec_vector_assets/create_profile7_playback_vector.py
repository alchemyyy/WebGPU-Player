#!/usr/bin/env python3
"""Create a 1080p dual-track Dolby Vision Profile 7 MP4 for playback smoke tests."""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
import tempfile
from dataclasses import dataclass
from typing import Final, Sequence

from create_dual_track_dolby_vision_MP4_vector import (
    DualTrackVectorConfiguration,
    VectorError,
    create_dual_track_dolby_vision_MP4_vector,
)
from media_tools import (
    ToolError,
    execute_tool,
    refers_to_same_file,
    resolve_FFmpeg_tool,
    resolve_MKVToolNix_tool,
)


MAXIMUM_SOURCE_VECTOR_BYTE_LENGTH: Final = 128 * 1_024 * 1_024
OUTPUT_FRAME_RATE: Final = "6000/1001"
SOURCE_LOOP_COUNT: Final = 9
TIMESTAMP_FILTER: Final = "setts=pts=N*1001:dts=N*1001:duration=1001:time_base=1/6000"
X265_PARAMETERS: Final = "repeat-headers=1:aud=1:bframes=0:keyint=24:min-keyint=24:scenecut=0"


class PlaybackVectorError(RuntimeError):
    """Reports a playback vector request that cannot be carried out."""


@dataclass(frozen=True)
class PlaybackVectorConfiguration:
    """Names the separate-track source, the MP4 output, and optional tool locations."""

    input_path: str
    output_path: str
    configured_FFmpeg_path: str | None = None
    MKVToolNix_directory: str | None = None


def create_structural_FFmpeg_arguments(input_path: str, output_path: str) -> list[str]:
    """Returns the FFmpeg arguments that re-encode the BL at 1080p and copy the EL."""

    return [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-stream_loop", str(SOURCE_LOOP_COUNT),
        "-i", input_path,
        "-map", "0:v:0",
        "-map", "0:v:1",
        "-filter:v:0", "scale=1920:1080:flags=lanczos",
        "-c:v:0", "libx265",
        "-preset:v:0", "ultrafast",
        "-crf:v:0", "30",
        "-pix_fmt:v:0", "yuv420p10le",
        "-x265-params:v:0", X265_PARAMETERS,
        "-fps_mode:v:0", "passthrough",
        "-c:v:1", "copy",
        "-fps_mode:v:1", "passthrough",
        "-bsf:v:0", TIMESTAMP_FILTER,
        "-bsf:v:1", TIMESTAMP_FILTER,
        "-color_primaries:v:0", "bt2020",
        "-color_trc:v:0", "smpte2084",
        "-colorspace:v:0", "bt2020nc",
        "-color_range:v:0", "tv",
        "-disposition:v:0", "default",
        "-disposition:v:1", "0",
        "-map_metadata", "-1",
        output_path,
    ]


def create_structural_MKV_merge_arguments(input_path: str, output_path: str) -> list[str]:
    """Returns the mkvmerge arguments that give both tracks one deterministic default duration."""

    return [
        "--quiet",
        "--output", output_path,
        "--deterministic", "webgpu-profile7-playback",
        "--no-date",
        "--disable-track-statistics-tags",
        "--default-duration", f"0:{OUTPUT_FRAME_RATE}p",
        "--default-duration", f"1:{OUTPUT_FRAME_RATE}p",
        input_path,
    ]


def create_argument_parser() -> argparse.ArgumentParser:
    """Creates the playback vector CLI."""

    parser = argparse.ArgumentParser(
        prog="python scripts/codec_vector_assets/create_profile7_playback_vector.py",
        description=(
            "Creates a validation-only 1080p Profile 7 dual-track MP4 for complete "
            "Jellyfin playback smoke tests. The BL is scaled to 1080p and re-encoded, "
            "so it is not a color-fidelity reference; the EL is copied at its source "
            "size. The summary reports both sizes. The input should be produced by "
            "create_separate_track_dolby_vision_vector.py."
        ),
        allow_abbrev=False,
    )
    parser.add_argument("input_path", metavar="separate-profile7.mkv")
    parser.add_argument("output_path", metavar="output.mp4")
    parser.add_argument(
        "--ffmpeg",
        metavar="path",
        help="FFmpeg executable; defaults to ffmpeg on PATH",
    )
    parser.add_argument(
        "--mkvtoolnix-directory",
        dest="MKVToolNix_directory",
        metavar="path",
        help=(
            "Directory containing mkvmerge; defaults to MKVToolNix under "
            "%%ProgramFiles%% on Windows, then PATH"
        ),
    )
    return parser


def parse_arguments(command_arguments: Sequence[str] | None) -> PlaybackVectorConfiguration:
    """Parses the CLI into one validated playback vector configuration."""

    arguments = create_argument_parser().parse_args(command_arguments)
    if arguments.ffmpeg == "":
        raise PlaybackVectorError("--ffmpeg requires a path")
    if arguments.MKVToolNix_directory == "":
        raise PlaybackVectorError("--mkvtoolnix-directory requires a path")
    input_path = os.path.abspath(arguments.input_path)
    output_path = os.path.abspath(arguments.output_path)
    if refers_to_same_file(input_path, output_path):
        raise PlaybackVectorError("The output path must differ from the input path")
    return PlaybackVectorConfiguration(
        input_path=input_path,
        output_path=output_path,
        configured_FFmpeg_path=os.path.abspath(arguments.ffmpeg) if arguments.ffmpeg else None,
        MKVToolNix_directory=(
            os.path.abspath(arguments.MKVToolNix_directory)
            if arguments.MKVToolNix_directory
            else None
        ),
    )


def create_playback_vector(configuration: PlaybackVectorConfiguration) -> dict[str, object]:
    """Re-encodes the BL, normalizes both tracks, and writes the patched dual-track MP4."""

    source_status = os.stat(configuration.input_path)
    if (
        not stat.S_ISREG(source_status.st_mode)
        or source_status.st_size > MAXIMUM_SOURCE_VECTOR_BYTE_LENGTH
    ):
        raise PlaybackVectorError("The source vector size is unsupported")
    FFmpeg_path = resolve_FFmpeg_tool("ffmpeg", configuration.configured_FFmpeg_path)
    MKV_merge_path = resolve_MKVToolNix_tool("mkvmerge", configuration.MKVToolNix_directory)
    with tempfile.TemporaryDirectory(prefix="webgpu-dovi-playback-") as temporary_directory:
        encoded_path = os.path.join(temporary_directory, "encoded.mkv")
        normalized_path = os.path.join(temporary_directory, "normalized.mkv")
        execute_tool(
            FFmpeg_path,
            create_structural_FFmpeg_arguments(configuration.input_path, encoded_path),
        )
        execute_tool(
            MKV_merge_path,
            create_structural_MKV_merge_arguments(encoded_path, normalized_path),
        )
        result = create_dual_track_dolby_vision_MP4_vector(
            DualTrackVectorConfiguration(
                input_path=normalized_path,
                output_path=configuration.output_path,
                configured_FFmpeg_path=configuration.configured_FFmpeg_path,
            )
        )
        # The summary already holds both layers' sizes as written: the scaled BL, and the EL as the source had it
        return {**result, "colorFidelityReference": False}


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Runs the CLI and prints the JSON summary of the written vector."""

    try:
        configuration = parse_arguments(command_arguments)
        summary = create_playback_vector(configuration)
    # The dual-track step reports its own VectorError
    except (PlaybackVectorError, VectorError, ToolError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
