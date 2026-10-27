"""Tests the AVI rewrites on small synthetic AVI files, without running FFmpeg."""

from __future__ import annotations

import struct
import sys
import unittest
from pathlib import Path


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

from avi_rewriting import (  # noqa: E402
    AVIIF_KEYFRAME,
    DIVX_PACKED_USER_DATA,
    STANDARD_INDEX_DELTA_FRAME,
    VOP_START_CODE,
    read_chunks,
    pack_DivX_B_frames,
    split_into_OpenDML_RIFF_lists,
)
from media_tools import VectorGenerationError, pack_bit_fields  # noqa: E402

SUPER_INDEX_ENTRY_COUNT = 4
# A video object layer header with a vop_time_increment_resolution of 24, so a VOP's time increment takes 5 bits
VOL_HEADER = b"\x00\x00\x01\x20" + pack_bit_fields(((0, 1), (1, 8), (0, 1), (1, 4), (0, 1), (0, 2), (1, 1), (24, 16), (1, 1)), padding_bit=0)
VOP_CODING_TYPES = {"I": 0, "P": 1, "B": 2}


def chunk(fourcc: bytes, data: bytes) -> bytes:
    return fourcc + struct.pack("<I", len(data)) + data + (b"\x00" if len(data) & 1 else b"")


def list_chunk(list_type: bytes, children: bytes) -> bytes:
    return chunk(b"LIST", list_type + children)


def VOP(coding_type: str, payload_size: int = 40) -> bytes:
    return VOP_START_CODE + bytes([VOP_CODING_TYPES[coding_type] << 6]) + bytes(range(1, payload_size))


def create_AVI(video_chunks: list[tuple[bytes, int]]) -> bytes:
    """Returns a one-RIFF AVI laid out as FFmpeg's muxer writes it, with one video stream of the given chunks and flags."""

    stream_header = b"vids" + b"\x00" * 40 + struct.pack("<I", 0) + b"\x00" * 8
    super_index_reservation = struct.pack("<HBBI4s", 4, 0, 0, 0, b"00dc") + b"\x00" * (12 + 16 * SUPER_INDEX_ENTRY_COUNT)
    header = list_chunk(b"hdrl", (
        chunk(b"avih", b"\x00" * 56)
        + list_chunk(b"strl", chunk(b"strh", stream_header) + chunk(b"strf", b"\x00" * 40) + chunk(b"JUNK", super_index_reservation))
        + chunk(b"JUNK", b"odmldmlh" + struct.pack("<I", 248) + b"\x00" * 248)
    ))
    movie = b""
    index = b""
    for data, flags in video_chunks:
        index += struct.pack("<4sIII", b"00dc", flags, 4 + len(movie), len(data))
        movie += chunk(b"00dc", data)
    body = b"AVI " + header + list_chunk(b"movi", movie) + chunk(b"idx1", index)
    return b"RIFF" + struct.pack("<I", len(body)) + body


def read_top_level(data: bytes) -> list[tuple[bytes, int, int]]:
    return [(entry.fourcc + data[entry.data_position:entry.data_position + 4], entry.data_position, entry.size) for entry in read_chunks(data, 0, len(data))]


class SplitIntoOpenDMLRIFFListsTest(unittest.TestCase):
    def test_indexes_every_chunk_across_the_RIFF_lists(self) -> None:
        frames = [(bytes([frame_number]) * 300, AVIIF_KEYFRAME if frame_number % 3 == 0 else 0) for frame_number in range(9)]
        source = create_AVI(frames)
        # A limit about two 308-byte chunks past the header, so the nine chunks take several RIFF lists
        rewrite = split_into_OpenDML_RIFF_lists(source, len(source) - len(frames) * 308 + 700)

        RIFF_lists = read_top_level(rewrite)
        self.assertEqual([fourcc for fourcc, _, _ in RIFF_lists][0], b"RIFFAVI ")
        self.assertGreater(len(RIFF_lists), 2)
        self.assertTrue(all(fourcc == b"RIFFAVIX" for fourcc, _, _ in RIFF_lists[1:]))

        super_index_position = rewrite.index(b"indx") + 8
        entry_count = struct.unpack_from("<I", rewrite, super_index_position + 4)[0]
        self.assertEqual(entry_count, len(RIFF_lists))
        indexed: list[tuple[bytes, bool]] = []
        for entry_number in range(entry_count):
            offset, size, duration = struct.unpack_from("<QII", rewrite, super_index_position + 24 + entry_number * 16)
            self.assertEqual(rewrite[offset:offset + 4], b"ix00")
            self.assertEqual(size, 8 + struct.unpack_from("<I", rewrite, offset + 4)[0])
            _, _, index_type, entries_in_use, chunk_id, base_offset = struct.unpack_from("<HBBI4sQ", rewrite, offset + 8)
            self.assertEqual((index_type, chunk_id), (1, b"00dc"))
            self.assertEqual(duration, entries_in_use)
            for chunk_number in range(entries_in_use):
                chunk_offset, size_field = struct.unpack_from("<II", rewrite, offset + 32 + chunk_number * 8)
                position = base_offset + chunk_offset
                self.assertEqual(rewrite[position - 8:position - 4], b"00dc")
                chunk_size = size_field & ~STANDARD_INDEX_DELTA_FRAME
                indexed.append((rewrite[position:position + chunk_size], not size_field & STANDARD_INDEX_DELTA_FRAME))
        self.assertEqual(indexed, [(data, bool(flags)) for data, flags in frames])

        # idx1 follows the first RIFF list's movi list and lists only its chunks; dmlh counts them all, avih the first list's
        first_RIFF_children = read_chunks(rewrite, 12, 8 + RIFF_lists[0][2])
        index = next(entry for entry in first_RIFF_children if entry.fourcc == b"idx1")
        first_RIFF_count = index.size // 16
        self.assertEqual(first_RIFF_count, struct.unpack_from("<I", rewrite, super_index_position + 24 + 12)[0])
        self.assertEqual(struct.unpack_from("<I", rewrite, rewrite.index(b"avih") + 8 + 16)[0], first_RIFF_count)
        self.assertEqual(struct.unpack_from("<I", rewrite, rewrite.index(b"odmldmlh") + 12)[0], len(frames))
        self.assertEqual(rewrite[rewrite.index(b"odmldmlh") - 8:rewrite.index(b"odmldmlh") - 4], b"LIST")

    def test_refuses_chunks_that_fit_one_RIFF_list(self) -> None:
        source = create_AVI([(b"\x01" * 10, AVIIF_KEYFRAME)])
        with self.assertRaises(VectorGenerationError):
            split_into_OpenDML_RIFF_lists(source, len(source) * 2)


class PackDivXBFramesTest(unittest.TestCase):
    def test_packs_each_run_of_B_VOPs_after_its_reference_and_fills_the_slot(self) -> None:
        decode_order = ["I", "P", "B", "P", "B", "B", "I"]
        frames = [((VOL_HEADER if coding_type == "I" else b"") + VOP(coding_type), AVIIF_KEYFRAME if coding_type == "I" else 0) for coding_type in decode_order]
        rewrite = pack_DivX_B_frames(create_AVI(frames))

        movie_list = next(entry for entry in read_chunks(rewrite, 12, len(rewrite)) if entry.fourcc == b"LIST" and rewrite[entry.data_position:entry.data_position + 4] == b"movi")
        chunks = [rewrite[entry.data_position:entry.data_position + entry.size] for entry in read_chunks(rewrite, movie_list.data_position + 4, movie_list.data_position + movie_list.size)]
        self.assertEqual(len(chunks), len(frames))
        vop_types = [["IPBS"[data[position + 4] >> 6] for position in range(len(data) - 4) if data[position:position + 4] == VOP_START_CODE] for data in chunks]
        self.assertEqual(vop_types, [["I"], ["P", "B"], ["P"], ["P", "B"], ["B"], ["P"], ["I"]])
        # The N-VOPs are small enough for FFmpeg to take as N-VOPs, and the key frames carry the packed marker
        self.assertTrue(all(len(chunks[slot]) <= 19 for slot in (2, 5)))
        self.assertTrue(all(DIVX_PACKED_USER_DATA in chunks[slot] for slot in (0, 6)))
        self.assertEqual(chunks[1], frames[1][0] + frames[2][0])
        # idx1 locates each chunk and keeps the key flags
        index = next(entry for entry in read_chunks(rewrite, 12, len(rewrite)) if entry.fourcc == b"idx1")
        entries = [struct.unpack_from("<4sIII", rewrite, index.data_position + offset) for offset in range(0, index.size, 16)]
        self.assertEqual([entry[1] for entry in entries], [AVIIF_KEYFRAME, 0, 0, 0, 0, 0, AVIIF_KEYFRAME])
        self.assertEqual([rewrite[movie_list.data_position + entry[2] + 8:][:entry[3]] for entry in entries], chunks)


if __name__ == "__main__":
    unittest.main()
