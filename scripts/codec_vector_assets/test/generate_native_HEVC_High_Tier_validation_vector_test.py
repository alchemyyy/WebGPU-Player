"""Tests the compact native HEVC High Tier vector generator contracts."""

from __future__ import annotations

import argparse
import sys
import unittest
from pathlib import Path


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import generate_native_HEVC_High_Tier_validation_vector as generator  # noqa: E402
from generate_static_HDR_validation_vectors import VectorGenerationError  # noqa: E402


def create_SPS(*, high_tier: bool) -> bytes:
    """Creates the bounded SPS prefix consumed by the generator parser."""

    RBSP = bytearray([0x01] * 13)
    RBSP[1] = generator.EXPECTED_PROFILE_IDC | (0x20 if high_tier else 0)
    RBSP[6] = 0x80
    RBSP[12] = generator.EXPECTED_LEVEL_IDC
    return b"\x00\x00\x00\x01\x42\x01" + bytes(RBSP)


class NativeHEVCHighTierVectorTests(unittest.TestCase):
    """Covers profile/tier parsing and option bounds."""

    def test_parses_exact_high_tier_profile_level(self) -> None:
        profile_tier_level = generator.parse_HEVC_profile_tier_level(
            create_SPS(high_tier=True)
        )

        self.assertEqual(
            profile_tier_level,
            generator.HEVCProfileTierLevel(
                is_high_tier=True,
                is_progressive=True,
                level_IDC=153,
                profile_IDC=2,
            ),
        )

    def test_rejects_main_tier_signaling(self) -> None:
        with self.assertRaises(VectorGenerationError):
            generator.require_expected_profile_tier_level(create_SPS(high_tier=False))

    def test_rejects_duration_outside_supported_bounds(self) -> None:
        for duration_seconds in (7, 121):
            with self.subTest(duration_seconds=duration_seconds):
                with self.assertRaises(VectorGenerationError):
                    generator.require_options(
                        argparse.Namespace(duration_seconds=duration_seconds)
                    )


if __name__ == "__main__":
    unittest.main()
