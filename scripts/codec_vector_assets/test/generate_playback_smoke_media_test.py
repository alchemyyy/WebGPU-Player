"""Focused tests for playback smoke vector parameters."""

from __future__ import annotations

import argparse
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

from generate_playback_smoke_media import (  # noqa: E402
    HEVC_LEVEL_4_1_IDC,
    HEVC_LEVEL_4_IDC,
    HLG_TRANSFER,
    PQ_TRANSFER,
    VectorGenerationError,
    GenerationSettings,
    create_argument_parser,
    create_base_vector_name,
    create_dolby_switch_vector_name,
    create_PCM_switch_vector_name,
    create_x265_parameters,
    execute,
    get_expected_HEVC_level_IDC,
    parse_duration_seconds,
)


def create_settings(output_directory: Path) -> GenerationSettings:
    """Creates settings whose tools are never invoked by these tests."""

    return GenerationSettings(
        duration_seconds=6,
        ffmpeg_path="ffmpeg",
        ffprobe_path="ffprobe",
        height=1080,
        output_directory=output_directory,
        overwrite=False,
        resolution="1080p",
        reuse_existing_base_vectors=False,
        width=1920,
    )


class PlaybackSmokeMediaTests(unittest.TestCase):
    """Covers vector contracts without requiring codec executables."""

    def test_uses_level_4_1_only_for_1080p60(self) -> None:
        self.assertEqual(get_expected_HEVC_level_IDC("1080p", 60), HEVC_LEVEL_4_1_IDC)
        self.assertEqual(get_expected_HEVC_level_IDC("1080p", 24), HEVC_LEVEL_4_IDC)
        self.assertEqual(get_expected_HEVC_level_IDC("720p", 60), HEVC_LEVEL_4_IDC)
        self.assertIn("level-idc=4.1", create_x265_parameters("1080p", 60, PQ_TRANSFER))
        self.assertIn("level-idc=4:", create_x265_parameters("720p", 60, PQ_TRANSFER))

    def test_signals_HDR10_only_for_the_PQ_transfer(self) -> None:
        self.assertEqual(
            create_x265_parameters("1080p", 24, PQ_TRANSFER),
            "level-idc=4:high-tier=0:keyint=48:min-keyint=24:scenecut=0:"
            "repeat-headers=1:range=limited:colorprim=9:transfer=16:colormatrix=9:"
            "hdr10=1",
        )
        HLG_parameters = create_x265_parameters("1080p", 30, HLG_TRANSFER)
        self.assertIn("transfer=18", HLG_parameters)
        self.assertIn("keyint=60:min-keyint=30", HLG_parameters)
        self.assertNotIn("hdr10", HLG_parameters)

    def test_names_vectors_as_the_harness_expects(self) -> None:
        self.assertEqual(
            create_base_vector_name("1080p", 24, PQ_TRANSFER),
            "pq-main10-1080p24-aac",
        )
        self.assertEqual(
            create_base_vector_name("720p", 60, HLG_TRANSFER),
            "hlg-main10-720p60-aac",
        )
        self.assertEqual(
            create_dolby_switch_vector_name("1080p", "eac3"),
            "pq-main10-1080p24-aac-eac3.mkv",
        )
        self.assertEqual(
            create_PCM_switch_vector_name("1080p"),
            "pq-main10-1080p24-aac-pcm_s24le-44100-mono.mkv",
        )

    def test_rejects_switch_vectors_without_24_fps_before_encoding(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory) / "media"
            with self.assertRaisesRegex(VectorGenerationError, "require 24"):
                execute(
                    create_settings(output_directory),
                    (30, 60),
                    include_AC3=True,
                    include_EAC3=False,
                    include_PCM=False,
                )
            self.assertFalse(output_directory.exists())

    def test_parses_the_supported_CLI_ranges(self) -> None:
        arguments = create_argument_parser().parse_args(
            ["--frame-rates", "24", "60", "--include-ac3", "--include-pcm"]
        )
        self.assertEqual(arguments.frame_rates, [24, 60])
        self.assertTrue(arguments.include_AC3)
        self.assertFalse(arguments.include_EAC3)
        self.assertTrue(arguments.include_PCM)
        self.assertEqual(parse_duration_seconds("120"), 120)
        for invalid_duration in ("5", "121"):
            with self.subTest(duration=invalid_duration):
                with self.assertRaises(argparse.ArgumentTypeError):
                    parse_duration_seconds(invalid_duration)


if __name__ == "__main__":
    unittest.main()
