#!/usr/bin/env python3
"""Create a validation-only Matroska copy whose EL decodes only from the container hvcE record."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Sequence

from media_tools import refers_to_same_file


HEVC_FILLER_DATA_NAL_UNIT_TYPE: Final = 38
HEVC_PARAMETER_SET_NAL_UNIT_TYPES: Final = (32, 33, 34)
HVCE_BLOCK_ADD_ID_TYPE_BYTES: Final = b"hvcE"
MAXIMUM_VECTOR_BYTE_LENGTH: Final = 64 * 1_024 * 1_024
MINIMUM_WRAPPED_NAL_UNIT_BYTE_LENGTH: Final = 4
NAL_UNIT_LENGTH_PREFIX_BYTE_LENGTH: Final = 4
# Every first header byte of NAL type 63, the EL wrapper, whatever its forbidden and high layer bits
ENHANCEMENT_WRAPPER_HEADER_PATTERN: Final = re.compile(rb"[\x7e\x7f\xfe\xff]")


class VectorError(RuntimeError):
    """Reports an unsupported source vector or an invalid argument."""


@dataclass(frozen=True)
class WrappedParameterSetCandidate:
    """Locates one length-prefixed EL parameter set inside a NAL type 63 wrapper."""

    byte_length: int
    inner_header_offset: int
    NAL_unit_type: int


@dataclass(frozen=True)
class ContainerOnlyHVCEVector:
    """Holds the transformed vector and the replaced EL parameter-set types in byte order."""

    data: bytes
    replaced_NAL_unit_types: tuple[int, ...]


@dataclass(frozen=True)
class VectorConfiguration:
    """Holds the resolved CLI paths."""

    input_path: str
    output_path: str


def read_uint32_BE(data: bytes | bytearray, offset: int) -> int:
    """Reads one unsigned big-endian 32-bit integer."""

    return int.from_bytes(data[offset : offset + 4], "big")


def get_HEVC_NAL_unit_type(first_header_byte: int) -> int:
    """Returns the HEVC NAL unit type from the first header byte."""

    return (first_header_byte >> 1) & 0x3F


def find_wrapped_enhancement_parameter_sets(
    data: bytes | bytearray,
) -> list[WrappedParameterSetCandidate]:
    """Returns every length-prefixed NAL type 63 wrapper that holds an HEVC parameter set."""

    candidates: list[WrappedParameterSetCandidate] = []
    # Outer headers from the end of the first length prefix through len - 4
    search_end_offset = len(data) - MINIMUM_WRAPPED_NAL_UNIT_BYTE_LENGTH + 1
    for header_match in ENHANCEMENT_WRAPPER_HEADER_PATTERN.finditer(
        data,
        NAL_UNIT_LENGTH_PREFIX_BYTE_LENGTH,
        search_end_offset,
    ):
        outer_header_offset = header_match.start()
        inner_header_offset = outer_header_offset + 2
        inner_NAL_unit_type = get_HEVC_NAL_unit_type(data[inner_header_offset])
        if inner_NAL_unit_type not in HEVC_PARAMETER_SET_NAL_UNIT_TYPES:
            continue
        declared_byte_length = read_uint32_BE(
            data,
            outer_header_offset - NAL_UNIT_LENGTH_PREFIX_BYTE_LENGTH,
        )
        if (
            declared_byte_length < MINIMUM_WRAPPED_NAL_UNIT_BYTE_LENGTH
            or outer_header_offset + declared_byte_length > len(data)
        ):
            continue
        candidates.append(
            WrappedParameterSetCandidate(
                byte_length=declared_byte_length - 2,
                inner_header_offset=inner_header_offset,
                NAL_unit_type=inner_NAL_unit_type,
            )
        )
    return candidates


def require_one_parameter_set_of_each_type(
    candidates: Sequence[WrappedParameterSetCandidate],
) -> None:
    """Requires exactly one wrapped EL VPS, SPS, and PPS."""

    for NAL_unit_type in HEVC_PARAMETER_SET_NAL_UNIT_TYPES:
        matching_count = sum(
            1 for candidate in candidates if candidate.NAL_unit_type == NAL_unit_type
        )
        if matching_count != 1:
            raise VectorError(
                f"Expected one wrapped EL NAL type {NAL_unit_type}, found {matching_count}"
            )
    if len(candidates) != len(HEVC_PARAMETER_SET_NAL_UNIT_TYPES):
        raise VectorError("The vector has unexpected wrapped EL parameter-set copies")


def replace_with_filler_data(data: bytearray, candidate: WrappedParameterSetCandidate) -> None:
    """Replaces one wrapped parameter set with a same-size filler data NAL unit."""

    start_offset = candidate.inner_header_offset
    end_offset = start_offset + candidate.byte_length
    # Keeps the forbidden bit and the high nuh_layer_id bit
    data[start_offset] = (data[start_offset] & 0x81) | (HEVC_FILLER_DATA_NAL_UNIT_TYPE << 1)
    data[start_offset + 2 : end_offset] = b"\xff" * (end_offset - start_offset - 2)
    # The rbsp_trailing_bits stop bit
    data[end_offset - 1] = 0x80


def create_container_only_HVCE_vector(
    source_data: bytes | bytearray | memoryview,
) -> ContainerOnlyHVCEVector:
    """Creates a same-size vector that requires container hvcE for EL decode."""

    data = bytearray(source_data)
    if len(data) == 0 or len(data) > MAXIMUM_VECTOR_BYTE_LENGTH:
        raise VectorError("The source vector size is unsupported")
    if HVCE_BLOCK_ADD_ID_TYPE_BYTES not in data:
        raise VectorError("The source vector has no Matroska hvcE mapping")
    candidates = find_wrapped_enhancement_parameter_sets(data)
    require_one_parameter_set_of_each_type(candidates)
    for candidate in candidates:
        replace_with_filler_data(data, candidate)
    if find_wrapped_enhancement_parameter_sets(data):
        raise VectorError("The transformed vector still has wrapped EL parameter sets")
    return ContainerOnlyHVCEVector(
        data=bytes(data),
        replaced_NAL_unit_types=tuple(candidate.NAL_unit_type for candidate in candidates),
    )


def create_argument_parser() -> argparse.ArgumentParser:
    """Creates the container-only hvcE vector CLI."""

    parser = argparse.ArgumentParser(
        prog="python scripts/codec_vector_assets/create_container_only_HVCE_vector.py",
        description=(
            "Creates a validation-only Matroska copy whose wrapped enhancement-layer "
            "VPS/SPS/PPS NAL units are replaced by same-size filler NAL units. The copy "
            "can decode its enhancement layer only when the player reads the retained "
            "container hvcE configuration."
        ),
    )
    parser.add_argument(
        "input_path",
        metavar="input.mkv",
        help="Matroska source with an hvcE mapping and wrapped EL parameter sets",
    )
    parser.add_argument("output_path", metavar="output.mkv", help="Matroska copy to write")
    return parser


def create_configuration(arguments: argparse.Namespace) -> VectorConfiguration:
    """Resolves the CLI paths and rejects an output path that equals the input path."""

    input_path = os.path.abspath(arguments.input_path)
    output_path = os.path.abspath(arguments.output_path)
    if refers_to_same_file(input_path, output_path):
        raise VectorError("The output path must differ from the input path")
    return VectorConfiguration(input_path=input_path, output_path=output_path)


def create_vector(configuration: VectorConfiguration) -> dict[str, object]:
    """Writes the container-only hvcE vector and returns its summary."""

    vector = create_container_only_HVCE_vector(Path(configuration.input_path).read_bytes())
    Path(configuration.output_path).write_bytes(vector.data)
    return {
        "byteLength": len(vector.data),
        "outputPath": configuration.output_path,
        "replacedNALUnitTypes": list(vector.replaced_NAL_unit_types),
        "sha256": hashlib.sha256(vector.data).hexdigest(),
    }


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Runs the CLI and prints the vector summary as JSON."""

    arguments = create_argument_parser().parse_args(command_arguments)
    try:
        summary = create_vector(create_configuration(arguments))
    except (VectorError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
