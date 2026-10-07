"""Tests FFmpeg resolution, checking, and installation for the MPEG-2 vector generator."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import generate_mpeg2_capability_vector as mpeg2_vector  # noqa: E402
from generated_output import GeneratedOutputError  # noqa: E402


class FFmpegResolutionTests(unittest.TestCase):
    """Covers the explicit flag and the PATH default."""

    def test_defaults_to_FFmpeg_on_PATH(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            executable_path = Path(temporary_directory) / "ffmpeg.exe"
            executable_path.write_bytes(b"")
            with patch.object(
                mpeg2_vector.shutil,
                "which",
                return_value=str(executable_path),
            ) as which:
                resolved_path = mpeg2_vector.resolve_ffmpeg_path(None)

            which.assert_called_once_with("ffmpeg")
            self.assertEqual(resolved_path, executable_path.resolve())

    def test_explicit_flag_overrides_PATH(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            executable_path = Path(temporary_directory) / "ffmpeg.exe"
            executable_path.write_bytes(b"")
            with patch.object(mpeg2_vector.shutil, "which") as which:
                resolved_path = mpeg2_vector.resolve_ffmpeg_path(executable_path)

            which.assert_not_called()
            self.assertEqual(resolved_path, executable_path.resolve())

    def test_reports_missing_FFmpeg_clearly(self) -> None:
        with patch.object(mpeg2_vector.shutil, "which", return_value=None):
            with self.assertRaisesRegex(
                FileNotFoundError,
                "not found on PATH; pass --ffmpeg",
            ):
                mpeg2_vector.resolve_ffmpeg_path(None)

        with tempfile.TemporaryDirectory() as temporary_directory:
            missing_path = Path(temporary_directory) / "ffmpeg.exe"
            with self.assertRaisesRegex(FileNotFoundError, "FFmpeg was not found"):
                mpeg2_vector.resolve_ffmpeg_path(missing_path)


class VectorGenerationTests(unittest.TestCase):
    """Covers comparing regenerated output with the committed vector and installing a missing one."""

    def generate_with_output(
        self,
        generated_bytes: bytes,
        installed_path: Path,
        *,
        check: bool,
    ) -> bool:
        """Runs generate_vector with FFmpeg replaced by a writer of fixed bytes."""

        def write_generated_output(
            command: list[str],
            **_options: object,
        ) -> subprocess.CompletedProcess[bytes]:
            Path(command[-1]).write_bytes(generated_bytes)
            return subprocess.CompletedProcess(command, 0)

        with (
            patch.object(mpeg2_vector, "OUTPUT_PATH", installed_path),
            patch.object(
                mpeg2_vector.subprocess,
                "run",
                side_effect=write_generated_output,
            ),
        ):
            return mpeg2_vector.generate_vector(Path("ffmpeg.exe"), check=check)

    def test_never_installs_output_that_differs_from_the_committed_vector(self) -> None:
        for check in (True, False):
            with self.subTest(check=check), tempfile.TemporaryDirectory() as temporary_directory:
                installed_path = Path(temporary_directory) / "vector.mkv"
                installed_path.write_bytes(b"committed vector")
                with self.assertRaisesRegex(
                    GeneratedOutputError,
                    "differs from the committed bytes",
                ):
                    self.generate_with_output(
                        b"other FFmpeg output",
                        installed_path,
                        check=check,
                    )

                self.assertEqual(installed_path.read_bytes(), b"committed vector")

    def test_generation_installs_a_missing_vector(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            installed_path = Path(temporary_directory) / "vector.mkv"

            self.assertTrue(
                self.generate_with_output(b"regenerated vector", installed_path, check=False)
            )
            self.assertEqual(installed_path.read_bytes(), b"regenerated vector")


if __name__ == "__main__":
    unittest.main()
