#!/usr/bin/env python3
"""Generate the deterministic progressive MPEG-2 qualification fixture."""

from __future__ import annotations

import argparse
import pathlib
import shutil
import subprocess
import tempfile

from ab_harness import calculate_sha256
from validation_fixture_registry import (
    DEFAULT_FRAGMENT_DIRECTORY,
    FixtureRegistrySpecification,
    create_fixture_registry_fragment,
    write_or_check_fragment,
)


SCRIPT_DIRECTORY = pathlib.Path(__file__).resolve().parent
REPOSITORY_ROOT = SCRIPT_DIRECTORY.parents[1]
FIXTURE_DIRECTORY = (
    REPOSITORY_ROOT / "vendor" / "webgpu" / "capability-fixtures" / "legacy-video"
)
OUTPUT_PATH = FIXTURE_DIRECTORY / "mpeg2-progressive-1920x1080.mkv"
VC1_FIXTURE_PATH = FIXTURE_DIRECTORY / "vc1-advanced-progressive-1920x1080.mkv"
EXPECTED_SHA256 = "86db9dfebafb85c3c6001c762c5a1c91427d2039fcd5fbffba8c8c42efaf43b1"
VC1_EXPECTED_SHA256 = (
    "560ccb27518b854f765aa84d4503a84c0a2ffaa5b28f5d6edd7de0326f246cd0"
)
DEFAULT_REGISTRY_OUTPUT = DEFAULT_FRAGMENT_DIRECTORY / "legacy-video.json"


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--ffmpeg",
        type=pathlib.Path,
        help="FFmpeg executable; defaults to ffmpeg on PATH",
    )
    parser.add_argument(
        "--registry-output",
        default=DEFAULT_REGISTRY_OUTPUT,
        type=pathlib.Path,
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail if the checked fixture or registry fragment is stale",
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


def generate_fixture(ffmpeg_path: pathlib.Path) -> str:
    """Encodes the MPEG-2 fixture and installs it only when it matches its pin."""

    with tempfile.TemporaryDirectory(
        prefix="jellyfin-legacy-video-fixture-"
    ) as temporary_directory:
        # Another FFmpeg build must not overwrite the committed fixture before the hash check
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
        subprocess.run(command, check=True, cwd=REPOSITORY_ROOT)
        actual_sha256 = calculate_sha256(generated_path)
        if actual_sha256 != EXPECTED_SHA256:
            raise RuntimeError(
                "The generated MPEG-2 qualification fixture differs from the pinned "
                f"fixture: {actual_sha256}"
            )
        OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(generated_path, OUTPUT_PATH)
    return actual_sha256


def create_registry_fragment() -> dict[str, object]:
    """Creates the exact progressive legacy-video validation-registry fragment."""

    specification = FixtureRegistrySpecification(
        fixture_id="mpeg2-main-progressive-1080p24-matroska",
        repository_path=OUTPUT_PATH.relative_to(REPOSITORY_ROOT).as_posix(),
        expected_sha256=EXPECTED_SHA256,
        license_expression="GPL-2.0-or-later",
        license_evidence_uri="repo://LICENSE",
        provenance={
            "generatorArguments": [
                "python",
                "scripts/webgpu/generate_legacy_video_capability_fixture.py",
            ],
            "kind": "generated",
            "revision": "jellyfin-ffmpeg-8.1.2",
            "source": "FFmpeg testsrc2 deterministic MPEG-2 Main encoding",
        },
        media={
            "container": "matroska",
            "packetization": "mpeg2video-access-units",
            "video": {
                "bitDepth": 8,
                "chroma": "4:2:0",
                "codec": "mpeg2video",
                "frameRate": 24,
                "height": 1080,
                "matrix": "unspecified",
                "primaries": "unspecified",
                "profile": "main",
                "progressive": True,
                "range": "unspecified",
                "transfer": "unspecified",
                "width": 1920,
            },
        },
    )
    vc1_specification = FixtureRegistrySpecification(
        fixture_id="vc1-advanced-progressive-1080p24-matroska",
        repository_path=VC1_FIXTURE_PATH.relative_to(REPOSITORY_ROOT).as_posix(),
        expected_sha256=VC1_EXPECTED_SHA256,
        license_expression="GPL-2.0-or-later",
        license_evidence_uri="repo://LICENSE",
        provenance={
            "generatorArguments": [
                "Windows Media Foundation MFVideoFormat_WVC1",
                "FFmpeg stream-copy remux to Matroska",
            ],
            "kind": "generated",
            "revision": "windows-11-media-foundation",
            "source": "Project-authored synthetic RGB moving test pattern",
        },
        media={
            "container": "matroska",
            "packetization": "vc1-advanced-access-units",
            "video": {
                "bitDepth": 8,
                "chroma": "4:2:0",
                "codec": "vc1",
                "frameRate": 24,
                "height": 1080,
                "matrix": "unspecified",
                "primaries": "unspecified",
                "profile": "advanced",
                "progressive": True,
                "range": "unspecified",
                "transfer": "unspecified",
                "width": 1920,
            },
        },
    )
    return create_fixture_registry_fragment(
        registry_id="legacy-video",
        generator_uri=(
            "repo://scripts/webgpu/generate_legacy_video_capability_fixture.py"
        ),
        specifications=(specification, vc1_specification),
    )


def main() -> None:
    arguments = parse_arguments()
    registry_output_path = arguments.registry_output.resolve()
    if arguments.check:
        # Building the fragment hashes both checked-in fixtures against their pins
        write_or_check_fragment(
            registry_output_path,
            create_registry_fragment(),
            check=True,
        )
        print(
            f"Verified {OUTPUT_PATH}, {VC1_FIXTURE_PATH}, and {registry_output_path}"
        )
        return
    actual_sha256 = generate_fixture(resolve_ffmpeg_path(arguments.ffmpeg))
    write_or_check_fragment(
        registry_output_path,
        create_registry_fragment(),
        check=False,
    )
    print(f"Generated {OUTPUT_PATH} ({actual_sha256})")


if __name__ == "__main__":
    main()
