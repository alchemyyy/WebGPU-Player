"""Tests the Profile 7 playback vector commands, tool resolution, and orchestration."""

from __future__ import annotations

import contextlib
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import create_profile7_playback_vector as generator  # noqa: E402
from create_dual_track_dolby_vision_MP4_vector import DualTrackVectorConfiguration  # noqa: E402


MKV_MERGE_EXECUTABLE_NAME = "mkvmerge.exe" if sys.platform == "win32" else "mkvmerge"


def run_main(command_arguments: list[str]) -> tuple[int, str, str]:
    """Runs the CLI and returns its exit status, stdout, and stderr."""

    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        status = generator.main(command_arguments)
    return status, stdout.getvalue(), stderr.getvalue()


def create_empty_file(path: str) -> str:
    """Creates one empty file, with its directory, and returns its path."""

    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(b"")
    return path


class StructuralCommandTests(unittest.TestCase):
    """Covers the structural FFmpeg encode and the mkvmerge normalization commands."""

    def test_builds_a_bounded_1080p_dual_track_structural_encode_command(self) -> None:
        arguments = generator.create_structural_FFmpeg_arguments("input.mkv", "encoded.mkv")

        self.assertEqual(
            arguments[:7],
            [
                "-hide_banner",
                "-loglevel", "error",
                "-nostdin",
                "-y",
                "-stream_loop", "9",
            ],
        )
        self.assertIn("scale=1920:1080:flags=lanczos", arguments)
        self.assertEqual(arguments.count("0:v:0"), 1)
        self.assertEqual(arguments.count("0:v:1"), 1)
        self.assertEqual(
            len([argument for argument in arguments if argument.startswith("setts=")]),
            2,
        )
        self.assertEqual(arguments[-1], "encoded.mkv")

    def test_normalizes_both_video_tracks_to_the_same_deterministic_default_duration(self) -> None:
        arguments = generator.create_structural_MKV_merge_arguments("encoded.mkv", "normalized.mkv")

        self.assertEqual(
            arguments,
            [
                "--quiet",
                "--output", "normalized.mkv",
                "--deterministic", "webgpu-profile7-playback",
                "--no-date",
                "--disable-track-statistics-tags",
                "--default-duration", "0:6000/1001p",
                "--default-duration", "1:6000/1001p",
                "encoded.mkv",
            ],
        )


class PlaybackVectorTests(unittest.TestCase):
    """Covers the tool sequence and the summary without running codec tools."""

    def test_encodes_and_normalizes_before_creating_the_dual_track_vector(self) -> None:
        commands: list[list[str]] = []
        dual_track_configurations: list[DualTrackVectorConfiguration] = []

        def run_tool(
            command: list[str],
            **_options: object,
        ) -> subprocess.CompletedProcess[bytes]:
            commands.append(command)
            return subprocess.CompletedProcess(command, 0, stdout=b"", stderr=b"")

        def create_dual_track_vector(
            configuration: DualTrackVectorConfiguration,
        ) -> dict[str, object]:
            dual_track_configurations.append(configuration)
            # A UHD source: the BL scaled to 1080p, and its 1080p EL copied
            return {
                "baseHeight": 1_080,
                "baseTrackID": 1,
                "baseWidth": 1_920,
                "byteLength": 1_024,
                "enhancementHeight": 1_080,
                "enhancementSampleEntryType": "dvh1",
                "enhancementTrackID": 2,
                "enhancementWidth": 1_920,
                "outputPath": configuration.output_path,
                "sha256": "0" * 64,
            }

        with tempfile.TemporaryDirectory() as temporary_directory:
            input_path = os.path.join(temporary_directory, "separate.mkv")
            output_path = os.path.join(temporary_directory, "playback.mp4")
            Path(input_path).write_bytes(b"separate-track source")
            FFmpeg_path = create_empty_file(os.path.join(temporary_directory, "ffmpeg.exe"))
            MKVToolNix_directory = os.path.join(temporary_directory, "MKVToolNix")
            MKV_merge_path = create_empty_file(os.path.join(MKVToolNix_directory, MKV_MERGE_EXECUTABLE_NAME))
            with (
                patch.object(subprocess, "run", side_effect=run_tool),
                patch.object(
                    generator,
                    "create_dual_track_dolby_vision_MP4_vector",
                    side_effect=create_dual_track_vector,
                ),
            ):
                summary = generator.create_playback_vector(
                    generator.PlaybackVectorConfiguration(
                        input_path=input_path,
                        output_path=output_path,
                        configured_FFmpeg_path=FFmpeg_path,
                        MKVToolNix_directory=MKVToolNix_directory,
                    )
                )

        self.assertEqual(len(commands), 2)
        encode_command, normalize_command = commands
        encoded_path = encode_command[-1]
        normalized_path = os.path.join(os.path.dirname(encoded_path), "normalized.mkv")
        self.assertEqual(os.path.basename(encoded_path), "encoded.mkv")
        self.assertTrue(os.path.basename(os.path.dirname(encoded_path)).startswith("webgpu-dovi-playback-"))
        self.assertEqual(
            encode_command,
            [FFmpeg_path, *generator.create_structural_FFmpeg_arguments(input_path, encoded_path)],
        )
        self.assertEqual(
            normalize_command,
            [
                MKV_merge_path,
                *generator.create_structural_MKV_merge_arguments(encoded_path, normalized_path),
            ],
        )
        self.assertEqual(
            dual_track_configurations,
            [
                DualTrackVectorConfiguration(
                    input_path=normalized_path,
                    output_path=output_path,
                    configured_FFmpeg_path=FFmpeg_path,
                )
            ],
        )
        self.assertEqual(
            list(summary),
            [
                "baseHeight",
                "baseTrackID",
                "baseWidth",
                "byteLength",
                "enhancementHeight",
                "enhancementSampleEntryType",
                "enhancementTrackID",
                "enhancementWidth",
                "outputPath",
                "sha256",
                "colorFidelityReference",
            ],
        )
        self.assertIs(summary["colorFidelityReference"], False)
        # The layer sizes are the ones the dual-track step read from the written vector
        self.assertEqual((summary["baseWidth"], summary["baseHeight"]), (1_920, 1_080))
        self.assertEqual((summary["enhancementWidth"], summary["enhancementHeight"]), (1_920, 1_080))

    def test_rejects_a_source_beyond_the_size_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            input_path = os.path.join(temporary_directory, "separate.mkv")
            with open(input_path, "wb") as input_stream:
                input_stream.truncate(generator.MAXIMUM_SOURCE_VECTOR_BYTE_LENGTH + 1)
            with self.assertRaises(generator.PlaybackVectorError) as raised:
                generator.create_playback_vector(
                    generator.PlaybackVectorConfiguration(
                        input_path=input_path,
                        output_path=os.path.join(temporary_directory, "playback.mp4"),
                    )
                )

        self.assertEqual(str(raised.exception), "The source vector size is unsupported")


class CommandLineTests(unittest.TestCase):
    """Covers the CLI validation and its exit statuses."""

    def test_rejects_empty_tool_paths(self) -> None:
        for option, message in (
            ("--ffmpeg", "--ffmpeg requires a path\n"),
            ("--mkvtoolnix-directory", "--mkvtoolnix-directory requires a path\n"),
        ):
            with self.subTest(option=option):
                status, _, stderr = run_main(["input.mkv", "output.mp4", option, ""])
                self.assertEqual((status, stderr), (1, message))

    def test_rejects_an_output_path_that_resolves_to_the_input_path(self) -> None:
        status, stdout, stderr = run_main(["vector.mkv", os.path.join(".", "vector.mkv")])

        self.assertEqual((status, stdout), (1, ""))
        self.assertEqual(stderr, "The output path must differ from the input path\n")

    def test_fails_with_status_1_for_a_missing_input(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            missing_path = os.path.join(temporary_directory, "missing.mkv")
            status, stdout, stderr = run_main([missing_path, os.path.join(temporary_directory, "playback.mp4")])

        self.assertEqual((status, stdout), (1, ""))
        self.assertIn("missing.mkv", stderr)

    def test_prints_help_and_exits_successfully(self) -> None:
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout), self.assertRaises(SystemExit) as raised:
            generator.main(["--help"])

        # NOTE: argparse wraps help text to the terminal width
        help_text = " ".join(stdout.getvalue().split())
        self.assertEqual(raised.exception.code, 0)
        self.assertIn("create_profile7_playback_vector.py", help_text)
        self.assertIn("for complete Jellyfin playback smoke tests", help_text)
        self.assertIn("--mkvtoolnix-directory path", help_text)


if __name__ == "__main__":
    unittest.main()
