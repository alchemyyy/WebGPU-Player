#!/usr/bin/env python3
"""Generate the MPEG-4 Part 2, H.263, and MS-MPEG4 decoder project's media: its self-test stream and one stream per codec and container its routes take.

libxvid encodes the self-test stream with global motion compensation (S-VOPs), quarter-sample motion, and B-VOPs from a rotating and zooming
source. It is written as a raw stream, which loses the N-VOPs libxvid writes for its delayed frames, as a native Matroska muxer drops them,
and FFmpeg remuxes it into Matroska with timestamps it generates in presentation order: libxvid's own Matroska output stamps each P-VOP
before the B-VOPs shown ahead of it. FFmpeg's mpeg4, msmpeg4, msmpeg4v2, h263, and h263p encoders write the other streams into MP4, AVI,
3GP, and Matroska, tagged as FFmpeg's muxers tag them. FFmpeg's Matroska muxer writes MPEG-4 Part 2 only as a native track, so one Matroska
file is rewritten into a Video for Windows track whose blocks carry an AVI's decode-order timestamps.
Each medium must probe as its codec and FourCC, show its picture types, and decode one frame per packet in FFmpeg's bit-exact single-threaded decode.
Another encoder build writes different bytes, so regenerated media never replaces a committed file; --check fails unless they are identical.
"""

from __future__ import annotations

import argparse
import json
import shutil
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Sequence

from engine_layout import DECODERS_DIRECTORY
from generated_output import GeneratedOutputError, install_or_check_output


VECTOR_DIRECTORY: Final = DECODERS_DIRECTORY / "mpeg4" / "vectors"
FRAME_RATE: Final = 25
FRAME_DURATION_MILLISECONDS: Final = 1_000 // FRAME_RATE
# The reference decode the package matches: FFmpeg's C code, which +bitexact selects, in one thread
REFERENCE_DECODER_OPTIONS: Final = ("-threads", "1", "-flags", "+bitexact")
SOURCE_PATTERN: Final = "testsrc2=size={width}x{height}:rate={rate},format=yuv420p"
# A source twice the picture's size, turned and zoomed into its center a little more each frame, so the motion is global
MOVING_SOURCE_PATTERN: Final = (
    "testsrc2=size={source_width}x{source_height}:rate={rate},rotate=0.015*n,"
    "zoompan=z='1+0.008*on':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s={width}x{height}:fps={rate},format=yuv420p"
)
# How an encode becomes the medium: FFmpeg's muxer writes it; a raw MPEG-4 stream remuxed into Matroska with presentation timestamps; or
# FFmpeg's Matroska file rewritten into a Video for Windows track
LAYOUT_MUXED: Final = "muxed"
LAYOUT_RAW_REMUX: Final = "raw-remux"
LAYOUT_VFW_REWRITE: Final = "vfw-rewrite"
RAW_MPEG4_MUXER: Final = "m4v"
MATROSKA_MUXER: Final = "matroska"
# ffprobe's codec_tag_string of a track without a FourCC
NO_FOURCC: Final = "[0][0][0][0]"

# MPEG-4 Part 2 start codes (ISO/IEC 14496-2 6.2.1): the prefix, VOP, and the video object layer range
START_CODE_PREFIX: Final = b"\x00\x00\x01"
START_CODE_LENGTH: Final = 4
VOP_START_CODE: Final = 0xB6
FIRST_VOL_START_CODE: Final = 0x20
LAST_VOL_START_CODE: Final = 0x2F
EXTENDED_PAR: Final = 15
GRAYSCALE_SHAPE: Final = 3
VBV_PARAMETER_BITS: Final = 79

# Matroska (RFC 9559): element IDs with their length markers, and the rewritten track's values
EBML_HEADER_ID: Final = 0x1A45DFA3
SEGMENT_ID: Final = 0x18538067
SEEK_HEAD_ID: Final = 0x114D9B74
VOID_ID: Final = 0xEC
CUES_ID: Final = 0x1C53BB6B
INFO_ID: Final = 0x1549A966
TIMESTAMP_SCALE_ID: Final = 0x2AD7B1
TRACKS_ID: Final = 0x1654AE6B
TRACK_ENTRY_ID: Final = 0xAE
CODEC_ID_ID: Final = 0x86
CODEC_PRIVATE_ID: Final = 0x63A2
VIDEO_ID: Final = 0xE0
PIXEL_WIDTH_ID: Final = 0xB0
PIXEL_HEIGHT_ID: Final = 0xBA
CLUSTER_ID: Final = 0x1F43B675
CLUSTER_TIMESTAMP_ID: Final = 0xE7
SIMPLE_BLOCK_ID: Final = 0xA3
# The index the rewrite drops, whose offsets it would move
DROPPED_SEGMENT_CHILD_IDS: Final = frozenset((SEEK_HEAD_ID, VOID_ID, CUES_ID))
MAXIMUM_EBML_ID_LENGTH: Final = 4
MAXIMUM_EBML_SIZE_LENGTH: Final = 8
NANOSECONDS_PER_MILLISECOND: Final = 1_000_000
VFW_CODEC_ID: Final = b"V_MS/VFW/FOURCC"
# A SimpleBlock's 16-bit timestamp, relative to its cluster's
BLOCK_TIMESTAMP: Final = struct.Struct(">h")
# FFmpeg's BITMAPINFOHEADER of a Video for Windows track (ff_put_bmp_header): its size counts the extradata after it, one plane of 24 bits,
# the FourCC, and the bytes of a 24-bit picture
BITMAP_INFO_HEADER: Final = struct.Struct("<IiiHH4sIiiII")
BITMAP_INFO_HEADER_PLANES: Final = 1
BITMAP_INFO_HEADER_BIT_COUNT: Final = 24
BITMAP_INFO_HEADER_BYTES_PER_PIXEL: Final = 3


class VectorGenerationError(RuntimeError):
    """Reports a medium the script cannot encode, mux, or verify."""


@dataclass(frozen=True)
class Medium:
    """One medium: its file, how it is encoded and muxed, and what FFprobe must report of it."""

    codec_flags: str
    codec_name: str
    codec_tag: str
    encoder_arguments: tuple[str, ...]
    file_name: str
    frame_count: int
    height: int
    layout: str
    moving_source: bool
    muxer: str
    picture_types: frozenset[str]
    width: int


B_VOP_ARGUMENTS: Final = ("-c:v", "mpeg4", "-q:v", "6", "-bf", "2", "-g", "8")
MSMPEG4V3_ARGUMENTS: Final = ("-c:v", "msmpeg4", "-q:v", "6", "-g", "8")
MSMPEG4V2_ARGUMENTS: Final = ("-c:v", "msmpeg4v2", "-q:v", "6", "-g", "8")
H263_ARGUMENTS: Final = ("-c:v", "h263", "-q:v", "6", "-g", "8")
ANCHOR_TYPES: Final = frozenset(("I", "P"))
B_VOP_TYPES: Final = frozenset(("I", "P", "B"))
STREAM_FRAME_COUNT: Final = 16

MEDIA: Final = (
    Medium(
        codec_flags="+qpel",
        codec_name="mpeg4",
        codec_tag=NO_FOURCC,
        encoder_arguments=("-c:v", "libxvid", "-q:v", "5", "-bf", "2", "-gmc", "1", "-g", "300"),
        file_name="mpeg4-gmc-qpel-b.mkv",
        frame_count=20,
        height=120,
        layout=LAYOUT_RAW_REMUX,
        moving_source=True,
        muxer=RAW_MPEG4_MUXER,
        picture_types=frozenset(("I", "P", "S", "B")),
        width=200,
    ),
    Medium(
        codec_flags="",
        codec_name="mpeg4",
        codec_tag="mp4v",
        encoder_arguments=B_VOP_ARGUMENTS,
        file_name="mpeg4-b.mp4",
        frame_count=STREAM_FRAME_COUNT,
        height=144,
        layout=LAYOUT_MUXED,
        moving_source=False,
        muxer="mp4",
        picture_types=B_VOP_TYPES,
        width=176,
    ),
    Medium(
        codec_flags="",
        codec_name="mpeg4",
        codec_tag="XVID",
        encoder_arguments=(*B_VOP_ARGUMENTS, "-tag:v", "XVID"),
        file_name="mpeg4-b-xvid.avi",
        frame_count=STREAM_FRAME_COUNT,
        height=144,
        layout=LAYOUT_MUXED,
        moving_source=False,
        muxer="avi",
        picture_types=B_VOP_TYPES,
        width=176,
    ),
    Medium(
        codec_flags="",
        codec_name="mpeg4",
        codec_tag="XVID",
        # The rewrite recomputes no CRC-32
        encoder_arguments=(*B_VOP_ARGUMENTS, "-write_crc32", "0"),
        file_name="mpeg4-b-vfw.mkv",
        frame_count=STREAM_FRAME_COUNT,
        height=144,
        layout=LAYOUT_VFW_REWRITE,
        moving_source=False,
        muxer=MATROSKA_MUXER,
        picture_types=B_VOP_TYPES,
        width=176,
    ),
    Medium(
        codec_flags="",
        codec_name="msmpeg4v3",
        codec_tag="DIV3",
        encoder_arguments=(*MSMPEG4V3_ARGUMENTS, "-tag:v", "DIV3"),
        file_name="msmpeg4v3.avi",
        frame_count=STREAM_FRAME_COUNT,
        height=144,
        layout=LAYOUT_MUXED,
        moving_source=False,
        muxer="avi",
        picture_types=ANCHOR_TYPES,
        width=176,
    ),
    Medium(
        codec_flags="",
        codec_name="msmpeg4v3",
        codec_tag=NO_FOURCC,
        encoder_arguments=MSMPEG4V3_ARGUMENTS,
        file_name="msmpeg4v3.mkv",
        frame_count=STREAM_FRAME_COUNT,
        height=144,
        layout=LAYOUT_MUXED,
        moving_source=False,
        muxer=MATROSKA_MUXER,
        picture_types=ANCHOR_TYPES,
        width=176,
    ),
    Medium(
        codec_flags="",
        codec_name="msmpeg4v2",
        codec_tag="MP42",
        encoder_arguments=MSMPEG4V2_ARGUMENTS,
        file_name="msmpeg4v2-vfw.mkv",
        frame_count=STREAM_FRAME_COUNT,
        height=144,
        layout=LAYOUT_MUXED,
        moving_source=False,
        muxer=MATROSKA_MUXER,
        picture_types=ANCHOR_TYPES,
        width=176,
    ),
    Medium(
        codec_flags="",
        codec_name="msmpeg4v2",
        codec_tag="MP42",
        encoder_arguments=MSMPEG4V2_ARGUMENTS,
        file_name="msmpeg4v2.avi",
        frame_count=STREAM_FRAME_COUNT,
        height=144,
        layout=LAYOUT_MUXED,
        moving_source=False,
        muxer="avi",
        picture_types=ANCHOR_TYPES,
        width=176,
    ),
    # H.263 codes only its source formats, sub-QCIF the smallest
    Medium(
        codec_flags="",
        codec_name="h263",
        codec_tag="s263",
        encoder_arguments=H263_ARGUMENTS,
        file_name="h263.3gp",
        frame_count=STREAM_FRAME_COUNT,
        height=96,
        layout=LAYOUT_MUXED,
        moving_source=False,
        muxer="3gp",
        picture_types=ANCHOR_TYPES,
        width=128,
    ),
    Medium(
        codec_flags="",
        codec_name="h263",
        codec_tag="H263",
        encoder_arguments=H263_ARGUMENTS,
        file_name="h263.avi",
        frame_count=STREAM_FRAME_COUNT,
        height=96,
        layout=LAYOUT_MUXED,
        moving_source=False,
        muxer="avi",
        picture_types=ANCHOR_TYPES,
        width=128,
    ),
    # H.263+ at a custom picture size, with advanced intra coding, the deblocking filter, and unrestricted motion vectors
    Medium(
        codec_flags="+aic+loop",
        codec_name="h263",
        codec_tag="H263",
        encoder_arguments=("-c:v", "h263p", "-q:v", "6", "-g", "8", "-umv", "1"),
        file_name="h263p-vfw.mkv",
        frame_count=STREAM_FRAME_COUNT,
        height=120,
        layout=LAYOUT_MUXED,
        moving_source=False,
        muxer=MATROSKA_MUXER,
        picture_types=ANCHOR_TYPES,
        width=200,
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


def run_tool(tool_path: Path, arguments: Sequence[str], file_name: str) -> bytes:
    """Requires a tool to succeed on a medium and returns its standard output."""

    result = subprocess.run([str(tool_path), *arguments], capture_output=True, check=False, stdin=subprocess.DEVNULL)
    if result.returncode != 0:
        raise VectorGenerationError(f"{tool_path.stem} failed on {file_name}:\n{result.stderr.decode('utf-8', errors='replace')}")
    return result.stdout


def get_source(medium: Medium) -> str:
    """Returns the lavfi source of a medium's frames."""

    if medium.moving_source:
        return MOVING_SOURCE_PATTERN.format(
            source_width=2 * medium.width, source_height=2 * medium.height, width=medium.width, height=medium.height, rate=FRAME_RATE
        )
    return SOURCE_PATTERN.format(width=medium.width, height=medium.height, rate=FRAME_RATE)


def get_encode_arguments(medium: Medium, output_path: Path) -> list[str]:
    """Returns FFmpeg's arguments that encode a medium in one thread, without metadata that would vary between runs."""

    return [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        get_source(medium),
        "-frames:v",
        str(medium.frame_count),
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:v",
        f"+bitexact{medium.codec_flags}",
        "-threads",
        "1",
        *medium.encoder_arguments,
        "-f",
        medium.muxer,
        "-y",
        str(output_path),
    ]


def get_remux_arguments(raw_path: Path, output_path: Path) -> list[str]:
    """Returns FFmpeg's arguments that remux a raw MPEG-4 stream into Matroska, generating each packet's presentation timestamp."""

    return [
        "-hide_banner",
        "-loglevel",
        "error",
        "-fflags",
        "+genpts",
        "-r",
        str(FRAME_RATE),
        "-f",
        RAW_MPEG4_MUXER,
        "-i",
        str(raw_path),
        "-map",
        "0:v:0",
        "-c",
        "copy",
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
        "-f",
        MATROSKA_MUXER,
        "-y",
        str(output_path),
    ]


class BitReader:
    """Reads bits most significant first."""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.bit_offset = 0

    def read(self, bit_count: int) -> int:
        value = 0
        for _ in range(bit_count):
            byte_index = self.bit_offset >> 3
            if byte_index >= len(self.data):
                raise VectorGenerationError("An MPEG-4 header ends early")
            value = (value << 1) | ((self.data[byte_index] >> (7 - (self.bit_offset & 7))) & 1)
            self.bit_offset += 1
        return value


def read_time_increment_bits(video_object_layer: bytes) -> int:
    """Returns the bits of vop_time_increment from a video object layer header after its start code, as FFmpeg counts them."""

    reader = BitReader(video_object_layer)
    reader.read(1 + 8)  # random_accessible_vol, video_object_type_indication
    verid = 1
    if reader.read(1):  # is_object_layer_identifier
        verid = reader.read(4)
        reader.read(3)  # video_object_layer_priority
    if reader.read(4) == EXTENDED_PAR:
        reader.read(8 + 8)  # par_width, par_height
    if reader.read(1):  # vol_control_parameters
        reader.read(2 + 1)  # chroma_format, low_delay
        if reader.read(1):
            reader.read(VBV_PARAMETER_BITS)
    if reader.read(2) == GRAYSCALE_SHAPE and verid != 1:
        reader.read(4)  # video_object_layer_shape_extension
    reader.read(1)  # marker_bit
    resolution = reader.read(16)
    # FFmpeg's av_log2(resolution - 1) + 1, at least 1
    return max(1, (resolution - 1).bit_length())


def is_coded_VOP(video_object_plane: bytes, time_increment_bits: int) -> bool:
    """Returns vop_coded of a VOP header after its start code; an N-VOP codes none of its picture."""

    reader = BitReader(video_object_plane)
    reader.read(2)  # vop_coding_type
    while reader.read(1):  # modulo_time_base
        pass
    reader.read(1 + time_increment_bits + 1)  # marker_bit, vop_time_increment, marker_bit
    return reader.read(1) == 1


def split_start_code_units(stream: bytes) -> list[bytes]:
    """Splits a raw MPEG-4 stream before each start code."""

    if not stream.startswith(START_CODE_PREFIX):
        raise VectorGenerationError("The raw MPEG-4 stream does not start with a start code")
    starts: list[int] = []
    offset = stream.find(START_CODE_PREFIX)
    while offset >= 0:
        starts.append(offset)
        offset = stream.find(START_CODE_PREFIX, offset + len(START_CODE_PREFIX))
    return [stream[start:end] for start, end in zip(starts, [*starts[1:], len(stream)])]


def drop_not_coded_VOPs(stream: bytes) -> bytes:
    """Returns a raw MPEG-4 stream without its N-VOPs, reading each VOP's time increment length from the video object layer before it."""

    time_increment_bits: int | None = None
    kept: list[bytes] = []
    for unit in split_start_code_units(stream):
        # A video object start code has no header after it, so only a cut start code fails here
        if len(unit) < START_CODE_LENGTH:
            raise VectorGenerationError("An MPEG-4 start code is cut short")
        start_code = unit[len(START_CODE_PREFIX)]
        header = unit[START_CODE_LENGTH:]
        if FIRST_VOL_START_CODE <= start_code <= LAST_VOL_START_CODE:
            time_increment_bits = read_time_increment_bits(header)
        elif start_code == VOP_START_CODE:
            if time_increment_bits is None:
                raise VectorGenerationError("A VOP precedes the video object layer")
            if not is_coded_VOP(header, time_increment_bits):
                continue
        kept.append(unit)
    return b"".join(kept)


def read_EBML_variable_integer(data: bytes, offset: int, maximum_length: int, keep_marker: bool) -> tuple[int, int]:
    """Reads an EBML ID (with its length marker) or size (without it) and returns it with the offset after it."""

    if offset >= len(data) or data[offset] == 0:
        raise VectorGenerationError(f"Invalid EBML variable-size integer at offset {offset}")
    length = 9 - data[offset].bit_length()
    if length > maximum_length or offset + length > len(data):
        raise VectorGenerationError(f"Invalid EBML variable-size integer at offset {offset}")
    value = int.from_bytes(data[offset:offset + length], "big")
    if not keep_marker:
        value &= (1 << (7 * length)) - 1
        if value == (1 << (7 * length)) - 1:
            raise VectorGenerationError(f"Unknown EBML size at offset {offset}")
    return value, offset + length


def read_EBML_elements(data: bytes) -> list[tuple[int, bytes]]:
    """Returns the elements at one level of EBML data, each as its ID and payload."""

    elements: list[tuple[int, bytes]] = []
    offset = 0
    while offset < len(data):
        element_ID, offset = read_EBML_variable_integer(data, offset, MAXIMUM_EBML_ID_LENGTH, keep_marker=True)
        size, offset = read_EBML_variable_integer(data, offset, MAXIMUM_EBML_SIZE_LENGTH, keep_marker=False)
        if offset + size > len(data):
            raise VectorGenerationError(f"The EBML element 0x{element_ID:X} runs past its parent")
        elements.append((element_ID, data[offset:offset + size]))
        offset += size
    return elements


def encode_EBML_element(element_ID: int, payload: bytes) -> bytes:
    """Encodes an element with its size in the shortest variable-size integer that is not the unknown size."""

    for length in range(1, MAXIMUM_EBML_SIZE_LENGTH + 1):
        if len(payload) < (1 << (7 * length)) - 1:
            size = ((1 << (7 * length)) | len(payload)).to_bytes(length, "big")
            return element_ID.to_bytes((element_ID.bit_length() + 7) // 8, "big") + size + payload
    raise VectorGenerationError(f"The EBML element 0x{element_ID:X} is too large")


def find_EBML_child(elements: Sequence[tuple[int, bytes]], element_ID: int) -> bytes:
    """Returns the payload of the one child of an ID."""

    payloads = [payload for child_ID, payload in elements if child_ID == element_ID]
    if len(payloads) != 1:
        raise VectorGenerationError(f"{len(payloads)} EBML elements 0x{element_ID:X}, expected one")
    return payloads[0]


def create_VFW_codec_private(width: int, height: int, fourcc: str, extradata: bytes) -> bytes:
    """Returns a Video for Windows CodecPrivate as FFmpeg's muxers write it: a BITMAPINFOHEADER, then the extradata."""

    header = BITMAP_INFO_HEADER.pack(
        BITMAP_INFO_HEADER.size + len(extradata),
        width,
        height,
        BITMAP_INFO_HEADER_PLANES,
        BITMAP_INFO_HEADER_BIT_COUNT,
        fourcc.encode("ascii"),
        width * height * BITMAP_INFO_HEADER_BYTES_PER_PIXEL,
        0,
        0,
        0,
        0,
    )
    return header + extradata


def rewrite_track_entry(track_entry: bytes, fourcc: str) -> bytes:
    """Rewrites a native track entry into a Video for Windows one of a FourCC, its CodecPrivate a BITMAPINFOHEADER of its size and then its extradata."""

    children = read_EBML_elements(track_entry)
    video = read_EBML_elements(find_EBML_child(children, VIDEO_ID))
    width = int.from_bytes(find_EBML_child(video, PIXEL_WIDTH_ID), "big")
    height = int.from_bytes(find_EBML_child(video, PIXEL_HEIGHT_ID), "big")
    extradata = find_EBML_child(children, CODEC_PRIVATE_ID)
    rewritten: list[bytes] = []
    for child_ID, payload in children:
        if child_ID == CODEC_ID_ID:
            payload = VFW_CODEC_ID
        elif child_ID == CODEC_PRIVATE_ID:
            payload = create_VFW_codec_private(width, height, fourcc, extradata)
        rewritten.append(encode_EBML_element(child_ID, payload))
    return b"".join(rewritten)


def retime_cluster(cluster: bytes, first_block_index: int) -> tuple[bytes, int]:
    """Gives a cluster's blocks the decode-order timestamps of an AVI, one frame duration per block from the first; returns it and the next block's index."""

    children = read_EBML_elements(cluster)
    child_IDs = {child_ID for child_ID, _ in children}
    if not child_IDs <= {CLUSTER_TIMESTAMP_ID, SIMPLE_BLOCK_ID}:
        raise VectorGenerationError(f"A cluster holds elements other than a timestamp and SimpleBlocks: {sorted(child_IDs)}")
    cluster_timestamp = first_block_index * FRAME_DURATION_MILLISECONDS
    rewritten = [encode_EBML_element(CLUSTER_TIMESTAMP_ID, cluster_timestamp.to_bytes(4, "big"))]
    block_index = first_block_index
    for child_ID, payload in children:
        if child_ID != SIMPLE_BLOCK_ID:
            continue
        _, timestamp_offset = read_EBML_variable_integer(payload, 0, MAXIMUM_EBML_SIZE_LENGTH, keep_marker=False)
        relative_timestamp = block_index * FRAME_DURATION_MILLISECONDS - cluster_timestamp
        block = payload[:timestamp_offset] + BLOCK_TIMESTAMP.pack(relative_timestamp) + payload[timestamp_offset + BLOCK_TIMESTAMP.size:]
        rewritten.append(encode_EBML_element(SIMPLE_BLOCK_ID, block))
        block_index += 1
    return b"".join(rewritten), block_index


def rewrite_as_VFW_track(content: bytes, fourcc: str) -> bytes:
    """Rewrites FFmpeg's Matroska file of one native video track into a Video for Windows track whose blocks carry decode-order timestamps.

    The seek head, cues, and void elements are dropped, since the rewrite moves the offsets they hold.
    """

    top_level = read_EBML_elements(content)
    if [element_ID for element_ID, _ in top_level] != [EBML_HEADER_ID, SEGMENT_ID]:
        raise VectorGenerationError("A Matroska file must hold one EBML header followed by one Segment")
    rewritten: list[bytes] = []
    block_index = 0
    for element_ID, payload in read_EBML_elements(top_level[1][1]):
        if element_ID in DROPPED_SEGMENT_CHILD_IDS:
            continue
        if element_ID == INFO_ID:
            timestamp_scale = int.from_bytes(find_EBML_child(read_EBML_elements(payload), TIMESTAMP_SCALE_ID), "big")
            if timestamp_scale != NANOSECONDS_PER_MILLISECOND:
                raise VectorGenerationError(f"A timestamp scale of {timestamp_scale} ns, expected milliseconds")
        elif element_ID == TRACKS_ID:
            payload = encode_EBML_element(TRACK_ENTRY_ID, rewrite_track_entry(find_EBML_child(read_EBML_elements(payload), TRACK_ENTRY_ID), fourcc))
        elif element_ID == CLUSTER_ID:
            payload, block_index = retime_cluster(payload, block_index)
        rewritten.append(encode_EBML_element(element_ID, payload))
    return encode_EBML_element(EBML_HEADER_ID, top_level[0][1]) + encode_EBML_element(SEGMENT_ID, b"".join(rewritten))


def encode_medium(medium: Medium, ffmpeg_path: Path, directory: Path) -> bytes:
    """Encodes a medium in a scratch folder and returns its file's bytes."""

    encoded_path = directory / f"encoded.{medium.muxer}"
    run_tool(ffmpeg_path, get_encode_arguments(medium, encoded_path), medium.file_name)
    if medium.layout == LAYOUT_RAW_REMUX:
        raw_path = directory / f"coded.{RAW_MPEG4_MUXER}"
        raw_path.write_bytes(drop_not_coded_VOPs(encoded_path.read_bytes()))
        remuxed_path = directory / "remuxed.mkv"
        run_tool(ffmpeg_path, get_remux_arguments(raw_path, remuxed_path), medium.file_name)
        return remuxed_path.read_bytes()
    if medium.layout == LAYOUT_VFW_REWRITE:
        return rewrite_as_VFW_track(encoded_path.read_bytes(), medium.codec_tag)
    return encoded_path.read_bytes()


def probe_medium(ffprobe_path: Path, media_path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Returns FFprobe's view of a medium's video: its streams, its packets' timestamps, and its frames' types and timestamps."""

    output = run_tool(
        ffprobe_path,
        ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,codec_tag_string,width,height:packet=pts:frame=pict_type,pts",
         "-of", "json", str(media_path)],
        media_path.name,
    )
    probe = json.loads(output.decode("utf-8"))
    # FFprobe lists packets and frames together, in the order it read and decoded them
    entries = probe.get("packets_and_frames", [])
    packets = [entry for entry in entries if entry.get("type") == "packet"]
    frames = [entry for entry in entries if entry.get("type") == "frame"]
    return probe.get("streams", []), packets, frames


def require_reference_decode(medium: Medium, media_path: Path, ffmpeg_path: Path) -> None:
    """Requires FFmpeg's reference decode of a medium to finish without reporting an error."""

    arguments = ["-v", "error", "-xerror", *REFERENCE_DECODER_OPTIONS, "-i", str(media_path), "-map", "0:v:0", "-f", "null", "-"]
    result = subprocess.run([str(ffmpeg_path), *arguments], capture_output=True, check=False, stdin=subprocess.DEVNULL)
    if result.returncode != 0 or result.stderr:
        raise VectorGenerationError(f"{medium.file_name}: FFmpeg's reference decode failed:\n{result.stderr.decode('utf-8', errors='replace')}")


def verify_medium(medium: Medium, media_path: Path, ffmpeg_path: Path, ffprobe_path: Path) -> None:
    """Requires a medium to probe as its codec, FourCC, and size, to show its picture types, and to decode one frame per packet without an error.

    The self-test stream's packets carry presentation timestamps, so its frames must come out in their timestamps' order.
    """

    streams, packets, frames = probe_medium(ffprobe_path, media_path)
    if len(streams) != 1:
        raise VectorGenerationError(f"{medium.file_name}: {len(streams)} video streams")
    stream = streams[0]
    found = (stream.get("codec_name"), stream.get("codec_tag_string"), stream.get("width"), stream.get("height"))
    expected = (medium.codec_name, medium.codec_tag, medium.width, medium.height)
    if found != expected:
        raise VectorGenerationError(f"{medium.file_name}: codec, FourCC, and size {found}, expected {expected}")
    picture_types = frozenset(frame.get("pict_type") for frame in frames)
    if picture_types != medium.picture_types:
        raise VectorGenerationError(f"{medium.file_name}: picture types {sorted(picture_types)}, expected {sorted(medium.picture_types)}")
    if len(frames) != len(packets):
        raise VectorGenerationError(f"{medium.file_name}: {len(frames)} frames of {len(packets)} packets")
    if medium.layout == LAYOUT_RAW_REMUX:
        timestamps = [frame.get("pts") for frame in frames]
        if None in timestamps or timestamps != sorted(set(timestamps)):
            raise VectorGenerationError(f"{medium.file_name}: frames at {timestamps}, out of presentation order")
    require_reference_decode(medium, media_path, ffmpeg_path)


def generate_medium(medium: Medium, ffmpeg_path: Path, ffprobe_path: Path, *, check: bool) -> bool:
    """Encodes and verifies one medium, then installs it when it is missing, or compares it with the committed file; returns whether it was written."""

    with tempfile.TemporaryDirectory(prefix="webgpu-mpeg4-vector-") as temporary_directory:
        # A failed encode or check never touches the committed medium
        directory = Path(temporary_directory)
        content = encode_medium(medium, ffmpeg_path, directory)
        candidate_path = directory / medium.file_name
        candidate_path.write_bytes(content)
        verify_medium(medium, candidate_path, ffmpeg_path, ffprobe_path)
        return install_or_check_output(VECTOR_DIRECTORY / medium.file_name, content, check=check)


def parse_arguments(command_arguments: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", type=Path, help="FFmpeg executable; defaults to ffmpeg on PATH. The committed media was encoded by FFmpeg 2026-03-01-git-862338fe31")
    parser.add_argument("--ffprobe", type=Path, help="FFprobe executable; defaults to ffprobe on PATH")
    parser.add_argument("--check", action="store_true", help="Fail unless every committed medium matches its regeneration; nothing is written")
    return parser.parse_args(command_arguments)


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Generates or checks every medium and returns the process exit status."""

    arguments = parse_arguments(command_arguments)
    try:
        ffmpeg_path = resolve_tool_path("ffmpeg", arguments.ffmpeg)
        ffprobe_path = resolve_tool_path("ffprobe", arguments.ffprobe)
        written = [medium.file_name for medium in MEDIA if generate_medium(medium, ffmpeg_path, ffprobe_path, check=arguments.check)]
    except (VectorGenerationError, GeneratedOutputError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    action = "Verified" if arguments.check else "Generated"
    print(f"{action} {len(MEDIA)} MPEG-4 decoder project media in {VECTOR_DIRECTORY}" + (f"; wrote {', '.join(written)}" if written else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
