"""Tests the WMA decoder project vector generator's vector table, FATE downloads, decoded frame counts, known answers, and generation without running FFmpeg."""

from __future__ import annotations

import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Sequence
from unittest.mock import patch


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import generate_wma_decoder_vectors as generator  # noqa: E402
from media_tools import MediaTools, VectorGenerationError  # noqa: E402
from vector_test_support import run_main  # noqa: E402


# Saved before any test replaces generator.VECTOR_DIRECTORY
COMMITTED_VECTOR_DIRECTORY = generator.VECTOR_DIRECTORY
TOOLS = MediaTools("ffmpeg", "ffprobe")
CODECS = {"wmav1", "wmav2", "wmapro", "wmalossless", "wmavoice"}
SAMPLE_BYTES = b"FATE sample bytes"
OTHER_BYTES = b"other bytes"
STEREO_VECTOR = generator.Vector("tone.avi", "wmav2", 44_100, 2, 2)
SIX_CHANNEL_VECTOR = generator.Vector("six.mkv", "wmapro", 48_000, 6, 2)


def create_probe(frame_samples: Sequence[int], layout: str | None = "stereo", channels: int = 2) -> str:
    """Returns FFprobe's JSON of decoded frames of the given sample counts."""

    frames: list[dict[str, Any]] = []
    for samples in frame_samples:
        frame: dict[str, Any] = {"nb_samples": samples, "channels": channels}
        if layout is not None:
            frame["channel_layout"] = layout
        frames.append(frame)
    return json.dumps({"frames": frames})


class FakeResponse(io.BytesIO):
    """A urlopen response that is its own context manager."""

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class VectorTableTests(unittest.TestCase):
    def test_covers_every_codec_with_a_vector(self) -> None:
        self.assertEqual({vector.codec for vector in generator.VECTORS}, CODECS)

    def test_muxes_each_remux_after_its_source_into_Matroska_or_beside_video(self) -> None:
        file_names = [vector.file_name for vector in generator.VECTORS]
        for vector in generator.VECTORS:
            if vector.remux_of is not None:
                with self.subTest(file_name=vector.file_name):
                    self.assertLess(file_names.index(vector.remux_of), file_names.index(vector.file_name))
                    self.assertTrue(vector.with_video or vector.file_name.endswith(".mkv"))

    def test_copies_the_WMA_2_packets_beside_H_264_in_AVI_and_Matroska(self) -> None:
        video_vectors = [vector for vector in generator.VECTORS if vector.with_video]
        arguments = generator.get_media_arguments(video_vectors[0], Path("out"))

        self.assertEqual([vector.file_name for vector in video_vectors], ["wmav2-h264.avi", "wmav2-h264.mkv"])
        self.assertEqual({vector.remux_of for vector in video_vectors}, {"wmav2.avi"})
        self.assertEqual(arguments[:10], ["-f", "lavfi", "-i", generator.VIDEO_SOURCE, "-i", str(Path("out") / "wmav2.avi"), "-map", "0:v", "-map", "1:a"])
        for flag in (*generator.VIDEO_ARGUMENTS, "-c:a", "copy"):
            self.assertIn(flag, arguments)

    def test_pins_each_FATE_sample_by_its_SHA_256(self) -> None:
        samples = [vector.fate_sample for vector in generator.VECTORS if vector.fate_sample is not None]

        self.assertEqual({vector.codec for vector in generator.VECTORS if vector.fate_sample is not None}, {"wmapro", "wmalossless", "wmavoice"})
        for sample in samples:
            with self.subTest(path=sample.path):
                self.assertRegex(sample.sha256, r"^[0-9a-f]{64}$")

    def test_encodes_without_varying_metadata_and_remuxes_with_copied_packets(self) -> None:
        directory = Path("out")
        encode, remux = generator.VECTORS[0], generator.VECTORS[1]

        encode_arguments = generator.get_media_arguments(encode, directory)
        remux_arguments = generator.get_media_arguments(remux, directory)

        self.assertIn("lavfi", encode_arguments)
        for flag in generator.BITEXACT_ARGUMENTS:
            self.assertIn(flag, encode_arguments)
        self.assertEqual(encode_arguments[-3:], ["-f", "avi", str(directory / encode.file_name)])
        self.assertEqual(remux_arguments[:6], ["-i", str(directory / encode.file_name), "-map", "0:a", "-c", "copy"])
        self.assertEqual(remux_arguments[-3:], ["-f", "matroska", str(directory / remux.file_name)])

    def test_keeps_a_FATE_sample_s_first_packets(self) -> None:
        vector = next(vector for vector in generator.VECTORS if vector.fate_sample is not None)
        with patch.object(generator, "download_FATE_sample", return_value=Path("sample.wma")):
            arguments = generator.get_media_arguments(vector, Path("out"))

        self.assertEqual(arguments[:8], ["-i", "sample.wma", "-map", "0:a", "-c", "copy", "-frames:a", str(vector.packet_count)])


class DownloadTests(unittest.TestCase):
    def test_writes_a_sample_whose_SHA_256_matches(self) -> None:
        sample = generator.FATESample("folder/sample.wma", hashlib.sha256(SAMPLE_BYTES).hexdigest())
        with tempfile.TemporaryDirectory() as temporary_directory, \
                patch.object(generator.urllib.request, "urlopen", return_value=FakeResponse(SAMPLE_BYTES)) as urlopen:
            path = generator.download_FATE_sample(sample, Path(temporary_directory))

            self.assertEqual(path.read_bytes(), SAMPLE_BYTES)
            self.assertEqual(urlopen.call_args.args[0], generator.FATE_SUITE_URL + sample.path)

    def test_refuses_a_sample_of_another_SHA_256(self) -> None:
        sample = generator.FATESample("folder/sample.wma", hashlib.sha256(OTHER_BYTES).hexdigest())
        with tempfile.TemporaryDirectory() as temporary_directory, \
                patch.object(generator.urllib.request, "urlopen", return_value=FakeResponse(SAMPLE_BYTES)):
            with self.assertRaisesRegex(VectorGenerationError, "has SHA-256"):
                generator.download_FATE_sample(sample, Path(temporary_directory))
            self.assertFalse((Path(temporary_directory) / "sample.wma").exists())


class DecodedFrameTests(unittest.TestCase):
    def read(self, vector: generator.Vector, probe: str) -> tuple[int, str]:
        with patch.object(generator, "execute_tool", return_value=probe):
            return generator.read_decoded_frames(TOOLS, vector, Path(vector.file_name))

    def test_counts_every_decoded_frame_and_names_their_layout(self) -> None:
        self.assertEqual(self.read(STEREO_VECTOR, create_probe([2048, 2048, 1024])), (5120, "stereo"))
        self.assertEqual(self.read(STEREO_VECTOR, create_probe([2048], layout=None)), (2048, ""))

    def test_refuses_a_vector_without_frames_with_changing_layouts_or_of_other_channels(self) -> None:
        mixed = json.loads(create_probe([2048, 2048]))
        mixed["frames"][1]["channel_layout"] = "mono"

        with self.assertRaisesRegex(VectorGenerationError, "decodes 0 frames"):
            self.read(STEREO_VECTOR, create_probe([]))
        with self.assertRaisesRegex(VectorGenerationError, "in the layouts"):
            self.read(STEREO_VECTOR, json.dumps(mixed))
        with self.assertRaisesRegex(VectorGenerationError, "decoded channels"):
            self.read(STEREO_VECTOR, create_probe([2048], layout="mono", channels=1))


class ChannelMaskTests(unittest.TestCase):
    def test_reads_named_layouts_by_FFmpeg_s_names(self) -> None:
        self.assertEqual(generator.get_channel_mask(SIX_CHANNEL_VECTOR, "5.1"), 0x3F)
        self.assertEqual(generator.get_channel_mask(SIX_CHANNEL_VECTOR, "5.1(side)"), 0x60F)

    def test_takes_the_default_layout_of_a_layout_without_a_mask(self) -> None:
        for layout in ("", "unknown", "2 channels"):
            with self.subTest(layout=layout):
                self.assertEqual(generator.get_channel_mask(STEREO_VECTOR, layout), 0x3)

    def test_refuses_a_layout_it_has_no_mask_for(self) -> None:
        with self.assertRaisesRegex(VectorGenerationError, "has no mask"):
            generator.get_channel_mask(SIX_CHANNEL_VECTOR, "6 channels")


class KnownAnswerTests(unittest.TestCase):
    def create(self, PCM: bytes, frame_count: int) -> dict[str, Any]:
        def decode(_: str, arguments: Sequence[str]) -> str:
            Path(arguments[-1]).write_bytes(PCM)
            return ""

        with tempfile.TemporaryDirectory() as temporary_directory, \
                patch.object(generator, "read_decoded_frames", return_value=(frame_count, "stereo")), \
                patch.object(generator, "execute_tool", side_effect=decode) as execute_tool:
            answer = generator.create_known_answer(TOOLS, STEREO_VECTOR, Path("tone.avi"), Path(temporary_directory))
            for option in generator.REFERENCE_DECODER_OPTIONS:
                self.assertIn(option, execute_tool.call_args.args[1])
            return answer

    def test_hashes_the_whole_PCM_of_FFmpeg_s_C_decode(self) -> None:
        # Two stereo frames
        PCM = bytes(range(16))

        answer = self.create(PCM, 2)

        self.assertEqual(answer, {
            "channelCount": 2,
            "channelMask": 0x3,
            "codec": "wmav2",
            "file": "tone.avi",
            "frameCount": 2,
            "pcmSHA256": hashlib.sha256(PCM).hexdigest(),
            "sampleRate": 44_100,
        })

    def test_refuses_PCM_of_another_length_than_the_decoded_frames(self) -> None:
        for PCM in (bytes(8), bytes(24)):
            with self.subTest(byte_length=len(PCM)), self.assertRaisesRegex(VectorGenerationError, "PCM bytes mismatch"):
                self.create(PCM, 2)

    def test_names_the_FFmpeg_build_and_decoder_options(self) -> None:
        document = json.loads(generator.format_known_answers([]))

        self.assertEqual(document, {
            "decoderOptions": list(generator.REFERENCE_DECODER_OPTIONS),
            "ffmpeg": generator.REQUIRED_FFMPEG_VERSION,
            "vectors": [],
        })


class GenerationTests(unittest.TestCase):
    def run_generator(self, directory: Path, command_arguments: Sequence[str]) -> tuple[int, str, str]:
        """Runs the generator with media that are the committed vectors, checks that pass, and the committed known answers."""

        committed_answers = json.loads((COMMITTED_VECTOR_DIRECTORY / generator.KNOWN_ANSWERS_FILE_NAME).read_text(encoding="utf-8"))["vectors"]

        def write_vector(_: MediaTools, vector: generator.Vector, output_directory: Path) -> Path:
            path = output_directory / vector.file_name
            path.write_bytes((COMMITTED_VECTOR_DIRECTORY / vector.file_name).read_bytes())
            return path

        def create_known_answer(_: MediaTools, vector: generator.Vector, *__: object) -> dict[str, Any]:
            return next(answer for answer in committed_answers if answer["file"] == vector.file_name)

        ffmpeg_path = directory / "ffmpeg"
        ffprobe_path = directory / "ffprobe"
        ffmpeg_path.write_bytes(b"")
        ffprobe_path.write_bytes(b"")
        with patch.object(generator, "VECTOR_DIRECTORY", directory / "vectors"), \
                patch.object(generator, "check_toolchain"), \
                patch.object(generator, "write_vector", side_effect=write_vector), \
                patch.object(generator, "verify_vector"), \
                patch.object(generator, "create_known_answer", side_effect=create_known_answer):
            return run_main(generator.main, ["--ffmpeg", str(ffmpeg_path), "--ffprobe", str(ffprobe_path), *command_arguments])

    def test_installs_missing_vectors_and_writes_the_known_answers_as_committed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            status, output, error = self.run_generator(directory, [])

            self.assertEqual((status, error), (0, ""))
            self.assertIn(f"Wrote {generator.KNOWN_ANSWERS_FILE_NAME}", output)
            for file_name in [*(vector.file_name for vector in generator.VECTORS), generator.KNOWN_ANSWERS_FILE_NAME]:
                with self.subTest(file_name=file_name):
                    self.assertEqual((directory / "vectors" / file_name).read_bytes(), (COMMITTED_VECTOR_DIRECTORY / file_name).read_bytes())

    def test_check_fails_on_a_missing_vector(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            status, _, error = self.run_generator(directory, ["--check"])

            self.assertEqual(status, 1)
            self.assertIn("Committed output is missing", error)

    def test_never_replaces_a_differing_vector(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            (directory / "vectors").mkdir()
            existing_path = directory / "vectors" / generator.VECTORS[0].file_name
            existing_path.write_bytes(OTHER_BYTES)
            status, _, error = self.run_generator(directory, [])

            self.assertEqual(status, 1)
            self.assertIn("differs from the committed bytes", error)
            self.assertEqual(existing_path.read_bytes(), OTHER_BYTES)

    def test_refuses_a_missing_explicit_tool(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            status, _, error = run_main(generator.main, ["--ffmpeg", str(Path(temporary_directory) / "ffmpeg")])

            self.assertEqual(status, 1)
            self.assertIn("generate_wma_decoder_vectors:", error)


if __name__ == "__main__":
    unittest.main()
