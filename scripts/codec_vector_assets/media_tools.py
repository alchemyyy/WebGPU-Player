"""Locates and runs FFmpeg and MKVToolNix, and compares file paths, for the Dolby Vision vector scripts."""

from __future__ import annotations

import errno
import os
import subprocess
import sys
from typing import Final, Sequence


# A tool writing more than this to either stream is treated as failed
MAXIMUM_TOOL_OUTPUT_BYTE_LENGTH: Final = 16 * 1_024 * 1_024
MKVTOOLNIX_PROGRAM_DIRECTORY_NAME: Final = "MKVToolNix"


class ToolError(RuntimeError):
    """Reports a tool that failed or wrote more output than the bound allows."""


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


def refers_to_same_file(first_path: str, second_path: str) -> bool:
    """Returns whether two paths name the same file, matching case where the platform ignores it."""

    if os.path.normcase(os.path.abspath(first_path)) == os.path.normcase(os.path.abspath(second_path)):
        return True
    try:
        # Catches links and alternate names, such as 8.3 short names, once both files exist
        return os.path.samefile(first_path, second_path)
    except OSError:
        return False
