"""Tests the MPEG-2 decoder vector generator's coding and container writing without running FFmpeg."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Sequence
from unittest.mock import patch


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import generate_mpeg2_decoder_vectors as generator  # noqa: E402
from generated_output import GeneratedOutputError  # noqa: E402
from vector_test_support import run_main  # noqa: E402


# Saved before any test replaces generator.VECTOR_DIRECTORY
COMMITTED_VECTOR_DIRECTORY = generator.VECTOR_DIRECTORY
START_CODE_PREFIX = b"\x00\x00\x01"
SEQUENCE_HEADER = START_CODE_PREFIX + bytes((generator.SEQUENCE_HEADER_CODE,))
PICTURE_START = START_CODE_PREFIX + bytes((generator.PICTURE_START_CODE,))
EXTENSION_START = START_CODE_PREFIX + bytes((generator.EXTENSION_START_CODE,))
# Every vector codes ten frames in two GOPs
VECTOR_FRAME_COUNT = 10
VECTOR_FORMAT_CHROMA = (generator.CHROMA_420, generator.CHROMA_422, generator.CHROMA_444)
FLAT_SAMPLE = 37
BLOCK_SAMPLES = 64
# A flat block's DC is eight times its sample in the transform's scale
FLAT_BLOCK_DC = 8 * FLAT_SAMPLE
F_CODES = (1, 2, 5, 9)
# About how many evenly spaced values of each f_code's range the motion test codes, besides its highest
MOTION_VALUE_STEPS = 97
# Bits after a code, so a decoder looking past its end reads zeros as at a slice's end
TRAILING_BITS = "0" * 16
# Three bits, then a picture start code from the next byte boundary, then one bit
BITS_AROUND_START_CODE = bytes((0b10100000, 0x00, 0x00, 0x01, generator.PICTURE_START_CODE, 0b10000000))
HALVED_VALUES = (-3, -2, -1, 0, 1, 3)
TRUNCATED_HALVES = [-1, -1, 0, 0, 0, 1]
MOTION_CODE_BITS = 5
# A SimpleBlock's track number, then its 16-bit relative timestamp and its flags
SIMPLE_BLOCK_TIMESTAMP_START = 1
SIMPLE_BLOCK_TIMESTAMP_END = 3
SIMPLE_BLOCK_HEADER_BYTES = 4
SEED = 12345
DRAW_COUNT = 1000
PERCENT_BOUND = 100
MD5_LINE = b"MD5=0123456789abcdef0123456789abcdef"
OTHER_MD5_LINE = b"MD5=fedcba9876543210fedcba9876543210"
PROBLEM_LOG = b"[mpeg2video @ 0] ac-tex damaged at 3 4\n"
CLEAN_LOG = b"[mpeg2video @ 0] Format yuv420p chosen by get_format().\n"


def decode_code(table: Sequence[tuple[int, int]], bits: str) -> int:
    """The index of the table's code that starts bits, as a decoder reading most significant bits first finds it."""

    matches = [index for index, (code, length) in enumerate(table) if bits.startswith(format(code, f"0{length}b"))]
    if len(matches) != 1:
        raise AssertionError(f"{len(matches)} codes start {bits}")
    return matches[0]


def decode_motion(bits: str, f_code: int, prediction: int) -> tuple[int, int]:
    """FFmpeg's mpeg_decode_motion over a bit string: the vector and the bits it read."""

    index = decode_code(generator.MOTION_CODE_CODES, bits)
    position = generator.MOTION_CODE_CODES[index][1]
    if index == 0:
        return prediction, position
    negative = bits[position] == "1"
    position += 1
    shift = f_code - 1
    value = index
    if shift:
        value = ((value - 1) << shift) | int(bits[position:position + shift], 2)
        value += 1
        position += shift
    if negative:
        value = -value
    return generator.sign_extend(value + prediction, 5 + shift), position


def written_bits(writer: generator.BitWriter) -> str:
    """The bits a writer holds, its partial byte included."""

    whole = "".join(format(byte, "08b") for byte in writer.buffer)
    return whole + (format(writer.accumulator, f"0{writer.pending_bits}b") if writer.pending_bits else "")


def read_ebml_elements(data: bytes) -> list[tuple[int, bytes]]:
    """The elements at one level of EBML data: their IDs and payloads."""

    elements = []
    position = 0
    while position < len(data):
        identifier_length = 1
        while not data[position] & (0x80 >> (identifier_length - 1)):
            identifier_length += 1
        identifier = int.from_bytes(data[position:position + identifier_length], "big")
        position += identifier_length
        size_length = 1
        while not data[position] & (0x80 >> (size_length - 1)):
            size_length += 1
        size = int.from_bytes(data[position:position + size_length], "big") & ((1 << (7 * size_length)) - 1)
        position += size_length
        elements.append((identifier, data[position:position + size]))
        position += size
    return elements


class BitWriterTests(unittest.TestCase):
    def test_writes_most_significant_bits_first_and_pads_start_codes_with_zero(self) -> None:
        writer = generator.BitWriter()
        writer.write(0b101, 3)
        writer.start_code(generator.PICTURE_START_CODE)
        writer.write(0b1, 1)

        self.assertEqual(writer.take(), BITS_AROUND_START_CODE)


class CodeTableTests(unittest.TestCase):
    def test_every_coefficient_code_decodes_to_its_run_and_level(self) -> None:
        for table, codes in ((generator.B14_CODES, generator.B14_COEFFICIENT_CODES), (generator.B15_CODES, generator.B15_COEFFICIENT_CODES)):
            for (run, level), (code, length) in codes.items():
                with self.subTest(run=run, level=level):
                    index = decode_code(table, format(code, f"0{length}b") + TRAILING_BITS)
                    self.assertEqual((generator.COEFFICIENT_RUNS[index], generator.COEFFICIENT_LEVELS[index]), (run, level))

    def test_every_variable_length_table_is_prefix_free(self) -> None:
        tables = (
            generator.MACROBLOCK_ADDRESS_INCREMENT_CODES,
            generator.CODED_BLOCK_PATTERN_CODES,
            generator.MOTION_CODE_CODES,
            generator.DC_SIZE_LUMINANCE_CODES,
            generator.DC_SIZE_CHROMINANCE_CODES,
            tuple(generator.P_MACROBLOCK_TYPE_CODES.values()),
            tuple(generator.B_MACROBLOCK_TYPE_CODES.values()),
        )
        for table in tables:
            for code, length in table:
                with self.subTest(code=code, length=length):
                    decode_code(table, format(code, f"0{length}b") + TRAILING_BITS)


class MotionCodingTests(unittest.TestCase):
    def test_vectors_across_an_f_code_range_decode_as_written_from_any_prediction(self) -> None:
        encoder = generator.PictureEncoder.__new__(generator.PictureEncoder)
        for f_code in F_CODES:
            low = -(16 << (f_code - 1))
            high = (16 << (f_code - 1)) - 1
            values = [*range(low, high, max(1, (high - low) // MOTION_VALUE_STEPS)), high]
            for prediction in (low, 0, high):
                for value in values:
                    with self.subTest(f_code=f_code, prediction=prediction, value=value):
                        encoder.writer = generator.BitWriter()
                        encoder.write_motion_component(value, prediction, f_code)
                        bits = written_bits(encoder.writer)
                        self.assertEqual(decode_motion(bits + TRAILING_BITS, f_code, prediction), (value, len(bits)))


class ArithmeticTests(unittest.TestCase):
    def test_halves_toward_zero_as_c_divides(self) -> None:
        self.assertEqual([generator.truncating_half(value) for value in HALVED_VALUES], TRUNCATED_HALVES)

    def test_sign_extends_as_ffmpeg(self) -> None:
        largest = (1 << (MOTION_CODE_BITS - 1)) - 1
        smallest = -(1 << (MOTION_CODE_BITS - 1))

        self.assertEqual(generator.sign_extend((1 << MOTION_CODE_BITS) - 1, MOTION_CODE_BITS), -1)
        self.assertEqual(generator.sign_extend(largest, MOTION_CODE_BITS), largest)
        self.assertEqual(generator.sign_extend(smallest - 1, MOTION_CODE_BITS), largest)

    def test_transforms_a_flat_block_to_its_dc_alone(self) -> None:
        coefficients = generator.forward_dct([FLAT_SAMPLE] * BLOCK_SAMPLES)

        self.assertEqual(coefficients[0], FLAT_BLOCK_DC)
        self.assertEqual(coefficients[1:], [0] * (BLOCK_SAMPLES - 1))

    def test_draws_the_same_choices_from_a_seed(self) -> None:
        first = generator.Random(SEED)
        second = generator.Random(SEED)

        draws = [first.below(PERCENT_BOUND) for _ in range(DRAW_COUNT)]
        self.assertEqual(draws, [second.below(PERCENT_BOUND) for _ in range(DRAW_COUNT)])
        self.assertTrue(all(0 <= draw < PERCENT_BOUND for draw in draws))


class VectorFileTests(unittest.TestCase):
    def test_writes_the_same_bytes_each_time(self) -> None:
        for specification in generator.VECTORS:
            with self.subTest(file_name=specification.file_name):
                self.assertEqual(generator.vector_file(specification), generator.vector_file(specification))

    def test_writes_one_MPEG2_track_whose_blocks_are_the_coded_frames_in_decode_order(self) -> None:
        for specification, chroma_format in zip(generator.VECTORS, VECTOR_FORMAT_CHROMA, strict=True):
            with self.subTest(file_name=specification.file_name):
                self.assertEqual(specification.sequence.chroma_format, chroma_format)
                top_level = read_ebml_elements(generator.vector_file(specification))
                self.assertEqual([identifier for identifier, _ in top_level], [generator.EBML_HEADER_ID, generator.SEGMENT_ID])
                segment = dict(read_ebml_elements(top_level[1][1]))
                track = dict(read_ebml_elements(dict(read_ebml_elements(segment[generator.TRACKS_ID]))[generator.TRACK_ENTRY_ID]))
                self.assertEqual(track[generator.CODEC_ID_ID], generator.MPEG2_CODEC_ID)
                self.assertTrue(track[generator.CODEC_PRIVATE_ID].startswith(SEQUENCE_HEADER))
                self.assertIn(EXTENSION_START, track[generator.CODEC_PRIVATE_ID])
                blocks = [payload for identifier, payload in read_ebml_elements(segment[generator.CLUSTER_ID])
                          if identifier == generator.SIMPLE_BLOCK_ID]
                self.assertEqual(len(blocks), VECTOR_FRAME_COUNT)
                timestamps = [int.from_bytes(block[SIMPLE_BLOCK_TIMESTAMP_START:SIMPLE_BLOCK_TIMESTAMP_END], "big", signed=True) for block in blocks]
                self.assertEqual(sorted(timestamps), [index * generator.FRAME_DURATION_MILLISECONDS for index in range(VECTOR_FRAME_COUNT)])
                self.assertNotEqual(timestamps, sorted(timestamps))
                self.assertTrue(all(PICTURE_START in block for block in blocks))
                self.assertTrue(blocks[0][SIMPLE_BLOCK_HEADER_BYTES:].startswith(SEQUENCE_HEADER))

    def test_codes_field_pairs_in_one_packet(self) -> None:
        for specification in generator.VECTORS:
            frames = generator.encode_vector(specification)
            for frame, frame_specification in zip(frames, specification.frames, strict=True):
                with self.subTest(file_name=specification.file_name, display_index=frame.display_index):
                    self.assertEqual(frame.data.count(PICTURE_START), len(frame_specification.pictures))


class GenerationTests(unittest.TestCase):
    def test_check_passes_on_the_committed_vectors(self) -> None:
        self.assertEqual(generator.generate_vectors(check=True, validate=False), len(generator.VECTORS))

    def test_check_fails_on_a_changed_vector_and_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            for specification in generator.VECTORS:
                (directory / specification.file_name).write_bytes(b"other bytes")
            with patch.object(generator, "VECTOR_DIRECTORY", directory):
                status, _, error = run_main(generator.main, ["--check", "--no-validate"])
                self.assertEqual(status, 1)
                self.assertIn("differs from the committed bytes", error)
                self.assertEqual((directory / generator.VECTORS[0].file_name).read_bytes(), b"other bytes")

    def test_generation_writes_every_vector(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            with patch.object(generator, "VECTOR_DIRECTORY", directory):
                status, output, _ = run_main(generator.main, ["--no-validate"])
            self.assertEqual(status, 0)
            self.assertIn(f"Generated {len(generator.VECTORS)} MPEG-2 decoder vectors", output)
            for specification in generator.VECTORS:
                self.assertEqual((directory / specification.file_name).read_bytes(), (COMMITTED_VECTOR_DIRECTORY / specification.file_name).read_bytes())

    def test_raises_on_the_committed_vectors_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory, patch.object(generator, "VECTOR_DIRECTORY", Path(temporary_directory)):
            with self.assertRaises(GeneratedOutputError):
                generator.generate_vectors(check=True, validate=False)


class FFmpegValidationTests(unittest.TestCase):
    def run_validation(self, log: bytes, digests: tuple[bytes, bytes]) -> None:
        responses = iter((
            subprocess.CompletedProcess([], 0, b"", log),
            subprocess.CompletedProcess([], 0, digests[0], b""),
            subprocess.CompletedProcess([], 0, digests[1], b""),
        ))
        with patch.object(generator.subprocess, "run", side_effect=lambda *_arguments, **_options: next(responses)):
            generator.validate_with_ffmpeg(Path("vector.mkv"))

    def test_accepts_a_clean_decode_that_both_simple_IDCTs_agree_on(self) -> None:
        self.run_validation(CLEAN_LOG, (MD5_LINE, MD5_LINE))

    def test_fails_on_a_stream_problem_FFmpeg_logs(self) -> None:
        with self.assertRaisesRegex(generator.VectorGenerationError, "does not decode vector.mkv cleanly"):
            self.run_validation(PROBLEM_LOG, (MD5_LINE, MD5_LINE))

    def test_fails_when_the_SIMD_and_C_simple_IDCTs_disagree(self) -> None:
        with self.assertRaisesRegex(generator.VectorGenerationError, "decode vector.mkv differently"):
            self.run_validation(CLEAN_LOG, (MD5_LINE, OTHER_MD5_LINE))


if __name__ == "__main__":
    unittest.main()
