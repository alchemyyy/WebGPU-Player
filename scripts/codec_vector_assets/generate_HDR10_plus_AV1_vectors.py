#!/usr/bin/env python3
"""Generate the HDR10+ AV1 test vectors and their known answers, or verify them with --check.

The vectors are one short AV1 Main 10 encode in BT.2020 PQ, in MP4 and in Matroska.
Each key frame's temporal unit carries a mastering display color volume (MDCV) and a content light level (CLL) metadata OBU, the same values in both.
Most temporal units also carry one HDR10+ ITU-T T.35 metadata OBU, and the metadata varies across the frames:
- profile B frames, with different curves, targeted displays, and distributions;
- a profile A frame, without a curve, whose targeted display peak is 0;
- frames without HDR10+.

libaom encodes testsrc2 with the PQ color tags, this script inserts the metadata OBUs where libaom places metadata, FFmpeg muxes the stream into an MP4, and FFmpeg remuxes that MP4 into Matroska.
This script, with HDR10_plus_metadata.py for the HDR10+ messages, serializes every payload itself, field by field, from the frame table below, which expectations.json records with each frame's T.35 message.
A message runs from its country code to its byte-aligned ST 2094-40 payload, without the OBU's trailing bits.

The generator refuses any FFmpeg build but the pinned one, because another build encodes and muxes other bytes.
Before writing, it validates:
- the metadata OBUs of every temporal unit, read back from the stream;
- the codec, color, packets, and key flags that FFprobe reads from the stream and from both containers;
- the HDR10+, mastering display, and content light level side data that FFmpeg decodes for every frame of both containers, the independent oracle.
Without --check it replaces the committed files once every check passes; with --check it fails unless each committed file matches.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Final, Mapping, Sequence

from create_dual_track_dolby_vision_MP4_vector import VectorError
from engine_layout import CODEC_VECTOR_ASSETS_DIRECTORY, layout_path
from generate_dolby_vision_AV1_vectors import (
    AV1_CODEC_NAME,
    AV1_SAMPLE_ENTRY_TYPE,
    BT2020_PQ_COLOR,
    CONTAINER_DROPPED_OBU_TYPES,
    CONTAINER_FORMATS,
    FFPROBE_EMPTY_CODEC_TAG,
    FILE_EXTENSION_BY_FORMAT,
    KEY_FRAME_TYPE,
    MATROSKA_FORMAT,
    METADATA_TYPE_ITUT_T35,
    MP4_FORMAT,
    OBU_HAS_SIZE_FIELD,
    OBU_STREAM_FORMAT,
    OBU_TRAILING_BITS_BYTE,
    OBU_TYPE_SHIFT,
    AV1EncodeSettings,
    AV1OBU,
    InjectedStream,
    OBUType,
    TemporalUnitSummary,
    create_AV1_encode_arguments,
    create_intermediate_MP4_arguments,
    create_remux_arguments,
    encode_leb128,
    get_FFmpeg_color_names,
    get_stream_color,
    get_streams,
    parse_OBUs,
    probe_media,
    read_leb128,
    read_MP4_video_signaling,
    read_shown_frame_type,
    require_OBU_stream_evidence,
    require_one_stream,
    require_video_sequence_header,
    split_temporal_units,
)
from generated_output import GeneratedOutputError, write_or_check_output
from HDR10_plus_metadata import (
    FFPROBE_HDR10_PLUS_FRAME_SIDE_DATA_TYPE,
    BezierCurve,
    DistributionPercentile,
    HDR10PlusFrame,
    SideDataEntry,
    create_distribution,
    create_expected_frame_metadata,
    create_expected_HDR10_plus_side_data,
    create_HDR10_plus_ITUT_T35_message,
    format_rational,
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


VECTOR_DIRECTORY: Final = CODEC_VECTOR_ASSETS_DIRECTORY / "hdr10plus-av1"
EXPECTATIONS_FILE_NAME: Final = "expectations.json"
VECTOR_FILE_STEM: Final = "hdr10plus"

# 192x192, like the Profile 10 vectors, so hardware decoders with a minimum coded size accept it
VECTOR_WIDTH: Final = 192
VECTOR_HEIGHT: Final = 192
VECTOR_FRAME_RATE: Final = Fraction(24)
# Six frames with a key frame every third frame, so the static metadata repeats in a second key frame's unit
VECTOR_FRAME_COUNT: Final = 6
VECTOR_KEY_FRAME_INTERVAL: Final = 3
VECTOR_CONSTANT_RATE_FACTOR: Final = 50
# One thread, one tile, and no row multithreading keep libaom's output deterministic
VECTOR_ENCODE_SETTINGS: Final = AV1EncodeSettings(
    constant_rate_factor=VECTOR_CONSTANT_RATE_FACTOR,
    frame_count=VECTOR_FRAME_COUNT,
    frame_rate=VECTOR_FRAME_RATE,
    height=VECTOR_HEIGHT,
    key_frame_interval=VECTOR_KEY_FRAME_INTERVAL,
    row_multithreading=False,
    thread_count=1,
    tile_layout="1x1",
    width=VECTOR_WIDTH,
)
VECTOR_COLOR: Final = BT2020_PQ_COLOR

# metadata_type of the AV1 specification, section 6.7.1
METADATA_TYPE_HDR_CLL: Final = 1
METADATA_TYPE_HDR_MDCV: Final = 2
# metadata_hdr_mdcv() codes chromaticities in 0.16, luminance_max in 24.8, and luminance_min in 18.14 fixed point
CHROMATICITY_SCALE: Final = 1 << 16
MAXIMUM_LUMINANCE_SCALE: Final = 1 << 8
MINIMUM_LUMINANCE_SCALE: Final = 1 << 14

# The static metadata FFprobe prints on a decoded frame
FFPROBE_MASTERING_DISPLAY_TYPE: Final = "Mastering display metadata"
FFPROBE_CONTENT_LIGHT_LEVEL_TYPE: Final = "Content light level metadata"
FFPROBE_KEY_FLAG: Final = "K"


@dataclass(frozen=True)
class MasteringDisplay:
    """The coded fields of metadata_hdr_mdcv(): the red, green, and blue primaries and the white point as (x, y), and the luminance range."""

    luminance_max: int
    luminance_min: int
    primaries: tuple[tuple[int, int], tuple[int, int], tuple[int, int]]
    white_point: tuple[int, int]


@dataclass(frozen=True)
class ContentLightLevel:
    """The coded fields of metadata_hdr_cll(), in nits."""

    maximum_content_light_level: int
    maximum_frame_average_light_level: int


def encode_chromaticity(value: str) -> int:
    """Returns a CIE 1931 chromaticity coordinate in the 0.16 fixed point of metadata_hdr_mdcv()."""

    return round(Fraction(value) * CHROMATICITY_SCALE)


# A BT.2020 mastering display with a D65 white point, 1000 nits at most and 0.005 nits at least, rounded to the coded precision
VECTOR_MASTERING_DISPLAY: Final = MasteringDisplay(
    luminance_max=1_000 * MAXIMUM_LUMINANCE_SCALE,
    luminance_min=round(Fraction("0.005") * MINIMUM_LUMINANCE_SCALE),
    primaries=(
        (encode_chromaticity("0.708"), encode_chromaticity("0.292")),
        (encode_chromaticity("0.170"), encode_chromaticity("0.797")),
        (encode_chromaticity("0.131"), encode_chromaticity("0.046")),
    ),
    white_point=(encode_chromaticity("0.3127"), encode_chromaticity("0.3290")),
)
VECTOR_CONTENT_LIGHT_LEVEL: Final = ContentLightLevel(maximum_content_light_level=940, maximum_frame_average_light_level=410)

# Two profile B frames, a frame without HDR10+, the profile A frame, another frame without HDR10+, and a last profile B frame.
# Every value differs from frame to frame, so a frame that takes another frame's metadata shows
VECTOR_FRAMES: Final[tuple[HDR10PlusFrame | None, ...]] = (
    HDR10PlusFrame(
        average_maxrgb=1_150,
        bezier_curve=BezierCurve(anchors=(130, 260, 390, 510, 620, 720, 810, 890, 960), knee_point_x=1_250, knee_point_y=1_100),
        distribution=create_distribution((12, 40, 75, 180, 420, 900, 2_100, 3_300, 7_800)),
        fraction_bright_pixels=3,
        maxscl=(9_000, 7_600, 6_200),
        targeted_system_display_maximum_luminance=1_000,
    ),
    HDR10PlusFrame(
        average_maxrgb=2_400,
        bezier_curve=BezierCurve(anchors=(300, 600, 900), knee_point_x=2_048, knee_point_y=1_536),
        distribution=(
            DistributionPercentile(percentage=1, percentile=20),
            DistributionPercentile(percentage=50, percentile=1_500),
            DistributionPercentile(percentage=99, percentile=9_500),
        ),
        fraction_bright_pixels=0,
        maxscl=(12_000, 9_800, 8_400),
        targeted_system_display_maximum_luminance=600,
    ),
    None,
    HDR10PlusFrame(
        average_maxrgb=640,
        bezier_curve=None,
        distribution=create_distribution((8, 30, 55, 140, 330, 700, 1_600, 2_500, 5_100)),
        fraction_bright_pixels=1,
        maxscl=(5_500, 4_700, 3_900),
        targeted_system_display_maximum_luminance=0,
    ),
    None,
    HDR10PlusFrame(
        average_maxrgb=3_000,
        bezier_curve=BezierCurve(anchors=(512,), knee_point_x=900, knee_point_y=700),
        distribution=(
            DistributionPercentile(percentage=50, percentile=2_000),
            DistributionPercentile(percentage=99, percentile=18_000),
        ),
        fraction_bright_pixels=5,
        maxscl=(20_000, 17_500, 15_000),
        targeted_system_display_maximum_luminance=1_000,
    ),
)


def create_mastering_display_metadata(mastering_display: MasteringDisplay) -> bytes:
    """Returns metadata_hdr_mdcv(): the primaries and white point as 16-bit pairs, then both luminances as 32-bit values."""

    chromaticities = [coordinate for primary in mastering_display.primaries for coordinate in primary]
    chromaticities.extend(mastering_display.white_point)
    return (
        b"".join(coordinate.to_bytes(2, "big") for coordinate in chromaticities)
        + mastering_display.luminance_max.to_bytes(4, "big")
        + mastering_display.luminance_min.to_bytes(4, "big")
    )


def create_content_light_level_metadata(content_light_level: ContentLightLevel) -> bytes:
    """Returns metadata_hdr_cll(): max_cll, then max_fall, as 16-bit values."""

    return (
        content_light_level.maximum_content_light_level.to_bytes(2, "big")
        + content_light_level.maximum_frame_average_light_level.to_bytes(2, "big")
    )


def create_metadata_OBU(metadata_type: int, metadata: bytes) -> bytes:
    """Returns a metadata OBU, with a size field and no extension: metadata_type, the byte-aligned metadata, then trailing_bits()."""

    payload = encode_leb128(metadata_type) + metadata + bytes((OBU_TRAILING_BITS_BYTE,))
    header = (OBUType.METADATA << OBU_TYPE_SHIFT) | OBU_HAS_SIZE_FIELD
    return bytes((header,)) + encode_leb128(len(payload)) + payload


def get_vector_key_frame_flags() -> list[bool]:
    """Returns whether each vector frame is a key frame, given the fixed key frame interval."""

    return [frame_index % VECTOR_KEY_FRAME_INTERVAL == 0 for frame_index in range(VECTOR_FRAME_COUNT)]


def get_expected_metadata(frame: HDR10PlusFrame | None, key_frame: bool) -> list[tuple[int, bytes]]:
    """Returns the metadata_type and the metadata, without trailing bits, of each metadata OBU a temporal unit carries, in order."""

    metadata: list[tuple[int, bytes]] = []
    if key_frame:
        metadata.append((METADATA_TYPE_HDR_MDCV, create_mastering_display_metadata(VECTOR_MASTERING_DISPLAY)))
        metadata.append((METADATA_TYPE_HDR_CLL, create_content_light_level_metadata(VECTOR_CONTENT_LIGHT_LEVEL)))
    if frame is not None:
        metadata.append((METADATA_TYPE_ITUT_T35, create_HDR10_plus_ITUT_T35_message(frame)))
    return metadata


def insert_HDR_metadata(stream: bytes, frames: Sequence[HDR10PlusFrame | None]) -> InjectedStream:
    """Returns the bitstream with each temporal unit's metadata OBUs, given the HDR10+ frame of each unit.

    The OBUs go before the first frame header or frame of the unit, after its temporal delimiter and sequence header, where libaom writes metadata.
    The MDCV and CLL OBUs go into the units that carry a sequence header, which must be the key frames' units.
    Every unit must show exactly one frame.
    """

    temporal_units = split_temporal_units(parse_OBUs(stream))
    if len(temporal_units) != len(frames):
        raise VectorGenerationError(f"The bitstream has {len(temporal_units)} temporal units for {len(frames)} frames")
    output = bytearray()
    summaries: list[TemporalUnitSummary] = []
    for temporal_unit, frame in zip(temporal_units, frames, strict=True):
        unit_output = bytearray()
        sample_byte_length = 0
        has_sequence_header = False
        metadata_inserted = False
        shown_frame_types: list[int] = []
        for OBU in temporal_unit:
            match OBU.OBU_type:
                case OBUType.SEQUENCE_HEADER:
                    require_video_sequence_header(OBU)
                    has_sequence_header = True
                case OBUType.METADATA:
                    raise VectorGenerationError("The encode already carries metadata OBUs")
                case OBUType.FRAME_HEADER | OBUType.FRAME:
                    if not metadata_inserted:
                        for metadata_type, metadata in get_expected_metadata(frame, has_sequence_header):
                            metadata_OBU = create_metadata_OBU(metadata_type, metadata)
                            unit_output += metadata_OBU
                            sample_byte_length += len(metadata_OBU)
                        metadata_inserted = True
                    shown_frame_type = read_shown_frame_type(OBU)
                    if shown_frame_type is not None:
                        shown_frame_types.append(shown_frame_type)
            unit_output += OBU.data
            if OBU.OBU_type not in CONTAINER_DROPPED_OBU_TYPES:
                sample_byte_length += len(OBU.data)
        if len(shown_frame_types) != 1:
            raise VectorGenerationError(f"Temporal unit {len(summaries)} shows {len(shown_frame_types)} frames instead of one")
        key_frame = shown_frame_types[0] == KEY_FRAME_TYPE
        if key_frame != has_sequence_header:
            raise VectorGenerationError(f"Temporal unit {len(summaries)} has a sequence header only where it has no key frame")
        output += unit_output
        summaries.append(TemporalUnitSummary(key_frame=key_frame, sample_byte_length=sample_byte_length))
    return InjectedStream(data=bytes(output), temporal_units=tuple(summaries))


def read_metadata(OBU: AV1OBU) -> tuple[int, bytes]:
    """Returns the metadata_type and the metadata of a metadata OBU, which must end with one 0x80 trailing bits byte."""

    metadata_type, type_byte_length = read_leb128(OBU.payload, 0)
    if not OBU.payload.endswith(bytes((OBU_TRAILING_BITS_BYTE,))):
        raise VectorGenerationError("A metadata OBU does not end with its trailing bits")
    return metadata_type, OBU.payload[type_byte_length:-1]


def read_temporal_unit_metadata(stream: bytes) -> list[list[tuple[int, bytes]]]:
    """Returns, per temporal unit, the metadata_type and the metadata of each metadata OBU a low-overhead bitstream carries."""

    return [
        [read_metadata(OBU) for OBU in temporal_unit if OBU.OBU_type == OBUType.METADATA]
        for temporal_unit in split_temporal_units(parse_OBUs(stream))
    ]


def require_injected_metadata(injected_stream: InjectedStream) -> None:
    """Requires every temporal unit to carry exactly its frame's metadata, in order."""

    require_equal(
        [
            [[metadata_type, metadata.hex()] for metadata_type, metadata in unit_metadata]
            for unit_metadata in read_temporal_unit_metadata(injected_stream.data)
        ],
        [
            [[metadata_type, metadata.hex()] for metadata_type, metadata in get_expected_metadata(frame, key_frame)]
            for frame, key_frame in zip(VECTOR_FRAMES, get_vector_key_frame_flags(), strict=True)
        ],
        "Temporal unit metadata",
    )


def create_expected_mastering_display_side_data(mastering_display: MasteringDisplay) -> SideDataEntry:
    """Returns the mastering display side data FFmpeg decodes from metadata_hdr_mdcv()."""

    entry: SideDataEntry = [("side_data_type", FFPROBE_MASTERING_DISPLAY_TYPE)]
    for color_name, (x, y) in zip(("red", "green", "blue"), mastering_display.primaries, strict=True):
        entry.append((f"{color_name}_x", format_rational(x, CHROMATICITY_SCALE)))
        entry.append((f"{color_name}_y", format_rational(y, CHROMATICITY_SCALE)))
    entry.append(("white_point_x", format_rational(mastering_display.white_point[0], CHROMATICITY_SCALE)))
    entry.append(("white_point_y", format_rational(mastering_display.white_point[1], CHROMATICITY_SCALE)))
    entry.append(("min_luminance", format_rational(mastering_display.luminance_min, MINIMUM_LUMINANCE_SCALE)))
    entry.append(("max_luminance", format_rational(mastering_display.luminance_max, MAXIMUM_LUMINANCE_SCALE)))
    return entry


def create_expected_content_light_level_side_data(content_light_level: ContentLightLevel) -> SideDataEntry:
    """Returns the content light level side data FFmpeg decodes from metadata_hdr_cll()."""

    return [
        ("side_data_type", FFPROBE_CONTENT_LIGHT_LEVEL_TYPE),
        ("max_content", content_light_level.maximum_content_light_level),
        ("max_average", content_light_level.maximum_frame_average_light_level),
    ]


def create_expected_frame_side_data() -> list[list[SideDataEntry]]:
    """Returns the side data FFmpeg decodes for each frame.

    libdav1d keeps the last mastering display and content light level metadata for every later frame, while HDR10+ belongs to its own frame alone.
    """

    return [
        [
            create_expected_mastering_display_side_data(VECTOR_MASTERING_DISPLAY),
            create_expected_content_light_level_side_data(VECTOR_CONTENT_LIGHT_LEVEL),
            *([] if frame is None else [create_expected_HDR10_plus_side_data(frame, FFPROBE_HDR10_PLUS_FRAME_SIDE_DATA_TYPE)]),
        ]
        for frame in VECTOR_FRAMES
    ]


def probe_frame_side_data(tools: MediaTools, path: Path) -> list[list[SideDataEntry]]:
    """Returns the side data FFmpeg decodes for each frame of a file, each entry as its ordered key and value pairs."""

    output = execute_tool(tools.FFprobe_path, ["-v", "error", "-show_frames", "-of", "json", str(path)])
    return [list(frame.get("side_data_list", [])) for frame in read_FFprobe_section(output, "frames", path.name)]


def require_frame_side_data(tools: MediaTools, path: Path) -> None:
    """Requires FFmpeg to decode each frame's mastering display, content light level, and HDR10+ metadata."""

    require_equal(
        [[[list(pair) for pair in entry] for entry in frame] for frame in probe_frame_side_data(tools, path)],
        [[[list(pair) for pair in entry] for entry in frame] for frame in create_expected_frame_side_data()],
        f"{path.name} frame side data",
    )


def require_container_evidence(
    probe: Mapping[str, Any],
    container_format: str,
    injected_stream: InjectedStream,
    label: str,
) -> None:
    """Requires the codec, color, packets, and absence of container HDR metadata and audio that FFprobe reads from a container."""

    stream = require_one_stream(probe, "video", label)
    expected_codec_tag = AV1_SAMPLE_ENTRY_TYPE if container_format == MP4_FORMAT else FFPROBE_EMPTY_CODEC_TAG
    require_equal(stream.get("codec_name"), AV1_CODEC_NAME, f"{label} codec")
    require_equal(stream.get("codec_tag_string"), expected_codec_tag, f"{label} codec tag")
    require_equal([stream.get("width"), stream.get("height")], [VECTOR_WIDTH, VECTOR_HEIGHT], f"{label} size")
    require_equal(get_stream_color(stream), get_FFmpeg_color_names(VECTOR_COLOR), f"{label} color")
    # The static metadata lives only in the metadata OBUs, so the engine's own reading is what a test proves
    require_equal(stream.get("side_data_list", []), [], f"{label} stream side data")
    packets = [packet for packet in probe.get("packets", []) if packet.get("stream_index") == stream.get("index")]
    # The samples are the injected temporal units without the OBUs the muxers drop
    require_equal(
        [[int(str(packet.get("size"))), str(packet.get("flags", "")).startswith(FFPROBE_KEY_FLAG)] for packet in packets],
        [[temporal_unit.sample_byte_length, temporal_unit.key_frame] for temporal_unit in injected_stream.temporal_units],
        f"{label} packet sizes and key flags",
    )
    require_equal(len(get_streams(probe, "audio")), 0, f"{label} audio stream count")


def require_MP4_signaling(data: bytes, label: str) -> None:
    """Requires an av01 sample entry with the nclx colr box FFmpeg writes for PQ, and no Dolby Vision configuration."""

    signaling = read_MP4_video_signaling(data)
    require_equal(signaling.sample_entry_type, AV1_SAMPLE_ENTRY_TYPE, f"{label} sample entry")
    require_equal(signaling.dolby_vision_configuration_record, None, f"{label} Dolby Vision configuration")
    require_equal(
        None if signaling.color is None else vars(signaling.color),
        vars(VECTOR_COLOR),
        f"{label} colr box",
    )


def get_vector_file_name(container_format: str) -> str:
    return f"{VECTOR_FILE_STEM}.{FILE_EXTENSION_BY_FORMAT[container_format]}"


def create_expectations() -> dict[str, object]:
    """Returns the known answers of both vectors, which depend only on the tables above."""

    frames = [
        {
            "HDR10Plus": None if frame is None else create_expected_frame_metadata(frame),
            "ITUTT35Message": None if frame is None else create_HDR10_plus_ITUT_T35_message(frame).hex(),
            "keyFrame": key_frame,
            # The key frames' units carry the MDCV and CLL metadata OBUs
            "staticHDRMetadata": key_frame,
        }
        for frame, key_frame in zip(VECTOR_FRAMES, get_vector_key_frame_flags(), strict=True)
    ]
    return {
        "colorPrimaries": VECTOR_COLOR.primaries,
        "contentLightLevel": {
            "maximumContentLightLevel": VECTOR_CONTENT_LIGHT_LEVEL.maximum_content_light_level,
            "maximumFrameAverageLightLevel": VECTOR_CONTENT_LIGHT_LEVEL.maximum_frame_average_light_level,
        },
        "frameCount": VECTOR_FRAME_COUNT,
        "frameRate": int(VECTOR_FRAME_RATE),
        "frames": frames,
        "fullRange": VECTOR_COLOR.full_range,
        "generator": layout_path("codecVectorScriptsDirectory", Path(__file__).name),
        "height": VECTOR_HEIGHT,
        "masteringDisplay": {
            "luminanceMax": VECTOR_MASTERING_DISPLAY.luminance_max,
            "luminanceMin": VECTOR_MASTERING_DISPLAY.luminance_min,
            "primaries": [list(primary) for primary in VECTOR_MASTERING_DISPLAY.primaries],
            "whitePoint": list(VECTOR_MASTERING_DISPLAY.white_point),
        },
        "matrixCoefficients": VECTOR_COLOR.matrix_coefficients,
        "transferCharacteristics": VECTOR_COLOR.transfer_characteristics,
        "vectors": [
            {
                "container": container_format,
                "fileName": get_vector_file_name(container_format),
                "sampleEntry": AV1_SAMPLE_ENTRY_TYPE if container_format == MP4_FORMAT else None,
            }
            for container_format in CONTAINER_FORMATS
        ],
        "width": VECTOR_WIDTH,
    }


def format_expectations(expectations: Mapping[str, object]) -> bytes:
    """Returns the expectations as sorted, two-space indented JSON with a final line feed."""

    return (json.dumps(expectations, indent=2, sort_keys=True) + "\n").encode("utf-8")


def build_vector_files(tools: MediaTools, temporary_directory: Path) -> dict[str, Path]:
    """Encodes the stream, inserts its metadata, muxes the MP4 and Matroska vectors, verifies them, and returns each file's path by name."""

    base_stream_path = temporary_directory / "base.obu"
    execute_tool(tools.FFmpeg_path, create_AV1_encode_arguments(VECTOR_ENCODE_SETTINGS, VECTOR_COLOR, base_stream_path))
    injected_stream = insert_HDR_metadata(base_stream_path.read_bytes(), VECTOR_FRAMES)
    require_injected_metadata(injected_stream)
    require_equal(
        [temporal_unit.key_frame for temporal_unit in injected_stream.temporal_units],
        get_vector_key_frame_flags(),
        "Key frames",
    )
    injected_stream_path = temporary_directory / "injected.obu"
    injected_stream_path.write_bytes(injected_stream.data)
    require_OBU_stream_evidence(
        probe_media(tools, injected_stream_path, OBU_STREAM_FORMAT),
        VECTOR_ENCODE_SETTINGS,
        VECTOR_COLOR,
        "HDR10+ bitstream",
    )

    paths = {container_format: temporary_directory / get_vector_file_name(container_format) for container_format in CONTAINER_FORMATS}
    execute_tool(
        tools.FFmpeg_path,
        create_intermediate_MP4_arguments(
            injected_stream_path,
            VECTOR_FRAME_RATE,
            None,
            VECTOR_FRAME_COUNT / VECTOR_FRAME_RATE,
            paths[MP4_FORMAT],
        ),
    )
    execute_tool(tools.FFmpeg_path, create_remux_arguments(paths[MP4_FORMAT], MATROSKA_FORMAT, paths[MATROSKA_FORMAT]))

    require_MP4_signaling(paths[MP4_FORMAT].read_bytes(), paths[MP4_FORMAT].name)
    for container_format, path in paths.items():
        require_container_evidence(probe_media(tools, path), container_format, injected_stream, path.name)
        require_frame_side_data(tools, path)
    return {path.name: path for path in paths.values()}


def generate_vector_files(tools: MediaTools, temporary_directory: Path) -> dict[str, bytes]:
    """Builds and verifies both vectors, and returns the bytes of each committed file by name."""

    vector_files = {file_name: path.read_bytes() for file_name, path in build_vector_files(tools, temporary_directory).items()}
    vector_files[EXPECTATIONS_FILE_NAME] = format_expectations(create_expectations())
    return vector_files


def parse_arguments(command_arguments: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail unless every committed vector and the expectations match a fresh run; nothing is written",
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
        with tempfile.TemporaryDirectory(prefix="webgpu-hdr10plus-av1-") as temporary_directory:
            vector_files = generate_vector_files(tools, Path(temporary_directory))
        # Every vector passed its checks before the first committed file is touched
        for file_name, content in vector_files.items():
            write_or_check_output(VECTOR_DIRECTORY / file_name, content, check=arguments.check)
    except (VectorGenerationError, VectorError, GeneratedOutputError, ToolError, OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1
    action = "Verified" if arguments.check else "Generated"
    print(f"{action} {len(vector_files) - 1} HDR10+ AV1 vectors and {EXPECTATIONS_FILE_NAME} in {VECTOR_DIRECTORY}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
