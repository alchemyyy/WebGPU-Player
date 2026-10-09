#!/usr/bin/env python3
"""Generate 1080p Dolby Vision Profile 10 AV1 playback media with stereo AAC, in MP4 and in Matroska.

For manual end-to-end tests through a host such as a Jellyfin server.
Git ignores the output, and generate_all_codec_vector_assets.py does not run this script.
Each file is testsrc2 in AV1 Main 10, ten seconds unless --duration-seconds gives 2 through 120, with one Dolby Vision RPU per frame and a stereo AAC tone.
There is one MP4 and one Matroska file per sub-profile: 10.0, 10.1, 10.2, and 10.4.
The encode, RPU insertion, container signaling, and per-file checks are those of generate_dolby_vision_AV1_vectors.py, with threads, tiles, a two-second key frame interval, and the first RPU of the sub-profile's test vector in every frame.
Its pinned-build and FFmpeg metadata parity checks are not run, so any FFmpeg build with libaom works.

The RPUs do not describe these pictures, so a file proves only that the pipeline runs and is no color reference.
A Profile 5 RPU over the non-IPT 10.0 test pattern renders with shifted colors, and the 10.2 file pairs an SDR base with a Profile 8.1 RPU made for a PQ base.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Final, Sequence

from create_dual_track_dolby_vision_MP4_vector import VectorError
from engine_layout import PLAYBACK_SMOKE_MEDIA_DIRECTORY
from generate_dolby_vision_AV1_vectors import (
    FILE_EXTENSION_BY_FORMAT,
    MATROSKA_FORMAT,
    MP4_FORMAT,
    SUB_PROFILES,
    AudioTone,
    AV1EncodeSettings,
    DolbyVisionAV1Build,
    MediaTools,
    SubProfile,
    VectorGenerationError,
    build_dolby_vision_AV1_files,
    read_source_RPU,
)
from generate_playback_smoke_media import format_generated_files
from media_tools import ToolError, resolve_FFmpeg_tool


DEFAULT_OUTPUT_DIRECTORY: Final = PLAYBACK_SMOKE_MEDIA_DIRECTORY
MEDIA_WIDTH: Final = 1920
MEDIA_HEIGHT: Final = 1080
MEDIA_RESOLUTION_NAME: Final = "1080p"
# Frame rates by their names in file names
FRAME_RATES: Final = {
    "23.976": Fraction(24_000, 1_001),
    "24": Fraction(24),
}
DEFAULT_FRAME_RATE_NAME: Final = "23.976"
MINIMUM_DURATION_SECONDS: Final = 2
MAXIMUM_DURATION_SECONDS: Final = 120
DEFAULT_DURATION_SECONDS: Final = 10
KEY_FRAME_INTERVAL_SECONDS: Final = 2
CONSTANT_RATE_FACTOR: Final = 30
# Zero lets libaom pick a thread per core
AUTOMATIC_THREAD_COUNT: Final = 0
TILE_LAYOUT: Final = "2x2"
AUDIO_TONE: Final = AudioTone(bit_rate_kilobits=128, channel_count=2, frequency=440, sample_rate=48_000)
SUB_PROFILES_BY_NAME: Final = {sub_profile.name: sub_profile for sub_profile in SUB_PROFILES}


@dataclass(frozen=True)
class PlaybackMediaSettings:
    """Holds the tools, the output location, and the length and frame rate of every file."""

    duration_seconds: int
    frame_rate_name: str
    output_directory: Path
    overwrite: bool
    tools: MediaTools


def parse_duration_seconds(value: str) -> int:
    """Parses one duration within the supported range."""

    duration_seconds = int(value)
    if duration_seconds < MINIMUM_DURATION_SECONDS or duration_seconds > MAXIMUM_DURATION_SECONDS:
        raise argparse.ArgumentTypeError(f"must be from {MINIMUM_DURATION_SECONDS} through {MAXIMUM_DURATION_SECONDS}")
    return duration_seconds


def create_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ffmpeg", metavar="path", help="FFmpeg executable; defaults to ffmpeg on PATH")
    parser.add_argument("--ffprobe", metavar="path", help="FFprobe executable; defaults to ffprobe on PATH")
    parser.add_argument("--output-directory", default=str(DEFAULT_OUTPUT_DIRECTORY))
    parser.add_argument("--sub-profiles", nargs="+", choices=tuple(SUB_PROFILES_BY_NAME), default=list(SUB_PROFILES_BY_NAME))
    parser.add_argument("--frame-rate", choices=tuple(FRAME_RATES), default=DEFAULT_FRAME_RATE_NAME)
    parser.add_argument("--duration-seconds", type=parse_duration_seconds, default=DEFAULT_DURATION_SECONDS)
    parser.add_argument("--overwrite", action="store_true")
    return parser


def create_media_file_name(sub_profile: SubProfile, frame_rate_name: str, container_format: str) -> str:
    return (
        f"dolby-vision-profile{sub_profile.name}-av1-{MEDIA_RESOLUTION_NAME}{frame_rate_name}-aac."
        f"{FILE_EXTENSION_BY_FORMAT[container_format]}"
    )


def create_encode_settings(duration_seconds: int, frame_rate_name: str) -> AV1EncodeSettings:
    """Returns a multithreaded 1080p encode of the duration, rounded to whole frames."""

    frame_rate = FRAME_RATES[frame_rate_name]
    return AV1EncodeSettings(
        constant_rate_factor=CONSTANT_RATE_FACTOR,
        frame_count=round(duration_seconds * frame_rate),
        frame_rate=frame_rate,
        height=MEDIA_HEIGHT,
        key_frame_interval=round(KEY_FRAME_INTERVAL_SECONDS * frame_rate),
        row_multithreading=True,
        thread_count=AUTOMATIC_THREAD_COUNT,
        tile_layout=TILE_LAYOUT,
        width=MEDIA_WIDTH,
    )


def require_replaceable_output(settings: PlaybackMediaSettings, output_path: Path) -> None:
    """Refuses to replace an existing file unless overwriting was requested."""

    if output_path.exists() and not settings.overwrite:
        raise VectorGenerationError(f"{output_path} already exists; pass --overwrite to replace it")


def create_playback_media(settings: PlaybackMediaSettings, sub_profile: SubProfile) -> list[Path]:
    """Builds, verifies, and writes the MP4 and Matroska files of one sub-profile."""

    output_paths = [
        settings.output_directory / create_media_file_name(sub_profile, settings.frame_rate_name, container_format)
        for container_format in (MP4_FORMAT, MATROSKA_FORMAT)
    ]
    for output_path in output_paths:
        require_replaceable_output(settings, output_path)
    encode_settings = create_encode_settings(settings.duration_seconds, settings.frame_rate_name)
    source_RPU = read_source_RPU(sub_profile.source_RPU_file_names[0])
    with tempfile.TemporaryDirectory(prefix="webgpu-dolby-vision-av1-playback-") as temporary_directory:
        temporary_path = Path(temporary_directory)
        build = DolbyVisionAV1Build(
            audio_tone=AUDIO_TONE,
            encode_settings=encode_settings,
            Matroska_path=temporary_path / output_paths[1].name,
            MP4_path=temporary_path / output_paths[0].name,
            source_RPUs=(source_RPU,) * encode_settings.frame_count,
            sub_profile=sub_profile,
        )
        build_dolby_vision_AV1_files(settings.tools, build, temporary_path)
        # Only verified files reach the output directory
        settings.output_directory.mkdir(parents=True, exist_ok=True)
        for built_path, output_path in zip((build.MP4_path, build.Matroska_path), output_paths, strict=True):
            shutil.copyfile(built_path, output_path)
    return output_paths


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Runs the CLI and prints the generated file table."""

    arguments = create_argument_parser().parse_args(command_arguments)
    generated_paths: list[Path] = []
    try:
        settings = PlaybackMediaSettings(
            duration_seconds=arguments.duration_seconds,
            frame_rate_name=arguments.frame_rate,
            output_directory=Path(arguments.output_directory).expanduser().resolve(),
            overwrite=arguments.overwrite,
            tools=MediaTools(
                FFmpeg_path=resolve_FFmpeg_tool("ffmpeg", arguments.ffmpeg),
                FFprobe_path=resolve_FFmpeg_tool("ffprobe", arguments.ffprobe),
            ),
        )
        # Each sub-profile once, in table order
        for sub_profile in SUB_PROFILES:
            if sub_profile.name in arguments.sub_profiles:
                generated_paths.extend(create_playback_media(settings, sub_profile))
    except (VectorGenerationError, VectorError, ToolError, OSError, ValueError) as error:
        print(f"Dolby Vision AV1 playback media generation failed: {error}", file=sys.stderr)
        return 1
    print(format_generated_files(generated_paths))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
