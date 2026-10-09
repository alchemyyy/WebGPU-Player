"""Tests patching dual-PID Profile 7 PMTs and creating the MPEG-TS vector through FFmpeg."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Callable, Sequence
from unittest.mock import patch


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import create_dual_PID_dolby_vision_TS_vector as generator  # noqa: E402
from vector_test_support import run_main  # noqa: E402


MPEG_TS_PACKET_BYTE_LENGTH = 188
MPEG_2_CRC_POLYNOMIAL = 0x04C1_1DB7
BASE_PID = 0x100
ENHANCEMENT_PID = 0x101
PROGRAM_MAP_PID = 0x1000
FakeToolRunner = Callable[..., subprocess.CompletedProcess[bytes]]
# A Profile 7 EL at level 3 with BL signal compatibility ID 6
LEVEL_3_CONFIGURATION = generator.DolbyVisionConfiguration(BL_signal_compatibility_ID=6, level=3)
LEVEL_3_DESCRIPTOR = bytes((0xB0, 0x07, 0x01, 0x00, 0x0E, 0x1E, 0x08, 0x00, 0x60))


def get_MPEG2_CRC32(data: bytes) -> int:
    """Returns the MPEG-2 CRC-32 independently of the generator."""

    CRC = 0xFFFF_FFFF
    for byte_value in data:
        CRC ^= byte_value << 24
        for _bit_index in range(8):
            CRC = (
                ((CRC << 1) ^ MPEG_2_CRC_POLYNOMIAL) & 0xFFFF_FFFF
                if CRC & 0x8000_0000
                else (CRC << 1) & 0xFFFF_FFFF
            )
    return CRC


def create_section(table_ID: int, body: bytes) -> bytes:
    """Creates one PSI section with its length and CRC."""

    section_length = len(body) + 4
    section_header = bytes((table_ID, 0xB0 | (section_length >> 8), section_length & 0xFF))
    section_without_CRC = section_header + body
    return section_without_CRC + get_MPEG2_CRC32(section_without_CRC).to_bytes(4, "big")


def create_elementary_stream(PID: int) -> bytes:
    """Creates one descriptor-free HEVC PMT entry."""

    return bytes((0x24, 0xE0 | (PID >> 8), PID & 0xFF, 0xF0, 0x00))


def packetize(PID: int, section: bytes, continuity_counter: int = 0) -> bytes:
    """Places one section after a zero pointer_field in one stuffed TS packet."""

    assert len(section) <= 183
    packet = bytearray(b"\xff" * MPEG_TS_PACKET_BYTE_LENGTH)
    packet[0:5] = bytes((0x47, 0x40 | (PID >> 8), PID & 0xFF, 0x10 | continuity_counter, 0))
    packet[5 : 5 + len(section)] = section
    return bytes(packet)


def create_program_association_table() -> bytes:
    """Creates a PAT that maps program 1 to the PMT PID."""

    return create_section(0x00, bytes((0x00, 0x01, 0xC1, 0x00, 0x00, 0x00, 0x01, 0xF0, 0x00)))


def create_program_map(include_enhancement: bool = True) -> bytes:
    """Creates a PMT with the HEVC BL entry and optionally the HEVC EL entry."""

    streams = [create_elementary_stream(BASE_PID)]
    if include_enhancement:
        streams.append(create_elementary_stream(ENHANCEMENT_PID))
    return create_section(
        0x02,
        bytes((0x00, 0x01, 0xC1, 0x00, 0x00, 0xE1, 0x00, 0xF0, 0x00)) + b"".join(streams),
    )


def create_transport_stream(
    include_enhancement: bool = True,
    repeated_program_map: bool = False,
) -> bytes:
    """Creates a PAT packet and one or two PMT packets."""

    packets = [
        packetize(0, create_program_association_table()),
        packetize(PROGRAM_MAP_PID, create_program_map(include_enhancement)),
    ]
    if repeated_program_map:
        packets.append(packetize(PROGRAM_MAP_PID, create_program_map(include_enhancement), 1))
    return b"".join(packets)


def create_configuration_record(**changes: object) -> dict[str, object]:
    """Returns the DOVI configuration record FFprobe prints for a level 6 Profile 7 EL, with changes."""

    record: dict[str, object] = {
        "side_data_type": "DOVI configuration record",
        "dv_version_major": 1,
        "dv_version_minor": 0,
        "dv_profile": 7,
        "dv_level": 6,
        "rpu_present_flag": 1,
        "el_present_flag": 1,
        "bl_present_flag": 0,
        "dv_bl_signal_compatibility_id": 6,
        "dv_md_compression": "none",
    }
    record.update(changes)
    return record


def create_probe_output(side_data_list: Sequence[object] | None = None) -> str:
    """Returns FFprobe's JSON for the second video track with the given side data."""

    stream: dict[str, object] = {"index": 1, "codec_name": "hevc", "width": 1_920, "height": 1_080}
    stream["side_data_list"] = [create_configuration_record()] if side_data_list is None else list(side_data_list)
    return json.dumps({"streams": [stream]})


def create_fake_tools(
    commands: list[list[str]],
    generated_data: bytes,
    *,
    exit_code: int = 0,
    probe_output: str | None = None,
) -> FakeToolRunner:
    """Returns a subprocess.run stand-in that records commands, answers FFprobe, and writes FFmpeg's MPEG-TS."""

    def run(command: list[str], **_options: object) -> subprocess.CompletedProcess[bytes]:
        commands.append(command)
        if Path(command[0]).stem == "ffprobe":
            output = create_probe_output() if probe_output is None else probe_output
            return subprocess.CompletedProcess(command, 0, output.encode("utf-8"), b"")
        if exit_code != 0:
            return subprocess.CompletedProcess(command, exit_code, b"", b"Invalid argument\n")
        Path(command[-1]).write_bytes(generated_data)
        return subprocess.CompletedProcess(command, 0, b"", b"")

    return run


class DualPIDTransportStreamTests(unittest.TestCase):
    """Covers the FFmpeg arguments and the PMT descriptor patch."""

    def test_creates_bounded_copy_only_FFmpeg_arguments_with_stable_PIDs(self) -> None:
        self.assertEqual(
            generator.create_transport_stream_FFmpeg_arguments("input.mkv", "output.ts"),
            [
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-i",
                "input.mkv",
                "-map",
                "0:v:0",
                "-map",
                "0:v:1",
                "-c:v",
                "copy",
                "-streamid",
                "0:256",
                "-streamid",
                "1:257",
                "-map_metadata",
                "-1",
                "-f",
                "mpegts",
                "output.ts",
            ],
        )

    def test_patches_every_compatible_PMT_with_a_dependency_descriptor(self) -> None:
        source_data = bytearray(create_transport_stream(True, True))
        result = generator.patch_dolby_vision_program_maps(source_data, LEVEL_3_CONFIGURATION)

        self.assertEqual(result.patched_program_map_count, 2)
        self.assertIsNot(result.output_data, source_data)
        self.assertEqual(source_data, create_transport_stream(True, True))
        self.assertNotEqual(result.output_data.find(LEVEL_3_DESCRIPTOR), -1)

        for packet_index in range(1, 3):
            packet_offset = packet_index * MPEG_TS_PACKET_BYTE_LENGTH
            section_offset = packet_offset + 5
            section_byte_length = 3 + (
                ((result.output_data[section_offset + 1] & 0x0F) << 8)
                | result.output_data[section_offset + 2]
            )
            self.assertEqual(
                get_MPEG2_CRC32(result.output_data[section_offset : section_offset + section_byte_length]),
                0,
            )

    def test_writes_the_level_and_compatibility_ID_of_the_EL_configuration(self) -> None:
        configurations = (
            (LEVEL_3_CONFIGURATION, LEVEL_3_DESCRIPTOR),
            # Profile 7, level 6, and the RPU and EL flags pack to (7 << 9) | (6 << 3) | 0b110 = 0x0E36, and ID 2 fills the high nibble of the last byte
            (
                generator.DolbyVisionConfiguration(BL_signal_compatibility_ID=2, level=6),
                bytes((0xB0, 0x07, 0x01, 0x00, 0x0E, 0x36, 0x08, 0x00, 0x20)),
            ),
            (
                generator.DolbyVisionConfiguration(BL_signal_compatibility_ID=6, level=13),
                bytes((0xB0, 0x07, 0x01, 0x00, 0x0E, 0x6E, 0x08, 0x00, 0x60)),
            ),
        )
        for configuration, descriptor in configurations:
            with self.subTest(configuration=configuration):
                self.assertEqual(
                    generator.create_dolby_vision_descriptor(BASE_PID, configuration),
                    descriptor,
                )
                result = generator.patch_dolby_vision_program_maps(
                    create_transport_stream(True),
                    configuration,
                )
                self.assertNotEqual(result.output_data.find(descriptor), -1)

    def test_rejects_a_transport_stream_without_the_enhancement_PID(self) -> None:
        with self.assertRaises(generator.TransportStreamVectorError):
            generator.patch_dolby_vision_program_maps(create_transport_stream(False), LEVEL_3_CONFIGURATION)

    def test_rejects_packet_misalignment(self) -> None:
        with self.assertRaises(generator.TransportStreamVectorError):
            generator.patch_dolby_vision_program_maps(bytes(189), LEVEL_3_CONFIGURATION)


class EnhancementLayerConfigurationTests(unittest.TestCase):
    """Covers reading the EL configuration record from FFprobe's JSON."""

    def test_probes_the_second_video_track_as_JSON(self) -> None:
        self.assertEqual(
            generator.create_enhancement_layer_probe_arguments("input.mkv"),
            ["-v", "error", "-select_streams", "v:1", "-show_streams", "-of", "json", "input.mkv"],
        )

    def test_reads_the_level_and_compatibility_ID(self) -> None:
        cases = (
            (create_probe_output(), generator.DolbyVisionConfiguration(BL_signal_compatibility_ID=6, level=6)),
            (
                create_probe_output([create_configuration_record(dv_level=1, bl_present_flag=1)]),
                generator.DolbyVisionConfiguration(BL_signal_compatibility_ID=6, level=1),
            ),
            # Other side data, such as a display matrix, is skipped
            (
                create_probe_output([{"side_data_type": "Display Matrix"}, create_configuration_record(dv_level=13)]),
                generator.DolbyVisionConfiguration(BL_signal_compatibility_ID=6, level=13),
            ),
        )
        for probe_output, configuration in cases:
            with self.subTest(configuration=configuration):
                self.assertEqual(generator.parse_enhancement_layer_configuration(probe_output), configuration)

    def test_rejects_a_missing_or_unsuitable_configuration_record(self) -> None:
        cases = (
            ("{", "FFprobe returned invalid stream JSON"),
            (json.dumps({"streams": []}), "The source has no second video track"),
            (json.dumps([]), "The source has no second video track"),
            (create_probe_output([]), "The enhancement track has no Dolby Vision configuration record"),
            (
                create_probe_output([create_configuration_record(), create_configuration_record()]),
                "The enhancement track has no Dolby Vision configuration record",
            ),
            (
                create_probe_output([create_configuration_record(dv_profile=8)]),
                "The enhancement track is not an RPU-bearing Profile 7 EL",
            ),
            (
                create_probe_output([create_configuration_record(rpu_present_flag=0)]),
                "The enhancement track is not an RPU-bearing Profile 7 EL",
            ),
            (
                create_probe_output([create_configuration_record(el_present_flag=0)]),
                "The enhancement track is not an RPU-bearing Profile 7 EL",
            ),
            (
                create_probe_output([create_configuration_record(dv_level=64)]),
                "The enhancement track has an invalid Dolby Vision dv_level",
            ),
            (
                create_probe_output([create_configuration_record(dv_level=True)]),
                "The enhancement track has an invalid Dolby Vision dv_level",
            ),
            (
                create_probe_output([create_configuration_record(dv_bl_signal_compatibility_id=16)]),
                "The enhancement track has an invalid Dolby Vision dv_bl_signal_compatibility_id",
            ),
        )
        for probe_output, message in cases:
            with self.subTest(message=message, probe_output=probe_output):
                with self.assertRaises(generator.TransportStreamVectorError) as raised:
                    generator.parse_enhancement_layer_configuration(probe_output)
                self.assertEqual(str(raised.exception), message)


class DualPIDVectorCLITests(unittest.TestCase):
    """Covers FFmpeg resolution, the summary, and CLI failures."""

    def test_writes_the_patched_stream_and_prints_the_summary(self) -> None:
        generated_data = create_transport_stream(True, True)
        with tempfile.TemporaryDirectory() as temporary_directory:
            FFmpeg_path = Path(temporary_directory) / "ffmpeg.exe"
            FFprobe_path = Path(temporary_directory) / "ffprobe.exe"
            input_path = Path(temporary_directory) / "separate.mkv"
            output_path = Path(temporary_directory) / "dual-pid.ts"
            FFmpeg_path.write_bytes(b"")
            FFprobe_path.write_bytes(b"")
            input_path.write_bytes(b"source")
            commands: list[list[str]] = []
            with patch.object(
                subprocess,
                "run",
                side_effect=create_fake_tools(commands, generated_data),
            ):
                status, standard_output, standard_error = run_main(
                    generator.main,
                    [
                        str(input_path),
                        str(output_path),
                        "--ffmpeg",
                        str(FFmpeg_path),
                        "--ffprobe",
                        str(FFprobe_path),
                    ]
                )

            self.assertEqual((status, standard_error), (0, ""))
            # The probed EL is level 6, so the descriptor carries level 6
            level_6_configuration = generator.DolbyVisionConfiguration(BL_signal_compatibility_ID=6, level=6)
            patched_data = generator.patch_dolby_vision_program_maps(
                generated_data,
                level_6_configuration,
            ).output_data
            self.assertEqual(output_path.read_bytes(), patched_data)
            expected_summary = {
                "basePID": 256,
                "colorFidelityReference": False,
                "dolbyVisionLevel": 6,
                "enhancementPID": 257,
                "outputByteLength": len(patched_data),
                "outputPath": str(output_path),
                "patchedProgramMapCount": 2,
            }
            self.assertEqual(standard_output, json.dumps(expected_summary, indent=2) + "\n")
            generated_path = Path(commands[1][-1])
            self.assertEqual(generated_path.name, "generated.ts")
            self.assertTrue(generated_path.parent.name.startswith(generator.TEMPORARY_DIRECTORY_PREFIX))
            self.assertFalse(generated_path.parent.exists())
            self.assertEqual(
                commands,
                [
                    [
                        str(FFprobe_path),
                        *generator.create_enhancement_layer_probe_arguments(str(input_path)),
                    ],
                    [
                        str(FFmpeg_path),
                        *generator.create_transport_stream_FFmpeg_arguments(
                            str(input_path),
                            str(generated_path),
                        ),
                    ],
                ],
            )

    def test_rejects_an_EL_without_a_configuration_record_before_running_FFmpeg(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            input_path = Path(temporary_directory) / "separate.mkv"
            output_path = Path(temporary_directory) / "dual-pid.ts"
            input_path.write_bytes(b"source")
            commands: list[list[str]] = []
            with patch.object(
                subprocess,
                "run",
                side_effect=create_fake_tools(
                    commands,
                    create_transport_stream(True),
                    probe_output=create_probe_output([]),
                ),
            ):
                result = run_main(generator.main, [str(input_path), str(output_path)])

            self.assertEqual(
                result,
                (1, "", "The enhancement track has no Dolby Vision configuration record\n"),
            )
            self.assertEqual([Path(command[0]).stem for command in commands], ["ffprobe"])
            self.assertFalse(output_path.exists())

    def test_reports_tool_failures_unsupported_streams_and_invalid_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            FFmpeg_path = Path(temporary_directory) / "ffmpeg.exe"
            input_path = Path(temporary_directory) / "separate.mkv"
            output_path = Path(temporary_directory) / "dual-pid.ts"
            FFmpeg_path.write_bytes(b"")
            input_path.write_bytes(b"source")
            vector_arguments = [str(input_path), str(output_path), "--ffmpeg", str(FFmpeg_path)]

            commands: list[list[str]] = []
            with patch.object(
                subprocess,
                "run",
                side_effect=create_fake_tools(commands, b"", exit_code=1),
            ):
                status, standard_output, standard_error = run_main(generator.main, vector_arguments)
            self.assertEqual(
                (status, standard_output, standard_error),
                (1, "", f"Command failed: {' '.join(commands[-1])}\nInvalid argument\n\n"),
            )

            generated_streams = (
                (
                    create_transport_stream(False),
                    "No generated PMT contains the expected HEVC BL and EL PIDs",
                ),
                (bytes(189), "The generated MPEG-TS packet alignment is invalid"),
                (b"", "The generated MPEG-TS is empty"),
            )
            for generated_data, expected_message in generated_streams:
                with self.subTest(expected_message=expected_message):
                    with patch.object(
                        subprocess,
                        "run",
                        side_effect=create_fake_tools([], generated_data),
                    ):
                        self.assertEqual(
                            run_main(generator.main, vector_arguments),
                            (1, "", expected_message + "\n"),
                        )
            self.assertFalse(output_path.exists())

            invalid_arguments = (
                (
                    [str(input_path), str(input_path)],
                    "The output path must differ from the input path\n",
                ),
                (
                    [str(input_path), str(output_path), "--ffmpeg", ""],
                    "--ffmpeg requires a path\n",
                ),
                (
                    [str(input_path), str(output_path), "--ffprobe", ""],
                    "--ffprobe requires a path\n",
                ),
            )
            for command_arguments, expected_message in invalid_arguments:
                with self.subTest(command_arguments=command_arguments):
                    self.assertEqual(run_main(generator.main, command_arguments), (1, "", expected_message))

            for command_arguments in (
                [str(Path(temporary_directory) / "missing.mkv"), str(output_path)],
                [str(input_path), str(output_path), "--ffmpeg", str(FFmpeg_path) + ".missing"],
            ):
                with self.subTest(command_arguments=command_arguments):
                    status, _standard_output, _standard_error = run_main(generator.main, command_arguments)
                    self.assertEqual(status, 1)


if __name__ == "__main__":
    unittest.main()
