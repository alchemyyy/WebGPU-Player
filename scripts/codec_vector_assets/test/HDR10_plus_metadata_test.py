"""Tests the HDR10+ frame model, its ITU-T T.35 serialization, and the known answers the HDR10+ vector generators share."""

from __future__ import annotations

import dataclasses
import sys
import unittest
from pathlib import Path
from typing import Any


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import HDR10_plus_metadata as HDR10_plus  # noqa: E402
from generate_dolby_vision_AV1_vectors import BitReader  # noqa: E402
from media_tools import VectorGenerationError  # noqa: E402


# Two frames of the VP9 vector, and the BlockAdditionals FFmpeg 2026-03-01 wrote for them
FFMPEG_PROFILE_B_FRAME = HDR10_plus.HDR10PlusFrame(
    average_maxrgb=1_000,
    bezier_curve=HDR10_plus.BezierCurve(anchors=(102, 205, 307, 410, 512, 614, 717, 819, 922), knee_point_x=0, knee_point_y=0),
    distribution=HDR10_plus.create_distribution((100, 200, 300, 400, 500, 600, 700, 800, 900)),
    fraction_bright_pixels=0,
    maxscl=(40_000, 35_000, 30_000),
    targeted_system_display_maximum_luminance=400,
)
FFMPEG_PROFILE_B_MESSAGE = bytes.fromhex(
    "b5003c0001040140000c81388088b83a9800fa240801902803205004b0c806419007d2580962d00af2f80c83180e100040000024663353366a0099acdccf9a00"
)
FFMPEG_PROFILE_A_FRAME = HDR10_plus.HDR10PlusFrame(
    average_maxrgb=800,
    bezier_curve=None,
    distribution=HDR10_plus.create_distribution((50, 100, 150, 200, 250, 300, 350, 400, 450)),
    fraction_bright_pixels=0,
    maxscl=(6_000, 5_000, 4_000),
    targeted_system_display_maximum_luminance=0,
)
FFMPEG_PROFILE_A_MESSAGE = bytes.fromhex(
    "b5003c00010401400000002ee0138807d000c8240800c8280190500258c803219003ea5804b2d0057af806431807080000"
)
# The largest counts and values each field holds
LARGEST_FRAME = HDR10_plus.HDR10PlusFrame(
    average_maxrgb=HDR10_plus.MAXIMUM_LUMINANCE_VALUE,
    bezier_curve=HDR10_plus.BezierCurve(
        anchors=(HDR10_plus.MAXIMUM_BEZIER_ANCHOR,) * HDR10_plus.MAXIMUM_BEZIER_ANCHOR_COUNT,
        knee_point_x=HDR10_plus.MAXIMUM_KNEE_POINT,
        knee_point_y=HDR10_plus.MAXIMUM_KNEE_POINT,
    ),
    distribution=tuple(
        HDR10_plus.DistributionPercentile(percentage=percentage, percentile=HDR10_plus.MAXIMUM_LUMINANCE_VALUE)
        for percentage in range(HDR10_plus.MAXIMUM_PERCENTAGE - HDR10_plus.MAXIMUM_PERCENTILE_COUNT + 1, HDR10_plus.MAXIMUM_PERCENTAGE + 1)
    ),
    fraction_bright_pixels=HDR10_plus.MAXIMUM_FRACTION_BRIGHT_PIXELS,
    maxscl=(HDR10_plus.MAXIMUM_LUMINANCE_VALUE,) * 3,
    targeted_system_display_maximum_luminance=HDR10_plus.MAXIMUM_TARGETED_LUMINANCE,
)
# One percentile and no curve
SMALLEST_FRAME = HDR10_plus.HDR10PlusFrame(
    average_maxrgb=4,
    bezier_curve=None,
    distribution=(HDR10_plus.DistributionPercentile(percentage=50, percentile=5),),
    fraction_bright_pixels=0,
    maxscl=(1, 2, 3),
    targeted_system_display_maximum_luminance=1,
)
SAMPLE_FRAMES = (FFMPEG_PROFILE_B_FRAME, FFMPEG_PROFILE_A_FRAME, LARGEST_FRAME, SMALLEST_FRAME)
VALID_BEZIER_CURVE = HDR10_plus.BezierCurve(anchors=(512,), knee_point_x=0, knee_point_y=0)
FFPROBE_PACKETS_OUTPUT = (
    '{"packets":[{"flags":"K__","side_data_list":[{"side_data_type":"HDR10+","maxscl":"1/100000","maxscl":"2/100000"}]},'
    '{"flags":"___"}]}'
)


def read_ITUT_T35_message(message: bytes) -> dict[str, Any]:
    """Reads an HDR10+ T.35 message field by field, as ST 2094-40 codes one processing window, independently of the serializer."""

    reader = BitReader(message)
    header = [reader.read(8), reader.read(16), reader.read(16), reader.read(8)]
    fields: dict[str, Any] = {
        "applicationVersion": reader.read(8),
        "header": header,
        "windowCount": reader.read(2),
        "targetedSystemDisplayMaximumLuminance": reader.read(27),
        "targetedPeakLuminanceFlag": reader.read(1),
        "maxSCL": [reader.read(17) for _ in range(3)],
        "averageMaxRGB": reader.read(17),
    }
    fields["distributionMaxRGB"] = [
        {"percentage": reader.read(7), "percentile": reader.read(17)} for _ in range(reader.read(4))
    ]
    fields["fractionBrightPixels"] = reader.read(10)
    fields["masteringPeakLuminanceFlag"] = reader.read(1)
    fields["bezierCurve"] = None
    if reader.read(1):
        knee_point_x = reader.read(12)
        knee_point_y = reader.read(12)
        fields["bezierCurve"] = {
            "anchors": [reader.read(10) for _ in range(reader.read(4))],
            "kneePointX": knee_point_x,
            "kneePointY": knee_point_y,
        }
    fields["colorSaturationMappingFlag"] = reader.read(1)
    padding_bit_count = len(message) * 8 - reader.bit_offset
    fields["paddingBitCount"] = padding_bit_count
    fields["padding"] = reader.read(padding_bit_count)
    return fields


class SerializationTests(unittest.TestCase):
    """Covers each frame's ITU-T T.35 message and the values a frame may hold."""

    def test_serializes_each_field_where_ST_2094_40_codes_it(self) -> None:
        for frame_index, frame in enumerate(SAMPLE_FRAMES):
            with self.subTest(frame_index=frame_index):
                fields = read_ITUT_T35_message(HDR10_plus.create_HDR10_plus_ITUT_T35_message(frame))
                expected = HDR10_plus.create_expected_frame_metadata(frame)
                self.assertEqual(fields["header"], [0xB5, 0x003C, 0x0001, 4])
                for field_name in (
                    "applicationVersion",
                    "averageMaxRGB",
                    "bezierCurve",
                    "distributionMaxRGB",
                    "fractionBrightPixels",
                    "maxSCL",
                    "targetedSystemDisplayMaximumLuminance",
                    "windowCount",
                ):
                    self.assertEqual(fields[field_name], expected[field_name], field_name)
                self.assertEqual(
                    [fields["targetedPeakLuminanceFlag"], fields["masteringPeakLuminanceFlag"], fields["colorSaturationMappingFlag"]],
                    [0, 0, 0],
                )
                # Zero bits pad the payload to its last byte; a codec's trailing bits come after it
                self.assertLess(fields["paddingBitCount"], 8)
                self.assertEqual(fields["padding"], 0)

    def test_writes_the_bytes_FFmpeg_writes(self) -> None:
        self.assertEqual(HDR10_plus.create_HDR10_plus_ITUT_T35_message(FFMPEG_PROFILE_B_FRAME), FFMPEG_PROFILE_B_MESSAGE)
        self.assertEqual(HDR10_plus.create_HDR10_plus_ITUT_T35_message(FFMPEG_PROFILE_A_FRAME), FFMPEG_PROFILE_A_MESSAGE)

    def test_codes_every_field_in_order_and_pads_with_zero_bits(self) -> None:
        # Header, application version 1, one window, the targeted peak, the three MaxSCL, the average, one percentile, and the flags, in 158 bits
        expected_bits = (
            "10110101" "0000000000111100" "0000000000000001" "00000100" "00000001" "01"
            + format(1, "027b") + "0"
            + format(1, "017b") + format(2, "017b") + format(3, "017b") + format(4, "017b")
            + "0001" + format(50, "07b") + format(5, "017b")
            + format(0, "010b") + "0" + "0" + "0"
        )
        padded_bits = expected_bits + "0" * (-len(expected_bits) % 8)

        message = HDR10_plus.create_HDR10_plus_ITUT_T35_message(SMALLEST_FRAME)

        self.assertEqual(message, int(padded_bits, 2).to_bytes(len(padded_bits) // 8, "big"))

    def test_rejects_values_the_syntax_or_the_engine_cannot_take(self) -> None:
        frame = dataclasses.replace(FFMPEG_PROFILE_B_FRAME, bezier_curve=VALID_BEZIER_CURVE)
        sixteen_percentiles = tuple(
            HDR10_plus.DistributionPercentile(percentage=percentage, percentile=1)
            for percentage in range(HDR10_plus.MAXIMUM_PERCENTILE_COUNT + 1)
        )
        cases = (
            (dataclasses.replace(frame, maxscl=(HDR10_plus.MAXIMUM_LUMINANCE_VALUE + 1, 0, 0)), "luminance exceeds"),
            (dataclasses.replace(frame, targeted_system_display_maximum_luminance=10_001), "targeted display"),
            (dataclasses.replace(frame, fraction_bright_pixels=1_001), "bright-pixel fraction"),
            (
                dataclasses.replace(
                    frame,
                    distribution=(
                        HDR10_plus.DistributionPercentile(percentage=50, percentile=10),
                        HDR10_plus.DistributionPercentile(percentage=50, percentile=20),
                    ),
                ),
                "increasing percentages",
            ),
            (dataclasses.replace(frame, distribution=sixteen_percentiles), "increasing percentages"),
            (dataclasses.replace(frame, bezier_curve=dataclasses.replace(VALID_BEZIER_CURVE, anchors=())), "1 to 15 anchors"),
            (dataclasses.replace(frame, bezier_curve=dataclasses.replace(VALID_BEZIER_CURVE, anchors=(1,) * 16)), "1 to 15 anchors"),
            (dataclasses.replace(frame, bezier_curve=dataclasses.replace(VALID_BEZIER_CURVE, knee_point_x=4_096)), "exceeds its range"),
            (dataclasses.replace(frame, bezier_curve=dataclasses.replace(VALID_BEZIER_CURVE, anchors=(1_024,))), "exceeds its range"),
        )
        for invalid_frame, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(VectorGenerationError, message):
                    HDR10_plus.create_HDR10_plus_ITUT_T35_message(invalid_frame)


class KnownAnswerTests(unittest.TestCase):
    """Covers the distributions hdr10plus_tool writes and the HDR10+ side data FFprobe prints."""

    def test_writes_the_hdr10plus_tool_percentages(self) -> None:
        self.assertEqual(
            [(entry.percentage, entry.percentile) for entry in HDR10_plus.create_distribution(range(10, 100, 10))],
            [(1, 10), (5, 20), (10, 30), (25, 40), (50, 50), (75, 60), (90, 70), (95, 80), (99, 90)],
        )
        with self.assertRaises(ValueError):
            HDR10_plus.create_distribution((1, 2))

    def test_lists_the_FFprobe_fields_in_order_under_the_frame_or_packet_type(self) -> None:
        profile_B_entry = HDR10_plus.create_expected_HDR10_plus_side_data(
            FFMPEG_PROFILE_B_FRAME,
            HDR10_plus.FFPROBE_HDR10_PLUS_PACKET_SIDE_DATA_TYPE,
        )
        profile_A_entry = HDR10_plus.create_expected_HDR10_plus_side_data(
            FFMPEG_PROFILE_A_FRAME,
            HDR10_plus.FFPROBE_HDR10_PLUS_FRAME_SIDE_DATA_TYPE,
        )

        self.assertEqual(profile_B_entry[:5], [
            ("side_data_type", "HDR10+ Dynamic Metadata (SMPTE 2094-40)"),
            ("application version", 1),
            ("num_windows", 1),
            ("targeted_system_display_maximum_luminance", "400/1"),
            ("maxscl", "40000/100000"),
        ])
        self.assertEqual(profile_B_entry[-2:], [("bezier_curve_anchors", "819/1023"), ("bezier_curve_anchors", "922/1023")])
        self.assertEqual(profile_A_entry[0], ("side_data_type", "HDR Dynamic Metadata SMPTE2094-40 (HDR10+)"))
        self.assertEqual(profile_A_entry[3], ("targeted_system_display_maximum_luminance", "0/1"))
        # A frame without a curve ends at its bright-pixel fraction
        self.assertEqual(profile_A_entry[-1], ("fraction_bright_pixels", "0/1000"))
        self.assertEqual(HDR10_plus.format_rational(82, 16_384), "82/16384")


class FFprobeJSONTests(unittest.TestCase):
    """Covers reading FFprobe's JSON, whose HDR10+ side data names a field once per value."""

    def test_keeps_each_repeated_field_in_order(self) -> None:
        self.assertEqual(
            HDR10_plus.read_FFprobe_section(FFPROBE_PACKETS_OUTPUT, "packets", "vector.webm"),
            [
                {
                    "flags": "K__",
                    "side_data_list": [[("side_data_type", "HDR10+"), ("maxscl", "1/100000"), ("maxscl", "2/100000")]],
                },
                {"flags": "___"},
            ],
        )
        self.assertEqual(HDR10_plus.read_FFprobe_section("{}", "frames", "vector.mkv"), [])

    def test_rejects_a_section_that_is_not_a_list(self) -> None:
        with self.assertRaisesRegex(VectorGenerationError, "FFprobe reported no frames list for vector.mkv"):
            HDR10_plus.read_FFprobe_section('{"frames":"none"}', "frames", "vector.mkv")


if __name__ == "__main__":
    unittest.main()
