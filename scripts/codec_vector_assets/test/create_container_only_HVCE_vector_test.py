"""Tests neutralizing wrapped EL parameter sets so EL decode needs the container hvcE record."""

from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Sequence


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import create_container_only_HVCE_vector as generator  # noqa: E402


HVCE_BLOCK_ADD_ID_TYPE_BYTES = b"hvcE"


def create_wrapped_NAL_unit(NAL_unit_type: int, byte_length: int = 8) -> bytes:
    """Creates one length-prefixed NAL type 63 wrapper around an EL NAL unit."""

    wrapper_byte_length = byte_length + 2
    output = bytearray(b"\x55" * (4 + wrapper_byte_length))
    output[0:4] = wrapper_byte_length.to_bytes(4, "big")
    output[4] = 63 << 1
    output[5] = 1
    output[6] = NAL_unit_type << 1
    output[7] = 1
    return bytes(output)


def create_source(parameter_set_types: Sequence[int] = (32, 33, 34)) -> bytes:
    """Creates an EBML header, the hvcE mapping, then one wrapper per parameter-set type."""

    return b"".join(
        (
            bytes((0x1A, 0x45, 0xDF, 0xA3)),
            HVCE_BLOCK_ADD_ID_TYPE_BYTES,
            *(create_wrapped_NAL_unit(NAL_unit_type) for NAL_unit_type in parameter_set_types),
        )
    )


def run_main(command_arguments: Sequence[str]) -> tuple[int, str, str]:
    """Runs the CLI and returns its exit status, standard output, and standard error."""

    standard_output = io.StringIO()
    standard_error = io.StringIO()
    with redirect_stdout(standard_output), redirect_stderr(standard_error):
        status = generator.main(command_arguments)
    return status, standard_output.getvalue(), standard_error.getvalue()


class ContainerOnlyHVCEVectorTests(unittest.TestCase):
    """Covers the same-size filler replacement and its validation."""

    def test_neutralizes_one_wrapped_EL_parameter_set_of_each_type_without_changing_size(
        self,
    ) -> None:
        source = bytearray(create_source())
        original = bytes(source)

        vector = generator.create_container_only_HVCE_vector(source)

        self.assertEqual(vector.replaced_NAL_unit_types, (32, 33, 34))
        self.assertEqual(len(vector.data), len(source))
        self.assertEqual(source, original)
        for wrapper_index in range(3):
            inner_header_offset = 8 + (wrapper_index * len(create_wrapped_NAL_unit(32))) + 6
            self.assertEqual((vector.data[inner_header_offset] >> 1) & 0x3F, 38)
            self.assertEqual(vector.data[inner_header_offset + 7], 0x80)

    def test_rejects_a_source_without_an_hvcE_mapping(self) -> None:
        with self.assertRaisesRegex(generator.VectorError, "no Matroska hvcE mapping"):
            generator.create_container_only_HVCE_vector(
                b"".join(
                    (
                        create_wrapped_NAL_unit(32),
                        create_wrapped_NAL_unit(33),
                        create_wrapped_NAL_unit(34),
                    )
                )
            )

    def test_rejects_missing_and_duplicate_wrapped_EL_parameter_sets(self) -> None:
        with self.assertRaisesRegex(generator.VectorError, "NAL type 33, found 0"):
            generator.create_container_only_HVCE_vector(create_source((32, 34)))
        with self.assertRaisesRegex(generator.VectorError, "NAL type 33, found 2"):
            generator.create_container_only_HVCE_vector(create_source((32, 33, 33, 34)))

    def test_finds_wrappers_for_every_header_bit_pattern_and_at_the_buffer_bounds(self) -> None:
        wrapped_VPS = create_wrapped_NAL_unit(32, byte_length=2)
        for first_header_byte in (0x7E, 0x7F, 0xFE, 0xFF):
            with self.subTest(first_header_byte=first_header_byte):
                data = bytearray(wrapped_VPS)
                data[4] = first_header_byte
                candidates = generator.find_wrapped_enhancement_parameter_sets(data)
                self.assertEqual(
                    candidates,
                    [
                        generator.WrappedParameterSetCandidate(
                            byte_length=2,
                            inner_header_offset=6,
                            NAL_unit_type=32,
                        )
                    ],
                )
        RPU_header = bytearray(wrapped_VPS)
        RPU_header[4] = 62 << 1
        self.assertEqual(generator.find_wrapped_enhancement_parameter_sets(RPU_header), [])
        # Header bytes without room for a length prefix before or a wrapper after are skipped
        self.assertEqual(generator.find_wrapped_enhancement_parameter_sets(wrapped_VPS[1:]), [])
        trailing_headers = wrapped_VPS + bytes((0x7E, 0x7E, 0x7E))
        trailing_candidates = generator.find_wrapped_enhancement_parameter_sets(trailing_headers)
        self.assertEqual(len(trailing_candidates), 1)

    def test_writes_the_vector_and_prints_the_summary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            input_path = Path(temporary_directory) / "source.mkv"
            output_path = Path(temporary_directory) / "container-only.mkv"
            input_path.write_bytes(create_source())

            status, standard_output, standard_error = run_main([str(input_path), str(output_path)])

            self.assertEqual((status, standard_error), (0, ""))
            vector = generator.create_container_only_HVCE_vector(create_source())
            self.assertEqual(output_path.read_bytes(), vector.data)
            expected_summary = {
                "byteLength": len(vector.data),
                "outputPath": str(output_path),
                "replacedNALUnitTypes": [32, 33, 34],
                "sha256": hashlib.sha256(vector.data).hexdigest(),
            }
            self.assertEqual(standard_output, json.dumps(expected_summary, indent=2) + "\n")

    def test_reports_unsupported_sources_and_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            input_path = Path(temporary_directory) / "source.mkv"
            output_path = Path(temporary_directory) / "container-only.mkv"
            input_path.write_bytes(b"")
            failures = (
                ([str(input_path), str(output_path)], "The source vector size is unsupported\n"),
                (
                    [str(input_path), str(input_path)],
                    "The output path must differ from the input path\n",
                ),
            )
            for command_arguments, expected_message in failures:
                with self.subTest(command_arguments=command_arguments):
                    self.assertEqual(run_main(command_arguments), (1, "", expected_message))
            self.assertFalse(output_path.exists())

            missing_status, _standard_output, _standard_error = run_main(
                [str(Path(temporary_directory) / "missing.mkv"), str(output_path)]
            )
            self.assertEqual(missing_status, 1)

    def test_refuses_an_output_path_that_names_the_input_file_another_way(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            input_path = Path(temporary_directory) / "source.mkv"
            link_path = Path(temporary_directory) / "link.mkv"
            source = create_source()
            input_path.write_bytes(source)
            os.link(input_path, link_path)

            self.assertEqual(
                run_main([str(input_path), str(link_path)]),
                (1, "", "The output path must differ from the input path\n"),
            )
            self.assertEqual(input_path.read_bytes(), source)


if __name__ == "__main__":
    unittest.main()
