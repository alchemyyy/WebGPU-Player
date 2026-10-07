#!/usr/bin/env python3
"""Create a validation-only dual-track Dolby Vision Profile 7 MP4 vector."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Sequence

from media_tools import ToolError, execute_tool, refers_to_same_file, resolve_FFmpeg_tool


BASIC_BOX_HEADER_BYTE_LENGTH: Final = 8
EXTENDED_BOX_HEADER_BYTE_LENGTH: Final = 16
VISUAL_SAMPLE_ENTRY_FIELD_BYTE_LENGTH: Final = 78
# The width and height follow the 8-byte SampleEntry fields and 16 bytes of predefined and reserved fields
VISUAL_SAMPLE_ENTRY_WIDTH_OFFSET: Final = 24
VISUAL_SAMPLE_ENTRY_HEIGHT_OFFSET: Final = 26
MAXIMUM_VECTOR_BYTE_LENGTH: Final = 128 * 1_024 * 1_024
MAXIMUM_CHILD_BOX_COUNT: Final = 4_096
# Box sizes and offsets stay within 2^53 - 1, the largest exactly representable double integer
MAXIMUM_SAFE_INTEGER: Final = 2**53 - 1
BASE_HEVC_SAMPLE_ENTRY_TYPES: Final = frozenset(("hvc1", "hev1"))
DOLBY_VISION_SAMPLE_ENTRY_TYPE_BY_HEVC_TYPE: Final = {
    "hvc1": "dvh1",
    "hev1": "dvhe",
}


class VectorError(RuntimeError):
    """Reports a source that cannot become a dual-track Profile 7 vector."""


@dataclass(frozen=True)
class BMFFBox:
    """Locates one ISO base media box and its payload within a buffer."""

    box_type: str
    compact_size: int
    data_offset: int
    data_size: int
    end_offset: int
    header_byte_length: int
    start_offset: int


@dataclass(frozen=True)
class VideoTrack:
    """Holds the boxes, the track ID, and the picture size of one parsed HEVC video track."""

    dolby_vision_configuration_box: BMFFBox | None
    height: int
    sample_entry: BMFFBox
    track_box: BMFFBox
    track_header_box: BMFFBox
    track_ID: int
    width: int


@dataclass(frozen=True)
class PatchedVector:
    """Holds a patched dual-track MP4, the track roles it declares, and each layer's picture size."""

    base_height: int
    base_track_ID: int
    base_width: int
    data: bytes
    enhancement_height: int
    enhancement_sample_entry_type: str
    enhancement_track_ID: int
    enhancement_width: int


@dataclass(frozen=True)
class DualTrackVectorConfiguration:
    """Names the separate-track source, the MP4 output, and an optional FFmpeg path."""

    input_path: str
    output_path: str
    configured_FFmpeg_path: str | None = None


def read_unsigned_32(data: bytes, offset: int, end_offset: int | None = None) -> int:
    """Reads one big-endian unsigned 32-bit integer that ends within end_offset."""

    bounded_end_offset = len(data) if end_offset is None else end_offset
    if offset < 0 or offset + 4 > bounded_end_offset:
        raise VectorError("An ISO base media unsigned integer is truncated")
    return int.from_bytes(data[offset : offset + 4], "big")


def read_unsigned_16(data: bytes, offset: int, end_offset: int) -> int:
    """Reads one big-endian unsigned 16-bit integer that ends within end_offset."""

    if offset < 0 or offset + 2 > end_offset:
        raise VectorError("An ISO base media unsigned integer is truncated")
    return int.from_bytes(data[offset : offset + 2], "big")


def read_unsigned_64(data: bytes, offset: int, end_offset: int) -> int:
    """Reads one big-endian unsigned 64-bit box size within the safe integer range."""

    high_value = read_unsigned_32(data, offset, end_offset)
    low_value = read_unsigned_32(data, offset + 4, end_offset)
    value = (high_value * 0x1_0000_0000) + low_value
    if value > MAXIMUM_SAFE_INTEGER:
        raise VectorError("An ISO base media box exceeds the safe integer range")
    return value


def write_unsigned_32(data: bytearray, offset: int, value: int) -> None:
    """Writes one big-endian unsigned 32-bit box size."""

    if value < 0 or value > 0xFFFF_FFFF:
        raise VectorError("An ISO base media box size cannot be represented")
    data[offset : offset + 4] = value.to_bytes(4, "big")


def read_four_CC(data: bytes, offset: int, end_offset: int) -> str:
    """Reads one printable ASCII FourCC that ends within end_offset."""

    if offset < 0 or offset + 4 > end_offset:
        raise VectorError("An ISO base media box type is truncated")
    four_CC = data[offset : offset + 4]
    for byte_value in four_CC:
        if byte_value < 0x20 or byte_value > 0x7E:
            raise VectorError("An ISO base media box type is not printable ASCII")
    return four_CC.decode("ascii")


def parse_box(data: bytes, start_offset: int, container_end_offset: int) -> BMFFBox:
    """Parses one compact, 64-bit, or to-the-end box header within its container."""

    if start_offset < 0 or start_offset + BASIC_BOX_HEADER_BYTE_LENGTH > container_end_offset:
        raise VectorError("An ISO base media box header is truncated")
    compact_size = read_unsigned_32(data, start_offset, container_end_offset)
    box_type = read_four_CC(data, start_offset + 4, container_end_offset)
    header_byte_length = (
        EXTENDED_BOX_HEADER_BYTE_LENGTH if compact_size == 1 else BASIC_BOX_HEADER_BYTE_LENGTH
    )
    match compact_size:
        case 1:
            box_byte_length = read_unsigned_64(data, start_offset + 8, container_end_offset)
        case 0:
            # A zero size extends the box to the end of its container
            box_byte_length = container_end_offset - start_offset
        case _:
            box_byte_length = compact_size
    end_offset = start_offset + box_byte_length
    if (
        box_byte_length < header_byte_length
        or end_offset > MAXIMUM_SAFE_INTEGER
        or end_offset > container_end_offset
    ):
        raise VectorError(f"The ISO base media {box_type} box size is invalid")
    return BMFFBox(
        box_type=box_type,
        compact_size=compact_size,
        data_offset=start_offset + header_byte_length,
        data_size=box_byte_length - header_byte_length,
        end_offset=end_offset,
        header_byte_length=header_byte_length,
        start_offset=start_offset,
    )


def parse_children(data: bytes, start_offset: int, end_offset: int) -> list[BMFFBox]:
    """Parses the bounded sequence of sibling boxes in one container payload."""

    boxes: list[BMFFBox] = []
    offset = start_offset
    while offset < end_offset:
        if len(boxes) >= MAXIMUM_CHILD_BOX_COUNT:
            raise VectorError("The ISO base media child box count exceeds its bound")
        box = parse_box(data, offset, end_offset)
        boxes.append(box)
        offset = box.end_offset
    return boxes


def find_unique_box(boxes: Sequence[BMFFBox], box_type: str) -> BMFFBox | None:
    """Returns the only box of one type, or None when that type is absent."""

    matches = [box for box in boxes if box.box_type == box_type]
    if len(matches) > 1:
        raise VectorError(f"Expected one ISO base media {box_type} box")
    return matches[0] if matches else None


def find_required_box(boxes: Sequence[BMFFBox], box_type: str) -> BMFFBox:
    """Returns the only box of one type and rejects a missing or repeated box."""

    box = find_unique_box(boxes, box_type)
    if box is None:
        raise VectorError(f"Expected one ISO base media {box_type} box")
    return box


def find_unique_nested_box(data: bytes, root_box: BMFFBox, path: Sequence[str]) -> BMFFBox:
    """Follows one path of required unique child boxes below root_box."""

    current_box = root_box
    for box_type in path:
        current_box = find_required_box(
            parse_children(data, current_box.data_offset, current_box.end_offset),
            box_type,
        )
    return current_box


def parse_track_ID(data: bytes, track_header_box: BMFFBox) -> int:
    """Reads the nonzero track ID from a version 0 or version 1 track header."""

    if track_header_box.data_size < 4:
        raise VectorError("The ISO base media track header is truncated")
    version = data[track_header_box.data_offset]
    # The track ID follows the version, flags, and 32-bit or 64-bit creation and modification times
    match version:
        case 0:
            track_ID_offset = track_header_box.data_offset + 12
        case 1:
            track_ID_offset = track_header_box.data_offset + 20
        case _:
            raise VectorError("The ISO base media track header version is unsupported")
    track_ID = read_unsigned_32(data, track_ID_offset, track_header_box.end_offset)
    if track_ID <= 0:
        raise VectorError("The ISO base media track ID is invalid")
    return track_ID


def parse_video_track(data: bytes, track_box: BMFFBox) -> VideoTrack:
    """Parses one HEVC video track and its optional Dolby Vision configuration."""

    if track_box.compact_size in (0, 1):
        raise VectorError("The vector requires compact track box sizes")
    track_children = parse_children(data, track_box.data_offset, track_box.end_offset)
    track_header_box = find_required_box(track_children, "tkhd")
    if find_unique_box(track_children, "tref") is not None:
        raise VectorError("The enhancement source already contains a track reference")
    handler_box = find_unique_nested_box(data, track_box, ("mdia", "hdlr"))
    if (
        handler_box.data_size < 12
        or read_four_CC(data, handler_box.data_offset + 8, handler_box.end_offset) != "vide"
    ):
        raise VectorError("The vector contains a non-video track")
    sample_description_box = find_unique_nested_box(
        data,
        track_box,
        ("mdia", "minf", "stbl", "stsd"),
    )
    if (
        sample_description_box.data_size < 8
        or read_unsigned_32(
            data,
            sample_description_box.data_offset + 4,
            sample_description_box.end_offset,
        )
        != 1
    ):
        raise VectorError("The vector requires one video sample entry per track")
    sample_entry = parse_box(
        data,
        sample_description_box.data_offset + 8,
        sample_description_box.end_offset,
    )
    if (
        sample_entry.end_offset != sample_description_box.end_offset
        or sample_entry.box_type not in BASE_HEVC_SAMPLE_ENTRY_TYPES
    ):
        raise VectorError("The vector requires hvc1 or hev1 sample entries")
    sample_entry_child_offset = sample_entry.data_offset + VISUAL_SAMPLE_ENTRY_FIELD_BYTE_LENGTH
    if sample_entry_child_offset > sample_entry.end_offset:
        raise VectorError("An HEVC visual sample entry is truncated")
    sample_entry_children = parse_children(
        data,
        sample_entry_child_offset,
        sample_entry.end_offset,
    )
    find_required_box(sample_entry_children, "hvcC")
    dolby_vision_configuration_box = find_unique_box(sample_entry_children, "dvcC")
    track_ID = parse_track_ID(data, track_header_box)
    return VideoTrack(
        dolby_vision_configuration_box=dolby_vision_configuration_box,
        height=read_unsigned_16(
            data,
            sample_entry.data_offset + VISUAL_SAMPLE_ENTRY_HEIGHT_OFFSET,
            sample_entry.end_offset,
        ),
        sample_entry=sample_entry,
        track_box=track_box,
        track_header_box=track_header_box,
        track_ID=track_ID,
        width=read_unsigned_16(
            data,
            sample_entry.data_offset + VISUAL_SAMPLE_ENTRY_WIDTH_OFFSET,
            sample_entry.end_offset,
        ),
    )


def require_profile7_enhancement_configuration(
    data: bytes,
    configuration_box: BMFFBox | None,
) -> int:
    """Returns the flag bits offset of an RPU-bearing Profile 7 EL dvcC configuration."""

    if configuration_box is None or configuration_box.data_size < 4:
        raise VectorError("The enhancement track has no valid dvcC configuration")
    # 7-bit dv_profile, 6-bit dv_level, then the RPU, EL, and BL present flags
    bits_offset = configuration_box.data_offset + 2
    configuration_bits = (data[bits_offset] * 256) + data[bits_offset + 1]
    profile = (configuration_bits >> 9) & 0x7F
    RPU_present = (configuration_bits & 4) != 0
    enhancement_layer_present = (configuration_bits & 2) != 0
    if profile != 7 or not RPU_present or not enhancement_layer_present:
        raise VectorError("The enhancement track is not an RPU-bearing Profile 7 EL")
    return bits_offset


def create_box(box_type: str, payload: bytes) -> bytes:
    """Creates one compact box around a payload."""

    output = bytearray(len(payload) + BASIC_BOX_HEADER_BYTE_LENGTH)
    write_unsigned_32(output, 0, len(output))
    output[4:BASIC_BOX_HEADER_BYTE_LENGTH] = box_type.encode("ascii")
    output[BASIC_BOX_HEADER_BYTE_LENGTH:] = payload
    return bytes(output)


def create_video_dependency_reference(base_track_ID: int) -> bytes:
    """Creates the tref box whose vdep entry names the base track."""

    track_ID = bytearray(4)
    write_unsigned_32(track_ID, 0, base_track_ID)
    return create_box("tref", create_box("vdep", bytes(track_ID)))


def patch_dual_track_dolby_vision_MP4(source_data: bytes | bytearray | memoryview) -> PatchedVector:
    """Patches a two-track HEVC MP4 into a legacy dual-track Profile 7 vector."""

    source = bytes(source_data)
    if len(source) == 0 or len(source) > MAXIMUM_VECTOR_BYTE_LENGTH:
        raise VectorError("The MP4 vector size is unsupported")
    top_level_boxes = parse_children(source, 0, len(source))
    if not top_level_boxes or top_level_boxes[0].box_type != "ftyp":
        raise VectorError("The vector is not an ISO base media file")
    movie_box = find_required_box(top_level_boxes, "moov")
    if movie_box.compact_size in (0, 1):
        raise VectorError("The vector requires a compact movie box size")
    # Growing moov keeps the chunk offsets valid only while all media data precedes it
    media_data_boxes = [box for box in top_level_boxes if box.box_type == "mdat"]
    if not media_data_boxes or any(
        box.end_offset > movie_box.start_offset for box in media_data_boxes
    ):
        raise VectorError("All vector media data must precede the movie box")
    track_boxes = [
        box
        for box in parse_children(source, movie_box.data_offset, movie_box.end_offset)
        if box.box_type == "trak"
    ]
    if len(track_boxes) != 2:
        raise VectorError("The vector requires exactly two video tracks")
    tracks = [parse_video_track(source, track_box) for track_box in track_boxes]
    if tracks[0].track_ID == tracks[1].track_ID:
        raise VectorError("The vector track IDs are duplicated")
    enhancement_tracks = [
        track for track in tracks if track.dolby_vision_configuration_box is not None
    ]
    if len(enhancement_tracks) != 1:
        raise VectorError("The vector requires exactly one Dolby Vision enhancement track")
    enhancement_track = enhancement_tracks[0]
    base_track = next((track for track in tracks if track is not enhancement_track), None)
    if base_track is None or base_track.dolby_vision_configuration_box is not None:
        raise VectorError("The vector base track is ambiguous")
    configuration_bits_offset = require_profile7_enhancement_configuration(
        source,
        enhancement_track.dolby_vision_configuration_box,
    )
    dolby_vision_sample_entry_type = DOLBY_VISION_SAMPLE_ENTRY_TYPE_BY_HEVC_TYPE.get(
        enhancement_track.sample_entry.box_type
    )
    if dolby_vision_sample_entry_type is None:
        raise VectorError("The enhancement sample entry type is unsupported")

    patched_source = bytearray(source)
    # Clears bl_present_flag, since the BL is the separate base track
    patched_source[configuration_bits_offset + 1] &= 0xFE
    sample_entry_type_offset = enhancement_track.sample_entry.start_offset + 4
    patched_source[sample_entry_type_offset : sample_entry_type_offset + 4] = (
        dolby_vision_sample_entry_type.encode("ascii")
    )
    track_reference_box = create_video_dependency_reference(base_track.track_ID)
    write_unsigned_32(
        patched_source,
        enhancement_track.track_box.start_offset,
        enhancement_track.track_box.end_offset
        - enhancement_track.track_box.start_offset
        + len(track_reference_box),
    )
    write_unsigned_32(
        patched_source,
        movie_box.start_offset,
        movie_box.end_offset - movie_box.start_offset + len(track_reference_box),
    )
    insertion_offset = enhancement_track.track_header_box.end_offset
    patched_source[insertion_offset:insertion_offset] = track_reference_box
    return PatchedVector(
        base_height=base_track.height,
        base_track_ID=base_track.track_ID,
        base_width=base_track.width,
        data=bytes(patched_source),
        enhancement_height=enhancement_track.height,
        enhancement_sample_entry_type=dolby_vision_sample_entry_type,
        enhancement_track_ID=enhancement_track.track_ID,
        enhancement_width=enhancement_track.width,
    )


def create_argument_parser() -> argparse.ArgumentParser:
    """Creates the dual-track vector CLI."""

    parser = argparse.ArgumentParser(
        prog="python scripts/codec_vector_assets/create_dual_track_dolby_vision_MP4_vector.py",
        description=(
            "Creates a validation-only MP4 with a base HEVC track and a dependent "
            "dvh1/dvhe Profile 7 enhancement track. The input should be produced by "
            "create_separate_track_dolby_vision_vector.py."
        ),
        allow_abbrev=False,
    )
    parser.add_argument("input_path", metavar="separate-profile7.mkv")
    parser.add_argument("output_path", metavar="output.mp4")
    parser.add_argument(
        "--ffmpeg",
        metavar="path",
        help="FFmpeg executable; defaults to ffmpeg on PATH",
    )
    return parser


def parse_arguments(command_arguments: Sequence[str] | None) -> DualTrackVectorConfiguration:
    """Parses the CLI into one validated vector configuration."""

    arguments = create_argument_parser().parse_args(command_arguments)
    if arguments.ffmpeg == "":
        raise VectorError("--ffmpeg requires a path")
    input_path = os.path.abspath(arguments.input_path)
    output_path = os.path.abspath(arguments.output_path)
    if refers_to_same_file(input_path, output_path):
        raise VectorError("The output path must differ from the input path")
    return DualTrackVectorConfiguration(
        input_path=input_path,
        output_path=output_path,
        configured_FFmpeg_path=os.path.abspath(arguments.ffmpeg) if arguments.ffmpeg else None,
    )


def create_dual_track_dolby_vision_MP4_vector(
    configuration: DualTrackVectorConfiguration,
) -> dict[str, object]:
    """Remuxes the separate-track source with FFmpeg and writes the patched dual-track MP4."""

    source_status = os.stat(configuration.input_path)
    if (
        not stat.S_ISREG(source_status.st_mode)
        or source_status.st_size > MAXIMUM_VECTOR_BYTE_LENGTH
    ):
        raise VectorError("The source vector size is unsupported")
    FFmpeg_path = resolve_FFmpeg_tool("ffmpeg", configuration.configured_FFmpeg_path)
    with tempfile.TemporaryDirectory(prefix="webgpu-dovi-mp4-") as temporary_directory:
        unpatched_path = os.path.join(temporary_directory, "unpatched.mp4")
        execute_tool(
            FFmpeg_path,
            [
                "-hide_banner",
                "-loglevel", "error",
                "-nostdin",
                "-y",
                "-i", configuration.input_path,
                "-map", "0:v:0",
                "-map", "0:v:1",
                "-c:v", "copy",
                "-tag:v:0", "hvc1",
                "-tag:v:1", "hvc1",
                "-disposition:v:0", "default",
                "-disposition:v:1", "0",
                "-map_metadata", "-1",
                "-strict", "unofficial",
                unpatched_path,
            ],
        )
        patched = patch_dual_track_dolby_vision_MP4(Path(unpatched_path).read_bytes())
        Path(configuration.output_path).write_bytes(patched.data)
        return {
            "baseHeight": patched.base_height,
            "baseTrackID": patched.base_track_ID,
            "baseWidth": patched.base_width,
            "byteLength": len(patched.data),
            "enhancementHeight": patched.enhancement_height,
            "enhancementSampleEntryType": patched.enhancement_sample_entry_type,
            "enhancementTrackID": patched.enhancement_track_ID,
            "enhancementWidth": patched.enhancement_width,
            "outputPath": configuration.output_path,
            "sha256": hashlib.sha256(patched.data).hexdigest(),
        }


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Runs the CLI and prints the JSON summary of the written vector."""

    try:
        configuration = parse_arguments(command_arguments)
        summary = create_dual_track_dolby_vision_MP4_vector(configuration)
    except (VectorError, ToolError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
