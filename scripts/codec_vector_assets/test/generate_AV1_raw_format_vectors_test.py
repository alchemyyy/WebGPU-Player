"""Tests the AV1 raw-format vector generator without running FFmpeg."""

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

import generate_AV1_raw_format_vectors as generator  # noqa: E402


# Saved before any test replaces generator.VECTOR_DIRECTORY
COMMITTED_VECTOR_DIRECTORY = generator.VECTOR_DIRECTORY
TEMPORAL_DELIMITER_OBU_TYPE = 2
FRAME_OBU_TYPE = 6
# The first line --inspect prints
MAIN_8_BIT_INSPECT_LINE = (
    '{"decodedFingerprints":[1750878287,2435266265],"pictureTypes":["I","P"],'
    '"sequenceHeader":{"bitDepth":8,"monochrome":false,"sequenceProfile":0,"subsamplingX":1,"subsamplingY":1},'
    '"temporalUnitByteLengths":[2412,1081],"variant":"main420-8"}'
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
LIBAOM_PROBE_ERROR_OUTPUT = (
    "[libaom-av1 @ 0000020b5771e600] 3.13.1-271-g85d21cdb24\r\n"
    "[libaom-av1 @ 0000020b5771e600] cmake ../ -G \"Ninja\"\r\n"
)
LIBDAV1D_PROBE_ERROR_OUTPUT = "[libdav1d @ 00000190365c9c00] libdav1d 1.5.3-18-gdaef396\r\n"

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


def create_sequence_header(
    profile: int,
    color_config: Sequence[BitField],
    *,
    reduced_still_picture_header: bool = False,
    every_optional_field: bool = False,
) -> bytes:
    """Returns a sequence header payload: libaom's choices, or every optional field present, then the color config."""

    fields: list[BitField] = [(profile, 3), (0, 1), (int(reduced_still_picture_header), 1)]
    if reduced_still_picture_header:
        fields.append((8, 5))
    elif every_optional_field:
        fields += [
            # Timing info whose num_ticks_per_picture_minus_1 is uvlc 3
            (1, 1), (1, 32), (60, 32), (1, 1), (0, 2), (1, 1), (0, 2),
            # A decoder model with 5-bit buffer delays
            (1, 1), (4, 5), (1, 32), (0, 5), (0, 5),
            # Initial display delays, then two operating points
            (1, 1), (1, 5),
            (0, 12), (8, 5), (0, 1), (1, 1), (21, 5), (10, 5), (1, 1), (1, 1), (9, 4),
            (0x101, 12), (4, 5), (0, 1), (0, 1),
        ]
    else:
        fields += [(0, 1), (0, 1), (0, 5), (0, 12), (4, 5)]
    fields += [(7, 4), (7, 4), (191, 8), (191, 8)]
    if not reduced_still_picture_header:
        fields += [(1, 1), (0, 4), (0, 3)] if every_optional_field else [(0, 1)]
    fields += [(0, 1), (1, 1), (1, 1)]
    if not reduced_still_picture_header:
        fields += [(1, 1), (1, 1), (1, 1), (1, 1), (1, 1), (1, 1), (1, 1)]
        # Forced screen content tools, then a forced integer motion vector choice
        fields += [(0, 1), (1, 1), (0, 1), (0, 1)] if every_optional_field else [(1, 1), (1, 1)]
        fields.append((6, 3))
    fields += [(0, 1), (1, 1), (1, 1), *color_config, (0, 1)]
    return pack_bit_fields(fields)


def create_OBU(OBU_type: int, payload: bytes) -> bytes:
    """Returns an OBU with a one-byte size field and no extension."""

    return bytes(((OBU_type << 3) | 0x02, len(payload))) + payload


def create_pattern_frame(byte_length: int) -> bytes:
    """Returns the byte pattern the HEVC generator's reference fingerprints were computed from with the Node generator."""

    return bytes((byte_index * 31 + 7) & 0xFF for byte_index in range(byte_length))


def read_committed_vector(vector: generator.AV1RawFormatVector) -> bytes:
    """Returns the committed bytes of one vector."""

    return (COMMITTED_VECTOR_DIRECTORY / f"{vector.variant}.obu").read_bytes()


def create_matching_evidence(vector: generator.AV1RawFormatVector) -> generator.VectorEvidence:
    """Returns evidence that satisfies every requirement for the vector."""

    return {
        "decodedFingerprints": list(vector.expected_fingerprints),
        "pictureTypes": ["I", "P"],
        "sequenceHeader": {
            "bitDepth": vector.bit_depth,
            "monochrome": False,
            "sequenceProfile": vector.sequence_profile,
            "subsamplingX": vector.subsampling[0],
            "subsamplingY": vector.subsampling[1],
        },
        "temporalUnitByteLengths": list(vector.temporal_unit_byte_lengths),
    }


class OBUParsingTests(unittest.TestCase):
    """Covers leb128 sizes, OBU headers, and every malformed stream the parser reports."""

    def test_reads_leb128_values_of_one_to_eight_bytes(self) -> None:
        cases = (
            (b"\x00", (0, 1)),
            (b"\x7F", (127, 1)),
            (b"\x80\x01", (128, 2)),
            (b"\xFF\xFF\xFF\xFF\x0F", (0xFFFF_FFFF, 5)),
            (b"\x80\x80\x80\x80\x80\x80\x80\x00", (0, 8)),
        )
        for data, expected in cases:
            with self.subTest(data=data.hex()):
                self.assertEqual(generator.read_leb128(data, 0), expected)

    def test_rejects_truncated_and_overlong_leb128_values(self) -> None:
        cases = (
            (b"\x80", "AV1 leb128 value is truncated"),
            (b"\x80" * 9, "AV1 leb128 value is longer than 8 bytes"),
        )
        for data, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(generator.VectorGenerationError) as raised:
                    generator.read_leb128(data, 0)
                self.assertEqual(str(raised.exception), message)

    def test_parses_types_and_payloads_with_and_without_an_extension(self) -> None:
        # A temporal delimiter, then a frame OBU with an extension byte and a two-byte size field
        frame_payload = bytes(range(130))
        data = create_OBU(TEMPORAL_DELIMITER_OBU_TYPE, b"") + bytes((0x36, 0x08, 0x82, 0x01)) + frame_payload
        self.assertEqual(
            generator.parse_OBUs(data),
            (
                generator.AV1OBU(OBU_type=TEMPORAL_DELIMITER_OBU_TYPE, payload=b""),
                generator.AV1OBU(OBU_type=FRAME_OBU_TYPE, payload=frame_payload),
            ),
        )

    def test_rejects_malformed_OBUs(self) -> None:
        cases = (
            (b"\x92\x00", "AV1 OBU at byte 0 sets the forbidden bit"),
            (b"\x12\x00\x30", "AV1 OBU at byte 2 has no size field"),
            (b"\x12\x00\x32\x05\x00", "AV1 OBU at byte 2 overruns the stream"),
        )
        for data, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(generator.VectorGenerationError) as raised:
                    generator.parse_OBUs(data)
                self.assertEqual(str(raised.exception), message)

    def test_requires_a_sequence_header(self) -> None:
        with self.assertRaises(generator.VectorGenerationError) as raised:
            generator.get_sequence_header_evidence(create_OBU(TEMPORAL_DELIMITER_OBU_TYPE, b""))
        self.assertEqual(str(raised.exception), "AV1 stream has no sequence header")


class SequenceHeaderTests(unittest.TestCase):
    """Covers reading seq_profile, BitDepth, mono_chrome, and the subsampling through every header branch."""

    def evidence(self, profile: int, bit_depth: int, monochrome: bool, subsampling: tuple[int, int]) -> dict[str, object]:
        return {
            "bitDepth": bit_depth,
            "monochrome": monochrome,
            "sequenceProfile": profile,
            "subsamplingX": subsampling[0],
            "subsamplingY": subsampling[1],
        }

    def test_reads_each_profile_depth_and_subsampling(self) -> None:
        # color_config() fields after high_bitdepth: twelve_bit for profile 2, mono_chrome except for profile 1,
        # color_description_present_flag, color_range, then the subsampling bits profile 2 at 12 bits codes
        cases = (
            (0, ((0, 1), (0, 1), (0, 1), (0, 1)), self.evidence(0, 8, False, (1, 1))),
            (0, ((1, 1), (0, 1), (0, 1), (1, 1)), self.evidence(0, 10, False, (1, 1))),
            (0, ((0, 1), (1, 1), (0, 1)), self.evidence(0, 8, True, (1, 1))),
            (1, ((0, 1), (0, 1), (0, 1)), self.evidence(1, 8, False, (0, 0))),
            (1, ((1, 1), (0, 1), (0, 1)), self.evidence(1, 10, False, (0, 0))),
            (2, ((0, 1), (0, 1), (0, 1), (0, 1)), self.evidence(2, 8, False, (1, 0))),
            (2, ((1, 1), (0, 1), (0, 1), (0, 1), (0, 1)), self.evidence(2, 10, False, (1, 0))),
            (2, ((1, 1), (1, 1), (0, 1), (0, 1), (0, 1), (1, 1), (1, 1)), self.evidence(2, 12, False, (1, 1))),
            (2, ((1, 1), (1, 1), (0, 1), (0, 1), (0, 1), (1, 1), (0, 1)), self.evidence(2, 12, False, (1, 0))),
            (2, ((1, 1), (1, 1), (0, 1), (0, 1), (0, 1), (0, 1)), self.evidence(2, 12, False, (0, 0))),
            # BT.709 primaries, sRGB transfer, and the identity matrix imply 4:4:4 without a color_range bit
            (2, ((0, 1), (0, 1), (1, 1), (1, 8), (13, 8), (0, 8)), self.evidence(2, 8, False, (0, 0))),
            # Other color descriptions are followed by color_range as usual
            (2, ((0, 1), (0, 1), (1, 1), (1, 8), (1, 8), (1, 8), (0, 1)), self.evidence(2, 8, False, (1, 0))),
        )
        for profile, color_config, expected in cases:
            for every_optional_field in (False, True):
                with self.subTest(profile=profile, color_config=color_config, every_optional_field=every_optional_field):
                    payload = create_sequence_header(profile, color_config, every_optional_field=every_optional_field)
                    self.assertEqual(generator.read_sequence_header_evidence(payload), expected)

    def test_reads_a_reduced_still_picture_header(self) -> None:
        payload = create_sequence_header(
            2,
            ((1, 1), (1, 1), (0, 1), (0, 1), (0, 1), (1, 1), (1, 1)),
            reduced_still_picture_header=True,
        )
        self.assertEqual(generator.read_sequence_header_evidence(payload), self.evidence(2, 12, False, (1, 1)))

    def test_rejects_a_truncated_header_and_an_overlong_uvlc(self) -> None:
        with self.assertRaises(generator.VectorGenerationError) as raised:
            generator.read_sequence_header_evidence(create_sequence_header(0, ())[:4])
        self.assertEqual(str(raised.exception), "AV1 sequence header ended unexpectedly")
        with self.assertRaises(generator.VectorGenerationError) as raised:
            generator.BitReader(bytes(5)).read_uvlc()
        self.assertEqual(str(raised.exception), "AV1 uvlc value is too large")

    def test_reads_uvlc_values(self) -> None:
        # Seven leading zeros, then a seven-bit suffix of 1, code 2^7 - 1 + 1 = 128
        for data, value in ((b"\x80", 0), (b"\x40", 1), (b"\x60", 2), (b"\x20", 3), (b"\x01\x02", 128)):
            with self.subTest(data=data.hex()):
                self.assertEqual(generator.BitReader(data).read_uvlc(), value)


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
        # Formats with the same geometry share a fingerprint, since only the geometry and bytes enter it
        frame_fingerprints = {
            "yuv420p": 4_180_004_021,
            "yuv422p": 2_029_015_285,
            "yuv444p": 1_892_189_493,
            "yuv422p10le": 3_679_872_853,
            "yuv444p10le": 2_927_224_661,
            "yuv420p12le": 344_961_109,
            "yuv422p12le": 3_679_872_853,
            "yuv444p12le": 2_927_224_661,
        }
        self.assertEqual(set(frame_fingerprints), {vector.pixel_format for vector in generator.VECTORS})
        for pixel_format, frame_fingerprint in frame_fingerprints.items():
            geometry = generator.get_format_geometry(pixel_format)
            with self.subTest(pixel_format=pixel_format):
                self.assertEqual(
                    generator.create_frame_fingerprint(create_pattern_frame(geometry.frame_byte_length), geometry),
                    frame_fingerprint,
                )

    def test_describes_the_raw_layout_of_every_pixel_format(self) -> None:
        # (bytes per component, chroma width, chroma height)
        layouts = {
            "yuv420p": (1, 96, 96),
            "yuv422p": (1, 96, 192),
            "yuv444p": (1, 192, 192),
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


class CommittedVectorTests(unittest.TestCase):
    """Parses the committed vectors in bin/codec_vector_assets/av1-raw-format/."""

    def test_sequence_headers_signal_the_table_format(self) -> None:
        for vector in generator.VECTORS:
            with self.subTest(variant=vector.variant):
                self.assertEqual(
                    generator.get_sequence_header_evidence(read_committed_vector(vector)),
                    create_matching_evidence(vector)["sequenceHeader"],
                )

    def test_temporal_units_cover_each_file_and_start_at_their_delimiters(self) -> None:
        for vector in generator.VECTORS:
            data = read_committed_vector(vector)
            key_byte_length, inter_byte_length = vector.temporal_unit_byte_lengths
            with self.subTest(variant=vector.variant):
                self.assertEqual(key_byte_length + inter_byte_length, len(data))
                key_types = [OBU.OBU_type for OBU in generator.parse_OBUs(data[:key_byte_length])]
                inter_types = [OBU.OBU_type for OBU in generator.parse_OBUs(data[key_byte_length:])]
                # Only the key temporal unit repeats the sequence header
                self.assertEqual(key_types, [TEMPORAL_DELIMITER_OBU_TYPE, generator.SEQUENCE_HEADER_OBU_TYPE, FRAME_OBU_TYPE])
                self.assertEqual(inter_types, [TEMPORAL_DELIMITER_OBU_TYPE, FRAME_OBU_TYPE])


class EvidenceRequirementTests(unittest.TestCase):
    """Covers each validation and the message it reports."""

    def test_accepts_the_evidence_every_table_row_requires(self) -> None:
        for vector in generator.VECTORS:
            with self.subTest(variant=vector.variant):
                generator.require_vector_evidence(vector, create_matching_evidence(vector))

    def test_reports_each_mismatch_with_its_message(self) -> None:
        vector = generator.VECTORS[0]
        matching_evidence = create_matching_evidence(vector)
        matching_header = matching_evidence["sequenceHeader"]
        cases = (
            (
                {**matching_evidence, "temporalUnitByteLengths": [1, 2]},
                "main420-8 temporal-unit lengths mismatch: expected [2412,1081], got [1,2]",
            ),
            (
                {**matching_evidence, "pictureTypes": ["I", "I"]},
                'main420-8 picture types mismatch: expected ["I","P"], got ["I","I"]',
            ),
            (
                {**matching_evidence, "sequenceHeader": {**matching_header, "monochrome": True}},
                'main420-8 sequence header mismatch: expected {"bitDepth":8,"monochrome":false,"sequenceProfile":0,'
                '"subsamplingX":1,"subsamplingY":1}, got {"bitDepth":8,"monochrome":true,"sequenceProfile":0,'
                '"subsamplingX":1,"subsamplingY":1}',
            ),
            (
                {**matching_evidence, "sequenceHeader": {**matching_header, "bitDepth": 10}},
                'main420-8 sequence header mismatch: expected {"bitDepth":8,"monochrome":false,"sequenceProfile":0,'
                '"subsamplingX":1,"subsamplingY":1}, got {"bitDepth":10,"monochrome":false,"sequenceProfile":0,'
                '"subsamplingX":1,"subsamplingY":1}',
            ),
            (
                {**matching_evidence, "decodedFingerprints": [0, 0]},
                "main420-8 decoded fingerprints mismatch: expected [1750878287,2435266265], got [0,0]",
            ),
            # The first failing requirement, in checking order, is the one reported
            (
                {**matching_evidence, "temporalUnitByteLengths": [1, 2], "decodedFingerprints": [0, 0]},
                "main420-8 temporal-unit lengths mismatch: expected [2412,1081], got [1,2]",
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
        generator.require_equal((2_412, 1_081), [2_412, 1_081], "label")


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
        self.assertEqual(output, generator.CommandOutput(standard_error="", standard_output="I\r\nP\r\n"))
        self.assertEqual(generator.split_output_lines(output.standard_output), ["I", "P"])
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
        libaom_probe_error_output: str,
        libdav1d_probe_error_output: str,
    ) -> list[tuple[str, tuple[str, ...]]]:
        """Runs check_toolchain against fixed tool output and returns the commands it ran."""

        commands: list[tuple[str, tuple[str, ...]]] = []

        def run_text_command(command: str, arguments: Sequence[str]) -> generator.CommandOutput:
            commands.append((command, tuple(arguments)))
            if tuple(arguments) == ("-version",):
                version = ffmpeg_version if command == "ffmpeg" else ffprobe_version
                return generator.CommandOutput(standard_error="", standard_output=version)
            error_output = libaom_probe_error_output if "libaom-av1" in arguments else libdav1d_probe_error_output
            return generator.CommandOutput(standard_error=error_output, standard_output="")

        with patch.object(generator, "run_text_command", side_effect=run_text_command):
            generator.check_toolchain(Path("temporary"))
        return commands

    def test_accepts_the_pinned_toolchain(self) -> None:
        commands = self.check_toolchain_with(
            FFMPEG_VERSION_OUTPUT,
            FFPROBE_VERSION_OUTPUT,
            LIBAOM_PROBE_ERROR_OUTPUT,
            LIBDAV1D_PROBE_ERROR_OUTPUT,
        )
        self.assertEqual([command for command, _arguments in commands], ["ffmpeg", "ffprobe", "ffmpeg", "ffmpeg"])
        probe_path = str(Path("temporary") / "libaom-version.obu")
        self.assertEqual(commands[2][1][-1], probe_path)
        self.assertIn("verbose", commands[2][1])
        # The decoder probe decodes the encoder probe's output with libdav1d
        self.assertIn(probe_path, commands[3][1])
        self.assertEqual(commands[3][1][3:5], ("-c:v", "libdav1d"))

    def test_rejects_any_other_toolchain(self) -> None:
        cases = (
            (
                FFMPEG_VERSION_OUTPUT.replace("862338fe31", "0123456789"),
                FFPROBE_VERSION_OUTPUT,
                LIBAOM_PROBE_ERROR_OUTPUT,
                LIBDAV1D_PROBE_ERROR_OUTPUT,
                "The installed FFmpeg/libavcodec is not the required version",
            ),
            (
                FFMPEG_VERSION_OUTPUT.replace("62. 24.100 / 62. 24.100", "62. 25.100 / 62. 25.100"),
                FFPROBE_VERSION_OUTPUT,
                LIBAOM_PROBE_ERROR_OUTPUT,
                LIBDAV1D_PROBE_ERROR_OUTPUT,
                "The installed FFmpeg/libavcodec is not the required version",
            ),
            (
                FFMPEG_VERSION_OUTPUT,
                FFPROBE_VERSION_OUTPUT.replace("2026-03-01", "2026-03-02"),
                LIBAOM_PROBE_ERROR_OUTPUT,
                LIBDAV1D_PROBE_ERROR_OUTPUT,
                "The installed FFprobe is not the required version",
            ),
            (
                FFMPEG_VERSION_OUTPUT,
                FFPROBE_VERSION_OUTPUT,
                LIBAOM_PROBE_ERROR_OUTPUT.replace("271-g85d21cdb24", "272-g0123456789"),
                LIBDAV1D_PROBE_ERROR_OUTPUT,
                "The installed libaom is not the required version",
            ),
            # A longer version that starts with the pinned one is another build
            (
                FFMPEG_VERSION_OUTPUT,
                FFPROBE_VERSION_OUTPUT,
                LIBAOM_PROBE_ERROR_OUTPUT.replace("g85d21cdb24", "g85d21cdb24-dirty"),
                LIBDAV1D_PROBE_ERROR_OUTPUT,
                "The installed libaom is not the required version",
            ),
            (
                FFMPEG_VERSION_OUTPUT,
                FFPROBE_VERSION_OUTPUT,
                LIBAOM_PROBE_ERROR_OUTPUT,
                LIBDAV1D_PROBE_ERROR_OUTPUT.replace("1.5.3-18", "1.5.3-19"),
                "The installed libdav1d is not the required version",
            ),
        )
        for ffmpeg_version, ffprobe_version, libaom_output, libdav1d_output, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(generator.VectorGenerationError) as raised:
                    self.check_toolchain_with(ffmpeg_version, ffprobe_version, libaom_output, libdav1d_output)
                self.assertEqual(str(raised.exception), message)


class ToolInvocationTests(unittest.TestCase):
    """Covers the encoder, FFprobe, and decoder command lines and how their output is read."""

    def test_encodes_with_serial_libaom_into_a_low_overhead_stream(self) -> None:
        with patch.object(generator, "run_text_command") as run_text_command:
            generator.generate_vector(generator.VECTORS[3], Path("vector.obu"))
        run_text_command.assert_called_once_with(
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
                "-map_metadata",
                "-1",
                "-fflags",
                "+bitexact",
                "-flags:v",
                "+bitexact",
                "-pix_fmt",
                "yuv422p",
                "-c:v",
                "libaom-av1",
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
                "-f",
                "obu",
                "-y",
                "vector.obu",
            ),
        )

    def test_reads_temporal_unit_sizes_and_picture_types_from_FFprobe(self) -> None:
        commands: list[tuple[str, tuple[str, ...]]] = []

        def run_text_command(command: str, arguments: Sequence[str]) -> generator.CommandOutput:
            commands.append((command, tuple(arguments)))
            output = "I\nP\n" if "frame=pict_type" in arguments else "2412\r\n1081\r\n"
            return generator.CommandOutput(standard_error="", standard_output=output)

        with patch.object(generator, "run_text_command", side_effect=run_text_command):
            self.assertEqual(generator.get_temporal_unit_byte_lengths(Path("vector.obu")), [2_412, 1_081])
            self.assertEqual(generator.get_picture_types(Path("vector.obu")), ["I", "P"])
        self.assertEqual(
            commands,
            [
                (
                    "ffprobe",
                    ("-v", "error", "-f", "obu", "-select_streams", "v:0", "-show_entries", "packet=size",
                     "-of", "csv=p=0", "vector.obu"),
                ),
                (
                    "ffprobe",
                    ("-v", "error", "-c:v", "libdav1d", "-f", "obu", "-select_streams", "v:0", "-show_entries",
                     "frame=pict_type", "-of", "csv=p=0", "vector.obu"),
                ),
            ],
        )

    def test_reads_empty_FFprobe_output_as_one_empty_line(self) -> None:
        empty_output = generator.CommandOutput(standard_error="", standard_output="")
        with patch.object(generator, "run_text_command", return_value=empty_output):
            self.assertEqual(generator.get_temporal_unit_byte_lengths(Path("vector.obu")), [0])
            self.assertEqual(generator.get_picture_types(Path("vector.obu")), [""])

    def test_fingerprints_each_frame_libdav1d_decodes(self) -> None:
        vector = generator.VECTORS[3]
        geometry = generator.get_format_geometry(vector.pixel_format)
        decoded_bytes = create_pattern_frame(geometry.frame_byte_length) + bytes(geometry.frame_byte_length)
        with patch.object(generator, "run_binary_command", return_value=decoded_bytes) as run_binary_command:
            fingerprints = generator.get_decoded_fingerprints(Path("vector.obu"), vector)
        run_binary_command.assert_called_once_with(
            "ffmpeg",
            (
                "-v",
                "error",
                "-c:v",
                "libdav1d",
                "-f",
                "obu",
                "-i",
                "vector.obu",
                "-map",
                "0:v:0",
                "-pix_fmt",
                "yuv422p",
                "-f",
                "rawvideo",
                "pipe:1",
            ),
        )
        # The fingerprints of the pattern frame and of an all-zero frame
        self.assertEqual(fingerprints, [2_029_015_285, 3_717_041_909])

    def test_rejects_a_decode_of_unexpected_length(self) -> None:
        vector = generator.VECTORS[3]
        geometry = generator.get_format_geometry(vector.pixel_format)
        for frame_count in (1, 3):
            with self.subTest(frame_count=frame_count):
                with patch.object(
                    generator,
                    "run_binary_command",
                    return_value=bytes(geometry.frame_byte_length * frame_count),
                ):
                    with self.assertRaises(generator.VectorGenerationError) as raised:
                        generator.get_decoded_fingerprints(Path("vector.obu"), vector)
                self.assertEqual(str(raised.exception), "professional422-8 decoded raw byte length is unexpected")


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

        def generate_vector(vector: generator.AV1RawFormatVector, output_path: Path) -> None:
            output_path.write_bytes(read_committed_vector(vector))

        def get_temporal_unit_byte_lengths(input_path: Path) -> list[int]:
            return list(vectors_by_variant[input_path.stem].temporal_unit_byte_lengths)

        def get_decoded_fingerprints(input_path: Path, vector: generator.AV1RawFormatVector) -> list[int]:
            return list(vector.expected_fingerprints)

        def get_picture_types(input_path: Path) -> list[str]:
            return list(picture_types)

        # A CRLF text layer, as on Windows, shows that the output bypasses newline translation
        standard_output = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", newline="\r\n")
        standard_error = io.StringIO()
        with (
            patch.object(generator, "check_toolchain"),
            patch.object(generator, "generate_vector", side_effect=generate_vector),
            patch.object(generator, "get_temporal_unit_byte_lengths", side_effect=get_temporal_unit_byte_lengths),
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
        self.assertEqual(lines[0], MAIN_8_BIT_INSPECT_LINE)
        self.assertEqual(
            [json.loads(line)["variant"] for line in lines],
            [vector.variant for vector in generator.VECTORS],
        )

    def test_check_verifies_the_committed_vectors(self) -> None:
        self.assertEqual(
            self.run_main(["--check"]),
            (0, b"Verified 8 deterministic AV1 raw-format vectors.\n", ""),
        )

    def test_generation_writes_every_vector(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            self.assertEqual(
                self.run_main([], vector_directory=output_directory),
                (0, b"Generated 8 deterministic AV1 raw-format vectors.\n", ""),
            )
            for vector in generator.VECTORS:
                with self.subTest(variant=vector.variant):
                    self.assertEqual(
                        (output_directory / f"{vector.variant}.obu").read_bytes(),
                        read_committed_vector(vector),
                    )

    def test_check_rejects_a_committed_vector_that_differs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            for vector in generator.VECTORS:
                (output_directory / f"{vector.variant}.obu").write_bytes(read_committed_vector(vector))
            stale_path = output_directory / "professional444-12.obu"
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
                (1, b"", 'main420-8 picture types mismatch: expected ["I","P"], got ["I","I"]\n'),
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
