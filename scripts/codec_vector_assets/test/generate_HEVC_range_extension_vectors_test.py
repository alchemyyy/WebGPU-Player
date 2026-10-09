"""Tests the HEVC range-extension vector generator without running FFmpeg."""

from __future__ import annotations

import dataclasses
import io
import json
import math
import random
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

import generate_HEVC_range_extension_vectors as generator  # noqa: E402


# Saved before any test replaces generator.VECTOR_DIRECTORY
COMMITTED_VECTOR_DIRECTORY = generator.VECTOR_DIRECTORY
FOUR_BYTE_START_CODE = b"\x00\x00\x00\x01"
THREE_BYTE_START_CODE = b"\x00\x00\x01"
# Synthetic escaped Main-profile VPS and SPS: profile IDC 1, compatibility flags 60000000, constraints 90.00
MAIN_VPS = bytes.fromhex("40010C01FFFF01600000030090000003000003005D959809")
MAIN_SPS = bytes.fromhex("42010101600000030090000003000003005DA00C0804000003008085965E49")
# The same parameter sets at Level 1, general_level_idc 30, which x265 picks for these vectors without level-idc
LEVEL_1_VPS = bytes.fromhex("40010C01FFFF01600000030090000003000003001E959809")
LEVEL_1_SPS = bytes.fromhex("42010101600000030090000003000003001EA00C0804000003008085965E49")
PPS = bytes.fromhex("4401C172B46240")
# An IDR slice holding an escape that patching must copy untouched
IDR_SLICE = bytes.fromhex("2801AF000003017F")
# The parameter sets above patched with constraint prefix 9F.88 by the Node generator this module replaced
RANGE_EXTENSION_VPS = bytes.fromhex("40010C01FFFF0408000003009F8800000300005D959809")
RANGE_EXTENSION_SPS = bytes.fromhex("4201010408000003009F8800000300005DA00C0804000003008085965E49")
PROFILE_TIER_LEVEL_EVIDENCE_KEYS = (
    "compatibilityFlags",
    "constraintPrefix",
    "intraConstrained",
    "onePictureOnly",
    "profileIDC",
)
# The first line --inspect prints, as the Node generator this module replaced printed it
RANGE_EXTENSION_8_BIT_INSPECT_LINE = (
    '{"accessUnitByteLengths":[3452,2905],"decodedFingerprints":[3329959031,201088281],'
    '"pictureTypes":["I","P"],"PTL":{"SPS":{"compatibilityFlags":"08000000",'
    '"constraintPrefix":"9F.88","intraConstrained":false,"onePictureOnly":false,"profileIDC":4},'
    '"VPS":{"compatibilityFlags":"08000000","constraintPrefix":"9F.88","intraConstrained":false,'
    '"onePictureOnly":false,"profileIDC":4}},"variant":"rext420-8"}'
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
X265_PROBE_ERROR_OUTPUT = "x265 [info]: HEVC encoder version 4.1+225-1b48507eb\n"


def create_stream(NAL_units: Sequence[bytes]) -> bytes:
    """Returns the NAL units, each behind a 4-byte start code."""

    return b"".join(FOUR_BYTE_START_CODE + NAL_unit for NAL_unit in NAL_units)


# x265 writes the slice behind a 3-byte start code, after 4-byte parameter-set start codes
MAIN_STREAM = create_stream((MAIN_VPS, MAIN_SPS, PPS)) + THREE_BYTE_START_CODE + IDR_SLICE
LEVEL_1_STREAM = create_stream((LEVEL_1_VPS, LEVEL_1_SPS, PPS)) + THREE_BYTE_START_CODE + IDR_SLICE
RANGE_EXTENSION_STREAM = (
    create_stream((RANGE_EXTENSION_VPS, RANGE_EXTENSION_SPS, PPS)) + THREE_BYTE_START_CODE + IDR_SLICE
)


def create_pattern_frame(byte_length: int) -> bytes:
    """Returns the byte pattern the reference fingerprints were computed from with the Node generator."""

    return bytes((byte_index * 31 + 7) & 0xFF for byte_index in range(byte_length))


def read_committed_vector(vector: generator.RangeExtensionVector) -> bytes:
    """Returns the committed bytes of one vector."""

    return (COMMITTED_VECTOR_DIRECTORY / f"{vector.variant}.hevc").read_bytes()


def create_matching_PTL_evidence(
    vector: generator.RangeExtensionVector,
) -> generator.ProfileTierLevelEvidence:
    """Returns the profile-tier-level evidence the vector table requires."""

    return {
        "compatibilityFlags": "08000000",
        "constraintPrefix": vector.constraint_prefix,
        "intraConstrained": vector.intra_constrained,
        "onePictureOnly": False,
        "profileIDC": 4,
    }


def create_matching_evidence(vector: generator.RangeExtensionVector) -> generator.VectorEvidence:
    """Returns evidence that satisfies every requirement for the vector."""

    return {
        "accessUnitByteLengths": list(vector.access_unit_byte_lengths),
        "decodedFingerprints": list(vector.expected_fingerprints),
        "pictureTypes": ["I"] if vector.frame_count == 1 else ["I", "P"],
        "PTL": {
            "SPS": create_matching_PTL_evidence(vector),
            "VPS": create_matching_PTL_evidence(vector),
        },
    }


class EmulationPreventionTests(unittest.TestCase):
    """Covers removing and inserting emulation-prevention bytes, edge behavior included."""

    def test_removes_each_escape_that_follows_two_zero_bytes(self) -> None:
        cases = (
            (b"\x00\x00\x03\x01", b"\x00\x00\x01"),
            (b"\x00\x00\x03\x00\x00\x03", b"\x00\x00\x00\x00"),
            (b"\x40\x01\x00\x00\x03", b"\x40\x01\x00\x00"),
            (MAIN_VPS, bytes.fromhex("40010C01FFFF01600000009000000000005D959809")),
        )
        for NAL_unit, RBSP in cases:
            with self.subTest(NAL_unit=NAL_unit.hex()):
                self.assertEqual(generator.remove_emulation_prevention_bytes(NAL_unit), RBSP)

    def test_removal_looks_back_at_input_bytes_without_validating(self) -> None:
        cases = (
            # The second 0x03 follows 0x00 0x03 in the input, so it stays
            (b"\x00\x00\x03\x03", b"\x00\x00\x03"),
            # Three zeros never occur in a NAL unit, but nothing rejects them
            (b"\x00\x00\x00\x03", b"\x00\x00\x00"),
            # An escape needs two zero bytes before it
            (b"\x00\x03", b"\x00\x03"),
            (b"\x03\x00\x03", b"\x03\x00\x03"),
            (b"", b""),
        )
        for NAL_unit, RBSP in cases:
            with self.subTest(NAL_unit=NAL_unit.hex()):
                self.assertEqual(generator.remove_emulation_prevention_bytes(NAL_unit), RBSP)

    def test_inserts_an_escape_before_each_low_byte_after_two_zeros(self) -> None:
        cases = (
            (b"\x40\x01\x00\x00\x00", b"\x40\x01\x00\x00\x03\x00"),
            (b"\x40\x01\x00\x00\x01", b"\x40\x01\x00\x00\x03\x01"),
            (b"\x40\x01\x00\x00\x02", b"\x40\x01\x00\x00\x03\x02"),
            (b"\x40\x01\x00\x00\x03", b"\x40\x01\x00\x00\x03\x03"),
            (b"\x40\x01\x00\x00\x04", b"\x40\x01\x00\x00\x04"),
            (b"\x40\x01\x00\x00\x00\x00\x00", b"\x40\x01\x00\x00\x03\x00\x00\x03\x00"),
        )
        for RBSP, NAL_unit in cases:
            with self.subTest(RBSP=RBSP.hex()):
                self.assertEqual(generator.add_emulation_prevention_bytes(RBSP), NAL_unit)

    def test_insertion_keeps_the_original_edge_behavior(self) -> None:
        cases = (
            # The two header bytes are copied and never counted as zeros
            (b"\x00\x00\x01", b"\x00\x00\x01"),
            # No escape follows trailing zeros
            (b"\x40\x01\x00\x00", b"\x40\x01\x00\x00"),
            # A header shorter than two bytes is zero-padded
            (b"", b"\x00\x00"),
            (b"\x40", b"\x40\x00"),
        )
        for RBSP, NAL_unit in cases:
            with self.subTest(RBSP=RBSP.hex()):
                self.assertEqual(generator.add_emulation_prevention_bytes(RBSP), NAL_unit)

    def test_round_trips_RBSPs_behind_a_valid_NAL_header(self) -> None:
        random_generator = random.Random(0x0E9B)
        for case_index in range(500):
            # nuh_temporal_id_plus1 is at least 1, so a valid second header byte is never zero
            RBSP = b"\x40\x01" + bytes(
                random_generator.choices((0, 0, 0, 1, 2, 3, 0x80, 0xFF), k=random_generator.randrange(64))
            )
            NAL_unit = generator.add_emulation_prevention_bytes(RBSP)
            with self.subTest(case_index=case_index, RBSP=RBSP.hex()):
                for start_code_prefix in (b"\x00\x00\x00", b"\x00\x00\x01", b"\x00\x00\x02"):
                    self.assertNotIn(start_code_prefix, NAL_unit)
                self.assertEqual(generator.remove_emulation_prevention_bytes(NAL_unit), RBSP)

    def test_round_trip_needs_a_nonzero_second_header_byte(self) -> None:
        # Insertion skips the header while removal looks back into it
        RBSP = b"\x40\x00\x00\x03"
        NAL_unit = generator.add_emulation_prevention_bytes(RBSP)
        self.assertEqual(NAL_unit, RBSP)
        self.assertEqual(generator.remove_emulation_prevention_bytes(NAL_unit), b"\x40\x00\x00")


class AnnexBStartCodeTests(unittest.TestCase):
    """Covers 3- and 4-byte start-code scanning, including its end-of-data bound."""

    def find_start_codes(self, data: bytes) -> list[tuple[int, int]]:
        """Returns the (offset, length) of every start code found."""

        return [
            (start_code.byte_offset, start_code.byte_length)
            for start_code in generator.find_annex_B_start_codes(data)
        ]

    def test_finds_3_and_4_byte_start_codes(self) -> None:
        cases = (
            (b"\x00\x00\x00\x01\x40\x01", [(0, 4)]),
            (b"\x00\x00\x01\x40\x01", [(0, 3)]),
            (b"\x00\x00\x00\x01\x40\x01\xAA\x00\x00\x01\x42\x01\xBB", [(0, 4), (7, 3)]),
            (b"\x00\x00\x01\x00\x00\x01\x40", [(0, 3), (3, 3)]),
            # A zero before a 4-byte start code stays with the previous NAL unit
            (b"\x00\x00\x00\x00\x01\x40", [(1, 4)]),
            (MAIN_STREAM, [(0, 4), (28, 4), (63, 4), (74, 3)]),
        )
        for data, start_codes in cases:
            with self.subTest(data=data.hex()):
                self.assertEqual(self.find_start_codes(data), start_codes)

    def test_scans_only_offsets_followed_by_three_bytes(self) -> None:
        cases: tuple[tuple[bytes, list[tuple[int, int]]], ...] = (
            # A 3-byte start code in the last three bytes is not found
            (b"\x40\x00\x00\x01", []),
            (b"\x00\x00\x01", []),
            (b"", []),
            (b"\x00\x00\x01\x40", [(0, 3)]),
            # A 4-byte start code may end the data, leaving an empty NAL unit
            (b"\xAA\x00\x00\x00\x01", [(1, 4)]),
        )
        for data, start_codes in cases:
            with self.subTest(data=data.hex()):
                self.assertEqual(self.find_start_codes(data), start_codes)

    def test_exposes_the_NAL_unit_offset(self) -> None:
        start_code = generator.AnnexBStartCode(byte_length=3, byte_offset=74)
        self.assertEqual(start_code.NAL_unit_offset, 77)

    def test_reads_a_NAL_header_past_the_end_as_type_0(self) -> None:
        self.assertEqual(generator.get_NAL_unit_type(MAIN_VPS, 0), 32)
        self.assertEqual(generator.get_NAL_unit_type(FOUR_BYTE_START_CODE, 4), 0)


class ProfileTierLevelPatchTests(unittest.TestCase):
    """Covers the VPS and SPS profile-tier-level rewrite and every error it reports."""

    def test_rewrites_the_VPS_and_SPS_and_copies_other_units(self) -> None:
        self.assertEqual(
            generator.patch_profile_tier_level_to_range_extension(MAIN_STREAM, "9F.88"),
            RANGE_EXTENSION_STREAM,
        )

    def test_writes_profile_compatibility_and_constraint_bytes_only(self) -> None:
        patched = generator.patch_profile_tier_level_to_range_extension(MAIN_STREAM, "9D.08")
        cases = (
            (MAIN_STREAM, generator.VPS_NAL_UNIT_TYPE, 6, "01 60000000 900000000000"),
            (patched, generator.VPS_NAL_UNIT_TYPE, 6, "04 08000000 9D0800000000"),
            (MAIN_STREAM, generator.SPS_NAL_UNIT_TYPE, 3, "01 60000000 900000000000"),
            (patched, generator.SPS_NAL_UNIT_TYPE, 3, "04 08000000 9D0800000000"),
        )
        RBSPs: dict[tuple[bytes, int], bytes] = {}
        for data, NAL_unit_type, profile_tier_level_offset, prefix in cases:
            start_codes = generator.find_annex_B_start_codes(data)
            unit_index = 0 if NAL_unit_type == generator.VPS_NAL_UNIT_TYPE else 1
            RBSP = generator.remove_emulation_prevention_bytes(
                data[start_codes[unit_index].NAL_unit_offset : start_codes[unit_index + 1].byte_offset]
            )
            RBSPs[(data, NAL_unit_type)] = RBSP
            with self.subTest(NAL_unit_type=NAL_unit_type, prefix=prefix):
                self.assertEqual(
                    RBSP[profile_tier_level_offset : profile_tier_level_offset + 11],
                    bytes.fromhex(prefix),
                )
        for NAL_unit_type, profile_tier_level_offset in ((32, 6), (33, 3)):
            original_RBSP = RBSPs[(MAIN_STREAM, NAL_unit_type)]
            patched_RBSP = RBSPs[(patched, NAL_unit_type)]
            prefix_end_offset = profile_tier_level_offset + 11
            with self.subTest(NAL_unit_type=NAL_unit_type):
                self.assertEqual(len(patched_RBSP), len(original_RBSP))
                self.assertEqual(
                    patched_RBSP[:profile_tier_level_offset],
                    original_RBSP[:profile_tier_level_offset],
                )
                self.assertEqual(patched_RBSP[prefix_end_offset:], original_RBSP[prefix_end_offset:])

    def test_keeps_an_empty_trailing_NAL_unit(self) -> None:
        # A final start code with nothing after it reads as type 0 and is copied
        self.assertEqual(
            generator.patch_profile_tier_level_to_range_extension(
                MAIN_STREAM + FOUR_BYTE_START_CODE,
                "9F.88",
            ),
            RANGE_EXTENSION_STREAM + FOUR_BYTE_START_CODE,
        )

    def test_rejects_data_that_does_not_start_with_a_start_code(self) -> None:
        for data in (b"", b"\x01" + MAIN_STREAM, MAIN_VPS):
            with self.subTest(data=data[:8].hex()):
                with self.assertRaisesRegex(
                    generator.VectorGenerationError,
                    "^Generated vector is not Annex B HEVC$",
                ):
                    generator.patch_profile_tier_level_to_range_extension(data, "9F.88")

    def test_rejects_parameter_sets_too_short_once_unescaped(self) -> None:
        # Each escaped unit is long enough, but its RBSP ends one byte before the last constraint byte
        self.assertEqual(len(generator.remove_emulation_prevention_bytes(MAIN_VPS[:18])), 16)
        self.assertEqual(len(generator.remove_emulation_prevention_bytes(MAIN_SPS[:15])), 13)
        for data in (create_stream((MAIN_VPS[:18], MAIN_SPS)), create_stream((MAIN_VPS, MAIN_SPS[:15]))):
            with self.subTest(data=data.hex()):
                with self.assertRaisesRegex(
                    generator.VectorGenerationError,
                    "^Generated VPS/SPS is too short to patch profile-tier-level$",
                ):
                    generator.patch_profile_tier_level_to_range_extension(data, "9F.88")

    def test_requires_exactly_one_VPS_and_one_SPS(self) -> None:
        cases = (
            (create_stream((MAIN_VPS, MAIN_VPS, MAIN_SPS)), "Expected one VPS/SPS, patched 2/1"),
            (create_stream((MAIN_VPS, MAIN_SPS, MAIN_SPS)), "Expected one VPS/SPS, patched 1/2"),
            (create_stream((MAIN_VPS, PPS)), "Expected one VPS/SPS, patched 1/0"),
            (create_stream((PPS, IDR_SLICE)), "Expected one VPS/SPS, patched 0/0"),
        )
        for data, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(generator.VectorGenerationError) as raised:
                    generator.patch_profile_tier_level_to_range_extension(data, "9F.88")
                self.assertEqual(str(raised.exception), message)


class GeneralLevelTests(unittest.TestCase):
    """Covers writing general_level_idc into the VPS and SPS."""

    def test_writes_the_level_into_the_VPS_and_SPS_only(self) -> None:
        self.assertEqual(
            generator.set_general_level_IDC(LEVEL_1_STREAM, generator.LEVEL_3_1_IDC),
            MAIN_STREAM,
        )
        self.assertEqual(generator.set_general_level_IDC(MAIN_STREAM, 30), LEVEL_1_STREAM)

    def test_level_3_1_is_general_level_idc_93(self) -> None:
        self.assertEqual(generator.LEVEL_3_1_IDC, 93)
        self.assertEqual(generator.GENERAL_LEVEL_IDC_OFFSET, 11)

    def test_requires_the_level_byte_that_the_profile_rewrite_does_not_need(self) -> None:
        # Each RBSP ends right before general_level_idc
        self.assertEqual(len(generator.remove_emulation_prevention_bytes(MAIN_VPS[:20])), 17)
        self.assertEqual(len(generator.remove_emulation_prevention_bytes(MAIN_SPS[:17])), 14)
        for data in (create_stream((MAIN_VPS[:20], MAIN_SPS)), create_stream((MAIN_VPS, MAIN_SPS[:17]))):
            with self.subTest(data=data.hex()):
                with self.assertRaisesRegex(
                    generator.VectorGenerationError,
                    "^Generated VPS/SPS is too short to patch profile-tier-level$",
                ):
                    generator.set_general_level_IDC(data, generator.LEVEL_3_1_IDC)
                generator.patch_profile_tier_level_to_range_extension(data, "9F.88")

    def test_requires_exactly_one_VPS_and_one_SPS(self) -> None:
        with self.assertRaises(generator.VectorGenerationError) as raised:
            generator.set_general_level_IDC(create_stream((MAIN_VPS, PPS)), generator.LEVEL_3_1_IDC)
        self.assertEqual(str(raised.exception), "Expected one VPS/SPS, patched 1/0")


class ProfileTierLevelEvidenceTests(unittest.TestCase):
    """Covers reading the general profile-tier-level fields back out of a stream."""

    def test_reads_the_general_profile_tier_level_fields_in_inspect_order(self) -> None:
        for NAL_unit_type in (generator.VPS_NAL_UNIT_TYPE, generator.SPS_NAL_UNIT_TYPE):
            with self.subTest(NAL_unit_type=NAL_unit_type):
                evidence = generator.get_profile_tier_level_evidence(MAIN_STREAM, NAL_unit_type)
                self.assertEqual(
                    evidence,
                    {
                        "compatibilityFlags": "60000000",
                        "constraintPrefix": "90.00",
                        "intraConstrained": False,
                        "onePictureOnly": False,
                        "profileIDC": 1,
                    },
                )
                self.assertEqual(tuple(evidence), PROFILE_TIER_LEVEL_EVIDENCE_KEYS)

    def test_reads_the_intra_and_one_picture_constraint_flags(self) -> None:
        cases = (
            ("9F.88", False, False),
            ("9F.A8", True, False),
            ("9F.98", False, True),
            ("9F.B8", True, True),
        )
        for constraint_prefix, intra_constrained, one_picture_only in cases:
            patched = generator.patch_profile_tier_level_to_range_extension(MAIN_STREAM, constraint_prefix)
            for NAL_unit_type in (generator.VPS_NAL_UNIT_TYPE, generator.SPS_NAL_UNIT_TYPE):
                with self.subTest(constraint_prefix=constraint_prefix, NAL_unit_type=NAL_unit_type):
                    self.assertEqual(
                        generator.get_profile_tier_level_evidence(patched, NAL_unit_type),
                        {
                            "compatibilityFlags": "08000000",
                            "constraintPrefix": constraint_prefix,
                            "intraConstrained": intra_constrained,
                            "onePictureOnly": one_picture_only,
                            "profileIDC": 4,
                        },
                    )

    def test_masks_profile_space_and_tier_out_of_the_profile_IDC(self) -> None:
        # Byte 0xE4 holds profile space 3 and the High tier flag before profile IDC 4
        SPS = bytes.fromhex("420101E408000003009F8800000300005D")
        evidence = generator.get_profile_tier_level_evidence(create_stream((SPS,)), 33)
        self.assertEqual(evidence["profileIDC"], 4)

    def test_reports_a_missing_parameter_set(self) -> None:
        with self.assertRaisesRegex(generator.VectorGenerationError, "^Vector has no NAL unit type 33$"):
            generator.get_profile_tier_level_evidence(create_stream((MAIN_VPS, PPS)), 33)

    def test_reports_a_parameter_set_too_short_for_the_constraints(self) -> None:
        cases = (
            (create_stream((MAIN_VPS[:18],)), generator.VPS_NAL_UNIT_TYPE),
            (create_stream((MAIN_SPS[:15],)), generator.SPS_NAL_UNIT_TYPE),
            # A start code that ends the data matches type 0 and is empty
            (b"\xAA" + FOUR_BYTE_START_CODE, 0),
        )
        for data, NAL_unit_type in cases:
            with self.subTest(data=data.hex()):
                with self.assertRaisesRegex(
                    generator.VectorGenerationError,
                    "^Vector parameter set is too short for profile-tier-level constraints$",
                ):
                    generator.get_profile_tier_level_evidence(data, NAL_unit_type)


class FingerprintTests(unittest.TestCase):
    """Covers 32-bit FNV-1a mixing against values computed by the Node generator this module replaced."""

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
        # Formats with the same geometry share a fingerprint, since only the geometry and bytes enter it
        frame_fingerprints = {
            "yuv420p": 4_180_004_021,
            "yuv422p": 2_029_015_285,
            "yuv444p": 1_892_189_493,
            "yuv420p10le": 344_961_109,
            "yuv422p10le": 3_679_872_853,
            "yuv444p10le": 2_927_224_661,
            "yuv420p12le": 344_961_109,
            "yuv422p12le": 3_679_872_853,
            "yuv444p12le": 2_927_224_661,
        }
        self.assertEqual(
            set(frame_fingerprints),
            {vector.pixel_format for vector in generator.VECTORS},
        )
        for pixel_format, frame_fingerprint in frame_fingerprints.items():
            geometry = generator.get_format_geometry(pixel_format)
            with self.subTest(pixel_format=pixel_format):
                self.assertEqual(
                    generator.create_frame_fingerprint(
                        create_pattern_frame(geometry.frame_byte_length),
                        geometry,
                    ),
                    frame_fingerprint,
                )

    def test_describes_the_raw_layout_of_every_pixel_format(self) -> None:
        # (bytes per component, chroma width, chroma height)
        layouts = {
            "yuv420p": (1, 96, 96),
            "yuv422p": (1, 96, 192),
            "yuv444p": (1, 192, 192),
            "yuv420p10le": (2, 96, 96),
            "yuv422p10le": (2, 96, 192),
            "yuv444p10le": (2, 192, 192),
            "yuv420p12le": (2, 96, 96),
            "yuv422p12le": (2, 96, 192),
            "yuv444p12le": (2, 192, 192),
        }
        self.assertEqual(set(layouts), {vector.pixel_format for vector in generator.VECTORS})
        for pixel_format, (bytes_per_component, chroma_width, chroma_height) in layouts.items():
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

    def test_sample_index_floor_division_matches_JavaScript_Math_floor(self) -> None:
        # Python's int / int is the correctly rounded IEEE quotient JavaScript computes
        checked_count = 0
        for vector in generator.VECTORS:
            geometry = generator.get_format_geometry(vector.pixel_format)
            planes = (
                (generator.CODED_WIDTH, generator.CODED_HEIGHT),
                (geometry.chroma_width, geometry.chroma_height),
            )
            for width, height in planes:
                axes = (
                    (generator.FINGERPRINT_ROW_SAMPLE_COUNT, height),
                    (generator.FINGERPRINT_COLUMN_SAMPLE_COUNT, width),
                )
                for sample_count, dimension in axes:
                    for sample_index in range(sample_count):
                        numerator = sample_index * (dimension - 1)
                        denominator = sample_count - 1
                        self.assertEqual(numerator // denominator, math.floor(numerator / denominator))
                        checked_count += 1
        self.assertEqual(checked_count, len(generator.VECTORS) * 2 * (36 + 64))


class VectorTableTests(unittest.TestCase):
    """Covers the x265 parameters and the vector table defaults."""

    def test_builds_the_x265_parameters_for_one_and_two_frames(self) -> None:
        two_frame_vector = generator.VECTORS[0]
        one_frame_vector = dataclasses.replace(two_frame_vector, frame_count=1)
        self.assertEqual(
            generator.get_x265_parameters(two_frame_vector),
            "info=0:pools=none:frame-threads=1:wpp=0:log-level=error:"
            "keyint=30:min-keyint=30:scenecut=0:bframes=0:repeat-headers=1",
        )
        self.assertEqual(
            generator.get_x265_parameters(one_frame_vector),
            "info=0:pools=none:frame-threads=1:wpp=0:log-level=error:keyint=1",
        )

    def test_never_asks_x265_for_a_level(self) -> None:
        # With CRF, x265 enforces a requested level through VBV, which it reports as non-deterministic
        for vector in generator.VECTORS:
            with self.subTest(variant=vector.variant):
                self.assertNotIn("level-idc", generator.get_x265_parameters(vector))

    def test_patches_only_the_4_2_0_8_and_10_bit_vectors(self) -> None:
        self.assertEqual(
            [vector.variant for vector in generator.VECTORS if vector.patch_profile_tier_level],
            ["rext420-8", "rext420-10"],
        )
        self.assertFalse(
            generator.RangeExtensionVector(
                access_unit_byte_lengths=(),
                constraint_prefix="",
                expected_fingerprints=(),
                frame_count=1,
                intra_constrained=False,
                pixel_format="",
                profile="",
                variant="",
            ).patch_profile_tier_level
        )


class CommittedVectorTests(unittest.TestCase):
    """Parses the committed vectors in bin/codec_vector_assets/hevc-range-extension/."""

    def test_parameter_sets_signal_the_table_profile_tier_level(self) -> None:
        for vector in generator.VECTORS:
            data = read_committed_vector(vector)
            VPS_evidence = generator.get_profile_tier_level_evidence(data, generator.VPS_NAL_UNIT_TYPE)
            SPS_evidence = generator.get_profile_tier_level_evidence(data, generator.SPS_NAL_UNIT_TYPE)
            with self.subTest(variant=vector.variant):
                self.assertEqual(SPS_evidence, VPS_evidence)
                self.assertEqual(VPS_evidence["profileIDC"], 4)
                self.assertEqual(VPS_evidence["compatibilityFlags"], "08000000")
                self.assertEqual(VPS_evidence["constraintPrefix"], vector.constraint_prefix)
                self.assertEqual(VPS_evidence["intraConstrained"], vector.intra_constrained)
                self.assertFalse(VPS_evidence["onePictureOnly"])

    def test_access_units_cover_each_file(self) -> None:
        for vector in generator.VECTORS:
            with self.subTest(variant=vector.variant):
                self.assertEqual(sum(vector.access_unit_byte_lengths), len(read_committed_vector(vector)))

    def test_patching_with_the_table_constraints_changes_nothing(self) -> None:
        for vector in generator.VECTORS:
            data = read_committed_vector(vector)
            with self.subTest(variant=vector.variant):
                self.assertEqual(
                    generator.patch_profile_tier_level_to_range_extension(data, vector.constraint_prefix),
                    data,
                )

    def test_parameter_sets_signal_level_3_1(self) -> None:
        for vector in generator.VECTORS:
            data = read_committed_vector(vector)
            with self.subTest(variant=vector.variant):
                self.assertEqual(generator.set_general_level_IDC(data, generator.LEVEL_3_1_IDC), data)
                self.assertNotEqual(generator.set_general_level_IDC(data, 30), data)


class EvidenceRequirementTests(unittest.TestCase):
    """Covers each validation and the message it reports."""

    def test_accepts_the_evidence_every_table_row_requires(self) -> None:
        for vector in generator.VECTORS:
            with self.subTest(variant=vector.variant):
                generator.require_vector_evidence(vector, create_matching_evidence(vector))

    def test_reports_each_mismatch_with_the_original_message(self) -> None:
        vector = generator.VECTORS[0]
        matching_evidence = create_matching_evidence(vector)
        matching_PTL_evidence = create_matching_PTL_evidence(vector)

        def change_both_parameter_sets(**changes: object) -> dict[str, object]:
            """Returns matching evidence with the same change to the SPS and VPS fields."""

            PTL_evidence = {**matching_PTL_evidence, **changes}
            return {**matching_evidence, "PTL": {"SPS": PTL_evidence, "VPS": PTL_evidence}}

        cases = (
            (
                {**matching_evidence, "accessUnitByteLengths": [1, 2]},
                "rext420-8 access-unit lengths mismatch: expected [3452,2905], got [1,2]",
            ),
            (
                {**matching_evidence, "pictureTypes": ["I", "I"]},
                'rext420-8 picture types mismatch: expected ["I","P"], got ["I","I"]',
            ),
            (
                {
                    **matching_evidence,
                    "PTL": {
                        "SPS": {**matching_PTL_evidence, "constraintPrefix": "9F.89"},
                        "VPS": matching_PTL_evidence,
                    },
                },
                'rext420-8 VPS/SPS PTL mismatch: expected {"compatibilityFlags":"08000000",'
                '"constraintPrefix":"9F.88","intraConstrained":false,"onePictureOnly":false,'
                '"profileIDC":4}, got {"compatibilityFlags":"08000000","constraintPrefix":"9F.89",'
                '"intraConstrained":false,"onePictureOnly":false,"profileIDC":4}',
            ),
            (
                change_both_parameter_sets(profileIDC=1),
                "rext420-8 profile IDC mismatch: expected 4, got 1",
            ),
            (
                change_both_parameter_sets(compatibilityFlags="60000000"),
                'rext420-8 compatibility flags mismatch: expected "08000000", got "60000000"',
            ),
            (
                change_both_parameter_sets(constraintPrefix="9D.88"),
                'rext420-8 PTL mismatch: expected "9F.88", got "9D.88"',
            ),
            (
                change_both_parameter_sets(intraConstrained=True),
                "rext420-8 intra constraint mismatch: expected false, got true",
            ),
            (
                change_both_parameter_sets(onePictureOnly=True),
                "rext420-8 one-picture constraint mismatch: expected false, got true",
            ),
            (
                {**matching_evidence, "decodedFingerprints": [0, 0]},
                "rext420-8 decoded fingerprints mismatch: expected [3329959031,201088281], got [0,0]",
            ),
            # The first failing requirement, in checking order, is the one reported
            (
                {**matching_evidence, "accessUnitByteLengths": [1, 2], "decodedFingerprints": [0, 0]},
                "rext420-8 access-unit lengths mismatch: expected [3452,2905], got [1,2]",
            ),
        )
        for evidence, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(generator.VectorGenerationError) as raised:
                    # The mismatched evidence breaks the declared shape, hence the cast
                    generator.require_vector_evidence(vector, cast(generator.VectorEvidence, evidence))
                self.assertEqual(str(raised.exception), message)

    def test_one_frame_vectors_require_one_intra_picture(self) -> None:
        vector = dataclasses.replace(
            generator.VECTORS[0],
            access_unit_byte_lengths=(3_452,),
            expected_fingerprints=(3_329_959_031,),
            frame_count=1,
        )
        generator.require_vector_evidence(vector, create_matching_evidence(vector))
        with self.assertRaises(generator.VectorGenerationError) as raised:
            generator.require_vector_evidence(
                vector,
                {**create_matching_evidence(vector), "pictureTypes": ["I", "P"]},
            )
        self.assertEqual(
            str(raised.exception),
            'rext420-8 picture types mismatch: expected ["I"], got ["I","P"]',
        )

    def test_compares_values_as_JSON_text(self) -> None:
        # True == 1 in Python, but the JSON texts differ
        with self.assertRaises(generator.VectorGenerationError) as raised:
            generator.require_equal(True, 1, "label")
        self.assertEqual(str(raised.exception), "label mismatch: expected 1, got true")
        generator.require_equal((3_452, 2_905), [3_452, 2_905], "label")


class CommandTests(unittest.TestCase):
    """Covers command failures and toolchain verification with the subprocesses replaced."""

    def test_runs_argument_lists_without_a_shell_or_inherited_input(self) -> None:
        completed = subprocess.CompletedProcess(["ffprobe"], 0, stdout=b"I\r\nP\r\n", stderr=b"")
        with patch.object(subprocess, "run", return_value=completed) as run:
            output = generator.run_text_command("ffprobe", ("-v", "error"))
        run.assert_called_once_with(
            ["ffprobe", "-v", "error"],
            capture_output=True,
            check=False,
            stdin=subprocess.DEVNULL,
        )
        # The output is decoded without newline translation
        self.assertEqual(output, generator.CommandOutput(standard_error="", standard_output="I\r\nP\r\n"))
        self.assertEqual(generator.split_output_lines(output.standard_output), ["I", "P"])
        self.assertEqual(generator.split_output_lines(""), [""])

    def test_reports_failed_commands_like_the_original(self) -> None:
        cases = (
            (generator.run_text_command, b"output", b"error", "ffmpeg failed:\nerror"),
            (generator.run_text_command, b"output", b"", "ffmpeg failed:\noutput"),
            # The binary runner reports only standard error, even when it is empty
            (generator.run_binary_command, b"output", b"", "ffmpeg failed:\n"),
            (generator.run_binary_command, b"", b"error", "ffmpeg failed:\nerror"),
        )
        for run_function, standard_output, standard_error, message in cases:
            completed = subprocess.CompletedProcess(
                ["ffmpeg"],
                1,
                stdout=standard_output,
                stderr=standard_error,
            )
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
        x265_probe_error_output: str,
    ) -> list[tuple[str, tuple[str, ...]]]:
        """Runs check_toolchain against fixed tool output and returns the commands it ran."""

        commands: list[tuple[str, tuple[str, ...]]] = []

        def run_text_command(command: str, arguments: Sequence[str]) -> generator.CommandOutput:
            commands.append((command, tuple(arguments)))
            if tuple(arguments) != ("-version",):
                return generator.CommandOutput(standard_error=x265_probe_error_output, standard_output="")
            version = ffmpeg_version if command == "ffmpeg" else ffprobe_version
            return generator.CommandOutput(standard_error="", standard_output=version)

        with patch.object(generator, "run_text_command", side_effect=run_text_command):
            generator.check_toolchain(Path("temporary"))
        return commands

    def test_accepts_the_pinned_toolchain(self) -> None:
        commands = self.check_toolchain_with(
            FFMPEG_VERSION_OUTPUT,
            FFPROBE_VERSION_OUTPUT,
            X265_PROBE_ERROR_OUTPUT,
        )
        self.assertEqual([command for command, _arguments in commands], ["ffmpeg", "ffprobe", "ffmpeg"])
        probe_arguments = commands[2][1]
        self.assertEqual(probe_arguments[-1], str(Path("temporary") / "x265-version.hevc"))
        self.assertIn(
            "info=0:pools=none:frame-threads=1:wpp=0:log-level=info:keyint=1",
            probe_arguments,
        )

    def test_rejects_any_other_toolchain(self) -> None:
        cases = (
            (
                FFMPEG_VERSION_OUTPUT.replace("862338fe31", "0123456789"),
                FFPROBE_VERSION_OUTPUT,
                X265_PROBE_ERROR_OUTPUT,
                "The installed FFmpeg/libavcodec is not the required version",
            ),
            (
                FFMPEG_VERSION_OUTPUT.replace("62. 24.100 / 62. 24.100", "62. 25.100 / 62. 25.100"),
                FFPROBE_VERSION_OUTPUT,
                X265_PROBE_ERROR_OUTPUT,
                "The installed FFmpeg/libavcodec is not the required version",
            ),
            (
                FFMPEG_VERSION_OUTPUT,
                FFPROBE_VERSION_OUTPUT.replace("2026-03-01", "2026-03-02"),
                X265_PROBE_ERROR_OUTPUT,
                "The installed FFprobe is not the required version",
            ),
            (
                FFMPEG_VERSION_OUTPUT,
                FFPROBE_VERSION_OUTPUT,
                X265_PROBE_ERROR_OUTPUT.replace("4.1+225", "4.1+226"),
                "The installed x265 is not the required version",
            ),
        )
        for ffmpeg_version, ffprobe_version, x265_probe_error_output, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(generator.VectorGenerationError) as raised:
                    self.check_toolchain_with(ffmpeg_version, ffprobe_version, x265_probe_error_output)
                self.assertEqual(str(raised.exception), message)


class ToolInvocationTests(unittest.TestCase):
    """Covers the encoder, FFprobe, and decoder command lines and how their output is read."""

    def test_encodes_with_x265_then_writes_the_level_and_patches_only_marked_vectors(self) -> None:
        commands: list[tuple[str, tuple[str, ...]]] = []

        def run_text_command(command: str, arguments: Sequence[str]) -> generator.CommandOutput:
            commands.append((command, tuple(arguments)))
            # Without level-idc, x265 signals Level 1 for these small vectors
            Path(arguments[-1]).write_bytes(LEVEL_1_STREAM)
            return generator.CommandOutput(standard_error="", standard_output="")

        with (
            tempfile.TemporaryDirectory() as temporary_directory,
            patch.object(generator, "run_text_command", side_effect=run_text_command),
        ):
            output_path = Path(temporary_directory) / "vector.hevc"
            # Both get Level 3.1; rext420-8 is also rewritten with constraint prefix 9F.88, and main422-8 keeps its profile
            for vector, generated_bytes in (
                (generator.VECTORS[0], RANGE_EXTENSION_STREAM),
                (generator.VECTORS[1], MAIN_STREAM),
            ):
                with self.subTest(variant=vector.variant):
                    generator.generate_vector(vector, output_path)
                    self.assertEqual(output_path.read_bytes(), generated_bytes)
        self.assertEqual(
            commands[1],
            (
                "ffmpeg",
                (
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=192x192:rate=1:duration=2",
                    "-frames:v",
                    "2",
                    "-pix_fmt",
                    "yuv422p",
                    "-c:v",
                    "libx265",
                    "-profile:v",
                    "main422-10",
                    "-preset",
                    "fast",
                    "-crf",
                    "32",
                    "-x265-params",
                    "info=0:pools=none:frame-threads=1:wpp=0:log-level=error:"
                    "keyint=30:min-keyint=30:scenecut=0:bframes=0:repeat-headers=1",
                    "-f",
                    "hevc",
                    "-y",
                    str(output_path),
                ),
            ),
        )

    def test_reads_packet_sizes_and_picture_types_from_FFprobe(self) -> None:
        outputs = {"packet=size": "3452\r\n2905\r\n", "frame=pict_type": "I\nP\n"}
        commands: list[tuple[str, tuple[str, ...]]] = []

        def run_text_command(command: str, arguments: Sequence[str]) -> generator.CommandOutput:
            commands.append((command, tuple(arguments)))
            return generator.CommandOutput(standard_error="", standard_output=outputs[arguments[5]])

        with patch.object(generator, "run_text_command", side_effect=run_text_command):
            self.assertEqual(generator.get_packet_byte_lengths(Path("vector.hevc")), [3_452, 2_905])
            self.assertEqual(generator.get_picture_types(Path("vector.hevc")), ["I", "P"])
        self.assertEqual(
            commands,
            [
                (
                    "ffprobe",
                    (
                        "-v",
                        "error",
                        "-select_streams",
                        "v:0",
                        "-show_entries",
                        entries,
                        "-of",
                        "csv=p=0",
                        "vector.hevc",
                    ),
                )
                for entries in ("packet=size", "frame=pict_type")
            ],
        )

    def test_reads_empty_FFprobe_output_like_the_original(self) -> None:
        # Empty output splits into one empty line, which reads as 0
        empty_output = generator.CommandOutput(standard_error="", standard_output="")
        with patch.object(generator, "run_text_command", return_value=empty_output):
            self.assertEqual(generator.get_packet_byte_lengths(Path("vector.hevc")), [0])
            self.assertEqual(generator.get_picture_types(Path("vector.hevc")), [""])

    def test_fingerprints_each_decoded_frame(self) -> None:
        vector = generator.VECTORS[1]
        geometry = generator.get_format_geometry(vector.pixel_format)
        decoded_bytes = create_pattern_frame(geometry.frame_byte_length) + bytes(geometry.frame_byte_length)
        with patch.object(generator, "run_binary_command", return_value=decoded_bytes) as run_binary_command:
            fingerprints = generator.get_decoded_fingerprints(Path("vector.hevc"), vector)
        run_binary_command.assert_called_once_with(
            "ffmpeg",
            (
                "-v",
                "error",
                "-i",
                "vector.hevc",
                "-map",
                "0:v:0",
                "-pix_fmt",
                "yuv422p",
                "-f",
                "rawvideo",
                "pipe:1",
            ),
        )
        # The Node generator's fingerprints of the pattern frame and of an all-zero frame
        self.assertEqual(fingerprints, [2_029_015_285, 3_717_041_909])

    def test_rejects_a_decode_of_unexpected_length(self) -> None:
        vector = generator.VECTORS[1]
        geometry = generator.get_format_geometry(vector.pixel_format)
        for frame_count in (1, 3):
            with self.subTest(frame_count=frame_count):
                with patch.object(
                    generator,
                    "run_binary_command",
                    return_value=bytes(geometry.frame_byte_length * frame_count),
                ):
                    with self.assertRaises(generator.VectorGenerationError) as raised:
                        generator.get_decoded_fingerprints(Path("vector.hevc"), vector)
                self.assertEqual(str(raised.exception), "main422-8 decoded raw byte length is unexpected")


class MainTests(unittest.TestCase):
    """Runs main() with the encoder replaced by the committed vectors and the table's measurements."""

    def run_main(
        self,
        arguments: Sequence[str],
        *,
        vector_directory: Path = COMMITTED_VECTOR_DIRECTORY,
        picture_types: Sequence[str] = ("I", "P"),
    ) -> tuple[int, bytes, str]:
        """Returns the exit status, the raw standard output, and the standard error text."""

        vectors_by_variant = {vector.variant: vector for vector in generator.VECTORS}

        def generate_vector(vector: generator.RangeExtensionVector, output_path: Path) -> None:
            output_path.write_bytes(read_committed_vector(vector))

        def get_packet_byte_lengths(input_path: Path) -> list[int]:
            return list(vectors_by_variant[input_path.stem].access_unit_byte_lengths)

        def get_decoded_fingerprints(
            input_path: Path,
            vector: generator.RangeExtensionVector,
        ) -> list[int]:
            return list(vector.expected_fingerprints)

        def get_picture_types(input_path: Path) -> list[str]:
            return list(picture_types)

        # A CRLF text layer, as on Windows, shows that the output bypasses newline translation
        standard_output = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", newline="\r\n")
        standard_error = io.StringIO()
        with (
            patch.object(generator, "check_toolchain"),
            patch.object(generator, "generate_vector", side_effect=generate_vector),
            patch.object(generator, "get_packet_byte_lengths", side_effect=get_packet_byte_lengths),
            patch.object(generator, "get_decoded_fingerprints", side_effect=get_decoded_fingerprints),
            patch.object(generator, "get_picture_types", side_effect=get_picture_types),
            patch.object(generator, "VECTOR_DIRECTORY", vector_directory),
            redirect_stdout(standard_output),
            redirect_stderr(standard_error),
        ):
            exit_status = generator.main(arguments)
        return exit_status, standard_output.buffer.getvalue(), standard_error.getvalue()

    def test_inspect_prints_the_original_JSON_lines(self) -> None:
        exit_status, output, errors = self.run_main(["--inspect"])
        self.assertEqual((exit_status, errors), (0, ""))
        self.assertNotIn(b"\r", output)
        lines = output.decode("utf-8").split("\n")
        self.assertEqual(lines.pop(), "")
        self.assertEqual(lines[0], RANGE_EXTENSION_8_BIT_INSPECT_LINE)
        self.assertEqual(
            [json.loads(line)["variant"] for line in lines],
            [vector.variant for vector in generator.VECTORS],
        )

    def test_check_verifies_the_committed_vectors(self) -> None:
        self.assertEqual(
            self.run_main(["--check"]),
            (0, b"Verified 9 deterministic HEVC range-extension vectors.\n", ""),
        )

    def test_generation_writes_every_vector(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            self.assertEqual(
                self.run_main([], vector_directory=output_directory),
                (0, b"Generated 9 deterministic HEVC range-extension vectors.\n", ""),
            )
            for vector in generator.VECTORS:
                with self.subTest(variant=vector.variant):
                    self.assertEqual(
                        (output_directory / f"{vector.variant}.hevc").read_bytes(),
                        read_committed_vector(vector),
                    )

    def test_check_rejects_a_committed_vector_that_differs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            for vector in generator.VECTORS:
                (output_directory / f"{vector.variant}.hevc").write_bytes(read_committed_vector(vector))
            stale_path = output_directory / "main444-12.hevc"
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
                self.run_main([], vector_directory=output_directory, picture_types=("I", "I")),
                (1, b"", 'rext420-8 picture types mismatch: expected ["I","P"], got ["I","I"]\n'),
            )
            self.assertEqual(list(output_directory.iterdir()), [])

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
