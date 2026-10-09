#!/usr/bin/env python3
"""Generate the Dolby Vision Profile 10 AV1 test vectors and their known answers, or verify them with --check.

Each vector is a short AV1 Main 10 encode, in MP4 and in Matroska, for one sub-profile: 10.0, 10.1, 10.2, or 10.4.
Every temporal unit carries one Dolby Vision RPU in an ITU-T T.35 metadata OBU, and the container signals the configuration record: a dvvC box in a dav1 (10.0) or av01 sample entry, or a Matroska BlockAdditionMapping.

The RPUs are dovi_tool test payloads from the test vector folder, carried byte for byte as the EMDF payload of the T.35 container that the dolby_vision crate and FFmpeg write.
The T.35 payload of a frame therefore parses to the packed output of the HEVC parse of its source RPU file, the known answer expectations.json records.
FFmpeg's own AV1 Dolby Vision encoding is not used: its encoders rebuild every RPU from AVDOVIMetadata, which reorders the extension blocks of the Profile 8 payloads, and they cannot signal 10.0 without the RPU header at encoder setup.

For each sub-profile:
- libaom encodes testsrc2 with the base color tags of the sub-profile;
- this script inserts the T.35 OBUs where libaom places metadata;
- FFmpeg muxes an intermediate MP4, to which this script adds a dvvC box;
- FFmpeg remuxes that file into both vectors, writing the container records from the configuration it read.
The 10.0 MP4 sample entry is then renamed dav1, which FFmpeg cannot write.

Mode: pinned build.
Another FFmpeg build encodes and muxes other bytes, so the generator refuses any build but the pinned one.
Before writing, it validates:
- every temporal unit;
- the container records, color tags, and packets that FFprobe reads back;
- that FFmpeg parses the same Dolby Vision metadata from each T.35 OBU as from the HEVC carriage of its source RPU.
Without --check it replaces the committed files once every check passes; with --check it fails unless each committed file matches.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tempfile
from dataclasses import dataclass
from enum import IntEnum
from fractions import Fraction
from pathlib import Path
from typing import Any, Final, Mapping, Sequence

from create_dual_track_dolby_vision_MP4_vector import (
    VISUAL_SAMPLE_ENTRY_FIELD_BYTE_LENGTH,
    BMFFBox,
    VectorError,
    create_box,
    find_required_box,
    find_unique_box,
    parse_box,
    parse_children,
    read_four_CC,
    read_unsigned_32,
    write_unsigned_32,
)
from engine_layout import CODEC_VECTOR_ASSETS_DIRECTORY, TEST_VECTORS_DIRECTORY, layout_path
from generated_output import GeneratedOutputError, write_or_check_output
from media_tools import ToolError, execute_tool, resolve_FFmpeg_tool


VECTOR_DIRECTORY: Final = CODEC_VECTOR_ASSETS_DIRECTORY / "dolby-vision-av1"
EXPECTATIONS_FILE_NAME: Final = "expectations.json"
RPU_SOURCE_FOLDER_NAME: Final = "dolby-vision-rpu"
RPU_SOURCE_DIRECTORY: Final = TEST_VECTORS_DIRECTORY / RPU_SOURCE_FOLDER_NAME
REQUIRED_FFMPEG_VERSION: Final = "2026-03-01-git-862338fe31-full_build-www.gyan.dev"
# The libraries that encode and mux the vectors
REQUIRED_LIBRARY_VERSION_PATTERNS: Final = (
    re.compile(r"libavcodec\s+62\.\s*24\.100"),
    re.compile(r"libavformat\s+62\.\s*10\.101"),
)

# H.273 code points
UNSPECIFIED_COLOR_CODE: Final = 2
BT709_COLOR_CODE: Final = 1
BT2020_PRIMARIES: Final = 9
PQ_TRANSFER: Final = 16
HLG_TRANSFER: Final = 18
BT2020_NON_CONSTANT_LUMINANCE_MATRIX: Final = 9
# FFmpeg's names for the code points above, as setparams takes them and FFprobe reports them
FFMPEG_PRIMARIES_NAMES: Final[Mapping[int, str]] = {
    BT709_COLOR_CODE: "bt709",
    UNSPECIFIED_COLOR_CODE: "unknown",
    BT2020_PRIMARIES: "bt2020",
}
FFMPEG_TRANSFER_NAMES: Final[Mapping[int, str]] = {
    BT709_COLOR_CODE: "bt709",
    UNSPECIFIED_COLOR_CODE: "unknown",
    PQ_TRANSFER: "smpte2084",
    HLG_TRANSFER: "arib-std-b67",
}
FFMPEG_MATRIX_NAMES: Final[Mapping[int, str]] = {
    BT709_COLOR_CODE: "bt709",
    UNSPECIFIED_COLOR_CODE: "unknown",
    BT2020_NON_CONSTANT_LUMINANCE_MATRIX: "bt2020nc",
}
FFMPEG_FULL_RANGE_NAME: Final = "pc"
FFMPEG_LIMITED_RANGE_NAME: Final = "tv"
FFPROBE_UNKNOWN_VALUE: Final = "unknown"

PIXEL_FORMAT: Final = "yuv420p10le"
FFPROBE_AV1_PROFILE: Final = "Main"
AV1_CODEC_NAME: Final = "av1"
# FFprobe's codec name for a sample entry that maps to no codec, as dav1 does; its JSON leaves the field out
FFPROBE_UNKNOWN_CODEC_NAME: Final = "unknown"
# FFprobe's codec_tag_string when a container stores no FourCC, as Matroska does
FFPROBE_EMPTY_CODEC_TAG: Final = "[0][0][0][0]"
MP4_FORMAT: Final = "mp4"
MATROSKA_FORMAT: Final = "matroska"
CONTAINER_FORMATS: Final = (MP4_FORMAT, MATROSKA_FORMAT)
FILE_EXTENSION_BY_FORMAT: Final[Mapping[str, str]] = {MP4_FORMAT: "mp4", MATROSKA_FORMAT: "mkv"}
OBU_STREAM_FORMAT: Final = "obu"
HEVC_STREAM_FORMAT: Final = "hevc"
# Divides into whole sample durations at both 24 and 24000/1001 frames per second
MP4_VIDEO_TIMESCALE: Final = 24_000

# 192x192, like the HEVC range-extension vectors, so hardware decoders with a minimum coded size accept it
VECTOR_WIDTH: Final = 192
VECTOR_HEIGHT: Final = 192
VECTOR_FRAME_RATE: Final = Fraction(24)
# Four frames with a key frame every second frame: two key and two inter temporal units
VECTOR_FRAME_COUNT: Final = 4
VECTOR_KEY_FRAME_INTERVAL: Final = 2
VECTOR_CONSTANT_RATE_FACTOR: Final = 50

# The RPU files store a 4-byte start code, then the escaped RPU from its 0x19 prefix, without the NAL header
RPU_FILE_START_CODE: Final = b"\x00\x00\x00\x01"
RPU_PREFIX: Final = 0x19
RPU_TERMINATOR: Final = 0x80
# NAL unit type 62 with nuh_layer_id 0 and nuh_temporal_id_plus1 1
HEVC_RPU_NAL_HEADER: Final = b"\x7C\x01"
HEVC_ACCESS_UNIT_DELIMITER_TYPE: Final = 35
ANNEX_B_START_CODE_PREFIX: Final = b"\x00\x00\x01"

# AV1 OBU header bits
OBU_TYPE_SHIFT: Final = 3
OBU_TYPE_MASK: Final = 0x0F
OBU_FORBIDDEN_BIT: Final = 0x80
OBU_EXTENSION_FLAG: Final = 0x04
OBU_HAS_SIZE_FIELD: Final = 0x02
OBU_EXTENSION_BYTE_LENGTH: Final = 1
# leb128() codes at most 8 bytes and values up to 2^32 - 1
MAXIMUM_LEB128_BYTE_LENGTH: Final = 8
MAXIMUM_LEB128_VALUE: Final = 0xFFFF_FFFF
LEB128_PAYLOAD_BIT_COUNT: Final = 7
LEB128_CONTINUATION_BIT: Final = 0x80
METADATA_TYPE_ITUT_T35: Final = 4
# trailing_bits() of a byte-aligned OBU payload: the trailing one bit and seven zero bits
OBU_TRAILING_BITS_BYTE: Final = 0x80
MAIN_SEQUENCE_PROFILE: Final = 0
# The first sequence header byte: seq_profile (3 bits), still_picture, then reduced_still_picture_header
SEQUENCE_PROFILE_SHIFT: Final = 5
REDUCED_STILL_PICTURE_HEADER_BIT: Final = 0x08
# Without reduced still picture headers, uncompressed_header() starts with show_existing_frame, frame_type (2 bits), and show_frame
SHOW_EXISTING_FRAME_BIT: Final = 0x80
FRAME_TYPE_SHIFT: Final = 5
FRAME_TYPE_MASK: Final = 0x03
SHOW_FRAME_BIT: Final = 0x10
KEY_FRAME_TYPE: Final = 0
# Stands for a shown existing frame, whose header codes no frame_type
EXISTING_FRAME_TYPE: Final = -1

# The ITU-T T.35 header and EMDF container (ETSI TS 103 572) of a Dolby Vision RPU
ITU_T_T35_COUNTRY_CODE_UNITED_STATES: Final = 0xB5
DOLBY_PROVIDER_CODE: Final = 0x003B
DOLBY_VISION_PROVIDER_ORIENTED_CODE: Final = 0x0000_0800
EMDF_VERSION: Final = 0
EMDF_KEY_ID: Final = 6
# An emdf_payload_id of 31 is extended by a variable_bits(5) value, 225 for the Dolby Vision RPU
EMDF_PAYLOAD_ID_ESCAPE: Final = 31
EMDF_PAYLOAD_ID_EXTENSION: Final = 225
EMDF_PAYLOAD_ID_EXTENSION_CHUNK_BIT_COUNT: Final = 5
EMDF_PAYLOAD_SIZE_CHUNK_BIT_COUNT: Final = 8
# emdf_payload_id 0 ends the payloads
EMDF_PAYLOAD_END_ID: Final = 0
# emdf_protection(): an 8-bit primary protection field of zero and no secondary field
EMDF_PROTECTION_LENGTH_PRIMARY_8_BITS: Final = 1
EMDF_PROTECTION_LENGTH_SECONDARY_NONE: Final = 0

DOLBY_VISION_AV1_PROFILE: Final = 10
DOLBY_VISION_VERSION_MAJOR: Final = 1
DOLBY_VISION_VERSION_MINOR: Final = 0
DOLBY_VISION_METADATA_COMPRESSION_NONE: Final = 0
DOLBY_VISION_CONFIGURATION_RECORD_BYTE_LENGTH: Final = 24
DOLBY_VISION_CONFIGURATION_BOX_TYPE: Final = "dvvC"
# dvcC, dvvC, and dvwC carry the configuration record of profiles up to 7, 8 to 10, and above 10
DOLBY_VISION_CONFIGURATION_BOX_TYPES: Final = frozenset(("dvcC", "dvvC", "dvwC"))
FFPROBE_DOLBY_VISION_CONFIGURATION_TYPE: Final = "DOVI configuration record"
FFPROBE_DOLBY_VISION_METADATA_TYPE: Final = "Dolby Vision Metadata"
FFPROBE_METADATA_COMPRESSION_NONE: Final = "none"
# FFmpeg's dv_levels: the highest pixel rate and the widest picture of each Dolby Vision level
DOLBY_VISION_LEVEL_LIMITS: Final = (
    (1, 1280 * 720 * 24, 1280),
    (2, 1280 * 720 * 30, 1280),
    (3, 1920 * 1080 * 24, 1920),
    (4, 1920 * 1080 * 30, 2560),
    (5, 1920 * 1080 * 60, 3840),
    (6, 3840 * 2160 * 24, 3840),
    (7, 3840 * 2160 * 30, 3840),
    (8, 3840 * 2160 * 48, 3840),
    (9, 3840 * 2160 * 60, 3840),
    (10, 3840 * 2160 * 120, 3840),
    (11, 3840 * 2160 * 120, 7680),
    (12, 7680 * 4320 * 60, 7680),
    (13, 7680 * 4320 * 120, 7680),
)

AV1_SAMPLE_ENTRY_TYPE: Final = "av01"
DOLBY_VISION_AV1_SAMPLE_ENTRY_TYPE: Final = "dav1"
AV1_SAMPLE_ENTRY_TYPES: Final = frozenset((AV1_SAMPLE_ENTRY_TYPE, DOLBY_VISION_AV1_SAMPLE_ENTRY_TYPE))
AV1_CONFIGURATION_BOX_TYPE: Final = "av1C"
COLOUR_INFORMATION_BOX_TYPE: Final = "colr"
NCLX_COLOUR_TYPE: Final = "nclx"
# An nclx colr payload: colour_type, three 16-bit code points, then full_range_flag in the top bit
NCLX_PAYLOAD_BYTE_LENGTH: Final = 11
NCLX_FULL_RANGE_BIT: Final = 0x80
VIDEO_HANDLER_TYPE: Final = "vide"
# hdlr is a full box: version and flags, then pre_defined, then handler_type
HANDLER_TYPE_OFFSET: Final = 8
# stsd is a full box: version and flags, then entry_count, then the entries
SAMPLE_DESCRIPTION_ENTRY_COUNT_OFFSET: Final = 4
SAMPLE_DESCRIPTION_ENTRIES_OFFSET: Final = 8
SAMPLE_ENTRY_TYPE_OFFSET: Final = 4

# The ITU-T T.35 payload a parser receives, as expectations.json records it
ITU_T_T35_PAYLOAD_DEFINITION: Final = (
    "itu_t_t35_country_code through the end of the metadata OBU payload, its trailing bits included"
)

BitField = tuple[int, int]


class VectorGenerationError(RuntimeError):
    """Reports a vector that cannot be generated or fails its verification."""


class OBUType(IntEnum):
    """The AV1 OBU types this script reads or writes."""

    SEQUENCE_HEADER = 1
    TEMPORAL_DELIMITER = 2
    FRAME_HEADER = 3
    METADATA = 5
    FRAME = 6
    REDUNDANT_FRAME_HEADER = 7
    TILE_LIST = 8
    PADDING = 15


# FFmpeg's MP4 and Matroska muxers drop these OBUs from every sample, as ff_av1_filter_obus does
CONTAINER_DROPPED_OBU_TYPES: Final = frozenset(
    (OBUType.TEMPORAL_DELIMITER, OBUType.REDUNDANT_FRAME_HEADER, OBUType.TILE_LIST, OBUType.PADDING)
)


@dataclass(frozen=True)
class BaseLayerColor:
    """The H.273 code points and the range that a base layer signals."""

    full_range: bool
    matrix_coefficients: int
    primaries: int
    transfer_characteristics: int

    @property
    def has_color_description(self) -> bool:
        """Returns whether all three code points are specified, the condition for FFmpeg to write a colr box."""

        return UNSPECIFIED_COLOR_CODE not in (
            self.primaries,
            self.transfer_characteristics,
            self.matrix_coefficients,
        )


# 10.0 has no compatible base: untagged and full range, as a decoded Profile 5 stream is.
# FFmpeg signals 10.0 from the full-range flag of the RPU, not from these tags
UNSPECIFIED_FULL_RANGE_COLOR: Final = BaseLayerColor(
    full_range=True,
    matrix_coefficients=UNSPECIFIED_COLOR_CODE,
    primaries=UNSPECIFIED_COLOR_CODE,
    transfer_characteristics=UNSPECIFIED_COLOR_CODE,
)
BT2020_PQ_COLOR: Final = BaseLayerColor(
    full_range=False,
    matrix_coefficients=BT2020_NON_CONSTANT_LUMINANCE_MATRIX,
    primaries=BT2020_PRIMARIES,
    transfer_characteristics=PQ_TRANSFER,
)
BT709_COLOR: Final = BaseLayerColor(
    full_range=False,
    matrix_coefficients=BT709_COLOR_CODE,
    primaries=BT709_COLOR_CODE,
    transfer_characteristics=BT709_COLOR_CODE,
)
BT2020_HLG_COLOR: Final = BaseLayerColor(
    full_range=False,
    matrix_coefficients=BT2020_NON_CONSTANT_LUMINANCE_MATRIX,
    primaries=BT2020_PRIMARIES,
    transfer_characteristics=HLG_TRANSFER,
)


@dataclass(frozen=True)
class SubProfile:
    """One Profile 10 sub-profile: its compatibility ID, base layer color, and the source RPU of each vector frame."""

    base_layer_signal_compatibility_ID: int
    color: BaseLayerColor
    name: str
    source_RPU_file_names: tuple[str, ...]


# Profile 5 and 8 RPUs:
# - 10.0 alternates two Profile 5 payloads, so a frame paired with the wrong RPU shows;
# - 10.1 and 10.2 carry the Profile 8.1 payload;
# - 10.4 carries the Profile 8.4 payload
SUB_PROFILES: Final = (
    SubProfile(
        base_layer_signal_compatibility_ID=0,
        color=UNSPECIFIED_FULL_RANGE_COLOR,
        name="10.0",
        source_RPU_file_names=("profile5.bin", "profile5-02.bin", "profile5.bin", "profile5-02.bin"),
    ),
    SubProfile(
        base_layer_signal_compatibility_ID=1,
        color=BT2020_PQ_COLOR,
        name="10.1",
        source_RPU_file_names=("profile8.bin",) * VECTOR_FRAME_COUNT,
    ),
    SubProfile(
        base_layer_signal_compatibility_ID=2,
        color=BT709_COLOR,
        name="10.2",
        source_RPU_file_names=("profile8.bin",) * VECTOR_FRAME_COUNT,
    ),
    SubProfile(
        base_layer_signal_compatibility_ID=4,
        color=BT2020_HLG_COLOR,
        name="10.4",
        source_RPU_file_names=("profile84.bin",) * VECTOR_FRAME_COUNT,
    ),
)


@dataclass(frozen=True)
class SourceRPU:
    """One dovi_tool test payload: its file name, the escaped RPU it stores, and the unescaped RPU."""

    escaped_RPU: bytes
    file_name: str
    RPU: bytes


@dataclass(frozen=True)
class AV1EncodeSettings:
    """Describes one libaom low-delay encode of testsrc2, which codes one shown frame per temporal unit."""

    constant_rate_factor: int
    frame_count: int
    frame_rate: Fraction
    height: int
    key_frame_interval: int
    row_multithreading: bool
    thread_count: int
    tile_layout: str
    width: int


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


@dataclass(frozen=True)
class AudioTone:
    """Describes an AAC sine tone muxed beside the video."""

    bit_rate_kilobits: int
    channel_count: int
    frequency: int
    sample_rate: int


@dataclass(frozen=True)
class MediaTools:
    """Names the FFmpeg and FFprobe executables."""

    FFmpeg_path: str
    FFprobe_path: str


@dataclass(frozen=True)
class DolbyVisionConfiguration:
    """The fields of a single-layer Dolby Vision configuration record that vary between vectors."""

    base_layer_signal_compatibility_ID: int
    level: int
    profile: int


@dataclass(frozen=True)
class AV1OBU:
    """One OBU of a low-overhead bitstream, header included."""

    data: bytes
    OBU_type: int
    payload_offset: int

    @property
    def payload(self) -> bytes:
        """Returns the OBU payload, after the header and the size field."""

        return self.data[self.payload_offset :]


@dataclass(frozen=True)
class TemporalUnitSummary:
    """Describes one temporal unit after the insertion: whether it shows a key frame, and its container sample size."""

    key_frame: bool
    sample_byte_length: int


@dataclass(frozen=True)
class InjectedStream:
    """A low-overhead bitstream with one RPU metadata OBU in every temporal unit."""

    data: bytes
    temporal_units: tuple[TemporalUnitSummary, ...]


@dataclass(frozen=True)
class AV1SampleEntry:
    """Locates the only AV1 video sample entry of an MP4, every box containing it, and its child boxes."""

    ancestors: tuple[BMFFBox, ...]
    children: tuple[BMFFBox, ...]
    sample_entry: BMFFBox


@dataclass(frozen=True)
class MP4VideoSignaling:
    """The sample entry type, Dolby Vision configuration record, and nclx color of an MP4's AV1 track."""

    color: BaseLayerColor | None
    dolby_vision_configuration_record: bytes | None
    sample_entry_type: str


@dataclass(frozen=True)
class DolbyVisionAV1Build:
    """Describes one encode of a sub-profile, the RPU of each frame, and the MP4 and Matroska files it becomes."""

    audio_tone: AudioTone | None
    encode_settings: AV1EncodeSettings
    Matroska_path: Path
    MP4_path: Path
    source_RPUs: tuple[SourceRPU, ...]
    sub_profile: SubProfile


@dataclass(frozen=True)
class BuiltDolbyVisionAV1Files:
    """The verified result of one build: the injected low-overhead bitstream and its temporal units."""

    injected_stream: InjectedStream
    injected_stream_path: Path


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
    packed_value = (packed_value << padding_bit_count) | (
        ((1 << padding_bit_count) - 1) if padding_bit else 0
    )
    return packed_value.to_bytes((bit_count + padding_bit_count) // 8, "big")


def encode_variable_bits(value: int, chunk_bit_count: int) -> list[BitField]:
    """Returns the variable_bits() fields of ETSI TS 103 572 that code a value in chunks of chunk_bit_count bits.

    Each read_more flag adds one to the value above the chunk it follows, so the chunks above the last store one less than the plain base-2^n digits.
    """

    if value < 0:
        raise ValueError("variable_bits() codes only non-negative values")
    chunk_mask = (1 << chunk_bit_count) - 1
    chunks = [value & chunk_mask]
    remaining_value = value >> chunk_bit_count
    while remaining_value > 0:
        remaining_value -= 1
        chunks.append(remaining_value & chunk_mask)
        remaining_value >>= chunk_bit_count
    chunks.reverse()
    fields: list[BitField] = []
    for chunk_index, chunk in enumerate(chunks):
        fields.append((chunk, chunk_bit_count))
        # read_more
        fields.append((1 if chunk_index + 1 < len(chunks) else 0, 1))
    return fields


@dataclass
class BitReader:
    """Reads most-significant-bit-first fields from bytes."""

    data: bytes
    bit_offset: int = 0

    def read(self, bit_count: int) -> int:
        """Reads one field and advances past it."""

        end_bit_offset = self.bit_offset + bit_count
        if end_bit_offset > len(self.data) * 8:
            raise VectorGenerationError("A bit field runs past the end of its data")
        first_byte_index = self.bit_offset // 8
        last_byte_index = (end_bit_offset + 7) // 8
        window = int.from_bytes(self.data[first_byte_index:last_byte_index], "big")
        window_bit_count = (last_byte_index - first_byte_index) * 8
        value = (window >> (window_bit_count - (end_bit_offset - first_byte_index * 8))) & ((1 << bit_count) - 1)
        self.bit_offset = end_bit_offset
        return value

    def read_variable_bits(self, chunk_bit_count: int) -> int:
        """Reads one variable_bits() value of ETSI TS 103 572."""

        value = 0
        while True:
            value += self.read(chunk_bit_count)
            if not self.read(1):
                return value
            value = (value + 1) << chunk_bit_count


def remove_emulation_prevention_bytes(escaped_data: bytes) -> bytes:
    """Returns the data without each 0x03 that follows two zero input bytes.

    This matches clear_start_code_emulation_prevention_3_byte in the pinned dolby_vision crate, which reads an RPU NAL unit the same way.
    """

    output = bytearray()
    for byte_index, byte_value in enumerate(escaped_data):
        if (
            byte_index >= 2
            and byte_value == 3
            and escaped_data[byte_index - 1] == 0
            and escaped_data[byte_index - 2] == 0
        ):
            continue
        output.append(byte_value)
    return bytes(output)


def read_source_RPU(file_name: str) -> SourceRPU:
    """Reads one dovi_tool test payload and unescapes its RPU, from its 0x19 prefix to its 0x80 terminator."""

    file_data = (RPU_SOURCE_DIRECTORY / file_name).read_bytes()
    if not file_data.startswith(RPU_FILE_START_CODE):
        raise VectorGenerationError(f"The RPU file {file_name} does not start with a start code")
    escaped_RPU = file_data[len(RPU_FILE_START_CODE) :]
    # Trailing zero bytes follow the terminator in some RPUs; the EMDF payload ends at the terminator
    RPU = remove_emulation_prevention_bytes(escaped_RPU).rstrip(b"\x00")
    if len(RPU) < 2 or RPU[0] != RPU_PREFIX or RPU[-1] != RPU_TERMINATOR:
        raise VectorGenerationError(f"The RPU file {file_name} does not hold a prefixed and terminated RPU")
    return SourceRPU(escaped_RPU=escaped_RPU, file_name=file_name, RPU=RPU)


def create_dolby_vision_ITUT_T35_payload(RPU: bytes) -> bytes:
    """Returns the T.35 payload after the country code that carries one unescaped RPU in its EMDF container.

    These are the bytes the pinned dolby_vision crate's convert_regular_rpu_to_av1_payload returns, and that FFmpeg's ff_dovi_rpu_generate writes after the country code:
    - the provider codes;
    - the fixed EMDF header;
    - the RPU without its 0x19 prefix, as the one EMDF payload;
    - the end of the payloads;
    - an 8-bit protection field;
    - one bits to the byte boundary.
    """

    if len(RPU) < 2 or RPU[0] != RPU_PREFIX or RPU[-1] != RPU_TERMINATOR:
        raise VectorGenerationError("An RPU must run from its 0x19 prefix to its 0x80 terminator")
    EMDF_payload = RPU[1:]
    fields: list[BitField] = [
        (DOLBY_PROVIDER_CODE, 16),
        (DOLBY_VISION_PROVIDER_ORIENTED_CODE, 32),
        (EMDF_VERSION, 2),
        (EMDF_KEY_ID, 3),
        (EMDF_PAYLOAD_ID_ESCAPE, 5),
        *encode_variable_bits(EMDF_PAYLOAD_ID_EXTENSION, EMDF_PAYLOAD_ID_EXTENSION_CHUNK_BIT_COUNT),
        # smploffste, duratione, groupide, and codecdatae are clear; discard_unknown_payload is set
        (0, 4),
        (1, 1),
        *encode_variable_bits(len(EMDF_payload), EMDF_PAYLOAD_SIZE_CHUNK_BIT_COUNT),
        *((byte_value, 8) for byte_value in EMDF_payload),
        (EMDF_PAYLOAD_END_ID, 5),
        (EMDF_PROTECTION_LENGTH_PRIMARY_8_BITS, 2),
        (EMDF_PROTECTION_LENGTH_SECONDARY_NONE, 2),
        (0, 8),
    ]
    return pack_bit_fields(fields, padding_bit=1)


def read_dolby_vision_RPU_from_ITUT_T35_payload(payload: bytes) -> bytes:
    """Returns the RPU, 0x19 prefix included, that a T.35 payload after the country code carries.

    It reads the payload as the pinned dolby_vision crate's convert_av1_rpu_payload_to_regular does, and also requires the protection fields that FFmpeg validates.
    """

    reader = BitReader(payload)
    require_equal(reader.read(16), DOLBY_PROVIDER_CODE, "T.35 provider code")
    require_equal(reader.read(32), DOLBY_VISION_PROVIDER_ORIENTED_CODE, "T.35 provider oriented code")
    require_equal(reader.read(2), EMDF_VERSION, "EMDF version")
    require_equal(reader.read(3), EMDF_KEY_ID, "EMDF key ID")
    require_equal(reader.read(5), EMDF_PAYLOAD_ID_ESCAPE, "EMDF payload ID")
    require_equal(
        reader.read_variable_bits(EMDF_PAYLOAD_ID_EXTENSION_CHUNK_BIT_COUNT),
        EMDF_PAYLOAD_ID_EXTENSION,
        "EMDF payload ID extension",
    )
    require_equal(reader.read(5), 1, "EMDF payload flags")
    payload_byte_length = reader.read_variable_bits(EMDF_PAYLOAD_SIZE_CHUNK_BIT_COUNT)
    RPU = bytes((RPU_PREFIX, *(reader.read(8) for _ in range(payload_byte_length))))
    require_equal(reader.read(5), EMDF_PAYLOAD_END_ID, "EMDF payload end")
    require_equal(reader.read(2), EMDF_PROTECTION_LENGTH_PRIMARY_8_BITS, "EMDF primary protection length")
    require_equal(reader.read(2), EMDF_PROTECTION_LENGTH_SECONDARY_NONE, "EMDF secondary protection length")
    require_equal(reader.read(8), 0, "EMDF primary protection")
    return RPU


def encode_leb128(value: int) -> bytes:
    """Returns the shortest leb128() coding of a value."""

    if value < 0 or value > MAXIMUM_LEB128_VALUE:
        raise ValueError(f"leb128() cannot code {value}")
    output = bytearray()
    remaining_value = value
    while True:
        byte_value = remaining_value & 0x7F
        remaining_value >>= LEB128_PAYLOAD_BIT_COUNT
        if remaining_value:
            output.append(byte_value | LEB128_CONTINUATION_BIT)
            continue
        output.append(byte_value)
        return bytes(output)


def read_leb128(data: bytes, offset: int) -> tuple[int, int]:
    """Returns one leb128() value and its byte length."""

    value = 0
    for byte_index in range(MAXIMUM_LEB128_BYTE_LENGTH):
        if offset + byte_index >= len(data):
            raise VectorGenerationError("An OBU size field is truncated")
        byte_value = data[offset + byte_index]
        value |= (byte_value & 0x7F) << (byte_index * LEB128_PAYLOAD_BIT_COUNT)
        if not byte_value & LEB128_CONTINUATION_BIT:
            if value > MAXIMUM_LEB128_VALUE:
                raise VectorGenerationError("An OBU size field exceeds 32 bits")
            return value, byte_index + 1
    raise VectorGenerationError("An OBU size field is longer than 8 bytes")


def parse_OBUs(data: bytes) -> tuple[AV1OBU, ...]:
    """Parses a low-overhead bitstream, in which every OBU has a size field."""

    OBUs: list[AV1OBU] = []
    offset = 0
    while offset < len(data):
        header = data[offset]
        if header & OBU_FORBIDDEN_BIT:
            raise VectorGenerationError("An OBU sets its forbidden bit")
        if not header & OBU_HAS_SIZE_FIELD:
            raise VectorGenerationError("An OBU of a low-overhead bitstream has no size field")
        header_byte_length = 1 + (OBU_EXTENSION_BYTE_LENGTH if header & OBU_EXTENSION_FLAG else 0)
        payload_byte_length, size_byte_length = read_leb128(data, offset + header_byte_length)
        payload_offset = header_byte_length + size_byte_length
        end_offset = offset + payload_offset + payload_byte_length
        if end_offset > len(data):
            raise VectorGenerationError("An OBU runs past the end of the bitstream")
        OBUs.append(
            AV1OBU(
                data=data[offset:end_offset],
                OBU_type=(header >> OBU_TYPE_SHIFT) & OBU_TYPE_MASK,
                payload_offset=payload_offset,
            )
        )
        offset = end_offset
    return tuple(OBUs)


def split_temporal_units(OBUs: Sequence[AV1OBU]) -> list[list[AV1OBU]]:
    """Groups OBUs into temporal units, each starting at its temporal delimiter."""

    if not OBUs or OBUs[0].OBU_type != OBUType.TEMPORAL_DELIMITER:
        raise VectorGenerationError("The bitstream does not start with a temporal delimiter")
    temporal_units: list[list[AV1OBU]] = []
    for OBU in OBUs:
        if OBU.OBU_type == OBUType.TEMPORAL_DELIMITER:
            temporal_units.append([])
        temporal_units[-1].append(OBU)
    return temporal_units


def is_dolby_vision_metadata_OBU(OBU: AV1OBU) -> bool:
    """Returns whether an OBU is ITU-T T.35 metadata with the Dolby Vision RPU provider codes."""

    payload = OBU.payload
    # metadata_type 4 is a one-byte leb128(), then the country code and the 2-byte and 4-byte provider codes
    return (
        OBU.OBU_type == OBUType.METADATA
        and len(payload) >= 8
        and payload[0] == METADATA_TYPE_ITUT_T35
        and payload[1] == ITU_T_T35_COUNTRY_CODE_UNITED_STATES
        and int.from_bytes(payload[2:4], "big") == DOLBY_PROVIDER_CODE
        and int.from_bytes(payload[4:8], "big") == DOLBY_VISION_PROVIDER_ORIENTED_CODE
    )


def create_dolby_vision_metadata_OBU(RPU: bytes) -> bytes:
    """Returns a metadata OBU, with a size field and no extension, whose metadata_itut_t35() carries one RPU."""

    payload = (
        encode_leb128(METADATA_TYPE_ITUT_T35)
        + bytes((ITU_T_T35_COUNTRY_CODE_UNITED_STATES,))
        + create_dolby_vision_ITUT_T35_payload(RPU)
        + bytes((OBU_TRAILING_BITS_BYTE,))
    )
    header = (OBUType.METADATA << OBU_TYPE_SHIFT) | OBU_HAS_SIZE_FIELD
    return bytes((header,)) + encode_leb128(len(payload)) + payload


def get_ITUT_T35_payload(OBU: AV1OBU) -> bytes:
    """Returns the T.35 payload a parser receives from a Dolby Vision metadata OBU, from the country code on."""

    if not is_dolby_vision_metadata_OBU(OBU):
        raise VectorGenerationError("The OBU is not Dolby Vision ITU-T T.35 metadata")
    # Past the one-byte metadata_type
    return OBU.payload[1:]


def require_video_sequence_header(OBU: AV1OBU) -> None:
    """Requires a Main profile sequence header without reduced still picture headers."""

    if not OBU.payload:
        raise VectorGenerationError("A sequence header OBU is empty")
    first_byte = OBU.payload[0]
    if first_byte >> SEQUENCE_PROFILE_SHIFT != MAIN_SEQUENCE_PROFILE:
        raise VectorGenerationError("The sequence header is not the AV1 Main profile")
    if first_byte & REDUCED_STILL_PICTURE_HEADER_BIT:
        raise VectorGenerationError("The sequence header uses reduced still picture headers")


def read_shown_frame_type(OBU: AV1OBU) -> int | None:
    """Returns the frame_type a frame or frame header OBU shows, EXISTING_FRAME_TYPE, or None for a hidden frame."""

    if not OBU.payload:
        raise VectorGenerationError("A frame header OBU is empty")
    first_byte = OBU.payload[0]
    if first_byte & SHOW_EXISTING_FRAME_BIT:
        return EXISTING_FRAME_TYPE
    if not first_byte & SHOW_FRAME_BIT:
        return None
    return (first_byte >> FRAME_TYPE_SHIFT) & FRAME_TYPE_MASK


def insert_dolby_vision_metadata(stream: bytes, RPUs: Sequence[bytes]) -> InjectedStream:
    """Returns the bitstream with one RPU metadata OBU in each temporal unit, given one unescaped RPU per unit.

    The OBU goes before the first frame header or frame of the unit, after its temporal delimiter, sequence header, and any other metadata, where libaom writes metadata.
    Every unit must show exactly one frame.
    """

    temporal_units = split_temporal_units(parse_OBUs(stream))
    if len(temporal_units) != len(RPUs):
        raise VectorGenerationError(
            f"The bitstream has {len(temporal_units)} temporal units for {len(RPUs)} RPUs"
        )
    output = bytearray()
    summaries: list[TemporalUnitSummary] = []
    has_sequence_header = False
    for temporal_unit, RPU in zip(temporal_units, RPUs, strict=True):
        metadata_OBU = create_dolby_vision_metadata_OBU(RPU)
        unit_output = bytearray()
        sample_byte_length = 0
        metadata_inserted = False
        shown_frame_types: list[int] = []
        for OBU in temporal_unit:
            match OBU.OBU_type:
                case OBUType.SEQUENCE_HEADER:
                    require_video_sequence_header(OBU)
                    has_sequence_header = True
                case OBUType.METADATA if is_dolby_vision_metadata_OBU(OBU):
                    raise VectorGenerationError("The bitstream already carries Dolby Vision metadata")
                case OBUType.FRAME_HEADER | OBUType.FRAME:
                    if not has_sequence_header:
                        raise VectorGenerationError("A frame precedes the first sequence header")
                    if not metadata_inserted:
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
            raise VectorGenerationError(
                f"Temporal unit {len(summaries)} shows {len(shown_frame_types)} frames instead of one"
            )
        output += unit_output
        summaries.append(
            TemporalUnitSummary(
                key_frame=shown_frame_types[0] == KEY_FRAME_TYPE,
                sample_byte_length=sample_byte_length,
            )
        )
    return InjectedStream(data=bytes(output), temporal_units=tuple(summaries))


def read_dolby_vision_RPUs(stream: bytes) -> list[list[bytes]]:
    """Returns, per temporal unit, the RPUs of the Dolby Vision metadata OBUs a low-overhead bitstream carries."""

    return [
        [
            read_dolby_vision_RPU_from_ITUT_T35_payload(get_ITUT_T35_payload(OBU)[1:])
            for OBU in temporal_unit
            if is_dolby_vision_metadata_OBU(OBU)
        ]
        for temporal_unit in split_temporal_units(parse_OBUs(stream))
    ]


def get_dolby_vision_level(width: int, height: int, frame_rate: Fraction) -> int:
    """Returns the lowest Dolby Vision level whose pixel rate and width hold the picture, as FFmpeg picks it."""

    # FFmpeg truncates the pixel rate to an integer before comparing it
    pixels_per_second = width * height * frame_rate.numerator // frame_rate.denominator
    for level, maximum_pixels_per_second, maximum_width in DOLBY_VISION_LEVEL_LIMITS:
        if pixels_per_second <= maximum_pixels_per_second and width <= maximum_width:
            return level
    raise VectorGenerationError(f"{width}x{height} at {frame_rate} frames per second exceeds every Dolby Vision level")


def create_dolby_vision_configuration_record(configuration: DolbyVisionConfiguration) -> bytes:
    """Returns the 24-byte configuration record of an RPU with a base layer and no enhancement layer.

    The layout is FFmpeg's ff_isom_put_dvcc_dvvc:
    - version 1.0;
    - the profile and level;
    - the RPU, EL, and BL present flags;
    - the compatibility ID;
    - no metadata compression;
    - reserved zero bits.
    """

    fields: list[BitField] = [
        (DOLBY_VISION_VERSION_MAJOR, 8),
        (DOLBY_VISION_VERSION_MINOR, 8),
        (configuration.profile, 7),
        (configuration.level, 6),
        # rpu_present_flag, el_present_flag, and bl_present_flag
        (1, 1),
        (0, 1),
        (1, 1),
        (configuration.base_layer_signal_compatibility_ID, 4),
        (DOLBY_VISION_METADATA_COMPRESSION_NONE, 2),
        (0, 26),
        (0, 32),
        (0, 32),
        (0, 32),
        (0, 32),
    ]
    return pack_bit_fields(fields, padding_bit=0)


def get_dolby_vision_configuration(
    sub_profile: SubProfile,
    encode_settings: AV1EncodeSettings,
) -> DolbyVisionConfiguration:
    """Returns the Profile 10 configuration of one encode of a sub-profile."""

    return DolbyVisionConfiguration(
        base_layer_signal_compatibility_ID=sub_profile.base_layer_signal_compatibility_ID,
        level=get_dolby_vision_level(encode_settings.width, encode_settings.height, encode_settings.frame_rate),
        profile=DOLBY_VISION_AV1_PROFILE,
    )


def get_MP4_sample_entry_type(sub_profile: SubProfile) -> str:
    """Returns dav1 for 10.0, whose base is not AV1-compatible, and av01 for every other sub-profile."""

    if sub_profile.base_layer_signal_compatibility_ID == 0:
        return DOLBY_VISION_AV1_SAMPLE_ENTRY_TYPE
    return AV1_SAMPLE_ENTRY_TYPE


def find_AV1_sample_entry(data: bytes) -> AV1SampleEntry:
    """Finds the only video track of an MP4 and requires its one sample entry to be av01 or dav1."""

    movie_box = find_required_box(parse_children(data, 0, len(data)), "moov")
    sample_entries: list[AV1SampleEntry] = []
    for track_box in parse_children(data, movie_box.data_offset, movie_box.end_offset):
        if track_box.box_type != "trak":
            continue
        media_box = find_required_box(parse_children(data, track_box.data_offset, track_box.end_offset), "mdia")
        media_children = parse_children(data, media_box.data_offset, media_box.end_offset)
        handler_box = find_required_box(media_children, "hdlr")
        handler_type = read_four_CC(data, handler_box.data_offset + HANDLER_TYPE_OFFSET, handler_box.end_offset)
        if handler_type != VIDEO_HANDLER_TYPE:
            continue
        media_information_box = find_required_box(media_children, "minf")
        sample_table_box = find_required_box(
            parse_children(data, media_information_box.data_offset, media_information_box.end_offset),
            "stbl",
        )
        sample_description_box = find_required_box(
            parse_children(data, sample_table_box.data_offset, sample_table_box.end_offset),
            "stsd",
        )
        entry_count = read_unsigned_32(
            data,
            sample_description_box.data_offset + SAMPLE_DESCRIPTION_ENTRY_COUNT_OFFSET,
            sample_description_box.end_offset,
        )
        sample_entry = parse_box(
            data,
            sample_description_box.data_offset + SAMPLE_DESCRIPTION_ENTRIES_OFFSET,
            sample_description_box.end_offset,
        )
        if (
            entry_count != 1
            or sample_entry.end_offset != sample_description_box.end_offset
            or sample_entry.box_type not in AV1_SAMPLE_ENTRY_TYPES
        ):
            raise VectorGenerationError("The MP4 video track needs one av01 or dav1 sample entry")
        children_offset = sample_entry.data_offset + VISUAL_SAMPLE_ENTRY_FIELD_BYTE_LENGTH
        if children_offset > sample_entry.end_offset:
            raise VectorGenerationError("The MP4 AV1 sample entry is truncated")
        sample_entries.append(
            AV1SampleEntry(
                ancestors=(
                    movie_box,
                    track_box,
                    media_box,
                    media_information_box,
                    sample_table_box,
                    sample_description_box,
                ),
                children=tuple(parse_children(data, children_offset, sample_entry.end_offset)),
                sample_entry=sample_entry,
            )
        )
    if len(sample_entries) != 1:
        raise VectorGenerationError(f"The MP4 has {len(sample_entries)} video tracks instead of one")
    return sample_entries[0]


def insert_dolby_vision_configuration_box(data: bytes, configuration_record: bytes) -> bytes:
    """Returns the MP4 with a dvvC box appended to its AV1 sample entry, growing every box that contains it.

    All media data must precede the movie box, so growing the movie box moves no sample.
    """

    top_level_boxes = parse_children(data, 0, len(data))
    movie_box = find_required_box(top_level_boxes, "moov")
    if any(box.box_type == "mdat" and box.end_offset > movie_box.start_offset for box in top_level_boxes):
        raise VectorGenerationError("All MP4 media data must precede the movie box")
    sample_entry = find_AV1_sample_entry(data)
    if any(child.box_type in DOLBY_VISION_CONFIGURATION_BOX_TYPES for child in sample_entry.children):
        raise VectorGenerationError("The MP4 AV1 sample entry already has a Dolby Vision configuration")
    configuration_box = create_box(DOLBY_VISION_CONFIGURATION_BOX_TYPE, configuration_record)
    patched_data = bytearray(data)
    for containing_box in (*sample_entry.ancestors, sample_entry.sample_entry):
        if containing_box.compact_size in (0, 1):
            raise VectorGenerationError(f"The MP4 {containing_box.box_type} box needs a compact size")
        write_unsigned_32(
            patched_data,
            containing_box.start_offset,
            containing_box.end_offset - containing_box.start_offset + len(configuration_box),
        )
    insertion_offset = sample_entry.sample_entry.end_offset
    patched_data[insertion_offset:insertion_offset] = configuration_box
    return bytes(patched_data)


def rename_AV1_sample_entry(data: bytes, sample_entry_type: str) -> bytes:
    """Returns the MP4 with the type of its AV1 sample entry replaced, which changes no size."""

    if sample_entry_type not in AV1_SAMPLE_ENTRY_TYPES:
        raise VectorGenerationError(f"{sample_entry_type} is not an AV1 sample entry type")
    type_offset = find_AV1_sample_entry(data).sample_entry.start_offset + SAMPLE_ENTRY_TYPE_OFFSET
    renamed_data = bytearray(data)
    renamed_data[type_offset : type_offset + 4] = sample_entry_type.encode("ascii")
    return bytes(renamed_data)


def read_MP4_video_signaling(data: bytes) -> MP4VideoSignaling:
    """Reads the sample entry type, the Dolby Vision configuration record, and the nclx color of the AV1 track."""

    sample_entry = find_AV1_sample_entry(data)
    find_required_box(sample_entry.children, AV1_CONFIGURATION_BOX_TYPE)
    configuration_boxes = [
        child for child in sample_entry.children if child.box_type in DOLBY_VISION_CONFIGURATION_BOX_TYPES
    ]
    if len(configuration_boxes) > 1:
        raise VectorGenerationError("The MP4 AV1 sample entry has more than one Dolby Vision configuration")
    configuration_record = None
    if configuration_boxes:
        configuration_box = configuration_boxes[0]
        if configuration_box.box_type != DOLBY_VISION_CONFIGURATION_BOX_TYPE:
            raise VectorGenerationError(f"An AV1 sample entry carries {configuration_box.box_type} instead of dvvC")
        configuration_record = data[configuration_box.data_offset : configuration_box.end_offset]
    color = None
    colour_information_box = find_unique_box(sample_entry.children, COLOUR_INFORMATION_BOX_TYPE)
    if colour_information_box is not None:
        payload = data[colour_information_box.data_offset : colour_information_box.end_offset]
        if len(payload) != NCLX_PAYLOAD_BYTE_LENGTH or payload[:4] != NCLX_COLOUR_TYPE.encode("ascii"):
            raise VectorGenerationError("The MP4 colr box is not nclx")
        color = BaseLayerColor(
            full_range=bool(payload[10] & NCLX_FULL_RANGE_BIT),
            matrix_coefficients=int.from_bytes(payload[8:10], "big"),
            primaries=int.from_bytes(payload[4:6], "big"),
            transfer_characteristics=int.from_bytes(payload[6:8], "big"),
        )
    return MP4VideoSignaling(
        color=color,
        dolby_vision_configuration_record=configuration_record,
        sample_entry_type=data[
            sample_entry.sample_entry.start_offset + SAMPLE_ENTRY_TYPE_OFFSET : sample_entry.sample_entry.data_offset
        ].decode("ascii"),
    )


def get_FFmpeg_color_names(color: BaseLayerColor) -> dict[str, str]:
    """Returns the FFprobe stream fields that describe a base layer color."""

    return {
        "color_primaries": FFMPEG_PRIMARIES_NAMES[color.primaries],
        "color_range": FFMPEG_FULL_RANGE_NAME if color.full_range else FFMPEG_LIMITED_RANGE_NAME,
        "color_space": FFMPEG_MATRIX_NAMES[color.matrix_coefficients],
        "color_transfer": FFMPEG_TRANSFER_NAMES[color.transfer_characteristics],
    }


def create_AV1_encode_arguments(
    encode_settings: AV1EncodeSettings,
    color: BaseLayerColor,
    output_path: Path,
) -> list[str]:
    """Returns the FFmpeg arguments of a libaom encode of testsrc2 with the color, as a low-overhead bitstream."""

    color_names = get_FFmpeg_color_names(color)
    # setparams tags every frame, so libaom writes the color into the sequence header
    source = (
        f"testsrc2=size={encode_settings.width}x{encode_settings.height}:rate={encode_settings.frame_rate},"
        f"format={PIXEL_FORMAT},"
        f"setparams=color_primaries={color_names['color_primaries']}:"
        f"color_trc={color_names['color_transfer']}:"
        f"colorspace={color_names['color_space']}:"
        f"range={color_names['color_range']}"
    )
    return [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-f", "lavfi",
        "-i", source,
        "-frames:v", str(encode_settings.frame_count),
        "-c:v", "libaom-av1",
        # Real-time usage has no lookahead, so no temporal unit holds a hidden frame
        "-usage", "realtime",
        "-cpu-used", "8",
        "-lag-in-frames", "0",
        "-threads", str(encode_settings.thread_count),
        "-row-mt", "1" if encode_settings.row_multithreading else "0",
        "-tiles", encode_settings.tile_layout,
        "-g", str(encode_settings.key_frame_interval),
        "-crf", str(encode_settings.constant_rate_factor),
        "-fflags", "+bitexact",
        "-flags:v", "+bitexact",
        "-map_metadata", "-1",
        "-f", OBU_STREAM_FORMAT,
        str(output_path),
    ]


def create_intermediate_MP4_arguments(
    stream_path: Path,
    frame_rate: Fraction,
    audio_tone: AudioTone | None,
    duration_seconds: Fraction,
    output_path: Path,
) -> list[str]:
    """Returns the FFmpeg arguments that mux a low-overhead bitstream, and an optional AAC tone, into an MP4."""

    audio_input_arguments: list[str] = []
    audio_output_arguments: list[str] = []
    if audio_tone is not None:
        audio_input_arguments = [
            "-f", "lavfi",
            "-i",
            f"sine=frequency={audio_tone.frequency}:sample_rate={audio_tone.sample_rate}:"
            f"duration={float(duration_seconds)}",
        ]
        audio_output_arguments = [
            "-map", "1:a:0",
            "-c:a", "aac",
            "-b:a", f"{audio_tone.bit_rate_kilobits}k",
            "-ar", str(audio_tone.sample_rate),
            "-ac", str(audio_tone.channel_count),
        ]
    return [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-framerate", str(frame_rate),
        "-f", OBU_STREAM_FORMAT,
        "-i", str(stream_path),
        *audio_input_arguments,
        "-map", "0:v:0",
        "-c:v", "copy",
        *audio_output_arguments,
        "-video_track_timescale", str(MP4_VIDEO_TIMESCALE),
        "-fflags", "+bitexact",
        "-map_metadata", "-1",
        "-f", MP4_FORMAT,
        str(output_path),
    ]


def create_remux_arguments(input_path: Path, container_format: str, output_path: Path) -> list[str]:
    """Returns the FFmpeg arguments that copy every stream of an MP4, Dolby Vision configuration included."""

    MP4_arguments: list[str] = []
    if container_format == MP4_FORMAT:
        MP4_arguments = [
            # FFmpeg writes a dvvC box only for unofficial compliance
            "-strict", "unofficial",
            "-video_track_timescale", str(MP4_VIDEO_TIMESCALE),
        ]
    return [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-i", str(input_path),
        "-map", "0",
        "-c", "copy",
        *MP4_arguments,
        "-fflags", "+bitexact",
        "-map_metadata", "-1",
        "-f", container_format,
        str(output_path),
    ]


def probe_media(tools: MediaTools, path: Path, input_format: str | None = None) -> dict[str, Any]:
    """Returns FFprobe's JSON description of every stream and packet of a file."""

    input_arguments = ["-f", input_format] if input_format else []
    output = execute_tool(
        tools.FFprobe_path,
        [
            "-v", "error",
            *input_arguments,
            "-show_streams",
            "-show_entries", "packet=stream_index,size,flags",
            "-of", "json",
            str(path),
        ],
    )
    return json.loads(output)


def probe_dolby_vision_metadata(tools: MediaTools, path: Path, input_format: str) -> list[dict[str, Any]]:
    """Returns the Dolby Vision metadata FFmpeg decodes for each frame of a raw bitstream."""

    output = execute_tool(
        tools.FFprobe_path,
        ["-v", "error", "-f", input_format, "-show_frames", "-of", "json", str(path)],
    )
    frames = json.loads(output).get("frames", [])
    frame_metadata: list[dict[str, Any]] = []
    for frame_index, frame in enumerate(frames):
        metadata = [
            side_data
            for side_data in frame.get("side_data_list", [])
            if side_data.get("side_data_type") == FFPROBE_DOLBY_VISION_METADATA_TYPE
        ]
        if len(metadata) != 1:
            raise VectorGenerationError(
                f"FFmpeg decodes {len(metadata)} Dolby Vision metadata for frame {frame_index} of {path.name}"
            )
        frame_metadata.append(metadata[0])
    return frame_metadata


def get_streams(probe: Mapping[str, Any], codec_type: str) -> list[dict[str, Any]]:
    """Returns the FFprobe streams of one codec type."""

    streams = probe.get("streams", [])
    if not isinstance(streams, list):
        raise VectorGenerationError("FFprobe reported no stream list")
    return [stream for stream in streams if stream.get("codec_type") == codec_type]


def require_one_stream(probe: Mapping[str, Any], codec_type: str, label: str) -> dict[str, Any]:
    """Returns the only FFprobe stream of one codec type."""

    streams = get_streams(probe, codec_type)
    if len(streams) != 1:
        raise VectorGenerationError(f"{label} has {len(streams)} {codec_type} streams instead of one")
    return streams[0]


def get_stream_color(stream: Mapping[str, Any]) -> dict[str, str]:
    """Returns the color fields of an FFprobe stream, where FFprobe leaves out an unknown value."""

    return {
        field_name: str(stream.get(field_name, FFPROBE_UNKNOWN_VALUE))
        for field_name in ("color_primaries", "color_range", "color_space", "color_transfer")
    }


def require_OBU_stream_evidence(
    probe: Mapping[str, Any],
    encode_settings: AV1EncodeSettings,
    color: BaseLayerColor,
    label: str,
) -> None:
    """Requires FFprobe to read an AV1 Main 10 stream of the encode's size and the color from the sequence header."""

    stream = require_one_stream(probe, "video", label)
    require_equal(stream.get("codec_name"), AV1_CODEC_NAME, f"{label} codec")
    require_equal(stream.get("profile"), FFPROBE_AV1_PROFILE, f"{label} profile")
    require_equal(stream.get("pix_fmt"), PIXEL_FORMAT, f"{label} pixel format")
    require_equal(
        [stream.get("width"), stream.get("height")],
        [encode_settings.width, encode_settings.height],
        f"{label} size",
    )
    require_equal(get_stream_color(stream), get_FFmpeg_color_names(color), f"{label} sequence header color")


def require_injected_stream(
    injected_stream: InjectedStream,
    source_RPUs: Sequence[SourceRPU],
    label: str,
) -> None:
    """Requires every temporal unit to carry exactly the source RPU of its frame."""

    require_equal(
        [[RPU.hex() for RPU in RPUs] for RPUs in read_dolby_vision_RPUs(injected_stream.data)],
        [[source_RPU.RPU.hex()] for source_RPU in source_RPUs],
        f"{label} RPUs",
    )


def require_container_evidence(
    probe: Mapping[str, Any],
    container_format: str,
    build: DolbyVisionAV1Build,
    configuration: DolbyVisionConfiguration,
    injected_stream: InjectedStream,
    label: str,
) -> None:
    """Requires the codec, Dolby Vision configuration, color, packets, and audio FFprobe reads from a container."""

    stream = require_one_stream(probe, "video", label)
    sample_entry_type = get_MP4_sample_entry_type(build.sub_profile)
    color = build.sub_profile.color
    if container_format == MATROSKA_FORMAT:
        expected_codec_name = AV1_CODEC_NAME
        expected_codec_tag = FFPROBE_EMPTY_CODEC_TAG
        expected_color = get_FFmpeg_color_names(color)
    elif sample_entry_type == DOLBY_VISION_AV1_SAMPLE_ENTRY_TYPE:
        # FFmpeg maps dav1 to no codec, so it reads the color of a dav1 track only from a colr box
        expected_codec_name = FFPROBE_UNKNOWN_CODEC_NAME
        expected_codec_tag = sample_entry_type
        expected_color = get_FFmpeg_color_names(color) if color.has_color_description else get_stream_color({})
    else:
        expected_codec_name = AV1_CODEC_NAME
        expected_codec_tag = sample_entry_type
        expected_color = get_FFmpeg_color_names(color)
    require_equal(stream.get("codec_name", FFPROBE_UNKNOWN_VALUE), expected_codec_name, f"{label} codec")
    require_equal(stream.get("codec_tag_string"), expected_codec_tag, f"{label} codec tag")
    require_equal(
        [stream.get("width"), stream.get("height")],
        [build.encode_settings.width, build.encode_settings.height],
        f"{label} size",
    )
    require_equal(get_stream_color(stream), expected_color, f"{label} color")
    configurations = [
        side_data
        for side_data in stream.get("side_data_list", [])
        if side_data.get("side_data_type") == FFPROBE_DOLBY_VISION_CONFIGURATION_TYPE
    ]
    require_equal(
        configurations,
        [
            {
                "side_data_type": FFPROBE_DOLBY_VISION_CONFIGURATION_TYPE,
                "dv_version_major": DOLBY_VISION_VERSION_MAJOR,
                "dv_version_minor": DOLBY_VISION_VERSION_MINOR,
                "dv_profile": configuration.profile,
                "dv_level": configuration.level,
                "rpu_present_flag": 1,
                "el_present_flag": 0,
                "bl_present_flag": 1,
                "dv_bl_signal_compatibility_id": configuration.base_layer_signal_compatibility_ID,
                "dv_md_compression": FFPROBE_METADATA_COMPRESSION_NONE,
            }
        ],
        f"{label} Dolby Vision configuration",
    )
    packets = [
        packet
        for packet in probe.get("packets", [])
        if packet.get("stream_index") == stream.get("index")
    ]
    # The samples are the injected temporal units without the OBUs the muxers drop
    require_equal(
        [[int(str(packet.get("size"))), str(packet.get("flags", "")).startswith("K")] for packet in packets],
        [
            [temporal_unit.sample_byte_length, temporal_unit.key_frame]
            for temporal_unit in injected_stream.temporal_units
        ],
        f"{label} packet sizes and key flags",
    )
    if build.audio_tone is None:
        require_equal(len(get_streams(probe, "audio")), 0, f"{label} audio stream count")
        return
    audio_stream = require_one_stream(probe, "audio", label)
    require_equal(
        [audio_stream.get("codec_name"), audio_stream.get("channels"), str(audio_stream.get("sample_rate"))],
        ["aac", build.audio_tone.channel_count, str(build.audio_tone.sample_rate)],
        f"{label} audio",
    )


def require_MP4_signaling(data: bytes, build: DolbyVisionAV1Build, configuration_record: bytes, label: str) -> None:
    """Requires the sample entry type, the dvvC record, and the colr box FFmpeg writes for the sub-profile's color."""

    color = build.sub_profile.color
    signaling = read_MP4_video_signaling(data)
    require_equal(signaling.sample_entry_type, get_MP4_sample_entry_type(build.sub_profile), f"{label} sample entry")
    require_equal(
        (signaling.dolby_vision_configuration_record or b"").hex(),
        configuration_record.hex(),
        f"{label} dvvC record",
    )
    # FFmpeg writes a colr box only when all three code points are specified
    expected_color = color if color.has_color_description else None
    require_equal(
        None if signaling.color is None else vars(signaling.color),
        None if expected_color is None else vars(expected_color),
        f"{label} colr box",
    )


def build_dolby_vision_AV1_files(
    tools: MediaTools,
    build: DolbyVisionAV1Build,
    temporary_directory: Path,
) -> BuiltDolbyVisionAV1Files:
    """Encodes the base layer, inserts each frame's RPU, writes the MP4 and Matroska files, and verifies them."""

    sub_profile = build.sub_profile
    encode_settings = build.encode_settings
    if len(build.source_RPUs) != encode_settings.frame_count:
        raise VectorGenerationError(
            f"Profile {sub_profile.name} has {len(build.source_RPUs)} RPUs for {encode_settings.frame_count} frames"
        )
    file_stem = f"profile{sub_profile.name}"
    base_stream_path = temporary_directory / f"{file_stem}-base.obu"
    execute_tool(tools.FFmpeg_path, create_AV1_encode_arguments(encode_settings, sub_profile.color, base_stream_path))
    injected_stream = insert_dolby_vision_metadata(
        base_stream_path.read_bytes(),
        [source_RPU.RPU for source_RPU in build.source_RPUs],
    )
    require_injected_stream(injected_stream, build.source_RPUs, f"Profile {sub_profile.name} bitstream")
    injected_stream_path = temporary_directory / f"{file_stem}-injected.obu"
    injected_stream_path.write_bytes(injected_stream.data)
    require_OBU_stream_evidence(
        probe_media(tools, injected_stream_path, OBU_STREAM_FORMAT),
        encode_settings,
        sub_profile.color,
        f"Profile {sub_profile.name} bitstream",
    )

    intermediate_path = temporary_directory / f"{file_stem}-intermediate.mp4"
    execute_tool(
        tools.FFmpeg_path,
        create_intermediate_MP4_arguments(
            injected_stream_path,
            encode_settings.frame_rate,
            build.audio_tone,
            encode_settings.frame_count / encode_settings.frame_rate,
            intermediate_path,
        ),
    )
    configuration = get_dolby_vision_configuration(sub_profile, encode_settings)
    configuration_record = create_dolby_vision_configuration_record(configuration)
    configured_path = temporary_directory / f"{file_stem}-configured.mp4"
    configured_path.write_bytes(
        insert_dolby_vision_configuration_box(intermediate_path.read_bytes(), configuration_record)
    )
    execute_tool(tools.FFmpeg_path, create_remux_arguments(configured_path, MP4_FORMAT, build.MP4_path))
    execute_tool(tools.FFmpeg_path, create_remux_arguments(configured_path, MATROSKA_FORMAT, build.Matroska_path))
    sample_entry_type = get_MP4_sample_entry_type(sub_profile)
    if sample_entry_type != AV1_SAMPLE_ENTRY_TYPE:
        build.MP4_path.write_bytes(rename_AV1_sample_entry(build.MP4_path.read_bytes(), sample_entry_type))

    require_MP4_signaling(build.MP4_path.read_bytes(), build, configuration_record, build.MP4_path.name)
    for container_format, path in ((MP4_FORMAT, build.MP4_path), (MATROSKA_FORMAT, build.Matroska_path)):
        require_container_evidence(
            probe_media(tools, path),
            container_format,
            build,
            configuration,
            injected_stream,
            path.name,
        )
    return BuiltDolbyVisionAV1Files(injected_stream=injected_stream, injected_stream_path=injected_stream_path)


def split_annex_B_NAL_units(data: bytes) -> list[bytes]:
    """Returns the NAL units of an Annex B stream, without their start codes or the zero bytes before them."""

    start_code_offsets: list[int] = []
    search_offset = 0
    while (start_code_offset := data.find(ANNEX_B_START_CODE_PREFIX, search_offset)) >= 0:
        start_code_offsets.append(start_code_offset)
        search_offset = start_code_offset + len(ANNEX_B_START_CODE_PREFIX)
    NAL_units: list[bytes] = []
    for unit_index, start_code_offset in enumerate(start_code_offsets):
        NAL_unit_offset = start_code_offset + len(ANNEX_B_START_CODE_PREFIX)
        if unit_index + 1 == len(start_code_offsets):
            NAL_units.append(data[NAL_unit_offset:])
            continue
        # A NAL unit never ends in a zero byte, so trailing zeros belong to the next start code
        NAL_units.append(data[NAL_unit_offset : start_code_offsets[unit_index + 1]].rstrip(b"\x00"))
    return NAL_units


def append_HEVC_RPU_NAL_units(stream: bytes, source_RPUs: Sequence[SourceRPU]) -> bytes:
    """Returns an Annex B HEVC stream, whose access units start with delimiters, with one RPU NAL unit ending each.

    Each NAL unit is type 62 around the escaped RPU its file stores, the carriage the HEVC parse reads.
    """

    access_units: list[list[bytes]] = []
    for NAL_unit in split_annex_B_NAL_units(stream):
        if (NAL_unit[0] >> 1) & 0x3F == HEVC_ACCESS_UNIT_DELIMITER_TYPE:
            access_units.append([])
        if not access_units:
            raise VectorGenerationError("The HEVC reference stream does not start with an access unit delimiter")
        access_units[-1].append(NAL_unit)
    if len(access_units) != len(source_RPUs):
        raise VectorGenerationError(
            f"The HEVC reference stream has {len(access_units)} access units for {len(source_RPUs)} RPUs"
        )
    output = bytearray()
    for access_unit, source_RPU in zip(access_units, source_RPUs, strict=True):
        for NAL_unit in (*access_unit, HEVC_RPU_NAL_HEADER + source_RPU.escaped_RPU):
            output += RPU_FILE_START_CODE + NAL_unit
    return bytes(output)


def create_HEVC_reference_encode_arguments(encode_settings: AV1EncodeSettings, output_path: Path) -> list[str]:
    """Returns the FFmpeg arguments of an HEVC Main 10 encode of testsrc2 with an access unit delimiter per frame."""

    return [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-f", "lavfi",
        "-i",
        f"testsrc2=size={encode_settings.width}x{encode_settings.height}:rate={encode_settings.frame_rate},"
        f"format={PIXEL_FORMAT}",
        "-frames:v", str(encode_settings.frame_count),
        "-c:v", "libx265",
        "-preset", "ultrafast",
        "-x265-params", "info=0:aud=1:bframes=0:pools=none:frame-threads=1:log-level=error",
        "-f", HEVC_STREAM_FORMAT,
        str(output_path),
    ]


def require_FFmpeg_metadata_parity(
    tools: MediaTools,
    built_files: BuiltDolbyVisionAV1Files,
    build: DolbyVisionAV1Build,
    temporary_directory: Path,
) -> None:
    """Requires FFmpeg to decode the same Dolby Vision metadata from each T.35 OBU as from its RPU in NAL unit 62."""

    file_stem = f"profile{build.sub_profile.name}"
    HEVC_base_path = temporary_directory / f"{file_stem}-reference-base.hevc"
    execute_tool(tools.FFmpeg_path, create_HEVC_reference_encode_arguments(build.encode_settings, HEVC_base_path))
    HEVC_reference_path = temporary_directory / f"{file_stem}-reference.hevc"
    HEVC_reference_path.write_bytes(append_HEVC_RPU_NAL_units(HEVC_base_path.read_bytes(), build.source_RPUs))
    require_equal(
        probe_dolby_vision_metadata(tools, built_files.injected_stream_path, OBU_STREAM_FORMAT),
        probe_dolby_vision_metadata(tools, HEVC_reference_path, HEVC_STREAM_FORMAT),
        f"Profile {build.sub_profile.name} FFmpeg Dolby Vision metadata from T.35 and from HEVC",
    )


def get_vector_file_name(sub_profile: SubProfile, container_format: str) -> str:
    """Returns the committed file name of one vector."""

    return f"profile{sub_profile.name}.{FILE_EXTENSION_BY_FORMAT[container_format]}"


def get_vector_key_frame_flags() -> list[bool]:
    """Returns whether each vector frame is a key frame, given the fixed key frame interval."""

    return [frame_index % VECTOR_KEY_FRAME_INTERVAL == 0 for frame_index in range(VECTOR_FRAME_COUNT)]


def create_expectations(source_RPUs_by_file_name: Mapping[str, SourceRPU]) -> dict[str, object]:
    """Returns the known answers of every vector, which depend only on the vector table and the source RPUs."""

    key_frame_flags = get_vector_key_frame_flags()
    vectors: list[dict[str, object]] = []
    for sub_profile in SUB_PROFILES:
        configuration = get_dolby_vision_configuration(sub_profile, VECTOR_ENCODE_SETTINGS)
        frames = [
            {
                "ITUTT35PayloadSHA256": hashlib.sha256(
                    get_ITUT_T35_payload(
                        parse_OBUs(create_dolby_vision_metadata_OBU(source_RPUs_by_file_name[file_name].RPU))[0]
                    )
                ).hexdigest(),
                "keyFrame": key_frame,
                "sourceRPUFileName": file_name,
            }
            for file_name, key_frame in zip(sub_profile.source_RPU_file_names, key_frame_flags, strict=True)
        ]
        for container_format in CONTAINER_FORMATS:
            vectors.append(
                {
                    "baseLayerSignalCompatibilityID": configuration.base_layer_signal_compatibility_ID,
                    "colorPrimaries": sub_profile.color.primaries,
                    "container": container_format,
                    "dolbyVisionLevel": configuration.level,
                    "dolbyVisionProfile": configuration.profile,
                    "fileName": get_vector_file_name(sub_profile, container_format),
                    "frameCount": VECTOR_FRAME_COUNT,
                    "frames": frames,
                    "fullRange": sub_profile.color.full_range,
                    "height": VECTOR_HEIGHT,
                    "matrixCoefficients": sub_profile.color.matrix_coefficients,
                    "sampleEntry": get_MP4_sample_entry_type(sub_profile) if container_format == MP4_FORMAT else None,
                    "subProfile": sub_profile.name,
                    "transferCharacteristics": sub_profile.color.transfer_characteristics,
                    "width": VECTOR_WIDTH,
                }
            )
    return {
        "generator": layout_path("codecVectorScriptsDirectory", Path(__file__).name),
        "ITUTT35Payload": ITU_T_T35_PAYLOAD_DEFINITION,
        "sourceRPUDirectory": layout_path("testVectorsDirectory", RPU_SOURCE_FOLDER_NAME),
        "vectors": vectors,
    }


def format_expectations(expectations: Mapping[str, object]) -> bytes:
    """Returns the expectations as sorted, two-space indented JSON with a final line feed."""

    return (json.dumps(expectations, indent=2, sort_keys=True) + "\n").encode("utf-8")


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


def generate_vector_files(tools: MediaTools, temporary_directory: Path) -> dict[str, bytes]:
    """Builds and verifies every vector, and returns the bytes of each committed file by name."""

    source_RPUs_by_file_name = {
        file_name: read_source_RPU(file_name)
        for sub_profile in SUB_PROFILES
        for file_name in sub_profile.source_RPU_file_names
    }
    key_frame_flags = get_vector_key_frame_flags()
    vector_files: dict[str, bytes] = {}
    for sub_profile in SUB_PROFILES:
        build = DolbyVisionAV1Build(
            audio_tone=None,
            encode_settings=VECTOR_ENCODE_SETTINGS,
            Matroska_path=temporary_directory / get_vector_file_name(sub_profile, MATROSKA_FORMAT),
            MP4_path=temporary_directory / get_vector_file_name(sub_profile, MP4_FORMAT),
            source_RPUs=tuple(source_RPUs_by_file_name[file_name] for file_name in sub_profile.source_RPU_file_names),
            sub_profile=sub_profile,
        )
        built_files = build_dolby_vision_AV1_files(tools, build, temporary_directory)
        require_equal(
            [temporal_unit.key_frame for temporal_unit in built_files.injected_stream.temporal_units],
            key_frame_flags,
            f"Profile {sub_profile.name} key frames",
        )
        require_FFmpeg_metadata_parity(tools, built_files, build, temporary_directory)
        for path in (build.MP4_path, build.Matroska_path):
            vector_files[path.name] = path.read_bytes()
    vector_files[EXPECTATIONS_FILE_NAME] = format_expectations(create_expectations(source_RPUs_by_file_name))
    return vector_files


def parse_arguments(command_arguments: Sequence[str] | None) -> argparse.Namespace:
    """Parses the command line."""

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
    """Generates or checks every vector and the expectations, and returns the process exit status."""

    arguments = parse_arguments(command_arguments)
    try:
        tools = MediaTools(
            FFmpeg_path=resolve_FFmpeg_tool("ffmpeg", arguments.ffmpeg),
            FFprobe_path=resolve_FFmpeg_tool("ffprobe", arguments.ffprobe),
        )
        check_toolchain(tools)
        with tempfile.TemporaryDirectory(prefix="webgpu-dolby-vision-av1-") as temporary_directory:
            vector_files = generate_vector_files(tools, Path(temporary_directory))
        # Every vector passed its checks before the first committed file is touched
        for file_name, content in vector_files.items():
            write_or_check_output(VECTOR_DIRECTORY / file_name, content, check=arguments.check)
    except (VectorGenerationError, VectorError, GeneratedOutputError, ToolError, OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1
    action = "Verified" if arguments.check else "Generated"
    print(
        f"{action} {len(vector_files) - 1} Dolby Vision Profile 10 AV1 vectors and "
        f"{EXPECTATIONS_FILE_NAME} in {VECTOR_DIRECTORY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
