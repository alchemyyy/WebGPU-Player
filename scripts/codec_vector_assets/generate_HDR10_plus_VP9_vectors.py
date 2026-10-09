#!/usr/bin/env python3
"""Generate the HDR10+ VP9 test vectors and their known answers, or verify them with --check.

VP9 has no metadata of its own, so its HDR10+ travels beside each frame in a Matroska BlockAdditional, as an ITU-T T.35 message under BlockAddID 4.
The vectors are one short VP9 Profile 2 encode, 10-bit BT.2020 PQ, in WebM, which carries BlockAddID 4 without a mapping, and in Matroska, whose BlockAdditionMapping gives it the ITU-T T.35 type.
The metadata varies across the frames: profile B frames with different curves and distributions, a profile A frame without a curve whose target peak is 0, and frames without HDR10+.

The pinned FFmpeg writes it all:
- libx265 encodes testsrc2 with one dhdr10-info entry per frame, so FFmpeg decodes HDR10+ frame side data;
- the sidedata filter deletes that side data from the frames without HDR10+;
- libvpx-vp9 passes the side data of a Profile 2 encode to its packets, and the WebM muxer writes each as a BlockAdditional;
- FFmpeg remuxes the WebM into Matroska, which adds the mapping.

The generator refuses any FFmpeg build but the pinned one, because another build encodes and muxes other bytes.
Before writing, it validates:
- the HDR10+ side data FFprobe reads from every packet of both files, the independent oracle;
- the BlockAdditional bytes of every block, which must equal the frame's own ST 2094-40 serialization in HDR10_plus_metadata.py;
- the key frames, the color, and the BlockAdditionMapping of each container.
Without --check it replaces the committed files once every check passes; with --check it fails unless each committed file matches.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Iterator, Mapping, Sequence

from engine_layout import CODEC_VECTOR_ASSETS_DIRECTORY, layout_path
from generated_output import GeneratedOutputError, write_or_check_output
from HDR10_plus_metadata import (
    FFPROBE_HDR10_PLUS_PACKET_SIDE_DATA_TYPE,
    HDR10_PLUS_WINDOW_COUNT,
    MAXIMUM_BEZIER_ANCHOR_COUNT,
    MAXIMUM_LUMINANCE_VALUE,
    MAXIMUM_PERCENTAGE,
    BezierCurve,
    DistributionPercentile,
    HDR10PlusFrame,
    create_distribution,
    create_expected_frame_metadata,
    create_expected_HDR10_plus_side_data,
    create_HDR10_plus_ITUT_T35_message,
    read_FFprobe_section,
)
from media_tools import (
    MediaTools,
    ToolError,
    VectorGenerationError,
    check_toolchain,
    execute_tool,
    require_equal,
    resolve_FFmpeg_tool,
)


VECTOR_DIRECTORY: Final = CODEC_VECTOR_ASSETS_DIRECTORY / "hdr10plus-vp9"
EXPECTATIONS_FILE_NAME: Final = "expectations.json"
VECTOR_FILE_STEM: Final = "hdr10plus"

WEBM_FORMAT: Final = "webm"
MATROSKA_FORMAT: Final = "matroska"
CONTAINER_FORMATS: Final = (WEBM_FORMAT, MATROSKA_FORMAT)
FILE_EXTENSION_BY_FORMAT: Final[Mapping[str, str]] = {WEBM_FORMAT: "webm", MATROSKA_FORMAT: "mkv"}
HEVC_STREAM_FORMAT: Final = "hevc"

# 192x192, like the other vectors, so hardware decoders with a minimum coded size accept it
VECTOR_WIDTH: Final = 192
VECTOR_HEIGHT: Final = 192
VECTOR_FRAME_RATE: Final = 24
# Two groups of four frames, so a start inside the second group begins at its key frame
VECTOR_KEY_FRAME_INTERVAL: Final = 4
# The muxers start a cluster after this much time, here at the second key frame (167 ms), so each group has its own cluster
CLUSTER_TIME_LIMIT_MILLISECONDS: Final = 160
VECTOR_CONSTANT_RATE_FACTOR: Final = 50
PIXEL_FORMAT: Final = "yuv420p10le"
VP9_CODEC_NAME: Final = "vp9"
VP9_PROFILE: Final = 2
FFPROBE_VP9_PROFILE: Final = "Profile 2"
# The source only feeds the VP9 encode its frames and their HDR10+ side data
HEVC_SOURCE_CONSTANT_RATE_FACTOR: Final = 51

# H.273 code points of the Matroska Colour element, and FFmpeg's names for them
BT2020_PRIMARIES: Final = 9
PQ_TRANSFER: Final = 16
BT2020_NON_CONSTANT_LUMINANCE_MATRIX: Final = 9
# Matroska Range 1 is broadcast range
MATROSKA_BROADCAST_RANGE: Final = 1
FFMPEG_COLOR_NAMES: Final[Mapping[str, str]] = {
    "color_primaries": "bt2020",
    "color_range": "tv",
    "color_space": "bt2020nc",
    "color_transfer": "smpte2084",
}

# x265's dhdr10-info has no bright-pixel fraction, so x265 writes 0 for every frame
X265_FRACTION_BRIGHT_PIXELS: Final = 0
# FFmpeg's ITU-T T.35 BlockAddID, which the Matroska BlockAdditionMapping gives the ITU-T T.35 BlockAddIDType
ITU_T_T35_BLOCK_ADDITION_ID: Final = 4
ITU_T_T35_BLOCK_ADDITION_TYPE: Final = 4
FFPROBE_KEY_FLAG: Final = "K"

# Matroska element IDs, with their length markers, from RFC 9559
EBML_HEADER_ID: Final = 0x1A45DFA3
DOC_TYPE_ID: Final = 0x4282
SEGMENT_ID: Final = 0x18538067
TRACKS_ID: Final = 0x1654AE6B
TRACK_ENTRY_ID: Final = 0xAE
TRACK_NUMBER_ID: Final = 0xD7
MAXIMUM_BLOCK_ADDITION_ID_ID: Final = 0x55EE
BLOCK_ADDITION_MAPPING_ID: Final = 0x41E4
BLOCK_ADDITION_ID_VALUE_ID: Final = 0x41F0
BLOCK_ADDITION_ID_TYPE_ID: Final = 0x41E7
VIDEO_ID: Final = 0xE0
COLOUR_ID: Final = 0x55B0
MATRIX_COEFFICIENTS_ID: Final = 0x55B1
RANGE_ID: Final = 0x55B9
TRANSFER_CHARACTERISTICS_ID: Final = 0x55BA
PRIMARIES_ID: Final = 0x55BB
CLUSTER_ID: Final = 0x1F43B675
SIMPLE_BLOCK_ID: Final = 0xA3
BLOCK_GROUP_ID: Final = 0xA0
BLOCK_ID: Final = 0xA1
BLOCK_ADDITIONS_ID: Final = 0x75A1
BLOCK_MORE_ID: Final = 0xA6
BLOCK_ADDITION_ID_ID: Final = 0xEE
BLOCK_ADDITIONAL_ID: Final = 0xA5
REFERENCE_BLOCK_ID: Final = 0xFB
# BlockAddID defaults to 1 when a BlockMore omits it
DEFAULT_BLOCK_ADDITION_ID: Final = 1
MAXIMUM_EBML_ID_BYTE_LENGTH: Final = 4
MAXIMUM_EBML_SIZE_BYTE_LENGTH: Final = 8
SIMPLE_BLOCK_KEY_FLAG: Final = 0x80
BLOCK_LACING_MASK: Final = 0x06
# The relative timestamp between a block's track number and its flags
BLOCK_TIMESTAMP_BYTE_LENGTH: Final = 2


@dataclass(frozen=True)
class EBMLElement:
    """One element of an EBML document: its ID with the length marker, and its data's offsets."""

    element_ID: int
    data_offset: int
    end_offset: int


@dataclass(frozen=True)
class MatroskaBlock:
    """One block of the video track and the BlockAdditionals of its BlockGroup."""

    key_frame: bool
    additions: tuple[tuple[int, bytes], ...]


@dataclass(frozen=True)
class MatroskaVideoTrack:
    """The parts of a Matroska or WebM file that carry and signal its HDR10+."""

    doc_type: str
    block_addition_mappings: tuple[tuple[int, int], ...]
    maximum_block_addition_ID: int | None
    # Primaries, transfer characteristics, matrix coefficients, and range
    color: tuple[int, ...]
    blocks: tuple[MatroskaBlock, ...]
    cluster_block_counts: tuple[int, ...]


# A frame of each shape the engine parses, then a key frame without HDR10+ and two frames with identical messages.
# The frames without HDR10+ still need a dhdr10-info entry, which the sidedata filter deletes after x265
VECTOR_FRAMES: Final[tuple[HDR10PlusFrame | None, ...]] = (
    HDR10PlusFrame(
        average_maxrgb=1_000,
        bezier_curve=BezierCurve(anchors=(102, 205, 307, 410, 512, 614, 717, 819, 922), knee_point_x=0, knee_point_y=0),
        distribution=create_distribution((100, 200, 300, 400, 500, 600, 700, 800, 900)),
        fraction_bright_pixels=X265_FRACTION_BRIGHT_PIXELS,
        maxscl=(40_000, 35_000, 30_000),
        targeted_system_display_maximum_luminance=400,
    ),
    HDR10PlusFrame(
        average_maxrgb=2_500,
        bezier_curve=BezierCurve(anchors=(256, 512, 768), knee_point_x=2_048, knee_point_y=1_024),
        distribution=(
            DistributionPercentile(percentage=1, percentile=5),
            DistributionPercentile(percentage=50, percentile=600),
            DistributionPercentile(percentage=99, percentile=9_000),
        ),
        fraction_bright_pixels=X265_FRACTION_BRIGHT_PIXELS,
        maxscl=(12_000, 10_000, 8_000),
        targeted_system_display_maximum_luminance=1_000,
    ),
    None,
    HDR10PlusFrame(
        average_maxrgb=800,
        bezier_curve=None,
        distribution=create_distribution((50, 100, 150, 200, 250, 300, 350, 400, 450)),
        fraction_bright_pixels=X265_FRACTION_BRIGHT_PIXELS,
        maxscl=(6_000, 5_000, 4_000),
        targeted_system_display_maximum_luminance=0,
    ),
    None,
    HDR10PlusFrame(
        average_maxrgb=1,
        bezier_curve=BezierCurve(
            anchors=tuple(anchor_index * 68 for anchor_index in range(1, MAXIMUM_BEZIER_ANCHOR_COUNT + 1)),
            knee_point_x=4_095,
            knee_point_y=4_095,
        ),
        distribution=tuple(
            DistributionPercentile(percentage=percentage, percentile=percentage * 1_000)
            for percentage in (1, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 98, 99, MAXIMUM_PERCENTAGE)
        ),
        fraction_bright_pixels=X265_FRACTION_BRIGHT_PIXELS,
        maxscl=(MAXIMUM_LUMINANCE_VALUE, 0, 1),
        targeted_system_display_maximum_luminance=10_000,
    ),
    HDR10PlusFrame(
        average_maxrgb=3_000,
        bezier_curve=BezierCurve(anchors=(512,), knee_point_x=1_000, knee_point_y=2_000),
        distribution=(DistributionPercentile(percentage=50, percentile=1_500),),
        fraction_bright_pixels=X265_FRACTION_BRIGHT_PIXELS,
        maxscl=(25_000, 20_000, 15_000),
        targeted_system_display_maximum_luminance=4_000,
    ),
    HDR10PlusFrame(
        average_maxrgb=3_000,
        bezier_curve=BezierCurve(anchors=(512,), knee_point_x=1_000, knee_point_y=2_000),
        distribution=(DistributionPercentile(percentage=50, percentile=1_500),),
        fraction_bright_pixels=X265_FRACTION_BRIGHT_PIXELS,
        maxscl=(25_000, 20_000, 15_000),
        targeted_system_display_maximum_luminance=4_000,
    ),
)
VECTOR_FRAME_COUNT: Final = len(VECTOR_FRAMES)


def create_x265_metadata_entry(frame: HDR10PlusFrame) -> dict[str, object]:
    """Returns one frame's entry in the SceneInfo list that x265's dhdr10-info reads."""

    if frame.fraction_bright_pixels != X265_FRACTION_BRIGHT_PIXELS:
        raise VectorGenerationError("x265's dhdr10-info cannot code an HDR10+ bright-pixel fraction")
    entry: dict[str, object] = {
        "LuminanceParameters": {
            "AverageRGB": frame.average_maxrgb,
            "LuminanceDistributions": {
                "DistributionIndex": [entry.percentage for entry in frame.distribution],
                "DistributionValues": [entry.percentile for entry in frame.distribution],
            },
            "MaxScl": list(frame.maxscl),
        },
        "NumberOfWindows": HDR10_PLUS_WINDOW_COUNT,
        "TargetedSystemDisplayMaximumLuminance": frame.targeted_system_display_maximum_luminance,
    }
    if frame.bezier_curve is not None:
        entry["BezierCurveData"] = {
            "Anchors": list(frame.bezier_curve.anchors),
            "KneePointX": frame.bezier_curve.knee_point_x,
            "KneePointY": frame.bezier_curve.knee_point_y,
        }
    return entry


def create_x265_metadata(frames: Sequence[HDR10PlusFrame | None]) -> bytes:
    """Returns the dhdr10-info JSON, one SceneInfo entry per frame.

    x265 writes an entry for every frame, so a frame without HDR10+ repeats the first frame's entry, which the sidedata filter deletes.
    """

    placeholder_frame = next((frame for frame in frames if frame is not None), None)
    if placeholder_frame is None:
        raise VectorGenerationError("At least one vector frame must carry HDR10+")
    entries = [create_x265_metadata_entry(placeholder_frame if frame is None else frame) for frame in frames]
    return (json.dumps({"SceneInfo": entries}, indent=2) + "\n").encode("utf-8")


def get_frame_indices_without_metadata(frames: Sequence[HDR10PlusFrame | None]) -> list[int]:
    return [frame_index for frame_index, frame in enumerate(frames) if frame is None]


def escape_FFmpeg_option_value(value: str) -> str:
    """Escapes the characters that end a key or a value in an FFmpeg key=value:key=value list, a drive colon included."""

    return re.sub(r"([\\':=])", r"\\\1", value)


def create_HEVC_source_arguments(metadata_path: Path, output_path: Path) -> list[str]:
    """Returns the FFmpeg arguments of an x265 encode of testsrc2 that carries each frame's dhdr10-info entry."""

    x265_parameters = ":".join(
        (
            "info=0",
            # No B-frames, so the frames decode in the order of their entries
            "bframes=0",
            "pools=none",
            "frame-threads=1",
            "log-level=error",
            f"dhdr10-info={escape_FFmpeg_option_value(metadata_path.as_posix())}",
        )
    )
    return [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-f", "lavfi",
        "-i", f"testsrc2=size={VECTOR_WIDTH}x{VECTOR_HEIGHT}:rate={VECTOR_FRAME_RATE},format={PIXEL_FORMAT}",
        "-frames:v", str(VECTOR_FRAME_COUNT),
        "-c:v", "libx265",
        "-preset", "ultrafast",
        "-crf", str(HEVC_SOURCE_CONSTANT_RATE_FACTOR),
        "-x265-params", x265_parameters,
        "-f", HEVC_STREAM_FORMAT,
        str(output_path),
    ]


def create_VP9_filter(frame_indices_without_metadata: Sequence[int]) -> str:
    """Returns the filter chain that deletes the HDR10+ of the listed frames and tags every frame BT.2020 PQ.

    libvpx-vp9 keeps HDR10+ only when the encoder opens on a PQ transfer, which it reads from the first frame.
    """

    filters: list[str] = []
    if frame_indices_without_metadata:
        deleted_frames = "+".join(f"eq(n,{frame_index})" for frame_index in frame_indices_without_metadata)
        filters.append(f"sidedata=mode=delete:type=DYNAMIC_HDR_PLUS:enable='{deleted_frames}'")
    filters.append(
        f"setparams=color_primaries={FFMPEG_COLOR_NAMES['color_primaries']}"
        f":color_trc={FFMPEG_COLOR_NAMES['color_transfer']}"
        f":colorspace={FFMPEG_COLOR_NAMES['color_space']}"
        f":range={FFMPEG_COLOR_NAMES['color_range']}"
    )
    return ",".join(filters)


def create_VP9_encode_arguments(source_path: Path, frame_indices_without_metadata: Sequence[int], output_path: Path) -> list[str]:
    """Returns the FFmpeg arguments of a single-threaded libvpx-vp9 Profile 2 encode of the source into WebM, which passes each frame's HDR10+ to its packet."""

    return [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-framerate", str(VECTOR_FRAME_RATE),
        "-f", HEVC_STREAM_FORMAT,
        "-i", str(source_path),
        "-vf", create_VP9_filter(frame_indices_without_metadata),
        "-c:v", "libvpx-vp9",
        "-profile:v", str(VP9_PROFILE),
        "-pix_fmt", PIXEL_FORMAT,
        "-deadline", "good",
        "-cpu-used", "8",
        "-threads", "1",
        "-row-mt", "0",
        # Without lookahead or alternate reference frames, every packet is one shown frame
        "-lag-in-frames", "0",
        "-auto-alt-ref", "0",
        "-g", str(VECTOR_KEY_FRAME_INTERVAL),
        "-keyint_min", str(VECTOR_KEY_FRAME_INTERVAL),
        "-crf", str(VECTOR_CONSTANT_RATE_FACTOR),
        "-b:v", "0",
        "-fflags", "+bitexact",
        "-flags:v", "+bitexact",
        "-map_metadata", "-1",
        "-cluster_time_limit", str(CLUSTER_TIME_LIMIT_MILLISECONDS),
        "-f", WEBM_FORMAT,
        str(output_path),
    ]


def create_remux_arguments(input_path: Path, output_path: Path) -> list[str]:
    """Returns the FFmpeg arguments that copy the WebM's packets, and their HDR10+ side data, into Matroska."""

    return [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-i", str(input_path),
        "-map", "0",
        "-c", "copy",
        "-fflags", "+bitexact",
        "-map_metadata", "-1",
        "-cluster_time_limit", str(CLUSTER_TIME_LIMIT_MILLISECONDS),
        "-f", MATROSKA_FORMAT,
        str(output_path),
    ]


def read_EBML_ID(data: bytes, offset: int) -> tuple[int, int]:
    """Reads an element ID, keeping its length marker, and returns it with the offset after it."""

    if offset >= len(data) or data[offset] == 0:
        raise VectorGenerationError(f"Invalid EBML ID at offset {offset}")
    byte_length = 9 - data[offset].bit_length()
    if byte_length > MAXIMUM_EBML_ID_BYTE_LENGTH or offset + byte_length > len(data):
        raise VectorGenerationError(f"Invalid EBML ID at offset {offset}")
    return int.from_bytes(data[offset : offset + byte_length], "big"), offset + byte_length


def read_EBML_variable_integer(data: bytes, offset: int) -> tuple[int, int]:
    """Reads a variable-size integer without its length marker and returns it with the offset after it."""

    if offset >= len(data) or data[offset] == 0:
        raise VectorGenerationError(f"Invalid EBML variable-size integer at offset {offset}")
    byte_length = 9 - data[offset].bit_length()
    if offset + byte_length > len(data):
        raise VectorGenerationError(f"Truncated EBML variable-size integer at offset {offset}")
    value = data[offset] & ((1 << (8 - byte_length)) - 1)
    for byte_value in data[offset + 1 : offset + byte_length]:
        value = (value << 8) | byte_value
    if value == (1 << (7 * byte_length)) - 1:
        raise VectorGenerationError(f"Unknown EBML size at offset {offset}")
    return value, offset + byte_length


def iterate_EBML_elements(data: bytes, start_offset: int, end_offset: int) -> Iterator[EBMLElement]:
    """Yields the elements between two offsets, which must hold whole elements of known size."""

    offset = start_offset
    while offset < end_offset:
        element_ID, offset = read_EBML_ID(data, offset)
        size, data_offset = read_EBML_variable_integer(data, offset)
        element_end_offset = data_offset + size
        if element_end_offset > end_offset:
            raise VectorGenerationError(f"The EBML element 0x{element_ID:X} runs past its parent")
        yield EBMLElement(element_ID=element_ID, data_offset=data_offset, end_offset=element_end_offset)
        offset = element_end_offset


def get_children(data: bytes, parent: EBMLElement, element_ID: int) -> list[EBMLElement]:
    return [child for child in iterate_EBML_elements(data, parent.data_offset, parent.end_offset) if child.element_ID == element_ID]


def get_one_child(data: bytes, parent: EBMLElement, element_ID: int) -> EBMLElement:
    children = get_children(data, parent, element_ID)
    if len(children) != 1:
        raise VectorGenerationError(f"Expected one EBML element 0x{element_ID:X}, found {len(children)}")
    return children[0]


def read_unsigned_element(data: bytes, element: EBMLElement) -> int:
    return int.from_bytes(data[element.data_offset : element.end_offset], "big")


def read_optional_unsigned_child(data: bytes, parent: EBMLElement, element_ID: int) -> int | None:
    children = get_children(data, parent, element_ID)
    if len(children) > 1:
        raise VectorGenerationError(f"Expected at most one EBML element 0x{element_ID:X}, found {len(children)}")
    return read_unsigned_element(data, children[0]) if children else None


def read_block_header(data: bytes, block: EBMLElement) -> tuple[int, int]:
    """Returns a Block or SimpleBlock's track number and flags, rejecting a laced block."""

    track_number, timestamp_offset = read_EBML_variable_integer(data, block.data_offset)
    flags_offset = timestamp_offset + BLOCK_TIMESTAMP_BYTE_LENGTH
    if flags_offset >= block.end_offset:
        raise VectorGenerationError("A Matroska block is truncated")
    flags = data[flags_offset]
    if flags & BLOCK_LACING_MASK:
        raise VectorGenerationError("A Matroska block is laced")
    return track_number, flags


def read_block_additions(data: bytes, block_group: EBMLElement) -> tuple[tuple[int, bytes], ...]:
    """Returns each BlockMore of a BlockGroup as its BlockAddID and BlockAdditional bytes."""

    additions: list[tuple[int, bytes]] = []
    for block_additions in get_children(data, block_group, BLOCK_ADDITIONS_ID):
        for block_more in get_children(data, block_additions, BLOCK_MORE_ID):
            addition_ID = read_optional_unsigned_child(data, block_more, BLOCK_ADDITION_ID_ID)
            additional = get_one_child(data, block_more, BLOCK_ADDITIONAL_ID)
            additions.append((
                DEFAULT_BLOCK_ADDITION_ID if addition_ID is None else addition_ID,
                data[additional.data_offset : additional.end_offset],
            ))
    return tuple(additions)


def read_cluster_blocks(data: bytes, cluster: EBMLElement, track_number: int) -> list[MatroskaBlock]:
    """Returns the blocks of one track in a cluster, in file order."""

    blocks: list[MatroskaBlock] = []
    for child in iterate_EBML_elements(data, cluster.data_offset, cluster.end_offset):
        if child.element_ID == SIMPLE_BLOCK_ID:
            block_track_number, flags = read_block_header(data, child)
            if block_track_number == track_number:
                blocks.append(MatroskaBlock(key_frame=bool(flags & SIMPLE_BLOCK_KEY_FLAG), additions=()))
        elif child.element_ID == BLOCK_GROUP_ID:
            block_track_number, _flags = read_block_header(data, get_one_child(data, child, BLOCK_ID))
            if block_track_number == track_number:
                # A BlockGroup without a ReferenceBlock is a key frame
                blocks.append(MatroskaBlock(
                    key_frame=not get_children(data, child, REFERENCE_BLOCK_ID),
                    additions=read_block_additions(data, child),
                ))
    return blocks


def read_Matroska_video_track(data: bytes) -> MatroskaVideoTrack:
    """Reads the DocType, the one track's HDR10+ signaling and color, and its blocks from a Matroska or WebM file."""

    top_level_elements = list(iterate_EBML_elements(data, 0, len(data)))
    if [element.element_ID for element in top_level_elements] != [EBML_HEADER_ID, SEGMENT_ID]:
        raise VectorGenerationError("The file is not one EBML header followed by one Segment")
    header, segment = top_level_elements
    doc_type_element = get_one_child(data, header, DOC_TYPE_ID)
    track_entry = get_one_child(data, get_one_child(data, segment, TRACKS_ID), TRACK_ENTRY_ID)
    track_number = read_unsigned_element(data, get_one_child(data, track_entry, TRACK_NUMBER_ID))
    colour = get_one_child(data, get_one_child(data, track_entry, VIDEO_ID), COLOUR_ID)
    color = tuple(
        read_unsigned_element(data, get_one_child(data, colour, element_ID))
        for element_ID in (PRIMARIES_ID, TRANSFER_CHARACTERISTICS_ID, MATRIX_COEFFICIENTS_ID, RANGE_ID)
    )
    mappings = tuple(
        (
            read_unsigned_element(data, get_one_child(data, mapping, BLOCK_ADDITION_ID_VALUE_ID)),
            read_unsigned_element(data, get_one_child(data, mapping, BLOCK_ADDITION_ID_TYPE_ID)),
        )
        for mapping in get_children(data, track_entry, BLOCK_ADDITION_MAPPING_ID)
    )
    blocks: list[MatroskaBlock] = []
    cluster_block_counts: list[int] = []
    for cluster in get_children(data, segment, CLUSTER_ID):
        cluster_blocks = read_cluster_blocks(data, cluster, track_number)
        blocks.extend(cluster_blocks)
        cluster_block_counts.append(len(cluster_blocks))
    return MatroskaVideoTrack(
        doc_type=data[doc_type_element.data_offset : doc_type_element.end_offset].decode("ascii"),
        block_addition_mappings=mappings,
        maximum_block_addition_ID=read_optional_unsigned_child(data, track_entry, MAXIMUM_BLOCK_ADDITION_ID_ID),
        color=color,
        blocks=tuple(blocks),
        cluster_block_counts=tuple(cluster_block_counts),
    )


def get_key_frame_flags() -> list[bool]:
    return [frame_index % VECTOR_KEY_FRAME_INTERVAL == 0 for frame_index in range(VECTOR_FRAME_COUNT)]


def get_expected_block_additions(frame: HDR10PlusFrame | None) -> tuple[tuple[int, bytes], ...]:
    if frame is None:
        return ()
    return ((ITU_T_T35_BLOCK_ADDITION_ID, create_HDR10_plus_ITUT_T35_message(frame)),)


def require_container_evidence(data: bytes, container_format: str, label: str) -> None:
    """Requires each block to carry its frame's T.35 message under BlockAddID 4, with the container's own signaling."""

    track = read_Matroska_video_track(data)
    require_equal(track.doc_type, container_format, f"{label} DocType")
    require_equal(
        list(track.color),
        [BT2020_PRIMARIES, PQ_TRANSFER, BT2020_NON_CONSTANT_LUMINANCE_MATRIX, MATROSKA_BROADCAST_RANGE],
        f"{label} Colour",
    )
    # WebM has no BlockAdditionMapping, so only Matroska maps BlockAddID 4 to the ITU-T T.35 type
    is_Matroska = container_format == MATROSKA_FORMAT
    require_equal(
        [list(mapping) for mapping in track.block_addition_mappings],
        [[ITU_T_T35_BLOCK_ADDITION_ID, ITU_T_T35_BLOCK_ADDITION_TYPE]] if is_Matroska else [],
        f"{label} BlockAdditionMapping",
    )
    require_equal(
        track.maximum_block_addition_ID,
        ITU_T_T35_BLOCK_ADDITION_ID if is_Matroska else None,
        f"{label} MaxBlockAdditionID",
    )
    require_equal([block.key_frame for block in track.blocks], get_key_frame_flags(), f"{label} key frames")
    require_equal(
        list(track.cluster_block_counts),
        [VECTOR_KEY_FRAME_INTERVAL] * (VECTOR_FRAME_COUNT // VECTOR_KEY_FRAME_INTERVAL),
        f"{label} blocks per cluster",
    )
    require_equal(
        [[[addition_ID, data.hex()] for addition_ID, data in block.additions] for block in track.blocks],
        [[[addition_ID, data.hex()] for addition_ID, data in get_expected_block_additions(frame)] for frame in VECTOR_FRAMES],
        f"{label} BlockAdditionals",
    )


def probe_packets(tools: MediaTools, path: Path) -> list[dict[str, Any]]:
    """Returns the flags and side data FFprobe reads for each packet of the video stream."""

    output = execute_tool(
        tools.FFprobe_path,
        [
            "-v", "error",
            "-select_streams", "v:0",
            "-show_packets",
            "-show_entries", "packet=flags:packet_side_data",
            "-of", "json",
            str(path),
        ],
    )
    return read_FFprobe_section(output, "packets", path.name)


def probe_video_stream(tools: MediaTools, path: Path) -> dict[str, Any]:
    output = execute_tool(tools.FFprobe_path, ["-v", "error", "-show_streams", "-of", "json", str(path)])
    streams = json.loads(output).get("streams", [])
    if len(streams) != 1 or streams[0].get("codec_type") != "video":
        raise VectorGenerationError(f"{path.name} has {len(streams)} streams instead of one video stream")
    return dict(streams[0])


def require_FFprobe_evidence(tools: MediaTools, path: Path, label: str) -> None:
    """Requires FFprobe to read a VP9 Profile 2 PQ stream, the key frames, and each packet's HDR10+ side data."""

    stream = probe_video_stream(tools, path)
    require_equal(
        [stream.get("codec_name"), stream.get("profile"), stream.get("pix_fmt"), stream.get("width"), stream.get("height")],
        [VP9_CODEC_NAME, FFPROBE_VP9_PROFILE, PIXEL_FORMAT, VECTOR_WIDTH, VECTOR_HEIGHT],
        f"{label} stream",
    )
    require_equal({name: stream.get(name) for name in FFMPEG_COLOR_NAMES}, dict(FFMPEG_COLOR_NAMES), f"{label} color")
    packets = probe_packets(tools, path)
    require_equal(
        [str(packet.get("flags", "")).startswith(FFPROBE_KEY_FLAG) for packet in packets],
        get_key_frame_flags(),
        f"{label} FFprobe key frames",
    )
    require_equal(
        [packet.get("side_data_list", []) for packet in packets],
        [
            [] if frame is None else [create_expected_HDR10_plus_side_data(frame, FFPROBE_HDR10_PLUS_PACKET_SIDE_DATA_TYPE)]
            for frame in VECTOR_FRAMES
        ],
        f"{label} FFprobe HDR10+ side data",
    )


def get_vector_file_name(container_format: str) -> str:
    return f"{VECTOR_FILE_STEM}.{FILE_EXTENSION_BY_FORMAT[container_format]}"


def create_expectations() -> dict[str, object]:
    """Returns the known answers of both vectors, which depend only on the frame table."""

    frames = [
        {
            "HDR10Plus": None if frame is None else create_expected_frame_metadata(frame),
            "ITUTT35Message": None if frame is None else create_HDR10_plus_ITUT_T35_message(frame).hex(),
            "keyFrame": key_frame,
        }
        for frame, key_frame in zip(VECTOR_FRAMES, get_key_frame_flags(), strict=True)
    ]
    return {
        "blockAdditionID": ITU_T_T35_BLOCK_ADDITION_ID,
        "colorPrimaries": BT2020_PRIMARIES,
        "frameCount": VECTOR_FRAME_COUNT,
        "frameRate": VECTOR_FRAME_RATE,
        "frames": frames,
        "fullRange": False,
        "generator": layout_path("codecVectorScriptsDirectory", Path(__file__).name),
        "height": VECTOR_HEIGHT,
        "matrixCoefficients": BT2020_NON_CONSTANT_LUMINANCE_MATRIX,
        "transferCharacteristics": PQ_TRANSFER,
        "vectors": [
            {
                "blockAdditionMapping": container_format == MATROSKA_FORMAT,
                "container": container_format,
                "fileName": get_vector_file_name(container_format),
            }
            for container_format in CONTAINER_FORMATS
        ],
        "width": VECTOR_WIDTH,
    }


def format_expectations(expectations: Mapping[str, object]) -> bytes:
    """Returns the expectations as sorted, two-space indented JSON with a final line feed."""

    return (json.dumps(expectations, indent=2, sort_keys=True) + "\n").encode("utf-8")


def build_vector_files(tools: MediaTools, temporary_directory: Path) -> dict[str, Path]:
    """Encodes the WebM vector, remuxes it into Matroska, and returns each file's path by container."""

    metadata_path = temporary_directory / "hdr10plus.json"
    metadata_path.write_bytes(create_x265_metadata(VECTOR_FRAMES))
    source_path = temporary_directory / "source.hevc"
    execute_tool(tools.FFmpeg_path, create_HEVC_source_arguments(metadata_path, source_path))
    paths = {container_format: temporary_directory / get_vector_file_name(container_format) for container_format in CONTAINER_FORMATS}
    execute_tool(
        tools.FFmpeg_path,
        create_VP9_encode_arguments(source_path, get_frame_indices_without_metadata(VECTOR_FRAMES), paths[WEBM_FORMAT]),
    )
    execute_tool(tools.FFmpeg_path, create_remux_arguments(paths[WEBM_FORMAT], paths[MATROSKA_FORMAT]))
    return paths


def generate_vector_files(tools: MediaTools, temporary_directory: Path) -> dict[str, bytes]:
    """Builds and verifies both vectors, and returns the bytes of each committed file by name."""

    vector_files: dict[str, bytes] = {}
    for container_format, path in build_vector_files(tools, temporary_directory).items():
        data = path.read_bytes()
        require_container_evidence(data, container_format, path.name)
        require_FFprobe_evidence(tools, path, path.name)
        vector_files[path.name] = data
    vector_files[EXPECTATIONS_FILE_NAME] = format_expectations(create_expectations())
    return vector_files


def parse_arguments(command_arguments: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail unless both committed vectors and the expectations match a fresh run; nothing is written",
    )
    parser.add_argument("--ffmpeg", metavar="path", help="FFmpeg executable; defaults to ffmpeg on PATH")
    parser.add_argument("--ffprobe", metavar="path", help="FFprobe executable; defaults to ffprobe on PATH")
    return parser.parse_args(command_arguments)


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Generates or checks both vectors and the expectations, and returns the process exit status."""

    arguments = parse_arguments(command_arguments)
    try:
        tools = MediaTools(
            FFmpeg_path=resolve_FFmpeg_tool("ffmpeg", arguments.ffmpeg),
            FFprobe_path=resolve_FFmpeg_tool("ffprobe", arguments.ffprobe),
        )
        check_toolchain(tools)
        with tempfile.TemporaryDirectory(prefix="webgpu-hdr10plus-vp9-") as temporary_directory:
            vector_files = generate_vector_files(tools, Path(temporary_directory))
        # Both vectors passed their checks before the first committed file is touched
        for file_name, content in vector_files.items():
            write_or_check_output(VECTOR_DIRECTORY / file_name, content, check=arguments.check)
    except (VectorGenerationError, GeneratedOutputError, ToolError, OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1
    action = "Verified" if arguments.check else "Generated"
    print(f"{action} {len(vector_files) - 1} HDR10+ VP9 vectors and {EXPECTATIONS_FILE_NAME} in {VECTOR_DIRECTORY}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
