#!/usr/bin/env python3
"""Create a validation-only dual-PID Profile 7 MPEG-TS vector."""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Sequence

from media_tools import ToolError, execute_tool, refers_to_same_file, resolve_FFmpeg_tool


MPEG_TS_PACKET_BYTE_LENGTH: Final = 188
MPEG_TS_SYNC_BYTE: Final = 0x47
PROGRAM_ASSOCIATION_TABLE_PID: Final = 0x0000
PROGRAM_ASSOCIATION_TABLE_ID: Final = 0x00
PROGRAM_MAP_TABLE_ID: Final = 0x02
MINIMUM_SECTION_BYTE_LENGTH: Final = 12
HEVC_STREAM_TYPE: Final = 0x24
DOLBY_VISION_VIDEO_STREAM_DESCRIPTOR_TAG: Final = 0xB0
DOLBY_VISION_PROFILE: Final = 7
# dv_level is a 6-bit field and dv_bl_signal_compatibility_id a 4-bit field
MAXIMUM_DOLBY_VISION_LEVEL: Final = 0x3F
MAXIMUM_BL_SIGNAL_COMPATIBILITY_ID: Final = 0x0F
DOVI_CONFIGURATION_RECORD_SIDE_DATA_TYPE: Final = "DOVI configuration record"
MPEG_2_CRC_POLYNOMIAL: Final = 0x04C1_1DB7
BASE_VIDEO_PID: Final = 0x100
ENHANCEMENT_VIDEO_PID: Final = 0x101
MAXIMUM_SOURCE_VECTOR_BYTE_LENGTH: Final = 128 * 1_024 * 1_024
MAXIMUM_TRANSPORT_STREAM_BYTE_LENGTH: Final = 256 * 1_024 * 1_024
TEMPORARY_DIRECTORY_PREFIX: Final = "webgpu-dovi-ts-"


class TransportStreamVectorError(RuntimeError):
    """Reports an unsupported source or generated stream, or an invalid argument."""


@dataclass(frozen=True)
class DolbyVisionConfiguration:
    """Holds the EL configuration record fields that the PMT descriptor repeats."""

    BL_signal_compatibility_ID: int
    level: int


@dataclass(frozen=True)
class PacketSection:
    """Bounds one CRC-valid PSI section carried whole in one TS packet."""

    section_end_offset: int
    section_offset: int


@dataclass(frozen=True)
class ProgramMapEnhancementEntry:
    """Locates the EL elementary-stream entry of one PMT section."""

    descriptor_end_offset: int
    entry_offset: int
    existing_descriptor_byte_length: int


@dataclass(frozen=True)
class ProgramMapPatchResult:
    """Holds the patched transport stream and its count of patched PMT packets."""

    output_data: bytes
    patched_program_map_count: int


@dataclass(frozen=True)
class VectorConfiguration:
    """Holds the resolved CLI paths."""

    configured_FFmpeg_path: str | None
    configured_FFprobe_path: str | None
    input_path: str
    output_path: str


def get_MPEG2_CRC32(data: bytes | bytearray | memoryview) -> int:
    """Returns the MPEG-2 CRC-32, which is zero over a section that ends with its own CRC."""

    CRC = 0xFFFF_FFFF
    for byte_value in data:
        CRC ^= byte_value << 24
        for _bit_index in range(8):
            CRC = (
                ((CRC << 1) ^ MPEG_2_CRC_POLYNOMIAL) & 0xFFFF_FFFF
                if CRC & 0x8000_0000
                else (CRC << 1) & 0xFFFF_FFFF
            )
    return CRC


def get_payload_offset(packet: bytes | bytearray | memoryview) -> int | None:
    """Returns where the payload of one TS packet starts, or None when it has none."""

    if len(packet) != MPEG_TS_PACKET_BYTE_LENGTH or packet[0] != MPEG_TS_SYNC_BYTE:
        return None
    adaptation_field_control = (packet[3] >> 4) & 0x03
    match adaptation_field_control:
        case 0 | 2:
            # Reserved, or an adaptation field without a payload
            return None
        case 3:
            # The adaptation_field_length byte and its field precede the payload
            payload_offset = 5 + packet[4]
        case _:
            payload_offset = 4
    return payload_offset if payload_offset < len(packet) else None


def get_packet_PID(packet: bytes | bytearray | memoryview) -> int:
    """Returns the 13-bit PID of one TS packet."""

    return ((packet[1] & 0x1F) << 8) | packet[2]


def get_single_packet_section(
    packet: bytes | bytearray | memoryview,
    expected_table_ID: int,
) -> PacketSection | None:
    """Returns the CRC-valid section that starts and ends in one packet, or None."""

    payload_offset = get_payload_offset(packet)
    # A section starts only in a packet with payload_unit_start_indicator set
    if payload_offset is None or (packet[1] & 0x40) == 0:
        return None
    # The pointer_field leads to the section start
    section_offset = payload_offset + 1 + packet[payload_offset]
    if section_offset + 3 > len(packet) or packet[section_offset] != expected_table_ID:
        return None
    section_byte_length = 3 + (
        ((packet[section_offset + 1] & 0x0F) << 8) | packet[section_offset + 2]
    )
    section_end_offset = section_offset + section_byte_length
    if (
        section_byte_length < MINIMUM_SECTION_BYTE_LENGTH
        or section_end_offset > len(packet)
        or get_MPEG2_CRC32(packet[section_offset:section_end_offset]) != 0
    ):
        return None
    return PacketSection(section_end_offset=section_end_offset, section_offset=section_offset)


def get_program_map_PIDs(data: bytes | bytearray | memoryview) -> set[int]:
    """Returns the PMT PIDs that the bounded PATs list, skipping the network PID entry."""

    program_map_PIDs: set[int] = set()
    for packet_offset in range(
        0,
        len(data) - MPEG_TS_PACKET_BYTE_LENGTH + 1,
        MPEG_TS_PACKET_BYTE_LENGTH,
    ):
        packet = data[packet_offset : packet_offset + MPEG_TS_PACKET_BYTE_LENGTH]
        if get_packet_PID(packet) != PROGRAM_ASSOCIATION_TABLE_PID:
            continue
        section = get_single_packet_section(packet, PROGRAM_ASSOCIATION_TABLE_ID)
        if section is None:
            continue
        # Four-byte program entries follow the eight-byte header and precede the CRC
        entries_end_offset = section.section_end_offset - 4
        for offset in range(section.section_offset + 8, entries_end_offset, 4):
            if offset + 4 > entries_end_offset:
                raise TransportStreamVectorError("The generated PAT is malformed")
            program_number = (packet[offset] << 8) | packet[offset + 1]
            if program_number != 0:
                program_map_PIDs.add(((packet[offset + 2] & 0x1F) << 8) | packet[offset + 3])
    if not program_map_PIDs:
        raise TransportStreamVectorError("The generated MPEG-TS has no bounded PAT")
    return program_map_PIDs


def create_dolby_vision_descriptor(base_PID: int, configuration: DolbyVisionConfiguration) -> bytes:
    """Returns the Profile 7 EL descriptor whose dependency_pid names the BL PID."""

    # The dv_profile and dv_level, then the RPU and EL present flags without the BL present flag
    configuration_bits = (DOLBY_VISION_PROFILE << 9) | (configuration.level << 3) | 0x06
    dependency_bits = base_PID << 3
    return bytes(
        (
            DOLBY_VISION_VIDEO_STREAM_DESCRIPTOR_TAG,
            # The descriptor_length, then dv_version_major and dv_version_minor
            7,
            1,
            0,
            configuration_bits >> 8,
            configuration_bits & 0xFF,
            (dependency_bits >> 8) & 0xFF,
            dependency_bits & 0xFF,
            configuration.BL_signal_compatibility_ID << 4,
        )
    )


def find_program_map_enhancement_entry(
    packet: bytes | bytearray | memoryview,
    section: PacketSection,
    base_PID: int,
    enhancement_PID: int,
) -> ProgramMapEnhancementEntry | None:
    """Returns the one HEVC EL entry of a PMT that also lists the HEVC BL, or None."""

    entries_end_offset = section.section_end_offset - 4
    program_info_byte_length = (
        ((packet[section.section_offset + 10] & 0x0F) << 8)
        | packet[section.section_offset + 11]
    )
    offset = section.section_offset + 12 + program_info_byte_length
    base_layer_found = False
    enhancement_entry: ProgramMapEnhancementEntry | None = None
    while offset < entries_end_offset:
        if offset + 5 > entries_end_offset:
            raise TransportStreamVectorError("The generated PMT stream entry is truncated")
        stream_type = packet[offset]
        PID = ((packet[offset + 1] & 0x1F) << 8) | packet[offset + 2]
        descriptor_byte_length = ((packet[offset + 3] & 0x0F) << 8) | packet[offset + 4]
        descriptor_end_offset = offset + 5 + descriptor_byte_length
        if descriptor_end_offset > entries_end_offset:
            raise TransportStreamVectorError("The generated PMT descriptor loop is malformed")
        if PID == base_PID and stream_type == HEVC_STREAM_TYPE:
            base_layer_found = True
        if PID == enhancement_PID and stream_type == HEVC_STREAM_TYPE:
            if enhancement_entry is not None:
                raise TransportStreamVectorError("The generated PMT repeats the EL PID")
            enhancement_entry = ProgramMapEnhancementEntry(
                descriptor_end_offset=descriptor_end_offset,
                entry_offset=offset,
                existing_descriptor_byte_length=descriptor_byte_length,
            )
        offset = descriptor_end_offset
    if not base_layer_found or enhancement_entry is None:
        return None
    return enhancement_entry


def patch_program_map_packet(
    packet: bytearray | memoryview,
    configuration: DolbyVisionConfiguration,
    base_PID: int,
    enhancement_PID: int,
) -> bool:
    """Appends the Dolby Vision descriptor to the EL entry of one PMT packet in place, if any."""

    section = get_single_packet_section(packet, PROGRAM_MAP_TABLE_ID)
    if section is None:
        return False
    enhancement_entry = find_program_map_enhancement_entry(
        packet,
        section,
        base_PID,
        enhancement_PID,
    )
    if enhancement_entry is None:
        return False
    descriptor = create_dolby_vision_descriptor(base_PID, configuration)
    next_section_end_offset = section.section_end_offset + len(descriptor)
    if next_section_end_offset > len(packet):
        raise TransportStreamVectorError("The generated PMT has no descriptor stuffing")
    # Moves the following entries and the old CRC behind the inserted descriptor
    descriptor_offset = enhancement_entry.descriptor_end_offset
    packet[descriptor_offset + len(descriptor) : next_section_end_offset] = bytes(
        packet[descriptor_offset : section.section_end_offset]
    )
    packet[descriptor_offset : descriptor_offset + len(descriptor)] = descriptor

    next_descriptor_byte_length = (
        enhancement_entry.existing_descriptor_byte_length + len(descriptor)
    )
    packet[enhancement_entry.entry_offset + 3] = 0xF0 | (next_descriptor_byte_length >> 8)
    packet[enhancement_entry.entry_offset + 4] = next_descriptor_byte_length & 0xFF
    previous_section_length = (
        ((packet[section.section_offset + 1] & 0x0F) << 8)
        | packet[section.section_offset + 2]
    )
    next_section_length = previous_section_length + len(descriptor)
    packet[section.section_offset + 1] = 0xB0 | (next_section_length >> 8)
    packet[section.section_offset + 2] = next_section_length & 0xFF

    CRC_offset = next_section_end_offset - 4
    CRC = get_MPEG2_CRC32(packet[section.section_offset : CRC_offset])
    packet[CRC_offset:next_section_end_offset] = CRC.to_bytes(4, "big")
    packet[next_section_end_offset:] = b"\xff" * (len(packet) - next_section_end_offset)
    return True


def patch_dolby_vision_program_maps(
    source_data: bytes | bytearray | memoryview,
    configuration: DolbyVisionConfiguration,
    base_PID: int = BASE_VIDEO_PID,
    enhancement_PID: int = ENHANCEMENT_VIDEO_PID,
) -> ProgramMapPatchResult:
    """Adds deterministic Profile 7 dependency descriptors, carrying the EL's level, to compatible single-packet PMTs."""

    if not isinstance(source_data, (bytes, bytearray, memoryview)) or len(source_data) == 0:
        raise TransportStreamVectorError("The generated MPEG-TS is empty")
    if len(source_data) % MPEG_TS_PACKET_BYTE_LENGTH != 0:
        raise TransportStreamVectorError("The generated MPEG-TS packet alignment is invalid")
    output_data = bytearray(source_data)
    patched_program_map_count = 0
    with memoryview(output_data) as output_view:
        program_map_PIDs = get_program_map_PIDs(output_view)
        for packet_offset in range(0, len(output_data), MPEG_TS_PACKET_BYTE_LENGTH):
            # Each packet view writes through to the output copy
            packet = output_view[packet_offset : packet_offset + MPEG_TS_PACKET_BYTE_LENGTH]
            if get_packet_PID(packet) not in program_map_PIDs:
                continue
            if patch_program_map_packet(packet, configuration, base_PID, enhancement_PID):
                patched_program_map_count += 1
    if patched_program_map_count == 0:
        raise TransportStreamVectorError(
            "No generated PMT contains the expected HEVC BL and EL PIDs"
        )
    return ProgramMapPatchResult(
        output_data=bytes(output_data),
        patched_program_map_count=patched_program_map_count,
    )


def create_transport_stream_FFmpeg_arguments(input_path: str, output_path: str) -> list[str]:
    """Returns the copy-only FFmpeg arguments that mux both HEVC tracks onto stable PIDs."""

    return [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        input_path,
        "-map",
        "0:v:0",
        "-map",
        "0:v:1",
        "-c:v",
        "copy",
        "-streamid",
        f"0:{BASE_VIDEO_PID}",
        "-streamid",
        f"1:{ENHANCEMENT_VIDEO_PID}",
        "-map_metadata",
        "-1",
        "-f",
        "mpegts",
        output_path,
    ]


def create_enhancement_layer_probe_arguments(input_path: str) -> list[str]:
    """Returns the FFprobe arguments that print the second video track's stream fields as JSON."""

    return ["-v", "error", "-select_streams", "v:1", "-show_streams", "-of", "json", input_path]


def require_record_integer(record: dict[str, object], field_name: str, maximum_value: int) -> int:
    """Returns one integer field of a configuration record, rejecting a missing or out-of-range value."""

    value = record.get(field_name)
    # JSON booleans parse as int subclasses but are not numbers
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum_value:
        raise TransportStreamVectorError(f"The enhancement track has an invalid Dolby Vision {field_name}")
    return value


def parse_enhancement_layer_configuration(probe_output: str) -> DolbyVisionConfiguration:
    """Returns the Profile 7 EL configuration record from FFprobe's JSON for the second video track."""

    try:
        probe_result: object = json.loads(probe_output)
    except ValueError as error:
        raise TransportStreamVectorError("FFprobe returned invalid stream JSON") from error
    streams = probe_result.get("streams") if isinstance(probe_result, dict) else None
    if not isinstance(streams, list) or len(streams) != 1 or not isinstance(streams[0], dict):
        raise TransportStreamVectorError("The source has no second video track")
    side_data_list = streams[0].get("side_data_list")
    records = [
        side_data
        for side_data in (side_data_list if isinstance(side_data_list, list) else [])
        if isinstance(side_data, dict)
        and side_data.get("side_data_type") == DOVI_CONFIGURATION_RECORD_SIDE_DATA_TYPE
    ]
    if len(records) != 1:
        raise TransportStreamVectorError("The enhancement track has no Dolby Vision configuration record")
    record = records[0]
    if (
        record.get("dv_profile") != DOLBY_VISION_PROFILE
        or record.get("rpu_present_flag") != 1
        or record.get("el_present_flag") != 1
    ):
        raise TransportStreamVectorError("The enhancement track is not an RPU-bearing Profile 7 EL")
    return DolbyVisionConfiguration(
        BL_signal_compatibility_ID=require_record_integer(
            record,
            "dv_bl_signal_compatibility_id",
            MAXIMUM_BL_SIGNAL_COMPATIBILITY_ID,
        ),
        level=require_record_integer(record, "dv_level", MAXIMUM_DOLBY_VISION_LEVEL),
    )


def create_argument_parser() -> argparse.ArgumentParser:
    """Creates the dual-PID transport stream vector CLI."""

    parser = argparse.ArgumentParser(
        prog="python scripts/codec_vector_assets/create_dual_PID_dolby_vision_TS_vector.py",
        description=(
            "Creates a validation-only dual-PID MPEG-TS vector. Both HEVC PIDs remain "
            "stream_type 0x24 so Mediabunny exposes them; the EL PMT entry receives a "
            "Profile 7 Dolby Vision dependency descriptor with the level and BL signal "
            "compatibility ID of the EL's own configuration record, which FFprobe reads. "
            "The input must expose ordinary HEVC BL and EL/RPU tracks, such as the output "
            "of the separate-track Matroska or structural Profile 7 playback vector "
            "generators."
        ),
    )
    parser.add_argument(
        "input_path",
        metavar="two-track-profile7-input",
        help="Source whose first two video tracks are the HEVC BL and EL/RPU",
    )
    parser.add_argument("output_path", metavar="output.ts", help="MPEG-TS vector to write")
    parser.add_argument(
        "--ffmpeg",
        dest="configured_FFmpeg_path",
        metavar="path",
        help="FFmpeg executable; defaults to ffmpeg on PATH",
    )
    parser.add_argument(
        "--ffprobe",
        dest="configured_FFprobe_path",
        metavar="path",
        help="FFprobe executable; defaults to ffprobe on PATH",
    )
    return parser


def resolve_configured_path(configured_path: str | None, option_name: str) -> str | None:
    """Returns an option's path made absolute, rejecting an empty value."""

    if configured_path is None:
        return None
    if not configured_path:
        raise TransportStreamVectorError(f"{option_name} requires a path")
    return os.path.abspath(configured_path)


def create_configuration(arguments: argparse.Namespace) -> VectorConfiguration:
    """Resolves the CLI paths and rejects an output path that names the input file."""

    configured_FFmpeg_path = resolve_configured_path(arguments.configured_FFmpeg_path, "--ffmpeg")
    configured_FFprobe_path = resolve_configured_path(arguments.configured_FFprobe_path, "--ffprobe")
    input_path = os.path.abspath(arguments.input_path)
    output_path = os.path.abspath(arguments.output_path)
    if refers_to_same_file(input_path, output_path):
        raise TransportStreamVectorError("The output path must differ from the input path")
    return VectorConfiguration(
        configured_FFmpeg_path=configured_FFmpeg_path,
        configured_FFprobe_path=configured_FFprobe_path,
        input_path=input_path,
        output_path=output_path,
    )


def create_vector(configuration: VectorConfiguration) -> dict[str, object]:
    """Writes the dual-PID transport stream vector and returns its summary."""

    source_status = os.stat(configuration.input_path)
    if (
        not stat.S_ISREG(source_status.st_mode)
        or source_status.st_size > MAXIMUM_SOURCE_VECTOR_BYTE_LENGTH
    ):
        raise TransportStreamVectorError("The source vector size is unsupported")
    FFmpeg_path = resolve_FFmpeg_tool("ffmpeg", configuration.configured_FFmpeg_path)
    FFprobe_path = resolve_FFmpeg_tool("ffprobe", configuration.configured_FFprobe_path)
    # The descriptor repeats the EL's own configuration, so the source is probed before anything is written
    dolby_vision_configuration = parse_enhancement_layer_configuration(
        execute_tool(FFprobe_path, create_enhancement_layer_probe_arguments(configuration.input_path))
    )
    with tempfile.TemporaryDirectory(prefix=TEMPORARY_DIRECTORY_PREFIX) as temporary_directory:
        generated_path = Path(temporary_directory) / "generated.ts"
        execute_tool(
            FFmpeg_path,
            create_transport_stream_FFmpeg_arguments(
                configuration.input_path,
                str(generated_path),
            ),
        )
        generated_status = generated_path.stat()
        if (
            not stat.S_ISREG(generated_status.st_mode)
            or generated_status.st_size > MAXIMUM_TRANSPORT_STREAM_BYTE_LENGTH
        ):
            raise TransportStreamVectorError("The generated MPEG-TS size is unsupported")
        result = patch_dolby_vision_program_maps(
            generated_path.read_bytes(),
            dolby_vision_configuration,
        )
        Path(configuration.output_path).write_bytes(result.output_data)
        return {
            "basePID": BASE_VIDEO_PID,
            "colorFidelityReference": False,
            "dolbyVisionLevel": dolby_vision_configuration.level,
            "enhancementPID": ENHANCEMENT_VIDEO_PID,
            "outputByteLength": len(result.output_data),
            "outputPath": configuration.output_path,
            "patchedProgramMapCount": result.patched_program_map_count,
        }


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Runs the CLI and prints the vector summary as JSON."""

    arguments = create_argument_parser().parse_args(command_arguments)
    try:
        summary = create_vector(create_configuration(arguments))
    except (TransportStreamVectorError, ToolError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
