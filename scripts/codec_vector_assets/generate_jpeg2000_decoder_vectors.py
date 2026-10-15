#!/usr/bin/env python3
"""Generate the JPEG 2000 decoder project's self-test media: one small multi-frame stream per output format.

FFmpeg's native jpeg2000 encoder and libopenjpeg encode them, varying the wavelet, tiles, quality layers, progression orders, and SOP and EPH
markers. Most are QuickTime files whose samples are whole JP2 files, as FFmpeg's encoders write them; two are Motion JPEG 2000 files this
script muxes itself, one holding each frame's codestream in a Contiguous Codestream box as ISO/IEC 15444-3 writers do, one holding JP2 files.
Another FFmpeg build encodes different bytes, so regenerated media never replaces a committed file; --check fails unless they are identical.
"""

from __future__ import annotations

import argparse
import base64
import json
import shutil
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Sequence

from engine_layout import DECODERS_DIRECTORY
from generated_output import GeneratedOutputError, install_or_check_output


VECTOR_DIRECTORY: Final = DECODERS_DIRECTORY / "jpeg2000" / "vectors"
FRAME_COUNT: Final = 3
FRAME_RATE: Final = 24
SOURCE_PATTERN: Final = "testsrc2=size={width}x{height}:rate={rate}"
CONTAINER_MOV: Final = "mov"
CONTAINER_MJ2: Final = "mj2"
# The two ways a Motion JPEG 2000 sample holds its picture
SAMPLE_CODESTREAM_BOX: Final = "codestream-box"
SAMPLE_JP2_FILE: Final = "jp2-file"
# Box types and fields of the Motion JPEG 2000 file ISO/IEC 15444-3 defines
SIGNATURE_BOX: Final = b"\x00\x00\x00\x0cjP  \r\n\x87\n"
BRAND: Final = b"mjp2"
UNITY_MATRIX: Final = (0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000)
FIXED_POINT_ONE: Final = 0x00010000
FULL_VOLUME: Final = 0x0100
TRACK_ENABLED_IN_MOVIE_AND_PREVIEW: Final = 0x000007
VIDEO_MEDIA_HEADER_FLAGS: Final = 0x000001
SELF_CONTAINED_DATA_REFERENCE: Final = 0x000001
UNDETERMINED_LANGUAGE: Final = 0x55C4
RESOLUTION_72_DPI: Final = 0x00480000
COLOUR_DEPTH: Final = 0x0018
NO_COLOUR_TABLE: Final = 0xFFFF
COMPRESSOR_NAME: Final = b"Motion JPEG 2000"
COMPRESSOR_NAME_FIELD_LENGTH: Final = 32
NEXT_TRACK_ID: Final = 2
TRACK_ID: Final = 1
COMPRESSION_TYPE: Final = 7
ENUMERATED_COLOUR_METHOD: Final = 1
SYCC_COLOUR_SPACE: Final = 18
PROGRESSIVE_FIELD_COUNT: Final = 1
BOX_HEADER_LENGTH: Final = 8
BITEXACT_DECODER_OPTIONS: Final = ("-flags", "bitexact")


class VectorGenerationError(RuntimeError):
    """Reports a medium the script cannot encode or mux."""


@dataclass(frozen=True)
class PixelLayout:
    """A pixel format's component count and bits, which an MJ2 sample entry's image header states."""

    bits: int
    components: int


PIXEL_LAYOUTS: Final = {
    "yuv420p": PixelLayout(bits=8, components=3),
    "yuv420p10le": PixelLayout(bits=10, components=3),
    "yuv420p12le": PixelLayout(bits=12, components=3),
    "yuv422p": PixelLayout(bits=8, components=3),
    "yuv422p10le": PixelLayout(bits=10, components=3),
    "yuv422p12le": PixelLayout(bits=12, components=3),
    "yuv444p": PixelLayout(bits=8, components=3),
    "yuv444p10le": PixelLayout(bits=10, components=3),
    "yuv444p12le": PixelLayout(bits=12, components=3),
}


@dataclass(frozen=True)
class DecoderVector:
    """One medium: its file, output format, picture size and pixel format, encoder arguments, container, and FFmpeg's reference decode options."""

    container: str
    decoder_options: tuple[str, ...]
    encoder_arguments: tuple[str, ...]
    file_name: str
    height: int
    output_format: str
    pixel_format: str
    sample_kind: str
    width: int


VECTORS: Final = (
    DecoderVector(
        container=CONTAINER_MOV,
        decoder_options=BITEXACT_DECODER_OPTIONS,
        encoder_arguments=("-c:v", "jpeg2000", "-tile_width", "64", "-tile_height", "48", "-layer_rates", "30,12,4",
                           "-prog", "lrcp", "-sop", "1", "-eph", "1"),
        file_name="native-97-tiles-layers-lrcp-420.mov",
        height=113,
        output_format="I420",
        pixel_format="yuv420p",
        sample_kind=SAMPLE_JP2_FILE,
        width=199,
    ),
    DecoderVector(
        container=CONTAINER_MOV,
        decoder_options=BITEXACT_DECODER_OPTIONS,
        encoder_arguments=("-c:v", "libopenjpeg", "-irreversible", "1", "-compression_level", "10", "-prog_order", "rpcl",
                           "-numresolution", "5"),
        file_name="openjpeg-97-rpcl-420p10.mov",
        height=96,
        output_format="I420P10",
        pixel_format="yuv420p10le",
        sample_kind=SAMPLE_JP2_FILE,
        width=160,
    ),
    DecoderVector(
        container=CONTAINER_MOV,
        decoder_options=(),
        encoder_arguments=("-c:v", "jpeg2000", "-pred", "dwt53", "-prog", "pcrl", "-tile_width", "128", "-tile_height", "64"),
        file_name="native-53-tiles-pcrl-420p12.mov",
        height=120,
        output_format="I420P12",
        pixel_format="yuv420p12le",
        sample_kind=SAMPLE_JP2_FILE,
        width=176,
    ),
    DecoderVector(
        container=CONTAINER_MOV,
        decoder_options=(),
        encoder_arguments=("-c:v", "libopenjpeg", "-prog_order", "cprl", "-numresolution", "4"),
        file_name="openjpeg-53-cprl-422.mov",
        height=98,
        output_format="I422",
        pixel_format="yuv422p",
        sample_kind=SAMPLE_JP2_FILE,
        width=130,
    ),
    DecoderVector(
        container=CONTAINER_MJ2,
        decoder_options=BITEXACT_DECODER_OPTIONS,
        encoder_arguments=("-c:v", "jpeg2000", "-format", "j2k", "-prog", "rlcp", "-layer_rates", "20,6"),
        file_name="native-97-layers-rlcp-422p10.mj2",
        height=75,
        output_format="I422P10",
        pixel_format="yuv422p10le",
        sample_kind=SAMPLE_CODESTREAM_BOX,
        width=211,
    ),
    DecoderVector(
        container=CONTAINER_MOV,
        decoder_options=BITEXACT_DECODER_OPTIONS,
        encoder_arguments=("-c:v", "libopenjpeg", "-irreversible", "1", "-compression_level", "6", "-prog_order", "lrcp"),
        file_name="openjpeg-97-lrcp-422p12.mov",
        height=128,
        output_format="I422P12",
        pixel_format="yuv422p12le",
        sample_kind=SAMPLE_JP2_FILE,
        width=128,
    ),
    DecoderVector(
        container=CONTAINER_MOV,
        decoder_options=(),
        encoder_arguments=("-c:v", "libopenjpeg", "-prog_order", "rlcp"),
        file_name="openjpeg-53-rct-rlcp-444.mov",
        height=108,
        output_format="I444",
        pixel_format="yuv444p",
        sample_kind=SAMPLE_JP2_FILE,
        width=192,
    ),
    DecoderVector(
        container=CONTAINER_MOV,
        decoder_options=BITEXACT_DECODER_OPTIONS,
        encoder_arguments=("-c:v", "jpeg2000", "-prog", "cprl", "-tile_width", "32", "-tile_height", "32", "-sop", "1", "-eph", "1"),
        file_name="native-97-tiles-cprl-444p10.mov",
        height=75,
        output_format="I444P10",
        pixel_format="yuv444p10le",
        sample_kind=SAMPLE_JP2_FILE,
        width=99,
    ),
    DecoderVector(
        container=CONTAINER_MJ2,
        decoder_options=BITEXACT_DECODER_OPTIONS,
        encoder_arguments=("-c:v", "libopenjpeg", "-irreversible", "1", "-compression_level", "4", "-prog_order", "pcrl"),
        file_name="openjpeg-97-ict-pcrl-444p12.mj2",
        height=81,
        output_format="I444P12",
        pixel_format="yuv444p12le",
        sample_kind=SAMPLE_JP2_FILE,
        width=144,
    ),
)


def resolve_tool_path(tool_name: str, explicit_path: Path | None) -> Path:
    """Resolves a tool from its explicit flag, otherwise from PATH."""

    if explicit_path is not None:
        resolved_path = explicit_path.expanduser().resolve()
        if not resolved_path.is_file():
            raise FileNotFoundError(f"{tool_name} was not found: {resolved_path}")
        return resolved_path
    path_resolution = shutil.which(tool_name)
    if path_resolution is None:
        raise FileNotFoundError(f"{tool_name} was not found on PATH; pass --{tool_name}")
    return Path(path_resolution).resolve()


def get_encode_arguments(vector: DecoderVector, output_path: Path) -> list[str]:
    """Returns FFmpeg's arguments that encode a vector's frames into a QuickTime file, without metadata that would vary between runs."""

    source = SOURCE_PATTERN.format(width=vector.width + vector.width % 2, height=vector.height + vector.height % 2, rate=FRAME_RATE)
    return [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        source,
        "-vf",
        f"scale={vector.width}:{vector.height}",
        "-frames:v",
        str(FRAME_COUNT),
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-pix_fmt",
        vector.pixel_format,
        *vector.encoder_arguments,
        "-f",
        CONTAINER_MOV,
        "-y",
        str(output_path),
    ]


def read_samples(ffprobe_path: Path, media_path: Path) -> list[bytes]:
    """Returns the video samples of a medium as FFprobe demuxes them, in decode order."""

    result = subprocess.run(
        [str(ffprobe_path), "-v", "error", "-select_streams", "v:0", "-show_packets", "-show_data", "-data_dump_format", "base64",
         "-of", "json", str(media_path)],
        capture_output=True,
        check=False,
        stdin=subprocess.DEVNULL,
    )
    if result.returncode != 0:
        raise VectorGenerationError(f"ffprobe failed on {media_path.name}:\n{result.stderr.decode('utf-8', errors='replace')}")
    packets = json.loads(result.stdout.decode("utf-8")).get("packets", [])
    return [base64.b64decode("".join(packet["data"].split())) for packet in packets]


def box(box_type: bytes, payload: bytes) -> bytes:
    """Returns a box of a type around its payload."""

    return struct.pack(">I", len(payload) + BOX_HEADER_LENGTH) + box_type + payload


def full_box(box_type: bytes, version: int, flags: int, payload: bytes) -> bytes:
    """Returns a full box: a box whose payload starts with its version and flags."""

    return box(box_type, struct.pack(">I", (version << 24) | flags) + payload)


def pack_matrix() -> bytes:
    return struct.pack(">9I", *UNITY_MATRIX)


def get_sample_entry(width: int, height: int, layout: PixelLayout) -> bytes:
    """Returns the 'mjp2' visual sample entry with its JP2 header, which states the sYCC colour space of the YUV components."""

    image_header = box(b"ihdr", struct.pack(">IIHBBBB", height, width, layout.components, layout.bits - 1, COMPRESSION_TYPE, 0, 0))
    colour = box(b"colr", struct.pack(">BBBI", ENUMERATED_COLOUR_METHOD, 0, 0, SYCC_COLOUR_SPACE))
    compressor_name = bytes([len(COMPRESSOR_NAME)]) + COMPRESSOR_NAME
    compressor_name += bytes(COMPRESSOR_NAME_FIELD_LENGTH - len(compressor_name))
    visual_fields = (
        bytes(6)
        + struct.pack(">H", 1)
        + bytes(16)
        + struct.pack(">HHIIIH", width, height, RESOLUTION_72_DPI, RESOLUTION_72_DPI, 0, 1)
        + compressor_name
        + struct.pack(">HH", COLOUR_DEPTH, NO_COLOUR_TABLE)
    )
    fields = box(b"fiel", bytes([PROGRESSIVE_FIELD_COUNT, 0]))
    return box(b"mjp2", visual_fields + box(b"jp2h", image_header + colour) + fields)


def mux_motion_jpeg2000(samples: Sequence[bytes], width: int, height: int, layout: PixelLayout) -> bytes:
    """Muxes samples into a Motion JPEG 2000 file: its signature and file type, the samples in one chunk, then the movie box."""

    file_type = box(b"ftyp", BRAND + struct.pack(">I", 0) + BRAND)
    media_data = box(b"mdat", b"".join(samples))
    first_sample_offset = len(SIGNATURE_BOX) + len(file_type) + BOX_HEADER_LENGTH
    duration = len(samples)
    movie_header = full_box(
        b"mvhd",
        0,
        0,
        struct.pack(">IIII", 0, 0, FRAME_RATE, duration) + struct.pack(">IH", FIXED_POINT_ONE, FULL_VOLUME) + bytes(10)
        + pack_matrix() + bytes(24) + struct.pack(">I", NEXT_TRACK_ID),
    )
    track_header = full_box(
        b"tkhd",
        0,
        TRACK_ENABLED_IN_MOVIE_AND_PREVIEW,
        struct.pack(">IIIII", 0, 0, TRACK_ID, 0, duration) + bytes(8) + struct.pack(">HHHH", 0, 0, 0, 0) + pack_matrix()
        + struct.pack(">II", width << 16, height << 16),
    )
    media_header = full_box(b"mdhd", 0, 0, struct.pack(">IIIIHH", 0, 0, FRAME_RATE, duration, UNDETERMINED_LANGUAGE, 0))
    handler = full_box(b"hdlr", 0, 0, struct.pack(">I", 0) + b"vide" + bytes(12) + b"Video\x00")
    video_header = full_box(b"vmhd", 0, VIDEO_MEDIA_HEADER_FLAGS, bytes(8))
    data_information = box(b"dinf", full_box(b"dref", 0, 0, struct.pack(">I", 1) + full_box(b"url ", 0, SELF_CONTAINED_DATA_REFERENCE, b"")))
    sample_description = full_box(b"stsd", 0, 0, struct.pack(">I", 1) + get_sample_entry(width, height, layout))
    time_to_sample = full_box(b"stts", 0, 0, struct.pack(">III", 1, len(samples), 1))
    sample_to_chunk = full_box(b"stsc", 0, 0, struct.pack(">IIII", 1, 1, len(samples), 1))
    sample_sizes = full_box(b"stsz", 0, 0, struct.pack(">II", 0, len(samples)) + b"".join(struct.pack(">I", len(sample)) for sample in samples))
    chunk_offsets = full_box(b"stco", 0, 0, struct.pack(">II", 1, first_sample_offset))
    sample_table = box(b"stbl", sample_description + time_to_sample + sample_to_chunk + sample_sizes + chunk_offsets)
    media_information = box(b"minf", video_header + data_information + sample_table)
    track = box(b"trak", track_header + box(b"mdia", media_header + handler + media_information))
    movie = box(b"moov", movie_header + track)
    return SIGNATURE_BOX + file_type + media_data + movie


def wrap_sample(vector: DecoderVector, sample: bytes) -> bytes:
    """Returns an MJ2 sample: a bare codestream in its Contiguous Codestream box, or the JP2 file FFmpeg's encoder wrote."""

    if vector.sample_kind == SAMPLE_CODESTREAM_BOX:
        if not sample.startswith(b"\xff\x4f"):
            raise VectorGenerationError(f"{vector.file_name}: the encoder wrote no bare codestream")
        return box(b"jp2c", sample)
    return sample


def generate_vector(vector: DecoderVector, ffmpeg_path: Path, ffprobe_path: Path, *, check: bool) -> bool:
    """Encodes one vector and installs it when it is missing, or compares it with the committed file; returns whether it was written."""

    with tempfile.TemporaryDirectory(prefix="webgpu-jpeg2000-vector-") as temporary_directory:
        # A failed encode never touches the committed vector
        encoded_path = Path(temporary_directory) / f"encoded.{CONTAINER_MOV}"
        result = subprocess.run([str(ffmpeg_path), *get_encode_arguments(vector, encoded_path)], capture_output=True, check=False, stdin=subprocess.DEVNULL)
        if result.returncode != 0:
            raise VectorGenerationError(f"FFmpeg failed on {vector.file_name}:\n{result.stderr.decode('utf-8', errors='replace')}")
        if vector.container == CONTAINER_MOV:
            content = encoded_path.read_bytes()
        else:
            samples = read_samples(ffprobe_path, encoded_path)
            if len(samples) != FRAME_COUNT:
                raise VectorGenerationError(f"{vector.file_name}: {len(samples)} samples, expected {FRAME_COUNT}")
            layout = PIXEL_LAYOUTS[vector.pixel_format]
            content = mux_motion_jpeg2000([wrap_sample(vector, sample) for sample in samples], vector.width, vector.height, layout)
        return install_or_check_output(VECTOR_DIRECTORY / vector.file_name, content, check=check)


def get_decoder_declarations() -> list[dict[str, object]]:
    """Returns the vector declarations of decoders/jpeg2000/decoder.json that match these media, for --print-declarations."""

    declarations: list[dict[str, object]] = []
    for vector in VECTORS:
        declaration: dict[str, object] = {"format": vector.output_format, "root": "decodersDirectory", "path": f"jpeg2000/vectors/{vector.file_name}"}
        if vector.decoder_options:
            declaration["decoderOptions"] = list(vector.decoder_options)
        declarations.append(declaration)
    return declarations


def parse_arguments(command_arguments: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", type=Path, help="FFmpeg executable; defaults to ffmpeg on PATH. The committed media was encoded by FFmpeg 2026-03-01-git-862338fe31")
    parser.add_argument("--ffprobe", type=Path, help="FFprobe executable; defaults to ffprobe on PATH")
    parser.add_argument("--check", action="store_true", help="Fail unless every committed medium matches its regeneration; nothing is written")
    parser.add_argument("--print-declarations", action="store_true", help="Print the vectors list of decoder.json for these media and exit")
    return parser.parse_args(command_arguments)


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Generates or checks every medium and returns the process exit status."""

    arguments = parse_arguments(command_arguments)
    if arguments.print_declarations:
        print(json.dumps(get_decoder_declarations(), indent=4))
        return 0
    try:
        ffmpeg_path = resolve_tool_path("ffmpeg", arguments.ffmpeg)
        ffprobe_path = resolve_tool_path("ffprobe", arguments.ffprobe)
        written = [vector.file_name for vector in VECTORS if generate_vector(vector, ffmpeg_path, ffprobe_path, check=arguments.check)]
    except (VectorGenerationError, GeneratedOutputError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    action = "Verified" if arguments.check else "Generated"
    print(f"{action} {len(VECTORS)} JPEG 2000 decoder vectors in {VECTOR_DIRECTORY}" + (f"; wrote {', '.join(written)}" if written else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
