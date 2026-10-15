#!/usr/bin/env python3
"""Generate the self-test vectors of every decoder project in decoders/.

A project's decoder.json lists its vectors under "vectors": each one's output format, its source media as a folder key of
tools/constants.json and a path in that folder, and optionally the FFmpeg decoder options of the reference decode ("decoderOptions").
Named projects are generated alone; with none named, every project is. For each project that lists any, this writes <project>/<project>.vectors,
the vectors section its package build packs. A vector holds its source's packets as FFprobe demuxes them, its frame range,
and the SHA-256 of FFmpeg's decode of every frame in presentation order, each plane's visible samples packed row after row
as the engine's vector check packs them.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import struct
import subprocess
import sys
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Final, Sequence

from engine_layout import DECODERS_DIRECTORY, ENGINE_ROOT, LAYOUT, SOURCE_DIRECTORY
from generated_output import GeneratedOutputError, write_or_check_output


# The engine's reader declares the section's magic and version, which the generated sections carry
PACKAGE_FORMAT: Final[dict[str, Any]] = json.loads(
    (SOURCE_DIRECTORY / "decode" / "packages" / "DecoderPackageFormat.json").read_text(encoding="utf-8")
)
SECTION_MAGIC: Final[int] = PACKAGE_FORMAT["vectorsMagic"]
SECTION_VERSION: Final[int] = PACKAGE_FORMAT["vectorsVersion"]
PROJECT_FILE_NAME: Final = "decoder.json"
SECTION_SUFFIX: Final = ".vectors"
WORD: Final = struct.Struct("<I")
MAXIMUM_WORD_VALUE: Final = 0xFFFF_FFFF
KEYFRAME_FLAG: Final = 1
FFPROBE_KEYFRAME_FLAG: Final = "K"
MICROSECONDS_PER_SECOND: Final = 1_000_000
FIRST_CHECKED_FRAME: Final = 0


class VectorGenerationError(RuntimeError):
    """Reports a source the generator cannot turn into a vector."""


@dataclass(frozen=True)
class OutputFormat:
    """An engine output format, the FFmpeg pixel format that decodes to the same planes, and its sample layout."""

    bytes_per_sample: int
    chroma_height_divisor: int
    chroma_width_divisor: int
    name: str
    pixel_format: str


# Every format a GPU decoder writes, in the engine's order
OUTPUT_FORMATS: Final = (
    OutputFormat(bytes_per_sample=1, chroma_height_divisor=2, chroma_width_divisor=2, name="I420", pixel_format="yuv420p"),
    OutputFormat(bytes_per_sample=2, chroma_height_divisor=2, chroma_width_divisor=2, name="I420P10", pixel_format="yuv420p10le"),
    OutputFormat(bytes_per_sample=2, chroma_height_divisor=2, chroma_width_divisor=2, name="I420P12", pixel_format="yuv420p12le"),
    OutputFormat(bytes_per_sample=1, chroma_height_divisor=1, chroma_width_divisor=2, name="I422", pixel_format="yuv422p"),
    OutputFormat(bytes_per_sample=2, chroma_height_divisor=1, chroma_width_divisor=2, name="I422P10", pixel_format="yuv422p10le"),
    OutputFormat(bytes_per_sample=2, chroma_height_divisor=1, chroma_width_divisor=2, name="I422P12", pixel_format="yuv422p12le"),
    OutputFormat(bytes_per_sample=1, chroma_height_divisor=1, chroma_width_divisor=1, name="I444", pixel_format="yuv444p"),
    OutputFormat(bytes_per_sample=2, chroma_height_divisor=1, chroma_width_divisor=1, name="I444P10", pixel_format="yuv444p10le"),
    OutputFormat(bytes_per_sample=2, chroma_height_divisor=1, chroma_width_divisor=1, name="I444P12", pixel_format="yuv444p12le"),
)


def get_output_format(name: str) -> OutputFormat:
    """Returns the output format of an engine format name."""

    for output_format in OUTPUT_FORMATS:
        if output_format.name == name:
            return output_format
    raise VectorGenerationError(f"No engine output format is named {name}")


@dataclass(frozen=True)
class VectorSource:
    """One vector: the media whose packets and decode it holds, the format FFmpeg decodes that media to, and FFmpeg's decoder options."""

    # FFmpeg input options that pick the reference decode a GPU decoder matches, such as a codec's bit-exact inverse transform
    decoder_options: tuple[str, ...]
    output_format: OutputFormat
    path: Path


@dataclass(frozen=True)
class DecoderProject:
    """A decoder project that lists vectors, and the vectors section its package build packs."""

    name: str
    section_path: Path
    sources: tuple[VectorSource, ...]


@dataclass(frozen=True)
class VectorPacket:
    """One packet in decode order, with its presentation timestamp."""

    data: bytes
    duration_microseconds: int
    keyframe: bool
    timestamp_microseconds: int


@dataclass(frozen=True)
class Vector:
    """One vector as the section stores it, with its checked frame range and their hash."""

    codec_private: bytes
    frame_count: int
    height: int
    output_format: OutputFormat
    packets: tuple[VectorPacket, ...]
    sha256: str
    width: int


def read_source(project_name: str, declaration: dict[str, Any]) -> VectorSource:
    """Reads one vector declaration: its format, its media as a layout folder key and a path in that folder, and optional FFmpeg decoder options."""

    label = f"{project_name}: vector {declaration}"
    decoder_options = declaration.get("decoderOptions", [])
    if not isinstance(decoder_options, list) or not all(isinstance(option, str) for option in decoder_options):
        raise VectorGenerationError(f"{label}: decoderOptions must be a list of FFmpeg option strings")
    try:
        root = LAYOUT[declaration["root"]]
        return VectorSource(
            decoder_options=tuple(decoder_options),
            output_format=get_output_format(declaration["format"]),
            path=ENGINE_ROOT / root / declaration["path"],
        )
    except (KeyError, TypeError) as error:
        raise VectorGenerationError(f"{label} needs a format, a root of tools/constants.json, and a path") from error


def read_projects() -> list[DecoderProject]:
    """Returns every decoder project that lists vectors, by name."""

    projects: list[DecoderProject] = []
    for project_file in sorted(DECODERS_DIRECTORY.glob(f"*/{PROJECT_FILE_NAME}")):
        name = project_file.parent.name
        declarations = json.loads(project_file.read_text(encoding="utf-8")).get("vectors", [])
        if not declarations:
            continue
        projects.append(DecoderProject(
            name=name,
            section_path=project_file.parent / f"{name}{SECTION_SUFFIX}",
            sources=tuple(read_source(name, declaration) for declaration in declarations),
        ))
    return projects


def run_binary_command(command: str, arguments: Sequence[str]) -> bytes:
    """Requires a command to succeed and returns its raw standard output."""

    try:
        result = subprocess.run([command, *arguments], capture_output=True, check=False, stdin=subprocess.DEVNULL)
    except OSError as error:
        raise VectorGenerationError(f"{command} failed: {error}") from error
    if result.returncode != 0:
        raise VectorGenerationError(f"{command} failed:\n{result.stderr.decode('utf-8', errors='replace')}")
    return result.stdout


def decode_base64(text: str) -> bytes:
    """Decodes FFprobe's base64 data dump, which may wrap its lines."""

    return base64.b64decode("".join(text.split()))


def to_microseconds(value: int, time_base: Fraction, label: str) -> int:
    """Converts a time in time_base units to whole microseconds, rounding half up, as a section word."""

    microseconds = math.floor(value * time_base * MICROSECONDS_PER_SECOND + Fraction(1, 2))
    if microseconds < 0 or microseconds > MAXIMUM_WORD_VALUE:
        raise VectorGenerationError(f"{label} {microseconds} us is outside a section word")
    return microseconds


def read_packets(packets: Sequence[dict[str, Any]], time_base: Fraction) -> tuple[VectorPacket, ...]:
    """Reads FFprobe's packets in decode order.

    A packet's timestamp is its presentation timestamp, else its decode timestamp.
    A raw stream has neither, so each of its packets starts where the one before it ends, which holds for a stream that decodes in presentation order, as the raw sources do.
    """

    vector_packets: list[VectorPacket] = []
    next_timestamp_microseconds = 0
    for packet_index, packet in enumerate(packets):
        label = f"packet {packet_index}"
        data = decode_base64(packet.get("data", ""))
        if not data:
            raise VectorGenerationError(f"{label} is empty")
        duration_microseconds = to_microseconds(int(packet.get("duration", 0)), time_base, f"{label} duration")
        timestamp = packet.get("pts", packet.get("dts"))
        timestamp_microseconds = (
            next_timestamp_microseconds if timestamp is None else to_microseconds(int(timestamp), time_base, f"{label} timestamp")
        )
        vector_packets.append(VectorPacket(
            data=data,
            duration_microseconds=duration_microseconds,
            keyframe=FFPROBE_KEYFRAME_FLAG in packet.get("flags", ""),
            timestamp_microseconds=timestamp_microseconds,
        ))
        next_timestamp_microseconds = timestamp_microseconds + duration_microseconds
    return tuple(vector_packets)


def get_frame_byte_length(output_format: OutputFormat, width: int, height: int) -> int:
    """Returns the bytes one frame's planes take, chroma sizes rounded up as FFmpeg sizes them."""

    chroma_width = math.ceil(width / output_format.chroma_width_divisor)
    chroma_height = math.ceil(height / output_format.chroma_height_divisor)
    return (width * height + 2 * chroma_width * chroma_height) * output_format.bytes_per_sample


def probe_source(path: Path) -> dict[str, Any]:
    """Returns FFprobe's view of the first video stream: the stream with its codec private data, and its packets with their data."""

    output = run_binary_command(
        "ffprobe",
        (
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_streams",
            "-show_packets",
            "-show_data",
            "-data_dump_format",
            "base64",
            "-of",
            "json",
            str(path),
        ),
    )
    return json.loads(output.decode("utf-8"))


def decode_source(path: Path, output_format: OutputFormat, decoder_options: Sequence[str]) -> bytes:
    """Returns FFmpeg's decode of every frame of the first video stream in presentation order, as raw planes in the format's pixel format."""

    return run_binary_command(
        "ffmpeg",
        (
            "-v",
            "error",
            *decoder_options,
            "-i",
            str(path),
            "-map",
            "0:v:0",
            "-fps_mode",
            "passthrough",
            "-f",
            "rawvideo",
            "-pix_fmt",
            output_format.pixel_format,
            "pipe:1",
        ),
    )


def read_vector(source: VectorSource) -> Vector:
    """Demuxes a source into a vector and hashes FFmpeg's decode of all of its frames."""

    label = source.path.name
    if not source.path.is_file():
        raise VectorGenerationError(f"Missing vector source {source.path}")
    probe = probe_source(source.path)
    streams = probe.get("streams", [])
    if len(streams) != 1:
        raise VectorGenerationError(f"{label}: {len(streams)} video streams")
    stream = streams[0]
    # The decoder's own pixel format, so FFmpeg converts nothing the hash then covers
    if stream.get("pix_fmt") != source.output_format.pixel_format:
        raise VectorGenerationError(f"{label}: pixel format {stream.get('pix_fmt')}, expected {source.output_format.pixel_format}")
    width = int(stream["width"])
    height = int(stream["height"])
    time_base = Fraction(stream["time_base"])
    packets = read_packets(probe.get("packets", []), time_base)
    if not packets:
        raise VectorGenerationError(f"{label}: no packets")
    decoded = decode_source(source.path, source.output_format, source.decoder_options)
    frame_byte_length = get_frame_byte_length(source.output_format, width, height)
    if not decoded or len(decoded) % frame_byte_length != 0:
        raise VectorGenerationError(f"{label}: {len(decoded)} decoded bytes are not whole {frame_byte_length}-byte frames")
    return Vector(
        codec_private=decode_base64(stream.get("extradata", "")),
        frame_count=len(decoded) // frame_byte_length,
        height=height,
        output_format=source.output_format,
        packets=packets,
        sha256=hashlib.sha256(decoded).hexdigest(),
        width=width,
    )


def pad_to_word(data: bytes) -> bytes:
    """Pads data with zero bytes to whole section words."""

    return data + bytes(-len(data) % WORD.size)


def encode_vector(vector: Vector) -> bytes:
    """Encodes one vector's section entry: its format name, size, checked frames and their hash, codec private data, and packets."""

    format_name = vector.output_format.name.encode("ascii")
    parts = [
        WORD.pack(len(format_name)),
        pad_to_word(format_name),
        WORD.pack(vector.width),
        WORD.pack(vector.height),
        WORD.pack(FIRST_CHECKED_FRAME),
        WORD.pack(vector.frame_count - 1),
        bytes.fromhex(vector.sha256),
        WORD.pack(len(vector.codec_private)),
        pad_to_word(vector.codec_private),
        WORD.pack(len(vector.packets)),
    ]
    for packet in vector.packets:
        parts.extend((
            WORD.pack(len(packet.data)),
            WORD.pack(KEYFRAME_FLAG if packet.keyframe else 0),
            WORD.pack(packet.timestamp_microseconds),
            WORD.pack(packet.duration_microseconds),
            pad_to_word(packet.data),
        ))
    return b"".join(parts)


def encode_section(vectors: Sequence[Vector]) -> bytes:
    """Encodes a package's vectors section, each entry behind its byte length."""

    parts = [WORD.pack(SECTION_MAGIC), WORD.pack(SECTION_VERSION), WORD.pack(len(vectors))]
    for vector in vectors:
        entry = encode_vector(vector)
        parts.extend((WORD.pack(len(entry)), entry))
    return b"".join(parts)


def generate_project_vectors(project: DecoderProject, *, check: bool) -> int:
    """Writes a project's vectors section, or with check compares it with the committed file; returns its vector count."""

    vectors = [read_vector(source) for source in project.sources]
    formats = [vector.output_format.name for vector in vectors]
    if len(set(formats)) != len(formats):
        raise VectorGenerationError(f"{project.name}: repeated formats {formats}")
    write_or_check_output(project.section_path, encode_section(vectors), check=check)
    return len(vectors)


def parse_arguments(command_arguments: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail unless every committed vectors section matches its regeneration; nothing is written",
    )
    parser.add_argument("projects", nargs="*", help="The projects to generate or check; every project when none is named")
    return parser.parse_args(command_arguments)


def select_projects(projects: Sequence[DecoderProject], names: Sequence[str]) -> list[DecoderProject]:
    """Returns the named projects, or every project when no name is given; an unknown name fails."""

    if not names:
        return list(projects)
    known_names = {project.name for project in projects}
    unknown_names = sorted(set(names) - known_names)
    if unknown_names:
        raise VectorGenerationError(f"No decoder project with vectors named {', '.join(unknown_names)}")
    return [project for project in projects if project.name in names]


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Generates or checks the decoder projects' vectors and returns the process exit status."""

    arguments = parse_arguments(command_arguments)
    try:
        projects = select_projects(read_projects(), arguments.projects)
        vector_count = sum(generate_project_vectors(project, check=arguments.check) for project in projects)
    except (VectorGenerationError, GeneratedOutputError, OSError, KeyError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1
    action = "Verified" if arguments.check else "Generated"
    print(f"{action} {vector_count} self-test vectors of {len(projects)} decoder projects in {DECODERS_DIRECTORY}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
