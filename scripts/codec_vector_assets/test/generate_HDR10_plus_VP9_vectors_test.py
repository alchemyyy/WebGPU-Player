"""Tests the HDR10+ VP9 vector generator without running FFmpeg."""

from __future__ import annotations

import dataclasses
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Sequence
from unittest.mock import patch


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import generate_HDR10_plus_VP9_vectors as generator  # noqa: E402
import HDR10_plus_metadata as HDR10_plus  # noqa: E402
from vector_test_support import run_main  # noqa: E402


# Saved before any test replaces generator.VECTOR_DIRECTORY
COMMITTED_VECTOR_DIRECTORY = generator.VECTOR_DIRECTORY
PROFILE_B_FRAME_INDEX = 0
PROFILE_A_FRAME_INDEX = 3
FRAME_INDICES_WITHOUT_METADATA = [2, 4]
EXPECTED_KEY_FRAMES = [True, False, False, False, True, False, False, False]
WINDOWS_METADATA_PATH = "C:/Users/Tester/O'Brien/hdr10plus=1.json"
ESCAPED_WINDOWS_METADATA_PATH = r"C\:/Users/Tester/O\'Brien/hdr10plus\=1.json"
OTHER_TRACK_NUMBER = 2
VIDEO_TRACK_NUMBER = 1
ALPHA_ADDITION = b"\x01\x02"
T35_ADDITION = b"\xB5\x00\x3C"


def read_committed_vector(file_name: str) -> bytes:
    return (COMMITTED_VECTOR_DIRECTORY / file_name).read_bytes()


def encode_EBML_size(size: int) -> bytes:
    """Codes a size in the shortest variable-size integer that is not the unknown-size value."""

    for byte_length in range(1, generator.MAXIMUM_EBML_SIZE_BYTE_LENGTH + 1):
        if size < (1 << (7 * byte_length)) - 1:
            return ((1 << (7 * byte_length)) | size).to_bytes(byte_length, "big")
    raise ValueError("The size does not fit an EBML size")


def create_element(element_ID: int, payload: bytes) -> bytes:
    """Creates one EBML element whose ID keeps its length marker."""

    return element_ID.to_bytes((element_ID.bit_length() + 7) // 8, "big") + encode_EBML_size(len(payload)) + payload


def create_unsigned_element(element_ID: int, value: int) -> bytes:
    return create_element(element_ID, value.to_bytes(max(1, (value.bit_length() + 7) // 8), "big"))


def create_block_payload(track_number: int, flags: int) -> bytes:
    """Creates a block's track number, a zero relative timestamp, its flags, and one frame byte."""

    return encode_EBML_size(track_number) + b"\x00\x00" + bytes((flags,)) + b"\x82"


def create_block_more(addition: bytes, addition_ID: int | None) -> bytes:
    addition_ID_element = b"" if addition_ID is None else create_unsigned_element(generator.BLOCK_ADDITION_ID_ID, addition_ID)
    return create_element(
        generator.BLOCK_MORE_ID,
        addition_ID_element + create_element(generator.BLOCK_ADDITIONAL_ID, addition),
    )


def create_Matroska_file(clusters: Sequence[bytes], *, doc_type: str = "matroska", mappings: Sequence[tuple[int, int]] = ()) -> bytes:
    """Creates a Matroska file with one video track, its color and mappings, and the given clusters."""

    colour = create_element(
        generator.COLOUR_ID,
        create_unsigned_element(generator.PRIMARIES_ID, generator.BT2020_PRIMARIES)
        + create_unsigned_element(generator.TRANSFER_CHARACTERISTICS_ID, generator.PQ_TRANSFER)
        + create_unsigned_element(generator.MATRIX_COEFFICIENTS_ID, generator.BT2020_NON_CONSTANT_LUMINANCE_MATRIX)
        + create_unsigned_element(generator.RANGE_ID, generator.MATROSKA_BROADCAST_RANGE),
    )
    mapping_elements = b"".join(
        create_element(
            generator.BLOCK_ADDITION_MAPPING_ID,
            create_unsigned_element(generator.BLOCK_ADDITION_ID_VALUE_ID, value)
            + create_unsigned_element(generator.BLOCK_ADDITION_ID_TYPE_ID, mapping_type),
        )
        for value, mapping_type in mappings
    )
    track_entry = create_element(
        generator.TRACK_ENTRY_ID,
        create_unsigned_element(generator.TRACK_NUMBER_ID, VIDEO_TRACK_NUMBER)
        + create_element(generator.VIDEO_ID, colour)
        + mapping_elements,
    )
    header = create_element(generator.EBML_HEADER_ID, create_element(generator.DOC_TYPE_ID, doc_type.encode("ascii")))
    segment = create_element(
        generator.SEGMENT_ID,
        create_element(generator.TRACKS_ID, track_entry)
        + b"".join(create_element(generator.CLUSTER_ID, cluster) for cluster in clusters),
    )
    return header + segment


def replace_once(data: bytes, old: bytes, new: bytes) -> bytes:
    if data.count(old) < 1 or len(old) != len(new):
        raise ValueError("The replaced bytes must occur and keep their length")
    return data.replace(old, new, 1)


class X265MetadataTests(unittest.TestCase):
    """Writes the dhdr10-info JSON x265 reads."""

    def test_writes_one_entry_per_frame_with_a_curve_only_for_profile_B(self) -> None:
        metadata = json.loads(generator.create_x265_metadata(generator.VECTOR_FRAMES))
        entries = metadata["SceneInfo"]

        self.assertEqual(len(entries), generator.VECTOR_FRAME_COUNT)
        self.assertEqual(entries[PROFILE_B_FRAME_INDEX]["BezierCurveData"], {
            "Anchors": [102, 205, 307, 410, 512, 614, 717, 819, 922],
            "KneePointX": 0,
            "KneePointY": 0,
        })
        self.assertNotIn("BezierCurveData", entries[PROFILE_A_FRAME_INDEX])
        self.assertEqual(entries[PROFILE_A_FRAME_INDEX]["TargetedSystemDisplayMaximumLuminance"], 0)
        self.assertEqual(entries[PROFILE_A_FRAME_INDEX]["LuminanceParameters"]["MaxScl"], [6_000, 5_000, 4_000])

    def test_fills_a_frame_without_HDR10_plus_with_the_first_entry(self) -> None:
        entries = json.loads(generator.create_x265_metadata(generator.VECTOR_FRAMES))["SceneInfo"]

        for frame_index in FRAME_INDICES_WITHOUT_METADATA:
            with self.subTest(frame_index=frame_index):
                self.assertEqual(entries[frame_index], entries[0])
        self.assertEqual(generator.get_frame_indices_without_metadata(generator.VECTOR_FRAMES), FRAME_INDICES_WITHOUT_METADATA)

    def test_rejects_a_vector_without_HDR10_plus(self) -> None:
        with self.assertRaisesRegex(generator.VectorGenerationError, "must carry HDR10"):
            generator.create_x265_metadata((None, None))

    def test_rejects_a_bright_pixel_fraction_x265_cannot_write(self) -> None:
        frame = generator.VECTOR_FRAMES[PROFILE_B_FRAME_INDEX]
        if frame is None:
            raise AssertionError("The profile B vector frame carries no HDR10+")

        with self.assertRaisesRegex(generator.VectorGenerationError, "cannot code an HDR10\\+ bright-pixel fraction"):
            generator.create_x265_metadata_entry(dataclasses.replace(frame, fraction_bright_pixels=1))


class ToolArgumentTests(unittest.TestCase):
    """Builds the FFmpeg commands."""

    def test_escapes_a_metadata_path_inside_the_x265_parameters(self) -> None:
        self.assertEqual(generator.escape_FFmpeg_option_value(WINDOWS_METADATA_PATH), ESCAPED_WINDOWS_METADATA_PATH)
        arguments = generator.create_HEVC_source_arguments(Path(WINDOWS_METADATA_PATH), Path("source.hevc"))

        x265_parameters = arguments[arguments.index("-x265-params") + 1]
        self.assertEqual(x265_parameters.split(":", 5)[:5], ["info=0", "bframes=0", "pools=none", "frame-threads=1", "log-level=error"])
        self.assertTrue(x265_parameters.endswith(f"dhdr10-info={ESCAPED_WINDOWS_METADATA_PATH}"))
        self.assertEqual(arguments[arguments.index("-frames:v") + 1], str(generator.VECTOR_FRAME_COUNT))

    def test_deletes_HDR10_plus_from_the_listed_frames_and_tags_PQ(self) -> None:
        self.assertEqual(
            generator.create_VP9_filter(FRAME_INDICES_WITHOUT_METADATA),
            "sidedata=mode=delete:type=DYNAMIC_HDR_PLUS:enable='eq(n,2)+eq(n,4)',"
            "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv",
        )
        self.assertEqual(
            generator.create_VP9_filter([]),
            "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv",
        )

    def test_encodes_Profile_2_in_one_thread_without_hidden_frames(self) -> None:
        arguments = generator.create_VP9_encode_arguments(Path("source.hevc"), FRAME_INDICES_WITHOUT_METADATA, Path("out.webm"))

        def get_value(name: str) -> str:
            return arguments[arguments.index(name) + 1]

        self.assertEqual(
            [get_value(name) for name in ("-c:v", "-profile:v", "-pix_fmt", "-threads", "-row-mt", "-lag-in-frames", "-auto-alt-ref")],
            ["libvpx-vp9", "2", "yuv420p10le", "1", "0", "0", "0"],
        )
        self.assertEqual([get_value("-g"), get_value("-keyint_min")], ["4", "4"])
        self.assertEqual([get_value("-fflags"), get_value("-flags:v")], ["+bitexact", "+bitexact"])
        self.assertEqual(get_value("-cluster_time_limit"), "160")
        self.assertEqual(arguments[-3:], ["-f", "webm", "out.webm"])

    def test_remuxes_every_packet_into_Matroska(self) -> None:
        arguments = generator.create_remux_arguments(Path("in.webm"), Path("out.mkv"))

        self.assertEqual(arguments[arguments.index("-c") + 1], "copy")
        self.assertEqual(arguments[arguments.index("-cluster_time_limit") + 1], "160")
        self.assertEqual(arguments[-3:], ["-f", "matroska", "out.mkv"])


class EBMLTests(unittest.TestCase):
    """Reads Matroska structure from synthetic files."""

    def test_reads_variable_size_integers_of_every_length(self) -> None:
        for value in (0, 1, 126, 127, 16_382, 16_383, 2**49):
            with self.subTest(value=value):
                coded = encode_EBML_size(value)
                self.assertEqual(generator.read_EBML_variable_integer(coded, 0), (value, len(coded)))

    def test_rejects_unknown_sizes_and_bad_codings(self) -> None:
        cases = ((b"\xFF", "Unknown EBML size"), (b"\x00", "Invalid EBML"), (b"\x40", "Truncated EBML"))
        for data, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(generator.VectorGenerationError, message):
                    generator.read_EBML_variable_integer(data, 0)
        with self.assertRaisesRegex(generator.VectorGenerationError, "Invalid EBML ID"):
            generator.read_EBML_ID(b"\x08\x00\x00\x00\x00", 0)

    def test_rejects_an_element_that_runs_past_its_parent(self) -> None:
        element = create_element(generator.CLUSTER_ID, b"\x00" * 4)

        with self.assertRaisesRegex(generator.VectorGenerationError, "runs past its parent"):
            list(generator.iterate_EBML_elements(element, 0, len(element) - 1))

    def test_reads_blocks_their_additions_and_the_track_signaling(self) -> None:
        first_cluster = (
            create_element(generator.SIMPLE_BLOCK_ID, create_block_payload(VIDEO_TRACK_NUMBER, generator.SIMPLE_BLOCK_KEY_FLAG))
            + create_element(generator.SIMPLE_BLOCK_ID, create_block_payload(OTHER_TRACK_NUMBER, generator.SIMPLE_BLOCK_KEY_FLAG))
        )
        second_cluster = create_element(
            generator.BLOCK_GROUP_ID,
            create_element(generator.BLOCK_ID, create_block_payload(VIDEO_TRACK_NUMBER, 0))
            + create_element(
                generator.BLOCK_ADDITIONS_ID,
                create_block_more(ALPHA_ADDITION, None) + create_block_more(T35_ADDITION, generator.ITU_T_T35_BLOCK_ADDITION_ID),
            )
            + create_unsigned_element(generator.REFERENCE_BLOCK_ID, 1),
        )
        data = create_Matroska_file([first_cluster, second_cluster], mappings=[(4, 4)])

        track = generator.read_Matroska_video_track(data)

        self.assertEqual(track.doc_type, "matroska")
        self.assertEqual(track.block_addition_mappings, ((4, 4),))
        self.assertIsNone(track.maximum_block_addition_ID)
        self.assertEqual(list(track.color), [9, 16, 9, 1])
        self.assertEqual(track.cluster_block_counts, (1, 1))
        self.assertEqual(track.blocks, (
            generator.MatroskaBlock(key_frame=True, additions=()),
            # A BlockMore without BlockAddID takes the default ID 1
            generator.MatroskaBlock(
                key_frame=False,
                additions=((generator.DEFAULT_BLOCK_ADDITION_ID, ALPHA_ADDITION), (generator.ITU_T_T35_BLOCK_ADDITION_ID, T35_ADDITION)),
            ),
        ))

    def test_rejects_laced_blocks_and_other_layouts(self) -> None:
        laced_cluster = create_element(generator.SIMPLE_BLOCK_ID, create_block_payload(VIDEO_TRACK_NUMBER, 0x02))
        with self.assertRaisesRegex(generator.VectorGenerationError, "is laced"):
            generator.read_Matroska_video_track(create_Matroska_file([laced_cluster]))
        with self.assertRaisesRegex(generator.VectorGenerationError, "one EBML header followed by one Segment"):
            generator.read_Matroska_video_track(create_Matroska_file([]) + create_element(generator.CLUSTER_ID, b""))


class EvidenceTests(unittest.TestCase):
    """Checks the containers and FFprobe's reading of them."""

    def test_accepts_both_committed_vectors(self) -> None:
        for container_format in generator.CONTAINER_FORMATS:
            file_name = generator.get_vector_file_name(container_format)
            with self.subTest(file_name=file_name):
                generator.require_container_evidence(read_committed_vector(file_name), container_format, file_name)

    def test_reports_each_container_mismatch(self) -> None:
        webm = read_committed_vector(generator.get_vector_file_name(generator.WEBM_FORMAT))
        matroska = read_committed_vector(generator.get_vector_file_name(generator.MATROSKA_FORMAT))
        profile_B_message = HDR10_plus.create_HDR10_plus_ITUT_T35_message(generator.VECTOR_FRAMES[PROFILE_B_FRAME_INDEX])
        altered_message = profile_B_message[:-1] + bytes((profile_B_message[-1] ^ 0x80,))
        cases = (
            (webm, generator.MATROSKA_FORMAT, "DocType"),
            (matroska, generator.WEBM_FORMAT, "DocType"),
            (replace_once(webm, profile_B_message, altered_message), generator.WEBM_FORMAT, "BlockAdditionals"),
        )
        for data, container_format, message in cases:
            with self.subTest(message=message, container_format=container_format):
                with self.assertRaisesRegex(generator.VectorGenerationError, message):
                    generator.require_container_evidence(data, container_format, "vector")

    def test_requires_the_Matroska_mapping_and_no_WebM_mapping(self) -> None:
        cluster = b"".join(
            create_element(generator.SIMPLE_BLOCK_ID, create_block_payload(VIDEO_TRACK_NUMBER, generator.SIMPLE_BLOCK_KEY_FLAG))
            for _frame in generator.VECTOR_FRAMES
        )
        cases = (
            (create_Matroska_file([cluster], doc_type="webm", mappings=[(4, 4)]), generator.WEBM_FORMAT),
            (create_Matroska_file([cluster], doc_type="matroska"), generator.MATROSKA_FORMAT),
        )
        for data, container_format in cases:
            with self.subTest(container_format=container_format):
                with self.assertRaisesRegex(generator.VectorGenerationError, "BlockAdditionMapping"):
                    generator.require_container_evidence(data, container_format, "vector")

    def run_FFprobe_evidence(self, packets: Sequence[Any], stream_overrides: dict[str, object] | None = None) -> None:
        stream: dict[str, object] = {
            "codec_name": "vp9",
            "height": generator.VECTOR_HEIGHT,
            "pix_fmt": "yuv420p10le",
            "profile": "Profile 2",
            "width": generator.VECTOR_WIDTH,
            **generator.FFMPEG_COLOR_NAMES,
            **(stream_overrides or {}),
        }
        tools = generator.MediaTools(FFmpeg_path="ffmpeg", FFprobe_path="ffprobe")
        with (
            patch.object(generator, "probe_video_stream", return_value=stream),
            patch.object(generator, "probe_packets", return_value=list(packets)),
        ):
            generator.require_FFprobe_evidence(tools, Path("vector.webm"), "vector")

    def create_FFprobe_packets(self) -> list[dict[str, object]]:
        packets: list[dict[str, object]] = []
        for frame, key_frame in zip(generator.VECTOR_FRAMES, EXPECTED_KEY_FRAMES, strict=True):
            packet: dict[str, object] = {"flags": "K__" if key_frame else "___"}
            if frame is not None:
                packet["side_data_list"] = [
                    HDR10_plus.create_expected_HDR10_plus_side_data(frame, HDR10_plus.FFPROBE_HDR10_PLUS_PACKET_SIDE_DATA_TYPE),
                ]
            packets.append(packet)
        return packets

    def test_accepts_the_side_data_of_every_packet(self) -> None:
        self.run_FFprobe_evidence(self.create_FFprobe_packets())

    def test_reports_side_data_on_the_wrong_packet_and_the_wrong_stream(self) -> None:
        packets = self.create_FFprobe_packets()
        packets[FRAME_INDICES_WITHOUT_METADATA[0]] = packets[PROFILE_B_FRAME_INDEX]
        with self.assertRaisesRegex(generator.VectorGenerationError, "FFprobe key frames|FFprobe HDR10"):
            self.run_FFprobe_evidence(packets)
        with self.assertRaisesRegex(generator.VectorGenerationError, "vector color"):
            self.run_FFprobe_evidence(self.create_FFprobe_packets(), {"color_transfer": "arib-std-b67"})
        with self.assertRaisesRegex(generator.VectorGenerationError, "vector stream"):
            self.run_FFprobe_evidence(self.create_FFprobe_packets(), {"profile": "Profile 0"})


class CommittedVectorTests(unittest.TestCase):
    """Reads the committed vectors and expectations in bin/codec_vector_assets/hdr10plus-vp9/."""

    def test_expectations_match_the_frame_table(self) -> None:
        self.assertEqual(
            read_committed_vector(generator.EXPECTATIONS_FILE_NAME),
            generator.format_expectations(generator.create_expectations()),
        )

    def test_records_both_containers_and_every_frame(self) -> None:
        expectations = json.loads(read_committed_vector(generator.EXPECTATIONS_FILE_NAME))
        frames = expectations["frames"]

        self.assertEqual(
            [(vector["fileName"], vector["container"], vector["blockAdditionMapping"]) for vector in expectations["vectors"]],
            [("hdr10plus.webm", "webm", False), ("hdr10plus.mkv", "matroska", True)],
        )
        self.assertEqual(expectations["generator"], "scripts/codec_vector_assets/generate_HDR10_plus_VP9_vectors.py")
        self.assertEqual([frame["keyFrame"] for frame in frames], EXPECTED_KEY_FRAMES)
        self.assertEqual([index for index, frame in enumerate(frames) if frame["HDR10Plus"] is None], FRAME_INDICES_WITHOUT_METADATA)
        self.assertIsNone(frames[PROFILE_A_FRAME_INDEX]["HDR10Plus"]["bezierCurve"])
        self.assertEqual(frames[PROFILE_A_FRAME_INDEX]["HDR10Plus"]["targetedSystemDisplayMaximumLuminance"], 0)
        self.assertEqual(frames[-1], frames[-2])

    def test_records_the_messages_FFmpeg_wrote(self) -> None:
        frames = json.loads(read_committed_vector(generator.EXPECTATIONS_FILE_NAME))["frames"]
        # FFmpeg, not the generator, wrote the BlockAdditionals of the committed Matroska vector
        Matroska_track = generator.read_Matroska_video_track(read_committed_vector(generator.get_vector_file_name(generator.MATROSKA_FORMAT)))
        messages = [dict(block.additions).get(generator.ITU_T_T35_BLOCK_ADDITION_ID) for block in Matroska_track.blocks]

        self.assertEqual(
            [frame["ITUTT35Message"] for frame in frames],
            [None if message is None else message.hex() for message in messages],
        )


class MainTests(unittest.TestCase):
    """Runs main() with each build replaced by a copy of the committed vectors."""

    def run_generator(self, arguments: Sequence[str], vector_directory: Path, *, failing_file_name: str | None = None) -> tuple[int, str, str]:
        """Returns the exit status, standard output, and standard error of one run.

        The FFprobe check fails for the named file and passes for every other.
        """

        def build_vector_files(tools: generator.MediaTools, temporary_directory: Path) -> dict[str, Path]:
            paths: dict[str, Path] = {}
            for container_format in generator.CONTAINER_FORMATS:
                path = temporary_directory / generator.get_vector_file_name(container_format)
                path.write_bytes(read_committed_vector(path.name))
                paths[container_format] = path
            return paths

        def require_FFprobe_evidence(tools: generator.MediaTools, path: Path, label: str) -> None:
            if path.name == failing_file_name:
                raise generator.VectorGenerationError(f"{label} FFprobe mismatch")

        with (
            patch.object(generator, "check_toolchain"),
            patch.object(generator, "build_vector_files", side_effect=build_vector_files),
            patch.object(generator, "require_FFprobe_evidence", side_effect=require_FFprobe_evidence),
            patch.object(generator, "VECTOR_DIRECTORY", vector_directory),
        ):
            return run_main(generator.main, arguments)

    def test_check_verifies_the_committed_vectors(self) -> None:
        exit_status, output, errors = self.run_generator(["--check"], COMMITTED_VECTOR_DIRECTORY)

        self.assertEqual((exit_status, errors), (0, ""))
        self.assertTrue(output.startswith("Verified 2 HDR10+ VP9 vectors and expectations.json"))

    def test_generation_writes_both_vectors_and_the_expectations(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            exit_status, output, errors = self.run_generator([], output_directory)

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

            exit_status, output, errors = self.run_generator(["--check"], output_directory)

            self.assertEqual((exit_status, output, errors), (1, "", f"Regenerated output differs from the committed bytes: {stale_path}\n"))
            self.assertEqual(stale_path.read_bytes(), b"stale")

    def test_reports_a_failed_check_before_writing_anything(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            # The Matroska vector fails after the WebM vector passes
            exit_status, output, errors = self.run_generator([], output_directory, failing_file_name="hdr10plus.mkv")

            self.assertEqual((exit_status, output, errors), (1, "", "hdr10plus.mkv FFprobe mismatch\n"))
            self.assertEqual(list(output_directory.iterdir()), [])

    def test_check_reports_a_missing_committed_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            exit_status, output, errors = self.run_generator(["--check"], output_directory)

            self.assertEqual((exit_status, output), (1, ""))
            self.assertEqual(errors, f"Committed output is missing: {output_directory / 'hdr10plus.webm'}\n")

    def test_parses_the_command_line(self) -> None:
        arguments = generator.parse_arguments(["--check", "--ffprobe", "tools/ffprobe.exe"])

        self.assertEqual((arguments.check, arguments.ffmpeg, arguments.ffprobe), (True, None, "tools/ffprobe.exe"))


if __name__ == "__main__":
    unittest.main()
