#!/usr/bin/env python3
"""Generate the AVI demux test vectors, or verify them with --check.

Each vector is a short FFmpeg encode muxed by FFmpeg's AVI muxer, which writes an idx1 index and, for these small files, no AVIX list.
Together they cover what the engine reads from AVI through Mediabunny:
- H.264 with B-frames, stamped in decode order as AVI is, beside variable-bitrate MP3 timed per frame;
- H.264 without B-frames beside constant-bitrate MP3 timed by bytes, whose first frame FFmpeg drops into an empty chunk;
- VP8 with 16-bit PCM, VP9 with AAC and its AudioSpecificConfig, and AV1 with AC-3 (WAVE_FORMAT_DVM, 0x2000);
- HEVC under the HEVC fourcc, which the engine refuses in AVI, and MPEG-4 Part 2 under XVID, which has no route.

The encoders' bytes depend on the FFmpeg build, so the generator refuses any but the pinned one, and an existing vector is only compared, never replaced.
Before writing, it checks each file's streams with FFprobe: the codec, the codec tag, and the packet count.
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


VECTOR_DIRECTORY: Final = CODEC_VECTOR_ASSETS_DIRECTORY / "avi"

# 192x192, like the other vectors, so hardware decoders with a minimum coded size accept it
VIDEO_SOURCE: Final = "testsrc2=size=192x192:rate=24:duration=0.5"
VIDEO_FRAME_COUNT: Final = 12
# Two groups of six frames, so a start inside the second group begins at its key frame
KEY_FRAME_INTERVAL: Final = "6"
AUDIO_SOURCE: Final = "sine=frequency=440:sample_rate=48000:duration=0.5"
STEREO_CHANNEL_COUNT: Final = "2"
# One thread, so every encode is deterministic
SINGLE_THREAD_ARGUMENTS: Final = ("-threads", "1")


@dataclass(frozen=True)
class AVIVector:
    """One AVI vector: its file name, the encoder arguments of each stream, and what FFprobe must read back."""

    file_name: str
    video_arguments: tuple[str, ...]
    audio_arguments: tuple[str, ...]
    video_codec_name: str
    video_codec_tag: str
    audio_codec_name: str


AVI_VECTORS: Final = (
    AVIVector(
        "h264-bframes-mp3-vbr.avi",
        ("-c:v", "libx264", "-preset", "medium", "-bf", "2", "-x264-params", "threads=1:scenecut=0"),
        ("-c:a", "libmp3lame", "-q:a", "6"),
        "h264",
        "H264",
        "mp3",
    ),
    AVIVector(
        "h264-mp3-cbr.avi",
        ("-c:v", "libx264", "-preset", "medium", "-bf", "0", "-x264-params", "threads=1:scenecut=0"),
        ("-c:a", "libmp3lame", "-b:a", "64k"),
        "h264",
        "H264",
        "mp3",
    ),
    AVIVector(
        "vp8-pcm_s16le.avi",
        ("-c:v", "libvpx", "-b:v", "300k", *SINGLE_THREAD_ARGUMENTS),
        ("-c:a", "pcm_s16le", "-ac", STEREO_CHANNEL_COUNT),
        "vp8",
        "VP80",
        "pcm_s16le",
    ),
    AVIVector(
        "vp9-aac.avi",
        ("-c:v", "libvpx-vp9", "-b:v", "300k", "-row-mt", "0", *SINGLE_THREAD_ARGUMENTS),
        ("-c:a", "aac", "-b:a", "96k"),
        "vp9",
        "VP90",
        "aac",
    ),
    AVIVector(
        "av1-ac3.avi",
        ("-c:v", "libaom-av1", "-cpu-used", "8", "-b:v", "200k", "-row-mt", "0", *SINGLE_THREAD_ARGUMENTS),
        ("-c:a", "ac3", "-b:a", "96k"),
        "av1",
        "AV01",
        "ac3",
    ),
    AVIVector(
        "hevc-ac3.avi",
        (
            "-c:v", "libx265", "-tag:v", "HEVC",
            "-x265-params", "info=0:pools=none:frame-threads=1:wpp=0:log-level=error:scenecut=0:bframes=0",
        ),
        ("-c:a", "ac3", "-b:a", "96k"),
        "hevc",
        "HEVC",
        "ac3",
    ),
    AVIVector(
        "mpeg4-mp3.avi",
        ("-c:v", "mpeg4", "-tag:v", "XVID", "-q:v", "5", *SINGLE_THREAD_ARGUMENTS),
        ("-c:a", "libmp3lame", "-b:a", "64k"),
        "mpeg4",
        "XVID",
        "mp3",
    ),
)


def parse_arguments(command_arguments: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail unless every committed vector matches a fresh encode")
    parser.add_argument("--ffmpeg", help="The FFmpeg executable, ffmpeg on PATH by default")
    parser.add_argument("--ffprobe", help="The FFprobe executable, ffprobe on PATH by default")
    return parser.parse_args(command_arguments)


def encode_vector(tools: MediaTools, vector: AVIVector, output_path: Path) -> None:
    """Encodes one vector with the pinned FFmpeg, its AVI muxer, and bit-exact flags."""

    execute_tool(tools.FFmpeg_path, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", VIDEO_SOURCE,
        "-f", "lavfi", "-i", AUDIO_SOURCE,
        "-frames:v", str(VIDEO_FRAME_COUNT), "-g", KEY_FRAME_INTERVAL, "-pix_fmt", "yuv420p",
        *vector.video_arguments,
        *vector.audio_arguments,
        "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
        "-f", "avi", str(output_path),
    ])


def verify_vector(tools: MediaTools, vector: AVIVector, path: Path) -> None:
    """Requires FFprobe to read the vector's two streams and every video frame."""

    probe = json.loads(execute_tool(tools.FFprobe_path, [
        "-hide_banner", "-loglevel", "error", "-count_packets",
        "-show_entries", "stream=codec_type,codec_name,codec_tag_string,nb_read_packets",
        "-of", "json", str(path),
    ]))
    streams = probe["streams"]
    require_equal([stream["codec_type"] for stream in streams], ["video", "audio"], f"{vector.file_name} stream types")
    video_stream, audio_stream = streams
    require_equal(video_stream["codec_name"], vector.video_codec_name, f"{vector.file_name} video codec")
    require_equal(video_stream["codec_tag_string"], vector.video_codec_tag, f"{vector.file_name} video codec tag")
    require_equal(audio_stream["codec_name"], vector.audio_codec_name, f"{vector.file_name} audio codec")
    # FFmpeg counts the packets it reads, without the empty chunks the muxer writes for dropped frames
    if int(video_stream["nb_read_packets"]) < VIDEO_FRAME_COUNT - 1:
        raise VectorGenerationError(f"{vector.file_name} holds {video_stream['nb_read_packets']} video packets")


def main(command_arguments: Sequence[str] | None = None) -> int:
    arguments = parse_arguments(command_arguments)
    tools = MediaTools(resolve_FFmpeg_tool("ffmpeg", arguments.ffmpeg), resolve_FFmpeg_tool("ffprobe", arguments.ffprobe))
    try:
        check_toolchain(tools)
        with tempfile.TemporaryDirectory() as temporary_directory:
            for vector in AVI_VECTORS:
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
        print(f"generate_AVI_demux_vectors: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
