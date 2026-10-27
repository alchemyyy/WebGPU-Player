"""Tests the MPEG-4 decoder project media generator's media table, encode arguments, N-VOP removal, and Video for Windows rewrite without running FFmpeg."""

from __future__ import annotations

import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Sequence
from unittest.mock import patch


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import generate_mpeg4_decoder_vectors as generator  # noqa: E402
from media_tools import pack_bit_fields  # noqa: E402
from vector_test_support import run_main  # noqa: E402


# Saved before any test replaces generator.VECTOR_DIRECTORY
COMMITTED_VECTOR_DIRECTORY = generator.VECTOR_DIRECTORY
PROJECT_DECLARATION_PATH = COMMITTED_VECTOR_DIRECTORY.parent / "decoder.json"
# The media the engine's route tests and the package's self-test read
MEDIA_FILE_NAMES = [
    "mpeg4-gmc-qpel-b.mkv",
    "mpeg4-b.mp4",
    "mpeg4-b-xvid.avi",
    "mpeg4-b-vfw.mkv",
    "msmpeg4v3.avi",
    "msmpeg4v3.mkv",
    "msmpeg4v2-vfw.mkv",
    "msmpeg4v2.avi",
    "h263.3gp",
    "h263.avi",
    "h263p-vfw.mkv",
]
SELF_TEST_FILE_NAME = "mpeg4-gmc-qpel-b.mkv"
OUTPUT_PATH = Path("encoded.out")
OTHER_BYTES = b"other bytes"
# A video object layer header after its start code: not random accessible, a simple object, no layer identifier, square pixels,
# then optionally vol_control_parameters with VBV parameters, a rectangular shape, a marker, and the time increment resolution
SIMPLE_OBJECT_TYPE = 1
SQUARE_PIXELS = 1
RECTANGULAR_SHAPE = 0
VOL_START_CODE = b"\x00\x00\x01\x20"
VOP_START_CODE = b"\x00\x00\x01\xb6"
VIDEO_OBJECT_START_CODE = b"\x00\x00\x01\x00"
P_VOP = 1
# Matroska fixtures: element IDs the generator does not name
SEEK_HEAD_PAYLOAD = b"seek entries"
CUES_PAYLOAD = b"cue points"
NATIVE_CODEC_ID = b"V_MPEG4/ISO/ASP"
TRACK_NUMBER_ID = 0xD7
BLOCK_GROUP_ID = 0xA0
VOL_EXTRADATA = VOL_START_CODE + b"\x12\x34"
TRACK_WIDTH = 176
TRACK_HEIGHT = 144
TRACK_NUMBER = 1
KEYFRAME_FLAG = 0x80


def create_VOL(resolution: int, *, control_parameters: bool = False) -> bytes:
    """Returns a video object layer header after its start code with a time increment resolution."""

    fields = [(0, 1), (SIMPLE_OBJECT_TYPE, 8), (0, 1), (SQUARE_PIXELS, 4), (int(control_parameters), 1)]
    if control_parameters:
        # chroma_format 4:2:0, low_delay 0, vbv_parameters with every field zero but the markers
        fields += [(1, 2), (0, 1), (1, 1), (0, generator.VBV_PARAMETER_BITS)]
    fields += [(RECTANGULAR_SHAPE, 2), (1, 1), (resolution, 16), (1, 1)]
    return pack_bit_fields(fields, padding_bit=0)


def create_VOP(time_increment_bits: int, *, coded: bool, modulo_time_base: int = 0) -> bytes:
    """Returns a P-VOP header after its start code, coded or an N-VOP, and a byte of macroblock data."""

    fields = [(P_VOP, 2), *([(1, 1)] * modulo_time_base), (0, 1), (1, 1), (1, time_increment_bits), (1, 1), (int(coded), 1)]
    return pack_bit_fields(fields, padding_bit=1) + b"\x5a"


def create_element(element_ID: int, payload: bytes) -> bytes:
    return generator.encode_EBML_element(element_ID, payload)


def create_simple_block(timestamp: int, data: bytes, flags: int = 0) -> bytes:
    """Returns a SimpleBlock of track 1 at a timestamp relative to its cluster."""

    return create_element(generator.SIMPLE_BLOCK_ID, bytes((0x80 | TRACK_NUMBER,)) + struct.pack(">h", timestamp) + bytes((flags,)) + data)


def create_cluster(timestamp: int, children: Sequence[bytes]) -> bytes:
    return create_element(generator.CLUSTER_ID, create_element(generator.CLUSTER_TIMESTAMP_ID, timestamp.to_bytes(2, "big")) + b"".join(children))


def create_Matroska_file(clusters: Sequence[bytes], *, timestamp_scale: int = generator.NANOSECONDS_PER_MILLISECOND) -> bytes:
    """Returns FFmpeg's layout of a native MPEG-4 Part 2 track: a seek head, the info, the track, the clusters, and the cues."""

    video = create_element(generator.PIXEL_WIDTH_ID, bytes((TRACK_WIDTH,))) + create_element(generator.PIXEL_HEIGHT_ID, bytes((TRACK_HEIGHT,)))
    track_entry = b"".join((
        create_element(TRACK_NUMBER_ID, bytes((TRACK_NUMBER,))),
        create_element(generator.CODEC_ID_ID, NATIVE_CODEC_ID),
        create_element(generator.CODEC_PRIVATE_ID, VOL_EXTRADATA),
        create_element(generator.VIDEO_ID, video),
    ))
    segment = b"".join((
        create_element(generator.SEEK_HEAD_ID, SEEK_HEAD_PAYLOAD),
        create_element(generator.VOID_ID, bytes(4)),
        create_element(generator.INFO_ID, create_element(generator.TIMESTAMP_SCALE_ID, timestamp_scale.to_bytes(3, "big"))),
        create_element(generator.TRACKS_ID, create_element(generator.TRACK_ENTRY_ID, track_entry)),
        *clusters,
        create_element(generator.CUES_ID, CUES_PAYLOAD),
    ))
    return create_element(generator.EBML_HEADER_ID, b"matroska") + create_element(generator.SEGMENT_ID, segment)


def read_segment(content: bytes) -> list[tuple[int, bytes]]:
    top_level = generator.read_EBML_elements(content)
    return generator.read_EBML_elements(top_level[1][1])


def read_block_timestamps(content: bytes) -> list[tuple[int, bytes]]:
    """Returns each block's absolute timestamp and its frame, in file order."""

    blocks = []
    for element_ID, payload in read_segment(content):
        if element_ID != generator.CLUSTER_ID:
            continue
        children = generator.read_EBML_elements(payload)
        cluster_timestamp = int.from_bytes(generator.find_EBML_child(children, generator.CLUSTER_TIMESTAMP_ID), "big")
        for child_ID, block in children:
            if child_ID == generator.SIMPLE_BLOCK_ID:
                blocks.append((cluster_timestamp + struct.unpack(">h", block[1:3])[0], block[4:]))
    return blocks


class MediaTableTests(unittest.TestCase):
    def test_lists_each_medium_the_routes_read_once(self) -> None:
        self.assertEqual([medium.file_name for medium in generator.MEDIA], MEDIA_FILE_NAMES)

    def test_declares_the_self_test_stream_with_the_bit_exact_single_threaded_reference_and_a_BITMAPINFOHEADER(self) -> None:
        declared = json.loads(PROJECT_DECLARATION_PATH.read_text(encoding="utf-8"))["vectors"]

        self.assertEqual(declared, [{
            "format": "I420",
            "root": "decodersDirectory",
            "path": f"mpeg4/vectors/{SELF_TEST_FILE_NAME}",
            "decoderOptions": list(generator.REFERENCE_DECODER_OPTIONS),
            "codecPrivate": "bitmap-info-header",
        }])

    def test_encodes_the_self_test_stream_with_Xvid_GMC_quarter_samples_and_B_VOPs_from_a_moving_source(self) -> None:
        medium = next(medium for medium in generator.MEDIA if medium.file_name == SELF_TEST_FILE_NAME)
        arguments = generator.get_encode_arguments(medium, OUTPUT_PATH)

        self.assertEqual(arguments[arguments.index("-c:v") + 1], "libxvid")
        self.assertEqual(arguments[arguments.index("-gmc") + 1], "1")
        self.assertEqual(arguments[arguments.index("-bf") + 1], "2")
        self.assertEqual(arguments[arguments.index("-flags:v") + 1], "+bitexact+qpel")
        self.assertIn("rotate=", arguments[arguments.index("-i") + 1])
        self.assertIn("zoompan=", arguments[arguments.index("-i") + 1])
        self.assertEqual((medium.layout, medium.muxer), (generator.LAYOUT_RAW_REMUX, generator.RAW_MPEG4_MUXER))
        self.assertEqual(medium.picture_types, frozenset(("I", "P", "S", "B")))

    def test_encodes_every_medium_in_one_thread_without_varying_metadata(self) -> None:
        for medium in generator.MEDIA:
            with self.subTest(file_name=medium.file_name):
                arguments = generator.get_encode_arguments(medium, OUTPUT_PATH)

                self.assertEqual(arguments[arguments.index("-threads") + 1], "1")
                self.assertEqual(arguments[arguments.index("-map_metadata") + 1], "-1")
                self.assertEqual(arguments[arguments.index("-fflags") + 1], "+bitexact")
                self.assertTrue(arguments[arguments.index("-flags:v") + 1].startswith("+bitexact"))
                self.assertEqual(arguments[arguments.index("-frames:v") + 1], str(medium.frame_count))
                self.assertEqual(arguments[-4:], ["-f", medium.muxer, "-y", str(OUTPUT_PATH)])

    def test_remuxes_the_raw_stream_with_generated_presentation_timestamps(self) -> None:
        arguments = generator.get_remux_arguments(Path("coded.m4v"), OUTPUT_PATH)

        self.assertEqual(arguments[arguments.index("-fflags") + 1], "+genpts")
        self.assertLess(arguments.index("+genpts"), arguments.index("-i"))
        self.assertEqual(arguments[arguments.index("-c") + 1], "copy")
        self.assertEqual(arguments[-4:], ["-f", generator.MATROSKA_MUXER, "-y", str(OUTPUT_PATH)])


class NotCodedVOPTests(unittest.TestCase):
    def test_counts_the_time_increment_bits_as_FFmpeg_does(self) -> None:
        for resolution, bit_count in ((1, 1), (2, 1), (25, 5), (30000, 15), (65535, 16)):
            with self.subTest(resolution=resolution):
                self.assertEqual(generator.read_time_increment_bits(create_VOL(resolution)), bit_count)

    def test_skips_the_VBV_parameters_of_a_layer_with_control_parameters(self) -> None:
        self.assertEqual(generator.read_time_increment_bits(create_VOL(25, control_parameters=True)), 5)

    def test_reads_vop_coded_after_any_modulo_time_base(self) -> None:
        for modulo_time_base in (0, 2):
            with self.subTest(modulo_time_base=modulo_time_base):
                self.assertTrue(generator.is_coded_VOP(create_VOP(5, coded=True, modulo_time_base=modulo_time_base), 5))
                self.assertFalse(generator.is_coded_VOP(create_VOP(5, coded=False, modulo_time_base=modulo_time_base), 5))

    def test_drops_only_the_N_VOPs_and_keeps_every_header(self) -> None:
        coded = VOP_START_CODE + create_VOP(5, coded=True)
        not_coded = VOP_START_CODE + create_VOP(5, coded=False)
        headers = VIDEO_OBJECT_START_CODE + VOL_START_CODE + create_VOL(25)

        self.assertEqual(generator.drop_not_coded_VOPs(headers + coded + not_coded + coded + not_coded), headers + coded + coded)

    def test_refuses_a_VOP_before_its_layer_and_a_stream_that_starts_elsewhere(self) -> None:
        with self.assertRaisesRegex(generator.VectorGenerationError, "precedes the video object layer"):
            generator.drop_not_coded_VOPs(VOP_START_CODE + create_VOP(5, coded=True))
        with self.assertRaisesRegex(generator.VectorGenerationError, "does not start with a start code"):
            generator.drop_not_coded_VOPs(b"\x12" + VOL_START_CODE + create_VOL(25))


class VideoForWindowsRewriteTests(unittest.TestCase):
    def test_rewrites_the_native_track_into_a_VFW_track_with_FFmpeg_s_BITMAPINFOHEADER_before_the_extradata(self) -> None:
        content = generator.rewrite_as_VFW_track(create_Matroska_file([create_cluster(0, [create_simple_block(0, b"I")])]), "XVID")
        tracks = generator.find_EBML_child(read_segment(content), generator.TRACKS_ID)
        track_entry = generator.read_EBML_elements(generator.find_EBML_child(generator.read_EBML_elements(tracks), generator.TRACK_ENTRY_ID))
        codec_private = generator.find_EBML_child(track_entry, generator.CODEC_PRIVATE_ID)
        header = generator.BITMAP_INFO_HEADER.unpack(codec_private[:generator.BITMAP_INFO_HEADER.size])

        self.assertEqual(generator.find_EBML_child(track_entry, generator.CODEC_ID_ID), generator.VFW_CODEC_ID)
        self.assertEqual(header, (40 + len(VOL_EXTRADATA), TRACK_WIDTH, TRACK_HEIGHT, 1, 24, b"XVID", TRACK_WIDTH * TRACK_HEIGHT * 3, 0, 0, 0, 0))
        self.assertEqual(codec_private[generator.BITMAP_INFO_HEADER.size:], VOL_EXTRADATA)
        self.assertEqual(generator.find_EBML_child(track_entry, TRACK_NUMBER_ID), bytes((TRACK_NUMBER,)))

    def test_stamps_the_blocks_in_decode_order_one_frame_apart_across_clusters(self) -> None:
        clusters = [
            create_cluster(0, [create_simple_block(0, b"I", KEYFRAME_FLAG), create_simple_block(120, b"P"), create_simple_block(40, b"B")]),
            create_cluster(200, [create_simple_block(-120, b"B"), create_simple_block(40, b"P")]),
        ]
        content = generator.rewrite_as_VFW_track(create_Matroska_file(clusters), "XVID")
        step = generator.FRAME_DURATION_MILLISECONDS

        self.assertEqual(read_block_timestamps(content), [(0, b"I"), (step, b"P"), (2 * step, b"B"), (3 * step, b"B"), (4 * step, b"P")])

    def test_drops_the_seek_head_void_and_cues_whose_offsets_it_moves(self) -> None:
        content = generator.rewrite_as_VFW_track(create_Matroska_file([create_cluster(0, [create_simple_block(0, b"I")])]), "XVID")

        self.assertEqual([element_ID for element_ID, _ in read_segment(content)],
                         [generator.INFO_ID, generator.TRACKS_ID, generator.CLUSTER_ID])

    def test_refuses_block_groups_and_timestamps_not_in_milliseconds(self) -> None:
        block_group = create_element(BLOCK_GROUP_ID, b"")
        with self.assertRaisesRegex(generator.VectorGenerationError, "other than a timestamp and SimpleBlocks"):
            generator.rewrite_as_VFW_track(create_Matroska_file([create_cluster(0, [block_group])]), "XVID")
        with self.assertRaisesRegex(generator.VectorGenerationError, "expected milliseconds"):
            generator.rewrite_as_VFW_track(create_Matroska_file([], timestamp_scale=1_000), "XVID")


class GenerationTests(unittest.TestCase):
    def run_generator(self, directory: Path, command_arguments: Sequence[str]) -> tuple[int, str, str]:
        """Runs the generator with encodes that return the committed media and checks that pass."""

        ffmpeg_path = directory / "ffmpeg"
        ffprobe_path = directory / "ffprobe"
        ffmpeg_path.write_bytes(b"")
        ffprobe_path.write_bytes(b"")
        with patch.object(generator, "VECTOR_DIRECTORY", directory / "vectors"), \
                patch.object(generator, "encode_medium", side_effect=lambda medium, *_: (COMMITTED_VECTOR_DIRECTORY / medium.file_name).read_bytes()), \
                patch.object(generator, "verify_medium"):
            return run_main(generator.main, ["--ffmpeg", str(ffmpeg_path), "--ffprobe", str(ffprobe_path), *command_arguments])

    def test_installs_missing_media_as_the_committed_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            status, output, error = self.run_generator(directory, [])

            self.assertEqual((status, error), (0, ""))
            self.assertIn(f"Generated {len(generator.MEDIA)} MPEG-4 decoder project media", output)
            for medium in generator.MEDIA:
                self.assertEqual((directory / "vectors" / medium.file_name).read_bytes(), (COMMITTED_VECTOR_DIRECTORY / medium.file_name).read_bytes())

    def test_check_fails_on_a_missing_medium(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            status, _, error = self.run_generator(directory, ["--check"])

            self.assertEqual(status, 1)
            self.assertIn("Committed output is missing", error)
            self.assertFalse((directory / "vectors").exists())

    def test_never_replaces_a_differing_medium(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            (directory / "vectors").mkdir()
            existing_path = directory / "vectors" / generator.MEDIA[0].file_name
            existing_path.write_bytes(OTHER_BYTES)
            status, _, error = self.run_generator(directory, [])

            self.assertEqual(status, 1)
            self.assertIn("differs from the committed bytes", error)
            self.assertEqual(existing_path.read_bytes(), OTHER_BYTES)

    def test_refuses_a_missing_explicit_tool(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            status, _, error = run_main(generator.main, ["--ffmpeg", str(Path(temporary_directory) / "ffmpeg")])

            self.assertEqual(status, 1)
            self.assertIn("ffmpeg was not found", error)


if __name__ == "__main__":
    unittest.main()
