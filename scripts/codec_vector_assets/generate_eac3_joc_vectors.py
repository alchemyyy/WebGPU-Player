#!/usr/bin/env python3
"""Generate the E-AC-3 decoder project's Dolby Atmos vectors and FFmpeg's known answers for them, or verify both with --check.

No encoder writes E-AC-3 with joint object coding (JOC) but Dolby's, so the vectors are remuxes of freely licensed streams, each
downloaded at a pinned commit over HTTPS and required to have its pinned SHA-256:
- androidx/media's sample_eac3joc.ec3 (Apache-2.0), a Dolby encode: a 5.1 core, 15 JOC objects, and OAMD of a 5.1 bed and 10 dynamic
  objects, its EMDF containers in audio-block skip fields. The vector keeps its first packets.
- OpenJOC's idx2.ec3 (Apache-2.0), a synthetic encode: a 5.1 independent substream with a dependent one adding the top front pair,
  JOC downmix configuration 2 (seven channels), its EMDF container in the dependent substream's auxiliary data.

The known answers are FFmpeg's whole decode of each vector with its C code (-cpuflags 0), as interleaved 32-bit float: the stock decode
the package outputs whenever its target needs no objects.

The muxer's bytes depend on the FFmpeg build, so the generator refuses any but the pinned one, and an existing vector is only compared,
never replaced. The known answers are rewritten from the committed vectors, and with --check must match.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Sequence

from engine_layout import DECODERS_DIRECTORY
from generated_output import GeneratedOutputError, install_or_check_output, write_or_check_output
from media_tools import (
    REQUIRED_FFMPEG_VERSION,
    MediaTools,
    ToolError,
    VectorGenerationError,
    check_toolchain,
    execute_tool,
    require_equal,
    resolve_FFmpeg_tool,
)


VECTOR_DIRECTORY: Final = DECODERS_DIRECTORY / "eac3" / "vectors"
KNOWN_ANSWERS_FILE_NAME: Final = "known-answers.json"
DOWNLOAD_TIMEOUT_SECONDS: Final = 120
# The reference decode: FFmpeg's C code, without the assembly a CPU's flags select
REFERENCE_DECODER_OPTIONS: Final = ("-cpuflags", "0")
FLOAT_BYTE_LENGTH: Final = 4
ATMOS_PROFILE: Final = "Dolby Digital Plus + Dolby Atmos"
BITEXACT_ARGUMENTS: Final = ("-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact")
# The WAVE channel masks of the layouts FFprobe names for the vectors' decoded frames, by FFmpeg's libavutil/channel_layout.c names
NAMED_LAYOUT_MASKS: Final = {"5.1(side)": 0x60F, "5.1.2": 0x560F}


@dataclass(frozen=True)
class Source:
    """A freely licensed stream: its URL at a pinned commit and its pinned SHA-256."""

    url: str
    sha256: str


@dataclass(frozen=True)
class Vector:
    """One vector: its file, the first packets of a source it remuxes into Matroska, and what FFprobe must read of it."""

    file_name: str
    source: Source
    packet_count: int
    channel_count: int


ANDROIDX_JOC: Final = Source(
    "https://raw.githubusercontent.com/androidx/media/8c6678b657ede1e7883fc164ef73ed483c7796c3/"
    "libraries/test_data/src/test/assets/media/ts/sample_eac3joc.ec3",
    "32fdd125ed45e6a34e2684e2cb9e81c0612113413a6d4aceac018b815d512edc",
)
OPENJOC_DEPENDENT_JOC: Final = Source(
    "https://raw.githubusercontent.com/chyinan/OpenJOC/e3e330a2000f8d0bced3460756473c8774eb16f0/"
    "crates/openjoc-api/tests/fixtures/admission/idx2.ec3",
    "8e28e1c017c287e7e6d215fb67457b4503611c04e7402850d826cb57049b9b87",
)

VECTORS: Final = (
    Vector("joc-5.1.mkv", ANDROIDX_JOC, 16, 6),
    Vector("joc-5.1.2-dependent.mkv", OPENJOC_DEPENDENT_JOC, 1, 8),
)


def parse_arguments(command_arguments: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail unless the committed vectors and known answers match a fresh run")
    parser.add_argument("--ffmpeg", help="The FFmpeg executable, ffmpeg on PATH by default")
    parser.add_argument("--ffprobe", help="The FFprobe executable, ffprobe on PATH by default")
    return parser.parse_args(command_arguments)


def download_source(source: Source, directory: Path) -> Path:
    """Downloads a source once into the directory, requiring its pinned SHA-256."""

    path = directory / Path(source.url).name
    if not path.exists():
        with urllib.request.urlopen(source.url, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            content = response.read()
        digest = hashlib.sha256(content).hexdigest()
        if digest != source.sha256:
            raise VectorGenerationError(f"{source.url} has SHA-256 {digest}, not {source.sha256}")
        path.write_bytes(content)
    return path


def read_packet_hashes(tools: MediaTools, path: Path, input_format: Sequence[str] = ()) -> list[str]:
    """Returns the SHA-256 of each audio packet FFprobe reads from a file."""

    probe = json.loads(execute_tool(tools.FFprobe_path, [
        "-hide_banner", "-loglevel", "error", *input_format, "-select_streams", "a", "-show_data_hash", "SHA256",
        "-show_entries", "packet=data_hash", "-of", "json", str(path),
    ]))
    return [packet["data_hash"] for packet in probe["packets"]]


def write_vector(tools: MediaTools, vector: Vector, directory: Path) -> Path:
    """Remuxes the first packets of a vector's source into Matroska in the directory, and checks them against the source's."""

    source_path = download_source(vector.source, directory)
    path = directory / vector.file_name
    execute_tool(tools.FFmpeg_path, [
        "-hide_banner", "-loglevel", "error", "-y", "-f", "eac3", "-i", str(source_path), "-map", "0:a", "-c", "copy",
        "-frames:a", str(vector.packet_count), *BITEXACT_ARGUMENTS, "-f", "matroska", str(path),
    ])
    source_hashes = read_packet_hashes(tools, source_path, ("-f", "eac3"))[:vector.packet_count]
    require_equal(read_packet_hashes(tools, path), source_hashes, f"{vector.file_name} packets")
    return path


def verify_vector(tools: MediaTools, vector: Vector, path: Path) -> None:
    """Requires FFprobe to read one E-AC-3 stream with FFmpeg's Atmos profile, its channels, and its packets."""

    probe = json.loads(execute_tool(tools.FFprobe_path, [
        "-hide_banner", "-loglevel", "error", "-count_packets",
        "-show_entries", "stream=codec_name,profile,sample_rate,channels,nb_read_packets", "-of", "json", str(path),
    ]))
    require_equal(len(probe["streams"]), 1, f"{vector.file_name} streams")
    stream = probe["streams"][0]
    require_equal(stream["codec_name"], "eac3", f"{vector.file_name} codec")
    require_equal(stream["profile"], ATMOS_PROFILE, f"{vector.file_name} profile")
    require_equal(int(stream["sample_rate"]), 48_000, f"{vector.file_name} sample rate")
    require_equal(stream["channels"], vector.channel_count, f"{vector.file_name} channels")
    require_equal(int(stream["nb_read_packets"]), vector.packet_count, f"{vector.file_name} packets")


def create_known_answer(tools: MediaTools, vector: Vector, path: Path, directory: Path) -> dict[str, Any]:
    """Returns a vector's known answer: its decoded channels and channel mask, and the frame count and SHA-256 of FFmpeg's PCM."""

    probe = json.loads(execute_tool(tools.FFprobe_path, [
        "-hide_banner", "-loglevel", "error", "-show_frames", "-show_entries", "frame=nb_samples,channels,channel_layout",
        "-of", "json", str(path),
    ]))
    frame_count = sum(int(frame["nb_samples"]) for frame in probe["frames"])
    layouts = {(int(frame["channels"]), frame.get("channel_layout", "")) for frame in probe["frames"]}
    if frame_count == 0 or len(layouts) != 1:
        raise VectorGenerationError(f"{vector.file_name} decodes {frame_count} frames in the layouts {sorted(layouts)}")
    channel_count, layout = layouts.pop()
    require_equal(channel_count, vector.channel_count, f"{vector.file_name} decoded channels")
    if layout not in NAMED_LAYOUT_MASKS:
        raise VectorGenerationError(f"{vector.file_name} decodes in the layout {layout!r}, which has no mask here")
    PCM_path = directory / f"{vector.file_name}.f32"
    execute_tool(tools.FFmpeg_path, [
        "-hide_banner", "-loglevel", "error", "-y", *REFERENCE_DECODER_OPTIONS, "-c:a", "eac3", "-i", str(path),
        "-f", "f32le", str(PCM_path),
    ])
    PCM = PCM_path.read_bytes()
    require_equal(len(PCM), frame_count * channel_count * FLOAT_BYTE_LENGTH, f"{vector.file_name} PCM bytes")
    return {
        "channelCount": channel_count,
        "channelMask": NAMED_LAYOUT_MASKS[layout],
        "file": vector.file_name,
        "frameCount": frame_count,
        "pcmSHA256": hashlib.sha256(PCM).hexdigest(),
    }


def format_known_answers(known_answers: list[dict[str, Any]]) -> bytes:
    """Returns the known answers file: the FFmpeg build and decoder options, then each vector's answer."""

    document = {
        "decoderOptions": list(REFERENCE_DECODER_OPTIONS),
        "ffmpeg": REQUIRED_FFMPEG_VERSION,
        "vectors": known_answers,
    }
    return (json.dumps(document, indent=4) + "\n").encode("utf-8")


def main(command_arguments: Sequence[str] | None = None) -> int:
    arguments = parse_arguments(command_arguments)
    try:
        tools = MediaTools(resolve_FFmpeg_tool("ffmpeg", arguments.ffmpeg), resolve_FFmpeg_tool("ffprobe", arguments.ffprobe))
        check_toolchain(tools)
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            for vector in VECTORS:
                path = write_vector(tools, vector, directory)
                verify_vector(tools, vector, path)
                written = install_or_check_output(VECTOR_DIRECTORY / vector.file_name, path.read_bytes(), check=arguments.check)
                print(f"{'Wrote' if written else 'Matched'} {vector.file_name}")
            known_answers = [create_known_answer(tools, vector, VECTOR_DIRECTORY / vector.file_name, directory) for vector in VECTORS]
            write_or_check_output(VECTOR_DIRECTORY / KNOWN_ANSWERS_FILE_NAME, format_known_answers(known_answers), check=arguments.check)
            print(f"{'Matched' if arguments.check else 'Wrote'} {KNOWN_ANSWERS_FILE_NAME}")
    except (GeneratedOutputError, OSError, ToolError, VectorGenerationError) as error:
        print(f"generate_eac3_joc_vectors: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
