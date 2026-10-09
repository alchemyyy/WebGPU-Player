#!/usr/bin/env python3
"""Generate a compact native HEVC Main10 High Tier HDR playback vector."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from engine_layout import PLAYBACK_SMOKE_MEDIA_DIRECTORY
from generate_static_HDR_validation_vectors import (
    VectorGenerationError,
    VALID_TONE_MAPPING_PEAK_NITS,
    calculate_SHA256,
    create_valid_static_HDR_SEI_NAL_unit,
    extract_HEVC,
    find_annex_B_NAL_units,
    inject_prefix_SEI_NAL_units,
    mux_vector,
    remove_emulation_prevention_bytes,
    require_exact_stream_metadata,
    require_executable,
    run_command,
    scan_static_HDR_metadata,
)


DEFAULT_OUTPUT_DIRECTORY = PLAYBACK_SMOKE_MEDIA_DIRECTORY
VECTOR_REVISION = "v1"
VECTOR_FILE_NAME = (
    "native-hevc-main10-high-tier-level-5.1-"
    f"{VECTOR_REVISION}-2160p24-flac.mkv"
)
MANIFEST_FILE_NAME = "native-HEVC-High-Tier-validation-manifest.json"
EXPECTED_PROFILE_IDC = 2
EXPECTED_LEVEL_IDC = 153
EXPECTED_WIDTH = 3_840
EXPECTED_HEIGHT = 2_160
EXPECTED_FRAME_RATE = 24
EXPECTED_DURATION_SECONDS = 12


@dataclass(frozen=True)
class HEVCProfileTierLevel:
    """Describes the fixed fields required from the first HEVC SPS."""

    is_high_tier: bool
    is_progressive: bool
    level_IDC: int
    profile_IDC: int


def create_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Generate one controlled 4K24 PQ Main10 High Tier Level 5.1 "
            "Matroska/FLAC playback vector."
        )
    )
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--output-directory", default=str(DEFAULT_OUTPUT_DIRECTORY))
    parser.add_argument("--duration-seconds", type=int, default=EXPECTED_DURATION_SECONDS)
    parser.add_argument("--overwrite", action="store_true")
    return parser


def parse_HEVC_profile_tier_level(data: bytes) -> HEVCProfileTierLevel:
    """Parses the first SPS profile, tier, level, and progressive flags."""

    SPS = next((NAL_unit for NAL_unit in find_annex_B_NAL_units(data) if NAL_unit.nal_type == 33), None)
    if SPS is None:
        raise VectorGenerationError("The generated HEVC stream has no SPS")
    NAL_unit = data[SPS.payload_offset : SPS.end_offset]
    if len(NAL_unit) < 2:
        raise VectorGenerationError("The generated HEVC SPS has no NAL header")
    RBSP = remove_emulation_prevention_bytes(NAL_unit[2:])
    if len(RBSP) < 13:
        raise VectorGenerationError("The generated HEVC SPS profile tier level is truncated")
    return HEVCProfileTierLevel(
        is_high_tier=(RBSP[1] & 0x20) != 0,
        is_progressive=(RBSP[6] & 0x80) != 0 and (RBSP[6] & 0x40) == 0,
        level_IDC=RBSP[12],
        profile_IDC=RBSP[1] & 0x1F,
    )


def require_expected_profile_tier_level(data: bytes) -> HEVCProfileTierLevel:
    """Requires exact Main10 High Tier Level 5.1 progressive signaling."""

    profile_tier_level = parse_HEVC_profile_tier_level(data)
    if profile_tier_level != HEVCProfileTierLevel(
        is_high_tier=True,
        is_progressive=True,
        level_IDC=EXPECTED_LEVEL_IDC,
        profile_IDC=EXPECTED_PROFILE_IDC,
    ):
        raise VectorGenerationError(f"Unexpected HEVC profile/tier/level signaling: {profile_tier_level}")
    return profile_tier_level


def generate_high_tier_HEVC(
    ffmpeg_path: str,
    output_path: Path,
    *,
    duration_seconds: int,
) -> None:
    """Generates one deterministic metadata-free High Tier elementary stream."""

    frame_count = EXPECTED_FRAME_RATE * duration_seconds
    key_frame_interval = EXPECTED_FRAME_RATE * 2
    video_input = (
        f"testsrc2=size={EXPECTED_WIDTH}x{EXPECTED_HEIGHT}:"
        f"rate={EXPECTED_FRAME_RATE}:duration={duration_seconds},format=yuv420p10le"
    )
    x265_parameters = ":".join(
        (
            "level-idc=5.1",
            "high-tier=1",
            "vbv-maxrate=60000",
            "vbv-bufsize=60000",
            "bframes=0",
            "frame-threads=1",
            f"keyint={key_frame_interval}",
            f"min-keyint={key_frame_interval}",
            "scenecut=0",
            "repeat-headers=1",
            "aud=1",
            "wpp=0",
            "pools=none",
            "info=0",
            "range=limited",
            "colorprim=9",
            "transfer=16",
            "colormatrix=9",
            "hdr10=0",
            "log-level=error",
        )
    )
    run_command(
        (
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "warning",
            "-y",
            "-f",
            "lavfi",
            "-i",
            video_input,
            "-frames:v",
            str(frame_count),
            "-an",
            "-c:v",
            "libx265",
            "-pix_fmt",
            "yuv420p10le",
            "-preset",
            "ultrafast",
            "-crf",
            "24",
            "-x265-params",
            x265_parameters,
            "-f",
            "hevc",
            str(output_path),
        ),
        "Native High Tier HEVC encode",
    )
    HEVC = output_path.read_bytes()
    require_expected_profile_tier_level(HEVC)
    if scan_static_HDR_metadata(HEVC) != "absent":
        raise VectorGenerationError("The base High Tier stream unexpectedly contains static HDR metadata")


def require_options(arguments: argparse.Namespace) -> None:
    """Rejects durations outside the supported vector bounds."""

    if arguments.duration_seconds < 8 or arguments.duration_seconds > 120:
        raise VectorGenerationError("Vector duration must be from 8 through 120 seconds")


def execute(arguments: argparse.Namespace) -> dict[str, object]:
    """Generates, verifies, and atomically publishes the vector and records."""

    require_options(arguments)
    ffmpeg_path = require_executable(arguments.ffmpeg, "FFmpeg")
    ffprobe_path = require_executable(arguments.ffprobe, "FFprobe")
    output_directory = Path(arguments.output_directory).expanduser().resolve()
    output_directory.mkdir(parents=True, exist_ok=True)
    vector_path = output_directory / VECTOR_FILE_NAME
    manifest_path = output_directory / MANIFEST_FILE_NAME
    existing_paths = [path for path in (vector_path, manifest_path) if path.exists()]
    if existing_paths and not arguments.overwrite:
        raise VectorGenerationError(f"Output already exists; pass --overwrite: {existing_paths[0]}")

    ffmpeg_version = run_command((ffmpeg_path, "-version"), "FFmpeg version query")
    with tempfile.TemporaryDirectory(prefix="webgpu-native-hevc-high-tier-") as temporary_directory:
        temporary_path = Path(temporary_directory)
        base_path = temporary_path / "base.hevc"
        generate_high_tier_HEVC(ffmpeg_path, base_path, duration_seconds=arguments.duration_seconds)
        injected_HEVC = inject_prefix_SEI_NAL_units(
            base_path.read_bytes(),
            (create_valid_static_HDR_SEI_NAL_unit(VALID_TONE_MAPPING_PEAK_NITS),),
        )
        require_expected_profile_tier_level(injected_HEVC)
        if scan_static_HDR_metadata(injected_HEVC) != "valid":
            raise VectorGenerationError("Injected High Tier HDR metadata is not valid")
        injected_path = temporary_path / "injected.hevc"
        injected_path.write_bytes(injected_HEVC)
        staged_vector_path = temporary_path / vector_path.name
        mux_vector(
            ffmpeg_path,
            injected_path,
            staged_vector_path,
            frame_rate=EXPECTED_FRAME_RATE,
            duration_seconds=arguments.duration_seconds,
        )
        stream_metadata = require_exact_stream_metadata(
            ffprobe_path,
            staged_vector_path,
            width=EXPECTED_WIDTH,
            height=EXPECTED_HEIGHT,
            frame_rate=EXPECTED_FRAME_RATE,
        )
        if stream_metadata["video"].get("level") != EXPECTED_LEVEL_IDC:
            raise VectorGenerationError("Muxed High Tier vector has the wrong HEVC level")
        extracted_path = temporary_path / "extracted.hevc"
        extracted_HEVC = extract_HEVC(ffmpeg_path, staged_vector_path, extracted_path)
        require_expected_profile_tier_level(extracted_HEVC)
        if scan_static_HDR_metadata(extracted_HEVC) != "valid":
            raise VectorGenerationError("Muxed High Tier HDR metadata is not valid")
        vector_record = {
            "byteLength": staged_vector_path.stat().st_size,
            "expectedStaticHDRMetadataStatus": "valid",
            "expectedToneMappingPeakNits": VALID_TONE_MAPPING_PEAK_NITS,
            "file": vector_path.name,
            "media": stream_metadata,
            "profileTierLevel": {
                "highTier": True,
                "levelIDC": EXPECTED_LEVEL_IDC,
                "profileIDC": EXPECTED_PROFILE_IDC,
            },
            "sha256": calculate_SHA256(staged_vector_path),
        }
        os.replace(staged_vector_path, vector_path)

    manifest = {
        "durationSeconds": arguments.duration_seconds,
        "ffmpegVersion": ffmpeg_version.stdout.splitlines()[0],
        "vector": vector_record,
        "generator": Path(__file__).name,
        "schemaVersion": 1,
    }
    temporary_manifest_path = manifest_path.with_suffix(".tmp")
    temporary_manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary_manifest_path, manifest_path)
    return {
        "vector": vector_path.name,
        "manifest": str(manifest_path),
        "status": "generated",
    }


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Runs the CLI and prints the JSON summary."""

    arguments = create_argument_parser().parse_args(command_arguments)
    try:
        result = execute(arguments)
    except (VectorGenerationError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Native HEVC High Tier vector generation failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
