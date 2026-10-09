"""Tests splitting interleaved Profile 7 access units and muxing the separate-track vector."""

from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Callable, Sequence
from unittest.mock import patch


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import create_separate_track_dolby_vision_vector as generator  # noqa: E402
import media_tools  # noqa: E402


START_CODE = b"\x00\x00\x00\x01"
FakeToolRunner = Callable[..., subprocess.CompletedProcess[bytes]]


def create_NAL_unit(NAL_unit_type: int, payload: bytes = b"\x01\x02") -> bytes:
    """Creates one HEVC NAL unit with a two-byte header."""

    return bytes((NAL_unit_type << 1, 1)) + payload


def encode_annex_B(NAL_units: Sequence[bytes]) -> bytes:
    """Prefixes every NAL unit with a four-byte start code."""

    return b"".join(START_CODE + NAL_unit for NAL_unit in NAL_units)


def create_interleaved_access_unit(
    enhancement_types: Sequence[int] = (32, 33, 34, 19),
    RPU_count: int = 1,
) -> bytes:
    """Creates BL NAL units, then RPUs, then wrapped EL NAL units."""

    base_NAL_units = [create_NAL_unit(NAL_unit_type) for NAL_unit_type in (32, 33, 34, 19)]
    enhancement_wrappers = [
        create_NAL_unit(63, create_NAL_unit(NAL_unit_type))
        for NAL_unit_type in enhancement_types
    ]
    RPU_NAL_units = [create_NAL_unit(62) for _RPU_index in range(RPU_count)]
    return encode_annex_B([*base_NAL_units, *RPU_NAL_units, *enhancement_wrappers])


def create_identification(*tracks: dict[str, object]) -> dict[str, object]:
    """Creates the subset of an mkvmerge identification that the generator reads."""

    return {"tracks": list(tracks)}


def create_HEVC_track(track_ID: object) -> dict[str, object]:
    """Creates one identified Matroska HEVC video track."""

    return {"id": track_ID, "properties": {"codec_id": "V_MPEGH/ISO/HEVC"}, "type": "video"}


def create_fake_MKVToolNix(
    commands: list[list[str]],
    interleaved_data: bytes,
    *,
    failing_tool: str | None = None,
    mux_marker: bytes = b"dvcC",
) -> FakeToolRunner:
    """Returns a subprocess.run stand-in that records commands and acts like MKVToolNix."""

    def run(command: list[str], **_options: object) -> subprocess.CompletedProcess[bytes]:
        commands.append(command)
        tool_name = Path(command[0]).stem
        arguments = command[1:]
        if tool_name == failing_tool:
            return subprocess.CompletedProcess(command, 2, b"", b"Error: simulated failure\n")
        if tool_name == "mkvextract":
            Path(arguments[2].split(":", 1)[1]).write_bytes(interleaved_data)
        elif arguments[0] == "-J":
            identification = create_identification(create_HEVC_track(0))
            return subprocess.CompletedProcess(command, 0, json.dumps(identification).encode(), b"")
        else:
            output_path = Path(arguments[arguments.index("--output") + 1])
            layer_paths = [
                Path(arguments[argument_index + 1])
                for argument_index, argument in enumerate(arguments)
                if argument == generator.DEFAULT_DURATION
            ]
            layer_data = b"".join(path.read_bytes() for path in layer_paths)
            output_path.write_bytes(b"\x1a\x45\xdf\xa3" + mux_marker + layer_data)
        return subprocess.CompletedProcess(command, 0, b"", b"")

    return run


def create_tool_directory(directory: Path) -> Path:
    """Creates placeholder mkvmerge and mkvextract executables for any platform."""

    for tool_name in ("mkvextract", "mkvmerge"):
        (directory / tool_name).write_bytes(b"")
        (directory / f"{tool_name}.exe").write_bytes(b"")
    return directory


def run_main(command_arguments: Sequence[str]) -> tuple[int, str, str]:
    """Runs the CLI and returns its exit status, standard output, and standard error."""

    standard_output = io.StringIO()
    standard_error = io.StringIO()
    with redirect_stdout(standard_output), redirect_stderr(standard_error):
        status = generator.main(command_arguments)
    return status, standard_output.getvalue(), standard_error.getvalue()


class SplitInterleavedDolbyVisionTests(unittest.TestCase):
    """Covers the BL and EL/RPU split of one interleaved access unit."""

    def get_NAL_unit_types(self, data: bytes) -> list[int]:
        """Returns the NAL unit types of a stream that uses four-byte start codes."""

        NAL_unit_types: list[int] = []
        offset = 0
        while offset < len(data):
            self.assertEqual(data[offset : offset + 4], START_CODE)
            NAL_unit_types.append((data[offset + 4] >> 1) & 0x3F)
            next_offset = offset + 6
            while (
                next_offset + 4 <= len(data)
                and data[next_offset : next_offset + 4] != START_CODE
            ):
                next_offset += 1
            offset = next_offset if next_offset + 4 <= len(data) else len(data)
        return NAL_unit_types

    def test_splits_interleaved_profile_7_into_independently_decodable_BL_and_EL_RPU_streams(
        self,
    ) -> None:
        split = generator.split_interleaved_dolby_vision_annex_B(create_interleaved_access_unit())

        self.assertEqual(self.get_NAL_unit_types(split.base_layer_data), [32, 33, 34, 19])
        self.assertEqual(
            self.get_NAL_unit_types(split.enhancement_layer_data),
            [62, 32, 33, 34, 19],
        )
        self.assertEqual(split.enhancement_wrapper_count, 4)
        self.assertEqual(split.RPU_count, 1)

    def test_rejects_missing_EL_parameter_sets_and_ambiguous_RPU_counts(self) -> None:
        with self.assertRaisesRegex(
            generator.VectorError,
            "Enhancement-layer stream has no HEVC NAL type 33",
        ):
            generator.split_interleaved_dolby_vision_annex_B(create_interleaved_access_unit(enhancement_types=(32, 34, 19)))
        with self.assertRaisesRegex(generator.VectorError, "one RPU"):
            generator.split_interleaved_dolby_vision_annex_B(create_interleaved_access_unit(RPU_count=2))

    def test_rejects_non_annex_B_input(self) -> None:
        with self.assertRaisesRegex(generator.VectorError, "not Annex B"):
            generator.split_interleaved_dolby_vision_annex_B(bytes((1, 2, 3, 4)))

    def test_finds_start_codes_where_a_byte_scan_finds_them(self) -> None:
        expected_start_codes = {
            b"\x00\x00\x01\x40": [(0, 3)],
            b"\x00\x00\x00\x01\x40": [(0, 4)],
            b"\x00\x00\x00\x00\x01\x40": [(1, 4)],
            b"\x00\x00\x01\x00\x00\x01": [(0, 3), (3, 3)],
            b"\x00\x00\x01\x00\x00\x00\x01": [(0, 3), (3, 4)],
            b"\x00\x00\x00\x01\x00\x00\x01": [(0, 4), (4, 3)],
            b"\x00\x00\x01\x00\x00\x00\x00\x01": [(0, 3), (4, 4)],
            b"\x00\x00\x00\x01\x00\x00\x00\x01": [(0, 4), (4, 4)],
            b"\x01\x00\x00\x00": [],
        }
        for data, expected in expected_start_codes.items():
            with self.subTest(data=data.hex()):
                start_codes = generator.find_annex_B_start_codes(data)
                self.assertEqual(
                    [(start_code.offset, start_code.byte_length) for start_code in start_codes],
                    expected,
                )


class MatroskaIdentificationTests(unittest.TestCase):
    """Covers track selection from Python's JSON types."""

    def test_accepts_only_one_HEVC_track_with_a_safe_integer_ID(self) -> None:
        self.assertEqual(
            generator.require_single_HEVC_video_track(create_identification(create_HEVC_track(3))),
            3,
        )
        self.assertEqual(
            generator.require_single_HEVC_video_track(create_identification(create_HEVC_track(3.0))),
            3,
        )
        audio_track = {"id": 1, "properties": {"codec_id": "A_FLAC"}, "type": "audio"}
        self.assertEqual(
            generator.require_single_HEVC_video_track(create_identification(audio_track, create_HEVC_track(0))),
            0,
        )
        invalid_identifications: tuple[object, ...] = (
            create_identification(create_HEVC_track(True)),
            create_identification(create_HEVC_track(1.5)),
            create_identification(create_HEVC_track(2**53)),
            create_identification(create_HEVC_track("1")),
            create_identification(create_HEVC_track(None)),
            create_identification(create_HEVC_track(0), create_HEVC_track(1)),
            create_identification(audio_track),
            {"tracks": "video"},
            None,
            [],
        )
        for identification in invalid_identifications:
            with self.subTest(identification=identification):
                with self.assertRaisesRegex(generator.VectorError, "exactly one Matroska HEVC"):
                    generator.require_single_HEVC_video_track(identification)

    def test_rejects_identification_output_that_is_not_strict_JSON(self) -> None:
        for standard_output in ('{"tracks": NaN}', "", "{"):
            with self.subTest(standard_output=standard_output):
                with (
                    patch.object(generator, "execute_tool", return_value=standard_output),
                    self.assertRaisesRegex(
                        generator.VectorError,
                        "invalid identification JSON for source.mkv",
                    ),
                ):
                    generator.identify_matroska("mkvmerge", os.path.join("media", "source.mkv"))


class SeparateTrackVectorTests(unittest.TestCase):
    """Covers the MKVToolNix commands, the summary, and CLI failures."""

    def test_creates_the_exact_MKVToolNix_arguments(self) -> None:
        self.assertEqual(
            generator.create_track_extraction_arguments("input.mkv", 0, "interleaved.hevc"),
            ["tracks", "input.mkv", "0:interleaved.hevc"],
        )
        self.assertEqual(
            generator.create_separate_track_MKVMerge_arguments("base.hevc", "el.hevc", "out.mkv"),
            [
                "--output",
                "out.mkv",
                "--deterministic",
                "webgpu-dolby-vision-separate-track-v1",
                "--no-date",
                "--disable-track-statistics-tags",
                "--default-duration",
                "0:24000/1001p",
                "base.hevc",
                "--default-duration",
                "0:24000/1001p",
                "el.hevc",
            ],
        )

    def test_muxes_the_repeated_layers_and_prints_the_summary(self) -> None:
        interleaved_data = create_interleaved_access_unit()
        split = generator.split_interleaved_dolby_vision_annex_B(interleaved_data)
        with tempfile.TemporaryDirectory() as temporary_directory:
            tool_directory = create_tool_directory(Path(temporary_directory))
            input_path = Path(temporary_directory) / "source.mkv"
            output_path = Path(temporary_directory) / "separate.mkv"
            input_path.write_bytes(b"source")
            commands: list[list[str]] = []
            with patch.object(
                subprocess,
                "run",
                side_effect=create_fake_MKVToolNix(commands, interleaved_data),
            ):
                status, standard_output, standard_error = run_main(
                    [
                        str(input_path),
                        str(output_path),
                        "--mkvtoolnix-directory",
                        str(tool_directory),
                    ]
                )

            self.assertEqual((status, standard_error), (0, ""))
            output_data = output_path.read_bytes()
            self.assertEqual(
                output_data,
                b"\x1a\x45\xdf\xa3dvcC"
                + split.base_layer_data * 3
                + split.enhancement_layer_data * 3,
            )
            expected_summary = {
                "baseLayerAccessUnitByteLength": len(split.base_layer_data),
                "byteLength": len(output_data),
                "enhancementLayerAccessUnitByteLength": len(split.enhancement_layer_data),
                "enhancementWrapperCount": 4,
                "outputPath": str(output_path),
                "repeatedAccessUnitCount": 3,
                "rpuCount": 1,
                "sha256": hashlib.sha256(output_data).hexdigest(),
            }
            self.assertEqual(standard_output, json.dumps(expected_summary, indent=2) + "\n")
            mkvextract_path = media_tools.resolve_MKVToolNix_tool("mkvextract", str(tool_directory))
            mkvmerge_path = media_tools.resolve_MKVToolNix_tool("mkvmerge", str(tool_directory))
            interleaved_path = commands[1][3].split(":", 1)[1]
            temporary_vector_directory = Path(interleaved_path).parent
            self.assertTrue(temporary_vector_directory.name.startswith(generator.TEMPORARY_DIRECTORY_PREFIX))
            self.assertFalse(temporary_vector_directory.exists())
            self.assertEqual(
                commands,
                [
                    [mkvmerge_path, "-J", str(input_path)],
                    [
                        mkvextract_path,
                        *generator.create_track_extraction_arguments(
                            str(input_path),
                            0,
                            str(temporary_vector_directory / "interleaved.hevc"),
                        ),
                    ],
                    [
                        mkvmerge_path,
                        *generator.create_separate_track_MKVMerge_arguments(
                            str(temporary_vector_directory / "base-layer.hevc"),
                            str(temporary_vector_directory / "enhancement-layer.hevc"),
                            str(output_path),
                        ),
                    ],
                ],
            )

    def test_reports_tool_failures_missing_dvcC_and_invalid_paths(self) -> None:
        interleaved_data = create_interleaved_access_unit()
        with tempfile.TemporaryDirectory() as temporary_directory:
            tool_directory = create_tool_directory(Path(temporary_directory))
            input_path = Path(temporary_directory) / "source.mkv"
            output_path = Path(temporary_directory) / "separate.mkv"
            input_path.write_bytes(b"source")
            vector_arguments = [
                str(input_path),
                str(output_path),
                "--mkvtoolnix-directory",
                str(tool_directory),
            ]
            commands: list[list[str]] = []
            with patch.object(
                subprocess,
                "run",
                side_effect=create_fake_MKVToolNix(
                    commands,
                    interleaved_data,
                    failing_tool="mkvextract",
                ),
            ):
                status, standard_output, standard_error = run_main(vector_arguments)
            self.assertEqual((status, standard_output), (1, ""))
            self.assertEqual(
                standard_error,
                f"Command failed: {' '.join(commands[-1])}\nError: simulated failure\n\n",
            )

            with patch.object(
                subprocess,
                "run",
                side_effect=create_fake_MKVToolNix([], interleaved_data, mux_marker=b"dvvC"),
            ):
                status, standard_output, standard_error = run_main(vector_arguments)
            self.assertEqual(
                (status, standard_output, standard_error),
                (1, "", "The separate enhancement track has no dvcC mapping\n"),
            )

            invalid_arguments = (
                (
                    [str(input_path), str(input_path)],
                    "The output path must differ from the input path",
                ),
                (
                    [str(input_path), str(output_path), "--mkvtoolnix-directory", ""],
                    "--mkvtoolnix-directory requires a directory",
                ),
            )
            for command_arguments, expected_message in invalid_arguments:
                with self.subTest(command_arguments=command_arguments):
                    status, _standard_output, standard_error = run_main(command_arguments)
                    self.assertEqual((status, standard_error), (1, expected_message + "\n"))

            missing_status, _standard_output, _standard_error = run_main(
                [str(Path(temporary_directory) / "missing.mkv"), str(output_path)]
            )
            self.assertEqual(missing_status, 1)


if __name__ == "__main__":
    unittest.main()
