"""Tests the Dolby Vision Profile 10 AV1 vector generator without running FFmpeg."""

from __future__ import annotations

import dataclasses
import io
import json
import random
import sys
import tempfile
import unittest
from collections import Counter
from contextlib import redirect_stderr, redirect_stdout
from fractions import Fraction
from pathlib import Path
from typing import Any, Sequence
from unittest.mock import patch


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import generate_dolby_vision_AV1_vectors as generator  # noqa: E402
from vector_test_support import box  # noqa: E402


# Saved before any test replaces generator.VECTOR_DIRECTORY
COMMITTED_VECTOR_DIRECTORY = generator.VECTOR_DIRECTORY
# ITU_T35_DOVI_RPU_PAYLOAD_HEADER in the pinned dolby_vision crate's av1 module: the provider codes and the fixed EMDF header bits that precede every RPU payload size
CRATE_ITUT_T35_PAYLOAD_HEADER = bytes((0x00, 0x3B, 0x00, 0x00, 0x08, 0x00, 0x37, 0xCD, 0x08))
# The 27 fixed EMDF header bits FFmpeg's dovi_rpudec.c and dovi_rpuenc.c read and write after the provider codes
FFMPEG_EMDF_HEADER_MAGIC = 0x01BE_6841
FFMPEG_EMDF_HEADER_BIT_COUNT = 27
# The 17 bits FFmpeg writes after the payload: emdf_payload_id 0 and emdf_protection()
FFMPEG_EMDF_FOOTER = 0x400
FFMPEG_EMDF_FOOTER_BIT_COUNT = 17
# FFmpeg 2026-03-01 rebuilt profile8.bin into this RPU when libaom-av1 encoded it with -dolbyvision 1.
# It wrote this payload after the T.35 country code of its metadata OBU, the OBU's trailing bits excluded
FFMPEG_REBUILT_PROFILE_8_RPU = bytes.fromhex(
    "19080908406136506f003ff801ffc00fffd000000800000680000040000034000002000001a2566000035ea2566f9fceb1c25664"
    "4ca00000100000008000000080000001c36224301860a5e308e0514000001a63e5affff000000000000000060207dce01518120"
    "c1f40006400000000601002d3733301805043001001000b6d0a82000404000000100a00000000000000a240ac2c80"
)
FFMPEG_ITUT_T35_PAYLOAD = bytes.fromhex(
    "003b0000080037cd0832a080908406136506f003ff801ffc00fffd000000800000680000040000034000002000001a256600003"
    "5ea2566f9fceb1c256644ca00000100000008000000080000001c36224301860a5e308e0514000001a63e5affff000000000000"
    "000060207dce01518120c1f40006400000000601002d3733301805043001001000b6d0a82000404000000100a00000000000000"
    "a240ac2c8002007"
)
SOURCE_RPU_FILE_NAMES = ("profile5.bin", "profile5-02.bin", "profile8.bin", "profile84.bin")
TEMPORAL_DELIMITER = bytes((0x12, 0x00))
# seq_profile 0, still_picture 0, reduced_still_picture_header 0, then arbitrary bits
SEQUENCE_HEADER_PAYLOAD = bytes((0x00, 0x00, 0x00, 0x2A))
# The first uncompressed_header() byte: show_existing_frame, frame_type (2 bits), show_frame
SHOWN_KEY_FRAME_HEADER = 0x10
SHOWN_INTER_FRAME_HEADER = 0x30
HIDDEN_INTER_FRAME_HEADER = 0x20
SHOW_EXISTING_FRAME_HEADER = 0x80
MINIMAL_RPU = bytes((0x19, 0x08, 0x09, 0x80))
PQ_CONFIGURATION_RECORD = bytes.fromhex("0100140d10") + bytes(19)


def create_OBU(OBU_type: int, payload: bytes, *, extension: bool = False) -> bytes:
    """Creates one OBU with a size field, and an extension byte when requested."""

    header = (OBU_type << 3) | 0x02 | (0x04 if extension else 0)
    extension_bytes = b"\x00" if extension else b""
    return bytes((header,)) + extension_bytes + generator.encode_leb128(len(payload)) + payload


def create_frame(first_header_byte: int, OBU_type: int = generator.OBUType.FRAME) -> bytes:
    """Creates a frame or frame header OBU whose header starts with the given byte."""

    return create_OBU(OBU_type, bytes((first_header_byte, 0x5A, 0xA5)))


SEQUENCE_HEADER = create_OBU(generator.OBUType.SEQUENCE_HEADER, SEQUENCE_HEADER_PAYLOAD)
KEY_FRAME = create_frame(SHOWN_KEY_FRAME_HEADER)
INTER_FRAME = create_frame(SHOWN_INTER_FRAME_HEADER)


def create_colr_box(color: generator.BaseLayerColor) -> bytes:
    """Creates an nclx colr box."""

    return box(
        "colr",
        b"nclx"
        + color.primaries.to_bytes(2, "big")
        + color.transfer_characteristics.to_bytes(2, "big")
        + color.matrix_coefficients.to_bytes(2, "big")
        + bytes((0x80 if color.full_range else 0x00,)),
    )


def create_track(handler_type: str, sample_entry: bytes) -> bytes:
    """Creates a track whose one sample entry is given."""

    sample_description = box("stsd", bytes(4) + (1).to_bytes(4, "big") + sample_entry)
    handler = box("hdlr", bytes(8) + handler_type.encode("ascii") + bytes(12))
    media_information = box("minf", box("stbl", sample_description))
    return box("trak", box("tkhd", bytes(84)) + box("mdia", box("mdhd", bytes(24)) + handler + media_information))


def create_AV1_sample_entry(children: bytes, sample_entry_type: str = "av01") -> bytes:
    """Creates a visual sample entry with the given child boxes."""

    return box(sample_entry_type, bytes(generator.VISUAL_SAMPLE_ENTRY_FIELD_BYTE_LENGTH) + children)


def create_MP4(tracks: Sequence[bytes], *, media_data_first: bool = True) -> bytes:
    """Creates an MP4 holding the tracks, with its media data before or after the movie box."""

    movie = box("moov", box("mvhd", bytes(100)) + b"".join(tracks))
    media_data = box("mdat", b"\x01\x02\x03\x04")
    file_type = box("ftyp", b"isom\x00\x00\x02\x00isom")
    if media_data_first:
        return file_type + media_data + movie
    return file_type + movie + media_data


AV1_CONFIGURATION_BOX = box("av1C", bytes((0x81, 0x00, 0x0C, 0x00)))
AUDIO_TRACK = create_track("soun", box("mp4a", bytes(28)))


def create_video_MP4(children: bytes = AV1_CONFIGURATION_BOX + create_colr_box(generator.BT2020_PQ_COLOR)) -> bytes:
    """Creates an MP4 with one AV1 video track and one audio track."""

    return create_MP4((create_track("vide", create_AV1_sample_entry(children)), AUDIO_TRACK))


def get_box_sizes(data: bytes) -> dict[str, int]:
    """Returns the size of each container box on the path to the AV1 sample entry, and of the sample entry."""

    sample_entry = generator.find_AV1_sample_entry(data)
    return {
        containing_box.box_type: containing_box.end_offset - containing_box.start_offset
        for containing_box in (*sample_entry.ancestors, sample_entry.sample_entry)
    }


def wrap_RPU_as_FFmpeg(RPU: bytes) -> bytes:
    """Transcribes the T.35 writing of FFmpeg's ff_dovi_rpu_generate, after the country code, as a reference."""

    payload = RPU[1:]
    bits = f"{0x003B:016b}{0x800:032b}{FFMPEG_EMDF_HEADER_MAGIC:0{FFMPEG_EMDF_HEADER_BIT_COUNT}b}"
    if len(payload) > 0xFF:
        bits += f"{(len(payload) >> 8) - 1:08b}1{len(payload) & 0xFF:08b}0"
    else:
        bits += f"{len(payload):08b}0"
    bits += "".join(f"{byte_value:08b}" for byte_value in payload)
    bits += f"{FFMPEG_EMDF_FOOTER:0{FFMPEG_EMDF_FOOTER_BIT_COUNT}b}"
    bits += "1" * (-len(bits) % 8)
    return int(bits, 2).to_bytes(len(bits) // 8, "big")


def read_committed_vector(file_name: str) -> bytes:
    """Returns the committed bytes of one vector."""

    return (COMMITTED_VECTOR_DIRECTORY / file_name).read_bytes()


def create_container_probe(
    build: generator.DolbyVisionAV1Build,
    container_format: str,
    injected_stream: generator.InjectedStream,
) -> dict[str, Any]:
    """Returns the FFprobe output of a container that matches the build."""

    color = build.sub_profile.color
    sample_entry_type = generator.get_MP4_sample_entry_type(build.sub_profile)
    stream: dict[str, Any] = {
        "codec_tag_string": generator.FFPROBE_EMPTY_CODEC_TAG,
        "codec_type": "video",
        "height": build.encode_settings.height,
        "index": 0,
        "width": build.encode_settings.width,
    }
    if container_format == generator.MP4_FORMAT:
        stream["codec_tag_string"] = sample_entry_type
    if sample_entry_type == generator.AV1_SAMPLE_ENTRY_TYPE or container_format == generator.MATROSKA_FORMAT:
        stream["codec_name"] = "av1"
    if container_format == generator.MATROSKA_FORMAT or color.has_color_description:
        stream.update(
            {
                field_name: value
                for field_name, value in generator.get_FFmpeg_color_names(color).items()
                if value != "unknown"
            }
        )
    stream["side_data_list"] = [
        {
            "side_data_type": "DOVI configuration record",
            "dv_version_major": 1,
            "dv_version_minor": 0,
            "dv_profile": 10,
            "dv_level": 1,
            "rpu_present_flag": 1,
            "el_present_flag": 0,
            "bl_present_flag": 1,
            "dv_bl_signal_compatibility_id": build.sub_profile.base_layer_signal_compatibility_ID,
            "dv_md_compression": "none",
        }
    ]
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


def create_vector_build(sub_profile: generator.SubProfile) -> generator.DolbyVisionAV1Build:
    """Returns the build of one vector, with paths no test opens."""

    return generator.DolbyVisionAV1Build(
        audio_tone=None,
        encode_settings=generator.VECTOR_ENCODE_SETTINGS,
        Matroska_path=Path("vector.mkv"),
        MP4_path=Path("vector.mp4"),
        source_RPUs=tuple(generator.read_source_RPU(file_name) for file_name in sub_profile.source_RPU_file_names),
        sub_profile=sub_profile,
    )


class BitFieldTests(unittest.TestCase):
    """Covers variable_bits() coding and bit reading."""

    def test_codes_the_EMDF_payload_ID_extension_as_the_crate_and_FFmpeg_do(self) -> None:
        # 225 = ((6 + 1) << 5) + 1: chunk 6 with read_more, then chunk 1
        self.assertEqual(generator.encode_variable_bits(225, 5), [(6, 5), (1, 1), (1, 5), (0, 1)])

    def test_codes_every_RPU_size_as_FFmpeg_does(self) -> None:
        # FFmpeg writes sizes above 0xFF as (size >> 8) - 1 with read_more, then the low byte
        for size in range(0x1_0001):
            if size > 0xFF:
                expected_fields = [((size >> 8) - 1, 8), (1, 1), (size & 0xFF, 8), (0, 1)]
            else:
                expected_fields = [(size, 8), (0, 1)]
            self.assertEqual(generator.encode_variable_bits(size, 8), expected_fields, size)

    def test_reads_back_what_it_codes(self) -> None:
        random_generator = random.Random(0xD0B1)
        for chunk_bit_count in (2, 5, 8):
            for value in [0, 1, 255, 256, 257, 65_536, *random_generator.sample(range(1 << 24), 200)]:
                fields = [(0b1, 1), *generator.encode_variable_bits(value, chunk_bit_count)]
                reader = generator.BitReader(generator.pack_bit_fields(fields, padding_bit=1))
                with self.subTest(chunk_bit_count=chunk_bit_count, value=value):
                    self.assertEqual(reader.read(1), 1)
                    self.assertEqual(reader.read_variable_bits(chunk_bit_count), value)

    def test_rejects_a_negative_variable_bits_value(self) -> None:
        with self.assertRaises(ValueError):
            generator.encode_variable_bits(-1, 8)

    def test_reader_rejects_a_field_past_the_end(self) -> None:
        reader = generator.BitReader(b"\xFF")
        self.assertEqual(reader.read(7), 0x7F)
        with self.assertRaisesRegex(generator.VectorGenerationError, "runs past the end"):
            reader.read(2)


class SourceRPUTests(unittest.TestCase):
    """Covers reading the dovi_tool payloads into the unescaped RPUs the HEVC parse reads."""

    def test_unescapes_as_the_crate_does(self) -> None:
        cases = (
            (bytes((0, 0, 3, 1)), bytes((0, 0, 1))),
            (bytes((0, 0, 3, 3)), bytes((0, 0, 3))),
            (bytes((0, 0, 3, 0, 0, 3)), bytes((0, 0, 0, 0))),
            (bytes((0, 3, 0, 0)), bytes((0, 3, 0, 0))),
            (b"", b""),
        )
        for escaped_data, data in cases:
            with self.subTest(escaped_data=escaped_data.hex()):
                self.assertEqual(generator.remove_emulation_prevention_bytes(escaped_data), data)

    def test_reads_every_source_RPU_from_prefix_to_terminator(self) -> None:
        for file_name in SOURCE_RPU_FILE_NAMES:
            source_RPU = generator.read_source_RPU(file_name)
            file_data = (generator.RPU_SOURCE_DIRECTORY / file_name).read_bytes()
            with self.subTest(file_name=file_name):
                self.assertEqual(source_RPU.escaped_RPU, file_data[4:])
                self.assertEqual(source_RPU.RPU[0], 0x19)
                self.assertEqual(source_RPU.RPU[-1], 0x80)
                # Each payload is escaped, so the RPU is shorter than the bytes stored
                self.assertLess(len(source_RPU.RPU), len(source_RPU.escaped_RPU))

    def test_uses_only_single_layer_profile_5_and_8_payloads(self) -> None:
        # RPU[3], the third byte after the 0x19 prefix, holds vdr_rpu_profile 0 (Profile 5) or 1 (Profile 8)
        RPU_profiles = {"profile5.bin": 0, "profile5-02.bin": 0, "profile8.bin": 1, "profile84.bin": 1}
        for sub_profile in generator.SUB_PROFILES:
            for file_name in sub_profile.source_RPU_file_names:
                with self.subTest(sub_profile=sub_profile.name, file_name=file_name):
                    RPU = generator.read_source_RPU(file_name).RPU
                    self.assertEqual((RPU[3] >> 3) & 0x0F, RPU_profiles[file_name])
                    self.assertEqual(
                        RPU_profiles[file_name] == 0,
                        sub_profile.base_layer_signal_compatibility_ID == 0,
                    )

    def test_rejects_a_file_without_a_start_code(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            (directory / "headerless.bin").write_bytes(MINIMAL_RPU)
            (directory / "unterminated.bin").write_bytes(b"\x00\x00\x00\x01\x19\x08\x09")
            with patch.object(generator, "RPU_SOURCE_DIRECTORY", directory):
                with self.assertRaisesRegex(generator.VectorGenerationError, "does not start with a start code"):
                    generator.read_source_RPU("headerless.bin")
                with self.assertRaisesRegex(generator.VectorGenerationError, "prefixed and terminated"):
                    generator.read_source_RPU("unterminated.bin")


class ITUTT35PayloadTests(unittest.TestCase):
    """Covers the EMDF container against the crate's header, FFmpeg's writer, and FFmpeg's own output."""

    def test_wraps_an_RPU_into_the_bytes_FFmpeg_wrote(self) -> None:
        self.assertEqual(
            generator.create_dolby_vision_ITUT_T35_payload(FFMPEG_REBUILT_PROFILE_8_RPU),
            FFMPEG_ITUT_T35_PAYLOAD,
        )

    def test_matches_a_transcription_of_FFmpeg_for_one_and_two_size_chunks(self) -> None:
        random_generator = random.Random(0x0B5)
        for payload_byte_length in (5, 6, 254, 255, 256, 257, 385, 511, 512, 600):
            RPU = bytes((0x19, *random_generator.randbytes(payload_byte_length - 1), 0x80))
            with self.subTest(payload_byte_length=payload_byte_length):
                self.assertEqual(generator.create_dolby_vision_ITUT_T35_payload(RPU), wrap_RPU_as_FFmpeg(RPU))

    def test_starts_every_source_payload_with_the_crate_header(self) -> None:
        for file_name in SOURCE_RPU_FILE_NAMES:
            payload = generator.create_dolby_vision_ITUT_T35_payload(generator.read_source_RPU(file_name).RPU)
            with self.subTest(file_name=file_name):
                self.assertEqual(payload[: len(CRATE_ITUT_T35_PAYLOAD_HEADER)], CRATE_ITUT_T35_PAYLOAD_HEADER)
                reader = generator.BitReader(payload)
                reader.read(48)
                self.assertEqual(reader.read(FFMPEG_EMDF_HEADER_BIT_COUNT), FFMPEG_EMDF_HEADER_MAGIC)

    def test_reads_every_source_RPU_back(self) -> None:
        for file_name in SOURCE_RPU_FILE_NAMES:
            RPU = generator.read_source_RPU(file_name).RPU
            with self.subTest(file_name=file_name):
                self.assertEqual(
                    generator.read_dolby_vision_RPU_from_ITUT_T35_payload(
                        generator.create_dolby_vision_ITUT_T35_payload(RPU)
                    ),
                    RPU,
                )

    def test_rejects_an_RPU_without_its_prefix_or_terminator(self) -> None:
        for RPU in (b"\x19", b"\x18\x80", b"\x19\x08\x00", b"\x19\x80\x00"):
            with self.subTest(RPU=RPU.hex()):
                with self.assertRaisesRegex(generator.VectorGenerationError, "0x19 prefix"):
                    generator.create_dolby_vision_ITUT_T35_payload(RPU)

    def test_reading_rejects_other_provider_codes_and_protection(self) -> None:
        payload = bytearray(generator.create_dolby_vision_ITUT_T35_payload(MINIMAL_RPU))
        HDR10_plus_payload = bytes((0x00, 0x3C)) + payload[2:]
        with self.assertRaisesRegex(generator.VectorGenerationError, "provider code mismatch"):
            generator.read_dolby_vision_RPU_from_ITUT_T35_payload(HDR10_plus_payload)
        # The last payload byte holds the end of the 8-bit primary protection, then one bits
        payload[-1] ^= 0x10
        with self.assertRaisesRegex(generator.VectorGenerationError, "EMDF primary protection mismatch"):
            generator.read_dolby_vision_RPU_from_ITUT_T35_payload(bytes(payload))


class OBUTests(unittest.TestCase):
    """Covers leb128(), OBU parsing, and the metadata OBU."""

    def test_codes_leb128_values(self) -> None:
        cases = (
            (0, "00"),
            (127, "7f"),
            (128, "8001"),
            (300, "ac02"),
            (0xFFFF_FFFF, "ffffffff0f"),
        )
        for value, coded in cases:
            with self.subTest(value=value):
                self.assertEqual(generator.encode_leb128(value).hex(), coded)
                self.assertEqual(generator.read_leb128(bytes.fromhex(coded) + b"\xEE", 0), (value, len(coded) // 2))
        for value in (-1, 0x1_0000_0000):
            with self.assertRaises(ValueError):
                generator.encode_leb128(value)

    def test_reads_non_minimal_leb128_and_rejects_bad_codings(self) -> None:
        self.assertEqual(generator.read_leb128(bytes.fromhex("8080808000"), 0), (0, 5))
        cases = (
            (bytes.fromhex("80"), "truncated"),
            (bytes.fromhex("8080808080808080"), "longer than 8 bytes"),
            (bytes.fromhex("8080808010"), "exceeds 32 bits"),
        )
        for data, message in cases:
            with self.subTest(data=data.hex()):
                with self.assertRaisesRegex(generator.VectorGenerationError, message):
                    generator.read_leb128(data, 0)

    def test_parses_OBUs_with_and_without_extensions(self) -> None:
        extended_frame = create_OBU(generator.OBUType.FRAME, b"\x10\x01", extension=True)
        OBUs = generator.parse_OBUs(TEMPORAL_DELIMITER + SEQUENCE_HEADER + extended_frame)
        self.assertEqual([OBU.OBU_type for OBU in OBUs], [2, 1, 6])
        self.assertEqual([OBU.payload for OBU in OBUs], [b"", SEQUENCE_HEADER_PAYLOAD, b"\x10\x01"])
        self.assertEqual(OBUs[2].data, extended_frame)

    def test_rejects_malformed_OBUs(self) -> None:
        cases = (
            (b"\x92\x00", "forbidden bit"),
            (b"\x10\x00", "no size field"),
            (b"\x32\x05\x10", "runs past the end"),
        )
        for data, message in cases:
            with self.subTest(data=data.hex()):
                with self.assertRaisesRegex(generator.VectorGenerationError, message):
                    generator.parse_OBUs(data)

    def test_writes_the_metadata_OBU_libaom_writes(self) -> None:
        OBU = generator.create_dolby_vision_metadata_OBU(FFMPEG_REBUILT_PROFILE_8_RPU)
        payload = b"\x04\xB5" + FFMPEG_ITUT_T35_PAYLOAD + b"\x80"
        # Metadata OBU type 5 with a size field, the 2-byte size, metadata_type 4, country code 0xB5, the T.35 payload, trailing bits
        self.assertEqual(OBU, b"\x2A" + generator.encode_leb128(len(payload)) + payload)
        parsed_OBU = generator.parse_OBUs(OBU)[0]
        self.assertTrue(generator.is_dolby_vision_metadata_OBU(parsed_OBU))
        self.assertEqual(generator.get_ITUT_T35_payload(parsed_OBU), payload[1:])

    def test_recognizes_only_Dolby_Vision_T35_metadata(self) -> None:
        dolby_vision_payload = generator.parse_OBUs(generator.create_dolby_vision_metadata_OBU(MINIMAL_RPU))[0].payload
        cases = (
            (create_OBU(generator.OBUType.METADATA, dolby_vision_payload), True),
            # HDR10+ uses provider code 0x003C
            (create_OBU(generator.OBUType.METADATA, b"\x04\xB5\x00\x3C\x00\x01\x04\x01\x80"), False),
            # HDR content light level metadata
            (create_OBU(generator.OBUType.METADATA, b"\x01\x03\xE8\x01\x90\x80"), False),
            (create_OBU(generator.OBUType.FRAME, dolby_vision_payload), False),
            (create_OBU(generator.OBUType.METADATA, dolby_vision_payload[:7]), False),
        )
        for data, is_dolby_vision in cases:
            OBU = generator.parse_OBUs(data)[0]
            with self.subTest(data=data[:10].hex()):
                self.assertEqual(generator.is_dolby_vision_metadata_OBU(OBU), is_dolby_vision)
        with self.assertRaisesRegex(generator.VectorGenerationError, "not Dolby Vision"):
            generator.get_ITUT_T35_payload(generator.parse_OBUs(cases[1][0])[0])


class InsertionTests(unittest.TestCase):
    """Covers inserting one RPU metadata OBU per temporal unit."""

    def test_inserts_after_the_sequence_header_and_before_the_frame(self) -> None:
        stream = TEMPORAL_DELIMITER + SEQUENCE_HEADER + KEY_FRAME + TEMPORAL_DELIMITER + INTER_FRAME
        first_RPU = generator.read_source_RPU("profile5.bin").RPU
        second_RPU = generator.read_source_RPU("profile5-02.bin").RPU
        injected_stream = generator.insert_dolby_vision_metadata(stream, (first_RPU, second_RPU))
        first_OBU = generator.create_dolby_vision_metadata_OBU(first_RPU)
        second_OBU = generator.create_dolby_vision_metadata_OBU(second_RPU)
        self.assertEqual(
            injected_stream.data,
            TEMPORAL_DELIMITER + SEQUENCE_HEADER + first_OBU + KEY_FRAME
            + TEMPORAL_DELIMITER + second_OBU + INTER_FRAME,
        )
        # A sample holds its temporal unit without the temporal delimiter
        self.assertEqual(
            injected_stream.temporal_units,
            (
                generator.TemporalUnitSummary(
                    key_frame=True,
                    sample_byte_length=len(SEQUENCE_HEADER + first_OBU + KEY_FRAME),
                ),
                generator.TemporalUnitSummary(key_frame=False, sample_byte_length=len(second_OBU + INTER_FRAME)),
            ),
        )
        self.assertEqual(generator.read_dolby_vision_RPUs(injected_stream.data), [[first_RPU], [second_RPU]])

    def test_counts_one_shown_frame_beside_hidden_frames(self) -> None:
        hidden_frame = create_frame(HIDDEN_INTER_FRAME_HEADER)
        shown_existing_frame = create_frame(SHOW_EXISTING_FRAME_HEADER, generator.OBUType.FRAME_HEADER)
        padding = create_OBU(generator.OBUType.PADDING, b"\x00\x00")
        light_level = create_OBU(generator.OBUType.METADATA, b"\x01\x03\xE8\x01\x90\x80")
        stream = (
            TEMPORAL_DELIMITER + SEQUENCE_HEADER + KEY_FRAME
            + TEMPORAL_DELIMITER + light_level + hidden_frame + INTER_FRAME + padding
            + TEMPORAL_DELIMITER + shown_existing_frame
        )
        injected_stream = generator.insert_dolby_vision_metadata(stream, (MINIMAL_RPU,) * 3)
        metadata_OBU = generator.create_dolby_vision_metadata_OBU(MINIMAL_RPU)
        self.assertIn(
            TEMPORAL_DELIMITER + light_level + metadata_OBU + hidden_frame + INTER_FRAME,
            injected_stream.data,
        )
        self.assertEqual(
            injected_stream.temporal_units[1:],
            (
                # FFmpeg's muxers drop padding OBUs from the sample, as they drop temporal delimiters
                generator.TemporalUnitSummary(
                    key_frame=False,
                    sample_byte_length=len(light_level + metadata_OBU + hidden_frame + INTER_FRAME),
                ),
                generator.TemporalUnitSummary(
                    key_frame=False,
                    sample_byte_length=len(metadata_OBU + shown_existing_frame),
                ),
            ),
        )

    def test_rejects_temporal_units_that_do_not_show_one_frame(self) -> None:
        hidden_frame = create_frame(HIDDEN_INTER_FRAME_HEADER)
        cases = (
            (TEMPORAL_DELIMITER + SEQUENCE_HEADER + KEY_FRAME + INTER_FRAME, "shows 2 frames"),
            (TEMPORAL_DELIMITER + SEQUENCE_HEADER + hidden_frame, "shows 0 frames"),
            (TEMPORAL_DELIMITER + SEQUENCE_HEADER, "shows 0 frames"),
        )
        for stream, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(generator.VectorGenerationError, message):
                    generator.insert_dolby_vision_metadata(stream, (MINIMAL_RPU,))

    def test_rejects_streams_it_cannot_carry_RPUs_in(self) -> None:
        existing_metadata = generator.create_dolby_vision_metadata_OBU(MINIMAL_RPU)
        reduced_header = create_OBU(generator.OBUType.SEQUENCE_HEADER, b"\x08\x00")
        high_profile_header = create_OBU(generator.OBUType.SEQUENCE_HEADER, b"\x20\x00")
        cases = (
            (TEMPORAL_DELIMITER + SEQUENCE_HEADER + existing_metadata + KEY_FRAME, 1, "already carries"),
            (TEMPORAL_DELIMITER + KEY_FRAME, 1, "precedes the first sequence header"),
            (TEMPORAL_DELIMITER + reduced_header + KEY_FRAME, 1, "reduced still picture headers"),
            (TEMPORAL_DELIMITER + high_profile_header + KEY_FRAME, 1, "Main profile"),
            (TEMPORAL_DELIMITER + SEQUENCE_HEADER + KEY_FRAME, 2, "1 temporal units for 2 RPUs"),
            (SEQUENCE_HEADER + KEY_FRAME, 1, "does not start with a temporal delimiter"),
        )
        for stream, RPU_count, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(generator.VectorGenerationError, message):
                    generator.insert_dolby_vision_metadata(stream, (MINIMAL_RPU,) * RPU_count)


class ConfigurationTests(unittest.TestCase):
    """Covers the Dolby Vision level and configuration record."""

    def test_picks_the_level_FFmpeg_picks(self) -> None:
        cases = (
            (192, 192, Fraction(24), 1),
            (1280, 720, Fraction(30), 2),
            (1920, 1080, Fraction(24_000, 1_001), 3),
            (1920, 1080, Fraction(24), 3),
            (1920, 1080, Fraction(25), 4),
            # Within the pixel rate of level 3, but wider than it allows
            (2560, 720, Fraction(24), 4),
            (2560, 1440, Fraction(24), 5),
            (3840, 2160, Fraction(24), 6),
            (7680, 4320, Fraction(120), 13),
        )
        for width, height, frame_rate, level in cases:
            with self.subTest(width=width, height=height, frame_rate=frame_rate):
                self.assertEqual(generator.get_dolby_vision_level(width, height, frame_rate), level)
        with self.assertRaisesRegex(generator.VectorGenerationError, "exceeds every Dolby Vision level"):
            generator.get_dolby_vision_level(7680, 4320, Fraction(240))

    def test_writes_the_record_FFmpeg_writes(self) -> None:
        # The record FFmpeg wrote into the Matroska BlockAdditionMapping of the 10.1 vector
        self.assertEqual(
            generator.create_dolby_vision_configuration_record(
                generator.DolbyVisionConfiguration(base_layer_signal_compatibility_ID=1, level=1, profile=10)
            ),
            PQ_CONFIGURATION_RECORD,
        )
        record = generator.create_dolby_vision_configuration_record(
            generator.DolbyVisionConfiguration(base_layer_signal_compatibility_ID=4, level=3, profile=10)
        )
        self.assertEqual(record, bytes.fromhex("0100141d40") + bytes(19))
        self.assertEqual(len(record), generator.DOLBY_VISION_CONFIGURATION_RECORD_BYTE_LENGTH)

    def test_uses_dav1_only_for_10_0(self) -> None:
        self.assertEqual(
            {
                sub_profile.name: generator.get_MP4_sample_entry_type(sub_profile)
                for sub_profile in generator.SUB_PROFILES
            },
            {"10.0": "dav1", "10.1": "av01", "10.2": "av01", "10.4": "av01"},
        )


class MP4Tests(unittest.TestCase):
    """Covers adding the dvvC box, renaming the sample entry, and reading the signaling back."""

    def test_appends_dvvC_and_grows_every_containing_box(self) -> None:
        data = create_video_MP4()
        patched_data = generator.insert_dolby_vision_configuration_box(data, PQ_CONFIGURATION_RECORD)
        self.assertEqual(len(patched_data), len(data) + 32)
        self.assertEqual(
            get_box_sizes(patched_data),
            {box_type: size + 32 for box_type, size in get_box_sizes(data).items()},
        )
        # The media data before the movie box is untouched
        media_data_offset = data.index(b"mdat") - 4
        self.assertEqual(patched_data[: media_data_offset + 12], data[: media_data_offset + 12])
        signaling = generator.read_MP4_video_signaling(patched_data)
        self.assertEqual(
            signaling,
            generator.MP4VideoSignaling(
                color=generator.BT2020_PQ_COLOR,
                dolby_vision_configuration_record=PQ_CONFIGURATION_RECORD,
                sample_entry_type="av01",
            ),
        )

    def test_renames_the_sample_entry_in_place(self) -> None:
        data = generator.insert_dolby_vision_configuration_box(
            create_video_MP4(AV1_CONFIGURATION_BOX),
            PQ_CONFIGURATION_RECORD,
        )
        renamed_data = generator.rename_AV1_sample_entry(data, "dav1")
        self.assertEqual(len(renamed_data), len(data))
        signaling = generator.read_MP4_video_signaling(renamed_data)
        self.assertEqual(signaling.sample_entry_type, "dav1")
        self.assertIsNone(signaling.color)
        with self.assertRaisesRegex(generator.VectorGenerationError, "not an AV1 sample entry type"):
            generator.rename_AV1_sample_entry(data, "hvc1")

    def test_rejects_MP4s_it_cannot_patch(self) -> None:
        configured_data = generator.insert_dolby_vision_configuration_box(create_video_MP4(), PQ_CONFIGURATION_RECORD)
        video_track = create_track("vide", create_AV1_sample_entry(AV1_CONFIGURATION_BOX))
        cases = (
            (create_MP4((video_track,), media_data_first=False), "must precede the movie box"),
            (configured_data, "already has a Dolby Vision configuration"),
            (create_MP4((AUDIO_TRACK,)), "has 0 video tracks"),
            (create_MP4((video_track, video_track)), "has 2 video tracks"),
            (create_MP4((create_track("vide", box("hvc1", bytes(78))),)), "one av01 or dav1 sample entry"),
            (create_MP4((create_track("vide", box("av01", bytes(40))),)), "sample entry is truncated"),
        )
        for data, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(generator.VectorGenerationError, message):
                    generator.insert_dolby_vision_configuration_box(data, PQ_CONFIGURATION_RECORD)

    def test_requires_compact_box_sizes(self) -> None:
        data = bytearray(create_video_MP4())
        stsd_offset = data.index(b"stsd") - 4
        stsd_size = int.from_bytes(data[stsd_offset : stsd_offset + 4], "big")
        # A 64-bit size field for stsd
        extended_stsd = (
            (1).to_bytes(4, "big") + b"stsd" + (stsd_size + 8).to_bytes(8, "big")
            + data[stsd_offset + 8 : stsd_offset + stsd_size]
        )
        data[stsd_offset : stsd_offset + stsd_size] = extended_stsd
        for box_type in ("stbl", "minf", "mdia", "trak", "moov"):
            box_offset = data.index(box_type.encode("ascii")) - 4
            box_size = int.from_bytes(data[box_offset : box_offset + 4], "big")
            data[box_offset : box_offset + 4] = (box_size + 8).to_bytes(4, "big")
        with self.assertRaisesRegex(generator.VectorGenerationError, "stsd box needs a compact size"):
            generator.insert_dolby_vision_configuration_box(bytes(data), PQ_CONFIGURATION_RECORD)

    def test_reading_rejects_other_configurations_and_colors(self) -> None:
        cases = (
            (AV1_CONFIGURATION_BOX + box("dvcC", PQ_CONFIGURATION_RECORD), "carries dvcC instead of dvvC"),
            (
                AV1_CONFIGURATION_BOX + box("dvvC", PQ_CONFIGURATION_RECORD) + box("dvwC", PQ_CONFIGURATION_RECORD),
                "more than one Dolby Vision configuration",
            ),
            (AV1_CONFIGURATION_BOX + box("colr", b"prof\x00\x00"), "not nclx"),
        )
        for children, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(generator.VectorGenerationError, message):
                    generator.read_MP4_video_signaling(create_video_MP4(children))
        with self.assertRaisesRegex(generator.VectorError, "av1C"):
            generator.read_MP4_video_signaling(create_video_MP4(b""))


class HEVCReferenceTests(unittest.TestCase):
    """Covers carrying the source RPUs as HEVC NAL unit 62, the carriage FFmpeg's parity check reads."""

    def test_splits_NAL_units_at_3_and_4_byte_start_codes(self) -> None:
        data = b"\x00\x00\x00\x01\x46\x01\x10\x00\x00\x01\x40\x01\x0C\x00\x00\x00\x01\x42\x01"
        self.assertEqual(
            generator.split_annex_B_NAL_units(data),
            [b"\x46\x01\x10", b"\x40\x01\x0C", b"\x42\x01"],
        )

    def test_ends_each_access_unit_with_its_RPU(self) -> None:
        delimiter = b"\x46\x01\x10"
        slice_unit = b"\x26\x01\xAF"
        stream = (b"\x00\x00\x00\x01" + delimiter + b"\x00\x00\x01" + slice_unit) * 2
        source_RPUs = (generator.read_source_RPU("profile8.bin"), generator.read_source_RPU("profile84.bin"))
        output = generator.append_HEVC_RPU_NAL_units(stream, source_RPUs)
        start_code = b"\x00\x00\x00\x01"
        self.assertEqual(
            output,
            b"".join(
                start_code + delimiter + start_code + slice_unit + start_code + b"\x7C\x01" + source_RPU.escaped_RPU
                for source_RPU in source_RPUs
            ),
        )

    def test_rejects_streams_without_one_delimited_access_unit_per_RPU(self) -> None:
        source_RPU = generator.read_source_RPU("profile8.bin")
        with self.assertRaisesRegex(generator.VectorGenerationError, "does not start with an access unit delimiter"):
            generator.append_HEVC_RPU_NAL_units(b"\x00\x00\x01\x26\x01\xAF", (source_RPU,))
        with self.assertRaisesRegex(generator.VectorGenerationError, "1 access units for 2 RPUs"):
            generator.append_HEVC_RPU_NAL_units(b"\x00\x00\x01\x46\x01\x10", (source_RPU, source_RPU))


class EvidenceTests(unittest.TestCase):
    """Covers the FFprobe and MP4 checks, and the messages they report."""

    def test_accepts_the_evidence_of_every_sub_profile(self) -> None:
        for sub_profile in generator.SUB_PROFILES:
            build = create_vector_build(sub_profile)
            injected_stream = generator.InjectedStream(
                data=b"",
                temporal_units=tuple(
                    generator.TemporalUnitSummary(key_frame=key_frame, sample_byte_length=100 + frame_index)
                    for frame_index, key_frame in enumerate(generator.get_vector_key_frame_flags())
                ),
            )
            configuration = generator.get_dolby_vision_configuration(sub_profile, build.encode_settings)
            for container_format in generator.CONTAINER_FORMATS:
                with self.subTest(sub_profile=sub_profile.name, container_format=container_format):
                    generator.require_container_evidence(
                        create_container_probe(build, container_format, injected_stream),
                        container_format,
                        build,
                        configuration,
                        injected_stream,
                        "vector",
                    )

    def test_reports_each_container_mismatch(self) -> None:
        build = create_vector_build(generator.SUB_PROFILES[1])
        injected_stream = generator.InjectedStream(
            data=b"",
            temporal_units=(generator.TemporalUnitSummary(key_frame=True, sample_byte_length=100),),
        )
        configuration = generator.get_dolby_vision_configuration(build.sub_profile, build.encode_settings)

        def check(probe: dict[str, Any]) -> None:
            generator.require_container_evidence(
                probe,
                generator.MATROSKA_FORMAT,
                build,
                configuration,
                injected_stream,
                "vector.mkv",
            )

        matching_probe = create_container_probe(build, generator.MATROSKA_FORMAT, injected_stream)
        check(matching_probe)
        stream = matching_probe["streams"][0]
        wrong_configuration = {**stream["side_data_list"][0], "dv_bl_signal_compatibility_id": 2}
        cases = (
            ({**matching_probe, "streams": []}, "vector.mkv has 0 video streams instead of one"),
            ({**matching_probe, "streams": [{**stream, "codec_name": "hevc"}]}, 'vector.mkv codec mismatch'),
            (
                {**matching_probe, "streams": [{**stream, "color_transfer": "arib-std-b67"}]},
                "vector.mkv color mismatch",
            ),
            (
                {**matching_probe, "streams": [{**stream, "side_data_list": [wrong_configuration]}]},
                "vector.mkv Dolby Vision configuration mismatch",
            ),
            (
                {**matching_probe, "packets": [{"flags": "___", "size": "100", "stream_index": 0}]},
                "vector.mkv packet sizes and key flags mismatch: expected \\[\\[100,true\\]\\]",
            ),
            (
                {**matching_probe, "streams": [stream, {"codec_type": "audio", "codec_name": "aac"}]},
                "vector.mkv audio stream count mismatch",
            ),
        )
        for probe, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(generator.VectorGenerationError, message):
                    check(probe)

    def test_checks_the_audio_tone_of_playback_media(self) -> None:
        tone = generator.AudioTone(bit_rate_kilobits=128, channel_count=2, frequency=440, sample_rate=48_000)
        build = dataclasses.replace(create_vector_build(generator.SUB_PROFILES[1]), audio_tone=tone)
        injected_stream = generator.InjectedStream(
            data=b"",
            temporal_units=(generator.TemporalUnitSummary(key_frame=True, sample_byte_length=100),),
        )
        configuration = generator.get_dolby_vision_configuration(build.sub_profile, build.encode_settings)
        probe = create_container_probe(build, generator.MP4_FORMAT, injected_stream)
        probe["streams"].append({"channels": 2, "codec_name": "aac", "codec_type": "audio", "sample_rate": "48000"})

        def check() -> None:
            generator.require_container_evidence(
                probe,
                generator.MP4_FORMAT,
                build,
                configuration,
                injected_stream,
                "media",
            )

        check()
        probe["streams"][1]["channels"] = 1
        with self.assertRaisesRegex(generator.VectorGenerationError, "media audio mismatch"):
            check()

    def test_requires_the_sequence_header_color(self) -> None:
        probe = {
            "streams": [
                {
                    "codec_name": "av1",
                    "codec_type": "video",
                    "color_range": "pc",
                    "height": 192,
                    "pix_fmt": "yuv420p10le",
                    "profile": "Main",
                    "width": 192,
                }
            ]
        }
        settings = generator.VECTOR_ENCODE_SETTINGS
        generator.require_OBU_stream_evidence(probe, settings, generator.UNSPECIFIED_FULL_RANGE_COLOR, "stream")
        with self.assertRaisesRegex(generator.VectorGenerationError, "stream sequence header color mismatch"):
            generator.require_OBU_stream_evidence(probe, settings, generator.BT709_COLOR, "stream")

    def test_requires_the_MP4_signaling_of_the_sub_profile(self) -> None:
        build = create_vector_build(generator.SUB_PROFILES[1])
        data = generator.insert_dolby_vision_configuration_box(create_video_MP4(), PQ_CONFIGURATION_RECORD)
        generator.require_MP4_signaling(data, build, PQ_CONFIGURATION_RECORD, "vector.mp4")
        cases = (
            (generator.rename_AV1_sample_entry(data, "dav1"), PQ_CONFIGURATION_RECORD, "sample entry mismatch"),
            (data, bytes.fromhex("0100140d20") + bytes(19), "dvvC record mismatch"),
            (
                generator.insert_dolby_vision_configuration_box(
                    create_video_MP4(AV1_CONFIGURATION_BOX + create_colr_box(generator.BT709_COLOR)),
                    PQ_CONFIGURATION_RECORD,
                ),
                PQ_CONFIGURATION_RECORD,
                "colr box mismatch",
            ),
        )
        for MP4_data, record, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(generator.VectorGenerationError, message):
                    generator.require_MP4_signaling(MP4_data, build, record, "vector.mp4")


class ToolTests(unittest.TestCase):
    """Covers the FFmpeg command lines and the pinned toolchain check."""

    def test_encodes_with_libaom_in_one_thread_without_lookahead(self) -> None:
        self.assertEqual(
            generator.create_AV1_encode_arguments(
                generator.VECTOR_ENCODE_SETTINGS,
                generator.BT2020_PQ_COLOR,
                Path("base.obu"),
            ),
            [
                "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                "-f", "lavfi",
                "-i",
                "testsrc2=size=192x192:rate=24,format=yuv420p10le,"
                "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv",
                "-frames:v", "4",
                "-c:v", "libaom-av1",
                "-usage", "realtime",
                "-cpu-used", "8",
                "-lag-in-frames", "0",
                "-threads", "1",
                "-row-mt", "0",
                "-tiles", "1x1",
                "-g", "2",
                "-crf", "50",
                "-fflags", "+bitexact",
                "-flags:v", "+bitexact",
                "-map_metadata", "-1",
                "-f", "obu",
                "base.obu",
            ],
        )

    def test_tags_10_0_as_untagged_full_range(self) -> None:
        source = generator.create_AV1_encode_arguments(
            generator.VECTOR_ENCODE_SETTINGS,
            generator.UNSPECIFIED_FULL_RANGE_COLOR,
            Path("base.obu"),
        )[8]
        self.assertTrue(source.endswith("setparams=color_primaries=unknown:color_trc=unknown:colorspace=unknown:range=pc"))

    def test_muxes_and_remuxes_with_bitexact_FFmpeg(self) -> None:
        intermediate_arguments = generator.create_intermediate_MP4_arguments(
            Path("injected.obu"),
            Fraction(24_000, 1_001),
            generator.AudioTone(bit_rate_kilobits=128, channel_count=2, frequency=440, sample_rate=48_000),
            Fraction(240_240, 24_000),
            Path("intermediate.mp4"),
        )
        self.assertEqual(
            intermediate_arguments[5:12],
            ["-framerate", "24000/1001", "-f", "obu", "-i", "injected.obu", "-f"],
        )
        self.assertIn("sine=frequency=440:sample_rate=48000:duration=10.01", intermediate_arguments)
        self.assertEqual(
            generator.create_remux_arguments(Path("configured.mp4"), "mp4", Path("vector.mp4"))[5:],
            [
                "-i", "configured.mp4",
                "-map", "0",
                "-c", "copy",
                "-strict", "unofficial",
                "-video_track_timescale", "24000",
                "-fflags", "+bitexact",
                "-map_metadata", "-1",
                "-f", "mp4",
                "vector.mp4",
            ],
        )
        self.assertNotIn(
            "-strict",
            generator.create_remux_arguments(Path("configured.mp4"), "matroska", Path("vector.mkv")),
        )


class CommittedVectorTests(unittest.TestCase):
    """Reads the committed vectors and expectations in bin/codec_vector_assets/dolby-vision-av1/."""

    def test_expectations_match_the_vector_table(self) -> None:
        source_RPUs = {file_name: generator.read_source_RPU(file_name) for file_name in SOURCE_RPU_FILE_NAMES}
        self.assertEqual(
            read_committed_vector(generator.EXPECTATIONS_FILE_NAME),
            generator.format_expectations(generator.create_expectations(source_RPUs)),
        )

    def test_records_one_vector_per_sub_profile_and_container(self) -> None:
        expectations = json.loads(read_committed_vector(generator.EXPECTATIONS_FILE_NAME))
        self.assertEqual(expectations["sourceRPUDirectory"], "src/capability/vectors/test/dolby-vision-rpu")
        self.assertEqual(
            [
                (
                    vector["fileName"],
                    vector["container"],
                    vector["sampleEntry"],
                    vector["baseLayerSignalCompatibilityID"],
                )
                for vector in expectations["vectors"]
            ],
            [
                ("profile10.0.mp4", "mp4", "dav1", 0),
                ("profile10.0.mkv", "matroska", None, 0),
                ("profile10.1.mp4", "mp4", "av01", 1),
                ("profile10.1.mkv", "matroska", None, 1),
                ("profile10.2.mp4", "mp4", "av01", 2),
                ("profile10.2.mkv", "matroska", None, 2),
                ("profile10.4.mp4", "mp4", "av01", 4),
                ("profile10.4.mkv", "matroska", None, 4),
            ],
        )
        for vector in expectations["vectors"]:
            with self.subTest(file_name=vector["fileName"]):
                self.assertEqual((vector["dolbyVisionProfile"], vector["dolbyVisionLevel"]), (10, 1))
                self.assertEqual([frame["keyFrame"] for frame in vector["frames"]], [True, False, True, False])
                self.assertEqual(len(vector["frames"]), vector["frameCount"])

    def test_every_frame_carries_its_source_RPU_byte_for_byte(self) -> None:
        for sub_profile in generator.SUB_PROFILES:
            for container_format in generator.CONTAINER_FORMATS:
                data = read_committed_vector(generator.get_vector_file_name(sub_profile, container_format))
                expected_counts: Counter[str] = Counter(sub_profile.source_RPU_file_names)
                with self.subTest(sub_profile=sub_profile.name, container_format=container_format):
                    for file_name, expected_count in expected_counts.items():
                        metadata_OBU = generator.create_dolby_vision_metadata_OBU(generator.read_source_RPU(file_name).RPU)
                        self.assertEqual(data.count(metadata_OBU), expected_count)
                    # Every Dolby Vision metadata OBU payload starts with metadata_type 4, country code 0xB5, provider code 0x003B, and provider oriented code 0x800
                    self.assertEqual(data.count(b"\x04\xB5\x00\x3B\x00\x00\x08\x00"), generator.VECTOR_FRAME_COUNT)

    def test_MP4_vectors_signal_their_sub_profile(self) -> None:
        for sub_profile in generator.SUB_PROFILES:
            configuration = generator.get_dolby_vision_configuration(sub_profile, generator.VECTOR_ENCODE_SETTINGS)
            signaling = generator.read_MP4_video_signaling(
                read_committed_vector(generator.get_vector_file_name(sub_profile, generator.MP4_FORMAT))
            )
            with self.subTest(sub_profile=sub_profile.name):
                self.assertEqual(signaling.sample_entry_type, generator.get_MP4_sample_entry_type(sub_profile))
                self.assertEqual(
                    signaling.dolby_vision_configuration_record,
                    generator.create_dolby_vision_configuration_record(configuration),
                )
                self.assertEqual(
                    signaling.color,
                    sub_profile.color if sub_profile.color.has_color_description else None,
                )

    def test_Matroska_vectors_carry_the_configuration_record(self) -> None:
        for sub_profile in generator.SUB_PROFILES:
            configuration = generator.get_dolby_vision_configuration(sub_profile, generator.VECTOR_ENCODE_SETTINGS)
            record = generator.create_dolby_vision_configuration_record(configuration)
            data = read_committed_vector(generator.get_vector_file_name(sub_profile, generator.MATROSKA_FORMAT))
            # BlockAddIDType dvvC, then BlockAddIDExtraData with a 1-byte size of 24
            with self.subTest(sub_profile=sub_profile.name):
                self.assertEqual(data.count(b"\x41\xE7\x84dvvC\x41\xED\x98" + record), 1)


class MainTests(unittest.TestCase):
    """Runs main() with each build replaced by a copy of the committed vectors."""

    def run_main(
        self,
        arguments: Sequence[str],
        vector_directory: Path,
        *,
        failing_sub_profile_name: str | None = None,
    ) -> tuple[int, str, str]:
        """Returns the exit status, standard output, and standard error of one run.

        The FFmpeg parity check fails for the named sub-profile and passes for every other.
        """

        def require_FFmpeg_metadata_parity(
            tools: generator.MediaTools,
            built_files: generator.BuiltDolbyVisionAV1Files,
            build: generator.DolbyVisionAV1Build,
            temporary_directory: Path,
        ) -> None:
            if build.sub_profile.name == failing_sub_profile_name:
                raise generator.VectorGenerationError(f"Profile {failing_sub_profile_name} parity mismatch")

        def build_dolby_vision_AV1_files(
            tools: generator.MediaTools,
            build: generator.DolbyVisionAV1Build,
            temporary_directory: Path,
        ) -> generator.BuiltDolbyVisionAV1Files:
            build.MP4_path.write_bytes(read_committed_vector(build.MP4_path.name))
            build.Matroska_path.write_bytes(read_committed_vector(build.Matroska_path.name))
            return generator.BuiltDolbyVisionAV1Files(
                injected_stream=generator.InjectedStream(
                    data=b"",
                    temporal_units=tuple(
                        generator.TemporalUnitSummary(key_frame=key_frame, sample_byte_length=0)
                        for key_frame in generator.get_vector_key_frame_flags()
                    ),
                ),
                injected_stream_path=temporary_directory / "injected.obu",
            )

        standard_output = io.StringIO()
        standard_error = io.StringIO()
        with (
            patch.object(generator, "check_toolchain"),
            patch.object(generator, "build_dolby_vision_AV1_files", side_effect=build_dolby_vision_AV1_files),
            patch.object(
                generator,
                "require_FFmpeg_metadata_parity",
                side_effect=require_FFmpeg_metadata_parity,
            ),
            patch.object(generator, "VECTOR_DIRECTORY", vector_directory),
            redirect_stdout(standard_output),
            redirect_stderr(standard_error),
        ):
            exit_status = generator.main(arguments)
        return exit_status, standard_output.getvalue(), standard_error.getvalue()

    def test_check_verifies_the_committed_vectors(self) -> None:
        exit_status, output, errors = self.run_main(["--check"], COMMITTED_VECTOR_DIRECTORY)
        self.assertEqual((exit_status, errors), (0, ""))
        self.assertTrue(output.startswith("Verified 8 Dolby Vision Profile 10 AV1 vectors and expectations.json"))

    def test_generation_writes_every_vector_and_the_expectations(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            exit_status, output, errors = self.run_main([], output_directory)
            self.assertEqual((exit_status, errors), (0, ""))
            self.assertTrue(output.startswith("Generated 8"))
            for path in COMMITTED_VECTOR_DIRECTORY.iterdir():
                with self.subTest(file_name=path.name):
                    self.assertEqual((output_directory / path.name).read_bytes(), path.read_bytes())

    def test_check_rejects_a_committed_file_that_differs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            for path in COMMITTED_VECTOR_DIRECTORY.iterdir():
                (output_directory / path.name).write_bytes(path.read_bytes())
            stale_path = output_directory / "profile10.4.mkv"
            stale_path.write_bytes(b"stale")
            exit_status, output, errors = self.run_main(["--check"], output_directory)
            self.assertEqual(
                (exit_status, output, errors),
                (1, "", f"Regenerated output differs from the committed bytes: {stale_path}\n"),
            )
            self.assertEqual(stale_path.read_bytes(), b"stale")

    def test_reports_a_failed_check_before_writing_anything(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            # The last sub-profile fails after the others pass
            exit_status, output, errors = self.run_main([], output_directory, failing_sub_profile_name="10.4")
            self.assertEqual((exit_status, output, errors), (1, "", "Profile 10.4 parity mismatch\n"))
            self.assertEqual(list(output_directory.iterdir()), [])

    def test_check_reports_a_missing_committed_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            exit_status, output, errors = self.run_main(["--check"], output_directory)
            self.assertEqual((exit_status, output), (1, ""))
            self.assertEqual(errors, f"Committed output is missing: {output_directory / 'profile10.0.mp4'}\n")
            self.assertEqual(list(output_directory.iterdir()), [])

    def test_parses_the_command_line(self) -> None:
        arguments = generator.parse_arguments(["--check", "--ffmpeg", "tools/ffmpeg.exe"])
        self.assertEqual((arguments.check, arguments.ffmpeg, arguments.ffprobe), (True, "tools/ffmpeg.exe", None))
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            generator.parse_arguments(["check"])
        self.assertEqual(raised.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
