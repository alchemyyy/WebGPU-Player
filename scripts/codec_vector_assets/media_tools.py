"""Locates, runs, and pins FFmpeg and MKVToolNix for the vector scripts, and compares file paths.

It also holds what the vector generators share: the error they raise, JSON equality checks, and bit packing.
"""

from __future__ import annotations

import errno
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from typing import Final, Sequence


# A tool writing more than this to either stream is treated as failed
MAXIMUM_TOOL_OUTPUT_BYTE_LENGTH: Final = 16 * 1_024 * 1_024
MKVTOOLNIX_PROGRAM_DIRECTORY_NAME: Final = "MKVToolNix"
REQUIRED_FFMPEG_VERSION: Final = "2026-03-01-git-862338fe31-full_build-www.gyan.dev"
# The libraries that decode, filter, encode, and mux the vectors
REQUIRED_LIBRARY_VERSION_PATTERNS: Final = (
    re.compile(r"libavcodec\s+62\.\s*24\.100"),
    re.compile(r"libavformat\s+62\.\s*10\.101"),
    re.compile(r"libavfilter\s+11\.\s*12\.100"),
)

BitField = tuple[int, int]


class ToolError(RuntimeError):
    """Reports a tool that failed or wrote more output than the bound allows."""


class VectorGenerationError(RuntimeError):
    """Reports a vector that cannot be generated or fails its verification."""


@dataclass(frozen=True)
class MediaTools:
    """Names the FFmpeg and FFprobe executables."""

    FFmpeg_path: str
    FFprobe_path: str


def get_executable_name(tool_name: str) -> str:
    """Returns the platform's executable file name for a tool."""

    return f"{tool_name}.exe" if sys.platform == "win32" else tool_name


def resolve_FFmpeg_tool(tool_name: str, configured_path: str | None) -> str:
    """Returns the configured ffmpeg or ffprobe after checking that it exists, otherwise the bare executable name."""

    if not configured_path:
        return get_executable_name(tool_name)
    if not os.access(configured_path, os.F_OK):
        raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), configured_path)
    return configured_path


def resolve_MKVToolNix_tool(tool_name: str, configured_directory: str | None) -> str:
    """Returns an MKVToolNix executable from the configured directory, then the installed MKVToolNix on Windows.

    Without either, the bare executable name resolves through PATH when it runs.
    """

    executable_name = get_executable_name(tool_name)
    candidate_directories: list[str] = []
    if configured_directory:
        candidate_directories.append(configured_directory)
    program_files_directory = os.environ.get("ProgramFiles")
    if sys.platform == "win32" and program_files_directory:
        candidate_directories.append(os.path.join(program_files_directory, MKVTOOLNIX_PROGRAM_DIRECTORY_NAME))
    for candidate_directory in candidate_directories:
        # Normalized, so the command names a canonical path
        candidate_path = os.path.normpath(os.path.join(candidate_directory, executable_name))
        if os.access(candidate_path, os.F_OK):
            return candidate_path
    return executable_name


def execute_tool(executable: str, arguments: Sequence[str]) -> str:
    """Runs one tool, rejecting a failure or oversized output, and returns its standard output."""

    command = [executable, *arguments]
    result = subprocess.run(command, capture_output=True, check=False, stdin=subprocess.DEVNULL)
    for stream_name, output in (("stdout", result.stdout), ("stderr", result.stderr)):
        # NOTE: The bound applies once the tool exits; the tool is not stopped early
        if len(output) > MAXIMUM_TOOL_OUTPUT_BYTE_LENGTH:
            raise ToolError(f"{stream_name} maxBuffer length exceeded")
    if result.returncode != 0:
        standard_error = result.stderr.decode("utf-8", errors="replace")
        raise ToolError(f"Command failed: {' '.join(command)}\n{standard_error}")
    return result.stdout.decode("utf-8", errors="replace")


def check_toolchain(tools: MediaTools) -> None:
    """Requires the pinned FFmpeg and FFprobe builds."""

    FFmpeg_version = execute_tool(tools.FFmpeg_path, ["-hide_banner", "-version"])
    if not FFmpeg_version.startswith(f"ffmpeg version {REQUIRED_FFMPEG_VERSION}") or any(
        pattern.search(FFmpeg_version) is None for pattern in REQUIRED_LIBRARY_VERSION_PATTERNS
    ):
        raise VectorGenerationError(f"FFmpeg must be the {REQUIRED_FFMPEG_VERSION} build")
    FFprobe_version = execute_tool(tools.FFprobe_path, ["-hide_banner", "-version"])
    if not FFprobe_version.startswith(f"ffprobe version {REQUIRED_FFMPEG_VERSION}"):
        raise VectorGenerationError(f"FFprobe must be the {REQUIRED_FFMPEG_VERSION} build")


def format_JSON(value: object) -> str:
    """Returns compact JSON text for a diagnostic."""

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def require_equal(actual: object, expected: object, label: str) -> None:
    """Requires identical JSON text, which also tells true from 1, and reports both values as JSON."""

    actual_JSON = format_JSON(actual)
    expected_JSON = format_JSON(expected)
    if actual_JSON != expected_JSON:
        raise VectorGenerationError(f"{label} mismatch: expected {expected_JSON}, got {actual_JSON}")


def pack_bit_fields(fields: Sequence[BitField], *, padding_bit: int) -> bytes:
    """Packs (value, bit count) fields most significant bit first, and pads the last byte with padding_bit."""

    packed_value = 0
    bit_count = 0
    for field_value, field_bit_count in fields:
        if field_value < 0 or field_value >= 1 << field_bit_count:
            raise ValueError(f"{field_value} does not fit in {field_bit_count} bits")
        packed_value = (packed_value << field_bit_count) | field_value
        bit_count += field_bit_count
    padding_bit_count = -bit_count % 8
    packed_value = (packed_value << padding_bit_count) | (((1 << padding_bit_count) - 1) if padding_bit else 0)
    return packed_value.to_bytes((bit_count + padding_bit_count) // 8, "big")


def refers_to_same_file(first_path: str, second_path: str) -> bool:
    """Returns whether two paths name the same file, matching case where the platform ignores it."""

    if os.path.normcase(os.path.abspath(first_path)) == os.path.normcase(os.path.abspath(second_path)):
        return True
    try:
        # Catches links and alternate names, such as 8.3 short names, once both files exist
        return os.path.samefile(first_path, second_path)
    except OSError:
        return False
