#!/usr/bin/env python3
"""Create a validation-only Matroska vector with separate Profile 7 BL and EL/RPU tracks."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
import tempfile
from dataclasses import dataclass
from enum import IntEnum
from pathlib import Path
from typing import Final, Sequence, TypeGuard

from media_tools import ToolError, execute_tool, refers_to_same_file, resolve_MKVToolNix_tool


ANNEX_B_START_CODE: Final = b"\x00\x00\x00\x01"
THREE_BYTE_ANNEX_B_START_CODE: Final = b"\x00\x00\x01"
DOLBY_VISION_CONFIGURATION_MARKER: Final = b"dvcC"
HEVC_PARAMETER_SET_NAL_UNIT_TYPES: Final = (32, 33, 34)
MAXIMUM_VCL_NAL_UNIT_TYPE: Final = 31
MINIMUM_HEVC_NAL_UNIT_BYTE_LENGTH: Final = 2
MINIMUM_REPEATED_ACCESS_UNIT_COUNT: Final = 3
MAXIMUM_SOURCE_VECTOR_BYTE_LENGTH: Final = 64 * 1_024 * 1_024
MAXIMUM_SAFE_INTEGER: Final = 2**53 - 1
DETERMINISTIC_MUX_SEED: Final = "webgpu-dolby-vision-separate-track-v1"
DEFAULT_DURATION: Final = "0:24000/1001p"
MATROSKA_HEVC_CODEC_ID: Final = "V_MPEGH/ISO/HEVC"
TEMPORARY_DIRECTORY_PREFIX: Final = "webgpu-dovi-separate-"


class NALUnitType(IntEnum):
    """Names the HEVC NAL unit types that carry Dolby Vision data."""

    DOLBY_VISION_RPU = 62
    DOLBY_VISION_ENHANCEMENT_WRAPPER = 63


class VectorError(RuntimeError):
    """Reports an unsupported source or an invalid argument."""


@dataclass(frozen=True)
class AnnexBStartCode:
    """Locates one three- or four-byte Annex B start code."""

    byte_length: int
    offset: int


@dataclass(frozen=True)
class DolbyVisionLayerSplit:
    """Holds the BL and EL/RPU Annex B streams of one interleaved access unit."""

    base_layer_data: bytes
    enhancement_layer_data: bytes
    enhancement_wrapper_count: int
    RPU_count: int


@dataclass(frozen=True)
class VectorConfiguration:
    """Holds the resolved CLI paths."""

    input_path: str
    MKVToolNix_directory: str | None
    output_path: str


def get_NAL_unit_type(NAL_unit: bytes | memoryview) -> int:
    return (NAL_unit[0] >> 1) & 0x3F


def find_annex_B_start_codes(data: bytes) -> list[AnnexBStartCode]:
    """Returns every three- or four-byte Annex B start code in byte order."""

    start_codes: list[AnnexBStartCode] = []
    search_offset = 0
    three_byte_offset = data.find(THREE_BYTE_ANNEX_B_START_CODE, search_offset)
    while three_byte_offset >= 0:
        # A preceding zero that the previous start code did not claim makes the four-byte form
        if three_byte_offset > search_offset and data[three_byte_offset - 1] == 0:
            start_code = AnnexBStartCode(byte_length=4, offset=three_byte_offset - 1)
        else:
            start_code = AnnexBStartCode(byte_length=3, offset=three_byte_offset)
        start_codes.append(start_code)
        search_offset = start_code.offset + start_code.byte_length
        three_byte_offset = data.find(THREE_BYTE_ANNEX_B_START_CODE, search_offset)
    return start_codes


def require_elementary_stream(NAL_unit_types: set[int], layer: str) -> None:
    """Requires every HEVC parameter set and at least one VCL NAL unit in one layer."""

    for parameter_set_type in HEVC_PARAMETER_SET_NAL_UNIT_TYPES:
        if parameter_set_type not in NAL_unit_types:
            raise VectorError(f"{layer} stream has no HEVC NAL type {parameter_set_type}")
    if not any(NAL_unit_type <= MAXIMUM_VCL_NAL_UNIT_TYPE for NAL_unit_type in NAL_unit_types):
        raise VectorError(f"{layer} stream has no VCL NAL unit")


def split_interleaved_dolby_vision_annex_B(source_data: bytes | bytearray | memoryview) -> DolbyVisionLayerSplit:
    """Splits one Annex B interleaved Profile 7 access unit into BL and EL/RPU streams."""

    data = bytes(source_data)
    if len(data) == 0 or len(data) > MAXIMUM_SOURCE_VECTOR_BYTE_LENGTH:
        raise VectorError("The extracted HEVC vector size is unsupported")
    start_codes = find_annex_B_start_codes(data)
    if not start_codes or start_codes[0].offset != 0:
        raise VectorError("The extracted HEVC vector is not Annex B")

    base_layer_data = bytearray()
    enhancement_layer_data = bytearray()
    base_layer_types: set[int] = set()
    enhancement_layer_types: set[int] = set()
    enhancement_wrapper_count = 0
    RPU_count = 0
    data_view = memoryview(data)
    for NAL_unit_index, start_code in enumerate(start_codes):
        NAL_unit_offset = start_code.offset + start_code.byte_length
        NAL_unit_end_offset = (
            start_codes[NAL_unit_index + 1].offset
            if NAL_unit_index + 1 < len(start_codes)
            else len(data)
        )
        NAL_unit = data_view[NAL_unit_offset:NAL_unit_end_offset]
        if len(NAL_unit) < MINIMUM_HEVC_NAL_UNIT_BYTE_LENGTH:
            raise VectorError("The extracted HEVC vector contains a truncated NAL unit")
        NAL_unit_type = get_NAL_unit_type(NAL_unit)
        match NAL_unit_type:
            case NALUnitType.DOLBY_VISION_ENHANCEMENT_WRAPPER:
                # The EL NAL unit follows the wrapper's own two-byte header
                enhancement_NAL_unit = NAL_unit[2:]
                if len(enhancement_NAL_unit) < MINIMUM_HEVC_NAL_UNIT_BYTE_LENGTH:
                    raise VectorError("A wrapped Dolby Vision EL NAL unit is truncated")
                enhancement_layer_data += ANNEX_B_START_CODE
                enhancement_layer_data += enhancement_NAL_unit
                enhancement_layer_types.add(get_NAL_unit_type(enhancement_NAL_unit))
                enhancement_wrapper_count += 1
            case NALUnitType.DOLBY_VISION_RPU:
                enhancement_layer_data += ANNEX_B_START_CODE
                enhancement_layer_data += NAL_unit
                enhancement_layer_types.add(NAL_unit_type)
                RPU_count += 1
            case _:
                base_layer_data += ANNEX_B_START_CODE
                base_layer_data += NAL_unit
                base_layer_types.add(NAL_unit_type)

    require_elementary_stream(base_layer_types, "Base-layer")
    require_elementary_stream(enhancement_layer_types, "Enhancement-layer")
    if enhancement_wrapper_count == 0 or RPU_count != 1:
        raise VectorError(
            f"Expected wrapped EL data and one RPU, found {enhancement_wrapper_count} "
            f"wrappers and {RPU_count} RPUs"
        )
    return DolbyVisionLayerSplit(
        base_layer_data=bytes(base_layer_data),
        enhancement_layer_data=bytes(enhancement_layer_data),
        enhancement_wrapper_count=enhancement_wrapper_count,
        RPU_count=RPU_count,
    )


def create_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python scripts/codec_vector_assets/create_separate_track_dolby_vision_vector.py",
        description=(
            "Creates a validation-only Matroska vector with one BL track and one "
            "Profile 7 EL/RPU track. MKVToolNix is required. The source must contain "
            "exactly one HEVC video track with interleaved NAL type 63 enhancement data."
        ),
    )
    parser.add_argument(
        "input_path",
        metavar="interleaved-profile7.mkv",
        help="Matroska source with one interleaved Profile 7 HEVC track",
    )
    parser.add_argument("output_path", metavar="output.mkv", help="Matroska vector to write")
    parser.add_argument(
        "--mkvtoolnix-directory",
        dest="MKVToolNix_directory",
        metavar="directory",
        help="Directory holding mkvmerge and mkvextract",
    )
    return parser


def create_configuration(arguments: argparse.Namespace) -> VectorConfiguration:
    """Resolves the CLI paths and rejects an output path that equals the input path."""

    MKVToolNix_directory: str | None = None
    if arguments.MKVToolNix_directory is not None:
        if not arguments.MKVToolNix_directory:
            raise VectorError("--mkvtoolnix-directory requires a directory")
        MKVToolNix_directory = os.path.abspath(arguments.MKVToolNix_directory)
    input_path = os.path.abspath(arguments.input_path)
    output_path = os.path.abspath(arguments.output_path)
    if refers_to_same_file(input_path, output_path):
        raise VectorError("The output path must differ from the input path")
    return VectorConfiguration(
        input_path=input_path,
        MKVToolNix_directory=MKVToolNix_directory,
        output_path=output_path,
    )


def reject_nonstandard_JSON_constant(name: str) -> object:
    """Rejects NaN and Infinity, which strict JSON forbids."""

    raise ValueError(f"Nonstandard JSON constant: {name}")


def identify_matroska(mkvmerge_path: str, input_path: str) -> object:
    """Returns the mkvmerge JSON identification of one Matroska file."""

    standard_output = execute_tool(mkvmerge_path, ["-J", input_path])
    try:
        return json.loads(standard_output, parse_constant=reject_nonstandard_JSON_constant)
    except ValueError as error:
        raise VectorError(
            "MKVToolNix returned invalid identification JSON for "
            f"{os.path.basename(input_path)}"
        ) from error


def is_safe_integer(value: object) -> TypeGuard[int | float]:
    """Returns whether a JSON number is an integer that a double represents exactly."""

    # JSON booleans parse as int subclasses but are not numbers
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return abs(value) <= MAXIMUM_SAFE_INTEGER
    if isinstance(value, float):
        return value.is_integer() and abs(value) <= MAXIMUM_SAFE_INTEGER
    return False


def require_single_HEVC_video_track(identification: object) -> int:
    """Returns the ID of the only HEVC video track in an mkvmerge identification."""

    tracks = identification.get("tracks") if isinstance(identification, dict) else None
    video_tracks: list[dict[str, object]] = []
    if isinstance(tracks, list):
        for track in tracks:
            if not isinstance(track, dict) or track.get("type") != "video":
                continue
            properties = track.get("properties")
            if (
                isinstance(properties, dict)
                and properties.get("codec_id") == MATROSKA_HEVC_CODEC_ID
            ):
                video_tracks.append(track)
    track_ID = video_tracks[0].get("id") if len(video_tracks) == 1 else None
    if not is_safe_integer(track_ID):
        raise VectorError("The source must contain exactly one Matroska HEVC video track")
    return int(track_ID)


def repeat_access_unit(data: bytes) -> bytes:
    """Repeats one access unit the minimum number of times a track needs."""

    return data * MINIMUM_REPEATED_ACCESS_UNIT_COUNT


def create_track_extraction_arguments(
    input_path: str,
    track_ID: int,
    output_path: str,
) -> list[str]:
    """Returns the mkvextract arguments that write one track as an elementary stream."""

    return ["tracks", input_path, f"{track_ID}:{output_path}"]


def create_separate_track_MKVMerge_arguments(
    base_layer_path: str,
    enhancement_layer_path: str,
    output_path: str,
) -> list[str]:
    """Returns the deterministic mkvmerge arguments that mux the BL and EL/RPU tracks."""

    return [
        "--output",
        output_path,
        "--deterministic",
        DETERMINISTIC_MUX_SEED,
        "--no-date",
        "--disable-track-statistics-tags",
        "--default-duration",
        DEFAULT_DURATION,
        base_layer_path,
        "--default-duration",
        DEFAULT_DURATION,
        enhancement_layer_path,
    ]


def create_vector(configuration: VectorConfiguration) -> dict[str, object]:
    """Writes the separate-track vector and returns its summary."""

    source_status = os.stat(configuration.input_path)
    if (
        not stat.S_ISREG(source_status.st_mode)
        or source_status.st_size > MAXIMUM_SOURCE_VECTOR_BYTE_LENGTH
    ):
        raise VectorError("The source vector size is unsupported")
    mkvextract_path = resolve_MKVToolNix_tool("mkvextract", configuration.MKVToolNix_directory)
    mkvmerge_path = resolve_MKVToolNix_tool("mkvmerge", configuration.MKVToolNix_directory)
    source_identification = identify_matroska(mkvmerge_path, configuration.input_path)
    source_track_ID = require_single_HEVC_video_track(source_identification)
    with tempfile.TemporaryDirectory(prefix=TEMPORARY_DIRECTORY_PREFIX) as temporary_directory:
        interleaved_path = Path(temporary_directory) / "interleaved.hevc"
        base_layer_path = Path(temporary_directory) / "base-layer.hevc"
        enhancement_layer_path = Path(temporary_directory) / "enhancement-layer.hevc"
        execute_tool(
            mkvextract_path,
            create_track_extraction_arguments(
                configuration.input_path,
                source_track_ID,
                str(interleaved_path),
            ),
        )
        split = split_interleaved_dolby_vision_annex_B(interleaved_path.read_bytes())
        base_layer_path.write_bytes(repeat_access_unit(split.base_layer_data))
        enhancement_layer_path.write_bytes(repeat_access_unit(split.enhancement_layer_data))
        execute_tool(
            mkvmerge_path,
            create_separate_track_MKVMerge_arguments(
                str(base_layer_path),
                str(enhancement_layer_path),
                configuration.output_path,
            ),
        )
        output_data = Path(configuration.output_path).read_bytes()
        if DOLBY_VISION_CONFIGURATION_MARKER not in output_data:
            raise VectorError("The separate enhancement track has no dvcC mapping")
        return {
            "baseLayerAccessUnitByteLength": len(split.base_layer_data),
            "byteLength": len(output_data),
            "enhancementLayerAccessUnitByteLength": len(split.enhancement_layer_data),
            "enhancementWrapperCount": split.enhancement_wrapper_count,
            "outputPath": configuration.output_path,
            "repeatedAccessUnitCount": MINIMUM_REPEATED_ACCESS_UNIT_COUNT,
            "rpuCount": split.RPU_count,
            "sha256": hashlib.sha256(output_data).hexdigest(),
        }


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Runs the CLI and prints the vector summary as JSON."""

    arguments = create_argument_parser().parse_args(command_arguments)
    try:
        summary = create_vector(create_configuration(arguments))
    except (VectorError, ToolError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
