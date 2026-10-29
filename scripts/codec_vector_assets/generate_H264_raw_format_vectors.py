#!/usr/bin/env python3
"""Generate the deterministic H.264 raw-format capability vectors."""

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


VECTOR_DIRECTORY: Final = CODEC_VECTOR_ASSETS_DIRECTORY / "h264-raw-format"
REQUIRED_FFMPEG_VERSION: Final = "2026-03-01-git-862338fe31-full_build-www.gyan.dev"
REQUIRED_LIBAVCODEC_VERSION_PATTERN: Final = re.compile(r"libavcodec\s+62\.\s*24\.100")
# libx264 names its build in the user data SEI of its first access unit
REQUIRED_X264_VERSION: Final = b"x264 - core 165 r3223 0480cb0"
CODED_WIDTH: Final = 192
CODED_HEIGHT: Final = 192
FRAME_RATE: Final = 1
# One key access unit, then a P and a B access unit, which the B precedes in presentation
FRAME_COUNT: Final = 3
FNV1A_OFFSET_BASIS: Final = 2_166_136_261
FNV1A_PRIME: Final = 16_777_619
# Masking each product to 32 bits reproduces JavaScript's Math.imul(...) >>> 0
UINT32_MASK: Final = 0xFFFF_FFFF
FINGERPRINT_COLUMN_SAMPLE_COUNT: Final = 64
FINGERPRINT_ROW_SAMPLE_COUNT: Final = 36
LITTLE_ENDIAN_UINT16: Final = struct.Struct("<H")
# Serial: one thread, no sliced threads, and a fixed group with one non-adaptive B-frame and no pyramid
LIBX264_ARGUMENTS: Final = (
    "-preset",
    "medium",
    "-crf",
    "30",
    "-threads",
    "1",
    "-x264-params",
    "keyint=30:min-keyint=30:scenecut=0:bframes=1:b-adapt=0:b-pyramid=none:threads=1:sliced-threads=0",
)
# Drops the SEI NAL units, x264's version and option string among them
REMOVE_SEI_ARGUMENTS: Final = ("-bsf:v", "filter_units=remove_types=6")
ANNEX_B_STREAM_FORMAT: Final = "h264"
# H.264 NAL unit types
CODED_SLICE_NAL_UNIT_TYPE: Final = 1
IDR_SLICE_NAL_UNIT_TYPE: Final = 5
SPS_NAL_UNIT_TYPE: Final = 7
NAL_UNIT_TYPE_MASK: Final = 0x1F
# slice_type modulo 5, as Table 7-6 names it
SLICE_TYPE_NAMES: Final = {0: "P", 1: "B", 2: "I", 3: "SP", 4: "SI"}
SLICE_TYPE_COUNT: Final = 5
# The profiles whose SPS codes chroma_format_idc and the bit depths (7.3.2.1.1)
CHROMA_FORMAT_PROFILE_IDCS: Final = frozenset((100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135))
CHROMA_FORMAT_444: Final = 3
# Bounds an Exp-Golomb code to a 32-bit value
MAXIMUM_EXP_GOLOMB_LEADING_ZERO_COUNT: Final = 31


class VectorGenerationError(RuntimeError):
    """Reports a deterministic vector generation or verification failure."""


@dataclass(frozen=True)
class H264RawFormatVector:
    """Describes one committed vector, its libx264 encode, and the evidence it must produce."""

    access_unit_byte_lengths: tuple[int, ...]
    bit_depth: int
    chroma_format: int
    codec_string: str
    # In presentation order, as FFmpeg decodes them
    expected_fingerprints: tuple[int, ...]
    pixel_format: str
    profile_IDC: int
    x264_profile: str
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


class SequenceParameterSetEvidence(TypedDict):
    """The profile, level, chroma, and depth fields of the first SPS, keyed as --inspect prints them."""

    bitDepthChroma: int
    bitDepthLuma: int
    chromaFormat: int
    constraintFlags: int
    levelIDC: int
    profileIDC: int


class VectorEvidence(TypedDict):
    """The measured structure of one generated vector, keyed and ordered as --inspect prints it."""

    accessUnitByteLengths: list[int]
    codecString: str
    decodedFingerprints: list[int]
    pictureTypes: list[str]
    sequenceParameterSet: SequenceParameterSetEvidence
    sliceTypes: list[str]


VECTORS: Final = (
    H264RawFormatVector(
        access_unit_byte_lengths=(3_644, 2_367, 2_424),
        bit_depth=10,
        chroma_format=1,
        codec_string="avc1.6E000B",
        expected_fingerprints=(3_372_277_727, 4_248_514_697, 2_206_859_063),
        pixel_format="yuv420p10le",
        profile_IDC=110,
        x264_profile="high10",
        variant="high420-10",
    ),
    H264RawFormatVector(
        access_unit_byte_lengths=(4_286, 2_853, 2_580),
        bit_depth=8,
        chroma_format=2,
        codec_string="avc1.7A000B",
        expected_fingerprints=(1_199_520_366, 4_116_879_377, 4_007_075_873),
        pixel_format="yuv422p",
        profile_IDC=122,
        x264_profile="high422",
        variant="high422-8",
    ),
    H264RawFormatVector(
        access_unit_byte_lengths=(4_335, 2_821, 2_583),
        bit_depth=10,
        chroma_format=2,
        codec_string="avc1.7A000B",
        expected_fingerprints=(1_854_869_281, 2_866_151_398, 84_893_698),
        pixel_format="yuv422p10le",
        profile_IDC=122,
        x264_profile="high422",
        variant="high422-10",
    ),
    H264RawFormatVector(
        access_unit_byte_lengths=(3_581, 2_595, 2_153),
        bit_depth=8,
        chroma_format=3,
        codec_string="avc1.F4000B",
        expected_fingerprints=(1_794_184_940, 738_321_613, 2_303_389_642),
        pixel_format="yuv444p",
        profile_IDC=244,
        x264_profile="high444",
        variant="high444-8",
    ),
    H264RawFormatVector(
        access_unit_byte_lengths=(3_686, 2_570, 2_088),
        bit_depth=10,
        chroma_format=3,
        codec_string="avc1.F4000B",
        expected_fingerprints=(3_943_187_793, 1_482_372_203, 281_888_925),
        pixel_format="yuv444p10le",
        profile_IDC=244,
        x264_profile="high444",
        variant="high444-10",
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


def generate_vector(vector: H264RawFormatVector, output_path: Path) -> None:
    """Encodes the vector with libx264 as an Annex B stream without SEI, its access units back to back."""

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
            "libx264",
            "-profile:v",
            vector.x264_profile,
            *LIBX264_ARGUMENTS,
            *REMOVE_SEI_ARGUMENTS,
            "-f",
            ANNEX_B_STREAM_FORMAT,
            "-y",
            str(output_path),
        ),
    )


def split_output_lines(output: str) -> list[str]:
    """Returns the trimmed output split at CRLF or LF, which leaves one empty line for empty output."""

    return re.split(r"\r?\n", output.strip())


def get_access_unit_byte_lengths(input_path: Path) -> list[int]:
    """Returns the byte length of every access unit, in decode order, each one packet of FFmpeg's H.264 demuxer."""

    result = run_text_command(
        "ffprobe",
        (
            "-v",
            "error",
            "-f",
            ANNEX_B_STREAM_FORMAT,
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
    """Returns the picture type FFprobe reports for every frame FFmpeg decodes, in presentation order."""

    result = run_text_command(
        "ffprobe",
        (
            "-v",
            "error",
            "-f",
            ANNEX_B_STREAM_FORMAT,
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


def find_NAL_units(data: bytes) -> tuple[bytes, ...]:
    """Returns the NAL units of an Annex B stream, each without its start code; zero bytes before a start code are trailing."""

    unit_offsets: list[int] = []
    byte_index = 0
    while byte_index + 2 < len(data):
        if data[byte_index] == 0 and data[byte_index + 1] == 0 and data[byte_index + 2] == 1:
            unit_offsets.append(byte_index + 3)
            byte_index += 3
            continue
        byte_index += 1
    if not unit_offsets:
        raise VectorGenerationError("H.264 stream has no Annex B start code")
    NAL_units: list[bytes] = []
    for unit_index, unit_offset in enumerate(unit_offsets):
        unit_end = unit_offsets[unit_index + 1] - 3 if unit_index + 1 < len(unit_offsets) else len(data)
        # A NAL unit never ends in a zero byte, so trailing zeros are a four-byte start code's or trailing_zero_8bits
        NAL_units.append(data[unit_offset:unit_end].rstrip(b"\x00"))
    return tuple(NAL_units)


def remove_emulation_prevention_bytes(NAL_unit: bytes) -> bytes:
    """Returns the RBSP of a NAL unit by dropping each 0x03 that follows two zero input bytes."""

    output = bytearray()
    zero_count = 0
    for byte_value in NAL_unit:
        if zero_count >= 2 and byte_value == 3:
            zero_count = 0
            continue
        output.append(byte_value)
        zero_count = zero_count + 1 if byte_value == 0 else 0
    return bytes(output)


class BitReader:
    """Reads most-significant-bit-first fields and Exp-Golomb codes from an RBSP."""

    def __init__(self, data: bytes) -> None:
        self.bit_index = 0
        self.data = data

    def read_bits(self, bit_count: int) -> int:
        value = 0
        for _ in range(bit_count):
            byte_index = self.bit_index // 8
            if byte_index >= len(self.data):
                raise VectorGenerationError("H.264 RBSP ended unexpectedly")
            value = (value << 1) | ((self.data[byte_index] >> (7 - (self.bit_index % 8))) & 1)
            self.bit_index += 1
        return value

    def read_unsigned_exp_golomb(self) -> int:
        leading_zero_count = 0
        while self.read_bits(1) == 0:
            leading_zero_count += 1
            if leading_zero_count > MAXIMUM_EXP_GOLOMB_LEADING_ZERO_COUNT:
                raise VectorGenerationError("H.264 Exp-Golomb code is too long")
        return self.read_bits(leading_zero_count) + (1 << leading_zero_count) - 1


def get_NAL_unit_type(NAL_unit: bytes) -> int:
    """Returns the nal_unit_type of a NAL unit, reading an empty unit as type 0."""

    return NAL_unit[0] & NAL_UNIT_TYPE_MASK if NAL_unit else 0


def read_sequence_parameter_set_evidence(NAL_unit: bytes) -> SequenceParameterSetEvidence:
    """Returns the profile, constraint flags, level, chroma_format_idc, and bit depths of one SPS NAL unit."""

    RBSP = remove_emulation_prevention_bytes(NAL_unit[1:])
    reader = BitReader(RBSP)
    profile_IDC = reader.read_bits(8)
    constraint_flags = reader.read_bits(8)
    level_IDC = reader.read_bits(8)
    reader.read_unsigned_exp_golomb()  # seq_parameter_set_id
    chroma_format = 1
    bit_depth_luma = bit_depth_chroma = 8
    if profile_IDC in CHROMA_FORMAT_PROFILE_IDCS:
        chroma_format = reader.read_unsigned_exp_golomb()
        if chroma_format == CHROMA_FORMAT_444:
            reader.read_bits(1)  # separate_colour_plane_flag
        bit_depth_luma = 8 + reader.read_unsigned_exp_golomb()
        bit_depth_chroma = 8 + reader.read_unsigned_exp_golomb()
    return {
        "bitDepthChroma": bit_depth_chroma,
        "bitDepthLuma": bit_depth_luma,
        "chromaFormat": chroma_format,
        "constraintFlags": constraint_flags,
        "levelIDC": level_IDC,
        "profileIDC": profile_IDC,
    }


def get_sequence_parameter_set_evidence(data: bytes) -> SequenceParameterSetEvidence:
    """Returns the evidence of the first SPS of an Annex B stream."""

    for NAL_unit in find_NAL_units(data):
        if get_NAL_unit_type(NAL_unit) == SPS_NAL_UNIT_TYPE:
            return read_sequence_parameter_set_evidence(NAL_unit)
    raise VectorGenerationError("H.264 stream has no SPS")


def get_codec_string(evidence: SequenceParameterSetEvidence) -> str:
    """Returns the avc1.PPCCLL codec string of an SPS: its profile, constraint flags, and level in hexadecimal."""

    return f"avc1.{evidence['profileIDC']:02X}{evidence['constraintFlags']:02X}{evidence['levelIDC']:02X}"


def get_slice_types(data: bytes, access_unit_byte_lengths: Sequence[int]) -> list[str]:
    """Returns the slice_type of the first slice of every access unit, in decode order."""

    slice_types: list[str] = []
    byte_offset = 0
    for byte_length in access_unit_byte_lengths:
        access_unit = data[byte_offset : byte_offset + byte_length]
        byte_offset += byte_length
        slice_NAL_unit = next(
            (
                NAL_unit
                for NAL_unit in find_NAL_units(access_unit)
                if get_NAL_unit_type(NAL_unit) in (CODED_SLICE_NAL_UNIT_TYPE, IDR_SLICE_NAL_UNIT_TYPE)
            ),
            None,
        )
        if slice_NAL_unit is None:
            raise VectorGenerationError("H.264 access unit has no slice")
        reader = BitReader(remove_emulation_prevention_bytes(slice_NAL_unit[1:]))
        reader.read_unsigned_exp_golomb()  # first_mb_in_slice
        slice_types.append(SLICE_TYPE_NAMES[reader.read_unsigned_exp_golomb() % SLICE_TYPE_COUNT])
    if byte_offset != len(data):
        raise VectorGenerationError("H.264 access units do not cover the stream")
    return slice_types


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

    bytes_per_component = 2 if "10le" in pixel_format else 1
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


def get_decoded_fingerprints(input_path: Path, vector: H264RawFormatVector) -> list[int]:
    """Returns the fingerprint of every frame FFmpeg's H.264 decoder outputs in its own pixel format, in presentation order."""

    decoded_bytes = run_binary_command(
        "ffmpeg",
        (
            "-v",
            "error",
            "-f",
            ANNEX_B_STREAM_FORMAT,
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
    """Requires the pinned FFmpeg, libavcodec, FFprobe, and libx264 builds."""

    ffmpeg_version = run_text_command("ffmpeg", ("-version",)).standard_output
    if (
        not ffmpeg_version.startswith(f"ffmpeg version {REQUIRED_FFMPEG_VERSION}")
        or REQUIRED_LIBAVCODEC_VERSION_PATTERN.search(ffmpeg_version) is None
    ):
        raise VectorGenerationError("The installed FFmpeg/libavcodec is not the required version")
    ffprobe_version = run_text_command("ffprobe", ("-version",)).standard_output
    if not ffprobe_version.startswith(f"ffprobe version {REQUIRED_FFMPEG_VERSION}"):
        raise VectorGenerationError("The installed FFprobe is not the required version")

    # Without the SEI filter, the encode keeps libx264's version string
    version_probe_path = temporary_directory / "libx264-version.h264"
    run_text_command(
        "ffmpeg",
        (
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=size={CODED_WIDTH}x{CODED_HEIGHT}:rate=1:duration=1",
            "-frames:v",
            "1",
            "-c:v",
            "libx264",
            "-f",
            ANNEX_B_STREAM_FORMAT,
            "-y",
            str(version_probe_path),
        ),
    )
    if REQUIRED_X264_VERSION + b" " not in version_probe_path.read_bytes():
        raise VectorGenerationError("The installed libx264 is not the required version")


def get_vector_evidence(vector: H264RawFormatVector, generated_path: Path) -> VectorEvidence:
    """Generates the vector and returns its access units, codec string, fingerprints, picture types, SPS, and slice types."""

    generate_vector(vector, generated_path)
    generated_bytes = generated_path.read_bytes()
    access_unit_byte_lengths = get_access_unit_byte_lengths(generated_path)
    sequence_parameter_set = get_sequence_parameter_set_evidence(generated_bytes)
    # Dictionary values evaluate in order, so the tools run in the order the evidence lists them
    return {
        "accessUnitByteLengths": access_unit_byte_lengths,
        "codecString": get_codec_string(sequence_parameter_set),
        "decodedFingerprints": get_decoded_fingerprints(generated_path, vector),
        "pictureTypes": get_picture_types(generated_path),
        "sequenceParameterSet": sequence_parameter_set,
        "sliceTypes": get_slice_types(generated_bytes, access_unit_byte_lengths),
    }


def require_vector_evidence(vector: H264RawFormatVector, evidence: VectorEvidence) -> None:
    """Requires the measured evidence to match the vector table."""

    require_equal(
        evidence["accessUnitByteLengths"],
        vector.access_unit_byte_lengths,
        f"{vector.variant} access-unit lengths",
    )
    # Decode order I, P, B and presentation order I, B, P: the B access unit presents between the other two
    require_equal(evidence["sliceTypes"], ["I", "P", "B"], f"{vector.variant} slice types")
    require_equal(evidence["pictureTypes"], ["I", "B", "P"], f"{vector.variant} picture types")
    sequence_parameter_set = evidence["sequenceParameterSet"]
    require_equal(
        {
            "bitDepthChroma": sequence_parameter_set["bitDepthChroma"],
            "bitDepthLuma": sequence_parameter_set["bitDepthLuma"],
            "chromaFormat": sequence_parameter_set["chromaFormat"],
            "profileIDC": sequence_parameter_set["profileIDC"],
        },
        {
            "bitDepthChroma": vector.bit_depth,
            "bitDepthLuma": vector.bit_depth,
            "chromaFormat": vector.chroma_format,
            "profileIDC": vector.profile_IDC,
        },
        f"{vector.variant} sequence parameter set",
    )
    require_equal(evidence["codecString"], vector.codec_string, f"{vector.variant} codec string")
    require_equal(evidence["decodedFingerprints"], vector.expected_fingerprints, f"{vector.variant} decoded fingerprints")


def verify_vector(vector: H264RawFormatVector, generated_path: Path, *, check: bool) -> None:
    """Requires the expected structure, then writes the vector or compares it with the committed bytes."""

    require_vector_evidence(vector, get_vector_evidence(vector, generated_path))
    write_or_check_output(VECTOR_DIRECTORY / f"{vector.variant}.h264", generated_path.read_bytes(), check=check)


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
        with tempfile.TemporaryDirectory(prefix="webgpu-h264-raw-") as temporary_directory:
            temporary_path = Path(temporary_directory)
            check_toolchain(temporary_path)
            for vector in VECTORS:
                generated_path = temporary_path / f"{vector.variant}.h264"
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
    write_output_line(f"{action} {len(VECTORS)} deterministic H.264 raw-format vectors.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
