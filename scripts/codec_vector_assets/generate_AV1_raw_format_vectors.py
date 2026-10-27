#!/usr/bin/env python3
"""Generate the deterministic AV1 raw-format capability vectors."""

from __future__ import annotations

import argparse
import json
import math
import re
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Sequence, TypedDict

from engine_layout import CODEC_VECTOR_ASSETS_DIRECTORY
from generated_output import GeneratedOutputError, write_or_check_output


VECTOR_DIRECTORY: Final = CODEC_VECTOR_ASSETS_DIRECTORY / "av1-raw-format"
REQUIRED_FFMPEG_VERSION: Final = "2026-03-01-git-862338fe31-full_build-www.gyan.dev"
REQUIRED_LIBAVCODEC_VERSION_PATTERN: Final = re.compile(r"libavcodec\s+62\.\s*24\.100")
# libaom and libdav1d print their versions at the verbose log level, each on its own line after the context tag
REQUIRED_LIBAOM_VERSION_PATTERN: Final = re.compile(r"\] 3\.13\.1-271-g85d21cdb24\r?$", re.MULTILINE)
REQUIRED_LIBDAV1D_VERSION_PATTERN: Final = re.compile(r"\] libdav1d 1\.5\.3-18-gdaef396\r?$", re.MULTILINE)
CODED_WIDTH: Final = 192
CODED_HEIGHT: Final = 192
FRAME_RATE: Final = 1
# One key temporal unit, then one inter temporal unit
FRAME_COUNT: Final = 2
FNV1A_OFFSET_BASIS: Final = 2_166_136_261
FNV1A_PRIME: Final = 16_777_619
# Masking each product to 32 bits reproduces JavaScript's Math.imul(...) >>> 0
UINT32_MASK: Final = 0xFFFF_FFFF
FINGERPRINT_COLUMN_SAMPLE_COUNT: Final = 64
FINGERPRINT_ROW_SAMPLE_COUNT: Final = 36
LITTLE_ENDIAN_UINT16: Final = struct.Struct("<H")
# Serial and byte-reproducible: one thread, no row multithreading, one tile.
# Good-quality usage clamps its speed to 6, and no lookahead keeps every temporal unit to one shown frame
LIBAOM_ARGUMENTS: Final = (
    "-usage",
    "good",
    "-cpu-used",
    "6",
    "-crf",
    "40",
    "-b:v",
    "0",
    "-g",
    "30",
    "-lag-in-frames",
    "0",
    "-threads",
    "1",
    "-row-mt",
    "0",
    "-tiles",
    "1x1",
)
REFERENCE_DECODER_ARGUMENTS: Final = ("-c:v", "libdav1d")
OBU_STREAM_FORMAT: Final = "obu"
# AV1 OBU header bits
OBU_FORBIDDEN_BIT: Final = 0x80
OBU_TYPE_SHIFT: Final = 3
OBU_TYPE_MASK: Final = 0x0F
OBU_EXTENSION_FLAG: Final = 0x04
OBU_HAS_SIZE_FIELD: Final = 0x02
SEQUENCE_HEADER_OBU_TYPE: Final = 1
# leb128() codes at most 8 bytes
MAXIMUM_LEB128_BYTE_LENGTH: Final = 8
# color_config() of a sequence header with BT.709 primaries, sRGB transfer, and identity matrix implies 4:4:4
CP_BT_709: Final = 1
TC_SRGB: Final = 13
MC_IDENTITY: Final = 0
PROFESSIONAL_SEQUENCE_PROFILE: Final = 2
HIGH_SEQUENCE_PROFILE: Final = 1
SELECT_SCREEN_CONTENT_TOOLS: Final = 2


class VectorGenerationError(RuntimeError):
    """Reports a deterministic vector generation or verification failure."""


@dataclass(frozen=True)
class AV1RawFormatVector:
    """Describes one committed vector, its libaom encode, and the evidence it must produce."""

    bit_depth: int
    expected_fingerprints: tuple[int, ...]
    pixel_format: str
    sequence_profile: int
    subsampling: tuple[int, int]
    temporal_unit_byte_lengths: tuple[int, ...]
    variant: str


@dataclass(frozen=True)
class CommandOutput:
    """Holds the decoded output of one successful command."""

    standard_error: str
    standard_output: str


@dataclass(frozen=True)
class FormatGeometry:
    """Describes the planar raw-video layout of one pixel format at the coded size."""

    bytes_per_component: int
    chroma_byte_length: int
    chroma_height: int
    chroma_width: int
    frame_byte_length: int
    luma_byte_length: int


@dataclass(frozen=True)
class AV1OBU:
    """One OBU of a low-overhead bitstream: its type and its payload after the header and size field."""

    OBU_type: int
    payload: bytes


class SequenceHeaderEvidence(TypedDict):
    """The color fields of the first sequence header, keyed as --inspect prints them."""

    bitDepth: int
    monochrome: bool
    sequenceProfile: int
    subsamplingX: int
    subsamplingY: int


class VectorEvidence(TypedDict):
    """The measured structure of one generated vector, keyed and ordered as --inspect prints it."""

    decodedFingerprints: list[int]
    pictureTypes: list[str]
    sequenceHeader: SequenceHeaderEvidence
    temporalUnitByteLengths: list[int]


VECTORS: Final = (
    AV1RawFormatVector(
        bit_depth=8,
        expected_fingerprints=(1_750_878_287, 2_435_266_265),
        pixel_format="yuv420p",
        sequence_profile=0,
        subsampling=(1, 1),
        temporal_unit_byte_lengths=(2_412, 1_081),
        variant="main420-8",
    ),
    AV1RawFormatVector(
        bit_depth=8,
        expected_fingerprints=(991_343_345, 2_442_111_325),
        pixel_format="yuv444p",
        sequence_profile=1,
        subsampling=(0, 0),
        temporal_unit_byte_lengths=(6_839, 1_468),
        variant="high444-8",
    ),
    AV1RawFormatVector(
        bit_depth=10,
        expected_fingerprints=(1_637_697_560, 2_586_901_718),
        pixel_format="yuv444p10le",
        sequence_profile=1,
        subsampling=(0, 0),
        temporal_unit_byte_lengths=(7_420, 1_359),
        variant="high444-10",
    ),
    AV1RawFormatVector(
        bit_depth=8,
        expected_fingerprints=(645_782_140, 2_755_507_149),
        pixel_format="yuv422p",
        sequence_profile=2,
        subsampling=(1, 0),
        temporal_unit_byte_lengths=(4_472, 1_325),
        variant="professional422-8",
    ),
    AV1RawFormatVector(
        bit_depth=10,
        expected_fingerprints=(2_462_944_461, 354_112_061),
        pixel_format="yuv422p10le",
        sequence_profile=2,
        subsampling=(1, 0),
        temporal_unit_byte_lengths=(4_936, 1_208),
        variant="professional422-10",
    ),
    AV1RawFormatVector(
        bit_depth=12,
        expected_fingerprints=(2_209_574_760, 315_170_145),
        pixel_format="yuv420p12le",
        sequence_profile=2,
        subsampling=(1, 1),
        temporal_unit_byte_lengths=(2_595, 893),
        variant="professional420-12",
    ),
    AV1RawFormatVector(
        bit_depth=12,
        expected_fingerprints=(3_557_842_973, 3_449_248_946),
        pixel_format="yuv422p12le",
        sequence_profile=2,
        subsampling=(1, 0),
        temporal_unit_byte_lengths=(4_942, 1_075),
        variant="professional422-12",
    ),
    AV1RawFormatVector(
        bit_depth=12,
        expected_fingerprints=(2_164_797_336, 3_228_784_269),
        pixel_format="yuv444p12le",
        sequence_profile=2,
        subsampling=(0, 0),
        temporal_unit_byte_lengths=(7_396, 1_309),
        variant="professional444-12",
    ),
)


def run_command(command: str, arguments: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
    """Runs one command with an argument list and captures its raw output."""

    try:
        return subprocess.run([command, *arguments], capture_output=True, check=False, stdin=subprocess.DEVNULL)
    except OSError as error:
        raise VectorGenerationError(f"{command} failed:\n{error}") from error


def run_text_command(command: str, arguments: Sequence[str]) -> CommandOutput:
    """Requires a command to succeed and returns its output decoded as UTF-8."""

    result = run_command(command, arguments)
    standard_error = result.stderr.decode("utf-8", errors="replace")
    standard_output = result.stdout.decode("utf-8", errors="replace")
    if result.returncode != 0:
        raise VectorGenerationError(f"{command} failed:\n{standard_error or standard_output}")
    return CommandOutput(standard_error=standard_error, standard_output=standard_output)


def run_binary_command(command: str, arguments: Sequence[str]) -> bytes:
    """Requires a command to succeed and returns its raw standard output."""

    result = run_command(command, arguments)
    if result.returncode != 0:
        raise VectorGenerationError(f"{command} failed:\n{result.stderr.decode('utf-8', errors='replace')}")
    return result.stdout


def format_JSON(value: object) -> str:
    """Returns the compact JSON text that JavaScript's JSON.stringify writes for the value."""

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def require_equal(actual: object, expected: object, label: str) -> None:
    """Requires identical JSON text, which also tells true from 1, and reports both values as JSON."""

    actual_JSON = format_JSON(actual)
    expected_JSON = format_JSON(expected)
    if actual_JSON != expected_JSON:
        raise VectorGenerationError(f"{label} mismatch: expected {expected_JSON}, got {actual_JSON}")


def generate_vector(vector: AV1RawFormatVector, output_path: Path) -> None:
    """Encodes the vector with libaom as a low-overhead OBU stream, its temporal units back to back."""

    run_text_command(
        "ffmpeg",
        (
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size={CODED_WIDTH}x{CODED_HEIGHT}:rate={FRAME_RATE}:duration={FRAME_COUNT}",
            "-frames:v",
            str(FRAME_COUNT),
            "-map_metadata",
            "-1",
            "-fflags",
            "+bitexact",
            "-flags:v",
            "+bitexact",
            "-pix_fmt",
            vector.pixel_format,
            "-c:v",
            "libaom-av1",
            *LIBAOM_ARGUMENTS,
            "-f",
            OBU_STREAM_FORMAT,
            "-y",
            str(output_path),
        ),
    )


def split_output_lines(output: str) -> list[str]:
    """Returns the trimmed output split at CRLF or LF, which leaves one empty line for empty output."""

    return re.split(r"\r?\n", output.strip())


def get_temporal_unit_byte_lengths(input_path: Path) -> list[int]:
    """Returns the byte length of every temporal unit, each one packet of FFmpeg's OBU demuxer."""

    result = run_text_command(
        "ffprobe",
        (
            "-v",
            "error",
            "-f",
            OBU_STREAM_FORMAT,
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=size",
            "-of",
            "csv=p=0",
            str(input_path),
        ),
    )
    # A blank line, which empty output produces, reads as 0
    return [int(line) if line.strip() else 0 for line in split_output_lines(result.standard_output)]


def get_picture_types(input_path: Path) -> list[str]:
    """Returns the picture type FFprobe reports for every frame libdav1d decodes."""

    result = run_text_command(
        "ffprobe",
        (
            "-v",
            "error",
            *REFERENCE_DECODER_ARGUMENTS,
            "-f",
            OBU_STREAM_FORMAT,
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=pict_type",
            "-of",
            "csv=p=0",
            str(input_path),
        ),
    )
    return split_output_lines(result.standard_output)


def read_leb128(data: bytes, offset: int) -> tuple[int, int]:
    """Returns one leb128() value and its byte length."""

    value = 0
    for byte_index in range(MAXIMUM_LEB128_BYTE_LENGTH):
        if offset + byte_index >= len(data):
            raise VectorGenerationError("AV1 leb128 value is truncated")
        byte = data[offset + byte_index]
        value |= (byte & 0x7F) << (7 * byte_index)
        if not byte & 0x80:
            return value, byte_index + 1
    raise VectorGenerationError("AV1 leb128 value is longer than 8 bytes")


def parse_OBUs(data: bytes) -> tuple[AV1OBU, ...]:
    """Parses a low-overhead bitstream, in which every OBU has a size field."""

    OBUs: list[AV1OBU] = []
    offset = 0
    while offset < len(data):
        header = data[offset]
        if header & OBU_FORBIDDEN_BIT:
            raise VectorGenerationError(f"AV1 OBU at byte {offset} sets the forbidden bit")
        if not header & OBU_HAS_SIZE_FIELD:
            raise VectorGenerationError(f"AV1 OBU at byte {offset} has no size field")
        payload_size, size_byte_length = read_leb128(data, offset + 1 + (1 if header & OBU_EXTENSION_FLAG else 0))
        payload_offset = offset + 1 + (1 if header & OBU_EXTENSION_FLAG else 0) + size_byte_length
        payload_end = payload_offset + payload_size
        if payload_end > len(data):
            raise VectorGenerationError(f"AV1 OBU at byte {offset} overruns the stream")
        OBUs.append(AV1OBU(OBU_type=(header >> OBU_TYPE_SHIFT) & OBU_TYPE_MASK, payload=data[payload_offset:payload_end]))
        offset = payload_end
    return tuple(OBUs)


class BitReader:
    """Reads most-significant-bit-first fields from bytes."""

    def __init__(self, data: bytes) -> None:
        self.bit_index = 0
        self.data = data

    def read_bits(self, bit_count: int) -> int:
        value = 0
        for _ in range(bit_count):
            byte_index = self.bit_index // 8
            if byte_index >= len(self.data):
                raise VectorGenerationError("AV1 sequence header ended unexpectedly")
            value = (value << 1) | ((self.data[byte_index] >> (7 - (self.bit_index % 8))) & 1)
            self.bit_index += 1
        return value

    def read_flag(self) -> bool:
        return self.read_bits(1) == 1

    def read_uvlc(self) -> int:
        leading_zero_count = 0
        while not self.read_flag():
            leading_zero_count += 1
            if leading_zero_count >= 32:
                raise VectorGenerationError("AV1 uvlc value is too large")
        return self.read_bits(leading_zero_count) + (1 << leading_zero_count) - 1


def skip_to_color_config(reader: BitReader) -> None:
    """Reads sequence_header_obu() from after seq_profile up to color_config(), as AV1 section 5.5.1 orders it."""

    reader.read_flag()  # still_picture
    reduced_still_picture_header = reader.read_flag()
    if reduced_still_picture_header:
        reader.read_bits(5)  # seq_level_idx[0]
    else:
        decoder_model_info_present = False
        buffer_delay_length = 0
        if reader.read_flag():  # timing_info_present_flag
            reader.read_bits(32)  # num_units_in_display_tick
            reader.read_bits(32)  # time_scale
            if reader.read_flag():  # equal_picture_interval
                reader.read_uvlc()  # num_ticks_per_picture_minus_1
            decoder_model_info_present = reader.read_flag()
            if decoder_model_info_present:
                buffer_delay_length = reader.read_bits(5) + 1
                reader.read_bits(32)  # num_units_in_decoding_tick
                reader.read_bits(5)  # buffer_removal_time_length_minus_1
                reader.read_bits(5)  # frame_presentation_time_length_minus_1
        initial_display_delay_present = reader.read_flag()
        for _ in range(reader.read_bits(5) + 1):
            reader.read_bits(12)  # operating_point_idc
            if reader.read_bits(5) > 7:  # seq_level_idx
                reader.read_flag()  # seq_tier
            if decoder_model_info_present and reader.read_flag():  # decoder_model_present_for_this_op
                reader.read_bits(buffer_delay_length)  # decoder_buffer_delay
                reader.read_bits(buffer_delay_length)  # encoder_buffer_delay
                reader.read_flag()  # low_delay_mode_flag
            if initial_display_delay_present and reader.read_flag():
                reader.read_bits(4)  # initial_display_delay_minus_1
    frame_width_bit_count = reader.read_bits(4) + 1
    frame_height_bit_count = reader.read_bits(4) + 1
    reader.read_bits(frame_width_bit_count)  # max_frame_width_minus_1
    reader.read_bits(frame_height_bit_count)  # max_frame_height_minus_1
    if not reduced_still_picture_header and reader.read_flag():  # frame_id_numbers_present_flag
        reader.read_bits(4)  # delta_frame_id_length_minus_2
        reader.read_bits(3)  # additional_frame_id_length_minus_1
    reader.read_flag()  # use_128x128_superblock
    reader.read_flag()  # enable_filter_intra
    reader.read_flag()  # enable_intra_edge_filter
    if not reduced_still_picture_header:
        reader.read_flag()  # enable_interintra_compound
        reader.read_flag()  # enable_masked_compound
        reader.read_flag()  # enable_warped_motion
        reader.read_flag()  # enable_dual_filter
        enable_order_hint = reader.read_flag()
        if enable_order_hint:
            reader.read_flag()  # enable_jnt_comp
            reader.read_flag()  # enable_ref_frame_mvs
        screen_content_tools = SELECT_SCREEN_CONTENT_TOOLS if reader.read_flag() else reader.read_bits(1)
        if screen_content_tools > 0 and not reader.read_flag():  # seq_choose_integer_mv
            reader.read_flag()  # seq_force_integer_mv
        if enable_order_hint:
            reader.read_bits(3)  # order_hint_bits_minus_1
    reader.read_flag()  # enable_superres
    reader.read_flag()  # enable_cdef
    reader.read_flag()  # enable_restoration


def read_sequence_header_evidence(payload: bytes) -> SequenceHeaderEvidence:
    """Returns seq_profile, BitDepth, mono_chrome, and the subsampling of one sequence header payload."""

    reader = BitReader(payload)
    sequence_profile = reader.read_bits(3)
    skip_to_color_config(reader)
    bit_depth = 8
    if reader.read_flag():  # high_bitdepth
        bit_depth = 12 if sequence_profile == PROFESSIONAL_SEQUENCE_PROFILE and reader.read_flag() else 10
    monochrome = False if sequence_profile == HIGH_SEQUENCE_PROFILE else reader.read_flag()
    color_primaries = color_transfer = matrix_coefficients = None
    if reader.read_flag():  # color_description_present_flag
        color_primaries = reader.read_bits(8)
        color_transfer = reader.read_bits(8)
        matrix_coefficients = reader.read_bits(8)
    if monochrome:
        subsampling = (1, 1)
    elif color_primaries == CP_BT_709 and color_transfer == TC_SRGB and matrix_coefficients == MC_IDENTITY:
        subsampling = (0, 0)
    else:
        reader.read_flag()  # color_range
        if sequence_profile == 0:
            subsampling = (1, 1)
        elif sequence_profile == HIGH_SEQUENCE_PROFILE:
            subsampling = (0, 0)
        elif bit_depth == 12:
            subsampling_x = reader.read_bits(1)
            subsampling = (subsampling_x, reader.read_bits(1) if subsampling_x else 0)
        else:
            subsampling = (1, 0)
    return {
        "bitDepth": bit_depth,
        "monochrome": monochrome,
        "sequenceProfile": sequence_profile,
        "subsamplingX": subsampling[0],
        "subsamplingY": subsampling[1],
    }


def get_sequence_header_evidence(data: bytes) -> SequenceHeaderEvidence:
    """Returns the evidence of the first sequence header OBU of a low-overhead bitstream."""

    for OBU in parse_OBUs(data):
        if OBU.OBU_type == SEQUENCE_HEADER_OBU_TYPE:
            return read_sequence_header_evidence(OBU.payload)
    raise VectorGenerationError("AV1 stream has no sequence header")


def mix_fingerprint_value(fingerprint: int, value: int) -> int:
    """Returns the FNV-1a fingerprint after mixing the low byte, then the second byte, of the value."""

    mixed_fingerprint = ((fingerprint ^ (value & 0xFF)) * FNV1A_PRIME) & UINT32_MASK
    return ((mixed_fingerprint ^ ((value >> 8) & 0xFF)) * FNV1A_PRIME) & UINT32_MASK


def mix_plane_fingerprint(
    fingerprint: int,
    frame: bytes,
    plane_offset: int,
    width: int,
    height: int,
    bytes_per_component: int,
) -> int:
    """Returns the fingerprint after mixing the plane dimensions and a uniform sample grid over the plane."""

    stride = width * bytes_per_component
    mixed_fingerprint = mix_fingerprint_value(fingerprint, width)
    mixed_fingerprint = mix_fingerprint_value(mixed_fingerprint, height)
    for row_sample_index in range(FINGERPRINT_ROW_SAMPLE_COUNT):
        # For these small non-negative operands, floor division equals JavaScript's Math.floor of the quotient
        row_index = row_sample_index * (height - 1) // (FINGERPRINT_ROW_SAMPLE_COUNT - 1)
        for column_sample_index in range(FINGERPRINT_COLUMN_SAMPLE_COUNT):
            column_index = (
                column_sample_index * (width - 1) // (FINGERPRINT_COLUMN_SAMPLE_COUNT - 1)
            )
            byte_offset = plane_offset + (row_index * stride) + (column_index * bytes_per_component)
            sample = (
                frame[byte_offset]
                if bytes_per_component == 1
                else LITTLE_ENDIAN_UINT16.unpack_from(frame, byte_offset)[0]
            )
            mixed_fingerprint = mix_fingerprint_value(mixed_fingerprint, sample)
    return mixed_fingerprint


def get_format_geometry(pixel_format: str) -> FormatGeometry:
    """Returns the planar raw-video layout FFmpeg writes for the pixel format at the coded size."""

    bytes_per_component = 2 if "10le" in pixel_format or "12le" in pixel_format else 1
    chroma_width_divisor = 1 if pixel_format.startswith("yuv444") else 2
    chroma_height_divisor = 2 if pixel_format.startswith("yuv420") else 1
    chroma_width = math.ceil(CODED_WIDTH / chroma_width_divisor)
    chroma_height = math.ceil(CODED_HEIGHT / chroma_height_divisor)
    luma_byte_length = CODED_WIDTH * CODED_HEIGHT * bytes_per_component
    chroma_byte_length = chroma_width * chroma_height * bytes_per_component
    return FormatGeometry(
        bytes_per_component=bytes_per_component,
        chroma_byte_length=chroma_byte_length,
        chroma_height=chroma_height,
        chroma_width=chroma_width,
        frame_byte_length=luma_byte_length + (2 * chroma_byte_length),
        luma_byte_length=luma_byte_length,
    )


def create_frame_fingerprint(frame: bytes, geometry: FormatGeometry) -> int:
    """Returns the production 32-bit FNV-1a fingerprint of one decoded frame's luma and chroma planes."""

    fingerprint = mix_plane_fingerprint(
        FNV1A_OFFSET_BASIS,
        frame,
        0,
        CODED_WIDTH,
        CODED_HEIGHT,
        geometry.bytes_per_component,
    )
    fingerprint = mix_plane_fingerprint(
        fingerprint,
        frame,
        geometry.luma_byte_length,
        geometry.chroma_width,
        geometry.chroma_height,
        geometry.bytes_per_component,
    )
    return mix_plane_fingerprint(
        fingerprint,
        frame,
        geometry.luma_byte_length + geometry.chroma_byte_length,
        geometry.chroma_width,
        geometry.chroma_height,
        geometry.bytes_per_component,
    )


def get_decoded_fingerprints(input_path: Path, vector: AV1RawFormatVector) -> list[int]:
    """Returns the fingerprint of every frame libdav1d decodes from the vector in its own pixel format."""

    decoded_bytes = run_binary_command(
        "ffmpeg",
        (
            "-v",
            "error",
            *REFERENCE_DECODER_ARGUMENTS,
            "-f",
            OBU_STREAM_FORMAT,
            "-i",
            str(input_path),
            "-map",
            "0:v:0",
            "-pix_fmt",
            vector.pixel_format,
            "-f",
            "rawvideo",
            "pipe:1",
        ),
    )
    geometry = get_format_geometry(vector.pixel_format)
    if len(decoded_bytes) != geometry.frame_byte_length * FRAME_COUNT:
        raise VectorGenerationError(f"{vector.variant} decoded raw byte length is unexpected")
    fingerprints: list[int] = []
    for frame_index in range(FRAME_COUNT):
        byte_offset = frame_index * geometry.frame_byte_length
        frame = decoded_bytes[byte_offset : byte_offset + geometry.frame_byte_length]
        fingerprints.append(create_frame_fingerprint(frame, geometry))
    return fingerprints


def check_toolchain(temporary_directory: Path) -> None:
    """Requires the pinned FFmpeg, libavcodec, FFprobe, libaom, and libdav1d builds."""

    ffmpeg_version = run_text_command("ffmpeg", ("-version",)).standard_output
    if (
        not ffmpeg_version.startswith(f"ffmpeg version {REQUIRED_FFMPEG_VERSION}")
        or REQUIRED_LIBAVCODEC_VERSION_PATTERN.search(ffmpeg_version) is None
    ):
        raise VectorGenerationError("The installed FFmpeg/libavcodec is not the required version")
    ffprobe_version = run_text_command("ffprobe", ("-version",)).standard_output
    if not ffprobe_version.startswith(f"ffprobe version {REQUIRED_FFMPEG_VERSION}"):
        raise VectorGenerationError("The installed FFprobe is not the required version")

    version_probe_path = temporary_directory / "libaom-version.obu"
    encoder_result = run_text_command(
        "ffmpeg",
        (
            "-hide_banner",
            "-loglevel",
            "verbose",
            "-f",
            "lavfi",
            "-i",
            f"color=size={CODED_WIDTH}x{CODED_HEIGHT}:rate=1:duration=1",
            "-frames:v",
            "1",
            "-c:v",
            "libaom-av1",
            "-cpu-used",
            "6",
            "-f",
            OBU_STREAM_FORMAT,
            "-y",
            str(version_probe_path),
        ),
    )
    if REQUIRED_LIBAOM_VERSION_PATTERN.search(encoder_result.standard_error) is None:
        raise VectorGenerationError("The installed libaom is not the required version")
    decoder_result = run_text_command(
        "ffmpeg",
        (
            "-hide_banner",
            "-loglevel",
            "verbose",
            *REFERENCE_DECODER_ARGUMENTS,
            "-f",
            OBU_STREAM_FORMAT,
            "-i",
            str(version_probe_path),
            "-f",
            "null",
            "-",
        ),
    )
    if REQUIRED_LIBDAV1D_VERSION_PATTERN.search(decoder_result.standard_error) is None:
        raise VectorGenerationError("The installed libdav1d is not the required version")


def get_vector_evidence(vector: AV1RawFormatVector, generated_path: Path) -> VectorEvidence:
    """Generates the vector and returns its fingerprints, picture types, sequence header, and temporal units."""

    generate_vector(vector, generated_path)
    generated_bytes = generated_path.read_bytes()
    # Dictionary values evaluate in order, so the tools run in the order the evidence lists them
    return {
        "decodedFingerprints": get_decoded_fingerprints(generated_path, vector),
        "pictureTypes": get_picture_types(generated_path),
        "sequenceHeader": get_sequence_header_evidence(generated_bytes),
        "temporalUnitByteLengths": get_temporal_unit_byte_lengths(generated_path),
    }


def require_vector_evidence(vector: AV1RawFormatVector, evidence: VectorEvidence) -> None:
    """Requires the measured evidence to match the vector table."""

    require_equal(
        evidence["temporalUnitByteLengths"],
        vector.temporal_unit_byte_lengths,
        f"{vector.variant} temporal-unit lengths",
    )
    require_equal(evidence["pictureTypes"], ["I", "P"], f"{vector.variant} picture types")
    require_equal(
        evidence["sequenceHeader"],
        {
            "bitDepth": vector.bit_depth,
            "monochrome": False,
            "sequenceProfile": vector.sequence_profile,
            "subsamplingX": vector.subsampling[0],
            "subsamplingY": vector.subsampling[1],
        },
        f"{vector.variant} sequence header",
    )
    require_equal(evidence["decodedFingerprints"], vector.expected_fingerprints, f"{vector.variant} decoded fingerprints")


def verify_vector(vector: AV1RawFormatVector, generated_path: Path, *, check: bool) -> None:
    """Requires the expected structure, then writes the vector or compares it with the committed bytes."""

    require_vector_evidence(vector, get_vector_evidence(vector, generated_path))
    write_or_check_output(VECTOR_DIRECTORY / f"{vector.variant}.obu", generated_path.read_bytes(), check=check)


def write_output_line(text: str) -> None:
    """Writes one LF-terminated UTF-8 line to standard output and flushes it."""

    # NOTE: print() ends lines with CRLF on Windows; LF keeps the output identical on every platform
    sys.stdout.buffer.write(f"{text}\n".encode("utf-8"))
    sys.stdout.buffer.flush()


def parse_arguments(command_arguments: Sequence[str] | None) -> argparse.Namespace:
    """Parses the command line, which selects at most one of --check and --inspect."""

    parser = argparse.ArgumentParser(description=__doc__)
    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument(
        "--check",
        action="store_true",
        help="Fail unless every committed vector matches its regeneration; nothing is written",
    )
    mode_group.add_argument(
        "--inspect",
        action="store_true",
        help="Print the measured evidence of every vector without comparing or writing",
    )
    return parser.parse_args(command_arguments)


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Generates, checks, or inspects every vector and returns the process exit status."""

    arguments = parse_arguments(command_arguments)
    try:
        with tempfile.TemporaryDirectory(prefix="webgpu-av1-raw-") as temporary_directory:
            temporary_path = Path(temporary_directory)
            check_toolchain(temporary_path)
            for vector in VECTORS:
                generated_path = temporary_path / f"{vector.variant}.obu"
                if arguments.inspect:
                    evidence = get_vector_evidence(vector, generated_path)
                    write_output_line(format_JSON({**evidence, "variant": vector.variant}))
                    continue
                verify_vector(vector, generated_path, check=arguments.check)
    except (VectorGenerationError, GeneratedOutputError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    if arguments.inspect:
        return 0
    action = "Verified" if arguments.check else "Generated"
    write_output_line(f"{action} {len(VECTORS)} deterministic AV1 raw-format vectors.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
