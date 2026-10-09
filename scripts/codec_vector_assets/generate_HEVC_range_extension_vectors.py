#!/usr/bin/env python3
"""Generate the deterministic HEVC range-extension capability vectors."""

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
from typing import Callable, Final, Sequence, TypedDict

from engine_layout import CODEC_VECTOR_ASSETS_DIRECTORY
from generated_output import GeneratedOutputError, write_or_check_output


VECTOR_DIRECTORY: Final = CODEC_VECTOR_ASSETS_DIRECTORY / "hevc-range-extension"
REQUIRED_FFMPEG_VERSION: Final = "2026-03-01-git-862338fe31-full_build-www.gyan.dev"
REQUIRED_LIBAVCODEC_VERSION_PATTERN: Final = re.compile(r"libavcodec\s+62\.\s*24\.100")
REQUIRED_X265_VERSION: Final = "4.1+225-1b48507eb"
CODED_WIDTH: Final = 192
CODED_HEIGHT: Final = 192
FRAME_RATE: Final = 1
FNV1A_OFFSET_BASIS: Final = 2_166_136_261
FNV1A_PRIME: Final = 16_777_619
# Masking each product to 32 bits reproduces JavaScript's Math.imul(...) >>> 0
UINT32_MASK: Final = 0xFFFF_FFFF
FINGERPRINT_COLUMN_SAMPLE_COUNT: Final = 64
FINGERPRINT_ROW_SAMPLE_COUNT: Final = 36
LITTLE_ENDIAN_UINT16: Final = struct.Struct("<H")
# No level-idc: with CRF, x265 enforces a level through VBV, which it reports as non-deterministic.
# generate_vector writes the level into the VPS and SPS instead
GENERAL_X265_PARAMETERS: Final = (
    "info=0",
    "pools=none",
    "frame-threads=1",
    "wpp=0",
    "log-level=error",
)
INTER_X265_PARAMETERS: Final = (
    "keyint=30",
    "min-keyint=30",
    "scenecut=0",
    "bframes=0",
    "repeat-headers=1",
)
NAL_HEADER_BYTE_LENGTH: Final = 2
VPS_NAL_UNIT_TYPE: Final = 32
SPS_NAL_UNIT_TYPE: Final = 33
# Where general_profile_tier_level starts in each parameter set, counting the NAL header
VPS_PROFILE_TIER_LEVEL_OFFSET: Final = 6
SPS_PROFILE_TIER_LEVEL_OFFSET: Final = 3
# Offsets from the start of general_profile_tier_level
COMPATIBILITY_FLAGS_OFFSET: Final = 1
CONSTRAINT_FLAGS_OFFSET: Final = 5
# The profile byte, the four compatibility-flag bytes, and the six constraint-flag bytes
PROFILE_TIER_LEVEL_PREFIX_BYTE_LENGTH: Final = 11
# general_level_idc follows that prefix
GENERAL_LEVEL_IDC_OFFSET: Final = PROFILE_TIER_LEVEL_PREFIX_BYTE_LENGTH
# general_level_idc is thirty times the level number, and Level 3.1 is what the vectors signal
LEVEL_3_1_IDC: Final = 93
PROFILE_IDC_MASK: Final = 0x1F
INTRA_CONSTRAINT_FLAG: Final = 0x20
ONE_PICTURE_ONLY_CONSTRAINT_FLAG: Final = 0x10
RANGE_EXTENSION_PROFILE_IDC: Final = 4
# Only general_profile_compatibility_flag[4] is set
RANGE_EXTENSION_COMPATIBILITY_FLAGS: Final = bytes((0x08, 0x00, 0x00, 0x00))


class VectorGenerationError(RuntimeError):
    """Reports a deterministic vector generation or verification failure."""


@dataclass(frozen=True)
class RangeExtensionVector:
    """Describes one committed vector, its x265 encode, and the evidence it must produce."""

    access_unit_byte_lengths: tuple[int, ...]
    constraint_prefix: str
    expected_fingerprints: tuple[int, ...]
    frame_count: int
    intra_constrained: bool
    pixel_format: str
    profile: str
    variant: str
    # x265 cannot signal profile IDC 4 for 4:2:0 at 8 or 10 bits, so those encodes are rewritten
    patch_profile_tier_level: bool = False


@dataclass(frozen=True)
class AnnexBStartCode:
    """Locates one Annex B start code."""

    byte_length: int
    byte_offset: int

    @property
    def NAL_unit_offset(self) -> int:
        return self.byte_offset + self.byte_length


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


class ProfileTierLevelEvidence(TypedDict):
    """The general profile-tier-level fields of one parameter set, keyed as --inspect prints them."""

    compatibilityFlags: str
    constraintPrefix: str
    intraConstrained: bool
    onePictureOnly: bool
    profileIDC: int


class ParameterSetEvidence(TypedDict):
    """The profile-tier-level evidence of the first SPS and VPS."""

    SPS: ProfileTierLevelEvidence
    VPS: ProfileTierLevelEvidence


class VectorEvidence(TypedDict):
    """The measured structure of one generated vector, keyed and ordered as --inspect prints it."""

    accessUnitByteLengths: list[int]
    decodedFingerprints: list[int]
    pictureTypes: list[str]
    PTL: ParameterSetEvidence


VECTORS: Final = (
    RangeExtensionVector(
        access_unit_byte_lengths=(3_452, 2_905),
        constraint_prefix="9F.88",
        expected_fingerprints=(3_329_959_031, 201_088_281),
        frame_count=2,
        intra_constrained=False,
        patch_profile_tier_level=True,
        pixel_format="yuv420p",
        profile="main",
        variant="rext420-8",
    ),
    RangeExtensionVector(
        access_unit_byte_lengths=(4_148, 3_582),
        constraint_prefix="9D.08",
        expected_fingerprints=(1_183_394_674, 2_295_522_323),
        frame_count=2,
        intra_constrained=False,
        pixel_format="yuv422p",
        profile="main422-10",
        variant="main422-8",
    ),
    RangeExtensionVector(
        access_unit_byte_lengths=(3_515, 2_872),
        constraint_prefix="9E.08",
        expected_fingerprints=(1_821_287_005, 2_492_293_762),
        frame_count=2,
        intra_constrained=False,
        pixel_format="yuv444p",
        profile="main444-8",
        variant="main444-8",
    ),
    RangeExtensionVector(
        access_unit_byte_lengths=(3_451, 3_011),
        constraint_prefix="9D.88",
        expected_fingerprints=(913_148_567, 991_175_167),
        frame_count=2,
        intra_constrained=False,
        patch_profile_tier_level=True,
        pixel_format="yuv420p10le",
        profile="main10",
        variant="rext420-10",
    ),
    RangeExtensionVector(
        access_unit_byte_lengths=(4_181, 3_655),
        constraint_prefix="9D.08",
        expected_fingerprints=(164_386_383, 4_284_346_653),
        frame_count=2,
        intra_constrained=False,
        pixel_format="yuv422p10le",
        profile="main422-10",
        variant="main422-10",
    ),
    RangeExtensionVector(
        access_unit_byte_lengths=(3_519, 2_871),
        constraint_prefix="9C.08",
        expected_fingerprints=(3_798_930_489, 1_052_002_504),
        frame_count=2,
        intra_constrained=False,
        pixel_format="yuv444p10le",
        profile="main444-10",
        variant="main444-10",
    ),
    RangeExtensionVector(
        access_unit_byte_lengths=(3_442, 3_013),
        constraint_prefix="99.88",
        expected_fingerprints=(1_429_287_902, 2_430_170_723),
        frame_count=2,
        intra_constrained=False,
        pixel_format="yuv420p12le",
        profile="main12",
        variant="main12-420",
    ),
    RangeExtensionVector(
        access_unit_byte_lengths=(4_140, 3_642),
        constraint_prefix="99.08",
        expected_fingerprints=(2_481_109_241, 654_435_566),
        frame_count=2,
        intra_constrained=False,
        pixel_format="yuv422p12le",
        profile="main422-12",
        variant="main422-12",
    ),
    RangeExtensionVector(
        access_unit_byte_lengths=(3_514, 2_887),
        constraint_prefix="98.08",
        expected_fingerprints=(3_231_491_211, 339_020_665),
        frame_count=2,
        intra_constrained=False,
        pixel_format="yuv444p12le",
        profile="main444-12",
        variant="main444-12",
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


def get_x265_parameters(vector: RangeExtensionVector) -> str:
    """Returns the -x265-params value: intra-only for one frame, otherwise one fixed inter GOP."""

    frame_parameters = ("keyint=1",) if vector.frame_count == 1 else INTER_X265_PARAMETERS
    return ":".join((*GENERAL_X265_PARAMETERS, *frame_parameters))


def generate_vector(vector: RangeExtensionVector, output_path: Path) -> None:
    """Encodes the vector with x265, writes Level 3.1 into its VPS and SPS, and rewrites its profile when required."""

    run_text_command(
        "ffmpeg",
        (
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size={CODED_WIDTH}x{CODED_HEIGHT}:rate={FRAME_RATE}:duration={vector.frame_count}",
            "-frames:v",
            str(vector.frame_count),
            "-pix_fmt",
            vector.pixel_format,
            "-c:v",
            "libx265",
            "-profile:v",
            vector.profile,
            "-preset",
            "fast",
            "-crf",
            "32",
            "-x265-params",
            get_x265_parameters(vector),
            "-f",
            "hevc",
            "-y",
            str(output_path),
        ),
    )
    vector_bytes = set_general_level_IDC(output_path.read_bytes(), LEVEL_3_1_IDC)
    if vector.patch_profile_tier_level:
        vector_bytes = patch_profile_tier_level_to_range_extension(vector_bytes, vector.constraint_prefix)
    output_path.write_bytes(vector_bytes)


def split_output_lines(output: str) -> list[str]:
    """Returns the trimmed output split at CRLF or LF, which leaves one empty line for empty output."""

    return re.split(r"\r?\n", output.strip())


def get_packet_byte_lengths(input_path: Path) -> list[int]:
    """Returns the byte length of every video packet FFprobe reads from the vector."""

    result = run_text_command(
        "ffprobe",
        (
            "-v",
            "error",
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
    """Returns the picture type FFprobe reports for every decoded frame."""

    result = run_text_command(
        "ffprobe",
        (
            "-v",
            "error",
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


def remove_emulation_prevention_bytes(NAL_unit: bytes) -> bytes:
    """Returns the RBSP of a NAL unit by dropping each 0x03 that follows two zero input bytes."""

    output = bytearray()
    for byte_index, byte_value in enumerate(NAL_unit):
        if (
            byte_index >= 2
            and byte_value == 3
            and NAL_unit[byte_index - 1] == 0
            and NAL_unit[byte_index - 2] == 0
        ):
            continue
        output.append(byte_value)
    return bytes(output)


def add_emulation_prevention_bytes(RBSP: bytes | bytearray) -> bytes:
    """Returns the NAL unit for an RBSP that starts with its two-byte NAL header, which is never escaped."""

    # A header shorter than two bytes is zero-padded
    output = bytearray(RBSP[:NAL_HEADER_BYTE_LENGTH]).ljust(NAL_HEADER_BYTE_LENGTH, b"\x00")
    consecutive_zero_count = 0
    for byte_value in RBSP[NAL_HEADER_BYTE_LENGTH:]:
        if consecutive_zero_count >= 2 and byte_value <= 3:
            output.append(3)
            consecutive_zero_count = 0
        output.append(byte_value)
        consecutive_zero_count = consecutive_zero_count + 1 if byte_value == 0 else 0
    return bytes(output)


def find_annex_B_start_codes(data: bytes) -> tuple[AnnexBStartCode, ...]:
    """Returns the 3- and 4-byte Annex B start codes at offsets followed by at least three more bytes."""

    start_codes: list[AnnexBStartCode] = []
    byte_index = 0
    while byte_index + 3 < len(data):
        if data[byte_index] != 0 or data[byte_index + 1] != 0:
            byte_index += 1
            continue
        match data[byte_index + 2]:
            case 1:
                start_codes.append(AnnexBStartCode(byte_length=3, byte_offset=byte_index))
                byte_index += 3
            case 0 if data[byte_index + 3] == 1:
                start_codes.append(AnnexBStartCode(byte_length=4, byte_offset=byte_index))
                byte_index += 4
            case _:
                byte_index += 1
    return tuple(start_codes)


def get_NAL_unit_type(data: bytes, NAL_unit_offset: int) -> int:
    """Returns the NAL unit type at the offset, reading a header past the end as type 0."""

    if NAL_unit_offset >= len(data):
        return 0
    return (data[NAL_unit_offset] >> 1) & 0x3F


def get_NAL_unit_end_offset(
    data: bytes,
    start_codes: Sequence[AnnexBStartCode],
    unit_index: int,
) -> int:
    """Returns where one NAL unit ends: at the next start code, or at the end of the data."""

    if unit_index + 1 < len(start_codes):
        return start_codes[unit_index + 1].byte_offset
    return len(data)


def get_profile_tier_level_offset(NAL_unit_type: int) -> int:
    """Returns the general_profile_tier_level offset of a VPS, and otherwise of an SPS."""

    if NAL_unit_type == VPS_NAL_UNIT_TYPE:
        return VPS_PROFILE_TIER_LEVEL_OFFSET
    return SPS_PROFILE_TIER_LEVEL_OFFSET


def rewrite_parameter_sets(
    data: bytes,
    required_byte_length: int,
    rewrite_profile_tier_level: Callable[[bytearray, int], None],
) -> bytes:
    """Returns the stream with its one VPS and one SPS rewritten through their unescaped RBSPs.

    The rewrite receives each RBSP and the offset of its general_profile_tier_level, which must be followed by required_byte_length bytes.
    Every other NAL unit is copied unchanged.
    """

    start_codes = find_annex_B_start_codes(data)
    if not start_codes or start_codes[0].byte_offset != 0:
        raise VectorGenerationError("Generated vector is not Annex B HEVC")
    output_parts: list[bytes] = []
    patched_VPS_count = 0
    patched_SPS_count = 0
    for unit_index, start_code in enumerate(start_codes):
        NAL_unit = data[start_code.NAL_unit_offset : get_NAL_unit_end_offset(data, start_codes, unit_index)]
        NAL_unit_type = get_NAL_unit_type(NAL_unit, 0)
        output_parts.append(data[start_code.byte_offset : start_code.NAL_unit_offset])
        if NAL_unit_type not in (VPS_NAL_UNIT_TYPE, SPS_NAL_UNIT_TYPE):
            output_parts.append(NAL_unit)
            continue

        RBSP = bytearray(remove_emulation_prevention_bytes(NAL_unit))
        profile_tier_level_offset = get_profile_tier_level_offset(NAL_unit_type)
        if len(RBSP) < profile_tier_level_offset + required_byte_length:
            raise VectorGenerationError("Generated VPS/SPS is too short to patch profile-tier-level")
        rewrite_profile_tier_level(RBSP, profile_tier_level_offset)
        output_parts.append(add_emulation_prevention_bytes(RBSP))
        if NAL_unit_type == VPS_NAL_UNIT_TYPE:
            patched_VPS_count += 1
        else:
            patched_SPS_count += 1
    if patched_VPS_count != 1 or patched_SPS_count != 1:
        raise VectorGenerationError(f"Expected one VPS/SPS, patched {patched_VPS_count}/{patched_SPS_count}")
    return b"".join(output_parts)


def patch_profile_tier_level_to_range_extension(data: bytes, constraint_prefix: str) -> bytes:
    """Returns the stream with its VPS and SPS rewritten to profile IDC 4 and the given constraint bytes."""

    constraint_bytes = [int(value, 16) for value in constraint_prefix.split(".")]

    def rewrite_profile(RBSP: bytearray, profile_tier_level_offset: int) -> None:
        constraint_flags_offset = profile_tier_level_offset + CONSTRAINT_FLAGS_OFFSET
        constraint_flags_end_offset = profile_tier_level_offset + PROFILE_TIER_LEVEL_PREFIX_BYTE_LENGTH
        # Profile space 0 and Main tier, then compatibility flag 4 and the constraint bytes
        RBSP[profile_tier_level_offset] = RANGE_EXTENSION_PROFILE_IDC
        RBSP[profile_tier_level_offset + COMPATIBILITY_FLAGS_OFFSET : constraint_flags_offset] = (
            RANGE_EXTENSION_COMPATIBILITY_FLAGS
        )
        RBSP[constraint_flags_offset:constraint_flags_end_offset] = bytes((constraint_bytes[0], constraint_bytes[1], 0, 0, 0, 0))

    return rewrite_parameter_sets(data, PROFILE_TIER_LEVEL_PREFIX_BYTE_LENGTH, rewrite_profile)


def set_general_level_IDC(data: bytes, level_IDC: int) -> bytes:
    """Returns the stream with the general_level_idc of its VPS and SPS set to level_IDC."""

    def rewrite_level(RBSP: bytearray, profile_tier_level_offset: int) -> None:
        RBSP[profile_tier_level_offset + GENERAL_LEVEL_IDC_OFFSET] = level_IDC

    return rewrite_parameter_sets(data, GENERAL_LEVEL_IDC_OFFSET + 1, rewrite_level)


def get_profile_tier_level_evidence(data: bytes, expected_NAL_unit_type: int) -> ProfileTierLevelEvidence:
    """Returns the general profile-tier-level fields of the first NAL unit of the expected type."""

    start_codes = find_annex_B_start_codes(data)
    unit_index = next(
        (
            candidate_index
            for candidate_index, start_code in enumerate(start_codes)
            if get_NAL_unit_type(data, start_code.NAL_unit_offset) == expected_NAL_unit_type
        ),
        None,
    )
    if unit_index is None:
        raise VectorGenerationError(f"Vector has no NAL unit type {expected_NAL_unit_type}")
    NAL_unit = data[start_codes[unit_index].NAL_unit_offset : get_NAL_unit_end_offset(data, start_codes, unit_index)]
    RBSP = remove_emulation_prevention_bytes(NAL_unit)
    profile_tier_level_offset = get_profile_tier_level_offset(expected_NAL_unit_type)
    constraint_flags_offset = profile_tier_level_offset + CONSTRAINT_FLAGS_OFFSET
    if len(RBSP) < profile_tier_level_offset + PROFILE_TIER_LEVEL_PREFIX_BYTE_LENGTH:
        raise VectorGenerationError("Vector parameter set is too short for profile-tier-level constraints")
    compatibility_flags = RBSP[profile_tier_level_offset + COMPATIBILITY_FLAGS_OFFSET : constraint_flags_offset]
    first_constraint_byte = RBSP[constraint_flags_offset]
    second_constraint_byte = RBSP[constraint_flags_offset + 1]
    return {
        "compatibilityFlags": compatibility_flags.hex().upper(),
        "constraintPrefix": f"{first_constraint_byte:02X}.{second_constraint_byte:02X}",
        "intraConstrained": (second_constraint_byte & INTRA_CONSTRAINT_FLAG) != 0,
        "onePictureOnly": (second_constraint_byte & ONE_PICTURE_ONLY_CONSTRAINT_FLAG) != 0,
        "profileIDC": RBSP[profile_tier_level_offset] & PROFILE_IDC_MASK,
    }


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


def get_decoded_fingerprints(input_path: Path, vector: RangeExtensionVector) -> list[int]:
    """Returns the fingerprint of every frame FFmpeg decodes from the vector in its own pixel format."""

    decoded_bytes = run_binary_command(
        "ffmpeg",
        (
            "-v",
            "error",
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
    if len(decoded_bytes) != geometry.frame_byte_length * vector.frame_count:
        raise VectorGenerationError(f"{vector.variant} decoded raw byte length is unexpected")
    fingerprints: list[int] = []
    for frame_index in range(vector.frame_count):
        byte_offset = frame_index * geometry.frame_byte_length
        frame = decoded_bytes[byte_offset : byte_offset + geometry.frame_byte_length]
        fingerprints.append(create_frame_fingerprint(frame, geometry))
    return fingerprints


def check_toolchain(temporary_directory: Path) -> None:
    """Requires the pinned FFmpeg, libavcodec, FFprobe, and x265 builds."""

    ffmpeg_version = run_text_command("ffmpeg", ("-version",)).standard_output
    if (
        not ffmpeg_version.startswith(f"ffmpeg version {REQUIRED_FFMPEG_VERSION}")
        or REQUIRED_LIBAVCODEC_VERSION_PATTERN.search(ffmpeg_version) is None
    ):
        raise VectorGenerationError("The installed FFmpeg/libavcodec is not the required version")
    ffprobe_version = run_text_command("ffprobe", ("-version",)).standard_output
    if not ffprobe_version.startswith(f"ffprobe version {REQUIRED_FFMPEG_VERSION}"):
        raise VectorGenerationError("The installed FFprobe is not the required version")

    x265_probe_path = temporary_directory / "x265-version.hevc"
    result = run_text_command(
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
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx265",
            "-profile:v",
            "main444-8",
            "-x265-params",
            "info=0:pools=none:frame-threads=1:wpp=0:log-level=info:keyint=1",
            "-f",
            "hevc",
            "-y",
            str(x265_probe_path),
        ),
    )
    if f"HEVC encoder version {REQUIRED_X265_VERSION}" not in result.standard_error:
        raise VectorGenerationError("The installed x265 is not the required version")


def get_vector_evidence(vector: RangeExtensionVector, generated_path: Path) -> VectorEvidence:
    """Generates the vector and returns its access units, fingerprints, picture types, and PTL fields."""

    generate_vector(vector, generated_path)
    generated_bytes = generated_path.read_bytes()
    # Dictionary values evaluate in order, so the tools run in the order the evidence lists them
    return {
        "accessUnitByteLengths": get_packet_byte_lengths(generated_path),
        "decodedFingerprints": get_decoded_fingerprints(generated_path, vector),
        "pictureTypes": get_picture_types(generated_path),
        "PTL": {
            "SPS": get_profile_tier_level_evidence(generated_bytes, SPS_NAL_UNIT_TYPE),
            "VPS": get_profile_tier_level_evidence(generated_bytes, VPS_NAL_UNIT_TYPE),
        },
    }


def require_vector_evidence(vector: RangeExtensionVector, evidence: VectorEvidence) -> None:
    """Requires the measured evidence to match the vector table."""

    require_equal(evidence["accessUnitByteLengths"], vector.access_unit_byte_lengths, f"{vector.variant} access-unit lengths")
    require_equal(evidence["pictureTypes"], ["I"] if vector.frame_count == 1 else ["I", "P"], f"{vector.variant} picture types")
    PTL_evidence = evidence["PTL"]["VPS"]
    require_equal(evidence["PTL"]["SPS"], PTL_evidence, f"{vector.variant} VPS/SPS PTL")
    require_equal(PTL_evidence["profileIDC"], RANGE_EXTENSION_PROFILE_IDC, f"{vector.variant} profile IDC")
    require_equal(
        PTL_evidence["compatibilityFlags"],
        RANGE_EXTENSION_COMPATIBILITY_FLAGS.hex().upper(),
        f"{vector.variant} compatibility flags",
    )
    require_equal(PTL_evidence["constraintPrefix"], vector.constraint_prefix, f"{vector.variant} PTL")
    require_equal(PTL_evidence["intraConstrained"], vector.intra_constrained, f"{vector.variant} intra constraint")
    require_equal(PTL_evidence["onePictureOnly"], False, f"{vector.variant} one-picture constraint")
    require_equal(evidence["decodedFingerprints"], vector.expected_fingerprints, f"{vector.variant} decoded fingerprints")


def verify_vector(vector: RangeExtensionVector, generated_path: Path, *, check: bool) -> None:
    """Requires the expected structure, then writes the vector or compares it with the committed bytes."""

    require_vector_evidence(vector, get_vector_evidence(vector, generated_path))
    write_or_check_output(VECTOR_DIRECTORY / f"{vector.variant}.hevc", generated_path.read_bytes(), check=check)


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
        with tempfile.TemporaryDirectory(prefix="webgpu-hevc-rext-") as temporary_directory:
            temporary_path = Path(temporary_directory)
            check_toolchain(temporary_path)
            for vector in VECTORS:
                generated_path = temporary_path / f"{vector.variant}.hevc"
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
    write_output_line(f"{action} {len(VECTORS)} deterministic HEVC range-extension vectors.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
