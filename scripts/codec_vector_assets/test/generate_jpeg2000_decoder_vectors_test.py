"""Tests the JPEG 2000 decoder vector generator's vector table, encode arguments, and Motion JPEG 2000 muxer without running FFmpeg."""

from __future__ import annotations

import json
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Sequence
from unittest.mock import patch


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import generate_jpeg2000_decoder_vectors as generator  # noqa: E402
from vector_test_support import run_main  # noqa: E402


# Saved before any test replaces generator.VECTOR_DIRECTORY
COMMITTED_VECTOR_DIRECTORY = generator.VECTOR_DIRECTORY
PROJECT_DECLARATION_PATH = COMMITTED_VECTOR_DIRECTORY.parent / "decoder.json"
# The engine's output formats in its order, each with the FFmpeg pixel format its vector's stream must have
PIXEL_FORMATS = {
    "I420": "yuv420p",
    "I420P10": "yuv420p10le",
    "I420P12": "yuv420p12le",
    "I422": "yuv422p",
    "I422P10": "yuv422p10le",
    "I422P12": "yuv422p12le",
    "I444": "yuv444p",
    "I444P10": "yuv444p10le",
    "I444P12": "yuv444p12le",
}
PROGRESSION_ORDERS = {"lrcp", "rlcp", "rpcl", "pcrl", "cprl"}
PROGRESSION_FLAGS = ("-prog", "-prog_order")
# File names carry the wavelet; FFmpeg's native encoder takes 5/3 with -pred dwt53, libopenjpeg takes 9/7 with -irreversible 1
IRREVERSIBLE_NAME_MARK = "-97-"
NATIVE_ENCODER = "jpeg2000"
NATIVE_REVERSIBLE_ARGUMENTS = ("-pred", "dwt53")
OPENJPEG_IRREVERSIBLE_ARGUMENTS = ("-irreversible", "1")
CODEC_FLAG = "-c:v"
OUTPUT_PATH = Path("encoded.mov")
# A JP2 file's leading signature box, and the start of a bare codestream: SOC, then SIZ
BARE_CODESTREAM = b"\xff\x4f\xff\x51" + bytes(8)
JP2_FILE_SAMPLE = generator.SIGNATURE_BOX + b"\x00\x00\x00\x08ftyp"
SAMPLES = (b"first sample", b"second", b"the third sample")
MUX_WIDTH = 211
MUX_HEIGHT = 75
MUX_LAYOUT = generator.PixelLayout(bits=10, components=3)
TOP_LEVEL_BOX_TYPES = [b"jP  ", b"ftyp", b"mdat", b"moov"]
SAMPLE_TABLE_PATH = (b"moov", b"trak", b"mdia", b"minf", b"stbl")
# A full box's version and flags, before its fields, and the sample description's entry count after them
FULL_BOX_PREFIX_LENGTH = 4
ENTRY_COUNT_LENGTH = 4
# The visual sample entry's fields before its child boxes
VISUAL_SAMPLE_ENTRY_LENGTH = 78
UNSIGNED_WORD = ">I"
OTHER_BYTES = b"other bytes"
FAILED_ENCODE_MESSAGE = b"Unknown encoder"
# What the fake encoder writes as the Digital Cinema stream's cover, which the stream's committed bytes already hold
COVER_BYTES = b"cover"


def read_boxes(data: bytes) -> list[tuple[bytes, bytes]]:
    """The boxes at one level of ISO base media data: their types and payloads."""

    boxes = []
    position = 0
    while position < len(data):
        size = int.from_bytes(data[position:position + 4], "big")
        boxes.append((data[position + 4:position + 8], data[position + 8:position + size]))
        position += size
    return boxes


def find_box(data: bytes, path: Sequence[bytes]) -> bytes:
    """The payload of the box a path of nested box types names."""

    payload = data
    for box_type in path:
        payload = dict(read_boxes(payload))[box_type]
    return payload


def read_full_box_words(payload: bytes) -> list[int]:
    """The 32-bit fields of a full box after its version and flags."""

    fields = payload[FULL_BOX_PREFIX_LENGTH:]
    return [value for (value,) in struct.iter_unpack(UNSIGNED_WORD, fields)]


def read_samples_of(content: bytes) -> list[bytes]:
    """The samples of a one-chunk Motion JPEG 2000 file, by its chunk offset and sample sizes."""

    sample_table = dict(read_boxes(find_box(content, SAMPLE_TABLE_PATH)))
    _, sample_count, *sizes = read_full_box_words(sample_table[b"stsz"])
    _, offset = read_full_box_words(sample_table[b"stco"])
    samples = []
    for size in sizes[:sample_count]:
        samples.append(content[offset:offset + size])
        offset += size
    return samples


def unwrap_sample(vector: generator.DecoderVector, sample: bytes) -> bytes:
    """The encoder's output a committed sample was made of: a codestream box's payload, or the JP2 file itself."""

    if vector.sample_kind == generator.SAMPLE_CODESTREAM_BOX:
        box_type, payload = read_boxes(sample)[0]
        if box_type != b"jp2c":
            raise AssertionError(f"{vector.file_name}: a sample of type {box_type!r}")
        return payload
    return sample


def is_irreversible(vector: generator.DecoderVector) -> bool:
    """Whether a vector's encoder arguments select the 9/7 wavelet."""

    arguments = vector.encoder_arguments
    encoder = arguments[arguments.index(CODEC_FLAG) + 1]
    pairs = list(zip(arguments, arguments[1:]))
    if encoder == NATIVE_ENCODER:
        return NATIVE_REVERSIBLE_ARGUMENTS not in pairs
    return OPENJPEG_IRREVERSIBLE_ARGUMENTS in pairs


def get_progression_order(vector: generator.DecoderVector) -> str:
    arguments = vector.encoder_arguments
    flag = next(flag for flag in PROGRESSION_FLAGS if flag in arguments)
    return arguments[arguments.index(flag) + 1]


class FakeTools:
    """Stands in for FFmpeg and FFprobe: an encode writes the committed QuickTime or Matroska file, a cover, or for an MJ2 vector its name,
    and a probe returns the committed MJ2 file's samples as the encoder wrote them."""

    def __init__(self, exit_status: int = 0) -> None:
        self.exit_status = exit_status
        self.vectors_by_scale = {f"scale={vector.width}:{vector.height}": vector for vector in generator.VECTORS}
        self.vectors_by_name = {vector.file_name: vector for vector in generator.VECTORS}

    def run(self, command: Sequence[str], **_options: object) -> subprocess.CompletedProcess[bytes]:
        if self.exit_status != 0:
            return subprocess.CompletedProcess(command, self.exit_status, b"", FAILED_ENCODE_MESSAGE)
        output_path = Path(command[-1])
        # The Digital Cinema stream's cover, then the stream itself, which scale no source
        if "-vf" not in command:
            is_cover = output_path.name == generator.COVER_FILE_NAME
            output_path.write_bytes(COVER_BYTES if is_cover else (COMMITTED_VECTOR_DIRECTORY / generator.DIGITAL_CINEMA_FILE_NAME).read_bytes())
            return subprocess.CompletedProcess(command, 0, b"", b"")
        vector = self.vectors_by_scale[command[command.index("-vf") + 1]]
        if vector.container == generator.CONTAINER_MOV:
            output_path.write_bytes((COMMITTED_VECTOR_DIRECTORY / vector.file_name).read_bytes())
        else:
            output_path.write_text(vector.file_name)
        return subprocess.CompletedProcess(command, 0, b"", b"")

    def read_samples(self, _ffprobe_path: Path, media_path: Path) -> list[bytes]:
        vector = self.vectors_by_name[media_path.read_text()]
        committed = (COMMITTED_VECTOR_DIRECTORY / vector.file_name).read_bytes()
        return [unwrap_sample(vector, sample) for sample in read_samples_of(committed)]


class VectorTableTests(unittest.TestCase):
    def test_lists_one_vector_per_output_format_in_the_engine_order_with_its_pixel_format(self) -> None:
        self.assertEqual([vector.output_format for vector in generator.VECTORS], list(PIXEL_FORMATS))
        for vector in generator.VECTORS:
            with self.subTest(file_name=vector.file_name):
                self.assertEqual(vector.pixel_format, PIXEL_FORMATS[vector.output_format])

    def test_decodes_the_9_7_vectors_on_FFmpeg_s_integer_path_and_names_their_wavelet(self) -> None:
        for vector in generator.VECTORS:
            with self.subTest(file_name=vector.file_name):
                self.assertEqual(IRREVERSIBLE_NAME_MARK in vector.file_name, is_irreversible(vector))
                self.assertEqual(vector.decoder_options, generator.BITEXACT_DECODER_OPTIONS if is_irreversible(vector) else ())

    def test_covers_every_progression_order_both_containers_and_odd_sizes(self) -> None:
        self.assertEqual({get_progression_order(vector) for vector in generator.VECTORS}, PROGRESSION_ORDERS)
        self.assertEqual({vector.container for vector in generator.VECTORS}, {generator.CONTAINER_MOV, generator.CONTAINER_MJ2})
        self.assertEqual({vector.sample_kind for vector in generator.VECTORS if vector.container == generator.CONTAINER_MJ2},
                         {generator.SAMPLE_CODESTREAM_BOX, generator.SAMPLE_JP2_FILE})
        self.assertTrue(any(vector.width % 2 for vector in generator.VECTORS))
        self.assertTrue(any(vector.height % 2 for vector in generator.VECTORS))

    def test_declares_what_decoder_json_lists(self) -> None:
        declared = json.loads(PROJECT_DECLARATION_PATH.read_text(encoding="utf-8"))["vectors"]

        self.assertEqual(generator.get_decoder_declarations(), declared)

    def test_prints_the_declarations(self) -> None:
        status, output, _ = run_main(generator.main, ["--print-declarations"])

        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output), generator.get_decoder_declarations())


class EncodeArgumentTests(unittest.TestCase):
    def test_scales_an_even_source_to_an_odd_size_and_drops_varying_metadata(self) -> None:
        vector = next(vector for vector in generator.VECTORS if vector.width % 2 and vector.height % 2)
        arguments = generator.get_encode_arguments(vector, OUTPUT_PATH)
        source = generator.SOURCE_PATTERN.format(width=vector.width + 1, height=vector.height + 1, rate=generator.FRAME_RATE)

        self.assertEqual(arguments[arguments.index("-i") + 1], source)
        self.assertEqual(arguments[arguments.index("-vf") + 1], f"scale={vector.width}:{vector.height}")
        self.assertEqual(arguments[arguments.index("-frames:v") + 1], str(generator.FRAME_COUNT))
        self.assertEqual(arguments[arguments.index("-map_metadata") + 1], "-1")
        self.assertEqual(arguments[arguments.index("-fflags") + 1], "+bitexact")
        self.assertEqual(arguments[arguments.index("-flags:v") + 1], "+bitexact")
        self.assertEqual(arguments[arguments.index("-pix_fmt") + 1], vector.pixel_format)
        self.assertEqual(arguments[-4:], ["-f", generator.CONTAINER_MOV, "-y", str(OUTPUT_PATH)])
        start = arguments.index(vector.encoder_arguments[0])
        self.assertEqual(tuple(arguments[start:start + len(vector.encoder_arguments)]), vector.encoder_arguments)


class SampleTests(unittest.TestCase):
    def test_wraps_a_bare_codestream_in_a_contiguous_codestream_box(self) -> None:
        vector = next(vector for vector in generator.VECTORS if vector.sample_kind == generator.SAMPLE_CODESTREAM_BOX)

        self.assertEqual(read_boxes(generator.wrap_sample(vector, BARE_CODESTREAM)), [(b"jp2c", BARE_CODESTREAM)])
        with self.assertRaisesRegex(generator.VectorGenerationError, "no bare codestream"):
            generator.wrap_sample(vector, JP2_FILE_SAMPLE)

    def test_keeps_a_JP2_file_as_the_sample(self) -> None:
        vector = next(vector for vector in generator.VECTORS if vector.sample_kind == generator.SAMPLE_JP2_FILE)

        self.assertEqual(generator.wrap_sample(vector, JP2_FILE_SAMPLE), JP2_FILE_SAMPLE)


class MotionJPEG2000Tests(unittest.TestCase):
    def test_writes_the_signature_and_file_type_then_the_samples_then_the_movie(self) -> None:
        content = generator.mux_motion_jpeg2000(SAMPLES, MUX_WIDTH, MUX_HEIGHT, MUX_LAYOUT)
        boxes = read_boxes(content)

        self.assertTrue(content.startswith(generator.SIGNATURE_BOX))
        self.assertEqual([box_type for box_type, _ in boxes], TOP_LEVEL_BOX_TYPES)
        self.assertTrue(dict(boxes)[b"ftyp"].startswith(generator.BRAND))
        self.assertEqual(dict(boxes)[b"mdat"], b"".join(SAMPLES))

    def test_locates_every_sample_by_its_chunk_offset_and_size(self) -> None:
        content = generator.mux_motion_jpeg2000(SAMPLES, MUX_WIDTH, MUX_HEIGHT, MUX_LAYOUT)

        self.assertEqual(read_samples_of(content), list(SAMPLES))

    def test_states_the_picture_and_the_sYCC_colour_space_in_the_sample_entry(self) -> None:
        content = generator.mux_motion_jpeg2000(SAMPLES, MUX_WIDTH, MUX_HEIGHT, MUX_LAYOUT)
        description = dict(read_boxes(find_box(content, SAMPLE_TABLE_PATH)))[b"stsd"]
        [(entry_type, entry)] = read_boxes(description[FULL_BOX_PREFIX_LENGTH + ENTRY_COUNT_LENGTH:])
        children = dict(read_boxes(entry[VISUAL_SAMPLE_ENTRY_LENGTH:]))
        header = dict(read_boxes(children[b"jp2h"]))
        height, width, components, bits_less_one, compression = struct.unpack(">IIHBB", header[b"ihdr"][:12])
        method, _, _, colour_space = struct.unpack(">BBBI", header[b"colr"])

        self.assertEqual(entry_type, generator.BRAND)
        self.assertEqual((width, height), (MUX_WIDTH, MUX_HEIGHT))
        self.assertEqual((components, bits_less_one + 1, compression), (MUX_LAYOUT.components, MUX_LAYOUT.bits, generator.COMPRESSION_TYPE))
        self.assertEqual((method, colour_space), (generator.ENUMERATED_COLOUR_METHOD, generator.SYCC_COLOUR_SPACE))

    def test_remuxes_each_committed_MJ2_vector_from_its_samples_byte_for_byte(self) -> None:
        for vector in generator.VECTORS:
            if vector.container != generator.CONTAINER_MJ2:
                continue
            with self.subTest(file_name=vector.file_name):
                committed = (COMMITTED_VECTOR_DIRECTORY / vector.file_name).read_bytes()
                samples = [unwrap_sample(vector, sample) for sample in read_samples_of(committed)]
                layout = generator.PIXEL_LAYOUTS[vector.pixel_format]

                self.assertEqual(len(samples), generator.FRAME_COUNT)
                self.assertEqual(generator.mux_motion_jpeg2000([generator.wrap_sample(vector, sample) for sample in samples],
                                                               vector.width, vector.height, layout), committed)


class GenerationTests(unittest.TestCase):
    def run_generator(self, directory: Path, tools: FakeTools, command_arguments: Sequence[str]) -> tuple[int, str, str]:
        ffmpeg_path = directory / "ffmpeg"
        ffprobe_path = directory / "ffprobe"
        ffmpeg_path.write_bytes(b"")
        ffprobe_path.write_bytes(b"")
        vector_directory = directory / "vectors"
        with patch.object(generator, "VECTOR_DIRECTORY", vector_directory), \
                patch.object(generator.subprocess, "run", side_effect=tools.run), \
                patch.object(generator, "read_samples", side_effect=tools.read_samples):
            return run_main(generator.main, ["--ffmpeg", str(ffmpeg_path), "--ffprobe", str(ffprobe_path), *command_arguments])

    def test_installs_missing_vectors_as_the_committed_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            status, output, error = self.run_generator(directory, FakeTools(), [])

            self.assertEqual((status, error), (0, ""))
            self.assertIn(f"Generated {len(generator.VECTORS) + 1} JPEG 2000 decoder media", output)
            for file_name in [*(vector.file_name for vector in generator.VECTORS), generator.DIGITAL_CINEMA_FILE_NAME]:
                self.assertEqual((directory / "vectors" / file_name).read_bytes(), (COMMITTED_VECTOR_DIRECTORY / file_name).read_bytes())

    def test_check_passes_on_identical_vectors(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            (directory / "vectors").mkdir()
            for file_name in [*(vector.file_name for vector in generator.VECTORS), generator.DIGITAL_CINEMA_FILE_NAME]:
                (directory / "vectors" / file_name).write_bytes((COMMITTED_VECTOR_DIRECTORY / file_name).read_bytes())
            status, output, _ = self.run_generator(directory, FakeTools(), ["--check"])

            self.assertEqual(status, 0)
            self.assertIn(f"Verified {len(generator.VECTORS) + 1} JPEG 2000 decoder media", output)

    def test_check_fails_on_a_changed_vector_and_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            (directory / "vectors").mkdir()
            changed_path = directory / "vectors" / generator.VECTORS[0].file_name
            changed_path.write_bytes(OTHER_BYTES)
            status, _, error = self.run_generator(directory, FakeTools(), ["--check"])

            self.assertEqual(status, 1)
            self.assertIn("differs from the committed bytes", error)
            self.assertEqual(changed_path.read_bytes(), OTHER_BYTES)

    def test_never_replaces_an_existing_vector(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            (directory / "vectors").mkdir()
            existing_path = directory / "vectors" / generator.VECTORS[0].file_name
            existing_path.write_bytes(OTHER_BYTES)
            status, _, error = self.run_generator(directory, FakeTools(), [])

            self.assertEqual(status, 1)
            self.assertIn("differs from the committed bytes", error)
            self.assertEqual(existing_path.read_bytes(), OTHER_BYTES)

    def test_reports_a_failed_encode_with_FFmpeg_s_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            status, _, error = self.run_generator(directory, FakeTools(exit_status=1), [])

            self.assertEqual(status, 1)
            self.assertIn(f"FFmpeg failed on {generator.VECTORS[0].file_name}", error)
            self.assertIn(FAILED_ENCODE_MESSAGE.decode("ascii"), error)
            self.assertFalse((directory / "vectors").exists())

    def test_refuses_a_missing_explicit_tool(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            missing_path = Path(temporary_directory) / "ffmpeg"
            status, _, error = run_main(generator.main, ["--ffmpeg", str(missing_path)])

            self.assertEqual(status, 1)
            self.assertIn("ffmpeg was not found", error)

    def test_names_the_flag_when_a_tool_is_not_on_PATH(self) -> None:
        with patch.object(generator.shutil, "which", return_value=None):
            with self.assertRaisesRegex(FileNotFoundError, "pass --ffprobe"):
                generator.resolve_tool_path("ffprobe", None)


if __name__ == "__main__":
    unittest.main()
