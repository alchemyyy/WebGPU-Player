"""Tests the static HDR vector generator's SEI injection, metadata scan, and option limits without running FFmpeg."""

from __future__ import annotations

import argparse
import sys
import unittest
from pathlib import Path


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

from generate_static_HDR_validation_vectors import (  # noqa: E402
    VectorGenerationError,
    START_CODE,
    add_emulation_prevention_bytes,
    create_vector_definitions,
    find_annex_B_NAL_units,
    inject_prefix_SEI_NAL_units,
    remove_emulation_prevention_bytes,
    require_generator_options,
    scan_static_HDR_metadata,
)


def create_base_HEVC_stream() -> bytes:
    """Returns an Annex B stream of a VPS and an IDR slice NAL unit, each only a NAL header and a 0x80 byte."""

    video_parameter_set = bytes((32 << 1, 1, 0x80))
    VCL_NAL_unit = bytes((19 << 1, 1, 0x80))
    return START_CODE + video_parameter_set + START_CODE + VCL_NAL_unit


class StaticHDRVectorGeneratorTests(unittest.TestCase):
    """Covers the four vector states, the SEI placement, emulation prevention, and the option limits."""

    def test_constructs_every_static_HDR_scan_state(self) -> None:
        base_stream = create_base_HEVC_stream()
        for definition in create_vector_definitions():
            with self.subTest(status=definition.expected_status):
                injected_stream = inject_prefix_SEI_NAL_units(
                    base_stream, definition.injected_NAL_units
                )
                self.assertEqual(
                    scan_static_HDR_metadata(injected_stream),
                    definition.expected_status,
                )

    def test_inserts_prefix_SEI_before_the_first_VCL_unit(self) -> None:
        base_stream = create_base_HEVC_stream()
        valid_definition = create_vector_definitions()[-1]
        injected_stream = inject_prefix_SEI_NAL_units(
            base_stream, valid_definition.injected_NAL_units
        )
        NAL_types = [
            NAL_unit.nal_type for NAL_unit in find_annex_B_NAL_units(injected_stream)
        ]
        self.assertEqual(NAL_types, [32, 39, 19])

    def test_round_trips_RBSP_emulation_prevention(self) -> None:
        RBSP = b"\x00\x00\x00\x00\x00\x01\x00\x00\x02\x00\x00\x03\x04"
        escaped = add_emulation_prevention_bytes(RBSP)
        self.assertNotEqual(escaped, RBSP)
        self.assertEqual(remove_emulation_prevention_bytes(escaped), RBSP)

    def test_rejects_injection_without_a_VCL_unit(self) -> None:
        parameter_set_only = START_CODE + bytes((32 << 1, 1, 0x80))
        with self.assertRaisesRegex(VectorGenerationError, "no VCL"):
            inject_prefix_SEI_NAL_units(
                parameter_set_only,
                create_vector_definitions()[-1].injected_NAL_units,
            )

    def test_rejects_invalid_generation_bounds(self) -> None:
        base_arguments = {
            "duration_seconds": 12,
            "frame_rate": 24,
            "height": 1080,
            "width": 1920,
        }
        invalid_arguments = (
            {**base_arguments, "width": 1919},
            {**base_arguments, "height": 15},
            {**base_arguments, "frame_rate": 25},
            {**base_arguments, "duration_seconds": 7},
        )
        for values in invalid_arguments:
            with self.subTest(values=values):
                with self.assertRaises(VectorGenerationError):
                    require_generator_options(argparse.Namespace(**values))


if __name__ == "__main__":
    unittest.main()
