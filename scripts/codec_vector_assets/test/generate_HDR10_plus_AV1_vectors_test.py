"""Tests the HDR10+ AV1 vector generator without running FFmpeg."""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any, Sequence
from unittest.mock import patch


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import generate_dolby_vision_AV1_vectors as dolby_vision_generator  # noqa: E402
import generate_HDR10_plus_AV1_vectors as generator  # noqa: E402


# Saved before any test replaces generator.VECTOR_DIRECTORY
COMMITTED_VECTOR_DIRECTORY = generator.VECTOR_DIRECTORY
VECTOR_FILE_NAMES = ("hdr10plus.mp4", "hdr10plus.mkv")
TEMPORAL_DELIMITER = bytes((0x12, 0x00))
# seq_profile 0, still_picture 0, reduced_still_picture_header 0, then arbitrary bits
SEQUENCE_HEADER_PAYLOAD = bytes((0x00, 0x00, 0x00, 0x2A))
# The first uncompressed_header() byte: show_existing_frame, frame_type (2 bits), show_frame
SHOWN_KEY_FRAME_HEADER = 0x10
SHOWN_INTER_FRAME_HEADER = 0x30
# A metadata OBU with a size field, the type every inserted OBU has
METADATA_OBU_HEADER = 0x2A
FRAME_WITHOUT_HDR10_PLUS_INDICES = (2, 4)
PROFILE_A_FRAME_INDEX = 3
# Each key frame's sample and the av1C record FFmpeg builds from the first temporal unit carry the MDCV and CLL OBUs
STATIC_METADATA_OBU_COPY_COUNT = 3
MATROSKA_EMPTY_CODEC_TAG = "[0][0][0][0]"


def create_OBU(OBU_type: int, payload: bytes) -> bytes:
    """Creates one OBU with a size field and no extension."""

    return bytes(((OBU_type << 3) | 0x02,)) + generator.encode_leb128(len(payload)) + payload


def create_frame(first_header_byte: int) -> bytes:
    """Creates a frame OBU whose header starts with the given byte."""

    return create_OBU(generator.OBUType.FRAME, bytes((first_header_byte, 0x5A, 0xA5)))


def require_HDR10_plus_frame(frame: generator.HDR10PlusFrame | None) -> generator.HDR10PlusFrame:
    """Returns a vector frame that carries HDR10+."""

    if frame is None:
        raise AssertionError("The vector frame carries no HDR10+")
    return frame


SEQUENCE_HEADER = create_OBU(generator.OBUType.SEQUENCE_HEADER, SEQUENCE_HEADER_PAYLOAD)
KEY_FRAME = create_frame(SHOWN_KEY_FRAME_HEADER)
INTER_FRAME = create_frame(SHOWN_INTER_FRAME_HEADER)
PROFILE_A_FRAME = require_HDR10_plus_frame(generator.VECTOR_FRAMES[PROFILE_A_FRAME_INDEX])


def create_vector_stream() -> bytes:
    """Creates a stream of synthetic temporal units with the vector's key frame layout."""

    return b"".join(
        TEMPORAL_DELIMITER + (SEQUENCE_HEADER + KEY_FRAME if key_frame else INTER_FRAME)
        for key_frame in generator.get_vector_key_frame_flags()
    )


def create_container_probe(container_format: str, injected_stream: generator.InjectedStream) -> dict[str, Any]:
    """Returns the FFprobe output of a container that matches the vector."""

    stream: dict[str, Any] = {
        "codec_name": "av1",
        "codec_tag_string": "av01" if container_format == generator.MP4_FORMAT else MATROSKA_EMPTY_CODEC_TAG,
        "codec_type": "video",
        "height": generator.VECTOR_HEIGHT,
        "index": 0,
        "width": generator.VECTOR_WIDTH,
        **generator.get_FFmpeg_color_names(generator.VECTOR_COLOR),
    }
    return {
        "packets": [
            {
                "flags": "K__" if temporal_unit.key_frame else "___",
                "size": str(temporal_unit.sample_byte_length),
                "stream_index": 0,
            }
            for temporal_unit in injected_stream.temporal_units
        ],
        "streams": [stream],
    }


def format_FFprobe_frames(frames: Sequence[Sequence[generator.SideDataEntry]]) -> str:
    """Writes frame side data as FFprobe's JSON does, which names a field once per value."""

    def format_entry(entry: generator.SideDataEntry) -> str:
        return "{" + ",".join(f"{json.dumps(key)}:{json.dumps(value)}" for key, value in entry) + "}"

    formatted_frames = [
        '{"media_type":"video","side_data_list":[' + ",".join(format_entry(entry) for entry in frame) + "]}"
        for frame in frames
    ]
    return '{"frames":[' + ",".join(formatted_frames) + "]}"


def read_committed_vector(file_name: str) -> bytes:
    """Returns the committed bytes of one vector file."""

    return (COMMITTED_VECTOR_DIRECTORY / file_name).read_bytes()


class SerializationTests(unittest.TestCase):
    """Covers the vector's HDR10+ frames and the static metadata the generator writes."""

    def test_covers_profile_A_and_profile_B_frames_and_frames_without_HDR10_plus(self) -> None:
        self.assertEqual(
            [index for index, frame in enumerate(generator.VECTOR_FRAMES) if frame is None],
            list(FRAME_WITHOUT_HDR10_PLUS_INDICES),
        )
        self.assertEqual(
            (PROFILE_A_FRAME.targeted_system_display_maximum_luminance, PROFILE_A_FRAME.bezier_curve),
            (0, None),
        )
        profile_B_frames = [frame for frame in generator.VECTOR_FRAMES if frame is not None and frame.bezier_curve is not None]
        self.assertEqual(len(profile_B_frames), 3)
        # No two frames share a message, so a frame paired with another frame's metadata shows
        messages = [generator.create_HDR10_plus_ITUT_T35_message(frame) for frame in generator.VECTOR_FRAMES if frame is not None]
        self.assertEqual(len(set(messages)), len(messages))

    def test_ends_the_profile_A_message_with_a_zero_byte(self) -> None:
        # The three zero flags end the payload in a byte of their own, so a reader that drops every trailing zero byte loses it
        self.assertEqual(generator.create_HDR10_plus_ITUT_T35_message(PROFILE_A_FRAME)[-1], 0)

    def test_writes_the_static_metadata_layouts(self) -> None:
        mastering_display = generator.create_mastering_display_metadata(generator.VECTOR_MASTERING_DISPLAY)
        self.assertEqual(len(mastering_display), 24)
        self.assertEqual(
            [int.from_bytes(mastering_display[offset : offset + 2], "big") for offset in range(0, 16, 2)],
            [46_399, 19_137, 11_141, 52_232, 8_585, 3_015, 20_493, 21_561],
        )
        # 1000 nits in 24.8 and 0.005 nits, rounded to 82/16384, in 18.14 fixed point
        self.assertEqual(int.from_bytes(mastering_display[16:20], "big"), 256_000)
        self.assertEqual(int.from_bytes(mastering_display[20:24], "big"), 82)
        self.assertEqual(
            generator.create_content_light_level_metadata(generator.VECTOR_CONTENT_LIGHT_LEVEL),
            (940).to_bytes(2, "big") + (410).to_bytes(2, "big"),
        )

    def test_writes_metadata_OBUs_with_their_trailing_bits(self) -> None:
        metadata = generator.create_content_light_level_metadata(generator.VECTOR_CONTENT_LIGHT_LEVEL)
        OBU = generator.create_metadata_OBU(generator.METADATA_TYPE_HDR_CLL, metadata)
        self.assertEqual(OBU, bytes((METADATA_OBU_HEADER, 6, generator.METADATA_TYPE_HDR_CLL)) + metadata + b"\x80")
        self.assertEqual(
            generator.read_metadata(generator.parse_OBUs(OBU)[0]),
            (generator.METADATA_TYPE_HDR_CLL, metadata),
        )
        without_trailing_bits = create_OBU(generator.OBUType.METADATA, bytes((generator.METADATA_TYPE_HDR_CLL,)) + metadata)
        with self.assertRaisesRegex(generator.VectorGenerationError, "trailing bits"):
            generator.read_metadata(generator.parse_OBUs(without_trailing_bits)[0])


class InsertionTests(unittest.TestCase):
    """Covers inserting each temporal unit's metadata OBUs."""

    def test_inserts_static_metadata_into_key_frame_units_and_HDR10_plus_where_a_frame_has_it(self) -> None:
        injected_stream = generator.insert_HDR_metadata(create_vector_stream(), generator.VECTOR_FRAMES)
        mastering_display_OBU = generator.create_metadata_OBU(
            generator.METADATA_TYPE_HDR_MDCV,
            generator.create_mastering_display_metadata(generator.VECTOR_MASTERING_DISPLAY),
        )
        content_light_level_OBU = generator.create_metadata_OBU(
            generator.METADATA_TYPE_HDR_CLL,
            generator.create_content_light_level_metadata(generator.VECTOR_CONTENT_LIGHT_LEVEL),
        )
        expected_units: list[bytes] = []
        for frame, key_frame in zip(generator.VECTOR_FRAMES, generator.get_vector_key_frame_flags(), strict=True):
            HDR10_plus_OBU = b"" if frame is None else generator.create_metadata_OBU(
                generator.METADATA_TYPE_ITUT_T35,
                generator.create_HDR10_plus_ITUT_T35_message(frame),
            )
            if key_frame:
                expected_units.append(SEQUENCE_HEADER + mastering_display_OBU + content_light_level_OBU + HDR10_plus_OBU + KEY_FRAME)
            else:
                expected_units.append(HDR10_plus_OBU + INTER_FRAME)
        self.assertEqual(injected_stream.data, b"".join(TEMPORAL_DELIMITER + unit for unit in expected_units))
        # A sample holds its temporal unit without the temporal delimiter
        self.assertEqual(
            injected_stream.temporal_units,
            tuple(
                generator.TemporalUnitSummary(key_frame=key_frame, sample_byte_length=len(unit))
                for unit, key_frame in zip(expected_units, generator.get_vector_key_frame_flags(), strict=True)
            ),
        )
        generator.require_injected_metadata(injected_stream)

    def test_rejects_streams_it_cannot_carry_the_metadata_in(self) -> None:
        existing_metadata = create_OBU(generator.OBUType.METADATA, b"\x01\x03\xE8\x01\x90\x80")
        cases = (
            (TEMPORAL_DELIMITER + SEQUENCE_HEADER + existing_metadata + KEY_FRAME, (None,), "already carries metadata"),
            (TEMPORAL_DELIMITER + SEQUENCE_HEADER + KEY_FRAME, (None, None), "1 temporal units for 2 frames"),
            (TEMPORAL_DELIMITER + KEY_FRAME, (None,), "sequence header only where it has no key frame"),
            (TEMPORAL_DELIMITER + SEQUENCE_HEADER + INTER_FRAME, (None,), "sequence header only where it has no key frame"),
            (TEMPORAL_DELIMITER + SEQUENCE_HEADER + KEY_FRAME + INTER_FRAME, (None,), "shows 2 frames"),
        )
        for stream, frames, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(generator.VectorGenerationError, message):
                    generator.insert_HDR_metadata(stream, frames)

    def test_reading_back_reports_a_unit_with_other_metadata(self) -> None:
        frames = list(generator.VECTOR_FRAMES)
        frames[1], frames[5] = frames[5], frames[1]
        injected_stream = generator.insert_HDR_metadata(create_vector_stream(), frames)
        with self.assertRaisesRegex(generator.VectorGenerationError, "Temporal unit metadata mismatch"):
            generator.require_injected_metadata(injected_stream)


class SideDataTests(unittest.TestCase):
    """Covers the frame side data FFmpeg decodes, the independent oracle."""

    def test_expects_static_metadata_on_every_frame_and_HDR10_plus_on_its_own(self) -> None:
        frames = generator.create_expected_frame_side_data()
        self.assertEqual(len(frames), generator.VECTOR_FRAME_COUNT)
        for frame_index, frame in enumerate(frames):
            with self.subTest(frame_index=frame_index):
                self.assertEqual(
                    [entry[0][1] for entry in frame],
                    [
                        "Mastering display metadata",
                        "Content light level metadata",
                        *([] if frame_index in FRAME_WITHOUT_HDR10_PLUS_INDICES else ["HDR Dynamic Metadata SMPTE2094-40 (HDR10+)"]),
                    ],
                )
        self.assertEqual(
            frames[0][0],
            [
                ("side_data_type", "Mastering display metadata"),
                ("red_x", "46399/65536"),
                ("red_y", "19137/65536"),
                ("green_x", "11141/65536"),
                ("green_y", "52232/65536"),
                ("blue_x", "8585/65536"),
                ("blue_y", "3015/65536"),
                ("white_point_x", "20493/65536"),
                ("white_point_y", "21561/65536"),
                ("min_luminance", "82/16384"),
                ("max_luminance", "256000/256"),
            ],
        )
        self.assertEqual(frames[0][1], [("side_data_type", "Content light level metadata"), ("max_content", 940), ("max_average", 410)])

    def test_expects_no_curve_fields_for_the_profile_A_frame(self) -> None:
        profile_A_entry = generator.create_expected_frame_side_data()[PROFILE_A_FRAME_INDEX][2]
        field_names = [field_name for field_name, _value in profile_A_entry]
        self.assertIn(("targeted_system_display_maximum_luminance", "0/1"), profile_A_entry)
        self.assertNotIn("knee_point_x", field_names)
        self.assertNotIn("bezier_curve_anchors", field_names)
        self.assertEqual(field_names.count("maxscl"), 3)
        self.assertEqual(field_names.count("distribution_maxrgb_percentile"), 9)

    def test_reads_each_repeated_FFprobe_field_in_order(self) -> None:
        expected_frames = generator.create_expected_frame_side_data()
        tools = generator.MediaTools(FFmpeg_path="ffmpeg", FFprobe_path="ffprobe")
        with patch.object(generator, "execute_tool", return_value=format_FFprobe_frames(expected_frames)) as execute_tool:
            self.assertEqual(generator.probe_frame_side_data(tools, Path("vector.mkv")), expected_frames)
            generator.require_frame_side_data(tools, Path("vector.mkv"))
        self.assertEqual(execute_tool.call_args.args[0], "ffprobe")
        self.assertIn("-show_frames", execute_tool.call_args.args[1])

    def test_reports_a_frame_whose_side_data_differs(self) -> None:
        frames = generator.create_expected_frame_side_data()
        # The frame without HDR10+ decodes with the HDR10+ of the frame before it
        frames[2] = [*frames[2], frames[1][2]]
        tools = generator.MediaTools(FFmpeg_path="ffmpeg", FFprobe_path="ffprobe")
        with patch.object(generator, "execute_tool", return_value=format_FFprobe_frames(frames)):
            with self.assertRaisesRegex(generator.VectorGenerationError, "vector.mp4 frame side data mismatch"):
                generator.require_frame_side_data(tools, Path("vector.mp4"))


class EvidenceTests(unittest.TestCase):
    """Covers the FFprobe container checks and the MP4 signaling."""

    def create_injected_stream(self) -> generator.InjectedStream:
        return generator.InjectedStream(
            data=b"",
            temporal_units=tuple(
                generator.TemporalUnitSummary(key_frame=key_frame, sample_byte_length=100 + frame_index)
                for frame_index, key_frame in enumerate(generator.get_vector_key_frame_flags())
            ),
        )

    def test_accepts_the_evidence_of_both_containers(self) -> None:
        injected_stream = self.create_injected_stream()
        for container_format in generator.CONTAINER_FORMATS:
            with self.subTest(container_format=container_format):
                generator.require_container_evidence(
                    create_container_probe(container_format, injected_stream),
                    container_format,
                    injected_stream,
                    "vector",
                )

    def test_reports_each_container_mismatch(self) -> None:
        injected_stream = self.create_injected_stream()
        matching_probe = create_container_probe(generator.MATROSKA_FORMAT, injected_stream)
        stream = matching_probe["streams"][0]
        container_mastering_display = {"side_data_type": "Mastering display metadata"}
        cases = (
            ({**matching_probe, "streams": [{**stream, "codec_tag_string": "av01"}]}, "vector.mkv codec tag mismatch"),
            ({**matching_probe, "streams": [{**stream, "width": 96}]}, "vector.mkv size mismatch"),
            ({**matching_probe, "streams": [{**stream, "color_transfer": "arib-std-b67"}]}, "vector.mkv color mismatch"),
            (
                {**matching_probe, "streams": [{**stream, "side_data_list": [container_mastering_display]}]},
                "vector.mkv stream side data mismatch",
            ),
            (
                {**matching_probe, "packets": matching_probe["packets"][1:]},
                "vector.mkv packet sizes and key flags mismatch",
            ),
            (
                {**matching_probe, "streams": [stream, {"codec_type": "audio", "codec_name": "aac"}]},
                "vector.mkv audio stream count mismatch",
            ),
        )
        for probe, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(generator.VectorGenerationError, message):
                    generator.require_container_evidence(probe, generator.MATROSKA_FORMAT, injected_stream, "vector.mkv")

    def test_requires_an_av01_sample_entry_with_the_PQ_color(self) -> None:
        data = read_committed_vector("hdr10plus.mp4")
        generator.require_MP4_signaling(data, "vector.mp4")
        with self.assertRaisesRegex(generator.VectorGenerationError, "vector.mp4 sample entry mismatch"):
            generator.require_MP4_signaling(dolby_vision_generator.rename_AV1_sample_entry(data, "dav1"), "vector.mp4")
        # The colr box's transfer_characteristics of 16 (PQ) becomes 18 (HLG)
        colr_payload = b"nclx\x00\x09\x00\x10\x00\x09\x00"
        self.assertEqual(data.count(colr_payload), 1)
        with self.assertRaisesRegex(generator.VectorGenerationError, "vector.mp4 colr box mismatch"):
            generator.require_MP4_signaling(data.replace(colr_payload, b"nclx\x00\x09\x00\x12\x00\x09\x00"), "vector.mp4")


class CommittedVectorTests(unittest.TestCase):
    """Reads the committed vectors and expectations in bin/codec_vector_assets/hdr10plus-av1/."""

    def test_expectations_match_the_tables(self) -> None:
        self.assertEqual(
            read_committed_vector(generator.EXPECTATIONS_FILE_NAME),
            generator.format_expectations(generator.create_expectations()),
        )

    def test_records_both_containers_and_every_frame(self) -> None:
        expectations = json.loads(read_committed_vector(generator.EXPECTATIONS_FILE_NAME))
        self.assertEqual(
            [(vector["fileName"], vector["container"], vector["sampleEntry"]) for vector in expectations["vectors"]],
            [("hdr10plus.mp4", "mp4", "av01"), ("hdr10plus.mkv", "matroska", None)],
        )
        frames = expectations["frames"]
        self.assertEqual(len(frames), expectations["frameCount"])
        self.assertEqual([frame["keyFrame"] for frame in frames], [True, False, False, True, False, False])
        self.assertEqual([frame["staticHDRMetadata"] for frame in frames], [frame["keyFrame"] for frame in frames])
        self.assertEqual([index for index, frame in enumerate(frames) if frame["HDR10Plus"] is None], list(FRAME_WITHOUT_HDR10_PLUS_INDICES))
        self.assertEqual(frames[PROFILE_A_FRAME_INDEX]["HDR10Plus"]["bezierCurve"], None)
        self.assertEqual(frames[PROFILE_A_FRAME_INDEX]["HDR10Plus"]["targetedSystemDisplayMaximumLuminance"], 0)

    def test_every_vector_carries_each_metadata_OBU_byte_for_byte(self) -> None:
        static_metadata_OBUs = (
            generator.create_metadata_OBU(
                generator.METADATA_TYPE_HDR_MDCV,
                generator.create_mastering_display_metadata(generator.VECTOR_MASTERING_DISPLAY),
            ),
            generator.create_metadata_OBU(
                generator.METADATA_TYPE_HDR_CLL,
                generator.create_content_light_level_metadata(generator.VECTOR_CONTENT_LIGHT_LEVEL),
            ),
        )
        for file_name in VECTOR_FILE_NAMES:
            data = read_committed_vector(file_name)
            with self.subTest(file_name=file_name):
                for OBU in static_metadata_OBUs:
                    self.assertEqual(data.count(OBU), STATIC_METADATA_OBU_COPY_COUNT)
                for frame in generator.VECTOR_FRAMES:
                    if frame is None:
                        continue
                    HDR10_plus_OBU = generator.create_metadata_OBU(
                        generator.METADATA_TYPE_ITUT_T35,
                        generator.create_HDR10_plus_ITUT_T35_message(frame),
                    )
                    self.assertEqual(data.count(HDR10_plus_OBU), 1)


class MainTests(unittest.TestCase):
    """Runs main() with the build replaced by a copy of the committed vectors."""

    def run_main(self, arguments: Sequence[str], vector_directory: Path, *, build_error: str | None = None) -> tuple[int, str, str]:
        """Returns the exit status, standard output, and standard error of one run."""

        def build_vector_files(tools: generator.MediaTools, temporary_directory: Path) -> dict[str, Path]:
            if build_error is not None:
                raise generator.VectorGenerationError(build_error)
            paths: dict[str, Path] = {}
            for file_name in VECTOR_FILE_NAMES:
                path = temporary_directory / file_name
                path.write_bytes(read_committed_vector(file_name))
                paths[file_name] = path
            return paths

        standard_output = io.StringIO()
        standard_error = io.StringIO()
        with (
            patch.object(generator, "check_toolchain"),
            patch.object(generator, "build_vector_files", side_effect=build_vector_files),
            patch.object(generator, "VECTOR_DIRECTORY", vector_directory),
            redirect_stdout(standard_output),
            redirect_stderr(standard_error),
        ):
            exit_status = generator.main(arguments)
        return exit_status, standard_output.getvalue(), standard_error.getvalue()

    def test_check_verifies_the_committed_vectors(self) -> None:
        exit_status, output, errors = self.run_main(["--check"], COMMITTED_VECTOR_DIRECTORY)
        self.assertEqual((exit_status, errors), (0, ""))
        self.assertTrue(output.startswith("Verified 2 HDR10+ AV1 vectors and expectations.json"))

    def test_generation_writes_both_vectors_and_the_expectations(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            exit_status, output, errors = self.run_main([], output_directory)
            self.assertEqual((exit_status, errors), (0, ""))
            self.assertTrue(output.startswith("Generated 2"))
            for path in COMMITTED_VECTOR_DIRECTORY.iterdir():
                with self.subTest(file_name=path.name):
                    self.assertEqual((output_directory / path.name).read_bytes(), path.read_bytes())

    def test_check_rejects_a_committed_file_that_differs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            for path in COMMITTED_VECTOR_DIRECTORY.iterdir():
                (output_directory / path.name).write_bytes(path.read_bytes())
            stale_path = output_directory / "hdr10plus.mkv"
            stale_path.write_bytes(b"stale")
            exit_status, output, errors = self.run_main(["--check"], output_directory)
            self.assertEqual(
                (exit_status, output, errors),
                (1, "", f"Regenerated output differs from the committed bytes: {stale_path}\n"),
            )
            self.assertEqual(stale_path.read_bytes(), b"stale")

    def test_reports_a_failed_build_before_writing_anything(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            exit_status, output, errors = self.run_main([], output_directory, build_error="Key frames mismatch")
            self.assertEqual((exit_status, output, errors), (1, "", "Key frames mismatch\n"))
            self.assertEqual(list(output_directory.iterdir()), [])

    def test_check_reports_a_missing_committed_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            exit_status, output, errors = self.run_main(["--check"], output_directory)
            self.assertEqual((exit_status, output), (1, ""))
            self.assertEqual(errors, f"Committed output is missing: {output_directory / 'hdr10plus.mp4'}\n")
            self.assertEqual(list(output_directory.iterdir()), [])

    def test_parses_the_command_line(self) -> None:
        arguments = generator.parse_arguments(["--check", "--ffprobe", "tools/ffprobe.exe"])
        self.assertEqual((arguments.check, arguments.ffmpeg, arguments.ffprobe), (True, None, "tools/ffprobe.exe"))
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            generator.parse_arguments(["check"])
        self.assertEqual(raised.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
