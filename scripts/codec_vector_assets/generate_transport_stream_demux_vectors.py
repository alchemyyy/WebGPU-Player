#!/usr/bin/env python3
"""Generate the MPEG-TS and M2TS demux test vectors, or verify them with --check.

Each vector is muxed by FFmpeg's MPEG-TS muxer, and its M2TS twin by the same muxer in M2TS mode, which prefixes each 188-byte packet with a 4-byte timecode.
Together they cover the stream types Mediabunny's demuxer reads beyond H.264 and HEVC:
- MPEG-1 video (stream type 0x01) beside MP3, an FFmpeg encode, in MPEG-TS alone;
- MPEG-2 video (stream type 0x02) with B-frames beside AC-3, an FFmpeg encode;
- VC-1 Advanced profile (stream type 0xEA with its VC-1 registration descriptor), remuxed from the committed qualification vector, since FFmpeg has no VC-1 encoder;
- DTS core (stream type 0x82) in M2TS alone, as a Blu-ray program carries it, remuxed from the committed DTS test vector, since FFmpeg's DTS encoder is experimental.
  In plain MPEG-TS FFmpeg writes 0x82 without the registration that names it DTS, so FFprobe, and so Jellyfin, read that stream as MP3.

The encoders' bytes depend on the FFmpeg build, so the generator refuses any but the pinned one, and an existing vector is only compared, never replaced.
Before writing, it checks each file's streams with FFprobe: the codec and the packet count.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Sequence

from engine_layout import CODEC_VECTOR_ASSETS_DIRECTORY, QUALIFICATION_VECTORS_DIRECTORY, TEST_VECTORS_DIRECTORY
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


VECTOR_DIRECTORY: Final = CODEC_VECTOR_ASSETS_DIRECTORY / "mpeg-ts"
VC1_SOURCE_PATH: Final = QUALIFICATION_VECTORS_DIRECTORY / "vc1" / "vc1-advanced-progressive-1920x1080.mkv"
VC1_SOURCE_FRAME_RATE: Final = "24"
VC1_FRAME_COUNT: Final = 12
START_CODE_PREFIX: Final = b"\x00\x00\x01"
VC1_FRAME_START_CODE: Final = b"\x00\x00\x01\x0d"
DTS_SOURCE_PATH: Final = TEST_VECTORS_DIRECTORY / "dts" / "core_51_24_48_768_0.mka"
DTS_BASE_NAME: Final = "dts-core"
DTS_CODEC_NAME: Final = "dts"
DTS_PACKET_COUNT: Final = 6

# 192x192, like the other vectors, so hardware decoders with a minimum coded size accept it
VIDEO_SOURCE: Final = "testsrc2=size=192x192:rate=24:duration=0.5"
VIDEO_FRAME_COUNT: Final = 12
# Two groups of six frames, so a start inside the second group begins at its key frame
KEY_FRAME_INTERVAL: Final = "6"
AUDIO_SOURCE: Final = "sine=frequency=440:sample_rate=48000:duration=0.5"
SINGLE_THREAD_ARGUMENTS: Final = ("-threads", "1")
TRANSPORT_STREAM_EXTENSION: Final = ".ts"
M2TS_EXTENSION: Final = ".m2ts"
M2TS_MODE_ARGUMENTS: Final = ("-mpegts_m2ts_mode", "1")


@dataclass(frozen=True)
class EncodedVector:
    """One encoded vector pair: its base file name, the encoder arguments of each stream, and what FFprobe must read back."""

    base_name: str
    video_arguments: tuple[str, ...]
    audio_arguments: tuple[str, ...]
    video_codec_name: str
    audio_codec_name: str
    extensions: tuple[str, ...]


ENCODED_VECTORS: Final = (
    # BDAV M2TS carries neither MPEG-1 video nor MP3; FFmpeg's M2TS mode writes them as private data, so MPEG-1 has a TS vector alone
    EncodedVector(
        "mpeg1video-mp3",
        ("-c:v", "mpeg1video", "-q:v", "4", "-bf", "0", *SINGLE_THREAD_ARGUMENTS),
        ("-c:a", "libmp3lame", "-b:a", "64k"),
        "mpeg1video",
        "mp3",
        (TRANSPORT_STREAM_EXTENSION,),
    ),
    EncodedVector(
        "mpeg2video-bframes-ac3",
        ("-c:v", "mpeg2video", "-q:v", "4", "-bf", "2", *SINGLE_THREAD_ARGUMENTS),
        ("-c:a", "ac3", "-b:a", "96k"),
        "mpeg2video",
        "ac3",
        (TRANSPORT_STREAM_EXTENSION, M2TS_EXTENSION),
    ),
)
VC1_BASE_NAME: Final = "vc1-advanced"


def parse_arguments(command_arguments: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail unless every committed vector matches a fresh run")
    parser.add_argument("--ffmpeg", help="The FFmpeg executable, ffmpeg on PATH by default")
    parser.add_argument("--ffprobe", help="The FFprobe executable, ffprobe on PATH by default")
    return parser.parse_args(command_arguments)


def get_mode_arguments(extension: str) -> tuple[str, ...]:
    return M2TS_MODE_ARGUMENTS if extension == M2TS_EXTENSION else ()


def encode_vector(tools: MediaTools, vector: EncodedVector, extension: str, output_path: Path) -> None:
    """Encodes one vector with the pinned FFmpeg, its MPEG-TS muxer, and bit-exact flags."""

    execute_tool(tools.FFmpeg_path, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", VIDEO_SOURCE,
        "-f", "lavfi", "-i", AUDIO_SOURCE,
        "-frames:v", str(VIDEO_FRAME_COUNT), "-g", KEY_FRAME_INTERVAL, "-pix_fmt", "yuv420p",
        *vector.video_arguments,
        *vector.audio_arguments,
        "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
        *get_mode_arguments(extension),
        "-f", "mpegts", str(output_path),
    ])


def copy_VC1_packets(tools: MediaTools, output_path: Path, extra_arguments: Sequence[str]) -> bytes:
    """Returns the qualification vector's VC-1 packets as FFmpeg's raw muxer concatenates them."""

    execute_tool(tools.FFmpeg_path, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(VC1_SOURCE_PATH),
        "-map", "0:v:0", "-c", "copy", *extra_arguments,
        "-f", "vc1", str(output_path),
    ])
    return output_path.read_bytes()


def write_VC1_elementary_stream(tools: MediaTools, work_directory: Path, output_path: Path) -> None:
    """
    Writes the qualification vector's VC-1 stream as an SMPTE 421M Annex E elementary stream, which MPEG-TS carries.
    Matroska keeps the sequence header and entry point in its codec private data and its frames without start codes;
    so the first frame takes the sequence header and entry point in band, and every frame a frame start code.
    A Video for Windows track marks every frame a key frame, so the flags cannot place more entry points.
    """

    probe = json.loads(execute_tool(tools.FFprobe_path, [
        "-hide_banner", "-loglevel", "error",
        "-select_streams", "v:0", "-show_entries", "packet=size",
        "-of", "json", str(VC1_SOURCE_PATH),
    ]))
    packets = probe["packets"]
    packet_data = copy_VC1_packets(tools, work_directory / "packets.vc1", ())
    # dump_extra puts the codec private data before the first packet, so whatever precedes the packet is the codec private data
    first_with_extradata = copy_VC1_packets(
        tools, work_directory / "first.vc1", ("-bsf:v", "dump_extra=freq=keyframe", "-frames:v", "1"),
    )
    extradata = first_with_extradata[:len(first_with_extradata) - int(packets[0]["size"])]
    # The codec private data's leading bytes before its first start code belong to the Video for Windows header, not the stream
    header_units = extradata[extradata.index(START_CODE_PREFIX):]
    stream = bytearray(header_units)
    packet_offset = 0
    for packet in packets:
        packet_size = int(packet["size"])
        frame = packet_data[packet_offset:packet_offset + packet_size]
        packet_offset += packet_size
        if not frame.startswith(START_CODE_PREFIX):
            stream += VC1_FRAME_START_CODE
        stream += frame
    require_equal(packet_offset, len(packet_data), "VC-1 packet bytes")
    output_path.write_bytes(bytes(stream))


def remux_VC1_vector(tools: MediaTools, elementary_stream_path: Path, extension: str, output_path: Path) -> None:
    """Remuxes the VC-1 elementary stream into MPEG-TS; its demuxer stamps the frames at the source's rate, since FFmpeg's MPEG-TS muxer needs decode times."""

    if not elementary_stream_path.exists():
        write_VC1_elementary_stream(tools, elementary_stream_path.parent, elementary_stream_path)
    execute_tool(tools.FFmpeg_path, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-fflags", "+genpts", "-r", VC1_SOURCE_FRAME_RATE, "-i", str(elementary_stream_path),
        "-map", "0:v:0", "-c", "copy",
        "-fflags", "+bitexact",
        *get_mode_arguments(extension),
        "-f", "mpegts", str(output_path),
    ])


def remux_DTS_vector(tools: MediaTools, output_path: Path) -> None:
    """Remuxes the DTS test vector's frames into M2TS."""

    execute_tool(tools.FFmpeg_path, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(DTS_SOURCE_PATH),
        "-map", "0:a:0", "-c", "copy",
        "-fflags", "+bitexact",
        *M2TS_MODE_ARGUMENTS,
        "-f", "mpegts", str(output_path),
    ])


def probe_streams(tools: MediaTools, path: Path) -> list[dict[str, object]]:
    probe = json.loads(execute_tool(tools.FFprobe_path, [
        "-hide_banner", "-loglevel", "error", "-count_packets",
        "-show_entries", "stream=codec_type,codec_name,nb_read_packets",
        "-of", "json", str(path),
    ]))
    return probe["streams"]


def verify_vector(tools: MediaTools, file_name: str, path: Path, codec_names: Sequence[str], video_frame_count: int) -> None:
    """Requires FFprobe to read the vector's streams and every video frame."""

    streams = probe_streams(tools, path)
    require_equal([stream["codec_name"] for stream in streams], list(codec_names), f"{file_name} codecs")
    video_stream = streams[0]
    require_equal(video_stream["codec_type"], "video", f"{file_name} first stream type")
    if int(video_stream["nb_read_packets"]) != video_frame_count:
        raise VectorGenerationError(f"{file_name} holds {video_stream['nb_read_packets']} video packets")


def verify_audio_vector(tools: MediaTools, file_name: str, path: Path, codec_name: str, packet_count: int) -> None:
    """Requires FFprobe to read the vector's one audio stream and every packet of it."""

    streams = probe_streams(tools, path)
    require_equal([stream["codec_name"] for stream in streams], [codec_name], f"{file_name} codecs")
    if int(streams[0]["nb_read_packets"]) != packet_count:
        raise VectorGenerationError(f"{file_name} holds {streams[0]['nb_read_packets']} audio packets")


def install_vector(path: Path, file_name: str, *, check: bool) -> None:
    written = install_or_check_output(VECTOR_DIRECTORY / file_name, path.read_bytes(), check=check)
    print(f"{'Wrote' if written else 'Matched'} {file_name}")


def main(command_arguments: Sequence[str] | None = None) -> int:
    arguments = parse_arguments(command_arguments)
    tools = MediaTools(resolve_FFmpeg_tool("ffmpeg", arguments.ffmpeg), resolve_FFmpeg_tool("ffprobe", arguments.ffprobe))
    try:
        check_toolchain(tools)
        with tempfile.TemporaryDirectory() as temporary_directory:
            for extension in (TRANSPORT_STREAM_EXTENSION, M2TS_EXTENSION):
                for vector in ENCODED_VECTORS:
                    if extension not in vector.extensions:
                        continue
                    file_name = vector.base_name + extension
                    encoded_path = Path(temporary_directory) / file_name
                    encode_vector(tools, vector, extension, encoded_path)
                    verify_vector(tools, file_name, encoded_path, (vector.video_codec_name, vector.audio_codec_name), VIDEO_FRAME_COUNT)
                    install_vector(encoded_path, file_name, check=arguments.check)
                file_name = VC1_BASE_NAME + extension
                remuxed_path = Path(temporary_directory) / file_name
                remux_VC1_vector(tools, Path(temporary_directory) / f"{VC1_BASE_NAME}.vc1", extension, remuxed_path)
                verify_vector(tools, file_name, remuxed_path, ("vc1",), VC1_FRAME_COUNT)
                install_vector(remuxed_path, file_name, check=arguments.check)
            file_name = DTS_BASE_NAME + M2TS_EXTENSION
            remuxed_path = Path(temporary_directory) / file_name
            remux_DTS_vector(tools, remuxed_path)
            verify_audio_vector(tools, file_name, remuxed_path, DTS_CODEC_NAME, DTS_PACKET_COUNT)
            install_vector(remuxed_path, file_name, check=arguments.check)
    except (GeneratedOutputError, ToolError, VectorGenerationError) as error:
        print(f"generate_transport_stream_demux_vectors: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
