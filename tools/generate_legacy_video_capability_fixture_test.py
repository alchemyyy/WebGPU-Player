"""Tests FFmpeg resolution and fixture installation for the legacy video generator."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIRECTORY))

import generate_legacy_video_capability_fixture as legacy_fixture  # noqa: E402


class FFmpegResolutionTests(unittest.TestCase):
    """Covers the explicit flag and the PATH default."""

    def test_defaults_to_FFmpeg_on_PATH(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            executable_path = Path(temporary_directory) / "ffmpeg.exe"
            executable_path.write_bytes(b"")
            with patch.object(
                legacy_fixture.shutil,
                "which",
                return_value=str(executable_path),
            ) as which:
                resolved_path = legacy_fixture.resolve_ffmpeg_path(None)

            which.assert_called_once_with("ffmpeg")
            self.assertEqual(resolved_path, executable_path.resolve())

    def test_explicit_flag_overrides_PATH(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            executable_path = Path(temporary_directory) / "ffmpeg.exe"
            executable_path.write_bytes(b"")
            with patch.object(legacy_fixture.shutil, "which") as which:
                resolved_path = legacy_fixture.resolve_ffmpeg_path(executable_path)

            which.assert_not_called()
            self.assertEqual(resolved_path, executable_path.resolve())

    def test_reports_missing_FFmpeg_clearly(self) -> None:
        with patch.object(legacy_fixture.shutil, "which", return_value=None):
            with self.assertRaisesRegex(
                FileNotFoundError,
                "not found on PATH; pass --ffmpeg",
            ):
                legacy_fixture.resolve_ffmpeg_path(None)

        with tempfile.TemporaryDirectory() as temporary_directory:
            missing_path = Path(temporary_directory) / "ffmpeg.exe"
            with self.assertRaisesRegex(FileNotFoundError, "FFmpeg was not found"):
                legacy_fixture.resolve_ffmpeg_path(missing_path)


class FixtureGenerationTests(unittest.TestCase):
    """Covers installing regenerated output only when it matches the pin."""

    def generate_with_output(self, generated_bytes: bytes, installed_path: Path) -> str:
        """Runs generate_fixture with FFmpeg replaced by a writer of fixed bytes."""

        def write_generated_output(
            command: list[str],
            **_options: object,
        ) -> subprocess.CompletedProcess[bytes]:
            Path(command[-1]).write_bytes(generated_bytes)
            return subprocess.CompletedProcess(command, 0)

        with (
            patch.object(legacy_fixture, "OUTPUT_PATH", installed_path),
            patch.object(
                legacy_fixture.subprocess,
                "run",
                side_effect=write_generated_output,
            ),
        ):
            return legacy_fixture.generate_fixture(Path("ffmpeg.exe"))

    def test_keeps_the_committed_fixture_when_output_differs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            installed_path = Path(temporary_directory) / "fixture.mkv"
            installed_path.write_bytes(b"committed fixture")
            with self.assertRaisesRegex(RuntimeError, "differs from the pinned fixture"):
                self.generate_with_output(b"other FFmpeg output", installed_path)

            self.assertEqual(installed_path.read_bytes(), b"committed fixture")

    def test_installs_output_that_matches_the_pin(self) -> None:
        pinned_bytes = legacy_fixture.OUTPUT_PATH.read_bytes()
        with tempfile.TemporaryDirectory() as temporary_directory:
            installed_path = Path(temporary_directory) / "fixture.mkv"
            installed_path.write_bytes(b"stale fixture")

            self.assertEqual(
                self.generate_with_output(pinned_bytes, installed_path),
                legacy_fixture.EXPECTED_SHA256,
            )
            self.assertEqual(installed_path.read_bytes(), pinned_bytes)


if __name__ == "__main__":
    unittest.main()
