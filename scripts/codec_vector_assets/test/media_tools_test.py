"""Tests FFmpeg and MKVToolNix resolution and the bounded tool runner shared by the Dolby Vision scripts."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import media_tools  # noqa: E402


def create_empty_file(path: Path) -> Path:
    """Creates one empty file, with its directory, and returns its path."""

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")
    return path


class FFmpegResolutionTests(unittest.TestCase):
    """Covers the bare executable names and configured ffmpeg and ffprobe paths."""

    def test_resolves_the_bare_executable_without_a_configured_path(self) -> None:
        with patch.object(sys, "platform", "win32"):
            self.assertEqual(media_tools.resolve_FFmpeg_tool("ffmpeg", None), "ffmpeg.exe")
            self.assertEqual(media_tools.resolve_FFmpeg_tool("ffmpeg", ""), "ffmpeg.exe")
            self.assertEqual(media_tools.resolve_FFmpeg_tool("ffprobe", None), "ffprobe.exe")
        with patch.object(sys, "platform", "linux"):
            self.assertEqual(media_tools.resolve_FFmpeg_tool("ffmpeg", None), "ffmpeg")
            self.assertEqual(media_tools.resolve_FFmpeg_tool("ffprobe", None), "ffprobe")

    def test_requires_a_configured_path_to_exist(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            executable_path = Path(temporary_directory) / "ffprobe.exe"
            with self.assertRaises(FileNotFoundError):
                media_tools.resolve_FFmpeg_tool("ffprobe", str(executable_path))

            create_empty_file(executable_path)
            self.assertEqual(
                media_tools.resolve_FFmpeg_tool("ffprobe", str(executable_path)),
                str(executable_path),
            )


class SameFileTests(unittest.TestCase):
    """Covers recognizing two paths that name one file."""

    def test_matches_equal_and_equivalent_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            file_path = Path(temporary_directory) / "vector.mkv"
            self.assertTrue(media_tools.refers_to_same_file(str(file_path), str(file_path)))
            self.assertTrue(
                media_tools.refers_to_same_file(
                    str(file_path),
                    os.path.join(temporary_directory, "nested", "..", "vector.mkv"),
                )
            )

    def test_matches_a_case_variant_where_the_platform_ignores_case(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            file_path = os.path.join(temporary_directory, "vector.mkv")
            upper_case_path = os.path.join(temporary_directory, "VECTOR.MKV")
            case_insensitive = os.path.normcase(file_path) == os.path.normcase(upper_case_path)
            self.assertEqual(media_tools.refers_to_same_file(file_path, upper_case_path), case_insensitive)

    def test_matches_a_hard_link_to_an_existing_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            file_path = create_empty_file(Path(temporary_directory) / "vector.mkv")
            link_path = Path(temporary_directory) / "link.mkv"
            os.link(file_path, link_path)
            self.assertTrue(media_tools.refers_to_same_file(str(file_path), str(link_path)))

    def test_rejects_different_files_and_missing_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            file_path = create_empty_file(Path(temporary_directory) / "vector.mkv")
            other_path = create_empty_file(Path(temporary_directory) / "other.mkv")
            self.assertFalse(media_tools.refers_to_same_file(str(file_path), str(other_path)))
            self.assertFalse(
                media_tools.refers_to_same_file(str(file_path), str(Path(temporary_directory) / "output.mkv"))
            )


class MKVToolNixResolutionTests(unittest.TestCase):
    """Covers the configured directory, then ProgramFiles on Windows, then the bare name."""

    def test_prefers_the_configured_directory_then_program_files_then_PATH(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            configured_directory = Path(temporary_directory) / "configured"
            program_files_directory = Path(temporary_directory) / "program-files"
            installed_directory = program_files_directory / "MKVToolNix"
            configured_directory.mkdir()
            installed_directory.mkdir(parents=True)
            with (
                patch.object(sys, "platform", "win32"),
                patch.dict(os.environ, {"ProgramFiles": str(program_files_directory)}),
            ):
                self.assertEqual(
                    media_tools.resolve_MKVToolNix_tool("mkvmerge", str(configured_directory)),
                    "mkvmerge.exe",
                )
                installed_path = create_empty_file(installed_directory / "mkvmerge.exe")
                self.assertEqual(
                    media_tools.resolve_MKVToolNix_tool("mkvmerge", str(configured_directory)),
                    str(installed_path),
                )
                configured_path = create_empty_file(configured_directory / "mkvmerge.exe")
                self.assertEqual(
                    media_tools.resolve_MKVToolNix_tool("mkvmerge", str(configured_directory)),
                    str(configured_path),
                )
                self.assertEqual(
                    media_tools.resolve_MKVToolNix_tool("mkvextract", str(configured_directory)),
                    "mkvextract.exe",
                )

    def test_normalizes_the_resolved_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            configured_directory = Path(temporary_directory) / "configured"
            configured_path = create_empty_file(configured_directory / "mkvmerge.exe")
            unnormalized_directory = os.path.join(str(configured_directory), "nested", "..")
            with patch.object(sys, "platform", "win32"):
                self.assertEqual(
                    media_tools.resolve_MKVToolNix_tool("mkvmerge", unnormalized_directory),
                    str(configured_path),
                )

    def test_ignores_program_files_outside_Windows(self) -> None:
        with tempfile.TemporaryDirectory() as program_files_directory:
            create_empty_file(Path(program_files_directory) / "MKVToolNix" / "mkvmerge")
            with (
                patch.object(sys, "platform", "linux"),
                patch.dict(os.environ, {"ProgramFiles": program_files_directory}),
            ):
                self.assertEqual(media_tools.resolve_MKVToolNix_tool("mkvmerge", None), "mkvmerge")


class ToolExecutionTests(unittest.TestCase):
    """Covers the command line, failed commands, and the tool output bound."""

    def test_runs_the_argument_list_without_inherited_input_and_returns_its_output(self) -> None:
        completed_process = subprocess.CompletedProcess(["mkvmerge"], 0, stdout=b"{}\n", stderr=b"")
        with patch.object(subprocess, "run", return_value=completed_process) as mocked_run:
            standard_output = media_tools.execute_tool("mkvmerge", ["-J", "input.mkv"])

        mocked_run.assert_called_once_with(
            ["mkvmerge", "-J", "input.mkv"],
            capture_output=True,
            check=False,
            stdin=subprocess.DEVNULL,
        )
        self.assertEqual(standard_output, "{}\n")

    def test_reports_a_failed_command_with_its_diagnostics(self) -> None:
        failed_process = subprocess.CompletedProcess(
            ["ffmpeg", "-i", "input.mkv"],
            1,
            stdout=b"",
            stderr=b"input.mkv: Invalid data\n",
        )
        with (
            patch.object(subprocess, "run", return_value=failed_process),
            self.assertRaises(media_tools.ToolError) as raised,
        ):
            media_tools.execute_tool("ffmpeg", ["-i", "input.mkv"])

        self.assertEqual(
            str(raised.exception),
            "Command failed: ffmpeg -i input.mkv\ninput.mkv: Invalid data\n",
        )

    def test_rejects_output_beyond_the_tool_output_bound(self) -> None:
        bound = media_tools.MAXIMUM_TOOL_OUTPUT_BYTE_LENGTH
        for stream_name in ("stdout", "stderr"):
            with self.subTest(stream_name=stream_name):
                flooded_output = {"stdout": b"", "stderr": b"", stream_name: b"x" * (bound + 1)}
                flooded_process = subprocess.CompletedProcess(["ffmpeg"], 0, **flooded_output)
                with (
                    patch.object(subprocess, "run", return_value=flooded_process),
                    self.assertRaises(media_tools.ToolError) as raised,
                ):
                    media_tools.execute_tool("ffmpeg", [])
                self.assertEqual(str(raised.exception), f"{stream_name} maxBuffer length exceeded")

        bounded_process = subprocess.CompletedProcess(["ffmpeg"], 0, stdout=b"x" * bound, stderr=b"")
        with patch.object(subprocess, "run", return_value=bounded_process):
            self.assertEqual(len(media_tools.execute_tool("ffmpeg", [])), bound)


if __name__ == "__main__":
    unittest.main()
