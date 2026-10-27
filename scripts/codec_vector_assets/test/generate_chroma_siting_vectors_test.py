"""Tests the chroma siting vector generator's removal of an avc3 or hev1 record's parameter sets without running FFmpeg."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import generate_chroma_siting_vectors as generator  # noqa: E402
from media_tools import VectorGenerationError  # noqa: E402
from vector_test_support import box  # noqa: E402

# A High avcC of four-byte lengths with one SPS and one PPS, then its closing chroma_format, bit depth, and SPS extension count
AVCC_HEADER = bytes((1, 0x64, 0, 0x0C, 0xFF))
SEQUENCE_PARAMETER_SET = bytes((0x67, 0x64, 0x00, 0x0C, 0xAC))
PICTURE_PARAMETER_SET = bytes((0x68, 0xEB, 0xE3))
AVCC_HIGH_EXTENSION = bytes((0xFD, 0xF8, 0xF8, 0))
AVCC = (
    AVCC_HEADER + bytes((0xE1, 0, len(SEQUENCE_PARAMETER_SET))) + SEQUENCE_PARAMETER_SET
    + bytes((1, 0, len(PICTURE_PARAMETER_SET))) + PICTURE_PARAMETER_SET + AVCC_HIGH_EXTENSION
)
# An hvcC's 22 fixed bytes, then one SPS array
HVCC_HEADER = bytes(range(1, 23))
HVCC = HVCC_HEADER + bytes((1, 0xA1, 0, 1, 0, 2, 0x42, 0x01))
MEDIA_DATA = box("mdat", b"\x00\x00\x00\x02\x65\x88")


def create_movie(sample_entry_type: str, record_type: str, record: bytes) -> bytes:
    """Returns a movie box down to one sample entry that holds a record, after the media data as FFmpeg writes it."""

    sample_entry = box(sample_entry_type, bytes(generator.VISUAL_SAMPLE_ENTRY_BYTE_LENGTH) + box(record_type, record))
    sample_description = box("stsd", bytes((0, 0, 0, 0, 0, 0, 0, 1)) + sample_entry)
    track = box("trak", box("mdia", box("minf", box("stbl", sample_description))))
    return MEDIA_DATA + box("moov", track)


class RecordParameterSetRemovalTests(unittest.TestCase):
    """Covers the record rewrite and the resizing of every box around it."""

    def test_keeps_an_avcc_header_and_its_closing_fields_without_its_parameter_sets(self) -> None:
        stripped = generator.remove_record_parameter_sets(create_movie("avc3", "avcC", AVCC))

        self.assertEqual(stripped, create_movie("avc3", "avcC", AVCC_HEADER + bytes((0xE0, 0)) + AVCC_HIGH_EXTENSION))
        self.assertEqual(len(AVCC_HEADER + bytes((0xE0, 0)) + AVCC_HIGH_EXTENSION), generator.STRIPPED_AVCC_BYTE_LENGTH)

    def test_keeps_an_hvcc_header_without_its_arrays(self) -> None:
        stripped = generator.remove_record_parameter_sets(create_movie("hev1", "hvcC", HVCC))

        self.assertEqual(stripped, create_movie("hev1", "hvcC", HVCC_HEADER + b"\x00"))
        self.assertEqual(len(HVCC_HEADER) + 1, generator.STRIPPED_HVCC_BYTE_LENGTH)

    def test_leaves_an_avc1_record_alone(self) -> None:
        movie = create_movie("avc1", "avcC", AVCC)

        self.assertEqual(generator.remove_record_parameter_sets(movie), movie)

    def test_refuses_a_movie_box_before_the_media_data(self) -> None:
        movie = create_movie("avc3", "avcC", AVCC)
        moved = movie[len(MEDIA_DATA):] + MEDIA_DATA

        with self.assertRaises(VectorGenerationError):
            generator.remove_record_parameter_sets(moved)


if __name__ == "__main__":
    unittest.main()
