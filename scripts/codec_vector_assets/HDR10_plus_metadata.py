"""The HDR10+ metadata the HDR10+ vector generators write, and the known answers it gives.

A frame is the ST 2094-40 values of one processing window, coded as the bitstream codes them.
Its ITU-T T.35 message runs from the country code to the byte-aligned payload, without any codec's trailing bits.
Its known answers are the coded values expectations.json records, and the HDR10+ side data FFprobe prints for it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Final, Sequence

from media_tools import BitField, VectorGenerationError, pack_bit_fields


# The ITU-T T.35 header of an HDR10+ message: the United States, Samsung's provider codes, and the ST 2094-40 application
ITU_T_T35_COUNTRY_CODE_UNITED_STATES: Final = 0xB5
SAMSUNG_PROVIDER_CODE: Final = 0x003C
HDR10_PLUS_PROVIDER_ORIENTED_CODE: Final = 0x0001
HDR10_PLUS_APPLICATION_IDENTIFIER: Final = 4
# Every payload has application version 1, one processing window, no peak luminance grids, and no saturation mapping
HDR10_PLUS_APPLICATION_VERSION: Final = 1
HDR10_PLUS_WINDOW_COUNT: Final = 1
# The largest coded values: 10000 nits in 0.1-nit units, and in nits for the targeted display
MAXIMUM_LUMINANCE_VALUE: Final = 100_000
MAXIMUM_TARGETED_LUMINANCE: Final = 10_000
MAXIMUM_PERCENTAGE: Final = 100
MAXIMUM_FRACTION_BRIGHT_PIXELS: Final = 1_000
MAXIMUM_PERCENTILE_COUNT: Final = 15
MAXIMUM_BEZIER_ANCHOR_COUNT: Final = 15
MAXIMUM_KNEE_POINT: Final = 4_095
MAXIMUM_BEZIER_ANCHOR: Final = 1_023
# The percentages hdr10plus_tool writes for a distribution
HDR10_PLUS_TOOL_PERCENTAGES: Final = (1, 5, 10, 25, 50, 75, 90, 95, 99)

# FFprobe names HDR10+ side data differently on a decoded frame and on a packet
FFPROBE_HDR10_PLUS_FRAME_SIDE_DATA_TYPE: Final = "HDR Dynamic Metadata SMPTE2094-40 (HDR10+)"
FFPROBE_HDR10_PLUS_PACKET_SIDE_DATA_TYPE: Final = "HDR10+ Dynamic Metadata (SMPTE 2094-40)"
# The denominators FFmpeg gives each coded value, which FFprobe prints them over
FFMPEG_LUMINANCE_DENOMINATOR: Final = 100_000
FFMPEG_TARGETED_LUMINANCE_DENOMINATOR: Final = 1
FFMPEG_FRACTION_BRIGHT_PIXELS_DENOMINATOR: Final = 1_000
FFMPEG_KNEE_POINT_DENOMINATOR: Final = 4_095
FFMPEG_BEZIER_ANCHOR_DENOMINATOR: Final = 1_023

# FFprobe's JSON names one field several times in an HDR10+ side data object, so each object is read as its ordered key and value pairs
SideDataEntry = list[tuple[str, Any]]


@dataclass(frozen=True)
class DistributionPercentile:
    """One distribution_maxrgb entry: a percentage and its MaxRGB percentile, in 0.1-nit units."""

    percentage: int
    percentile: int


@dataclass(frozen=True)
class BezierCurve:
    """The tone mapping of a profile B frame: the knee point in 1/4095 steps and the anchors in 1/1023 steps."""

    anchors: tuple[int, ...]
    knee_point_x: int
    knee_point_y: int


@dataclass(frozen=True)
class HDR10PlusFrame:
    """The ST 2094-40 values of one frame, coded as its single processing window codes them.

    Luminances are in 0.1-nit units, except the targeted display maximum, which is in nits.
    A profile A frame has no Bezier curve and targets a peak of 0.
    """

    average_maxrgb: int
    bezier_curve: BezierCurve | None
    distribution: tuple[DistributionPercentile, ...]
    fraction_bright_pixels: int
    maxscl: tuple[int, int, int]
    targeted_system_display_maximum_luminance: int


def create_distribution(percentiles: Sequence[int]) -> tuple[DistributionPercentile, ...]:
    """Returns the nine percentages hdr10plus_tool writes, with the given percentiles."""

    return tuple(
        DistributionPercentile(percentage=percentage, percentile=percentile)
        for percentage, percentile in zip(HDR10_PLUS_TOOL_PERCENTAGES, percentiles, strict=True)
    )


def require_valid_frame(frame: HDR10PlusFrame) -> None:
    """Requires values that the payload syntax can code and that the engine accepts."""

    luminances = (*frame.maxscl, frame.average_maxrgb, *(entry.percentile for entry in frame.distribution))
    if any(value < 0 or value > MAXIMUM_LUMINANCE_VALUE for value in luminances):
        raise VectorGenerationError("An HDR10+ luminance exceeds 10000 nits")
    if not 0 <= frame.targeted_system_display_maximum_luminance <= MAXIMUM_TARGETED_LUMINANCE:
        raise VectorGenerationError("An HDR10+ targeted display luminance exceeds 10000 nits")
    if not 0 <= frame.fraction_bright_pixels <= MAXIMUM_FRACTION_BRIGHT_PIXELS:
        raise VectorGenerationError("An HDR10+ bright-pixel fraction exceeds 1000")
    percentages = [entry.percentage for entry in frame.distribution]
    if (
        len(percentages) > MAXIMUM_PERCENTILE_COUNT
        or any(percentage < 0 or percentage > MAXIMUM_PERCENTAGE for percentage in percentages)
        or percentages != sorted(set(percentages))
    ):
        raise VectorGenerationError("An HDR10+ distribution needs at most 15 increasing percentages up to 100")
    curve = frame.bezier_curve
    if curve is None:
        return
    if not 1 <= len(curve.anchors) <= MAXIMUM_BEZIER_ANCHOR_COUNT:
        raise VectorGenerationError("An HDR10+ Bezier curve needs 1 to 15 anchors")
    if (
        not 0 <= curve.knee_point_x <= MAXIMUM_KNEE_POINT
        or not 0 <= curve.knee_point_y <= MAXIMUM_KNEE_POINT
        or any(anchor < 0 or anchor > MAXIMUM_BEZIER_ANCHOR for anchor in curve.anchors)
    ):
        raise VectorGenerationError("An HDR10+ Bezier curve value exceeds its range")


def create_HDR10_plus_ITUT_T35_message(frame: HDR10PlusFrame) -> bytes:
    """Serializes one frame as an ITU-T T.35 message, from its country code to its byte-aligned ST 2094-40 payload."""

    require_valid_frame(frame)
    fields: list[BitField] = [
        (ITU_T_T35_COUNTRY_CODE_UNITED_STATES, 8),
        (SAMSUNG_PROVIDER_CODE, 16),
        (HDR10_PLUS_PROVIDER_ORIENTED_CODE, 16),
        (HDR10_PLUS_APPLICATION_IDENTIFIER, 8),
        (HDR10_PLUS_APPLICATION_VERSION, 8),
        (HDR10_PLUS_WINDOW_COUNT, 2),
        (frame.targeted_system_display_maximum_luminance, 27),
        # targeted_system_display_actual_peak_luminance_flag
        (0, 1),
    ]
    fields.extend((value, 17) for value in frame.maxscl)
    fields.append((frame.average_maxrgb, 17))
    fields.append((len(frame.distribution), 4))
    for entry in frame.distribution:
        fields.extend(((entry.percentage, 7), (entry.percentile, 17)))
    fields.append((frame.fraction_bright_pixels, 10))
    # mastering_display_actual_peak_luminance_flag
    fields.append((0, 1))
    curve = frame.bezier_curve
    fields.append((0 if curve is None else 1, 1))
    if curve is not None:
        fields.extend(((curve.knee_point_x, 12), (curve.knee_point_y, 12), (len(curve.anchors), 4)))
        fields.extend((anchor, 10) for anchor in curve.anchors)
    # color_saturation_mapping_flag
    fields.append((0, 1))
    return pack_bit_fields(fields, padding_bit=0)


def create_expected_frame_metadata(frame: HDR10PlusFrame) -> dict[str, object]:
    """Returns a frame's coded ST 2094-40 values, as the known answer records them."""

    curve = frame.bezier_curve
    return {
        "applicationVersion": HDR10_PLUS_APPLICATION_VERSION,
        "averageMaxRGB": frame.average_maxrgb,
        "bezierCurve": None if curve is None else {
            "anchors": list(curve.anchors),
            "kneePointX": curve.knee_point_x,
            "kneePointY": curve.knee_point_y,
        },
        "distributionMaxRGB": [
            {"percentage": entry.percentage, "percentile": entry.percentile}
            for entry in frame.distribution
        ],
        "fractionBrightPixels": frame.fraction_bright_pixels,
        "maxSCL": list(frame.maxscl),
        "targetedSystemDisplayMaximumLuminance": frame.targeted_system_display_maximum_luminance,
        "windowCount": HDR10_PLUS_WINDOW_COUNT,
    }


def format_rational(numerator: int, denominator: int) -> str:
    """Returns a rational as FFprobe prints it, unreduced."""

    return f"{numerator}/{denominator}"


def create_expected_HDR10_plus_side_data(frame: HDR10PlusFrame, side_data_type: str) -> SideDataEntry:
    """Returns the HDR10+ side data FFmpeg decodes from a frame's message, in the order FFprobe prints its fields, under the type FFprobe names it by."""

    entry: SideDataEntry = [
        ("side_data_type", side_data_type),
        ("application version", HDR10_PLUS_APPLICATION_VERSION),
        ("num_windows", HDR10_PLUS_WINDOW_COUNT),
        (
            "targeted_system_display_maximum_luminance",
            format_rational(frame.targeted_system_display_maximum_luminance, FFMPEG_TARGETED_LUMINANCE_DENOMINATOR),
        ),
    ]
    entry.extend(("maxscl", format_rational(value, FFMPEG_LUMINANCE_DENOMINATOR)) for value in frame.maxscl)
    entry.append(("average_maxrgb", format_rational(frame.average_maxrgb, FFMPEG_LUMINANCE_DENOMINATOR)))
    entry.append(("num_distribution_maxrgb_percentiles", len(frame.distribution)))
    for distribution_entry in frame.distribution:
        entry.append(("distribution_maxrgb_percentage", distribution_entry.percentage))
        entry.append((
            "distribution_maxrgb_percentile",
            format_rational(distribution_entry.percentile, FFMPEG_LUMINANCE_DENOMINATOR),
        ))
    entry.append((
        "fraction_bright_pixels",
        format_rational(frame.fraction_bright_pixels, FFMPEG_FRACTION_BRIGHT_PIXELS_DENOMINATOR),
    ))
    curve = frame.bezier_curve
    if curve is not None:
        entry.append(("knee_point_x", format_rational(curve.knee_point_x, FFMPEG_KNEE_POINT_DENOMINATOR)))
        entry.append(("knee_point_y", format_rational(curve.knee_point_y, FFMPEG_KNEE_POINT_DENOMINATOR)))
        entry.append(("num_bezier_curve_anchors", len(curve.anchors)))
        entry.extend(
            ("bezier_curve_anchors", format_rational(anchor, FFMPEG_BEZIER_ANCHOR_DENOMINATOR))
            for anchor in curve.anchors
        )
    return entry


def read_FFprobe_section(output: str, section: str, label: str) -> list[dict[str, Any]]:
    """Returns the objects of one section of FFprobe's JSON output, such as its frames or packets.

    Their side data entries keep their fields as ordered key and value pairs, because an HDR10+ entry names a field once per value.
    """

    probe = dict(json.loads(output, object_pairs_hook=list))
    objects = probe.get(section, [])
    if not isinstance(objects, list):
        raise VectorGenerationError(f"FFprobe reported no {section} list for {label}")
    return [dict(entry) for entry in objects]
