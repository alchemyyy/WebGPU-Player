"""Tests the Dolby Vision Profile 10 AV1 playback media generator without running FFmpeg."""

from __future__ import annotations

import argparse
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from fractions import Fraction
from pathlib import Path
from unittest.mock import patch


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import generate_dolby_vision_AV1_playback_media as playback_media  # noqa: E402
import generate_dolby_vision_AV1_vectors as vectors  # noqa: E402


def create_settings(output_directory: Path, *, overwrite: bool = False) -> playback_media.PlaybackMediaSettings:
    """Creates settings whose tools are never invoked by these tests."""

    return playback_media.PlaybackMediaSettings(
        duration_seconds=10,
        frame_rate_name="23.976",
        output_directory=output_directory,
        overwrite=overwrite,
        tools=vectors.MediaTools(FFmpeg_path="ffmpeg", FFprobe_path="ffprobe"),
    )


class RecordingBuilder:
    """Stands in for build_dolby_vision_AV1_files: records each build and writes marker bytes to its paths."""

    def __init__(self) -> None:
        self.builds: list[vectors.DolbyVisionAV1Build] = []

    def __call__(
        self,
        tools: vectors.MediaTools,
        build: vectors.DolbyVisionAV1Build,
        temporary_directory: Path,
    ) -> vectors.BuiltDolbyVisionAV1Files:
        self.builds.append(build)
        build.MP4_path.write_bytes(f"MP4 {build.sub_profile.name}".encode("ascii"))
        build.Matroska_path.write_bytes(f"Matroska {build.sub_profile.name}".encode("ascii"))
        return vectors.BuiltDolbyVisionAV1Files(
            injected_stream=vectors.InjectedStream(data=b"", temporal_units=()),
            injected_stream_path=temporary_directory / "injected.obu",
        )


class SettingsTests(unittest.TestCase):
    """Covers file names, the encode, and the CLI ranges."""

    def test_names_files_by_sub_profile_frame_rate_and_container(self) -> None:
        sub_profile = playback_media.SUB_PROFILES_BY_NAME["10.1"]
        self.assertEqual(
            playback_media.create_media_file_name(sub_profile, "23.976", vectors.MP4_FORMAT),
            "dolby-vision-profile10.1-av1-1080p23.976-aac.mp4",
        )
        self.assertEqual(
            playback_media.create_media_file_name(playback_media.SUB_PROFILES_BY_NAME["10.0"], "24", "matroska"),
            "dolby-vision-profile10.0-av1-1080p24-aac.mkv",
        )

    def test_encodes_whole_frames_with_two_second_key_frame_intervals(self) -> None:
        self.assertEqual(
            playback_media.create_encode_settings(10, "23.976"),
            vectors.AV1EncodeSettings(
                constant_rate_factor=30,
                frame_count=240,
                frame_rate=Fraction(24_000, 1_001),
                height=1080,
                key_frame_interval=48,
                row_multithreading=True,
                thread_count=0,
                tile_layout="2x2",
                width=1920,
            ),
        )
        settings = playback_media.create_encode_settings(7, "24")
        self.assertEqual((settings.frame_count, settings.key_frame_interval), (168, 48))

    def test_parses_the_supported_CLI_ranges(self) -> None:
        arguments = playback_media.create_argument_parser().parse_args([])
        self.assertEqual(arguments.sub_profiles, ["10.0", "10.1", "10.2", "10.4"])
        self.assertEqual((arguments.frame_rate, arguments.duration_seconds), ("23.976", 10))
        arguments = playback_media.create_argument_parser().parse_args(
            ["--sub-profiles", "10.4", "--frame-rate", "24", "--duration-seconds", "120"]
        )
        self.assertEqual(
            (arguments.sub_profiles, arguments.frame_rate, arguments.duration_seconds),
            (["10.4"], "24", 120),
        )
        for invalid_duration in ("1", "121"):
            with self.subTest(duration=invalid_duration):
                with self.assertRaises(argparse.ArgumentTypeError):
                    playback_media.parse_duration_seconds(invalid_duration)
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            playback_media.create_argument_parser().parse_args(["--sub-profiles", "10.3"])


class CreationTests(unittest.TestCase):
    """Covers building, verifying, and writing one sub-profile with the vector build replaced."""

    def test_builds_the_first_vector_RPU_into_every_frame_with_audio(self) -> None:
        builder = RecordingBuilder()
        with (
            tempfile.TemporaryDirectory() as temporary_directory,
            patch.object(playback_media, "build_dolby_vision_AV1_files", side_effect=builder),
        ):
            output_directory = Path(temporary_directory) / "media"
            output_paths = playback_media.create_playback_media(
                create_settings(output_directory),
                playback_media.SUB_PROFILES_BY_NAME["10.0"],
            )
            self.assertEqual(
                [path.name for path in output_paths],
                [
                    "dolby-vision-profile10.0-av1-1080p23.976-aac.mp4",
                    "dolby-vision-profile10.0-av1-1080p23.976-aac.mkv",
                ],
            )
            self.assertEqual([path.read_bytes() for path in output_paths], [b"MP4 10.0", b"Matroska 10.0"])
        build = builder.builds[0]
        self.assertEqual(build.audio_tone, playback_media.AUDIO_TONE)
        self.assertEqual(len(build.source_RPUs), 240)
        self.assertEqual({source_RPU.file_name for source_RPU in build.source_RPUs}, {"profile5.bin"})

    def test_refuses_to_replace_a_file_before_building(self) -> None:
        builder = RecordingBuilder()
        with (
            tempfile.TemporaryDirectory() as temporary_directory,
            patch.object(playback_media, "build_dolby_vision_AV1_files", side_effect=builder),
        ):
            output_directory = Path(temporary_directory)
            existing_path = output_directory / "dolby-vision-profile10.4-av1-1080p23.976-aac.mkv"
            existing_path.write_bytes(b"existing")
            sub_profile = playback_media.SUB_PROFILES_BY_NAME["10.4"]
            with self.assertRaisesRegex(vectors.VectorGenerationError, "pass --overwrite to replace it"):
                playback_media.create_playback_media(create_settings(output_directory), sub_profile)
            self.assertEqual(builder.builds, [])
            playback_media.create_playback_media(create_settings(output_directory, overwrite=True), sub_profile)
            self.assertEqual(existing_path.read_bytes(), b"Matroska 10.4")

    def test_main_builds_the_requested_sub_profiles_in_table_order(self) -> None:
        builder = RecordingBuilder()
        with (
            tempfile.TemporaryDirectory() as temporary_directory,
            patch.object(playback_media, "build_dolby_vision_AV1_files", side_effect=builder),
            redirect_stdout(io.StringIO()) as standard_output,
        ):
            exit_status = playback_media.main(
                ["--output-directory", temporary_directory, "--sub-profiles", "10.4", "10.1", "10.4"]
            )
        self.assertEqual(exit_status, 0)
        self.assertEqual([build.sub_profile.name for build in builder.builds], ["10.1", "10.4"])
        self.assertIn("dolby-vision-profile10.4-av1-1080p23.976-aac.mkv", standard_output.getvalue())

    def test_main_reports_a_failed_build(self) -> None:
        with (
            tempfile.TemporaryDirectory() as temporary_directory,
            patch.object(
                playback_media,
                "build_dolby_vision_AV1_files",
                side_effect=vectors.VectorGenerationError("Profile 10.0 bitstream RPUs mismatch"),
            ),
            redirect_stderr(io.StringIO()) as standard_error,
        ):
            exit_status = playback_media.main(["--output-directory", temporary_directory])
            self.assertEqual(list(Path(temporary_directory).iterdir()), [])
        self.assertEqual(exit_status, 1)
        self.assertEqual(
            standard_error.getvalue(),
            "Dolby Vision AV1 playback media generation failed: Profile 10.0 bitstream RPUs mismatch\n",
        )


if __name__ == "__main__":
    unittest.main()
