#!/usr/bin/env python3
"""Generate HDR10 and HLG HEVC Main 10 playback smoke vectors and audio-switch variants."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from engine_layout import PLAYBACK_SMOKE_MEDIA_DIRECTORY


DEFAULT_OUTPUT_DIRECTORY = PLAYBACK_SMOKE_MEDIA_DIRECTORY
SUPPORTED_FRAME_RATES = (24, 30, 60)
DEFAULT_FRAME_RATES = (24,)
RESOLUTION_DIMENSIONS: dict[str, tuple[int, int]] = {
    "720p": (1280, 720),
    "1080p": (1920, 1080),
}
DEFAULT_RESOLUTION = "1080p"
MINIMUM_DURATION_SECONDS = 6
MAXIMUM_DURATION_SECONDS = 120
DEFAULT_DURATION_SECONDS = 6
TARGET_VIDEO_BIT_RATE_KILOBITS = 6000
MAXIMUM_VIDEO_BIT_RATE_KILOBITS = 8000
VIDEO_PIXEL_FORMAT = "yuv420p10le"
AUDIO_SAMPLE_RATE = 48_000
AUDIO_CHANNEL_COUNT = 2
BASE_AUDIO_CODEC = "aac"
BASE_AUDIO_BIT_RATE_KILOBITS = 128
SWITCH_AUDIO_BIT_RATE_KILOBITS = 192
# Audio-switch vectors remux the 24 fps PQ base vector
SWITCH_VECTOR_FRAME_RATE = 24
AC3_TONE_FREQUENCY = 880
EAC3_TONE_FREQUENCY = 990
PCM_SWITCH_CODEC = "pcm_s24le"
PCM_TONE_FREQUENCY = 1100
PCM_CHANNEL_COUNT = 1
PCM_SAMPLE_RATE = 44_100
# HEVC general_level_idc is thirty times the level number
HEVC_LEVEL_4_IDC = 120
HEVC_LEVEL_4_1_IDC = 123
HIGH_LEVEL_RESOLUTION = "1080p"
HIGH_LEVEL_FRAME_RATE = 60


class VectorGenerationError(RuntimeError):
    """Reports a deterministic vector generation or verification failure."""


@dataclass(frozen=True)
class HDRTransfer:
    """Describes one HDR transfer vector family."""

    code: str
    file_prefix: str
    name: str
    tone_frequency: int


# The x265 transfer codes are the H.273 transfer characteristics values
PQ_TRANSFER = HDRTransfer(code="16", file_prefix="pq", name="smpte2084", tone_frequency=440)
HLG_TRANSFER = HDRTransfer(code="18", file_prefix="hlg", name="arib-std-b67", tone_frequency=660)


@dataclass(frozen=True)
class GenerationSettings:
    """Holds the resolved tools, output location, and vector geometry."""

    duration_seconds: int
    ffmpeg_path: str
    ffprobe_path: str
    height: int
    output_directory: Path
    overwrite: bool
    resolution: str
    reuse_existing_base_vectors: bool
    width: int


def parse_duration_seconds(value: str) -> int:
    """Parses one vector duration within the supported range."""

    duration_seconds = int(value)
    if (
        duration_seconds < MINIMUM_DURATION_SECONDS
        or duration_seconds > MAXIMUM_DURATION_SECONDS
    ):
        raise argparse.ArgumentTypeError(f"must be from {MINIMUM_DURATION_SECONDS} through {MAXIMUM_DURATION_SECONDS}")
    return duration_seconds


def create_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Generate PQ and HLG HEVC Main 10 Matroska vectors with AAC audio, plus "
            "optional AC-3, E-AC-3, and PCM audio-switch variants."
        )
    )
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--output-directory", default=str(DEFAULT_OUTPUT_DIRECTORY))
    parser.add_argument("--frame-rates", nargs="+", type=int, choices=SUPPORTED_FRAME_RATES, default=list(DEFAULT_FRAME_RATES))
    parser.add_argument("--resolution", choices=tuple(RESOLUTION_DIMENSIONS), default=DEFAULT_RESOLUTION)
    parser.add_argument("--duration-seconds", type=parse_duration_seconds, default=DEFAULT_DURATION_SECONDS)
    parser.add_argument("--include-ac3", dest="include_AC3", action="store_true")
    parser.add_argument("--include-eac3", dest="include_EAC3", action="store_true")
    parser.add_argument("--include-pcm", dest="include_PCM", action="store_true")
    parser.add_argument("--reuse-existing-base-vectors", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    return parser


def uses_high_HEVC_level(resolution: str, frame_rate: int) -> bool:
    """Reports whether a vector needs HEVC level 4.1 rather than level 4."""

    return resolution == HIGH_LEVEL_RESOLUTION and frame_rate == HIGH_LEVEL_FRAME_RATE


def get_expected_HEVC_level_IDC(resolution: str, frame_rate: int) -> int:
    """Returns the general_level_idc that FFprobe must report."""

    if uses_high_HEVC_level(resolution, frame_rate):
        return HEVC_LEVEL_4_1_IDC
    return HEVC_LEVEL_4_IDC


def create_x265_parameters(resolution: str, frame_rate: int, transfer: HDRTransfer) -> str:
    """Creates the x265 parameters for a Main tier, two-second-GOP HDR vector."""

    parameters = [
        f"level-idc={'4.1' if uses_high_HEVC_level(resolution, frame_rate) else '4'}",
        "high-tier=0",
        f"keyint={frame_rate * 2}",
        f"min-keyint={frame_rate}",
        "scenecut=0",
        "repeat-headers=1",
        "range=limited",
        "colorprim=9",
        f"transfer={transfer.code}",
        "colormatrix=9",
    ]
    if transfer == PQ_TRANSFER:
        parameters.append("hdr10=1")
    return ":".join(parameters)


def create_base_vector_name(resolution: str, frame_rate: int, transfer: HDRTransfer) -> str:
    """Returns the file stem of one base AAC vector."""

    return f"{transfer.file_prefix}-main10-{resolution}{frame_rate}-{BASE_AUDIO_CODEC}"


def create_dolby_switch_vector_name(resolution: str, audio_codec: str) -> str:
    """Returns the file name of one AC-3 or E-AC-3 audio-switch vector."""

    return f"pq-main10-{resolution}{SWITCH_VECTOR_FRAME_RATE}-aac-{audio_codec}.mkv"


def create_PCM_switch_vector_name(resolution: str) -> str:
    return (
        f"pq-main10-{resolution}{SWITCH_VECTOR_FRAME_RATE}-aac-{PCM_SWITCH_CODEC}-"
        f"{PCM_SAMPLE_RATE}-mono.mkv"
    )


def require_executable(command: str, label: str) -> str:
    """Resolves one required executable without invoking a shell."""

    resolved = shutil.which(command)
    if resolved is None:
        candidate = Path(command).expanduser()
        if candidate.is_file():
            return str(candidate.resolve())
        raise VectorGenerationError(f"{label} was not found: {command}")
    return resolved


def run_tool(arguments: Sequence[str], failure_message: str) -> None:
    """Runs one fixed argument vector with its warnings on the console."""

    result = subprocess.run(list(arguments), check=False)
    if result.returncode != 0:
        raise VectorGenerationError(failure_message)


def format_probe_value(value: object) -> str:
    """Formats one probed value for comparison, with an absent value as empty text."""

    return "" if value is None else str(value)


def parse_probe_integer(value: object) -> int | None:
    """Parses an integer that FFprobe may report as a number or a string."""

    try:
        return int(str(value))
    except ValueError:
        return None


def probe_streams(settings: GenerationSettings, path: Path) -> list[dict[str, object]]:
    """Returns the FFprobe records for every stream in one vector."""

    result = subprocess.run(
        [
            settings.ffprobe_path,
            "-v",
            "error",
            "-show_entries",
            "stream=index,codec_name,profile,level,width,height,pix_fmt,r_frame_rate,"
            "color_range,color_space,color_transfer,color_primaries,channels,sample_rate",
            "-of",
            "json",
            str(path),
        ],
        check=False,
        stdout=subprocess.PIPE,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        raise VectorGenerationError(f"FFprobe failed while verifying {path}")
    return list(json.loads(result.stdout).get("streams", []))


def find_first_stream(streams: Sequence[dict[str, object]], codec_name: str) -> dict[str, object] | None:
    for stream in streams:
        if stream.get("codec_name") == codec_name:
            return stream
    return None


def require_playback_smoke_vector(
    settings: GenerationSettings,
    path: Path,
    transfer: HDRTransfer,
    audio_codec: str,
    frame_rate: int,
    expected_audio_channel_count: int = AUDIO_CHANNEL_COUNT,
    expected_audio_sample_rate: int = AUDIO_SAMPLE_RATE,
) -> None:
    """Rejects a vector whose HEVC or selected audio stream deviates from its contract."""

    streams = probe_streams(settings, path)
    video_stream = find_first_stream(streams, "hevc")
    audio_stream = find_first_stream(streams, audio_codec)
    if video_stream is None or audio_stream is None:
        raise VectorGenerationError(f"The expected HEVC/{audio_codec} streams are missing from {path}")

    expected_video = {
        "profile": "Main 10",
        "level": str(get_expected_HEVC_level_IDC(settings.resolution, frame_rate)),
        "width": str(settings.width),
        "height": str(settings.height),
        "pix_fmt": VIDEO_PIXEL_FORMAT,
        "r_frame_rate": f"{frame_rate}/1",
        "color_range": "tv",
        "color_space": "bt2020nc",
        "color_transfer": transfer.name,
        "color_primaries": "bt2020",
    }
    for property_name, expected_value in expected_video.items():
        actual_value = format_probe_value(video_stream.get(property_name))
        if actual_value != expected_value:
            raise VectorGenerationError(
                f"Unexpected {property_name} in {path}: "
                f"expected {expected_value}, got {actual_value}"
            )
    if (
        parse_probe_integer(audio_stream.get("sample_rate")) != expected_audio_sample_rate
        or parse_probe_integer(audio_stream.get("channels")) != expected_audio_channel_count
    ):
        raise VectorGenerationError(
            f"The audio stream in {path} must have {expected_audio_channel_count} channels "
            f"at {expected_audio_sample_rate} Hz"
        )


def require_replaceable_output(settings: GenerationSettings, output_path: Path) -> None:
    """Refuses to replace an existing vector unless overwriting was requested."""

    if output_path.exists() and not settings.overwrite:
        raise VectorGenerationError(f"{output_path} already exists; pass --overwrite to replace it")


def create_tone_input(frequency: int, sample_rate: int, duration_seconds: int) -> str:
    """Creates one lavfi sine source."""

    return f"sine=frequency={frequency}:sample_rate={sample_rate}:duration={duration_seconds}"


def create_playback_smoke_vector(
    settings: GenerationSettings,
    transfer: HDRTransfer,
    frame_rate: int,
) -> Path:
    """Encodes one HEVC Main 10 vector with an AAC tone, or verifies a reused one."""

    output_path = settings.output_directory / (
        f"{create_base_vector_name(settings.resolution, frame_rate, transfer)}.mkv"
    )
    if output_path.exists() and not settings.overwrite:
        if not settings.reuse_existing_base_vectors:
            raise VectorGenerationError(f"{output_path} already exists; pass --overwrite to replace it")
        require_playback_smoke_vector(settings, output_path, transfer, BASE_AUDIO_CODEC, frame_rate)
        return output_path

    video_input = (
        f"testsrc2=size={settings.width}x{settings.height}:rate={frame_rate}:"
        f"duration={settings.duration_seconds},format={VIDEO_PIXEL_FORMAT}"
    )
    run_tool(
        [
            settings.ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "warning",
            "-y",
            "-f",
            "lavfi",
            "-i",
            video_input,
            "-f",
            "lavfi",
            "-i",
            create_tone_input(transfer.tone_frequency, AUDIO_SAMPLE_RATE, settings.duration_seconds),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "libx265",
            "-pix_fmt",
            VIDEO_PIXEL_FORMAT,
            "-preset",
            "fast",
            "-b:v",
            f"{TARGET_VIDEO_BIT_RATE_KILOBITS}k",
            "-maxrate",
            f"{MAXIMUM_VIDEO_BIT_RATE_KILOBITS}k",
            "-bufsize",
            f"{MAXIMUM_VIDEO_BIT_RATE_KILOBITS}k",
            "-x265-params",
            create_x265_parameters(settings.resolution, frame_rate, transfer),
            "-c:a",
            BASE_AUDIO_CODEC,
            "-b:a",
            f"{BASE_AUDIO_BIT_RATE_KILOBITS}k",
            "-ar",
            str(AUDIO_SAMPLE_RATE),
            "-ac",
            str(AUDIO_CHANNEL_COUNT),
            "-shortest",
            str(output_path),
        ],
        f"FFmpeg failed while generating {output_path}",
    )
    require_playback_smoke_vector(settings, output_path, transfer, BASE_AUDIO_CODEC, frame_rate)
    return output_path


def create_dolby_audio_switch_vector(
    settings: GenerationSettings,
    base_vector_path: Path,
    audio_codec: str,
    tone_frequency: int,
) -> Path:
    """Remuxes the PQ base vector with a non-default AC-3 or E-AC-3 switch track."""

    output_path = settings.output_directory / create_dolby_switch_vector_name(settings.resolution, audio_codec)
    require_replaceable_output(settings, output_path)
    run_tool(
        [
            settings.ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "warning",
            "-y",
            "-i",
            str(base_vector_path),
            "-f",
            "lavfi",
            "-i",
            create_tone_input(tone_frequency, AUDIO_SAMPLE_RATE, settings.duration_seconds),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a:0",
            "copy",
            "-c:a:1",
            audio_codec,
            "-b:a:1",
            f"{SWITCH_AUDIO_BIT_RATE_KILOBITS}k",
            "-ar:a:1",
            str(AUDIO_SAMPLE_RATE),
            "-ac:a:1",
            str(AUDIO_CHANNEL_COUNT),
            "-metadata:s:a:0",
            "title=AAC default",
            "-metadata:s:a:1",
            f"title={audio_codec} switch target",
            "-disposition:a:0",
            "default",
            "-disposition:a:1",
            "0",
            "-shortest",
            str(output_path),
        ],
        f"FFmpeg failed while generating {output_path}",
    )
    for verified_audio_codec in (BASE_AUDIO_CODEC, audio_codec):
        require_playback_smoke_vector(settings, output_path, PQ_TRANSFER, verified_audio_codec, SWITCH_VECTOR_FRAME_RATE)
    return output_path


def create_PCM_audio_switch_vector(settings: GenerationSettings, base_vector_path: Path) -> Path:
    """Remuxes the PQ base vector with a non-default 44.1 kHz mono PCM switch track."""

    output_path = settings.output_directory / create_PCM_switch_vector_name(settings.resolution)
    require_replaceable_output(settings, output_path)
    run_tool(
        [
            settings.ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "warning",
            "-y",
            "-i",
            str(base_vector_path),
            "-f",
            "lavfi",
            "-i",
            create_tone_input(PCM_TONE_FREQUENCY, PCM_SAMPLE_RATE, settings.duration_seconds),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a:0",
            "copy",
            "-c:a:1",
            PCM_SWITCH_CODEC,
            "-ar:a:1",
            str(PCM_SAMPLE_RATE),
            "-ac:a:1",
            str(PCM_CHANNEL_COUNT),
            "-metadata:s:a:0",
            "title=AAC default",
            "-metadata:s:a:1",
            "title=Mediabunny PCM 44.1 kHz mono switch target",
            "-disposition:a:0",
            "default",
            "-disposition:a:1",
            "0",
            "-shortest",
            str(output_path),
        ],
        f"FFmpeg failed while generating {output_path}",
    )
    require_playback_smoke_vector(settings, output_path, PQ_TRANSFER, BASE_AUDIO_CODEC, SWITCH_VECTOR_FRAME_RATE)
    require_playback_smoke_vector(
        settings,
        output_path,
        PQ_TRANSFER,
        PCM_SWITCH_CODEC,
        SWITCH_VECTOR_FRAME_RATE,
        expected_audio_channel_count=PCM_CHANNEL_COUNT,
        expected_audio_sample_rate=PCM_SAMPLE_RATE,
    )
    return output_path


def execute(
    settings: GenerationSettings,
    frame_rates: Sequence[int],
    include_AC3: bool,
    include_EAC3: bool,
    include_PCM: bool,
) -> list[Path]:
    """Generates the base vectors for every frame rate, then any audio-switch variants."""

    unique_frame_rates = sorted(set(frame_rates))
    switch_vector_requested = include_AC3 or include_EAC3 or include_PCM
    # Validated before encoding so a bad request does not waste the base encodes
    if switch_vector_requested and SWITCH_VECTOR_FRAME_RATE not in unique_frame_rates:
        raise VectorGenerationError("--include-ac3, --include-eac3, and --include-pcm require 24 in --frame-rates")

    settings.output_directory.mkdir(parents=True, exist_ok=True)
    generated_paths: list[Path] = []
    switch_base_vector_path: Path | None = None
    for frame_rate in unique_frame_rates:
        PQ_vector_path = create_playback_smoke_vector(settings, PQ_TRANSFER, frame_rate)
        generated_paths.append(PQ_vector_path)
        generated_paths.append(create_playback_smoke_vector(settings, HLG_TRANSFER, frame_rate))
        if frame_rate == SWITCH_VECTOR_FRAME_RATE:
            switch_base_vector_path = PQ_vector_path

    if switch_base_vector_path is None:
        return generated_paths
    if include_AC3:
        generated_paths.append(create_dolby_audio_switch_vector(settings, switch_base_vector_path, "ac3", AC3_TONE_FREQUENCY))
    if include_EAC3:
        generated_paths.append(create_dolby_audio_switch_vector(settings, switch_base_vector_path, "eac3", EAC3_TONE_FREQUENCY))
    if include_PCM:
        generated_paths.append(create_PCM_audio_switch_vector(settings, switch_base_vector_path))
    return generated_paths


def format_generated_files(paths: Sequence[Path]) -> str:
    """Formats a Name, Length, and FullName table of the generated vectors."""

    headers = ("Name", "Length", "FullName")
    rows = [(path.name, str(path.stat().st_size), str(path)) for path in paths]
    name_width = max([len(headers[0]), *(len(row[0]) for row in rows)])
    length_width = max([len(headers[1]), *(len(row[1]) for row in rows)])
    lines = [
        f"{headers[0]:<{name_width}} {headers[1]:>{length_width}} {headers[2]}",
        f"{'-' * len(headers[0]):<{name_width}} {'-' * len(headers[1]):>{length_width}} "
        f"{'-' * len(headers[2])}",
    ]
    for name, length, full_name in rows:
        lines.append(f"{name:<{name_width}} {length:>{length_width}} {full_name}")
    return "\n".join(lines)


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Runs the CLI and prints the generated vector table."""

    arguments = create_argument_parser().parse_args(command_arguments)
    width, height = RESOLUTION_DIMENSIONS[arguments.resolution]
    try:
        settings = GenerationSettings(
            duration_seconds=arguments.duration_seconds,
            ffmpeg_path=require_executable(arguments.ffmpeg, "FFmpeg"),
            ffprobe_path=require_executable(arguments.ffprobe, "FFprobe"),
            height=height,
            output_directory=Path(arguments.output_directory).expanduser().resolve(),
            overwrite=arguments.overwrite,
            resolution=arguments.resolution,
            reuse_existing_base_vectors=arguments.reuse_existing_base_vectors,
            width=width,
        )
        generated_paths = execute(
            settings,
            arguments.frame_rates,
            arguments.include_AC3,
            arguments.include_EAC3,
            arguments.include_PCM,
        )
    except (VectorGenerationError, OSError, ValueError) as error:
        print(f"Playback smoke media generation failed: {error}", file=sys.stderr)
        return 1
    print(format_generated_files(generated_paths))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
