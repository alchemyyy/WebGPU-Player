"""Tests the dual-track Dolby Vision MP4 patcher, its FFmpeg remux, and its CLI."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Callable
from unittest.mock import patch


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import create_dual_track_dolby_vision_MP4_vector as generator  # noqa: E402
from vector_test_support import box, run_main  # noqa: E402


VISUAL_SAMPLE_ENTRY_FIELD_BYTE_LENGTH = 78
SUMMARY_KEYS = [
    "baseHeight",
    "baseTrackID",
    "baseWidth",
    "byteLength",
    "enhancementHeight",
    "enhancementSampleEntryType",
    "enhancementTrackID",
    "enhancementWidth",
    "outputPath",
    "sha256",
]


def unsigned_32(value: int) -> bytes:
    """Encodes one big-endian unsigned 32-bit integer."""

    return value.to_bytes(4, "big")


def full_box(box_type: str, payload: bytes, version: int = 0) -> bytes:
    """Creates one full box with the given version and zero flags."""

    return box(box_type, b"".join([bytes((version, 0, 0, 0)), payload]))


def create_HEVC_configuration(seed: int = 0x20) -> bytes:
    """Creates a deterministic 23-byte hvcC payload."""

    configuration = bytearray(23)
    configuration[0] = 1
    for byte_index in range(1, len(configuration)):
        configuration[byte_index] = (seed + byte_index) & 0xFF
    return bytes(configuration)


def create_dolby_vision_configuration(
    *,
    profile: int = 7,
    RPU_present: bool = True,
    enhancement_layer_present: bool = True,
    base_layer_present: bool = True,
) -> bytes:
    """Creates a 24-byte level 6 dvcC payload with the given profile and flags."""

    configuration = bytearray(24)
    configuration[0] = 1
    bits = (
        (profile << 9)
        | (6 << 3)
        | (4 if RPU_present else 0)
        | (2 if enhancement_layer_present else 0)
        | (1 if base_layer_present else 0)
    )
    configuration[2:4] = bits.to_bytes(2, "big")
    return bytes(configuration)


def create_visual_sample_entry_fields(picture_size: tuple[int, int]) -> bytes:
    """Creates the VisualSampleEntry field bytes with the given width and height and every other field zero."""

    fields = bytearray(VISUAL_SAMPLE_ENTRY_FIELD_BYTE_LENGTH)
    width, height = picture_size
    fields[24:26] = width.to_bytes(2, "big")
    fields[26:28] = height.to_bytes(2, "big")
    return bytes(fields)


def create_track(
    *,
    track_ID: int,
    sample_entry_type: str | None = None,
    dolby_vision_configuration: bytes | None = None,
    track_reference: bytes | None = None,
    track_header_version: int = 0,
    picture_size: tuple[int, int] = (0, 0),
) -> bytes:
    """Creates one minimal HEVC video trak box."""

    # Version 1 track headers carry 64-bit creation and modification times
    time_byte_length = 16 if track_header_version == 1 else 8
    track_header = full_box(
        "tkhd",
        b"".join([bytes(time_byte_length), unsigned_32(track_ID)]),
        track_header_version,
    )
    handler = full_box("hdlr", b"".join([bytes(4), b"vide"]))
    sample_children = [box("hvcC", create_HEVC_configuration(track_ID * 16))]
    if dolby_vision_configuration is not None:
        sample_children.append(box("dvcC", dolby_vision_configuration))
    sample_entry = box(
        "hvc1" if sample_entry_type is None else sample_entry_type,
        b"".join([create_visual_sample_entry_fields(picture_size), *sample_children]),
    )
    sample_description = full_box("stsd", b"".join([unsigned_32(1), sample_entry]))
    track_children = [track_header]
    if track_reference is not None:
        track_children.append(track_reference)
    track_children.append(box("mdia", b"".join([handler, box("minf", box("stbl", sample_description))])))
    return box("trak", b"".join(track_children))


def create_MP4(
    *,
    base_track_ID: int = 1,
    enhancement_track_ID: int = 2,
    sample_entry_type: str | None = None,
    dolby_vision_configuration: bytes | None = None,
    track_reference: bytes | None = None,
    movie_before_media_data: bool = False,
    track_header_version: int = 0,
    base_picture_size: tuple[int, int] = (0, 0),
    enhancement_picture_size: tuple[int, int] = (0, 0),
) -> bytes:
    """Creates a minimal two-track MP4 whose second track carries dvcC."""

    base_track = create_track(
        track_ID=base_track_ID,
        sample_entry_type=sample_entry_type,
        track_header_version=track_header_version,
        picture_size=base_picture_size,
    )
    enhancement_track = create_track(
        track_ID=enhancement_track_ID,
        sample_entry_type=sample_entry_type,
        dolby_vision_configuration=(
            create_dolby_vision_configuration()
            if dolby_vision_configuration is None
            else dolby_vision_configuration
        ),
        track_reference=track_reference,
        track_header_version=track_header_version,
        picture_size=enhancement_picture_size,
    )
    movie = box("moov", b"".join([base_track, enhancement_track]))
    media_data = box("mdat", bytes((1,)))
    if movie_before_media_data:
        return b"".join([box("ftyp"), movie, media_data])
    return b"".join([box("ftyp"), media_data, movie])


def find_marker(data: bytes, marker: str) -> int:
    """Returns the first offset of an ASCII marker, or -1."""

    return data.find(marker.encode("ascii"))


def create_FFmpeg_runner(
    output_data: bytes,
    commands: list[list[str]],
) -> Callable[..., subprocess.CompletedProcess[bytes]]:
    """Returns a subprocess.run stand-in that records commands and writes FFmpeg output."""

    def run_FFmpeg(
        command: list[str],
        **_options: object,
    ) -> subprocess.CompletedProcess[bytes]:
        commands.append(command)
        Path(command[-1]).write_bytes(output_data)
        return subprocess.CompletedProcess(command, 0, stdout=b"", stderr=b"")

    return run_FFmpeg


class DualTrackPatchTests(unittest.TestCase):
    """Covers the ISO base media patch with synthetic two-track MP4 files."""

    def assert_vector_error(self, source: bytes, message: str) -> None:
        """Asserts that patching raises a VectorError, not a subclass, with the given message."""

        with self.assertRaises(generator.VectorError) as raised:
            generator.patch_dual_track_dolby_vision_MP4(source)
        self.assertIs(type(raised.exception), generator.VectorError)
        self.assertEqual(str(raised.exception), message)

    def test_patches_hvc1_into_a_dependent_dvh1_Profile_7_enhancement_track(self) -> None:
        source = create_MP4()
        result = generator.patch_dual_track_dolby_vision_MP4(source)

        self.assertEqual(result.base_track_ID, 1)
        self.assertEqual(result.enhancement_track_ID, 2)
        self.assertEqual(result.enhancement_sample_entry_type, "dvh1")
        self.assertEqual(len(result.data), len(source) + 20)
        self.assertGreater(find_marker(result.data, "dvh1"), 0)
        configuration_marker_offset = find_marker(result.data, "dvcC")
        self.assertEqual(result.data[configuration_marker_offset + 7] & 1, 0)
        dependency_marker_offset = find_marker(result.data, "vdep")
        self.assertEqual(
            int.from_bytes(
                result.data[dependency_marker_offset + 4 : dependency_marker_offset + 8],
                "big",
            ),
            1,
        )

    def test_maps_hev1_enhancement_samples_to_dvhe(self) -> None:
        result = generator.patch_dual_track_dolby_vision_MP4(create_MP4(sample_entry_type="hev1"))

        self.assertEqual(result.enhancement_sample_entry_type, "dvhe")
        self.assertGreater(find_marker(result.data, "dvhe"), 0)

    def test_rejects_media_data_after_the_movie_box(self) -> None:
        self.assert_vector_error(
            create_MP4(movie_before_media_data=True),
            "All vector media data must precede the movie box",
        )

    def test_rejects_a_preexisting_track_reference(self) -> None:
        self.assert_vector_error(
            create_MP4(track_reference=box("tref", box("vdep", unsigned_32(1)))),
            "The enhancement source already contains a track reference",
        )

    def test_rejects_duplicate_track_IDs(self) -> None:
        self.assert_vector_error(
            create_MP4(enhancement_track_ID=1),
            "The vector track IDs are duplicated",
        )

    def test_rejects_invalid_Dolby_Vision_enhancement_configurations(self) -> None:
        for dolby_vision_configuration in (
            create_dolby_vision_configuration(profile=8),
            create_dolby_vision_configuration(RPU_present=False),
            create_dolby_vision_configuration(enhancement_layer_present=False),
        ):
            with self.subTest(dolby_vision_configuration=dolby_vision_configuration.hex()):
                self.assert_vector_error(
                    create_MP4(dolby_vision_configuration=dolby_vision_configuration),
                    "The enhancement track is not an RPU-bearing Profile 7 EL",
                )

    def test_rejects_malformed_and_non_ISO_input(self) -> None:
        with self.assertRaises(generator.VectorError):
            generator.patch_dual_track_dolby_vision_MP4(b"not an mp4")
        self.assert_vector_error(b"", "The MP4 vector size is unsupported")

    def test_accepts_a_64_bit_media_data_box(self) -> None:
        compact_source = create_MP4()
        # ftyp and the one-byte mdat occupy the first 17 bytes
        movie = compact_source[17:]
        extended_media_data = b"".join([unsigned_32(1), b"mdat", (17).to_bytes(8, "big"), bytes((1,))])
        source = b"".join([box("ftyp"), extended_media_data, movie])

        result = generator.patch_dual_track_dolby_vision_MP4(source)
        compact_result = generator.patch_dual_track_dolby_vision_MP4(compact_source)

        self.assertEqual(result.enhancement_track_ID, 2)
        self.assertEqual(result.data[:25], source[:25])
        self.assertEqual(result.data[25:], compact_result.data[17:])

    def test_bounds_64_bit_box_sizes_by_the_safe_integer_range(self) -> None:
        for box_byte_length, message in (
            (2**53, "An ISO base media box exceeds the safe integer range"),
            (2**53 - 1, "The ISO base media mdat box size is invalid"),
        ):
            with self.subTest(box_byte_length=box_byte_length):
                self.assert_vector_error(
                    b"".join([unsigned_32(1), b"mdat", box_byte_length.to_bytes(8, "big")]),
                    message,
                )

    def test_reads_each_layer_picture_size_from_its_sample_entry(self) -> None:
        result = generator.patch_dual_track_dolby_vision_MP4(
            create_MP4(base_picture_size=(1_920, 1_080), enhancement_picture_size=(960, 540))
        )

        self.assertEqual((result.base_width, result.base_height), (1_920, 1_080))
        self.assertEqual((result.enhancement_width, result.enhancement_height), (960, 540))

    def test_reads_version_1_track_headers_and_rejects_later_versions(self) -> None:
        result = generator.patch_dual_track_dolby_vision_MP4(create_MP4(track_header_version=1))

        self.assertEqual((result.base_track_ID, result.enhancement_track_ID), (1, 2))
        self.assert_vector_error(
            create_MP4(track_header_version=2),
            "The ISO base media track header version is unsupported",
        )


class VectorCreationTests(unittest.TestCase):
    """Covers the FFmpeg remux command, the written vector, and the summary."""

    def test_remuxes_with_FFmpeg_and_writes_the_patched_vector(self) -> None:
        source_MP4 = create_MP4()
        expected = generator.patch_dual_track_dolby_vision_MP4(source_MP4)
        commands: list[list[str]] = []
        with tempfile.TemporaryDirectory() as temporary_directory:
            input_path = os.path.join(temporary_directory, "separate.mkv")
            output_path = os.path.join(temporary_directory, "dual-track.mp4")
            FFmpeg_path = os.path.join(temporary_directory, "ffmpeg.exe")
            Path(input_path).write_bytes(b"separate-track source")
            Path(FFmpeg_path).write_bytes(b"")
            with patch.object(
                subprocess,
                "run",
                side_effect=create_FFmpeg_runner(source_MP4, commands),
            ):
                summary = generator.create_dual_track_dolby_vision_MP4_vector(
                    generator.DualTrackVectorConfiguration(
                        input_path=input_path,
                        output_path=output_path,
                        configured_FFmpeg_path=FFmpeg_path,
                    )
                )

            self.assertEqual(Path(output_path).read_bytes(), expected.data)

        self.assertEqual(len(commands), 1)
        unpatched_path = Path(commands[0][-1])
        self.assertEqual(
            commands[0],
            [
                FFmpeg_path,
                "-hide_banner",
                "-loglevel", "error",
                "-nostdin",
                "-y",
                "-i", input_path,
                "-map", "0:v:0",
                "-map", "0:v:1",
                "-c:v", "copy",
                "-tag:v:0", "hvc1",
                "-tag:v:1", "hvc1",
                "-disposition:v:0", "default",
                "-disposition:v:1", "0",
                "-map_metadata", "-1",
                "-strict", "unofficial",
                str(unpatched_path),
            ],
        )
        self.assertEqual(unpatched_path.name, "unpatched.mp4")
        self.assertTrue(unpatched_path.parent.name.startswith("webgpu-dovi-mp4-"))
        self.assertFalse(unpatched_path.parent.exists())
        self.assertEqual(list(summary), SUMMARY_KEYS)
        self.assertEqual(
            summary,
            {
                "baseHeight": 0,
                "baseTrackID": 1,
                "baseWidth": 0,
                "byteLength": len(expected.data),
                "enhancementHeight": 0,
                "enhancementSampleEntryType": "dvh1",
                "enhancementTrackID": 2,
                "enhancementWidth": 0,
                "outputPath": output_path,
                "sha256": hashlib.sha256(expected.data).hexdigest(),
            },
        )

    def test_rejects_a_source_that_is_not_a_file(self) -> None:
        with (
            tempfile.TemporaryDirectory() as temporary_directory,
            self.assertRaises(generator.VectorError) as raised,
        ):
            generator.create_dual_track_dolby_vision_MP4_vector(
                generator.DualTrackVectorConfiguration(
                    input_path=temporary_directory,
                    output_path=os.path.join(temporary_directory, "output.mp4"),
                )
            )

        self.assertEqual(str(raised.exception), "The source vector size is unsupported")


class CommandLineTests(unittest.TestCase):
    """Covers the CLI summary, its validation, and its exit statuses."""

    def test_prints_the_JSON_summary(self) -> None:
        commands: list[list[str]] = []
        with tempfile.TemporaryDirectory() as temporary_directory:
            input_path = os.path.join(temporary_directory, "separate.mkv")
            output_path = os.path.join(temporary_directory, "dual-track.mp4")
            Path(input_path).write_bytes(b"separate-track source")
            with patch.object(
                subprocess,
                "run",
                side_effect=create_FFmpeg_runner(create_MP4(), commands),
            ):
                status, stdout, stderr = run_main(generator.main, [input_path, output_path])

        self.assertEqual((status, stderr), (0, ""))
        summary = json.loads(stdout)
        self.assertEqual(list(summary), SUMMARY_KEYS)
        self.assertEqual(stdout, json.dumps(summary, indent=2) + "\n")
        self.assertEqual(summary["outputPath"], output_path)

    def test_rejects_an_output_path_that_resolves_to_the_input_path(self) -> None:
        status, stdout, stderr = run_main(generator.main, ["vector.mkv", os.path.join(".", "vector.mkv")])

        self.assertEqual((status, stdout), (1, ""))
        self.assertEqual(stderr, "The output path must differ from the input path\n")

    def test_rejects_an_empty_FFmpeg_path(self) -> None:
        status, _, stderr = run_main(generator.main, ["input.mkv", "output.mp4", "--ffmpeg", ""])

        self.assertEqual((status, stderr), (1, "--ffmpeg requires a path\n"))

    def test_fails_with_status_1_for_a_missing_input(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            missing_path = os.path.join(temporary_directory, "missing.mkv")
            status, stdout, stderr = run_main(generator.main, [missing_path, os.path.join(temporary_directory, "output.mp4")])

        self.assertEqual((status, stdout), (1, ""))
        self.assertIn("missing.mkv", stderr)

    def test_prints_help_and_exits_successfully(self) -> None:
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout), self.assertRaises(SystemExit) as raised:
            generator.main(["--help"])

        # NOTE: argparse wraps help text to the terminal width
        help_text = " ".join(stdout.getvalue().split())
        self.assertEqual(raised.exception.code, 0)
        self.assertIn("create_dual_track_dolby_vision_MP4_vector.py", help_text)
        self.assertIn("a dependent dvh1/dvhe Profile 7 enhancement track", help_text)
        self.assertIn("--ffmpeg path", help_text)


if __name__ == "__main__":
    unittest.main()
