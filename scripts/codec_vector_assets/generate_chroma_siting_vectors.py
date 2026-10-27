#!/usr/bin/env python3
"""Generate the chroma siting test vectors, or verify them with --check.

Each vector is a short H.264 or HEVC encode whose SPS declares a 4:2:0 chroma location, in a container that leaves the SPS to the stream,
so the engine reads the location from its first key packet's in-band SPS:
- H.264 and HEVC in MPEG-TS and M2TS, and H.264 in AVI, whose packets are Annex B and whose tracks have no decoder record;
- H.264 under avc3 and HEVC under hev1, in MP4 and in Matroska, with their encoders repeating the parameter sets in band
  and the generator removing them from the avcC or hvcC, as a record may leave them out.
Beside them, HEVC outside the bounded SPS parser's progressive Main and Main 10 bounds, with its SPS in its hvcC:
an interlaced field sequence, Main 12, and Main 4:2:2 10, whose location the engine leaves undeclared.

The encoders' bytes depend on the FFmpeg build, so the generator refuses any but the pinned one, and an existing vector is only compared, never replaced.
Before writing, it checks each file with FFprobe: the codec, the codec tag, the pixel format, and the chroma location FFmpeg's decoder reads,
and that no record of an avc3 or hev1 vector holds an SPS.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Sequence

from engine_layout import CODEC_VECTOR_ASSETS_DIRECTORY
from generated_output import GeneratedOutputError, install_or_check_output
from media_tools import (
    MediaTools,
    ToolError,
    VectorGenerationError,
    check_toolchain,
    execute_tool,
    require_equal,
    resolve_FFmpeg_tool,
)


VECTOR_DIRECTORY: Final = CODEC_VECTOR_ASSETS_DIRECTORY / "chroma-siting"

# 192x192, like the other vectors, so hardware decoders with a minimum coded size accept it
VIDEO_SOURCE: Final = "testsrc2=size=192x192:rate=24:duration=0.25"
VIDEO_FRAME_COUNT: Final = 6
X264_PARAMETERS: Final = "threads=1"
X265_PARAMETERS: Final = "info=0:pools=none:frame-threads=1:wpp=0:log-level=error"
# The encoders write the parameter sets into every key packet, as avc3 and hev1 streams carry them
REPEATED_HEADERS_PARAMETER: Final = "repeat-headers=1"
# libx265 encodes each frame of its input as one field of a field sequence, field_seq_flag set
INTERLACED_PARAMETER: Final = "interlace=tff"

# ISO base media boxes on the way to a sample entry's decoder record, and the bytes before each container's children
CONTAINER_BOX_TYPES: Final = frozenset({b"moov", b"trak", b"mdia", b"minf", b"stbl"})
SAMPLE_DESCRIPTION_BOX_TYPE: Final = b"stsd"
SAMPLE_DESCRIPTION_HEADER_BYTE_LENGTH: Final = 8
VISUAL_SAMPLE_ENTRY_BYTE_LENGTH: Final = 78
SAMPLE_ENTRY_RECORD_TYPES: Final = {b"avc3": b"avcC", b"hev1": b"hvcC"}
BOX_HEADER_BYTE_LENGTH: Final = 8
# avcC: the fixed header before numOfSequenceParameterSets, whose top three bits are reserved ones
AVCC_HEADER_BYTE_LENGTH: Final = 5
AVCC_NO_SEQUENCE_PARAMETER_SETS: Final = 0xE0
AVCC_SPS_COUNT_MASK: Final = 0x1F
# hvcC: the fixed header before numOfArrays
HVCC_HEADER_BYTE_LENGTH: Final = 22
LENGTH_FIELD_BYTE_LENGTH: Final = 2
# A record without parameter sets: avcC's header, both counts, and High's four closing bytes; hvcC's header and a zero numOfArrays
STRIPPED_AVCC_BYTE_LENGTH: Final = 11
STRIPPED_HVCC_BYTE_LENGTH: Final = 23


@dataclass(frozen=True)
class ChromaSitingVector:
    """One vector: its file name, its encode, its container, and what FFprobe must read back."""

    file_name: str
    # One of libx264 and libx265
    encoder: str
    pixel_format: str
    # x264's and x265's chromaloc, H.273's chroma_sample_loc_type
    chroma_location_type: int
    encoder_parameters: tuple[str, ...]
    output_arguments: tuple[str, ...]
    codec_tag: str
    # FFmpeg's name of the location its decoder reads, unspecified where it reads none, as for 4:2:2
    probed_chroma_location: str
    # The container a vector whose MP4 record loses its parameter sets ends in, mp4 or matroska; None for a vector kept as encoded
    strip_record_into: str | None = None

    @property
    def codec_name(self) -> str:
        return "h264" if self.encoder == "libx264" else "hevc"


TRANSPORT_STREAM_ARGUMENTS: Final = ("-f", "mpegts")
M2TS_ARGUMENTS: Final = ("-f", "mpegts", "-mpegts_m2ts_mode", "1")

CHROMA_SITING_VECTORS: Final = (
    ChromaSitingVector("h264-top-left.ts", "libx264", "yuv420p", 2, (), TRANSPORT_STREAM_ARGUMENTS, "[27][0][0][0]", "topleft"),
    ChromaSitingVector("h264-top.m2ts", "libx264", "yuv420p", 3, (), M2TS_ARGUMENTS, "[27][0][0][0]", "top"),
    ChromaSitingVector("h264-bottom-left.avi", "libx264", "yuv420p", 4, (), ("-f", "avi"), "H264", "bottomleft"),
    ChromaSitingVector(
        "h264-bottom-avc3.mp4", "libx264", "yuv420p", 5, (REPEATED_HEADERS_PARAMETER,), ("-tag:v", "avc3", "-f", "mp4"), "avc3", "bottom", "mp4"
    ),
    ChromaSitingVector(
        "h264-center-avc3.mkv", "libx264", "yuv420p", 1, (REPEATED_HEADERS_PARAMETER,), ("-tag:v", "avc3", "-f", "mp4"), "[0][0][0][0]", "center", "matroska"
    ),
    ChromaSitingVector("hevc-top-left.ts", "libx265", "yuv420p", 2, (), TRANSPORT_STREAM_ARGUMENTS, "HEVC", "topleft"),
    ChromaSitingVector("hevc-top.m2ts", "libx265", "yuv420p", 3, (), M2TS_ARGUMENTS, "HEVC", "top"),
    ChromaSitingVector(
        "hevc-bottom-hev1.mp4", "libx265", "yuv420p", 5, (REPEATED_HEADERS_PARAMETER,), ("-tag:v", "hev1", "-f", "mp4"), "hev1", "bottom", "mp4"
    ),
    ChromaSitingVector(
        "hevc-center-hev1.mkv", "libx265", "yuv420p", 1, (REPEATED_HEADERS_PARAMETER,), ("-tag:v", "hev1", "-f", "mp4"), "[0][0][0][0]", "center", "matroska"
    ),
    ChromaSitingVector(
        "hevc-interlaced-bottom-left.mkv", "libx265", "yuv420p", 4, (INTERLACED_PARAMETER,), ("-f", "matroska"), "[0][0][0][0]", "bottomleft"
    ),
    ChromaSitingVector("hevc-main12-top.mp4", "libx265", "yuv420p12le", 3, (), ("-tag:v", "hvc1", "-f", "mp4"), "hvc1", "top"),
    # libx265 declares no location for 4:2:2, whose chroma H.264 and HEVC fix on the left luma column
    ChromaSitingVector("hevc-422-10.mkv", "libx265", "yuv422p10le", 2, (), ("-f", "matroska"), "[0][0][0][0]", "unspecified"),
)


def parse_arguments(command_arguments: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail unless every committed vector matches a fresh encode")
    parser.add_argument("--ffmpeg", help="The FFmpeg executable, ffmpeg on PATH by default")
    parser.add_argument("--ffprobe", help="The FFprobe executable, ffprobe on PATH by default")
    return parser.parse_args(command_arguments)


def remove_avcc_parameter_sets(record: bytes) -> bytes:
    """Returns an avcC without its SPSs and PPSs, keeping the header and the chroma_format, bit depth, and SPS extension fields a High profile's record closes with."""

    offset = AVCC_HEADER_BYTE_LENGTH + 1
    for _ in range(record[AVCC_HEADER_BYTE_LENGTH] & AVCC_SPS_COUNT_MASK):
        offset += LENGTH_FIELD_BYTE_LENGTH + int.from_bytes(record[offset:offset + LENGTH_FIELD_BYTE_LENGTH], "big")
    picture_parameter_set_count = record[offset]
    offset += 1
    for _ in range(picture_parameter_set_count):
        offset += LENGTH_FIELD_BYTE_LENGTH + int.from_bytes(record[offset:offset + LENGTH_FIELD_BYTE_LENGTH], "big")
    return record[:AVCC_HEADER_BYTE_LENGTH] + bytes((AVCC_NO_SEQUENCE_PARAMETER_SETS, 0)) + record[offset:]


def remove_hvcc_parameter_sets(record: bytes) -> bytes:
    """Returns an hvcC without its NAL unit arrays, the VPS, SPS, and PPS arrays and any SEI array."""

    return record[:HVCC_HEADER_BYTE_LENGTH] + b"\x00"


def rebuild_boxes(data: bytes) -> bytes:
    """Rebuilds a run of ISO base media boxes, removing the parameter sets from each avc3 or hev1 sample entry's record, and resizing every box around it."""

    output = bytearray()
    offset = 0
    while offset < len(data):
        size = int.from_bytes(data[offset:offset + 4], "big")
        box_type = data[offset + 4:offset + BOX_HEADER_BYTE_LENGTH]
        if size < BOX_HEADER_BYTE_LENGTH or offset + size > len(data):
            raise VectorGenerationError(f"The {box_type!r} box has an unsupported size {size}")
        payload = data[offset + BOX_HEADER_BYTE_LENGTH:offset + size]
        if box_type in CONTAINER_BOX_TYPES:
            payload = rebuild_boxes(payload)
        elif box_type == SAMPLE_DESCRIPTION_BOX_TYPE:
            payload = payload[:SAMPLE_DESCRIPTION_HEADER_BYTE_LENGTH] + rebuild_boxes(payload[SAMPLE_DESCRIPTION_HEADER_BYTE_LENGTH:])
        elif box_type in SAMPLE_ENTRY_RECORD_TYPES:
            payload = payload[:VISUAL_SAMPLE_ENTRY_BYTE_LENGTH] + rebuild_boxes(payload[VISUAL_SAMPLE_ENTRY_BYTE_LENGTH:])
        elif box_type == b"avcC":
            payload = remove_avcc_parameter_sets(payload)
        elif box_type == b"hvcC":
            payload = remove_hvcc_parameter_sets(payload)
        output += (len(payload) + BOX_HEADER_BYTE_LENGTH).to_bytes(4, "big") + box_type + payload
        offset += size
    return bytes(output)


def remove_record_parameter_sets(mp4: bytes) -> bytes:
    """Returns an MP4 whose avc3 or hev1 record holds no parameter sets.

    FFmpeg writes the movie box after the media data, so resizing it moves no chunk offset.
    """

    if mp4.find(b"moov") < mp4.find(b"mdat"):
        raise VectorGenerationError("The MP4's movie box precedes its media data")
    return rebuild_boxes(mp4)


def encode_vector(tools: MediaTools, vector: ChromaSitingVector, output_path: Path) -> None:
    """Encodes one vector with the pinned FFmpeg and bit-exact flags."""

    parameters_option = "-x264-params" if vector.encoder == "libx264" else "-x265-params"
    base_parameters = X264_PARAMETERS if vector.encoder == "libx264" else X265_PARAMETERS
    parameters = ":".join((base_parameters, f"chromaloc={vector.chroma_location_type}", *vector.encoder_parameters))
    execute_tool(tools.FFmpeg_path, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", VIDEO_SOURCE,
        "-frames:v", str(VIDEO_FRAME_COUNT), "-pix_fmt", vector.pixel_format,
        "-c:v", vector.encoder, parameters_option, parameters,
        "-fflags", "+bitexact", "-flags:v", "+bitexact",
        *vector.output_arguments, str(output_path),
    ])


def write_vector(tools: MediaTools, vector: ChromaSitingVector, temporary_directory: Path) -> Path:
    """Encodes a vector, removing its record's parameter sets and remuxing it where it takes that, and returns its path."""

    encoded_path = temporary_directory / f"encoded-{vector.file_name}"
    if vector.strip_record_into is None:
        encode_vector(tools, vector, encoded_path)
        return encoded_path
    mp4_path = encoded_path.with_suffix(".mp4")
    encode_vector(tools, vector, mp4_path)
    stripped_path = temporary_directory / f"stripped-{vector.file_name}.mp4"
    stripped_path.write_bytes(remove_record_parameter_sets(mp4_path.read_bytes()))
    if vector.strip_record_into == "mp4":
        return stripped_path
    # FFmpeg copies an avcC or hvcC it demuxed into the Matroska CodecPrivate as it is
    execute_tool(tools.FFmpeg_path, [
        "-hide_banner", "-loglevel", "error", "-y", "-i", str(stripped_path), "-c", "copy",
        "-fflags", "+bitexact", "-f", vector.strip_record_into, str(encoded_path),
    ])
    return encoded_path


def verify_vector(tools: MediaTools, vector: ChromaSitingVector, path: Path) -> None:
    """Requires FFprobe to read the vector's video stream and every frame, and FFmpeg's decoder the declared chroma location."""

    probe = json.loads(execute_tool(tools.FFprobe_path, [
        "-hide_banner", "-loglevel", "error", "-count_frames",
        "-show_entries", "stream=codec_name,codec_tag_string,pix_fmt,chroma_location,nb_read_frames,extradata_size",
        "-of", "json", str(path),
    ]))
    streams = probe["streams"]
    require_equal(len(streams), 1, f"{vector.file_name} stream count")
    stream = streams[0]
    require_equal(stream["codec_name"], vector.codec_name, f"{vector.file_name} codec")
    require_equal(stream["codec_tag_string"], vector.codec_tag, f"{vector.file_name} codec tag")
    require_equal(stream["pix_fmt"], vector.pixel_format, f"{vector.file_name} pixel format")
    require_equal(stream.get("chroma_location", "unspecified"), vector.probed_chroma_location, f"{vector.file_name} chroma location")
    # A field sequence decodes each field as a picture
    if int(stream["nb_read_frames"]) < VIDEO_FRAME_COUNT:
        raise VectorGenerationError(f"{vector.file_name} decodes {stream['nb_read_frames']} frames")
    # The record is the stream's extradata in MP4 and Matroska alike, and holds no parameter set once only its fixed fields remain
    if vector.strip_record_into is not None:
        stripped_record_byte_length = STRIPPED_AVCC_BYTE_LENGTH if vector.codec_name == "h264" else STRIPPED_HVCC_BYTE_LENGTH
        require_equal(int(stream["extradata_size"]), stripped_record_byte_length, f"{vector.file_name} record size")


def main(command_arguments: Sequence[str] | None = None) -> int:
    arguments = parse_arguments(command_arguments)
    tools = MediaTools(resolve_FFmpeg_tool("ffmpeg", arguments.ffmpeg), resolve_FFmpeg_tool("ffprobe", arguments.ffprobe))
    try:
        check_toolchain(tools)
        with tempfile.TemporaryDirectory() as temporary_directory:
            for vector in CHROMA_SITING_VECTORS:
                vector_path = write_vector(tools, vector, Path(temporary_directory))
                verify_vector(tools, vector, vector_path)
                written = install_or_check_output(
                    VECTOR_DIRECTORY / vector.file_name,
                    vector_path.read_bytes(),
                    check=arguments.check,
                )
                print(f"{'Wrote' if written else 'Matched'} {vector.file_name}")
    except (GeneratedOutputError, ToolError, VectorGenerationError) as error:
        print(f"generate_chroma_siting_vectors: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
