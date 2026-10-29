"""Tests the H.264 raw-format vector generator without running FFmpeg."""

from __future__ import annotations

import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Sequence, cast
from unittest.mock import patch


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import generate_H264_raw_format_vectors as generator  # noqa: E402


# Saved before any test replaces generator.VECTOR_DIRECTORY
COMMITTED_VECTOR_DIRECTORY = generator.VECTOR_DIRECTORY
START_CODE = b"\x00\x00\x01"
PPS_NAL_UNIT_TYPE = 8
SEI_NAL_UNIT_TYPE = 6
# nal_ref_idc 3 headers, except the non-reference B slice
SPS_NAL_HEADER = 0x67
PPS_NAL_HEADER = 0x68
IDR_SLICE_NAL_HEADER = 0x65
REFERENCE_SLICE_NAL_HEADER = 0x41
NON_REFERENCE_SLICE_NAL_HEADER = 0x01
# The first line --inspect prints
HIGH_420_10_BIT_INSPECT_LINE = (
    '{"accessUnitByteLengths":[3644,2367,2424],"codecString":"avc1.6E000B",'
    '"decodedFingerprints":[3372277727,4248514697,2206859063],"pictureTypes":["I","B","P"],'
    '"sequenceParameterSet":{"bitDepthChroma":10,"bitDepthLuma":10,"chromaFormat":1,"constraintFlags":0,'
    '"levelIDC":11,"profileIDC":110},"sliceTypes":["I","P","B"],"variant":"high420-10"}'
)
FFMPEG_VERSION_OUTPUT = (
    "ffmpeg version 2026-03-01-git-862338fe31-full_build-www.gyan.dev "
    "Copyright (c) 2000-2026 the FFmpeg developers\n"
    "libavutil      60. 25.100 / 60. 25.100\n"
    "libavcodec     62. 24.100 / 62. 24.100\n"
)
FFPROBE_VERSION_OUTPUT = (
    "ffprobe version 2026-03-01-git-862338fe31-full_build-www.gyan.dev "
    "Copyright (c) 2007-2026 the FFmpeg developers\n"
)
# The start of the user data SEI libx264 writes into its first access unit
LIBX264_PROBE_BYTES = (
    b"\x00\x00\x00\x01\x67\x64\x00\x0A\x00\x00\x01\x06\x05\x2E"
    + bytes(16)
    + b"x264 - core 165 r3223 0480cb0 - H.264/MPEG-4 AVC codec - Copyleft 2003-2025\x00\x80"
)

BitField = tuple[int, int]


def pack_bit_fields(fields: Sequence[BitField]) -> bytes:
    """Packs (value, bit count) fields most significant bit first, and pads the last byte with zero bits."""

    value = 0
    bit_count = 0
    for field_value, field_bit_count in fields:
        value = (value << field_bit_count) | field_value
        bit_count += field_bit_count
    padding_bit_count = (-bit_count) % 8
    return (value << padding_bit_count).to_bytes((bit_count + padding_bit_count) // 8, "big")


def unsigned_exp_golomb(value: int) -> BitField:
    """Returns the ue(v) code of a value as one field: leading zeros, then value + 1 in binary."""

    code_number = value + 1
    return (code_number, (2 * code_number.bit_length()) - 1)


def add_emulation_prevention_bytes(RBSP: bytes) -> bytes:
    """Returns the NAL unit payload of an RBSP, a 0x03 inserted wherever two zero bytes precede a byte of 3 or less."""

    output = bytearray()
    zero_count = 0
    for byte_value in RBSP:
        if zero_count >= 2 and byte_value <= 3:
            output.append(3)
            zero_count = 0
        output.append(byte_value)
        zero_count = zero_count + 1 if byte_value == 0 else 0
    return bytes(output)


def create_NAL_unit(header: int, fields: Sequence[BitField]) -> bytes:
    """Returns a NAL unit of the fields, closed by rbsp_trailing_bits and escaped with emulation prevention."""

    return bytes((header,)) + add_emulation_prevention_bytes(pack_bit_fields((*fields, (1, 1))))


def create_slice_NAL_unit(header: int, slice_type: int) -> bytes:
    """Returns a slice NAL unit whose header starts with first_mb_in_slice 0 and the slice_type."""

    return create_NAL_unit(header, (unsigned_exp_golomb(0), unsigned_exp_golomb(slice_type), (0x5A, 8)))


def create_access_unit(*NAL_units: bytes) -> bytes:
    """Returns the NAL units in Annex B form, the first after a four-byte start code as libx264 writes it."""

    return b"\x00" + b"".join(START_CODE + NAL_unit for NAL_unit in NAL_units)


def create_pattern_frame(byte_length: int) -> bytes:
    """Returns the byte pattern the HEVC generator's reference fingerprints were computed from with the Node generator."""

    return bytes((byte_index * 31 + 7) & 0xFF for byte_index in range(byte_length))


def read_committed_vector(vector: generator.H264RawFormatVector) -> bytes:
    """Returns the committed bytes of one vector."""

    return (COMMITTED_VECTOR_DIRECTORY / f"{vector.variant}.h264").read_bytes()


def split_access_units(data: bytes, access_unit_byte_lengths: Sequence[int]) -> list[bytes]:
    """Returns the stream cut at the access-unit lengths, in decode order."""

    access_units: list[bytes] = []
    byte_offset = 0
    for byte_length in access_unit_byte_lengths:
        access_units.append(data[byte_offset : byte_offset + byte_length])
        byte_offset += byte_length
    return access_units


def create_matching_evidence(vector: generator.H264RawFormatVector) -> generator.VectorEvidence:
    """Returns evidence that satisfies every requirement for the vector."""

    return {
        "accessUnitByteLengths": list(vector.access_unit_byte_lengths),
        "codecString": vector.codec_string,
        "decodedFingerprints": list(vector.expected_fingerprints),
        "pictureTypes": ["I", "B", "P"],
        "sequenceParameterSet": {
            "bitDepthChroma": vector.bit_depth,
            "bitDepthLuma": vector.bit_depth,
            "chromaFormat": vector.chroma_format,
            "constraintFlags": 0,
            "levelIDC": 11,
            "profileIDC": vector.profile_IDC,
        },
        "sliceTypes": ["I", "P", "B"],
    }


class NALParsingTests(unittest.TestCase):
    """Covers Annex B splitting, emulation prevention, and the bit reader."""

    def test_splits_at_three_and_four_byte_start_codes(self) -> None:
        cases = (
            (b"\x00\x00\x01\x09\xF0", (b"\x09\xF0",)),
            (b"\x00\x00\x00\x01\x67\xAA\x00\x00\x01\x68\xBB", (b"\x67\xAA", b"\x68\xBB")),
            # Bytes before the first start code belong to no NAL unit
            (b"\xFF\x00\x00\x01\x41\x9A", (b"\x41\x9A",)),
            # Trailing zero bytes, at the end or before the next start code, are dropped
            (b"\x00\x00\x01\x67\x01\x00\x00\x00\x00\x01\x68\x02\x00\x00", (b"\x67\x01", b"\x68\x02")),
            # An escaped 00 00 03 is not a start code
            (b"\x00\x00\x01\x65\x00\x00\x03\x01", (b"\x65\x00\x00\x03\x01",)),
            (b"\x00\x00\x01", (b"",)),
        )
        for data, NAL_units in cases:
            with self.subTest(data=data.hex()):
                self.assertEqual(generator.find_NAL_units(data), NAL_units)

    def test_rejects_a_stream_without_a_start_code(self) -> None:
        for data in (b"", b"\x00\x00", b"\x00\x00\x02\x67", b"\x67\x64\x00\x0B"):
            with self.subTest(data=data.hex()):
                with self.assertRaises(generator.VectorGenerationError) as raised:
                    generator.find_NAL_units(data)
                self.assertEqual(str(raised.exception), "H.264 stream has no Annex B start code")

    def test_reads_the_NAL_unit_type(self) -> None:
        cases = ((b"\x67\x64", 7), (b"\x68", 8), (b"\x65", 5), (b"\x41", 1), (b"\x01", 1), (b"\x06", 6), (b"", 0))
        for NAL_unit, NAL_unit_type in cases:
            with self.subTest(NAL_unit=NAL_unit.hex()):
                self.assertEqual(generator.get_NAL_unit_type(NAL_unit), NAL_unit_type)

    def test_removes_emulation_prevention_bytes(self) -> None:
        cases = (
            (b"\x00\x00\x03\x01", b"\x00\x00\x01"),
            (b"\x00\x00\x03\x00\x00\x03\x03", b"\x00\x00\x00\x00\x03"),
            (b"\x00\x00\x00\x03\x02", b"\x00\x00\x00\x02"),
            # One zero byte does not escape the next 3, and a removed 3 restarts the zero count
            (b"\x00\x03\x00", b"\x00\x03\x00"),
            (b"\x00\x00\x03\x03", b"\x00\x00\x03"),
            (b"\x00\x00\x03", b"\x00\x00"),
            (b"\x12\x34", b"\x12\x34"),
        )
        for NAL_unit, RBSP in cases:
            with self.subTest(NAL_unit=NAL_unit.hex()):
                self.assertEqual(generator.remove_emulation_prevention_bytes(NAL_unit), RBSP)

    def test_reads_bits_most_significant_first(self) -> None:
        reader = generator.BitReader(b"\xA5\x0F")
        self.assertEqual(reader.read_bits(4), 0xA)
        self.assertEqual(reader.read_bits(6), 0x14)
        self.assertEqual(reader.read_bits(0), 0)
        self.assertEqual(reader.read_bits(6), 0x0F)
        with self.assertRaises(generator.VectorGenerationError) as raised:
            reader.read_bits(1)
        self.assertEqual(str(raised.exception), "H.264 RBSP ended unexpectedly")

    def test_reads_unsigned_exp_golomb_codes(self) -> None:
        for value in (0, 1, 2, 3, 6, 7, 63, 255, 0xFFFF_FFFE):
            with self.subTest(value=value):
                reader = generator.BitReader(pack_bit_fields((unsigned_exp_golomb(value), (1, 1))))
                self.assertEqual(reader.read_unsigned_exp_golomb(), value)
                self.assertEqual(reader.read_bits(1), 1)
        # Consecutive codes 1, 010, 011, 00100
        reader = generator.BitReader(b"\xA6\x40")
        self.assertEqual([reader.read_unsigned_exp_golomb() for _ in range(4)], [0, 1, 2, 3])

    def test_rejects_too_long_and_truncated_exp_golomb_codes(self) -> None:
        cases = (
            # The 32nd leading zero exceeds a 32-bit value
            (bytes(4) + b"\x80", "H.264 Exp-Golomb code is too long"),
            (b"\x00", "H.264 RBSP ended unexpectedly"),
            # Seven leading zeros and the one end the data before the seven-bit suffix
            (b"\x01", "H.264 RBSP ended unexpectedly"),
        )
        for data, message in cases:
            with self.subTest(data=data.hex()):
                reader = generator.BitReader(data)
                with self.assertRaises(generator.VectorGenerationError) as raised:
                    reader.read_unsigned_exp_golomb()
                self.assertEqual(str(raised.exception), message)


class SequenceParameterSetTests(unittest.TestCase):
    """Covers the profile, constraint, level, chroma, and depth fields of an SPS and its codec string."""

    def evidence(
        self,
        profile_IDC: int,
        constraint_flags: int,
        level_IDC: int,
        chroma_format: int,
        bit_depth_luma: int,
        bit_depth_chroma: int,
    ) -> generator.SequenceParameterSetEvidence:
        return {
            "bitDepthChroma": bit_depth_chroma,
            "bitDepthLuma": bit_depth_luma,
            "chromaFormat": chroma_format,
            "constraintFlags": constraint_flags,
            "levelIDC": level_IDC,
            "profileIDC": profile_IDC,
        }

    def test_skips_separate_colour_plane_flag_for_chroma_format_3(self) -> None:
        for separate_colour_plane_flag in (0, 1):
            with self.subTest(separate_colour_plane_flag=separate_colour_plane_flag):
                SPS = create_NAL_unit(
                    SPS_NAL_HEADER,
                    (
                        (244, 8),
                        (0, 8),
                        (11, 8),
                        unsigned_exp_golomb(0),
                        unsigned_exp_golomb(3),
                        (separate_colour_plane_flag, 1),
                        # Distinct luma and chroma depths show the order they are read in
                        unsigned_exp_golomb(2),
                        unsigned_exp_golomb(0),
                        (0, 1),
                    ),
                )
                evidence = generator.read_sequence_parameter_set_evidence(SPS)
                self.assertEqual(evidence, self.evidence(244, 0, 11, 3, 10, 8))
                self.assertEqual(generator.get_codec_string(evidence), "avc1.F4000B")

    def test_reads_chroma_and_depth_of_High_profiles_through_emulation_prevention(self) -> None:
        # profile_idc 100 with zero constraint flags and level, then seq_parameter_set_id 63, whose first byte is 0x02
        fields = (
            (100, 8),
            (0, 8),
            (0, 8),
            unsigned_exp_golomb(63),
            unsigned_exp_golomb(2),
            unsigned_exp_golomb(1),
            unsigned_exp_golomb(1),
        )
        SPS = create_NAL_unit(SPS_NAL_HEADER, fields)
        self.assertEqual(SPS[:6], b"\x67\x64\x00\x00\x03\x02")
        evidence = generator.read_sequence_parameter_set_evidence(SPS)
        self.assertEqual(evidence, self.evidence(100, 0, 0, 2, 9, 9))
        self.assertEqual(generator.get_codec_string(evidence), "avc1.640000")

    def test_reads_every_chroma_format_of_the_vector_profiles(self) -> None:
        for profile_IDC in (110, 122, 244):
            for chroma_format in (0, 1, 2, 3):
                with self.subTest(profile_IDC=profile_IDC, chroma_format=chroma_format):
                    separate_colour_plane: tuple[BitField, ...] = ((0, 1),) if chroma_format == 3 else ()
                    SPS = create_NAL_unit(
                        SPS_NAL_HEADER,
                        (
                            (profile_IDC, 8),
                            (0x10, 8),
                            (31, 8),
                            unsigned_exp_golomb(1),
                            unsigned_exp_golomb(chroma_format),
                            *separate_colour_plane,
                            unsigned_exp_golomb(2),
                            unsigned_exp_golomb(2),
                        ),
                    )
                    self.assertEqual(
                        generator.read_sequence_parameter_set_evidence(SPS),
                        self.evidence(profile_IDC, 0x10, 31, chroma_format, 10, 10),
                    )

    def test_defaults_chroma_and_depth_of_profiles_without_them(self) -> None:
        # Baseline, Main, and Extended code neither field; what follows the ID is not read
        for profile_IDC, codec_string in ((66, "avc1.42E01E"), (77, "avc1.4DE01E"), (88, "avc1.58E01E")):
            with self.subTest(profile_IDC=profile_IDC):
                SPS = create_NAL_unit(
                    SPS_NAL_HEADER,
                    ((profile_IDC, 8), (0xE0, 8), (30, 8), unsigned_exp_golomb(0), unsigned_exp_golomb(3)),
                )
                evidence = generator.read_sequence_parameter_set_evidence(SPS)
                self.assertEqual(evidence, self.evidence(profile_IDC, 0xE0, 30, 1, 8, 8))
                self.assertEqual(generator.get_codec_string(evidence), codec_string)
        # The ID is the last field read, so the RBSP may end after it
        evidence = generator.read_sequence_parameter_set_evidence(b"\x67\x4D\x40\x0B\x80")
        self.assertEqual(evidence, self.evidence(77, 0x40, 11, 1, 8, 8))
        self.assertEqual(generator.get_codec_string(evidence), "avc1.4D400B")

    def test_rejects_a_truncated_SPS(self) -> None:
        for SPS in (b"\x67\x64\x00", b"\x67\x64\x00\x0B\x80"):
            with self.subTest(SPS=SPS.hex()):
                with self.assertRaises(generator.VectorGenerationError) as raised:
                    generator.read_sequence_parameter_set_evidence(SPS)
                self.assertEqual(str(raised.exception), "H.264 RBSP ended unexpectedly")

    def test_formats_codec_strings_as_two_hexadecimal_digits_per_field(self) -> None:
        cases = (
            (self.evidence(244, 0, 11, 3, 8, 8), "avc1.F4000B"),
            (self.evidence(110, 0, 11, 1, 10, 10), "avc1.6E000B"),
            (self.evidence(122, 0, 11, 2, 8, 8), "avc1.7A000B"),
            (self.evidence(66, 0xE0, 9, 1, 8, 8), "avc1.42E009"),
            (self.evidence(100, 0x0C, 0x33, 1, 8, 8), "avc1.640C33"),
        )
        for evidence, codec_string in cases:
            with self.subTest(codec_string=codec_string):
                self.assertEqual(generator.get_codec_string(evidence), codec_string)

    def test_reads_the_first_SPS_of_a_stream(self) -> None:
        first_SPS = create_NAL_unit(SPS_NAL_HEADER, ((122, 8), (0, 8), (11, 8), unsigned_exp_golomb(0),
                                                     unsigned_exp_golomb(2), unsigned_exp_golomb(0),
                                                     unsigned_exp_golomb(0)))
        second_SPS = create_NAL_unit(SPS_NAL_HEADER, ((77, 8), (0, 8), (30, 8), unsigned_exp_golomb(0)))
        data = create_access_unit(b"\x09\xF0", first_SPS, second_SPS)
        self.assertEqual(
            generator.get_sequence_parameter_set_evidence(data),
            self.evidence(122, 0, 11, 2, 8, 8),
        )

    def test_requires_an_SPS(self) -> None:
        data = create_access_unit(b"\x68\xEE", create_slice_NAL_unit(IDR_SLICE_NAL_HEADER, 7))
        with self.assertRaises(generator.VectorGenerationError) as raised:
            generator.get_sequence_parameter_set_evidence(data)
        self.assertEqual(str(raised.exception), "H.264 stream has no SPS")


class SliceTypeTests(unittest.TestCase):
    """Covers reading the slice_type of each access unit and the malformed streams it reports."""

    def test_reads_the_first_slice_of_each_access_unit(self) -> None:
        SPS = create_NAL_unit(SPS_NAL_HEADER, ((100, 8), (0, 8), (11, 8), unsigned_exp_golomb(0)))
        access_units = (
            create_access_unit(SPS, b"\x68\xEE", create_slice_NAL_unit(IDR_SLICE_NAL_HEADER, 7)),
            # The second slice of an access unit is not read
            create_access_unit(
                create_slice_NAL_unit(REFERENCE_SLICE_NAL_HEADER, 5),
                create_slice_NAL_unit(REFERENCE_SLICE_NAL_HEADER, 2),
            ),
            create_access_unit(create_slice_NAL_unit(NON_REFERENCE_SLICE_NAL_HEADER, 6)),
            create_access_unit(create_slice_NAL_unit(REFERENCE_SLICE_NAL_HEADER, 0)),
            create_access_unit(create_slice_NAL_unit(NON_REFERENCE_SLICE_NAL_HEADER, 1)),
            create_access_unit(create_slice_NAL_unit(IDR_SLICE_NAL_HEADER, 2)),
            create_access_unit(create_slice_NAL_unit(REFERENCE_SLICE_NAL_HEADER, 8)),
            create_access_unit(create_slice_NAL_unit(REFERENCE_SLICE_NAL_HEADER, 9)),
        )
        self.assertEqual(
            generator.get_slice_types(b"".join(access_units), [len(access_unit) for access_unit in access_units]),
            ["I", "P", "B", "P", "B", "I", "SP", "SI"],
        )

    def test_reads_a_slice_header_through_emulation_prevention(self) -> None:
        # first_mb_in_slice 2^22 - 1 codes as 22 zeros, a one, and 22 zeros, so its third byte 0x02 is escaped
        slice_NAL_unit = create_NAL_unit(
            NON_REFERENCE_SLICE_NAL_HEADER,
            (unsigned_exp_golomb((1 << 22) - 1), unsigned_exp_golomb(6)),
        )
        self.assertEqual(slice_NAL_unit[1:5], b"\x00\x00\x03\x02")
        data = create_access_unit(slice_NAL_unit)
        self.assertEqual(generator.get_slice_types(data, [len(data)]), ["B"])

    def test_requires_a_slice_in_every_access_unit(self) -> None:
        key_access_unit = create_access_unit(create_slice_NAL_unit(IDR_SLICE_NAL_HEADER, 7))
        parameter_access_unit = create_access_unit(b"\x67\x64\x00\x0B\x80", b"\x68\xEE", b"\x06\x05\x00\x80")
        data = key_access_unit + parameter_access_unit
        with self.assertRaises(generator.VectorGenerationError) as raised:
            generator.get_slice_types(data, [len(key_access_unit), len(parameter_access_unit)])
        self.assertEqual(str(raised.exception), "H.264 access unit has no slice")

    def test_requires_the_access_units_to_cover_the_stream(self) -> None:
        access_unit = create_access_unit(create_slice_NAL_unit(IDR_SLICE_NAL_HEADER, 7))
        with self.assertRaises(generator.VectorGenerationError) as raised:
            generator.get_slice_types(access_unit + access_unit, [len(access_unit)])
        self.assertEqual(str(raised.exception), "H.264 access units do not cover the stream")
        # Lengths past the end leave an empty access unit, which has no start code
        with self.assertRaises(generator.VectorGenerationError) as raised:
            generator.get_slice_types(access_unit, [len(access_unit), 1])
        self.assertEqual(str(raised.exception), "H.264 stream has no Annex B start code")


class FingerprintTests(unittest.TestCase):
    """Covers 32-bit FNV-1a mixing against the values the HEVC generator pins for the same production sampler."""

    def test_mixes_values_with_JavaScript_32_bit_arithmetic(self) -> None:
        cases = (
            (2_166_136_261, 0, 292_984_781),
            (2_166_136_261, 192, 2_409_285_901),
            (0xFFFF_FFFF, 0xFFFF, 4_236_716_141),
            (0, 0x0102, 1_292_170_853),
            (123_456_789, 4_095, 261_940_355),
        )
        for fingerprint, value, mixed_fingerprint in cases:
            with self.subTest(fingerprint=fingerprint, value=value):
                self.assertEqual(generator.mix_fingerprint_value(fingerprint, value), mixed_fingerprint)

    def test_mixes_plane_dimensions_and_grid_samples(self) -> None:
        # (width, height, plane offset, bytes per component, JavaScript fingerprint)
        cases = (
            (7, 5, 3, 2, 2_560_572_687),
            (1, 1, 0, 1, 4_045_479_021),
            (65, 37, 11, 1, 1_410_507_263),
        )
        for width, height, plane_offset, bytes_per_component, plane_fingerprint in cases:
            frame = create_pattern_frame(plane_offset + (width * height * bytes_per_component))
            with self.subTest(width=width, height=height, bytes_per_component=bytes_per_component):
                self.assertEqual(
                    generator.mix_plane_fingerprint(
                        generator.FNV1A_OFFSET_BASIS,
                        frame,
                        plane_offset,
                        width,
                        height,
                        bytes_per_component,
                    ),
                    plane_fingerprint,
                )

    def test_fingerprints_frames_of_every_pixel_format(self) -> None:
        # Formats with the same geometry share a fingerprint, since only the geometry and bytes enter it:
        # yuv420p10le lays out as the yuv420p12le frame the AV1 generator pins
        frame_fingerprints = {
            "yuv420p10le": 344_961_109,
            "yuv422p": 2_029_015_285,
            "yuv422p10le": 3_679_872_853,
            "yuv444p": 1_892_189_493,
            "yuv444p10le": 2_927_224_661,
        }
        self.assertEqual(set(frame_fingerprints), {vector.pixel_format for vector in generator.VECTORS})
        # yuv420p is no vector's format, but shares the sampler's pinned value
        for pixel_format, frame_fingerprint in {**frame_fingerprints, "yuv420p": 4_180_004_021}.items():
            geometry = generator.get_format_geometry(pixel_format)
            with self.subTest(pixel_format=pixel_format):
                self.assertEqual(
                    generator.create_frame_fingerprint(create_pattern_frame(geometry.frame_byte_length), geometry),
                    frame_fingerprint,
                )

    def test_describes_the_raw_layout_of_every_pixel_format(self) -> None:
        # (bytes per component, chroma width, chroma height)
        layouts = {
            "yuv420p10le": (2, 96, 96),
            "yuv422p": (1, 96, 192),
            "yuv422p10le": (2, 96, 192),
            "yuv444p": (1, 192, 192),
            "yuv444p10le": (2, 192, 192),
        }
        self.assertEqual(set(layouts), {vector.pixel_format for vector in generator.VECTORS})
        for pixel_format, (bytes_per_component, chroma_width, chroma_height) in {
            **layouts,
            "yuv420p": (1, 96, 96),
        }.items():
            luma_byte_length = 192 * 192 * bytes_per_component
            chroma_byte_length = chroma_width * chroma_height * bytes_per_component
            with self.subTest(pixel_format=pixel_format):
                self.assertEqual(
                    generator.get_format_geometry(pixel_format),
                    generator.FormatGeometry(
                        bytes_per_component=bytes_per_component,
                        chroma_byte_length=chroma_byte_length,
                        chroma_height=chroma_height,
                        chroma_width=chroma_width,
                        frame_byte_length=luma_byte_length + (2 * chroma_byte_length),
                        luma_byte_length=luma_byte_length,
                    ),
                )


class CommittedVectorTests(unittest.TestCase):
    """Parses the committed vectors in bin/codec_vector_assets/h264-raw-format/."""

    def test_access_units_cover_each_file_in_I_P_B_decode_order(self) -> None:
        for vector in generator.VECTORS:
            data = read_committed_vector(vector)
            with self.subTest(variant=vector.variant):
                self.assertEqual(sum(vector.access_unit_byte_lengths), len(data))
                self.assertEqual(generator.get_slice_types(data, vector.access_unit_byte_lengths), ["I", "P", "B"])

    def test_sequence_parameter_sets_signal_the_table_format(self) -> None:
        for vector in generator.VECTORS:
            evidence = generator.get_sequence_parameter_set_evidence(read_committed_vector(vector))
            with self.subTest(variant=vector.variant):
                self.assertEqual(
                    (evidence["profileIDC"], evidence["chromaFormat"], evidence["bitDepthLuma"], evidence["bitDepthChroma"]),
                    (vector.profile_IDC, vector.chroma_format, vector.bit_depth, vector.bit_depth),
                )
                self.assertEqual(generator.get_codec_string(evidence), vector.codec_string)

    def test_key_access_unit_carries_the_parameter_sets_and_no_unit_carries_SEI(self) -> None:
        for vector in generator.VECTORS:
            access_units = split_access_units(read_committed_vector(vector), vector.access_unit_byte_lengths)
            NAL_unit_types = [
                [generator.get_NAL_unit_type(NAL_unit) for NAL_unit in generator.find_NAL_units(access_unit)]
                for access_unit in access_units
            ]
            with self.subTest(variant=vector.variant):
                for NAL_unit_type in (generator.SPS_NAL_UNIT_TYPE, PPS_NAL_UNIT_TYPE, generator.IDR_SLICE_NAL_UNIT_TYPE):
                    self.assertIn(NAL_unit_type, NAL_unit_types[0])
                for access_unit_NAL_unit_types in NAL_unit_types:
                    self.assertNotIn(SEI_NAL_UNIT_TYPE, access_unit_NAL_unit_types)
                # Only the key access unit carries parameter sets and an IDR slice
                for access_unit_NAL_unit_types in NAL_unit_types[1:]:
                    self.assertEqual(access_unit_NAL_unit_types, [generator.CODED_SLICE_NAL_UNIT_TYPE])

    def test_committed_vectors_omit_the_libx264_version(self) -> None:
        for vector in generator.VECTORS:
            with self.subTest(variant=vector.variant):
                self.assertNotIn(b"x264", read_committed_vector(vector))


class EvidenceRequirementTests(unittest.TestCase):
    """Covers each validation and the message it reports."""

    def test_accepts_the_evidence_every_table_row_requires(self) -> None:
        for vector in generator.VECTORS:
            with self.subTest(variant=vector.variant):
                generator.require_vector_evidence(vector, create_matching_evidence(vector))

    def test_ignores_the_level_and_constraint_flags_the_codec_string_covers(self) -> None:
        vector = generator.VECTORS[0]
        matching_evidence = create_matching_evidence(vector)
        generator.require_vector_evidence(
            vector,
            {
                **matching_evidence,
                "sequenceParameterSet": {**matching_evidence["sequenceParameterSet"], "constraintFlags": 8, "levelIDC": 12},
            },
        )

    def test_reports_each_mismatch_with_its_message(self) -> None:
        vector = generator.VECTORS[0]
        matching_evidence = create_matching_evidence(vector)
        matching_SPS = matching_evidence["sequenceParameterSet"]
        expected_SPS_JSON = '{"bitDepthChroma":10,"bitDepthLuma":10,"chromaFormat":1,"profileIDC":110}'
        cases = (
            (
                {**matching_evidence, "accessUnitByteLengths": [1, 2, 3]},
                "high420-10 access-unit lengths mismatch: expected [3644,2367,2424], got [1,2,3]",
            ),
            (
                {**matching_evidence, "sliceTypes": ["I", "B", "P"]},
                'high420-10 slice types mismatch: expected ["I","P","B"], got ["I","B","P"]',
            ),
            (
                {**matching_evidence, "pictureTypes": ["I", "P", "B"]},
                'high420-10 picture types mismatch: expected ["I","B","P"], got ["I","P","B"]',
            ),
            (
                {**matching_evidence, "sequenceParameterSet": {**matching_SPS, "chromaFormat": 2}},
                f"high420-10 sequence parameter set mismatch: expected {expected_SPS_JSON}, got "
                '{"bitDepthChroma":10,"bitDepthLuma":10,"chromaFormat":2,"profileIDC":110}',
            ),
            (
                {**matching_evidence, "sequenceParameterSet": {**matching_SPS, "bitDepthChroma": 8}},
                f"high420-10 sequence parameter set mismatch: expected {expected_SPS_JSON}, got "
                '{"bitDepthChroma":8,"bitDepthLuma":10,"chromaFormat":1,"profileIDC":110}',
            ),
            (
                {**matching_evidence, "sequenceParameterSet": {**matching_SPS, "bitDepthLuma": 8}},
                f"high420-10 sequence parameter set mismatch: expected {expected_SPS_JSON}, got "
                '{"bitDepthChroma":10,"bitDepthLuma":8,"chromaFormat":1,"profileIDC":110}',
            ),
            (
                {**matching_evidence, "sequenceParameterSet": {**matching_SPS, "profileIDC": 100}},
                f"high420-10 sequence parameter set mismatch: expected {expected_SPS_JSON}, got "
                '{"bitDepthChroma":10,"bitDepthLuma":10,"chromaFormat":1,"profileIDC":100}',
            ),
            (
                {**matching_evidence, "codecString": "avc1.6E000C"},
                'high420-10 codec string mismatch: expected "avc1.6E000B", got "avc1.6E000C"',
            ),
            (
                {**matching_evidence, "decodedFingerprints": [0, 0, 0]},
                "high420-10 decoded fingerprints mismatch: expected [3372277727,4248514697,2206859063], got [0,0,0]",
            ),
            # The first failing requirement, in checking order, is the one reported
            (
                {**matching_evidence, "accessUnitByteLengths": [1, 2, 3], "decodedFingerprints": [0, 0, 0]},
                "high420-10 access-unit lengths mismatch: expected [3644,2367,2424], got [1,2,3]",
            ),
            (
                {**matching_evidence, "codecString": "avc1.6E000C", "pictureTypes": ["I", "P", "B"]},
                'high420-10 picture types mismatch: expected ["I","B","P"], got ["I","P","B"]',
            ),
        )
        for evidence, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(generator.VectorGenerationError) as raised:
                    # The mismatched evidence breaks the declared shape, hence the cast
                    generator.require_vector_evidence(vector, cast(generator.VectorEvidence, evidence))
                self.assertEqual(str(raised.exception), message)

    def test_compares_values_as_JSON_text(self) -> None:
        # True == 1 in Python, but the JSON texts differ
        with self.assertRaises(generator.VectorGenerationError) as raised:
            generator.require_equal(True, 1, "label")
        self.assertEqual(str(raised.exception), "label mismatch: expected 1, got true")
        generator.require_equal((3_644, 2_367, 2_424), [3_644, 2_367, 2_424], "label")


class CommandTests(unittest.TestCase):
    """Covers command failures and toolchain verification with the subprocesses replaced."""

    def test_runs_argument_lists_without_a_shell_or_inherited_input(self) -> None:
        completed = subprocess.CompletedProcess(["ffprobe"], 0, stdout=b"I\r\nB\r\nP\r\n", stderr=b"")
        with patch.object(subprocess, "run", return_value=completed) as run:
            output = generator.run_text_command("ffprobe", ("-v", "error"))
        run.assert_called_once_with(
            ["ffprobe", "-v", "error"],
            capture_output=True,
            check=False,
            stdin=subprocess.DEVNULL,
        )
        self.assertEqual(output, generator.CommandOutput(standard_error="", standard_output="I\r\nB\r\nP\r\n"))
        self.assertEqual(generator.split_output_lines(output.standard_output), ["I", "B", "P"])
        self.assertEqual(generator.split_output_lines(""), [""])

    def test_reports_failed_commands_with_their_output(self) -> None:
        cases = (
            (generator.run_text_command, b"output", b"error", "ffmpeg failed:\nerror"),
            (generator.run_text_command, b"output", b"", "ffmpeg failed:\noutput"),
            # The binary runner reports only standard error, even when it is empty
            (generator.run_binary_command, b"output", b"", "ffmpeg failed:\n"),
            (generator.run_binary_command, b"", b"error", "ffmpeg failed:\nerror"),
        )
        for run_function, standard_output, standard_error, message in cases:
            completed = subprocess.CompletedProcess(["ffmpeg"], 1, stdout=standard_output, stderr=standard_error)
            with self.subTest(message=message):
                with patch.object(subprocess, "run", return_value=completed):
                    with self.assertRaises(generator.VectorGenerationError) as raised:
                        run_function("ffmpeg", ())
                self.assertEqual(str(raised.exception), message)

    def test_reports_why_a_command_cannot_start(self) -> None:
        not_found = FileNotFoundError(2, "Not found")
        for run_function in (generator.run_text_command, generator.run_binary_command):
            with self.subTest(run_function=run_function.__name__):
                with patch.object(subprocess, "run", side_effect=not_found):
                    with self.assertRaises(generator.VectorGenerationError) as raised:
                        run_function("ffmpeg", ())
                self.assertEqual(str(raised.exception), "ffmpeg failed:\n[Errno 2] Not found")
                self.assertIs(raised.exception.__cause__, not_found)

    def check_toolchain_with(
        self,
        ffmpeg_version: str,
        ffprobe_version: str,
        libx264_probe_bytes: bytes,
    ) -> tuple[Path, list[tuple[str, tuple[str, ...]]]]:
        """Runs check_toolchain against fixed tool output and returns its directory and the commands it ran."""

        commands: list[tuple[str, tuple[str, ...]]] = []

        def run_text_command(command: str, arguments: Sequence[str]) -> generator.CommandOutput:
            commands.append((command, tuple(arguments)))
            if tuple(arguments) == ("-version",):
                version = ffmpeg_version if command == "ffmpeg" else ffprobe_version
                return generator.CommandOutput(standard_error="", standard_output=version)
            # The libx264 probe encodes into the path it names last
            Path(arguments[-1]).write_bytes(libx264_probe_bytes)
            return generator.CommandOutput(standard_error="", standard_output="")

        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            with patch.object(generator, "run_text_command", side_effect=run_text_command):
                generator.check_toolchain(temporary_path)
        return temporary_path, commands

    def test_accepts_the_pinned_toolchain(self) -> None:
        temporary_path, commands = self.check_toolchain_with(
            FFMPEG_VERSION_OUTPUT,
            FFPROBE_VERSION_OUTPUT,
            LIBX264_PROBE_BYTES,
        )
        self.assertEqual([command for command, _arguments in commands], ["ffmpeg", "ffprobe", "ffmpeg"])
        self.assertEqual(commands[0][1], ("-version",))
        self.assertEqual(commands[1][1], ("-version",))
        probe_arguments = commands[2][1]
        self.assertEqual(probe_arguments[-1], str(temporary_path / "libx264-version.h264"))
        self.assertIn("libx264", probe_arguments)
        self.assertEqual(probe_arguments[-4:-1], ("-f", "h264", "-y"))
        # The probe keeps the SEI that names the libx264 build
        self.assertNotIn("-bsf:v", probe_arguments)

    def test_rejects_any_other_toolchain(self) -> None:
        cases = (
            (
                FFMPEG_VERSION_OUTPUT.replace("862338fe31", "0123456789"),
                FFPROBE_VERSION_OUTPUT,
                LIBX264_PROBE_BYTES,
                "The installed FFmpeg/libavcodec is not the required version",
            ),
            (
                FFMPEG_VERSION_OUTPUT.replace("62. 24.100 / 62. 24.100", "62. 25.100 / 62. 25.100"),
                FFPROBE_VERSION_OUTPUT,
                LIBX264_PROBE_BYTES,
                "The installed FFmpeg/libavcodec is not the required version",
            ),
            (
                FFMPEG_VERSION_OUTPUT,
                FFPROBE_VERSION_OUTPUT.replace("2026-03-01", "2026-03-02"),
                LIBX264_PROBE_BYTES,
                "The installed FFprobe is not the required version",
            ),
            (
                FFMPEG_VERSION_OUTPUT,
                FFPROBE_VERSION_OUTPUT,
                LIBX264_PROBE_BYTES.replace(b"r3223 0480cb0", b"r3222 b35605a"),
                "The installed libx264 is not the required version",
            ),
            # A longer version that starts with the pinned one is another build
            (
                FFMPEG_VERSION_OUTPUT,
                FFPROBE_VERSION_OUTPUT,
                LIBX264_PROBE_BYTES.replace(b"0480cb0 ", b"0480cb0-dirty "),
                "The installed libx264 is not the required version",
            ),
            (
                FFMPEG_VERSION_OUTPUT,
                FFPROBE_VERSION_OUTPUT,
                LIBX264_PROBE_BYTES.replace(b"core 165", b"core 164"),
                "The installed libx264 is not the required version",
            ),
        )
        for ffmpeg_version, ffprobe_version, libx264_probe_bytes, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(generator.VectorGenerationError) as raised:
                    self.check_toolchain_with(ffmpeg_version, ffprobe_version, libx264_probe_bytes)
                self.assertEqual(str(raised.exception), message)


class ToolInvocationTests(unittest.TestCase):
    """Covers the encoder, FFprobe, and decoder command lines and how their output is read."""

    def test_encodes_with_serial_libx264_into_an_Annex_B_stream_without_SEI(self) -> None:
        with patch.object(generator, "run_text_command") as run_text_command:
            generator.generate_vector(generator.VECTORS[1], Path("vector.h264"))
        run_text_command.assert_called_once_with(
            "ffmpeg",
            (
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=192x192:rate=1:duration=3",
                "-frames:v",
                "3",
                "-map_metadata",
                "-1",
                "-fflags",
                "+bitexact",
                "-flags:v",
                "+bitexact",
                "-pix_fmt",
                "yuv422p",
                "-c:v",
                "libx264",
                "-profile:v",
                "high422",
                "-preset",
                "medium",
                "-crf",
                "30",
                "-threads",
                "1",
                "-x264-params",
                "keyint=30:min-keyint=30:scenecut=0:bframes=1:b-adapt=0:b-pyramid=none:threads=1:sliced-threads=0",
                "-bsf:v",
                "filter_units=remove_types=6",
                "-f",
                "h264",
                "-y",
                "vector.h264",
            ),
        )

    def test_reads_access_unit_sizes_and_picture_types_from_FFprobe(self) -> None:
        commands: list[tuple[str, tuple[str, ...]]] = []

        def run_text_command(command: str, arguments: Sequence[str]) -> generator.CommandOutput:
            commands.append((command, tuple(arguments)))
            output = "I\nB\nP\n" if "frame=pict_type" in arguments else "4286\r\n2853\r\n2580\r\n"
            return generator.CommandOutput(standard_error="", standard_output=output)

        with patch.object(generator, "run_text_command", side_effect=run_text_command):
            self.assertEqual(generator.get_access_unit_byte_lengths(Path("vector.h264")), [4_286, 2_853, 2_580])
            self.assertEqual(generator.get_picture_types(Path("vector.h264")), ["I", "B", "P"])
        self.assertEqual(
            commands,
            [
                (
                    "ffprobe",
                    ("-v", "error", "-f", "h264", "-select_streams", "v:0", "-show_entries", "packet=size",
                     "-of", "csv=p=0", "vector.h264"),
                ),
                (
                    "ffprobe",
                    ("-v", "error", "-f", "h264", "-select_streams", "v:0", "-show_entries", "frame=pict_type",
                     "-of", "csv=p=0", "vector.h264"),
                ),
            ],
        )

    def test_reads_empty_FFprobe_output_as_one_empty_line(self) -> None:
        empty_output = generator.CommandOutput(standard_error="", standard_output="")
        with patch.object(generator, "run_text_command", return_value=empty_output):
            self.assertEqual(generator.get_access_unit_byte_lengths(Path("vector.h264")), [0])
            self.assertEqual(generator.get_picture_types(Path("vector.h264")), [""])

    def test_fingerprints_each_frame_FFmpeg_decodes(self) -> None:
        vector = generator.VECTORS[1]
        geometry = generator.get_format_geometry(vector.pixel_format)
        decoded_bytes = create_pattern_frame(geometry.frame_byte_length) + bytes(2 * geometry.frame_byte_length)
        with patch.object(generator, "run_binary_command", return_value=decoded_bytes) as run_binary_command:
            fingerprints = generator.get_decoded_fingerprints(Path("vector.h264"), vector)
        run_binary_command.assert_called_once_with(
            "ffmpeg",
            (
                "-v",
                "error",
                "-f",
                "h264",
                "-i",
                "vector.h264",
                "-map",
                "0:v:0",
                "-pix_fmt",
                "yuv422p",
                "-f",
                "rawvideo",
                "pipe:1",
            ),
        )
        # The fingerprints of the pattern frame and of two all-zero frames
        self.assertEqual(fingerprints, [2_029_015_285, 3_717_041_909, 3_717_041_909])

    def test_rejects_a_decode_of_unexpected_length(self) -> None:
        vector = generator.VECTORS[1]
        geometry = generator.get_format_geometry(vector.pixel_format)
        for byte_length in (geometry.frame_byte_length * 2, geometry.frame_byte_length * 4, (geometry.frame_byte_length * 3) + 1):
            with self.subTest(byte_length=byte_length):
                with patch.object(generator, "run_binary_command", return_value=bytes(byte_length)):
                    with self.assertRaises(generator.VectorGenerationError) as raised:
                        generator.get_decoded_fingerprints(Path("vector.h264"), vector)
                self.assertEqual(str(raised.exception), "high422-8 decoded raw byte length is unexpected")


class MainTests(unittest.TestCase):
    """Runs main() with the encoder replaced by the committed vectors and the table's measurements."""

    def run_main(
        self,
        arguments: Sequence[str],
        *,
        vector_directory: Path = COMMITTED_VECTOR_DIRECTORY,
        picture_types: Sequence[str] = ("I", "B", "P"),
    ) -> tuple[int, bytes, str]:
        """Returns the exit status, the raw standard output, and the standard error text."""

        vectors_by_variant = {vector.variant: vector for vector in generator.VECTORS}

        def generate_vector(vector: generator.H264RawFormatVector, output_path: Path) -> None:
            output_path.write_bytes(read_committed_vector(vector))

        def get_access_unit_byte_lengths(input_path: Path) -> list[int]:
            return list(vectors_by_variant[input_path.stem].access_unit_byte_lengths)

        def get_decoded_fingerprints(input_path: Path, vector: generator.H264RawFormatVector) -> list[int]:
            return list(vector.expected_fingerprints)

        def get_picture_types(input_path: Path) -> list[str]:
            return list(picture_types)

        # A CRLF text layer, as on Windows, shows that the output bypasses newline translation
        standard_output = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", newline="\r\n")
        standard_error = io.StringIO()
        with (
            patch.object(generator, "check_toolchain"),
            patch.object(generator, "generate_vector", side_effect=generate_vector),
            patch.object(generator, "get_access_unit_byte_lengths", side_effect=get_access_unit_byte_lengths),
            patch.object(generator, "get_decoded_fingerprints", side_effect=get_decoded_fingerprints),
            patch.object(generator, "get_picture_types", side_effect=get_picture_types),
            patch.object(generator, "VECTOR_DIRECTORY", vector_directory),
            redirect_stdout(standard_output),
            redirect_stderr(standard_error),
        ):
            exit_status = generator.main(arguments)
        return exit_status, standard_output.buffer.getvalue(), standard_error.getvalue()

    def test_inspect_prints_one_JSON_line_per_vector(self) -> None:
        exit_status, output, errors = self.run_main(["--inspect"])
        self.assertEqual((exit_status, errors), (0, ""))
        self.assertNotIn(b"\r", output)
        lines = output.decode("utf-8").split("\n")
        self.assertEqual(lines.pop(), "")
        self.assertEqual(lines[0], HIGH_420_10_BIT_INSPECT_LINE)
        self.assertEqual(
            [json.loads(line)["variant"] for line in lines],
            [vector.variant for vector in generator.VECTORS],
        )
        for line, vector in zip(lines, generator.VECTORS):
            with self.subTest(variant=vector.variant):
                evidence = json.loads(line)
                self.assertEqual(evidence["codecString"], vector.codec_string)
                self.assertEqual(evidence["sliceTypes"], ["I", "P", "B"])

    def test_inspect_does_not_require_the_evidence(self) -> None:
        exit_status, output, errors = self.run_main(["--inspect"], picture_types=("I", "P", "B"))
        self.assertEqual((exit_status, errors), (0, ""))
        self.assertEqual(len(output.decode("utf-8").split("\n")), len(generator.VECTORS) + 1)

    def test_check_verifies_the_committed_vectors(self) -> None:
        self.assertEqual(
            self.run_main(["--check"]),
            (0, b"Verified 5 deterministic H.264 raw-format vectors.\n", ""),
        )

    def test_generation_writes_every_vector(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            self.assertEqual(
                self.run_main([], vector_directory=output_directory),
                (0, b"Generated 5 deterministic H.264 raw-format vectors.\n", ""),
            )
            for vector in generator.VECTORS:
                with self.subTest(variant=vector.variant):
                    self.assertEqual(
                        (output_directory / f"{vector.variant}.h264").read_bytes(),
                        read_committed_vector(vector),
                    )

    def test_check_rejects_a_committed_vector_that_differs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            for vector in generator.VECTORS:
                (output_directory / f"{vector.variant}.h264").write_bytes(read_committed_vector(vector))
            stale_path = output_directory / "high444-10.h264"
            stale_path.write_bytes(b"stale")
            self.assertEqual(
                self.run_main(["--check"], vector_directory=output_directory),
                (1, b"", f"Regenerated output differs from the committed bytes: {stale_path}\n"),
            )
            self.assertEqual(stale_path.read_bytes(), b"stale")

    def test_reports_a_failed_requirement_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            self.assertEqual(
                self.run_main([], vector_directory=output_directory, picture_types=("I", "P", "B")),
                (1, b"", 'high420-10 picture types mismatch: expected ["I","B","P"], got ["I","P","B"]\n'),
            )
            self.assertEqual(list(output_directory.iterdir()), [])

    def test_reports_a_failed_toolchain_check(self) -> None:
        standard_error = io.StringIO()
        failure = generator.VectorGenerationError("The installed libx264 is not the required version")
        with (
            patch.object(generator, "check_toolchain", side_effect=failure),
            patch.object(generator, "generate_vector") as generate_vector,
            redirect_stdout(io.StringIO()),
            redirect_stderr(standard_error),
        ):
            self.assertEqual(generator.main(["--check"]), 1)
        generate_vector.assert_not_called()
        self.assertEqual(standard_error.getvalue(), "The installed libx264 is not the required version\n")

    def test_rejects_both_modes_and_unknown_arguments(self) -> None:
        for arguments in (["--check", "--inspect"], ["check"]):
            with self.subTest(arguments=arguments):
                with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                    generator.parse_arguments(arguments)
                self.assertEqual(raised.exception.code, 2)

    def test_parses_each_mode(self) -> None:
        cases: tuple[tuple[list[str], bool, bool], ...] = (
            ([], False, False),
            (["--check"], True, False),
            (["--inspect"], False, True),
        )
        for arguments, check, inspect in cases:
            with self.subTest(arguments=arguments):
                parsed_arguments = generator.parse_arguments(arguments)
                self.assertEqual((parsed_arguments.check, parsed_arguments.inspect), (check, inspect))


if __name__ == "__main__":
    unittest.main()
