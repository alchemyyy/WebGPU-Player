#!/usr/bin/env python3
"""Generate the MPEG program stream demux test vectors, or verify them with --check.

FFmpeg's program stream muxers write them, as Mediabunny's fork reads them:
- MPEG-1 video beside MP3, an FFmpeg encode, in an MPEG-1 system stream (FFmpeg's mpeg muxer), as an .mpg file holds them;
- MPEG-2 video with B-frames beside AC-3, an FFmpeg encode, in a DVD-Video program stream (FFmpeg's vob muxer), whose AC-3 rides in private stream 1.

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


VECTOR_DIRECTORY: Final = CODEC_VECTOR_ASSETS_DIRECTORY / "mpeg-ps"

# 192x192, like the other vectors, so hardware decoders with a minimum coded size accept it
VIDEO_SOURCE: Final = "testsrc2=size=192x192:rate=24:duration=0.5"
VIDEO_FRAME_COUNT: Final = 12
# Two groups of six frames, so a start inside the second group begins at its key frame
KEY_FRAME_INTERVAL: Final = "6"
AUDIO_SOURCE: Final = "sine=frequency=440:sample_rate=48000:duration=0.5"
SINGLE_THREAD_ARGUMENTS: Final = ("-threads", "1")


@dataclass(frozen=True)
class EncodedVector:
    """One encoded vector: its file name, the encoder arguments of each stream, its muxer, and what FFprobe must read back."""

    file_name: str
    video_arguments: tuple[str, ...]
    audio_arguments: tuple[str, ...]
    muxer: str
    video_codec_name: str
    audio_codec_name: str


ENCODED_VECTORS: Final = (
    EncodedVector(
        "mpeg1video-mp3.mpg",
        ("-c:v", "mpeg1video", "-q:v", "4", "-bf", "0", *SINGLE_THREAD_ARGUMENTS),
        ("-c:a", "libmp3lame", "-b:a", "64k"),
        "mpeg",
        "mpeg1video",
        "mp3",
    ),
    EncodedVector(
        "mpeg2video-bframes-ac3.vob",
        ("-c:v", "mpeg2video", "-q:v", "4", "-bf", "2", *SINGLE_THREAD_ARGUMENTS),
        ("-c:a", "ac3", "-b:a", "96k"),
        "vob",
        "mpeg2video",
        "ac3",
    ),
)


def parse_arguments(command_arguments: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail unless every committed vector matches a fresh run")
    parser.add_argument("--ffmpeg", help="The FFmpeg executable, ffmpeg on PATH by default")
    parser.add_argument("--ffprobe", help="The FFprobe executable, ffprobe on PATH by default")
    return parser.parse_args(command_arguments)


def encode_vector(tools: MediaTools, vector: EncodedVector, output_path: Path) -> None:
    """Encodes one vector with the pinned FFmpeg, its program stream muxer, and bit-exact flags."""

    execute_tool(tools.FFmpeg_path, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", VIDEO_SOURCE,
        "-f", "lavfi", "-i", AUDIO_SOURCE,
        "-frames:v", str(VIDEO_FRAME_COUNT), "-g", KEY_FRAME_INTERVAL, "-pix_fmt", "yuv420p",
        *vector.video_arguments,
        *vector.audio_arguments,
        "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
        "-f", vector.muxer, str(output_path),
    ])


def verify_vector(tools: MediaTools, vector: EncodedVector, path: Path) -> None:
    """Requires FFprobe to read the program stream, its two streams, and every video frame."""

    probe = json.loads(execute_tool(tools.FFprobe_path, [
        "-hide_banner", "-loglevel", "error", "-count_packets",
        "-show_entries", "format=format_name:stream=codec_type,codec_name,nb_read_packets",
        "-of", "json", str(path),
    ]))
    require_equal(probe["format"]["format_name"], "mpeg", f"{vector.file_name} format")
    streams = probe["streams"]
    require_equal(
        [stream["codec_name"] for stream in streams],
        [vector.video_codec_name, vector.audio_codec_name],
        f"{vector.file_name} codecs",
    )
    if int(streams[0]["nb_read_packets"]) != VIDEO_FRAME_COUNT:
        raise VectorGenerationError(f"{vector.file_name} holds {streams[0]['nb_read_packets']} video packets")


def main(command_arguments: Sequence[str] | None = None) -> int:
    arguments = parse_arguments(command_arguments)
    tools = MediaTools(resolve_FFmpeg_tool("ffmpeg", arguments.ffmpeg), resolve_FFmpeg_tool("ffprobe", arguments.ffprobe))
    try:
        check_toolchain(tools)
        with tempfile.TemporaryDirectory() as temporary_directory:
            for vector in ENCODED_VECTORS:
                encoded_path = Path(temporary_directory) / vector.file_name
                encode_vector(tools, vector, encoded_path)
                verify_vector(tools, vector, encoded_path)
                written = install_or_check_output(
                    VECTOR_DIRECTORY / vector.file_name,
                    encoded_path.read_bytes(),
                    check=arguments.check,
                )
                print(f"{'Wrote' if written else 'Matched'} {vector.file_name}")
    except (GeneratedOutputError, ToolError, VectorGenerationError) as error:
        print(f"generate_program_stream_demux_vectors: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
