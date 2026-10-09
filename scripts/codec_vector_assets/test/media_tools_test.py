"""Tests the tool resolution, the bounded tool runner, the pinned FFmpeg check, and the JSON and bit-packing helpers the vector scripts share."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Sequence
from unittest.mock import patch


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import media_tools  # noqa: E402


# The version output of the pinned build, with the library lines the check reads
PINNED_FFMPEG_VERSION_OUTPUT = (
    "ffmpeg version 2026-03-01-git-862338fe31-full_build-www.gyan.dev Copyright (c) 2000-2026\n"
    "libavcodec     62. 24.100 / 62. 24.100\n"
    "libavformat    62. 10.101 / 62. 10.101\n"
    "libavfilter    11. 12.100 / 11. 12.100\n"
)
PINNED_FFPROBE_VERSION_OUTPUT = "ffprobe version 2026-03-01-git-862338fe31-full_build-www.gyan.dev\n"


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


class ToolchainTests(unittest.TestCase):
    """Covers the pinned FFmpeg and FFprobe builds the encoding generators require."""

    def check_toolchain_with(self, FFmpeg_output: str, FFprobe_output: str) -> None:
        """Runs the toolchain check against fixed version output."""

        def execute_tool(executable: str, arguments: Sequence[str]) -> str:
            return FFmpeg_output if executable == "ffmpeg" else FFprobe_output

        with patch.object(media_tools, "execute_tool", side_effect=execute_tool):
            media_tools.check_toolchain(media_tools.MediaTools(FFmpeg_path="ffmpeg", FFprobe_path="ffprobe"))

    def test_accepts_only_the_pinned_build(self) -> None:
        self.check_toolchain_with(PINNED_FFMPEG_VERSION_OUTPUT, PINNED_FFPROBE_VERSION_OUTPUT)
        cases = (
            (PINNED_FFMPEG_VERSION_OUTPUT.replace("862338fe31", "0123456789"), PINNED_FFPROBE_VERSION_OUTPUT, "FFmpeg must be"),
            (PINNED_FFMPEG_VERSION_OUTPUT.replace("62. 10.101", "62. 11.100"), PINNED_FFPROBE_VERSION_OUTPUT, "FFmpeg must be"),
            (PINNED_FFMPEG_VERSION_OUTPUT.replace("11. 12.100", "11. 13.100"), PINNED_FFPROBE_VERSION_OUTPUT, "FFmpeg must be"),
            (PINNED_FFMPEG_VERSION_OUTPUT, PINNED_FFPROBE_VERSION_OUTPUT.replace("2026-03-01", "2026-03-02"), "FFprobe must be"),
        )
        for FFmpeg_output, FFprobe_output, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(media_tools.VectorGenerationError, message):
                    self.check_toolchain_with(FFmpeg_output, FFprobe_output)


class JSONCheckTests(unittest.TestCase):
    """Covers the compact JSON diagnostics and the equality check that compares JSON text."""

    def test_formats_compact_JSON(self) -> None:
        self.assertEqual(media_tools.format_JSON({"frames": [1, None, "K"]}), '{"frames":[1,null,"K"]}')

    def test_tells_true_from_1_and_reports_both_values(self) -> None:
        # A tuple and a list write the same JSON text
        media_tools.require_equal((1, "K"), [1, "K"], "packet")
        with self.assertRaisesRegex(media_tools.VectorGenerationError, "^key frame mismatch: expected 1, got true$"):
            media_tools.require_equal(True, 1, "key frame")


class BitPackingTests(unittest.TestCase):
    """Covers packing fields most significant bit first and padding the last byte."""

    def test_packs_fields_and_pads_with_the_requested_bit(self) -> None:
        self.assertEqual(media_tools.pack_bit_fields(((0b101, 3),), padding_bit=1), bytes((0b1011_1111,)))
        self.assertEqual(media_tools.pack_bit_fields(((0b101, 3),), padding_bit=0), bytes((0b1010_0000,)))
        self.assertEqual(media_tools.pack_bit_fields(((0x3B, 16), (1, 1)), padding_bit=0), bytes((0x00, 0x3B, 0x80)))
        self.assertEqual(media_tools.pack_bit_fields(((0xAB, 8),), padding_bit=1), bytes((0xAB,)))

    def test_rejects_a_value_wider_than_its_field(self) -> None:
        for field in ((2, 1), (-1, 8), (256, 8)):
            with self.subTest(field=field):
                with self.assertRaises(ValueError):
                    media_tools.pack_bit_fields((field,), padding_bit=0)


if __name__ == "__main__":
    unittest.main()
